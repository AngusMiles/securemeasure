// Dev-only synthetic "photo" renderer: a stylised front door with a sheet of paper taped to it, drawn by
// inverse-mapping every output pixel through a homography onto the door plane and shading by material.
// It produces the bundled demo photo and gives tests an image whose exact corner positions are known.
//
// Plane frame (millimetres): origin at the top-left corner of the door opening, x right, y down, z pointing
// away from the camera. Everything the customer measures (door leaf, architrave, sheet) lies in z = 0.
//
// Pixel convention: by default integer image coordinates are pixel CENTRES, i.e. pixel [j][i] integrates
// the square (i - 0.5 .. i + 0.5, j - 0.5 .. j + 0.5), the frame a raw bilinear array lookup indexes.
// Pass pixelOrigin: 'corner' to rasterise in the canvas convention instead (pixel [j][i] covers
// i .. i + 1); truth is the plain projection either way.
//
// The app itself (js/vision.js, js/editor.js, a browser canvas) works in the CANVAS convention, so a
// default render sits half a pixel up-left of where detectSheet / refineQuad / the editor place the same
// feature. Anything compared with their output must be rendered with pixelOrigin: 'corner'; DEMO_SCENE
// is, so the bundled demo photo and assets/demo-door.truth.json agree with the app to sub-pixel accuracy.

import zlib from 'node:zlib';
import { cameraHomography, projectPoint } from './camera.mjs';

/** @typedef {{x:number, y:number}} Point */
/** @typedef {{data: Uint8ClampedArray, width: number, height: number}} Image */

const DEFAULT_COLORS = Object.freeze({
  wall: '#dccbb2',
  architrave: '#f1eee7',
  door: '#223f5e',
  doorPanel: '#1d3752',
  gap: '#0c1117',
  handle: '#c9a24b',
  step: '#bdbab3',
  floor: '#a8a49c',
  floorJoint: '#817d76',
  mat: '#7b5d3d',
  plant: '#47723f',
  pot: '#b8663b',
  fixture: '#2f3339',
});

const DEFAULT_SHEET_COLOR = '#fbfaf6';

// Corner samples of a pixel that differ by more than this (0..255 scale) mark it as an edge pixel.
const EDGE_THRESHOLD = 0.75;

const DEMO_CAMERA = Object.freeze({
  focalPx: 2100,
  target: Object.freeze({ x: 410, y: 1090 }),
  distanceMm: 2900,
  yawDeg: 6,
  pitchDeg: -4,
  rollDeg: 0.6,
});

/**
 * The exact renderScene options behind assets/demo-door.png: a portrait 1536 x 2048 photo of an
 * 820 x 2040 mm door with a level, portrait A4 sheet at chest height, taken from 2.9 m away, standing a
 * little to the right of centre with the phone at chest height. Rasterised in the canvas pixel convention
 * (pixelOrigin: 'corner'), the one the app uses, so the truth corners are directly comparable with what
 * detectSheet and the corner editor report for this photo. Deep-frozen; pass it straight to renderScene
 * (or spread it to vary one option).
 */
export const DEMO_SCENE = deepFreeze({
  width: 1536,
  height: 2048,
  camera: DEMO_CAMERA,
  planeToImage: cameraHomography({ imageWidth: 1536, imageHeight: 2048, ...DEMO_CAMERA }),
  doorMm: { w: 820, h: 2040 },
  sheet: { cx: 410, cy: 700, w: 210, h: 297, rotDeg: 0, color: DEFAULT_SHEET_COLOR },
  noiseSigma: 0,
  blurPx: 0.55,
  supersample: 4,
  lighting: 1,
  decor: true,
  seed: 1,
  pixelOrigin: 'corner',
});

/**
 * Render a synthetic photo of a front door.
 *
 * @param {object} opts
 * @param {number[]} opts.planeToImage  required (unless `camera` holds a full pose): row-major 3x3
 *   homography, door-plane mm -> image px
 * @param {number} [opts.width=768]     output width in px
 * @param {number} [opts.height=1024]   output height in px
 * @param {{w:number,h:number}} [opts.doorMm]  door opening size, default 820 x 2040
 * @param {{cx?:number,cy?:number,w?:number,h?:number,rotDeg?:number,color?:string}|null} [opts.sheet]
 *   sheet of paper (centre, side lengths, clockwise rotation in degrees); default a level portrait A4 at
 *   chest height; null = no sheet
 * @param {Partial<typeof DEFAULT_COLORS>} [opts.colors]  hex overrides per material
 * @param {number} [opts.lighting=1]    strength of every lighting effect (gradients, shadows, bevels,
 *   vignette); 0 = flat material colours
 * @param {number} [opts.noiseSigma=0]  gaussian sensor noise (0..255 scale) from a seeded PRNG
 * @param {number} [opts.seed=1]        PRNG seed for the noise
 * @param {number} [opts.blurPx=0]      gaussian lens blur sigma in px
 * @param {number} [opts.supersample=3] S: edge pixels average S x S samples (1 = no anti-aliasing)
 * @param {boolean} [opts.adaptive=true] supersample only pixels whose corners disagree (false = every pixel)
 * @param {boolean} [opts.decor=true]   pot plant, doorbell, wall light and doormat (never drawn over
 *   the opening, its frame or the sheet)
 * @param {boolean} [opts.handle=true]  brass lever handle on the lock rail
 * @param {{focalPx:number, principal?:Point}|object} [opts.camera]  pinhole parameters matching
 *   planeToImage (see tools/camera.mjs). With `focalPx` the step and path are drawn as real 3D ground in
 *   front of the door; without a camera they are drawn flat in the door plane.
 * @param {number} [opts.architraveMm=70]  frame band width
 * @param {{heightMm?:number, depthMm?:number, sideMm?:number}} [opts.step]  the step below the door
 * @param {{x:number,y:number,w:number,h:number}[]} [opts.panels]  recessed panel rectangles (mm)
 * @param {'center'|'corner'} [opts.pixelOrigin='center']  whether integer image coordinates are pixel
 *   centres or pixel top-left corners (see the note at the top of this file)
 * @returns {{ image: Image, truth: { planeToImage: number[], doorPx: Point[], sheetPx: Point[]|null,
 *   doorMm: {w:number,h:number}, sheetMm: {w:number,h:number}|null } }}
 */
