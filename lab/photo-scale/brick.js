// Door size from the brick courses beside it, in ONE photo with the opening's four corners.
// Pure: no DOM, no globals, safe under Node. Ported from the research scripts scale-cues/scripts/period.py,
// sim_brick.py (rectify, strip_profile, harmonic_period) and real_brick.py (the band loop, agreement and
// course hypotheses).
//
// HOW
//   The corners give the door plane up to scale, in door heights: u right, v down, the opening [0, woh] x [0, 1]
//   (planeToImageFor(corners, woh, 1)). Strips 0.1 door heights wide beside the opening are resampled at
//   1500 samples per door height; the mean |d luma / dv| across each strip peaks at every bed joint, and a
//   harmonic-sum periodogram finds the course period p (door heights per course). Bands that agree vote, the
//   final period comes from their mean profile, and H = course / p.
//   A brick face standing d mm in front of the frame (the reveal) is nearer the camera, so its courses look
//   bigger on the door plane by Z / (Z - d) (Z = camera-to-door-plane distance = H Zu). Exactly:
//     c / p = H (Z - d) / Z  =>  H = c / p + d / Zu.
//   W = H / aspect. The course size c is a regional hypothesis (AU 86 mm by default); every one is shown.
//
// The periodogram is the slow part (about 8 M multiply-adds a band). brickSteps is a generator that yields
// after each band, so a page can run it in setTimeout chunks (runBrickSync runs it straight through).

import { planeToImageFor, classifyStandard, sigmaLnScaleFromP90 } from '../../js/estimate.js';
import { sampleBilinear } from '../../js/vision.js';

/** Samples per door height along v. */
export const SPU = 1500;
/** Columns across each band. */
export const NU = 30;
/** v range of a band (door heights). */
export const V0 = 0.02;
export const V1 = 0.98;
/** Bands: for each side, k = 0..13, lo = 0.03 + 0.05 k from the opening's edge, 0.1 wide. */
export const BAND_FIRST = 0.03;
export const BAND_STEP = 0.05;
export const BAND_COUNT = 14;
export const BAND_WIDTH = 0.1;
/** A band is used when at least this fraction of its rows fall inside the photo. */
export const MIN_VALID = 0.6;
/** Course periods searched: 55-190 mm courses on 1700-2700 mm doors, in samples. */
export const PMIN = (55 / 2700) * SPU;
export const PMAX = (190 / 1700) * SPU;
export const GRID = 1500;
export const FINE = 400;
export const FINAL_GRID = 800;
/** A band is strong above this peak / median power. */
export const STRONG_SCORE = 25;
/** Strong bands agree within this of their median period. */
export const AGREE_FRAC = 0.04;
/** Agreeing bands needed for an answer. */
export const MIN_AGREE = 3;
/**
 * Left vs right, and top vs bottom, periods may differ by at most this (%). A corner in the wrong place skews
 * the rectified plane, so the halves read different periods (a top-left dot 40 px off reads 12 % apart); the
 * research's real brick photos stayed within 4 %. Tune it from the exported agreement figures.
 */
export const HALVES_MAX_PCT = 5;
/** The opening heights the regional course may give, mm. */
export const HEIGHT_GATE_MM = Object.freeze([1900, 2500]);
/** Catalogue snap with a brick size: its scale is taken as good to 5 % p90. */
export const BRICK_SNAP_P90_PERCENT = 5;

