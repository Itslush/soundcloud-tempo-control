import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { createSoundCloudHostClock } from '../src/audio/soundcloud-host-clock.mjs';

const manifest = JSON.parse(
  readFileSync(
    new URL('./fixtures/soundcloud-host-clock.json', import.meta.url),
  ),
);
const methodSources = [
  'function(e){e.ended=e.ready&&this._getPositionOrPositionSeekingTo()===e.duration}',
  'function(){if(!this._mediaElementAndState||"USABLE"!==this._mediaElementAndState.state)throw new Error("Media element does not exist or is in invalid state.");var e=this._mediaElementAndState.cachedMediaElTime,t=e.elTime,r=e.systemTime;return this.isStalled()||!this.isActuallyPlaying()?t:t+(L()-r)}',
  'function(){var e=null!==this._duration?this._duration:1/0;if(!this._mediaElementAndState||"USABLE"!==this._mediaElementAndState.state)return this._positionWhenMediaElementRevoked;this._determineIfPlaying();var t=Math.min(this._getTruePosition(),e);return this._shouldBeEnded()?e:t}',
  'function(){return this._endedOverride||this._mediaElementReportingEnded()}',
  'function(){var e=this,t=this._duration;null!==t&&this._update((function(){e._provideDuration(t),e._mediaElementAndState&&"STABLE"===e._mediaElementAndState.state&&(e.isReady()||e._signalReady(),e._handleDeferredPauseAndSeek())}))}',
  'function(){var e=this._lastSegmentAppended;if(!e||!e.isFinalSegment())return!1;if(!V)return r.prototype._shouldBeEnded.call(this);if(r.prototype._shouldBeEnded.call(this))return!0;if(!this.getMediaElement())return!1;var t=this._duration;return this._stallDetected&&null!==t&&this._getMediaElementPosition()>=t-600}',
];
const own = (object, key) => Object.getOwnPropertyDescriptor(object, key);
const unsupported = (error) => error.code === 'SOUNDCLOUD_HOST_UNSUPPORTED';
const stale = (error) => error.code === 'SOUNDCLOUD_HOST_STALE';

function sdkExports(id, values) {
  const definitions = manifest.exports.filter((entry) => entry.module === id);
  const names = definitions.map(
    (entry) => entry.getter.match(/^function\(\)\{return (\w+)\}$/)[1],
  );
  const scope = Function(
    ...names,
    `return {
      getters: [${definitions.map((entry) => entry.getter).join(',')}],
      set(index, value) {
        switch (index) {
          ${names.map((name, index) => `case ${index}: ${name} = value; break;`).join('\n')}
        }
      }
    }`,
  )(...definitions.map((entry) => values[entry.name]));
  const exports = {};
  definitions.forEach((entry, index) =>
    Object.defineProperty(exports, entry.name, {
      get: scope.getters[index],
      configurable: entry.configurable,
      enumerable: entry.enumerable,
    }),
  );
  return {
    exports,
    set(name, value) {
      const index = definitions.findIndex((entry) => entry.name === name);
      assert.notEqual(index, -1);
      scope.set(index, value);
    },
  };
}

function replaceExport(f, id, name, descriptor) {
  const descriptors = Object.getOwnPropertyDescriptors(f.exportsById[id]);
  descriptors[name] = descriptor;
  const exports = Object.defineProperties({}, descriptors);
  f.exportsById[id] = exports;
  f.runtime.c[id].exports = exports;
}

