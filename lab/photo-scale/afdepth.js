// Door size from the iPhone's time-of-flight autofocus distance (Apple MakerNote 0x0038 AFMeasuredDepth)
// plus the four corners of the opening. Pure: no DOM, no globals, safe under Node; never throws.
//
// THE IDEA
//   The corners alone give the opening's shape and the camera's pose up to scale (rectifyRectangle: t is the
//   top-left corner's position for an opening of height 1, r3 the plane normal into the house). One real
//   distance along one known ray fixes the scale:
//     ray through the AF point p:     d = [(p.x - cx) / f, (p.y - cy) / f, 1]
//     the point the depth refers to:  X = D d            ("axial": D is the z depth)
//                                     X = D d / |d|      ("range": D is the distance along the ray)
//     frame plane in mm:              dot(r3, X) = H dot(r3, t)
//     leaf set back s mm:             dot(r3, X) = H dot(r3, t) + s
//   so H = (dot(r3, X) - s) / dot(r3, t) and W = H / aspect. Which reading Apple's number is, and whether its
//   unit really is cm, is what the lab is for: both models are shown, and with a tape truth the raw value
//   that would have been exact is shown too.
//
// ERROR MODEL (research scale-cues/scripts/af_sim.py; the ToF error is ASSUMED, not measured): with exact
// depth, 3 px corner taps give H about 5 / 12 mm p50 / p90; every 1 % of depth error adds about 1 % of H
// (2 % lognormal: H p90 about 68 mm). So the go/no-go rests on the real depth error, measured with a tape.
//
// FOCAL: K comes from photoFocal (js/estimate.js). A picked file's EXIF focal is only a best guess there (a
// gallery crop keeps the 4:3 shape and the EXIF), and Zu, so H, scales with the focal: H is about D / f, so a
// wrong focal is a proportional error in H on top of the depth's. FocalLengthIn35mmFilm is a whole number
// (24 or 26 mm: up to about +-2 % from the rounding alone; see focalRoundingPct), and estimate.js notes that
// the diagonal-versus-width reading of it can be another 4 %. That is a constant scale error per phone model,
// 40-80 mm of H, the whole budget; it cannot be told apart from an error in the depth's unit with a tape
// height alone, since both scale H the same way. So the session (stats.js) reports the error both raw and
// after one leave-one-door-out scale constant per phone model.

import { rectifyRectangle, classifyStandard, sigmaLnScaleFromP90 } from '../../js/estimate.js';
import { orderDoorQuad } from '../../js/geometry.js';

/** Raw AFMeasuredDepth to mm, per the brief (the value is in cm). The lab checks this against the tape. */
export const AF_RAW_TO_MM = 10;
/** Raw values in this range are the sensor's "out of range" answer, not a distance. */
export const AF_OUT_OF_RANGE = Object.freeze([1059, 1079]);
/** Leaf set-backs (mm behind the frame face) always shown, besides the typed one. */
export const SETBACKS_MM = Object.freeze([0, 20, 40]);
/** Catalogue snap with an AF-depth size: its scale is taken as good to 3 % p90. */
export const AF_SNAP_P90_PERCENT = 3;
export const MODELS = Object.freeze(['axial', 'range']);

const RAD = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Whether a raw AFMeasuredDepth can be used, and its distance in mm.
 * @param {number|null|undefined} raw
 * @param {number|null|undefined} confidence  AFConfidence (0x003D); null when the tag is missing
 * @returns {{ valid: boolean, reasons: string[], raw: number|null, confidence: number|null, depthMm: number|null }}
 *   reasons: 'no_tag' | 'not_a_number' | 'not_positive' | 'out_of_range' | 'confidence_zero'
 */
export function afDepthReading(raw, confidence) {
  const reasons = [];
  const conf = isNum(confidence) ? confidence : null;
  if (raw === null || raw === undefined) reasons.push('no_tag');
  else if (!isNum(raw)) reasons.push('not_a_number');
  else {
    if (raw <= 0) reasons.push('not_positive');
    if (raw >= AF_OUT_OF_RANGE[0] && raw <= AF_OUT_OF_RANGE[1]) reasons.push('out_of_range');
  }
  if (conf === 0) reasons.push('confidence_zero');
  const valid = reasons.length === 0;
  return { valid, reasons, raw: isNum(raw) ? raw : null, confidence: conf, depthMm: valid ? raw * AF_RAW_TO_MM : null };
}

/**
 * A point in stored (unrotated) pixels, turned by the EXIF orientation into the displayed picture.
 * @param {number} x
 * @param {number} y
 * @param {number} w  stored width
 * @param {number} h  stored height
 * @param {number} orientation  1..8
 * @returns {{ x: number, y: number, w: number, h: number }}  the point and the displayed size
 */
