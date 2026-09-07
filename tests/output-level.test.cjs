const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');

const source = require('./module-fixture.cjs')(['tempo-output.js']);
const key = 'soundcloud.tempo.outputDb';

function fixture(initial) {
  const records = new WeakMap();
  const events = [];
  const warnings = [];
  const storage = new Map(
    initial === undefined ? [] : [[key, String(initial)]],
  );
  const references = new Set();
  const record = (media) => {
    const value = records.get(media);
    if (!value) throw new TypeError('Illegal invocation');
    return value;
  };
  const changed = (media) =>
    events.push(() => media.dispatchEvent(new Event('volumechange')));
  class HTMLMediaElement extends EventTarget {
    constructor() {
      super();
      records.set(this, { volume: 1, muted: false, adds: 0, removes: 0 });
    }
    addEventListener(type, ...args) {
      if (type === 'volumechange') record(this).adds++;
      return super.addEventListener(type, ...args);
    }
    removeEventListener(type, ...args) {
      if (type === 'volumechange') record(this).removes++;
      return super.removeEventListener(type, ...args);
    }
    get volume() {
      return record(this).volume;
    }
    set volume(value) {
      const state = record(this);
      const number = +value;
      if (!Number.isFinite(number))
        throw new TypeError('Volume must be finite');
      if (number < 0 || number > 1)
        throw new DOMException('Invalid volume', 'IndexSizeError');
      if (state.failVolume) throw new Error('Native volume failed');
      if (state.volume === number) return;
      state.volume = number;
      changed(this);
    }
    get muted() {
      return record(this).muted;
    }
    set muted(value) {
      const state = record(this);
      if (state.failMuted) throw new Error('Native muted failed');
      const next = !!value;
      if (state.muted === next) return;
      state.muted = next;
      changed(this);
    }
  }
  class HTMLAudioElement extends HTMLMediaElement {}
  class HTMLVideoElement extends HTMLMediaElement {}
  const nativeVolume = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'volume',
  );
  const nativeMuted = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'muted',
  );
  const window = new EventTarget();
  const settings = { failStorage: false, failRead: false };
  const properties = new Map();
  const ui = {
    outputSlider: {
      min: '-24',
      max: '0',
      value: '-6',
      get valueAsNumber() {
        return Number(this.value);
      },
      style: {
        getPropertyValue: (name) => properties.get(name) || '',
        setProperty: (name, value) => properties.set(name, value),
      },
    },
    outputValue: {},
  };
  const localStorage = {
    getItem(name) {
      if (settings.failRead) throw new Error('Read blocked');
      return storage.get(name) ?? null;
    },
    setItem(name, value) {
      if (settings.failStorage) throw new Error('Storage blocked');
      storage.set(name, value);
    },
  };
  const api = vm.runInNewContext(
    source + '\ncreateOutputLevel({references, readUI: () => ui});',
    {
      HTMLMediaElement,
      HTMLAudioElement,
      references,
      window,
      localStorage,
      ui,
      console: { warn: (...args) => warnings.push(args) },
    },
  );
  const flush = () => {
    for (const event of events.splice(0)) event();
  };
  const external = (name, value) => {
    if (value === null) storage.delete(name);
    else storage.set(name, value);
    const event = new Event('storage');
    event.key = name;
    window.dispatchEvent(event);
  };
  return {
    api,
    Audio: HTMLAudioElement,
    Video: HTMLVideoElement,
    prototype: HTMLMediaElement.prototype,
    nativeVolume,
    nativeMuted,
    references,
    records,
    storage,
    external,
    settings,
    ui,
    flush,
    events,
    warnings,
  };
}

const level = (api, audio) => ({ ...api.readLevel(audio) });
const collect = (api, audio) => {
  const values = [];
  const stop = api.subscribeLevel(audio, (value) => values.push({ ...value }));
  return { values, stop };
};