function fixture({
  digest,
  push,
  diagnostic,
  captureFailure,
  realClock = false,
} = {}) {
  const counts = {
    captures: 0,
    hostFactories: 0,
    digests: 0,
    clocks: 0,
    binds: 0,
    failures: 0,
  };
  const mediaValues = new WeakMap();
  class Media {
    constructor() {
      mediaValues.set(this, {
        src: 'blob:https://soundcloud.com/track',
        currentSrc: 'blob:https://soundcloud.com/track',
        srcObject: null,
      });
    }
  }
  for (const key of ['src', 'currentSrc', 'srcObject'])
    Object.defineProperty(Media.prototype, key, {
      configurable: true,
      get() {
        return mediaValues.get(this)[key];
      },
    });
  class BasePlayer {}
  class HTML5PlayerBase extends BasePlayer {
    getMediaElement() {
      return this._mediaElementAndState.element;
    }
  }
  class HLSMSEPlayer extends HTML5PlayerBase {}
  const prototypes = {
    BasePlayer: BasePlayer.prototype,
    HTML5PlayerBase: HTML5PlayerBase.prototype,
    HLSMSEPlayer: HLSMSEPlayer.prototype,
  };
  manifest.methods.forEach(({ prototype, method }, index) => {
    Object.defineProperty(prototypes[prototype], method, {
      value: Function(`return (${methodSources[index]})`)(),
      configurable: true,
      writable: true,
    });
  });
  const audio = new Media();
  function leafFor(media = audio) {
    const leaf = new HLSMSEPlayer();
    leaf._duration = 1000;
    leaf._mediaElementAndState = {
      state: 'USABLE',
      element: media,
      cachedMediaElTime: { elTime: 100, systemTime: 100 },
    };
    leaf._update = (callback) => callback();
    leaf._provideDuration = (duration) => {
      leaf.provided = duration;
    };
    return leaf;
  }
  const leaf = leafFor();
  const middle = Object.assign(new BasePlayer(), {
    _player: leaf,
    _synced: true,
  });
  const outer = Object.assign(new BasePlayer(), {
    _player: middle,
    _synced: true,
  });
  let currentItem = { sound: { player: { player: outer } } };
  const queueExports = {};
  queueExports.getCurrentQueueItem = Function(
    'P',
    'I',
    'return function(){return P.at(I)}',
  )({ at: () => currentItem }, 0);
  queueExports.getCurrentSound = Function(
    'W',
    'return function(){var e=W.getCurrentQueueItem();return null==e?void 0:e.sound}',
  )(queueExports);
  const scopes = Object.fromEntries(
    [
      ['100', { BasePlayer }],
      ['572', { HTML5PlayerBase }],
      ['1280', { HLSMSEPlayer }],
    ].map(([id, constructors]) => [
      id,
      sdkExports(id, {
        ...constructors,
        version: manifest.version,
        buildNumber: manifest.buildNumber,
      }),
    ]),
  );
  const exportsById = {
    20: queueExports,
    ...Object.fromEntries(
      Object.entries(scopes).map(([id, scope]) => [id, scope.exports]),
    ),
  };
  const runtime = () => {
    counts.hostFactories++;
    throw new Error('A host factory was invoked');
  };
  runtime.m = Object.fromEntries(
    Object.keys(exportsById).map((id) => [id, runtime]),
  );
  runtime.c = Object.fromEntries(
    Object.entries(exportsById).map(([id, exports]) => [
      id,
      { i: id, l: true, exports },
    ]),
  );
  const queue = [];
  queue.push = function (packet) {
    counts.captures++;
    for (const [id, factory] of Object.entries(packet[1]))
      runtime.m[id] = factory;
    for (const [id] of packet[2]) {
      const exports = {};
      const module = (runtime.c[id] = { i: id, l: false, exports });
      diagnostic?.({ module, id, runtime, queue, packet });
      try {
        runtime.m[id](module, exports, runtime);
      } catch (error) {
        captureFailure?.({ module, id, runtime, queue, packet });
        throw error;
      }
      module.l = true;
    }
    Array.prototype.push.call(this, packet);
    push?.({ packet, runtime, queue });
  };
  const window = { webpackJsonp: queue, HTMLMediaElement: Media };
  const crypto = {
    randomUUID: () => webcrypto.randomUUID(),
    subtle: {
      digest(...args) {
        counts.digests++;
        return digest ? digest(...args) : webcrypto.subtle.digest(...args);
      },
    },
  };
  let clockOptions;
  const coreBindings = [];
  const createClock = (options) => {
    counts.clocks++;
    clockOptions = options;
    return {
      bind(media, hooks) {
        counts.binds++;
        assert.equal(hooks.sourceMatches(), true);
        hooks.snapshot();
        let active = true;
        let restoration = Promise.resolve();
        const binding = {
          hooks,
          update() {
            if (!active) return false;
            try {
              active = hooks.sourceMatches();
              return active;
            } catch (error) {
              active = false;
              restoration = Promise.resolve(options.onFailure(media, error));
              return false;
            }
          },
          release() {
            const changed = active;
            active = false;
            return changed;
          },
          get active() {
            return active;
          },
          get restoration() {
            return restoration;
          },
        };
        coreBindings.push(binding);
        return binding;
      },
      dispose() {
        coreBindings.forEach((binding) => binding.release());
        return Promise.all(coreBindings.map((binding) => binding.restoration));
      },
    };
  };
  const adapter = createSoundCloudHostClock({
    window,
    crypto,
    mediaPrototype: Media.prototype,
    ...(realClock ? {} : { createClock }),
  });
  const parameters = {
    snapshot: () => ({
      position: 0.5,
      duration: 2,
      paused: false,
      ended: false,
    }),
    sourceMatches: () => true,
    onFailure() {
      counts.failures++;
    },
  };
  return {
    adapter,
    audio,
    Media,
    mediaValues,
    prototypes,
    leaf,
    middle,
    outer,
    leafFor,
    counts,
    queue,
    runtime,
    window,
    crypto,
    exportsById,
    setExport(id, name, value) {
      scopes[id].set(name, value);
    },
    parameters,
    coreBindings,
    get clockOptions() {
      return clockOptions;
    },
    get currentItem() {
      return currentItem;
    },
    set currentItem(value) {
      currentItem = value;
    },
  };
}

