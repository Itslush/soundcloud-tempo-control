export function createBufferedPlayback({
  modules,
  graph,
  readSettings,
  media,
  applyNative,
  recoverNative,
  onState,
  onFailure,
  prototype = HTMLMediaElement.prototype,
  timers = globalThis,
}) {
  const descriptors = Object.getOwnPropertyDescriptors(prototype);
  const raw = (audio, name) => descriptors[name]?.get?.call(audio);
  const records = new WeakMap();
  const sources = new WeakMap();
  const waiters = new Map();
  const abortError = () => new DOMException('Playback changed', 'AbortError');
  let closed = false;
  let disposal;
  let selected;
  const binding = modules.createSourceBinding({
    onChange(audio, result) {
      for (const receive of waiters.get(audio) || []) receive(result);
    },
  });
  const hostClock = modules.createSoundCloudHostClock({
    mediaPrototype: prototype,
  });
  const owner = modules.createPlaybackOwner({
    prototype,
    hostClock,
    acquireGraph: (audio, hooks) => graph.acquireBuffered(audio, hooks),
    resolveSource,
    createEngine,
    onChange(audio, state) {
      const record = records.get(audio);
      if (!record || !current(audio, record)) return;
      const previous = record.state?.state;
      record.state = state;
      if (state?.error && state.error.name !== 'AbortError')
        return fail(audio, record, state.error, state.hostFailure === true);
      if (state?.state !== previous) onState();
    },
    onError(error) {
      if (error?.name !== 'AbortError')
        console.warn('[SoundCloud Tempo]', error);
    },
  });
  binding.install();

  function current(audio, record) {
    return (
      !closed &&
      records.get(audio) === record &&
      raw(audio, 'src') === record.src &&
      raw(audio, 'srcObject') === record.srcObject &&
      readSettings(audio).track === record.track
    );
  }

  function fail(audio, record, error, hostFailure = false) {
    if (!current(audio, record) || error?.name === 'AbortError') return;
    if (record.recovery) return;
    record.error = error;
    if (
      (hostFailure || error?.code === 'SOUNDCLOUD_HOST_UNSUPPORTED') &&
      recoverNative
    ) {
      record.nativeFallback = true;
      record.recovery = owner.release(audio).then(async () => {
        if (!current(audio, record)) throw abortError();
        recoverNative(audio);
        onFailure('Using browser playback at 0.25×. Saved tempo unchanged.');
        onState();
        if (record.intent && !record.playRequest)
          await descriptors.play.value.call(audio);
      });
      record.recovery.catch((cause) => {
        if (!current(audio, record) || cause?.name === 'AbortError') return;
        record.error = cause;
        onFailure(cause.message || 'Browser playback could not resume.');
        onState();
      });
      return;
    }
    if (record.required && !owner.owns(audio))
      descriptors.pause.value.call(audio);
    onFailure(error.message || 'Buffered playback is unavailable.');
    onState();
  }

  function resolveSource(audio, { signal }) {
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        const listeners = waiters.get(audio);
        listeners?.delete(receive);
        if (!listeners?.size) waiters.delete(audio);
        callback(value);
      };
      const abort = () => finish(reject, abortError());
      const receive = (result) => {
        if (result.status === 'bound') finish(resolve, result);
        else if (['ambiguous', 'unavailable'].includes(result.status))
          finish(
            reject,
            new Error(
              'Could not identify this track’s audio. Choose 0.25× or higher to use browser playback.',
            ),
          );
      };
      if (signal.aborted) return abort();
      if (!waiters.has(audio)) waiters.set(audio, new Set());
      waiters.get(audio).add(receive);
      signal.addEventListener('abort', abort, { once: true });
      timer = timers.setTimeout(
        () =>
          finish(
            reject,
            new Error(
              'Track audio is not available for buffered playback. Reload the track or choose 0.25× or higher.',
            ),
          ),
        10000,
      );
      try {
        receive(binding.resolve(audio));
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function createEngine({ context, destination, source, mode, signal }) {
    const { Mediabunny } = await modules.loadAudioDependencies({
      signal,
    });
    if (signal.aborted) throw abortError();
    const pcm = modules.createPcmSource({
      library: Mediabunny,
      url: source.playlistUrl,
    });
    let provider;
    try {
      provider = modules.createPcmWindow({ source: pcm });
      const output =
        mode === 'preserve'
          ? modules.createPreserveOutput({
              context,
              destination,
            })
          : modules.createNaturalOutput({ context, destination });
      return { provider, output };
    } catch (error) {
      await (provider || pcm).dispose();
      throw error;
    }
  }

  function settings(audio) {
    const value = readSettings(audio);
    return {
      track: value.track,
      mode: value.mode,
      wasm: value.wasm,
      rate: value.schedule?.rateAt ?? value.rate,
      required: (value.schedule?.minimumRate ?? value.rate) < 0.25,
      src: raw(audio, 'src'),
      srcObject: raw(audio, 'srcObject'),
    };
  }

  function same(left, right) {
    return left && Object.keys(right).every((key) => left[key] === right[key]);
  }

  function sync(audio) {
    if (closed) return false;
    if (selected?.deref() !== audio) return true;
    const next = settings(audio);
    const previous = records.get(audio);
    const source = binding.resolve(audio);
    if (!sources.has(audio))
      sources.set(audio, { track: next.track, id: source.sourceId });
    else if (sources.get(audio).id === null && source.sourceId !== null)
      sources.set(audio, { track: next.track, id: source.sourceId });
    if (
      same(previous, next) &&
      (previous.pending ||
        previous.error ||
        !next.required ||
        owner.owns(audio))
    )
      return next.required || Boolean(previous.pending);
    if (!next.required && !previous?.pending && !owner.owns(audio)) {
      records.delete(audio);
      return false;
    }
    const record = {
      ...next,
      intent: previous?.pending ? previous.intent : !audio.paused,
      pending: null,
      state: null,
      error: null,
      manualPlay: false,
    };
    if (
      previous?.pending &&
      previous.playRequest &&
      !previous.playRequest.cancelled &&
      current(audio, previous)
    ) {
      record.playRequest = previous.playRequest;
      record.playRequest.record = record;
      record.manualPlay = true;
    }
    records.set(audio, record);
    let operation;
    if (next.required) {
      if (
        !next.track ||
        !graph.hasGraph(audio) ||
        (next.mode === 'preserve' && !next.wasm)
      ) {
        descriptors.pause.value.call(audio);
        record.waitingGraph = !graph.hasGraph(audio);
        record.unavailable = true;
        const message = !next.track
          ? 'Load a track before choosing this tempo.'
          : record.waitingGraph
            ? 'The player audio connection is not ready. Reload the track to use speeds below 0.25×.'
            : 'Enable WASM to preserve key below 0.25×.';
        fail(audio, record, new Error(message));
        operation = owner.release(audio).then(() => {
          throw record.error;
        });
      } else operation = owner.use(audio, next);
    } else {
      operation = owner.release(audio).then((released) => {
        if (!current(audio, record)) throw abortError();
        applyNative(audio);
        if (
          released?.restored &&
          released.playing &&
          record.intent &&
          !record.manualPlay
        )
          return descriptors.play.value.call(audio);
      });
    }
    const pending = Promise.resolve(operation);
    record.pending = pending;
    pending
      .then(
        () => {
          if (record.pending === pending) record.pending = null;
          if (!current(audio, record)) return;
          if (!record.required) applyNative(audio);
          onState();
        },
        (error) => {
          if (record.pending === pending) record.pending = null;
          fail(audio, record, error);
        },
      )
      .catch((error) => fail(audio, record, error));
    return true;
  }

  async function preparedPlay(audio, request) {
    while (!request.cancelled && current(audio, request.record)) {
      const record = request.record;
      try {
        await (record.recovery ?? record.pending);
      } catch (error) {
        if (request.record !== record) continue;
        if (!record.recovery) throw error;
        await record.recovery;
      }
      if (request.record !== record) continue;
      if (!current(audio, record) || !record.intent || request.cancelled) break;
      if (record.required && !record.nativeFallback && !owner.owns(audio))
        break;
      return request.fallback();
    }
    throw abortError();
  }

  function play(audio, fallback) {
    const record = records.get(audio);
    if (!record) return fallback();
    if (record.playRequest && !record.playRequest.cancelled)
      return record.playRequest.promise;
    record.intent = true;
    record.manualPlay = true;
    if (record.error && !record.nativeFallback) {
      if (record.unavailable) return Promise.reject(record.error);
      record.error = null;
      record.state = null;
      onFailure('');
      if (!record.required) return fallback();
      const retry = owner.release(audio).then(() => {
        if (!current(audio, record) || !record.intent) throw abortError();
        return owner.use(audio, record);
      });
      record.pending = retry;
      retry.then(
        () => {
          if (record.pending === retry) record.pending = null;
          if (current(audio, record)) onState();
        },
        (error) => {
          if (record.pending === retry) record.pending = null;
          fail(audio, record, error);
        },
      );
    }
    if (!record.pending && !record.recovery) return fallback();
    const request = { record, fallback, cancelled: false, promise: null };
    record.playRequest = request;
    request.promise = preparedPlay(audio, request);
    const clear = () => {
      if (request.record.playRequest === request)
        request.record.playRequest = null;
    };
    request.promise.then(clear, clear);
    return request.promise;
  }

  function pause(audio) {
    const record = records.get(audio);
    if (record) {
      record.intent = false;
      if (record.playRequest) record.playRequest.cancelled = true;
    }
    const owned = owner.owns(audio);
    owner.pause(audio);
    return owned;
  }

  function select(audio) {
    const previous = selected?.deref();
    if (previous === audio || closed) return;
    selected = new WeakRef(audio);
    if (!previous) return;
    records.delete(previous);
    binding.release(previous);
    owner.release(previous, { restore: false }).catch((error) => {
      if (error?.name !== 'AbortError')
        console.warn('[SoundCloud Tempo]', error);
    });
  }

  function changeTrack(previous, next) {
    if (!previous || previous === next) return;
    const audio = selected?.deref();
    if (audio) {
      const before = sources.get(audio);
      const source = binding.resolve(audio);
      if (!before || before.id === source.sourceId) binding.invalidate(audio);
      sources.set(audio, { track: next, id: source.sourceId });
      records.delete(audio);
      owner.release(audio, { restore: false }).catch((error) => {
        if (error?.name !== 'AbortError') onFailure(error.message);
      });
    }
  }

  function graphReady(audio) {
    if (!selected?.deref()) select(audio);
    if (!records.get(audio)?.waitingGraph) return;
    onFailure('');
    records.delete(audio);
    sync(audio);
  }

  function label() {
    for (const audio of media()) {
      const record = records.get(audio);
      if (!record || !current(audio, record)) continue;
      if (record.error) return record.error.message;
      if (!record.required) continue;
      if (record.state?.state === 'buffering') return 'Buffering audio…';
      if (record.pending) return 'Preparing audio…';
      return record.mode === 'preserve'
        ? 'Buffered playback · Preserve key.'
        : 'Buffered playback · Natural pitch.';
    }
    return null;
  }

  function dispose() {
    if (disposal) return disposal;
    closed = true;
    disposal = Promise.allSettled([owner.dispose(), binding.dispose()]).then(
      async (results) => {
        const host = await Promise.allSettled([hostClock.dispose()]);
        results.push(...host);
        const errors = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason);
        if (errors.length)
          throw new AggregateError(errors, 'Playback cleanup failed');
      },
    );
    return disposal;
  }

  return Object.freeze({
    sync,
    play,
    pause,
    select,
    changeTrack,
    graphReady,
    label,
    dispose,
  });
}
