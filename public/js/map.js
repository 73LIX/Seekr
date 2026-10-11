/* Tiny slippy map (OpenStreetMap-style raster tiles). No dependencies.
   Pan (drag), zoom (wheel, pinch, buttons), markers, metre-radius circles, click-to-pick. */
(function () {
  'use strict';
  const TILE = 256;
  const MAX_LAT = 85.0511287798;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function project(lat, lng, z) {
    const n = TILE * 2 ** z;
    const la = clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    return {
      x: ((lng + 180) / 360) * n,
      y: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n,
    };
  }
  function unproject(x, y, z) {
    const n = TILE * 2 ** z;
    return {
      lng: (x / n) * 360 - 180,
      lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    };
  }
  const metersPerPx = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

  class TMap {
    constructor(container, opts = {}) {
      this.box = container;
      this.opts = opts;
      this.minZoom = opts.minZoom ?? 2;
      this.maxZoom = opts.maxZoom ?? 19;
      this.zoom = clamp(opts.zoom ?? 15, this.minZoom, this.maxZoom);
      const c = opts.center || [20.5937, 78.9629];
      this.lat = c[0];
      this.lng = c[1];
      this.markers = new Set();
      this.circles = new Set();
      this.tiles = new Map();
      this.clickHandler = opts.onClick || null;
      this.pointers = new Map();
      this.raf = 0;
      this.userMoved = false;

      container.classList.add('tmap');
      container.setAttribute('role', 'application');
      container.setAttribute('aria-label', opts.label || 'Map');
      this.tileLayer = document.createElement('div');
      this.tileLayer.className = 'tiles';
      this.overlay = document.createElement('div');
      this.overlay.className = 'overlay';
      container.append(this.tileLayer, this.overlay);

      const zoom = document.createElement('div');
      zoom.className = 'zoom';
      const plus = document.createElement('button');
      plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'Zoom in');
      const minus = document.createElement('button');
      minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'Zoom out');
      plus.addEventListener('click', () => this.zoomBy(1));
      minus.addEventListener('click', () => this.zoomBy(-1));
      zoom.append(plus, minus);
      container.append(zoom);

      if (opts.attribution) {
        const a = document.createElement('div');
        a.className = 'attrib';
        a.textContent = opts.attribution.replace(/&copy;/g, '©');
        container.append(a);
      }

      this._bind();
      this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.render()) : null;
      if (this.ro) this.ro.observe(container);
      this.render();
    }

    // ---- coordinates
    _origin() {
      const w = this.box.clientWidth;
      const h = this.box.clientHeight;
      const c = project(this.lat, this.lng, this.zoom);
      return { w, h, c, tlx: c.x - w / 2, tly: c.y - h / 2 };
    }
    latLngToPoint(lat, lng) {
      const o = this._origin();
      const p = project(lat, lng, this.zoom);
      return { x: p.x - o.tlx, y: p.y - o.tly };
    }
    pointToLatLng(x, y) {
      const o = this._origin();
      return unproject(o.tlx + x, o.tly + y, this.zoom);
    }

    // ---- view
    setView(lat, lng, zoom) {
      this.lat = clamp(lat, -MAX_LAT, MAX_LAT);
      this.lng = lng;
      if (zoom !== undefined) this.zoom = clamp(Math.round(zoom), this.minZoom, this.maxZoom);
      this.render();
    }
    panTo(lat, lng) { this.setView(lat, lng); }
    getCenter() { return { lat: this.lat, lng: this.lng }; }
    zoomBy(d, pt) {
      const nz = clamp(this.zoom + d, this.minZoom, this.maxZoom);
      if (nz === this.zoom) return;
      this.userMoved = true;
      if (pt) {
        const ll = this.pointToLatLng(pt.x, pt.y);
        this.zoom = nz;
        const p = project(ll.lat, ll.lng, nz);
        const o = this._origin();
        const c = unproject(p.x - (pt.x - o.w / 2), p.y - (pt.y - o.h / 2), nz);
        this.lat = c.lat; this.lng = c.lng;
      } else {
        this.zoom = nz;
      }
      this.render();
    }
    fitPoints(points, { maxZoom = 17, pad = 70 } = {}) {
      const pts = points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (!pts.length) return;
      const w = Math.max(60, this.box.clientWidth - pad * 2);
      const h = Math.max(60, this.box.clientHeight - pad * 2);
      let best = this.minZoom;
      for (let z = maxZoom; z >= this.minZoom; z--) {
        const ps = pts.map((p) => project(p.lat, p.lng, z));
        const xs = ps.map((p) => p.x); const ys = ps.map((p) => p.y);
        if (Math.max(...xs) - Math.min(...xs) <= w && Math.max(...ys) - Math.min(...ys) <= h) { best = z; break; }
      }
      const ps = pts.map((p) => project(p.lat, p.lng, best));
      const xs = ps.map((p) => p.x); const ys = ps.map((p) => p.y);
      const c = unproject((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, best);
      this.setView(c.lat, c.lng, best);
    }
    onClick(fn) { this.clickHandler = fn; }

    // ---- overlays
    addMarker(lat, lng, node, { passive = true } = {}) {
      const holder = document.createElement('div');
      holder.className = 'mk' + (passive ? ' passive' : '');
      holder.append(node);
      this.overlay.append(holder);
      const m = {
        lat, lng, holder, el: node,
        setLatLng: (la, ln) => { m.lat = la; m.lng = ln; this._schedule(); },
        remove: () => { holder.remove(); this.markers.delete(m); },
      };
      this.markers.add(m);
      this._schedule();
      return m;
    }
    addCircle(lat, lng, radiusM) {
      const node = document.createElement('div');
      node.className = 'circle';
      this.overlay.prepend(node);
      const c = {
        lat, lng, r: radiusM, node,
        set: (la, ln, r) => { c.lat = la; c.lng = ln; if (r !== undefined) c.r = r; this._schedule(); },
        remove: () => { node.remove(); this.circles.delete(c); },
      };
      this.circles.add(c);
      this._schedule();
      return c;
    }
    clearOverlays() {
      for (const m of [...this.markers]) m.remove();
      for (const c of [...this.circles]) c.remove();
    }

    // ---- rendering
    _schedule() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
    }
    render() {
      const o = this._origin();
      if (!o.w || !o.h) return;
      const z = this.zoom;
      const n = 2 ** z;
      const want = new Set();
      const x0 = Math.floor(o.tlx / TILE);
      const x1 = Math.floor((o.tlx + o.w) / TILE);
      const y0 = Math.max(0, Math.floor(o.tly / TILE));
      const y1 = Math.min(n - 1, Math.floor((o.tly + o.h) / TILE));
      const tileUrl = this.opts.tileUrl;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const wx = ((tx % n) + n) % n;
          const key = `${z}/${tx}/${ty}`;
          want.add(key);
          let img = this.tiles.get(key);
          if (!img && tileUrl) {
            img = document.createElement('img');
            img.alt = '';
            img.draggable = false;
            img.referrerPolicy = 'origin';
            img.decoding = 'async';
            img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
            img.src = tileUrl.replace('{z}', z).replace('{x}', wx).replace('{y}', ty).replace('{s}', 'a');
            this.tileLayer.append(img);
            this.tiles.set(key, img);
          }
          if (img) img.style.transform = `translate(${Math.round(tx * TILE - o.tlx)}px, ${Math.round(ty * TILE - o.tly)}px)`;
        }
      }
      for (const [key, img] of this.tiles) {
        if (!want.has(key)) { img.remove(); this.tiles.delete(key); }
      }
      for (const m of this.markers) {
        const p = project(m.lat, m.lng, z);
        m.holder.style.transform = `translate(${(p.x - o.tlx).toFixed(1)}px, ${(p.y - o.tly).toFixed(1)}px)`;
      }
      for (const c of this.circles) {
        const p = project(c.lat, c.lng, z);
        const r = Math.max(2, c.r / metersPerPx(c.lat, z));
        c.node.style.width = c.node.style.height = `${(r * 2).toFixed(1)}px`;
        c.node.style.transform = `translate(${(p.x - o.tlx - r).toFixed(1)}px, ${(p.y - o.tly - r).toFixed(1)}px)`;
      }
      this.box.dataset.zoom = String(z);
    }

    // ---- input
    _bind() {
      const box = this.box;
      let moved = 0;
      let pinchBase = 0;
      let downAt = null;
      const rel = (e) => {
        const r = box.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      box.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.zoom')) return;
        box.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointers.size === 1) { moved = 0; downAt = rel(e); }
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          pinchBase = Math.hypot(a.x - b.x, a.y - b.y);
          moved = 99;
        }
        box.classList.add('dragging');
      });
      box.addEventListener('pointermove', (e) => {
        const prev = this.pointers.get(e.pointerId);
        if (!prev) return;
        const cur = { x: e.clientX, y: e.clientY };
        if (this.pointers.size === 1) {
          const dx = cur.x - prev.x; const dy = cur.y - prev.y;
          moved += Math.abs(dx) + Math.abs(dy);
          if (moved > 6) {
            const o = this._origin();
            const c = unproject(o.c.x - dx, o.c.y - dy, this.zoom);
            this.lat = clamp(c.lat, -MAX_LAT, MAX_LAT); this.lng = c.lng;
            this.userMoved = true;
            this._schedule();
          }
        } else if (this.pointers.size === 2) {
          this.pointers.set(e.pointerId, cur);
          const [a, b] = [...this.pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinchBase && d / pinchBase > 1.45) { this.zoomBy(1, this._mid(a, b)); pinchBase = d; }
          else if (pinchBase && d / pinchBase < 0.69) { this.zoomBy(-1, this._mid(a, b)); pinchBase = d; }
        }
        this.pointers.set(e.pointerId, cur);
      });
      const end = (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.delete(e.pointerId);
        if (this.pointers.size === 0) {
          box.classList.remove('dragging');
          if (e.type === 'pointerup' && moved <= 6 && downAt && this.clickHandler) {
            const ll = this.pointToLatLng(downAt.x, downAt.y);
            this.clickHandler(ll.lat, ll.lng, e);
          }
        }
      };
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);
      let wheelLock = 0;
      box.addEventListener('wheel', (e) => {
        e.preventDefault();
        const now = Date.now();
        if (now - wheelLock < 140) return;
        wheelLock = now;
        this.zoomBy(e.deltaY < 0 ? 1 : -1, rel(e));
      }, { passive: false });
    }
    _mid(a, b) {
      const r = this.box.getBoundingClientRect();
      return { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    }
    destroy() {
      if (this.ro) this.ro.disconnect();
      cancelAnimationFrame(this.raf);
      this.box.replaceChildren();
    }
  }

  /** marker builders */
  const marks = {
    control(label, { pulse = true, small = false, chest = false } = {}) {
      const w = document.createElement('div');
      w.className = 'ctl' + (pulse ? ' pulse' : '') + (small ? ' small' : '') + (chest ? ' chest' : '');
      const ring = document.createElement('s'); const box = document.createElement('i'); const mid = document.createElement('b');
      if (!small && window.PX) mid.append(window.PX.sprite(chest ? 'chest' : 'x', { scale: chest ? 3 : 2 }));
      w.append(ring, box, mid);
      if (label) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = label; w.append(t); }
      return w;
    },
    me() { const w = document.createElement('div'); w.className = 'me'; if (window.PX) w.append(window.PX.sprite('hero', { scale: 3 })); return w; },
    team(name, cls) {
      const w = document.createElement('div'); w.className = 'team-dot ' + (cls || '');
      if (window.PX) w.append(window.PX.sprite('pawn', { scale: 4, color: window.PX.teamColor(name) }));
      const s = document.createElement('span'); s.textContent = name; w.append(s); return w;
    },
    pin(selected) { const w = document.createElement('div'); w.className = 'pin' + (selected ? ' sel' : ''); w.append(document.createElement('i')); return w; },
  };

  function distanceM(a, b, c, d) {
    const R = 6371000; const t = Math.PI / 180;
    const dLat = (c - a) * t; const dLng = (d - b) * t;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  window.TMap = TMap;
  window.TMap.marks = marks;
  window.TMap.distanceM = distanceM;
  window.TMap._project = project;
})();
