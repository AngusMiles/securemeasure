// Test-only synthetic image renderer for the vision tests.
//
// Draws convex polygons with EXACT pixel-area coverage (polygon clipped against each pixel square), so the
// ground-truth edges are known to far better than the 0.25 px the tests assert. Optional lighting gradient,
// Gaussian blur and seeded Gaussian noise are applied afterwards, in that order, like a real camera would.
//
// Coordinates are continuous image coordinates: pixel (i, j) covers [i, i+1) x [j, j+1), its centre is at
// (i + 0.5, j + 0.5). This is the same convention js/vision.js uses for quads.

/**
 * Small deterministic PRNG (mulberry32).
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal sample (Box-Muller) from a uniform generator.
 * @param {() => number} rng
 * @returns {number}
 */
export function gaussian(rng) {
  let u = rng();
  if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const CLIP_A = new Float64Array(64);
const CLIP_B = new Float64Array(64);

/** Area of (convex polygon) ∩ (unit pixel square at px, py), via Sutherland-Hodgman clipping. */
function coverage(poly, n, px, py) {
  let src = CLIP_A;
  let dst = CLIP_B;
  for (let i = 0; i < 2 * n; i++) src[i] = poly[i];
  let count = n;
  // Four half-planes: x >= px, x <= px + 1, y >= py, y <= py + 1.
  for (let side = 0; side < 4 && count > 0; side++) {
    const axis = side < 2 ? 0 : 1;
    const bound = side === 0 ? px : side === 1 ? px + 1 : side === 2 ? py : py + 1;
    const sign = side % 2 === 0 ? 1 : -1; // inside when sign * (v - bound) >= 0
    let out = 0;
    let ax = src[2 * (count - 1)];
    let ay = src[2 * (count - 1) + 1];
    let da = sign * ((axis === 0 ? ax : ay) - bound);
    for (let i = 0; i < count; i++) {
      const bx = src[2 * i];
      const by = src[2 * i + 1];
      const db = sign * ((axis === 0 ? bx : by) - bound);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        dst[2 * out] = ax + (bx - ax) * t;
        dst[2 * out + 1] = ay + (by - ay) * t;
        out++;
      }
      if (db >= 0) {
        dst[2 * out] = bx;
        dst[2 * out + 1] = by;
        out++;
      }
      ax = bx;
      ay = by;
      da = db;
    }
    count = out;
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  if (count < 3) return 0;
  let area = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    area += src[2 * i] * src[2 * j + 1] - src[2 * j] * src[2 * i + 1];
  }
  return Math.min(1, Math.abs(area) / 2);
}

/** Alpha-blend one convex polygon into the float planes with exact coverage. */
function drawPolygon(planes, width, height, points, color) {
  const n = points.length;
  if (n < 3) return;
  const poly = new Float64Array(2 * n);
  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    signedArea += p.x * q.y - q.x * p.y;
  }
  // Store with positive shoelace orientation so that "inside" is on the left of every edge.
  for (let i = 0; i < n; i++) {
    const p = points[signedArea >= 0 ? i : n - 1 - i];
    poly[2 * i] = p.x;
    poly[2 * i + 1] = p.y;
  }
  // Edge half-planes: a*x + b*y + c >= 0 inside, (a, b) unit length.
  const ea = new Float64Array(n);
  const eb = new Float64Array(n);
  const ec = new Float64Array(n);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x0 = poly[2 * i];
    const y0 = poly[2 * i + 1];
    const j = (i + 1) % n;
    const dx = poly[2 * j] - x0;
    const dy = poly[2 * j + 1] - y0;
    const len = Math.hypot(dx, dy) || 1;
    ea[i] = -dy / len;
    eb[i] = dx / len;
    ec[i] = -(ea[i] * x0 + eb[i] * y0);
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x0);
    minY = Math.min(minY, y0);
    maxY = Math.max(maxY, y0);
  }
  const x0 = Math.max(0, Math.floor(minX) - 1);
  const x1 = Math.min(width - 1, Math.ceil(maxX) + 1);
  const y0 = Math.max(0, Math.floor(minY) - 1);
  const y1 = Math.min(height - 1, Math.ceil(maxY) + 1);
  const [pr, pg, pb] = planes;
  const HALF_DIAG = 0.70711;
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const cx = x + 0.5;
      let dmin = Infinity;
      for (let e = 0; e < n; e++) {
        const d = ea[e] * cx + eb[e] * cy + ec[e];
        if (d < dmin) dmin = d;
      }
      if (dmin <= -HALF_DIAG) continue;
      const cov = dmin >= HALF_DIAG ? 1 : coverage(poly, n, x, y);
      if (cov <= 0) continue;
      const idx = y * width + x;
      pr[idx] += (color[0] - pr[idx]) * cov;
      pg[idx] += (color[1] - pg[idx]) * cov;
      pb[idx] += (color[2] - pb[idx]) * cov;
    }
  }
}

