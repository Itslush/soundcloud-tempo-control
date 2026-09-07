import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import esbuild from 'esbuild';
import assets from '../scripts/worklet-assets.cjs';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'test-results');
const factory = resolve(process.argv[2] || '');
const location = relative(directory, factory);
if (!process.argv[2] || location.startsWith('..') || isAbsolute(location))
  throw new Error('A diagnostic factory inside test-results is required');
const bytes = await readFile(factory);
const result = await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: `import Module from ${JSON.stringify(factory)}; import {registerPreserveProcessor} from './src/audio/preserve-worklet.mjs'; registerPreserveProcessor(Module, 'soundcloud-preserve-buffered-v1');`,
    resolveDir: root,
    sourcefile: 'diagnostic-preserve-entry.mjs',
    loader: 'js',
  },
  outfile: 'preserve-worklet.js', bundle:true, format:'esm', platform:'browser',
  target:'es2022', treeShaking:true, minifyWhitespace:true, legalComments:'none',
  sourcemap:'external', sourcesContent:true, write:false, logLevel:'silent',
});
if (result.warnings.length) throw new Error(JSON.stringify(result.warnings));
const artifact = assets.writeWorkletArtifact(directory, {
  output: result.outputFiles.find(file => file.path.endsWith('.js')).text,
  sourceMap: result.outputFiles.find(file => file.path.endsWith('.map')).text,
});
console.log(JSON.stringify({...artifact, factory, factorySha256:createHash('sha256').update(bytes).digest('hex')}));
