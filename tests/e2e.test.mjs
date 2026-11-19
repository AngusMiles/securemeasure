// End-to-end test of the real measuring pipeline under Node, with no DOM: a synthetic door photo goes
// through exactly the calls the screens make, in the same order and with the same arguments.
//
// The paper method:
//   sheet screen    detectSheet(photo.image, tap, { luma }) -> sheetDetectionOutcome
//                   (refineQuad(photo.image, corners) for "Snap to edges")
//   door screen     measureDoor({ ...config sigmas }) -> applyMeasurementRules
//   result screen   warpToRect(photo.image, measure.planeToImage, ...)
//   quote screen    calculateQuote(config, { ...size, productId, selections, includeInstallation })
//   details screen  validateCustomer -> buildLeadPayload -> submitLead
//
// The no-paper estimate (the "no-paper photo estimate" group below):
//   capture screen  setPhoto, method 'estimate', findDoor(photo, { prior: priorFromGuide(...) })
//                   (the welcome demo: the bundled photo's lens from js/demo.js demoPhotoFocal35mm,
//                   useDemoPhoto, then findDoor(photo))
//   door screen     startingQuad -> doorCornersPlaced -> estimateFromCorners({ ...photoFocal(photo),
//                   sizes: standardSizesFrom(config) }) -> applyMeasurementRules(candidates[0])
//   result screen   estimateChoices -> planeToImageFor(measure.corners, W, H) -> warpToRect
//   quote screen    calculateQuote, as above
//   details screen  leadMeasurement(state, config) -> buildLeadPayload -> buildMailtoUrl / submitLead
//
// The photos come from tools/scene.mjs, which knows where every corner really is. The scenes are rendered
// in the canvas pixel convention (DEMO_SCENE's pixelOrigin: 'corner'), the frame js/vision.js and the
// corner editor work in, so truth and detection are directly comparable.
//
// Which settings: every group but the last runs on tests/helpers/shipped-config.mjs, a fixed copy of the
// settings this repo ships. js/config.js is there to be edited (sheet sizes, a fitting allowance, prices,
// where enquiries go, wording), and none of that may fail a test of the measuring code. The last group
// puts js/config.js itself through the same steps and pins nothing in it.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cameraHomography } from '../tools/camera.mjs';
import { DEMO_SCENE, decodePng, renderScene, sceneTruth, truthToJson } from '../tools/scene.mjs';
import { detectSheet, refineQuad, warpToRect } from '../js/vision.js';
import { applyHomography, measureDoor } from '../js/geometry.js';
import { applyMeasurementRules, calculateQuote } from '../js/quote.js';
import { buildLeadPayload, buildMailtoUrl, LEAD_MAIL_STRINGS, leadMode, submitLead, validateCustomer } from '../js/lead.js';
import { deepMerge } from '../js/theme.js';
import { getLuma, getSheetMm, setPhoto } from '../js/photo.js';
import {
  canEnterDoor,
  cornersInOutlineOrder,
  doorCornersPlaced,
  doorOutlines,
  outlineIndexOf,
  sheetDetectionOutcome,
} from '../js/screens/mark-common.js';
import { detectDoor } from '../js/door-detect.js';
import { findDoor, isConfident, startingQuad } from '../js/door-find.js';
import { estimateFromCorners, photoFocal, planeToImageFor, standardSizesFrom } from '../js/estimate.js';
import { guideRect, priorFromGuide } from '../js/camera.js';
import { demoPhotoFocal35mm, demoPhotoUrl, useDemoPhoto } from '../js/demo.js';
import { createInitialState } from '../js/app.js';
import { PREVIEW_MARGIN_MM, canPreview } from '../js/screens/result-preview.js';
import { estimateBannerKey, estimateChoices, measuredPayload } from '../js/screens/result-standard.js';
import { resultMode } from '../js/screens/result.js';
import { isDemoDoor as detailsIsDemoDoor, leadMeasurement as detailsLeadMeasurement } from '../js/screens/details.js';
import liveConfig from '../js/config.js';
import acmeSkin from '../skins/acme.js';
import { SHIPPED_CONFIG as baseConfig } from './helpers/shipped-config.mjs';
import { mulberry32 } from './helpers/synth.mjs';

const TRUE_WIDTH_MM = 820;
const TRUE_HEIGHT_MM = 2040;

// How far a customer's hand-placed door corner is off, per axis (uniform within +-2 px), and the fixed
// seed behind "the" marked corners. The sweeps below show the chosen seed is nothing special.
const DOOR_SLIP_PX = 2;
const DOOR_SEED = 20240607;
const SWEEP_SEEDS = 300;

// Sheet corners must land within 0.75 px of the truth at worst. A clean scene is held much tighter: a
// half-pixel disagreement about the pixel convention between the renderer and vision.js would show up as
// a 0.71 px corner error, and 0.75 px would let that through.
const CLEAN_SHEET_TOL_PX = 0.25;
const NOISY_SHEET_TOL_PX = 0.5;
// On a pale door the paper's outline is mostly its own soft shadow, which pulls the detected edges in by
// up to about half a pixel.
const PALE_SHEET_TOL_PX = 0.75;

// PREVIEW_MARGIN_MM (60 mm of frame round the opening) comes from js/screens/result-preview.js.
const PREVIEW_WIDTH_PX = 560;

const PAPER_RGB = hexToRgb(DEMO_SCENE.sheet.color);
const DOOR_RGB = [34, 63, 94]; //         tools/scene.mjs default door colour #223f5e
const ARCHITRAVE_RGB = [241, 238, 231]; // tools/scene.mjs default architrave colour #f1eee7
const COLOUR_TOL = 25; // lighting, lens blur and sensor noise move a flat colour by up to about 10 levels

const DETECT_FAILURE_REASONS = ['no_region', 'touches_border', 'too_large', 'too_small', 'not_quad', 'cut_off'];

const CUSTOMER = {
  name: 'Alex Taylor',
  phone: '0400 000 000',
  email: 'alex@example.com',
  postcode: '3000',
  notes: 'Side gate is unlocked.',
  consent: true,
};

// A harder photo: standing well to one side with the phone at eye level, the sheet taped on crooked,
// and a noisier, softer image. (tools/camera.mjs counts pitch as positive when the phone is BELOW the
// point it looks at; a customer's phone is above it, so 8 degrees of tilt is pitchDeg -8.)
const STRONG_CAMERA = { focalPx: 2100, target: { x: 410, y: 1090 }, distanceMm: 3000, yawDeg: 15, pitchDeg: -8, rollDeg: -1 };
const STRONG_SCENE = {
  ...DEMO_SCENE,
  camera: STRONG_CAMERA,
  planeToImage: cameraHomography({ imageWidth: DEMO_SCENE.width, imageHeight: DEMO_SCENE.height, ...STRONG_CAMERA }),
  sheet: { ...DEMO_SCENE.sheet, rotDeg: 6 },
  noiseSigma: 3,
  blurPx: 0.8,
  seed: 7,
};

// The demo door painted white: white paper on a white door, told apart only by the paper's faint outline
// and the shadow round it. Most front doors are pale, so this is the everyday hard case.
const WHITE_DOOR_SCENE = { ...DEMO_SCENE, colors: { door: '#f4f2ee', doorPanel: '#ebe9e4' }, noiseSigma: 3, blurPx: 0.9, seed: 3 };

// The same A4 sheet taped on sideways. The config still says 210 x 297: measureDoor has to work out
// which side is which.
const LANDSCAPE_SCENE = { ...DEMO_SCENE, sheet: { ...DEMO_SCENE.sheet, w: 297, h: 210 } };

/* ------------------------------------------------------------------------------------------------------ */
/* Small helpers                                                                                          */
/* ------------------------------------------------------------------------------------------------------ */

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const centroid = (quad) => ({
  x: quad.reduce((sum, p) => sum + p.x, 0) / quad.length,
  y: quad.reduce((sum, p) => sum + p.y, 0) / quad.length,
});

/** Largest distance between matching corners of two quads in the same [TL, TR, BR, BL] order. */
const maxCornerError = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

/** Hand-placed corners: every coordinate off by a fixed pseudo-random amount within +-ampPx. */
function slipQuad(quad, seed, ampPx) {
  const rng = mulberry32(seed);
  return quad.map((p) => ({ x: p.x + (rng() * 2 - 1) * ampPx, y: p.y + (rng() * 2 - 1) * ampPx }));
}

const sum = (values) => values.reduce((total, v) => total + v, 0);

function assertColour(actual, expected, label) {
  const worst = Math.max(...expected.map((v, c) => Math.abs(actual[c] - v)));
  assert.ok(worst <= COLOUR_TOL, `${label}: expected about rgb(${expected.join(', ')}), got rgb(${actual.slice(0, 3).join(', ')})`);
}

/* ------------------------------------------------------------------------------------------------------ */
/* The pipeline, call for call as the screens run it                                                      */
/* ------------------------------------------------------------------------------------------------------ */

/**
 * What loadPhoto (js/photo.js) hands the screens, minus the canvas. A rendered scene stands for the
 * customer's own photo; only the bundled demo photo is loaded with isDemo.
 */
const asPhoto = (image, { isDemo = false } = {}) => ({ canvas: null, image, width: image.width, height: image.height, isDemo, _luma: null });

/** The slice of the app state the measuring code reads. */
const initialState = (config) => ({
  referenceId: config.measurement.defaultReferenceId,
  customReference: { widthMm: null, heightMm: null },
});

/** js/screens/sheet.js: the customer taps the sheet. */
const tapSheet = (photo, point) => detectSheet(photo.image, point, { luma: getLuma(photo) });

/** js/screens/sheet.js: what the screen makes of the tap: 'found', 'check' (kept, but not trusted) or 'manual'. */
const sheetOutcome = (config, state, photo, sheet) =>
  sheetDetectionOutcome(sheet, getSheetMm(state, config), photo.width, photo.height, config.measurement.plausible);

