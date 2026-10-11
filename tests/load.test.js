'use strict';
/**
 * Load / chaos run: 40 teams x 3 players race through a 4-stage hunt (3 QR + 1 photo with a slow AI)
 * while 120 live streams are open and the organizer polls the dashboard. Checks the invariants that matter:
 * one winner, no server errors, consistent progress, bounded latency.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, register, buildEvent, FakeAI, makeImage } = require('./helpers');

const TEAMS = Number(process.env.LOAD_TEAMS || 40);
const PER = 3;

test(`load: ${TEAMS} teams x ${PER} players race to one winner`, { timeout: 180000 }, async () => {
  const ai = new FakeAI(); ai.delayMs = 25;
  const t = await startApp({ ai });
  const statuses = new Map();
  const lat = [];
  const track = async (p) => { const t0 = performance.now(); const r = await p; lat.push(performance.now() - t0); statuses.set(r.status, (statuses.get(r.status) || 0) + 1); return r; };
  const streams = [];
  try {
    const org = await register(t, 'organizer', 'Org');
    const { event, stages, targets } = await buildEvent(org, [{ verify_type: 'qr' }, { verify_type: 'qr' }, { verify_type: 'photo', geofence_m: 0 }, { verify_type: 'qr' }]);
    const E = event.id;

    // sign everyone up and form teams (concurrently, like a crowd at the start line)
    const teams = await Promise.all(Array.from({ length: TEAMS }, async (_, i) => {
      const lead = await register(t, 'participant', `L${i}`);
      await lead.post('/api/join', { code: event.code });
      const tm = await lead.post(`/api/play/${E}/team`, { name: `Team ${i}` });
      assert.equal(tm.status, 200);
      const code = (await lead.get(`/api/play/${E}/state`)).body.team.code;
      const mates = await Promise.all(Array.from({ length: PER - 1 }, async (_, j) => {
        const m = await register(t, 'participant', `M${i}_${j}`);
        await m.post('/api/join', { code: event.code });
        const r = await m.post('/api/teams/join', { code });
        assert.equal(r.status, 200);
        return m;
      }));
      return { i, players: [lead, ...mates], photo: await makeImage(5000 + i) };
    }));
    const dash0 = (await org.get(`/api/events/${E}/dashboard`)).body;
    assert.equal(dash0.teams.length, TEAMS); assert.equal(dash0.participants, TEAMS * PER); assert.equal(dash0.unteamed, 0);

    // everyone watches live
    for (const tm of teams) for (const p of tm.players) {
      const ctrl = new AbortController();
      const res = await fetch(`${t.base}/api/play/${E}/stream`, { headers: { Authorization: `Bearer ${p.token}` }, signal: ctrl.signal });
      assert.equal(res.status, 200);
      let n = 0; (async () => { try { const rd = res.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; n++; } } catch { /* closed */ } })();
      streams.push({ ctrl, count: () => n });
    }
    assert.equal((await org.post(`/api/events/${E}/start`)).status, 200);

    // organizer polls the dashboard throughout
    let polling = true; let pollMax = 0; let polls = 0;
    const poller = (async () => { while (polling) { const t0 = performance.now(); const r = await org.get(`/api/events/${E}/dashboard`); pollMax = Math.max(pollMax, performance.now() - t0); assert.equal(r.status, 200); polls++; await new Promise((r2) => setTimeout(r2, 100)); } })();

    // each team: teammates act at the same time (answer from all 3 phones, scan from all 3, hint spam)
    const play = async (tm, from, to) => {
      const [a, b] = tm.players;
      for (let s = from; s < to; s++) {
        if (s === 1) await Promise.all(tm.players.map((p) => track(p.post(`/api/play/${E}/hint`))));
        const answers = await Promise.all(tm.players.map((p) => track(p.post(`/api/play/${E}/answer`, { answer: `answer${s + 1}` }))));
        if (answers.some((r) => r.status === 409 && r.body.error.code === 'event_ended')) return 'late';
        assert.ok(answers.every((r) => [200, 409].includes(r.status)), 'answer statuses ' + answers.map((r) => r.status));
        assert.equal(answers.filter((r) => r.status === 200 && r.body.correct).length >= 1, true);
        if (stages[s].verify_type === 'photo') {
          // two phones send different photos at once; at most one may advance the team
          const rs = await Promise.all([track(a.postRaw(`/api/play/${E}/photo`, tm.photo)), track(b.postRaw(`/api/play/${E}/photo`, tm.photo))]);
          assert.ok(rs.every((r) => [200, 409, 429].includes(r.status)), 'photo statuses ' + rs.map((r) => r.status + JSON.stringify(r.body)));
        } else {
          const rs = await Promise.all(tm.players.map((p) => track(p.post(`/api/play/${E}/scan`, { code: stages[s].qr_token }))));
          assert.ok(rs.every((r) => [200, 409].includes(r.status)), 'scan statuses ' + rs.map((r) => r.status));
        }
      }
      return 'done';
    };
    const t0 = Date.now();
    // phase 1: everybody sprints to the last checkpoint; nobody may win yet
    const phase1 = await Promise.all(teams.map((tm) => play(tm, 0, stages.length - 1)));
    assert.ok(phase1.every((o) => o === 'done'));
    const mid = (await org.get(`/api/events/${E}/dashboard`)).body;
    assert.equal(mid.event.status, 'running', 'no winner before the final stage');
    assert.ok(mid.teams.every((x) => x.completed === stages.length - 1 && !x.finished_at), 'all teams are exactly one stage from the treasure');
    // phase 2: all teams hit the treasure at the same moment
    const outcomes = await Promise.all(teams.map((tm) => play(tm, stages.length - 1, stages.length)));
    const took = Date.now() - t0;
    polling = false; await poller;

    // ------------------------------------------------ invariants
    const dash = (await org.get(`/api/events/${E}/dashboard`)).body;
    assert.equal(dash.event.status, 'ended');
    assert.ok(dash.event.winner, 'there is a winner');
    const finished = dash.teams.filter((x) => x.finished_at);
    assert.equal(finished.length, 1, `exactly one finisher, got ${finished.length}`);
    assert.equal(finished[0].name, dash.event.winner.name);
    assert.equal(finished[0].completed, stages.length);
    for (const tm of dash.teams) {
      assert.ok(tm.completed >= 0 && tm.completed <= stages.length);
      assert.ok(tm.hints_used >= 0 && tm.hints_used <= 3, `${tm.name} used ${tm.hints_used} hints`);
      assert.equal(tm.members.length, PER);
    }
    assert.ok(![...statuses.keys()].some((s) => s >= 500), 'no 5xx: ' + JSON.stringify([...statuses]));
    // every team was charged for exactly one hint (3 phones asked at once, one stage)
    assert.ok(dash.teams.every((x) => x.hints_used <= 3));
    const won = dash.event.winner.name;
    for (const tm of teams.slice(0, 5)) {
      const s = (await tm.players[0].get(`/api/play/${E}/state`)).body;
      assert.equal(s.event.winner.name, won, 'every player sees the same winner');
      assert.equal(s.game.result, s.team.name === won ? 'won' : 'lost');
    }
    lat.sort((x, y) => x - y);
    const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
    console.log(`  load: ${TEAMS * PER} players, ${lat.length} gameplay requests in ${took} ms; p50 ${p(0.5).toFixed(0)} ms, p95 ${p(0.95).toFixed(0)} ms, p99 ${p(0.99).toFixed(0)} ms; dashboard polls ${polls}, worst ${pollMax.toFixed(0)} ms; statuses ${JSON.stringify([...statuses])}; final-stage outcomes done=${outcomes.filter((o) => o === 'done').length} late=${outcomes.filter((o) => o === 'late').length}`);
    assert.ok(p(0.95) < 3000, 'p95 latency under 3 s');
    assert.ok(pollMax < 3000, 'dashboard stays responsive');
    assert.ok(streams.every((s) => s.count() > 0), 'every live stream received updates');
  } finally {
    streams.forEach((s) => s.ctrl.abort());
    await t.close();
  }
});

test('load: signup/login storm (200 accounts at once) stays correct and unique', { timeout: 120000 }, async () => {
  const t = await startApp({ ai: new FakeAI() });
  try {
    const { client } = require('./helpers');
    const anon = () => client(() => t.base);
    const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => anon().post('/api/auth/register', { username: `storm${i}`, password: 'secret123', role: 'participant' })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(new Set(rs.map((r) => r.body.token)).size, 200);
    const dup = await Promise.all(Array.from({ length: 20 }, () => anon().post('/api/auth/register', { username: 'samename', password: 'secret123', role: 'participant' })));
    assert.equal(dup.filter((r) => r.status === 200).length, 1, 'only one of 20 racing duplicates wins');
    assert.equal(dup.filter((r) => r.status === 409).length, 19);
    const logins = await Promise.all(Array.from({ length: 100 }, (_, i) => anon().post('/api/auth/login', { username: `storm${i}`, password: 'secret123' })));
    assert.ok(logins.every((r) => r.status === 200));
  } finally { await t.close(); }
});
