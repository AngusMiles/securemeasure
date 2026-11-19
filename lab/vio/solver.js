// Visual-inertial door scale: the solver of the lab page (lab/vio/). Pure ES module, no DOM, also runs under
// Node (lab/vio/replay.mjs, tests/lab-vio.test.mjs).
//
// PORTED from the Nov 2026 research simulator vi-scale/sim/vi-sim.mjs (scratchpad webscale\vi-scale\sim):
// expSO3, logSO3, inv3, polar, lsq, visionPoses, eventTimes, integrateGyro, findIdx, interpR, rotResidual,
// alignRotation, buildTrack, integrate2, interpArr, gyroAidedCentres, fitScale, solve, median and GATE.
// Changes from the research copy (each marked "LAB:" below):
//  - the IMG_W / IMG_H constants are gone: the logged frame size is passed in (width, height);
//  - the assumed focal (fAss) is an input: focalPx, which the page sets from the EXIF focal35mm of the lens
//    check or PHONE_DEFAULT_F35, through focalPxFrom35mm(f35, w, h) (see focalPxForFrame);
//  - solve() never throws: anything unusable gives { ok: false, reason };
//  - the delta grids are integer-stepped (no float drift), and the result carries the per-window scales,
//    the sweep size, the gate, and the camera-centre motion (for the Rotate-only check);
//  - an optional cubic-Hermite gyro integrator (settings.gyroIntegrator, default 'hermite'; see below);
//  - solveWith(log, overrides) re-runs the whole page pipeline on a downloaded log (replay.mjs);
//  - solveWith solves only the motion phase +- settings.trim (0.6 s), clear of the Tap-sync taps
//    (solveWindow), because the page's runs are much longer than the research's;
//  - the gate's x residual test uses the median of the 2.5 s window fits (4 mm), see GATE_LIMITS;
//  - imuCentreMotion: the Rotate-only check's camera motion that the IMU does not see (lever arm removed).
//
// FRAMES. World = door frame of tools/camera.mjs (x right, y DOWN, z into the house, door plane z = 0), in
// door-height units on the vision side and metres on the IMU side; the solved scale is metres per door height,
// i.e. the door height in metres. Camera: x right, y down, z forward. Device (W3C): x right, y up the screen,
// z out of the screen. Back camera, portrait: camera = diag(1, -1, -1) x device (FLIP).
//
// Time offset convention: IMU time = vision time + delta (dRot from the rotation fit, dTr from the
// translation fit).

import { rectifyRectangle, focalPxFrom35mm, PHONE_DEFAULT_F35 } from '../../js/estimate.js';
// A benign import cycle (motion.js imports integrateGyro / rotResidual / eventTimes from here): both modules
// only use each other's function declarations, at call time, never while they load.
import { normaliseMotion, detectGyroMapping, applyGyroMapping, parseGyroMapping } from './motion.js';

