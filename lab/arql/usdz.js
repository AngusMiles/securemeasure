// USDZ writer and reader for the AR Quick Look lab page. Pure: no DOM, no globals, safe under Node.
//
// A USDZ is a plain ZIP with three extra rules (Pixar's usdz spec, also what Apple's Quick Look reads):
//   1. every entry is STORED (method 0): no compression, no encryption, no data descriptor;
//   2. the first entry is the root layer (here always 'scene.usda');
//   3. each entry's file data starts at a multiple of 64 bytes from the start of the file, so the
//      reader can map it in place. The gap is filled with an extra field in the entry's LOCAL header.
//
// three.js's USDZExporter (MIT) gets rule 3 only approximately for entries after the first; this writer
// computes the exact padding for every entry. An extra field is at least 4 bytes (2-byte id, 2-byte size),
// so a gap of 1-3 bytes is padded to 65-67 bytes instead.

/** Data alignment required by the usdz spec, in bytes. */
export const USDZ_ALIGN = 64;

/** Extra-field header id used for padding (the one Pixar's usdzip writes). */
const PAD_EXTRA_ID = 0x1986;

/** Fixed DOS time/date (1980-01-01 00:00) so the same input always gives the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_HEADER_LEN = 30;
const CENTRAL_HEADER_LEN = 46;
const EOCD_LEN = 22;
const UTF8_FLAG = 0x0800;
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * UTF-8 bytes of a string.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function utf8(text) {
  return new TextEncoder().encode(String(text));
}

/**
 * CRC-32 (ISO-HDLC, the ZIP and PNG one).
 * @param {Uint8Array|string} input  bytes, or a string (hashed as UTF-8)
 * @param {number} [start]  CRC so far, to continue a running CRC (default: a fresh one)
 * @returns {number} unsigned 32-bit
 */
export function crc32(input, start) {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  let c = start === undefined ? 0xffffffff : (start ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Extra-field length that puts the data of a local header written at `headerOffset` with a name of
 * `nameLen` bytes on a multiple of `align`: 0, or 4..align+3.
 * @param {number} headerOffset
 * @param {number} nameLen
 * @param {number} [align]
 * @returns {number}
 */
export function paddingFor(headerOffset, nameLen, align = USDZ_ALIGN) {
  const pad = (align - ((headerOffset + LOCAL_HEADER_LEN + nameLen) % align)) % align;
  if (pad === 0) return 0;
  return pad < 4 ? pad + align : pad;
}

function checkPath(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('makeUsdz: every entry needs a path');
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((s) => s === '..' || s === '' || s === '.')) {
    throw new TypeError(`makeUsdz: bad entry path '${path}'`);
  }
}

/**
 * Pack files into a USDZ (see the rules at the top of this file).
 *
 * @param {Array<{ path: string, bytes: Uint8Array }>} entries  must include 'scene.usda', which is
 *        written first whatever its place in the list; the others keep their order
 * @returns {Uint8Array}
 * @throws {TypeError} on a missing root layer, a repeated or unsafe path, or bytes that are not a Uint8Array
 */
export function makeUsdz(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new TypeError('makeUsdz: no entries');
  const seen = new Set();
  for (const e of entries) {
    checkPath(e && e.path);
    if (!(e.bytes instanceof Uint8Array)) throw new TypeError(`makeUsdz: '${e.path}' has no bytes`);
    if (seen.has(e.path)) throw new TypeError(`makeUsdz: '${e.path}' is listed twice`);
    seen.add(e.path);
  }
  const root = entries.find((e) => e.path === 'scene.usda');
  if (!root) throw new TypeError("makeUsdz: the root layer 'scene.usda' is missing");
  const ordered = [root, ...entries.filter((e) => e !== root)];

  const prepared = [];
  let offset = 0;
  for (const e of ordered) {
    const name = utf8(e.path);
    const extraLen = paddingFor(offset, name.length);
    const ascii = name.every((b) => b < 0x80);
    prepared.push({ name, extraLen, bytes: e.bytes, crc: crc32(e.bytes), headerOffset: offset, flags: ascii ? 0 : UTF8_FLAG });
    offset += LOCAL_HEADER_LEN + name.length + extraLen + e.bytes.length;
  }
  const centralOffset = offset;
  const centralSize = prepared.reduce((acc, p) => acc + CENTRAL_HEADER_LEN + p.name.length, 0);
  const total = centralOffset + centralSize + EOCD_LEN;
  if (total > 0xffffffff || prepared.length > 0xffff) throw new RangeError('makeUsdz: too big for a ZIP32 archive');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;
  for (const p of prepared) {
    view.setUint32(pos, LOCAL_SIG, true);
    view.setUint16(pos + 4, VERSION, true);
    view.setUint16(pos + 6, p.flags, true);
    view.setUint16(pos + 8, 0, true); // stored
    view.setUint16(pos + 10, DOS_TIME, true);
    view.setUint16(pos + 12, DOS_DATE, true);
    view.setUint32(pos + 14, p.crc, true);
    view.setUint32(pos + 18, p.bytes.length, true);
    view.setUint32(pos + 22, p.bytes.length, true);
    view.setUint16(pos + 26, p.name.length, true);
    view.setUint16(pos + 28, p.extraLen, true);
    out.set(p.name, pos + LOCAL_HEADER_LEN);
    pos += LOCAL_HEADER_LEN + p.name.length;
    if (p.extraLen) {
      view.setUint16(pos, PAD_EXTRA_ID, true);
      view.setUint16(pos + 2, p.extraLen - 4, true);
      // The rest of the extra field stays zero.
      pos += p.extraLen;
    }
    out.set(p.bytes, pos);
    pos += p.bytes.length;
  }
  for (const p of prepared) {
    view.setUint32(pos, CENTRAL_SIG, true);
    view.setUint16(pos + 4, VERSION, true); // made by
    view.setUint16(pos + 6, VERSION, true); // needed
    view.setUint16(pos + 8, p.flags, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, DOS_TIME, true);
    view.setUint16(pos + 14, DOS_DATE, true);
    view.setUint32(pos + 16, p.crc, true);
    view.setUint32(pos + 20, p.bytes.length, true);
    view.setUint32(pos + 24, p.bytes.length, true);
    view.setUint16(pos + 28, p.name.length, true);
    view.setUint16(pos + 30, 0, true); // no extra in the central directory
    view.setUint16(pos + 32, 0, true); // no comment
    view.setUint16(pos + 34, 0, true); // disk
    view.setUint16(pos + 36, 0, true); // internal attributes
    view.setUint32(pos + 38, 0, true); // external attributes
    view.setUint32(pos + 42, p.headerOffset, true);
    out.set(p.name, pos + CENTRAL_HEADER_LEN);
    pos += CENTRAL_HEADER_LEN + p.name.length;
  }
  view.setUint32(pos, EOCD_SIG, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, centralSize, true);
  view.setUint32(pos + 16, centralOffset, true);
  view.setUint16(pos + 20, 0, true);
  return out;
}

/**
 * The end-of-central-directory record of a ZIP.
 * @param {Uint8Array} bytes
 * @returns {{ offset: number, count: number, centralSize: number, centralOffset: number }}
 * @throws {Error} when there is none
 */
export function readEocd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = bytes.length - EOCD_LEN; pos >= Math.max(0, bytes.length - EOCD_LEN - 0xffff); pos--) {
    if (view.getUint32(pos, true) === EOCD_SIG) {
      return {
        offset: pos,
        count: view.getUint16(pos + 10, true),
        centralSize: view.getUint32(pos + 12, true),
        centralOffset: view.getUint32(pos + 16, true),
      };
    }
  }
  throw new Error('readZip: no end of central directory');
}

