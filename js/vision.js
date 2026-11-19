// On-device image processing for SecureMeasure: sheet detection, sub-pixel corner refinement and the
// flattened door preview. Pure functions over typed arrays, no DOM, so the module also runs under Node.
//
// COORDINATES. Quads, seeds and homographies use continuous image coordinates, the same ones a canvas uses:
// pixel (i, j) covers the square [i, i+1) x [j, j+1) and its centre is at (i + 0.5, j + 0.5). A point the
// customer drags onto an edge on screen is therefore directly comparable with a quad returned from here.
// `sampleBilinear` is the one exception: it is a raw array lookup addressed by pixel index.

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ data: Uint8ClampedArray, width: number, height: number }} Image */
/** @typedef {{ data: Float32Array, width: number, height: number }} Luma */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------------------------------------------ */
/* Basics                                                                                                 */
/* ------------------------------------------------------------------------------------------------------ */

/**
 * Convert an RGBA image to Rec.601 luma (0..255, float).
 *
 * @param {Image} image
 * @returns {Luma}
 */
export function toLuma(image) {
  const { data, width, height } = image;
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return { data: out, width, height };
}

/**
 * Bilinear lookup in a luma plane, addressed by pixel index: (x, y) = (3, 7) returns exactly the value of
 * the pixel in column 3, row 7. Coordinates outside the plane are clamped to the border pixels.
 * To sample at a point given in continuous image coordinates (see the note at the top of this file), pass
 * (x - 0.5, y - 0.5).
 *
 * @param {Luma} luma
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function sampleBilinear(luma, x, y) {
  const { data, width, height } = luma;
  if (!(x > 0)) x = 0;
  else if (x > width - 1) x = width - 1;
  if (!(y > 0)) y = 0;
  else if (y > height - 1) y = height - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const r0 = y0 * width;
  const r1 = y1 * width;
  const top = data[r0 + x0] + (data[r0 + x1] - data[r0 + x0]) * fx;
  const bottom = data[r1 + x0] + (data[r1 + x1] - data[r1 + x0]) * fx;
  return top + (bottom - top) * fy;
}

/* ------------------------------------------------------------------------------------------------------ */
/* Small geometry helpers (kept local so this module has no imports)                                      */
/* ------------------------------------------------------------------------------------------------------ */

const copyQuad = (quad) => quad.map((p) => ({ x: p.x, y: p.y }));

/** Shoelace area; positive for [TL, TR, BR, BL] in image coordinates (y down). */
function signedArea(quad) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function isConvex(quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(Math.abs(cross) > 1e-9)) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Any 4 points -> [TL, TR, BR, BL]: clockwise on screen, starting at the corner with the smallest x + y. */
function orderCorners(points) {
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  const sorted = copyQuad(points).sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let first = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[first].x + sorted[first].y) first = i;
  }
  return [0, 1, 2, 3].map((i) => sorted[(first + i) % 4]);
}

/** Intersection of two lines given as { x, y, dx, dy }; null when (nearly) parallel. */
function intersectLines(l1, l2) {
  const den = l1.dx * l2.dy - l1.dy * l2.dx;
  if (!(Math.abs(den) > 1e-9)) return null;
  const t = ((l2.x - l1.x) * l2.dy - (l2.y - l1.y) * l2.dx) / den;
  return { x: l1.x + l1.dx * t, y: l1.y + l1.dy * t };
}

/** Move every side of a convex quad outwards by d (inwards when negative). */
function offsetQuad(quad, d) {
  const s = signedArea(quad) >= 0 ? 1 : -1;
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    lines.push({ x: p.x + ((s * dy) / len) * d, y: p.y - ((s * dx) / len) * d, dx, dy });
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersectLines(lines[(i + 3) % 4], lines[i]);
    if (!p) return copyQuad(quad);
    out.push(p);
  }
  return out;
}

/** Median of the first `count` entries of a typed array (which is left untouched). */
function medianOf(values, count) {
  if (count <= 0) return 0;
  const sorted = values.slice(0, count).sort();
  const mid = count >> 1;
  return count % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/* ------------------------------------------------------------------------------------------------------ */
/* refineQuad                                                                                             */
/* ------------------------------------------------------------------------------------------------------ */

// Edge profiles are sampled every half pixel along the side's normal and filtered with a derivative-of-
// Gaussian (sigma = 1 px). The filter is scaled so that an ideal step of height C gives a peak response of C,
// which lets contrast thresholds be expressed in grey levels.
const STEP = 0.5;
const EDGE_SIGMA_PX = 1;
const EDGE_KERNEL = (() => {
  const sigma = EDGE_SIGMA_PX / STEP;
  const half = Math.ceil(3 * sigma);
  const w = new Float32Array(half + 1);
  let sum = 0;
  for (let k = 1; k <= half; k++) {
    w[k] = k * Math.exp((-0.5 * k * k) / (sigma * sigma));
    sum += w[k];
  }
  for (let k = 1; k <= half; k++) w[k] /= sum;
  return w;
})();
const KERNEL_HALF = EDGE_KERNEL.length - 1;
// Std-dev of the edge-filter response per unit of white image noise (measured: 0.43 for long sides, where the
// three averaged profiles are independent, up to 0.7 for very short ones).
const RESPONSE_NOISE_GAIN = 0.5;

const isLumaSource = (source) => source.data instanceof Float32Array || source.data.length === source.width * source.height;

/**
 * Luma view of the part of `source` around a quad. For an RGBA source only the needed window is converted,
 * which keeps refineQuad cheap on a 5-megapixel photo.
 */
function lumaWindow(source, quad, pad) {
  const W = source.width;
  const H = source.height;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of quad) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const x0 = clamp(Math.floor(minX - pad), 0, W - 1);
  const y0 = clamp(Math.floor(minY - pad), 0, H - 1);
  const x1 = clamp(Math.ceil(maxX + pad), x0 + 1, W);
  const y1 = clamp(Math.ceil(maxY + pad), y0 + 1, H);
  if (isLumaSource(source)) {
    return { data: source.data, width: W, height: H, ox: 0, oy: 0, rx0: x0, ry0: y0, rx1: x1, ry1: y1 };
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Float32Array(w * h);
  const src = source.data;
  for (let y = 0; y < h; y++) {
    let j = ((y + y0) * W + x0) * 4;
    const row = y * w;
    for (let x = 0; x < w; x++, j += 4) {
      out[row + x] = 0.299 * src[j] + 0.587 * src[j + 1] + 0.114 * src[j + 2];
    }
  }
  return { data: out, width: w, height: h, ox: x0, oy: y0, rx0: 0, ry0: 0, rx1: w, ry1: h };
}

/** Bilinear sample of a luma window at a point in continuous image coordinates. */
function sampleWindow(win, x, y) {
  const { data, width, height } = win;
  let fx = x - 0.5 - win.ox;
  let fy = y - 0.5 - win.oy;
  if (!(fx > 0)) fx = 0;
  else if (fx > width - 1) fx = width - 1;
  if (!(fy > 0)) fy = 0;
  else if (fy > height - 1) fy = height - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  fx -= x0;
  fy -= y0;
  const r0 = y0 * width;
  const r1 = y1 * width;
  const top = data[r0 + x0] + (data[r0 + x1] - data[r0 + x0]) * fx;
  const bottom = data[r1 + x0] + (data[r1 + x1] - data[r1 + x0]) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Robust image-noise estimate (grey levels, 1 sigma) over the window's region of interest: the median
 * response of a 3x3 mask that cancels constant, linear and step-edge structure. Texture such as wood grain
 * counts as noise here, which is what the edge search wants.
 */
function estimateNoise(win) {
  const { data, width } = win;
  const x0 = win.rx0 + 1;
  const y0 = win.ry0 + 1;
  const x1 = win.rx1 - 1;
  const y1 = win.ry1 - 1;
  if (x1 - x0 < 2 || y1 - y0 < 2) return 0;
  const stride = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  const values = new Float32Array(Math.ceil((x1 - x0) / stride) * Math.ceil((y1 - y0) / stride));
  let n = 0;
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = y * width + x;
      const lap =
        4 * data[i] -
        2 * (data[i - 1] + data[i + 1] + data[i - width] + data[i + width]) +
        data[i - width - 1] +
        data[i - width + 1] +
        data[i + width - 1] +
        data[i + width + 1];
      values[n++] = lap < 0 ? -lap : lap;
    }
  }
  return medianOf(values, n) / (0.6745 * 6);
}

/**
 * Robust straight-line fit s = a + b*u through edge points (u along the side, s across it; sorted by u).
 * A truncated-least-squares consensus search over point pairs finds the dominant line, then Tukey-weighted
 * least squares polishes it. Returns null when there are too few points.
 *
 * The consensus band is as tight as the data allows: the point noise is estimated from the jitter between
 * neighbouring points, which a smooth systematic drift does not inflate. So when part of a side is pulled
 * off by something almost touching it (a door groove running into the sheet's edge), the clean part still
 * wins instead of the fit settling on a tilted compromise. `tol` is the widest band allowed and the band
 * used for the reported inlier count and RMS.
 */
function robustLine(us, ss, n, tol) {
  if (n < 4) return null;
  let fitTol = tol;
  if (n >= 6) {
    const jitter = new Float64Array(n - 1);
    for (let k = 0; k < n - 1; k++) jitter[k] = ss[k + 1] - ss[k];
    const mid = medianOf(jitter, n - 1);
    for (let k = 0; k < n - 1; k++) jitter[k] = Math.abs(jitter[k] - mid);
    const sigma = (1.4826 * medianOf(jitter, n - 1)) / Math.SQRT2;
    fitTol = clamp(3 * sigma, Math.min(0.2, tol), tol);
  }
  const tol2 = fitTol * fitTol;
  const minGap = 0.3 * (us[n - 1] - us[0]);
  // Candidate lines come from pairs of points; with many samples per edge only every stride-th point is
  // used as a pair member, which keeps the search at a few thousand pairs.
  const stride = Math.max(1, Math.floor(n / 48));
  let bestScore = Infinity;
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride; j < n; j += stride) {
      const du = us[j] - us[i];
      if (du < minGap || du <= 0) continue;
      const slope = (ss[j] - ss[i]) / du;
      const icpt = ss[i] - slope * us[i];
      let score = 0;
      for (let k = 0; k < n && score < bestScore; k++) {
        const r = ss[k] - icpt - slope * us[k];
        const r2 = r * r;
        score += r2 < tol2 ? r2 : tol2;
      }
      if (score < bestScore) {
        bestScore = score;
        a = icpt;
        b = slope;
      }
    }
  }
  if (!Number.isFinite(bestScore)) return null;

  const u0 = 0.5 * (us[0] + us[n - 1]);
  const absRes = new Float64Array(n);
  for (let iter = 0; iter < 4; iter++) {
    let m = 0;
    for (let k = 0; k < n; k++) {
      const r = Math.abs(ss[k] - a - b * us[k]);
      if (r <= fitTol) absRes[m++] = r;
    }
    if (m < 3) break;
    const scale = 1.4826 * medianOf(absRes, m);
    const cut = clamp(4.685 * scale, fitTol, Math.max(fitTol, Math.min(tol, 1.5 * fitTol)));
    let sw = 0;
    let swu = 0;
    let swuu = 0;
    let sws = 0;
    let swus = 0;
    for (let k = 0; k < n; k++) {
      const r = (ss[k] - a - b * us[k]) / cut;
      if (r <= -1 || r >= 1) continue;
      const w = (1 - r * r) * (1 - r * r);
      const u = us[k] - u0;
      sw += w;
      swu += w * u;
      swuu += w * u * u;
      sws += w * ss[k];
      swus += w * u * ss[k];
    }
    const det = sw * swuu - swu * swu;
    if (!(det > 1e-9)) break;
    b = (sw * swus - swu * sws) / det;
    a = (sws - b * swu) / sw - b * u0;
  }

  let inliers = 0;
  let sumSq = 0;
  for (let k = 0; k < n; k++) {
    const r = ss[k] - a - b * us[k];
    if (r >= -tol && r <= tol) {
      inliers++;
      sumSq += r * r;
    }
  }
  return { a, b, inliers, rms: inliers ? Math.sqrt(sumSq / inliers) : 0 };
}

