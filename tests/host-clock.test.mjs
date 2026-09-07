import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostClock } from '../src/audio/host-clock.mjs';

function fixture(options = {}) {
  const queue = [];
  const failures = [];
  class BasePlayer {
    constructor() {
      this.state = { ready: true, ended: false, position: 0, duration: 1000 };
      this.listeners = new Set();
      this.nativeEndedCalls = 0;
    }
    _updateEndedInState(state, marker) {
      this.nativeEndedCalls++;
      const position =
        state.seek?.state === 'IN_PROGRESS'
          ? state.seek.position
          : state.position;
      state.ended = state.ready && position === state.duration;
      return marker;
    }
    refresh() {
      this.state.position = this._getPosition();
      this._updateEndedInState(this.state);
      this._updateEndedInState(this.state);
      return this.state;
    }
    getPosition() {
      const state = this.refresh();
      return state.seek?.state === 'IN_PROGRESS'
        ? state.seek.position
        : state.position;
    }
    pause() {
      this._player ? this._player.pause() : this.getMediaElement().pause();
    }
  }
  class MediaPlayer extends BasePlayer {
    constructor(media, duration = 1000) {
      super();
      this._mediaElementAndState = { element: media, state: 'USABLE' };
      this._duration = duration;
      this.state.duration = duration;
      this.durationUpdates = [];
      this.nativeClockCalls = 0;
      this.nativeEndedChecks = 0;
      this.inPositionRead = false;
    }
    getMediaElement() {
      return this._mediaElementAndState?.element;
    }
    _getTruePosition(offset = 0) {
      if (this._mediaElementAndState?.state !== 'USABLE')
        throw new Error('Media element is not usable');
      this.nativeClockCalls++;
      return this.getMediaElement().nativePosition + offset;
    }
    _shouldBeEnded() {
      this.nativeEndedChecks++;
      return this.getMediaElement().nativeEnded;
    }
    _getPosition() {
      this.inPositionRead = true;
      try {
        const duration = this._duration;
        return this._shouldBeEnded()
          ? duration
          : Math.min(duration, this._getTruePosition());
      } finally {
        this.inPositionRead = false;
      }
    }
    _handleDurationChange() {
      assert.equal(this.inPositionRead, false);
      this.state.duration = this._duration;
      this.durationUpdates.push(this._duration);
      for (const listener of [...this.listeners]) listener(this.state.duration);
    }
  }
  class HlsPlayer extends MediaPlayer {
    _shouldBeEnded() {
      this.nativeEndedChecks++;
      return this.safariStall || this.getMediaElement().nativeEnded;
    }
  }
  class ProxyPlayer extends BasePlayer {
    constructor(child) {
      super();
      this._player = null;
      this._lastPlayerPosition = 0;
      this._synced = false;
      this.syncObservations = [];
      this._providePlayer(child);
    }
    _providePlayer(child) {
      this.unsubscribe?.();
      if (this._player && this._synced)
        this._lastPlayerPosition = this._player.getPosition();
      this._synced = false;
      this._player = child;
      const receive = (duration) => {
        this.state.duration = duration;
        this.refresh();
        for (const listener of [...this.listeners]) listener(duration);
      };
      child.listeners.add(receive);
      this.unsubscribe = () => child.listeners.delete(receive);
      receive(child.state.duration);
      this.syncObservations.push({ ...this.state, synced: this._synced });
      this._synced = true;
      this.refresh();
    }
    _getPosition() {
      return this._synced
        ? this._player.getPosition()
        : this._lastPlayerPosition;
    }
  }
  const adapterOptions = {
    basePrototype: BasePlayer.prototype,
    mediaPrototype: MediaPlayer.prototype,
    leafPrototypes: [HlsPlayer.prototype],
    enqueue: (callback) => queue.push(callback),
    onFailure: (media, error) => failures.push({ media, error }),
    ...options,
  };
  const adapter = createHostClock(adapterOptions);
  const flush = () => {
    for (let count = 0; queue.length; count++) {
      assert.ok(count < 100, 'duration propagation remains bounded');
      queue.shift()();
    }
  };
  const make = ({ duration = 1000, hint = 1, position = 0.99 } = {}) => {
    const state = {
      position,
      paused: false,
      ended: false,
      duration: null,
      durationHint: hint,
    };
    const media = {
      nativePosition: 1500,
      nativeEnded: false,
      pauses: 0,
      pause() {
        this.pauses++;
        state.paused = true;
      },
    };
    const leaf = new HlsPlayer(media, duration);
    let sourceCurrent = true;
    let acceptedLeaf = leaf;
    const binding = adapter.bind(media, {
      snapshot: () => ({ ...state }),
      sourceMatches: (player) =>
        sourceCurrent && (!player || player === acceptedLeaf),
    });
    return {
      state,
      media,
      leaf,
      binding,
      sourceChanged() {
        sourceCurrent = false;
      },
      accept(player) {
        acceptedLeaf = player;
      },
    };
  };
  return {
    adapter,
    adapterOptions,
    make,
    flush,
    failures,
    BasePlayer,
    MediaPlayer,
    HlsPlayer,
    ProxyPlayer,
  };
}

