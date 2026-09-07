import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackOwner } from '../src/audio/playback-owner.mjs';

const settle = async () => {
  for (let index = 0; index < 100; index++) await Promise.resolve();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const native = new WeakMap();
  class Media extends EventTarget {
    constructor() {
      super();
      native.set(this, {
        currentTime: 4,
        duration: 120,
        paused: true,
        ended: false,
        seeking: false,
        readyState: 4,
        networkState: 1,
        playbackRate: 1,
        defaultPlaybackRate: 1,
        src: 'blob:track-one',
        srcObject: null,
      });
      this.calls = [];
    }
    play() {
      this.calls.push('play');
      native.get(this).paused = false;
      return Promise.resolve();
    }
    pause() {
      this.calls.push('pause');
      native.get(this).paused = true;
      this.dispatchEvent(new Event('pause'));
    }
    load() {
      this.calls.push('load');
    }
  }
  for (const key of Object.keys(native.get(new Media())))
    Object.defineProperty(Media.prototype, key, {
      configurable: true,
      get() {
        return native.get(this)[key];
      },
      ...(['src', 'srcObject', 'currentTime'].includes(key)
        ? {
            set(value) {
              native.get(this)[key] = value;
            },
          }
        : {}),
    });
  const context = new EventTarget();
  Object.assign(context, {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    resume: async () => {},
  });
  const tasks = new Map();
  let timerId = 0;
  const queued = [];
  const changes = [];
  const errors = [];
  const graph = { owned: false, acquisitions: 0, releases: [], lease: null };
  const engines = [];
  const sources = [];
  const owner = createPlaybackOwner({
    prototype: Media.prototype,
    enqueue: (callback) => queued.push(callback),
    timers: {
      setTimeout(callback) {
        tasks.set(++timerId, callback);
        return timerId;
      },
      clearTimeout(id) {
        tasks.delete(id);
      },
    },
    onChange: (audio, state) => changes.push({ audio, state }),
    onError: (error) => errors.push(error),
    acquireGraph(audio, hooks) {
      assert.equal(graph.owned, false, 'Graph cannot have overlapping owners');
      graph.owned = true;
      graph.acquisitions++;
      const controller = new AbortController();
      const lease = {
        context,
        input: { context },
        ready: Promise.resolve().then(() =>
          hooks.parkNative({ signal: controller.signal }),
        ),
        async release(position, { restore }) {
          controller.abort();
          graph.releases.push({ position, restore });
          await options.releaseGate?.promise;
          await hooks.restoreNative({
            position,
            restore,
            signal: new AbortController().signal,
          });
          graph.owned = false;
        },
      };
      graph.lease = lease;
      return lease;
    },
    async resolveSource(audio, { signal }) {
      sources.push({ audio, signal });
      await options.sourceGate?.promise;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return { playlistUrl: 'https://test.sndcdn.com/audio.m3u8', sourceId: 1 };
    },
    async createEngine({ mode, signal }) {
      await options.engineGate?.promise;
      const stats = {
        mode,
        signal,
        leases: 0,
        providerDisposed: 0,
        outputDisposed: 0,
        scheduled: [],
        resets: 0,
      };
      const engine = {
        provider: {
          async info() {
            return {
              sampleRate: 48000,
              channels: 2,
              durationHint: options.durationHint ?? 120,
            };
          },
          async acquire(start, end) {
            const total = options.totalSourceFrames;
            const first = total === undefined ? start : Math.min(start, total);
            const last = total === undefined ? end : Math.min(end, total);
            stats.leases++;
            return {
              sampleRate: 48000,
              pcmStartFrame: first,
              ...(total === undefined ? {} : { totalSourceFrames: total }),
              channels: [
                new Float32Array(last - first),
                new Float32Array(last - first),
              ],
              release() {
                stats.leases--;
              },
            };
          },
          async reset() {},
          async dispose() {
            stats.providerDisposed++;
          },
        },
        output: {
          schedule({ clock, totalSourceFrames }) {
            stats.scheduled.push(clock);
            if (totalSourceFrames === undefined) return clock;
            const sourceEndFrame = Math.min(
              clock.sourceEndFrame,
              totalSourceFrames,
            );
            return {
              sourceStartFrame: clock.sourceStartFrame,
              sourceEndFrame,
              outputStartFrame: clock.outputStartFrame,
              outputEndFrame: clock.outputAt(sourceEndFrame),
            };
          },
          truncate() {},
          reset() {
            stats.resets++;
          },
          dispose() {
            stats.outputDisposed++;
          },
        },
        stats,
      };
      engines.push(engine);
      return engine;
    },
  });
  const audio = new Media();
  return {
    owner,
    audio,
    native,
    context,
    graph,
    engines,
    sources,
    tasks,
    errors,
    changes,
    flush() {
      while (queued.length) queued.shift()();
    },
    async advance(time) {
      context.currentTime = time;
      for (const [id, callback] of [...tasks]) {
        tasks.delete(id);
        callback();
      }
      await settle();
      this.flush();
    },
  };
}

