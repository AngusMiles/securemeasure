/**
 * The classical door-opening detector (js/door-detect.js) on paper-free synthetic photos from the dev
 * renderer (tools/scene.mjs), whose exact corner positions are known. Ported from the research prototype's
 * tests; its real-photo regression check needs the benchmark photos and an image decoder, so it stays there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectDoor, snapQuad, suggestDefaultQuad, FEATURES, WEIGHTS } from '../js/door-detect.js';
import { renderScene } from '../tools/scene.mjs';
import { cameraHomography } from '../tools/camera.mjs';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const maxErr = (q, t) => Math.max(...q.map((p, i) => dist(p, t[i])));

/** A paper-free synthetic door photo that is NOT one of the benchmark renders. */
function render({ width = 1536, height = 2048, door = { w: 870, h: 2040 }, yawDeg = 8, distanceMm = 2600, focalPx = 1538, colors, seed = 3 } = {}) {
  const target = { x: door.w / 2, y: door.h * 0.52 };
  const pitchDeg = (Math.asin((door.h - 1400 - target.y) / distanceMm) * 180) / Math.PI;
  const camera = { focalPx, target, distanceMm, yawDeg, pitchDeg, rollDeg: 0.7 };
  const planeToImage = cameraHomography({ imageWidth: width, imageHeight: height, ...camera });
  return renderScene({ width, height, camera, planeToImage, doorMm: door, sheet: null, colors, noiseSigma: 1.5, blurPx: 0.7, supersample: 2, decor: true, seed, pixelOrigin: 'corner' });
}

const scene = render();
const truth = scene.truth.doorPx;

test('model tables are consistent', () => {
  assert.equal(WEIGHTS.length, FEATURES.length);
  assert.ok(WEIGHTS.every(Number.isFinite));
});

test('rejects bad input without throwing', () => {
  assert.equal(detectDoor(null).reason, 'bad_input');
  assert.equal(detectDoor({ data: new Uint8ClampedArray(10), width: 100, height: 100 }).reason, 'bad_input');
  assert.equal(detectDoor({ data: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16 }).reason, 'bad_input');
});

test('a blank image yields no door', () => {
  const w = 600;
  const h = 800;
  const data = new Uint8ClampedArray(w * h * 4).fill(180);
  const r = detectDoor({ data, width: w, height: h });
  assert.equal(r.ok, false);
  assert.equal(r.quad, null);
  assert.equal(r.confidence, 0);
});

// The sill sits on a dark shadow band in this render; the edge search lands 3-5 px low there (about 1 cm on a
// 2 m door), so the bound is 8 px (0.3% of the diagonal). Head and jambs come out at sub-pixel accuracy.
const TOL = 8;

test('finds the opening of a synthetic door within a few pixels, confidently', () => {
  const r = detectDoor(scene.image);
  assert.equal(r.ok, true);
  assert.equal(r.quad.length, 4);
  const e = maxErr(r.quad, truth);
  assert.ok(e < TOL, `max corner error ${e.toFixed(2)} px`);
  assert.ok(dist(r.quad[0], truth[0]) < 1.5 && dist(r.quad[1], truth[1]) < 1.5, 'top corners sub-pixel-ish');
  assert.ok(r.confidence > 0.6, `confidence ${r.confidence}`);
  assert.equal(r.refined, true);
  // [TL, TR, BR, BL] order
  assert.ok(r.quad[0].x < r.quad[1].x && r.quad[3].x < r.quad[2].x && r.quad[0].y < r.quad[3].y && r.quad[1].y < r.quad[2].y);
});

test('works on a white door in a white frame on a pale wall (low contrast) and in landscape', () => {
  const low = render({ width: 2048, height: 1536, yawDeg: -12, colors: { door: '#f2f0ea', doorPanel: '#e6e3dc', architrave: '#ffffff', wall: '#ece7de' }, seed: 9 });
  const r = detectDoor(low.image);
  assert.equal(r.ok, true);
  const e = maxErr(r.quad, low.truth.doorPx);
  assert.ok(e < 0.03 * Math.hypot(2048, 1536), `max corner error ${e.toFixed(1)} px`);
});

