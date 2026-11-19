// The result screen's pure logic, from js/screens/result.js and js/screens/result-standard.js:
//  - when a 'poor' paper result is shown as "Check your photo" because the sheet could be either way
//    round, rather than as an ordinary "Rough measurement";
//  - which mode the screen shows, and for the two no-paper modes which sizes, banners, issue lines and
//    buttons it offers, the height labels on the estimate's sizes, the AR "closest standard size"
//    rule, and the 'measured' event it sends;
//  - mounted on a small stand-in for the DOM: the manual-entry screen's buttons, the estimate
//    screen's badges, banner and issue lines as a customer sees them;
//  - after the real door screen (js/screens/door.js, in tests/helpers/screen-dom.mjs's fake browser):
//    the paper screen's tips for a wide ± when door corners were left where detection put them, and the
//    bundled demo photo's estimate banner.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { measureDoor, QUALITY_THRESHOLDS } from '../js/geometry.js';
import { estimateFromCorners, nearestStandard, planeToImageFor, standardSizesFrom } from '../js/estimate.js';
import { createTranslator } from '../js/strings.js';
import { demoPhotoFocal35mm, useDemoPhoto } from '../js/demo.js';
import * as doorScreen from '../js/screens/door.js';
import * as resultScreen from '../js/screens/result.js';
import {
  CORNERS_TIP_MAX_RATIO,
  canEnter,
  cornersLeftToDetection,
  handPlacingTightens,
  manualAlternative,
  measureInstead,
  mount,
  orientationUnclear,
  paperIssueCodes,
  resultMode,
  strings,
  uncertainEvenByHand,
} from '../js/screens/result.js';
import { createInitialState, FALLBACK_GUARDS, resolveScreenId } from '../js/app.js';
import { deepMerge, measurementMethods } from '../js/theme.js';
import * as ui from '../js/ui.js';
import {
  AR_STANDARD_TOLERANCE,
  AR_WARNINGS,
  ESTIMATE_ISSUES,
  HEIGHT_FAMILIES,
  HEIGHT_FAMILY_MERGE_MM,
  HEIGHT_MATCH_MM,
  MAX_CHOICES,
  arWarningKeys,
  choiceBadgeKey,
  choiceBadgeText,
  choiceHeightFamilies,
  closestStandard,
  estimateBannerKey,
  estimateChoices,
  estimateIssueKeys,
  heightFamilies,
  heightFamilyKey,
  heightFamilyOf,
  heightQuestionKey,
  measuredPayload,
  offersPaper,
  parseMm,
  resultTools,
  sameSize,
  strings as standardStrings,
} from '../js/screens/result-standard.js';
import { PREVIEW_MARGIN_MM, canPreview } from '../js/screens/result-preview.js';
import { SHIPPED_CONFIG } from './helpers/shipped-config.mjs';
import { installFakeDom } from './helpers/screen-dom.mjs';
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

/* ------------------------------------------------------------------ */
/* Paper: what a wide "plus or minus" is put down to                   */
/* ------------------------------------------------------------------ */

describe('paperIssueCodes: a wide ± from corners detection placed asks for the corners to be checked', () => {
  const NONE = [false, false, false, false];
  const ALL = [true, true, true, true];
  const limit = QUALITY_THRESHOLDS.highUncertaintySigmaMm;
  // The bundled demo measured untouched, as door.js keeps it: 'poor' for detection's corner error alone.
  const demo = (overrides = {}) => ({
    method: 'paper',
    widthMm: 822,
    heightMm: 2047,
    sigmaWidthMm: 13.1,
    sigmaHeightMm: 21,
    quality: { level: 'poor', issues: ['high_uncertainty'] },
    fit: { orientationMargin: 60 },
    doorCornersByHand: NONE,
    sigmaIfHandPlaced: { widthMm: 4.5, heightMm: 7.9 },
    ...overrides,
  });
  const codes = (measure, sheetMm = A4) => paperIssueCodes(measure, measure.quality.level, sheetMm);

  test('detected corners, and a photo that is fine by hand: the corners tip instead of "retake it"', () => {
    assert.deepEqual(codes(demo()), ['corners_detected']);
    // Any one corner left where detection put it is enough.
    for (let i = 0; i < 4; i += 1) {
      assert.deepEqual(codes(demo({ doorCornersByHand: ALL.map((v, j) => j !== i) })), ['corners_detected'], `corner ${i}`);
    }
    // Exactly at the limit is not 'high_uncertainty' (measureDoor's own rule: above it).
    assert.deepEqual(codes(demo({ sigmaIfHandPlaced: { widthMm: limit, heightMm: limit } })), ['corners_detected']);
    // A 'fair' grade with the issue is the same story.
    assert.deepEqual(codes(demo({ quality: { level: 'fair', issues: ['high_uncertainty'] } })), ['corners_detected']);
  });

  test('wide even with every corner placed by hand: the photo is part of it, so its tip follows', () => {
    assert.deepEqual(codes(demo({ sigmaIfHandPlaced: { widthMm: 7.6, heightMm: limit + 0.5 } })), ['corners_detected', 'high_uncertainty']);
    assert.deepEqual(codes(demo({ sigmaIfHandPlaced: { widthMm: limit + 3, heightMm: 4 } })), ['corners_detected', 'high_uncertainty']);
    // Not known (no figures, or not numbers): nobody knows the corners are the whole story.
    for (const sigmaIfHandPlaced of [undefined, null, {}, { widthMm: 4, heightMm: null }, { widthMm: '4', heightMm: '4' }, { widthMm: NaN, heightMm: 4 }]) {
      assert.deepEqual(codes(demo({ sigmaIfHandPlaced })), ['corners_detected', 'high_uncertainty'], JSON.stringify(sigmaIfHandPlaced));
    }
  });

  test('corners the customer placed, or a measurement that does not say: unchanged', () => {
    assert.deepEqual(codes(demo({ doorCornersByHand: ALL })), ['high_uncertainty']);
    for (const doorCornersByHand of [undefined, null, [false, false, false], 'none']) {
      assert.deepEqual(codes(demo({ doorCornersByHand })), ['high_uncertainty'], String(doorCornersByHand));
    }
    assert.equal(cornersLeftToDetection(demo({ doorCornersByHand: undefined })), false);
    assert.equal(cornersLeftToDetection(demo({ doorCornersByHand: [true, true, 1, true] })), true, 'only true is by hand');
  });

  test('every other tip is kept as it was, in its place, once', () => {
    const issues = ['steep_angle', 'door_small', 'steep_angle', 'high_uncertainty'];
    assert.deepEqual(codes(demo({ quality: { level: 'poor', issues } })), ['steep_angle', 'door_small', 'corners_detected']);
    assert.deepEqual(codes(demo({ quality: { level: 'poor', issues: ['high_residual', 'high_uncertainty'] } })), ['high_residual', 'corners_detected']);
    // No wide ±: nothing to put down to the corners, whoever placed them.
    assert.deepEqual(codes(demo({ quality: { level: 'fair', issues: ['door_near_edge'] } })), ['door_near_edge']);
    assert.deepEqual(codes(demo({ quality: { level: 'good', issues: [] } })), []);
    assert.deepEqual(paperIssueCodes(demo({ quality: undefined }), 'fair', A4), []);
  });

  test('an undecided sheet orientation still comes first and stands in for the wide ±', () => {
    const measure = demo({ fit: { orientationMargin: 0.1 } });
    assert.deepEqual(codes(measure), ['orientation_unclear']);
    assert.deepEqual(codes({ ...measure, quality: { level: 'poor', issues: ['door_small', 'high_uncertainty'] } }), ['orientation_unclear', 'door_small']);
  });

  test('uncertainEvenByHand is measureDoor\'s own high_uncertainty rule on the by-hand sigmas', () => {
    assert.equal(uncertainEvenByHand({ sigmaIfHandPlaced: { widthMm: limit, heightMm: 1 } }), false);
    assert.equal(uncertainEvenByHand({ sigmaIfHandPlaced: { widthMm: 1, heightMm: limit + 0.01 } }), true);
    assert.equal(uncertainEvenByHand({}), true);
    assert.equal(uncertainEvenByHand(null), true);
  });

  test('the corners tip has copy, and points at the button it names', () => {
    const t = createTranslator(SHIPPED_CONFIG, strings);
    assert.equal(
      strings['result.issue.corners_detected'],
      'We placed the door corners for you. To tighten this up, tap Adjust corners, zoom in and press each corner to check it sits exactly where the door meets the frame, dragging it there if not.',
    );
    assert.ok(t('result.issue.corners_detected').includes(t('result.adjustCorners')));
  });

  test('the corners tip asks for every corner to be checked, not only the wrong ones dragged', () => {
    // The review's case: the demo door measured untouched, every detected corner already exactly right.
    // "Drag each one exactly onto its corner" left nothing to do with a corner that was already there, so
    // the tip came back after every visit to Adjust corners. Pressing a corner (the magnifier shows it close
    // up) and letting go is the check, and it must be what the tip asks for.
    const tip = strings['result.issue.corners_detected'];
    assert.match(tip, /\bpress each corner\b/);
    assert.match(tip, /\bdragging it there if not\b/);
    assert.doesNotMatch(tip, /\bdrag each one\b/);
  });

  test('placing the corners by hand must take at least a fifth off a ± that stays wide', () => {
    assert.equal(CORNERS_TIP_MAX_RATIO, 0.8);
    // Still wide by hand (worst 21 mm measured): the corners tip leads only for a real difference.
    const wide = limit + 2;
    const at = (byHandWorst) => codes(demo({ sigmaIfHandPlaced: { widthMm: 5, heightMm: byHandWorst } }));
    assert.deepEqual(at(0.8 * 21), ['corners_detected', 'high_uncertainty'], 'exactly a fifth off');
    assert.deepEqual(at(0.8 * 21 + 0.01), ['high_uncertainty'], 'just under a fifth off');
    assert.deepEqual(at(wide), ['corners_detected', 'high_uncertainty']);
    // The sheet sets the ±: an A4 sheet placed by hand, three corners by hand and one detected (±47 to ±43 mm).
    const sheetLimited = { sigmaWidthMm: 12.1, sigmaHeightMm: 23.13, doorCornersByHand: [true, true, true, false], sigmaIfHandPlaced: { widthMm: 11.4, heightMm: 21.32 } };
    assert.deepEqual(codes(demo(sheetLimited)), ['high_uncertainty']);
    assert.equal(handPlacingTightens(demo(sheetLimited)), false);
    // A bank card: by hand changes nothing worth the trip, and its own tips stay in their places.
    const card = { quality: { level: 'poor', issues: ['sheet_small', 'high_uncertainty'] }, sigmaWidthMm: 60, sigmaHeightMm: 115.5, sigmaIfHandPlaced: { widthMm: 59.8, heightMm: 115.2 } };
    assert.deepEqual(codes(demo(card)), ['sheet_small', 'high_uncertainty']);
    // A company sigmaDoorPx at or above detection's: by hand is the measurement itself.
    assert.deepEqual(codes(demo({ sigmaIfHandPlaced: { widthMm: 13.1, heightMm: 21 } })), ['high_uncertainty']);
    assert.deepEqual(codes(demo({ sigmaIfHandPlaced: { widthMm: 14, heightMm: 22 } })), ['high_uncertainty'], 'worse by hand');
  });

  test('a ± that placing the corners by hand would clear gets the corners tip, however small the step', () => {
    // 12.4 mm measured, 11.9 mm by hand: only a few per cent, but it is the step that clears 'high_uncertainty'.
    const justOver = demo({ quality: { level: 'fair', issues: ['high_uncertainty'] }, sigmaWidthMm: 8, sigmaHeightMm: limit + 0.4, sigmaIfHandPlaced: { widthMm: 7.8, heightMm: limit - 0.1 } });
    assert.deepEqual(codes(justOver), ['corners_detected']);
    assert.equal(handPlacingTightens(justOver), true);
  });

  test('handPlacingTightens: unknown figures keep the corners tip, as before they were compared', () => {
    assert.equal(handPlacingTightens(demo()), true);
    for (const sigmaIfHandPlaced of [undefined, null, { widthMm: 4, heightMm: null }]) {
      assert.equal(handPlacingTightens(demo({ sigmaIfHandPlaced })), true, JSON.stringify(sigmaIfHandPlaced));
    }
    // The measured sigmas missing (measureDoor always gives them): no ratio to go by.
    const byHandWide = { widthMm: limit + 5, heightMm: limit + 5 };
    for (const sigmaHeightMm of [undefined, NaN, '21', -1]) {
      assert.equal(handPlacingTightens(demo({ sigmaHeightMm, sigmaIfHandPlaced: byHandWide })), true, String(sigmaHeightMm));
    }
  });
});

