// Synthetic visual-inertial sweeps for the lab page's tests (tests/lab-vio.test.mjs) and for trying solver
// changes offline. Pure ES module (Node or browser), not used by the page itself.
//
// TRIMMED COPY of the Nov 2026 research simulator vi-scale/sim/vi-sim.mjs (scratchpad webscale\vi-scale\sim):
// makeTrial, makeOIS, project, simulateVision, simulateIMU, BASE (simulation keys), IDEAL and the scenarios the
// tests use, with the same random-number generator, so a seed gives the research's numbers. Changes: the frame
// size is a parameter (default the research's 1440 x 1920 portrait frame); a rotateOnly key fixes the camera centre; the solver keys of BASE live in
// solver.js DEFAULT_SETTINGS; and it can emit the raw event log a phone would produce (toRawMotion,
// synthLog), iOS-style (ms timestamps, deg/s, CoreMotion accelerometer sign, x/y/z packed into
// alpha/beta/gamma) or W3C-style.
//
// World = door frame (x right, y DOWN, z into the house, metres), door 0.82 x 2.04 m, sill on the floor.
// Camera: x right, y down, z forward. Device (W3C): x right, y up the screen, z out of the screen.

import { mm, mv, mT, expSO3, logSO3, FLIP, G, DEFAULT_SETTINGS, solve } from './solver.js';
import { DEG, parseGyroMapping } from './motion.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scl(a, 1 / len(a));

// ------------------------------------------------------------------------------------------------ random
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeRng(seed) {
  const u = mulberry32(seed);
  let spare = null;
  const g = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let x;
    let y;
    let r;
    do {
      x = 2 * u() - 1;
      y = 2 * u() - 1;
      r = x * x + y * y;
    } while (r >= 1 || r === 0);
    const m = Math.sqrt((-2 * Math.log(r)) / r);
    spare = y * m;
    return x * m;
  };
  return { u, g, uni: (a, b) => a + (b - a) * u(), g3: (s) => [s * g(), s * g(), s * g()] };
}
function smooth(rng, sigma, fmin, fmax, n = 6) {
  const f = [];
  const ph = [];
  for (let i = 0; i < n; i++) {
    f.push(rng.uni(fmin, fmax));
    ph.push(rng.uni(0, 2 * Math.PI));
  }
  const a = sigma * Math.sqrt(2 / n);
  return (t) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.sin(2 * Math.PI * f[i] * t + ph[i]);
    return a * s;
  };
}
const smootherstep = (s) => s * s * s * (s * (6 * s - 15) + 10);
function envelope(t, t1, t2, r) {
  if (t <= t1 || t >= t2) return 0;
  const s = Math.min((t - t1) / r, (t2 - t) / r, 1);
  return smootherstep(s);
}

// ------------------------------------------------------------------------------------------------ scene
export const DOOR_W = 0.82;
export const DOOR_H = 2.04;
const DOOR = [[0, 0, 0], [DOOR_W, 0, 0], [DOOR_W, DOOR_H, 0], [0, DOOR_H, 0]];
const GW = [0, G, 0];
export const IMG_W = 1440;
export const IMG_H = 1920;

