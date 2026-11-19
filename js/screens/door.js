/**
 * Door screen (step 2): the customer drags four handles onto the corners of
 * the door opening. It works two ways, picked by `state.method`:
 *
 *  - paper ('paper', or null for callers that predate `method`): the sheet of
 *    paper marked on the sheet screen is shown as a ghost outline, and the
 *    sheet and the door are fitted together to get the opening's width and
 *    height (measureDoor).
 *  - estimate ('estimate', the no-paper photo): there is no scale in the
 *    photo, so no millimetres are read from it. The four corners and the
 *    camera's focal length give the opening's height-to-width ratio, which is
 *    matched to the company's standard door sizes (estimateFromCorners). The
 *    result screen shows it as an estimate to be confirmed by a check measure.
 *
 * Either way the handles start on the door that findDoor() found in the photo
 * (or a sensible fallback rectangle). The live-camera path runs findDoor()
 * before coming here; on the paper path, and whenever an earlier search ran out
 * of time, this screen runs it after the first paint, and moves the handles onto
 * what it found unless the customer has moved or selected one by then (and never
 * while a finger is on the photo). Detection is a starting position, never a
 * measurement: the customer always confirms the corners, "Not this? Show the next
 * outline" steps through the other outlines it considered, and corners left where
 * detection put them are measured with detection's error, not a hand's.
 */

import { measureDoor } from '../geometry.js';
import { applyMeasurementRules } from '../quote.js';
import { getSheetMm } from '../photo.js';
import { ESTIMATE_THRESHOLDS, estimateFromCorners, photoFocal, standardSizesFrom } from '../estimate.js';
import { findDoor, isConfident, startingQuad } from '../door-find.js';
import {
  canEnterDoor,
  copyQuad,
  cornersByHand,
  cornersInOutlineOrder,
  createMarkScreen,
  defaultDoorQuad,
  doorBannerKind,
  doorCornerSigmaPx,
  doorCornersPlaced,
  doorOutlines,
  invalidateMeasurement,
  isPhotoTarget,
  isQuad,
  isSettledDetection,
  markCornersByHand,
  nextOutlineIndex,
  outlineIndexOf,
  pressGate,
  sameQuad,
  themeColor,
} from './mark-common.js';

/** Screen id. */
export const id = 'door';
/** Progress step this screen belongs to. */
export const step = 2;

/** Default copy for this screen (override any key through config.text). */
export const strings = {
  'door.title': 'Mark the door opening',
  'door.estimate.title': 'Check the door corners',
  'door.banner': 'Drag each corner to a corner of the door opening, where the door meets the frame.',
  'door.banner.searching': 'Looking for your door…',
  'door.banner.found': 'We found your door. Check each corner sits where the door meets the frame.',
  'door.banner.outline': 'Outline {n} of {total}. Check each corner sits where the door meets the frame.',
  'door.outline.next': 'Not this? Show the next outline',
  'door.measure': 'Measure my door',
  'door.estimate.measure': 'Find my door size',
  'door.back': 'Back to the sheet',
  'door.estimate.back': 'Retake photo',
  'door.estimate.back.demo': 'Back',
  'door.help.open': 'Where do the corners go?',
  'door.help.title': 'Where to put the corners',
  'door.help.diagram':
    'A door in its frame with a sheet of paper taped to it. The four corners of the door opening are highlighted. A corner of the outer trim is crossed out.',
  'door.estimate.help.diagram':
    'A door in its frame. The four corners of the door opening are highlighted. A corner of the outer trim is crossed out.',
  'door.help.opening':
    "Mark the door opening itself, where the door meets the frame. Don't mark the outer trim around it.",
  'door.help.plane':
    'All four corners need to sit on the same flat surface as the sheet of paper, so keep the door fully closed.',
  'door.estimate.help.exact':
    'Keep the door closed and put each corner exactly in place. Pinch to zoom in. We match the shape of the opening to the nearest standard door size.',
  'door.help.close': 'Got it',
  'door.error.untouched': 'Drag the four corners onto your door opening first.',
  'door.error.not_convex':
    "Those corners don't make a door shape. Put one handle on each corner of the door opening, then try again.",
  'door.error.degenerate':
    "We couldn't work out a size from those corners. Check the corners of the paper and the door, then try again.",
  'door.estimate.error.degenerate':
    "We couldn't work out a size from those corners. Check each handle sits on a corner of the door opening, then try again.",
  'door.error.no_convergence':
    "We couldn't get a steady measurement. Check each handle sits right on a corner of the door opening, then try again.",
  'door.editor.aria':
    'Your door photo. Drag the four corner handles onto the corners of the door opening.',
  'door.nudge.label': 'Fine-tune the selected corner',
  'door.nudge.up': 'Move the corner up',
  'door.nudge.down': 'Move the corner down',
  'door.nudge.left': 'Move the corner left',
  'door.nudge.right': 'Move the corner right',
  'door.fit': 'Show the whole photo',
};

