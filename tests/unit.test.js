'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const u = require('../server/util');

describe('answer matching', () => {
  const m = (input, ...accepted) => u.answerMatches(input, accepted);
  test('case, spacing and punctuation are ignored', () => {
    assert.ok(m('  CLOCK ', 'clock'));
    assert.ok(m('The Clock!', 'clock'));
    assert.ok(m('a clock', 'clock'));
    assert.ok(m('grand-father clock', 'grandfather clock'));
    assert.ok(m('stair case', 'staircase'));
    assert.ok(m("it's a secret", 'its a secret'));
  });
  test('diacritics are folded', () => {
    assert.ok(m('café', 'cafe'));
    assert.ok(m('CAFE', 'café'));
  });
  test('typos tolerated only on longer answers', () => {
    assert.ok(m('lighthose', 'lighthouse')); // 1 edit on 10 letters
    assert.ok(m('lighthoise', 'lighthouse'));
    assert.ok(m('fountian', 'fountain')); // swapped adjacent letters count as a single typo
    assert.ok(m('lighthxxse', 'lighthouse')); // two substitutions are within the 2-edit allowance for 9+ letters
    assert.equal(m('lighthxxxe', 'lighthouse'), false); // three edits are not
  });
  test('levenshtein handles swaps, caps and edge cases', () => {
    assert.equal(u.levenshtein('ab', 'ba'), 1);
    assert.equal(u.levenshtein('abcd', 'acbd'), 1);
    assert.equal(u.levenshtein('kitten', 'sitting'), 3);
    assert.equal(u.levenshtein('', 'abc'), 3);
    assert.ok(u.levenshtein('aaaaaaaa', 'bbbbbbbb', 2) > 2);
  });
  test('short answers and numbers must be exact', () => {
    assert.equal(m('cat', 'cap'), false);
    assert.equal(m('mist', 'most'), false);
    assert.equal(m('1947', '1948'), false);
    assert.ok(m('1947', '1947'));
  });
  test('multiple accepted answers', () => {
    assert.ok(m('tree', 'oak', 'tree'));
    assert.equal(m('bush', 'oak', 'tree'), false);
  });
  test('empty and junk input never match', () => {
    assert.equal(m('', 'clock'), false);
    assert.equal(m('   ', 'clock'), false);
    assert.equal(m('!!!', 'clock'), false);
    assert.equal(m(null, 'clock'), false);
    assert.equal(m('x'.repeat(5000), 'clock'), false);
  });
});

describe('text cleaning', () => {
  test('strips control, zero-width and bidi characters', () => {
    assert.equal(u.cleanText('a\u0000b​c‮d', 20), 'abcd');
  });
  test('collapses whitespace and truncates', () => {
    assert.equal(u.cleanText('  a   b \n c ', 20), 'a b c');
    assert.equal(u.cleanText('x'.repeat(100), 10).length, 10);
  });
  test('multiline keeps newlines', () => {
    assert.equal(u.cleanText('a\nb', 20, { multiline: true }), 'a\nb');
  });
});

describe('geo + codes + limiter', () => {
  test('haversine is sane', () => {
    assert.ok(Math.abs(u.haversineM(0, 0, 0, 0)) < 1e-6);
    const d = u.haversineM(22.5726, 88.3639, 22.5726, 88.3739); // ~0.01deg lon at lat 22.57
    assert.ok(d > 1000 && d < 1100, `got ${d}`);
  });
  test('codes are 6 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) assert.match(u.randomCode(6), /^[A-HJ-NP-Z2-9]{6}$/);
  });
  test('normalizeCode accepts lowercase, spaces and dashes', () => {
    assert.equal(u.normalizeCode(' ab-cd ef '), 'ABCDEF');
    assert.equal(u.normalizeCode(null), '');
  });
  test('rate limiter counts per window and resets', async () => {
    const rl = new u.RateLimiter(false);
    assert.ok(rl.hit('k', 2, 50).ok);
    assert.ok(rl.hit('k', 2, 50).ok);
    const third = rl.hit('k', 2, 50);
    assert.equal(third.ok, false);
    assert.ok(third.retryMs > 0);
    await new Promise((r) => setTimeout(r, 70));
    assert.ok(rl.hit('k', 2, 50).ok);
    rl.stop();
  });
  test('password hashing verifies and rejects', async () => {
    const { salt, hash } = await u.hashPassword('hunter22');
    assert.ok(await u.verifyPassword('hunter22', salt, hash));
    assert.equal(await u.verifyPassword('hunter23', salt, hash), false);
  });
});
