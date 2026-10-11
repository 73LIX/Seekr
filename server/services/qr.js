'use strict';
/**
 * Small dependency-free QR Code generator (ISO/IEC 18004, byte mode, versions 1-10).
 * Used to print checkpoint QR codes as SVG. Verified against OpenCV's decoder in tests/qr.test.js.
 */

// index = version (1..10); -1 is a placeholder for index 0
const ECC_CODEWORDS_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const NUM_ERROR_CORRECTION_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 10;

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
const numDataCodewords = (ver, ecl) =>
  Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----
function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= rsMultiply(coef, factor);
    });
  }
  return result;
}

function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function appendBits(val, len, bb) {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

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

/** Encode text; returns { version, size, modules: boolean[][] } */
function encode(text, ecl = 'M') {
  if (!ECC_CODEWORDS_PER_BLOCK[ecl]) throw new Error('bad ECC level');
  const data = Buffer.from(String(text), 'utf8');
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const used = 4 + (ver < 10 ? 8 : 16) + data.length * 8;
    if (used <= numDataCodewords(ver, ecl) * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error('QR payload too long');

  const bb = [];
  appendBits(0b0100, 4, bb);
  appendBits(data.length, ver < 10 ? 8 : 16, bb);
  for (const b of data) appendBits(b, 8, bb);
  const capBits = numDataCodewords(ver, ecl) * 8;
  appendBits(0, Math.min(4, capBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let pad = 0xec; bb.length < capBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bb);
  const dataCw = [];
  for (let i = 0; i < bb.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb[i + j];
    dataCw.push(v);
  }
  const allCw = addEccAndInterleave(dataCw, ver, ecl);

  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => {
    modules[y][x] = dark;
    isFn[y][x] = true;
  };

  const drawFormatBits = (mask) => {
    const d = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
    setFn(8, 7, getBit(bits, 6));
    setFn(8, 8, getBit(bits, 7));
    setFn(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
    setFn(8, size - 8, true);
  };
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  const drawAlignment = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  };

  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  const align = alignmentPositions(ver);
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(align[i], align[j]);
    }
  }
  drawFormatBits(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, color);
      setFn(b, a, color);
    }
  }

  // place codewords in the zig-zag pattern
  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && bitIdx < allCw.length * 8) {
          modules[y][x] = getBit(allCw[bitIdx >>> 3], 7 - (bitIdx & 7));
          bitIdx++;
        }
      }
    }
  }

  const applyMask = (m) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFn[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };

  // penalty score (ISO 18004 rules N1-N4)
  const finderCount = (h) => {
    const k = h[1];
    const core = k > 0 && h[2] === k && h[3] === k * 3 && h[4] === k && h[5] === k;
    return (core && h[0] >= k * 4 && h[6] >= k ? 1 : 0) + (core && h[6] >= k * 4 && h[0] >= k ? 1 : 0);
  };
  const addHistory = (run, h) => {
    if (h[0] === 0) run += size;
    h.pop();
    h.unshift(run);
  };
  const terminateAndCount = (color, run, h) => {
    if (color) {
      addHistory(run, h);
      run = 0;
    }
    run += size;
    addHistory(run, h);
    return finderCount(h);
  };
  const penalty = () => {
    let result = 0;
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runX = 0;
      const h = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += 3;
          else if (runX > 5) result++;
        } else {
          addHistory(runX, h);
          if (!runColor) result += finderCount(h) * 40;
          runColor = modules[y][x];
          runX = 1;
        }
      }
      result += terminateAndCount(runColor, runX, h) * 40;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runY = 0;
      const h = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === runColor) {
          runY++;
          if (runY === 5) result += 3;
          else if (runY > 5) result++;
        } else {
          addHistory(runY, h);
          if (!runColor) result += finderCount(h) * 40;
          runColor = modules[y][x];
          runY = 1;
        }
      }
      result += terminateAndCount(runColor, runY, h) * 40;
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
      }
    }
    let dark = 0;
    for (const row of modules) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  };

  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormatBits(m);
    const score = penalty();
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
    applyMask(m); // undo
  }
  applyMask(best);
  drawFormatBits(best);
  return { version: ver, size, modules, mask: best };
}

function toSvg(text, { ecl = 'M', border = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const qr = encode(text, ecl);
  const parts = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    }
  }
  const dim = qr.size + border * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * 8}" height="${dim * 8}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="${light}"/><path d="${parts.join('')}" fill="${dark}"/></svg>`
  );
}

module.exports = { encode, toSvg, MAX_VERSION };