/** js/screens/sheet.js: is a detected outline announced as the sheet (the green "Auto-detected" state)? */
const sheetAccepted = (config, state, photo, sheet) => sheetOutcome(config, state, photo, sheet) === 'found';

/**
 * js/screens/sheet.js: what the screen keeps in state.sheet after the tap. Only an outline announced as
 * found counts as snapped corners; one the screen is unsure of is kept for the customer to check and is
 * measured as hand-placed. Null when the customer is sent to place the corners by hand.
 */
function markedSheet(config, state, photo, sheet) {
  const outcome = sheetOutcome(config, state, photo, sheet);
  return outcome === 'manual' ? null : { points: sheet.quad, refined: outcome === 'found' };
}

/** js/screens/door.js: "Measure my door", from the corners kept in state.sheet and the marked door corners. */
function measure(config, state, photo, marked, doorPx) {
  const m = config.measurement;
  return measureDoor({
    sheetPx: marked.points,
    doorPx,
    sheetMm: getSheetMm(state, config),
    imageSize: { width: photo.width, height: photo.height },
    sigmaSheetPx: marked.refined ? m.sigmaSheetRefinedPx : m.sigmaSheetManualPx,
    sigmaDoorPx: m.sigmaDoorPx,
    plausible: m.plausible,
  });
}

/** js/screens/door.js: the rule-adjusted, rounded size every later screen works from. */
const toSize = (config, result) => ({
  ...applyMeasurementRules(config.measurement, { widthMm: result.widthMm, heightMm: result.heightMm }),
  source: 'photo',
});

/** js/screens/result.js: the flattened preview of the door. */
const flatten = (photo, result) =>
  warpToRect(photo.image, result.planeToImage, {
    widthMm: result.widthMm,
    heightMm: result.heightMm,
    marginMm: PREVIEW_MARGIN_MM,
    outWidth: PREVIEW_WIDTH_PX,
  });

/** js/screens/details.js: the measurement block of the enquiry (the paper measure has no `method`). */
const leadMeasurement = (size, result) => detailsLeadMeasurement({ size, measure: result });

/** js/screens/details.js: is the size being sent the bundled demo door's, not the customer's own? */
const isDemoDoor = (size, photo) => detailsIsDemoDoor({ size, photo });

/**
 * Photograph a scene and take it as far as a size, the way a customer would: one tap in the middle of
 * the sheet, then four door corners placed a couple of pixels out. Never asserts and never throws for a
 * failed stage (later stages are null), so each test can report the first thing that actually went wrong.
 */
function runPipeline(sceneOptions, config = baseConfig) {
  const { image, truth } = renderScene(sceneOptions);
  const photo = asPhoto(image);
  const state = initialState(config);
  const sheet = tapSheet(photo, centroid(truth.sheetPx));
  const marked = markedSheet(config, state, photo, sheet);
  const doorPx = slipQuad(truth.doorPx, DOOR_SEED, DOOR_SLIP_PX);
  const result = marked ? measure(config, state, photo, marked, doorPx) : null;
  const size = result && result.ok ? toSize(config, result) : null;
  return { config, photo, truth, state, sheet, marked, doorPx, result, size };
}

/** Colour of the flattened preview at a door-plane position (mm from the opening's top-left corner). */
function previewColourAt(preview, result, xMm, yMm) {
  const u = Math.floor(((xMm + PREVIEW_MARGIN_MM) / (result.widthMm + 2 * PREVIEW_MARGIN_MM)) * preview.width);
  const v = Math.floor(((yMm + PREVIEW_MARGIN_MM) / (result.heightMm + 2 * PREVIEW_MARGIN_MM)) * preview.height);
  const i = (v * preview.width + u) * 4;
  return Array.from(preview.data.subarray(i, i + 4));
}

/* ------------------------------------------------------------------------------------------------------ */
/* Shared assertions                                                                                      */
/* ------------------------------------------------------------------------------------------------------ */

function assertSheetFound(sheet, truthQuad, tolPx, label) {
  assert.equal(sheet.ok, true, `${label}: sheet found (reason: ${sheet.reason})`);
  assert.equal(sheet.refined, true, `${label}: corners refined to sub-pixel accuracy`);
  assert.ok(sheet.confidence > 0.8 && sheet.confidence <= 1, `${label}: confidence ${sheet.confidence}`);
  const error = maxCornerError(sheet.quad, truthQuad);
  assert.ok(error <= tolPx, `${label}: worst corner is ${error.toFixed(3)} px from the truth (limit ${tolPx})`);
}

function assertMeasured(run, { widthTolMm, heightTolMm, orientation }) {
  const { result, size } = run;
  assert.ok(result, 'the sheet was found, so there is a measurement');
  assert.equal(result.ok, true, `measureDoor succeeded (${result.error}: ${result.message})`);

  const widthError = result.widthMm - TRUE_WIDTH_MM;
  const heightError = result.heightMm - TRUE_HEIGHT_MM;
  assert.ok(Math.abs(widthError) <= widthTolMm, `width ${result.widthMm.toFixed(1)} mm is within ${widthTolMm} mm of ${TRUE_WIDTH_MM}`);
  assert.ok(Math.abs(heightError) <= heightTolMm, `height ${result.heightMm.toFixed(1)} mm is within ${heightTolMm} mm of ${TRUE_HEIGHT_MM}`);

  assert.ok(['good', 'fair'].includes(result.quality.level), `quality is ${result.quality.level} (${result.quality.issues.join(', ')})`);
  assert.ok(result.quality.score > 0 && result.quality.score <= 1);
  for (const major of ['high_residual', 'methods_disagree', 'implausible_size']) {
    assert.ok(!result.quality.issues.includes(major), `no ${major}`);
  }

  assert.ok(result.sigmaWidthMm > 0 && Number.isFinite(result.sigmaWidthMm));
  assert.ok(result.sigmaHeightMm > 0 && Number.isFinite(result.sigmaHeightMm));
  assert.ok(Math.abs(widthError) <= 4 * result.sigmaWidthMm, `width error ${widthError.toFixed(2)} mm vs sigma ${result.sigmaWidthMm.toFixed(2)} mm`);
  assert.ok(Math.abs(heightError) <= 4 * result.sigmaHeightMm, `height error ${heightError.toFixed(2)} mm vs sigma ${result.sigmaHeightMm.toFixed(2)} mm`);

  assert.equal(result.sheetOrientation, orientation);
  // The model can absorb most of a small slip (16 observations, 13 parameters), so the residual stays
  // well under the slips themselves.
  assert.ok(result.rmsResidualPx < DOOR_SLIP_PX, `reprojection RMS ${result.rmsResidualPx.toFixed(2)} px`);

  // imageToPlane: origin at the door's top-left corner, x right, y down, in mm.
  const planeCorners = [
    { x: 0, y: 0 },
    { x: result.widthMm, y: 0 },
    { x: result.widthMm, y: result.heightMm },
    { x: 0, y: result.heightMm },
  ];
  run.doorPx.forEach((corner, i) => {
    const onPlane = applyHomography(result.imageToPlane, corner);
    const off = Math.hypot(onPlane.x - planeCorners[i].x, onPlane.y - planeCorners[i].y);
    assert.ok(off < 12, `marked door corner ${i} maps to within 12 mm of its plane corner (${off.toFixed(1)} mm)`);
    const back = applyHomography(result.planeToImage, onPlane);
    assert.ok(Math.hypot(back.x - corner.x, back.y - corner.y) < 1e-6, 'planeToImage undoes imageToPlane');
  });

  assert.deepEqual(size, { widthMm: Math.round(result.widthMm), heightMm: Math.round(result.heightMm), source: 'photo' });
}

/** The same door marked SWEEP_SEEDS different ways: how the size and its claimed uncertainty hold up. */
function sweepDoorSlips(run, { widthTolMm, heightTolMm }) {
  const stats = { failed: 0, poor: 0, withinTol: 0, worstZ: 0, rmsZ: 0 };
  let sumZ2 = 0;
  let measured = 0;
  for (let seed = 1; seed <= SWEEP_SEEDS; seed++) {
    const result = measure(run.config, run.state, run.photo, run.marked, slipQuad(run.truth.doorPx, seed, DOOR_SLIP_PX));
    if (!result.ok) {
      stats.failed++;
      continue;
    }
    measured++;
    if (result.quality.level === 'poor') stats.poor++;
    const widthError = result.widthMm - TRUE_WIDTH_MM;
    const heightError = result.heightMm - TRUE_HEIGHT_MM;
    if (Math.abs(widthError) <= widthTolMm && Math.abs(heightError) <= heightTolMm) stats.withinTol++;
    const zw = widthError / result.sigmaWidthMm;
    const zh = heightError / result.sigmaHeightMm;
    sumZ2 += zw * zw + zh * zh;
    stats.worstZ = Math.max(stats.worstZ, Math.abs(zw), Math.abs(zh));
  }
  stats.rmsZ = Math.sqrt(sumZ2 / (2 * Math.max(1, measured)));
  return stats;
}

