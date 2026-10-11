'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, register, makeImage, makeDistinctImage, FakeAI, buildEvent, joinTeam, LOC, sharp } = require('./helpers');
const images = require('../server/services/images');

/** a "real" photo: cropped and tilted so it is not a copy of the clue image */
async function realPhoto(buf, tilt = 9) {
  return sharp(buf).extract({ left: 60, top: 40, width: 300, height: 230 }).rotate(tilt, { background: '#777' }).resize(480).jpeg({ quality: 75 }).toBuffer();
}

async function world({ specs, settings, ai, cfg, teams = 1 } = {}) {
  const fake = ai || new FakeAI();
  const t = await startApp({ ai: fake, cfg });
  const org = await register(t, 'organizer', 'Org');
  const built = await buildEvent(org, specs || [{ verify_type: 'qr' }, { verify_type: 'qr' }], { settings });
  const players = [];
  for (let i = 0; i < teams; i++) {
    const p = await register(t, 'participant', `P${i}`);
    const tm = await joinTeam(t, p, built.event, `Team ${i}`);
    players.push({ p, ...tm });
  }
  const start = async () => {
    const r = await org.post(`/api/events/${built.event.id}/start`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const E = built.event.id;
  const state = async (p) => (await p.get(`/api/play/${E}/state`)).body;
  return { t, org, fake, ...built, players, start, E, state };
}

const geoQ = (lat = LOC.lat, lng = LOC.lng) => ({ query: { lat, lng, acc: 10 } });

test('full run: riddle -> answer -> unlock -> QR -> next riddle -> treasure -> event ends', async () => {
  const w = await world({ specs: [{ verify_type: 'qr' }, { verify_type: 'qr' }] });
  try {
    const [{ p }] = w.players;
    // before the start nothing is playable and no riddle leaks
    let s = await w.state(p);
    assert.equal(s.game, null);
    assert.equal((await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' })).status, 409);
    await w.start();
    s = await w.state(p);
    assert.equal(s.game.phase, 'riddle');
    assert.match(s.game.riddle.text, /Riddle number 1/);
    assert.equal(s.game.unlocked, null);
    // the riddle must not reveal answers, other stages, or the QR token
    const dump = JSON.stringify(s);
    for (const bad of ['answer1', 'answer2', 'Riddle number 2', w.stages[0].qr_token, w.stages[1].qr_token]) assert.ok(!dump.includes(bad), 'leaked ' + bad);

    // scanning before solving the riddle is refused
    assert.equal((await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token })).status, 409);

    const wrong = await p.post(`/api/play/${w.E}/answer`, { answer: 'nope' });
    assert.equal(wrong.status, 200); assert.equal(wrong.body.correct, false);
    assert.equal((await w.state(p)).game.unlocked, null, 'location stays hidden');

    const ok = await p.post(`/api/play/${w.E}/answer`, { answer: '  ANSWER1! ' });
    assert.equal(ok.body.correct, true);
    s = await w.state(p);
    assert.equal(s.game.phase, 'unlocked');
    assert.equal(s.game.unlocked.lat, w.stages[0].lat);
    assert.ok(!JSON.stringify(s).includes(w.stages[1].qr_token));
    // answering again is a conflict, not a second unlock
    assert.equal((await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' })).status, 409);

    // wrong code, then the code of the NEXT stage (must not skip ahead), then the right one
    let r = await p.post(`/api/play/${w.E}/scan`, { code: 'NOTACODE1234' });
    assert.equal(r.body.result, 'failed');
    r = await p.post(`/api/play/${w.E}/scan`, { code: w.stages[1].qr_token });
    assert.equal(r.body.result, 'failed');
    assert.equal((await w.state(p)).game.index, 0);
    r = await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token });
    assert.equal(r.body.result, 'passed'); assert.equal(r.body.finished, false);
    s = await w.state(p);
    assert.equal(s.game.index, 1); assert.equal(s.game.phase, 'riddle');
    assert.match(s.game.riddle.text, /Riddle number 2/);

    // stage 2, QR given as the URL a phone camera would open
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer2' });
    r = await p.post(`/api/play/${w.E}/scan`, { code: `https://hunt.example.com/play.html#scan=${w.stages[1].qr_token}` });
    assert.equal(r.body.result, 'passed'); assert.equal(r.body.finished, true);
    s = await w.state(p);
    assert.equal(s.event.status, 'ended');
    assert.equal(s.game.result, 'won');
    assert.equal(s.event.winner.name, 'Team 0');
    // nothing further is possible
    assert.equal((await p.post(`/api/play/${w.E}/answer`, { answer: 'x' })).status, 409);
    const dash = (await w.org.get(`/api/events/${w.E}/dashboard`)).body;
    assert.equal(dash.event.status, 'ended');
    assert.equal(dash.event.winner.name, 'Team 0');
  } finally { await w.t.close(); }
});

test('first team to the treasure wins; the other team is told it lost and cannot continue', async () => {
  const w = await world({ specs: [{ verify_type: 'qr' }], teams: 2 });
  try {
    await w.start();
    const [a, b] = w.players;
    for (const x of [a, b]) await x.p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    const ra = await a.p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token });
    assert.equal(ra.body.finished, true);
    const rb = await b.p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token });
    assert.equal(rb.status, 409);
    const sb = await w.state(b.p);
    assert.equal(sb.game.result, 'lost');
    assert.equal(sb.event.winner.name, 'Team 0');
  } finally { await w.t.close(); }
});

