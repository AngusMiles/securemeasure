// The pure helpers the two mark screens (sheet and door) share, from js/screens/mark-common.js:
// what the sheet screen makes of a detection, when a corner press counts as a move, and how far
// the nudge pad is from the drawn outline; and the door screen's own decisions: who may enter it,
// what its banner says, when its corners count as placed and which outline comes next.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  canEnterDoor,
  clearanceFromRect,
  cornersInOutlineOrder,
  doorBannerKind,
  doorCornersPlaced,
  doorOutlines,
  invalidateMeasurement,
  nextOutlineIndex,
  outlineClearanceFromRect,
  outlineIndexOf,
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

// ---------- door screen ----------

// A door opening in a 1536 x 2048 photo, [TL, TR, BR, BL], and the two outlines detection typically
// confuses it with: the outer trim (wider and taller) and the door plus a glass panel above it.
const DOOR = [
  { x: 520, y: 300 },
  { x: 1010, y: 310 },
  { x: 1000, y: 1700 },
  { x: 515, y: 1690 },
];
const TRIM = [
  { x: 440, y: 220 },
  { x: 1090, y: 230 },
  { x: 1080, y: 1705 },
  { x: 435, y: 1695 },
];
const TRANSOM = [
  { x: 520, y: 80 },
  { x: 1010, y: 90 },
  { x: 1000, y: 1700 },
  { x: 515, y: 1690 },
];
const copy = (quad) => quad.map((p) => ({ ...p }));

describe('canEnterDoor', () => {
  const photo = { width: 1536, height: 2048 };
  const sheet = { points: rectQuad(900, 1200, 110), refined: true, detected: true };

  test('the no-paper estimate needs only a photo', () => {
    assert.equal(canEnterDoor({ method: 'estimate', photo, sheet: { points: null } }), true);
    assert.equal(canEnterDoor({ method: 'estimate', photo: null, sheet }), false);
  });

  test('never after an AR measurement, which goes straight to the result', () => {
    assert.equal(canEnterDoor({ method: 'ar', photo, sheet }), false);
    assert.equal(canEnterDoor({ method: 'ar', photo: null, sheet: { points: null } }), false);
  });

  test('the paper method, or no method at all, needs a photo and a placed sheet', () => {
    for (const method of ['paper', null, undefined]) {
      assert.equal(canEnterDoor({ method, photo, sheet }), true, `${method}: marked sheet`);
      assert.equal(canEnterDoor({ method, photo: null, sheet }), false, `${method}: no photo`);
      assert.equal(canEnterDoor({ method, photo, sheet: { points: null } }), false, `${method}: no sheet`);
      assert.equal(canEnterDoor({ method, photo, sheet: { ...sheet, placed: false } }), false, `${method}: stand-in rectangle`);
      assert.equal(canEnterDoor({ method, photo, sheet: { ...sheet, placed: true } }), true, `${method}: stand-in moved`);
      assert.equal(canEnterDoor({ method, photo, sheet: { points: sheet.points.slice(0, 3) } }), false, `${method}: three corners`);
    }
    const old = { photo, sheet };
    assert.equal(canEnterDoor(old), true, 'a state from before `method` existed');
  });

  test('is false for no state', () => {
    assert.equal(canEnterDoor(null), false);
    assert.equal(canEnterDoor(undefined), false);
  });
});

