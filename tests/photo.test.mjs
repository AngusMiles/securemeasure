/**
 * Which decoder loadPhoto (js/photo.js) ends up drawing from, per browser behaviour.
 * Runs under Node with the few browser globals photo.js touches stubbed.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadPhoto, readJpegInfo } from '../js/photo.js';

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
  assert.deepEqual(readJpegInfo(jpegHead(6, 4032, 3024)), { orientation: 6, width: 4032, height: 3024 });
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
