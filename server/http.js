'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./util');
const { AIUnavailable } = require('./services/ai');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const RESPONDED = Symbol('responded');

class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, opts, handler) {
    const keys = [];
    const escaped = pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const source = escaped.replace(/:([a-zA-Z_]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${source}/?$`), keys, opts: opts || {}, handler });
  }
  get(p, o, h) { this.add('GET', p, o, h); }
  post(p, o, h) { this.add('POST', p, o, h); }
  patch(p, o, h) { this.add('PATCH', p, o, h); }
  del(p, o, h) { this.add('DELETE', p, o, h); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          params[k] = m[i + 1];
        }
      });
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res, status, buf, contentType, headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const hardCap = Math.max(limit * 4, 1024 * 1024);
    if (Number.isFinite(declared) && declared > hardCap) {
      reject(new HttpError(413, 'payload_too_large', 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0; // keep draining so the client can read our 413
        if (size > hardCap) req.destroy();
      } else if (!tooBig) {
        chunks.push(c);
      }
    });
    req.on('end', () => (tooBig ? reject(new HttpError(413, 'payload_too_large', 'Request body too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', () => reject(new HttpError(400, 'bad_request', 'Request aborted')));
    req.on('aborted', () => reject(new HttpError(400, 'bad_request', 'Request aborted')));
  });
}

function securityHeaders(cfg) {
  let tileOrigin = '';
  try {
    tileOrigin = new URL(cfg.tileUrl.replace('{s}', 'a').replace('{z}', '0').replace('{x}', '0').replace('{y}', '0')).origin;
  } catch { /* ignore */ }
  const img = ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://unpkg.com', tileOrigin].filter(Boolean).join(' ');
  const csp = [
    "default-src 'self'",
    `img-src ${img}`,
    "script-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
  };
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function serveStatic(cfg, req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(cfg.publicDir, rel));
  if (full !== cfg.publicDir && !full.startsWith(cfg.publicDir + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const body = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function createRequestHandler({ cfg, router, authenticate, limiter }) {
  const baseHeaders = securityHeaders(cfg);
  return async function handle(req, res) {
    for (const [k, v] of Object.entries(baseHeaders)) res.setHeader(k, v);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: { code: 'bad_url', message: 'Bad request URL' } });
    }
    const pathname = url.pathname;
    try {
      const isApi = pathname.startsWith('/api/') || pathname === '/healthz';
      if (!isApi) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(cfg, req, res, pathname)) return;
        return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
      }
      const { route, params, pathMatched } = router.match(req.method === 'HEAD' ? 'GET' : req.method, pathname);
      if (!route) {
        return sendJson(res, pathMatched ? 405 : 404, { error: { code: pathMatched ? 'method_not_allowed' : 'not_found', message: pathMatched ? 'Method not allowed' : 'Not found' } });
      }
      const ip = clientIp(req, cfg.trustProxy);
      const opts = route.opts;
      if (opts.rate) {
        const r = limiter.hit(`${opts.rate.name}:${ip}`, opts.rate.max, opts.rate.windowMs);
        if (!r.ok) throw new HttpError(429, 'rate_limited', 'Too many requests - slow down', { retry_after_ms: r.retryMs });
      }
      let user = null;
      if (opts.auth) {
        user = authenticate(req);
        if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in');
        if (opts.auth !== 'any' && user.role !== opts.auth) {
          throw new HttpError(403, 'wrong_role', `This action is for ${opts.auth}s`);
        }
      }
      let bodyCache;
      const ctx = {
        req, res, url, params, user, ip, cfg,
        query: Object.fromEntries(url.searchParams),
        async raw(limit = cfg.limits.jsonBytes) {
          if (bodyCache === undefined) bodyCache = await readBody(req, limit);
          return bodyCache;
        },
        async json() {
          const buf = await ctx.raw(opts.limit || cfg.limits.jsonBytes);
          if (buf.length === 0) return {};
          let v;
          try {
            v = JSON.parse(buf.toString('utf8'));
          } catch {
            throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
          }
          if (v === null || typeof v !== 'object' || Array.isArray(v)) {
            throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object');
          }
          return v;
        },
        RESPONDED,
      };
      const out = await route.handler(ctx);
      if (out === RESPONDED || res.writableEnded || res.headersSent) return;
      sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      if (err instanceof HttpError) {
        const headers = {};
        if (err.status === 413) {
          headers.Connection = 'close';
          res.on('finish', () => req.destroy());
        }
        if (err.status === 429 && err.extra?.retry_after_ms) headers['Retry-After'] = String(Math.ceil(err.extra.retry_after_ms / 1000));
        return sendJson(res, err.status, { error: { code: err.code, message: err.message, ...(err.extra || {}) } }, headers);
      }
      if (err instanceof AIUnavailable) {
        return sendJson(res, 503, { error: { code: 'ai_unavailable', message: err.message } });
      }
      console.error(`[error] ${req.method} ${pathname}`, err);
      return sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server' } });
    }
  };
}

module.exports = { Router, createRequestHandler, sendJson, sendBuffer, readBody, RESPONDED };