test('native and unowned calls retain return values, receivers and arguments', () => {
  const f = fixture();
  const owned = f.make();
  const media = { nativePosition: 123, nativeEnded: false };
  const player = new f.HlsPlayer(media);
  assert.equal(player._getTruePosition(7), 130);
  const state = { ready: true, position: 1, duration: 1 };
  const marker = {};
  assert.equal(player._updateEndedInState(state, marker), marker);
  assert.equal(state.ended, true);
  assert.equal(player.nativeEndedCalls, 1);
  assert.equal(player.nativeClockCalls, 1);
  owned.binding.release();
  f.flush();
  assert.deepEqual(f.failures, []);
});

test('truthful clock handles rate changes, pause and buffering without extrapolation', () => {
  const f = fixture();
  const value = f.make();
  for (const position of [0.2, 0.200625, 0.22, 0.45, 0.45]) {
    value.state.position = position;
    assert.equal(value.leaf._getTruePosition(), position * 1000);
  }
  value.state.paused = true;
  assert.equal(value.leaf._getTruePosition(), 450);
  assert.equal(value.leaf.nativeClockCalls, 0);
  f.flush();
  assert.deepEqual(f.failures, []);
  f.adapter.dispose();
});

test('a failing host-state probe releases ownership and calls the native method once', async () => {
  const f = fixture();
  const value = f.make();
  const state = new Proxy(
    { ready: true, position: 1, duration: 1 },
    {
      getOwnPropertyDescriptor(target, name) {
        if (name === 'seek') throw new Error('Host state shape changed');
        return Reflect.getOwnPropertyDescriptor(target, name);
      },
    },
  );
  const marker = {};
  assert.equal(value.leaf._updateEndedInState(state, marker), marker);
  assert.equal(value.leaf.nativeEndedCalls, 1);
  assert.equal(state.ended, true);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].error.message, /Host state shape changed/);
  assert.equal(value.leaf._getTruePosition(), value.media.nativePosition);
  await Promise.resolve();
  f.flush();
  await f.adapter.dispose();
});

test('native exceptions are not intercepted or retried by the host guard', async () => {
  const f = fixture();
  const value = f.make();
  value.leaf._mediaElementAndState.state = 'UNUSABLE';
  assert.throws(
    () => value.leaf._getTruePosition(),
    /Media element is not usable/,
  );
  assert.equal(f.failures.length, 0);
  value.leaf._mediaElementAndState.state = 'USABLE';
  assert.equal(value.leaf._getTruePosition(), value.state.position * 1000);
  f.flush();
  await f.adapter.dispose();
});