const settings = (mode = 'natural', rate = 0.025, track = '/artist/track') => ({
  mode,
  rate,
  track,
});

test('acquiring a natively ended element replays from the start on the first Play', async (t) => {
  const f = fixture({ totalSourceFrames: 192000, durationHint: 4 });
  t.after(() => f.owner.dispose());
  Object.assign(f.native.get(f.audio), {
    currentTime: 4,
    duration: 4,
    paused: true,
    ended: true,
  });
  await f.owner.use(f.audio, settings());
  assert.equal(f.audio.paused, true);
  assert.equal(f.native.get(f.audio).currentTime, 4);
  const playing = f.audio.play();
  await settle();
  await f.advance(0.3);
  await playing;
  const scheduled = f.engines[0].stats.scheduled;
  assert.ok(scheduled.length > 0, 'First replay must schedule audio');
  assert.equal(scheduled[0].sourceStartFrame, 0);
  assert.equal(f.audio.paused, false);
  assert.equal(f.audio.ended, false);
  assert.ok(f.audio.currentTime < 4);
  assert.deepEqual(f.errors, []);
});

test('acquiring paused media at the duration without native EOF does not invent a rewind', async (t) => {
  const f = fixture({ totalSourceFrames: 192000, durationHint: 4 });
  t.after(() => f.owner.dispose());
  Object.assign(f.native.get(f.audio), {
    currentTime: 4,
    duration: 4,
    paused: true,
    ended: false,
  });
  await f.owner.use(f.audio, settings());
  assert.equal(f.audio.currentTime, 4);
  const playing = f.audio.play();
  await settle();
  f.flush();
  await playing;
  assert.equal(f.engines[0].stats.scheduled.length, 0);
  assert.equal(f.audio.currentTime, 4);
  assert.equal(f.audio.ended, true);
  assert.deepEqual(f.errors, []);
});

test('mode handoff retains genuine EOF until the first replay', async (t) => {
  const f = fixture({ totalSourceFrames: 192000, durationHint: 4 });
  t.after(() => f.owner.dispose());
  Object.assign(f.native.get(f.audio), {
    currentTime: 4,
    duration: 4,
    paused: true,
    ended: true,
  });
  await f.owner.use(f.audio, settings());
  assert.equal(f.audio.ended, true);
  f.native.get(f.audio).ended = false;
  await f.owner.use(f.audio, settings('preserve'));
  assert.equal(f.audio.ended, true);
  assert.equal(f.audio.currentTime, 4);
  assert.equal(f.engines.length, 0);
  const playing = f.audio.play();
  await settle();
  await f.advance(0.3);
  await playing;
  assert.equal(f.engines[0].stats.scheduled[0].sourceStartFrame, 0);
  assert.equal(f.audio.ended, false);
  assert.deepEqual(f.errors, []);
});

test('an explicit seek after ended acquisition overrides replay rewind', async (t) => {
  const f = fixture({ totalSourceFrames: 192000, durationHint: 4 });
  t.after(() => f.owner.dispose());
  Object.assign(f.native.get(f.audio), {
    currentTime: 4,
    duration: 4,
    paused: true,
    ended: true,
  });
  await f.owner.use(f.audio, settings());
  f.audio.currentTime = 1;
  await settle();
  f.flush();
  assert.equal(f.audio.ended, false);
  assert.equal(f.audio.currentTime, 1);
  const playing = f.audio.play();
  await settle();
  await f.advance(0.3);
  await playing;
  assert.equal(f.engines[0].stats.scheduled[0].sourceStartFrame, 48000);
  assert.deepEqual(f.errors, []);
});

