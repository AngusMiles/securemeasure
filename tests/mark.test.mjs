// The pure helpers the two mark screens (sheet and door) share, from js/screens/mark-common.js:
// what the sheet screen makes of a detection, when a corner press counts as a move, and how far
// the nudge pad is from the drawn outline; and the door screen's own decisions: who may enter it,
// what its banner says, when its corners count as placed and which outline comes next. Last, the
// door screen itself (js/screens/door.js) mounted on a stand-in DOM with the real corner editor, for
// what those helpers cannot show alone: its background search for the door, and what the customer's
// presses on the photo meanwhile do to it.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  canEnterDoor,
  clearanceFromRect,
  cornersByHand,
  cornersInOutlineOrder,
  doorBannerKind,
  doorCornerSigmaPx,
  doorCornersPlaced,
  doorOutlines,
  invalidateMeasurement,
  isPhotoTarget,
  isSettledDetection,
  markCornersByHand,
  nextOutlineIndex,
  outlineClearanceFromRect,
  outlineIndexOf,
  pressGate,
  sameQuad,
  sheetDetectionOutcome,
} from '../js/screens/mark-common.js';
import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { measureDoor } from '../js/geometry.js';
import { QuadEditor, fitView, imageToScreen, viewsEqual } from '../js/editor.js';
import { startingQuad } from '../js/door-find.js';
import * as doorScreen from '../js/screens/door.js';
import { SHIPPED_CONFIG } from './helpers/shipped-config.mjs';

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

  test('a head sloping past 45 degrees still starts at its top-left corner, not the one nearest the photo corner', () => {
    // An 820 x 2040 opening 1.8 m away, seen 40 deg off to the side and 20 deg from below, the phone rolled
    // 15 deg, in a 1920 x 2560 photo. The far end of the head (top-right) has the smaller x + y, so starting
    // from the photo's top-left corner read every placement a corner round: 0.40 high-to-wide, non-standard.
    const steep = [
      { x: 536, y: 672 },
      { x: 992, y: 173 },
      { x: 1804, y: 2490 },
      { x: 924, y: 2519 },
    ];
    assert.ok(steep[1].x + steep[1].y < steep[0].x + steep[0].y, 'the case the old rule got wrong');
    // The same door the other way round: seen from the other side, the phone rolled the other way.
    const mirrored = [steep[1], steep[0], steep[3], steep[2]].map((p) => ({ x: 1920 - p.x, y: p.y }));
    for (const [name, quad] of [['steep', steep], ['mirrored', mirrored]]) {
      for (let k = 0; k < 4; k += 1) {
        const rotated = [...quad.slice(k), ...quad.slice(0, k)];
        assert.ok(sameQuad(cornersInOutlineOrder(rotated), quad), `${name}, rotated by ${k}`);
        assert.ok(sameQuad(cornersInOutlineOrder([...rotated].reverse()), quad), `${name}, rotated by ${k}, anticlockwise`);
      }
    }
  });

  test('every pose with the whole opening in the photo gives the opening from its top-left corner', () => {
    const W = 1920;
    const H = 2560;
    // A 26 mm-equivalent phone lens on this photo.
    const focalPx = (26 / Math.hypot(36, 24)) * Math.hypot(W, H);
    let poses = 0;
    for (const [w, h] of [[820, 2040], [920, 2340]]) {
      for (const distanceMm of [1800, 2500]) {
        for (let yawDeg = -55; yawDeg <= 55; yawDeg += 5) {
          for (let pitchDeg = -15; pitchDeg <= 20; pitchDeg += 5) {
            for (let rollDeg = -20; rollDeg <= 20; rollDeg += 5) {
              const Hm = cameraHomography({
                imageWidth: W,
                imageHeight: H,
                focalPx,
                target: { x: w / 2, y: h / 2 },
                distanceMm,
                yawDeg,
                pitchDeg,
                rollDeg,
              });
              const truth = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => projectPoint(Hm, { x, y }));
              if (truth.some((p) => !(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H))) continue;
              poses += 1;
              const handles = [truth[2], truth[0], truth[3], truth[1]];
              const pose = `${w}x${h} ${distanceMm}/${yawDeg}/${pitchDeg}/${rollDeg}`;
              assert.ok(sameQuad(cornersInOutlineOrder(handles), truth), pose);
            }
          }
        }
      }
    }
    assert.ok(poses > 1000, `${poses} poses`);
  });

  test('anything but four finite points comes back as it was', () => {
    assert.deepEqual(cornersInOutlineOrder(DOOR.slice(0, 3)), DOOR.slice(0, 3));
    assert.deepEqual(cornersInOutlineOrder(null), []);
  });
});