export function orientPoint(x, y, w, h, orientation) {
  switch (orientation) {
    case 2: return { x: w - x, y, w, h };
    case 3: return { x: w - x, y: h - y, w, h };
    case 4: return { x, y: h - y, w, h };
    case 5: return { x: y, y: x, w: h, h: w };
    case 6: return { x: h - y, y: x, w: h, h: w };
    case 7: return { x: h - y, y: w - x, w: h, h: w };
    case 8: return { x: y, y: w - x, w: h, h: w };
    default: return { x, y, w, h };
  }
}

const sameShape = (aw, ah, bw, bh) => Math.abs((aw / ah) / (bw / bh) - 1) <= 0.02;

/**
 * Where the autofocus measured, in working-image px: the centre of EXIF SubjectArea (stored px), turned by the
 * EXIF orientation and scaled from PixelX/YDimension to the working image; the image centre when that cannot
 * be done. When the EXIF size and the decoded picture only match the other way round (a picker that turned the
 * pixels but kept the old size, or a writer that records the turned size), the other reading is used and the
 * source says it was a guess.
 *
 * @param {{ subjectArea?: number[]|null, pixelX?: number|null, pixelY?: number|null, orientation?: number|null }|null} exif
 * @param {number} workW
 * @param {number} workH
 * @returns {{ point: { x: number, y: number }, source: 'subject_area'|'subject_area_guess'|'centre', note: string }}
 */
export function afPointFromExif(exif, workW, workH) {
  const centre = { point: { x: workW / 2, y: workH / 2 }, source: 'centre', note: '' };
  if (!exif || !Array.isArray(exif.subjectArea) || exif.subjectArea.length < 2) return { ...centre, note: 'no SubjectArea: image centre used' };
  const [sx, sy] = exif.subjectArea;
  const pw = exif.pixelX;
  const ph = exif.pixelY;
  if (!(isNum(sx) && isNum(sy) && pw > 0 && ph > 0 && workW > 0 && workH > 0)) {
    return { ...centre, note: 'no PixelX/YDimension to scale SubjectArea: image centre used' };
  }
  const o = exif.orientation >= 1 && exif.orientation <= 8 ? exif.orientation : 1;
  const tries = [{ o, source: 'subject_area' }];
  // The likeliest other readings: no turn at all, or the iPhone's portrait turn (6).
  if (o >= 5) tries.push({ o: 1, source: 'subject_area_guess' });
  else tries.push({ o: 6, source: 'subject_area_guess' });
  for (const t of tries) {
    const d = orientPoint(sx, sy, pw, ph, t.o);
    if (!sameShape(d.w, d.h, workW, workH)) continue;
    const point = { x: (d.x * workW) / d.w, y: (d.y * workH) / d.h };
    const note = t.source === 'subject_area'
      ? `SubjectArea (${sx}, ${sy}) of ${pw} x ${ph}, orientation ${o}`
      : `EXIF size ${pw} x ${ph} with orientation ${o} does not match the decoded ${workW} x ${workH}; read as orientation ${t.o}`;
    return { point, source: t.source, note };
  }
  return { ...centre, note: `EXIF size ${pw} x ${ph} has another shape from the decoded ${workW} x ${workH} (cropped?): image centre used` };
}

/**
 * Whether p lies inside the convex quad (either winding).
 * @param {{ x: number, y: number }} p
 * @param {Array<{ x: number, y: number }>} quad
 */
export function pointInQuad(p, quad) {
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c > 0) pos++;
    else if (c < 0) neg++;
  }
  return pos === 0 || neg === 0;
}

/**
 * The geometry that does not depend on the depth: the rectification and the AF ray against the plane.
 * @param {Array<{x:number,y:number}>} corners  any order (put in [TL, TR, BR, BL] by orderDoorQuad)
 * @param {{ f: number, cx: number, cy: number }} K
 * @param {{ x: number, y: number }} point  the AF point, working px
 */
export function afGeometry(corners, K, point) {
  const quad = orderDoorQuad(corners);
  const rect = rectifyRectangle(quad, K);
  const d = [(point.x - K.cx) / K.f, (point.y - K.cy) / K.f, 1];
  const dNorm = norm(d);
  const nD = dot(rect.r3, d);
  const nT = dot(rect.r3, rect.t);
  return {
    quad,
    rect,
    d,
    dNorm,
    nD,
    nT,
    Zu: Math.abs(nT),
    inside: pointInQuad(point, quad),
    offAxisDeg: Math.acos(1 / dNorm) / RAD,
    // Angle between the AF ray and the plane normal: a grazing ray turns a small depth error into a big one.
    incidenceDeg: Math.acos(Math.min(1, Math.abs(nD) / dNorm)) / RAD,
  };
}

