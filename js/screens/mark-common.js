/**
 * Shared pieces of the two "mark" screens (sheet and door): the flush layout
 * (banner, photo stage, action bar), the floating nudge pad and Fit button,
 * hold-to-repeat, and the QuadEditor lifecycle. It also holds the door screen's
 * small decisions (what its banner says, when its corners count as placed, the
 * "next outline" cycle), as pure functions so they are tested in Node.
 *
 * This module holds no user-visible copy. Each screen passes its own
 * translated labels in, so every string stays under that screen's `strings`.
 */

import { QuadEditor, outlineOrder } from '../editor.js';

const HOLD_DELAY_MS = 350;
const HOLD_INTERVAL_MS = 80;
// A press that ends without a click (the finger slid off the button) must not
// swallow a later keyboard click, so the "pointer already handled it" flag expires.
const CLICK_GUARD_MS = 600;
const MAX_LAYOUT_WAIT_FRAMES = 30;
const FALLBACK_SHEET_RATIO = 297 / 210;
// Limits for believing a detected outline is the chosen reference (see sheetOutlineIsPlausible).
const SHEET_SHAPE_TOLERANCE = 1.35;
const SHEET_SIZE_ALLOWANCE = 1.3;
// A door filling under 30% of the photo's long side is too small to measure from in any case.
const SHEET_MIN_DOOR_SPAN = 0.3;
const FALLBACK_DOOR_HEIGHT_MM = { min: 1500, max: 2800 };
// detectSheet's confidence below which even a sub-pixel outline is only a suggestion. A clean sheet
// scores above about 0.9; 0.5 is what is left when the worst side is ragged or thinly supported.
const SHEET_FOUND_CONFIDENCE = 0.7;
// zoomToQuad / resetView animate for about 220 ms and the editor has no "view
// settled" callback, so the nudge pad is placed again once the photo is at rest.
const VIEW_SETTLE_MS = 300;
// Same as the editor's grab radius: with this much room around a handle, every
// press that would grab it lands on the photo rather than on the pad.
const PAD_CLEARANCE_PX = 28;
// The pad as a strip is four 44 px arrows tall. A stage shorter than this (a
// phone on its side) cannot hold it below the chips, so the pad stays a cross.
const PAD_STRIP_MIN_STAGE_PX = 260;
// Where the nudge pad may float, in order of preference: bottom-left,
// bottom-right, then half-way up either side (see mark.css).
const PAD_PLACEMENTS = [
  { flip: false, mid: false },
  { flip: true, mid: false },
  { flip: false, mid: true },
  { flip: true, mid: true },
];