/* ------------------------------------------------------------------ */
/* After the real door screen, in a fake browser                       */
/* ------------------------------------------------------------------ */

/** Run `fn` with tests/helpers/screen-dom.mjs's fake browser installed, and take it away again whatever happens. */
async function inFakeBrowser(fn) {
  const dom = installFakeDom();
  try {
    return await fn(dom);
  } finally {
    dom.uninstall();
  }
}

/**
 * Press → on the door screen's photo for each of the first `count` handles, Tab moving on to the next: each
 * moves a pixel right, and is from then on a corner the customer placed. The rest stay where detection put them.
 */
function nudgeCorners(screen, count) {
  for (let i = 0; i < count; i++) {
    // The first → selects handle 0 (nothing is selected yet); Tab moves on to the next one.
    screen.key(i === 0 ? 'ArrowRight' : 'Tab');
    screen.key('ArrowRight');
  }
}

/**
 * Mount js/screens/door.js on `state`, nudge the first `nudges` handles, press its measure button, then mount
 * js/screens/result.js on what the door screen recorded, as the router does. Nothing stands in for the
 * measuring: state.measure is the door screen's own (measurePaper or measureEstimate).
 * `choices` is the estimate's list of sizes as the customer meets it: the card's heading and hint, and the
 * radio group's accessible name (what a screen reader announces in place of the heading).
 * @returns {Promise<{ state: object, issues: string[], chip: string[], banner: string[], badges: string[],
 *   choices: { title: string[], hint: string[], ariaLabel: Array<string | null> }, t: Function }>}
 */
function doorThenResult(state, { config = SHIPPED_CONFIG, nudges = 0 } = {}) {
  return inFakeBrowser((dom) => {
    const door = dom.mount(doorScreen, { state, config });
    nudgeCorners(door, nudges);
    door.press(door.ctx.t(state.method === 'estimate' ? 'door.estimate.measure' : 'door.measure'));
    assert.deepEqual(door.toasts, [], 'measured, with no message');
    assert.equal(door.went.at(-1), 'result');
    door.unmount();

    const result = dom.mount(resultScreen, { state, config });
    const texts = (selector, root = result.root) => root.querySelectorAll(selector).map((el) => el.textContent.trim());
    // The fake DOM knows no descendant selectors: look inside the choices card itself.
    const choicesCard = result.root.querySelector('.sm-result__choices');
    const view = {
      state,
      t: result.ctx.t,
      issues: texts('.sm-result__issue'),
      chip: texts('.sm-chip__label'),
      banner: texts('.sm-banner').filter(Boolean),
      badges: texts('.sm-radiocard__badge'),
      choices: {
        title: choicesCard ? texts('.sm-result__section-title', choicesCard) : [],
        hint: choicesCard ? texts('.sm-result__section-hint', choicesCard) : [],
        ariaLabel: choicesCard ? choicesCard.querySelectorAll('[role="radiogroup"]').map((el) => el.getAttribute('aria-label')) : [],
      },
    };
    result.unmount();
    return view;
  });
}

describe('the paper result after the real door screen: a wide ± from detected corners, and what it is put down to', () => {
  const NONE = [false, false, false, false];
  const THREE = [true, true, true, false];
  // An 820 x 2040 mm door photographed 2.8 m away on a 1920 x 2560 photo, the sheet taped halfway up.
  const CAMERA = cameraHomography({ imageWidth: IMAGE.width, imageHeight: IMAGE.height, focalPx: 0.72 * 2560, target: { x: 410, y: 1020 }, distanceMm: 2800, yawDeg: 3, pitchDeg: -2 });
  const DOOR_PX = [[0, 0], [820, 0], [820, 2040], [0, 2040]].map(([x, y]) => projectPoint(CAMERA, { x, y }));
  const sheetOnPhoto = (sheetMm) =>
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => projectPoint(CAMERA, { x: 410 + (sx * sheetMm.w) / 2, y: 1100 + (sy * sheetMm.h) / 2 }));

  /**
   * The paper way in at the door screen: detection sure of the door (the handles start on it, in
   * [TL, TR, BR, BL] order, so handle i is corner i), the sheet's corners found (`refined`) or placed by
   * hand, then "Measure my door" after `nudges` handles are moved, and the result screen.
   */
  function paper({ sheetMm = A4, referenceId = 'a4', refined, nudges, config = SHIPPED_CONFIG }) {
    const state = createInitialState(config);
    state.method = 'paper';
    state.referenceId = referenceId;
    state.photo = { width: IMAGE.width, height: IMAGE.height, canvas: { ...IMAGE }, image: null, isDemo: false, capture: 'frame', focal35mm: null, _luma: null };
    state.sheet = { points: sheetOnPhoto(sheetMm), refined, detected: refined, placed: true };
    state.door = { points: null, detection: { ok: true, quad: DOOR_PX.map((p) => ({ ...p })), confidence: 0.86, alternatives: [] } };
    return doorThenResult(state, { config, nudges });
  }

  const worst = (sigmas) => Math.max(sigmas.widthMm, sigmas.heightMm);
  /** What is left of the worse ± once every corner is placed by hand: 1 means placing them changes nothing. */
  const gain = (measure) => worst(measure.sigmaIfHandPlaced) / worst({ widthMm: measure.sigmaWidthMm, heightMm: measure.sigmaHeightMm });
  const pct = (measure) => `by hand leaves ${(100 * gain(measure)).toFixed(0)}% of the ±`;

  test('an A4 sheet placed by hand sets the ±: no trip to Adjust corners for a few mm, the photo\'s own tip alone', async () => {
    // The review's case: three door corners placed by hand, one left where detection put it. The by-hand
    // figure is the door screen's own, so it is measured with the sheet as it was placed: by hand, 2 px.
    const { state, issues, chip } = await paper({ refined: false, nudges: 3 });
    const { measure } = state;
    assert.deepEqual(measure.doorCornersByHand, THREE);
    assert.ok(measure.quality.issues.includes('high_uncertainty'), measure.quality.issues.join(', '));
    assert.deepEqual(issues, [strings['result.issue.high_uncertainty']]);
    assert.deepEqual(chip, [strings['result.quality.rough']], 'the grade is the measurement\'s own');
    // Why: wide even by hand, and placing the corners would take less than a fifth off.
    assert.equal(uncertainEvenByHand(measure), true, `by hand ±${worst(measure.sigmaIfHandPlaced).toFixed(1)} mm, 1 sigma`);
    assert.ok(gain(measure) > CORNERS_TIP_MAX_RATIO, pct(measure));
    assert.equal(handPlacingTightens(measure), false);

    // The same door corners with the sheet found: by hand is far tighter, because the sheet is.
    const found = (await paper({ refined: true, nudges: 3 })).state.measure;
    assert.ok(
      worst(measure.sigmaIfHandPlaced) > 2 * worst(found.sigmaIfHandPlaced),
      `by hand: ±${worst(measure.sigmaIfHandPlaced).toFixed(1)} mm with the sheet placed by hand, ±${worst(found.sigmaIfHandPlaced).toFixed(1)} mm found`,
    );
  });

  test('a bank card placed by hand: its own tips, and no corners tip', async () => {
    const { state, issues } = await paper({ sheetMm: CARD, referenceId: 'card', refined: false, nudges: 3 });
    assert.deepEqual(state.measure.doorCornersByHand, THREE);
    assert.deepEqual(issues, [strings['result.issue.sheet_small'], strings['result.issue.high_uncertainty']]);
    assert.ok(gain(state.measure) > CORNERS_TIP_MAX_RATIO, pct(state.measure));
  });

  test('a company sigmaDoorPx no better than detection\'s: by hand is the measurement itself, so no corners tip', async () => {
    const coarse = deepMerge(SHIPPED_CONFIG, { measurement: { sigmaDoorPx: 12 } });
    for (const nudges of [0, 3]) {
      const { state, issues } = await paper({ refined: true, nudges, config: coarse });
      // Remeasured on the fitted opening (door.js measurePaper), so not to the last digit.
      assert.ok(Math.abs(gain(state.measure) - 1) < 0.01, `${nudges} nudged: ${pct(state.measure)}`);
      assert.deepEqual(issues, [strings['result.issue.high_uncertainty']], `${nudges} nudged`);
    }
  });

  test('where checking the corners does pay, the corners tip still leads', async () => {
    // A found sheet, every door corner left to detection: the corners are the whole story.
    const found = await paper({ refined: true, nudges: 0 });
    assert.deepEqual(found.state.measure.doorCornersByHand, NONE);
    assert.deepEqual(found.issues, [strings['result.issue.corners_detected']]);
    assert.ok(gain(found.state.measure) <= CORNERS_TIP_MAX_RATIO, pct(found.state.measure));
    // An A4 sheet placed by hand with all four door corners left to detection: still wide by hand, so the
    // photo's tip follows, but checking the corners takes more than a fifth off.
    const unchecked = await paper({ refined: false, nudges: 0 });
    assert.deepEqual(unchecked.issues, [strings['result.issue.corners_detected'], strings['result.issue.high_uncertainty']]);
    assert.ok(gain(unchecked.state.measure) <= CORNERS_TIP_MAX_RATIO, pct(unchecked.state.measure));
    assert.equal(uncertainEvenByHand(unchecked.state.measure), true);
  });
});

