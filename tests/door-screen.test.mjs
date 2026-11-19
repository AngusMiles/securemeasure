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
import { readFileSync } from 'node:fs';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { measureDoor, QUALITY_THRESHOLDS } from '../js/geometry.js';
import { getSheetMm } from '../js/photo.js';
import { estimateFromCorners, photoFocal, standardSizesFrom } from '../js/estimate.js';
import { createInitialState } from '../js/app.js';
import { useDemoPhoto } from '../js/demo.js';
import { cornersInOutlineOrder, doorCornerSigmaPx } from '../js/screens/mark-common.js';
import { fitView, imageToScreen } from '../js/editor.js';
import * as door from '../js/screens/door.js';
import * as resultScreen from '../js/screens/result.js';
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

/**
 * js/screens/door.js measurePaper with this door corner error: what state.measure must then be. `byHand`
 * says which corners the customer placed, in the measured opening's [TL, TR, BR, BL] order (the handles
 * here start on quads in that order, so it is also their handle order). With it go the sigmas the same
 * sheet gives with every door corner placed by hand where that fit puts the opening (doorFitPx), which the
 * result screen reads (paperIssueCodes): not on the marked corners, whose misfit with the sheet would be
 * detection's error counted as the photo's (see the "off by a realistic amount" test below).
 */