const NUDGES = [
  { dir: 'up', icon: 'arrow-up', dx: 0, dy: -1 },
  { dir: 'left', icon: 'arrow-left', dx: -1, dy: 0 },
  { dir: 'right', icon: 'arrow-right', dx: 1, dy: 0 },
  { dir: 'down', icon: 'arrow-down', dx: 0, dy: 1 },
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * @typedef {{ x: number, y: number }} Point
 */

/**
 * Read a theme colour from the CSS custom properties set by applyTheme.
 * @param {string} name Custom property name, e.g. '--sm-accent'.
 * @param {string} fallback Used when the property is empty or there is no DOM.
 * @returns {string}
 */
export function themeColor(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Detached copy of a list of points, so state and the editor never share objects.
 * @param {Point[]} points
 * @returns {Point[]}
 */
export function copyQuad(points) {
  return points.map((p) => ({ x: p.x, y: p.y }));
}

/**
 * True for an array of exactly four finite points.
 * @param {unknown} points
 * @returns {boolean}
 */
export function isQuad(points) {
  return (
    Array.isArray(points) &&
    points.length === 4 &&
    points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
  );
}

/**
 * True when two quads have the same four points in the same order. The screens use this so that a
 * "final" change leaving every handle exactly where it was never counts as an edit (js/editor.js
 * only reports one after a real move, and this keeps the screens right whatever it reports).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameQuad(a, b) {
  return isQuad(a) && isQuad(b) && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
}

// Sizes worked out from marked corners: the paper measurement ('photo') and the no-paper
// standard-size estimate ('estimate'). A typed-in size ('manual') and an AR measurement ('ar') are not.
const CORNER_SIZE_SOURCES = new Set(['photo', 'estimate']);

/**
 * Drop everything worked out from the marked corners, because a corner has just
 * changed: the measurement, and the size if it came from that measurement (the
 * paper measurement or the standard-size estimate). A size the customer typed in
 * is theirs and stays.
 * @param {object} state The shared app state (mutated).
 * @returns {void}
 */
export function invalidateMeasurement(state) {
  state.measure = null;
  if (state.size && CORNER_SIZE_SOURCES.has(state.size.source)) state.size = null;
}

/**
 * Distance from a rectangle to the nearest of some points; 0 when one is inside it.
 * @param {Point[]} points
 * @param {{ left: number, top: number, right: number, bottom: number }} rect Same coordinates as the points.
 * @returns {number} Infinity when there are no points.
 */
export function clearanceFromRect(points, rect) {
  let nearest = Infinity;
  for (const p of points) {
    const dx = Math.max(rect.left - p.x, 0, p.x - rect.right);
    const dy = Math.max(rect.top - p.y, 0, p.y - rect.bottom);
    nearest = Math.min(nearest, Math.hypot(dx, dy));
  }
  return nearest;
}

/**
 * Distance from a rectangle to the straight line between two points; 0 when the line touches it.
 * @param {Point} a
 * @param {Point} b
 * @param {{ left: number, top: number, right: number, bottom: number }} rect
 * @returns {number}
 */
function segmentClearance(a, b, rect) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Clip the line to the rectangle (Liang-Barsky): if any of it is left, they touch.
  let from = 0;
  let to = 1;
  let touches = true;
  for (const [step, room] of [
    [-dx, a.x - rect.left],
    [dx, rect.right - a.x],
    [-dy, a.y - rect.top],
    [dy, rect.bottom - a.y],
  ]) {
    if (step === 0) {
      if (room < 0) touches = false;
    } else if (step < 0) {
      from = Math.max(from, room / step);
    } else {
      to = Math.min(to, room / step);
    }
  }
  if (touches && from <= to) return 0;
  // Apart: the gap is narrowest at an end of the line or at a corner of the rectangle.
  let nearest = clearanceFromRect([a, b], rect);
  const lengthSq = dx * dx + dy * dy;
  for (const cx of [rect.left, rect.right]) {
    for (const cy of [rect.top, rect.bottom]) {
      const t = lengthSq > 0 ? clamp(((cx - a.x) * dx + (cy - a.y) * dy) / lengthSq, 0, 1) : 0;
      nearest = Math.min(nearest, Math.hypot(a.x + t * dx - cx, a.y + t * dy - cy));
    }
  }
  return nearest;
}

/**
 * Distance from a rectangle to the outline drawn through some corner points, joined the way the
 * editor joins them; 0 when the outline runs through the rectangle. Never more than
 * clearanceFromRect for the same points, since the corners are part of the outline.
 * @param {Point[]} points
 * @param {{ left: number, top: number, right: number, bottom: number }} rect Same coordinates as the points.
 * @returns {number} Infinity when there are no points.
 */
export function outlineClearanceFromRect(points, rect) {
  if (points.length < 2) return clearanceFromRect(points, rect);
  const order = outlineOrder(points);
  let nearest = Infinity;
  for (let i = 0; i < order.length; i += 1) {
    const next = order[(i + 1) % order.length];
    nearest = Math.min(nearest, segmentClearance(points[order[i]], points[next], rect));
  }
  return nearest;
}

/**
 * Pick the spot for the nudge pad that keeps it off the corner handles. The
 * current spot is kept while it is clear (so the pad does not wander); otherwise
 * the first clear spot wins, or failing that the one with the most room.
 * @param {object} current The spot the pad is in now (one of `candidates`).
 * @param {object[]} candidates Every spot, in order of preference.
 * @param {(candidate: object) => number} clearanceOf Distance from the pad in that spot to the nearest handle.
 * @param {number} enough Clearance at which a spot counts as clear.
 * @returns {object} One of `candidates`.
 */
export function choosePadPlacement(current, candidates, clearanceOf, enough) {
  let best = current;
  let bestClearance = clearanceOf(current);
  if (bestClearance >= enough) return current;
  for (const candidate of candidates) {
    if (candidate === current) continue;
    const clearance = clearanceOf(candidate);
    if (clearance >= enough) return candidate;
    if (clearance > bestClearance) {
      best = candidate;
      bestClearance = clearance;
    }
  }
  return best;
}

/**
 * Starting handles for the door: a tall rectangle inset from the photo edges.
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @returns {Point[]} Quad [TL, TR, BR, BL]
 */
export function defaultDoorQuad(imageWidth, imageHeight) {
  const left = imageWidth * 0.2;
  const right = imageWidth * 0.8;
  const top = imageHeight * 0.08;
  const bottom = imageHeight * 0.92;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

/**
 * May the door screen be entered? It depends on the way in the customer chose (`state.method`):
 *  - 'ar': never. The AR screen measures the door itself and goes straight to the result.
 *  - 'estimate' (the no-paper photo): a photo is all it needs; there is no sheet to mark.
 *  - anything else ('paper', or null from callers that predate `method`): a photo and a marked
 *    sheet. The stand-in rectangle the sheet screen shows after a failed detection does not count
 *    until the customer has moved a corner (`placed`).
 * door.js exports this as its `canEnter`; it lives here so it can be tested without loading the
 * door screen's estimate and detection modules.
 * @param {object} state
 * @returns {boolean}
 */
export function canEnterDoor(state) {
  if (!state || !state.photo) return false;
  if (state.method === 'ar') return false;
  if (state.method === 'estimate') return true;
  return Boolean(state.sheet && isQuad(state.sheet.points) && state.sheet.placed !== false);
}

/**
 * The outlines the door screen can offer from a findDoor() result, best first: the detected quad
 * then its alternatives. Detection's main mistake is a neighbouring rectangle (the outer trim, the
 * transom plus the door, a glass panel), and the right outline is among these three far more often
 * than it is the first, hence "Not this? Show the next outline". Anything that is not four finite
 * points, and any repeat of an outline already listed, is left out.
 *
 * Given the photo's size, every corner is kept inside it ([0, width] x [0, height]), exactly as
 * startingQuad() and the editor keep the handles, so an outline can be recognised again from the
 * handles sitting on it (outlineIndexOf) even when detection put a corner a fraction outside.
 * @param {{ ok?: boolean, quad?: Point[] | null, alternatives?: Point[][] } | null | undefined} detection
 * @param {{ width?: number, height?: number }} [bounds] The photo's size; omitted, nothing is clamped.
 * @returns {Point[][]} Detached copies; empty when nothing was found.
 */
export function doorOutlines(detection, bounds = {}) {
  if (!detection || !detection.ok || !isQuad(detection.quad)) return [];
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  const inside = width > 0 && height > 0
    ? (quad) => quad.map((p) => ({ x: clamp(p.x, 0, width), y: clamp(p.y, 0, height) }))
    : copyQuad;
  const outlines = [inside(detection.quad)];
  const alternatives = Array.isArray(detection.alternatives) ? detection.alternatives : [];
  for (const quad of alternatives) {
    if (!isQuad(quad)) continue;
    const outline = inside(quad);
    if (!outlines.some((known) => sameQuad(known, outline))) outlines.push(outline);
  }
  return outlines;
}

/**
 * Which of `outlines` a set of handles is sitting on exactly, or -1 for none (the customer's own
 * corners, or the fallback starting rectangle).
 * @param {Point[][]} outlines
 * @param {unknown} points
 * @returns {number}
 */
export function outlineIndexOf(outlines, points) {
  if (!Array.isArray(outlines)) return -1;
  return outlines.findIndex((quad) => sameQuad(quad, points));
}

/**
 * The outline "Not this? Show the next outline" moves to: the one after `index`, round to the first
 * again after the last. From no outline (-1: the customer's own corners or the fallback rectangle)
 * it starts at the detected one.
 * @param {number} index The outline shown now, or -1.
 * @param {number} count How many outlines there are.
 * @returns {number} -1 when there are none.
 */
export function nextOutlineIndex(index, count) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (!Number.isInteger(index) || index < 0 || index >= count) return 0;
  return (index + 1) % count;
}

/**
 * Have the door corners been placed, so that measuring from them means something? Measuring the
 * untouched starting rectangle would give a confident-looking but meaningless size, so the handles
 * count as placed once the customer has:
 *  - moved a corner (`moved`), or
 *  - picked an outline with "Not this? Show the next outline" (`chosen`): looking at a few and
 *    settling on one is a decision about where the door is;
 * or when the handles are still on the outline detection was confident of (`confident` and
 * `outline` 0). A detection it was not sure of is only a starting position.
 * @param {{ moved?: boolean, chosen?: boolean, confident?: boolean, outline?: number }} status
 * @returns {boolean}
 */
export function doorCornersPlaced({ moved = false, chosen = false, confident = false, outline = -1 } = {}) {
  return moved === true || chosen === true || (confident === true && outline === 0);
}

/**
 * What the door screen's banner should say:
 *  - 'searching': findDoor() is still looking at the photo;
 *  - 'outline': the customer is stepping through the outlines ("Outline 2 of 3");
 *  - 'found': the handles start on an outline detection is confident of (`outline` 0). It is still
 *    only a suggestion: the wording asks the customer to check each corner;
 *  - 'place': anything else. The customer drags the corners onto the door opening.
 * @param {{ searching?: boolean, confident?: boolean, chosen?: boolean, outline?: number, outlines?: number }} status
 *   `outline` is the index of the outline the handles were put on (-1 for none) and `outlines`
 *   how many there are.
 * @returns {'searching' | 'outline' | 'found' | 'place'}
 */
export function doorBannerKind({ searching = false, confident = false, chosen = false, outline = -1, outlines = 0 } = {}) {
  if (searching === true) return 'searching';
  const showing = Number.isInteger(outline) && outline >= 0 && outline < outlines;
  if (chosen === true && showing && outlines > 1) return 'outline';
  if (confident === true && showing && outline === 0) return 'found';
  return 'place';
}

/**
 * The corners as the outline the customer sees, in [TL, TR, BR, BL] order. The editor joins its
 * handles so the outline never crosses itself (see outlineOrder), whichever handle ended up on
 * which corner; the standard-size estimate needs that outline's corners in reading order, or it
 * would take the door's height for its width. Clockwise on screen, starting from the corner
 * nearest the photo's top-left.
 * @param {Point[]} points Four points (handle order).
 * @returns {Point[]} Detached copies, reordered; the input unchanged (copied) if it is not a quad.
 */
export function cornersInOutlineOrder(points) {
  if (!isQuad(points)) return Array.isArray(points) ? copyQuad(points.filter(Boolean)) : [];
  const ordered = outlineOrder(points).map((i) => ({ x: points[i].x, y: points[i].y }));
  let first = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].x + ordered[i].y < ordered[first].x + ordered[first].y) first = i;
  }
  return [...ordered.slice(first), ...ordered.slice(0, first)];
}

