// Automatic door-OPENING corner detection for SecureMeasure.
// Plain ES module, no imports, no DOM, no dependencies: runs in the browser (main thread or worker) and Node.
// Vendored unchanged from the Nov 2026 research prototype (door-detect.mjs); the app reaches it through
// js/door-find.js, which runs it in a module worker (js/door-detect-worker.js) off the main thread.
// The `weights`, `weightsOffset`, `keepCandidates` and `dumpFeatures` options exist only for the offline
// training / debugging tools; the app never sets them, and keeping them lets those tools run on this copy.
//
// It places the STARTING handles and says "we found your door"; the customer always confirms the corners.
// Its output is never a measurement by itself.
//
//   detectDoor(image, opts) -> { ok, quad: [TL, TR, BR, BL] | null, confidence: 0..1, reason?, ... }
//
// Method (classical, no model download):
//  1. Box-downscale the RGBA photo to ~640 px long side; luma + two opponent-colour planes.
//  2. Sobel gradient; per pixel the strongest of the three planes, so colour-only edges count.
//  3. Gradient-directed Hough transform for near-vertical (jamb) and near-horizontal (head / sill) lines,
//     separate accumulators per edge polarity.
//  4. Per kept line a prefix-summed edge-support profile: the support of any stretch of a line (one side of
//     a candidate quad, or the bit next to a corner) is an O(1) lookup.
//  5. Enumerate jamb pairs x head/sill pairs -> door-shaped quads; heuristic stage-1 score (side and corner
//     support, aspect, size, position, vertical-vanishing consistency); keep a de-duplicated shortlist.
//  6. Re-rank the shortlist with a linear model over richer features: colour contrast across each side,
//     and "context" features describing the nested chain a door makes (architrave / transom+leaf > leaf >
//     panels or glazing; a step below the sill), so the leaf can win over its frame and its panels.
//     The weights were fitted on the benchmark photos (tools/train.mjs, leave-one-out validated).
//  7. Refine each side at full resolution (colour-matched step-edge search, innermost strong edge, robust
//     line fit). Exposed on its own as snapQuad() for "magnetic" handles.
//  8. Confidence: product of soft gates (margin over the best clearly different quad, weakest corner,
//     competitive nested alternative, score).
//
// MEASURED (Nov 2026; 27 Wikimedia door photos with hand-placed corners, leave-one-photo-out; 36 synthetic):
//  - real photos: all 4 corners within 3% of the image diagonal on 16/27 (59%), within 1% on 13/27; the right
//    quad is among the pick + 2 alternatives on 20/27. confidence > 0.6 on 8/27, none of them wrong.
//    Typical failure: the architrave, transom+leaf, a glazed panel or a step is chosen instead of the leaf.
//  - synthetic renders: 35/36 within 3%, median corner error 1-2 px; but ~4/30 held-out renders confidently
//    chose the architrave (all corners 30-80 px out), so a confident result still needs the customer's check.
//  - ~50 ms median, < 150 ms worst case for a 2048 px photo in Node on a desktop CPU (phones: several times
//    slower). So: use it to place the starting handles, never as a measurement by itself.
//
// COORDINATES: continuous canvas convention (pixel i spans [i, i+1)), same as js/vision.js.

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ data: Uint8ClampedArray | Uint8Array, width: number, height: number }} Image */

const DEG = Math.PI / 180;

/** Names of the re-ranking features, in weight order. */
export const FEATURES = Object.freeze([
  'edge', // perimeter-weighted side support
  'minSide', // weakest side support
  'jamb', // mean support of the two jambs
  'head', // head support
  'sill', // sill support
  'kTop', // corner support, top corners
  'kBot', // corner support, bottom corners
  'kMin', // weakest corner
  'aspDev2', // squared log-deviation of image aspect from 2.35
  'aspLog', // signed log(aspect / 2.35)
  'cenDev2', // squared horizontal offset from the image centre
  'size', // log(min(hFrac, 0.5) / 0.5)
  'hFrac', // opening height / image height
  'cy', // vertical centre - 0.5
  'oppPol', // jambs have opposite edge polarity (leaf one colour, frame another)
  'vDev', // deviation of the jambs from the vertical vanishing direction (deg, clipped)
  'ctxFrame', // a competitive candidate sits inside this one on the same sill (this is the frame)
  'ctxTransom', // ... inside with the same jambs and sill, lower head (this includes a transom)
  'ctxStep', // ... inside with the same jambs and head, higher sill (this includes a step)
  'ctxPanel', // this sits inside a competitive candidate with sides inset and bottom raised (a panel)
  'isInnerFrame', // this is the inner of a frame pattern (the leaf inside its frame)
  'ctxFrameSym', // a competitive candidate sits inside this one like a leaf in a symmetric architrave
  'conLR', // colour contrast across the jambs
  'conT', // ... across the head
  'conB', // ... across the sill
  'inUni', // colour difference between the inside bands of L, R, T (the leaf is one colour)
  'outSym', // colour difference between the outside bands of L and R (the frame is one colour)
  'inTex', // edge density inside the opening (brick, siding and foliage are busy; a leaf is calmer)
  'stage1', // stage-1 heuristic score
]);

// Fitted by tools/train.mjs on the 33 benchmark photos (pairwise logistic ranking, L2 lambda = 0.05;
// the vertical-position feature cy is held at 0 because these photos frame doors low, unlike a phone user).
// Accuracy quoted for this detector is leave-one-photo-out (each photo scored with weights fitted without it).
// prettier-ignore
export const WEIGHTS = Object.freeze([
  1.0421, -0.1022, 0.3318, 0.3945, 1.3083, 1.2976, 1.1759, 1.2108, -0.5265, 0.0416, -0.4641, 1.4305, -1.1916, 0, 0.0504, -0.2812, 0.0113, -0.3751, -0.255, 0.1631, 0.5844, -0.4924, 0.1278, 0.402, 0.37, -0.4786, -0.4117, -1.7188, 0.4732,
]);

export const SCORE_OFFSET = -4.5652;

// Confidence = product of soft gates (margin over the best clearly different quad, weakest corner support,
// competitive nested alternative, overall score). Thresholds set by hand on the benchmark photos.
export const CONFIDENCE_MODEL = Object.freeze({ margin: 0.4, kMin: 0.5, maxCtx: 0.7, score: 2 });

export const DEFAULTS = Object.freeze({
  workSize: 640, // long side of the analysis image
  vTiltDeg: 20, // jambs: max angle from image vertical
  hTiltDeg: 32, // head / sill: max angle from image horizontal
  angStepDeg: 0.5,
  voteTolDeg: 3, // a pixel votes for line angles within this of its own edge direction
  profTolDeg: 12, // support profile: gradient must be within this of the line normal
  maxV: 44, // lines kept per family
  maxH: 60,
  minLineFrac: 0.05, // Hough peak must have support worth this fraction of the image extent
  minSideSup: 0.3, // every side of a candidate must have at least this support fraction
  aspMin: 1.6, // image-space height / width of the opening
  aspMax: 4.0,
  minWFrac: 0.06, // opening width as a fraction of the image width
  maxWFrac: 0.9,
  minHFrac: 0.2, // opening height as a fraction of the image height
  chromaWeight: 0.8,
  priorTol: 0.2, // with opts.prior: every corner within this fraction of the prior height
  priorWeight: 3, // score penalty per (mean corner distance / prior height)
  shortlist: 160, // candidates kept (after de-duplication) for re-ranking
  refine: true,
  weights: null, // override WEIGHTS (training / cross-validation)
  weightsOffset: null,
  keepCandidates: 0, // >0 returns that many re-ranked candidates (debug / "next suggestion" UI)
  dumpFeatures: false, // training: return every shortlisted candidate with its feature vector
});