describe('doorOutlines', () => {
  test('the detected quad first, then its alternatives', () => {
    const outlines = doorOutlines({ ok: true, quad: DOOR, confidence: 0.4, alternatives: [TRIM, TRANSOM] });
    assert.equal(outlines.length, 3);
    assert.ok(sameQuad(outlines[0], DOOR));
    assert.ok(sameQuad(outlines[1], TRIM));
    assert.ok(sameQuad(outlines[2], TRANSOM));
  });

  test('hands out copies, so moving a handle never changes the detection', () => {
    const detection = { ok: true, quad: copy(DOOR), alternatives: [copy(TRIM)] };
    const outlines = doorOutlines(detection);
    outlines[0][0].x += 50;
    outlines[1][2].y -= 50;
    assert.ok(sameQuad(detection.quad, DOOR));
    assert.ok(sameQuad(detection.alternatives[0], TRIM));
  });

  test('leaves out broken alternatives and repeats of an outline already listed', () => {
    const outlines = doorOutlines({
      ok: true,
      quad: DOOR,
      alternatives: [copy(DOOR), TRIM.slice(0, 3), null, [...TRIM.slice(0, 3), { x: NaN, y: 1 }], copy(TRIM), copy(TRIM)],
    });
    assert.equal(outlines.length, 2);
    assert.ok(sameQuad(outlines[1], TRIM));
  });

  test("given the photo's size, corners are kept inside it, as the handles are", () => {
    const outside = [
      { x: -2.5, y: 300 },
      { x: 1540, y: -1 },
      { x: 1000, y: 2050 },
      { x: 515, y: 1690 },
    ];
    const [outline] = doorOutlines({ ok: true, quad: outside }, { width: 1536, height: 2048 });
    assert.deepEqual(outline, [
      { x: 0, y: 300 },
      { x: 1536, y: 0 },
      { x: 1000, y: 2048 },
      { x: 515, y: 1690 },
    ]);
    // The handles the editor puts on that outline are recognised as sitting on it.
    assert.equal(outlineIndexOf([outline], outline.map((p) => ({ ...p }))), 0);
    // Alternatives that only differ outside the photo are the same outline once clamped.
    const twin = [{ x: -10, y: 300 }, { x: 1600, y: -7 }, { x: 1000, y: 2100 }, { x: 515, y: 1690 }];
    const twins = doorOutlines({ ok: true, quad: DOOR, alternatives: [outside, twin] }, { width: 1536, height: 2048 });
    assert.equal(twins.length, 2);
    // Without a size nothing is clamped.
    assert.deepEqual(doorOutlines({ ok: true, quad: outside })[0], outside);
  });

  test('a detection with no alternatives offers just its own outline', () => {
    assert.equal(doorOutlines({ ok: true, quad: DOOR }).length, 1);
    assert.equal(doorOutlines({ ok: true, quad: DOOR, alternatives: [] }).length, 1);
    assert.equal(doorOutlines({ ok: true, quad: DOOR, alternatives: 'none' }).length, 1);
  });

  test('nothing found, a failed or timed-out search, or no search yet offers none', () => {
    assert.deepEqual(doorOutlines(null), []);
    assert.deepEqual(doorOutlines(undefined), []);
    for (const reason of ['no_lines', 'no_candidate', 'timeout']) {
      assert.deepEqual(doorOutlines({ ok: false, quad: null, confidence: 0, alternatives: [], reason }), [], reason);
    }
    // Alternatives of a detection that found nothing are not offered on their own.
    assert.deepEqual(doorOutlines({ ok: false, quad: null, alternatives: [TRIM] }), []);
    assert.deepEqual(doorOutlines({ ok: true, quad: DOOR.slice(0, 3), alternatives: [TRIM] }), []);
  });
});

describe('outlineIndexOf', () => {
  const outlines = [DOOR, TRIM, TRANSOM];

  test('finds the outline the handles sit on exactly', () => {
    assert.equal(outlineIndexOf(outlines, copy(DOOR)), 0);
    assert.equal(outlineIndexOf(outlines, copy(TRANSOM)), 2);
  });

  test('is -1 for corners the customer moved, the fallback rectangle, or nothing', () => {
    const moved = copy(TRIM);
    moved[1].x += 0.5;
    assert.equal(outlineIndexOf(outlines, moved), -1);
    assert.equal(outlineIndexOf(outlines, rectQuad(300, 200, 900, 2)), -1);
    assert.equal(outlineIndexOf(outlines, null), -1);
    assert.equal(outlineIndexOf([], copy(DOOR)), -1);
    assert.equal(outlineIndexOf(null, copy(DOOR)), -1);
  });
});

describe('nextOutlineIndex', () => {
  test('steps through every outline and round to the first again', () => {
    const seen = [];
    let index = 0;
    for (let i = 0; i < 6; i += 1) {
      index = nextOutlineIndex(index, 3);
      seen.push(index);
    }
    assert.deepEqual(seen, [1, 2, 0, 1, 2, 0]);
  });

  test("from the customer's own corners or the fallback rectangle it starts at the detected outline", () => {
    assert.equal(nextOutlineIndex(-1, 3), 0);
    assert.equal(nextOutlineIndex(null, 3), 0);
    assert.equal(nextOutlineIndex(undefined, 2), 0);
    assert.equal(nextOutlineIndex(7, 3), 0, 'an index that no longer exists');
  });

  test('with one outline it stays on it, and with none there is nowhere to go', () => {
    assert.equal(nextOutlineIndex(0, 1), 0);
    assert.equal(nextOutlineIndex(-1, 1), 0);
    assert.equal(nextOutlineIndex(0, 0), -1);
    assert.equal(nextOutlineIndex(-1, NaN), -1);
  });
});

describe('doorCornersPlaced', () => {
  test('the untouched starting rectangle is not placed', () => {
    assert.equal(doorCornersPlaced({}), false);
    assert.equal(doorCornersPlaced(), false);
    assert.equal(doorCornersPlaced({ moved: false, chosen: false, confident: false, outline: -1 }), false);
  });

  test('an outline detection was unsure of is only a starting position', () => {
    assert.equal(doorCornersPlaced({ confident: false, outline: 0 }), false);
  });

  test('the outline detection was confident of counts as placed while the handles are on it', () => {
    assert.equal(doorCornersPlaced({ confident: true, outline: 0 }), true);
    // Confident, but the handles are not on that outline (it arrived after the customer started).
    assert.equal(doorCornersPlaced({ confident: true, outline: -1 }), false);
    assert.equal(doorCornersPlaced({ confident: true }), false);
  });

  test('a moved corner or a chosen outline counts as placed, whatever detection thought', () => {
    for (const confident of [true, false]) {
      assert.equal(doorCornersPlaced({ moved: true, confident, outline: -1 }), true);
      assert.equal(doorCornersPlaced({ chosen: true, confident, outline: 2 }), true);
      assert.equal(doorCornersPlaced({ chosen: true, confident, outline: 0 }), true);
    }
  });

  test('only a real true counts', () => {
    assert.equal(doorCornersPlaced({ moved: 1, chosen: 'yes', confident: 1, outline: 0 }), false);
  });
});

