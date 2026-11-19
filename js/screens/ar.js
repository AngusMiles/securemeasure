/**
 * AR screen (step 2): measure the door opening with the phone's AR camera (WebXR, Chrome on Android
 * with ARCore only).
 *
 * Two halves:
 *   - The pre-session card, a normal padded screen: what to do, an honest line about accuracy, and
 *     "Start AR" / "Take a photo instead" (or the paper method, or a typed size, when the company
 *     has switched the camera way in off: cardAlternative).
 *   - The AR session. Chrome shows the camera full screen with one DOM element on top of it, the DOM
 *     overlay root. That root lives on <body> (not in this screen's <section>) only for as long as a
 *     session is starting or running, so its styles are global `.sm-ar-*` classes (css/screens/ar.css)
 *     and it picks up the theme from the custom properties on <html>. It holds a full-screen <svg> for
 *     the crosshair, the placed corners and the outline, an instruction pill at the top and a bar of
 *     buttons at the bottom. A tap anywhere else on the camera view is an XR "select", which places
 *     the current point.
 *
 * The geometry (floor-anchored method, see js/xr-measure.js) and the step machine (js/ar-flow.js) are
 * plain modules tested under Node. This file only moves numbers between WebXR objects and them, and
 * draws. A finished measurement becomes `state.measure` (method 'ar') and `state.size` exactly as the
 * build contract says; the result screen shows it as an "AR estimate" with the nearest standard size.
 *
 * Nothing touches the DOM, `navigator` or WebXR at import time, so this module imports under Node.
 */

import { applyMeasurementRules } from '../quote.js';
import { nearestStandard, standardSizesFrom } from '../estimate.js';
import { add, projectSegmentToCss, projectToCss, rayFromPoseMatrix } from '../xr-measure.js';
import { createArFlow, outlineSegments, POINT_KEYS } from '../ar-flow.js';
import { arSupported, isKnownInAppBrowser } from '../ar-support.js';

/** Screen id. */
export const id = 'ar';
/** Progress step this screen belongs to. */
export const step = 2;

/** Default copy for this screen (override any key through config.text). */
export const strings = {
  // ---- Pre-session card
  'ar.title': 'Measure with AR',
  'ar.subtitle': 'Your phone’s camera measures the door opening for you. It takes about a minute.',
  'ar.how.title': 'How it works',
  'ar.how.stand': 'Stand 1 to 2 metres back from the door, in good light.',
  'ar.how.floor': 'Point your phone at the floor and move it slowly until a ring appears.',
  'ar.how.bottom': 'Tap the two bottom corners, where the frame meets the ground.',
  'ar.how.sill': 'If there’s a raised step or sill in the doorway, tap the top of it. If not, tap “No step”.',
  'ar.how.top': 'Tap the two top corners of the opening.',
  'ar.diagram': 'A door opening. The two bottom corners are where the frame meets the ground, the two top corners are the inside corners at the top of the frame.',
  'ar.note': 'AR gives an estimate. We confirm the exact size with a check measure before your door is made.',
  'ar.start': 'Start AR',
  // The way on instead of AR (cardAlternative): the photo, else the sheet of paper, else a typed size.
  'ar.photo': 'Take a photo instead',
  'ar.paper': 'Measure with a sheet of paper',
  'ar.manual': 'I already know my door size',
  // The card's banners and the "stopped" toast, worded for that way on (cardCopyKey): the plain key
  // offers the photo, '.paper' the sheet of paper, '.manual' a typed size and '.none' nothing else.
  'ar.unsupported': 'AR measuring doesn’t work on this phone or browser. You can take a photo instead.',
  'ar.unsupported.paper': 'AR measuring doesn’t work on this phone or browser. You can measure with a sheet of paper instead.',
  'ar.unsupported.manual': 'AR measuring doesn’t work on this phone or browser. If you know your door size, you can enter it instead.',
  'ar.unsupported.none': 'AR measuring doesn’t work on this phone or browser.',
  'ar.unsupported.inApp': 'AR measuring doesn’t work inside this app. Open this page in Chrome, or take a photo instead.',
  'ar.unsupported.inApp.paper': 'AR measuring doesn’t work inside this app. Open this page in Chrome, or measure with a sheet of paper instead.',
  'ar.unsupported.inApp.manual': 'AR measuring doesn’t work inside this app. Open this page in Chrome, or enter your door size if you know it.',
  'ar.unsupported.inApp.none': 'AR measuring doesn’t work inside this app. Open this page in Chrome.',
  'ar.failed': 'AR didn’t start on this phone. You can take a photo instead, or try AR again.',
  'ar.failed.paper': 'AR didn’t start on this phone. You can measure with a sheet of paper instead, or try AR again.',
  'ar.failed.manual': 'AR didn’t start on this phone. You can try AR again, or enter your door size if you know it.',
  'ar.failed.none': 'AR didn’t start on this phone. You can try AR again.',
  'ar.error.start': 'We couldn’t start AR on this phone.',
  'ar.error.ended': 'AR measuring stopped. You can start again, or take a photo instead.',
  'ar.error.ended.paper': 'AR measuring stopped. You can start again, or measure with a sheet of paper instead.',
  'ar.error.ended.manual': 'AR measuring stopped. You can start again, or enter your door size if you know it.',
  'ar.error.ended.none': 'AR measuring stopped. You can start again.',

  // ---- In the AR view
  'ar.overlay.label': 'AR measuring',
  'ar.progress.floor': 'Getting ready',
  'ar.progress.corner': 'Corner {n} of 4',
  'ar.progress.sill': 'Raised step',
  'ar.progress.done': 'Nearly done',
  'ar.floor.title': 'Find the floor',
  'ar.floor.text': 'Point your phone at the floor near the door and move it slowly from side to side.',
  'ar.bl.title': 'Bottom-left corner',
  'ar.bl.text': 'Aim the crosshair where the left side of the frame meets the ground, then tap.',
  'ar.br.title': 'Bottom-right corner',
  'ar.br.text': 'Now aim where the right side of the frame meets the ground, then tap.',
  'ar.sill.title': 'Is there a raised step?',
  'ar.sill.text': 'If the doorway has a raised step or sill, aim at the top of it and tap. If not, tap “No step”.',
  'ar.tl.title': 'Top-left corner',
  'ar.tl.text': 'Aim at the top-left inside corner of the frame, then tap.',
  'ar.tr.title': 'Top-right corner',
  'ar.tr.text': 'Now aim at the top-right inside corner, then tap.',
  'ar.done.title': 'Checking your measurement…',
  'ar.done.text': 'Hold on a moment.',
  'ar.place': 'Place corner',
  'ar.place.sill': 'Place the top of the step',
  'ar.undo': 'Undo',
  'ar.noStep': 'No step',
  'ar.cancel': 'Cancel',
  'ar.retry.title': 'That didn’t line up — try again',
  'ar.retry.text': 'One of the corners looks out of place. Do the corners again, or tap Undo to redo the last one.',
  'ar.retry.again': 'Do the corners again',
  'ar.label.mm': '{mm} mm',

  // ---- Hints: one for every js/ar-flow.js HINT_KEYS entry (aimPoint reasons and the flow's own),
  // plus tracking / paused / restarted from the session itself.
  'ar.hint.scan_floor': 'Move your phone slowly over the floor',
  'ar.hint.hold_still': 'Hold still…',
  'ar.hint.hold_steady': 'Hold the phone steady, then tap again',
  'ar.hint.not_floor': 'Aim at the ground, not the wall',
  'ar.hint.no_surface': 'Can’t see the ground there. Move slowly',
  'ar.hint.too_far': 'Step closer',
  'ar.hint.too_narrow': 'Too close to the first corner',
  'ar.hint.too_wide': 'Too far from the first corner',
  'ar.hint.not_level': 'Aim at the ground, level with the first corner',
  'ar.hint.need_bl': 'Tap the bottom-left corner first',
  'ar.hint.no_plane': 'Tap both bottom corners first',
  'ar.hint.behind': 'Point your phone at the door',
  'ar.hint.grazing': 'Face the door',
  'ar.hint.too_low': 'Aim higher',
  'ar.hint.too_high': 'Aim lower',
  'ar.hint.off_opening': 'Aim inside the door frame',
  'ar.hint.no_ray': 'Hold on, finding your place',
  'ar.hint.bad_step': 'Hold on, finding your place',
  'ar.hint.tracking': 'Move your phone slowly so it can see the room',
  'ar.hint.paused': 'AR is paused',
  'ar.hint.restarted': 'Your phone lost its place, so we’ve started again',
};

