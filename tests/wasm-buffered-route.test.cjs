const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');

const source = require('./module-fixture.cjs')(['tempo-wasm.js']);
const modulePromise = import('../src/audio/playback-gate.mjs');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
  await new Promise(setImmediate);
}

async function fixture() {
  const audioModules = await modulePromise;
  class Node extends EventTarget {
    constructor(context, kind = 'gain') {
      super();
      this.context = context;
      this.kind = kind;
      this.connections = new Set();
      this.gain = {
        value: 1,
        cancelScheduledValues() {},
        setValueAtTime(value) {
          this.value = value;
        },
        linearRampToValueAtTime(value) {
          this.value = value;
        },
      };
    }
    connect(destination) {
      this.context.trip('connect', this, destination);
      this.connections.add(destination);
      return destination;
    }
    disconnect(destination) {
      this.context.trip('disconnect', this, destination);
      if (destination) this.connections.delete(destination);
      else this.connections.clear();
    }
  }
  class Audio extends EventTarget {
    paused = false;
    seeking = false;
    plays = 0;
    play() {
      this.plays++;
      this.paused = false;
    }
  }
  class Context extends EventTarget {
    state = 'running';
    sampleRate = 48000;
    currentTime = 0;
    nodes = [];
    failure = null;
    trip(stage, from, to) {
      if (!this.failure?.(stage, from, to)) return;
      this.failure = null;
      throw new Error(`Injected ${stage} failure`);
    }
    createGain() {
      this.trip('allocate');
      const node = new Node(this);
      this.nodes.push(node);
      return node;
    }
    createMediaElementSource() {
      return new Node(this, 'source');
    }
    close() {
      this.state = 'closed';
      this.dispatchEvent(new Event('statechange'));
    }
  }
  const context = new Context();
  const audio = new Audio();
  const level = { volume: 0.8, muted: false, outputDb: -6 };
  const subscribers = new Set();
  const nodes = [];
  const warnings = [];
  const state = { enabled: false, speed: 0.5, creation: null };
  let api;
  const refresh = () => api.sync(audio, state.enabled, state.speed);
  const globals = {
    AudioContext: Context,
    AudioNode: Node,
    HTMLAudioElement: Audio,
    window: { AudioContext: Context, AudioNode: Node },
    audioModules,
    DOMException,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { warn: (...args) => warnings.push(args) },
    preservesKey: () => true,
    useWasm: true,
    bufferedAudio: null,
    references: new Set([new WeakRef(audio)]),
    discover() {},
    apply: refresh,
    updateAll: refresh,
    outputLevel: {
      readLevel(target) {
        assert.equal(target, audio);
        return { ...level };
      },
      subscribeLevel(target, callback) {
        assert.equal(target, audio);
        subscribers.add(callback);
        callback({ ...level });
        return () => subscribers.delete(callback);
      },
    },
    createStretchNode: async () => {
      const node = new Node(context, 'stretch');
      node.port = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      node.configurations = [];
      node.schedules = [];
      node.configure = async (value) => {
        node.configurations.push(value);
        if (node.configureGate) await node.configureGate.promise;
      };
      node.latency = async () => 0.12;
      node.schedule = async (value) => {
        node.schedules.push(value);
        if (value.active && node.scheduleGate) await node.scheduleGate.promise;
      };
      nodes.push(node);
      if (state.creation) await state.creation.promise;
      return node;
    },
  };
  api = vm.runInNewContext(
    source +
      '\ncreateWasmAudio({...globalThis, readUseWasm: () => useWasm, onGraphReady: audio => globalThis.bufferedAudio?.graphReady(audio)});',
    globals,
  );
  const mediaSource = context.createMediaElementSource(audio);
  const [dry, wet, input, output] = context.nodes;
  const downstream = new Node(context, 'downstream');
  const observer = new Node(context, 'observer');
  mediaSource.connect(downstream);
  mediaSource.connect(observer);
  const parks = [];
  const restores = [];
  const hooks = {
    parkNative(command) {
      parks.push(command);
      audio.paused = true;
      audio.dispatchEvent(new Event('pause'));
    },
    restoreNative(command) {
      restores.push(command);
    },
  };
  return {
    api,
    context,
    audio,
    mediaSource,
    dry,
    wet,
    input,
    output,
    downstream,
    observer,
    nodes,
    state,
    subscribers,
    level,
    warnings,
    refresh,
    hooks,
    parks,
    restores,
    setLevel(value) {
      Object.assign(level, value);
      for (const callback of [...subscribers]) callback({ ...level });
    },
  };
}

function gainTo(node, target, seen = new Set()) {
  if (node === target) return 1;
  if (seen.has(node)) throw new Error('Unexpected audio graph cycle');
  const path = new Set(seen).add(node);
  return (
    node.gain.value *
    [...node.connections].reduce(
      (sum, next) => sum + gainTo(next, target, path),
      0,
    )
  );
}

function downstreamUnchanged(f) {
  assert.deepEqual([...f.output.connections], [f.downstream, f.observer]);
}

