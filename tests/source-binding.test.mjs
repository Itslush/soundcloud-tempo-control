import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSourceBinding } from '../src/audio/source-binding.mjs';

const ROOT = 'https://playback.media-streaming.soundcloud.cloud/public/';
const MIME = 'audio/mp4; codecs="mp4a.40.2"';
const playlist = (names) =>
  '#EXTM3U\n' +
  names.map((name) => `#EXTINF:10,\n${name}\n`).join('') +
  '#EXT-X-ENDLIST\n';
const digest = (algorithm, bytes) =>
  Promise.resolve(
    Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
  );

function box(type, payload) {
  const value = new Uint8Array(payload.length + 8);
  new DataView(value.buffer).setUint32(0, value.length);
  value.set(
    Array.from(type, (character) => character.charCodeAt(0)),
    4,
  );
  value.set(payload, 8);
  return value;
}

function payload(length = 40001, seed = 7) {
  return Uint8Array.from(
    { length },
    (_, index) => (index * seed + (index >>> 8)) & 255,
  );
}

function fixture(options = {}) {
  const binding = createSourceBinding({ digest, ...options });
  const source = {};
  const buffer = {};
  const media = { currentSrc: 'blob:public-a' };
  binding.objectUrl(media.currentSrc, source);
  binding.sourceBuffer(source, buffer, MIME);
  binding.resolve(media);
  return { binding, source, buffer, media };
}

function weakReferences() {
  const references = new WeakMap();
  class WeakRef {
    constructor(target) {
      this.target = target;
      references.set(target, this);
    }
    deref() {
      return this.target;
    }
  }
  return {
    global: { WeakRef },
    collect(target) {
      references.get(target).target = undefined;
    },
  };
}

function stream(binding, name, data, sizes = [37, 16001, 3, 809]) {
  const reader = binding.response(ROOT + name);
  assert.ok(reader);
  let offset = 0;
  let index = 0;
  while (offset < data.length) {
    const count = Math.min(sizes[index++ % sizes.length], data.length - offset);
    reader.write(data.subarray(offset, offset + count));
    offset += count;
  }
  reader.close();
  return reader;
}

test('binds exact media ownership through copied mdat bytes, independent of chunk boundaries and changed init boxes', async () => {
  const { binding, buffer, media } = fixture();
  binding.playlist(ROOT + 'playlist.m3u8', playlist(['data000.m4s']));
  const mdat = box('mdat', payload());
  const network = new Uint8Array(mdat.length + 31);
  network.set(box('moof', new Uint8Array(23)));
  network.set(mdat, 31);
  stream(binding, 'data000.m4s', network);
  binding.append(buffer, box('ftyp', new Uint8Array(500)));
  binding.append(buffer, mdat.slice());
  await binding.settle();
  const result = binding.resolve(media);
  assert.equal(result.status, 'bound');
  assert.equal(result.playlistUrl, ROOT + 'playlist.m3u8');
  assert.equal(result.proof, 'sha256-mdat-blocks');
  assert.equal(binding.stats().scratchBytes, 0);
  assert.equal(binding.stats().digestBytes, 0);
  await binding.dispose();
});

test('prefetched playlists never bind by arrival order and unchanged prefixes do not disguise different payloads', async () => {
  const { binding, buffer, media } = fixture();
  const first = payload();
  const second = first.slice();
  second[12345] ^= 1;
  binding.playlist(ROOT + 'prefetch.m3u8', playlist(['future.m4s']));
  binding.playlist(ROOT + 'active.m3u8', playlist(['active.m4s']));
  stream(binding, 'future.m4s', box('mdat', first));
  stream(binding, 'active.m4s', box('mdat', second));
  binding.append(buffer, box('mdat', second));
  await binding.settle();
  assert.equal(binding.resolve(media).playlistUrl, ROOT + 'active.m3u8');
  await binding.dispose();
});

test('identical payloads under different playlists remain explicitly ambiguous', async () => {
  const { binding, buffer, media } = fixture();
  const data = box('mdat', payload());
  binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s']));
  binding.playlist(ROOT + 'b.m3u8', playlist(['b.m4s']));
  stream(binding, 'a.m4s', data);
  stream(binding, 'b.m4s', data);
  binding.append(buffer, data);
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'ambiguous');
  await binding.dispose();
});