describe('doorBannerKind', () => {
  test('says it is looking while findDoor runs, whatever else is known', () => {
    assert.equal(doorBannerKind({ searching: true }), 'searching');
    assert.equal(doorBannerKind({ searching: true, confident: true, outline: 0, outlines: 3 }), 'searching');
  });

  test('says the door was found only for a confident outline the handles start on', () => {
    assert.equal(doorBannerKind({ confident: true, outline: 0, outlines: 1 }), 'found');
    assert.equal(doorBannerKind({ confident: true, outline: 0, outlines: 3 }), 'found');
    assert.equal(doorBannerKind({ confident: false, outline: 0, outlines: 3 }), 'place', 'not confident');
    assert.equal(doorBannerKind({ confident: true, outline: -1, outlines: 3 }), 'place', "the customer's own corners");
    assert.equal(doorBannerKind({ confident: true, outline: 0, outlines: 0 }), 'place', 'no outline to be on');
  });

  test('counts the outlines once the customer steps through them', () => {
    for (const outline of [0, 1, 2]) {
      assert.equal(doorBannerKind({ chosen: true, confident: true, outline, outlines: 3 }), 'outline', `outline ${outline}`);
      assert.equal(doorBannerKind({ chosen: true, confident: false, outline, outlines: 3 }), 'outline', `outline ${outline}`);
    }
    // With a single outline there is nothing to count.
    assert.equal(doorBannerKind({ chosen: true, confident: true, outline: 0, outlines: 1 }), 'found');
    assert.equal(doorBannerKind({ chosen: true, outline: 5, outlines: 3 }), 'place', 'an outline that does not exist');
  });

  test('otherwise asks the customer to place the corners', () => {
    assert.equal(doorBannerKind(), 'place');
    assert.equal(doorBannerKind({}), 'place');
    assert.equal(doorBannerKind({ outline: -1, outlines: 0 }), 'place', 'nothing found');
  });
});

describe('cornersInOutlineOrder', () => {
  test('a quad already in order is unchanged, as copies', () => {
    const ordered = cornersInOutlineOrder(DOOR);
    assert.ok(sameQuad(ordered, DOOR));
    assert.notEqual(ordered[0], DOOR[0]);
  });

  test('handles dragged past each other give the drawn outline from its top-left corner', () => {
    // The customer put handle 0 on the bottom-right corner and handle 2 on the top-left one.
    const swapped = [DOOR[2], DOOR[1], DOOR[0], DOOR[3]];
    assert.ok(sameQuad(cornersInOutlineOrder(swapped), DOOR));
    // Bottom corners crossed over: joined in handle order this would be a bow-tie.
    const crossed = [DOOR[0], DOOR[1], DOOR[3], DOOR[2]];
    assert.ok(sameQuad(cornersInOutlineOrder(crossed), DOOR));
    // Every handle one corner round: the width would otherwise be read as the height.
    for (let k = 1; k < 4; k += 1) {
      const rotated = [...DOOR.slice(k), ...DOOR.slice(0, k)];
      assert.ok(sameQuad(cornersInOutlineOrder(rotated), DOOR), `rotated by ${k}`);
    }
    const anticlockwise = [DOOR[0], DOOR[3], DOOR[2], DOOR[1]];
    assert.ok(sameQuad(cornersInOutlineOrder(anticlockwise), DOOR), 'anticlockwise');
  });

  test('a door photographed on a slight angle still starts at its top-left corner', () => {
    const tilted = [
      { x: 600, y: 260 },
      { x: 1080, y: 420 },
      { x: 960, y: 1800 },
      { x: 470, y: 1640 },
    ];
    assert.ok(sameQuad(cornersInOutlineOrder([tilted[3], tilted[2], tilted[1], tilted[0]]), tilted));
  });

  test('anything but four finite points comes back as it was', () => {
    assert.deepEqual(cornersInOutlineOrder(DOOR.slice(0, 3)), DOOR.slice(0, 3));
    assert.deepEqual(cornersInOutlineOrder(null), []);
  });
});

describe('invalidateMeasurement', () => {
  const measured = (size) => ({ measure: { ok: true }, size });

  test('a moved corner drops the paper measurement and the standard-size estimate', () => {
    for (const source of ['photo', 'estimate']) {
      const state = measured({ widthMm: 820, heightMm: 2040, source, standard: source === 'estimate' });
      invalidateMeasurement(state);
      assert.equal(state.measure, null, source);
      assert.equal(state.size, null, source);
    }
  });

  test('a size the customer typed in, or one from AR, stays', () => {
    for (const source of ['manual', 'ar']) {
      const size = { widthMm: 812, heightMm: 2035, source };
      const state = measured(size);
      invalidateMeasurement(state);
      assert.equal(state.measure, null, source);
      assert.equal(state.size, size, source);
    }
    const state = measured(null);
    invalidateMeasurement(state);
    assert.equal(state.size, null);
  });
});
