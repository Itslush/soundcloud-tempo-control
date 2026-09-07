const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');

const source = require('./module-fixture.cjs')(['tempo-buffered.js']);
const create = vm.runInNewContext(`${source}\ncreateBufferedPlayback;`, {
  DOMException,
  WeakRef,
  Promise,
  console,
  HTMLMediaElement: class {},
});
const settle = async () => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(configuration = {}) {
  class Media {
    _src = 'blob:one';
    paused = true;
    position = 5;
    plays = 0;
    pauses = 0;
    get src() {
      return this._src;
    }
    get srcObject() {
      return null;
    }
    play() {
      this.plays++;
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.pauses++;
      this.paused = true;
    }
  }
  const audio = new Media();
  const current = {
    track: '/artist/track',
    rate: 1,
    mode: 'natural',
    wasm: true,
    schedule: null,
  };
  const calls = {
    uses: [],
    useMedia: [],
    sourceMedia: [],
    releasedMedia: [],
    releases: [],
    invalidations: [],
    states: 0,
    native: 0,
    failures: [],
    dependencies: 0,
    disposals: [],
    hostClocks: [],
    ownerDisposed: false,
  };
  const state = {
    owned: false,
    graph: true,
    release: null,
    use: null,
    source: {
      status: 'bound',
      sourceId: 1,
      playlistUrl: 'https://test.sndcdn.com/one.m3u8',
    },
  };
  let ownerOptions, bindingOptions;
  const tasks = new Map();
  let timerId = 0;
  const modules = {
    createSoundCloudHostClock({ mediaPrototype }) {
      assert.equal(mediaPrototype, Media.prototype);
      const clock = {
        async dispose() {
          assert.equal(calls.ownerDisposed, true);
          calls.disposals.push('host-clock');
          if (configuration.hostDisposeError)
            throw configuration.hostDisposeError;
        },
      };
      calls.hostClocks.push(clock);
      return clock;
    },
    createSourceBinding(options) {
      bindingOptions = options;
      return {
        install() {},
        resolve(value) {
          calls.sourceMedia.push(value);
          return state.source;
        },
        invalidate: (value) => calls.invalidations.push(value),
        release(value) {
          calls.releasedMedia.push(value);
        },
        dispose: async () => calls.disposals.push('binding'),
      };
    },
    createPlaybackOwner(options) {
      ownerOptions = options;
      return {
        use(value, settings) {
          assert.ok(value instanceof Media);
          calls.uses.push(settings);
          calls.useMedia.push(value);
          if (configuration.hostPreflightError)
            return Promise.reject(configuration.hostPreflightError);
          state.owned = true;
          state.ownedAudio = value;
          return state.use?.promise || Promise.resolve();
        },
        release(value, options) {
          calls.releases.push(options);
          const result =
            state.owned && state.ownedAudio === value
              ? {
                  position: audio.position,
                  playing: !audio.paused,
                  restored: options?.restore !== false,
                }
              : null;
          state.owned = false;
          value.paused = true;
          return state.release?.promise || Promise.resolve(result);
        },
        owns: (value) => state.owned && state.ownedAudio === value,
        pause(value) {
          value.paused = true;
        },
        async dispose() {
          calls.disposals.push('owner');
          await configuration.ownerDisposeGate?.promise;
          calls.ownerDisposed = true;
          if (configuration.ownerDisposeError)
            throw configuration.ownerDisposeError;
        },
      };
    },
    async loadAudioDependencies() {
      calls.dependencies++;
      return { Mediabunny: {} };
    },
    createPcmSource: () => ({ dispose: () => calls.disposals.push('pcm') }),
    createPcmWindow: () => ({ dispose: () => calls.disposals.push('window') }),
    createNaturalOutput: () => ({ kind: 'natural' }),
    createPreserveOutput: () => ({ kind: 'preserve' }),
  };
  const api = create({
    modules,
    prototype: Media.prototype,
    graph: { hasGraph: () => state.graph, acquireBuffered() {} },
    readSettings: () => current,
    media: () => [audio],
    applyNative: () => calls.native++,
    recoverNative() {
      current.rate = 0.25;
      calls.native++;
    },
    onState: () => calls.states++,
    onFailure: (message) => calls.failures.push(message),
    timers: {
      setTimeout(callback) {
        tasks.set(++timerId, callback);
        return timerId;
      },
      clearTimeout(id) {
        tasks.delete(id);
      },
    },
  });
  api.select(audio);
  return {
    api,
    audio,
    current,
    calls,
    state,
    modules,
    tasks,
    owner: ownerOptions,
    binding: bindingOptions,
    fallback: () => audio.play(),
  };
}

