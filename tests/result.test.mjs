// The result screen's one piece of pure logic, from js/screens/result.js: when a 'poor' result is
// shown as "Check your photo" because the sheet could be either way round, rather than as an
// ordinary "Rough measurement".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { measureDoor, QUALITY_THRESHOLDS } from '../js/geometry.js';
import { orientationUnclear } from '../js/screens/result.js';
import { SHIPPED_CONFIG } from './helpers/shipped-config.mjs';
import { mulberry32 } from './helpers/synth.mjs';

const IMAGE = { width: 1920, height: 2560 };
const A4 = { w: 210, h: 297 };
const LETTER = { w: 215.9, h: 279.4 };
const CARD = { w: 85.6, h: 53.98 };

// What measureDoor leaves behind when it could not decide which way round the sheet is.
const undecided = { widthMm: 829, heightMm: 2024, quality: { level: 'poor', issues: ['high_uncertainty'] }, fit: { orientationMargin: 0.1 } };
const flags = (measure, sheetMm) => orientationUnclear(measure, measure.quality.level, measure.quality.issues, sheetMm);

test('an undecided orientation is flagged when the two possible sizes are far apart', () => {
  for (const sheetMm of [A4, LETTER, CARD, { w: 210, h: 220 }]) {
    assert.equal(flags(undecided, sheetMm), true, `${sheetMm.w} x ${sheetMm.h}`);
  }
  // Without a sheet size to go by, the cautious answer.
  assert.equal(flags(undecided, undefined), true);
  // The measurement can also name the problem itself.
  const named = { ...undecided, quality: { level: 'poor', issues: ['orientation_unclear'] }, fit: { orientationMargin: 50 } };
  assert.equal(flags(named, { w: 300, h: 302 }), true);
});

test('a decided orientation, or a result that is not wide, is never flagged', () => {
  const decided = { ...undecided, fit: { orientationMargin: QUALITY_THRESHOLDS.orientationMinMargin + 1 } };
  assert.equal(flags(decided, A4), false);
  assert.equal(flags({ ...undecided, fit: { orientationMargin: null } }, A4), false);
  assert.equal(flags({ ...undecided, quality: { level: 'fair', issues: ['high_uncertainty'] } }, A4), false);
  assert.equal(flags({ ...undecided, quality: { level: 'poor', issues: [] } }, A4), false);
});

test('a nearly square sheet placed by hand is a rough measurement, not a photo to retake', () => {
  // A customer's own 300 x 302 mm reference, sheet corners placed by hand. Neither way round can win,
  // but the two readings are only about 5 x 14 mm apart: the wide "plus or minus" comes from the
  // hand-placed corners, and a retake could not settle the orientation anyway.
  const sheetMm = { w: 300, h: 302 };
  const m = SHIPPED_CONFIG.measurement;
  const P = cameraHomography({ imageWidth: IMAGE.width, imageHeight: IMAGE.height, focalPx: 0.72 * 2560, target: { x: 410, y: 1020 }, distanceMm: 2600, yawDeg: 3, pitchDeg: -2 });
  const doorPx = [{ x: 0, y: 0 }, { x: 820, y: 0 }, { x: 820, y: 2040 }, { x: 0, y: 2040 }].map((p) => projectPoint(P, p));
  const sheetPx = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => projectPoint(P, { x: 410 + (sx * sheetMm.w) / 2, y: 1100 + (sy * sheetMm.h) / 2 }));
  const rand = mulberry32(5);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const noise = (pts, s) => pts.map((p) => ({ x: p.x + s * gauss(), y: p.y + s * gauss() }));
  const measure = measureDoor({
    sheetPx: noise(sheetPx, m.sigmaSheetManualPx),
    doorPx: noise(doorPx, m.sigmaDoorPx),
    sheetMm,
    imageSize: IMAGE,
    sigmaSheetPx: m.sigmaSheetManualPx,
    sigmaDoorPx: m.sigmaDoorPx,
  });
  assert.equal(measure.ok, true);
  // The case in point: graded poor for a wide sigma, with the orientation undecided.
  assert.equal(measure.quality.level, 'poor');
  assert.ok(measure.quality.issues.includes('high_uncertainty'));
  assert.ok(measure.fit.orientationMargin < QUALITY_THRESHOLDS.orientationMinMargin, `margin ${measure.fit.orientationMargin}`);
  assert.equal(flags(measure, sheetMm), false);
  // The same corners read against an A4 sheet would be a coin flip between two very different sizes.
  assert.equal(flags(measure, A4), true);
});