/** Simulation keys of the research BASE (sources and estimates are documented in vi-sim.mjs PARAMS). */
export const BASE = Object.freeze({
  name: 'base',
  mode: 'lateral',
  distance: [1.5, 3.0],
  camHeight: [1.35, 0.1],
  sweepAmp: [0.07, 0.15],
  sweepFreq: [0.6, 1.1],
  sweepDur: [3.0, 5.0],
  still: 0.6,
  yawCoupling: [0, 1],
  rotWobbleDeg: 1.0,
  offAxisDeg: 1.5,
  wobbleY: 0.01,
  wobbleZ: 0.01,
  arcRadius: [0.4, 1.0],
  fps: 30,
  frameDrop: 0.05,
  pxWhite: 1.0,
  pxCorr: 1.0,
  pxCorrTau: 0.4,
  blurK: 0.15,
  exposure: 1 / 60,
  rollingShutter: [0.015, 0.03],
  focal35: [24, 26],
  focalAssumed: 26,
  videoFovErr: 0.02,
  capLatency: [0.01, 0.05],
  capJitter: 0.0007,
  accNoise: 160e-6 * G,
  accBias: 0.05,
  accSens: 0.004,
  accCross: 0.005,
  gyroNoise: (0.007 * Math.PI) / 180,
  gyroBias: (0.1 * Math.PI) / 180,
  leakTau: Infinity,
  tiltWalk: (0.05 * Math.PI) / 180,
  leverArm: true,
  cmRateErr: 0.005,
  timerJitter: 0.0007,
  timerLateP: 0.02,
  ipc: [0.001, 0.0005],
  mainBusy: 0,
  ois: 0,
  oisFc: 1.0,
  oisStrokeDeg: 1.0,
  perfectTiming: false,
  rotateOnly: false, // LAB: rotation only (the page's Rotate-only mode): the camera centre is fixed, or
  // turns about rotatePivot
  rotatePivot: [0, 0, 0], // LAB: with rotateOnly, the point the phone turns about, from the lens, device frame
  // (m; [0, -0.1, 0.03] is a wrist 10 cm below the lens and 3 cm behind the screen): the lens really moves

  width: IMG_W,
  height: IMG_H,
});
export const IDEAL = Object.freeze({
  accBias: 0, accSens: 0, accCross: 0, gyroBias: 0, tiltWalk: 0, leverArm: false, rollingShutter: [0, 0],
  videoFovErr: 0, focal35: [26, 26], pxCorr: 0, pxWhite: 0.5, blurK: 0, cmRateErr: 0, timerJitter: 0, timerLateP: 0,
  frameDrop: 0,
});
/** IDEAL with every noise source off as well. */
export const NOISE_FREE = Object.freeze({ ...IDEAL, pxWhite: 0, accNoise: 0, gyroNoise: 0, capJitter: 0, ipc: [0, 0] });
export const SCENARIOS = Object.freeze({
  S0: { name: 'S0 ideal: white IMU noise + 0.5 px corners, perfect timing', ...IDEAL, perfectTiming: true },
  S1: { name: 'S1 ideal + WebKit 60 Hz polling, IPC, 1 ms stamps, capture latency', ...IDEAL },
  S2: { name: 'S2 BASELINE lateral sweep (recommended solver)' },
  S10: { name: 'S10 OIS gain 0.5, high-pass 1 Hz', ois: 0.5 },
  S13: { name: 'S13 pessimistic sensors', accNoise: 320e-6 * G, accBias: 0.15, gyroBias: (0.3 * Math.PI) / 180, accSens: 0.01, accCross: 0.01, pxWhite: 2, pxCorr: 2 },
});