/** Course heights (brick + bed joint), mm. */
export const COURSES = Object.freeze([
  { id: 'AU86', label: 'AU standard 86', mm: 86 },
  { id: 'UK75', label: 'UK 75', mm: 75 },
  { id: 'US67.7', label: 'US modular 67.7', mm: 67.7 },
  { id: 'USQ81.3', label: 'US queen 81.3', mm: 81.3 },
  { id: 'AU100', label: 'AU modular 100', mm: 100 },
  { id: 'AU60', label: 'AU linear 60', mm: 60 },
  { id: 'BLOCK200', label: 'block 200', mm: 200 },
]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------------------------------------
// Statistics helpers (local: brick.js stays standalone)
// ---------------------------------------------------------------------------------------------------------

function medianOf(values) {
  const a = Array.from(values).filter(isNum).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------------------------------------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------------------------------------

/**
 * The 28 bands beside an opening woh door heights wide.
 * @param {number} woh  width over height
 * @returns {Array<{ side: 'L'|'R', k: number, u0: number, u1: number }>}
 */
export function bandList(woh) {
  const out = [];
  for (const side of ['L', 'R']) {
    for (let k = 0; k < BAND_COUNT; k++) {
      const lo = BAND_FIRST + BAND_STEP * k;
      const [u0, u1] = side === 'L' ? [-(lo + BAND_WIDTH), -lo] : [woh + lo, woh + lo + BAND_WIDTH];
      out.push({ side, k, u0, u1 });
    }
  }
  return out;
}

/**
 * Mean |delta-v luma| across a strip of the door plane. Samples outside the photo (or behind the camera) are
 * invalid; a row with fewer than half its columns valid is NaN.
 *
 * @param {{ data: ArrayLike<number>, width: number, height: number }} luma  getLuma(photo)
 * @param {number[]} P  planeToImageFor(corners, woh, 1): door-plane (u, v) in door heights -> image px
 * @param {number} u0
 * @param {number} u1
 * @param {number} [v0]
 * @param {number} [v1]
 * @param {number} [spu]
 * @param {number} [nu]
 * @returns {{ prof: Float64Array, valid: Float64Array, validFrac: number }}  prof and valid have one entry per
 *   pair of neighbouring rows; validFrac is the share of those with at least half their columns valid
 */
export function stripProfile(luma, P, u0, u1, v0 = V0, v1 = V1, spu = SPU, nu = NU) {
  const n = Math.max(0, Math.round((v1 - v0) * spu));
  const rows = Math.max(0, n - 1);
  const sum = new Float64Array(rows);
  const cnt = new Float64Array(rows);
  const col = new Float64Array(n);
  const w = luma.width;
  const h = luma.height;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = P;
  // Points on the camera's side share the sign of the projective w at the opening's centre (as warpToRect).
  const uc = (u0 + u1) / 2;
  const wSign = h6 * uc + h7 * 0.5 + h8 < 0 ? -1 : 1;
  for (let j = 0; j < nu; j++) {
    const u = nu === 1 ? u0 : u0 + ((u1 - u0) * j) / (nu - 1);
    for (let i = 0; i < n; i++) {
      const v = v0 + i / spu;
      const W = h6 * u + h7 * v + h8;
      if (!(W * wSign > 1e-12)) {
        col[i] = NaN;
        continue;
      }
      const x = (h0 * u + h1 * v + h2) / W;
      const y = (h3 * u + h4 * v + h5) / W;
      col[i] = x >= 0.5 && x <= w - 0.5 && y >= 0.5 && y <= h - 0.5 ? sampleBilinear(luma, x - 0.5, y - 0.5) : NaN;
    }
    for (let i = 0; i < rows; i++) {
      const g = Math.abs(col[i + 1] - col[i]);
      if (g === g) {
        sum[i] += g;
        cnt[i] += 1;
      }
    }
  }
  const prof = new Float64Array(rows);
  const valid = new Float64Array(rows);
  let good = 0;
  for (let i = 0; i < rows; i++) {
    valid[i] = cnt[i] / nu;
    if (valid[i] >= 0.5) {
      prof[i] = sum[i] / cnt[i];
      good++;
    } else prof[i] = NaN;
  }
  return { prof, valid, validFrac: rows ? good / rows : 0 };
}

// ---------------------------------------------------------------------------------------------------------
// Harmonic-sum periodogram
// ---------------------------------------------------------------------------------------------------------

/**
 * |DFT of y at f cycles per sample|^2, with sin/cos by recurrence.
 * @param {Float64Array} y
 * @param {number} f
 */
export function dftPower(y, f) {
  const wv = 2 * Math.PI * f;
  const c = Math.cos(wv);
  const s = Math.sin(wv);
  let cr = 1;
  let ci = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < y.length; i++) {
    const v = y[i];
    re += v * cr;
    im -= v * ci;
    const t = cr * c - ci * s;
    ci = ci * c + cr * s;
    cr = t;
  }
  return re * re + im * im;
}

/**
 * The windowed signal the periodogram sees: subtract the nan-mean, NaN to 0, Hann window.
 * @param {ArrayLike<number>} prof
 */
export function prepareProfile(prof) {
  const n = prof.length;
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const v = prof[i];
    if (isNum(v)) {
      s += v;
      c++;
    }
  }
  const mean = c ? s / c : 0;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = prof[i];
    const hann = n > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) : 1;
    y[i] = isNum(v) ? (v - mean) * hann : 0;
  }
  return y;
}

