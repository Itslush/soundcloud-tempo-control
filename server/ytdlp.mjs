import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ServiceError } from './errors.mjs';

const python = fileURLToPath(
  new URL(
    process.platform === 'win32'
      ? '../.venv/Scripts/python.exe'
      : '../.venv/bin/python',
    import.meta.url,
  ),
);
const fields =
  '%(.{id,title,uploader,webpage_url,duration,url,protocol,format_id,availability,has_drm,is_live,extractor_key,_type})j';

function failure(message) {
  if (/No module named|ENOENT/i.test(message))
    return new ServiceError(
      503,
      'Track loading needs setup. Run npm run setup:backend.',
    );
  if (/429|Too Many Requests/i.test(message))
    return new ServiceError(429, 'SoundCloud is busy. Try again shortly.');
  if (/404|not found|does not exist/i.test(message))
    return new ServiceError(404, 'Track not found. Check the link.');
  if (
    /403|private|not available|unavailable|login|sign in|DRM|format is not/i.test(
      message,
    )
  )
    return new ServiceError(403, 'This track is not available for preview.');
  return new ServiceError(502, 'SoundCloud could not be reached. Try again.');
}

export function createExtractor({
  command = python,
  launch = spawn,
  timeout = 30000,
} = {}) {
  return {
    get configured() {
      return existsSync(command);
    },
    extract(url, signal) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const args = [
          '-I',
          '-m',
          'yt_dlp',
          '--ignore-config',
          '--no-plugin-dirs',
          '--no-cache-dir',
          '--no-playlist',
          '--no-geo-bypass',
          '--no-js-runtimes',
          '--no-warnings',
          '--no-progress',
          '--no-colors',
          '--skip-download',
          '--no-check-formats',
          '--socket-timeout',
          '8',
          '--retries',
          '0',
          '--extractor-retries',
          '1',
          '--use-extractors',
          'Soundcloud$',
          '--extractor-args',
          'soundcloud:formats=http_aac,http_mp3,hls_aac,hls_mp3',
          '--format',
          'bestaudio',
          '--print',
          fields,
          '--',
          url,
        ];
        const child = launch(command, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks = [];
        let size = 0;
        let stderr = '';
        let stopped = false;
        const timer = setTimeout(
          () =>
            stop(new ServiceError(504, 'Track loading timed out. Try again.')),
          timeout,
        );
        const abort = () => stop(signal.reason);

        function finish(error, value) {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve(value);
        }

        function stop(error) {
          if (stopped) return;
          child.kill('SIGKILL');
          finish(error);
        }

        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk) => {
          if (stopped) return;
          size += chunk.length;
          if (size > 524288)
            return stop(
              new ServiceError(502, 'The track response was too large.'),
            );
          chunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
          if (stopped) return;
          stderr += chunk.toString('utf8');
          if (stderr.length > 16384) stop(failure(stderr));
        });
        child.once('error', (error) =>
          finish(failure(error.code || error.message)),
        );
        child.once('close', (code) => {
          if (stopped) return;
          if (code !== 0) return finish(failure(stderr));
          try {
            finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(
              new ServiceError(502, 'The track response could not be read.'),
            );
          }
        });
        if (signal?.aborted) abort();
      });
    },
  };
}
