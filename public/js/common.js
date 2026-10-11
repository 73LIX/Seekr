/* Shared helpers: API client, DOM builder, toasts, live stream, auth guard. No dependencies. */
(function () {
  'use strict';
  const TOKEN_KEY = 'th.token';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const session = {
    token: () => store.get(TOKEN_KEY),
    set(t) { store.set(TOKEN_KEY, t); },
    clear() { store.del(TOKEN_KEY); },
  };

  class ApiError extends Error {
    constructor(status, body) {
      // the server answers { error: { code, message, ...extras } }
      const e = body && typeof body.error === 'object' && body.error ? body.error : (body || {});
      super(e.message || (typeof body?.error === 'string' ? body.error : '') || `Request failed (${status})`);
      this.status = status;
      this.code = e.code || (typeof body?.error === 'string' ? body.error : undefined);
      this.data = e;
    }
  }

  async function parse(res) {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 200) }; }
    if (!res.ok) {
      if (res.status === 401 && session.token()) { session.clear(); }
      throw new ApiError(res.status, body);
    }
    return body;
  }
  function headers(extra) {
    const h = Object.assign({}, extra);
    const t = session.token();
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, { error: 'network', message: 'Cannot reach the server - check your connection.' });
    }
    return parse(res);
  }
  async function upload(url, blob) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: headers({ 'Content-Type': blob.type || 'application/octet-stream' }), body: blob });
    } catch {
      throw new ApiError(0, { error: 'network', message: 'Upload failed - check your connection and try again.' });
    }
    return parse(res);
  }
  /** images and SVGs live behind auth, so fetch them with the token and hand back an object URL */
  async function authBlobUrl(url) {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new ApiError(res.status, null);
    return URL.createObjectURL(await res.blob());
  }
  async function authText(url) {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new ApiError(res.status, null);
    return res.text();
  }

  // ---------------------------------------------------------------- DOM
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (v === true) n.setAttribute(k, '');
        else n.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function mount(node, ...kids) { clear(node); for (const k of kids.flat(Infinity)) if (k) node.append(k); return node; }

  function toast(message, kind) {
    let box = document.getElementById('toasts');
    if (!box) { box = el('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
    const t = el('div', { class: 'toast ' + (kind || '') }, message);
    box.append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3800);
  }
  function errMsg(e) { return (e && e.message) || 'Something went wrong'; }

  /** run an async action with a busy button; shows errors as toasts */
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); }
    catch (e) { toast(errMsg(e), 'bad'); return undefined; }
    finally { if (btn) btn.disabled = false; }
  }

  // ---------------------------------------------------------------- live stream (SSE over fetch so we can send the bearer token)
  function stream(url, onMessage, onState) {
    let stopped = false;
    let ctrl = null;
    let delay = 1000;
    async function run() {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await fetch(url, { headers: headers({ Accept: 'text/event-stream' }), signal: ctrl.signal });
          if (res.status === 401 || res.status === 403 || res.status === 404) { onState && onState('denied'); return; }
          if (!res.ok || !res.body) throw new Error('bad stream');
          onState && onState('open');
          delay = 1000;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              for (const line of chunk.split('\n')) {
                if (line.startsWith('data:')) {
                  try { onMessage(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
                }
              }
            }
          }
        } catch (e) {
          if (stopped) return;
        }
        if (stopped) return;
        onState && onState('reconnecting');
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10000);
      }
    }
    run();
    return { stop() { stopped = true; if (ctrl) ctrl.abort(); } };
  }

  /** coalesce bursts of refresh notices into one call */
  function debounce(fn, ms) {
    let t = null;
    let again = false;
    let running = false;
    async function fire() {
      if (running) { again = true; return; }
      running = true;
      try { await fn(); } finally { running = false; if (again) { again = false; schedule(); } }
    }
    function schedule() { clearTimeout(t); t = setTimeout(fire, ms); }
    return schedule;
  }

  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  function ago(ms, now) {
    if (!ms) return 'never';
    const s = Math.max(0, Math.round(((now || Date.now()) - ms) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
  }

  async function requireRole(role) {
    if (!session.token()) { location.replace('/'); return null; }
    try {
      const { user } = await api('GET', '/api/me');
      if (user.role !== role) { location.replace('/'); return null; }
      return user;
    } catch (e) {
      if (e.status === 401) { session.clear(); location.replace('/'); return null; }
      throw e;
    }
  }
  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    session.clear();
    location.replace('/');
  }

  const LOGO = () => (window.PX ? window.PX.sprite('chest', { scale: 3 }) : document.createElement('span'));

  window.H = { api, upload, authBlobUrl, authText, el, clear, mount, toast, errMsg, busy, stream, debounce, fmtTime, ago, duration, session, store, requireRole, logout, ApiError, LOGO };
})();