function assertSweep(run, t, { widthTolMm, heightTolMm, minShare }) {
  const stats = sweepDoorSlips(run, { widthTolMm, heightTolMm });
  const share = stats.withinTol / SWEEP_SEEDS;
  t.diagnostic(
    `${SWEEP_SEEDS} markings: ${(100 * share).toFixed(1)}% within ${widthTolMm} / ${heightTolMm} mm, ` +
      `worst error ${stats.worstZ.toFixed(2)} sigma, rms ${stats.rmsZ.toFixed(2)} sigma`,
  );
  assert.equal(stats.failed, 0, 'every marking gives a measurement');
  assert.equal(stats.poor, 0, 'no marking is graded poor');
  assert.ok(share >= minShare, `${(100 * share).toFixed(1)}% of markings are within ${widthTolMm} / ${heightTolMm} mm`);
  assert.ok(stats.worstZ <= 4, `worst error is ${stats.worstZ.toFixed(2)} reported sigmas`);

  // Calibration. A uniform +-DOOR_SLIP_PX slip is DOOR_SLIP_PX / sqrt(3) px rms per axis, against the
  // sigmaDoorPx the fit was told to expect, so errors should run at about that fraction of the reported
  // sigma: a little under, because the reported sigma also budgets for sheet-corner error that a refined
  // sheet barely has. Far below means the uncertainty is overstated; above, understated.
  const expectedZ = DOOR_SLIP_PX / Math.sqrt(3) / run.config.measurement.sigmaDoorPx;
  assert.ok(
    stats.rmsZ > 0.5 * expectedZ && stats.rmsZ < 1.15 * expectedZ,
    `errors run at ${stats.rmsZ.toFixed(2)} of the reported sigma (about ${expectedZ.toFixed(2)} expected)`,
  );
}

function assertPreview(run) {
  const { photo, result } = run;
  const preview = flatten(photo, result);
  const totalW = result.widthMm + 2 * PREVIEW_MARGIN_MM;
  const totalH = result.heightMm + 2 * PREVIEW_MARGIN_MM;

  assert.equal(preview.width, PREVIEW_WIDTH_PX);
  assert.ok(Math.abs(preview.height - (PREVIEW_WIDTH_PX * totalH) / totalW) <= 0.5, 'height follows from (H + 2m) / (W + 2m)');
  assert.ok(Math.abs(preview.width / preview.height - totalW / totalH) < 1 / preview.height, 'aspect ratio matches (W + 2m) / (H + 2m)');
  assert.equal(preview.data.length, preview.width * preview.height * 4);

  const at = (xMm, yMm) => previewColourAt(preview, result, xMm, yMm);
  const midY = TRUE_HEIGHT_MM / 2;
  assertColour(at(410, 700), PAPER_RGB, 'sheet centre is paper white');
  assertColour(at(57, midY), DOOR_RGB, 'left stile is the door colour');
  assertColour(at(410, 60), DOOR_RGB, 'top rail is the door colour');

  // The opening's edges land where the preview says they are: door just inside, frame just outside.
  assertColour(at(15, midY), DOOR_RGB, '15 mm inside the left edge');
  assertColour(at(-15, midY), ARCHITRAVE_RGB, '15 mm outside the left edge');
  assertColour(at(TRUE_WIDTH_MM - 15, 600), DOOR_RGB, '15 mm inside the right edge');
  assertColour(at(TRUE_WIDTH_MM + 15, 600), ARCHITRAVE_RGB, '15 mm outside the right edge');
  assertColour(at(410, 15), DOOR_RGB, '15 mm inside the top edge');
  assertColour(at(410, -15), ARCHITRAVE_RGB, '15 mm outside the top edge');
  assertColour(at(410, TRUE_HEIGHT_MM - 15), DOOR_RGB, '15 mm inside the bottom edge');

  for (const [x, y] of [[410, 700], [57, midY], [-15, midY]]) assert.equal(at(x, y)[3], 255, 'pixels inside the photo are opaque');
  return preview;
}

/** What a quote should come to for a standard-size door, worked out from the config alone. */
function expectedStandardTotal(config, product, selections, includeInstallation) {
  const { options, installation } = config.pricing;
  let total = product.basePrice;
  for (const option of options) {
    if (option.type === 'select') {
      const chosen = option.choices.find((choice) => choice.id === (selections[option.id] ?? option.default));
      total += chosen.price;
    } else if (selections[option.id] ?? option.default) {
      total += option.price;
    }
  }
  if (installation.enabled && includeInstallation) total += installation.price;
  return total;
}

/** Every way the options can be set: each select choice x each checkbox on or off. */
function optionCombinations(options) {
  let combos = [{}];
  for (const option of options) {
    const values = option.type === 'select' ? option.choices.map((choice) => choice.id) : [false, true];
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [option.id]: value })));
  }
  return combos;
}

/** Whole cents, the unit js/quote.js adds up in: amounts in currency units pick up float noise once cents are involved. */
const cents = (amount) => Math.round(amount * 100);

function assertQuoteAddsUp(quote, config, label) {
  assert.equal(quote.ok, true, `${label}: ok (${quote.messages.join(' ')})`);
  assert.equal(quote.status, 'ok', label);
  assert.ok(quote.total > 0, `${label}: positive total`);
  const lineTotal = sum(quote.lineItems.map((item) => item.amount));
  const expected = config.pricing.pricesIncludeTax ? lineTotal : lineTotal + quote.taxAmount;
  assert.equal(cents(quote.total), cents(expected), `${label}: total equals the sum of its line items`);
  assert.equal(cents(quote.subtotal + quote.taxAmount), cents(quote.total), `${label}: subtotal + tax = total`);
  assert.equal(quote.currency, config.pricing.currency);
  assert.equal(quote.lineItems[0].id, 'product');
}

async function assertLeadGoesThrough(run, quote, product) {
  const { config, size, result, photo } = run;
  assert.equal(leadMode(config), 'demo', 'the shipped settings send nothing anywhere');

  assert.deepEqual(validateCustomer(config, CUSTOMER), { ok: true, errors: {} });
  const refused = validateCustomer(config, { ...CUSTOMER, consent: false });
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.consent, 'consent is required');

  const payload = buildLeadPayload({
    config,
    customer: CUSTOMER,
    measurement: leadMeasurement(size, result),
    quote,
    selections: quote.selections,
    includeInstallation: quote.includeInstallation,
    product,
    photoDataUrl: null,
    demo: isDemoDoor(size, photo),
    now: new Date('2026-03-04T05:06:07Z'),
  });
  assert.match(payload.reference, /^SM-[0-9A-Z]{6}$/);
  assert.equal(payload.createdAt, '2026-03-04T05:06:07.000Z');
  assert.equal(payload.brand, config.brand.name);
  assert.equal(payload.demo, photo.isDemo, 'marked as a demo only when the size came from the bundled demo photo');
  assert.equal(payload.customer.name, CUSTOMER.name);
  assert.equal(payload.customer.consent, true);
  assert.equal(payload.measurement.widthMm, size.widthMm);
  assert.equal(payload.measurement.heightMm, size.heightMm);
  assert.equal(payload.measurement.source, 'photo');
  assert.equal(payload.measurement.quality, result.quality.level);
  assert.deepEqual(payload.product, { id: product.id, name: product.name });
  assert.equal(payload.includeInstallation, quote.includeInstallation);
  assert.equal(payload.quote.status, 'ok');
  assert.equal(payload.quote.total, quote.total);
  assert.deepEqual(payload.quote.lineItems, quote.lineItems);
  assert.ok(!('photo' in payload), 'no photo unless the company asks for one');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, 'payload survives JSON unchanged');

  assert.deepEqual(await submitLead(config, payload), { ok: true, mode: 'demo' });
  return payload;
}

/** The enquiry for a run's size with the first product at its default options, built under `config`. */
function enquiryFor(config, run) {
  const { size, result, photo } = run;
  const product = config.pricing.products[0];
  const quote = calculateQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id });
  return buildLeadPayload({
    config,
    customer: CUSTOMER,
    measurement: leadMeasurement(size, result),
    quote,
    selections: quote.selections,
    includeInstallation: quote.includeInstallation,
    product,
    photoDataUrl: null,
    demo: isDemoDoor(size, photo),
    now: new Date('2026-03-04T05:06:07Z'),
  });
}

/* ------------------------------------------------------------------------------------------------------ */
/* The bundled demo scene                                                                                 */
/* ------------------------------------------------------------------------------------------------------ */

// The demo scene is shared with the skin tests further down, so it is rendered once.
let demoRun = null;
const getDemoRun = () => (demoRun ??= runPipeline(DEMO_SCENE));