/* ------------------------------------------------------------------ */
/* Which mode the screen shows                                         */
/* ------------------------------------------------------------------ */

const candidate = (widthMm, heightMm, p) => ({ widthMm, heightMm, p, zAspect: 0 });
const estimate = (overrides = {}) => ({
  method: 'estimate',
  ok: true,
  candidates: [candidate(820, 2040, 0.7), candidate(870, 2100, 0.2), candidate(770, 2040, 0.06), candidate(920, 2340, 0.04)],
  confident: false,
  nonStandard: false,
  issues: [],
  widthMm: 820,
  heightMm: 2040,
  ...overrides,
});
const arMeasure = (overrides = {}) => ({
  method: 'ar',
  ok: true,
  widthMm: 838.4,
  heightMm: 2071.6,
  warnings: [],
  candidates: [candidate(820, 2040, 0.8), candidate(870, 2100, 0.15)],
  runs: 1,
  ...overrides,
});

describe('resultMode', () => {
  test('dispatches on how the door was measured', () => {
    assert.equal(resultMode({ measure: null, manualEntry: true }), 'manual');
    assert.equal(resultMode({}), 'manual');
    // The paper measure predates measure.method; door.js may now add method: 'paper'.
    assert.equal(resultMode({ measure: { widthMm: 820, heightMm: 2040, quality: { level: 'good' } } }), 'paper');
    assert.equal(resultMode({ measure: { method: 'paper', widthMm: 820, heightMm: 2040 } }), 'paper');
    assert.equal(resultMode({ measure: estimate() }), 'estimate');
    assert.equal(resultMode({ measure: arMeasure() }), 'ar');
  });

  test('a no-paper measure with no usable size asks for the size instead of showing blanks', () => {
    assert.equal(resultMode({ measure: estimate({ candidates: [], widthMm: NaN, heightMm: NaN }) }), 'manual');
    assert.equal(resultMode({ measure: arMeasure({ widthMm: NaN }) }), 'manual');
    assert.equal(resultMode({ measure: arMeasure({ heightMm: 0 }) }), 'manual');
    // No candidate list, but the measure's own size is still the best match.
    assert.equal(resultMode({ measure: estimate({ candidates: undefined }) }), 'estimate');
  });
});

/* ------------------------------------------------------------------ */
/* Estimate mode                                                       */
/* ------------------------------------------------------------------ */

describe('estimateChoices', () => {
  test('offers the most likely size and up to two more with a real chance', () => {
    const choices = estimateChoices(estimate());
    assert.equal(MAX_CHOICES, 3);
    assert.deepEqual(
      choices.map(({ widthMm, heightMm }) => [widthMm, heightMm]),
      [[820, 2040], [870, 2100], [770, 2040]],
    );
    assert.deepEqual(choices.map((choice) => choice.key), ['820x2040', '870x2100', '770x2040']);
    assert.deepEqual(choices.map((choice) => choice.p), [0.7, 0.2, 0.06]);
  });

  test('a size under 5 % is not offered, but the most likely size always is', () => {
    const confident = estimate({ candidates: [candidate(820, 2040, 0.97), candidate(870, 2100, 0.049), candidate(770, 2040, 0.01)] });
    assert.deepEqual(estimateChoices(confident).map((choice) => choice.key), ['820x2040']);
    const flat = estimate({ candidates: [candidate(820, 2040, 0.03), candidate(870, 2100, 0.05)] });
    assert.deepEqual(estimateChoices(flat).map((choice) => choice.key), ['820x2040', '870x2100']);
  });

  test('skips unusable entries and repeats, and falls back to the measure size', () => {
    const messy = estimate({
      candidates: [null, candidate(NaN, 2040, 0.5), candidate(820, 2040, 0.4), candidate(820, 2040, 0.3), candidate(-5, 2040, 0.2), candidate(870, 2100, 0.1)],
    });
    assert.deepEqual(estimateChoices(messy).map((choice) => choice.key), ['820x2040', '870x2100']);
    assert.deepEqual(estimateChoices(estimate({ candidates: [] })).map((choice) => choice.key), ['820x2040']);
    assert.deepEqual(estimateChoices(estimate({ candidates: [], widthMm: undefined })), []);
    assert.deepEqual(estimateChoices(null), []);
  });

  test('the first size is "Most likely", the rest "Also possible"', () => {
    assert.equal(choiceBadgeKey(0), 'result.estimate.mostLikely');
    assert.equal(choiceBadgeKey(1), 'result.estimate.alsoPossible');
    assert.equal(choiceBadgeKey(2), 'result.estimate.alsoPossible');
  });
});

