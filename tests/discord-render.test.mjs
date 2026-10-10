import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  readdir,
} from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderPcm, SAMPLE_RATE } from '../server/shares/audio.mjs';
import {
  mediaUrl,
  playlistSegments,
  downloadMedia,
} from '../server/shares/download.mjs';
import { parseRenderCode, createShareStore } from '../server/shares/store.mjs';
import { encodeTempoCode } from '../src/tempo-share.js';
import { createSharesApp, embedHtml } from '../server/shares/app.mjs';

const profile = {
  v: 1,
  track: '/artist/song',
  duration: 4,
  points: [{ t: 0, r: 0.75, d: 0, c: 'instant' }],
  pitch: 'preserve',
  keyShift: -3,
};
function frequency(data, from, to, channel = 0) {
  let crossings = 0;
  let energy = 0;
  const start = Math.round(from * SAMPLE_RATE);
  const end = Math.round(to * SAMPLE_RATE);
  for (let i = start + 1; i < end; i++) {
    const value = data.readFloatLE(i * 8 + channel * 4);
    energy += value * value;
    if (value >= 0 && data.readFloatLE((i - 1) * 8 + channel * 4) < 0)
      crossings++;
  }
  assert.ok(energy / (end - start) > 0.001, 'audio must be audible');
  return crossings / (to - from);
}

