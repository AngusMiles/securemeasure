/**
 * SecureMeasure application shell.
 *
 * Loads the (optionally skinned) config, applies the theme, builds the shared `ctx` object and
 * runs the screen router: one screen module is mounted at a time as the sole child of .sm-main,
 * with browser history kept in step so the phone's back button works.
 *
 * The customer comes in one of five ways, all from the welcome screen:
 *   AR (Android + ARCore only)   welcome -> ar -> result
 *   the live camera              welcome -> capture -> door -> result
 *   the demo photo               welcome -> door -> result
 *   a sheet of paper (exact)     welcome -> prepare -> sheet -> door -> result
 *   a size they already know     welcome -> result
 * and every way then carries on to quote -> details -> done. `state.method` records which of the
 * photo ways is in use ('paper', 'estimate' or 'ar'); the door and sheet screens read it.
 */

import { loadConfig, applyTheme, measurementMethods } from './theme.js';
import * as ui from './ui.js';
import { COMMON, buildStrings, createTranslator } from './strings.js';
import * as welcome from './screens/welcome.js';
import * as prepare from './screens/prepare.js';
import * as capture from './screens/capture.js';
import * as ar from './screens/ar.js';
import * as sheet from './screens/sheet.js';
import * as door from './screens/door.js';
import * as result from './screens/result.js';
import * as quote from './screens/quote.js';
import * as details from './screens/details.js';
import * as done from './screens/done.js';

const SCREENS = { welcome, prepare, capture, ar, sheet, door, result, quote, details, done };

/**
 * Every screen, earliest first. The router reads it two ways: a screen that cannot be entered falls
 * back to the nearest earlier one that can (see resolveScreenId), and moving to an earlier screen
 * returns to that screen's history entry instead of stacking a new one (see go() in startApp).
 * @type {ReadonlyArray<string>}
 */
export const SCREEN_ORDER = Object.freeze([
  'welcome',
  'prepare',
  'capture',
  'ar',
  'sheet',
  'door',
  'result',
  'quote',
  'details',
  'done',
]);
const TOTAL_STEPS = 4;

/**
 * Progress step of each screen. Used only when a screen module's own `step` export is missing or
 * malformed; tests/app.test.mjs checks that every module agrees with it.
 * @type {Readonly<Record<string, number>>}
 */
export const FALLBACK_STEPS = Object.freeze({
  welcome: 1,
  prepare: 1,
  capture: 1,
  ar: 2,
  sheet: 2,
  door: 2,
  result: 3,
  quote: 4,
  details: 4,
  done: 4,
});

/**
 * Who may enter each screen, given the shared state. Used only when a screen module's own `canEnter`
 * export is missing; it mirrors those exports (tests/app.test.mjs checks that they agree).
 * @type {Readonly<Record<string, (state: object) => boolean>>}
 */
export const FALLBACK_GUARDS = Object.freeze({
  welcome: () => true,
  prepare: () => true,
  capture: () => true,
  ar: () => true,
  // The sheet of paper belongs to the paper method only; a photo for the estimate has none to mark.
  sheet: (state) => state.method !== 'estimate' && state.method !== 'ar' && Boolean(state.photo),
  door: (state) => {
    // AR measures the opening itself and goes straight to the result.
    if (state.method === 'ar') return false;
    if (state.method === 'estimate') return Boolean(state.photo);
    // The paper method (and a null method, from before the customer chose one) needs a marked sheet.
    return Boolean(state.photo && state.sheet && state.sheet.points && state.sheet.placed !== false);
  },
  result: (state) => Boolean(state.measure || state.manualEntry),
  quote: (state) => Boolean(state.size),
  details: (state) => Boolean(state.size && state.quoteInput && state.quoteInput.productId),
  done: (state) => Boolean(state.submission),
});

/**
 * Screens that belong to one way in only, and the `state.method` that way sets. None has a guard
 * (each can always be entered, to start or restart its way in), so without this the fallback in
 * resolveScreenId would stop at whichever of them sits nearest in SCREEN_ORDER: a paper customer
 * whose photo is gone would be sent to the AR screen, on a phone that may not even do AR, and a
 * customer back from the camera or the demo would be sent to the paper method's "Get set up".
 */