describe('height families', () => {
  const catalogue = (pairs) => pairs.map((pair) => (Array.isArray(pair) ? { widthMm: pair[0], heightMm: pair[1] } : pair));
  const AU = standardSizesFrom(SHIPPED_CONFIG);
  // js/config.js's US example: 80 in doors, and 7 ft ones in two widths.
  const US = catalogue([[762, 2032], [813, 2032], [914, 2032], [813, 2134], [914, 2134]]);
  // js/config.js's UK example: one height.
  const UK = catalogue([[762, 1981], [838, 1981]]);
  const t = createTranslator({}, strings);
  const labelled = (sizes) => {
    const families = heightFamilies(sizes);
    return (heightMm) => heightFamilyOf(heightMm, families);
  };

  test('Australian catalogue: 2040 and 2100 look alike and are standard height; 2340 is tall', () => {
    const expected = [
      { id: 'standard', heightsMm: [2040, 2100] },
      { id: 'tall', heightsMm: [2340] },
    ];
    assert.deepEqual(heightFamilies(AU), expected);
    // The built-in list (a company with no standardSizes of its own) is the same catalogue.
    assert.deepEqual(heightFamilies(standardSizesFrom({})), expected);
    const of = labelled(AU);
    assert.deepEqual([2040, 2100, 2340].map(of), ['standard', 'standard', 'tall']);
    // No-break spaces keep the dot off the start of a line and the height in one piece when it wraps.
    assert.equal(choiceBadgeText(t, 0, of(2040)), 'Most likely\u00a0· Standard\u00a0height');
    assert.equal(choiceBadgeText(t, 1, of(2340)), 'Also possible\u00a0· Tall');
    assert.equal(choiceBadgeText(t, 2, of(2100)), 'Also possible\u00a0· Standard\u00a0height');
    assert.equal(choiceBadgeText(t, 1, 'extraTall'), 'Also possible\u00a0· Extra\u00a0tall');
  });

  test('US catalogue: 80 in and 7 ft look alike, so only an 8 ft door is told apart by height', () => {
    // 2032 against 2134 mm is 102 mm, 5 % of the door: not something to judge by eye.
    assert.deepEqual(heightFamilies(US), []);
    const of = labelled(US);
    assert.equal(of(2032), null);
    assert.equal(of(2134), null);
    assert.equal(choiceBadgeText(t, 1, of(2134)), 'Also possible');
    assert.equal(estimateBannerKey(estimate(), 2, [of(2032), of(2134)]), 'result.estimate.unsure');
    const withEightFoot = [...US, { widthMm: 914, heightMm: 2438 }];
    assert.deepEqual(heightFamilies(withEightFoot), [
      { id: 'standard', heightsMm: [2032, 2134] },
      { id: 'tall', heightsMm: [2438] },
    ]);
    const of8 = labelled(withEightFoot);
    assert.equal(choiceBadgeText(t, 1, of8(2438)), 'Also possible\u00a0· Tall');
    assert.equal(estimateBannerKey(estimate(), 2, [of8(2032), of8(2438)]), 'result.estimate.unsureHeight.standardTall');
  });

  test('single-height catalogue: no families, so no height labels and the plain unsure banner', () => {
    assert.deepEqual(heightFamilies(UK), []);
    const of = labelled(UK);
    assert.equal(of(1981), null);
    assert.equal(choiceBadgeText(t, 0, of(1981)), 'Most likely');
    assert.equal(choiceBadgeText(t, 1), 'Also possible');
    assert.equal(estimateBannerKey(estimate(), 2, [of(1981), of(1981)]), 'result.estimate.unsure');
  });

  test('every group above the second is extra tall; order, repeats and broken entries do not matter', () => {
    const messy = catalogue([
      [920, 3000], [920, 2400], [820, 2340], null, [820, 2040], [820, 'tall'], [870, 2100], [920, 2040], [820, -1], {}, [920, 2700],
    ]);
    assert.deepEqual(heightFamilies(messy), [
      { id: 'standard', heightsMm: [2040, 2100] },
      { id: 'tall', heightsMm: [2340, 2400] },
      { id: 'extraTall', heightsMm: [2700, 3000] },
    ]);
    assert.equal(heightFamilyOf(3000, heightFamilies(messy)), 'extraTall');
    assert.deepEqual(HEIGHT_FAMILIES, ['standard', 'tall', 'extraTall']);
    for (const junk of [undefined, null, 'AU', {}, []]) assert.deepEqual(heightFamilies(junk), [], String(junk));
  });

  test('heights less than 150 mm apart are one family, so two labels always mean a height you can see', () => {
    assert.equal(HEIGHT_FAMILY_MERGE_MM, 150);
    // 2032, 2040 and 2100 all look the same on the door: one height, so nothing to label.
    assert.deepEqual(heightFamilies(catalogue([[813, 2032], [820, 2040], [870, 2100]])), []);
    assert.deepEqual(heightFamilies(catalogue([[820, 2040], [820, 2189]])), []);
    assert.deepEqual(heightFamilies(catalogue([[820, 2040], [820, 2190]])), [
      { id: 'standard', heightsMm: [2040] },
      { id: 'tall', heightsMm: [2190] },
    ]);
    // A run of close heights is one family even where its ends are far apart: no label at all is
    // better than one that splits 2160 from 2220.
    assert.deepEqual(heightFamilies(catalogue([2040, 2100, 2160, 2220, 2280, 2340].map((h) => [820, h]))), []);
    // Whatever the catalogue, heights in different families are at least HEIGHT_FAMILY_MERGE_MM apart.
    const rand = mulberry32(11);
    for (let trial = 0; trial < 300; trial += 1) {
      const sizes = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => ({ widthMm: 820, heightMm: 1900 + Math.round(rand() * 900) }));
      const families = heightFamilies(sizes);
      for (const [i, a] of families.entries()) {
        for (const b of families.slice(i + 1)) {
          const gap = Math.min(...a.heightsMm.flatMap((x) => b.heightsMm.map((y) => Math.abs(x - y))));
          assert.ok(gap >= HEIGHT_FAMILY_MERGE_MM, `${a.id} ${a.heightsMm} / ${b.id} ${b.heightsMm}`);
        }
      }
    }
  });

  test('a height that is not one of the catalogue\'s gets no label', () => {
    const of = labelled(AU);
    assert.equal(of(1981), null);
    assert.equal(of(2070), null, 'halfway between two heights');
    assert.equal(HEIGHT_MATCH_MM, 20);
    assert.equal(of(2055), 'standard', 'within 20 mm of 2040');
    assert.equal(of(NaN), null);
    assert.equal(of(undefined), null);
    assert.equal(heightFamilyOf(2040, undefined), null);
    assert.equal(heightFamilyOf(2040, [{ id: 'mystery', heightsMm: [2040] }]), null);
  });

  test('the labels and the way they join the badge can be reworded through config.text', () => {
    assert.equal(heightFamilyKey('standard'), 'result.estimate.height.standard');
    assert.equal(heightFamilyKey('extraTall'), 'result.estimate.height.extraTall');
    assert.equal(heightFamilyKey('mystery'), null);
    assert.equal(heightFamilyKey(null), null);
    const custom = createTranslator(
      { text: { 'result.estimate.height.extraTall': 'Oversize', 'result.estimate.badgeWithHeight': '{height}: {badge}' } },
      strings,
    );
    assert.equal(choiceBadgeText(custom, 1, 'extraTall'), 'Oversize: Also possible');
    assert.equal(choiceBadgeText(custom, 0, 'standard'), 'Standard height: Most likely');
    assert.equal(choiceBadgeText(custom, 0, 'mystery'), 'Most likely');
  });

  test('the most common Australian door, 820 x 2040, is offered with 920 x 2340 and asked about by height', () => {
    // Photographed square on with the phone's usual 26 mm lens: the shapes are within about 2 % of each
    // other, so the estimate is not confident, but the two differ by 300 mm in height.
    const imageWidth = 3024;
    const imageHeight = 4032;
    const focalPx = (26 / Math.hypot(36, 24)) * Math.hypot(imageWidth, imageHeight);
    const P = cameraHomography({ imageWidth, imageHeight, focalPx, target: { x: 410, y: 1020 }, distanceMm: 2600, yawDeg: 0, pitchDeg: 0 });
    const corners = [{ x: 0, y: 0 }, { x: 820, y: 0 }, { x: 820, y: 2040 }, { x: 0, y: 2040 }].map((p) => projectPoint(P, p));
    const measure = estimateFromCorners({ corners, imageWidth, imageHeight, focalPx, focalSource: 'exif', sizes: AU });
    assert.equal(measure.confident, false);
    const choices = estimateChoices(measure);
    const keys = choices.map((choice) => choice.key);
    assert.equal(keys[0], '820x2040');
    assert.ok(keys.includes('920x2340'), keys.join(', '));
    const families = choiceHeightFamilies(choices, heightFamilies(AU));
    assert.equal(families[0], 'standard');
    assert.equal(families[keys.indexOf('920x2340')], 'tall');
    const banner = estimateBannerKey(measure, choices.length, families);
    assert.equal(banner, 'result.estimate.unsureHeight.standardTall');
    assert.match(t(banner), /^Is your door a standard height or tall\?/);
    assert.match(t('result.estimate.unsureHeight.standardExtraTall'), /standard height or extra tall\?/);
  });

  test('sizes that differ only by 2040 against 2100 get no height labels and no height question', () => {
    // The review's live-camera case: a true 870 x 2100 door, corners where detection put them. Asking
    // "standard height or tall?" there sent customers whose door looks ordinary to 870 x 2040, 60 mm short.
    const families = heightFamilies(AU);
    const measure = estimate({ candidates: [candidate(870, 2100, 0.46), candidate(870, 2040, 0.3), candidate(820, 2040, 0.15)] });
    const choices = estimateChoices(measure);
    const labels = choiceHeightFamilies(choices, families);
    assert.deepEqual(labels, [null, null, null]);
    assert.equal(estimateBannerKey(measure, choices.length, labels), 'result.estimate.unsure');
    assert.deepEqual(labels.map((family, index) => choiceBadgeText(t, index, family)), ['Most likely', 'Also possible', 'Also possible']);
  });

  test('sizes that differ by 300 mm in height are labelled, 2100 with 2040 as standard height', () => {
    const families = heightFamilies(AU);
    const measure = estimate({ candidates: [candidate(820, 2040, 0.5), candidate(920, 2340, 0.3), candidate(870, 2100, 0.1)] });
    const choices = estimateChoices(measure);
    const labels = choiceHeightFamilies(choices, families);
    assert.deepEqual(labels, ['standard', 'tall', 'standard']);
    assert.equal(estimateBannerKey(measure, choices.length, labels), 'result.estimate.unsureHeight.standardTall');
    // Whatever the list, 2040 and 2100 are never two different answers to the height question.
    for (const pool of [[2040, 2100], [2100, 2040, 2340], [2040, 2340, 2100], [2340, 2100]]) {
      const each = choiceHeightFamilies(pool.map((heightMm, index) => ({ widthMm: 820 + 50 * index, heightMm })), families);
      if (pool.includes(2040)) assert.equal(each[pool.indexOf(2040)], each[pool.indexOf(2100)], pool.join(', '));
      else assert.deepEqual(each, ['tall', 'standard'], pool.join(', '));
    }
    assert.deepEqual(choiceHeightFamilies(undefined, families), []);
    assert.deepEqual(choiceHeightFamilies([{ heightMm: 2040 }, null], families), [null, null]);
  });
});

