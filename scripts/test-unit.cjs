const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const files = readdirSync(join(root, 'tests'))
  .filter((name) => /\.test\.(cjs|mjs)$/.test(name))
  .sort()
  .map((name) => join('tests', name));
if (!files.length) throw new Error('No unit tests found');
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
