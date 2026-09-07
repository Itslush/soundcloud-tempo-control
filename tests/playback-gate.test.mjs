import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackGate } from '../src/audio/playback-gate.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

class FakeNode {
  constructor(context, id) {
    this.context = context;
    this.id = id;
    this.edges = new Set();
    this.connections = 0;
    this.disconnections = 0;
    this.cancellations = [];
    let stored = 1;
    this.gain = {
      get value() {
        return stored;
      },
      set value(value) {
        context.trip(`${id}:value`);
        stored = value;
      },
      cancelScheduledValues: (time) => {
        context.trip(`${id}:cancel`);
        this.cancellations.push(time);
      },
    };
  }
  connect(destination) {
    this.context.trip(`${this.id}:connect`);
    this.edges.add(destination);
    this.connections++;
    return destination;
  }
  disconnect(destination) {
    this.context.trip(`${this.id}:disconnect`);
    assert.notEqual(destination, undefined);
    this.edges.delete(destination);
    this.disconnections++;
  }
}

class FakeContext {
  constructor() {
    this.state = 'running';
    this.nodes = [];
    this.listeners = new Set();
  }
  trip(stage) {
    if (this.failAt === stage) {
      this.failAt = null;
      throw new Error(`Injected ${stage} failure`);
    }
  }
  createGain() {
    this.trip('createGain');
    const node = new FakeNode(this, `gain${this.nodes.length}`);
    this.nodes.push(node);
    return node;
  }
  addEventListener(type, listener) {
    assert.equal(type, 'statechange');
    this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    assert.equal(type, 'statechange');
    this.listeners.delete(listener);
  }
  close() {
    this.state = 'closed';
    for (const listener of [...this.listeners]) listener();
  }
}