const ERROR_KEYS = new Map([
  ['not_convex', 'door.error.not_convex'],
  ['degenerate', 'door.error.degenerate'],
  ['no_convergence', 'door.error.no_convergence'],
]);

// estimateFromCorners only fails these two ways; the paper wording of 'degenerate' talks about the sheet.
const ESTIMATE_ERROR_KEYS = new Map([
  ['not_convex', 'door.error.not_convex'],
  ['degenerate', 'door.estimate.error.degenerate'],
]);

// What each doorBannerKind() answer looks like.
const BANNERS = {
  searching: { key: 'door.banner.searching', tone: 'info' },
  outline: { key: 'door.banner.outline', tone: 'info' },
  found: { key: 'door.banner.found', tone: 'success' },
  place: { key: 'door.banner', tone: 'info' },
};

const FALLBACK_ACCENT = '#f59e0b';
const FALLBACK_SUCCESS = '#16a34a';
const FALLBACK_PRIMARY = '#0f172a';
const ERROR_TOAST_MS = 6000;
// Nothing waits on this screen's own search for the door: the customer can drag the handles meanwhile.
// So it is cut off only when something has clearly gone wrong, not at findDoor's 4 s default, which a
// budget phone busy with other work can need for the search itself. Starting the worker and fetching its
// modules is given the same allowance (findDoor's loadTimeoutMs), within the same 15 s overall: as a
// background search, a worker that has not started by then ends as a 'timeout' rather than freezing the
// page with a main-thread search, and the next visit looks again.
const BACKGROUND_SEARCH_TIMEOUT_MS = 15000;
// Stage events that end a press on the photo (see pressGate).
const RELEASE_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'];

// Static illustration, styled by classes in mark.css so it follows the skin.
// It carries no text: the wording lives in `strings`. Built from parts so the
// no-paper estimate can show the same door without the taped sheet.
const DIAGRAM_DOOR = `
  <rect class="sm-mark__dg-wall" width="240" height="272" rx="14"/>
  <rect class="sm-mark__dg-trim" x="40" y="16" width="160" height="232"/>
  <rect class="sm-mark__dg-door" x="64" y="40" width="112" height="208"/>
  <rect class="sm-mark__dg-panel" x="80" y="56" width="76" height="78" rx="3"/>
  <rect class="sm-mark__dg-panel" x="80" y="160" width="76" height="72" rx="3"/>
  <rect class="sm-mark__dg-handle" x="162" y="140" width="7" height="24" rx="3.5"/>
  <line class="sm-mark__dg-floor" x1="14" y1="248" x2="226" y2="248"/>`;
const DIAGRAM_SHEET = `
  <rect class="sm-mark__dg-sheet" x="104" y="102" width="32" height="45" rx="1.5"/>
  <rect class="sm-mark__dg-tape" x="99" y="99" width="11" height="5" rx="1" transform="rotate(-40 104.5 101.5)"/>
  <rect class="sm-mark__dg-tape" x="130" y="99" width="11" height="5" rx="1" transform="rotate(40 135.5 101.5)"/>
  <rect class="sm-mark__dg-tape" x="99" y="145" width="11" height="5" rx="1" transform="rotate(40 104.5 147.5)"/>
  <rect class="sm-mark__dg-tape" x="130" y="145" width="11" height="5" rx="1" transform="rotate(-40 135.5 147.5)"/>`;
