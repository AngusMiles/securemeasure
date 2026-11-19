// Photo metadata for the photo-scale lab: container sniffing, the JPEG APP1 Exif block, the HEIF 'Exif'
// item, a generic TIFF IFD reader and Apple's MakerNote (with tag 0x0038 AFMeasuredDepth, the time-of-flight
// autofocus distance that LiDAR iPhones record).
//
// Pure: no DOM, no globals, safe under Node. Reads bytes only and never runs anything from the file.
// parseMeta never throws: anything it cannot read becomes a warning and a null.
//
// Ported from the research script scale-cues/scripts/makernote.py (tag map and MakerNote layout), with the
// HEIF and bounds handling added for files a phone hands to a web page.

/** Byte size of one value of each TIFF type. */
const TYPE_SIZES = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 });
const TYPE_NAMES = Object.freeze({
  1: 'BYTE', 2: 'ASCII', 3: 'SHORT', 4: 'LONG', 5: 'RATIONAL', 6: 'SBYTE', 7: 'UNDEFINED',
  8: 'SSHORT', 9: 'SLONG', 10: 'SRATIONAL', 11: 'FLOAT', 12: 'DOUBLE', 13: 'IFD',
});

/** ftyp brands that make a file HEIF (HEIC from an iPhone is 'heic' with 'mif1' compatible). */
export const HEIF_BRANDS = Object.freeze(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);

/** Numbers decoded per entry at most (the count is always reported in full). */
const MAX_VALUES = 64;
/** Entries read per IFD at most: a corrupt count must not make us loop for ever. */
const MAX_ENTRIES = 512;
/** Characters kept from an ASCII value. */
const MAX_ASCII = 256;
/** Bytes shown as hex for BYTE / UNDEFINED values. */
const HEX_BYTES = 16;

/** Tags of IFD0 and the Exif IFD that the lab reports by name. */
export const EXIF_TAGS = Object.freeze({
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  software: 0x0131,
  dateTime: 0x0132,
  exifIfd: 0x8769,
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  subjectDistance: 0x9206,
  focalLength: 0x920a,
  subjectArea: 0x9214,
  makerNote: 0x927c,
  pixelX: 0xa002,
  pixelY: 0xa003,
  focal35: 0xa405,
  lensModel: 0xa434,
});

/**
 * Apple MakerNote tags the lab names (ExifTool's Apple.pm names; 0x0039 is a guess). Everything else is
 * still decoded, just without a name.
 */
export const APPLE_TAGS = Object.freeze({
  0x0007: 'AFStable',
  0x0008: 'AccelerationVector',
  0x000c: 'FocusDistanceRange',
  0x0023: 'AFPerformance',
  0x002e: 'CameraType',
  0x002f: 'FocusPosition',
  0x0038: 'AFMeasuredDepth',
  0x0039: 'ROIType?',
  0x003d: 'AFConfidence',
});

export const TAG_AF_DEPTH = 0x0038;
export const TAG_AF_CONFIDENCE = 0x003d;
export const TAG_ACCELERATION = 0x0008;

const APPLE_SIGNATURE = 'Apple iOS\0';

// ---------------------------------------------------------------------------------------------------------
// Small byte helpers. Every read is bounds-checked by the caller or throws a RangeError (DataView), which the
// section that asked catches.
// ---------------------------------------------------------------------------------------------------------

