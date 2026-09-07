import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createPcmSource } from '../src/audio/bounded-source.mjs';

const MEDIA_URL =
  'https://playback.media-streaming.soundcloud.cloud/track/playlist.m3u8';
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('source limits accept only declared own keys', () => {
  for (const limits of [
    { constructor: 1 },
    { toString: 1 },
    JSON.parse('{"__proto__":1}'),
  ])
    assert.throws(() => fixture({ limits }), /Unknown source limit/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const state = {
    requests: [],
    sources: [],
    inputs: [],
    decoders: [],
    samples: [],
    readers: [],
    decoded: [],
    lookups: [],
  };
  const config = options.config || {
    codec: 'mp4a.40.2',
    sampleRate: 48000,
    numberOfChannels: 2,
  };
  const descriptors =
    options.packets ||
    [0, 0.1, 0.2, 0.3].map((timestamp) => ({ timestamp, duration: 0.1 }));
  const packets = descriptors.map((descriptor, index) => ({
    index,
    timestamp: descriptor.timestamp,
    duration: descriptor.duration,
    type: 'key',
    toEncodedAudioChunk() {
      return { ...descriptor, index };
    },
  }));

  class BufferSource {
    constructor(bytes) {
      this.bytes = bytes;
      state.sources.push(this);
    }
  }

  class CustomPathedSource {
    constructor(rootPath, requestHandler) {
      this.rootPath = rootPath;
      this.requestHandler = requestHandler;
    }
  }

  class Input {
    constructor({ source }) {
      this.source = source;
      this.disposals = 0;
      state.inputs.push(this);
    }
    async getPrimaryAudioTrack() {
      const root = await this.source.requestHandler({
        path: this.source.rootPath,
        isRoot: true,
      });
      options.parse?.(root.bytes);
      for (const path of options.paths || [])
        await this.source.requestHandler({ path, isRoot: false });
      if (options.noTrack) return null;
      return {
        getDecoderConfig: async () => config,
        getDurationFromMetadata: async () => options.duration ?? 1,
        getTimeResolution: async () => options.timeResolution ?? 48000,
      };
    }
    dispose() {
      this.disposals++;
    }
  }

  class EncodedPacketSink {
    async getKeyPacket(start) {
      if (options.packetGate) await options.packetGate.promise;
      return packets.findLast((packet) => packet.timestamp <= start) || null;
    }
    async getFirstKeyPacket() {
      return packets[0] || null;
    }
    async getPacket(timestamp) {
      state.lookups.push(timestamp);
      if (options.prerollPacket) return options.prerollPacket;
      return (
        packets.findLast((packet) => packet.timestamp <= timestamp) || null
      );
    }
    async getNextPacket(packet) {
      return packets[packet.index + 1] || null;
    }
  }

  class AudioData {
    constructor(packet, overrides = {}) {
      this.timestamp = Math.round(packet.timestamp * 1000000);
      this.sampleRate = options.outputSampleRate || 48000;
      this.numberOfChannels = 2;
      this.numberOfFrames = Math.round(packet.duration * this.sampleRate);
      this.closes = 0;
      Object.assign(this, overrides);
      state.samples.push(this);
    }
    copyTo(plane, settings) {
      assert.equal(settings.format, 'f32-planar');
      plane.fill(options.nonFinite ? NaN : settings.planeIndex ? -0.25 : 0.25);
      if (options.copyError) throw new Error('Copy failed');
    }
    close() {
      this.closes++;
    }
  }

  class AudioDecoder extends EventTarget {
    static async isConfigSupported() {
      return { supported: options.supported !== false };
    }
    constructor(callbacks) {
      super();
      this.callbacks = callbacks;
      this.decodeQueueSize = 0;
      this.pending = new Set();
      this.closed = false;
      this.closes = 0;
      state.decoders.push(this);
    }
    configure(value) {
      this.config = value;
    }
    decode(packet) {
      state.decoded.push(packet.timestamp);
      this.decodeQueueSize++;
      const pending = deferred();
      this.pending.add(pending.promise);
      const emit = () => {
        this.decodeQueueSize--;
        if (!this.closed || options.lateOutput) {
          for (
            let index = 0;
            index < (options.outputsPerPacket || 1);
            index++
          ) {
            const overrides =
              typeof options.outputOverrides === 'function'
                ? options.outputOverrides(packet, index)
                : options.outputOverrides;
            this.callbacks.output(new AudioData(packet, overrides));
          }
        }
        this.dispatchEvent(new Event('dequeue'));
        this.pending.delete(pending.promise);
        pending.resolve();
      };
      if (options.manualDecode) state.emit = emit;
      else setImmediate(emit);
    }
    async flush() {
      await Promise.all(this.pending);
    }
    close() {
      this.closed = true;
      this.closes++;
    }
  }

  function response(url, resource = {}) {
    const chunks = (
      resource.chunks || [new Uint8Array(16), new Uint8Array(16)]
    ).slice();
    const reader = {
      cancels: 0,
      releases: 0,
      async read() {
        if (resource.readGate) return resource.readGate.promise;
        if (resource.readError) throw new Error('Read failed');
        return chunks.length
          ? { done: false, value: chunks.shift() }
          : { done: true };
      },
      cancel() {
        this.cancels++;
        return Promise.resolve();
      },
      releaseLock() {
        this.releases++;
      },
    };
    state.readers.push(reader);
    const headers = new Headers();
    if (resource.length !== undefined)
      headers.set('content-length', resource.length);
    if (resource.contentEncoding)
      headers.set('content-encoding', resource.contentEncoding);
    const result = {
      status: resource.status || 200,
      url: resource.url || url,
      redirected: resource.redirected || false,
      headers,
      body: { getReader: () => reader, cancel: () => reader.cancel() },
    };
    return result;
  }

  async function fetch(url, init) {
    state.requests.push({ url, init });
    if (options.fetchGate) return options.fetchGate.promise;
    if (options.fetchError) throw new Error('Fetch failed');
    const resource =
      typeof options.resource === 'function'
        ? options.resource(url)
        : options.resource;
    return response(url, resource);
  }

  const source = createPcmSource({
    library: {
      BufferSource,
      CustomPathedSource,
      Input,
      EncodedPacketSink,
      HLS_FORMATS: ['hls', 'mp4'],
    },
    url: options.url || MEDIA_URL,
    fetch: options.useDefaultFetch ? undefined : fetch,
    AudioDecoder,
    limits: {
      operationTimeoutMs: 500,
      networkTimeoutMs: 500,
      ...options.limits,
    },
  });
  return { source, state, response, AudioData };
}

async function collect(source, start = 0, end = 0.25) {
  const result = [];
  for await (const packet of source.read(start, end)) {
    result.push({
      timestamp: packet.timestamp,
      sampleRate: packet.sampleRate,
      channels: packet.channels.map((plane) => [...plane]),
    });
    packet.release();
  }
  return result;
}

function assertClean(source, state) {
  const stats = source.stats();
  assert.equal(stats.activeTransactions, 0);
  assert.equal(stats.heldEncodedBytes, stats.retainedManifestBytes);
  assert.equal(stats.heldPcmBytes, 0);
  assert.equal(stats.queuedSamples, 0);
  assert.equal(stats.decodeQueueSize, 0);
  assert.equal(stats.openedDecoders, stats.closedDecoders);
  assert.ok(state.inputs.every((input) => input.disposals === 1));
  assert.ok(state.samples.every((sample) => sample.closes === 1));
  assert.ok(state.decoders.every((decoder) => decoder.closes === 1));
}

test('retains actual PCM format and source timestamps with deterministic disposal', async () => {
  const { source, state } = fixture({ outputSampleRate: 44100 });
  const packets = await collect(source);
  assert.deepEqual(
    packets.map((packet) => packet.timestamp),
    [0, 0.1, 0.2],
  );
  assert.ok(packets.every((packet) => packet.sampleRate === 44100));
  assert.equal(packets[0].channels[0].length, 4410);
  assert.ok(packets[0].channels[0].every((sample) => sample === 0.25));
  assert.ok(packets[0].channels[1].every((sample) => sample === -0.25));
  assert.ok(source.stats().peakDecodeQueueSize <= 2);
  assertClean(source, state);
});

test('metadata is labelled declared, cached without resource ownership', async () => {
  const { source, state } = fixture();
  assert.deepEqual(await source.info(), {
    codec: 'mp4a.40.2',
    declaredSampleRate: 48000,
    declaredChannels: 2,
    duration: 1,
  });
  assert.equal((await source.info()).declaredSampleRate, 48000);
  assert.equal(state.requests.length, 1);
  assertClean(source, state);
  source.dispose();
  await assert.rejects(source.info(), { name: 'AbortError' });
});

test('default fetch retains its global receiver through page wrappers', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', function (url, init) {
    assert.equal(this, globalThis);
    assert.equal(url, MEDIA_URL);
    assert.equal(init.credentials, 'omit');
    calls++;
    return Promise.resolve(new Response(new Uint8Array(32)));
  });
  const { source, state } = fixture({ useDefaultFetch: true });
  await collect(source);
  assert.equal(calls, 1);
  assertClean(source, state);
  source.dispose();
});

