'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, register, buildEvent, joinTeam } = require('./helpers');

describe('events', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  test('create, list, rename; only the owner can see or change it', async () => {
    const a = await register(t, 'organizer', 'orgA');
    const b = await register(t, 'organizer', 'orgB');
    const ev = await a.post('/api/events', { name: '  Campus   Hunt  ' });
    assert.equal(ev.status, 200);
    assert.equal(ev.body.name, 'Campus Hunt');
    assert.match(ev.body.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(ev.body.status, 'lobby');
    assert.equal(ev.body.settings.match_threshold, 85);
    assert.equal(ev.body.settings.max_hints, 3);

    assert.equal((await a.get('/api/events')).body.events.length, 1);
    assert.equal((await b.get('/api/events')).body.events.length, 0);

    assert.equal((await b.get(`/api/events/${ev.body.id}/dashboard`)).status, 404);
    assert.equal((await b.patch(`/api/events/${ev.body.id}`, { name: 'Hijack' })).status, 404);
    assert.equal((await b.del(`/api/events/${ev.body.id}`)).status, 404);
    assert.equal((await b.post(`/api/events/${ev.body.id}/start`)).status, 404);

    const renamed = await a.patch(`/api/events/${ev.body.id}`, { name: 'Renamed' });
    assert.equal(renamed.body.name, 'Renamed');
  });

  test('names are validated', async () => {
    const a = await register(t, 'organizer');
    for (const name of ['', ' ', 'x', undefined, '\u0000​']) {
      assert.equal((await a.post('/api/events', { name })).status, 400, String(name));
    }
    const long = await a.post('/api/events', { name: 'n'.repeat(500) });
    assert.equal(long.body.name.length, 80);
  });

  test('event codes are unique across many events', async () => {
    const a = await register(t, 'organizer');
    const codes = new Set();
    for (let i = 0; i < 40; i++) codes.add((await a.post('/api/events', { name: `Event ${i}` })).body.code);
    assert.equal(codes.size, 40);
  });

  test('settings: validated and clamped to sane ranges', async () => {
    const a = await register(t, 'organizer');
    const ok = await a.post('/api/events', { name: 'Tuned', settings: { match_threshold: 90, review_min: 70, max_hints: 5, team_max: 3, show_leaderboard: false } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.team_max, 3);
    assert.equal(ok.body.settings.show_leaderboard, false);
    const bads = [
      { team_max: 5 }, { team_max: 0 }, { max_hints: -1 }, { max_hints: 99 }, { match_threshold: 20 },
      { match_threshold: 60, review_min: 80 }, { allow_review: 'yes' }, { match_threshold: 85.5 },
    ];
    for (const settings of bads) {
      const r = await a.post('/api/events', { name: 'Bad', settings });
      assert.equal(r.status, 400, JSON.stringify(settings));
    }
  });

  test('joining: code is case/space/dash insensitive; unknown codes 404', async () => {
    const a = await register(t, 'organizer');
    const p = await register(t, 'participant');
    const ev = (await a.post('/api/events', { name: 'Join me' })).body;
    const messy = ` ${ev.code.slice(0, 3).toLowerCase()}-${ev.code.slice(3).toLowerCase()} `;
    const j = await p.post('/api/join', { code: messy });
    assert.equal(j.status, 200);
    assert.equal(j.body.event_id, ev.id);
    // idempotent
    assert.equal((await p.post('/api/join', { code: ev.code })).status, 200);
    assert.equal((await p.get('/api/my/events')).body.events.length, 1);
    for (const code of ['ZZZZZZ', '', null, undefined, 123, "'; DROP TABLE events;--"]) {
      const r = await p.post('/api/join', { code });
      assert.equal(r.status, 404, String(code));
    }
  });

  test('a participant who has not joined cannot read event state', async () => {
    const a = await register(t, 'organizer');
    const p = await register(t, 'participant');
    const ev = (await a.post('/api/events', { name: 'Private' })).body;
    const r = await p.get(`/api/play/${ev.id}/state`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'not_joined');
  });

  test('ids that are not positive integers are 404, never 500', async () => {
    const a = await register(t, 'organizer');
    const p = await register(t, 'participant');
    for (const id of ['abc', '-1', '0', '1.5', '99999999999999', '1e3', '%00', "1'OR'1"]) {
      assert.equal((await a.get(`/api/events/${encodeURIComponent(id)}/dashboard`)).status, 404, id);
      assert.equal((await a.patch(`/api/stages/${encodeURIComponent(id)}`, {})).status, 404, id);
      assert.equal((await p.get(`/api/play/${encodeURIComponent(id)}/state`)).status, 404, id);
    }
  });

  test('deleting an event removes its teams, stages and join code', async () => {
    const a = await register(t, 'organizer');
    const p = await register(t, 'participant');
    const { event } = await buildEvent(a, [{}]);
    await joinTeam(t, p, event, 'Doomed');
    assert.equal((await a.del(`/api/events/${event.id}`)).status, 200);
    assert.equal((await p.get(`/api/play/${event.id}/state`)).status, 404);
    assert.equal((await p.post('/api/join', { code: event.code })).status, 404);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', event.id).n, 0);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM stages WHERE event_id = ?', event.id).n, 0);
  });

  test('ended events cannot be joined by newcomers; started ones need allow_late_join', async () => {
    const a = await register(t, 'organizer');
    const early = await register(t, 'participant');
    const late = await register(t, 'participant');
    const { event } = await buildEvent(a, [{}]);
    await joinTeam(t, early, event, 'Early Birds');
    assert.equal((await a.post(`/api/events/${event.id}/start`)).status, 200);
    const refused = await late.post('/api/join', { code: event.code });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'event_started');
    assert.equal((await a.patch(`/api/events/${event.id}`, { settings: { allow_late_join: true } })).status, 200);
    assert.equal((await late.post('/api/join', { code: event.code })).status, 200);
    assert.equal((await a.post(`/api/events/${event.id}/end`)).status, 200);
    const third = await register(t, 'participant');
    const gone = await third.post('/api/join', { code: event.code });
    assert.equal(gone.status, 409);
    assert.equal(gone.body.error.code, 'event_ended');
  });
});

