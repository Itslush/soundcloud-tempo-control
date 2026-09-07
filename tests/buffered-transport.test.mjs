import assert from 'node:assert/strict';
import test from 'node:test';
import { createBufferedTransport } from '../src/audio/buffered-transport.mjs';

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

function fixture(options = {}) {
  const listeners = new Set();
  const tasks = new Map();
  let nextTask = 0;
  const context = {
    sampleRate: options.outputRate ?? 48000,
    currentTime: 0,
    state: 'running',
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    async resume() {
      this.state = 'running';
    },
  };
  const timers = {
    setTimeout(callback) {
      const id = ++nextTask;
      tasks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
  };
  const sourceRate = options.sourceRate ?? 44100;
  const state = {
    reads: [],
    leases: 0,
    resets: 0,
    disposed: 0,
    inFlight: 0,
    peakInFlight: 0,
  };
  const provider = {
    async info() {
      return {
        sampleRate: sourceRate,
        channels: 2,
        durationHint: options.durationHint ?? 1,
      };
    },
    async acquire(start, end, { signal }) {
      state.inFlight++;
      state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
      state.reads.push([start, end]);
      try {
        await options.onAcquire?.({ start, end, signal, context });
        if (signal.aborted && !options.ignoreAbort)
          throw new DOMException('Aborted', 'AbortError');
        const total = options.totalSourceFrames;
        const from = total === undefined ? start : Math.min(start, total);
        const to = total === undefined ? end : Math.min(end, total);
        state.leases++;
        let released = false;
        return {
          sampleRate: sourceRate,
          pcmStartFrame: from,
          channels: [new Float32Array(to - from), new Float32Array(to - from)],
          ...(total === undefined ? {} : { totalSourceFrames: total }),
          release() {
            assert.equal(released, false);
            released = true;
            state.leases--;
          },
        };
      } finally {
        state.inFlight--;
      }
    },
    async reset() {
      state.resets++;
    },
    async dispose() {
      state.disposed++;
    },
  };
  const scheduled = [];
  const cuts = [];
  const output = {
    resets: 0,
    disposed: 0,
    schedule({ clock, ...lease }) {
      assert.equal(state.leases, 1);
      assert.equal(lease.sampleRate, sourceRate);
      const sourceEndFrame = Math.min(
        clock.sourceEndFrame,
        lease.totalSourceFrames ?? Infinity,
      );
      const record = {
        clock,
        sourceStartFrame: clock.sourceStartFrame,
        sourceEndFrame,
        outputStartFrame: clock.outputStartFrame,
        outputEndFrame: clock.outputAt(sourceEndFrame),
      };
      scheduled.push(record);
      return record;
    },
    truncate(frame) {
      cuts.push(frame);
    },
    reset() {
      this.resets++;
    },
    dispose() {
      this.disposed++;
    },
  };
  const changes = [];
  Object.assign(output, options.output);
  const transport = createBufferedTransport({
    context,
    provider,
    output,
    timers,
    rate: options.rate ?? 1,
    initialPosition: options.initialPosition,
    initiallyEnded: options.initiallyEnded,
    onChange: options.onChange ?? ((state) => changes.push(state)),
  });
  return {
    transport,
    context,
    provider,
    output,
    state,
    tasks,
    scheduled,
    cuts,
    changes,
    listeners,
    async tick(time) {
      context.currentTime = time;
      for (const [id, callback] of [...tasks]) {
        tasks.delete(id);
        callback();
      }
      await settle();
    },
    changeState(value) {
      context.state = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

test('initial state validates before allocation and preserves a lazy ended position', async () => {
  for (const initialPosition of [-1, NaN, Infinity, 86400])
    assert.throws(() => fixture({ initialPosition }), /initial playback state/);
  assert.throws(() => fixture({ initiallyEnded: 1 }), /initial playback state/);
  const f = fixture({ initialPosition: 4, initiallyEnded: true });
  try {
    assert.equal(f.transport.snapshot().position, 4);
    assert.equal(f.transport.snapshot().ended, true);
    assert.equal(f.transport.snapshot().paused, true);
    assert.equal(f.state.reads.length, 0);
    assert.equal(f.tasks.size, 0);
  } finally {
    await f.transport.dispose();
  }
});

test('a synchronous resume failure retains EOF replay intent for retry', async () => {
  const f = fixture({ initialPosition: 4, initiallyEnded: true });
  try {
    f.context.state = 'suspended';
    f.context.resume = () => {
      throw new Error('Resume failed');
    };
    await assert.rejects(f.transport.play(), /Resume failed/);
    assert.equal(f.transport.snapshot().ended, true);
    assert.equal(f.transport.snapshot().position, 4);
    f.context.resume = async () => {
      f.context.state = 'running';
    };
    await f.transport.play();
    assert.equal(f.scheduled[0].sourceStartFrame, 0);
  } finally {
    await f.transport.dispose();
  }
});

test('uses rendered source time, with bounded lookahead and no duration-hint EOF', async () => {
  const f = fixture({ rate: 0.025, durationHint: 0.001 });
  const initial = await f.transport.play();
  assert.equal(initial.state, 'buffering');
  assert.equal(initial.position, 0);
  assert.equal(initial.duration, null);
  assert.equal(f.scheduled.length, 3);
  assert.equal(f.state.leases, 0);
  const first = f.scheduled[0];
  f.context.currentTime = first.outputStartFrame / 48000 + 0.1;
  assert.ok(
    Math.abs(f.transport.snapshot().position - Math.fround(0.025) * 0.1) <
      1e-12,
  );
  assert.equal(f.transport.snapshot().state, 'playing');
  for (let time = 0.2; time < 5; time += 0.1) {
    await f.tick(time);
    const state = f.transport.snapshot();
    assert.ok(state.scheduledWindows <= 4);
    assert.ok(state.scheduledAheadSeconds < 1.1);
    assert.notEqual(state.state, 'ended');
  }
  assert.equal(f.state.peakInFlight, 1);
  for (let index = 1; index < f.scheduled.length; index++) {
    assert.equal(
      f.scheduled[index].sourceStartFrame,
      f.scheduled[index - 1].sourceEndFrame,
    );
    assert.equal(
      f.scheduled[index].outputStartFrame,
      f.scheduled[index - 1].outputEndFrame,
    );
  }
  await f.transport.dispose();
  assert.equal(f.tasks.size, 0);
});

test('pause freezes the actual rendered position and resume starts from its fractional frame', async () => {
  const f = fixture({ rate: 0.85 });
  await f.transport.play();
  const first = f.scheduled[0];
  const frame = first.outputStartFrame + 5731;
  f.context.currentTime = frame / 48000;
  const expected = first.clock.sourceAt(frame);
  const paused = f.transport.pause();
  assert.equal(paused.sourceFrame, expected);
  assert.equal(paused.state, 'paused');
  assert.equal(f.tasks.size, 0);
  f.context.currentTime = 9;
  assert.equal(f.transport.snapshot().sourceFrame, expected);
  const before = f.scheduled.length;
  await f.transport.play();
  assert.equal(f.scheduled[before].sourceStartFrame, expected);
  assert.equal(f.state.resets, 0);
  await f.transport.dispose();
});

test('live rate changes cut future output without resetting or losing source continuity', async () => {
  const f = fixture();
  await f.transport.play();
  f.context.currentTime = 0.13;
  const first = f.scheduled[0];
  const before = f.scheduled.length;
  await f.transport.setRate(0.025);
  assert.equal(f.output.resets, 0);
  assert.equal(f.cuts.length, 1);
  const cut = f.cuts[0];
  assert.equal(f.scheduled[before].outputStartFrame, cut);
  assert.equal(f.scheduled[before].sourceStartFrame, first.clock.sourceAt(cut));
  assert.equal(f.scheduled[before].clock.intervals[0].rate, Math.fround(0.025));
  f.context.currentTime = (cut - 10) / 48000;
  assert.equal(
    f.transport.snapshot().sourceFrame,
    first.clock.sourceAt(cut - 10),
  );
  f.context.currentTime = (cut + 100) / 48000;
  assert.equal(
    f.transport.snapshot().sourceFrame,
    f.scheduled[before].clock.sourceAt(cut + 100),
  );
  assert.equal(f.state.resets, 0);
  await f.transport.dispose();
});

test('seeks discard scheduled audio, reset the provider and ignore a stale noncooperative read', async () => {
  const hold = deferred();
  let reads = 0;
  const f = fixture({
    ignoreAbort: true,
    onAcquire: async () => {
      if (++reads === 1) await hold.promise;
    },
  });
  const playing = f.transport.play();
  await settle();
  const seeking = f.transport.seek(40.125);
  assert.equal(f.transport.snapshot().lifecycle, 'SEEKING');
  assert.equal(f.transport.snapshot().position, 40.125);
  assert.equal(f.scheduled.length, 0);
  hold.resolve();
  await Promise.all([playing, seeking]);
  assert.equal(f.transport.snapshot().lifecycle, 'BUFFERING');
  assert.equal(f.scheduled[0].sourceStartFrame, 40.125 * 44100);
  assert.equal(f.state.resets, 1);
  assert.equal(f.state.leases, 0);
  assert.equal(f.state.peakInFlight, 1);
  await f.transport.dispose();
});

test('a slow read freezes source progress during the gap and resumes without skipping samples', async () => {
  const hold = deferred();
  let held = false;
  const f = fixture({
    onAcquire: async () => {
      if (held) {
        held = false;
        await hold.promise;
      }
    },
  });
  await f.transport.play();
  const tail = f.scheduled.at(-1);
  held = true;
  await f.tick(0.5);
  f.context.currentTime = 2;
  const stalled = f.transport.snapshot();
  assert.equal(stalled.state, 'buffering');
  assert.equal(stalled.sourceFrame, tail.sourceEndFrame);
  const before = f.scheduled.length;
  hold.resolve();
  await settle();
  assert.equal(f.scheduled[before].sourceStartFrame, tail.sourceEndFrame);
  assert.ok(f.scheduled[before].outputStartFrame >= 2.05 * 48000);
  await f.transport.dispose();
});

test('verified EOF truncates the final window and ends only after its scheduled audio', async () => {
  const f = fixture({ totalSourceFrames: 17003 });
  await f.transport.play();
  assert.equal(f.scheduled.length, 2);
  const last = f.scheduled.at(-1);
  assert.equal(last.sourceEndFrame, 17003);
  f.context.currentTime = (last.outputEndFrame - 1) / 48000;
  assert.equal(f.transport.snapshot().state, 'playing');
  await f.tick((last.outputEndFrame + 1) / 48000);
  assert.equal(f.transport.snapshot().state, 'ended');
  assert.equal(f.transport.snapshot().sourceFrame, 17003);
  assert.equal(f.tasks.size, 0);
  const before = f.scheduled.length;
  await f.transport.play();
  assert.equal(f.scheduled[before].sourceStartFrame, 0);
  assert.equal(f.state.resets, 1);
  await f.transport.dispose();
});

test('seeking past verified EOF clamps to the decoded end without scheduling empty PCM', async () => {
  const f = fixture({ totalSourceFrames: 5000 });
  await f.transport.play();
  await f.transport.seek(60);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.transport.snapshot().state, 'ended');
  assert.equal(f.transport.snapshot().sourceFrame, 5000);
  await f.transport.dispose();
});

test('suspended contexts stop polling and retain the source position', async () => {
  const f = fixture();
  await f.transport.play();
  f.context.currentTime = 0.1;
  const position = f.transport.snapshot().position;
  f.changeState('suspended');
  assert.equal(f.tasks.size, 0);
  assert.equal(f.transport.snapshot().state, 'suspended');
  assert.equal(f.transport.snapshot().position, position);
  f.changeState('running');
  await settle();
  assert.equal(f.transport.snapshot().state, 'playing');
  assert.equal(f.tasks.size, 1);
  await f.transport.dispose();
});

test('a paused pending play rejects and cannot schedule after its cancelled read finishes', async () => {
  const hold = deferred();
  const f = fixture({ ignoreAbort: true, onAcquire: () => hold.promise });
  const playing = f.transport.play();
  const rejected = assert.rejects(playing, { name: 'AbortError' });
  await settle();
  f.transport.pause();
  hold.resolve();
  await rejected;
  assert.equal(f.scheduled.length, 0);
  assert.equal(f.state.leases, 0);
  assert.equal(f.tasks.size, 0);
  await f.transport.dispose();
});

test('source and renderer errors enter a recoverable error state and release the PCM lease', async () => {
  const f = fixture();
  const schedule = f.output.schedule;
  f.output.schedule = () => {
    throw new Error('Output failed');
  };
  await assert.rejects(f.transport.play(), /Output failed/);
  assert.equal(f.transport.snapshot().state, 'error');
  assert.equal(f.state.leases, 0);
  assert.equal(f.tasks.size, 0);
  f.output.schedule = schedule;
  await f.transport.play();
  assert.equal(f.transport.snapshot().state, 'buffering');
  await f.transport.dispose();
});

test('invalid commands leave scheduled playback intact and observers cannot break playback', async () => {
  const f = fixture({
    onChange: () => {
      throw new Error('Observer failed');
    },
  });
  await f.transport.play();
  for (const value of [0, 0.024, 4.001, NaN, Infinity, '0.5'])
    assert.throws(() => f.transport.setRate(value), /Playback rate/);
  for (const value of [-1, NaN, Infinity, 86400])
    assert.throws(() => f.transport.seek(value), /Seek position/);
  assert.equal(f.output.resets, 0);
  assert.equal(f.cuts.length, 0);
  assert.ok(f.transport.snapshot().observerErrors > 0);
  await f.transport.dispose();
});

test('dispose waits for an outstanding lease, releases both owners and removes all timers/listeners', async () => {
  const hold = deferred();
  const f = fixture({ ignoreAbort: true, onAcquire: () => hold.promise });
  const playing = f.transport.play();
  const rejected = assert.rejects(playing, { name: 'AbortError' });
  await settle();
  const disposing = f.transport.dispose();
  assert.equal(f.transport.dispose(), disposing);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.tasks.size, 0);
  hold.resolve();
  await Promise.all([disposing, rejected]);
  assert.equal(f.output.disposed, 1);
  assert.equal(f.state.disposed, 1);
  assert.equal(f.state.leases, 0);
  assert.equal(f.scheduled.length, 0);
  assert.throws(() => f.transport.play(), /disposed/);
});

test('paused seeks clear the provider immediately without decoding or starting audio', async () => {
  const f = fixture();
  await f.transport.seek(123.456);
  assert.equal(f.state.resets, 1);
  assert.equal(f.state.reads.length, 0);
  assert.equal(f.transport.snapshot().position, 123.456);
  assert.equal(f.transport.snapshot().state, 'paused');
  await f.transport.play();
  assert.equal(f.scheduled[0].sourceStartFrame, 123.456 * 44100);
  await f.transport.dispose();
});

test('closing the shared context cancels playback and releases both owners', async () => {
  const f = fixture();
  await f.transport.play();
  f.changeState('closed');
  await settle();
  assert.equal(f.state.disposed, 1);
  assert.equal(f.output.disposed, 1);
  assert.equal(f.tasks.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.transport.snapshot().state, 'disposed');
  assert.equal(f.transport.snapshot().lifecycle, 'DISPOSED');
  assert.match(f.transport.snapshot().error.message, /context is closed/);
});

test('rapid rate changes and multiple pending seeks coalesce to the final command', async () => {
  const hold = deferred();
  let first = true;
  const f = fixture({
    onAcquire: async () => {
      if (first) {
        first = false;
        await hold.promise;
      }
    },
  });
  const playing = f.transport.play();
  await settle();
  const commands = [];
  for (let index = 1; index <= 100; index++) {
    commands.push(f.transport.seek(index));
    commands.push(f.transport.setRate(index / 100 + 0.025));
  }
  hold.resolve();
  await Promise.all([playing, ...commands]);
  assert.equal(f.state.peakInFlight, 1);
  assert.equal(f.state.resets, 1);
  assert.equal(f.scheduled[0].sourceStartFrame, 100 * 44100);
  assert.equal(f.scheduled[0].clock.intervals[0].rate, Math.fround(1.025));
  assert.equal(f.tasks.size, 1);
  await f.transport.dispose();
});

test('late reads keep the originally evaluated timeline instead of reevaluating its curve', async () => {
  let calls = 0;
  const f = fixture({
    rate: () => {
      calls++;
      return 0.85;
    },
    onAcquire: async ({ context }) => {
      context.currentTime += 0.2;
    },
  });
  await f.transport.play();
  const intervalCount = f.scheduled.reduce(
    (count, record) => count + record.clock.intervals.length,
    0,
  );
  assert.equal(calls, intervalCount + 1);
  for (let index = 1; index < f.scheduled.length; index++)
    assert.equal(
      f.scheduled[index].sourceStartFrame,
      f.scheduled[index - 1].sourceEndFrame,
    );
  await f.transport.dispose();
});

test('bad initial EOF metadata cannot leave a partially initialized transport on retry', async () => {
  const f = fixture();
  let calls = 0;
  f.provider.info = async () => {
    calls++;
    return { sampleRate: 44100, channels: 2, totalSourceFrames: NaN };
  };
  await assert.rejects(f.transport.play(), /decoded audio end/);
  await assert.rejects(f.transport.play(), /decoded audio end/);
  assert.equal(calls, 2);
  assert.equal(f.transport.snapshot().sampleRate, null);
  await f.transport.dispose();
});

test('blocked context resume is cancellable and its later rejection is handled', async () => {
  const f = fixture();
  const hold = deferred();
  f.context.state = 'suspended';
  f.context.resume = () => hold.promise;
  const playing = f.transport.play();
  const rejected = assert.rejects(playing, { name: 'AbortError' });
  await settle();
  f.transport.pause();
  await rejected;
  assert.equal(f.state.reads.length, 0);
  hold.reject(new Error('Not allowed'));
  await settle();
  assert.equal(f.transport.snapshot().state, 'paused');
  await f.transport.dispose();
});

test('changing rate inside a starvation gap preserves the previous window and its clock', async () => {
  const hold = deferred();
  let held = false;
  const f = fixture({
    onAcquire: async () => {
      if (held) {
        held = false;
        await hold.promise;
      }
    },
  });
  await f.transport.play();
  const tail = f.scheduled.at(-1);
  held = true;
  await f.tick(0.5);
  f.context.currentTime = 0.791;
  const before = f.scheduled.length;
  hold.resolve();
  await settle();
  const delayed = f.scheduled[before];
  assert.ok(delayed.outputStartFrame > tail.outputEndFrame);
  const beforeChange = f.scheduled.length;
  await f.transport.setRate(0.025);
  f.context.currentTime = 0.82;
  const state = f.transport.snapshot();
  assert.equal(state.state, 'buffering');
  assert.equal(state.sourceFrame, tail.sourceEndFrame);
  assert.equal(tail.outputEndFrame, tail.clock.outputEndFrame);
  assert.equal(f.cuts.at(-1), delayed.outputStartFrame);
  assert.equal(
    f.scheduled[beforeChange].outputStartFrame,
    delayed.outputStartFrame,
  );
  await f.transport.dispose();
  assert.equal(f.state.disposed, 1);
});

test('all concurrent Play promises reject consistently after cancellation', async () => {
  const hold = deferred();
  const f = fixture({ ignoreAbort: true, onAcquire: () => hold.promise });
  const first = assert.rejects(f.transport.play(), { name: 'AbortError' });
  const second = assert.rejects(f.transport.play(), { name: 'AbortError' });
  await settle();
  f.transport.pause();
  hold.resolve();
  await Promise.all([first, second]);
  assert.equal(f.scheduled.length, 0);
  await f.transport.dispose();
});

test('source/output rate combinations retain continuous frame mappings', async () => {
  for (const sourceRate of [8000, 44100, 48000, 96000, 192000]) {
    for (const outputRate of [44100, 48000, 96000]) {
      const f = fixture({
        sourceRate,
        outputRate,
        rate: (time) => (time < 0.02 ? 0.025 : 4),
      });
      await f.transport.play();
      for (let time = 0.2; time < 1.2; time += 0.2) await f.tick(time);
      assert.equal(f.transport.snapshot().error, null);
      for (let index = 1; index < f.scheduled.length; index++) {
        assert.equal(
          f.scheduled[index].sourceStartFrame,
          f.scheduled[index - 1].sourceEndFrame,
        );
        assert.equal(
          f.scheduled[index].outputStartFrame,
          f.scheduled[index - 1].outputEndFrame,
        );
      }
      await f.transport.dispose();
    }
  }
});

test('replay cannot resurrect a Play promise cancelled while its decoder was pending', async () => {
  const hold = deferred();
  let first = true;
  const f = fixture({
    ignoreAbort: true,
    onAcquire: async () => {
      if (first) {
        first = false;
        await hold.promise;
      }
    },
  });
  const cancelled = assert.rejects(f.transport.play(), { name: 'AbortError' });
  await settle();
  f.transport.pause();
  const replay = f.transport.play();
  hold.resolve();
  await cancelled;
  assert.equal((await replay).paused, false);
  assert.equal(f.state.peakInFlight, 1);
  await f.transport.dispose();
});

test('commands issued during state notification drain before the worker finishes', async () => {
  let triggered = false;
  let seeking;
  const f = fixture({
    onChange: (state) => {
      if (triggered || !state.scheduledWindows) return;
      triggered = true;
      f.transport.pause();
      seeking = f.transport.seek(12.5);
    },
  });
  await assert.rejects(f.transport.play(), { name: 'AbortError' });
  await seeking;
  assert.equal(f.state.resets, 1);
  assert.equal(f.transport.snapshot().state, 'paused');
  assert.equal(f.transport.snapshot().position, 12.5);
  assert.equal(f.tasks.size, 0);
  await f.transport.dispose();
});

test('nonfinite renderer clocks and synchronous resume failures cannot leave active playback', async () => {
  const f = fixture();
  const schedule = f.output.schedule;
  f.output.schedule = (input) => ({ ...schedule(input), sourceEndFrame: NaN });
  await assert.rejects(f.transport.play(), /continuity/);
  assert.equal(f.state.leases, 0);
  assert.equal(f.transport.snapshot().paused, true);
  await f.transport.dispose();
  const blocked = fixture();
  blocked.context.state = 'suspended';
  blocked.context.resume = () => {
    throw new Error('Resume failed');
  };
  await assert.rejects(blocked.transport.play(), /Resume failed/);
  assert.equal(blocked.transport.snapshot().state, 'error');
  assert.equal(blocked.transport.snapshot().paused, true);
  assert.equal(blocked.tasks.size, 0);
  await blocked.transport.dispose();
});

test('replay at each worker-completion microtask starts a fresh command instead of returning stale paused state', async () => {
  for (let gap = 0; gap < 16; gap++) {
    const f = fixture();
    f.context.state = 'suspended';
    const cancelled = assert.rejects(f.transport.play(), {
      name: 'AbortError',
    });
    f.transport.pause();
    for (let step = 0; step < gap; step++) await Promise.resolve();
    const replay = await f.transport.play();
    await cancelled;
    assert.equal(replay.paused, false, `Replay after ${gap} microtasks`);
    assert.ok(f.scheduled.length > 0);
    await f.transport.dispose();
  }
});

test('renderer initialization precedes PCM requests and supplies history and scheduling lead', async () => {
  const initialization = deferred();
  const calls = [];
  const f = fixture({
    output: {
      minimumLeadSeconds: 0.2,
      async initialize({ sourceSampleRate, signal }) {
        calls.push([sourceSampleRate, signal]);
        await initialization.promise;
      },
      requiredPcmRange(clock) {
        return {
          startFrame: Math.max(0, Math.floor(clock.sourceStartFrame) - 8192),
          endFrame: Math.ceil(clock.sourceEndFrame) + 16384,
        };
      },
    },
  });
  const playing = f.transport.play();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 44100);
  assert.equal(f.state.reads.length, 0);
  initialization.resolve();
  await playing;
  const clock = f.scheduled[0].clock;
  assert.ok(clock.outputStartFrame >= 0.2 * 48000);
  assert.deepEqual(f.state.reads[0], [
    0,
    Math.ceil(clock.sourceEndFrame) + 16384,
  ]);
  await f.transport.dispose();
});

test('async scheduling retains its PCM lease until acknowledgement and cannot revive a paused output', async () => {
  const held = deferred();
  const f = fixture();
  const schedule = f.output.schedule;
  f.output.schedule = async (input) => {
    await held.promise;
    return schedule(input);
  };
  const playing = assert.rejects(f.transport.play(), { name: 'AbortError' });
  await settle();
  assert.equal(f.state.leases, 1);
  assert.equal(f.transport.snapshot().scheduledWindows, 0);
  f.transport.pause();
  held.resolve();
  await playing;
  assert.equal(f.state.leases, 0);
  assert.equal(f.transport.snapshot().scheduledWindows, 0);
  assert.equal(f.transport.snapshot().paused, true);
  await f.transport.dispose();
});

test('rate edits serialize behind pending schedule and truncate acknowledgements', async () => {
  const scheduling = deferred();
  const truncating = deferred();
  const f = fixture({ output: { minimumLeadSeconds: 0.2 } });
  const schedule = f.output.schedule;
  let schedules = 0;
  let busy = false;
  f.output.schedule = async (input) => {
    assert.equal(busy, false);
    busy = true;
    if (++schedules === 1) await scheduling.promise;
    const result = schedule(input);
    busy = false;
    return result;
  };
  f.output.truncate = async (frame) => {
    assert.equal(busy, false);
    busy = true;
    f.cuts.push(frame);
    await truncating.promise;
    busy = false;
  };
  const playing = f.transport.play();
  await settle();
  const slower = f.transport.setRate(0.85);
  const slowest = f.transport.setRate(0.025);
  assert.equal(f.cuts.length, 0);
  scheduling.resolve();
  await settle();
  assert.equal(f.cuts.length, 1);
  assert.equal(schedules, 1);
  truncating.resolve();
  await Promise.all([playing, slower, slowest]);
  assert.equal(f.transport.snapshot().error, null);
  assert.equal(
    f.scheduled[1].sourceStartFrame,
    f.scheduled[0].clock.sourceAt(f.cuts[0]),
  );
  assert.equal(f.scheduled[1].clock.intervals[0].rate, Math.fround(0.025));
  await f.transport.dispose();
});

test('a new seek cannot decode or schedule before renderer reset acknowledgement', async () => {
  const reset = deferred();
  const f = fixture();
  await f.transport.play();
  f.output.reset = () => reset.promise;
  const reads = f.state.reads.length;
  const seeking = f.transport.seek(12);
  await settle();
  assert.equal(f.state.reads.length, reads);
  assert.equal(f.transport.snapshot().scheduledWindows, 0);
  reset.resolve();
  await seeking;
  assert.ok(f.scheduled.at(-1).sourceStartFrame >= 12 * 44100);
  await f.transport.dispose();
});

test('asynchronous renderer failures stop playback and unsubscribe on disposal', async () => {
  let publishFailure;
  let unsubscribed = false;
  const f = fixture({
    output: {
      subscribeFailure(callback) {
        publishFailure = callback;
        return () => {
          unsubscribed = true;
        };
      },
    },
  });
  await f.transport.play();
  publishFailure(new Error('Processor stopped'));
  assert.equal(f.transport.snapshot().state, 'error');
  assert.equal(f.transport.snapshot().scheduledWindows, 0);
  assert.equal(f.tasks.size, 0);
  await f.transport.dispose();
  assert.equal(unsubscribed, true);
});

test('asynchronous reset failure is reported while paused without unhandled rejection', async () => {
  const reset = deferred();
  const f = fixture();
  await f.transport.play();
  f.output.reset = () => reset.promise;
  f.transport.pause();
  reset.reject(new Error('Reset failed'));
  await settle();
  assert.equal(f.transport.snapshot().state, 'error');
  assert.match(f.transport.snapshot().error.message, /Reset failed/);
  assert.equal(f.transport.snapshot().scheduledWindows, 0);
  await f.transport.dispose();
});

test('transport disposal waits for asynchronous renderer disposal and still releases the source on failure', async () => {
  const cleanup = deferred();
  const f = fixture();
  await f.transport.play();
  f.output.dispose = () => cleanup.promise;
  let finished = false;
  const disposing = f.transport.dispose();
  const rejected = assert.rejects(disposing, /disposal failed/);
  disposing.then(
    () => {},
    () => {
      finished = true;
    },
  );
  await settle();
  assert.equal(finished, false);
  cleanup.reject(new Error('Worklet disposal failed'));
  await rejected;
  assert.equal(f.state.disposed, 1);
  assert.equal(f.state.leases, 0);
});

test('coalesced commands do not automatically retry a failed reset', async () => {
  const f = fixture();
  f.provider.reset = async () => {
    f.state.resets++;
    throw new Error('Reset unavailable');
  };
  const states = await Promise.all([
    f.transport.seek(1),
    f.transport.seek(2),
    f.transport.seek(3),
  ]);
  assert.equal(f.state.resets, 2);
  assert.ok(states.every((state) => state.state === 'error'));
  const next = await f.transport.seek(4);
  assert.equal(next.state, 'error');
  assert.equal(f.state.resets, 3);
  await f.transport.dispose();
});

test('a rate edit cannot hide an outstanding renderer scheduling failure', async () => {
  const held = deferred();
  const f = fixture();
  const schedule = f.output.schedule;
  let calls = 0;
  f.output.schedule = (input) =>
    ++calls === 1 ? held.promise : schedule(input);
  const playing = assert.rejects(f.transport.play(), /Scheduling failed/);
  await settle();
  const changing = f.transport.setRate(0.025);
  held.reject(new Error('Scheduling failed'));
  await playing;
  assert.equal((await changing).state, 'error');
  assert.equal(f.state.leases, 0);
  assert.equal(f.tasks.size, 0);
  await f.transport.dispose();
});

test('a newer rate edit cannot hide a failed truncate acknowledgement', async () => {
  const held = deferred();
  const f = fixture();
  await f.transport.play();
  let calls = 0;
  f.output.truncate = () => (++calls === 1 ? held.promise : Promise.resolve());
  const first = f.transport.setRate(0.85);
  await settle();
  const second = f.transport.setRate(0.025);
  held.reject(new Error('Truncate failed'));
  const results = await Promise.all([first, second]);
  assert.ok(results.every((state) => state.state === 'error'));
  assert.match(f.transport.snapshot().error.message, /Truncate failed/);
  assert.equal(f.transport.snapshot().scheduledWindows, 0);
  await f.transport.dispose();
});

test('the source clock freezes at a pending truncate even when acknowledgement arrives after old windows expire', async () => {
  for (const delayedTime of [0.22, 0.6, 2]) {
    const held = deferred();
    const f = fixture();
    await f.transport.play();
    f.context.currentTime = 0.1;
    f.output.truncate = (frame) => {
      f.cuts.push(frame);
      return held.promise;
    };
    const first = f.scheduled[0];
    const count = f.scheduled.length;
    const changing = f.transport.setRate(0.85);
    await settle();
    const sourceAtCut = first.clock.sourceAt(f.cuts[0]);
    f.context.currentTime = delayedTime;
    assert.equal(f.transport.snapshot().sourceFrame, sourceAtCut);
    assert.equal(f.transport.snapshot().state, 'buffering');
    held.resolve();
    await changing;
    assert.equal(f.scheduled[count].sourceStartFrame, sourceAtCut);
    assert.equal(f.transport.snapshot().sourceFrame, sourceAtCut);
    await f.transport.dispose();
  }
});

test('rendered rate follows the active output quantum rather than the latest requested speed', async () => {
  const f = fixture({ output: { minimumLeadSeconds: 0.2 } });
  await f.transport.play();
  assert.equal(f.transport.snapshot().renderedRate, null);
  f.context.currentTime = 0.3;
  assert.equal(f.transport.snapshot().renderedRate, 1);
  await f.transport.setRate(0.025);
  assert.equal(f.transport.snapshot().renderedRate, 1);
  f.context.currentTime = f.cuts[0] / 48000;
  assert.equal(f.transport.snapshot().renderedRate, Math.fround(0.025));
  f.transport.pause();
  assert.equal(f.transport.snapshot().renderedRate, null);
  await f.transport.dispose();
});