/**
 * Starting handles for the sheet when auto-detection fails: a portrait
 * rectangle with the reference's aspect ratio, about 15% of the photo wide,
 * centred on the tap and kept inside the image.
 * @param {Point} center Where the customer tapped (image px).
 * @param {{ w: number, h: number }} sheetMm Reference side lengths.
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @returns {Point[]} Quad [TL, TR, BR, BL]
 */
export function defaultSheetQuad(center, sheetMm, imageWidth, imageHeight) {
  const a = Number(sheetMm?.w);
  const b = Number(sheetMm?.h);
  const ratio = a > 0 && b > 0 ? Math.max(a, b) / Math.min(a, b) : FALLBACK_SHEET_RATIO;
  let width = imageWidth * 0.15;
  let height = width * ratio;
  // A very wide photo could make the portrait rectangle taller than the image.
  const fit = Math.min(1, imageHeight / height);
  width *= fit;
  height *= fit;
  const cx = clamp(center.x, width / 2, imageWidth - width / 2);
  const cy = clamp(center.y, height / 2, imageHeight - height / 2);
  return [
    { x: cx - width / 2, y: cy - height / 2 },
    { x: cx + width / 2, y: cy - height / 2 },
    { x: cx + width / 2, y: cy + height / 2 },
    { x: cx - width / 2, y: cy + height / 2 },
  ];
}

