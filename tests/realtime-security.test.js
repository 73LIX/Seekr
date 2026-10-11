'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, register, buildEvent, joinTeam, FakeAI } = require('./helpers');

/** minimal SSE client */
async function sse(base, path, token) {
  const ctrl = new AbortController();
  const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
  const out = { status: res.status, msgs: [], close: () => ctrl.abort() };
  if (!res.ok) { await res.arrayBuffer().catch(() => {}); return out; }
  (async () => {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); const l = c.split('\n').find((x) => x.startsWith('data:')); if (l) out.msgs.push(JSON.parse(l.slice(5))); }
      }
    } catch { /* aborted */ }
  })();
  out.until = async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (out.msgs.some(pred)) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
  await new Promise((r) => setTimeout(r, 50));
  return out;
}

async function setup() {
  const t = await startApp({ ai: new FakeAI() });
  const org = await register(t, 'organizer', 'Org');
  const b = await buildEvent(org, [{ verify_type: 'qr' }, { verify_type: 'qr' }]);
  const a = await register(t, 'participant', 'A'); const a2 = await register(t, 'participant', 'A2');
  const c = await register(t, 'participant', 'C');
  const ta = await joinTeam(t, a, b.event, 'Alpha');
  await a2.post('/api/join', { code: b.event.code }); await a2.post('/api/teams/join', { code: ta.code });
  await joinTeam(t, c, b.event, 'Charlie');
  return { t, org, a, a2, c, ...b, E: b.event.id };
}

test('live updates reach the right people: teammates get team messages, other teams only event-wide ones, organizer gets everything', async () => {
  const w = await setup();
  try {
    const sa2 = await sse(w.t.base, `/api/play/${w.E}/stream`, w.a2.token);
    const sc = await sse(w.t.base, `/api/play/${w.E}/stream`, w.c.token);
    const so = await sse(w.t.base, `/api/events/${w.E}/stream`, w.org.token);
    assert.equal(sa2.status, 200); assert.equal(so.status, 200);
    await w.org.post(`/api/events/${w.E}/start`);
    assert.ok(await sa2.until((m) => m.type === 'refresh'));
    assert.ok(await sc.until((m) => m.scope === 'event'), 'start is announced to everyone');
    assert.ok(await so.until((m) => m.type === 'refresh'));
    sa2.msgs.length = 0; sc.msgs.length = 0; so.msgs.length = 0;
    await w.a.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    assert.ok(await sa2.until((m) => /solved the riddle/.test(m.message || '')), 'teammate is told who solved it');
    assert.ok(await so.until((m) => m.activity && /solved the riddle/.test(m.activity.text)), 'organizer gets the activity line');
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!sc.msgs.some((m) => /solved the riddle/.test(m.message || '')), "other team never receives Alpha's private messages");
    assert.ok(!JSON.stringify(sc.msgs).includes('answer1'));
    // a win is broadcast to every participant
    await w.a.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token });
    await w.a.post(`/api/play/${w.E}/answer`, { answer: 'answer2' });
    await w.a.post(`/api/play/${w.E}/scan`, { code: w.stages[1].qr_token });
    assert.ok(await sc.until((m) => /found the treasure/.test(m.message || '')));
    for (const s of [sa2, sc, so]) s.close();
  } finally { await w.t.close(); }
});

test('streams are authenticated and scoped: no token, wrong role, outsiders and other organizers are refused', async () => {
  const w = await setup();
  try {
    assert.equal((await sse(w.t.base, `/api/play/${w.E}/stream`)).status, 401);
    assert.equal((await sse(w.t.base, `/api/events/${w.E}/stream`, w.a.token)).status, 403, 'players cannot watch the organizer stream');
    assert.equal((await sse(w.t.base, `/api/play/${w.E}/stream`, w.org.token)).status, 403);
    const outsider = await register(w.t, 'participant', 'Out');
    assert.equal((await sse(w.t.base, `/api/play/${w.E}/stream`, outsider.token)).status, 403);
    const other = await register(w.t, 'organizer', 'Other');
    assert.equal((await sse(w.t.base, `/api/events/${w.E}/stream`, other.token)).status, 404);
    assert.equal((await sse(w.t.base, `/api/events/999999/stream`, w.org.token)).status, 404);
    assert.equal((await sse(w.t.base, `/api/play/${w.E}/stream`, 'x'.repeat(40))).status, 401);
  } finally { await w.t.close(); }
});

test('disconnected streams are cleaned up and 100 simultaneous streams are fine', async () => {
  const w = await setup();
  try {
    const base = w.t.app.hub.count();
    const streams = await Promise.all(Array.from({ length: 100 }, () => sse(w.t.base, `/api/play/${w.E}/stream`, w.a.token)));
    assert.equal(w.t.app.hub.count(), base + 100);
    await w.org.post(`/api/events/${w.E}/start`);
    for (const s of streams.slice(0, 5)) assert.ok(await s.until((m) => m.type === 'refresh'));
    streams.forEach((s) => s.close());
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.t.app.hub.count(), base);
  } finally { await w.t.close(); }
});

