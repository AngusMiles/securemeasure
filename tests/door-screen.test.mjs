// The door screen (js/screens/door.js) itself, mounted in a fake browser (tests/helpers/screen-dom.mjs)
// with its real corner editor, and pressed the way a customer presses it: "Measure my door" or "Find my
// door size", the arrow keys on the photo, "Not this? Show the next outline", and a trip back from the
// result screen's "Adjust corners" (the screen unmounted and mounted again on the same state).
//
// What it pins: which corner error the screen measures with. Corners still where detection put them are
// as good as detection, 9 px per axis on a 2048 px photo scaled to the photo (doorCornerSigmaPx in
// js/screens/mark-common.js), not as good as a corner the customer dragged into place with the magnifier
// (config.measurement.sigmaDoorPx, 2.5 px) or a tap (the estimate's own 3 px). Measured as hand-placed, an
// untouched detection reads "Good measurement, accurate to about ±8 mm" while being commonly 10-50 mm out.
//
// Nothing stands in for the measuring code: state.measure is measureDoor's (paper) or estimateFromCorners'
// (no paper) own result, and each test compares it with the same call made here with the corner error the
// screen should have used, and shows that the other one gives a different answer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { measureDoor } from '../js/geometry.js';
import { getSheetMm } from '../js/photo.js';
import { estimateFromCorners, photoFocal, standardSizesFrom } from '../js/estimate.js';
import { createInitialState } from '../js/app.js';
import { cornersInOutlineOrder, doorCornerSigmaPx } from '../js/screens/mark-common.js';
import * as door from '../js/screens/door.js';
import { SHIPPED_CONFIG as config } from './helpers/shipped-config.mjs';
import { installFakeDom } from './helpers/screen-dom.mjs';

const m = config.measurement;

// A 1200 x 1600 photo, so the detection error is seen to scale with the photo: 9 px at 2048 px is 7.03 px here.
const PHOTO_W = 1200;
const PHOTO_H = 1600;
const DETECTED_SIGMA_PX = (9 * Math.max(PHOTO_W, PHOTO_H)) / 2048;
const ALL_DETECTED = [false, false, false, false];
const ALL_BY_HAND = [true, true, true, true];

// An 820 x 2040 mm door with an A4 sheet taped to it, photographed a little from the right and below
// with the phone main camera the no-paper estimate assumes (the 26 mm prior), so both ways measure it.
const FOCAL = photoFocal({ width: PHOTO_W, height: PHOTO_H, focal35mm: null, capture: 'frame' });
const CAMERA = cameraHomography({
  imageWidth: PHOTO_W,
  imageHeight: PHOTO_H,
  focalPx: FOCAL.focalPx,
  target: { x: 410, y: 1020 },
  distanceMm: 2800,
  yawDeg: 12,
  pitchDeg: -6,
  rollDeg: 1,
});
const onPhoto = (corners) => corners.map(([x, y]) => projectPoint(CAMERA, { x, y }));
// [TL, TR, BR, BL], image px.
const DOOR_PX = onPhoto([[0, 0], [820, 0], [820, 2040], [0, 2040]]);
const SHEET_PX = onPhoto([[305, 600], [515, 600], [515, 897], [305, 897]]);
// Detection's usual runner-up: the outer trim, 60 mm round the opening.
const TRIM_PX = onPhoto([[-60, -60], [880, -60], [880, 2040], [-60, 2040]]);

const copy = (quad) => quad.map((p) => ({ x: p.x, y: p.y }));
/** The quad with the first `count` corners moved one pixel right, as one press of → on each does. */
const nudged = (quad, count) => quad.map((p, i) => (i < count ? { x: p.x + 1, y: p.y } : { x: p.x, y: p.y }));

/** What findDoor() leaves in state.door.detection when it is sure it found the door. */
const confidentDetection = ({ alternatives = [] } = {}) => ({ ok: true, quad: copy(DOOR_PX), confidence: 0.86, alternatives });