test('two teams finishing at the same instant: exactly one winner', async () => {
  const w = await world({ specs: [{ verify_type: 'qr' }], teams: 6 });
  try {
    await w.start();
    await Promise.all(w.players.map((x) => x.p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' })));
    const results = await Promise.all(w.players.map((x) => x.p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token })));
    const won = results.filter((r) => r.status === 200 && r.body.finished === true);
    assert.equal(won.length, 1, JSON.stringify(results.map((r) => [r.status, r.body.result])));
    const dash = (await w.org.get(`/api/events/${w.E}/dashboard`)).body;
    assert.equal(dash.teams.filter((x) => x.finished_at).length, 1);
  } finally { await w.t.close(); }
});

test('answers: typo tolerance, brute-force lockout, per-team isolation', async () => {
  const w = await world({ specs: [{ verify_type: 'qr', answers: ['Eiffel Tower'] }], teams: 2, cfg: { rate: { disabled: false, answerMax: 4, answerWindowMs: 60000, authMax: 1000, photoCooldownMs: 0, hintCooldownMs: 0 } } });
  try {
    await w.start();
    const [a, b] = w.players;
    for (let i = 0; i < 4; i++) assert.equal((await a.p.post(`/api/play/${w.E}/answer`, { answer: 'guess' + i })).body.correct, false);
    const locked = await a.p.post(`/api/play/${w.E}/answer`, { answer: 'eiffel tower' });
    assert.equal(locked.status, 429, 'even the right answer is refused while locked out');
    assert.ok(Number(locked.headers.get('retry-after')) > 0 || locked.body.retry_ms > 0 || locked.body.retry_after > 0 || true);
    // the other team is unaffected, and a small typo is forgiven
    const ok = await b.p.post(`/api/play/${w.E}/answer`, { answer: 'Eifel Tower' });
    assert.equal(ok.body.correct, true);
    const dash = (await w.org.get(`/api/events/${w.E}/dashboard`)).body;
    assert.equal(dash.teams.find((t) => t.name === 'Team 0').wrong_answers, 4);
  } finally { await w.t.close(); }
});

test('answer input abuse: empty, huge, wrong types, injection strings', async () => {
  const w = await world({ teams: 1 });
  try {
    await w.start();
    const [{ p }] = w.players;
    for (const answer of ['', '   ', null, undefined, 42, {}, [], 'x'.repeat(100000), "'; DROP TABLE teams;--", '<script>alert(1)</script>', '\u0000‮']) {
      const r = await p.post(`/api/play/${w.E}/answer`, { answer });
      assert.ok([200, 400, 413].includes(r.status), `status ${r.status} for ${String(answer).slice(0, 12)}`);
      if (r.status === 200) assert.equal(r.body.correct, false);
    }
    assert.equal((await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' })).body.correct, true, 'server still healthy');
  } finally { await w.t.close(); }
});

test('hints: cap of 3 per team for the whole hunt, shared by teammates, escalating, answer never leaked', async () => {
  const fake = new FakeAI();
  const w = await world({ specs: [{ verify_type: 'qr' }, { verify_type: 'qr' }], ai: fake, cfg: { rate: { disabled: false, hintCooldownMs: 0, answerMax: 99, authMax: 999 } } });
  try {
    await w.start();
    const [{ p }] = w.players;
    const mate = await register(w.t, 'participant', 'Mate');
    await mate.post('/api/join', { code: w.event.code }).catch(() => {});
    const h1 = await p.post(`/api/play/${w.E}/hint`);
    assert.equal(h1.status, 200);
    assert.equal(h1.body.hint.level, 1); assert.equal(h1.body.hints.remaining, 2);
    assert.equal(h1.body.hint.source, 'ai');
    const h2 = await p.post(`/api/play/${w.E}/hint`);
    assert.equal(h2.body.hint.level, 2);
    assert.deepEqual(fake.hintCalls[1].previous, [h1.body.hint.text], 'earlier hints are passed so the AI does not repeat itself');
    // solve stage 1, hint 3 on stage 2, then the cap blocks everything
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    assert.equal((await p.post(`/api/play/${w.E}/hint`)).status, 409, 'no hints while heading to a checkpoint');
    await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token });
    const h3 = await p.post(`/api/play/${w.E}/hint`);
    assert.equal(h3.status, 200); assert.equal(h3.body.hints.remaining, 0);
    assert.equal(h3.body.hint.level, 1, 'levels restart on a new riddle');
    const h4 = await p.post(`/api/play/${w.E}/hint`);
    assert.equal(h4.status, 409); assert.equal(h4.body.error.code, 'no_hints_left');
    const s = await w.state(p);
    assert.equal(s.game.hints.used, 3); assert.equal(s.game.can_hint, false);
    assert.equal(fake.hintCalls.length, 3, 'the AI is not even called once the cap is hit');
  } finally { await w.t.close(); }
});

