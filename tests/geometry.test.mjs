import test from 'node:test';
import assert from 'node:assert/strict';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import {
  solveHomography,
  applyHomography,
  invertHomography,
  orderQuad,
  isConvexQuad,
  quadArea,
  QUALITY_THRESHOLDS,
  measureDoor,
} from '../js/geometry.js';

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

const IMAGE = { width: 1920, height: 2560 };
const A4 = { w: 210, h: 297 };
const LETTER = { w: 215.9, h: 279.4 };
const CARD = { w: 85.6, h: 53.98 };
const ISSUE_CODES = [
  'sheet_small',
  'steep_angle',
  'high_residual',
  'methods_disagree',
  'door_near_edge',
  'door_small',
  'implausible_size',
  'sheet_off_door',
  'high_uncertainty',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  return () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

function shuffled(items, rand) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const addNoise = (pts, sigma, gauss) => pts.map((p) => ({ x: p.x + sigma * gauss(), y: p.y + sigma * gauss() }));

/**
 * Noise-free synthetic photo of a door with a sheet on it.
 * `sheet` is the sheet as placed: w along the door's width at rotDeg = 0. Corners come back in
 * [TL, TR, BR, BL] order on the door plane.
 */
function makeScene({ W = 820, H = 2040, sheet = A4, centre = { x: 410, y: 1020 }, rotDeg = 0, cam = {}, image = IMAGE, focalFrac = 0.72, doorMm } = {}) {
  const P = cameraHomography({
    imageWidth: image.width,
    imageHeight: image.height,
    focalPx: focalFrac * Math.max(image.width, image.height),
    target: { x: W / 2, y: H / 2 },
    ...cam,
  });
  const doorPlane = doorMm || [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const t = (rotDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const sheetPlane = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx * sheet.w) / 2;
    const y = (sy * sheet.h) / 2;
    return { x: centre.x + c * x - s * y, y: centre.y + s * x + c * y };
  });
  return {
    P,
    doorPx: doorPlane.map((p) => projectPoint(P, p)),
    sheetPx: sheetPlane.map((p) => projectPoint(P, p)),
    sheetMm: { w: sheet.w, h: sheet.h },
    imageSize: { width: image.width, height: image.height },
  };
}

const input = (scene, extra = {}) => ({ sheetPx: scene.sheetPx, doorPx: scene.doorPx, sheetMm: scene.sheetMm, imageSize: scene.imageSize, ...extra });

function assertClose(actual, expected, tol, message) {
  assert.ok(Math.abs(actual - expected) <= tol, `${message || 'value'}: expected ${expected} +- ${tol}, got ${actual}`);
}

function assertPointsClose(actual, expected, tol, message) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assertClose(actual[i].x, expected[i].x, tol, `${message || 'point'}[${i}].x`);
    assertClose(actual[i].y, expected[i].y, tol, `${message || 'point'}[${i}].y`);
  }
}

/** A clean, well-framed, close-to-square-on photo. */
const CLEAN = { cam: { distanceMm: 2300, yawDeg: 4, pitchDeg: -3, rollDeg: 1 } };
/** Corner noise of the "refined sheet" case: sub-pixel sheet corners, hand-placed door corners. */
const REFINED = { sigmaSheetPx: 0.3, sigmaDoorPx: 2 };

// ---------------------------------------------------------------------------------------------------------
// Homographies
// ---------------------------------------------------------------------------------------------------------

test('solveHomography recovers a known homography from four points', () => {
  const H = [1.2, 0.1, 300, -0.05, 0.9, 150, 1e-4, -2e-4, 1];
  const src = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 2000 }, { x: 0, y: 2000 }];
  const dst = src.map((p) => applyHomography(H, p));
  const got = solveHomography(src, dst);
  assert.equal(got.length, 9);
  for (let i = 0; i < 9; i++) assertClose(got[i], H[i], 1e-9 * Math.max(1, Math.abs(H[i])), `H[${i}]`);
  assert.equal(got[8], 1);
});

test('solveHomography / invertHomography round trip on camera views', () => {
  const rand = mulberry32(11);
  for (let trial = 0; trial < 200; trial++) {
    const P = cameraHomography({
      imageWidth: IMAGE.width,
      imageHeight: IMAGE.height,
      focalPx: 0.72 * IMAGE.height,
      distanceMm: 2000 + 2000 * rand(),
      yawDeg: -30 + 60 * rand(),
      pitchDeg: -20 + 40 * rand(),
      rollDeg: -10 + 20 * rand(),
    });
    const plane = [{ x: 0, y: 0 }, { x: 820, y: 0 }, { x: 820, y: 2040 }, { x: 0, y: 2040 }];
    const px = plane.map((p) => projectPoint(P, p));
    const H = solveHomography(plane, px);
    const back = invertHomography(H);
    const viaSolve = solveHomography(px, plane);
    for (let i = 0; i < 12; i++) {
      const q = { x: -200 + 1200 * rand(), y: -200 + 2400 * rand() };
      const image = applyHomography(H, q);
      assertPointsClose([image], [projectPoint(P, q)], 1e-7, 'forward');
      assertPointsClose([applyHomography(back, image)], [q], 1e-7, 'inverse');
      assertPointsClose([applyHomography(viaSolve, image)], [q], 1e-6, 'solved inverse');
    }
  }
});

test('invertHomography returns the true matrix inverse', () => {
  const H = [0.47, 0.08, 633.8, -0.07, 1.1, 531.7, -4.9e-5, 5e-5, 1];
  const inv = invertHomography(H);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += H[r * 3 + k] * inv[k * 3 + c];
      assertClose(sum, r === c ? 1 : 0, 1e-9, `(H * inv)[${r}][${c}]`);
    }
  }
  assert.throws(() => invertHomography([1, 2, 3, 2, 4, 6, 0, 0, 1]), /degenerate/);
  assert.throws(() => invertHomography([0, 0, 0, 0, 0, 0, 0, 0, 0]), /degenerate/);
});

test('solveHomography handles more than four points, exactly and in the least-squares sense', () => {
  const H = [0.9, -0.2, 40, 0.15, 1.1, -30, 2e-4, 1e-4, 1];
  const rand = mulberry32(5);
  const gauss = gaussian(rand);
  const src = [];
  for (let i = 0; i < 30; i++) src.push({ x: 1000 * rand(), y: 1500 * rand() });
  const exact = src.map((p) => applyHomography(H, p));
  const got = solveHomography(src, exact);
  for (const p of src) assertPointsClose([applyHomography(got, p)], [applyHomography(H, p)], 1e-7);

  const noisy = addNoise(exact, 0.5, gauss);
  const fitted = solveHomography(src, noisy);
  let sumSq = 0;
  for (let i = 0; i < src.length; i++) {
    const q = applyHomography(fitted, src[i]);
    sumSq += (q.x - exact[i].x) ** 2 + (q.y - exact[i].y) ** 2;
  }
  // Thirty points average the noise down: the fitted map is closer to the truth than any one point.
  assert.ok(Math.sqrt(sumSq / src.length) < 0.5, `rms ${Math.sqrt(sumSq / src.length)}`);
});

test('solveHomography copes with very differently scaled spaces (px <-> mm)', () => {
  const src = [{ x: 2000.5, y: 3000.25 }, { x: 2600.75, y: 2990 }, { x: 2650, y: 4500.5 }, { x: 1980, y: 4480 }];
  const dst = [{ x: 0, y: 0 }, { x: 0.82, y: 0 }, { x: 0.82, y: 2.04 }, { x: 0, y: 2.04 }];
  const H = solveHomography(src, dst);
  assertPointsClose(src.map((p) => applyHomography(H, p)), dst, 1e-10);
  assertPointsClose(dst.map((p) => applyHomography(invertHomography(H), p)), src, 1e-6);
});

