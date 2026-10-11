'use strict';
const http = require('node:http');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { RateLimiter } = require('./util');
const { Router, createRequestHandler } = require('./http');
const { createAuth } = require('./auth');
const { Hub } = require('./services/hub');
const { AIService } = require('./services/ai');
const { ImageStore, available: imagesAvailable } = require('./services/images');
const { Game } = require('./services/game');
const { registerRoutes } = require('./routes');

/**
 * Build the whole application. `overrides.ai` lets tests inject a fake AI provider
 * (needs generateHint, compareImages, health).
 */
function createApp(configOverrides = {}, { ai: aiOverride } = {}) {
  const cfg = loadConfig(configOverrides);
  const db = openDb(cfg.dbPath);
  const limiter = new RateLimiter(cfg.rate.disabled);
  const hub = new Hub();
  const store = new ImageStore(cfg.dataDir);
  const ai = aiOverride || new AIService(cfg, { imageStore: store });
  const auth = createAuth({ db, cfg, limiter });
  const game = new Game({ db, cfg, ai, store, hub, rate: limiter });
  const router = new Router();
  registerRoutes({ router, game, auth, cfg, hub, store, ai });
  const handler = createRequestHandler({ cfg, router, authenticate: auth.authenticate, limiter });
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;

  auth.sweep();
  const sweeper = setInterval(() => auth.sweep(), 3600_000);
  sweeper.unref();

  let closed = false;
  return {
    cfg, db, game, hub, store, ai, server, imagesAvailable: imagesAvailable(),
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      hub.closeAll();
      limiter.stop();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      db.close();
    },
  };
}

module.exports = { createApp };
