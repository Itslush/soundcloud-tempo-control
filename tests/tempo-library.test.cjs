const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');

const sources = require('./module-fixture.cjs')([
  'tempo-editor.js',
  'tempo-library.js',
]);
const track = '/artist/track';
const fixedKey = 'soundcloud.tempo.track.' + encodeURIComponent(track);
const timelineKey = 'soundcloud.tempo.timeline.' + encodeURIComponent(track);
const profile = (key = track) => ({
  v: 1,
  track: key,
  duration: 200,
  points: [
    { t: 0, r: 0.8, d: 0, c: 'instant' },
    { t: 20, r: 1, d: 10, c: 'smooth' },
  ],
  pitch: 'preserve',
});
const backup = (
  tracks = [
    {
      track,
      speed: { rate: 0.8, enabled: false },
      timeline: { data: profile(), enabled: true },
    },
  ],
) => ({
  format: 'soundcloud-tempo-control',
  version: 1,
  tracks,
  preferences: {
    randomSaved: true,
    copyLinks: true,
    preserveKey: false,
    useWasm: true,
    outputDb: -8,
  },
});

function fixture(values = {}) {
  const map = new Map(Object.entries(values));
  const storage = {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
  const context = {
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    location: { hash: '' },
    TextEncoder,
    api: {
      parseTrack: (value) =>
        /^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(value) ? value : '',
    },
    storage,
  };
  const store = vm.runInNewContext(
    sources +
      '\nconst editor = createTempoEditor(api); createTempoStore({ storage: () => storage, parseTrack: api.parseTrack, validateTimeline: editor.validate });',
    context,
  );
  return { store, storage, map };
}

test('legacy speeds, disabled speeds and timeline-only tracks share one validated inventory', () => {
  const { store, map } = fixture({
    [fixedKey]: '0.75',
    [timelineKey]: JSON.stringify({ data: profile(), enabled: true }),
    'unrelated.key': 'keep',
  });
  assert.equal(store.tracks().length, 1);
  assert.equal(store.tracks()[0].speed.rate, 0.75);
  store.set(track, 'speed', { rate: 0.75, enabled: false });
  assert.equal(store.speed(track).enabled, false);
  store.set(track, 'speed', null);
  assert.equal(store.tracks().length, 1);
  assert.equal(store.tracks()[0].timeline.data.pitch, 'preserve');
  store.set(track, 'timeline', null);
  assert.equal(store.tracks().length, 0);
  assert.equal(map.get('unrelated.key'), 'keep');
});

test('buffered speeds survive legacy reads, disabled saves and fresh store reloads', () => {
  for (const rate of [0.025, 0.05, 0.1, 0.249, 0.25, 4]) {
    const first = fixture({ [fixedKey]: JSON.stringify(rate) });
    assert.equal(first.store.speed(track).rate, rate);
    assert.equal(first.store.speed(track).enabled, true);
    first.store.set(track, 'speed', { rate, enabled: false });
    const second = fixture(Object.fromEntries(first.map));
    assert.equal(second.store.speed(track).rate, rate);
    assert.equal(second.store.speed(track).enabled, false);
    second.store.set(track, 'speed', { rate, enabled: true });
    assert.equal(second.map.get(fixedKey), JSON.stringify(rate));
    assert.equal(second.store.tracks()[0].speed.rate, rate);
  }
});

test('speed boundaries reject before rounding without overwriting a saved low rate', () => {
  const { store, map } = fixture({ [fixedKey]: '0.025' });
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
    assert.throws(() => store.set(track, 'speed', { rate, enabled: true }));
    assert.equal(map.get(fixedKey), '0.025');
    assert.equal(store.speed(track).rate, 0.025);
  }
});

test('low-rate timelines and fixed speeds survive backup import and export together', () => {
  const tracks = [0.025, 0.05, 0.1].map((rate, index) => {
    const key = `/artist/low-${index}`;
    const data = profile(key);
    data.points = [
      { t: 0, r: 0.1, d: 0, c: 'instant' },
      { t: 20, r: 0.025, d: 10, c: 'smooth' },
      { t: 40, r: 0.05, d: 15, c: 'linear' },
    ];
    return {
      track: key,
      speed: { rate, enabled: index !== 1 },
      timeline: { data, enabled: index !== 2 },
    };
  });
  const first = fixture();
  first.store.commit(first.store.prepare(JSON.stringify(backup(tracks))));
  const exported = first.store.exportBackup();
  const second = fixture();
  second.store.commit(second.store.prepare(exported));
  assert.equal(second.store.exportBackup(), exported);
  for (const item of tracks) {
    const saved = second.store.speed(item.track);
    const timeline = second.store.timeline(item.track);
    assert.equal(saved.rate, item.speed.rate);
    assert.equal(saved.enabled, item.speed.enabled);
    assert.equal(timeline.enabled, item.timeline.enabled);
    assert.equal(timeline.data.pitch, 'preserve');
    assert.deepEqual(
      JSON.parse(JSON.stringify(timeline.data.points)),
      item.timeline.data.points,
    );
  }
});

test('a subminimum speed or timeline rejects the entire mixed low-rate backup', () => {
  const { store, map } = fixture({
    [fixedKey]: '0.05',
    'unrelated.key': 'keep',
  });
  const before = [...map];
  for (const type of ['speed', 'timeline']) {
    const invalid = { track: '/other/song' };
    if (type === 'speed')
      invalid.speed = { rate: 0.024999999999, enabled: true };
    else {
      const data = profile(invalid.track);
      data.points[1].r = 0.024999999999;
      invalid.timeline = { data, enabled: true };
    }
    assert.throws(() =>
      store.prepare(
        JSON.stringify(
          backup([{ track, speed: { rate: 0.025, enabled: true } }, invalid]),
        ),
      ),
    );
    assert.deepEqual([...map], before);
  }
});

