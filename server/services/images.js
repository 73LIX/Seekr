'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { badRequest, HttpError, sha256 } = require('../util');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const available = () => sharp !== null;

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

async function dhash(jpeg) {
  const { data } = await sharp(jpeg).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

async function colorHist(jpeg) {
  const { data } = await sharp(jpeg).removeAlpha().resize(32, 32, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const hist = new Float64Array(64);
  const px = data.length / 3;
  for (let i = 0; i < data.length; i += 3) {
    hist[((data[i] >> 6) << 4) | ((data[i + 1] >> 6) << 2) | (data[i + 2] >> 6)]++;
  }
  for (let i = 0; i < 64; i++) hist[i] /= px;
  return Array.from(hist);
}

function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

async function features(jpeg) {
  return { dhash: await dhash(jpeg), hist: await colorHist(jpeg) };
}

/** Crude local similarity 0..100 from perceptual hash + colour histogram. Only a fallback. */
function localSimilarity(a, b) {
  const s1 = 1 - hamming(a.dhash, b.dhash) / 64;
  const shape = Math.min(1, Math.max(0, (s1 - 0.5) / 0.5));
  let inter = 0;
  for (let i = 0; i < 64; i++) inter += Math.min(a.hist[i], b.hist[i]);
  const color = Math.min(1, Math.max(0, (inter - 0.4) / 0.6));
  return Math.round(100 * (0.6 * shape + 0.4 * color));
}

/**
 * Validate + normalise an uploaded image: sniff real type, cap pixels, apply EXIF rotation,
 * strip metadata, downscale to <=1024px JPEG. Throws HttpError for bad input.
 */
async function prepareImage(buffer, { maxBytes }) {
  if (!available()) throw new HttpError(503, 'images_unavailable', 'Image processing is not available on this server');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw badRequest('empty_image', 'No image data received');
  if (buffer.length > maxBytes) throw new HttpError(413, 'image_too_large', 'Image is too large');
  if (!sniff(buffer)) throw new HttpError(415, 'unsupported_image', 'Please upload a JPEG, PNG or WebP photo');
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw badRequest('invalid_image', 'That file could not be read as an image');
  }
  if (!meta.width || !meta.height || meta.width < 32 || meta.height < 32) {
    throw badRequest('image_too_small', 'Image is too small');
  }
  let jpeg;
  try {
    jpeg = await sharp(buffer, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    throw badRequest('invalid_image', 'That file could not be read as an image');
  }
  const f = await features(jpeg);
  return { jpeg, sha: sha256(buffer), dhash: f.dhash, hist: f.hist };
}

class ImageStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.dir, { recursive: true });
    this.featureCache = new Map();
  }
  save(jpeg) {
    const name = crypto.randomBytes(16).toString('hex') + '.jpg';
    fs.writeFileSync(path.join(this.dir, name), jpeg);
    return name;
  }
  _path(name) {
    if (!/^[a-f0-9]{32}\.jpg$/.test(String(name))) return null;
    return path.join(this.dir, name);
  }
  read(name) {
    const p = this._path(name);
    if (!p) return null;
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }
  remove(name) {
    const p = this._path(name);
    this.featureCache.delete(name);
    if (!p) return;
    try {
      fs.unlinkSync(p);
    } catch { /* already gone */ }
  }
  async featuresOf(name) {
    if (this.featureCache.has(name)) return this.featureCache.get(name);
    const buf = this.read(name);
    if (!buf) return null;
    const f = await features(buf);
    this.featureCache.set(name, f);
    return f;
  }
}

module.exports = { available, sniff, prepareImage, features, localSimilarity, hamming, ImageStore };
