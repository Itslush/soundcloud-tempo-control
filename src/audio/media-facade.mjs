const EVENTS = [
  'play',
  'playing',
  'pause',
  'timeupdate',
  'seeking',
  'seeked',
  'ended',
  'waiting',
  'stalled',
  'canplay',
  'canplaythrough',
  'progress',
  'durationchange',
  'loadedmetadata',
  'loadeddata',
  'ratechange',
  'error',
  'abort',
];
const READERS = [
  'currentTime',
  'duration',
  'paused',
  'ended',
  'seeking',
  'readyState',
  'networkState',
];
const RATE_READERS = ['playbackRate', 'defaultPlaybackRate'];
const abortError = () =>
  new DOMException('Playback was interrupted', 'AbortError');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function validateSnapshot(state) {
  if (
    !state ||
    !Number.isFinite(state.position) ||
    state.position < 0 ||
    typeof state.paused !== 'boolean' ||
    typeof state.ended !== 'boolean' ||
    (state.requestedRate !== undefined &&
      (!Number.isFinite(state.requestedRate) ||
        state.requestedRate < 0.025 ||
        state.requestedRate > 4)) ||
    ![
      'paused',
      'buffering',
      'suspended',
      'playing',
      'ended',
      'error',
      'disposed',
    ].includes(state.state)
  )
    throw new TypeError('Invalid transport snapshot');
  return state;
}