/**
 * dot(r3, X) in mm for a depth under one model.
 * @param {{ nD: number, dNorm: number }} geom
 * @param {number} depthMm
 * @param {'axial'|'range'} model
 */
export function planeDotMm(geom, depthMm, model) {
  return model === 'range' ? (depthMm * geom.nD) / geom.dNorm : depthMm * geom.nD;
}

/**
 * Opening height (mm) from dot(r3, X), for a leaf set back s mm behind the frame face.
 * @param {number} nX   dot(r3, X), mm
 * @param {number} nT   dot(r3, t), door heights
 * @param {number} setbackMm
 */
export function heightFromPlaneDot(nX, nT, setbackMm) {
  return (nX - setbackMm) / nT;
}

/**
 * The raw AFMeasuredDepth that would have given the true height exactly (to check the unit and the model).
 * @param {object} geom  afGeometry
 * @param {'axial'|'range'} model
 * @param {number} trueHeightMm
 * @param {number} setbackMm
 */
export function rawForHeight(geom, model, trueHeightMm, setbackMm) {
  const nX = trueHeightMm * geom.nT + setbackMm;
  const depth = model === 'range' ? (nX * geom.dNorm) / geom.nD : nX / geom.nD;
  return depth / AF_RAW_TO_MM;
}

/**
 * The mm per raw unit the tape implies: the true depth is rawNeeded x AF_RAW_TO_MM (rawForHeight assumes
 * that unit), and it must equal rawGiven x unit, so unit = rawNeeded x AF_RAW_TO_MM / rawGiven. (Given /
 * needed is the inverse ratio: 0.5 means the photo's number is half what the tape needs, a 20 mm unit.)
 * This takes the focal as exact: a focal off by x % moves it by about x % too (see the FOCAL note above).
 * @param {number} rawGiven   the photo's AFMeasuredDepth
 * @param {number} rawNeeded  rawForHeight for the tape height
 * @returns {number} NaN when either is not a positive number
 */
export function impliedRawUnitMm(rawGiven, rawNeeded) {
  return isNum(rawGiven) && isNum(rawNeeded) && rawGiven > 0 && rawNeeded > 0 ? (rawNeeded * AF_RAW_TO_MM) / rawGiven : NaN;
}

/**
 * The largest scale error (%) the rounding of a whole-number FocalLengthIn35mmFilm alone can make: half a mm
 * of the given focal. 24 mm: 2.1 %; 26 mm: 1.9 %.
 * @param {number|null|undefined} f35
 * @returns {number} NaN when no focal is given
 */
export function focalRoundingPct(f35) {
  return isNum(f35) && f35 > 0 ? 50 / f35 : NaN;
}

// ---------------------------------------------------------------------------------------------------------
// Gravity from the MakerNote's AccelerationVector, against the door's own vertical
// ---------------------------------------------------------------------------------------------------------

const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const AXES = ['X', 'Y', 'Z'];

function mapAccel(a, perm, signs) {
  return [signs[0] * a[perm[0]], signs[1] * a[perm[1]], signs[2] * a[perm[2]]];
}

function mappingLabel(perm, signs) {
  return `(${perm.map((p, i) => `${signs[i] > 0 ? '+' : '-'}${AXES[p]}`).join(', ')})`;
}

/** Pitch (optical axis below the horizon, + = looking down) and roll of a camera-frame "down" vector, deg. */
function pitchRoll(v) {
  const n = norm(v);
  const u = [v[0] / n, v[1] / n, v[2] / n];
  return { pitchDeg: Math.asin(Math.max(-1, Math.min(1, u[2]))) / RAD, rollDeg: Math.atan2(u[0], u[1]) / RAD };
}

function angleDeg(a, b) {
  const c = dot(a, b) / (norm(a) * norm(b));
  return Math.acos(Math.max(-1, Math.min(1, c))) / RAD;
}

/**
 * A plausibility check of the corners against the phone's own gravity reading. A plumb door's "down" (r2) and
 * gravity agree in any photo; how Apple's axes map onto the camera's is not documented well, so the mapping
 * ExifTool describes (X to the left seen from the screen, Y to the bottom, Z into the screen: camera
 * (-X, +Y, +Z), portrait) is shown with its sign either way, and the best of all 48 signed axis orders too
 * (over several photos a consistent best mapping is the real one).
 *
 * @param {number[]|null} accel  3 numbers, g
 * @param {number[]} r2  the door's down axis in the camera frame
 */