test('unsupported host identity skips duration synchronization without rejecting native handback', async () => {
  const f = fixture();
  const value = f.make();
  value.binding.release();
  f.flush();
  await value.binding.restoration;
  let changed = false;
  const error = Object.assign(new Error('Host implementation changed'), { code: 'SOUNDCLOUD_HOST_UNSUPPORTED' });
  const binding = f.adapter.bind(value.media, {
    snapshot: () => ({ ...value.state }),
    sourceMatches: () => {
      if (changed) throw error;
      return true;
    },
  });
  value.leaf._getTruePosition();
  f.flush();
  const updates = value.leaf.durationUpdates.length;
  changed = true;
  assert.equal(value.leaf._getTruePosition(), value.media.nativePosition);
  await Promise.resolve();
  f.flush();
  await binding.restoration;
  assert.equal(value.leaf.durationUpdates.length, updates);
  assert.equal(f.failures.length, 1);
  await f.adapter.dispose();
});

test('every dynamically created proxy stays unended at an underestimated hint', () => {
  const f = fixture();
  const value = f.make({ position: 1.4 });
  const middle = new f.ProxyPlayer(value.leaf);
  const outer = new f.ProxyPlayer(middle);
  f.flush();
  for (const player of [value.leaf, middle, outer]) {
    assert.equal(player.getPosition(), 1000);
    assert.equal(player.state.ended, false);
    assert.equal(player.nativeEndedCalls, 0);
  }
  assert.equal(value.media.pauses, 0);
  value.state.duration = 1.5;
  value.binding.update();
  for (const player of [value.leaf, middle, outer]) {
    assert.equal(player.state.duration, 1500);
    assert.equal(player.getPosition(), 1400);
    assert.equal(player.state.ended, false);
  }
  value.state.position = 1.5;
  value.state.ended = true;
  value.state.duration = value.state.position;
  value.state.paused = true;
  outer.refresh();
  for (const player of [value.leaf, middle, outer])
    assert.equal(player.state.ended, true);
  assert.equal(value.media.pauses, 0);
  assert.deepEqual(f.failures, []);
  f.adapter.dispose();
});

test('unknown hint does not force a pause or completion', () => {
  const f = fixture();
  const value = f.make({ duration: 800, hint: null, position: 0.95 });
  const proxy = new f.ProxyPlayer(value.leaf);
  assert.equal(value.leaf._getTruePosition(), 950);
  assert.equal(proxy.state.ended, false);
  f.flush();
  assert.equal(value.media.pauses, 0);
  assert.equal(value.leaf._duration, 800);
  value.state.duration = 1.2;
  value.binding.update();
  assert.equal(proxy.state.duration, 1200);
  assert.equal(proxy.getPosition(), 950);
  assert.deepEqual(f.failures, []);
  f.adapter.dispose();
});

test('owned HLS bypasses stall-based completion and preserves readiness', () => {
  const f = fixture();
  const value = f.make();
  const assertOwned = () => {
    assert.equal(value.binding.active, true);
    assert.deepEqual(f.failures, []);
    assert.equal(value.leaf.nativeEndedChecks, 0);
    assert.equal(value.leaf.nativeEndedCalls, 0);
    assert.equal(value.leaf.nativeClockCalls, 0);
  };
  value.leaf.safariStall = true;
  value.media.nativeEnded = true;
  assert.equal(value.leaf._shouldBeEnded(), false);
  assertOwned();
  value.state.paused = true;
  assert.equal(value.leaf._shouldBeEnded(), false);
  assertOwned();
  value.state.position = 1.25;
  value.state.duration = 1.25;
  value.state.ended = true;
  value.leaf.state.ready = false;
  value.leaf.refresh();
  assert.equal(value.leaf.state.ended, false);
  assertOwned();
  value.leaf.state.ready = true;
  value.leaf.refresh();
  assert.equal(value.leaf.state.ended, true);
  assertOwned();
  f.flush();
  assertOwned();
  f.adapter.dispose();
});

