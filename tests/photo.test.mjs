/**
 * Which decoder loadPhoto (js/photo.js) ends up drawing from, per browser behaviour; the EXIF reader
 * (orientation and the 35 mm-equivalent focal length the no-paper estimate uses); what a loaded photo
 * carries; and what setPhoto resets. Runs under Node with the few browser globals photo.js touches stubbed.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadPhoto, readJpegInfo, setPhoto } from '../js/photo.js';

const CONFIG = { measurement: { maxWorkingSizePx: 2560 } };

/** Smallest JPEG head the sniffer understands: SOI, APP1/Exif with an orientation, SOF0 with the stored size. */
function jpegHead(orientation, width, height) {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1Length = exif.length + 2;
  const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, app1Length >> 8, app1Length & 255, ...exif, ...sof, 0xff, 0xd9]);
}

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** @type {{ calls: string[], drawnFrom: any, closed: number, revoked: number }} */
let seen;

/** @param {{ bitmap?: (blob: Blob, options?: object) => Promise<object>, img?: { w: number, h: number } }} engine */
function installBrowser({ bitmap, img = { w: 3024, h: 4032 } }) {
  seen = { calls: [], drawnFrom: null, closed: 0, revoked: 0 };
  if (bitmap) {
    globalThis.createImageBitmap = async (blob, options) => {
      seen.calls.push(options ? `options:${options.imageOrientation}` : 'plain');
      const result = await bitmap(blob, options);
      return { ...result, kind: 'bitmap', close: () => { seen.closed += 1; } };
    };
  } else {
    delete globalThis.createImageBitmap;
  }
  globalThis.Image = class {
    constructor() {
      this.kind = 'img';
      this.naturalWidth = img.w;
      this.naturalHeight = img.h;
    }
    set src(_value) {
      seen.calls.push('img');
      queueMicrotask(() => this.onload && this.onload());
    }
  };
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => { seen.revoked += 1; };
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillRect() {},
        drawImage(drawable) { seen.drawnFrom = drawable; },
        getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(4) }),
      }),
    }),
  };
}

/** Safari 15.0-16.3: 'from-image' is not in the enum; the plain call gives the rotated size with unrotated pixels. */
const oldSafari = (rotatedSize) => async (_blob, options) => {
  if (options) throw new TypeError("'from-image' is not a valid enum value");
  return { width: rotatedSize.w, height: rotatedSize.h, pixels: 'unrotated' };
};

beforeEach(() => {
  delete globalThis.createImageBitmap;
});

test('sniffer reads the portrait iPhone header', () => {
  assert.deepEqual(readJpegInfo(jpegHead(6, 4032, 3024)), { orientation: 6, width: 4032, height: 3024, focal35mm: null });
});

test('Safari 15.0-16.3, portrait photo (orientation 6): decoded through <img>, plain bitmap call never made', async () => {
  installBrowser({ bitmap: oldSafari({ w: 3024, h: 4032 }) });
  const photo = await loadPhoto(new Blob([jpegHead(6, 4032, 3024)], { type: 'image/jpeg' }), CONFIG);
  assert.deepEqual(seen.calls, ['options:from-image', 'img']);
  assert.equal(seen.drawnFrom.kind, 'img');
  assert.equal(photo.width, 1920);
  assert.equal(photo.height, 2560);
  assert.equal(seen.revoked, 1);
});

for (const orientation of [2, 3, 4, 5, 7, 8]) {
  test(`Safari 15.0-16.3, orientation ${orientation}: decoded through <img>`, async () => {
    installBrowser({ bitmap: oldSafari({ w: 3024, h: 4032 }) });
    await loadPhoto(new Blob([jpegHead(orientation, 4032, 3024)], { type: 'image/jpeg' }), CONFIG);
    assert.deepEqual(seen.calls, ['options:from-image', 'img']);
    assert.equal(seen.drawnFrom.kind, 'img');
  });
}