test("solveHomography throws Error('degenerate') for singular input", () => {
  const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const collinear = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
  const threeInLine = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }];
  const duplicate = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const samePoint = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
  const withNaN = [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  for (const [src, dst] of [
    [collinear, square],
    [square, collinear],
    [threeInLine, square],
    [threeInLine, threeInLine],
    [duplicate, square],
    [samePoint, square],
    [withNaN, square],
    [square.slice(0, 3), square.slice(0, 3)],
    [square, square.slice(0, 3)],
  ]) {
    assert.throws(() => solveHomography(src, dst), (err) => err instanceof Error && err.message === 'degenerate');
  }
});

// ---------------------------------------------------------------------------------------------------------
// Quads
// ---------------------------------------------------------------------------------------------------------

test('orderQuad returns [TL, TR, BR, BL] for every permutation of a perspective quad', () => {
  const scene = makeScene({ cam: { distanceMm: 2400, yawDeg: 22, pitchDeg: -12, rollDeg: 6 } });
  const expected = scene.doorPx;
  const idx = [0, 1, 2, 3];
  let count = 0;
  for (const a of idx) for (const b of idx) for (const c of idx) for (const d of idx) {
    if (new Set([a, b, c, d]).size !== 4) continue;
    count++;
    const original = [expected[a], expected[b], expected[c], expected[d]];
    const copy = original.map((p) => ({ ...p }));
    assert.deepEqual(orderQuad(original), expected);
    assert.deepEqual(original, copy, 'input must not be modified');
  }
  assert.equal(count, 24);
});

test('orderQuad handles rotated rectangles and camera views across the pose range', () => {
  const rand = mulberry32(3);
  for (let deg = -40; deg <= 40; deg += 5) {
    const t = (deg * Math.PI) / 180;
    const rect = [[-200, -500], [200, -500], [200, 500], [-200, 500]].map(([x, y]) => ({
      x: 900 + Math.cos(t) * x - Math.sin(t) * y,
      y: 1200 + Math.sin(t) * x + Math.cos(t) * y,
    }));
    assert.deepEqual(orderQuad(shuffled(rect, rand)), rect, `rotation ${deg} deg`);
  }
  for (const yawDeg of [-25, 0, 25]) for (const pitchDeg of [-15, 0, 15]) for (const rollDeg of [-8, 0, 8]) {
    const scene = makeScene({ cam: { distanceMm: 2600, yawDeg, pitchDeg, rollDeg } });
    assert.deepEqual(orderQuad(shuffled(scene.doorPx, rand)), scene.doorPx, `door yaw ${yawDeg} pitch ${pitchDeg} roll ${rollDeg}`);
  }
  // Clockwise on screen (positive shoelace sum with y down), starting at the smallest x + y.
  const ordered = orderQuad([{ x: 10, y: 300 }, { x: 250, y: 20 }, { x: 0, y: 0 }, { x: 260, y: 310 }]);
  assert.deepEqual(ordered[0], { x: 0, y: 0 });
  let twice = 0;
  for (let i = 0; i < 4; i++) twice += ordered[i].x * ordered[(i + 1) % 4].y - ordered[(i + 1) % 4].x * ordered[i].y;
  assert.ok(twice > 0);
  // A diamond ties on x + y: the upper corner goes first.
  assert.deepEqual(orderQuad([{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }]), [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ]);
});

test('isConvexQuad accepts convex quads of either winding and rejects everything else', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(isConvexQuad(square), true);
  assert.equal(isConvexQuad(square.slice().reverse()), true);
  assert.equal(isConvexQuad(makeScene({ cam: { yawDeg: 25, pitchDeg: 15, rollDeg: 8 } }).doorPx), true);
  // bow-tie (two edges cross)
  assert.equal(isConvexQuad([square[0], square[1], square[3], square[2]]), false);
  // dart (one reflex corner)
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 10 }]), false);
  // three corners in a line
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]), false);
  // all in a line
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]), false);
  // repeated corner
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), false);
  // not finite / wrong length
  assert.equal(isConvexQuad([{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), false);
  assert.equal(isConvexQuad(square.slice(0, 3)), false);
});

test('quadArea is the positive shoelace area', () => {
  const rect = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 70 }, { x: 10, y: 70 }];
  assert.equal(quadArea(rect), 5000);
  assert.equal(quadArea(rect.slice().reverse()), 5000);
  assertClose(quadArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 3, y: 2 }, { x: 1, y: 2 }]), 6, 1e-12, 'trapezoid');
  assert.equal(quadArea([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]), 0);
});

// ---------------------------------------------------------------------------------------------------------
// measureDoor: exact recovery without noise
// ---------------------------------------------------------------------------------------------------------

test('measureDoor recovers W and H to better than 0.01 mm across poses, sheet rotations, positions and sheet types', () => {
  const rand = mulberry32(2024);
  const sheets = [
    { name: 'A4 portrait', placed: A4 },
    { name: 'A4 landscape', placed: { w: 297, h: 210 } },
    { name: 'bank card', placed: CARD },
  ];
  const positions = [{ x: 410, y: 1020 }, { x: 170, y: 320 }, { x: 640, y: 1790 }];
  let cases = 0;
  let worst = 0;
  for (const distanceMm of [2000, 2800, 4000]) for (const yawDeg of [-25, 0, 25]) for (const pitchDeg of [-15, 0, 15]) for (const rollDeg of [-8, 0, 8]) {
    for (const rotDeg of [0, 7, 30, 45, 90]) for (const centre of positions) for (const sheet of sheets) {
      const scene = makeScene({ sheet: sheet.placed, centre, rotDeg, cam: { distanceMm, yawDeg, pitchDeg, rollDeg } });
      const label = `${sheet.name} rot ${rotDeg} at (${centre.x},${centre.y}), d ${distanceMm} yaw ${yawDeg} pitch ${pitchDeg} roll ${rollDeg}`;
      // Corner order is scrambled and the sheet size is handed over either way round.
      const res = measureDoor({
        sheetPx: shuffled(scene.sheetPx, rand),
        doorPx: shuffled(scene.doorPx, rand),
        sheetMm: rand() < 0.5 ? scene.sheetMm : { w: scene.sheetMm.h, h: scene.sheetMm.w },
        imageSize: scene.imageSize,
      });
      assert.equal(res.ok, true, `${label}: ${res.error} ${res.message}`);
      const err = Math.max(Math.abs(res.widthMm - 820), Math.abs(res.heightMm - 2040));
      worst = Math.max(worst, err);
      assert.ok(err < 0.01, `${label}: got ${res.widthMm} x ${res.heightMm}`);
      assert.ok(res.rmsResidualPx < 1e-6, `${label}: residual ${res.rmsResidualPx}`);
      assert.ok(res.sigmaWidthMm > 0 && Number.isFinite(res.sigmaWidthMm), label);
      assert.ok(res.sigmaHeightMm > 0 && Number.isFinite(res.sigmaHeightMm), label);
      // The sheet-only cross-check is exact too when there is no noise.
      assertClose(res.sheetOnly.widthMm, 820, 0.01, `${label}: sheet-only width`);
      assertClose(res.sheetOnly.heightMm, 2040, 0.01, `${label}: sheet-only height`);
      if (rotDeg !== 45) {
        const longSideVertical = (scene.sheetMm.h >= scene.sheetMm.w) === (rotDeg < 45);
        assert.equal(res.sheetOrientation, longSideVertical ? 'portrait' : 'landscape', label);
      }
      cases++;
    }
  }
  assert.equal(cases, 81 * 5 * 3 * 3);
  assert.ok(worst < 1e-6, `worst error ${worst} mm`);
});