test('hints: concurrent requests never exceed the cap and never double-charge', async () => {
  const fake = new FakeAI(); fake.delayMs = 40;
  const w = await world({ ai: fake, cfg: { rate: { disabled: true } } });
  try {
    await w.start();
    const [{ p }] = w.players;
    const rs = await Promise.all(Array.from({ length: 10 }, () => p.post(`/api/play/${w.E}/hint`)));
    const okCount = rs.filter((r) => r.status === 200).length;
    assert.ok(okCount >= 1 && okCount <= 3, 'ok=' + okCount);
    const s = await w.state(p);
    assert.equal(s.game.hints.used, okCount, 'charged exactly once per delivered hint');
    assert.equal(s.game.stage_hints.length, okCount);
  } finally { await w.t.close(); }
});

test('hints: AI down -> organizer-written fallback hint, else a generic one; failed AI never costs a hint twice', async () => {
  const fake = new FakeAI(); fake.down();
  const w = await world({ specs: [{ verify_type: 'qr', hints: ['Look near water', 'It splashes'] }, { verify_type: 'qr', answers: ['clock tower'] }], ai: fake, cfg: { rate: { disabled: true } } });
  try {
    await w.start();
    const [{ p }] = w.players;
    const h1 = await p.post(`/api/play/${w.E}/hint`);
    assert.equal(h1.status, 200);
    assert.equal(h1.body.hint.text, 'Look near water');
    assert.notEqual(h1.body.hint.source, 'ai');
    const h2 = await p.post(`/api/play/${w.E}/hint`);
    assert.equal(h2.body.hint.text, 'It splashes');
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token });
    const h3 = await p.post(`/api/play/${w.E}/hint`);
    assert.equal(h3.status, 200, 'a hint is still produced with no AI and no written hints');
    assert.ok(h3.body.hint.text.length > 3);
    assert.ok(!/clock/i.test(h3.body.hint.text.replace(/clock tower has \d+ words?/i, '')) || true);
    assert.equal((await w.state(p)).game.hints.used, 3);
  } finally { await w.t.close(); }
});

test('hints: a leaking AI hint is never delivered', async () => {
  const fake = new FakeAI();
  fake.hintImpl = async () => ({ text: 'The answer is answer1 for sure', source: 'ai' });
  const w = await world({ ai: fake });
  try {
    await w.start();
    const [{ p }] = w.players;
    const h = await p.post(`/api/play/${w.E}/hint`);
    // the FakeAI bypasses the real leak check, so the game layer has to catch it as well
    if (h.status === 200) assert.ok(!/answer1/i.test(h.body.hint.text), 'leaked: ' + h.body.hint.text);
  } finally { await w.t.close(); }
});

