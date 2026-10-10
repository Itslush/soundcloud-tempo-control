import { open } from 'node:fs/promises';

export function mediaUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !(
      url.hostname.endsWith('.sndcdn.com') ||
      url.hostname === 'playback.media-streaming.soundcloud.cloud'
    )
  )
    throw new Error('Unsupported audio host.');
  return url.href;
}

async function responseFor(value, signal, fetcher) {
  let url = mediaUrl(value);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetcher(url, { signal, redirect: 'manual' });
    if (response.ok) return { response, url };
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status))
      throw new Error('SoundCloud audio could not be downloaded.');
    const location = response.headers.get('location');
    if (!location) throw new Error('The audio redirect is incomplete.');
    url = mediaUrl(new URL(location, url).href);
  }
  throw new Error('Too many audio redirects.');
}

async function consume(response, budget, write) {
  for await (const bytes of response.body) {
    budget.left -= bytes.length;
    if (budget.left < 0) throw new Error('The audio download is too large.');
    await write(bytes);
  }
}

export function playlistSegments(text, base) {
  if (
    !text.startsWith('#EXTM3U') ||
    !text.includes('#EXT-X-ENDLIST') ||
    /#EXT-X-(?:KEY|SESSION-KEY|BYTERANGE|STREAM-INF|DISCONTINUITY)/.test(text)
  )
    throw new Error('This stream cannot be rendered for Discord.');
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const segments = [];
  let initialized = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const match = /^#EXT-X-MAP:URI="([^"]+)"$/.exec(line);
      if (!match || initialized || segments.length)
        throw new Error('Unsupported audio initialization segment.');
      segments.push(mediaUrl(new URL(match[1], base).href));
      initialized = true;
    } else if (line && !line.startsWith('#')) {
      segments.push(mediaUrl(new URL(line, base).href));
    }
  }
  if (segments.length <= Number(initialized) || segments.length > 2000)
    throw new Error('Unsupported audio playlist length.');
  return segments;
}

export async function downloadMedia(
  url,
  file,
  { hls = false, maxBytes = 64 * 1024 * 1024, signal, fetcher = fetch } = {},
) {
  const budget = { left: maxBytes };
  const output = await open(file, 'wx');
  async function write(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await output.write(bytes, offset);
      if (!bytesWritten)
        throw new Error('The audio download could not be saved.');
      offset += bytesWritten;
    }
  }
  try {
    if (hls) {
      const chunks = [];
      const playlist = await responseFor(url, signal, fetcher);
      await consume(playlist.response, { left: 512 * 1024 }, async (bytes) =>
        chunks.push(bytes),
      );
      for (const segment of playlistSegments(
        Buffer.concat(chunks).toString('utf8'),
        playlist.url,
      ))
        await consume(
          (await responseFor(segment, signal, fetcher)).response,
          budget,
          write,
        );
    } else {
      await consume(
        (await responseFor(url, signal, fetcher)).response,
        budget,
        write,
      );
    }
  } finally {
    await output.close();
  }
}
