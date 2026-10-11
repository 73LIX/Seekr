'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const badRequest = (code, msg, extra) => new HttpError(400, code, msg, extra);
const unauthorized = (msg = 'Please sign in') => new HttpError(401, 'unauthorized', msg);
const forbidden = (msg = 'Not allowed', code = 'forbidden') => new HttpError(403, code, msg);
const notFound = (msg = 'Not found', code = 'not_found') => new HttpError(404, code, msg);
const conflict = (code, msg, extra) => new HttpError(409, code, msg, extra);
const tooMany = (msg, retryMs) =>
  new HttpError(429, 'rate_limited', msg, { retry_after_ms: Math.max(0, Math.ceil(retryMs || 0)) });

// ---------- codes ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
function randomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
function normalizeCode(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 40);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- text ----------
function cleanText(value, max, { multiline = false } = {}) {
  if (value === undefined || value === null) return '';
  let s = String(value).normalize('NFC');
  // strip control chars (keep \n and \t when multiline), zero-width and bidi override chars
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '');
  if (!multiline) s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/[  ]{2,}/g, ' ').trim();
  return s.slice(0, max);
}

// ---------- riddle answers ----------
function normalizeAnswer(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}
/** edit distance where swapping two adjacent letters counts as ONE edit (common phone typo) */
function levenshtein(a, b, cap = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let prevMin = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // a transposition reaches back two rows, so only stop early when both recent rows are already over the cap
    if (rowMin > cap && prevMin > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
    prevMin = rowMin;
  }
  return prev[b.length];
}
/** exact (after normalisation / ignoring spaces) or a small typo on longer answers */
function answerMatches(input, accepted) {
  const given = normalizeAnswer(String(input ?? '').slice(0, 200));
  if (!given) return false;
  const givenCompact = given.replace(/ /g, '');
  for (const raw of accepted) {
    const want = normalizeAnswer(raw);
    if (!want) continue;
    if (given === want) return true;
    const wantCompact = want.replace(/ /g, '');
    if (givenCompact === wantCompact) return true;
    if (/^\d+$/.test(wantCompact)) continue; // numbers must be exact
    const tolerance = wantCompact.length >= 9 ? 2 : wantCompact.length >= 5 ? 1 : 0;
    if (tolerance && levenshtein(givenCompact, wantCompact, tolerance) <= tolerance) return true;
  }
  return false;
}

// ---------- geo ----------
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------- passwords / tokens ----------
async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
async function verifyPassword(password, saltHex, hashHex) {
  const { hash } = await hashPassword(password, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const newToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- rate limiting (in memory, single process) ----------
class RateLimiter {
  constructor(disabled = false) {
    this.disabled = disabled;
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }
  /** count one hit; returns {ok, retryMs} */
  hit(key, max, windowMs) {
    if (this.disabled) return { ok: true, retryMs: 0 };
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return b.count > max ? { ok: false, retryMs: b.resetAt - now } : { ok: true, retryMs: 0 };
  }
  /** peek without counting */
  blocked(key, max) {
    if (this.disabled) return { blocked: false, retryMs: 0 };
    const b = this.buckets.get(key);
    const now = Date.now();
    if (b && b.resetAt > now && b.count >= max) return { blocked: true, retryMs: b.resetAt - now };
    return { blocked: false, retryMs: 0 };
  }
  reset(key) {
    this.buckets.delete(key);
  }
  sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
  stop() {
    clearInterval(this.timer);
  }
}

module.exports = {
  HttpError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany,
  randomCode, normalizeCode, sha256, cleanText, normalizeAnswer, levenshtein, answerMatches,
  haversineM, hashPassword, verifyPassword, newToken, tokenHash, safeEqual, RateLimiter,
};
