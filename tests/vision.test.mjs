import test from 'node:test';
import assert from 'node:assert/strict';

import { toLuma, sampleBilinear, refineQuad, detectSheet, warpToRect } from '../js/vision.js';
import {
  renderSynth,
  poseQuad,
  perturbQuad,
  cornerErrors,
  maxCornerError,
  mulberry32,
  band,
  shadeBeyond,
  disc,
  offsetQuad,
  homographyFrom4,
  applyH,
  pixelAt,
} from './helpers/synth.mjs';

const PAPER = [238, 238, 232];
const DARK_DOOR = [70, 48, 38];
const WALL = [205, 198, 186];

const centreOf = (q) => ({
  x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
  y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
});

const shoelace = (q) => q.reduce((acc, p, i) => acc + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0) / 2;

/** Asserts the [TL, TR, BR, BL] convention: clockwise on screen, first corner has the smallest x + y. */
function assertOrdered(quad) {
  assert.equal(quad.length, 4);
  assert.ok(shoelace(quad) > 0, 'corners run clockwise on screen');
  const sums = quad.map((p) => p.x + p.y);
  assert.equal(sums.indexOf(Math.min(...sums)), 0, 'first corner is the top-left one');
}

/** A door on a wall with a sheet on the door: the standard detection scene. */
function doorScene({
  width,
  height,
  door,
  sheet,
  doorColor = DARK_DOOR,
  sheetColor = PAPER,
  wall = WALL,
  extra = [],
  gradient = null,
  blurSigma = 0.8,
  noiseSigma = 3,
  seed = 1,
}) {
  const shapes = [];
  if (door) shapes.push({ points: door, color: doorColor });
  shapes.push(...extra);
  if (sheet) shapes.push({ points: sheet, color: sheetColor });
  return renderSynth({ width, height, background: wall, shapes, gradient, blurSigma, noiseSigma, seed });
}

/* ------------------------------------------------------------------------------------------------------ */
/* toLuma / sampleBilinear                                                                                */
/* ------------------------------------------------------------------------------------------------------ */

test('toLuma converts RGBA to Rec.601 luma', () => {
  const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0, 10, 20, 30, 255, 0, 0, 0, 255]);
  const luma = toLuma({ data, width: 3, height: 2 });
  assert.ok(luma.data instanceof Float32Array);
  assert.equal(luma.width, 3);
  assert.equal(luma.height, 2);
  assert.equal(luma.data.length, 6);
  const expected = [76.245, 149.685, 29.07, 255, 0.299 * 10 + 0.587 * 20 + 0.114 * 30, 0];
  expected.forEach((v, i) => assert.ok(Math.abs(luma.data[i] - v) < 1e-3, `pixel ${i}: ${luma.data[i]} vs ${v}`));
});

test('sampleBilinear interpolates between pixel centres and clamps at the borders', () => {
  const luma = { data: new Float32Array([0, 10, 20, 30, 40, 50]), width: 3, height: 2 };
  assert.equal(sampleBilinear(luma, 0, 0), 0);
  assert.equal(sampleBilinear(luma, 2, 1), 50);
  assert.equal(sampleBilinear(luma, 1, 0), 10);
  assert.ok(Math.abs(sampleBilinear(luma, 0.5, 0) - 5) < 1e-6);
  assert.ok(Math.abs(sampleBilinear(luma, 0, 0.5) - 15) < 1e-6);
  assert.ok(Math.abs(sampleBilinear(luma, 0.5, 0.5) - 20) < 1e-6);
  assert.ok(Math.abs(sampleBilinear(luma, 1.25, 0.75) - (0.25 * 12.5 + 0.75 * 42.5)) < 1e-5);
  // outside: clamped to the nearest border pixel
  assert.equal(sampleBilinear(luma, -5, -5), 0);
  assert.equal(sampleBilinear(luma, 99, 99), 50);
  assert.equal(sampleBilinear(luma, 99, 0), 20);
  assert.equal(sampleBilinear(luma, -1, 1), 30);
});

/* ------------------------------------------------------------------------------------------------------ */
/* refineQuad                                                                                             */
/* ------------------------------------------------------------------------------------------------------ */

const REFINE_POSES = [
  { cx: 450, cy: 350, w: 210, h: 297 },
  { cx: 450.37, cy: 350.61, w: 210, h: 297, rotDeg: 7 },
  { cx: 420.2, cy: 330.8, w: 150, h: 212, rotDeg: -15, yawDeg: 20, pitchDeg: 10 },
  { cx: 460.5, cy: 360.1, w: 297, h: 210, rotDeg: 20, yawDeg: -25, pitchDeg: -15 },
  { cx: 449.7, cy: 351.3, w: 100, h: 141, rotDeg: 3, yawDeg: 10 },
  { cx: 450.9, cy: 349.4, w: 60, h: 85, rotDeg: -5 },
];

const POLARITIES = [
  { name: 'light sheet on dark door', fg: [235, 235, 228], bg: [62, 50, 44] },
  { name: 'dark blue sheet on light door', fg: [40, 60, 120], bg: [222, 216, 205] },
];

/** Runs refineQuad over all poses from perturbed starts; returns the worst and mean of the max corner error. */
function refineSweep({ fg, bg, blurSigma, noiseSigma, perturbPx, rngSeed, source = 'image' }) {
  const rng = mulberry32(rngSeed);
  let worst = 0;
  let total = 0;
  let count = 0;
  for (const pose of REFINE_POSES) {
    const truth = poseQuad(pose);
    const image = renderSynth({
      width: 900,
      height: 700,
      background: bg,
      shapes: [{ points: truth, color: fg }],
      blurSigma,
      noiseSigma,
      seed: count + 1,
    });
    const src = source === 'luma' ? toLuma(image) : image;
    for (let rep = 0; rep < 2; rep++) {
      const start = perturbQuad(truth, perturbPx, rng);
      const res = refineQuad(src, start);
      assert.ok(res.ok, `refine failed (${res.reason}) for pose ${JSON.stringify(pose)}`);
      assert.equal(res.quad.length, 4);
      assert.equal(res.shiftsPx.length, 4);
      assert.equal(res.edgeRmsPx.length, 4);
      assert.equal(res.inlierRatio.length, 4);
      assert.equal(res.reason, undefined);
      res.inlierRatio.forEach((r) => assert.ok(r >= 0.6 && r <= 1));
      // shiftsPx reports how far each corner moved from where it started.
      res.shiftsPx.forEach((s, i) => {
        const moved = Math.hypot(res.quad[i].x - start[i].x, res.quad[i].y - start[i].y);
        assert.ok(Math.abs(s - moved) < 1e-9);
        assert.ok(s <= perturbPx + 1);
      });
      const err = Math.max(...cornerErrors(res.quad, truth));
      worst = Math.max(worst, err);
      total += err;
      count++;
    }
  }
  return { worst, mean: total / count };
}

for (const [index, polarity] of POLARITIES.entries()) {
  test(`refineQuad: clean anti-aliased edges, ${polarity.name}, corners within 0.25 px`, (t) => {
    const { worst, mean } = refineSweep({ ...polarity, blurSigma: 0, noiseSigma: 0, perturbPx: 6, rngSeed: 100 + index });
    t.diagnostic(`clean ${polarity.name}: worst corner error ${worst.toFixed(3)} px, mean ${mean.toFixed(3)} px`);
    assert.ok(worst < 0.25, `worst corner error ${worst}`);
  });

  test(`refineQuad: noise sigma 4 and blur sigma 1, ${polarity.name}, corners within 0.5 px`, (t) => {
    const { worst, mean } = refineSweep({ ...polarity, blurSigma: 1, noiseSigma: 4, perturbPx: 6, rngSeed: 200 + index });
    t.diagnostic(`noisy ${polarity.name}: worst corner error ${worst.toFixed(3)} px, mean ${mean.toFixed(3)} px`);
    assert.ok(worst < 0.5, `worst corner error ${worst}`);
  });
}

test('refineQuad accepts a precomputed Luma and gives the same answer as the RGBA image', () => {
  const truth = poseQuad(REFINE_POSES[2]);
  const image = renderSynth({ width: 900, height: 700, background: [62, 50, 44], shapes: [{ points: truth, color: PAPER }], blurSigma: 0.7, noiseSigma: 2 });
  const start = perturbQuad(truth, 5, mulberry32(9));
  const fromImage = refineQuad(image, start);
  const fromLuma = refineQuad(toLuma(image), start);
  assert.ok(fromImage.ok && fromLuma.ok);
  assert.ok(Math.max(...cornerErrors(fromImage.quad, fromLuma.quad)) < 0.02);
  assert.ok(Math.max(...cornerErrors(fromLuma.quad, truth)) < 0.25);
});

