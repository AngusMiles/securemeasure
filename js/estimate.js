// The no-paper estimate: a door opening's shape from ONE photo, snapped to the company's standard sizes.
//
// Pure module: no DOM, no globals, safe to import under Node. Everything is closed form: microseconds per
// photo and nothing to download. Ported from the Nov 2026 research baseline (bench-baseline/reference.mjs);
// the gravity / camera-height methods it also explored are left out because they are not shipped.
//
// WHAT ONE PHOTO CAN AND CANNOT GIVE (4 corners of the opening + the camera's focal length):
//   - The opening's height / width RATIO is recoverable exactly in the noise-free case: metric rectification
//     of a rectangle with known intrinsics. With the customer's corners (about 3 px tap error at 2048 px)
//     it is good to ~0.6 % median / 1.6 % p90 in simulation, ~1.4 % / 2.8 % on real photos.
//   - The absolute SIZE is not recoverable: a door twice the size seen from twice as far gives the same
//     photo. AI single-photo depth was benchmarked for that and failed (4-58 % too big on real photos).
//   - So the ratio is matched against the catalogue of standard sizes the company sells: the exact size is
//     picked ~77 % of the time and is in the top two ~98 % of the time (AU catalogue, 3 px taps). A miss is
//     mostly the 2340-high doors, whose ratios sit 0.7 % from another size, or 2040 vs 2100 high.
//   - The answer is therefore always "nearest standard size, confirmed by a check measure". Never show raw
//     millimetres from a photo with no scale, and never claim +-20 mm.
//
// CONVENTIONS
//   Image:   pixels, x right, y down, origin at the top-left CORNER of the top-left pixel (canvas convention,
//            the same as js/vision.js and the corner editor).
//   Camera:  x right, y down, z forward (out of the back of the phone). K = [[f,0,cx],[0,f,cy],[0,0,1]].
//   Corners: [TL, TR, BR, BL] of the door OPENING (inside the frame, head to sill), each { x, y }.
//   Plane:   door-plane millimetres, X right, Y down, origin at the opening's top-left; rectangle (0,0)-(W,H).
//   Aspect:  height over width (H/W).

import { orderDoorQuad } from './geometry.js';

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ f: number, cx: number, cy: number }} Intrinsics */
/** @typedef {{ widthMm: number, heightMm: number }} StandardSize */
/** @typedef {{ widthMm: number, heightMm: number, p: number, zAspect: number }} Candidate */

const RAD = Math.PI / 180;

/**
 * The standard door OPENING sizes used when the company's config has none (Australian range, mm).
 * The same list is the default of `config.measurement.standardSizes`.
 * @type {ReadonlyArray<Readonly<StandardSize>>}
 */
export const DEFAULT_STANDARD_SIZES = Object.freeze(
  [
    [720, 2040], [770, 2040], [820, 2040], [870, 2040], [920, 2040],
    [820, 2100], [870, 2100], [920, 2100],
    [820, 2340], [920, 2340],
  ].map(([widthMm, heightMm]) => Object.freeze({ widthMm, heightMm })),
);

/**
 * Numbers behind estimateFromCorners. They come from the research benchmark; change them only with new
 * evidence (they set what the customer is told).
 */
export const ESTIMATE_THRESHOLDS = Object.freeze({
  /** 1-sigma corner tap error, px, for a 2048 px photo (scaled with the photo's long side). */
  tapSigmaPxAt2048: 3,
  /** 1-sigma of ln(focal) with an EXIF focal length: makers round it and define it slightly differently. */
  focalSigmaLnExif: 0.02,
  /**
   * 1-sigma of ln(focal) with the 26 mm phone prior (see PHONE_FOCAL_SIGMA_LN), and with a picked file's
   * EXIF figure, which may describe a bigger picture than the one decoded (see photoFocal).
   */
  focalSigmaLnPrior: 0.08,
  /**
   * Floor added in quadrature to the propagated aspect sigma: which edge the customer took for the opening,
   * leaf versus opening differences, a frame that is not quite square. Without it a crisp photo would claim
   * more certainty than any real door allows.
   */
  sigmaFloorLn: 0.01,
  /** 'not_rectangular': the two recovered side directions are further than this from perpendicular, deg. */
  maxOrthogonalityDeg: 2,
  /**
   * 'steep_angle' with the 26 mm prior on a photo from the live camera ('prior'): the focal lengths the
   * lens may really have, as a factor either way of the assumed one. The live camera is the 1x main lens
   * (24-28 mm) with some of the frame taken off by video stabilisation (~10 %), so the real focal is about
   * 0.9-1.25x the prior. If the best size is not the same over the whole range the lens guess decides the
   * answer, and the estimate is never `confident` (see estimateFromCorners). This replaces an 18 deg limit
   * on the angle measured with the guessed focal, which reads about half the real angle when the guess is
   * half the real focal, and flagged a door square to the phone but off to one side of the photo.
   */
  lensRangePrior: 1.25,
  /**
   * The same for a picked file ('prior_file', 'exif_file'), on top of lensRangePrior: a camera-app photo may
   * be on the 0.5x or 2x lens and a gallery crop makes the real focal up to 2x the one assumed. Without EXIF
   * ('prior_file') that is half to twice; with it ('exif_file') the figure names the lens, and a crop can
   * only lengthen the focal, so 1x to 2x. Only lenses that put the camera at a height a customer holds a
   * phone at count (fileCameraHeightMm); what they are asked: estimateFromCorners.
   */
  lensRangeFile: 2,
  /**
   * Where a picked file's camera may have been, mm above the sill, for a lens in lensRangeFile to count: a
   * phone held to photograph a door, from crouching to a tall adult's eye level. A lens that would put the
   * camera above or below this is not the lens the photo was taken with. This is what keeps the ordinary
   * downward tilt from counting: aimed at the door's middle from 2.6 m at 1.4 m, the same photo on twice
   * the focal would have been taken from 5 m with the camera about 2.5 m up.
   */
  fileCameraHeightMm: Object.freeze([400, 1800]),
  /**
   * A lens in lensRangeFile that turns the view at least this far sideways (door normal against the optical
   * axis, left-right, deg) also takes away a sure answer when the best size stops being a sure match (p <
   * confidentP) there, not only when the size changes. Turned sideways, nothing in the photo limits where
   * the camera stood, as the camera's height does for the downward tilt (see estimateFromCorners).
   */
  fileSideOnDeg: 10,
  /** 'non_standard': the best catalogue size is more than this many sigmas away in ln(aspect). */
  nonStandardZ: 3,
  /** 'door_near_edge': a corner closer to the image border than this fraction of the image size. */
  edgeMarginFrac: 0.01,
  /** 'door_small': opening height in px below this fraction of the image height. */
  doorMinHeightFrac: 0.3,
  /**
   * `confident` needs the best size's posterior probability at or above this (and a standard ratio, and
   * none of NOT_CONFIDENT_ISSUES).
   */
  confidentP: 0.8,
  /** Candidates returned with an estimate, best first. */
  maxCandidates: 4,
});

