const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect, verify } = require('./capture-artifact.cjs');
const original =
  '(() => {const audioModules = {rate: 1}; const label = "tempo";})();';
const identity = inspect(original);
const evidence = {
  artifactSha256: identity.artifactSha256,
  nonAudioDerivation: {
    scheme: 'outside-audioModules-declaration-v1',
    derivedFromArtifactSha256: identity.artifactSha256,
    sha256: identity.nonAudioSha256,
  },
};

test('exact captures need no retrospective derivation', () => {
  assert.equal(
    verify(original, { artifactSha256: identity.artifactSha256 }).scope,
    'captured-artifact',
  );
});
test('audio-only edits retain original capture attribution', () => {
  const result = verify(original.replace('rate: 1', 'rate: 2'), evidence);
  assert.equal(result.scope, 'unchanged-non-audio-code');
  assert.equal(result.capturedArtifactSha256, identity.artifactSha256);
  assert.notEqual(result.artifactSha256, identity.artifactSha256);
});
test('interface edits and unrelated derivations are rejected', () => {
  assert.throws(() => verify(original.replace('tempo', 'speed'), evidence));
  assert.throws(() =>
    verify(original.replace('rate: 1', 'rate: 2'), {
      ...evidence,
      nonAudioDerivation: {
        ...evidence.nonAudioDerivation,
        derivedFromArtifactSha256: 'wrong',
      },
    }),
  );
  assert.throws(() =>
    verify(original.replace('rate: 1', 'rate: 2'), {
      artifactSha256: identity.artifactSha256,
    }),
  );
});
test('unexpected bundle boundaries fail closed', () => {
  assert.throws(() =>
    inspect('(() => {const audioModules = {}, label = "tempo";})();'),
  );
  assert.throws(() => inspect('const audioModules = {};'));
  assert.throws(() => inspect('(() => {})();'));
});