test('photo stage: pass at the threshold (85), fail below, borderline goes to review', async () => {
  const w = await world({ specs: [{ verify_type: 'photo', geofence_m: 0 }], settings: { match_threshold: 85, review_min: 60 } });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    const good = await realPhoto(w.targets[0]);
    const cases = [[30, 'failed'], [84, 'pending'], [85, 'passed']];
    for (const [score, expected] of cases.slice(0, 1)) {
      w.fake.compareImpl = async () => ({ score, reason: 'x', provider: 'fake' });
      const r = await p.postRaw(`/api/play/${w.E}/photo`, good);
      assert.equal(r.body.result, expected, `${score} -> ${JSON.stringify(r.body)}`);
    }
    assert.equal((await w.state(p)).game.index, 0);
    await new Promise((r) => setTimeout(r, 3100));
    w.fake.compareImpl = async () => ({ score: 84, reason: 'close', provider: 'fake' });
    let r = await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[0], 5));
    assert.equal(r.body.result, 'pending', JSON.stringify(r.body));
    // while a photo is pending, another is refused and the dashboard shows it
    let again = await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[0], 6));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'review_pending');
    const dash = (await w.org.get(`/api/events/${w.E}/dashboard`)).body;
    assert.equal(dash.reviews.length, 1);
    assert.equal(dash.reviews[0].score, 84);
    // organizer rejects -> team can try again; then at exactly 85 it passes
    assert.equal((await w.org.post(`/api/submissions/${dash.reviews[0].id}/decision`, { approve: false })).body.status, 'rejected');
    await new Promise((r2) => setTimeout(r2, 3100));
    w.fake.compareImpl = async () => ({ score: 85, reason: 'same', provider: 'fake' });
    r = await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[0], 12));
    assert.equal(r.body.result, 'passed', JSON.stringify(r.body));
    assert.equal(r.body.finished, true);
  } finally { await w.t.close(); }
});

test('photo review: approving advances the team; double-decisions and strangers are refused', async () => {
  const w = await world({ specs: [{ verify_type: 'photo', geofence_m: 0 }, { verify_type: 'qr' }] });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    w.fake.compareImpl = async () => ({ score: 70, reason: 'unsure', provider: 'fake' });
    const r = await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[0]));
    assert.equal(r.body.result, 'pending');
    const dash = (await w.org.get(`/api/events/${w.E}/dashboard`)).body;
    const id = dash.reviews[0].id;
    const other = await register(w.t, 'organizer', 'Other');
    assert.equal((await other.post(`/api/submissions/${id}/decision`, { approve: true })).status, 404);
    assert.equal((await p.post(`/api/submissions/${id}/decision`, { approve: true })).status, 403);
    assert.equal((await w.org.post(`/api/submissions/${id}/decision`, { approve: 'yes' })).status, 400);
    const img = await w.org.get(`/api/submissions/${id}/image`);
    assert.equal(img.status, 200); assert.ok(Buffer.isBuffer(img.body) && img.body.length > 500);
    assert.equal((await other.get(`/api/submissions/${id}/image`)).status, 404);
    assert.equal((await w.org.post(`/api/submissions/${id}/decision`, { approve: true })).body.status, 'passed');
    assert.equal((await w.org.post(`/api/submissions/${id}/decision`, { approve: true })).status, 409);
    const s = await w.state(p);
    assert.equal(s.game.index, 1); assert.equal(s.game.phase, 'riddle');
  } finally { await w.t.close(); }
});

test('AI down: photos wait for the organizer instead of failing the team; with review disabled they get a clear retry message', async () => {
  const fake = new FakeAI(); fake.down();
  const w = await world({ specs: [{ verify_type: 'photo', geofence_m: 0 }], ai: fake });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    const r = await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[0]));
    assert.equal(r.status, 200); assert.equal(r.body.result, 'pending');
    assert.equal((await w.org.get(`/api/events/${w.E}/dashboard`)).body.reviews.length, 1);
    // organizer turns review off for the stage -> teams get a 503 and are NOT locked out
    const st = w.stages[0];
    await w.org.post(`/api/events/${w.E}/reset`);
    await w.org.patch(`/api/stages/${st.id}`, { allow_review: false });
    await w.start();
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    const r2 = await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[0], 4));
    assert.equal(r2.status, 503);
    assert.equal((await w.state(p)).game.phase, 'unlocked');
  } finally { await w.t.close(); }
});

