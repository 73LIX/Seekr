/* Small dependency-free QR decoder (ISO/IEC 18004, byte mode, versions 1-10 - the codes this app prints).
   Works on photos: rotation, tilt/perspective, uneven light and a few damaged modules (Reed-Solomon).
   Browser: window.QRDecode.fromSource(img|video|canvas|bitmap) / .fromImageData(rgba, w, h)  ->  string | null
   Node (tests): require('./qrdecode.js').fromImageData(...) */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- tables (same as the generator)
  const ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
  };
  const NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
  };
  const FORMAT_ECL = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
    (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
  ];
  const rawModules = (ver) => {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return r;
  };
  function alignPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const size = ver * 4 + 17;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let p = size - 7; out.length < n; p -= step) out.splice(1, 0, p);
    return out;
  }

  // ---------------------------------------------------------------- GF(256) + Reed-Solomon
  const EXP = new Uint8Array(512); const LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const gdiv = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);

  /** corrects cw (data + ecc) in place; returns false if it cannot */
  function rsCorrect(cw, nsym) {
    const N = cw.length;
    const S = new Array(nsym).fill(0);
    let clean = true;
    for (let k = 0; k < nsym; k++) {
      let s = 0;
      for (let i = 0; i < N; i++) s = gmul(s, EXP[k]) ^ cw[i];
      S[k] = s;
      if (s) clean = false;
    }
    if (clean) return true;
    let C = [1]; let B = [1]; let L = 0; let m = 1; let b = 1;
    for (let n = 0; n < nsym; n++) {
      let d = S[n];
      for (let i = 1; i <= L; i++) d ^= gmul(C[i] || 0, S[n - i]);
      if (d === 0) { m++; continue; }
      const T = C.slice();
      const coef = gdiv(d, b);
      while (C.length < B.length + m) C.push(0);
      for (let i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
      if (2 * L <= n) { L = n + 1 - L; B = T; b = d; m = 1; } else m++;
    }
    if (L === 0 || L > nsym / 2) return false;
    const pos = [];
    for (let i = 0; i < N; i++) {
      const e = N - 1 - i;
      let v = 0; // C(alpha^-e)
      for (let j = 0; j < C.length; j++) v ^= gmul(C[j], EXP[(255 - ((e * j) % 255)) % 255]);
      if (v === 0) pos.push(i);
    }
    if (pos.length !== L) return false;
    // Omega = S(x) * C(x) mod x^nsym
    const omega = new Array(nsym).fill(0);
    for (let i = 0; i < nsym; i++) for (let j = 0; j < C.length && i + j < nsym; j++) omega[i + j] ^= gmul(S[i], C[j]);
    for (const i of pos) {
      const e = N - 1 - i;
      const xinv = EXP[(255 - e) % 255];
      let num = 0; let pw = 1;
      for (let j = 0; j < nsym; j++) { num ^= gmul(omega[j], pw); pw = gmul(pw, xinv); }
      let den = 0; // C'(xinv): odd terms only
      for (let j = 1; j < C.length; j += 2) den ^= gmul(C[j], EXP[(LOG[xinv] * (j - 1)) % 255] || (j - 1 === 0 ? 1 : 0));
      if (!den) return false;
      cw[i] ^= gmul(EXP[e % 255], gdiv(num, den));
    }
    for (let k = 0; k < nsym; k++) {
      let s = 0;
      for (let i = 0; i < N; i++) s = gmul(s, EXP[k]) ^ cw[i];
      if (s) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- image -> black/white
  function toBinary(rgba, w, h, bias) {
    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    // integral image -> local mean
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += gray[y * w + x]; integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row; }
    }
    const r = Math.max(6, Math.round(Math.min(w, h) / 14));
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r); const y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r); const x1 = Math.min(w, x + r + 1);
        const sum = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        bin[y * w + x] = gray[y * w + x] < mean * bias - 4 ? 1 : 0;
      }
    }
    return bin;
  }

  // ---------------------------------------------------------------- finder patterns
  function ratioOk(c) {
    const total = c[0] + c[1] + c[2] + c[3] + c[4];
    if (total < 7 || c.includes(0)) return false;
    const ms = total / 7; const tol = ms * 0.65;
    return Math.abs(c[0] - ms) < tol && Math.abs(c[1] - ms) < tol && Math.abs(c[2] - 3 * ms) < 3 * tol && Math.abs(c[3] - ms) < tol && Math.abs(c[4] - ms) < tol;
  }
  /** walk through (cx,cy) along an axis; returns { total, center } or null */
  function cross(bin, w, h, cx, cy, vertical) {
    const at = (k) => {
      const x = vertical ? cx : cx + k; const y = vertical ? cy + k : cy;
      return x < 0 || y < 0 || x >= w || y >= h ? -1 : bin[y * w + x];
    };
    if (at(0) !== 1) return null;
    const c = [0, 0, 0, 0, 0];
    let k = 0;
    while (at(k) === 1) { c[2]++; k--; }
    const a = c[2];
    while (at(k) === 0) { c[1]++; k--; }
    while (at(k) === 1) { c[0]++; k--; }
    k = 1;
    let b = 0;
    while (at(k) === 1) { b++; k++; }
    while (at(k) === 0) { c[3]++; k++; }
    while (at(k) === 1) { c[4]++; k++; }
    c[2] = a + b;
    if (!ratioOk(c)) return null;
    return { total: c[0] + c[1] + c[2] + c[3] + c[4], center: (vertical ? cy : cx) + (b - a + 1) / 2 };
  }
  function findFinders(bin, w, h) {
    const found = [];
    for (let y = 0; y < h; y++) {
      const runs = []; // [color, start, len]
      let x = 0;
      while (x < w) {
        const col = bin[y * w + x]; let e = x;
        while (e < w && bin[y * w + e] === col) e++;
        runs.push([col, x, e - x]);
        x = e;
      }
      for (let i = 0; i + 4 < runs.length; i++) {
        if (runs[i][0] !== 1) continue;
        const c = [runs[i][2], runs[i + 1][2], runs[i + 2][2], runs[i + 3][2], runs[i + 4][2]];
        if (!ratioOk(c)) continue;
        const cx = Math.round(runs[i + 2][1] + runs[i + 2][2] / 2 - 0.5);
        const v = cross(bin, w, h, cx, y, true);
        if (!v) continue;
        const cy = Math.round(v.center - 0.0);
        const hz = cross(bin, w, h, cx, cy, false);
        if (!hz) continue;
        const size = (v.total + hz.total) / 2;
        const px = hz.center; const py = v.center;
        const hit = found.find((f) => Math.abs(f.x - px) < f.size * 0.6 && Math.abs(f.y - py) < f.size * 0.6 && Math.abs(f.size - size) < f.size * 0.5);
        if (hit) { hit.x = (hit.x * hit.n + px) / (hit.n + 1); hit.y = (hit.y * hit.n + py) / (hit.n + 1); hit.size = (hit.size * hit.n + size) / (hit.n + 1); hit.n++; }
        else found.push({ x: px, y: py, size, n: 1 });
      }
    }
    // refine: the 3x3 black core of a real finder is one solid blob of about 9 modules; its centroid is exact
    const out = [];
    const core = (sx, sy, expect) => {
      const seen = new Set([sy * w + sx]); const stack = [sy * w + sx];
      let ax = 0; let ay = 0; let area = 0;
      while (stack.length && area < expect * 3) {
        const idx = stack.pop(); const x = idx % w; const y = (idx - x) / w;
        area++; ax += x; ay += y;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (bin[ni] && !seen.has(ni)) { seen.add(ni); stack.push(ni); }
        }
      }
      return area >= expect * 0.45 && area <= expect * 1.8 ? { x: ax / area, y: ay / area, area } : null;
    };
    for (const f of found.filter((q) => q.n >= 2)) {
      const ms = f.size / 7; const expect = ms * ms * 9;
      let hit = null;
      for (const k of [0, 0.7, 1.4, 2.1]) {
        for (let d = 0; d < (k ? 8 : 1) && !hit; d++) {
          const ang = (d * Math.PI) / 4;
          const sx = Math.round(f.x + Math.cos(ang) * ms * k); const sy = Math.round(f.y + Math.sin(ang) * ms * k);
          if (sx < 0 || sy < 0 || sx >= w || sy >= h || !bin[sy * w + sx]) continue;
          hit = core(sx, sy, expect);
        }
        if (hit) break;
      }
      if (!hit) continue;
      if (out.some((o) => Math.hypot(o.x - hit.x, o.y - hit.y) < ms * 2)) continue;
      out.push({ x: hit.x, y: hit.y, size: f.size, n: f.n, ms: Math.sqrt(hit.area / 9) });
    }
    return out.sort((a, b) => b.n - a.n).slice(0, 22);
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function triples(f) {
    const out = [];
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) for (let k = j + 1; k < f.length; k++) {
      const t = [f[i], f[j], f[k]];
      const medMs = [t[0].ms, t[1].ms, t[2].ms].sort((p, q) => p - q)[1];
      const mean = medMs * 7;
      if (t.some((p) => Math.abs(p.ms * 7 - mean) > mean * 0.4)) continue;
      for (let c = 0; c < 3; c++) {
        const tl = t[c]; const a = t[(c + 1) % 3]; const b = t[(c + 2) % 3];
        const la = dist(tl, a); const lb = dist(tl, b);
        if (la < mean * 1.8 || lb < mean * 1.8) continue;
        const cos = ((a.x - tl.x) * (b.x - tl.x) + (a.y - tl.y) * (b.y - tl.y)) / (la * lb);
        const ratio = Math.abs(la - lb) / Math.max(la, lb);
        if (Math.abs(cos) > 0.4 || ratio > 0.4) continue;
        let tr = a; let bl = b;
        if ((tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x) < 0) { tr = b; bl = a; }
        out.push({ tl, tr, bl, score: Math.abs(cos) + ratio - Math.min(tl.n, a.n, b.n) / (mean / 2.5), ms: medMs });
      }
    }
    return out.sort((p, q) => p.score - q.score).slice(0, 8);
  }

  // ---------------------------------------------------------------- homography (module coords -> pixels)
  function solveHomography(src, dst) {
    const A = []; const bvec = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i]; const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bvec.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bvec.push(v);
    }
    const n = 8;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-12) return null;
      [A[i], A[p]] = [A[p], A[i]]; [bvec[i], bvec[p]] = [bvec[p], bvec[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        bvec[r] -= f * bvec[i];
      }
    }
    const h = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = bvec[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * h[c];
      h[i] = s / A[i][i];
    }
    return (x, y) => { const d = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d]; };
  }

  /** look for the alignment pattern near its affine prediction */
  function findAlignment(bin, w, h, tri, size, ms) {
    const { tl, tr, bl } = tri;
    const span = size - 7;
    const ex = [(tr.x - tl.x) / span, (tr.y - tl.y) / span];
    const ey = [(bl.x - tl.x) / span, (bl.y - tl.y) / span];
    const at = (mx, my) => [tl.x + (mx - 3.5) * ex[0] + (my - 3.5) * ey[0], tl.y + (mx - 3.5) * ex[1] + (my - 3.5) * ey[1]];
    const [px, py] = at(size - 6.5, size - 6.5);
    const get = (x, y) => { const xi = Math.round(x); const yi = Math.round(y); return xi < 0 || yi < 0 || xi >= w || yi >= h ? 0 : bin[yi * w + xi]; };
    let best = null; let bestScore = -1;
    const step = Math.max(0.5, ms / 3); const reach = ms * 4;
    for (let dy = -reach; dy <= reach; dy += step) for (let dx = -reach; dx <= reach; dx += step) {
      const cx = px + dx; const cy = py + dy;
      let score = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const want = Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0;
        if (get(cx + i * ex[0] + j * ey[0], cy + i * ex[1] + j * ey[1]) === want) score++;
      }
      if (score > bestScore) { bestScore = score; best = [cx, cy]; }
    }
    return bestScore >= 22 ? best : [px, py];
  }

  // ---------------------------------------------------------------- read modules
  function functionMask(ver) {
    const size = ver * 4 + 17;
    const fn = Array.from({ length: size }, () => new Uint8Array(size));
    const box = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y <= Math.min(size - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(size - 1, x1); x++) fn[y][x] = 1; };
    box(0, 0, 8, 8); box(size - 8, 0, size - 1, 8); box(0, size - 8, 8, size - 1);
    for (let i = 0; i < size; i++) { fn[6][i] = 1; fn[i][6] = 1; }
    const al = alignPositions(ver); const n = al.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      box(al[i] - 2, al[j] - 2, al[i] + 2, al[j] + 2);
    }
    if (ver >= 7) { box(size - 11, 0, size - 9, 5); box(0, size - 11, 5, size - 9); }
    return fn;
  }
  function bch15(d) { let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); return ((d << 10) | r) ^ 0x5412; }
  const FORMATS = []; for (let d = 0; d < 32; d++) FORMATS.push([bch15(d), d]);
  const popcount = (v) => { let c = 0; while (v) { c += v & 1; v >>>= 1; } return c; };
  function readFormat(m, size) {
    const bit = (x, y) => (m[y][x] ? 1 : 0);
    let a = 0; let b = 0;
    for (let i = 0; i <= 5; i++) a |= bit(8, i) << i;
    a |= bit(8, 7) << 6; a |= bit(8, 8) << 7; a |= bit(7, 8) << 8;
    for (let i = 9; i < 15; i++) a |= bit(14 - i, 8) << i;
    for (let i = 0; i < 8; i++) b |= bit(size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) b |= bit(8, size - 15 + i) << i;
    let best = null; let bd = 99;
    for (const raw of [a, b]) for (const [code, d] of FORMATS) { const dd = popcount(raw ^ code); if (dd < bd) { bd = dd; best = d; } }
    return bd <= 3 ? { ecl: FORMAT_ECL[best >> 3], mask: best & 7 } : null;
  }

  function parseData(data, ver) {
    let bitPos = 0;
    const read = (n) => { let v = 0; for (let i = 0; i < n; i++) { const byte = data[bitPos >> 3]; if (byte === undefined) return -1; v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1); bitPos++; } return v; };
    const bytes = [];
    for (;;) {
      const mode = read(4);
      if (mode <= 0) break; // terminator or out of data
      if (mode !== 4) return null; // only byte mode is produced by this app
      const len = read(ver < 10 ? 8 : 16);
      if (len < 0) return null;
      for (let i = 0; i < len; i++) { const b = read(8); if (b < 0) return null; bytes.push(b); }
    }
    if (!bytes.length) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return String.fromCharCode(...bytes); }
  }

  function decodeMatrix(m, ver) {
    const size = ver * 4 + 17;
    const fmt = readFormat(m, size);
    if (!fmt) return null;
    const fn = functionMask(ver);
    const maskFn = MASKS[fmt.mask];
    const total = Math.floor(rawModules(ver) / 8);
    const bits = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j; const up = ((right + 1) & 2) === 0; const y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bits.length < total * 8) bits.push((m[y][x] ? 1 : 0) ^ (maskFn(x, y) ? 1 : 0));
      }
    }
    if (bits.length < total * 8) return null;
    const cw = [];
    for (let i = 0; i < total; i++) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; cw.push(v); }
    const nb = NUM_BLOCKS[fmt.ecl][ver]; const ecc = ECC_PER_BLOCK[fmt.ecl][ver];
    const shortBlocks = nb - (total % nb); const shortLen = Math.floor(total / nb);
    const blocks = Array.from({ length: nb }, () => []);
    let k = 0;
    for (let i = 0; i <= shortLen; i++) for (let j = 0; j < nb; j++) {
      if (i === shortLen - ecc && j < shortBlocks) { blocks[j][i] = 0; continue; }
      if (k < cw.length) blocks[j][i] = cw[k++];
    }
    const data = [];
    for (let j = 0; j < nb; j++) {
      const blk = blocks[j].slice();
      if (j < shortBlocks) blk.splice(shortLen - ecc, 1);
      if (!rsCorrect(blk, ecc)) return null;
      for (let i = 0; i < blk.length - ecc; i++) data.push(blk[i]);
    }
    return parseData(data, ver);
  }

  function sampleGrid(bin, w, h, H, size) {
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const get = (p) => { const x = Math.round(p[0]); const y = Math.round(p[1]); return x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x]; };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let votes = 0;
      for (const [dx, dy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]]) votes += get(H(x + dx, y + dy));
      m[y][x] = votes >= 3;
    }
    return m;
  }

  function tryTriple(bin, w, h, tri) {
    const d = (dist(tri.tl, tri.tr) + dist(tri.tl, tri.bl)) / 2;
    const ms0 = tri.ms;
    const est = d / ms0 + 7;
    const v0 = Math.round((est - 17) / 4);
    const order = [v0, v0 - 1, v0 + 1, v0 - 2, v0 + 2].filter((v) => v >= 1 && v <= 10);
    for (const ver of order) {
      const size = ver * 4 + 17;
      const span = size - 7;
      const ms = d / span;
      let fourth;
      let src4;
      if (ver >= 2) { fourth = findAlignment(bin, w, h, tri, size, ms); src4 = [size - 6.5, size - 6.5]; }
      else { fourth = { x: tri.tr.x + tri.bl.x - tri.tl.x, y: tri.tr.y + tri.bl.y - tri.tl.y }; fourth = [fourth.x, fourth.y]; src4 = [size - 3.5, size - 3.5]; }
      const H = solveHomography(
        [[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5], src4],
        [[tri.tl.x, tri.tl.y], [tri.tr.x, tri.tr.y], [tri.bl.x, tri.bl.y], fourth]);
      if (!H) continue;
      const text = decodeMatrix(sampleGrid(bin, w, h, H, size), ver);
      if (text) return text;
    }
    return null;
  }

  /** rgba: Uint8Array/Uint8ClampedArray of w*h*4 */
  function fromImageData(rgba, w, h) {
    for (const bias of [0.93, 1.0, 0.85]) {
      const bin = toBinary(rgba, w, h, bias);
      const finders = findFinders(bin, w, h);
      if (finders.length < 3) continue;
      for (const tri of triples(finders)) {
        const t = tryTriple(bin, w, h, tri);
        if (t) return t;
      }
    }
    return null;
  }

  /** browser helper: draws any image-like source to a canvas (a few sizes) and decodes it */
  function fromSource(src, opts) {
    const sw = src.videoWidth || src.naturalWidth || src.width; const sh = src.videoHeight || src.naturalHeight || src.height;
    if (!sw || !sh) return null;
    const sizes = (opts && opts.sizes) || [900, 560, 1400];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (const maxSide of sizes) {
      const k = Math.min(1, maxSide / Math.max(sw, sh));
      canvas.width = Math.max(1, Math.round(sw * k)); canvas.height = Math.max(1, Math.round(sh * k));
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const t = fromImageData(img.data, img.width, img.height);
      if (t) return t;
    }
    return null;
  }

  const api = { fromImageData, fromSource, _t: { toBinary, findFinders, triples, tryTriple, decodeMatrix, readFormat, sampleGrid, solveHomography } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.QRDecode = api;
})(typeof window !== 'undefined' ? window : globalThis);
