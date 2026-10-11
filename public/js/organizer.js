(function () {
  'use strict';
  const { api, upload, el, mount, toast, errMsg, busy, stream, debounce, authBlobUrl, authText, ago, fmtTime } = H;
  const app = document.getElementById('app');
  const { sprite, sfx } = PX;
  document.addEventListener('click', (e) => { if (e.target.closest('button')) sfx.play('click'); });

  let user = null;
  let cfg = { tile_url: '', tile_attribution: '' };
  let evId = null;
  let D = null; // dashboard
  let tab = null;
  let selStage = null;
  let live = null;
  let ui = null;
  let liveMap = null;
  let liveMapFitted = false;
  let aiStatus = null;
  let ticker = null;

  const STATUS = { lobby: ['Setting up', 'warn'], running: ['Live', 'pink'], ended: ['Ended', ''] };

  // ================================================================ routing / chrome
  function route() {
    const m = /^#ev\/(\d+)(?:\/(stages|live|settings))?$/.exec(location.hash);
    if (m) openEvent(Number(m[1]), m[2]); else openList();
  }
  window.addEventListener('hashchange', route);

  function leave() {
    if (live) { live.stop(); live = null; }
    clearInterval(ticker); ticker = null;
    if (liveMap) { liveMap.destroy(); liveMap = null; }
    ui = null; D = null; evId = null; liveMapFitted = false;
  }
  function topbar() {
    return el('header', { class: 'topbar' },
      el('a', { class: 'logo', href: '#' }, H.LOGO(), 'Treasure Hunt', el('small', null, 'GAME MASTER')),
      el('span', { class: 'grow' }),
      el('button', { class: 'small', 'aria-label': 'Toggle sound', onclick: (e) => { e.currentTarget.textContent = sfx.toggle() ? 'SND OFF' : 'SND ON'; } }, sfx.muted() ? 'SND OFF' : 'SND ON'),
      el('span', { class: 'who' }, user.display_name),
      el('button', { class: 'small', onclick: () => H.logout() }, 'Sign out'));
  }
  function confirmClick(label, action, cls) {
    let armed = 0;
    const b = el('button', { class: cls || 'danger small', onclick: async () => {
      if (Date.now() - armed > 3500) { armed = Date.now(); b.textContent = 'Click again to confirm'; setTimeout(() => { if (b.isConnected && Date.now() - armed >= 3400) b.textContent = label; }, 3600); return; }
      armed = 0; b.textContent = label;
      await busy(b, action);
    } }, label);
    return b;
  }

  // ================================================================ events list
  async function openList() {
    leave();
    mount(app, topbar(), el('main', { class: 'page stack', id: 'list' }, el('p', { class: 'muted' }, 'Loading…')));
    let events = [];
    try { events = (await api('GET', '/api/events')).events; } catch (e) { toast(errMsg(e), 'bad'); }
    const name = el('input', { id: 'newName', placeholder: 'e.g. Campus Treasure Hunt 2026', maxlength: 80 });
    const create = el('button', { class: 'primary', type: 'submit' }, 'Create hunt');
    const form = el('form', { class: 'card row', style: { alignItems: 'flex-end' }, onsubmit: async (e) => {
      e.preventDefault();
      const ev = await busy(create, () => api('POST', '/api/events', { name: name.value }));
      if (ev) location.hash = `ev/${ev.id}/stages`;
    } }, el('div', { class: 'field grow', style: { margin: 0 } }, el('label', { for: 'newName' }, 'New hunt'), name), create);
    const cards = events.length ? events.map((e) => {
      const [label, cls] = STATUS[e.status] || [e.status, ''];
      return el('div', { class: 'card row', 'data-testid': 'event-card' }, sprite('chest', { scale: 4 }),
        el('div', { class: 'grow' }, el('h3', null, e.name), el('small', null, `${e.stage_count} stages · ${e.team_count} teams · code `), el('strong', null, e.code)),
        el('span', { class: 'pill ' + cls }, label),
        el('a', { class: 'btn', href: `#ev/${e.id}` }, 'Open'));
    }) : [el('div', { class: 'empty' }, 'No hunts yet. Name your first one above, then add riddles and pin their locations on the map.')];
    mount(document.getElementById('list'), el('h1', null, 'Your hunts'), form, cards);
  }

  // ================================================================ event view
  async function openEvent(id, wantTab) {
    if (evId !== id) { leave(); evId = id; selStage = null; }
    if (!D) {
      mount(app, topbar(), el('main', { class: 'page' }, el('p', { class: 'muted' }, 'Loading…')));
      try { D = await api('GET', `/api/events/${id}/dashboard`); } catch (e) { toast(errMsg(e), 'bad'); location.hash = ''; return; }
      api('GET', '/api/ai/status').then((s) => { aiStatus = s; paintHead(); }).catch(() => {});
      const refresh = debounce(() => reload(), 200);
      live = stream(`/api/events/${id}/stream`, () => refresh(), () => {});
      ticker = setInterval(() => { if (tab === 'live') paintLive(); }, 15000);
    }
    tab = wantTab || tab || (D.event.status === 'lobby' ? 'stages' : 'live');
    buildShell();
  }

  async function reload() {
    if (!evId) return;
    let fresh;
    try { fresh = await api('GET', `/api/events/${evId}/dashboard`); } catch { return; }
    const statusChanged = D && fresh.event.status !== D.event.status;
    D = fresh;
    if (!ui) return;
    paintHead();
    if (statusChanged) { if (fresh.event.status !== 'lobby' && tab === 'stages') tab = 'live'; buildShell(); return; }
    if (tab === 'live') paintLive();
    else if (tab === 'stages') paintStageList();
  }

  function buildShell() {
    ui = { head: el('div'), problems: el('div'), tabs: el('div', { class: 'tabs', role: 'tablist' }), body: el('div', { class: 'tab-body' }) };
    mount(app, topbar(), el('main', { class: 'page' }, el('a', { href: '#', class: 'muted' }, '← All hunts'), ui.head, ui.problems, ui.tabs, ui.body));
    paintHead();
    paintTabs();
    buildTab();
  }

  function paintTabs() {
    const defs = [['stages', 'Stages'], ['live', 'Teams & live'], ['settings', 'Settings']];
    mount(ui.tabs, defs.map(([k, label]) => el('button', { role: 'tab', 'aria-selected': String(tab === k), 'data-testid': 'tab-' + k, onclick: () => { location.hash = `ev/${evId}/${k}`; if (tab !== k) { tab = k; paintTabs(); buildTab(); } } }, label)));
  }

  function paintHead() {
    if (!ui) return;
    const ev = D.event;
    const [label, cls] = STATUS[ev.status] || [ev.status, ''];
    const start = el('button', { class: 'primary', 'data-testid': 'start-btn', disabled: ev.status !== 'lobby' || D.problems.length > 0, onclick: async (e) => {
      const r = await busy(e.currentTarget, () => api('POST', `/api/events/${evId}/start`));
      if (r) toast('The hunt is live!', 'good');
    } }, 'Start hunt');
    const actions = [];
    if (ev.status === 'lobby') actions.push(start);
    if (ev.status === 'running') actions.push(confirmClick('End hunt now', async () => { await api('POST', `/api/events/${evId}/end`); toast('Hunt ended'); }));
    if (ev.status !== 'lobby') actions.push(confirmClick('Reset to setup', async () => { await api('POST', `/api/events/${evId}/reset`); toast('Progress cleared - back to setup', 'good'); }, 'small danger'));
    if (ev.status === 'lobby') actions.push(confirmClick('Delete hunt', async () => { await api('DELETE', `/api/events/${evId}`); location.hash = ''; }));
    let ai = null;
    if (aiStatus) {
      ai = el('span', { class: 'pill ' + (aiStatus.ok ? '' : 'warn'), title: aiStatus.detail || '', 'data-testid': 'ai-status' },
        aiStatus.provider === 'off' ? 'AI off' : aiStatus.ok ? `AI ready${aiStatus.model ? ' · ' + aiStatus.model : ''}` : 'AI not reachable');
    }
    mount(ui.head, el('div', { class: 'evhead' },
      el('div', null, el('h1', null, ev.name), el('div', { class: 'row tight', style: { marginTop: '.4rem' } }, el('span', { class: 'pill ' + cls, 'data-testid': 'status' }, label), ai,
        ev.winner ? el('span', { class: 'pill warn' }, sprite('trophy', { scale: 2 }), ev.winner.name) : null)),
      el('div', null, el('div', { class: 'muted' }), el('div', { class: 'big-code', 'data-testid': 'event-code' }, ev.code)),
      el('div', { class: 'row' }, actions)));
    const probs = ev.status === 'lobby' ? D.problems : [];
    mount(ui.problems, probs.length ? el('div', { class: 'notice', style: { marginBottom: '1rem' }, 'data-testid': 'problems' }, el('strong', null, 'Before you can start:'), el('ul', null, probs.map((p) => el('li', null, p)))) : null);
  }

  function buildTab() {
    liveMapFitted = liveMapFitted && tab === 'live';
    if (liveMap) { liveMap.destroy(); liveMap = null; }
    if (tab === 'stages') buildStages();
    else if (tab === 'live') buildLive();
    else buildSettings();
  }

  // ================================================================ stages tab
  let st = null; // stage editor refs

  function stageById(id) { return D.stages.find((s) => s.id === id); }

  function buildStages() {
    ui.list = el('div', { class: 'stack', 'data-testid': 'stage-list' });
    ui.editor = el('div', { class: 'card stack', 'data-testid': 'stage-editor' });
    mount(ui.body, el('div', { class: 'grid2' }, el('div', { class: 'stack' }, ui.list), ui.editor));
    if (!selStage || !stageById(selStage)) selStage = D.stages[0] ? D.stages[0].id : null;
    paintStageList();
    buildEditor();
  }

  function locked() { return D.event.status !== 'lobby'; }

  function paintStageList() {
    if (!ui || !ui.list) return;
    const nodes = D.stages.map((s, i) => {
      const last = i === D.stages.length - 1;
      const ready = s.riddle_text && s.answers.length && s.lat !== null;
      return el('div', { class: 'row tight', style: { flexWrap: 'nowrap' } },
        el('button', { class: 'stage-item', 'aria-current': String(s.id === selStage), 'data-testid': 'stage-item', onclick: () => { selStage = s.id; paintStageList(); buildEditor(); } },
          el('span', { class: 'sym' + (last ? ' last' : '') }, last ? sprite('chest', { scale: 2 }) : i + 1),
          el('span', { class: 't grow' }, s.title || `Stage ${i + 1}`, last ? el('small', null, ' · treasure') : null),
          ready ? null : el('span', { class: 'pill warn', title: 'Needs riddle, answer and location' }, 'draft')),
        locked() ? null : el('div', { class: 'stack', style: { display: 'grid', gap: '2px' } },
          el('button', { class: 'small ghost', 'aria-label': 'Move up', disabled: i === 0, style: { minHeight: '22px', padding: '0 .4rem' }, onclick: () => move(i, -1) }, '▲'),
          el('button', { class: 'small ghost', 'aria-label': 'Move down', disabled: last, style: { minHeight: '22px', padding: '0 .4rem' }, onclick: () => move(i, 1) }, '▼')));
    });
    mount(ui.list,
      D.stages.length ? nodes : el('div', { class: 'empty' }, 'No stages yet. Each stage is one riddle, one place on the map, and one proof (photo or QR). The last stage is the treasure.'),
      locked() ? el('div', { class: 'notice' }, 'Stages are locked while the hunt is running. Reset to setup to edit them.') :
        el('button', { class: 'primary block', 'data-testid': 'add-stage', onclick: async (e) => {
          const s = await busy(e.currentTarget, () => api('POST', `/api/events/${evId}/stages`, {}));
          if (s) { selStage = s.id; await reload(); paintStageList(); buildEditor(); }
        } }, '+ Add stage'),
      D.stages.some((s) => s.verify_type !== 'photo') ? el('button', { class: 'block', onclick: printQrs }, 'Print QR codes') : null);
  }

  async function move(i, d) {
    const ids = D.stages.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api('POST', `/api/events/${evId}/stages/reorder`, { order: ids }); await reload(); } catch (e) { toast(errMsg(e), 'bad'); }
  }

  function field(label, input, hint, id) {
    return el('div', { class: 'field' }, el('label', { for: id }, label), input, hint ? el('div', { class: 'hint' }, hint) : null);
  }

  function buildEditor() {
    st = null;
    const s = selStage ? stageById(selStage) : null;
    if (!s) { mount(ui.editor, el('div', { class: 'empty' }, 'Add a stage to start building your hunt.')); return; }
    const idx = D.stages.findIndex((x) => x.id === s.id);
    const isLast = idx === D.stages.length - 1;
    const ro = locked();
    const f = {};
    f.title = el('input', { id: 'f-title', value: s.title, maxlength: 80 });
    f.riddle = el('textarea', { id: 'f-riddle', rows: 4, maxlength: 1500, placeholder: 'I have hands but cannot clap…' }); f.riddle.value = s.riddle_text || '';
    f.answers = el('textarea', { id: 'f-answers', rows: 3, placeholder: 'clock\nthe clock\nclock tower' }); f.answers.value = s.answers.join('\n');
    f.hints = el('textarea', { id: 'f-hints', rows: 3, placeholder: 'Optional. Up to 3 lines, from vague to clear.' }); f.hints.value = s.hints.join('\n');
    f.place = el('input', { id: 'f-place', value: s.location_name || '', maxlength: 100, placeholder: 'e.g. Library fountain' });
    f.lat = el('input', { id: 'f-lat', type: 'number', step: 'any', value: s.lat ?? '', 'aria-label': 'Latitude' });
    f.lng = el('input', { id: 'f-lng', type: 'number', step: 'any', value: s.lng ?? '', 'aria-label': 'Longitude' });
    f.geofence = el('input', { id: 'f-geofence', type: 'number', min: 0, max: 5000, value: s.geofence_m });
    f.verify = el('select', { id: 'f-verify' }, [['photo', 'Photo of an object'], ['qr', 'QR code'], ['either', 'Photo or QR code']].map(([v, l]) => el('option', { value: v, selected: s.verify_type === v }, l)));
    f.object = el('input', { id: 'f-object', value: s.object_description || '', maxlength: 300, placeholder: 'e.g. the brass plaque on the left of the fountain' });
    f.thr = el('input', { id: 'f-thr', type: 'number', min: 50, max: 100, value: s.match_threshold ?? '', placeholder: String(D.event.settings.match_threshold) });
    f.review = el('input', { id: 'f-review', type: 'number', min: 0, max: 99, value: s.review_min ?? '', placeholder: String(D.event.settings.review_min) });
    f.allowReview = el('input', { id: 'f-allowreview', type: 'checkbox' }); f.allowReview.checked = s.allow_review;
    f.success = el('textarea', { id: 'f-success', rows: 2, maxlength: 300, placeholder: 'Shown to the team when they clear this stage.' }); f.success.value = s.success_message || '';
    st = f;

    // location picker
    const mapBox = el('div', { class: 'pick-map', 'data-testid': 'pick-map' });
    const pickInfo = el('div', { class: 'muted', id: 'pickInfo' }, ro ? '' : 'Click the map to place the checkpoint.');
    let map; let marker = null; let circle = null;
    const placeMarker = () => {
      const la = parseFloat(f.lat.value); const ln = parseFloat(f.lng.value);
      if (marker) { marker.remove(); marker = null; }
      if (circle) { circle.remove(); circle = null; }
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        marker = map.addMarker(la, ln, TMap.marks.control(String(idx + 1), { pulse: false }));
        const g = parseInt(f.geofence.value, 10);
        if (g > 0) circle = map.addCircle(la, ln, g);
      }
    };
    const others = D.stages.filter((x) => x.id !== s.id && x.lat !== null);
    const c0 = s.lat !== null ? [s.lat, s.lng] : others[0] ? [others[0].lat, others[0].lng] : [20.5937, 78.9629];
    const editorEls = [
      el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('h2', null, `Stage ${idx + 1}${isLast ? ' - the treasure' : ''}`), ro ? null : confirmClick('Delete stage', async () => { await api('DELETE', `/api/stages/${s.id}`); selStage = null; await reload(); paintStageList(); buildEditor(); })),
      el('fieldset', { style: { border: 0, padding: 0, margin: 0, minWidth: 0 }, disabled: ro },
        el('section', { class: 'sect' },
          el('h3', null, el('span', { class: 'num px' }, '1'), 'The riddle'),
          field('Title (only you see this)', f.title, null, 'f-title'),
          field('Riddle', f.riddle, 'Teams see this first. Solving it unlocks the location on their map.', 'f-riddle'),
          field('Accepted answers (one per line)', f.answers, 'Capitals, spacing and small typos are forgiven.', 'f-answers'),
          riddleImageBlock(s, ro),
          field('Fallback hints (optional)', f.hints, 'Written by you. Used when the AI is offline; the AI writes fresh hints otherwise.', 'f-hints'),
          el('div', { class: 'row' }, el('button', { type: 'button', class: 'small', 'data-testid': 'hint-preview', onclick: async (e) => {
            const r = await busy(e.currentTarget, async () => { await save(true); return api('POST', `/api/stages/${s.id}/hint-preview`, { level: 1 }); });
            if (r) mount(prevBox, el('div', { class: 'notice good' }, el('strong', null, `Sample level-1 hint (${r.source === 'ai' ? 'AI' : r.source}): `), r.text));
          } }, 'Preview an AI hint')),
          el('div', { 'data-testid': 'hint-prev', style: { marginTop: '10px' } })),
        el('section', { class: 'sect' },
          el('h3', null, el('span', { class: 'num px' }, '2'), 'Where is it?'),
          field('Place name (teams see it once they solve the riddle)', f.place, null, 'f-place'),
          el('div', { class: 'loc-grid' },
            el('div', null, mapBox, pickInfo),
            el('div', { class: 'loc-side' },
              el('div', { class: 'split' }, field('Latitude', f.lat, null, 'f-lat'), field('Longitude', f.lng, null, 'f-lng')),
              ro ? null : el('div', { class: 'btn-row' }, el('button', { type: 'button', class: 'small', onclick: () => {
                if (!navigator.geolocation) { toast('This browser has no location access', 'bad'); return; }
                navigator.geolocation.getCurrentPosition((p) => { f.lat.value = p.coords.latitude.toFixed(6); f.lng.value = p.coords.longitude.toFixed(6); placeMarker(); map.setView(p.coords.latitude, p.coords.longitude, 18); }, () => toast('Could not read your location', 'bad'), { enableHighAccuracy: true, timeout: 15000 });
              } }, 'Use my current location')),
              field('Check-in radius (metres, 0 = no GPS check)', f.geofence, 'Teams must be within this distance to submit a photo or code. Use 30-60 m outdoors, more near tall buildings.', 'f-geofence')))),
        el('section', { class: 'sect' },
          el('h3', null, el('span', { class: 'num px' }, '3'), 'Proof of arrival'),
          field('How do teams prove they are there?', f.verify, null, 'f-verify'),
          el('div', { 'data-photo-part': true },
            field('What should they photograph?', f.object, 'The AI uses this together with your target photo.', 'f-object'),
            targetImageBlock(s, ro),
            el('div', { class: 'split', style: { marginTop: '14px' } }, field('Match score to pass (blank = event default)', f.thr, null, 'f-thr'), field('Send to you for review from (blank = default)', f.review, null, 'f-review')),
            el('div', { class: 'check' }, f.allowReview, el('label', { for: 'f-allowreview' }, 'Let borderline or AI-down photos wait for my approval'))),
          qrBlock(s, ro)),
        el('section', { class: 'sect' },
          el('h3', null, el('span', { class: 'num px' }, '4'), 'When they clear it'),
          field('Message when cleared (optional)', f.success, null, 'f-success'))),
    ];
    const prevBox = editorEls[1].querySelector('[data-testid="hint-prev"]');
    ro || editorEls.push(el('div', { class: 'savebar' }, el('button', { class: 'primary', 'data-testid': 'save-stage', onclick: (e) => busy(e.currentTarget, async () => { await save(); toast('Stage saved', 'good'); }) }, 'Save stage')));
    mount(ui.editor, editorEls);

    const toggleVerify = () => {
      const photo = f.verify.value !== 'qr';
      ui.editor.querySelector('[data-photo-part]').classList.toggle('hidden', !photo);
      const q = ui.editor.querySelector('[data-qr-part]'); if (q) q.classList.toggle('hidden', f.verify.value === 'photo');
    };
    f.verify.addEventListener('change', toggleVerify);
    toggleVerify();

    map = new TMap(mapBox, { tileUrl: cfg.tile_url, attribution: cfg.tile_attribution, center: c0, zoom: s.lat !== null ? 17 : others.length ? 15 : 5, label: 'Pick the checkpoint location' });
    for (const o of others) map.addMarker(o.lat, o.lng, TMap.marks.control(String(D.stages.indexOf(o) + 1), { pulse: false, small: true }));
    placeMarker();
    if (!ro) {
      map.onClick((la, ln) => { f.lat.value = la.toFixed(6); f.lng.value = ln.toFixed(6); placeMarker(); pickInfo.textContent = `Pinned at ${la.toFixed(5)}, ${ln.toFixed(5)}`; });
      for (const i of [f.lat, f.lng, f.geofence]) i.addEventListener('input', placeMarker);
    }

    f.save = save;
    async function save(quiet) {
      const num = (v) => (String(v).trim() === '' ? null : Number(v));
      const body = {
        title: f.title.value, riddle_text: f.riddle.value,
        answers: f.answers.value.split('\n'), hints: f.hints.value.split('\n'),
        location_name: f.place.value, geofence_m: Number(f.geofence.value || 0),
        verify_type: f.verify.value, object_description: f.object.value,
        match_threshold: num(f.thr.value), review_min: num(f.review.value),
        allow_review: f.allowReview.checked, success_message: f.success.value,
      };
      const la = num(f.lat.value); const ln = num(f.lng.value);
      body.lat = la; body.lng = ln;
      await api('PATCH', `/api/stages/${s.id}`, body);
      await reload();
      if (!quiet) paintStageList();
    }
  }

  /** keep what the organizer has typed before anything that rebuilds the form */
  async function autosave() { if (st && st.save && !locked()) await st.save(true); }

  function imageBlock(s, role, hasImage, label, hint, ro) {
    const preview = el('img', { alt: label + ' preview', style: { maxWidth: '180px', maxHeight: '140px', borderRadius: '8px', border: '2px solid var(--ink)', display: hasImage ? 'block' : 'none' } });
    if (hasImage) authBlobUrl(`/api/stages/${s.id}/image/${role}`).then((u) => { preview.src = u; }).catch(() => { preview.style.display = 'none'; });
    const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'data-testid': 'upload-' + role, 'aria-label': label });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const r = await busy(input, async () => { await autosave(); return upload(`/api/stages/${s.id}/image/${role}`, file); });
      input.value = '';
      if (r) { toast(label + ' uploaded', 'good'); await reload(); buildEditor(); }
    });
    return el('div', { class: 'field' }, el('label', null, label), preview,
      ro ? null : el('div', { class: 'row', style: { marginTop: '.4rem' } }, input,
        hasImage ? el('button', { type: 'button', class: 'small danger', onclick: async () => { const r = await busy(null, async () => { await autosave(); return api('DELETE', `/api/stages/${s.id}/image/${role}`); }); if (r) { await reload(); buildEditor(); } } }, 'Remove') : null),
      hint ? el('div', { class: 'hint' }, hint) : null);
  }
  function riddleImageBlock(s, ro) { return imageBlock(s, 'riddle', s.has_riddle_image, 'Riddle picture (optional)', 'Shown under the riddle text.', ro); }
  function targetImageBlock(s, ro) { return imageBlock(s, 'target', s.has_target_image, 'Target photo', 'A clear photo of the object, taken from where teams will stand. Teams compare against this.', ro); }

  function qrBlock(s, ro) {
    const preview = el('div', { class: 'qr-preview', 'data-testid': 'qr-preview', 'aria-label': 'QR code' });
    const load = () => authText(`/api/stages/${s.id}/qr.svg?base=${encodeURIComponent(location.origin)}`).then((svg) => { preview.innerHTML = svg; }).catch(() => { preview.textContent = 'QR unavailable'; });
    load();
    return el('div', { 'data-qr-part': true, class: 'field' },
      el('label', null, 'Checkpoint QR code'),
      el('div', { class: 'row', style: { alignItems: 'flex-start' } }, preview,
        el('div', { class: 'stack grow' },
          el('p', { class: 'muted' }, 'Print it and fix it at the location. Phone cameras open the game and check the team in. It only works for teams currently on this stage.'),
          el('div', { class: 'row' },
            el('button', { type: 'button', class: 'small', onclick: () => { const blob = new Blob([preview.innerHTML], { type: 'image/svg+xml' }); const a = el('a', { href: URL.createObjectURL(blob), download: `stage-${s.position + 1}-qr.svg` }); document.body.append(a); a.click(); a.remove(); } }, 'Download SVG'),
            ro ? null : confirmClick('Make a new code', async () => { await autosave(); await api('POST', `/api/stages/${s.id}/qr/regenerate`); toast('New code created - reprint it', 'good'); await reload(); buildEditor(); }, 'small danger')))));
  }

  async function printQrs() {
    const area = document.getElementById('printArea');
    area.replaceChildren();
    for (const s of D.stages) {
      if (s.verify_type === 'photo') continue;
      try {
        const svg = await authText(`/api/stages/${s.id}/qr.svg?base=${encodeURIComponent(location.origin)}`);
        const box = el('div', { class: 'qr-sheet' }, el('h1', null, 'Scan to check in'), el('div'), el('p', { style: { color: '#888', fontSize: '10pt' } }, `Organizer note: stage ${s.position + 1}${s.location_name ? ' - ' + s.location_name : ''}. Trim this line off before placing.`));
        box.children[1].innerHTML = svg;
        area.append(box);
      } catch { /* skip */ }
    }
    if (!area.children.length) { toast('No QR checkpoints to print', 'bad'); return; }
    window.print();
  }

  // ================================================================ live tab
  function buildLive() {
    ui.stats = el('div', { class: 'row' });
    ui.mapBox = el('div', { class: 'live-map', 'data-testid': 'live-map' });
    ui.reviews = el('div', { class: 'stack', 'data-testid': 'reviews' });
    ui.teams = el('div', { class: 'table-wrap', 'data-testid': 'teams' });
    ui.activity = el('ul', { class: 'activity', 'data-testid': 'activity' });
    mount(ui.body, el('div', { class: 'stack' }, ui.stats, ui.reviews,
      el('div', { class: 'grid2', style: { gridTemplateColumns: 'minmax(280px, 1fr) minmax(280px, 1fr)' } },
        el('div', { class: 'card flat stack' }, el('h3', null, 'Where everyone is'), ui.mapBox, el('div', { class: 'row' }, el('button', { class: 'small', onclick: () => fitLive(true) }, 'Fit everyone'))),
        el('div', { class: 'card flat stack' }, el('h3', null, 'Activity'), ui.activity)),
      el('div', { class: 'card flat stack' }, el('h3', null, 'Teams'), ui.teams)));
    liveMap = new TMap(ui.mapBox, { tileUrl: cfg.tile_url, attribution: cfg.tile_attribution, center: [20.5937, 78.9629], zoom: 4, label: 'Live map of teams and checkpoints' });
    liveMarkers = [];
    paintLive();
  }
  let liveMarkers = [];

  function fitLive(force) {
    if (!liveMap) return;
    if (liveMapFitted && !force) return;
    const pts = [];
    for (const s of D.stages) if (s.lat !== null) pts.push({ lat: s.lat, lng: s.lng });
    for (const t of D.teams) if (t.location) pts.push(t.location);
    if (pts.length) { liveMap.fitPoints(pts, { maxZoom: 18 }); liveMapFitted = true; }
  }

  function phaseText(t) {
    if (t.finished_at || t.phase === 'done') return 'Found the treasure';
    if (D.event.status === 'lobby') return 'Waiting';
    return t.phase === 'riddle' ? 'Solving riddle ' + (t.stage_pos + 1) : 'Heading to checkpoint ' + (t.stage_pos + 1);
  }

  function paintLive() {
    if (!ui || !ui.teams || !liveMap) return;
    const now = D.server_time + 0;
    const total = D.stages.length;
    mount(ui.stats,
      stat('Teams', D.teams.length), stat('Players', D.participants), stat('Not on a team', D.unteamed),
      stat('Waiting for review', D.reviews.length, D.reviews.length ? 'warn' : ''));
    // reviews
    mount(ui.reviews, D.reviews.map((r) => {
      const img = el('img', { alt: 'Submitted photo' });
      authBlobUrl(r.image_url).then((u) => { img.src = u; }).catch(() => {});
      return el('div', { class: 'review', 'data-testid': 'review' }, img,
        el('div', { class: 'stack' },
          el('strong', null, `${r.team_name} - stage ${r.stage_position + 1}`),
          el('div', null, r.score !== null && r.score !== undefined ? `AI match ${Math.round(r.score)}%. ` : '', r.reason || ''),
          el('div', { class: 'row' },
            el('button', { class: 'primary small', 'data-testid': 'approve', onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/submissions/${r.id}/decision`, { approve: true }); await reload(); }) }, 'Approve'),
            el('button', { class: 'danger small', 'data-testid': 'reject', onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/submissions/${r.id}/decision`, { approve: false }); await reload(); }) }, 'Reject'))));
    }));
    // teams table
    if (!D.teams.length) mount(ui.teams, el('div', { class: 'empty' }, 'No teams yet. Share the event code - teams appear here as players create them.'));
    else mount(ui.teams, el('table', { class: 'data' },
      el('thead', null, el('tr', null, ['#', 'Team', 'Members', 'Progress', 'Status', 'Hints', 'Wrong', 'Seen'].map((h) => el('th', null, h)))),
      el('tbody', null, D.teams.map((t) => el('tr', { 'data-testid': 'team-row' },
        el('td', null, t.rank), el('td', null, el('strong', null, t.name), el('div', null, el('small', null, 'code ' + t.code))),
        el('td', null, t.members.map((m) => m.display_name).join(', ')),
        el('td', null, `${t.completed}/${total}`), el('td', null, phaseText(t), t.pending_reviews ? el('span', { class: 'pill warn' }, 'photo waiting') : null),
        el('td', null, t.hints_used), el('td', null, t.wrong_answers),
        el('td', null, t.last_seen ? ago(t.last_seen, now) : '-'))))));
    // activity
    mount(ui.activity, D.activity.length ? D.activity.map((a) => el('li', null, el('time', null, fmtTime(a.created_at)), a.text)) : el('li', { class: 'muted' }, 'Nothing has happened yet.'));
    // map
    for (const m of liveMarkers) m.remove();
    liveMarkers = [];
    D.stages.forEach((s, i) => { if (s.lat !== null) liveMarkers.push(liveMap.addMarker(s.lat, s.lng, TMap.marks.control(String(i + 1), { pulse: false, small: true }))); });
    for (const t of D.teams) {
      if (!t.location) continue;
      const stale = !t.last_seen || now - t.last_seen > 60000;
      const cls = (t.finished_at ? 'winner ' : '') + (stale ? 'stale' : '');
      liveMarkers.push(liveMap.addMarker(t.location.lat, t.location.lng, TMap.marks.team(t.name, cls)));
    }
    fitLive(false);
  }
  function stat(label, n, cls) {
    return el('div', { class: 'card flat tile' + (cls === 'warn' ? ' hot' : '') }, el('div', { class: 'k' }, label), el('div', { class: 'v' }, n));
  }

  // ================================================================ settings tab
  function buildSettings() {
    const ev = D.event; const s = ev.settings;
    const name = el('input', { id: 's-name', value: ev.name, maxlength: 80 });
    const thr = el('input', { id: 's-thr', type: 'number', min: 50, max: 100, value: s.match_threshold });
    const rev = el('input', { id: 's-rev', type: 'number', min: 0, max: 99, value: s.review_min });
    const hints = el('input', { id: 's-hints', type: 'number', min: 0, max: 10, value: s.max_hints });
    const team = el('input', { id: 's-team', type: 'number', min: 1, max: 4, value: s.team_max });
    const chk = (id, label, on) => { const c = el('input', { id, type: 'checkbox' }); c.checked = on; return [c, el('div', { class: 'check' }, c, el('label', { for: id }, label))]; };
    const [board, boardRow] = chk('s-board', 'Show the leaderboard to players', s.show_leaderboard);
    const [late, lateRow] = chk('s-late', 'Let players join and form teams after the hunt starts', s.allow_late_join);
    const [review, reviewRow] = chk('s-review', 'Send borderline photos to me instead of rejecting them', s.allow_review);
    const save = el('button', { class: 'primary', 'data-testid': 'save-settings', onclick: (e) => busy(e.currentTarget, async () => {
      await api('PATCH', `/api/events/${evId}`, { name: name.value, settings: {
        match_threshold: Number(thr.value), review_min: Number(rev.value), max_hints: Number(hints.value), team_max: Number(team.value),
        show_leaderboard: board.checked, allow_late_join: late.checked, allow_review: review.checked } });
      toast('Settings saved', 'good'); await reload();
    }) }, 'Save settings');
    mount(ui.body, el('div', { class: 'card stack', style: { maxWidth: '620px' } },
      field('Hunt name', name, null, 's-name'),
      el('div', { class: 'split' },
        field('Photo match needed to pass (%)', thr, 'Scores at or above this clear the stage.', 's-thr'),
        field('Send to me for review from (%)', rev, 'Scores between this and the pass mark wait for you.', 's-rev')),
      el('div', { class: 'split' },
        field('Hints per team, whole hunt', hints, null, 's-hints'),
        field('Players per team (max 4)', team, null, 's-team')),
      reviewRow, boardRow, lateRow, save));
  }

  // ================================================================ boot
  (async function boot() {
    try { user = await H.requireRole('organizer'); } catch (e) { toast(errMsg(e), 'bad'); return; }
    if (!user) return;
    try { cfg = await api('GET', '/api/config'); } catch { /* defaults */ }
    route();
  })();
})();