describe('teams', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  async function lobby(n = 1) {
    const org = await register(t, 'organizer');
    const { event } = await buildEvent(org, Array.from({ length: n }, () => ({})));
    return { org, event };
  }

  test('create a team, share its code, teammates join', async () => {
    const { event } = await lobby();
    const [a, b] = [await register(t, 'participant', 'Ann'), await register(t, 'participant', 'Bob')];
    const { code } = await joinTeam(t, a, event, 'Red Foxes');
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    const j = await b.post('/api/teams/join', { code: code.toLowerCase() });
    assert.equal(j.status, 200);
    const st = (await a.get(`/api/play/${event.id}/state`)).body;
    assert.deepEqual(st.team.members.map((m) => m.display_name), ['Ann', 'Bob']);
    assert.equal(st.team.max, 4);
    // joining by team code also joined Bob to the event
    assert.equal((await b.get(`/api/play/${event.id}/state`)).status, 200);
  });

  test('team names: unique per event (case-insensitive), validated, sanitised', async () => {
    const { event } = await lobby();
    const [a, b, c] = [await register(t, 'participant'), await register(t, 'participant'), await register(t, 'participant')];
    await joinTeam(t, a, event, 'Falcons');
    await b.post('/api/join', { code: event.code });
    const dup = await b.post(`/api/play/${event.id}/team`, { name: 'fAlCoNs' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'team_name_taken');
    for (const name of ['', 'x', ' ', undefined, '​​']) {
      assert.equal((await b.post(`/api/play/${event.id}/team`, { name })).status, 400, String(name));
    }
    const xss = await b.post(`/api/play/${event.id}/team`, { name: '<img src=x onerror=alert(1)>' });
    assert.equal(xss.status, 200);
    const st = (await b.get(`/api/play/${event.id}/state`)).body;
    assert.equal(st.team.name, '<img src=x onerror=alert(1)>', 'stored verbatim as text; the UI must escape it');
    await c.post('/api/join', { code: event.code });
    const long = await c.post(`/api/play/${event.id}/team`, { name: 'L'.repeat(200) });
    assert.equal(long.status, 200);
    assert.equal((await c.get(`/api/play/${event.id}/state`)).body.team.name.length, 30);
  });

  test('a team holds at most 4 members', async () => {
    const { event } = await lobby();
    const players = [];
    for (let i = 0; i < 6; i++) players.push(await register(t, 'participant'));
    const { code } = await joinTeam(t, players[0], event, 'Full House');
    for (let i = 1; i < 4; i++) assert.equal((await players[i].post('/api/teams/join', { code })).status, 200);
    const fifth = await players[4].post('/api/teams/join', { code });
    assert.equal(fifth.status, 409);
    assert.equal(fifth.body.error.code, 'team_full');
    assert.equal((await players[0].get(`/api/play/${event.id}/state`)).body.team.members.length, 4);
  });

  test('concurrent joins never exceed the team cap', async () => {
    const { event } = await lobby();
    const players = [];
    for (let i = 0; i < 12; i++) players.push(await register(t, 'participant'));
    const { code } = await joinTeam(t, players[0], event, 'Stampede');
    const results = await Promise.all(players.slice(1).map((p) => p.post('/api/teams/join', { code })));
    const ok = results.filter((r) => r.status === 200).length;
    const full = results.filter((r) => r.status === 409 && r.body.error.code === 'team_full').length;
    assert.equal(ok, 3, 'exactly 3 joiners fit beside the leader');
    assert.equal(full, 8);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM team_members WHERE event_id = ?', event.id).n, 4);
  });

  test('one team per player per event; same player may play different events', async () => {
    const { event: e1 } = await lobby();
    const { event: e2 } = await lobby();
    const p = await register(t, 'participant');
    const q = await register(t, 'participant');
    await joinTeam(t, p, e1, 'Alpha');
    const second = await p.post(`/api/play/${e1.id}/team`, { name: 'Beta' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'already_in_team');
    const { code } = await joinTeam(t, q, e1, 'Gamma');
    const hop = await p.post('/api/teams/join', { code });
    assert.equal(hop.status, 409);
    assert.equal(hop.body.error.code, 'already_in_team');
    assert.equal((await joinTeam(t, p, e2, 'Alpha')).teamId > 0, true); // same name, different event: fine
    assert.equal((await p.get('/api/my/events')).body.events.length, 2);
  });

  test('joining your own team again is a harmless no-op', async () => {
    const { event } = await lobby();
    const p = await register(t, 'participant');
    const { code } = await joinTeam(t, p, event, 'Loopers');
    assert.equal((await p.post('/api/teams/join', { code })).status, 200);
    assert.equal((await p.get(`/api/play/${event.id}/state`)).body.team.members.length, 1);
  });

  test('bad team codes', async () => {
    const p = await register(t, 'participant');
    for (const code of ['NOPE12', '', null, 42, '%%%']) {
      assert.equal((await p.post('/api/teams/join', { code })).status, 404, String(code));
    }
  });

  test('leaving: leadership passes on, empty teams disappear, lobby only', async () => {
    const { org, event } = await lobby();
    const [a, b] = [await register(t, 'participant'), await register(t, 'participant')];
    const { code } = await joinTeam(t, a, event, 'Leavers');
    await b.post('/api/teams/join', { code });
    assert.equal((await a.post(`/api/play/${event.id}/team/leave`)).status, 200);
    const st = (await b.get(`/api/play/${event.id}/state`)).body;
    assert.equal(st.team.leader_id, b.user.id);
    assert.equal(st.team.members.length, 1);
    assert.equal((await b.post(`/api/play/${event.id}/team/leave`)).status, 200);
    assert.equal((await a.post('/api/teams/join', { code })).status, 404, 'empty team was removed');
    // a free player can rejoin / create again
    assert.equal((await a.post(`/api/play/${event.id}/team`, { name: 'Round Two' })).status, 200);
    // after the start nobody may leave
    await joinTeam(t, b, event, 'Stayers');
    assert.equal((await org.post(`/api/events/${event.id}/start`)).status, 200);
    const stuck = await b.post(`/api/play/${event.id}/team/leave`);
    assert.equal(stuck.status, 409);
    assert.equal(stuck.body.error.code, 'event_started');
  });

  test('team_max setting is honoured', async () => {
    const org = await register(t, 'organizer');
    const { event } = await buildEvent(org, [{}], { settings: { team_max: 2 } });
    const [a, b, c] = [await register(t, 'participant'), await register(t, 'participant'), await register(t, 'participant')];
    const { code } = await joinTeam(t, a, event, 'Duo');
    assert.equal((await b.post('/api/teams/join', { code })).status, 200);
    assert.equal((await c.post('/api/teams/join', { code })).body.error.code, 'team_full');
  });

  test('teams are locked once the hunt starts (unless late join is on)', async () => {
    const { org, event } = await lobby();
    const [a, b, c] = [await register(t, 'participant'), await register(t, 'participant'), await register(t, 'participant')];
    const { code } = await joinTeam(t, a, event, 'First');
    await b.post('/api/join', { code: event.code });
    await org.post(`/api/events/${event.id}/start`);
    assert.equal((await b.post(`/api/play/${event.id}/team`, { name: 'Latecomers' })).body.error.code, 'event_started');
    assert.equal((await b.post('/api/teams/join', { code })).body.error.code, 'event_started');
    await org.patch(`/api/events/${event.id}`, { settings: { allow_late_join: true } });
    assert.equal((await b.post('/api/teams/join', { code })).status, 200);
    assert.equal((await c.post('/api/join', { code: event.code })).status, 200);
    assert.equal((await c.post(`/api/play/${event.id}/team`, { name: 'Late Crew' })).status, 200);
    const st = (await c.get(`/api/play/${event.id}/state`)).body;
    assert.equal(st.game.index, 0, 'late team starts at the first riddle');
  });
});