/**
 * Could a detected outline be the reference sheet the customer chose? Detection grows a region from
 * the tap, so a tap on a door panel, the step or the handle plate comes back as a tidy quad too, as
 * does white paper that has run together with the pale panel behind it. Two checks catch those:
 *  - shape: the long-to-short side ratio is within 35% of the reference's;
 *  - size: with the whole door in the photo, and no door shorter than `plausible.minHeightMm`, a
 *    millimetre spans at most (photo long side / minHeightMm) pixels. That caps the sheet's longest
 *    side; the cap is then loosened by 30% for perspective and a tightly framed door. The other
 *    way, a door no taller than `plausible.maxHeightMm` that fills at least 30% of the photo puts
 *    a floor under it, which is what rules out small fittings shaped like the sheet.
 * Shape alone is not enough: plenty of door panels are close to A4 in proportion.
 * @param {Point[]} quad The detected outline, in order around the quad (image px).
 * @param {{ w: number, h: number }} sheetMm Reference side lengths (either way round).
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {{ minHeightMm?: number, maxHeightMm?: number }} [plausible] config.measurement.plausible.
 * @returns {boolean} True when there is nothing to check against (no usable reference size).
 */
export function sheetOutlineIsPlausible(quad, sheetMm, imageWidth, imageHeight, plausible) {
  if (!isQuad(quad)) return false;
  const a = Number(sheetMm?.w);
  const b = Number(sheetMm?.h);
  if (!(a > 0 && b > 0)) return true;
  const side = (i) => Math.hypot(quad[(i + 1) % 4].x - quad[i].x, quad[(i + 1) % 4].y - quad[i].y);
  const sides = [side(0), side(1), side(2), side(3)];
  const across = (sides[0] + sides[2]) / 2;
  const down = (sides[1] + sides[3]) / 2;
  const shorter = Math.min(across, down);
  if (!(shorter > 0)) return false;
  const shape = Math.max(across, down) / shorter / (Math.max(a, b) / Math.min(a, b));
  if (shape > SHEET_SHAPE_TOLERANCE || shape < 1 / SHEET_SHAPE_TOLERANCE) return false;
  const minDoor = Number(plausible?.minHeightMm) > 0 ? Number(plausible.minHeightMm) : FALLBACK_DOOR_HEIGHT_MM.min;
  const maxDoor = Number(plausible?.maxHeightMm) > 0 ? Number(plausible.maxHeightMm) : FALLBACK_DOOR_HEIGHT_MM.max;
  // Sheet long side in px if the whole photo's long side were 1 mm of door height.
  const reach = Math.max(imageWidth, imageHeight) * Math.max(a, b);
  const longest = Math.max(...sides);
  return longest <= (SHEET_SIZE_ALLOWANCE * reach) / minDoor && longest >= (SHEET_MIN_DOOR_SPAN * reach) / maxDoor;
}