/**
 * Detect the door opening in a photo.
 *
 * @param {Image} image  RGBA photo (any size; 2048 px long side is typical)
 * @param {object} [opts]  overrides of DEFAULTS, plus:
 * @param {Point}  [opts.hint]  where the customer tapped on the door (full-res px): only quads containing it
 * @param {Point[]} [opts.prior]  rough opening quad [TL, TR, BR, BL] (full-res px): a capture guide the customer
 *        lined the door up with, or their first rough placement. Candidates must lie near it.
 * @param {number} [opts.focalPx]  focal length in full-res px, if known (adds a rectified-aspect prior)
 * @param {{ data: ArrayLike<number>, width: number, height: number }} [opts.depth]  optional depth map (any
 *        resolution, same framing, larger = farther). Weak extra cue: an opening is not nearer to the
 *        camera than the wall band around it. Hand-set weight; not validated on real depth maps.
 * @returns {{ ok: boolean, quad: Point[] | null, confidence: number, reason?: string, score?: number,
 *             refined?: boolean, alternatives?: Point[][], timings?: object }}
 */
export function detectDoor(image, opts = {}) {
  const fail = (reason) => ({ ok: false, quad: null, confidence: 0, reason });
  if (!image || !image.data || !(image.width >= 32) || !(image.height >= 32)) return fail('bad_input');
  if (image.data.length < image.width * image.height * 4) return fail('bad_input');
  try {
    return detectImpl(image, { ...DEFAULTS, ...opts }, fail);
  } catch (err) {
    return { ...fail('error'), error: String(err && err.stack ? err.stack : err) };
  }
}

/**
 * Starting handles when there is no confident detection: a door-shaped (2.35:1 in the image) rectangle,
 * centred, 62% of the photo height (narrower than the full-width default, which puts every handle far from
 * a door that fills a third of a portrait photo).
 * @param {number} W image width
 * @param {number} H image height
 * @returns {Point[]} [TL, TR, BR, BL]
 */
export function suggestDefaultQuad(W, H) {
  let hq = 0.62 * H;
  let wq = hq / ASPECT_CENTRE;
  if (wq > 0.8 * W) {
    wq = 0.8 * W;
    hq = wq * ASPECT_CENTRE;
  }
  const cx = 0.5 * W;
  const cy = 0.52 * H;
  return [
    { x: cx - wq / 2, y: cy - hq / 2 },
    { x: cx + wq / 2, y: cy - hq / 2 },
    { x: cx + wq / 2, y: cy + hq / 2 },
    { x: cx - wq / 2, y: cy + hq / 2 },
  ];
}

