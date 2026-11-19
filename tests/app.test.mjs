import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Importing the shell must not start it: js/app.js only boots where there is a document.
import {
  createInitialState,
  FALLBACK_GUARDS,
  FALLBACK_STEPS,
  interruptedPhotoScreen,
  resolveScreenId,
  SCREEN_ORDER,
} from '../js/app.js';
import { BUNDLED_DEMO_PHOTO, demoPhotoFocal35mm, demoPhotoUrl, loadDemo, selectDemoReference, useDemoPhoto } from '../js/demo.js';
import { estimateFromCorners, FULL_FRAME_DIAGONAL_MM, photoFocal, standardSizesFrom } from '../js/estimate.js';
import { DEMO_SCENE } from '../tools/scene.mjs';
import { COMMON, buildStrings } from '../js/strings.js';
import { SHIPPED_CONFIG } from './helpers/shipped-config.mjs';
import * as welcome from '../js/screens/welcome.js';
import * as prepare from '../js/screens/prepare.js';
import * as capture from '../js/screens/capture.js';
import * as ar from '../js/screens/ar.js';
import * as sheet from '../js/screens/sheet.js';
import * as door from '../js/screens/door.js';
import * as result from '../js/screens/result.js';
import * as quote from '../js/screens/quote.js';
import * as details from '../js/screens/details.js';
import * as done from '../js/screens/done.js';

const MODULES = { welcome, prepare, capture, ar, sheet, door, result, quote, details, done };

const QUAD = [
  { x: 400, y: 600 },
  { x: 610, y: 600 },
  { x: 610, y: 897 },
  { x: 400, y: 897 },
];

/** A stand-in photo: the guards only ask whether there is one. */
const fakePhoto = (extra = {}) => ({ width: 1536, height: 2048, isDemo: false, canvas: { width: 1536, height: 2048 }, ...extra });

/** createInitialState with some fields changed, the way the screens change them. */
function stateWith(changes = {}) {
  return { ...createInitialState(SHIPPED_CONFIG), ...changes };
}

/** One state for every stage of every way in, to run each guard against. */
const STATES = {
  fresh: stateWith(),
  'paper: photo, no sheet yet': stateWith({ method: 'paper', photo: fakePhoto() }),
  'paper: stand-in sheet not placed': stateWith({
    method: 'paper',
    photo: fakePhoto(),
    sheet: { points: QUAD, refined: false, detected: false, placed: false },
  }),
  'paper: sheet marked': stateWith({ method: 'paper', photo: fakePhoto(), sheet: { points: QUAD, refined: true, detected: true } }),
  'no method (old caller): sheet marked': stateWith({ photo: fakePhoto(), sheet: { points: QUAD, refined: true, detected: true } }),
  'estimate: no photo': stateWith({ method: 'estimate' }),
  'estimate: photo': stateWith({ method: 'estimate', photo: fakePhoto() }),
  'estimate: photo with a stale sheet': stateWith({
    method: 'estimate',
    photo: fakePhoto(),
    sheet: { points: QUAD, refined: true, detected: true },
  }),
  'estimate: measured': stateWith({
    method: 'estimate',
    photo: fakePhoto(),
    measure: { method: 'estimate', ok: true, widthMm: 820, heightMm: 2040 },
    size: { widthMm: 820, heightMm: 2040, source: 'estimate', standard: true },
  }),
  'ar: measured': stateWith({
    method: 'ar',
    measure: { method: 'ar', ok: true, widthMm: 823, heightMm: 2046 },
    size: { widthMm: 823, heightMm: 2046, source: 'ar', standard: false },
  }),
  'ar: with an old photo': stateWith({ method: 'ar', photo: fakePhoto() }),
  'manual entry': stateWith({ manualEntry: true }),
  'priced, product chosen': stateWith({
    manualEntry: true,
    size: { widthMm: 900, heightMm: 2100, source: 'manual' },
    quoteInput: { productId: 'stainless-mesh', selections: {}, includeInstallation: true },
  }),
  sent: stateWith({ manualEntry: true, size: { widthMm: 900, heightMm: 2100, source: 'manual' }, submission: { ok: true } }),
};