test('readLevel is immutable and read-only, with logical volume and independent output gain', () => {
  const { api, Audio, nativeVolume, flush } = fixture();
  const audio = new Audio();
  assert.deepEqual(level(api, audio), {
    volume: 1,
    muted: false,
    outputDb: -6,
  });
  assert.equal(Object.isFrozen(api.readLevel(audio)), true);
  assert.equal(nativeVolume.get.call(audio), 1);
  api.attach(audio);
  const expected = 10 ** (-6 / 20);
  assert.equal(nativeVolume.get.call(audio), expected);
  api.attach(audio);
  assert.equal(nativeVolume.get.call(audio), expected);
  audio.volume = 0.8;
  assert.equal(nativeVolume.get.call(audio), 0.8 * expected);
  audio.volume = audio.volume;
  flush();
  assert.equal(nativeVolume.get.call(audio), 0.8 * expected);
  assert.equal(level(api, audio).volume, 0.8);
});

test('volume and mute notifications are synchronous and queued volumechange is deduplicated', () => {
  const { api, Audio, flush, events } = fixture();
  const audio = new Audio();
  api.attach(audio);
  flush();
  const { values, stop } = collect(api, audio);
  audio.muted = true;
  assert.deepEqual(values.at(-1), { volume: 1, muted: true, outputDb: -6 });
  assert.ok(events.length > 0);
  audio.volume = 0.4;
  assert.equal(values.length, 3);
  flush();
  assert.equal(values.length, 3);
  audio.muted = 1;
  audio.volume = 0.4;
  flush();
  assert.equal(values.length, 3);
  audio.muted = 0;
  assert.equal(values.at(-1).muted, false);
  stop();
});

test('invalid writes keep native validation, logical state and subscribers unchanged', () => {
  const { api, Audio, nativeVolume, records, prototype, flush } = fixture();
  const audio = new Audio();
  api.attach(audio);
  const { values } = collect(api, audio);
  for (const value of [-1, 2, Infinity, NaN, undefined, Symbol(), 1n]) {
    assert.throws(() => {
      audio.volume = value;
    });
    assert.equal(audio.volume, 1);
  }
  let conversions = 0;
  assert.throws(
    () => {
      audio.volume = {
        valueOf() {
          conversions++;
          return 2;
        },
      };
    },
    { name: 'IndexSizeError' },
  );
  assert.equal(conversions, 1);
  assert.throws(
    () =>
      Object.getOwnPropertyDescriptor(prototype, 'volume').set.call({}, 0.4),
    { name: 'TypeError' },
  );
  assert.throws(
    () =>
      Object.getOwnPropertyDescriptor(prototype, 'muted').set.call({}, true),
    { name: 'TypeError' },
  );
  records.get(audio).failVolume = true;
  assert.throws(() => {
    audio.volume = 0.6;
  }, /Native volume failed/);
  records.get(audio).failMuted = true;
  assert.throws(() => {
    audio.muted = true;
  }, /Native muted failed/);
  flush();
  assert.equal(values.length, 1);
  assert.equal(nativeVolume.get.call(audio), 10 ** (-6 / 20));
});

test('failed attach leaves logical ownership unset and emits no change', () => {
  const { api, Audio, records, nativeVolume } = fixture();
  const audio = new Audio();
  records.get(audio).failVolume = true;
  const { values } = collect(api, audio);
  assert.throws(() => api.attach(audio), /Native volume failed/);
  records.get(audio).failVolume = false;
  nativeVolume.set.call(audio, 0.7);
  assert.equal(api.readLevel(audio).volume, 0.7);
  api.attach(audio);
  assert.equal(values.at(-1).volume, 0.7);
});

test('subscription ownership shares one listener and removes it after the final unsubscribe', () => {
  const { api, Audio, records, flush } = fixture();
  const audio = new Audio();
  const calls = [];
  const callback = (value) => calls.push(value.volume);
  const first = api.subscribeLevel(audio, callback);
  const second = api.subscribeLevel(audio, callback);
  assert.equal(records.get(audio).adds, 1);
  first();
  first();
  assert.equal(records.get(audio).removes, 0);
  audio.volume = 0.4;
  assert.deepEqual(calls, [1, 1, 0.4]);
  second();
  assert.equal(records.get(audio).removes, 1);
  audio.volume = 0.5;
  flush();
  assert.deepEqual(calls, [1, 1, 0.4]);
  const third = api.subscribeLevel(audio, callback);
  assert.equal(records.get(audio).adds, 2);
  third();
  assert.equal(records.get(audio).removes, 2);
});