// ------------------------------------------------------------------------------------------------ maths
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scl(a, 1 / len(a));
// 3x3 row-major
export function mm(A, B) {
  const C = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) C[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
  return C;
}
export function mv(A, v) {
  return [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
}
export function mT(A) {
  return [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
}
export const I3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);
/** camera <-> device for the back camera in portrait (self-inverse). */
export const FLIP = Object.freeze([1, 0, 0, 0, -1, 0, 0, 0, -1]);
export const G = 9.80665;
const GW = [0, G, 0]; // gravity acceleration, world (y down)

export function expSO3(w) {
  const th = len(w);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const k = scl(w, 1 / th);
  const s = Math.sin(th);
  const c = 1 - Math.cos(th);
  const K = [0, -k[2], k[1], k[2], 0, -k[0], -k[1], k[0], 0];
  const K2 = mm(K, K);
  return I3.map((v, i) => v + s * K[i] + c * K2[i]);
}
export function logSO3(R) {
  const cosT = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(cosT);
  const v = [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  if (th < 1e-7) return v;
  return scl(v, th / Math.sin(th));
}
export function inv3(A) {
  const [a, b, c, d, e, f, g, h, i] = A;
  const co = [e * i - f * h, -(d * i - f * g), d * h - e * g];
  const det = a * co[0] + b * co[1] + c * co[2];
  return [
    co[0] / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    co[1] / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    co[2] / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}
/** Nearest rotation (polar factor) by Newton iteration. */
export function polar(M) {
  let X = M.slice();
  for (let it = 0; it < 12; it++) {
    const Y = mT(inv3(X));
    X = X.map((v, i) => 0.5 * (v + Y[i]));
  }
  return X;
}
/** Dense least squares via normal equations + Cholesky (columns pre-scaled), optional ridge per column. */
export function lsq(rows, rhs, n, ridge = null) {
  const N = new Float64Array(n * n);
  const b = new Float64Array(n);
  for (let r = 0; r < rows.length; r++) {
    const a = rows[r];
    const y = rhs[r];
    for (let i = 0; i < n; i++) {
      const ai = a[i];
      if (ai === 0) continue;
      b[i] += ai * y;
      for (let j = i; j < n; j++) N[i * n + j] += ai * a[j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) N[i * n + j] = N[j * n + i];
  if (ridge) for (let i = 0; i < n; i++) N[i * n + i] += ridge[i];
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = 1 / Math.sqrt(N[i * n + i] || 1);
  for (let i = 0; i < n; i++) {
    b[i] *= d[i];
    for (let j = 0; j < n; j++) N[i * n + j] *= d[i] * d[j];
  }
  for (let i = 0; i < n; i++) N[i * n + i] += 1e-12;
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = N[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-300));
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * z[k];
    z[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  for (let i = 0; i < n; i++) x[i] *= d[i];
  return x;
}
export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

// ------------------------------------------------------------------------------------------------ settings
/**
 * The research BASE solver keys (vi-sim.mjs BASE, "recommended solver"), plus the lab's pipeline keys.
 *  accelSource 'B'          accelerationIncludingGravity + our own attitude ('A' = event.acceleration)
 *  visionTranslation        'gyroAided' (gyro rotation + corner rays) | 'homography' (per-frame pose)
 *  separateZ / useAxes      own scale for the depth axis; the height comes from the x/y scale
 *  bodyBias / cubic         nuisance columns
 *  integrator               'hermite' | 'hermite-central' (research slopes) | 'trapezoid' (accelerometer
 *                           double integration; see integrate2)
 *  gyroIntegrator           LAB: 'hermite' (cubic rate spline) | 'trapezoid' (the research's mean-rate rule).
 *                           On noise-free synthetic sweeps the mean-rate rule leaves a scale bias of up to
 *                           -0.33 % (it overstates the rotation by ~(w h)^2/12, which the focal column turns
 *                           into scale); 'hermite' leaves < 0.1 %. Research S2 (200 seeds): p50 0.85 -> 0.84 %,
 *                           p90 2.34 -> 2.17 %, bias -0.21 -> -0.05 %.
 *  fit / combine / window   'inverse' fit; 'win' = median over 2.5 s windows of the geometric mean of the
 *                           forward and inverse fits
 *  focalCol                 estimate ln(focal error) jointly
 *  timestamps               'raw' event.timeStamp | 'fit' straight line through the event index
 *  mode                     'lateral' (left-right sweep: the motion size is read on x) | 'push'
 * Lab pipeline keys (used by solveWith only):
 *  timeSource               'auto' (captureTime when present on >= 90 % of frames) | 'captureTime' |
 *                           'presentationTime'
 *  gyroMapping              'auto' (detectGyroMapping) or a label such as 'x=+beta y=+gamma z=+alpha'
 *  mappingDelta             time offset (s) at which detectGyroMapping compares rotations
 *  f35                      null = the logged focal (EXIF or prior); a number forces a 35 mm-equivalent
 *  useFlagged               false = drop frames the tracker flagged
 *  trim                     LAB: margin (s) kept around the motion phase (sweep / rotate / still10); the long
 *                           still phases the page records (still-1 >= 1 s, a 7 s sweep, still-2 >= 1 s, and the
 *                           Tap-sync taps) stay out of the solve (see solveWindow). null = the whole run.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'lateral',
  accelSource: 'B',
  visionTranslation: 'gyroAided',
  separateZ: true,
  useAxes: 'xy',
  bodyBias: true,
  cubic: false,
  integrator: 'hermite',
  gyroIntegrator: 'hermite',
  fit: 'inverse',
  combine: 'win',
  window: 2.5,
  focalCol: true,
  timestamps: 'raw',
  timeSource: 'auto',
  gyroMapping: 'auto',
  mappingDelta: -0.02,
  f35: null,
  useFlagged: false,
  trim: 0.6,
});

/**
 * The research acceptance gate (vi-sim.mjs GATE). NaN anywhere fails it.
 * LAB: the x residual test uses the median over the 2.5 s windows of each window fit's x residual
 * (rmsXWinMm, limit 4 mm) when the result has one, else the whole-run fit's (rmsMm[0], the research's 6 mm).
 * The research applied 6 mm to one fit over the whole 4.2-6.2 s run, whose quadratic nuisance terms stop
 * absorbing the IMU drift on the page's longer runs (a 7 s sweep): S2 with still 1.2 s and a 7-8 s sweep
 * passed 37 of 100 on it (11 of 40 untrimmed), at the same accuracy. The scale is the median of the window
 * fits, so their residual is the one that says whether it can be trusted. Window fits leave less residual
 * (S2 p50 2.3 mm against 3.5 mm whole-run), so 4 mm keeps the research gate's selectivity (Nov 2026 lab
 * check, trimmed solve through solveWith): S2 research durations 90 / 100 pass (whole-run 6 mm: 82), page
 * durations 96 / 100 (37); S10 OIS 1 / 60 (6) and 2 / 60 (2); S13 pessimistic sensors 43 / 60 (44) and
 * 45 / 60 (18). At 6 mm the window test let OIS through (S10 17 / 60, gated |error| p90 7.9 %).
 */
export const GATE_LIMITS = Object.freeze({ split: 0.03, motionRmsMm: 25, rmsXmm: 6, rmsXWinMm: 4 });
/** The x residual the gate tests: { mm, limit, windowed }. */
export function gateResidual(r) {
  if (r && Number.isFinite(r.rmsXWinMm)) return { mm: r.rmsXWinMm, limit: GATE_LIMITS.rmsXWinMm, windowed: true };
  return { mm: r && r.rmsMm ? toNum(r.rmsMm[0]) : NaN, limit: GATE_LIMITS.rmsXmm, windowed: false };
}
const residualOk = (r) => {
  const g = gateResidual(r);
  return g.mm < g.limit;
};
export const GATE = (r) =>
  Boolean(r) && r.ok !== false && r.split < GATE_LIMITS.split && r.motionRmsMm > GATE_LIMITS.motionRmsMm && residualOk(r);
export const GATE_TEXT = 'window-to-window scale spread (1.48 MAD) < 3 %, vision-seen motion RMS > 25 mm, x residual RMS < 4 mm (median of the 2.5 s window fits; 6 mm when there is only a whole-run fit)';

/**
 * The gate with the reason for each failed test, in plain words.
 * @param {object} r  a solve() result
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function gateOf(r) {
  const reasons = [];
  if (!r || r.ok === false) return { pass: false, reasons: [`no result${r && r.reason ? ` (${r.reason})` : ''}`] };
  if (!(r.split < GATE_LIMITS.split)) reasons.push(`window spread ${fmtPct(r.split)} is not under 3 %`);
  if (!(r.motionRmsMm > GATE_LIMITS.motionRmsMm)) reasons.push(`motion RMS ${fmtNum(r.motionRmsMm)} mm is not over 25 mm (slide further)`);
  const xr = gateResidual(r);
  if (!(xr.mm < xr.limit)) reasons.push(`x residual ${fmtNum(xr.mm)} mm${xr.windowed ? ' (median of the window fits)' : ''} is not under ${xr.limit} mm`);
  return { pass: reasons.length === 0, reasons };
}
const fmtPct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} %` : 'n/a');
const fmtNum = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');

// ------------------------------------------------------------------------------------------------ focal
/**
 * Focal length in px for the logged frame. focalPxFrom35mm assumes a whole 4:3 (or 3:2) frame; a frame of
 * another shape (16:9 video) is a crop of the 4:3 sensor across its long side, so the 4:3 frame with the same
 * long side is used instead.
 * @returns {{ focalPx: number, frameAssumed: 'as_logged' | '4:3_long_side' }}
 */
export function focalPxForFrame(f35, width, height) {
  const f = Number.isFinite(f35) && f35 > 0 ? f35 : PHONE_DEFAULT_F35;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const ratio = long / short;
  const whole = Math.abs(ratio / (4 / 3) - 1) <= 0.02 || Math.abs(ratio / 1.5 - 1) <= 0.02;
  if (whole) return { focalPx: focalPxFrom35mm(f, width, height), frameAssumed: 'as_logged' };
  return { focalPx: focalPxFrom35mm(f, long, (long * 3) / 4), frameAssumed: '4:3_long_side' };
}

// ------------------------------------------------------------------------------------------------ solver
// LAB: width/height instead of IMG_W/IMG_H; frames carry t (s) instead of tCap; bad rectifications skipped.
export function visionPoses(frames, fAss, width, height) {
  const K = { f: fAss, cx: width / 2, cy: height / 2 };
  const out = [];
  for (const fr of frames) {
    const r = rectifyRectangle(fr.corners, K);
    const Rcd = [r.r1[0], r.r2[0], r.r3[0], r.r1[1], r.r2[1], r.r3[1], r.r1[2], r.r2[2], r.r3[2]]; // door->camera
    const c = scl(mv(mT(Rcd), r.t), -1); // camera centre, door coords, height units
    if (!Rcd.every(Number.isFinite) || !c.every(Number.isFinite) || !Number.isFinite(r.widthOverHeight)) continue;
    const Rwd = mm(mT(Rcd), FLIP); // device -> door
    out.push({ t: fr.t, c, Rwd, wh: r.widthOverHeight, corners: fr.corners });
  }
  return out;
}

export function eventTimes(events, how) {
  const n = events.length;
  const t = new Float64Array(n);
  if (how === 'fit') {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += events[i].ts;
      sxx += i * i;
      sxy += i * events[i].ts;
    }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const a = (sy - b * sx) / n;
    for (let i = 0; i < n; i++) t[i] = a + b * i;
  } else for (let i = 0; i < n; i++) t[i] = events[i].ts;
  return t;
}

/**
 * Device attitude by integrating the rotation rate from R = I at te[0]. 'trapezoid' (research) uses the mean
 * rate of each interval; 'hermite' (LAB) treats the rate as a cubic Hermite spline (central-difference slopes),
 * whose integral removes the ~(w h)^2/12 amplitude error of the mean-rate rule at 60 Hz. The slopes ride on
 * the returned array (R.slopes) so that interpR interpolates the same way.
 */
export function integrateGyro(events, te, bias, how = 'trapezoid') {
  const n = events.length;
  const R = new Array(n);
  R[0] = I3;
  let m = null;
  if (how === 'hermite' && n > 1) {
    m = new Array(n);
    for (let j = 0; j < n; j++) {
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(n - 1, j + 1);
      m[j] = scl(sub(events[j1].rot, events[j0].rot), 1 / (te[j1] - te[j0]));
    }
  }
  for (let i = 0; i + 1 < n; i++) {
    const h = te[i + 1] - te[i];
    let th = scl(sub(add(events[i].rot, events[i + 1].rot), scl(bias, 2)), 0.5 * h);
    if (m) th = add(th, scl(sub(m[i], m[i + 1]), (h * h) / 12));
    R[i + 1] = mm(R[i], expSO3(th));
  }
  R.slopes = m;
  return R;
}
export function findIdx(te, t) {
  let lo = 0;
  let hi = te.length - 1;
  if (t <= te[0]) return 0;
  if (t >= te[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (te[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}
export function interpR(Rg, te, events, bias, t) {
  const i = findIdx(te, t);
  const tau = t - te[i];
  const h = te[i + 1] - te[i];
  const s = tau / h;
  const m = Rg.slopes;
  if (m && s >= 0 && s <= 1) {
    // integral over [0, s] of the cubic Hermite rate (basis integrated in s, times h)
    const s2 = s * s;
    const s3 = s2 * s;
    const s4 = s3 * s;
    const a0 = h * (s - s3 + s4 / 2);
    const a1 = h * (s3 - s4 / 2);
    const b0 = h * h * (s2 / 2 - (2 * s3) / 3 + s4 / 4);
    const b1 = h * h * (-s3 / 3 + s4 / 4);
    const w0 = sub(events[i].rot, bias);
    const w1 = sub(events[i + 1].rot, bias);
    const th = add(add(scl(w0, a0), scl(w1, a1)), add(scl(m[i], b0), scl(m[i + 1], b1)));
    return mm(Rg[i], expSO3(th));
  }
  const w = scl(sub(add(events[i].rot, events[i + 1].rot), scl(bias, 2)), 0.5);
  return mm(Rg[i], expSO3(scl(w, tau)));
}

// Anchor gyro attitude to the vision attitude (A = polar(sum Rvis Rg^T)); residual = sum |log(Rg^T A^T Rvis)|^2.
export function rotResidual(poses, events, te, Rg, bias, delta) {
  const Rk = poses.map((p) => interpR(Rg, te, events, bias, p.t + delta));
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < poses.length; k++) {
    const P = mm(poses[k].Rwd, mT(Rk[k]));
    for (let i = 0; i < 9; i++) S[i] += P[i];
  }
  const A = polar(S);
  const AT = mT(A);
  let resid = 0;
  const es = [];
  for (let k = 0; k < poses.length; k++) {
    const e = logSO3(mm(mT(Rk[k]), mm(AT, poses[k].Rwd)));
    es.push(e);
    resid += dot(e, e);
  }
  return { A, resid, es };
}
// Same, plus gyro-bias estimation from the drift of the residual (e_k ~ c - b t).
export function alignRotation(poses, events, te, delta, iters = 3, how = 'trapezoid') {
  let bias = [0, 0, 0];
  let Rg = null;
  let r = null;
  const tm = poses.reduce((s, p) => s + p.t, 0) / poses.length;
  for (let it = 0; it < iters; it++) {
    Rg = integrateGyro(events, te, bias, how);
    r = rotResidual(poses, events, te, Rg, bias, delta);
    if (it === iters - 1) break;
    const sumT = [0, 0, 0];
    let stt = 0;
    for (let k = 0; k < poses.length; k++) {
      const u = poses[k].t - tm;
      stt += u * u;
      for (let a = 0; a < 3; a++) sumT[a] += r.es[k][a] * u;
    }
    bias = add(bias, scl(sumT, -1 / stt));
  }
  return { A: r.A, bias, Rg, resid: r.resid };
}

export function buildTrack(cfg, events, te, rot) {
  const n = events.length;
  const aw = new Array(n);
  const Rw = new Array(n);
  for (let i = 0; i < n; i++) {
    const R = mm(rot.A, rot.Rg[i]);
    Rw[i] = R;
    if (cfg.accelSource === 'A') aw[i] = mv(R, events[i].acc);
    else aw[i] = add(mv(R, events[i].accG), GW);
  }
  // Double integration. 'hermite' (default) models the samples as a cubic Hermite spline (slopes by central
  // differences), exact for cubics; 'trapezoid' is the naive scheme, which with perfect data loses ~(w h)^2/6
  // of the amplitude at 60 Hz (research: -0.07..-0.4 % scale).
  const series = [];
  for (let a = 0; a < 3; a++) series.push(Float64Array.from(aw, (v) => v[a]));
  for (let i = 0; i < 3; i++) for (let a = 0; a < 3; a++) series.push(Float64Array.from(Rw, (R) => R[3 * a + i]));
  const ints = series.map((y) => integrate2(te, y, cfg.integrator));
  return { P: ints.slice(0, 3), Q: ints.slice(3) }; // Q[3*i+a]
}
/**
 * Slopes dy/dt at the sample times for the Hermite integrator.
 * 'cubic' (LAB default): the derivative of the cubic through 4 neighbouring samples, averaged over the two
 * stencils centred on the sample (one-sided cubic at the ends), so the integrator is exact for a cubic y on
 * any spacing. 'central' (research): (y[j+1] - y[j-1]) / (t[j+1] - t[j-1]), one-sided at the ends; it leaves a
 * position error of ~6e-6 m on a cubic over 6.7 s at 60 Hz (relative 4e-8), negligible next to sensor noise.
 */
export function sampleSlopes(te, y, how = 'cubic') {
  const n = y.length;
  const m = new Float64Array(n);
  if (how === 'central' || n < 4) {
    for (let j = 0; j < n; j++) {
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(n - 1, j + 1);
      m[j] = j1 > j0 ? (y[j1] - y[j0]) / (te[j1] - te[j0]) : 0;
    }
    return m;
  }
  // derivative at te[j] of the Lagrange cubic through samples a..a+3
  const lag = (a, j) => {
    const x = te[j];
    let d = 0;
    for (let k = a; k < a + 4; k++) {
      let lk = 0;
      for (let q = a; q < a + 4; q++) {
        if (q === k) continue;
        let prod = 1 / (te[k] - te[q]);
        for (let r = a; r < a + 4; r++) if (r !== k && r !== q) prod *= (x - te[r]) / (te[k] - te[r]);
        lk += prod;
      }
      d += y[k] * lk;
    }
    return d;
  };
  for (let j = 0; j < n; j++) {
    const lo = j - 2 >= 0 && j + 1 <= n - 1;
    const hi = j - 1 >= 0 && j + 2 <= n - 1;
    if (lo && hi) m[j] = 0.5 * (lag(j - 2, j) + lag(j - 1, j));
    else if (lo) m[j] = lag(j - 2, j);
    else if (hi) m[j] = lag(j - 1, j);
    else m[j] = lag(j < 2 ? 0 : n - 4, j);
  }
  return m;
}

/**
 * Double integral (P) and integral (V) of samples y at times te, from P = V = 0 at te[0].
 * 'hermite' (default): y as a cubic Hermite spline with cubic-exact slopes (sampleSlopes 'cubic'): exact for a
 * cubic y. 'hermite-central': the research's central-difference slopes. 'trapezoid': the naive scheme.
 */
export function integrate2(te, y, how = 'hermite') {
  const n = y.length;
  const lin = how === 'trapezoid';
  const m = lin ? null : sampleSlopes(te, y, how === 'hermite-central' ? 'central' : 'cubic');
  const P = new Float64Array(n);
  const V = new Float64Array(n);
  for (let j = 0; j + 1 < n; j++) {
    const h = te[j + 1] - te[j];
    if (lin) {
      const am = 0.5 * (y[j] + y[j + 1]);
      P[j + 1] = P[j] + V[j] * h + 0.5 * am * h * h;
      V[j + 1] = V[j] + am * h;
    } else {
      P[j + 1] = P[j] + V[j] * h + h * h * ((7 * y[j]) / 20 + (3 * y[j + 1]) / 20) + h * h * h * (m[j] / 20 - m[j + 1] / 30);
      V[j + 1] = V[j] + (h * (y[j] + y[j + 1])) / 2 + (h * h * (m[j] - m[j + 1])) / 12;
    }
  }
  return { P, V, lin };
}
// Interpolate an integrated track at t: cubic Hermite on (P, V), or linear for the naive scheme.
export function interpArr(tr, te, t) {
  const i = findIdx(te, t);
  const h = te[i + 1] - te[i];
  const s = (t - te[i]) / h;
  if (tr.lin) return tr.P[i] * (1 - s) + tr.P[i + 1] * s;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * tr.P[i] + (s3 - 2 * s2 + s) * h * tr.V[i] + (-2 * s3 + 3 * s2) * tr.P[i + 1] + (s3 - s2) * h * tr.V[i + 1];
}

// Gyro-aided camera centre: rotation known, solve C from the 4 corner rays.
// LAB: principal point from the logged frame size.
export function gyroAidedCentres(poses, rot, events, te, delta, fAss, rho, width, height) {
  const X = [[0, 0, 0], [rho, 0, 0], [rho, 1, 0], [0, 1, 0]];
  const cx = width / 2;
  const cy = height / 2;
  return poses.map((p) => {
    const Rwd = mm(rot.A, interpR(rot.Rg, te, events, rot.bias, p.t + delta));
    const Rwc = mm(Rwd, FLIP);
    const Nm = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    let b = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const d = unit(mv(Rwc, [(p.corners[i].x - cx) / fAss, (p.corners[i].y - cy) / fAss, 1]));
      const Pm = [1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2], -d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2], -d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]];
      for (let q = 0; q < 9; q++) Nm[q] += Pm[q];
      b = add(b, mv(Pm, X[i]));
    }
    return mv(inv3(Nm), b);
  });
}

// Translation fit for a given time offset delta (IMU time = vision time + delta).
// 'forward': P_imu(t) = s c(t) + p0 + v0 u + b u^2/2 + sum beta_i Q_i(t)   (vision noise in the regressor:
//            biased low by regression dilution)
// 'inverse': c(t) = k P_imu(t) + q0 + q1 u + q2 u^2 + sum g_i Q_i(t), s = 1/k   (vision noise in the response)
// x[0], x[1] are always the scales of the x/y axes and of the z axis.
export function fitScale(cfg, poses, cs, track, te, delta, sig, subset = null, dcs = null) {
  const inv = cfg.fit !== 'forward';
  const nf = dcs ? 1 : 0;
  const idx = subset || poses.map((_, i) => i);
  if (!idx.length) return null;
  const tm = idx.reduce((s, i) => s + poses[i].t, 0) / idx.length;
  const nb = cfg.bodyBias ? 3 : 0;
  const nc = cfg.cubic ? 2 : 0;
  const n = 2 + 9 + nb + nc + nf;
  const rows = [];
  const rhs = [];
  for (const k of idx) {
    const t = poses[k].t + delta;
    if (t <= te[0] || t >= te[te.length - 1]) continue;
    const u = poses[k].t - tm;
    for (let a = 0; a < 3; a++) {
      const w = 1 / sig[a];
      const r = new Float64Array(n);
      if (nf && a < 2) r[n - 1] = dcs[k][a] * w;
      const P = interpArr(track.P[a], te, t);
      const main = inv ? P : cs[k][a];
      if (a < 2 || !cfg.separateZ) r[0] = main * w;
      else r[1] = main * w;
      r[2 + a] = w;
      r[5 + a] = u * w;
      r[8 + a] = 0.5 * u * u * w;
      if (nb) for (let i = 0; i < 3; i++) r[11 + i] = interpArr(track.Q[3 * i + a], te, t) * w;
      if (nc && a !== 1) r[11 + nb + (a === 0 ? 0 : 1)] = (u * u * u * w) / 6;
      rows.push(r);
      rhs.push((inv ? cs[k][a] : P) * w);
    }
  }
  if (rows.length < n + 5) return null;
  const ridge = new Float64Array(n);
  const unitScale = inv ? 0.5 : 1; // nuisance terms are multiplied by k ~ 1/2 in the inverse form
  for (let a = 0; a < 3; a++) ridge[8 + a] = 1 / (0.3 * unitScale) ** 2; // world accel offset prior 0.3 m/s^2
  if (nb) for (let i = 0; i < 3; i++) ridge[11 + i] = 1 / (0.1 * unitScale) ** 2; // body bias prior 0.1 m/s^2
  if (nc) for (let i = 0; i < nc; i++) ridge[11 + nb + i] = 1 / (0.05 * unitScale) ** 2;
  if (!cfg.separateZ) ridge[1] = 1;
  if (nf) ridge[n - 1] = 1 / 0.1 ** 2; // ln focal error prior 10 %
  const x = lsq(rows, rhs, n, ridge);
  let rss = 0;
  const per = [0, 0, 0];
  const cnt = [0, 0, 0];
  for (let r = 0; r < rows.length; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rows[r][i] * x[i];
    const e = rhs[r] - s;
    rss += e * e;
    per[r % 3] += (e * sig[r % 3]) ** 2;
    cnt[r % 3]++;
  }
  const rmsAxis = per.map((v, a) => Math.sqrt(v / cnt[a]));
  if (inv) {
    x[0] = 1 / x[0];
    x[1] = cfg.separateZ ? 1 / x[1] : x[0];
  }
  const sNow = Math.abs(x[0]);
  return { x, rss, rmsAxis, rmsMm: rmsAxis.map((v) => v * 1000 * (inv ? sNow : 1)), lnFocalErr: nf ? x[n - 1] : 0 };
}

const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finite3 = (v) => Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
const goodCorners = (c) => Array.isArray(c) && c.length === 4 && c.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));

/**
 * Solve for the door's metric size from tracked corners and device motion.
 *
 * @param {object} o
 * @param {{ t: number, corners: {x:number,y:number}[] }[]} o.frames  t in s (captureTime, else
 *        presentationTime, / 1000), corners [TL, TR, BR, BL] in frame px
 * @param {{ ts: number, acc?: number[], accG: number[], rot: number[] }[]} o.events  normalised device motion:
 *        ts in s on the same clock, W3C specific force in m/s^2 (device frame), rotation rate in rad/s about
 *        device x, y, z (already through the gyro mapping)
 * @param {number} o.width   frame size, px (the size the corners are in)
 * @param {number} o.height
 * @param {number} o.focalPx assumed focal, px at that size
 * @param {number} [o.refHeightM]  the door height (m) if known (the tape), for the Rotate-only check only
 *        (imuCentreMotion); the scale is never taken from it
 * @param {object} [o.settings]  overrides of DEFAULT_SETTINGS
 * @returns {object} { ok: true, Hm, Wm, sXY, sZ, rho, dRot, dTr, split, rmsMm[3], rmsXWinMm, lnFocalErr,
 *   focalRatioEst, motionRmsMm, sweepPpMm, gyroBiasEst, windows[{t0, s, rmsXmm}], gate{pass, reasons},
 *   centreRmsH[3], centreRmsXYImuH, ... } or { ok: false, reason, ...whatever diagnostics were reached }.
 *   Never throws.
 */
export function solve({ frames, events, width, height, focalPx, refHeightM, settings } = {}) {
  try {
    return solveImpl(frames, events, width, height, focalPx, { ...DEFAULT_SETTINGS, ...(settings || {}) }, refHeightM);
  } catch (err) {
    return { ok: false, reason: 'error', error: String((err && err.message) || err) };
  }
}

function solveImpl(framesIn, eventsIn, width, height, focalPx, cfg, refHeightM) {
  if (!isPos(width) || !isPos(height) || !isPos(focalPx)) return { ok: false, reason: 'bad_camera' };
  if (!Array.isArray(framesIn) || !Array.isArray(eventsIn)) return { ok: false, reason: 'no_input' };
  const fAss = focalPx;
  // LAB: drop unusable input instead of failing on it.
  const frames = framesIn.filter((f) => f && Number.isFinite(f.t) && goodCorners(f.corners)).sort((a, b) => a.t - b.t);
  const accKey = cfg.accelSource === 'A' ? 'acc' : 'accG';
  const evs = [];
  for (const e of eventsIn) {
    if (!e || !Number.isFinite(e.ts) || !finite3(e[accKey]) || !finite3(e.rot)) continue;
    // keep strictly increasing timestamps (duplicate polls of one sample / same-ms bursts)
    if (!evs.length || e.ts > evs[evs.length - 1].ts + 0.0002) evs.push(e);
  }
  const events = evs;
  if (events.length < 30) return { ok: false, reason: events.length ? 'few_events' : 'no_motion' };
  const allPoses = visionPoses(frames, fAss, width, height);
  if (allPoses.length < 20) return { ok: false, reason: 'few_frames', nFrames: allPoses.length };
  const te = eventTimes(events, cfg.timestamps);
  // LAB: frames must lie inside the motion record (fitScale also skips any whose t + delta falls outside).
  const poses = allPoses.filter((p) => p.t >= te[0] && p.t <= te[te.length - 1]);
  if (poses.length < 20) return { ok: false, reason: 'no_overlap', nFrames: allPoses.length, nInside: poses.length };
  const rho = median(poses.map((p) => p.wh));

  // 1) time offset from rotation alignment: gyro bias at a nominal offset, then a grid on the residual
  const pre = alignRotation(poses, events, te, -0.02, 3, cfg.gyroIntegrator);
  let best = { d: 0, r: Infinity };
  for (let i = 0; i <= 40; i++) {
    const d = -0.2 + i * 0.01;
    const r = rotResidual(poses, events, te, pre.Rg, pre.bias, d).resid;
    if (r < best.r) best = { d, r };
  }
  const d0 = best.d;
  for (let i = 0; i <= 20; i++) {
    const d = d0 - 0.01 + i * 0.001;
    const r = rotResidual(poses, events, te, pre.Rg, pre.bias, d).resid;
    if (r < best.r) best = { d, r };
  }
  const dRot = best.d;
  const rot = alignRotation(poses, events, te, dRot, 3, cfg.gyroIntegrator);
  const rotRmsDeg = (Math.sqrt(rot.resid / (3 * poses.length)) * 180) / Math.PI;
  const track = buildTrack(cfg, events, te, rot);
  const gyroAided = cfg.visionTranslation === 'gyroAided';
  const cs = gyroAided ? gyroAidedCentres(poses, rot, events, te, dRot, fAss, rho, width, height) : poses.map((p) => p.c);
  // d(centre)/d(ln f): lets the fit absorb a wrong focal (it shows up wherever the phone rotates)
  let dcs = null;
  const c1 = gyroAided ? gyroAidedCentres(poses, rot, events, te, dRot, fAss * 1.01, rho, width, height) : null;
  if (cfg.focalCol && gyroAided) dcs = c1.map((c, k) => scl(sub(c, cs[k]), 1 / Math.log(1.01)));
  const diag = { nFrames: poses.length, nEvents: events.length, rho, dRot, rotRmsDeg, gyroBiasEst: rot.bias, ...centreMotion(cs, c1) };
  if (isPos(refHeightM) && gyroAided) Object.assign(diag, imuCentreMotion(poses, cs, dcs, rot, events, te, track, dRot, refHeightM));

  // 2) refine delta on translation residual
  const invFit = cfg.fit !== 'forward';
  let sig = invFit ? [0.0015, 0.0015, 0.006] : [0.003, 0.003, 0.012];
  let bt = { d: dRot, rss: Infinity };
  for (let i = 0; i <= 30; i++) {
    const d = dRot - 0.06 + i * 0.004;
    const f = fitScale(cfg, poses, cs, track, te, d, sig, null, dcs);
    if (f && f.rss < bt.rss) bt = { d, rss: f.rss };
  }
  const b0 = bt.d;
  for (let i = 0; i <= 16; i++) {
    const d = b0 - 0.004 + i * 0.0005;
    const f = fitScale(cfg, poses, cs, track, te, d, sig, null, dcs);
    if (f && f.rss < bt.rss) bt = { d, rss: f.rss };
  }
  let fit = fitScale(cfg, poses, cs, track, te, bt.d, sig, null, dcs);
  if (!fit) return { ok: false, reason: 'fit', ...diag };
  sig = fit.rmsAxis.map((v) => Math.max(v, invFit ? 0.00025 : 0.0005));
  fit = fitScale(cfg, poses, cs, track, te, bt.d, sig, null, dcs);
  if (!fit) return { ok: false, reason: 'fit', ...diag };
  // split halves
  const half = Math.floor(poses.length / 2);
  const idxA = poses.map((_, i) => i).filter((i) => i < half);
  const idxB = poses.map((_, i) => i).filter((i) => i >= half);
  const fa = fitScale(cfg, poses, cs, track, te, bt.d, sig, idxA, dcs);
  const fb = fitScale(cfg, poses, cs, track, te, bt.d, sig, idxB, dcs);
  const pick = (f) => (f ? Math.abs(cfg.useAxes === 'z' ? f.x[1] : f.x[0]) : NaN);
  let sMain = pick(fit);
  let split = Math.abs(pick(fa) - pick(fb)) / sMain;
  // 'geo': geometric mean of the forward fit (biased low by vision noise) and the inverse fit (biased high by
  // IMU-track noise). 'win': the same per window (own nuisance terms), median over windows.
  let sigInv = null;
  let sigFwd = null;
  let lastRmsX = NaN; // LAB: x residual (mm) of the last inverse fit both() ran
  const both = (subset) => {
    const fi = fitScale({ ...cfg, fit: 'inverse' }, poses, cs, track, te, bt.d, sigInv, subset, dcs);
    const ff = fitScale({ ...cfg, fit: 'forward' }, poses, cs, track, te, bt.d, sigFwd, subset, dcs);
    lastRmsX = fi ? fi.rmsMm[0] : NaN;
    return fi && ff ? Math.sqrt(pick(fi) * pick(ff)) : NaN;
  };
  const windows = [];
  let rmsXWinMm = NaN;
  if (cfg.combine !== 'none') {
    const s0i = fitScale({ ...cfg, fit: 'inverse' }, poses, cs, track, te, bt.d, [0.0015, 0.0015, 0.006], null, dcs);
    const s0f = fitScale({ ...cfg, fit: 'forward' }, poses, cs, track, te, bt.d, [0.003, 0.003, 0.012], null, dcs);
    if (s0i && s0f) {
      sigInv = s0i.rmsAxis.map((v) => Math.max(v, 0.00025));
      sigFwd = s0f.rmsAxis.map((v) => Math.max(v, 0.0005));
      if (cfg.combine === 'geo') {
        sMain = both(null);
        split = Math.abs(both(idxA) - both(idxB)) / sMain;
      } else if (cfg.combine === 'win') {
        const t0w = poses[0].t;
        const t1w = poses[poses.length - 1].t;
        const W = cfg.window;
        const ws = [];
        const nWin = W > 0 ? Math.floor((t1w - t0w - W) / (W / 2) + 1e-9) + 1 : 0;
        for (let wi = 0; wi < nWin; wi++) {
          const a = t0w + (wi * W) / 2;
          const subIdx = poses.map((p, i) => i).filter((i) => poses[i].t >= a && poses[i].t < a + W);
          if (subIdx.length < 20) continue;
          const v = both(subIdx);
          if (Number.isFinite(v)) {
            ws.push(v);
            windows.push({ t0: a - t0w, s: v, rmsXmm: lastRmsX });
          }
        }
        if (ws.length >= 2) {
          const srt = [...ws].sort((x, y) => x - y);
          sMain = median(srt);
          split = (1.4826 * median(srt.map((v) => Math.abs(v - sMain)))) / sMain; // robust relative spread
          rmsXWinMm = median(windows.map((w) => w.rmsXmm).filter(Number.isFinite));
        }
      }
    }
  }
  if (!(Number.isFinite(sMain) && sMain > 0)) return { ok: false, reason: 'no_scale', ...diag, dTr: bt.d };
  // motion size seen by vision (m, using the estimate)
  const ax = cfg.mode === 'push' ? 2 : 0;
  const vals = cs.map((c) => c[ax] * sMain);
  const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
  const motionRms = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / vals.length);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const res = {
    ok: true,
    ...diag,
    Hm: sMain,
    Wm: sMain * rho,
    sXY: fit.x[0],
    sZ: fit.x[1],
    rho,
    aspectHW: 1 / rho,
    dRot,
    dTr: bt.d,
    split,
    rmsMm: fit.rmsMm,
    rmsXWinMm,
    lnFocalErr: fit.lnFocalErr,
    // lnFocalErr = ln(f_assumed / f_true) (research definition: the centres computed with the assumed focal
    // are the true ones plus lnFocalErr * dc/dlnf), so the self-estimated focal is f_assumed / exp(lnFocalErr).
    focalRatioEst: Math.exp(-fit.lnFocalErr),
    motionRmsMm: motionRms * 1000,
    sweepPpMm: (hi - lo) * 1000,
    windows,
  };
  res.gate = gateOf(res);
  return res;
}

