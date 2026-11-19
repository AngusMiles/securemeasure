// Minimal PNG encoder for the AR Quick Look lab page. Pure: no DOM, no node:zlib, safe in a browser.
//
// The page normally turns its textures into PNGs with a canvas (putImageData + toBlob('image/png')),
// which compresses well. This is the fallback for a browser where that fails, and what the unit tests use.
// It writes zlib "stored" deflate blocks (no compression), so a texture costs its raw size: 3 bytes per
// pixel when every pixel is opaque, else 4. Filter type 0 on every row.

import { crc32 } from './usdz.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Largest payload of one stored deflate block. */
const STORED_MAX = 65535;

/**
 * Adler-32, the zlib stream checksum.
 * @param {Uint8Array|string} input  bytes, or a string (hashed as UTF-8)
 * @returns {number} unsigned 32-bit
 */
export function adler32(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let a = 1;
  let b = 0;
  // 5552 is the longest run before b can overflow 2^32 (the zlib constant NMAX).
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * A zlib stream holding `raw` in stored deflate blocks.
 * @param {Uint8Array} raw
 * @returns {Uint8Array}
 */
export function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  // CMF 0x78 = deflate, 32 K window; FLG 0x01 makes (CMF * 256 + FLG) % 31 == 0, no dictionary, level 0.
  out[0] = 0x78;
  out[1] = 0x01;
  let pos = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * STORED_MAX;
    const len = Math.min(STORED_MAX, raw.length - start);
    out[pos] = i === blocks - 1 ? 1 : 0; // BFINAL, BTYPE 00
    out[pos + 1] = len & 0xff;
    out[pos + 2] = len >>> 8;
    out[pos + 3] = ~len & 0xff;
    out[pos + 4] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(start, start + len), pos + 5);
    pos += 5 + len;
  }
  const adler = adler32(raw);
  out[pos] = adler >>> 24;
  out[pos + 1] = (adler >>> 16) & 0xff;
  out[pos + 2] = (adler >>> 8) & 0xff;
  out[pos + 3] = adler & 0xff;
  return out;
}

function chunk(type, body) {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/**
 * Encode an RGBA image as an 8-bit PNG: truecolour (type 2) when every pixel is opaque, else truecolour
 * with alpha (type 6).
 *
 * @param {{ data: ArrayLike<number>, width: number, height: number }} image  RGBA, 4 bytes per pixel
 * @returns {Uint8Array}
 * @throws {RangeError} on a size that does not match the data
 */
export function encodePng(image) {
  const { width, height, data } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('encodePng: width and height must be positive integers');
  }
  if (!data || data.length !== width * height * 4) throw new RangeError('encodePng: data must be width x height x 4 bytes');
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    let d = y * (stride + 1);
    raw[d++] = 0; // filter: none
    for (let x = 0, s = y * width * 4; x < width; x++, s += 4) {
      raw[d++] = data[s];
      raw[d++] = data[s + 1];
      raw[d++] = data[s + 2];
      if (!opaque) raw[d++] = data[s + 3];
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((acc, p) => acc + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
