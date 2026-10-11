'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, register } = require('./helpers');

describe('auth', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  test('register + /api/me for both roles', async () => {
    for (const role of ['organizer', 'participant']) {
      const c = await register(t, role);
      const me = await c.get('/api/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.role, role);
      assert.equal(me.body.user.id, c.user.id);
      assert.ok(!JSON.stringify(me.body).includes('pw_'), 'no password material in responses');
    }
  });

  test('duplicate usernames are rejected case-insensitively', async () => {
    const anon = client(() => t.base);
    const a = await anon.post('/api/auth/register', { username: 'Sherlock', password: 'secret1', role: 'participant' });
    assert.equal(a.status, 200);
    const b = await anon.post('/api/auth/register', { username: 'sherLOCK', password: 'secret1', role: 'organizer' });
    assert.equal(b.status, 409);
    assert.equal(b.body.error.code, 'username_taken');
  });

  test('invalid registration input is refused', async () => {
    const anon = client(() => t.base);
    const bad = [
      { username: 'ab', password: 'secret1', role: 'participant' },
      { username: 'has space', password: 'secret1', role: 'participant' },
      { username: 'emoji😀name', password: 'secret1', role: 'participant' },
      { username: "x'; DROP TABLE users;--", password: 'secret1', role: 'participant' },
      { username: 'goodname', password: '123', role: 'participant' },
      { username: 'goodname', password: 'x'.repeat(200), role: 'participant' },
      { username: 'goodname', password: 'secret1', role: 'admin' },
      { username: 'goodname', password: 'secret1' },
      {},
    ];
    for (const body of bad) {
      const r = await anon.post('/api/auth/register', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  test('login works, wrong password and unknown user look identical', async () => {
    const anon = client(() => t.base);
    await anon.post('/api/auth/register', { username: 'loginuser', password: 'rightpass', role: 'participant' });
    const ok = await anon.post('/api/auth/login', { username: 'LOGINUSER', password: 'rightpass' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    const wrong = await anon.post('/api/auth/login', { username: 'loginuser', password: 'nope' });
    const ghost = await anon.post('/api/auth/login', { username: 'nobody-here', password: 'nope' });
    assert.equal(wrong.status, 401);
    assert.equal(ghost.status, 401);
    assert.equal(wrong.body.error.message, ghost.body.error.message);
  });

  test('SQL-injection style credentials do not log in or crash', async () => {
    const anon = client(() => t.base);
    for (const username of ["' OR '1'='1", 'admin"--', "x' UNION SELECT * FROM users--"]) {
      const r = await anon.post('/api/auth/login', { username, password: "' OR '1'='1" });
      assert.equal(r.status, 401);
    }
  });

  test('logout invalidates the token', async () => {
    const c = await register(t, 'participant');
    assert.equal((await c.get('/api/me')).status, 200);
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    assert.equal((await c.get('/api/me')).status, 401);
  });

  test('missing, malformed and forged tokens are 401', async () => {
    const anon = client(() => t.base);
    assert.equal((await anon.get('/api/me')).status, 401);
    for (const token of ['garbage', 'x'.repeat(43), 'a'.repeat(300), '../../etc/passwd']) {
      const c = client(() => t.base, token);
      assert.equal((await c.get('/api/me')).status, 401, token);
    }
    const real = await register(t, 'participant');
    // token in the query string must NOT authenticate
    const q = await client(() => t.base).get('/api/me', { query: { token: real.token } });
    assert.equal(q.status, 401);
    // wrong scheme
    const r = await fetch(`${t.base}/api/me`, { headers: { Authorization: `Token ${real.token}` } });
    assert.equal(r.status, 401);
  });

  test('expired sessions are rejected', async () => {
    const c = await register(t, 'participant');
    t.app.db.run('UPDATE sessions SET expires_at = ?', Date.now() - 1000);
    assert.equal((await c.get('/api/me')).status, 401);
  });

  test('roles are isolated', async () => {
    const org = await register(t, 'organizer');
    const p = await register(t, 'participant');
    assert.equal((await p.get('/api/events')).status, 403);
    assert.equal((await p.post('/api/events', { name: 'Nope' })).status, 403);
    assert.equal((await org.get('/api/my/events')).status, 403);
    assert.equal((await org.post('/api/join', { code: 'ABCDEF' })).status, 403);
    assert.equal((await client(() => t.base).get('/api/events')).status, 401);
  });

  test('bad bodies: invalid JSON, arrays, oversized', async () => {
    const anon = client(() => t.base);
    const bad = await anon.req('POST', '/api/auth/login', undefined, { raw: '{not json', headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_json');
    const arr = await anon.req('POST', '/api/auth/login', undefined, { raw: '[1,2]', headers: { 'Content-Type': 'application/json' } });
    assert.equal(arr.status, 400);
    const big = await anon.req('POST', '/api/auth/login', undefined, { raw: JSON.stringify({ username: 'a', password: 'x'.repeat(200_000) }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(big.status, 413);
  });

  test('display name defaults to the username and is sanitised', async () => {
    const anon = client(() => t.base);
    const a = await anon.post('/api/auth/register', { username: 'nameless', password: 'secret1', role: 'participant' });
    assert.equal(a.body.user.display_name, 'nameless');
    const b = await anon.post('/api/auth/register', { username: 'fancyname', password: 'secret1', role: 'participant', display_name: '  Zed​  \u0000Z  ' });
    assert.equal(b.body.user.display_name, 'Zed Z');
  });
});

describe('auth hardening (rate limits and invite code)', () => {
  test('failed-login lockout and per-IP auth throttle', async () => {
    const t = await startApp({ cfg: { rate: { disabled: false, authMax: 25, authWindowMs: 60_000 } } });
    try {
      const anon = client(() => t.base);
      await anon.post('/api/auth/register', { username: 'victim', password: 'rightpass', role: 'participant' });
      let locked = null;
      for (let i = 0; i < 12; i++) {
        const r = await anon.post('/api/auth/login', { username: 'victim', password: 'wrong' + i });
        if (r.status === 429) { locked = r; break; }
        assert.equal(r.status, 401);
      }
      assert.ok(locked, 'account lockout kicked in');
      // even the right password is refused while locked
      const stillLocked = await anon.post('/api/auth/login', { username: 'victim', password: 'rightpass' });
      assert.equal(stillLocked.status, 429);
      assert.ok(locked.headers.get('retry-after'));
      // the IP-level limiter eventually trips for a scanner hitting many usernames
      let throttled = false;
      for (let i = 0; i < 40; i++) {
        const r = await anon.post('/api/auth/login', { username: `ghost${i}`, password: 'x' });
        if (r.status === 429) { throttled = true; break; }
      }
      assert.ok(throttled, 'per-IP throttle kicked in');
    } finally {
      await t.close();
    }
  });

  test('organizer sign-up can require an invite code', async () => {
    const prev = process.env.ORGANIZER_SIGNUP_CODE;
    process.env.ORGANIZER_SIGNUP_CODE = 'let-me-in';
    const t = await startApp();
    try {
      const anon = client(() => t.base);
      const no = await anon.post('/api/auth/register', { username: 'sneaky', password: 'secret1', role: 'organizer' });
      assert.equal(no.status, 403);
      const wrong = await anon.post('/api/auth/register', { username: 'sneaky', password: 'secret1', role: 'organizer', signup_code: 'nope' });
      assert.equal(wrong.status, 403);
      const yes = await anon.post('/api/auth/register', { username: 'trusted', password: 'secret1', role: 'organizer', signup_code: 'let-me-in' });
      assert.equal(yes.status, 200);
      // participants never need the code
      const p = await anon.post('/api/auth/register', { username: 'player1', password: 'secret1', role: 'participant' });
      assert.equal(p.status, 200);
      assert.equal((await anon.get('/api/config')).body.organizer_code_required, true);
    } finally {
      if (prev === undefined) delete process.env.ORGANIZER_SIGNUP_CODE;
      else process.env.ORGANIZER_SIGNUP_CODE = prev;
      await t.close();
    }
  });
});