test('duration propagation occurs outside reads and coalesces host assignments', () => {
  const f = fixture();
  const value = f.make();
  value.leaf.getPosition();
  assert.deepEqual(value.leaf.durationUpdates, []);
  value.leaf._duration = 1100;
  value.leaf._duration = 1200;
  assert.equal(value.leaf._duration, 1000);
  f.flush();
  assert.deepEqual(value.leaf.durationUpdates, [1000]);
  const originalFlags = {
    enumerable: true,
    configurable: true,
    writable: true,
  };
  value.binding.release();
  assert.deepEqual(Object.getOwnPropertyDescriptor(value.leaf, '_duration'), {
    ...originalFlags,
    value: 1200,
  });
  f.flush();
  assert.deepEqual(value.leaf.durationUpdates, [1000, 1200]);
  assert.equal(value.leaf.state.duration, 1200);
  assert.deepEqual(f.failures, []);
});

test('real Pause and replacement commands remain immediate', () => {
  const f = fixture();
  const value = f.make();
  const proxy = new f.ProxyPlayer(value.leaf);
  proxy.pause();
  assert.equal(value.media.pauses, 1);
  assert.equal(value.state.paused, true);
  const replacement = new f.HlsPlayer(value.media, 1700);
  value.accept(replacement);
  proxy._providePlayer(replacement);
  f.flush();
  assert.equal(proxy._player, replacement);
  assert.equal(proxy.state.ended, false);
  assert.equal(replacement._getTruePosition(), 990);
  assert.equal(value.leaf._getTruePosition(), value.media.nativePosition);
  assert.deepEqual(f.failures, []);
  f.adapter.dispose();
});

test('source mismatch invalidates synchronously and queued work cannot attach to a new generation', () => {
  const f = fixture();
  const value = f.make();
  value.leaf._getTruePosition();
  value.sourceChanged();
  assert.equal(value.leaf._getTruePosition(), value.media.nativePosition);
  assert.equal(value.binding.active, false);
  assert.equal(value.leaf._duration, 1000);
  f.flush();
  assert.deepEqual(value.leaf.durationUpdates, []);
  const replacement = new f.HlsPlayer(value.media, 1800);
  const nextState = { position: 0.1, duration: 2, paused: false, ended: false };
  const next = f.adapter.bind(value.media, {
    snapshot: () => nextState,
    sourceMatches: (player) => !player || player === replacement,
  });
  assert.equal(value.leaf._getTruePosition(), value.media.nativePosition);
  assert.equal(replacement._getTruePosition(), 100);
  f.flush();
  assert.equal(replacement._duration, 2000);
  assert.equal(next.active, true);
  assert.deepEqual(f.failures, []);
  f.adapter.dispose();
});

test('last release restores prototypes while remaining bindings keep their guards', () => {
  const f = fixture();
  const original = Object.getOwnPropertyDescriptors(f.MediaPlayer.prototype);
  const first = f.make();
  const second = f.make({ position: 0.5 });
  first.leaf._getTruePosition();
  second.leaf._getTruePosition();
  first.binding.release();
  assert.equal(second.leaf._getTruePosition(), 500);
  second.binding.release();
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(f.MediaPlayer.prototype),
    original,
  );
  f.flush();
  assert.deepEqual(f.failures, []);
});

test('frozen and changed method descriptors fail before any patch is applied', () => {
  const f = fixture();
  const original = Object.getOwnPropertyDescriptor(
    f.BasePlayer.prototype,
    '_updateEndedInState',
  );
  Object.defineProperty(f.MediaPlayer.prototype, '_getTruePosition', {
    configurable: false,
  });
  assert.throws(() => f.make(), /changed externally/);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(
      f.BasePlayer.prototype,
      '_updateEndedInState',
    ),
    original,
  );
  assert.throws(
    () => createHostClock(f.adapterOptions),
    /Unsupported host method/,
  );
});

test('unknown and frozen leaf descriptors release with a recoverable failure', () => {
  for (const change of [
    (leaf) => Object.defineProperty(leaf, '_duration', { configurable: false }),
    (leaf) =>
      Object.defineProperty(leaf, '_shouldBeEnded', {
        value: () => true,
        configurable: true,
      }),
  ]) {
    const f = fixture();
    const value = f.make();
    change(value.leaf);
    value.leaf._getTruePosition();
    assert.equal(value.binding.active, false);
    assert.equal(f.failures.length, 1);
    assert.match(f.failures[0].error.message, /Unsupported owned host player/);
    f.flush();
  }
});

