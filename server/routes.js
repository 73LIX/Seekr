'use strict';
const { HttpError, badRequest, notFound } = require('./util');
const { sendJson, sendBuffer, RESPONDED } = require('./http');
const qr = require('./services/qr');

function registerRoutes({ router, game, auth, cfg, hub, store, ai }) {
  const authRate = { name: 'auth', max: cfg.rate.authMax, windowMs: cfg.rate.authWindowMs };

  // ------------------------------------------------------------ public
  router.get('/healthz', {}, () => {
    game.db.get('SELECT 1 AS ok');
    return { ok: true };
  });
  router.get('/api/config', {}, () => ({
    tile_url: cfg.tileUrl,
    tile_attribution: cfg.tileAttribution,
    team_max: cfg.game.teamMax,
    max_hints: cfg.game.maxHints,
    organizer_code_required: Boolean(cfg.organizerSignupCode),
  }));

  // ------------------------------------------------------------ auth
  router.post('/api/auth/register', { rate: authRate }, async (ctx) => auth.register(await ctx.json()));
  router.post('/api/auth/login', { rate: authRate }, async (ctx) => auth.login(await ctx.json(), ctx.ip));
  router.post('/api/auth/logout', { auth: 'any' }, (ctx) => {
    auth.logout(ctx.req);
    return { ok: true };
  });
  router.get('/api/me', { auth: 'any' }, (ctx) => ({ user: auth.publicUser(ctx.user) }));

  // ------------------------------------------------------------ organizer: events
  const org = { auth: 'organizer' };
  router.get('/api/events', org, (ctx) => ({ events: game.listEvents(ctx.user) }));
  router.post('/api/events', org, async (ctx) => game.createEvent(ctx.user, await ctx.json()));
  router.get('/api/events/:id/dashboard', org, (ctx) => game.dashboard(ctx.user, ctx.params.id));
  router.patch('/api/events/:id', org, async (ctx) => game.updateEvent(ctx.user, ctx.params.id, await ctx.json()));
  router.del('/api/events/:id', org, (ctx) => game.deleteEvent(ctx.user, ctx.params.id));
  router.post('/api/events/:id/start', org, (ctx) => game.startEvent(ctx.user, ctx.params.id));
  router.post('/api/events/:id/end', org, (ctx) => game.endEvent(ctx.user, ctx.params.id));
  router.post('/api/events/:id/reset', org, (ctx) => game.resetEvent(ctx.user, ctx.params.id));

  router.get('/api/events/:id/stream', org, (ctx) => {
    const event = game._orgEvent(ctx.user, ctx.params.id);
    hub.add(ctx.res, { role: 'organizer', userId: ctx.user.id, eventId: event.id });
    return RESPONDED;
  });

  // ------------------------------------------------------------ organizer: stages
  router.post('/api/events/:id/stages', org, async (ctx) => game.addStage(ctx.user, ctx.params.id, await ctx.json()));
  router.post('/api/events/:id/stages/reorder', org, async (ctx) => {
    const b = await ctx.json();
    return { stages: game.reorderStages(ctx.user, ctx.params.id, b.order) };
  });
  router.patch('/api/stages/:id', org, async (ctx) => game.updateStage(ctx.user, ctx.params.id, await ctx.json()));
  router.del('/api/stages/:id', org, (ctx) => game.deleteStage(ctx.user, ctx.params.id));
  router.post('/api/stages/:id/image/:role', { auth: 'organizer', limit: cfg.limits.imageBytes }, async (ctx) => {
    const buf = await ctx.raw(cfg.limits.imageBytes);
    return game.setStageImage(ctx.user, ctx.params.id, ctx.params.role, buf);
  });
  router.del('/api/stages/:id/image/:role', org, (ctx) => game.clearStageImage(ctx.user, ctx.params.id, ctx.params.role));
  router.post('/api/stages/:id/qr/regenerate', org, (ctx) => game.regenerateQr(ctx.user, ctx.params.id));
  router.post('/api/stages/:id/hint-preview', { auth: 'organizer', rate: { name: 'hintprev', max: 30, windowMs: 60_000 } }, async (ctx) => {
    const b = await ctx.json();
    return game.previewHint(ctx.user, ctx.params.id, b.level);
  });
  router.get('/api/stages/:id/qr.svg', org, (ctx) => {
    const stage = game._orgStage(ctx.user, ctx.params.id);
    let base = cfg.publicUrl;
    if (!base) {
      try {
        const u = new URL(String(ctx.query.base || ''));
        if (u.protocol === 'http:' || u.protocol === 'https:') base = u.origin;
      } catch { /* fall through */ }
    }
    if (!base) {
      const host = ctx.req.headers.host || 'localhost';
      base = `${cfg.trustProxy && ctx.req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${host}`;
    }
    const svg = qr.toSvg(game.qrPayload(stage, base), { ecl: 'M' });
    sendBuffer(ctx.res, 200, Buffer.from(svg), 'image/svg+xml', { 'Cache-Control': 'no-store' });
    return RESPONDED;
  });
  router.get('/api/stages/:id/qr-text', org, (ctx) => {
    const stage = game._orgStage(ctx.user, ctx.params.id);
    return { code: stage.qr_token };
  });

  // reviews
  router.post('/api/submissions/:id/decision', org, async (ctx) => {
    const b = await ctx.json();
    return game.decideSubmission(ctx.user, ctx.params.id, b.approve);
  });
  router.get('/api/submissions/:id/image', org, (ctx) => {
    const file = game.submissionImage(ctx.user, ctx.params.id);
    const buf = store.read(file);
    if (!buf) throw notFound();
    sendBuffer(ctx.res, 200, buf, 'image/jpeg', { 'Cache-Control': 'private, max-age=300' });
    return RESPONDED;
  });

  router.get('/api/ai/status', org, async () => ({ ...(await ai.health()), queue: ai.queueDepth ? ai.queueDepth() : 0 }));

  // stage images are shared: organizers always, participants only what they have earned
  router.get('/api/stages/:id/image/:role', { auth: 'any' }, (ctx) => {
    const file = game.imageAccess(ctx.user, ctx.params.id, ctx.params.role);
    const buf = store.read(file);
    if (!buf) throw notFound();
    sendBuffer(ctx.res, 200, buf, 'image/jpeg', { 'Cache-Control': 'private, max-age=60' });
    return RESPONDED;
  });

  // ------------------------------------------------------------ participant
  const part = { auth: 'participant' };
  router.post('/api/join', { auth: 'participant', rate: { name: 'join', max: 30, windowMs: 60_000 } }, async (ctx) => {
    const b = await ctx.json();
    return game.joinEvent(ctx.user, b.code);
  });
  router.get('/api/my/events', part, (ctx) => ({ events: game.myEvents(ctx.user) }));
  router.post('/api/teams/join', { auth: 'participant', rate: { name: 'teamjoin', max: 30, windowMs: 60_000 } }, async (ctx) => {
    const b = await ctx.json();
    return game.joinTeam(ctx.user, b.code);
  });

  router.get('/api/play/:eid/state', part, (ctx) => game.playerState(ctx.user, ctx.params.eid));
  router.get('/api/play/:eid/stream', part, (ctx) => {
    const { event } = game._playCtx(ctx.user, ctx.params.eid, { needTeam: false });
    hub.add(ctx.res, { role: 'participant', userId: ctx.user.id, eventId: event.id });
    return RESPONDED;
  });
  router.post('/api/play/:eid/team', part, async (ctx) => {
    const b = await ctx.json();
    return game.createTeam(ctx.user, ctx.params.eid, b.name);
  });
  router.post('/api/play/:eid/team/leave', part, (ctx) => game.leaveTeam(ctx.user, ctx.params.eid));
  router.post('/api/play/:eid/answer', part, async (ctx) => {
    const b = await ctx.json();
    return game.submitAnswer(ctx.user, ctx.params.eid, b.answer);
  });
  router.post('/api/play/:eid/hint', part, (ctx) => game.requestHint(ctx.user, ctx.params.eid));
  const geoOf = (q) => (q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng, acc: q.acc } : null);
  router.post('/api/play/:eid/scan', part, async (ctx) => {
    const b = await ctx.json();
    return game.submitScan(ctx.user, ctx.params.eid, b.code, b.geo || geoOf(ctx.query));
  });
  router.post('/api/play/:eid/photo', { auth: 'participant', limit: cfg.limits.imageBytes }, async (ctx) => {
    const buf = await ctx.raw(cfg.limits.imageBytes);
    return game.submitPhoto(ctx.user, ctx.params.eid, buf, geoOf(ctx.query));
  });
  router.post('/api/play/:eid/ping', part, async (ctx) => game.ping(ctx.user, ctx.params.eid, await ctx.json()));
}

module.exports = { registerRoutes };