test('native EOF replay still respects explicit Pause and source-change cancellation', async () => {
  for (const action of ['pause', 'source']) {
    const f = fixture({ totalSourceFrames: 192000, durationHint: 4 });
    try {
      Object.assign(f.native.get(f.audio), {
        currentTime: 4,
        duration: 4,
        paused: true,
        ended: true,
      });
      await f.owner.use(f.audio, settings());
      const playing = f.audio.play();
      const cancelled = assert.rejects(playing, { name: 'AbortError' });
      if (action === 'pause') f.audio.pause();
      else f.audio.src = 'blob:next-track';
      await settle();
      f.flush();
      await cancelled;
      assert.equal(f.audio.paused, true);
      assert.equal(f.native.get(f.audio).currentTime, 4);
      if (action === 'source') assert.equal(f.owner.owns(f.audio), false);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.owner.dispose();
    }
  }
});

test('paused ownership attaches immediately without fetching or starting the native player', async () => {
  const f = fixture();
  const using = f.owner.use(f.audio, settings());
  assert.equal(f.owner.owns(f.audio), true);
  await using;
  assert.equal(f.audio.currentTime, 4);
  assert.equal(f.audio.paused, true);
  assert.equal(f.sources.length, 0);
  assert.equal(f.engines.length, 0);
  assert.deepEqual(f.audio.calls, ['pause']);
  await f.owner.dispose();
  assert.equal(f.graph.owned, false);
});

test('play uses the owned graph and source clock without native duplicate playback', async () => {
  const f = fixture();
  await f.owner.use(f.audio, settings());
  const playing = f.audio.play();
  await settle();
  await f.advance(0.2);
  await playing;
  assert.equal(f.audio.paused, false);
  assert.equal(f.native.get(f.audio).paused, true);
  assert.ok(
    Math.abs(
      f.audio.currentTime - (4 + (0.2 - 2432 / 48000) * Math.fround(0.025)),
    ) < 1e-10,
  );
  assert.deepEqual(f.audio.calls, ['pause']);
  assert.equal(f.engines.length, 1);
  f.audio.pause();
  await f.owner.dispose();
  assert.equal(f.engines[0].stats.providerDisposed, 1);
  assert.equal(f.engines[0].stats.outputDisposed, 1);
  assert.equal(f.engines[0].stats.leases, 0);
});

test('queued loadstart during first Play and Seek retains one owner and its playing intent', async () => {
  for (const mode of ['natural', 'preserve']) {
    const sourceGate = deferred();
    const f = fixture({ sourceGate });
    const using = f.owner.use(f.audio, settings(mode));
    const playing = f.audio.play().then(
      () => null,
      (error) => error,
    );
    try {
      f.audio.currentTime = 0;
      f.audio.dispatchEvent(new Event('loadstart'));
      assert.equal(f.owner.owns(f.audio), true);
      sourceGate.resolve();
      await using;
      await settle();
      await f.advance(0.3);
      assert.equal(await playing, null);
      assert.equal(f.audio.paused, false);
      assert.equal(f.native.get(f.audio).paused, true);
      assert.ok(f.audio.currentTime > 0 && f.audio.currentTime < 0.01);
      assert.equal(f.graph.acquisitions, 1);
      assert.equal(f.graph.releases.length, 0);
      assert.equal(f.engines.length, 1);
      assert.equal(f.engines[0].stats.outputDisposed, 0);
      assert.deepEqual(f.audio.calls, ['pause']);
      assert.deepEqual(f.errors, []);
    } finally {
      sourceGate.resolve();
      await f.owner.dispose();
    }
    assert.equal(f.engines[0].stats.providerDisposed, 1);
    assert.equal(f.engines[0].stats.outputDisposed, 1);
    assert.equal(f.graph.owned, false);
  }
});