const METHOD_SCREENS = Object.freeze({ prepare: 'paper', capture: 'estimate', ar: 'ar' });

/**
 * May `candidate` stand in for a screen that cannot be entered? Any screen but a way in's own may; a way
 * in's own screen only on that way. "Get set up" is also where the paper method starts, so it may stand
 * in before any way in is chosen (`state.method` null, the paper method's own convention), as long as
 * the company offers the paper method at all.
 */
function isFallbackFor(candidate, state, methods) {
  const onlyFor = METHOD_SCREENS[candidate];
  if (!onlyFor) return true;
  const method = state ? state.method : null;
  if (method === onlyFor) return true;
  return candidate === 'prepare' && method == null && !(methods && methods.paper === false);
}

/**
 * Where a request for screen `id` lands: `id` itself if it may be entered, otherwise the furthest
 * earlier screen that may and that belongs to the way in being used (see METHOD_SCREENS), otherwise
 * the welcome screen. An unknown id lands on the welcome screen.
 *
 * @param {string} id               the requested screen
 * @param {object} state            the shared state (for `state.method`)
 * @param {(id: string) => boolean} canEnter  the router's guard check for a screen id
 * @param {{ paper?: boolean }} [methods]  the ways in the company offers (measurementMethods in
 *   js/theme.js); left out, every way in counts as offered
 * @returns {string} a screen id from SCREEN_ORDER
 */
export function resolveScreenId(id, state, canEnter, methods) {
  const index = SCREEN_ORDER.indexOf(id);
  if (index < 0) return 'welcome';
  for (let i = index; i > 0; i -= 1) {
    const candidate = SCREEN_ORDER[i];
    // Asked for by name, a way in's own screen is always fine; as a fallback only on its own way.
    if (i < index && !isFallbackFor(candidate, state, methods)) continue;
    if (canEnter(candidate)) return candidate;
  }
  return 'welcome';
}

/** Screens with a photo picker that the start-up code returns to when the page was lost mid-photo. */
const RESTORABLE_SCREENS = Object.freeze(['prepare', 'capture']);

/** The string id of each of those screens' "Choose a photo" button, named in the message shown then. */
const CHOOSE_LABEL_KEYS = Object.freeze({ prepare: 'prepare.choose', capture: 'capture.fallback.choose' });

/**
 * The screen to pick up again after a reload the customer never asked for, read from the history
 * entry the page came back to (see "interrupted photo" in startApp), or null for a normal start.
 *
 * @param {unknown} entry  history.state
 * @returns {string | null} 'prepare' or 'capture', or null
 */
export function interruptedPhotoScreen(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!RESTORABLE_SCREENS.includes(entry.screen)) return null;
  return entry.picking && typeof entry.picking === 'object' ? entry.screen : null;
}

const TOAST_ICONS = { info: 'info', success: 'check', error: 'alert' };
const MAX_TOASTS = 3;
/** How long to wait for the browser to report a history.go() before navigating without it. */
const TRAVEL_TIMEOUT_MS = 700;
const LOG_PREFIX = '[SecureMeasure]';

/** Where the app's own modules are served from. Anything else that runs in the page is somebody else's code. */
const APP_ROOT = new URL('..', import.meta.url).href;
const OWN_SCRIPT_ROOTS = [`${APP_ROOT}js/`, `${APP_ROOT}skins/`];

/** True when `text` (a script address or an error's stack) points at one of the app's own modules. */
function mentionsOwnScript(text) {
  return typeof text === 'string' && OWN_SCRIPT_ROOTS.some((root) => text.includes(root));
}

/**
 * Create a fresh shared state object for one measuring session.
 *
 * @param {object} config The merged config.
 * @returns {object} The state described in the build contract (`ctx.state`).
 */
