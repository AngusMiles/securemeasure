// Device-motion normalisation and sensor diagnostics for the lab page (lab/vio/). Pure ES module, no DOM.
//
// What iOS Safari is reported to do differently from the W3C spec (research Nov 2026, WebKit source):
//  - e.interval is in SECONDS (about 0.0167); the spec and Chrome give ms;
//  - accelerationIncludingGravity carries CoreMotion's sign (upright portrait: y about -9.8; W3C: +9.8);
//  - rotationRate alpha / beta / gamma are filled in x / y / z order, not the spec's z / x / y;
//  - events are polled from CoreMotion by a 60 Hz timer, so the same sample can arrive twice;
//  - Event.timeStamp has 1 ms resolution and is set when the event is created on the main thread.
// None of this is assumed: the sign comes from the still-1 gravity, the axis order from the vision rotation
// (detectGyroMapping), and repeats are counted and dropped.

import { integrateGyro, rotResidual, eventTimes } from './solver.js';

export const DEG = Math.PI / 180;
export const ROT_NAMES = Object.freeze(['alpha', 'beta', 'gamma']);
/** The raw per-event columns the page logs, in this order. */
export const MOTION_COLUMNS = Object.freeze(['timeStamp', 'now', 'interval', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'alpha', 'beta', 'gamma']);
export const NORMALISE_LIMITS = Object.freeze({ minGap: 0.0002, gapMs: 25, gMin: 9.3, gMax: 10.3, uprightFrac: 0.8 });

const toNum = (v) => (typeof v === 'number' ? v : v === null || v === undefined ? NaN : Number(v));
const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
const col = (raw, name) => (raw && raw[name] && typeof raw[name].length === 'number' ? raw[name] : []);

function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
function meanSd(a) {
  if (!a.length) return { mean: NaN, sd: NaN };
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, a.length - 1));
  return { mean, sd };
}

/**
 * Normalise the raw devicemotion log.
 *
 * Times and repeats: t = timeStamp / 1000 (or the handler's performance.now() when timeStamp is on another
 * clock); exact repeats (all 9 values equal to the previous event) are dropped and counted; then events not
 * later than the previous kept one by more than 0.2 ms are dropped; gaps over 25 ms are counted.
 * Units: rotationRate deg/s -> rad/s; acceleration stays in m/s^2.
 * Sign: s = sign(mean y of accelerationIncludingGravity over still-1); both acceleration vectors are
 * multiplied by s, so the solver always gets W3C specific force.
 * Refuses (ok: false) when |g| is outside 9.3-10.3 m/s^2 or |g_y| < 0.8 |g| (not upright).
 *
 * @param {object} raw  { n?, timeStamp, now, interval, ax, ay, az, gx, gy, gz, alpha, beta, gamma } arrays
 *        (typed arrays, or plain arrays with null for a missing value after a JSON round trip)
 * @param {{ stillMs?: [number, number] | null }} [opts]  still-1 window on the performance.now clock (ms)
 * @returns {{ ok: boolean, reason?: string, events: object[], stats: object }}
 */