test('returning native ownership restores the rendered position without restarting audio', async () => {
  const f = fixture();
  await f.owner.use(f.audio, settings());
  const playing = f.audio.play();
  await settle();
  await f.advance(0.3);
  await playing;
  const position = f.audio.currentTime;
  const released = await f.owner.release(f.audio);
  assert.equal(released.playing, true);
  assert.equal(released.position, position);
  assert.equal(f.audio.currentTime, position);
  assert.equal(f.audio.paused, true);
  assert.equal(f.owner.owns(f.audio), false);
  assert.deepEqual(f.audio.calls, ['pause']);
  await f.owner.dispose();
});

test('native source replacement cancels pending initialization and never seeks the new song', async () => {
  const sourceGate = deferred();
  const f = fixture({ sourceGate });
  await f.owner.use(f.audio, settings());
  const playing = assert.rejects(f.audio.play(), { name: 'AbortError' });
  await settle();
  f.audio.src = 'blob:new-song';
  assert.equal(f.owner.owns(f.audio), false);
  sourceGate.resolve();
  await playing;
  await f.owner.dispose();
  assert.equal(f.engines.length, 0);
  assert.equal(f.audio.currentTime, 4);
  assert.equal(f.graph.releases[0].restore, false);
});

test('a late factory result is disposed even when it ignores source cancellation', async () => {
  const engineGate = deferred();
  const f = fixture({ engineGate });
  await f.owner.use(f.audio, settings());
  const playing = assert.rejects(f.audio.play(), { name: 'AbortError' });
  await settle();
  const disposing = f.owner.dispose();
  engineGate.resolve();
  await Promise.all([playing, disposing]);
  assert.equal(f.engines.length, 1);
  assert.equal(f.engines[0].stats.providerDisposed, 1);
  assert.equal(f.engines[0].stats.outputDisposed, 1);
  assert.equal(f.graph.owned, false);
});

test('mode changes preserve position and playback intent through serialized graph release', async () => {
  const f = fixture();
  await f.owner.use(f.audio, settings());
  const playing = f.audio.play();
  await settle();
  await f.advance(0.3);
  await playing;
  const position = f.audio.currentTime;
  await f.owner.use(f.audio, settings('preserve'));
  assert.equal(f.audio.currentTime, position);
  assert.equal(f.audio.paused, false);
  assert.equal(f.graph.acquisitions, 2);
  assert.deepEqual(
    f.engines.map((engine) => engine.stats.mode),
    ['natural', 'preserve'],
  );
  assert.equal(f.engines[0].stats.outputDisposed, 1);
  assert.deepEqual(f.audio.calls, ['pause', 'pause']);
  await f.owner.dispose();
});

test('latest mode request wins while the previous graph is still releasing', async () => {
  const releaseGate = deferred();
  const f = fixture({ releaseGate });
  await f.owner.use(f.audio, settings());
  const older = assert.rejects(f.owner.use(f.audio, settings('preserve')), {
    name: 'AbortError',
  });
  const latest = f.owner.use(f.audio, settings('natural', 0.85));
  releaseGate.resolve();
  await Promise.all([older, latest]);
  assert.equal(f.graph.acquisitions, 2);
  assert.equal(f.owner.snapshot(f.audio).paused, true);
  await f.owner.dispose();
});

test('a superseding mode request retains same-track playback intent and source position', async () => {
  const releaseGate = deferred();
  const f = fixture({ releaseGate });
  await f.owner.use(f.audio, settings());
  const playing = f.audio.play();
  await settle();
  await f.advance(0.3);
  await playing;
  const position = f.audio.currentTime;
  const older = assert.rejects(f.owner.use(f.audio, settings('preserve')), {
    name: 'AbortError',
  });
  const latest = f.owner.use(f.audio, settings('natural', 0.85));
  releaseGate.resolve();
  await Promise.all([older, latest]);
  assert.equal(f.owner.snapshot(f.audio).paused, false);
  assert.equal(f.owner.snapshot(f.audio).position, position);
  assert.equal(f.graph.acquisitions, 2);
  await f.owner.dispose();
});