test('Safari 15.0-16.3, JPEG stored upright (orientation 1): plain bitmap is still used', async () => {
  installBrowser({ bitmap: oldSafari({ w: 4032, h: 3024 }) });
  const photo = await loadPhoto(new Blob([jpegHead(1, 4032, 3024)], { type: 'image/jpeg' }), CONFIG);
  assert.deepEqual(seen.calls, ['options:from-image', 'plain']);
  assert.equal(seen.drawnFrom.kind, 'bitmap');
  assert.equal(photo.width, 2560);
  assert.equal(photo.height, 1920);
  assert.equal(seen.closed, 1);
});

test('Safari 15.0-16.3, not a JPEG (rotation unknown): decoded through <img>', async () => {
  installBrowser({ bitmap: oldSafari({ w: 3024, h: 4032 }) });
  await loadPhoto(new Blob([PNG_HEAD], { type: 'image/heic' }), CONFIG);
  assert.deepEqual(seen.calls, ['options:from-image', 'img']);
  assert.equal(seen.drawnFrom.kind, 'img');
});

test('Safari 15.0-16.3, JPEG header cut short before the frame size: decoded through <img>', async () => {
  installBrowser({ bitmap: oldSafari({ w: 3024, h: 4032 }) });
  await loadPhoto(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])], { type: 'image/jpeg' }), CONFIG);
  assert.deepEqual(seen.calls, ['options:from-image', 'img']);
});

test('Safari 15.0-16.3, header could not be read at all: decoded through <img>', async () => {
  installBrowser({ bitmap: oldSafari({ w: 3024, h: 4032 }) });
  const blob = new Blob([jpegHead(6, 4032, 3024)], { type: 'image/jpeg' });
  blob.slice = () => { throw new Error('read failed'); };
  await loadPhoto(blob, CONFIG);
  assert.deepEqual(seen.calls, ['options:from-image', 'img']);
});

test("engine that accepts 'from-image' and rotates: bitmap is used", async () => {
  installBrowser({ bitmap: async () => ({ width: 3024, height: 4032 }) });
  const photo = await loadPhoto(new Blob([jpegHead(6, 4032, 3024)], { type: 'image/jpeg' }), CONFIG);
  assert.deepEqual(seen.calls, ['options:from-image']);
  assert.equal(seen.drawnFrom.kind, 'bitmap');
  assert.equal(photo.width, 1920);
  assert.equal(photo.height, 2560);
  assert.equal(seen.closed, 1);
});

test("engine that accepts 'from-image' but ignores EXIF: bitmap is closed and <img> is used", async () => {
  installBrowser({ bitmap: async () => ({ width: 4032, height: 3024 }) });
  await loadPhoto(new Blob([jpegHead(6, 4032, 3024)], { type: 'image/jpeg' }), CONFIG);
  assert.deepEqual(seen.calls, ['options:from-image', 'img']);
  assert.equal(seen.drawnFrom.kind, 'img');
  assert.equal(seen.closed, 1);
});

test('no createImageBitmap at all: <img> is used', async () => {
  installBrowser({});
  await loadPhoto(new Blob([jpegHead(6, 4032, 3024)], { type: 'image/jpeg' }), CONFIG);
  assert.deepEqual(seen.calls, ['img']);
});

test('both decoders fail: decode_failed', async () => {
  installBrowser({ bitmap: async () => { throw new Error('cannot decode'); } });
  globalThis.Image = class {
    set src(_value) { queueMicrotask(() => this.onerror && this.onerror()); }
  };
  await assert.rejects(loadPhoto(new Blob([jpegHead(1, 4032, 3024)], { type: 'image/jpeg' }), CONFIG), /decode_failed/);
  assert.deepEqual(seen.calls, ['options:from-image', 'plain']);
  assert.equal(seen.revoked, 1);
});

/* ---------------------------------------------------------------- EXIF focal length -------------- */

/**
 * A JPEG head with a realistic EXIF block, built byte by byte in either byte order: IFD0 holds the
 * orientation and the ExifIFDPointer; the Exif sub-IFD holds an out-of-line ExposureTime (RATIONAL),
 * ExposureMode and, unless left out, FocalLengthIn35mmFilm.
 *
 * @param {object} o
 * @param {'II'|'MM'} [o.order]
 * @param {number} [o.orientation]
 * @param {number|null} [o.focal35mm]   null leaves the tag out
 * @param {number} [o.focalType]        3 SHORT (the spec), 4 LONG
 * @param {boolean} [o.exifPointer]     false leaves the ExifIFDPointer out of IFD0
 * @param {number} [o.pointerOverride]  write this offset into the ExifIFDPointer instead of the real one
 * @param {number} [o.app1Shortfall]    declare the APP1 segment this many bytes shorter than it is
 * @param {number} [o.width]            stored (SOF) width
 * @param {number} [o.height]           stored (SOF) height
 * @param {{ w: number, h: number }|null} [o.pixelSize]  EXIF PixelX/YDimension; null leaves them out
 * @param {number} [o.pixelType]        3 SHORT, 4 LONG (what phones write)
 */
