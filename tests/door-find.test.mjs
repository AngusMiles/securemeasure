/**
 * Finding the door without blocking the page (js/door-find.js, js/door-detect-worker.js).
 * Node has no global Worker, so findDoor takes its main-thread fallback here; the worker path is driven
 * with a stand-in Worker that answers through the real worker module, with the pixel buffer really
 * transferred (structuredClone), so the photo keeping its own pixels is checked for real.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { findDoor, startingQuad, isConfident, CONFIDENT, runDetection } from '../js/door-find.js';
import { handleMessage } from '../js/door-detect-worker.js';
import { detectDoor, suggestDefaultQuad } from '../js/door-detect.js';
import { renderScene } from '../tools/scene.mjs';
import { cameraHomography } from '../tools/camera.mjs';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const maxErr = (q, t) => Math.max(...q.map((p, i) => dist(p, t[i])));

/** A paper-free synthetic door photo (the same kind of scene the detector's own tests use). */
function renderDoor({ width = 1536, height = 2048, door = { w: 870, h: 2040 }, yawDeg = 8, distanceMm = 2600, focalPx = 1538 } = {}) {
  const target = { x: door.w / 2, y: door.h * 0.52 };
  const pitchDeg = (Math.asin((door.h - 1400 - target.y) / distanceMm) * 180) / Math.PI;
  const camera = { focalPx, target, distanceMm, yawDeg, pitchDeg, rollDeg: 0.7 };
  const planeToImage = cameraHomography({ imageWidth: width, imageHeight: height, ...camera });
  return renderScene({ width, height, camera, planeToImage, doorMm: door, sheet: null, noiseSigma: 1.5, blurPx: 0.7, supersample: 2, decor: true, seed: 3, pixelOrigin: 'corner' });
}

/** What loadPhoto hands the screens, minus the canvas. */
const asPhoto = (image) => ({ canvas: null, image, width: image.width, height: image.height, isDemo: false, focal35mm: null, capture: 'file', _luma: null });

const scene = renderDoor();
const truth = scene.truth.doorPx;
const photo = asPhoto(scene.image);
// The detector lands 3-5 px low on this render's shadowed sill (see tests/door-detect.test.mjs).
const TOL = 8;

const blankImage = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(180), width: w, height: h });
const checksum = (data) => {
  let s = 0;
  for (let i = 0; i < data.length; i += 97) s = (s * 31 + data[i]) >>> 0;
  return s;
};

afterEach(() => {
  delete globalThis.Worker;
});

