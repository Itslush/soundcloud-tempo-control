const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('./module-fixture.cjs')(['tempo-crossfade.js']);
const { createCrossfade } = vm.runInNewContext(source + '\nfixtureModule;', {
  AbortController,
});
const settle = () => new Promise(setImmediate);

function fixture() {
  const values = new Map();
  const audio = Object.assign(new EventTarget(), {
    currentTime: 20,
    duration: 30,
    currentSrc: 'blob:first',
    paused: false,
    seeking: false,
    readyState: 4,
  });
  const settings = { rate: 1, preserve: false, shift: 0, variable: false };
  const state = {
    track: 'first',
    clicks: 0,
    reads: 0,
    stops: 0,
    fades: [],
    bound: true,
    graphReady: true,
    fail: false,
    cached: 0,
    preloads: 0,
    releases: 0,
    nextTrack: 'second',
    nextRate: 1,
  };
  const context = {
    currentTime: 0,
    state: 'running',
    createBuffer: (channels, frames, sampleRate) => ({
      duration: frames / sampleRate,
      copyToChannel() {},
    }),
  };
  let tick;
  const api = createCrossfade({
    readNextRate: () => state.nextRate,
    preloadNext: async () => {
      state.preloads++;
      if (state.queuePending)
        throw Object.assign(new Error('No next track is queued.'), {
          code: 'SOUNDCLOUD_QUEUE_PENDING',
        });
      const next = state.nextTrack;
      let released = false;
      return {
        matches: () => next === state.nextTrack,
        ready: (seconds) => state.cached >= seconds,
        bufferedSeconds: () => state.cached,
        streamUrl: () => state.nextUrl ?? 'https://a.sndcdn.com/next.m3u8',
        isCurrent: () => state.track === next,
        dispose() {
          if (!released) state.releases++;
          released = true;
        },
      };
    },
    graph: {
      contextFor: () => context,
      crossfadeReady: () => state.graphReady,
      prepareIncoming: async (audio, buffer) => {
        await state.openingWait;
        return buffer;
      },
      beginCrossfade(target, buffer, offset, rate, seconds, opening) {
        state.start = { target, buffer, offset, rate, seconds, opening };
        return {
          context,
          overlapEnd: context.currentTime + seconds,
          endTime: context.currentTime + opening.duration,
          position: () => context.currentTime,
          nativePosition: (target) => target.currentTime,
          silence: () => true,
          fadeIn(target, duration) {
            state.fades.push({ target, duration });
            this.endTime = context.currentTime + 0.08;
            return true;
          },
          dispose: () => state.stops++,
        };
      },
    },
    modules: {
      loadAudioDependencies: async () => {
        state.reads++;
        return {};
      },
      createPcmSource: () => ({}),
      createPcmWindow: () => ({
        info: async () => {
          if (state.fail) throw new Error('Decoder unavailable');
          return { durationHint: 30, sampleRate: 8000 };
        },
        acquire: async (from, to) => ({
          channels: [new Float32Array(to - from), new Float32Array(to - from)],
          release() {},
        }),
        dispose: async () => {},
      }),
    },
    sourceFor: () => ({
      status: state.bound ? 'bound' : 'unbound',
      reason: state.bound ? undefined : 'waiting-for-payload-proof',
      sourceId: state.track,
      playlistUrl: 'https://a.sndcdn.com/a.m3u8',
    }),
    resolveSource: async () => {
      await state.sourceWait;
      return {
        status: state.bound ? 'bound' : 'unbound',
        sourceId: state.track,
        playlistUrl: 'https://a.sndcdn.com/a.m3u8',
      };
    },
    sourceStats: () => ({ installed: true, playlists: 1 }),
    readSettings: () => settings,
    readTrack: () => state.track,
    nextButton: () => ({
      click() {
        state.clicks++;
      },
    }),
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    timers: {
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
    },
  });
  api.reload();
  api.select(audio);
  return {
    api,
    state,
    audio,
    settings,
    context,
    values,
    tick: () => tick?.(),
    async opening() {
      tick?.();
      await settle();
      tick?.();
    },
  };
}

test('crossfade is opt-in, overlaps once, then restores normal playback', async () => {
  const f = fixture();
  f.tick();
  assert.equal(f.state.reads, 0);
  f.api.set(true, 5);
  f.tick();
  await settle();
  assert.equal(f.state.preloads, 1);
  assert.equal(f.state.clicks, 0);
  f.state.cached = 24;
  await f.opening();
  assert.equal(f.api.label(), 'Crossfade ready.');
  f.audio.currentTime = 25;
  f.tick();
  assert.equal(f.state.clicks, 1);
  assert.equal(f.state.start.offset, 2);
  assert.equal(f.state.start.seconds, 5);
  f.audio.dispatchEvent(new Event('pause'));
  assert.equal(f.state.stops, 0);
  f.state.track = 'second';
  f.audio.currentTime = 0;
  f.audio.currentSrc = 'blob:second';
  f.context.currentTime = 1;
  f.audio.dispatchEvent(new Event('playing'));
  assert.equal(
    f.state.fades.length,
    0,
    'buffered intro keeps playing during native startup',
  );
  assert.equal(
    f.audio.currentTime,
    1,
    'native playback is aligned while muted',
  );
  f.tick();
  assert.equal(f.state.clicks, 1);
  f.context.currentTime = 5;
  f.audio.currentTime = 5;
  f.tick();
  assert.equal(f.state.fades.length, 1);
  f.context.currentTime = 5.1;
  f.tick();
  assert.equal(f.state.stops, 1);
  assert.equal(f.state.releases, 1);
  f.api.dispose();
});

