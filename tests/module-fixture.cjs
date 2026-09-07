const path = require('node:path');
const { buildSync } = require('esbuild');

module.exports = function moduleFixture(files) {
  const root = path.resolve(__dirname, '../src');
  return buildSync({
    absWorkingDir: root,
    stdin: {
      contents: files
        .map((file) => `export * from ${JSON.stringify(`./${file}`)};`)
        .join('\n'),
      resolveDir: root,
      sourcefile: 'fixture-entry.mjs',
    },
    bundle: true,
    format: 'iife',
    globalName: 'fixtureModule',
    platform: 'browser',
    target: 'es2022',
    write: false,
    footer: { js: 'Object.assign(globalThis, fixtureModule);' },
  }).outputFiles[0].text;
};