/** Separable Gaussian blur of one float plane, clamping at the borders. */
function blurPlane(plane, width, height, sigma) {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    kernel[k + radius] = Math.exp((-0.5 * k * k) / (sigma * sigma));
    sum += kernel[k + radius];
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  const tmp = new Float32Array(plane.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
        acc += kernel[k + radius] * plane[row + xx];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
        acc += kernel[k + radius] * tmp[yy * width + x];
      }
      plane[row + x] = acc;
    }
  }
}

/**
 * Render a synthetic RGBA image.
 *
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {number[]} [o.background]  [r, g, b]
 * @param {{ points: {x:number,y:number}[], color: number[] }[]} [o.shapes]  convex polygons, drawn in order
 *        (later shapes paint over earlier ones); use this for the main quad and for distractor edges
 * @param {{ angleDeg?: number, strength: number } | null} [o.gradient]  multiplicative lighting gradient:
 *        brightness goes from (1 - strength/2) to (1 + strength/2) across the image along angleDeg
 * @param {number} [o.blurSigma]   Gaussian blur sigma in px (0 = none; edges are still anti-aliased)
 * @param {number} [o.noiseSigma]  Gaussian noise sigma in grey levels
 * @param {number} [o.seed]        noise seed
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function renderSynth({
  width,
  height,
  background = [70, 70, 70],
  shapes = [],
  gradient = null,
  blurSigma = 0,
  noiseSigma = 0,
  seed = 1,
}) {
  const n = width * height;
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 3; c++) planes[c].fill(background[c]);
  for (const shape of shapes) drawPolygon(planes, width, height, shape.points, shape.color);

  if (gradient && gradient.strength) {
    const ang = ((gradient.angleDeg ?? 0) * Math.PI) / 180;
    const gx = Math.cos(ang);
    const gy = Math.sin(ang);
    const corners = [0, width * gx, height * gy, width * gx + height * gy];
    const lo = Math.min(...corners);
    const span = Math.max(...corners) - lo || 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = ((x + 0.5) * gx + (y + 0.5) * gy - lo) / span;
        const f = 1 + gradient.strength * (t - 0.5);
        const idx = y * width + x;
        planes[0][idx] *= f;
        planes[1][idx] *= f;
        planes[2][idx] *= f;
      }
    }
  }

  if (blurSigma > 0) for (const plane of planes) blurPlane(plane, width, height, blurSigma);

  const data = new Uint8ClampedArray(n * 4);
  const rng = mulberry32(seed);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let r = planes[0][i];
    let g = planes[1][i];
    let b = planes[2][i];
    if (noiseSigma > 0) {
      r += noiseSigma * gaussian(rng);
      g += noiseSigma * gaussian(rng);
      b += noiseSigma * gaussian(rng);
    }
    data[j] = r;
    data[j + 1] = g;
    data[j + 2] = b;
    data[j + 3] = 255;
  }
  return { data, width, height };
}

/**
 * Image corners [TL, TR, BR, BL] of a w x h rectangle seen by a simple pinhole camera: the rectangle is
 * rotated in its own plane by rotDeg, tilted by yaw (about the vertical axis) and pitch (about the
 * horizontal axis), then projected with focal length `focal` so that its centre lands on (cx, cy) and, when
 * untilted, it appears exactly w x h pixels.
 *
 * @param {object} o
 * @returns {{x:number,y:number}[]}
 */