function harmonicSum(y, period, nharm) {
  let p = 0;
  for (let h = 1; h <= nharm; h++) {
    const f = h / period;
    if (f >= 0.5) continue;
    p += dftPower(y, f);
  }
  return p;
}

/**
 * The period (in samples) with the most power in its first `nharm` harmonics, over periods log-spaced in
 * [pmin, pmax], refined over +-2 grid steps. score = refined peak power / median power over the grid.
 *
 * @param {ArrayLike<number>} prof
 * @param {number} pmin
 * @param {number} pmax
 * @param {{ nharm?: number, ngrid?: number, nfine?: number, refine?: number }} [opts]
 * @returns {{ period: number, score: number }}  period NaN and score 0 for an empty or flat profile
 */
export function harmonicPeriod(prof, pmin, pmax, { nharm = 3, ngrid = GRID, nfine = FINE, refine = 2 } = {}) {
  const y = prepareProfile(prof);
  if (y.length < 4 || !(pmin > 0) || !(pmax > pmin)) return { period: NaN, score: 0 };
  const lmin = Math.log(pmin);
  const step = (Math.log(pmax) - lmin) / (ngrid - 1);
  const periods = new Float64Array(ngrid);
  const P = new Float64Array(ngrid);
  let k = 0;
  for (let i = 0; i < ngrid; i++) {
    periods[i] = Math.exp(lmin + step * i);
    P[i] = harmonicSum(y, periods[i], nharm);
    if (P[i] > P[k]) k = i;
  }
  const lo = periods[Math.max(k - refine, 0)];
  const hi = periods[Math.min(k + refine, ngrid - 1)];
  let best = periods[k];
  let bestP = -Infinity;
  for (let i = 0; i < nfine; i++) {
    const per = nfine === 1 ? lo : lo + ((hi - lo) * i) / (nfine - 1);
    const pw = harmonicSum(y, per, nharm);
    if (pw > bestP) {
      best = per;
      bestP = pw;
    }
  }
  const med = medianOf(P);
  return { period: best, score: bestP / (med + 1e-12) };
}

// ---------------------------------------------------------------------------------------------------------
// Band loop
// ---------------------------------------------------------------------------------------------------------

