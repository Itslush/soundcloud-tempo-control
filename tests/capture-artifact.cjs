const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parsers } = require('prettier/plugins/babel');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function inspect(code) {
  const program = parsers.babel.parse(code).program;
  const body =
    program.body.length === 1 && program.body[0].expression?.callee?.body?.body;
  if (!Array.isArray(body)) throw new Error('Unexpected userscript structure');
  const audio = body.filter(
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.declarations.some((item) => item.id.name === 'audioModules'),
  );
  if (audio.length !== 1 || audio[0].declarations.length !== 1)
    throw new Error('Expected one standalone audio bundle');
  return {
    artifactSha256: hash(code),
    nonAudioSha256: hash(
      code.slice(0, audio[0].start) + code.slice(audio[0].end),
    ),
  };
}

function verify(code, evidence) {
  const current = inspect(code);
  if (current.artifactSha256 === evidence.artifactSha256)
    return { ...current, scope: 'captured-artifact' };
  const proof = evidence.nonAudioDerivation;
  if (
    proof?.scheme !== 'outside-audioModules-declaration-v1' ||
    proof.derivedFromArtifactSha256 !== evidence.artifactSha256 ||
    proof.sha256 !== current.nonAudioSha256
  )
    throw new Error(
      'Non-audio code changed since the screenshots were captured',
    );
  return {
    ...current,
    scope: 'unchanged-non-audio-code',
    capturedArtifactSha256: evidence.artifactSha256,
  };
}

module.exports = { inspect, verify };
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const code = fs.readFileSync(
    process.argv[2] || path.join(root, 'dist/soundcloud-tempo-control.user.js'),
    'utf8',
  );
  const evidence = JSON.parse(
    fs.readFileSync(path.join(root, 'docs/screenshot-evidence.json'), 'utf8'),
  );
  console.log(JSON.stringify(verify(code, evidence)));
}
