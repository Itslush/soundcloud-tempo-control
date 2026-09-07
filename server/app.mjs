import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isIP } from 'node:net';
import { createSoundCloud, ServiceError } from './soundcloud.mjs';
import { createStaticDelivery, wantsHtml } from './static-delivery.mjs';
import config from '../scripts/config.cjs';

const root = fileURLToPath(new URL('../dist/site/', import.meta.url));
const { siteUrl } = config.readConfig();
function send(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(response.req.method === 'HEAD' ? undefined : body);
}

export function createApp({
  service = createSoundCloud(),
  origin = process.env.PUBLIC_ORIGIN ||
    (siteUrl && new URL(siteUrl).origin) ||
    'http://127.0.0.1:4322',
  basePath = siteUrl ? new URL(siteUrl).pathname : '/',
  siteRoot = root,
  staticOptions,
  trustLoopbackProxy = process.env.TRUST_LOOPBACK_PROXY === '1',
} = {}) {
  const prefix = '/' + basePath.split('/').filter(Boolean).join('/');
  const base = prefix === '/' ? '/' : prefix + '/';
  const allowedOrigin = new URL(origin).origin;
  const limits = new Map();
  let active = 0;
  const deliver = createStaticDelivery(siteRoot, staticOptions);
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(request.url, origin);
      if (base !== '/' && url.pathname === prefix) {
        response.writeHead(308, { Location: base + url.search });
        return response.end();
      }
      if (!url.pathname.startsWith(base))
        return send(response, 404, { error: 'Not found.' });
      url.pathname = '/' + url.pathname.slice(base.length);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          return send(response, 405, { error: 'Method not allowed.' });
        }
        if (request.headers.origin && request.headers.origin !== allowedOrigin)
          throw new ServiceError(403, 'Request origin is not allowed.');
        response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        response.setHeader('Vary', 'Origin');
        if (pathname === '/api/status')
          return send(response, 200, { soundcloud: service.configured });
        if (pathname !== '/api/resolve')
          return send(response, 404, { error: 'Not found.' });
        const now = Date.now();
        for (const [key, entry] of limits)
          if (entry.until <= now) limits.delete(key);
        const peer = request.socket.remoteAddress;
        const forwarded = request.headers['x-real-ip'];
        const ip =
          trustLoopbackProxy &&
          ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) &&
          typeof forwarded === 'string' &&
          isIP(forwarded)
            ? forwarded
            : peer;
        if (!limits.has(ip) && limits.size >= 2048)
          throw new ServiceError(503, 'Preview is busy. Try again shortly.');
        const entry = limits.get(ip) || { count: 0, until: now + 60000 };
        limits.set(ip, entry);
        if (++entry.count > 20 || active >= 8) {
          response.setHeader('Retry-After', '60');
          throw new ServiceError(429, 'Too many requests. Try again shortly.');
        }
        active++;
        const controller = new AbortController();
        const disconnect = () => controller.abort();
        response.once('close', disconnect);
        try {
          return send(
            response,
            200,
            await service.resolve(
              url.searchParams.get('url') || '',
              controller.signal,
            ),
          );
        } finally {
          response.removeListener('close', disconnect);
          active--;
        }
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        return send(response, 405, { error: 'Method not allowed.' });
      }
      if (await deliver(request, response, pathname)) return;
      if (
        wantsHtml(request, pathname) &&
        (await deliver(request, response, '/404.html', 404))
      )
        return;
      return send(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (response.headersSent || response.destroyed) return response.destroy();
      const status =
        error instanceof ServiceError
          ? error.status
          : error instanceof URIError
            ? 400
            : ['ENOENT', 'ENOTDIR'].includes(error.code)
              ? 404
              : 502;
      send(response, status, {
        error:
          error instanceof ServiceError
            ? error.message
            : status === 400
              ? 'Invalid request path.'
              : status === 404
                ? 'Not found.'
                : 'Preview could not be loaded. Try again.',
      });
    }
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 4322);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535');
  const server = createApp();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(port, process.env.HOST || '127.0.0.1', () =>
    console.log(`Preview: http://127.0.0.1:${port}`),
  );
  server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => server.close());
}
