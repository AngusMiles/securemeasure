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
  for (const options of [null, { prior: 'nope' }, { prior: [{ x: NaN, y: 1 }, {}, null, 4] }, { timeoutMs: -1 }, { loadTimeoutMs: 'soon' }]) {
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
 * Like the real one it says { ready: true } once "loaded" (after `readyAfterMs`; null: never, as an old
 * cached worker script would not), and holds a request until then.
 */
function installWorker({ answer = 'ok', throwOnCreate = false, readyAfterMs = 0 } = {}) {
  const log = { created: [], posted: [], terminated: 0 };
  globalThis.Worker = class {
    constructor(url, options) {
      if (throwOnCreate) throw new Error('SecurityError');
      log.created.push({ url: String(url), options });
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      if (readyAfterMs !== null && answer !== 'error') {
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: { ready: true } });
        }, readyAfterMs);
      }
    }
    postMessage(message, transfer) {
      const received = structuredClone(message, { transfer });
      log.posted.push({ message, transfer, received });
      setTimeout(() => {
        if (answer === 'ok' && this.onmessage) this.onmessage({ data: structuredClone(handleMessage(received)) });
        if (answer === 'wrong-id' && this.onmessage) this.onmessage({ data: { id: -1, result: { ok: false, reason: 'stale' } } });
        if (answer === 'error' && this.onerror) this.onerror({ preventDefault() {} });
      }, (readyAfterMs ?? 0) + 5);
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

test("worker path: the search's time limit starts once the worker is ready, not while its code loads", async () => {
  const fallback = await findDoor(photo);
  // Loading takes longer than the whole search may: still the worker's answer, not a timeout.
  const log = installWorker({ readyAfterMs: 120 });
  const r = await findDoor(photo, { timeoutMs: 60 });
  assert.deepEqual(r, fallback);
  assert.equal(log.posted.length, 1, 'the request is posted straight away (the worker holds it until loaded)');
  assert.equal(log.terminated, 1);

  // An old cached worker script that never says it is ready still answers, within the load allowance.
  installWorker({ readyAfterMs: null });
  assert.deepEqual(await findDoor(photo, { timeoutMs: 60 }), fallback);
});

test('worker path: a worker that has not started within the load allowance is given up for the main thread', async () => {
  const log = installWorker({ answer: 'none', readyAfterMs: null });
  const started = Date.now();
  const r = await findDoor(photo, { timeoutMs: 10000, loadTimeoutMs: 50 });
  assert.equal(r.ok, true, 'answered on the main thread');
  assert.ok(maxErr(r.quad, truth) < TOL);
  assert.equal(log.terminated, 1, 'the stalled worker is stopped');
  assert.ok(Date.now() - started < 5000, 'without waiting for the search time limit');
});

test('worker path: a worker that starts late gets only what is left of the wait, not a whole search on top', async () => {
  // The capture screen waits behind "Finding your door…". With its defaults (a 4 s search, 6 s to start) a
  // worker ready at 5.9 s has until 6 s, not 9.9 s; here, scaled down, one ready at 350 ms of a 400 ms
  // allowance has until 400 ms, not 350 + 350 ms. The door screen then looks again in the background.
  const log = installWorker({ answer: 'none', readyAfterMs: 350 });
  const started = Date.now();
  const r = await findDoor(photo, { timeoutMs: 350, loadTimeoutMs: 400 });
  const took = Date.now() - started;
  assert.deepEqual(r, { ok: false, quad: null, confidence: 0, alternatives: [], reason: 'timeout' });
  assert.ok(took < 600, `answered after ${took} ms`);
  assert.equal(log.terminated, 1);
});

test('worker path, in the background: a worker that has not started in time is a timeout, not a main-thread search', async () => {
  // The door screen's own search runs while the customer may be dragging a corner: a slow-to-start worker
  // must not turn into a detection on the main thread, which freezes the page (a timeout is looked for
  // again on the next visit).
  const fallback = await findDoor(photo, { background: true });
  assert.equal(fallback.ok, true, 'no Worker in this engine: the main thread still searches');
  let log = installWorker({ answer: 'none', readyAfterMs: null });
  const started = Date.now();
  const r = await findDoor(photo, { timeoutMs: 10000, loadTimeoutMs: 50, background: true });
  assert.deepEqual(r, { ok: false, quad: null, confidence: 0, alternatives: [], reason: 'timeout' }, 'not searched on the main thread');
  assert.equal(log.terminated, 1, 'the stalled worker is stopped');
  assert.ok(Date.now() - started < 5000, 'without waiting for the search time limit');

  // A worker that starts in time still answers, and one that fails to load still means the main thread:
  // the search would never get done otherwise.
  log = installWorker({ readyAfterMs: 20 });
  assert.deepEqual(await findDoor(photo, { loadTimeoutMs: 2000, background: true }), fallback);
  assert.equal(log.terminated, 1);
  installWorker({ answer: 'error' });
  assert.deepEqual(await findDoor(photo, { background: true }), fallback);
});

test('signal: a search its caller gave up on stops the worker and never starts on the main thread', async () => {
  // Aborted while the worker is still loading: a timeout straight away (it settled nothing), worker stopped.
  let log = installWorker({ answer: 'none', readyAfterMs: null });
  const leaving = new AbortController();
  const started = Date.now();
  const pending = findDoor(photo, { loadTimeoutMs: 2000, signal: leaving.signal });
  setTimeout(() => leaving.abort(), 10);
  assert.equal((await pending).reason, 'timeout', 'not searched on the main thread after the load allowance');
  assert.ok(Date.now() - started < 1000, 'at the abort, not at the end of the load allowance');
  assert.equal(log.terminated, 1);

  // Already aborted: no worker is even made.
  log = installWorker();
  const gone = new AbortController();
  gone.abort();
  assert.equal((await findDoor(photo, { signal: gone.signal })).reason, 'timeout');
  assert.equal(log.created.length, 0);

  // No Worker in this engine, aborted while it yields before the main-thread search: never started.
  delete globalThis.Worker;
  const late = new AbortController();
  const yielding = findDoor(photo, { signal: late.signal });
  late.abort();
  assert.equal((await yielding).reason, 'timeout');

  // Not aborted: the answer as usual, and aborting after it answered changes nothing.
  const kept = new AbortController();
  const fallback = await findDoor(photo);
  installWorker();
  assert.deepEqual(await findDoor(photo, { signal: kept.signal }), fallback);
  kept.abort();
  assert.deepEqual(await findDoor(photo, { signal: { aborted: false } }), fallback, 'anything shaped like a signal');
});

test('worker module, in a worker scope: listens, then says it is ready, then answers each request', async () => {
  // The real worker script's half of the start-up protocol (findDoor only starts the search's own time
  // limit at { ready: true }; a worker that never said so would be given up at the load allowance).
  const saved = ['self', 'WorkerGlobalScope'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const posted = [];
  globalThis.WorkerGlobalScope = class {};
  globalThis.self = { postMessage: (message) => posted.push({ message, listening: typeof globalThis.self.onmessage === 'function' }) };
  try {
    await import('../js/door-detect-worker.js?scope=1');
    assert.deepEqual(posted, [{ message: { ready: true }, listening: true }], 'ready once, and only after it listens');
    const image = blankImage(320, 400);
    globalThis.self.onmessage({ data: { id: 3, image, opts: {} } });
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[1].message, { id: 3, result: runDetection(image, {}) });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
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