test('real WASM render preserves rate, semitone shift, stereo and automated pitch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tempo-render-test-'));
  try {
    const input = Buffer.alloc(4 * SAMPLE_RATE * 8);
    for (let i = 0; i < 4 * SAMPLE_RATE; i++)
      for (let channel = 0; channel < 2; channel++)
        input.writeFloatLE(
          0.2 *
            Math.sin((i * 2 * Math.PI * (channel ? 660 : 440)) / SAMPLE_RATE),
          i * 8 + channel * 4,
        );
    await writeFile(path.join(dir, 'source.pcm'), input);
    const duration = await renderPcm(
      path.join(dir, 'source.pcm'),
      path.join(dir, 'out.pcm'),
      profile,
    );
    assert.ok(Math.abs(duration - 4 / 0.75) < 0.005, String(duration));
    const output = await readFile(path.join(dir, 'out.pcm'));
    assert.ok(Math.abs(frequency(output, 1, 3) - 440 * 2 ** (-3 / 12)) < 3);
    assert.ok(Math.abs(frequency(output, 1, 3, 1) - 660 * 2 ** (-3 / 12)) < 3);
    const automated = {
      ...profile,
      pitch: 'natural',
      pitchPoints: [
        { t: 0, k: 0, d: 0, c: 'instant' },
        { t: 2, k: 12, d: 0, c: 'instant' },
      ],
    };
    await renderPcm(
      path.join(dir, 'source.pcm'),
      path.join(dir, 'auto.pcm'),
      automated,
    );
    const shifted = await readFile(path.join(dir, 'auto.pcm'));
    assert.ok(Math.abs(frequency(shifted, 0.6, 1.6) - 330) < 3);
    assert.ok(Math.abs(frequency(shifted, 3.5, 4.5) - 660) < 3);
    const rampDuration = await renderPcm(
      path.join(dir, 'source.pcm'),
      path.join(dir, 'ramp.pcm'),
      {
        ...profile,
        points: [
          { t: 0, r: 0.5, d: 0, c: 'instant' },
          { t: 4, r: 1.5, d: 4, c: 'linear' },
        ],
      },
    );
    assert.ok(
      Math.abs(rampDuration - 4 * Math.log(3)) < 0.015,
      String(rampDuration),
    );
    await assert.rejects(
      renderPcm(path.join(dir, 'source.pcm'), path.join(dir, 'mismatch.pcm'), {
        ...profile,
        duration: 30,
      }),
      /length/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('render boundary reuses canonical validation and rejects private endpoints', () => {
  assert.deepEqual(parseRenderCode(encodeTempoCode(profile)), profile);
  for (const extra of [
    { duration: 901 },
    { track: '/../../secret' },
    { keyShift: 50 },
    { points: [] },
  ])
    assert.throws(() =>
      parseRenderCode(encodeTempoCode({ ...profile, ...extra })),
    );
  for (const url of [
    'http://x.sndcdn.com/a',
    'https://127.0.0.1/a',
    'https://x.sndcdn.com.evil.org/a',
    'https://x.sndcdn.com:444/a',
    'https://user@x.sndcdn.com/a',
  ])
    assert.throws(() => mediaUrl(url));
  assert.deepEqual(
    playlistSegments(
      '#EXTM3U\n#EXTINF:3\npart.aac\n#EXT-X-ENDLIST',
      'https://x.sndcdn.com/a/playlist',
    ),
    ['https://x.sndcdn.com/a/part.aac'],
  );
  assert.deepEqual(
    playlistSegments(
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3\npart.m4s\n#EXT-X-ENDLIST',
      'https://x.sndcdn.com/a/list',
    ),
    ['https://x.sndcdn.com/a/init.mp4', 'https://x.sndcdn.com/a/part.m4s'],
  );
  for (const text of [
    '#EXTM3U\nhttps://127.0.0.1/a\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\na\n#EXT-X-ENDLIST',
    '#EXTM3U\na',
  ])
    assert.throws(() => playlistSegments(text, 'https://x.sndcdn.com/a'));
});

test('downloads enforce size and validate every redirect', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tempo-download-test-'));
  try {
    let calls = 0;
    await assert.rejects(
      downloadMedia('https://x.sndcdn.com/a', path.join(dir, 'redirect'), {
        fetcher: async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { location: 'https://127.0.0.1/private' },
          });
        },
      }),
      /host/,
    );
    assert.equal(calls, 1);
    const urls = [];
    await downloadMedia(
      'https://x.sndcdn.com/old/list.m3u8',
      path.join(dir, 'playlist'),
      {
        hls: true,
        fetcher: async (url) => {
          urls.push(url);
          if (urls.length === 1)
            return new Response(null, {
              status: 302,
              headers: { location: '/new/list.m3u8' },
            });
          if (urls.length === 2)
            return new Response('#EXTM3U\n#EXTINF:3\npart.aac\n#EXT-X-ENDLIST');
          return new Response('audio');
        },
      },
    );
    assert.equal(urls[2], 'https://x.sndcdn.com/new/part.aac');
    assert.equal(await readFile(path.join(dir, 'playlist'), 'utf8'), 'audio');
    await assert.rejects(
      downloadMedia('https://x.sndcdn.com/a', path.join(dir, 'oversize'), {
        maxBytes: 3,
        fetcher: async () => new Response('1234'),
      }),
      /too large/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store bounds workers, retries failures, publishes atomically and expires media', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tempo-store-test-'));
  let time = Date.now();
  let child, work;
  const launch = (_command, args) => {
    work = args.at(-1);
    child = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  let store;
  try {
    await mkdir(path.join(dir, 'jobs'));
    for (let i = 0; i < 64; i++)
      await writeFile(
        path.join(dir, 'jobs', i.toString(16).padStart(32, '0') + '.json'),
        JSON.stringify({ state: 'failed', expires: time + 86400000 }),
      );
    store = await createShareStore(dir, { launch, now: () => time });
    const code = encodeTempoCode(profile);
    const job = await store.create(code);
    assert.equal(job.state, 'rendering');
    assert.equal((await store.create(code)).id, job.id);
    await assert.rejects(
      store.create(encodeTempoCode({ ...profile, keyShift: 1 })),
      (error) => error.status === 429,
    );
    await writeFile(path.join(work, 'audio.mp4'), 'rendered');
    await writeFile(path.join(work, 'poster.jpg'), 'poster');
    await writeFile(
      path.join(work, 'result.json'),
      JSON.stringify({ title: 'song', duration: 5.333 }),
    );
    child.emit('close', 0);
    for (
      let i = 0;
      i < 100 && (await store.read(job.id)).state !== 'ready';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await store.read(job.id)).state, 'ready');
    assert.equal(
      await readFile(path.join(dir, 'media', job.id + '.mp4'), 'utf8'),
      'rendered',
    );
    for (
      let i = 0;
      i < 100 &&
      (await readdir(path.join(dir, 'jobs'))).some((name) =>
        name.endsWith('.work'),
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    store.close();
    time += 8 * 86400000;
    store = await createShareStore(dir, { launch, now: () => time });
    assert.deepEqual(await readdir(path.join(dir, 'media')), []);
    const retry = await store.create(code);
    child.emit('close', 1);
    for (
      let i = 0;
      i < 100 && (await store.read(retry.id)).state !== 'failed';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await store.read(retry.id)).state, 'failed');
  } finally {
    store?.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP shares require explicit publishing, enforce CORS, and hide internal profile state', async (t) => {
  const id = 'a'.repeat(32);
  let created = 0;
  const data = {
    state: 'ready',
    title: '<script>alert(1)</script>',
    artist: 'A & B',
    expires: Date.now() + 5000,
    code: encodeTempoCode(profile),
  };
  const app = createSharesApp({
    publicOrigin: 'https://render.example',
    siteUrl: 'https://site.example/',
    store: {
      async create() {
        created++;
        return { id, ...data };
      },
      async read() {
        return data;
      },
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.address().port}/soundcloud-tempo-control/`;
  const post = (body, site = 'https://site.example') =>
    fetch(origin + 'api/shares', {
      method: 'POST',
      headers: { origin: site, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ publish: true }, 'https://evil.example')).status,
    403,
  );
  assert.equal((await post({ code: data.code })).status, 400);
  assert.equal((await post({ code: data.code, publish: true })).status, 200);
  assert.equal(created, 1);
  const status = await (await fetch(origin + 'api/shares/' + id)).json();
  assert.equal(status.code, undefined);
  assert.equal(
    status.url,
    'https://render.example/soundcloud-tempo-control/listen/' + id,
  );
  const html = await (await fetch(origin + 'listen/' + id)).text();
  assert.ok(html.includes('video/mp4'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert'));
  assert.equal(
    (await fetch(origin + 'api/shares/../../etc/passwd')).status,
    404,
  );
  assert.equal(
    (
      await fetch(origin + 'api/shares', {
        method: 'OPTIONS',
        headers: { origin: 'https://site.example' },
      })
    ).status,
    204,
  );
});