test('Node has no Worker: the main-thread fallback finds the door, confidently', async () => {
  assert.equal(typeof globalThis.Worker, 'undefined');
  const r = await findDoor(photo);
  assert.equal(r.ok, true);
  assert.ok(maxErr(r.quad, truth) < TOL, `max corner error ${maxErr(r.quad, truth).toFixed(2)} px`);
  assert.ok(r.confidence > CONFIDENT, `confidence ${r.confidence}`);
  assert.equal(isConfident(r), true);
  assert.ok(Array.isArray(r.alternatives) && r.alternatives.every((q) => q.length === 4));
  // Only the small, plain shape goes into state.door.detection (no detector debug fields).
  assert.deepEqual(Object.keys(r).sort(), ['alternatives', 'confidence', 'ok', 'quad']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('never throws or rejects, whatever it is given', async () => {
  const bad = [
    undefined,
    null,
    {},
    { image: null },
    { image: { data: new Uint8ClampedArray(10), width: 100, height: 100 } },
    { image: { data: new Uint8ClampedArray(64), width: -4, height: 4 } },
    { image: { data: null, width: 100, height: 100 } },
    { image: { data: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16 } },
  ];
  for (const p of bad) {
    const r = await findDoor(p);
    assert.equal(r.ok, false);
    assert.equal(r.quad, null);
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.alternatives, []);
    assert.equal(typeof r.reason, 'string');
  }
  assert.equal((await findDoor(null)).reason, 'bad_input');
  // Unusable options are ignored rather than fatal.
  for (const options of [null, { prior: 'nope' }, { prior: [{ x: NaN, y: 1 }, {}, null, 4] }, { timeoutMs: -1 }]) {
    const r = await findDoor(photo, options);
    assert.equal(r.ok, true);
  }
});

test('a photo with no door: ok false with a reason, and the starting handles fall back to the default', async () => {
  const blank = asPhoto(blankImage(600, 800));
  const r = await findDoor(blank);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_lines');
  assert.equal(isConfident(r), false);
  assert.deepEqual(startingQuad(blank, r), suggestDefaultQuad(600, 800));
});

test('startingQuad: detected outline when there is one, else the default; fresh points inside the photo', () => {
  const W = photo.width;
  const H = photo.height;
  assert.deepEqual(startingQuad(photo, null), suggestDefaultQuad(W, H));
  assert.deepEqual(startingQuad(photo, undefined), suggestDefaultQuad(W, H));
  assert.deepEqual(startingQuad(photo, { ok: false, quad: null, confidence: 0, alternatives: [], reason: 'timeout' }), suggestDefaultQuad(W, H));
  assert.deepEqual(startingQuad(photo, { ok: true, quad: null, confidence: 0.9 }), suggestDefaultQuad(W, H), 'ok without a quad');

  const quad = [{ x: 100, y: 200 }, { x: 600, y: 210 }, { x: 610, y: 1800 }, { x: 95, y: 1790 }];
  const detection = { ok: true, quad, confidence: 0.3, alternatives: [] };
  const start = startingQuad(photo, detection);
  assert.deepEqual(start, quad);
  assert.notEqual(start, quad);
  assert.notEqual(start[0], quad[0]);

  const outside = [{ x: -12, y: -3 }, { x: W + 5, y: 10 }, { x: W + 1, y: H + 9 }, { x: 20, y: H + 2 }];
  assert.deepEqual(startingQuad(photo, { ok: true, quad: outside, confidence: 0.9, alternatives: [] }), [
    { x: 0, y: 0 },
    { x: W, y: 10 },
    { x: W, y: H },
    { x: 20, y: H },
  ]);
  assert.ok(startingQuad(null, null).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), 'no photo size: still finite');
});

test('isConfident is strictly above CONFIDENT, and only for a usable detection', () => {
  const quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }, { x: 0, y: 2 }];
  assert.equal(CONFIDENT, 0.6);
  assert.equal(isConfident(null), false);
  assert.equal(isConfident({ ok: false, quad: null, confidence: 0.9 }), false);
  assert.equal(isConfident({ ok: true, quad, confidence: 0.6 }), false);
  assert.equal(isConfident({ ok: true, quad, confidence: 0.61 }), true);
  assert.equal(isConfident({ ok: true, quad: null, confidence: 0.9 }), false);
  assert.equal(isConfident({ ok: true, quad, confidence: '0.9' }), false);
});

test('prior: a guide near the door is used; a guide nowhere near it falls back to the whole photo', async () => {
  const near = truth.map((p, i) => ({ x: p.x + [25, -30, 20, -15][i], y: p.y + [-20, 25, 30, -25][i] }));
  const withPrior = await findDoor(photo, { prior: near });
  assert.equal(withPrior.ok, true);
  assert.ok(maxErr(withPrior.quad, truth) < TOL);

  const far = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 130 }, { x: 10, y: 130 }];
  assert.equal(detectDoor(scene.image, { prior: far }).reason, 'no_candidate_near_prior', 'the guide alone finds nothing');
  const retried = await findDoor(photo, { prior: far });
  assert.equal(retried.ok, true);
  assert.ok(maxErr(retried.quad, truth) < TOL);
});

/**
 * Stand-in for a browser module Worker: answers through the real worker module, after a real structured
 * clone WITH transfer, so a transferred buffer is detached on the sending side exactly as in a browser.
 */