export function gravityCheck(accel, r2) {
  if (!Array.isArray(accel) || accel.length < 3 || !accel.slice(0, 3).every(isNum) || !(norm(accel) > 0)) return null;
  const a = accel.slice(0, 3);
  const door = pitchRoll(r2);
  const make = (perm, signs) => {
    const g = mapAccel(a, perm, signs);
    return { mapping: mappingLabel(perm, signs), gCam: g, angleToDoorDeg: angleDeg(g, r2), ...pitchRoll(g) };
  };
  const documented = make([0, 1, 2], [-1, 1, 1]);
  const documentedFlipped = make([0, 1, 2], [1, -1, -1]);
  let best = null;
  for (const perm of PERMS) {
    for (let s = 0; s < 8; s++) {
      const signs = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
      const c = make(perm, signs);
      if (!best || c.angleToDoorDeg < best.angleToDoorDeg) best = c;
    }
  }
  return { magnitudeG: norm(a), door, documented, documentedFlipped, best };
}

// ---------------------------------------------------------------------------------------------------------
// Everything for one photo
// ---------------------------------------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {Array<{x:number,y:number}>} input.corners
 * @param {{ f: number, cx: number, cy: number }} input.K
 * @param {{ x: number, y: number }} input.point       AF point, working px
 * @param {number|null} input.afDepthRaw
 * @param {number|null} [input.afConfidence]
 * @param {number[]|null} [input.accel]
 * @param {number} [input.setbackMm=20]               the typed leaf set-back
 * @param {number} [input.sigmaLnAspect]              for the catalogue snap (estimateFromCorners)
 * @param {Array<{widthMm:number,heightMm:number}>} [input.sizes]
 * @param {number|null} [input.depthMm]               a distance in mm to use instead of the raw value (tests)
 */
export function analyseAfDepth(input) {
  try {
    return analyse(input);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'failed' };
  }
}

function analyse({ corners, K, point, afDepthRaw = null, afConfidence = null, accel = null, setbackMm = 20, sigmaLnAspect, sizes, depthMm = null }) {
  if (!Array.isArray(corners) || corners.length !== 4 || !K || !(K.f > 0) || !point) return { ok: false, error: 'bad_input' };
  const reading = isNum(depthMm) && depthMm > 0
    ? { valid: true, reasons: [], raw: depthMm / AF_RAW_TO_MM, confidence: null, depthMm }
    : afDepthReading(afDepthRaw, afConfidence);
  const geom = afGeometry(corners, K, point);
  const { rect } = geom;
  if (!(geom.nT > 0) || !isNum(geom.nD)) return { ok: false, error: 'degenerate', reading };
  const typed = isNum(setbackMm) ? setbackMm : 0;
  const setbacks = [...SETBACKS_MM];
  if (!setbacks.includes(typed)) setbacks.push(typed);
  const models = {};
  for (const model of MODELS) {
    const nX = reading.valid ? planeDotMm(geom, reading.depthMm, model) : null;
    models[model] = {
      nXmm: nX,
      variants: setbacks.map((s) => {
        if (nX === null) return { setbackMm: s, H: null, W: null, Zmm: null };
        const H = heightFromPlaneDot(nX, geom.nT, s);
        return { setbackMm: s, H, W: H / rect.aspectHW, Zmm: H * geom.Zu };
      }),
    };
  }
  const pick = (model) => models[model].variants.find((v) => v.setbackMm === typed);
  const usable = reading.valid && geom.inside;
  const snap = {};
  for (const model of MODELS) {
    const v = pick(model);
    snap[model] = usable && v.H > 0 && sigmaLnAspect > 0
      ? classifyStandard({
          aspectHW: rect.aspectHW,
          sigmaLnAspect,
          estimateMm: { w: v.W, h: v.H },
          sigmaLnScale: sigmaLnScaleFromP90(AF_SNAP_P90_PERCENT),
          sizes,
        }).slice(0, 3).map(({ widthMm, heightMm, p, zAspect, zScale }) => ({ widthMm, heightMm, p, zAspect, zScale }))
      : [];
  }
  return {
    ok: true,
    reading,
    usable,
    point: { x: point.x, y: point.y },
    inside: geom.inside,
    offAxisDeg: geom.offAxisDeg,
    incidenceDeg: geom.incidenceDeg,
    aspectHW: rect.aspectHW,
    nT: geom.nT,
    nD: geom.nD,
    dNorm: geom.dNorm,
    Zu: geom.Zu,
    setbackMm: typed,
    models,
    headline: { range: pick('range'), axial: pick('axial') },
    snap,
    gravity: gravityCheck(accel, rect.r2),
    geom: { nT: geom.nT, nD: geom.nD, dNorm: geom.dNorm },
  };
}