test('measureDoor is exact for other door sizes and a landscape photo', () => {
  for (const [W, H] of [[720, 1980], [1000, 2300], [600, 1900], [1100, 2400]]) {
    for (const image of [IMAGE, { width: 2560, height: 1920 }]) {
      const scene = makeScene({ W, H, image, centre: { x: 0.4 * W, y: 0.55 * H }, rotDeg: -3, cam: { distanceMm: image === IMAGE ? 3000 : 4200, yawDeg: 10, pitchDeg: -6, rollDeg: 2 } });
      const res = measureDoor(input(scene));
      assert.equal(res.ok, true);
      assertClose(res.widthMm, W, 0.01, 'width');
      assertClose(res.heightMm, H, 0.01, 'height');
    }
  }
});

test('measureDoor returns consistent homographies and fitted corners', () => {
  const scene = makeScene({ centre: { x: 300, y: 700 }, rotDeg: 12, cam: { distanceMm: 2700, yawDeg: -14, pitchDeg: 7, rollDeg: -3 } });
  const rand = mulberry32(8);
  const res = measureDoor({ ...input(scene), sheetPx: shuffled(scene.sheetPx, rand), doorPx: shuffled(scene.doorPx, rand) });
  assert.equal(res.ok, true);
  assert.equal(res.planeToImage.length, 9);
  assert.equal(res.imageToPlane.length, 9);

  // Door plane: origin at the door's top-left, x right, y down, millimetres.
  const doorPlane = [{ x: 0, y: 0 }, { x: 820, y: 0 }, { x: 820, y: 2040 }, { x: 0, y: 2040 }];
  assertPointsClose(doorPlane.map((p) => applyHomography(res.planeToImage, p)), scene.doorPx, 1e-6, 'planeToImage(door)');
  assertPointsClose(scene.doorPx.map((p) => applyHomography(res.imageToPlane, p)), doorPlane, 1e-6, 'imageToPlane(door)');
  // Any other point on the plane agrees with the true camera too.
  for (const q of [{ x: 123, y: 456 }, { x: 800, y: 1999 }, { x: -150, y: 2200 }]) {
    assertPointsClose([applyHomography(res.planeToImage, q)], [projectPoint(scene.P, q)], 1e-6, 'planeToImage');
    assertPointsClose([applyHomography(res.imageToPlane, projectPoint(scene.P, q))], [q], 1e-6, 'imageToPlane');
  }
  // Fitted corners line up index by index with the ordered input corners.
  assertPointsClose(res.doorFitPx, orderQuad(scene.doorPx), 1e-6, 'doorFitPx');
  assertPointsClose(res.sheetFitPx, orderQuad(scene.sheetPx), 1e-6, 'sheetFitPx');
  // The whole result survives JSON (no NaN / Infinity / undefined anywhere).
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
});

test('measureDoor defaults: sigmas 1 px / 2.5 px and the standard plausible range', () => {
  const scene = makeScene(CLEAN);
  const implicit = measureDoor(input(scene));
  const explicit = measureDoor(input(scene, { sigmaSheetPx: 1, sigmaDoorPx: 2.5, plausible: { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 } }));
  assert.deepEqual(implicit, explicit);
  // Without noise the reported sigma is pure propagation, so it scales with the input sigmas.
  const doubled = measureDoor(input(scene, { sigmaSheetPx: 2, sigmaDoorPx: 5 }));
  assertClose(doubled.sigmaWidthMm, 2 * implicit.sigmaWidthMm, 1e-6, 'sigma width scales');
  assertClose(doubled.sigmaHeightMm, 2 * implicit.sigmaHeightMm, 1e-6, 'sigma height scales');
  // A sharper sheet or sharper door corners both help.
  assert.ok(measureDoor(input(scene, { sigmaSheetPx: 0.3 })).sigmaHeightMm < implicit.sigmaHeightMm);
  assert.ok(measureDoor(input(scene, { sigmaDoorPx: 1 })).sigmaHeightMm < implicit.sigmaHeightMm);
});

// ---------------------------------------------------------------------------------------------------------
// measureDoor: which way round the sheet is
// ---------------------------------------------------------------------------------------------------------

test('measureDoor tells a portrait sheet from a landscape one even when it is taped square to the door', () => {
  // With the sheet square to the door, a portrait A4 on an 820 x 2040 door and a landscape A4 on a
  // 1160 x 1442 door produce exactly the same eight corners up to a homography. Only the camera's
  // geometry (square pixels, optical axis near the image centre) separates them.
  for (const focalFrac of [0.55, 0.72, 1.0, 1.5]) {
    for (const [yawDeg, pitchDeg, rollDeg] of [[0, 0, 0], [12, 0, 0], [0, -8, 0], [-15, 6, 2], [25, 15, 8], [3, -2, 0.5]]) {
      for (const placed of [A4, { w: 297, h: 210 }, CARD, { w: 215.9, h: 279.4 }]) {
        const scene = makeScene({ sheet: placed, focalFrac, cam: { distanceMm: (2600 * focalFrac) / 0.72, yawDeg, pitchDeg, rollDeg } });
        const label = `f ${focalFrac}, yaw ${yawDeg} pitch ${pitchDeg} roll ${rollDeg}, sheet ${placed.w} x ${placed.h}`;
        const a = measureDoor(input(scene));
        const b = measureDoor(input(scene, { sheetMm: { w: placed.h, h: placed.w } }));
        for (const res of [a, b]) {
          assert.equal(res.ok, true, label);
          assertClose(res.widthMm, 820, 0.01, `${label}: width`);
          assertClose(res.heightMm, 2040, 0.01, `${label}: height`);
          assert.equal(res.sheetOrientation, placed.h >= placed.w ? 'portrait' : 'landscape', label);
          assert.ok(res.fit.orientationMargin > QUALITY_THRESHOLDS.orientationMinMargin, `${label}: margin ${res.fit.orientationMargin}`);
        }
        assertClose(a.widthMm, b.widthMm, 1e-9, `${label}: same answer either way round`);
      }
    }
  }
});

test('measureDoor still resolves the sheet orientation without imageSize, and for a square reference', () => {
  const scene = makeScene({ cam: { distanceMm: 2600, yawDeg: 6, pitchDeg: -4, rollDeg: 1 } });
  const res = measureDoor({ sheetPx: scene.sheetPx, doorPx: scene.doorPx, sheetMm: A4 });
  assert.equal(res.ok, true);
  assertClose(res.widthMm, 820, 0.01, 'width');
  assertClose(res.heightMm, 2040, 0.01, 'height');

  const square = makeScene({ sheet: { w: 150, h: 150 }, rotDeg: 20, cam: { distanceMm: 2600, yawDeg: 6, pitchDeg: -4, rollDeg: 1 } });
  const sq = measureDoor(input(square));
  assert.equal(sq.ok, true);
  assertClose(sq.widthMm, 820, 0.01, 'width');
  assertClose(sq.heightMm, 2040, 0.01, 'height');
  assert.equal(sq.sheetOrientation, 'portrait');
  assert.equal(sq.fit.orientationMargin, null);
});