test('the graph stays unchanged before acquisition and dry-buffered-dry preserves downstream routing', async () => {
  const f = await fixture();
  assert.equal(f.api.hasGraph(f.audio), true);
  assert.equal(f.api.hasGraph({}), false);
  assert.equal(f.context.nodes.length, 4);
  assert.deepEqual([...f.dry.connections], [f.output]);
  assert.deepEqual([...f.wet.connections], [f.output]);
  assert.equal(f.subscribers.size, 0);
  f.refresh();
  assert.equal(f.context.nodes.length, 4);
  const lease = f.api.acquireBuffered(f.audio, f.hooks);
  assert.equal(lease.context, f.context);
  assert.equal(gainTo(f.mediaSource, f.output), 0);
  assert.equal(lease.input.gain.value, 0);
  downstreamUnchanged(f);
  await lease.ready;
  assert.equal(f.parks.length, 1);
  assert.equal(lease.input.gain.value, 0.8 * 10 ** (-6 / 20));
  assert.equal(gainTo(f.mediaSource, f.output), 0);
  assert.equal(f.api.active(f.audio), false);
  const release = lease.release(12.25);
  assert.equal(lease.release(12.25), release);
  await release;
  assert.equal(f.restores[0].position, 12.25);
  assert.equal(f.audio.plays, 0);
  assert.equal(f.audio.paused, true);
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  assert.equal(lease.input.connections.size, 0);
  downstreamUnchanged(f);
  f.mediaSource.disconnect(f.observer);
  assert.deepEqual([...f.output.connections], [f.downstream]);
  f.mediaSource.connect(f.observer);
  const second = f.api.acquireBuffered(f.audio, f.hooks);
  await second.ready;
  assert.equal(f.context.nodes.length, 8);
  assert.equal(f.subscribers.size, 1);
  await second.release(undefined, { restore: false });
  assert.equal(f.restores[1].restore, false);
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  f.context.close();
  assert.equal(f.subscribers.size, 0);
});

test('buffered level scaling occurs once and changes synchronously without mutating native properties', async () => {
  const f = await fixture();
  const lease = f.api.acquireBuffered(f.audio, f.hooks);
  await lease.ready;
  assert.equal(lease.input.gain.value, 0.8 * 10 ** (-6 / 20));
  f.setLevel({ volume: 0.4, outputDb: -12 });
  assert.equal(lease.input.gain.value, 0.4 * 10 ** (-12 / 20));
  f.setLevel({ muted: true });
  assert.equal(lease.input.gain.value, 0);
  assert.equal(Object.hasOwn(f.audio, 'volume'), false);
  assert.equal(Object.hasOwn(f.audio, 'muted'), false);
  f.setLevel({ muted: false });
  await lease.release(5);
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  assert.equal(f.level.volume, 0.4);
  assert.equal(f.level.outputDb, -12);
  f.context.close();
});

test('active legacy wet processing is cleared and cannot restart during buffered ownership', async () => {
  const f = await fixture();
  f.state.enabled = true;
  f.refresh();
  await settle();
  const node = f.nodes[0];
  assert.equal(f.api.active(f.audio), true);
  const lease = f.api.acquireBuffered(f.audio, f.hooks);
  await lease.ready;
  await settle();
  assert.equal(f.api.active(f.audio), false);
  assert.equal(node.connections.size, 0);
  assert.equal(f.input.connections.size, 0);
  assert.equal(node.schedules.at(-1).active, false);
  f.audio.paused = false;
  for (let i = 0; i < 20; i++) f.api.sync(f.audio, true, 0.5 + i / 100);
  await settle();
  assert.equal(node.configurations.length, 1);
  assert.equal(node.schedules.filter((value) => value.active).length, 1);
  f.audio.paused = true;
  await lease.release(1);
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  assert.equal(f.api.active(f.audio), false);
  f.context.close();
  assert.equal(node.port.closed, true);
});

test('late legacy creation, configuration and schedule cannot reactivate the buffered route', async () => {
  for (const stage of ['creation', 'configure', 'schedule']) {
    const f = await fixture();
    const pending = deferred();
    f.state.enabled = true;
    if (stage === 'creation') f.state.creation = pending;
    f.refresh();
    const node = f.nodes[0];
    if (stage === 'configure') node.configureGate = pending;
    if (stage === 'schedule') node.scheduleGate = pending;
    await settle();
    const lease = f.api.acquireBuffered(f.audio, {
      ...f.hooks,
      parkNative() {},
    });
    await lease.ready;
    pending.resolve();
    await settle();
    assert.equal(f.api.active(f.audio), false, stage);
    assert.equal(node.connections.size, 0, stage);
    assert.equal(f.input.connections.size, 0, stage);
    assert.equal(gainTo(f.mediaSource, f.output), 0, stage);
    assert.equal(f.api.sync(f.audio, true, 0.7), false);
    f.audio.paused = true;
    await lease.release(0);
    f.context.close();
  }
});

