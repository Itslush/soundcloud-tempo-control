const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const DEFAULT_ENTRIES = Object.freeze([
  'rate-clock.mjs',
  'natural-output.mjs',
  'pcm-window.mjs',
  'bounded-source.mjs',
  'buffered-transport.mjs',
  'media-facade.mjs',
  'playback-gate.mjs',
  'source-binding.mjs',
  'preserve-output.mjs',
]);

function bundleAudio({
  directory = path.join(__dirname, '../src/audio'),
  entries = DEFAULT_ENTRIES,
  namespace = 'audioModules',
} = {}) {
  if (!Array.isArray(entries) || !entries.length)
    throw new TypeError('Audio entries are required');
  if (
    typeof namespace !== 'string' ||
    !/^[$A-Z_a-z][$\w]*$/.test(namespace) ||
    ['Object', 'await'].includes(namespace)
  )
    throw new TypeError('Invalid audio namespace');
  new vm.Script(`"use strict"; const ${namespace} = 0;`);
  const root = fs.realpathSync(directory);
  const inside = (file) => {
    const relative = path.relative(root, fs.realpathSync(file));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error(`Audio module escapes source root: ${file}`);
  };
  const imports = [...new Set(entries)].sort().map((entry) => {
    if (
      typeof entry !== 'string' ||
      !entry.endsWith('.mjs') ||
      /[\\?#\u0000]/.test(entry) ||
      path.isAbsolute(entry)
    )
      throw new TypeError('Invalid audio entry');
    inside(path.resolve(root, entry));
    return `export * from ${JSON.stringify(`./${entry}`)};`;
  });
  const result = esbuild.buildSync({
    absWorkingDir: root,
    stdin: {
      contents: imports.join('\n'),
      resolveDir: root,
      sourcefile: 'audio-entry.mjs',
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    globalName: namespace,
    platform: 'browser',
    target: 'es2022',
    treeShaking: true,
    legalComments: 'none',
    banner: { js: '"use strict";' },
    footer: { js: `Object.freeze(${namespace});` },
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  if (result.warnings.length)
    throw new Error(result.warnings.map(({ text }) => text).join('\n'));
  for (const input of Object.keys(result.metafile.inputs))
    if (input !== 'audio-entry.mjs') inside(path.resolve(root, input));
  return result.outputFiles[0].text;
}

module.exports = { bundleAudio, DEFAULT_ENTRIES };