// A response sample counts as a distinct peak when nothing within 2 px of it is higher. Plain neighbour
// comparison is not enough: on a blurred, noisy edge the response bump carries small wiggles, and picking
// "the nearest local maximum" among those would drag the result towards the initial guess.
const PEAK_SEPARATION = Math.round(2 / STEP);
// How far from an edge (in samples) a step of the opposite sign still distorts its response noticeably.
const LOBE_REACH = Math.round(5 / STEP);
// Responses are computed this many samples beyond the search window on both sides, so that neighbouring
// structure is visible (and can be modelled) even when the window itself has shrunk to a few pixels.
const RESPONSE_MARGIN = LOBE_REACH + 4;

function isDistinctPeak(resp, row, q, M) {
  const v = resp[row + q];
  const lo = q - PEAK_SEPARATION < 0 ? 0 : q - PEAK_SEPARATION;
  const hi = q + PEAK_SEPARATION > M - 1 ? M - 1 : q + PEAK_SEPARATION;
  for (let k = lo; k < q; k++) if (resp[row + k] >= v) return false;
  for (let k = q + 1; k <= hi; k++) if (resp[row + k] > v) return false;
  return true;
}

/**
 * Fit a Gaussian bump to v[base .. base+len) around index q: a parabola through the logarithm of every
 * sample above half the peak height, weighted by the squared value (which undoes the noise amplification of
 * the logarithm). Using the whole top half of the bump rather than three samples matters on blurred, noisy
 * edges. Returns { centre, sigma, amp } in sample units relative to `base`, or null when there is no usable
 * bump at q.
 */
function fitBump(v, base, len, q) {
  const peak = v[base + q];
  if (!(peak > 0)) return null;
  const level = 0.5 * peak;
  let lo = q;
  let hi = q;
  while (lo > 0 && q - lo < 10 && v[base + lo - 1] > level) lo--;
  while (hi < len - 1 && hi - q < 10 && v[base + hi + 1] > level) hi++;
  if (lo === q && q > 0 && v[base + q - 1] > 0) lo--;
  if (hi === q && q < len - 1 && v[base + q + 1] > 0) hi++;
  if (hi - lo < 2) return null;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (let k = lo; k <= hi; k++) {
    const value = v[base + k];
    const x = k - q;
    const w = value * value;
    const l = Math.log(value);
    const wx = w * x;
    const wxx = wx * x;
    s0 += w;
    s1 += wx;
    s2 += wxx;
    s3 += wxx * x;
    s4 += wxx * x * x;
    t0 += w * l;
    t1 += wx * l;
    t2 += wxx * l;
  }
  // Normal equations of the weighted fit l = a + b x + c x^2, solved by Cramer's rule.
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (!(Math.abs(det) > 1e-12 * s0 * s2 * s4)) return null;
  const a = (t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2)) / det;
  const b = (s0 * (t1 * s4 - s3 * t2) - t0 * (s1 * s4 - s3 * s2) + s2 * (s1 * t2 - t1 * s2)) / det;
  const c = (s0 * (s2 * t2 - t1 * s3) - s1 * (s1 * t2 - t1 * s2) + t0 * (s1 * s3 - s2 * s2)) / det;
  if (!(c < 0)) return null;
  const limit = 0.5 * (hi - lo) + 1;
  const offset = clamp(-b / (2 * c), -limit, limit);
  return { centre: q + offset, sigma: Math.sqrt(-0.5 / c), amp: Math.exp(a - (b * b) / (4 * c)) };
}

/**
 * Solve the n x n system A x = b in place by Gaussian elimination with partial pivoting (A row-major).
 * Returns false when the matrix is singular; on success b holds the solution.
 */
function solveLinear(A, b, n) {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]) > Math.abs(A[pivot * n + col])) pivot = r;
    if (!(Math.abs(A[pivot * n + col]) > 1e-12)) return false;
    if (pivot !== col) {
      for (let c = col; c < n; c++) {
        const tmp = A[col * n + c];
        A[col * n + c] = A[pivot * n + c];
        A[pivot * n + c] = tmp;
      }
      const tmp = b[col];
      b[col] = b[pivot];
      b[pivot] = tmp;
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / A[col * n + col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= A[r * n + c] * b[c];
    b[r] = sum / A[r * n + r];
  }
  return true;
}

/**
 * Sub-sample position (as a fractional index into the profile's responses) of the edge whose response
 * peaks at index q.
 *
 * An isolated edge gives a symmetric bump and its centre is the answer. A step of the opposite sign close
 * by (the far side of the thin shadow a sheet casts on the door, or a sharpening halo) overlaps that bump
 * with a negative lobe and pushes its apparent centre away, by up to a pixel. When such lobes are present
 * the response is therefore fitted as a whole: the edge's Gaussian bump minus one Gaussian lobe on either
 * side, all of the same width because the same blur made them (Levenberg-Marquardt, a handful of steps).
 */
function locatePeak(resp, row, q, M, noiseLevel) {
  const isolated = fitBump(resp, row, M, q);
  if (!isolated) return q;
  const lo = q - RESPONSE_MARGIN < 0 ? 0 : q - RESPONSE_MARGIN;
  const hi = q + RESPONSE_MARGIN > M - 1 ? M - 1 : q + RESPONSE_MARGIN;
  // Parameters: [A, e, sigma, B1, e1, (B2, e2)] for  A g(k; e) - B1 g(k; e1) - B2 g(k; e2).
  const p = [isolated.amp, isolated.centre, isolated.sigma];
  const threshold = -Math.max(0.08 * resp[row + q], noiseLevel);
  for (const dir of [-1, 1]) {
    let deepest = threshold;
    let at = -1;
    for (let k = q + dir; k >= lo && k <= hi && (k - q) * dir <= LOBE_REACH; k += dir) {
      if (resp[row + k] < deepest) {
        deepest = resp[row + k];
        at = k;
      }
    }
    if (at >= 0) p.push(-deepest, at);
  }
  const n = p.length;
  if (n === 3) return isolated.centre;

  const sigmaMin = 0.6 * isolated.sigma;
  const sigmaMax = 1.6 * isolated.sigma;
  const cost = (params) => {
    let total = 0;
    for (let k = lo; k <= hi; k++) {
      let model = 0;
      for (let j = 0; j < n; j += j === 0 ? 3 : 2) {
        const z = (k - params[j + 1]) / params[2];
        model += (j === 0 ? params[0] : -params[j]) * Math.exp(-0.5 * z * z);
      }
      const d = resp[row + k] - model;
      total += d * d;
    }
    return total;
  };

  const JtJ = new Float64Array(n * n);
  const Jtr = new Float64Array(n);
  const grad = new Float64Array(n);
  const damped = new Float64Array(n * n);
  const delta = new Float64Array(n);
  const trial = new Array(n);
  let current = cost(p);
  let lambda = 1e-2;
  for (let step = 0; step < 12; step++) {
    JtJ.fill(0);
    Jtr.fill(0);
    const sigma = p[2];
    for (let k = lo; k <= hi; k++) {
      let model = 0;
      grad[2] = 0;
      for (let j = 0; j < n; j += j === 0 ? 3 : 2) {
        const amp = j === 0 ? p[0] : -p[j];
        const u = (k - p[j + 1]) / sigma;
        const g = Math.exp(-0.5 * u * u);
        model += amp * g;
        grad[j] = j === 0 ? g : -g;
        grad[j + 1] = (amp * g * u) / sigma;
        grad[2] += (amp * g * u * u) / sigma;
      }
      const d = resp[row + k] - model;
      for (let a = 0; a < n; a++) {
        Jtr[a] += grad[a] * d;
        for (let b = a; b < n; b++) JtJ[a * n + b] += grad[a] * grad[b];
      }
    }
    // Take a damped step, raising the damping until the fit actually improves.
    let gain = -1;
    for (let attempt = 0; attempt < 4 && gain < 0; attempt++) {
      for (let a = 0; a < n; a++) {
        for (let b = a; b < n; b++) {
          damped[a * n + b] = JtJ[a * n + b];
          damped[b * n + a] = JtJ[a * n + b];
        }
        damped[a * n + a] *= 1 + lambda;
        delta[a] = Jtr[a];
      }
      if (solveLinear(damped, delta, n)) {
        for (let a = 0; a < n; a++) trial[a] = p[a] + delta[a];
        trial[2] = clamp(trial[2], sigmaMin, sigmaMax);
        for (let j = 3; j < n; j += 2) if (trial[j] < 0) trial[j] = 0;
        const next = cost(trial);
        if (next < current) {
          gain = current - next;
          current = next;
          for (let a = 0; a < n; a++) p[a] = trial[a];
          lambda *= 0.3;
          continue;
        }
      }
      lambda *= 10;
    }
    if (gain < 1e-4 * current) break;
  }
  // The correction is a fraction of a pixel in every legitimate case; anything larger means the model did
  // not fit, and the plain estimate is the safer one.
  return Math.abs(p[1] - isolated.centre) <= 1.5 / STEP ? p[1] : isolated.centre;
}

