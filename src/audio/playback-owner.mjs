import { createBufferedTransport } from './buffered-transport.mjs';
import { createMediaFacade } from './media-facade.mjs';

const abortError = () =>
  new DOMException('Playback ownership changed', 'AbortError');

function waitFor(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function lazyEngine({
  ready,
  resolveSource,
  createEngine,
  context,
  destination,
  audio,
  mode,
}) {
  const lifetime = new AbortController();
  const listeners = new Set();
  const cleanups = new Map();
  let engine, loading, subscription;
  let closed = false;

  function check() {
    if (closed) throw abortError();
  }

  function ensure() {
    check();
    if (loading) return loading;
    loading = (async () => {
      await ready;
      check();
      const source = await resolveSource(audio, { signal: lifetime.signal });
      check();
      engine = await createEngine({
        context,
        destination,
        source,
        mode,
        signal: lifetime.signal,
      });
      check();
      if (!engine?.provider || !engine?.output)
        throw new TypeError(
          'The playback engine must own a provider and output',
        );
      subscription = engine.output.subscribeFailure?.((error) => {
        for (const listener of listeners) listener(error);
      });
      return engine;
    })();
    loading.catch(() => {
      if (!closed && !engine) loading = null;
    });
    return loading;
  }

  function disposePart(key) {
    if (cleanups.has(key)) return cleanups.get(key);
    closed = true;
    lifetime.abort();
    if (key === 'output') {
      subscription?.();
      subscription = null;
      listeners.clear();
    }
    let cleanup;
    try {
      cleanup = engine?.[key]
        ? Promise.resolve(engine[key].dispose())
        : Promise.resolve(loading)
            .catch(() => {})
            .then(() => engine?.[key]?.dispose());
    } catch (error) {
      cleanup = Promise.reject(error);
    }
    cleanups.set(key, cleanup);
    cleanup.catch(() => {});
    return cleanup;
  }

  const provider = {
    async info({ signal } = {}) {
      const value = await waitFor(ensure(), signal);
      if (signal?.aborted) throw abortError();
      return value.provider.info({ signal });
    },
    acquire: (...args) => engine.provider.acquire(...args),
    reset: () => engine?.provider?.reset(),
    dispose: () => disposePart('provider'),
  };
  const output = {
    async initialize(options) {
      const value = await waitFor(ensure(), options.signal);
      if (options.signal?.aborted) throw abortError();
      return value.output.initialize?.(options);
    },
    requiredPcmRange: (clock) => engine.output.requiredPcmRange?.(clock),
    get minimumLeadSeconds() {
      return engine?.output?.minimumLeadSeconds;
    },
    schedule: (input) => engine.output.schedule(input),
    truncate: (frame) => engine.output.truncate(frame),
    reset: () => engine?.output?.reset(),
    dispose: () => disposePart('output'),
    subscribeFailure(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { provider, output };
}

export function createPlaybackOwner({
  prototype = globalThis.HTMLMediaElement?.prototype,
  acquireGraph,
  resolveSource,
  createEngine,
  hostClock = null,
  onChange = () => {},
  onError = () => {},
  enqueue,
  timers,
} = {}) {
  if (
    !prototype ||
    (hostClock !== null && typeof hostClock?.prepare !== 'function') ||
    [acquireGraph, resolveSource, createEngine, onChange, onError].some(
      (value) => typeof value !== 'function',
    )
  )
    throw new TypeError(
      'Playback ownership requires media, graph, source and engine adapters',
    );
  const descriptors = Object.getOwnPropertyDescriptors(prototype);
  const raw = (audio, name) => descriptors[name]?.get?.call(audio);
  const nativeState = (audio) => ({
    position: raw(audio, 'currentTime') || 0,
    playing: !raw(audio, 'paused'),
    ended: raw(audio, 'ended') === true,
  });
  const owners = new Map();
  const closingOwners = new Map();
  const revisions = new WeakMap();
  const releases = new WeakMap();
  const pauses = new WeakMap();
  let closed = false;
  let disposal;
  const facade = createMediaFacade({ prototype, enqueue, onError: report });

  function report(error) {
    if (error?.name === 'AbortError') return;
    try {
      onError(error);
    } catch {}
  }

  function publish(audio, state) {
    try {
      onChange(audio, state);
    } catch (error) {
      report(error);
    }
  }

  function snapshot(entry, state = entry.transport.snapshot()) {
    const requestedRate =
      typeof entry.rate === 'function'
        ? entry.rate(state.position)
        : entry.rate;
    if (
      !Number.isFinite(requestedRate) ||
      requestedRate < 0.025 ||
      requestedRate > 4
    )
      throw new RangeError('Playback rate must be between 0.025 and 4');
    return Object.freeze({ ...state, requestedRate });
  }

  function trackRelease(audio, promise) {
    releases.set(audio, promise);
    const clear = () => {
      if (releases.get(audio) === promise) releases.delete(audio);
    };
    promise.then(clear, clear);
    return promise;
  }

  function sourceMatches(entry) {
    return (
      entry.src === raw(entry.audio, 'src') &&
      entry.srcObject === raw(entry.audio, 'srcObject')
    );
  }

  function valid(entry, signal) {
    if (signal.aborted || closed || !sourceMatches(entry)) throw abortError();
  }

  function releaseResult(entry) {
    return {
      position: entry.final.position,
      ended: entry.final.ended,
      playing:
        entry.final.playing &&
        entry.final.pauseRevision === (pauses.get(entry.audio) ?? 0),
      track: entry.track,
      restored: entry.restored,
    };
  }

  async function handBack(entry) {
    const restore = entry.restore && !closed && sourceMatches(entry);
    if (entry.lease.context.state === 'closed') {
      entry.restored = false;
      return;
    }
    try {
      await entry.lease.release(restore ? entry.final.position : undefined, {
        restore,
      });
      entry.restored = restore;
    } catch (error) {
      if (!restore || (!closed && sourceMatches(entry))) throw error;
      await entry.lease.release(undefined, { restore: false });
      entry.restored = false;
    }
  }

  function releaseHost(entry) {
    if (entry.hostRestoration) return entry.hostRestoration;
    try {
      entry.host?.release();
      entry.hostRestoration = Promise.resolve(entry.host?.restoration);
    } catch (error) {
      entry.hostRestoration = Promise.reject(error);
    }
    entry.hostRestoration.catch(() => {});
    return entry.hostRestoration;
  }

  function handBackAndRestoreHost(entry) {
    entry.nativeHandBack = handBack(entry);
    return Promise.allSettled([entry.nativeHandBack]).then(async (results) => {
      const failures = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      try {
        await releaseHost(entry);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'Native playback restoration failed',
        );
    });
  }

  function hostFailure(entry, error) {
    if (entry.hostFailure || owners.get(entry.audio) !== entry)
      return (entry.nativeHandBack ?? Promise.resolve()).catch(() => {});
    entry.hostFailure = error;
    report(error);
    try {
      entry.transport.pause();
    } catch (failure) {
      report(failure);
    }
    const state = {
      ...entry.lastState,
      state: 'error',
      paused: true,
      error,
      hostFailure: true,
    };
    entry.binding.update(state);
    publish(entry.audio, state);
    entry.restore = true;
    entry.binding.release().catch(report);
    return entry.nativeHandBack.catch(() => {});
  }

  function updateHost(entry) {
    if (!entry.host || entry.closing || entry.hostFailure) return;
    try {
      if (entry.host.update() === false && !entry.host.active)
        release(entry.audio, { restore: false }).catch(report);
    } catch (error) {
      hostFailure(entry, error);
    }
  }

  function trackClosing(entry, operation) {
    const closing = Promise.resolve(operation).then(
      () => {
        if (closingOwners.get(entry.audio) === entry)
          closingOwners.delete(entry.audio);
        return releaseResult(entry);
      },
      (error) => {
        entry.closePromise = null;
        throw error;
      },
    );
    entry.closePromise = closing;
    trackRelease(entry.audio, closing);
    closing.catch(report);
    return closing;
  }

  function retryClosing(entry) {
    if (entry.closePromise) return entry.closePromise;
    const operation = Promise.allSettled([
      entry.transportDisposal,
      handBackAndRestoreHost(entry),
    ]).then((results) => {
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length)
        throw new AggregateError(errors, 'Playback ownership cleanup failed');
    });
    return trackClosing(entry, operation);
  }

  function disposeTransport(entry) {
    if (entry.transportDisposal) return entry.transportDisposal;
    try {
      entry.transportDisposal = Promise.resolve(entry.transport?.dispose());
    } catch (error) {
      entry.transportDisposal = Promise.reject(error);
    }
    entry.transportDisposal.catch(() => {});
    return entry.transportDisposal;
  }

  function activate(audio, settings, initial, preparedHost) {
    const entry = {
      audio,
      ...settings,
      src: raw(audio, 'src'),
      srcObject: raw(audio, 'srcObject'),
      restore: false,
      closing: false,
    };
    owners.set(audio, entry);
    let lease, transport, binding;
    try {
      lease = acquireGraph(audio, {
        parkNative({ signal }) {
          valid(entry, signal);
          if (owners.get(audio) !== entry) throw abortError();
          descriptors.pause.value.call(audio);
        },
        restoreNative({ position, restore, signal }) {
          if (!restore) return;
          valid(entry, signal);
          if (owners.has(audio) && owners.get(audio) !== entry)
            throw abortError();
          descriptors.currentTime.set.call(audio, position);
        },
      });
      lease.ready.catch(() => {});
      const engine = lazyEngine({
        ready: lease.ready,
        resolveSource,
        createEngine,
        context: lease.context,
        destination: lease.input,
        audio,
        mode: settings.mode,
      });
      transport = createBufferedTransport({
        context: lease.context,
        ...engine,
        rate: settings.rate,
        initialPosition: initial.position,
        initiallyEnded: initial.ended,
        timers,
        onChange(state) {
          const value = snapshot(entry, state);
          entry.lastState = value;
          binding?.update(value);
          if (state.state !== 'disposed' && !entry.closing) updateHost(entry);
          if (state.state === 'disposed' && binding?.active) {
            binding.release().catch(report);
            return;
          }
          if (owners.get(audio) === entry) publish(audio, value);
        },
      });
      entry.lease = lease;
      entry.transport = transport;
      entry.lastState = snapshot(entry);
      entry.host = preparedHost?.bind({
        snapshot: () => snapshot(entry),
        sourceMatches: () => sourceMatches(entry),
        onFailure: (error) => hostFailure(entry, error),
      });
      if (
        preparedHost &&
        (!entry.host ||
          typeof entry.host.update !== 'function' ||
          typeof entry.host.release !== 'function' ||
          typeof entry.host.active !== 'boolean')
      )
        throw new TypeError('Invalid host clock binding');
      binding = facade.bind(audio, {
        transport: {
          ...transport,
          snapshot: () => snapshot(entry),
          dispose: () => disposeTransport(entry),
        },
        onDetach({ state, reason }) {
          entry.closing = true;
          if (owners.get(audio) === entry) owners.delete(audio);
          entry.restore = entry.restore && reason === 'release';
          entry.final = {
            position: state.position,
            ended: state.ended,
            playing: !state.paused,
            pauseRevision: pauses.get(audio) ?? 0,
          };
          closingOwners.set(audio, entry);
          const releasing = handBackAndRestoreHost(entry);
          trackClosing(entry, entry.binding.release());
          publish(audio, null);
          return releasing;
        },
      });
      entry.binding = binding;
      updateHost(entry);
      if (entry.hostFailure) throw entry.hostFailure;
      publish(audio, entry.lastState);
      const playing = initial.playing ? transport.play() : Promise.resolve();
      entry.ready = Promise.all([lease.ready, playing]).then(() => {
        if (owners.get(audio) !== entry) throw abortError();
        return snapshot(entry);
      });
      entry.ready.catch(report);
      return entry;
    } catch (error) {
      if (owners.get(audio) === entry) owners.delete(audio);
      if (binding) binding.release().catch(report);
      else {
        if (lease) {
          lease.ready.catch(() => {});
          entry.lease = lease;
          entry.transport = transport;
          entry.final = {
            position: initial.position,
            ended: initial.ended,
            playing: initial.playing,
            pauseRevision: pauses.get(audio) ?? 0,
          };
          closingOwners.set(audio, entry);
          disposeTransport(entry);
          retryClosing(entry);
        }
      }
      throw error;
    }
  }

  async function use(audio, settings) {
    if (closed) throw new Error('Playback owner is disposed');
    if (
      !prototype.isPrototypeOf(audio) ||
      !settings ||
      typeof settings.track !== 'string' ||
      !settings.track ||
      !['natural', 'preserve'].includes(settings.mode) ||
      !(typeof settings.rate === 'function' || Number.isFinite(settings.rate))
    )
      throw new TypeError(
        'A media element, track, rate and pitch mode are required',
      );
    const firstRate =
      typeof settings.rate === 'function'
        ? settings.rate(audio.currentTime)
        : settings.rate;
    if (!Number.isFinite(firstRate) || firstRate < 0.025 || firstRate > 4)
      throw new RangeError('Playback rate must be between 0.025 and 4');
    const revision = (revisions.get(audio) ?? 0) + 1;
    revisions.set(audio, revision);
    const pauseRevision = pauses.get(audio) ?? 0;
    const identity = {
      src: raw(audio, 'src'),
      srcObject: raw(audio, 'srcObject'),
    };
    let initial = nativeState(audio);
    let restored = false;
    const previous = owners.get(audio);
    if (
      previous &&
      previous.track === settings.track &&
      previous.mode === settings.mode
    ) {
      if (previous.rate !== settings.rate) {
        previous.rate = settings.rate;
        await previous.transport.setRate(settings.rate);
      }
      await previous.ready;
      if (
        closed ||
        revisions.get(audio) !== revision ||
        owners.get(audio) !== previous ||
        !sourceMatches(previous)
      )
        throw abortError();
      return snapshot(previous);
    }
    if (previous) {
      const sameTrack = previous.track === settings.track;
      const released = await release(audio, {
        restore: sameTrack,
        invalidate: false,
      });
      restored = Boolean(
        released?.restored && released.track === settings.track,
      );
      initial = restored ? released : nativeState(audio);
    } else if (releases.has(audio) || closingOwners.has(audio)) {
      const released = await (releases.get(audio) ??
        retryClosing(closingOwners.get(audio)));
      restored = Boolean(
        released?.restored && released.track === settings.track,
      );
      initial = restored ? released : nativeState(audio);
    }
    if (
      closed ||
      revisions.get(audio) !== revision ||
      identity.src !== raw(audio, 'src') ||
      identity.srcObject !== raw(audio, 'srcObject')
    )
      throw abortError();
    if ((pauses.get(audio) ?? 0) !== pauseRevision) initial.playing = false;
    if (owners.size + closingOwners.size >= 2)
      throw new Error('Buffered media ownership limit reached');
    const preparedHost = hostClock ? await hostClock.prepare(audio) : null;
    if (
      closed ||
      revisions.get(audio) !== revision ||
      identity.src !== raw(audio, 'src') ||
      identity.srcObject !== raw(audio, 'srcObject')
    )
      throw abortError();
    if (hostClock && typeof preparedHost?.bind !== 'function')
      throw new TypeError('Host clock preparation did not return a binding');
    if (hostClock && !restored) initial = nativeState(audio);
    if ((pauses.get(audio) ?? 0) !== pauseRevision) initial.playing = false;
    if (owners.size + closingOwners.size >= 2)
      throw new Error('Buffered media ownership limit reached');
    return activate(audio, settings, initial, preparedHost).ready;
  }

  function release(audio, { restore = true, invalidate = true } = {}) {
    if (invalidate) revisions.set(audio, (revisions.get(audio) ?? 0) + 1);
    const entry = owners.get(audio);
    if (!entry) {
      const closing = closingOwners.get(audio);
      if (!closing) return releases.get(audio) ?? Promise.resolve(null);
      closing.restore = restore;
      return retryClosing(closing);
    }
    entry.restore = restore;
    entry.binding.release().catch(report);
    return entry.closePromise;
  }

  function pause(audio) {
    if (!prototype.isPrototypeOf(audio))
      throw new TypeError('A media element is required');
    pauses.set(audio, (pauses.get(audio) ?? 0) + 1);
    return owners.get(audio)?.transport.pause() ?? null;
  }

  function dispose() {
    if (disposal) return disposal;
    closed = true;
    let resolve, reject;
    disposal = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const closing = [facade.dispose()];
    for (const entry of closingOwners.values()) {
      entry.restore = false;
      closing.push(retryClosing(entry));
    }
    Promise.allSettled(closing).then((results) => {
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length)
        reject(new AggregateError(errors, 'Playback owner disposal failed'));
      else resolve();
    });
    return disposal;
  }

  return Object.freeze({
    use,
    pause,
    release,
    dispose,
    owns: (audio) => owners.has(audio),
    snapshot: (audio) => {
      const entry = owners.get(audio);
      return entry ? snapshot(entry) : null;
    },
  });
}
