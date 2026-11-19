/**
 * The AR measuring flow: a small state machine over js/xr-measure.js.
 *
 * The AR screen (js/screens/ar.js) feeds it one reticle ray and the first hit-test result per XR
 * frame and forwards the customer's taps; this module decides what that aim means for the current
 * step, when a point is placed, and what to tell the customer. It holds numbers only (metres in the
 * session's 'local' space, +Y up): no WebXR, DOM or WebGL objects, so Node tests drive it with
 * synthetic rays and hits.
 *
 * Steps, in order:
 *   'floor'  scan the floor until enough upward hit-test results agree on its height (estimateFloorY).
 *            The floor height is the fallback for a bottom corner when the hit test finds nothing.
 *   'bl'     bottom-left: where the left side of the frame meets the ground (a floor hit).
 *   'br'     bottom-right. BL and BR then fix the door plane: the vertical plane through them.
 *   'sill'   optional: the top of a raised step or sill, measured on the door plane. Chrome takes the
 *            furthest plane hit even outside a detected plane's outline, so aiming the bottom corners
 *            at a raised sill lands them on the porch floor behind it and overstates the size (about
 *            +38 mm of height for a 25 mm sill in the error model). The customer aims the bottom
 *            corners at the ground instead, and taps the sill once so heights are taken from its top.
 *            skipSill() is the "No step" button.
 *   'tl'     top-left inside corner: the reticle ray meets the door plane (no hit test needed).
 *   'tr'     top-right.
 *   'done'   result() measures the opening (measureOpening).
 *
 * A tap does not place the point under the crosshair at that instant: the hand moves as the screen is
 * touched. It collects the next TAP_FRAMES usable aims and places their per-axis median.
 */

import {
  aimPoint,
  distance,
  doorPlaneFromBase,
  estimateFloorY,
  horizontal,
  isUpwardHorizontal,
  measureOpening,
  medianPoint,
  normalize,
  surfaceNormalFromQuaternion,
  toPlaneCoords,
  vec3,
  DEFAULT_LIMITS,
} from './xr-measure.js';

/** Every step, in the order the customer goes through them. */
export const STEPS = Object.freeze(['floor', 'bl', 'br', 'sill', 'tl', 'tr', 'done']);

/** The points the customer places, in order (the sill one can be skipped). */
export const POINT_KEYS = Object.freeze(['bl', 'br', 'sill', 'tl', 'tr']);

/** Every reason xr-measure's aimPoint() can give for an aim it cannot use. Each one is also a hint key. */
export const AIM_REASONS = Object.freeze([
  'not_floor',
  'no_surface',
  'too_far',
  'too_narrow',
  'too_wide',
  'not_level',
  'need_bl',
  'no_plane',
  'behind',
  'grazing',
  'too_low',
  'too_high',
  'off_opening',
  'no_ray',
  'bad_step',
]);

/**
 * Hints of the flow's own, on top of the aim reasons:
 *   scan_floor   still looking for the floor
 *   hold_still   a tap is collecting its frames
 *   hold_steady  a tap gave up: too few usable aims while it was collecting (the phone moved)
 */
export const FLOW_HINTS = Object.freeze(['scan_floor', 'hold_still', 'hold_steady']);

/** Every hint onFrame() can return (the screen needs a string for each). */
export const HINT_KEYS = Object.freeze([...AIM_REASONS, ...FLOW_HINTS]);

/*
 * Floor scan. ARCore's first plane hits can sit a few centimetres off while it settles, so the floor
 * only counts as found once FLOOR_AGREEING of the last FLOOR_WINDOW upward hits are within
 * FLOOR_AGREE_M of their median height. At 30-60 frames a second that is well under a second of
 * steady scanning once a plane has been found.
 */
const FLOOR_AGREEING = 15;
const FLOOR_AGREE_M = 0.02;
const FLOOR_WINDOW = 30;

/*
 * Taps. The research recipe takes the median of the aim over the 8-10 frames after a tap. If the aim
 * keeps failing (the phone swung away) the tap is dropped after TAP_MAX_FRAMES frames rather than
 * placing a point from a handful of stray frames, and the customer is asked to hold steady and tap
 * again for HOLD_STEADY_FRAMES frames (about two seconds).
 */
const TAP_FRAMES = 9;
const TAP_MAX_FRAMES = 45;
const HOLD_STEADY_FRAMES = 90;

const NEXT_STEP = { bl: 'br', br: 'sill', sill: 'tl', tl: 'tr', tr: 'done' };
const finite3 = (p) => Array.isArray(p) && p.length >= 3 && p.every((v) => Number.isFinite(v));
const copy = (p) => (p ? [p[0], p[1], p[2]] : null);

