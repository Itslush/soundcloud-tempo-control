import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcmWindow } from '../src/audio/pcm-window.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

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
  const sampleRate = options.sampleRate || 8000;
  const frames = options.frames ?? 48000;
  const packetFrames = options.packetFrames || 80;
  const timestampOffset = options.timestampOffset || 0;
  const state = {
    reads: [],
    packets: [],
    returns: 0,
    disposals: 0,
    infoCalls: 0,
  };
  const sampleAt = (frame, channel) =>
    ((frame % 997) / 1000) * (channel ? -1 : 1);
  const source = {
    async info({ signal } = {}) {
      state.infoCalls++;
      if (signal?.aborted) throw signal.reason;
      return {
        duration: options.durationHint ?? frames / sampleRate,
        declaredSampleRate: 96000,
      };
    },
    async *read(start, end, { signal, allowEndOfStream } = {}) {
      assert.equal(allowEndOfStream, true);
      const call = { start, end, signal };
      state.reads.push(call);
      let frame = Math.max(
        0,
        Math.floor(((start - timestampOffset) * sampleRate) / packetFrames) *
          packetFrames,
      );
      let lastEnd = frame;
      try {
        while (frame < Math.min((end - timestampOffset) * sampleRate, frames)) {
          if (
            options.gate &&
            state.reads.length > (options.gateAfterReads ?? 0)
          )
            await options.gate.promise;
          if (signal?.aborted && !options.ignoreAbort) throw signal.reason;
          const length = Math.min(packetFrames, frames - frame);
          const timestamp =
            typeof options.timestamp === 'function'
              ? options.timestamp(frame, call)
              : frame / sampleRate + timestampOffset;
          const packet = {
            timestamp,
            sampleRate:
              typeof options.packetRate === 'function'
                ? options.packetRate(frame, call)
                : sampleRate,
            channels: Array.from(
              { length: options.channels || 2 },
              (_, channel) =>
                Float32Array.from({ length }, (_, index) =>
                  options.nonFinite ? NaN : sampleAt(frame + index, channel),
                ),
            ),
            releases: 0,
            release() {
              this.releases++;
              this.channels.length = 0;
            },
          };
          state.packets.push(packet);
          yield packet;
          if (packet.releases !== 1)
            throw new Error('Packet was not released exactly once');
          lastEnd = frame + length;
          frame += packetFrames;
          if (options.failAfterFirst) throw new Error('Decoder failed');
        }
        return (
          options.eofMetadata ||
          (lastEnd >= frames || (start - timestampOffset) * sampleRate >= frames
            ? {
                endOfStream: true,
                sampleRate,
                endTimestamp: frames / sampleRate + timestampOffset,
              }
            : { endOfStream: false, sampleRate })
        );
      } finally {
        state.returns++;
      }
    },
    async dispose() {
      state.disposals++;
      await options.disposeGate?.promise;
    },
  };
  const window = createPcmWindow({
    source,
    maxBytes: options.maxBytes,
    readAheadSeconds: options.readAheadSeconds ?? 0.1,
  });
  return { window, source, state, sampleAt, sampleRate };
}

function releasedPackets(state) {
  assert.ok(state.packets.every((packet) => packet.releases === 1));
}

function checkLease(lease, sampleAt, start, end) {
  assert.equal(lease.pcmStartFrame, start);
  assert.equal(lease.channels.length, 2);
  assert.equal(lease.channels[0].length, end - start);
  for (let channel = 0; channel < 2; channel++) {
    const expected = Float32Array.from({ length: end - start }, (_, index) =>
      sampleAt(start + index, channel),
    );
    assert.deepEqual(lease.channels[channel], expected);
  }
}

test('info primes actual decoded format and treats metadata duration only as a hint', async () => {
  const { window, state } = fixture({ durationHint: 0.001 });
  assert.deepEqual(await window.info(), {
    sampleRate: 8000,
    channels: 2,
    durationHint: 0.001,
  });
  assert.equal((await window.info()).sampleRate, 8000);
  assert.equal(state.infoCalls, 1);
  assert.equal(state.reads.length, 1);
  assert.equal(state.reads[0].end, 0.1);
  releasedPackets(state);
  await window.dispose();
  assert.equal(state.disposals, 1);
  assert.equal(window.stats().ownedBytes, 0);
});