/**
 * How much the gyro-aided camera centre moves (door-height units): RMS about its mean per axis, and the
 * share of the x/y motion a focal error would explain (ln f fitted on dc/dlnf). In a Rotate-only run the
 * centre should stay put; motion that follows the rotation means OIS or a wrong focal.
 */
function centreMotion(cs, c1) {
  const n = cs.length;
  const mean = [0, 0, 0];
  for (const c of cs) for (let a = 0; a < 3; a++) mean[a] += c[a] / n;
  const rms = [0, 0, 0];
  for (const c of cs) for (let a = 0; a < 3; a++) rms[a] += (c[a] - mean[a]) ** 2 / n;
  const out = { centreRmsH: rms.map(Math.sqrt) };
  if (!c1) return out;
  const d = c1.map((c, k) => scl(sub(c, cs[k]), 1 / Math.log(1.01)));
  const dm = [0, 0, 0];
  for (const v of d) for (let a = 0; a < 3; a++) dm[a] += v[a] / n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++)
    for (let a = 0; a < 2; a++) {
      num += (cs[k][a] - mean[a]) * (d[k][a] - dm[a]);
      den += (d[k][a] - dm[a]) ** 2;
    }
  const g = den > 0 ? num / den : 0;
  let after = 0;
  for (let k = 0; k < n; k++)
    for (let a = 0; a < 2; a++) after += (cs[k][a] - mean[a] - g * (d[k][a] - dm[a])) ** 2 / n;
  out.lnFocalFromCentres = g;
  out.centreRmsXYH = Math.sqrt(rms[0] + rms[1]);
  out.centreRmsXYAfterFocalH = Math.sqrt(after);
  return out;
}