/**
 * List a ZIP's entries the way a USDZ reader sees them (for the tests and the page's entry list).
 *
 * @param {Uint8Array} bytes
 * @returns {Array<{ path: string, dataOffset: number, size: number, crcOk: boolean, method: number,
 *   flags: number, crc: number, headerOffset: number, localExtraLen: number, aligned: boolean }>}
 *   in central-directory order
 * @throws {Error} on a broken archive
 */
export function readZip(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('readZip: bytes must be a Uint8Array');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = readEocd(bytes);
  const decoder = new TextDecoder();
  const list = [];
  let pos = eocd.centralOffset;
  for (let i = 0; i < eocd.count; i++) {
    if (view.getUint32(pos, true) !== CENTRAL_SIG) throw new Error('readZip: bad central directory entry');
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const headerOffset = view.getUint32(pos + 42, true);
    const path = decoder.decode(bytes.subarray(pos + CENTRAL_HEADER_LEN, pos + CENTRAL_HEADER_LEN + nameLen));
    pos += CENTRAL_HEADER_LEN + nameLen + extraLen + commentLen;

    if (view.getUint32(headerOffset, true) !== LOCAL_SIG) throw new Error(`readZip: bad local header for '${path}'`);
    const localNameLen = view.getUint16(headerOffset + 26, true);
    const localExtraLen = view.getUint16(headerOffset + 28, true);
    const dataOffset = headerOffset + LOCAL_HEADER_LEN + localNameLen + localExtraLen;
    if (dataOffset + size > bytes.length) throw new Error(`readZip: '${path}' runs past the end`);
    const data = bytes.subarray(dataOffset, dataOffset + size);
    list.push({
      path,
      dataOffset,
      size,
      crcOk: method === 0 && crc32(data) === crc,
      method,
      flags,
      crc,
      headerOffset,
      localExtraLen,
      aligned: dataOffset % USDZ_ALIGN === 0,
    });
  }
  return list;
}

/**
 * The bytes of one entry of a stored ZIP (a view into `bytes`, not a copy).
 * @param {Uint8Array} bytes
 * @param {{ dataOffset: number, size: number }} entry  from readZip
 * @returns {Uint8Array}
 */
export function entryBytes(bytes, entry) {
  return bytes.subarray(entry.dataOffset, entry.dataOffset + entry.size);
}
