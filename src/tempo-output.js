import { syncTempoRange } from './tempo-range.js';

export function createOutputLevel({ references, readUI }) {
  const key = 'soundcloud.tempo.outputDb';
  const volume = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'volume',
  );
  const muted = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'muted',
  );
  const levels = new WeakMap();
  const subscriptions = new WeakMap();
  const subscribed = new Set();
  let db = read();

  function read() {
    try {
      const raw = localStorage.getItem(key);
      const value = raw === null ? -6 : Number(raw);
      return Number.isFinite(value) ? Math.max(-24, Math.min(0, value)) : -6;
    } catch {
      return -6;
    }
  }

  function gain() {
    return 10 ** (db / 20);
  }

  function attach(audio) {
    if (
      !(audio instanceof HTMLAudioElement) ||
      !volume?.set ||
      levels.has(audio)
    )
      return;
    const value = volume.get.call(audio);
    volume.set.call(audio, value * gain());
    levels.set(audio, value);
    notify(audio);
  }

  function readLevel(audio) {
    if (!(audio instanceof HTMLAudioElement))
      throw new TypeError('An audio element is required.');
    const nativeVolume = volume.get.call(audio);
    return Object.freeze({
      volume: levels.has(audio) ? levels.get(audio) : nativeVolume,
      muted: muted.get.call(audio),
      outputDb: db,
    });
  }

  function call(callback, value) {
    try {
      callback(value);
    } catch (cause) {
      console.warn(cause);
    }
  }

  function notify(audio) {
    const record = subscriptions.get(audio);
    if (!record) return;
    const value = readLevel(audio);
    const previous = record.last;
    if (
      previous.volume === value.volume &&
      previous.muted === value.muted &&
      previous.outputDb === value.outputDb
    )
      return;
    record.last = value;
    for (const [token, callback] of [...record.callbacks]) {
      if (record.last !== value) break;
      if (record.callbacks.has(token)) call(callback, value);
    }
  }

  function subscribeLevel(audio, callback) {
    if (typeof callback !== 'function')
      throw new TypeError('A level callback is required.');
    notify(audio);
    const value = readLevel(audio);
    let record = subscriptions.get(audio);
    if (!record) {
      record = {
        ref: new WeakRef(audio),
        callbacks: new Map(),
        last: value,
        listener: (event) => notify(event.currentTarget),
      };
      audio.addEventListener('volumechange', record.listener);
      subscriptions.set(audio, record);
      subscribed.add(record.ref);
    }
    const token = {};
    const ref = record.ref;
    record.callbacks.set(token, callback);
    call(callback, value);
    return () => {
      const target = ref.deref();
      const current = target && subscriptions.get(target);
      if (
        !current ||
        !current.callbacks.delete(token) ||
        current.callbacks.size
      )
        return;
      target.removeEventListener('volumechange', current.listener);
      subscriptions.delete(target);
      subscribed.delete(ref);
    };
  }

  function apply() {
    const seen = new WeakSet();
    for (const ref of [...references, ...subscribed]) {
      const audio = ref.deref();
      if (!audio) {
        subscribed.delete(ref);
        continue;
      }
      if (!(audio instanceof HTMLAudioElement)) continue;
      if (seen.has(audio)) continue;
      seen.add(audio);
      attach(audio);
      volume?.set?.call(audio, levels.get(audio) * gain());
      notify(audio);
    }
    const ui = readUI();
    if (ui?.outputSlider) {
      ui.outputSlider.value = String(db);
      ui.outputValue.textContent = `${db} dB`;
      syncTempoRange(ui.outputSlider);
    }
  }

  if (volume?.configurable && volume.set && volume.get) {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      ...volume,
      get() {
        return this instanceof HTMLAudioElement && levels.has(this)
          ? levels.get(this)
          : volume.get.call(this);
      },
      set(value) {
        if (!(this instanceof HTMLAudioElement))
          return volume.set.call(this, value);
        volume.get.call(this);
        const number = +value;
        if (!Number.isFinite(number) || number < 0 || number > 1)
          return volume.set.call(this, number);
        volume.set.call(this, number * gain());
        levels.set(this, number);
        notify(this);
      },
    });
  }

  if (muted?.configurable && muted.set && muted.get) {
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
      ...muted,
      set(value) {
        muted.set.call(this, value);
        if (this instanceof HTMLAudioElement) notify(this);
      },
    });
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    db = read();
    apply();
  });

  return {
    attach,
    readLevel,
    subscribeLevel,
    value: () => db,
    reload() {
      db = read();
      apply();
    },
    set(value) {
      const next = Number(value);
      if (!Number.isFinite(next)) return;
      const previous = db;
      db = Math.max(-24, Math.min(0, Math.round(next)));
      try {
        localStorage.setItem(key, String(db));
      } catch {
        db = previous;
        apply();
        throw new Error('Output level could not be saved.');
      }
      apply();
    },
  };
}