/**
 * LAB: the camera-centre motion vision sees and the IMU does not (the Rotate-only check). Turning a hand-held
 * phone pivots it about the hand or wrist, 5-15 cm from the lens, so the lens really moves (+-10 deg: about
 * 6-18 mm RMS) and centreRmsXYH is not 0 even with no OIS. The IMU sees that motion, OIS and a wrong focal do
 * not. So the gyro-aided centres are fitted to the IMU track with the scale FIXED at the known door height
 * (refHeightM, from the tape: no scale freedom that could soak up OIS), per axis:
 *   c(t) - P_imu(t) / s = q0 + q1 u + q2 u^2 / 2 + body-bias terms + R(t) l [+ ln f x dc/dln f]
 * with the solver's nuisance terms and priors (accel offset 0.3 m/s^2, body bias 0.1 m/s^2), plus the fixed
 * IMU-to-lens offset l in the screen plane (device x, y; prior 5 cm: the accelerometer is a few cm from the
 * lens, and turning by +-10 deg moves one relative to the other by up to ~9 mm). Its component along the
 * optical axis stays 0: the IMU chip is within about 1 cm of the lens's depth, and under yaw / pitch an offset
 * l_z moves the centre exactly as a focal error of l_z / distance does (an 18 cm l_z would hide a 24 mm lens
 * taken for 26 mm). What is left (x and y, RMS, door-height units) is the apparent translation; the second
 * number also fits a focal error, so motion that survives it points to OIS.
 */