export function normaliseMotion(raw, { stillMs = null } = {}) {
  const ts = col(raw, 'timeStamp');
  const nowA = col(raw, 'now');
  const n = Math.min(Number.isFinite(toNum(raw && raw.n)) ? toNum(raw.n) : ts.length, ts.length);
  const C = MOTION_COLUMNS.slice(3).map((k) => col(raw, k));
  const stats = { nRaw: n };
  if (n < 10) return { ok: false, reason: 'no_motion', events: [], stats };

  // Which clock: Event.timeStamp is a DOMHighResTimeStamp in current engines; an epoch-ms timeStamp (old
  // engines) would be ~1.7e12 away from performance.now().
  const lags = [];
  for (let i = 0; i < n; i++) {
    const d = toNum(nowA[i]) - toNum(ts[i]);
    if (Number.isFinite(d)) lags.push(d);
  }
  lags.sort((a, b) => a - b);
  const lag = quantile(lags, 0.5);
  const timeBase = Number.isFinite(lag) && Math.abs(lag) < 1000 ? 'timeStamp' : 'now';
  const tOf = (i) => (timeBase === 'timeStamp' ? toNum(ts[i]) : toNum(nowA[i])) / 1000;
  stats.timeBase = timeBase;
  stats.timeStampLagMs = lag;

  // Delivery timing (all raw events, before any dropping).
  const dts = [];
  for (let i = 1; i < n; i++) {
    const d = (tOf(i) - tOf(i - 1)) * 1000;
    if (Number.isFinite(d)) dts.push(d);
  }
  const dsorted = [...dts].sort((a, b) => a - b);
  const ms = meanSd(dts);
  stats.dtMeanMs = ms.mean;
  stats.dtSdMs = ms.sd;
  stats.dtP95Ms = quantile(dsorted, 0.95);
  stats.dtMaxMs = dsorted.length ? dsorted[dsorted.length - 1] : NaN;
  const intervals = [];
  const intA = col(raw, 'interval');
  for (let i = 0; i < n; i++) if (Number.isFinite(toNum(intA[i]))) intervals.push(toNum(intA[i]));
  intervals.sort((a, b) => a - b);
  stats.intervalRaw = quantile(intervals, 0.5);
  stats.intervalUnit = !Number.isFinite(stats.intervalRaw) ? 'none' : stats.intervalRaw < 1 ? 's' : 'ms';
  const span = tOf(n - 1) - tOf(0);
  stats.rawHz = span > 0 ? (n - 1) / span : NaN;

  // Repeats, non-increasing times, nulls.
  let repeats = 0;
  let notLater = 0;
  let nullRot = 0;
  let nullAccG = 0;
  let nullAcc = 0;
  const keep = [];
  let lastT = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = C.map((c) => toNum(c[i]));
    if (!(Number.isFinite(v[6]) && Number.isFinite(v[7]) && Number.isFinite(v[8]))) nullRot++;
    if (!(Number.isFinite(v[3]) && Number.isFinite(v[4]) && Number.isFinite(v[5]))) nullAccG++;
    if (!(Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]))) nullAcc++;
    if (i > 0) {
      let rep = true;
      for (let k = 0; k < 9 && rep; k++) rep = same(v[k], toNum(C[k][i - 1]));
      if (rep) {
        repeats++;
        continue;
      }
    }
    const t = tOf(i);
    if (!Number.isFinite(t)) continue;
    if (!(t > lastT + NORMALISE_LIMITS.minGap)) {
      notLater++;
      continue;
    }
    lastT = t;
    keep.push(i);
  }
  let gaps = 0;
  for (let j = 1; j < keep.length; j++) if ((tOf(keep[j]) - tOf(keep[j - 1])) * 1000 > NORMALISE_LIMITS.gapMs) gaps++;
  Object.assign(stats, { repeats, repeatsPct: (100 * repeats) / n, notLater, gaps25: gaps, nullRot, nullAccG, nullAcc, nKept: keep.length });
  const keptSpan = keep.length > 1 ? tOf(keep[keep.length - 1]) - tOf(keep[0]) : NaN;
  stats.hz = keptSpan > 0 ? (keep.length - 1) / keptSpan : NaN;
  // A frozen sensor repeats one sample for ever: say so rather than fail a later check on a handful of events.
  if (keep.length < 30) return { ok: false, reason: repeats > keep.length ? 'repeated_samples' : 'few_events', events: [], stats };

  // Accelerometer sign from the still-1 gravity (raw indices whose handler time lies in the window).
  let still = [];
  if (stillMs) for (const i of keep) if (toNum(nowA[i]) >= stillMs[0] && toNum(nowA[i]) <= stillMs[1]) still.push(i);
  stats.stillSource = still.length >= 5 ? 'still1' : 'first_events';
  if (still.length < 5) still = keep.slice(0, 60);
  const gm = [0, 0, 0];
  let ng = 0;
  for (const i of still) {
    const g = [toNum(C[3][i]), toNum(C[4][i]), toNum(C[5][i])];
    if (!g.every(Number.isFinite)) continue;
    for (let a = 0; a < 3; a++) gm[a] += g[a];
    ng++;
  }
  if (!ng) return { ok: false, reason: 'no_gravity', events: [], stats };
  for (let a = 0; a < 3; a++) gm[a] /= ng;
  const s = gm[1] < 0 ? -1 : 1;
  const gStill = gm.map((v) => v * s);
  const gNorm = Math.hypot(...gStill);
  Object.assign(stats, { accelSign: s, gStill, gNorm, tiltDeg: (Math.acos(Math.min(1, Math.abs(gStill[1]) / gNorm)) * 180) / Math.PI, nStill: ng });

  const events = [];
  for (const i of keep) {
    const v = C.map((c) => toNum(c[i]));
    events.push({
      ts: tOf(i),
      acc: [s * v[0], s * v[1], s * v[2]],
      accG: [s * v[3], s * v[4], s * v[5]],
      rotRaw: [v[6] * DEG, v[7] * DEG, v[8] * DEG],
    });
  }
  if (!(gNorm >= NORMALISE_LIMITS.gMin && gNorm <= NORMALISE_LIMITS.gMax)) return { ok: false, reason: 'gravity_out_of_range', events, stats };
  if (!(Math.abs(gStill[1]) >= NORMALISE_LIMITS.uprightFrac * gNorm)) return { ok: false, reason: 'not_upright', events, stats };
  return { ok: true, events, stats };
}