function exifJpeg({ order = 'II', orientation = 6, focal35mm = 26, focalType = 3, exifPointer = true, pointerOverride, app1Shortfall = 0, width = 4032, height = 3024, pixelSize = null, pixelType = 4 } = {}) {
  const little = order === 'II';
  const bytes = [];
  const u16 = (v) => (little ? bytes.push(v & 255, (v >> 8) & 255) : bytes.push((v >> 8) & 255, v & 255));
  const u32 = (v) => (little ? bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255) : bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
  const entry = (tag, type, count, write) => {
    u16(tag);
    u16(type);
    u32(count);
    const at = bytes.length;
    write();
    while (bytes.length < at + 4) bytes.push(0);
  };

  // TIFF header + IFD0 at offset 8.
  bytes.push(little ? 0x49 : 0x4d, little ? 0x49 : 0x4d);
  u16(42);
  u32(8);
  const ifd0Count = exifPointer ? 2 : 1;
  const exifIfdOffset = 8 + 2 + ifd0Count * 12 + 4;
  u16(ifd0Count);
  entry(0x0112, 3, 1, () => u16(orientation));
  if (exifPointer) entry(0x8769, 4, 1, () => u32(pointerOverride !== undefined ? pointerOverride : exifIfdOffset));
  u32(0); // no IFD1
  // Exif sub-IFD.
  const exifCount = 2 + (focal35mm === null ? 0 : 1) + (pixelSize ? 2 : 0);
  const rationalOffset = exifIfdOffset + 2 + exifCount * 12 + 4;
  u16(exifCount);
  entry(0x829a, 5, 1, () => u32(rationalOffset)); // ExposureTime, stored after the IFD
  if (pixelSize) {
    const dim = (v) => () => (pixelType === 4 ? u32(v) : u16(v));
    entry(0xa002, pixelType, 1, dim(pixelSize.w)); // PixelXDimension
    entry(0xa003, pixelType, 1, dim(pixelSize.h)); // PixelYDimension
  }
  entry(0xa402, 3, 1, () => u16(0)); // ExposureMode: auto
  if (focal35mm !== null) entry(0xa405, focalType, 1, () => (focalType === 4 ? u32(focal35mm) : u16(focal35mm)));
  u32(0);
  u32(1);
  u32(120); // 1/120 s

  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...bytes];
  const app1Length = exif.length + 2 - app1Shortfall;
  const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, app1Length >> 8, app1Length & 255, ...exif, ...sof, 0xff, 0xd9]);
}

test('EXIF FocalLengthIn35mmFilm is read from the Exif sub-IFD in both byte orders', () => {
  for (const order of ['II', 'MM']) {
    assert.deepEqual(readJpegInfo(exifJpeg({ order })), { orientation: 6, width: 4032, height: 3024, focal35mm: 26 }, order);
    assert.equal(readJpegInfo(exifJpeg({ order, focal35mm: 77, orientation: 1 })).focal35mm, 77, `${order} telephoto`);
    assert.equal(readJpegInfo(exifJpeg({ order, focal35mm: 24, focalType: 4 })).focal35mm, 24, `${order} written as a LONG`);
  }
});