test('source-event cleanup holds the graph barrier before a new source can acquire it', async () => {
  const releaseGate = deferred();
  const f = fixture({ releaseGate });
  await f.owner.use(f.audio, settings());
  f.audio.src = 'blob:new-source';
  const next = f.owner.use(f.audio, settings('natural', 0.025, '/artist/new'));
  await settle();
  assert.equal(f.graph.acquisitions, 1);
  releaseGate.resolve();
  await next;
  assert.equal(f.graph.acquisitions, 2);
  assert.equal(f.graph.releases[0].restore, false);
  await f.owner.dispose();
});

test('invalid settings leave the existing player ownership intact', async () => {
  const f = fixture();
  await f.owner.use(f.audio, settings());
  for (const rate of [0, 4.01, NaN])
    await assert.rejects(f.owner.use(f.audio, settings('natural', rate)));
  assert.equal(f.owner.owns(f.audio), true);
  assert.equal(f.graph.acquisitions, 1);
  await f.owner.dispose();
});

test('owned rate getters expose the requested rate before loading and revert after release', async () => {
  const f = fixture();
  const observed = [];
  f.audio.addEventListener('ratechange', () =>
    observed.push(f.audio.playbackRate),
  );
  const starting = f.owner.use(f.audio, settings());
  assert.equal(f.audio.playbackRate, 0.025);
  assert.equal(f.audio.defaultPlaybackRate, 0.025);
  assert.equal(f.native.get(f.audio).playbackRate, 1);
  await starting;
  f.flush();
  assert.deepEqual(observed, [0.025]);
  const changed = f.owner.use(f.audio, settings('natural', 0.075));
  assert.equal(f.audio.playbackRate, 0.075);
  assert.equal(f.owner.snapshot(f.audio).requestedRate, 0.075);
  assert.equal(f.owner.snapshot(f.audio).renderedRate, null);
  await changed;
  f.flush();
  assert.deepEqual(observed, [0.025, 0.075]);
  await f.owner.release(f.audio);
  assert.equal(f.audio.playbackRate, 1);
  assert.equal(f.audio.defaultPlaybackRate, 1);
  await f.owner.dispose();
});

test('owned timeline rate getters evaluate full precision at the logical source position', async () => {
  const f = fixture();
  const curve = (time) => 0.025 + time * 0.000123456;
  await f.owner.use(f.audio, settings('natural', curve));
  assert.equal(f.audio.playbackRate, curve(4));
  assert.equal(f.audio.defaultPlaybackRate, curve(4));
  assert.equal(f.owner.snapshot(f.audio).requestedRate, curve(4));
  assert.notEqual(f.audio.playbackRate, Math.round(curve(4) * 1000) / 1000);
  f.audio.currentTime = 8;
  await settle();
  f.flush();
  assert.equal(f.audio.playbackRate, curve(8));
  await f.owner.dispose();
});

test('source replacement during restoration abandons the old seek and leaves the graph recoverable', async () => {
  const releaseGate = deferred();
  const f = fixture({ releaseGate });
  await f.owner.use(f.audio, settings());
  const switching = assert.rejects(f.owner.use(f.audio, settings('preserve')), {
    name: 'AbortError',
  });
  await settle();
  f.audio.src = 'blob:replacement';
  releaseGate.resolve();
  await switching;
  assert.equal(f.graph.owned, false);
  assert.equal(f.owner.owns(f.audio), false);
  assert.deepEqual(
    f.graph.releases.map((value) => value.restore),
    [true, false],
  );
  assert.equal(f.audio.currentTime, 4);
  await f.owner.use(f.audio, settings('natural', 0.025, '/artist/replacement'));
  assert.equal(f.graph.acquisitions, 2);
  await f.owner.dispose();
});

test('failed graph handback remains explicitly retryable instead of orphaning ownership', async () => {
  const f = fixture();
  await f.owner.use(f.audio, settings());
  const original = f.graph.lease.release;
  let failed = false;
  f.graph.lease.release = (...args) => {
    if (!failed) {
      failed = true;
      return Promise.reject(new Error('Handback failed'));
    }
    return original(...args);
  };
  await assert.rejects(f.owner.release(f.audio), /cleanup failed/);
  assert.equal(f.graph.owned, true);
  assert.equal(f.owner.owns(f.audio), false);
  const released = await f.owner.release(f.audio, { restore: false });
  assert.equal(released.restored, false);
  assert.equal(f.graph.owned, false);
  await f.owner.use(f.audio, settings());
  assert.equal(f.graph.acquisitions, 2);
  await f.owner.dispose();
});