describe('demo scene, default config: one photo to a price and an enquiry', () => {
  let demo;
  before(() => {
    demo = getDemoRun();
  });

  test('a tap in the middle of the sheet finds it, refined to a small fraction of a pixel', () => {
    assertSheetFound(demo.sheet, demo.truth.sheetPx, CLEAN_SHEET_TOL_PX, 'centre tap');
  });

  test('taps 40 px away from the middle find the same sheet', () => {
    const centre = centroid(demo.truth.sheetPx);
    const offsets = [[40, 0], [-40, 0], [0, 40], [0, -40], [28.3, 28.3], [-28.3, 28.3], [28.3, -28.3], [-28.3, -28.3]];
    for (const [dx, dy] of offsets) {
      const sheet = tapSheet(demo.photo, { x: centre.x + dx, y: centre.y + dy });
      assertSheetFound(sheet, demo.truth.sheetPx, CLEAN_SHEET_TOL_PX, `tap at ${dx}, ${dy}`);
      assert.ok(maxCornerError(sheet.quad, demo.sheet.quad) < 0.1, 'same outline as the centre tap');
    }
  });

  test('a tap that misses the sheet fails cleanly, so the screen can fall back to manual corners', () => {
    const H = demo.truth.planeToImage;
    const misses = {
      'door stile': applyHomography(H, { x: 57, y: 1020 }),
      wall: applyHomography(H, { x: -300, y: 1000 }),
      'outside the photo': { x: -10, y: 50 },
    };
    for (const [where, point] of Object.entries(misses)) {
      const sheet = tapSheet(demo.photo, point);
      assert.equal(sheet.ok, false, `${where}: not a sheet`);
      assert.equal(sheet.quad, null);
      assert.equal(sheet.refined, false);
      assert.ok(DETECT_FAILURE_REASONS.includes(sheet.reason), `${where}: reason ${sheet.reason}`);
    }
  });

  test('only the sheet is announced as found: a tapped door panel, step or handle plate goes the manual way', () => {
    const { config, state, photo, truth } = demo;
    assert.equal(sheetAccepted(config, state, photo, demo.sheet), true, 'the real sheet is accepted');

    // Door-plane positions (mm) of things that are quad-shaped too. detectSheet returns most of them as
    // clean, confident outlines; the screen must not tell the customer the sheet was found.
    const H = truth.planeToImage;
    const decoys = {
      'upper panel': { x: 410, y: 300 },
      'lower left panel': { x: 240, y: 1500 },
      'lower right panel': { x: 580, y: 1500 },
      step: { x: 410, y: 2110 },
      'handle plate': { x: 760, y: 1080 },
    };
    let outlined = 0;
    for (const [what, mm] of Object.entries(decoys)) {
      const found = tapSheet(photo, applyHomography(H, mm));
      if (found.ok) outlined++;
      assert.equal(sheetAccepted(config, state, photo, found), false, `${what} is not taken for the sheet`);
    }
    assert.ok(outlined >= 3, `the check is what rejects them: ${outlined} of 5 decoys came back as outlines`);

    // The same sheet is still accepted when the customer says it is US Letter (close in shape and size),
    // and refused as a bank card, which could never be that big with the whole door in the photo.
    const as = (referenceId) => sheetAccepted(config, { ...state, referenceId }, photo, demo.sheet);
    assert.equal(as('letter'), true);
    assert.equal(as('card'), false);
  });

  test('"Snap to edges" pulls hand-placed sheet corners onto the paper', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rough = slipQuad(demo.truth.sheetPx, seed, 6);
      // The photo itself, as the screen passes it: the snap then has the sheet's colour to check against.
      const snapped = refineQuad(demo.photo.image, rough);
      assert.equal(snapped.ok, true, `seed ${seed}: ${snapped.reason}`);
      const error = maxCornerError(snapped.quad, demo.truth.sheetPx);
      assert.ok(error <= CLEAN_SHEET_TOL_PX, `seed ${seed}: worst corner ${error.toFixed(3)} px from the truth`);
    }
  });

  test('door corners marked a couple of pixels out still measure 820 x 2040 mm', (t) => {
    assertMeasured(demo, { widthTolMm: 4, heightTolMm: 6, orientation: 'portrait' });
    // The README quotes this result ("Simulated accuracy" and the sample enquiry): if it moves, so must they.
    const { result, size } = demo;
    t.diagnostic(
      `${size.widthMm} x ${size.heightMm} mm, graded ${result.quality.level}, sigma ${result.sigmaWidthMm.toFixed(1)} / ${result.sigmaHeightMm.toFixed(1)} mm`,
    );
    assert.equal(result.quality.level, 'good', 'a clean, straight-on photo with snapped sheet corners is a good measurement');
    assert.deepEqual(result.quality.issues, []);
  });

  test('an outline the sheet screen is unsure of is kept, but measured as hand-placed corners', () => {
    const { config, state, photo, sheet, doorPx, result } = demo;
    // What detectSheet returns when it cannot confirm a side against the paper, or is not confident.
    for (const unsure of [{ ...sheet, refined: false, confidence: 0.4, reason: 'off_sheet' }, { ...sheet, confidence: 0.65 }]) {
      assert.equal(sheetOutcome(config, state, photo, unsure), 'check');
      const marked = markedSheet(config, state, photo, unsure);
      assert.deepEqual(marked, { points: sheet.quad, refined: false });
      const rough = measure(config, state, photo, marked, doorPx);
      assert.equal(rough.ok, true);
      // The same corners, so much the same size; what changes is how far the app trusts it.
      assert.ok(Math.abs(rough.widthMm - result.widthMm) < 2 && Math.abs(rough.heightMm - result.heightMm) < 4);
      assert.ok(rough.sigmaHeightMm > 2 * result.sigmaHeightMm, `sigma ${rough.sigmaHeightMm.toFixed(1)} mm against ${result.sigmaHeightMm.toFixed(1)} mm`);
      assert.equal(rough.quality.level, 'poor', 'hand-placed sheet corners grade poor (shown as a rough measurement)');
    }
    // Nothing usable sends the customer to place the corners by hand: there is nothing to measure yet.
    assert.equal(markedSheet(config, state, photo, { ok: false, quad: null, refined: false, confidence: 0, reason: 'cut_off' }), null);
  });

  test('the answer holds however the door corners are a couple of pixels out', (t) => {
    assertSweep(demo, t, { widthTolMm: 4, heightTolMm: 6, minShare: 0.9 });
  });

  test('corner order and the way round the sheet size is given make no difference', () => {
    const { config, photo, marked, doorPx, result } = demo;
    const shuffledSheet = { ...marked, points: [marked.points[2], marked.points[0], marked.points[3], marked.points[1]] };
    const shuffledDoor = [doorPx[3], doorPx[1], doorPx[0], doorPx[2]];
    const sideways = { referenceId: 'custom', customReference: { widthMm: 297, heightMm: 210 } };
    const again = measure(config, sideways, photo, shuffledSheet, shuffledDoor);
    assert.equal(again.ok, true);
    assert.ok(Math.abs(again.widthMm - result.widthMm) < 1e-6);
    assert.ok(Math.abs(again.heightMm - result.heightMm) < 1e-6);
    assert.equal(again.sheetOrientation, 'portrait');
  });

  test('the flattened preview shows the sheet, the door and its frame where the measurement says', () => {
    const preview = assertPreview(demo);
    let transparent = 0;
    for (let i = 3; i < preview.data.length; i += 4) if (preview.data[i] === 0) transparent++;
    assert.equal(transparent, 0, 'the whole preview lies inside the demo photo');
  });

  test('the measured size prices instantly for the first product', () => {
    const { config, size } = demo;
    const product = config.pricing.products[0];
    const quote = calculateQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id });
    assertQuoteAddsUp(quote, config, product.id);
    assert.equal(quote.sizeCategory, 'standard');
    assert.equal(quote.total, expectedStandardTotal(config, product, {}, config.pricing.installation.default));
    assert.equal(quote.productId, product.id);
  });

  test('the enquiry validates, builds and submits in demo mode', async () => {
    const { config, size } = demo;
    const product = config.pricing.products[0];
    const quote = calculateQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id });
    await assertLeadGoesThrough(demo, quote, product);
  });

  test('with lead.endpoint set, the same enquiry is POSTed to the company as JSON text, with no preflight', async (t) => {
    const config = deepMerge(baseConfig, { lead: { endpoint: 'https://crm.example/securemeasure-leads' } });
    assert.equal(leadMode(config), 'webhook');
    const payload = enquiryFor(config, demo);
    assert.equal(payload.demo, false);

    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 204 };
    });
    assert.deepEqual(await submitLead(config, payload), { ok: true, mode: 'webhook' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://crm.example/securemeasure-leads');
    assert.equal(requests[0].init.method, 'POST');
    // A CORS "simple" request, so a webhook on another domain gets no preflight: text/plain is the only
    // header, and nothing asks for cookies or credentials.
    assert.deepEqual(requests[0].init.headers, { 'Content-Type': 'text/plain;charset=UTF-8' });
    assert.ok(!('credentials' in requests[0].init) && !('mode' in requests[0].init));
    assert.deepEqual(JSON.parse(requests[0].init.body), payload);

    // A company's own server that insists on application/json (and answers the preflight) can ask for it.
    const asJson = deepMerge(config, { lead: { contentType: 'application/json' } });
    assert.deepEqual(await submitLead(asJson, payload), { ok: true, mode: 'webhook' });
    assert.deepEqual(requests[1].init.headers, { 'Content-Type': 'application/json' });
    assert.equal(requests[1].init.body, requests[0].init.body);

    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));
    assert.deepEqual(await submitLead(config, payload), { ok: false, mode: 'webhook', error: 'http_500' });
  });

  test('with lead.mailto set, the enquiry opens as a readable, pre-filled email', async () => {
    const config = deepMerge(baseConfig, { lead: { mailto: 'sales@doors.example' } });
    assert.equal(leadMode(config), 'mailto');
    const payload = enquiryFor(config, demo);
    const { size, result } = demo;

    globalThis.location = { href: 'https://doors.example/measure/' };
    try {
      assert.deepEqual(await submitLead(config, payload), { ok: true, mode: 'mailto' });
      const url = new URL(globalThis.location.href);
      assert.equal(url.protocol, 'mailto:');
      assert.equal(url.pathname, 'sales@doors.example');
      assert.ok(globalThis.location.href.length < 2000, 'short enough for every mail client');
      assert.ok(url.searchParams.get('subject').includes(payload.reference));
      assert.ok(!url.searchParams.get('subject').includes('[DEMO]'), "the customer's own door is not tagged as a demo");
      const body = url.searchParams.get('body');
      for (const line of [
        `Reference: ${payload.reference}`,
        `Door size: ${size.widthMm} mm wide x ${size.heightMm} mm high`,
        // The same "accurate to about" figures the customer saw: two sigma, rounded up.
        `confidence ${result.quality.level} (about +/- ${Math.ceil(2 * result.sigmaWidthMm)} mm wide, +/- ${Math.ceil(2 * result.sigmaHeightMm)} mm high)`,
        `Product: ${config.pricing.products[0].name}`,
        CUSTOMER.name,
        CUSTOMER.phone,
        CUSTOMER.notes,
      ]) {
        assert.ok(body.includes(line), `email body mentions "${line}"`);
      }
    } finally {
      delete globalThis.location;
    }
  });
});

/* ------------------------------------------------------------------------------------------------------ */
/* The committed assets                                                                                   */
/* ------------------------------------------------------------------------------------------------------ */