test('accepts only credential-free HTTPS media hosts', async () => {
  for (const url of [
    'http://cf-media.sndcdn.com/a',
    'https://sndcdn.com/a',
    'https://sndcdn.com.evil.test/a',
    'https://evil.test/a',
    'https://user:pass@cf-media.sndcdn.com/a',
    'https://cf-media.sndcdn.com:8443/a',
    'https://cf-media.sndcdn.com/a#b',
  ])
    assert.throws(() => fixture({ url }), { name: 'SecurityError' });
  const { source, state } = fixture({
    url: 'https://cf-media.sndcdn.com/audio?token=public',
  });
  await source.info();
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(state.requests[0].init).filter(
        ([key]) => key !== 'signal',
      ),
    ),
    {
      credentials: 'omit',
      redirect: 'error',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    },
  );
});

test('validates each child path and rejects redirects', async () => {
  for (const options of [
    { paths: ['https://example.com/audio.m4s'] },
    { resource: { redirected: true } },
    { resource: { url: 'https://cf-media.sndcdn.com/other' } },
  ]) {
    const { source, state } = fixture(options);
    await assert.rejects(source.info(), { name: 'SecurityError' });
    assertClean(source, state);
  }
});

test('shares repeated resources only within one transaction', async () => {
  const { source, state } = fixture({ paths: ['part.m4s', 'part.m4s'] });
  await source.info();
  assert.equal(state.requests.length, 2);
  assert.notEqual(state.sources[1], state.sources[2]);
  assert.equal(state.sources[1].bytes, state.sources[2].bytes);
  await collect(source);
  assert.equal(state.requests.length, 4);
  assertClean(source, state);
});