// ------------------------------------------------------------------------------------------------ gyro axes
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/** 'x=+beta y=+gamma z=+alpha' for perm [1, 2, 0] and signs [1, 1, 1]. */
export function mappingLabel(perm, signs) {
  return ['x', 'y', 'z'].map((ax, i) => `${ax}=${signs[i] < 0 ? '-' : '+'}${ROT_NAMES[perm[i]]}`).join(' ');
}
/** The inverse of mappingLabel; null for anything else. */
export function parseGyroMapping(label) {
  if (typeof label !== 'string') return null;
  const m = label.trim().match(/^x=([+-])(alpha|beta|gamma)\s+y=([+-])(alpha|beta|gamma)\s+z=([+-])(alpha|beta|gamma)$/);
  if (!m) return null;
  const perm = [m[2], m[4], m[6]].map((nme) => ROT_NAMES.indexOf(nme));
  if (new Set(perm).size !== 3) return null;
  const signs = [m[1], m[3], m[5]].map((c) => (c === '-' ? -1 : 1));
  return { ok: true, perm, signs, label: mappingLabel(perm, signs) };
}
/** Device-frame rotation rate x, y, z (rad/s) from an event's [alpha, beta, gamma]. */
export function applyGyroMapping(events, mapping) {
  const { perm, signs } = mapping;
  return events.map((e) => ({
    ts: e.ts,
    acc: e.acc,
    accG: e.accG,
    rot: [signs[0] * e.rotRaw[perm[0]], signs[1] * e.rotRaw[perm[1]], signs[2] * e.rotRaw[perm[2]]],
  }));
}

/**
 * Which of the 48 signed axis permutations turns [alpha, beta, gamma] into device x, y, z: for each, integrate
 * the gyro and compare with the vision rotations (rotResidual, at a nominal camera-IMU offset). The smallest
 * residual wins; `ratio` = runner-up / best should be much greater than 1.
 *
 * @param {object[]} poses  solver.visionPoses output
 * @param {object[]} events normaliseMotion events (rotRaw in rad/s)
 * @param {{ delta?: number }} [opts]
 * @returns {{ ok: boolean, reason?: string, perm, signs, label, resid, ratio, runnerUp, top: object[] }}
 */