test('refineQuad keeps the caller\'s corner order, whichever way round it runs', () => {
  const truth = poseQuad(REFINE_POSES[1]);
  const image = renderSynth({ width: 900, height: 700, background: [62, 50, 44], shapes: [{ points: truth, color: PAPER }] });
  const rng = mulberry32(31);
  const rotated = [truth[2], truth[3], truth[0], truth[1]];
  const reversed = [truth[0], truth[3], truth[2], truth[1]];
  for (const reference of [rotated, reversed]) {
    const res = refineQuad(image, perturbQuad(reference, 5, rng));
    assert.ok(res.ok, res.reason);
    assert.ok(Math.max(...cornerErrors(res.quad, reference)) < 0.25);
  }
});

test('refineQuad is not pulled onto a parallel edge that lies further away than the true one', (t) => {
  const rng = mulberry32(77);
  let worst = 0;
  for (const [bandColor, label] of [
    [[30, 26, 24], 'stronger than the sheet edge'],
    [[95, 88, 84], 'weaker than the sheet edge'],
  ]) {
    for (const pose of [
      { cx: 450.3, cy: 350.6, w: 210, h: 297, rotDeg: 4 },
      { cx: 440.8, cy: 345.2, w: 170, h: 240, rotDeg: -11, yawDeg: 12 },
    ]) {
      const truth = poseQuad(pose);
      // Dark mouldings running parallel to the right and bottom sides, 9 px outside the sheet. Their inner
      // edges have the same polarity as the sheet's own edge (lighter -> darker going outwards).
      const offset = (a, b, d) => {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const nx = (b.y - a.y) / len;
        const ny = -(b.x - a.x) / len;
        const ext = 40 / len;
        return [
          { x: a.x - (b.x - a.x) * ext + nx * d, y: a.y - (b.y - a.y) * ext + ny * d },
          { x: b.x + (b.x - a.x) * ext + nx * d, y: b.y + (b.y - a.y) * ext + ny * d },
        ];
      };
      const [r0, r1] = offset(truth[1], truth[2], 9 + 4);
      const [b0, b1] = offset(truth[2], truth[3], 9 + 4);
      const image = renderSynth({
        width: 900,
        height: 700,
        background: [150, 142, 136],
        shapes: [
          { points: band(r0, r1, 8), color: bandColor },
          { points: band(b0, b1, 8), color: bandColor },
          { points: truth, color: PAPER },
        ],
        blurSigma: 0.8,
        noiseSigma: 2,
        seed: 5,
      });
      for (let rep = 0; rep < 3; rep++) {
        // Starts within 3.5 px of the truth, so the true edge is always the nearer of the two.
        const res = refineQuad(image, perturbQuad(truth, 3.5, rng));
        assert.ok(res.ok, `${label}: ${res.reason}`);
        const err = Math.max(...cornerErrors(res.quad, truth));
        worst = Math.max(worst, err);
        assert.ok(err < 0.5, `${label}: corner error ${err}`);
      }
    }
  }
  t.diagnostic(`with distractor edges: worst corner error ${worst.toFixed(3)} px`);
});

test('refineQuad allows for a cast shadow or a sharpening halo hugging the edges', (t) => {
  const rng = mulberry32(55);
  const paper = [232, 232, 228];
  const door = [194, 190, 184];
  const shift = (quad, dx, dy) => quad.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  let worstShadow = 0;
  let worstHalo = 0;
  for (const pose of [
    { cx: 400.3, cy: 300.4, w: 168, h: 238, rotDeg: 5 },
    { cx: 395.8, cy: 305.1, w: 150, h: 212, rotDeg: -9, yawDeg: 12, pitchDeg: 6 },
  ]) {
    const truth = poseQuad(pose);
    // A hard shadow 3-4 px wide along the right and bottom edges, much darker than the door. Its outer edge
    // has the opposite polarity to the sheet's and, left alone, drags those two sides inwards by ~0.3 px.
    const shadowed = renderSynth({
      width: 800,
      height: 600,
      background: door,
      shapes: [{ points: shift(truth, 3, 4), color: door.map((v) => v * 0.6) }, { points: truth, color: paper }],
      blurSigma: 1,
      noiseSigma: 2,
      seed: 21,
    });
    // A halo all round: a darker ring outside the sheet and a brighter ring just inside it.
    const haloed = renderSynth({
      width: 800,
      height: 600,
      background: door,
      shapes: [
        { points: offsetQuad(truth, 4), color: door.map((v) => v * 0.88) },
        { points: truth, color: [246, 246, 242] },
        { points: offsetQuad(truth, -4), color: paper },
      ],
      blurSigma: 0.8,
      noiseSigma: 2,
      seed: 22,
    });
    for (let rep = 0; rep < 2; rep++) {
      const start = perturbQuad(truth, 4, rng);
      const a = refineQuad(shadowed, start);
      assert.ok(a.ok, a.reason);
      worstShadow = Math.max(worstShadow, ...cornerErrors(a.quad, truth));
      const b = refineQuad(haloed, start);
      assert.ok(b.ok, b.reason);
      worstHalo = Math.max(worstHalo, ...cornerErrors(b.quad, truth));
    }
  }
  t.diagnostic(`worst corner error: ${worstShadow.toFixed(3)} px beside a cast shadow, ${worstHalo.toFixed(3)} px with a halo`);
  assert.ok(worstShadow < 0.2, `shadow: ${worstShadow}`);
  assert.ok(worstHalo < 0.2, `halo: ${worstHalo}`);
});

test('refineQuad keeps a side off the far edge of the shadow line round a sheet on a pale door', (t) => {
  // White paper on an off-white door, outlined by a shadow line a few pixels wide. The line's outer edge
  // is about as strong as the paper's own edge and steps the other way. One side of the starting quad sits
  // right on it (a hand-placed corner pair, or a coarse outline that took in the shadow). Judged on its
  // own, that side prefers the edge under it and ends up a shadow-width outside the paper while still
  // reporting ok; the three sides that found the paper have to overrule it.
  const door = [236, 233, 226];
  const paper = [250, 249, 245];
  let worst = 0;
  for (const bandPx of [4, 5, 6]) {
    for (const pose of [{ rotDeg: 0 }, { rotDeg: 7, yawDeg: 10 }, { rotDeg: -12, pitchDeg: 8 }]) {
      const truth = poseQuad({ cx: 400, cy: 300, w: 170, h: 240, ...pose });
      const grown = offsetQuad(truth, bandPx);
      const image = renderSynth({
        width: 800,
        height: 600,
        background: door,
        shapes: [{ points: grown, color: door.map((v) => v * 0.82) }, { points: truth, color: paper }],
        blurSigma: 0.8,
        noiseSigma: 2,
        seed: 31,
      });
      for (let side = 0; side < 4; side++) {
        const start = truth.map((p) => ({ ...p }));
        start[side] = grown[side];
        start[(side + 1) % 4] = grown[(side + 1) % 4];
        const res = refineQuad(image, start, { searchRadiusPx: 8 });
        assert.ok(res.ok, `band ${bandPx} px, side ${side}: ${res.reason}`);
        const error = Math.max(...cornerErrors(res.quad, truth));
        assert.ok(error < 0.25, `band ${bandPx} px, side ${side}: corner ${error.toFixed(2)} px off the paper`);
        worst = Math.max(worst, error);
      }
    }
  }
  t.diagnostic(`one side started on the shadow's far edge: worst corner error ${worst.toFixed(3)} px`);
});

test('refineQuad leaves a side alone when it genuinely steps the other way (sheet across a two-tone surface)', () => {
  // A mid-grey sheet whose left edge lies on a pale strip and the rest on a dark door: three sides are
  // lighter than their surroundings, the left one darker, with nothing of the common sign near it.
  const sheet = [140, 140, 138];
  for (const pose of [{ rotDeg: 0 }, { rotDeg: 3, yawDeg: 8 }]) {
    const truth = poseQuad({ cx: 400, cy: 300, w: 180, h: 250, ...pose });
    const strip = [{ x: 0, y: 0 }, { x: 325, y: 0 }, { x: 325, y: 600 }, { x: 0, y: 600 }];
    const image = renderSynth({
      width: 800,
      height: 600,
      background: [60, 52, 48],
      shapes: [{ points: strip, color: [225, 222, 215] }, { points: truth, color: sheet }],
      blurSigma: 0.7,
      noiseSigma: 2,
      seed: 41,
    });
    const rng = mulberry32(42);
    for (let rep = 0; rep < 3; rep++) {
      const res = refineQuad(image, perturbQuad(truth, 4, rng));
      assert.ok(res.ok, res.reason);
      const error = Math.max(...cornerErrors(res.quad, truth));
      assert.ok(error < 0.25, `corner ${error.toFixed(2)} px off`);
    }
  }
});

