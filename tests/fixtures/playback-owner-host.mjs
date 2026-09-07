import assert from 'node:assert/strict';
import { createPlaybackOwner } from '../../src/audio/playback-owner.mjs';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function settle() {
  for (let index = 0; index < 100; index++) await Promise.resolve();
}

export function observe(promise) {
  const result = { status: 'pending' };
  result.done = Promise.resolve(promise).then(
    (value) => Object.assign(result, { status: 'fulfilled', value }),
    (error) => Object.assign(result, { status: 'rejected', error }),
  );
  return result;
}

export const settings = (
  mode = 'natural',
  rate = 0.025,
  track = '/artist/track',
) => ({
  mode,
  rate,
  track,
});

export function fixture(t, options = {}) {
  const native = new WeakMap();
  const events = [];
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
  const queued = [];
  const changes = [];
  const errors = [];
  const engines = [];
  const sources = [];
  const leases = [];
  const preparations = [];
  const bindings = [];
  const liveGraphs = new Set();
  let timerId = 0;
  const hostClock = {
    async prepare(audio) {
      const plan = options.plans?.[preparations.length] ?? {};
      preparations.push({ audio, plan });
      events.push('prepare');
      await plan.prepareGate?.promise;
      if (plan.prepareError) throw plan.prepareError;
      if ('prepared' in plan) return plan.prepared;
      return {
        bind(callbacks) {
          events.push('host-bind');
          if (plan.bindError) throw plan.bindError;
          const record = {
            audio,
            plan,
            callbacks,
            updates: [],
            active: true,
            restoration: null,
            releases: 0,
            restored: false,
            updateError: null,
          };
          function restore() {
            return Promise.resolve(plan.restoreGate?.promise).then(() => {
              if (plan.restoreError) throw plan.restoreError;
              record.restored = callbacks.sourceMatches();
              events.push(record.restored ? 'host-restored' : 'host-stale');
            });
          }
          record.fail = (error) => {
            record.active = false;
            record.restoration = Promise.resolve()
              .then(() => callbacks.onFailure(error))
              .then(() => {
                events.push('failure-native-returned');
                return restore();
              });
            record.restoration.catch(() => {});
            return record.restoration;
          };
          const binding = {
            update() {
              events.push('host-update');
              if (record.updateError) throw record.updateError;
              if (plan.initialUpdateError) throw plan.initialUpdateError;
              if (record.returnFalse) return false;
              assert.equal(
                record.active,
                true,
                'An inactive host must not update',
              );
              assert.equal(
                callbacks.sourceMatches(),
                true,
                'A stale host must not update',
              );
              record.updates.push({
                snapshot: callbacks.snapshot(),
                mediaPosition: audio.currentTime,
                mediaPaused: audio.paused,
              });
            },
            release() {
              events.push('host-release');
              record.releases++;
              record.active = false;
              record.restoration ??= restore();
              record.restoration.catch(() => {});
            },
            get active() {
              return record.active;
            },
            get restoration() {
              return record.restoration ?? Promise.resolve();
            },
          };
          record.binding = binding;
          bindings.push(record);
          return binding;
        },
      };
    },
  };
  const owner = createPlaybackOwner({
    prototype: Media.prototype,
    hostClock: options.noHost ? null : hostClock,
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
    onChange(audio, state) {
      changes.push({ audio, state });
      options.onChange?.(audio, state);
    },
    onError: (error) => errors.push(error),
    acquireGraph(audio, hooks) {
      assert.equal(
        liveGraphs.has(audio),
        false,
        'Graph cannot have overlapping owners',
      );
      liveGraphs.add(audio);
      events.push('graph-acquire');
      const controller = new AbortController();
      const lease = {
        audio,
        context,
        input: { context },
        releases: [],
        ready: Promise.resolve().then(() =>
          hooks.parkNative({ signal: controller.signal }),
        ),
        async release(position, { restore }) {
          events.push('native-release-start');
          controller.abort();
          lease.releases.push({ position, restore });
          await options.nativeReleaseGate?.promise;
          if (options.nativeReleaseError) throw options.nativeReleaseError;
          await hooks.restoreNative({
            position,
            restore,
            signal: new AbortController().signal,
          });
          liveGraphs.delete(audio);
          events.push('native-released');
        },
      };
      leases.push(lease);
      return lease;
    },
    async resolveSource(audio, { signal }) {
      sources.push({ audio, signal });
      return { playlistUrl: 'https://test.sndcdn.com/audio.m3u8', sourceId: 1 };
    },
    async createEngine({ mode }) {
      const stats = { mode, leases: 0, providerDisposed: 0, outputDisposed: 0 };
      engines.push(stats);
      return {
        provider: {
          async info() {
            return { sampleRate: 48000, channels: 2, durationHint: 120 };
          },
          async acquire(start, end) {
            stats.leases++;
            return {
              sampleRate: 48000,
              pcmStartFrame: start,
              channels: [
                new Float32Array(end - start),
                new Float32Array(end - start),
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
          schedule: ({ clock }) => clock,
          truncate() {},
          reset() {},
          dispose() {
            stats.outputDisposed++;
          },
        },
      };
    },
  });
  t.after(async () => {
    options.nativeReleaseError = null;
    options.nativeReleaseGate?.resolve();
    for (const plan of options.plans ?? []) {
      plan.prepareGate?.resolve();
      plan.restoreGate?.resolve();
    }
    await owner.dispose().catch(() => {});
  });
  const f = {
    owner,
    audio: new Media(),
    Media,
    native,
    context,
    events,
    tasks,
    changes,
    errors,
    engines,
    sources,
    leases,
    preparations,
    bindings,
    liveGraphs,
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
      f.flush();
    },
    async play() {
      const playing = f.audio.play();
      await settle();
      await f.advance(context.currentTime + 0.3);
      await playing;
    },
  };
  return f;
}