/**
 * Sample luminance profiles across the current guess A->B of one side and filter them into edge responses.
 * Returns null for a side too short to measure. In the result, resp[j * M + q] is the signed step height of
 * profile j at offset (q - centre) * STEP along the side's normal; edges are searched for within
 * [first, last].
 */
function sampleSide(win, A, B, radius, cfg) {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 2)) return null;
  const ux = dx / length;
  const uy = dy / length;
  const nx = uy;
  const ny = -ux;

  // Response index q corresponds to the offset (q - centre) * STEP along the normal. Edges are searched for
  // within [first, last]; the responses extend RESPONSE_MARGIN samples further on both sides.
  const half = Math.max(2, Math.round(radius / STEP));
  const centre = half + RESPONSE_MARGIN;
  const first = RESPONSE_MARGIN + 1;
  const last = RESPONSE_MARGIN + 2 * half - 1;
  const M = 2 * centre + 1;
  const N = cfg.samples;
  const profile = new Float32Array(M + 2 * KERNEL_HALF);
  const resp = new Float32Array(N * M);
  const ts = new Float64Array(N);
  // Each profile is the mean of three parallel ones a pixel or so apart along the side: more of the edge's
  // pixels contribute, which cuts the noise without blurring across the edge.
  const tangentStep = clamp(((1 - 2 * cfg.margin) * length) / N / 3, 0.5, 1.25);
  const tx = ux * tangentStep;
  const ty = uy * tangentStep;
  for (let j = 0; j < N; j++) {
    const t = cfg.margin + ((1 - 2 * cfg.margin) * (j + 0.5)) / N;
    ts[j] = t;
    const px = A.x + dx * t;
    const py = A.y + dy * t;
    for (let q = 0; q < profile.length; q++) {
      const s = (q - centre - KERNEL_HALF) * STEP;
      const x = px + nx * s;
      const y = py + ny * s;
      profile[q] = (sampleWindow(win, x - tx, y - ty) + sampleWindow(win, x, y) + sampleWindow(win, x + tx, y + ty)) / 3;
    }
    const row = j * M;
    for (let q = 0; q < M; q++) {
      const c = q + KERNEL_HALF;
      let r = 0;
      for (let k = 1; k <= KERNEL_HALF; k++) r += EDGE_KERNEL[k] * (profile[c + k] - profile[c - k]);
      resp[row + q] = r;
    }
  }
  return { A, length, ux, uy, nx, ny, centre, first, last, M, N, resp, ts };
}

/**
 * How strongly one side's profiles show steps of each sign near the initial guess: per profile the
 * strongest step of either sign, weighted down with distance from the guess, summed over the profiles.
 */
function polarityEvidence(side, radius) {
  const { centre, first, last, M, N, resp } = side;
  const prior = new Float32Array(M);
  const sigma = 0.6 * radius;
  for (let q = first; q <= last; q++) {
    const s = (q - centre) * STEP;
    prior[q] = Math.exp((-0.5 * s * s) / (sigma * sigma));
  }
  let pos = 0;
  let neg = 0;
  for (let j = 0; j < N; j++) {
    const row = j * M;
    let bestPos = 0;
    let bestNeg = 0;
    for (let q = first; q <= last; q++) {
      const v = resp[row + q] * prior[q];
      if (v > bestPos) bestPos = v;
      else if (-v > bestNeg) bestNeg = -v;
    }
    pos += bestPos;
    neg += bestNeg;
  }
  return { pos, neg };
}

// A dissenting side is overruled when its steps of the common sign reach this share of its preferred ones.
const POLARITY_OVERRULE_SHARE = 0.4;

/**
 * One polarity per side, from each side's own evidence (null for an unusable side), then reconciled.
 *
 * Each side prefers whichever sign has the stronger steps near the initial guess. But a sheet is lighter (or
 * darker) than what lies right beside it all the way round, so its four sides step the same way. When three
 * sides agree and the fourth prefers the opposite sign while still showing clear steps of the common one, it
 * has been drawn to the far edge of the shadow line beside the paper (or a moulding next to it), which runs
 * a few pixels off the paper's own edge: common on a pale door, where the paper's outline and its shadow
 * are about equally strong. That side is brought into line. A side whose own sign dominates outright (a
 * sheet lying across a two-tone surface) is left alone, as is a two-against-two split.
 */
function agreePolarities(evidence) {
  const own = evidence.map((e) => (e && e.neg > e.pos ? -1 : 1));
  if (evidence.some((e) => !e)) return own;
  const votes = own[0] + own[1] + own[2] + own[3];
  if (votes !== 2 && votes !== -2) return own;
  const common = votes > 0 ? 1 : -1;
  return own.map((sign, i) => {
    if (sign === common) return sign;
    const forCommon = common > 0 ? evidence[i].pos : evidence[i].neg;
    const forOwn = common > 0 ? evidence[i].neg : evidence[i].pos;
    return forCommon >= POLARITY_OVERRULE_SHARE * forOwn ? common : sign;
  });
}

/**
 * Locate one sampled side: pick one step edge of the given polarity per profile and fit a line through them.
 */
function fitSide(side, radius, cfg, polarity) {
  const result = { ok: false, inlierRatio: 0, rms: 0, line: null };
  const { A, length, ux, uy, nx, ny, centre, first, last, M, N, resp, ts } = side;
  if (polarity < 0) for (let i = 0; i < resp.length; i++) resp[i] = -resp[i];

  // Strongest distinct peak per profile, and the side's typical edge strength.
  const peakMax = new Float32Array(N);
  for (let j = 0; j < N; j++) {
    const row = j * M;
    let best = 0;
    for (let q = first; q <= last; q++) {
      const v = resp[row + q];
      if (v > best && isDistinctPeak(resp, row, q, M)) best = v;
    }
    peakMax[j] = best;
  }
  const sideStrength = medianOf(peakMax, N);

  // Per profile: of the steps that are substantial (relative to the strongest one in that profile and to the
  // side as a whole), take the one NEAREST the initial guess. This is what stops a stronger parallel edge a
  // bit further away (a door moulding, the sheet's shadow) from capturing the side.
  const us = new Float64Array(N);
  const ss = new Float64Array(N);
  let count = 0;
  for (let j = 0; j < N; j++) {
    if (peakMax[j] < cfg.floor) continue;
    const threshold = Math.max(cfg.floor, 0.45 * peakMax[j], 0.3 * sideStrength);
    const row = j * M;
    let bestQ = -1;
    let bestDist = Infinity;
    for (let q = first; q <= last; q++) {
      if (resp[row + q] < threshold || !isDistinctPeak(resp, row, q, M)) continue;
      const dist = q > centre ? q - centre : centre - q;
      if (dist < bestDist) {
        bestDist = dist;
        bestQ = q;
      }
    }
    if (bestQ < 0) continue;
    us[count] = ts[j] * length;
    ss[count] = (locatePeak(resp, row, bestQ, M, 0.5 * cfg.floor) - centre) * STEP;
    count++;
  }

  const fit = robustLine(us, ss, count, clamp(radius / 3, 0.75, 2));
  if (!fit) return result;
  result.ok = true;
  result.inlierRatio = fit.inliers / N;
  result.rms = fit.rms;
  result.line = { x: A.x + nx * fit.a, y: A.y + ny * fit.a, dx: ux + nx * fit.b, dy: uy + ny * fit.b };
  return result;
}

/** Bilinear Y, Cb, Cr of an RGBA image at a point in continuous image coordinates, written to out[0..2]. */
function sampleYCC(image, x, y, out) {
  const { data, width, height } = image;
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (!(fx > 0)) fx = 0;
  else if (fx > width - 1) fx = width - 1;
  if (!(fy > 0)) fy = 0;
  else if (fy > height - 1) fy = height - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  fx -= x0;
  fy -= y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const a = (y0 * width + x0) * 4;
  const b = (y0 * width + x1) * 4;
  const c = (y1 * width + x0) * 4;
  const d = (y1 * width + x1) * 4;
  const red = data[a] * w00 + data[b] * w10 + data[c] * w01 + data[d] * w11;
  const green = data[a + 1] * w00 + data[b + 1] * w10 + data[c + 1] * w01 + data[d + 1] * w11;
  const blue = data[a + 2] * w00 + data[b + 2] * w10 + data[c + 2] * w01 + data[d + 2] * w11;
  const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
  out[0] = luma;
  out[1] = 0.564 * (blue - luma);
  out[2] = 0.713 * (red - luma);
}

// Two colours count as the same surface when one lies inside an ellipse around the other: generous in luma,
// so a lighting gradient across the paper is tolerated, tighter in chroma.
const lumaTolerance = (y) => clamp(0.3 * y, 30, 70);
const chromaTolerance = (y) => 12 + 0.05 * y;

/** Is `colour` the same surface as `reference`? Both are [Y, Cb, Cr]. */
function sameSurface(reference, colour) {
  const tolC = chromaTolerance(reference[0]);
  const dy = (colour[0] - reference[0]) / lumaTolerance(reference[0]);
  const db = (colour[1] - reference[1]) / tolC;
  const dr = (colour[2] - reference[2]) / tolC;
  return dy * dy + db * db + dr * dr <= 1;
}

/** Could `colour` be `surface` in shade: no lighter, and the same hue dimmed? Both are [Y, Cb, Cr]. */
function isShadeOf(surface, colour) {
  const dim = colour[0] / Math.max(1, surface[0]);
  const tolC = chromaTolerance(colour[0]);
  return dim <= 1.05 && Math.abs(colour[1] - dim * surface[1]) <= tolC && Math.abs(colour[2] - dim * surface[2]) <= tolC;
}

// The strips compared with the sheet's own colour lie this far to either side of a fitted side: near enough
// to be inside a shadow only a few pixels wide. A third strip, further out and clear of the edge's own
// blur, shows the door undisturbed. A fourth, further in (this share of the shortest side, and at least
// SIDE_PAPER_MIN_PX), shows the paper on the same side, clear of such a shadow but lit as the side is.
const SIDE_STRIP_PX = 2;
const SIDE_CLEAR_PX = 7.5;
const SIDE_PAPER_FRAC = 0.08;
const SIDE_PAPER_MIN_PX = 8;
const SIDE_PROBES = 16;
const INTERIOR_GRID = [0.2, 0.35, 0.5, 0.65, 0.8];

// How much darker than the paper beside it a strip inside a side must be to count as a shadow there:
// well clear of noise, print and the lighting across a few pixels of paper.
const dipTolerance = (y) => Math.max(8, 0.06 * y);
// The faint shadows that test is for leave the door at least this share of its light. (A darker one is
// far enough from a pale sheet's colour for sameSurface to tell.)
const SHADOW_MIN_SHARE = 0.55;