export function renderScene(opts) {
  const scene = resolveScene(opts);
  const shade = createShader(scene);
  const rgb = rasterise(scene, shade);
  if (scene.blurPx > 0) gaussianBlur(rgb, scene.width, scene.height, scene.blurPx);
  if (scene.noiseSigma > 0) addNoise(rgb, scene.noiseSigma, scene.seed);

  const n = scene.width * scene.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let p = 0, q = 0, s = 0; p < n; p++, q += 4, s += 3) {
    data[q] = rgb[s];
    data[q + 1] = rgb[s + 1];
    data[q + 2] = rgb[s + 2];
    data[q + 3] = 255;
  }
  return { image: { data, width: scene.width, height: scene.height }, truth: buildTruth(scene) };
}

/**
 * The ground truth renderScene would return for these options, without rendering any pixels.
 *
 * @param {object} opts  same options as renderScene
 * @returns {{ planeToImage: number[], doorPx: Point[], sheetPx: Point[]|null,
 *   doorMm: {w:number,h:number}, sheetMm: {w:number,h:number}|null }}
 */
export function sceneTruth(opts) {
  return buildTruth(resolveScene(opts));
}

/**
 * Shape a renderScene truth as the JSON stored next to the demo photo. Pixel coordinates are rounded to
 * 1e-4 px so the file is stable and readable.
 *
 * @param {{doorPx: Point[], sheetPx: Point[]|null, doorMm: {w:number,h:number}, sheetMm: {w:number,h:number}|null}} truth
 * @param {{width:number, height:number}} size  the rendered image (or its options)
 * @returns {{ widthMm:number, heightMm:number, sheetMm:{w:number,h:number}|null, doorPx:Point[],
 *   sheetPx:Point[]|null, imageWidth:number, imageHeight:number }}
 */
export function truthToJson(truth, size) {
  const round = (p) => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 });
  return {
    widthMm: truth.doorMm.w,
    heightMm: truth.doorMm.h,
    sheetMm: truth.sheetMm ? { w: truth.sheetMm.w, h: truth.sheetMm.h } : null,
    doorPx: truth.doorPx.map(round),
    sheetPx: truth.sheetPx ? truth.sheetPx.map(round) : null,
    imageWidth: size.width,
    imageHeight: size.height,
  };
}

// ---------------------------------------------------------------------------------------------------
// Options and truth
// ---------------------------------------------------------------------------------------------------

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new TypeError(`renderScene: bad colour "${hex}" (expected #rgb or #rrggbb)`);
  const s = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) throw new Error('renderScene: planeToImage is singular');
  return [
    A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    C / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

/**
 * Camera centre in the plane frame, recovered from H = K [r1 r2 t]. Returns null when the homography is
 * not consistent with that pinhole (e.g. a plain scale-and-shift used by a test).
 */
function eyeFromHomography(H, focalPx, principal) {
  const f = focalPx;
  const { x: cx, y: cy } = principal;
  const m = [
    (H[0] - cx * H[6]) / f, (H[1] - cx * H[7]) / f, (H[2] - cx * H[8]) / f,
    (H[3] - cy * H[6]) / f, (H[4] - cy * H[7]) / f, (H[5] - cy * H[8]) / f,
    H[6], H[7], H[8],
  ];
  const n1 = Math.hypot(m[0], m[3], m[6]);
  const n2 = Math.hypot(m[1], m[4], m[7]);
  if (!(n1 > 0) || !(n2 > 0) || Math.abs(n1 - n2) > 1e-6 * (n1 + n2)) return null;
  // The plane must be in front of the camera, which fixes the sign of the scale.
  const lambda = (m[8] >= 0 ? 1 : -1) * (n1 + n2) / 2;
  const r1 = [m[0] / lambda, m[3] / lambda, m[6] / lambda];
  const r2 = [m[1] / lambda, m[4] / lambda, m[7] / lambda];
  if (Math.abs(r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]) > 1e-6) return null;
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const t = [m[2] / lambda, m[5] / lambda, m[8] / lambda];
  const dot = (v) => v[0] * t[0] + v[1] * t[1] + v[2] * t[2];
  const eye = { x: -dot(r1), y: -dot(r2), z: -dot(r3) };
  return Number.isFinite(eye.x + eye.y + eye.z) ? eye : null;
}