describe('isSettledDetection', () => {
  test('anything detection settled on is kept for the photo, found or not', () => {
    assert.equal(isSettledDetection({ ok: true, quad: DOOR, confidence: 0.9, alternatives: [] }), true);
    for (const reason of ['no_lines', 'no_candidate', 'no_candidate_at_hint', 'bad_input', 'error']) {
      assert.equal(isSettledDetection({ ok: false, quad: null, confidence: 0, alternatives: [], reason }), true, reason);
    }
  });

  test('a search that ran out of time is looked for again, like no search at all', () => {
    // findDoor's answer when its timer fired: on a cold worker or a weak signal, not a verdict on the photo.
    assert.equal(isSettledDetection({ ok: false, quad: null, confidence: 0, alternatives: [], reason: 'timeout' }), false);
    assert.equal(isSettledDetection(null), false);
    assert.equal(isSettledDetection(undefined), false);
    assert.equal(isSettledDetection('timeout'), false);
  });
});

describe('where the door corners came from', () => {
  const PHOTO = { imageWidth: 1536, imageHeight: 2048 };
  const NONE = [false, false, false, false];
  const ALL = [true, true, true, true];

  test('cornersByHand reads four booleans, and anything else as none', () => {
    assert.deepEqual(cornersByHand(null), NONE);
    assert.deepEqual(cornersByHand(undefined), NONE);
    assert.deepEqual(cornersByHand([true, true, true]), NONE);
    assert.deepEqual(cornersByHand([true, 1, 'yes', false]), [true, false, false, false]);
    const saved = [true, false, true, false];
    const read = cornersByHand(saved);
    assert.deepEqual(read, saved);
    assert.notEqual(read, saved, 'a fresh array');
  });

  test('markCornersByHand marks the handles that moved and keeps the ones already placed', () => {
    const before = copy(DOOR);
    const after = copy(DOOR);
    after[2].x += 4;
    assert.deepEqual(markCornersByHand(NONE, before, after), [false, false, true, false]);
    assert.deepEqual(markCornersByHand([true, false, false, false], before, after), [true, false, true, false]);
    assert.deepEqual(markCornersByHand([true, false, false, false], before, copy(DOOR)), [true, false, false, false], 'nothing moved');
    assert.deepEqual(markCornersByHand(NONE, null, after), NONE, 'no quad to compare with');
    assert.deepEqual(markCornersByHand(NONE, before, after.slice(0, 3)), NONE);
    const byHand = [...NONE];
    markCornersByHand(byHand, before, after);
    assert.deepEqual(byHand, NONE, 'the input is left as it was');
  });

  test("corners all placed by hand are measured with the hand's error", () => {
    assert.equal(doorCornerSigmaPx({ byHand: ALL, handSigmaPx: 2.5, ...PHOTO }), 2.5);
    // No hand sigma given (the estimate keeps its own): nothing is passed, so its default applies.
    assert.equal(doorCornerSigmaPx({ byHand: ALL, ...PHOTO }), null);
    assert.equal(doorCornerSigmaPx({ byHand: ALL, handSigmaPx: NaN, ...PHOTO }), null);
  });

  test("an untouched or chosen detected outline is measured with detection's error, not a hand's", () => {
    // Detected corners are a median 7.8 px and a p90 19 px out on a 2048 px photo: taken as hand-placed
    // (2.5 px) an untouched detection read "Good measurement, accurate to about ±8 mm".
    const detected = doorCornerSigmaPx({ byHand: NONE, handSigmaPx: 2.5, ...PHOTO });
    assert.equal(detected, 9);
    assert.ok(detected >= 3 * 2.5);
    // Scaled with the photo.
    assert.equal(doorCornerSigmaPx({ byHand: NONE, handSigmaPx: 2.5, imageWidth: 1920, imageHeight: 2560 }), 11.25);
    assert.equal(doorCornerSigmaPx({ byHand: NONE, handSigmaPx: 2.5, imageWidth: 2560, imageHeight: 1920 }), 11.25);
    // Without a usable photo size, the bench photo's.
    assert.equal(doorCornerSigmaPx({ byHand: NONE, handSigmaPx: 2.5 }), 9);
    assert.equal(doorCornerSigmaPx({ byHand: NONE, ...PHOTO }), 9);
    // Never less than the hand's own error.
    assert.equal(doorCornerSigmaPx({ byHand: NONE, handSigmaPx: 20, ...PHOTO }), 20);
  });

  test("corners of both kinds are measured at the RMS of their errors, not at the worst one's", () => {
    // One corner left where detection put it, whichever it is: not 9 px for all four.
    const oneDetected = Math.sqrt((3 * 2.5 ** 2 + 9 ** 2) / 4);
    for (let i = 0; i < 4; i += 1) {
      const byHand = ALL.map((v, j) => j !== i);
      const sigma = doorCornerSigmaPx({ byHand, handSigmaPx: 2.5, ...PHOTO });
      assert.ok(Math.abs(sigma - oneDetected) < 1e-12, `corner ${i}: ${sigma}`);
    }
    const twoDetected = doorCornerSigmaPx({ byHand: [true, false, true, false], handSigmaPx: 2.5, ...PHOTO });
    assert.ok(Math.abs(twoDetected - Math.sqrt((2 * 2.5 ** 2 + 2 * 9 ** 2) / 4)) < 1e-12, `two corners: ${twoDetected}`);
    // Each corner's own error is scaled with the photo, as for all four.
    const big = doorCornerSigmaPx({ byHand: [true, true, true, false], handSigmaPx: 2.5, imageWidth: 1920, imageHeight: 2560 });
    assert.ok(Math.abs(big - Math.sqrt((3 * 2.5 ** 2 + 11.25 ** 2) / 4)) < 1e-12, `2560 px photo: ${big}`);
    // Missing or malformed: none by hand.
    assert.equal(doorCornerSigmaPx({ byHand: null, handSigmaPx: 2.5, ...PHOTO }), 9);
    assert.equal(doorCornerSigmaPx({ byHand: [1, 1, 1, 1], handSigmaPx: 2.5, ...PHOTO }), 9);
  });

  test("without a hand's error to weigh in, any corner left where detection put it is detection's for all", () => {
    assert.equal(doorCornerSigmaPx({ byHand: [true, true, true, false], ...PHOTO }), 9);
    assert.equal(doorCornerSigmaPx({ byHand: [true, true, true, false], handSigmaPx: 0, ...PHOTO }), 9);
  });

  test('the ± measureDoor reports for three corners placed by hand and one left alone is the one it measures to', () => {
    // A 1920 x 2560 photo of an 820 x 2040 door with an A4 sheet on it, from 2.6 m and a little to the
    // side, on a 26 mm-equivalent lens; the sheet found and refined (0.5 px), three door corners dragged
    // into place (2.5 px) and one left where detection put it (11.25 px on this photo). Taken at the worst
    // corner's error for all four, measureDoor said about ±34 mm and "poor" for what scatters by about ±20.
    const W = 1920;
    const H = 2560;
    const camera = cameraHomography({
      imageWidth: W,
      imageHeight: H,
      focalPx: (26 / Math.hypot(36, 24)) * Math.hypot(W, H),
      target: { x: 410, y: 1020 },
      distanceMm: 2600,
      yawDeg: 8,
      pitchDeg: -4,
      rollDeg: 0,
    });
    const onPhoto = (corners) => corners.map(([x, y]) => projectPoint(camera, { x, y }));
    const door = onPhoto([[0, 0], [820, 0], [820, 2040], [0, 2040]]);
    const sheet = onPhoto([[305, 850], [515, 850], [515, 1147], [305, 1147]]);
    const SHEET_SIGMA_PX = 0.5;
    const HAND_SIGMA_PX = 2.5;
    const DETECTED_SIGMA_PX = (9 * Math.max(W, H)) / 2048;
    const measure = (doorPx, sheetPx, sigmaDoorPx) =>
      measureDoor({
        sheetPx,
        doorPx,
        sheetMm: A4,
        imageSize: { width: W, height: H },
        sigmaSheetPx: SHEET_SIGMA_PX,
        sigmaDoorPx,
        plausible: PLAUSIBLE,
      });
    const sd = (values) => {
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1));
    };
    const random = seededRandom(20261119);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    const TRIALS = 1500;

    for (let left = 0; left < 4; left += 1) {
      const byHand = [0, 1, 2, 3].map((i) => i !== left);
      const sigmaDoorPx = doorCornerSigmaPx({ byHand, handSigmaPx: HAND_SIGMA_PX, imageWidth: W, imageHeight: H });
      const reported = measure(door, sheet, sigmaDoorPx);
      assert.equal(reported.ok, true, `corner ${left}: ${reported.error}`);
      // The same measurement of the same door, many times over, with each corner off by its own error.
      const widths = [];
      const heights = [];
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const doorPx = door.map((p, i) => {
          const sigma = byHand[i] ? HAND_SIGMA_PX : DETECTED_SIGMA_PX;
          return { x: p.x + gauss() * sigma, y: p.y + gauss() * sigma };
        });
        const sheetPx = sheet.map((p) => ({ x: p.x + gauss() * SHEET_SIGMA_PX, y: p.y + gauss() * SHEET_SIGMA_PX }));
        const r = measure(doorPx, sheetPx, sigmaDoorPx);
        if (!r.ok) continue;
        widths.push(r.widthMm);
        heights.push(r.heightMm);
      }
      assert.ok(widths.length > TRIALS * 0.95, `corner ${left}: ${widths.length} measured`);
      const actual = { width: sd(widths), height: sd(heights) };
      for (const side of ['width', 'height']) {
        const said = side === 'width' ? reported.sigmaWidthMm : reported.sigmaHeightMm;
        const ratio = said / actual[side];
        assert.ok(ratio > 0.75 && ratio < 1.25, `corner ${left} ${side}: says ±${said.toFixed(2)} mm, scatters ±${actual[side].toFixed(2)} mm`);
      }
    }
  });
});

