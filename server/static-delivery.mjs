import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
const textExtensions = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.txt',
]);
const chunkSize = 64 * 1024;

function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function qualities(header) {
  const result = new Map();
  for (const entry of String(header || '').split(',')) {
    const parts = entry.trim().toLowerCase().split(';');
    const name = parts.shift().trim();
    if (!['br', 'gzip', 'identity', '*'].includes(name)) continue;
    let quality = 1;
    if (parts.length) {
      const match =
        parts.length === 1 &&
        /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parts[0]);
      quality = match ? Number(match[1]) : 0;
    }
    result.set(name, Math.min(result.get(name) ?? 1, quality));
  }
  return result;
}

export function negotiateEncoding(header, canCompress = true) {
  const accepted = qualities(header);
  const identity =
    accepted.get('identity') ?? (accepted.get('*') === 0 ? 0 : 1);
  const choices = canCompress
    ? ['br', 'gzip'].map((name) => ({
        name,
        quality: accepted.get(name) ?? accepted.get('*') ?? 0,
      }))
    : [];
  if (accepted.has('identity'))
    choices.push({ name: 'identity', quality: identity });
  choices.sort((a, b) => b.quality - a.quality);
  return (
    choices.find((choice) => choice.quality > 0)?.name ||
    (identity > 0 ? 'identity' : null)
  );
}

export function matchesEtag(header, etag) {
  const value = String(header).trim();
  if (value === '*') return true;
  const tag = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
  if (!new RegExp(`^${tag}(?:[ \\t]*,[ \\t]*${tag})*$`).test(value))
    return false;
  const expected = etag.replace(/^W\//, '');
  return [...value.matchAll(new RegExp(tag, 'g'))].some(
    ([candidate]) => candidate.replace(/^W\//, '') === expected,
  );
}

export function wantsHtml(request, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const accept = String(request.headers.accept || '').toLowerCase();
  if (
    accept.split(',').some((item) => {
      const [type, ...parameters] = item.trim().split(';');
      if (!['text/html', 'application/xhtml+xml'].includes(type.trim()))
        return false;
      const quality = parameters.find((parameter) =>
        parameter.trim().startsWith('q='),
      );
      return !quality || Number(quality.trim().slice(2)) > 0;
    })
  )
    return true;
  if (accept && accept.trim() !== '*/*') return false;
  return (
    request.headers['sec-fetch-mode'] === 'navigate' ||
    request.headers['sec-fetch-dest'] === 'document' ||
    path.posix.extname(pathname) === ''
  );
}

export function createStaticDelivery(
  siteRoot,
  { maxCompressedStreams = 4, maxCompressibleBytes = 8 * 1024 * 1024 } = {},
) {
  if (
    !Number.isInteger(maxCompressedStreams) ||
    maxCompressedStreams < 0 ||
    maxCompressedStreams > 16
  )
    throw new Error('maxCompressedStreams must be between 0 and 16');
  if (
    !Number.isSafeInteger(maxCompressibleBytes) ||
    maxCompressibleBytes < 0 ||
    maxCompressibleBytes > 32 * 1024 * 1024
  )
    throw new Error('maxCompressibleBytes must be between 0 and 33554432');
  const root = path.resolve(siteRoot);
  let compressedStreams = 0;
  return async function deliver(request, response, pathname, status = 200) {
    if (
      pathname.includes('\0') ||
      pathname.includes('\\') ||
      pathname.split('/').some((part) => part.startsWith('.'))
    )
      return false;
    let file = path.resolve(root, '.' + pathname);
    if (!inside(root, file)) return false;
    let info;
    try {
      const actualRoot = await realpath(root);
      file = await realpath(file);
      if (!inside(actualRoot, file)) return false;
      info = await stat(file, { bigint: true });
      if (info.isDirectory()) {
        file = await realpath(path.join(file, 'index.html'));
        if (!inside(actualRoot, file)) return false;
        info = await stat(file, { bigint: true });
      }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
      throw error;
    }
    if (!info.isFile()) return false;
    const extension = path.extname(file).toLowerCase();
    const compressible =
      textExtensions.has(extension) &&
      info.size > 0n &&
      info.size <= BigInt(maxCompressibleBytes);
    let encoding = negotiateEncoding(
      request.headers['accept-encoding'],
      compressible,
    );
    const capacity = compressedStreams < maxCompressedStreams;
    if (encoding && encoding !== 'identity' && !capacity) {
      encoding = negotiateEncoding(request.headers['accept-encoding'], false);
      if (!encoding) {
        response.writeHead(503, {
          'Cache-Control': 'no-store',
          Vary: 'Accept-Encoding',
          'Retry-After': '1',
          'Content-Length': '0',
        });
        response.end();
        return true;
      }
    }
    if (!encoding) {
      response.writeHead(406, {
        'Cache-Control': 'no-store',
        Vary: 'Accept-Encoding',
        'Content-Length': '0',
      });
      response.end();
      return true;
    }
    const etag = `W/"${info.size.toString(16)}-${info.mtimeNs.toString(16)}-${info.ctimeNs.toString(16)}-${encoding}"`;
    const headers = {
      'Content-Type': types[extension] || 'application/octet-stream',
      'Cache-Control':
        status === 200
          ? pathname.startsWith('/_astro/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache'
          : 'no-store',
      Vary: 'Accept-Encoding',
    };
    if (status === 200) {
      headers.ETag = etag;
      headers['Last-Modified'] = new Date(Number(info.mtimeMs)).toUTCString();
    }
    if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
    const since = Date.parse(request.headers['if-modified-since'] || '');
    const fresh =
      request.headers['if-none-match'] !== undefined
        ? matchesEtag(request.headers['if-none-match'], etag)
        : Number.isFinite(since) &&
          Math.floor(Number(info.mtimeMs) / 1000) <= Math.floor(since / 1000);
    if (status === 200 && fresh) {
      response.writeHead(304, headers);
      response.end();
      return true;
    }
    if (encoding === 'identity')
      headers['Content-Length'] = info.size.toString();
    response.writeHead(status, headers);
    if (request.method === 'HEAD') {
      response.end();
      return true;
    }
    const source = createReadStream(file, { highWaterMark: chunkSize });
    if (encoding === 'identity') {
      await pipeline(source, response);
      return true;
    }
    compressedStreams++;
    try {
      const compressor =
        encoding === 'br'
          ? createBrotliCompress({
              chunkSize,
              params: {
                [constants.BROTLI_PARAM_QUALITY]: 4,
                [constants.BROTLI_PARAM_LGWIN]: 20,
              },
            })
          : createGzip({ chunkSize, level: 6, memLevel: 7 });
      await pipeline(source, compressor, response);
    } finally {
      compressedStreams--;
    }
    return true;
  };
}