export function createInitialState(config) {
  const measurement = (config && config.measurement) || {};
  return {
    // The photo way in the customer chose: 'paper' (prepare.js), 'estimate' (capture.js and the welcome
    // demo) or 'ar' (ar.js, once it has a measurement); null until then. setPhoto() leaves it alone.
    method: null,
    manualEntry: false,
    referenceId: measurement.defaultReferenceId,
    customReference: { widthMm: null, heightMm: null },
    // The customer's own sheet choice, set aside while the paper demo photo is loaded (js/demo.js).
    ownReference: null,
    photo: null,
    sheet: { points: null, refined: false, detected: false },
    // detection: findDoor()'s result for the current photo, or null until it has run (js/door-find.js).
    door: { points: null, detection: null },
    measure: null,
    size: null,
    quoteInput: { productId: null, selections: {}, includeInstallation: null },
    quote: null,
    customer: {},
    // Reference and time of the first send, reused when a failed send is tried again (details.js).
    leadAttempt: null,
    submission: null,
  };
}

/**
 * Resolve once the browser has had a chance to paint. requestAnimationFrame never fires in a
 * hidden tab, so a timer backs it up rather than leaving the caller waiting forever.
 */
function nextPaint() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, 120);
  });
}

/** `config.embed.parentOrigin` as a bare origin, or '' when unset, '*' or not a URL. */
function normaliseOrigin(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*') return '';
  try {
    const { origin } = new URL(trimmed);
    return origin && origin !== 'null' ? origin : '';
  } catch {
    return '';
  }
}

function isEditable(el) {
  return Boolean(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true);
}

function findShell() {
  const app = document.getElementById('sm-app');
  const main = document.getElementById('sm-main');
  if (!app || !main) return null;
  return {
    app,
    main,
    back: document.getElementById('sm-back'),
    brand: document.getElementById('sm-brand'),
    stepper: document.getElementById('sm-stepper'),
    stepCount: document.getElementById('sm-step-count'),
    stepName: document.getElementById('sm-step-name'),
    segments: Array.from(app.querySelectorAll('.sm-progress__seg')),
    toasts: document.getElementById('sm-toasts'),
    busy: document.getElementById('sm-busy'),
    busyMessage: document.getElementById('sm-busy-message'),
  };
}

function showBootFailure(els) {
  els.main.replaceChildren(
    ui.h(
      'section',
      { class: 'sm-screen' },
      ui.card({ class: 'sm-crash' }, ui.h('span', { class: 'sm-crash__icon' }, ui.icon('alert', 28)), ui.h('p', { text: COMMON['common.bootFailed'] })),
    ),
  );
}

/**
 * Build ctx, wire the shell chrome and show the first screen.
 *
 * @param {object} config The merged config.
 * @param {ReturnType<typeof findShell>} els Shell elements from index.html.
 */