/**
 * measureOpening() warnings that mean a corner is in the wrong place rather than an imperfect door:
 * the customer is asked to try again inside the same session instead of being shown a size.
 * (base_not_level and off_plane are real-world conditions; they go on to the result screen.)
 *
 * implausible_size is not one of them. Every corner has already passed aimPoint's guard rails
 * (xr-measure DEFAULT_LIMITS: up to 2 m wide, top corners 1.5 to 3.2 m up), which are wider than
 * measureOpening's usual door range, so a real double door or a low cellar door lands on it with
 * every corner in the right place. Retrying would only repeat the same honest pass for ever; the
 * result screen shows the size with its "unusual size" line, "Measure again" and the typed-size form.
 */
export const BLUNDER_WARNINGS = Object.freeze(['widths_disagree', 'heights_disagree', 'out_of_square']);

/** Radius of the ring drawn on the surface under the crosshair, metres. */
const RING_RADIUS_M = 0.1;
const RING_SIDES = 24;
/** Frames a new hint must persist before it is shown, so it does not flicker with every frame. */
const HINT_SETTLE_FRAMES = 6;
/**
 * How long a hint must stay up before screen readers are told it, ms. Well above HINT_SETTLE_FRAMES:
 * while the phone sweeps, the hint can change every few frames, and each change would cut off the
 * instruction being read out.
 */
export const HINT_ANNOUNCE_MS = 1000;
/** How long "started again" stays up after the AR world was reset, ms. */
const RESTARTED_MS = 3000;
const ERROR_TOAST_MS = 6000;
/**
 * Setting a granted session up (WebGL, reference spaces, hit-test source) takes well under a second;
 * if it has not finished after this long something is stuck, and the photo is the better way on.
 */
const SETUP_TIMEOUT_MS = 10000;

/** Instruction copy per flow step: [progress line, title, text]. */
const STEP_COPY = {
  floor: ['ar.progress.floor', 'ar.floor.title', 'ar.floor.text'],
  bl: ['ar.progress.corner', 'ar.bl.title', 'ar.bl.text'],
  br: ['ar.progress.corner', 'ar.br.title', 'ar.br.text'],
  sill: ['ar.progress.sill', 'ar.sill.title', 'ar.sill.text'],
  tl: ['ar.progress.corner', 'ar.tl.title', 'ar.tl.text'],
  tr: ['ar.progress.corner', 'ar.tr.title', 'ar.tr.text'],
  done: ['ar.progress.done', 'ar.done.title', 'ar.done.text'],
};
const CORNER_NUMBER = { bl: 1, br: 2, tl: 3, tr: 4 };
const OUTLINE_IDS = ['bottom', 'left', 'top', 'right', 'sill'];
const FLOOR_STEPS = new Set(['floor', 'bl', 'br']);

// Static glyph for the Start button (the icon kit has no AR icon): a cube inside viewfinder corners.
const ICON_AR =
  '<svg xmlns="http://www.w3.org/2000/svg" class="sm-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>' +
  '<path d="M12 6.5l5 2.75v5.5L12 17.5l-5-2.75v-5.5L12 6.5z"/>' +
  '<path d="M7 9.25L12 12l5-2.75M12 12v5.5"/>' +
  '</svg>';

// A door opening with the four corners to tap and the ring on the floor. Styled by classes in
// ar.css so it follows the skin; it carries no text (the description is in `strings`).
const DIAGRAM =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150" focusable="false">' +
  '<rect class="sm-ar__dg-wall" width="200" height="150" rx="12"/>' +
  '<path class="sm-ar__dg-floor" d="M0 128h200V138a12 12 0 0 1-12 12H12A12 12 0 0 1 0 138z"/>' +
  '<rect class="sm-ar__dg-frame" x="66" y="14" width="68" height="114"/>' +
  '<rect class="sm-ar__dg-door" x="72" y="20" width="56" height="108"/>' +
  '<rect class="sm-ar__dg-handle" x="117" y="72" width="4" height="13" rx="2"/>' +
  '<rect class="sm-ar__dg-outline" x="72" y="20" width="56" height="108"/>' +
  '<ellipse class="sm-ar__dg-ring" cx="100" cy="139" rx="16" ry="5"/>' +
  '<circle class="sm-ar__dg-dot" cx="72" cy="128" r="4.5"/>' +
  '<circle class="sm-ar__dg-dot" cx="128" cy="128" r="4.5"/>' +
  '<circle class="sm-ar__dg-dot" cx="72" cy="20" r="4.5"/>' +
  '<circle class="sm-ar__dg-dot" cx="128" cy="20" r="4.5"/>' +
  '</svg>';

