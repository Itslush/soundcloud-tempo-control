const ownedInputs = new WeakSet();

function readLevel(levels) {
  const value = levels.read();
  if (
    !value ||
    !Number.isFinite(value.volume) ||
    value.volume < 0 ||
    value.volume > 1 ||
    typeof value.muted !== 'boolean' ||
    !Number.isFinite(value.outputDb) ||
    value.outputDb < -24 ||
    value.outputDb > 0
  )
    throw new RangeError('Invalid logical output level');
  return Object.freeze({
    volume: value.volume,
    muted: value.muted,
    outputDb: value.outputDb,
    gain: value.muted ? 0 : value.volume * 10 ** (value.outputDb / 20),
  });
}

function aborted() {
  return new DOMException('Playback ownership superseded', 'AbortError');
}

function interruptible(promise, signal) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, aborted());
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export function createPlaybackGate({
  context,
  nativeInput,
  destination,
  levels,
  parkNative,
  restoreNative,
}) {
  if (
    !context ||
    typeof context.createGain !== 'function' ||
    typeof context.addEventListener !== 'function' ||
    typeof context.removeEventListener !== 'function' ||
    !nativeInput ||
    nativeInput.context !== context ||
    typeof nativeInput.connect !== 'function' ||
    typeof nativeInput.disconnect !== 'function' ||
    !destination ||
    destination.context !== context ||
    destination === nativeInput
  )
    throw new TypeError(
      'A native input and destination in one audio context are required',
    );
  if (
    !levels ||
    typeof levels.read !== 'function' ||
    typeof levels.subscribe !== 'function' ||
    typeof parkNative !== 'function' ||
    typeof restoreNative !== 'function'
  )
    throw new TypeError(
      'Logical levels and native ownership hooks are required',
    );
  if (context.state === 'closed') throw new Error('Audio context is closed');
  let level = readLevel(levels);
  if (ownedInputs.has(nativeInput))
    throw new Error('Native graph input already has a playback gate');
  ownedInputs.add(nativeInput);
  let nativeNode = null;
  let nativeConnected = false;
  let inputConnected = false;
  let unsubscribe = null;
  let listening = false;
  let current = null;
  let generation = 0;
  let disposed = false;
  let phase = 'native';
  let failure = null;
  let cleanupErrors = 0;

  function available() {
    if (disposed) throw new Error('Playback gate is disposed');
    if (context.state === 'closed') throw new Error('Audio context is closed');
  }

  function value(node, gain) {
    node.gain.cancelScheduledValues(0);
    node.gain.value = gain;
  }

  function attempt(action, errors) {
    try {
      action();
    } catch (error) {
      cleanupErrors++;
      errors.push(error);
    }
  }

  function closeNative(errors) {
    if (!nativeNode) return;
    if (nativeConnected)
      attempt(() => {
        nativeNode.disconnect(destination);
        nativeConnected = false;
      }, errors);
    attempt(() => value(nativeNode, 0), errors);
  }

  function closeBuffered(owner, errors) {
    if (!owner?.input) return;
    const before = errors.length;
    if (owner.connected)
      attempt(() => {
        owner.input.disconnect(destination);
        owner.connected = false;
      }, errors);
    attempt(() => value(owner.input, 0), errors);
    if (errors.length === before) owner.input = null;
  }

  function snapshot() {
    return Object.freeze({
      state: phase,
      generation,
      owned: current !== null,
      nodes: Number(nativeNode !== null) + Number(Boolean(current?.input)),
      nativeConnected,
      bufferedConnected: Boolean(current?.connected),
      nativeGain: nativeNode?.gain.value ?? 0,
      bufferedGain: current?.input?.gain.value ?? 0,
      level,
      error: failure,
      cleanupErrors,
    });
  }

  function valid(owner, revision) {
    return (
      !disposed &&
      context.state !== 'closed' &&
      current === owner &&
      owner.generation === generation &&
      owner.revision === revision
    );
  }

  function fail(owner, error) {
    const errors = [];
    closeNative(errors);
    closeBuffered(owner, errors);
    owner?.controller.abort();
    phase = 'failed';
    failure = errors.length
      ? new AggregateError(
          [error, ...errors],
          'Playback gate could not be silenced',
          { cause: error },
        )
      : error;
    return failure;
  }

  function refresh() {
    if (disposed) return;
    try {
      level = readLevel(levels);
      if (phase === 'buffered') value(current.input, level.gain);
    } catch (error) {
      fail(current, error);
    }
  }

  function release(owner, position, options = {}) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'restore') ||
      (options.restore !== undefined && typeof options.restore !== 'boolean')
    )
      throw new TypeError('Invalid native restoration options');
    const restore = options.restore ?? true;
    if (
      (restore || position !== undefined) &&
      (!Number.isFinite(position) || position < 0 || position > 86400)
    )
      throw new RangeError(
        'Native restoration requires a valid source position',
      );
    if (owner.releasePromise) return owner.releasePromise;
    available();
    if (current !== owner || owner.generation !== generation) throw aborted();
    owner.controller.abort();
    owner.controller = new AbortController();
    const signal = owner.controller.signal;
    const revision = ++owner.revision;
    phase = 'releasing';
    failure = null;
    const errors = [];
    closeBuffered(owner, errors);
    closeNative(errors);
    owner.releasePromise = Promise.resolve()
      .then(async () => {
        if (!valid(owner, revision)) throw aborted();
        if (errors.length)
          throw new AggregateError(errors, 'Buffered route cleanup failed');
        await interruptible(
          restoreNative({
            position,
            restore,
            signal,
            generation: owner.generation,
          }),
          signal,
        );
        if (!valid(owner, revision)) throw aborted();
        level = readLevel(levels);
        value(nativeNode, 1);
        nativeConnected = true;
        nativeNode.connect(destination);
        if (!valid(owner, revision)) throw aborted();
        current = null;
        phase = 'native';
        return snapshot();
      })
      .catch((error) => {
        owner.releasePromise = null;
        if (valid(owner, revision)) throw fail(owner, error);
        throw error;
      });
    owner.releasePromise.catch(() => {});
    return owner.releasePromise;
  }

  function acquire() {
    available();
    if (current) throw new Error('Playback gate already has an owner');
    if (phase !== 'native')
      throw new Error('Playback gate is not ready for ownership');
    level = readLevel(levels);
    const input = context.createGain();
    try {
      value(input, 0);
      input.connect(destination);
    } catch (error) {
      const errors = [];
      attempt(() => input.disconnect(destination), errors);
      if (errors.length)
        throw new AggregateError(
          [error, ...errors],
          'Buffered route allocation failed',
          { cause: error },
        );
      throw error;
    }
    const owner = {
      input,
      connected: true,
      generation: ++generation,
      revision: 0,
      controller: new AbortController(),
      releasePromise: null,
    };
    current = owner;
    phase = 'acquiring';
    failure = null;
    const errors = [];
    closeNative(errors);
    const signal = owner.controller.signal;
    const ready = Promise.resolve()
      .then(async () => {
        if (!valid(owner, 0)) throw aborted();
        if (errors.length)
          throw new AggregateError(errors, 'Native route cleanup failed');
        await interruptible(
          parkNative({ signal, generation: owner.generation }),
          signal,
        );
        if (!valid(owner, 0)) throw aborted();
        level = readLevel(levels);
        value(owner.input, level.gain);
        phase = 'buffered';
        return snapshot();
      })
      .catch((error) => {
        if (valid(owner, 0)) throw fail(owner, error);
        throw error;
      });
    ready.catch(() => {});
    return Object.freeze({
      input,
      ready,
      generation: owner.generation,
      release: (position, options) => release(owner, position, options),
    });
  }

  function dispose() {
    if (disposed && !nativeNode && !current && !unsubscribe && !listening)
      return snapshot();
    disposed = true;
    phase = 'disposed';
    generation++;
    current?.controller.abort();
    const errors = [];
    if (listening)
      attempt(() => {
        context.removeEventListener('statechange', stateChanged);
        listening = false;
      }, errors);
    if (unsubscribe)
      attempt(() => {
        unsubscribe();
        unsubscribe = null;
      }, errors);
    closeBuffered(current, errors);
    closeNative(errors);
    if (inputConnected)
      attempt(() => {
        nativeInput.disconnect(nativeNode);
        inputConnected = false;
      }, errors);
    if (!errors.length) {
      current = null;
      nativeNode = null;
      ownedInputs.delete(nativeInput);
    }
    if (errors.length) {
      failure = new AggregateError(errors, 'Playback gate cleanup failed');
      throw failure;
    }
    return snapshot();
  }

  function stateChanged() {
    if (disposed || context.state !== 'closed') return;
    try {
      dispose();
    } catch {}
  }

  try {
    nativeNode = context.createGain();
    value(nativeNode, 1);
    nativeConnected = true;
    nativeNode.connect(destination);
    inputConnected = true;
    nativeInput.connect(nativeNode);
    unsubscribe = levels.subscribe(refresh);
    if (typeof unsubscribe !== 'function') {
      unsubscribe = null;
      throw new TypeError('Level subscription must provide cleanup');
    }
    listening = true;
    context.addEventListener('statechange', stateChanged);
    available();
    if (phase !== 'native') throw failure;
  } catch (error) {
    try {
      dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Playback gate initialization failed',
        { cause: error },
      );
    }
    throw error;
  }
  return Object.freeze({ acquire, snapshot, dispose });
}
