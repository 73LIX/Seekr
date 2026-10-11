'use strict';
const {
  HttpError, badRequest, cleanText, hashPassword, verifyPassword, newToken, tokenHash, safeEqual,
} = require('./util');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const DUMMY_SALT = '00'.repeat(16);

function createAuth({ db, cfg, limiter }) {
  const ttlMs = cfg.sessionTtlHours * 3600 * 1000;

  function publicUser(u) {
    return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
  }

  function issueSession(userId) {
    const token = newToken();
    const now = Date.now();
    db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', tokenHash(token), userId, now, now + ttlMs);
    return token;
  }

  function bearer(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(h);
    return m ? m[1] : null;
  }

  function authenticate(req) {
    const token = bearer(req);
    if (!token) return null;
    const row = db.get(
      `SELECT u.id, u.username, u.display_name, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      tokenHash(token),
    );
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
      return null;
    }
    return { id: row.id, username: row.username, display_name: row.display_name, role: row.role, token };
  }

  async function register({ username, password, role, display_name, signup_code }) {
    const uname = String(username ?? '').trim();
    if (!USERNAME_RE.test(uname)) throw badRequest('invalid_username', 'Username must be 3-24 letters, numbers, dots, dashes or underscores');
    const pw = String(password ?? '');
    if (pw.length < 6 || pw.length > 128) throw badRequest('invalid_password', 'Password must be 6-128 characters');
    if (role !== 'organizer' && role !== 'participant') throw badRequest('invalid_role', 'Choose organizer or participant');
    if (role === 'organizer' && cfg.organizerSignupCode && !safeEqual(String(signup_code ?? ''), cfg.organizerSignupCode)) {
      throw new HttpError(403, 'bad_signup_code', 'A valid organizer invite code is required');
    }
    const name = cleanText(display_name, 30) || uname;
    if (db.get('SELECT 1 FROM users WHERE username = ?', uname)) throw new HttpError(409, 'username_taken', 'That username is already taken');
    const { salt, hash } = await hashPassword(pw);
    let id;
    try {
      const r = db.run('INSERT INTO users (username, display_name, role, pw_salt, pw_hash, created_at) VALUES (?,?,?,?,?,?)', uname, name, role, salt, hash, Date.now());
      id = Number(r.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'username_taken', 'That username is already taken');
      throw e;
    }
    const user = db.get('SELECT * FROM users WHERE id = ?', id);
    return { token: issueSession(id), user: publicUser(user) };
  }

  async function login({ username, password }, ip) {
    const uname = String(username ?? '').trim().slice(0, 60);
    const pw = String(password ?? '').slice(0, 200);
    const failKey = `loginfail:${uname.toLowerCase()}`;
    const lock = limiter.blocked(failKey, 10);
    if (lock.blocked) throw new HttpError(429, 'rate_limited', 'Too many failed sign-in attempts - try again later', { retry_after_ms: lock.retryMs });
    const u = db.get('SELECT * FROM users WHERE username = ?', uname);
    const ok = u ? await verifyPassword(pw, u.pw_salt, u.pw_hash) : (await verifyPassword(pw, DUMMY_SALT, '00'.repeat(32)), false);
    if (!ok) {
      limiter.hit(failKey, 10, 15 * 60_000);
      throw new HttpError(401, 'invalid_credentials', 'Wrong username or password');
    }
    limiter.reset(failKey);
    return { token: issueSession(u.id), user: publicUser(u) };
  }

  function logout(req) {
    const token = bearer(req);
    if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
  }

  function sweep() {
    db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  }

  return { authenticate, register, login, logout, publicUser, sweep };
}

module.exports = { createAuth };