test('failed transport setup keeps a graph-release barrier before retry', async () => {
  const releaseGate = deferred();
  const f = fixture({ releaseGate });
  f.context.sampleRate = 7000;
  await assert.rejects(f.owner.use(f.audio, settings()), /audio context/);
  f.context.sampleRate = 48000;
  const next = f.owner.use(f.audio, settings());
  await settle();
  assert.equal(f.graph.acquisitions, 1);
  releaseGate.resolve();
  await next;
  assert.equal(f.graph.acquisitions, 2);
  assert.equal(f.graph.owned, true);
  await f.owner.dispose();
});

test('source initialization can retry after a transient failure before engine creation', async () => {
  const sourceGate = deferred();
  const options = { sourceGate };
  const f = fixture(options);
  await f.owner.use(f.audio, settings());
  const first = assert.rejects(f.audio.play(), /Temporary source error/);
  await settle();
  sourceGate.reject(new Error('Temporary source error'));
  await first;
  options.sourceGate = null;
  const second = f.audio.play();
  await settle();
  await f.advance(0.2);
  await second;
  assert.equal(f.sources.length, 2);
  assert.equal(f.engines.length, 1);
  await f.owner.dispose();
});

test('pause during a mode handoff overrides both pending and superseding playback intent', async () => {
  for (const supersede of [false, true]) {
    const releaseGate = deferred();
    const f = fixture({ releaseGate });
    await f.owner.use(f.audio, settings());
    const playing = f.audio.play();
    await settle();
    await f.advance(0.3);
    await playing;
    const changing = f.owner.use(f.audio, settings('preserve'));
    const changed = supersede
      ? assert.rejects(changing, { name: 'AbortError' })
      : changing;
    f.owner.pause(f.audio);
    f.audio.pause();
    const latest = supersede
      ? f.owner.use(f.audio, settings('natural', 0.85))
      : Promise.resolve();
    releaseGate.resolve();
    await Promise.all([changed, latest]);
    assert.equal(f.owner.snapshot(f.audio).paused, true);
    assert.equal(f.audio.paused, true);
    assert.equal(f.engines.length, 1);
    await f.owner.dispose();
  }
});

test('pause also controls an active transport and does not call native media methods', async () => {
  const f = fixture();
  await f.owner.use(f.audio, settings());
  const playing = f.audio.play();
  await settle();
  await f.advance(0.3);
  await playing;
  const calls = [...f.audio.calls];
  const state = f.owner.pause(f.audio);
  assert.equal(state.paused, true);
  assert.equal(f.audio.paused, true);
  assert.deepEqual(f.audio.calls, calls);
  await f.owner.dispose();
});

test('release returns the same frozen source position that it restores natively', async () => {
  const f = fixture();
  await f.owner.use(f.audio, settings());
  const playing = f.audio.play();
  await settle();
  await f.advance(0.3);
  await playing;
  let time = 0.3;
  Object.defineProperty(f.context, 'currentTime', {
    configurable: true,
    get() {
      time += 0.002;
      return time;
    },
  });
  const released = await f.owner.release(f.audio);
  assert.equal(released.position, f.native.get(f.audio).currentTime);
  assert.equal(released.position, f.graph.releases[0].position);
  assert.ok(released.position > 4);
  await f.owner.dispose();
});

test('context closure removes the facade instead of retaining a disposed owner', async () => {
  const f = fixture();
  await f.owner.use(f.audio, settings());
  f.context.state = 'closed';
  f.context.dispatchEvent(new Event('statechange'));
  await settle();
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(f.owner.snapshot(f.audio), null);
  f.native.get(f.audio).currentTime = 9;
  assert.equal(f.audio.currentTime, 9);
  await f.owner.dispose();
});