/** What loadPhoto hands the screens for a grabbed video frame (no EXIF focal). */
const framePhoto = () => ({
  width: PHOTO_W,
  height: PHOTO_H,
  canvas: { width: PHOTO_W, height: PHOTO_H },
  image: null,
  isDemo: false,
  capture: 'frame',
  focal35mm: null,
  _luma: null,
});

/** The paper way in, at the door screen: the sheet found and refined, findDoor's answer kept. */
function paperState(detection = confidentDetection()) {
  const state = createInitialState(config);
  state.method = 'paper';
  state.photo = framePhoto();
  state.sheet = { points: copy(SHEET_PX), refined: true, detected: true, placed: true };
  state.door = { points: null, detection };
  return state;
}

/** The no-paper way in (the capture screen), at the door screen. */
function estimateState(detection = confidentDetection()) {
  const state = createInitialState(config);
  state.method = 'estimate';
  state.photo = framePhoto();
  state.door = { points: null, detection };
  return state;
}

/** js/screens/door.js measurePaper with this door corner error: what state.measure must then be. */
function paperMeasure(state, doorPx, sigmaDoorPx) {
  const result = measureDoor({
    sheetPx: state.sheet.points,
    doorPx,
    sheetMm: getSheetMm(state, config),
    imageSize: { width: PHOTO_W, height: PHOTO_H },
    sigmaSheetPx: m.sigmaSheetRefinedPx,
    sigmaDoorPx,
    plausible: m.plausible,
  });
  assert.equal(result.ok, true, `measureDoor (${result.error})`);
  return { ...result, method: 'paper' };
}

/** js/screens/door.js measureEstimate with this corner error (undefined: left out, so a tap's). */
function estimateMeasure(state, doorPx, cornerSigmaPx) {
  const focal = photoFocal(state.photo);
  const input = {
    corners: cornersInOutlineOrder(doorPx),
    imageWidth: PHOTO_W,
    imageHeight: PHOTO_H,
    focalPx: focal.focalPx,
    focalSource: focal.source,
    sizes: standardSizesFrom(config),
  };
  if (cornerSigmaPx !== undefined) input.cornerSigmaPx = cornerSigmaPx;
  const result = estimateFromCorners(input);
  assert.equal(result.ok, true, `estimateFromCorners (${result.error})`);
  return result;
}

/** Run `fn` with the fake browser installed, and take it away again whatever happens. */
async function inBrowser(fn) {
  const dom = installFakeDom();
  try {
    return await fn(dom);
  } finally {
    dom.uninstall();
  }
}

/** Press → on the photo once per corner, for the first `count` handles: each moves one pixel right. */
function nudgeCorners(screen, count) {
  for (let i = 0; i < count; i++) {
    // The first → selects handle 0 (nothing is selected yet); Tab moves on to the next one.
    if (i === 0) screen.key('ArrowRight');
    else screen.key('Tab');
    screen.key('ArrowRight');
  }
}

/** The press went through: no "drag the corners first" and no error, on to the result. */
function assertMeasured(screen, label) {
  assert.deepEqual(screen.toasts, [], `${label}: no message`);
  assert.equal(screen.went.at(-1), 'result', `${label}: on to the result`);
}