test('only the source actually attached to currentSrc can bind', async () => {
  const { binding, buffer, media } = fixture();
  const data = box('mdat', payload());
  binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s']));
  stream(binding, 'a.m4s', data);
  binding.append(buffer, data);
  await binding.settle();
  const previous = binding.resolve(media);
  media.currentSrc = 'blob:another-source';
  assert.equal(binding.resolve(media).status, 'unbound');
  assert.ok(binding.resolve(media).generation > previous.generation);
  await binding.dispose();
});

test('queue invalidation rejects both in-flight hashes and later appends from the old MediaSource', async () => {
  const releases = [];
  const { binding, buffer, media } = fixture({
    digest: (algorithm, bytes) => {
      const hash = digest(algorithm, bytes);
      return new Promise((resolve) => releases.push(() => resolve(hash)));
    },
  });
  const data = box('mdat', payload(100));
  binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s']));
  stream(binding, 'a.m4s', data);
  binding.append(buffer, data);
  binding.invalidate(media);
  while (releases.length || binding.stats().pendingHashBytes) {
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'unbound');
  binding.append(buffer, data);
  while (releases.length || binding.stats().pendingHashBytes) {
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'unbound');
  const nextSource = {};
  const nextBuffer = {};
  media.currentSrc = 'blob:new-track';
  binding.objectUrl(media.currentSrc, nextSource);
  binding.sourceBuffer(nextSource, nextBuffer, MIME);
  binding.append(nextBuffer, data);
  while (releases.length || binding.stats().pendingHashBytes) {
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'bound');
  await binding.dispose();
});

test('new appends cannot retain a previous playlist while their own proof is missing', async () => {
  const { binding, buffer, media } = fixture();
  binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s']));
  const data = box('mdat', payload());
  stream(binding, 'a.m4s', data);
  binding.append(buffer, data);
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'bound');
  binding.append(buffer, box('mdat', payload(33001, 17)));
  assert.equal(binding.resolve(media).status, 'unbound');
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'unbound');
  await binding.dispose();
});

test('incomplete and aborted network resources cannot publish a payload proof', async () => {
  for (const ending of ['close', 'abort']) {
    const { binding, buffer, media } = fixture();
    binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s']));
    const data = box('mdat', payload());
    const reader = binding.response(ROOT + 'a.m4s');
    reader.write(data);
    if (ending === 'close') reader.write(new Uint8Array([0, 0, 0]));
    reader[ending]();
    binding.append(buffer, data);
    await binding.settle();
    assert.equal(binding.resolve(media).status, 'unbound');
    await binding.dispose();
  }
});

test('malformed, encrypted, live, oversized and foreign playlists are not candidates', async () => {
  const { binding } = fixture({
    limits: { playlistCharacters: 200, segments: 2 },
  });
  for (const [url, text] of [
    [ROOT + 'a.m3u8', playlist(['a.m4s']).replace('#EXT-X-ENDLIST', '')],
    [ROOT + 'a.m3u8', playlist(['a.m4s']) + '#EXT-X-KEY:METHOD=AES-128'],
    [ROOT + 'a.m3u8', playlist(['a.m4s', 'b.m4s', 'c.m4s'])],
    [ROOT + 'a.m3u8', playlist(['https://other.example/data.m4s'])],
    [ROOT + 'a.m3u8', 'x'.repeat(201)],
    [
      'https://name:password@playback.media-streaming.soundcloud.cloud/a.m3u8',
      playlist(['a.m4s']),
    ],
    [ROOT.replace('https:', 'http:') + 'a.m3u8', playlist(['a.m4s'])],
  ])
    assert.equal(binding.playlist(url, text), false);
  assert.equal(binding.response(ROOT + 'unknown.m4s'), null);
  await binding.dispose();
});

test('source close releases parser ownership and permits bounded subsequent source generations', async () => {
  const { binding, source, buffer, media } = fixture({
    limits: { sources: 1 },
  });
  binding.append(buffer, box('mdat', payload()).subarray(0, 100));
  binding.closeSource(source);
  await binding.settle();
  assert.equal(binding.stats().scratchBytes, 0);
  assert.equal(binding.stats().parsers, 0);
  assert.equal(binding.resolve(media).status, 'unbound');
  const next = {};
  binding.objectUrl('blob:next', next);
  binding.sourceBuffer(next, {}, MIME);
  assert.equal(binding.stats().sources, 1);
  await binding.dispose();
  assert.equal(binding.stats().parsers, 0);
});