test('EXIF without the focal tag, without the Exif sub-IFD, or with focal 0 (unknown): focal35mm is null', () => {
  for (const order of ['II', 'MM']) {
    assert.deepEqual(readJpegInfo(exifJpeg({ order, focal35mm: null })), { orientation: 6, width: 4032, height: 3024, focal35mm: null });
    assert.deepEqual(readJpegInfo(exifJpeg({ order, exifPointer: false })), { orientation: 6, width: 4032, height: 3024, focal35mm: null });
    assert.equal(readJpegInfo(exifJpeg({ order, focal35mm: 0 })).focal35mm, null);
    assert.equal(readJpegInfo(exifJpeg({ order, focalType: 5 })).focal35mm, null, 'wrong type');
  }
  assert.equal(readJpegInfo(PNG_HEAD).focal35mm, null);
  assert.equal(readJpegInfo(new Uint8Array(0)).focal35mm, null);
  assert.equal(readJpegInfo(null).focal35mm, null);
});

test('truncated or out-of-bounds EXIF never throws, loses only what is missing, and never reads past the segment', () => {
  for (const order of ['II', 'MM']) {
    const full = exifJpeg({ order });
    // File cut short inside the Exif sub-IFD: the orientation in IFD0 survives, the focal length does not.
    for (const cut of [60, 64, 70, 76]) {
      assert.deepEqual(readJpegInfo(full.slice(0, cut)), { orientation: 6, width: null, height: null, focal35mm: null }, `${order} cut at ${cut}`);
    }
    // Cut inside IFD0: nothing but the defaults.
    assert.deepEqual(readJpegInfo(full.slice(0, 20)), { orientation: 1, width: null, height: null, focal35mm: null });
    // Pointer past the segment, or wrapping round to a huge offset.
    for (const pointerOverride of [4000, 0xfffffff0, 2]) {
      assert.deepEqual(readJpegInfo(exifJpeg({ order, pointerOverride })), { orientation: 6, width: 4032, height: 3024, focal35mm: null }, `${order} pointer ${pointerOverride}`);
    }
    // The segment declared too short to hold the focal entry: the bytes after its end are not EXIF.
    const short = readJpegInfo(exifJpeg({ order, app1Shortfall: 20 }));
    assert.equal(short.focal35mm, null);
    assert.equal(short.orientation, 6);
  }
});

test("the focal is dropped when EXIF's own pixel size has another shape than the frame (a cropped copy)", () => {
  const camera = { w: 4032, h: 3024 };
  for (const order of ['II', 'MM']) {
    for (const pixelType of [3, 4]) {
      const tag = `${order} ${pixelType === 3 ? 'SHORT' : 'LONG'}`;
      // The camera's own file, the size written either way up, and a scaled-down copy: same shape, kept.
      assert.deepEqual(readJpegInfo(exifJpeg({ order, pixelType, pixelSize: camera })), { orientation: 6, width: 4032, height: 3024, focal35mm: 26 }, tag);
      assert.equal(readJpegInfo(exifJpeg({ order, pixelType, pixelSize: { w: 3024, h: 4032 } })).focal35mm, 26, `${tag} rotated size`);
      assert.equal(readJpegInfo(exifJpeg({ order, pixelType, pixelSize: camera, width: 2016, height: 1512 })).focal35mm, 26, `${tag} scaled down`);
      // Cropped in a gallery app that copied the EXIF: to the door (1600 x 3000) or to 3:2.
      assert.deepEqual(
        readJpegInfo(exifJpeg({ order, pixelType, pixelSize: camera, width: 3000, height: 1600 })),
        { orientation: 6, width: 3000, height: 1600, focal35mm: null },
        `${tag} cropped to the door`,
      );
      assert.equal(readJpegInfo(exifJpeg({ order, pixelType, pixelSize: camera, width: 4032, height: 2688 })).focal35mm, null, `${tag} cropped to 3:2`);
    }
    // A missing or zero dimension says nothing, so the focal stays.
    assert.equal(readJpegInfo(exifJpeg({ order, pixelSize: { w: 0, h: 3024 }, width: 3000, height: 1600 })).focal35mm, 26, `${order} zero width`);
    assert.equal(readJpegInfo(exifJpeg({ order, pixelSize: { w: 4032, h: 0 }, width: 3000, height: 1600 })).focal35mm, 26, `${order} zero height`);
  }
});

/* ---------------------------------------------------------------- what a photo carries ----------- */