/** @param {Uint8Array} b @param {number} start @param {number} n */
function ascii(b, start, n) {
  let s = '';
  for (let i = start; i < start + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** @param {Uint8Array} b @param {number} start @param {number} n */
export function hexOf(b, start, n) {
  let s = '';
  const end = Math.min(b.length, start + n);
  for (let i = Math.max(0, start); i < end; i++) s += (i > start ? ' ' : '') + b[i].toString(16).padStart(2, '0');
  return s;
}

/** Printable ASCII of a header, other bytes as '.'. */
function printable(b, start, n) {
  let s = '';
  const end = Math.min(b.length, start + n);
  for (let i = Math.max(0, start); i < end; i++) s += b[i] >= 0x20 && b[i] < 0x7f ? String.fromCharCode(b[i]) : '.';
  return s;
}

/** @param {Uint8Array} b */
function viewOf(b) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** Unsigned big-endian integer of n bytes (0..8); exact up to 2^53. */
function uintBE(view, pos, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + view.getUint8(pos + i);
  return v;
}

/** @param {unknown} input */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(0);
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

// ---------------------------------------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------------------------------------

/**
 * What kind of file the bytes are. HEIF needs an ftyp box whose major or a compatible brand is in HEIF_BRANDS.
 *
 * @param {Uint8Array} b
 * @returns {{ container: 'jpeg'|'heif'|'png'|'other', brands: string[] }}
 */
export function sniffContainer(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return { container: 'jpeg', brands: [] };
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { container: 'png', brands: [] };
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const view = viewOf(b);
    const size = Math.min(view.getUint32(0), b.length);
    const brands = [ascii(b, 8, 4)];
    for (let p = 16; p + 4 <= size; p += 4) brands.push(ascii(b, p, 4));
    const heif = brands.some((brand) => HEIF_BRANDS.includes(brand));
    return { container: heif ? 'heif' : 'other', brands };
  }
  return { container: 'other', brands: [] };
}

// ---------------------------------------------------------------------------------------------------------
// JPEG: walk the markers to APP1 'Exif\0\0'
// ---------------------------------------------------------------------------------------------------------

/**
 * @param {Uint8Array} b
 * @param {string[]} warnings
 * @returns {{ start: number, end: number } | null}  the TIFF block (start of 'II'/'MM', one past its end)
 */
export function findJpegTiff(b, warnings) {
  const view = viewOf(b);
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) {
      warnings.push(`JPEG: expected a marker at byte ${pos}, found 0x${b[pos].toString(16)}`);
      return null;
    }
    const marker = b[pos + 1];
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data: no Exif before it
    const length = view.getUint16(pos + 2);
    if (length < 2) {
      warnings.push(`JPEG: segment 0x${marker.toString(16)} has a bad length`);
      return null;
    }
    const start = pos + 4;
    const end = Math.min(pos + 2 + length, b.length);
    if (marker === 0xe1 && end - start >= 6 && ascii(b, start, 4) === 'Exif' && b[start + 4] === 0 && b[start + 5] === 0) {
      if (pos + 2 + length > b.length) warnings.push('JPEG: the Exif segment is cut short');
      return { start: start + 6, end };
    }
    pos += 2 + length;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// HEIF: ftyp, meta (FullBox) > iinf (infe v2/v3) + iloc (v0-2) -> the 'Exif' item's bytes; with several
// Exif items, the one iref 'cdsc' links to the primary item (pitm)
// ---------------------------------------------------------------------------------------------------------

/**
 * The boxes between start and end. A box that claims to run past `end` is cut to it (with a warning).
 * @returns {Array<{ type: string, start: number, data: number, end: number }>}
 */
function readBoxes(b, start, end, warnings, where) {
  const view = viewOf(b);
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end && boxes.length < 4096) {
    let size = view.getUint32(pos);
    const type = ascii(b, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = uintBE(view, pos + 8, 8);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (type === 'uuid') header += 16;
    if (size < header) {
      warnings.push(`HEIF: box '${type}' in ${where} has a bad size`);
      break;
    }
    let boxEnd = pos + size;
    if (boxEnd > end) {
      warnings.push(`HEIF: box '${type}' in ${where} is cut short`);
      boxEnd = end;
    }
    boxes.push({ type, start: pos, data: pos + header, end: boxEnd });
    pos = boxEnd;
  }
  return boxes;
}

/**
 * The ids of every item of type 'Exif' in an iinf box, in file order, and every item type seen.
 * @param {{ data: number, end: number }} box
 * @returns {{ ids: number[], types: string[] }}
 */
function exifItemIds(b, box, warnings) {
  const view = viewOf(b);
  const version = b[box.data];
  let pos = box.data + 4;
  const count = version === 0 ? view.getUint16(pos) : view.getUint32(pos);
  pos += version === 0 ? 2 : 4;
  const entries = readBoxes(b, pos, box.end, warnings, 'iinf');
  if (entries.length < count) warnings.push(`HEIF: iinf says ${count} items, found ${entries.length}`);
  const types = [];
  const ids = [];
  for (const infe of entries) {
    if (infe.type !== 'infe') continue;
    const v = b[infe.data];
    if (v < 2) continue; // v0/v1 entries carry no item type
    let p = infe.data + 4;
    const id = v === 2 ? view.getUint16(p) : view.getUint32(p);
    p += v === 2 ? 2 : 4;
    p += 2; // item_protection_index
    if (p + 4 > infe.end) continue;
    const type = ascii(b, p, 4);
    types.push(type);
    if (type === 'Exif') ids.push(id);
  }
  return { ids, types };
}

/**
 * The primary item id from a pitm box (FullBox: v0 a 16-bit id, v1 a 32-bit one), or null.
 * @param {{ data: number, end: number }} box
 */
function primaryItemId(b, box) {
  const view = viewOf(b);
  const version = b[box.data];
  const p = box.data + 4;
  const size = version === 0 ? 2 : 4;
  if (p + size > box.end) return null;
  return size === 2 ? view.getUint16(p) : view.getUint32(p);
}

/**
 * The references of an iref box (FullBox: v0 16-bit ids, v1 32-bit): each child box is one reference type
 * ('cdsc' = this item describes those, 'thmb', 'auxl', 'dimg'...) from one item to a list of items.
 * @param {{ data: number, end: number }} box
 * @returns {Array<{ type: string, from: number, to: number[] }>}
 */
function itemReferences(b, box, warnings) {
  const view = viewOf(b);
  const version = b[box.data];
  const size = version === 0 ? 2 : 4;
  const id = (p) => (size === 2 ? view.getUint16(p) : view.getUint32(p));
  const refs = [];
  for (const r of readBoxes(b, box.data + 4, box.end, warnings, 'iref')) {
    let p = r.data;
    if (p + size + 2 > r.end) continue;
    const from = id(p);
    p += size;
    const n = view.getUint16(p);
    p += 2;
    const to = [];
    for (let i = 0; i < n && p + size <= r.end; i++, p += size) to.push(id(p));
    refs.push({ type: r.type, from, to });
  }
  return refs;
}

/**
 * The extents of item `id` from an iloc box (versions 0-2). Only construction_method 0 (file offsets).
 * @returns {{ extents: Array<{ offset: number, length: number }>, method: number } | null}
 */
function ilocExtents(b, box, id, warnings) {
  const view = viewOf(b);
  const version = b[box.data];
  if (version > 2) {
    warnings.push(`HEIF: iloc version ${version} is not supported`);
    return null;
  }
  let pos = box.data + 4;
  const offsetSize = b[pos] >> 4;
  const lengthSize = b[pos] & 15;
  const baseOffsetSize = b[pos + 1] >> 4;
  const indexSize = version === 1 || version === 2 ? b[pos + 1] & 15 : 0;
  pos += 2;
  const count = version < 2 ? view.getUint16(pos) : view.getUint32(pos);
  pos += version < 2 ? 2 : 4;
  for (let i = 0; i < count && pos < box.end; i++) {
    const itemId = version < 2 ? view.getUint16(pos) : view.getUint32(pos);
    pos += version < 2 ? 2 : 4;
    let method = 0;
    if (version === 1 || version === 2) {
      method = view.getUint16(pos) & 15;
      pos += 2;
    }
    pos += 2; // data_reference_index
    const baseOffset = uintBE(view, pos, baseOffsetSize);
    pos += baseOffsetSize;
    const extentCount = view.getUint16(pos);
    pos += 2;
    const extents = [];
    for (let e = 0; e < extentCount; e++) {
      pos += indexSize;
      const offset = uintBE(view, pos, offsetSize);
      pos += offsetSize;
      const length = uintBE(view, pos, lengthSize);
      pos += lengthSize;
      extents.push({ offset: baseOffset + offset, length });
    }
    if (pos > box.end) throw new RangeError('iloc runs past its box');
    if (itemId === id) return { extents, method };
  }
  return null;
}

/**
 * The TIFF block of a HEIF file's Exif item.
 * @param {Uint8Array} b
 * @param {string[]} warnings
 * @returns {{ bytes: Uint8Array, start: number, end: number } | null}  `bytes` may be a copy (several extents)
 */
export function findHeifTiff(b, warnings) {
  try {
    return findHeifTiffUnsafe(b, warnings);
  } catch (e) {
    warnings.push(`HEIF: the boxes are cut short or malformed (${errText(e)})`);
    return null;
  }
}

function findHeifTiffUnsafe(b, warnings) {
  const top = readBoxes(b, 0, b.length, warnings, 'file');
  const meta = top.find((box) => box.type === 'meta');
  if (!meta) {
    warnings.push('HEIF: no meta box');
    return null;
  }
  // meta is a FullBox; a QuickTime-style one without version/flags starts straight with a child box.
  const fullBox = ascii(b, meta.data + 4, 4) !== 'hdlr';
  const children = readBoxes(b, meta.data + (fullBox ? 4 : 0), meta.end, warnings, 'meta');
  const iinf = children.find((box) => box.type === 'iinf');
  const iloc = children.find((box) => box.type === 'iloc');
  if (!iinf || !iloc) {
    warnings.push(`HEIF: meta has no ${iinf ? 'iloc' : 'iinf'} box`);
    return null;
  }
  const { ids, types } = exifItemIds(b, iinf, warnings);
  if (!ids.length) {
    warnings.push(`HEIF: no item of type 'Exif' (item types: ${types.join(', ') || 'none'})`);
    return null;
  }
  // The Exif item that describes the primary image ('cdsc' -> pitm), not one for a thumbnail, an auxiliary
  // or a gain-map image, which may carry no MakerNote.
  const pitm = children.find((box) => box.type === 'pitm');
  const iref = children.find((box) => box.type === 'iref');
  let primary = null;
  let refs = [];
  try {
    primary = pitm ? primaryItemId(b, pitm) : null;
    refs = iref ? itemReferences(b, iref, warnings) : [];
  } catch (e) {
    // A broken pitm or iref must not cost the Exif itself: fall back to the first Exif item.
    warnings.push(`HEIF: pitm/iref unreadable (${errText(e)}); the first Exif item is read`);
  }
  const describes = (id) => refs.filter((r) => r.type === 'cdsc' && r.from === id).flatMap((r) => r.to);
  const ofPrimary = primary === null ? [] : ids.filter((id) => describes(id).includes(primary));
  const id = ofPrimary.length ? ofPrimary[0] : ids[0];
  const linked = ids.some((x) => describes(x).length);
  if (ids.length > 1 || (primary !== null && linked && !ofPrimary.length)) {
    const list = ids.map((x) => {
      const to = describes(x);
      return `${x}${to.length ? ` (describes item ${to.join(', ')})` : ' (linked to no item)'}`;
    });
    const why = ofPrimary.length ? 'the one that describes the primary item' : 'none describes the primary item, so the first';
    warnings.push(`HEIF: ${ids.length} Exif item(s): ${list.join('; ')}; primary item ${primary === null ? 'not given' : primary}; item ${id} was read (${why})`);
    for (const other of ids) {
      if (other === id) continue;
      warnings.push(`HEIF: Exif item ${other} (not read): ${otherExifSummary(b, iloc, other)}`);
    }
  }
  return exifItemTiff(b, iloc, id, warnings);
}

/** One line on what an Exif item that was not read holds, so a MakerNote in the wrong item shows up. */
function otherExifSummary(b, iloc, id) {
  try {
    const scratch = [];
    const tiff = exifItemTiff(b, iloc, id, scratch);
    if (!tiff) return `unreadable (${scratch[scratch.length - 1] || 'no TIFF'})`;
    const { maker } = readTiff(tiff.bytes, tiff.start, tiff.end, scratch);
    if (!maker.apple) return `no Apple MakerNote (${maker.reason || 'not Apple'})`;
    return `Apple MakerNote with ${maker.tags.length} tags, 0x0038 ${maker.afDepthRaw === null ? 'absent' : `= ${maker.afDepthRaw}`}`;
  } catch (e) {
    return `unreadable (${errText(e)})`;
  }
}

/** The TIFF block of one Exif item, from its iloc extents. */
function exifItemTiff(b, iloc, id, warnings) {
  const loc = ilocExtents(b, iloc, id, warnings);
  if (!loc || !loc.extents.length) {
    warnings.push(`HEIF: the Exif item ${id} has no location`);
    return null;
  }
  if (loc.method !== 0) {
    warnings.push(`HEIF: the Exif item uses construction_method ${loc.method}; only 0 (file offsets) is read`);
    return null;
  }
  if (loc.extents.length === 1) {
    const { offset, length } = loc.extents[0];
    const end = length === 0 ? b.length : Math.min(b.length, offset + length);
    if (offset >= b.length) {
      warnings.push('HEIF: the Exif item lies past the end of the file (cut short?)');
      return null;
    }
    if (length && offset + length > b.length) warnings.push('HEIF: the Exif item is cut short');
    return locateTiff(b, offset, end, warnings);
  }
  // Several extents: join them so the TIFF offsets inside are contiguous.
  const parts = loc.extents.map(({ offset, length }) => b.subarray(Math.min(offset, b.length), Math.min(b.length, offset + length)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.length;
  }
  return locateTiff(data, 0, total, warnings);
}

/**
 * An Exif item starts with a big-endian uint32 offset to the TIFF header, usually 6 to skip 'Exif\0\0'.
 * Some writers put 'Exif\0\0' after the offset as well; that prefix is skipped too.
 */
function locateTiff(bytes, start, end, warnings) {
  if (end - start < 4) {
    warnings.push('HEIF: the Exif item is too short');
    return null;
  }
  const view = viewOf(bytes);
  let tiff = start + 4 + view.getUint32(start);
  const isTiff = (p) => p + 4 <= end && (ascii(bytes, p, 2) === 'II' || ascii(bytes, p, 2) === 'MM');
  if (!isTiff(tiff) && tiff + 6 <= end && ascii(bytes, tiff, 6) === 'Exif\0\0') tiff += 6;
  if (!isTiff(tiff)) {
    // Last resort: look for the header near the start of the item.
    const found = [];
    for (let p = start + 4; p < Math.min(end - 4, start + 64); p++) if (isTiff(p) && bytes[p + 2] + bytes[p + 3] === 42) found.push(p);
    if (!found.length) {
      warnings.push('HEIF: no TIFF header in the Exif item');
      return null;
    }
    warnings.push('HEIF: the Exif item offset was wrong; found the TIFF header by searching');
    tiff = found[0];
  }
  return { bytes, start: tiff, end };
}

// ---------------------------------------------------------------------------------------------------------
// TIFF IFDs
// ---------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} IfdEntry
 * @property {number} tag
 * @property {number} type
 * @property {string} typeName
 * @property {number} count
 * @property {Array<number|null>|string|null} value  numbers (rationals as num/den, null for a zero
 *   denominator), the string for ASCII, null for BYTE/UNDEFINED (see hex) or an unreadable value
 * @property {string} [hex]       first 16 bytes as hex, for BYTE / SBYTE / UNDEFINED
 * @property {number} [byteLength]
 * @property {number} pos         absolute position of the value
 * @property {boolean} [truncated] only the first MAX_VALUES numbers were decoded
 * @property {string} [error]
 */

/**
 * Read one IFD. Offsets are relative to `base` (the TIFF header, or the MakerNote start for Apple's).
 *
 * @param {Uint8Array} b
 * @param {number} base
 * @param {number} offset  IFD offset from base
 * @param {number} end     one past the last readable byte
 * @param {boolean} little
 * @param {string[]} warnings
 * @param {string} label   for warnings
 * @returns {{ entries: IfdEntry[], next: number }}
 */
export function readIfd(b, base, offset, end, little, warnings, label) {
  const view = viewOf(b);
  const entries = [];
  const ifd = base + offset;
  if (!(offset >= 0) || ifd + 2 > end) {
    warnings.push(`${label}: IFD offset ${offset} is outside the data`);
    return { entries, next: 0 };
  }
  let count = view.getUint16(ifd, little);
  if (count > MAX_ENTRIES) {
    warnings.push(`${label}: ${count} entries claimed; reading ${MAX_ENTRIES}`);
    count = MAX_ENTRIES;
  }
  let pos = ifd + 2;
  for (let i = 0; i < count; i++, pos += 12) {
    if (pos + 12 > end) {
      warnings.push(`${label}: cut short after ${i} of ${count} entries`);
      return { entries, next: 0 };
    }
    entries.push(readEntry(b, view, base, pos, end, little));
  }
  const next = pos + 4 <= end ? view.getUint32(pos, little) : 0;
  return { entries, next };
}

function readEntry(b, view, base, pos, end, little) {
  const tag = view.getUint16(pos, little);
  const type = view.getUint16(pos + 2, little);
  const count = view.getUint32(pos + 4, little);
  const typeName = TYPE_NAMES[type] || `type${type}`;
  const entry = { tag, type, typeName, count, value: null, pos: pos + 8 };
  const size = TYPE_SIZES[type];
  if (!size) {
    entry.error = 'unknown type';
    entry.hex = hexOf(b, pos + 8, 4);
    return entry;
  }
  const total = size * count;
  const valuePos = total <= 4 ? pos + 8 : base + view.getUint32(pos + 8, little);
  entry.pos = valuePos;
  if (!(valuePos >= 0) || valuePos + total > end || valuePos + total > b.length) {
    entry.error = 'value outside the data';
    return entry;
  }
  try {
    entry.value = decodeValue(b, view, type, count, valuePos, little, entry);
  } catch (e) {
    entry.error = errText(e);
    entry.value = null;
  }
  return entry;
}

function decodeValue(b, view, type, count, at, little, entry) {
  const n = Math.min(count, MAX_VALUES);
  if (count > MAX_VALUES && type !== 2 && type !== 1 && type !== 6 && type !== 7) entry.truncated = true;
  switch (type) {
    case 2: {
      let s = ascii(b, at, Math.min(count, MAX_ASCII));
      const nul = s.indexOf('\0');
      if (nul >= 0) s = s.slice(0, nul);
      return s;
    }
    case 1:
    case 6:
    case 7: {
      entry.hex = hexOf(b, at, HEX_BYTES);
      entry.byteLength = count;
      if (type === 7) return null;
      const out = [];
      for (let i = 0; i < Math.min(count, 16); i++) out.push(type === 1 ? b[at + i] : view.getInt8(at + i));
      return out;
    }
    case 3:
    case 8: {
      const out = [];
      for (let i = 0; i < n; i++) out.push(type === 3 ? view.getUint16(at + 2 * i, little) : view.getInt16(at + 2 * i, little));
      return out;
    }
    case 4:
    case 9:
    case 13: {
      const out = [];
      for (let i = 0; i < n; i++) out.push(type === 9 ? view.getInt32(at + 4 * i, little) : view.getUint32(at + 4 * i, little));
      return out;
    }
    case 5:
    case 10: {
      const out = [];
      for (let i = 0; i < n; i++) {
        const num = type === 5 ? view.getUint32(at + 8 * i, little) : view.getInt32(at + 8 * i, little);
        const den = type === 5 ? view.getUint32(at + 8 * i + 4, little) : view.getInt32(at + 8 * i + 4, little);
        if (den === 0) entry.zeroDenominator = true;
        out.push(den === 0 ? null : num / den);
      }
      return out;
    }
    case 11:
    case 12: {
      const out = [];
      for (let i = 0; i < n; i++) out.push(type === 11 ? view.getFloat32(at + 4 * i, little) : view.getFloat64(at + 8 * i, little));
      return out;
    }
    default:
      return null;
  }
}

/** @param {IfdEntry[]} entries @param {number} tag */
function find(entries, tag) {
  return entries.find((e) => e.tag === tag) || null;
}

/** The first number of an entry, or null. */
function firstNumber(entry) {
  if (!entry || !Array.isArray(entry.value) || !entry.value.length) return null;
  const v = entry.value[0];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** All numbers of an entry (null for a zero denominator), or null. */
function numbers(entry) {
  return entry && Array.isArray(entry.value) ? entry.value.slice() : null;
}

function text(entry) {
  return entry && typeof entry.value === 'string' ? entry.value : null;
}

/** A compact, JSON-friendly copy of an entry for display and export. */
export function entryRow(entry, names = null) {
  const row = {
    tag: `0x${entry.tag.toString(16).padStart(4, '0')}`,
    name: names && names[entry.tag] ? names[entry.tag] : '',
    type: entry.typeName,
    count: entry.count,
    value: entry.value,
  };
  if (entry.hex !== undefined) row.hex = entry.hex;
  if (entry.zeroDenominator) row.zeroDenominator = true;
  if (entry.truncated) row.truncated = true;
  if (entry.error) row.error = entry.error;
  return row;
}

// ---------------------------------------------------------------------------------------------------------
// Apple MakerNote
// ---------------------------------------------------------------------------------------------------------

function emptyMaker(reason) {
  return { present: false, apple: false, reason, header: null, tags: [], afDepthRaw: null, afConfidence: null, accel: null };
}

/**
 * Apple's MakerNote: 'Apple iOS\0', a 2-byte version, 'MM' at offset 12, the IFD at offset 14, offsets
 * relative to the MakerNote's own start, big-endian. Every entry is decoded.
 *
 * @param {Uint8Array} b
 * @param {number} start
 * @param {number} length
 * @param {string[]} warnings
 */
export function readAppleMakerNote(b, start, length, warnings) {
  const end = Math.min(b.length, start + length);
  const maker = {
    present: true,
    apple: false,
    reason: null,
    byteLength: length,
    header: { ascii: printable(b, start, 16), hex: hexOf(b, start, 16) },
    version: null,
    tags: [],
    afDepthRaw: null,
    afConfidence: null,
    accel: null,
  };
  if (end - start < 10) {
    maker.reason = 'makernote_cut_short';
    warnings.push(`MakerNote: only ${Math.max(0, end - start)} bytes could be read`);
    return maker;
  }
  if (ascii(b, start, 10) !== APPLE_SIGNATURE) {
    maker.reason = 'not_apple';
    warnings.push(`MakerNote is not Apple's (starts '${maker.header.ascii}')`);
    return maker;
  }
  maker.apple = true;
  const view = viewOf(b);
  maker.version = view.getUint16(start + 10);
  const order = ascii(b, start + 12, 2);
  let little = false;
  if (order === 'II') little = true;
  else if (order !== 'MM') warnings.push(`Apple MakerNote: byte order '${printable(b, start + 12, 2)}', read as big-endian`);
  const { entries } = readIfd(b, start, 14, end, little, warnings, 'Apple MakerNote');
  maker.tags = entries.map((e) => entryRow(e, APPLE_TAGS));
  maker.afDepthRaw = firstNumber(find(entries, TAG_AF_DEPTH));
  maker.afConfidence = firstNumber(find(entries, TAG_AF_CONFIDENCE));
  const accel = numbers(find(entries, TAG_ACCELERATION));
  maker.accel = accel && accel.length >= 3 && accel.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v)) ? accel.slice(0, 3) : null;
  if (accel && !maker.accel) warnings.push('Apple MakerNote: AccelerationVector is unreadable (zero denominator?)');
  return maker;
}

// ---------------------------------------------------------------------------------------------------------
// TIFF -> named Exif fields + MakerNote
// ---------------------------------------------------------------------------------------------------------

/**
 * Named fields of IFD0 and the Exif IFD, plus the MakerNote.
 * @param {Uint8Array} b
 * @param {number} start  TIFF header ('II'/'MM')
 * @param {number} end
 * @param {string[]} warnings
 */
export function readTiff(b, start, end, warnings) {
  const view = viewOf(b);
  if (end - start < 8) {
    warnings.push('TIFF: header cut short');
    return { exif: null, maker: emptyMaker('no_exif') };
  }
  const order = ascii(b, start, 2);
  if (order !== 'II' && order !== 'MM') {
    warnings.push(`TIFF: bad byte order '${printable(b, start, 2)}'`);
    return { exif: null, maker: emptyMaker('no_exif') };
  }
  const little = order === 'II';
  if (view.getUint16(start + 2, little) !== 42) warnings.push('TIFF: magic number is not 42');
  const ifd0 = readIfd(b, start, view.getUint32(start + 4, little), end, little, warnings, 'IFD0').entries;
  const T = EXIF_TAGS;
  const orientation = firstNumber(find(ifd0, T.orientation));
  const exif = {
    byteOrder: order,
    make: text(find(ifd0, T.make)),
    model: text(find(ifd0, T.model)),
    software: text(find(ifd0, T.software)),
    orientation: orientation >= 1 && orientation <= 8 ? orientation : null,
    dateTime: text(find(ifd0, T.dateTime)),
    hasExifIfd: false,
    exposureTime: null,
    fNumber: null,
    iso: null,
    focalLength: null,
    focal35: null,
    subjectArea: null,
    pixelX: null,
    pixelY: null,
    lensModel: null,
    subjectDistance: null,
    makerNoteBytes: null,
    ifd0Tags: ifd0.map((e) => `0x${e.tag.toString(16).padStart(4, '0')}`),
    exifTags: [],
  };
  const pointer = firstNumber(find(ifd0, T.exifIfd));
  if (pointer === null) {
    warnings.push('TIFF: no Exif IFD');
    return { exif, maker: emptyMaker('no_exif_ifd') };
  }
  const sub = readIfd(b, start, pointer, end, little, warnings, 'Exif IFD').entries;
  exif.hasExifIfd = true;
  exif.exifTags = sub.map((e) => `0x${e.tag.toString(16).padStart(4, '0')}`);
  exif.exposureTime = firstNumber(find(sub, T.exposureTime));
  exif.fNumber = firstNumber(find(sub, T.fNumber));
  exif.iso = firstNumber(find(sub, T.iso));
  exif.focalLength = firstNumber(find(sub, T.focalLength));
  const f35 = firstNumber(find(sub, T.focal35));
  exif.focal35 = f35 > 0 ? f35 : null;
  const area = numbers(find(sub, T.subjectArea));
  exif.subjectArea = area && area.length >= 2 && area.every(Number.isFinite) ? area.slice(0, 4) : null;
  exif.pixelX = firstNumber(find(sub, T.pixelX));
  exif.pixelY = firstNumber(find(sub, T.pixelY));
  exif.lensModel = text(find(sub, T.lensModel));
  exif.subjectDistance = firstNumber(find(sub, T.subjectDistance));
  for (const e of [find(sub, T.exposureTime), find(sub, T.fNumber), find(sub, T.focalLength), find(sub, T.subjectDistance)]) {
    if (e && e.zeroDenominator) warnings.push(`Exif 0x${e.tag.toString(16)}: zero denominator (value unknown)`);
  }
  const note = find(sub, T.makerNote);
  if (!note) return { exif, maker: emptyMaker('no_makernote_tag') };
  exif.makerNoteBytes = note.count;
  if (note.error) {
    warnings.push(`MakerNote: ${note.error}`);
    // A note cut short by a truncated file can still give its first entries.
    if (!(note.pos >= 0 && note.pos < Math.min(end, b.length))) return { exif, maker: emptyMaker('makernote_unreadable') };
  }
  const length = Math.min(note.count, Math.min(end, b.length) - note.pos);
  return { exif, maker: readAppleMakerNote(b, note.pos, length, warnings) };
}

// ---------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------

/**
 * Everything the lab reads from a photo file. Never throws.
 *
 * @param {ArrayBuffer|Uint8Array} input  the whole file (or as much of it as was read)
 * @returns {{
 *   container: 'jpeg'|'heif'|'png'|'other', brands: string[], byteLength: number,
 *   exif: object|null,
 *   maker: { present: boolean, apple: boolean, reason: string|null, header: object|null, tags: object[],
 *            afDepthRaw: number|null, afConfidence: number|null, accel: number[]|null },
 *   warnings: string[], head64?: string
 * }}
 */
export function parseMeta(input) {
  const warnings = [];
  const out = { container: 'other', brands: [], byteLength: 0, exif: null, maker: emptyMaker('no_exif'), warnings };
  try {
    const b = toBytes(input);
    out.byteLength = b.length;
    const sniff = sniffContainer(b);
    out.container = sniff.container;
    out.brands = sniff.brands;
    let tiff = null;
    if (sniff.container === 'jpeg') {
      const found = findJpegTiff(b, warnings);
      if (found) tiff = { bytes: b, start: found.start, end: found.end };
      else warnings.push('JPEG: no Exif (APP1) segment');
    } else if (sniff.container === 'heif') {
      tiff = findHeifTiff(b, warnings);
    } else {
      out.head64 = hexOf(b, 0, 64);
      warnings.push(sniff.container === 'png' ? 'PNG: Exif is not read from PNG files' : `unknown file type${sniff.brands.length ? ` (brands ${sniff.brands.join(', ')})` : ''}`);
    }
    if (tiff) {
      const { exif, maker } = readTiff(tiff.bytes, tiff.start, tiff.end, warnings);
      out.exif = exif;
      out.maker = maker;
    }
  } catch (e) {
    warnings.push(`metadata could not be read: ${errText(e)}`);
  }
  return out;
}