test('measureDoor keeps the right sheet orientation under realistic noise', () => {
  const rand = mulberry32(77);
  const gauss = gaussian(rand);
  let total = 0;
  for (let i = 0; i < 1500; i++) {
    const placed = i % 2 === 0 ? A4 : { w: 297, h: 210 };
    const scene = makeScene({
      sheet: placed,
      centre: { x: 200 + 420 * rand(), y: 300 + 1440 * rand() },
      rotDeg: -5 + 10 * rand(),
      cam: { distanceMm: 2200 + 1300 * rand(), yawDeg: -15 + 30 * rand(), pitchDeg: -8 + 16 * rand(), rollDeg: -3 + 6 * rand() },
    });
    const res = measureDoor({
      sheetPx: addNoise(scene.sheetPx, 2, gauss),
      doorPx: addNoise(scene.doorPx, 2.5, gauss),
      sheetMm: A4,
      imageSize: IMAGE,
      sigmaSheetPx: 2,
      sigmaDoorPx: 2.5,
    });
    assert.equal(res.ok, true);
    assert.equal(res.sheetOrientation, placed.h >= placed.w ? 'portrait' : 'landscape', `trial ${i}: ${res.widthMm} x ${res.heightMm}`);
    total++;
  }
  assert.equal(total, 1500);
});

/** True when measureDoor could not safely tell a portrait sheet from a landscape one. */
const orientationUndecided = (res) => res.fit.orientationMargin !== null && res.fit.orientationMargin < QUALITY_THRESHOLDS.orientationMinMargin;

test('US Letter: door corners marked about 5 px out no longer flip the sheet to landscape', () => {
  // An 820 x 2040 door with a US Letter sheet taped portrait 0.8 degrees off square, photographed 9
  // degrees from the side. The door corners are 3 to 8 px from where they belong, about twice the
  // configured 2.5 px. The landscape reading happens to absorb that error (chi-square 2.1 against
  // 20.1), which used to outvote the camera: 1061 x 1583 mm, graded 'fair', no issue.
  const marked = {
    sheetPx: [{ x: 876.4, y: 1027.4 }, { x: 1046.9, y: 1024.6 }, { x: 1044.7, y: 1248.2 }, { x: 875.3, y: 1247.6 }],
    doorPx: [{ x: 646.9, y: 435.8 }, { x: 1293.8, y: 418 }, { x: 1265.1, y: 2082.6 }, { x: 623.9, y: 2020.7 }],
    sheetMm: LETTER,
    imageSize: IMAGE,
    sigmaSheetPx: 0.5,
    sigmaDoorPx: 2.5,
  };
  const res = measureDoor(marked);
  assert.equal(res.ok, true);
  assert.equal(res.sheetOrientation, 'portrait');
  assertClose(res.widthMm, 820, 4, 'width');
  assertClose(res.heightMm, 2046, 6, 'height');
  assert.equal(orientationUndecided(res), false, `margin ${res.fit.orientationMargin}`);
  assert.ok(!res.quality.issues.includes('implausible_size'));

  // The same photo with the door corners exactly where they belong.
  const exact = measureDoor({ ...marked, doorPx: [{ x: 650.4, y: 443 }, { x: 1296.5, y: 410.5 }, { x: 1261.1, y: 2078.3 }, { x: 618.4, y: 2023 }] });
  assert.equal(exact.sheetOrientation, 'portrait');
  assertClose(exact.widthMm, 820, 0.5, 'width, true corners');
  assertClose(exact.heightMm, 2046, 0.5, 'height, true corners');

  // The configured door sigma changes how sure the answer is, not which answer it is.
  for (const sigmaDoorPx of [2, 2.5, 4, 6]) {
    const other = measureDoor({ ...marked, sigmaDoorPx });
    assert.equal(other.sheetOrientation, 'portrait', `sigmaDoorPx ${sigmaDoorPx}`);
    assertClose(other.widthMm, 820, 4, `width at sigmaDoorPx ${sigmaDoorPx}`);
    assertClose(other.heightMm, 2046, 6, `height at sigmaDoorPx ${sigmaDoorPx}`);
  }
});

test('when marking error makes the wrong way round fit better, the result is flagged instead of silently wrong', () => {
  // US Letter taped portrait on an 820 x 2040 door, door corners 6 to 13 px out (about three times
  // the configured sigma). The landscape reading fits six times better (chi-square 5 against 31) and
  // used to win: 1060 x 1577 mm, graded 'fair', no issue. Marking error can do that, so it does not
  // settle the choice: the camera's reading is reported and the orientation is flagged as undecided.
  const res = measureDoor({
    sheetPx: [{ x: 882.4, y: 1328.4 }, { x: 1042.8, y: 1319.1 }, { x: 1054.5, y: 1537 }, { x: 893.8, y: 1540.2 }],
    doorPx: [{ x: 678.4, y: 533.2 }, { x: 1286.9, y: 463.9 }, { x: 1336.5, y: 2110.1 }, { x: 713.4, y: 2037.3 }],
    sheetMm: LETTER,
    imageSize: IMAGE,
    sigmaSheetPx: 0.5,
    sigmaDoorPx: 2.5,
  });
  assert.equal(res.ok, true);
  assert.equal(orientationUndecided(res), true, `margin ${res.fit.orientationMargin}`);
  assert.ok(res.fit.orientationMargin >= 0);
  assert.equal(res.sheetOrientation, 'portrait');
  assertClose(res.widthMm, 820, 5, 'width');
  assertClose(res.heightMm, 2040, 10, 'height');
  // Half the gap to the other reading (1060 x 1577) is in the sigmas, and the grade says so.
  assert.ok(res.sigmaWidthMm > 100 && res.sigmaHeightMm > 200, `sigmas ${res.sigmaWidthMm} / ${res.sigmaHeightMm}`);
  assert.equal(res.quality.level, 'poor');
  assert.ok(res.quality.issues.includes('high_uncertainty'));
});

test('Monte Carlo: door corners marked 2 to 3 times worse than configured never give an unflagged wrong-way-round size (US Letter)', (t) => {
  // Configured sigmas throughout (0.5 px sheet, 2.5 px door); only the real door-corner error changes.
  const scenarios = [
    { name: 'as configured', doorNoisePx: 2.5, maxYawDeg: 15, seed: 501, maxWrong: 0, maxFalseAlarms: 4 },
    { name: 'twice the configured door sigma', doorNoisePx: 5, maxYawDeg: 15, seed: 502, maxWrong: 4, maxFalseAlarms: 40 },
    { name: 'three times, up to 25 degrees from the side', doorNoisePx: 7.5, maxYawDeg: 25, seed: 503, maxWrong: 60, maxFalseAlarms: 160 },
  ];
  const N = 4000;
  for (const { name, doorNoisePx, maxYawDeg, seed, maxWrong, maxFalseAlarms } of scenarios) {
    const rand = mulberry32(seed);
    const gauss = gaussian(rand);
    let wrong = 0;
    let falseAlarms = 0;
    for (let i = 0; i < N; i++) {
      // Mostly portrait: that is the way round that marking error can flip.
      const placed = i % 4 === 3 ? { w: LETTER.h, h: LETTER.w } : LETTER;
      const scene = makeScene({
        sheet: placed,
        centre: { x: 220 + 380 * rand(), y: 300 + 1440 * rand() },
        rotDeg: -3 + 6 * rand(),
        cam: { distanceMm: 2400 + 1100 * rand(), yawDeg: maxYawDeg * (2 * rand() - 1), pitchDeg: -8 + 16 * rand(), rollDeg: -3 + 6 * rand() },
      });
      const res = measureDoor({
        sheetPx: addNoise(scene.sheetPx, 0.5, gauss),
        doorPx: addNoise(scene.doorPx, doorNoisePx, gauss),
        sheetMm: LETTER,
        imageSize: IMAGE,
        sigmaSheetPx: 0.5,
        sigmaDoorPx: 2.5,
      });
      const label = `${name}, trial ${i}: ${res.widthMm} x ${res.heightMm}, margin ${res.fit && res.fit.orientationMargin}`;
      assert.equal(res.ok, true, label);
      const undecided = orientationUndecided(res);
      if (undecided) {
        // Flagged: the sigmas carry half the gap between the two readings, so the true size is within
        // reach of the reported one whichever reading was picked, and the grade cannot be good or fair.
        assert.equal(res.quality.level, 'poor', label);
        assert.ok(res.quality.issues.includes('high_uncertainty'), label);
        assert.ok(Math.abs(res.widthMm - 820) <= 3 * res.sigmaWidthMm, label);
        assert.ok(Math.abs(res.heightMm - 2040) <= 3 * res.sigmaHeightMm, label);
      }
      if (res.sheetOrientation !== (placed.h >= placed.w ? 'portrait' : 'landscape')) {
        wrong++;
        assert.ok(undecided, `wrong way round and not flagged; ${label}`);
      } else if (undecided) {
        falseAlarms++;
      }
    }
    t.diagnostic(`${name}: ${wrong} of ${N} the wrong way round (all flagged), ${falseAlarms} flagged although right`);
    // Wrong picks are rare as well as flagged, and right ones are seldom flagged for nothing.
    assert.ok(wrong <= maxWrong, `${name}: ${wrong} of ${N} the wrong way round`);
    assert.ok(falseAlarms <= maxFalseAlarms, `${name}: ${falseAlarms} of ${N} flagged although right`);
  }
});