const VOD_MANIFEST =
  '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\npart.m4s\n#EXT-X-ENDLIST\n';

test('reuses a completed root playlist after its network URL stops responding', async () => {
  const bytes = new TextEncoder().encode(VOD_MANIFEST);
  let requests = 0;
  const { source, state } = fixture({
    resource: () => (++requests === 1 ? { chunks: [bytes] } : { status: 403 }),
    parse: (value) =>
      assert.equal(new TextDecoder().decode(value), VOD_MANIFEST),
  });
  await source.info();
  state.sources[0].bytes.fill(0);
  await collect(source);
  await collect(source);
  assert.equal(requests, 1);
  assert.equal(source.stats().retainedManifestBytes, bytes.byteLength);
  assertClean(source, state);
  source.dispose();
  assert.equal(source.stats().heldEncodedBytes, 0);
  assert.equal(source.stats().retainedManifestBytes, 0);
});

test('live and oversized root playlists are not retained', async () => {
  for (const text of [
    VOD_MANIFEST.replace('#EXT-X-ENDLIST\n', ''),
    VOD_MANIFEST + '#'.repeat(262144),
  ]) {
    const { source, state } = fixture({
      resource: { chunks: [new TextEncoder().encode(text)] },
    });
    await source.info();
    await collect(source);
    assert.equal(state.requests.length, 2);
    assert.equal(source.stats().retainedManifestBytes, 0);
    assertClean(source, state);
  }
});

test('failed playlist responses are never retained', async () => {
  const { source, state } = fixture({
    resource: { status: 403, chunks: [new TextEncoder().encode(VOD_MANIFEST)] },
  });
  await assert.rejects(source.info(), /Media resource could not be read/);
  await assert.rejects(source.info(), /Media resource could not be read/);
  assert.equal(state.requests.length, 2);
  assert.equal(source.stats().retainedManifestBytes, 0);
  assertClean(source, state);
});