/**
 * Issues that rule out `confident` however high the best size's p. p only says how well the recovered
 * ratio matches a size, not whether the ratio is right, and each of these can leave the ratio wrong while
 * it still matches some size well: a corner that is off, a lens guess that matters at this angle, an
 * opening cut off by the photo's edge. Why each one, with examples: estimateFromCorners.
 */
const NOT_CONFIDENT_ISSUES = Object.freeze(['not_rectangular', 'steep_angle', 'door_near_edge']);

/**
 * Where an estimate's focal length came from (photoFocal): the camera's own EXIF for this frame ('exif'),
 * the 26 mm prior on a photo from the live camera ('prior'), or, for a picked file, its EXIF figure
 * ('exif_file') or the prior ('prior_file'). A file's lens and crop are unknown, so neither is trusted.
 */
const FOCAL_SOURCES = Object.freeze(['exif', 'prior', 'exif_file', 'prior_file']);

/** Focal lengths tried each side of the assumed one by lensEffect, evenly spaced in ln(focal). */
const LENS_STEPS = 4;

// nearestStandard (after an AR measurement): AR scale and aim errors are about +-3 % (1 sigma) on both the
// ratio and the overall size, so both enter the match with that sigma.
const AR_SIGMA_LN_ASPECT = 0.03;
const AR_SIGMA_LN_SCALE = 0.03;
const AR_MAX_CANDIDATES = 3;

// Anything outside this is a typo in the config, not a door.
const MAX_SIZE_MM = 10000;

// ---------------------------------------------------------------------------------------------------------
// Small vector helpers (3-vectors as arrays)
// ---------------------------------------------------------------------------------------------------------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / len(a));

/** @param {unknown} value */
function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** @param {unknown} p */
function isFinitePoint(p) {
  return !!p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** @param {unknown} q */
function isFourPoints(q) {
  return Array.isArray(q) && q.length === 4 && q.every(isFinitePoint);
}

// ---------------------------------------------------------------------------------------------------------
// Intrinsics
// ---------------------------------------------------------------------------------------------------------

/** Diagonal of a 36 x 24 mm full frame (43.27 mm), the basis of EXIF FocalLengthIn35mmFilm. */
export const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);

/**
 * Prior focal length for an unknown phone main camera at 1x: 26 mm-equivalent (iPhone 6..16 wide camera
 * 26 mm, recent Pro models 24 mm; most Android main cameras 23-27 mm). Treat as +-8 % (1 sigma).
 */
export const PHONE_DEFAULT_F35 = 26;
export const PHONE_FOCAL_SIGMA_LN = 0.08;

/**
 * Focal length in pixels from a 35 mm-equivalent focal length, for an image that is the camera's FULL frame
 * (possibly downscaled, NOT cropped). Uses the diagonal definition; some makers define the equivalent on the
 * width, which differs by up to ~4 % for 4:3 sensors (well inside the EXIF focal sigma above).
 *
 * @param {number} focal35mm
 * @param {number} width   image width, px (after EXIF rotation and any downscale)
 * @param {number} height  image height, px
 * @returns {number} NaN when any input is not a positive number
 */
export function focalPxFrom35mm(focal35mm, width, height) {
  if (!isPositive(focal35mm) || !isPositive(width) || !isPositive(height)) return NaN;
  return (focal35mm / FULL_FRAME_DIAGONAL_MM) * Math.hypot(width, height);
}

/**
 * Long side over short side of a camera's whole frame: 4:3 (every phone main camera) and 3:2 (most
 * interchangeable-lens cameras). 16:9 and 1:1 are left out on purpose: phones make those by cropping the
 * 4:3 sensor, and some still write the 4:3 frame's 35 mm figure (8-15 % out on the diagonal).
 */
const FULL_FRAME_ASPECTS = [4 / 3, 3 / 2];
/** How far (relative) an image's long/short ratio may be from FULL_FRAME_ASPECTS and still count. */
const FULL_FRAME_ASPECT_TOLERANCE = 0.02;