describe('createInitialState', () => {
  test('starts a session with no way in chosen and nothing found yet', () => {
    const state = createInitialState(SHIPPED_CONFIG);
    assert.equal(state.method, null);
    assert.deepEqual(state.door, { points: null, detection: null });
    assert.deepEqual(state.sheet, { points: null, refined: false, detected: false });
    assert.equal(state.photo, null);
    assert.equal(state.measure, null);
    assert.equal(state.size, null);
    assert.equal(state.manualEntry, false);
  });

  test('holds every field of the state contract, and only those', () => {
    assert.deepEqual(createInitialState(SHIPPED_CONFIG), {
      method: null,
      manualEntry: false,
      referenceId: SHIPPED_CONFIG.measurement.defaultReferenceId,
      customReference: { widthMm: null, heightMm: null },
      ownReference: null,
      photo: null,
      sheet: { points: null, refined: false, detected: false },
      door: { points: null, detection: null },
      measure: null,
      size: null,
      quoteInput: { productId: null, selections: {}, includeInstallation: null },
      quote: null,
      customer: {},
      leadAttempt: null,
      submission: null,
    });
  });

  test('gives every session its own objects', () => {
    const first = createInitialState(SHIPPED_CONFIG);
    const second = createInitialState(SHIPPED_CONFIG);
    for (const key of ['customReference', 'sheet', 'door', 'quoteInput', 'customer']) {
      assert.notEqual(first[key], second[key], key);
    }
    first.door.detection = { ok: true };
    assert.equal(second.door.detection, null);
  });

  test('copes without a config', () => {
    assert.equal(createInitialState(undefined).referenceId, undefined);
    assert.equal(createInitialState({}).method, null);
  });
});