/** A repeatable stand-in for Math.random (mulberry32), so a Monte Carlo test gives the same numbers every run. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('isPhotoTarget', () => {
  const target = (inFloatingControl) => ({
    closest: (selector) => (selector === '.sm-mark__float' && inFloatingControl ? {} : null),
  });

  test('the photo counts, a control floating over it does not', () => {
    assert.equal(isPhotoTarget(target(false)), true);
    assert.equal(isPhotoTarget(target(true)), false);
  });

  test('a target that cannot say counts as the photo', () => {
    assert.equal(isPhotoTarget(null), true);
    assert.equal(isPhotoTarget({}), true);
  });
});

describe('pressGate', () => {
  test('with nothing pressed a change runs at once', () => {
    const gate = pressGate();
    let runs = 0;
    gate.whenReleased(() => {
      runs += 1;
    });
    assert.equal(runs, 1);
    assert.equal(gate.pressed, false);
    assert.equal(gate.release(1), null, 'nothing was held back');
  });

  test('a change asked for mid-drag waits for the finger to lift', () => {
    const gate = pressGate();
    let runs = 0;
    gate.press(1, true);
    assert.equal(gate.pressed, true);
    gate.whenReleased(() => {
      runs += 1;
    });
    assert.equal(runs, 0, 'not while the handle is being dragged');
    const run = gate.release(1);
    assert.equal(typeof run, 'function');
    assert.equal(gate.pressed, false);
    run();
    assert.equal(runs, 1);
    assert.equal(gate.release(1), null, 'handed back once');
  });

  test('a pinch waits for both fingers, and only the latest change is kept', () => {
    const gate = pressGate();
    const ran = [];
    gate.press(1, true);
    gate.press(2, false);
    gate.whenReleased(() => ran.push('first'));
    gate.whenReleased(() => ran.push('second'));
    assert.equal(gate.release(1), null, 'one finger still down');
    gate.release(2)();
    assert.deepEqual(ran, ['second']);
  });

  test('a press that never reported its release is forgotten at the next first finger', () => {
    const gate = pressGate();
    gate.press(7, true);
    gate.press(8, true);
    gate.whenReleased(() => {});
    assert.equal(typeof gate.release(8), 'function');
  });

  test('clear drops what is held back', () => {
    const gate = pressGate();
    let runs = 0;
    gate.press(1, true);
    gate.whenReleased(() => {
      runs += 1;
    });
    gate.clear();
    assert.equal(gate.pressed, false);
    assert.equal(gate.release(1), null);
    assert.equal(runs, 0);
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

// ---------- the door screen, mounted ----------
//
// js/screens/door.js on a stand-in DOM, with the real mark-screen scaffold (createMarkScreen) and the real
// corner editor (js/editor.js), and findDoor's module worker stood in for (FakeWorker), so a test decides
// when the background search for the door answers, and what. Nothing else is stood in for: js/door-find.js
// runs as in the app, time limits and all. Events go through a capture and a bubble phase as in a browser:
// the door screen watches presses on the photo in the capture phase, before the editor acts on them. The
// editor gets no 2-D context and its window no animation frames, so it draws nothing and zooms at once.

/** The photo stage, CSS px: a 390 px wide phone, less the banner and the action bar. */
const STAGE_PX = { width: 390, height: 560 };
const SCREEN_PHOTO = { width: 1536, height: 2048 };

class StandInElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.localName = String(tag).toLowerCase();
    this.parentNode = null;
    this.childNodes = [];
    this.attrs = new Map();
    this.listeners = [];
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.ownText = '';
    const classes = new Set();
    this.classes = classes;
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
  }

  get className() {
    return [...this.classes].join(' ');
  }

  set className(value) {
    this.classes.clear();
    for (const name of String(value).split(/\s+/)) if (name) this.classes.add(name);
  }

  get textContent() {
    return this.ownText + this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.ownText = value === null || value === undefined ? '' : String(value);
    this.childNodes = [];
  }

  get isConnected() {
    return true;
  }

  // Every element is laid out at the photo stage's size: the mark screen sizes the editor from it.
  get clientWidth() {
    return STAGE_PX.width;
  }

  get clientHeight() {
    return STAGE_PX.height;
  }

  getBoundingClientRect() {
    const { width, height } = STAGE_PX;
    return { left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, width, height };
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  appendChild(node) {
    node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes.flat()) if (node && typeof node === 'object') this.appendChild(node);
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  addEventListener(type, listener, options) {
    this.listeners.push({ type, listener, capture: options === true || Boolean(options && options.capture) });
  }

  removeEventListener(type, listener, options) {
    const capture = options === true || Boolean(options && options.capture);
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.listener === listener && l.capture === capture));
  }

  /** Only '.class' selectors, which is all the screens ask of it (never :focus-visible). */
  matches(selector) {
    return selector.startsWith('.') && this.classes.has(selector.slice(1));
  }

  closest(selector) {
    for (let at = this; at; at = at.parentNode) if (at.matches(selector)) return at;
    return null;
  }

  getContext() {
    return null;
  }

  setPointerCapture() {}

  releasePointerCapture() {}

  hasPointerCapture() {
    return false;
  }

  focus() {}

  blur() {}

  /** The first element, depth first and this one included, that `predicate` accepts. */
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.childNodes) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
}