/**
 * Find the sides of a fitted quad that lie on the far edge of the sheet's shadow instead of on the paper.
 *
 * Edges are found from luminance alone. A coloured sheet on a pale door can be as dark as the shadow it
 * casts, so its own edge is a faint step (or none) beside the strong one at the shadow's far edge, and a
 * side settles there, a shadow-width outside the paper, with a perfectly straight and well supported fit.
 * Colour gives it away: the strip just inside such a side is not the sheet's colour but that of the door
 * just outside it, in shade (and not merely the edge's own blur). The sheet's colour is the median over the
 * middle of the quad and each strip's the median along the middle of its side, so print, a crease or tape
 * covering part of them does not matter.
 *
 * That comparison allows for the light changing across the paper, so it misses a pale, pastel or grey
 * sheet, whose shadow is the same sort of colour only a little darker. Such a side gives itself away
 * locally instead: somewhere between it and the paper a little further in on the same side there is a
 * band darker than that paper and no lighter than the door outside the side, and blur alone never makes
 * a dip like that. (A sharpening halo can, but it puts a matching bright rim on the door's side, which is
 * allowed for.) A sheet about as dark as its own shadow, and no different in colour, still gets past.
 *
 * @param {Image} image  RGBA
 * @param {Point[]} quad
 * @returns {{ sheet: number[], shadow: (number[] | null)[] }}  sheet: the sheet's colour as [Y, Cb, Cr];
 *   shadow[i]: the shadow's colour found inside the side from corner i to corner i+1 when that side lies
 *   on the shadow's edge, null when it is on the sheet
 */
function sidesOnShadow(image, quad) {
  const ycc = [0, 0, 0];
  const samples = [0, 1, 2].map(() => new Float32Array(25));
  let n = 0;
  for (const u of INTERIOR_GRID) {
    for (const v of INTERIOR_GRID) {
      const topX = quad[0].x + (quad[1].x - quad[0].x) * u;
      const topY = quad[0].y + (quad[1].y - quad[0].y) * u;
      const bottomX = quad[3].x + (quad[2].x - quad[3].x) * u;
      const bottomY = quad[3].y + (quad[2].y - quad[3].y) * u;
      sampleYCC(image, topX + (bottomX - topX) * v, topY + (bottomY - topY) * v, ycc);
      for (let c = 0; c < 3; c++) samples[c][n] = ycc[c];
      n++;
    }
  }
  const sheet = samples.map((values) => medianOf(values, n));

  let shortest = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    shortest = Math.min(shortest, Math.hypot(q.x - p.x, q.y - p.y));
  }
  const paperDepth = Math.max(SIDE_PAPER_MIN_PX, SIDE_PAPER_FRAC * shortest);

  const inward = signedArea(quad) >= 0 ? 1 : -1;
  const shadow = [null, null, null, null];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Unit normal pointing into the quad.
    const nx = (-inward * dy) / len;
    const ny = (inward * dx) / len;
    // The colour along the side, `depth` px in from it (out from it when negative).
    const strip = (depth) => {
      for (let k = 0; k < SIDE_PROBES; k++) {
        const t = 0.2 + (0.6 * (k + 0.5)) / SIDE_PROBES;
        sampleYCC(image, a.x + dx * t + nx * depth, a.y + dy * t + ny * depth, ycc);
        for (let c = 0; c < 3; c++) samples[c][k] = ycc[c];
      }
      return samples.map((values) => medianOf(values, SIDE_PROBES));
    };
    // Strips just inside the side, just outside it, and further out.
    const inside = strip(SIDE_STRIP_PX);
    const outside = strip(-SIDE_STRIP_PX);
    const beyond = strip(-SIDE_CLEAR_PX);
    // In a soft photo the door's colour is blurred in across the sheet's real edge, and takes as much
    // out of the strip on the door's side: what the strip inside would be if that were all.
    const blurred = sheet.map((value, c) => value + beyond[c] - outside[c]);
    if (!sameSurface(sheet, inside) && isShadeOf(outside, inside) && !sameSurface(blurred, inside)) {
      shadow[i] = inside;
      continue;
    }
    // A shadow darker than the paper, anywhere between the side and the paper further in. (A soft one can
    // be lighter at its far edge, where the side settled, than nearer the paper.) Blur only ever blends the
    // door into the paper, never makes the paper darker than both. A sharpening halo can: it darkens the
    // paper's side of an edge as much as it lightens the door's side, so that much is let off, and a band
    // darker than any such shadow (where the light rim is lost to white) is left to the test above.
    const paper = strip(paperDepth);
    const tolerance = dipTolerance(paper[0]);
    let darkest = null;
    for (let depth = SIDE_STRIP_PX; depth <= paperDepth - SIDE_STRIP_PX; depth++) {
      const band = depth === SIDE_STRIP_PX ? inside : strip(depth);
      if (!(paper[0] - band[0] > tolerance) || band[0] < SHADOW_MIN_SHARE * beyond[0] || !isShadeOf(outside, band)) continue;
      // The light rim a halo would leave on the door's side, the same distance out.
      const halo = Math.max(0, (depth === SIDE_STRIP_PX ? outside : strip(-depth))[0] - beyond[0]);
      if (paper[0] - band[0] - halo > tolerance && !(darkest && darkest[0] <= band[0])) darkest = band;
    }
    if (darkest) shadow[i] = darkest;
  }
  return { sheet, shadow };
}

/**
 * Move the sides of a fitted quad that lie on the far edge of the sheet's shadow (see sidesOnShadow) in to
 * where the sheet's own colour begins: along each such side, walk inwards to the point half-way between
 * the shadow's colour and the sheet's, and put a line through those points.
 *
 * @param {Image} image  RGBA
 * @param {Point[]} quad
 * @param {number[]} sheet  the sheet's colour, [Y, Cb, Cr]
 * @param {(number[] | null)[]} shadow  per side, the shadow's colour, or null for a side to leave alone
 * @returns {Point[] | null}  the corrected quad in the same corner order; null when the paper's edge was
 *   not found that way
 */
function ontoSheet(image, quad, sheet, shadow) {
  const inward = signedArea(quad) >= 0 ? 1 : -1;
  const tolY = lumaTolerance(sheet[0]);
  const tolC = chromaTolerance(sheet[0]);
  let shortest = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    shortest = Math.min(shortest, Math.hypot(q.x - p.x, q.y - p.y));
  }
  const deepest = clamp(0.25 * shortest, 8, 40);
  // As far in as sidesOnShadow looks for the shadow.
  const shadowReach = Math.max(SIDE_PAPER_MIN_PX, SIDE_PAPER_FRAC * shortest) - SIDE_STRIP_PX;
  const ycc = [0, 0, 0];
  const us = new Float64Array(SIDE_PROBES);
  const ss = new Float64Array(SIDE_PROBES);
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (!shadow[i]) {
      lines.push({ x: a.x, y: a.y, dx, dy });
      continue;
    }
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-inward * dy) / len;
    const ny = (inward * dx) / len;
    // Axis from the sheet's colour to the shadow's, weighted like sameSurface. A colour's place along it:
    // 0 = sheet, 1 = shadow.
    const ay = (shadow[i][0] - sheet[0]) / (tolY * tolY);
    const ab = (shadow[i][1] - sheet[1]) / (tolC * tolC);
    const ar = (shadow[i][2] - sheet[2]) / (tolC * tolC);
    const span = ay * (shadow[i][0] - sheet[0]) + ab * (shadow[i][1] - sheet[1]) + ar * (shadow[i][2] - sheet[2]);
    let count = 0;
    for (let k = 0; k < SIDE_PROBES; k++) {
      const t = 0.2 + (0.6 * (k + 0.5)) / SIDE_PROBES;
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      // A soft shadow can be lighter at its far edge than nearer the paper, so the walk may start on a
      // colour nearer the sheet's and only then reach the shadow. A probe that does not reach it within
      // the reach sidesOnShadow looked in (print, tape) has no crossing and is skipped.
      let before = null;
      for (let depth = SIDE_STRIP_PX; depth <= deepest; depth += STEP) {
        sampleYCC(image, px + nx * depth, py + ny * depth, ycc);
        const now = (ay * (ycc[0] - sheet[0]) + ab * (ycc[1] - sheet[1]) + ar * (ycc[2] - sheet[2])) / span;
        if (now >= 0.5) {
          before = now;
        } else if (before !== null) {
          us[count] = t * len;
          ss[count] = depth - (STEP * (0.5 - now)) / (before - now);
          count++;
          break;
        } else if (depth >= shadowReach) {
          break;
        }
      }
    }
    const fit = robustLine(us, ss, count, 1.5);
    if (!fit || fit.inliers < 0.6 * SIDE_PROBES) return null;
    lines.push({ x: a.x + nx * fit.a, y: a.y + ny * fit.a, dx: dx / len + nx * fit.b, dy: dy / len + ny * fit.b });
  }
  const moved = [];
  for (let i = 0; i < 4; i++) {
    const corner = intersectLines(lines[(i + 3) % 4], lines[i]);
    if (!corner) return null;
    moved.push(corner);
  }
  if (!isConvex(moved) || signedArea(moved) * inward <= 0) return null;
  // What comes back must itself pass the test the fitted quad failed.
  return sidesOnShadow(image, moved).shadow.some(Boolean) ? null : moved;
}

/**
 * Snap a roughly placed quad onto the real edges of a sheet with sub-pixel precision.
 *
 * Each side is located independently from luminance step edges found across it (ignoring the stretch near
 * each corner, so tape, dog-ears and rounded corners do not matter), fitted with a robust straight line, and
 * the corners are the intersections of adjacent lines. Works for a light sheet on a dark surface and the
 * reverse: the polarity is detected per side, and a lone side that disagrees with the other three without
 * good reason is overruled (see agreePolarities).
 *
 * Luminance cannot tell the edge of a coloured sheet from the far edge of the shadow it casts on a pale
 * door. Given the RGBA image, the result is therefore checked against colour as well and refused
 * ('off_sheet') when a side has settled on the shadow (see sidesOnShadow). A luma plane carries no colour,
 * so pass the photo itself wherever that matters.
 *
 * @param {Image | Luma} source  RGBA image or precomputed luma plane
 * @param {Point[]} quad         4 corners in order around the quad (continuous image coordinates)
 * @param {object} [opts]
 * @param {number} [opts.searchRadiusPx]   how far from the initial side an edge may be; default
 *        clamp(0.12 * shortest side, 4, 24)
 * @param {number} [opts.samplesPerEdge=48]
 * @param {number} [opts.cornerMarginFrac=0.15]  fraction of each side ignored at both ends
 * @param {number} [opts.iterations=2]     passes; the search radius shrinks after the first
 * @param {number} [opts.minContrast=6]    smallest luminance step (grey levels) accepted as an edge
 * @param {boolean} [opts.checkColour=true]  false skips the colour check made on an RGBA source
 * @returns {{ ok: boolean, quad: Point[], shiftsPx: number[], edgeRmsPx: number[], inlierRatio: number[], reason?: string }}
 *   quad: refined corners in the input order (the unchanged input when ok is false).
 *   shiftsPx[i]: how far corner i moved. edgeRmsPx[i] / inlierRatio[i]: fit quality of the side from corner i
 *   to corner i+1 (RMS distance of the edge points from the fitted line; share of the samples that support
 *   it). When ok is false these describe the attempt that was rejected.
 *   reason (when not ok): 'bad_input' | 'degenerate' (unusable quad) | 'weak_edge' (a side with inlierRatio
 *   under 0.6) | 'ragged_edge' (edge RMS over 1.5 px) | 'corner_moved' (a corner moved more than 1.5 x the
 *   search radius) | 'not_convex' | 'off_sheet' (RGBA source only: a side lies on the far edge of the
 *   sheet's shadow, not on the paper).
 */