describe('estimate banner and issue lines', () => {
  test('a confident estimate shows no banner; an unsure one is worded for the list', () => {
    assert.equal(estimateBannerKey(estimate({ confident: true }), 3), null);
    assert.equal(estimateBannerKey(estimate(), 3), 'result.estimate.unsure');
    assert.equal(estimateBannerKey(estimate(), 1), 'result.estimate.unsureOne');
  });

  test('a door that may not be a standard size gets that banner, whatever else', () => {
    assert.equal(estimateBannerKey(estimate({ nonStandard: true }), 3), 'result.estimate.nonStandard');
    assert.equal(estimateBannerKey(estimate({ nonStandard: true, confident: true }), 1), 'result.estimate.nonStandard');
  });

  test('unsure between sizes of different heights: asks which height the door is, naming only those', () => {
    assert.equal(estimateBannerKey(estimate(), 2, ['standard', 'extraTall']), 'result.estimate.unsureHeight.standardExtraTall');
    assert.equal(estimateBannerKey(estimate(), 2, ['standard', 'tall']), 'result.estimate.unsureHeight.standardTall');
    assert.equal(estimateBannerKey(estimate(), 2, ['tall', 'extraTall']), 'result.estimate.unsureHeight.tallExtraTall');
    assert.equal(
      estimateBannerKey(estimate(), 3, ['extraTall', 'tall', 'standard']),
      'result.estimate.unsureHeight.standardTallExtraTall',
    );
    // The order of the list and repeated heights do not matter.
    assert.equal(estimateBannerKey(estimate(), 3, ['extraTall', 'standard', 'standard']), 'result.estimate.unsureHeight.standardExtraTall');
  });

  test('unsure between sizes of one height, or with no height labels: the plain unsure banner', () => {
    assert.equal(estimateBannerKey(estimate(), 3, ['standard', 'standard', 'standard']), 'result.estimate.unsure');
    // A single-height catalogue labels nothing.
    assert.equal(estimateBannerKey(estimate(), 2, [null, null]), 'result.estimate.unsure');
    assert.equal(estimateBannerKey(estimate(), 2, ['tall', null]), 'result.estimate.unsure');
    assert.equal(estimateBannerKey(estimate(), 2, []), 'result.estimate.unsure');
    assert.equal(estimateBannerKey(estimate(), 2, 'standard tall'), 'result.estimate.unsure');
  });

  test('heights never override a confident, non-standard or single-size estimate', () => {
    assert.equal(estimateBannerKey(estimate({ confident: true }), 2, ['standard', 'extraTall']), null);
    assert.equal(estimateBannerKey(estimate({ nonStandard: true }), 2, ['standard', 'extraTall']), 'result.estimate.nonStandard');
    assert.equal(estimateBannerKey(estimate(), 1, ['extraTall']), 'result.estimate.unsureOne');
  });

  test('the bundled demo photo: each unsure banner in its demo form, asking nothing about "your door"', () => {
    const demo = { isDemo: true };
    assert.equal(estimateBannerKey(estimate(), 3, ['standard', 'tall', 'standard'], demo), 'result.estimate.demo.unsureHeight');
    assert.equal(estimateBannerKey(estimate(), 2, ['standard', 'extraTall'], demo), 'result.estimate.demo.unsureHeight');
    assert.equal(estimateBannerKey(estimate(), 3, [null, null, null], demo), 'result.estimate.demo.unsure');
    assert.equal(estimateBannerKey(estimate(), 3, undefined, demo), 'result.estimate.demo.unsure');
    assert.equal(estimateBannerKey(estimate(), 1, ['standard'], demo), 'result.estimate.demo.unsureOne');
    // Confident, or not a standard size: the same as for any photo.
    assert.equal(estimateBannerKey(estimate({ confident: true }), 3, ['standard', 'tall'], demo), null);
    assert.equal(estimateBannerKey(estimate({ nonStandard: true }), 3, ['standard', 'tall'], demo), 'result.estimate.nonStandard');
    // Only a real true is the demo; the customer's own photo still gets the height question.
    for (const options of [undefined, {}, { isDemo: false }, { isDemo: 'yes' }]) {
      assert.equal(estimateBannerKey(estimate(), 2, ['standard', 'tall'], options), 'result.estimate.unsureHeight.standardTall', JSON.stringify(options));
    }
  });

  test('the demo banners ask nothing about the visitor\'s door, and name only buttons the demo shows', () => {
    const t = createTranslator({}, strings);
    for (const key of ['result.estimate.demo.unsureHeight', 'result.estimate.demo.unsure', 'result.estimate.demo.unsureOne']) {
      assert.doesNotMatch(t(key), /\bis your door\b|like your door|retake/i, key);
      assert.match(t(key), /\bour demo door\b/, key);
    }
    // Nor does the list of sizes under them: no question, and no "Pick ..." of its own.
    for (const key of ['result.estimate.demo.choices.title', 'result.estimate.demo.choices.hint']) {
      assert.doesNotMatch(t(key), /\bis your door\b|like your door|retake|\?|(^|[.!?;]\s+)pick\b/i, key);
      assert.match(t(key), /\bour demo (door|photo)\b/, key);
    }
    // No Retake photo for the demo (resultTools): the one-size banner sends the visitor to what is there.
    for (const tool of resultTools('estimate', { isDemo: true })) {
      assert.ok(t('result.estimate.demo.unsureOne').includes(t(tool.label)), tool.label);
    }
  });

  test('heightQuestionKey asks only when there are two heights or more to tell apart', () => {
    assert.equal(heightQuestionKey(['standard']), null);
    assert.equal(heightQuestionKey(['tall', 'tall']), null);
    assert.equal(heightQuestionKey([null, 'mystery', 'standard']), null);
    assert.equal(heightQuestionKey(undefined), null);
    assert.equal(heightQuestionKey(['tall', 'standard']), 'result.estimate.unsureHeight.standardTall');
  });

  test('explains the known issues in a fixed order; non_standard is the banner, not a line', () => {
    const measure = estimate({ issues: ['door_near_edge', 'non_standard', 'steep_angle', 'mystery', 'not_rectangular', 'door_small'] });
    assert.deepEqual(estimateIssueKeys(measure), [
      'result.estimate.issue.not_rectangular',
      'result.estimate.issue.steep_angle',
      'result.estimate.issue.door_small',
      'result.estimate.issue.door_near_edge',
    ]);
    assert.deepEqual(estimateIssueKeys(estimate({ issues: undefined })), []);
    assert.ok(!ESTIMATE_ISSUES.includes('non_standard'));
  });

  test("a picked photo's angle line says what is unsure about it; our own captures keep the usual one", () => {
    const issues = ['steep_angle', 'door_small'];
    const keys = (focalSource, options) => estimateIssueKeys(estimate({ issues, focalSource }), options);
    // No EXIF (iOS's camera app strips it): the lens is unknown. EXIF: the lens is named, a crop is not.
    assert.deepEqual(keys('prior_file', { liveCamera: true }), ['result.estimate.issue.steep_angle_file', 'result.estimate.issue.door_small']);
    assert.deepEqual(keys('exif_file', { liveCamera: true }), ['result.estimate.issue.steep_angle_crop', 'result.estimate.issue.door_small']);
    for (const focalSource of ['exif', 'prior', undefined, 'mystery']) {
      for (const liveCamera of [true, false]) {
        assert.deepEqual(keys(focalSource, { liveCamera }), [
          'result.estimate.issue.steep_angle',
          'result.estimate.issue.door_small',
        ], `${focalSource} ${liveCamera}`);
      }
    }
  });

  test('a picked photo is only sent back to the camera here when that camera has worked', () => {
    // iPhone Safari, camera prompt answered Don't Allow (or Instagram's browser, which has no camera):
    // the camera app was the only way on, and Retake photo would only lead back there. Not known
    // (nothing has said the camera worked) is treated the same: the advice must be one they can follow.
    for (const options of [undefined, {}, { liveCamera: false }, { liveCamera: 'yes' }]) {
      assert.deepEqual(estimateIssueKeys(estimate({ issues: ['steep_angle'], focalSource: 'prior_file' }), options), [
        'result.estimate.issue.steep_angle_file_app',
      ], JSON.stringify(options));
      assert.deepEqual(estimateIssueKeys(estimate({ issues: ['steep_angle'], focalSource: 'exif_file' }), options), [
        'result.estimate.issue.steep_angle_crop_app',
      ], JSON.stringify(options));
    }
    const t = createTranslator({}, strings);
    for (const key of ['result.estimate.issue.steep_angle_file_app', 'result.estimate.issue.steep_angle_crop_app']) {
      assert.doesNotMatch(t(key), /Retake photo|camera there/, key);
      // What clears it for a camera-app photo: square on, the phone upright (not tilted at the door), 1x, no crop.
      assert.match(t(key), /camera app/, key);
      assert.match(t(key), /stand square/, key);
      assert.match(t(key), /upright/, key);
      assert.match(t(key), /1x/, key);
      assert.match(t(key), /crop/, key);
    }
    for (const key of ['result.estimate.issue.steep_angle_file', 'result.estimate.issue.steep_angle_crop']) {
      assert.match(t(key), /tap Retake photo/, key);
    }
    // EXIF names the lens: the line for it never says the lens is unknown.
    for (const key of ['result.estimate.issue.steep_angle_crop', 'result.estimate.issue.steep_angle_crop_app']) {
      assert.doesNotMatch(t(key), /which lens/, key);
      assert.match(t(key), /cropped or zoomed/, key);
    }
  });
});

/* ------------------------------------------------------------------ */
/* AR mode                                                             */
/* ------------------------------------------------------------------ */

describe('closestStandard', () => {
  test('offers the most likely standard size within 60 mm of the width and 90 mm of the height', () => {
    assert.deepEqual(AR_STANDARD_TOLERANCE, { widthMm: 60, heightMm: 90 });
    assert.deepEqual(closestStandard(arMeasure()), { widthMm: 820, heightMm: 2040 });
    // The limits themselves still count.
    assert.deepEqual(closestStandard(arMeasure({ widthMm: 880, heightMm: 2130 })), { widthMm: 820, heightMm: 2040 });
    assert.deepEqual(closestStandard(arMeasure({ widthMm: 760, heightMm: 1950 })), { widthMm: 820, heightMm: 2040 });
  });

  test('offers nothing when the door is further than that from it', () => {
    assert.equal(closestStandard(arMeasure({ widthMm: 880.5 })), null);
    assert.equal(closestStandard(arMeasure({ widthMm: 759 })), null);
    assert.equal(closestStandard(arMeasure({ heightMm: 2130.5 })), null);
    assert.equal(closestStandard(arMeasure({ heightMm: 1949 })), null);
  });

  test('only the most likely size is considered, never a later one that happens to be nearer', () => {
    const measure = arMeasure({ widthMm: 868, heightMm: 2098, candidates: [candidate(820, 2340, 0.5), candidate(870, 2100, 0.4)] });
    assert.equal(closestStandard(measure), null);
  });

  test('copes with a missing or broken candidate list', () => {
    assert.equal(closestStandard(arMeasure({ candidates: [] })), null);
    assert.equal(closestStandard(arMeasure({ candidates: undefined })), null);
    assert.equal(closestStandard(arMeasure({ candidates: [candidate('wide', 2040, 1)] })), null);
    assert.equal(closestStandard(arMeasure({ widthMm: NaN })), null);
    assert.equal(closestStandard(null), null);
  });

  test("with the core module's nearestStandard, a near-standard measurement finds its size", () => {
    const measured = { widthMm: 823.6, heightMm: 2047.2 };
    const measure = arMeasure({ ...measured, candidates: nearestStandard(measured) });
    assert.deepEqual(closestStandard(measure), { widthMm: 820, heightMm: 2040 });
  });

  test('explains every AR warning code, in a fixed order', () => {
    const measure = arMeasure({ warnings: ['implausible_size', 'off_plane', 'base_not_level', 'unknown'] });
    assert.deepEqual(arWarningKeys(measure), [
      'result.ar.warning.base_not_level',
      'result.ar.warning.off_plane',
      'result.ar.warning.implausible_size',
    ]);
    assert.deepEqual(arWarningKeys(arMeasure({ warnings: undefined })), []);
  });
});

