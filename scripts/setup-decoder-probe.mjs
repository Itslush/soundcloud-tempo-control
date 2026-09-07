import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '1.55.7';
const directory = new URL(
  `../test-results/decoder-assets/mediabunny-${version}/package/`,
  import.meta.url,
);
const assets = [
  {
    path: 'dist/bundles/mediabunny.cjs',
    sha256: '194c80aaff75b420184c1b82f932863b1318d47bb51fc07754658608707f82fb',
    maximum: 2 * 1024 * 1024,
  },
  {
    path: 'LICENSE',
    sha256: '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
    maximum: 32768,
  },
];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(asset) {
  const target = new URL(asset.path, directory);
  const existing = await readFile(target).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && digest(existing) === asset.sha256) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let reader;
  try {
    const response = await fetch(
      `https://cdn.jsdelivr.net/npm/mediabunny@${version}/${asset.path}`,
      {
        signal: controller.signal,
        redirect: 'error',
      },
    );
    if (!response.ok || !response.body)
      throw new Error(`Decoder asset request failed: ${response.status}`);
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.maximum)
        throw new Error('Decoder asset exceeds its size limit');
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    if (digest(bytes) !== asset.sha256)
      throw new Error(`Decoder checksum mismatch: ${asset.path}`);
    await mkdir(dirname(fileURLToPath(target)), { recursive: true });
    await writeFile(target, bytes);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

for (const asset of assets) await download(asset);
console.log(
  `Mediabunny ${version} diagnostic assets verified. Not included in production builds.`,
);