export function refineQuad(source, quad, opts) {
  opts = opts || {};
  const stats = { shiftsPx: [0, 0, 0, 0], edgeRmsPx: [0, 0, 0, 0], inlierRatio: [0, 0, 0, 0] };
  const validQuad =
    Array.isArray(quad) && quad.length === 4 && quad.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const fail = (reason) => ({ ok: false, quad: validQuad ? copyQuad(quad) : quad, ...stats, reason });
  if (!validQuad || !source || !source.data || !(source.width > 1) || !(source.height > 1)) return fail('bad_input');

  let shortest = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    shortest = Math.min(shortest, Math.hypot(q.x - p.x, q.y - p.y));
  }
  if (!(shortest > 2) || !isConvex(quad)) return fail('degenerate');

  const radius0 = opts.searchRadiusPx > 0 ? opts.searchRadiusPx : clamp(0.12 * shortest, 4, 24);
  const iterations = Math.max(1, Math.round(opts.iterations ?? 2));
  const cfg = {
    samples: Math.max(8, Math.round(opts.samplesPerEdge ?? 48)),
    margin: clamp(opts.cornerMarginFrac ?? 0.15, 0, 0.45),
    floor: 0,
  };
  const minContrast = opts.minContrast ?? 6;

  const win = lumaWindow(source, quad, 2.6 * radius0 + (KERNEL_HALF + RESPONSE_MARGIN) * STEP + 4);
  // A step must clear both an absolute contrast and the noise level, otherwise a blank, noisy patch would
  // yield a "peak" in every profile.
  cfg.floor = Math.max(minContrast, 4 * RESPONSE_NOISE_GAIN * estimateNoise(win));

  const orientation = signedArea(quad) >= 0 ? 1 : -1;
  // Decided on the first pass, while the search window is widest, and kept for the tighter passes.
  let polarities = null;
  let current = copyQuad(quad);
  let radius = radius0;

  for (let iter = 0; iter < iterations; iter++) {
    const sampled = [];
    for (let i = 0; i < 4; i++) sampled.push(sampleSide(win, current[i], current[(i + 1) % 4], radius, cfg));
    if (!polarities) polarities = agreePolarities(sampled.map((side) => side && polarityEvidence(side, radius)));

    const lines = [];
    let weak = false;
    let ragged = false;
    for (let i = 0; i < 4; i++) {
      const side = sampled[i] ? fitSide(sampled[i], radius, cfg, polarities[i]) : { ok: false, inlierRatio: 0, rms: 0, line: null };
      stats.inlierRatio[i] = side.inlierRatio;
      stats.edgeRmsPx[i] = side.rms;
      if (!side.ok || side.inlierRatio < 0.6) weak = true;
      else if (side.rms > 1.5) ragged = true;
      lines.push(side.line);
    }
    if (weak) return fail('weak_edge');
    if (ragged) return fail('ragged_edge');

    const next = [];
    for (let i = 0; i < 4; i++) {
      const corner = intersectLines(lines[(i + 3) % 4], lines[i]);
      if (!corner) return fail('degenerate');
      next.push(corner);
    }
    for (let i = 0; i < 4; i++) {
      stats.shiftsPx[i] = Math.hypot(next[i].x - quad[i].x, next[i].y - quad[i].y);
    }
    if (stats.shiftsPx.some((s) => !(s <= 1.5 * radius0))) {
      return fail('corner_moved');
    }
    if (!isConvex(next) || signedArea(next) * orientation <= 0) return fail('not_convex');
    current = next;
    radius = Math.min(radius, Math.max(2.5, radius * (iter === 0 ? 0.35 : 0.6)));
  }

  // Luminance cannot tell the sheet's edge from the far edge of its shadow; with the photo's colour we can.
  if (opts.checkColour !== false && !isLumaSource(source) && sidesOnShadow(source, current).shadow.some(Boolean)) {
    return fail('off_sheet');
  }
  return { ok: true, quad: current, ...stats };
}

/* ------------------------------------------------------------------------------------------------------ */
/* detectSheet                                                                                            */
/* ------------------------------------------------------------------------------------------------------ */

const DETECT_LONG_SIDE = 400;
const MAX_REGION_FRACTION = 0.3;
const MAX_REGION_SPAN = 1 / 3;
const MIN_REGION_FRACTION = 0.0005;

/**
 * Box-downscale RGBA to Y / Cb / Cr float planes with the long side near DETECT_LONG_SIDE.
 * For large reduction factors only every second source pixel is read; the average of the remaining ~10
 * samples per block is plenty for region growing and makes this the cheapest step on a 5-megapixel photo.
 */
function downscaleYCC(image) {
  const W = image.width;
  const H = image.height;
  const f = Math.max(1, Math.max(W, H) / DETECT_LONG_SIDE);
  const w = Math.max(1, Math.round(W / f));
  const h = Math.max(1, Math.round(H / f));
  const sx = W / w;
  const sy = H / h;
  const stride = Math.min(sx, sy) >= 4 ? 2 : 1;
  const xStart = new Int32Array(w + 1);
  const yStart = new Int32Array(h + 1);
  for (let i = 0; i <= w; i++) xStart[i] = Math.min(W, Math.round(i * sx));
  for (let j = 0; j <= h; j++) yStart[j] = Math.min(H, Math.round(j * sy));
  const n = w * h;
  const Y = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  const src = image.data;
  for (let j = 0; j < h; j++) {
    const y0 = yStart[j];
    const y1 = Math.max(y0 + 1, yStart[j + 1]);
    for (let i = 0; i < w; i++) {
      const x0 = xStart[i];
      const x1 = Math.max(x0 + 1, xStart[i + 1]);
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0; y < y1; y += stride) {
        let p = (y * W + x0) * 4;
        for (let x = x0; x < x1; x += stride, p += 4 * stride) {
          r += src[p];
          g += src[p + 1];
          b += src[p + 2];
          count++;
        }
      }
      const inv = 1 / count;
      r *= inv;
      g *= inv;
      b *= inv;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const idx = j * w + i;
      Y[idx] = luma;
      Cb[idx] = 0.564 * (b - luma);
      Cr[idx] = 0.713 * (r - luma);
    }
  }
  return { Y, Cb, Cr, w, h, sx, sy };
}

/** Sobel gradient magnitude in grey levels per pixel (a step of height C gives about C / 2 next to it). */
function gradientMagnitude(Y, w, h) {
  const G = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < w - 1 ? x + 1 : x;
      const a = Y[ym * w + xm];
      const b = Y[ym * w + x];
      const c = Y[ym * w + xp];
      const d = Y[y * w + xm];
      const e = Y[y * w + xp];
      const f = Y[yp * w + xm];
      const g = Y[yp * w + x];
      const i = Y[yp * w + xp];
      const gx = c + 2 * e + i - a - 2 * d - f;
      const gy = f + 2 * g + i - a - 2 * b - c;
      G[y * w + x] = Math.sqrt(gx * gx + gy * gy) / 8;
    }
  }
  return G;
}

/** Convex hull (monotone chain) of points already sorted by (y, x). Returns indices into the input. */
function convexHull(xs, ys, n) {
  if (n < 3) return null;
  const hull = new Int32Array(2 * n);
  let k = 0;
  const cross = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  for (let i = 0; i < n; i++) {
    while (k >= 2 && cross(hull[k - 2], hull[k - 1], i) <= 0) k--;
    hull[k++] = i;
  }
  const lower = k + 1;
  for (let i = n - 2; i >= 0; i--) {
    while (k >= lower && cross(hull[k - 2], hull[k - 1], i) <= 0) k--;
    hull[k++] = i;
  }
  k--; // the last point repeats the first
  return k >= 3 ? hull.subarray(0, k) : null;
}

/**
 * Largest-area quadrilateral whose corners are hull vertices: start from the hull's longest diagonal and the
 * vertex furthest from it on either side, then move one corner at a time while the area still grows.
 */
function hullToQuad(xs, ys, hull) {
  const m = hull.length;
  if (m < 4) return null;
  const X = (i) => xs[hull[i]];
  const Yv = (i) => ys[hull[i]];
  let bi = 0;
  let bj = 0;
  let bestD = -1;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const d = (X(i) - X(j)) ** 2 + (Yv(i) - Yv(j)) ** 2;
      if (d > bestD) {
        bestD = d;
        bi = i;
        bj = j;
      }
    }
  }
  const idx = [bi, -1, bj, -1];
  // Vertex strictly between hull positions `from` and `to` (walking forwards, cyclically) furthest from the
  // chord joining them.
  const furthestBetween = (from, to) => {
    const ax = X(from);
    const ay = Yv(from);
    const bx = X(to) - ax;
    const by = Yv(to) - ay;
    let best = -1;
    let bestDist = 1e-9;
    for (let k = (from + 1) % m; k !== to; k = (k + 1) % m) {
      const dist = Math.abs(bx * (Yv(k) - ay) - by * (X(k) - ax));
      if (dist > bestDist) {
        bestDist = dist;
        best = k;
      }
    }
    return best;
  };
  idx[1] = furthestBetween(idx[0], idx[2]);
  idx[3] = furthestBetween(idx[2], idx[0]);
  if (idx[1] < 0 || idx[3] < 0) return null;
  for (let iter = 0; iter < 24; iter++) {
    let changed = false;
    for (let v = 0; v < 4; v++) {
      const best = furthestBetween(idx[(v + 3) % 4], idx[(v + 1) % 4]);
      if (best >= 0 && best !== idx[v]) {
        idx[v] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return idx.map((i) => ({ x: X(i), y: Yv(i) }));
}

/**
 * Could this quad be a rectangle seen under mild perspective? Every interior angle between about 40 and 140
 * degrees, and opposite sides of comparable length (a triangle with a clipped tip fails the latter).
 */
function isRectangleLike(quad) {
  const side = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const a = quad[(i + 3) % 4];
    const b = quad[(i + 1) % 4];
    const ax = a.x - p.x;
    const ay = a.y - p.y;
    const bx = b.x - p.x;
    const by = b.y - p.y;
    side[i] = Math.hypot(bx, by);
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * side[i] || 1);
    if (!(Math.abs(cos) < 0.766)) return false;
  }
  const comparable = (a, b) => Math.min(a, b) > 0.55 * Math.max(a, b);
  return comparable(side[0], side[2]) && comparable(side[1], side[3]);
}

