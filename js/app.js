/**
 * SecureMeasure application shell.
 *
 * Loads the (optionally skinned) config, applies the theme, builds the shared `ctx` object and
 * runs the screen router: one screen module is mounted at a time as the sole child of .sm-main,
 * with browser history kept in step so the phone's back button works.
 */

import { loadConfig, applyTheme } from './theme.js';
import * as ui from './ui.js';
import { COMMON, buildStrings, createTranslator } from './strings.js';
import * as welcome from './screens/welcome.js';
import * as prepare from './screens/prepare.js';
import * as sheet from './screens/sheet.js';
import * as door from './screens/door.js';
import * as result from './screens/result.js';
import * as quote from './screens/quote.js';
import * as details from './screens/details.js';
import * as done from './screens/done.js';

const SCREENS = { welcome, prepare, sheet, door, result, quote, details, done };
const SCREEN_ORDER = ['welcome', 'prepare', 'sheet', 'door', 'result', 'quote', 'details', 'done'];
const TOTAL_STEPS = 4;

/** Used only when a screen module's own `step` / `canEnter` export is missing or malformed. */
const FALLBACK_STEPS = { welcome: 1, prepare: 1, sheet: 2, door: 2, result: 3, quote: 4, details: 4, done: 4 };
const FALLBACK_GUARDS = {
  welcome: () => true,
  prepare: () => true,
  sheet: (state) => Boolean(state.photo),
  door: (state) => Boolean(state.photo && state.sheet && state.sheet.points && state.sheet.placed !== false),
  result: (state) => Boolean(state.measure || state.manualEntry),
  quote: (state) => Boolean(state.size),
  details: (state) => Boolean(state.size && state.quoteInput && state.quoteInput.productId),
  done: (state) => Boolean(state.submission),
};

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
    manualEntry: false,
    referenceId: measurement.defaultReferenceId,
    customReference: { widthMm: null, heightMm: null },
    // The customer's own sheet choice, set aside while the demo photo is loaded (welcome.js / prepare.js).
    ownReference: null,
    photo: null,
    sheet: { points: null, refined: false, detected: false },
    door: { points: null },
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

  /** The requested screen if it may be entered, otherwise the furthest earlier screen that may. */
  function resolveScreen(id) {
    const index = SCREEN_ORDER.indexOf(id);
    if (index < 0) {
      console.warn(`${LOG_PREFIX} unknown screen "${id}"`);
      return 'welcome';
    }
    for (let i = index; i > 0; i -= 1) {
      if (canEnter(SCREEN_ORDER[i])) return SCREEN_ORDER[i];
    }
    return 'welcome';
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
  // the start-up code at the bottom of startApp() looks for it.

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
   * If the page went away while a photo was being taken on "Get set up", put the customer's sheet
   * choice back into the (fresh) state and report true: that screen is where to pick up again.
   */
  function restoreInterruptedPhoto() {
    const entry = history.state;
    const note = entry && entry.screen === 'prepare' ? entry.picking : null;
    if (!note || typeof note !== 'object') return false;
    if (typeof note.referenceId === 'string') state.referenceId = note.referenceId;
    const custom = note.customReference;
    if (custom && typeof custom === 'object') {
      for (const side of ['widthMm', 'heightMm']) {
        if (Number.isFinite(custom[side])) state.customReference[side] = custom[side];
      }
    }
    return true;
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
        // The step has no entry of its own (the demo photo and a typed-in size both skip "Get set up").
        // Take over the first entry that belongs to a later step, so none of those is left underneath
        // for Back to land on.
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
    // While the demo photo is loaded, the customer's own sheet choice waits in state.ownReference.
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
  if (restoreInterruptedPhoto()) {
    // The entries underneath are still the old session's, so Back from here leads to the first screen.
    writeHistory('prepare', historyIndex(), false);
    show('prepare', { initial: true });
    toast(t('common.photoInterrupted', { choose: t('prepare.choose') }), { duration: 12000 });
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