test('conflicting external duration and prototype changes are never overwritten', () => {
  const f = fixture();
  const value = f.make();
  value.leaf._getTruePosition();
  Object.defineProperty(value.leaf, '_duration', {
    value: 3333,
    configurable: true,
    writable: true,
  });
  const foreign = () => 9999;
  f.MediaPlayer.prototype._getTruePosition = foreign;
  value.binding.update();
  assert.equal(value.binding.active, false);
  assert.equal(value.leaf._duration, 3333);
  assert.equal(f.MediaPlayer.prototype._getTruePosition, foreign);
  assert.equal(f.failures.length, 1);
  f.flush();
});

test('bad snapshots and source callbacks release without fabricated completion', () => {
  const f = fixture();
  const value = f.make();
  value.state.position = NaN;
  value.leaf._getTruePosition();
  assert.equal(value.binding.active, false);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].error.message, /snapshot/);
  assert.throws(
    () =>
      f.adapter.bind(
        {},
        {
          snapshot: () => ({ position: 0, ended: true, paused: false }),
          sourceMatches: () => true,
        },
      ),
    /snapshot/,
  );
  assert.throws(
    () =>
      f.adapter.bind(
        {},
        {
          snapshot: () => ({
            position: 1,
            duration: 2,
            ended: true,
            paused: true,
          }),
          sourceMatches: () => true,
        },
      ),
    /snapshot/,
  );
});

test('owned clock does not bypass host media initialization state', () => {
  const f = fixture();
  const value = f.make();
  value.leaf._mediaElementAndState.state = 'STABLE';
  assert.throws(() => value.leaf._getTruePosition(), /not usable/);
  assert.equal(value.binding.active, true);
  value.leaf._mediaElementAndState.state = 'USABLE';
  assert.equal(value.leaf._getTruePosition(), 990);
  f.adapter.dispose();
});

test('failed source validation is isolated to its binding', () => {
  const f = fixture();
  const value = f.make();
  let broken = false;
  const other = {};
  const binding = f.adapter.bind(other, {
    snapshot: () => ({ position: 0, ended: false, paused: true }),
    sourceMatches() {
      if (broken) throw new Error('source validation failed');
      return true;
    },
  });
  broken = true;
  binding.update();
  assert.equal(binding.active, false);
  assert.equal(value.binding.active, true);
  assert.equal(value.leaf._getTruePosition(), 990);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].media, other);
  f.adapter.dispose();
});

test('release propagates restored duration through the current proxy chain', () => {
  const f = fixture();
  const value = f.make();
  const proxy = new f.ProxyPlayer(value.leaf);
  value.state.duration = 2;
  value.binding.update();
  assert.equal(proxy.state.duration, 2000);
  value.leaf._duration = 1200;
  value.binding.release();
  assert.equal(proxy.state.duration, 1200);
  assert.equal(value.leaf._duration, 1200);
  f.flush();
  assert.equal(proxy.state.duration, 1200);
  assert.deepEqual(f.failures, []);
});

test('invalid unowned chains delegate without affecting an owned source', () => {
  const f = fixture({ maxDepth: 2 });
  const value = f.make();
  const one = new f.BasePlayer();
  const two = new f.BasePlayer();
  one._synced = two._synced = true;
  one._player = two;
  two._player = one;
  one._updateEndedInState(one.state);
  assert.equal(value.binding.active, true);
  assert.equal(f.failures.length, 0);
  const accessor = new f.BasePlayer();
  Object.defineProperty(accessor, '_player', {
    get() {
      assert.fail('private getter must not run');
    },
  });
  accessor._updateEndedInState(accessor.state);
  assert.equal(value.binding.active, true);
  assert.equal(f.failures.length, 0);
  f.adapter.dispose();
});