function validQuad(q) {
  return Array.isArray(q) && q.length === 4 && q.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

/* ------------------------------------------------------------------------------------------------ */

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function detectImpl(image, cfg, fail) {
  const t0 = now();
  const T = {};
  const work = downscale(image, cfg.workSize, cfg.chromaWeight);
  const { w, h } = work;
  const grad = gradients(work);
  T.prep = now() - t0;

  const thr = edgeThresholds(grad.mag, w, h);
  const sup = softSupport(grad.mag, thr);
  const famV = houghFamily('V', grad, sup, w, h, cfg);
  const famH = houghFamily('H', grad, sup, w, h, cfg);
  T.hough = now() - t0;
  if (famV.length < 2 || famH.length < 2) return { ...fail('no_lines'), timings: T };

  for (const L of famV) L.prof = lineProfile(L, grad, w, h, thr, cfg);
  for (const L of famH) L.prof = lineProfile(L, grad, w, h, thr, cfg);
  const vvp = verticalDirectionModel(famV, w, h);

  const sx = image.width / w; // full-res px per work px
  const sy = image.height / h;
  const hint = cfg.hint ? { x: cfg.hint.x / sx, y: cfg.hint.y / sy } : null;
  const focal = cfg.focalPx > 0 ? cfg.focalPx / Math.sqrt(sx * sy) : 0;
  const prior = validQuad(cfg.prior) ? cfg.prior.map((p) => ({ x: p.x / sx, y: p.y / sy })) : null;

  const all = enumerate(famV, famH, w, h, cfg, vvp, hint, focal, prior);
  T.enumerate = now() - t0;
  if (!all.length) return { ...fail(prior ? 'no_candidate_near_prior' : hint ? 'no_candidate_at_hint' : 'no_candidate'), timings: T };

  const diag = Math.hypot(w, h);
  const cands = dedupe(all, 0.006 * diag, cfg.shortlist);
  regionFeatures(cands, work);
  textureFeature(cands, sup, w, h);
  contextFeatures(cands);
  if (cfg.depth) depthFeature(cands, cfg.depth, w, h);
  const wts = cfg.weights || WEIGHTS;
  const off = cfg.weights ? cfg.weightsOffset || 0 : SCORE_OFFSET;
  for (const c of cands) {
    c.phi = FEATURES.map((k) => c.f[k] || 0);
    let s = off;
    for (let i = 0; i < wts.length; i++) s += wts[i] * c.phi[i];
    if (c.f.depthRecess !== undefined) s += 0.5 * c.f.depthRecess;
    if (prior) s -= cfg.priorWeight * c.f.priorDist;
    c.score = s;
  }
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  T.rank = now() - t0;

  const toFull = (q) => q.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  if (cfg.dumpFeatures) {
    return {
      ok: true,
      quad: toFull(best.quad),
      confidence: 0,
      shortlist: cands.map((c) => ({ quad: toFull(c.quad), phi: c.phi, score: c.score })),
      work: { w, h },
      timings: T,
    };
  }

  // Margin to the best clearly different candidate (> 3% of the diagonal away at some corner).
  let rival = null;
  for (const c of cands) {
    if (c !== best && maxCornerDist(c.quad, best.quad) > 0.03 * diag) {
      rival = c;
      break;
    }
  }

  let quad = toFull(best.quad);
  let refined = false;
  if (cfg.refine) {
    const r = refineSides(image, quad, Math.max(4, 0.8 * (sx + sy)));
    if (r) {
      quad = r;
      refined = true;
    }
  }
  T.refine = now() - t0;

  const out = {
    ok: true,
    quad,
    confidence: confidenceOf(best, rival ? best.score - rival.score : 3),
    score: best.score,
    margin: rival ? best.score - rival.score : null,
    refined,
    features: best.f,
    timings: T,
  };
  // Up to two clearly different runners-up, for a "not this one? tap for the next" control.
  const alts = [];
  for (const c of cands) {
    if (alts.length >= 2) break;
    if (c === best) continue;
    if (maxCornerDist(c.quad, best.quad) <= 0.03 * diag) continue;
    if (alts.some((a) => maxCornerDist(a.quad, c.quad) <= 0.03 * diag)) continue;
    alts.push(c);
  }
  out.alternatives = alts.map((c) => toFull(c.quad));
  if (cfg.keepCandidates > 0) {
    out.candidates = cands.slice(0, cfg.keepCandidates).map((c) => ({ score: c.score, f: c.f, quad: toFull(c.quad) }));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ */
/* 1. Downscale to analysis planes                                                                    */
/* ------------------------------------------------------------------------------------------------ */

function downscale(image, workSize, chromaWeight) {
  const { data, width: W, height: H } = image;
  const s = Math.min(1, workSize / Math.max(W, H));
  const w = Math.max(16, Math.round(W * s));
  const h = Math.max(16, Math.round(H * s));
  const colMap = new Int32Array(W);
  const colCnt = new Float32Array(w);
  for (let x = 0; x < W; x++) {
    const c = Math.min(w - 1, Math.floor(((x + 0.5) * w) / W));
    colMap[x] = c;
    colCnt[c]++;
  }
  const rowCnt = new Float32Array(h);
  const R = new Float32Array(w * h);
  const G = new Float32Array(w * h);
  const B = new Float32Array(w * h);
  for (let y = 0; y < H; y++) {
    const r = Math.min(h - 1, Math.floor(((y + 0.5) * h) / H));
    rowCnt[r]++;
    const base = r * w;
    let j = y * W * 4;
    for (let x = 0; x < W; x++, j += 4) {
      const i = base + colMap[x];
      R[i] += data[j];
      G[i] += data[j + 1];
      B[i] += data[j + 2];
    }
  }
  const L = new Float32Array(w * h);
  const C1 = new Float32Array(w * h);
  const C2 = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const inv = 1 / (rowCnt[y] * colCnt[x]);
      const r = (R[i] *= inv);
      const g = (G[i] *= inv);
      const b = (B[i] *= inv);
      L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      C1[i] = chromaWeight * (r - g) * 0.5;
      C2[i] = chromaWeight * ((r + g) * 0.5 - b) * 0.5;
    }
  }
  return { w, h, R, G, B, L, C1, C2 };
}

/* ------------------------------------------------------------------------------------------------ */
/* 2. Gradients                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

function gradients(work) {
  const { w, h } = work;
  const planes = [work.L, work.C1, work.C2];
  const n = w * h;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = -1;
      let bx = 0;
      let by = 0;
      for (let c = 0; c < 3; c++) {
        const p = planes[c];
        const a = p[i - w - 1];
        const b = p[i - w];
        const d = p[i - w + 1];
        const e = p[i - 1];
        const f = p[i + 1];
        const g = p[i + w - 1];
        const k = p[i + w];
        const l = p[i + w + 1];
        const gxv = (d + 2 * f + l - a - 2 * e - g) * 0.25;
        const gyv = (g + 2 * k + l - a - 2 * b - d) * 0.25;
        const m2 = gxv * gxv + gyv * gyv;
        if (m2 > best) {
          best = m2;
          bx = gxv;
          by = gyv;
        }
      }
      gx[i] = bx;
      gy[i] = by;
      mag[i] = Math.sqrt(best);
    }
  }
  return { gx, gy, mag };
}

/** Soft edge thresholds from the gradient-magnitude distribution (textured scenes get higher ones). */
function edgeThresholds(mag, w, h) {
  const bins = new Uint32Array(512);
  let n = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const v = mag[y * w + x] * 2;
      bins[v < 511 ? v | 0 : 511]++;
      n++;
    }
  }
  let acc = 0;
  let med = 255;
  for (let i = 0; i < 512; i++) {
    acc += bins[i];
    if (acc >= 0.5 * n) {
      med = i / 2;
      break;
    }
  }
  const lo = Math.min(14, Math.max(3, 1.3 * med + 1.5));
  const hi = Math.max(lo + 8, 2.6 * lo);
  return { lo, hi, med };
}