/**
 * Whether an image has the shape of a camera's whole frame (4:3 or 3:2, either way up, within 2 %), the
 * only images an EXIF 35 mm-equivalent focal length can be trusted for. A photo cropped in a gallery app
 * usually keeps the camera's EXIF, so its FocalLengthIn35mmFilm describes a bigger picture than the one
 * decoded: turned into pixels on the crop's own diagonal it gives a focal far too short (a 1600 x 3000 crop
 * of a 3024 x 4032 frame: x0.67), with nothing in the corners to show it.
 *
 * @param {number} width   px
 * @param {number} height  px
 * @returns {boolean}
 */
export function isFullFrameAspect(width, height) {
  if (!isPositive(width) || !isPositive(height)) return false;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return FULL_FRAME_ASPECTS.some((aspect) => Math.abs(ratio / aspect - 1) <= FULL_FRAME_ASPECT_TOLERANCE);
}

/**
 * The focal length to use for a loaded photo: its EXIF 35 mm-equivalent when it has a believable one and
 * the photo has a whole frame's shape (isFullFrameAspect), otherwise the phone prior. Live video frames and
 * iOS `<input capture>` photos carry no EXIF, so they always get the prior; so does a cropped, 16:9 or
 * square photo, whose EXIF figure may not describe it. The prior's wider sigma and the 'steep_angle' issue
 * then say how much the lens guess matters; near-frontal photos barely depend on it (estimateFromCorners).
 *
 * A picked file (`photo.capture === 'file'`) gets '_file' on its source, and its EXIF figure is only a best
 * guess: a gallery crop that keeps the photo's 4:3 shape (the 'Original' aspect in iOS Photos and Google
 * Photos) keeps its EXIF and passes every shape check, yet its real focal is 1/crop of the figure. A file
 * from the camera app may also be on any of the phone's lenses (0.5x, 2x...), which iOS does not say. So
 * a file never gets the EXIF sigma, and estimateFromCorners asks whether a lens from half to twice the
 * assumed one (with EXIF, which names the lens, a crop: 1x to 2x) would change the answer, among those
 * that put the camera where a customer holds a phone. Our own captures ('live', 'frame') and the demo are
 * whole frames from a known camera; so, for compatibility, is a photo object without `capture`.
 *
 * @param {{ width: number, height: number, focal35mm?: number|null, capture?: string }} photo  a photo
 *        from loadPhoto
 * @returns {{ focalPx: number, source: 'exif' | 'prior' | 'exif_file' | 'prior_file' }}  focalPx is NaN
 *          when the photo has no usable size
 */
export function photoFocal(photo) {
  const f35 = photo ? photo.focal35mm : null;
  const width = photo ? photo.width : NaN;
  const height = photo ? photo.height : NaN;
  // 10..200 mm covers every phone lens from ultra-wide to the longest periscope; anything else is a broken tag.
  const exif = typeof f35 === 'number' && Number.isFinite(f35) && f35 >= 10 && f35 <= 200 && isFullFrameAspect(width, height);
  const file = Boolean(photo) && photo.capture === 'file';
  return {
    focalPx: focalPxFrom35mm(exif ? f35 : PHONE_DEFAULT_F35, width, height),
    source: `${exif ? 'exif' : 'prior'}${file ? '_file' : ''}`,
  };
}

/**
 * Pinhole intrinsics, principal point at the image centre by default.
 *
 * @param {number} focalPx
 * @param {number} width
 * @param {number} height
 * @param {Point} [principal]
 * @returns {Intrinsics}
 */
export function intrinsics(focalPx, width, height, principal) {
  return { f: focalPx, cx: principal ? principal.x : width / 2, cy: principal ? principal.y : height / 2 };
}

// ---------------------------------------------------------------------------------------------------------
// Homography of the unit square onto the tapped quad
// ---------------------------------------------------------------------------------------------------------

/**
 * Row-major 3x3 homography H (H[8] = 1) mapping the unit square (0,0),(1,0),(1,1),(0,1) onto corners
 * [TL, TR, BR, BL]. Closed form (Heckbert 1989). Entries are not finite for a degenerate quad.
 *
 * @param {Point[]} corners
 * @returns {number[]}
 */