/* ------------------------------------------------------------------ */
/* Buttons each mode shows                                             */
/* ------------------------------------------------------------------ */

describe('resultTools and the paper link', () => {
  const route = (tools) => tools.map(({ id, target }) => `${id}->${target}`);

  test('estimate: adjust the corners, or retake the photo', () => {
    assert.deepEqual(route(resultTools('estimate')), ['adjust->door', 'retake->capture']);
  });

  test('estimate from the demo photo: there is nothing to retake, so start again from the ways in', () => {
    assert.deepEqual(route(resultTools('estimate', { isDemo: true })), ['adjust->door', 'ownDoor->welcome']);
  });

  test('AR: measure again, or take a photo instead unless the camera way in is switched off', () => {
    assert.deepEqual(route(resultTools('ar')), ['measureAgain->ar', 'usePhoto->capture']);
    assert.deepEqual(route(resultTools('ar', { methods: { camera: true } })), ['measureAgain->ar', 'usePhoto->capture']);
    assert.deepEqual(route(resultTools('ar', { methods: { camera: false } })), ['measureAgain->ar']);
  });

  test('any other mode has none of these', () => {
    assert.deepEqual(resultTools('paper'), []);
  });

  test('the paper link shows unless the company switched the paper method off', () => {
    assert.equal(offersPaper({ measurement: {} }), true);
    assert.equal(offersPaper({ measurement: { methods: { paper: true } } }), true);
    assert.equal(offersPaper({ measurement: { methods: { ar: false } } }), true);
    assert.equal(offersPaper({ measurement: { methods: { paper: false } } }), false);
    assert.equal(offersPaper(undefined), true);
  });
});

