'use strict';
const path = require('node:path');

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

function merge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      merge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

function loadConfig(overrides = {}) {
  const env = process.env;
  const root = path.resolve(__dirname, '..');
  const dataDir = path.resolve(overrides.dataDir || env.DATA_DIR || path.join(root, 'data'));
  const cfg = {
    root,
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, 'hunt.db'),
    publicDir: path.join(root, 'public'),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    trustProxy: bool(env.TRUST_PROXY, false),
    // when set, creating an organizer account requires this invite code
    organizerSignupCode: env.ORGANIZER_SIGNUP_CODE || '',
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 24 * 14),
    tileUrl: env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: env.TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors',
    ai: {
      provider: (env.AI_PROVIDER || 'ollama').toLowerCase(), // ollama | local | off
      ollamaUrl: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      model: env.OLLAMA_MODEL || 'gemma4:e2b',
      // gemma4 can "think" before answering; that is slow and unnecessary for short JSON replies
      think: bool(env.AI_THINK, false),
      timeoutMs: int(env.AI_TIMEOUT_MS, 90000),
      concurrency: Math.max(1, int(env.AI_CONCURRENCY, 1)),
      maxQueue: Math.max(0, int(env.AI_MAX_QUEUE, 30)),
    },
    game: {
      maxHints: 3,
      teamMax: 4,
      defaultThreshold: 85,
      defaultReviewMin: 60,
      // A submitted photo this close (hamming distance of 64-bit dHash) to the clue image
      // is treated as a screenshot/copy of the clue rather than a fresh photo.
      copyDistance: 2,
    },
    limits: {
      jsonBytes: 64 * 1024,
      imageBytes: 8 * 1024 * 1024,
      maxStagesPerEvent: 50,
      maxEventsPerOrganizer: 100,
      maxTeamsPerEvent: 200,
    },
    rate: {
      disabled: false,
      authMax: 30,
      authWindowMs: 60_000,
      answerMax: 6,
      answerWindowMs: 30_000,
      scanFailMax: 20,
      scanWindowMs: 300_000,
      photoCooldownMs: 3000,
      hintCooldownMs: 1000,
    },
  };
  return merge(cfg, overrides);
}

module.exports = { loadConfig };
