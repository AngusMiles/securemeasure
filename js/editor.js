/**
 * Touch-first quad editor: four draggable corner handles over a photo, drawn on a <canvas>.
 *
 * The file has two halves:
 *   1. Small pure functions holding ALL of the coordinate maths (view fitting, zooming, clamping,
 *      hit testing, loupe placement...). They never touch the DOM, so they are unit tested in Node.
 *   2. The QuadEditor class: Pointer Events, keyboard, canvas rendering. Nothing in it runs at
 *      import time, so this module also imports cleanly in Node.
 *
 * DOM it creates inside the container: <canvas class="sm-quad-editor"> filling it (photo, quad,
 * handles, focus ring) and a small <canvas class="sm-quad-editor__loupe"> stacked above it that
 * is only shown while a handle is being dragged or nudged.
 *
 * Coordinate systems
 *   - "screen": CSS px relative to the canvas top-left corner.
 *   - "image":  working-image px, x right, y down, continuous: pixel (i, j) covers the square
 *               [i, i + 1) x [j, j + 1), exactly as a canvas draws it and as js/vision.js
 *               reports its quads.
 *   - A View maps image -> screen as a uniform scale plus a translation.
 */

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ scale: number, tx: number, ty: number }} View   screen = image * scale + (tx, ty)
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ r: number, g: number, b: number, a: number }} Rgba   r/g/b 0..255, a 0..1
 */

const TAU = Math.PI * 2;

/** Radius (CSS px) around a handle inside which a touch grabs it. */
export const HANDLE_HIT_RADIUS_PX = 28;
/** A press that moves less than this (CSS px)... */
export const TAP_SLOP_PX = 10;
/** ...and lasts less than this (ms) is a tap. Generous: a slow, deliberate press on the sheet must
 * still count, and the editor has no long-press gesture to tell it apart from. */
export const TAP_MAX_MS = 700;
/** A second finger landing within this long (ms) of a press on a handle makes the two a pinch from
 * the start: the first finger was never dragging that handle. */
export const PINCH_START_MS = 300;
/** Deepest zoom, in screen px per image px. */
export const MAX_SCALE = 8;
/** Loupe diameter in CSS px. */
export const LOUPE_DIAMETER_PX = 120;
/** Gap between the loupe and the canvas edges in CSS px. */
export const LOUPE_MARGIN_PX = 12;
/** The loupe shows at least this many screen px per image px... */
export const LOUPE_MIN_SCALE = 4;
/** ...and at least this many times the current view zoom. */
export const LOUPE_ZOOM_FACTOR = 3;

/** z-index of the loupe layer: above controls a host floats over the photo. */
export const LOUPE_Z_INDEX = 5;

const ZOOM_ANIMATION_MS = 220;
const NUDGE_LOUPE_MS = 1400;
const OVERSCROLL_FRAC = 0.3;
const DEFAULT_COLOR = '#1f8fff';
const DEFAULT_GHOST_COLOR = '#ffffff';
const DARK_CASING = 'rgba(0, 0, 0, 0.6)';
const LIGHT_CASING = 'rgba(255, 255, 255, 0.92)';
const LOUPE_BACKDROP = '#15181c';
const FALLBACK_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ------------------------------------------------------------------------------------------ *
 * Pure coordinate maths
 * ------------------------------------------------------------------------------------------ */

/**
 * The view that letterboxes the whole image inside the viewport, centred.
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} viewWidth   CSS px
 * @param {number} viewHeight  CSS px
 * @param {number} [paddingPx] empty border kept around the image
 * @returns {View}
 */
export function fitView(imageWidth, imageHeight, viewWidth, viewHeight, paddingPx = 0) {
  const availW = viewWidth - 2 * paddingPx;
  const availH = viewHeight - 2 * paddingPx;
  if (!(imageWidth > 0 && imageHeight > 0 && availW > 0 && availH > 0)) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const scale = Math.min(availW / imageWidth, availH / imageHeight);
  return {
    scale,
    tx: (viewWidth - imageWidth * scale) / 2,
    ty: (viewHeight - imageHeight * scale) / 2,
  };
}

/**
 * Map an image point to screen (canvas CSS px).
 * @param {View} view
 * @param {Point} p
 * @returns {Point}
 */
export function imageToScreen(view, p) {
  return { x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty };
}

/**
 * Map a screen point (canvas CSS px) to image px.
 * @param {View} view
 * @param {Point} p
 * @returns {Point}
 */
export function screenToImage(view, p) {
  return { x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale };
}

/**
 * The same view expressed for coordinates that are offset from the bitmap grid by a constant
 * number of image px (used for the half-pixel shift between pixel-centre and pixel-corner
 * conventions).
 * @param {View} view
 * @param {number} offsetImagePx
 * @returns {View}
 */
export function shiftView(view, offsetImagePx) {
  return {
    scale: view.scale,
    tx: view.tx + offsetImagePx * view.scale,
    ty: view.ty + offsetImagePx * view.scale,
  };
}

/**
 * Zoom range for an image in a viewport: the fit view is the minimum; the maximum is MAX_SCALE
 * screen px per image px (or the fit scale, for images so small that fit is already deeper).
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {number} [maxScale]
 * @returns {{ minScale: number, maxScale: number }}
 */
export function scaleLimits(imageWidth, imageHeight, viewWidth, viewHeight, maxScale = MAX_SCALE) {
  const minScale = fitView(imageWidth, imageHeight, viewWidth, viewHeight).scale;
  return { minScale, maxScale: Math.max(maxScale, minScale) };
}

/**
 * Zoom by `factor` keeping the image point under `anchor` (screen px) exactly where it is.
 * The scale is limited first, so the anchor stays fixed even when a limit is hit.
 * @param {View} view
 * @param {Point} anchor
 * @param {number} factor
 * @param {{ minScale?: number, maxScale?: number }} [limits]
 * @returns {View}
 */
export function zoomAt(view, anchor, factor, limits = {}) {
  const lo = limits.minScale ?? 0;
  const hi = limits.maxScale ?? Infinity;
  const wanted = view.scale * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  const scale = clamp(wanted, lo, Math.max(lo, hi));
  const k = scale / view.scale;
  return {
    scale,
    tx: anchor.x - (anchor.x - view.tx) * k,
    ty: anchor.y - (anchor.y - view.ty) * k,
  };
}

/**
 * Translate a view by a screen-space delta.
 * @param {View} view
 * @param {number} dx
 * @param {number} dy
 * @returns {View}
 */
export function panBy(view, dx, dy) {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy };
}

/**
 * Force a view into the legal range so the image can never be lost off-screen.
 *  - scale is limited to [fit, max] (rescaling about the viewport centre);
 *  - on an axis where the image is smaller than the viewport it is centred;
 *  - on an axis where it is larger, no gap may open between an image edge and the viewport edge
 *    beyond `overscrollPx`. The allowance grows smoothly from zero at the fit view, so the fit
 *    view itself is rigid while a zoomed-in view lets an edge-hugging corner be pulled toward
 *    the middle of the screen where a thumb can reach it.
 * @param {View} view
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {{ minScale?: number, maxScale?: number, overscrollPx?: number }} [opts]
 * @returns {View}
 */
export function clampView(view, imageWidth, imageHeight, viewWidth, viewHeight, opts = {}) {
  const limits = scaleLimits(imageWidth, imageHeight, viewWidth, viewHeight);
  const lo = opts.minScale ?? limits.minScale;
  const hi = Math.max(lo, opts.maxScale ?? limits.maxScale);
  const overscroll = Math.max(0, opts.overscrollPx ?? 0);

  if (!view || !Number.isFinite(view.scale) || view.scale <= 0
    || !Number.isFinite(view.tx) || !Number.isFinite(view.ty)) {
    return fitView(imageWidth, imageHeight, viewWidth, viewHeight);
  }

  let { scale, tx, ty } = view;
  const limited = clamp(scale, lo, hi);
  if (limited !== scale) {
    const k = limited / scale;
    tx = viewWidth / 2 - (viewWidth / 2 - tx) * k;
    ty = viewHeight / 2 - (viewHeight / 2 - ty) * k;
    scale = limited;
  }

  const axis = (t, content, size) => {
    if (content <= size) return (size - content) / 2;
    const slack = Math.min(overscroll, (content - size) / 2);
    return clamp(t, size - content - slack, slack);
  };
  return {
    scale,
    tx: axis(tx, imageWidth * scale, viewWidth),
    ty: axis(ty, imageHeight * scale, viewHeight),
  };
}

/**
 * Clamp a point to the image.
 * With pixelOrigin 'corner' (the canvas convention: pixel i covers [i, i + 1), which is what
 * js/vision.js uses for its quads) the valid range is [0, size]; with 'center' (integer
 * coordinates address pixel centres) it is [0, size - 1]. Non-finite coordinates become 0.
 * @param {Point} p
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {'corner' | 'center'} [pixelOrigin]
 * @returns {Point}
 */