export function imuCentreMotion(poses, cs, dcs, rot, events, te, track, delta, refHeightM) {
  const k = 1 / refHeightM; // door heights per metre
  // Rows are divided by the vision noise per axis (door heights; the depth is about 4 x noisier), so that the
  // priors weigh against the data as in fitScale: the solver's starting values, then the first pass's RMS.
  const fitOnce = (withFocal, sig) => {
    const w = sig.map((s) => 1 / s);
    const nf = withFocal && dcs ? 1 : 0;
    const n = 14 + nf;
    const idx = [];
    for (let j = 0; j < poses.length; j++) {
      const t = poses[j].t + delta;
      if (t > te[0] && t < te[te.length - 1]) idx.push(j);
    }
    if (idx.length < 20) return null;
    const tm = idx.reduce((s, j) => s + poses[j].t, 0) / idx.length;
    const rows = [];
    const rhs = [];
    const raw = [];
    for (const j of idx) {
      const t = poses[j].t + delta;
      const u = poses[j].t - tm;
      const Rw = mm(rot.A, interpR(rot.Rg, te, events, rot.bias, t));
      for (let a = 0; a < 3; a++) {
        const r = new Float64Array(n);
        r[a] = w[a];
        r[3 + a] = u * w[a];
        r[6 + a] = 0.5 * u * u * k * w[a];
        for (let i = 0; i < 3; i++) r[9 + i] = interpArr(track.Q[3 * i + a], te, t) * k * w[a];
        for (let i = 0; i < 2; i++) r[12 + i] = Rw[3 * a + i] * k * w[a]; // in-plane offset only (see above)
        if (nf && a < 2) r[14] = dcs[j][a] * w[a];
        const y = cs[j][a] - k * interpArr(track.P[a], te, t);
        rows.push(r);
        rhs.push(y * w[a]);
        raw.push(a);
      }
    }
    const ridge = new Float64Array(n);
    for (let a = 0; a < 3; a++) ridge[6 + a] = 1 / 0.3 ** 2; // world accel offset, m/s^2
    for (let i = 0; i < 3; i++) ridge[9 + i] = 1 / 0.1 ** 2; // body bias, m/s^2
    for (let i = 0; i < 2; i++) ridge[12 + i] = 1 / 0.05 ** 2; // IMU-to-lens offset in the screen plane, m
    if (nf) ridge[14] = 1 / 0.1 ** 2; // ln focal error
    const x = lsq(rows, rhs, n, ridge);
    const per = [0, 0, 0];
    for (let r = 0; r < rows.length; r++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += rows[r][i] * x[i];
      per[raw[r]] += ((rhs[r] - s) / w[raw[r]]) ** 2;
    }
    const rmsAxis = per.map((v) => Math.sqrt(v / idx.length));
    return { rmsXYH: Math.sqrt((per[0] + per[1]) / idx.length), rmsAxis, lever: [-x[12], -x[13], 0], lnFocalErr: nf ? x[14] : 0 };
  };
  const run = (withFocal) => {
    const first = fitOnce(withFocal, [0.0015, 0.0015, 0.006]);
    return first ? fitOnce(withFocal, first.rmsAxis.map((v) => Math.max(v, 0.00025))) : null;
  };
  const plain = run(false);
  if (!plain) return {};
  const foc = run(true);
  return {
    centreRmsXYImuH: plain.rmsXYH,
    centreRmsXYImuAfterFocalH: foc ? foc.rmsXYH : NaN,
    imuLensOffsetM: plain.lever,
    imuRefHeightM: refHeightM,
  };
}