export function poseQuad({ cx, cy, w, h, rotDeg = 0, yawDeg = 0, pitchDeg = 0, focal = 1600 }) {
  const rad = Math.PI / 180;
  const cr = Math.cos(rotDeg * rad);
  const sr = Math.sin(rotDeg * rad);
  const cyw = Math.cos(yawDeg * rad);
  const syw = Math.sin(yawDeg * rad);
  const cp = Math.cos(pitchDeg * rad);
  const sp = Math.sin(pitchDeg * rad);
  const local = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  return local.map(([lx, ly]) => {
    const x0 = lx * cr - ly * sr;
    const y0 = lx * sr + ly * cr;
    // yaw about the y axis, then pitch about the x axis
    const x1 = x0 * cyw;
    const z1 = -x0 * syw;
    const y2 = y0 * cp - z1 * sp;
    const z2 = y0 * sp + z1 * cp;
    const depth = focal + z2;
    return { x: cx + (focal * x1) / depth, y: cy + (focal * y2) / depth };
  });
}

/**
 * Move every corner by a random vector of length between 0.5*maxPx and maxPx.
 * @param {{x:number,y:number}[]} quad
 * @param {number} maxPx
 * @param {() => number} rng
 * @returns {{x:number,y:number}[]}
 */
export function perturbQuad(quad, maxPx, rng) {
  return quad.map((p) => {
    const ang = rng() * 2 * Math.PI;
    const r = maxPx * (0.5 + 0.5 * rng());
    return { x: p.x + r * Math.cos(ang), y: p.y + r * Math.sin(ang) };
  });
}

/**
 * Per-corner distances between two quads given in the same corner order.
 * @returns {number[]}
 */
export function cornerErrors(a, b) {
  return a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y));
}

/**
 * Largest corner distance between two quads, trying all four cyclic alignments of the corner order.
 * @returns {number}
 */
export function maxCornerError(a, b) {
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const p = a[i];
      const q = b[(i + shift) % 4];
      worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
    }
    best = Math.min(best, worst);
  }
  return best;
}

/**
 * A thick straight line from a to b as a convex polygon (useful as a distractor edge).
 * @returns {{x:number,y:number}[]}
 */
export function band(a, b, widthPx) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (widthPx / 2);
  const ny = (dx / len) * (widthPx / 2);
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
}

/**
 * Regular polygon approximating a disc.
 * @returns {{x:number,y:number}[]}
 */
export function disc(cx, cy, r, segments = 72) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/**
 * Grow (positive d) or shrink (negative d) a convex quad by moving each side along its outward normal.
 * @returns {{x:number,y:number}[]}
 */
export function offsetQuad(quad, d) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    area += p.x * q.y - q.x * p.y;
  }
  const s = area >= 0 ? 1 : -1;
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    const nx = (s * dy) / len;
    const ny = (-s * dx) / len;
    lines.push({ x: p.x + nx * d, y: p.y + ny * d, dx, dy });
  }
  return quad.map((_, i) => {
    const l1 = lines[(i + 3) % 4];
    const l2 = lines[i];
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    const t = ((l2.x - l1.x) * l2.dy - (l2.y - l1.y) * l2.dx) / den;
    return { x: l1.x + l1.dx * t, y: l1.y + l1.dy * t };
  });
}

/**
 * Exact homography (row-major 3x3) from four point correspondences src[i] -> dst[i].
 * @returns {number[]}
 */
export function homographyFrom4(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
    }
  }
  const hvec = A.map((row, i) => row[8] / row[i]);
  return [...hvec, 1];
}

/**
 * Apply a row-major 3x3 homography to a point.
 * @returns {{x:number,y:number}}
 */
export function applyH(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/**
 * Read one pixel as [r, g, b, a].
 * @returns {number[]}
 */
export function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}