test('a caller-identified owned invalid chain fails without crossing the bound', () => {
  const f = fixture({ maxDepth: 2 });
  const one = new f.BasePlayer();
  const two = new f.BasePlayer();
  one._synced = two._synced = true;
  one._player = two;
  two._player = one;
  const binding = f.adapter.bind(
    {},
    {
      snapshot: () => ({ position: 0, paused: false, ended: false }),
      sourceMatches: (player) => !player || player === one,
    },
  );
  one._updateEndedInState(one.state);
  assert.equal(binding.active, false);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].error.message, /depth limit|Cyclic/);
});

test('duration and host-propagation failures restore owned descriptors', () => {
  const f = fixture();
  const value = f.make();
  value.leaf._getTruePosition();
  value.leaf.listeners.add(() => {
    throw new Error('host duration failure');
  });
  f.flush();
  assert.equal(value.binding.active, false);
  assert.equal(value.leaf._duration, 1000);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].error.message, /host duration failure/);
});

test('owned binding and leaf retention have fixed ceilings', () => {
  const f = fixture();
  for (let index = 0; index < 8; index++) f.make();
  assert.throws(() => f.make(), /Invalid host clock binding/);
  f.adapter.dispose();
  const next = fixture();
  const media = { nativePosition: 0, nativeEnded: false };
  const binding = next.adapter.bind(media, {
    snapshot: () => ({ position: 0, paused: false, ended: false }),
    sourceMatches: (player) => !player || player.getMediaElement() === media,
  });
  for (let index = 0; index < 9; index++)
    new next.HlsPlayer(media)._getTruePosition();
  assert.equal(binding.active, false);
  assert.equal(next.failures.length, 1);
  assert.match(next.failures[0].error.message, /player limit/);
  next.flush();
});

test('dispose restores current leaf and proxy cached durations', () => {
  const f = fixture();
  const value = f.make();
  const inner = new f.ProxyPlayer(value.leaf);
  const outer = new f.ProxyPlayer(inner);
  value.state.duration = 2;
  value.binding.update();
  value.leaf._duration = 1200;
  assert.equal(outer.state.duration, 2000);
  f.adapter.dispose();
  f.flush();
  for (const player of [value.leaf, inner, outer])
    assert.equal(player.state.duration, 1200);
  assert.equal(value.binding.active, false);
  assert.deepEqual(f.failures, []);
});

test('failure relinquishes playback immediately then restores duration outside the read', () => {
  let stopped = false;
  const errors = [];
  const f = fixture({
    onFailure(media, error) {
      stopped = true;
      media.nativePosition = 990;
      errors.push(error);
    },
  });
  const value = f.make();
  const proxy = new f.ProxyPlayer(value.leaf);
  value.state.duration = 2;
  value.binding.update();
  value.state.position = NaN;
  value.leaf._getTruePosition();
  assert.equal(stopped, true);
  assert.equal(value.binding.active, false);
  assert.equal(proxy.state.duration, 2000);
  f.flush();
  assert.equal(value.leaf.state.duration, 1000);
  assert.equal(proxy.state.duration, 1000);
  assert.equal(errors.length, 1);
});

test('failure restoration awaits asynchronous native handback', async () => {
  let finish;
  let stopped = false;
  const restored = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture({
    onFailure(media) {
      stopped = true;
      return restored.then(() => {
        media.nativePosition = 990;
      });
    },
  });
  const value = f.make();
  const proxy = new f.ProxyPlayer(value.leaf);
  value.state.duration = 2;
  value.binding.update();
  value.state.position = NaN;
  value.leaf._getTruePosition();
  assert.equal(stopped, true);
  f.flush();
  assert.equal(proxy.state.duration, 2000);
  finish();
  await restored;
  await Promise.resolve();
  f.flush();
  assert.equal(value.leaf.state.duration, 1000);
  assert.equal(proxy.state.duration, 1000);
});

test('source invalidation still skips stale duration synchronization on disposal', () => {
  const f = fixture();
  const value = f.make();
  const proxy = new f.ProxyPlayer(value.leaf);
  value.state.duration = 2;
  value.binding.update();
  const count = value.leaf.durationUpdates.length;
  value.sourceChanged();
  f.adapter.dispose();
  f.flush();
  assert.equal(value.leaf._duration, 1000);
  assert.equal(proxy.state.duration, 2000);
  assert.equal(value.leaf.durationUpdates.length, count);
  assert.deepEqual(f.failures, []);
});

