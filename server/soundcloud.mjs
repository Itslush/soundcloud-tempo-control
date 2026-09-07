import { createExtractor } from './ytdlp.mjs';
import { ServiceError } from './errors.mjs';

export { ServiceError } from './errors.mjs';

export function trackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !url ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'].includes(
      url.hostname,
    )
  )
    throw new ServiceError(400, 'Enter a SoundCloud track link.');
  const parts = url.pathname.split('/').filter(Boolean);
  const short = url.hostname === 'on.soundcloud.com';
  if (
    parts.length !== (short ? 1 : 2) ||
    parts.some((part) => !/^[\w-]+$/.test(part)) ||
    (!short &&
      [
        'sets',
        'likes',
        'reposts',
        'tracks',
        'albums',
        'popular-tracks',
      ].includes(parts[1])) ||
    (!short &&
      ['discover', 'search', 'you', 'settings', 'upload', 'charts'].includes(
        parts[0],
      ))
  )
    throw new ServiceError(
      400,
      'Use a single public track, not a playlist or profile.',
    );
  url.hostname = short ? url.hostname : 'soundcloud.com';
  url.pathname = '/' + parts.join('/');
  url.hash = '';
  url.search = '';
  return url.href;
}

function streamUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    (!url.hostname.endsWith('.sndcdn.com') &&
      url.hostname !== 'playback.media-streaming.soundcloud.cloud')
  )
    throw new ServiceError(502, 'The audio host is not supported.');
  return url.href;
}

function trackData(track, url) {
  if (
    !track ||
    track.extractor_key !== 'Soundcloud' ||
    (track._type && track._type !== 'video') ||
    trackUrl(track.webpage_url) !== url
  )
    throw new ServiceError(502, 'The track response did not match the link.');
  if (
    track.has_drm ||
    track.is_live ||
    (track.availability && track.availability !== 'public')
  )
    throw new ServiceError(403, 'This track is not available for preview.');
  if (!['http', 'https', 'm3u8', 'm3u8_native'].includes(track.protocol))
    throw new ServiceError(502, 'The audio format is not supported.');
  if (!Number.isFinite(track.duration) || track.duration <= 0)
    throw new ServiceError(502, 'Track duration is unavailable.');
  return {
    title: String(track.title || 'SoundCloud track').slice(0, 300),
    artist: String(track.uploader || '').slice(0, 200),
    permalink: url,
    duration: track.duration,
    stream: streamUrl(track.url),
    format: track.protocol.startsWith('m3u8') ? 'hls' : 'audio',
    preview: String(track.format_id).includes('preview'),
  };
}

function subscribe(job, signal) {
  signal?.throwIfAborted();
  job.users++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => finish(reject, signal.reason);
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (--job.users === 0 && !job.done) job.controller.abort();
      callback(value);
    }
    signal?.addEventListener('abort', abort, { once: true });
    job.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal?.aborted) abort();
  });
}

export function createSoundCloud({
  extractor = createExtractor(),
  fetcher = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const pending = new Map();

  async function expand(value, signal) {
    let url = value;
    for (let i = 0; i < 4; i++) {
      if (new URL(url).hostname === 'soundcloud.com') return url;
      const response = await fetcher(url, {
        redirect: 'manual',
        signal,
        headers: { Accept: 'text/html' },
      });
      await response.body?.cancel();
      if (response.status === 429)
        throw new ServiceError(429, 'SoundCloud is busy. Try again shortly.');
      if (![301, 302, 303, 307, 308].includes(response.status))
        throw new ServiceError(400, 'Use the full SoundCloud track link.');
      const location = response.headers.get('location');
      if (!location)
        throw new ServiceError(502, 'The track link is incomplete.');
      url = trackUrl(new URL(location, url).href);
    }
    throw new ServiceError(502, 'The track link redirected too many times.');
  }

  async function load(value, signal) {
    const url = await expand(value, signal);
    const data = trackData(await extractor.extract(url, signal), url);
    signal.throwIfAborted();
    for (const [key, entry] of cache)
      if (entry.expires <= now()) cache.delete(key);
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(value, { data, expires: now() + 60000 });
    return data;
  }

  return {
    get configured() {
      return extractor.configured;
    },
    async resolve(value, signal) {
      signal?.throwIfAborted();
      const url = trackUrl(value);
      if (!extractor.configured)
        throw new ServiceError(
          503,
          'Track loading needs setup. Run npm run setup:backend.',
        );
      if (cache.get(url)?.expires > now()) return cache.get(url).data;
      let job = pending.get(url);
      if (job?.controller.signal.aborted) {
        pending.delete(url);
        job = null;
      }
      if (!job) {
        if (pending.size >= 4)
          throw new ServiceError(429, 'Preview is busy. Try again shortly.');
        const controller = new AbortController();
        job = { controller, users: 0, done: false };
        const deadline = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(35000),
        ]);
        const current = job;
        job.promise = load(url, deadline).finally(() => {
          current.done = true;
          if (pending.get(url) === current) pending.delete(url);
        });
        pending.set(url, job);
      }
      return subscribe(job, signal);
    },
  };
}