test('pending identification waits for proof and cannot resume after cancellation', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture();
    let identify;
    f.state.bound = false;
    f.state.sourceWait = new Promise((resolve) => {
      identify = resolve;
    });
    f.api.set(true, 5);
    f.tick();
    await settle();
    assert.equal(f.api.diagnostics().stage, 'identifying-source');
    assert.equal(
      f.api.diagnostics().player.sourceReason,
      'waiting-for-payload-proof',
    );
    assert.equal(f.api.diagnostics().player.sourceCapture.installed, true);
    assert.equal(f.state.reads, 0);
    if (cancelled) f.api.cancel();
    f.state.bound = true;
    identify();
    await settle();
    assert.equal(f.state.reads, cancelled ? 0 : 1);
    assert.equal(f.state.clicks, 0);
    f.api.dispose();
  }
});

test('recovered graphs clear stale warnings before the preload window', () => {
  const f = fixture();
  f.audio.duration = 183.05;
  f.audio.currentTime = 1.4;
  f.state.graphReady = false;
  f.api.set(true, 10);
  f.tick();
  assert.match(f.api.label(), /needs a ready player/);
  f.state.graphReady = true;
  f.tick();
  assert.match(f.api.label(), /Preloading starts near the end/);
  assert.equal(f.api.diagnostics().player.graphReady, true);
  assert.equal(f.state.preloads, 0);
  f.api.dispose();
});

test('a pending payload hash at the fade boundary waits without dropping the prepared overlap', async () => {
  const f = fixture();
  f.api.set(true, 5);
  f.tick();
  await settle();
  f.state.cached = 24;
  await f.opening();
  f.audio.currentTime = 25;
  f.state.bound = false;
  f.tick();
  assert.equal(f.state.clicks, 0);
  assert.equal(f.state.releases, 0);
  assert.match(f.api.label(), /Waiting for stream verification/);
  f.state.bound = true;
  f.tick();
  assert.equal(f.state.clicks, 1);
  assert.equal(f.state.preloads, 1);
  f.api.dispose();
});

test('pause, seek, disable and manual cancellation dispose the overlap', async () => {
  for (const action of ['pause', 'seeking', 'off', 'cancel']) {
    const f = fixture();
    f.api.set(true, 5);
    f.tick();
    await settle();
    f.state.cached = 24;
    await f.opening();
    f.audio.currentTime = 25;
    f.tick();
    f.state.track = 'second';
    f.audio.currentTime = 0;
    f.tick();
    if (action === 'off') f.api.set(false, 5);
    else if (action === 'cancel') f.api.cancel();
    else if (action === 'seeking')
      f.api.cancel(); // Trusted seek controls cancel before the native seek event.
    else f.audio.dispatchEvent(new Event(action));
    assert.equal(f.state.stops, 1, action);
    f.api.dispose();
  }
});

test('delayed next-track loading never starts a fade or advances an unbuffered queue', async () => {
  const f = fixture();
  f.api.set(true, 5);
  f.tick();
  await settle();
  f.audio.currentTime = 25;
  f.tick();
  assert.equal(f.state.clicks, 0);
  assert.equal(f.state.start, undefined);
  assert.match(f.api.label(), /Buffering the next track/);
  f.state.cached = 2;
  f.audio.currentTime = 27;
  f.tick();
  assert.equal(f.state.clicks, 0);
  f.state.cached = 24;
  await f.opening();
  assert.equal(f.state.clicks, 1);
  assert.equal(f.state.start.seconds, 3);
  f.api.dispose();
});

test('normal-speed next tracks need six buffered seconds, not twenty-four; diagnostics explain readiness', async () => {
  const f = fixture();
  f.state.nextRate = 1;
  f.state.cached = 5;
  f.api.set(true, 5);
  f.tick();
  await settle();
  f.audio.currentTime = 25;
  f.tick();
  assert.equal(f.state.clicks, 0);
  const waiting = f.api.diagnostics();
  assert.equal(waiting.player.requiredSeconds, 6);
  assert.equal(waiting.player.nextBufferedSeconds, 5);
  assert.equal(waiting.stage, 'waiting-for-next-buffer');
  f.state.cached = 6;
  await f.opening();
  assert.equal(f.state.clicks, 1);
  f.api.cancel();
  assert.match(f.api.diagnostics().status, /playback controls changed/);
  assert.ok(!JSON.stringify(f.api.diagnostics()).includes('sndcdn.com'));
  for (let i = 0; i < 20; i++) f.api.set(i % 2 === 0, 5);
  assert.equal(f.api.diagnostics().history.length, 12);
  f.api.dispose();
});