/**
 * The AR screen can always be entered: it says so itself when this phone cannot do AR.
 * @returns {boolean}
 */
export function canEnter() {
  return true;
}

/**
 * True when a measureOpening() result should not be shown: missing, or with a warning that means a
 * corner was put in the wrong place (BLUNDER_WARNINGS).
 * @param {{ warnings?: string[] } | null | undefined} m
 * @returns {boolean}
 */
export function isBlunder(m) {
  if (!m || !Number.isFinite(m.widthMm) || !Number.isFinite(m.heightMm)) return true;
  return (Array.isArray(m.warnings) ? m.warnings : []).some((w) => BLUNDER_WARNINGS.includes(w));
}

/**
 * The way on the pre-session card offers instead of AR, which its copy talks about: 'photo' (the
 * camera way in), else 'paper', else 'manual' (typing a size the customer already knows), else null.
 * A company that switched a way in off is not offered it here either (the same rule as the result
 * screen's AR tools, resultTools in result-standard.js). With a normalised config (measurementMethods
 * in theme.js keeps paper on when camera, paper and typed sizes are all off) null does not happen.
 *
 * @param {object} config
 * @returns {'photo' | 'paper' | 'manual' | null}
 */
export function cardAlternative(config) {
  const measurement = (config && config.measurement) || {};
  const methods = measurement.methods && typeof measurement.methods === 'object' ? measurement.methods : {};
  if (methods.camera !== false) return 'photo';
  if (methods.paper !== false) return 'paper';
  if (measurement.allowManualOverride !== false) return 'manual';
  return null;
}

/**
 * The string key of the card copy `base` worded for `alternative` (see `strings`): the plain key
 * for the photo, `${base}.paper`, `${base}.manual` or `${base}.none` otherwise.
 * @param {string} base  'ar.unsupported' | 'ar.unsupported.inApp' | 'ar.failed' | 'ar.error.ended'
 * @param {'photo' | 'paper' | 'manual' | null} alternative  cardAlternative(config)
 * @returns {string}
 */
export function cardCopyKey(base, alternative) {
  return alternative === 'photo' ? base : `${base}.${alternative || 'none'}`;
}

/**
 * What screen readers are told about the hint line. Call it with the hint shown now (a key or null)
 * and the time; it returns the hint that should be spoken, or null. A hint is spoken only once it has
 * stayed up for `holdMs`, and a hint that changes or goes is dropped at once (emptying a polite live
 * region says nothing), so a hint flickering during a sweep is never read out.
 *
 * @param {number} [holdMs]
 * @returns {(key: string | null, now: number) => string | null}
 */
export function createHintSpeaker(holdMs = HINT_ANNOUNCE_MS) {
  let current = null;
  let since = 0;
  let spoken = null;
  return (key, now) => {
    const next = key || null;
    if (next !== current) {
      current = next;
      since = now;
      spoken = null;
    } else if (current && !spoken && now - since >= holdMs) {
      spoken = current;
    }
    return spoken;
  };
}

/**
 * The `state.measure` of an AR measurement (shape in the build contract), from a measureOpening()
 * result and the company's standard sizes.
 *
 * @param {object} m  measureOpening() result
 * @param {Array<{ widthMm: number, heightMm: number }>} sizes  standardSizesFrom(config)
 * @returns {{ method: 'ar', ok: true, widthMm: number, heightMm: number, minWidthMm: number,
 *   minHeightMm: number, sillHeightMm: number, warnings: string[], candidates: object[], runs: number }}
 */
export function buildArMeasure(m, sizes) {
  return {
    method: 'ar',
    ok: true,
    widthMm: m.widthMm,
    heightMm: m.heightMm,
    minWidthMm: m.minWidthMm,
    minHeightMm: m.minHeightMm,
    sillHeightMm: m.sillHeightMm,
    warnings: Array.isArray(m.warnings) ? [...m.warnings] : [],
    candidates: nearestStandard({ widthMm: m.widthMm, heightMm: m.heightMm, sizes }),
    runs: 1,
  };
}

/**
 * Ask the browser for the AR session. Call it straight from the tap handler with no await before
 * it: requestSession() needs the tap's transient user activation, and any await (even an already
 * settled one) can use it up, which Chrome reports as a SecurityError.
 *
 * Never 'local-floor' (on ARCore that is only 'local' moved down by a fixed 1.2 m guess, so the floor
 * comes from hit tests instead) and never 'depth-sensing' (about 160 x 120 px of smoothed depth, worst
 * exactly at corners and on plain doors).
 *
 * @param {Element} root  the DOM overlay root; it must be in the document by the time Chrome shows it
 * @returns {Promise<XRSession>}  rejects (never throws) when WebXR is missing or the session is refused
 */