describe('bundled demo photo (assets/demo-door.png)', () => {
  const pngBytes = readFileSync(new URL('../assets/demo-door.png', import.meta.url));
  const truthJson = JSON.parse(readFileSync(new URL('../assets/demo-door.truth.json', import.meta.url), 'utf8'));

  test('is a 1536 x 2048 PNG under 1.2 MB with a truth file that matches DEMO_SCENE', () => {
    assert.equal(pngBytes.toString('latin1', 12, 16), 'IHDR');
    assert.equal(pngBytes.readUInt32BE(16), 1536);
    assert.equal(pngBytes.readUInt32BE(20), 2048);
    assert.ok(pngBytes.length < 1.2 * 1024 * 1024, `demo PNG is ${pngBytes.length} bytes`);
    assert.deepEqual(truthJson, truthToJson(sceneTruth(DEMO_SCENE), DEMO_SCENE));
    assert.equal(truthJson.widthMm, TRUE_WIDTH_MM);
    assert.equal(truthJson.heightMm, TRUE_HEIGHT_MM);
  });

  /** The demo photo as "Try it with a demo photo" loads it, taken as far as a size with the true door corners. */
  function runDemoPhoto(config) {
    const photo = asPhoto(decodePng(pngBytes), { isDemo: true });
    // js/demo.js (selectDemoReference): the paper demo photo is always measured with its own A4 sheet,
    // whatever is selected.
    const state = { referenceId: 'custom', customReference: { widthMm: 210, heightMm: 297 } };
    const sheet = tapSheet(photo, centroid(truthJson.sheetPx));
    const marked = markedSheet(config, state, photo, sheet);
    const result = marked ? measure(config, state, photo, marked, truthJson.doorPx) : null;
    const size = result && result.ok ? toSize(config, result) : null;
    return { config, photo, state, sheet, marked, doorPx: truthJson.doorPx, result, size };
  }

  test('measures 820 x 2040 mm from one tap and the true door corners', () => {
    const run = runDemoPhoto(baseConfig);
    const { photo, sheet, result } = run;
    assert.equal(photo.width, truthJson.imageWidth);
    assert.equal(photo.height, truthJson.imageHeight);

    assertSheetFound(sheet, truthJson.sheetPx, CLEAN_SHEET_TOL_PX, 'committed photo');
    assert.equal(sheetAccepted(baseConfig, run.state, photo, sheet), true, 'and the screen accepts it');

    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.widthMm - truthJson.widthMm) < 1, `width ${result.widthMm.toFixed(2)} mm`);
    assert.ok(Math.abs(result.heightMm - truthJson.heightMm) < 1, `height ${result.heightMm.toFixed(2)} mm`);
    assert.ok(['good', 'fair'].includes(result.quality.level), `quality ${result.quality.level}`);
    assert.deepEqual(run.size, { widthMm: TRUE_WIDTH_MM, heightMm: TRUE_HEIGHT_MM, source: 'photo' });
  });

  test('an enquiry measured from it is marked as a demo, in the data and in the email', async () => {
    const run = runDemoPhoto(baseConfig);
    assert.equal(enquiryFor(baseConfig, run).demo, true);

    // A size the customer typed in after trying the demo is their own door, not the demo door.
    const typed = { ...run, size: { widthMm: 900, heightMm: 2100, source: 'manual' } };
    assert.equal(enquiryFor(baseConfig, typed).demo, false);

    const config = deepMerge(baseConfig, { lead: { mailto: 'sales@doors.example' } });
    const payload = enquiryFor(config, run);
    globalThis.location = { href: 'https://doors.example/measure/' };
    try {
      assert.deepEqual(await submitLead(config, payload), { ok: true, mode: 'mailto' });
      const url = new URL(globalThis.location.href);
      assert.ok(url.searchParams.get('subject').startsWith('[DEMO] '), `subject: ${url.searchParams.get('subject')}`);
      assert.ok(url.searchParams.get('subject').includes(payload.reference));
      assert.ok(url.searchParams.get('body').includes('from the built-in demo photo'), 'the body says whose door it is');
    } finally {
      delete globalThis.location;
    }
  });
});

/* ------------------------------------------------------------------------------------------------------ */
/* The no-paper photo estimate                                                                            */
/* ------------------------------------------------------------------------------------------------------ */

// No sheet in the sums: the four corners and the lens give the opening's height-to-width ratio, which is
// matched to the company's standard sizes (an estimate the result screen says needs a check measure).
// Neither the rendered scene nor the committed PNG carries EXIF. The scene, taken as a grabbed video frame,
// gets the 26 mm phone prior; it was shot with a longer lens (DEMO_CAMERA focalPx 2100, about 35 mm), so
// this also shows a near-frontal photo barely depends on the guess. The bundled demo photo is different:
// js/demo.js loadDemo knows the lens it was rendered with (demoPhotoFocal35mm) and sets it on the photo,
// so its estimate uses that focal length ('exif'), as the app does.

/** The corner the detector may be off by (its sill edge sits on a shadow band; see tests/door-detect.test.mjs). */
const DETECT_TOL_PX = 8;

/** What loadPhoto (js/photo.js) hands the no-paper path: no EXIF focal (PNG, video frame), and how it was taken. */
const asEstimatePhoto = (image, { isDemo = false, capture = 'frame' } = {}) => ({
  ...asPhoto(image, { isDemo }),
  focal35mm: null,
  capture: isDemo ? 'demo' : capture,
});

/** The capture screen's viewfinder on a 375 px wide phone, over a 1536 x 2048 portrait video stream. */
const PHONE_VIEW = Object.freeze({ viewW: 375, viewH: 620, videoW: 1536, videoH: 2048 });

/** js/screens/capture.js: the guide the customer framed the door in, as a detection prior in photo px. */
const guidePrior = (photo) =>
  priorFromGuide({ guide: guideRect(PHONE_VIEW.viewW, PHONE_VIEW.viewH), ...PHONE_VIEW, photoW: photo.width, photoH: photo.height });

/**
 * A photo taken as far as a standard size, the way the screens do it, in the app's own initial state:
 * the capture screen (or, for the bundled demo photo, the welcome screen's demo) makes it the session's
 * photo and finds the door in it; the door screen starts the handles there and, the detection being
 * confident, "Find my door size" measures them untouched.
 */
async function runEstimate(photo, config = baseConfig) {
  const state = createInitialState(config);
  let prior = null;
  if (photo.isDemo) {
    // js/screens/welcome.js startDemo -> js/demo.js loadDemo (which adds the bundled photo's known lens)
    // -> useDemoPhoto, then findDoor(photo).
    if (photo.focal35mm == null) photo.focal35mm = demoPhotoFocal35mm(demoPhotoUrl(config));
    useDemoPhoto(state, photo, 'estimate', config.measurement);
  } else {
    // js/screens/capture.js usePhoto: setPhoto, the way in, then the door with the guide as the prior.
    setPhoto(state, photo);
    state.method = 'estimate';
    prior = guidePrior(photo);
  }
  state.door.detection = await findDoor(photo, { prior });

  // js/screens/door.js: where the handles start, and whether they count as placed without a drag.
  const { detection } = state.door;
  const points = startingQuad(photo, detection);
  const outlines = doorOutlines(detection, { width: photo.width, height: photo.height });
  const placed = doorCornersPlaced({ confident: isConfident(detection), outline: outlineIndexOf(outlines, points) });

  // js/screens/door.js measureEstimate.
  const focal = photoFocal(photo);
  const measure = estimateFromCorners({
    corners: cornersInOutlineOrder(points),
    imageWidth: photo.width,
    imageHeight: photo.height,
    focalPx: focal.focalPx,
    focalSource: focal.source,
    sizes: standardSizesFrom(config),
  });
  if (measure.ok) {
    const best = measure.candidates[0];
    state.door.points = points;
    state.measure = measure;
    state.size = {
      ...applyMeasurementRules(config.measurement, { widthMm: best.widthMm, heightMm: best.heightMm }),
      source: 'estimate',
      standard: true,
    };
  }
  return { config, photo, state, prior, detection, points, placed, focal, measure, size: state.size };
}

/** js/screens/quote.js + details.js: the enquiry for the estimated size, first product at its default options. */
function estimateEnquiry(run, config = run.config) {
  const { state } = run;
  const product = config.pricing.products[0];
  const quote = calculateQuote(config, { widthMm: state.size.widthMm, heightMm: state.size.heightMm, productId: product.id });
  const payload = buildLeadPayload({
    config,
    customer: CUSTOMER,
    measurement: detailsLeadMeasurement(state, config),
    quote,
    selections: quote.selections,
    includeInstallation: quote.includeInstallation,
    product,
    photoDataUrl: null,
    demo: detailsIsDemoDoor(state),
    now: new Date('2026-03-04T05:06:07Z'),
  });
  return { product, quote, payload };
}

/** The pre-filled email for an enquiry (lead.mailto), as the customer's mail app opens it. */
function mailFor(config, payload) {
  const url = new URL(buildMailtoUrl(config, payload));
  return { url, subject: url.searchParams.get('subject'), body: url.searchParams.get('body') };
}

const sizeLabel = (size) => `${size.widthMm}x${size.heightMm}`;