function startApp(config, els) {
  const strings = buildStrings(SCREEN_ORDER.map((id) => SCREENS[id]));
  const t = createTranslator(config, strings);
  let state = createInitialState(config);
  const methods = measurementMethods(config);
  const embedded = window.parent !== window;
  const parentOrigin = normaliseOrigin(config.embed && config.embed.parentOrigin);

  /** @type {{ id: string, root: HTMLElement, cleanup: (() => void) | null } | null} */
  let current = null;
  let navToken = 0;
  let lastErrorToastAt = 0;
  const toasts = [];
  const busyStack = [];

  // ----- guards and steps -----

  function canEnter(id) {
    const module = SCREENS[id];
    const guard = module && typeof module.canEnter === 'function' ? module.canEnter : FALLBACK_GUARDS[id];
    try {
      return Boolean(guard(state));
    } catch (error) {
      console.error(`${LOG_PREFIX} canEnter("${id}") threw`, error);
      return false;
    }
  }

  /** The requested screen if it may be entered, otherwise the furthest earlier screen that may (resolveScreenId). */
  function resolveScreen(id) {
    if (!SCREEN_ORDER.includes(id)) console.warn(`${LOG_PREFIX} unknown screen "${id}"`);
    return resolveScreenId(id, state, canEnter, methods);
  }

  function stepOf(id) {
    const step = SCREENS[id] && SCREENS[id].step;
    return Number.isInteger(step) && step >= 1 && step <= TOTAL_STEPS ? step : FALLBACK_STEPS[id];
  }

  // ----- history -----

  /** The screen held by each of our history entries written or visited in this page load, by idx. */
  const trail = [];
  /**
   * A history.go() of ours that the browser has not reported yet: { screen, next }. `screen` is where the
   * move must end, or null for "one more step back, wherever that leads" (see the popstate handler).
   */
  let travelling = null;
  /** The history idx of the entry the visible screen belongs to; tells a Back move from a Forward one. */
  let shownIdx = 0;

  function historyIndex() {
    const entry = history.state;
    return entry && Number.isInteger(entry.idx) ? entry.idx : 0;
  }

  /** Sandboxed iframes and rapid-fire calls can make the History API throw; navigation must still happen. */
  function writeHistory(screen, idx, push) {
    try {
      if (push) history.pushState({ screen, idx }, '');
      else history.replaceState({ screen, idx }, '');
    } catch (error) {
      console.warn(`${LOG_PREFIX} history update failed`, error);
      return;
    }
    // A push drops every entry that was ahead of us.
    if (push) trail.length = idx;
    trail[idx] = screen;
    shownIdx = idx;
  }

  /**
   * Move `delta` entries through our own history. The popstate handler then shows `screen` (or, for a
   * null `screen`, whatever the entry it lands on holds); if the browser never reports the move (no
   * such entry, history unavailable), `otherwise` runs instead. `next` runs once the move is over.
   */
  function travel(delta, screen, otherwise, next = null) {
    const trip = { screen, next };
    const abandon = () => {
      if (travelling !== trip) return;
      travelling = null;
      if (otherwise) otherwise();
      if (trip.next) trip.next();
    };
    travelling = trip;
    try {
      history.go(delta);
    } catch (error) {
      console.warn(`${LOG_PREFIX} history update failed`, error);
      abandon();
      return;
    }
    setTimeout(abandon, TRAVEL_TIMEOUT_MS);
  }

  /** After a restart, step back to our first entry so Back leaves the app instead of replaying the old session. */
  function rewind() {
    const idx = historyIndex();
    if (idx > 0) travel(-idx, 'welcome');
  }

  // ----- interrupted photo -----
  //
  // A phone short of memory can close this page while its camera app is in front. The page then loads
  // afresh when the customer comes back and the photo never arrives. A history entry survives that, so
  // while a photo picker is open the entry carries a note of the sheet the customer chose (`picking`);
  // the start-up code at the bottom of startApp() looks for it. Both "Get set up" (the paper method) and
  // the camera screen ("Use your camera app instead") open the phone's camera app this way.

  /** True from the tap that opens a photo picker until the page shows it is still here. */
  let pickerOpen = false;

  /** Put `note` on the current history entry, or take the note off again when it is null. */
  function setPickerNote(note) {
    const entry = history.state;
    if (!entry || typeof entry.screen !== 'string' || (!note && !entry.picking)) return;
    try {
      history.replaceState(note ? { ...entry, picking: note } : { screen: entry.screen, idx: entry.idx }, '');
    } catch (error) {
      console.warn(`${LOG_PREFIX} history update failed`, error);
    }
  }

  /**
   * If the page went away while a photo was being taken on "Get set up" or the camera screen, put the
   * customer's sheet choice back into the (fresh) state and return that screen: it is where to pick up
   * again. Returns null for a normal start.
   */
  function restoreInterruptedPhoto() {
    const entry = history.state;
    const screen = interruptedPhotoScreen(entry);
    if (!screen) return null;
    const note = entry.picking;
    if (typeof note.referenceId === 'string') state.referenceId = note.referenceId;
    const custom = note.customReference;
    if (custom && typeof custom === 'object') {
      for (const side of ['widthMm', 'heightMm']) {
        if (Number.isFinite(custom[side])) state.customReference[side] = custom[side];
      }
    }
    return screen;
  }

  /** The label of `screen`'s "Choose a photo" button, for the interrupted-photo message. */
  function chooseLabel(screen) {
    const key = CHOOSE_LABEL_KEYS[screen] || CHOOSE_LABEL_KEYS.prepare;
    const label = t(key);
    // The translator hands back the key itself for copy that does not exist.
    return label === key ? t(CHOOSE_LABEL_KEYS.prepare) : label;
  }

  // ----- chrome -----

  function renderBrand() {
    const brand = config.brand || {};
    const name = brand.name || '';
    const wordmark = () => ui.h('span', { class: 'sm-brand__name', text: name });
    if (!brand.logoUrl) {
      els.brand.replaceChildren(wordmark());
      return;
    }
    const logo = ui.h('img', { class: 'sm-brand__logo', alt: name, attrs: { decoding: 'async' } });
    logo.addEventListener('error', () => els.brand.replaceChildren(wordmark()), { once: true });
    logo.src = brand.logoUrl;
    els.brand.replaceChildren(logo);
  }

  function updateHeader(id) {
    const step = stepOf(id);
    els.stepCount.textContent = t('common.step', { n: step, total: TOTAL_STEPS });
    els.stepName.textContent = t(`common.steps.${step}`);
    els.stepper.hidden = false;
    els.segments.forEach((segment, index) => segment.classList.toggle('is-done', index < step));
    els.back.hidden = id === 'welcome' || id === 'done';
    // Not "data-screen": that attribute belongs to the screen <section> and must stay unique in the page.
    els.app.dataset.activeScreen = id;
  }

  function focusScreen(root) {
    const target = root.querySelector('[data-autofocus]') || root.querySelector('h1');
    if (!target) return;
    if (target.tagName === 'H1' && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }

  // ----- toasts -----

  function toast(message, { type = 'info', duration = 3500 } = {}) {
    const tone = Object.prototype.hasOwnProperty.call(TOAST_ICONS, type) ? type : 'info';
    // The region is already aria-live="polite"; only errors are promoted to an assertive alert.
    const el = ui.h(
      'div',
      { class: `sm-toast sm-toast--${tone}`, attrs: { role: tone === 'error' ? 'alert' : null } },
      ui.icon(TOAST_ICONS[tone], 20),
      ui.h('p', { class: 'sm-toast__text', text: message === null || message === undefined ? '' : String(message) }),
    );
    const entry = { el, timer: null, gone: false };
    const dismiss = () => {
      if (entry.gone) return;
      entry.gone = true;
      clearTimeout(entry.timer);
      const index = toasts.indexOf(entry);
      if (index >= 0) toasts.splice(index, 1);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 200);
    };
    el.addEventListener('click', dismiss);
    toasts.push(entry);
    els.toasts.appendChild(el);
    while (toasts.length > MAX_TOASTS) {
      const oldest = toasts.shift();
      oldest.gone = true;
      clearTimeout(oldest.timer);
      oldest.el.remove();
    }
    if (Number.isFinite(duration) && duration > 0) entry.timer = setTimeout(dismiss, duration);
    return dismiss;
  }

  function reportError(error) {
    console.error(LOG_PREFIX, error);
    const now = Date.now();
    if (now - lastErrorToastAt < 4000) return;
    lastErrorToastAt = now;
    toast(t('common.error'), { type: 'error', duration: 5000 });
  }

  // ----- busy overlay -----

  function renderBusy() {
    const top = busyStack[busyStack.length - 1];
    els.busy.hidden = !top;
    if (top) {
      els.busyMessage.textContent = top.message;
      els.main.setAttribute('aria-busy', 'true');
    } else {
      els.main.removeAttribute('aria-busy');
    }
  }

  async function busy(asyncFn, message) {
    const entry = { message: message || t('common.working') };
    busyStack.push(entry);
    renderBusy();
    try {
      // Two frames: the first commits the overlay, the second guarantees it has been painted
      // before heavy synchronous work (image processing) blocks the main thread.
      await nextPaint();
      await nextPaint();
      return await (typeof asyncFn === 'function' ? asyncFn() : asyncFn);
    } finally {
      const index = busyStack.indexOf(entry);
      if (index >= 0) busyStack.splice(index, 1);
      renderBusy();
    }
  }

  // ----- embed events -----

  function emit(type, payload) {
    if (!embedded || !parentOrigin) return;
    const message = { source: 'securemeasure', type, payload };
    try {
      window.parent.postMessage(message, parentOrigin);
    } catch {
      // Payloads holding canvases or functions cannot be structured-cloned; send the JSON-safe part.
      try {
        window.parent.postMessage(JSON.parse(JSON.stringify(message)), parentOrigin);
      } catch (error) {
        console.warn(`${LOG_PREFIX} could not post "${type}" to the parent page`, error);
      }
    }
  }

  // ----- screens -----

  function runCleanup(cleanup, id) {
    if (typeof cleanup !== 'function') return;
    try {
      cleanup();
    } catch (error) {
      console.error(`${LOG_PREFIX} cleanup of screen "${id}" threw`, error);
    }
  }

  /** Watches the height of the visible screen's action bar (see trackActionBar). */
  let barObserver = null;

  function unmountCurrent() {
    const previous = current;
    current = null;
    if (barObserver) barObserver.disconnect();
    barObserver = null;
    if (previous) runCleanup(previous.cleanup, previous.id);
    ui.closeOpenSheets();
  }

  /**
   * Tell the scroller how much of its bottom edge the screen's sticky action bar covers. A field brought
   * into view by Tab or the keyboard's Next key then stops above the bar instead of underneath it
   * (scroll-padding-bottom on .sm-main in css/base.css).
   */
  function trackActionBar(root) {
    // On a flush screen nothing scrolls and the bar is not sticky.
    const bar = root.classList.contains('sm-screen--flush')
      ? null
      : Array.from(root.children).find((child) => child.classList.contains('sm-actionbar'));
    const publish = () => els.main.style.setProperty('--sm-actionbar-h', `${bar ? bar.offsetHeight : 0}px`);
    publish();
    // The bar's height can change while it is on screen: the result screen swaps its buttons, labels wrap.
    if (bar && typeof ResizeObserver === 'function') {
      barObserver = new ResizeObserver(publish);
      barObserver.observe(bar);
    }
  }

  function renderCrash(root, id) {
    // If the first screen itself is broken, resetting would only crash again; reload instead.
    const restart = id === 'welcome' ? () => location.reload() : () => reset();
    root.className = `sm-screen sm-screen--${id}`;
    root.replaceChildren(
      ui.card(
        { class: 'sm-crash' },
        ui.h('span', { class: 'sm-crash__icon' }, ui.icon('alert', 28)),
        ui.h('h1', { class: 'sm-title', text: t('common.crashTitle'), attrs: { tabindex: '-1' } }),
        ui.h('p', { class: 'sm-muted', text: t('common.crashBody') }),
        ui.button(t('common.startAgain'), { icon: 'refresh', onClick: restart }),
      ),
    );
  }

  function show(id, { initial = false } = {}) {
    navToken += 1;
    const token = navToken;
    unmountCurrent();

    const module = SCREENS[id];
    const root = ui.h('section', { class: `sm-screen sm-screen--${id}`, dataset: { screen: id } });
    els.main.replaceChildren(root);

    let cleanup = null;
    try {
      const returned = module.mount(root, ctx);
      if (typeof returned === 'function') {
        cleanup = returned;
      } else if (returned && typeof returned.then === 'function') {
        // mount() is meant to be synchronous; tolerate an async one rather than lose its cleanup or its error.
        returned.then(
          (lateCleanup) => {
            if (typeof lateCleanup !== 'function') return;
            if (current && current.root === root) current.cleanup = lateCleanup;
            else runCleanup(lateCleanup, id);
          },
          (error) => {
            console.error(`${LOG_PREFIX} screen "${id}" failed to mount`, error);
            if (current && current.root === root) {
              renderCrash(root, id);
              focusScreen(root);
            }
          },
        );
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} screen "${id}" failed to mount`, error);
      if (token === navToken) renderCrash(root, id);
    }

    // mount() may itself navigate (e.g. redirect when something is missing); that newer screen now owns the page.
    if (token !== navToken) {
      runCleanup(cleanup, id);
      return;
    }

    current = { id, root, cleanup };
    updateHeader(id);
    trackActionBar(root);
    els.main.scrollTop = 0;
    // Do not pull focus into the iframe when a host page first loads it.
    if (!(initial && embedded)) focusScreen(root);
  }

  function go(screenId, { replace = false } = {}) {
    if (travelling) {
      // A step back through history is still in flight: act on this request once it has landed.
      // Asking again for the screen it is heading to is a double tap; once is enough.
      if (resolveScreen(screenId) !== travelling.screen) travelling.next = () => go(screenId, { replace });
      return;
    }
    const target = resolveScreen(screenId);
    const idx = historyIndex();
    const stay = replace || !current || current.id === target;
    const arrive = () => {
      writeHistory(target, stay ? idx : idx + 1, !stay);
      show(target);
    };
    // Stepping back to an earlier step ("Adjust corners" on the result, "Retake photo", "Edit" on the
    // quote) returns to that step's history entry instead of stacking a copy on top. The history stays
    // one entry per step, in step order, so Back always means "the previous step".
    if (!stay && idx > 0 && SCREEN_ORDER.indexOf(target) < SCREEN_ORDER.indexOf(current.id)) {
      const order = SCREEN_ORDER.indexOf(target);
      let at = trail.lastIndexOf(target, idx - 1);
      if (at < 0) {
        // The step has no entry of its own: every way in but the paper one skips "Get set up", AR skips
        // the camera screen, and the camera skips AR. Take over the first entry that belongs to a later
        // step, so none of those is left underneath for Back to land on.
        at = 1;
        while (at < idx && SCREEN_ORDER.indexOf(trail[at]) <= order) at += 1;
      }
      if (at < idx) {
        travel(at - idx, target, arrive);
      } else {
        writeHistory(target, idx, false);
        show(target);
      }
      return;
    }
    arrive();
  }

  function back() {
    // Never walk out of the app: the first history entry has nowhere in-app to go back to.
    if (historyIndex() > 0) history.back();
    else if (!current || current.id !== 'welcome') go('welcome', { replace: true });
  }

  function resetState() {
    // A new object rather than a refill: whatever still holds the old session's state (an enquiry
    // in flight, a photo still decoding) can then no longer write into the new session.
    state = createInitialState(config);
    ctx.state = state;
  }

  /** Drop the session, show the first screen in history entry `idx`, then step back to our first entry. */
  function startOver(idx) {
    const canvas = state.photo && state.photo.canvas;
    resetState();
    writeHistory('welcome', idx, false);
    show('welcome');
    // iOS Safari counts every live canvas against a hard memory budget and is slow to collect them, so
    // the old working canvas (about 20 MB) is handed back now. Only after show(): by then the screen
    // that was drawing from it has been cleaned up.
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    rewind();
  }

  function reset() {
    startOver(historyIndex());
  }

  // Screens read ctx.state when they mount; reset() swaps in a fresh object, so never cache it across screens.
  const ctx = { config, t, state, go, back, reset, toast, busy, emit, ui };

  // ----- wiring -----

  window.addEventListener('popstate', (event) => {
    const entry = event.state;
    // Entries without our state come from fragment links (#...), not from the router: leave the screen alone.
    if (!entry || typeof entry.screen !== 'string') return;
    const idx = Number.isInteger(entry.idx) ? entry.idx : 0;
    const trip = travelling;
    travelling = null;
    // A move of ours with a set destination, as opposed to the customer's own Back / Forward.
    const bound = trip && trip.screen ? trip : null;
    // After a lead has been sent, going back must not re-open the finished flow.
    if (!bound && ((current && current.id === 'done') || state.submission)) {
      startOver(idx);
      return;
    }
    // A move we started ourselves ends on the screen it was started for, whatever the entry says.
    const target = resolveScreen(bound ? bound.screen : entry.screen);
    const goingBack = idx < shownIdx;
    if (target !== entry.screen) writeHistory(target, idx, false);
    else trail[idx] = target;
    shownIdx = idx;
    if (!current || current.id !== target) {
      show(target);
    } else if (!bound && goingBack && idx > 0) {
      // Back landed on an entry that can no longer be entered and falls back to the screen already
      // showing (the result after a corner was moved, the manual-entry screen after switching to the
      // camera). A Back press must always go somewhere, so carry on to the entry before this one.
      travel(-1, null, null, trip && trip.next);
      return;
    }
    // Otherwise already showing it (a Forward press onto such an entry): keep its in-progress UI.
    if (trip && trip.next) trip.next();
  });

  // Only failures in the app's own code are the customer's business. In-app browsers (Instagram,
  // Facebook) and third-party tags run their own scripts in this page; when one of those throws, the
  // screen is fine and the browser's console already has the error.
  window.addEventListener('error', (event) => {
    // Benign and common wherever a ResizeObserver resizes what it observes.
    if (typeof event.message === 'string' && event.message.includes('ResizeObserver loop')) return;
    if (!mentionsOwnScript(event.filename)) return;
    reportError(event.error || event.message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (!reason || reason.name === 'AbortError') return;
    // A rejection carries no script address, only the stack of the error it was rejected with.
    if (!mentionsOwnScript(reason.stack)) return;
    reportError(reason);
  });

  // A photo picker is about to open (see "interrupted photo" above). The click reaches the file input
  // itself, either directly or passed on by its label, unless a screen stopped the picker from opening.
  document.addEventListener('click', (event) => {
    const el = event.target;
    if (event.defaultPrevented || travelling || !el || el.tagName !== 'INPUT' || el.type !== 'file') return;
    // While the paper demo photo is loaded, the customer's own sheet choice waits in state.ownReference.
    const chosen = state.ownReference || state;
    pickerOpen = true;
    setPickerNote({ referenceId: chosen.referenceId, customReference: { ...chosen.customReference } });
  });

  // None of these can happen while a picker or the camera is in front, so each one shows that the page
  // came through and the note is no longer needed. `change` and `cancel` are the picker's own events;
  // the page coming back into view, a touch or a key press cover the browsers that never send `cancel`.
  const pickerClosed = () => {
    if (!pickerOpen || document.visibilityState === 'hidden') return;
    pickerOpen = false;
    setPickerNote(null);
  };
  for (const type of ['change', 'cancel', 'visibilitychange', 'pointerdown', 'keydown']) {
    document.addEventListener(type, pickerClosed, true);
  }

  // iOS can leave the page scrolled up after the keyboard closes; the app itself never scrolls the window.
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!isEditable(document.activeElement) && (window.scrollX !== 0 || window.scrollY !== 0)) window.scrollTo(0, 0);
    }, 60);
  });

  ui.setUiStrings({ close: t('common.close') });
  els.back.replaceChildren(ui.icon('arrow-left', 22));
  els.back.setAttribute('aria-label', t('common.back'));
  els.back.addEventListener('click', () => back());
  renderBrand();

  // Start from the first screen: state does not survive a reload, and any incoming hash is ignored.
  // The one exception is a reload the customer never asked for, when the phone closed the page while
  // they were taking the photo: go back to that step, with their sheet choice, and say what happened.
  const restored = restoreInterruptedPhoto();
  if (restored) {
    // The entries underneath are still the old session's, so Back from here leads to the first screen.
    writeHistory(restored, historyIndex(), false);
    show(restored, { initial: true });
    toast(t('common.photoInterrupted', { choose: chooseLabel(restored) }), { duration: 12000 });
  } else {
    writeHistory('welcome', 0, false);
    show('welcome', { initial: true });
  }
}

async function boot() {
  const els = findShell();
  if (!els) {
    console.error(`${LOG_PREFIX} index.html is missing the #sm-app / #sm-main shell`);
    return;
  }
  if (new URLSearchParams(location.search).get('embed') === '1') document.documentElement.classList.add('sm-embed');

  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    console.error(`${LOG_PREFIX} could not load the config`, error);
    showBootFailure(els);
    return;
  }
  try {
    applyTheme(config);
  } catch (error) {
    console.error(`${LOG_PREFIX} applyTheme failed`, error);
  }
  try {
    startApp(config, els);
  } catch (error) {
    console.error(`${LOG_PREFIX} could not start`, error);
    showBootFailure(els);
  }
}

// Guarded so that importing this module under Node (for createInitialState) has no side effects.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
