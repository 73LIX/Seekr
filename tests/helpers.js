'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { AIUnavailable } = require('../server/services/ai');
const images = require('../server/services/images');

let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

// ---------------------------------------------------------------- app lifecycle
async function startApp({ cfg = {}, ai } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-test-'));
  const config = {
    dataDir: dir,
    dbPath: path.join(dir, 'hunt.db'),
    rate: { disabled: true },
    ai: { provider: 'off' },
    ...cfg,
  };
  const app = createApp(config, { ai });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const out = {
    app, base, dir,
    async close() {
      await out.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    /** restart on the same data dir (persistence tests) */
    async restart() {
      await out.app.close();
      const app2 = createApp(config, { ai });
      const a2 = await app2.listen(0, '127.0.0.1');
      out.app = app2;
      out.base = `http://127.0.0.1:${a2.port}`;
      return out;
    },
    client: (token) => client(() => out.base, token),
  };
  return out;
}

// ---------------------------------------------------------------- http client
function client(getBase, token) {
  const c = {
    token,
    async req(method, p, body, { raw, headers = {}, query } = {}) {
      const h = { ...headers };
      if (c.token) h.Authorization = `Bearer ${c.token}`;
      let payload;
      if (raw !== undefined) {
        payload = raw;
        h['Content-Type'] = h['Content-Type'] || 'application/octet-stream';
      } else if (body !== undefined) {
        payload = JSON.stringify(body);
        h['Content-Type'] = 'application/json';
      }
      const qs = query ? '?' + new URLSearchParams(query).toString() : '';
      const res = await fetch(getBase() + p + qs, { method, headers: h, body: payload });
      const ct = res.headers.get('content-type') || '';
      let data;
      if (ct.includes('application/json')) data = await res.json();
      else if (ct.startsWith('text/') || ct.includes('svg')) data = await res.text();
      else data = Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: data, headers: res.headers };
    },
    get: (p, o) => c.req('GET', p, undefined, o),
    post: (p, b, o) => c.req('POST', p, b ?? {}, o),
    patch: (p, b, o) => c.req('PATCH', p, b ?? {}, o),
    del: (p, o) => c.req('DELETE', p, undefined, o),
    postRaw: (p, buf, o = {}) => c.req('POST', p, undefined, { ...o, raw: buf }),
  };
  return c;
}

let counter = 0;
async function register(t, role, name) {
  const username = `${name || role}${++counter}x${Math.random().toString(36).slice(2, 6)}`;
  const anon = client(() => t.base);
  const r = await anon.post('/api/auth/register', { username, password: 'secret123', role, display_name: name || username });
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const c = client(() => t.base, r.body.token);
  c.user = r.body.user;
  c.username = username;
  return c;
}