// ------------------------------------------------------------------------------------------------ trial
export function makeTrial(cfg, rng) {
  const F35_TO_PX = Math.hypot(cfg.width, cfg.height) / Math.hypot(36, 24);
  const D = rng.uni(...cfg.distance);
  const hc = cfg.camHeight[0] + cfg.camHeight[1] * rng.g();
  const xoff = 0.08 * rng.g();
  const C0 = [DOOR_W / 2 + xoff, DOOR_H - hc, -D];
  const aim = [DOOR_W / 2 + 0.03 * rng.g(), DOOR_H / 2 + 0.05 * rng.g(), 0];
  const zc = unit(sub(aim, C0));
  let xc = unit(cross([0, 1, 0], zc));
  let yc = cross(zc, xc);
  const roll0 = ((1.5 * Math.PI) / 180) * rng.g();
  {
    const c = Math.cos(roll0);
    const s = Math.sin(roll0);
    const xr = add(scl(xc, c), scl(yc, s));
    const yr = add(scl(xc, -s), scl(yc, c));
    xc = xr;
    yc = yr;
  }
  const Rbase = [xc[0], yc[0], zc[0], xc[1], yc[1], zc[1], xc[2], yc[2], zc[2]]; // camera -> world
  const t1 = cfg.still;
  const Ts = rng.uni(...cfg.sweepDur);
  const t2 = t1 + Ts;
  const T = t2 + cfg.still;
  const ramp = 0.4;
  const A0 = rng.uni(...cfg.sweepAmp);
  const f0 = rng.uni(...cfg.sweepFreq);
  const am = smooth(rng, 0.15, 0.1, 0.5, 4);
  const pm = smooth(rng, 0.4, 0.05, 0.4, 4);
  const ph0 = rng.uni(0, 2 * Math.PI);
  const drift = [smooth(rng, 0.015, 0.05, 0.3, 3), smooth(rng, 0.008, 0.05, 0.3, 3), smooth(rng, 0.01, 0.05, 0.3, 3)];
  const wob = [smooth(rng, cfg.wobbleY, 0.3, 2, 5), smooth(rng, cfg.wobbleZ, 0.3, 2, 5)];
  const arcR = rng.uni(...cfg.arcRadius) * (rng.u() < 0.5 ? -1 : 1);
  const sway = [0, 1, 2].map(() => smooth(rng, 0.0015, 0.1, 1.0, 4));
  const trem = [0, 1, 2].map(() => smooth(rng, 0.0001, 8, 12, 4));
  const k = rng.uni(...cfg.yawCoupling);
  const rw = (cfg.rotWobbleDeg * Math.PI) / 180;
  const rotWob = [0, 1, 2].map(() => smooth(rng, rw, 0.2, 2, 5));
  const rotSway = [0, 1, 2].map(() => smooth(rng, (0.2 * Math.PI) / 180, 0.1, 1, 4));
  const rotTrem = [0, 1, 2].map(() => smooth(rng, (0.03 * Math.PI) / 180, 8, 12, 4));
  const sweep = (t) => {
    const e = envelope(t, t1, t2, ramp);
    if (e === 0) return 0;
    return e * A0 * (1 + am(t)) * Math.sin(2 * Math.PI * f0 * (t - t1) + ph0 + pm(t));
  };
  const pivot = cfg.rotatePivot || [0, 0, 0];
  const RdwBase = mm(Rbase, FLIP);
  const pos = (t) => {
    // LAB: the Rotate-only mode: the pivot (C0 + Rdw(0) pivot) stays put, so the lens is at pivot - Rdw(t) pivot
    if (cfg.rotateOnly) return sub(add(C0, mv(RdwBase, pivot)), mv(Rdw(t), pivot));
    const e = envelope(t, t1, t2, ramp);
    const s = sweep(t);
    let dx;
    let dy;
    let dz;
    if (cfg.mode === 'lateral') {
      dx = s + e * drift[0](t);
      dy = e * (wob[0](t) + drift[1](t));
      dz = (s * s) / (2 * arcR) + e * (wob[1](t) + drift[2](t));
    } else {
      dz = s + e * drift[2](t);
      dy = e * (wob[0](t) + drift[1](t));
      dx = e * (wob[1](t) + drift[0](t));
    }
    return [C0[0] + dx + sway[0](t) + trem[0](t), C0[1] + dy + sway[1](t) + trem[1](t), C0[2] + dz + sway[2](t) + trem[2](t)];
  };
  const theta = (t) => {
    const e = envelope(t, t1, t2, ramp);
    // (Rotate-only: no sweep, so no yaw coupling; pos() needs theta() there)
    const yawCouple = cfg.mode === 'lateral' && !cfg.rotateOnly ? -k * Math.atan((pos(t)[0] - C0[0]) / D) : 0;
    return [e * rotWob[0](t) + rotSway[0](t) + rotTrem[0](t), yawCouple + e * rotWob[1](t) + rotSway[1](t) + rotTrem[1](t), e * rotWob[2](t) * 0.7 + rotSway[2](t) + rotTrem[2](t)];
  };
  const Rcw = (t) => mm(Rbase, expSO3(theta(t)));
  const Rdw = (t) => mm(Rcw(t), FLIP);
  const leverArm = cfg.leverArm ? [rng.uni(-0.01, 0.03), rng.uni(-0.07, -0.03), rng.uni(-0.005, 0.005)] : [0, 0, 0];
  const imuPos = (t) => add(pos(t), mv(Rdw(t), leverArm));
  const h = 1e-3;
  const accW = (t) => scl(add(sub(imuPos(t + h), scl(imuPos(t), 2)), imuPos(t - h)), 1 / (h * h));
  const omegaD = (t) => scl(logSO3(mm(mT(Rdw(t - h)), Rdw(t + h))), 1 / (2 * h));
  const f35 = rng.uni(...cfg.focal35);
  const fTrue = f35 * F35_TO_PX * (1 + cfg.videoFovErr * rng.g());
  const fAss = cfg.focalAssumed * F35_TO_PX;
  return { D, hc, C0, Rbase, t1, t2, T, A0, f0, k, pos, theta, Rcw, Rdw, accW, omegaD, fTrue, fAss, leverArm, Ts, f35 };
}