// ------------------------------------------------------------------------------------------------ log replay
const toNum = (v) => (typeof v === 'number' ? v : v === null || v === undefined ? NaN : Number(v));
const arr = (a) => (a && typeof a.length === 'number' ? a : []);

/**
 * The solver inputs of a page log (schema 'securemeasure-lab-vio/1'), exactly as the page builds them.
 * @param {object} log
 * @param {object} [overrides]  settings overrides (DEFAULT_SETTINGS keys)
 * @returns {{ ok: boolean, reason?: string, frames, events, width, height, focalPx, settings, info }}
 */
export function prepareLog(log, overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...((log && log.settings && log.settings.solver) || {}), ...(overrides || {}) };
  const info = { settings };
  if (!log || typeof log !== 'object' || !log.frames || !log.tracker || !log.motion || !log.env) return { ok: false, reason: 'bad_log', info };
  const size = log.env.trackSize || {};
  const width = toNum(size.w);
  const height = toNum(size.h);
  if (!isPos(width) || !isPos(height)) return { ok: false, reason: 'bad_log', info };
  const focal = log.env.focal || {};
  const f35 = Number.isFinite(toNum(settings.f35)) && toNum(settings.f35) > 0 ? toNum(settings.f35) : toNum(focal.f35);
  const { focalPx, frameAssumed } = focalPxForFrame(f35, width, height);
  info.focal = { f35: Number.isFinite(f35) && f35 > 0 ? f35 : PHONE_DEFAULT_F35, source: settings.f35 ? 'override' : focal.source || 'prior', focalPx, frameAssumed };
  info.width = width;
  info.height = height;

  // Frames: time source, tracker quad, tracker flags.
  const F = log.frames;
  const T = log.tracker;
  const nF = Math.min(toNum(F.n) || arr(F.now).length, arr(F.now).length);
  const cap = arr(F.captureTime);
  const pres = arr(F.presentationTime);
  let nCap = 0;
  for (let i = 0; i < nF; i++) if (Number.isFinite(toNum(cap[i]))) nCap++;
  const timeSource = settings.timeSource === 'auto' ? (nF > 0 && nCap >= 0.9 * nF ? 'captureTime' : 'presentationTime') : settings.timeSource;
  const timeArr = timeSource === 'captureTime' ? cap : pres;
  const quad = arr(T.quad);
  const okA = arr(T.ok);
  const flagA = arr(T.flagged);
  const frames = [];
  for (let i = 0; i < nF; i++) {
    if (toNum(okA[i]) !== 1) continue;
    if (!settings.useFlagged && toNum(flagA[i]) === 1) continue;
    const t = toNum(timeArr[i]) / 1000;
    if (!Number.isFinite(t)) continue;
    const q = [];
    for (let c = 0; c < 4; c++) q.push({ x: toNum(quad[8 * i + 2 * c]), y: toNum(quad[8 * i + 2 * c + 1]) });
    if (!goodCorners(q)) continue;
    frames.push({ t, corners: q, index: i });
  }
  info.timeSource = timeSource;
  info.captureTimeFrames = nCap;
  info.nFramesLogged = nF;
  info.frame0Corners = frames.length ? frames[0].corners : null;

  // Motion: normalise (units, repeats, accelerometer sign), then the gyro axis mapping.
  const still = phaseWindow(log.phases, 'still1');
  const norm = normaliseMotion(log.motion, { stillMs: still });
  info.motion = norm.stats;
  // LAB: only the motion phase (+- settings.trim) is solved, clear of the Tap-sync taps.
  const win = solveWindow(log, toNum(settings.trim));
  info.window = win;
  const framesUsed = win ? frames.filter((f) => f.t >= win.t0 && f.t <= win.t1) : frames;
  info.nFramesUsed = framesUsed.length;
  if (!norm.ok) return { ok: false, reason: norm.reason, info, frames: framesUsed, width, height, focalPx, settings };
  const evWin = win ? norm.events.filter((e) => e.ts >= win.eventT0 && e.ts <= win.eventT1) : norm.events;
  let mapping;
  if (settings.gyroMapping === 'auto') {
    const poses = visionPoses(framesUsed, focalPx, width, height);
    mapping = detectGyroMapping(poses, evWin, { delta: settings.mappingDelta });
    // LAB: with little rotation (a Still run) every candidate fits about as well (ratio ~1.0-1.4), so the
    // winner is a guess: kept for the solve, but marked so that nobody reads it as WebKit's axis order.
    if (mapping && mapping.ok) mapping.determined = mapping.ratio >= MAPPING_MIN_RATIO;
  } else {
    mapping = parseGyroMapping(settings.gyroMapping);
    if (mapping) {
      mapping.fixed = true;
      mapping.determined = true;
    }
  }
  info.mapping = mapping;
  if (!mapping || !mapping.ok) return { ok: false, reason: 'gyro_mapping', info, frames: framesUsed, width, height, focalPx, settings };
  const events = applyGyroMapping(evWin, mapping);
  return { ok: true, frames: framesUsed, events, width, height, focalPx, settings, info };
}

