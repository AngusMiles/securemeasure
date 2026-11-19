// Errors and the session summary for the photo-scale lab. Pure: no DOM, no globals, safe under Node.
//
// A row is one photo as photo-scale.js stores it (no pixels). Truth is kept per door id, so several photos
// of one door (one per route) share one tape measurement.
//
// What counts toward the error statistics (questions 2 and 3) and the go/no-go:
//   - only rows whose corners the tester confirmed (cornersConfirmed): a door-finder guess nobody checked, or
//     the fallback middle box, gives a wrong size that no gate catches;
//   - one value per door (and phone): several photos of one door, such as one Camera-app photo given through
//     both Library and Files, are one measurement, so they count once (the median of their errors);
//   - the brick methods only on doors whose wall is marked brick.

import { heightFromCourse, HEIGHT_GATE_MM } from './brick.js';
import { heightFromPlaneDot, AF_RAW_TO_MM } from './afdepth.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Percentile with linear interpolation between order statistics (numpy's default), ignoring non-numbers.
 * @param {number[]} values
 * @param {number} q  0..100
 * @returns {number} NaN for no values
 */
export function percentile(values, q) {
  const a = (values || []).filter(isNum).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const pos = (Math.min(100, Math.max(0, q)) / 100) * (a.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(a.length - 1, lo + 1);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export const median = (values) => percentile(values, 50);

/**
 * @param {number[]} signed  signed errors
 * @returns {{ n: number, p50: number, p90: number, biasMedian: number, biasMean: number }}  of |error|
 */
export function errorStats(signed) {
  const s = (signed || []).filter(isNum);
  const abs = s.map(Math.abs);
  return {
    n: s.length,
    p50: percentile(abs, 50),
    p90: percentile(abs, 90),
    biasMedian: median(s),
    biasMean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Routes and which rows count
// ---------------------------------------------------------------------------------------------------------

/** Route ids, in the order the page offers them ('inpage_frame' is set by the page, never chosen). */
export const ROUTES = Object.freeze([
  { id: 'library', label: 'Photo Library (accept image/*)' },
  { id: 'library_heic', label: 'Photo Library (accept lists HEIC)' },
  { id: 'library_any', label: 'Photo Library (no accept filter)' },
  { id: 'files', label: 'Files' },
  { id: 'inpage', label: 'In-page camera (takePhoto still)' },
  { id: 'inpage_frame', label: 'In-page video frame (takePhoto gave no still)' },
  { id: 'takephoto', label: "Picker 'Take Photo' (control)" },
]);

/** Routes a customer would really take: picking from the library, or this page's own camera. */
export const CUSTOMER_ROUTES = Object.freeze(['library', 'library_heic', 'library_any', 'inpage']);
/** Routes that work but ask more than a customer will usually do (Save to Files in Photos first). */
export const EFFORT_ROUTES = Object.freeze(['files']);
/** Every route a customer could use at all (the control and a bare video frame are not). */
export const PRACTICAL_ROUTES = Object.freeze([...CUSTOMER_ROUTES, ...EFFORT_ROUTES]);

/** The go/no-go thresholds. */
export const GO_RULES = Object.freeze({
  afDoors: 10,
  afHp90: 50,
  brickDoors: 15,
  brickHp90: 60,
  brickWp90: 25,
  /** Brick doors (wall marked brick, corners confirmed) where every photo was gated out, at most. */
  brickMaxGatedPct: 25,
  nonBrickDoors: 3,
});

/**
 * The route a row counts under. Rows saved before the page took its own stills kept route 'inpage' for a
 * video frame; a frame never has a MakerNote and says nothing about takePhoto, so it counts on its own.
 * @param {object} row
 */
export function rowRoute(row) {
  if (!row) return null;
  if (row.route === 'inpage' && row.capture === 'frame' && !row.metaFrom) return 'inpage_frame';
  return row.route;
}

/**
 * Whether the tester confirmed this row's corners: moved by hand (unless the tick was taken off again), or
 * the door finder's corners with the "dots are on the corners" tick. The middle box never counts, nor does
 * a door-finder guess nobody looked at.
 * @param {object} row
 */
export function cornersConfirmed(row) {
  if (!row || !Array.isArray(row.corners)) return false;
  const src = row.cornersSource;
  if (src !== 'moved' && src !== 'detected') return false;
  if (row.cornersChecked === true) return true;
  if (row.cornersChecked === false) return false;
  // Rows saved before the tick existed: moved by hand counts.
  return src === 'moved';
}

/** The phone model a row came from (its EXIF Model), for the per-phone scale constant. */
export function phoneOf(row) {
  return (row && row.exif && typeof row.exif.model === 'string' && row.exif.model.trim()) || 'unknown phone';
}

// ---------------------------------------------------------------------------------------------------------
// Methods: how each one turns a stored row (and the door's truth) into a W x H, or says it is gated out
// ---------------------------------------------------------------------------------------------------------

export const METHODS = Object.freeze([
  { id: 'af_range', label: 'AF depth: range, typed s', kind: 'af', model: 'range' },
  { id: 'af_axial', label: 'AF depth: axial, typed s', kind: 'af', model: 'axial' },
  { id: 'af_range_true_s', label: 'AF depth: range, measured s', kind: 'af', model: 'range' },
  { id: 'af_axial_true_s', label: 'AF depth: axial, measured s', kind: 'af', model: 'axial' },
  { id: 'brick', label: 'Bricks: regional course, chosen reveal', kind: 'brick' },
  { id: 'brick_raw', label: 'Bricks: regional course, no reveal', kind: 'brick' },
  { id: 'brick_true_reveal', label: 'Bricks: regional course, measured reveal', kind: 'brick' },
  { id: 'brick_true_course', label: 'Bricks: measured course and reveal', kind: 'brick' },
  { id: 'cat_aspect', label: 'Catalogue: shape only', kind: 'catalogue' },
  { id: 'cat_af', label: 'Catalogue: shape + AF depth', kind: 'catalogue' },
  { id: 'cat_brick', label: 'Catalogue: shape + bricks', kind: 'catalogue' },
]);

/** Whether a method is judged on brick walls only. */
const brickOnly = (m) => m.kind === 'brick' || m.id === 'cat_brick';

/**
 * A row's estimate under one method.
 *
 * Row fields used: aspectHW; af { valid, inside, nT, nX: { axial, range }, setbackMm, reasons };
 * brick { checks[], periodUnits, Zu, courseMm, revealMm }; catalogue { aspect, af, brick } (each { w, h } or null).
 * Truth fields used: setbackMm, revealMm, courses10Mm.
 *
 * @param {object} row
 * @param {object|null} truth
 * @param {string} id  a METHODS id
 * @returns {{ W: number, H: number } | { gated: true, reason: string } | null}  null = cannot apply (no data
 *   for it, e.g. no measured set-back typed)
 */
export function methodEstimate(row, truth, id) {
  if (!row) return null;
  const aspect = row.aspectHW;
  const af = row.af;
  const br = row.brick;
  const t = truth || {};
  const afSize = (model, s) => {
    if (!af) return { gated: true, reason: 'no_photo_geometry' };
    if (!af.valid) return { gated: true, reason: (af.reasons && af.reasons[0]) || 'no_depth' };
    if (!af.inside) return { gated: true, reason: 'af_point_outside_opening' };
    const nX = af.nX && af.nX[model];
    if (!isNum(nX) || !isNum(af.nT) || !isNum(aspect)) return { gated: true, reason: 'no_depth' };
    const H = heightFromPlaneDot(nX, af.nT, s);
    return { W: H / aspect, H };
  };
  const brickSize = (courseMm, revealMm) => {
    if (!br) return { gated: true, reason: 'not_run' };
    if (br.checks && br.checks.length) return { gated: true, reason: br.checks[0] };
    if (!isNum(br.periodUnits) || !isNum(br.Zu) || !isNum(aspect)) return { gated: true, reason: 'no_brick' };
    const H = heightFromCourse(courseMm, br.periodUnits, revealMm, br.Zu);
    if (!(H >= HEIGHT_GATE_MM[0] && H <= HEIGHT_GATE_MM[1])) return { gated: true, reason: 'height_out_of_range' };
    return { W: H / aspect, H };
  };
  const pick = (size, parent) => {
    if (parent && parent.gated) return parent;
    return size && isNum(size.w) && isNum(size.h) ? { W: size.w, H: size.h } : { gated: true, reason: 'no_pick' };
  };
  switch (id) {
    case 'af_range':
      return afSize('range', af ? af.setbackMm : 0);
    case 'af_axial':
      return afSize('axial', af ? af.setbackMm : 0);
    case 'af_range_true_s':
      return isNum(t.setbackMm) ? afSize('range', t.setbackMm) : null;
    case 'af_axial_true_s':
      return isNum(t.setbackMm) ? afSize('axial', t.setbackMm) : null;
    case 'brick':
      return br ? brickSize(br.courseMm, br.revealMm) : { gated: true, reason: 'not_run' };
    case 'brick_raw':
      return br ? brickSize(br.courseMm, 0) : { gated: true, reason: 'not_run' };
    case 'brick_true_reveal':
      return isNum(t.revealMm) ? (br ? brickSize(br.courseMm, t.revealMm) : { gated: true, reason: 'not_run' }) : null;
    case 'brick_true_course':
      return isNum(t.courses10Mm) && isNum(t.revealMm) ? (br ? brickSize(t.courses10Mm / 10, t.revealMm) : { gated: true, reason: 'not_run' }) : null;
    case 'cat_aspect':
      return row.catalogue ? pick(row.catalogue.aspect, null) : null;
    case 'cat_af':
      return row.catalogue ? pick(row.catalogue.af, afSize('range', af ? af.setbackMm : 0)) : null;
    case 'cat_brick':
      return row.catalogue ? pick(row.catalogue.brick, br ? brickSize(br.courseMm, br.revealMm) : { gated: true, reason: 'not_run' }) : null;
    default:
      return null;
  }
}

/** Whether a truth record has a tape width and height. */
export function hasTape(truth) {
  return Boolean(truth) && isNum(truth.wMm) && isNum(truth.hMm) && truth.wMm > 0 && truth.hMm > 0;
}

/**
 * Signed errors of every method for one row.
 * @returns {Array<{ id: string, label: string, kind: string, estimate: object|null, eW: number|null, eH: number|null,
 *   eWPct: number|null, eHPct: number|null }>}
 */
export function rowErrors(row, truth) {
  return METHODS.map((m) => {
    const estimate = methodEstimate(row, truth, m.id);
    const out = { id: m.id, label: m.label, kind: m.kind, estimate, eW: null, eH: null, eWPct: null, eHPct: null };
    if (estimate && !estimate.gated && hasTape(truth)) {
      out.eW = estimate.W - truth.wMm;
      out.eH = estimate.H - truth.hMm;
      out.eWPct = (100 * out.eW) / truth.wMm;
      out.eHPct = (100 * out.eH) / truth.hMm;
    }
    return out;
  });
}

/**
 * The mm per raw AFMeasuredDepth unit that the tape height implies for one row and one depth model:
 * AF_RAW_TO_MM x (H_tape x nT + s) / nX, nX being dot(r3, X) from the raw value read as AF_RAW_TO_MM mm.
 * The same figure as impliedRawUnitMm(raw, rawForHeight(...)) in afdepth.js, from the stored row alone.
 * It takes the focal as exact: a focal error moves it in proportion (see afdepth.js, FOCAL).
 * @param {object} row
 * @param {object} truth
 * @param {'range'|'axial'} model
 * @returns {number|null}  null when the row has no usable depth or the door no tape height
 */
export function afImpliedUnit(row, truth, model) {
  const af = row && row.af;
  if (!af || !af.valid || !af.inside || !hasTape(truth)) return null;
  const nX = af.nX && af.nX[model];
  if (!isNum(nX) || !(nX > 0) || !isNum(af.nT)) return null;
  const s = isNum(truth.setbackMm) ? truth.setbackMm : isNum(af.setbackMm) ? af.setbackMm : 0;
  return (AF_RAW_TO_MM * (truth.hMm * af.nT + s)) / nX;
}

const pct = (n, d) => (d > 0 ? (100 * n) / d : NaN);

/** The commonest value of a list (the first on a tie). */
function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

/**
 * Leave-one-door-out per-phone calibration: each door's H is divided by the median H_est / H_tape of the
 * OTHER doors photographed with the same phone model, which removes a constant per-model scale error (a
 * rounded or misread focal, or a depth unit) without letting a door calibrate itself. Doors whose phone has
 * no other door are left out.
 * @param {Array<{ door: string, phone: string, truth: object, eW: number, eH: number, ratio: number }>} units
 */
function leaveOneDoorOut(units) {
  const eW = [];
  const eH = [];
  const doors = new Set();
  for (const u of units) {
    const others = units.filter((o) => o.phone === u.phone && o.door !== u.door).map((o) => o.ratio);
    if (!others.length) continue;
    const k = median(others);
    if (!(k > 0)) continue;
    eH.push((u.truth.hMm + u.eH) / k - u.truth.hMm);
    eW.push((u.truth.wMm + u.eW) / k - u.truth.wMm);
    doors.add(u.door);
  }
  return { doors: doors.size, W: errorStats(eW), H: errorStats(eH) };
}

/**
 * One method over the counted rows: per-row gating, then one value per door and phone (the median of that
 * door's errors with that phone), and the p50 / p90 over those values.
 */
function methodSummary(m, rows, truthOf) {
  const perUnit = new Map();
  let applicable = 0;
  let gated = 0;
  for (const row of rows) {
    const truth = truthOf(row);
    if (brickOnly(m) && truth.wall !== 'brick') continue;
    const est = methodEstimate(row, truth, m.id);
    if (!est) continue;
    applicable++;
    const phone = phoneOf(row);
    const key = `${row.doorId}\u0000${m.kind === 'af' ? phone : ''}`;
    let u = perUnit.get(key);
    if (!u) {
      u = { door: row.doorId, phone, truth, eW: [], eH: [], ratio: [] };
      perUnit.set(key, u);
    }
    if (est.gated) {
      gated++;
      continue;
    }
    u.eW.push(est.W - truth.wMm);
    u.eH.push(est.H - truth.hMm);
    u.ratio.push(est.H / truth.hMm);
  }
  const all = [...perUnit.values()];
  const units = all.filter((u) => u.eH.length).map((u) => ({ door: u.door, phone: u.phone, truth: u.truth, eW: median(u.eW), eH: median(u.eH), ratio: median(u.ratio) }));
  const doorIds = new Set(all.map((u) => u.door));
  const measured = new Set(units.map((u) => u.door));
  const out = {
    id: m.id,
    label: m.label,
    kind: m.kind,
    applicable,
    gated,
    gatedPct: pct(gated, applicable),
    units: units.length,
    doors: measured.size,
    doorsApplicable: doorIds.size,
    doorsGated: doorIds.size - measured.size,
    doorsGatedPct: pct(doorIds.size - measured.size, doorIds.size),
    W: errorStats(units.map((u) => u.eW)),
    H: errorStats(units.map((u) => u.eH)),
  };
  if (m.kind === 'af') out.calibrated = leaveOneDoorOut(units);
  return out;
}

/**
 * Per phone model: the median H_est / H_tape and the mm per raw unit the tape implies, for both depth
 * models (typed set-back for the ratio, measured set-back when given for the unit), one value per door.
 * A tape height alone cannot tell the focal from the depth's unit: both scale H the same way.
 */
function afByPhone(rows, truthOf) {
  const phones = new Map();
  for (const row of rows) {
    const truth = truthOf(row);
    const phone = phoneOf(row);
    let p = phones.get(phone);
    if (!p) {
      p = { phone, f35: [], doors: new Map() };
      phones.set(phone, p);
    }
    for (const model of ['range', 'axial']) {
      const est = methodEstimate(row, truth, model === 'range' ? 'af_range' : 'af_axial');
      const unit = afImpliedUnit(row, truth, model);
      if (!est || est.gated || unit === null) continue;
      let d = p.doors.get(row.doorId);
      if (!d) {
        d = { range: { ratio: [], unit: [] }, axial: { ratio: [], unit: [] } };
        p.doors.set(row.doorId, d);
      }
      d[model].ratio.push(est.H / truth.hMm);
      d[model].unit.push(unit);
      if (row.exif && isNum(row.exif.focal35)) p.f35.push(row.exif.focal35);
    }
  }
  return [...phones.values()].filter((p) => p.doors.size).map((p) => {
    const doors = [...p.doors.values()];
    const pool = (model, key) => median(doors.map((d) => median(d[model][key])));
    return {
      phone: p.phone,
      doors: doors.length,
      f35: mode(p.f35),
      ratio: { range: pool('range', 'ratio'), axial: pool('axial', 'ratio') },
      mmPerRaw: { range: pool('range', 'unit'), axial: pool('axial', 'unit') },
    };
  });
}

/**
 * The session table: per route, how often the MakerNote and a valid AF depth survive; per method, errors
 * against the tape and how often the method is gated out; and the go/no-go figures.
 *
 * @param {object[]} rows
 * @param {Record<string, object>} truthByDoor
 */
export function sessionSummary(rows, truthByDoor) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const truthOf = (row) => (row && row.doorId && truthByDoor ? truthByDoor[row.doorId] || null : null);
  const routes = ROUTES.map((r) => {
    const sel = list.filter((row) => rowRoute(row) === r.id);
    const maker = sel.filter((row) => row.maker && row.maker.present && row.maker.apple).length;
    const depthTag = sel.filter((row) => row.maker && isNum(row.maker.afDepthRaw)).length;
    const valid = sel.filter((row) => row.afReading && row.afReading.valid).length;
    return { id: r.id, label: r.label, n: sel.length, makerPct: pct(maker, sel.length), depthTagPct: pct(depthTag, sel.length), validPct: pct(valid, sel.length), depthTagCount: depthTag };
  });

  const withTape = list.filter((row) => hasTape(truthOf(row)));
  const counted = withTape.filter(cornersConfirmed);
  const leftOutBySource = {};
  for (const row of withTape) {
    if (cornersConfirmed(row)) continue;
    const why = !Array.isArray(row.corners) ? 'no_corners' : row.cornersSource || 'unknown';
    leftOutBySource[why] = (leftOutBySource[why] || 0) + 1;
  }
  const leftOut = { rows: withTape.length - counted.length, bySource: leftOutBySource };

  const methods = METHODS.map((m) => methodSummary(m, counted, truthOf));
  const byId = Object.fromEntries(methods.map((m) => [m.id, m]));
  const afCalibration = { byPhone: afByPhone(counted, truthOf) };

  // Gates on walls that are not brick: every such photo should be gated out.
  const nonBrick = counted.filter((row) => truthOf(row).wall === 'other' && row.brick);
  const caught = nonBrick.filter((row) => {
    const est = methodEstimate(row, truthOf(row), 'brick');
    return !est || est.gated;
  }).length;
  const nonBrickDoors = new Set(nonBrick.map((row) => row.doorId)).size;

  const R = GO_RULES;
  const survives = (ids) => routes.filter((r) => ids.includes(r.id) && r.depthTagCount > 0).map((r) => r.id);
  const customerDepth = survives(CUSTOMER_ROUTES);
  const effortDepth = survives(EFFORT_ROUTES);
  const afM = ['af_range', 'af_axial'].map((id) => byId[id]);
  const afRaw = afM.filter((m) => m.doors >= R.afDoors && m.H.p90 <= R.afHp90);
  const afCal = afM.filter((m) => m.calibrated.doors >= R.afDoors && m.calibrated.H.p90 <= R.afHp90);
  const afEnough = afM.some((m) => m.doors >= R.afDoors);
  let afVerdict;
  if (!customerDepth.length) {
    afVerdict = effortDepth.length
      ? 'only through Files (Save to Files first, which customers rarely do): no customer route keeps 0x0038 yet'
      : 'no practical route keeps 0x0038 yet';
  } else if (afRaw.length) afVerdict = 'GO';
  else if (afCal.length) afVerdict = 'GO with a per-phone scale constant (leave-one-door-out)';
  else if (afEnough) afVerdict = 'NO-GO on these numbers (raw and with a per-phone scale constant)';
  else afVerdict = `need >= ${R.afDoors} doors with confirmed corners`;

  const brickM = byId.brick;
  const brickPass = brickM.doors >= R.brickDoors
    && brickM.H.p90 <= R.brickHp90
    && brickM.W.p90 <= R.brickWp90
    && brickM.doorsGatedPct <= R.brickMaxGatedPct
    && nonBrickDoors >= R.nonBrickDoors
    && caught === nonBrick.length;
  const go = {
    af: {
      depthSurvivesOn: customerDepth,
      depthSurvivesOnEffort: effortDepth,
      methodsPassing: afRaw.map((m) => m.id),
      methodsPassingCalibrated: afCal.map((m) => m.id),
      go: customerDepth.length > 0 && (afRaw.length > 0 || afCal.length > 0),
      verdict: afVerdict,
    },
    brick: {
      brickDoors: brickM.doorsApplicable,
      doorsMeasured: brickM.doors,
      doorsGated: brickM.doorsGated,
      doorsGatedPct: brickM.doorsGatedPct,
      Hp90: brickM.H.p90,
      Wp90: brickM.W.p90,
      nonBrickPhotos: nonBrick.length,
      nonBrickDoors,
      nonBrickCaughtPct: pct(caught, nonBrick.length),
      go: brickPass,
      verdict: brickPass
        ? 'GO'
        : brickM.doors < R.brickDoors
          ? `need >= ${R.brickDoors} brick doors measured`
          : nonBrickDoors < R.nonBrickDoors
            ? `need >= ${R.nonBrickDoors} doors that are not brick`
            : 'NO-GO on these numbers',
    },
  };
  return { rows: list.length, routes, counted: counted.length, leftOut, methods, afCalibration, go };
}