const STEP_X = [-1, 1, 0, 0];
const STEP_Y = [0, 0, -1, 1];
// Longest hop over a thin barrier, in small-image pixels. A crease shows up as a darker line flanked by a row
// or two of raised gradient on each side, so the nearest undisturbed paper beyond it is 4 to 6 pixels away.
const MAX_BRIDGE = 6;

/**
 * Flood-fill the pixels accepted by `accept` from around the seed and reduce the region to a coarse quad.
 *
 * @param {number} w  small-image width
 * @param {number} h  small-image height
 * @param {number} seedX
 * @param {number} seedY
 * @param {(i: number) => boolean} accept  membership test for pixel index i
 * @param {((from: number, to: number) => boolean) | null} bridge  when given, the fill may hop over up to
 *        MAX_BRIDGE - 1 pixels in a straight line onto an accepted pixel `to` for which bridge(from, to) holds
 * @param {Int32Array} stack    scratch space with at least w*h entries
 * @param {number} shortfallPx  how far the grown region is expected to stop short of the true outline
 * @returns {{ reason: string } | { quad: Point[], fill: number, mask: Uint8Array }}  quad in small-image
 *   coordinates; mask is 1 on region pixels
 */
function growRegion(w, h, seedX, seedY, accept, bridge, stack, shortfallPx) {
  const n = w * h;
  // Iterative 4-connected flood fill. A pixel is marked when pushed, so the stack never exceeds n entries.
  const mask = new Uint8Array(n);
  let sp = 0;
  for (let y = Math.max(0, seedY - 1); y <= Math.min(h - 1, seedY + 1); y++) {
    for (let x = Math.max(0, seedX - 1); x <= Math.min(w - 1, seedX + 1); x++) {
      const i = y * w + x;
      if (accept(i)) {
        mask[i] = 1;
        stack[sp++] = i;
      }
    }
  }
  let count = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i - x) / w;
    count++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (let d = 0; d < 4; d++) {
      const nx = x + STEP_X[d];
      const ny = y + STEP_Y[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (mask[j]) continue;
      if (accept(j)) {
        mask[j] = 1;
        stack[sp++] = j;
        continue;
      }
      if (!bridge) continue;
      for (let k = 2; k <= MAX_BRIDGE; k++) {
        const fx = x + STEP_X[d] * k;
        const fy = y + STEP_Y[d] * k;
        if (fx < 0 || fy < 0 || fx >= w || fy >= h) break;
        const far = fy * w + fx;
        if (mask[far]) break; // already reached some other way
        if (!accept(far) || !bridge(i, far)) continue;
        // Claim the far pixel and the barrier pixels hopped over (those are not grown from).
        mask[far] = 1;
        stack[sp++] = far;
        for (let m = 1; m < k; m++) {
          const between = (y + STEP_Y[d] * m) * w + x + STEP_X[d] * m;
          if (!mask[between]) {
            mask[between] = 1;
            count++;
          }
        }
        break;
      }
    }
  }

  if (count === 0) return { reason: 'no_region' };
  // With the whole door in the photo, a reference sheet (even A3) spans under a third of either image
  // dimension. Anything bigger is the door, a door panel or the wall, whatever its area.
  const tooWide = maxX - minX + 1 > MAX_REGION_SPAN * w || maxY - minY + 1 > MAX_REGION_SPAN * h;
  if (count > MAX_REGION_FRACTION * n || tooWide) return { reason: 'too_large' };
  if (minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1) return { reason: 'touches_border' };
  if (count < 6 || maxX - minX < 2 || maxY - minY < 2) return { reason: 'too_small' };

  // Close holes (print on the paper, specks of noise): flood the outside of the region within its bounding
  // box grown by one pixel; whatever the flood cannot reach belongs to the shape. Mask value 2 = outside.
  const bx0 = minX - 1;
  const by0 = minY - 1;
  const bx1 = maxX + 1;
  const by1 = maxY + 1;
  sp = 0;
  const pushOutside = (i) => {
    if (mask[i] === 0) {
      mask[i] = 2;
      stack[sp++] = i;
    }
  };
  for (let x = bx0; x <= bx1; x++) {
    pushOutside(by0 * w + x);
    pushOutside(by1 * w + x);
  }
  for (let y = by0; y <= by1; y++) {
    pushOutside(y * w + bx0);
    pushOutside(y * w + bx1);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i - x) / w;
    if (x > bx0) pushOutside(i - 1);
    if (x < bx1) pushOutside(i + 1);
    if (y > by0) pushOutside(i - w);
    if (y < by1) pushOutside(i + w);
  }

  // The filled region on its own small grid, padded so the morphology below never needs bounds checks.
  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  const openRadius = clamp(Math.round(0.08 * Math.min(spanX, spanY)), 1, 4);
  const pad = openRadius + 1;
  const bw = spanX + 2 * pad;
  const bh = spanY + 2 * pad;
  const filled = new Uint8Array(bw * bh);
  let filledArea = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (mask[y * w + x] !== 2) {
        filled[(y - minY + pad) * bw + (x - minX + pad)] = 1;
        filledArea++;
      }
    }
  }

  // Morphological opening: strips thin protrusions such as paper-coloured tape running off the corners, which
  // would otherwise drag the hull (and so the corners) outwards. Kept only if most of the region survives.
  let opened = null;
  let openedArea = 0;
  {
    let src = filled.slice();
    let dst = new Uint8Array(bw * bh);
    for (let pass = 0; pass < 2 * openRadius; pass++) {
      const erode = pass < openRadius;
      for (let y = 1; y < bh - 1; y++) {
        for (let x = 1; x < bw - 1; x++) {
          const i = y * bw + x;
          const sum =
            src[i - bw - 1] + src[i - bw] + src[i - bw + 1] +
            src[i - 1] + src[i] + src[i + 1] +
            src[i + bw - 1] + src[i + bw] + src[i + bw + 1];
          dst[i] = erode ? (sum === 9 ? 1 : 0) : sum > 0 ? 1 : 0;
        }
      }
      const swap = src;
      src = dst;
      dst = swap;
    }
    for (let i = 0; i < src.length; i++) openedArea += src[i];
    if (openedArea >= 0.5 * filledArea) opened = src;
  }

  // Reduce a shape on the padded grid to its outline quad, or say why it is not one.
  const outline = (shape, area) => {
    // Hull of the pixel centres at the left and right end of every row of the shape.
    const hx = new Float64Array(2 * bh);
    const hy = new Float64Array(2 * bh);
    let hn = 0;
    for (let y = 1; y < bh - 1; y++) {
      const row = y * bw;
      let left = 1;
      while (left < bw - 1 && shape[row + left] !== 1) left++;
      if (left >= bw - 1) continue;
      let right = bw - 2;
      while (shape[row + right] !== 1) right--;
      hx[hn] = left - pad + minX + 0.5;
      hy[hn] = y - pad + minY + 0.5;
      hn++;
      if (right > left) {
        hx[hn] = right - pad + minX + 0.5;
        hy[hn] = y - pad + minY + 0.5;
        hn++;
      }
    }
    const hull = convexHull(hx, hy, hn);
    const rawQuad = hull && hullToQuad(hx, hy, hull);
    if (!rawQuad || !isConvex(rawQuad)) return { reason: 'not_quad' };
    const centreQuad = orderCorners(rawQuad);

    // Rectangularity: compare the filled pixel count with the quad grown from pixel centres to pixel extents.
    // Too low = ragged or L-shaped region; too high = the quad cuts off chunks of it (a disc, a pentagon).
    const fill = area / Math.abs(signedArea(offsetQuad(centreQuad, 0.5)));
    const quad = offsetQuad(centreQuad, 0.5 + shortfallPx);
    if (Math.abs(signedArea(quad)) < MIN_REGION_FRACTION * n) return { reason: 'too_small' };
    if (!(fill > 0.85 && fill < 1.15) || !isRectangleLike(centreQuad)) return { reason: 'not_quad' };
    return { quad, fill, mask };
  };

  if (!opened) return outline(filled, filledArea);
  const result = outline(opened, openedArea);
  // The opening works with an axis-aligned square, which also bites the corners off a sheet lying at 30 to
  // 60 degrees to the photo: its outline then reads as an octagon, not a quad. Before giving up on such a
  // region, look at it as it was filled.
  return result.reason === 'not_quad' ? outline(filled, filledArea) : result;
}

/**
 * True when at least three sides of `quad` have region pixels of `mask` just beyond them, i.e. the quad is
 * an island inside that region rather than a piece cut off one end of it.
 */
function isIslandIn(quad, mask, w, h) {
  const outward = signedArea(quad) >= 0 ? 1 : -1;
  let enclosedSides = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (outward * (b.y - a.y)) / len;
    const ny = (-outward * (b.x - a.x)) / len;
    let hits = 0;
    for (const t of [0.25, 0.5, 0.75]) {
      const x = Math.floor(a.x + (b.x - a.x) * t + nx * 3);
      const y = Math.floor(a.y + (b.y - a.y) * t + ny * 3);
      if (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1) hits++;
    }
    if (hits >= 2) enclosedSides++;
  }
  return enclosedSides >= 3;
}

/** True when p lies inside a convex quad, or no more than `slack` outside one of its sides. */
function quadContains(quad, p, slack) {
  const inward = signedArea(quad) >= 0 ? 1 : -1;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dist = (inward * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))) / len;
    if (dist < -slack) return false;
  }
  return true;
}

// Probe points along the middle half of a side, and again just beyond each of its ends.
const RUN_ON_PROBES = 9;

/**
 * True when a side of the quad carries on past one of its corners under different light: the quad is one
 * part of a sheet that a hard shadow line runs across (the edge of a porch roof's shade), not the whole
 * sheet.
 *
 * The region grown from the tap stops where the paper's brightness changes abruptly, and a shadow line is
 * as straight and sharp as a paper edge, so the outline of the lit (or the shaded) part passes every other
 * check. But the sheet's real edges do not end at the two corners on the shadow line. Just past such a
 * corner, on the side's own line, there is still an edge with the sheet's colour inside it and the door
 * outside it, both of them darker, or both lighter, than along the side itself. Tape over a corner, the
 * sheet's own shadow and a door moulding each fail one of those tests: the door beside tape is lit as
 * before, tape and shadow are not the paper's colour dimmed, and paper-coloured tape is simply more paper.
 *
 * @param {Image} image  RGBA
 * @param {Point[]} quad
 * @returns {boolean}
 */