/** detectGyroMapping's runner-up / best residual ratio under which the mapping counts as not determined. */
export const MAPPING_MIN_RATIO = 5;
/** The phase whose motion is solved, per mode (the first of these a log has). */
export const MOTION_PHASE_NAMES = Object.freeze(['sweep', 'rotate', 'still10']);
/** Left out around each Tap-sync tap (ms from the tap): the tap's unbalanced acceleration sample. */
export const TAP_ZONE_MS = Object.freeze([-300, 600]);
/** Extra motion events kept on each side of the solved frames (s): the time-offset search reaches +-0.27 s. */
export const EVENT_PAD_S = 0.3;

/**
 * LAB: the part of a log the solver uses. The page records a still-1 of at least 1 s, a 7 s sweep and a
 * still-2 of at least 1 s (Tap-sync adds up to 5 s per tap); one fit across all of it leaves IMU drift its
 * quadratic nuisance terms cannot absorb. So: the motion phase (sweep / rotate / still10) +- marginS for the
 * frames, and EVENT_PAD_S more for the motion events. For Tap-sync both are then clipped clear of each tap:
 * [tap - 0.3 s, tap + 0.6 s] (the whole tap phase when no tap was seen), because a sharp tap sampled at
 * 60 Hz leaves an unbalanced acceleration sample, a velocity step that no polynomial absorbs.
 * @param {object} log
 * @param {number} marginS  null / NaN / negative: no window (the whole run)
 * @returns {{ t0, t1, eventT0, eventT1, phase, tapZones } | null}  times in s (the frames' / events' clock)
 */