export function createMediaFacade({
  prototype = globalThis.HTMLMediaElement?.prototype,
  enqueue = (callback) => setTimeout(callback, 0),
  onError = () => {},
} = {}) {
  if (
    !prototype ||
    typeof enqueue !== 'function' ||
    typeof onError !== 'function'
  )
    throw new TypeError('A media prototype and callbacks are required');
  const original = new Map();
  const installed = new Map();
  const owners = new Map();
  const releases = new Set();
  const ownEvents = new WeakSet();
  let disposed = false;
  let closing = false;
  let disposal = null;
  const descriptor = (key) => Object.getOwnPropertyDescriptor(prototype, key);
  const read = (audio, key) => original.get(key)?.get?.call(audio);
  const currentSource = descriptor('currentSrc')?.get;
  const sourceOf = (audio) =>
    read(audio, 'srcObject') ??
    (read(audio, 'src') || currentSource?.call(audio) || '');

  function report(error) {
    try {
      onError(error);
    } catch {}
  }

  function patch(key, transform) {
    const before = descriptor(key);
    if (!before?.configurable) throw new Error(`Cannot intercept media ${key}`);
    const after = transform(before);
    Object.defineProperty(prototype, key, after);
    original.set(key, before);
    installed.set(key, after);
  }

  function restore() {
    for (const [key, ours] of installed) {
      const current = descriptor(key);
      if (
        current?.value === ours.value &&
        current?.get === ours.get &&
        current?.set === ours.set
      )
        Object.defineProperty(prototype, key, original.get(key));
    }
    installed.clear();
  }

  function current(entry) {
    return !disposed && owners.get(entry.audio) === entry;
  }

  function stopPlay(entry, error) {
    const pending = entry.pendingPlay;
    if (!pending) return;
    entry.pendingPlay = null;
    pending.reject(error);
  }

  function emit(entry, names, after) {
    if (!names.length && !after) return;
    entry.events.push(...names.map((name) => ({ name })));
    if (after) entry.events.push({ after });
    if (entry.queued) return;
    entry.queued = true;
    enqueue(() => {
      entry.queued = false;
      const events = entry.events.splice(0);
      for (const item of events) {
        if (!current(entry)) break;
        if (item.after) {
          item.after();
          continue;
        }
        const EventType =
          entry.audio.ownerDocument?.defaultView?.Event ?? Event;
        if (item.name === 'ratechange') entry.rateEventQueued = false;
        const event = new EventType(item.name);
        ownEvents.add(event);
        entry.audio.dispatchEvent(event);
      }
    });
  }

  function finishPlay(entry) {
    const pending = entry.pendingPlay;
    if (!pending) return;
    emit(entry, [], () => {
      if (
        entry.pendingPlay !== pending ||
        (entry.state.paused && !entry.state.ended)
      )
        return;
      entry.pendingPlay = null;
      pending.resolve();
    });
  }

  function updateEntry(entry, value) {
    if (!current(entry)) return;
    const state = validateSnapshot(value);
    const previous = entry.state;
    entry.state = state;
    const names = [];
    if (
      state.requestedRate !== undefined &&
      state.requestedRate !== entry.lastRate
    ) {
      entry.lastRate = state.requestedRate;
      if (!entry.rateEventQueued) {
        entry.rateEventQueued = true;
        names.push('ratechange');
      }
    }
    if (previous.paused && !state.paused) names.push('play');
    if (state.state === 'playing' && previous.state !== 'playing')
      names.push('playing');
    if (
      (state.state === 'buffering' || state.state === 'suspended') &&
      previous.state === 'playing'
    )
      names.push('waiting');
    if (!previous.paused && state.paused) names.push('timeupdate', 'pause');
    if (state.ended && !previous.ended) names.push('timeupdate', 'ended');
    if (state.error && state.error !== previous.error) {
      stopPlay(entry, state.error);
      names.push('error');
    } else if (state.paused && !state.ended) stopPlay(entry, abortError());
    const duration = durationOf(entry);
    if (
      duration !== entry.lastDuration &&
      !(Number.isNaN(duration) && Number.isNaN(entry.lastDuration))
    ) {
      entry.lastDuration = duration;
      names.push('durationchange');
    }
    const now = performance.now();
    if (
      state.position !== entry.lastTime &&
      now - entry.lastTimeUpdate >= 250
    ) {
      if (!names.includes('timeupdate')) names.push('timeupdate');
      entry.lastTime = state.position;
      entry.lastTimeUpdate = now;
    }
    emit(entry, names);
    if (state.state === 'playing' || state.ended) finishPlay(entry);
  }

  function refresh(entry) {
    if (current(entry)) updateEntry(entry, entry.transport.snapshot());
  }

  function durationOf(entry, state = entry.state) {
    const { duration, durationHint } = state;
    if (Number.isFinite(duration) && duration >= 0) return duration;
    if (Number.isFinite(durationHint) && durationHint > 0) return durationHint;
    return read(entry.audio, 'duration');
  }

  function property(entry, key) {
    const state = validateSnapshot(entry.transport.snapshot());
    if (key === 'currentTime') return state.position;
    if (key === 'paused') return state.paused;
    if (key === 'ended') return state.ended;
    if (key === 'seeking') return entry.seeking;
    if (key === 'duration') return durationOf(entry, state);
    if (RATE_READERS.includes(key))
      return state.requestedRate ?? read(entry.audio, key);
    if (key === 'networkState') return state.state === 'buffering' ? 2 : 1;
    if (state.state === 'playing' || state.scheduledWindows > 0) return 3;
    return state.sampleRate ? 1 : 0;
  }

  function play(entry) {
    if (entry.pendingPlay) return entry.pendingPlay.promise;
    const pending = deferred();
    entry.pendingPlay = pending;
    try {
      const operation = entry.transport.play();
      refresh(entry);
      Promise.resolve(operation).then(
        () => refresh(entry),
        (error) => {
          if (entry.pendingPlay === pending) stopPlay(entry, error);
        },
      );
    } catch (error) {
      stopPlay(entry, error);
    }
    return pending.promise;
  }

  function pause(entry) {
    stopPlay(entry, abortError());
    entry.transport.pause();
    refresh(entry);
  }

  function seek(entry, value) {
    const position = Number(value);
    if (!Number.isFinite(position))
      throw new TypeError('Seek position must be finite');
    const target = Math.max(0, position);
    const revision = ++entry.seekRevision;
    entry.seeking = true;
    emit(entry, ['seeking']);
    try {
      const operation = entry.transport.seek(target);
      refresh(entry);
      Promise.resolve(operation).then(
        () => {
          if (!current(entry) || entry.seekRevision !== revision) return;
          entry.seeking = false;
          refresh(entry);
          emit(entry, ['timeupdate', 'seeked']);
        },
        (error) => {
          if (!current(entry) || entry.seekRevision !== revision) return;
          entry.seeking = false;
          report(error);
          refresh(entry);
        },
      );
    } catch (error) {
      entry.seeking = false;
      throw error;
    }
  }

  function detach(entry, reason) {
    if (!current(entry)) return entry.releasing ?? Promise.resolve();
    const completion = deferred();
    entry.releasing = completion.promise;
    releases.add(entry.releasing);
    owners.delete(entry.audio);
    entry.releasing.then(
      () => releases.delete(entry.releasing),
      (error) => {
        releases.delete(entry.releasing);
        report(error);
      },
    );
    const errors = [];
    let state = entry.state;
    try {
      state = validateSnapshot(entry.transport.snapshot());
    } catch (error) {
      errors.push(error);
    }
    entry.events.length = 0;
    stopPlay(entry, abortError());
    for (const event of EVENTS)
      entry.audio.removeEventListener(event, entry.filter, true);
    for (const event of ['emptied', 'loadstart'])
      entry.audio.removeEventListener(event, entry.changed, true);
    const tasks = [];
    const collect = (task) => {
      if (task !== disposal && task !== entry.releasing) tasks.push(task);
    };
    try {
      collect(entry.transport.dispose());
    } catch (error) {
      errors.push(error);
    }
    try {
      collect(entry.onDetach({ reason, state, media: entry.audio }));
    } catch (error) {
      errors.push(error);
    }
    Promise.allSettled(tasks).then((results) => {
      errors.push(
        ...results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason),
      );
      if (errors.length)
        completion.reject(
          new AggregateError(errors, 'Media ownership cleanup failed'),
        );
      else completion.resolve();
    });
    return entry.releasing;
  }

  function bind(audio, { transport, onDetach = () => {} }) {
    if (disposed || closing) throw new Error('Media facade is disposed');
    if (
      !prototype.isPrototypeOf(audio) ||
      typeof audio.addEventListener !== 'function' ||
      !transport ||
      ['snapshot', 'play', 'pause', 'seek', 'dispose'].some(
        (key) => typeof transport[key] !== 'function',
      ) ||
      typeof onDetach !== 'function'
    )
      throw new TypeError('A media element and transport are required');
    if (owners.has(audio) || owners.size + releases.size >= 2)
      throw new Error('Media ownership limit reached');
    const state = validateSnapshot(transport.snapshot());
    const entry = {
      audio,
      transport,
      onDetach,
      state,
      source: sourceOf(audio),
      events: [],
      queued: false,
      seeking: false,
      seekRevision: 0,
      lastTime: state.position,
      lastRate: read(audio, 'playbackRate') ?? state.requestedRate,
      rateEventQueued: false,
      lastTimeUpdate: performance.now(),
      pendingPlay: null,
    };
    entry.lastDuration = durationOf(entry);
    entry.filter = (event) => {
      if (current(entry) && !ownEvents.has(event))
        event.stopImmediatePropagation();
    };
    entry.changed = (event) => {
      if (event.type === 'emptied' || sourceOf(audio) !== entry.source)
        void detach(entry, 'source-change');
    };
    owners.set(audio, entry);
    for (const event of EVENTS)
      audio.addEventListener(event, entry.filter, true);
    for (const event of ['emptied', 'loadstart'])
      audio.addEventListener(event, entry.changed, true);
    updateEntry(entry, state);
    return Object.freeze({
      update: (state) => updateEntry(entry, state),
      release: () => detach(entry, 'release'),
      get active() {
        return current(entry);
      },
    });
  }

  try {
    for (const key of [
      ...READERS,
      ...RATE_READERS.filter((name) => descriptor(name)?.get),
    ])
      patch(key, (before) => ({
        ...before,
        get() {
          const entry = owners.get(this);
          return entry ? property(entry, key) : before.get.call(this);
        },
        ...(key === 'currentTime'
          ? {
              set(value) {
                const entry = owners.get(this);
                return entry
                  ? seek(entry, value)
                  : before.set.call(this, value);
              },
            }
          : {}),
      }));
    for (const key of ['play', 'pause', 'fastSeek']) {
      if (!descriptor(key) && key === 'fastSeek') continue;
      patch(key, (before) => ({
        ...before,
        value: function (...args) {
          const entry = owners.get(this);
          if (!entry) return Reflect.apply(before.value, this, args);
          if (key === 'play') return play(entry);
          if (key === 'pause') return pause(entry);
          return seek(entry, args[0]);
        },
      }));
    }
    for (const key of ['src', 'srcObject']) {
      if (!descriptor(key)) continue;
      patch(key, (before) => ({
        ...before,
        set(value) {
          const entry = owners.get(this);
          if (entry) void detach(entry, 'source-change');
          return before.set.call(this, value);
        },
      }));
    }
    patch('load', (before) => ({
      ...before,
      value: function (...args) {
        const entry = owners.get(this);
        if (entry) void detach(entry, 'load');
        return Reflect.apply(before.value, this, args);
      },
    }));
  } catch (error) {
    restore();
    throw error;
  }

  function dispose() {
    if (disposal) return disposal;
    const completion = deferred();
    disposal = completion.promise;
    closing = true;
    for (const entry of [...owners.values()]) detach(entry, 'dispose');
    disposed = true;
    const errors = [];
    try {
      restore();
    } catch (error) {
      errors.push(error);
    }
    Promise.allSettled([...releases]).then((results) => {
      errors.push(
        ...results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason),
      );
      if (errors.length)
        completion.reject(
          new AggregateError(errors, 'Media facade cleanup failed'),
        );
      else completion.resolve();
    });
    return disposal;
  }

  return Object.freeze({ bind, owns: (audio) => owners.has(audio), dispose });
}