test('a rejected segment is fetched again on retry while the completed playlist stays reusable', async () => {
  const manifest = new TextEncoder().encode(VOD_MANIFEST);
  let segmentRequests = 0;
  const { source, state } = fixture({
    paths: ['part.m4s'],
    resource: (url) =>
      url === MEDIA_URL
        ? { chunks: [manifest] }
        : { status: ++segmentRequests === 2 ? 403 : 200 },
  });
  await source.info();
  await assert.rejects(collect(source), /Media resource could not be read/);
  assertClean(source, state);
  const packets = await collect(source);
  assert.equal(packets.length, 3);
  assert.equal(segmentRequests, 3);
  assert.equal(
    state.requests.filter((request) => request.url === MEDIA_URL).length,
    1,
  );
  assertClean(source, state);
  source.dispose();
  assert.equal(source.stats().heldEncodedBytes, 0);
});

test('retained playlist bytes share the encoded-memory budget', async () => {
  const bytes = new TextEncoder().encode(VOD_MANIFEST);
  const { source, state } = fixture({
    resource: { chunks: [bytes] },
    limits: { encodedBytes: bytes.byteLength * 2 },
  });
  await source.info();
  await collect(source);
  assert.ok(source.stats().peakHeldEncodedBytes <= bytes.byteLength * 2);
  assertClean(source, state);
  source.dispose();
  assert.equal(source.stats().heldEncodedBytes, 0);
});

test('bounds resource sizes, aggregate chunks, and contiguous assembly overlap', async () => {
  const cases = [
    { resource: { length: '1000' }, limits: { resourceBytes: 32 } },
    { limits: { resourceBytes: 31 } },
    { limits: { encodedBytes: 31 } },
    { limits: { encodedBytes: 48 } },
    { paths: ['part.m4s'], limits: { encodedBytes: 80 } },
    {
      resource: { chunks: [new Uint8Array(new ArrayBuffer(128), 0, 16)] },
      limits: { encodedBytes: 64 },
    },
    { paths: ['part.m4s'], limits: { resourceCount: 1 } },
  ];
  for (const options of cases) {
    const { source, state } = fixture(options);
    await assert.rejects(source.info(), { name: 'QuotaExceededError' });
    assert.ok(
      source.stats().peakHeldEncodedBytes <=
        (options.limits.encodedBytes || 16777216),
    );
    assertClean(source, state);
  }
  const { source, state } = fixture({ limits: { encodedBytes: 64 } });
  await source.info();
  assert.equal(source.stats().peakHeldEncodedBytes, 64);
  assertClean(source, state);
});

test('rejects malformed headers, empty bodies and failed reads, cleaning readers', async () => {
  for (const resource of [
    { length: 'NaN' },
    { length: '-1' },
    { length: '1.5' },
    { length: '9007199254740992' },
    { chunks: [] },
    { readError: true },
    { status: 403 },
  ]) {
    const { source, state } = fixture({ resource });
    await assert.rejects(source.info());
    assert.ok(state.readers.every((reader) => reader.cancels >= 1));
    assertClean(source, state);
  }
});

test('accepts browser-decoded gzip playlists with exposed or hidden content encoding', async () => {
  const playlist =
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\npart-1.m4s\n#EXTINF:10,\npart-2.m4s\n#EXTINF:10,\npart-3.m4s\n#EXT-X-ENDLIST\n';
  const decoded = new TextEncoder().encode(playlist);
  const wireBytes = gzipSync(decoded).byteLength;
  assert.notEqual(wireBytes, decoded.byteLength);
  for (const contentEncoding of ['gzip', undefined]) {
    const { source, state } = fixture({
      resource: {
        length: String(wireBytes),
        contentEncoding,
        chunks: [decoded.slice(0, 40), decoded.slice(40)],
      },
      parse: (bytes) => assert.equal(new TextDecoder().decode(bytes), playlist),
    });
    await source.info();
    assert.equal(state.sources[0].bytes.byteLength, decoded.byteLength);
    assert.equal(source.stats().deliveredBytes, decoded.byteLength);
    assertClean(source, state);
    source.dispose();
    assert.equal(source.stats().heldEncodedBytes, 0);
  }
});

test('never uses wire Content-Length as the decoded-body size, in either direction', async () => {
  for (const length of ['0', '1', '31', '33', '1000']) {
    const { source, state } = fixture({ resource: { length } });
    await source.info();
    assert.equal(source.stats().deliveredBytes, 32);
    assertClean(source, state);
  }
});