describe('the door screen measures detected corners with detection\'s error (js/screens/door.js in a fake browser)', () => {
  test('the fixture: either corner error gives a size, and they give different answers', () => {
    const paper = paperState();
    const detected = paperMeasure(paper, DOOR_PX, DETECTED_SIGMA_PX);
    const hand = paperMeasure(paper, DOOR_PX, m.sigmaDoorPx);
    assert.equal(Math.round(detected.widthMm), 820);
    assert.equal(Math.round(detected.heightMm), 2040);
    assert.ok(detected.sigmaWidthMm > hand.sigmaWidthMm * 1.5, 'detection\'s error is a wider ± than a dragged corner\'s');
    assert.notEqual(detected.quality.level, hand.quality.level, 'and a different grade');

    const estimate = estimateState();
    const fromDetection = estimateMeasure(estimate, DOOR_PX, DETECTED_SIGMA_PX);
    const fromTap = estimateMeasure(estimate, DOOR_PX, undefined);
    assert.equal(`${fromDetection.candidates[0].widthMm}x${fromDetection.candidates[0].heightMm}`, '820x2040');
    assert.ok(fromDetection.candidates[0].p < fromTap.candidates[0].p, 'detection\'s error makes the estimate less sure than a tap\'s');
  });

  test('paper: "Measure my door" on an untouched confident detection uses detection\'s error, not a dragged corner\'s', async () => {
    await inBrowser((dom) => {
      const state = paperState();
      const screen = dom.mount(door, { state, config });
      screen.press('Measure my door');
      assertMeasured(screen, 'untouched');

      // The handles started on the detected door, and that is what was measured.
      assert.deepEqual(state.door.points, DOOR_PX);
      assert.deepEqual(state.door.byHand, ALL_DETECTED, 'kept with the corners: none placed by the customer');
      assert.equal(state.door.chosen, false);
      assert.deepEqual(state.measure, paperMeasure(state, DOOR_PX, DETECTED_SIGMA_PX));
      assert.notDeepEqual(state.measure, paperMeasure(state, DOOR_PX, m.sigmaDoorPx), 'not as if the customer had dragged them');

      // The ± the result screen and the enquiry show is that one.
      const measured = screen.emitted.find((event) => event.type === 'measured')?.payload;
      assert.ok(measured, 'the measurement is announced');
      assert.equal(measured.sigmaWidthMm, state.measure.sigmaWidthMm);
      assert.equal(measured.sigmaHeightMm, state.measure.sigmaHeightMm);
      assert.equal(measured.quality, state.measure.quality.level);
      screen.unmount();
    });
  });

  test('paper: back from "Adjust corners", corners left where detection put them are still detection\'s', async () => {
    await inBrowser((dom) => {
      const state = paperState();
      const first = dom.mount(door, { state, config });
      first.press('Measure my door');
      assertMeasured(first, 'first visit');
      first.unmount();

      const again = dom.mount(door, { state, config });
      assert.deepEqual(state.door.byHand, ALL_DETECTED, 'mounting again changes nothing');
      again.press('Measure my door');
      assertMeasured(again, 'second visit');
      assert.deepEqual(state.door.byHand, ALL_DETECTED, 'measuring again does not make them the customer\'s');
      assert.deepEqual(state.measure, paperMeasure(state, DOOR_PX, DETECTED_SIGMA_PX));
      again.unmount();
    });
  });

  test('paper: corners the customer moves are measured with their own aim, and those left alone with detection\'s', async () => {
    await inBrowser((dom) => {
      const state = paperState();
      const screen = dom.mount(door, { state, config });

      nudgeCorners(screen, 1);
      assert.equal(state.measure, null, 'a moved corner drops any earlier measurement');
      screen.press('Measure my door');
      assertMeasured(screen, 'one corner moved');
      assert.deepEqual(state.door.points, nudged(DOOR_PX, 1));
      assert.deepEqual(state.door.byHand, [true, false, false, false]);
      // How the four are put together into the one figure measureDoor takes is doorCornerSigmaPx's business
      // (tests/mark.test.mjs); what matters here is that the three detected corners count as detection's.
      const mixed = doorCornerSigmaPx({ byHand: state.door.byHand, handSigmaPx: m.sigmaDoorPx, imageWidth: PHOTO_W, imageHeight: PHOTO_H });
      assert.ok(mixed > m.sigmaDoorPx, `three corners left alone are less sure than four placed (${mixed} px)`);
      assert.deepEqual(state.measure, paperMeasure(state, nudged(DOOR_PX, 1), mixed));
      assert.notDeepEqual(state.measure, paperMeasure(state, nudged(DOOR_PX, 1), m.sigmaDoorPx));

      // The first handle is still selected: Tab on to each of the other three and move it.
      for (let i = 1; i < 4; i++) {
        screen.key('Tab');
        screen.key('ArrowRight');
      }
      screen.press('Measure my door');
      assertMeasured(screen, 'all four moved');
      assert.deepEqual(state.door.points, nudged(DOOR_PX, 4));
      assert.deepEqual(state.door.byHand, ALL_BY_HAND);
      assert.deepEqual(state.measure, paperMeasure(state, nudged(DOOR_PX, 4), m.sigmaDoorPx));
      screen.unmount();

      // Back from "Adjust corners": still the customer's own corners, still measurable without a drag.
      const again = dom.mount(door, { state, config });
      assert.deepEqual(state.door.byHand, ALL_BY_HAND);
      again.press('Measure my door');
      assertMeasured(again, 'second visit');
      assert.deepEqual(state.measure, paperMeasure(state, nudged(DOOR_PX, 4), m.sigmaDoorPx));
      again.unmount();
    });
  });

  test('paper: an outline picked with "Not this? Show the next outline" is detection\'s, on this visit and the next', async () => {
    await inBrowser((dom) => {
      const state = paperState(confidentDetection({ alternatives: [copy(TRIM_PX)] }));
      const screen = dom.mount(door, { state, config });
      assert.equal(screen.button('Not this? Show the next outline')?.hidden, false, 'offered: detection considered two outlines');
      screen.press('Not this? Show the next outline');
      screen.press('Measure my door');
      assertMeasured(screen, 'next outline');
      assert.deepEqual(state.door.points, TRIM_PX);
      assert.deepEqual(state.door.byHand, ALL_DETECTED);
      assert.equal(state.door.chosen, true);
      assert.deepEqual(state.measure, paperMeasure(state, TRIM_PX, DETECTED_SIGMA_PX));
      screen.unmount();

      // A picked outline counts as placed when the customer comes back, and is still detection's.
      const again = dom.mount(door, { state, config });
      again.press('Measure my door');
      assertMeasured(again, 'second visit');
      assert.equal(state.door.chosen, true);
      assert.deepEqual(state.measure, paperMeasure(state, TRIM_PX, DETECTED_SIGMA_PX));
      again.unmount();
    });
  });

  test('no paper: "Find my door size" on an untouched confident detection uses detection\'s error, not a tap\'s', async () => {
    await inBrowser((dom) => {
      const state = estimateState();
      const screen = dom.mount(door, { state, config });
      screen.press('Find my door size');
      assertMeasured(screen, 'untouched');
      assert.deepEqual(state.door.points, DOOR_PX);
      assert.deepEqual(state.door.byHand, ALL_DETECTED);
      assert.deepEqual(state.measure, estimateMeasure(state, DOOR_PX, DETECTED_SIGMA_PX));
      assert.notDeepEqual(state.measure, estimateMeasure(state, DOOR_PX, undefined), 'not as if the customer had tapped them');
      const best = state.measure.candidates[0];
      assert.deepEqual(state.size, { widthMm: best.widthMm, heightMm: best.heightMm, source: 'estimate', standard: true });
      screen.unmount();

      // Back from "Adjust corners": the same corners, still detection's.
      const again = dom.mount(door, { state, config });
      assert.deepEqual(state.door.byHand, ALL_DETECTED);
      again.press('Find my door size');
      assertMeasured(again, 'second visit');
      assert.deepEqual(state.measure, estimateMeasure(state, DOOR_PX, DETECTED_SIGMA_PX));
      again.unmount();
    });
  });

  test('no paper: with all four corners placed by the customer, the estimate takes a tap\'s error', async () => {
    await inBrowser((dom) => {
      const state = estimateState();
      const screen = dom.mount(door, { state, config });
      nudgeCorners(screen, 4);
      screen.press('Find my door size');
      assertMeasured(screen, 'all four moved');
      assert.deepEqual(state.door.byHand, ALL_BY_HAND);
      assert.deepEqual(state.measure, estimateMeasure(state, nudged(DOOR_PX, 4), undefined));
      screen.unmount();
    });
  });
});
