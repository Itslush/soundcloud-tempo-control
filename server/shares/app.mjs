import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createShareStore } from './store.mjs';
import { ServiceError } from '../errors.mjs';
import config from '../../scripts/config.cjs';

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const base = '/soundcloud-tempo-control/';
export function embedHtml({ id, data, publicOrigin, siteUrl }) {
  const media = `${publicOrigin}${base}media/${id}`;
  const website = new URL('share/', siteUrl);
  website.hash = 'sct=' + data.code;
  const title = escape(data.title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta property="og:type" content="video.other"><meta property="og:title" content="${title}">
<meta property="og:description" content="${escape(data.artist)} · Shared tempo and pitch">
<meta property="og:url" content="${publicOrigin}${base}listen/${id}">
<meta property="og:image" content="${media}.jpg">
<meta property="og:video" content="${media}.mp4"><meta property="og:video:secure_url" content="${media}.mp4">
<meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="640"><meta property="og:video:height" content="640">
<meta name="twitter:card" content="player"><meta name="twitter:player:stream" content="${media}.mp4"><meta name="twitter:player:stream:content_type" content="video/mp4">
</head><body><a href="${escape(website.href)}">Open shared track</a><script>location.replace(${JSON.stringify(website.href).replaceAll('<', '\\u003c')})</script></body></html>`;
}

function send(response, status, body, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body) : body;
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(response.req.method === 'HEAD' ? undefined : text);
}

export function createSharesApp({
  store,
  publicOrigin,
  siteUrl = config.readConfig().siteUrl,
  trustProxy = false,
}) {
  const allowedOrigin = new URL(siteUrl).origin;
  const limits = new Map();
  const app = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Vary', 'Origin');
    try {
      const url = new URL(request.url, publicOrigin);
      const route = url.pathname;
      if (request.headers.origin && request.headers.origin !== allowedOrigin)
        throw new ServiceError(403, 'Request origin is not allowed.');
      if (request.method === 'OPTIONS' && route === base + 'api/shares') {
        response.setHeader('Access-Control-Allow-Methods', 'POST, GET');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return send(response, 204, '');
      }
      if (request.method === 'POST' && route === base + 'api/shares') {
        if (
          request.headers.origin !== allowedOrigin ||
          request.headers['content-type'] !== 'application/json'
        )
          throw new ServiceError(
            403,
            'Create links from the shared-track page.',
          );
        const peer = request.socket.remoteAddress;
        const forwarded = request.headers['x-real-ip'];
        const ip =
          trustProxy &&
          ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) &&
          typeof forwarded === 'string' &&
          isIP(forwarded)
            ? forwarded
            : peer;
        const now = Date.now();
        for (const [key, item] of limits)
          if (item.until <= now) limits.delete(key);
        if (!limits.has(ip) && limits.size >= 2048)
          throw new ServiceError(503, 'Sharing is busy. Try again later.');
        const limit = limits.get(ip) || { count: 0, until: now + 3600000 };
        limits.set(ip, limit);
        if (++limit.count > 6) {
          response.setHeader('Retry-After', '3600');
          throw new ServiceError(
            429,
            'Too many render requests. Try again in an hour.',
          );
        }
        let body = '';
        for await (const chunk of request) {
          body += chunk.toString('utf8');
          if (Buffer.byteLength(body) > 20000)
            throw new ServiceError(413, 'Sharing settings are too large.');
        }
        let value;
        try {
          value = JSON.parse(body);
        } catch {
          throw new ServiceError(400, 'Invalid sharing request.');
        }
        if (value?.publish !== true)
          throw new ServiceError(
            400,
            'Confirm that this audio may be published.',
          );
        const data = await store.create(value.code);
        return send(
          response,
          data.state === 'ready' ? 200 : 202,
          publicStatus(data.id, data),
        );
      }
      const match = new RegExp(
        `^${base}(api/shares|listen)/([a-f0-9]{32})/?$`,
      ).exec(route);
      if (match && ['GET', 'HEAD'].includes(request.method)) {
        const data = await store.read(match[2]);
        if (match[1] === 'api/shares')
          return send(response, 200, publicStatus(match[2], data));
        if (data.state !== 'ready')
          throw new ServiceError(409, 'This track is not ready to share.');
        return send(
          response,
          200,
          embedHtml({ id: match[2], data, publicOrigin, siteUrl }),
          'text/html; charset=utf-8',
        );
      }
      throw new ServiceError(404, 'Link not found.');
    } catch (error) {
      if (response.headersSent || response.destroyed) return response.destroy();
      send(response, error instanceof ServiceError ? error.status : 500, {
        error:
          error instanceof ServiceError
            ? error.message
            : 'Sharing is unavailable. Try again later.',
      });
    }
  });
  function publicStatus(id, data) {
    return {
      id,
      state: data.state,
      expires: data.expires,
      ...(data.state === 'ready'
        ? { url: `${publicOrigin}${base}listen/${id}` }
        : {}),
      ...(data.state === 'failed' ? { error: data.error } : {}),
    };
  }
  app.requestTimeout = 15000;
  app.headersTimeout = 10000;
  return app;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const store = await createShareStore(
    process.env.SHARE_ROOT || '/var/lib/tempo-shares',
  );
  const app = createSharesApp({
    store,
    publicOrigin: process.env.SHARE_ORIGIN,
    trustProxy: true,
  });
  app.listen(Number(process.env.PORT || 4324), '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      store.close();
      app.close();
    });
}