function resolveScene(opts) {
  if (!opts || typeof opts !== 'object') throw new TypeError('renderScene: an options object is required');
  const width = Math.round(opts.width ?? 768);
  const height = Math.round(opts.height ?? 1024);
  if (!(width > 0) || !(height > 0)) throw new RangeError('renderScene: width and height must be positive');

  const camera = opts.camera ?? null;
  let planeToImage = opts.planeToImage;
  if (!planeToImage && camera && Number.isFinite(camera.distanceMm ?? 2800)) {
    planeToImage = cameraHomography({ imageWidth: width, imageHeight: height, ...camera });
  }
  if (!planeToImage || planeToImage.length !== 9) {
    throw new TypeError('renderScene: planeToImage (row-major 3x3, door-plane mm -> image px) is required');
  }
  planeToImage = Array.from(planeToImage, Number);
  if (!planeToImage.every(Number.isFinite)) throw new TypeError('renderScene: planeToImage has non-finite entries');
  const imageToPlane = invert3(planeToImage);

  const doorMm = { w: Number(opts.doorMm?.w ?? 820), h: Number(opts.doorMm?.h ?? 2040) };
  const W = doorMm.w;
  const H = doorMm.h;
  if (!(W > 0) || !(H > 0)) throw new RangeError('renderScene: doorMm must be positive');

  let sheet = null;
  if (opts.sheet !== null && opts.sheet !== false) {
    sheet = { cx: W / 2, cy: Math.round(H * 0.343), w: 210, h: 297, rotDeg: 0, color: DEFAULT_SHEET_COLOR, ...opts.sheet };
    if (!(sheet.w > 0) || !(sheet.h > 0)) throw new RangeError('renderScene: sheet w and h must be positive');
  }

  const colors = { ...DEFAULT_COLORS, ...(opts.colors ?? {}) };
  const rgb = {};
  for (const key of Object.keys(colors)) rgb[key] = hexToRgb(colors[key]);
  if (sheet) rgb.sheet = hexToRgb(sheet.color);

  const architraveMm = Number(opts.architraveMm ?? 70);
  const stile = 0.14 * W;
  const mullion = 0.11 * W;
  const panels = (opts.panels ?? [
    { x: stile, y: 0.062 * H, w: W - 2 * stile, h: (0.49 - 0.062) * H },
    { x: stile, y: 0.57 * H, w: (W - 2 * stile - mullion) / 2, h: (0.905 - 0.57) * H },
    { x: (W + mullion) / 2, y: 0.57 * H, w: (W - 2 * stile - mullion) / 2, h: (0.905 - 0.57) * H },
  ]).map((p) => ({ x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h }));

  const step = {
    heightMm: Number(opts.step?.heightMm ?? 170),
    depthMm: Number(opts.step?.depthMm ?? 380),
    sideMm: Number(opts.step?.sideMm ?? architraveMm + 95),
  };

  // Real 3D ground needs to know where the camera is; that takes the focal length as well as H.
  let eye = null;
  if (camera && Number.isFinite(camera.focalPx) && camera.focalPx > 0) {
    const principal = camera.principal ?? { x: width / 2, y: height / 2 };
    eye = eyeFromHomography(planeToImage, camera.focalPx, principal);
    // Only a camera standing in front of the step and looking over it gives a sensible ground view.
    if (eye && !(eye.z < -(step.depthMm + 200) && eye.y < H - 100)) eye = null;
  }

  const pixelOrigin = opts.pixelOrigin ?? 'center';
  if (pixelOrigin !== 'center' && pixelOrigin !== 'corner') {
    throw new TypeError("renderScene: pixelOrigin must be 'center' or 'corner'");
  }

  return {
    width,
    height,
    planeToImage,
    imageToPlane,
    doorMm,
    sheet,
    rgb,
    eye,
    architraveMm,
    panels,
    step,
    stile,
    lighting: Math.max(0, Number(opts.lighting ?? 1)),
    noiseSigma: Math.max(0, Number(opts.noiseSigma ?? 0)),
    seed: (opts.seed ?? 1) >>> 0,
    blurPx: Math.max(0, Number(opts.blurPx ?? 0)),
    supersample: Math.max(1, Math.round(opts.supersample ?? 3)),
    adaptive: opts.adaptive !== false,
    decor: opts.decor !== false,
    handle: opts.handle !== false,
    pixelOrigin,
  };
}

/** Rotate / flip four corners given in cyclic order into [TL, TR, BR, BL] as seen in the image. */
function toImageQuad(points) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  // With y down, a positive shoelace sum means clockwise on screen.
  const cw = area >= 0 ? points.slice() : points.slice().reverse();
  let first = 0;
  for (let i = 1; i < 4; i++) if (cw[i].x + cw[i].y < cw[first].x + cw[first].y) first = i;
  return [0, 1, 2, 3].map((i) => cw[(first + i) % 4]);
}

function sheetCornersMm(sheet) {
  const a = (sheet.rotDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const hw = sheet.w / 2;
  const hh = sheet.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
    x: sheet.cx + lx * c - ly * s,
    y: sheet.cy + lx * s + ly * c,
  }));
}

