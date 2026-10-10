import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoundCloud } from '../soundcloud.mjs';
import { renderPcm, SAMPLE_RATE, MAX_SOURCE_SECONDS } from './audio.mjs';
import { downloadMedia } from './download.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        ...args,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let detail = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.stderr.on('data', (chunk) => {
      detail = (detail + chunk).slice(-2000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Audio conversion failed: ' + detail));
    });
  });
}

async function render(directory) {
  const file = (name) => path.join(directory, name);
  const profile = JSON.parse(await readFile(file('profile.json'), 'utf8'));
  const track = await createSoundCloud().resolve(
    'https://soundcloud.com' + profile.track,
    AbortSignal.timeout(35000),
  );
  if (
    track.preview ||
    track.duration > MAX_SOURCE_SECONDS ||
    Math.abs(track.duration - profile.duration) >
      Math.max(2, track.duration * 0.01)
  )
    throw new Error(
      'A full track matching this timeline is required, up to 15 minutes.',
    );
  await downloadMedia(track.stream, file('source.audio'), {
    hls: track.format === 'hls',
    signal: AbortSignal.timeout(120000),
  });
  await runFfmpeg([
    '-protocol_whitelist',
    'file,pipe',
    '-format_whitelist',
    'aac,mp3,mpegts,mov,ogg,flac',
    '-i',
    file('source.audio'),
    '-map',
    '0:a:0',
    '-vn',
    '-t',
    String(MAX_SOURCE_SECONDS + 1),
    '-ac',
    '2',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    'f32le',
    file('source.pcm'),
  ]);
  const duration = await renderPcm(
    file('source.pcm'),
    file('adjusted.pcm'),
    profile,
  );
  if (track.artwork) {
    await downloadMedia(track.artwork, file('artwork.image'), {
      maxBytes: 5 * 1024 * 1024,
      signal: AbortSignal.timeout(20000),
    });
    await runFfmpeg([
      '-max_alloc',
      '67108864',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      file('artwork.image'),
      '-vf',
      'scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1',
      '-frames:v',
      '1',
      '-update',
      '1',
      file('poster.jpg'),
    ]);
  } else {
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x111111:s=640x640',
      '-frames:v',
      '1',
      '-update',
      '1',
      file('poster.jpg'),
    ]);
  }
  await runFfmpeg([
    '-loop',
    '1',
    '-framerate',
    '1',
    '-i',
    file('poster.jpg'),
    '-f',
    'f32le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    '2',
    '-i',
    file('adjusted.pcm'),
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-preset',
    'ultrafast',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-t',
    String(duration),
    '-movflags',
    '+faststart',
    file('audio.mp4'),
  ]);
  if ((await stat(file('audio.mp4'))).size > 48 * 1024 * 1024)
    throw new Error('The rendered file exceeds the sharing limit.');
  await writeFile(
    file('result.json'),
    JSON.stringify({ title: track.title, artist: track.artist, duration }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  render(process.argv[2]).catch(async (error) => {
    const message = /conversion failed/.test(error.message)
      ? 'The audio could not be converted. Try another track.'
      : error.message;
    await writeFile(
      path.join(process.argv[2], 'error.json'),
      JSON.stringify({ error: message }),
    ).catch(() => {});
    process.exitCode = 1;
  });
}