test('in-progress seek away from actual EOF prevents completion through the chain', () => {
  const f = fixture();
  const value = f.make();
  const inner = new f.ProxyPlayer(value.leaf);
  const outer = new f.ProxyPlayer(inner);
  Object.assign(value.state, {
    position: 1,
    duration: 1,
    ended: true,
    paused: true,
  });
  value.binding.update();
  outer.refresh();
  assert.equal(outer.state.ended, true);
  for (const player of [value.leaf, inner, outer]) {
    player.state.seek = { state: 'IN_PROGRESS', position: 0 };
    player.refresh();
    assert.equal(player.getPosition(), 0);
    assert.equal(player.state.ended, false);
  }
  for (const player of [value.leaf, inner, outer]) {
    player.state.seek = { state: 'IN_PROGRESS', position: 1000 };
    player.refresh();
    assert.equal(player.state.ended, true);
  }
  assert.equal(value.binding.active, true);
  assert.deepEqual(f.failures, []);
  f.adapter.dispose();
});

test('an unsynchronized proxy cannot inherit EOF before initial position synchronization', () => {
  const f = fixture();
  const value = f.make();
  Object.assign(value.state, {
    position: 1,
    duration: 1,
    ended: true,
    paused: true,
  });
  const inner = new f.ProxyPlayer(value.leaf);
  const outer = new f.ProxyPlayer(inner);
  for (const player of [inner, outer]) {
    assert.equal(player.syncObservations[0].synced, false);
    assert.equal(player.syncObservations[0].position, 0);
    assert.equal(player.syncObservations[0].ended, false);
    assert.equal(player.state.ended, true);
  }
  inner._synced = false;
  outer.refresh();
  assert.equal(outer.state.ended, false);
  assert.equal(value.binding.active, true);
  assert.deepEqual(f.failures, []);
  f.adapter.dispose();
});

test('rejected native handback remains an observable restoration failure', async () => {
  const f = fixture({
    onFailure() {
      return Promise.reject(new Error('handback failed'));
    },
  });
  const value = f.make();
  const proxy = new f.ProxyPlayer(value.leaf);
  value.state.duration = 2;
  value.binding.update();
  value.state.position = NaN;
  value.leaf._getTruePosition();
  await assert.rejects(value.binding.restoration, /handback failed/);
  f.flush();
  assert.equal(proxy.state.duration, 2000);
  assert.equal(value.leaf._duration, 1000);
  assert.equal(value.binding.active, false);
});

test('disposal preserves its rejected completion rather than reporting a later success', async () => {
  const f = fixture();
  const value = f.make();
  new f.ProxyPlayer(value.leaf);
  value.state.duration = 2;
  value.binding.update();
  value.leaf.listeners.add(() => {
    throw new Error('restoration failed');
  });
  const completion = f.adapter.dispose();
  await assert.rejects(completion, /restoration failed/);
  assert.equal(f.adapter.dispose(), completion);
  await assert.rejects(value.binding.restoration, /restoration failed/);
  f.flush();
});

test('late handback completion cannot update a replacement source', async () => {
  let finish;
  const handback = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture({
    onFailure() {
      return handback;
    },
  });
  const value = f.make();
  const proxy = new f.ProxyPlayer(value.leaf);
  value.state.duration = 2;
  value.binding.update();
  value.state.position = NaN;
  value.leaf._getTruePosition();
  const updates = value.leaf.durationUpdates.length;
  value.sourceChanged();
  const replacement = new f.HlsPlayer(value.media, 3000);
  const binding = f.adapter.bind(value.media, {
    snapshot: () => ({ position: 0, duration: 3, paused: false, ended: false }),
    sourceMatches: (player) => !player || player === replacement,
  });
  finish();
  await handback;
  await Promise.resolve();
  f.flush();
  await value.binding.restoration;
  assert.equal(value.leaf.durationUpdates.length, updates);
  assert.equal(proxy.state.duration, 2000);
  assert.equal(binding.active, true);
  await f.adapter.dispose();
});