function fixture(options = {}) {
  const context = new FakeContext();
  const nativeInput = new FakeNode(context, 'native');
  const destination = new FakeNode(context, 'output');
  const speaker = new FakeNode(context, 'speaker');
  const observer = new FakeNode(context, 'observer');
  destination.connect(speaker);
  nativeInput.connect(observer);
  const subscribers = new Set();
  let level = { volume: 0.8, muted: false, outputDb: -6 };
  const levels = {
    read: () => level,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
  const native = { paused: false, position: 7.25 };
  const parks = [];
  const restores = [];
  const config = {
    context,
    nativeInput,
    destination,
    levels,
    async parkNative(command) {
      parks.push(command);
      native.paused = true;
      await options.park?.(command);
    },
    async restoreNative(command) {
      restores.push(command);
      await options.restore?.(command);
      if (!command.signal.aborted && command.restore)
        native.position = command.position;
    },
  };
  const gate = options.defer ? null : createPlaybackGate(config);
  return {
    context,
    nativeInput,
    destination,
    speaker,
    observer,
    subscribers,
    native,
    levels,
    config,
    gate,
    parks,
    restores,
    setLevel(next) {
      level = next;
      for (const listener of [...subscribers]) listener();
    },
  };
}

test('native route is unity and buffered gain applies logical volume and dB once after native parking', async () => {
  const held = deferred();
  const f = fixture({ park: () => held.promise });
  const nativeGate = f.context.nodes[0];
  assert.equal(f.gate.snapshot().state, 'native');
  assert.equal(nativeGate.gain.value, 1);
  assert.ok(nativeGate.edges.has(f.destination));
  const lease = f.gate.acquire();
  assert.equal(nativeGate.gain.value, 0);
  assert.equal(nativeGate.edges.size, 0);
  assert.equal(lease.input.gain.value, 0);
  assert.equal(f.gate.snapshot().nodes, 2);
  await settle();
  assert.equal(f.parks.length, 1);
  assert.equal(f.native.paused, true);
  assert.equal(f.restores.length, 0);
  held.resolve();
  const ready = await lease.ready;
  assert.equal(ready.state, 'buffered');
  const expected = 0.8 * 10 ** (-6 / 20);
  assert.equal(lease.input.gain.value, expected);
  assert.notEqual(lease.input.gain.value, expected * 10 ** (-6 / 20));
  assert.equal(f.gate.snapshot().nativeConnected, false);
  await lease.release(9.125);
  assert.equal(f.native.position, 9.125);
  assert.equal(f.native.paused, true);
  assert.equal(nativeGate.gain.value, 1);
  assert.equal(f.gate.snapshot().nodes, 1);
  f.gate.dispose();
});

test('level subscription follows logical volume, mute and dB without modifying native or downstream gains', async () => {
  const f = fixture();
  const lease = f.gate.acquire();
  await lease.ready;
  for (const level of [
    { volume: 0.4, muted: false, outputDb: -12 },
    { volume: 0.4, muted: true, outputDb: -12 },
    { volume: 1, muted: false, outputDb: 0 },
    { volume: 0, muted: false, outputDb: -24 },
  ]) {
    f.setLevel(level);
    assert.equal(
      lease.input.gain.value,
      level.muted ? 0 : level.volume * 10 ** (level.outputDb / 20),
    );
    assert.equal(f.context.nodes[0].gain.value, 0);
    assert.equal(f.destination.gain.value, 1);
  }
  await lease.release(7.25);
  f.setLevel({ volume: 0.1, muted: true, outputDb: -3 });
  assert.equal(f.context.nodes[0].gain.value, 1);
  assert.equal(f.destination.disconnections, 0);
  assert.deepEqual([...f.destination.edges], [f.speaker]);
  assert.ok(f.nativeInput.edges.has(f.observer));
  f.gate.dispose();
  assert.deepEqual([...f.nativeInput.edges], [f.observer]);
  assert.deepEqual([...f.destination.edges], [f.speaker]);
});

test('release closes buffered output immediately and only hands native back after confirmed source restoration', async () => {
  const held = deferred();
  const f = fixture({ restore: () => held.promise });
  const lease = f.gate.acquire();
  await lease.ready;
  const releasing = lease.release(83.375);
  assert.equal(lease.release(83.375), releasing);
  assert.equal(lease.input.gain.value, 0);
  assert.equal(lease.input.edges.size, 0);
  assert.equal(f.context.nodes[0].edges.size, 0);
  assert.equal(f.gate.snapshot().state, 'releasing');
  await settle();
  assert.equal(f.restores[0].position, 83.375);
  assert.equal(f.restores[0].restore, true);
  assert.equal(f.native.position, 7.25);
  held.resolve();
  await releasing;
  assert.equal(f.native.position, 83.375);
  assert.equal(f.native.paused, true);
  assert.equal(f.gate.snapshot().nativeConnected, true);
  f.gate.dispose();
});

test('abandoning replaced media skips old-position restoration but still waits for guarded native handback', async () => {
  const held = deferred();
  const f = fixture({ restore: () => held.promise });
  const lease = f.gate.acquire();
  await lease.ready;
  const releasing = lease.release(undefined, { restore: false });
  await settle();
  assert.equal(f.restores.length, 1);
  assert.equal(f.restores[0].restore, false);
  assert.equal(f.restores[0].position, undefined);
  assert.equal(f.gate.snapshot().nativeConnected, false);
  held.resolve();
  await releasing;
  assert.equal(f.native.position, 7.25);
  assert.equal(f.native.paused, true);
  f.gate.dispose();
});

test('each owner gets a permanently isolated input and stale releases cannot affect a later lease', async () => {
  const f = fixture();
  const first = f.gate.acquire();
  await first.ready;
  assert.throws(() => f.gate.acquire(), /already has an owner/);
  assert.equal(f.context.nodes.length, 2);
  const released = first.release(10);
  await released;
  const second = f.gate.acquire();
  await second.ready;
  assert.notEqual(first.input, second.input);
  assert.ok(second.generation > first.generation);
  const before = f.gate.snapshot();
  assert.equal(first.release(10), released);
  await released;
  assert.deepEqual(f.gate.snapshot(), before);
  assert.equal(first.input.gain.value, 0);
  assert.equal(first.input.edges.size, 0);
  assert.equal(f.gate.snapshot().nodes, 2);
  await second.release(11);
  f.gate.dispose();
});

test('releasing a pending acquisition cancels readiness and late park completion cannot reopen its buffered input', async () => {
  const held = deferred();
  const f = fixture({ park: () => held.promise });
  const lease = f.gate.acquire();
  const canceled = assert.rejects(lease.ready, { name: 'AbortError' });
  await settle();
  await lease.release(7.25);
  await canceled;
  const before = f.gate.snapshot();
  held.resolve();
  await settle();
  assert.deepEqual(f.gate.snapshot(), before);
  assert.equal(f.parks[0].signal.aborted, true);
  assert.equal(lease.input.edges.size, 0);
  assert.equal(lease.input.gain.value, 0);
  f.gate.dispose();
});

test('failed parking remains silent and its lease can explicitly return native ownership', async () => {
  const f = fixture({
    park: () => {
      throw new Error('Park failed');
    },
  });
  const lease = f.gate.acquire();
  await assert.rejects(lease.ready, /Park failed/);
  assert.equal(f.gate.snapshot().state, 'failed');
  assert.equal(f.gate.snapshot().nativeConnected, false);
  assert.equal(lease.input.edges.size, 0);
  assert.equal(lease.input.gain.value, 0);
  await lease.release(7.25);
  assert.equal(f.gate.snapshot().state, 'native');
  f.gate.dispose();
});

test('failed restoration is retryable without reopening either route or resuming native playback', async () => {
  let failures = 1;
  const f = fixture({
    restore: () => {
      if (failures--) throw new Error('Seek failed');
    },
  });
  const lease = f.gate.acquire();
  await lease.ready;
  await assert.rejects(lease.release(90.25), /Seek failed/);
  assert.equal(f.gate.snapshot().state, 'failed');
  assert.equal(f.gate.snapshot().nativeConnected, false);
  assert.equal(lease.input.edges.size, 0);
  assert.equal(f.native.position, 7.25);
  await lease.release(91.125);
  assert.equal(f.native.position, 91.125);
  assert.equal(f.native.paused, true);
  assert.equal(f.restores.length, 2);
  f.gate.dispose();
});

test('dispose cancels pending restoration, removes subscriptions and preserves unrelated graph connections', async () => {
  const held = deferred();
  const f = fixture({ restore: () => held.promise });
  const lease = f.gate.acquire();
  await lease.ready;
  const rejected = assert.rejects(lease.release(100), { name: 'AbortError' });
  await settle();
  const end = f.gate.dispose();
  await rejected;
  held.resolve();
  await settle();
  assert.deepEqual(f.gate.dispose(), end);
  assert.equal(f.gate.snapshot().nodes, 0);
  assert.equal(f.gate.snapshot().state, 'disposed');
  assert.equal(f.native.position, 7.25);
  assert.equal(f.native.paused, true);
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.context.listeners.size, 0);
  assert.deepEqual([...f.nativeInput.edges], [f.observer]);
  assert.deepEqual([...f.destination.edges], [f.speaker]);
  assert.throws(() => f.gate.acquire(), /disposed/);
});

