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
 * as "use the photo instead", or whichever other way in the company offers (js/screens/ar.js).
 *
 * Pure apart from reading `navigator` / `isSecureContext` when called. Nothing runs at import time,
 * so this module is safe to import under Node.
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
 * Forget the cached answer so the next arSupported() asks the browser again. For tests; the app
 * itself never needs it, because what a browser supports does not change while the page is open.
 */
export function resetArSupport() {
  query = null;
  answer = null;
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