test('small successive windows reuse read-ahead and expose no unrequested padding', async () => {
  const { window, state, sampleAt } = fixture();
  await window.info();
  for (let start = 0; start < 750; start += 25) {
    const lease = await window.acquire(start, start + 50);
    checkLease(lease, sampleAt, start, start + 50);
    lease.release();
  }
  assert.equal(state.reads.length, 1);
  assert.equal(window.stats().cacheHits, 30);
  const beyond = await window.acquire(750, 850);
  checkLease(beyond, sampleAt, 750, 850);
  beyond.release();
  assert.equal(state.reads.length, 2);
  assert.equal(state.reads[1].start, 0.1);
  assert.equal(state.reads[1].end, 0.2);
  releasedPackets(state);
  await window.dispose();
});

test('leases own independent assembled copies and require release before new jobs', async () => {
  const { window, sampleAt } = fixture();
  await window.info();
  const lease = await window.acquire(50, 250);
  await assert.rejects(window.acquire(250, 300), { name: 'InvalidStateError' });
  lease.channels[0].fill(100);
  lease.release();
  lease.release();
  assert.equal(lease.released, true);
  assert.equal(lease.channels.length, 0);
  const again = await window.acquire(50, 250);
  checkLease(again, sampleAt, 50, 250);
  again.release();
  await window.dispose();
});

test('owned cache, assembly reservation and lease never exceed the shared byte cap', async () => {
  const maxBytes = 2048;
  const { window, state, sampleAt } = fixture({ maxBytes });
  await window.info();
  for (let start = 0; start < 3000; start += 97) {
    const lease = await window.acquire(start, start + 100);
    checkLease(lease, sampleAt, start, start + 100);
    assert.ok(window.stats().ownedBytes <= maxBytes);
    lease.release();
  }
  assert.ok(window.stats().peakBudgetedBytes <= maxBytes);
  assert.ok(window.stats().peakOwnedBytes <= maxBytes);
  await assert.rejects(window.acquire(0, 200), { name: 'QuotaExceededError' });
  releasedPackets(state);
  await window.dispose();
  assert.equal(window.stats().ownedBytes, 0);
  assert.equal(window.stats().reservedBytes, 0);
});

test('verified decoded EOF clips only the true boundary and returns an empty EOF lease', async () => {
  const { window, state, sampleAt } = fixture({
    frames: 137,
    durationHint: 50,
  });
  assert.deepEqual(await window.info(), {
    sampleRate: 8000,
    channels: 2,
    durationHint: 50,
    totalSourceFrames: 137,
  });
  const tail = await window.acquire(100, 500);
  checkLease(tail, sampleAt, 100, 137);
  assert.equal(tail.totalSourceFrames, 137);
  tail.release();
  for (const start of [137, 1000]) {
    const empty = await window.acquire(start, start + 50);
    checkLease(empty, sampleAt, 137, 137);
    assert.equal(empty.totalSourceFrames, 137);
    empty.release();
  }
  assert.equal(state.reads.length, 1);
  await window.dispose();
});

test('EOF discovered during a later acquire clips the requested interpolation tail', async () => {
  const { window, sampleAt } = fixture({ frames: 1007, durationHint: 0.001 });
  assert.equal((await window.info()).totalSourceFrames, undefined);
  const lease = await window.acquire(700, 1200);
  checkLease(lease, sampleAt, 700, 1007);
  assert.equal(lease.totalSourceFrames, 1007);
  lease.release();
  await window.dispose();
});

test('reset invalidates leases and clears cache while retaining same-source format', async () => {
  const { window, state, sampleAt } = fixture();
  await window.info();
  const lease = await window.acquire(0, 100);
  const generation = window.stats().generation;
  await window.reset();
  assert.equal(lease.released, true);
  assert.equal(window.stats().ownedBytes, 0);
  assert.equal(window.stats().generation, generation + 1);
  assert.equal((await window.info()).sampleRate, 8000);
  const next = await window.acquire(10000, 10100);
  checkLease(next, sampleAt, 10000, 10100);
  next.release();
  releasedPackets(state);
  await window.dispose();
});