/**
 * What the sheet screen makes of detectSheet's answer to a tap:
 *  - 'found': an outline of the right shape and size whose sides were each located to sub-pixel
 *    accuracy with good support. Only this is announced as the sheet.
 *  - 'check': an outline of the right shape and size that detection itself is unsure of, either the
 *    coarse outline of the tapped region (`refined: false`, never checked against an edge) or a
 *    refined one with low confidence. A starting position the customer is asked to check.
 *  - 'manual': nothing usable (see sheetOutlineIsPlausible); the customer places the corners.
 * @param {{ ok?: boolean, quad?: Point[] | null, refined?: boolean, confidence?: number } | null} result What detectSheet returned.
 * @param {{ w: number, h: number }} sheetMm Reference side lengths (either way round).
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {{ minHeightMm?: number, maxHeightMm?: number }} [plausible] config.measurement.plausible.
 * @returns {'found' | 'check' | 'manual'}
 */
export function sheetDetectionOutcome(result, sheetMm, imageWidth, imageHeight, plausible) {
  if (!result || !result.ok || !sheetOutlineIsPlausible(result.quad, sheetMm, imageWidth, imageHeight, plausible)) {
    return 'manual';
  }
  return result.refined === true && result.confidence >= SHEET_FOUND_CONFIDENCE ? 'found' : 'check';
}

/**
 * Nudge distance for the n-th firing of a held arrow. A single press is always
 * 1 image px; a long hold speeds up, because 1 px per tick is invisible while
 * the photo is zoomed out.
 * @param {number} repeat 0 for the initial press, then 1, 2, ... for each repeat.
 * @returns {number} Image px.
 */
export function nudgeStepForRepeat(repeat) {
  if (repeat < 10) return 1;
  if (repeat < 25) return 2;
  return 4;
}

/**
 * Make a button fire once on press and then repeat while it is held.
 * Keyboard and assistive-technology activation (a click with no pointer press)
 * fires once. A second finger never presses the button, and one landing
 * anywhere during a hold ends it, so a pinch cannot set the button off.
 * @param {HTMLButtonElement} button
 * @param {(repeat: number) => void} action Called with 0 on press, then 1, 2, ...
 * @param {{ delayMs?: number, intervalMs?: number, onHoldChange?: (holding: boolean) => void }} [options]
 * @returns {() => void} Cleanup: removes listeners and clears timers.
 */
export function holdToRepeat(button, action, options = {}) {
  const { delayMs = HOLD_DELAY_MS, intervalMs = HOLD_INTERVAL_MS, onHoldChange } = options;
  let delayTimer = 0;
  let repeatTimer = 0;
  let guardTimer = 0;
  let activePointer = null;
  let pressPointer = null;
  let repeat = 0;
  let pointerHandled = false;

  function armClickGuard() {
    pointerHandled = true;
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      pointerHandled = false;
    }, CLICK_GUARD_MS);
  }

  function stop() {
    const wasHolding = activePointer !== null;
    clearTimeout(delayTimer);
    clearInterval(repeatTimer);
    delayTimer = 0;
    repeatTimer = 0;
    activePointer = null;
    if (wasHolding) {
      armClickGuard();
      if (onHoldChange) onHoldChange(false);
    }
  }

  function fire() {
    if (button.disabled || !button.isConnected) {
      stop();
      return;
    }
    action(repeat);
    repeat += 1;
  }

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A second finger is the other half of a pinch that happened to land on the
    // button, not a press on it.
    if (event.isPrimary === false) return;
    if (button.disabled) return;
    stop();
    clearTimeout(guardTimer);
    activePointer = event.pointerId;
    pressPointer = event.pointerId;
    pointerHandled = true;
    repeat = 0;
    if (onHoldChange) onHoldChange(true);
    fire();
    if (activePointer === null) return;
    delayTimer = setTimeout(() => {
      delayTimer = 0;
      fire();
      if (activePointer !== null) repeatTimer = setInterval(fire, intervalMs);
    }, delayMs);
  };

  const onPointerEnd = (event) => {
    if (activePointer !== null && event.pointerId === activePointer) stop();
    // The hold was already ended (by a second finger), a while ago perhaps:
    // the click of this press may still follow its release.
    else if (event.pointerId === pressPointer) armClickGuard();
    if (event.pointerId === pressPointer) pressPointer = null;
  };

  // Likewise a second finger landing anywhere during a hold: the customer is
  // zooming, and the held arrow must not keep moving a corner meanwhile.
  const onAnyPointerDown = (event) => {
    if (activePointer !== null && event.pointerId !== activePointer) stop();
  };

  const onClick = () => {
    if (pointerHandled) {
      pointerHandled = false;
      clearTimeout(guardTimer);
      return;
    }
    if (!button.disabled) action(0);
  };

  // A long press must not open the browser's context menu over the photo.
  const onContextMenu = (event) => event.preventDefault();

  const listeners = [
    ['pointerdown', onPointerDown],
    ['pointerup', onPointerEnd],
    ['pointercancel', onPointerEnd],
    ['pointerleave', onPointerEnd],
    ['click', onClick],
    ['contextmenu', onContextMenu],
  ];
  for (const [type, handler] of listeners) button.addEventListener(type, handler);
  const doc = button.ownerDocument;
  if (doc) doc.addEventListener('pointerdown', onAnyPointerDown, true);
  // If the app is backgrounded mid-hold the release may never arrive.
  const view = typeof window !== 'undefined' ? window : null;
  if (view) view.addEventListener('blur', stop);

  return () => {
    for (const [type, handler] of listeners) button.removeEventListener(type, handler);
    if (doc) doc.removeEventListener('pointerdown', onAnyPointerDown, true);
    if (view) view.removeEventListener('blur', stop);
    stop();
    clearTimeout(guardTimer);
  };
}

