/**
 * Can this browser measure with WebXR AR?
 *
 * Only Chrome on an Android phone with ARCore can: no iPhone browser has WebXR at all, Firefox for
 * Android ships it switched off, and the in-app browsers of Facebook, Instagram and the like are
 * Android WebViews, which have none either. So the welcome screen offers "Measure with AR" only when
 * arSupported() says yes, and every other phone gets the photo path.
 *
 * A yes here is still not a promise. Chrome registers ARCore on every Android 7+ phone and only asks
 * for "Google Play Services for AR" when a session starts, so isSessionSupported('immersive-ar') can
 * say true on a phone where requestSession() then fails. The AR screen therefore treats any rejection
 * as "use the photo instead", or whichever other way in the company offers (js/screens/ar.js), and
 * tells this module (noteArRefused), so the welcome screen stops putting AR first for the rest of the
 * visit (arRefused) instead of sending the customer back to a way in that has just failed.
 *
 * Pure apart from reading `navigator` / `isSecureContext` / `document` when called. Nothing runs at
 * import time, so this module is safe to import under Node.
 */

/** How long to wait for isSessionSupported() before saying no. */
export const SUPPORT_TIMEOUT_MS = 1500;

/**
 * The one isSessionSupported() query this page makes, shared by every caller: a promise that always
 * resolves to a boolean once the browser answers (or right away when there is nothing to ask).
 * @type {Promise<boolean> | null}
 */
let query = null;

/** The browser's answer once it has arrived; null while it is still out (or never asked). */
let answer = null;

/** Ask the browser, once. Never throws and never rejects. */
function askBrowser() {
  try {
    // WebXR is only exposed in secure contexts (HTTPS or localhost); without one there is nothing to ask.
    if (globalThis.isSecureContext !== true) return Promise.resolve(false);
    const nav = globalThis.navigator;
    const xr = nav && nav.xr;
    if (!xr || typeof xr.isSessionSupported !== 'function') return Promise.resolve(false);
    // The AR screen needs the 'dom-overlay' feature, which Chrome builds on the Fullscreen API: it runs
    // the fullscreen permissions-policy check before it grants the overlay, so a page that may not use
    // fullscreen has every requestSession() rejected (NotSupportedError, FULLSCREEN_ERROR), however
    // often the customer tries. isSessionSupported() does not check that and still says true. This is
    // an iframe embed without allow="fullscreen" / allowfullscreen, or a Permissions-Policy header
    // without fullscreen; document.fullscreenEnabled is false in exactly those cases. (Checked after
    // navigator.xr, so the hint is not logged on iPhones, which have no element fullscreen or WebXR.)
    const doc = globalThis.document;
    if (doc && doc.fullscreenEnabled === false) {
      console.info(
        '[SecureMeasure] AR measuring is off: this page may not use fullscreen, which AR needs. ' +
          'In an iframe, add allow="camera; xr-spatial-tracking; fullscreen" and allowfullscreen; ' +
          'a Permissions-Policy header must allow fullscreen.',
      );
      return Promise.resolve(false);
    }
    // A cross-origin iframe without allow="xr-spatial-tracking" gets a SecurityError here, thrown or
    // as a rejection depending on the browser: both mean no.
    return Promise.resolve(xr.isSessionSupported('immersive-ar')).then(
      (supported) => supported === true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * True when this browser says it can run an 'immersive-ar' session: a secure context, `navigator.xr`
 * present and `navigator.xr.isSessionSupported('immersive-ar')` resolving true.
 *
 * The browser is asked once per page; every later call reuses that answer. A browser that has not
 * answered within `timeoutMs` counts as no for that call, so the welcome screen never waits on a hung
 * query; if the answer does turn up later, the next call gets it. Never rejects.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function arSupported({ timeoutMs = SUPPORT_TIMEOUT_MS } = {}) {
  if (answer !== null) return Promise.resolve(answer);
  if (!query) {
    query = askBrowser().then((supported) => {
      answer = supported;
      return supported;
    });
  }
  const wait = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : SUPPORT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), wait);
    query.then((supported) => {
      clearTimeout(timer);
      resolve(supported);
    });
  });
}

/**
 * True once an AR session has been refused (or failed to set up) on this page and none has run
 * since. Module state, not screen state, because the screens are rebuilt on every visit: the AR card
 * that saw the refusal is gone by the time the customer is back on the welcome screen.
 */
let refused = false;

/**
 * Record that requestSession() was refused or the granted session could not be set up. Until a
 * session runs, arRefused() says so, and the welcome screen and the AR card put the other way in
 * first. arSupported() is left alone: AR is still offered, second, because the cause may be a prompt
 * the customer dismissed by mistake, which Chrome shows again on the next try.
 */
export function noteArRefused() {
  refused = true;
}

/** Record that an AR session was granted: whatever refused AR before does not stand in its way now. */
export function noteArStarted() {
  refused = false;
}

/**
 * True when AR was refused on this page (noteArRefused) and has not started since (noteArStarted).
 * @returns {boolean}
 */
export function arRefused() {
  return refused;
}

/**
 * Forget the cached answer and any refusal, so the next arSupported() asks the browser again. For
 * tests; the app itself never needs it, because what a browser supports does not change while the
 * page is open.
 */
export function resetArSupport() {
  query = null;
  answer = null;
  refused = false;
}

/*
 * User-agent markers of the in-app browsers people open links in. All of them are Android WebViews
 * (or iOS WKWebViews), and none has WebXR or a reliable camera prompt, so the AR and camera screens
 * can say "open this page in Chrome" rather than a vague "not supported".
 *   FBAN / FBAV / FB_IAB / FBIOS   Facebook and Messenger
 *   Instagram                      Instagram
 *   Line/                          LINE
 *   ; wv)                          the Android System WebView's own marker, e.g. "(Linux; Android 14; wv)"
 *   WebView                        apps that say so outright
 *   plus TikTok (musical_ly, BytedanceWebview), Snapchat, WeChat (MicroMessenger), LinkedIn, Pinterest
 *   and X / Twitter for Android.
 * Deliberately not here: Chrome, Samsung Internet and Firefox, which are real browsers.
 */
const IN_APP_MARKERS = [
  /\bFBAN\//,
  /\bFBAV\//,
  /\bFB_IAB\//,
  /\bFBIOS\b/,
  /\bInstagram\b/,
  /\bLine\/\d/,
  /;\s*wv\)/,
  /\bWebView\b/i,
  /\bmusical_ly\b/,
  /\bBytedanceWebview\b/i,
  /\bSnapchat\b/,
  /\bMicroMessenger\//,
  /\bLinkedInApp\b/,
  /\bPinterest\b/,
  /\bTwitterAndroid\b/,
];

/**
 * True when the user-agent string belongs to an app's built-in browser (Facebook, Instagram, LINE, an
 * Android WebView, ...) rather than to a real browser.
 *
 * @param {string} [userAgent] Defaults to `navigator.userAgent`.
 * @returns {boolean}
 */
export function isKnownInAppBrowser(userAgent) {
  const ua = userAgent === undefined ? globalThis.navigator && globalThis.navigator.userAgent : userAgent;
  if (typeof ua !== 'string' || ua === '') return false;
  return IN_APP_MARKERS.some((marker) => marker.test(ua));
}