function buildTruth(scene) {
  const { planeToImage: H, doorMm, sheet } = scene;
  // Truth is always the plain projection; pixelOrigin only changes which square each pixel integrates.
  const project = (p) => projectPoint(H, p);
  const doorCorners = [{ x: 0, y: 0 }, { x: doorMm.w, y: 0 }, { x: doorMm.w, y: doorMm.h }, { x: 0, y: doorMm.h }];
  return {
    planeToImage: H.slice(),
    doorPx: toImageQuad(doorCorners.map(project)),
    sheetPx: sheet ? toImageQuad(sheetCornersMm(sheet).map(project)) : null,
    doorMm: { w: doorMm.w, h: doorMm.h },
    sheetMm: sheet ? { w: sheet.w, h: sheet.h } : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------------------------------

/** Smoothstep that also accepts a > b (a falling edge). */
function sstep(a, b, x) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Signed distance to an axis-aligned box centred on the origin. */
function sdBox(px, py, hx, hy) {
  const dx = Math.abs(px) - hx;
  const dy = Math.abs(py) - hy;
  const ox = dx > 0 ? dx : 0;
  const oy = dy > 0 ? dy : 0;
  const inside = dx > dy ? dx : dy;
  return Math.sqrt(ox * ox + oy * oy) + (inside < 0 ? inside : 0);
}

/** Distance to the segment a-b. */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  let t = ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

/** Deterministic 0..1 hash of two small integers (per-paver tone variation). */
function hash2(a, b) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Build shade(ix, iy, out): the colour (0..255 floats, may exceed 255 before clamping) seen at a
 * continuous image position.
 */
function createShader(scene) {
  const { width, height, doorMm, sheet, rgb: C, eye, panels, step, stile, decor } = scene;
  const W = doorMm.w;
  const H = doorMm.h;
  const A = scene.architraveMm;
  const Lk = scene.lighting;
  const [g0, g1, g2, g3, g4, g5, g6, g7, g8] = scene.imageToPlane;
  const wSign = Math.sign(g6 * (width / 2) + g7 * (height / 2) + g8) || 1;
  const vignetteNorm = 1 / ((width / 2) ** 2 + (height / 2) ** 2);
  const imgCx = (width - 1) / 2;
  const imgCy = (height - 1) / 2;

  // Material functions write their result here.
  let R = 0;
  let G = 0;
  let B = 0;
  const put = (c, k) => {
    R = c[0] * k;
    G = c[1] * k;
    B = c[2] * k;
  };

  // --- sheet -------------------------------------------------------------------------------------
  const hasSheet = !!sheet;
  const sheetAngle = hasSheet ? (sheet.rotDeg * Math.PI) / 180 : 0;
  const sCos = Math.cos(sheetAngle);
  const sSin = Math.sin(sheetAngle);
  const scx = hasSheet ? sheet.cx : 0;
  const scy = hasSheet ? sheet.cy : 0;
  const shw = hasSheet ? sheet.w / 2 : 0;
  const shh = hasSheet ? sheet.h / 2 : 0;

  const onSheet = (X, Y) => {
    if (!hasSheet) return false;
    const dx = X - scx;
    const dy = Y - scy;
    return Math.abs(dx * sCos + dy * sSin) <= shw && Math.abs(-dx * sSin + dy * sCos) <= shh;
  };

  // Soft contact shadow, pushed slightly down and to the right of the sheet (light from the upper left).
  const sheetShadow = (X, Y) => {
    if (!hasSheet) return 0;
    const dx = X - scx - 3;
    const dy = Y - scy - 5;
    const d = sdBox(dx * sCos + dy * sSin, -dx * sSin + dy * sCos, shw, shh);
    return d >= 16 ? 0 : 0.42 * (1 - sstep(-4, 16, d));
  };

  // --- door hardware -----------------------------------------------------------------------------
  const hasHandle = scene.handle;
  const hx = W - stile / 2;
  const hy = 0.53 * H;
  const leverLen = Math.min(128, W * 0.2);
  const leverR = 10.5;
  const plateCy = hy + 45;
  const plateHx = 23;
  const plateHy = 118;
  const plateRad = 9;
  const keyY = hy + 105;
  const brassDark = [C.handle[0] * 0.3, C.handle[1] * 0.26, C.handle[2] * 0.2];

  // --- gap, panels -------------------------------------------------------------------------------
  const gap = 3;
  const gapBottom = 5;
  const bevel = 16;

  // --- step / ground -----------------------------------------------------------------------------
  const yT = H; // top of the step = door threshold
  const yG = H + step.heightMm; // path level
  const bx0 = -step.sideMm;
  const bx1 = W + step.sideMm;
  const depth = step.depthMm;
  const tileW = 520;
  const tileD = 330;
  const joint = 9;
  const matX0 = W / 2 - Math.min(280, W * 0.36);
  const matX1 = W / 2 + Math.min(280, W * 0.36);
  const matZNear = -55;
  const matZFar = -Math.min(depth - 45, 325);

  // --- decor: pot plant (a billboard standing just in front of the wall), doorbell, wall light -----
  const plantZ = -Math.min(190, depth / 2);
  const pcx = -A - 300;
  const potH = 300;
  const potTop = yG - potH;
  const potTopHW = 150;
  const potBotHW = 108;
  const rimH = 46;
  const rimHW = 162;
  const rimSag = eye ? 24 : 0;
  const potSag = eye ? 40 : 0;
  const FR = 205;
  const fcy = potTop - 0.8 * FR;
  const bellX = W + A + 82;
  const bellY = 0.5 * H;
  const lampX = W + A + 270;
  const lampY = 0.2 * H;

  /** 0 = nothing, 1 = foliage, 2 = pot body, 3 = pot rim, at a point on the plant billboard. */
  const plantMaterial = (bx, by) => {
    const dx = bx - pcx;
    const dy = by - fcy;
    const rr = dx * dx + dy * dy;
    if (rr < FR * FR * 1.15) {
      const th = Math.atan2(dy, dx);
      const rw = FR * (1 + 0.04 * Math.sin(7 * th + 0.6) + 0.025 * Math.sin(13 * th + 2.1));
      if (rr < rw * rw) return 1;
    }
    if (by >= potTop && by <= yG) {
      // Seen from above, the round rim and base bulge towards the camera, so their lower edges sag in
      // the middle. The billboard touches the ground at the front of the base; the sides lift off.
      const ax = Math.abs(dx);
      if (ax <= rimHW && by < potTop + rimH + rimSag * Math.sqrt(1 - (ax / rimHW) ** 2)) return 3;
      if (ax > potBotHW + ((potTopHW - potBotHW) * (yG - by)) / potH) return 0;
      if (potSag > 0) {
        const lift = ax < potBotHW ? potSag * (1 - Math.sqrt(1 - (ax / potBotHW) ** 2)) : potSag;
        if (yG - by < lift) return 0;
      }
      return 2;
    }
    return 0;
  };

  const shadePlant = (m, bx, by) => {
    const dx = bx - pcx;
    if (m === 1) {
      let k = 1;
      if (Lk > 0) {
        const nx = dx / FR;
        const ny = (by - fcy) / FR;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const diffuse = Math.max(0, -0.45 * nx - 0.65 * ny + 0.61 * nz);
        // Three plane waves 60 degrees apart, gently warped, give soft clumps of leaves rather than a weave.
        const wx = (dx + 16 * Math.sin(by * 0.043 + 1)) * 0.098;
        const wy = (by + 16 * Math.sin(dx * 0.051 + 2)) * 0.098;
        const clumps = (Math.cos(wx) + Math.cos(0.5 * wx + 0.866 * wy) + Math.cos(-0.5 * wx + 0.866 * wy)) / 3;
        k = 1 + Lk * (-0.38 + 0.62 * diffuse + 0.13 * clumps);
      }
      put(C.plant, k);
      return;
    }
    let k = 1;
    if (Lk > 0) {
      const hw = m === 3 ? rimHW : potBotHW + ((potTopHW - potBotHW) * Math.max(0, yG - by)) / potH;
      const u = dx / hw;
      k = 1 + Lk * (0.08 - 0.22 * u - 0.18 * u * u);
      if (m === 3) k *= 1 + Lk * 0.07;
      else k *= 1 - Lk * 0.22 * (1 - sstep(0, 22, by - potTop - rimH - rimSag * Math.sqrt(Math.max(0, 1 - (dx / rimHW) ** 2))));
      // The foliage overhangs and shades the top of the pot.
      k *= 1 - Lk * 0.2 * (1 - sstep(0, 60, by - potTop));
    }
    put(C.pot, k);
  };

  // --- door plane materials ----------------------------------------------------------------------

  const shadeDoor = (X, Y) => {
    if (X < gap || X > W - gap || Y < gap || Y > H - gapBottom) {
      put(C.gap, 1);
      return;
    }
    let k = 1;
    if (Lk > 0) {
      k = 1 + Lk * (0.16 - 0.28 * (Y / H) - 0.1 * (X / W - 0.5));
      // The leaf sits back in the frame, so the head and the left jamb shade its edges.
      k *= 1 - Lk * 0.3 * (1 - sstep(0, 55, Y));
      k *= 1 - Lk * 0.22 * (1 - sstep(0, 32, X));
      const ss = sheetShadow(X, Y);
      if (ss > 0) k *= 1 - Lk * ss;
    }

    if (hasHandle) {
      const dLever = sdSegment(X, Y, hx, hy, hx - leverLen, hy) - leverR;
      const dRose = Math.hypot(X - hx, Y - hy) - 19;
      if (dLever < 0 || dRose < 0) {
        let kb = 1;
        if (Lk > 0) {
          if (dLever < 0) {
            const v = (Y - hy) / leverR;
            kb = 1 + Lk * (0.02 - 0.3 * v + 0.26 * Math.exp(-(((v + 0.38) / 0.24) ** 2)));
          } else {
            kb = 1 + Lk * (0.06 - 0.2 * ((Y - hy) / 19));
            if (dRose > -2.4) kb *= 1 - Lk * 0.25;
          }
        }
        put(C.handle, kb);
        return;
      }
      const dPlate = sdBox(X - hx, Y - plateCy, plateHx - plateRad, plateHy - plateRad) - plateRad;
      if (dPlate < 0) {
        const dKey = Math.hypot(X - hx, Y - keyY);
        if (dKey < 7.5 || (Math.abs(X - hx) < 2.6 && Y > keyY && Y < keyY + 16)) {
          put(brassDark, 1);
          return;
        }
        let kb = 1;
        if (Lk > 0) {
          kb = 1 + Lk * (0.08 - 0.24 * ((Y - plateCy + plateHy) / (2 * plateHy)));
          if (dPlate > -2.4) kb *= 1 - Lk * 0.26;
          else if (dKey < 12) kb *= 1 + Lk * 0.1;
          // The lever throws a soft shadow down the plate.
          kb *= 1 - Lk * 0.34 * (1 - sstep(-1, 9, sdSegment(X - 4, Y - 7, hx, hy, hx - leverLen, hy) - leverR));
        }
        put(C.handle, kb);
        return;
      }
      if (Lk > 0) {
        const sLever = sdSegment(X - 4, Y - 7, hx, hy, hx - leverLen, hy) - leverR;
        if (sLever < 10) k *= 1 - Lk * 0.36 * (1 - sstep(-1, 10, sLever));
        const sPlate = sdBox(X - hx - 2.5, Y - plateCy - 4, plateHx - plateRad, plateHy - plateRad) - plateRad;
        if (sPlate < 8) k *= 1 - Lk * 0.3 * (1 - sstep(-1, 8, sPlate));
      }
    }

    for (let i = 0; i < panels.length; i++) {
      const p = panels[i];
      if (X <= p.x0 || X >= p.x1 || Y <= p.y0 || Y >= p.y1) continue;
      const dl = X - p.x0;
      const dr = p.x1 - X;
      const dt = Y - p.y0;
      const db = p.y1 - Y;
      const de = Math.min(dl, dr, dt, db);
      if (de < bevel) {
        // Mitred bevel sloping down into the panel: the top and left faces are in shade, the bottom and
        // right faces catch the light.
        let f = 1;
        if (Lk > 0) {
          if (de === dt) f = 1 - 0.42 * Lk;
          else if (de === dl) f = 1 - 0.3 * Lk;
          else if (de === db) f = 1 + 0.5 * Lk;
          else f = 1 + 0.32 * Lk;
        }
        put(C.door, k * f);
        return;
      }
      if (Lk > 0) {
        const top = 0.26 * (1 - sstep(0, 46, dt - bevel));
        const left = 0.2 * (1 - sstep(0, 34, dl - bevel));
        k *= 1 - Lk * (top > left ? top : left);
      }
      put(C.doorPanel, k);
      return;
    }
    put(C.door, k);
  };

  const shadeArchitrave = (X, Y) => {
    let k = 1;
    if (Lk > 0) {
      const dl = -X;
      const dr = X - W;
      const dt = -Y;
      // member: 0 = left leg, 1 = right leg, 2 = head (mitred at the top corners)
      let member;
      let t;
      if (dt > 0 && dt >= dl && dt >= dr) {
        member = 2;
        t = dt / A;
      } else if (dl > 0) {
        member = 0;
        t = dl / A;
      } else {
        member = 1;
        t = dr / A;
      }
      k = 1 + Lk * (0.012 - 0.04 * (Y / H));
      if (member === 2) k *= 1 - Lk * 0.012;
      // Small chamfers on the inner and outer edges: faces turned to the upper left are lit.
      if (t < 0.1) k *= member === 1 ? 1 + 0.03 * Lk : 1 - 0.15 * Lk;
      else if (t > 0.9) k *= member === 1 ? 1 - 0.15 * Lk : 1 + 0.03 * Lk;
      else if (t > 0.56 && t < 0.61) k *= 1 - 0.07 * Lk;
    }
    put(C.architrave, k);
  };

  const shadeWall = (X, Y) => {
    let k = 1;
    if (Lk > 0) {
      k = 1 + Lk * (0.03 - 0.065 * (Y / H) - 0.05 * ((X - W / 2) / H));
      // Soft shade from the eave above.
      k *= 1 - Lk * 0.1 * sstep(-0.06 * H, -0.2 * H, Y);
      // Architrave drop shadow, down and to the right.
      const qx = X - 5 - W / 2;
      const qy = Y - 7 - (H + 4000 - A) / 2;
      const d = sdBox(qx, qy, W / 2 + A, (H + 4000 + A) / 2);
      if (d < 18) k *= 1 - Lk * 0.24 * (1 - sstep(0, 18, d));
      // Contact shade where the wall meets the ground.
      if (Y > yG - 110) k *= 1 - Lk * 0.16 * (1 - sstep(0, 110, yG - Y));
      if (decor) {
        const dPlant = sdSegment(X - 95, Y - 45, pcx, fcy, pcx, yG - 60) - 150;
        if (dPlant < 90) k *= 1 - Lk * 0.17 * (1 - sstep(-50, 90, dPlant));
      }
    }
    if (decor) {
      // Doorbell: a small dark plate with a brass button.
      const dBell = sdBox(X - bellX, Y - bellY, 20 - 9, 44 - 9) - 9;
      if (dBell < 0) {
        const dBtn = Math.hypot(X - bellX, Y - bellY + 12);
        if (dBtn < 11) put(C.handle, 1 + Lk * (0.05 - 0.2 * ((Y - bellY + 12) / 11)));
        else put(C.fixture, 1 + Lk * (0.12 - 0.3 * ((Y - bellY + 44) / 88)));
        return;
      }
      // Wall light: a dark cylinder with a soft highlight down its lit side.
      const dLamp = sdBox(X - lampX, Y - lampY, 38 - 10, 105 - 10) - 10;
      if (dLamp < 0) {
        const u = (X - lampX) / 38;
        put(C.fixture, 1 + Lk * (-0.1 + 0.75 * Math.exp(-(((u + 0.38) / 0.3) ** 2)) - 0.25 * u));
        return;
      }
      if (Lk > 0) {
        const sBell = sdBox(X - bellX - 3, Y - bellY - 5, 20 - 9, 44 - 9) - 9;
        if (sBell < 9) k *= 1 - Lk * 0.25 * (1 - sstep(-1, 9, sBell));
        const sLamp = sdBox(X - lampX - 14, Y - lampY - 18, 38 - 10, 105 - 10) - 10;
        if (sLamp < 30) k *= 1 - Lk * 0.2 * (1 - sstep(-8, 30, sLamp));
      }
    }
    put(C.wall, k);
  };

  /** Paving seen from above: gx along the wall, dist = mm in front of the step's front face. */
  const shadeGround = (gx, dist) => {
    const row = Math.floor(dist / tileD);
    const fz = dist - row * tileD;
    const xs = gx + (row & 1 ? tileW / 2 : 0) + 130;
    const colI = Math.floor(xs / tileW);
    const fx = xs - colI * tileW;
    const isJoint = fz < joint || fx < joint;
    let k = 1;
    if (Lk > 0) {
      k = 1 + Lk * 0.07 * (hash2(row, colI) - 0.5);
      // Contact shade along the front of the step ...
      if (dist > 0 && dist < 500) {
        k *= 1 - Lk * 0.34 * Math.exp(-dist / 85) * sstep(bx0 - 70, bx0, gx) * sstep(bx1 + 70, bx1, gx);
      }
      // ... and along the foot of the wall either side of it.
      const gz = -(dist + depth);
      if (gz > -450) k *= 1 - Lk * 0.26 * Math.exp(gz / 80);
      if (decor) {
        // Contact shadow hugging the base of the pot, drifting away from the light.
        const ex = (gx - pcx - 28) / 165;
        const ez = (gz - plantZ - 30) / 112;
        const e = Math.sqrt(ex * ex + ez * ez);
        if (e < 1.3) k *= 1 - Lk * 0.42 * (1 - sstep(0.6, 1.3, e));
      }
    }
    put(isJoint ? C.floorJoint : C.floor, k);
  };

  const shadeTread = (px, pz) => {
    let k = 1;
    if (Lk > 0) {
      k = 1 + Lk * 0.04;
      k *= 1 - Lk * 0.3 * Math.exp(pz / 70);
      if (pz < -depth + 14) k *= 1 + Lk * 0.05;
    }
    if (decor && px > matX0 && px < matX1 && pz < matZNear && pz > matZFar) {
      const edge = Math.min(px - matX0, matX1 - px, matZNear - pz, pz - matZFar);
      put(C.mat, edge < 22 ? k * (1 - 0.22 * Lk) : k);
      return;
    }
    if (decor && Lk > 0) {
      // Thin contact shadow around the doormat.
      const d = sdBox(px - (matX0 + matX1) / 2 - 3, pz - (matZNear + matZFar) / 2 + 4, (matX1 - matX0) / 2, (matZNear - matZFar) / 2);
      if (d < 12) k *= 1 - Lk * 0.2 * (1 - sstep(0, 12, d));
    }
    put(C.step, k);
  };

  /** Everything lying in the door plane itself. */
  const shadePlane = (X, Y) => {
    if (hasSheet) {
      const dx = X - scx;
      const dy = Y - scy;
      const ly = -dx * sSin + dy * sCos;
      if (Math.abs(dx * sCos + dy * sSin) <= shw && Math.abs(ly) <= shh) {
        put(C.sheet, Lk > 0 ? 1 - Lk * 0.03 * (ly / (2 * shh) + 0.5) : 1);
        return;
      }
    }
    if (X >= 0 && X <= W && Y >= 0 && Y <= H) shadeDoor(X, Y);
    else if (X >= -A && X <= W + A && Y >= -A && Y <= H) shadeArchitrave(X, Y);
    else shadeWall(X, Y);
  };

  /** Flat fallback for the area below the threshold when the camera position is unknown. */
  const shadeBelowFlat = (X, Y) => {
    if (Y > yG) shadeGround(X, Y - yG);
    else if (X >= bx0 && X <= bx1) put(C.step, 1);
    else shadeWall(X, Y);
  };

  /**
   * Things standing in front of the door plane (step, path, pot plant), found by casting the ray from
   * the camera through plane point (X, Y). Returns false when the ray reaches the plane unobstructed.
   */
  const shadeFront = (X, Y, plantAllowed) => {
    const ex = eye.x;
    const ey = eye.y;
    const ez = eye.z;
    const Dx = X - ex;
    const Dy = Y - ey;
    let best = 1;
    let kind = 0; // 1 box, 2 ground, 3 plant
    let face = 0;
    let plantM = 0;

    if (plantAllowed) {
      const u = 1 - plantZ / ez;
      const m = plantMaterial(ex + u * Dx, ey + u * Dy);
      if (m) {
        best = u;
        kind = 3;
        plantM = m;
      }
    }

    if (Y > yT) {
      // Slab test against the step box [bx0, bx1] x [yT, yG] x [-depth, 0]. Dy > 0 and Dz = -ez > 0 here.
      let t0 = 0;
      let t1 = Infinity;
      let f = 0;
      let miss = false;
      if (Math.abs(Dx) < 1e-9) {
        miss = ex < bx0 || ex > bx1;
      } else {
        let a = (bx0 - ex) / Dx;
        let b = (bx1 - ex) / Dx;
        if (a > b) {
          const tmp = a;
          a = b;
          b = tmp;
        }
        if (a > t0) {
          t0 = a;
          f = 1;
        }
        if (b < t1) t1 = b;
      }
      if (!miss) {
        const a = (yT - ey) / Dy;
        const b = (yG - ey) / Dy;
        if (a > t0) {
          t0 = a;
          f = 2;
        }
        if (b < t1) t1 = b;
        const c = 1 + depth / ez;
        if (c > t0) {
          t0 = c;
          f = 3;
        }
        if (t1 > 1) t1 = 1;
        if (t0 <= t1 && t0 < best) {
          best = t0;
          kind = 1;
          face = f;
        }
      }
      if (Y > yG) {
        const u = (yG - ey) / Dy;
        if (u < best) {
          best = u;
          kind = 2;
        }
      }
    }

    if (kind === 0) return false;
    const px = ex + best * Dx;
    const py = ey + best * Dy;
    const pz = ez * (1 - best);
    if (kind === 3) {
      shadePlant(plantM, px, py);
    } else if (kind === 2) {
      shadeGround(px, -pz - depth);
    } else if (face === 2) {
      shadeTread(px, pz);
    } else if (face === 3) {
      let k = 1;
      if (Lk > 0) {
        k = 1 - Lk * 0.2;
        k *= 1 - Lk * 0.24 * (1 - sstep(0, 26, py - yT));
        k *= 1 - Lk * 0.1 * (1 - sstep(0, 50, yG - py));
      }
      put(C.step, k);
    } else {
      put(C.step, 1 - Lk * 0.32);
    }
    return true;
  };

  return function shade(ix, iy, out) {
    const w = g6 * ix + g7 * iy + g8;
    if (w * wSign <= 0) {
      // Beyond the plane's horizon: nothing sensible to show, so fall back to plain wall.
      put(C.wall, 1);
    } else {
      const X = (g0 * ix + g1 * iy + g2) / w;
      const Y = (g3 * ix + g4 * iy + g5) / w;
      // The pot plant is skipped wherever the door plane shows the opening, its frame or the sheet, so
      // that even from a steep angle decor can never hide what a test wants to measure.
      const plantAllowed = decor && !(X > -A && X < W + A && Y > -A && Y < H) && !onSheet(X, Y);
      if (eye) {
        if (!shadeFront(X, Y, plantAllowed)) shadePlane(X, Y);
      } else {
        // Camera position unknown: draw the pot plant, step and path flat in the door plane.
        const m = plantAllowed ? plantMaterial(X, Y) : 0;
        if (m) shadePlant(m, X, Y);
        else if (Y > yT) shadeBelowFlat(X, Y);
        else shadePlane(X, Y);
      }
    }
    if (Lk > 0) {
      const vx = ix - imgCx;
      const vy = iy - imgCy;
      const v = 1 - Lk * 0.1 * (vx * vx + vy * vy) * vignetteNorm;
      R *= v;
      G *= v;
      B *= v;
    }
    out[0] = R > 255 ? 255 : R;
    out[1] = G > 255 ? 255 : G;
    out[2] = B > 255 ? 255 : B;
  };
}

// ---------------------------------------------------------------------------------------------------
// Rasterising, blur, noise
// ---------------------------------------------------------------------------------------------------

/**
 * Sub-pixel sample offsets for supersample = S: S x S points on a rank-1 lattice instead of a square
 * grid. No two samples share a row or a column, so the coverage of a near-vertical or near-horizontal
 * edge (every edge in a door photo) resolves to 1 / S^2 of a pixel rather than 1 / S.
 */
function samplePattern(S) {
  const n = S * S;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let g = Math.max(1, Math.round(n / 1.6180339887));
  while (gcd(g, n) !== 1) g++;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    dx[k] = (k + 0.5) / n;
    dy[k] = (((k * g) % n) + 0.5) / n;
  }
  return { n, dx, dy };
}

/**
 * Box-filtered rasterisation into a Float32 RGB buffer. In adaptive mode each pixel's four corners are
 * shaded once (shared with its neighbours); only pixels whose corners disagree get the full
 * supersample pattern, which keeps a 3-megapixel render to roughly one shade call per pixel.
 * Averaging is done on the encoded (sRGB) values so an edge's half-way level sits exactly on the edge.
 */
function rasterise(scene, shade) {
  const { width, height, adaptive } = scene;
  const o = scene.pixelOrigin === 'corner' ? 0 : -0.5;
  const rgb = new Float32Array(width * height * 3);
  const out = new Float64Array(3);
  const { n, dx, dy } = samplePattern(scene.supersample);
  const inv = 1 / n;

  const supersamplePixel = (i, j, p) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < n; k++) {
      shade(i + o + dx[k], j + o + dy[k], out);
      r += out[0];
      g += out[1];
      b += out[2];
    }
    rgb[p] = r * inv;
    rgb[p + 1] = g * inv;
    rgb[p + 2] = b * inv;
  };

  if (!adaptive) {
    for (let j = 0, p = 0; j < height; j++) {
      for (let i = 0; i < width; i++, p += 3) supersamplePixel(i, j, p);
    }
    return rgb;
  }

  let above = new Float32Array((width + 1) * 3);
  let below = new Float32Array((width + 1) * 3);
  const shadeCornerRow = (row, j) => {
    const y = j + o;
    for (let i = 0, q = 0; i <= width; i++, q += 3) {
      shade(i + o, y, out);
      row[q] = out[0];
      row[q + 1] = out[1];
      row[q + 2] = out[2];
    }
  };

  shadeCornerRow(above, 0);
  for (let j = 0, p = 0; j < height; j++) {
    shadeCornerRow(below, j + 1);
    for (let i = 0, a = 0; i < width; i++, a += 3, p += 3) {
      let edge = false;
      for (let c = 0; c < 3; c++) {
        const v0 = above[a + c];
        const v1 = above[a + 3 + c];
        const v2 = below[a + c];
        const v3 = below[a + 3 + c];
        const lo = Math.min(v0, v1, v2, v3);
        const hi = Math.max(v0, v1, v2, v3);
        if (hi - lo > EDGE_THRESHOLD) {
          edge = true;
          break;
        }
      }
      if (edge) {
        supersamplePixel(i, j, p);
      } else {
        rgb[p] = (above[a] + above[a + 3] + below[a] + below[a + 3]) / 4;
        rgb[p + 1] = (above[a + 1] + above[a + 4] + below[a + 1] + below[a + 4]) / 4;
        rgb[p + 2] = (above[a + 2] + above[a + 5] + below[a + 2] + below[a + 5]) / 4;
      }
    }
    const tmp = above;
    above = below;
    below = tmp;
  }
  return rgb;
}