/**
 * @typedef {object} MarkLabels Translated labels for the shared floating controls.
 * @property {string} nudge Accessible name of the nudge pad as a group.
 * @property {string} up
 * @property {string} down
 * @property {string} left
 * @property {string} right
 * @property {string} fit Accessible name of the Fit button.
 */

/**
 * @typedef {object} MarkScreenOptions
 * @property {string} title Screen title (rendered as a visually hidden h1).
 * @property {{ text: string, tone?: 'info' | 'success' | 'warning' | 'danger' }} banner
 * @property {MarkLabels} labels
 * @property {Node[]} actions Children of the action bar, primary button first.
 * @property {object} editor
 * @property {Point[] | null} editor.points Initial quad, or null for none.
 * @property {string} editor.color Overlay colour of the editable quad.
 * @property {string} [editor.ariaLabel]
 * @property {{ points: Point[], color: string } | null} [editor.ghost]
 * @property {(points: Point[], meta: { final: boolean, index: number | null }) => void} [editor.onChange] Receives a detached copy of the points.
 * @property {(point: Point) => void} [editor.onTap] A tap on the photo away from the handles. While there is no quad, Enter or Space on the photo counts as a tap in the middle of the view, so the step can be done from a keyboard.
 * @property {(editor: QuadEditor) => void} [onReady] Called once, right after the editor is created.
 */

/**
 * @typedef {object} MarkScreen
 * @property {HTMLElement & { update: (text: string, tone?: string) => void }} banner
 * @property {HTMLElement} stage
 * @property {HTMLElement} chips Top-left overlay over the photo, for status chips.
 * @property {HTMLElement} tools Top-right overlay over the photo, for small floating buttons.
 * @property {HTMLElement} actionBar
 * @property {QuadEditor | null} editor Null until the first animation frame after mount.
 * @property {() => void} sync Re-read the editor's handles and update the nudge pad, now and again once any view animation has finished. Call after setPoints / setActive / zoomToQuad / resetView.
 * @property {() => void} flushLayout Resize the editor now if the stage changed size. Call after changing the banner or action bar and before zoomToQuad / resetView.
 * @property {() => void} destroy
 */

/**
 * Build the shared mark-screen scaffold inside `root` and schedule the QuadEditor.
 *
 * The editor is created in an animation frame once the stage has real layout,
 * and never if the screen is destroyed first.
 * @param {HTMLElement} root The empty screen <section>.
 * @param {object} ctx App context (uses ctx.ui and ctx.state.photo).
 * @param {MarkScreenOptions} opts
 * @returns {MarkScreen}
 */
