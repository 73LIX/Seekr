(function () {
  'use strict';
  const { api, upload, el, mount, toast, errMsg, busy, stream, debounce, authBlobUrl, store } = H;
  const { sprite, sfx } = PX;
  const app = document.getElementById('app');

  let user = null;
  let cfg = { tile_url: '', tile_attribution: '' };
  let eventId = null;
  let state = null;
  let live = null; // SSE handle
  let shell = null; // game screen refs
  let geo = null;
  let geoWatch = null;
  let lastPing = 0;
  let flash = null;
  let tick = null;
  let hintArmed = 0;
  let clockOffset = 0;
  let resultPlayed = null;
  const blobCache = new Map();

  // ================================================================ routing
  function readHash() {
    const h = location.hash.replace(/^#/, '');
    const scan = /(?:^|&)scan=([A-Za-z0-9_-]{4,64})/.exec(h);
    if (scan) { store.set('th.scan', scan[1]); history.replaceState(null, '', location.pathname); }
    const m = /^e\/(\d+)$/.exec(h);
    return m ? Number(m[1]) : null;
  }
  window.addEventListener('hashchange', () => { route(); });
  document.addEventListener('click', (e) => { if (e.target.closest('button')) sfx.play('click'); });

  async function route() {
    const id = readHash();
    if (id) openEvent(id); else openHome();
  }
  function go(id) {
    if (id) { if (location.hash === '#e/' + id) route(); else location.hash = 'e/' + id; }
    else if (location.hash && location.hash !== '#') location.hash = '';
    else route();
  }

  function leaveEvent() {
    if (live) { live.stop(); live = null; }
    if (geoWatch !== null && navigator.geolocation) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
    clearInterval(tick); tick = null;
    shell = null; state = null; eventId = null;
  }

  // ================================================================ chrome
  function muteButton() {
    const b = el('button', { class: 'small', 'aria-label': 'Toggle sound', title: 'Sound on/off' }, sfx.muted() ? 'SND OFF' : 'SND ON');
    b.addEventListener('click', (e) => { e.stopPropagation(); b.textContent = sfx.toggle() ? 'SND OFF' : 'SND ON'; });
    return b;
  }
  function topbar(extra) {
    return el('header', { class: 'topbar' },
      el('a', { class: 'logo', href: '#' }, H.LOGO(), 'Treasure Hunt'),
      el('span', { class: 'grow' }),
      extra,
      muteButton(),
      el('span', { class: 'who' }, user ? user.display_name : ''),
      el('button', { class: 'small', onclick: () => H.logout() }, 'Sign out'));
  }

  // ================================================================ home
  async function openHome() {
    leaveEvent();
    mount(app, topbar(), el('main', { class: 'page narrow stack', id: 'home' }, el('p', { class: 'muted' }, 'LOADING…')));
    let events = [];
    try { events = (await api('GET', '/api/my/events')).events; } catch (e) { toast(errMsg(e), 'bad'); }
    const code = el('input', { id: 'joinCode', placeholder: 'e.g. K7MQ2X', maxlength: 8, autocomplete: 'off', autocapitalize: 'characters', style: { textTransform: 'uppercase', letterSpacing: '.15em', fontWeight: '800' } });
    const joinBtn = el('button', { class: 'primary', type: 'submit' }, 'Join hunt');
    const form = el('form', { class: 'card stack', onsubmit: async (ev) => {
      ev.preventDefault();
      if (!code.value.trim()) { toast('Enter the code from your organizer', 'bad'); return; }
      const r = await busy(joinBtn, () => api('POST', '/api/join', { code: code.value }));
      if (r) go(r.event_id);
    } },
      el('h2', null, sprite('scroll', { scale: 4 }), ' Join a hunt'),
      el('div', { class: 'field' }, el('label', { for: 'joinCode' }, 'Event code'), code),
      joinBtn);
    const list = events.length
      ? el('div', { class: 'stack' }, events.map((e) => el('button', { class: 'block', style: { justifyContent: 'space-between' }, onclick: () => go(e.id) },
          el('span', null, e.name),
          el('span', { class: 'pill ' + (e.status === 'running' ? 'pink' : e.status === 'ended' ? '' : 'warn') }, e.status === 'running' ? 'live' : e.status === 'lobby' ? 'not started' : 'ended'))))
      : el('div', { class: 'empty' }, 'You have not joined a hunt yet. Ask your organizer for the event code.');
    mount(document.getElementById('home'), form, el('h3', null, 'Your hunts'), list);
    if (store.get('th.scan')) handlePendingScan(events);
  }

  async function handlePendingScan(events) {
    const code = store.get('th.scan');
    store.del('th.scan');
    const cands = events.filter((e) => e.status === 'running' && e.team);
    if (!cands.length) { toast('Join a running hunt and solve its riddle first, then scan the code.', 'bad'); return; }
    for (const e of cands) {
      try {
        const r = await api('POST', `/api/play/${e.id}/scan`, { code, geo });
        flash = r.result === 'passed' ? { kind: 'good', text: r.message } : { kind: 'bad', text: r.message };
        go(e.id);
        return;
      } catch (err) {
        if (cands.length === 1 || err.code !== 'riddle_first') { flash = { kind: 'bad', text: errMsg(err) }; go(e.id); return; }
      }
    }
  }

  // ================================================================ event
  async function openEvent(id) {
    if (eventId !== id) { leaveEvent(); eventId = id; }
    if (!live) {
      const refresh = debounce(() => load(), 150);
      live = stream(`/api/play/${id}/stream`, (m) => {
        if (m && m.message) toast(m.message);
        refresh();
      }, (s) => { if (s === 'denied') { toast('You are not part of that hunt.', 'bad'); leaveEvent(); go(null); } });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    }
    await load(true);
  }

  async function load(first) {
    if (!eventId) return;
    try {
      state = await api('GET', `/api/play/${eventId}/state`);
      clockOffset = state.server_time - Date.now();
    } catch (e) {
      if (first) { toast(errMsg(e), 'bad'); go(null); }
      return;
    }
    render();
  }

  function render() {
    const s = state;
    if (!s) return;
    const ev = s.event;
    const inGame = s.team && s.game && (ev.status === 'running' || ev.status === 'ended') && s.game.phase !== undefined;
    if (inGame && ev.status === 'running' && s.game.phase !== 'done') { renderGame(); return; }
    shell = null;
    clearInterval(tick); tick = null;
    if (inGame || ev.status === 'ended') { renderResult(); return; }
    renderTeamArea();
  }

  // ---------------------------------------------------------------- team area (lobby)
  function renderTeamArea() {
    const s = state; const ev = s.event;
    const body = el('main', { class: 'page narrow stack' });
    body.append(el('div', null, el('h2', null, ev.name), el('span', { class: 'pill ' + (ev.status === 'running' ? 'pink' : 'warn') }, ev.status === 'running' ? 'hunt is live' : 'waiting to start')));
    if (!s.team) {
      if (!ev.can_form_teams) {
        body.append(el('div', { class: 'notice bad' }, 'Teams are locked for this hunt. Ask the organizer if you can still join.'));
      } else {
        const name = el('input', { id: 'teamName', maxlength: 30, placeholder: 'e.g. Map Readers', autocomplete: 'off' });
        const create = el('button', { class: 'primary', type: 'submit' }, 'Create team');
        const code = el('input', { id: 'teamCode', maxlength: 8, placeholder: 'Team code', autocomplete: 'off', autocapitalize: 'characters', style: { textTransform: 'uppercase', letterSpacing: '.15em', fontWeight: '800' } });
        const join = el('button', { class: 'primary', type: 'submit' }, 'Join team');
        body.append(
          el('form', { class: 'card stack', onsubmit: async (e) => {
            e.preventDefault();
            const r = await busy(create, () => api('POST', `/api/play/${eventId}/team`, { name: name.value }));
            if (r) { toast('Team created - share the code with up to ' + (s.limits.team_max - 1) + ' friends', 'good'); load(); }
          } }, el('h3', null, 'Start a team'), el('div', { class: 'field' }, el('label', { for: 'teamName' }, 'Team name'), name), create),
          el('form', { class: 'card stack', onsubmit: async (e) => {
            e.preventDefault();
            const r = await busy(join, () => api('POST', '/api/teams/join', { code: code.value }));
            if (r) { toast('You joined the team', 'good'); load(); }
          } }, el('h3', null, 'Join a friend’s team'), el('div', { class: 'field' }, el('label', { for: 'teamCode' }, 'Team code'), code), join));
      }
    } else {
      const t = s.team;
      const isLeader = t.leader_id === s.me.id;
      body.append(el('div', { class: 'card stack' },
        el('h3', null, 'Your team: ' + t.name),
        el('div', null, el('div', { class: 'muted' }, 'Team code - friends enter this to join'), el('div', { class: 'code-box', 'data-testid': 'team-code' }, t.code)),
        el('div', { class: 'row' }, el('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(t.code); toast('Code copied', 'good'); } catch { toast('Copy the code by hand', 'bad'); } } }, 'Copy code')),
        el('div', null, el('strong', null, `Members (${t.members.length}/${t.max})`),
          t.members.map((m) => el('div', { class: 'member' }, sprite('hero', { scale: 3, color: PX.teamColor(m.display_name || m.name) }), m.display_name || m.name, m.id === t.leader_id ? el('span', { class: 'pill' }, 'leader') : null, m.id === s.me.id ? el('small', null, '(you)') : null))),
        ev.status === 'lobby' ? el('p', { class: 'notice' }, 'You are in. The first riddle appears here the moment the organizer starts the hunt.') : null,
        ev.can_form_teams ? el('button', { class: 'danger small', onclick: async () => { const r = await busy(null, () => api('POST', `/api/play/${eventId}/team/leave`)); if (r) { load(); } } }, 'Leave team') : null));
      void isLeader;
    }
    body.append(el('button', { class: 'ghost', onclick: () => go(null) }, '← All hunts'));
    mount(app, topbar(), body);
  }

  // ---------------------------------------------------------------- results
  function boardTable(s) {
    const rows = s.leaderboard || [];
    return el('table', { class: 'board' },
      el('thead', null, el('tr', null, el('th', null, '#'), el('th', null, 'Team'), el('th', null, 'Progress'))),
      el('tbody', null, rows.map((r) => el('tr', { class: s.team && r.team_id === s.team.id ? 'mine' : '' },
        el('td', null, r.rank), el('td', null, r.name), el('td', null, r.finished ? 'Found the treasure' : `${r.completed}/${r.total} stages`)))));
  }
  function renderResult() {
    const s = state; const g = s.game; const ev = s.event;
    const won = g && g.result === 'won';
    const body = el('main', { class: 'page narrow stack' });
    if (won) {
      const first = !(ev.status === 'ended' && ev.winner && s.team && ev.winner.team_id !== s.team.id);
      body.append(el('div', { class: 'card stack finale' },
        el('div', { class: 'bob', 'aria-hidden': 'true' }, sprite('chestOpen', { scale: 10 })),
        el('div', { class: 'big' }, first ? 'Your team found the treasure!' : 'You found it!'),
        el('p', null, ev.winner ? `Winner: ${ev.winner.name}` : ''),
        flash ? el('div', { class: 'result-flash good' }, flash.text) : null));
      if (resultPlayed !== 'win') { resultPlayed = 'win'; sfx.play('win'); PX.confetti(document.body, 80); }
    } else if (ev.status === 'ended') {
      body.append(el('div', { class: 'card stack finale' },
        el('div', { 'aria-hidden': 'true' }, sprite('skull', { scale: 8 })),
        el('div', { class: 'big lose' }, 'The hunt is over'),
        el('p', null, ev.winner ? `${ev.winner.name} found the treasure first.` : 'The organizer ended the hunt.')));
      if (resultPlayed !== 'lose') { resultPlayed = 'lose'; sfx.play('lose'); }
    }
    body.append(el('div', { class: 'card' }, el('h3', null, sprite('trophy', { scale: 3 }), ' Standings'), boardTable(s)));
    body.append(el('button', { onclick: () => go(null) }, '← All hunts'));
    mount(app, topbar(), body);
  }

  // ================================================================ game screen
  function elapsed() { return state && state.event.started_at ? H.duration(Date.now() + clockOffset - state.event.started_at) : ''; }

  function levelBar(total, index) {
    const segs = [];
    for (let i = 0; i < total; i++) segs.push(el('i', { class: 'seg1' + (i < index ? ' done' : i === index ? ' now' : '') }));
    return el('div', { class: 'levelbar', role: 'img', 'aria-label': `Stage ${Math.min(index + 1, total)} of ${total}` },
      el('span', { class: 'lv' }, `LV ${Math.min(index + 1, total)}/${total}`), segs, el('span', { class: 'goal' }, sprite('chest', { scale: 2 })));
  }
  function hearts(g) {
    const out = [el('span', { class: 'lbl' }, 'HINTS')];
    for (let i = 0; i < g.hints.max; i++) out.push(sprite(i < g.hints.remaining ? 'heart' : 'heartEmpty', { scale: 3 }));
    return el('div', { class: 'hearts', role: 'img', 'aria-label': `${g.hints.remaining} of ${g.hints.max} hints left` }, out);
  }

  function ensureShell() {
    if (shell && shell.eventId === eventId && document.body.contains(shell.root)) return shell;
    const hud = el('div', { class: 'hud' });
    const mapBox = el('div', { 'data-testid': 'map' });
    const mapwrap = el('div', { class: 'mapwrap' }, mapBox);
    const sheet = el('div', { class: 'sheet', 'data-testid': 'sheet' });
    const root = el('div', { class: 'game' }, hud, mapwrap, sheet);
    mount(app, root);
    const map = new TMap(mapBox, { tileUrl: cfg.tile_url, attribution: cfg.tile_attribution, center: geo ? [geo.lat, geo.lng] : [20.5937, 78.9629], zoom: geo ? 17 : 4, label: 'Hunt map' });
    shell = { eventId, root, hud, sheet, map, mapBox, me: null, target: null, circle: null, targetKey: null, fitted: false, answerValue: '' };
    startGeo();
    clearInterval(tick);
    tick = setInterval(() => { const n = shell && shell.root.querySelector('[data-clock]'); if (n) n.textContent = elapsed(); }, 1000);
    return shell;
  }

  function renderGame() {
    const sh = ensureShell();
    const s = state; const g = s.game;
    // HUD
    mount(sh.hud,
      el('div', { class: 'grow' }, el('div', { class: 'name' }, s.team.name), levelBar(g.total, g.index)),
      hearts(g),
      el('span', { class: 'hud-clock', 'data-clock': true }, elapsed()),
      muteButton(),
      el('button', { onclick: showBoard }, 'Standings'));
    if (sh.lastIndex !== undefined && g.index > sh.lastIndex) { sfx.play('level'); toast('LEVEL UP! Stage ' + (g.index + 1) + ' unlocked', 'good'); }
    sh.lastIndex = g.index;
    // map overlays
    syncMap(sh, g);
    // sheet
    const keepFocus = document.activeElement && document.activeElement.id === 'answer';
    const keepVal = sh.answerValue;
    mount(sh.sheet, sheetBody(g));
    const inp = sh.sheet.querySelector('#answer');
    if (inp) { inp.value = keepVal || ''; if (keepFocus) inp.focus(); }
  }

  function syncMap(sh, g) {
    const u = g.phase === 'unlocked' ? g.unlocked : null;
    const key = u ? `${u.lat},${u.lng}` : null;
    if (key !== sh.targetKey) {
      if (sh.target) { sh.target.remove(); sh.target = null; }
      if (sh.circle) { sh.circle.remove(); sh.circle = null; }
      sh.targetKey = key;
      if (u) {
        sh.target = sh.map.addMarker(u.lat, u.lng, TMap.marks.control(u.location_name || 'Go here', { chest: g.index === g.total - 1 }));
        if (u.geofence_m) sh.circle = sh.map.addCircle(u.lat, u.lng, u.geofence_m);
        const pts = [{ lat: u.lat, lng: u.lng }]; if (geo) pts.push(geo);
        sh.map.fitPoints(pts, { maxZoom: 18 });
      }
    }
    updateMe();
  }
  function updateMe() {
    if (!shell || !geo) return;
    if (!shell.me) shell.me = shell.map.addMarker(geo.lat, geo.lng, TMap.marks.me());
    else shell.me.setLatLng(geo.lat, geo.lng);
    if (!shell.fitted && !shell.targetKey) { shell.map.setView(geo.lat, geo.lng, 17); shell.fitted = true; }
    const d = shell.sheet.querySelector('[data-distance]');
    if (d) d.textContent = distanceText();
    const c = shell.sheet.querySelector('[data-compass]');
    const u = state && state.game && state.game.unlocked;
    if (c && u) c.style.transform = `rotate(${bearing(geo, u)}deg)`;
  }
  function bearing(a, b) {
    const t = Math.PI / 180;
    const y = Math.sin((b.lng - a.lng) * t) * Math.cos(b.lat * t);
    const x = Math.cos(a.lat * t) * Math.sin(b.lat * t) - Math.sin(a.lat * t) * Math.cos(b.lat * t) * Math.cos((b.lng - a.lng) * t);
    return Math.round(((Math.atan2(y, x) / t) + 360) % 360);
  }
  function distanceText() {
    const g = state && state.game; const u = g && g.unlocked;
    if (!u) return '';
    if (!geo) return 'Location not available yet - allow location access to see how far you are.';
    const m = Math.round(TMap.distanceM(geo.lat, geo.lng, u.lat, u.lng));
    const pretty = m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
    return u.geofence_m ? `${pretty} away. Get within ${u.geofence_m} m to check in.` : `${pretty} away.`;
  }

  // ---------------------------------------------------------------- geolocation
  function startGeo() {
    if (geoWatch !== null || !navigator.geolocation) return;
    geoWatch = navigator.geolocation.watchPosition((p) => {
      geo = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy || 0 };
      updateMe();
      const now = Date.now();
      if (eventId && now - lastPing > 6000) {
        lastPing = now;
        api('POST', `/api/play/${eventId}/ping`, geo).catch(() => {});
      }
    }, () => { geo = geo || null; }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  function geoQuery() {
    return geo ? `?lat=${geo.lat}&lng=${geo.lng}&acc=${Math.round(geo.acc || 0)}` : '';
  }

  // ---------------------------------------------------------------- sheet body
  function flashBox() {
    if (!flash) return null;
    if (!flash.played) { flash.played = true; if (flash.kind === 'good') sfx.play('ok'); else if (flash.kind === 'bad') sfx.play('bad'); }
    const icon = flash.kind === 'good' ? 'star' : flash.kind === 'bad' ? 'skull' : 'scroll';
    return el('div', { class: 'result-flash ' + flash.kind, role: 'status', 'data-testid': 'flash' }, sprite(icon, { scale: 3 }), el('span', null, flash.text));
  }

  function sheetBody(g) {
    const nodes = [flashBox()];
    if (g.phase === 'riddle') nodes.push(riddleBlock(g));
    else if (g.phase === 'unlocked') nodes.push(unlockedBlock(g));
    return nodes;
  }

  function riddleBlock(g) {
    const r = g.riddle || {};
    const img = r.image_url ? el('img', { class: 'riddle-img', alt: 'Riddle picture' }) : null;
    if (img) cachedBlob(r.image_url).then((u) => { img.src = u; }).catch(() => {});
    const ans = el('input', { id: 'answer', placeholder: 'Your answer', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'Your answer', oninput: (e) => { if (shell) shell.answerValue = e.target.value; } });
    const go = el('button', { class: 'primary', type: 'submit' }, 'Check answer');
    const form = el('form', { class: 'row', style: { flexWrap: 'nowrap' }, onsubmit: async (e) => {
      e.preventDefault();
      const v = ans.value.trim();
      if (!v) { toast('Type your answer first', 'bad'); return; }
      const res = await busy(go, () => api('POST', `/api/play/${eventId}/answer`, { answer: v }));
      if (!res) return;
      if (res.correct) { flash = { kind: 'good', text: res.message }; if (shell) shell.answerValue = ''; }
      else { flash = { kind: 'bad', text: res.message }; }
      await load();
    } }, el('div', { class: 'grow' }, ans), go);
    const hints = el('ul', { class: 'hint-list' }, (g.stage_hints || []).map((h) => el('li', { 'data-testid': 'hint' }, el('small', null, `Hint ${h.level}${h.source === 'ai' ? ' (AI)' : ''}`), h.text)));
    const hintBtn = el('button', { class: 'small', 'data-testid': 'hint-btn', disabled: !g.can_hint, onclick: async (e) => {
      const b = e.currentTarget;
      if (Date.now() - hintArmed > 4000) {
        hintArmed = Date.now();
        b.textContent = `Tap again to spend 1 of your ${g.hints.remaining} remaining hints`;
        setTimeout(() => { if (b.isConnected && Date.now() - hintArmed >= 3900) b.textContent = hintLabel(g); }, 4100);
        return;
      }
      hintArmed = 0;
      b.textContent = 'Thinking up a hint…';
      const res = await busy(b, () => api('POST', `/api/play/${eventId}/hint`));
      if (res) sfx.play('hint');
      if (res) flash = { kind: 'wait', text: `Hint used - ${res.hints.remaining} left for the whole hunt.` };
      await load();
    } }, hintLabel(g));
    const riddle = el('div', { class: 'riddle', 'data-testid': 'riddle' });
    if (shell && shell.typed !== g.index) { shell.typed = g.index; PX.typewrite(riddle, r.text || ''); } else riddle.textContent = r.text || '';
    return el('div', null,
      el('div', { class: 'quest' }, sprite('scroll', { scale: 3 }), `QUEST ${g.index + 1}/${g.total}`),
      riddle, img,
      hints, form,
      el('div', { class: 'row', style: { marginTop: '.7rem', justifyContent: 'space-between' } }, hintBtn, el('small', null, `${g.hints.remaining} of ${g.hints.max} hints left`)));
  }
  function hintLabel(g) {
    return g.hints.remaining > 0 ? 'Get a hint' : 'No hints left';
  }

  function unlockedBlock(g) {
    const u = g.unlocked;
    const wantsPhoto = u.verify_type === 'photo' || u.verify_type === 'either';
    const wantsQr = u.verify_type === 'qr' || u.verify_type === 'either';
    const img = u.target_image_url ? el('img', { class: 'target-img', alt: 'Photo to match' }) : null;
    if (img) cachedBlob(u.target_image_url).then((x) => { img.src = x; }).catch(() => {});
    // two inputs: one asks the phone for its camera, one opens the gallery/file picker (works even when the camera is blocked)
    const file = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', id: 'photoInput', 'data-testid': 'photo-input', tabindex: '-1' });
    const fileCam = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'sr-only', 'data-testid': 'photo-input-camera', tabindex: '-1' });
    const photoBtn = el('button', { class: 'accent', 'data-testid': 'photo-btn', onclick: () => fileCam.click() }, 'Take photo');
    photoBtn.prepend(sprite('camera', { scale: 3 }));
    const uploadBtn = el('button', { 'data-testid': 'upload-btn', onclick: () => file.click() }, 'Upload photo');
    for (const inp of [file, fileCam]) inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      inp.value = '';
      if (f) await sendPhoto(f, photoBtn);
    });
    const qrFile = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', 'data-testid': 'qr-file', tabindex: '-1' });
    qrFile.addEventListener('change', async () => {
      const f = qrFile.files && qrFile.files[0];
      qrFile.value = '';
      if (f) await scanFromFile(f);
    });
    return el('div', null,
      el('div', { class: 'quest' }, sprite(g.index === g.total - 1 ? 'chest' : 'flag', { scale: 3 }), `STAGE ${g.index + 1}/${g.total}${g.index === g.total - 1 ? ' - THE TREASURE' : ''}`),
      el('h2', { 'data-testid': 'place' }, u.location_name || 'Your next checkpoint'),
      el('div', { class: 'dist' },
        el('div', { class: 'compass', 'aria-hidden': 'true' }, el('span', { class: 'arrow px', 'data-compass': true, style: { transform: geo ? `rotate(${bearing(geo, u)}deg)` : 'none' } }, '▲')),
        el('p', { 'data-distance': true, 'data-testid': 'distance', style: { margin: 0 } }, distanceText())),
      g.pending_review ? el('div', { class: 'notice', 'data-testid': 'pending' }, 'Your last photo is with the organizer for a manual check. You will move on as soon as they approve it.') : null,
      el('div', { class: 'row', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } },
        img,
        el('div', { class: 'grow' },
          wantsPhoto ? el('p', null, el('strong', null, 'Find and photograph: '), u.object_description || 'the object described by the organizer') : null,
          wantsQr && !wantsPhoto ? el('p', null, 'Find the QR code at this spot and scan it.') : null,
          wantsPhoto && wantsQr ? el('p', { class: 'muted' }, 'Or scan the QR code if you can find it.') : null)),
      el('div', { class: 'btn-row2' },
        wantsPhoto ? [photoBtn, uploadBtn, file, fileCam] : null,
        wantsQr ? el('button', { class: wantsPhoto ? '' : 'accent', 'data-testid': 'scan-btn', onclick: openScanner }, sprite('qr', { scale: 3 }), 'Scan QR code') : null,
        wantsQr ? el('button', { 'data-testid': 'qr-upload-btn', onclick: () => qrFile.click() }, 'Upload QR picture') : null,
        wantsQr ? qrFile : null));
  }

  async function cachedBlob(url) {
    if (blobCache.has(url)) return blobCache.get(url);
    const p = authBlobUrl(url);
    blobCache.set(url, p);
    p.catch(() => blobCache.delete(url));
    return p;
  }

  // ---------------------------------------------------------------- photo
  async function toJpeg(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const max = 1280;
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
      if (blob) return blob;
    } catch { /* fall through to the original file */ }
    return file;
  }
  async function sendPhoto(file, btn) {
    flash = { kind: 'wait', text: 'Checking your photo - this can take up to a minute…' };
    if (shell) mount(shell.sheet, sheetBody(state.game));
    const blob = await toJpeg(file);
    let res;
    try {
      res = await upload(`/api/play/${eventId}/photo${geoQuery()}`, blob);
    } catch (e) {
      flash = { kind: 'bad', text: errMsg(e) };
      await load();
      if (shell) mount(shell.sheet, sheetBody(state.game));
      return;
    }
    if (res.result === 'passed') flash = { kind: 'good', text: res.message + (Number.isFinite(res.score) ? ` (match ${Math.round(res.score)}%)` : '') };
    else if (res.result === 'pending') flash = { kind: 'wait', text: res.message };
    else flash = { kind: 'bad', text: res.message + (Number.isFinite(res.score) ? ` (match ${Math.round(res.score)}%)` : '') };
    await load();
  }

  // ---------------------------------------------------------------- QR scanner
  /** read a QR code out of a picture: the browser's own detector when it has one, then our decoder */
  async function decodeQrFromFile(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return null; }
    try {
      if ('BarcodeDetector' in window) {
        try { const found = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bmp); if (found.length) return found[0].rawValue; } catch { /* fall through */ }
      }
      return QRDecode.fromSource(bmp, { sizes: [1000, 640, 1500, 420] });
    } finally { if (bmp.close) bmp.close(); }
  }
  async function scanFromFile(file) {
    toast('Reading the picture…');
    const raw = await decodeQrFromFile(file);
    if (!raw) { toast('No QR code found in that picture. Retake it closer, with the whole code in view and not blurry.', 'bad'); return; }
    try {
      const r = await api('POST', `/api/play/${eventId}/scan`, { code: raw, geo });
      flash = r.result === 'passed' ? { kind: 'good', text: r.message } : { kind: 'bad', text: r.message };
      await load();
      if (shell) mount(shell.sheet, sheetBody(state.game));
    } catch (e) { toast(errMsg(e), 'bad'); }
  }

  function openScanner() {
    let stopped = false;
    let stream_ = null;
    let timer = null;
    const video = el('video', { playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera view' });
    video.setAttribute('playsinline', ''); video.muted = true;
    const msg = el('div', { class: 'scan-msg', role: 'status' }, 'Starting the camera…');
    const code = el('input', { placeholder: 'Or type the code', autocomplete: 'off', 'aria-label': 'Checkpoint code', 'data-testid': 'scan-input' });
    const send = el('button', { class: 'primary', 'data-testid': 'scan-send' }, 'Submit code');
    const upload = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'data-testid': 'scan-file' });
    const uploadBtn = el('button', { onclick: () => upload.click() }, 'Upload QR picture');
    const close = el('button', { onclick: () => stop() }, 'Close');
    const box = el('div', { class: 'scanner', role: 'dialog', 'aria-label': 'Scan QR code' }, video, el('div', { class: 'bar' }, msg, code, send, uploadBtn, upload, close));
    document.body.append(box);
    function stop() {
      stopped = true; clearInterval(timer);
      if (stream_) stream_.getTracks().forEach((t) => t.stop());
      box.remove();
    }
    const bad = (text) => { msg.textContent = text; msg.classList.add('bad'); };
    let inflight = false;
    let cooling = false; // camera frames are ignored briefly after a miss; typed or uploaded codes never are
    async function submit(raw) {
      if (!raw || inflight) return;
      inflight = true;
      send.disabled = true;
      try {
        const r = await api('POST', `/api/play/${eventId}/scan`, { code: raw, geo });
        if (r.result === 'passed') {
          flash = { kind: 'good', text: r.message };
          stop();
          await load();
          return;
        }
        bad(r.message || 'That code does not match this checkpoint.');
      } catch (e) {
        bad(errMsg(e));
      }
      send.disabled = false;
      inflight = false;
      cooling = true;
      setTimeout(() => { cooling = false; }, 1500);
    }
    send.addEventListener('click', () => submit(code.value.trim()));
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(code.value.trim()); });
    upload.addEventListener('change', async () => {
      const f = upload.files && upload.files[0];
      upload.value = '';
      if (!f) return;
      msg.classList.remove('bad'); msg.textContent = 'Reading the picture…';
      const raw = await decodeQrFromFile(f);
      if (!raw) { bad('No QR code found in that picture. Retake it closer, with the whole code in view.'); return; }
      submit(raw);
    });
    (async () => {
      const noCam = (why) => { video.classList.add('hidden'); msg.textContent = why + ' You can still upload a picture of the QR code, or type the code.'; };
      if (!window.isSecureContext) { noCam('The camera only works on a secure (https) address.'); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { noCam('This browser does not allow camera access here.'); return; }
      try {
        const native = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
        stream_ = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (stopped) { stream_.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream_;
        await video.play().catch(() => {});
        msg.textContent = 'Point the camera at the checkpoint QR code.';
        let busyScan = false;
        timer = setInterval(async () => {
          if (busyScan || stopped || video.readyState < 2 || cooling || inflight) return;
          busyScan = true;
          try {
            let raw = null;
            if (native) { try { const found = await native.detect(video); if (found.length) raw = found[0].rawValue; } catch { /* use our decoder */ } }
            if (!raw) raw = QRDecode.fromSource(video, { sizes: [720] });
            if (raw) submit(raw);
          } catch { /* ignore frame errors */ }
          busyScan = false;
        }, 350);
      } catch (e) {
        noCam(e && e.name === 'NotAllowedError' ? 'Camera permission was denied - allow it in your browser settings.' : 'Could not start the camera.');
      }
    })();
    code.focus();
  }

  // ---------------------------------------------------------------- standings
  function showBoard() {
    const card = el('div', { class: 'card stack' }, el('h3', null, 'Standings'), boardTable(state), el('button', { onclick: () => box.remove() }, 'Close'));
    const box = el('div', { class: 'overlay-card', onclick: (e) => { if (e.target === box) box.remove(); } }, card);
    document.body.append(box);
  }

  // ================================================================ boot
  (async function boot() {
    if (!H.session.token()) { readHash(); location.replace('/'); return; }
    readHash(); // stashes a #scan= token before any redirect
    try { user = await H.requireRole('participant'); } catch (e) { toast(errMsg(e), 'bad'); return; }
    if (!user) return;
    try { cfg = await api('GET', '/api/config'); } catch { /* defaults */ }
    route();
  })();
})();