/** In-place separable gaussian blur of a Float32 RGB buffer, clamping at the borders. */
function gaussianBlur(rgb, width, height, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const line = new Float32Array(Math.max(width, height) * 3);
  // Horizontal pass.
  for (let y = 0; y < height; y++) {
    const base = y * width * 3;
    line.set(rgb.subarray(base, base + width * 3));
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
        const wgt = kernel[k + radius];
        r += wgt * line[xx * 3];
        g += wgt * line[xx * 3 + 1];
        b += wgt * line[xx * 3 + 2];
      }
      rgb[base + x * 3] = r;
      rgb[base + x * 3 + 1] = g;
      rgb[base + x * 3 + 2] = b;
    }
  }
  // Vertical pass.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const s = (y * width + x) * 3;
      line[y * 3] = rgb[s];
      line[y * 3 + 1] = rgb[s + 1];
      line[y * 3 + 2] = rgb[s + 2];
    }
    for (let y = 0; y < height; y++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
        const wgt = kernel[k + radius];
        r += wgt * line[yy * 3];
        g += wgt * line[yy * 3 + 1];
        b += wgt * line[yy * 3 + 2];
      }
      const s = (y * width + x) * 3;
      rgb[s] = r;
      rgb[s + 1] = g;
      rgb[s + 2] = b;
    }
  }
}

