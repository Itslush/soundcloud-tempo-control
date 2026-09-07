import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaFacade } from '../src/audio/media-facade.mjs';
import { createBufferedTransport } from '../src/audio/buffered-transport.mjs';

const tick = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

function realTransport(f) {
  const context = {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running',
    async resume() {
      this.state = 'running';
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const timers = new Map();
  const scheduled = [];
  let timer = 0;
  const transport = createBufferedTransport({
    context,
    rate: 1,
    timers: {
      setTimeout(callback) {
        timers.set(++timer, callback);
        return timer;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    provider: {
      async info() {
        return { sampleRate: 44100, channels: 2, durationHint: 1 };
      },
      async acquire(start, end) {
        const first = Math.min(start, 17003);
        const last = Math.min(end, 17003);
        return {
          sampleRate: 44100,
          pcmStartFrame: first,
          totalSourceFrames: 17003,
          channels: [
            new Float32Array(last - first),
            new Float32Array(last - first),
          ],
          release() {},
        };
      },
      reset() {},
      dispose() {},
    },
    output: {
      schedule({ clock, totalSourceFrames }) {
        const sourceEndFrame = Math.min(
          clock.sourceEndFrame,
          totalSourceFrames,
        );
        const window = {
          sourceStartFrame: clock.sourceStartFrame,
          sourceEndFrame,
          outputStartFrame: clock.outputStartFrame,
          outputEndFrame: clock.outputAt(sourceEndFrame),
        };
        scheduled.push(window);
        return window;
      },
      truncate() {},
      reset() {},
      dispose() {},
    },
    onChange: (state) => f.binding.update(state),
  });
  Object.assign(f.transport, transport);
  f.binding.update(transport.snapshot());
  return {
    transport,
    scheduled,
    async advance(time) {
      context.currentTime = time;
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
      for (let index = 0; index < 50; index++) await Promise.resolve();
      f.flush();
    },
  };
}

test('real transport EOF replay resolves the new media Play promise', async (t) => {
  const f = fixture();
  const engine = realTransport(f);
  t.after(() => f.facade.dispose());
  const first = f.audio.play();
  await engine.advance(0);
  await engine.advance(0.1);
  await first;
  const end = engine.scheduled.at(-1).outputEndFrame / 48000;
  await engine.advance(end + 0.001);
  assert.equal(f.audio.ended, true);
  assert.equal(f.audio.paused, true);
  const count = engine.scheduled.length;
  let outcome;
  const replay = f.audio.play().then(
    () => (outcome = { status: 'fulfilled' }),
    (error) => (outcome = { status: 'rejected', error }),
  );
  await engine.advance(end + 0.001);
  await engine.advance(end + 0.2);
  await replay;
  assert.equal(engine.scheduled[count].sourceStartFrame, 0);
  assert.equal(f.audio.ended, false);
  assert.equal(f.audio.paused, false);
  assert.ok(f.audio.currentTime > 0);
  assert.equal(outcome.status, 'fulfilled', outcome.error?.stack);
  assert.deepEqual(f.errors, []);
});

function fixture({ rates = false, requestedRate } = {}) {
  const values = new WeakMap();
  class Media extends EventTarget {
    constructor() {
      super();
      values.set(this, {
        currentTime: 4,
        duration: 90,
        paused: true,
        ended: false,
        seeking: false,
        readyState: 4,
        networkState: 1,
        src: 'original',
        currentSrc: 'original',
        srcObject: null,
        ...(rates ? { playbackRate: 1, defaultPlaybackRate: 1 } : {}),
      });
      this.calls = [];
    }
    play() {
      this.calls.push('play');
      values.get(this).paused = false;
      return Promise.resolve();
    }
    pause() {
      this.calls.push('pause');
      values.get(this).paused = true;
    }
    fastSeek(value) {
      this.calls.push(['fastSeek', value]);
      values.get(this).currentTime = value;
    }
    load() {
      this.calls.push('load');
    }
  }
  for (const key of Object.keys(values.get(new Media())))
    Object.defineProperty(Media.prototype, key, {
      configurable: true,
      enumerable: true,
      get() {
        return values.get(this)[key];
      },
      ...([
        'currentTime',
        'src',
        'srcObject',
        'playbackRate',
        'defaultPlaybackRate',
      ].includes(key)
        ? {
            set(value) {
              values.get(this)[key] = value;
            },
          }
        : {}),
    });
  const original = Object.getOwnPropertyDescriptors(Media.prototype);
  const queue = [];
  const errors = [];
  const facade = createMediaFacade({
    prototype: Media.prototype,
    enqueue: (callback) => queue.push(callback),
    onError: (error) => errors.push(error),
  });
  let state = {
    state: 'paused',
    position: 10,
    duration: null,
    durationHint: null,
    paused: true,
    ended: false,
    sampleRate: null,
    scheduledWindows: 0,
    error: null,
    ...(requestedRate === undefined ? {} : { requestedRate }),
  };
  const calls = [];
  let binding;
  let playGate;
  let seekGate;
  const publish = (changes) => {
    state = { ...state, ...changes };
    binding?.update(state);
  };
  const transport = {
    snapshot: () => state,
    play() {
      calls.push('play');
      publish({ paused: false, state: 'buffering', ended: false });
      return playGate ?? Promise.resolve(state);
    },
    pause() {
      calls.push('pause');
      publish({ paused: true, state: 'paused' });
      return state;
    },
    seek(position) {
      calls.push(['seek', position]);
      publish({ position });
      return seekGate ?? Promise.resolve(state);
    },
    dispose() {
      calls.push('dispose');
      return Promise.resolve();
    },
  };
  const audio = new Media();
  const events = [];
  const detached = [];
  binding = facade.bind(audio, {
    transport,
    onDetach: (detail) => detached.push(detail),
  });
  for (const name of [
    'play',
    'playing',
    'pause',
    'seeking',
    'seeked',
    'waiting',
    'timeupdate',
    'ended',
    'durationchange',
    'error',
    'ratechange',
  ])
    audio.addEventListener(name, () => events.push(name));
  return {
    Media,
    facade,
    audio,
    binding,
    transport,
    events,
    errors,
    queue,
    calls,
    detached,
    original,
    publish,
    set playGate(value) {
      playGate = value;
    },
    set seekGate(value) {
      seekGate = value;
    },
    setState(changes) {
      state = { ...state, ...changes };
    },
    setNative(changes) {
      Object.assign(values.get(audio), changes);
    },
    flush() {
      let count = 0;
      while (queue.length) {
        if (++count > 100) throw new Error('Event loop');
        queue.shift()();
      }
    },
  };
}

test('owned reads use the transport clock and untouched media keep their native methods', async () => {
  const f = fixture();
  assert.equal(f.audio.currentTime, 10);
  assert.equal(f.audio.duration, 90);
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.readyState, 0);
  f.setState({
    position: 25.5,
    durationHint: 120,
    sampleRate: 44100,
    state: 'playing',
    paused: false,
    scheduledWindows: 2,
  });
  assert.equal(f.audio.currentTime, 25.5);
  assert.equal(f.audio.duration, 120);
  assert.equal(f.audio.paused, false);
  assert.equal(f.audio.readyState, 3);
  const other = new f.Media();
  await other.play();
  other.currentTime = 9;
  other.pause();
  other.fastSeek(5);
  assert.deepEqual(other.calls, ['play', 'pause', ['fastSeek', 5]]);
  assert.equal(other.currentTime, 5);
  assert.deepEqual(f.audio.calls, []);
  await f.facade.dispose();
});

test('owned rate getters retain exact requested values before and during rendering', async () => {
  const f = fixture({ rates: true, requestedRate: 0.025 });
  assert.equal(f.audio.playbackRate, 0.025);
  assert.equal(f.audio.defaultPlaybackRate, 0.025);
  assert.equal(f.original.playbackRate.get.call(f.audio), 1);
  f.publish({ state: 'buffering', paused: false, renderedRate: null });
  assert.equal(f.audio.playbackRate, 0.025);
  f.publish({
    state: 'playing',
    requestedRate: 0.1,
    renderedRate: Math.fround(0.025),
  });
  assert.equal(f.audio.playbackRate, 0.1);
  assert.equal(f.audio.defaultPlaybackRate, 0.1);
  const precise = 0.123456789012345;
  f.publish({
    state: 'paused',
    paused: true,
    requestedRate: precise,
    renderedRate: null,
  });
  assert.equal(f.audio.playbackRate, precise);
  assert.equal(f.audio.defaultPlaybackRate, precise);
  const other = new f.Media();
  other.playbackRate = 1.5;
  other.defaultPlaybackRate = 0.8;
  assert.equal(other.playbackRate, 1.5);
  assert.equal(other.defaultPlaybackRate, 0.8);
  await f.binding.release();
  assert.equal(f.audio.playbackRate, 1);
  assert.equal(f.audio.defaultPlaybackRate, 1);
  await f.facade.dispose();
  assert.equal(
    Object.getOwnPropertyDescriptor(f.Media.prototype, 'playbackRate').get,
    f.original.playbackRate.get,
  );
});

test('logical rate changes use one owned event per queued update batch', async () => {
  const f = fixture({ rates: true, requestedRate: 0.025 });
  const observed = [];
  f.audio.addEventListener('ratechange', () =>
    observed.push(f.audio.playbackRate),
  );
  f.flush();
  assert.deepEqual(observed, [0.025]);
  f.events.length = 0;
  f.publish({ requestedRate: 0.05 });
  f.publish({ requestedRate: 0.1 });
  f.publish({ requestedRate: 0.1 });
  f.audio.dispatchEvent(new Event('ratechange'));
  assert.deepEqual(f.events, []);
  f.flush();
  assert.deepEqual(f.events, ['ratechange']);
  assert.deepEqual(observed, [0.025, 0.1]);
  f.publish({ requestedRate: 0.1 });
  f.flush();
  assert.deepEqual(observed, [0.025, 0.1]);
  f.publish({ requestedRate: 0.2 });
  f.flush();
  assert.deepEqual(observed, [0.025, 0.1, 0.2]);
  await f.facade.dispose();
});

test('detaching ownership cancels queued logical rate changes', async () => {
  const f = fixture({ rates: true, requestedRate: 1 });
  f.publish({ requestedRate: 0.025 });
  await f.binding.release();
  f.flush();
  assert.deepEqual(f.events, []);
  assert.equal(f.audio.playbackRate, 1);
  await f.facade.dispose();
});

test('optional logical rates preserve legacy native reads and validate supplied rates', async () => {
  const f = fixture({ rates: true });
  f.original.playbackRate.set.call(f.audio, 0.85);
  assert.equal(f.audio.playbackRate, 0.85);
  assert.equal(f.audio.defaultPlaybackRate, 1);
  for (const requestedRate of [NaN, Infinity, 0.024, 4.001]) {
    f.setState({ requestedRate });
    assert.throws(() => f.audio.playbackRate, /Invalid transport snapshot/);
  }
  f.setState({ requestedRate: 0.025 });
  await f.facade.dispose();
});

test('Play resolves after the playing event, not merely when PCM was queued', async () => {
  const f = fixture();
  let settled = false;
  const playing = f.audio.play().then(() => {
    settled = true;
    f.events.push('resolved');
  });
  await tick();
  f.flush();
  assert.equal(settled, false);
  assert.deepEqual(f.events, ['play']);
  f.publish({ state: 'playing', sampleRate: 44100, scheduledWindows: 3 });
  assert.equal(settled, false);
  f.flush();
  await playing;
  assert.deepEqual(f.events, ['play', 'playing', 'resolved']);
  assert.deepEqual(f.audio.calls, []);
  await f.facade.dispose();
});

test('pause cancels pending Play and replay gets a fresh independently settled promise', async () => {
  const f = fixture();
  const old = f.audio.play();
  assert.equal(f.audio.play(), old);
  const rejected = assert.rejects(old, { name: 'AbortError' });
  f.audio.pause();
  const next = f.audio.play();
  assert.notEqual(next, old);
  f.publish({ state: 'playing' });
  f.flush();
  await Promise.all([rejected, next]);
  assert.deepEqual(f.calls.slice(0, 3), ['play', 'pause', 'play']);
  await f.facade.dispose();
});

test('seeks publish seeking and seeked and only the latest completion may settle', async () => {
  const f = fixture();
  let finishOld;
  f.seekGate = new Promise((resolve) => {
    finishOld = resolve;
  });
  f.audio.currentTime = 15.25;
  assert.equal(f.audio.currentTime, 15.25);
  assert.equal(f.audio.seeking, true);
  f.seekGate = null;
  f.audio.fastSeek(30.125);
  await tick();
  f.flush();
  assert.equal(f.audio.seeking, false);
  assert.deepEqual(f.calls, [
    ['seek', 15.25],
    ['seek', 30.125],
  ]);
  assert.equal(f.events.filter((name) => name === 'seeked').length, 1);
  finishOld();
  await tick();
  f.flush();
  assert.equal(f.events.filter((name) => name === 'seeked').length, 1);
  assert.throws(() => {
    f.audio.currentTime = NaN;
  }, /finite/);
  f.audio.currentTime = -1;
  assert.equal(f.audio.currentTime, 0);
  await f.facade.dispose();
});

test('reading duration cannot swallow a later state transition', async () => {
  const f = fixture();
  const playing = f.audio.play();
  f.flush();
  f.setState({ state: 'playing', position: 10.2, durationHint: 182 });
  assert.equal(f.audio.duration, 182);
  f.publish({});
  f.flush();
  await playing;
  assert.equal(f.events.filter((name) => name === 'playing').length, 1);
  f.publish({ state: 'buffering' });
  f.flush();
  assert.equal(f.events.at(-1), 'waiting');
  await f.facade.dispose();
});

test('source replacement detaches synchronously, drops queued events and disposes the old transport', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.audio.play(), { name: 'AbortError' });
  f.audio.src = 'replacement';
  assert.equal(f.facade.owns(f.audio), false);
  assert.equal(f.binding.active, false);
  assert.equal(f.audio.src, 'replacement');
  assert.equal(f.audio.currentTime, 4);
  assert.equal(f.detached[0].reason, 'source-change');
  f.publish({ state: 'playing', paused: false });
  f.flush();
  assert.deepEqual(f.events, []);
  await rejected;
  await f.facade.dispose();
});

test('queued loadstart for the bound source preserves pending Play and Seek', async () => {
  for (const currentSrc of ['', 'previous', 'original']) {
    const f = fixture();
    const result = f.audio.play().then(
      () => null,
      (error) => error,
    );
    try {
      f.audio.currentTime = 0;
      f.setNative({ currentSrc });
      f.audio.dispatchEvent(new Event('loadstart'));
      assert.equal(f.binding.active, true, 'loadstart released the new source');
      assert.equal(f.calls.includes('dispose'), false);
      f.publish({ state: 'playing', paused: false });
      await tick();
      f.flush();
      assert.equal(await result, null);
      assert.equal(f.audio.paused, false);
      assert.deepEqual(f.audio.calls, []);
    } finally {
      await f.facade.dispose();
    }
  }
});

test('load and raw source-change events release ownership without seeking native playback', async () => {
  for (const action of ['load', 'emptied', 'loadstart', 'srcObject']) {
    const f = fixture();
    if (action === 'load') f.audio.load();
    else if (action === 'srcObject') f.audio.srcObject = {};
    else {
      f.setNative({ src: 'replacement', currentSrc: 'replacement' });
      f.audio.dispatchEvent(new Event(action));
    }
    assert.equal(f.facade.owns(f.audio), false);
    assert.ok(f.calls.includes('dispose'));
    assert.equal(f.audio.currentTime, 4);
    assert.deepEqual(f.audio.calls, action === 'load' ? ['load'] : []);
    await f.facade.dispose();
  }
});

test('emptied still cancels ownership when an attribute reload keeps the same URL', async () => {
  const f = fixture();
  f.setNative({ currentSrc: '' });
  f.audio.dispatchEvent(new Event('emptied'));
  assert.equal(f.binding.active, false);
  f.setNative({ currentSrc: 'original' });
  f.audio.dispatchEvent(new Event('loadstart'));
  assert.equal(f.binding.active, false);
  assert.equal(f.calls.filter((name) => name === 'dispose').length, 1);
  await f.facade.dispose();
});

test('source events detect unwrapped srcObject and child-source replacement', async () => {
  for (const kind of ['srcObject', 'currentSrc']) {
    const f = fixture();
    await f.binding.release();
    f.setNative({ src: '', currentSrc: 'first-child', srcObject: null });
    const binding = f.facade.bind(f.audio, { transport: f.transport });
    f.audio.dispatchEvent(new Event('loadstart'));
    assert.equal(binding.active, true);
    f.setNative({ [kind]: kind === 'srcObject' ? {} : 'second-child' });
    f.audio.dispatchEvent(new Event('loadstart'));
    assert.equal(binding.active, false);
    await f.facade.dispose();
  }
});

test('explicit same-source assignment and load still cancel ownership immediately', async () => {
  for (const action of ['src', 'srcObject', 'load']) {
    const f = fixture();
    if (action === 'load') f.audio.load();
    else f.audio[action] = f.audio[action];
    assert.equal(f.binding.active, false);
    assert.equal(f.calls.filter((name) => name === 'dispose').length, 1);
    await f.facade.dispose();
  }
});

test('parked native playback events are suppressed but bridge events remain visible', async () => {
  const f = fixture();
  for (const type of ['pause', 'playing', 'timeupdate', 'ended'])
    f.audio.dispatchEvent(new Event(type));
  assert.deepEqual(f.events, []);
  f.publish({ state: 'ended', ended: true, position: 90 });
  f.flush();
  assert.equal(f.events.filter((name) => name === 'ended').length, 1);
  f.publish({});
  f.flush();
  assert.equal(f.events.filter((name) => name === 'ended').length, 1);
  await f.facade.dispose();
});

test('idle repeated updates create no event tasks', async () => {
  const f = fixture();
  for (let index = 0; index < 1000; index++) f.publish({});
  assert.equal(f.queue.length, 0);
  await f.facade.dispose();
});

test('dispose restores only its own descriptors and reports all owner cleanup failures', async () => {
  const f = fixture();
  const replacement = function () {};
  Object.defineProperty(f.Media.prototype, 'play', {
    configurable: true,
    value: replacement,
  });
  f.transport.dispose = () => {
    throw new Error('Cleanup failed');
  };
  await assert.rejects(f.facade.dispose(), /cleanup failed/);
  assert.equal(f.Media.prototype.play, replacement);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(f.Media.prototype, 'currentTime'),
    f.original.currentTime,
  );
  assert.equal(f.binding.active, false);
  assert.equal(f.facade.owns(f.audio), false);
});