function assertClean(f) {
  assert.equal(f.counts.hostFactories, 0);
  assert.deepEqual(Object.keys(f.runtime.m).sort(), [
    '100',
    '1280',
    '20',
    '572',
  ]);
  assert.deepEqual(Object.keys(f.runtime.c).sort(), [
    '100',
    '1280',
    '20',
    '572',
  ]);
  assert.equal(
    f.queue.filter((packet) =>
      String(packet[2]?.[0]?.[0]).startsWith('soundcloud-tempo-clock-'),
    ).length,
    0,
  );
}

test('deterministic SDK fixture matches all six pinned real SHA-256 fingerprints', () => {
  methodSources.forEach((source, index) =>
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      manifest.methods[index].sha256,
    ),
  );
});

test('the runtime fixture uses all nine observed nonconfigurable SDK export getters', async () => {
  const f = fixture({ realClock: true });
  assert.equal(manifest.exports.length, 9);
  for (const entry of manifest.exports) {
    const descriptor = own(f.exportsById[entry.module], entry.name);
    assert.equal('value' in descriptor, false);
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.set, undefined);
    assert.equal(
      Function.prototype.toString.call(descriptor.get),
      entry.getter,
    );
  }
  const prepared = await f.adapter.prepare(f.audio);
  assertClean(f);
  const binding = prepared.bind(f.parameters);
  assert.equal(f.leaf._getTruePosition(), 500);
  assert.equal(binding.update(), true);
  binding.release();
  await binding.restoration;
  await f.adapter.dispose();
});

test('unapproved SDK export getters cannot execute or spoof their source', async () => {
  for (const entry of manifest.exports) {
    const f = fixture();
    let reads = 0;
    const getter = function () {
      reads++;
      throw new Error('Unapproved export getter executed');
    };
    getter.toString = () => entry.getter;
    replaceExport(f, entry.module, entry.name, {
      get: getter,
      configurable: false,
      enumerable: true,
    });
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    assert.equal(reads, 0);
    assert.equal(f.counts.clocks, 0);
    assertClean(f);
    await f.adapter.dispose();
  }
});

test('SDK exports require the recorded getter flags without a data-property fallback', async () => {
  for (const entry of manifest.exports)
    for (const shape of ['configurable', 'nonenumerable', 'setter', 'data']) {
      const f = fixture();
      const descriptor = own(f.exportsById[entry.module], entry.name);
      if (shape === 'configurable') descriptor.configurable = true;
      if (shape === 'nonenumerable') descriptor.enumerable = false;
      if (shape === 'setter') descriptor.set = () => {};
      if (shape === 'data') {
        descriptor.value = f.exportsById[entry.module][entry.name];
        delete descriptor.get;
        delete descriptor.set;
      }
      replaceExport(f, entry.module, entry.name, descriptor);
      await assert.rejects(f.adapter.prepare(f.audio), unsupported);
      assert.equal(f.counts.clocks, 0);
      assertClean(f);
      await f.adapter.dispose();
    }
});

test('SDK live bindings are revalidated even when their export descriptors stay identical', async () => {
  for (const entry of manifest.exports) {
    const f = fixture();
    const prepared = await f.adapter.prepare(f.audio);
    const original = own(f.exportsById[entry.module], entry.name);
    f.setExport(entry.module, entry.name, null);
    assert.deepEqual(own(f.exportsById[entry.module], entry.name), original);
    assert.throws(() => prepared.bind(f.parameters), unsupported);
    assert.equal(f.counts.clocks, 0);
    assertClean(f);
    await f.adapter.dispose();
  }
});

test('SDK live-binding changes during hashing invalidate preparation', async () => {
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const f = fixture({
    digest: async (...args) => {
      await gate;
      return webcrypto.subtle.digest(...args);
    },
  });
  const pending = f.adapter.prepare(f.audio);
  f.setExport('572', 'HTML5PlayerBase', function Replacement() {});
  resume();
  await assert.rejects(pending, unsupported);
  assert.equal(f.counts.clocks, 0);
  assertClean(f);
  await f.adapter.dispose();
});

test('SDK live-binding changes on an owned route require native handback', async () => {
  const f = fixture();
  let received;
  const binding = (await f.adapter.prepare(f.audio)).bind({
    ...f.parameters,
    onFailure(error) {
      received = error;
    },
  });
  f.setExport('100', 'BasePlayer', function Replacement() {});
  assert.equal(binding.update(), false);
  assert.equal(binding.active, false);
  assert.ok(unsupported(received));
  assert.match(received.message, /BasePlayer export changed/);
  await binding.restoration;
  await f.adapter.dispose();
  assertClean(f);
});