const DIAGRAM_MARKS = `
  <rect class="sm-mark__dg-outline" x="64" y="40" width="112" height="208"/>
  <path class="sm-mark__dg-wrong" d="M195 11l10 10M205 11l-10 10"/>
  <circle class="sm-mark__dg-ring" cx="64" cy="40" r="9"/>
  <circle class="sm-mark__dg-dot" cx="64" cy="40" r="3.5"/>
  <circle class="sm-mark__dg-ring" cx="176" cy="40" r="9"/>
  <circle class="sm-mark__dg-dot" cx="176" cy="40" r="3.5"/>
  <circle class="sm-mark__dg-ring" cx="176" cy="248" r="9"/>
  <circle class="sm-mark__dg-dot" cx="176" cy="248" r="3.5"/>
  <circle class="sm-mark__dg-ring" cx="64" cy="248" r="9"/>
  <circle class="sm-mark__dg-dot" cx="64" cy="248" r="3.5"/>`;
const diagramSvg = (parts) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 272" focusable="false">${parts.join('')}</svg>`;
const HELP_DIAGRAM = diagramSvg([DIAGRAM_DOOR, DIAGRAM_SHEET, DIAGRAM_MARKS]);
const HELP_DIAGRAM_NO_SHEET = diagramSvg([DIAGRAM_DOOR, DIAGRAM_MARKS]);

/**
 * Whether the door screen may be entered (see canEnterDoor in mark-common.js):
 *  - `method` 'ar': never;
 *  - `method` 'estimate': with a photo;
 *  - otherwise (paper, or no method): a photo and a sheet whose corners count as placed. The
 *    stand-in rectangle the sheet screen shows after a failed detection does not count until the
 *    customer has moved a corner (`placed`).
 * @param {object} state
 * @returns {boolean}
 */
export function canEnter(state) {
  return canEnterDoor(state);
}

/**
 * Colour of the door quad: a high-visibility green, unless the skin's accent
 * (used for the sheet outline drawn alongside it) is that same colour.
 * @param {object} config
 * @param {string} accent
 * @returns {string}
 */
function doorColor(config, accent) {
  const colors = config.brand?.colors ?? {};
  const success = themeColor('--sm-success', colors.success || FALLBACK_SUCCESS);
  if (success.toLowerCase() !== accent.toLowerCase()) return success;
  return themeColor('--sm-primary', colors.primary || FALLBACK_PRIMARY);
}

/**
 * isConfident() for a detection that may be missing or malformed: never throws.
 * @param {object | null} detection
 * @returns {boolean}
 */
function confidentOf(detection) {
  if (!detection || typeof detection !== 'object') return false;
  try {
    return isConfident(detection) === true;
  } catch {
    return false;
  }
}

/**
 * Where the handles start for a detection (or none): its quad when it found one, else the
 * detector's own fallback rectangle, else the old fixed one. Never throws.
 * @param {object} photo
 * @param {object | null} detection
 * @returns {{ x: number, y: number }[]}
 */
function startPoints(photo, detection) {
  try {
    const quad = startingQuad(photo, detection);
    if (isQuad(quad)) return copyQuad(quad);
  } catch {
    // Fall through to the fixed rectangle below.
  }
  return defaultDoorQuad(photo.width, photo.height);
}

/**
 * Run `fn` once the browser has painted what is on screen now: a frame, then a task. Detection
 * may fall back to the main thread (no module Worker), and must not hold up the first sight of
 * the photo.
 * @param {() => void} fn
 * @returns {() => void} Cancel.
 */
