'use strict';
const {
  HttpError, badRequest, forbidden, notFound, conflict, tooMany,
  randomCode, normalizeCode, cleanText, answerMatches, normalizeAnswer, haversineM, safeEqual,
} = require('../util');
const { AIUnavailable, hintLeaks } = require('./ai');
const images = require('./images');

const DEFAULT_SETTINGS = Object.freeze({
  match_threshold: 85,
  review_min: 60,
  allow_review: true,
  show_leaderboard: true,
  allow_late_join: false,
  max_hints: 3,
  team_max: 4,
});

const parseId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 31) throw notFound('Not found');
  return n;
};
const asInt = (v, name, min, max) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest('invalid_' + name, `${name} must be a whole number between ${min} and ${max}`);
  return n;
};
const asBool = (v, name) => {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return Boolean(v);
  throw badRequest('invalid_' + name, `${name} must be true or false`);
};
const isUnique = (e) => e && /UNIQUE constraint failed/i.test(String(e.message));

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function parseAnswers(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/\r?\n|\|/);
  const out = [];
  const seen = new Set();
  for (const a of arr) {
    const t = cleanText(a, 120);
    const n = normalizeAnswer(t);
    if (!t || !n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
  }
  if (out.length > 10) throw badRequest('too_many_answers', 'At most 10 accepted answers per riddle');
  return out;
}

function parseHints(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/\r?\n/);
  const out = arr.map((h) => cleanText(h, 200)).filter(Boolean);
  if (out.length > 3) throw badRequest('too_many_hints', 'At most 3 written hints per riddle');
  return out;
}

class Game {
  constructor({ db, cfg, ai, store, hub, rate }) {
    this.db = db;
    this.cfg = cfg;
    this.ai = ai;
    this.store = store;
    this.hub = hub;
    this.rate = rate;
    this.inflight = new Set();
  }

  // ------------------------------------------------------------------ helpers
  now() {
    return Date.now();
  }
  settingsOf(event) {
    return { ...DEFAULT_SETTINGS, ...parseJson(event.settings, {}) };
  }
  normalizeSettings(input, current = DEFAULT_SETTINGS) {
    const s = { ...current };
    const src = input && typeof input === 'object' ? input : {};
    if (src.match_threshold !== undefined) s.match_threshold = asInt(src.match_threshold, 'match_threshold', 50, 100);
    if (src.review_min !== undefined) s.review_min = asInt(src.review_min, 'review_min', 0, 99);
    if (src.allow_review !== undefined) s.allow_review = asBool(src.allow_review, 'allow_review');
    if (src.show_leaderboard !== undefined) s.show_leaderboard = asBool(src.show_leaderboard, 'show_leaderboard');
    if (src.allow_late_join !== undefined) s.allow_late_join = asBool(src.allow_late_join, 'allow_late_join');
    if (src.max_hints !== undefined) s.max_hints = asInt(src.max_hints, 'max_hints', 0, 10);
    if (src.team_max !== undefined) s.team_max = asInt(src.team_max, 'team_max', 1, this.cfg.game.teamMax);
    if (s.review_min >= s.match_threshold) throw badRequest('invalid_review_min', 'review_min must be lower than match_threshold');
    return s;
  }