function runsOnPastCorner(image, quad) {
  const inward = signedArea(quad) >= 0 ? 1 : -1;
  const ycc = [0, 0, 0];
  const inner = [0, 0, 0];
  const along = [0, 1, 2, 3].map(() => new Float32Array(RUN_ON_PROBES));
  let outer = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const nx = -inward * uy;
    const ny = inward * ux;
    // Colours either side of the side's line, a distance s along it from corner a: each the mean of three
    // taps 2, 3 and 4 px off the line. The inside colour goes to `inner`, the outside luma to `outer`.
    const probe = (s) => {
      const x = a.x + ux * s;
      const y = a.y + uy * s;
      outer = 0;
      inner[0] = inner[1] = inner[2] = 0;
      for (let o = 2; o <= 4; o++) {
        sampleYCC(image, x + nx * o, y + ny * o, ycc);
        for (let c = 0; c < 3; c++) inner[c] += ycc[c] / 3;
        sampleYCC(image, x - nx * o, y - ny * o, ycc);
        outer += ycc[0] / 3;
      }
    };
    for (let k = 0; k < RUN_ON_PROBES; k++) {
      probe(len * (0.25 + (0.5 * k) / (RUN_ON_PROBES - 1)));
      for (let c = 0; c < 3; c++) along[c][k] = inner[c];
      along[3][k] = outer;
    }
    // The sheet and what lies beside it, along this side.
    const sheet = [0, 1, 2].map((c) => medianOf(along[c], RUN_ON_PROBES));
    const beside = medianOf(along[3], RUN_ON_PROBES);
    const own = sheet[0] - beside;
    const sign = own >= 0 ? 1 : -1;
    const tolC = chromaTolerance(sheet[0]);
    const margin = Math.max(4, 0.15 * beside);
    const reach = clamp(0.06 * len, 8, 16);
    for (const dir of [-1, 1]) {
      let hits = 0;
      for (let k = 0; k < RUN_ON_PROBES; k++) {
        const past = 4 + (reach * k) / (RUN_ON_PROBES - 1);
        probe(dir > 0 ? len + past : -past);
        // How much lighter (or darker) than the sheet the inside of the line is out here.
        const gain = inner[0] / Math.max(1, sheet[0]);
        // The edge carries on, about as strong as an edge lit that much would be ...
        if (sign * (inner[0] - outer) < Math.max(6, 0.5 * gain * Math.abs(own))) continue;
        // ... its inside is not simply more of the sheet (or tape the colour of the paper) ...
        if (sameSurface(sheet, inner)) continue;
        // ... but it is the sheet's own colour, lighter or darker ...
        if (Math.abs(inner[1] - gain * sheet[1]) > tolC || Math.abs(inner[2] - gain * sheet[2]) > tolC) continue;
        // ... and what lies beside it has gone lighter or darker with it.
        if (gain < 1 ? outer > beside - margin : outer < beside + margin) continue;
        hits++;
      }
      if (2 * hits > RUN_ON_PROBES) return true;
    }
  }
  return false;
}

