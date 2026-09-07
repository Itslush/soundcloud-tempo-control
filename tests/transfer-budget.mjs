import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { parsers } from 'prettier/plugins/babel';
import { createApp } from '../server/app.mjs';
import config from '../scripts/config.cjs';

const budgets = {
  html: 24 * 1024,
  javascript: 48 * 1024,
  css: 16 * 1024,
  fonts: 112 * 1024,
  initial: 192 * 1024,
  initialWithAllPreviewCrops: 384 * 1024,
  resources: 32,
};

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
      (match) => [match[1].toLowerCase(), match[2] ?? match[3]],
    ),
  );
}

function transfer(url, encoding, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { headers: { 'Accept-Encoding': encoding, ...headers } },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024)
            return request.destroy(
              new Error(`Transfer exceeds measurement cap: ${url.pathname}`),
            );
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function decoded(result) {
  if (result.headers['content-encoding'] === 'br')
    return brotliDecompressSync(result.body);
  if (result.headers['content-encoding'] === 'gzip')
    return gunzipSync(result.body);
  return result.body;
}

async function measure(origin, basePath, encoding) {
  const home = new URL(basePath, origin);
  const queue = new Map();
  const rows = [];
  function add(value, kind, initial, parent = home) {
    if (!value || value.startsWith('data:') || value.startsWith('#')) return;
    const url = new URL(value, parent);
    assert.equal(
      url.origin,
      home.origin,
      `External startup dependency is outside this local budget: ${url.href}`,
    );
    assert(
      url.pathname.startsWith(basePath),
      `Asset escapes deployment prefix: ${url.pathname}`,
    );
    const previous = queue.get(url.href);
    if (previous) {
      previous.initial ||= initial;
      return;
    }
    assert(queue.size < 128, 'Resource discovery exceeds 128 assets');
    queue.set(url.href, { url, kind, initial });
  }
  add(home.href, 'html', true);
  for (const resource of queue.values()) {
    const result = await transfer(resource.url, encoding);
    assert.equal(result.status, 200, resource.url.pathname);
    const content = decoded(result);
    assert(result.headers.etag, `ETag missing: ${resource.url.pathname}`);
    assert.equal(result.headers.vary, 'Accept-Encoding', resource.url.pathname);
    if (['html', 'javascript', 'css', 'svg'].includes(resource.kind))
      assert.equal(
        result.headers['content-encoding'],
        encoding,
        `Compression missing: ${resource.url.pathname}`,
      );
    rows.push({
      resource,
      encodedBytes: result.body.length,
      sourceBytes: content.length,
    });
    const unchanged = await transfer(resource.url, encoding, {
      'If-None-Match': result.headers.etag,
    });
    assert.equal(unchanged.status, 304, resource.url.pathname);
    assert.equal(unchanged.body.length, 0, resource.url.pathname);
    if (resource.kind === 'html') {
      const html = content.toString();
      for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
        const attrs = attributes(tag);
        if (attrs.src) add(attrs.src, 'javascript', true, resource.url);
      }
      for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
        const attrs = attributes(tag);
        if (attrs.rel === 'stylesheet')
          add(attrs.href, 'css', true, resource.url);
        if (attrs.rel === 'modulepreload')
          add(attrs.href, 'javascript', true, resource.url);
        if (attrs.rel === 'preload')
          add(
            attrs.href,
            attrs.as === 'font'
              ? 'fonts'
              : attrs.as === 'script'
                ? 'javascript'
                : attrs.as === 'style'
                  ? 'css'
                  : 'images',
            true,
            resource.url,
          );
        if (attrs.rel === 'icon')
          add(
            attrs.href,
            attrs.type === 'image/svg+xml' ? 'svg' : 'images',
            true,
            resource.url,
          );
      }
      for (const [picture] of html.matchAll(
        /<picture\b[^>]*>[\s\S]*?<\/picture>/gi,
      )) {
        const img = attributes(picture.match(/<img\b[^>]*>/i)?.[0] || '');
        for (const [tag] of picture.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
          const attrs = attributes(tag);
          for (const value of (attrs.srcset || '').split(','))
            add(
              value.trim().split(/\s+/)[0],
              'images',
              img.loading !== 'lazy',
              resource.url,
            );
        }
      }
      for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
        const attrs = attributes(tag);
        add(attrs.src, 'images', attrs.loading !== 'lazy', resource.url);
      }
    }
    if (resource.kind === 'css') {
      for (const [, value] of content
        .toString()
        .matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
        const kind = /\.woff2?(?:[?#]|$)/i.test(value) ? 'fonts' : 'images';
        add(value, kind, resource.initial, resource.url);
      }
    }
    if (resource.kind === 'javascript') {
      const source = parsers.babel.parse(content.toString());
      for (const statement of source.program.body) {
        if (
          [
            'ImportDeclaration',
            'ExportNamedDeclaration',
            'ExportAllDeclaration',
          ].includes(statement.type) &&
          typeof statement.source?.value === 'string'
        )
          add(
            statement.source.value,
            'javascript',
            resource.initial,
            resource.url,
          );
      }
    }
  }
  const sum = (predicate) =>
    rows
      .filter(({ resource }) => predicate(resource))
      .reduce((total, row) => total + row.encodedBytes, 0);
  const totals = {
    html: sum((resource) => resource.kind === 'html'),
    javascript: sum((resource) => resource.kind === 'javascript'),
    css: sum((resource) => resource.kind === 'css'),
    fonts: sum((resource) => resource.kind === 'fonts'),
    initial: sum((resource) => resource.initial),
    initialWithAllPreviewCrops: sum(() => true),
    resources: rows.length,
  };
  for (const [name, limit] of Object.entries(budgets))
    assert(
      totals[name] <= limit,
      `${encoding} ${name}: ${totals[name]} exceeds ${limit}`,
    );
  return {
    encoding,
    totals,
    resources: rows.map(({ resource, ...sizes }) => ({
      path: resource.url.pathname,
      kind: resource.kind,
      initial: resource.initial,
      ...sizes,
    })),
  };
}

const { siteUrl } = config.readConfig();
const basePath = siteUrl ? new URL(siteUrl).pathname : '/';
const server = createApp({
  basePath,
  siteRoot: process.env.TEMPO_TEST_SITE_ROOT || fileURLToPath(new URL('../dist/site/', import.meta.url)),
  service: {
    configured: false,
    resolve: async () => {
      throw new Error('Budget checks must not resolve external audio');
    },
  },
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const measurements = [];
  for (const encoding of ['br', 'gzip'])
    measurements.push(await measure(origin, basePath, encoding));
  console.log(
    JSON.stringify(
      {
        scope:
          'Local HTTP response body bytes. Includes all CSS font subsets and, separately, every responsive preview crop. Excludes headers, TLS, resolver responses, playback audio, dynamic imports and full screenshot originals opened on demand. Every measured resource also passed ETag/304 revalidation.',
        budgets,
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