// A pale door, and sheets of the kind the app suggests for one. Each is about as dark as the shadow it
// casts, so in luminance the paper's own edge all but vanishes beside the far edge of that shadow.
const PALE_DOOR = [236, 233, 226];
const COLOURED_SHEETS = { blue: [63, 127, 208], kraft: [185, 141, 92], orange: [240, 138, 36], 'light green': [159, 216, 154] };

// Pale, pastel and grey sheets: their shadow is the same sort of colour as the paper, only a little darker.
// (Cream and a paler grey are too close to this door's colour to be outlined at all.)
const PALE_SHEETS = { 'pastel pink': [255, 209, 220], lavender: [216, 205, 234], 'light grey': [200, 200, 200] };

/**
 * A coloured sheet on the pale door with a hard shadow `shadowPx` wide down its right and bottom sides,
 * the door in it `shade` times as bright.
 */
function shadowedSheetShapes(truth, sheetColor, shadowPx, shade = 0.6) {
  const shadow = truth.map((p) => ({ x: p.x + shadowPx, y: p.y + shadowPx }));
  return [{ points: shadow, color: PALE_DOOR.map((v) => v * shade) }, { points: truth, color: sheetColor }];
}

test('refineQuad given the photo refuses a side that settles on the far edge of the sheet\'s shadow', (t) => {
  const truth = poseQuad({ cx: 400.3, cy: 300.4, w: 168, h: 238, rotDeg: 3, yawDeg: 6 });
  const rng = mulberry32(71);
  let refused = 0;
  let worstAccepted = 0;
  for (const [name, sheetColor] of Object.entries(COLOURED_SHEETS)) {
    for (const shadowPx of [4, 6]) {
      const image = renderSynth({
        width: 800,
        height: 600,
        background: PALE_DOOR,
        shapes: shadowedSheetShapes(truth, sheetColor, shadowPx),
        blurSigma: 0.9,
        noiseSigma: 2,
        seed: 23,
      });
      for (let rep = 0; rep < 2; rep++) {
        const start = perturbQuad(truth, 3, rng);
        const res = refineQuad(image, start);
        // Never "ok" with a side on the shadow: either the paper's own edges were found, or it says so
        // and hands the corners back untouched.
        if (res.ok) {
          worstAccepted = Math.max(worstAccepted, ...cornerErrors(res.quad, truth));
        } else {
          refused++;
          assert.equal(res.reason, 'off_sheet', `${name}, ${shadowPx} px shadow`);
          assert.deepEqual(res.quad, start);
        }
        // A luma plane has no colour to go by; the check can be switched off for the photo as well.
        const unchecked = refineQuad(image, start, { checkColour: false });
        assert.ok(unchecked.ok, unchecked.reason);
        assert.ok(Math.max(...cornerErrors(unchecked.quad, refineQuad(toLuma(image), start).quad)) < 0.02);
      }
    }
    // Without the shadow there is nothing to be wary of.
    const shapes = [{ points: truth, color: sheetColor }];
    const plain = renderSynth({ width: 800, height: 600, background: PALE_DOOR, shapes, blurSigma: 0.9, noiseSigma: 2, seed: 24 });
    const res = refineQuad(plain, perturbQuad(truth, 3, rng));
    assert.ok(res.ok, `${name}, no shadow: ${res.reason}`);
    assert.ok(Math.max(...cornerErrors(res.quad, truth)) < 0.25, `${name}, no shadow`);
  }
  t.diagnostic(`coloured sheet beside its shadow: ${refused} of 16 snaps refused, worst accepted corner ${worstAccepted.toFixed(3)} px off`);
  assert.ok(worstAccepted < 0.75, `an accepted snap is ${worstAccepted.toFixed(2)} px off the paper`);
  assert.ok(refused >= 12, `only ${refused} of 16 refused`);
});

test('refineQuad given the photo refuses the shadow edge of a pale, pastel or grey sheet too', (t) => {
  // The shadow is darker than the paper but close to it in colour, so only the paper further in on the
  // same side tells the two apart.
  const truth = poseQuad({ cx: 400.3, cy: 300.4, w: 168, h: 238, rotDeg: 3, yawDeg: 6 });
  const rng = mulberry32(73);
  let refused = 0;
  let worstAccepted = 0;
  for (const [name, sheetColor] of Object.entries(PALE_SHEETS)) {
    for (const shade of [0.6, 0.8]) {
      for (const shadowPx of [4, 6]) {
        const shapes = shadowedSheetShapes(truth, sheetColor, shadowPx, shade);
        const image = renderSynth({ width: 800, height: 600, background: PALE_DOOR, shapes, blurSigma: 0.9, noiseSigma: 2, seed: 23 });
        for (let rep = 0; rep < 2; rep++) {
          const start = perturbQuad(truth, 3, rng);
          const res = refineQuad(image, start);
          if (res.ok) {
            worstAccepted = Math.max(worstAccepted, ...cornerErrors(res.quad, truth));
          } else {
            refused++;
            assert.equal(res.reason, 'off_sheet', `${name}, shadow x${shade}, ${shadowPx} px`);
          }
        }
      }
    }
    // Without the shadow the paper's own edges are found as usual.
    const plain = renderSynth({ width: 800, height: 600, background: PALE_DOOR, shapes: [{ points: truth, color: sheetColor }], blurSigma: 0.9, noiseSigma: 2, seed: 24 });
    const res = refineQuad(plain, perturbQuad(truth, 3, rng));
    assert.ok(res.ok, `${name}, no shadow: ${res.reason}`);
    assert.ok(Math.max(...cornerErrors(res.quad, truth)) < 0.25, `${name}, no shadow`);
  }
  t.diagnostic(`pale sheet beside its shadow: ${refused} of 24 snaps refused, worst accepted corner ${worstAccepted.toFixed(3)} px off`);
  assert.ok(worstAccepted < 0.75, `an accepted snap is ${worstAccepted.toFixed(2)} px off the paper`);
  assert.ok(refused >= 20, `only ${refused} of 24 refused`);
});

test('refineQuad given the photo does not take a soft edge on a dark sheet for the sheet\'s shadow', () => {
  // In a soft photo the door's colour is blurred in across the real edge of a black, grey or navy sheet,
  // and the strip just inside that edge is then a dimmed version of the pale door, as a shadow would be.
  const truth = poseQuad({ cx: 400.3, cy: 300.4, w: 168, h: 238, rotDeg: 3, yawDeg: 6 });
  const rng = mulberry32(72);
  for (const sheetColor of [[32, 32, 32], [96, 96, 96], [28, 43, 85]]) {
    for (const blurSigma of [1.5, 2.5, 3, 4]) {
      const shapes = [{ points: truth, color: sheetColor }];
      const image = renderSynth({ width: 800, height: 600, background: PALE_DOOR, shapes, blurSigma, noiseSigma: 2, seed: 25 });
      const res = refineQuad(image, perturbQuad(truth, 3, rng));
      assert.ok(res.ok, `sheet ${sheetColor}, blur ${blurSigma}: ${res.reason}`);
      assert.ok(Math.max(...cornerErrors(res.quad, truth)) < 0.25, `sheet ${sheetColor}, blur ${blurSigma}`);
    }
  }
});

test('refineQuad given the photo does not take a sharpening halo round a sheet on a pale door for its shadow', () => {
  // A sharpened photo: a dark rim just inside the sheet's edge and a light one just outside it, in
  // proportion to the step (lost to white where the door is already near white). The dark rim is darker
  // than the paper further in, as a faint shadow would be.
  const truth = poseQuad({ cx: 400.3, cy: 300.4, w: 168, h: 238, rotDeg: 3, yawDeg: 6 });
  const rng = mulberry32(74);
  for (const door of [PALE_DOOR, [250, 249, 246]]) {
    for (const sheetColor of [[32, 32, 32], [96, 96, 96], [28, 43, 85], [140, 140, 138], [200, 200, 200]]) {
      for (const strength of [0.15, 0.3]) {
        const shapes = [
          { points: offsetQuad(truth, 1.5), color: door.map((v, c) => Math.min(255, v + strength * (v - sheetColor[c]))) },
          { points: truth, color: sheetColor.map((v, c) => Math.max(0, v - strength * (door[c] - v))) },
          { points: offsetQuad(truth, -1.5), color: sheetColor },
        ];
        const image = renderSynth({ width: 800, height: 600, background: door, shapes, blurSigma: 0.7, noiseSigma: 2, seed: 26 });
        const res = refineQuad(image, perturbQuad(truth, 3, rng));
        const what = `sheet ${sheetColor} on door ${door}, halo ${strength}`;
        assert.ok(res.ok, `${what}: ${res.reason}`);
        assert.ok(Math.max(...cornerErrors(res.quad, truth)) < 0.25, what);
      }
    }
  }
});