test('ordinary playback leaves native ownership and dependency loading untouched', async () => {
  const f = fixture();
  for (const rate of [0.25, 0.85, 1, 2, 4]) {
    f.current.rate = rate;
    assert.equal(f.api.sync(f.audio), false);
  }
  assert.equal(f.calls.uses.length, 0);
  assert.equal(f.calls.dependencies, 0);
  await f.api.play(f.audio, f.fallback);
  assert.equal(f.audio.plays, 1);
  await f.api.dispose();
});

test('the host clock is passed to ownership and disposed only after native cleanup settles', async () => {
  const ownerDisposeGate = deferred();
  const f = fixture({ ownerDisposeGate });
  assert.equal(f.calls.hostClocks.length, 1);
  assert.equal(f.owner.hostClock, f.calls.hostClocks[0]);
  const disposal = f.api.dispose();
  assert.equal(f.api.dispose(), disposal);
  await settle();
  assert.equal(f.calls.disposals.includes('host-clock'), false);
  ownerDisposeGate.resolve();
  await disposal;
  assert.deepEqual(f.calls.disposals, ['owner', 'binding', 'host-clock']);
});

test('host cleanup still runs after owner cleanup failure and both errors remain reported', async () => {
  const ownerDisposeError = new Error('Native return failed');
  const hostDisposeError = new Error('Host restoration failed');
  const f = fixture({ ownerDisposeError, hostDisposeError });
  await assert.rejects(f.api.dispose(), (error) => {
    assert.equal(error.name, 'AggregateError');
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], ownerDisposeError);
    assert.equal(error.errors[1], hostDisposeError);
    return true;
  });
  assert.deepEqual(f.calls.disposals, ['owner', 'binding', 'host-clock']);
});

test('low-rate ownership starts synchronously and repeated refreshes do not reacquire', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  assert.equal(f.api.sync(f.audio), true);
  assert.equal(f.state.owned, true);
  for (let index = 0; index < 100; index++) f.api.sync(f.audio);
  await settle();
  f.api.sync(f.audio);
  assert.equal(f.calls.uses.length, 1);
  assert.equal(f.calls.uses[0].rate, 0.025);
  await f.api.dispose();
});

test('rejected host preflight pauses native playback instead of continuing at an unrequested speed', async () => {
  const error = new Error('Unsupported SoundCloud player');
  const f = fixture({ hostPreflightError: error });
  await f.audio.play();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  assert.equal(f.state.owned, false);
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.plays, 1);
  assert.equal(f.calls.failures.at(-1), error.message);
  assert.equal(f.calls.dependencies, 0);
  await f.api.dispose();
});

test('position snapshots retain the latest state without repeated status notifications', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  const initial = f.calls.states;
  const reads = [];
  for (let position = 0; position < 200; position++) {
    f.owner.onChange(
      f.audio,
      Object.freeze({
        get state() {
          reads.push(position);
          return 'playing';
        },
        position,
        duration: position + 1000,
        scheduledWindows: position % 3,
      }),
    );
  }
  assert.equal(f.calls.states, initial + 1);
  reads.length = 0;
  assert.equal(f.api.label(), 'Buffered playback · Natural pitch.');
  assert.deepEqual(reads, [199]);
  assert.deepEqual(f.calls.failures, []);
  await f.api.dispose();
});

test('unsupported host preflight resumes native playback at the recovery rate', async () => {
  const error = Object.assign(new Error('Unsupported host'), {
    code: 'SOUNDCLOUD_HOST_UNSUPPORTED',
  });
  const f = fixture({ hostPreflightError: error });
  await f.audio.play();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  assert.equal(f.current.rate, 0.25);
  assert.equal(f.audio.paused, false);
  assert.equal(f.calls.native, 1);
  assert.equal(f.calls.dependencies, 0);
  assert.match(f.calls.failures.at(-1), /Saved tempo unchanged/);
  await f.api.dispose();
});

test('pause during unsupported-host handback prevents automatic resume', async () => {
  const error = Object.assign(new Error('Unsupported host'), {
    code: 'SOUNDCLOUD_HOST_UNSUPPORTED',
  });
  const f = fixture({ hostPreflightError: error });
  await f.audio.play();
  f.current.rate = 0.025;
  f.state.release = deferred();
  f.api.sync(f.audio);
  await settle();
  f.api.pause(f.audio);
  f.state.release.resolve(null);
  await settle();
  assert.equal(f.current.rate, 0.25);
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.plays, 1);
  await f.api.dispose();
});