test('compressed responses retain decoded-resource and aggregate ownership caps', async () => {
  for (const limits of [{ resourceBytes: 31 }, { encodedBytes: 48 }]) {
    const { source, state } = fixture({
      resource: { length: '8', contentEncoding: 'gzip' },
      limits,
    });
    await assert.rejects(source.info(), { name: 'QuotaExceededError' });
    assert.ok(
      source.stats().peakHeldEncodedBytes <= (limits.encodedBytes || 16777216),
    );
    assertClean(source, state);
  }
});

test('media parser failures still reject fully-read bodies after removing wire-length equality', async () => {
  const { source, state } = fixture({
    resource: { length: '1000' },
    parse: () => {
      throw new Error('Invalid or incomplete media');
    },
  });
  await assert.rejects(source.info(), /Invalid or incomplete media/);
  assertClean(source, state);
});

test('requires explicit release before advancing, including final sample', async () => {
  const { source, state } = fixture();
  const iterator = source.read(0, 0.01);
  const { value } = await iterator.next();
  assert.ok(value.channels.length);
  await assert.rejects(iterator.next(), { name: 'InvalidStateError' });
  assert.equal(value.released, true);
  assert.equal(value.channels.length, 0);
  value.release();
  assertClean(source, state);
});

test('early iterator return closes outstanding decoded and held resources', async () => {
  const { source, state } = fixture();
  const iterator = source.read(0, 0.3);
  const { value } = await iterator.next();
  await iterator.return();
  assert.equal(value.released, true);
  assertClean(source, state);
});

test('dispose invalidates a yielded packet and rejects subsequent operations', async () => {
  const { source, state } = fixture();
  const iterator = source.read(0, 0.3);
  const { value } = await iterator.next();
  source.dispose();
  source.dispose();
  assert.equal(value.released, true);
  await assert.rejects(iterator.next(), { name: 'AbortError' });
  await assert.rejects(source.read(0, 0.2).next(), { name: 'AbortError' });
  assertClean(source, state);
});

test('pre-aborted and concurrent operations cannot retain an active transaction', async () => {
  const controller = new AbortController();
  controller.abort();
  const { source, state } = fixture();
  await assert.rejects(
    source.read(0, 0.2, { signal: controller.signal }).next(),
    { name: 'AbortError' },
  );
  assertClean(source, state);
  const iterator = source.read(0, 0.2);
  const { value } = await iterator.next();
  await assert.rejects(source.read(0, 0.2).next(), {
    name: 'InvalidStateError',
  });
  value.release();
  await iterator.return();
  assertClean(source, state);
});

test('late fetch response after cancellation is cancelled without becoming owned', async () => {
  const fetchGate = deferred();
  const { source, state, response } = fixture({ fetchGate });
  const pending = source.info();
  await tick();
  source.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  fetchGate.resolve(response(MEDIA_URL));
  await tick();
  assert.equal(state.readers[0].cancels, 1);
  assertClean(source, state);
});