test('refineQuad reports ok:false on featureless regions and returns the input quad unchanged', () => {
  const quad = [
    { x: 100, y: 100 },
    { x: 300, y: 104 },
    { x: 296, y: 300 },
    { x: 98, y: 290 },
  ];
  const flat = renderSynth({ width: 400, height: 400, background: [128, 128, 128] });
  const noisy = renderSynth({ width: 400, height: 400, background: [128, 128, 128], noiseSigma: 6, seed: 3 });
  const ramp = renderSynth({ width: 400, height: 400, background: [128, 128, 128], gradient: { angleDeg: 20, strength: 0.5 }, noiseSigma: 3, seed: 4 });
  for (const image of [flat, noisy, ramp]) {
    for (const opts of [undefined, { searchRadiusPx: 4 }, { searchRadiusPx: 12, iterations: 3 }]) {
      const res = refineQuad(image, quad, opts);
      assert.equal(res.ok, false);
      assert.equal(typeof res.reason, 'string');
      assert.deepEqual(res.quad, quad);
      assert.equal(res.shiftsPx.length, 4);
      assert.equal(res.edgeRmsPx.length, 4);
      assert.equal(res.inlierRatio.length, 4);
    }
  }
});

test('refineQuad fails cleanly when the edges are out of reach or the input is unusable', () => {
  const truth = poseQuad({ cx: 450, cy: 350, w: 210, h: 297 });
  const image = renderSynth({ width: 900, height: 700, background: [62, 50, 44], shapes: [{ points: truth, color: PAPER }] });
  // 60 px away from every edge: nothing within the search radius.
  const far = truth.map((p) => ({ x: p.x + 60, y: p.y + 60 }));
  const res = refineQuad(image, far, { searchRadiusPx: 10 });
  assert.equal(res.ok, false);
  assert.deepEqual(res.quad, far);

  assert.equal(refineQuad(image, [{ x: 1, y: 1 }, { x: 2, y: 2 }]).ok, false);
  assert.equal(refineQuad(image, [{ x: 1, y: 1 }, { x: NaN, y: 2 }, { x: 5, y: 5 }, { x: 1, y: 5 }]).ok, false);
  assert.equal(refineQuad(null, truth).ok, false);
  // self-intersecting "bow-tie"
  assert.equal(refineQuad(image, [truth[0], truth[2], truth[1], truth[3]]).ok, false);
});

/* ------------------------------------------------------------------------------------------------------ */
/* detectSheet                                                                                            */
/* ------------------------------------------------------------------------------------------------------ */

test('detectSheet finds a white sheet on a dark door (800 x 600), from any tap on the paper', () => {
  const door = poseQuad({ cx: 400, cy: 300, w: 300, h: 560, yawDeg: 8 });
  const sheet = poseQuad({ cx: 401.3, cy: 250.6, w: 90, h: 127, rotDeg: 6, yawDeg: 8 });
  const image = doorScene({ width: 800, height: 600, door, sheet });
  const c = centreOf(sheet);
  for (const seed of [c, { x: c.x + 25, y: c.y - 35 }, { x: sheet[0].x + 9, y: sheet[0].y + 11 }, { x: sheet[2].x - 10, y: sheet[2].y - 9 }]) {
    const res = detectSheet(image, seed);
    assert.ok(res.ok, res.reason);
    assert.equal(res.refined, true);
    assert.equal(res.reason, undefined);
    assert.ok(res.confidence > 0.6 && res.confidence <= 1);
    assertOrdered(res.quad);
    assert.ok(Math.max(...cornerErrors(res.quad, sheet)) < 0.5);
  }
});

test('detectSheet on a 1536 x 2048 photo with a sheet about 150 px wide, uneven lighting, noise and blur', (t) => {
  const door = poseQuad({ cx: 770, cy: 1050, w: 620, h: 1540, yawDeg: 6, pitchDeg: -4 });
  const sheet = poseQuad({ cx: 760.4, cy: 800.7, w: 150, h: 212, rotDeg: 2, yawDeg: 6, pitchDeg: -4 });
  const image = doorScene({
    width: 1536,
    height: 2048,
    door,
    sheet,
    doorColor: [120, 84, 60],
    gradient: { angleDeg: 30, strength: 0.25 },
    blurSigma: 0.9,
    noiseSigma: 4,
  });
  const started = performance.now();
  const res = detectSheet(image, centreOf(sheet));
  const elapsed = performance.now() - started;
  assert.ok(res.ok, res.reason);
  assert.equal(res.refined, true);
  assertOrdered(res.quad);
  const err = Math.max(...cornerErrors(res.quad, sheet));
  t.diagnostic(`1536x2048: corner error ${err.toFixed(3)} px, confidence ${res.confidence.toFixed(2)}, ${elapsed.toFixed(1)} ms`);
  assert.ok(err < 0.5, `corner error ${err}`);

  // A precomputed luma plane is accepted and gives the same corners.
  const withLuma = detectSheet(image, centreOf(sheet), { luma: toLuma(image) });
  assert.ok(withLuma.ok && withLuma.refined);
  assert.ok(Math.max(...cornerErrors(withLuma.quad, res.quad)) < 0.02);

  // Tapping the door instead of the sheet is rejected, not mistaken for a very large sheet.
  const onDoor = detectSheet(image, { x: 770, y: 1500 });
  assert.equal(onDoor.ok, false);
  assert.equal(onDoor.reason, 'too_large');
  assert.equal(onDoor.quad, null);
  assert.equal(onDoor.confidence, 0);
  assert.equal(onDoor.refined, false);
});

test('detectSheet copes with rotation up to 20 degrees, perspective and a lighting gradient across the paper', () => {
  const door = poseQuad({ cx: 600, cy: 820, w: 520, h: 1300, yawDeg: 15, pitchDeg: 8 });
  const cases = [
    { sheet: poseQuad({ cx: 610.2, cy: 700.4, w: 130, h: 184, rotDeg: 20, yawDeg: 15, pitchDeg: 8 }), gradient: { angleDeg: 100, strength: 0.3 } },
    { sheet: poseQuad({ cx: 590.6, cy: 690.9, w: 184, h: 130, rotDeg: -18, yawDeg: -20, pitchDeg: 12 }), gradient: { angleDeg: 200, strength: 0.3 } },
    { sheet: poseQuad({ cx: 600.1, cy: 720.3, w: 160, h: 226, rotDeg: -9, yawDeg: 18, pitchDeg: -10 }), gradient: { angleDeg: 320, strength: 0.25 } },
  ];
  for (const { sheet, gradient } of cases) {
    const image = doorScene({ width: 1200, height: 1600, door, sheet, doorColor: [150, 150, 154], gradient });
    const res = detectSheet(image, centreOf(sheet));
    assert.ok(res.ok, res.reason);
    assert.equal(res.refined, true);
    assertOrdered(res.quad);
    assert.ok(maxCornerError(res.quad, sheet) < 0.5);
  }
});

test('detectSheet finds a sheet lying at any angle to the photo, with or without tape on its corners', () => {
  // Around 30 to 60 degrees the axis-aligned clean-up of the tapped region bites the sheet's corners off; a
  // sheet stuck on diagonally (or a phone held well off level) must still come back as a quad.
  const door = poseQuad({ cx: 450, cy: 620, w: 420, h: 1000, yawDeg: 8, pitchDeg: -4 });
  const centre = { x: 450.3, y: 520.6 };
  for (const rotDeg of [0, 30, 45, 60, 75]) {
    const sheet = poseQuad({ cx: centre.x, cy: centre.y, w: 120, h: 170, rotDeg, yawDeg: 8, pitchDeg: -4 });
    // Paper-coloured tape running 12 px out over each corner, along the diagonal.
    const tape = sheet.map((corner) => {
      const dx = corner.x - centre.x;
      const dy = corner.y - centre.y;
      const reach = 12 / Math.hypot(dx, dy);
      return {
        points: band({ x: corner.x - dx * reach, y: corner.y - dy * reach }, { x: corner.x + dx * reach, y: corner.y + dy * reach }, 8),
        color: [232, 230, 222],
      };
    });
    for (const extra of [[], tape]) {
      const image = doorScene({ width: 900, height: 1200, door, sheet, extra, seed: 60 + rotDeg });
      const what = `${rotDeg} degrees${extra.length ? ', taped' : ''}`;
      const res = detectSheet(image, centre);
      assert.ok(res.ok, `${what}: ${res.reason}`);
      assert.equal(res.refined, true, what);
      assertOrdered(res.quad);
      const error = maxCornerError(res.quad, sheet);
      assert.ok(error < 0.5, `${what}: corner ${error.toFixed(2)} px off`);
    }
  }
});