test('unsupported-host recovery cannot change or restart a replacement track', async () => {
  const error = Object.assign(new Error('Unsupported host'), {
    code: 'SOUNDCLOUD_HOST_UNSUPPORTED',
  });
  const f = fixture({ hostPreflightError: error });
  await f.audio.play();
  f.current.rate = 0.025;
  f.state.release = deferred();
  f.api.sync(f.audio);
  await settle();
  f.current.track = '/artist/replacement';
  f.current.rate = 0.85;
  f.state.release.resolve(null);
  await settle();
  assert.equal(f.current.rate, 0.85);
  assert.equal(f.calls.native, 0);
  assert.equal(f.audio.plays, 1);
  await f.api.dispose();
});

test('buffering, playback, suspension, ending and release each notify on status changes', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  for (const state of [
    'buffering',
    'playing',
    'paused',
    'suspended',
    'playing',
    'ended',
    null,
  ]) {
    const before = f.calls.states;
    for (let position = 0; position < 3; position++) {
      f.owner.onChange(f.audio, state === null ? null : { state, position });
    }
    assert.equal(f.calls.states, before + 1, state);
    assert.equal(
      f.api.label(),
      state === 'buffering'
        ? 'Buffering audio…'
        : 'Buffered playback · Natural pitch.',
    );
  }
  await f.api.dispose();
});

test('setup completion notifies even when the transport status stays playing', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.state.use = deferred();
  f.api.sync(f.audio);
  for (let position = 0; position < 10; position++)
    f.owner.onChange(f.audio, { state: 'playing', position });
  assert.equal(f.calls.states, 1);
  assert.equal(f.api.label(), 'Preparing audio…');
  f.state.use.resolve();
  await settle();
  assert.equal(f.calls.states, 2);
  assert.equal(f.api.label(), 'Buffered playback · Natural pitch.');
  f.owner.onChange(f.audio, { state: 'playing', position: 11 });
  assert.equal(f.calls.states, 2);
  await f.api.dispose();
});

test('native release completion notifies without a new transport status', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  f.owner.onChange(f.audio, { state: 'playing', position: 5 });
  const before = f.calls.states;
  f.current.rate = 0.85;
  f.state.release = deferred();
  f.api.sync(f.audio);
  f.owner.onChange(f.audio, null);
  assert.equal(f.calls.states, before);
  f.state.release.resolve({ restored: true, playing: false });
  await settle();
  assert.equal(f.calls.states, before + 1);
  assert.equal(f.calls.native, 2);
  assert.equal(f.api.label(), null);
  await f.api.dispose();
});

test('changing pitch mode updates the status while retaining playing transport state', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  for (const mode of ['natural', 'preserve', 'natural']) {
    f.current.mode = mode;
    f.state.use = deferred();
    const before = f.calls.states;
    f.api.sync(f.audio);
    f.owner.onChange(f.audio, { state: 'playing', position: 5 });
    assert.equal(f.calls.states, before + 1);
    assert.equal(f.api.label(), 'Preparing audio…');
    f.state.use.resolve();
    await settle();
    assert.equal(f.calls.states, before + 2);
    assert.equal(
      f.api.label(),
      mode === 'preserve'
        ? 'Buffered playback · Preserve key.'
        : 'Buffered playback · Natural pitch.',
    );
  }
  await f.api.dispose();
});

test('transport errors keep failure reporting and notify once per failure', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  const before = f.calls.states;
  for (const message of ['decoder failed', 'decoder failed', 'output failed']) {
    const states = f.calls.states;
    f.owner.onChange(f.audio, {
      state: 'error',
      error: new Error(message),
    });
    assert.equal(f.calls.states, states + 1);
    assert.equal(f.calls.failures.at(-1), message);
    assert.equal(f.api.label(), message);
  }
  assert.equal(f.calls.states, before + 3);
  assert.deepEqual(f.calls.failures, [
    'decoder failed',
    'decoder failed',
    'output failed',
  ]);
  await f.api.dispose();
});

test('aborted transport notifications do not report failures but retain status changes', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  const before = f.calls.states;
  for (let position = 0; position < 3; position++) {
    f.owner.onChange(f.audio, {
      state: 'error',
      error: new DOMException('Playback changed', 'AbortError'),
      position,
    });
  }
  assert.equal(f.calls.states, before + 1);
  assert.deepEqual(f.calls.failures, []);
  assert.equal(f.api.label(), 'Buffered playback · Natural pitch.');
  await f.api.dispose();
});