// ---------------------------------------------------------------- images
const hex = (n) => n.toString(16).padStart(2, '0');
/** deterministic pseudo-random */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}
async function makeImage(seed, { width = 480, height = 360 } = {}) {
  const r = rng(seed * 7919 + 13);
  const bg = `#${hex((r() * 255) | 0)}${hex((r() * 255) | 0)}${hex((r() * 255) | 0)}`;
  let shapes = '';
  for (let i = 0; i < 9; i++) {
    const c = `#${hex((r() * 255) | 0)}${hex((r() * 255) | 0)}${hex((r() * 255) | 0)}`;
    if (r() > 0.5) shapes += `<circle cx="${(r() * width) | 0}" cy="${(r() * height) | 0}" r="${20 + ((r() * 80) | 0)}" fill="${c}"/>`;
    else shapes += `<rect x="${(r() * width) | 0}" y="${(r() * height) | 0}" width="${40 + ((r() * 160) | 0)}" height="${30 + ((r() * 120) | 0)}" fill="${c}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${bg}"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}
/** an image whose perceptual hash is clearly different from `against` */
async function makeDistinctImage(seed, against) {
  const f = await images.features(against);
  for (let s = seed; s < seed + 200; s++) {
    const img = await makeImage(s);
    const g = await images.features(img);
    if (images.hamming(f.dhash, g.dhash) > 6) return img;
  }
  throw new Error('could not build a distinct image');
}
/** same picture re-encoded / slightly brightened: should score high locally but not be a dHash duplicate of the file bytes */
async function makeVariant(buf) {
  return sharp(buf).modulate({ brightness: 1.08 }).resize(520).jpeg({ quality: 70 }).toBuffer();
}

// ---------------------------------------------------------------- scripted AI
class FakeAI {
  constructor() {
    this.hintCalls = [];
    this.compareCalls = [];
    this.hintImpl = async ({ level }) => ({ text: `Think about the clue, level ${level}.`, source: 'ai' });
    this.compareImpl = async () => ({ score: 95, reason: 'looks the same', provider: 'fake' });
    this.delayMs = 0;
    this.active = 0;
    this.maxActive = 0;
  }
  async _track(fn) {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      return await fn();
    } finally {
      this.active--;
    }
  }
  async health() {
    return { provider: 'fake', ok: true, vision: true, detail: 'fake' };
  }
  queueDepth() {
    return this.active;
  }
  generateHint(args) {
    this.hintCalls.push(args);
    return this._track(() => this.hintImpl(args));
  }
  compareImages(args) {
    this.compareCalls.push(args);
    return this._track(() => this.compareImpl(args));
  }
  down() {
    const fail = async () => {
      throw new AIUnavailable('down for test');
    };
    this.hintImpl = fail;
    this.compareImpl = fail;
  }
}

// ---------------------------------------------------------------- scenario builder
const LOC = { lat: 22.5726, lng: 88.3639 };

/**
 * Create an event with N stages. Each spec: { verify_type, answers, geofence_m, ... }.
 * Photo stages automatically get a target image. Returns { event, stages, targets }.
 */
async function buildEvent(org, specs, { name = 'Test Hunt', settings } = {}) {
  const ev = await org.post('/api/events', { name, settings });
  if (ev.status !== 200) throw new Error('create event: ' + JSON.stringify(ev.body));
  const event = ev.body;
  const stages = [];
  const targets = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = {
      title: `Stage ${i + 1}`,
      riddle_text: `Riddle number ${i + 1}: what has keys but opens no doors?`,
      answers: [`answer${i + 1}`],
      lat: LOC.lat + i * 0.001,
      lng: LOC.lng + i * 0.001,
      location_name: `Spot ${i + 1}`,
      verify_type: 'qr',
      ...specs[i],
    };
    const created = await org.post(`/api/events/${event.id}/stages`, spec);
    if (created.status !== 200) throw new Error('add stage: ' + JSON.stringify(created.body));
    let stage = created.body;
    let target = null;
    if (spec.verify_type === 'photo' || spec.verify_type === 'either') {
      target = await makeImage(100 + i);
      const up = await org.postRaw(`/api/stages/${stage.id}/image/target`, target);
      if (up.status !== 200) throw new Error('upload target: ' + JSON.stringify(up.body));
      stage = up.body;
    }
    stages.push(stage);
    targets.push(target);
  }
  return { event, stages, targets };
}

async function joinTeam(t, player, event, teamName) {
  const j = await player.post('/api/join', { code: event.code });
  if (j.status !== 200) throw new Error('join: ' + JSON.stringify(j.body));
  const tm = await player.post(`/api/play/${event.id}/team`, { name: teamName });
  if (tm.status !== 200) throw new Error('team: ' + JSON.stringify(tm.body));
  const st = await player.get(`/api/play/${event.id}/state`);
  return { teamId: tm.body.team_id, code: st.body.team.code };
}

module.exports = {
  startApp, client, register, makeImage, makeDistinctImage, makeVariant, FakeAI, buildEvent, joinTeam, LOC, sharp,
};