test('allocation and native rewiring failures restore the original route without leaked subscribers', async () => {
  for (const failure of [
    'mix',
    'nativeGate',
    'bufferedInput',
    'connectDry',
    'connectWet',
    'disconnectWet',
  ]) {
    const f = await fixture();
    const allocation = { mix: 4, nativeGate: 5, bufferedInput: 6 }[failure];
    f.context.failure = (stage, from, to) =>
      (allocation !== undefined &&
        stage === 'allocate' &&
        f.context.nodes.length === allocation) ||
      (failure === 'connectDry' &&
        stage === 'connect' &&
        from === f.dry &&
        to !== f.output) ||
      (failure === 'connectWet' &&
        stage === 'connect' &&
        from === f.wet &&
        to !== f.output) ||
      (failure === 'disconnectWet' &&
        stage === 'disconnect' &&
        from === f.wet &&
        to === f.output);
    assert.throws(() => f.api.acquireBuffered(f.audio, f.hooks), /Injected/);
    await settle();
    assert.deepEqual([...f.dry.connections], [f.output], failure);
    assert.deepEqual([...f.wet.connections], [f.output], failure);
    assert.equal(gainTo(f.mediaSource, f.output), 1, failure);
    assert.equal(f.subscribers.size, 0, failure);
    assert.equal(f.parks.length, 0, failure);
    downstreamUnchanged(f);
    const lease = f.api.acquireBuffered(f.audio, f.hooks);
    await lease.ready;
    await lease.release(0);
    f.context.close();
  }
});

test('failed asynchronous parking retains silent ownership until explicit restoration', async () => {
  const f = await fixture();
  const lease = f.api.acquireBuffered(f.audio, {
    ...f.hooks,
    parkNative() {
      throw new Error('Park failed');
    },
  });
  await assert.rejects(lease.ready, /Park failed/);
  assert.equal(gainTo(f.mediaSource, f.output), 0);
  assert.equal(lease.input.gain.value, 0);
  assert.throws(
    () => f.api.acquireBuffered(f.audio, f.hooks),
    /already has an owner/,
  );
  assert.equal(f.api.sync(f.audio, true, 0.5), false);
  await lease.release(3);
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  assert.equal(f.audio.plays, 0);
  f.context.close();
});

test('release before parking completes stays exclusive and does not let a late callback reclaim the route', async () => {
  const f = await fixture();
  const parking = deferred();
  const restoring = deferred();
  const lease = f.api.acquireBuffered(f.audio, {
    parkNative: () => parking.promise,
    restoreNative: () => restoring.promise,
  });
  await settle();
  const release = lease.release(10);
  await assert.rejects(lease.ready, { name: 'AbortError' });
  assert.equal(f.api.sync(f.audio, true, 0.5), false);
  assert.throws(
    () => f.api.acquireBuffered(f.audio, f.hooks),
    /already has an owner/,
  );
  assert.equal(gainTo(f.mediaSource, f.output), 0);
  assert.equal(lease.input.gain.value, 0);
  restoring.resolve();
  await release;
  parking.resolve();
  await settle();
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  assert.equal(f.nodes.length, 0);
  const next = f.api.acquireBuffered(f.audio, f.hooks);
  await next.ready;
  await lease.release(10);
  assert.equal(gainTo(f.mediaSource, f.output), 0);
  await next.release(10);
  f.context.close();
});

test('a reused gate survives a later buffered-input allocation failure without duplicating native output', async () => {
  const f = await fixture();
  const first = f.api.acquireBuffered(f.audio, f.hooks);
  await first.ready;
  await first.release(0);
  f.context.failure = (stage) => stage === 'allocate';
  assert.throws(() => f.api.acquireBuffered(f.audio, f.hooks), /Injected/);
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  assert.equal(f.subscribers.size, 1);
  downstreamUnchanged(f);
  const next = f.api.acquireBuffered(f.audio, f.hooks);
  await next.ready;
  assert.equal(gainTo(f.mediaSource, f.output), 0);
  await next.release(0);
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  f.context.close();
});

test('context closure aborts pending ownership, disconnects routes and removes level listeners', async () => {
  const f = await fixture();
  const pending = deferred();
  const lease = f.api.acquireBuffered(f.audio, {
    ...f.hooks,
    parkNative: () => pending.promise,
  });
  await settle();
  f.context.close();
  await assert.rejects(lease.ready, { name: 'AbortError' });
  pending.resolve();
  await settle();
  assert.equal(f.subscribers.size, 0);
  assert.equal(gainTo(f.mediaSource, f.output), 0);
  assert.equal(lease.input.connections.size, 0);
  assert.equal(f.api.hasGraph(f.audio), false);
  assert.throws(() => lease.release(0), /disposed/);
  assert.throws(
    () => f.api.acquireBuffered(f.audio, f.hooks),
    /active native audio graph/,
  );
  downstreamUnchanged(f);
});

test('missing graphs and invalid hooks do not allocate or alter native routing', async () => {
  const f = await fixture();
  assert.throws(
    () => f.api.acquireBuffered({}, f.hooks),
    /active native audio graph/,
  );
  assert.throws(() => f.api.acquireBuffered(f.audio, {}), /ownership hooks/);
  assert.equal(f.context.nodes.length, 4);
  assert.equal(gainTo(f.mediaSource, f.output), 1);
  f.context.close();
});