test('failed setup and successful retry notify without waiting for a status transition', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.state.use = deferred();
  f.api.sync(f.audio);
  f.state.use.reject(new Error('setup failed'));
  await settle();
  assert.equal(f.calls.states, 1);
  assert.equal(f.api.label(), 'setup failed');
  f.state.use = deferred();
  const playing = f.api.play(f.audio, f.fallback);
  await settle();
  f.owner.onChange(f.audio, { state: 'playing', position: 5 });
  assert.equal(f.calls.states, 2);
  assert.equal(f.api.label(), 'Preparing audio…');
  f.state.use.resolve();
  await playing;
  await settle();
  assert.equal(f.calls.states, 3);
  assert.equal(f.api.label(), 'Buffered playback · Natural pitch.');
  assert.deepEqual(f.calls.failures, ['setup failed', '']);
  await f.api.dispose();
});

test('stale transport snapshots and setup completion do not notify', async () => {
  for (const change of ['src', 'track', 'selection', 'dispose']) {
    const f = fixture();
    f.current.rate = 0.025;
    f.state.use = deferred();
    f.api.sync(f.audio);
    f.owner.onChange(f.audio, { state: 'playing', position: 5 });
    const before = f.calls.states;
    if (change === 'src') f.audio._src = 'blob:two';
    else if (change === 'track') f.current.track = '/artist/two';
    else if (change === 'selection') f.api.select(new f.audio.constructor());
    else await f.api.dispose();
    f.owner.onChange(f.audio, {
      state: 'error',
      error: new Error('stale failure'),
    });
    f.state.use.resolve();
    await settle();
    assert.equal(f.calls.states, before, change);
    assert.deepEqual(f.calls.failures, [], change);
    await f.api.dispose();
  }
});

test('a timeline containing a future low point acquires once with the full rate function', async () => {
  const f = fixture();
  const rateAt = (time) => (time < 10 ? 1 : 0.025);
  f.current.schedule = { rateAt, minimumRate: 0.025 };
  assert.equal(f.api.sync(f.audio), true);
  await settle();
  f.current.rate = 0.5;
  assert.equal(f.api.sync(f.audio), true);
  assert.equal(f.calls.uses.length, 1);
  assert.equal(f.calls.uses[0].rate, rateAt);
  await f.api.dispose();
});

test('native handoff resumes once at the requested native settings', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  f.audio.paused = false;
  f.current.rate = 0.85;
  assert.equal(f.api.sync(f.audio), true);
  await settle();
  assert.equal(f.calls.native, 2);
  assert.equal(f.audio.plays, 1);
  assert.equal(f.api.sync(f.audio), false);
  await f.api.dispose();
});

test('pause during native handoff prevents the captured playing intent from restarting audio', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  f.audio.paused = false;
  f.state.release = deferred();
  f.current.rate = 1;
  f.api.sync(f.audio);
  f.api.pause(f.audio);
  f.state.release.resolve({ restored: true, playing: true });
  await settle();
  assert.equal(f.audio.plays, 0);
  assert.equal(f.calls.native, 2);
  await f.api.dispose();
});

test('explicit play during handoff does not duplicate the automatic native resume', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  f.audio.paused = false;
  f.state.release = deferred();
  f.current.rate = 1;
  f.api.sync(f.audio);
  const playing = f.api.play(f.audio, f.fallback);
  f.state.release.resolve({ restored: true, playing: true });
  await playing;
  assert.equal(f.audio.plays, 1);
  await f.api.dispose();
});

test('source or track changes cancel a pending native resume', async () => {
  for (const change of ['src', 'track']) {
    const f = fixture();
    f.current.rate = 0.025;
    f.api.sync(f.audio);
    await settle();
    f.audio.paused = false;
    f.state.release = deferred();
    f.current.rate = 1;
    f.api.sync(f.audio);
    if (change === 'src') f.audio._src = 'blob:two';
    else f.current.track = '/artist/two';
    f.state.release.resolve({ restored: true, playing: true });
    await settle();
    assert.equal(f.audio.plays, 0);
    assert.equal(f.calls.native, 0);
    await f.api.dispose();
  }
});

test('unsupported low-rate preservation pauses instead of silently using native 1x', async () => {
  const f = fixture();
  Object.assign(f.current, { rate: 0.025, mode: 'preserve', wasm: false });
  f.audio.paused = false;
  assert.equal(f.api.sync(f.audio), true);
  await settle();
  await assert.rejects(f.api.play(f.audio, f.fallback), /Enable WASM/);
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.plays, 0);
  assert.equal(f.calls.uses.length, 0);
  await f.api.dispose();
});

test('graph availability retries a previously blocked low-rate activation', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.state.graph = false;
  f.api.sync(f.audio);
  await settle();
  assert.equal(f.calls.uses.length, 0);
  f.state.graph = true;
  f.api.graphReady(f.audio);
  await settle();
  assert.equal(f.calls.uses.length, 1);
  await f.api.dispose();
});