/** Row-wise mean of several profiles, ignoring NaN (NaN where all are NaN). */
function meanProfile(profiles, i0, i1) {
  const n = Math.max(0, i1 - i0);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (const p of profiles) {
      const v = p[i0 + i];
      if (v === v) {
        s += v;
        c++;
      }
    }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

/**
 * The brick search, one band per step. Yields { done, total } after each band; returns the result.
 *
 * @param {{ data: ArrayLike<number>, width: number, height: number }} luma
 * @param {Array<{x:number,y:number}>} quad  [TL, TR, BR, BL] (orderDoorQuad)
 * @param {number} woh  rectifyRectangle(quad, K).widthOverHeight
 * @returns {Generator<{done:number,total:number}, object>}
 */
export function* brickSteps(luma, quad, woh) {
  const P = planeToImageFor(quad, woh, 1);
  if (!P || !(woh > 0) || !luma || !(luma.width > 0)) return { ok: false, error: 'degenerate' };
  const list = bandList(woh);
  const bands = [];
  const profiles = [];
  for (const band of list) {
    const strip = stripProfile(luma, P, band.u0, band.u1);
    const row = { side: band.side, k: band.k, u0: band.u0, u1: band.u1, validFrac: strip.validFrac, kept: strip.validFrac >= MIN_VALID };
    if (row.kept) {
      const { period, score } = harmonicPeriod(strip.prof, PMIN, PMAX);
      row.periodUnits = period / SPU;
      row.score = score;
      profiles.push(strip.prof);
      row.profileIndex = profiles.length - 1;
      bands.push(row);
      yield { done: bands.length, total: list.length };
    } else {
      bands.push(row);
    }
  }
  return combine(bands, profiles);
}

function combine(bands, profiles) {
  const kept = bands.filter((b) => b.kept);
  const strong = kept.filter((b) => b.score > STRONG_SCORE);
  const bestScore = kept.reduce((m, b) => Math.max(m, b.score), 0);
  const out = {
    ok: true,
    found: false,
    bands: bands.map(({ profileIndex, ...b }) => ({ ...b, strong: b.kept && b.score > STRONG_SCORE, agree: false })),
    nBands: bands.length,
    nKept: kept.length,
    nStrong: strong.length,
    nAgree: 0,
    bestScore,
    medianStrongUnits: null,
    periodUnits: null,
    periodScore: null,
    left: null,
    right: null,
    top: null,
    bottom: null,
    agreeLRPct: null,
    agreeTBPct: null,
    wide: null,
    reason: null,
  };
  if (!strong.length) {
    out.reason = kept.length ? 'no_strong_band' : 'no_band_in_photo';
    return out;
  }
  const med = medianOf(strong.map((b) => b.periodUnits));
  const agree = strong.filter((b) => Math.abs(b.periodUnits / med - 1) < AGREE_FRAC);
  out.medianStrongUnits = med;
  out.nAgree = agree.length;
  const agreeSet = new Set(agree);
  out.bands = bands.map(({ profileIndex, ...b }) => ({ ...b, strong: b.kept && b.score > STRONG_SCORE, agree: agreeSet.has(b) }));
  if (!agree.length) {
    out.reason = 'no_agreement';
    return out;
  }
  const rows = profiles[0].length;
  const split = Math.round((0.5 - V0) * SPU); // first sample at v = 0.5
  const lo = 0.8 * med * SPU;
  const hi = 1.25 * med * SPU;
  const est = (sel, i0, i1) => {
    if (!sel.length || i1 - i0 < 8) return null;
    const mean = meanProfile(sel.map((b) => profiles[b.profileIndex]), i0, i1);
    const r = harmonicPeriod(mean, lo, hi, { ngrid: FINAL_GRID });
    return isNum(r.period) ? { units: r.period / SPU, score: r.score } : null;
  };
  const all = est(agree, 0, rows);
  out.found = Boolean(all);
  if (!all) {
    out.reason = 'no_period';
    return out;
  }
  out.periodUnits = all.units;
  out.periodScore = all.score;
  out.left = est(agree.filter((b) => b.side === 'L'), 0, rows);
  out.right = est(agree.filter((b) => b.side === 'R'), 0, rows);
  out.top = est(agree, 0, split - 1);
  out.bottom = est(agree, split, rows);
  if (out.left && out.right) out.agreeLRPct = Math.abs(out.left.units / out.right.units - 1) * 100;
  if (out.top && out.bottom) out.agreeTBPct = Math.abs(out.top.units / out.bottom.units - 1) * 100;
  // The combined profile over the whole search range: its own strongest period must be this one.
  const wideMean = meanProfile(agree.map((b) => profiles[b.profileIndex]), 0, rows);
  const wide = harmonicPeriod(wideMean, PMIN, PMAX);
  out.wide = { units: wide.period / SPU, score: wide.score, matches: Math.abs(wide.period / SPU / med - 1) < AGREE_FRAC };
  return out;
}

/**
 * Run brickSteps to the end (tests, workers).
 * @param {Generator} gen
 */
export function runBrickSync(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

// ---------------------------------------------------------------------------------------------------------
// Scale: course hypotheses, reveal correction, gate, catalogue snap (cheap: re-run on every setting change)
// ---------------------------------------------------------------------------------------------------------

/**
 * Whether a brick result passes the checks that do not depend on the course size: enough agreeing bands,
 * the combined profile strongly periodic with its own peak at the same period, and the left/right and
 * top/bottom halves within HALVES_MAX_PCT of each other.
 * @param {object} found  brickSteps result
 * @returns {string[]}  failed checks ([] = passed)
 */
export function brickChecks(found) {
  const failed = [];
  if (!found || !found.ok || !found.found) return ['no_brick'];
  if (found.nAgree < MIN_AGREE) failed.push('few_agreeing_bands');
  if (!found.wide || !(found.wide.score > STRONG_SCORE)) failed.push('weak_combined_score');
  else if (!found.wide.matches) failed.push('combined_peak_elsewhere');
  if (isNum(found.agreeLRPct) && found.agreeLRPct > HALVES_MAX_PCT) failed.push('left_right_disagree');
  if (isNum(found.agreeTBPct) && found.agreeTBPct > HALVES_MAX_PCT) failed.push('top_bottom_disagree');
  return failed;
}

/**
 * H for a course c, a period p (door heights) and a reveal d: c / p + d / Zu.
 * @param {number} courseMm
 * @param {number} periodUnits
 * @param {number} revealMm
 * @param {number} Zu  |dot(r3, t)|, the camera-to-plane distance in door heights
 */
export function heightFromCourse(courseMm, periodUnits, revealMm, Zu) {
  return courseMm / periodUnits + (revealMm || 0) / Zu;
}

/**
 * The inverse of heightFromCourse: the course size (mm) a period implies for an opening of height H mm,
 * p x (H - d / Zu). The brick face stands d mm nearer the camera, so its courses look bigger in door
 * heights than they would on the frame plane; p x H alone reads every course too big by p x d / Zu (about
 * 5 % for a 125 mm reveal at Zu 1.2).
 * @param {number} periodUnits  a band's (or the combined) period, door heights
 * @param {number} heightMm     the opening's height
 * @param {number} revealMm
 * @param {number} Zu
 */
export function courseFromPeriod(periodUnits, heightMm, revealMm, Zu) {
  return periodUnits * (heightMm - (revealMm || 0) / Zu);
}

/**
 * Every course hypothesis, raw and reveal-corrected, with its gate; the regional one's catalogue snap.
 *
 * @param {object} found  brickSteps result
 * @param {object} o
 * @param {number} o.Zu
 * @param {number} o.aspectHW
 * @param {number} o.revealMm
 * @param {string} [o.regionId='AU86']
 * @param {number} [o.sigmaLnAspect]
 * @param {Array<{widthMm:number,heightMm:number}>} [o.sizes]
 */
export function brickScale(found, { Zu, aspectHW, revealMm = 0, regionId = 'AU86', sigmaLnAspect, sizes } = {}) {
  const checks = brickChecks(found);
  const p = found && found.periodUnits;
  const reveal = isNum(revealMm) ? revealMm : 0;
  const hypotheses = COURSES.map((c) => {
    if (!isNum(p) || !(p > 0) || !(Zu > 0)) return { ...c, Hraw: null, Wraw: null, H: null, W: null, gateOk: false, gate: checks.length ? checks : ['no_period'] };
    const Hraw = c.mm / p;
    const H = heightFromCourse(c.mm, p, reveal, Zu);
    const gate = [...checks];
    if (!(H >= HEIGHT_GATE_MM[0] && H <= HEIGHT_GATE_MM[1])) gate.push('height_out_of_range');
    return { ...c, Hraw, Wraw: Hraw / aspectHW, H, W: H / aspectHW, gateOk: gate.length === 0, gate };
  });
  const regional = hypotheses.find((h) => h.id === regionId) || hypotheses[0];
  const snap = regional.gateOk && sigmaLnAspect > 0
    ? classifyStandard({
        aspectHW,
        sigmaLnAspect,
        estimateMm: { w: regional.W, h: regional.H },
        sigmaLnScale: sigmaLnScaleFromP90(BRICK_SNAP_P90_PERCENT),
        sizes,
      }).slice(0, 3).map(({ widthMm, heightMm, p: prob, zAspect, zScale }) => ({ widthMm, heightMm, p: prob, zAspect, zScale }))
    : [];
  return { checks, revealMm: reveal, Zu, regionId: regional.id, regional, hypotheses, snap };
}