export function makeOIS(cfg, tr) {
  if (!cfg.ois) return () => [0, 0];
  const dt = 1e-3;
  const n = Math.ceil((tr.T + 0.5) / dt);
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const a = 1 / (1 + 2 * Math.PI * cfg.oisFc * dt);
  let px = 0;
  let py = 0;
  let hx = 0;
  let hy = 0;
  const lim = (cfg.oisStrokeDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const th = tr.theta(i * dt);
    if (i > 0) {
      hx = a * (hx + th[1] - px);
      hy = a * (hy + th[0] - py);
    }
    px = th[1];
    py = th[0];
    ax[i] = Math.max(-lim, Math.min(lim, hx));
    ay[i] = Math.max(-lim, Math.min(lim, hy));
  }
  return (t) => {
    const i = Math.max(0, Math.min(n - 1, Math.round(t / dt)));
    return [cfg.ois * tr.fTrue * ax[i], -cfg.ois * tr.fTrue * ay[i]];
  };
}

function project(cfg, tr, ois, X, t) {
  const R = tr.Rcw(t);
  const Xc = mv(mT(R), sub(X, tr.pos(t)));
  const o = ois(t);
  return { u: (tr.fTrue * Xc[0]) / Xc[2] + cfg.width / 2 + o[0], v: (tr.fTrue * Xc[1]) / Xc[2] + cfg.height / 2 + o[1], z: Xc[2] };
}

export function simulateVision(cfg, tr, rng) {
  const W = cfg.width;
  const H = cfg.height;
  const ois = makeOIS(cfg, tr);
  const rsT = rng.uni(...cfg.rollingShutter) * (rng.u() < 0.5 ? -1 : 1);
  const lat = rng.uni(...cfg.capLatency);
  const frames = [];
  const tStart = 0.05 + rng.u() / cfg.fps;
  const ou = Array.from({ length: 8 }, () => cfg.pxCorr * rng.g());
  let lastT = tStart;
  let visible = true;
  for (let kf = 0; ; kf++) {
    const e = tStart + kf / cfg.fps;
    if (e > tr.T - 0.05) break;
    const dtf = e - lastT;
    lastT = e;
    const decay = Math.exp(-dtf / cfg.pxCorrTau);
    for (let i = 0; i < 8; i++) ou[i] = ou[i] * decay + cfg.pxCorr * Math.sqrt(1 - decay * decay) * rng.g();
    const corners = [];
    for (let i = 0; i < 4; i++) {
      let p = project(cfg, tr, ois, DOOR[i], e);
      const ti = cfg.perfectTiming ? e : e + rsT * (p.u / W - 0.5);
      p = project(cfg, tr, ois, DOOR[i], ti);
      if (!(p.z > 0) || p.u < 15 || p.u > W - 15 || p.v < 15 || p.v > H - 15) visible = false;
      const p2 = project(cfg, tr, ois, DOOR[i], ti + 1e-3);
      const blur = Math.hypot(p2.u - p.u, p2.v - p.v) * 1000 * cfg.exposure;
      const sb = cfg.blurK * blur;
      corners.push({ x: p.u + cfg.pxWhite * rng.g() + ou[2 * i] + sb * rng.g(), y: p.v + cfg.pxWhite * rng.g() + ou[2 * i + 1] + sb * rng.g() });
    }
    if (rng.u() < cfg.frameDrop) continue;
    const cap = cfg.perfectTiming ? e : Math.floor((e + lat + cfg.capJitter * rng.g()) * 1000) / 1000;
    frames.push({ tCap: cap, tTrue: e, corners });
  }
  return { frames, visible, lat, rsT };
}

