import assert from 'node:assert/strict';
import moduleFixture from './module-fixture.cjs';
import test from 'node:test';
import vm from 'node:vm';

const source = moduleFixture(['tempo-editor.js']);
const track = '/artist/track';
const storageKey = (key) =>
  'soundcloud.tempo.timeline.' + encodeURIComponent(key);

function profile({ key = track, curve = 'linear', rates = [1, 0.5] } = {}) {
  return {
    v: 1,
    track: key,
    duration: 60,
    points: [
      { t: 0, r: rates[0], d: 0, c: 'instant' },
      { t: 20, r: rates[1], d: 10, c: curve },
    ],
  };
}

function media(paused = true) {
  return Object.assign(new EventTarget(), {
    paused,
    ended: false,
    currentTime: 0,
    duration: 60,
    dataset: {},
  });
}

function fixture(data = profile(), enabled = true) {
  const values = new Map();
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: true });
  const timers = new Map();
  const api = {
    ready: false,
    rate: 1,
    copyLinks: true,
    pitchMode: data?.pitch ?? 'natural',
    parseTrack: (key) => (/^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(key) ? key : ''),
    refresh() {},
    normal() {},
  };
  const context = {
    window,
    document,
    location: { hash: '' },
    localStorage: { getItem: (key) => values.get(key) ?? null },
    TextEncoder,
    TextDecoder,
    URL,
    btoa,
    atob,
    api,
    setTimeout(fn) {
      const id = timers.size + 1;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  function save(value, state = true) {
    values.set(
      storageKey(value.track),
      JSON.stringify({ data: value, enabled: state }),
    );
  }
  if (data) save(data, enabled);
  const editor = vm.runInNewContext(
    source + '\ncreateTempoEditor(api)',
    context,
  );
  return { editor, save, values, window, timers, api };
}

function sharedProfile(link) {
  const url = new URL(link);
  assert.equal(url.origin, 'https://soundcloud.com');
  assert.ok(url.hash.startsWith('#sct=SCT1.'));
  return JSON.parse(
    Buffer.from(url.hash.slice('#sct=SCT1.'.length), 'base64url').toString(
      'utf8',
    ),
  );
}

test('playback schedule is immutable and retains object and function identity across ticks', () => {
  const { editor } = fixture();
  const audio = media();
  editor.changeTrack(track);
  editor.observe(audio);
  const schedule = editor.playbackSchedule(audio);
  assert.ok(Object.isFrozen(schedule));
  assert.throws(() => {
    schedule.minimumRate = 4;
  }, TypeError);
  for (let index = 0; index < 1000; index++) {
    audio.currentTime = index / 100;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(editor.playbackSchedule(audio), schedule);
    assert.equal(editor.playbackSchedule(audio).rateAt, schedule.rateAt);
    schedule.rateAt(index / 100);
  }
});

test('audio interpolation keeps precision while displayed value remains rounded', () => {
  const { editor } = fixture();
  const audio = media();
  editor.changeTrack(track);
  editor.observe(audio);
  audio.currentTime = 10 + 1 / 3;
  const exact = 1 - (0.5 * (audio.currentTime - 10)) / 10;
  assert.equal(editor.playbackSchedule(audio).rateAt(audio.currentTime), exact);
  assert.equal(editor.value(), 0.983);
  assert.notEqual(
    editor.playbackSchedule(audio).rateAt(audio.currentTime),
    editor.value(),
  );
});

test('complete profile evaluation covers all curves, holds, exact nodes and endpoints', () => {
  const curves = {
    instant: () => 0,
    linear: (x) => x,
    'ease-in': (x) => x * x,
    'ease-out': (x) => 1 - (1 - x) ** 2,
    smooth: (x) => x * x * (3 - 2 * x),
  };
  for (const [curve, transform] of Object.entries(curves)) {
    const data = profile({ curve });
    data.points.push({ t: 30, r: 1.5, d: 0, c: 'instant' });
    const { editor } = fixture(data);
    const audio = media();
    editor.changeTrack(track);
    editor.observe(audio);
    const { rateAt } = editor.playbackSchedule(audio);
    assert.equal(rateAt(-100), 1);
    assert.equal(rateAt(0), 1);
    assert.equal(rateAt(10), 1);
    for (const x of [0.001, 0.13, 0.5, 0.77, 0.999]) {
      const time = 10 + 10 * x;
      assert.ok(
        Math.abs(rateAt(time) - (1 - 0.5 * transform((time - 10) / 10))) <
          1e-12,
      );
    }
    assert.equal(rateAt(20), 0.5);
    assert.equal(rateAt(29.999), 0.5);
    assert.equal(rateAt(30), 1.5);
    assert.equal(rateAt(1000), 1.5);
  }
});

test('missing, disabled, suspended and inactive media have no playback schedule', () => {
  const { editor, save } = fixture(profile(), false);
  const audio = media();
  assert.equal(editor.playbackSchedule(audio), null);
  editor.changeTrack(track);
  assert.equal(editor.playbackSchedule(audio), null);
  editor.observe(audio);
  assert.equal(editor.playbackSchedule(audio), null);
  save(profile());
  editor.refreshSaved(track);
  const schedule = editor.playbackSchedule(audio);
  assert.ok(schedule);
  assert.equal(editor.playbackSchedule(media()), null);
  assert.equal(editor.playbackSchedule(undefined), null);
  editor.suspend();
  assert.equal(editor.playbackSchedule(audio), null);
  assert.equal(schedule.rateAt(15), 0.75);
});

test('native pause retains the selected media schedule but another playing element replaces it', () => {
  const { editor } = fixture();
  const first = media(false);
  const second = media(true);
  editor.changeTrack(track);
  editor.observe(first);
  editor.observe(second);
  const schedule = editor.playbackSchedule(first);
  first.paused = true;
  first.dispatchEvent(new Event('pause'));
  assert.equal(editor.playbackSchedule(first), schedule);
  second.paused = false;
  second.dispatchEvent(new Event('playing'));
  assert.equal(editor.playbackSchedule(first), null);
  assert.equal(editor.playbackSchedule(second), schedule);
});

test('track changes clear media ownership and replace the cached profile snapshot', () => {
  const { editor, save } = fixture();
  const audio = media();
  editor.changeTrack(track);
  editor.observe(audio);
  const old = editor.playbackSchedule(audio);
  const other = profile({ key: '/other/song', rates: [2, 0.25] });
  save(other);
  editor.changeTrack(other.track);
  assert.equal(editor.playbackSchedule(audio), null);
  editor.observe(audio);
  const current = editor.playbackSchedule(audio);
  assert.notEqual(current, old);
  assert.equal(current.rateAt(0), 2);
  assert.equal(current.minimumRate, 0.25);
  assert.equal(old.rateAt(0), 1);
  editor.changeTrack('/missing/song');
  editor.observe(audio);
  assert.equal(editor.playbackSchedule(audio), null);
});

test('saved replacements invalidate identity without changing an existing schedule closure', () => {
  const { editor, save, window } = fixture();
  const audio = media();
  editor.changeTrack(track);
  editor.observe(audio);
  const old = editor.playbackSchedule(audio);
  editor.refreshSaved('/unrelated/track');
  assert.equal(editor.playbackSchedule(audio), old);
  const updated = profile({ rates: [0.8, 0.4] });
  save(updated);
  window.dispatchEvent(
    Object.assign(new Event('storage'), { key: storageKey(track) }),
  );
  const current = editor.playbackSchedule(audio);
  assert.notEqual(current, old);
  assert.notEqual(current.rateAt, old.rateAt);
  assert.equal(current.minimumRate, 0.4);
  assert.equal(old.minimumRate, 0.5);
  updated.points[0].r = 3;
  assert.equal(current.rateAt(0), 0.8);
});

test('minimum rate includes every point and production validation retains the 0.025 bound', () => {
  const data = profile({ rates: [1.2, 0.7] });
  data.points.push({ t: 30, r: 0.025, d: 5, c: 'smooth' });
  data.points.push({ t: 40, r: 4, d: 5, c: 'ease-out' });
  const { editor } = fixture(data);
  const audio = media();
  editor.changeTrack(track);
  editor.observe(audio);
  assert.equal(editor.playbackSchedule(audio).minimumRate, 0.025);
  for (const time of [NaN, Infinity, -Infinity, '15', null])
    assert.throws(() => editor.playbackSchedule(audio).rateAt(time), /finite/);
  data.points[2].r = 0.024999999999;
  assert.throws(() => editor.validate(data), /0\.025/);
});

test('low-rate node validation accepts exact endpoints and rejects underflow before rounding', () => {
  const { editor } = fixture();
  for (const rate of [0.025, 0.05, 0.1, 0.249, 0.25, 4]) {
    const validated = editor.validate(profile({ rates: [rate, rate] }));
    assert.equal(validated.points[0].r, rate);
    assert.equal(validated.points[1].r, rate);
  }
  for (const rate of [
    -1,
    0,
    0.024,
    0.024999999999,
    4.000000000001,
    4.001,
    NaN,
    Infinity,
    -Infinity,
    '0.025',
    null,
    undefined,
  ]) {
    for (const index of [0, 1]) {
      const data = profile({ rates: [0.025, 0.1] });
      data.points[index].r = rate;
      assert.throws(() => editor.validate(data));
    }
  }
});

test('every low-rate curve survives saved reload with its full unrounded interpolation', () => {
  const curves = {
    instant: () => 0,
    linear: (x) => x,
    'ease-in': (x) => x * x,
    'ease-out': (x) => 1 - (1 - x) ** 2,
    smooth: (x) => x * x * (3 - 2 * x),
  };
  for (const [curve, transform] of Object.entries(curves)) {
    const data = profile({ curve, rates: [0.1, 0.025] });
    data.points.push({ t: 30, r: 0.05, d: 5, c: curve });
    const first = fixture(data);
    const audio = media();
    first.editor.changeTrack(track);
    first.editor.observe(audio);
    const before = first.editor.playbackSchedule(audio);
    const stored = JSON.parse(first.values.get(storageKey(track))).data;
    const reloaded = fixture(stored);
    reloaded.editor.changeTrack(track);
    reloaded.editor.observe(audio);
    const after = reloaded.editor.playbackSchedule(audio);
    assert.equal(after.minimumRate, 0.025);
    for (const x of [0, 0.001, 1 / 3, 0.5, 0.999]) {
      const downTime = 10 + x * 10;
      const upTime = 25 + x * 5;
      assert.ok(
        Math.abs(
          after.rateAt(downTime) -
            (0.1 - 0.075 * transform((downTime - 10) / 10)),
        ) < 1e-14,
      );
      assert.ok(
        Math.abs(
          after.rateAt(upTime) - (0.025 + 0.025 * transform((upTime - 25) / 5)),
        ) < 1e-14,
      );
      assert.equal(after.rateAt(downTime), before.rateAt(downTime));
    }
    for (const [time, expected] of [
      [-1, 0.1],
      [0, 0.1],
      [20, 0.025],
      [25, 0.025],
      [30, 0.05],
      [60, 0.05],
    ])
      assert.equal(after.rateAt(time), expected);
  }
});

test('shared low-rate timelines retain nodes, fade settings, pitch mode and recipient playback', () => {
  for (const pitch of ['natural', 'preserve']) {
    const data = profile({ curve: 'smooth', rates: [0.1, 0.025] });
    data.points.push({ t: 30, r: 0.05, d: 7.5, c: 'ease-out' });
    data.pitch = pitch;
    const sender = fixture(data);
    const audio = media();
    sender.editor.changeTrack(track);
    sender.editor.observe(audio);
    const link = sender.editor.shareLink(`https://soundcloud.com${track}`);
    const decoded = sharedProfile(link);
    assert.deepEqual(decoded, data);
    const receiver = fixture(decoded);
    const otherAudio = media();
    receiver.editor.changeTrack(track);
    receiver.editor.observe(otherAudio);
    const received = receiver.editor.playbackSchedule(otherAudio);
    assert.equal(received.minimumRate, 0.025);
    assert.equal(receiver.editor.pitchMode(), pitch);
    for (const time of [0, 10, 13.333333333, 20, 22.5, 25, 30, 60])
      assert.equal(
        received.rateAt(time),
        sender.editor.playbackSchedule(audio).rateAt(time),
      );
    assert.equal(
      receiver.editor.shareLink(`https://soundcloud.com${track}`),
      link,
    );
  }
});

test('single low-speed shares encode the current rate without a saved timeline', () => {
  for (const rate of [0.025, 0.05, 0.1]) {
    const { editor, api } = fixture(null);
    const audio = media();
    api.rate = rate;
    editor.changeTrack(track);
    editor.observe(audio);
    const decoded = sharedProfile(
      editor.shareLink(`https://soundcloud.com${track}`),
    );
    assert.deepEqual(decoded.points, [{ t: 0, r: rate, d: 0, c: 'instant' }]);
    assert.equal(decoded.duration, audio.duration);
    assert.equal(decoded.pitch, 'natural');
    const recipient = fixture(decoded);
    const recipientAudio = media();
    recipient.editor.changeTrack(track);
    recipient.editor.observe(recipientAudio);
    assert.equal(recipient.editor.validate(decoded).points[0].r, rate);
    for (const time of [0, 1, 30, 60])
      assert.equal(
        recipient.editor.playbackSchedule(recipientAudio).rateAt(time),
        rate,
      );
    api.rate = 0.024999999999;
    assert.equal(
      editor.shareLink(`https://soundcloud.com${track}`),
      `https://soundcloud.com${track}`,
    );
  }
});

test('invalid subminimum stored replacement cannot activate or alter an existing low-rate snapshot', () => {
  const { editor, save } = fixture(profile({ rates: [0.025, 0.1] }));
  const audio = media();
  editor.changeTrack(track);
  editor.observe(audio);
  const original = editor.playbackSchedule(audio);
  save(profile({ rates: [0.025, 0.024999999999] }));
  editor.refreshSaved(track);
  assert.equal(editor.playbackSchedule(audio), null);
  assert.equal(original.minimumRate, 0.025);
  assert.equal(original.rateAt(0), 0.025);
  assert.equal(original.rateAt(20), 0.1);
});

test('single-point schedules stay constant and mismatched stored tracks are not activated', () => {
  const data = profile({ rates: [0.775, 1] });
  data.points.length = 1;
  const { editor, values } = fixture(data);
  const audio = media();
  editor.changeTrack(track);
  editor.observe(audio);
  const schedule = editor.playbackSchedule(audio);
  assert.equal(schedule.minimumRate, 0.775);
  for (const time of [-1, 0, 0.0001, 30, 86400])
    assert.equal(schedule.rateAt(time), 0.775);
  values.set(
    storageKey(track),
    JSON.stringify({
      data: profile({ key: '/other/song' }),
      enabled: true,
    }),
  );
  editor.refreshSaved(track);
  assert.equal(editor.playbackSchedule(audio), null);
  assert.equal(schedule.rateAt(10), 0.775);
});