describe('screen order, steps and guards', () => {
  test('lists every screen once, earliest first', () => {
    assert.deepEqual(
      [...SCREEN_ORDER],
      ['welcome', 'prepare', 'capture', 'ar', 'sheet', 'door', 'result', 'quote', 'details', 'done'],
    );
    assert.ok(Object.isFrozen(SCREEN_ORDER));
  });

  test('puts each screen on its progress step', () => {
    assert.deepEqual(FALLBACK_STEPS, {
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
    assert.deepEqual(Object.keys(FALLBACK_GUARDS), [...SCREEN_ORDER]);
    assert.ok(Object.isFrozen(FALLBACK_STEPS) && Object.isFrozen(FALLBACK_GUARDS));
  });

  test('names the steps for the header: step 2 is "Measure"', () => {
    assert.equal(COMMON['common.steps.1'], 'Photo');
    assert.equal(COMMON['common.steps.2'], 'Measure');
    assert.equal(COMMON['common.steps.3'], 'Size');
    assert.equal(COMMON['common.steps.4'], 'Price');
  });

  test('the ways in can always be started', () => {
    for (const id of ['welcome', 'prepare', 'capture', 'ar']) {
      for (const [name, state] of Object.entries(STATES)) assert.equal(FALLBACK_GUARDS[id](state), true, `${id}: ${name}`);
    }
  });

  test('the sheet belongs to the paper method only', () => {
    const sheetGuard = FALLBACK_GUARDS.sheet;
    assert.equal(sheetGuard(STATES.fresh), false, 'no photo');
    assert.equal(sheetGuard(STATES['paper: photo, no sheet yet']), true);
    assert.equal(sheetGuard(STATES['no method (old caller): sheet marked']), true);
    assert.equal(sheetGuard(STATES['estimate: photo']), false);
    assert.equal(sheetGuard(STATES['ar: with an old photo']), false);
  });

  test('the door screen: never for AR, any photo for the estimate, a marked sheet for paper', () => {
    const doorGuard = FALLBACK_GUARDS.door;
    assert.equal(doorGuard(STATES['ar: with an old photo']), false);
    assert.equal(doorGuard(STATES['ar: measured']), false);
    assert.equal(doorGuard(STATES['estimate: photo']), true);
    assert.equal(doorGuard(STATES['estimate: no photo']), false);
    assert.equal(doorGuard(STATES['paper: photo, no sheet yet']), false);
    assert.equal(doorGuard(STATES['paper: stand-in sheet not placed']), false);
    assert.equal(doorGuard(STATES['paper: sheet marked']), true);
    assert.equal(doorGuard(STATES['no method (old caller): sheet marked']), true);
  });

  test('every screen module agrees with the router about its id, step and guard', () => {
    assert.deepEqual(Object.keys(MODULES), [...SCREEN_ORDER]);
    for (const [id, module] of Object.entries(MODULES)) {
      assert.equal(module.id, id);
      assert.equal(module.step, FALLBACK_STEPS[id], `${id}.step`);
      assert.equal(typeof module.mount, 'function', `${id}.mount`);
      assert.equal(typeof module.canEnter, 'function', `${id}.canEnter`);
      for (const [name, state] of Object.entries(STATES)) {
        assert.equal(Boolean(module.canEnter(state)), FALLBACK_GUARDS[id](state), `${id}.canEnter with "${name}"`);
      }
    }
  });

  test('no two screens define the same string id', () => {
    const owner = new Map();
    for (const [id, module] of Object.entries(MODULES)) {
      for (const key of Object.keys(module.strings || {})) {
        assert.ok(!owner.has(key) || owner.get(key) === id, `"${key}" is defined by both ${owner.get(key)} and ${id}`);
        owner.set(key, id);
        assert.ok(!(key in COMMON), `${id} redefines the shared "${key}"`);
      }
    }
    const table = buildStrings(Object.values(MODULES));
    for (const [key, value] of Object.entries(table)) assert.ok(value.trim() !== '', `"${key}" is empty`);
  });
});

describe('resolveScreenId', () => {
  const resolve = (id, state) => resolveScreenId(id, state, (screen) => FALLBACK_GUARDS[screen](state));

  test('a screen that may be entered is where the request lands', () => {
    assert.equal(resolve('door', STATES['estimate: photo']), 'door');
    assert.equal(resolve('result', STATES['ar: measured']), 'result');
    assert.equal(resolve('done', STATES.sent), 'done');
    assert.equal(resolve('welcome', STATES.fresh), 'welcome');
  });

  test('an unknown screen lands on the welcome screen', () => {
    assert.equal(resolve('nowhere', STATES['estimate: measured']), 'welcome');
  });

  test("asked for by name, a way in's own screen is always fine", () => {
    assert.equal(resolve('ar', STATES['paper: sheet marked']), 'ar');
    assert.equal(resolve('capture', STATES['ar: measured']), 'capture');
    assert.equal(resolve('capture', STATES.fresh), 'capture');
  });

  test("falls back along the customer's own way in, never onto another way's screen", () => {
    // Paper, or no way in chosen yet: back to "Get set up", not to the AR or camera screen in between.
    assert.equal(resolve('sheet', STATES.fresh), 'prepare');
    assert.equal(resolve('quote', STATES.fresh), 'prepare');
    assert.equal(resolve('door', STATES['paper: photo, no sheet yet']), 'sheet');
    assert.equal(resolve('door', STATES['paper: stand-in sheet not placed']), 'sheet');
    assert.equal(resolve('result', STATES['paper: sheet marked']), 'door');

    // The no-paper photo: its corners, else the camera.
    assert.equal(resolve('result', STATES['estimate: photo']), 'door');
    assert.equal(resolve('quote', STATES['estimate: photo with a stale sheet']), 'door');
    assert.equal(resolve('door', STATES['estimate: no photo']), 'capture');
    assert.equal(resolve('sheet', STATES['estimate: photo']), 'capture');

    // AR: back to the AR screen, never the door screen (even with an old photo in the state).
    assert.equal(resolve('result', STATES['ar: with an old photo']), 'ar');
    assert.equal(resolve('door', STATES['ar: with an old photo']), 'ar');
  });

  test('"Get set up" stands in only on the paper way, or before any way in while the paper method is offered', () => {
    const offered = (id, state, methods) => resolveScreenId(id, state, (screen) => FALLBACK_GUARDS[screen](state), methods);
    const paperOff = { ar: true, camera: true, paper: false };
    const paperOn = { ar: true, camera: true, paper: true };

    // After "Start again" the state is fresh; Forward onto an old demo or camera entry finds no photo.
    for (const id of ['door', 'sheet', 'result', 'quote']) {
      assert.equal(offered(id, STATES.fresh, paperOff), 'welcome', `${id} with the paper method switched off`);
      assert.equal(offered(id, STATES.fresh, paperOn), 'prepare', `${id} with the paper method offered`);
    }
    // A customer on another way in never lands there, whatever the company offers.
    const estimateNoCamera = stateWith({ method: 'estimate' });
    assert.equal(offered('door', estimateNoCamera, paperOn), 'capture');
    assert.equal(offered('quote', stateWith({ method: 'ar' }), paperOn), 'ar');
    // The paper way itself keeps it, and asked for by name it is always fine.
    assert.equal(offered('sheet', stateWith({ method: 'paper' }), paperOff), 'prepare');
    assert.equal(offered('prepare', STATES.fresh, paperOff), 'prepare');
  });
});

describe('interruptedPhotoScreen', () => {
  const note = { referenceId: 'a4', customReference: { widthMm: null, heightMm: null } };

  test('picks up again on "Get set up" or the camera screen when the page went away mid-photo', () => {
    assert.equal(interruptedPhotoScreen({ screen: 'prepare', idx: 1, picking: note }), 'prepare');
    assert.equal(interruptedPhotoScreen({ screen: 'capture', idx: 1, picking: note }), 'capture');
  });

  test('starts normally otherwise', () => {
    assert.equal(interruptedPhotoScreen(null), null);
    assert.equal(interruptedPhotoScreen('prepare'), null);
    assert.equal(interruptedPhotoScreen({ screen: 'prepare', idx: 1 }), null, 'no photo was being taken');
    assert.equal(interruptedPhotoScreen({ screen: 'prepare', idx: 1, picking: 'yes' }), null);
    assert.equal(interruptedPhotoScreen({ screen: 'door', idx: 2, picking: note }), null, 'no picker there');
    assert.equal(interruptedPhotoScreen({ screen: 'result', idx: 3, picking: note }), null);
  });
});

describe('demo photo (js/demo.js)', () => {
  const measurement = SHIPPED_CONFIG.measurement;

  test('reads the demo address from the config', () => {
    assert.equal(demoPhotoUrl(SHIPPED_CONFIG), 'assets/demo-door.png');
    assert.equal(demoPhotoUrl({ measurement: { demoPhotoUrl: '  ' } }), '');
    assert.equal(demoPhotoUrl({ measurement: { demoPhotoUrl: 42 } }), '');
    assert.equal(demoPhotoUrl({}), '');
    assert.equal(demoPhotoUrl(undefined), '');
  });

  test('knows the lens of the bundled demo photo, and of no other', () => {
    // tools/scene.mjs renders assets/demo-door.png; its 35 mm equivalent is focalPx over the image diagonal.
    const { camera, width, height } = DEMO_SCENE;
    const rendered = (camera.focalPx / Math.hypot(width, height)) * FULL_FRAME_DIAGONAL_MM;
    assert.ok(Math.abs(BUNDLED_DEMO_PHOTO.focal35mm - rendered) < 0.05, `rendered with ${rendered.toFixed(2)} mm`);
    assert.equal(BUNDLED_DEMO_PHOTO.path, SHIPPED_CONFIG.measurement.demoPhotoUrl);

    for (const url of ['assets/demo-door.png', './assets/demo-door.png', ' assets/demo-door.png?v=2 ']) {
      assert.equal(demoPhotoFocal35mm(url), BUNDLED_DEMO_PHOTO.focal35mm, url);
    }
    for (const url of ['assets/our-door.jpg', 'img/demo-door.png', 'https://cdn.example.com/assets/demo-door.png', '', '  ', null, 42]) {
      assert.equal(demoPhotoFocal35mm(url), null, String(url));
    }
  });

  test('with its own lens, the bundled demo door is matched with confidence from its true corners', () => {
    const truth = JSON.parse(readFileSync(new URL('../assets/demo-door.truth.json', import.meta.url), 'utf8'));
    const photo = { width: truth.imageWidth, height: truth.imageHeight, focal35mm: demoPhotoFocal35mm(demoPhotoUrl(SHIPPED_CONFIG)) };
    const focal = photoFocal(photo);
    assert.equal(focal.source, 'exif', 'the known lens, not the 26 mm phone guess');
    const measure = estimateFromCorners({
      corners: truth.doorPx,
      imageWidth: photo.width,
      imageHeight: photo.height,
      focalPx: focal.focalPx,
      focalSource: focal.source,
      sizes: standardSizesFrom(SHIPPED_CONFIG),
    });
    assert.equal(measure.ok, true);
    assert.equal(`${measure.candidates[0].widthMm}x${measure.candidates[0].heightMm}`, `${truth.widthMm}x${truth.heightMm}`);
    assert.equal(measure.confident, true, `p = ${measure.candidates[0].p.toFixed(3)}`);
  });

  test('without a demo photo, loading one fails and leaves the state alone', async () => {
    const state = createInitialState(SHIPPED_CONFIG);
    const before = structuredClone(state);
    await assert.rejects(loadDemo({ config: { measurement: { demoPhotoUrl: '' } }, state }), /no_demo/);
    assert.deepEqual(state, before);
  });

  test('the no-paper demo becomes the photo for the estimate and leaves the sheet choice alone', () => {
    const state = stateWith({
      method: 'paper',
      referenceId: 'letter',
      photo: fakePhoto(),
      measure: { widthMm: 900, heightMm: 2100 },
      size: { widthMm: 900, heightMm: 2100, source: 'photo' },
      door: { points: QUAD, detection: { ok: true } },
    });
    const previous = state.photo;
    const demo = fakePhoto({ isDemo: true });
    useDemoPhoto(state, demo, 'estimate', measurement);

    assert.equal(state.photo, demo);
    assert.equal(state.method, 'estimate');
    assert.deepEqual(state.door, { points: null, detection: null }, 'nothing found on the old photo carries over');
    assert.equal(state.measure, null);
    assert.equal(state.size, null);
    assert.equal(state.referenceId, 'letter');
    assert.equal(state.ownReference, null);
    assert.equal(previous.canvas.width, 0, "the old photo's canvas is handed back");
  });

  test('the paper demo is measured with its own A4 sheet and keeps the customer choice aside', () => {
    const state = stateWith({ referenceId: 'letter' });
    useDemoPhoto(state, fakePhoto({ isDemo: true }), 'paper', measurement);
    assert.equal(state.method, 'paper');
    assert.equal(state.referenceId, 'a4');
    assert.equal(state.ownReference.referenceId, 'letter');

    // A second go finds the demo's A4 in the state: the customer's own choice must survive it.
    useDemoPhoto(state, fakePhoto({ isDemo: true }), 'paper', measurement);
    assert.equal(state.ownReference.referenceId, 'letter');
  });

  test('anything but the two demo methods is read as the no-paper demo', () => {
    const state = stateWith();
    useDemoPhoto(state, fakePhoto({ isDemo: true }), 'ar', measurement);
    assert.equal(state.method, 'estimate');
  });

  test('a company with no A4 reference gets an A4-sized custom sheet for the demo', () => {
    const state = stateWith({ referenceId: 'card' });
    selectDemoReference(state, { references: [{ id: 'card', label: 'Bank card', widthMm: 85.6, heightMm: 53.98 }] });
    assert.equal(state.referenceId, 'custom');
    assert.deepEqual(state.customReference, { widthMm: 210, heightMm: 297 });
    assert.deepEqual(state.ownReference, { referenceId: 'card', customReference: { widthMm: null, heightMm: null } });
  });
});

describe('shell copy', () => {
  test('the welcome screen promises no paper, and says how the size is settled', () => {
    assert.equal(welcome.strings['welcome.title'], 'Measure your door in a minute');
    assert.equal(welcome.strings['welcome.subtitle'], 'Point your phone at your door for an instant price. No tape measure, no paper.');
    assert.equal(
      welcome.strings['welcome.standardNote'],
      'We match your door to the nearest standard size. We confirm the exact size with a check measure before your door is made.',
    );
    assert.deepEqual(
      ['welcome.ar', 'welcome.camera', 'welcome.demo', 'welcome.paper', 'welcome.manual'].map((key) => welcome.strings[key]),
      ['Measure with AR', 'Measure with my camera', 'Try it with a demo photo', 'Measure exactly with a sheet of paper', 'I already know my door size'],
    );
  });

  test('no shell copy claims a tolerance it cannot keep', () => {
    for (const module of [welcome, prepare, sheet]) {
      for (const [key, value] of Object.entries(module.strings)) {
        assert.ok(!/±|\+\/-|plus or minus|accurate to/i.test(value), `${key}: ${value}`);
      }
    }
  });

  test('"Get set up" offers the paper demo and calls itself the exact method', () => {
    assert.match(prepare.strings['prepare.subtitle'], /exact/i);
    assert.equal(prepare.strings['prepare.demo'], 'Try the paper method with our demo photo');
  });
});