// ~50 ms median on a desktop; the bound leaves room for the rest of the suite running in parallel.
test('runs in under 300 ms on a 2048 px photo (single thread, after warm-up)', () => {
  detectDoor(scene.image);
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    detectDoor(scene.image);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[1] < 300, `median ${times[1].toFixed(0)} ms`);
});

test('is deterministic', () => {
  const a = detectDoor(scene.image);
  const b = detectDoor(scene.image);
  assert.deepEqual(a.quad, b.quad);
  assert.equal(a.confidence, b.confidence);
});

test('hint: only quads containing the tap are considered', () => {
  const c = { x: truth.reduce((s, p) => s + p.x, 0) / 4, y: truth.reduce((s, p) => s + p.y, 0) / 4 };
  const r = detectDoor(scene.image, { hint: c });
  assert.ok(maxErr(r.quad, truth) < TOL);
  const away = detectDoor(scene.image, { hint: { x: 30, y: 30 } });
  if (away.ok) {
    const q = away.quad;
    assert.ok(Math.min(q[0].x, q[3].x) <= 40 && Math.min(q[0].y, q[1].y) <= 40, 'returned quad must contain the hint');
  } else {
    assert.match(away.reason, /no_candidate/);
  }
});

test('prior: a rough guide quad is snapped onto the opening', () => {
  const prior = truth.map((p, i) => ({ x: p.x + [25, -30, 20, -15][i], y: p.y + [-20, 25, 30, -25][i] }));
  const r = detectDoor(scene.image, { prior });
  assert.equal(r.ok, true);
  assert.ok(maxErr(r.quad, truth) < TOL);
});

test('alternatives are clearly different quads', () => {
  const r = detectDoor(scene.image);
  const diag = Math.hypot(scene.image.width, scene.image.height);
  for (const alt of r.alternatives) assert.ok(maxErr(alt, r.quad) > 0.03 * diag);
});

test('snapQuad pulls handles placed ~10 px off onto the edges', () => {
  const rough = truth.map((p, i) => ({ x: p.x + [8, -7, 9, -6][i], y: p.y + [-6, 9, -8, 7][i] }));
  const s = snapQuad(scene.image, rough, { radiusPx: 16 });
  assert.equal(s.ok, true);
  assert.ok(maxErr(s.quad, truth) < 1.5, `after snap ${maxErr(s.quad, truth).toFixed(2)} px`);
  assert.equal(snapQuad(scene.image, null).ok, false);
});

test('suggestDefaultQuad is a centred, door-shaped rectangle inside the photo', () => {
  for (const [W, H] of [[1536, 2048], [2048, 1536], [600, 600]]) {
    const q = suggestDefaultQuad(W, H);
    const w = q[1].x - q[0].x;
    const h = q[3].y - q[0].y;
    assert.ok(Math.abs(h / w - 2.35) < 1e-9);
    assert.ok(q.every((p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H));
    assert.ok(Math.abs((q[0].x + q[1].x) / 2 - W / 2) < 1e-9);
  }
});

test('depth map hook: a flat depth map changes nothing; a map that puts the opening nearer than the wall is used', () => {
  const W = 48;
  const H = 64;
  const flat = { data: new Float32Array(W * H).fill(2500), width: W, height: H };
  const base = detectDoor(scene.image);
  const withFlat = detectDoor(scene.image, { depth: flat });
  assert.deepEqual(withFlat.quad, base.quad);
  // Depth that makes the true opening stick OUT towards the camera (impossible for an opening): its score drops.
  const bump = new Float32Array(W * H).fill(2500);
  const sx = W / scene.image.width;
  const sy = H / scene.image.height;
  const xs = truth.map((p) => p.x * sx);
  const ys = truth.map((p) => p.y * sy);
  for (let y = Math.ceil(Math.min(...ys)); y < Math.max(...ys); y++) for (let x = Math.ceil(Math.min(...xs)); x < Math.max(...xs); x++) bump[y * W + x] = 1500;
  const withBump = detectDoor(scene.image, { depth: { data: bump, width: W, height: H } });
  assert.ok(withBump.score < base.score, 'score should drop when the opening is nearer than its surround');
});
