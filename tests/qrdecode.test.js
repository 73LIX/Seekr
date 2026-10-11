'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encode } = require('../server/services/qr.js');
const QR = require('../public/js/qrdecode.js');

/** render a QR into an RGBA picture with an optional rotation / perspective / lighting / noise, like a phone photo */
function render(text, { ecl = 'M', scale = 6, quiet = 4, angle = 0, tilt = 0, shade = 0, noise = 0, blur = 0, pad = 40, seed = 1 } = {}) {
  const q = encode(text, ecl);
  const n = q.size + quiet * 2;
  const side = n * scale + pad * 2;
  const w = side; const h = side;
  const px = new Uint8ClampedArray(w * h * 4);
  let rnd = seed;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  const cx = w / 2; const cy = h / 2; const cos = Math.cos(angle); const sin = Math.sin(angle);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // inverse transform: image pixel -> qr plane
    let dx = x - cx; let dy = y - cy;
    const persp = 1 + tilt * (dy / h);
    dx /= persp; dy /= persp;
    const u = (dx * cos + dy * sin) / scale + n / 2;
    const v = (-dx * sin + dy * cos) / scale + n / 2;
    let dark = 0;
    const mx = Math.floor(u - quiet); const my = Math.floor(v - quiet);
    if (mx >= 0 && my >= 0 && mx < q.size && my < q.size && q.modules[my][mx]) dark = 1;
    let g = dark ? 25 : 235;
    g = g * (1 - shade * (x / w)) + (rand() - 0.5) * noise;
    const i = (y * w + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, g)); px[i + 3] = 255;
  }
  if (blur) { // box blur
    const copy = px.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += copy[((y + j) * w + x + i) * 4];
      const o = (y * w + x) * 4; px[o] = px[o + 1] = px[o + 2] = s / 9;
    }
  }
  return { px, w, h, q };
}
const dec = (r) => QR.fromImageData(r.px, r.w, r.h);
const URL1 = 'https://abc.ngrok-free.app/play.html#scan=Xk3mQ9aB2cD4eF6g';

test('decodes a clean code at several versions and ECC levels', () => {
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    for (const text of ['hi', URL1, URL1 + URL1, 'x'.repeat(80), 'https://example.com/play.html#scan=' + 'A'.repeat(40)]) {
      const r = render(text, { ecl });
      assert.equal(dec(r), text, `ecl ${ecl} len ${text.length} (v${r.q.version})`);
    }
  }
});
test('decodes rotated codes (every 15 degrees)', () => {
  for (let a = 0; a < 360; a += 15) assert.equal(dec(render(URL1, { angle: (a * Math.PI) / 180 })), URL1, 'angle ' + a);
});
test('decodes perspective tilt, uneven light, noise and blur', () => {
  assert.equal(dec(render(URL1, { tilt: 0.25, angle: 0.3 })), URL1);
  assert.equal(dec(render(URL1, { tilt: -0.3, angle: -0.7 })), URL1);
  assert.equal(dec(render(URL1, { shade: 0.55 })), URL1);
  assert.equal(dec(render(URL1, { noise: 60, seed: 7 })), URL1);
  assert.equal(dec(render(URL1, { blur: 1, scale: 4, angle: 0.5 })), URL1);
});
test('small and large module sizes', () => {
  assert.equal(dec(render(URL1, { scale: 3, angle: 0.2 })), URL1);
  assert.equal(dec(render(URL1, { scale: 12 })), URL1);
});
test('recovers from damaged modules via Reed-Solomon (ECC H)', () => {
  const r = render(URL1, { ecl: 'H', scale: 8 });
  const s = 8;
  // blot out a 3x3-module patch in the data area
  const x0 = 40 + (4 + 12) * s; const y0 = 40 + (4 + 12) * s;
  for (let y = y0; y < y0 + 3 * s; y++) for (let x = x0; x < x0 + 3 * s; x++) { const i = (y * r.w + x) * 4; r.px[i] = r.px[i + 1] = r.px[i + 2] = 128 + ((x + y) % 2) * 100; }
  assert.equal(dec(r), URL1);
});
test('returns null for pictures with no QR code, without hanging', () => {
  const w = 400; const h = 400; const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = ((i % w) / 8 | 0) % 2 ? 255 : 0; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
  assert.equal(QR.fromImageData(px, w, h), null);
  const t0 = Date.now();
  for (let i = 0; i < w * h * 4; i++) px[i] = (i * 2654435761) >>> 24;
  assert.equal(QR.fromImageData(px, w, h), null);
  assert.ok(Date.now() - t0 < 5000);
});
