// The result screen's pure logic, from js/screens/result.js and js/screens/result-standard.js:
//  - when a 'poor' paper result is shown as "Check your photo" because the sheet could be either way
//    round, rather than as an ordinary "Rough measurement";
//  - which mode the screen shows, and for the two no-paper modes which sizes, banners, issue lines and
//    buttons it offers, the height labels on the estimate's sizes, the AR "closest standard size"
//    rule, and the 'measured' event it sends;
//  - mounted on a small stand-in for the DOM: the manual-entry screen's buttons, and the estimate
//    screen's badges, banner and issue lines as a customer sees them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { measureDoor, QUALITY_THRESHOLDS } from '../js/geometry.js';
import { estimateFromCorners, nearestStandard, planeToImageFor, standardSizesFrom } from '../js/estimate.js';
import { createTranslator } from '../js/strings.js';
import { canEnter, manualAlternative, measureInstead, mount, orientationUnclear, resultMode, strings } from '../js/screens/result.js';
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
      return {
        banner: withClass(screen.root, 'sm-banner').map(textOf),
        badges: withClass(screen.root, 'sm-radiocard__badge').map(textOf),
        issues: withClass(screen.root, 'sm-result__issue').map(textOf),
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