test('when portrait vs landscape truly cannot be decided, the sigmas say so and the grade is poor', () => {
  // The one genuinely ambiguous view: an ultra-wide lens, a strong sideways angle with the camera at
  // exactly door-centre height, a sheet taped dead level, and a door for which both readings
  // (900 x 2300 with a portrait sheet, 1273 x 1626 with a landscape one) are plausible sizes.
  for (const yawDeg of [28, 33, 38]) {
    const scene = makeScene({ W: 900, H: 2300, centre: { x: 450, y: 1150 }, focalFrac: 0.375, cam: { distanceMm: (2600 * 0.375) / 0.72, yawDeg } });
    const res = measureDoor(input(scene, REFINED));
    assert.equal(res.ok, true);
    assert.ok(res.fit.orientationMargin < QUALITY_THRESHOLDS.orientationMinMargin, `yaw ${yawDeg}: margin ${res.fit.orientationMargin}`);
    assert.equal(res.quality.level, 'poor');
    assert.ok(res.quality.issues.includes('high_uncertainty'));
    // Half the gap between the two candidate answers is in the sigma, so the truth is within 2 sigma
    // whichever candidate was reported.
    assert.ok(res.sigmaWidthMm > 150 && res.sigmaHeightMm > 300);
    assert.ok(Math.abs(res.widthMm - 900) <= 2.01 * res.sigmaWidthMm);
    assert.ok(Math.abs(res.heightMm - 2300) <= 2.01 * res.sigmaHeightMm);
  }
  // A nearly square reference is just as undecidable, but the two answers are almost the same, so
  // it costs next to nothing.
  const nearSquare = measureDoor(input(makeScene({ sheet: { w: 300, h: 301 }, cam: { distanceMm: 2600 } }), REFINED));
  assert.ok(nearSquare.fit.orientationMargin < QUALITY_THRESHOLDS.orientationMinMargin);
  assert.ok(nearSquare.sigmaHeightMm < 8);
  assert.ok(!nearSquare.quality.issues.includes('high_uncertainty'));
  assert.ok(Math.abs(nearSquare.heightMm - 2040) < 2040 / 300 + 0.01);
});

// ---------------------------------------------------------------------------------------------------------
// measureDoor: accuracy and calibration under noise
// ---------------------------------------------------------------------------------------------------------

test('Monte Carlo: the joint estimate has less than half the RMS error of the sheet-only method (A4, sigma 0.5 / 2.5 px)', () => {
  // Random realistic photos: the sheet can be anywhere on the door. (With the sheet dead centre the
  // two methods are equally good; the joint fit wins by removing the extrapolation away from the sheet.)
  const rand = mulberry32(20240607);
  const gauss = gaussian(rand);
  const N = 2000;
  const sumSq = { jointW: 0, jointH: 0, sheetW: 0, sheetH: 0 };
  let measured = 0;
  for (let i = 0; i < N; i++) {
    const rotDeg = -5 + 10 * rand();
    const scene = makeScene({
      centre: { x: 180 + 460 * rand(), y: 230 + 1580 * rand() },
      rotDeg,
      cam: {
        target: { x: 310 + 200 * rand(), y: 870 + 300 * rand() },
        distanceMm: 2200 + 1300 * rand(),
        yawDeg: -15 + 30 * rand(),
        pitchDeg: -8 + 16 * rand(),
        rollDeg: -3 + 6 * rand(),
      },
    });
    const res = measureDoor({
      sheetPx: addNoise(scene.sheetPx, 0.5, gauss),
      doorPx: addNoise(scene.doorPx, 2.5, gauss),
      sheetMm: A4,
      imageSize: IMAGE,
      sigmaSheetPx: 0.5,
      sigmaDoorPx: 2.5,
    });
    assert.equal(res.ok, true, `trial ${i}: ${res.error}`);
    assert.equal(res.sheetOnly.valid, true);
    measured++;
    sumSq.jointW += (res.widthMm - 820) ** 2;
    sumSq.jointH += (res.heightMm - 2040) ** 2;
    sumSq.sheetW += (res.sheetOnly.widthMm - 820) ** 2;
    sumSq.sheetH += (res.sheetOnly.heightMm - 2040) ** 2;
  }
  const rms = (v) => Math.sqrt(v / measured);
  const summary = `joint ${rms(sumSq.jointW).toFixed(2)} / ${rms(sumSq.jointH).toFixed(2)} mm, sheet-only ${rms(sumSq.sheetW).toFixed(2)} / ${rms(sumSq.sheetH).toFixed(2)} mm`;
  assert.ok(rms(sumSq.sheetW) >= 2 * rms(sumSq.jointW), `width: ${summary}`);
  assert.ok(rms(sumSq.sheetH) >= 2 * rms(sumSq.jointH), `height: ${summary}`);
  // Sanity: the joint estimate itself is in the millimetre class, not the centimetre class.
  assert.ok(rms(sumSq.jointW) < 8, summary);
  assert.ok(rms(sumSq.jointH) < 16, summary);
});

