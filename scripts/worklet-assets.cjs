const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');

async function buildPreserveWorklet() {
  const lock = require('../vendor/signalsmith/wasm-factory.json');
  for (const [file, hash] of [
    [lock.file, lock.sha256],
    [lock.upstreamFile, lock.upstreamSha256],
  ]) {
    const bytes = fs.readFileSync(path.join(root, 'vendor/signalsmith', file));
    if (createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new Error(`Signalsmith asset checksum mismatch: ${file}`);
  }
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/audio/preserve-entry.mjs'],
    outfile: 'preserve-worklet.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    treeShaking: true,
    minifyWhitespace: true,
    legalComments: 'none',
    sourcemap: 'external',
    sourcesContent: true,
    write: false,
    logLevel: 'silent',
  });
  if (result.warnings.length)
    throw new Error(result.warnings.map(({ text }) => text).join('\n'));
  return {
    output: result.outputFiles.find(({ path }) => path.endsWith('.js')).text,
    sourceMap: result.outputFiles.find(({ path }) => path.endsWith('.map'))
      .text,
  };
}

function workletAssets(onBuild = () => {}) {
  return {
    name: 'audio-worklet-assets',
    setup(build) {
      build.onResolve({ filter: /^tempo:preserve-worklet$/ }, () => ({
        path: 'preserve-worklet',
        namespace: 'audio-worklet',
      }));
      build.onLoad({ filter: /.*/, namespace: 'audio-worklet' }, async () => {
        const artifact = await buildPreserveWorklet();
        onBuild(artifact);
        return { contents: artifact.output, loader: 'text' };
      });
    },
  };
}

function writeWorkletArtifact(directory, artifact) {
  const sha256 = createHash('sha256').update(artifact.output).digest('hex');
  const mapHash = createHash('sha256').update(artifact.sourceMap).digest('hex');
  const file = path.join(directory, `preserve-worklet-${sha256}.js`);
  const sourceMap = `${file}.${mapHash}.map`;
  fs.mkdirSync(directory, { recursive: true });
  for (const [target, content] of [
    [file, artifact.output],
    [sourceMap, artifact.sourceMap],
  ]) {
    try {
      fs.writeFileSync(target, content, { flag: 'wx' });
    } catch (error) {
      if (
        error.code !== 'EEXIST' ||
        fs.readFileSync(target, 'utf8') !== content
      )
        throw error;
    }
  }
  return { path: file, sha256, sourceMap };
}

module.exports = { buildPreserveWorklet, workletAssets, writeWorkletArtifact };

if (require.main === module)
  buildPreserveWorklet()
    .then((artifact) => {
      console.log(
        JSON.stringify(
          writeWorkletArtifact(path.join(root, 'test-results'), artifact),
        ),
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