describe('manual entry: the way back to measuring', () => {
  const withMethods = (methods, extra = {}) => ({ measurement: { methods, ...extra } });
  const route = (config) => {
    const alternative = manualAlternative(config);
    return alternative && `${alternative.target}:${alternative.label}`;
  };

  test('the no-paper camera when it is on, as the welcome screen\'s "Measure with my camera" does', () => {
    assert.equal(route(SHIPPED_CONFIG), 'capture:result.manual.useCamera');
    assert.equal(route(withMethods({ ar: true, camera: true, paper: true })), 'capture:result.manual.useCamera');
    // The paper method switched off is never where this leads.
    assert.equal(route(withMethods({ ar: true, camera: true, paper: false })), 'capture:result.manual.useCamera');
    assert.equal(route(undefined), 'capture:result.manual.useCamera');
  });

  test('the paper method, with its own words, when only paper is on', () => {
    assert.equal(route(withMethods({ ar: true, camera: false, paper: true })), 'prepare:result.manual.usePaper');
    assert.equal(manualAlternative(withMethods({ camera: false })).icon, 'paper');
  });

  test('no button when neither the camera nor the paper method is on', () => {
    assert.equal(manualAlternative(withMethods({ ar: true, camera: false, paper: false })), null);
    assert.equal(manualAlternative(withMethods({ ar: false, camera: false, paper: false })), null);
  });

  test('each label has copy, and each target its own words', () => {
    const camera = manualAlternative(withMethods({ camera: true }));
    const paper = manualAlternative(withMethods({ camera: false, paper: true }));
    for (const { label } of [camera, paper]) assert.equal(typeof strings[label], 'string', label);
    assert.notEqual(strings[camera.label], strings[paper.label]);
    assert.match(strings[paper.label], /paper/i);
  });

  test('leaving for the camera keeps the typed size editable: the quote\'s Edit comes back to the form', () => {
    // "I already know my door size", 820 x 2040, Get my price, the quote's Edit, then this button. The
    // quote stays ahead in the history, so Forward reaches it again and its Edit asks for 'result'.
    for (const config of [SHIPPED_CONFIG, withMethods({ camera: false, paper: true }), withMethods({ camera: true, paper: false })]) {
      const state = { ...createInitialState(config), manualEntry: true, size: { widthMm: 820, heightMm: 2040, source: 'manual' } };
      const alternative = manualAlternative(config);
      const went = [];
      measureInstead({ state, go: (id) => went.push(id) }, alternative);
      assert.deepEqual(went, [alternative.target]);

      assert.equal(state.manualEntry, true, alternative.target);
      assert.deepEqual(state.size, { widthMm: 820, heightMm: 2040, source: 'manual' });
      assert.equal(canEnter(state), true);
      assert.equal(resultMode(state), 'manual');
      const guard = (id) => (id === 'result' ? canEnter(state) : FALLBACK_GUARDS[id](state));
      assert.equal(FALLBACK_GUARDS.quote(state), true, 'the quote ahead in the history can still be entered');
      // Not the paper method's "Get set up", nor the welcome screen when paper is off.
      assert.equal(resolveScreenId('result', state, guard, measurementMethods(config)), 'result', alternative.target);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Sizes and the 'measured' event                                      */
/* ------------------------------------------------------------------ */

describe('measuredPayload', () => {
  test('paper: unchanged, with the grade, the sigmas and the demo flag', () => {
    const state = {
      size: { widthMm: 822, heightMm: 2041, source: 'photo' },
      measure: { quality: { level: 'good' }, sigmaWidthMm: 1.2, sigmaHeightMm: 2.5 },
      photo: { isDemo: true },
    };
    assert.deepEqual(measuredPayload(state), {
      widthMm: 822, heightMm: 2041, source: 'photo', quality: 'good', sigmaWidthMm: 1.2, sigmaHeightMm: 2.5, demo: true,
    });
    assert.equal('demo' in measuredPayload({ ...state, photo: { isDemo: false } }), false);
  });

  test('estimate: always a standard size; the demo photo is flagged', () => {
    const size = { widthMm: 820, heightMm: 2040, source: 'estimate', standard: true };
    assert.deepEqual(measuredPayload({ size, measure: estimate(), photo: { isDemo: false, capture: 'live' } }), {
      widthMm: 820, heightMm: 2040, source: 'estimate', standard: true,
    });
    assert.deepEqual(measuredPayload({ size, measure: estimate(), photo: { capture: 'demo' } }), {
      widthMm: 820, heightMm: 2040, source: 'estimate', standard: true, demo: true,
    });
  });

  test('AR: says whether the standard size was chosen, and never flags a leftover demo photo', () => {
    const photo = { isDemo: true };
    assert.deepEqual(measuredPayload({ size: { widthMm: 838, heightMm: 2072, source: 'ar', standard: false }, measure: arMeasure(), photo }), {
      widthMm: 838, heightMm: 2072, source: 'ar', standard: false,
    });
    assert.deepEqual(measuredPayload({ size: { widthMm: 820, heightMm: 2040, source: 'ar', standard: true }, measure: arMeasure(), photo }), {
      widthMm: 820, heightMm: 2040, source: 'ar', standard: true,
    });
  });

  test('a typed-in size is just the numbers', () => {
    assert.deepEqual(measuredPayload({ size: { widthMm: 900, heightMm: 2100, source: 'manual' }, measure: estimate(), photo: { isDemo: true } }), {
      widthMm: 900, heightMm: 2100, source: 'manual',
    });
  });
});

test('sameSize tells apart the numbers, the source and the AR standard choice', () => {
  const a = { widthMm: 820, heightMm: 2040, source: 'ar', standard: true };
  assert.equal(sameSize(a, { ...a }), true);
  assert.equal(sameSize(a, { ...a, standard: false }), false);
  assert.equal(sameSize(a, { ...a, source: 'manual' }), false);
  assert.equal(sameSize(a, { ...a, widthMm: 821 }), false);
  assert.equal(sameSize({ widthMm: 820, heightMm: 2040, source: 'photo' }, { widthMm: 820, heightMm: 2040, source: 'photo', standard: false }), true);
  assert.equal(sameSize(null, a), false);
});

test('parseMm reads whole millimetres from what a customer types', () => {
  assert.equal(parseMm(' 820 '), 820);
  assert.equal(parseMm('819,6'), 820);
  assert.equal(parseMm(''), null);
  assert.equal(parseMm('abc'), null);
  assert.equal(parseMm(null), null);
});

/* ------------------------------------------------------------------ */
/* Flattened preview                                                   */
/* ------------------------------------------------------------------ */

test('canPreview needs a photo and a usable door rectangle', () => {
  const image = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  const plane = { planeToImage: [1, 0, 0, 0, 1, 0, 0, 0, 1], widthMm: 820, heightMm: 2040 };
  assert.equal(PREVIEW_MARGIN_MM, 60);
  assert.equal(canPreview(image, plane), true);
  assert.equal(canPreview(null, plane), false);
  assert.equal(canPreview(image, null), false);
  assert.equal(canPreview(image, { ...plane, planeToImage: null }), false);
  assert.equal(canPreview(image, { ...plane, planeToImage: [1, 0, 0] }), false);
  assert.equal(canPreview(image, { ...plane, planeToImage: [NaN, 0, 0, 0, 1, 0, 0, 0, 1] }), false);
  assert.equal(canPreview(image, { ...plane, widthMm: 0 }), false);
});

test('a real estimate drives the screen: its sizes, banner and a preview mapping for each choice', () => {
  // A 820 x 2040 opening photographed a little off square with the phone's usual 26 mm lens.
  const imageWidth = 3024;
  const imageHeight = 4032;
  const focalPx = (26 / Math.hypot(36, 24)) * Math.hypot(imageWidth, imageHeight);
  const P = cameraHomography({ imageWidth, imageHeight, focalPx, target: { x: 410, y: 1020 }, distanceMm: 2600, yawDeg: 8, pitchDeg: -4 });
  const corners = [{ x: 0, y: 0 }, { x: 820, y: 0 }, { x: 820, y: 2040 }, { x: 0, y: 2040 }].map((p) => projectPoint(P, p));
  const measure = estimateFromCorners({ corners, imageWidth, imageHeight, focalPx, focalSource: 'exif' });
  assert.equal(measure.ok, true);
  assert.equal(resultMode({ measure }), 'estimate');

  const choices = estimateChoices(measure);
  assert.ok(choices.length >= 1 && choices.length <= MAX_CHOICES);
  assert.deepEqual([choices[0].widthMm, choices[0].heightMm], [measure.candidates[0].widthMm, measure.candidates[0].heightMm]);
  assert.ok(choices.some((choice) => choice.key === '820x2040'), choices.map((choice) => choice.key).join(', '));
  const families = heightFamilies(standardSizesFrom(SHIPPED_CONFIG));
  const choiceFamilies = choices.map((choice) => heightFamilyOf(choice.heightMm, families));
  // Every size offered is one of the catalogue's, so each has a height label.
  assert.ok(choiceFamilies.every((family) => HEIGHT_FAMILIES.includes(family)), choiceFamilies.join(', '));
  for (const banner of [estimateBannerKey(measure, choices.length), estimateBannerKey(measure, choices.length, choiceFamilies)]) {
    assert.ok(banner === null || Object.prototype.hasOwnProperty.call(strings, banner), banner);
  }

  for (const choice of choices) {
    const plane = { planeToImage: planeToImageFor(measure.corners, choice.widthMm, choice.heightMm), ...choice };
    assert.equal(canPreview({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, plane), true, choice.key);
    // The chosen size's rectangle lands on the corners the customer confirmed.
    const far = projectPoint(plane.planeToImage, { x: choice.widthMm, y: choice.heightMm });
    assert.ok(Math.hypot(far.x - measure.corners[2].x, far.y - measure.corners[2].y) < 1e-6);
  }
});

/* ------------------------------------------------------------------ */
/* The screen itself, mounted on a small stand-in for the DOM          */
/* ------------------------------------------------------------------ */

// Just enough of the DOM for js/ui.js to build the result screen under Node: elements with attributes,
// classes, text and click listeners. A listener that throws fails the test, where a browser would only
// log it and leave the customer with a button that does nothing.
class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    const text = value === null || value === undefined ? '' : String(value);
    this.replaceChildren(...(text ? [new FakeText(text)] : []));
  }

  appendChild(node) {
    node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...items) {
    for (const item of items) this.appendChild(item instanceof FakeNode ? item : new FakeText(String(item)));
  }

  replaceChildren(...items) {
    for (const node of [...this.childNodes]) node.remove();
    this.append(...items);
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.data = data;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.localName = tag;
    this.nodeName = tag.toUpperCase();
    this.attributes = [];
    this.attrs = new Map();
    this.classes = new Set();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    const classes = this.classes;
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on = !classes.has(name)) => {
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeElement);
  }

  setAttribute(name, value) {
    if (name === 'class') {
      this.classes.clear();
      for (const className of String(value).split(/\s+/).filter(Boolean)) this.classes.add(className);
    }
    this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((fn) => fn !== listener));
  }

  click() {
    if (this.disabled) return;
    for (const listener of [...(this.listeners.get('click') ?? [])]) listener({ type: 'click', target: this, preventDefault() {} });
  }

  focus() {}

  scrollIntoView() {}

  querySelectorAll() {
    return [];
  }
}

const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(String(text)),
  importNode: (node) => node,
};

class FakeDOMParser {
  parseFromString() {
    return { documentElement: new FakeElement('svg'), getElementsByTagName: () => [] };
  }
}

/** Every element under `root` (itself included) that `match` accepts, in document order. */
function findAll(root, match) {
  const found = [];
  const walk = (node) => {
    if (!(node instanceof FakeElement)) return;
    if (match(node)) found.push(node);
    node.childNodes.forEach(walk);
  };
  walk(root);
  return found;
}

const withClass = (root, className) => findAll(root, (el) => el.classes.has(className));
const textOf = (el) => el.textContent.trim();

/**
 * Mount js/screens/result.js on the stand-in DOM with `state` and `config`, the way js/app.js does.
 * @returns {{ root: FakeElement, went: string[], emitted: object[], state: object, cleanup: () => void }}
 */
function mountResult(state, config = SHIPPED_CONFIG) {
  const saved = Object.fromEntries(
    ['document', 'Node', 'DOMParser', 'cancelAnimationFrame', 'requestAnimationFrame'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.assign(globalThis, {
    document: fakeDocument,
    Node: FakeNode,
    DOMParser: FakeDOMParser,
    cancelAnimationFrame: () => {},
    requestAnimationFrame: () => 0,
  });
  const restore = () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  const root = new FakeElement('section');
  const went = [];
  const emitted = [];
  const ctx = {
    config,
    state,
    ui,
    t: createTranslator(config, strings),
    go: (id) => went.push(id),
    emit: (type, payload) => emitted.push({ type, payload }),
    toast: () => {},
    busy: (work) => work(),
  };
  let cleanup;
  try {
    cleanup = mount(root, ctx);
  } catch (error) {
    restore();
    throw error;
  }
  return {
    root,
    went,
    emitted,
    state,
    // The listeners run later, still on the stand-in DOM: restore the globals only when the test is done.
    cleanup: () => {
      try {
        cleanup?.();
      } finally {
        restore();
      }
    },
  };
}

const buttonNamed = (root, label) => findAll(root, (el) => el.localName === 'button' && textOf(el) === label);

describe('the manual-entry screen, mounted', () => {
  const typed = (config) => ({ ...createInitialState(config), manualEntry: true, size: { widthMm: 820, heightMm: 2040, source: 'manual' } });
  const cameraOff = deepMerge(SHIPPED_CONFIG, { measurement: { methods: { camera: false, paper: true } } });
  const bothOff = deepMerge(SHIPPED_CONFIG, { measurement: { methods: { camera: false, paper: false } } });

  test('"Measure with my camera instead" goes to the camera and keeps the typed size editable', () => {
    // The review's case: 820 x 2040 typed in, Get my price, the quote's Edit, then this button. It used
    // to throw (a local of the same name shadowed measureInstead), so the button did nothing.
    for (const [config, label, target] of [
      [SHIPPED_CONFIG, strings['result.manual.useCamera'], 'capture'],
      [cameraOff, strings['result.manual.usePaper'], 'prepare'],
    ]) {
      const screen = mountResult(typed(config), config);
      try {
        const [button] = buttonNamed(screen.root, label);
        assert.ok(button, `no "${label}" button`);
        button.click();
        assert.deepEqual(screen.went, [target], label);
        assert.equal(screen.state.manualEntry, true, label);
        assert.deepEqual(screen.state.size, { widthMm: 820, heightMm: 2040, source: 'manual' });
        assert.equal(canEnter(screen.state), true);
        assert.deepEqual(screen.emitted, [], 'leaving to measure is not a new size');
      } finally {
        screen.cleanup();
      }
    }
  });

  test('no way back to measuring when the company switched both camera and paper off', () => {
    const screen = mountResult(typed(bothOff), bothOff);
    try {
      const labels = findAll(screen.root, (el) => el.localName === 'button').map(textOf);
      assert.ok(labels.includes(strings['result.continue']), labels.join(' | '));
      assert.ok(!labels.some((label) => /instead$/.test(label)), labels.join(' | '));
    } finally {
      screen.cleanup();
    }
  });

  test('Get my price prices the typed size', () => {
    const screen = mountResult(typed(SHIPPED_CONFIG));
    try {
      buttonNamed(screen.root, strings['result.continue'])[0].click();
      assert.deepEqual(screen.went, ['quote']);
      assert.deepEqual(screen.emitted, [{ type: 'measured', payload: { widthMm: 820, heightMm: 2040, source: 'manual' } }]);
    } finally {
      screen.cleanup();
    }
  });
});

describe('the estimate screen, mounted', () => {
  const corners = [{ x: 400, y: 300 }, { x: 1200, y: 310 }, { x: 1190, y: 2300 }, { x: 410, y: 2290 }];
  const shown = (measure, extra = {}) => {
    const screen = mountResult({ ...createInitialState(SHIPPED_CONFIG), method: 'estimate', measure: { corners, ...measure }, ...extra });
    try {
      const [choicesCard] = withClass(screen.root, 'sm-result__choices');
      return {
        banner: withClass(screen.root, 'sm-banner').map(textOf),
        badges: withClass(screen.root, 'sm-radiocard__badge').map(textOf),
        issues: withClass(screen.root, 'sm-result__issue').map(textOf),
        // The list of sizes' heading and hint, and the radio group's accessible name.
        choices: choicesCard
          ? [
              ...withClass(choicesCard, 'sm-result__section-title').map(textOf),
              ...withClass(choicesCard, 'sm-result__section-hint').map(textOf),
              ...findAll(choicesCard, (el) => el.getAttribute('role') === 'radiogroup').map((el) => el.getAttribute('aria-label')),
            ]
          : [],
      };
    } finally {
      screen.cleanup();
    }
  };

  test('2040 against 2100: no height labels and no height question, the plain unsure banner', () => {
    const view = shown(estimate({ candidates: [candidate(870, 2100, 0.46), candidate(870, 2040, 0.3), candidate(820, 2040, 0.15)] }));
    assert.deepEqual(view.badges, [strings['result.estimate.mostLikely'], strings['result.estimate.alsoPossible'], strings['result.estimate.alsoPossible']]);
    assert.deepEqual(view.banner, [strings['result.estimate.unsure']]);
  });

  test('2040 against 2340: each size says its height and the banner asks', () => {
    const view = shown(estimate({ candidates: [candidate(820, 2040, 0.5), candidate(920, 2340, 0.3), candidate(870, 2100, 0.1)] }));
    assert.deepEqual(view.badges, [
      'Most likely · Standard height',
      'Also possible · Tall',
      'Also possible · Standard height',
    ]);
    assert.deepEqual(view.banner, [strings['result.estimate.unsureHeight.standardTall']]);
  });

  test('a picked photo on an angle: the camera here only when it has worked, else the camera app', () => {
    const measure = estimate({ issues: ['steep_angle'], focalSource: 'prior_file' });
    // capture.js never reached a live camera (blocked, an in-app browser): nothing says it works.
    assert.deepEqual(shown(measure).issues, [strings['result.estimate.issue.steep_angle_file_app']]);
    assert.deepEqual(shown(measure, { liveCamera: false }).issues, [strings['result.estimate.issue.steep_angle_file_app']]);
    assert.deepEqual(shown(measure, { liveCamera: true }).issues, [strings['result.estimate.issue.steep_angle_file']]);
    const exif = estimate({ issues: ['steep_angle'], focalSource: 'exif_file' });
    assert.deepEqual(shown(exif).issues, [strings['result.estimate.issue.steep_angle_crop_app']]);
    assert.deepEqual(shown(exif, { liveCamera: true }).issues, [strings['result.estimate.issue.steep_angle_crop']]);
  });

  test('the demo photo, unsure between heights: the demo banner and list heading, and the height labels kept', () => {
    const measure = estimate({ candidates: [candidate(820, 2040, 0.44), candidate(920, 2340, 0.26), candidate(820, 2100, 0.17)] });
    const t = createTranslator(SHIPPED_CONFIG, strings);
    const demoTitle = strings['result.estimate.demo.choices.title'];
    // Either mark of the bundled demo photo (js/demo.js dropDemoMeasure reads both).
    for (const photo of [{ isDemo: true }, { capture: 'demo' }]) {
      const view = shown(measure, { photo });
      assert.deepEqual(view.banner, [strings['result.estimate.demo.unsureHeight']], JSON.stringify(photo));
      assert.deepEqual(view.choices, [demoTitle, strings['result.estimate.demo.choices.hint'], demoTitle], JSON.stringify(photo));
      assert.deepEqual(view.badges, [choiceBadgeText(t, 0, 'standard'), choiceBadgeText(t, 1, 'tall'), choiceBadgeText(t, 2, 'standard')]);
    }
    // The customer's own photo: still asked, by the banner and the list.
    const own = shown(measure, { photo: { isDemo: false, capture: 'live' } });
    assert.deepEqual(own.banner, [strings['result.estimate.unsureHeight.standardTall']]);
    const ownTitle = strings['result.estimate.choices.title'];
    assert.deepEqual(own.choices, [ownTitle, strings['result.estimate.choices.hint'], ownTitle]);
  });
});

describe('welcome\'s "Try it with a demo photo", after the real door screen: the estimate asks nothing about "your door"', () => {
  // assets/demo-door.png by its truth file: an 820 x 2040 mm door, taken with the lens js/demo.js names for it.
  const DEMO = JSON.parse(readFileSync(new URL('../assets/demo-door.truth.json', import.meta.url), 'utf8'));
  const config = SHIPPED_CONFIG;

  /** The demo photo at the door screen, as loadDemo leaves it, with detection sure of its door (on its true corners). */
  function demoAtDoor() {
    const state = createInitialState(config);
    const photo = {
      width: DEMO.imageWidth,
      height: DEMO.imageHeight,
      canvas: { width: DEMO.imageWidth, height: DEMO.imageHeight },
      image: null,
      isDemo: true,
      capture: 'demo',
      focal35mm: demoPhotoFocal35mm(config.measurement.demoPhotoUrl),
      _luma: null,
    };
    useDemoPhoto(state, photo, 'estimate', config.measurement);
    state.door.detection = { ok: true, quad: DEMO.doorPx.map((p) => ({ ...p })), confidence: 0.99, alternatives: [] };
    return state;
  }

  test('"Find my door size" on the found corners: unsure between heights, so the demo banner, not the height question', async () => {
    const view = await doorThenResult(demoAtDoor(), { config });
    const { measure } = view.state;
    // The review's case: corners left where detection put them are measured with detection's error, and
    // that leaves the demo door short of a sure match, even with its own lens (35.5 mm) and true corners.
    assert.equal(measure.method, 'estimate');
    assert.equal(measure.confident, false);
    const choices = estimateChoices(measure);
    assert.equal(choices[0].key, '820x2040');
    const families = choiceHeightFamilies(choices, heightFamilies(standardSizesFrom(config)));
    assert.equal(estimateBannerKey(measure, choices.length, families), 'result.estimate.unsureHeight.standardTall', 'a customer\'s own photo would be asked');

    assert.deepEqual(view.banner, [view.t('result.estimate.demo.unsureHeight')]);
    assert.ok(!view.banner.some((text) => /\bis your door\b/i.test(text)), view.banner.join(' | '));
    // The sizes still say their heights: what a customer's own photo would offer.
    assert.deepEqual(view.badges, families.map((family, index) => choiceBadgeText(view.t, index, family)));
    assert.ok(families.includes('tall'), families.join(', '));
  });

  test('"Find my door size": the list of sizes under the demo banner is not headed "Which is your door?"', async () => {
    // The review's case: the banner says "you don't need to pick", and the card right under it used to
    // ask "Which is your door?" and say "Pick the one that looks right", to its heading, hint and the
    // radio group a screen reader announces.
    const view = await doorThenResult(demoAtDoor(), { config });
    assert.ok(estimateChoices(view.state.measure).length > 1, 'the demo offers a list of sizes');
    assert.deepEqual(view.choices, {
      title: [view.t('result.estimate.demo.choices.title')],
      hint: [view.t('result.estimate.demo.choices.hint')],
      ariaLabel: [view.t('result.estimate.demo.choices.title')],
    });
    const asked = [...view.banner, ...view.choices.title, ...view.choices.hint, ...view.choices.ariaLabel];
    // A question about the visitor's door, or "Pick ..." told as a sentence of its own.
    for (const text of asked) assert.doesNotMatch(text, /\bis your door\b|like your door|(^|[.!?;]\s+)pick\b/i, text);
  });
});

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

describe('strings', () => {
  const has = (key) => Object.prototype.hasOwnProperty.call(strings, key) && typeof strings[key] === 'string';

  test("the no-paper modes' copy is merged into result.js's strings, without changing the paper copy", () => {
    for (const [key, value] of Object.entries(standardStrings)) assert.equal(strings[key], value, key);
    assert.equal(strings['result.subtitle'], 'Measured from your photo. Check it looks right, then get your price.');
    assert.equal(
      strings['result.override.hint'],
      'Enter the size of the door opening in millimetres and we will use it instead of the photo measurement.',
    );
  });

  test('every key the helpers can produce has copy', () => {
    const keys = [
      ...ESTIMATE_ISSUES.map((code) => `result.estimate.issue.${code}`),
      ...['prior_file', 'exif_file'].flatMap((focalSource) =>
        [true, false].flatMap((liveCamera) => estimateIssueKeys(estimate({ issues: ['steep_angle'], focalSource }), { liveCamera })),
      ),
      ...AR_WARNINGS.map((code) => `result.ar.warning.${code}`),
      'result.estimate.nonStandard',
      'result.estimate.unsure',
      'result.estimate.unsureOne',
      // The demo photo's forms of the unsure banners.
      ...[[1, []], [2, [null, null]], [2, ['standard', 'tall']]].map(([count, families]) =>
        estimateBannerKey(estimate(), count, families, { isDemo: true }),
      ),
      choiceBadgeKey(0),
      choiceBadgeKey(1),
      'result.estimate.badgeWithHeight',
      ...HEIGHT_FAMILIES.map(heightFamilyKey),
      // Every set of two or more heights a list can span has its own question.
      ...[['standard', 'tall'], ['standard', 'extraTall'], ['tall', 'extraTall'], HEIGHT_FAMILIES].map(heightQuestionKey),
      ...['estimate', 'ar'].flatMap((mode) =>
        [...resultTools(mode), ...resultTools(mode, { isDemo: true })].map((tool) => tool.label),
      ),
    ];
    for (const key of keys) assert.ok(has(key), key);
  });

  test('every literal t() key in the result modules has copy', () => {
    for (const file of ['../js/screens/result.js', '../js/screens/result-standard.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const keys = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]);
      assert.ok(keys.length > 10, file);
      for (const key of keys) assert.ok(has(key), `${file}: ${key}`);
    }
  });

  test('each height question uses the words of the labels on the list it asks about', () => {
    for (const span of [['standard', 'tall'], ['standard', 'extraTall'], ['tall', 'extraTall'], HEIGHT_FAMILIES]) {
      const question = strings[heightQuestionKey(span)];
      for (const family of span) {
        const label = strings[heightFamilyKey(family)].toLowerCase();
        assert.ok(question.toLowerCase().includes(label), `${heightQuestionKey(span)} should mention "${label}"`);
      }
    }
  });

  test('the no-paper copy never claims a millimetre accuracy', () => {
    for (const [key, value] of Object.entries(standardStrings)) {
      assert.doesNotMatch(value, /±|\+\/-|accurate to/i, key);
    }
  });
});