test('a loaded photo carries its EXIF focal and how it was captured', async () => {
  installBrowser({ bitmap: async () => ({ width: 3024, height: 4032 }) });
  const jpeg = () => new Blob([exifJpeg({ focal35mm: 26 })], { type: 'image/jpeg' });

  const picked = await loadPhoto(jpeg(), CONFIG);
  assert.equal(picked.focal35mm, 26);
  assert.equal(picked.capture, 'file');
  assert.equal(picked.isDemo, false);
  assert.equal(picked.width, 1920);
  assert.equal(picked.height, 2560);

  for (const capture of ['live', 'frame', 'file']) assert.equal((await loadPhoto(jpeg(), CONFIG, { capture })).capture, capture);
  assert.equal((await loadPhoto(jpeg(), CONFIG, { capture: 'webcam' })).capture, 'file', 'unknown kinds count as a file');
  assert.equal((await loadPhoto(jpeg(), CONFIG, { capture: 'demo' })).capture, 'demo');
  const demoBlob = await loadPhoto(jpeg(), CONFIG, { isDemo: true, capture: 'live' });
  assert.equal(demoBlob.capture, 'demo', 'isDemo implies demo');
  assert.equal(demoBlob.isDemo, true);

  const frame = await loadPhoto(new Blob([jpegHead(1, 1920, 1080)], { type: 'image/jpeg' }), CONFIG, { capture: 'frame' });
  assert.equal(frame.focal35mm, null, 'a canvas-encoded video frame has no EXIF');
  const png = await loadPhoto(new Blob([PNG_HEAD], { type: 'image/png' }), CONFIG);
  assert.equal(png.focal35mm, null);
});

test('a picked photo cropped in a gallery app that kept the camera EXIF carries no focal', async () => {
  installBrowser({ bitmap: async () => ({ width: 1600, height: 3000 }) });
  const crop = new Blob([exifJpeg({ focal35mm: 26, pixelSize: { w: 4032, h: 3024 }, width: 3000, height: 1600 })], { type: 'image/jpeg' });
  const picked = await loadPhoto(crop, CONFIG);
  assert.equal(picked.focal35mm, null);
  assert.equal(picked.width, 1365, 'the crop, scaled to the 2560 px working size');
  assert.equal(picked.height, 2560);

  installBrowser({ bitmap: async () => ({ width: 3024, height: 4032 }) });
  const whole = await loadPhoto(new Blob([exifJpeg({ focal35mm: 26, pixelSize: { w: 4032, h: 3024 } })], { type: 'image/jpeg' }), CONFIG);
  assert.equal(whole.focal35mm, 26, "the camera's own file keeps it");
});

test('a photo decoded through <img> keeps the focal; a URL source (the demo) has none', async () => {
  installBrowser({});
  const viaImg = await loadPhoto(new Blob([exifJpeg({ order: 'MM', focal35mm: 28 })], { type: 'image/jpeg' }), CONFIG);
  assert.deepEqual(seen.calls, ['img']);
  assert.equal(viaImg.focal35mm, 28);

  const demo = await loadPhoto('assets/demo-door.png', CONFIG, { isDemo: true });
  assert.equal(demo.focal35mm, null);
  assert.equal(demo.capture, 'demo');
  assert.equal(demo.isDemo, true);
});

test('setPhoto clears the door corners AND the door detection, and leaves the way in alone', () => {
  const oldCanvas = { width: 1920, height: 2560 };
  const state = {
    method: 'estimate',
    photo: { canvas: oldCanvas },
    sheet: { points: [1, 2, 3, 4], refined: true, detected: true },
    door: { points: [{ x: 1, y: 2 }], detection: { ok: true, quad: [], confidence: 0.9, alternatives: [] } },
    measure: { ok: true },
    size: { widthMm: 820, heightMm: 2040, source: 'estimate' },
    manualEntry: true,
  };
  const photo = { canvas: { width: 10, height: 10 } };
  setPhoto(state, photo);
  assert.equal(state.photo, photo);
  assert.deepEqual(state.door, { points: null, detection: null });
  assert.deepEqual(state.sheet, { points: null, refined: false, detected: false });
  assert.equal(state.measure, null);
  assert.equal(state.size, null);
  assert.equal(state.manualEntry, false);
  assert.equal(state.method, 'estimate', 'callers set the method themselves');
  assert.equal(oldCanvas.width, 0, 'the previous working canvas is released');
});