test('never-settling failure cleanup consumes the binding admission budget', () => {
  const f = fixture({
    onFailure() {
      return new Promise(() => {});
    },
  });
  for (let index = 0; index < 8; index++) {
    const value = f.make();
    value.state.position = NaN;
    value.leaf._getTruePosition();
    assert.equal(value.binding.active, false);
  }
  assert.throws(() => f.make(), /Invalid host clock binding/);
  const disposing = f.adapter.dispose();
  assert.equal(f.adapter.dispose(), disposing);
});

test('a previously settled restoration rejection remains visible to later disposal', async () => {
  const f = fixture({
    onFailure() {
      return Promise.reject(new Error('earlier handback failure'));
    },
  });
  const value = f.make();
  value.state.position = NaN;
  value.leaf._getTruePosition();
  await assert.rejects(value.binding.restoration, /earlier handback failure/);
  const disposing = f.adapter.dispose();
  await assert.rejects(disposing, /earlier handback failure/);
  assert.equal(f.adapter.dispose(), disposing);
});

test('empty rejection reasons cannot turn a failed restoration into successful disposal', async () => {
  const f = fixture({
    onFailure() {
      return Promise.reject();
    },
  });
  const value = f.make();
  value.state.position = NaN;
  value.leaf._getTruePosition();
  await assert.rejects(value.binding.restoration);
  await assert.rejects(f.adapter.dispose());
});

test('reentrant disposal shares the outer completion and its restoration failure', async () => {
  const f = fixture();
  const value = f.make();
  new f.ProxyPlayer(value.leaf);
  value.state.duration = 2;
  value.binding.update();
  let nested;
  const failure = new Error('reentrant restoration failed');
  value.leaf.listeners.add(() => {
    nested = f.adapter.dispose();
    throw failure;
  });
  const outer = f.adapter.dispose();
  const outcomes = await Promise.allSettled([nested, outer]);
  assert.equal(nested, outer);
  assert.deepEqual(outcomes, [
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  assert.equal(f.adapter.dispose(), outer);
  await assert.rejects(
    value.binding.restoration,
    /reentrant restoration failed/,
  );
  f.flush();
});

test('synchronous failure retries cannot bypass pending cleanup admission', () => {
  let attempts = 0;
  const values = [];
  const rejected = [];
  const f = fixture({
    onFailure() {
      attempts++;
      if (attempts < 12) {
        try {
          const value = f.make();
          values.push(value);
          value.state.position = NaN;
          value.leaf._getTruePosition();
        } catch (error) {
          rejected.push(error);
        }
      }
      return new Promise(() => {});
    },
  });
  const first = f.make();
  values.push(first);
  first.state.position = NaN;
  first.leaf._getTruePosition();
  assert.equal(attempts, 8);
  assert.equal(values.length, 8);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].message, /Invalid host clock binding/);
  assert.ok(values.every((value) => !value.binding.active));
  assert.throws(() => f.make(), /Invalid host clock binding/);
  f.adapter.dispose();
});

test('disposal inside failure handback observes the reserved restoration rejection', async () => {
  let nested;
  let restoration;
  let value;
  const failure = new Error('reentrant handback failed');
  const f = fixture({
    onFailure() {
      restoration = value.binding.restoration;
      nested = f.adapter.dispose();
      throw failure;
    },
  });
  value = f.make();
  value.state.position = NaN;
  value.leaf._getTruePosition();
  const outer = f.adapter.dispose();
  const outcomes = await Promise.allSettled([
    restoration,
    value.binding.restoration,
    nested,
    outer,
  ]);
  assert.equal(restoration, value.binding.restoration);
  assert.equal(nested, outer);
  assert.deepEqual(
    outcomes,
    Array.from({ length: 4 }, () => ({ status: 'rejected', reason: failure })),
  );
  assert.equal(f.adapter.dispose(), outer);
  f.flush();
});