export function createMarkScreen(root, ctx, opts) {
  const { ui } = ctx;
  const photo = ctx.state.photo;
  const { labels } = opts;
  const cleanups = [];
  let editor = null;
  let destroyed = false;
  let holding = false;
  let createFrame = 0;
  let syncFrame = 0;
  let layoutFrame = 0;
  let settleTimer = 0;
  let waitedFrames = 0;
  let lastWidth = 0;
  let lastHeight = 0;
  let placement = PAD_PLACEMENTS[0];

  root.classList.add('sm-screen--flush', 'sm-mark');

  const heading = ui.h('h1', { class: 'sm-visually-hidden', text: opts.title });

  const banner = ui.banner(opts.banner.text, { tone: opts.banner.tone ?? 'info' });
  banner.classList.add('sm-mark__banner');
  banner.setAttribute('data-autofocus', '');
  banner.setAttribute('tabindex', '-1');
  // The banner text changes as the customer works; make sure that is announced.
  if (!banner.hasAttribute('role') && !banner.hasAttribute('aria-live')) {
    banner.setAttribute('aria-live', 'polite');
  }

  // The editor gets its own host element so it can do what it likes with its
  // container without disturbing the controls floating above the canvas.
  const canvasHost = ui.h('div', { class: 'sm-mark__canvas' });
  const chips = ui.h('div', { class: 'sm-mark__chips' });
  const tools = ui.h('div', { class: 'sm-mark__tools' });
  const top = ui.h('div', { class: 'sm-mark__top' }, chips, tools);

  const nudgeButtons = NUDGES.map(({ dir, icon, dx, dy }) => {
    const button = ui.h(
      'button',
      {
        class: `sm-mark__float sm-mark__nudge sm-mark__nudge--${dir}`,
        type: 'button',
        disabled: true,
        attrs: { 'aria-label': labels[dir] },
      },
      ui.icon(icon, 20),
    );
    cleanups.push(
      holdToRepeat(
        button,
        (repeat) => {
          if (!editor) return;
          const step = nudgeStepForRepeat(repeat);
          editor.nudge(dx * step, dy * step);
        },
        {
          onHoldChange: (isHolding) => {
            holding = isHolding;
            if (!isHolding) scheduleSync();
          },
        },
      ),
    );
    return button;
  });

  const pad = ui.h(
    'div',
    {
      class: 'sm-mark__pad sm-mark__pad--idle',
      hidden: true,
      attrs: { role: 'group', 'aria-label': labels.nudge },
    },
    ui.h('span', { class: 'sm-mark__pad-hub', attrs: { 'aria-hidden': 'true' } }),
    nudgeButtons,
  );

  const fit = ui.h(
    'button',
    {
      class: 'sm-mark__float sm-mark__fab sm-mark__fit',
      type: 'button',
      attrs: { 'aria-label': labels.fit, title: labels.fit },
      on: {
        click: () => {
          if (!editor) return;
          flushLayout();
          editor.resetView();
          syncWhenSettled();
        },
      },
    },
    ui.icon('fit', 20),
  );

  const controls = ui.h('div', { class: 'sm-mark__controls' }, pad, fit);
  const stage = ui.h('div', { class: 'sm-mark__stage' }, canvasHost, top, controls);
  const actionBar = ui.actionBar(...opts.actions);
  root.append(heading, banner, stage, actionBar);

  function applyPlacement(next) {
    placement = next;
    controls.classList.toggle('sm-mark__controls--flip', next.flip);
    controls.classList.toggle('sm-mark__controls--mid', next.mid);
  }

  /** Where the handles are drawn, in viewport px; null if the editor cannot say. */
  function handlesOnScreen(points) {
    // getView() is an extra of js/editor.js, not part of the editor contract;
    // without it the pad simply stays where it is.
    const view = typeof editor.getView === 'function' ? editor.getView() : null;
    if (!view || !(view.scale > 0)) return null;
    const host = canvasHost.getBoundingClientRect();
    return points.map((p) => ({
      x: host.left + p.x * view.scale + view.tx,
      y: host.top + p.y * view.scale + view.ty,
    }));
  }

  /**
   * Keep the pad off the outline, so it never hides part of what the customer
   * is checking, and failing that at least off the corner handles. While its
   * arrows are live, a handle underneath it cannot be grabbed, and a press
   * meant for that handle would nudge the selected corner instead.
   */
  function placePad(points) {
    const handles = handlesOnScreen(points);
    if (!handles) return;
    const start = placement;
    // Each spot is laid out and measured at most once per pass.
    const rects = new Map();
    const padRectAt = (candidate) => {
      if (!rects.has(candidate)) {
        applyPlacement(candidate);
        rects.set(candidate, pad.getBoundingClientRect());
      }
      return rects.get(candidate);
    };
    const offOutline = (candidate) => outlineClearanceFromRect(handles, padRectAt(candidate));
    const offHandles = (candidate) => clearanceFromRect(handles, padRectAt(candidate));
    let next = choosePadPlacement(start, PAD_PLACEMENTS, offOutline, PAD_CLEARANCE_PX);
    if (offOutline(next) < PAD_CLEARANCE_PX) {
      // No spot is clear of the whole outline: the photo is zoomed right in, or the quad fills it.
      next = choosePadPlacement(start, PAD_PLACEMENTS, offHandles, PAD_CLEARANCE_PX);
    }
    applyPlacement(next);
  }

  /** The image point in the middle of the photo stage, as zoomed and panned right now. */
  function viewCentre() {
    const view = editor && typeof editor.getView === 'function' ? editor.getView() : null;
    if (!view || !(view.scale > 0)) return { x: photo.width / 2, y: photo.height / 2 };
    return {
      x: clamp((canvasHost.clientWidth / 2 - view.tx) / view.scale, 0, photo.width - 1),
      y: clamp((canvasHost.clientHeight / 2 - view.ty) / view.scale, 0, photo.height - 1),
    };
  }

  function sync() {
    if (destroyed) return;
    const points = editor ? editor.getPoints() : null;
    const hasQuad = isQuad(points);
    const active = hasQuad ? editor.getActive() : null;
    const enabled = Number.isInteger(active) && active >= 0 && active < 4;

    // A narrow strip wherever the stage is tall enough for one (see mark.css):
    // it fits in the margin beside the sheet or the door instead of over them.
    controls.classList.toggle('sm-mark__controls--strip', stage.clientHeight >= PAD_STRIP_MIN_STAGE_PX);

    // A quad that has only just appeared is usually still being zoomed to: the
    // pad stays hidden until the view is at rest, so it shows up in its final spot.
    pad.hidden = !hasQuad || (pad.hidden && settleTimer !== 0);
    // While idle the pad is dimmed and lets touches through to the photo (see
    // mark.css), so it never stops the customer grabbing a handle underneath it.
    pad.classList.toggle('sm-mark__pad--idle', !enabled);
    for (const button of nudgeButtons) button.disabled = !enabled;

    // Never during a hold: the pad must not slide out from under the finger.
    if (!hasQuad) applyPlacement(PAD_PLACEMENTS[0]);
    else if (!holding && !pad.hidden) placePad(points);
  }

  function scheduleSync() {
    if (destroyed || syncFrame) return;
    syncFrame = requestAnimationFrame(() => {
      syncFrame = 0;
      sync();
    });
  }

  function syncWhenSettled() {
    if (destroyed) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      sync();
    }, VIEW_SETTLE_MS);
  }

  function flushLayout() {
    if (destroyed || !editor) return;
    const width = canvasHost.clientWidth;
    const height = canvasHost.clientHeight;
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    editor.resize();
  }

  function scheduleLayout() {
    if (destroyed || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      flushLayout();
      // The stage changed shape, so the handles and the pad are in new places.
      sync();
    });
  }

  // Any interaction inside the stage can change the active handle or move the
  // photo (pan, pinch, wheel, keyboard zoom), so look again afterwards, and once
  // more when a zoom animation it started has finished. Capture phase: runs even
  // if the editor stops propagation.
  const onStageActivity = () => {
    scheduleSync();
    syncWhenSettled();
  };
  const stageEvents = ['pointerdown', 'pointerup', 'pointercancel', 'keyup', 'wheel'];
  const stageListenerOptions = { capture: true, passive: true };
  for (const type of stageEvents) stage.addEventListener(type, onStageActivity, stageListenerOptions);
  cleanups.push(() => {
    for (const type of stageEvents) stage.removeEventListener(type, onStageActivity, stageListenerOptions);
  });

  // The editor only reports taps made with a pointer. So that marking the sheet
  // does not need one, Enter or Space on the photo stands in for a tap in the
  // middle of the view while there are no corners yet. Once there are, the
  // editor's own keys (Tab, arrows) take over and this does nothing.
  const onPhotoKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // defaultPrevented: an editor that handles the key itself has already made the tap.
    if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!opts.editor.onTap || !editor || isQuad(editor.getPoints())) return;
    event.preventDefault();
    opts.editor.onTap(viewCentre());
  };
  canvasHost.addEventListener('keydown', onPhotoKey);
  cleanups.push(() => canvasHost.removeEventListener('keydown', onPhotoKey));

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(canvasHost);
    cleanups.push(() => observer.disconnect());
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', scheduleLayout);
    cleanups.push(() => window.removeEventListener('resize', scheduleLayout));
  }

  function createEditor() {
    createFrame = 0;
    if (destroyed) return;
    // The editor sizes its canvas from the container, so wait for real layout
    // (a slow first paint can take a few frames) before creating it.
    const unsized = canvasHost.clientWidth === 0 || canvasHost.clientHeight === 0;
    if (unsized && waitedFrames < MAX_LAYOUT_WAIT_FRAMES) {
      waitedFrames += 1;
      createFrame = requestAnimationFrame(createEditor);
      return;
    }

    const config = opts.editor;
    lastWidth = canvasHost.clientWidth;
    lastHeight = canvasHost.clientHeight;
    editor = new QuadEditor(canvasHost, {
      image: photo.canvas,
      imageWidth: photo.width,
      imageHeight: photo.height,
      points: isQuad(config.points) ? copyQuad(config.points) : null,
      color: config.color,
      ariaLabel: config.ariaLabel,
      ghost: config.ghost ?? null,
      onChange: (points, meta) => {
        const final = Boolean(meta && meta.final);
        if (final) sync();
        else scheduleSync();
        if (config.onChange && isQuad(points)) {
          config.onChange(copyQuad(points), { final, index: meta?.index ?? null });
        }
      },
      onTap: (point) => (config.onTap && point ? config.onTap({ x: point.x, y: point.y }) : undefined),
      // Not part of the editor contract: used when the editor offers it, and the
      // stage listeners above cover editors that do not.
      onActiveChange: scheduleSync,
    });
    if (opts.onReady) opts.onReady(editor);
    syncWhenSettled();
    sync();
  }
  createFrame = requestAnimationFrame(createEditor);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (createFrame) cancelAnimationFrame(createFrame);
    if (syncFrame) cancelAnimationFrame(syncFrame);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    clearTimeout(settleTimer);
    for (const cleanup of cleanups) cleanup();
    if (editor) {
      editor.destroy();
      editor = null;
    }
    root.classList.remove('sm-screen--flush', 'sm-mark');
  }

  return {
    banner,
    stage,
    chips,
    tools,
    actionBar,
    get editor() {
      return editor;
    },
    sync: () => {
      syncWhenSettled();
      sync();
    },
    flushLayout,
    destroy,
  };
}