function assertEstimatesDemoDoor(run, truthDoorPx, label) {
  const { measure, state, focal, photo } = run;
  // The bundled demo photo's lens is known to the app (js/demo.js); any other photo without EXIF gets the prior.
  const lens = photo.isDemo ? 'exif' : 'prior';
  assert.equal(focal.source, lens, `${label}: ${photo.isDemo ? "the bundled demo photo's known lens" : 'no EXIF, so the 26 mm phone prior'}`);
  assert.equal(measure.ok, true, `${label}: estimateFromCorners succeeded (${measure.error})`);
  assert.equal(measure.method, 'estimate');
  assert.equal(measure.focalSource, lens);
  assert.equal(sizeLabel(measure.candidates[0]), '820x2040', `${label}: candidates ${measure.candidates.map(sizeLabel).join(', ')}`);
  assert.equal(measure.widthMm, TRUE_WIDTH_MM);
  assert.equal(measure.heightMm, TRUE_HEIGHT_MM);
  assert.equal(measure.nonStandard, false);
  assert.ok(!measure.issues.includes('not_rectangular'), `${label}: issues ${measure.issues.join(', ')}`);
  const aspectError = Math.abs(measure.aspectHW / (TRUE_HEIGHT_MM / TRUE_WIDTH_MM) - 1);
  assert.ok(aspectError < 0.015, `${label}: height/width ${measure.aspectHW.toFixed(4)} is within 1.5% of the truth`);

  // Only the company's own sizes, best first, at most 4.
  const catalogue = new Set(standardSizesFrom(run.config).map(sizeLabel));
  assert.ok(measure.candidates.length >= 1 && measure.candidates.length <= 4);
  for (const candidate of measure.candidates) assert.ok(catalogue.has(sizeLabel(candidate)), `${sizeLabel(candidate)} is in the catalogue`);
  for (let i = 1; i < measure.candidates.length; i++) assert.ok(measure.candidates[i - 1].p >= measure.candidates[i].p, 'best first');

  // The corners it measured are the detected door, put in [TL, TR, BR, BL] order.
  assert.ok(maxCornerError(measure.corners, truthDoorPx) < DETECT_TOL_PX, `${label}: worst corner ${maxCornerError(measure.corners, truthDoorPx).toFixed(2)} px`);

  // js/screens/door.js: the size every later screen works from, with the company's rules applied.
  assert.deepEqual(state.size, { widthMm: TRUE_WIDTH_MM, heightMm: TRUE_HEIGHT_MM, source: 'estimate', standard: true });
  assert.equal(state.method, 'estimate');
}

describe('no-paper photo estimate: the demo scene from the live camera to a price and an enquiry', () => {
  let run;
  let truth;
  before(async () => {
    const demo = getDemoRun();
    truth = demo.truth;
    // The same render as the paper groups, as a grabbed video frame: no EXIF, framed in the guide.
    run = await runEstimate(asEstimatePhoto(demo.photo.image, { capture: 'frame' }));
  });

  test('the capture guide and the photo find the door confidently, near its true corners', () => {
    const { prior, detection, photo, state } = run;
    assert.ok(Array.isArray(prior) && prior.length === 4, 'a live capture passes the guide as the prior');
    assert.equal(detection.ok, true, `findDoor found a door (${detection.reason})`);
    assert.ok(isConfident(detection), `confidence ${detection.confidence.toFixed(3)} is above "we found your door"`);
    assert.ok(maxCornerError(detection.quad, truth.doorPx) < DETECT_TOL_PX, `worst corner ${maxCornerError(detection.quad, truth.doorPx).toFixed(2)} px`);

    // findDoor runs detectDoor (in a worker in the browser); the raw detector sees the same opening.
    const raw = detectDoor(photo.image);
    assert.equal(raw.ok, true);
    assert.ok(maxCornerError(raw.quad, detection.quad) < 1, 'findDoor reports the detector’s own outline');

    // js/screens/door.js: entered on the photo alone, and a confident detection counts as placed.
    assert.equal(canEnterDoor(state), true);
    assert.equal(run.placed, true, 'the handles on a confident detection may be measured untouched');
  });

  test('the estimate matches the opening to 820 x 2040 mm with the 26 mm prior and the shipped catalogue', (t) => {
    const { measure } = run;
    t.diagnostic(
      `${measure.candidates.map((c) => `${sizeLabel(c)} p=${c.p.toFixed(2)}`).join(', ')}; ` +
        `aspect ${measure.aspectHW.toFixed(4)}, tilt ${measure.viewTiltDeg.toFixed(1)} deg, confident ${measure.confident}`,
    );
    assertEstimatesDemoDoor(run, truth.doorPx, 'demo scene');
  });

  test('the result screen offers that size first, and its flattened preview shows the door where the estimate puts it', () => {
    const { state, measure, photo } = run;
    assert.equal(resultMode(state), 'estimate');
    const choices = estimateChoices(measure);
    assert.ok(choices.length >= 1 && choices.length <= 3);
    assert.equal(sizeLabel(choices[0]), '820x2040');
    // The size the door screen announced is the one the result screen starts on: nothing to send again.
    assert.deepEqual(measuredPayload(state), { widthMm: TRUE_WIDTH_MM, heightMm: TRUE_HEIGHT_MM, source: 'estimate', standard: true });
    if (!measure.confident) assert.ok(estimateBannerKey(measure, choices.length), 'an unsure estimate says so');

    const plane = { planeToImage: planeToImageFor(measure.corners, choices[0].widthMm, choices[0].heightMm), ...choices[0] };
    assert.ok(canPreview(photo.image, plane));
    plane.planeToImage.forEach((v, i) => assert.ok(Math.abs(v - measure.planeToImage[i]) <= 1e-9 * Math.max(1, Math.abs(v)), 'same mapping the estimate carries'));

    const preview = warpToRect(photo.image, plane.planeToImage, {
      widthMm: plane.widthMm,
      heightMm: plane.heightMm,
      marginMm: PREVIEW_MARGIN_MM,
      outWidth: PREVIEW_WIDTH_PX,
    });
    const at = (xMm, yMm) => previewColourAt(preview, plane, xMm, yMm);
    const midY = TRUE_HEIGHT_MM / 2;
    // The paper is in the photo (it is the paper groups' render) but plays no part here: it simply lands
    // where it is on the door because the estimated size is the true one.
    assertColour(at(410, 700), PAPER_RGB, 'sheet centre is paper white');
    assertColour(at(57, midY), DOOR_RGB, 'left stile is the door colour');
    assertColour(at(20, midY), DOOR_RGB, '20 mm inside the left edge');
    assertColour(at(-20, midY), ARCHITRAVE_RGB, '20 mm outside the left edge');
    assertColour(at(TRUE_WIDTH_MM - 20, 600), DOOR_RGB, '20 mm inside the right edge');
    assertColour(at(TRUE_WIDTH_MM + 20, 600), ARCHITRAVE_RGB, '20 mm outside the right edge');
    assertColour(at(410, 20), DOOR_RGB, '20 mm inside the top edge');
    assertColour(at(410, -20), ARCHITRAVE_RGB, '20 mm outside the top edge');
  });

  test('the size prices instantly, and the enquiry carries it as a standard-size estimate with no plus-or-minus', async () => {
    const { config, state, measure } = run;
    const { product, quote, payload } = estimateEnquiry(run);
    assertQuoteAddsUp(quote, config, product.id);
    assert.equal(quote.sizeCategory, 'standard');
    assert.equal(quote.total, expectedStandardTotal(config, product, {}, config.pricing.installation.default));

    assert.equal(payload.demo, false, "the customer's own door");
    assert.equal(payload.measurement.source, 'estimate');
    assert.equal(payload.measurement.standard, true);
    assert.equal(payload.measurement.widthMm, state.size.widthMm);
    assert.equal(payload.measurement.heightMm, state.size.heightMm);
    // The other sizes the result screen offered, as the company lists them.
    assert.deepEqual(
      payload.measurement.alternatives,
      estimateChoices(measure)
        .slice(1)
        .map(({ widthMm, heightMm }) => ({ widthMm, heightMm })),
    );
    assert.ok(Math.abs(payload.measurement.aspectHW - measure.aspectHW) < 1e-4);
    for (const key of ['quality', 'qualityIssues', 'sigmaWidthMm', 'sigmaHeightMm']) {
      assert.ok(!(key in payload.measurement), `no ${key}: the estimate has no millimetre scale of its own`);
    }
    assert.deepEqual(payload.product, { id: product.id, name: product.name });
    assert.equal(payload.quote.total, quote.total);
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, 'payload survives JSON unchanged');
    assert.deepEqual(await submitLead(config, payload), { ok: true, mode: 'demo' });
  });

  test('the email says it is an estimate that needs a check measure, and lists the other sizes it could be', () => {
    const config = deepMerge(baseConfig, { lead: { mailto: 'sales@doors.example' } });
    const { payload } = estimateEnquiry(run, config);
    const { url, subject, body } = mailFor(config, payload);
    assert.equal(url.protocol, 'mailto:');
    assert.equal(url.pathname, 'sales@doors.example');
    assert.ok(subject.includes(payload.reference));
    assert.ok(subject.includes('(820 x 2040 mm)'), `subject: ${subject}`);
    assert.ok(!subject.includes('[DEMO]'), "the customer's own door is not tagged as a demo");
    const lines = [`Door size: ${TRUE_WIDTH_MM} mm wide x ${TRUE_HEIGHT_MM} mm high`, LEAD_MAIL_STRINGS['lead.mail.measuredEstimate']];
    if (payload.measurement.alternatives.length > 0) {
      const sizes = payload.measurement.alternatives.map((s) => `${s.widthMm} x ${s.heightMm} mm`).join(', ');
      lines.push(`Other standard sizes it could be: ${sizes}`);
    }
    for (const line of [...lines, `Product: ${config.pricing.products[0].name}`, CUSTOMER.name, CUSTOMER.notes]) {
      assert.ok(body.includes(line), `email body mentions "${line}"`);
    }
    assert.ok(!body.includes('+/-'), 'no accuracy figure that nobody measured');
    assert.ok(!body.includes('confidence'), 'no paper-method fit grade');
  });
});