test('queue reordering releases stale preloads and buffers the new next track', async () => {
  const f = fixture();
  f.api.set(true, 5);
  f.tick();
  await settle();
  f.state.cached = 24;
  f.state.nextTrack = 'third';
  f.audio.currentTime = 25;
  f.tick();
  assert.equal(f.state.releases, 1);
  assert.equal(f.state.clicks, 0);
  await settle();
  await f.opening();
  assert.equal(f.state.preloads, 2);
  assert.equal(f.state.clicks, 1);
  f.state.track = 'unexpected';
  f.audio.currentTime = 0;
  f.tick();
  assert.equal(f.state.stops, 1);
  assert.equal(f.state.releases, 2);
  f.api.dispose();
});

test('an initially empty queue is retried when playback advances, without toggling crossfade', async () => {
  const f = fixture();
  f.state.queuePending = true;
  f.api.set(true, 5);
  f.tick();
  await settle();
  assert.equal(f.api.diagnostics().stage, 'unavailable');
  f.tick();
  assert.equal(f.state.preloads, 1);
  f.state.queuePending = false;
  f.audio.currentTime += 2;
  f.tick();
  await settle();
  assert.equal(f.state.preloads, 2);
  f.state.cached = 24;
  await f.opening();
  f.audio.currentTime = 25;
  f.tick();
  assert.equal(f.state.clicks, 1);
  f.api.dispose();
});

test('unsupported sources and decode failures never advance the queue', async () => {
  for (const mode of ['unbound', 'decode', 'timeline']) {
    const f = fixture();
    f.state.bound = mode !== 'unbound';
    f.state.fail = mode === 'decode';
    f.settings.variable = mode === 'timeline';
    f.api.set(true, 5);
    f.tick();
    await settle();
    f.audio.currentTime = 25;
    f.tick();
    assert.equal(f.state.clicks, 0, mode);
    assert.match(f.api.label(), /Playing normally|timeline/);
    f.api.dispose();
  }
});

test('cancelled preparation cannot start later and settings validate before writing', async () => {
  const f = fixture();
  f.api.set(true, 5);
  f.tick();
  f.api.set(false, 5);
  await settle();
  f.audio.currentTime = 25;
  f.tick();
  assert.equal(f.state.clicks, 0);
  const before = [...f.values];
  for (const value of [0, 11, 1.5, Infinity, NaN])
    assert.throws(() => f.api.set(true, value));
  assert.deepEqual([...f.values], before);
  f.api.dispose();
});

test('a late native start stays masked until it matches the already-audible opening', async () => {
  const f = fixture();
  f.state.cached = 24;
  f.api.set(true, 5);
  f.tick();
  await settle();
  await f.opening();
  f.audio.currentTime = 25;
  f.tick();
  f.context.currentTime = 6; // Native startup lasts longer than the overlap.
  f.tick();
  assert.equal(
    f.state.stops,
    0,
    'opening keeps playing after the outgoing tail ends',
  );
  f.state.track = 'second';
  f.audio.currentTime = 0;
  f.tick();
  assert.equal(f.audio.currentTime, 6);
  assert.equal(f.state.fades.length, 0);
  f.context.currentTime = 6.1;
  f.audio.currentTime = 6.1;
  f.tick();
  assert.equal(f.state.fades.length, 1);
  f.context.currentTime = 6.2;
  f.tick();
  assert.equal(f.state.stops, 1);
  f.api.dispose();
});

test('opening cancellation, changed stream and exhausted handoff restore safely', async () => {
  for (const action of ['cancel', 'stream', 'timeout']) {
    const f = fixture();
    f.state.cached = 24;
    f.api.set(true, 5);
    f.tick();
    await settle();
    let finish;
    f.state.openingWait = new Promise((resolve) => {
      finish = resolve;
    });
    f.tick();
    await settle();
    assert.equal(f.api.diagnostics().stage, 'decoding-incoming');
    if (action === 'cancel') f.api.cancel();
    if (action === 'stream')
      f.state.nextUrl = 'https://a.sndcdn.com/replacement.m3u8';
    finish();
    await settle();
    assert.equal(f.state.clicks, 0);
    if (action === 'timeout') {
      f.audio.currentTime = 25;
      f.tick();
      f.context.currentTime = 14;
      f.tick();
      assert.equal(f.state.stops, 1);
      assert.match(f.api.label(), /before SoundCloud could synchronize/);
    } else assert.equal(f.state.releases, 1);
    f.api.dispose();
  }
});