function softSupport(mag, thr) {
  const n = mag.length;
  const out = new Float32Array(n);
  const inv = 1 / (thr.hi - thr.lo);
  for (let i = 0; i < n; i++) {
    const s = (mag[i] - thr.lo) * inv;
    out[i] = s <= 0 ? 0 : s >= 1 ? 1 : s;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ */
/* 3. Gradient-directed Hough per family                                                              */
/* ------------------------------------------------------------------------------------------------ */
// Family 'V': u = x, v = y. Family 'H': u = y, v = x. A line is u(v) = m - (v - c2) * t, t = tan(alpha),
// alpha = angle of its normal from the u axis. pol = +1 when the image gets brighter towards +u.

function houghFamily(fam, grad, sup, w, h, cfg) {
  const isV = fam === 'V';
  const A = (isV ? cfg.vTiltDeg : cfg.hTiltDeg) * DEG;
  const step = cfg.angStepDeg * DEG;
  const half = Math.round(A / step);
  const nA = 2 * half + 1;
  const tans = new Float32Array(nA);
  for (let k = 0; k < nA; k++) tans[k] = Math.tan((k - half) * step);
  const lenU = isV ? w : h;
  const lenV = isV ? h : w;
  const c2 = lenV / 2;
  const margin = Math.ceil(c2 * Math.tan(A)) + 2;
  const nOff = lenU + 2 * margin;
  const accP = new Float32Array(nA * nOff);
  const accN = new Float32Array(nA * nOff);
  const kTol = Math.max(1, Math.round((cfg.voteTolDeg * DEG) / step));
  const limit = A + kTol * step;
  const { gx, gy } = grad;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const s = sup[i];
      if (s <= 0) continue;
      let gu = isV ? gx[i] : gy[i];
      let gv = isV ? gy[i] : gx[i];
      let acc = accP;
      if (gu < 0) {
        gu = -gu;
        gv = -gv;
        acc = accN;
      }
      if (gu === 0) continue;
      const phi = Math.atan(gv / gu);
      if (phi > limit || phi < -limit) continue;
      const u = (isV ? x : y) + 0.5;
      const dv = (isV ? y : x) + 0.5 - c2;
      const k0 = Math.round(phi / step) + half;
      const ka = k0 - kTol < 0 ? 0 : k0 - kTol;
      const kb = k0 + kTol > nA - 1 ? nA - 1 : k0 + kTol;
      for (let k = ka; k <= kb; k++) {
        const off = (u + dv * tans[k] + margin) | 0;
        if (off >= 0 && off < nOff) acc[k * nOff + off] += s;
      }
    }
  }

  const minVotes = cfg.minLineFrac * lenV;
  const peaks = [];
  const KW = 3;
  const OW = 2;
  for (let pi = 0; pi < 2; pi++) {
    const acc = pi === 0 ? accP : accN;
    const pol = pi === 0 ? 1 : -1;
    for (let k = 0; k < nA; k++) {
      for (let o = 0; o < nOff; o++) {
        const v = acc[k * nOff + o];
        if (v < minVotes) continue;
        let isMax = true;
        for (let dk = -KW; dk <= KW && isMax; dk++) {
          const kk = k + dk;
          if (kk < 0 || kk >= nA) continue;
          for (let d = -OW; d <= OW; d++) {
            const oo = o + d;
            if (oo < 0 || oo >= nOff || (dk === 0 && d === 0)) continue;
            const q = acc[kk * nOff + oo];
            if (q > v || (q === v && (dk < 0 || (dk === 0 && d < 0)))) {
              isMax = false;
              break;
            }
          }
        }
        if (!isMax) continue;
        const l = o > 0 ? acc[k * nOff + o - 1] : 0;
        const r = o < nOff - 1 ? acc[k * nOff + o + 1] : 0;
        const den = l - 2 * v + r;
        const sub = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
        peaks.push({ fam, pol, t: tans[k], m: o - margin + 0.5 + sub, votes: v, c2 });
      }
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  return peaks.slice(0, isV ? cfg.maxV : cfg.maxH);
}

/* ------------------------------------------------------------------------------------------------ */
/* 4. Support profiles                                                                                */
/* ------------------------------------------------------------------------------------------------ */

function lineProfile(L, grad, w, h, thr, cfg) {
  const isV = L.fam === 'V';
  const { gx, gy } = grad;
  const cosA = 1 / Math.sqrt(1 + L.t * L.t);
  const sinA = L.t * cosA;
  const nu = cosA * L.pol;
  const nv = sinA * L.pol;
  const tanTol = Math.tan(cfg.profTolDeg * DEG);
  const inv = 1 / (thr.hi - thr.lo);
  const lenU = isV ? w : h;
  const lenV = isV ? h : w;
  const P = new Float32Array(lenV + 1);
  for (let j = 0; j < lenV; j++) {
    const u = L.m - (j + 0.5 - L.c2) * L.t;
    const ui = Math.floor(u);
    let best = 0;
    for (let d = -1; d <= 1; d++) {
      const uu = ui + d;
      if (uu < 0 || uu >= lenU) continue;
      const i = isV ? j * w + uu : uu * w + j;
      const gu = isV ? gx[i] : gy[i];
      const gv = isV ? gy[i] : gx[i];
      const proj = gu * nu + gv * nv;
      if (proj <= 0) continue;
      const perp = Math.abs(gv * nu - gu * nv);
      if (perp > proj * tanTol) continue;
      let s = (proj - thr.lo) * inv;
      if (s <= 0) continue;
      if (s > 1) s = 1;
      if (s > best) best = s;
    }
    P[j + 1] = P[j] + best;
  }
  return P;
}

/** Mean support of line L between along-coordinates a and b (outside the image counts as 0). */
function support(L, a, b) {
  const len = Math.abs(b - a);
  if (!(len > 1e-6)) return 0;
  const P = L.prof;
  const n = P.length - 1;
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  if (lo < 0) lo = 0;
  if (hi > n) hi = n;
  if (hi <= lo) return 0;
  return (prefixAt(P, hi) - prefixAt(P, lo)) / len;
}

function prefixAt(P, x) {
  const i = Math.floor(x);
  if (i >= P.length - 1) return P[P.length - 1];
  const f = x - i;
  return P[i] + f * (P[i + 1] - P[i]);
}

/** Intersection of a 'V' line and an 'H' line in work-image coordinates. */
function intersectVH(V, H) {
  const yc = V.c2;
  const xc = H.c2;
  const den = 1 - H.t * V.t;
  const x = (V.m - (H.m - yc) * V.t - xc * H.t * V.t) / den;
  const y = H.m - (x - xc) * H.t;
  return { x, y };
}

/* ------------------------------------------------------------------------------------------------ */
/* Vertical vanishing direction                                                                       */
/* ------------------------------------------------------------------------------------------------ */
// Verticals through one vanishing point have tan(alpha) exactly linear in their x at the image centre:
// t = a + b * (m - xc). Fitted robustly (RANSAC over pairs + weighted LS) on the strong vertical lines.

function verticalDirectionModel(famV, w, h) {
  const pts = famV.filter((L) => L.votes > 0.12 * h).map((L) => ({ x: L.m - w / 2, t: L.t, wt: L.votes }));
  if (pts.length < 4) return null;
  let best = null;
  const tol = Math.tan(0.6 * DEG);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (Math.abs(dx) < 0.1 * w) continue;
      const b = (pts[j].t - pts[i].t) / dx;
      const a = pts[i].t - b * pts[i].x;
      if (Math.abs(b) * w > Math.tan(25 * DEG)) continue;
      let s = 0;
      for (const p of pts) if (Math.abs(p.t - (a + b * p.x)) < tol) s += p.wt;
      if (!best || s > best.s) best = { a, b, s };
    }
  }
  if (!best) return null;
  let sw = 0;
  let sx = 0;
  let st = 0;
  let sxx = 0;
  let sxt = 0;
  let n = 0;
  for (const p of pts) {
    if (Math.abs(p.t - (best.a + best.b * p.x)) >= tol) continue;
    sw += p.wt;
    sx += p.wt * p.x;
    st += p.wt * p.t;
    sxx += p.wt * p.x * p.x;
    sxt += p.wt * p.x * p.t;
    n++;
  }
  if (n < 3) return null;
  const det = sw * sxx - sx * sx;
  if (Math.abs(det) < 1e-9) return null;
  const b = (sw * sxt - sx * st) / det;
  const a = (st - b * sx) / sw;
  return { a, b, xc: w / 2 };
}

function vvpDeviationDeg(vvp, L) {
  if (!vvp) return 0;
  const tExp = vvp.a + vvp.b * (L.m - vvp.xc);
  return Math.abs(Math.atan(L.t) - Math.atan(tExp)) / DEG;
}

/* ------------------------------------------------------------------------------------------------ */
/* 5. Candidate enumeration, stage-1 score                                                            */
/* ------------------------------------------------------------------------------------------------ */

const CORNER_FRAC_V = 0.1; // corner window along a jamb, fraction of its length
const CORNER_FRAC_H = 0.18; // corner window along the head / sill, fraction of its length
const ASPECT_CENTRE = 2.35; // typical image-space height / width of a door opening