export function detectGyroMapping(poses, events, { delta = -0.02 } = {}) {
  const evs = [];
  for (const e of events || []) {
    if (!e || !Number.isFinite(e.ts) || !e.rotRaw || !e.rotRaw.every(Number.isFinite)) continue;
    if (evs.length && !(e.ts > evs[evs.length - 1].ts)) continue;
    evs.push(e);
  }
  if (!Array.isArray(poses) || poses.length < 10) return { ok: false, reason: 'few_frames' };
  if (evs.length < 30) return { ok: false, reason: 'few_events' };
  const inside = poses.filter((p) => p.t + delta > evs[0].ts && p.t + delta < evs[evs.length - 1].ts);
  if (inside.length < 10) return { ok: false, reason: 'no_overlap' };
  const te = eventTimes(evs, 'raw');
  const work = evs.map(() => ({ rot: [0, 0, 0] }));
  const zero = [0, 0, 0];
  const all = [];
  for (const perm of PERMS)
    for (let sbits = 0; sbits < 8; sbits++) {
      const signs = [sbits & 1 ? -1 : 1, sbits & 2 ? -1 : 1, sbits & 4 ? -1 : 1];
      for (let i = 0; i < evs.length; i++) {
        const r = evs[i].rotRaw;
        const w = work[i].rot;
        w[0] = signs[0] * r[perm[0]];
        w[1] = signs[1] * r[perm[1]];
        w[2] = signs[2] * r[perm[2]];
      }
      const Rg = integrateGyro(work, te, zero);
      const resid = rotResidual(inside, work, te, Rg, zero, delta).resid;
      all.push({ perm, signs, label: mappingLabel(perm, signs), resid });
    }
  all.sort((a, b) => a.resid - b.resid);
  const best = all[0];
  const second = all[1];
  return {
    ok: Number.isFinite(best.resid),
    perm: best.perm,
    signs: best.signs,
    label: best.label,
    resid: best.resid,
    rmsDeg: (Math.sqrt(best.resid / (3 * inside.length)) * 180) / Math.PI,
    ratio: second.resid / Math.max(best.resid, 1e-300),
    runnerUp: second.label,
    top: all.slice(0, 4).map((m) => ({ label: m.label, resid: m.resid })),
  };
}

// ------------------------------------------------------------------------------------------------ diagnostics
/**
 * Noise floor of a still run (phone braced): per-axis sd of the specific force (m/s^2) and of the rotation
 * rate (deg/s), the mean rate (= gyro bias, deg/s), and per-coordinate sd of the corners (px) with their lag-1
 * autocorrelation (white noise ~0, slowly varying ~1). Linear trends are removed first.
 * @param {object[]} events  mapped events { ts, accG, rot }
 * @param {{ t: number, corners: object[] }[]} frames
 * @param {string} [gyroAxes]  what rot's three components are ('x/y/z' device axes, or 'alpha/beta/gamma'
 *        when the gyro mapping could not be determined); carried into the result
 */
