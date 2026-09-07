const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildScript } = require('../scripts/build-userscript.cjs');
const { writeWorkletArtifact } = require('../scripts/worklet-assets.cjs');

async function main() {
  const build = await buildScript();
  const sha256 = createHash('sha256').update(build.output).digest('hex');
  const directory = path.resolve(__dirname, '../test-results');
  const destination = path.join(directory, `playback-${sha256}.user.js`);
  const mapHash = createHash('sha256').update(build.sourceMap).digest('hex');
  const sourceMap = `${destination}.${mapHash}.map`;
  fs.mkdirSync(directory, { recursive: true });
  const worklet = writeWorkletArtifact(directory, build.worklet);
  for (const [file, content] of [
    [destination, build.output],
    [sourceMap, build.sourceMap],
  ]) {
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== content)
        throw error;
    }
  }
  console.log(
    JSON.stringify(
      {
        path: destination,
        sha256,
        bytes: Buffer.byteLength(build.output),
        sourceMap,
        worklet,
        published: false,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