function enumerate(famV, famH, w, h, cfg, vvp, hint, focal, prior) {
  const priorH = prior ? 0.5 * (prior[3].y - prior[0].y + prior[2].y - prior[1].y) : 0;
  const priorTol = cfg.priorTol * Math.abs(priorH);
  const V = famV.slice().sort((a, b) => a.m - b.m);
  const vDev = V.map((L) => vvpDeviationDeg(vvp, L));
  const nH = famH.length;
  const hx = new Float32Array(nH * 4); // per H line: xL, yL, xR, yR for the current jamb pair
  const hs = new Float32Array(nH);
  const order = new Int32Array(nH);
  const out = [];
  let bestFast = -Infinity;
  const minW = cfg.minWFrac * w;
  const maxW = cfg.maxWFrac * w;
  const yc = h / 2;
  const tolOut = 0.01 * h;

  for (let a = 0; a < V.length; a++) {
    const La = V[a];
    for (let b = a + 1; b < V.length; b++) {
      const Lb = V[b];
      const wc = Lb.m - La.m;
      if (wc < minW || wc > maxW) continue;
      const top = Lb.m + yc * Lb.t - (La.m + yc * La.t);
      const bot = Lb.m - (h - yc) * Lb.t - (La.m - (h - yc) * La.t);
      if (top < 0.5 * minW || bot < 0.5 * minW) continue;
      if (hint) {
        const xa = La.m - (hint.y - yc) * La.t;
        const xb = Lb.m - (hint.y - yc) * Lb.t;
        if (hint.x < xa || hint.x > xb) continue;
      }
      let nk = 0;
      for (let j = 0; j < nH; j++) {
        const Hj = famH[j];
        const p = intersectVH(La, Hj);
        const q = intersectVH(Lb, Hj);
        if (p.y < -tolOut || p.y > h + tolOut || q.y < -tolOut || q.y > h + tolOut) continue;
        const s = support(Hj, p.x, q.x);
        if (s < cfg.minSideSup) continue;
        hx[j * 4] = p.x;
        hx[j * 4 + 1] = p.y;
        hx[j * 4 + 2] = q.x;
        hx[j * 4 + 3] = q.y;
        hs[j] = s;
        order[nk++] = j;
      }
      if (nk < 2) continue;
      for (let i1 = 0; i1 < nk; i1++) {
        const jt = order[i1];
        for (let i2 = 0; i2 < nk; i2++) {
          const jb = order[i2];
          if (jb === jt) continue;
          const tyL = hx[jt * 4 + 1];
          const tyR = hx[jt * 4 + 3];
          const byL = hx[jb * 4 + 1];
          const byR = hx[jb * 4 + 3];
          const hL = byL - tyL;
          const hR = byR - tyR;
          if (!(hL > 0 && hR > 0)) continue;
          const hgt = 0.5 * (hL + hR);
          if (hgt < cfg.minHFrac * h) continue;
          const xtl = hx[jt * 4];
          const xtr = hx[jt * 4 + 2];
          const xbl = hx[jb * 4];
          const xbr = hx[jb * 4 + 2];
          const wT = xtr - xtl;
          const wB = xbr - xbl;
          if (!(wT > 0 && wB > 0)) continue;
          const wid = 0.5 * (wT + wB);
          const asp = hgt / wid;
          if (asp < cfg.aspMin || asp > cfg.aspMax) continue;
          if (hint) {
            const yt = tyL + ((hint.x - xtl) / wT) * (tyR - tyL);
            const yb = byL + ((hint.x - xbl) / wB) * (byR - byL);
            if (hint.y < yt || hint.y > yb) continue;
          }
          const sL = support(La, tyL, byL);
          if (sL < cfg.minSideSup) continue;
          const sR = support(Lb, tyR, byR);
          if (sR < cfg.minSideSup) continue;
          const Ht = famH[jt];
          const Hb = famH[jb];
          // Corner evidence: both sides supported right up to the corner (a real corner, not two lines
          // crossing, e.g. collinear panel edges meeting the sill, or a panel's top rail).
          const cv = CORNER_FRAC_V;
          const ch = CORNER_FRAC_H;
          const kTL = Math.sqrt(support(La, tyL, tyL + cv * hL) * support(Ht, xtl, xtl + ch * wT));
          const kTR = Math.sqrt(support(Lb, tyR, tyR + cv * hR) * support(Ht, xtr - ch * wT, xtr));
          const kBL = Math.sqrt(support(La, byL - cv * hL, byL) * support(Hb, xbl, xbl + ch * wB));
          const kBR = Math.sqrt(support(Lb, byR - cv * hR, byR) * support(Hb, xbr - ch * wB, xbr));
          // Cheap bound before allocating: candidates far below the best so far can never matter.
          const fast = stage1Fast(sL, sR, hs[jt], hs[jb], kTL, kTR, kBL, kBR, asp, hgt, wid, hgt / h, (xtl + xtr + xbr + xbl) / 4 / w, La.pol !== Lb.pol, Math.max(vDev[a], vDev[b]));
          if (fast < bestFast - KEEP_BELOW_BEST) continue;
          if (fast > bestFast) bestFast = fast;
          const quad = [
            { x: xtl, y: tyL },
            { x: xtr, y: tyR },
            { x: xbr, y: byR },
            { x: xbl, y: byL },
          ];
          let priorDist = 0;
          if (prior) {
            let worst = 0;
            for (let k = 0; k < 4; k++) {
              const d = Math.hypot(quad[k].x - prior[k].x, quad[k].y - prior[k].y);
              priorDist += d / 4;
              if (d > worst) worst = d;
            }
            if (worst > priorTol) continue;
            priorDist /= Math.abs(priorH);
          }
          const f = {
            priorDist,
            sL, sR, sT: hs[jt], sB: hs[jb], kTL, kTR, kBR, kBL, asp, hgt, wid,
            hFrac: hgt / h,
            cxF: (xtl + xtr + xbr + xbl) / 4 / w,
            cyF: (tyL + tyR + byR + byL) / 4 / h,
            oppPol: La.pol !== Lb.pol ? 1 : 0,
            vDevRaw: Math.max(vDev[a], vDev[b]),
            rectAsp: focal ? rectifiedAspect(quad, focal, w, h) : 0,
          };
          const s1 = stage1(f);
          if (s1 < -2) continue;
          out.push({ quad, f, s1 });
        }
      }
    }
  }
  out.sort((x, y) => y.s1 - x.s1);
  const floor = out.length ? out[0].s1 - KEEP_BELOW_BEST : 0;
  let n = out.length;
  while (n > 0 && out[n - 1].s1 < floor) n--;
  out.length = n;
  return out;
}

const KEEP_BELOW_BEST = 2.5;

/** stage1 without the optional focal-length term, from scalars (no allocation). */
function stage1Fast(sL, sR, sT, sB, kTL, kTR, kBL, kBR, asp, hgt, wid, hFrac, cxF, oppPol, vDevRaw) {
  const edge = (hgt * (sL + sR) + wid * (sT + 0.8 * sB)) / (2 * hgt + 1.8 * wid);
  const minSide = Math.min(sL, sR, sT, sB);
  const kMin = Math.min(kTL, kTR, kBL, kBR);
  const la = Math.log(asp / ASPECT_CENTRE) / 0.2;
  const dc = (cxF - 0.5) / 0.28;
  return (
    2.5 * edge + minSide + 0.4 * (kTL + kTR) + 0.25 * (kBL + kBR) + 0.5 * kMin - 0.35 * Math.min(4, la * la) -
    0.3 * Math.min(4, dc * dc) + 0.8 * Math.log(Math.min(hFrac, 0.5) / 0.5) + (oppPol ? 0.15 : 0) -
    0.4 * Math.min(3, Math.max(0, vDevRaw - 0.75))
  );
}