test('facade disposal joins already detached owners and cannot resolve early', async () => {
  const f = fixture();
  let finish;
  f.transport.dispose = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const released = f.binding.release();
  let done = false;
  const disposal = f.facade.dispose();
  assert.equal(f.facade.dispose(), disposal);
  disposal.then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  finish();
  await Promise.all([released, disposal]);
  assert.equal(done, true);
});

test('a broken snapshot does not prevent output disposal or descriptor restoration', async () => {
  const f = fixture();
  f.transport.snapshot = () => {
    throw new Error('Clock failed');
  };
  await assert.rejects(f.facade.dispose(), /cleanup failed/);
  assert.ok(f.calls.includes('dispose'));
  assert.equal(f.facade.owns(f.audio), false);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(f.Media.prototype, 'currentTime'),
    f.original.currentTime,
  );
});

test('disposal rejects reentrant ownership before invoking cleanup callbacks', async () => {
  const f = fixture();
  const other = new f.Media();
  let attempted = false;
  f.facade.bind(other, {
    transport: f.transport,
    onDetach() {
      attempted = true;
      assert.throws(
        () => f.facade.bind(new f.Media(), { transport: f.transport }),
        /disposed/,
      );
    },
  });
  await f.facade.dispose();
  assert.equal(attempted, true);
  assert.equal(f.facade.owns(other), false);
  assert.equal(f.calls.filter((name) => name === 'dispose').length, 2);
});

test('reentrant facade disposal joins the owner already inside its detach callback', async () => {
  const f = fixture();
  await f.binding.release();
  let finish;
  let disposal;
  f.transport.dispose = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const binding = f.facade.bind(f.audio, {
    transport: f.transport,
    onDetach() {
      disposal = f.facade.dispose();
      assert.equal(f.facade.dispose(), disposal);
      return disposal;
    },
  });
  const release = binding.release();
  let done = false;
  disposal.then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  finish();
  await Promise.all([release, disposal]);
  assert.equal(done, true);
});

test('reentrant binding release returns its existing cleanup promise', async () => {
  const f = fixture();
  await f.binding.release();
  let nested;
  const binding = f.facade.bind(f.audio, {
    transport: f.transport,
    onDetach() {
      nested = binding.release();
      return nested;
    },
  });
  const release = binding.release();
  assert.equal(nested, release);
  await release;
  await f.facade.dispose();
});