test('Monte Carlo: reported sigmas are calibrated against the actual error spread', () => {
  const scenes = [
    { name: 'chest height, slightly oblique', scene: makeScene({ centre: { x: 400, y: 800 }, rotDeg: 3, cam: { distanceMm: 2600, yawDeg: 8, pitchDeg: -4, rollDeg: 1.5 } }), sigmaSheetPx: 0.5, sigmaDoorPx: 2.5 },
    { name: 'low on the door, further away', scene: makeScene({ centre: { x: 250, y: 1500 }, rotDeg: -4, cam: { distanceMm: 3200, yawDeg: -12, pitchDeg: 6, rollDeg: -2 } }), sigmaSheetPx: 0.5, sigmaDoorPx: 2.5 },
    { name: 'rotated sheet near the top, manual corners', scene: makeScene({ centre: { x: 560, y: 400 }, rotDeg: 30, cam: { distanceMm: 2300, yawDeg: 5, pitchDeg: 3 } }), sigmaSheetPx: 2, sigmaDoorPx: 2.5 },
  ];
  const rand = mulberry32(99);
  const gauss = gaussian(rand);
  for (const { name, scene, sigmaSheetPx, sigmaDoorPx } of scenes) {
    const N = 1200;
    const errW = [];
    const errH = [];
    let sumSigmaW = 0;
    let sumSigmaH = 0;
    for (let i = 0; i < N; i++) {
      const res = measureDoor({
        sheetPx: addNoise(scene.sheetPx, sigmaSheetPx, gauss),
        doorPx: addNoise(scene.doorPx, sigmaDoorPx, gauss),
        sheetMm: A4,
        imageSize: IMAGE,
        sigmaSheetPx,
        sigmaDoorPx,
      });
      assert.equal(res.ok, true, `${name} trial ${i}`);
      errW.push(res.widthMm - 820);
      errH.push(res.heightMm - 2040);
      sumSigmaW += res.sigmaWidthMm;
      sumSigmaH += res.sigmaHeightMm;
    }
    const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
    const std = (v) => {
      const m = mean(v);
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
    };
    const ratioW = std(errW) / (sumSigmaW / N);
    const ratioH = std(errH) / (sumSigmaH / N);
    assert.ok(ratioW > 0.6 && ratioW < 1.6, `${name}: width std / sigma = ${ratioW}`);
    assert.ok(ratioH > 0.6 && ratioH < 1.6, `${name}: height std / sigma = ${ratioH}`);
    // No meaningful bias either: the mean error is well inside one sigma.
    assert.ok(Math.abs(mean(errW)) < 0.25 * std(errW), `${name}: width bias ${mean(errW)}`);
    assert.ok(Math.abs(mean(errH)) < 0.25 * std(errH), `${name}: height bias ${mean(errH)}`);
  }
});

test('reported sigma grows when the residuals show the corners were worse than claimed, and never shrinks', () => {
  const scene = makeScene({ centre: { x: 300, y: 700 }, ...CLEAN });
  const clean = measureDoor(input(scene, REFINED));
  assert.equal(clean.fit.sigmaScale, 1);
  const bent = { ...scene, sheetPx: scene.sheetPx.map((p, i) => (i === 2 ? { x: p.x + 4, y: p.y - 3 } : p)) };
  const res = measureDoor(input(bent, REFINED));
  assert.equal(res.ok, true);
  assert.ok(res.fit.chi2 > 3 * res.fit.dof);
  assert.ok(res.fit.sigmaScale > 1);
  assert.ok(res.sigmaWidthMm > clean.sigmaWidthMm && res.sigmaHeightMm > clean.sigmaHeightMm);
});

// ---------------------------------------------------------------------------------------------------------
// measureDoor: bad input
// ---------------------------------------------------------------------------------------------------------