/** Hand-set stage-1 score; also fills the per-candidate geometric features used by the re-ranker. */
function stage1(f) {
  f.edge = (f.hgt * (f.sL + f.sR) + f.wid * (f.sT + 0.8 * f.sB)) / (2 * f.hgt + 1.8 * f.wid);
  f.minSide = Math.min(f.sL, f.sR, f.sT, f.sB);
  f.jamb = 0.5 * (f.sL + f.sR);
  f.head = f.sT;
  f.sill = f.sB;
  f.kTop = 0.5 * (f.kTL + f.kTR);
  f.kBot = 0.5 * (f.kBL + f.kBR);
  f.kMin = Math.min(f.kTL, f.kTR, f.kBL, f.kBR);
  f.aspLog = Math.log(f.asp / ASPECT_CENTRE);
  const la = f.aspLog / 0.2;
  f.aspDev2 = Math.min(4, la * la);
  const dc = (f.cxF - 0.5) / 0.28;
  f.cenDev2 = Math.min(4, dc * dc);
  f.size = Math.log(Math.min(f.hFrac, 0.5) / 0.5);
  f.cy = f.cyF - 0.5;
  f.vDev = Math.min(3, Math.max(0, f.vDevRaw - 0.75));
  let s =
    2.5 * f.edge + 1.0 * f.minSide + 0.8 * f.kTop + 0.5 * f.kBot + 0.5 * f.kMin -
    0.35 * f.aspDev2 - 0.3 * f.cenDev2 + 0.8 * f.size + 0.15 * f.oppPol - 0.4 * f.vDev;
  if (f.rectAsp) {
    const lr = Math.log(f.rectAsp / 2.45) / 0.15;
    s -= 0.3 * Math.min(4, lr * lr);
  }
  f.stage1 = s;
  return s;
}

/** Height / width of the rectangle that projects to `quad` (pinhole, focal f, centred principal point). */
function rectifiedAspect(quad, f, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const P = quad.map((p) => [(p.x - cx) / f, (p.y - cy) / f]);
  const H = squareToQuad(P);
  if (!H) return 0;
  const n1 = Math.hypot(H[0], H[3], H[6]);
  const n2 = Math.hypot(H[1], H[4], H[7]);
  return n1 > 0 ? n2 / n1 : 0;
}

/** Projective map of the unit square onto P[0..3] ((0,0)->P0, (1,0)->P1, (1,1)->P2, (0,1)->P3). */
function squareToQuad(P) {
  const [x0, y0] = P[0];
  const [x1, y1] = P[1];
  const [x2, y2] = P[2];
  const [x3, y3] = P[3];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const hh = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
}

function maxCornerDist(a, b) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return m;
}

/** Greedy non-maximum suppression on the stage-1 order. */
function dedupe(all, radius, keep) {
  const kept = [];
  for (const c of all) {
    if (kept.length >= keep) break;
    let dup = false;
    for (const k of kept) {
      if (maxCornerDist(k.quad, c.quad) < radius) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(c);
  }
  return kept;
}

/* ------------------------------------------------------------------------------------------------ */
/* 6a. Region features: colour on both sides of each side                                              */
/* ------------------------------------------------------------------------------------------------ */

function bilinear3(work, x, y, out) {
  const { w, h, R, G, B } = work;
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > w - 1.001) fx = w - 1.001;
  if (fy < 0) fy = 0;
  else if (fy > h - 1.001) fy = h - 1.001;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const ax = fx - x0;
  const ay = fy - y0;
  const i = y0 * w + x0;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  out[0] += R[i] * w00 + R[i + 1] * w10 + R[i + w] * w01 + R[i + w + 1] * w11;
  out[1] += G[i] * w00 + G[i + 1] * w10 + G[i + w] * w01 + G[i + w + 1] * w11;
  out[2] += B[i] * w00 + B[i + 1] * w10 + B[i + w] * w01 + B[i + w + 1] * w11;
}

/** Mean colours of thin bands just inside and just outside side k (0 top, 1 right, 2 bottom, 3 left). */
function sideBands(work, quad, k, d) {
  const p = quad[k];
  const q = quad[(k + 1) % 4];
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const nx = -(q.y - p.y) / len; // inward normal for a clockwise (TL, TR, BR, BL) quad, y down
  const ny = (q.x - p.x) / len;
  const inC = [0, 0, 0];
  const outC = [0, 0, 0];
  const N = 12;
  for (let i = 0; i < N; i++) {
    const t = 0.15 + (0.7 * (i + 0.5)) / N;
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    bilinear3(work, x + nx * d, y + ny * d, inC);
    bilinear3(work, x - nx * d, y - ny * d, outC);
  }
  for (let c = 0; c < 3; c++) {
    inC[c] /= N;
    outC[c] /= N;
  }
  return { inC, outC };
}

const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 64;

function regionFeatures(cands, work) {
  for (const c of cands) {
    const d = Math.max(1.5, 0.06 * c.f.wid);
    const s = [0, 1, 2, 3].map((k) => sideBands(work, c.quad, k, d));
    const [T, R, B, L] = s;
    c.f.conLR = Math.min(2, 0.5 * (cdist(L.inC, L.outC) + cdist(R.inC, R.outC)));
    c.f.conT = Math.min(2, cdist(T.inC, T.outC));
    c.f.conB = Math.min(2, cdist(B.inC, B.outC));
    c.f.inUni = Math.min(2, (cdist(L.inC, R.inC) + cdist(L.inC, T.inC) + cdist(R.inC, T.inC)) / 3);
    c.f.outSym = Math.min(2, cdist(L.outC, R.outC));
  }
}