test('backup roundtrip preserves state and merges without deleting unrelated tracks', () => {
  const { store, map } = fixture({
    'soundcloud.tempo.track.%2Fother%2Fsong': '1.1',
    'unrelated.key': 'keep',
  });
  const input = JSON.stringify(backup());
  const preview = store.prepare(input);
  assert.equal(map.has(fixedKey), false);
  store.commit(preview);
  assert.equal(store.speed(track).enabled, false);
  assert.equal(store.timeline(track).data.points[1].c, 'smooth');
  const exported = store.exportBackup();
  const second = fixture();
  second.store.commit(second.store.prepare(exported));
  assert.equal(second.store.exportBackup(), exported);
  assert.equal(map.get('unrelated.key'), 'keep');
  assert.equal(store.tracks().length, 2);
});

test('malformed, unsafe, duplicate, mixed and oversized backups never write', () => {
  const { store, map } = fixture({ [fixedKey]: '0.75' });
  const invalid = [
    null,
    {},
    { ...backup(), version: 2 },
    { ...backup(), preferences: { outputDb: 1 } },
    { ...backup(), preferences: { preserveKey: 'true' } },
    { ...backup(), preferences: { unknown: false } },
    backup([
      {
        track: 'https://evil.test/artist/track',
        speed: { rate: 1, enabled: true },
      },
    ]),
    backup([
      { track, speed: { rate: 0.8, enabled: true } },
      { track, speed: { rate: 1, enabled: true } },
    ]),
    backup([
      { track, speed: { rate: 0.8, enabled: true } },
      { track: '/other/song', speed: { rate: 8, enabled: true } },
    ]),
    backup([{ track, speed: { rate: 0.8, enabled: 1 } }]),
    backup([
      { track, timeline: { data: profile('/other/song'), enabled: true } },
    ]),
    backup([
      {
        track,
        timeline: {
          data: {
            ...profile(),
            points: [
              { t: 0, r: 1, d: 0, c: 'instant' },
              { t: 5, r: 1, d: 9, c: 'linear' },
            ],
          },
          enabled: true,
        },
      },
    ]),
  ];
  for (const value of invalid)
    assert.throws(() => store.prepare(JSON.stringify(value)));
  assert.throws(() => store.prepare('{bad'));
  assert.throws(() => store.prepare(' '.repeat(store.limit + 1)));
  assert.deepEqual([...map], [[fixedKey, '0.75']]);
});

test('import detects stale previews before any overwrite', () => {
  const { store, map } = fixture({ [fixedKey]: '0.75' });
  const preview = store.prepare(JSON.stringify(backup()));
  map.set(fixedKey, '0.9');
  assert.throws(() => store.commit(preview), /changed/);
  assert.equal(map.size, 1);
  assert.equal(map.get(fixedKey), '0.9');
});

test('partial storage failure rolls successful writes back', () => {
  const { store, storage, map } = fixture({
    [fixedKey]: '0.75',
    'unrelated.key': 'keep',
  });
  const before = [...map];
  const preview = store.prepare(JSON.stringify(backup()));
  const write = storage.setItem;
  let writes = 0;
  storage.setItem = (key, value) => {
    if (++writes === 3) throw new Error('Quota exceeded');
    write(key, value);
  };
  assert.throws(() => store.commit(preview), /previous settings were kept/);
  assert.deepEqual([...map], before);
});

test('invalid local records do not become executable links or block valid entries', () => {
  const { store } = fixture({
    [fixedKey]: '0.8',
    [timelineKey]: '{invalid',
    'soundcloud.tempo.track.%2Fartist%2F%3Cscript%3E': '0.7',
    'soundcloud.tempo.track.%zz': '1',
    'soundcloud.tempo.track.%2Fother%2Fsong': '{"rate":0.9,"enabled":"true"}',
  });
  assert.equal(store.tracks().length, 1);
  assert.equal(store.tracks()[0].track, track);
});

test('backup count and aggregate point limits reject before writing', () => {
  const { store, map } = fixture();
  const tooMany = Array.from({ length: 1001 }, (_, index) => ({
    track: `/artist/track-${index}`,
    speed: { rate: 1, enabled: true },
  }));
  assert.throws(() => store.prepare(JSON.stringify(backup(tooMany))), /1,000/);
  const points = Array.from({ length: 200 }, (_, index) => ({
    t: index,
    r: 1,
    d: 0,
    c: 'instant',
  }));
  const dense = Array.from({ length: 101 }, (_, index) => {
    const track = `/artist/track-${index}`;
    return {
      track,
      timeline: { data: { ...profile(track), points }, enabled: true },
    };
  });
  assert.throws(() => store.prepare(JSON.stringify(backup(dense))), /20,000/);
  assert.equal(map.size, 0);
});

test('rollback failure is reported without claiming all previous values were restored', () => {
  const { store, storage } = fixture({ [fixedKey]: '0.75' });
  const preview = store.prepare(JSON.stringify(backup()));
  const write = storage.setItem;
  let writes = 0;
  storage.setItem = (key, value) => {
    if (++writes >= 2) throw new Error('Blocked');
    write(key, value);
  };
  assert.throws(
    () => store.commit(preview),
    /some settings could not be restored/,
  );
});