test('measureDoor returns ok:false (and never throws) for bad geometry', () => {
  const scene = makeScene(CLEAN);
  const good = input(scene);
  const line = [{ x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 300 }, { x: 400, y: 400 }];
  const threeInLine = [{ x: 500, y: 400 }, { x: 900, y: 400 }, { x: 1300, y: 400 }, { x: 700, y: 2000 }];
  const dart = [{ x: 500, y: 400 }, { x: 1300, y: 400 }, { x: 900, y: 700 }, { x: 900, y: 2000 }];
  const samePoint = [{ x: 900, y: 900 }, { x: 900, y: 900 }, { x: 900, y: 900 }, { x: 900, y: 900 }];
  const duplicate = [scene.doorPx[0], scene.doorPx[0], scene.doorPx[2], scene.doorPx[3]];
  const cases = [
    ['collinear door', { ...good, doorPx: line }, 'degenerate'],
    ['collinear sheet', { ...good, sheetPx: line }, 'degenerate'],
    ['three door corners in a line', { ...good, doorPx: threeInLine }, 'degenerate'],
    ['dart-shaped door', { ...good, doorPx: dart }, 'not_convex'],
    ['dart-shaped sheet', { ...good, sheetPx: dart.map((p) => ({ x: 900 + p.x / 10, y: 1000 + p.y / 10 })) }, 'not_convex'],
    ['duplicate door corner', { ...good, doorPx: duplicate }, 'degenerate'],
    ['duplicate sheet corner', { ...good, sheetPx: [scene.sheetPx[0], scene.sheetPx[1], scene.sheetPx[1], scene.sheetPx[3]] }, 'degenerate'],
    ['zero-size sheet in the photo', { ...good, sheetPx: samePoint }, 'degenerate'],
    ['zero-width sheet in mm', { ...good, sheetMm: { w: 0, h: 297 } }, 'degenerate'],
    ['zero-size sheet in mm', { ...good, sheetMm: { w: 0, h: 0 } }, 'degenerate'],
    ['negative sheet size', { ...good, sheetMm: { w: -210, h: 297 } }, 'degenerate'],
    ['missing sheet size', { ...good, sheetMm: undefined }, 'degenerate'],
    ['NaN coordinate', { ...good, doorPx: [{ x: NaN, y: 0 }, ...scene.doorPx.slice(1)] }, 'degenerate'],
    ['infinite coordinate', { ...good, sheetPx: [{ x: Infinity, y: 0 }, ...scene.sheetPx.slice(1)] }, 'degenerate'],
    ['three door corners', { ...good, doorPx: scene.doorPx.slice(0, 3) }, 'degenerate'],
    ['missing corners', { sheetMm: A4, imageSize: IMAGE }, 'degenerate'],
    ['sheet beyond the door plane horizon', { ...good, sheetPx: scene.sheetPx.map((p) => ({ x: p.x * 1e7, y: p.y * 1e7 })) }, null],
  ];
  for (const [name, bad, error] of cases) {
    let res;
    assert.doesNotThrow(() => {
      res = measureDoor(bad);
    }, name);
    assert.equal(res.ok, false, name);
    if (error) assert.equal(res.error, error, name);
    assert.ok(['not_convex', 'degenerate', 'no_convergence'].includes(res.error), name);
    assert.equal(typeof res.message, 'string', name);
    assert.ok(res.message.length > 0, name);
  }
  for (const nothing of [undefined, null, 42, 'door', {}]) {
    let res;
    assert.doesNotThrow(() => {
      res = measureDoor(nothing);
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'degenerate');
  }
});

test('a bow-tie drawing order is just a corner order: measureDoor re-orders it and still measures', () => {
  // The contract accepts corners in ANY order, so crossing two corners is repaired by the ordering
  // step rather than rejected; only point sets that are not in convex position fail.
  const scene = makeScene(CLEAN);
  const bowTie = (q) => [q[0], q[1], q[3], q[2]];
  assert.equal(isConvexQuad(bowTie(scene.doorPx)), false);
  let res;
  assert.doesNotThrow(() => {
    res = measureDoor(input(scene, { doorPx: bowTie(scene.doorPx), sheetPx: bowTie(scene.sheetPx) }));
  });
  assert.equal(res.ok, true);
  assertClose(res.widthMm, 820, 0.01, 'width');
  assertClose(res.heightMm, 2040, 0.01, 'height');
});

test('measureDoor never yields NaN for near-degenerate but valid input', () => {
  const scene = makeScene(CLEAN);
  const centre = scene.sheetPx.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
  const rand = mulberry32(1);
  const gauss = gaussian(rand);
  for (const shrink of [0.2, 0.05, 0.01, 1e-3, 1e-5, 1e-8]) {
    for (const noise of [0, 0.5]) {
      // A sheet that is only a few pixels (or a fraction of a pixel) across.
      const tiny = scene.sheetPx.map((p) => ({ x: centre.x + shrink * (p.x - centre.x) + noise * gauss(), y: centre.y + shrink * (p.y - centre.y) + noise * gauss() }));
      let res;
      assert.doesNotThrow(() => {
        res = measureDoor(input(scene, { sheetPx: tiny }));
      });
      if (res.ok) {
        const numbers = [res.widthMm, res.heightMm, res.sigmaWidthMm, res.sigmaHeightMm, res.rmsResidualPx, res.quality.score, ...res.planeToImage, ...res.imageToPlane];
        assert.ok(numbers.every(Number.isFinite), `shrink ${shrink} noise ${noise}`);
        assert.ok(res.widthMm > 0 && res.heightMm > 0);
        assert.notEqual(res.quality.level, 'good');
      } else {
        assert.ok(['not_convex', 'degenerate', 'no_convergence'].includes(res.error));
      }
    }
  }
  // Fronto-parallel, pixel-aligned everything.
  const flat = measureDoor({
    doorPx: [{ x: 600, y: 300 }, { x: 1320, y: 300 }, { x: 1320, y: 2091 }, { x: 600, y: 2091 }],
    sheetPx: [{ x: 800, y: 1000 }, { x: 984.375, y: 1000 }, { x: 984.375, y: 1260.75 }, { x: 800, y: 1260.75 }],
    sheetMm: A4,
    imageSize: IMAGE,
  });
  assert.equal(flat.ok, true);
  assertClose(flat.widthMm, (720 * 210) / 184.375, 1e-6, 'fronto-parallel width');
  assertClose(flat.heightMm, (1791 * 297) / 260.75, 1e-6, 'fronto-parallel height');
});

// ---------------------------------------------------------------------------------------------------------
// measureDoor: quality
// ---------------------------------------------------------------------------------------------------------

test('QUALITY_THRESHOLDS exposes the numbers behind the quality rules', () => {
  assert.ok(Object.isFrozen(QUALITY_THRESHOLDS));
  for (const [key, value] of Object.entries(QUALITY_THRESHOLDS)) assert.ok(Number.isFinite(value) && value > 0, key);
  assert.ok(QUALITY_THRESHOLDS.goodSigmaMm < QUALITY_THRESHOLDS.highUncertaintySigmaMm);
  assert.ok(QUALITY_THRESHOLDS.highUncertaintySigmaMm < QUALITY_THRESHOLDS.poorSigmaMm);
});

test('the sigma grades are tuned for quoting: good up to 8 mm, high_uncertainty above 12 mm, poor above 16 mm', () => {
  assert.equal(QUALITY_THRESHOLDS.goodSigmaMm, 8);
  assert.equal(QUALITY_THRESHOLDS.highUncertaintySigmaMm, 12);
  assert.equal(QUALITY_THRESHOLDS.poorSigmaMm, 16);

  // Without noise the reported sigma is pure propagation, so scaling both corner sigmas scales it
  // exactly: the same clean photo can be given any sigma, with nothing else about it changing.
  const scene = makeScene(CLEAN);
  const base = measureDoor(input(scene, REFINED));
  const baseSigmaMm = Math.max(base.sigmaWidthMm, base.sigmaHeightMm);
  const gradeAt = (sigmaMm) => {
    const k = sigmaMm / baseSigmaMm;
    const res = measureDoor(input(scene, { sigmaSheetPx: REFINED.sigmaSheetPx * k, sigmaDoorPx: REFINED.sigmaDoorPx * k }));
    assert.equal(res.ok, true);
    assertClose(Math.max(res.sigmaWidthMm, res.sigmaHeightMm), sigmaMm, 1e-4, 'reported sigma');
    return res.quality;
  };
  let lastScore = 1;
  for (const [sigmaMm, level, issues] of [
    [3, 'good', []],
    [7.9, 'good', []],
    [8.1, 'fair', []],
    [11.9, 'fair', []],
    [12.1, 'fair', ['high_uncertainty']],
    [15.9, 'fair', ['high_uncertainty']],
    [16.1, 'poor', ['high_uncertainty']],
    [40, 'poor', ['high_uncertainty']],
  ]) {
    const quality = gradeAt(sigmaMm);
    assert.equal(quality.level, level, `level at sigma ${sigmaMm} mm`);
    assert.deepEqual(quality.issues, issues, `issues at sigma ${sigmaMm} mm`);
    // The score follows the same scale: it never goes up as the measurement gets less certain.
    assert.ok(quality.score <= lastScore, `score ${quality.score} at sigma ${sigmaMm} mm`);
    lastScore = quality.score;
  }
});

test("a clean, well-posed scene is graded 'good' with no issues", () => {
  // Sub-pixel sheet corners on the standard 1920 x 2560 working image.
  const refined = measureDoor(input(makeScene(CLEAN), REFINED));
  assert.equal(refined.ok, true);
  assert.deepEqual(refined.quality.issues, []);
  assert.equal(refined.quality.level, 'good');
  assert.ok(refined.quality.score >= 0.75 && refined.quality.score <= 1);
  assert.ok(refined.sigmaWidthMm <= QUALITY_THRESHOLDS.goodSigmaMm && refined.sigmaHeightMm <= QUALITY_THRESHOLDS.goodSigmaMm);

  // The shipped config sigmas (0.5 / 2.5 px) on a full-resolution 12 MP photo.
  const hiRes = measureDoor(input(makeScene({ ...CLEAN, image: { width: 3024, height: 4032 } }), { sigmaSheetPx: 0.5, sigmaDoorPx: 2.5 }));
  assert.equal(hiRes.quality.level, 'good');
  assert.deepEqual(hiRes.quality.issues, []);
});

test('quality is graded consistently: score bands follow the level', () => {
  const rand = mulberry32(31);
  const gauss = gaussian(rand);
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    const sheet = i % 3 === 0 ? CARD : A4;
    const scene = makeScene({
      sheet,
      centre: { x: 150 + 520 * rand(), y: 200 + 1640 * rand() },
      rotDeg: 360 * rand(),
      cam: { distanceMm: 1900 + 3000 * rand(), yawDeg: -30 + 60 * rand(), pitchDeg: -15 + 30 * rand(), rollDeg: -5 + 10 * rand() },
    });
    const sigmaSheetPx = i % 2 === 0 ? 0.3 : 2;
    const res = measureDoor({ sheetPx: addNoise(scene.sheetPx, sigmaSheetPx, gauss), doorPx: addNoise(scene.doorPx, 2, gauss), sheetMm: sheet, imageSize: IMAGE, sigmaSheetPx, sigmaDoorPx: 2 });
    assert.equal(res.ok, true);
    const { level, score, issues } = res.quality;
    seen.add(level);
    assert.ok(['good', 'fair', 'poor'].includes(level));
    assert.ok(score >= 0 && score <= 1);
    for (const code of issues) assert.ok(ISSUE_CODES.includes(code), code);
    assert.equal(new Set(issues).size, issues.length);
    const maxSigma = Math.max(res.sigmaWidthMm, res.sigmaHeightMm);
    if (level === 'good') {
      assert.equal(issues.length, 0);
      assert.ok(maxSigma <= QUALITY_THRESHOLDS.goodSigmaMm);
      assert.ok(score >= 0.75);
    } else if (level === 'fair') {
      assert.ok(score >= 0.4 && score < 0.75);
      assert.ok(maxSigma <= QUALITY_THRESHOLDS.poorSigmaMm);
      assert.ok(!issues.some((c) => ['high_residual', 'implausible_size', 'methods_disagree'].includes(c)));
    } else {
      assert.ok(score < 0.4);
    }
    assert.equal(issues.includes('high_uncertainty'), maxSigma > QUALITY_THRESHOLDS.highUncertaintySigmaMm);
  }
  assert.deepEqual([...seen].sort(), ['fair', 'good', 'poor']);
});

