// When the app offers AR, from js/ar-support.js: arSupported() with a mocked navigator.xr and
// isSecureContext (supported, unsupported, throwing, hanging past the timeout, cached), and the
// in-app browser check.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { arSupported, isKnownInAppBrowser, resetArSupport, SUPPORT_TIMEOUT_MS } from '../js/ar-support.js';

const saved = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  isSecureContext: Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext'),
};

function restore(name) {
  if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
  else delete globalThis[name];
}

/** Install a fake browser: `xr` becomes navigator.xr (omit it for a browser without WebXR). */
function fakeBrowser({ secure = true, xr, userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131.0.0.0 Mobile Safari/537.36' } = {}) {
  const nav = { userAgent };
  if (xr !== undefined) nav.xr = xr;
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
}

/** A navigator.xr whose isSessionSupported() runs `answer` and counts its calls. */
function fakeXr(answer) {
  const xr = {
    calls: [],
    isSessionSupported(mode) {
      xr.calls.push(mode);
      return answer(mode);
    },
  };
  return xr;
}

/** A promise with its resolve function, for answers that arrive late (or never). */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => resetArSupport());
afterEach(() => {
  restore('navigator');
  restore('isSecureContext');
  resetArSupport();
});

describe('arSupported', () => {
  test('true when a secure page has navigator.xr and immersive-ar is supported', async () => {
    const xr = fakeXr(() => Promise.resolve(true));
    fakeBrowser({ xr });
    assert.equal(await arSupported(), true);
    assert.deepEqual(xr.calls, ['immersive-ar']);
  });

  test('false when immersive-ar is not supported, or the answer is not a plain true', async () => {
    fakeBrowser({ xr: fakeXr(() => Promise.resolve(false)) });
    assert.equal(await arSupported(), false);
    resetArSupport();
    fakeBrowser({ xr: fakeXr(() => Promise.resolve('yes')) });
    assert.equal(await arSupported(), false);
  });

  test('false without WebXR, and without asking outside a secure context', async () => {
    fakeBrowser({});
    assert.equal(await arSupported(), false, 'no navigator.xr');
    resetArSupport();
    fakeBrowser({ xr: {} });
    assert.equal(await arSupported(), false, 'navigator.xr without isSessionSupported');
    resetArSupport();
    const xr = fakeXr(() => Promise.resolve(true));
    fakeBrowser({ secure: false, xr });
    assert.equal(await arSupported(), false, 'plain http');
    assert.equal(xr.calls.length, 0);
  });

  test('false, never a rejection, when isSessionSupported throws or rejects', async () => {
    const securityError = Object.assign(new Error('blocked by permissions policy'), { name: 'SecurityError' });
    fakeBrowser({
      xr: fakeXr(() => {
        throw securityError;
      }),
    });
    assert.equal(await arSupported(), false, 'throws');
    resetArSupport();
    fakeBrowser({ xr: fakeXr(() => Promise.reject(securityError)) });
    assert.equal(await arSupported(), false, 'rejects');
    resetArSupport();
    // A navigator whose xr getter itself throws (seen with some privacy extensions).
    const nav = {};
    Object.defineProperty(nav, 'xr', {
      get() {
        throw securityError;
      },
    });
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true, writable: true });
    assert.equal(await arSupported(), false, 'getter throws');
  });

  test('a query that hangs past the timeout counts as no; a late answer is used next time', async () => {
    const late = deferred();
    const xr = fakeXr(() => late.promise);
    fakeBrowser({ xr });
    const started = Date.now();
    assert.equal(await arSupported({ timeoutMs: 30 }), false);
    assert.ok(Date.now() - started < 1000, 'did not wait for the hung query');
    late.resolve(true);
    await late.promise;
    await Promise.resolve();
    assert.equal(await arSupported({ timeoutMs: 30 }), true);
    assert.equal(xr.calls.length, 1, 'the browser was asked once');
    assert.equal(SUPPORT_TIMEOUT_MS, 1500);
  });

  test('a query that never answers keeps saying no, without asking again', async () => {
    const xr = fakeXr(() => new Promise(() => {}));
    fakeBrowser({ xr });
    assert.equal(await arSupported({ timeoutMs: 10 }), false);
    assert.equal(await arSupported({ timeoutMs: 10 }), false);
    assert.equal(xr.calls.length, 1);
  });

  test('the answer is cached: concurrent and later calls share one query until reset', async () => {
    const xr = fakeXr(() => Promise.resolve(true));
    fakeBrowser({ xr });
    const [a, b] = await Promise.all([arSupported(), arSupported()]);
    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(await arSupported(), true);
    assert.equal(xr.calls.length, 1);
    // What the browser supports does not change while the page is open: a changed fake is not seen...
    fakeBrowser({ xr: fakeXr(() => Promise.resolve(false)) });
    assert.equal(await arSupported(), true);
    // ...until the cache is dropped.
    resetArSupport();
    assert.equal(await arSupported(), false);
  });
});

describe('isKnownInAppBrowser', () => {
  const IN_APP = {
    'Facebook (Android)':
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/494.0.0.48.73;]',
    'Facebook (iPhone)':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.37.108;FBBV/620000000;FBDV/iPhone15,2]',
    'Messenger (Android)':
      'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 [FBAN/Orca-Android;FBAV/480.0.0.0;]',
    'Instagram (Android)':
      'Mozilla/5.0 (Linux; Android 13; SM-S911B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.107 Mobile Safari/537.36 Instagram 360.0.0.30.109 Android (33/13; 480dpi; 1080x2340; samsung; SM-S911B)',
    'Instagram (iPhone)':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101 (iPhone16,1; iOS 18_1; en_AU; en)',
    LINE: 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 Line/14.5.0',
    'Android WebView':
      'Mozilla/5.0 (Linux; Android 14; SM-G991B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.39 Mobile Safari/537.36',
    TikTok: 'Mozilla/5.0 (Linux; Android 13; 2201117TG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 musical_ly_2023408040 BytedanceWebview/d8a21c6',
  };
  const BROWSERS = {
    'Chrome (Android)': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Samsung Internet':
      'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    'Firefox (Android)': 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
    'Safari (iPhone)':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    'Chrome (Linux desktop)': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };

  test('recognises the in-app browsers people open links in', () => {
    for (const [name, ua] of Object.entries(IN_APP)) assert.equal(isKnownInAppBrowser(ua), true, name);
  });

  test('real browsers are not in-app browsers', () => {
    for (const [name, ua] of Object.entries(BROWSERS)) assert.equal(isKnownInAppBrowser(ua), false, name);
  });

  test('no user agent is not an in-app browser; with no argument it reads navigator.userAgent', () => {
    assert.equal(isKnownInAppBrowser(''), false);
    assert.equal(isKnownInAppBrowser(null), false);
    assert.equal(isKnownInAppBrowser(42), false);
    fakeBrowser({ userAgent: IN_APP['Instagram (Android)'] });
    assert.equal(isKnownInAppBrowser(), true);
    fakeBrowser({ userAgent: BROWSERS['Chrome (Android)'] });
    assert.equal(isKnownInAppBrowser(), false);
  });
});