test('abort cancels a pending body read without retaining its later chunk', async () => {
  const readGate = deferred();
  const controller = new AbortController();
  const { source, state } = fixture({ resource: { readGate } });
  const pending = source.info({ signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  readGate.resolve({ done: false, value: new Uint8Array(16) });
  await tick();
  assert.ok(state.readers[0].cancels >= 1);
  assertClean(source, state);
});

test('network and decoder operations have finite deadlines', async () => {
  for (const options of [
    { fetchGate: deferred(), limits: { networkTimeoutMs: 15 } },
    { resource: { readGate: deferred() }, limits: { networkTimeoutMs: 15 } },
    { manualDecode: true, limits: { operationTimeoutMs: 15 } },
  ]) {
    const { source, state } = fixture(options);
    await assert.rejects(collect(source), { name: 'TimeoutError' });
    assertClean(source, state);
  }
});

test('stale decoder output is closed and cannot reach the next read', async () => {
  const { source, state } = fixture({
    manualDecode: true,
    lateOutput: true,
    packets: [{ timestamp: 0, duration: 0.1 }],
  });
  const controller = new AbortController();
  const pending = source.read(0, 0.2, { signal: controller.signal }).next();
  await tick();
  const emit = state.emit;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const next = source.read(0, 0.2);
  const first = next.next();
  await tick();
  emit();
  assert.equal(source.stats().staleSamples, 1);
  state.emit();
  const { value } = await first;
  value.release();
  await next.return();
  assertClean(source, state);
});

test('validates decoded metadata and finite PCM before yielding', async () => {
  for (const options of [
    { outputOverrides: { timestamp: NaN } },
    { outputOverrides: { numberOfFrames: 0 } },
    { outputOverrides: { numberOfFrames: 32769 } },
    { outputOverrides: { sampleRate: 0 } },
    { outputOverrides: { numberOfChannels: 3 } },
    { nonFinite: true },
    { copyError: true },
    { supported: false },
    { noTrack: true },
    { config: { codec: '', sampleRate: 48000, numberOfChannels: 2 } },
  ]) {
    const { source, state } = fixture(options);
    await assert.rejects(collect(source));
    assertClean(source, state);
  }
});

test('decoded PCM and output queue caps reject excess and close every sample', async () => {
  const cases = [
    { limits: { pcmBytes: 63 } },
    {
      outputsPerPacket: 3,
      outputOverrides: (_, index) => ({
        timestamp: index * 1000,
        numberOfFrames: 48,
      }),
      limits: { outputSamples: 2 },
    },
  ];
  for (const options of cases) {
    const { source, state } = fixture(options);
    await assert.rejects(collect(source), { name: 'QuotaExceededError' });
    assertClean(source, state);
  }
});

test('rejects duplicate timestamps, backwards timestamps, and mid-read format changes', async () => {
  for (const outputOverrides of [
    () => ({ timestamp: 0 }),
    (packet) => ({ timestamp: packet.index ? -1 : 0 }),
    (packet) => ({ sampleRate: packet.index ? 44100 : 48000 }),
  ]) {
    const { source, state } = fixture({ outputOverrides });
    await assert.rejects(collect(source));
    assertClean(source, state);
  }
});

test('uses key-packet preroll and retains boundary-overlapping samples', async () => {
  const packets = [
    { timestamp: 0, duration: 0.1 },
    { timestamp: 0.1, duration: 0.1 },
    { timestamp: 0.2, duration: 0.1 },
  ];
  const { source, state } = fixture({
    packets,
    outputOverrides: { numberOfFrames: 4800 },
  });
  const result = await collect(source, 0.15, 0.21);
  assert.deepEqual(state.decoded, [0, 0.1, 0.2]);
  assert.deepEqual(
    result.map((packet) => packet.timestamp),
    [0.1, 0.2],
  );
  assertClean(source, state);
});

test('rejects invalid ranges and bounded packet-count exhaustion', async () => {
  const { source, state } = fixture({ limits: { packetsPerRead: 1 } });
  for (const [start, end] of [
    [-1, 1],
    [0, Infinity],
    [1, 1],
    [NaN, 1],
  ])
    await assert.rejects(source.read(start, end).next(), TypeError);
  await assert.rejects(collect(source), { name: 'QuotaExceededError' });
  assertClean(source, state);
});

test('AAC-LC seeks decode four earlier packets without exposing preroll samples', async () => {
  const packets = Array.from({ length: 12 }, (_, index) => ({
    timestamp: index * 0.1,
    duration: 0.1,
  }));
  const { source, state } = fixture({ packets });
  const result = await collect(source, 0.75, 0.86);
  assert.equal(state.lookups.length, 4);
  assert.deepEqual(
    state.decoded,
    [
      0.30000000000000004, 0.4, 0.5, 0.6000000000000001, 0.7000000000000001,
      0.8,
    ],
  );
  assert.deepEqual(
    result.map((packet) => packet.timestamp),
    [0.7, 0.8],
  );
  assertClean(source, state);
});

test('the beginning of the source needs no fabricated negative preroll', async () => {
  const { source, state } = fixture();
  const result = await collect(source, 0, 0.1);
  assert.equal(state.lookups.length, 1);
  assert.deepEqual(state.decoded, [0]);
  assert.equal(result[0].timestamp, 0);
  assertClean(source, state);
});

test('unsupported codec families are rejected before configuring a decoder', async () => {
  for (const codec of ['mp3', 'mp4a.40.5', 'mp4a.40.29', 'mp4a.67', 'opus']) {
    const { source, state } = fixture({
      config: { codec, sampleRate: 48000, numberOfChannels: 2 },
    });
    await assert.rejects(collect(source), { name: 'NotSupportedError' });
    assert.equal(state.decoders.length, 0);
    assertClean(source, state);
  }
  const { source, state } = fixture({
    config: { codec: 'mp4a.40.02', sampleRate: 48000, numberOfChannels: 2 },
  });
  await collect(source);
  assertClean(source, state);
});

test('preroll cannot walk backwards forever or exceed one second', async () => {
  for (const prerollPacket of [
    { timestamp: -2, duration: 0.1 },
    { timestamp: 0.1, duration: 0.1 },
    { timestamp: NaN, duration: 0.1 },
  ]) {
    const { source, state } = fixture({ prerollPacket });
    await assert.rejects(collect(source, 0.15, 0.2), { name: 'DataError' });
    assertClean(source, state);
  }
});

test('missing start, internal gaps, overlaps, empty reads, and short tails reject', async () => {
  const cases = [
    { packets: [{ timestamp: 0.1, duration: 0.1 }], interval: [0, 0.15] },
    {
      packets: [
        { timestamp: 0, duration: 0.1 },
        { timestamp: 0.12, duration: 0.1 },
      ],
      interval: [0, 0.2],
    },
    {
      packets: [
        { timestamp: 0, duration: 0.1 },
        { timestamp: 0.09, duration: 0.1 },
      ],
      interval: [0, 0.18],
    },
    { packets: [], interval: [0, 0.1] },
    { packets: [{ timestamp: 0, duration: 0.1 }], interval: [0, 0.2] },
    { packets: [{ timestamp: 0, duration: 0.1 }], interval: [1, 1.1] },
  ];
  for (const { interval, ...options } of cases) {
    const { source, state } = fixture(options);
    await assert.rejects(collect(source, ...interval), { name: 'DataError' });
    assertClean(source, state);
  }
});

test('coverage tolerates timestamp rounding up to one sample, never a larger gap', async () => {
  for (const offset of [0.000001, 0.00002]) {
    const { source, state } = fixture({
      outputOverrides: (packet) => ({
        timestamp: Math.round(
          (packet.timestamp + (packet.index ? offset : 0)) * 1000000,
        ),
      }),
    });
    await collect(source, 0, 0.25);
    assertClean(source, state);
  }
  const { source, state } = fixture({
    outputOverrides: (packet) => ({
      timestamp: Math.round(
        (packet.timestamp + (packet.index ? 0.000022 : 0)) * 1000000,
      ),
    }),
  });
  await assert.rejects(collect(source), { name: 'DataError' });
  assertClean(source, state);
});

test('optional EOF reports only the decoded tail after encoded exhaustion', async () => {
  const { source, state } = fixture({
    packets: [{ timestamp: 0, duration: 0.1 }],
    duration: 99,
  });
  const iterator = source.read(0, 0.2, { allowEndOfStream: true });
  const first = await iterator.next();
  first.value.release();
  assert.deepEqual(await iterator.next(), {
    done: true,
    value: { endOfStream: true, sampleRate: 48000, endTimestamp: 0.1 },
  });
  assertClean(source, state);
  await assert.rejects(collect(source, 0, 0.2), { name: 'DataError' });
});

test('range completion cannot claim EOF while encoded packets remain', async () => {
  const { source, state } = fixture();
  const iterator = source.read(0, 0.05, { allowEndOfStream: true });
  const first = await iterator.next();
  first.value.release();
  assert.deepEqual(await iterator.next(), {
    done: true,
    value: { endOfStream: false, sampleRate: 48000 },
  });
  assertClean(source, state);
});

test('optional EOF never suppresses missing-start or empty-decoder errors', async () => {
  for (const packets of [[], [{ timestamp: 0.1, duration: 0.1 }]]) {
    const { source, state } = fixture({ packets });
    const iterator = source.read(0, 0.3, { allowEndOfStream: true });
    await assert.rejects(iterator.next(), { name: 'DataError' });
    assertClean(source, state);
  }
  const { source, state } = fixture({
    packets: [{ timestamp: 0, duration: 0.1 }],
  });
  assert.deepEqual(
    await source.read(1, 1.1, { allowEndOfStream: true }).next(),
    {
      done: true,
      value: { endOfStream: true, sampleRate: 48000, endTimestamp: 0.1 },
    },
  );
  assertClean(source, state);
});