test('hash, scratch and metadata ownership stay bounded when hashing is slow or rejected', async () => {
  const releases = [];
  const { binding, buffer, media } = fixture({
    limits: { pendingHashBytes: 20000 },
    digest: (algorithm, bytes) => {
      const hash = digest(algorithm, bytes);
      return new Promise((resolve) => releases.push(() => resolve(hash)));
    },
  });
  binding.append(buffer, box('mdat', payload(50000)));
  assert.equal(binding.resolve(media).status, 'unbound');
  assert.ok(binding.stats().peakPendingHashBytes <= 20000);
  assert.ok(binding.stats().peakScratchBytes <= 16384);
  for (const release of releases) release();
  await binding.dispose();
  assert.equal(binding.stats().pendingHashBytes, 0);
  assert.equal(binding.stats().scratchBytes, 0);
  assert.equal(binding.stats().digestBytes, 0);
  assert.ok(binding.stats().failures > 0);
});

test('unsupported source buffers and invalid MP4 boxes fail closed without leaking scratch', async () => {
  for (const data of [
    new Uint8Array(8),
    box('mdat', payload()).subarray(0, 10),
  ]) {
    const { binding, source, buffer, media } = fixture();
    binding.append(buffer, data);
    binding.closeSource(source);
    await binding.settle();
    assert.equal(binding.resolve(media).status, 'unbound');
    assert.equal(binding.stats().scratchBytes, 0);
    await binding.dispose();
  }
  const { binding, source, media } = fixture();
  binding.sourceBuffer(source, {}, 'audio/webm; codecs="opus"');
  assert.equal(binding.resolve(media).status, 'unbound');
  await binding.dispose();
});

test('terminal disposal joins pending hashes and never re-registers media', async () => {
  const { binding, buffer, media } = fixture();
  binding.append(buffer, box('mdat', payload()));
  const first = binding.dispose();
  assert.equal(binding.dispose(), first);
  await first;
  assert.equal(binding.resolve(media).status, 'unbound');
  assert.equal(binding.stats().media, 0);
  assert.equal(binding.stats().pendingHashBytes, 0);
  assert.equal(binding.stats().digestBytes, 0);
  assert.equal(binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s'])), false);
});

test('inactive playlists are evicted without displacing an attached proven source', async () => {
  const { binding, buffer, media } = fixture({ limits: { playlists: 2 } });
  const data = box('mdat', payload());
  binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s']));
  stream(binding, 'a.m4s', data);
  binding.append(buffer, data);
  await binding.settle();
  for (let index = 0; index < 10; index++) {
    assert.equal(
      binding.playlist(
        ROOT + `future${index}.m3u8`,
        playlist([`future${index}.m4s`]),
      ),
      true,
    );
    assert.equal(binding.resolve(media).playlistUrl, ROOT + 'a.m3u8');
    assert.equal(binding.stats().playlists, 2);
  }
  binding.release(media);
  assert.equal(binding.stats().media, 0);
  await binding.dispose();
});

function fakeRealm() {
  class Xhr {
    get response() {
      return this.value;
    }
    get responseText() {
      return this.value;
    }
  }
  class Stream {
    getReader() {
      return this.reader;
    }
  }
  class Reader {
    read() {
      return Promise.resolve(this.chunks.shift() || { done: true });
    }
    cancel() {
      this.cancelled = true;
      return Promise.resolve();
    }
    releaseLock() {
      this.released = true;
    }
  }
  class Response {
    get body() {
      return this.stream;
    }
  }
  class SourceBuffer {
    appendBuffer(value) {
      if (this.fail) throw new Error('Native append failed');
      this.last = value;
    }
  }
  class MediaSource extends EventTarget {
    addSourceBuffer() {
      return new SourceBuffer();
    }
  }
  class Media {
    constructor() {
      this.currentSrc = '';
    }
    load() {
      this.loads = (this.loads || 0) + 1;
    }
    get src() {
      return this.currentSrc;
    }
    set src(value) {
      this.currentSrc = value;
    }
  }
  const URL = {
    createObjectURL() {
      return 'blob:fake';
    },
  };
  return {
    XMLHttpRequest: Xhr,
    ReadableStream: Stream,
    ReadableStreamDefaultReader: Reader,
    Response,
    SourceBuffer,
    MediaSource,
    HTMLMediaElement: Media,
    URL,
  };
}

test('installed hooks preserve native results, reject failed appends, and restore only owned descriptors', async () => {
  const global = fakeRealm();
  const original = global.SourceBuffer.prototype.appendBuffer;
  const binding = createSourceBinding({ global, digest });
  assert.equal(binding.install(), true);
  assert.equal(binding.install(), false);
  const xhr = new global.XMLHttpRequest();
  Object.assign(xhr, {
    readyState: 4,
    status: 200,
    responseURL: ROOT + 'a.m3u8',
    value: playlist(['a.m4s']),
  });
  assert.equal(xhr.responseText, xhr.value);
  const nativeSource = new global.MediaSource();
  const url = global.URL.createObjectURL(nativeSource);
  const buffer = nativeSource.addSourceBuffer(MIME);
  const media = new global.HTMLMediaElement();
  media.src = url;
  const data = box('mdat', payload());
  const reader = new global.ReadableStreamDefaultReader();
  reader.chunks = [{ done: false, value: data }];
  const response = new global.Response();
  response.url = ROOT + 'a.m4s';
  response.stream = new global.ReadableStream();
  response.stream.reader = reader;
  const observed = response.body.getReader();
  assert.equal(observed, reader);
  assert.equal((await observed.read()).value, data);
  await observed.read();
  observed.releaseLock();
  assert.equal(reader.released, true);
  buffer.fail = true;
  assert.throws(() => buffer.appendBuffer(data), /Native append failed/);
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'unbound');
  buffer.fail = false;
  buffer.appendBuffer(data);
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'bound');
  media.load();
  assert.equal(media.loads, 1);
  assert.equal(binding.resolve(media).status, 'unbound');
  const thirdParty = function () {};
  global.ReadableStreamDefaultReader.prototype.read = thirdParty;
  await binding.dispose();
  assert.equal(global.SourceBuffer.prototype.appendBuffer, original);
  assert.equal(global.ReadableStreamDefaultReader.prototype.read, thirdParty);
});

