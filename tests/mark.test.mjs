// The pure helpers the two mark screens (sheet and door) share, from js/screens/mark-common.js:
// what the sheet screen makes of a detection, when a corner press counts as a move, and how far
// the nudge pad is from the drawn outline.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearanceFromRect,
  outlineClearanceFromRect,
  sameQuad,
  sheetDetectionOutcome,
} from '../js/screens/mark-common.js';

const A4 = { w: 210, h: 297 };
const IMAGE = { width: 1920, height: 2560 };
const PLAUSIBLE = { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 };

/** An axis-aligned outline [TL, TR, BR, BL], `width` px wide with the given long-to-short ratio. */
function rectQuad(x, y, width, ratio = A4.h / A4.w) {
  const height = width * ratio;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

// About 110 px wide on a 2560 px tall photo: what an A4 sheet on a door that fills the photo looks like.
const SHEET = rectQuad(900, 1200, 110);

const outcome = (result, sheetMm = A4) => sheetDetectionOutcome(result, sheetMm, IMAGE.width, IMAGE.height, PLAUSIBLE);

describe('sheetDetectionOutcome', () => {
  test('a sub-pixel outline of the right shape and size, with confidence 0.7 or more, is found', () => {
    for (const confidence of [0.7, 0.85, 1]) {
      assert.equal(outcome({ ok: true, quad: SHEET, refined: true, confidence }), 'found', `confidence ${confidence}`);
    }
  });

  test('an outline detection is unsure of is kept for the customer to check', () => {
    assert.equal(outcome({ ok: true, quad: SHEET, refined: true, confidence: 0.69 }), 'check', 'low confidence');
    assert.equal(outcome({ ok: true, quad: SHEET, refined: true }), 'check', 'no confidence given');
    assert.equal(outcome({ ok: true, quad: SHEET, refined: true, confidence: NaN }), 'check', 'confidence not a number');
    for (const confidence of [0.2, 0.7, 0.99]) {
      assert.equal(outcome({ ok: true, quad: SHEET, refined: false, confidence }), 'check', `not refined, confidence ${confidence}`);
    }
    // js/vision.js puts a side that would sit on the sheet's shadow back on the paper by colour.
    assert.equal(outcome({ ok: true, quad: SHEET, refined: false, confidence: 0.4, reason: 'off_sheet' }), 'check');
  });

  test('nothing usable sends the customer to place the corners by hand', () => {
    assert.equal(outcome(null), 'manual');
    assert.equal(outcome(undefined), 'manual');
    for (const reason of ['no_region', 'touches_border', 'too_large', 'too_small', 'not_quad', 'cut_off']) {
      assert.equal(outcome({ ok: false, quad: null, refined: false, confidence: 0, reason }), 'manual', reason);
    }
    assert.equal(outcome({ ok: true, quad: SHEET.slice(0, 3), refined: true, confidence: 0.9 }), 'manual', 'three corners');
    assert.equal(outcome({ ok: true, quad: [...SHEET.slice(0, 3), { x: NaN, y: 0 }], refined: true, confidence: 0.9 }), 'manual', 'a corner that is not a number');
  });

  test('an outline the wrong size or shape for the chosen sheet is not taken for it', () => {
    const found = (quad) => outcome({ ok: true, quad, refined: true, confidence: 0.95 });
    assert.equal(found(rectQuad(400, 400, 700)), 'manual', 'far too big: a door panel');
    assert.equal(found(rectQuad(950, 1300, 20)), 'manual', 'far too small: a lock plate');
    assert.equal(found(rectQuad(900, 1200, 140, 1)), 'manual', 'square, where A4 is 1.41 to 1');
    assert.equal(found(rectQuad(900, 1200, 70, 3)), 'manual', 'a long strip');
    // The same outline is the right shape for a sheet of those proportions.
    assert.equal(outcome({ ok: true, quad: rectQuad(900, 1200, 140, 1), refined: true, confidence: 0.95 }, { w: 200, h: 200 }), 'found');
  });

  test('a sheet lying on its side is the same sheet', () => {
    const sideways = rectQuad(900, 1200, 110 * (A4.h / A4.w), A4.w / A4.h);
    assert.equal(outcome({ ok: true, quad: sideways, refined: true, confidence: 0.9 }), 'found');
    assert.equal(outcome({ ok: true, quad: SHEET, refined: true, confidence: 0.9 }, { w: A4.h, h: A4.w }), 'found');
  });
});

describe('sameQuad', () => {
  test('is true for the same four points in the same order, whatever the objects', () => {
    const copy = SHEET.map((p) => ({ ...p }));
    assert.equal(sameQuad(SHEET, copy), true);
    assert.equal(sameQuad(SHEET, SHEET), true);
  });

  test('is false for a reordered outline or any corner moved, however little', () => {
    assert.equal(sameQuad(SHEET, [SHEET[1], SHEET[2], SHEET[3], SHEET[0]]), false, 'same corners, another order');
    for (let i = 0; i < 4; i += 1) {
      const moved = SHEET.map((p, j) => (j === i ? { x: p.x + 0.001, y: p.y } : { ...p }));
      assert.equal(sameQuad(SHEET, moved), false, `corner ${i} moved 0.001 px`);
    }
  });

  test('is false unless both are four finite points', () => {
    assert.equal(sameQuad(SHEET.slice(0, 3), SHEET.slice(0, 3)), false);
    assert.equal(sameQuad(null, SHEET), false);
    assert.equal(sameQuad(SHEET, undefined), false);
    assert.equal(sameQuad(null, null), false);
    const broken = [...SHEET.slice(0, 3), { x: NaN, y: 1 }];
    assert.equal(sameQuad(broken, broken), false);
  });
});

describe('outlineClearanceFromRect', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  test('is 0 when a side runs through the rectangle, though every corner is well clear of it', () => {
    const acrossTopSide = { left: 45, right: 55, top: -5, bottom: 5 };
    assert.equal(clearanceFromRect(square, acrossTopSide), 45);
    assert.equal(outlineClearanceFromRect(square, acrossTopSide), 0);
  });

  test('off a corner it is the distance to that corner', () => {
    const offCorner = { left: 110, right: 120, top: 110, bottom: 120 };
    assert.ok(Math.abs(outlineClearanceFromRect(square, offCorner) - Math.hypot(10, 10)) < 1e-9);
    assert.equal(outlineClearanceFromRect(square, offCorner), clearanceFromRect(square, offCorner));
  });

  test('off the middle of a side it is the distance to that side', () => {
    assert.equal(outlineClearanceFromRect(square, { left: 40, right: 60, top: 130, bottom: 150 }), 30);
  });

  test('handles dragged past each other give the outline the editor draws, not a bow-tie', () => {
    // Bottom corners swapped: joined in index order this is a bow-tie through the middle.
    const crossed = [square[0], square[1], square[3], square[2]];
    const middle = { left: 45, right: 55, top: 45, bottom: 55 };
    assert.equal(outlineClearanceFromRect(crossed, middle), outlineClearanceFromRect(square, middle));
    assert.equal(outlineClearanceFromRect(crossed, middle), 45);
    for (const rect of [{ left: 45, right: 55, top: -5, bottom: 5 }, { left: 110, right: 120, top: 110, bottom: 120 }]) {
      assert.equal(outlineClearanceFromRect(crossed, rect), outlineClearanceFromRect(square, rect));
    }
  });

  test('is never more than the distance to the nearest corner', () => {
    for (const rect of [
      { left: -30, right: -10, top: 40, bottom: 60 },
      { left: 30, right: 70, top: 30, bottom: 70 },
      { left: 200, right: 210, top: -50, bottom: -40 },
    ]) {
      assert.ok(outlineClearanceFromRect(square, rect) <= clearanceFromRect(square, rect), JSON.stringify(rect));
    }
  });

  test('is Infinity with no points, and the corner distance with only one', () => {
    const rect = { left: 0, right: 10, top: 0, bottom: 10 };
    assert.equal(outlineClearanceFromRect([], rect), Infinity);
    assert.equal(outlineClearanceFromRect([{ x: 13, y: 14 }], rect), 5);
  });
});