export function requestArSession(root) {
  try {
    const xr = globalThis.navigator && globalThis.navigator.xr;
    if (!xr || typeof xr.requestSession !== 'function') {
      return Promise.reject(Object.assign(new Error('WebXR is not available'), { name: 'NotSupportedError' }));
    }
    return Promise.resolve(
      xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test', 'dom-overlay'],
        optionalFeatures: ['anchors'],
        domOverlay: { root },
      }),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Corners of a polygon of RING_SIDES sides, radius r, around `centre` in the plane spanned by u and v. */
function ringPoints(centre, u, v, r) {
  const out = [];
  for (let i = 0; i < RING_SIDES; i += 1) {
    const a = (i / RING_SIDES) * Math.PI * 2;
    const c = Math.cos(a) * r;
    const s = Math.sin(a) * r;
    out.push([centre[0] + u[0] * c + v[0] * s, centre[1] + u[1] * c + v[1] * s, centre[2] + u[2] * c + v[2] * s]);
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;
const stopXrSelect = (event) => event.preventDefault();

/** `promise`, or a rejection once `ms` have passed without it settling. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The DOM overlay: everything shown on top of the camera during the session. Built once per mount
 * and reused by every session started from it.
 */
function createOverlay(ui, t, handlers) {
  const { h } = ui;

  // ---- Drawing (purely visual: the pill says the same in words) --------------------------------
  const ring = h('polygon', { class: 'sm-ar-ring', attrs: { visibility: 'hidden' } });
  const lines = {};
  for (const lineId of OUTLINE_IDS) {
    lines[lineId] = {
      halo: h('line', { class: 'sm-ar-line__halo', attrs: { visibility: 'hidden' } }),
      line: h('line', { class: `sm-ar-line sm-ar-line--${lineId}`, attrs: { visibility: 'hidden' } }),
    };
  }
  const dots = POINT_KEYS.map(() => h('circle', { class: 'sm-ar-dot', attrs: { r: 7, visibility: 'hidden' } }));
  const cross = h(
    'g',
    { class: 'sm-ar-cross', attrs: { visibility: 'hidden' } },
    h('circle', { class: 'sm-ar-cross__halo', attrs: { r: 20 } }),
    h('circle', { class: 'sm-ar-cross__ring', attrs: { r: 20 } }),
    h('path', { class: 'sm-ar-cross__ticks', attrs: { d: 'M-30 0h-9M30 0h9M0-30v-9M0 30v9' } }),
    h('circle', { class: 'sm-ar-cross__dot', attrs: { r: 3.5 } }),
  );
  const svg = h(
    'svg',
    { class: 'sm-ar-canvas', attrs: { 'aria-hidden': 'true', focusable: 'false', width: '100%', height: '100%' } },
    ring,
    OUTLINE_IDS.map((lineId) => lines[lineId].halo),
    OUTLINE_IDS.map((lineId) => lines[lineId].line),
    dots,
    cross,
  );
  // Labels are HTML so they can sit on a readable chip; positioned with a transform every frame.
  const labels = {};
  for (const lineId of OUTLINE_IDS) labels[lineId] = h('span', { class: 'sm-ar-label sm-num', hidden: true });
  const labelLayer = h('div', { class: 'sm-ar-labels', attrs: { 'aria-hidden': 'true' } }, Object.values(labels));

  // ---- Instruction pill ------------------------------------------------------------------------
  // Two live regions, so a hint changing never makes screen readers start the instruction again:
  // the step (read once per step) and a spoken copy of the hint, set only once the hint has held
  // for HINT_ANNOUNCE_MS (createHintSpeaker). The hint line on screen is hidden from them, since it
  // can change every few frames while the phone sweeps.
  const eyebrow = h('p', { class: 'sm-ar-pill__eyebrow' });
  const title = h('p', { class: 'sm-ar-pill__title' });
  const text = h('p', { class: 'sm-ar-pill__text' });
  const stepRegion = h(
    'div',
    { class: 'sm-ar-pill__step', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } },
    eyebrow,
    title,
    text,
  );
  const hintText = h('span');
  const hint = h('p', { class: 'sm-ar-pill__hint', hidden: true, attrs: { 'aria-hidden': 'true' } }, ui.icon('alert', 18), hintText);
  const hintSpoken = h('p', {
    class: 'sm-visually-hidden',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const pill = h('div', { class: 'sm-ar-pill', attrs: { tabindex: '-1' } }, stepRegion, hint, hintSpoken);

  // ---- Retry panel (a measurement that did not add up) -----------------------------------------
  const retryButton = ui.button(t('ar.retry.again'), { variant: 'primary', icon: 'refresh', onClick: handlers.retry });
  const panel = ui.card(
    { class: 'sm-ar-panel', hidden: true, attrs: { role: 'alertdialog', 'aria-labelledby': 'sm-ar-retry-title' } },
    h('div', { class: 'sm-stack' }, h('h2', { class: 'sm-ar-panel__title', id: 'sm-ar-retry-title', text: t('ar.retry.title') }), h('p', { class: 'sm-ar-panel__text', text: t('ar.retry.text') }), retryButton),
  );

  // ---- Bottom controls -------------------------------------------------------------------------
  const undoButton = ui.button(t('ar.undo'), { variant: 'secondary', size: 'sm', icon: 'arrow-left', full: false, onClick: handlers.undo });
  const cancelButton = ui.button(t('ar.cancel'), { variant: 'secondary', size: 'sm', icon: 'close', full: false, onClick: handlers.cancel });
  const skipButton = ui.button(t('ar.noStep'), { variant: 'secondary', size: 'sm', full: false, onClick: handlers.skipSill });
  skipButton.classList.add('sm-ar-skip');
  skipButton.hidden = true;
  const placeButton = h(
    'button',
    { class: 'sm-ar-place', type: 'button', attrs: { 'aria-label': t('ar.place') }, on: { click: handlers.place } },
    ui.icon('plus', 34),
  );
  undoButton.classList.add('sm-ar-bar__undo');
  cancelButton.classList.add('sm-ar-bar__cancel');
  const bar = h('div', { class: 'sm-ar-bar' }, undoButton, placeButton, cancelButton);
  const bottom = h('div', { class: 'sm-ar-bottom' }, skipButton, bar);

  const root = h(
    'div',
    { class: 'sm-ar-overlay', attrs: { role: 'region', 'aria-label': t('ar.overlay.label') } },
    svg,
    labelLayer,
    h('div', { class: 'sm-ar-top' }, pill),
    h('div', { class: 'sm-ar-middle' }, panel),
    bottom,
  );

  // A tap on any control (or on the pill or panel around it) must not also place a point: cancelling
  // beforexrselect stops the XR select that tap would otherwise fire as well as the click.
  for (const el of [pill, panel, bottom, bar, retryButton, undoButton, cancelButton, skipButton, placeButton]) {
    el.addEventListener('beforexrselect', stopXrSelect);
  }

  let width = 0;
  let height = 0;
  let shownStep = null;
  let shownHint;
  let speakHint = createHintSpeaker();
  let spokenHint = null;

  const show = (el, on) => el.setAttribute('visibility', on ? 'visible' : 'hidden');
  const setLine = (el, a, b) => {
    el.setAttribute('x1', round1(a.x));
    el.setAttribute('y1', round1(a.y));
    el.setAttribute('x2', round1(b.x));
    el.setAttribute('y2', round1(b.y));
  };

  /** Show the overlay once the session is running (it is invisible while Chrome starts AR). */
  function setLive(on) {
    root.classList.toggle('is-live', Boolean(on));
  }

  /** Instruction copy and controls for a flow step. */
  function setStep(flowStep, { canUndo, retry }) {
    if (flowStep !== shownStep) {
      shownStep = flowStep;
      const [progressKey, titleKey, textKey] = STEP_COPY[flowStep] || STEP_COPY.floor;
      eyebrow.textContent = t(progressKey, { n: CORNER_NUMBER[flowStep] || '' });
      title.textContent = t(titleKey);
      text.textContent = t(textKey);
      placeButton.setAttribute('aria-label', t(flowStep === 'sill' ? 'ar.place.sill' : 'ar.place'));
    }
    skipButton.hidden = flowStep !== 'sill' || retry;
    placeButton.disabled = flowStep === 'floor' || flowStep === 'done' || retry;
    undoButton.disabled = !canUndo;
    panel.hidden = !retry;
    // The panel says what happened; a "Checking…" pill above it would contradict it.
    pill.hidden = retry;
  }

  /** The hint line under the instruction (null hides it). Called every frame, so the spoken copy can catch up. */
  function setHint(key, now = performance.now()) {
    if (key !== shownHint) {
      shownHint = key;
      hintText.textContent = key ? t(`ar.hint.${key}`) : '';
      hint.hidden = !key;
    }
    const spoken = speakHint(key, now);
    if (spoken !== spokenHint) {
      spokenHint = spoken;
      hintSpoken.textContent = spoken ? t(`ar.hint.${spoken}`) : '';
    }
  }

  /**
   * Draw one frame. Every coordinate is in CSS pixels of the overlay.
   * @param {{ W: number, H: number, cross: {x:number,y:number}|null, aimOk: boolean, collecting: boolean,
   *   ring: Array<{x:number,y:number}>|null, dots: Array<{x:number,y:number}|null>,
   *   segments: Array<{ id: string, a: {x:number,y:number}, b: {x:number,y:number}, live: boolean,
   *   label: { x: number, y: number, text: string } | null }> } | null} scene  null hides the drawing
   */
  function draw(scene) {
    if (!scene) {
      show(cross, false);
      show(ring, false);
      for (const lineId of OUTLINE_IDS) {
        show(lines[lineId].halo, false);
        show(lines[lineId].line, false);
        labels[lineId].hidden = true;
      }
      for (const dot of dots) show(dot, false);
      return;
    }
    // The phone may rotate, and the overlay with it: the drawing follows its current size.
    if (scene.W !== width || scene.H !== height) {
      width = scene.W;
      height = scene.H;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }

    if (scene.cross) {
      cross.setAttribute('transform', `translate(${round1(scene.cross.x)} ${round1(scene.cross.y)})`);
      cross.setAttribute('class', `sm-ar-cross${scene.aimOk ? ' is-ok' : ''}${scene.collecting ? ' is-collecting' : ''}`);
    }
    show(cross, Boolean(scene.cross));

    if (scene.ring) ring.setAttribute('points', scene.ring.map((p) => `${round1(p.x)},${round1(p.y)}`).join(' '));
    show(ring, Boolean(scene.ring));

    dots.forEach((dot, i) => {
      const p = scene.dots[i];
      if (p) {
        dot.setAttribute('cx', round1(p.x));
        dot.setAttribute('cy', round1(p.y));
      }
      show(dot, Boolean(p));
    });

    for (const lineId of OUTLINE_IDS) {
      const seg = scene.segments.find((s) => s.id === lineId);
      const { halo, line } = lines[lineId];
      if (seg) {
        setLine(halo, seg.a, seg.b);
        setLine(line, seg.a, seg.b);
        line.setAttribute('class', `sm-ar-line sm-ar-line--${lineId}${seg.live ? ' is-live' : ''}`);
      }
      show(halo, Boolean(seg));
      show(line, Boolean(seg));
      const label = labels[lineId];
      if (seg && seg.label) {
        if (label.textContent !== seg.label.text) label.textContent = seg.label.text;
        label.style.transform = `translate(${round1(seg.label.x)}px, ${round1(seg.label.y)}px) translate(-50%, -50%)`;
        label.hidden = false;
      } else {
        label.hidden = true;
      }
    }
  }

  /** Back to how a new session starts. */
  function reset() {
    shownStep = null;
    shownHint = undefined;
    speakHint = createHintSpeaker();
    setLive(false);
    setHint(null);
    draw(null);
    panel.hidden = true;
    pill.hidden = false;
  }

  return { root, pill, retryButton, setLive, setStep, setHint, draw, reset };
}

/**
 * Build the AR screen.
 * @param {HTMLElement} root The empty screen <section>.
 * @param {object} ctx App context.
 * @returns {() => void} Cleanup.
 */
export function mount(root, ctx) {
  const { ui, config } = ctx;
  const { h } = ui;
  const t = (key, vars) => ctx.t(key, vars);
  const measurement = config.measurement || {};
  const methods = measurement.methods && typeof measurement.methods === 'object' ? measurement.methods : {};
  // "Open this page in Chrome" only helps on Android: no iPhone browser has WebXR, Chrome included.
  const userAgent = (globalThis.navigator && globalThis.navigator.userAgent) || '';
  const inApp = isKnownInAppBrowser(userAgent) && !/iPhone|iPad|iPod/.test(userAgent);

  let alive = true;
  /** true / false once known; null while arSupported() has not answered (the card assumes yes). */
  let supported = methods.ar === false || inApp ? false : null;
  /** A session was refused (or failed to set up) on this visit: the other way on (cardAlternative) becomes the main one. */
  let startFailed = false;
  /** The session being started or running: see beginSession(). */
  let live = null;
  let startButton = null;

  const flow = createArFlow();

  // ---- Pre-session card ---------------------------------------------------------------------------

  const header = ui.screenHeader({ title: t('ar.title'), subtitle: t('ar.subtitle') });

  const diagram = ui.svgFromString(DIAGRAM);
  diagram.classList.add('sm-ar__diagram');
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', t('ar.diagram'));

  const howKeys = ['ar.how.stand', 'ar.how.floor', 'ar.how.bottom', 'ar.how.sill', 'ar.how.top'];
  const howCard = ui.card(
    { class: 'sm-ar__how' },
    h(
      'div',
      { class: 'sm-stack' },
      h('h2', { class: 'sm-ar__heading', text: t('ar.how.title') }),
      diagram,
      h(
        'ol',
        { class: 'sm-ar__steps', attrs: { role: 'list' } },
        howKeys.map((key, index) =>
          h(
            'li',
            { class: 'sm-ar__step' },
            h('span', { class: 'sm-ar__num sm-num', text: String(index + 1), attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'sm-ar__step-text', text: t(key) }),
          ),
        ),
      ),
    ),
  );

  const note = h('p', { class: 'sm-ar__note' }, ui.icon('info', 18), h('span', { text: t('ar.note') }));
  const statusBanner = ui.banner('', { tone: 'warning' });
  const bar = ui.actionBar();

  root.append(header, statusBanner, howCard, note, bar);

  // The way on instead of AR, and what the card's copy offers (cardAlternative).
  const alternative = cardAlternative(config);
  const copy = (base) => t(cardCopyKey(base, alternative));

  function alternativeButton(primary) {
    const look = { variant: primary ? 'primary' : 'secondary', size: primary ? 'lg' : 'md' };
    if (alternative === 'photo') return ui.button(t('ar.photo'), { ...look, icon: 'camera', onClick: () => ctx.go('capture') });
    if (alternative === 'paper') return ui.button(t('ar.paper'), { ...look, icon: 'paper', onClick: () => ctx.go('prepare') });
    if (alternative === 'manual') {
      return ui.button(t('ar.manual'), {
        ...look,
        icon: 'edit',
        // As the welcome screen's "I already know my door size".
        onClick: () => {
          ctx.state.manualEntry = true;
          ctx.go('result');
        },
      });
    }
    return null;
  }

  function renderCard() {
    if (supported === false) statusBanner.update(copy(inApp ? 'ar.unsupported.inApp' : 'ar.unsupported'), 'warning');
    else if (startFailed) statusBanner.update(copy('ar.failed'), 'warning');
    else statusBanner.update('');

    const arFirst = supported !== false && !startFailed;
    const otherButton = alternativeButton(!arFirst);
    startButton = null;
    if (supported === false) {
      bar.replaceChildren(...(otherButton ? [otherButton] : []));
      return;
    }
    startButton = ui.button(t('ar.start'), {
      variant: arFirst ? 'primary' : 'secondary',
      size: arFirst ? 'lg' : 'md',
      onClick: onStart,
    });
    startButton.prepend(ui.svgFromString(ICON_AR));
    bar.replaceChildren(...(arFirst ? [startButton, otherButton] : [otherButton, startButton]).filter(Boolean));
  }
  renderCard();

  /**
   * Put focus on the card's main action, the first button in the bar. renderCard() replaces the
   * buttons, so without this the focus of a keyboard or screen-reader user (on the Start AR button
   * they just used) would drop to <body>.
   */
  function focusCardAction() {
    try {
      const first = bar.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    } catch {
      // Focus is a courtesy for screen readers; nothing depends on it.
    }
  }

  if (supported === null) {
    arSupported().then((ok) => {
      if (!alive || ok) return;
      supported = false;
      renderCard();
    });
  }

  // ---- The overlay and its controls --------------------------------------------------------------

  const overlay = createOverlay(ui, t, {
    place: () => live && placePoint(live),
    undo: () => live && undoPoint(live),
    skipSill: () => {
      if (live && flow.skipSill()) syncControls(live);
    },
    cancel: () => live && endSession(live, 'cancel'),
    retry: () => live && retryCorners(live),
  });

  function onStart() {
    // The FIRST statement, with no await before it: the session request needs this tap's user activation.
    const request = live ? null : requestArSession(overlay.root);
    if (!request) return;
    // Chrome makes the overlay root full screen once the session is granted, so it must be in the
    // document by then. It stays invisible (ar.css) until the session is running.
    document.body.appendChild(overlay.root);
    const s = { session: null, request };
    live = s;
    if (startButton) startButton.setLoading(true);
    request.then(
      (session) => {
        if (!alive || live !== s) {
          session.end().catch(() => {});
          return;
        }
        beginSession(s, session);
      },
      (error) => {
        // SecurityError (no user activation, hidden page, blocked by Permissions-Policy) or
        // NotSupportedError (not capable, AR permission or ARCore install declined, DOM overlay failed):
        // Chrome only says which in the console, and every case means the same here.
        console.warn('[SecureMeasure] AR session refused', error);
        if (live === s) live = null;
        overlay.root.remove();
        if (!alive) return;
        startFailed = true;
        renderCard();
        ctx.toast(t('ar.error.start'), { type: 'error', duration: ERROR_TOAST_MS });
        focusCardAction();
      },
    );
  }

  /**
   * Set the granted session up: a WebGL layer that only clears to transparent (the camera image is
   * composited by the browser; everything we draw is SVG in the DOM overlay), the 'local' and
   * 'viewer' reference spaces, and a hit-test source along the viewer's -Z (the crosshair ray).
   */
  async function beginSession(s, session) {
    Object.assign(s, {
      session,
      gl: null,
      local: null,
      hitSource: null,
      anchorsOn: false,
      anchors: new Map(),
      anchorTokens: new Map(),
      ended: false,
      tornDown: false,
      endReason: null,
      paused: false,
      checked: false,
      restartedUntil: 0,
      hint: { shown: null, candidate: null, count: 0 },
      frameError: false,
    });
    flow.reset();
    session.addEventListener('end', () => onSessionEnd(s));

    // Show the overlay straight away, on "Find the floor" with only Cancel working, so the customer is
    // never left looking at a full-screen camera with no way out while the session is set up.
    overlay.reset();
    overlay.setLive(true);
    syncControls(s);
    if (startButton) startButton.setLoading(false);
    try {
      overlay.pill.focus({ preventScroll: true });
    } catch {
      // Focus is a courtesy for screen readers; nothing depends on it.
    }

    try {
      await withTimeout(setUpSession(s, session), SETUP_TIMEOUT_MS);
      if (s.ended) return;
    } catch (error) {
      console.warn('[SecureMeasure] AR session setup failed', error);
      endSession(s, 'failed');
      return;
    }

    s.anchorsOn = Array.isArray(session.enabledFeatures) && session.enabledFeatures.includes('anchors');
    session.addEventListener('select', () => placePoint(s));
    session.addEventListener('visibilitychange', () => {
      s.paused = session.visibilityState !== 'visible';
    });
    // The AR world was re-based (tracking was lost and found again): every placed point and the floor
    // height are now in the wrong place, so the measurement starts again from the floor scan.
    s.local.addEventListener('reset', () => {
      if (s.ended) return;
      flow.reset();
      syncAnchors(s);
      s.checked = false;
      s.restartedUntil = performance.now() + RESTARTED_MS;
    });

    session.requestAnimationFrame((time, frame) => onXRFrame(s, time, frame));
  }

  async function setUpSession(s, session) {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false });
    if (!gl) throw new Error('WebGL is not available');
    s.gl = gl;
    // XRWebGLLayer throws InvalidStateError for a context that is not XR-compatible.
    await gl.makeXRCompatible();
    if (s.ended) return;
    session.updateRenderState({
      baseLayer: new globalThis.XRWebGLLayer(session, gl, { alpha: true, antialias: false, depth: false }),
    });
    // 'local' is ARCore's own world with +Y up, which is what js/xr-measure.js expects.
    const local = await session.requestReferenceSpace('local');
    const viewer = await session.requestReferenceSpace('viewer');
    // No entityTypes: stable Chrome ignores them and always hit-tests detected planes.
    const hitSource = await session.requestHitTestSource({ space: viewer });
    s.hitSource = hitSource;
    if (s.ended) {
      // Ended (or timed out) while this was being set up: teardown has already run.
      try {
        hitSource.cancel();
      } catch {
        // Gone with the session.
      }
      return;
    }
    s.local = local;
  }

  function syncControls(s) {
    const points = flow.points;
    const canUndo = flow.collecting || POINT_KEYS.some((key) => points[key]);
    overlay.setStep(flow.step, { canUndo, retry: flow.step === 'done' && s.checked && !s.endReason });
  }

  function placePoint(s) {
    if (s.ended || !s.local) return;
    flow.tap();
  }

  function undoPoint(s) {
    if (s.ended) return;
    flow.undo();
    syncAnchors(s);
    s.checked = false;
    syncControls(s);
  }

  function retryCorners(s) {
    if (s.ended) return;
    flow.reset({ keepFloor: true });
    syncAnchors(s);
    s.checked = false;
    syncControls(s);
    try {
      overlay.pill.focus({ preventScroll: true });
    } catch {
      // As above.
    }
  }

  // ---- Anchors: points that ARCore keeps in place as its map of the room improves ----------------

  function anchorPoint(s, frame, { step: key, point }) {
    if (typeof frame.createAnchor !== 'function' || typeof globalThis.XRRigidTransform !== 'function') return;
    const token = {};
    s.anchorTokens.set(key, token);
    let request;
    try {
      request = frame.createAnchor(new globalThis.XRRigidTransform({ x: point[0], y: point[1], z: point[2] }), s.local);
    } catch {
      return;
    }
    Promise.resolve(request).then(
      (anchor) => {
        if (!anchor) return;
        // Undone, restarted or ended while the anchor was being made: it is not wanted any more.
        if (s.ended || s.anchorTokens.get(key) !== token || !flow.points[key]) {
          deleteAnchor(anchor);
          return;
        }
        s.anchors.set(key, anchor);
      },
      () => {
        // No anchor: the point simply stays where it was placed.
      },
    );
  }

  function deleteAnchor(anchor) {
    try {
      if (anchor && typeof anchor.delete === 'function') anchor.delete();
    } catch {
      // Already gone with its session.
    }
  }

  /** Drop the anchors of points that are no longer placed (after undo, a retry or a restart). */
  function syncAnchors(s) {
    const points = flow.points;
    for (const key of POINT_KEYS) {
      if (points[key]) continue;
      s.anchorTokens.delete(key);
      if (s.anchors.has(key)) {
        deleteAnchor(s.anchors.get(key));
        s.anchors.delete(key);
      }
    }
  }

  /** Move each anchored point to where ARCore now has its anchor. */
  function refreshAnchors(s, frame) {
    if (!s.anchors.size) return;
    const moved = {};
    for (const [key, anchor] of s.anchors) {
      // Not tracked this frame (ARCore lost sight of it): the point keeps its last known place.
      if (frame.trackedAnchors && !frame.trackedAnchors.has(anchor)) continue;
      try {
        const pose = frame.getPose(anchor.anchorSpace, s.local);
        if (pose) moved[key] = pose.transform.position;
      } catch {
        // A deleted or lost anchor: same as not tracked.
      }
    }
    flow.updatePoints(moved);
  }

  // ---- The frame loop ----------------------------------------------------------------------------

  /** A new hint must hold for a few frames before it replaces the one shown, so it does not flicker. */
  function settleHint(s, next) {
    const state = s.hint;
    if (next === state.shown) {
      state.candidate = next;
      state.count = 0;
    } else if (next === 'hold_still' || state.shown === 'hold_still') {
      // A tap starting or finishing is not flicker: say so at once.
      state.shown = next;
      state.count = 0;
    } else {
      if (next === state.candidate) state.count += 1;
      else {
        state.candidate = next;
        state.count = 1;
      }
      if (state.count >= HINT_SETTLE_FRAMES) {
        state.shown = next;
        state.count = 0;
      }
    }
    return state.shown;
  }

  function onXRFrame(s, time, frame) {
    if (s.ended) return;
    const session = s.session;
    session.requestAnimationFrame((nextTime, nextFrame) => onXRFrame(s, nextTime, nextFrame));
    try {
      const layer = session.renderState.baseLayer;
      if (layer && s.gl) {
        const gl = s.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      if (s.checked && s.endReason) return; // finishing: the session is on its way out

      const W = overlay.root.clientWidth;
      const H = overlay.root.clientHeight;
      const pose = frame.getViewerPose(s.local);
      const restarted = performance.now() < s.restartedUntil;
      if (!pose || pose.emulatedPosition || s.paused) {
        overlay.draw(null);
        syncControls(s);
        overlay.setHint(restarted ? 'restarted' : s.paused ? 'paused' : 'tracking');
        return;
      }

      const view = pose.views[0];
      // The same ray the hit-test source uses: the viewer's -Z axis.
      const ray = rayFromPoseMatrix(pose.transform.matrix);
      if (s.anchorsOn) refreshAnchors(s, frame);

      let hit = null;
      const results = frame.getHitTestResults(s.hitSource);
      const hitPose = results.length ? results[0].getPose(s.local) : null;
      if (hitPose) hit = { position: hitPose.transform.position, orientation: hitPose.transform.orientation };

      const out = flow.onFrame({ ray, hit });
      if (out.committed && s.anchorsOn) anchorPoint(s, frame, out.committed);
      if (flow.step !== 'done') s.checked = false;

      drawFrame(view, W, H, ray, out);
      const hint = settleHint(s, out.hint);
      overlay.setHint(restarted ? 'restarted' : hint);

      if (flow.step === 'done' && !s.checked) finish(s);
      syncControls(s);
    } catch (error) {
      if (!s.frameError) {
        s.frameError = true;
        console.error('[SecureMeasure] AR frame failed', error);
      }
    }
  }

  /** Project the 3D scene into CSS pixels of the overlay and draw it. */
  function drawFrame(view, W, H, ray, out) {
    // view.transform.inverse.matrix takes 'local' points into the view; projectionMatrix may be
    // off-centre on a phone, which is why nothing here assumes the middle of the screen.
    const viewMatrix = view.transform.inverse.matrix;
    const projection = view.projectionMatrix;
    const at = (p) => {
      const c = projectToCss(viewMatrix, projection, p, W, H);
      return c.inFront ? { x: c.x, y: c.y } : null;
    };
    const flowStep = flow.step;
    const points = flow.points;
    const plane = flow.plane;
    const aim = out.aim;

    // The crosshair sits where the hit-test ray points: 1 m along the viewer's -Z, projected.
    const cross = at(add(ray.origin, ray.direction));

    // A ring on the surface under the crosshair: on the floor while the base is placed, on the door
    // plane for the sill and the top corners. It only shows while the aim is usable.
    let ringCss = null;
    if (aim.ok && aim.point) {
      const basis = FLOOR_STEPS.has(flowStep) ? [[1, 0, 0], [0, 0, 1]] : plane ? [plane.right, plane.up] : null;
      if (basis) {
        const projected = ringPoints(aim.point, basis[0], basis[1], RING_RADIUS_M).map(at);
        if (projected.every(Boolean)) ringCss = projected;
      }
    }

    const dots = POINT_KEYS.map((key) => (points[key] ? at(points[key]) : null));
    const segments = [];
    for (const seg of outlineSegments(points, plane, { step: flowStep, aim })) {
      const projected = projectSegmentToCss(viewMatrix, projection, seg.a, seg.b, W, H);
      if (!projected) continue;
      const ends = at(seg.a) && at(seg.b);
      const label =
        seg.id !== 'sill' && ends && Number.isFinite(seg.mm) && seg.mm > 0
          ? {
              x: (projected.a.x + projected.b.x) / 2,
              y: (projected.a.y + projected.b.y) / 2,
              text: t('ar.label.mm', { mm: ui.fmtMm(seg.mm) }),
            }
          : null;
      segments.push({ id: seg.id, a: projected.a, b: projected.b, live: seg.live, label });
    }

    overlay.draw({ W, H, cross, aimOk: aim.ok, collecting: out.collecting, ring: ringCss, dots, segments });
  }

  // ---- Finishing ---------------------------------------------------------------------------------

  /**
   * All corners are in. A measurement that does not add up (a corner on the wrong edge) is offered
   * again inside the same session; anything else becomes the AR measurement and the session ends.
   */
  function finish(s) {
    s.checked = true;
    const m = flow.result();
    if (isBlunder(m)) {
      syncControls(s);
      try {
        overlay.retryButton.focus({ preventScroll: true });
      } catch {
        // As above.
      }
      return;
    }

    const state = ctx.state;
    state.measure = buildArMeasure(m, standardSizesFrom(config));
    state.method = 'ar';
    state.manualEntry = false;
    state.size = {
      ...applyMeasurementRules(measurement, { widthMm: m.widthMm, heightMm: m.heightMm }),
      source: 'ar',
      standard: false,
    };
    ctx.emit('measured', { widthMm: state.size.widthMm, heightMm: state.size.heightMm, source: 'ar', standard: false });
    endSession(s, 'result');
  }

  /** End the session on purpose; `reason` decides what happens once it has ended (onSessionEnd). */
  function endSession(s, reason) {
    if (!s.session || s.ended) return;
    if (!s.endReason) s.endReason = reason;
    overlay.draw(null);
    // Some browsers resolve end() without firing 'end' when the session is already shutting down.
    s.session.end().then(
      () => onSessionEnd(s),
      () => onSessionEnd(s),
    );
  }

  /** Free what the session held and take the overlay off the page. Safe to call more than once. */
  function teardown(s) {
    if (s.tornDown) return;
    s.tornDown = true;
    try {
      if (s.hitSource && typeof s.hitSource.cancel === 'function') s.hitSource.cancel();
    } catch {
      // Cancelled with its session already.
    }
    for (const anchor of s.anchors.values()) deleteAnchor(anchor);
    s.anchors.clear();
    s.anchorTokens.clear();
    try {
      const lose = s.gl && s.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch {
      // The context goes with the canvas anyway.
    }
    overlay.root.remove();
    overlay.reset();
  }

  function onSessionEnd(s) {
    if (s.ended) return;
    s.ended = true;
    teardown(s);
    if (live === s) live = null;
    if (!alive) return;

    if (s.endReason === 'result') {
      ctx.go('result');
      return;
    }
    if (s.endReason === 'failed') startFailed = true;
    renderCard();
    if (s.endReason === 'failed') {
      ctx.toast(t('ar.error.start'), { type: 'error', duration: ERROR_TOAST_MS });
    } else if (s.endReason !== 'cancel') {
      // Ended by the phone, not by us: the customer pressed Back, switched apps or the AR service stopped.
      ctx.toast(copy('ar.error.ended'), { duration: ERROR_TOAST_MS });
    }
    // Start AR again after a cancel or an unexpected end; the other way on after a failed setup.
    focusCardAction();
  }

  return () => {
    alive = false;
    const s = live;
    live = null;
    if (s && s.session && !s.ended) {
      s.endReason = 'leave';
      s.session.end().catch(() => {});
      s.ended = true;
      teardown(s);
    }
    overlay.root.remove();
  };
}