/** Mean soft edge support inside the opening (inner 70% of its bounding box), via a summed-area table. */
function textureFeature(cands, sup, w, h) {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += sup[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  for (const c of cands) {
    const q = c.quad;
    const x0 = Math.max(q[0].x, q[3].x);
    const x1 = Math.min(q[1].x, q[2].x);
    const y0 = Math.max(q[0].y, q[1].y);
    const y1 = Math.min(q[2].y, q[3].y);
    const mx = 0.15 * (x1 - x0);
    const my = 0.15 * (y1 - y0);
    const a = Math.max(0, Math.min(w, Math.round(x0 + mx)));
    const b = Math.max(0, Math.min(w, Math.round(x1 - mx)));
    const t = Math.max(0, Math.min(h, Math.round(y0 + my)));
    const u = Math.max(0, Math.min(h, Math.round(y1 - my)));
    const area = (b - a) * (u - t);
    c.f.inTex = area > 0 ? (sat[u * (w + 1) + b] - sat[t * (w + 1) + b] - sat[u * (w + 1) + a] + sat[t * (w + 1) + a]) / area : 0;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* 6b. Context features: where a candidate sits in the nested chain of door-shaped outlines            */
/* ------------------------------------------------------------------------------------------------ */
// Insets of `inner` relative to `outer`, as fractions of the outer's width / height (positive = inside).
function nestRelation(inner, outer) {
  const qi = inner.quad;
  const qo = outer.quad;
  const ow = outer.f.wid;
  const oh = outer.f.hgt;
  const dl = (0.5 * (qi[0].x + qi[3].x) - 0.5 * (qo[0].x + qo[3].x)) / ow;
  const dr = (0.5 * (qo[1].x + qo[2].x) - 0.5 * (qi[1].x + qi[2].x)) / ow;
  const dt = (0.5 * (qi[0].y + qi[1].y) - 0.5 * (qo[0].y + qo[1].y)) / oh;
  const db = (0.5 * (qo[2].y + qo[3].y) - 0.5 * (qi[2].y + qi[3].y)) / oh;
  return { dl, dr, dt, db };
}

// How competitive candidate b is relative to a, from its stage-1 score: 1 when as good, 0 when 1.5 worse.
const compete = (a, b) => Math.max(0, Math.min(1.5, 1 + (b.s1 - a.s1) / 1.5));

function contextFeatures(cands) {
  for (const c of cands) {
    c.f.ctxFrame = 0;
    c.f.ctxTransom = 0;
    c.f.ctxStep = 0;
    c.f.ctxPanel = 0;
    c.f.isInnerFrame = 0;
    c.f.ctxFrameSym = 0;
  }
  const n = cands.length;
  for (let i = 0; i < n; i++) {
    const o = cands[i];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const c = cands[j];
      const r = nestRelation(c, o); // c inside o?
      if (r.dl < -0.03 || r.dr < -0.03 || r.dt < -0.03 || r.db < -0.03) continue;
      const shareL = Math.abs(r.dl) < 0.03;
      const shareR = Math.abs(r.dr) < 0.03;
      const shareT = Math.abs(r.dt) < 0.03;
      const shareB = Math.abs(r.db) < 0.03;
      if (shareB && r.dl < 0.25 && r.dr < 0.25 && r.dl + r.dr > 0.03 && r.dt < 0.35) {
        o.f.ctxFrame = Math.max(o.f.ctxFrame, compete(o, c));
        c.f.isInnerFrame = Math.max(c.f.isInnerFrame, compete(c, o));
      }
      // Architrave pattern: the inner outline is inset by about the same amount on both jambs, a little at the
      // head, not at all at the sill, and has four real corners.
      if (shareB && r.dl > 0.03 && r.dr > 0.03 && r.dl < 0.22 && r.dr < 0.22 && Math.abs(r.dl - r.dr) < 0.06 && r.dt > 0.005 && r.dt < 0.12 && c.f.kMin >= 0.6) {
        o.f.ctxFrameSym = Math.max(o.f.ctxFrameSym, compete(o, c));
      }
      if (shareL && shareR && shareB && r.dt > 0.04 && r.dt < 0.35) o.f.ctxTransom = Math.max(o.f.ctxTransom, compete(o, c));
      if (shareL && shareR && shareT && r.db > 0.02 && r.db < 0.15) o.f.ctxStep = Math.max(o.f.ctxStep, compete(o, c));
      if (r.dl > 0.06 && r.dr > 0.06 && r.dt > 0.03 && r.db > 0.04 && c.f.hgt < 0.7 * o.f.hgt) {
        c.f.ctxPanel = Math.max(c.f.ctxPanel, compete(c, o));
      }
    }
  }
}

/** Optional depth cue: median depth inside the opening minus the surrounding band, relative. */
function depthFeature(cands, depth, w, h) {
  const { data, width: dw, height: dh } = depth;
  const sample = (x, y) => {
    const u = Math.min(dw - 1, Math.max(0, Math.floor((x / w) * dw)));
    const v = Math.min(dh - 1, Math.max(0, Math.floor((y / h) * dh)));
    return data[v * dw + u];
  };
  const med = (a) => {
    const s = a.filter(Number.isFinite).sort((p, q) => p - q);
    return s.length ? s[s.length >> 1] : NaN;
  };
  for (const c of cands) {
    const q = c.quad;
    const inside = [];
    const ring = [];
    for (let i = 1; i < 8; i++) {
      for (let j = 1; j < 8; j++) {
        const u = i / 8;
        const v = j / 8;
        const x = (1 - v) * ((1 - u) * q[0].x + u * q[1].x) + v * ((1 - u) * q[3].x + u * q[2].x);
        const y = (1 - v) * ((1 - u) * q[0].y + u * q[1].y) + v * ((1 - u) * q[3].y + u * q[2].y);
        inside.push(sample(x, y));
      }
    }
    const d = 0.12 * c.f.wid;
    for (let k = 0; k < 3; k++) {
      // left, right, top bands (the bottom band is the floor, which is nearer by nature)
      const p = q[[3, 1, 0][k]];
      const r = q[[0, 2, 1][k]];
      const len = Math.hypot(r.x - p.x, r.y - p.y) || 1;
      const nx = (-(r.y - p.y) / len) * (k === 0 ? -1 : 1);
      const ny = ((r.x - p.x) / len) * (k === 0 ? -1 : 1);
      for (let i = 1; i < 8; i++) {
        const t = i / 8;
        ring.push(sample(p.x + (r.x - p.x) * t - nx * d, p.y + (r.y - p.y) * t - ny * d));
      }
    }
    const di = med(inside);
    const dr = med(ring);
    // +: the opening is at least as far as its surround (recess or flush); -: it is nearer (not an opening).
    c.f.depthRecess = Number.isFinite(di) && Number.isFinite(dr) && dr > 0 ? Math.max(-1, Math.min(0.2, (di - dr) / dr)) * 5 : 0;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* 7. Full-resolution side refinement                                                                 */
/* ------------------------------------------------------------------------------------------------ */

function rgbAt(image, x, y, out) {
  const { data, width: W, height: H } = image;
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > W - 1.001) fx = W - 1.001;
  if (fy < 0) fy = 0;
  else if (fy > H - 1.001) fy = H - 1.001;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const ax = fx - x0;
  const ay = fy - y0;
  const i = (y0 * W + x0) * 4;
  const j = i + W * 4;
  for (let c = 0; c < 3; c++) {
    const top = data[i + c] + (data[i + 4 + c] - data[i + c]) * ax;
    const bot = data[j + c] + (data[j + 4 + c] - data[j + c]) * ax;
    out[c] = top + (bot - top) * ay;
  }
}

/** Fit a line (point + unit direction) to points with iterative outlier rejection. */
function robustLine(pts) {
  let use = pts;
  let line = null;
  for (let it = 0; it < 3; it++) {
    if (use.length < 6) return null;
    let mx = 0;
    let my = 0;
    for (const p of use) {
      mx += p.x;
      my += p.y;
    }
    mx /= use.length;
    my /= use.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const p of use) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    line = { x: mx, y: my, dx, dy };
    const res = pts.map((p) => Math.abs(-(p.x - mx) * dy + (p.y - my) * dx));
    const sorted = res.slice().sort((a, b) => a - b);
    const mad = sorted[sorted.length >> 1];
    const lim = Math.max(1.2, 2.5 * 1.4826 * mad);
    use = pts.filter((p, i) => res[i] <= lim);
    line.inliers = use.length / pts.length;
    let ss = 0;
    for (const p of use) {
      const r = -(p.x - mx) * dy + (p.y - my) * dx;
      ss += r * r;
    }
    line.rms = Math.sqrt(ss / Math.max(1, use.length));
  }
  return line;
}

function intersect(l1, l2) {
  const den = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.x - l1.x) * l2.dy - (l2.y - l1.y) * l2.dx) / den;
  return { x: l1.x + l1.dx * t, y: l1.y + l1.dy * t };
}