function paperMeasure(state, doorPx, sigmaDoorPx, byHand) {
  const photo = state.photo;
  const input = {
    sheetPx: state.sheet.points,
    doorPx,
    sheetMm: getSheetMm(state, config),
    imageSize: { width: photo.width, height: photo.height },
    sigmaSheetPx: state.sheet.refined ? m.sigmaSheetRefinedPx : m.sigmaSheetManualPx,
    plausible: m.plausible,
  };
  const result = measureDoor({ ...input, sigmaDoorPx });
  assert.equal(result.ok, true, `measureDoor (${result.error})`);
  const handPlaced = byHand.every(Boolean) ? result : measureDoor({ ...input, doorPx: result.doorFitPx, sigmaDoorPx: m.sigmaDoorPx });
  assert.equal(handPlaced.ok, true, `measureDoor, all by hand (${handPlaced.error})`);
  return {
    ...result,
    method: 'paper',
    doorCornersByHand: [...byHand],
    sigmaIfHandPlaced: { widthMm: handPlaced.sigmaWidthMm, heightMm: handPlaced.sigmaHeightMm },
  };
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

/**
 * Check the first `count` handles with the keyboard, moving none: → selects handle 0 (nothing is selected
 * yet) and Tab each next one, and Enter confirms the selected one right where it is, the keyboard's press
 * and let go (the editor's onHandleCheck).
 */
function checkCornersByKey(screen, count) {
  for (let i = 0; i < count; i++) {
    screen.key(i === 0 ? 'ArrowRight' : 'Tab');
    screen.key('Enter');
  }
}

// The photo stage in the fake browser (tests/helpers/screen-dom.mjs), CSS px: the editor starts showing the whole photo in it.
const STAGE = { width: 360, height: 520 };

/**
 * Press each handle in turn with a finger and let go, the fingertip rolling 2 px right and 1 px down:
 * inside the editor's dead zone, so no handle moves. The handles are at `quad` on a photo shown whole.
 */
function pressCorners(dom, screen, quad, photo) {
  const canvas = screen.root.querySelector('canvas');
  if (!canvas) throw new Error('no photo on the door screen yet');
  const view = fitView(photo.width, photo.height, STAGE.width, STAGE.height);
  const finger = (type, at) => canvas.dispatch(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: at.x, clientY: at.y });
  for (const corner of quad) {
    const at = imageToScreen(view, corner);
    finger('pointerdown', at);
    finger('pointermove', { x: at.x + 2, y: at.y + 1 });
    finger('pointerup', { x: at.x + 2, y: at.y + 1 });
    dom.flushFrames();
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
    const detected = paperMeasure(paper, DOOR_PX, DETECTED_SIGMA_PX, ALL_DETECTED);
    const hand = paperMeasure(paper, DOOR_PX, m.sigmaDoorPx, ALL_BY_HAND);
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
      assert.deepEqual(state.measure, paperMeasure(state, DOOR_PX, DETECTED_SIGMA_PX, ALL_DETECTED));
      assert.notDeepEqual(state.measure, paperMeasure(state, DOOR_PX, m.sigmaDoorPx, ALL_BY_HAND), 'not as if the customer had dragged them');

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
      assert.deepEqual(state.measure, paperMeasure(state, DOOR_PX, DETECTED_SIGMA_PX, ALL_DETECTED));
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
      assert.deepEqual(state.measure, paperMeasure(state, nudged(DOOR_PX, 1), mixed, [true, false, false, false]));
      assert.notDeepEqual(state.measure, paperMeasure(state, nudged(DOOR_PX, 1), m.sigmaDoorPx, ALL_BY_HAND));

      // The first handle is still selected: Tab on to each of the other three and move it.
      for (let i = 1; i < 4; i++) {
        screen.key('Tab');
        screen.key('ArrowRight');
      }
      screen.press('Measure my door');
      assertMeasured(screen, 'all four moved');
      assert.deepEqual(state.door.points, nudged(DOOR_PX, 4));
      assert.deepEqual(state.door.byHand, ALL_BY_HAND);
      assert.deepEqual(state.measure, paperMeasure(state, nudged(DOOR_PX, 4), m.sigmaDoorPx, ALL_BY_HAND));
      screen.unmount();

      // Back from "Adjust corners": still the customer's own corners, still measurable without a drag.
      const again = dom.mount(door, { state, config });
      assert.deepEqual(state.door.byHand, ALL_BY_HAND);
      again.press('Measure my door');
      assertMeasured(again, 'second visit');
      assert.deepEqual(state.measure, paperMeasure(state, nudged(DOOR_PX, 4), m.sigmaDoorPx, ALL_BY_HAND));
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
      assert.deepEqual(state.measure, paperMeasure(state, TRIM_PX, DETECTED_SIGMA_PX, ALL_DETECTED));
      screen.unmount();

      // A picked outline counts as placed when the customer comes back, and is still detection's.
      const again = dom.mount(door, { state, config });
      again.press('Measure my door');
      assertMeasured(again, 'second visit');
      assert.equal(state.door.chosen, true);
      assert.deepEqual(state.measure, paperMeasure(state, TRIM_PX, DETECTED_SIGMA_PX, ALL_DETECTED));
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

  test('paper: the measurement says which corners the customer placed, in the measured opening\'s order', async () => {
    await inBrowser((dom) => {
      // Handles in another order than the opening's [TL, TR, BR, BL]: the same door, started on its
      // bottom-right corner, with only that handle (handle 0, the opening's BR) moved.
      const state = paperState(confidentDetection());
      state.door.points = [DOOR_PX[2], DOOR_PX[3], DOOR_PX[0], DOOR_PX[1]].map((p) => ({ x: p.x, y: p.y }));
      state.door.byHand = [false, false, false, false];
      const screen = dom.mount(door, { state, config });
      nudgeCorners(screen, 1);
      screen.press('Measure my door');
      assertMeasured(screen, 'BR moved');
      assert.deepEqual(state.door.byHand, [true, false, false, false], 'by handle');
      assert.deepEqual(state.measure.doorCornersByHand, [false, false, true, false], 'by corner of the opening: BR');
      screen.unmount();
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

// The bundled demo photo (assets/demo-door.png), by its own truth file: a clean, straight-on photo of an
// 820 x 2040 mm door with an A4 sheet. Detected corners left as they are read about ±42 mm, graded
// 'poor'; the same corners placed by hand read 'Good measurement' with nothing to fix.
const DEMO = JSON.parse(readFileSync(new URL('../assets/demo-door.truth.json', import.meta.url), 'utf8'));

/**
 * The paper demo at the door screen: the demo photo, its sheet found and refined, its door found (on its
 * true corners unless `detected` says where detection put them).
 */
function paperDemoState(detected = DEMO.doorPx) {
  const state = createInitialState(config);
  const photo = { width: DEMO.imageWidth, height: DEMO.imageHeight, canvas: null, image: null, isDemo: true, focal35mm: null, _luma: null };
  useDemoPhoto(state, photo, 'paper', m);
  state.sheet = { points: copy(DEMO.sheetPx), refined: true, detected: true, placed: true };
  state.door.detection = { ok: true, quad: copy(detected), confidence: 0.98, alternatives: [] };
  return state;
}

/** Mount the result screen on `state` the way the router does after "Measure my door", and read it. */
function resultShown(dom, state) {
  const screen = dom.mount(resultScreen, { state, config });
  const texts = (selector) => screen.root.querySelectorAll(selector).map((el) => el.textContent.trim());
  const say = (key, vars) => screen.ctx.t(key, vars);
  return {
    screen,
    say,
    issues: texts('.sm-result__issue'),
    chip: texts('.sm-chip__label'),
    accuracy: screen.root.querySelectorAll('.sm-result__accuracy').filter((el) => !el.hidden).map((el) => el.textContent),
    // The fake DOM takes no descendant selectors: the action bar's buttons, by their labels.
    actions: screen.root
      .querySelectorAll('.sm-actionbar')
      .flatMap((bar) => bar.querySelectorAll('.sm-btn__label'))
      .map((el) => el.textContent),
  };
}

describe('what the paper result says to do about a wide ± from corners detection placed (door, then result, in a fake browser)', () => {
  test('the demo door measured untouched: check the corners, not retake a photo that is fine, and the grade stays honest', async () => {
    await inBrowser((dom) => {
      const state = paperDemoState();
      const doorScreen = dom.mount(door, { state, config });
      doorScreen.press('Measure my door');
      assertMeasured(doorScreen, 'untouched');
      doorScreen.unmount();

      // Measured with detection's error, which is what makes it wide; by hand the same photo is fine.
      const { measure } = state;
      assert.equal(Math.round(measure.widthMm), 820);
      assert.equal(Math.round(measure.heightMm), 2040);
      assert.equal(measure.quality.level, 'poor');
      assert.deepEqual(measure.quality.issues, ['high_uncertainty']);
      assert.deepEqual(measure.doorCornersByHand, ALL_DETECTED);
      const byHandWorst = Math.max(measure.sigmaIfHandPlaced.widthMm, measure.sigmaIfHandPlaced.heightMm);
      assert.ok(byHandWorst <= QUALITY_THRESHOLDS.highUncertaintySigmaMm, `by hand: ±${byHandWorst.toFixed(1)} mm, 1 sigma`);

      const view = resultShown(dom, state);
      const { say } = view;
      assert.deepEqual(view.issues, [say('result.issue.corners_detected')]);
      assert.ok(!view.issues.includes(say('result.issue.high_uncertainty')), 'no "retake it" for a photo that is fine');
      // The grade and the ± are the measurement's own: a rough one, as wide as it is.
      assert.deepEqual(view.chip, [say('result.quality.rough')]);
      const mm = Math.max(2, Math.ceil(2 * Math.max(measure.sigmaWidthMm, measure.sigmaHeightMm)));
      assert.ok(mm >= 40, `±${mm} mm`);
      assert.deepEqual(view.accuracy, [say('result.accuracy', { mm })]);
      // Retake is not promoted: the way on is the price, and Adjust corners goes back to the corners.
      assert.deepEqual(view.actions, [say('result.continue')]);
      view.screen.press(say('result.adjustCorners'));
      assert.deepEqual(view.screen.went, ['door']);
      view.screen.unmount();

      // Doing what the tip says (each corner moved onto its corner: here a pixel each) tightens it up.
      const again = dom.mount(door, { state, config });
      nudgeCorners(again, 4);
      again.press('Measure my door');
      assertMeasured(again, 'all four placed');
      again.unmount();
      assert.deepEqual(state.measure.doorCornersByHand, ALL_BY_HAND);
      const checked = resultShown(dom, state);
      assert.deepEqual(checked.chip, [checked.say('result.quality.good')]);
      assert.deepEqual(checked.issues, [], 'nothing left to fix');
      checked.screen.unmount();
    });
  });

  test('doing what the tip says with corners that are already right: pressing each one and letting go counts as placed by hand', async () => {
    // The tip asks for each corner to be pressed and checked, and dragged only if it is out. Detection here
    // is right on the door, so the customer presses each corner, sees it is right and lets go: nothing
    // moves, and the measurement must still tighten up as if they had placed them.
    await inBrowser((dom) => {
      const state = paperDemoState();
      const first = dom.mount(door, { state, config });
      first.press('Measure my door');
      assertMeasured(first, 'untouched');
      first.unmount();
      const before = resultShown(dom, state);
      assert.deepEqual(before.issues, [before.say('result.issue.corners_detected')]);
      before.screen.unmount();

      const again = dom.mount(door, { state, config });
      pressCorners(dom, again, DEMO.doorPx, state.photo);
      assert.equal(state.measure, null, 'a checked corner has a new ±: the earlier measurement is dropped');
      again.press('Measure my door');
      assertMeasured(again, 'all four checked');
      again.unmount();

      assert.deepEqual(state.door.points, DEMO.doorPx, 'nothing moved');
      assert.deepEqual(state.door.byHand, ALL_BY_HAND);
      assert.deepEqual(state.measure.doorCornersByHand, ALL_BY_HAND);
      assert.deepEqual(state.measure, paperMeasure(state, DEMO.doorPx, m.sigmaDoorPx, ALL_BY_HAND));
      const checked = resultShown(dom, state);
      assert.deepEqual(checked.chip, [checked.say('result.quality.good')]);
      assert.deepEqual(checked.issues, [], 'nothing left to fix');
      checked.screen.unmount();
    });
  });

  test('a corner confirmed with Enter and left where it is counts as placed by hand, alongside the ones nudged', async () => {
    // Detection put TL, TR and BR a pixel left of the door and BL exactly on it. The customer nudges the
    // first three onto the door, Tabs on to BL and presses Enter on it: BL is right, so it is confirmed
    // without moving it.
    const detected = DEMO.doorPx.map((p, i) => ({ x: i < 3 ? p.x - 1 : p.x, y: p.y }));
    await inBrowser((dom) => {
      const state = paperDemoState(detected);
      const screen = dom.mount(door, { state, config });
      nudgeCorners(screen, 3);
      assert.deepEqual(state.door.byHand, [true, true, true, false], 'three nudged, BL not yet looked at');
      screen.key('Tab');
      assert.deepEqual(state.door.byHand, [true, true, true, false], 'Tab only selects BL');
      screen.key('Enter'); // the keyboard's press and let go: checks the selected corner where it is
      assert.deepEqual(state.door.byHand, ALL_BY_HAND, 'BL checked');
      screen.press('Measure my door');
      assertMeasured(screen, 'three nudged, one checked');
      screen.unmount();

      assert.deepEqual(state.door.points, nudged(detected, 3));
      assert.deepEqual(state.measure.doorCornersByHand, ALL_BY_HAND);
      assert.deepEqual(state.measure, paperMeasure(state, nudged(detected, 3), m.sigmaDoorPx, ALL_BY_HAND));
      const view = resultShown(dom, state);
      assert.deepEqual(view.issues, [], 'nothing left to fix');
      view.screen.unmount();
    });
  });

  test('checking the corners of the stand-in rectangle, even all four, is not placing them: still "drag the corners first", on this visit and the next', async () => {
    // Nothing found: the handles start on the detector's stand-in rectangle, which is nobody's door.
    const state = paperState({ ok: false, quad: null, confidence: 0, alternatives: [], reason: 'no_lines' });
    await inBrowser((dom) => {
      const screen = dom.mount(door, { state, config });
      // Every corner checked where it is, moving nothing (→ selects handle 0 and Enter checks it, then Tab
      // on to each of the others and Enter): on an outline detection drew, that would place them.
      checkCornersByKey(screen, 4);
      screen.press('Measure my door');
      assert.deepEqual(screen.toasts.map((toast) => toast.text), [screen.ctx.t('door.error.untouched')]);
      assert.deepEqual(screen.went, []);
      assert.equal(state.door.points, null, 'not kept as corners the customer placed');
      screen.unmount();

      const again = dom.mount(door, { state, config });
      again.press('Measure my door');
      assert.deepEqual(again.toasts.map((toast) => toast.text), [again.ctx.t('door.error.untouched')]);
      assert.deepEqual(again.went, []);
      again.unmount();
    });
  });

  test('an outline detection was unsure of but got right: every corner checked where it is, and it measures, with no corner moved', async () => {
    // Detection found the door but was not sure of it (confidence 0.6 or below), so the banner asks for the
    // corners to be placed. The customer presses each corner (or selects it and presses Enter or Space), sees
    // it is right and lets go. With one outline there is no "Not this? Show the next outline", so unless the
    // checks count, the only way on is to nudge a correct corner off its spot.
    const unsure = () => ({ ok: true, quad: copy(DOOR_PX), confidence: 0.5, alternatives: [] });
    await inBrowser((dom) => {
      // Paper, by finger.
      const state = paperState(unsure());
      const screen = dom.mount(door, { state, config });
      const untouched = screen.ctx.t('door.error.untouched');
      assert.deepEqual(
        screen.root.querySelectorAll('.sm-banner').map((el) => el.textContent.trim()),
        [screen.ctx.t('door.banner')],
        'not "we found your door"',
      );
      assert.equal(screen.button(screen.ctx.t('door.outline.next')).hidden, true, 'one outline: nothing to step through');
      // Three corners checked is not yet the outline accepted: the fourth has not been looked at.
      pressCorners(dom, screen, DOOR_PX.slice(0, 3), state.photo);
      screen.press('Measure my door');
      assert.deepEqual(screen.toasts.map((toast) => toast.text), [untouched]);
      assert.deepEqual(screen.went, []);
      pressCorners(dom, screen, DOOR_PX.slice(3), state.photo);
      assert.deepEqual(state.door.byHand, ALL_BY_HAND, 'the last check keeps the corners, with every one by hand');
      screen.press('Measure my door');
      assert.deepEqual(screen.toasts.map((toast) => toast.text), [untouched], 'no "drag the corners first" this time');
      assert.deepEqual(screen.went, ['result']);
      screen.unmount();
      assert.deepEqual(state.door.points, DOOR_PX, 'nothing moved');
      assert.deepEqual(state.measure, paperMeasure(state, DOOR_PX, m.sigmaDoorPx, ALL_BY_HAND), 'measured as placed by hand');

      // No paper, by keyboard.
      const estimate = estimateState(unsure());
      const keys = dom.mount(door, { state: estimate, config });
      // → selects the first corner and Enter checks it; Tab on to each of the others and Space checks it.
      keys.key('ArrowRight');
      keys.key('Enter');
      for (let i = 0; i < 3; i++) {
        keys.key('Tab');
        keys.key(' ');
      }
      keys.press('Find my door size');
      assertMeasured(keys, 'every corner checked with the keyboard');
      keys.unmount();
      assert.deepEqual(estimate.door.points, DOOR_PX, 'nothing moved');
      assert.deepEqual(estimate.door.byHand, ALL_BY_HAND);
      assert.deepEqual(estimate.measure, estimateMeasure(estimate, DOOR_PX, undefined), 'with a tap\'s error');
    });
  });

  test('detected corners off by a realistic amount, on a photo that is fine by hand: only "check the corners", never "retake it"', async () => {
    // Detection is never exactly on the corners: on the bench it is typically about 8 px out on a 2048 px
    // photo, and one corner in ten more than 19 px. Each set here moves the four corners in different
    // directions, which no flat rectangle fits, by about 8.5 px (6 px each way) and about 14 px.
    const OFFSETS = [
      [[-6, 6], [6, -6], [-6, -6], [6, 6]],
      [[12, -8], [-9, 11], [7, 13], [-13, -5]],
    ];
    // What the photo itself allows: its true corners, each placed by hand.
    const input = {
      sheetPx: DEMO.sheetPx,
      sheetMm: getSheetMm(paperDemoState(), config),
      imageSize: { width: DEMO.imageWidth, height: DEMO.imageHeight },
      sigmaSheetPx: m.sigmaSheetRefinedPx,
      plausible: m.plausible,
    };
    const byHand = measureDoor({ ...input, doorPx: DEMO.doorPx, sigmaDoorPx: m.sigmaDoorPx });
    assert.equal(byHand.quality.level, 'good', 'the fixture: by hand, the demo photo is fine');

    for (const offsets of OFFSETS) {
      const label = JSON.stringify(offsets);
      const detected = DEMO.doorPx.map((p, i) => ({ x: p.x + offsets[i][0], y: p.y + offsets[i][1] }));
      await inBrowser((dom) => {
        const state = paperDemoState(detected);
        const doorScreen = dom.mount(door, { state, config });
        doorScreen.press('Measure my door');
        assertMeasured(doorScreen, `${label}: untouched`);
        doorScreen.unmount();

        const { measure } = state;
        assert.deepEqual(measure.doorCornersByHand, ALL_DETECTED, label);
        assert.ok(measure.quality.issues.includes('high_uncertainty'), `${label}: wide, from detection's error`);
        // The photo's own part is the photo's, whichever way detection happened to be off: the misfit of
        // detection's corners is not counted as the photo's (measureDoor's fit.sigmaScale).
        assert.ok(Math.abs(measure.sigmaIfHandPlaced.widthMm - byHand.sigmaWidthMm) < 1, `${label}: width, by hand ±${measure.sigmaIfHandPlaced.widthMm.toFixed(1)} mm`);
        assert.ok(Math.abs(measure.sigmaIfHandPlaced.heightMm - byHand.sigmaHeightMm) < 1, `${label}: height, by hand ±${measure.sigmaIfHandPlaced.heightMm.toFixed(1)} mm`);

        const view = resultShown(dom, state);
        assert.deepEqual(view.issues, [view.say('result.issue.corners_detected')], `${label}: check the corners`);
        assert.ok(!view.issues.includes(view.say('result.issue.high_uncertainty')), `${label}: no "retake it" for a photo that is fine`);
        view.screen.unmount();
      });
    }
  });

  test('when the photo would be wide even with every corner placed by hand, its own tip follows', async () => {
    await inBrowser((dom) => {
      // This file's 1200 x 1600 photo, taken from further away: by hand it is still above ±12 mm (1 sigma).
      const state = paperState();
      const doorScreen = dom.mount(door, { state, config });
      doorScreen.press('Measure my door');
      assertMeasured(doorScreen, 'untouched');
      doorScreen.unmount();
      assert.ok(state.measure.quality.issues.includes('high_uncertainty'));
      const byHandWorst = Math.max(state.measure.sigmaIfHandPlaced.widthMm, state.measure.sigmaIfHandPlaced.heightMm);
      assert.ok(byHandWorst > QUALITY_THRESHOLDS.highUncertaintySigmaMm, `by hand: ±${byHandWorst.toFixed(1)} mm, 1 sigma`);

      const view = resultShown(dom, state);
      assert.deepEqual(view.issues, [view.say('result.issue.corners_detected'), view.say('result.issue.high_uncertainty')]);
      view.screen.unmount();
    });
  });

  test('corners the customer placed themselves keep the photo\'s own tip alone', async () => {
    await inBrowser((dom) => {
      const state = paperState();
      const doorScreen = dom.mount(door, { state, config });
      nudgeCorners(doorScreen, 4);
      doorScreen.press('Measure my door');
      assertMeasured(doorScreen, 'all four placed');
      doorScreen.unmount();
      assert.deepEqual(state.measure.doorCornersByHand, ALL_BY_HAND);
      assert.ok(state.measure.quality.issues.includes('high_uncertainty'), state.measure.quality.issues.join(', '));

      const view = resultShown(dom, state);
      assert.deepEqual(view.issues, [view.say('result.issue.high_uncertainty')]);
      view.screen.unmount();
    });
  });
});