export function squareToQuad(corners) {
  const [p0, p1, p2, p3] = corners;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0;
  let h = 0;
  if (dx3 !== 0 || dy3 !== 0) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

/**
 * Apply a row-major homography to (x, y).
 *
 * @param {number[]} H
 * @param {number} x
 * @param {number} y
 * @returns {Point}
 */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

/**
 * Row-major homography mapping door-plane millimetres (0..W, 0..H) onto the quad: (0,0) -> corners[0],
 * (W,0) -> corners[1], (W,H) -> corners[2], (0,H) -> corners[3]. Used for the flattened preview of the
 * chosen standard size (the photo itself says nothing about the size, so W and H are the candidate's).
 *
 * @param {Point[]} corners  [TL, TR, BR, BL], image px
 * @param {number} widthMm
 * @param {number} heightMm
 * @returns {number[]|null}  null when the corners or the size are unusable
 */
export function planeToImageFor(corners, widthMm, heightMm) {
  if (!isFourPoints(corners) || !isPositive(widthMm) || !isPositive(heightMm)) return null;
  const S = squareToQuad(corners);
  // H = S * diag(1/W, 1/H, 1): the first column takes X / W, the second Y / H.
  const H = [
    S[0] / widthMm, S[1] / heightMm, S[2],
    S[3] / widthMm, S[4] / heightMm, S[5],
    S[6] / widthMm, S[7] / heightMm, S[8],
  ];
  return H.every(Number.isFinite) ? H : null;
}

// ---------------------------------------------------------------------------------------------------------
// Metric rectification of a rectangle with known intrinsics -> aspect ratio + pose up to scale
// ---------------------------------------------------------------------------------------------------------

/**
 * Closed-form rectification. K^-1 H ~ [W r1, H r2, t], so W/H = |K^-1 h1| / |K^-1 h2|.
 * The two recovered side directions are only orthogonal for consistent data; the angle error is a free
 * self-consistency check (bad focal, bad corners, or an opening that is not a rectangle in 3D).
 *
 * @param {Point[]} corners  [TL, TR, BR, BL], image px
 * @param {Intrinsics} K
 * @returns {{aspectHW:number, orthogonalityErrDeg:number, r1:number[], r2:number[], r3:number[], t:number[],
 *            widthOverHeight:number, viewTiltDeg:number, H:number[]}}
 *   r1 = door "right" axis, r2 = door "down" axis, r3 = plane normal (into the house), all in the camera frame;
 *   t = camera-frame position of the TL corner for a rectangle scaled to HEIGHT 1 (multiply by the height in
 *   mm); viewTiltDeg = angle between the plane normal and the line of sight to the opening's centre, for
 *   information only: it depends on K.f, and a door square to the phone but off to one side of the photo
 *   reads as tilted although its ratio does not depend on the lens at all (estimateFromCorners asks the
 *   lens question directly instead).
 */
export function rectifyRectangle(corners, K) {
  const H = squareToQuad(corners);
  const kinv = (v) => [(v[0] - K.cx * v[2]) / K.f, (v[1] - K.cy * v[2]) / K.f, v[2]];
  const m1 = kinv([H[0], H[3], H[6]]);
  const m2 = kinv([H[1], H[4], H[7]]);
  const m3 = kinv([H[2], H[5], H[8]]);
  const l1 = len(m1);
  const l2 = len(m2);
  const a = mul(m1, 1 / l1);
  const b = mul(m2, 1 / l2);
  const cosAB = Math.max(-1, Math.min(1, dot(a, b)));
  // Closest orthonormal pair, symmetric in the two axes.
  const c = unit(add(a, b));
  const d = unit(sub(a, b));
  const r1 = mul(add(c, d), Math.SQRT1_2);
  const r2 = mul(sub(c, d), Math.SQRT1_2);
  const r3 = cross(r1, r2);
  const widthOverHeight = l1 / l2;
  const t = mul(m3, 1 / l2);
  const centre = add(t, add(mul(r1, widthOverHeight / 2), mul(r2, 0.5)));
  const viewTiltDeg = Math.acos(Math.min(1, Math.abs(dot(r3, unit(centre))))) / RAD;
  return {
    aspectHW: l2 / l1,
    widthOverHeight,
    orthogonalityErrDeg: Math.abs(90 - Math.acos(cosAB) / RAD),
    r1,
    r2,
    r3,
    t,
    viewTiltDeg,
    H,
  };
}

/**
 * 1-sigma uncertainty of ln(aspect) from isotropic corner noise sigmaPx (first-order propagation, central
 * differences) plus, optionally, a focal uncertainty sigma (ln f). Cheap enough to run on every tap.
 * The focal term is what makes an oblique photo with an assumed lens honest: near-frontal, the aspect barely
 * depends on f; 30 degrees off-axis with a 2x lens taken for 1x it is 10 % out.
 *
 * @param {Point[]} corners
 * @param {Intrinsics} K
 * @param {number} sigmaPx
 * @param {number} [focalSigmaLn=0]
 * @returns {number}
 */
export function aspectSigmaLn(corners, K, sigmaPx, focalSigmaLn = 0) {
  let v = 0;
  const h = 0.25;
  for (let i = 0; i < 4; i++) {
    for (const axis of ['x', 'y']) {
      const cp = corners.map((c) => ({ x: c.x, y: c.y }));
      const cm = corners.map((c) => ({ x: c.x, y: c.y }));
      cp[i][axis] += h;
      cm[i][axis] -= h;
      const g = (Math.log(rectifyRectangle(cp, K).aspectHW) - Math.log(rectifyRectangle(cm, K).aspectHW)) / (2 * h);
      v += (g * sigmaPx) ** 2;
    }
  }
  if (focalSigmaLn > 0) {
    const s = Math.exp(focalSigmaLn);
    const up = Math.log(rectifyRectangle(corners, { ...K, f: K.f * s }).aspectHW);
    const dn = Math.log(rectifyRectangle(corners, { ...K, f: K.f / s }).aspectHW);
    v += ((up - dn) / 2) ** 2;
  }
  return Math.sqrt(v);
}

// ---------------------------------------------------------------------------------------------------------
// Standard-size catalogue and classifier
// ---------------------------------------------------------------------------------------------------------

/**
 * Width and height of a size given as { widthMm, heightMm } (the app's shape) or { w, h } (the research
 * shape), or null when it is not a usable size.
 * @param {unknown} s
 * @returns {{ w: number, h: number } | null}
 */
function sizeDims(s) {
  if (!s || typeof s !== 'object') return null;
  const w = s.widthMm !== undefined ? s.widthMm : s.w;
  const h = s.heightMm !== undefined ? s.heightMm : s.h;
  return isPositive(w) && isPositive(h) && w <= MAX_SIZE_MM && h <= MAX_SIZE_MM ? { w, h } : null;
}

/**
 * The usable, distinct sizes of a list as fresh { widthMm, heightMm } objects, in the list's order;
 * null when there are none (so callers can fall back to the defaults).
 * @param {unknown} list
 * @returns {StandardSize[] | null}
 */
function cleanSizes(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const d = sizeDims(entry);
    if (!d) continue;
    const key = `${d.w}x${d.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ widthMm: d.w, heightMm: d.h });
  }
  return out.length ? out : null;
}

/**
 * The company's standard sizes from the merged config (`measurement.standardSizes`), with malformed or
 * repeated entries dropped; DEFAULT_STANDARD_SIZES when the config has none that are usable.
 *
 * @param {object} config  merged app config
 * @returns {StandardSize[]}  fresh objects, safe to keep or change
 */
export function standardSizesFrom(config) {
  const list = config && config.measurement ? config.measurement.standardSizes : undefined;
  return cleanSizes(list) || DEFAULT_STANDARD_SIZES.map((s) => ({ widthMm: s.widthMm, heightMm: s.heightMm }));
}

/**
 * Rank standard sizes given the rectified aspect ratio and, optionally, a rough metric size estimate.
 * Gaussian likelihood in (ln aspect, ln scale) where scale = sqrt(W * H): a metric estimate (AR, or any
 * other scale cue) scales W and H together, so its error lies along the scale axis only.
 *
 * Posterior ∝ exp(-(zA² + zS²) / 2) · prior, normalised over the sizes given; best first (ties keep the
 * catalogue order).
 *
 * @param {object} o
 * @param {number} o.aspectHW            rectified H/W
 * @param {number} o.sigmaLnAspect       1-sigma of ln(aspect) (see aspectSigmaLn; add a floor ~0.01)
 * @param {{w:number,h:number}|{widthMm:number,heightMm:number}} [o.estimateMm]  rough metric size (only
 *        sqrt(W*H) is used); ignored without a positive sigmaLnScale
 * @param {number} [o.sigmaLnScale]      1-sigma of ln(scale); sigmaLnScaleFromP90(N) for an estimate whose
 *        |error| <= N % 90 % of the time
 * @param {Array<{widthMm:number,heightMm:number}|{w:number,h:number}>} [o.sizes]  default DEFAULT_STANDARD_SIZES;
 *        unusable entries are skipped
 * @param {number[]} [o.priors]          optional prior weight per size (e.g. a sales mix); uniform by default;
 *        a size with a weight that is not positive is left out
 * @returns {Array<object>} each size as given (its own fields) plus { p, zAspect, zScale }, best first;
 *          [] when the aspect or its sigma is not a positive number
 */
export function classifyStandard({
  aspectHW,
  sigmaLnAspect,
  estimateMm = null,
  sigmaLnScale = null,
  sizes = DEFAULT_STANDARD_SIZES,
  priors = null,
} = {}) {
  if (!isPositive(aspectHW) || !isPositive(sigmaLnAspect) || !Array.isArray(sizes)) return [];
  const est = estimateMm ? sizeDims(estimateMm) : null;
  const useScale = Boolean(est) && isPositive(sigmaLnScale);
  const la = Math.log(aspectHW);
  const ls = useScale ? 0.5 * Math.log(est.w * est.h) : null;
  const scored = [];
  sizes.forEach((s, i) => {
    const d = sizeDims(s);
    if (!d) return;
    const weight = priors ? priors[i] : 1;
    if (!isPositive(weight)) return;
    const zA = (la - Math.log(d.h / d.w)) / sigmaLnAspect;
    const zS = useScale ? (ls - 0.5 * Math.log(d.w * d.h)) / sigmaLnScale : null;
    const logL = -0.5 * (zA * zA + (zS === null ? 0 : zS * zS)) + Math.log(weight);
    scored.push({ ...s, logL, zAspect: zA, zScale: zS });
  });
  if (!scored.length) return [];
  const mx = Math.max(...scored.map((s) => s.logL));
  const tot = scored.reduce((acc, s) => acc + Math.exp(s.logL - mx), 0);
  return scored.map(({ logL, ...s }) => ({ ...s, p: Math.exp(logL - mx) / tot })).sort((a, b) => b.p - a.p);
}

/**
 * 1-sigma of ln(scale) for an estimator whose absolute relative error is <= N % in 90 % of cases
 * (Gaussian in ln).
 * @param {number} nPercent
 * @returns {number}
 */
export function sigmaLnScaleFromP90(nPercent) {
  return Math.log(1 + nPercent / 100) / 1.6449;
}

/** The app's candidate shape (drops the research fields). */
const toCandidate = (c) => ({ widthMm: c.widthMm, heightMm: c.heightMm, p: c.p, zAspect: c.zAspect });

// ---------------------------------------------------------------------------------------------------------
// The app's entry points
// ---------------------------------------------------------------------------------------------------------

/**
 * 'convex' | 'not_convex' | 'degenerate' for a quad in drawing order (same rules as js/geometry.js uses for
 * the paper measurement, so both paths reject the same shapes).
 * @param {Point[]} q
 */
function quadShape(q) {
  let perimeter = 0;
  for (let i = 0; i < 4; i++) perimeter += Math.hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y);
  if (!(perimeter > 0) || !Number.isFinite(perimeter)) return 'degenerate';
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const e1x = b.x - a.x;
    const e1y = b.y - a.y;
    const e2x = c.x - b.x;
    const e2y = c.y - b.y;
    const l1 = Math.hypot(e1x, e1y);
    const l2 = Math.hypot(e2x, e2y);
    if (!(l1 > 1e-9 * perimeter) || !(l2 > 1e-9 * perimeter)) return 'degenerate';
    const sine = (e1x * e2y - e1y * e2x) / (l1 * l2);
    if (!(Math.abs(sine) > 1e-6)) return 'degenerate';
    if (sine > 0) positive++;
    else negative++;
  }
  return positive === 4 || negative === 4 ? 'convex' : 'not_convex';
}

/**
 * The camera's height above the sill, in opening heights, for a rectification (rectifyRectangle): t is the
 * head's top-left corner seen from the camera at height 1 and r2 points down the opening, so the camera
 * sits -t.r2 below the head.
 * @param {{ t: number[], r2: number[] }} rect
 * @returns {number}
 */
function cameraHeightAboveSill(rect) {
  return 1 + dot(rect.t, rect.r2);
}

/**
 * How far the door's normal is turned left or right of the optical axis, deg (0 for a door faced square on,
 * whatever the downward tilt).
 * @param {{ r3: number[] }} rect
 * @returns {number}
 */
function sideTiltDeg(rect) {
  return Math.atan2(Math.abs(rect.r3[0]), Math.abs(rect.r3[2])) / RAD;
}

/**
 * What the lens does to the answer over the focal lengths from K.f / range to K.f * range (LENS_STEPS each
 * side, even in ln f). `decides`: with one of them the nearest catalogue size is not `best`. `shiftLn`: the
 * furthest ln(aspect) gets from its value at K.f. Asked of the ratio itself rather than of an angle
 * measured with the guessed focal, which reads too small exactly when the guess is too short. A door square
 * to the phone gives the same ratio with every focal, wherever it sits in the photo, so for it the lens
 * never decides.
 *
 * `file` is for a picked file's wider range (ESTIMATE_THRESHOLDS.lensRangeFile), where a focal only counts
 * when it puts the camera `heightMm` above the sill (with the size found there), and where it also decides
 * when `best`, a sure match at K.f (p >= minP), is no longer one at a focal that sees the door at least
 * `sideOnDeg` from the side. `longerOnly`: only focal lengths above K.f (a crop of a photo whose EXIF names
 * the lens).
 *
 * @param {Point[]} quad   [TL, TR, BR, BL]
 * @param {Intrinsics} K   with the assumed focal
 * @param {number} aspectHW  the ratio at K.f
 * @param {StandardSize[]} sizes
 * @param {number} sigmaLnAspect  the estimate's sigma, kept for every focal tried
 * @param {Candidate} best  the best size at K.f
 * @param {number} range   > 1
 * @param {{ longerOnly: boolean, heightMm: readonly number[], sideOnDeg: number, minP: number } | null} [file]
 * @returns {{ decides: boolean, shiftLn: number }}
 */
function lensEffect(quad, K, aspectHW, sizes, sigmaLnAspect, best, range, file = null) {
  const sure = file !== null && best.p >= file.minP;
  let decides = false;
  let shiftLn = 0;
  for (let i = file && file.longerOnly ? 1 : -LENS_STEPS; i <= LENS_STEPS; i++) {
    if (i === 0) continue;
    const rect = rectifyRectangle(quad, { ...K, f: K.f * range ** (i / LENS_STEPS) });
    const top = classifyStandard({ aspectHW: rect.aspectHW, sigmaLnAspect, sizes })[0];
    if (!top) return { decides: true, shiftLn: Infinity };
    if (file) {
      const heightMm = cameraHeightAboveSill(rect) * top.heightMm;
      if (!(heightMm >= file.heightMm[0] && heightMm <= file.heightMm[1])) continue;
    }
    shiftLn = Math.max(shiftLn, Math.abs(Math.log(rect.aspectHW / aspectHW)));
    if (top.widthMm !== best.widthMm || top.heightMm !== best.heightMm) decides = true;
    else if (sure && top.p < file.minP && sideTiltDeg(rect) >= file.sideOnDeg) decides = true;
  }
  return { decides, shiftLn };
}

/**
 * The no-paper estimate from the four corners the customer confirmed: the opening's ratio, matched to the
 * nearest standard sizes. Never throws.
 *
 * Uncertainty: corner sigma `cornerSigmaPx` when given, else a tap's 3 px at 2048 px (scaled with the
 * photo); focal sigma ln 0.02 ('exif') or 0.08 (any other source); sigma = hypot(aspectSigmaLn(...), 0.01).
 * Issues (any of):
 *   'not_rectangular' the corners do not make a rectangle for this lens (orthogonality > 2 deg): a corner is
 *                     off, or the photo is not the 1x camera
 *   'steep_angle'     the focal is not the camera's own EXIF and the lens guess decides the answer: the photo
 *                     is off square enough that a lens it may really have been taken with would pick another
 *                     size, or (a picked file seen from the side) would not be sure of this one (lensEffect;
 *                     ranges ESTIMATE_THRESHOLDS.lensRangePrior / lensRangeFile). Only where that takes away a
 *                     sure answer or the lens moves the ratio further than the corners' own error does, so a
 *                     near-square photo that is unsure between two sizes is not said to be on an angle
 *   'non_standard'    no catalogue size within 3 sigma of the ratio
 *   'door_near_edge'  a corner within 1 % of the image size of an edge (the opening may be cut off)
 *   'door_small'      the opening is less than 30 % of the image height
 * `confident` needs the best size at p >= 0.8, a standard ratio, and none of 'not_rectangular',
 * 'steep_angle' or 'door_near_edge' (NOT_CONFIDENT_ISSUES). Each can leave the ratio itself wrong while it
 * still matches one size well, and p only says how well it matches:
 *   - 'door_near_edge': a corner on the photo's edge is usually where the customer ran out of photo, not
 *     where the opening ends, so the ratio is off by however much was cut (3 % cut turns 870 x 2100 into a
 *     sure-looking 870 x 2040).
 *   - 'steep_angle': the prior's 8 % sigma covers the ordinary spread of main-camera lenses, not a photo
 *     cropped in a gallery app or taken on a 2x or ultra-wide lens, where the guess is 30 % or more out.
 *     Square-on that barely moves the ratio; off-axis it moves it onto another size (an 870 x 2100 door
 *     photographed 35 deg off to the side, then cropped, reads as 770 x 2040 at p 0.83; an 820 x 2100 door
 *     20 deg off on the 2x lens reads as 770 x 2040 at p 1.00). The angle cannot be judged from the photo
 *     either: measured with a focal that is too short it reads about half the real one. So the question is
 *     asked of the lens directly: would the answer change with the lenses this photo may have been taken
 *     with? A door square to the phone gives the same ratio with every lens, wherever it is in the photo.
 *     With the camera's own EXIF focal the angle only costs precision (tap and 2 % focal error, propagated
 *     through the actual view), which sigma already carries, so a steep 'exif' photo is judged on p as usual.
 *     A picked file is asked about more lenses (half to twice), but only those that put the camera where a
 *     customer holds a phone: the phone tilted down at the door's middle, as nearly every photo is, moves
 *     the ratio a little with the lens too, and on twice the focal the same photo would have been taken
 *     from a camera 2.5 m up. So the ordinary downward tilt alone never makes a square-on picked photo unsure.
 *
 * @param {object} input
 * @param {Point[]} input.corners      the opening's four corners, image px (canvas convention), any order
 *        (put in [TL, TR, BR, BL] by the outline's shape, as orderDoorQuad in js/geometry.js does)
 * @param {number} input.imageWidth    the photo the corners are in, px
 * @param {number} input.imageHeight
 * @param {number} input.focalPx       from photoFocal(photo)
 * @param {'exif'|'prior'|'exif_file'|'prior_file'} [input.focalSource]  from photoFocal(photo).source;
 *        anything else counts as 'prior'. `source` is accepted as an alias, so `{ ...photoFocal(photo) }`
 *        can be spread straight in.
 * @param {StandardSize[]} [input.sizes]  the catalogue (standardSizesFrom(config)); default DEFAULT_STANDARD_SIZES
 * @param {number} [input.cornerSigmaPx]  1-sigma corner error, px, when the caller knows it (the door screen
 *        passes detection's larger error for corners left where detection put them); anything but a positive
 *        number means a tap's, ESTIMATE_THRESHOLDS.tapSigmaPxAt2048 scaled with the photo's long side
 * @returns {{
 *   method: 'estimate', ok: true, corners: Point[], imageWidth: number, imageHeight: number,
 *   aspectHW: number, sigmaLnAspect: number, focalPx: number,
 *   focalSource: 'exif'|'prior'|'exif_file'|'prior_file',
 *   orthogonalityErrDeg: number, viewTiltDeg: number, candidates: Candidate[], nonStandard: boolean,
 *   confident: boolean, issues: string[], widthMm: number, heightMm: number, planeToImage: number[]
 * } | { ok: false, error: 'not_convex' | 'degenerate' }}
 *   corners are the input put in [TL, TR, BR, BL] order; candidates (best first, at most 4) come only from
 *   the catalogue; widthMm / heightMm and planeToImage are candidates[0]'s.
 */
export function estimateFromCorners(input) {
  try {
    return estimate(input);
  } catch {
    return { ok: false, error: 'degenerate' };
  }
}

function estimate(input) {
  const fail = (error) => ({ ok: false, error });
  if (!input || typeof input !== 'object') return fail('degenerate');
  const { corners, imageWidth, imageHeight, focalPx } = input;
  if (!isFourPoints(corners) || !isPositive(imageWidth) || !isPositive(imageHeight) || !isPositive(focalPx)) {
    return fail('degenerate');
  }
  const rawSource = input.focalSource !== undefined ? input.focalSource : input.source;
  const focalSource = FOCAL_SOURCES.includes(rawSource) ? rawSource : 'prior';
  const file = focalSource === 'exif_file' || focalSource === 'prior_file';
  const sizes = cleanSizes(input.sizes) || DEFAULT_STANDARD_SIZES;
  const T = ESTIMATE_THRESHOLDS;

  // Same ordering as the paper path and the door screen's outline (orderDoorQuad): handles dragged past
  // each other still describe the same opening, and the head is the top side by the outline's shape, not
  // whichever corner is nearest the photo's top-left. Seen steeply off to one side and from below with the
  // phone rolled, the head slopes past 45 deg; starting at that corner would read the opening a corner
  // round, its height for its width (an 820 x 2040 opening as 0.40 high-to-wide, matching no size).
  const quad = orderDoorQuad(corners);
  const shape = quadShape(quad);
  if (shape !== 'convex') return fail(shape);

  const K = intrinsics(focalPx, imageWidth, imageHeight);
  const rect = rectifyRectangle(quad, K);
  if (!isPositive(rect.aspectHW) || !Number.isFinite(rect.orthogonalityErrDeg) || !Number.isFinite(rect.viewTiltDeg)) {
    return fail('degenerate');
  }

  // The corners' own error when the caller knows it (a corner still where detection put it is less sure
  // than a tap: see doorCornerSigmaPx in js/screens/mark-common.js), otherwise a tap's.
  const sigmaPx = isPositive(input.cornerSigmaPx)
    ? input.cornerSigmaPx
    : (T.tapSigmaPxAt2048 * Math.max(imageWidth, imageHeight)) / 2048;
  const focalSigma = focalSource === 'exif' ? T.focalSigmaLnExif : T.focalSigmaLnPrior;
  const sigmaLnAspect = Math.hypot(aspectSigmaLn(quad, K, sigmaPx, focalSigma), T.sigmaFloorLn);
  if (!isPositive(sigmaLnAspect)) return fail('degenerate');

  const ranked = classifyStandard({ aspectHW: rect.aspectHW, sigmaLnAspect, sizes });
  if (!ranked.length) return fail('degenerate');
  const candidates = ranked.slice(0, T.maxCandidates).map(toCandidate);
  const best = candidates[0];
  const nonStandard = Math.abs(best.zAspect) > T.nonStandardZ;

  const issues = [];
  if (rect.orthogonalityErrDeg > T.maxOrthogonalityDeg) issues.push('not_rectangular');
  if (focalSource !== 'exif') {
    // The 1x main lens's own spread, for every source: the live camera's lens is within the prior's own
    // sigma, which p already allows for, so there only the size must stay the same.
    const near = lensEffect(quad, K, rect.aspectHW, sizes, sigmaLnAspect, best, T.lensRangePrior);
    // A picked file's lens and crop may be far out, past anything sigma allows, so it is also asked about
    // the lenses and crops it may have been taken with, but only those that put the camera at a height a
    // customer holds a phone at. Aimed at the door's middle from 1.3-1.5 m, as nearly every photo is, the
    // phone is tilted down 5-12 deg, and a longer focal reads that as a steeper tilt, which moves the ratio
    // up: an 870 x 2040 door from 2.6 m becomes 870 x 2100 on twice the focal, the same photo taken from 5 m
    // with the camera 2.5 m up. Seen from the side nothing limits where the camera stood, so there the size
    // must also stay a sure match: far outside two close sizes the nearer one looks sure. 720 x 2040 and
    // 820 x 2340 are 0.7 % apart; a 720 x 2040 door 20 deg off on the 2x lens reads as 820 x 2340 at p 0.83
    // with the prior, and at its real focal neither is sure (p 0.52). With a corner a few px out, 820 x 2340
    // can stay the nearer all the way to the real focal. EXIF names the lens ('exif_file': a 2x photo reads
    // 52 mm), so there only a crop is unknown, and a crop only lengthens the focal.
    const far = file
      ? lensEffect(quad, K, rect.aspectHW, sizes, sigmaLnAspect, best, T.lensRangeFile, {
          longerOnly: focalSource === 'exif_file',
          heightMm: T.fileCameraHeightMm,
          sideOnDeg: T.fileSideOnDeg,
          minP: T.confidentP,
        })
      : { decides: false, shiftLn: 0 };
    // Put down to the angle where the lens takes away a sure answer, or moves the ratio further than the
    // corners' own error (a tap's, or detection's: sigmaPx) does. Not otherwise: a near-square photo whose
    // ratio sits between two sizes is unsure because of the corners, and a nudge of the lens tipping it
    // either way is no reason to tell the customer they stood on an angle.
    const cornerSigmaLn = Math.hypot(aspectSigmaLn(quad, K, sigmaPx), T.sigmaFloorLn);
    const shiftLn = Math.max(near.shiftLn, far.shiftLn);
    if ((near.decides || far.decides) && (best.p >= T.confidentP || shiftLn > cornerSigmaLn)) issues.push('steep_angle');
  }
  if (nonStandard) issues.push('non_standard');
  const mx = T.edgeMarginFrac * imageWidth;
  const my = T.edgeMarginFrac * imageHeight;
  if (quad.some((p) => p.x < mx || p.x > imageWidth - mx || p.y < my || p.y > imageHeight - my)) {
    issues.push('door_near_edge');
  }
  const ys = quad.map((p) => p.y);
  if ((Math.max(...ys) - Math.min(...ys)) / imageHeight < T.doorMinHeightFrac) issues.push('door_small');

  const planeToImage = planeToImageFor(quad, best.widthMm, best.heightMm);
  if (!planeToImage) return fail('degenerate');

  return {
    method: 'estimate',
    ok: true,
    corners: quad.map((p) => ({ x: p.x, y: p.y })),
    imageWidth,
    imageHeight,
    aspectHW: rect.aspectHW,
    sigmaLnAspect,
    focalPx,
    focalSource,
    orthogonalityErrDeg: rect.orthogonalityErrDeg,
    viewTiltDeg: rect.viewTiltDeg,
    candidates,
    nonStandard,
    confident: best.p >= T.confidentP && !nonStandard && !issues.some((issue) => NOT_CONFIDENT_ISSUES.includes(issue)),
    issues,
    widthMm: best.widthMm,
    heightMm: best.heightMm,
    planeToImage,
  };
}

/**
 * The catalogue sizes nearest a real measurement (the AR path), best first. Both the ratio and the overall
 * size count, each with a 3 % sigma, so a door that is a bit off in both still finds its standard size.
 *
 * @param {{ widthMm: number, heightMm: number, sizes?: StandardSize[] }} o  measured size (mm, unrounded)
 *        and the catalogue (standardSizesFrom(config); default DEFAULT_STANDARD_SIZES)
 * @returns {Candidate[]}  at most 3; [] when the measured size is not two positive numbers
 */
export function nearestStandard({ widthMm, heightMm, sizes } = {}) {
  if (!isPositive(widthMm) || !isPositive(heightMm)) return [];
  return classifyStandard({
    aspectHW: heightMm / widthMm,
    sigmaLnAspect: AR_SIGMA_LN_ASPECT,
    estimateMm: { w: widthMm, h: heightMm },
    sigmaLnScale: AR_SIGMA_LN_SCALE,
    sizes: cleanSizes(sizes) || DEFAULT_STANDARD_SIZES,
  })
    .slice(0, AR_MAX_CANDIDATES)
    .map(toCandidate);
}