test("issue 'sheet_small': the sheet is only a few dozen pixels across", () => {
  const res = measureDoor(input(makeScene({ ...CLEAN, image: { width: 600, height: 800 } }), REFINED));
  assert.equal(res.ok, true);
  assert.ok(res.quality.issues.includes('sheet_small'));
  assertClose(res.widthMm, 820, 0.01, 'still exact without noise');
});

test("issue 'steep_angle': photographed from far off to one side", () => {
  const res = measureDoor(input(makeScene({ cam: { distanceMm: 2600, yawDeg: 55 } }), REFINED));
  assert.equal(res.ok, true);
  assert.deepEqual(res.quality.issues, ['steep_angle']);
  assert.equal(res.quality.level, 'fair');
  // ... and from below.
  const low = measureDoor(input(makeScene({ cam: { distanceMm: 2200, pitchDeg: 32 } }), REFINED));
  assert.ok(low.quality.issues.includes('steep_angle'));
});

test("issue 'high_residual': one corner is clearly mis-marked", () => {
  const scene = makeScene({ centre: { x: 300, y: 700 }, ...CLEAN });
  const bent = { ...scene, sheetPx: scene.sheetPx.map((p, i) => (i === 2 ? { x: p.x + 9, y: p.y - 7 } : p)) };
  const res = measureDoor(input(bent, REFINED));
  assert.equal(res.ok, true);
  assert.ok(res.quality.issues.includes('high_residual'));
  assert.equal(res.quality.level, 'poor');
  assert.ok(res.rmsResidualPx > 1);
  assert.ok(res.fit.chi2 / res.fit.dof > QUALITY_THRESHOLDS.highResidualChi2PerDof);
});

test("issue 'methods_disagree': the sheet's own perspective contradicts the door's", () => {
  // Keystone the sheet by 2 px a side, as if it were peeling away from the door.
  const scene = makeScene({ centre: { x: 300, y: 600 }, ...CLEAN });
  const d = 2;
  const keystoned = { ...scene, sheetPx: scene.sheetPx.map((p, i) => ({ x: p.x + (i === 0 || i === 2 ? -d : d), y: p.y })) };
  const res = measureDoor(input(keystoned, REFINED));
  assert.equal(res.ok, true);
  assert.ok(res.quality.issues.includes('methods_disagree'), res.quality.issues.join(','));
  assert.equal(res.quality.level, 'poor');
  // The joint estimate is far less upset by the bad sheet than the sheet-only extrapolation is.
  assert.ok(Math.abs(res.heightMm - 2040) < 0.2 * Math.abs(res.sheetOnly.heightMm - 2040));
});

test("issue 'door_near_edge': a door corner is within 2% of the image border", () => {
  const scene = makeScene({ cam: { distanceMm: 1500 } });
  const res = measureDoor(input(scene, REFINED));
  assert.equal(res.ok, true);
  assert.deepEqual(res.quality.issues, ['door_near_edge']);
  assert.equal(res.quality.level, 'fair');
  // Left edge only: the camera is aimed well to the right of the door.
  const shifted = makeScene({ cam: { distanceMm: 2600, target: { x: 1320, y: 1020 } } });
  const leftmost = Math.min(...shifted.doorPx.map((p) => p.x));
  assert.ok(leftmost > 0 && leftmost < 0.02 * IMAGE.width, `leftmost door corner at x = ${leftmost}`);
  assert.ok(measureDoor(input(shifted, REFINED)).quality.issues.includes('door_near_edge'));
  // Comfortably inside the frame: no flag.
  assert.ok(!measureDoor(input(makeScene({ cam: { distanceMm: 2600 } }), REFINED)).quality.issues.includes('door_near_edge'));
});

test("issue 'door_small': the door fills under 45% of the image height", () => {
  const res = measureDoor(input(makeScene({ cam: { distanceMm: 5000 } }), REFINED));
  assert.equal(res.ok, true);
  assert.ok(res.quality.issues.includes('door_small'));
  assert.ok(!measureDoor(input(makeScene({ cam: { distanceMm: 3000 } }), REFINED)).quality.issues.includes('door_small'));
});

test("issue 'implausible_size': the result is outside the plausible range", () => {
  // The customer picked A3 but taped up A4: everything comes out 41% too big.
  const wrongSheet = measureDoor(input(makeScene(CLEAN), { ...REFINED, sheetMm: { w: 297, h: 420 } }));
  assert.equal(wrongSheet.ok, true);
  assert.ok(wrongSheet.quality.issues.includes('implausible_size'));
  assert.equal(wrongSheet.quality.level, 'poor');
  assertClose(wrongSheet.heightMm, 2040 * Math.SQRT2, 0.5, 'scaled height');

  // A custom range from the caller is honoured.
  const scene = makeScene(CLEAN);
  const narrow = measureDoor(input(scene, { ...REFINED, plausible: { minWidthMm: 850, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 } }));
  assert.ok(narrow.quality.issues.includes('implausible_size'));
  const wide = measureDoor(input(scene, { ...REFINED, plausible: { minWidthMm: 100, maxWidthMm: 5000, minHeightMm: 100, maxHeightMm: 5000 } }));
  assert.ok(!wide.quality.issues.includes('implausible_size'));
});

test("issue 'sheet_off_door': the sheet is on the wall beside the door", () => {
  const res = measureDoor(input(makeScene({ ...CLEAN, centre: { x: -250, y: 1020 } }), REFINED));
  assert.equal(res.ok, true);
  assert.deepEqual(res.quality.issues, ['sheet_off_door']);
  assertClose(res.widthMm, 820, 0.01, 'still measures: the wall is in the same plane');
});

test("issue 'high_uncertainty': a bank card marked by hand cannot give millimetres", () => {
  const res = measureDoor(input(makeScene({ ...CLEAN, sheet: CARD }), { sigmaSheetPx: 2, sigmaDoorPx: 2 }));
  assert.equal(res.ok, true);
  assert.ok(res.quality.issues.includes('high_uncertainty'));
  assert.equal(res.quality.level, 'poor');
  assert.ok(Math.max(res.sigmaWidthMm, res.sigmaHeightMm) > QUALITY_THRESHOLDS.poorSigmaMm);
});

test('every issue code is one of the nine contract strings and each can be triggered', () => {
  const triggered = new Set();
  const collect = (res) => {
    assert.equal(res.ok, true);
    for (const code of res.quality.issues) {
      assert.ok(ISSUE_CODES.includes(code), `unknown issue code ${code}`);
      triggered.add(code);
    }
  };
  const base = makeScene({ centre: { x: 300, y: 600 }, ...CLEAN });
  collect(measureDoor(input(makeScene({ ...CLEAN, image: { width: 600, height: 800 } }), REFINED)));
  collect(measureDoor(input(makeScene({ cam: { distanceMm: 2600, yawDeg: 55 } }), REFINED)));
  collect(measureDoor(input({ ...base, sheetPx: base.sheetPx.map((p, i) => ({ x: p.x + (i === 0 || i === 2 ? -2 : 2), y: p.y })) }, REFINED)));
  collect(measureDoor(input(makeScene({ cam: { distanceMm: 1500 } }), REFINED)));
  collect(measureDoor(input(makeScene({ cam: { distanceMm: 5000 } }), REFINED)));
  collect(measureDoor(input(makeScene(CLEAN), { ...REFINED, sheetMm: { w: 297, h: 420 } })));
  collect(measureDoor(input(makeScene({ ...CLEAN, centre: { x: -250, y: 1020 } }), REFINED)));
  collect(measureDoor(input(makeScene({ ...CLEAN, sheet: CARD }), { sigmaSheetPx: 2, sigmaDoorPx: 2 })));
  assert.deepEqual([...triggered].sort(), ISSUE_CODES.slice().sort());
});
