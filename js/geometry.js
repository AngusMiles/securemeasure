// Plane geometry for SecureMeasure: homographies, quad helpers and the joint door measurement.
//
// Pure module: no DOM, no globals, safe to import under Node.
//
// The measurement idea: the reference sheet and the door opening lie in one plane. The sheet has a known
// size (metric scale) but is small; the door opening is big (pins down perspective) but has unknown size.
// measureDoor() fits ONE plane-to-image homography to all eight marked corners at once, with the door
// modelled as a W x H rectangle and the sheet as a rigid rectangle of known size somewhere on the plane.

/** @typedef {{x:number, y:number}} Point */
/** @typedef {Point[]} Quad four points [TL, TR, BR, BL] in image pixels (x right, y down) */
/** @typedef {number[]} Homography row-major 3x3, length 9 */

/**
 * Numeric thresholds behind `quality.issues` and `quality.level` in {@link measureDoor}.
 * Lengths are millimetres unless the name says otherwise.
 */
export const QUALITY_THRESHOLDS = Object.freeze({
  /** 'sheet_small': shortest marked sheet side, px. */
  sheetMinSidePx: 60,
  /** 'steep_angle': longer / shorter of two opposite door sides, in px. */
  steepAngleRatio: 1.25,
  /** 'high_residual': chi-square per degree of freedom of the joint fit (3 dof). */
  highResidualChi2PerDof: 8,
  /** 'methods_disagree': joint vs sheet-only difference, in combined standard deviations ... */
  disagreeSigmas: 5,
  /** ... and it must also exceed this many mm, so trivial differences never count. */
  disagreeMinMm: 5,
  /** 'door_near_edge': a door corner closer to the image border than this fraction of the image size. */
  edgeMarginFrac: 0.02,
  /** 'door_small': door height in px as a fraction of the image height. */
  doorMinHeightFrac: 0.45,
  /** level 'good' needs both sigmas at or below this. */
  goodSigmaMm: 4,
  /** 'high_uncertainty': a sigma above this. */
  highUncertaintySigmaMm: 8,
  /** level 'poor': a sigma above this. */
  poorSigmaMm: 10,
  /**
   * Portrait-vs-landscape choice for the sheet: below this score margin (fit.orientationMargin) the
   * choice is unsafe, and half the gap between the two possible answers is folded into the sigmas.
   */
  orientationMinMargin: 2,
});

const DEFAULT_PLAUSIBLE = Object.freeze({ minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 });

/** Issues that force level 'poor'. */
const MAJOR_ISSUES = new Set(['high_residual', 'implausible_size', 'methods_disagree']);

// ---------------------------------------------------------------------------------------------------------
// Small dense linear algebra
// ---------------------------------------------------------------------------------------------------------

/**
 * In-place Cholesky factorisation A = L L^T of a symmetric positive-definite n x n matrix (row-major).
 * The lower triangle is overwritten with L. Returns false when A is not (numerically) positive definite.
 */
function choleskyFactor(A, n, minPivot = 0) {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] * A[j * n + k];
    if (!(d > minPivot)) return false;
    d = Math.sqrt(d);
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / d;
    }
  }
  return true;
}

/** Solve L L^T x = b in place (b becomes x), L from choleskyFactor. */
function choleskySolve(L, n, b) {
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * b[k];
    b[i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * b[k];
    b[i] = s / L[i * n + i];
  }
}

/**
 * Eigen-decomposition of a symmetric n x n matrix by cyclic Jacobi rotations.
 * M (row-major) is destroyed; returns eigenvalues and the matching eigenvectors as columns of V.
 * Jacobi is slow for big matrices but for 9 x 9 it is tiny, and it resolves the smallest
 * eigenvector (the DLT null vector) to high relative accuracy.
 */