test('partial hook installation rolls back cleanly when a required surface is missing', async () => {
  const global = fakeRealm();
  const original = Object.getOwnPropertyDescriptor(
    global.XMLHttpRequest.prototype,
    'responseText',
  );
  delete global.Response;
  const binding = createSourceBinding({ global, digest });
  assert.equal(binding.install(), false);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(
      global.XMLHttpRequest.prototype,
      'responseText',
    ),
    original,
  );
  await binding.dispose();
});

test('passive source and load hooks ignore unselected media while selected replacements still invalidate', async () => {
  const global = fakeRealm();
  const binding = createSourceBinding({ global, digest, limits: { media: 1 } });
  binding.install();
  const unselected = [];
  for (let index = 0; index < 30; index++) {
    const media = new global.HTMLMediaElement();
    media.src = `blob:preloaded-${index}`;
    media.load();
    unselected.push(media);
  }
  assert.equal(binding.stats().media, 0);
  const selected = new global.HTMLMediaElement();
  selected.src = 'blob:selected';
  const source = {};
  const buffer = {};
  binding.objectUrl(selected.currentSrc, source);
  binding.sourceBuffer(source, buffer, MIME);
  binding.resolve(selected);
  const data = box('mdat', payload());
  binding.playlist(ROOT + 'selected.m3u8', playlist(['selected.m4s']));
  stream(binding, 'selected.m4s', data);
  binding.append(buffer, data);
  await binding.settle();
  const previous = binding.resolve(selected);
  assert.equal(previous.status, 'bound');
  selected.src = 'blob:replacement';
  const replaced = binding.resolve(selected);
  assert.equal(replaced.status, 'unbound');
  assert.ok(replaced.generation > previous.generation);
  selected.load();
  assert.ok(binding.resolve(selected).generation > replaced.generation);
  assert.equal(binding.stats().media, 1);
  assert.equal(unselected.length, 30);
  binding.release(selected);
  binding.invalidate(unselected[0]);
  assert.equal(binding.stats().media, 1);
  assert.equal(binding.resolve(unselected[0]).generation, 1);
  await binding.dispose();
});

test('URL metadata and digest bookkeeping have independent enforced limits', async () => {
  const { binding, buffer, media } = fixture({
    limits: { playlistUrlCharacters: 200, digestBytes: 32 },
  });
  assert.equal(binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s'])), true);
  assert.equal(binding.playlist(ROOT + 'b.m3u8', playlist(['b.m4s'])), false);
  assert.ok(binding.stats().playlistUrlCharacters <= 200);
  binding.append(buffer, box('mdat', payload()));
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'unbound');
  assert.ok(binding.stats().peakDigestBytes <= 32);
  await binding.dispose();
  assert.equal(binding.stats().digestBytes, 0);
});