export function clampPoint(p, imageWidth, imageHeight, pixelOrigin = 'corner') {
  const inset = pixelOrigin === 'center' ? 1 : 0;
  const maxX = Math.max(0, imageWidth - inset);
  const maxY = Math.max(0, imageHeight - inset);
  return {
    x: Number.isFinite(p.x) ? clamp(p.x, 0, maxX) : 0,
    y: Number.isFinite(p.y) ? clamp(p.y, 0, maxY) : 0,
  };
}

/**
 * Which handle does a press at `screenPoint` grab? The nearest handle wins; -1 when none is
 * within `radiusPx` (measured on screen, so the target stays thumb-sized at every zoom).
 * @param {Point[] | null} points   handle positions in image px
 * @param {Point} screenPoint
 * @param {View} view
 * @param {number} [radiusPx]
 * @returns {number} handle index or -1
 */
export function hitTestHandle(points, screenPoint, view, radiusPx = HANDLE_HIT_RADIUS_PX) {
  if (!Array.isArray(points)) return -1;
  const r2 = radiusPx * radiusPx;
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < points.length; i++) {
    const s = imageToScreen(view, points[i]);
    const dx = s.x - screenPoint.x;
    const dy = s.y - screenPoint.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestD2) {
      best = i;
      bestD2 = d2;
    }
  }
  return best;
}

/**
 * Where to draw the loupe: the top corner further from the finger, so the hand never covers it.
 * `previousSide` adds a little hysteresis around the centre line so the loupe does not flicker
 * from side to side while a finger hovers near the middle of the screen.
 * @param {Point} finger   screen px
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {{ diameter?: number, margin?: number, previousSide?: 'left' | 'right' | null }} [opts]
 * @returns {{ side: 'left' | 'right', cx: number, cy: number, radius: number }}
 */
export function loupeCorner(finger, viewWidth, viewHeight, opts = {}) {
  const margin = opts.margin ?? LOUPE_MARGIN_PX;
  const wanted = opts.diameter ?? LOUPE_DIAMETER_PX;
  // Shrink in tiny containers so the loupe always fits inside the canvas.
  const diameter = Math.max(24, Math.min(wanted, viewWidth - 2 * margin, viewHeight - 2 * margin));
  const radius = diameter / 2;
  const mid = viewWidth / 2;
  const hysteresis = Math.min(24, viewWidth * 0.06);

  let side;
  if (opts.previousSide === 'left') side = finger.x < mid - hysteresis ? 'right' : 'left';
  else if (opts.previousSide === 'right') side = finger.x > mid + hysteresis ? 'left' : 'right';
  else side = finger.x <= mid ? 'right' : 'left';

  return {
    side,
    cx: side === 'left' ? margin + radius : viewWidth - margin - radius,
    cy: margin + radius,
    radius,
  };
}

/**
 * Loupe magnification in screen px per image px for the current view zoom.
 * @param {number} viewScale
 * @returns {number}
 */
export function loupeScale(viewScale) {
  const zoom = Number.isFinite(viewScale) && viewScale > 0 ? viewScale : 0;
  return Math.max(LOUPE_MIN_SCALE, LOUPE_ZOOM_FACTOR * zoom);
}

/**
 * Axis-aligned bounds of a set of points, or null when there are none / they are not finite.
 * @param {Point[]} points
 * @returns {Rect | null}
 */
export function quadBounds(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The view that frames a quad: its bounding box plus `padFrac` of its longer side on every side,
 * centred, limited to the legal zoom range and clamped like any other view.
 * @param {Point[]} quad   image px
 * @param {number} padFrac
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {{ maxScale?: number, overscrollPx?: number, pixelOffset?: number }} [opts]
 * @returns {View}
 */
export function viewForQuad(quad, padFrac, imageWidth, imageHeight, viewWidth, viewHeight, opts = {}) {
  const bounds = quadBounds(quad);
  if (!bounds || !(viewWidth > 0 && viewHeight > 0)) {
    return fitView(imageWidth, imageHeight, viewWidth, viewHeight);
  }
  const frac = Number.isFinite(padFrac) ? Math.max(0, padFrac) : 0;
  const pad = frac * Math.max(bounds.width, bounds.height, 1);
  const w = bounds.width + 2 * pad;
  const h = bounds.height + 2 * pad;
  const limits = scaleLimits(imageWidth, imageHeight, viewWidth, viewHeight, opts.maxScale);
  const scale = clamp(Math.min(viewWidth / w, viewHeight / h), limits.minScale, limits.maxScale);
  const offset = opts.pixelOffset ?? 0;
  const cx = bounds.x + bounds.width / 2 + offset;
  const cy = bounds.y + bounds.height / 2 + offset;
  return clampView(
    { scale, tx: viewWidth / 2 - cx * scale, ty: viewHeight / 2 - cy * scale },
    imageWidth, imageHeight, viewWidth, viewHeight,
    { minScale: limits.minScale, maxScale: limits.maxScale, overscrollPx: opts.overscrollPx },
  );
}

/**
 * Interpolate between two views for a zoom animation: the scale moves geometrically and the
 * image point at the viewport centre moves linearly, which reads as one smooth camera move.
 * @param {View} a
 * @param {View} b
 * @param {number} t   0..1
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @returns {View}
 */
export function lerpView(a, b, t, viewWidth, viewHeight) {
  if (!(t > 0)) return { ...a };
  if (t >= 1) return { ...b };
  const scale = a.scale * Math.pow(b.scale / a.scale, t);
  const centre = { x: viewWidth / 2, y: viewHeight / 2 };
  const ia = screenToImage(a, centre);
  const ib = screenToImage(b, centre);
  const ix = ia.x + (ib.x - ia.x) * t;
  const iy = ia.y + (ib.y - ia.y) * t;
  return { scale, tx: centre.x - ix * scale, ty: centre.y - iy * scale };
}

/**
 * True when two views are the same to within a small tolerance.
 * @param {View} a
 * @param {View} b
 * @param {number} [epsilon]
 * @returns {boolean}
 */
export function viewsEqual(a, b, epsilon = 1e-3) {
  return Math.abs(a.scale - b.scale) <= epsilon * Math.max(1e-9, Math.abs(b.scale))
    && Math.abs(a.tx - b.tx) <= epsilon * 100
    && Math.abs(a.ty - b.ty) <= epsilon * 100;
}

/**
 * The view after a two-finger move: zooms by the change in finger spread about the previous
 * pinch centre and pans by the movement of that centre, so the image point that was between the
 * fingers stays between the fingers.
 * @param {View} view
 * @param {Point} prevA
 * @param {Point} prevB
 * @param {Point} nextA
 * @param {Point} nextB
 * @param {{ minScale?: number, maxScale?: number }} [limits]
 * @returns {View}
 */
export function pinchView(view, prevA, prevB, nextA, nextB, limits = {}) {
  const prevCentre = { x: (prevA.x + prevB.x) / 2, y: (prevA.y + prevB.y) / 2 };
  const nextCentre = { x: (nextA.x + nextB.x) / 2, y: (nextA.y + nextB.y) / 2 };
  const prevSpread = distance(prevA, prevB);
  const nextSpread = distance(nextA, nextB);
  // Fingers almost touching give a wildly unstable ratio: pan only.
  const factor = prevSpread > 8 && nextSpread > 8 ? nextSpread / prevSpread : 1;
  const zoomed = zoomAt(view, prevCentre, factor, limits);
  return panBy(zoomed, nextCentre.x - prevCentre.x, nextCentre.y - prevCentre.y);
}

/**
 * Pan the view just enough to bring a screen point at least `marginPx` inside the viewport.
 * @param {View} view
 * @param {Point} screenPoint
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {number} [marginPx]
 * @returns {View}
 */
export function ensureVisible(view, screenPoint, viewWidth, viewHeight, marginPx = 0) {
  const mx = Math.min(Math.max(0, marginPx), viewWidth / 2);
  const my = Math.min(Math.max(0, marginPx), viewHeight / 2);
  let dx = 0;
  let dy = 0;
  if (screenPoint.x < mx) dx = mx - screenPoint.x;
  else if (screenPoint.x > viewWidth - mx) dx = viewWidth - mx - screenPoint.x;
  if (screenPoint.y < my) dy = my - screenPoint.y;
  else if (screenPoint.y > viewHeight - my) dy = viewHeight - my - screenPoint.y;
  return panBy(view, dx, dy);
}

/**
 * The part of the image that is on screen, as an integer source rectangle (so only that part
 * needs to be drawn), or null when the image is entirely off-screen.
 * @param {View} view
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @returns {Rect | null}
 */
export function visibleImageRect(view, imageWidth, imageHeight, viewWidth, viewHeight) {
  const x0 = Math.max(0, Math.floor(-view.tx / view.scale));
  const y0 = Math.max(0, Math.floor(-view.ty / view.scale));
  const x1 = Math.min(imageWidth, Math.ceil((viewWidth - view.tx) / view.scale));
  const y1 = Math.min(imageHeight, Math.ceil((viewHeight - view.ty) / view.scale));
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Canvas backing-store size for a CSS size: device-pixel sharp, but capped so a 3x phone or a
 * huge desktop window never allocates an enormous bitmap.
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} devicePixelRatio
 * @param {{ maxRatio?: number, maxPixels?: number }} [opts]
 * @returns {{ width: number, height: number, ratio: number }}
 */
export function backingStoreSize(cssWidth, cssHeight, devicePixelRatio, opts = {}) {
  const maxRatio = opts.maxRatio ?? 3;
  const maxPixels = opts.maxPixels ?? 4_000_000;
  const w = Math.max(0, cssWidth || 0);
  const h = Math.max(0, cssHeight || 0);
  let ratio = clamp(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1, 1, maxRatio);
  if (w * h * ratio * ratio > maxPixels) ratio = Math.sqrt(maxPixels / (w * h));
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    ratio,
  };
}

