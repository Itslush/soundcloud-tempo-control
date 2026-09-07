const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');

const source = require('./module-fixture.cjs')(['tempo-wasm.js']);
const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
  await new Promise(setImmediate);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture() {
  class Node extends EventTarget {
    constructor(context) {
      super();
      this.context = context;
      this.connections = new Set();
      this.gain = {
        value: 1,
        events: [],
        cancelScheduledValues(time) {
          this.events.push(['cancel', time]);
        },
        setValueAtTime(value, time) {
          this.value = value;
          this.events.push(['set', value, time]);
        },
        linearRampToValueAtTime(value, time) {
          this.value = value;
          this.events.push(['ramp', value, time]);
        },
      };
    }
    connect(destination) {
      this.connections.add(destination);
      return destination;
    }
    disconnect(destination) {
      if (destination) this.connections.delete(destination);
      else this.connections.clear();
    }
  }
  class Audio extends EventTarget {
    paused = false;
    seeking = false;
  }
  class Context extends EventTarget {
    sampleRate = 48000;
    currentTime = 0;
    state = 'running';
    createGain() {
      return new Node(this);
    }
    createMediaElementSource() {
      return new Node(this);
    }
  }
  const context = new Context();
  const audio = new Audio();
  const nodes = [];
  const timers = new Map();
  const warnings = [];
  let timerId = 0;
  let api;
  const state = { enabled: true, speed: 0.5, creation: null };
  const refresh = () => api.sync(audio, state.enabled, state.speed);
  const globals = {
    window: { AudioContext: Context, AudioNode: Node },
    AudioContext: Context,
    AudioNode: Node,
    HTMLAudioElement: Audio,
    WeakMap,
    WeakRef,
    setTimeout: (callback) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    console: { warn: (...args) => warnings.push(args) },
    preservesKey: () => true,
    useWasm: true,
    bufferedAudio: null,
    references: new Set([new WeakRef(audio)]),
    discover() {},
    apply: refresh,
    updateAll: refresh,
    createStretchNode: async () => {
      const node = new Node(context);
      node.port = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      node.configurations = [];
      node.schedules = [];
      node.configure = async (options) => {
        node.configurations.push(options);
        if (node.configureGate) await node.configureGate.promise;
      };
      node.latency = async () => 0.12;
      node.schedule = async (options) => {
        node.schedules.push(options);
        if (options.active && node.scheduleGate)
          await node.scheduleGate.promise;
        if (!options.active && node.stopGate) await node.stopGate.promise;
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
  const input = [...mediaSource.connections].find(
    (node) => node.gain.value === 0,
  );
  return {
    api,
    audio,
    context,
    nodes,
    state,
    timers,
    warnings,
    refresh,
    mediaSource,
    input,
  };
}

test('pause, seek and mode changes reuse one node with full default-equivalent resets', async () => {
  const value = fixture();
  value.refresh();
  await settle();
  assert.equal(value.api.active(value.audio), true);
  const node = value.nodes[0];
  assert.equal(node.configurations[0].blockMs, 120);
  assert.equal(node.configurations[0].intervalMs, 30);
  assert.equal(node.configurations[0].splitComputation, false);
  assert.deepEqual(value.input.gain.events.slice(-3), [
    ['cancel', 0],
    ['set', 0, 0],
    ['set', 1, 0.12],
  ]);
  const wet = [...node.connections][0];
  assert.deepEqual(wet.gain.events.slice(-3), [
    ['set', 0, 0],
    ['set', 0, 0.24],
    ['ramp', 1, 0.25],
  ]);
  for (let index = 0; index < 20; index++) {
    value.audio.paused = true;
    value.audio.dispatchEvent(new Event('pause'));
    value.refresh();
    await settle();
    assert.equal(node.connections.size, 0);
    assert.equal(node.port.closed, false);
    assert.equal(value.api.active(value.audio), false);
    assert.equal(node.schedules.at(-1).active, false);
    assert.equal(value.input.gain.value, 0);
    assert.equal(value.input.connections.size, 0);
    assert.equal(value.mediaSource.connections.has(value.input), true);
    value.audio.paused = false;
    value.state.speed = 0.75;
    value.refresh();
    await settle();
    value.audio.seeking = true;
    value.audio.dispatchEvent(new Event('seeking'));
    value.audio.seeking = false;
    value.audio.dispatchEvent(new Event('seeked'));
    await settle();
    value.state.enabled = false;
    value.refresh();
    await settle();
    value.state.enabled = true;
    value.refresh();
    await settle();
    assert.equal(value.api.active(value.audio), true);
  }
  assert.equal(value.nodes.length, 1);
  assert.equal(node.configurations.length, 61);
  assert.equal(value.timers.size, 0);
  assert.equal(value.warnings.length, 0);
});

test('late creation remains cached but cannot reconnect a paused or stale source', async () => {
  const value = fixture();
  value.state.creation = deferred();
  value.refresh();
  value.audio.paused = true;
  value.audio.dispatchEvent(new Event('pause'));
  value.state.creation.resolve();
  await settle();
  assert.equal(value.nodes.length, 1);
  assert.equal(value.nodes[0].connections.size, 0);
  assert.equal(value.nodes[0].port.closed, false);
  assert.equal(value.api.active(value.audio), false);
  value.audio.paused = false;
  value.refresh();
  await settle();
  assert.equal(value.nodes.length, 1);
  assert.equal(value.api.active(value.audio), true);
});

test('a stale schedule cannot activate after a seek, and the newest speed wins', async () => {
  const value = fixture();
  value.refresh();
  await settle();
  const node = value.nodes[0];
  node.scheduleGate = deferred();
  value.state.speed = 0.6;
  value.refresh();
  value.audio.seeking = true;
  value.audio.dispatchEvent(new Event('seeking'));
  value.state.speed = 0.8;
  value.audio.seeking = false;
  value.audio.dispatchEvent(new Event('seeked'));
  assert.equal(value.api.active(value.audio), false);
  node.scheduleGate.resolve();
  await settle();
  assert.equal(value.nodes.length, 1);
  assert.equal(value.api.active(value.audio), true);
  assert.equal(node.schedules.at(-1).semitones, -12 * Math.log2(0.8));
  assert.equal(node.configurations.length, 2);
});

test('initial compensation stays dry until the newest speed is acknowledged without a seek', async () => {
  const value = fixture();
  value.refresh();
  const node = value.nodes[0];
  const first = deferred();
  const latest = deferred();
  node.scheduleGate = first;
  await settle();
  assert.equal(value.api.active(value.audio), false);
  assert.equal(node.schedules.at(-1).semitones, -12 * Math.log2(0.5));
  value.state.speed = 0.8;
  value.refresh();
  node.scheduleGate = latest;
  first.resolve();
  await settle();
  assert.equal(node.schedules.at(-1).semitones, -12 * Math.log2(0.8));
  assert.equal(value.api.active(value.audio), false);
  latest.resolve();
  await settle();
  assert.equal(value.api.active(value.audio), true);
  assert.equal(value.nodes.length, 1);
  assert.equal(node.configurations.length, 1);
});

test('live speed changes keep the active route while the newest schedule is pending', async () => {
  const value = fixture();
  value.refresh();
  await settle();
  const node = value.nodes[0];
  const primingEvents = value.input.gain.events.length;
  const first = deferred();
  const latest = deferred();
  node.scheduleGate = first;
  value.state.speed = 0.6;
  value.refresh();
  await settle();
  value.state.speed = 0.8;
  value.refresh();
  node.scheduleGate = latest;
  first.resolve();
  await settle();
  assert.equal(node.schedules.at(-1).semitones, -12 * Math.log2(0.8));
  assert.equal(value.api.active(value.audio), true);
  latest.resolve();
  await settle();
  assert.equal(value.api.active(value.audio), true);
  assert.equal(node.configurations.length, 1);
  assert.equal(
    node.schedules.some((schedule) => !schedule.active),
    false,
  );
  assert.equal(value.input.gain.events.length, primingEvents);
});

test('configure timeout poisons the node and cannot trigger recreation bursts', async () => {
  const value = fixture();
  value.refresh();
  await settle();
  const node = value.nodes[0];
  node.configureGate = deferred();
  value.audio.dispatchEvent(new Event('seeking'));
  value.refresh();
  await settle();
  for (const timeout of [...value.timers.values()]) timeout();
  await settle();
  assert.equal(value.api.active(value.audio), false);
  assert.equal(node.port.closed, true);
  for (let index = 0; index < 10; index++) {
    value.state.enabled = !value.state.enabled;
    value.refresh();
  }
  assert.equal(value.nodes.length, 1);
  node.configureGate.resolve();
  await settle();
  assert.equal(node.connections.size, 0);
  assert.equal(value.api.active(value.audio), false);
  assert.match(value.api.label(), /browser fallback/);
});

test('creation timeout closes a late result without a replacement attempt', async () => {
  const value = fixture();
  value.state.creation = deferred();
  value.refresh();
  for (const timeout of [...value.timers.values()]) timeout();
  await settle();
  value.state.creation.resolve();
  await settle();
  for (let index = 0; index < 10; index++) value.refresh();
  assert.equal(value.nodes.length, 1);
  assert.equal(value.nodes[0].port.closed, true);
  assert.equal(value.nodes[0].connections.size, 0);
  assert.equal(value.api.active(value.audio), false);
});

test('processor errors and closed contexts retire cached nodes', async () => {
  for (const failure of ['processor', 'context']) {
    const value = fixture();
    value.refresh();
    await settle();
    const node = value.nodes[0];
    if (failure === 'processor')
      node.dispatchEvent(new Event('processorerror'));
    else {
      value.context.state = 'closed';
      value.context.dispatchEvent(new Event('statechange'));
    }
    await settle();
    value.refresh();
    assert.equal(value.api.active(value.audio), false);
    assert.equal(node.connections.size, 0);
    assert.equal(node.port.closed, true);
    assert.equal(value.nodes.length, 1);
  }
});

test('failed or stalled deactivation uses fallback without uncaught event errors', async () => {
  for (const failure of ['throw', 'timeout']) {
    const value = fixture();
    value.refresh();
    await settle();
    const node = value.nodes[0];
    if (failure === 'throw')
      node.schedule = () => {
        throw new Error('Port failed');
      };
    else node.stopGate = deferred();
    value.audio.paused = true;
    value.audio.dispatchEvent(new Event('pause'));
    await settle();
    for (const timeout of [...value.timers.values()]) timeout();
    await settle();
    value.audio.paused = false;
    value.refresh();
    assert.equal(value.nodes.length, 1);
    assert.equal(node.connections.size, 0);
    assert.equal(node.port.closed, true);
    assert.equal(value.api.active(value.audio), false);
    assert.equal(value.warnings.length, 1);
  }
});

test('a partial graph connection failure removes the gated input-to-worklet edge', async () => {
  const value = fixture();
  value.refresh();
  const node = value.nodes[0];
  node.connect = () => {
    throw new Error('Connection rejected');
  };
  await settle();
  assert.equal(value.input.connections.has(node), false);
  assert.equal(node.port.closed, true);
  assert.equal(value.api.active(value.audio), false);
  assert.equal(value.nodes.length, 1);
});
