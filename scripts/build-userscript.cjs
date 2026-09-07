const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const { workletAssets, writeWorkletArtifact } = require('./worklet-assets.cjs');
const { root, readConfig, validateConfig } = require('./config.cjs');

function userscriptMetadata(config, version) {
  const entries = [
    ['name', 'SoundCloud Tempo Control (Natural Pitch)'],
    ['namespace', 'soundcloud-tempo-control'],
    ['version', version],
    [
      'description',
      'Playback speed, optional key preservation, saved tempos and shareable timelines.',
    ],
    ['license', 'MIT'],
    ['match', 'https://soundcloud.com/*'],
    ['match', 'https://m.soundcloud.com/*'],
    ['run-at', 'document-start'],
    ['grant', 'none'],
    ['inject-into', 'page'],
    ['noframes', ''],
  ];
  if (config.siteUrl)
    entries.push(
      ['homepageURL', config.siteUrl],
      [
        'supportURL',
        config.repositoryUrl || new URL('guide/', config.siteUrl).href,
      ],
      [
        'downloadURL',
        new URL('downloads/soundcloud-tempo-control.user.js', config.siteUrl)
          .href,
      ],
      [
        'updateURL',
        new URL('downloads/soundcloud-tempo-control.meta.js', config.siteUrl)
          .href,
      ],
    );
  return [
    '// ==UserScript==',
    ...entries.map(([key, value]) =>
      `// @${key.padEnd(13)} ${value}`.trimEnd(),
    ),
    '// ==/UserScript==',
    '',
  ].join('\n');
}

function verifySignalsmith() {
  const lock = require('../vendor/signalsmith/signalsmith.json');
  const vendor = fs.readFileSync(
    path.join(root, 'vendor/signalsmith', lock.file),
  );
  if (createHash('sha256').update(vendor).digest('hex') !== lock.sha256)
    throw new Error('Signalsmith checksum mismatch');
}

async function buildScript(
  config = readConfig(),
  version = require('../package.json').version,
  { inject = [] } = {},
) {
  config = validateConfig(config);
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Use a numeric major.minor.patch release version');
  verifySignalsmith();
  const metadata = userscriptMetadata(config, version);
  let worklet;
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/tempo-inline-source.js'],
    inject,
    plugins: [
      workletAssets((artifact) => {
        worklet = artifact;
      }),
    ],
    outfile: 'soundcloud-tempo-control.user.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    treeShaking: true,
    minifyWhitespace: true,
    lineLimit: 100,
    legalComments: 'none',
    banner: { js: metadata.trimEnd() },
    define: {
      __TEMPO_VERSION__: JSON.stringify(version),
      __TEMPO_WEBSITE__: JSON.stringify(config.siteUrl),
    },
    sourcemap: 'external',
    sourcesContent: true,
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  if (result.warnings.length)
    throw new Error(result.warnings.map(({ text }) => text).join('\n'));
  const output = result.outputFiles.find(({ path }) =>
    path.endsWith('.user.js'),
  ).text;
  const sourceMap = result.outputFiles.find(({ path }) =>
    path.endsWith('.map'),
  ).text;
  return {
    output,
    sourceMap,
    worklet,
    metadata,
    version,
    updatesConfigured: Boolean(config.siteUrl),
  };
}

async function main() {
  const config = readConfig(process.argv.includes('--release'));
  const build = await buildScript(config);
  const sha256 = createHash('sha256').update(build.output).digest('hex');
  const manifest = {
    version: build.version,
    sha256,
    bytes: Buffer.byteLength(build.output),
    updatesConfigured: build.updatesConfigured,
  };
  for (const directory of ['dist', 'site/public/downloads']) {
    const destination = path.join(root, directory);
    fs.mkdirSync(destination, { recursive: true });
    writeWorkletArtifact(destination, build.worklet);
    fs.writeFileSync(
      path.join(destination, 'soundcloud-tempo-control.user.js'),
      build.output,
    );
    fs.writeFileSync(
      path.join(destination, 'soundcloud-tempo-control.meta.js'),
      build.metadata,
    );
    fs.writeFileSync(
      path.join(destination, 'soundcloud-tempo-control.user.js.map'),
      build.sourceMap,
    );
    fs.writeFileSync(
      path.join(destination, 'release.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(destination, 'SHA256SUMS.txt'),
      `${sha256}  soundcloud-tempo-control.user.js\n`,
    );
  }
  const audioDirectory = path.join(root, 'site/public/audio');
  const licenseDirectory = path.join(root, 'site/public/licenses');
  fs.mkdirSync(licenseDirectory, { recursive: true });
  for (const [name, source] of Object.entries({
    'Signalsmith.txt': 'vendor/signalsmith/LICENSE.txt',
    'Mediabunny.txt': 'vendor/mediabunny/LICENSE',
    'Mediabunny-notice.txt': 'vendor/mediabunny/NOTICE.md',
    'HLS.js.txt': 'node_modules/hls.js/LICENSE',
    'Mulish.txt': 'node_modules/@fontsource-variable/mulish/LICENSE',
  }))
    fs.copyFileSync(path.join(root, source), path.join(licenseDirectory, name));
  fs.mkdirSync(audioDirectory, { recursive: true });
  const engine = await buildWebsiteEngine();
  fs.writeFileSync(path.join(audioDirectory, 'engine.js'), engine.output);
  fs.writeFileSync(
    path.join(audioDirectory, 'engine.js.map'),
    engine.sourceMap,
  );
  console.log(
    `Built v${build.version} (${manifest.bytes} bytes). ${build.updatesConfigured ? 'Public update URLs configured.' : 'Local build: public updates are not configured.'}`,
  );
}

async function buildWebsiteEngine() {
  verifySignalsmith();
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/tempo-dependency.js'],
    outfile: 'engine.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    treeShaking: true,
    minifyWhitespace: true,
    lineLimit: 100,
    legalComments: 'none',
    sourcemap: 'external',
    sourcesContent: true,
    write: false,
    logLevel: 'silent',
  });
  if (result.warnings.length)
    throw new Error(result.warnings.map(({ text }) => text).join('\n'));
  return {
    output: result.outputFiles.find(
      ({ path }) => path.endsWith('/engine.js') || path.endsWith('\\engine.js'),
    ).text,
    sourceMap: result.outputFiles.find(({ path }) => path.endsWith('.map'))
      .text,
  };
}

module.exports = { buildScript, buildWebsiteEngine };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