describe('no-paper photo estimate: the bundled demo photo (assets/demo-door.png)', () => {
  const pngBytes = readFileSync(new URL('../assets/demo-door.png', import.meta.url));
  const truthJson = JSON.parse(readFileSync(new URL('../assets/demo-door.truth.json', import.meta.url), 'utf8'));
  let run;
  before(async () => {
    run = await runEstimate(asEstimatePhoto(decodePng(pngBytes), { isDemo: true }));
  });

  test('"Try it with a demo photo": detectDoor finds the door and estimateFromCorners makes it 820 x 2040 mm', () => {
    const { photo, detection, state } = run;
    assert.equal(photo.width, truthJson.imageWidth);
    assert.equal(photo.height, truthJson.imageHeight);
    assert.equal(photo.capture, 'demo');
    assert.equal(state.method, 'estimate', 'the welcome demo takes the no-paper way in');

    const raw = detectDoor(photo.image);
    assert.equal(raw.ok, true, `detectDoor found a door (${raw.reason})`);
    assert.ok(raw.confidence > 0.6, `confidence ${raw.confidence.toFixed(3)}`);
    assert.ok(maxCornerError(raw.quad, truthJson.doorPx) < DETECT_TOL_PX, `worst corner ${maxCornerError(raw.quad, truthJson.doorPx).toFixed(2)} px`);
    assert.ok(isConfident(detection), 'findDoor says "we found your door"');
    assert.equal(run.placed, true);

    assertEstimatesDemoDoor(run, truthJson.doorPx, 'demo photo');

    // The true corners give the same answer: the match does not hang on the detector's few pixels.
    const exact = estimateFromCorners({
      corners: truthJson.doorPx,
      imageWidth: photo.width,
      imageHeight: photo.height,
      ...photoFocal(photo),
      sizes: standardSizesFrom(baseConfig),
    });
    assert.equal(exact.ok, true);
    assert.equal(sizeLabel(exact.candidates[0]), '820x2040');
  });

  test('an enquiry from it is marked as the demo door, in the data and in the email', () => {
    const { state } = run;
    assert.equal(detailsIsDemoDoor(state), true);
    assert.equal(measuredPayload(state).demo, true, 'the measured event says so too');
    const plain = estimateEnquiry(run);
    assert.equal(plain.payload.demo, true);
    assert.equal(plain.payload.measurement.source, 'estimate');

    const config = deepMerge(baseConfig, { lead: { mailto: 'sales@doors.example' } });
    const { payload } = estimateEnquiry(run, config);
    const { subject, body } = mailFor(config, payload);
    assert.ok(subject.startsWith('[DEMO] '), `subject: ${subject}`);
    assert.ok(body.includes(LEAD_MAIL_STRINGS['lead.mail.measuredDemoEstimate']), 'the body says whose door it is');
  });
});

/* ------------------------------------------------------------------------------------------------------ */
/* Harder photos                                                                                          */
/* ------------------------------------------------------------------------------------------------------ */

describe('stronger pose: 15 degrees to the side, 8 degrees of tilt, crooked sheet, noisy photo', () => {
  let run;
  before(() => {
    run = runPipeline(STRONG_SCENE);
  });

  test('the photo really is a harder one, with the whole door still in frame', () => {
    const [tl, tr, br, bl] = run.truth.doorPx;
    const left = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const right = Math.hypot(br.x - tr.x, br.y - tr.y);
    assert.ok(Math.max(left, right) / Math.min(left, right) > 1.04, 'the near side of the door is clearly longer');
    for (const p of run.truth.doorPx) {
      assert.ok(p.x > 0.05 * run.photo.width && p.x < 0.95 * run.photo.width, `corner x ${p.x.toFixed(0)}`);
      assert.ok(p.y > 0.05 * run.photo.height && p.y < 0.95 * run.photo.height, `corner y ${p.y.toFixed(0)}`);
    }
    const [stl, str] = run.truth.sheetPx;
    const tiltDeg = (Math.atan2(str.y - stl.y, str.x - stl.x) * 180) / Math.PI;
    assert.ok(Math.abs(tiltDeg) > 3, `sheet top edge runs at ${tiltDeg.toFixed(1)} degrees`);
  });

  test('the sheet is found and refined, from the middle and from 40 px away', () => {
    assertSheetFound(run.sheet, run.truth.sheetPx, NOISY_SHEET_TOL_PX, 'centre tap');
    assert.equal(sheetAccepted(run.config, run.state, run.photo, run.sheet), true, 'and the screen accepts it');
    const centre = centroid(run.truth.sheetPx);
    for (const [dx, dy] of [[40, 0], [-28.3, 28.3], [0, -40]]) {
      const sheet = tapSheet(run.photo, { x: centre.x + dx, y: centre.y + dy });
      assertSheetFound(sheet, run.truth.sheetPx, NOISY_SHEET_TOL_PX, `tap at ${dx}, ${dy}`);
    }
  });

  test('the door measures 820 x 2040 mm within 6 / 9 mm', () => {
    assertMeasured(run, { widthTolMm: 6, heightTolMm: 9, orientation: 'portrait' });
  });

  test('the answer holds however the door corners are a couple of pixels out', (t) => {
    assertSweep(run, t, { widthTolMm: 6, heightTolMm: 9, minShare: 0.9 });
  });

  test('the flattened preview is square-on, and the size prices and submits', async () => {
    assertPreview(run);
    const { config, size } = run;
    const product = config.pricing.products[0];
    const quote = calculateQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id });
    assertQuoteAddsUp(quote, config, product.id);
    await assertLeadGoesThrough(run, quote, product);
  });
});

describe('sheet taped on sideways (landscape)', () => {
  let run;
  before(() => {
    run = runPipeline(LANDSCAPE_SCENE);
  });

  test('the sheet is found, wider than it is tall', () => {
    assertSheetFound(run.sheet, run.truth.sheetPx, CLEAN_SHEET_TOL_PX, 'centre tap');
    assert.equal(sheetAccepted(run.config, run.state, run.photo, run.sheet), true, 'and the screen accepts it');
    const [tl, tr, , bl] = run.sheet.quad;
    assert.ok(Math.hypot(tr.x - tl.x, tr.y - tl.y) > 1.2 * Math.hypot(bl.x - tl.x, bl.y - tl.y));
    const centre = centroid(run.truth.sheetPx);
    assertSheetFound(tapSheet(run.photo, { x: centre.x + 40, y: centre.y }), run.truth.sheetPx, CLEAN_SHEET_TOL_PX, 'tap 40 px right');
  });

  test('measureDoor works out which way round the sheet is and still gets 820 x 2040 mm', () => {
    assert.deepEqual(getSheetMm(run.state, run.config), { w: 210, h: 297 }, 'the config still describes the sheet as 210 x 297');
    assertMeasured(run, { widthTolMm: 4, heightTolMm: 6, orientation: 'landscape' });
  });

  test('the answer holds however the door corners are a couple of pixels out', (t) => {
    assertSweep(run, t, { widthTolMm: 4, heightTolMm: 6, minShare: 0.9 });
  });

  test('the flattened preview is right, and the size prices and submits', async () => {
    assertPreview(run);
    const { config, size } = run;
    const product = config.pricing.products[0];
    const quote = calculateQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id });
    assertQuoteAddsUp(quote, config, product.id);
    await assertLeadGoesThrough(run, quote, product);
  });
});

describe('white paper on a white door', () => {
  let run;
  before(() => {
    run = runPipeline(WHITE_DOOR_SCENE);
  });

  test('the photo really has little contrast between paper and door', () => {
    const { photo, truth } = run;
    const luma = getLuma(photo);
    const lumaAt = (p) => luma.data[Math.floor(p.y) * luma.width + Math.floor(p.x)];
    const H = truth.planeToImage;
    const paper = lumaAt(applyHomography(H, { x: 410, y: 700 }));
    const door = lumaAt(applyHomography(H, { x: 410, y: 300 }));
    assert.ok(paper > 235, `paper luma ${paper.toFixed(0)}`);
    assert.ok(Math.abs(paper - door) < 25, `paper ${paper.toFixed(0)} vs door ${door.toFixed(0)}`);
  });

  test('the sheet is still found on the paper itself, not on the edge of its shadow', () => {
    assertSheetFound(run.sheet, run.truth.sheetPx, PALE_SHEET_TOL_PX, 'centre tap');
    assert.equal(sheetAccepted(run.config, run.state, run.photo, run.sheet), true, 'and the screen accepts it');
    const centre = centroid(run.truth.sheetPx);
    for (const [dx, dy] of [[40, 0], [-40, 0], [0, 40], [0, -40], [28.3, -28.3]]) {
      const sheet = tapSheet(run.photo, { x: centre.x + dx, y: centre.y + dy });
      assertSheetFound(sheet, run.truth.sheetPx, PALE_SHEET_TOL_PX, `tap at ${dx}, ${dy}`);
    }
  });

  test('the door measures 820 x 2040 mm within 6 / 9 mm', () => {
    assertMeasured(run, { widthTolMm: 6, heightTolMm: 9, orientation: 'portrait' });
  });
});

describe('pale, pastel and grey sheets on a white door', () => {
  // Their shadow is the same sort of colour as the paper, only a little darker, and its far edge is the
  // strongest edge about. An outline that settles there makes the door about 5% small, so the sheet screen
  // must not announce it as found; an outline it is unsure of is measured as hand-placed, whose wider
  // plus-or-minus still covers the true size.
  const SHEETS = { cream: '#efe4c8', 'pastel pink': '#ffd1dc', lavender: '#d8cdea', 'pale grey': '#dcdcdc', 'light grey': '#c8c8c8' };
  for (const [name, color] of Object.entries(SHEETS)) {
    test(`${name}: not announced as found off the paper, and the size shown covers 820 x 2040 mm`, (t) => {
      const run = runPipeline({ ...WHITE_DOOR_SCENE, sheet: { ...DEMO_SCENE.sheet, color } });
      const { config, state, photo, sheet, truth, result } = run;
      assert.equal(sheet.ok, true, `sheet found (reason: ${sheet.reason})`);
      const outcome = sheetOutcome(config, state, photo, sheet);
      const error = maxCornerError(sheet.quad, truth.sheetPx);
      t.diagnostic(`${outcome} (${sheet.reason ?? 'refined'}), worst corner ${error.toFixed(2)} px; ${result.widthMm.toFixed(0)} x ${result.heightMm.toFixed(0)} mm, ${result.quality.level}`);
      if (outcome === 'found') assert.ok(error <= PALE_SHEET_TOL_PX, `announced as found ${error.toFixed(2)} px off the paper`);
      else assert.equal(outcome, 'check');
      assert.ok(result.ok, result.message);
      // "Accurate to about +/- N mm" is two standard deviations.
      assert.ok(Math.abs(result.widthMm - 820) <= 2 * result.sigmaWidthMm, `width ${result.widthMm.toFixed(1)} +/- ${(2 * result.sigmaWidthMm).toFixed(1)}`);
      assert.ok(Math.abs(result.heightMm - 2040) <= 2 * result.sigmaHeightMm, `height ${result.heightMm.toFixed(1)} +/- ${(2 * result.sigmaHeightMm).toFixed(1)}`);
    });
  }
});