/** Add independent gaussian noise to every channel from a seeded mulberry32 stream. */
function addNoise(rgb, sigma, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < rgb.length; i += 2) {
    // Box-Muller gives two independent normals per pair of uniforms.
    const mag = sigma * Math.sqrt(-2 * Math.log(1 - next()));
    const ang = 2 * Math.PI * next();
    rgb[i] += mag * Math.cos(ang);
    if (i + 1 < rgb.length) rgb[i + 1] += mag * Math.sin(ang);
  }
}

// ---------------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Encode an image as a PNG using node:zlib only. 8-bit truecolour; the alpha channel is dropped when
 * every pixel is opaque. Each scanline gets whichever of the five PNG filters minimises the sum of
 * absolute residuals, which is what makes smooth gradients compress well.
 *
 * @param {{data: ArrayLike<number>, width: number, height: number}} image  RGBA (4 bytes per pixel) or
 *   RGB (3 bytes per pixel) data
 * @returns {Buffer}
 */
export function encodePng(image) {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('encodePng: width and height must be positive integers');
  }
  const inCh = data.length === width * height * 4 ? 4 : data.length === width * height * 3 ? 3 : 0;
  if (!inCh) throw new RangeError('encodePng: data length does not match width x height x 3 or 4');

  let opaque = true;
  if (inCh === 4) {
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) {
        opaque = false;
        break;
      }
    }
  }
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let cur = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));

  for (let y = 0; y < height; y++) {
    if (inCh === bpp) {
      for (let i = 0, s = y * stride; i < stride; i++, s++) cur[i] = data[s];
    } else {
      for (let x = 0, s = y * width * 4, d = 0; x < width; x++, s += 4, d += 3) {
        cur[d] = data[s];
        cur[d + 1] = data[s + 1];
        cur[d + 2] = data[s + 2];
      }
    }
    const cost = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const x = cur[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const residuals = [x, x - a, x - b, x - ((a + b) >> 1), x - paeth(a, b, c)];
      for (let f = 0; f < 5; f++) {
        const v = residuals[f] & 0xff;
        candidates[f][i] = v;
        cost[f] += v < 128 ? v : 256 - v;
      }
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (cost[f] < cost[best]) best = f;
    const rowStart = y * (stride + 1);
    raw[rowStart] = best;
    raw.set(candidates[best], rowStart + 1);
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: truecolour, with or without alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // not interlaced
  const idat = zlib.deflateSync(raw, { level: 9, memLevel: 9 });
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Decode a PNG written by encodePng (8-bit truecolour, with or without alpha, not interlaced) back into
 * an RGBA image. Verifies the signature and every chunk CRC. Dev/test helper, not a general decoder.
 *
 * @param {Uint8Array} bytes
 * @returns {Image}
 */
export function decodePng(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('decodePng: not a PNG');
  let width = 0;
  let height = 0;
  let bpp = 0;
  const idat = [];
  for (let pos = 8; pos + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (pos + 12 + length > buf.length) throw new Error('decodePng: truncated chunk');
    if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== buf.readUInt32BE(pos + 8 + length)) {
      throw new Error(`decodePng: bad CRC in ${type}`);
    }
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const colourType = body[9];
      if (body[8] !== 8 || (colourType !== 2 && colourType !== 6) || body[12] !== 0) {
        throw new Error('decodePng: only 8-bit non-interlaced RGB / RGBA is supported');
      }
      bpp = colourType === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (!bpp) throw new Error('decodePng: missing IHDR');

  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error('decodePng: unexpected image data length');
  const data = new Uint8ClampedArray(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    if (filter > 4) throw new Error('decodePng: bad filter type');
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      cur[i] = (raw[rowStart + 1 + i] + predicted) & 0xff;
    }
    for (let x = 0, s = 0, d = y * width * 4; x < width; x++, s += bpp, d += 4) {
      data[d] = cur[s];
      data[d + 1] = cur[s + 1];
      data[d + 2] = cur[s + 2];
      data[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return { data, width, height };
}