test('unavailable bindings in approved getters produce actionable errors', async () => {
  for (const entry of manifest.exports) {
    const f = fixture();
    replaceExport(f, entry.module, entry.name, {
      configurable: false,
      enumerable: true,
      get: Function(`return (${entry.getter})`)(),
    });
    await assert.rejects(f.adapter.prepare(f.audio), (error) => {
      assert.ok(unsupported(error));
      assert.match(error.message, /export could not be read/);
      assert.equal(error.cause?.name, 'ReferenceError');
      return true;
    });
    assert.equal(f.counts.clocks, 0);
    assertClean(f);
    await f.adapter.dispose();
  }
});

test('discovery is lazy, loaded-only, shared and fully cleaned before binding', async () => {
  const f = fixture();
  const before = Object.fromEntries(
    Object.entries(f.prototypes).map(([name, prototype]) => [
      name,
      Object.getOwnPropertyDescriptors(prototype),
    ]),
  );
  assert.equal(f.counts.captures, 0);
  const [first, second] = await Promise.all([
    f.adapter.prepare(f.audio),
    f.adapter.prepare(f.audio),
  ]);
  assert.equal(f.counts.captures, 1);
  assert.equal(f.counts.digests, 6);
  assert.equal(f.counts.clocks, 0);
  for (const [name, prototype] of Object.entries(f.prototypes))
    assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before[name]);
  assertClean(f);
  const binding = first.bind(f.parameters);
  assert.equal(binding.active, true);
  assert.equal(binding.update(), true);
  assert.throws(() => second.bind(f.parameters), unsupported);
  binding.release();
  await binding.restoration;
  assert.throws(() => first.bind(f.parameters), stale);
  await f.adapter.dispose();
});

test('the real core binds only validated owned media and restores its prototypes and duration', async () => {
  const f = fixture({ realClock: true });
  const original = own(f.prototypes.HTML5PlayerBase, '_getTruePosition');
  const ready = await f.adapter.prepare(f.audio);
  assert.deepEqual(
    own(f.prototypes.HTML5PlayerBase, '_getTruePosition'),
    original,
  );
  const binding = ready.bind(f.parameters);
  assert.notEqual(
    own(f.prototypes.HTML5PlayerBase, '_getTruePosition').value,
    original.value,
  );
  assert.equal(f.leaf._getTruePosition(), 500);
  assert.equal(binding.update(), true);
  assert.equal(f.leaf.provided, 2000);
  await f.adapter.dispose();
  assert.equal(binding.active, false);
  assert.deepEqual(
    own(f.prototypes.HTML5PlayerBase, '_getTruePosition'),
    original,
  );
  assert.equal(f.leaf._duration, 1000);
  assert.equal(f.leaf.provided, 1000);
  assertClean(f);
});

