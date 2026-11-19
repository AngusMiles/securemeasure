/**
 * Photo intake: turns whatever the phone hands us (camera shot, library photo, demo URL) into
 * one bounded working canvas plus its pixels. Everything stays on the device.
 *
 * Nothing here touches the DOM at import time, so the pure helpers also run under Node.
 */
import { toLuma } from './vision.js';

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {object} Photo
 * @property {HTMLCanvasElement} canvas  working canvas (long side <= measurement.maxWorkingSizePx)
 * @property {ImageData} image           the canvas pixels, grabbed once
 * @property {number} width              working width in px
 * @property {number} height             working height in px
 * @property {boolean} isDemo            true for the bundled demo photo
 * @property {object|null} _luma         lazily cached greyscale copy (see getLuma)
 */

const DEFAULT_MAX_SIDE = 2560;

// 4096 x 4096 is the largest canvas every supported iOS Safari will reliably allocate, so a
// config that asks for more is capped rather than producing a blank canvas.
const HARD_MAX_SIDE = 4096;

// EXIF and the frame header sit at the very start of a JPEG; this is far more than enough.
const SNIFF_BYTES = 256 * 1024;

// A stalled download must not leave the customer staring at a spinner for ever.
const URL_TIMEOUT_MS = 30000;

const FALLBACK_SHEET_MM = { w: 210, h: 297 };

/**
 * Decode a photo and prepare the working image used by every later step.
 *
 * @param {File|Blob|string} source  a picked/captured file, or a URL (relative URLs resolve against the page)
 * @param {object} config            merged app config (uses measurement.maxWorkingSizePx)
 * @param {{ isDemo?: boolean }} [options]
 * @returns {Promise<Photo>}
 * @throws {Error} Error('decode_failed') when the source cannot be decoded
 */
export async function loadPhoto(source, config, { isDemo = false } = {}) {
  let decoded = null;
  try {
    decoded = typeof source === 'string' ? await decodeUrl(source) : await decodeBlob(source);
    if (!(decoded.width > 0 && decoded.height > 0)) throw new Error('empty image');
    const working = drawWorkingCanvas(decoded.drawable, decoded.width, decoded.height, workingMaxSide(config));
    return { ...working, isDemo: Boolean(isDemo), _luma: null };
  } catch (cause) {
    throw new Error('decode_failed', { cause });
  } finally {
    if (decoded) decoded.release();
  }
}

/**
 * Greyscale copy of the working image, computed on first use and cached on the photo.
 *
 * @param {Photo} photo
 * @returns {{ data: Float32Array, width: number, height: number }}
 */
export function getLuma(photo) {
  if (!photo._luma) photo._luma = toLuma(photo.image);
  return photo._luma;
}

/**
 * Side lengths of the reference sheet the customer said is on the door.
 * Falls back to the default reference (then the first one, then A4) when the selection is unusable.
 *
 * @param {{ referenceId: string, customReference?: { widthMm: number|null, heightMm: number|null } }} state
 * @param {object} config
 * @returns {{ w: number, h: number }}
 */
export function getSheetMm(state, config) {
  const measurement = (config && config.measurement) || {};
  const references = Array.isArray(measurement.references) ? measurement.references : [];
  const referenceId = state ? state.referenceId : undefined;

  if (referenceId === 'custom') {
    const custom = (state && state.customReference) || {};
    if (isPositive(custom.widthMm) && isPositive(custom.heightMm)) {
      return { w: custom.widthMm, h: custom.heightMm };
    }
  }

  const usable = references.filter((ref) => ref && isPositive(ref.widthMm) && isPositive(ref.heightMm));
  const reference =
    usable.find((ref) => ref.id === referenceId) ||
    usable.find((ref) => ref.id === measurement.defaultReferenceId) ||
    usable[0];
  return reference ? { w: reference.widthMm, h: reference.heightMm } : { ...FALLBACK_SHEET_MM };
}

/**
 * Small JPEG copy of the working photo, for attaching to an enquiry.
 *
 * @param {Photo} photo
 * @param {number} [maxSide=1024]  long side of the copy in px (never upscales)
 * @param {number} [quality=0.7]   JPEG quality 0..1
 * @returns {string} data URL ('data:image/jpeg;base64,...')
 */
