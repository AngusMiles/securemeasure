// Camera-height + gravity scale for the lab page's secondary panel (lab/vio/). Pure ES module, no DOM.
//
// PORTED from the Nov 2026 research simulator camheight/sim/geom.mjs (scratchpad webscale\camheight\sim):
// jointML, rectDrop, the vector helpers, rotvec, matMul, matVec, col, fromCols and the linear solve (renamed
// solveLinear). Unchanged except that the imports come from the repo by relative path.
//
// Frames: door / world as tools/camera.mjs (X right, Y DOWN = gravity for a plumb door, Z into the house, mm;
// corners TL (0,0), TR (W,0), BR (W,H), BL (0,H), the sill line is Y = H). Camera: x right, y down, z forward;
// X_cam = R X_world + t. `down` below is the gravity DIRECTION in the camera frame (unit vector pointing to
// the ground), which is -unit(specific force) mapped device -> camera.

import { rectifyRectangle } from '../../js/estimate.js';
import { FLIP, mv } from './solver.js';
import { normaliseMotion } from './motion.js';

export const RAD = Math.PI / 180;
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => mul(a, 1 / len(a));

/** Rodrigues: rotation vector -> 3x3 row-major nested matrix. */
export function rotvec(w) {
  const th = len(w);
  if (th < 1e-15) return [[1, -w[2], w[1]], [w[2], 1, -w[0]], [-w[1], w[0], 1]];
  const k = mul(w, 1 / th);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  return [
    [c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
    [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
    [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v],
  ];
}
export const matMul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
export const matVec = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
export const col = (M, j) => [M[0][j], M[1][j], M[2][j]];
export const fromCols = (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];

/** Rotate a camera-frame vector by small angles about camera x (pitch) and z (roll), radians. */
export function tiltCam(g, pitchRad, rollRad) {
  return unit(matVec(matMul(rotvec([pitchRad, 0, 0]), rotvec([0, 0, rollRad])), g));
}

/** (B/C) rectified shape, scale from the drop. down = sensor gravity (B) or the door's own vertical r2 (C). */
export function rectDrop(corners, K, dropMm, gSensor = null) {
  const R = rectifyRectangle(corners, K);
  const rho = R.widthOverHeight;
  const down = gSensor ? unit(gSensor) : R.r2;
  const mid = add(add(R.t, R.r2), mul(R.r1, rho / 2));
  const du = dot(down, mid);
  if (!(du > 1e-6)) return null;
  const s = dropMm / du;
  return { w: rho * s, h: s, dist: Math.abs(dot(R.r3, R.t)) * s, rect: R };
}

/**
 * (D) Joint maximum likelihood: 8 corner coordinates + sensor gravity (2 dof) + drop prior + focal prior.
 * Unknowns: rotation (3), translation (3), ln W, ln H, ln f (9). The door is assumed plumb, so gravity =
 * R * (0,1,0). Levenberg-Marquardt with a numeric Jacobian; ~10 iterations.
 * @param {{x:number,y:number}[]} corners  [TL, TR, BR, BL] px
 * @param {{f:number,cx:number,cy:number}} K0  assumed intrinsics
 * @param {number[]} g  gravity direction (down) in the camera frame
 * @param {number} dropMm  vertical drop from the lens to the sill line
 * @returns {{ w, h, f, dist, cost, R } | null}  mm
 */
export function jointML(corners, K0, g, dropMm, { sigmaPx = 3, sigmaG = 0.6 * RAD, sigmaDrop = 40, sigmaLnF = 0.02, useGravity = true, fitFocal = true, init = null } = {}) {
  const start = init || rectDrop(corners, K0, dropMm, useGravity ? g : null);
  if (!start) return null;
  const Rr = start.rect;
  const R0 = fromCols(Rr.r1, Rr.r2, Rr.r3);
  const t0 = mul(Rr.t, start.h);
  const gm = unit(g);
  const e1 = unit(cross(gm, Math.abs(gm[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const e2 = cross(gm, e1);
  const lnf0 = Math.log(K0.f);
  let p = [0, 0, 0, t0[0], t0[1], t0[2], Math.log(start.w), Math.log(start.h), lnf0];
  const nP = fitFocal ? 9 : 8;
  const resid = (q) => {
    const R = matMul(rotvec([q[0], q[1], q[2]]), R0);
    const t = [q[3], q[4], q[5]];
    const W = Math.exp(q[6]);
    const Hh = Math.exp(q[7]);
    const f = fitFocal ? Math.exp(q[8]) : K0.f;
    const out = [];
    const P = [[0, 0, 0], [W, 0, 0], [W, Hh, 0], [0, Hh, 0]];
    for (let i = 0; i < 4; i++) {
      const X = add(matVec(R, P[i]), t);
      if (X[2] <= 1) return null;
      out.push(((f * X[0]) / X[2] + K0.cx - corners[i].x) / sigmaPx);
      out.push(((f * X[1]) / X[2] + K0.cy - corners[i].y) / sigmaPx);
    }
    const d = col(R, 1);
    if (useGravity) {
      out.push(dot(d, e1) / sigmaG);
      out.push(dot(d, e2) / sigmaG);
    }
    const drop = Hh + dot(d, t);
    out.push((drop - dropMm) / sigmaDrop);
    if (fitFocal) out.push((Math.log(f) - lnf0) / sigmaLnF);
    return out;
  };
  const steps = [1e-6, 1e-6, 1e-6, 1e-3, 1e-3, 1e-3, 1e-7, 1e-7, 1e-7];
  let r = resid(p);
  if (!r) return null;
  let cost = r.reduce((a, b) => a + b * b, 0);
  let lambda = 1e-3;
  for (let it = 0; it < 30; it++) {
    const J = [];
    for (let k = 0; k < nP; k++) {
      const pp = p.slice();
      const pm = p.slice();
      pp[k] += steps[k];
      pm[k] -= steps[k];
      const rp = resid(pp);
      const rm = resid(pm);
      if (!rp || !rm) return null;
      J.push(rp.map((v, i) => (v - rm[i]) / (2 * steps[k])));
    }
    const A = Array.from({ length: nP }, (_, a) => Array.from({ length: nP }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
    const bvec = Array.from({ length: nP }, (_, a) => -J[a].reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const dp = solveLinear(M, bvec);
      if (!dp) break;
      const pn = p.slice();
      for (let k = 0; k < nP; k++) pn[k] += dp[k];
      const rn = resid(pn);
      if (rn) {
        const cn = rn.reduce((a, b) => a + b * b, 0);
        if (cn < cost) {
          const rel = (cost - cn) / Math.max(cost, 1e-12);
          p = pn;
          r = rn;
          cost = cn;
          lambda = Math.max(lambda / 3, 1e-9);
          improved = true;
          if (rel < 1e-10) it = 99;
          break;
        }
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  const R = matMul(rotvec([p[0], p[1], p[2]]), R0);
  return { w: Math.exp(p[6]), h: Math.exp(p[7]), f: fitFocal ? Math.exp(p[8]) : K0.f, dist: Math.abs(dot(col(R, 2), [p[3], p[4], p[5]])), cost, R };
}

/** Gaussian elimination with partial pivoting (research `solve`). */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const fct = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= fct * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// ------------------------------------------------------------------------------------------------ lab panel
/**
 * Gravity direction in the back camera's frame from the mean specific force of a still phone (W3C sign,
 * device frame): down = -unit(f), then camera = FLIP x device.
 * @param {number[]} fDevice  e.g. normaliseMotion stats.gStill
 * @returns {number[] | null}
 */
export function downInCamera(fDevice) {
  if (!Array.isArray(fDevice) || fDevice.length !== 3 || !fDevice.every(Number.isFinite) || !(len(fDevice) > 0)) return null;
  return mv(FLIP, mul(unit(fDevice), -1));
}

/**
 * (a) The door's vertical (rectifyRectangle r2, door "down" in the camera frame) against the sensor's down.
 * pitchDeg: angle about camera x, measured in the camera y-z plane, + when the sensor's down is turned from the
 * door's towards +z (rotvec([+p, 0, 0]) applied to the door's down gives +p). rollDeg: about camera z, in the
 * x-y plane, + when turned from +y towards -x (rotvec([0, 0, +r])). angleDeg: the full angle between them.
 * A plumb door and a perfect IMU-to-camera alignment give 0 / 0; the numbers are each phone's gravity error
 * plus its IMU-to-camera misalignment plus the door's own lean.
 */
export function doorVsGravity(corners, K, down) {
  const R = rectifyRectangle(corners, K);
  const r2 = unit(R.r2);
  const d = unit(down);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const pitch = wrap(Math.atan2(d[2], d[1]) - Math.atan2(r2[2], r2[1]));
  const roll = wrap(Math.atan2(-d[0], d[1]) - Math.atan2(-r2[0], r2[1]));
  return {
    pitchDeg: pitch / RAD,
    rollDeg: roll / RAD,
    angleDeg: Math.acos(Math.max(-1, Math.min(1, dot(r2, d)))) / RAD,
    doorDown: r2,
    sensorDown: d,
  };
}

/** Lens drop to the sill from a typed stature: stature + 20 (shoes) - 110 (eye below the top of the head) -
 * 60 (phone held below the eyes) - sill offset. All mm. */
export function dropFromStature(statureMm, sillOffsetMm = 0) {
  return statureMm + 20 - 110 - 60 - (Number.isFinite(sillOffsetMm) ? sillOffsetMm : 0);
}

/**
 * Everything the camera-height panel shows.
 * @param {object} o
 * @param {{x:number,y:number}[]} o.corners  mean corners over a still interval, frame px (cameraHeightInputs)
 * @param {number} o.width
 * @param {number} o.height
 * @param {number} o.focalPx
 * @param {boolean} o.exifFocal  true when the focal came from EXIF (sigma ln f 0.02, else 0.08)
 * @param {number[]} o.gravityDevice  mean specific force over the SAME interval, W3C device frame (m/s^2)
 * @param {number} [o.lensHeightMm]  lens above the ground the tester stands on (taped)
 * @param {number} [o.sillOffsetMm]  + when the sill is higher than where the tester stands
 * @param {number} [o.statureMm]
 * @param {{ w?: number, h?: number }} [o.tapeMm]
 */
export function cameraHeightPanel({ corners, width, height, focalPx, exifFocal = false, gravityDevice, lensHeightMm, sillOffsetMm, statureMm, tapeMm = {} } = {}) {
  const out = { ok: false };
  const down = downInCamera(gravityDevice);
  const okCorners = Array.isArray(corners) && corners.length === 4 && corners.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!down || !okCorners || !(focalPx > 0) || !(width > 0) || !(height > 0)) {
    out.reason = !down ? 'no_gravity' : 'no_corners';
    return out;
  }
  const K = { f: focalPx, cx: width / 2, cy: height / 2 };
  out.ok = true;
  out.down = down;
  out.tilt = doorVsGravity(corners, K, down);
  const sill = Number.isFinite(sillOffsetMm) ? sillOffsetMm : 0;
  const opts = { sigmaPx: 2, sigmaG: 0.6 * RAD, sigmaDrop: 20, sigmaLnF: exifFocal ? 0.02 : 0.08 };
  const withErr = (r, drop) => {
    if (!r) return { ok: false, dropMm: drop };
    const e = { ok: true, dropMm: drop, wMm: r.w, hMm: r.h, distMm: r.dist, fPx: r.f, fRatio: r.f / focalPx };
    if (Number.isFinite(tapeMm.w)) e.errWmm = r.w - tapeMm.w;
    if (Number.isFinite(tapeMm.h)) e.errHmm = r.h - tapeMm.h;
    return e;
  };
  if (Number.isFinite(lensHeightMm) && lensHeightMm > 0) {
    const drop = lensHeightMm - sill;
    out.taped = withErr(safe(() => jointML(corners, K, down, drop, opts)), drop);
  }
  if (Number.isFinite(statureMm) && statureMm > 0) {
    const drop = dropFromStature(statureMm, sill);
    out.stature = withErr(safe(() => jointML(corners, K, down, drop, opts)), drop);
  }
  return out;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ inputs
const toNum = (v) => (typeof v === 'number' ? v : v === null || v === undefined ? NaN : Number(v));
/** Length of the verified-still interval (ms): still-1 only ends after the gyro stayed under 3 deg/s this long. */
export const STILL_WINDOW_MS = 1000;

/**
 * The interval the camera-height panel averages over (ms, the page's performance.now clock): the last
 * STILL_WINDOW_MS of still-1, which the page only ends once the phone has been still that long (its start
 * holds the tap on "Yes" and the settling after it, 0.3-2 deg of turn); the whole still10 phase of a Still
 * run; else the last STILL_WINDOW_MS of still-2. null when the log has none of them.
 */
export function cameraHeightWindow(phases) {
  const list = Array.isArray(phases) ? phases : [];
  for (const [name, whole] of [['still1', false], ['still10', true], ['still2', false]]) {
    const p = list.find((x) => x && x.name === name);
    if (!p) continue;
    const t0 = toNum(p.t0);
    const t1 = toNum(p.t1);
    if (!(Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0)) continue;
    return { phase: name, t0: whole ? t0 : Math.max(t0, t1 - STILL_WINDOW_MS), t1 };
  }
  return null;
}

/**
 * Corners and gravity for cameraHeightPanel from the SAME still interval (cameraHeightWindow): the mean quad
 * of the tracked frames inside it and the mean specific force of the motion events inside it. (Pairing the
 * first tracked frame with the whole still-1 mean mixes the tap on the screen and the settling into the
 * gravity; bench.json puts H p90 at about 211 mm per degree of gravity error.)
 * @param {object} log  a page log (phases, motion)
 * @param {{ t: number, corners: {x:number,y:number}[] }[]} frames  tracked frames, t in s on the log's clock
 * @returns {{ ok: boolean, reason?: string, corners?, gravityDevice?, window?, nFrames?, nEvents? }}
 */
export function cameraHeightInputs(log, frames) {
  const win = cameraHeightWindow(log && log.phases);
  if (!win) return { ok: false, reason: 'no_still_window' };
  const inside = (frames || []).filter((f) => f && Number.isFinite(f.t) && f.t * 1000 >= win.t0 && f.t * 1000 <= win.t1);
  if (inside.length < 3) return { ok: false, reason: 'no_still_frames', window: win, nFrames: inside.length };
  const corners = [0, 1, 2, 3].map((c) => ({
    x: inside.reduce((s, f) => s + f.corners[c].x, 0) / inside.length,
    y: inside.reduce((s, f) => s + f.corners[c].y, 0) / inside.length,
  }));
  const norm = log && log.motion ? normaliseMotion(log.motion, { stillMs: [win.t0, win.t1] }) : null;
  const st = norm && norm.stats;
  // stillSource 'still1' is normaliseMotion's name for "the window it was given" (>= 5 events inside it)
  if (!st || st.stillSource !== 'still1' || !Array.isArray(st.gStill)) return { ok: false, reason: 'no_still_motion', window: win, nFrames: inside.length, corners };
  return { ok: true, corners, gravityDevice: st.gStill, window: win, nFrames: inside.length, nEvents: st.nStill };
}