/** One detection attempt from one seed, on planes prepared once per photo (see detectSheetImpl). */
function detectFromSeed(image, planes, seed, opts, fail) {
  const W = image.width;
  const H = image.height;
  if (!(seed.x >= 0 && seed.y >= 0 && seed.x < W && seed.y < H)) return fail('no_region');

  const { Y, Cb, Cr, G, w, h, sx, sy } = planes;
  const seedX = Math.min(w - 1, Math.floor(seed.x / sx));
  const seedY = Math.min(h - 1, Math.floor(seed.y / sy));

  // Reference colour and local texture level: medians over a 5x5 neighbourhood, so a tap on a speck of print
  // or right beside the sheet's edge still picks up the paper.
  const patch = [new Float32Array(25), new Float32Array(25), new Float32Array(25), new Float32Array(25)];
  let pc = 0;
  for (let y = Math.max(0, seedY - 2); y <= Math.min(h - 1, seedY + 2); y++) {
    for (let x = Math.max(0, seedX - 2); x <= Math.min(w - 1, seedX + 2); x++) {
      const i = y * w + x;
      patch[0][pc] = Y[i];
      patch[1][pc] = Cb[i];
      patch[2][pc] = Cr[i];
      patch[3][pc] = G[i];
      pc++;
    }
  }
  const y0 = medianOf(patch[0], pc);
  const cb0 = medianOf(patch[1], pc);
  const cr0 = medianOf(patch[2], pc);
  const texture = medianOf(patch[3], pc);

  // Similar colour = inside an ellipse around the reference; generous in luma so a lighting gradient across
  // the paper is tolerated.
  const invTolY = 1 / lumaTolerance(y0);
  const invTolC = 1 / chromaTolerance(y0);
  const similar = (i) => {
    const dy = (Y[i] - y0) * invTolY;
    const db = (Cb[i] - cb0) * invTolC;
    const dr = (Cr[i] - cr0) * invTolC;
    return dy * dy + db * db + dr * dr <= 1;
  };
  // Stricter variant: additionally never enter a pixel with a strong gradient. This is what bounds the paper
  // on a door of nearly the same colour, and it stops the fill creeping along the ramp of half-covered
  // pixels on a slanted edge.
  const edgeLimit = Math.min(24, clamp(0.035 * y0, 4, 10) + 2 * texture);
  const similarAndCalm = (i) => G[i] <= edgeLimit && similar(i);
  // Two pixels on either side of a thin barrier belong together when they match closely: paper on both
  // sides of a crease does, paper and a light door do not. Both must also sit in a flat 3x3 neighbourhood.
  // That rules out the pixels of the crease itself, which are often about as dark as the door and would
  // otherwise be a stepping stone from the paper onto the door where the crease meets the sheet's edge
  // (the gradient alone cannot tell: it vanishes on the centre line of a thin dark line).
  const closeY = Math.max(8, 0.09 * y0);
  const flatLimit = Math.max(6, 0.04 * y0) + 2 * texture;
  const isFlat = (i) => {
    const x = i % w;
    const y = (i - x) / w;
    let lo = Y[i];
    let hi = lo;
    for (let yy = y > 0 ? y - 1 : y; yy <= (y < h - 1 ? y + 1 : y); yy++) {
      for (let xx = x > 0 ? x - 1 : x; xx <= (x < w - 1 ? x + 1 : x); xx++) {
        const v = Y[yy * w + xx];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
    }
    return hi - lo <= flatLimit;
  };
  const closeMatch = (a, b) =>
    Math.abs(Y[a] - Y[b]) <= closeY && Math.abs(Cb[a] - Cb[b]) <= 8 && Math.abs(Cr[a] - Cr[b]) <= 8 && isFlat(a) && isFlat(b);

  // Three ways to grow the region, most permissive first:
  //  1. colour alone: the best outline whenever the door is clearly a different colour, and immune to
  //     creases, print and shading on the paper;
  //  2. bounded by edges, but allowed to hop over thin ones between closely matching pixels: for a creased
  //     sheet on a door too close in colour for (1);
  //  3. strictly bounded by edges: for paper on a door of almost the same colour, where only the paper's
  //     faint outline separates them.
  // The most permissive one that yields a quad wins, unless a stricter one found a quad sitting inside it
  // like an island (a sheet on a same-coloured panel that is quad-shaped itself). A stricter result that is
  // merely one end of the permissive one (half a folded sheet) never wins.
  const stack = new Int32Array(w * h);
  const candidates = [
    growRegion(w, h, seedX, seedY, similar, null, stack, 0),
    growRegion(w, h, seedX, seedY, similarAndCalm, closeMatch, stack, 1),
    growRegion(w, h, seedX, seedY, similarAndCalm, null, stack, 1),
  ];
  let region = null;
  for (const candidate of candidates) {
    if (!candidate.quad) continue;
    if (!region || isIslandIn(candidate.quad, region.mask, w, h)) region = candidate;
  }
  if (!region) {
    // Report the strictest attempt that found anything at all.
    const informative = candidates.reverse().find((c) => c.reason !== 'no_region');
    return fail(informative ? informative.reason : 'no_region');
  }
  const coarseSmall = region.quad;
  const fill = region.fill;

  // Two-stage refinement: first on the small image (cheap, wide capture range in full-res pixels), then at
  // full resolution starting from a guess that is already within a pixel or two.
  const scale = Math.max(sx, sy);
  let small = coarseSmall;
  let smallRefined = false;
  if (scale > 1.5) {
    let shortest = Infinity;
    for (let i = 0; i < 4; i++) {
      const p = coarseSmall[i];
      const q = coarseSmall[(i + 1) % 4];
      shortest = Math.min(shortest, Math.hypot(q.x - p.x, q.y - p.y));
    }
    const pre = refineQuad({ data: Y, width: w, height: h }, coarseSmall, {
      searchRadiusPx: clamp(0.3 * shortest, 2.5, 5),
      iterations: 2,
    });
    if (pre.ok) {
      small = pre.quad;
      smallRefined = true;
    }
  }
  const coarse = small.map((p) => ({ x: p.x * sx, y: p.y * sy }));

  let source = image;
  if (opts && opts.luma && opts.luma.width === W && opts.luma.height === H && opts.luma.data) source = opts.luma;
  else if (scale === 1) source = { data: Y, width: w, height: h };

  const radii = smallRefined ? [clamp(1.25 * scale + 1.5, 4, 14), clamp(3 * scale, 8, 24)] : [clamp(2.5 * scale, 6, 24)];
  const coarseArea = Math.abs(signedArea(coarse));
  let refined = null;
  // What to offer instead when a side will only settle on the far edge of the sheet's shadow.
  let offSheet = null;
  for (const searchRadiusPx of radii) {
    const attempt = refineQuad(source, coarse, { searchRadiusPx, iterations: 3, checkColour: false });
    // A refinement that changes the outline's area a lot has latched onto something other than the region.
    const areaRatio = Math.abs(signedArea(attempt.quad)) / coarseArea;
    if (!attempt.ok || !(areaRatio > 0.7 && areaRatio < 1.4)) continue;
    const { sheet, shadow } = sidesOnShadow(image, attempt.quad);
    if (!shadow.some(Boolean)) {
      refined = attempt;
      break;
    }
    // Those sides moved in to where the sheet's own colour begins or, failing that, the outline of the
    // region, which was grown by colour (the small-image fit may sit on the shadow as well).
    offSheet = offSheet || ontoSheet(image, attempt.quad, sheet, shadow) || coarseSmall.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  }

  const rectScore = clamp(1 - Math.abs(fill - 1) / 0.15, 0, 1);
  if (!refined) {
    // Put back on the paper, the outline can still be only the lit (or the shaded) part of the sheet.
    if (offSheet && runsOnPastCorner(image, offSheet)) return fail('cut_off');
    const outline = { ok: true, quad: orderCorners(offSheet || coarse), confidence: 0.2 + 0.2 * rectScore, refined: false };
    if (offSheet) outline.reason = 'off_sheet';
    return outline;
  }
  if (runsOnPastCorner(image, refined.quad)) return fail('cut_off');
  // Judge by the worst side: one side with patchy support or a ragged fit (something touching the sheet's
  // edge, heavy blur) is enough to make the corners at its ends less trustworthy.
  const worstInliers = Math.min(...refined.inlierRatio);
  const worstRms = Math.max(...refined.edgeRmsPx);
  const edgeScore = clamp((worstInliers - 0.6) / 0.3, 0, 1) * clamp(1 - (worstRms - 0.1) / 0.6, 0, 1);
  return {
    ok: true,
    quad: orderCorners(refined.quad),
    confidence: clamp(0.5 + 0.35 * edgeScore + 0.15 * rectScore, 0, 1),
    refined: true,
  };
}

// Where to look again when a tap gives nothing usable: 3 small-image pixels away in 8 directions.
const RETRY_REACH = 3;
const RETRY_DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function detectSheetImpl(image, seed, opts, fail) {
  if (!image || !image.data || !(image.width > 0) || !(image.height > 0)) return fail('no_region');
  if (!seed || !Number.isFinite(seed.x) || !Number.isFinite(seed.y)) return fail('no_region');
  if (seed.x < 0 || seed.y < 0 || seed.x >= image.width || seed.y >= image.height) return fail('no_region');

  const planes = downscaleYCC(image);
  planes.G = gradientMagnitude(planes.Y, planes.w, planes.h);
  const first = detectFromSeed(image, planes, seed, opts, fail);
  // A sheet cut in two by a shadow line, or one whose shadow hides its edge, looks the same from any point
  // on it: there is nothing to gain from looking again.
  if ((first.ok && first.refined) || first.reason === 'cut_off' || first.reason === 'off_sheet') return first;

  // A tap within a few pixels of the sheet's edge reads a blend of paper and door as its reference
  // colour, and the region grown from that is a sliver, the whole door, or nothing. So look again from
  // a little further out in each direction, and believe only an outline that has the tap inside it:
  // then the customer did tap that shape. Of several (the sheet, and the door panel around it), the
  // smallest is the one they tapped. A coarse first outline only ever gives way to a refined one, or to
  // one whose edges were found and put back on the paper by colour ('off_sheet').
  const rank = (result) => (result.refined ? 2 : result.reason === 'off_sheet' ? 1 : 0);
  const scale = Math.max(planes.sx, planes.sy);
  const slack = Math.max(2, 0.5 * scale);
  let best = null;
  let bestArea = Infinity;
  for (const [dx, dy] of RETRY_DIRECTIONS) {
    const moved = { x: seed.x + dx * RETRY_REACH * planes.sx, y: seed.y + dy * RETRY_REACH * planes.sy };
    const attempt = detectFromSeed(image, planes, moved, opts, fail);
    if (!attempt.ok || !quadContains(attempt.quad, seed, slack)) continue;
    if (best && rank(best) > rank(attempt)) continue;
    const area = Math.abs(signedArea(attempt.quad));
    if (!best || rank(attempt) > rank(best) || area < bestArea) {
      best = attempt;
      bestArea = area;
    }
  }
  if (best && (rank(best) > rank(first) || !first.ok)) return best;
  return first;
}

/**
 * Find the sheet of paper the customer tapped.
 *
 * Grows a region of similar colour from the tap on a downscaled copy of the photo (stopping at strong
 * edges where colour alone is not enough), checks that it is a plausible quadrilateral, and refines its
 * corners at full resolution with {@link refineQuad}. When that gives nothing usable (a tap right on the
 * sheet's edge), it looks again from a few pixels away in each direction and accepts an outline that has
 * the tap inside it. Never throws.
 *
 * The refined outline is then checked against the photo's colour for the two things a luminance edge
 * cannot tell from the paper's own edge. A side that has settled on the far edge of the shadow the sheet
 * casts (a coloured, pastel or grey sheet on a pale door) is moved back to where the sheet's colour
 * begins, and the outline is handed over as unrefined. An outline that is only the lit, or only the
 * shaded, part of a sheet with a hard shadow line across it is refused, whether or not a side was moved
 * back. A sheet about as dark as its own shadow, and no different in colour, can still be outlined on the
 * shadow's far edge (see sidesOnShadow).
 *
 * @param {Image} image          full-resolution RGBA photo
 * @param {Point} seed           where the customer tapped (continuous image coordinates, full resolution)
 * @param {object} [opts]
 * @param {Luma} [opts.luma]     precomputed full-resolution luma of `image` (saves converting the window
 *        around the sheet again)
 * @returns {{ ok: boolean, quad: Point[] | null, confidence: number, refined: boolean, reason?: string }}
 *   quad: [TL, TR, BR, BL] in full-resolution image coordinates, or null when ok is false.
 *   refined: true when the corners are sub-pixel refined; false = coarse outline only (lower confidence),
 *     for the customer to check rather than to rely on.
 *   confidence: 0..1; above ~0.9 for a clean sheet, lower when a side is ragged or poorly supported, and
 *     no more than 0.4 for an unrefined outline.
 *   reason (when ok and not refined): 'off_sheet' when a side would only settle on the far edge of the
 *     sheet's shadow and was put back on the paper by colour; absent when the edges could not be fitted at
 *     all and the quad is just the outline of the tapped region.
 *   reason (when not ok):
 *     'no_region'       the tap is outside the photo, or nothing coherent lies under it
 *     'too_large'       the region covers over 30% of the photo or spans over a third of its width or height:
 *                       the door, a panel or the wall was tapped, or the sheet and the door are the same colour
 *     'touches_border'  the region runs off the edge of the photo
 *     'too_small'       the region is under 0.05% of the photo
 *     'not_quad'        the region is not a four-sided, roughly rectangular shape
 *     'cut_off'         a hard shadow line runs across the sheet, and the outline found is only the part of
 *                       it on the tapped side of that line
 */
export function detectSheet(image, seed, opts = {}) {
  const fail = (reason) => ({ ok: false, quad: null, confidence: 0, refined: false, reason });
  try {
    return detectSheetImpl(image, seed, opts, fail);
  } catch {
    return fail('no_region');
  }
}

/* ------------------------------------------------------------------------------------------------------ */
/* warpToRect                                                                                             */
/* ------------------------------------------------------------------------------------------------------ */

/**
 * Perspective-correct ("flatten") part of the door plane into a new image.
 *
 * The output covers the plane rectangle [-marginMm, widthMm + marginMm] x [-marginMm, heightMm + marginMm]
 * exactly: plane point (X, Y) lands at output position ((X + marginMm) / (widthMm + 2 marginMm) * width,
 * (Y + marginMm) / (heightMm + 2 marginMm) * height). Pixels whose source falls outside the photo are fully
 * transparent.
 *
 * @param {Image} image                 source RGBA photo
 * @param {number[]} planeToImage       homography (row-major 3x3) from door-plane mm to image pixels
 * @param {object} opts
 * @param {number} opts.widthMm
 * @param {number} opts.heightMm
 * @param {number} [opts.marginMm=0]    extra plane shown on every side
 * @param {number} opts.outWidth        output width in pixels; the height follows from the aspect ratio
 * @returns {Image}
 */
export function warpToRect(image, planeToImage, opts) {
  const { widthMm, heightMm, marginMm = 0, outWidth } = opts;
  const totalW = widthMm + 2 * marginMm;
  const totalH = heightMm + 2 * marginMm;
  const ow = Math.max(1, Math.round(outWidth));
  const oh = Math.max(1, Math.round((ow * totalH) / totalW));
  const data = new Uint8ClampedArray(ow * oh * 4);
  // Written through a plain byte view: the interpolated values are already within 0..255, and skipping the
  // clamped-array conversion makes the inner loop noticeably faster.
  const out = new Uint8Array(data.buffer);
  const result = { data, width: ow, height: oh };
  if (!(totalW > 0) || !(totalH > 0)) return result;

  const src = image.data;
  const sw = image.width;
  const sh = image.height;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = planeToImage;
  // Points on the camera's side of the plane's horizon share the sign of the projective w at the door centre.
  const wSign = h6 * (widthMm / 2) + h7 * (heightMm / 2) + h8 < 0 ? -1 : 1;
  const stepX = totalW / ow;
  const stepY = totalH / oh;
  const X0 = -marginMm + 0.5 * stepX;
  const dnx = h0 * stepX;
  const dny = h3 * stepX;
  const dnw = h6 * stepX;
  const maxX = sw - 1;
  const maxY = sh - 1;

  for (let v = 0; v < oh; v++) {
    const Yp = -marginMm + (v + 0.5) * stepY;
    let nx = h0 * X0 + h1 * Yp + h2;
    let ny = h3 * X0 + h4 * Yp + h5;
    let nw = h6 * X0 + h7 * Yp + h8;
    let o = v * ow * 4;
    for (let u = 0; u < ow; u++, o += 4, nx += dnx, ny += dny, nw += dnw) {
      if (!(nw * wSign > 1e-12)) continue;
      const x = nx / nw;
      const y = ny / nw;
      if (!(x >= 0 && x <= sw && y >= 0 && y <= sh)) continue;
      let fx = x - 0.5;
      let fy = y - 0.5;
      if (fx < 0) fx = 0;
      else if (fx > maxX) fx = maxX;
      if (fy < 0) fy = 0;
      else if (fy > maxY) fy = maxY;
      const x0 = fx | 0;
      const y0 = fy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      fx -= x0;
      fy -= y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      out[o] = (src[a] * w00 + src[b] * w10 + src[c] * w01 + src[d] * w11 + 0.5) | 0;
      out[o + 1] = (src[a + 1] * w00 + src[b + 1] * w10 + src[c + 1] * w01 + src[d + 1] * w11 + 0.5) | 0;
      out[o + 2] = (src[a + 2] * w00 + src[b + 2] * w10 + src[c + 2] * w01 + src[d + 2] * w11 + 0.5) | 0;
      out[o + 3] = (src[a + 3] * w00 + src[b + 3] * w10 + src[c + 3] * w01 + src[d + 3] * w11 + 0.5) | 0;
    }
  }
  return result;
}
