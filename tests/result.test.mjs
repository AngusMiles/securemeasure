// The result screen's pure logic, from js/screens/result.js and js/screens/result-standard.js:
//  - when a 'poor' paper result is shown as "Check your photo" because the sheet could be either way
//    round, rather than as an ordinary "Rough measurement";
//  - which mode the screen shows, and for the two no-paper modes which sizes, banners, issue lines and
//    buttons it offers, the AR "closest standard size" rule, and the 'measured' event it sends.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { measureDoor, QUALITY_THRESHOLDS } from '../js/geometry.js';
import { estimateFromCorners, nearestStandard, planeToImageFor } from '../js/estimate.js';
import { manualAlternative, orientationUnclear, resultMode, strings } from '../js/screens/result.js';
import {
  AR_STANDARD_TOLERANCE,
  AR_WARNINGS,
  ESTIMATE_ISSUES,
  MAX_CHOICES,
  arWarningKeys,
  choiceBadgeKey,
  closestStandard,
  estimateBannerKey,
  estimateChoices,
  estimateIssueKeys,
  measuredPayload,
  offersPaper,
  parseMm,
  resultTools,
  sameSize,
  strings as standardStrings,
} from '../js/screens/result-standard.js';
import { PREVIEW_MARGIN_MM, canPreview } from '../js/screens/result-preview.js';
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
  const banner = estimateBannerKey(measure, choices.length);
  assert.ok(banner === null || Object.prototype.hasOwnProperty.call(strings, banner));

  for (const choice of choices) {
    const plane = { planeToImage: planeToImageFor(measure.corners, choice.widthMm, choice.heightMm), ...choice };
    assert.equal(canPreview({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, plane), true, choice.key);
    // The chosen size's rectangle lands on the corners the customer confirmed.
    const far = projectPoint(plane.planeToImage, { x: choice.widthMm, y: choice.heightMm });
    assert.ok(Math.hypot(far.x - measure.corners[2].x, far.y - measure.corners[2].y) < 1e-6);
  }
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
      ...AR_WARNINGS.map((code) => `result.ar.warning.${code}`),
      'result.estimate.nonStandard',
      'result.estimate.unsure',
      'result.estimate.unsureOne',
      choiceBadgeKey(0),
      choiceBadgeKey(1),
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

  test('the no-paper copy never claims a millimetre accuracy', () => {
    for (const [key, value] of Object.entries(standardStrings)) {
      assert.doesNotMatch(value, /±|\+\/-|accurate to/i, key);
    }
  });
});