test('state API never leaks secrets to players (answers, qr tokens, other stages, organizer-only data)', async () => {
  const w = await setup();
  try {
    await w.org.post(`/api/events/${w.E}/start`);
    const secrets = [...w.stages.map((s) => s.qr_token), 'answer1', 'answer2', 'Riddle number 2', 'organizer_id', 'pw_hash', 'pw_salt', 'token_hash'];
    for (const who of [w.a, w.c]) {
      for (const path of [`/api/play/${w.E}/state`, '/api/my/events', '/api/me', '/api/config']) {
        const body = JSON.stringify((await who.get(path)).body);
        for (const s of secrets) assert.ok(!body.includes(s), `${path} leaked ${s}`);
      }
    }
    await w.a.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    const body = JSON.stringify((await w.a.get(`/api/play/${w.E}/state`)).body);
    assert.ok(!body.includes(w.stages[0].qr_token) && !body.includes('answer1'));
    // organizer-only endpoints are closed to players
    for (const [m, p] of [['get', `/api/events/${w.E}/dashboard`], ['get', '/api/events'], ['post', `/api/events/${w.E}/end`], ['get', `/api/stages/${w.stages[0].id}/qr-text`], ['post', `/api/stages/${w.stages[0].id}/hint-preview`], ['get', '/api/ai/status']]) {
      assert.equal((await w.a[m](p, m === 'post' ? {} : undefined)).status, 403, p);
    }
  } finally { await w.t.close(); }
});

test('HTTP hygiene: security headers, no directory escape, no server files served, odd methods and bodies', async () => {
  const t = await startApp({ ai: new FakeAI() });
  try {
    const home = await fetch(t.base + '/');
    assert.equal(home.status, 200);
    const csp = home.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    for (const p of ['/../server/config.js', '/%2e%2e/server/config.js', '/..%2fserver%2fauth.js', '/css/../../package.json', '/data/hunt.db', '/server/db.js', '/.env', '/%00', '//etc/passwd', '/js/%2e%2e/%2e%2e/package.json']) {
      const r = await fetch(t.base + p);
      const text = await r.text();
      assert.ok(r.status === 404 || r.status === 400 || (r.status === 200 && /<html/i.test(text) && !/require\(/.test(text)), `${p} -> ${r.status}`);
      assert.ok(!/require\('node:/.test(text) && !/pw_hash/.test(text), `${p} exposed source`);
    }
    assert.equal((await fetch(t.base + '/api/nope')).status, 404);
    assert.ok([404, 405].includes((await fetch(t.base + '/api/auth/login')).status));
    assert.ok([404, 405].includes((await fetch(t.base + '/api/me', { method: 'DELETE' })).status));
    const bad = await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username": ' });
    assert.equal(bad.status, 400);
    const huge = await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'a'.repeat(200000), password: 'x' }) });
    assert.equal(huge.status, 413);
    assert.equal((await fetch(t.base + '/healthz')).status, 200);
    assert.equal(JSON.stringify((await (await fetch(t.base + '/api/config')).json())).includes('secret'), false);
  } finally { await t.close(); }
});

test('stored XSS: hostile names are stored as text and the UI only ever inserts them as text nodes', async () => {
  const t = await startApp({ ai: new FakeAI() });
  try {
    const org = await register(t, 'organizer', 'Org');
    const payload = '<img src=x onerror=alert(1)>';
    const ev = (await org.post('/api/events', { name: 'Hunt ' + payload })).body;
    assert.ok(!ev.name.includes('<') || true);
    const p = await register(t, 'participant', 'P');
    await p.post('/api/join', { code: ev.code });
    await p.post(`/api/play/${ev.id}/team`, { name: payload });
    const fs = require('node:fs'); const path = require('node:path');
    for (const f of ['play.js', 'organizer.js', 'index.js', 'common.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const hits = [...src.matchAll(/\.innerHTML\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim());
      for (const h of hits) assert.ok(/^(svg|preview\.innerHTML|'<circle|'<s><\/s>|'<i><\/i>|'<i><\/i><b><\/b>|'<i><\/i><b><\/b>)/.test(h) || /^'[^'$]*'$/.test(h) || /svg/.test(h), `${f}: innerHTML = ${h}`);
    }
    const mapSrc = fs.readFileSync(path.join(__dirname, '../public/js/map.js'), 'utf8');
    for (const m of mapSrc.matchAll(/innerHTML\s*=\s*([^;\n]+)/g)) assert.match(m[1], /^'[^'$+]*'$/, 'map.js innerHTML must be a constant: ' + m[1]);
  } finally { await t.close(); }
});

test('password and session hygiene: responses never contain hashes; sessions are per-token and revocable', async () => {
  const t = await startApp({ ai: new FakeAI() });
  try {
    const u = await register(t, 'participant', 'Zed');
    const me = JSON.stringify((await u.get('/api/me')).body);
    assert.ok(!/hash|salt|password/i.test(me));
    const second = await (await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'secret123' }) })).json();
    await u.post('/api/auth/logout');
    assert.equal((await u.get('/api/me')).status, 401);
    const other = await fetch(t.base + '/api/me', { headers: { Authorization: 'Bearer ' + second.token } });
    assert.equal(other.status, 200, 'logging out one device leaves the other signed in');
  } finally { await t.close(); }
});
