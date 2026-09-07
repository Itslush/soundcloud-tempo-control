const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { parsers } = require('prettier/plugins/babel');
const root = path.resolve(__dirname, '..');
const output = fs.readFileSync(
  path.resolve(
    root,
    process.argv[2] || 'dist/soundcloud-tempo-control.user.js',
  ),
  'utf8',
);
const lock = require('../vendor/signalsmith/signalsmith.json');
const vendor = fs.readFileSync(
  path.join(root, 'vendor/signalsmith', lock.file),
);
const ast = parsers.babel.parse(output);
const prefix = 'data:application/octet-stream;base64,';
const original = vendor
  .toString('utf8')
  .match(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/)[1];
assert.equal(createHash('sha256').update(vendor).digest('hex'), lock.sha256);
assert.ok(WebAssembly.validate(Buffer.from(original, 'base64')));
assert.deepEqual(
  [...output.matchAll(/^\/\/ @require\s+(\S+)$/gm)].map((match) => match[1]),
  [],
);
assert.ok(lock.url.includes(`@${lock.revision}/`));
assert.ok(ast.comments.length >= 13);
const metadataEnd =
  output.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length;
assert.ok(
  ast.comments.every(
    (comment) => comment.type === 'CommentLine' && comment.end <= metadataEnd,
  ),
);

const migrations = [];
const embeddedWasm = [];
function findMigration(node) {
  if (!node || typeof node !== 'object') return;
  if (
    node.type === 'FunctionDeclaration' &&
    node.id?.name === 'migrateTrackStorage'
  )
    migrations.push(node);
  if (
    node.type === 'StringLiteral' &&
    node.value.startsWith(prefix) &&
    node.value.length > prefix.length
  )
    embeddedWasm.push(node.value.slice(prefix.length));
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'tokens', 'comments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(findMigration);
    else if (value && typeof value === 'object') findMigration(value);
  }
}
findMigration(ast.program);
assert.deepEqual(embeddedWasm, [original]);
assert.equal(migrations.length, 1);
const [migration] = migrations;
const old = 'legacy.soundcloud.tempo.track.%2Fartist%2Ftrack';
const current = 'soundcloud.tempo.track.%2Fartist%2Ftrack';
for (const existing of [null, '0.9']) {
  const storage = { [old]: '0.7' };
  if (existing !== null) storage[current] = existing;
  Object.defineProperties(storage, {
    getItem: { value: (key) => storage[key] ?? null },
    setItem: {
      value: (key, value) => {
        storage[key] = value;
      },
    },
    removeItem: {
      value: (key) => {
        delete storage[key];
      },
    },
  });
  vm.runInNewContext(
    output.slice(migration.start, migration.end) + ';migrateTrackStorage();',
    { localStorage: storage },
  );
  assert.equal(storage[current], existing ?? '0.7');
  assert.ok(!(old in storage));
}
console.log(
  'Pinned dependency checksum and embedded WASM validated; no CDN metadata; metadata-only comments; storage migration passed.',
);