test('context closure makes acquisition terminal and ignores late rejected native callbacks', async () => {
  const held = deferred();
  const f = fixture({ park: () => held.promise });
  const lease = f.gate.acquire();
  const rejected = assert.rejects(lease.ready, { name: 'AbortError' });
  await settle();
  f.context.close();
  await rejected;
  held.reject(new Error('Late park failure'));
  await settle();
  assert.equal(f.gate.snapshot().state, 'disposed');
  assert.equal(f.gate.snapshot().nodes, 0);
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.context.listeners.size, 0);
  assert.equal(lease.input.edges.size, 0);
});

test('invalid release arguments leave the current buffered owner unchanged', async () => {
  const f = fixture();
  const lease = f.gate.acquire();
  await lease.ready;
  const before = f.gate.snapshot();
  for (const position of [-1, Infinity, NaN, 86401, undefined, '3'])
    assert.throws(() => lease.release(position), /source position/);
  for (const options of [null, [], { restore: 0 }, { extra: true }])
    assert.throws(() => lease.release(1, options), /options/);
  assert.deepEqual(f.gate.snapshot(), before);
  assert.equal(f.restores.length, 0);
  await lease.release(86400);
  f.gate.dispose();
});

test('bad level updates fail closed without throwing through the shared level publisher', async () => {
  const f = fixture();
  const lease = f.gate.acquire();
  await lease.ready;
  assert.doesNotThrow(() =>
    f.setLevel({ volume: NaN, muted: false, outputDb: -6 }),
  );
  assert.equal(f.gate.snapshot().state, 'failed');
  assert.equal(f.gate.snapshot().nativeConnected, false);
  assert.equal(lease.input.edges.size, 0);
  f.setLevel({ volume: 0.8, muted: false, outputDb: -6 });
  await lease.release(7.25);
  f.gate.dispose();
});