export function solveWindow(log, marginS) {
  if (!log || typeof marginS !== 'number' || !(marginS >= 0)) return null; // (null >= 0 is true in JS)
  const phases = Array.isArray(log.phases) ? log.phases.filter((p) => p && typeof p === 'object') : [];
  const motion = phases.find((p) => MOTION_PHASE_NAMES.includes(p.name) && phaseWindow([p], p.name));
  if (!motion) return null;
  const [m0, m1] = phaseWindow([motion], motion.name);
  const pad = EVENT_PAD_S * 1000;
  let a = m0 - marginS * 1000;
  let b = m1 + marginS * 1000;
  const zones = [];
  for (const p of phases) {
    if (p.name !== 'tap1' && p.name !== 'tap2') continue;
    const w = phaseWindow([p], p.name);
    if (!w) continue;
    const tap = Array.isArray(log.taps) ? log.taps.find((x) => x && x.phase === p.name) : null;
    const at = tap ? toNum(tap.at) : NaN;
    zones.push(Number.isFinite(at) ? [at + TAP_ZONE_MS[0], at + TAP_ZONE_MS[1]] : [w[0] + TAP_ZONE_MS[0], w[1] + TAP_ZONE_MS[1]]);
  }
  const mid = 0.5 * (m0 + m1);
  for (const [z0, z1] of zones) {
    if (0.5 * (z0 + z1) < mid) a = Math.max(a, z1 + pad);
    else b = Math.min(b, z0 - pad);
  }
  return { t0: a / 1000, t1: b / 1000, eventT0: (a - pad) / 1000, eventT1: (b + pad) / 1000, phase: motion.name, tapZones: zones.map((z) => [z[0] / 1000, z[1] / 1000]) };
}

/** [t0, t1] in ms of the named phase of a log, or null. */
export function phaseWindow(phases, name) {
  if (!Array.isArray(phases)) return null;
  const p = phases.find((x) => x && x.name === name);
  if (!p) return null;
  const t0 = toNum(p.t0);
  const t1 = toNum(p.t1);
  return Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 ? [t0, t1] : null;
}

/**
 * Re-run the page's whole pipeline on a log: normalise the motion, detect (or apply) the gyro mapping, solve.
 * The page stores this function's result as log.results.solve, so replaying a log with no overrides gives
 * the same numbers. Never throws.
 * @param {object} log  a parsed 'securemeasure-lab-vio/1' log
 * @param {object} [overrides]  DEFAULT_SETTINGS keys to change
 * @returns {object} solve() result plus { prep } (time source, focal, motion stats, mapping)
 */
export function solveWith(log, overrides = {}) {
  try {
    const p = prepareLog(log, overrides);
    if (!p.ok) return { ok: false, reason: p.reason, gate: gateOf({ ok: false, reason: p.reason }), prep: p.info };
    // The tape height (or a nominal 2.04 m door) only scales the Rotate-only check's IMU motion.
    const tapeH = log.truth ? toNum(log.truth.tapeH) : NaN;
    const refHeightM = tapeH > 0 ? tapeH / 1000 : 2.04;
    const res = solve({ frames: p.frames, events: p.events, width: p.width, height: p.height, focalPx: p.focalPx, refHeightM, settings: p.settings });
    if (!res.ok) res.gate = gateOf(res);
    if (res.ok) res.focal35Est = p.info.focal.f35 * res.focalRatioEst;
    return { ...res, prep: p.info };
  } catch (err) {
    return { ok: false, reason: 'error', error: String((err && err.message) || err), gate: { pass: false, reasons: ['error'] } };
  }
}
