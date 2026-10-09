const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const source = require('./module-fixture.cjs')([
  'tempo-share.js',
  'tempo-profile.js',
  'tempo-pitch-settings.js',
]);
const api = vm.runInNewContext(source + ';fixtureModule', {
  URL,
  TextEncoder,
  TextDecoder,
  btoa,
  atob,
});
const website = 'https://itslush.github.io/soundcloud-tempo-control/';
const parseTrack = (value) =>
  /^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(value) ? value : '';
const validate = (value) => api.validateProfile(value, parseTrack);
const profile = {
  v: 1,
  track: '/artist/song',
  duration: 90,
  keyShift: -0.25,
  points: [{ t: 0, r: 0.75, d: 0, c: 'instant' }],
  pitchPoints: [
    { t: 0, k: -0.25, d: 0, c: 'instant' },
    { t: 20, k: 2.5, d: 10, c: 'smooth' },
  ],
};
const decode = (value) =>
  api.decodeTempoCode(value, validate, parseTrack, website);

test('pitch automation survives code, legacy URL and website URL round trips', () => {
  for (const value of [
    api.encodeTempoCode(profile),
    api.tempoShareLink(profile),
    api.tempoShareLink(profile, website),
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(decode(value))), profile);
  }
  const url = new URL(api.tempoShareLink(profile, website));
  assert.equal(url.pathname, '/soundcloud-tempo-control/share/');
  assert.equal(url.search, '');
  assert.ok(url.hash.startsWith('#sct=SCT1.'));
});

test('share imports reject spoofed origins, credentials, mismatched tracks and malformed data', () => {
  const landing = api.tempoShareLink(profile, website);
  for (const value of [
    landing.replace('itslush.github.io', 'evil.example'),
    landing.replace('https://', 'https://user:secret@'),
    landing.replace('/share/', '/other/'),
    api.tempoShareLink(profile).replace('/artist/song?', '/artist/other?'),
    'SCT1.%%%%',
    'SCT1._w',
    'SCT1.' + 'A'.repeat(50000),
    api.encodeTempoCode({ ...profile, track: '//evil.example' }),
    api.encodeTempoCode({
      ...profile,
      pitchPoints: [{ t: 0, k: 12.01, d: 0, c: 'instant' }],
    }),
  ])
    assert.throws(() => decode(value), value.slice(0, 80));
  assert.throws(
    () => api.tempoShareLink({ ...profile, extra: 'x'.repeat(8000) }, website),
    /Too large/,
  );
});

test('pitch range and step reject invalid settings and accept older note-mode preferences', () => {
  assert.ok(
    api.validPitchSettings({
      min: -5.5,
      max: 8.25,
      step: 0.125,
      notes: true,
      source: 9,
    }),
  );
  for (const patch of [
    { min: -13 },
    { max: 13 },
    { min: 12 },
    { step: 0 },
    { step: Infinity },
  ])
    assert.ok(
      !api.validPitchSettings({ ...api.defaultPitchSettings, ...patch }),
    );
  assert.equal(api.pitchNote, undefined);
  assert.equal(api.shiftToNote, undefined);
});
