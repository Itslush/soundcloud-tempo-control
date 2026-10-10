import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTempoCode, encodeTempoCode } from '../../src/tempo-share.js';
import { validateProfile } from '../../src/tempo-profile.js';
import { ServiceError, trackUrl } from '../soundcloud.mjs';

export const TTL = 7 * 86400000;
export const ID = /^[a-f0-9]{32}$/;
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
function stop(child) {
  if (!child) return;
  try {
    if (process.platform !== 'win32' && child.pid)
      process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
const parseTrack = (value) => {
  try {
    return new URL(trackUrl('https://soundcloud.com' + value)).pathname ===
      value
      ? value
      : '';
  } catch {
    return '';
  }
};

export function parseRenderCode(code) {
  try {
    if (typeof code !== 'string' || code.length > 16000)
      throw new Error('Invalid sharing code.');
    const profile = decodeTempoCode(
      code,
      (value) => validateProfile(value, parseTrack),
      parseTrack,
    );
    if (profile.duration > 900)
      throw new Error('Discord links support tracks up to 15 minutes.');
    return profile;
  } catch (error) {
    throw new ServiceError(400, error.message);
  }
}

export async function createShareStore(
  root,
  { launch = spawn, now = Date.now } = {},
) {
  const jobs = path.join(root, 'jobs');
  const media = path.join(root, 'media');
  await mkdir(jobs, { recursive: true, mode: 0o700 });
  await mkdir(media, { recursive: true });
  let active = null;
  let starting = false;
  let cleaning = null;

  async function read(id) {
    if (!ID.test(id)) throw new ServiceError(404, 'Link not found.');
    try {
      const data = JSON.parse(
        await readFile(path.join(jobs, id + '.json'), 'utf8'),
      );
      if (data.expires <= now())
        throw new ServiceError(
          410,
          'This Discord link has expired. Create a new one from the shared-track page.',
        );
      return data;
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new ServiceError(404, 'Link not found.');
      throw error;
    }
  }
  async function save(id, data) {
    const filename = path.join(jobs, id + '.json');
    await writeFile(filename + '.tmp', JSON.stringify(data));
    await rename(filename + '.tmp', filename);
  }
  async function cleanFiles() {
    let count = 0;
    let bytes = 0;
    for (const name of await readdir(jobs)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const id = name.slice(0, 32);
      const data = JSON.parse(await readFile(path.join(jobs, name), 'utf8'));
      if (data.expires <= now() || data.state === 'failed') {
        for (const extension of ['mp4', 'jpg'])
          await rm(path.join(media, id + '.' + extension), { force: true });
        await rm(path.join(jobs, name), { force: true });
      } else {
        count++;
        if (data.state === 'ready')
          bytes += (await stat(path.join(media, id + '.mp4'))).size;
      }
    }
    return { count, bytes };
  }
  function cleanup() {
    if (!cleaning)
      cleaning = cleanFiles().finally(() => {
        cleaning = null;
      });
    return cleaning;
  }
  for (const name of await readdir(jobs)) {
    if (/^[a-f0-9]{32}\.work$/.test(name))
      await rm(path.join(jobs, name), { recursive: true, force: true });
    if (/^[a-f0-9]{32}\.json$/.test(name)) {
      const data = JSON.parse(await readFile(path.join(jobs, name), 'utf8'));
      if (data.state === 'rendering')
        await save(name.slice(0, 32), {
          ...data,
          state: 'failed',
          error: 'Rendering was interrupted. Create the link again.',
        });
      if (data.state !== 'ready')
        for (const extension of ['mp4', 'jpg'])
          await rm(path.join(media, name.slice(0, 32) + '.' + extension), {
            force: true,
          });
    }
  }
  await cleanup();
  const cleaner = setInterval(() => {
    if (!active && !starting) cleanup().catch(() => {});
  }, 3600000);
  cleaner.unref();

  return {
    read,
    async create(code) {
      const profile = parseRenderCode(code);
      const canonical = encodeTempoCode(profile);
      const id = createHash('sha256')
        .update('discord-render-v1:' + canonical)
        .digest('hex')
        .slice(0, 32);
      const existing = await read(id).catch((error) => {
        if ([404, 410].includes(error.status)) return null;
        throw error;
      });
      if (existing && ['ready', 'rendering'].includes(existing.state))
        return { id, ...existing };
      if (active || starting)
        throw new ServiceError(
          429,
          'Another track is rendering. Try again in a few minutes.',
        );
      starting = true;
      const directory = path.join(jobs, id + '.work');
      try {
        const capacity = await cleanup();
        if (
          capacity.count >= 64 ||
          capacity.bytes + 48 * 1024 * 1024 > 1024 ** 3
        )
          throw new ServiceError(
            503,
            'Discord sharing storage is full. Try again later.',
          );
        await mkdir(directory);
        await writeFile(
          path.join(directory, 'profile.json'),
          JSON.stringify(profile),
        );
        const data = {
          state: 'rendering',
          code: canonical,
          expires: now() + TTL,
        };
        await save(id, data);
        const child = launch(
          process.execPath,
          ['--max-old-space-size=80', worker, directory],
          {
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: 'ignore',
          },
        );
        active = child;
        const deadline = setTimeout(() => stop(child), 15 * 60000);
        let settled = false;
        async function finish(success) {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          try {
            if (success) {
              const result = JSON.parse(
                await readFile(path.join(directory, 'result.json'), 'utf8'),
              );
              for (const [from, extension] of [
                ['audio.mp4', 'mp4'],
                ['poster.jpg', 'jpg'],
              ])
                await rename(
                  path.join(directory, from),
                  path.join(media, id + '.' + extension),
                );
              await save(id, { ...data, ...result, state: 'ready' });
            } else {
              const failure = await readFile(
                path.join(directory, 'error.json'),
                'utf8',
              )
                .then(JSON.parse)
                .catch(() => ({
                  error: 'Rendering stopped before completion. Try again.',
                }));
              await save(id, {
                ...data,
                state: 'failed',
                error: String(failure.error).slice(0, 300),
              });
            }
          } catch {
            await save(id, {
              ...data,
              state: 'failed',
              error: 'The rendered track could not be saved. Try again.',
            }).catch(() => {});
          } finally {
            stop(child);
            const saved = await read(id).catch(() => null);
            if (saved?.state !== 'ready')
              for (const extension of ['mp4', 'jpg'])
                await rm(path.join(media, id + '.' + extension), {
                  force: true,
                }).catch(() => {});
            await rm(directory, { recursive: true, force: true }).catch(
              () => {},
            );
            active = null;
          }
        }
        child.once('error', () => finish(false));
        child.once('close', (status) => finish(status === 0));
        return { id, ...data };
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      } finally {
        starting = false;
      }
    },
    close() {
      clearInterval(cleaner);
      stop(active);
    },
  };
}