export function simulateIMU(cfg, tr, rng) {
  const dtCm = (1 / 60) * (1 + rng.uni(-cfg.cmRateErr, cfg.cmRateErr));
  const tCm0 = -0.3 + rng.u() * dtCm;
  const sigA = cfg.accNoise * Math.sqrt(30);
  const sigG = cfg.gyroNoise * Math.sqrt(30);
  const M = [
    1 + cfg.accSens * rng.g(), cfg.accCross * rng.g(), cfg.accCross * rng.g(),
    cfg.accCross * rng.g(), 1 + cfg.accSens * rng.g(), cfg.accCross * rng.g(),
    cfg.accCross * rng.g(), cfg.accCross * rng.g(), 1 + cfg.accSens * rng.g(),
  ];
  const ba = rng.g3(cfg.accBias);
  const bg = rng.g3(cfg.gyroBias);
  const samples = [];
  const proj = (v) => [v[0], 0, v[2]];
  let leak = null;
  for (let j = 0; ; j++) {
    const t = tCm0 + j * dtCm;
    if (t > tr.T + 0.2) break;
    const R = tr.Rdw(t);
    const aw = tr.accW(t);
    const fd = mv(mT(R), sub(aw, GW));
    const fm = add(add(mv(M, fd), ba), rng.g3(sigA));
    if (leak === null) leak = scl(proj(mv(R, ba)), -1);
    if (Number.isFinite(cfg.leakTau)) {
      const target = scl(proj(add(aw, mv(R, ba))), -1);
      leak = add(leak, scl(sub(target, leak), dtCm / cfg.leakTau));
    }
    leak = add(leak, proj(rng.g3(G * cfg.tiltWalk * Math.sqrt(dtCm))));
    const ghat = add(GW, leak);
    const user = add(fm, mv(mT(R), ghat));
    const om = add(tr.omegaD(t), add(bg, rng.g3(sigG)));
    samples.push({ t, accG: fm, acc: user, rot: om });
  }
  const events = [];
  const p0 = rng.u() / 60 - 0.25;
  let jIdx = 0;
  let blockEnd = -1;
  for (let m = 0; ; m++) {
    let p = p0 + m / 60 + Math.abs(cfg.timerJitter * rng.g());
    if (rng.u() < cfg.timerLateP) p += rng.uni(0.003, 0.015);
    if (p > tr.T + 0.1) break;
    while (jIdx + 1 < samples.length && samples[jIdx + 1].t + 0.001 <= p) jIdx++;
    const s = samples[jIdx];
    let arrive = p + Math.max(0, cfg.ipc[0] + cfg.ipc[1] * rng.g());
    if (cfg.mainBusy > 0) {
      const per = 1 / 30;
      const ph = arrive % per;
      const busy = cfg.mainBusy * per;
      if (ph < busy) arrive += busy - ph;
      if (arrive < blockEnd) arrive = blockEnd;
      blockEnd = arrive;
    }
    const ts = cfg.perfectTiming ? s.t : Math.floor(arrive * 1000) / 1000;
    events.push({ ts, accG: s.accG, acc: s.acc, rot: s.rot, tTrue: s.t });
  }
  return { events, ba, bg, dtCm };
}

/**
 * One synthetic sweep, drawn exactly as the research runTrial draws it (the door is re-drawn until it stays
 * in frame).
 * @returns {{ ok: boolean, cfg, tr, frames: {t, corners}[], events: {ts, acc, accG, rot}[], width, height,
 *   focalPx, lat }}
 */