test('detectSheet works for a coloured sheet on a light door and for a small (unscaled) image', () => {
  const door = poseQuad({ cx: 600, cy: 800, w: 500, h: 1250, yawDeg: -7 });
  const sheet = poseQuad({ cx: 603.3, cy: 640.8, w: 140, h: 198, rotDeg: -4, yawDeg: -7 });
  const blueOnWhite = doorScene({ width: 1200, height: 1600, door, sheet, doorColor: [232, 230, 224], sheetColor: [45, 75, 150], wall: [170, 160, 150] });
  const res = detectSheet(blueOnWhite, centreOf(sheet));
  assert.ok(res.ok, res.reason);
  assert.equal(res.refined, true);
  assert.ok(Math.max(...cornerErrors(res.quad, sheet)) < 0.5);

  // 400 x 300: no downscaling happens, the region is grown at full resolution.
  const smallDoor = poseQuad({ cx: 200, cy: 150, w: 150, h: 280 });
  const smallSheet = poseQuad({ cx: 198.4, cy: 120.7, w: 52, h: 73, rotDeg: 5 });
  const small = doorScene({ width: 400, height: 300, door: smallDoor, sheet: smallSheet, blurSigma: 0.6, noiseSigma: 2 });
  const res2 = detectSheet(small, centreOf(smallSheet));
  assert.ok(res2.ok, res2.reason);
  assert.equal(res2.refined, true);
  assert.ok(Math.max(...cornerErrors(res2.quad, smallSheet)) < 0.5);
});

test('detectSheet ignores tape over the corners, including tape the colour of the paper', () => {
  const door = poseQuad({ cx: 768, cy: 1040, w: 640, h: 1560, yawDeg: 6, pitchDeg: -4 });
  const sheet = poseQuad({ cx: 757.7, cy: 820.6, w: 150, h: 212, rotDeg: -12, yawDeg: 6, pitchDeg: -4 });
  const c = centreOf(sheet);
  for (const tapeColor of [[50, 90, 170], [240, 240, 236]]) {
    // A strip of tape across each corner, perpendicular to the diagonal, sticking out over the door.
    const tape = sheet.map((p) => {
      const len = Math.hypot(p.x - c.x, p.y - c.y);
      const ux = (p.x - c.x) / len;
      const uy = (p.y - c.y) / len;
      const mx = p.x - ux * 3;
      const my = p.y - uy * 3;
      return { points: band({ x: mx + uy * 26, y: my - ux * 26 }, { x: mx - uy * 26, y: my + ux * 26 }, 18), color: tapeColor };
    });
    const image = renderSynth({
      width: 1536,
      height: 2048,
      background: WALL,
      shapes: [{ points: door, color: [95, 60, 40] }, { points: sheet, color: PAPER }, ...tape],
      gradient: { angleDeg: 40, strength: 0.2 },
      blurSigma: 0.8,
      noiseSigma: 3,
    });
    const res = detectSheet(image, c);
    assert.ok(res.ok, res.reason);
    assert.equal(res.refined, true);
    assert.ok(Math.max(...cornerErrors(res.quad, sheet)) < 0.5, `tape ${tapeColor}`);
  }
});

test('detectSheet returns the whole of a folded sheet, not the panel between two creases', () => {
  const door = poseQuad({ cx: 768, cy: 1044, w: 645, h: 1597, yawDeg: 6, pitchDeg: -4 });
  const sheet = poseQuad({ cx: 757.7, cy: 819.8, w: 150, h: 212, rotDeg: 4, yawDeg: 6, pitchDeg: -4 });
  const along = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  // A letter fold: two dark crease lines across the sheet, with the middle third slightly in shade.
  const third = [along(sheet[0], sheet[3], 1 / 3), along(sheet[1], sheet[2], 1 / 3), along(sheet[1], sheet[2], 2 / 3), along(sheet[0], sheet[3], 2 / 3)];
  const folds = [
    { points: third, color: PAPER.map((v) => v - 14) },
    { points: band(third[0], third[1], 3), color: PAPER.map((v) => v - 60) },
    { points: band(third[3], third[2], 3), color: PAPER.map((v) => v - 60) },
  ];
  const c = centreOf(sheet);
  // On a dark door the paper's colour alone outlines it; on a light door detection has to step over the creases.
  for (const doorColor of [[95, 60, 40], [195, 195, 192]]) {
    const image = renderSynth({
      width: 1536,
      height: 2048,
      background: WALL,
      shapes: [{ points: door, color: doorColor }, { points: sheet, color: PAPER }, ...folds],
      gradient: { angleDeg: 40, strength: 0.2 },
      blurSigma: 0.8,
      noiseSigma: 3,
    });
    const res = detectSheet(image, { x: c.x + 5, y: c.y + 8 });
    assert.ok(res.ok, res.reason);
    assert.equal(res.refined, true);
    assert.ok(Math.max(...cornerErrors(res.quad, sheet)) < 0.5, `door ${doorColor}`);
  }
});

test('detectSheet finds the sheet from a tap right on its edge, and still rejects a tap beside it', () => {
  const door = poseQuad({ cx: 770, cy: 1050, w: 620, h: 1540, yawDeg: 6, pitchDeg: -4 });
  const sheet = poseQuad({ cx: 760.4, cy: 800.7, w: 150, h: 212, rotDeg: 2, yawDeg: 6, pitchDeg: -4 });
  const c = centreOf(sheet);
  for (const doorColor of [DARK_DOOR, [150, 152, 150]]) {
    const image = doorScene({ width: 1536, height: 2048, door, sheet, doorColor, blurSigma: 0.9, noiseSigma: 3 });
    for (let e = 0; e < 4; e++) {
      const a = sheet[e];
      const b = sheet[(e + 1) % 4];
      for (const t of [0.2, 0.5, 0.8]) {
        const onEdge = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const reach = Math.hypot(c.x - onEdge.x, c.y - onEdge.y);
        const inwards = { x: (c.x - onEdge.x) / reach, y: (c.y - onEdge.y) / reach };
        // On its own, a tap this close to the edge reads a blend of paper and door and finds nothing.
        for (const inside of [1, 2.5, 4]) {
          const where = `door ${doorColor}, side ${e} at ${t}, ${inside} px in`;
          const res = detectSheet(image, { x: onEdge.x + inwards.x * inside, y: onEdge.y + inwards.y * inside });
          assert.ok(res.ok, `${where}: ${res.reason}`);
          assert.equal(res.refined, true, where);
          assert.ok(Math.max(...cornerErrors(res.quad, sheet)) < 0.5, where);
        }
        // A tap on the door beside the sheet is not on the sheet, however close a second look gets to it.
        const beside = detectSheet(image, { x: onEdge.x - inwards.x * 12, y: onEdge.y - inwards.y * 12 });
        assert.equal(beside.ok, false, `door ${doorColor}, side ${e} at ${t}, 12 px outside`);
        assert.equal(beside.quad, null);
      }
    }
  }
});

test('detectSheet does not call a coloured sheet refined when a side will only sit on its shadow', (t) => {
  const door = poseQuad({ cx: 600, cy: 800, w: 500, h: 1250, yawDeg: -7 });
  const truth = poseQuad({ cx: 603.3, cy: 640.8, w: 140, h: 198, rotDeg: -4, yawDeg: -7 });
  let heldBack = 0;
  let worst = 0;
  for (const [name, sheetColor] of Object.entries(COLOURED_SHEETS)) {
    for (const shadowPx of [4, 6]) {
      const image = renderSynth({
        width: 1200,
        height: 1600,
        background: [170, 160, 150],
        shapes: [{ points: door, color: PALE_DOOR }, ...shadowedSheetShapes(truth, sheetColor, shadowPx)],
        blurSigma: 0.9,
        noiseSigma: 2,
        seed: 5,
      });
      const what = `${name}, ${shadowPx} px shadow`;
      // With or without the luma plane the sheet screen hands over.
      for (const opts of [undefined, { luma: toLuma(image) }]) {
        const res = detectSheet(image, centreOf(truth), opts);
        assert.ok(res.ok, `${what}: ${res.reason}`);
        const error = maxCornerError(res.quad, truth);
        worst = Math.max(worst, error);
        // The sides are put back on the paper by colour, and the outline is offered as unrefined.
        assert.ok(error < 1.5, `${what}: corner ${error.toFixed(2)} px off the paper`);
        if (res.refined) continue;
        heldBack++;
        assert.equal(res.reason, 'off_sheet', what);
        assert.ok(res.confidence < 0.5, `${what}: confidence ${res.confidence}`);
      }
    }
  }
  t.diagnostic(`coloured sheet beside its shadow: ${heldBack} of 16 outlines held back as unrefined, worst corner ${worst.toFixed(2)} px off`);
  assert.ok(heldBack >= 12, `only ${heldBack} of 16 were held back`);
});