// For each side: the colour step direction (inside minus outside colour, from the analysis image) gives a
// matched 1-D filter; along N normals the strongest outside->inside step within +-r px is located with
// sub-pixel precision, and a robust line is fitted. Sides that cannot be refined keep the coarse line.
/** Mean colours of bands just inside / outside side k of a full-resolution quad. */
function sideBandsFull(image, quad, k, d) {
  const p = quad[k];
  const q = quad[(k + 1) % 4];
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const nx = -(q.y - p.y) / len;
  const ny = (q.x - p.x) / len;
  const inC = [0, 0, 0];
  const outC = [0, 0, 0];
  const rgb = [0, 0, 0];
  const N = 16;
  for (let i = 0; i < N; i++) {
    const t = 0.15 + (0.7 * (i + 0.5)) / N;
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    for (let j = 1; j <= 3; j++) {
      const dd = (d * j) / 2;
      rgbAt(image, x + nx * dd, y + ny * dd, rgb);
      for (let c = 0; c < 3; c++) inC[c] += rgb[c];
      rgbAt(image, x - nx * dd, y - ny * dd, rgb);
      for (let c = 0; c < 3; c++) outC[c] += rgb[c];
    }
  }
  for (let c = 0; c < 3; c++) {
    inC[c] /= 3 * N;
    outC[c] /= 3 * N;
  }
  return { inC, outC };
}

/**
 * Snap a rough opening quad onto the nearest matching edges (sub-pixel), side by side. Use it as a magnet
 * after the customer drags handles, or after a capture guide. Each side moves at most radiusPx; a side whose
 * edge cannot be found keeps its position.
 * @param {Image} image
 * @param {Point[]} quad [TL, TR, BR, BL], full-res px
 * @param {{ radiusPx?: number }} [opts] search radius (default 1.5% of the image diagonal, at least 4 px)
 * @returns {{ ok: boolean, quad: Point[] }}
 */
export function snapQuad(image, quad, opts = {}) {
  if (!image || !image.data || !validQuad(quad)) return { ok: false, quad };
  const r = opts.radiusPx > 0 ? opts.radiusPx : Math.max(4, 0.015 * Math.hypot(image.width, image.height));
  const out = refineSides(image, quad, r);
  return out ? { ok: true, quad: out } : { ok: false, quad: quad.map((p) => ({ x: p.x, y: p.y })) };
}

const INNER_EDGE_FRAC = 0.6;

function refineSides(image, quad, r) {
  const STEP = 0.5;
  const nS = Math.round((2 * r) / STEP) + 1;
  const prof = new Float32Array(nS + 2);
  const dv = new Float32Array(nS + 2);
  const rgb = [0, 0, 0];
  const wid = 0.5 * (quad[1].x - quad[0].x + quad[2].x - quad[3].x);
  const lines = [];
  let any = false;
  for (let k = 0; k < 4; k++) {
    const p = quad[k];
    const q = quad[(k + 1) % 4];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const dx = (q.x - p.x) / len;
    const dy = (q.y - p.y) / len;
    const nx = -dy;
    const ny = dx;
    const coarse = { x: p.x, y: p.y, dx, dy };
    const { inC, outC } = sideBandsFull(image, quad, k, Math.max(2, Math.min(0.04 * wid, 0.6 * r)));
    let ex = inC[0] - outC[0];
    let ey = inC[1] - outC[1];
    let ez = inC[2] - outC[2];
    const en = Math.hypot(ex, ey, ez);
    if (en < 10) {
      lines.push(coarse);
      continue;
    }
    ex /= en;
    ey /= en;
    ez /= en;
    const pts = [];
    const N = 40;
    for (let i = 0; i < N; i++) {
      const t = 0.08 + (0.84 * (i + 0.5)) / N;
      const bx = p.x + (q.x - p.x) * t;
      const by = p.y + (q.y - p.y) * t;
      for (let j = 0; j < nS; j++) {
        const s = -r + j * STEP;
        rgbAt(image, bx + nx * s, by + ny * s, rgb);
        prof[j] = rgb[0] * ex + rgb[1] * ey + rgb[2] * ez;
      }
      // derivative over +-1 px (2 samples) - a light smoothing derivative filter
      let bestJ = -1;
      let bestV = 0;
      for (let j = 2; j < nS - 2; j++) {
        const v = (dv[j] = prof[j + 2] + prof[j + 1] - prof[j - 1] - prof[j - 2]);
        if (v > bestV) {
          bestV = v;
          bestJ = j;
        }
      }
      if (bestJ < 0 || bestV < 0.25 * en) continue;
      // The opening is the INNERMOST boundary: take the first strong step met coming from inside (a shadow
      // gap or a frame bead just outside the leaf edge must not pull the side outwards).
      for (let j = nS - 4; j > bestJ; j--) {
        if (dv[j] >= INNER_EDGE_FRAC * bestV && dv[j] >= dv[j - 1] && dv[j] >= dv[j + 1]) {
          bestJ = j;
          bestV = dv[j];
          break;
        }
      }
      const vm = prof[bestJ + 1] + prof[bestJ] - prof[bestJ - 2] - prof[bestJ - 3];
      const vp = prof[bestJ + 3] + prof[bestJ + 2] - prof[bestJ] - prof[bestJ - 1];
      const den = vm - 2 * bestV + vp;
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (vm - vp)) / den)) : 0;
      const s = -r + (bestJ + off) * STEP;
      pts.push({ x: bx + nx * s, y: by + ny * s });
    }
    const fit = pts.length >= 0.5 * N ? robustLine(pts) : null;
    if (!fit || fit.inliers < 0.6 || fit.rms > 1.5 || Math.abs(fit.dx * dx + fit.dy * dy) < Math.cos(3 * DEG)) {
      lines.push(coarse);
      continue;
    }
    if (fit.dx * dx + fit.dy * dy < 0) {
      fit.dx = -fit.dx;
      fit.dy = -fit.dy;
    }
    lines.push(fit);
    any = true;
  }
  if (!any) return null;
  const outQ = [];
  for (let k = 0; k < 4; k++) {
    const c = intersect(lines[(k + 3) % 4], lines[k]);
    if (!c || Math.hypot(c.x - quad[k].x, c.y - quad[k].y) > 2 * r) return null;
    outQ.push(c);
  }
  return outQ;
}

/* ------------------------------------------------------------------------------------------------ */
/* 8. Confidence                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

function confidenceOf(best, margin) {
  const m = CONFIDENCE_MODEL;
  const f = best.f;
  const sig = (v) => 1 / (1 + Math.exp(-v));
  const maxCtx = Math.max(f.ctxPanel || 0, f.ctxStep || 0, f.ctxTransom || 0);
  const c = sig(8 * (margin - m.margin)) * sig(12 * (f.kMin - m.kMin)) * sig(12 * (m.maxCtx - maxCtx)) * sig(3 * (best.score - m.score));
  return Math.max(0, Math.min(1, c));
}
