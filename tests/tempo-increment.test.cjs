const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const source = require('./module-fixture.cjs')(['tempo-increment.js', 'tempo-pitch-settings.js']);

test('tempo increment loads finite supported values, with a safe default for bad storage', () => {
  let stored = null;
  const api = vm.runInNewContext(source + ';fixtureModule', {
    localStorage: { getItem() { return stored; } },
  });
  for (const value of [null, '', '0', '-0.1', 'Infinity', 'NaN', '2', '{}']) {
    stored = value;
    assert.equal(api.readTempoIncrement(), 0.025);
  }
  for (const value of [0.001, 0.025, 0.125, 1]) {
    stored = String(value);
    assert.equal(api.readTempoIncrement(), value);
  }
  const blocked = vm.runInNewContext(source + ';fixtureModule', {
    localStorage: { getItem() { throw new Error('Blocked'); } },
  });
  assert.equal(blocked.readTempoIncrement(), 0.025);
});

test('old note-mode settings retain pitch bounds and increment without enabling note mode', () => {
  const api = vm.runInNewContext(source + ';fixtureModule', {
    localStorage: { getItem() { return JSON.stringify({ min: -6, max: 7, step: 0.125, notes: true, source: 9 }); } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.readPitchSettings())), { min: -6, max: 7, step: 0.125 });
});