test('detectSheet does not call a pale or grey sheet refined when a side will only sit on its shadow', (t) => {
  // Lavender and light grey: their shadow is darker than the paper but close to it in colour.
  // (A pastel pink is too close to this door's colour to be outlined at all.)
  const door = poseQuad({ cx: 600, cy: 800, w: 500, h: 1250, yawDeg: -7 });
  const truth = poseQuad({ cx: 603.3, cy: 640.8, w: 140, h: 198, rotDeg: -4, yawDeg: -7 });
  let heldBack = 0;
  let worst = 0;
  for (const name of ['lavender', 'light grey']) {
    for (const shade of [0.6, 0.8]) {
      for (const shadowPx of [4, 6]) {
        const image = renderSynth({
          width: 1200,
          height: 1600,
          background: [170, 160, 150],
          shapes: [{ points: door, color: PALE_DOOR }, ...shadowedSheetShapes(truth, PALE_SHEETS[name], shadowPx, shade)],
          blurSigma: 0.9,
          noiseSigma: 2,
          seed: 5,
        });
        const what = `${name}, shadow x${shade}, ${shadowPx} px`;
        const res = detectSheet(image, centreOf(truth), { luma: toLuma(image) });
        assert.ok(res.ok, `${what}: ${res.reason}`);
        const error = maxCornerError(res.quad, truth);
        worst = Math.max(worst, error);
        assert.ok(error < 1.5, `${what}: corner ${error.toFixed(2)} px off the paper`);
        if (res.refined) continue;
        heldBack++;
        assert.equal(res.reason, 'off_sheet', what);
        assert.ok(res.confidence < 0.5, `${what}: confidence ${res.confidence}`);
      }
    }
  }
  t.diagnostic(`pale sheet beside its shadow: ${heldBack} of 8 outlines held back as unrefined, worst corner ${worst.toFixed(2)} px off`);
  assert.ok(heldBack >= 6, `only ${heldBack} of 8 were held back`);
});

test('detectSheet is not put off by a shadow line that misses the sheet, by shade over all of it, or by tape', () => {
  const door = poseQuad({ cx: 600, cy: 800, w: 520, h: 1300, yawDeg: 5 });
  const sheet = poseQuad({ cx: 601.3, cy: 650.6, w: 150, h: 212, rotDeg: 2, yawDeg: 5 });
  const c = centreOf(sheet);
  // The shadow's edge as a line a -> b, with the shade on its left.
  const level = (y) => [{ x: 0, y }, { x: 1200, y }];
  const upright = (x) => [{ x, y: 1600 }, { x, y: 0 }];
  const lines = {
    'line 8 px above the sheet': level(sheet[0].y - 8),
    'line 30 px above the sheet': level(sheet[0].y - 32),
    'line 8 px below the sheet (all of it in shade)': level(sheet[2].y + 8),
    'line 40 px below the sheet (all of it in shade)': level(sheet[2].y + 40),
    'upright line 8 px left of the sheet': upright(sheet[3].x - 8),
    'upright line 8 px right of the sheet (all of it in shade)': upright(sheet[1].x + 8),
  };
  for (const doorColor of [DARK_DOOR, [150, 152, 150]]) {
    const lit = doorScene({ width: 1200, height: 1600, door, sheet, doorColor, seed: 9 });
    for (const [name, [a, b]] of Object.entries(lines)) {
      const image = shadeBeyond({ ...lit, data: new Uint8ClampedArray(lit.data) }, a, b, 0.5);
      const res = detectSheet(image, c, { luma: toLuma(image) });
      const what = `door ${doorColor}, ${name}`;
      assert.ok(res.ok, `${what}: ${res.reason}`);
      assert.equal(res.refined, true, what);
      assert.ok(maxCornerError(res.quad, sheet) < 0.5, what);
    }
    // Tape across each corner, sticking out over the door: masking tape, parcel tape, duct tape, black tape.
    for (const tapeColor of [[225, 200, 120], [150, 105, 60], [150, 150, 150], [30, 30, 30]]) {
      const tape = sheet.map((p) => {
        const len = Math.hypot(p.x - c.x, p.y - c.y);
        const ux = (p.x - c.x) / len;
        const uy = (p.y - c.y) / len;
        const mx = p.x - ux * 3;
        const my = p.y - uy * 3;
        return { points: band({ x: mx + uy * 26, y: my - ux * 26 }, { x: mx - uy * 26, y: my + ux * 26 }, 18), color: tapeColor };
      });
      const image = renderSynth({
        width: 1200,
        height: 1600,
        background: WALL,
        shapes: [{ points: door, color: doorColor }, { points: sheet, color: PAPER }, ...tape],
        blurSigma: 0.8,
        noiseSigma: 3,
        seed: 9,
      });
      const res = detectSheet(image, c);
      const what = `tape ${tapeColor} on door ${doorColor}`;
      assert.ok(res.ok, `${what}: ${res.reason}`);
      assert.equal(res.refined, true, what);
      assert.ok(maxCornerError(res.quad, sheet) < 0.5, what);
    }
  }
});

