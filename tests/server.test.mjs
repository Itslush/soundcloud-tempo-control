import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createSoundCloud, trackUrl } from '../server/soundcloud.mjs';
import { createApp } from '../server/app.mjs';
import { matchesEtag, negotiateEncoding } from '../server/static-delivery.mjs';

const link = 'https://soundcloud.com/artist/track';
const track = {
  title: 'Test',
  uploader: 'Artist',
  duration: 30,
  webpage_url: link,
  extractor_key: 'Soundcloud',
  url: 'https://playback.media-streaming.soundcloud.cloud/track/playlist.m3u8',
  protocol: 'm3u8_native',
  format_id: 'hls_aac_160k',
};
const extractor = (extract = async () => track) => ({
  configured: true,
  extract,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function rawRequest(origin, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      origin,
      { path: pathname, method, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function staticFixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tempo-static-'));
  const siteRoot = path.join(directory, 'site');
  await mkdir(path.join(siteRoot, '_astro'), { recursive: true });
  await mkdir(path.join(siteRoot, 'guide'));
  await mkdir(path.join(siteRoot, 'empty'));
  const html =
    '<!doctype html><h1>Tempo controls</h1>' +
    '<p>Tempo and saved tracks</p>'.repeat(200);
  await Promise.all([
    writeFile(path.join(siteRoot, 'index.html'), html),
    writeFile(
      path.join(siteRoot, '404.html'),
      '<!doctype html><a href="/tempo/">Back to Tempo Control</a>',
    ),
    writeFile(
      path.join(siteRoot, 'guide', 'index.html'),
      '<h1>Setup guide</h1>',
    ),
    writeFile(
      path.join(siteRoot, '_astro', 'app.hash.js'),
      'export const value = "tempo";\n'.repeat(200),
    ),
    writeFile(
      path.join(siteRoot, 'sample.png'),
      Buffer.from([137, 80, 78, 71, 0, 0, 0, 0]),
    ),
    writeFile(path.join(siteRoot, '.secret'), 'private file'),
    writeFile(path.join(directory, 'outside.txt'), 'outside secret'),
  ]);
  const app = createApp({
    siteRoot,
    basePath: '/',
    service: { configured: false },
    ...options,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    siteRoot,
    directory,
    html,
    origin: `http://127.0.0.1:${app.address().port}`,
  };
}

test('encoding negotiation respects quality, exclusions, wildcards and malformed values', () => {
  for (const [header, expected] of [
    [undefined, 'identity'],
    ['', 'identity'],
    ['gzip', 'gzip'],
    ['gzip, br', 'br'],
    ['gzip;q=1, br;q=0.5', 'gzip'],
    ['gzip;q=0, br;q=0', 'identity'],
    ['GZIP; Q=1', 'gzip'],
    ['*;q=0.5', 'br'],
    ['*;q=0, gzip;q=1', 'gzip'],
    ['*;q=0', null],
    ['identity;q=0, br;q=0, gzip;q=0', null],
    ['identity;q=1, br;q=0.5', 'identity'],
    ['br;q=0, br;q=1', 'identity'],
    ['br;q=NaN, gzip;q=1', 'gzip'],
    ['br;q=1.1', 'identity'],
    ['br;q=-1', 'identity'],
    ['br;q=.8', 'identity'],
    ['br;q=0.1234', 'identity'],
    ['br;q=1;other=value', 'identity'],
  ])
    assert.equal(negotiateEncoding(header), expected, String(header));
  assert.equal(negotiateEncoding('gzip', false), 'identity');
  assert.equal(negotiateEncoding('gzip, identity;q=0', false), null);
});

test('etag matching accepts weak comparison and valid lists without trusting malformed lists', () => {
  const tag = 'W/"size-time-gzip"';
  for (const header of [
    tag,
    '"size-time-gzip"',
    '*',
    `"other", ${tag}`,
    `"comma,tag", ${tag}`,
  ])
    assert.equal(matchesEtag(header, tag), true, header);
  for (const header of [
    '',
    'not-a-tag',
    `${tag},`,
    `garbage, ${tag}`,
    `${tag} garbage`,
    `*, ${tag}`,
    '"size-time-br"',
  ])
    assert.equal(matchesEtag(header, tag), false, header);
});

test('missing page navigation serves HTML recovery with a real 404 and API errors remain JSON', async (t) => {
  const { origin } = await staticFixture(t, { basePath: '/tempo/' });
  for (const pathname of [
    '/tempo/missing',
    '/tempo/missing/',
    '/tempo/empty/',
    '/tempo/index.html/child',
  ]) {
    const result = await rawRequest(origin, pathname, {
      headers: { Accept: 'text/html' },
    });
    assert.equal(result.status, 404, pathname);
    assert.match(result.headers['content-type'], /^text\/html/);
    assert.match(result.body.toString(), /Back to Tempo Control/);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers.etag, undefined);
  }
  assert.match(
    (await rawRequest(origin, '/tempo/missing')).headers['content-type'],
    /^text\/html/,
  );
  for (const pathname of [
    '/tempo/api',
    '/tempo/api/missing',
    '/tempo/%61pi/missing',
    '/tempo/missing.js',
    '/outside',
    '/tempos/missing',
  ]) {
    const result = await rawRequest(origin, pathname);
    assert.equal(result.status, 404, pathname);
    assert.match(result.headers['content-type'], /^application\/json/);
  }
  for (const accept of [
    'application/json',
    'text/html;q=0, application/json',
  ]) {
    const result = await rawRequest(origin, '/tempo/missing', {
      headers: { Accept: accept },
    });
    assert.match(result.headers['content-type'], /^application\/json/);
  }
  const api = await rawRequest(origin, '/tempo/api/missing', {
    headers: { Accept: 'text/html', 'Accept-Encoding': 'br' },
  });
  assert.match(api.headers['content-type'], /^application\/json/);
  assert.equal(api.headers['content-encoding'], undefined);
  const head = await rawRequest(origin, '/tempo/missing', {
    method: 'HEAD',
    headers: { Accept: 'text/html' },
  });
  assert.equal(head.status, 404);
  assert.equal(head.body.length, 0);
  assert(Number(head.headers['content-length']) > 0);
});

test('unavailable 404 file falls back to JSON and HEAD suppresses every error body', async (t) => {
  const { origin, siteRoot } = await staticFixture(t);
  await rm(path.join(siteRoot, '404.html'));
  for (const pathname of ['/missing', '/api/missing', '/bad%ZZ']) {
    const result = await rawRequest(origin, pathname, {
      method: 'HEAD',
      headers: { Accept: 'text/html' },
    });
    assert.equal(
      result.status,
      pathname === '/bad%ZZ' ? 400 : pathname.startsWith('/api/') ? 405 : 404,
    );
    assert.equal(result.body.length, 0);
    assert.match(result.headers['content-type'], /^application\/json/);
  }
  const missing = await rawRequest(origin, '/missing', {
    headers: { Accept: 'text/html' },
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'Not found.' });
});

test('static delivery rejects malformed, hidden and escaped paths and keeps prefix redirects', async (t) => {
  const { origin } = await staticFixture(t, { basePath: '/tempo/' });
  for (const pathname of [
    '/tempo/%',
    '/tempo/%ZZ',
    '/tempo/%C0%AF',
    '/tempo/api/%ZZ',
  ]) {
    const result = await rawRequest(origin, pathname);
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.body), {
      error: 'Invalid request path.',
    });
  }
  for (const pathname of [
    '/tempo/.secret',
    '/tempo/%2esecret',
    '/tempo/%00',
    '/tempo/%5c..%5coutside.txt',
    '/tempo/%2e%2e%2foutside.txt',
    '/tempo/../outside.txt',
    '/tempo/%2e%2e/outside.txt',
  ]) {
    const result = await rawRequest(origin, pathname);
    assert.equal(result.status, 404, pathname);
    assert.doesNotMatch(result.body.toString(), /private file|outside secret/);
  }
  const redirect = await rawRequest(origin, '/tempo?x=1', { method: 'HEAD' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/tempo/?x=1');
  assert.equal(redirect.body.length, 0);
  for (const pathname of ['/tempo/', '/tempo/guide/', '/tempo/guide'])
    assert.equal((await rawRequest(origin, pathname)).status, 200);
  const post = await rawRequest(origin, '/tempo/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('static delivery refuses directory links that leave the configured root', async (t) => {
  const { origin, siteRoot, directory } = await staticFixture(t);
  const outside = path.join(directory, 'private');
  await mkdir(outside);
  await writeFile(path.join(outside, 'index.html'), 'outside secret');
  await symlink(
    outside,
    path.join(siteRoot, 'escaped'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = await rawRequest(origin, '/escaped/', {
    headers: { Accept: 'text/html' },
  });
  assert.equal(result.status, 404);
  assert.doesNotMatch(result.body.toString(), /outside secret/);
});

test('gzip and Brotli stream valid text and HEAD describes the same representation', async (t) => {
  const { origin, html } = await staticFixture(t);
  for (const encoding of ['gzip', 'br']) {
    const options = { headers: { 'Accept-Encoding': encoding } };
    const result = await rawRequest(origin, '/', options);
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], encoding);
    assert.equal(result.headers.vary, 'Accept-Encoding');
    assert.equal(result.headers['content-length'], undefined);
    assert.match(result.headers.etag, new RegExp(`-${encoding}"$`));
    assert.equal(
      (encoding === 'gzip'
        ? gunzipSync(result.body)
        : brotliDecompressSync(result.body)
      ).toString(),
      html,
    );
    assert(result.body.length < Buffer.byteLength(html) / 2);
    const head = await rawRequest(origin, '/', { ...options, method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    for (const header of [
      'content-type',
      'content-encoding',
      'content-length',
      'etag',
      'last-modified',
      'vary',
    ])
      assert.equal(head.headers[header], result.headers[header], header);
  }
  const identity = await rawRequest(origin, '/');
  assert.equal(identity.body.toString(), html);
  assert.equal(
    Number(identity.headers['content-length']),
    Buffer.byteLength(html),
  );
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.equal(identity.headers['x-content-type-options'], 'nosniff');
  assert.equal(identity.headers['x-frame-options'], 'DENY');
  assert.equal(identity.headers['referrer-policy'], 'no-referrer');
});

test('conditional requests return bodyless 304 and ETag takes precedence over modification dates', async (t) => {
  const { origin, siteRoot, html } = await staticFixture(t);
  const first = await rawRequest(origin, '/', {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  for (const method of ['GET', 'HEAD']) {
    for (const validator of [
      first.headers.etag,
      first.headers.etag.replace(/^W\//, ''),
      `"another", ${first.headers.etag}`,
      '*',
    ]) {
      const result = await rawRequest(origin, '/', {
        method,
        headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': validator },
      });
      assert.equal(result.status, 304);
      assert.equal(result.body.length, 0);
      assert.equal(result.headers.etag, first.headers.etag);
      assert.equal(result.headers.vary, 'Accept-Encoding');
      assert.equal(result.headers['content-length'], undefined);
    }
  }
  for (const validator of ['"stale"', `${first.headers.etag}, broken`]) {
    const result = await rawRequest(origin, '/', {
      headers: {
        'Accept-Encoding': 'gzip',
        'If-None-Match': validator,
        'If-Modified-Since': new Date(Date.now() + 60000).toUTCString(),
      },
    });
    assert.equal(result.status, 200);
  }
  const changedRepresentation = await rawRequest(origin, '/', {
    headers: { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag },
  });
  assert.equal(changedRepresentation.status, 200);
  assert.notEqual(changedRepresentation.headers.etag, first.headers.etag);
  for (const [date, status] of [
    [first.headers['last-modified'], 304],
    ['not a date', 200],
    ['Thu, 01 Jan 1970 00:00:00 GMT', 200],
  ])
    assert.equal(
      (
        await rawRequest(origin, '/', {
          headers: { 'If-Modified-Since': date },
        })
      ).status,
      status,
    );
  await writeFile(
    path.join(siteRoot, 'index.html'),
    html.replace('Tempo', 'Other'),
  );
  await utimes(
    path.join(siteRoot, 'index.html'),
    new Date(),
    new Date(Date.now() + 1000),
  );
  const changed = await rawRequest(origin, '/', {
    headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag },
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  const missing = await rawRequest(origin, '/missing', {
    headers: { Accept: 'text/html', 'If-None-Match': '*' },
  });
  assert.equal(missing.status, 404);
});

test('fingerprinted assets cache immutably while mutable files revalidate', async (t) => {
  const { origin } = await staticFixture(t, { basePath: '/tempo/' });
  const asset = await rawRequest(origin, '/tempo/_astro/app.hash.js', {
    headers: { 'Accept-Encoding': 'br' },
  });
  assert.equal(
    asset.headers['cache-control'],
    'public, max-age=31536000, immutable',
  );
  assert.equal(asset.headers['content-encoding'], 'br');
  const unchanged = await rawRequest(origin, '/tempo/_astro/app.hash.js', {
    headers: { 'Accept-Encoding': 'br', 'If-None-Match': asset.headers.etag },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(
    unchanged.headers['cache-control'],
    asset.headers['cache-control'],
  );
  assert.equal(
    (await rawRequest(origin, '/tempo/')).headers['cache-control'],
    'no-cache',
  );
  assert.equal(
    (
      await rawRequest(origin, '/tempo/api/status', {
        headers: { 'If-None-Match': '*' },
      })
    ).headers['cache-control'],
    'no-store',
  );
});

test('compression skips binary and oversized assets and does not violate identity exclusions', async (t) => {
  const { origin } = await staticFixture(t, {
    staticOptions: { maxCompressibleBytes: 100 },
  });
  for (const pathname of ['/', '/sample.png']) {
    const result = await rawRequest(origin, pathname, {
      headers: { 'Accept-Encoding': 'br, gzip' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], undefined);
    assert.equal(Number(result.headers['content-length']), result.body.length);
    const excluded = await rawRequest(origin, pathname, {
      headers: { 'Accept-Encoding': 'gzip, identity;q=0' },
    });
    assert.equal(excluded.status, 406);
    assert.equal(excluded.body.length, 0);
    assert.equal(excluded.headers.vary, 'Accept-Encoding');
  }
});

test('exhausted compression capacity falls back or asks for retry without retaining content', async (t) => {
  const { origin } = await staticFixture(t, {
    staticOptions: { maxCompressedStreams: 0 },
  });
  const fallback = await rawRequest(origin, '/', {
    headers: { 'Accept-Encoding': 'br' },
  });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers['content-encoding'], undefined);
  const retry = await rawRequest(origin, '/', {
    headers: { 'Accept-Encoding': 'br, identity;q=0' },
  });
  assert.equal(retry.status, 503);
  assert.equal(retry.headers['retry-after'], '1');
  assert.equal(retry.headers['cache-control'], 'no-store');
  assert.equal(retry.body.length, 0);
  assert.throws(
    () => createApp({ staticOptions: { maxCompressedStreams: 17 } }),
    /maxCompressedStreams/,
  );
  assert.throws(
    () => createApp({ staticOptions: { maxCompressibleBytes: Infinity } }),
    /maxCompressibleBytes/,
  );
});

test('a stalled compressed transfer is bounded and disconnect releases its slot', async (t) => {
  const { origin, siteRoot } = await staticFixture(t, {
    staticOptions: { maxCompressedStreams: 1 },
  });
  await writeFile(
    path.join(siteRoot, 'large.txt'),
    randomBytes(4 * 1024 * 1024),
  );
  let first;
  const closed = new Promise((resolve) => {
    first = httpRequest(origin + '/large.txt', {
      headers: { 'Accept-Encoding': 'br' },
    });
    first.once('close', resolve);
    first.on('error', () => {});
  });
  const started = new Promise((resolve, reject) => {
    first.once('response', (response) => {
      response.pause();
      response.on('error', () => {});
      resolve(response.headers);
    });
    first.once('error', reject);
  });
  t.after(() => first.destroy());
  first.end();
  assert.equal((await started)['content-encoding'], 'br');
  const bounded = await rawRequest(origin, '/', {
    headers: { 'Accept-Encoding': 'br' },
  });
  assert.equal(bounded.status, 200);
  assert.equal(bounded.headers['content-encoding'], undefined);
  first.destroy();
  await closed;
  let restored;
  for (let attempt = 0; attempt < 30; attempt++) {
    restored = await rawRequest(origin, '/', {
      headers: { 'Accept-Encoding': 'br' },
    });
    if (restored.headers['content-encoding'] === 'br') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(restored.headers['content-encoding'], 'br');
});

test('accepts public track and short links and discards tracking and tempo fragments', () => {
  assert.equal(trackUrl(link + '?utm_source=x#sct=code'), link);
  assert.equal(trackUrl('https://www.soundcloud.com/artist/track/'), link);
  assert.equal(
    trackUrl('https://on.soundcloud.com/abc'),
    'https://on.soundcloud.com/abc',
  );
  for (const value of [
    null,
    'https://evil.test/a',
    'https://soundcloud.com.evil.test/a/b',
    'http://soundcloud.com/a/b',
    'https://u:p@soundcloud.com/a/b',
    'https://soundcloud.com:8080/a/b',
    'file:///tmp/a',
    'not a link',
    'https://soundcloud.com/artist',
    'https://soundcloud.com/a/sets/b',
    'https://soundcloud.com/a/sets',
    'https://soundcloud.com/a/b/secret',
    'https://soundcloud.com/a/%3Bcommand',
    'https://on.soundcloud.com/a/b',
    'https://soundcloud.com/you/likes',
  ])
    assert.throws(() => trackUrl(value), { status: 400 });
});

test('missing yt-dlp setup produces an actionable response', async () => {
  const service = createSoundCloud({ extractor: { configured: false } });
  assert.equal(service.configured, false);
  await assert.rejects(service.resolve(link), {
    status: 503,
    message: /setup:backend/,
  });
});

test('resolves without credentials, caches for a minute, and shares concurrent extraction', async () => {
  let calls = 0;
  let now = 0;
  const service = createSoundCloud({
    now: () => now,
    extractor: extractor(async (url) => {
      calls++;
      await tick();
      return { ...track, webpage_url: url };
    }),
  });
  const [first, second] = await Promise.all([
    service.resolve(link),
    service.resolve(link),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    title: 'Test',
    artist: 'Artist',
    duration: 30,
    permalink: link,
    stream: track.url,
    format: 'hls',
    preview: false,
  });
  assert.equal(calls, 1);
  await service.resolve(link);
  assert.equal(calls, 1);
  now = 60001;
  await service.resolve(link);
  assert.equal(calls, 2);
});

test('bounded cache evicts the oldest of 128 tracks', async () => {
  let calls = 0;
  const service = createSoundCloud({
    extractor: extractor(async (url) => {
      calls++;
      return { ...track, webpage_url: url };
    }),
  });
  for (let i = 0; i < 129; i++) await service.resolve(link + i);
  await service.resolve(link + 128);
  assert.equal(calls, 129);
  await service.resolve(link + 0);
  assert.equal(calls, 130);
});

test('accepts progressive previews without claiming they are full tracks', async () => {
  const service = createSoundCloud({
    extractor: extractor(async () => ({
      ...track,
      url: 'https://cf-media.sndcdn.com/a.mp3',
      protocol: 'http',
      format_id: 'http_mp3_preview',
    })),
  });
  const data = await service.resolve(link);
  assert.equal(data.format, 'audio');
  assert.equal(data.preview, true);
});

test('rejects unrelated CDN hosts, invalid metadata, private, DRM and unsupported formats', async () => {
  for (const override of [
    { url: 'https://evil.test/audio' },
    { url: 'https://sndcdn.com.evil.test/audio' },
    {
      url: 'https://playback.media-streaming.soundcloud.cloud.evil.test/audio',
    },
    { url: 'http://cf-media.sndcdn.com/audio' },
    { url: 'https://secret@cf-media.sndcdn.com/audio' },
    { url: 'file:///audio' },
    { url: null },
    { protocol: 'ftp' },
    { duration: Infinity },
    { duration: 0 },
    { has_drm: true },
    { is_live: true },
    { availability: 'private' },
    { availability: 'subscriber_only' },
    { extractor_key: 'Generic' },
    { _type: 'playlist' },
    { webpage_url: 'https://soundcloud.com/artist/other' },
  ]) {
    const service = createSoundCloud({
      extractor: extractor(async () => ({ ...track, ...override })),
    });
    await assert.rejects(service.resolve(link), (error) =>
      [403, 502].includes(error.status),
    );
  }
});

test('expands short links only within SoundCloud and strips tracking', async () => {
  const service = createSoundCloud({
    extractor: extractor(),
    fetcher: async (url, options) => {
      assert.equal(url, 'https://on.soundcloud.com/abc');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, undefined);
      return new Response(null, {
        status: 302,
        headers: { location: link + '?tracking=x' },
      });
    },
  });
  assert.equal(
    (await service.resolve('https://on.soundcloud.com/abc')).permalink,
    link,
  );
});

test('rejects short-link redirects to other hosts, profiles, loops and missing targets', async () => {
  for (const location of [
    'https://127.0.0.1/audio',
    'https://evil.test/a/b',
    'https://soundcloud.com/artist',
    'https://on.soundcloud.com/abc',
    '',
  ]) {
    let calls = 0;
    const service = createSoundCloud({
      extractor: extractor(() => assert.fail('must not launch extractor')),
      fetcher: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: location ? { location } : {},
        });
      },
    });
    await assert.rejects(service.resolve('https://on.soundcloud.com/abc'));
    assert(calls <= 4);
  }
});

test('one cancelled caller does not cancel another caller for the same track', async () => {
  let finish;
  let extractionSignal;
  const service = createSoundCloud({
    extractor: extractor((url, signal) => {
      extractionSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
  });
  const controller = new AbortController();
  const first = service.resolve(link, controller.signal);
  const second = service.resolve(link);
  await tick();
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(extractionSignal.aborted, false);
  finish(track);
  assert.equal((await second).title, 'Test');
});

test('last caller cancellation aborts extraction and does not cache the result', async () => {
  let calls = 0;
  let extractionSignal;
  const service = createSoundCloud({
    extractor: extractor((url, signal) => {
      extractionSignal = signal;
      if (++calls > 1) return track;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    }),
  });
  const controller = new AbortController();
  const result = service.resolve(link, controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  await tick();
  assert.equal(extractionSignal.aborted, true);
  assert.equal((await service.resolve(link)).title, 'Test');
  assert.equal(calls, 2);
});

test('allows at most four distinct concurrent extraction jobs', async () => {
  const service = createSoundCloud({
    extractor: extractor(
      (url, signal) =>
        new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    ),
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const jobs = controllers.map((controller, i) =>
    service.resolve(link + i, controller.signal),
  );
  const settled = Promise.allSettled(jobs);
  await tick();
  await assert.rejects(service.resolve(link + 'extra'), { status: 429 });
  for (const controller of controllers) controller.abort();
  assert((await settled).every((result) => result.status === 'rejected'));
});

test('serves assets and API under a configured deployment prefix', async () => {
  const app = createApp({
    origin: 'https://tempo.test',
    basePath: '/tempo/',
    siteRoot: fileURLToPath(new URL('./fixtures/', import.meta.url)),
    service: { configured: true, resolve: async () => track },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(base + '/tempo/api/status')).status, 200);
    assert.equal(
      (await fetch(base + '/tempo/inline-fixture.html')).status,
      200,
    );
    assert.equal((await fetch(base + '/api/status')).status, 404);
    assert.equal((await fetch(base + '/tempohost/api/status')).status, 404);
    const redirect = await fetch(base + '/tempo', { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/tempo/');
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('HTTP surface limits requests, methods and cross-site access', async () => {
  const app = createApp({
    basePath: '/',
    origin: 'https://tempo.test',
    service: { configured: true, resolve: async () => track },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.deepEqual(await (await fetch(base + '/api/status')).json(), {
      soundcloud: true,
    });
    const cors = await fetch(base + '/api/status', {
      headers: { Origin: 'https://tempo.test' },
    });
    assert.equal(
      cors.headers.get('access-control-allow-origin'),
      'https://tempo.test',
    );
    assert.equal(cors.headers.get('vary'), 'Origin');
    assert.equal(
      (await fetch(base + '/api/resolve', { method: 'POST' })).status,
      405,
    );
    assert.equal(
      (
        await fetch(base + '/api/resolve', {
          headers: { Origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + '/.env')).status, 404);
    assert.equal((await fetch(base + '/%2eenv')).status, 404);
    assert.equal((await fetch(base + '/.venv/pyvenv.cfg')).status, 404);
    for (let i = 0; i < 20; i++)
      assert.equal((await fetch(base + '/api/resolve')).status, 200);
    const limited = await fetch(base + '/api/resolve');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('proxy client addresses are trusted only when explicitly enabled', async (t) => {
  for (const trustLoopbackProxy of [false, true]) {
    const app = createApp({
      basePath: '/',
      trustLoopbackProxy,
      service: { configured: true, resolve: async () => track },
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      app.closeAllConnections();
      app.close();
    });
    const url = `http://127.0.0.1:${app.address().port}/api/resolve`;
    for (let i = 0; i < 20; i++) {
      assert.equal(
        (await fetch(url, { headers: { 'X-Real-IP': '192.0.2.1' } })).status,
        200,
      );
    }
    assert.equal(
      (await fetch(url, { headers: { 'X-Real-IP': '192.0.2.1' } })).status,
      429,
    );
    assert.equal(
      (await fetch(url, { headers: { 'X-Real-IP': '192.0.2.2' } })).status,
      trustLoopbackProxy ? 200 : 429,
    );
  }
});

test('disconnecting a browser aborts its pending server request', async () => {
  let received;
  let aborted;
  const entered = new Promise((resolve) => {
    received = resolve;
  });
  const cancelled = new Promise((resolve) => {
    aborted = resolve;
  });
  const app = createApp({
    basePath: '/',
    service: {
      configured: true,
      resolve: (url, signal) =>
        new Promise((resolve, reject) => {
          received();
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${app.address().port}/api/resolve?url=test`,
      { signal: controller.signal },
    );
    await entered;
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    await cancelled;
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  }
});