/** Fire an event at `target` as a browser does: capture down its ancestors, the target, bubble back up. */
function fire(target, type, props = {}) {
  const ancestors = [];
  for (let at = target.parentNode; at; at = at.parentNode) ancestors.unshift(at);
  const event = {
    type,
    target,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {},
    ...props,
  };
  const run = (node, phase) => {
    for (const { type: listening, listener, capture } of [...node.listeners]) {
      if (listening === type && (phase === 'target' || capture === (phase === 'capture'))) listener(event);
    }
  };
  for (const node of ancestors) run(node, 'capture');
  run(target, 'target');
  for (const node of [...ancestors].reverse()) run(node, 'bubble');
  return event;
}

/** The document and window the editor finds through its container (no animation frames: it draws at once). */
function standInDocument() {
  const win = {
    devicePixelRatio: 1,
    performance,
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
    clearTimeout: (id) => clearTimeout(id),
    getComputedStyle: () => ({ position: 'relative', color: '', fontFamily: '' }),
    addEventListener() {},
    removeEventListener() {},
  };
  const doc = {
    defaultView: win,
    createElement: (tag) => new StandInElement(doc, tag),
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

/** The parts of js/ui.js the door screen and the mark-screen scaffold use, built on the stand-in DOM. */
function standInUi(doc) {
  const h = (tag, props, ...children) => {
    const el = doc.createElement(tag);
    const p = props || {};
    if (p.class) el.className = p.class;
    if (p.text !== undefined && p.text !== null) el.textContent = p.text;
    if (p.hidden) el.hidden = true;
    if (p.disabled) el.disabled = true;
    if (p.type) el.setAttribute('type', p.type);
    for (const [name, value] of Object.entries(p.attrs || {})) el.setAttribute(name, value);
    for (const [type, listener] of Object.entries(p.on || {})) el.addEventListener(type, listener);
    el.append(...children);
    return el;
  };
  return {
    h,
    icon: (name) => h('svg', { class: `sm-icon sm-icon--${name}` }),
    svgFromString: () => h('svg'),
    button(label, { onClick } = {}) {
      const el = h('button', { class: 'sm-btn', type: 'button', text: label });
      if (onClick) el.addEventListener('click', onClick);
      return el;
    },
    actionBar: (...children) => h('div', { class: 'sm-actionbar' }, ...children),
    banner(text, { tone = 'info' } = {}) {
      const el = h('div', { class: 'sm-banner', text });
      el.tone = tone;
      el.update = (next, nextTone) => {
        el.textContent = next;
        if (nextTone) el.tone = nextTone;
      };
      return el;
    },
    bottomSheet: () => ({ el: h('div'), open() {}, close() {} }),
  };
}

/** The door screen's own wording, as ctx.t gives it with no config.text. */
const say = (key, vars = {}) =>
  String(doorScreen.strings[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));

// Every stand-in worker findDoor made, in order.
const workers = [];

/** findDoor's module worker, stood in for: it answers when the test says, with what the test says. */
class FakeWorker {
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    workers.push(this);
  }

  postMessage(message) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  /** The worker has loaded. findDoor starts timing the search now: returns the time limits it set. */
  ready() {
    const realSetTimeout = globalThis.setTimeout;
    const limits = [];
    globalThis.setTimeout = (fn, ms, ...args) => {
      limits.push(ms);
      return realSetTimeout(fn, ms, ...args);
    };
    try {
      this.onmessage?.({ data: { ready: true } });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    return limits;
  }

  /** The search's answer, as door-detect-worker.js posts it. */
  answer(result) {
    this.onmessage?.({ data: { id: this.posted[0]?.id, result } });
  }
}

// Every corner editor made, in order, so a test can read its handles and its view.
const editors = [];
// Screens still mounted, so a failing test cannot leave one listening.
const mountedScreens = [];

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait (task by task) until `condition` holds. */
async function until(condition, what) {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await nextTask();
  }
  assert.fail(`gave up waiting for ${what}`);
}

/**
 * Mount the door screen on `state` the way the router does, with a press of the photo and the editor at hand.
 * @param {object} state
 */
function mountDoorScreen(state) {
  const doc = standInDocument();
  const root = doc.createElement('section');
  const went = [];
  const toasts = [];
  const ctx = {
    state,
    config: SHIPPED_CONFIG,
    ui: standInUi(doc),
    t: say,
    go: (id) => went.push(id),
    toast: (text) => toasts.push(text),
    emit() {},
  };
  const editorIndex = editors.length;
  const cleanup = doorScreen.mount(root, ctx);
  let clock = performance.now();
  const canvas = () => root.find((el) => el.classList.contains('sm-quad-editor'));
  const pointer = (type, pointerId, at, { primary = true, after = 16 } = {}) => {
    clock += after;
    const target = canvas();
    if (!target) throw new Error('no photo on the door screen yet');
    fire(target, type, {
      pointerId,
      pointerType: 'touch',
      isPrimary: primary,
      button: 0,
      clientX: at.x,
      clientY: at.y,
      timeStamp: clock,
    });
  };
  const screen = {
    root,
    went,
    toasts,
    /** This screen's corner editor, once its first frame has made it. */
    get editor() {
      return editors[editorIndex] ?? null;
    },
    banner: () => root.find((el) => el.classList.contains('sm-banner')).textContent,
    button: (label) => root.find((el) => el.localName === 'button' && el.textContent === label),
    press: (label) => fire(screen.button(label), 'click'),
    down: (pointerId, at, options) => pointer('pointerdown', pointerId, at, options),
    move: (pointerId, at, options) => pointer('pointermove', pointerId, at, options),
    up: (pointerId, at, options) => pointer('pointerup', pointerId, at, options),
    mounted: true,
    unmount() {
      if (!screen.mounted) return;
      screen.mounted = false;
      cleanup();
    },
  };
  mountedScreens.push(screen);
  return screen;
}

// A door opening and the A4 sheet taped to it in a 1536 x 2048 photo, from 2.6 m and a little to the side.
const SCREEN_CAMERA = cameraHomography({
  imageWidth: SCREEN_PHOTO.width,
  imageHeight: SCREEN_PHOTO.height,
  focalPx: (26 / Math.hypot(36, 24)) * Math.hypot(SCREEN_PHOTO.width, SCREEN_PHOTO.height),
  target: { x: 410, y: 1020 },
  distanceMm: 2600,
  yawDeg: 6,
  pitchDeg: -3,
  rollDeg: 0,
});
const onScreenPhoto = (corners) => corners.map(([x, y]) => projectPoint(SCREEN_CAMERA, { x, y }));
const SCREEN_DOOR = onScreenPhoto([[0, 0], [820, 0], [820, 2040], [0, 2040]]);
const SCREEN_TRIM = onScreenPhoto([[-60, -60], [880, -60], [880, 2040], [-60, 2040]]);
const SCREEN_SHEET = onScreenPhoto([[305, 850], [515, 850], [515, 1147], [305, 1147]]);
// Where the handles start before anything is found: the detector's door-shaped rectangle mid-photo.
const FALLBACK = startingQuad(SCREEN_PHOTO, null);
// The editor's view of the whole photo, and where an image point is on it.
const FIT = fitView(SCREEN_PHOTO.width, SCREEN_PHOTO.height, STAGE_PX.width, STAGE_PX.height);
const onStage = (point) => imageToScreen(FIT, point);
// A spot on the photo nowhere near a handle: a press there pans, a tap there is a tap.
const EMPTY_SPOT = { x: 30, y: 60 };
const TIMED_OUT = { ok: false, quad: null, confidence: 0, alternatives: [], reason: 'timeout' };

/** What findDoor answers when it is sure it found the door (alternatives: the other outlines it considered). */
const foundDoor = (alternatives = []) => ({ ok: true, quad: copy(SCREEN_DOOR), confidence: 0.86, alternatives: alternatives.map(copy) });

/** A photo as loadPhoto hands it over; its pixels only travel to the stand-in worker. */
function screenPhoto() {
  return {
    width: SCREEN_PHOTO.width,
    height: SCREEN_PHOTO.height,
    canvas: null,
    image: { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 },
    isDemo: false,
    capture: 'frame',
    focal35mm: null,
  };
}

/** At the door screen on the paper path: the sheet found and refined, no search for the door yet. */
function paperAtDoor(door = { points: null, detection: null }) {
  return {
    method: 'paper',
    photo: screenPhoto(),
    sheet: { points: copy(SCREEN_SHEET), refined: true, detected: true, placed: true },
    door,
    measure: null,
    size: null,
  };
}

/** Mount the door screen and wait for its background search to ask the (stand-in) worker. */
async function mountAndSearch(state) {
  const before = workers.length;
  const screen = mountDoorScreen(state);
  await until(() => workers.length > before, 'the search for the door to start');
  assert.equal(screen.banner(), say('door.banner.searching'));
  return { screen, worker: workers.at(-1) };
}

/** The stand-in worker answers the search; then wait for the door screen to have had the answer. */
async function searchAnswers(worker, result) {
  worker.ready();
  worker.answer(result);
  await until(() => worker.terminated, 'findDoor to finish');
  // lookForDoor carries on once findDoor's promise has resolved.
  for (let i = 0; i < 3; i += 1) await nextTask();
}

/** The same four points, to well under a pixel's width. */
function isQuadNear(points, quad) {
  return Array.isArray(points) && points.length === 4 && points.every((p, i) => Math.hypot(p.x - quad[i].x, p.y - quad[i].y) < 1e-9);
}
const onDoor = (points) => isQuadNear(points, SCREEN_DOOR);

describe('the door screen, mounted: its background search for the door', () => {
  let saved = [];
  let realResize = null;

  before(() => {
    saved = ['Worker', 'requestAnimationFrame', 'cancelAnimationFrame'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    set('Worker', FakeWorker);
    set('requestAnimationFrame', (callback) => setTimeout(() => callback(performance.now()), 0));
    set('cancelAnimationFrame', (id) => clearTimeout(id));
    realResize = QuadEditor.prototype.resize;
    // The editor sizes itself once as it is made: that is where a test picks it up.
    QuadEditor.prototype.resize = function resize(...args) {
      if (!editors.includes(this)) editors.push(this);
      return realResize.apply(this, args);
    };
  });

  afterEach(() => {
    for (const screen of mountedScreens) screen.unmount();
    // A search a failed test left unanswered must not keep its time limits running.
    for (const worker of workers) if (!worker.terminated) worker.answer({ ok: false, reason: 'no_lines' });
  });

  after(() => {
    QuadEditor.prototype.resize = realResize;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  test('a search that ran out of time on the capture screen is run again, on the framing guide, with the longer time limit', async () => {
    // What js/screens/capture.js leaves when its findDoor timed out: the timeout, and the guide it searched in.
    const prior = [
      { x: 380, y: 300 },
      { x: 1150, y: 300 },
      { x: 1150, y: 1900 },
      { x: 380, y: 1900 },
    ];
    const state = { method: 'estimate', photo: screenPhoto(), door: { points: null, detection: { ...TIMED_OUT }, prior: copy(prior) } };
    const { screen, worker } = await mountAndSearch(state);
    assert.deepEqual(worker.posted[0].opts, { prior }, 'searched on the guide the customer lined the door up with');
    // The search gets what is left of the call's 15 s once the worker has started: 15 s less the few ms
    // it took to start here (more on a busy machine), never findDoor's 4 s default.
    const limits = worker.ready();
    assert.equal(limits.length, 1, 'one time limit for the search');
    assert.ok(limits[0] > 14000 && limits[0] <= 15000, `given 15 s, not findDoor's 4 s default (${limits[0]} ms)`);
    worker.answer(foundDoor());
    await until(() => screen.banner() === say('door.banner.found'), 'the door to be shown as found');

    assert.deepEqual(state.door.detection, foundDoor(), 'the photo\'s answer replaces the timeout');
    assert.ok(onDoor(screen.editor.getPoints()), 'the handles start on the door');
    screen.unmount();

    // Back from "Adjust corners": the answer is kept, so there is no searching again.
    const again = mountDoorScreen(state);
    await until(() => again.editor, 'the editor');
    for (let i = 0; i < 5; i += 1) await nextTask();
    assert.equal(workers.at(-1), worker, 'no new search');
    assert.equal(again.banner(), say('door.banner.found'));
    assert.ok(onDoor(again.editor.getPoints()));
  });

  test('a search here that runs out of time too is not kept: the next visit looks again', async () => {
    const state = paperAtDoor();
    const { screen, worker } = await mountAndSearch(state);
    await searchAnswers(worker, { ...TIMED_OUT });
    assert.equal(state.door.detection, null, 'not the photo\'s answer');
    assert.equal(screen.banner(), say('door.banner'));
    screen.unmount();

    const { worker: retry } = await mountAndSearch(state);
    assert.notEqual(retry, worker, 'searched again');
  });

  test('leaving the screen stops its search: the worker is stopped, nothing is kept, and the next visit looks again', async () => {
    const state = paperAtDoor();
    const { screen, worker } = await mountAndSearch(state);
    worker.ready();
    screen.unmount();
    await until(() => worker.terminated, 'the search to be stopped');
    // An answer that would still have come is not listened to any more.
    worker.answer(foundDoor());
    for (let i = 0; i < 3; i += 1) await nextTask();
    assert.equal(state.door.detection, null, 'a search given up is not the photo\'s answer');

    const { worker: retry } = await mountAndSearch(state);
    assert.notEqual(retry, worker, 'searched again');
  });

  test('a tap on the photo before the search ends does not lose the door it finds', async () => {
    // A tap away from the handles only lets go of the selected corner; it places nothing. With one outline
    // there is no "Not this? Show the next outline" to bring the door back, had it been dropped.
    const state = paperAtDoor();
    const { screen, worker } = await mountAndSearch(state);
    screen.down(1, EMPTY_SPOT);
    screen.up(1, EMPTY_SPOT, { after: 80 });
    await nextTask();
    await searchAnswers(worker, foundDoor());

    assert.ok(onDoor(screen.editor.getPoints()), 'the handles moved onto the door');
    assert.equal(screen.editor.getActive(), null);
    assert.equal(screen.banner(), say('door.banner.found'));
    assert.equal(screen.button(say('door.outline.next')).hidden, true, 'one outline: nothing to step through');
    screen.press(say('door.measure'));
    assert.deepEqual(screen.toasts, [], 'no "drag the four corners first"');
    assert.deepEqual(screen.went, ['result']);
    assert.ok(onDoor(state.door.points));
  });

  test('a pinch before the search ends: the handles go onto the door, and the whole photo is shown again', async () => {
    const state = paperAtDoor();
    const { screen, worker } = await mountAndSearch(state);
    screen.down(1, { x: 100, y: 300 });
    screen.down(2, { x: 200, y: 300 }, { primary: false });
    for (const x of [230, 260, 300]) screen.move(2, { x, y: 300 });
    screen.up(2, { x: 300, y: 300 });
    screen.up(1, { x: 100, y: 300 });
    assert.ok(screen.editor.getView().scale > FIT.scale * 1.5, 'zoomed in');
    assert.ok(isQuadNear(screen.editor.getPoints(), FALLBACK), 'no handle moved');
    await nextTask();
    await searchAnswers(worker, foundDoor());

    assert.ok(onDoor(screen.editor.getPoints()), 'the handles moved onto the door');
    assert.ok(viewsEqual(screen.editor.getView(), FIT), 'the whole photo, where the handles now are');
    assert.equal(screen.banner(), say('door.banner.found'));
  });

  test('a finger on the photo when the search ends: nothing moves or changes until it lifts', async () => {
    const state = paperAtDoor();
    const { screen, worker } = await mountAndSearch(state);
    const outlineButton = screen.button(say('door.outline.next'));
    screen.down(1, EMPTY_SPOT);
    await searchAnswers(worker, foundDoor([SCREEN_TRIM]));
    assert.deepEqual(state.door.detection, foundDoor([SCREEN_TRIM]), 'the answer is kept for the photo straight away');
    assert.equal(screen.banner(), say('door.banner.searching'), 'the banner waits');
    assert.equal(outlineButton.hidden, true, 'the outline button waits');
    assert.ok(isQuadNear(screen.editor.getPoints(), FALLBACK), 'the handles wait');

    // Held, not a tap. The release is seen before the editor's own: what follows waits one task for it.
    screen.up(1, EMPTY_SPOT, { after: 2000 });
    assert.equal(screen.banner(), say('door.banner.searching'), 'not before the editor has had the release');
    await nextTask();
    assert.equal(screen.banner(), say('door.banner.found'));
    assert.equal(outlineButton.hidden, false, 'two outlines: "Not this?" is offered');
    assert.ok(onDoor(screen.editor.getPoints()), 'nothing was placed, so the handles go onto the door');
  });

  test('a handle held still when the search ends stays where it is, and selected', async () => {
    const state = paperAtDoor();
    const { screen, worker } = await mountAndSearch(state);
    const handle = onStage(FALLBACK[0]);
    screen.down(1, handle);
    assert.equal(screen.editor.getActive(), 0, 'the press selected it');
    await searchAnswers(worker, foundDoor());
    assert.ok(isQuadNear(screen.editor.getPoints(), FALLBACK), 'not moved from under the finger');
    assert.equal(screen.banner(), say('door.banner.searching'));

    screen.up(1, handle, { after: 300 });
    await nextTask();
    assert.ok(isQuadNear(screen.editor.getPoints(), FALLBACK), 'nor after: a selected handle is the customer\'s');
    assert.equal(screen.editor.getActive(), 0, 'still selected');
    assert.equal(screen.banner(), say('door.banner'), 'drag each corner');
  });

  test('a handle dragged while the search runs is the customer\'s, and the banner waits for the finger', async () => {
    const state = paperAtDoor();
    const { screen, worker } = await mountAndSearch(state);
    const handle = onStage(FALLBACK[0]);
    screen.down(1, handle);
    for (const step of [6, 26, 46]) screen.move(1, { x: handle.x + step, y: handle.y + step / 2 });
    const dragged = screen.editor.getPoints()[0];
    assert.ok(!isQuadNear(screen.editor.getPoints(), FALLBACK), 'the handle follows the finger');
    await searchAnswers(worker, foundDoor([SCREEN_TRIM]));
    assert.equal(screen.banner(), say('door.banner.searching'), 'no banner change mid-drag');
    assert.equal(screen.button(say('door.outline.next')).hidden, true, 'no new button mid-drag');
    assert.deepEqual(screen.editor.getPoints()[0], dragged, 'the handle stays under the finger');

    screen.up(1, { x: handle.x + 46, y: handle.y + 23 }, { after: 200 });
    assert.equal(screen.banner(), say('door.banner.searching'));
    await nextTask();
    assert.equal(screen.banner(), say('door.banner'), 'the customer\'s own corners: drag each corner');
    assert.equal(screen.button(say('door.outline.next')).hidden, false, 'the outlines found are still offered');
    const points = screen.editor.getPoints();
    assert.deepEqual(points[0], dragged, 'where the customer put it');
    for (let i = 1; i < 4; i += 1) assert.deepEqual(points[i], FALLBACK[i], `handle ${i} untouched`);
    assert.deepEqual(state.door.byHand, [true, false, false, false]);
  });
});