test('missing, unloaded and unsupported SDK modules fail without executing host factories', async () => {
  for (const mutate of [
    (f) => {
      delete f.runtime.c[572];
    },
    (f) => {
      f.runtime.c[100].l = false;
    },
    (f) => {
      f.setExport('1280', 'version', '33.0.0');
    },
    (f) => {
      f.setExport('572', 'buildNumber', 2286);
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    assert.equal(f.counts.hostFactories, 0);
    assert.equal(f.counts.clocks, 0);
    assert.equal(f.queue.length, 0);
    await f.adapter.dispose();
  }
});

test('changed SDK methods cannot spoof their fingerprints with a toString property', async () => {
  for (const { prototype, method } of manifest.methods) {
    const f = fixture();
    const original = f.prototypes[prototype][method];
    const changed = function () {};
    changed.toString = () => Function.prototype.toString.call(original);
    f.prototypes[prototype][method] = changed;
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    assertClean(f);
    await f.adapter.dispose();
  }
});

test('unapproved accessor-shaped host state is rejected without invoking its getters', async () => {
  for (const target of [
    'module',
    'export',
    'method',
    'queue',
    'chain',
    'media',
  ]) {
    const f = fixture();
    let reads = 0;
    if (target === 'export')
      replaceExport(f, '100', 'version', {
        configurable: true,
        value: manifest.version,
      });
    const objects = {
      module: [f.runtime.c[100], 'exports'],
      export: [f.exportsById[100], 'version'],
      method: [f.prototypes.HTML5PlayerBase, '_getPosition'],
      queue: [f.exportsById[20], 'getCurrentSound'],
      chain: [f.middle, '_player'],
      media: [f.leaf._mediaElementAndState, 'element'],
    };
    const [object, key] = objects[target];
    Object.defineProperty(object, key, {
      configurable: true,
      get() {
        reads++;
        throw new Error('Getter executed');
      },
    });
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    assert.equal(reads, 0, target);
    assertClean(f);
    await f.adapter.dispose();
  }
});

test('queue methods must match both recorded accessors before either is called', async () => {
  for (const key of ['getCurrentSound', 'getCurrentQueueItem']) {
    const f = fixture();
    let calls = 0;
    f.exportsById[20][key] = () => {
      calls++;
      return f.currentItem;
    };
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    assert.equal(calls, 0);
    assertClean(f);
    await f.adapter.dispose();
  }
});

test('unsynchronized, cyclic, oversized and overridden player chains fail closed', async () => {
  for (const mutate of [
    (f) => {
      f.middle._synced = false;
    },
    (f) => {
      f.middle._player = f.outer;
    },
    (f) => {
      f.leaf._getTruePosition = function () {};
    },
    (f) => {
      let child = f.leaf;
      for (let index = 0; index < 8; index++)
        child = Object.assign(Object.create(f.prototypes.BasePlayer), {
          _player: child,
          _synced: true,
        });
      f.middle._player = child;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    assert.equal(f.counts.clocks, 0);
    assertClean(f);
    await f.adapter.dispose();
  }
});

test('bind rejects changed source, selection, descriptors and disposed preparations', async () => {
  for (const mutate of [
    (f) => {
      f.mediaValues.get(f.audio).src = 'blob:replacement';
    },
    (f) => {
      f.currentItem = { sound: f.currentItem.sound };
    },
    (f) => {
      f.prototypes.HTML5PlayerBase._getPosition = function () {};
    },
    (f) => {
      f.window.webpackJsonp = [];
    },
    (f) => {
      f.adapter.dispose();
    },
  ]) {
    const f = fixture();
    const ready = await f.adapter.prepare(f.audio);
    mutate(f);
    assert.throws(
      () => ready.bind(f.parameters),
      (error) => stale(error) || unsupported(error),
    );
    assert.equal(f.counts.clocks, 0);
    await f.adapter.dispose();
  }
});

test('known unbound media lifecycle states invalidate prepare and bind without adapting the host', async () => {
  for (const phase of [null, 'INITIALIZING', 'STABLE']) {
    const f = fixture();
    const prepared = await f.adapter.prepare(f.audio);
    f.leaf._mediaElementAndState =
      phase === null ? null : { state: phase, element: f.audio };
    await assert.rejects(f.adapter.prepare(f.audio), stale);
    assert.throws(() => prepared.bind(f.parameters), stale);
    assert.equal(f.counts.clocks, 0);
    assert.equal(f.counts.failures, 0);
    assertClean(f);
    await f.adapter.dispose();
  }
});

test('real host position reads during known media teardown release the owned clock without failure', async () => {
  for (const phase of [null, 'INITIALIZING', 'STABLE']) {
    const f = fixture({ realClock: true });
    const originalMethods = Object.fromEntries(
      Object.entries(f.prototypes).map(([name, prototype]) => [
        name,
        Object.getOwnPropertyDescriptors(prototype),
      ]),
    );
    const binding = (await f.adapter.prepare(f.audio)).bind(f.parameters);
    assert.equal(f.leaf._getTruePosition(), 500);
    assert.equal(binding.update(), true);
    assert.equal(typeof own(f.leaf, '_duration').get, 'function');
    f.leaf._duration = 1250;
    f.leaf._positionWhenMediaElementRevoked = 450;
    f.leaf._mediaElementAndState =
      phase === null ? null : { state: phase, element: f.audio };
    assert.equal(f.leaf._getPosition(), 450);
    assert.equal(binding.active, false);
    assert.equal(f.counts.failures, 0);
    assert.equal(f.leaf._duration, 1250);
    assert.equal(own(f.leaf, '_duration').get, undefined);
    await binding.restoration;
    await f.adapter.dispose();
    for (const [name, prototype] of Object.entries(f.prototypes))
      assert.deepEqual(
        Object.getOwnPropertyDescriptors(prototype),
        originalMethods[name],
      );
    assertClean(f);
  }
});

test('unknown and accessor-shaped media lifecycle states remain incompatible without getter execution', async () => {
  for (const shape of [
    'undefined',
    'missing-state',
    'state-getter',
    'unknown-phase',
    'initializing-element-getter',
    'stable-missing-element',
  ]) {
    const f = fixture();
    const binding = (await f.adapter.prepare(f.audio)).bind(f.parameters);
    let reads = 0;
    const getter = () => {
      reads++;
      throw new Error('Unapproved lifecycle getter executed');
    };
    const state = { state: 'USABLE', element: f.audio };
    if (shape === 'missing-state') delete state.state;
    if (shape === 'state-getter')
      Object.defineProperty(state, 'state', { get: getter });
    if (shape === 'unknown-phase') state.state = 'RELEASED';
    if (shape === 'initializing-element-getter') {
      state.state = 'INITIALIZING';
      Object.defineProperty(state, 'element', { get: getter });
    }
    if (shape === 'stable-missing-element') {
      state.state = 'STABLE';
      delete state.element;
    }
    f.leaf._mediaElementAndState = shape === 'undefined' ? undefined : state;
    assert.equal(binding.update(), false);
    assert.equal(binding.active, false);
    assert.equal(f.counts.failures, 1, shape);
    assert.equal(reads, 0);
    await binding.restoration;
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    await f.adapter.dispose();
    assertClean(f);
  }
});

test('a released native media leaf requires a fresh binding when it becomes usable again', async () => {
  const f = fixture({ realClock: true });
  const state = f.leaf._mediaElementAndState;
  const first = (await f.adapter.prepare(f.audio)).bind(f.parameters);
  assert.equal(f.leaf._getTruePosition(), 500);
  f.leaf._mediaElementAndState = null;
  assert.equal(first.update(), false);
  assert.equal(first.active, false);
  assert.equal(f.counts.failures, 0);
  f.leaf._mediaElementAndState = state;
  assert.equal(first.update(), false);
  const second = (await f.adapter.prepare(f.audio)).bind(f.parameters);
  assert.equal(second.active, true);
  assert.equal(f.leaf._getTruePosition(), 500);
  second.release();
  await second.restoration;
  await f.adapter.dispose();
  assertClean(f);
});

test('native source reads bypass facade accessors and per-element property overrides', async () => {
  const f = fixture();
  const ready = await f.adapter.prepare(f.audio);
  for (const target of [f.audio, f.Media.prototype])
    for (const key of ['src', 'currentSrc', 'srcObject'])
      Object.defineProperty(target, key, {
        configurable: true,
        get() {
          throw new Error('Facade getter used');
        },
      });
  const binding = ready.bind(f.parameters);
  assert.equal(binding.update(), true);
  f.mediaValues.get(f.audio).src = 'changed';
  assert.equal(binding.update(), false);
  assert.equal(f.counts.failures, 0);
  await f.adapter.dispose();
});

test('dynamic proxy and leaf replacements remain restricted to current membership', async () => {
  const f = fixture();
  const binding = (await f.adapter.prepare(f.audio)).bind(f.parameters);
  const nextLeaf = f.leafFor();
  f.middle._player = nextLeaf;
  const matches = f.coreBindings[0].hooks.sourceMatches;
  assert.equal(matches(nextLeaf), true);
  assert.equal(matches(f.leaf), false);
  assert.equal(matches(f.outer), true);
  assert.equal(matches({}), false);
  assert.equal(binding.update(), true);
  await f.adapter.dispose();
});

test('owned implementation failures route to the matching handback promise', async () => {
  const f = fixture();
  let resolve;
  let received;
  const handback = new Promise((done) => {
    resolve = done;
  });
  const binding = (await f.adapter.prepare(f.audio)).bind({
    ...f.parameters,
    onFailure(error) {
      received = error;
      return handback;
    },
  });
  f.prototypes.HTML5PlayerBase._getPosition = function () {};
  assert.equal(binding.update(), false);
  assert.equal(binding.active, false);
  assert.ok(unsupported(received));
  let complete = false;
  binding.restoration.then(() => {
    complete = true;
  });
  await Promise.resolve();
  assert.equal(complete, false);
  resolve();
  await binding.restoration;
  assert.equal(complete, true);
  await f.adapter.dispose();
});

test('capture cleanup preserves unrelated packets and foreign replacement registrations', async () => {
  const foreignPacket = [[], {}, []];
  let foreignId;
  const foreignFactory = () => {};
  const f = fixture({
    push({ packet, runtime, queue }) {
      foreignId = packet[2][0][0];
      runtime.m[foreignId] = foreignFactory;
      Array.prototype.push.call(queue, foreignPacket);
    },
  });
  await assert.rejects(f.adapter.prepare(f.audio), unsupported);
  assert.equal(f.runtime.m[foreignId], foreignFactory);
  assert.equal(Object.hasOwn(f.runtime.c, foreignId), false);
  assert.deepEqual(f.queue.slice(), [foreignPacket]);
  assert.equal(f.counts.hostFactories, 0);
  await f.adapter.dispose();
});

test('rejected diagnostic exports leave no owned factory, cache entry or packet', async () => {
  for (const shape of ['nonwritable', 'accessor', 'missing'])
    for (const configurable of [false, true]) {
      let reads = 0;
      let module;
      let descriptor;
      const f = fixture({
        diagnostic(capture) {
          module = capture.module;
          if (shape === 'missing') delete module.exports;
          if (shape === 'nonwritable')
            Object.defineProperty(module, 'exports', {
              value: {},
              writable: false,
              configurable,
            });
          if (shape === 'accessor')
            Object.defineProperty(module, 'exports', {
              configurable,
              get() {
                reads++;
                throw new Error('Diagnostic exports getter executed');
              },
            });
          descriptor = own(module, 'exports');
          Array.prototype.push.call(capture.queue, capture.packet);
        },
      });
      await assert.rejects(f.adapter.prepare(f.audio), unsupported);
      assert.equal(reads, 0);
      assert.equal(f.counts.captures, 1);
      assert.equal(f.counts.digests, 0);
      assert.equal(f.counts.clocks, 0);
      assert.deepEqual(own(module, 'exports'), descriptor);
      assertClean(f);
      await f.adapter.dispose();
    }
});

test('rejected diagnostic cleanup preserves foreign cache and exports descriptor replacements', async () => {
  for (const change of ['cache', 'value', 'flags', 'getter']) {
    let id;
    let module;
    let reads = 0;
    const foreign = {};
    const f = fixture({
      diagnostic(capture) {
        ({ id, module } = capture);
        Object.defineProperty(module, 'exports', {
          value: {},
          writable: false,
          configurable: true,
          enumerable: true,
        });
      },
      captureFailure(capture) {
        if (change === 'cache') capture.runtime.c[id] = foreign;
        if (change === 'value')
          Object.defineProperty(module, 'exports', { value: foreign });
        if (change === 'flags')
          Object.defineProperty(module, 'exports', { enumerable: false });
        if (change === 'getter')
          Object.defineProperty(module, 'exports', {
            get() {
              reads++;
              return foreign;
            },
          });
      },
    });
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    assert.equal(f.runtime.c[id], change === 'cache' ? foreign : module);
    assert.equal(Object.hasOwn(f.runtime.m, id), false);
    assert.equal(reads, 0);
    assert.equal(f.counts.hostFactories, 0);
    assert.equal(f.queue.length, 0);
    await f.adapter.dispose();
  }
});

test('preparation revalidates after asynchronous hashing and shares pending work', async () => {
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const f = fixture({
    digest: async (...args) => {
      await gate;
      return webcrypto.subtle.digest(...args);
    },
  });
  const tasks = Array.from({ length: 8 }, () => f.adapter.prepare(f.audio));
  await assert.rejects(f.adapter.prepare(f.audio), unsupported);
  assert.equal(f.counts.captures, 1);
  assertClean(f);
  f.mediaValues.get(f.audio).src = 'changed';
  resume();
  for (const task of tasks) await assert.rejects(task, stale);
  await f.adapter.dispose();
});

test('disposal invalidates pending preparations and retains one completion', async () => {
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const f = fixture({
    digest: async (...args) => {
      await gate;
      return webcrypto.subtle.digest(...args);
    },
  });
  const task = f.adapter.prepare(f.audio);
  const disposal = f.adapter.dispose();
  assert.equal(f.adapter.dispose(), disposal);
  resume();
  await assert.rejects(task, stale);
  await disposal;
  assert.equal(f.adapter.dispose(), disposal);
  await assert.rejects(f.adapter.prepare(f.audio), stale);
  assertClean(f);
});

test('a second bound source reuses the validated core without rediscovery', async () => {
  const f = fixture();
  const first = (await f.adapter.prepare(f.audio)).bind(f.parameters);
  first.release();
  const audio = new f.Media();
  f.middle._player = f.leafFor(audio);
  const second = (await f.adapter.prepare(audio)).bind(f.parameters);
  assert.equal(second.active, true);
  assert.equal(f.counts.clocks, 1);
  assert.equal(f.counts.captures, 1);
  await f.adapter.dispose();
});

test('a cold native currentSrc settling does not change an explicit source identity', async () => {
  const f = fixture();
  const values = f.mediaValues.get(f.audio);
  values.currentSrc = '';
  const ready = await f.adapter.prepare(f.audio);
  values.currentSrc = values.src;
  const binding = ready.bind(f.parameters);
  values.currentSrc = 'previously-selected-source';
  assert.equal(binding.update(), true);
  values.src = 'blob:next-source';
  assert.equal(binding.update(), false);
  await f.adapter.dispose();
});

test('currentSrc remains an exact fallback when explicit src is empty', async () => {
  const f = fixture();
  f.mediaValues.get(f.audio).src = '';
  const binding = (await f.adapter.prepare(f.audio)).bind(f.parameters);
  assert.equal(binding.update(), true);
  f.mediaValues.get(f.audio).currentSrc = 'blob:next-source';
  assert.equal(binding.update(), false);
  await f.adapter.dispose();
});

test('owned dynamic synchronization uses the core guard rather than forcing handback', async () => {
  const f = fixture({ realClock: true });
  const binding = (await f.adapter.prepare(f.audio)).bind({
    ...f.parameters,
    snapshot: () => ({ position: 2, duration: 2, paused: true, ended: true }),
  });
  f.outer._synced = false;
  const state = { ready: true, ended: false, duration: 2000 };
  f.outer._updateEndedInState(state);
  assert.equal(state.ended, false);
  assert.equal(binding.active, true);
  assert.equal(f.counts.failures, 0);
  f.outer._synced = true;
  f.outer._updateEndedInState(state);
  assert.equal(state.ended, true);
  await f.adapter.dispose();
});

test('uninitialized queues and queue accessors are rejected before capture', async () => {
  for (const mode of ['plain', 'getter', 'frozen']) {
    const f = fixture();
    let reads = 0;
    if (mode === 'plain') f.window.webpackJsonp = [];
    if (mode === 'getter')
      Object.defineProperty(f.window, 'webpackJsonp', {
        get() {
          reads++;
          return f.queue;
        },
      });
    if (mode === 'frozen') Object.freeze(f.queue);
    await assert.rejects(f.adapter.prepare(f.audio), unsupported);
    assert.equal(reads, 0);
    assert.equal(f.counts.captures, 0);
    await f.adapter.dispose();
  }
});

test('loaded-module retry succeeds without a persistent discovery hook', async () => {
  const f = fixture();
  f.runtime.c[572].l = false;
  await assert.rejects(f.adapter.prepare(f.audio), unsupported);
  assertClean(f);
  f.runtime.c[572].l = true;
  const ready = await f.adapter.prepare(f.audio);
  assert.equal(f.counts.captures, 2);
  assertClean(f);
  const binding = ready.bind(f.parameters);
  binding.release();
  await f.adapter.dispose();
});

test('method descriptor drift during hashing rejects the completed preparation', async () => {
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const f = fixture({
    digest: async (...args) => {
      await gate;
      return webcrypto.subtle.digest(...args);
    },
  });
  const task = f.adapter.prepare(f.audio);
  const prototype = f.prototypes.BasePlayer;
  Object.defineProperty(prototype, '_updateEndedInState', {
    ...own(prototype, '_updateEndedInState'),
    enumerable: true,
  });
  resume();
  await assert.rejects(task, unsupported);
  assertClean(f);
  await f.adapter.dispose();
});

test('cleanup never deletes a diagnostic cache entry whose exports were replaced', async () => {
  let id;
  const replacement = {};
  const f = fixture({
    push({ packet, runtime }) {
      id = packet[2][0][0];
      runtime.c[id].exports = replacement;
    },
  });
  await assert.rejects(f.adapter.prepare(f.audio), unsupported);
  assert.equal(f.runtime.c[id].exports, replacement);
  assert.equal(Object.hasOwn(f.runtime.m, id), false);
  assert.equal(f.queue.length, 0);
  await f.adapter.dispose();
});

test('invalid native receivers and stream-object sources fail with an actionable error', async () => {
  const f = fixture();
  await assert.rejects(
    f.adapter.prepare(Object.create(f.Media.prototype)),
    unsupported,
  );
  f.mediaValues.get(f.audio).srcObject = {};
  await assert.rejects(f.adapter.prepare(f.audio), unsupported);
  assert.equal(f.counts.captures, 0);
  await f.adapter.dispose();
});

test('repeated real-core lifecycles distinguish pending bindings from installed guards', async () => {
  const f = fixture({ realClock: true });
  const original = own(f.prototypes.BasePlayer, '_updateEndedInState');
  for (let index = 0; index < 5; index++) {
    const binding = (await f.adapter.prepare(f.audio)).bind(f.parameters);
    assert.equal(f.leaf._getTruePosition(), 500);
    assert.equal(binding.update(), true);
    assert.equal(binding.release(), true);
    await binding.restoration;
    assert.equal(binding.active, false);
    assert.deepEqual(
      own(f.prototypes.BasePlayer, '_updateEndedInState'),
      original,
    );
    assert.equal(f.leaf._duration, 1000);
    assert.equal(f.leaf.provided, 1000);
  }
  assert.equal(f.counts.captures, 1);
  assert.equal(f.counts.digests, 6);
  await f.adapter.dispose();
  assertClean(f);
});

test('overlapping real-core bindings keep shared guards until the final release', async () => {
  const f = fixture({ realClock: true });
  const original = own(f.prototypes.BasePlayer, '_updateEndedInState');
  const first = (await f.adapter.prepare(f.audio)).bind(f.parameters);
  assert.equal(f.leaf._getTruePosition(), 500);
  first.update();
  await Promise.resolve();
  const audio = new f.Media();
  const leaf = f.leafFor(audio);
  f.middle._player = leaf;
  const second = (await f.adapter.prepare(audio)).bind(f.parameters);
  assert.equal(first.active, true);
  assert.equal(leaf._getTruePosition(), 500);
  assert.equal(second.update(), true);
  first.release();
  await first.restoration;
  assert.equal(second.active, true);
  assert.notEqual(
    own(f.prototypes.BasePlayer, '_updateEndedInState').value,
    original.value,
  );
  assert.equal(leaf._getTruePosition(), 500);
  second.release();
  await second.restoration;
  assert.deepEqual(
    own(f.prototypes.BasePlayer, '_updateEndedInState'),
    original,
  );
  assert.equal(leaf._duration, 1000);
  assert.equal(leaf.provided, 1000);
  assert.equal(f.counts.captures, 1);
  await f.adapter.dispose();
});