test('graph failures during handback are reported and leave a retryable silent owner', async () => {
  for (const stage of [
    'gain1:disconnect',
    'gain1:cancel',
    'gain0:value',
    'gain0:connect',
  ]) {
    const f = fixture();
    const lease = f.gate.acquire();
    await lease.ready;
    f.context.failAt = stage;
    await assert.rejects(lease.release(22));
    assert.equal(f.gate.snapshot().state, 'failed', stage);
    assert.equal(f.gate.snapshot().nativeConnected, false, stage);
    assert.equal(lease.input.edges.size, 0, stage);
    assert.equal(lease.input.gain.value, 0, stage);
    await lease.release(22);
    assert.equal(f.gate.snapshot().state, 'native', stage);
    f.gate.dispose();
  }
});

test('allocation and construction failures preserve unrelated edges and do not retain level listeners', async () => {
  for (const stage of [
    'createGain',
    'gain0:value',
    'gain0:connect',
    'native:connect',
  ]) {
    const f = fixture({ defer: true });
    f.context.failAt = stage;
    assert.throws(() => createPlaybackGate(f.config));
    assert.equal(f.subscribers.size, 0, stage);
    assert.equal(f.context.listeners.size, 0, stage);
    assert.deepEqual([...f.nativeInput.edges], [f.observer], stage);
    assert.deepEqual([...f.destination.edges], [f.speaker], stage);
  }
  for (const stage of ['createGain', 'gain1:value', 'gain1:connect']) {
    const f = fixture();
    f.context.failAt = stage;
    assert.throws(() => f.gate.acquire());
    assert.equal(f.gate.snapshot().nativeConnected, true);
    assert.equal(f.gate.snapshot().owned, false);
    assert.equal(
      f.context.nodes.at(-1).id === 'gain1'
        ? f.context.nodes.at(-1).edges.size
        : 0,
      0,
    );
    f.gate.dispose();
  }
});

test('one native graph input cannot acquire competing gate instances', () => {
  const f = fixture();
  const nodes = f.context.nodes.length;
  assert.throws(
    () => createPlaybackGate(f.config),
    /already has a playback gate/,
  );
  assert.equal(f.context.nodes.length, nodes);
  f.gate.dispose();
  const replacement = createPlaybackGate(f.config);
  assert.equal(replacement.snapshot().state, 'native');
  replacement.dispose();
});

test('failed disposal reports cleanup errors and a retry removes remaining owned edges', async () => {
  const f = fixture();
  const lease = f.gate.acquire();
  await lease.ready;
  f.context.failAt = 'native:disconnect';
  assert.throws(() => f.gate.dispose(), AggregateError);
  assert.equal(f.gate.snapshot().state, 'disposed');
  assert.equal(f.gate.snapshot().nativeConnected, false);
  assert.equal(f.gate.snapshot().cleanupErrors, 1);
  assert.equal(lease.input.edges.size, 0);
  assert.equal(f.subscribers.size, 0);
  const final = f.gate.dispose();
  assert.equal(final.nodes, 0);
  assert.equal(f.context.listeners.size, 0);
  assert.deepEqual([...f.nativeInput.edges], [f.observer]);
  assert.deepEqual(f.gate.dispose(), final);
});

test('invalid logical levels and graph ownership are rejected before gain allocation', () => {
  const f = fixture({ defer: true });
  for (const bad of [
    { volume: -0.1, muted: false, outputDb: -6 },
    { volume: 1.1, muted: false, outputDb: -6 },
    { volume: 0.8, muted: 0, outputDb: -6 },
    { volume: 0.8, muted: false, outputDb: 1 },
    { volume: 0.8, muted: false, outputDb: -25 },
    { volume: 0.8, muted: false, outputDb: NaN },
  ]) {
    f.setLevel(bad);
    assert.throws(() => createPlaybackGate(f.config), /logical output level/);
  }
  f.setLevel({ volume: 0.8, muted: false, outputDb: -6 });
  for (const change of [
    { destination: f.nativeInput },
    { destination: { context: new FakeContext() } },
    { levels: {} },
    { parkNative: null },
    { restoreNative: null },
  ])
    assert.throws(
      () => createPlaybackGate({ ...f.config, ...change }),
      TypeError,
    );
  assert.equal(f.context.nodes.length, 0);
});