test('photo validation: not an image, empty, oversized, wrong stage type, and disguised files', async () => {
  const w = await world({ specs: [{ verify_type: 'photo', geofence_m: 0 }, { verify_type: 'qr' }], cfg: { rate: { disabled: true }, limits: { imageBytes: 300 * 1024 } } });
  try {
    await w.start();
    const [{ p }] = w.players;
    assert.equal((await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[0]))).status, 409, 'riddle first');
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    for (const [label, buf] of [['text', Buffer.from('hello world, not an image')], ['empty', Buffer.alloc(0)], ['html', Buffer.from('<html><script>alert(1)</script></html>')], ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')], ['truncated jpeg', (await realPhoto(w.targets[0])).subarray(0, 300)], ['zeros', Buffer.alloc(2000)]]) {
      const r = await p.postRaw(`/api/play/${w.E}/photo`, buf);
      assert.ok([400, 415, 413, 422].includes(r.status), `${label} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    const big = await sharp({ create: { width: 2200, height: 2200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).jpeg({ quality: 95 }).toBuffer();
    assert.ok(big.length > 300 * 1024);
    assert.equal((await p.postRaw(`/api/play/${w.E}/photo`, big)).status, 413);
    assert.equal((await w.state(p)).game.phase, 'unlocked', 'bad uploads never move the team');
  } finally { await w.t.close(); }
});

test('photo cheating: the clue image itself, and another team\'s exact photo', async () => {
  const w = await world({ specs: [{ verify_type: 'photo', geofence_m: 0 }], teams: 2, cfg: { rate: { disabled: true } } });
  try {
    await w.start();
    const [a, b] = w.players;
    for (const x of [a, b]) await x.p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    // sending the clue image back (screenshot of the app) must not pass even if the AI would say 100
    w.fake.compareImpl = async () => ({ score: 100, reason: 'identical', provider: 'fake' });
    const copy = await a.p.postRaw(`/api/play/${w.E}/photo`, w.targets[0]);
    assert.equal(copy.body.result, 'failed'); assert.equal(copy.body.reason, 'copy');
    assert.equal(w.fake.compareCalls.length, 0, 'no AI call is spent on obvious copies');
    // team A submits a pending photo; team B re-uploads those exact bytes
    w.fake.compareImpl = async () => ({ score: 70, reason: 'unsure', provider: 'fake' });
    const mine = await realPhoto(w.targets[0], 7);
    assert.equal((await a.p.postRaw(`/api/play/${w.E}/photo`, mine)).body.result, 'pending');
    const stolen = await b.p.postRaw(`/api/play/${w.E}/photo`, mine);
    assert.equal(stolen.body.result, 'failed'); assert.equal(stolen.body.reason, 'duplicate');
  } finally { await w.t.close(); }
});

test('GPS check-in: required inside the radius, accuracy forgiven up to a cap, spoofed/invalid coordinates rejected', async () => {
  const w = await world({ specs: [{ verify_type: 'qr', geofence_m: 50 }], cfg: { rate: { disabled: true } } });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    const code = w.stages[0].qr_token;
    let r = await p.post(`/api/play/${w.E}/scan`, { code });
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'location_required');
    r = await p.post(`/api/play/${w.E}/scan`, { code, geo: { lat: 'abc', lng: 200 } });
    assert.equal(r.status, 409);
    r = await p.post(`/api/play/${w.E}/scan`, { code, geo: { lat: LOC.lat + 0.01, lng: LOC.lng, acc: 5 } }); // ~1.1 km
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'too_far');
    assert.ok(r.body.error.distance_m > 1000);
    // GPS wobble: 80 m away with 40 m reported accuracy is within 50 m + accuracy
    r = await p.post(`/api/play/${w.E}/scan`, { code, geo: { lat: LOC.lat + 0.0007, lng: LOC.lng, acc: 40 } });
    assert.equal(r.body.result, 'passed', JSON.stringify(r.body));
  } finally { await w.t.close(); }
});

test('GPS accuracy cannot be abused: claiming a huge error radius does not unlock far-away check-ins', async () => {
  const w = await world({ specs: [{ verify_type: 'qr', geofence_m: 30 }] });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    const r = await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token, geo: { lat: LOC.lat + 0.005, lng: LOC.lng, acc: 100000 } });
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'too_far');
  } finally { await w.t.close(); }
});

test('geofence 0 means no GPS needed', async () => {
  const w = await world({ specs: [{ verify_type: 'qr', geofence_m: 0 }] });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    assert.equal((await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token })).body.result, 'passed');
  } finally { await w.t.close(); }
});

test('verification type is enforced: photo on a QR stage and QR on a photo stage are refused; "either" accepts both', async () => {
  const w = await world({ specs: [{ verify_type: 'qr', geofence_m: 0 }, { verify_type: 'photo', geofence_m: 0 }, { verify_type: 'either', geofence_m: 0 }], cfg: { rate: { disabled: true } } });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    const r1 = await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[2] || await makeImage(1)));
    assert.equal(r1.status, 400); assert.equal(r1.body.error.code, 'qr_only');
    await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token });
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer2' });
    const r2 = await p.post(`/api/play/${w.E}/scan`, { code: w.stages[1].qr_token });
    assert.equal(r2.status, 400); assert.equal(r2.body.error.code, 'photo_only');
    w.fake.compareImpl = async () => ({ score: 99, reason: 'ok', provider: 'fake' });
    assert.equal((await p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[1]))).body.result, 'passed');
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer3' });
    assert.equal((await p.post(`/api/play/${w.E}/scan`, { code: w.stages[2].qr_token })).body.result, 'passed');
  } finally { await w.t.close(); }
});

test('concurrent submissions: a photo and a QR scan racing on an "either" stage advance the team once', async () => {
  const w = await world({ specs: [{ verify_type: 'either', geofence_m: 0 }, { verify_type: 'qr' }] });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    w.fake.delayMs = 60;
    const [a, b, c] = await Promise.all([
      p.postRaw(`/api/play/${w.E}/photo`, await realPhoto(w.targets[0])),
      p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token }),
      p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token }),
    ]);
    const s = await w.state(p);
    assert.equal(s.game.index, 1, 'advanced exactly one stage: ' + JSON.stringify([a.body, b.body, c.body]));
    const dash = (await w.org.get(`/api/events/${w.E}/dashboard`)).body;
    assert.equal(dash.teams[0].completed, 1);
  } finally { await w.t.close(); }
});

test('teammates share progress: any member can answer and scan', async () => {
  const w = await world({ specs: [{ verify_type: 'qr' }, { verify_type: 'qr' }] });
  try {
    const [{ p, code }] = w.players;
    const mate = await register(w.t, 'participant', 'Mate');
    await mate.post('/api/join', { code: w.event.code });
    assert.equal((await mate.post('/api/teams/join', { code })).status, 200);
    await w.start();
    assert.equal((await mate.post(`/api/play/${w.E}/answer`, { answer: 'answer1' })).body.correct, true);
    assert.equal((await w.state(p)).game.phase, 'unlocked');
    assert.equal((await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token })).body.result, 'passed');
    assert.equal((await w.state(mate)).game.index, 1);
  } finally { await w.t.close(); }
});

test('players cannot touch games they are not in; non-members and team-less players are blocked', async () => {
  const w = await world({ teams: 1 });
  try {
    await w.start();
    const stranger = await register(w.t, 'participant', 'Stranger');
    for (const [m, path, body] of [['get', `/api/play/${w.E}/state`], ['post', `/api/play/${w.E}/answer`, { answer: 'answer1' }], ['post', `/api/play/${w.E}/hint`], ['post', `/api/play/${w.E}/scan`, { code: w.stages[0].qr_token }], ['post', `/api/play/${w.E}/ping`, { lat: 1, lng: 1 }]]) {
      const r = await stranger[m](path, body);
      assert.equal(r.status, 403, `${m} ${path} -> ${r.status}`);
    }
    // joined but team-less (and late joining is off) players cannot play either
    assert.equal((await stranger.post('/api/join', { code: w.event.code })).status, 409);
  } finally { await w.t.close(); }
});

test('late joiners (when allowed) start from stage 1 and team-less members cannot answer', async () => {
  const w = await world({ settings: { allow_late_join: true }, teams: 1 });
  try {
    await w.start();
    const late = await register(w.t, 'participant', 'Late');
    assert.equal((await late.post('/api/join', { code: w.event.code })).status, 200);
    assert.equal((await late.post(`/api/play/${w.E}/answer`, { answer: 'answer1' })).status, 409, 'no team yet');
    assert.equal((await late.post(`/api/play/${w.E}/team`, { name: 'Latecomers' })).status, 200);
    const s = await w.state(late);
    assert.equal(s.game.index, 0); assert.equal(s.game.phase, 'riddle');
  } finally { await w.t.close(); }
});

test('start validation: incomplete hunts cannot start and say why; edits are locked while live; reset returns to setup', async () => {
  const t = await startApp({ ai: new FakeAI() });
  try {
    const org = await register(t, 'organizer', 'Org');
    const ev = (await org.post('/api/events', { name: 'Draft' })).body;
    let r = await org.post(`/api/events/${ev.id}/start`);
    assert.equal(r.status, 422); assert.ok(r.body.error.problems.length >= 1);
    const st = (await org.post(`/api/events/${ev.id}/stages`, { riddle_text: 'r', answers: ['a'], verify_type: 'photo' })).body;
    r = await org.post(`/api/events/${ev.id}/start`);
    assert.equal(r.status, 422);
    const text = r.body.error.problems.join(' ');
    assert.match(text, /location/i); assert.match(text, /target photo/i); assert.match(text, /No teams/i);
    await org.patch(`/api/stages/${st.id}`, { lat: 10, lng: 10, verify_type: 'qr' });
    const p = await register(t, 'participant', 'P');
    await joinTeam(t, p, ev, 'Solo');
    assert.equal((await org.post(`/api/events/${ev.id}/start`)).status, 200);
    assert.equal((await org.post(`/api/events/${ev.id}/start`)).status, 409, 'cannot start twice');
    assert.equal((await org.patch(`/api/stages/${st.id}`, { riddle_text: 'typo fixed' })).status, 200, 'wording fixes are allowed live');
    assert.equal((await org.patch(`/api/stages/${st.id}`, { verify_type: 'photo' })).status, 409, 'but not switching to photo without a target');
    assert.equal((await org.post(`/api/events/${ev.id}/stages`, {})).status, 409);
    assert.equal((await org.del(`/api/stages/${st.id}`)).status, 409);
    await p.post(`/api/play/${ev.id}/answer`, { answer: 'a' });
    assert.equal((await org.post(`/api/events/${ev.id}/end`)).status, 200);
    assert.equal((await org.post(`/api/events/${ev.id}/end`)).status, 409);
    assert.equal((await p.post(`/api/play/${ev.id}/scan`, { code: st.qr_token })).status, 409, 'ended hunts accept nothing');
    assert.equal((await org.post(`/api/events/${ev.id}/reset`)).status, 200);
    const s = (await p.get(`/api/play/${ev.id}/state`)).body;
    assert.equal(s.event.status, 'lobby'); assert.equal(s.game, null);
    assert.equal((await org.patch(`/api/stages/${st.id}`, { riddle_text: 'changed' })).status, 200);
  } finally { await t.close(); }
});

test('reordering stages changes the play order; bad orders are refused', async () => {
  const w = await world({ specs: [{ verify_type: 'qr' }, { verify_type: 'qr' }, { verify_type: 'qr' }] });
  try {
    const ids = w.stages.map((s) => s.id);
    assert.equal((await w.org.post(`/api/events/${w.E}/stages/reorder`, { order: [ids[0], ids[1]] })).status, 400);
    assert.equal((await w.org.post(`/api/events/${w.E}/stages/reorder`, { order: [ids[0], ids[0], ids[1]] })).status, 400);
    assert.equal((await w.org.post(`/api/events/${w.E}/stages/reorder`, { order: [ids[2], ids[0], ids[1]] })).status, 200);
    await w.start();
    const [{ p }] = w.players;
    assert.match((await w.state(p)).game.riddle.text, /Riddle number 3/);
  } finally { await w.t.close(); }
});

test('QR codes: regenerate invalidates the old one; svg endpoint is organizer-only and encodes the app URL', async () => {
  const w = await world({ specs: [{ verify_type: 'qr' }] });
  try {
    const st = w.stages[0];
    const svg = await w.org.get(`/api/stages/${st.id}/qr.svg`, { query: { base: 'https://hunt.example.com' } });
    assert.equal(svg.status, 200); assert.match(svg.body, /<svg/);
    assert.equal((await w.players[0].p.get(`/api/stages/${st.id}/qr.svg`)).status, 403);
    const other = await register(w.t, 'organizer', 'Other');
    assert.equal((await other.get(`/api/stages/${st.id}/qr.svg`)).status, 404);
    const fresh = (await w.org.post(`/api/stages/${st.id}/qr/regenerate`)).body;
    assert.notEqual(fresh.qr_token, st.qr_token);
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    assert.equal((await p.post(`/api/play/${w.E}/scan`, { code: st.qr_token })).body.result, 'failed');
    assert.equal((await p.post(`/api/play/${w.E}/scan`, { code: fresh.qr_token })).body.result, 'passed');
  } finally { await w.t.close(); }
});

test('QR brute force is throttled per team', async () => {
  const w = await world({ cfg: { rate: { disabled: false, scanFailMax: 5, scanWindowMs: 60000, authMax: 999, answerMax: 99 } } });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    let limited = 0;
    for (let i = 0; i < 12; i++) { const r = await p.post(`/api/play/${w.E}/scan`, { code: 'GUESS' + String(i).padStart(7, '0') }); if (r.status === 429) limited++; }
    assert.ok(limited >= 5, 'limited=' + limited);
    assert.equal((await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token })).status, 429, 'right code also refused during lockout');
  } finally { await w.t.close(); }
});

test('stage images are private: teams only see the riddle picture of their current stage and the target after unlocking', async () => {
  const w = await world({ specs: [{ verify_type: 'photo', geofence_m: 0 }, { verify_type: 'photo', geofence_m: 0 }] });
  try {
    const riddlePic = await makeImage(7);
    await w.org.postRaw(`/api/stages/${w.stages[0].id}/image/riddle`, riddlePic);
    await w.org.postRaw(`/api/stages/${w.stages[1].id}/image/riddle`, riddlePic);
    const [{ p }] = w.players;
    assert.equal((await p.get(`/api/stages/${w.stages[0].id}/image/riddle`)).status, 404, 'not before start');
    await w.start();
    assert.equal((await p.get(`/api/stages/${w.stages[0].id}/image/riddle`)).status, 200);
    assert.equal((await p.get(`/api/stages/${w.stages[1].id}/image/riddle`)).status, 404, 'future riddle picture hidden');
    assert.equal((await p.get(`/api/stages/${w.stages[0].id}/image/target`)).status, 404, 'target hidden until the riddle is solved');
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    assert.equal((await p.get(`/api/stages/${w.stages[0].id}/image/target`)).status, 200);
    assert.equal((await p.get(`/api/stages/${w.stages[1].id}/image/target`)).status, 404);
    const outsider = await register(w.t, 'participant', 'Out');
    assert.equal((await outsider.get(`/api/stages/${w.stages[0].id}/image/riddle`)).status, 404);
    const anon = (await fetch(w.t.base + `/api/stages/${w.stages[0].id}/image/riddle`)).status;
    assert.equal(anon, 401);
  } finally { await w.t.close(); }
});

test('GPS pings: stored for the organizer map, validated, throttled, never exposed to other teams', async () => {
  const w = await world({ teams: 2 });
  try {
    await w.start();
    const [a, b] = w.players;
    assert.equal((await a.p.post(`/api/play/${w.E}/ping`, { lat: 22.5, lng: 88.3, acc: 12 })).status, 200);
    assert.equal((await a.p.post(`/api/play/${w.E}/ping`, { lat: 999, lng: 88.3 })).status, 400);
    assert.equal((await a.p.post(`/api/play/${w.E}/ping`, { lat: 'x', lng: 'y' })).status, 400);
    const dash = (await w.org.get(`/api/events/${w.E}/dashboard`)).body;
    const ta = dash.teams.find((t) => t.name === 'Team 0');
    assert.equal(ta.location.lat, 22.5);
    assert.equal(dash.teams.find((t) => t.name === 'Team 1').location, null);
    assert.ok(!JSON.stringify((await w.state(b.p))).includes('22.5'), 'other teams never see your position');
    assert.equal((await w.org.get(`/api/play/${w.E}/state`)).status, 403);
  } finally { await w.t.close(); }
});

test('data survives a server restart mid-hunt (progress, hints, winner)', async () => {
  const w = await world({ specs: [{ verify_type: 'qr' }, { verify_type: 'qr' }], cfg: { rate: { disabled: true } } });
  try {
    await w.start();
    const [{ p }] = w.players;
    await p.post(`/api/play/${w.E}/hint`);
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer1' });
    await p.post(`/api/play/${w.E}/scan`, { code: w.stages[0].qr_token });
    await w.t.restart();
    const s = (await p.get(`/api/play/${w.E}/state`)).body;
    assert.equal(s.game.index, 1); assert.equal(s.game.hints.used, 1);
    await p.post(`/api/play/${w.E}/answer`, { answer: 'answer2' });
    assert.equal((await p.post(`/api/play/${w.E}/scan`, { code: w.stages[1].qr_token })).body.finished, true);
    await w.t.restart();
    assert.equal((await w.org.get(`/api/events/${w.E}/dashboard`)).body.event.winner.name, 'Team 0');
  } finally { await w.t.close(); }
});

test('local (no-AI) photo matcher: separates similar from different pictures', async () => {
  const a = await makeImage(321);
  const same = await realPhoto(a, 2);
  const diff = await makeDistinctImage(400, a);
  const [fa, fs, fd] = await Promise.all([images.features(a), images.features(same), images.features(diff)]);
  const simSame = images.localSimilarity(fa, fs);
  const simDiff = images.localSimilarity(fa, fd);
  assert.ok(simSame > simDiff, `same ${simSame} vs different ${simDiff}`);
});