test('aborting a read preserves validated cache and closes late packets without publication', async () => {
  const gate = deferred();
  const { window, state, sampleAt } = fixture({
    gate,
    gateAfterReads: 1,
    ignoreAbort: true,
  });
  await window.info();
  const before = window.stats().cacheBytes;
  const controller = new AbortController();
  const pending = window.acquire(800, 900, { signal: controller.signal });
  await tick();
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(window.stats().activeLeases, 0);
  assert.ok(window.stats().cacheBytes <= before);
  const cached = await window.acquire(700, 750);
  checkLease(cached, sampleAt, 700, 750);
  cached.release();
  releasedPackets(state);
  await window.dispose();
});

test('reset waits for an old read and cannot publish its stale result', async () => {
  const gate = deferred();
  const { window, state } = fixture({
    gate,
    gateAfterReads: 1,
    ignoreAbort: true,
  });
  await window.info();
  const pending = window.acquire(800, 900);
  await tick();
  const reset = window.reset();
  await assert.rejects(window.acquire(0, 10), { name: 'InvalidStateError' });
  gate.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  await reset;
  assert.equal(window.stats().ownedBytes, 0);
  assert.equal(window.stats().activeJobs, 0);
  assert.equal(window.stats().activeLeases, 0);
  releasedPackets(state);
  await window.dispose();
});

test('strict format and timestamp validation releases every rejected source packet', async () => {
  const cases = [
    { channels: 1 },
    { nonFinite: true },
    { packetRate: (frame) => (frame ? 16000 : 8000) },
    { timestamp: (frame) => frame / 8000 + (frame ? 0.001 : 0) },
    { timestamp: (frame) => frame / 8000 - (frame ? 0.001 : 0) },
    { timestamp: () => NaN },
  ];
  for (const options of cases) {
    const { window, state } = fixture(options);
    await assert.rejects(window.info(), { name: 'DataError' });
    releasedPackets(state);
    await window.dispose();
    assert.equal(window.stats().ownedBytes, 0);
  }
});

test('carried frame counts tolerate rounding without accumulating per-packet drift', async () => {
  const { window, state, sampleAt } = fixture({
    timestamp: (frame) => Math.round((frame / 8000) * 1000000) / 1000000,
  });
  await window.info();
  const lease = await window.acquire(717, 1054);
  checkLease(lease, sampleAt, 717, 1054);
  lease.release();
  releasedPackets(state);
  await window.dispose();
  const drift = fixture({
    timestamp: (frame) => frame / 8000 + (frame / 80) * 0.0001,
  });
  await assert.rejects(drift.window.info(), { name: 'DataError' });
  await drift.window.dispose();
});

test('invalid EOF metadata cannot clamp playback or contradict retained frames', async () => {
  for (const eofMetadata of [
    { endOfStream: true, sampleRate: 96000, endTimestamp: 0.1 },
    { endOfStream: true, sampleRate: 8000, endTimestamp: 0.05 },
    { endOfStream: true, sampleRate: 8000, endTimestamp: 0.2 },
    { endOfStream: true, sampleRate: 8000, endTimestamp: 0.1 + 1.25 / 8000 },
    { endOfStream: true, sampleRate: 8000, endTimestamp: 0.1 - 1.25 / 8000 },
    { endOfStream: true, sampleRate: 8000, endTimestamp: NaN },
  ]) {
    const { window, state } = fixture({ eofMetadata });
    await assert.rejects(window.info(), { name: 'DataError' });
    releasedPackets(state);
    await window.dispose();
  }
});

test('EOF quantization never adds or removes a carried decoded sample', async () => {
  for (const samples of [-1, -0.9, 0.9, 1]) {
    const { window, state, sampleAt } = fixture({
      frames: 137,
      eofMetadata: {
        endOfStream: true,
        sampleRate: 8000,
        endTimestamp: (137 + samples) / 8000,
      },
    });
    assert.equal((await window.info()).totalSourceFrames, 137);
    const lease = await window.acquire(100, 140);
    checkLease(lease, sampleAt, 100, 137);
    lease.release();
    releasedPackets(state);
    await window.dispose();
  }
});