/**
 * Order in which to join the points so the outline is always a simple polygon (never a bow-tie),
 * even after the customer drags one handle past another: indices sorted by angle around the
 * centroid. For a normal [TL, TR, BR, BL] quad this is [0, 1, 2, 3].
 * @param {Point[]} points
 * @returns {number[]}
 */
export function outlineOrder(points) {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x / n;
    cy += p.y / n;
  }
  return points
    .map((p, i) => ({ i, angle: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((u, v) => u.angle - v.angle || u.i - v.i)
    .map((o) => o.i);
}

/**
 * Is a press that travelled `distancePx` and lasted `elapsedMs` a tap?
 * @param {number} distancePx
 * @param {number} elapsedMs
 * @returns {boolean}
 */
export function isTap(distancePx, elapsedMs) {
  return distancePx <= TAP_SLOP_PX && elapsedMs <= TAP_MAX_MS;
}

/**
 * A second finger has landed while the first is holding a handle: was the first one the start of
 * a pinch rather than a drag the customer meant? Yes when the second finger followed quickly, or
 * when the first is still no further from where it pressed than a tap may travel. The handle then
 * goes back where it was instead of keeping whatever the first finger did to it on the way.
 * @param {number} travelPx    how far the first finger is from where it pressed (CSS px)
 * @param {number} elapsedMs   how long ago it pressed
 * @returns {boolean}
 */
export function isPinchStart(travelPx, elapsedMs) {
  return elapsedMs < PINCH_START_MS || travelPx <= TAP_SLOP_PX;
}

/**
 * The handle position to commit when a finger lifts.
 * A fingertip rolls as it leaves the glass and drags the contact point a pixel or two with it.
 * If the finger was all but still during the last moments before release, the position from just
 * before those moments is the one the customer was looking at, so that one is returned. A finger
 * that was clearly still travelling keeps its last position.
 * @param {{ t: number, point: Point, sx: number, sy: number }[]} trail   recent drag samples, oldest first (sx/sy = finger screen px)
 * @param {number} releaseTime   same clock as trail[].t
 * @param {{ windowMs?: number, maxTravelPx?: number }} [opts]
 * @returns {Point | null}
 */
export function settledPoint(trail, releaseTime, opts = {}) {
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const windowMs = opts.windowMs ?? 60;
  const maxTravelPx = opts.maxTravelPx ?? 3;
  const last = trail[trail.length - 1];
  for (let i = trail.length - 1; i >= 0; i--) {
    const sample = trail[i];
    if (sample.t <= releaseTime - windowMs) {
      const travel = Math.hypot(last.sx - sample.sx, last.sy - sample.sy);
      return travel <= maxTravelPx ? sample.point : last.point;
    }
  }
  return last.point;
}

/**
 * Zoom factor for one wheel event (wheel up / pinch out zooms in). Limited per event so a
 * free-spinning wheel cannot jump the whole zoom range at once.
 * @param {number} deltaY
 * @param {number} [deltaMode]   0 = pixels, 1 = lines, 2 = pages
 * @param {boolean} [ctrlKey]    true for trackpad pinch gestures, which report small deltas
 * @returns {number}
 */
export function wheelZoomFactor(deltaY, deltaMode = 0, ctrlKey = false) {
  if (!Number.isFinite(deltaY)) return 1;
  const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  return clamp(Math.exp(-px * (ctrlKey ? 0.01 : 0.0015)), 0.5, 2);
}

/**
 * Which handle Tab / Shift+Tab moves to, or null when focus should leave the canvas.
 * @param {number | null} active
 * @param {number} count
 * @param {boolean} backwards
 * @returns {number | null}
 */
export function nextTabIndex(active, count, backwards) {
  if (active == null || !(count > 0)) return null;
  const next = active + (backwards ? -1 : 1);
  return next >= 0 && next < count ? next : null;
}

/**
 * Parse '#rgb', '#rgba', '#rrggbb', '#rrggbbaa', 'rgb(...)' and 'rgba(...)' (comma or space
 * separated). Anything else returns null.
 * @param {string} value
 * @returns {Rgba | null}
 */
export function parseCssColor(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]+)$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((c) => parseInt(c + c, 16));
      return { r: v[0], g: v[1], b: v[2], a: h.length === 4 ? v[3] / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
      return { r: v[0], g: v[1], b: v[2], a: h.length === 8 ? v[3] / 255 : 1 };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channel = (t) => (t.endsWith('%') ? (parseFloat(t) * 255) / 100 : parseFloat(t));
  const alpha = (t) => (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t));
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  const a = parts.length === 4 ? alpha(parts[3]) : 1;
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
}

/**
 * WCAG relative luminance (0 = black, 1 = white) of an sRGB colour.
 * @param {{ r: number, g: number, b: number }} rgb
 * @returns {number}
 */
export function relativeLuminance(rgb) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/**
 * Casing (outline) colour for an overlay line: light under dark lines, dark under light ones.
 * Line and casing are then far apart in brightness, so at least one of the two contrasts with
 * whatever the photo shows underneath (a white door in sun or a black one in shade).
 * @param {Rgba | null} rgb   null (unknown colour) gets the dark casing
 * @returns {string} CSS colour
 */
export function casingFor(rgb) {
  return rgb && relativeLuminance(rgb) < 0.22 ? LIGHT_CASING : DARK_CASING;
}

/* ------------------------------------------------------------------------------------------ *
 * Small private helpers
 * ------------------------------------------------------------------------------------------ */

/**
 * Copy `count` finite points out of arbitrary input.
 * @param {unknown} value
 * @param {number} [count]
 * @returns {Point[] | null}
 */