test('apply, storage and reload update subscribed audio once and preserve scaling', () => {
  const { api, Audio, references, external, storage, nativeVolume, flush, ui } =
    fixture();
  const first = new Audio();
  const second = new Audio();
  api.attach(first);
  api.attach(second);
  first.volume = 0.8;
  second.volume = 0.4;
  references.add(new WeakRef(first));
  const a = collect(api, first);
  const b = collect(api, second);
  api.set(-12);
  assert.equal(ui.outputSlider.style.getPropertyValue('--range-fill'), '50%');
  assert.equal(a.values.length, 2);
  assert.equal(b.values.length, 2);
  assert.equal(nativeVolume.get.call(first), 0.8 * 10 ** (-12 / 20));
  assert.equal(nativeVolume.get.call(second), 0.4 * 10 ** (-12 / 20));
  external('other.setting', '-1');
  assert.equal(a.values.length, 2);
  external(key, '-9');
  assert.equal(ui.outputSlider.style.getPropertyValue('--range-fill'), '62.5%');
  assert.equal(a.values.at(-1).outputDb, -9);
  storage.set(key, '-3');
  api.reload();
  assert.equal(b.values.at(-1).outputDb, -3);
  assert.equal(ui.outputSlider.value, '-3');
  assert.equal(ui.outputValue.textContent, '-3 dB');
  assert.equal(ui.outputSlider.style.getPropertyValue('--range-fill'), '87.5%');
  flush();
  assert.equal(a.values.length, 4);
  assert.equal(b.values.length, 4);
  a.stop();
  b.stop();
});

test('storage failures restore the previous level without publishing a failed setting', () => {
  const { api, Audio, settings, nativeVolume, flush } = fixture();
  const audio = new Audio();
  api.attach(audio);
  const { values } = collect(api, audio);
  settings.failStorage = true;
  assert.throws(() => api.set(-12), /could not be saved/);
  assert.equal(api.value(), -6);
  assert.equal(nativeVolume.get.call(audio), 10 ** (-6 / 20));
  flush();
  assert.equal(values.length, 1);
});

test('native muted changes are observed through volumechange without altering logical volume', () => {
  const { api, Audio, nativeMuted, nativeVolume, flush } = fixture();
  const audio = new Audio();
  api.attach(audio);
  const { values } = collect(api, audio);
  nativeMuted.set.call(audio, true);
  assert.equal(values.length, 1);
  flush();
  assert.equal(values.at(-1).muted, true);
  nativeVolume.set.call(audio, 0);
  flush();
  assert.equal(values.length, 2);
  assert.equal(api.readLevel(audio).volume, 1);
});

test('a subscriber joining before queued native events receives the current level only once', () => {
  const { api, Audio, nativeMuted, flush } = fixture();
  const audio = new Audio();
  api.attach(audio);
  flush();
  const first = collect(api, audio);
  nativeMuted.set.call(audio, true);
  const second = collect(api, audio);
  flush();
  assert.equal(first.values.length, 2);
  assert.equal(second.values.length, 1);
  assert.equal(second.values[0].muted, true);
});

test('videos retain native setters and are outside the audio subscription API', () => {
  const { api, Video, nativeVolume, references } = fixture();
  const video = new Video();
  video.volume = 0.8;
  video.muted = 'yes';
  references.add(new WeakRef(video));
  api.attach(video);
  api.set(-24);
  assert.equal(video.volume, 0.8);
  assert.equal(nativeVolume.get.call(video), 0.8);
  assert.equal(video.muted, true);
  assert.throws(() => api.readLevel(video), { name: 'TypeError' });
  assert.throws(() => api.subscribeLevel(video, () => {}), {
    name: 'TypeError',
  });
});

test('subscriber errors and reentrant changes cannot prevent current notifications or deliver stale levels', () => {
  const { api, Audio, warnings } = fixture();
  const audio = new Audio();
  api.attach(audio);
  let armed = false;
  const later = [];
  const throwing = api.subscribeLevel(audio, () => {
    throw new Error('Subscriber failed');
  });
  api.subscribeLevel(audio, (value) => {
    if (armed && value.volume === 0.4) audio.muted = true;
  });
  api.subscribeLevel(audio, (value) => later.push({ ...value }));
  armed = true;
  audio.volume = 0.4;
  assert.deepEqual(later, [
    { volume: 1, muted: false, outputDb: -6 },
    { volume: 0.4, muted: true, outputDb: -6 },
  ]);
  assert.equal(warnings.length, 3);
  throwing();
});