export function photoToJpegDataUrl(photo, maxSide = 1024, quality = 0.7) {
  const { width, height } = fitWithin(photo.width, photo.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // JPEG has no alpha channel: without a backdrop, transparent pixels would come out black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.canvas, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  releaseCanvas(canvas);
  return dataUrl;
}

/**
 * Put a freshly loaded photo into the shared state and clear everything that was derived from
 * the previous one (sheet, door, measurement, size), as the state contract requires.
 * The working canvas of the photo being replaced is released; nothing may draw from it afterwards.
 *
 * @param {object} state  the shared app state (mutated)
 * @param {Photo} photo
 * @returns {void}
 */
export function setPhoto(state, photo) {
  const previous = state.photo;
  if (previous && previous !== photo && previous.canvas) releaseCanvas(previous.canvas);
  state.photo = photo;
  state.sheet = { points: null, refined: false, detected: false };
  state.door = { points: null };
  state.measure = null;
  state.size = null;
  state.manualEntry = false;
}

/**
 * Read the EXIF orientation and the stored (unrotated) pixel size from the head of a JPEG.
 * Pure; returns orientation 1 and null sizes for anything it does not recognise.
 *
 * @param {Uint8Array} bytes  the first bytes of the file
 * @returns {{ orientation: number, width: number|null, height: number|null }}  orientation is the EXIF value 1..8
 */
export function readJpegInfo(bytes) {
  const info = { orientation: 1, width: null, height: null };
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return info;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 2;
    while (pos + 4 <= view.byteLength) {
      if (view.getUint8(pos) !== 0xff) break;
      const marker = view.getUint8(pos + 1);
      if (marker === 0xff) {
        pos += 1; // padding byte before a marker
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2; // markers that carry no length
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break; // image data starts: nothing more to learn
      const length = view.getUint16(pos + 2);
      if (length < 2) break;
      const start = pos + 4;
      if (marker === 0xe1) {
        const orientation = readExifOrientation(view, start, Math.min(pos + 2 + length, view.byteLength));
        if (orientation) info.orientation = orientation;
      } else if (isFrameHeader(marker)) {
        info.height = view.getUint16(start + 1);
        info.width = view.getUint16(start + 3);
        break;
      }
      pos += 2 + length;
    }
  } catch {
    // A truncated or malformed header just means we know less; the decoder has the final say.
  }
  return info;
}

/** @param {number} marker */
function isFrameHeader(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * @param {DataView} view
 * @param {number} start  first payload byte of an APP1 segment
 * @param {number} end    one past its last available byte
 * @returns {number} 1..8, or 0 when this segment holds no orientation
 */
function readExifOrientation(view, start, end) {
  // 'Exif\0\0' (XMP also lives in APP1 and must be skipped)
  if (end - start < 14 || view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return 0;
  const tiff = start + 6;
  const byteOrder = view.getUint16(tiff);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return 0;
  const little = byteOrder === 0x4949;
  if (view.getUint16(tiff + 2, little) !== 42) return 0;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 0;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

/**
 * iOS Safari counts every live canvas against a hard memory budget and is slow to collect
 * them; shrinking a canvas we are finished with hands its memory back straight away, which
 * matters when a customer retakes the photo several times.
 *
 * @param {HTMLCanvasElement} canvas
 */
function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

/** @param {unknown} value */
function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** @param {object} config */
function workingMaxSide(config) {
  const requested = Number(config && config.measurement && config.measurement.maxWorkingSizePx);
  const maxSide = Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_MAX_SIDE;
  return Math.min(Math.floor(maxSide), HARD_MAX_SIDE);
}

/**
 * Scale (down only) so the long side fits within maxSide.
 * @param {number} width
 * @param {number} height
 * @param {number} maxSide
 */
function fitWithin(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * @param {CanvasImageSource} drawable
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} maxSide
 */
function drawWorkingCanvas(drawable, sourceWidth, sourceHeight, maxSide) {
  const { width, height } = fitWithin(sourceWidth, sourceHeight, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  // An opaque backdrop keeps the pixel maths well defined for PNGs with transparency.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  return { canvas, image, width, height };
}

/**
 * @param {Blob} blob
 * @returns {Promise<{ drawable: CanvasImageSource, width: number, height: number, release: () => void }>}
 */
async function decodeBlob(blob) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) throw new Error('not a file');

  const info = await sniffJpeg(blob);
  const bitmap = await decodeBitmap(blob, info);
  if (bitmap) {
    if (bitmapIsUpright(bitmap, info)) {
      return { drawable: bitmap, width: bitmap.width, height: bitmap.height, release: () => closeBitmap(bitmap) };
    }
    closeBitmap(bitmap);
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url, false);
    return { drawable: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * @param {string} url
 * @returns {Promise<{ drawable: CanvasImageSource, width: number, height: number, release: () => void }>}
 */
async function decodeUrl(url) {
  if (url.trim() === '') throw new Error('empty url');
  const img = await loadImageElement(url, isCrossOrigin(url), URL_TIMEOUT_MS);
  return { drawable: img, width: img.naturalWidth, height: img.naturalHeight, release: () => {} };
}

/**
 * @param {Blob} blob
 * @param {{ orientation: number, width: number|null, height: number|null }|null} info  what sniffJpeg read
 * @returns {Promise<ImageBitmap|null>} null when this engine cannot be relied on to decode the blob upright this way
 */
async function decodeBitmap(blob, info) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Older Safari and Chrome reject the options bag (or this value).
  }
  // The plain call cannot be trusted with a rotated photo: Safari 15.0-16.3 returns a bitmap that
  // has the rotated size but unrotated, cut-off pixels, and nothing about its shape gives that
  // away. So it is used only when the header says no rotation is needed; the rest go to <img>.
  if (!isStoredUpright(info)) return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * Whether the header was read as a JPEG that needs no rotation. A file we could not read that far
 * (not a JPEG, such as HEIC, or a header cut short) may still carry a rotation, so it does not count.
 *
 * @param {{ orientation: number, width: number|null, height: number|null }|null} info
 */
function isStoredUpright(info) {
  return Boolean(info && info.orientation === 1 && info.width && info.height);
}

/** @param {ImageBitmap} bitmap */
function closeBitmap(bitmap) {
  if (typeof bitmap.close === 'function') bitmap.close();
}

/**
 * Second check on a bitmap from decodeBitmap: whether the rotation the camera recorded really was
 * applied. Not every engine that accepts the 'from-image' request honours EXIF, which would leave
 * a portrait phone photo lying on its side; <img> decoding is reliable, so we defer to it when unsure.
 *
 * The shape test is only good enough because decodeBitmap never makes the plain createImageBitmap
 * call for a rotated photo: on Safari 15.0-16.3 that bitmap has the right shape and the wrong pixels.
 *
 * @param {ImageBitmap} bitmap
 * @param {{ orientation: number, width: number|null, height: number|null }|null} info
 */
function bitmapIsUpright(bitmap, info) {
  if (!info || info.orientation === 1) return true;
  // Orientations 5..8 swap the sides, so the bitmap's shape shows whether the tag was applied.
  if (info.orientation >= 5 && info.width && info.height && info.width !== info.height) {
    const storedLandscape = info.width > info.height;
    const decodedLandscape = bitmap.width > bitmap.height;
    return storedLandscape !== decodedLandscape;
  }
  return false; // mirrored / upside down / unknown stored size: the shape cannot tell us
}

/**
 * @param {Blob} blob
 * @returns {Promise<{ orientation: number, width: number|null, height: number|null }|null>}
 */
async function sniffJpeg(blob) {
  try {
    const head = await blob.slice(0, SNIFF_BYTES).arrayBuffer();
    return readJpegInfo(new Uint8Array(head));
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @param {boolean} crossOrigin  request with CORS so the canvas stays readable
 * @param {number} [timeoutMs=0]  give up after this long (0 = wait indefinitely)
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageElement(url, crossOrigin, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let timer = 0;
    const settle = (finish, value) => {
      if (timer) clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      finish(value);
    };
    img.decoding = 'async';
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => settle(resolve, img);
    img.onerror = () => settle(reject, new Error('image load failed'));
    if (timeoutMs > 0) timer = setTimeout(() => settle(reject, new Error('image load timed out')), timeoutMs);
    img.src = url;
  });
}

/** @param {string} url */
function isCrossOrigin(url) {
  try {
    const target = new URL(url, document.baseURI);
    return (target.protocol === 'http:' || target.protocol === 'https:') && target.origin !== location.origin;
  } catch {
    return false;
  }
}