test('detectSheet failure: no_region when the tap is outside the photo or the input is unusable; never throws', () => {
  const sheet = poseQuad({ cx: 400, cy: 300, w: 120, h: 170 });
  const image = doorScene({ width: 800, height: 600, sheet, wall: [90, 60, 40] });
  for (const seed of [{ x: -5, y: 300 }, { x: 400, y: 600 }, { x: 800, y: 10 }, { x: NaN, y: 300 }, null, undefined, {}]) {
    const res = detectSheet(image, seed);
    assert.deepEqual(res, { ok: false, quad: null, confidence: 0, refined: false, reason: 'no_region' });
  }
  for (const bad of [null, undefined, {}, { data: null, width: 10, height: 10 }, { data: new Uint8ClampedArray(0), width: 0, height: 0 }]) {
    const res = detectSheet(bad, { x: 1, y: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_region');
  }
});

test('detectSheet failure: touches_border when the sheet is cut off by the edge of the photo', () => {
  const sheet = poseQuad({ cx: 30, cy: 300, w: 120, h: 170, rotDeg: 3 });
  const image = doorScene({ width: 800, height: 600, sheet, wall: [90, 60, 40] });
  const res = detectSheet(image, { x: 45, y: 300 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'touches_border');
  assert.equal(res.quad, null);
});

test('detectSheet failure: too_large for a tap on the door, on the wall, or on a white sheet on a white door', () => {
  const door = poseQuad({ cx: 600, cy: 800, w: 520, h: 1300, yawDeg: 5 });
  const sheet = poseQuad({ cx: 600, cy: 650, w: 140, h: 198, rotDeg: 3, yawDeg: 5 });
  const image = doorScene({ width: 1200, height: 1600, door, sheet });
  // on the door
  assert.equal(detectSheet(image, { x: 600, y: 1150 }).reason, 'too_large');
  // on the wall
  const wall = detectSheet(image, { x: 60, y: 800 });
  assert.equal(wall.ok, false);
  assert.ok(wall.reason === 'too_large' || wall.reason === 'touches_border', wall.reason);

  // white sheet on a white door: the region floods the whole door
  const whiteOnWhite = doorScene({ width: 1200, height: 1600, door, sheet, doorColor: [236, 236, 231], sheetColor: [240, 240, 235], wall: [150, 140, 130] });
  const res = detectSheet(whiteOnWhite, centreOf(sheet));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'too_large');
  assert.equal(res.quad, null);

  // a door-sized region that does not reach the photo's border and covers more than 30% of it
  const island = doorScene({ width: 800, height: 600, door: poseQuad({ cx: 400, cy: 300, w: 420, h: 520 }), sheet: null });
  assert.equal(detectSheet(island, { x: 400, y: 300 }).reason, 'too_large');
});

test('detectSheet failure: too_small for a speck', () => {
  // 30 x 42 px in a 2000 x 1500 photo is about 0.04% of the image.
  const speck = poseQuad({ cx: 1000.5, cy: 800.5, w: 30, h: 42 });
  const image = doorScene({ width: 2000, height: 1500, sheet: speck, wall: [90, 60, 40], blurSigma: 0.6, noiseSigma: 2 });
  const res = detectSheet(image, { x: 1000, y: 800 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'too_small');
  assert.equal(res.quad, null);
});

test('detectSheet failure: not_quad for shapes that are not four-sided', () => {
  const base = { width: 800, height: 600, background: [90, 60, 40], blurSigma: 0.8, noiseSigma: 3 };
  // Each entry is a list of convex pieces drawn in the paper colour (the L needs two).
  const shapes = {
    disc: [disc(400, 300, 80)],
    triangle: [[{ x: 320, y: 220 }, { x: 480, y: 262 }, { x: 384, y: 388 }]],
    pentagon: [disc(400, 300, 78, 5)],
    'L shape': [
      [{ x: 330, y: 220 }, { x: 400, y: 220 }, { x: 400, y: 380 }, { x: 330, y: 380 }],
      [{ x: 400, y: 310 }, { x: 480, y: 310 }, { x: 480, y: 380 }, { x: 400, y: 380 }],
    ],
  };
  for (const [name, pieces] of Object.entries(shapes)) {
    const image = renderSynth({ ...base, shapes: pieces.map((points) => ({ points, color: PAPER })) });
    const res = detectSheet(image, { x: 380, y: 330 });
    assert.equal(res.ok, false, name);
    assert.equal(res.reason, 'not_quad', name);
    assert.equal(res.quad, null);
  }
});

test('detectSheet failure: cut_off when a hard shadow line runs across the sheet', () => {
  const door = poseQuad({ cx: 600, cy: 800, w: 520, h: 1300, yawDeg: 5 });
  const sheet = poseQuad({ cx: 601.3, cy: 650.6, w: 150, h: 212, rotDeg: 2, yawDeg: 5 });
  const tap = centreOf(sheet);
  const along = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  // The shadow's edge as a line a -> b right across the door, with the shade on its left: `share` of the
  // way down (level) or across (upright) the sheet.
  const across = (p, q) => [along(p, q, -3), along(p, q, 4)];
  const level = (share) => across(along(sheet[0], sheet[3], share), along(sheet[1], sheet[2], share));
  const upright = (share) => across(along(sheet[3], sheet[2], share), along(sheet[0], sheet[1], share));
  const flip = ([a, b]) => [b, a];
  const cuts = {
    'top 12% in shade': level(0.12),
    'top 25% in shade': level(0.25),
    'left 15% in shade': upright(0.15),
    // The tap lands on the shaded part when that is most of the sheet.
    'all but the bottom 15% in shade': level(0.85),
    'bottom 20% in shade': flip(level(0.8)),
  };
  for (const doorColor of [DARK_DOOR, [150, 152, 150], [186, 188, 190]]) {
    const lit = doorScene({ width: 1200, height: 1600, door, sheet, doorColor, seed: 9 });
    const shaded = ([a, b], factor) => shadeBeyond({ ...lit, data: new Uint8ClampedArray(lit.data) }, a, b, factor);
    for (const factor of [0.4, 0.6]) {
      for (const [name, line] of Object.entries(cuts)) {
        const image = shaded(line, factor);
        const res = detectSheet(image, tap, { luma: toLuma(image) });
        const what = `door ${doorColor}, shade x${factor}, ${name}`;
        assert.equal(res.ok, false, `${what}: outline accepted (refined ${res.refined}, confidence ${res.confidence})`);
        assert.equal(res.reason, 'cut_off', what);
        assert.equal(res.quad, null);
        assert.equal(res.refined, false);
      }
    }
    // Wherever else the line falls, an outline is never both called refined and wrong. (A sliver of under
    // about 5% of the sheet on a door close to the paper's colour is too little to go by.)
    for (const share of [0.06, 0.4, 0.6, 0.94]) {
      const image = shaded(level(share), 0.5);
      const res = detectSheet(image, tap, { luma: toLuma(image) });
      if (res.ok && res.refined) {
        const error = maxCornerError(res.quad, sheet);
        assert.ok(error < 1, `door ${doorColor}, top ${share * 100}% in shade: refined, yet ${error.toFixed(1)} px off`);
      }
    }
  }
});

test('detectSheet failure: cut_off for a coloured or dark sheet on a pale door with a shadow line across it', () => {
  // The sheet's own shadow sends its outline down the 'off_sheet' path, which must not skip the check
  // for a shadow line across the paper: put back on the paper, the outline is still only part of it.
  const door = poseQuad({ cx: 600, cy: 800, w: 500, h: 1250, yawDeg: -7 });
  const truth = poseQuad({ cx: 603.3, cy: 640.8, w: 140, h: 198, rotDeg: -4, yawDeg: -7 });
  const tap = centreOf(truth);
  const along = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const across = (p, q) => [along(p, q, -3), along(p, q, 4)];
  const level = (share) => across(along(truth[0], truth[3], share), along(truth[1], truth[2], share));
  const upright = (share) => across(along(truth[3], truth[2], share), along(truth[0], truth[1], share));
  const cuts = { 'top 12% in shade': level(0.12), 'top 25% in shade': level(0.25), 'left 15% in shade': upright(0.15) };
  const sheets = { ...COLOURED_SHEETS, navy: [28, 43, 85], 'light grey': PALE_SHEETS['light grey'] };
  for (const [name, sheetColor] of Object.entries(sheets)) {
    const lit = renderSynth({
      width: 1200,
      height: 1600,
      background: [170, 160, 150],
      shapes: [{ points: door, color: PALE_DOOR }, ...shadowedSheetShapes(truth, sheetColor, 4)],
      blurSigma: 0.9,
      noiseSigma: 2,
      seed: 5,
    });
    // Uncut, the same sheet is outlined (refined, or held back for checking), never refused.
    const whole = detectSheet(lit, tap, { luma: toLuma(lit) });
    assert.ok(whole.ok, `${name}, no shadow line: ${whole.reason}`);
    assert.ok(maxCornerError(whole.quad, truth) < 2, `${name}, no shadow line`);
    for (const [cut, [a, b]] of Object.entries(cuts)) {
      const image = shadeBeyond({ ...lit, data: new Uint8ClampedArray(lit.data) }, a, b, 0.5);
      const res = detectSheet(image, tap, { luma: toLuma(image) });
      const what = `${name}, ${cut}`;
      assert.equal(res.ok, false, `${what}: outline accepted (refined ${res.refined}, reason ${res.reason})`);
      assert.equal(res.reason, 'cut_off', what);
    }
  }
});

/* ------------------------------------------------------------------------------------------------------ */
/* warpToRect                                                                                             */
/* ------------------------------------------------------------------------------------------------------ */

test('warpToRect flattens the door plane: known rectangles land at the expected place and size', (t) => {
  const widthMm = 820;
  const heightMm = 2040;
  const plane = [{ x: 0, y: 0 }, { x: widthMm, y: 0 }, { x: widthMm, y: heightMm }, { x: 0, y: heightMm }];
  const doorPx = poseQuad({ cx: 610, cy: 800, w: 520, h: 1294, rotDeg: 2, yawDeg: 14, pitchDeg: -7 });
  const planeToImage = homographyFrom4(plane, doorPx);
  const sheetMm = [{ x: 300, y: 900 }, { x: 510, y: 900 }, { x: 510, y: 1197 }, { x: 300, y: 1197 }];
  const sheetPx = sheetMm.map((p) => applyH(planeToImage, p));
  const doorColor = [100, 64, 44];
  const image = renderSynth({
    width: 1200,
    height: 1600,
    background: WALL,
    shapes: [{ points: doorPx, color: doorColor }, { points: sheetPx, color: PAPER }],
  });

  const marginMm = 100;
  const out = warpToRect(image, planeToImage, { widthMm, heightMm, marginMm, outWidth: 510 });
  // (820 + 200) mm across 510 px = 2 mm per px, so (2040 + 200) mm is 1120 px.
  assert.equal(out.width, 510);
  assert.equal(out.height, 1120);
  assert.ok(out.data instanceof Uint8ClampedArray);
  assert.equal(out.data.length, 510 * 1120 * 4);

  const toOut = (p) => ({ x: (p.x + marginMm) / 2, y: (p.y + marginMm) / 2 });
  const near = (actual, expected, tol = 3) => actual.every((v, i) => Math.abs(v - expected[i]) <= tol);

  // Inside the sheet, on the door, and on the wall strip shown by the margin.
  assert.ok(near(pixelAt(out, 252, 574), [...PAPER, 255]), 'sheet interior');
  assert.ok(near(pixelAt(out, 100, 300), [...doorColor, 255]), 'door interior');
  assert.ok(near(pixelAt(out, 440, 1040), [...doorColor, 255]), 'door interior near the bottom-right');
  assert.ok(near(pixelAt(out, 20, 560), [...WALL, 255]), 'wall left of the door');
  assert.ok(near(pixelAt(out, 490, 560), [...WALL, 255]), 'wall right of the door');
  // Just inside / outside each door edge (door spans x 50..460, y 50..1070 in the output).
  assert.ok(near(pixelAt(out, 53, 560), [...doorColor, 255]));
  assert.ok(near(pixelAt(out, 46, 560), [...WALL, 255]));
  assert.ok(near(pixelAt(out, 456, 560), [...doorColor, 255]));
  assert.ok(near(pixelAt(out, 463, 560), [...WALL, 255]));
  assert.ok(near(pixelAt(out, 255, 53), [...doorColor, 255]));
  assert.ok(near(pixelAt(out, 255, 46), [...WALL, 255]));
  assert.ok(near(pixelAt(out, 255, 1066), [...doorColor, 255]));
  assert.ok(near(pixelAt(out, 255, 1073), [...WALL, 255]));

  // Sub-pixel check: the flattened sheet and door are axis-aligned rectangles at exactly the predicted place.
  const expectedSheet = sheetMm.map(toOut);
  const sheetFit = refineQuad(out, expectedSheet.map((p) => ({ x: p.x + 2, y: p.y - 2 })));
  assert.ok(sheetFit.ok, sheetFit.reason);
  const sheetErr = Math.max(...cornerErrors(sheetFit.quad, expectedSheet));
  const expectedDoor = plane.map(toOut);
  const doorFit = refineQuad(out, expectedDoor.map((p) => ({ x: p.x - 3, y: p.y + 2 })));
  assert.ok(doorFit.ok, doorFit.reason);
  const doorErr = Math.max(...cornerErrors(doorFit.quad, expectedDoor));
  t.diagnostic(`warp geometry: sheet corners within ${sheetErr.toFixed(3)} px, door corners within ${doorErr.toFixed(3)} px`);
  assert.ok(sheetErr < 0.35, `sheet corner error ${sheetErr}`);
  assert.ok(doorErr < 0.35, `door corner error ${doorErr}`);
  // 105 x 148.5 px for A4 at 2 mm per px
  assert.ok(Math.abs(Math.hypot(sheetFit.quad[1].x - sheetFit.quad[0].x, sheetFit.quad[1].y - sheetFit.quad[0].y) - 105) < 0.4);
  assert.ok(Math.abs(Math.hypot(sheetFit.quad[3].x - sheetFit.quad[0].x, sheetFit.quad[3].y - sheetFit.quad[0].y) - 148.5) < 0.4);

  // No margin: the output is exactly the door.
  const tight = warpToRect(image, planeToImage, { widthMm, heightMm, outWidth: 205 });
  assert.equal(tight.width, 205);
  assert.equal(tight.height, 510);
  assert.ok(near(pixelAt(tight, 2, 2), [...doorColor, 255], 6));
  assert.ok(near(pixelAt(tight, 202, 507), [...doorColor, 255], 6));
  assert.ok(near(pixelAt(tight, 101, 262), [...PAPER, 255]));

  // A homography is only defined up to scale (including sign).
  const flipped = warpToRect(image, planeToImage.map((v) => -3 * v), { widthMm, heightMm, marginMm, outWidth: 510 });
  assert.deepEqual(pixelAt(flipped, 252, 574), pixelAt(out, 252, 574));
  assert.deepEqual(pixelAt(flipped, 20, 560), pixelAt(out, 20, 560));
});

test('warpToRect leaves pixels outside the source photo fully transparent', () => {
  const widthMm = 820;
  const heightMm = 2040;
  const plane = [{ x: 0, y: 0 }, { x: widthMm, y: 0 }, { x: widthMm, y: heightMm }, { x: 0, y: heightMm }];
  // The door runs off the top and the left of this 600 x 800 photo.
  const doorPx = [{ x: -60, y: -90 }, { x: 420, y: -70 }, { x: 430, y: 700 }, { x: -50, y: 720 }];
  const planeToImage = homographyFrom4(plane, doorPx);
  const image = renderSynth({ width: 600, height: 800, background: [180, 170, 160], shapes: [{ points: doorPx, color: [90, 60, 40] }] });
  const out = warpToRect(image, planeToImage, { widthMm, heightMm, marginMm: 60, outWidth: 470 });
  assert.equal(out.width, 470);
  assert.equal(out.height, 1080);

  let transparent = 0;
  let opaque = 0;
  for (let v = 0; v < out.height; v++) {
    const Y = -60 + ((v + 0.5) * (heightMm + 120)) / out.height;
    for (let u = 0; u < out.width; u++) {
      const X = -60 + ((u + 0.5) * (widthMm + 120)) / out.width;
      const src = applyH(planeToImage, { x: X, y: Y });
      const alpha = out.data[(v * out.width + u) * 4 + 3];
      const inside = src.x >= 0 && src.x <= 600 && src.y >= 0 && src.y <= 800;
      // Skip the knife-edge pixels right on the photo's border.
      const margin = Math.min(src.x, 600 - src.x, src.y, 800 - src.y);
      if (Math.abs(margin) < 0.01) continue;
      if (inside) {
        opaque++;
        if (alpha !== 255) assert.fail(`pixel ${u},${v} maps inside the photo but has alpha ${alpha}`);
      } else {
        transparent++;
        const i = (v * out.width + u) * 4;
        if (alpha !== 0 || out.data[i] !== 0 || out.data[i + 1] !== 0 || out.data[i + 2] !== 0) {
          assert.fail(`pixel ${u},${v} maps outside the photo but is not transparent black`);
        }
      }
    }
  }
  assert.ok(transparent > 5000, `expected a transparent band, got ${transparent} px`);
  assert.ok(opaque > 100000);
  assert.deepEqual(pixelAt(out, 0, 0), [0, 0, 0, 0]);
  assert.equal(pixelAt(out, 300, 600)[3], 255);
});

/* ------------------------------------------------------------------------------------------------------ */
/* Speed on a full-size photo                                                                             */
/* ------------------------------------------------------------------------------------------------------ */

test('full-size photo (2560 x 1920): detect, refine and warp stay fast', (t) => {
  const door = poseQuad({ cx: 1280, cy: 980, w: 760, h: 1800, yawDeg: 5 });
  const sheet = poseQuad({ cx: 1270.3, cy: 760.6, w: 196, h: 277, rotDeg: -3, yawDeg: 5 });
  const image = doorScene({ width: 2560, height: 1920, door, sheet, blurSigma: 0, noiseSigma: 3 });
  const seed = centreOf(sheet);
  const time = (fn, runs) => {
    fn(); // warm-up
    const started = performance.now();
    for (let i = 0; i < runs; i++) fn();
    return (performance.now() - started) / runs;
  };

  const res = detectSheet(image, seed);
  assert.ok(res.ok && res.refined, res.reason);
  assert.ok(Math.max(...cornerErrors(res.quad, sheet)) < 0.5);

  const detectMs = time(() => detectSheet(image, seed), 5);
  const start = perturbQuad(sheet, 6, mulberry32(4));
  const refineMs = time(() => refineQuad(image, start), 10);
  const plane = [{ x: 0, y: 0 }, { x: 820, y: 0 }, { x: 820, y: 2040 }, { x: 0, y: 2040 }];
  const planeToImage = homographyFrom4(plane, door);
  let warped;
  const warpMs = time(() => {
    warped = warpToRect(image, planeToImage, { widthMm: 820, heightMm: 2040, marginMm: 80, outWidth: 720 });
  }, 3);
  t.diagnostic(`2560x1920 on this machine: detectSheet ${detectMs.toFixed(1)} ms, refineQuad ${refineMs.toFixed(2)} ms, warpToRect(720 x ${warped.height}) ${warpMs.toFixed(1)} ms`);
  // Phone targets are 300 / 50 / 150 ms; a desktop running the tests should be several times faster than
  // that, so these bounds only catch gross regressions without being flaky on a busy machine.
  assert.ok(detectMs < 300, `detectSheet took ${detectMs} ms`);
  assert.ok(refineMs < 50, `refineQuad took ${refineMs} ms`);
  assert.ok(warpMs < 150, `warpToRect took ${warpMs} ms`);
});