test('an established append proof survives unrelated resource eviction but still detects later ambiguity', async () => {
  const { binding, buffer, media } = fixture({ limits: { resources: 1 } });
  const active = box('mdat', payload());
  binding.playlist(ROOT + 'active.m3u8', playlist(['active.m4s']));
  binding.playlist(ROOT + 'future.m3u8', playlist(['future.m4s', 'same.m4s']));
  stream(binding, 'active.m4s', active);
  binding.append(buffer, active);
  await binding.settle();
  assert.equal(binding.resolve(media).playlistUrl, ROOT + 'active.m3u8');
  stream(binding, 'future.m4s', box('mdat', payload(37000, 13)));
  await binding.settle();
  assert.equal(binding.stats().resources, 1);
  assert.equal(binding.resolve(media).playlistUrl, ROOT + 'active.m3u8');
  stream(binding, 'same.m4s', active);
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'ambiguous');
  await binding.dispose();
});

test('collected media are pruned before observation limits and statistics without evicting live observations', async () => {
  const weak = weakReferences();
  const binding = createSourceBinding({
    global: weak.global,
    digest,
    limits: { media: 2 },
  });
  const active = { currentSrc: 'blob:active' };
  binding.resolve(active);
  for (let index = 0; index < 40; index++) {
    const previous = { currentSrc: `blob:previous-${index}` };
    assert.equal(binding.resolve(previous).status, 'unbound');
    assert.equal(
      binding.resolve({ currentSrc: 'blob:overflow' }).reason,
      'media-limit',
    );
    weak.collect(previous);
    const next = { currentSrc: `blob:next-${index}` };
    assert.equal(binding.resolve(next).status, 'unbound');
    assert.equal(binding.stats().media, 2);
    weak.collect(next);
    assert.equal(binding.stats().media, 1);
    assert.equal(binding.resolve(active).generation, 0);
  }
  binding.release(active);
  assert.equal(binding.stats().media, 0);
  await binding.dispose();
});

test('collected media cannot receive notifications or protect an inactive playlist from eviction', async () => {
  const weak = weakReferences();
  const changes = [];
  const { binding, buffer, media } = fixture({
    global: weak.global,
    limits: { playlists: 1 },
    onChange: (target, result) => changes.push({ target, result }),
  });
  const data = box('mdat', payload());
  binding.playlist(ROOT + 'active.m3u8', playlist(['active.m4s']));
  stream(binding, 'active.m4s', data);
  binding.append(buffer, data);
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'bound');
  assert.equal(
    binding.playlist(ROOT + 'future.m3u8', playlist(['future.m4s'])),
    false,
  );
  changes.length = 0;
  weak.collect(media);
  assert.equal(
    binding.playlist(ROOT + 'future.m3u8', playlist(['future.m4s'])),
    true,
  );
  assert.equal(changes.length, 0);
  assert.equal(binding.stats().media, 0);
  await binding.dispose();
});

test('explicit release removes the weak index immediately and invalidation survives unrelated media collection', async () => {
  const weak = weakReferences();
  const { binding, buffer, media } = fixture({
    global: weak.global,
    limits: { media: 2 },
  });
  const discarded = { currentSrc: 'blob:discarded' };
  binding.resolve(discarded);
  binding.release(discarded);
  assert.equal(binding.stats().media, 1);
  binding.resolve(discarded);
  weak.collect(discarded);
  const data = box('mdat', payload());
  binding.playlist(ROOT + 'active.m3u8', playlist(['active.m4s']));
  stream(binding, 'active.m4s', data);
  binding.append(buffer, data);
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'bound');
  binding.invalidate(media);
  const generation = binding.resolve(media).generation;
  binding.append(buffer, data);
  await binding.settle();
  assert.equal(binding.resolve(media).status, 'unbound');
  assert.equal(binding.resolve(media).generation, generation);
  assert.equal(binding.stats().media, 1);
  await binding.dispose();
  assert.equal(binding.stats().media, 0);
});

test('a notification callback releasing another observation cannot re-register it from the iteration snapshot', async () => {
  const first = { currentSrc: 'blob:first' };
  const second = { currentSrc: 'blob:second' };
  const changes = [];
  const binding = createSourceBinding({
    digest,
    onChange: (target) => {
      changes.push(target);
      if (target === first) binding.release(second);
    },
  });
  binding.resolve(first);
  binding.resolve(second);
  binding.playlist(ROOT + 'a.m3u8', playlist(['a.m4s']));
  assert.deepEqual(changes, [first]);
  assert.equal(binding.stats().media, 1);
  await binding.dispose();
});