/**
 * A hit-test result as plain numbers: { position: [x,y,z], normal: [x,y,z] | null }, or null.
 * Accepts DOMPointReadOnly-style objects and either a surface normal or the hit pose's orientation
 * (whose +Y axis is the surface normal).
 */
function normaliseHit(hit) {
  if (!hit || !hit.position) return null;
  const position = vec3(hit.position);
  if (!finite3(position)) return null;
  let normal = null;
  if (hit.normal) normal = normalize(vec3(hit.normal));
  else if (hit.orientation) normal = surfaceNormalFromQuaternion(hit.orientation);
  return { position, normal: normal && finite3(normal) ? normal : null };
}

/**
 * Create one AR measuring flow.
 *
 * @param {{ limits?: object, tolerances?: object }} [options] Overrides for xr-measure's
 *   DEFAULT_LIMITS (aimPoint guard rails) and DEFAULT_TOLERANCES (measureOpening blunder checks).
 */
export function createArFlow({ limits = {}, tolerances = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const T = { ...(tolerances || {}) };

  let step = 'floor';
  const points = { bl: null, br: null, sill: null, tl: null, tr: null };
  /** Recent upward hit positions, newest last (at most FLOOR_WINDOW). */
  const floorSamples = [];
  let floorY = null;
  let floorReady = false;
  /** The door plane, once both bottom corners are placed. */
  let plane = null;
  /** Where the phone was on the latest frame: the door plane's normal faces it. */
  let eye = null;
  /** A tap still collecting its frames: { step, frames: number[][], seen: number }. */
  let pending = null;
  /** Frames left to show 'hold_steady' after a tap gave up. */
  let holdSteady = 0;
  /** What was done, newest last, so undo() can step back: { step, skipped }. */
  const history = [];

  function updatePlane() {
    plane = points.bl && points.br ? doorPlaneFromBase(points.bl, points.br, { towards: eye }) : null;
  }

  /** The floor point of an upward hit close enough to trust, or the reason it is not one. */
  function floorAim(h) {
    if (!h) return { ok: false, reason: 'no_surface' };
    if (h.normal && !isUpwardHorizontal(h.normal, { maxTiltDeg: L.maxFloorTiltDeg })) return { ok: false, reason: 'not_floor' };
    if (eye && distance(h.position, eye) > L.maxDistanceM) return { ok: false, reason: 'too_far' };
    return { ok: true, point: h.position, source: 'hit' };
  }

  function addFloorSample(point) {
    floorSamples.push({ position: point });
    if (floorSamples.length > FLOOR_WINDOW) floorSamples.shift();
    // Every sample here already faces up (floorAim), so estimateFloorY is the median height.
    floorY = estimateFloorY(floorSamples);
  }

  function floorAgreeing() {
    if (!Number.isFinite(floorY)) return 0;
    return floorSamples.filter((s) => Math.abs(s.position[1] - floorY) <= FLOOR_AGREE_M).length;
  }

  function commit(key, point) {
    points[key] = copy(point);
    history.push({ step: key, skipped: false });
    if (key === 'bl' || key === 'br') updatePlane();
    step = NEXT_STEP[key];
    return { step: key, point: copy(point) };
  }

  /**
   * Feed one XR frame.
   *
   * @param {{ ray: { origin: number[]|object, direction: number[]|object },
   *           hit?: { position: number[]|object, orientation?: number[]|object, normal?: number[]|object } | null }} frame
   *   `ray`: the viewer's reticle ray in 'local' space (xr-measure rayFromPoseMatrix). `hit`: the first
   *   hit-test result's pose in 'local' space, or null when there is none this frame.
   * @returns {{
   *   aim: { ok: boolean, point?: number[], source?: string, reason?: string },
   *   hint: string | null,
   *   floorReady: boolean,
   *   committed: { step: string, point: number[] } | null,
   *   collecting: boolean,
   * }}
   *   `aim`: what the crosshair is on for the current step. `hint`: one of HINT_KEYS, or null when the
   *   aim is good and nothing needs saying. `committed`: the point placed on this frame, if any (the
   *   screen anchors it). `collecting`: a tap is gathering its frames.
   */
  function onFrame({ ray, hit = null } = {}) {
    if (ray && ray.origin) {
      const origin = vec3(ray.origin);
      if (finite3(origin)) eye = origin;
    }
    const h = normaliseHit(hit);
    if (holdSteady > 0) holdSteady -= 1;

    // The floor keeps being sampled until the base is placed: hits near the door's foot are the most
    // relevant ones for the floor-height fallback of the bottom corners.
    let floorHit = null;
    if (step === 'floor' || step === 'bl' || step === 'br') {
      floorHit = floorAim(h);
      if (floorHit.ok) addFloorSample(floorHit.point);
    }

    if (step === 'floor') {
      if (!floorReady && floorAgreeing() >= FLOOR_AGREEING) {
        floorReady = true;
        step = 'bl';
      }
      return { aim: floorHit, hint: floorReady ? null : 'scan_floor', floorReady, committed: null, collecting: false };
    }

    if (step === 'done') {
      return { aim: { ok: false, reason: 'done' }, hint: null, floorReady, committed: null, collecting: false };
    }

    const aim = ray
      ? aimPoint({ step, ray, hit: h, floorY, plane, bl: points.bl, limits: L })
      : { ok: false, reason: 'no_ray' };

    let committed = null;
    if (pending) {
      pending.seen += 1;
      if (aim.ok) pending.frames.push(aim.point);
      if (pending.frames.length >= TAP_FRAMES) {
        const median = medianPoint(pending.frames);
        pending = null;
        if (median) committed = commit(step, median);
      } else if (pending.seen >= TAP_MAX_FRAMES) {
        pending = null;
        holdSteady = HOLD_STEADY_FRAMES;
      }
    }

    let hint = null;
    if (pending) hint = 'hold_still';
    else if (committed) hint = null;
    else if (!aim.ok) hint = AIM_REASONS.includes(aim.reason) ? aim.reason : 'no_surface';
    else if (holdSteady > 0) hint = 'hold_steady';

    return { aim, hint, floorReady, committed, collecting: Boolean(pending) };
  }

  /**
   * The customer tapped: collect the next TAP_FRAMES usable aims and place their median.
   * @returns {boolean} false when there is nothing to place (floor scan, done, or already collecting).
   */
  function tap() {
    if (step === 'floor' || step === 'done' || pending) return false;
    pending = { step, frames: [], seen: 0 };
    holdSteady = 0;
    return true;
  }

  /**
   * Step back once: a tap still collecting is dropped; otherwise the last point placed (or the
   * skipped sill) is taken back and its step becomes current again.
   * @returns {boolean} false when there was nothing to undo.
   */
  function undo() {
    if (pending) {
      pending = null;
      return true;
    }
    const last = history.pop();
    if (!last) return false;
    points[last.step] = null;
    step = last.step;
    holdSteady = 0;
    if (last.step === 'bl' || last.step === 'br') updatePlane();
    return true;
  }

  /**
   * "No step": the opening has no raised sill, so heights are taken from the floor corners.
   * @returns {boolean} false outside the sill step.
   */
  function skipSill() {
    if (step !== 'sill') return false;
    pending = null;
    points.sill = null;
    history.push({ step: 'sill', skipped: true });
    step = 'tl';
    return true;
  }

  /**
   * Start again. By default from the floor scan (what the 'local' space's reset event needs: the
   * world has moved, so the floor height is stale too). With `keepFloor` (a retry after a measurement
   * that did not add up) only the corners go and the customer starts again at the bottom-left one.
   * @param {{ keepFloor?: boolean }} [options]
   */
  function reset({ keepFloor = false } = {}) {
    pending = null;
    holdSteady = 0;
    for (const key of POINT_KEYS) points[key] = null;
    history.length = 0;
    plane = null;
    if (keepFloor && floorReady) {
      step = 'bl';
      return;
    }
    floorSamples.length = 0;
    floorY = null;
    floorReady = false;
    step = 'floor';
  }

  /**
   * Move placed points to where their anchors are now (the AR screen re-reads anchor poses every
   * frame, because ARCore refines its map as the phone moves). Keys that are not placed are ignored.
   * @param {Partial<Record<'bl'|'br'|'sill'|'tl'|'tr', number[]|object>>} moved
   */
  function updatePoints(moved) {
    if (!moved || typeof moved !== 'object') return;
    let base = false;
    for (const key of POINT_KEYS) {
      if (!points[key] || !moved[key]) continue;
      const p = vec3(moved[key]);
      if (!finite3(p)) continue;
      points[key] = p;
      if (key === 'bl' || key === 'br') base = true;
    }
    if (base) updatePlane();
  }

  /**
   * The measurement, once every corner is placed: xr-measure's measureOpening() result (widthMm,
   * heightMm, minWidthMm, minHeightMm, sillHeightMm, warnings, ...), or null before then or when the
   * corners are degenerate.
   */
  function result() {
    if (step !== 'done') return null;
    if (!points.bl || !points.br || !points.tl || !points.tr) return null;
    return measureOpening({
      bl: points.bl,
      br: points.br,
      tl: points.tl,
      tr: points.tr,
      sill: points.sill,
      towards: eye,
      tolerances: T,
    });
  }

  return {
    /** The current step: 'floor' | 'bl' | 'br' | 'sill' | 'tl' | 'tr' | 'done'. */
    get step() {
      return step;
    },
    /** Copies of the placed points, metres in 'local' space (null where not placed). */
    get points() {
      return { bl: copy(points.bl), br: copy(points.br), sill: copy(points.sill), tl: copy(points.tl), tr: copy(points.tr) };
    },
    /** The floor height (along +Y) found by the scan, or null. */
    get floorY() {
      return floorY;
    },
    /** True once the floor scan has found the floor (until reset()). */
    get floorReady() {
      return floorReady;
    },
    /** The door plane through the bottom corners (xr-measure doorPlaneFromBase), or null. */
    get plane() {
      return plane;
    },
    /** True while a tap is collecting its frames. */
    get collecting() {
      return Boolean(pending);
    },
    onFrame,
    tap,
    undo,
    skipSill,
    reset,
    updatePoints,
    result,
  };
}

/** A point on the door plane from in-plane coordinates (metres right of BL, metres up from BL). */
function planePoint(plane, x, y) {
  const o = plane.origin;
  return [
    o[0] + plane.right[0] * x + plane.up[0] * y,
    o[1] + plane.right[1] * x + plane.up[1] * y,
    o[2] + plane.right[2] * x + plane.up[2] * y,
  ];
}

/**
 * The outline to draw over the camera view: the opening's edges between the points placed so far,
 * plus a rubber-band edge to the live aim, each with its length in mm measured the way
 * measureOpening() measures it (widths along the floor line, heights straight up the door plane from
 * the floor corners, or from the sill once it is placed).
 *
 * @param {{ bl?: number[]|null, br?: number[]|null, sill?: number[]|null, tl?: number[]|null, tr?: number[]|null }} points
 * @param {object|null} plane  the flow's door plane (null until both bottom corners are placed)
 * @param {{ step: string, aim: { ok: boolean, point?: number[] } } | null} [live]  the current step and aim
 * @returns {Array<{ id: 'bottom'|'left'|'top'|'right'|'sill', a: number[], b: number[], mm: number, live: boolean }>}
 */
export function outlineSegments(points, plane, live = null) {
  const P = { bl: null, br: null, sill: null, tl: null, tr: null, ...(points || {}) };
  let liveKey = null;
  if (live && live.aim && live.aim.ok && finite3(live.aim.point) && POINT_KEYS.includes(live.step) && !P[live.step]) {
    liveKey = live.step;
    P[liveKey] = live.aim.point;
  }
  // A live bottom-right before the plane exists: the plane it would make.
  const pl = plane || (P.bl && P.br ? doorPlaneFromBase(P.bl, P.br) : null);
  const isLive = (...keys) => keys.includes(liveKey);
  const segments = [];

  if (P.bl && P.br) {
    const mm = pl ? (toPlaneCoords(pl, P.br)[0] - toPlaneCoords(pl, P.bl)[0]) * 1000 : distance(horizontal(P.br), horizontal(P.bl)) * 1000;
    segments.push({ id: 'bottom', a: P.bl, b: P.br, mm, live: isLive('bl', 'br') });
  }
  if (!pl) return segments;

  const sillY = P.sill ? toPlaneCoords(pl, P.sill)[1] : null;
  if (sillY !== null) {
    segments.push({
      id: 'sill',
      a: planePoint(pl, 0, sillY),
      b: planePoint(pl, pl.baseLengthM, sillY),
      mm: sillY * 1000,
      live: isLive('sill'),
    });
  }
  const side = (id, baseKey, topKey) => {
    if (!P[topKey]) return;
    const [x, y] = toPlaneCoords(pl, P[topKey]);
    const baseY = sillY !== null ? sillY : toPlaneCoords(pl, P[baseKey])[1];
    segments.push({ id, a: planePoint(pl, x, baseY), b: P[topKey], mm: (y - baseY) * 1000, live: isLive(topKey, 'sill') });
  };
  side('left', 'bl', 'tl');
  side('right', 'br', 'tr');
  if (P.tl && P.tr) {
    const mm = (toPlaneCoords(pl, P.tr)[0] - toPlaneCoords(pl, P.tl)[0]) * 1000;
    segments.push({ id: 'top', a: P.tl, b: P.tr, mm, live: isLive('tl', 'tr') });
  }
  return segments;
}