function afterPaint(fn) {
  let frame = 0;
  let timer = 0;
  const later = () => {
    frame = 0;
    timer = setTimeout(fn, 0);
  };
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(later);
  else later();
  return () => {
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

/**
 * Build the door screen.
 * @param {HTMLElement} root The empty screen <section>.
 * @param {object} ctx App context.
 * @returns {() => void} Cleanup.
 */
export function mount(root, ctx) {
  const { state, config, ui } = ctx;
  const t = (key, vars) => ctx.t(key, vars);
  const photo = state.photo;
  const estimate = state.method === 'estimate';
  const isDemo = photo.isDemo === true || photo.capture === 'demo';
  if (!state.door || typeof state.door !== 'object') state.door = { points: null, detection: null };

  let disposed = false;
  let cancelSearch = null;
  // Stops the background search once this screen has gone (a 'timeout': the next visit looks again).
  let searchAbort = null;
  let releaseTimer = 0;
  // What findDoor() made of this photo; null until it has looked (the paper path comes here without).
  // A search that ran out of time has not looked, as far as this screen is concerned: it looks again
  // (isSettledDetection), or the handles would stay on the fallback rectangle for good.
  let detection = isSettledDetection(state.door.detection) ? state.door.detection : null;
  let searching = detection === null;
  // Kept inside the photo like the handles, so the handles on one can be recognised (outlineIndexOf).
  const bounds = { width: photo.width, height: photo.height };
  let outlines = doorOutlines(detection, bounds);

  // Corners kept from an earlier visit (moved, a chosen outline, or measured), or none.
  const saved = isQuad(state.door.points) ? copyQuad(state.door.points) : null;
  // Which handles the customer put where they are themselves, by handle index. Kept with the corners
  // (state.door.byHand), so a detected outline measured untouched is still the detector's when the
  // customer comes back to adjust it: it is measured with detection's error, not a hand's (doorCornerSigmaPx).
  let byHand = cornersByHand(saved ? state.door.byHand : null);
  // Measuring the untouched starting rectangle would give a confident-looking
  // but meaningless size, so require the corners to have been placed (see doorCornersPlaced).
  let touched = byHand.some(Boolean);
  // True from the first report of a handle moving, and for an earlier visit's corners: a late detection
  // never moves the handles once the customer has moved one, nor replaces an earlier visit's. A tap, a
  // pan or a pinch that moved no handle does not count: the fallback rectangle is nobody's, and a detection
  // dropped for it could not be got back with a single outline (there is no "next outline" to show). A
  // handle held under a finger, or a selected one, is not moved either (pressGate, showSearchResult).
  let handled = saved !== null;
  // An outline picked with "Not this? Show the next outline", on this visit or an earlier one.
  let chosen = saved !== null && state.door.chosen === true;
  // Where the handles were last put down, starting with what the editor is given. A press on a
  // handle that leaves it exactly there has placed nothing.
  let committed = saved ?? startPoints(photo, detection);
  // Which of `outlines` the handles were put on (-1: none, or the customer's own corners).
  let outline = outlineIndexOf(outlines, committed);
  // Fingers on the photo right now; what the late search changes waits for them (see pressGate).
  const gate = pressGate();

  const accent = themeColor('--sm-accent', config.brand?.colors?.accent || FALLBACK_ACCENT);

  const measureBtn = ui.button(t(estimate ? 'door.estimate.measure' : 'door.measure'), {
    icon: 'ruler',
    onClick: measure,
  });
  // Not ctx.back(): after "Adjust corners" on the result screen the previous
  // history entry is that screen, not the step this button names.
  let backBtn;
  if (!estimate) {
    backBtn = ui.button(t('door.back'), { variant: 'ghost', icon: 'arrow-left', onClick: () => ctx.go('sheet') });
  } else if (isDemo) {
    // The demo photo came from the welcome screen; there is nothing to retake.
    backBtn = ui.button(t('door.estimate.back.demo'), {
      variant: 'ghost',
      icon: 'arrow-left',
      onClick: () => ctx.go('welcome'),
    });
  } else {
    backBtn = ui.button(t('door.estimate.back'), { variant: 'ghost', icon: 'camera', onClick: () => ctx.go('capture') });
  }

  const diagram = ui.svgFromString(estimate ? HELP_DIAGRAM_NO_SHEET : HELP_DIAGRAM);
  diagram.classList.add('sm-mark__diagram');
  diagram.removeAttribute('aria-hidden');
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', t(estimate ? 'door.estimate.help.diagram' : 'door.help.diagram'));

  const guidance = (iconName, key) =>
    ui.h(
      'li',
      { class: 'sm-mark__help-item' },
      ui.h('span', { class: 'sm-mark__help-icon' }, ui.icon(iconName, 20)),
      ui.h('span', { class: 'sm-grow', text: t(key) }),
    );

  // The bottom sheet is appended to <body>, outside this screen's root, so its
  // content carries the sm-mark class itself to pick up the mark.css rules.
  const help = ui.bottomSheet(
    { title: t('door.help.title') },
    ui.h(
      'div',
      { class: 'sm-mark sm-mark--help' },
      diagram,
      ui.h(
        'ul',
        { class: 'sm-mark__help-list' },
        guidance('door', 'door.help.opening'),
        // There is no sheet of paper on the no-paper path.
        estimate ? guidance('ruler', 'door.estimate.help.exact') : guidance('paper', 'door.help.plane'),
      ),
      ui.button(t('door.help.close'), { variant: 'secondary', onClick: () => help.close() }),
    ),
  );

  const helpBtn = ui.h(
    'button',
    {
      class: 'sm-mark__float sm-mark__fab',
      type: 'button',
      attrs: {
        'aria-label': t('door.help.open'),
        'aria-haspopup': 'dialog',
        title: t('door.help.open'),
      },
      on: { click: () => help.open() },
    },
    ui.icon('help', 22),
  );

  // In the action bar rather than floating over the photo: the top of the photo is
  // where a door's top corners usually are, and a handle under a floating button
  // cannot be grabbed. Small, so its long label stays on one line on a 320px phone
  // and the bar takes as little from the photo as it can.
  const outlineBtn = ui.button(t('door.outline.next'), {
    variant: 'secondary',
    size: 'sm',
    icon: 'refresh',
    onClick: showNextOutline,
  });
  outlineBtn.hidden = true;

  const mark = createMarkScreen(root, ctx, {
    title: t(estimate ? 'door.estimate.title' : 'door.title'),
    banner: bannerNow(),
    labels: {
      nudge: t('door.nudge.label'),
      up: t('door.nudge.up'),
      down: t('door.nudge.down'),
      left: t('door.nudge.left'),
      right: t('door.nudge.right'),
      fit: t('door.fit'),
    },
    actions: [measureBtn, outlineBtn, backBtn],
    editor: {
      points: committed,
      color: doorColor(config, accent),
      ariaLabel: t('door.editor.aria'),
      // The sheet the door is measured against; the no-paper estimate has none.
      ghost: estimate ? null : { points: copyQuad(state.sheet.points), color: accent },
      onChange,
      onTap,
    },
    onReady: () => {
      if (searching) cancelSearch = afterPaint(lookForDoor);
    },
  });
  mark.tools.append(helpBtn);
  renderOutlineButton();

  // On a short screen (a phone on its side) the bar is one row, with these two shrunk to their icons
  // (see mark.css): three full-width rows would leave the photo almost no height.
  mark.actionBar.classList.add('sm-mark__doorbar');
  outlineBtn.classList.add('sm-mark__compact');
  backBtn.classList.add('sm-mark__compact');

  // Capture phase, so these see every press before the editor acts on it.
  const stageListenerOptions = { capture: true, passive: true };
  const onPress = (event) => {
    if (!isPhotoTarget(event.target)) return;
    gate.press(event.pointerId, event.isPrimary === true);
  };
  const onRelease = (event) => {
    const run = gate.release(event.pointerId);
    if (!run) return;
    clearTimeout(releaseTimer);
    // This listener runs before the editor's own pointerup: let it put the handle down first. Pressed
    // again by then, the change waits for that press too.
    releaseTimer = setTimeout(() => gate.whenReleased(run), 0);
  };
  mark.stage.addEventListener('pointerdown', onPress, stageListenerOptions);
  for (const type of RELEASE_EVENTS) mark.stage.addEventListener(type, onRelease, stageListenerOptions);

  /** The banner for where things stand now (see doorBannerKind). */
  function bannerNow() {
    const kind = doorBannerKind({
      searching,
      confident: confidentOf(detection),
      chosen,
      outline,
      outlines: outlines.length,
    });
    const banner = BANNERS[kind] ?? BANNERS.place;
    return { text: t(banner.key, { n: outline + 1, total: outlines.length }), tone: banner.tone };
  }

  function renderBanner() {
    const banner = bannerNow();
    mark.banner.update(banner.text, banner.tone);
  }

  function renderOutlineButton() {
    // Only worth offering when detection considered more than one outline.
    outlineBtn.hidden = searching || outlines.length < 2;
  }

  /** The guard in front of measuring: see doorCornersPlaced. */
  function placed() {
    return doorCornersPlaced({ moved: touched, chosen, confident: confidentOf(detection), outline });
  }

  /**
   * Look for the door in the photo (only when nobody has yet), then start the handles on it unless the
   * customer has moved or selected one: their own corners always win over a late suggestion.
   */
  async function lookForDoor() {
    cancelSearch = null;
    const search = new AbortController();
    searchAbort = search;
    let result = null;
    try {
      // The capture screen's framing guide, when it left one, keeps the search on the door the customer
      // lined up, as it did for the search that ran out of time there.
      const prior = isQuad(state.door.prior) ? copyQuad(state.door.prior) : null;
      // In the background: the customer may be dragging a corner meanwhile, so a worker slow to start ends
      // as a 'timeout' rather than a main-thread search freezing the page; and stopped if the screen goes.
      result = await findDoor(photo, {
        prior,
        timeoutMs: BACKGROUND_SEARCH_TIMEOUT_MS,
        loadTimeoutMs: BACKGROUND_SEARCH_TIMEOUT_MS,
        background: true,
        signal: search.signal,
      });
    } catch {
      // findDoor never rejects; this is only belt and braces.
      result = null;
    }
    // Only for the photo it looked at, in the session it was run in: a reset or a retake replaced it.
    // Never a search that ran out of time or was given up (this screen left, or the worker was slow to
    // start), so the next visit looks again; it replaces one that did.
    const current = ctx.state === state && state.photo === photo;
    if (current && isSettledDetection(result) && !isSettledDetection(state.door.detection)) state.door.detection = result;
    if (disposed) return;

    // Nothing the search changes happens while a finger is on the photo: a handle held there must not be
    // moved from under it, and the new banner and the outline button can change the height of the photo,
    // which would slide the handle being dragged away from the fingertip (see pressGate). Once the finger
    // is up, what that press did (moved a handle, selected one, or neither) decides.
    gate.whenReleased(() => showSearchResult(result));
  }

  /**
   * What the finished search changes: the handles, if the customer has not moved or selected one, then
   * the banner, the outline button and the photo's room.
   * @param {object | null} result What findDoor() answered.
   */
  function showSearchResult(result) {
    if (disposed) return;
    searching = false;
    detection = result && typeof result === 'object' ? result : null;
    outlines = doorOutlines(detection, bounds);
    const editor = mark.editor;
    let placedNow = false;
    // A selected handle is the customer's too, whatever `handled` says: it is never moved or let go of.
    if (!handled && !chosen && editor && editor.getActive() === null) {
      const start = startPoints(photo, detection);
      editor.setPoints(copyQuad(start));
      // The editor keeps every handle inside the photo; remember where it actually put them.
      committed = editor.getPoints() ?? start;
      outline = outlineIndexOf(outlines, start);
      placedNow = true;
    } else {
      outline = outlineIndexOf(outlines, editor ? editor.getPoints() : committed);
    }
    renderBanner();
    renderOutlineButton();
    // The banner and the action bar may have changed height: give the photo its new room now.
    mark.flushLayout();
    // The customer may have zoomed in to look before any handle moved: show the whole photo, where the
    // handles now are. (Nothing happens when the view already shows it.)
    if (placedNow) editor.resetView();
    mark.sync();
  }

  /** "Not this? Show the next outline": put the handles on the next outline detection considered. */
  function showNextOutline() {
    const editor = mark.editor;
    if (!editor || outlines.length < 2) return;
    outline = nextOutlineIndex(outline, outlines.length);
    if (outline < 0) return;
    chosen = true;
    editor.setPoints(copyQuad(outlines[outline]));
    committed = editor.getPoints() ?? copyQuad(outlines[outline]);
    // Every handle is now where detection put it, none where the customer did.
    byHand = cornersByHand(null);
    // A chosen outline counts as placed, here and when the customer comes back to adjust it.
    keepCorners(committed);
    invalidateMeasurement(state);
    editor.setActive(null);
    renderBanner();
    // The banner may now wrap to a different height: let the editor pick up the new stage size
    // before showing the whole photo, which is where the outlines differ.
    mark.flushLayout();
    editor.resetView();
    mark.sync();
  }

  function onChange(points, meta) {
    handled = true;
    if (!meta.final || sameQuad(points, committed)) return;
    byHand = markCornersByHand(byHand, committed, points);
    committed = points;
    touched = true;
    keepCorners(points);
    invalidateMeasurement(state);
  }

  /**
   * Keep the corners for "Adjust corners" and Back / Forward, with where they came from: which handles
   * the customer placed (byHand) and whether they picked the outline (chosen). The corners alone would
   * not say, and a detected outline measured untouched would come back as the customer's own.
   */
  function keepCorners(points) {
    state.door.points = copyQuad(points);
    state.door.byHand = [...byHand];
    state.door.chosen = chosen;
  }

  /**
   * The corners' error to measure with (see doorCornerSigmaPx): `handSigmaPx` for each corner the customer
   * placed, detection's for each one still where detection put it, as one figure for all four.
   * @param {number} handSigmaPx A corner placed by hand's error, image px.
   * @returns {number | null} null only for an unusable `handSigmaPx` with every corner by hand: the
   *   measuring code's own default then applies.
   */
  function cornerSigmaPx(handSigmaPx) {
    return doorCornerSigmaPx({ byHand, handSigmaPx, imageWidth: photo.width, imageHeight: photo.height });
  }

  /** A tap's corner error on this photo: what estimateFromCorners takes when it is given none. */
  function tapSigmaPx() {
    return (ESTIMATE_THRESHOLDS.tapSigmaPxAt2048 * Math.max(photo.width, photo.height)) / 2048;
  }

  function onTap() {
    // A tap on the photo lets go of the selected corner, which frees up any
    // handle sitting under the nudge pad.
    const editor = mark.editor;
    if (!editor) return;
    editor.setActive(null);
    mark.sync();
  }

  function measure() {
    const editor = mark.editor;
    if (!editor) return;
    const points = editor.getPoints();
    if (!isQuad(points)) return;
    if (!placed()) {
      ctx.toast(t('door.error.untouched'), { type: 'info' });
      return;
    }
    if (estimate) measureEstimate(points);
    else measurePaper(points);
  }

  /** Paper: fit the marked sheet and the door together (unchanged from before the no-paper path). */
  function measurePaper(points) {
    if (!isQuad(state.sheet?.points)) return;
    const m = config.measurement;
    let r;
    try {
      r = measureDoor({
        sheetPx: state.sheet.points,
        doorPx: points,
        sheetMm: getSheetMm(state, config),
        imageSize: { width: photo.width, height: photo.height },
        sigmaSheetPx: state.sheet.refined ? m.sigmaSheetRefinedPx : m.sigmaSheetManualPx,
        // m.sigmaDoorPx is for corners dragged into place; a detected one left as it was is as good as detection.
        sigmaDoorPx: cornerSigmaPx(m.sigmaDoorPx),
        plausible: m.plausible,
      });
    } catch {
      r = { ok: false, error: 'degenerate' };
    }
    if (!r || !r.ok) {
      const key = (r && ERROR_KEYS.get(r.error)) || ERROR_KEYS.get('degenerate');
      ctx.toast(t(key), { type: 'error', duration: ERROR_TOAST_MS });
      return;
    }

    keepCorners(points);
    state.measure = { ...r, method: 'paper' };
    state.size = {
      ...applyMeasurementRules(m, { widthMm: r.widthMm, heightMm: r.heightMm }),
      source: 'photo',
    };
    // Same payload shape as the result screen sends for a size chosen there.
    const measured = {
      widthMm: state.size.widthMm,
      heightMm: state.size.heightMm,
      source: 'photo',
      quality: r.quality.level,
      sigmaWidthMm: r.sigmaWidthMm,
      sigmaHeightMm: r.sigmaHeightMm,
    };
    // The bundled demo door, not the customer's own: said here as it is on the enquiry.
    if (isDemo) measured.demo = true;
    ctx.emit('measured', measured);
    ctx.go('result');
  }

  /**
   * No paper: match the shape of the marked opening to the nearest standard door sizes. There is no
   * scale in the photo, so the size is always one of the company's own catalogue sizes, and the
   * result screen says it is an estimate to be confirmed by a check measure.
   */
  function measureEstimate(points) {
    const m = config.measurement;
    let r;
    try {
      const focal = photoFocal(photo) ?? {};
      const input = {
        // The outline the customer sees, in [TL, TR, BR, BL] order, whichever handle is on which corner.
        corners: cornersInOutlineOrder(points),
        imageWidth: photo.width,
        imageHeight: photo.height,
        focalPx: focal.focalPx,
        // photoFocal names it `source`; estimateFromCorners takes it as `focalSource`.
        focalSource: focal.focalSource ?? focal.source,
        sizes: standardSizesFrom(config),
      };
      // Its own corner error is a tap's; a detected corner left as it was is as good as detection, so
      // the estimate is not more sure of a size than the corners allow. Left out when all are by hand,
      // so the estimate's own default applies.
      if (!byHand.every(Boolean)) input.cornerSigmaPx = cornerSigmaPx(tapSigmaPx());
      r = estimateFromCorners(input);
    } catch {
      r = { ok: false, error: 'degenerate' };
    }
    const best = r && r.ok && Array.isArray(r.candidates) ? r.candidates[0] : null;
    if (!best || !Number.isFinite(best.widthMm) || !Number.isFinite(best.heightMm)) {
      const key = (r && !r.ok && ESTIMATE_ERROR_KEYS.get(r.error)) || ESTIMATE_ERROR_KEYS.get('degenerate');
      ctx.toast(t(key), { type: 'error', duration: ERROR_TOAST_MS });
      return;
    }

    keepCorners(points);
    state.measure = r;
    state.size = {
      ...applyMeasurementRules(m, { widthMm: best.widthMm, heightMm: best.heightMm }),
      source: 'estimate',
      standard: true,
    };
    const measured = {
      widthMm: state.size.widthMm,
      heightMm: state.size.heightMm,
      source: 'estimate',
      standard: true,
    };
    if (isDemo) measured.demo = true;
    ctx.emit('measured', measured);
    ctx.go('result');
  }

  return () => {
    disposed = true;
    if (cancelSearch) cancelSearch();
    if (searchAbort) searchAbort.abort();
    clearTimeout(releaseTimer);
    gate.clear();
    mark.stage.removeEventListener('pointerdown', onPress, stageListenerOptions);
    for (const type of RELEASE_EVENTS) mark.stage.removeEventListener(type, onRelease, stageListenerOptions);
    mark.destroy();
    // Close the help sheet if it is still open, so nothing is left on <body>.
    try {
      help.close();
      help.el.remove();
    } catch {
      // The sheet was never opened, so there is nothing to tidy up.
    }
  };
}