export function synthTrial(cfgIn, seed) {
  const cfg = { ...BASE, ...cfgIn };
  const rng = makeRng(seed);
  let tr;
  let vis;
  let tries = 0;
  do {
    tr = makeTrial(cfg, rng);
    vis = simulateVision(cfg, tr, rng);
    tries++;
  } while (!vis.visible && tries < 20);
  if (!vis.visible) return { ok: false, reason: 'not_in_frame' };
  const imu = simulateIMU(cfg, tr, rng);
  return {
    ok: true,
    cfg,
    tr,
    frames: vis.frames.map((f) => ({ t: f.tCap, corners: f.corners })),
    events: imu.events,
    width: cfg.width,
    height: cfg.height,
    focalPx: tr.fAss,
    lat: vis.lat,
  };
}

/** Solve a synthetic trial directly (events already in device x/y/z, W3C sign), research style. */
export function solveSynth(cfgIn, seed, settings = {}) {
  const s = synthTrial(cfgIn, seed);
  if (!s.ok) return { ok: false, reason: s.reason };
  const res = solve({ frames: s.frames, events: s.events, width: s.width, height: s.height, focalPx: s.focalPx, refHeightM: DOOR_H, settings: { ...DEFAULT_SETTINGS, ...settings } });
  if (!res.ok) return res;
  return { ...res, errScalePct: (res.Hm / DOOR_H - 1) * 100, errWPct: (res.Wm / DOOR_W - 1) * 100, focalErr: s.tr.fAss / s.tr.fTrue - 1, trueF35: s.tr.fTrue / (s.tr.fAss / s.cfg.focalAssumed) };
}

/**
 * The raw devicemotion columns a phone would log for these events.
 * style 'ios': timeStamp ms, interval 1/60 s, CoreMotion sign (all acceleration negated), rotation in deg/s
 *              with x, y, z packed into alpha, beta, gamma;
 * style 'w3c': interval 16 ms, W3C sign, alpha = z, beta = x, gamma = y;
 * or a mapping label ('x=-gamma y=+alpha z=+beta'): rotation packed so that this label recovers it.
 */
export function toRawMotion(events, style = 'ios') {
  const n = events.length;
  const cols = {};
  for (const k of ['timeStamp', 'now', 'interval', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'alpha', 'beta', 'gamma']) cols[k] = new Float64Array(n);
  const map = style === 'ios' ? parseGyroMapping('x=+alpha y=+beta z=+gamma') : style === 'w3c' ? parseGyroMapping('x=+beta y=+gamma z=+alpha') : parseGyroMapping(style);
  if (!map) throw new Error(`unknown style ${style}`);
  const sign = style === 'w3c' ? 1 : -1;
  const names = ['alpha', 'beta', 'gamma'];
  for (let i = 0; i < n; i++) {
    const e = events[i];
    cols.timeStamp[i] = e.ts * 1000;
    cols.now[i] = e.ts * 1000 + 0.3;
    cols.interval[i] = style === 'w3c' ? 16 : 1 / 60;
    cols.ax[i] = sign * e.acc[0];
    cols.ay[i] = sign * e.acc[1];
    cols.az[i] = sign * e.acc[2];
    cols.gx[i] = sign * e.accG[0];
    cols.gy[i] = sign * e.accG[1];
    cols.gz[i] = sign * e.accG[2];
    for (let a = 0; a < 3; a++) cols[names[map.perm[a]]][i] = (map.signs[a] * e.rot[a]) / DEG;
  }
  return { n, ...cols };
}

/**
 * A page log (schema 'securemeasure-lab-vio/1') for a synthetic trial, as the page would write it.
 * @param {object} cfgIn  simulation overrides
 * @param {number} seed
 * @param {{ style?: string, frameOffsetS?: number, solver?: object, mode?: string, tapSpikeMs2?: number }} [opts]
 *        frameOffsetS is added to every frame time (a camera-IMU offset). mode names the phases as the page
 *        does: 'sweep' (still1 / sweep / still2), 'rotate' (still1 / rotate / still2), 'still' (still10 over the
 *        whole run) or 'tapsync' (still1 / tap1 / sweep / still2 / tap2; needs cfg.still >= 1.5: taps at
 *        0.5 s and at the sweep's end + still / 2 + 0.25 s, each adding tapSpikeMs2 to device x of one motion
 *        sample, the unbalanced sample WebKit's 60 Hz polling leaves of a sharp tap)
 */