test('sub-sample timestamp origins are preserved in later read bounds and EOF', async () => {
  for (const sampleRate of [8000, 44100, 48000]) {
    for (const direction of [-1, 1]) {
      const timestampOffset =
        direction * (sampleRate === 8000 ? 0.25 / sampleRate : 0.000005);
      const { window, state, sampleAt } = fixture({
        sampleRate,
        frames: 10007,
        packetFrames: 83,
        timestampOffset,
        timestamp: (frame) =>
          sampleRate === 8000
            ? frame / sampleRate + timestampOffset
            : Math.round((frame / sampleRate + timestampOffset) * 1000000) /
              1000000,
      });
      await window.info();
      await window.reset();
      const middle = await window.acquire(7000, 7300);
      checkLease(middle, sampleAt, 7000, 7300);
      middle.release();
      const read = state.reads[1];
      assert.equal(read.start, timestampOffset + 7000 / sampleRate);
      assert.equal(
        read.end,
        timestampOffset + (7000 + Math.ceil(0.1 * sampleRate)) / sampleRate,
      );
      const tail = await window.acquire(9850, 10200);
      checkLease(tail, sampleAt, 9850, 10007);
      assert.equal(tail.totalSourceFrames, 10007);
      tail.release();
      await window.reset();
      const beginning = await window.acquire(0, 100);
      checkLease(beginning, sampleAt, 0, 100);
      assert.equal(state.reads.at(-1).start, Math.max(0, timestampOffset));
      beginning.release();
      releasedPackets(state);
      await window.dispose();
    }
  }
});

test('source errors release reservations and permit retry without a stale lease', async () => {
  const options = { failAfterFirst: true };
  const { window, state } = fixture(options);
  await assert.rejects(window.info(), /Decoder failed/);
  assert.equal(window.stats().activeJobs, 0);
  assert.equal(window.stats().reservedBytes, 0);
  options.failAfterFirst = false;
  await window.info();
  assert.equal(state.reads.length, 2);
  const lease = await window.acquire(0, 100);
  lease.release();
  releasedPackets(state);
  await window.dispose();
});

test('validates construction, initialization, bounds and terminal disposal', async () => {
  const { window, source, state } = fixture();
  for (const change of [
    { maxBytes: 15 },
    { maxBytes: Infinity },
    { readAheadSeconds: 0 },
    { readAheadSeconds: 31 },
    { readAheadSeconds: NaN },
  ])
    assert.throws(() => createPcmWindow({ source, ...change }), RangeError);
  await assert.rejects(window.acquire(0, 1), { name: 'InvalidStateError' });
  await window.info();
  for (const [start, end] of [
    [-1, 2],
    [0.5, 2],
    [0, Infinity],
    [1, 1],
  ])
    await assert.rejects(window.acquire(start, end), RangeError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(window.acquire(0, 1, { signal: controller.signal }), {
    name: 'AbortError',
  });
  await window.dispose();
  await window.dispose();
  await assert.rejects(window.info(), { name: 'AbortError' });
  await assert.rejects(window.acquire(0, 1), { name: 'AbortError' });
  assert.equal(state.disposals, 1);
});

test('44100 and 48000 Hz packets retain one absolute frame lattice across page boundaries', async () => {
  for (const sampleRate of [44100, 48000]) {
    const { window, state, sampleAt } = fixture({
      sampleRate,
      packetFrames: 1024,
      timestamp: (frame) =>
        Math.round((frame / sampleRate) * 1000000) / 1000000,
    });
    await window.info();
    for (let start = 3571; start < 18000; start += 997) {
      const lease = await window.acquire(start, start + 1500);
      checkLease(lease, sampleAt, start, start + 1500);
      lease.release();
    }
    assert.ok(state.reads.length < 8);
    releasedPackets(state);
    await window.dispose();
  }
});

test('disposal callers all wait for the owned source, and reset remains terminal afterward', async () => {
  const disposeGate = deferred();
  const { window, state } = fixture({ disposeGate });
  await window.info();
  let completed = 0;
  const first = window.dispose().then(() => completed++);
  const second = window.dispose().then(() => completed++);
  await tick();
  assert.equal(completed, 0);
  assert.equal(state.disposals, 1);
  disposeGate.resolve();
  await Promise.all([first, second]);
  assert.equal(completed, 2);
  const before = window.stats();
  await window.reset();
  assert.deepEqual(window.stats(), before);
});