function jacobiEigen(M, n) {
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    let diag = 0;
    for (let p = 0; p < n; p++) {
      diag += M[p * n + p] * M[p * n + p];
      for (let q = p + 1; q < n; q++) off += M[p * n + q] * M[p * n + q];
    }
    if (off <= 1e-34 * diag || off === 0) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = M[p * n + q];
        if (apq === 0) continue;
        const theta = (M[q * n + q] - M[p * n + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = M[k * n + p];
          const akq = M[k * n + q];
          M[k * n + p] = c * akp - s * akq;
          M[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = M[p * n + k];
          const aqk = M[q * n + k];
          M[p * n + k] = c * apk - s * aqk;
          M[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p];
          const vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = M[i * n + i];
  return { values, V };
}

/** 3x3 inverse by adjugate. Returns null when the matrix is singular to working precision. */
function invert3(H) {
  const a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], i = H[8];
  const det = a * (e * i - f * h) + b * (f * g - d * i) + c * (d * h - e * g);
  // Compare against the size of the terms that were summed: a scale-free test for cancellation,
  // so badly scaled but perfectly valid px <-> mm homographies are not rejected.
  const terms =
    Math.abs(a * e * i) + Math.abs(a * f * h) + Math.abs(b * f * g) + Math.abs(b * d * i) + Math.abs(c * d * h) + Math.abs(c * e * g);
  if (!Number.isFinite(det) || !(Math.abs(det) > 1e-13 * terms)) return null;
  const k = 1 / det;
  return [
    (e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k,
    (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k,
    (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k,
  ];
}

/**
 * Closed-form homography taking the unit square (0,0),(1,0),(1,1),(0,1) onto q[0..3] (Heckbert).
 * Exact for four points and much cheaper than a general DLT. Returns null for degenerate quads.
 */
function squareToQuad(q) {
  const x0 = q[0].x, y0 = q[0].y, x1 = q[1].x, y1 = q[1].y, x2 = q[2].x, y2 = q[2].y, x3 = q[3].x, y3 = q[3].y;
  const dx1 = x1 - x2, dy1 = y1 - y2, dx2 = x3 - x2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const scale = Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2);
  if (!(Math.abs(den) > 1e-12 * scale)) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  const H = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
  return H.every(Number.isFinite) ? H : null;
}

// ---------------------------------------------------------------------------------------------------------
// Homographies
// ---------------------------------------------------------------------------------------------------------

/** Hartley normalisation: translate the centroid to the origin, scale the mean distance to sqrt(2). */
function hartley(points) {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let d = 0;
  for (const p of points) d += Math.hypot(p.x - cx, p.y - cy);
  d /= n;
  if (!Number.isFinite(d) || !(d > 0)) return null;
  return { cx, cy, scale: Math.SQRT2 / d };
}

/**
 * Homography mapping `src` points onto `dst` points (least squares for more than four pairs).
 * Hartley-normalised DLT; the null vector comes from a Jacobi eigen-decomposition of A^T A.
 *
 * @param {Point[]} src at least four points
 * @param {Point[]} dst the same number of points
 * @returns {Homography} H with applyHomography(H, src[i]) ~ dst[i], scaled so H[8] = 1 when possible
 * @throws {Error} Error('degenerate') when the points do not determine an invertible homography
 */
export function solveHomography(src, dst) {
  if (!Array.isArray(src) || !Array.isArray(dst) || src.length < 4 || src.length !== dst.length) {
    throw new Error('degenerate');
  }
  for (let i = 0; i < src.length; i++) {
    if (!isFinitePoint(src[i]) || !isFinitePoint(dst[i])) throw new Error('degenerate');
  }
  const ns = hartley(src);
  const nd = hartley(dst);
  if (!ns || !nd) throw new Error('degenerate');

  const M = new Float64Array(81);
  const row = new Float64Array(9);
  const accumulate = () => {
    for (let i = 0; i < 9; i++) {
      if (row[i] === 0) continue;
      for (let j = 0; j < 9; j++) M[i * 9 + j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < src.length; k++) {
    const x = (src[k].x - ns.cx) * ns.scale;
    const y = (src[k].y - ns.cy) * ns.scale;
    const X = (dst[k].x - nd.cx) * nd.scale;
    const Y = (dst[k].y - nd.cy) * nd.scale;
    row.fill(0);
    row[0] = -x; row[1] = -y; row[2] = -1; row[6] = X * x; row[7] = X * y; row[8] = X;
    accumulate();
    row.fill(0);
    row[3] = -x; row[4] = -y; row[5] = -1; row[6] = Y * x; row[7] = Y * y; row[8] = Y;
    accumulate();
  }

  const { values, V } = jacobiEigen(M, 9);
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < 9; i++) {
    if (values[i] < values[lo]) lo = i;
    if (values[i] > values[hi]) hi = i;
  }
  let second = Infinity;
  for (let i = 0; i < 9; i++) if (i !== lo && values[i] < second) second = values[i];
  // A two-dimensional null space means the correspondences do not pin down a unique homography.
  if (!(values[hi] > 0) || !(second > 1e-13 * values[hi])) throw new Error('degenerate');

  const hn = new Array(9);
  let norm = 0;
  for (let i = 0; i < 9; i++) {
    hn[i] = V[i * 9 + lo];
    norm += hn[i] * hn[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 9; i++) hn[i] /= norm;
  const detN =
    hn[0] * (hn[4] * hn[8] - hn[5] * hn[7]) + hn[1] * (hn[5] * hn[6] - hn[3] * hn[8]) + hn[2] * (hn[3] * hn[7] - hn[4] * hn[6]);
  // Unit Frobenius norm in normalised coordinates, so the determinant is a meaningful singularity measure.
  if (!Number.isFinite(detN) || !(Math.abs(detN) > 1e-10)) throw new Error('degenerate');

  // H = Td^-1 * Hn * Ts
  const a = ns.scale;
  const hs = [
    hn[0] * a, hn[1] * a, hn[2] - a * (hn[0] * ns.cx + hn[1] * ns.cy),
    hn[3] * a, hn[4] * a, hn[5] - a * (hn[3] * ns.cx + hn[4] * ns.cy),
    hn[6] * a, hn[7] * a, hn[8] - a * (hn[6] * ns.cx + hn[7] * ns.cy),
  ];
  const b = 1 / nd.scale;
  const H = [
    b * hs[0] + nd.cx * hs[6], b * hs[1] + nd.cx * hs[7], b * hs[2] + nd.cx * hs[8],
    b * hs[3] + nd.cy * hs[6], b * hs[4] + nd.cy * hs[7], b * hs[5] + nd.cy * hs[8],
    hs[6], hs[7], hs[8],
  ];
  return normaliseHomography(H);
}

/** Scale a homography so H[8] = 1 (or to unit max-magnitude when H[8] is effectively zero). */
function normaliseHomography(H) {
  let maxAbs = 0;
  for (let i = 0; i < 9; i++) maxAbs = Math.max(maxAbs, Math.abs(H[i]));
  if (!(maxAbs > 0) || !Number.isFinite(maxAbs)) throw new Error('degenerate');
  // Divide (rather than multiply by a reciprocal) so H[8] comes out as exactly 1.
  const d = Math.abs(H[8]) > 1e-12 * maxAbs ? H[8] : maxAbs;
  return Array.from(H, (v) => v / d);
}

/**
 * Apply a homography to a point.
 *
 * @param {Homography} H
 * @param {Point} p
 * @returns {Point}
 */
export function applyHomography(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/**
 * Inverse homography (the true matrix inverse, so H * invertHomography(H) = identity).
 *
 * @param {Homography} H
 * @returns {Homography}
 * @throws {Error} Error('degenerate') when H is singular
 */
export function invertHomography(H) {
  const inv = Array.isArray(H) || ArrayBuffer.isView(H) ? invert3(H) : null;
  if (!inv) throw new Error('degenerate');
  return inv;
}

// ---------------------------------------------------------------------------------------------------------
// Quads
// ---------------------------------------------------------------------------------------------------------

function isFinitePoint(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * Put any four points into [TL, TR, BR, BL] order for image coordinates (y down).
 * Points are sorted by angle around their centroid, which is clockwise on screen, then rotated so the
 * first is the corner with the smallest x + y (ties go to the upper corner). Works for rotated and
 * perspective-distorted quads; the input is not modified.
 *
 * @param {Point[]} points four points in any order
 * @returns {Quad}
 */
export function orderQuad(points) {
  const pts = Array.from(points, (p) => ({ x: p.x, y: p.y }));
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x / pts.length;
    cy += p.y / pts.length;
  }
  const keyed = pts.map((p) => ({ p, angle: Math.atan2(p.y - cy, p.x - cx) }));
  keyed.sort((a, b) => a.angle - b.angle);
  let span = 0;
  for (const p of pts) span = Math.max(span, Math.abs(p.x - cx), Math.abs(p.y - cy));
  const tie = 1e-9 * span;
  let start = 0;
  for (let i = 1; i < keyed.length; i++) {
    const s = keyed[i].p.x + keyed[i].p.y;
    const best = keyed[start].p.x + keyed[start].p.y;
    if (s < best - tie || (Math.abs(s - best) <= tie && keyed[i].p.y < keyed[start].p.y)) start = i;
  }
  return keyed.map((_, i) => keyed[(start + i) % keyed.length].p);
}

/** 'convex' | 'not_convex' | 'degenerate' for a quad given in drawing order. */
function classifyQuad(q) {
  if (!q || q.length !== 4 || !q.every(isFinitePoint)) return 'degenerate';
  let perimeter = 0;
  for (let i = 0; i < 4; i++) perimeter += Math.hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y);
  if (!(perimeter > 0) || !Number.isFinite(perimeter)) return 'degenerate';
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const e1x = b.x - a.x, e1y = b.y - a.y, e2x = c.x - b.x, e2y = c.y - b.y;
    const l1 = Math.hypot(e1x, e1y);
    const l2 = Math.hypot(e2x, e2y);
    if (!(l1 > 1e-9 * perimeter) || !(l2 > 1e-9 * perimeter)) return 'degenerate';
    const sine = (e1x * e2y - e1y * e2x) / (l1 * l2);
    // A corner flatter than about a fifth of an arc-second is three collinear points for our purposes.
    if (!(Math.abs(sine) > 1e-6)) return 'degenerate';
    if (sine > 0) positive++;
    else negative++;
  }
  return positive === 4 || negative === 4 ? 'convex' : 'not_convex';
}

/**
 * True when the quad, taken in the order given, is strictly convex and non-degenerate
 * (no repeated points, no three collinear corners, no bow-tie). Either winding is accepted.
 *
 * @param {Point[]} quad four points in drawing order
 * @returns {boolean}
 */
export function isConvexQuad(quad) {
  return classifyQuad(quad) === 'convex';
}

/**
 * Area of a quad in px^2 by the shoelace formula (always positive, whatever the winding).
 *
 * @param {Point[]} quad four points in drawing order
 * @returns {number}
 */
export function quadArea(quad) {
  let twice = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

function pointInConvexQuad(p, q) {
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross > 0) positive++;
    else if (cross < 0) negative++;
  }
  return positive === 0 || negative === 0;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------------------------------------------------
// Joint fit
// ---------------------------------------------------------------------------------------------------------
//
// Parameter vector (13), all O(1) so the normal equations are well conditioned:
//   p[0..7]  G: homography taking the door's unit square (u = X / W, v = Y / H) to Hartley-normalised
//               image coordinates, with G[8] fixed at 1. planeToImage = T^-1 * G * diag(1/W, 1/H, 1).
//   p[8], p[9]    W / S, H / S        door size (S = a fixed length scale in mm)
//   p[10], p[11]  cx / S, cy / S      sheet centre on the door plane
//   p[12]         theta               sheet rotation on the door plane
//
// Expressing the homography in door-relative (u, v) coordinates is just a parameter-dependent choice of
// plane units: it makes the four door corners depend on G alone, so W and H enter only through the
// sheet. That keeps Levenberg-Marquardt close to linear from the starting point.

const N_PARAMS = 13;
const N_RESIDUALS = 16;
const DOOR_UV = [0, 0, 1, 0, 1, 1, 0, 1];
const SHEET_SIGNS = [-1, -1, 1, -1, 1, 1, -1, 1];
const MIN_DENOMINATOR = 1e-9;
const LM_MAX_ITERATIONS = 100;
/** Chi-square below which the fit is exact to rounding (noise-free input). */
const LM_EXACT_COST = 1e-22;
const LM_GRADIENT_TOL = 1e-11;
const LM_STEP_TOL = 1e-13;
/** The joint fit has 16 residuals and 13 parameters. */
const FIT_DOF = N_RESIDUALS - N_PARAMS;
/**
 * Pseudo degrees of freedom of prior trust in the caller's sigmas when rescaling the covariance.
 * With only 3 real dof, chi^2 / dof on its own is far too noisy to use as a variance estimate.
 */
const SIGMA_PRIOR_DOF = 3;

/**
 * Whitened residuals (and optionally the Jacobian) of the joint model. Returns the cost r.r, or
 * Infinity when the parameters put a corner on or behind the horizon / make the door non-positive.
 */
function evaluateModel(p, model, r, J) {
  const g0 = p[0], g1 = p[1], g2 = p[2], g3 = p[3], g4 = p[4], g5 = p[5], g6 = p[6], g7 = p[7];
  const W = p[8], H = p[9], cx = p[10], cy = p[11], theta = p[12];
  if (!(W > 1e-9) || !(H > 1e-9)) return Infinity;
  const { obs, wDoor, wSheet, halfA, halfB } = model;
  const n = N_PARAMS;
  if (J) J.fill(0);
  let cost = 0;

  for (let k = 0; k < 4; k++) {
    const u = DOOR_UV[2 * k];
    const v = DOOR_UV[2 * k + 1];
    const den = g6 * u + g7 * v + 1;
    if (!(den > MIN_DENOMINATOR)) return Infinity;
    const x = (g0 * u + g1 * v + g2) / den;
    const y = (g3 * u + g4 * v + g5) / den;
    const rx = wDoor * (x - obs[2 * k]);
    const ry = wDoor * (y - obs[2 * k + 1]);
    r[2 * k] = rx;
    r[2 * k + 1] = ry;
    cost += rx * rx + ry * ry;
    if (J) {
      const w = wDoor / den;
      let o = 2 * k * n;
      J[o] = w * u; J[o + 1] = w * v; J[o + 2] = w; J[o + 6] = -w * x * u; J[o + 7] = -w * x * v;
      o += n;
      J[o + 3] = w * u; J[o + 4] = w * v; J[o + 5] = w; J[o + 6] = -w * y * u; J[o + 7] = -w * y * v;
    }
  }

  const c = Math.cos(theta);
  const s = Math.sin(theta);
  for (let k = 0; k < 4; k++) {
    const xi = SHEET_SIGNS[2 * k] * halfA;
    const eta = SHEET_SIGNS[2 * k + 1] * halfB;
    const dX = c * xi - s * eta;
    const dY = s * xi + c * eta;
    const u = (cx + dX) / W;
    const v = (cy + dY) / H;
    const den = g6 * u + g7 * v + 1;
    if (!(den > MIN_DENOMINATOR)) return Infinity;
    const x = (g0 * u + g1 * v + g2) / den;
    const y = (g3 * u + g4 * v + g5) / den;
    const i = 8 + 2 * k;
    const rx = wSheet * (x - obs[i]);
    const ry = wSheet * (y - obs[i + 1]);
    r[i] = rx;
    r[i + 1] = ry;
    cost += rx * rx + ry * ry;
    if (J) {
      const w = wSheet / den;
      // d(image)/d(u, v), already weighted.
      const xu = w * (g0 - x * g6), xv = w * (g1 - x * g7), yu = w * (g3 - y * g6), yv = w * (g4 - y * g7);
      let o = i * n;
      J[o] = w * u; J[o + 1] = w * v; J[o + 2] = w; J[o + 6] = -w * x * u; J[o + 7] = -w * x * v;
      J[o + 8] = (-xu * u) / W; J[o + 9] = (-xv * v) / H; J[o + 10] = xu / W; J[o + 11] = xv / H;
      J[o + 12] = (-xu * dY) / W + (xv * dX) / H;
      o += n;
      J[o + 3] = w * u; J[o + 4] = w * v; J[o + 5] = w; J[o + 6] = -w * y * u; J[o + 7] = -w * y * v;
      J[o + 8] = (-yu * u) / W; J[o + 9] = (-yv * v) / H; J[o + 10] = yu / W; J[o + 11] = yv / H;
      J[o + 12] = (-yu * dY) / W + (yv * dX) / H;
    }
  }
  return cost;
}

/** A = J^T J (full symmetric), g = J^T r. */
function normalEquations(J, r, A, g) {
  const n = N_PARAMS;
  A.fill(0);
  g.fill(0);
  for (let row = 0; row < N_RESIDUALS; row++) {
    const o = row * n;
    const ri = r[row];
    for (let i = 0; i < n; i++) {
      const ji = J[o + i];
      if (ji === 0) continue;
      g[i] += ji * ri;
      for (let j = 0; j <= i; j++) A[i * n + j] += ji * J[o + j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) A[j * n + i] = A[i * n + j];
}

/**
 * Levenberg-Marquardt with Marquardt (diagonal) scaling. Returns null if the start point is invalid,
 * otherwise { p, r, J, cost, iterations, converged } at the best point found.
 */
function levenbergMarquardt(model, p0) {
  const n = N_PARAMS;
  let p = Float64Array.from(p0);
  let r = new Float64Array(N_RESIDUALS);
  let J = new Float64Array(N_RESIDUALS * n);
  let pTrial = new Float64Array(n);
  let rTrial = new Float64Array(N_RESIDUALS);
  let JTrial = new Float64Array(N_RESIDUALS * n);
  const A = new Float64Array(n * n);
  const g = new Float64Array(n);
  const M = new Float64Array(n * n);
  const delta = new Float64Array(n);

  let cost = evaluateModel(p, model, r, J);
  if (!Number.isFinite(cost)) return null;
  let lambda = 1e-3;
  let converged = false;
  let iterations = 0;

  while (iterations < LM_MAX_ITERATIONS) {
    if (cost <= LM_EXACT_COST) {
      converged = true;
      break;
    }
    normalEquations(J, r, A, g);
    let maxDiag = 0;
    for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, A[i * n + i]);
    // Largest cosine between the residual vector and a Jacobian column: zero at a stationary point.
    let gradient = 0;
    for (let i = 0; i < n; i++) {
      const d = A[i * n + i];
      if (d > 0) gradient = Math.max(gradient, Math.abs(g[i]) / Math.sqrt(d));
    }
    if (gradient <= LM_GRADIENT_TOL * Math.sqrt(cost)) {
      converged = true;
      break;
    }
    iterations++;

    let accepted = false;
    let costTrial = Infinity;
    let step = Infinity;
    while (lambda <= 1e15) {
      M.set(A);
      for (let i = 0; i < n; i++) M[i * n + i] += lambda * Math.max(A[i * n + i], 1e-12 * maxDiag);
      if (choleskyFactor(M, n)) {
        delta.set(g);
        choleskySolve(M, n, delta);
        step = 0;
        for (let i = 0; i < n; i++) {
          pTrial[i] = p[i] - delta[i];
          step = Math.max(step, Math.abs(delta[i]) / (Math.abs(p[i]) + 1));
        }
        costTrial = evaluateModel(pTrial, model, rTrial, JTrial);
        if (costTrial < cost) {
          accepted = true;
          break;
        }
        // No improvement from a step this small: we are at the minimum to rounding.
        if (step <= LM_STEP_TOL) {
          converged = true;
          break;
        }
      }
      lambda *= 10;
    }
    if (!accepted) break;

    const reduction = cost - costTrial;
    [p, pTrial] = [pTrial, p];
    [r, rTrial] = [rTrial, r];
    [J, JTrial] = [JTrial, J];
    cost = costTrial;
    lambda = Math.max(lambda * 0.1, 1e-9);
    if (step <= LM_STEP_TOL || (reduction <= 1e-14 * cost && step <= 1e-9)) {
      converged = true;
      break;
    }
  }
  return { p, r, J, cost, iterations, converged };
}

/**
 * Variances of W and H (in units of S^2) from inverse(J^T J), using a Jacobi-preconditioned
 * Cholesky factorisation. Returns null when the normal matrix is singular (scale not identifiable).
 */
function sizeVariances(J, r) {
  const n = N_PARAMS;
  const A = new Float64Array(n * n);
  const g = new Float64Array(n);
  normalEquations(J, r, A, g);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    d[i] = Math.sqrt(A[i * n + i]);
    if (!(d[i] > 0) || !Number.isFinite(d[i])) return null;
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i * n + j] /= d[i] * d[j];
  if (!choleskyFactor(A, n, 1e-13)) return null;
  const e = new Float64Array(n);
  e[8] = 1;
  choleskySolve(A, n, e);
  const varW = e[8] / (d[8] * d[8]);
  e.fill(0);
  e[9] = 1;
  choleskySolve(A, n, e);
  const varH = e[9] / (d[9] * d[9]);
  if (!(varW >= 0) || !(varH >= 0) || !Number.isFinite(varW) || !Number.isFinite(varH)) return null;
  return { varW, varH };
}

/**
 * Linear starting point for one assignment of the sheet side lengths (side 0->1 has length a).
 * In the door's unit-square frame the plane is (W u, H v), so each known sheet length L gives the
 * linear equation W^2 du^2 + H^2 dv^2 = L^2 in (W^2, H^2). Rows are divided by L^2 so the residual
 * is a relative, dimensionless misfit that can be compared between the two assignments.
 */
function linearStart(uv, a, b, fallbackAspect) {
  const diag = Math.hypot(a, b);
  const pairs = [0, 1, a, 1, 2, b, 2, 3, a, 3, 0, b, 0, 2, diag, 1, 3, diag];
  const m1 = new Float64Array(6);
  const m2 = new Float64Array(6);
  let s11 = 0, s12 = 0, s22 = 0, b1 = 0, b2 = 0;
  for (let k = 0; k < 6; k++) {
    const i = pairs[3 * k];
    const j = pairs[3 * k + 1];
    const L2 = pairs[3 * k + 2] * pairs[3 * k + 2];
    const du = uv[2 * j] - uv[2 * i];
    const dv = uv[2 * j + 1] - uv[2 * i + 1];
    m1[k] = (du * du) / L2;
    m2[k] = (dv * dv) / L2;
    s11 += m1[k] * m1[k];
    s12 += m1[k] * m2[k];
    s22 += m2[k] * m2[k];
    b1 += m1[k];
    b2 += m2[k];
  }
  let W2 = NaN;
  let H2 = NaN;
  let fallback = false;
  const det = s11 * s22 - s12 * s12;
  if (det > 1e-12 * s11 * s22) {
    W2 = (b1 * s22 - b2 * s12) / det;
    H2 = (s11 * b2 - s12 * b1) / det;
  }
  if (!(W2 > 0) || !(H2 > 0) || !Number.isFinite(W2) || !Number.isFinite(H2)) {
    // Noise can push one unknown non-positive. Fall back to a one-parameter fit that takes the door's
    // aspect ratio from its pixel shape; LM sorts out the rest.
    fallback = true;
    const rho2 = fallbackAspect * fallbackAspect;
    let sm = 0;
    let smm = 0;
    for (let k = 0; k < 6; k++) {
      const m = m1[k] + rho2 * m2[k];
      sm += m;
      smm += m * m;
    }
    if (!(smm > 0) || !Number.isFinite(smm)) return null;
    W2 = sm / smm;
    H2 = rho2 * W2;
    if (!(W2 > 0) || !(H2 > 0) || !Number.isFinite(W2) || !Number.isFinite(H2)) return null;
  }
  let misfit = 0;
  for (let k = 0; k < 6; k++) {
    const e = W2 * m1[k] + H2 * m2[k] - 1;
    misfit += e * e;
  }
  const W = Math.sqrt(W2);
  const H = Math.sqrt(H2);
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < 4; k++) {
    cx += (W * uv[2 * k]) / 4;
    cy += (H * uv[2 * k + 1]) / 4;
  }
  // Direction of the two 'a' sides (0->1 and 3->2), averaged.
  const ax = W * (uv[2] - uv[0] + uv[4] - uv[6]);
  const ay = H * (uv[3] - uv[1] + uv[5] - uv[7]);
  return { a, b, W, H, cx, cy, theta: Math.atan2(ay, ax), misfit: Math.sqrt(misfit / 6), fallback };
}

// Choosing which way round the sheet is.
//
// When the sheet is square to the door (the normal way to tape it up) the eight corners CANNOT tell a
// portrait sheet from a landscape one: stretching the plane by (h/w, w/h) maps one explanation exactly
// onto the other, door rectangle included, and a homography absorbs the stretch. Both assignments then
// fit with identical residuals but give door sizes that differ by the sheet's aspect ratio.
// What does tell them apart is the camera: a real phone camera has square pixels and its optical axis
// near the image centre, so a metric plane must project with K^-1 [h1 h2] orthogonal and equal in
// length for some plausible focal length. The wrong assignment breaks that badly (by aspect^4 in the
// fronto-parallel case). The prior is used ONLY to pick between the two discrete assignments; the
// reported sizes never depend on any camera assumption.

/** Typical phone main-camera focal length as a fraction of the long image side. */
const NOMINAL_FOCAL_FRAC = 0.72;
/** Tolerance on ln(eigenvalue ratio) of the plane's metric as seen by the assumed camera. */
const CAMERA_SHAPE_TOL = 0.15;
/** Tolerance on ln(focal / nominal focal): a factor of ~1.8 either way costs one unit. */
const CAMERA_FOCAL_TOL = 0.6;
/** Nudge against an assignment whose door size is outside the caller's plausible range. */
const IMPLAUSIBLE_PENALTY = 3;

/**
 * How badly a plane-to-image homography (metric plane) disagrees with a square-pixel pinhole camera
 * whose principal point is `principal`, minimised over the focal length with a log-normal prior
 * around `nominalFocal`. Zero for a perfectly consistent view; chi-square-like units.
 */
function cameraInconsistency(P, principal, nominalFocal) {
  const h1x = P[0] - principal.x * P[6], h1y = P[3] - principal.y * P[6], h1z = P[6];
  const h2x = P[1] - principal.x * P[7], h2y = P[4] - principal.y * P[7], h2z = P[7];
  const a11 = h1x * h1x + h1y * h1y, a22 = h2x * h2x + h2y * h2y, a12 = h1x * h2x + h1y * h2y;
  const b11 = h1z * h1z, b22 = h2z * h2z, b12 = h1z * h2z;
  let best = Infinity;
  for (let i = -20; i <= 20; i++) {
    const t = i * 0.1;
    const f = nominalFocal * Math.exp(t);
    const psi = 1 / (f * f);
    // Gram matrix of K^-1 [h1 h2]; proportional to the identity for a true metric plane.
    const g11 = psi * a11 + b11, g22 = psi * a22 + b22, g12 = psi * a12 + b12;
    const trace = g11 + g22;
    const spread = Math.hypot(g11 - g22, 2 * g12);
    const logRatio = Math.log((trace + spread) / Math.max(trace - spread, Number.MIN_VALUE));
    const cost = (logRatio / CAMERA_SHAPE_TOL) ** 2 + (t / CAMERA_FOCAL_TOL) ** 2;
    if (cost < best) best = cost;
  }
  return best;
}

/**
 * Door size from the sheet alone: homography sheet px -> sheet mm from its four corners, then the door
 * corners mapped through it. Returns null when a door corner falls on or beyond that homography's horizon.
 */
function sheetOnlyEstimate(sheet, door, a, b) {
  const toPx = squareToQuad(sheet);
  if (!toPx) return null;
  const toUnit = invert3(toPx);
  if (!toUnit) return null;
  const mid = { x: (sheet[0].x + sheet[1].x + sheet[2].x + sheet[3].x) / 4, y: (sheet[0].y + sheet[1].y + sheet[2].y + sheet[3].y) / 4 };
  const side = toUnit[6] * mid.x + toUnit[7] * mid.y + toUnit[8];
  const mm = [];
  for (let k = 0; k < 4; k++) {
    const p = door[k];
    const w = toUnit[6] * p.x + toUnit[7] * p.y + toUnit[8];
    // The corner must be on the same side of the vanishing line as the sheet itself.
    if (!(w * side > 0)) return null;
    mm.push({ x: (a * (toUnit[0] * p.x + toUnit[1] * p.y + toUnit[2])) / w, y: (b * (toUnit[3] * p.x + toUnit[4] * p.y + toUnit[5])) / w });
  }
  const widthTopMm = dist(mm[0], mm[1]);
  const widthBottomMm = dist(mm[3], mm[2]);
  const heightLeftMm = dist(mm[0], mm[3]);
  const heightRightMm = dist(mm[1], mm[2]);
  const out = {
    widthTopMm,
    widthBottomMm,
    heightLeftMm,
    heightRightMm,
    widthMm: (widthTopMm + widthBottomMm) / 2,
    heightMm: (heightLeftMm + heightRightMm) / 2,
  };
  return Object.values(out).every(Number.isFinite) ? out : null;
}

/**
 * 1-sigma uncertainty of the sheet-only estimate, by pushing a +-1 sigma change of every marked
 * coordinate through it. Using a full-sigma secant rather than a derivative picks up some of the
 * strong non-linearity of extrapolating from a small sheet. Infinity when a perturbed case is invalid.
 *
 * Also returns the sigmas of 1/width and 1/height. An extrapolated length behaves like
 * L / ((1 + e x1)(1 + e x2)) in the homography's perspective error e, so the length itself is
 * heavy-tailed (it has poles) while its reciprocal is a tame polynomial in e. The agreement test is
 * therefore done on reciprocals, and their variance includes the curvature (second-difference) term,
 * which dominates when the sheet is tiny and the extrapolation is many sheet-lengths long.
 */
function sheetOnlySigma(sheet, door, a, b, sigmaSheet, sigmaDoor, base) {
  let varW = 0;
  let varH = 0;
  let varInvW = 0;
  let varInvH = 0;
  const shifted = (quad, k, axis, d) => quad.map((p, i) => (i === k ? { x: p.x + (axis === 0 ? d : 0), y: p.y + (axis === 1 ? d : 0) } : p));
  for (let group = 0; group < 2; group++) {
    const sigma = group === 0 ? sigmaSheet : sigmaDoor;
    for (let k = 0; k < 4; k++) {
      for (let axis = 0; axis < 2; axis++) {
        const plus = group === 0 ? sheetOnlyEstimate(shifted(sheet, k, axis, sigma), door, a, b) : sheetOnlyEstimate(sheet, shifted(door, k, axis, sigma), a, b);
        const minus = group === 0 ? sheetOnlyEstimate(shifted(sheet, k, axis, -sigma), door, a, b) : sheetOnlyEstimate(sheet, shifted(door, k, axis, -sigma), a, b);
        if (!plus || !minus) return { sigmaWidthMm: Infinity, sigmaHeightMm: Infinity, sigmaInvWidth: Infinity, sigmaInvHeight: Infinity };
        varW += ((plus.widthMm - minus.widthMm) / 2) ** 2;
        varH += ((plus.heightMm - minus.heightMm) / 2) ** 2;
        // For z = z0 + g e + c e^2 with e ~ N(0, sigma^2): var(z) = (g sigma)^2 + 2 (c sigma^2)^2.
        const curveW = (1 / plus.widthMm + 1 / minus.widthMm - 2 / base.widthMm) / 2;
        const curveH = (1 / plus.heightMm + 1 / minus.heightMm - 2 / base.heightMm) / 2;
        varInvW += ((1 / plus.widthMm - 1 / minus.widthMm) / 2) ** 2 + 2 * curveW * curveW;
        varInvH += ((1 / plus.heightMm - 1 / minus.heightMm) / 2) ** 2 + 2 * curveH * curveH;
      }
    }
  }
  return { sigmaWidthMm: Math.sqrt(varW), sigmaHeightMm: Math.sqrt(varH), sigmaInvWidth: Math.sqrt(varInvW), sigmaInvHeight: Math.sqrt(varInvH) };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function assessQuality({ door, sheet, imageSize, widthMm, heightMm, sigmaWidthMm, sigmaHeightMm, chi2, sheetOnly, sheetOnlySigmas, plausible }) {
  const T = QUALITY_THRESHOLDS;
  const issues = [];

  const sheetSides = [dist(sheet[0], sheet[1]), dist(sheet[1], sheet[2]), dist(sheet[2], sheet[3]), dist(sheet[3], sheet[0])];
  if (Math.min(...sheetSides) < T.sheetMinSidePx) issues.push('sheet_small');

  const top = dist(door[0], door[1]);
  const right = dist(door[1], door[2]);
  const bottom = dist(door[3], door[2]);
  const left = dist(door[0], door[3]);
  const ratio = (p, q) => Math.max(p, q) / Math.min(p, q);
  if (ratio(top, bottom) > T.steepAngleRatio || ratio(left, right) > T.steepAngleRatio) issues.push('steep_angle');

  if (chi2 / FIT_DOF > T.highResidualChi2PerDof) issues.push('high_residual');

  if (sheetOnly) {
    // Compared as reciprocals (see sheetOnlySigma); sigma(1/L) = sigma(L) / L^2 for the joint value.
    const disagrees = (joint, other, sigmaJoint, sigmaInvOther) => {
      if (!(Math.abs(joint - other) > T.disagreeMinMm)) return false;
      return Math.abs(1 / joint - 1 / other) > T.disagreeSigmas * Math.hypot(sigmaJoint / (joint * joint), sigmaInvOther);
    };
    if (
      disagrees(widthMm, sheetOnly.widthMm, sigmaWidthMm, sheetOnlySigmas.sigmaInvWidth) ||
      disagrees(heightMm, sheetOnly.heightMm, sigmaHeightMm, sheetOnlySigmas.sigmaInvHeight)
    ) {
      issues.push('methods_disagree');
    }
  }

  const imgW = Number(imageSize && imageSize.width);
  const imgH = Number(imageSize && imageSize.height);
  if (imgW > 0 && imgH > 0) {
    const mx = T.edgeMarginFrac * imgW;
    const my = T.edgeMarginFrac * imgH;
    if (door.some((p) => p.x < mx || p.x > imgW - mx || p.y < my || p.y > imgH - my)) issues.push('door_near_edge');
    const ys = door.map((p) => p.y);
    if ((Math.max(...ys) - Math.min(...ys)) / imgH < T.doorMinHeightFrac) issues.push('door_small');
  }

  if (widthMm < plausible.minWidthMm || widthMm > plausible.maxWidthMm || heightMm < plausible.minHeightMm || heightMm > plausible.maxHeightMm) {
    issues.push('implausible_size');
  }

  const sheetCentre = { x: (sheet[0].x + sheet[1].x + sheet[2].x + sheet[3].x) / 4, y: (sheet[0].y + sheet[1].y + sheet[2].y + sheet[3].y) / 4 };
  if (!pointInConvexQuad(sheetCentre, door)) issues.push('sheet_off_door');

  const maxSigma = Math.max(sigmaWidthMm, sigmaHeightMm);
  if (maxSigma > T.highUncertaintySigmaMm) issues.push('high_uncertainty');

  let level = 'fair';
  if (maxSigma > T.poorSigmaMm || issues.some((code) => MAJOR_ISSUES.has(code))) level = 'poor';
  else if (issues.length === 0 && maxSigma <= T.goodSigmaMm) level = 'good';

  // Score: driven by the uncertainty, knocked down per issue, then kept inside its level's band so
  // the number and the label can never contradict each other.
  let score = clamp(1 - (maxSigma - 1) / 11, 0, 1);
  for (const code of issues) score *= MAJOR_ISSUES.has(code) ? 0.5 : 0.85;
  if (level === 'good') score = clamp(score, 0.75, 1);
  else if (level === 'fair') score = clamp(score, 0.4, 0.74);
  else score = clamp(score, 0, 0.39);
  if (!Number.isFinite(score)) score = 0;

  return { level, score: Math.round(score * 1000) / 1000, issues };
}

const fail = (error, message) => ({ ok: false, error, message });

const positiveOr = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

const isFourPoints = (pts) => Array.isArray(pts) && pts.length === 4 && pts.every(isFinitePoint);

/**
 * Measure a door opening from one photo: a joint weighted least-squares fit of a single plane-to-image
 * homography to the four reference-sheet corners (known size) and the four door corners (a W x H
 * rectangle of unknown size in the same plane).
 *
 * Never throws for bad geometry: returns `{ ok: false, error, message }` instead.
 *
 * Result notes:
 * - widthMm / heightMm are along the door's top edge (TL -> TR of the ordered door corners) and its left edge.
 * - sigmaWidthMm / sigmaHeightMm are 1-sigma, from the fit covariance for the corner sigmas given, inflated
 *   (never deflated) when the residuals say the corners were worse than claimed, and widened by half the
 *   gap between the two candidate answers when portrait vs landscape cannot be decided safely.
 * - sheetOnly is the independent cross-check. If the sheet-only homography puts a door corner beyond its
 *   horizon the lengths are meaningless: `valid` is false and the numbers are null.
 * - doorFitPx / sheetFitPx line up index by index with orderQuad(doorPx) / orderQuad(sheetPx).
 * - fit.orientationMargin: how decisively portrait vs landscape was chosen for the sheet (chi-square-like
 *   units; null for a square sheet). Under QUALITY_THRESHOLDS.orientationMinMargin the choice is unsafe
 *   and the sigmas say so (which for any ordinary sheet means 'high_uncertainty' and level 'poor').
 *
 * @param {object} input
 * @param {Point[]} input.sheetPx four sheet corners in image px, any order
 * @param {Point[]} input.doorPx four door-opening corners in image px, any order
 * @param {{w:number, h:number}} input.sheetMm sheet side lengths in mm (which side is which in the photo is worked out)
 * @param {{width:number, height:number}} input.imageSize size of the FULL photo in px: used for the framing
 *   checks and, as the camera's optical centre, to tell a portrait sheet from a landscape one
 * @param {number} [input.sigmaSheetPx=1] 1-sigma localisation noise of a sheet corner, px
 * @param {number} [input.sigmaDoorPx=2.5] 1-sigma localisation noise of a door corner, px
 * @param {{minWidthMm:number, maxWidthMm:number, minHeightMm:number, maxHeightMm:number}} [input.plausible]
 * @returns {{
 *   ok: true, widthMm: number, heightMm: number, sigmaWidthMm: number, sigmaHeightMm: number,
 *   rmsResidualPx: number, sheetOrientation: 'portrait'|'landscape',
 *   sheetOnly: { widthTopMm: number|null, widthBottomMm: number|null, heightLeftMm: number|null, heightRightMm: number|null,
 *                widthMm: number|null, heightMm: number|null, valid: boolean, sigmaWidthMm: number|null, sigmaHeightMm: number|null },
 *   imageToPlane: Homography, planeToImage: Homography, doorFitPx: Quad, sheetFitPx: Quad,
 *   quality: { level: 'good'|'fair'|'poor', score: number, issues: string[] },
 *   fit: { chi2: number, dof: number, iterations: number, sigmaScale: number, orientationMargin: number|null }
 * } | { ok: false, error: 'not_convex'|'degenerate'|'no_convergence', message: string }}
 */
export function measureDoor(input) {
  try {
    return measure(input);
  } catch {
    return fail('degenerate', 'The marked corners could not be turned into a measurement.');
  }
}

function measure(input) {
  if (!input || typeof input !== 'object') return fail('degenerate', 'No measurement input was provided.');
  if (!isFourPoints(input.sheetPx) || !isFourPoints(input.doorPx)) {
    return fail('degenerate', 'Four sheet corners and four door corners are needed.');
  }
  const mmW = Number(input.sheetMm && input.sheetMm.w);
  const mmH = Number(input.sheetMm && input.sheetMm.h);
  if (!(mmW > 0) || !(mmH > 0) || !Number.isFinite(mmW) || !Number.isFinite(mmH)) {
    return fail('degenerate', 'The reference sheet size must be a positive width and height.');
  }
  const sigmaSheet = positiveOr(input.sigmaSheetPx, 1);
  const sigmaDoor = positiveOr(input.sigmaDoorPx, 2.5);
  const plausible = { ...DEFAULT_PLAUSIBLE, ...(input.plausible || {}) };

  const door = orderQuad(input.doorPx);
  const sheet = orderQuad(input.sheetPx);
  const doorShape = classifyQuad(door);
  if (doorShape === 'not_convex') return fail('not_convex', 'The door corners do not form a simple four-sided shape.');
  if (doorShape !== 'convex') return fail('degenerate', 'Two or more door corners are on top of each other or in a line.');
  const sheetShape = classifyQuad(sheet);
  if (sheetShape === 'not_convex') return fail('not_convex', 'The sheet corners do not form a simple four-sided shape.');
  if (sheetShape !== 'convex') return fail('degenerate', 'Two or more sheet corners are on top of each other or in a line.');

  // Hartley-normalise the image so every homography entry is O(1).
  const norm = hartley([...door, ...sheet]);
  if (!norm) return fail('degenerate', 'The marked corners are all in one spot.');
  const pxPerUnit = 1 / norm.scale;
  const toNorm = (p) => ({ x: (p.x - norm.cx) * norm.scale, y: (p.y - norm.cy) * norm.scale });
  const doorN = door.map(toNorm);
  const sheetN = sheet.map(toNorm);
  const obs = new Float64Array(16);
  for (let k = 0; k < 4; k++) {
    obs[2 * k] = doorN[k].x;
    obs[2 * k + 1] = doorN[k].y;
    obs[8 + 2 * k] = sheetN[k].x;
    obs[9 + 2 * k] = sheetN[k].y;
  }

  // Step 2: exact homography unit square -> door, and the sheet corners in that (u, v) frame.
  const G0 = squareToQuad(doorN);
  const G0inv = G0 && invert3(G0);
  if (!G0inv) return fail('degenerate', 'The door corners are too close to a straight line.');
  const uv = new Float64Array(8);
  const doorSide = G0inv[6] * doorN[0].x + G0inv[7] * doorN[0].y + G0inv[8];
  for (let k = 0; k < 4; k++) {
    const p = sheetN[k];
    const w = G0inv[6] * p.x + G0inv[7] * p.y + G0inv[8];
    if (!(w * doorSide > 0)) return fail('degenerate', 'The sheet and the door corners cannot lie on one flat surface.');
    uv[2 * k] = (G0inv[0] * p.x + G0inv[1] * p.y + G0inv[2]) / w;
    uv[2 * k + 1] = (G0inv[3] * p.x + G0inv[4] * p.y + G0inv[5]) / w;
  }

  const fallbackAspect = (dist(door[0], door[3]) + dist(door[1], door[2])) / (dist(door[0], door[1]) + dist(door[3], door[2]));
  const square = Math.abs(mmW - mmH) <= 1e-9 * Math.max(mmW, mmH);
  const starts = [linearStart(uv, mmW, mmH, fallbackAspect)];
  if (!square) starts.push(linearStart(uv, mmH, mmW, fallbackAspect));
  const candidates = starts.filter(Boolean).sort((p, q) => p.fallback - q.fallback || p.misfit - q.misfit);
  if (candidates.length === 0) return fail('degenerate', 'The sheet corners are too close together to give a scale.');

  // Step 3: refine. Both assignments are always refined: for a sheet taped roughly square to the door
  // the linear misfits of the two are both just noise, so ranking by them (and skipping the "worse"
  // one) occasionally throws away the right answer. A second refinement costs a few tens of microseconds.
  const imgW = Number(input.imageSize && input.imageSize.width);
  const imgH = Number(input.imageSize && input.imageSize.height);
  const hasImageSize = imgW > 0 && imgH > 0 && Number.isFinite(imgW) && Number.isFinite(imgH);
  const doorYs = door.map((q) => q.y);
  const principal = hasImageSize ? { x: imgW / 2, y: imgH / 2 } : { x: norm.cx, y: norm.cy };
  const nominalFocal = NOMINAL_FOCAL_FRAC * (hasImageSize ? Math.max(imgW, imgH) : 1.6 * (Math.max(...doorYs) - Math.min(...doorYs)));

  const refine = (start) => {
    const S = Math.sqrt(start.W * start.H);
    const model = { obs, wDoor: pxPerUnit / sigmaDoor, wSheet: pxPerUnit / sigmaSheet, halfA: start.a / (2 * S), halfB: start.b / (2 * S) };
    const p0 = [G0[0], G0[1], G0[2], G0[3], G0[4], G0[5], G0[6], G0[7], start.W / S, start.H / S, start.cx / S, start.cy / S, start.theta];
    const fit = levenbergMarquardt(model, p0);
    if (!fit || !fit.converged || !Number.isFinite(fit.cost)) return null;
    const q = fit.p;
    const widthMm = q[8] * S;
    const heightMm = q[9] * S;
    if (!(widthMm > 0) || !(heightMm > 0) || !Number.isFinite(widthMm) || !Number.isFinite(heightMm)) return null;
    // planeToImage = T^-1 * G * diag(1/W, 1/H, 1); its last entry is exactly 1.
    const s = pxPerUnit;
    const planeToImage = [
      (s * q[0] + norm.cx * q[6]) / widthMm, (s * q[1] + norm.cx * q[7]) / heightMm, s * q[2] + norm.cx,
      (s * q[3] + norm.cy * q[6]) / widthMm, (s * q[4] + norm.cy * q[7]) / heightMm, s * q[5] + norm.cy,
      q[6] / widthMm, q[7] / heightMm, 1,
    ];
    if (!planeToImage.every(Number.isFinite)) return null;
    const implausible =
      widthMm < plausible.minWidthMm || widthMm > plausible.maxWidthMm || heightMm < plausible.minHeightMm || heightMm > plausible.maxHeightMm;
    const prior = cameraInconsistency(planeToImage, principal, nominalFocal) + (implausible ? IMPLAUSIBLE_PENALTY : 0);
    return { ...fit, S, a: start.a, b: start.b, widthMm, heightMm, planeToImage, prior };
  };

  let best = refine(candidates[0]);
  let runnerUp = null;
  let orientationMargin = Infinity;
  if (candidates.length > 1) {
    const other = refine(candidates[1]);
    if (best && other) {
      // If even the better fit is far worse than the sigmas allow (a mis-marked corner, say), the raw
      // chi-square difference between the two is mostly an accident of that error. Rescale so the
      // better fit has chi^2 = dof before weighing it against the camera prior.
      const noiseScale = Math.max(1, Math.min(best.cost, other.cost) / FIT_DOF);
      const scoreBest = best.cost / noiseScale + best.prior;
      const scoreOther = other.cost / noiseScale + other.prior;
      orientationMargin = Math.abs(scoreOther - scoreBest);
      runnerUp = scoreOther < scoreBest ? best : other;
      if (scoreOther < scoreBest) best = other;
    } else if (other) {
      best = other;
    }
  }
  if (!best) return fail('no_convergence', 'The fit did not settle on a door size.');

  // Step 4: sizes and their uncertainty.
  const { p, S, widthMm, heightMm, planeToImage } = best;
  const variances = sizeVariances(best.J, best.r);
  if (!variances) return fail('degenerate', 'The sheet is too small in the photo to give a reliable scale.');
  const chi2 = best.cost;
  // The residuals are whitened, so chi^2 should be about dof = 3 when the sigmas are right. Three
  // degrees of freedom say very little on their own, so blend the observed chi^2 with a prior worth
  // SIGMA_PRIOR_DOF observations that the sigmas are right, and only ever inflate.
  const sigmaScale = Math.sqrt(Math.max(1, (SIGMA_PRIOR_DOF + chi2) / (SIGMA_PRIOR_DOF + FIT_DOF)));
  let sigmaWidthMm = S * Math.sqrt(variances.varW) * sigmaScale;
  let sigmaHeightMm = S * Math.sqrt(variances.varH) * sigmaScale;
  if (runnerUp && orientationMargin < QUALITY_THRESHOLDS.orientationMinMargin) {
    // Nothing decides between portrait and landscape: the truth is one of two answers, about equally
    // likely, so the spread between them (half the gap, as a standard deviation) is real uncertainty.
    sigmaWidthMm = Math.hypot(sigmaWidthMm, (runnerUp.widthMm - widthMm) / 2);
    sigmaHeightMm = Math.hypot(sigmaHeightMm, (runnerUp.heightMm - heightMm) / 2);
  }
  if (!Number.isFinite(sigmaWidthMm) || !Number.isFinite(sigmaHeightMm)) {
    return fail('degenerate', 'The sheet is too small in the photo to give a reliable scale.');
  }

  const inverse = invert3(planeToImage);
  if (!inverse) return fail('degenerate', 'The fitted view of the door is degenerate.');
  const imageToPlane = normaliseHomography(inverse);

  const cx = p[10] * S;
  const cy = p[11] * S;
  const cos = Math.cos(p[12]);
  const sin = Math.sin(p[12]);
  const doorFitPx = [{ x: 0, y: 0 }, { x: widthMm, y: 0 }, { x: widthMm, y: heightMm }, { x: 0, y: heightMm }].map((q) => applyHomography(planeToImage, q));
  const sheetFitPx = [];
  for (let i = 0; i < 4; i++) {
    const xi = (SHEET_SIGNS[2 * i] * best.a) / 2;
    const eta = (SHEET_SIGNS[2 * i + 1] * best.b) / 2;
    sheetFitPx.push(applyHomography(planeToImage, { x: cx + cos * xi - sin * eta, y: cy + sin * xi + cos * eta }));
  }
  let sumSq = 0;
  for (let i = 0; i < 4; i++) {
    sumSq += (doorFitPx[i].x - door[i].x) ** 2 + (doorFitPx[i].y - door[i].y) ** 2;
    sumSq += (sheetFitPx[i].x - sheet[i].x) ** 2 + (sheetFitPx[i].y - sheet[i].y) ** 2;
  }
  const rmsResidualPx = Math.sqrt(sumSq / 8);

  // Long sheet side closer to the door's vertical axis = portrait (a square sheet counts as portrait).
  const longX = best.a >= best.b ? cos : -sin;
  const longY = best.a >= best.b ? sin : cos;
  const sheetOrientation = square || Math.abs(longY) >= Math.abs(longX) ? 'portrait' : 'landscape';

  // Step 5: independent cross-check and quality.
  const sheetOnlyRaw = sheetOnlyEstimate(sheet, door, best.a, best.b);
  const sheetOnlySigmas = sheetOnlyRaw ? sheetOnlySigma(sheet, door, best.a, best.b, sigmaSheet, sigmaDoor, sheetOnlyRaw) : null;
  const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);
  const sheetOnly = sheetOnlyRaw
    ? { ...sheetOnlyRaw, valid: true, sigmaWidthMm: finiteOrNull(sheetOnlySigmas.sigmaWidthMm), sigmaHeightMm: finiteOrNull(sheetOnlySigmas.sigmaHeightMm) }
    : { widthTopMm: null, widthBottomMm: null, heightLeftMm: null, heightRightMm: null, widthMm: null, heightMm: null, valid: false, sigmaWidthMm: null, sigmaHeightMm: null };

  const quality = assessQuality({
    door,
    sheet,
    imageSize: input.imageSize,
    widthMm,
    heightMm,
    sigmaWidthMm,
    sigmaHeightMm,
    chi2,
    sheetOnly: sheetOnlyRaw,
    sheetOnlySigmas,
    plausible,
  });

  return {
    ok: true,
    widthMm,
    heightMm,
    sigmaWidthMm,
    sigmaHeightMm,
    rmsResidualPx,
    sheetOrientation,
    sheetOnly,
    imageToPlane,
    planeToImage,
    doorFitPx,
    sheetFitPx,
    quality,
    fit: { chi2, dof: FIT_DOF, iterations: best.iterations, sigmaScale, orientationMargin: Number.isFinite(orientationMargin) ? orientationMargin : null },
  };
}
