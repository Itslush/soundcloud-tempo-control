const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildScript } = require('../scripts/build-userscript.cjs');
const artifactConstants = require('./artifact-constants.cjs');
const { root, validateConfig } = require('../scripts/config.cjs');

const empty = { siteUrl: '', paypalUrl: '', repositoryUrl: '' };

test('local builds contain no fake deployment or payment URLs', async () => {
  const result = await buildScript(empty, '1.0.0');
  assert.match(result.metadata, /@version\s+1\.0\.0\b/);
  assert.doesNotMatch(result.metadata, /@(downloadURL|updateURL|homepageURL)/);
  assert.equal(result.updatesConfigured, false);
  assert.doesNotMatch(result.output, /__TEMPO_VERSION__|__TEMPO_WEBSITE__/);
});

test('release URLs support subdirectory hosting and retain identity', async () => {
  const result = await buildScript(
    { ...empty, siteUrl: 'https://example.com/tempo' },
    '1.0.1',
  );
  assert.match(
    result.metadata,
    /@downloadURL\s+https:\/\/example.com\/tempo\/downloads\/soundcloud-tempo-control.user.js/,
  );
  assert.match(
    result.metadata,
    /@updateURL\s+https:\/\/example.com\/tempo\/downloads\/soundcloud-tempo-control.meta.js/,
  );
  assert.match(result.metadata, /@namespace\s+soundcloud-tempo-control\n/);
  assert.match(
    result.metadata,
    /@name\s+SoundCloud Tempo Control \(Natural Pitch\)/,
  );
  assert.deepEqual(artifactConstants(result.output, ['VERSION', 'WEBSITE']), {
    VERSION: '1.0.1',
    WEBSITE: 'https://example.com/tempo/',
  });
});

test('build output is deterministic', async () => {
  const first = await buildScript(empty);
  const second = await buildScript(empty);
  assert.equal(first.output, second.output);
  assert.equal(first.sourceMap, second.sourceMap);
  assert.deepEqual(first.worklet, second.worklet);
  const map = JSON.parse(first.sourceMap);
  assert.equal(map.version, 3);
  assert.equal(map.sources.length, map.sourcesContent.length);
  assert.ok(map.mappings.length > 0);
  for (const file of ['src/tempo-inline-source.js', 'src/tempo-editor.js']) {
    const index = map.sources.indexOf(file);
    assert.ok(index >= 0, `${file} is mapped to its original module`);
    assert.equal(
      map.sourcesContent[index],
      fs.readFileSync(path.join(root, file), 'utf8'),
    );
  }
  const workletMap = JSON.parse(first.worklet.sourceMap);
  const processor = workletMap.sources.indexOf(
    'src/audio/preserve-worklet.mjs',
  );
  assert.ok(processor >= 0);
  assert.equal(
    workletMap.sourcesContent[processor],
    fs.readFileSync(path.join(root, 'src/audio/preserve-worklet.mjs'), 'utf8'),
  );
});

test('invalid destinations and unresolved release setup fail closed', () => {
  assert.throws(() => validateConfig(empty, true), /Set siteUrl/);
  for (const siteUrl of [
    'http://example.com',
    'https://localhost',
    'https://user:secret@example.com',
    'https://example.com/#other',
  ]) {
    assert.throws(() => validateConfig({ ...empty, siteUrl }));
  }
  for (const paypalUrl of [
    'javascript:alert(1)',
    'https://paypal.com.evil.test/me',
    'https://example.com',
  ]) {
    assert.throws(() => validateConfig({ ...empty, paypalUrl }));
  }
  assert.equal(
    validateConfig({ ...empty, paypalUrl: 'https://paypal.me/demo' }).paypalUrl,
    'https://paypal.me/demo',
  );
});

test('website downloads and hashes exactly match the userscript artifact', () => {
  const script = fs.readFileSync(
    path.join(root, 'dist/soundcloud-tempo-control.user.js'),
  );
  const copy = fs.readFileSync(
    path.join(root, 'site/public/downloads/soundcloud-tempo-control.user.js'),
  );
  assert.deepEqual(script, copy);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'dist/release.json')),
  );
  assert.equal(manifest.version, require('../package.json').version);
  assert.equal(
    manifest.sha256,
    createHash('sha256').update(script).digest('hex'),
  );
  assert.equal(manifest.bytes, script.length);
});