  _event(id) {
    const e = this.db.get('SELECT * FROM events WHERE id = ?', id);
    if (!e) throw notFound('Event not found');
    return e;
  }
  _orgEvent(user, eventId) {
    const e = this.db.get('SELECT * FROM events WHERE id = ? AND organizer_id = ?', parseId(eventId), user.id);
    if (!e) throw notFound('Event not found');
    return e;
  }
  _orgStage(user, stageId) {
    const s = this.db.get(
      'SELECT s.* FROM stages s JOIN events e ON e.id = s.event_id WHERE s.id = ? AND e.organizer_id = ?',
      parseId(stageId), user.id,
    );
    if (!s) throw notFound('Stage not found');
    return s;
  }
  stages(eventId) {
    return this.db.all('SELECT * FROM stages WHERE event_id = ? ORDER BY position', eventId);
  }
  _stageAt(eventId, pos) {
    return this.db.get('SELECT * FROM stages WHERE event_id = ? AND position = ?', eventId, pos);
  }
  _count(table, where, ...p) {
    return this.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...p).n;
  }
  _teamOf(userId, eventId) {
    return this.db.get(
      'SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? AND m.event_id = ?',
      userId, eventId,
    );
  }
  _membersOf(teamId) {
    return this.db.all(
      'SELECT u.id, u.display_name FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.joined_at, u.id',
      teamId,
    );
  }
  _requireMember(user, event) {
    const m = this.db.get('SELECT 1 AS ok FROM event_members WHERE event_id = ? AND user_id = ?', event.id, user.id);
    if (!m) throw forbidden('Join this event with its code first', 'not_joined');
  }
  _playCtx(user, eventId, { needTeam = true } = {}) {
    const event = this._event(parseId(eventId));
    this._requireMember(user, event);
    const team = this._teamOf(user.id, event.id);
    if (needTeam && !team) throw conflict('no_team', 'Join or create a team first');
    return { event, team };
  }
  _requireRunning(event) {
    if (event.status === 'lobby') throw conflict('not_started', 'The hunt has not started yet');
    if (event.status === 'ended') throw conflict('event_ended', 'This hunt has ended');
  }
  _completed(team, total) {
    return team.phase === 'done' ? total : team.stage_pos;
  }

  _log(eventId, teamId, kind, text) {
    const at = this.now();
    const r = this.db.run('INSERT INTO activity (event_id, team_id, kind, text, created_at) VALUES (?,?,?,?,?)', eventId, teamId, kind, text, at);
    const item = { id: Number(r.lastInsertRowid), team_id: teamId, kind, text, created_at: at };
    this.hub.toOrganizers(eventId, { type: 'refresh', activity: item });
    return item;
  }
  _notifyTeam(team, payload = {}) {
    const ids = this._membersOf(team.id).map((m) => m.id);
    this.hub.toUsers(team.event_id, ids, { type: 'refresh', ...payload });
  }
  _notifyEvent(eventId) {
    this.hub.toEventParticipants(eventId, { type: 'refresh', scope: 'event' });
    this.hub.toOrganizers(eventId, { type: 'refresh' });
  }

  // ------------------------------------------------------------------ events (organizer)
  createEvent(user, { name, settings }) {
    const n = cleanText(name, 80);
    if (n.length < 2) throw badRequest('invalid_name', 'Give the event a name (2-80 characters)');
    if (this._count('events', 'organizer_id = ?', user.id) >= this.cfg.limits.maxEventsPerOrganizer) {
      throw conflict('too_many_events', 'Event limit reached - delete an old event first');
    }
    const s = this.normalizeSettings(settings, DEFAULT_SETTINGS);
    for (let i = 0; i < 12; i++) {
      try {
        const r = this.db.run(
          'INSERT INTO events (organizer_id, name, code, status, settings, created_at) VALUES (?,?,?,?,?,?)',
          user.id, n, randomCode(6), 'lobby', JSON.stringify(s), this.now(),
        );
        return this.eventView(this._event(Number(r.lastInsertRowid)));
      } catch (e) {
        if (!isUnique(e)) throw e;
      }
    }
    throw new HttpError(500, 'code_generation_failed', 'Could not allocate an event code');
  }

  eventView(event) {
    const winner = event.winner_team_id ? this.db.get('SELECT id, name FROM teams WHERE id = ?', event.winner_team_id) : null;
    return {
      id: event.id, name: event.name, code: event.code, status: event.status,
      settings: this.settingsOf(event), created_at: event.created_at,
      started_at: event.started_at, ended_at: event.ended_at, winner: winner || null,
    };
  }

  listEvents(user) {
    return this.db
      .all('SELECT * FROM events WHERE organizer_id = ? ORDER BY id DESC', user.id)
      .map((e) => ({
        ...this.eventView(e),
        stage_count: this._count('stages', 'event_id = ?', e.id),
        team_count: this._count('teams', 'event_id = ?', e.id),
      }));
  }

  updateEvent(user, eventId, body) {
    const event = this._orgEvent(user, eventId);
    const patch = body || {};
    let name = event.name;
    if (patch.name !== undefined) {
      name = cleanText(patch.name, 80);
      if (name.length < 2) throw badRequest('invalid_name', 'Give the event a name (2-80 characters)');
    }
    const settings = patch.settings !== undefined ? this.normalizeSettings(patch.settings, this.settingsOf(event)) : this.settingsOf(event);
    if (event.status === 'running' && settings.team_max < this.settingsOf(event).team_max) {
      throw conflict('locked', 'Team size cannot be reduced while the hunt is running');
    }
    this.db.run('UPDATE events SET name = ?, settings = ? WHERE id = ?', name, JSON.stringify(settings), event.id);
    this._notifyEvent(event.id);
    return this.eventView(this._event(event.id));
  }

  deleteEvent(user, eventId) {
    const event = this._orgEvent(user, eventId);
    const files = [
      ...this.db.all('SELECT riddle_image AS f FROM stages WHERE event_id = ? AND riddle_image IS NOT NULL', event.id),
      ...this.db.all('SELECT target_image AS f FROM stages WHERE event_id = ? AND target_image IS NOT NULL', event.id),
      ...this.db.all('SELECT image_file AS f FROM submissions WHERE event_id = ? AND image_file IS NOT NULL', event.id),
    ].map((r) => r.f);
    this.db.run('DELETE FROM events WHERE id = ?', event.id);
    files.forEach((f) => this.store.remove(f));
    this.hub.toEventParticipants(event.id, { type: 'refresh', scope: 'event' });
    return { deleted: true };
  }

  validateEvent(event) {
    const problems = [];
    const stages = this.stages(event.id);
    const s = this.settingsOf(event);
    if (stages.length === 0) problems.push('Add at least one stage (the last stage is the treasure).');
    for (const st of stages) {
      const label = `Stage ${st.position + 1}`;
      if (!st.riddle_text && !st.riddle_image) problems.push(`${label}: write a riddle.`);
      if (parseJson(st.answers, []).length === 0) problems.push(`${label}: add at least one accepted answer.`);
      if (st.lat === null || st.lng === null) problems.push(`${label}: pin its location on the map.`);
      if ((st.verify_type === 'photo' || st.verify_type === 'either') && !st.target_image) {
        problems.push(`${label}: upload the target photo teams must match.`);
      }
      if ((st.verify_type === 'photo' || st.verify_type === 'either') && !images.available()) {
        problems.push(`${label}: photo checks need the image library on the server (sharp).`);
      }
    }
    if (this._count('teams', 'event_id = ?', event.id) === 0 && !s.allow_late_join) {
      problems.push('No teams have joined yet.');
    }
    return problems;
  }

  startEvent(user, eventId) {
    const event = this._orgEvent(user, eventId);
    if (event.status !== 'lobby') throw conflict('bad_state', 'This hunt has already started');
    const problems = this.validateEvent(event);
    if (problems.length) throw new HttpError(422, 'not_ready', 'The hunt is not ready to start', { problems });
    const now = this.now();
    this.db.tx(() => {
      this.db.run(
        "UPDATE teams SET stage_pos = 0, phase = 'riddle', hints_used = 0, wrong_answers = 0, finished_at = NULL, progress_at = ? WHERE event_id = ?",
        now, event.id,
      );
      this.db.run("UPDATE events SET status = 'running', started_at = ?, ended_at = NULL, winner_team_id = NULL WHERE id = ?", now, event.id);
      this._log(event.id, null, 'event', 'The hunt has started!');
    });
    this._notifyEvent(event.id);
    return this.eventView(this._event(event.id));
  }

  endEvent(user, eventId) {
    const event = this._orgEvent(user, eventId);
    if (event.status !== 'running') throw conflict('bad_state', 'The hunt is not running');
    this.db.tx(() => {
      this.db.run("UPDATE events SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'running'", this.now(), event.id);
      this._log(event.id, null, 'event', 'The organizer ended the hunt.');
    });
    this._notifyEvent(event.id);
    return this.eventView(this._event(event.id));
  }

  /** back to the lobby: keeps stages and teams, wipes progress */
  resetEvent(user, eventId) {
    const event = this._orgEvent(user, eventId);
    if (event.status === 'lobby') throw conflict('bad_state', 'Nothing to reset');
    const files = this.db.all('SELECT image_file AS f FROM submissions WHERE event_id = ? AND image_file IS NOT NULL', event.id).map((r) => r.f);
    this.db.tx(() => {
      this.db.run('DELETE FROM submissions WHERE event_id = ?', event.id);
      this.db.run('DELETE FROM hints_issued WHERE team_id IN (SELECT id FROM teams WHERE event_id = ?)', event.id);
      this.db.run('DELETE FROM activity WHERE event_id = ?', event.id);
      this.db.run(
        "UPDATE teams SET stage_pos = 0, phase = 'riddle', hints_used = 0, wrong_answers = 0, finished_at = NULL, progress_at = NULL, last_lat = NULL, last_lng = NULL, last_acc = NULL WHERE event_id = ?",
        event.id,
      );
      this.db.run("UPDATE events SET status = 'lobby', started_at = NULL, ended_at = NULL, winner_team_id = NULL WHERE id = ?", event.id);
    });
    files.forEach((f) => this.store.remove(f));
    this._notifyEvent(event.id);
    return this.eventView(this._event(event.id));
  }

  // ------------------------------------------------------------------ stages (organizer)
  stageView(st) {
    return {
      id: st.id, position: st.position, title: st.title, riddle_text: st.riddle_text,
      answers: parseJson(st.answers, []), hints: parseJson(st.hints, []),
      lat: st.lat, lng: st.lng, location_name: st.location_name,
      verify_type: st.verify_type, object_description: st.object_description,
      geofence_m: st.geofence_m, match_threshold: st.match_threshold, review_min: st.review_min,
      allow_review: Boolean(st.allow_review), qr_token: st.qr_token,
      has_riddle_image: Boolean(st.riddle_image), has_target_image: Boolean(st.target_image),
      success_message: st.success_message,
    };
  }

  _stageFields(input, existing) {
    const out = {};
    const src = input && typeof input === 'object' ? input : {};
    if (src.title !== undefined) out.title = cleanText(src.title, 80);
    if (src.riddle_text !== undefined) out.riddle_text = cleanText(src.riddle_text, 1500, { multiline: true });
    if (src.answers !== undefined) out.answers = JSON.stringify(parseAnswers(src.answers));
    if (src.hints !== undefined) out.hints = JSON.stringify(parseHints(src.hints));
    if (src.location_name !== undefined) out.location_name = cleanText(src.location_name, 100);
    if (src.object_description !== undefined) out.object_description = cleanText(src.object_description, 300);
    if (src.success_message !== undefined) out.success_message = cleanText(src.success_message, 300, { multiline: true });
    if (src.verify_type !== undefined) {
      if (!['qr', 'photo', 'either'].includes(src.verify_type)) throw badRequest('invalid_verify_type', 'verify_type must be qr, photo or either');
      out.verify_type = src.verify_type;
    }
    if (src.lat !== undefined || src.lng !== undefined) {
      const lat = src.lat === undefined ? existing?.lat : src.lat;
      const lng = src.lng === undefined ? existing?.lng : src.lng;
      if ((lat === null || lat === '') && (lng === null || lng === '')) {
        out.lat = null;
        out.lng = null;
      } else {
        const la = Number(lat);
        const ln = Number(lng);
        if (lat === null || lng === null || lat === '' || lng === '' || !Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) {
          throw badRequest('invalid_location', 'Latitude must be -90..90 and longitude -180..180');
        }
        out.lat = la;
        out.lng = ln;
      }
    }
    if (src.geofence_m !== undefined) out.geofence_m = asInt(src.geofence_m, 'geofence_m', 0, 5000);
    if (src.match_threshold !== undefined) out.match_threshold = src.match_threshold === null ? null : asInt(src.match_threshold, 'match_threshold', 50, 100);
    if (src.review_min !== undefined) out.review_min = src.review_min === null ? null : asInt(src.review_min, 'review_min', 0, 99);
    if (src.allow_review !== undefined) out.allow_review = asBool(src.allow_review, 'allow_review') ? 1 : 0;
    const thr = out.match_threshold !== undefined ? out.match_threshold : existing?.match_threshold;
    const rev = out.review_min !== undefined ? out.review_min : existing?.review_min;
    if (thr !== null && thr !== undefined && rev !== null && rev !== undefined && rev >= thr) {
      throw badRequest('invalid_review_min', 'review_min must be lower than match_threshold');
    }
    return out;
  }

  addStage(user, eventId, body) {
    const event = this._orgEvent(user, eventId);
    if (event.status !== 'lobby') throw conflict('locked', 'Stages can only be added before the hunt starts');
    if (this._count('stages', 'event_id = ?', event.id) >= this.cfg.limits.maxStagesPerEvent) {
      throw conflict('too_many_stages', `At most ${this.cfg.limits.maxStagesPerEvent} stages per event`);
    }
    const fields = this._stageFields(body, null);
    return this.db.tx(() => {
      const pos = this._count('stages', 'event_id = ?', event.id);
      let token;
      for (let i = 0; i < 12; i++) {
        token = randomCode(12);
        if (!this.db.get('SELECT 1 FROM stages WHERE qr_token = ?', token)) break;
      }
      const r = this.db.run(
        'INSERT INTO stages (event_id, position, title, qr_token) VALUES (?,?,?,?)',
        event.id, pos, fields.title || `Stage ${pos + 1}`, token,
      );
      const id = Number(r.lastInsertRowid);
      this._applyStageFields(id, fields);
      this._notifyEvent(event.id);
      return this.stageView(this.db.get('SELECT * FROM stages WHERE id = ?', id));
    });
  }

  _applyStageFields(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.run(`UPDATE stages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
  }

  updateStage(user, stageId, body) {
    const st = this._orgStage(user, stageId);
    const event = this._event(st.event_id);
    const fields = this._stageFields(body, st);
    if (event.status === 'running' || event.status === 'ended') {
      const next = { ...st, ...fields };
      if ((next.verify_type === 'photo' || next.verify_type === 'either') && !next.target_image) {
        throw conflict('needs_target_image', 'Upload the target photo before switching to photo verification');
      }
    }
    this._applyStageFields(st.id, fields);
    this._notifyEvent(event.id);
    return this.stageView(this.db.get('SELECT * FROM stages WHERE id = ?', st.id));
  }

  deleteStage(user, stageId) {
    const st = this._orgStage(user, stageId);
    const event = this._event(st.event_id);
    if (event.status !== 'lobby') throw conflict('locked', 'Stages can only be removed before the hunt starts');
    this.db.tx(() => {
      this.db.run('DELETE FROM stages WHERE id = ?', st.id);
      const rest = this.stages(event.id);
      rest.forEach((s, i) => {
        if (s.position !== i) this.db.run('UPDATE stages SET position = ? WHERE id = ?', i, s.id);
      });
    });
    [st.riddle_image, st.target_image].filter(Boolean).forEach((f) => this.store.remove(f));
    this._notifyEvent(event.id);
    return { deleted: true };
  }

  reorderStages(user, eventId, order) {
    const event = this._orgEvent(user, eventId);
    if (event.status !== 'lobby') throw conflict('locked', 'Stages can only be reordered before the hunt starts');
    const ids = this.stages(event.id).map((s) => s.id);
    if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== order.length || !order.every((i) => ids.includes(i))) {
      throw badRequest('invalid_order', 'order must list every stage id exactly once');
    }
    this.db.tx(() => order.forEach((id, i) => this.db.run('UPDATE stages SET position = ? WHERE id = ?', i, id)));
    this._notifyEvent(event.id);
    return this.stages(event.id).map((s) => this.stageView(s));
  }

  async setStageImage(user, stageId, role, buffer) {
    if (!['riddle', 'target'].includes(role)) throw notFound('Unknown image slot');
    const st = this._orgStage(user, stageId);
    const prepared = await images.prepareImage(buffer, { maxBytes: this.cfg.limits.imageBytes });
    const file = this.store.save(prepared.jpeg);
    const col = role === 'riddle' ? 'riddle_image' : 'target_image';
    const old = st[col];
    this.db.run(`UPDATE stages SET ${col} = ? WHERE id = ?`, file, st.id);
    if (old) this.store.remove(old);
    this._notifyEvent(st.event_id);
    return this.stageView(this.db.get('SELECT * FROM stages WHERE id = ?', st.id));
  }

  clearStageImage(user, stageId, role) {
    if (!['riddle', 'target'].includes(role)) throw notFound('Unknown image slot');
    const st = this._orgStage(user, stageId);
    const col = role === 'riddle' ? 'riddle_image' : 'target_image';
    const event = this._event(st.event_id);
    if (role === 'target' && event.status !== 'lobby' && (st.verify_type === 'photo' || st.verify_type === 'either')) {
      throw conflict('needs_target_image', 'This checkpoint needs its target photo while the hunt is live');
    }
    if (st[col]) {
      this.db.run(`UPDATE stages SET ${col} = NULL WHERE id = ?`, st.id);
      this.store.remove(st[col]);
    }
    this._notifyEvent(st.event_id);
    return this.stageView(this.db.get('SELECT * FROM stages WHERE id = ?', st.id));
  }

  regenerateQr(user, stageId) {
    const st = this._orgStage(user, stageId);
    let token;
    for (let i = 0; i < 12; i++) {
      token = randomCode(12);
      if (!this.db.get('SELECT 1 FROM stages WHERE qr_token = ?', token)) break;
    }
    this.db.run('UPDATE stages SET qr_token = ? WHERE id = ?', token, st.id);
    return this.stageView(this.db.get('SELECT * FROM stages WHERE id = ?', st.id));
  }

  qrPayload(stage, base) {
    return `${base}/play.html#scan=${stage.qr_token}`;
  }

  /** preview an AI hint for an organizer without touching any team */
  async previewHint(user, stageId, level) {
    const st = this._orgStage(user, stageId);
    const lvl = asInt(level ?? 1, 'level', 1, 3);
    const answers = parseJson(st.answers, []);
    if (!st.riddle_text || !answers.length) throw badRequest('incomplete_stage', 'Add the riddle and its answer first');
    const hint = await this._hintFor(st, lvl, []);
    return hint;
  }

  // ------------------------------------------------------------------ dashboard (organizer)
  teamRow(team, total) {
    return {
      id: team.id, name: team.name, code: team.code, leader_id: team.leader_id,
      members: this._membersOf(team.id), stage_pos: team.stage_pos, phase: team.phase,
      completed: this._completed(team, total), hints_used: team.hints_used, wrong_answers: team.wrong_answers,
      finished_at: team.finished_at, progress_at: team.progress_at, last_seen: team.last_seen,
      location: team.last_lat === null || team.last_lat === undefined ? null : { lat: team.last_lat, lng: team.last_lng, acc: team.last_acc },
      pending_reviews: this._count("submissions", "team_id = ? AND status = 'pending'", team.id),
    };
  }

  dashboard(user, eventId) {
    const event = this._orgEvent(user, eventId);
    const stages = this.stages(event.id);
    const total = stages.length;
    const teams = this.db.all('SELECT * FROM teams WHERE event_id = ?', event.id).map((t) => this.teamRow(t, total));
    teams.sort((a, b) => b.completed - a.completed || (a.progress_at ?? Infinity) - (b.progress_at ?? Infinity) || a.name.localeCompare(b.name));
    teams.forEach((t, i) => { t.rank = i + 1; });
    const reviews = this.db
      .all(
        `SELECT sub.id, sub.team_id, t.name AS team_name, sub.stage_id, st.position AS stage_position,
                sub.score, sub.reason, sub.created_at
         FROM submissions sub JOIN teams t ON t.id = sub.team_id JOIN stages st ON st.id = sub.stage_id
         WHERE sub.event_id = ? AND sub.status = 'pending' ORDER BY sub.id`,
        event.id,
      )
      .map((r) => ({ ...r, image_url: `/api/submissions/${r.id}/image` }));
    const activity = this.db.all('SELECT * FROM activity WHERE event_id = ? ORDER BY id DESC LIMIT 80', event.id);
    const participants = this._count('event_members', 'event_id = ?', event.id);
    const teamed = this._count('team_members', 'event_id = ?', event.id);
    return {
      server_time: this.now(),
      event: this.eventView(event),
      stages: stages.map((s) => this.stageView(s)),
      teams,
      reviews,
      activity,
      participants,
      unteamed: participants - teamed,
      problems: event.status === 'lobby' ? this.validateEvent(event) : [],
    };
  }

  // ------------------------------------------------------------------ participants: join, teams
  joinEvent(user, code) {
    const c = normalizeCode(code);
    const event = c ? this.db.get('SELECT * FROM events WHERE code = ?', c) : null;
    if (!event) throw notFound('No event with that code', 'bad_code');
    const already = this.db.get('SELECT 1 AS ok FROM event_members WHERE event_id = ? AND user_id = ?', event.id, user.id);
    if (!already) {
      const s = this.settingsOf(event);
      if (event.status === 'ended') throw conflict('event_ended', 'That hunt has already ended');
      if (event.status === 'running' && !s.allow_late_join) throw conflict('event_started', 'That hunt has already started');
      this.db.run('INSERT OR IGNORE INTO event_members (event_id, user_id, joined_at) VALUES (?,?,?)', event.id, user.id, this.now());
      this._notifyEvent(event.id);
    }
    return { event_id: event.id, name: event.name, status: event.status };
  }

  myEvents(user) {
    return this.db
      .all(
        `SELECT e.id, e.name, e.code, e.status, em.joined_at FROM event_members em JOIN events e ON e.id = em.event_id
         WHERE em.user_id = ? ORDER BY em.joined_at DESC`,
        user.id,
      )
      .map((e) => {
        const t = this._teamOf(user.id, e.id);
        return { id: e.id, name: e.name, status: e.status, team: t ? { id: t.id, name: t.name } : null };
      });
  }

  _canFormTeams(event) {
    const s = this.settingsOf(event);
    if (event.status === 'ended') throw conflict('event_ended', 'This hunt has ended');
    if (event.status === 'running' && !s.allow_late_join) throw conflict('event_started', 'Teams are locked - the hunt has started');
    return s;
  }

  createTeam(user, eventId, name) {
    const event = this._event(parseId(eventId));
    this._requireMember(user, event);
    const s = this._canFormTeams(event);
    const n = cleanText(name, 30);
    if (n.length < 2) throw badRequest('invalid_team_name', 'Team name must be 2-30 characters');
    return this.db.tx(() => {
      if (this._teamOf(user.id, event.id)) throw conflict('already_in_team', 'You are already in a team');
      if (this._count('teams', 'event_id = ?', event.id) >= this.cfg.limits.maxTeamsPerEvent) throw conflict('too_many_teams', 'This event is full');
      if (this.db.get('SELECT 1 FROM teams WHERE event_id = ? AND name = ?', event.id, n)) throw conflict('team_name_taken', 'That team name is taken');
      const progressAt = event.status === 'running' ? this.now() : null;
      for (let i = 0; i < 12; i++) {
        try {
          const r = this.db.run(
            'INSERT INTO teams (event_id, name, code, leader_id, created_at, progress_at) VALUES (?,?,?,?,?,?)',
            event.id, n, randomCode(6), user.id, this.now(), progressAt,
          );
          const teamId = Number(r.lastInsertRowid);
          this.db.run('INSERT INTO team_members (team_id, event_id, user_id, joined_at) VALUES (?,?,?,?)', teamId, event.id, user.id, this.now());
          this._log(event.id, teamId, 'team', `Team "${n}" was created by ${user.display_name}`);
          this._notifyEvent(event.id);
          return { team_id: teamId, max: s.team_max };
        } catch (e) {
          if (!isUnique(e) || /team_members/.test(String(e.message))) throw e;
          if (/teams\.event_id, teams\.name/i.test(String(e.message))) throw conflict('team_name_taken', 'That team name is taken');
        }
      }
      throw new HttpError(500, 'code_generation_failed', 'Could not allocate a team code');
    });
  }

  joinTeam(user, code) {
    const c = normalizeCode(code);
    const team = c ? this.db.get('SELECT * FROM teams WHERE code = ?', c) : null;
    if (!team) throw notFound('No team with that code', 'bad_code');
    const event = this._event(team.event_id);
    const s = this._canFormTeams(event);
    return this.db.tx(() => {
      const mine = this._teamOf(user.id, event.id);
      if (mine) {
        if (mine.id === team.id) return { team_id: team.id, event_id: event.id };
        throw conflict('already_in_team', 'You are already in a team - leave it first');
      }
      if (this._count('team_members', 'team_id = ?', team.id) >= s.team_max) throw conflict('team_full', `That team already has ${s.team_max} members`);
      this.db.run('INSERT OR IGNORE INTO event_members (event_id, user_id, joined_at) VALUES (?,?,?)', event.id, user.id, this.now());
      this.db.run('INSERT INTO team_members (team_id, event_id, user_id, joined_at) VALUES (?,?,?,?)', team.id, event.id, user.id, this.now());
      this._log(event.id, team.id, 'team', `${user.display_name} joined team "${team.name}"`);
      this._notifyTeam(team);
      this._notifyEvent(event.id);
      return { team_id: team.id, event_id: event.id };
    });
  }

  leaveTeam(user, eventId) {
    const { event, team } = this._playCtx(user, eventId);
    if (event.status !== 'lobby') throw conflict('event_started', 'You cannot leave a team once the hunt has started');
    this.db.tx(() => {
      this.db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', team.id, user.id);
      const rest = this._membersOf(team.id);
      if (rest.length === 0) {
        this.db.run('DELETE FROM teams WHERE id = ?', team.id);
      } else if (team.leader_id === user.id) {
        this.db.run('UPDATE teams SET leader_id = ? WHERE id = ?', rest[0].id, team.id);
      }
      this._log(event.id, rest.length ? team.id : null, 'team', `${user.display_name} left team "${team.name}"`);
    });
    if (this.db.get('SELECT 1 FROM teams WHERE id = ?', team.id)) this._notifyTeam(team);
    this._notifyEvent(event.id);
    return { left: true };
  }

  // ------------------------------------------------------------------ participant views
  _leaderboard(event, total) {
    const rows = this.db.all('SELECT * FROM teams WHERE event_id = ?', event.id);
    const list = rows.map((t) => ({
      team_id: t.id, name: t.name, completed: this._completed(t, total), finished: t.phase === 'done',
      at: t.progress_at ?? Infinity,
    }));
    list.sort((a, b) => b.completed - a.completed || a.at - b.at || a.name.localeCompare(b.name));
    return list.map((r, i) => ({ rank: i + 1, team_id: r.team_id, name: r.name, completed: r.completed, total, finished: r.finished }));
  }

  playerState(user, eventId) {
    const event = this._event(parseId(eventId));
    this._requireMember(user, event);
    const team = this._teamOf(user.id, event.id);
    const s = this.settingsOf(event);
    const total = this._count('stages', 'event_id = ?', event.id);
    const winner = event.winner_team_id ? this.db.get('SELECT id, name FROM teams WHERE id = ?', event.winner_team_id) : null;
    const state = {
      server_time: this.now(),
      me: { id: user.id, display_name: user.display_name },
      event: {
        id: event.id, name: event.name, status: event.status, total_stages: total,
        started_at: event.started_at, ended_at: event.ended_at,
        winner: winner ? { team_id: winner.id, name: winner.name } : null,
        can_form_teams: event.status === 'lobby' || (event.status === 'running' && s.allow_late_join),
      },
      limits: { team_max: s.team_max, max_hints: s.max_hints },
      team: null,
      game: null,
      leaderboard: [],
    };
    if (team) {
      state.team = {
        id: team.id, name: team.name, code: team.code, leader_id: team.leader_id,
        members: this._membersOf(team.id), max: s.team_max,
      };
      if (event.status !== 'lobby') state.game = this._gameView(event, team, total, s);
    }
    const board = this._leaderboard(event, total);
    state.leaderboard = s.show_leaderboard ? board : team ? board.filter((r) => r.team_id === team.id) : [];
    return state;
  }

  _gameView(event, team, total, s) {
    const stages = this.stages(event.id);
    const remaining = Math.max(0, s.max_hints - team.hints_used);
    const game = {
      phase: team.phase, index: team.stage_pos, total,
      hints: { used: team.hints_used, max: s.max_hints, remaining },
      result: event.status === 'ended' ? (event.winner_team_id === team.id ? 'won' : 'lost') : team.phase === 'done' ? 'won' : null,
      history: [], riddle: null, unlocked: null, stage_hints: [], can_hint: false, pending_review: false,
    };
    const doneUpTo = team.phase === 'done' ? total : team.stage_pos;
    game.history = stages.filter((st) => st.position < doneUpTo).map((st) => ({ position: st.position, message: st.success_message }));
    if (team.phase === 'done') return game;
    const st = stages[team.stage_pos];
    if (!st) return game;
    game.riddle = { text: st.riddle_text, image_url: st.riddle_image ? `/api/stages/${st.id}/image/riddle` : null };
    game.stage_hints = this.db
      .all('SELECT level, text, source FROM hints_issued WHERE team_id = ? AND stage_id = ? ORDER BY id', team.id, st.id);
    game.can_hint = event.status === 'running' && team.phase === 'riddle' && remaining > 0 && !this.inflight.has(`hint:${team.id}`);
    game.pending_review = Boolean(this.db.get("SELECT 1 FROM submissions WHERE team_id = ? AND stage_id = ? AND status = 'pending'", team.id, st.id));
    if (team.phase === 'unlocked') {
      game.unlocked = {
        lat: st.lat, lng: st.lng, location_name: st.location_name,
        verify_type: st.verify_type, object_description: st.object_description,
        target_image_url: st.target_image ? `/api/stages/${st.id}/image/target` : null,
        geofence_m: st.geofence_m,
      };
    }
    return game;
  }

  /** who may see a stage image right now */
  imageAccess(user, stageId, role) {
    const st = this.db.get('SELECT * FROM stages WHERE id = ?', parseId(stageId));
    if (!st) throw notFound();
    const event = this._event(st.event_id);
    const file = role === 'riddle' ? st.riddle_image : role === 'target' ? st.target_image : null;
    if (!file) throw notFound('No image');
    if (user.role === 'organizer') {
      if (event.organizer_id !== user.id) throw notFound();
      return file;
    }
    const m = this.db.get('SELECT 1 AS ok FROM event_members WHERE event_id = ? AND user_id = ?', event.id, user.id);
    const team = m ? this._teamOf(user.id, event.id) : null;
    if (!team || event.status === 'lobby') throw notFound();
    const total = this._count('stages', 'event_id = ?', event.id);
    const cleared = team.phase === 'done' || st.position < team.stage_pos;
    const current = st.position === team.stage_pos && team.phase !== 'done';
    const ok = role === 'riddle' ? cleared || current : cleared || (current && team.phase === 'unlocked');
    if (!ok || st.position >= total) throw notFound();
    return file;
  }

  // ------------------------------------------------------------------ gameplay
  _geoFrom(geo) {
    if (!geo) return null;
    const lat = Number(geo.lat);
    const lng = Number(geo.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    const acc = Number.isFinite(Number(geo.acc)) ? Math.max(0, Number(geo.acc)) : 0;
    return { lat, lng, acc };
  }
  _checkGeofence(stage, geo) {
    if (!stage.geofence_m || stage.lat === null) return;
    const g = this._geoFrom(geo);
    if (!g) throw conflict('location_required', 'Turn on location sharing so we can confirm you are at the checkpoint');
    const dist = haversineM(g.lat, g.lng, stage.lat, stage.lng);
    if (Math.max(0, dist - Math.min(g.acc, 150)) > stage.geofence_m) {
      throw conflict('too_far', `You are about ${Math.round(dist)} m from the checkpoint - get closer`, { distance_m: Math.round(dist) });
    }
  }

  ping(user, eventId, body) {
    const { event, team } = this._playCtx(user, eventId);
    if (event.status === 'ended') return { ok: true };
    const g = this._geoFrom(body);
    if (!g) throw badRequest('invalid_location', 'Invalid location');
    const lim = this.rate.hit(`ping:${user.id}`, 1, 4000);
    if (!lim.ok) return { ok: true, skipped: true };
    this.db.run('UPDATE teams SET last_lat = ?, last_lng = ?, last_acc = ?, last_seen = ? WHERE id = ?', g.lat, g.lng, g.acc, this.now(), team.id);
    this.hub.toOrganizers(event.id, { type: 'refresh' });
    return { ok: true };
  }

  submitAnswer(user, eventId, answer) {
    const { event, team } = this._playCtx(user, eventId);
    this._requireRunning(event);
    if (team.phase !== 'riddle') throw conflict('already_solved', team.phase === 'unlocked' ? 'You already solved this riddle - head to the location' : 'Nothing to answer');
    const stage = this._stageAt(event.id, team.stage_pos);
    const given = cleanText(answer, 200);
    if (!given) throw badRequest('empty_answer', 'Type your answer first');
    const r = this.rate;
    const key = `answer:${team.id}:${stage.id}`;
    const lock = r.blocked(key, this.cfg.rate.answerMax);
    if (lock.blocked) throw tooMany('Too many wrong answers - wait a few seconds', lock.retryMs);
    const accepted = parseJson(stage.answers, []);
    if (!answerMatches(given, accepted)) {
      r.hit(key, this.cfg.rate.answerMax, this.cfg.rate.answerWindowMs);
      this.db.run('UPDATE teams SET wrong_answers = wrong_answers + 1 WHERE id = ?', team.id);
      this.hub.toOrganizers(event.id, { type: 'refresh' });
      return { correct: false, message: 'Not quite - think again or use a hint.' };
    }
    const changed = this.db.tx(() => {
      const t = this.db.get('SELECT * FROM teams WHERE id = ?', team.id);
      const ev = this._event(event.id);
      if (ev.status !== 'running' || t.phase !== 'riddle' || t.stage_pos !== stage.position) return false;
      this.db.run("UPDATE teams SET phase = 'unlocked', progress_at = ? WHERE id = ?", this.now(), team.id);
      this._log(event.id, team.id, 'riddle', `Team "${team.name}" solved the riddle for stage ${stage.position + 1}`);
      return true;
    });
    if (!changed) throw conflict('stale', 'Your team already moved on');
    this.rate.reset(key);
    this._notifyTeam(team, { message: `${user.display_name} solved the riddle! The next location is on the map.` });
    this._notifyEvent(event.id);
    return { correct: true, message: 'Correct! The location is now on your map.' };
  }

  // ---- hints
  _structuralHint(answers, level) {
    const a = String(answers[0] || '').trim();
    const compact = a.replace(/\s+/g, '');
    const words = a.split(/\s+/).filter(Boolean).length || 1;
    if (!compact) return 'Read the riddle once more, slowly - every line matters.';
    if (level <= 1) return `The answer is ${words === 1 ? 'one word' : `${words} words`} with ${compact.length} letters.`;
    if (level === 2) return `It starts with "${compact[0].toUpperCase()}" and has ${compact.length} letters.`;
    return `It starts with "${compact[0].toUpperCase()}" and ends with "${compact[compact.length - 1].toUpperCase()}".`;
  }

  async _hintFor(stage, level, previous) {
    const answers = parseJson(stage.answers, []);
    try {
      const h = await this.ai.generateHint({ riddle: stage.riddle_text, answers, level, previous });
      // defence in depth: never hand out a hint that contains the answer, whichever provider wrote it
      if (h && h.text && !hintLeaks(h.text, answers)) return { text: String(h.text).slice(0, 300), source: h.source || 'ai' };
    } catch (e) {
      if (!(e instanceof AIUnavailable)) throw e;
    }
    const written = parseJson(stage.hints, []);
    if (written[level - 1]) return { text: written[level - 1], source: 'organizer' };
    return { text: this._structuralHint(answers, level), source: 'auto' };
  }

  async requestHint(user, eventId) {
    const { event, team } = this._playCtx(user, eventId);
    this._requireRunning(event);
    if (team.phase !== 'riddle') throw conflict('not_riddle', 'Hints are only available while you are solving a riddle');
    const s = this.settingsOf(event);
    if (team.hints_used >= s.max_hints) throw conflict('no_hints_left', `Your team has used all ${s.max_hints} hints`);
    const key = `hint:${team.id}`;
    if (this.inflight.has(key)) throw conflict('busy', 'A hint is already being prepared for your team');
    const lim = this.rate.hit(`hintcd:${team.id}`, 1, this.cfg.rate.hintCooldownMs);
    if (!lim.ok) throw tooMany('Slow down a moment', lim.retryMs);
    const stage = this._stageAt(event.id, team.stage_pos);
    const given = this.db.all('SELECT level, text FROM hints_issued WHERE team_id = ? AND stage_id = ? ORDER BY id', team.id, stage.id);
    const level = Math.min(3, given.length + 1);
    this.inflight.add(key);
    let hint;
    try {
      hint = await this._hintFor(stage, level, given.map((g) => g.text));
    } finally {
      this.inflight.delete(key);
    }
    // re-validate after the (possibly slow) AI call, then spend the hint atomically
    const spent = this.db.tx(() => {
      const t = this.db.get('SELECT * FROM teams WHERE id = ?', team.id);
      const ev = this._event(event.id);
      if (ev.status !== 'running' || t.phase !== 'riddle' || t.stage_pos !== stage.position) return null;
      if (t.hints_used >= s.max_hints) return null;
      this.db.run('UPDATE teams SET hints_used = hints_used + 1 WHERE id = ?', team.id);
      this.db.run(
        'INSERT INTO hints_issued (team_id, stage_id, level, text, source, created_at) VALUES (?,?,?,?,?,?)',
        team.id, stage.id, level, hint.text, hint.source, this.now(),
      );
      this._log(event.id, team.id, 'hint', `Team "${team.name}" used hint ${t.hints_used + 1}/${s.max_hints} on stage ${stage.position + 1}`);
      return t.hints_used + 1;
    });
    if (spent === null) throw conflict('stale', 'That hint is no longer available');
    this._notifyTeam(team);
    return { hint: { level, text: hint.text, source: hint.source }, hints: { used: spent, max: s.max_hints, remaining: s.max_hints - spent } };
  }

  // ---- checkpoint completion (single place that advances a team)
  _completeStage(teamId, stageId, via, byName) {
    return this.db.tx(() => {
      const t = this.db.get('SELECT * FROM teams WHERE id = ?', teamId);
      const ev = this._event(t.event_id);
      const st = this.db.get('SELECT * FROM stages WHERE id = ?', stageId);
      if (ev.status !== 'running') throw conflict('event_ended', 'This hunt has ended');
      if (t.phase !== 'unlocked' || t.stage_pos !== st.position) throw conflict('stale', 'Your team already moved on');
      const total = this._count('stages', 'event_id = ?', ev.id);
      const now = this.now();
      this.db.run("UPDATE submissions SET status = 'superseded', decided_at = ? WHERE team_id = ? AND stage_id = ? AND status = 'pending'", now, t.id, st.id);
      if (st.position >= total - 1) {
        this.db.run("UPDATE teams SET phase = 'done', finished_at = ?, progress_at = ? WHERE id = ?", now, now, t.id);
        this.db.run("UPDATE events SET status = 'ended', ended_at = ?, winner_team_id = ? WHERE id = ?", now, t.id, ev.id);
        this._log(ev.id, t.id, 'finish', `🏆 Team "${t.name}" found the treasure and won the hunt!`);
        return { finished: true, team: t, stage: st };
      }
      this.db.run("UPDATE teams SET stage_pos = stage_pos + 1, phase = 'riddle', progress_at = ? WHERE id = ?", now, t.id);
      this._log(ev.id, t.id, 'checkpoint', `Team "${t.name}" cleared checkpoint ${st.position + 1} of ${total} (${via}${byName ? `, ${byName}` : ''})`);
      return { finished: false, team: t, stage: st };
    });
  }

  _afterComplete(res, byName) {
    const msg = res.finished
      ? '🏆 You found the treasure! Your team wins!'
      : `${byName || 'A teammate'} cleared the checkpoint! Your next riddle is ready.`;
    this._notifyTeam(res.team, { message: msg });
    this._notifyEvent(res.team.event_id);
    if (res.finished) {
      this.hub.toEventParticipants(res.team.event_id, { type: 'refresh', scope: 'event', message: `Team "${res.team.name}" found the treasure - the hunt is over!` });
    }
  }

  // ---- QR / code check
  _extractToken(raw) {
    const s = String(raw ?? '').slice(0, 500);
    const m = s.match(/scan=([A-Za-z0-9]{6,32})/);
    return normalizeCode(m ? m[1] : s);
  }

  submitScan(user, eventId, raw, geo) {
    const { event, team } = this._playCtx(user, eventId);
    this._requireRunning(event);
    if (team.phase === 'riddle') throw conflict('riddle_first', 'Solve the current riddle first - then scan the checkpoint code');
    if (team.phase !== 'unlocked') throw conflict('not_ready', 'Nothing to scan right now');
    const stage = this._stageAt(event.id, team.stage_pos);
    if (stage.verify_type === 'photo') throw badRequest('photo_only', 'This checkpoint is verified with a photo, not a code');
    const key = `scanfail:${team.id}`;
    const lock = this.rate.blocked(key, this.cfg.rate.scanFailMax);
    if (lock.blocked) throw tooMany('Too many wrong codes - wait a minute', lock.retryMs);
    const token = this._extractToken(raw);
    if (!token || !safeEqual(token, stage.qr_token)) {
      this.rate.hit(key, this.cfg.rate.scanFailMax, this.cfg.rate.scanWindowMs);
      return { result: 'failed', message: "That code doesn't belong to your current checkpoint." };
    }
    this._checkGeofence(stage, geo);
    const res = this._completeStage(team.id, stage.id, 'QR', user.display_name);
    this._afterComplete(res, user.display_name);
    return { result: 'passed', finished: res.finished, message: stage.success_message || (res.finished ? 'You found the treasure!' : 'Checkpoint cleared!') };
  }

  // ---- photo check
  async submitPhoto(user, eventId, buffer, geo) {
    const { event, team } = this._playCtx(user, eventId);
    this._requireRunning(event);
    if (team.phase === 'riddle') throw conflict('riddle_first', 'Solve the current riddle first');
    if (team.phase !== 'unlocked') throw conflict('not_ready', 'Nothing to verify right now');
    const stage = this._stageAt(event.id, team.stage_pos);
    if (stage.verify_type === 'qr') throw badRequest('qr_only', 'This checkpoint is verified with a QR code, not a photo');
    this._checkGeofence(stage, geo);
    if (this.db.get("SELECT 1 FROM submissions WHERE team_id = ? AND stage_id = ? AND status = 'pending'", team.id, stage.id)) {
      throw conflict('review_pending', 'Your last photo is waiting for the organizer to review it');
    }
    const key = `photo:${team.id}`;
    if (this.inflight.has(key)) throw conflict('busy', 'Your team already has a photo being checked');
    const cd = this.rate.hit(`photocd:${team.id}`, 1, this.cfg.rate.photoCooldownMs);
    if (!cd.ok) throw tooMany('Wait a few seconds before sending another photo', cd.retryMs);

    const s = this.settingsOf(event);
    const threshold = stage.match_threshold ?? s.match_threshold;
    const reviewMin = Math.min(stage.review_min ?? s.review_min, threshold - 1);
    const allowReview = Boolean(stage.allow_review) && s.allow_review;

    this.inflight.add(key);
    let outcome; // {status, score, reason, message}
    let prepared;
    try {
      prepared = await images.prepareImage(buffer, { maxBytes: this.cfg.limits.imageBytes });
      const other = this.db.get('SELECT team_id FROM submissions WHERE stage_id = ? AND image_sha = ? AND team_id <> ? LIMIT 1', stage.id, prepared.sha, team.id);
      const target = stage.target_image ? this.store.read(stage.target_image) : null;
      if (other) {
        outcome = { status: 'failed', score: 0, reason: 'duplicate', message: 'That exact photo was already used by another team. Take your own photo of the real thing.' };
        this._log(event.id, team.id, 'warning', `Team "${team.name}" re-used another team's photo at stage ${stage.position + 1}`);
      } else if (target) {
        const tf = await this.store.featuresOf(stage.target_image);
        if (tf && images.hamming(tf.dhash, prepared.dhash) <= this.cfg.game.copyDistance) {
          outcome = { status: 'failed', score: 0, reason: 'copy', message: 'That looks like the clue image itself - take a fresh photo of the real object.' };
          this._log(event.id, team.id, 'warning', `Team "${team.name}" submitted what looks like a copy of the clue image at stage ${stage.position + 1}`);
        } else {
          try {
            const r = await this.ai.compareImages({ reference: target, candidate: prepared.jpeg, description: stage.object_description });
            outcome = { status: null, score: r.score, reason: r.reason };
          } catch (e) {
            if (!(e instanceof AIUnavailable)) throw e;
            if (!allowReview) throw new HttpError(503, 'ai_unavailable', `${e.message}. Please try again shortly.`);
            outcome = { status: 'pending', score: null, reason: `AI unavailable (${e.message}) - needs organizer review`, message: 'The AI could not check your photo, so the organizer will review it.' };
          }
        }
      } else {
        outcome = { status: 'pending', score: null, reason: 'No target photo configured - needs organizer review', message: 'The organizer will review your photo.' };
      }
    } finally {
      this.inflight.delete(key);
    }

    if (outcome.status === null) {
      if (outcome.score >= threshold) outcome.status = 'passed';
      else if (outcome.score >= reviewMin && allowReview) {
        outcome.status = 'pending';
        outcome.message = `Close! (${outcome.score}/${threshold}) The organizer will take a look at your photo.`;
      } else {
        outcome.status = 'failed';
        outcome.message = `Not a match yet (${outcome.score}/${threshold} needed). Get closer, change the angle, and make sure the target is clearly in frame.`;
      }
    }

    // state may have changed while we waited on the AI (teammate scanned the QR, event ended...)
    const fresh = this.db.get('SELECT * FROM teams WHERE id = ?', team.id);
    const freshEvent = this._event(event.id);
    if (freshEvent.status !== 'running' || fresh.phase !== 'unlocked' || fresh.stage_pos !== stage.position) {
      return { result: 'stale', message: freshEvent.status === 'ended' ? 'The hunt ended while your photo was being checked.' : 'Your team already moved on.' };
    }
    const file = this.store.save(prepared.jpeg);
    const sub = this.db.run(
      'INSERT INTO submissions (event_id, team_id, stage_id, user_id, kind, status, score, reason, image_file, image_sha, dhash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      event.id, team.id, stage.id, user.id, 'photo', outcome.status, outcome.score, outcome.reason || '', file, prepared.sha, prepared.dhash, this.now(),
    );
    const subId = Number(sub.lastInsertRowid);

    if (outcome.status === 'passed') {
      let res;
      try {
        res = this._completeStage(team.id, stage.id, 'photo', user.display_name);
      } catch (e) {
        if (e instanceof HttpError && (e.code === 'stale' || e.code === 'event_ended')) {
          this.db.run("UPDATE submissions SET status = 'superseded' WHERE id = ?", subId);
          return { result: 'stale', message: 'Your team already moved on.' };
        }
        throw e;
      }
      this._afterComplete(res, user.display_name);
      return { result: 'passed', score: outcome.score, finished: res.finished, message: stage.success_message || (res.finished ? 'You found the treasure!' : 'Match! Checkpoint cleared.') };
    }
    if (outcome.status === 'pending') {
      this._log(event.id, team.id, 'review', `Team "${team.name}" needs a photo review at stage ${stage.position + 1}${outcome.score !== null ? ` (score ${outcome.score})` : ''}`);
      this._notifyTeam(team);
      return { result: 'pending', score: outcome.score, message: outcome.message };
    }
    this._log(event.id, team.id, 'photo', `Team "${team.name}" photo did not match at stage ${stage.position + 1} (${outcome.score ?? 0}/${threshold})`);
    this.hub.toOrganizers(event.id, { type: 'refresh' });
    return { result: 'failed', score: outcome.score, reason: outcome.reason, message: outcome.message };
  }

  // ---- organizer review of borderline photos
  decideSubmission(user, submissionId, approve) {
    const sub = this.db.get(
      'SELECT sub.* FROM submissions sub JOIN events e ON e.id = sub.event_id WHERE sub.id = ? AND e.organizer_id = ?',
      parseId(submissionId), user.id,
    );
    if (!sub) throw notFound('Submission not found');
    if (typeof approve !== 'boolean') throw badRequest('invalid_decision', 'approve must be true or false');
    if (sub.status !== 'pending') throw conflict('already_decided', 'This photo was already decided');
    const team = this.db.get('SELECT * FROM teams WHERE id = ?', sub.team_id);
    const stage = this.db.get('SELECT * FROM stages WHERE id = ?', sub.stage_id);
    const event = this._event(sub.event_id);
    const now = this.now();
    if (event.status !== 'running' || team.phase !== 'unlocked' || team.stage_pos !== stage.position) {
      this.db.run("UPDATE submissions SET status = 'superseded', decided_at = ?, decided_by = ? WHERE id = ?", now, user.id, sub.id);
      this.hub.toOrganizers(event.id, { type: 'refresh' });
      return { status: 'superseded' };
    }
    if (!approve) {
      this.db.run("UPDATE submissions SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?", now, user.id, sub.id);
      this._log(event.id, team.id, 'review', `Photo from team "${team.name}" was rejected by the organizer`);
      this._notifyTeam(team, { message: 'The organizer rejected your photo - try again.' });
      return { status: 'rejected' };
    }
    this.db.run("UPDATE submissions SET status = 'passed', decided_at = ?, decided_by = ? WHERE id = ?", now, user.id, sub.id);
    const res = this._completeStage(team.id, stage.id, 'photo, approved', null);
    this._afterComplete(res, 'The organizer');
    return { status: 'passed', finished: res.finished };
  }

  submissionImage(user, submissionId) {
    const sub = this.db.get(
      'SELECT sub.image_file FROM submissions sub JOIN events e ON e.id = sub.event_id WHERE sub.id = ? AND e.organizer_id = ?',
      parseId(submissionId), user.id,
    );
    if (!sub || !sub.image_file) throw notFound();
    return sub.image_file;
  }
}

module.exports = { Game, DEFAULT_SETTINGS, parseJson };