function toPoints(value, count = 4) {
  if (!Array.isArray(value) || value.length !== count) return null;
  const out = [];
  for (const p of value) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** @param {any} source  @returns {{ width: number, height: number }} */
function intrinsicSize(source) {
  if (!source) return { width: 0, height: 0 };
  return {
    width: Number(source.naturalWidth || source.videoWidth || source.width) || 0,
    height: Number(source.naturalHeight || source.videoHeight || source.height) || 0,
  };
}

/** Rounded-rectangle path (CanvasRenderingContext2D.roundRect is missing in Safari 15). */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Distance from a point to an axis-aligned rectangle (0 when inside). */
function rectDistance(p, x, y, w, h) {
  const dx = Math.max(x - p.x, 0, p.x - (x + w));
  const dy = Math.max(y - p.y, 0, p.y - (y + h));
  return Math.hypot(dx, dy);
}

/* ------------------------------------------------------------------------------------------ *
 * QuadEditor
 * ------------------------------------------------------------------------------------------ */

/**
 * @typedef {object} QuadEditorOptions
 * @property {CanvasImageSource} image          the working canvas (or any drawable source)
 * @property {number} imageWidth                working-image width in px
 * @property {number} imageHeight               working-image height in px
 * @property {Point[] | null} [points]          the four handles, image px
 * @property {string} [color]                   CSS colour of the quad overlay
 * @property {string[]} [labels]                one short label per handle
 * @property {string} [ariaLabel]               accessible name of the canvas
 * @property {{ points: Point[], color?: string } | null} [ghost]   second, non-editable outline
 * @property {(points: Point[], meta: { final: boolean, index: number | null }) => void} [onChange]
 *   final: false while a handle is being dragged; final: true once it has been let go somewhere
 *   new, and for every nudge. final: true always means the handle moved. A drag that leaves the
 *   handle where it started (a tap that wobbled, or the first finger of a pinch landing on it)
 *   never reports final: true; if it reported movement on the way, its last report is a
 *   final: false one showing the handle back in place.
 * @property {(imagePoint: Point) => void} [onTap]   a tap on the image that is not on a handle
 * @property {(index: number | null) => void} [onActiveChange]   the customer (not setActive) changed the active handle
 * @property {'corner' | 'center'} [pixelOrigin]
 *   What integer point coordinates address. 'corner' (default) is the canvas convention used by
 *   js/vision.js: pixel i covers [i, i + 1). Pass 'center' only for points produced by code in
 *   which integers are pixel centres; handles are then drawn half a pixel further right and down
 *   over the photo, so those points still land on the feature they describe.
 */

/**
 * Touch-first editor for the four corners of a quad drawn over a photo.
 *
 * Gestures: drag a handle (a loupe shows what is under the finger); pinch to zoom and pan with
 * two fingers; drag empty image with one finger to pan when zoomed in; tap empty image to fire
 * onTap; mouse wheel zooms. Keyboard: Tab / Shift+Tab step through the handles, arrows nudge the
 * active handle by 1 image px (Shift: 10), + / - / 0 zoom in / out / fit.
 */
export class QuadEditor {
  /**
   * @param {HTMLElement} container   element with a definite size; the canvas fills it
   * @param {QuadEditorOptions} opts
   */
  constructor(container, opts = {}) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('QuadEditor: a container element is required');
    }
    const doc = container.ownerDocument || globalThis.document;
    if (!doc) throw new TypeError('QuadEditor: no document available');
    // Everything environmental goes through the container's own window, which keeps the editor
    // correct inside iframes and lets tests drive it with a stand-in DOM.
    const win = doc.defaultView || globalThis;

    this._container = container;
    this._doc = doc;
    this._win = win;
    this._destroyed = false;

    const options = opts || {};
    const intrinsic = intrinsicSize(options.image);
    this._image = options.image || null;
    this._iw = Number(options.imageWidth) > 0 ? Number(options.imageWidth) : intrinsic.width || 1;
    this._ih = Number(options.imageHeight) > 0 ? Number(options.imageHeight) : intrinsic.height || 1;
    this._origin = options.pixelOrigin === 'center' ? 'center' : 'corner';
    // Bitmap position of point coordinate 0: half a pixel in when integers address pixel centres.
    this._offset = this._origin === 'center' ? 0.5 : 0;

    this._labels = Array.isArray(options.labels) ? options.labels.map((l) => (l == null ? '' : String(l))) : null;
    this._onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this._onTap = typeof options.onTap === 'function' ? options.onTap : null;
    this._onActiveChange = typeof options.onActiveChange === 'function' ? options.onActiveChange : null;

    this._points = null;
    this._active = null;
    this._ghost = null;
    this._colorInput = options.color;
    this._color = { css: DEFAULT_COLOR, casing: DARK_CASING };
    this._ghostColor = { css: DEFAULT_GHOST_COLOR, casing: DARK_CASING };
    this._font = `600 12px ${FALLBACK_FONT}`;
    this._stylesStale = true;

    this._view = { scale: 1, tx: 0, ty: 0 };
    this._vw = 0;
    this._vh = 0;
    this._rx = 1;
    this._ry = 1;
    this._pendingZoom = null;
    this._anim = null;
    this._raf = 0;

    // Gesture state machine: 'idle' | 'handle' | 'pan' | 'pinch'.
    this._mode = 'idle';
    this._pointers = new Map();
    this._drag = null;
    this._pan = null;
    this._pinch = null;

    this._loupeSide = null;
    this._loupeUntil = 0;
    this._loupeTimer = 0;
    this._focusVisible = false;
    this._positionChecked = false;
    this._positionSet = false;
    this._positionBefore = '';
    this._teardown = [];

    const canvas = doc.createElement('canvas');
    canvas.className = 'sm-quad-editor';
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    if (options.ariaLabel) canvas.setAttribute('aria-label', String(options.ariaLabel));
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      display: 'block',
      // The editor owns every gesture on the photo: no browser scroll, zoom, text selection,
      // callout menu or tap flash may compete with a thumb that is placing a corner.
      touchAction: 'none',
      userSelect: 'none',
      webkitUserSelect: 'none',
      webkitTouchCallout: 'none',
      webkitTapHighlightColor: 'transparent',
      // The focus ring is painted on the canvas itself (see _drawFocusRing): a CSS outline would
      // be clipped by the scroll container the editor normally sits in.
      outline: 'none',
      cursor: 'default',
    });
    this._canvas = canvas;
    this._ctx = null;
    try {
      this._ctx = canvas.getContext('2d');
    } catch {
      this._ctx = null;
    }

    // The loupe gets a small canvas of its own, stacked above the main one. Hosts float chips
    // and buttons over the top corners of the photo, which is exactly where the loupe lives; on
    // its own layer it covers them for the moment it is needed instead of hiding behind them.
    const loupe = doc.createElement('canvas');
    loupe.className = 'sm-quad-editor__loupe';
    loupe.setAttribute('aria-hidden', 'true');
    Object.assign(loupe.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'none',
      pointerEvents: 'none',
      zIndex: String(LOUPE_Z_INDEX),
    });
    this._loupeCanvas = loupe;
    this._loupeCtx = null;
    try {
      this._loupeCtx = loupe.getContext('2d');
    } catch {
      this._loupeCtx = null;
    }
    this._loupeShown = false;
    this._loupeBox = '';

    this._points = this._normalisePoints(options.points);
    this._ghost = this._normaliseGhost(options.ghost);

    container.appendChild(canvas);
    container.appendChild(loupe);

    this._listen(canvas, 'pointerdown', (e) => this._onPointerDown(e));
    this._listen(canvas, 'pointermove', (e) => this._onPointerMove(e));
    this._listen(canvas, 'pointerup', (e) => this._onPointerEnd(e, false));
    this._listen(canvas, 'pointercancel', (e) => this._onPointerEnd(e, true));
    this._listen(canvas, 'lostpointercapture', (e) => this._onLostCapture(e));
    this._listen(canvas, 'wheel', (e) => this._onWheel(e), { passive: false });
    this._listen(canvas, 'keydown', (e) => this._onKeyDown(e));
    this._listen(canvas, 'focus', () => this._onFocus());
    this._listen(canvas, 'blur', () => this._onBlur());
    this._listen(canvas, 'contextmenu', (e) => this._onContextMenu(e));
    // Belt and braces for Safari, which has ignored touch-action in places over the years.
    this._listen(canvas, 'touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    this._listen(canvas, 'gesturestart', (e) => e.preventDefault());
    // Catches devicePixelRatio changes (browser zoom, moving between monitors) that leave the
    // container's CSS size, and therefore the ResizeObserver, untouched.
    if (typeof win.addEventListener === 'function') this._listen(win, 'resize', () => this.resize());

    this._resizeObserver = null;
    if (typeof win.ResizeObserver === 'function') {
      this._resizeObserver = new win.ResizeObserver(() => this.resize());
      this._resizeObserver.observe(container);
    }

    this.resize();
  }

  /* ---------------------------------- public API ---------------------------------- */

  /**
   * Replace the four handles (image px) or remove them with null. Points are clamped to the
   * image. Does not fire onChange.
   * @param {Point[] | null} points
   */
  setPoints(points) {
    if (this._destroyed) return;
    this._points = this._normalisePoints(points);
    if (!this._points) {
      this._active = null;
      this._loupeUntil = 0;
      if (this._mode === 'handle') {
        this._drag = null;
        this._mode = 'idle';
      }
    } else if (this._mode === 'handle') {
      this._rebaseDrag(true);
    }
    this._requestDraw();
  }

  /**
   * @returns {Point[] | null} copies of the four handles in image px, or null when there are none
   */
  getPoints() {
    if (this._destroyed || !this._points) return null;
    return this._points.map((p) => ({ x: p.x, y: p.y }));
  }

  /**
   * Show (or with null, hide) a second, non-editable dashed outline.
   * @param {{ points: Point[], color?: string } | null} ghost
   */
  setGhost(ghost) {
    if (this._destroyed) return;
    this._ghost = this._normaliseGhost(ghost);
    this._stylesStale = true;
    this._requestDraw();
  }

  /**
   * Change the colour of the quad overlay (any CSS colour, including var(...)).
   * @param {string} color
   */
  setColor(color) {
    if (this._destroyed) return;
    this._colorInput = color;
    this._stylesStale = true;
    this._requestDraw();
  }

  /**
   * Make a handle the active one (highlighted; the target of nudge and the arrow keys), or none
   * with null. Out-of-range values are treated as null. Does not fire any callback.
   * @param {number | null} index
   */
  setActive(index) {
    if (this._destroyed) return;
    this._setActive(this._validIndex(index), false);
  }

  /**
   * @returns {number | null} index of the active handle
   */
  getActive() {
    return this._destroyed ? null : this._active;
  }

  /**
   * Move the active handle by image px. Fires onChange with final: true. Does nothing when
   * there are no points, no active handle, or the handle is already against the image edge.
   * @param {number} dx
   * @param {number} dy
   */
  nudge(dx, dy) {
    if (this._destroyed || !this._points || this._active == null) return;
    const stepX = Number(dx) || 0;
    const stepY = Number(dy) || 0;
    if (!stepX && !stepY) return;
    const index = this._active;
    const current = this._points[index];
    const next = clampPoint({ x: current.x + stepX, y: current.y + stepY }, this._iw, this._ih, this._origin);
    if (next.x === current.x && next.y === current.y) return;
    this._points[index] = next;
    this._rebaseDrag(true);
    this._keepHandleVisible(index);
    this._showLoupeBriefly();
    this._requestDraw();
    this._emitChange(true, index);
  }

  /**
   * Zoom so the quad fills the view with `padFrac` of its longer side as breathing room. Called
   * before the container has a size, it is applied as soon as it gets one.
   * @param {Point[]} quad   image px
   * @param {number} [padFrac]
   */
  zoomToQuad(quad, padFrac = 0.35) {
    if (this._destroyed) return;
    const points = toPoints(quad);
    if (!points) return;
    if (!(this._vw > 0 && this._vh > 0)) {
      this._pendingZoom = { points, padFrac };
      return;
    }
    this._animateTo(this._viewForQuad(points, padFrac));
  }

  /** Return to the view that shows the whole photo. */
  resetView() {
    if (this._destroyed) return;
    this._pendingZoom = null;
    if (!(this._vw > 0 && this._vh > 0)) return;
    this._animateTo(fitView(this._iw, this._ih, this._vw, this._vh));
  }

  /**
   * @returns {View} a copy of the current image -> canvas CSS px transform
   */
  getView() {
    return { scale: this._view.scale, tx: this._view.tx, ty: this._view.ty };
  }

  /**
   * Re-measure the container and redraw. Runs automatically when the container resizes; call it
   * by hand only after changing layout in a way a ResizeObserver cannot see.
   */
  resize() {
    if (this._destroyed) return;
    this._ensurePositioned();
    const width = Math.max(0, Math.floor(this._container.clientWidth || 0));
    const height = Math.max(0, Math.floor(this._container.clientHeight || 0));
    const store = backingStoreSize(width, height, Number(this._win.devicePixelRatio) || 1);
    const sizeChanged = width !== this._vw || height !== this._vh;
    const storeChanged = this._canvas.width !== store.width || this._canvas.height !== store.height;
    if (!sizeChanged && !storeChanged) {
      this._requestDraw();
      return;
    }

    if (this._anim) {
      this._view = this._anim.target;
      this._cancelAnimation();
    }
    const prevW = this._vw;
    const prevH = this._vh;
    const prevView = this._view;
    this._vw = width;
    this._vh = height;
    if (storeChanged) {
      this._canvas.width = store.width;
      this._canvas.height = store.height;
    }
    if (!(width > 0 && height > 0)) return;
    this._rx = store.width / width;
    this._ry = store.height / height;
    this._stylesStale = true;

    if (this._pendingZoom) {
      this._view = this._viewForQuad(this._pendingZoom.points, this._pendingZoom.padFrac);
      this._pendingZoom = null;
    } else if (!(prevW > 0 && prevH > 0) || viewsEqual(prevView, fitView(this._iw, this._ih, prevW, prevH))) {
      this._view = fitView(this._iw, this._ih, width, height);
    } else {
      // Zoomed in: keep the same zoom and the same image point in the middle of the screen.
      const centre = screenToImage(prevView, { x: prevW / 2, y: prevH / 2 });
      this._view = this._clampedView({
        scale: prevView.scale,
        tx: width / 2 - centre.x * prevView.scale,
        ty: height / 2 - centre.y * prevView.scale,
      });
    }
    this._rebaseDrag();
    // A resize clears the canvas, so paint in the same frame rather than waiting for the next.
    this._drawNow();
  }

  /** Release every listener, observer, timer and animation frame and remove the canvases. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._cancelAnimation();
    if (this._raf) {
      this._win.cancelAnimationFrame?.(this._raf);
      this._raf = 0;
    }
    if (this._loupeTimer) {
      this._win.clearTimeout(this._loupeTimer);
      this._loupeTimer = 0;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    for (const off of this._teardown) off();
    this._teardown.length = 0;
    for (const id of this._pointers.keys()) this._releaseCapture(id);
    this._pointers.clear();
    this._mode = 'idle';
    this._drag = null;
    this._pan = null;
    this._pinch = null;

    for (const canvas of [this._canvas, this._loupeCanvas]) {
      if (typeof canvas.remove === 'function') canvas.remove();
      else if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
    if (this._positionSet) this._container.style.position = this._positionBefore;

    this._image = null;
    this._points = null;
    this._ghost = null;
    this._active = null;
    this._onChange = null;
    this._onTap = null;
    this._onActiveChange = null;
    this._ctx = null;
    this._loupeCtx = null;
  }

  /* ---------------------------------- state helpers ---------------------------------- */

  _listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._teardown.push(() => target.removeEventListener(type, handler, options));
  }

  _normalisePoints(points) {
    const copy = toPoints(points);
    return copy ? copy.map((p) => clampPoint(p, this._iw, this._ih, this._origin)) : null;
  }

  _normaliseGhost(ghost) {
    const points = ghost ? toPoints(ghost.points) : null;
    return points ? { points, color: ghost.color } : null;
  }

  _validIndex(index) {
    return this._points && Number.isInteger(index) && index >= 0 && index < this._points.length ? index : null;
  }

  _setActive(index, byUser) {
    if (index === this._active) return;
    this._active = index;
    this._loupeUntil = 0;
    this._requestDraw();
    if (byUser && this._onActiveChange) this._onActiveChange(index);
  }

  _emitChange(final, index) {
    if (this._onChange && this._points) this._onChange(this.getPoints(), { final, index });
  }

  /** The view for point coordinates (half a pixel off the bitmap view when pixelOrigin is 'center'). */
  _pointView() {
    return shiftView(this._view, this._offset);
  }

  _limits() {
    return scaleLimits(this._iw, this._ih, this._vw, this._vh);
  }

  _clampedView(view) {
    return clampView(view, this._iw, this._ih, this._vw, this._vh, {
      overscrollPx: Math.min(this._vw, this._vh) * OVERSCROLL_FRAC,
    });
  }

  _setView(view) {
    this._view = this._clampedView(view);
    this._rebaseDrag();
    this._requestDraw();
  }

  _viewForQuad(points, padFrac) {
    return viewForQuad(points, padFrac, this._iw, this._ih, this._vw, this._vh, {
      overscrollPx: Math.min(this._vw, this._vh) * OVERSCROLL_FRAC,
      pixelOffset: this._offset,
    });
  }

  /** Image point (point coordinates) under a screen position, or null when it is off the photo. */
  _imagePointAt(pos) {
    const b = screenToImage(this._view, pos);
    if (b.x < 0 || b.y < 0 || b.x > this._iw || b.y > this._ih) return null;
    return clampPoint({ x: b.x - this._offset, y: b.y - this._offset }, this._iw, this._ih, this._origin);
  }

  /**
   * Re-measure the grab offset of a handle drag. Needed whenever something other than the
   * dragging finger moves the handle on screen (zoom, resize, setPoints, nudge), otherwise the
   * handle would jump on the next pointer move.
   * @param {boolean} [placed]   true when the host has just placed the handles (setPoints) or been
   *   told for good where they are (nudge): the drag then counts as starting from there, which is
   *   where _endDrag looks for movement and where a pinch start puts the handle back.
   */
  _rebaseDrag(placed = false) {
    const drag = this._drag;
    if (this._mode !== 'handle' || !drag || !this._points) return;
    const point = this._points[drag.index];
    const handle = imageToScreen(this._pointView(), point);
    drag.offset = { x: handle.x - drag.finger.x, y: handle.y - drag.finger.y };
    drag.trail.length = 0;
    if (placed) drag.origin = { x: point.x, y: point.y };
  }

  _keepHandleVisible(index) {
    if (!this._points || !(this._vw > 0 && this._vh > 0)) return;
    const s = imageToScreen(this._pointView(), this._points[index]);
    const margin = Math.min(48, this._vw / 4, this._vh / 4);
    const moved = this._clampedView(ensureVisible(this._view, s, this._vw, this._vh, margin));
    if (!viewsEqual(moved, this._view, 1e-6)) {
      this._cancelAnimation();
      this._view = moved;
      this._rebaseDrag();
    }
  }

  _showLoupeBriefly() {
    this._loupeUntil = this._now() + NUDGE_LOUPE_MS;
    if (this._loupeTimer) this._win.clearTimeout(this._loupeTimer);
    this._loupeTimer = this._win.setTimeout(() => {
      this._loupeTimer = 0;
      this._loupeUntil = 0;
      this._requestDraw();
    }, NUDGE_LOUPE_MS);
  }

  _now() {
    const perf = this._win.performance;
    return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
  }

  _prefersReducedMotion() {
    try {
      return !!this._win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  _ensurePositioned() {
    if (this._positionChecked || this._container.isConnected === false) return;
    this._positionChecked = true;
    let position = '';
    try {
      position = this._win.getComputedStyle(this._container).position;
    } catch {
      position = '';
    }
    if (position === 'static') {
      this._positionBefore = this._container.style.position;
      this._container.style.position = 'relative';
      this._positionSet = true;
    }
  }

  /** Canvas cannot paint var(...) or currentColor, and needs RGB to pick a casing: let the browser compute it. */
  _resolveColor(input, fallback) {
    const raw = typeof input === 'string' && input.trim() ? input.trim() : fallback;
    let rgb = parseCssColor(raw);
    let css = raw;
    if (!rgb) {
      try {
        const style = this._canvas.style;
        const before = style.color;
        style.color = raw;
        const computed = this._win.getComputedStyle(this._canvas).color;
        style.color = before;
        if (computed) {
          css = computed;
          rgb = parseCssColor(computed);
        } else if (/var\(|currentcolor/i.test(raw)) {
          // Not attached to the document yet, so the browser cannot say: try again on the next
          // resize and use the fallback meanwhile.
          css = fallback;
          rgb = parseCssColor(fallback);
          this._stylesStale = true;
        }
      } catch {
        css = fallback;
        rgb = parseCssColor(fallback);
      }
    }
    return { css, casing: casingFor(rgb) };
  }

  _refreshStyles() {
    this._stylesStale = false;
    this._color = this._resolveColor(this._colorInput, DEFAULT_COLOR);
    this._ghostColor = this._resolveColor(this._ghost && this._ghost.color, DEFAULT_GHOST_COLOR);
    let family = '';
    try {
      family = this._win.getComputedStyle(this._canvas).fontFamily || '';
    } catch {
      family = '';
    }
    this._font = `600 12px ${family || FALLBACK_FONT}`;
  }

  /* ---------------------------------- view animation ---------------------------------- */

  _animateTo(target, durationMs = ZOOM_ANIMATION_MS) {
    this._cancelAnimation();
    const from = this._view;
    const raf = this._win.requestAnimationFrame;
    if (durationMs <= 0 || typeof raf !== 'function' || viewsEqual(from, target, 1e-6) || this._prefersReducedMotion()) {
      this._view = target;
      this._rebaseDrag();
      this._requestDraw();
      return;
    }
    const start = this._now();
    const anim = { target, raf: 0 };
    const step = () => {
      anim.raf = 0;
      if (this._destroyed || this._anim !== anim) return;
      const t = clamp((this._now() - start) / durationMs, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this._view = t >= 1 ? target : lerpView(from, target, eased, this._vw, this._vh);
      if (t >= 1) this._anim = null;
      else anim.raf = this._win.requestAnimationFrame(step);
      this._rebaseDrag();
      this._drawNow();
    };
    this._anim = anim;
    anim.raf = this._win.requestAnimationFrame(step);
  }

  _cancelAnimation() {
    if (!this._anim) return;
    if (this._anim.raf) this._win.cancelAnimationFrame?.(this._anim.raf);
    this._anim = null;
  }

  _zoomBy(factor) {
    if (!(this._vw > 0 && this._vh > 0)) return;
    let anchor = { x: this._vw / 2, y: this._vh / 2 };
    if (this._points && this._active != null) {
      const s = imageToScreen(this._pointView(), this._points[this._active]);
      if (s.x >= 0 && s.y >= 0 && s.x <= this._vw && s.y <= this._vh) anchor = s;
    }
    const base = this._anim ? this._anim.target : this._view;
    this._animateTo(this._clampedView(zoomAt(base, anchor, factor, this._limits())), 140);
  }

  /* ---------------------------------- pointer gestures ---------------------------------- */

  _pos(e) {
    const rect = this._canvas.getBoundingClientRect();
    const kx = rect.width > 0 ? this._vw / rect.width : 1;
    const ky = rect.height > 0 ? this._vh / rect.height : 1;
    return { x: (e.clientX - rect.left) * kx, y: (e.clientY - rect.top) * ky };
  }

  _time(e) {
    return Number.isFinite(e.timeStamp) ? e.timeStamp : this._now();
  }

  _releaseCapture(pointerId) {
    try {
      const canvas = this._canvas;
      if (typeof canvas.hasPointerCapture !== 'function' || canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture?.(pointerId);
      }
    } catch {
      // The pointer is already gone: nothing to release.
    }
  }

  _onPointerDown(e) {
    if (this._destroyed || !(this._vw > 0 && this._vh > 0)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A press from a pointer that never reported its release: finish the old gesture first, so a
    // drag that reported live changes still gets its final one.
    if (this._pointers.has(e.pointerId)) this._onPointerEnd(e, true);
    // The primary touch is by definition the only finger on the glass, so any pointer still on
    // the books has lost its release event. Without this a stale entry would turn every later
    // one-finger drag into half of a phantom pinch.
    if (e.isPrimary === true && e.pointerType === 'touch') {
      for (const id of [...this._pointers.keys()]) {
        this._onPointerEnd({ pointerId: id, timeStamp: e.timeStamp }, true);
      }
    }
    // Two fingers are all the editor understands; a third is ignored from start to finish.
    if (this._pointers.size >= 2) return;

    const pos = this._pos(e);
    this._pointers.set(e.pointerId, pos);
    try {
      this._canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is a nicety (keeps a drag alive outside the canvas); carry on without it.
    }
    this._cancelAnimation();
    this._focusVisible = false;

    let ended = null;
    let activated = null;
    if (this._pointers.size === 1) {
      const pv = this._pointView();
      const hit = hitTestHandle(this._points, pos, pv, HANDLE_HIT_RADIUS_PX);
      if (hit >= 0) {
        const handle = imageToScreen(pv, this._points[hit]);
        this._mode = 'handle';
        this._drag = {
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          index: hit,
          // Finger-to-handle offset at the moment of the grab: kept for the whole drag so the
          // handle never jumps to sit under the finger.
          offset: { x: handle.x - pos.x, y: handle.y - pos.y },
          start: pos,
          startTime: this._time(e),
          finger: pos,
          moved: false,
          // Dead zone so that tapping a handle to select it cannot shift it.
          slop: e.pointerType === 'touch' ? 4 : 2,
          trail: [],
          // Where the handle was when it was grabbed, and whether onChange has been told it moved:
          // together they decide what, if anything, the end of the drag reports (see _endDrag).
          origin: { x: this._points[hit].x, y: this._points[hit].y },
          reported: false,
        };
        this._loupeSide = null;
        if (this._active !== hit) activated = hit;
        this._active = hit;
        this._loupeUntil = 0;
      } else {
        this._mode = 'pan';
        this._pan = { pointerId: e.pointerId, start: pos, last: pos, startTime: this._time(e), moved: false };
      }
    } else {
      // A second finger: whatever the first was doing ends here and the pair becomes a pinch.
      if (this._mode === 'handle') {
        const drag = this._drag;
        // The first finger of a pinch often lands on a handle and slides it before the second one
        // arrives. That was never a drag: put the handle back instead of keeping the slide.
        if (drag && this._points && isPinchStart(distance(drag.finger, drag.start), this._time(e) - drag.startTime)) {
          this._points[drag.index] = { x: drag.origin.x, y: drag.origin.y };
        }
        ended = this._endDrag();
      }
      this._pan = null;
      this._startPinch();
    }

    this._updateCursor(pos);
    this._requestDraw();
    if (activated != null && this._onActiveChange) this._onActiveChange(activated);
    if (ended) this._emitChange(ended.final, ended.index);
  }

  _onPointerMove(e) {
    if (this._destroyed) return;
    const pos = this._pos(e);
    if (!this._pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') this._updateCursor(pos);
      return;
    }
    this._pointers.set(e.pointerId, pos);

    if (this._mode === 'handle' && this._drag && this._drag.pointerId === e.pointerId) {
      this._moveHandle(pos, this._time(e));
    } else if (this._mode === 'pan' && this._pan && this._pan.pointerId === e.pointerId) {
      const pan = this._pan;
      if (!pan.moved) {
        if (distance(pos, pan.start) <= TAP_SLOP_PX) return;
        pan.moved = true;
        pan.last = pos;
        this._updateCursor(pos);
        return;
      }
      const dx = pos.x - pan.last.x;
      const dy = pos.y - pan.last.y;
      pan.last = pos;
      this._setView(panBy(this._view, dx, dy));
    } else if (this._mode === 'pinch' && this._pinch && this._pinch.ids.includes(e.pointerId)) {
      const pinch = this._pinch;
      const a = this._pointers.get(pinch.ids[0]);
      const b = this._pointers.get(pinch.ids[1]);
      const next = pinchView(this._view, pinch.a, pinch.b, a, b, this._limits());
      pinch.a = a;
      pinch.b = b;
      this._setView(next);
    }
  }

  _moveHandle(pos, time) {
    const drag = this._drag;
    const pv = this._pointView();
    drag.finger = pos;
    if (!drag.moved) {
      if (distance(pos, drag.start) <= drag.slop) return;
      drag.moved = true;
      // Leaving the dead zone: start tracking from where the finger is now, so the handle sets
      // off from rest instead of jumping by the width of the dead zone.
      const handle = imageToScreen(pv, this._points[drag.index]);
      drag.offset = { x: handle.x - pos.x, y: handle.y - pos.y };
      drag.trail.push({ t: time, point: { ...this._points[drag.index] }, sx: pos.x, sy: pos.y });
      this._requestDraw();
      return;
    }
    const target = screenToImage(pv, { x: pos.x + drag.offset.x, y: pos.y + drag.offset.y });
    const next = clampPoint(target, this._iw, this._ih, this._origin);
    const current = this._points[drag.index];
    const changed = next.x !== current.x || next.y !== current.y;
    if (changed) this._points[drag.index] = next;

    const trail = drag.trail;
    trail.push({ t: time, point: { x: next.x, y: next.y }, sx: pos.x, sy: pos.y });
    // Keep one sample from before the settling window plus everything newer.
    while (trail.length > 2 && trail[1].t <= time - 250) trail.shift();

    this._requestDraw();
    if (changed) {
      drag.reported = true;
      this._emitChange(false, drag.index);
    }
  }

  /**
   * Leave handle-drag mode and say what onChange is owed:
   *  - a final change when the handle ended somewhere other than where the drag found it;
   *  - a last non-final one when it is back where it was but onChange saw it move on the way
   *    (lift-off jitter taken back out, or a pinch start undone), so listeners see it return and
   *    nothing is committed;
   *  - nothing when it never moved (a press that only left the dead zone).
   * @returns {{ index: number, final: boolean } | null}
   */
  _endDrag() {
    const drag = this._drag;
    this._drag = null;
    this._mode = 'idle';
    this._loupeSide = null;
    if (!drag || !this._points) return null;
    const point = this._points[drag.index];
    if (point.x !== drag.origin.x || point.y !== drag.origin.y) return { index: drag.index, final: true };
    return drag.reported ? { index: drag.index, final: false } : null;
  }

  _startPinch() {
    const ids = [...this._pointers.keys()].slice(0, 2);
    this._mode = 'pinch';
    this._pinch = { ids, a: this._pointers.get(ids[0]), b: this._pointers.get(ids[1]) };
  }

  _onPointerEnd(e, cancelled) {
    if (this._destroyed || !this._pointers.has(e.pointerId)) return;
    const pos = cancelled ? this._pointers.get(e.pointerId) : this._pos(e);
    this._pointers.delete(e.pointerId);
    this._releaseCapture(e.pointerId);

    let ended = null;
    let tapPoint = null;
    if (this._mode === 'handle' && this._drag && this._drag.pointerId === e.pointerId) {
      const drag = this._drag;
      if (drag.moved && !cancelled && drag.pointerType === 'touch' && this._points) {
        const settled = settledPoint(drag.trail, this._time(e));
        if (settled) this._points[drag.index] = clampPoint(settled, this._iw, this._ih, this._origin);
      }
      ended = this._endDrag();
    } else if (this._mode === 'pan' && this._pan && this._pan.pointerId === e.pointerId) {
      const pan = this._pan;
      this._pan = null;
      this._mode = 'idle';
      if (!cancelled && !pan.moved && isTap(distance(pos, pan.start), this._time(e) - pan.startTime)) {
        tapPoint = this._imagePointAt(pan.start);
      }
    } else if (this._mode === 'pinch' && this._pinch && this._pinch.ids.includes(e.pointerId)) {
      this._pinch = null;
      const rest = this._pointers.entries().next();
      if (!rest.done) {
        // One finger stays down after a pinch: let it carry on panning (never a tap).
        const [pointerId, p] = rest.value;
        this._mode = 'pan';
        this._pan = { pointerId, start: p, last: p, startTime: -Infinity, moved: true };
      } else {
        this._mode = 'idle';
      }
    }

    this._updateCursor(pos);
    this._requestDraw();
    if (ended) this._emitChange(ended.final, ended.index);
    if (tapPoint && this._onTap) this._onTap(tapPoint);
  }

  _onLostCapture(e) {
    // After a normal pointerup the pointer is already forgotten and this is a no-op. If capture
    // is lost while the pointer is still tracked, the browser took the gesture away: cancel.
    if (this._pointers.has(e.pointerId)) this._onPointerEnd(e, true);
  }

  _onWheel(e) {
    if (this._destroyed || !(this._vw > 0 && this._vh > 0)) return;
    e.preventDefault();
    this._cancelAnimation();
    const factor = wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey);
    this._setView(zoomAt(this._view, this._pos(e), factor, this._limits()));
  }

  _onContextMenu(e) {
    // A long press must not pop a menu in the middle of placing a corner.
    if (this._pointers.size > 0 || (e.pointerType && e.pointerType !== 'mouse')) e.preventDefault();
  }

  _updateCursor(pos) {
    let cursor;
    if (this._mode === 'handle' || this._mode === 'pinch' || (this._mode === 'pan' && this._pan && this._pan.moved)) {
      cursor = 'grabbing';
    } else if (hitTestHandle(this._points, pos, this._pointView(), HANDLE_HIT_RADIUS_PX) >= 0) {
      cursor = 'grab';
    } else {
      cursor = this._onTap ? 'crosshair' : 'default';
    }
    if (this._canvas.style.cursor !== cursor) this._canvas.style.cursor = cursor;
  }

  /* ---------------------------------- keyboard ---------------------------------- */

  _onKeyDown(e) {
    if (this._destroyed || e.altKey || e.ctrlKey || e.metaKey) return;
    const points = this._points;
    switch (e.key) {
      case 'Tab': {
        if (!points || this._active == null) return;
        const next = nextTabIndex(this._active, points.length, !!e.shiftKey);
        if (next == null) return; // past the last / first handle: let focus leave the canvas
        e.preventDefault();
        this._focusVisible = true;
        this._setActive(next, true);
        this._keepHandleVisible(next);
        this._requestDraw();
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!points) return;
        e.preventDefault();
        this._focusVisible = true;
        if (this._active == null) {
          this._setActive(0, true);
          this._keepHandleVisible(0);
          this._requestDraw();
          return;
        }
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        this._requestDraw();
        this.nudge(dx, dy);
        return;
      }
      case '+':
      case '=':
        e.preventDefault();
        this._zoomBy(1.5);
        return;
      case '-':
      case '_':
        e.preventDefault();
        this._zoomBy(1 / 1.5);
        return;
      case '0':
        e.preventDefault();
        this.resetView();
        return;
      default:
    }
  }

  _onFocus() {
    if (this._destroyed) return;
    let visible = false;
    try {
      visible = !!this._canvas.matches?.(':focus-visible');
    } catch {
      visible = false;
    }
    this._focusVisible = visible;
    // Arriving by keyboard: select the first handle so the arrow keys work straight away.
    if (visible && this._points && this._active == null) this._setActive(0, true);
    this._requestDraw();
  }

  _onBlur() {
    if (this._destroyed) return;
    this._focusVisible = false;
    this._requestDraw();
  }

  /* ---------------------------------- rendering ---------------------------------- */

  _requestDraw() {
    if (this._destroyed || this._raf) return;
    if (typeof this._win.requestAnimationFrame !== 'function') {
      this._draw();
      return;
    }
    this._raf = this._win.requestAnimationFrame(() => {
      this._raf = 0;
      this._draw();
    });
  }

  _drawNow() {
    if (this._raf) {
      this._win.cancelAnimationFrame?.(this._raf);
      this._raf = 0;
    }
    this._draw();
  }

  _draw() {
    const ctx = this._ctx;
    if (this._destroyed || !ctx || !(this._vw > 0 && this._vh > 0)) return;
    if (this._stylesStale) this._refreshStyles();

    ctx.setTransform(this._rx, 0, 0, this._ry, 0, 0);
    ctx.clearRect(0, 0, this._vw, this._vh);
    this._drawImage(ctx);

    const pv = this._pointView();
    if (this._ghost) {
      const pts = this._ghost.points.map((p) => imageToScreen(pv, p));
      this._strokeOutline(ctx, pts, outlineOrder(pts), null, this._ghostColor, {
        dash: [7, 5], width: 1.5, casingWidth: 3.5,
      });
    }

    if (this._points) {
      const pts = this._points.map((p) => imageToScreen(pv, p));
      const order = outlineOrder(pts);
      const radii = pts.map((_, i) => (i === this._active ? 14 : 11));

      // Very light interior tint: enough to see which area is selected, not enough to hide it.
      ctx.beginPath();
      order.forEach((i, k) => (k === 0 ? ctx.moveTo(pts[i].x, pts[i].y) : ctx.lineTo(pts[i].x, pts[i].y)));
      ctx.closePath();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = this._color.css;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Edges stop at the handle rings so the corner itself is never painted over.
      this._strokeOutline(ctx, pts, order, radii, this._color, { dash: null, width: 1.75, casingWidth: 4 });
      const dragging = this._mode === 'handle' && this._drag ? this._drag.index : -1;
      pts.forEach((s, i) => this._drawHandle(ctx, s, radii[i], i === this._active));
      this._drawLabels(ctx, pts, radii, dragging);
    }

    if (this._focusVisible) this._drawFocusRing(ctx);

    const loupe = this._loupeTarget(pv);
    if (loupe) this._drawLoupe(loupe.index, loupe.finger);
    else this._hideLoupe();
  }

  _drawImage(ctx) {
    const image = this._image;
    if (!image) return;
    const view = this._view;
    const rect = visibleImageRect(view, this._iw, this._ih, this._vw, this._vh);
    if (!rect) return;
    const size = intrinsicSize(image);
    const kx = size.width > 0 ? size.width / this._iw : 1;
    const ky = size.height > 0 ? size.height / this._ih : 1;
    // Smooth while the photo is shrunk or mildly enlarged; honest hard pixels once each image
    // pixel is big enough to aim at.
    ctx.imageSmoothingEnabled = view.scale < 3;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(
        image,
        rect.x * kx, rect.y * ky, rect.width * kx, rect.height * ky,
        rect.x * view.scale + view.tx, rect.y * view.scale + view.ty,
        rect.width * view.scale, rect.height * view.scale,
      );
    } catch {
      // A source that is not drawable (yet) leaves the photo area empty; the overlay still works.
    }
  }

  /**
   * Stroke the closed outline twice: a wide casing, then the coloured line on top.
   * `gaps` (per-point radii) leaves the area around each handle clear.
   */
  _strokeOutline(ctx, pts, order, gaps, color, { dash, width, casingWidth }) {
    const n = order.length;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const ia = order[k];
      const ib = order[(k + 1) % n];
      const a = pts[ia];
      const b = pts[ib];
      const len = distance(a, b);
      const ga = gaps ? gaps[ia] : 0;
      const gb = gaps ? gaps[ib] : 0;
      if (!(len > ga + gb + 0.5)) continue;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      ctx.moveTo(a.x + ux * ga, a.y + uy * ga);
      ctx.lineTo(b.x - ux * gb, b.y - uy * gb);
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = dash ? 'butt' : 'round';
    ctx.setLineDash(dash || []);
    ctx.lineWidth = casingWidth;
    ctx.strokeStyle = color.casing;
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = color.css;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawHandle(ctx, s, radius, active) {
    const { css, casing } = this._color;
    if (active) {
      // Second, fainter ring marks the active handle without tinting the pixels at the corner.
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius + 6, 0, TAU);
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = casing;
      ctx.stroke();
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = css;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, TAU);
    ctx.lineWidth = active ? 5.5 : 4.5;
    ctx.strokeStyle = casing;
    ctx.stroke();
    ctx.lineWidth = active ? 3 : 2;
    ctx.strokeStyle = css;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, TAU);
    ctx.fillStyle = casing;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.5, 0, TAU);
    ctx.fillStyle = css;
    ctx.fill();
  }

  _drawLabels(ctx, pts, radii, skipIndex) {
    const labels = this._labels;
    if (!labels) return;
    // Handles packed tightly together (a small sheet at fit zoom) leave no room for words.
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (distance(pts[i], pts[j]) < 64) return;
      }
    }
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x / pts.length;
      cy += p.y / pts.length;
    }
    ctx.font = this._font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const height = 22;
    for (let i = 0; i < pts.length; i++) {
      const text = labels[i];
      if (!text || i === skipIndex) continue;
      const s = pts[i];
      if (s.x < -20 || s.y < -20 || s.x > this._vw + 20 || s.y > this._vh + 20) continue;
      const width = Math.ceil(ctx.measureText(text).width) + 16;
      let dx = s.x - cx;
      let dy = s.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const reach = radii[i] + 8 + (Math.abs(dx) * width + Math.abs(dy) * height) / 2;
      // Preferred spot is outside the quad; if the screen edge pushes the pill back over the
      // handle, try the inside, and failing that leave the label off rather than hide the corner.
      let placed = null;
      for (const sign of [1, -1]) {
        const x = clamp(s.x + sign * dx * reach - width / 2, 4, Math.max(4, this._vw - width - 4));
        const y = clamp(s.y + sign * dy * reach - height / 2, 4, Math.max(4, this._vh - height - 4));
        if (rectDistance(s, x, y, width, height) >= radii[i] + 4) {
          placed = { x, y };
          break;
        }
      }
      if (!placed) continue;
      roundRectPath(ctx, placed.x, placed.y, width, height, height / 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, placed.x + width / 2, placed.y + height / 2 + 0.5);
    }
  }

  /** Which handle the loupe should magnify right now, and where the finger (or handle) is. */
  _loupeTarget(pv) {
    if (!this._points) return null;
    if (this._mode === 'handle' && this._drag) {
      return { index: this._drag.index, finger: this._drag.finger };
    }
    if (this._active != null && this._loupeUntil > 0 && this._now() < this._loupeUntil) {
      return { index: this._active, finger: imageToScreen(pv, this._points[this._active]) };
    }
    return null;
  }

  _hideLoupe() {
    if (!this._loupeShown) return;
    this._loupeShown = false;
    this._loupeSide = null;
    this._loupeCanvas.style.display = 'none';
  }

  /** Paint the loupe layer and move it to the top corner away from the finger. */
  _drawLoupe(index, finger) {
    const ctx = this._loupeCtx;
    if (!ctx) return;
    const el = this._loupeCanvas;
    const spot = loupeCorner(finger, this._vw, this._vh, { previousSide: this._loupeSide });
    this._loupeSide = spot.side;
    const radius = spot.radius;

    // The layer is the loupe plus a border wide enough for its rim and soft shadow.
    const pad = LOUPE_MARGIN_PX;
    const size = 2 * (radius + pad);
    const store = Math.max(1, Math.round(size * this._rx));
    if (el.width !== store || el.height !== store) {
      el.width = store;
      el.height = store;
    }
    const left = spot.cx - radius - pad;
    const top = spot.cy - radius - pad;
    const box = `${left},${top},${size}`;
    if (box !== this._loupeBox) {
      this._loupeBox = box;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
    }
    if (!this._loupeShown) {
      this._loupeShown = true;
      el.style.display = 'block';
    }

    const cx = size / 2;
    const cy = size / 2;
    const zoom = loupeScale(this._view.scale);
    const p = this._points[index];
    const bx = p.x + this._offset;
    const by = p.y + this._offset;

    ctx.setTransform(store / size, 0, 0, store / size, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 9;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = LOUPE_BACKDROP;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.clip();

    const image = this._image;
    if (image) {
      const half = radius / zoom;
      const x0 = clamp(Math.floor(bx - half), 0, this._iw);
      const x1 = clamp(Math.ceil(bx + half), 0, this._iw);
      const y0 = clamp(Math.floor(by - half), 0, this._ih);
      const y1 = clamp(Math.ceil(by + half), 0, this._ih);
      if (x1 > x0 && y1 > y0) {
        const size = intrinsicSize(image);
        const kx = size.width > 0 ? size.width / this._iw : 1;
        const ky = size.height > 0 ? size.height / this._ih : 1;
        // Hard pixel edges: the customer is aiming at individual pixels here.
        ctx.imageSmoothingEnabled = false;
        try {
          ctx.drawImage(
            image,
            x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky,
            cx + (x0 - bx) * zoom, cy + (y0 - by) * zoom, (x1 - x0) * zoom, (y1 - y0) * zoom,
          );
        } catch {
          // Not drawable: the dark backdrop and crosshair still show.
        }
      }
    }

    // Two-tone crosshair with an open centre, so the exact target pixel stays visible and the
    // lines read on both light and dark surroundings.
    const inner = 6;
    const outer = Math.max(inner + 4, radius - 8);
    ctx.beginPath();
    ctx.moveTo(cx - outer, cy);
    ctx.lineTo(cx - inner, cy);
    ctx.moveTo(cx + inner, cy);
    ctx.lineTo(cx + outer, cy);
    ctx.moveTo(cx, cy - outer);
    ctx.lineTo(cx, cy - inner);
    ctx.moveTo(cx, cy + inner);
    ctx.lineTo(cx, cy + outer);
    ctx.lineCap = 'butt';
    ctx.setLineDash([]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.75, 0, TAU);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 0.9, 0, TAU);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 2, 0, TAU);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.stroke();
  }

  _drawFocusRing(ctx) {
    const w = this._vw;
    const h = this._vh;
    ctx.setLineDash([]);
    ctx.lineJoin = 'miter';
    ctx.lineWidth = 5;
    ctx.strokeStyle = this._color.casing;
    ctx.strokeRect(2.5, 2.5, w - 5, h - 5);
    ctx.lineWidth = 3;
    ctx.strokeStyle = this._color.css;
    ctx.strokeRect(2.5, 2.5, w - 5, h - 5);
  }
}