export function noiseFloor(events, frames, gyroAxes = 'x/y/z') {
  const detrendSd = (ts, ys) => {
    const n = ys.length;
    if (n < 3) return { sd: NaN, lag1: NaN, mean: NaN };
    const tm = ts.reduce((a, b) => a + b, 0) / n;
    const ym = ys.reduce((a, b) => a + b, 0) / n;
    let stt = 0;
    let sty = 0;
    for (let i = 0; i < n; i++) {
      stt += (ts[i] - tm) ** 2;
      sty += (ts[i] - tm) * (ys[i] - ym);
    }
    const b = stt > 0 ? sty / stt : 0;
    const r = ys.map((y, i) => y - ym - b * (ts[i] - tm));
    const v = r.reduce((a, x) => a + x * x, 0) / (n - 1);
    let c = 0;
    for (let i = 1; i < n; i++) c += r[i] * r[i - 1];
    return { sd: Math.sqrt(v), lag1: v > 0 ? c / (n - 1) / v : NaN, mean: ym };
  };
  const out = { nEvents: events.length, nFrames: frames.length, gyroAxes };
  const te = events.map((e) => e.ts);
  out.accSd = [0, 1, 2].map((a) => detrendSd(te, events.map((e) => e.accG[a])).sd);
  const gyro = [0, 1, 2].map((a) => detrendSd(te, events.map((e) => e.rot[a] / DEG)));
  out.gyroSdDegS = gyro.map((g) => g.sd);
  out.gyroMeanDegS = gyro.map((g) => g.mean);
  const tf = frames.map((f) => f.t);
  const cs = [];
  for (let c = 0; c < 4; c++)
    for (const k of ['x', 'y']) cs.push(detrendSd(tf, frames.map((f) => f.corners[c][k])));
  out.cornerSdPx = cs.map((c) => c.sd);
  out.cornerSdMeanPx = cs.reduce((a, c) => a + c.sd, 0) / cs.length;
  out.cornerLag1Mean = cs.reduce((a, c) => a + c.lag1, 0) / cs.length;
  return out;
}

/** A tap's frame jump must be at least this many times the window's median jump to count as the tap. */
export const TAP_JUMP_STANDOUT = 3;

/**
 * Camera-IMU time offset from sharp taps (Tap-sync mode): in each window, the IMU spike time (first sample
 * whose change of the specific-force vector reaches half the window's biggest change) and the frame with the biggest
 * tracker jump. offset = t_imu - t_frame, the same sense as the solver's delta (IMU = vision + delta).
 * Resolution: about one frame (33 ms) and one motion sample (17 ms).
 * `frames` must include the frames the tracker FLAGGED: a tap that shakes the picture by more than the
 * tracker's 8 px limit flags its own frame. ok needs an IMU spike (> 2 m/s^2) and a frame jump that stands out
 * (>= TAP_JUMP_STANDOUT x the window's median jump); otherwise the biggest jump is just tracking noise.
 * @param {object[]} events  normalised events { ts, accG }
 * @param {{ t: number, jumpPx: number }[]} frames  every tracked frame with a jump, flagged or not
 * @param {[number, number][]} windows  in s, same clock
 */
export function tapSyncOffsets(events, frames, windows) {
  const out = [];
  for (const [w0, w1] of windows || []) {
    const ev = events.filter((e) => e.ts >= w0 && e.ts <= w1);
    const fr = frames.filter((f) => f.t >= w0 && f.t <= w1 && Number.isFinite(f.jumpPx));
    if (ev.length < 3 || fr.length < 3) {
      out.push({ ok: false, window: [w0, w1] });
      continue;
    }
    const jumps = [];
    for (let i = 1; i < ev.length; i++) jumps.push(Math.hypot(ev[i].accG[0] - ev[i - 1].accG[0], ev[i].accG[1] - ev[i - 1].accG[1], ev[i].accG[2] - ev[i - 1].accG[2]));
    const peak = Math.max(...jumps);
    const iSpike = jumps.findIndex((j) => j >= 0.5 * peak) + 1;
    let fBest = fr[0];
    for (const f of fr) if (f.jumpPx > fBest.jumpPx) fBest = f;
    const js = fr.map((f) => f.jumpPx).sort((a, b) => a - b);
    const jumpMedianPx = quantile(js, 0.5);
    const standsOut = fBest.jumpPx >= TAP_JUMP_STANDOUT * jumpMedianPx && fBest.jumpPx > 0;
    out.push({
      ok: peak > 2 && standsOut,
      reason: peak > 2 ? (standsOut ? null : 'no_frame_jump') : 'no_imu_spike',
      window: [w0, w1],
      tImu: ev[iSpike].ts,
      peakMs2: peak,
      tFrame: fBest.t,
      jumpPx: fBest.jumpPx,
      jumpMedianPx,
      offsetMs: (ev[iSpike].ts - fBest.t) * 1000,
    });
  }
  return out;
}