/* ------------------------------------------------------------------------------------------------------ */
/* Skins                                                                                                  */
/* ------------------------------------------------------------------------------------------------------ */

describe('acme skin (?skin=acme): the same photo through a re-skinned config', () => {
  let acme;
  let demo;
  let run;
  before(() => {
    // What loadConfig('?skin=acme') builds, laid over the shipped settings rather than over js/config.js.
    acme = deepMerge(baseConfig, acmeSkin);
    demo = getDemoRun();
    // Same photo and the same marked corners as the default run, measured with the skinned config.
    const { photo, truth, sheet, doorPx } = demo;
    const state = initialState(acme);
    const marked = markedSheet(acme, state, photo, sheet);
    const result = marked ? measure(acme, state, photo, marked, doorPx) : null;
    run = { config: acme, photo, truth, state, sheet, marked, doorPx, result, size: result && result.ok ? toSize(acme, result) : null };
  });

  test('the skin is merged over the default config', () => {
    assert.equal(acme.brand.name, acmeSkin.brand.name);
    assert.notEqual(acme.brand.name, baseConfig.brand.name);
    assert.notDeepEqual(acme.pricing.products.map((p) => p.id), baseConfig.pricing.products.map((p) => p.id));
    assert.deepEqual(acme.measurement, baseConfig.measurement, 'measurement settings are inherited');
    assert.deepEqual(acme.lead.fields, baseConfig.lead.fields, 'lead form is inherited');
  });

  test('the door measures the same under the skin', () => {
    assertMeasured(run, { widthTolMm: 4, heightTolMm: 6, orientation: 'portrait' });
    assert.deepEqual(run.size, demo.size);
  });

  for (const [label, getConfig] of [['acme', () => acme], ['default', () => baseConfig]]) {
    test(`${label} config: every product prices with the default options`, () => {
      const config = getConfig();
      const { size } = run;
      assert.ok(config.pricing.products.length > 0);
      for (const product of config.pricing.products) {
        const quote = calculateQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id });
        assertQuoteAddsUp(quote, config, product.id);
        assert.equal(quote.sizeCategory, 'standard');
        assert.equal(quote.lineItems[0].label, product.name);
        assert.equal(quote.lineItems[0].amount, product.basePrice);
        assert.equal(quote.total, expectedStandardTotal(config, product, {}, config.pricing.installation.default), product.id);
      }
    });

    test(`${label} config: every product prices with every combination of options`, (t) => {
      const config = getConfig();
      const { size } = run;
      const combos = optionCombinations(config.pricing.options);
      let priced = 0;
      for (const product of config.pricing.products) {
        for (const selections of combos) {
          for (const includeInstallation of [true, false]) {
            const quote = calculateQuote(config, {
              widthMm: size.widthMm,
              heightMm: size.heightMm,
              productId: product.id,
              selections,
              includeInstallation,
            });
            const what = `${product.id} ${JSON.stringify(selections)} install ${includeInstallation}`;
            assertQuoteAddsUp(quote, config, what);
            assert.equal(quote.total, expectedStandardTotal(config, product, selections, includeInstallation), what);
            assert.deepEqual(quote.selections, selections, what);
            assert.equal(quote.includeInstallation, includeInstallation, what);
            priced++;
          }
        }
      }
      t.diagnostic(`${priced} quotes priced`);
      assert.equal(priced, config.pricing.products.length * combos.length * 2);
    });
  }

  test('the enquiry carries the skin brand and submits in demo mode', async () => {
    const { size } = run;
    const product = acme.pricing.products.at(-1);
    const selections = Object.fromEntries(
      acme.pricing.options.map((option) => [option.id, option.type === 'select' ? option.choices.at(-1).id : true]),
    );
    const quote = calculateQuote(acme, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id, selections, includeInstallation: false });
    assertQuoteAddsUp(quote, acme, product.id);
    const payload = await assertLeadGoesThrough(run, quote, product);
    assert.equal(payload.brand, 'Acme Security Doors');
    assert.deepEqual(payload.selections, selections);
    assert.equal(payload.includeInstallation, false);
  });
});

/* ------------------------------------------------------------------------------------------------------ */
/* js/config.js itself                                                                                    */
/* ------------------------------------------------------------------------------------------------------ */

// Everything above runs on the fixed copy of the shipped settings. This group is the only one that reads
// js/config.js, and it pins nothing in it: each check holds for any settings the app can run with, so it
// keeps passing after a door company has put in its own sheets, sizes, prices and form. A failure here
// is about js/config.js, not about the measuring code.
describe('js/config.js as it stands: your own settings through the same steps', () => {
  const pngBytes = readFileSync(new URL('../assets/demo-door.png', import.meta.url));
  const truthJson = JSON.parse(readFileSync(new URL('../assets/demo-door.truth.json', import.meta.url), 'utf8'));
  const config = liveConfig;

  /** An answer for every question on the company's own form, valid for its type. */
  function customerFor(fields) {
    const byType = { tel: CUSTOMER.phone, email: CUSTOMER.email, textarea: CUSTOMER.notes };
    return { ...Object.fromEntries(fields.map((field) => [field.id, byType[field.type] ?? 'Alex Taylor'])), consent: true };
  }

  test('the demo photo measures 820 x 2040 mm with its measurement settings', () => {
    const photo = asPhoto(decodePng(pngBytes), { isDemo: true });
    // js/demo.js (selectDemoReference): the paper demo photo is always measured with its own A4 sheet,
    // whatever is selected.
    const state = { referenceId: 'custom', customReference: { widthMm: 210, heightMm: 297 } };
    const sheet = tapSheet(photo, centroid(truthJson.sheetPx));
    const marked = markedSheet(config, state, photo, sheet);
    assert.ok(marked, 'the sheet in the demo photo is outlined (if not, look at measurement.plausible in js/config.js)');

    const result = measure(config, state, photo, marked, truthJson.doorPx);
    assert.equal(result.ok, true, `measured with the settings in js/config.js (${result.error}: ${result.message})`);
    // The corner settings weight the fit; with corners this well placed they barely move the size.
    assert.ok(Math.abs(result.widthMm - truthJson.widthMm) < 3, `width ${result.widthMm.toFixed(1)} mm with the sigma settings in js/config.js`);
    assert.ok(Math.abs(result.heightMm - truthJson.heightMm) < 3, `height ${result.heightMm.toFixed(1)} mm with the sigma settings in js/config.js`);

    const size = toSize(config, result);
    assert.ok(
      Number.isFinite(size.widthMm) && Number.isFinite(size.heightMm) && size.widthMm > 0 && size.heightMm > 0,
      `measurement.adjustments and roundToMm in js/config.js give a usable size (${size.widthMm} x ${size.heightMm})`,
    );
  });

  test('every door on its price list prices the demo door, or sends it for a custom quote', (t) => {
    const size = toSize(config, { widthMm: TRUE_WIDTH_MM, heightMm: TRUE_HEIGHT_MM });
    const products = config.pricing.products;
    assert.ok(Array.isArray(products) && products.length > 0, 'js/config.js lists at least one door under pricing.products');
    let priced = 0;
    for (const product of products) {
      for (const includeInstallation of [true, false]) {
        const quote = calculateQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id, includeInstallation });
        const what = `js/config.js, ${product.id}, installation ${includeInstallation}`;
        if (quote.status === 'out_of_range') {
          // A legitimate answer: this company does not price an 820 x 2040 mm door on the spot.
          assert.ok(quote.messages.length > 0, `${what}: the customer is told why there is no instant price`);
          continue;
        }
        assertQuoteAddsUp(quote, config, what);
        assert.equal(quote.productId, product.id, what);
        priced++;
      }
    }
    t.diagnostic(`${size.widthMm} x ${size.heightMm} mm: ${priced} of ${products.length * 2} quotes priced, the rest sent for a custom quote`);
  });

  test('an enquiry for the demo door builds from its own form', () => {
    const size = toSize(config, { widthMm: TRUE_WIDTH_MM, heightMm: TRUE_HEIGHT_MM });
    const product = config.pricing.products[0];
    const quote = calculateQuote(config, { widthMm: size.widthMm, heightMm: size.heightMm, productId: product.id });
    const customer = customerFor(config.lead.fields);
    assert.deepEqual(validateCustomer(config, customer), { ok: true, errors: {} }, 'an answer to every question in lead.fields is accepted');

    const payload = buildLeadPayload({
      config,
      customer,
      measurement: { ...size, quality: 'good', sigmaWidthMm: 4.5, sigmaHeightMm: 7.9 },
      quote,
      selections: quote.selections,
      includeInstallation: quote.includeInstallation,
      product,
      demo: true,
    });
    assert.equal(payload.brand, config.brand.name);
    assert.equal(payload.demo, true);
    for (const field of config.lead.fields) assert.equal(payload.customer[field.id], customer[field.id], `the enquiry carries the answer to "${field.id}"`);
    assert.equal(payload.customer.consent, true);
    assert.equal(payload.measurement.widthMm, size.widthMm);
    assert.equal(payload.measurement.heightMm, size.heightMm);
    assert.deepEqual(payload.product, { id: String(product.id), name: String(product.name) });
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, 'the enquiry survives JSON unchanged');
    // Not submitted: with lead.endpoint filled in, that would post a made-up enquiry to the company's own system.
    assert.ok(['webhook', 'mailto', 'demo'].includes(leadMode(config)));
  });
});