function installWorker({ answer = 'ok', throwOnCreate = false } = {}) {
  const log = { created: [], posted: [], terminated: 0 };
  globalThis.Worker = class {
    constructor(url, options) {
      if (throwOnCreate) throw new Error('SecurityError');
      log.created.push({ url: String(url), options });
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
    }
    postMessage(message, transfer) {
      const received = structuredClone(message, { transfer });
      log.posted.push({ message, transfer, received });
      setTimeout(() => {
        if (answer === 'ok' && this.onmessage) this.onmessage({ data: structuredClone(handleMessage(received)) });
        if (answer === 'wrong-id' && this.onmessage) this.onmessage({ data: { id: -1, result: { ok: false, reason: 'stale' } } });
        if (answer === 'error' && this.onerror) this.onerror({ preventDefault() {} });
      }, 5);
    }
    terminate() {
      log.terminated += 1;
    }
  };
  return log;
}

test('worker path: a module worker gets a transferred COPY of the pixels and answers like the fallback', async () => {
  const before = checksum(photo.image.data);
  const length = photo.image.data.length;
  const fallback = await findDoor(photo);
  const log = installWorker();
  const r = await findDoor(photo);
  assert.equal(log.created.length, 1);
  assert.match(log.created[0].url, /\/js\/door-detect-worker\.js$/);
  assert.deepEqual(log.created[0].options, { type: 'module' });
  const { message, transfer } = log.posted[0];
  assert.equal(transfer.length, 1);
  assert.equal(transfer[0].byteLength, 0, 'the copy was transferred (detached here)');
  assert.notEqual(message.image.data, photo.image.data);
  assert.equal(photo.image.data.length, length, "the photo's own pixels are not detached");
  assert.equal(checksum(photo.image.data), before);
  assert.equal(log.terminated, 1, 'one request per worker, terminated after');
  assert.deepEqual(r, fallback);
});

test('worker path: no answer in time is a timeout (and the worker is stopped); a stale reply is ignored', async () => {
  let log = installWorker({ answer: 'none' });
  const r = await findDoor(photo, { timeoutMs: 40 });
  assert.deepEqual(r, { ok: false, quad: null, confidence: 0, alternatives: [], reason: 'timeout' });
  assert.equal(log.terminated, 1);
  assert.deepEqual(startingQuad(photo, r), suggestDefaultQuad(photo.width, photo.height));

  log = installWorker({ answer: 'wrong-id' });
  const stale = await findDoor(photo, { timeoutMs: 60 });
  assert.equal(stale.reason, 'timeout');
  assert.equal(log.terminated, 1);
});

test('worker path: a worker that fails to load or cannot be created falls back to the main thread', async () => {
  const log = installWorker({ answer: 'error' });
  const r = await findDoor(photo);
  assert.equal(r.ok, true);
  assert.ok(maxErr(r.quad, truth) < TOL);
  assert.equal(log.terminated, 1);

  installWorker({ throwOnCreate: true });
  const created = await findDoor(photo);
  assert.equal(created.ok, true);
  assert.ok(maxErr(created.quad, truth) < TOL);
});

test('worker module: handleMessage answers every message, malformed ones with a failure', () => {
  assert.deepEqual(handleMessage(null), { id: undefined, result: { ok: false, quad: null, confidence: 0, alternatives: [], reason: 'bad_input' } });
  assert.equal(handleMessage({ id: 7 }).id, 7);
  assert.equal(handleMessage({ id: 7, image: { data: [1, 2], width: 10, height: 10 } }).result.reason, 'bad_input');
  const blank = handleMessage({ id: 'a', image: blankImage(320, 400), opts: null });
  assert.equal(blank.id, 'a');
  assert.equal(blank.result.ok, false);
  assert.equal(blank.result.reason, 'no_lines');
  assert.deepEqual(runDetection(blankImage(320, 400)), blank.result);
});