test('source association waits for proof, times out, and removes aborted listeners', async () => {
  const f = fixture();
  f.state.source = { status: 'unbound', sourceId: 1 };
  const controller = new AbortController();
  const resolving = f.owner.resolveSource(f.audio, {
    signal: controller.signal,
  });
  assert.equal(f.tasks.size, 1);
  const proved = {
    status: 'bound',
    sourceId: 1,
    playlistUrl: 'https://test.sndcdn.com/one.m3u8',
  };
  f.binding.onChange(f.audio, proved);
  assert.equal(await resolving, proved);
  assert.equal(f.tasks.size, 0);
  const aborted = f.owner.resolveSource(f.audio, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal(f.tasks.size, 0);
  const timeout = f.owner.resolveSource(f.audio, {
    signal: new AbortController().signal,
  });
  [...f.tasks.values()][0]();
  await assert.rejects(timeout, /Track audio is not available/);
  assert.equal(f.tasks.size, 0);
  await f.api.dispose();
});

test('track changes invalidate old source proof and release without restoring old audio', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  f.api.changeTrack('/artist/track', '/artist/two');
  assert.deepEqual(f.calls.invalidations, [f.audio]);
  assert.equal(f.calls.releases.at(-1).restore, false);
  await f.api.dispose();
});

test('engine assembly is lazy, mode-aware, abortable and cleans up partial allocation', async () => {
  const f = fixture();
  const controller = new AbortController();
  const input = {
    context: {},
    destination: {},
    source: f.state.source,
    signal: controller.signal,
  };
  assert.equal(f.calls.dependencies, 0);
  const natural = await f.owner.createEngine({ ...input, mode: 'natural' });
  const preserve = await f.owner.createEngine({ ...input, mode: 'preserve' });
  assert.equal(natural.output.kind, 'natural');
  assert.equal(preserve.output.kind, 'preserve');
  f.modules.createNaturalOutput = () => {
    throw new Error('allocation failed');
  };
  await assert.rejects(
    f.owner.createEngine({ ...input, mode: 'natural' }),
    /allocation failed/,
  );
  assert.ok(f.calls.disposals.includes('window'));
  controller.abort();
  await assert.rejects(f.owner.createEngine({ ...input, mode: 'natural' }), {
    name: 'AbortError',
  });
  await f.api.dispose();
});

test('unselected old and preloaded media cannot consume buffered ownership or source slots', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  const old = Array.from({ length: 20 }, () => new f.audio.constructor());
  for (const audio of old) assert.equal(f.api.sync(audio), true);
  assert.equal(f.calls.uses.length, 0);
  assert.equal(f.calls.sourceMedia.length, 0);
  f.api.sync(f.audio);
  await settle();
  assert.deepEqual(f.calls.useMedia, [f.audio]);
  f.api.select(old[0]);
  f.api.sync(old[0]);
  await settle();
  assert.deepEqual(f.calls.useMedia, [f.audio, old[0]]);
  assert.deepEqual(f.calls.releasedMedia, [f.audio]);
  assert.equal(f.calls.releases.at(-1).restore, false);
  await f.api.dispose();
});

test('explicit Play retries a failed owned engine through release and recreation only once', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  f.owner.onChange(f.audio, {
    state: 'error',
    error: new Error('decoder failed'),
  });
  assert.match(f.api.label(), /decoder failed/);
  for (let index = 0; index < 100; index++) f.api.sync(f.audio);
  assert.equal(f.calls.uses.length, 1);
  await f.api.play(f.audio, f.fallback);
  await settle();
  assert.equal(f.calls.uses.length, 2);
  assert.equal(f.calls.releases.length, 1);
  assert.equal(f.audio.plays, 1);
  assert.equal(f.calls.failures.at(-1), '');
  await f.api.dispose();
});

test('a pause during explicit error recovery cancels replay before another engine starts', async () => {
  const f = fixture();
  f.current.rate = 0.025;
  f.api.sync(f.audio);
  await settle();
  f.owner.onChange(f.audio, {
    state: 'error',
    error: new Error('decoder failed'),
  });
  f.state.release = deferred();
  const playing = assert.rejects(f.api.play(f.audio, f.fallback), {
    name: 'AbortError',
  });
  f.api.pause(f.audio);
  f.state.release.resolve({ restored: true, playing: false });
  await playing;
  assert.equal(f.calls.uses.length, 1);
  assert.equal(f.audio.plays, 0);
  await f.api.dispose();
});