export function synthLog(cfgIn, seed, { style = 'ios', frameOffsetS = 0, solver = {}, mode = 'sweep', tapSpikeMs2 = 0 } = {}) {
  const s = synthTrial(cfgIn, seed);
  if (!s.ok) return null;
  const nF = s.frames.length;
  const frames = { n: nF, now: [], captureTime: [], presentationTime: [], expectedDisplayTime: [], presentedFrames: [], mediaTime: [], width: [], height: [], status: [] };
  const tracker = { quad: [], ok: [], ms: [], jumpPx: [], flagged: [] };
  s.frames.forEach((f, i) => {
    const tms = (f.t + frameOffsetS) * 1000;
    frames.now.push(tms + 25);
    frames.captureTime.push(tms);
    frames.presentationTime.push(tms + 20);
    frames.expectedDisplayTime.push(tms + 36);
    frames.presentedFrames.push(i + 1);
    frames.mediaTime.push(f.t);
    frames.width.push(s.width);
    frames.height.push(s.height);
    frames.status.push(0);
    for (const c of f.corners) tracker.quad.push(c.x, c.y);
    tracker.ok.push(1);
    tracker.ms.push(10);
    tracker.jumpPx.push(0.5);
    tracker.flagged.push(0);
  });
  const raw = toRawMotion(s.events, style);
  const motion = { n: raw.n };
  for (const [k, v] of Object.entries(raw)) if (k !== 'n') motion[k] = Array.from(v);
  const t1 = s.tr.t1 * 1000;
  const t2 = s.tr.t2 * 1000;
  const T = s.tr.T * 1000;
  let phases;
  let taps = [];
  if (mode === 'rotate') phases = [{ name: 'still1', t0: 0, t1 }, { name: 'rotate', t0: t1, t1: t2 }, { name: 'still2', t0: t2, t1: T }];
  else if (mode === 'still') phases = [{ name: 'still10', t0: 0, t1: T }];
  else if (mode === 'tapsync') {
    if (!(s.cfg.still >= 1.5)) throw new Error('tapsync needs cfg.still >= 1.5');
    const mid2 = t2 + (T - t2) / 2;
    phases = [
      { name: 'still1', t0: 0, t1: 300 },
      { name: 'tap1', t0: 300, t1 },
      { name: 'sweep', t0: t1, t1: t2 },
      { name: 'still2', t0: t2, t1: mid2 },
      { name: 'tap2', t0: mid2, t1: T },
    ];
    taps = [{ phase: 'tap1', at: 500 }, { phase: 'tap2', at: mid2 + 250 }];
    const sign = style === 'w3c' ? 1 : -1;
    for (const tap of taps) {
      let k = 0;
      while (k < motion.n && motion.timeStamp[k] < tap.at) k++;
      if (k < motion.n) motion.gx[k] += sign * tapSpikeMs2;
    }
  } else phases = [{ name: 'still1', t0: 0, t1 }, { name: 'sweep', t0: t1, t1: t2 }, { name: 'still2', t0: t2, t1: T }];
  return {
    schema: 'securemeasure-lab-vio/1',
    mode,
    synthetic: { seed, cfg: cfgIn, trueH: DOOR_H, trueW: DOOR_W, lat: s.lat, fTrue: s.tr.fTrue, fAss: s.tr.fAss },
    env: { trackSize: { w: s.width, h: s.height }, focal: { f35: s.cfg.focalAssumed, source: 'prior' } },
    settings: { solver: { ...DEFAULT_SETTINGS, ...solver } },
    truth: { doorId: `synth-${seed}`, tapeW: DOOR_W * 1000, tapeH: DOOR_H * 1000 },
    phases,
    taps,
    motion,
    frames,
    tracker,
  };
}
