import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Importing the shell must not start it: js/app.js only boots where there is a document.
import {
  createInitialState,
  FALLBACK_GUARDS,
  FALLBACK_STEPS,
  interruptedPhotoScreen,
  isSessionEntry,
  newSessionToken,
  requestedScreen,
  resolveScreenId,
  SCREEN_ORDER,
} from '../js/app.js';
import { BUNDLED_DEMO_PHOTO, demoPhotoFocal35mm, demoPhotoUrl, loadDemo, selectDemoReference, useDemoPhoto } from '../js/demo.js';
import { estimateFromCorners, FULL_FRAME_DIAGONAL_MM, photoFocal, standardSizesFrom } from '../js/estimate.js';
import { DEMO_SCENE } from '../tools/scene.mjs';
import { COMMON, buildStrings, createTranslator } from '../js/strings.js';
import { deepMerge } from '../js/theme.js';
import { noteArRefused, resetArSupport } from '../js/ar-support.js';
import * as ui from '../js/ui.js';
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
      liveCamera: null,
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

describe('history entries of other page loads and sessions', () => {
  test("only an entry with this session's mark is one of its own", () => {
    const session = newSessionToken();
    assert.equal(isSessionEntry({ screen: 'door', idx: 2, session }, session), true);
    assert.equal(isSessionEntry({ screen: 'door', idx: 2, session: newSessionToken() }, session), false, 'an earlier load or session');
    assert.equal(isSessionEntry({ screen: 'door', idx: 2 }, session), false, 'written before entries carried a session');
    assert.equal(isSessionEntry({ screen: 'door', idx: 2 }, undefined), false);
    assert.equal(isSessionEntry(null, session), false);
    assert.equal(isSessionEntry('door', session), false);
  });

  test('every page load and every "Start again" gets a mark of its own', () => {
    const marks = new Set(Array.from({ length: 2000 }, () => newSessionToken()));
    assert.equal(marks.size, 2000);
    for (const mark of marks) assert.equal(typeof mark, 'string');
  });

  test('Back onto an old journey\'s entry asks for the welcome screen, Forward for the screen on show', () => {
    const session = newSessionToken();
    for (const screen of SCREEN_ORDER) {
      for (const old of [{ screen, idx: 2, session: newSessionToken() }, { screen, idx: 2 }]) {
        assert.equal(requestedScreen(old, session, true, 'welcome'), 'welcome', `Back onto ${screen}`);
        assert.equal(requestedScreen(old, session, true, 'prepare'), 'welcome', `Back onto ${screen} from "Get set up"`);
        assert.equal(requestedScreen(old, session, false, 'welcome'), 'welcome', `Forward onto ${screen}`);
        assert.equal(requestedScreen(old, session, false, 'result'), 'result', `Forward onto ${screen} from the result`);
      }
      // This session's own entries still lead where they say.
      assert.equal(requestedScreen({ screen, idx: 2, session }, session, true, 'welcome'), screen);
      assert.equal(requestedScreen({ screen, idx: 2, session }, session, false, 'welcome'), screen);
    }
  });
});

// ---- A browser, just enough of one ------------------------------------------------------------
//
// The router and the welcome screen run here as they do in a phone's browser: js/ui.js builds real
// (fake) elements, js/app.js boots on a document, and the session history keeps its entries across
// page loads, as a browser's does through a reload or a tab the phone discarded.

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeElement);
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    const text = value === null || value === undefined ? '' : String(value);
    this.replaceChildren(...(text ? [text] : []));
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, ref) {
    node.remove();
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }

  /** As in a browser, append() and friends write anything that is not a node (null too) as text. */
  asNodes(items) {
    return items.map((item) => (item instanceof FakeNode ? item : this.ownerDocument.createTextNode(String(item))));
  }

  append(...items) {
    for (const node of this.asNodes(items)) this.appendChild(node);
  }

  prepend(...items) {
    const first = this.childNodes[0] || null;
    for (const node of this.asNodes(items)) this.insertBefore(node, first);
  }

  replaceChildren(...items) {
    for (const node of [...this.childNodes]) node.remove();
    this.append(...items);
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.data = data;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

const dataAttribute = (name) => `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.localName = tag;
    this.attrs = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.offsetHeight = 0;
    this.style = { cssText: '', setProperty() {}, removeProperty() {} };
    const el = this;
    this.dataset = new Proxy(
      {},
      {
        get: (_, name) => (typeof name === 'string' ? (el.getAttribute(dataAttribute(name)) ?? undefined) : undefined),
        set: (_, name, value) => {
          el.setAttribute(dataAttribute(String(name)), value);
          return true;
        },
      },
    );
    const classes = () => new Set((el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
    const write = (set) => el.setAttribute('class', [...set].join(' '));
    this.classList = {
      add: (...names) => write(new Set([...classes(), ...names])),
      remove: (...names) => write(new Set([...classes()].filter((name) => !names.includes(name)))),
      toggle: (name, force) => {
        const on = force === undefined ? !classes().has(name) : Boolean(force);
        if (on) this.classList.add(name);
        else this.classList.remove(name);
        return on;
      },
      contains: (name) => classes().has(name),
      [Symbol.iterator]: () => classes()[Symbol.iterator](),
    };
  }

  get tagName() {
    return this.localName.toUpperCase();
  }

  /** As on <input>, `type` reflects the attribute: js/app.js tells a photo picker by type="file". */
  get type() {
    return this.getAttribute('type') ?? (this.localName === 'input' ? 'text' : '');
  }

  set type(value) {
    this.setAttribute('type', value);
  }

  get nodeName() {
    return this.tagName;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((fn) => fn !== listener));
  }

  click() {
    if (this.disabled) return;
    const event = { type: 'click', target: this, defaultPrevented: false };
    event.preventDefault = () => {
      event.defaultPrevented = true;
    };
    for (const listener of [...(this.listeners.get('click') || [])]) listener(event);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  /** The selectors js/ui.js, js/app.js and the welcome screen use: tag, .class and [attr] / [attr="value"], in lists. */
  matches(selector) {
    return selector.split(',').some((part) => {
      const found = /^([a-zA-Z*][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(part.trim());
      if (!found) throw new Error(`the fake DOM does not know the selector "${part}"`);
      const [, tag, classNames, attributes] = found;
      if (tag && tag !== '*' && tag.toLowerCase() !== this.localName.toLowerCase()) return false;
      if (!classNames.split('.').filter(Boolean).every((name) => this.classList.contains(name))) return false;
      for (const [, name, value] of attributes.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value)) return false;
      }
      return true;
    });
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument {
  constructor() {
    this.readyState = 'complete';
    this.visibilityState = 'visible';
    this.activeElement = null;
    this.title = '';
    this.head = null;
    this.listeners = new Map();
    this.documentElement = this.createElement('html');
    this.body = this.createElement('body');
    this.documentElement.append(this.body);
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  createElementNS(namespace, tag) {
    return new FakeElement(this, tag);
  }

  createTextNode(data) {
    return new FakeText(this, String(data));
  }

  importNode(node) {
    return node;
  }

  getElementById(id) {
    return this.documentElement.querySelectorAll('*').find((el) => el.getAttribute('id') === id) || null;
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  contains(node) {
    return this.documentElement.contains(node);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((fn) => fn !== listener));
  }

  /** Hand `event` to this document's `type` listeners, as an event that reaches the document does. */
  fire(type, event) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }
}

/** Parses nothing: every static SVG the screens draw becomes an empty <svg>, which is all a test needs. */
class FakeDOMParser {
  parseFromString() {
    return { documentElement: globalThis.document.createElementNS('http://www.w3.org/2000/svg', 'svg'), getElementsByTagName: () => [] };
  }
}

class FakeWindow {
  constructor() {
    this.parent = this;
    this.listeners = new Map();
    this.scrollX = 0;
    this.scrollY = 0;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((fn) => fn !== listener));
  }

  scrollTo() {}

  fire(type, event) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }
}

/**
 * A session history: the page the customer came from, then the app's entries. As in a browser, a move
 * is reported later (a popstate task) and only within the app's own page; a move onto the page before
 * the app leaves it. A reload keeps every entry and starts a new page in the current one.
 */
class FakeHistory {
  constructor() {
    this.entries = [{ page: 'outside', state: null }];
    this.index = 0;
    this.window = null;
    this.pending = 0;
  }

  get state() {
    return structuredClone(this.entries[this.index].state);
  }

  get length() {
    return this.entries.length;
  }

  /** Where the customer is: 'app' or 'outside'. */
  where() {
    return this.entries[this.index].page;
  }

  /** The states of the app's entries, oldest first. */
  appStates() {
    return this.entries.filter((entry) => entry.page === 'app').map((entry) => structuredClone(entry.state));
  }

  navigateToApp() {
    this.entries.splice(this.index + 1, Infinity, { page: 'app', state: null });
    this.index += 1;
  }

  pushState(state) {
    this.entries.splice(this.index + 1, Infinity, { page: 'app', state: structuredClone(state) });
    this.index += 1;
  }

  replaceState(state) {
    this.entries[this.index].state = structuredClone(state);
  }

  go(delta) {
    const to = this.index + delta;
    if (!delta || to < 0 || to >= this.entries.length) return;
    this.pending += 1;
    setTimeout(() => {
      this.pending -= 1;
      this.index = to;
      const entry = this.entries[to];
      // Another page: the app is gone, and nothing of it hears about the move.
      if (entry.page === 'app') this.window.fire('popstate', { state: structuredClone(entry.state) });
    }, 0);
  }

  back() {
    this.go(-1);
  }

  forward() {
    this.go(1);
  }
}

const BROWSER_GLOBALS = ['document', 'window', 'history', 'location', 'navigator', 'Node', 'DOMParser', 'isSecureContext'];
let pageLoads = 0;

/**
 * Install the fake browser's globals; `uninstall()` puts back whatever was there. Each `open()` or
 * `reload()` starts js/app.js on a new page (a new module instance, so a new router) and returns the
 * page, with the screens its router mounted (`mounted`). `cameraStarts` counts getUserMedia() calls.
 */
function fakeBrowser({ xr = null } = {}) {
  const saved = BROWSER_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const history = new FakeHistory();
  let cameraStarts = 0;
  const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set('history', history);
  set('location', { search: '', href: 'https://doors.example/measure/', reload() {} });
  set('Node', FakeNode);
  set('DOMParser', FakeDOMParser);
  set('isSecureContext', Boolean(xr));
  set('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1',
    xr: xr || undefined,
    mediaDevices: {
      getUserMedia: () => {
        cameraStarts += 1;
        return Promise.reject(new Error('no camera in a test'));
      },
    },
  });
  resetArSupport();

  /** A new page: its own document, window and shell (index.html), in the history's current entry. */
  function newPage() {
    const doc = new FakeDocument();
    const win = new FakeWindow();
    set('document', doc);
    set('window', win);
    history.window = win;
    const el = (tag, id, ...children) => {
      const node = doc.createElement(tag);
      if (id) node.setAttribute('id', id);
      node.append(...children);
      return node;
    };
    const segments = [1, 2, 3, 4].map(() => {
      const segment = doc.createElement('span');
      segment.classList.add('sm-progress__seg');
      return segment;
    });
    const main = el('main', 'sm-main');
    doc.body.append(
      el(
        'div',
        'sm-app',
        el('button', 'sm-back'),
        el('div', 'sm-brand'),
        el('p', 'sm-stepper', el('span', 'sm-step-count'), el('span', 'sm-step-name')),
        el('div', 'sm-progress', ...segments),
        main,
        el('div', 'sm-toasts'),
        el('div', 'sm-busy', el('p', 'sm-busy-message')),
      ),
    );
    const page = { doc, mounted: [] };
    // The router shows a screen by making it the only child of .sm-main.
    const replace = main.replaceChildren.bind(main);
    main.replaceChildren = (...nodes) => {
      page.mounted.push(nodes[0] && nodes[0].dataset ? nodes[0].dataset.screen : undefined);
      replace(...nodes);
    };
    page.screen = () => (main.children[0] ? main.children[0].dataset.screen : undefined);
    return page;
  }

  async function start() {
    const page = newPage();
    pageLoads += 1;
    await import(new URL(`../js/app.js?page=${pageLoads}`, import.meta.url).href);
    await settle();
    return page;
  }

  /** Let every move the browser owes the page arrive, and whatever each one sets off. */
  async function settle() {
    for (let quiet = 0; quiet < 3; ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      quiet = history.pending > 0 ? 0 : quiet + 1;
    }
  }

  return {
    history,
    get cameraStarts() {
      return cameraStarts;
    },
    open() {
      history.navigateToApp();
      return start();
    },
    reload: start,
    settle,
    newPage,
    uninstall() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      resetArSupport();
    },
  };
}

/** The kit button (js/ui.js button or fileButton) on `page` whose label reads `label`. */
function buttonLabelled(page, label) {
  const found = page.doc.documentElement
    .querySelectorAll('.sm-btn')
    .find((button) => button.querySelector('.sm-btn__label')?.textContent === label);
  assert.ok(found, `no "${label}" button on the page`);
  return found;
}

/** A click on `target` as it reaches the document: one no screen has prevented. */
function clickOn(target) {
  const event = { type: 'click', target, defaultPrevented: false };
  event.preventDefault = () => {
    event.defaultPrevented = true;
  };
  return event;
}

describe('the router after a reload or "Start again" (js/app.js in a fake browser)', () => {
  /** What an earlier page load wrote for the camera way in: welcome(0) -> capture(1) -> door(2) -> result(3). */
  async function cameraJourney(browser, { marked = true } = {}) {
    await browser.open();
    const first = browser.history.state;
    assert.deepEqual([first.screen, first.idx], ['welcome', 0]);
    assert.equal(typeof first.session, 'string', 'every entry carries its session');
    const session = marked ? { session: first.session } : {};
    if (!marked) browser.history.replaceState({ screen: 'welcome', idx: 0 });
    for (const [idx, screen] of [[1, 'capture'], [2, 'door'], [3, 'result']]) browser.history.pushState({ screen, idx, ...session });
    return first.session;
  }

  for (const marked of [true, false]) {
    test(`Back from the fresh welcome screen leaves the app, opening none of the old screens${marked ? '' : ' (entries from before session marks)'}`, async (t) => {
      const errors = t.mock.method(console, 'error', () => {}).mock;
      const browser = fakeBrowser();
      try {
        const oldSession = await cameraJourney(browser, { marked });
        // iOS discards the tab while the customer is in another app, or they pull to refresh: the page
        // loads again in the result's entry, with the three older entries still behind it.
        const page = await browser.reload();
        assert.deepEqual(page.mounted, ['welcome']);
        const start = browser.history.state;
        assert.equal(start.screen, 'welcome');
        assert.equal(start.idx, 3, 'the page keeps its place above the old entries, so Back still reads as Back');
        assert.notEqual(start.session, oldSession);

        browser.history.back();
        await browser.settle();
        assert.deepEqual(page.mounted, ['welcome'], 'not "Get set up", not the camera, not the AR card');
        assert.equal(browser.cameraStarts, 0, 'the camera never started');
        assert.equal(browser.history.where(), 'outside', 'one Back left the app');
        assert.equal(errors.callCount(), 0, errors.calls.map((call) => call.arguments.join(' ')).join('\n'));
      } finally {
        browser.uninstall();
      }
    });
  }

  test('Forward onto the old entries ahead changes nothing, and Back still leaves', async (t) => {
    const errors = t.mock.method(console, 'error', () => {}).mock;
    const browser = fakeBrowser();
    try {
      await cameraJourney(browser);
      // The customer had gone Back to the camera screen when the page went away.
      browser.history.index -= 2;
      const page = await browser.reload();
      assert.deepEqual([browser.history.state.screen, browser.history.state.idx], ['welcome', 1]);

      browser.history.forward();
      await browser.settle();
      browser.history.forward();
      await browser.settle();
      assert.deepEqual(page.mounted, ['welcome'], 'the old door and result entries are not replayed');
      assert.equal(page.screen(), 'welcome');
      const states = browser.history.appStates();
      assert.deepEqual(
        states.map((state) => [state.screen, state.idx]),
        [
          ['welcome', 0],
          ['welcome', 1],
          ['welcome', 2],
          ['welcome', 3],
        ],
      );
      const session = browser.history.state.session;
      assert.ok(states.slice(1).every((state) => state.session === session), 'each entry passed over now belongs to this session');

      browser.history.back();
      await browser.settle();
      assert.deepEqual(page.mounted, ['welcome']);
      assert.equal(browser.history.where(), 'outside');
      assert.equal(browser.cameraStarts, 0);
      assert.equal(errors.callCount(), 0, errors.calls.map((call) => call.arguments.join(' ')).join('\n'));
    } finally {
      browser.uninstall();
    }
  });

  test('"Start again" gives the new session a mark of its own: Forward onto the ended journey\'s entries changes nothing', async (t) => {
    const errors = t.mock.method(console, 'error', () => {}).mock;
    const browser = fakeBrowser();
    try {
      const page = await browser.open();
      const oldSession = browser.history.state.session;
      // This session's camera journey got as far as the door screen. Reaching it takes a decoded photo,
      // which the fake browser has none of, so its entries are written the way the router writes them.
      for (const [idx, screen] of [[1, 'capture'], [2, 'door']]) browser.history.pushState({ screen, idx, session: oldSession });
      // Then the size is typed in instead, and that screen fails to mount (it can make no inputs): its
      // crash card offers "Start again", which runs the same reset() as the done screen's.
      page.doc.createElement = (tag) => {
        if (tag === 'input') throw new Error('no inputs in this test');
        return FakeDocument.prototype.createElement.call(page.doc, tag);
      };
      buttonLabelled(page, welcome.strings['welcome.manual']).click();
      delete page.doc.createElement;
      assert.deepEqual([page.screen(), browser.history.state.idx], ['result', 3]);

      buttonLabelled(page, COMMON['common.startAgain']).click();
      await browser.settle();
      assert.deepEqual(page.mounted, ['welcome', 'result', 'welcome']);
      assert.equal(browser.history.state.idx, 0, 'back on our first entry, so Back leaves the app');
      const session = browser.history.state.session;
      assert.equal(typeof session, 'string');
      assert.notEqual(session, oldSession, 'the new session has a mark of its own');

      // The ended journey's camera and door entries now lie ahead of the welcome screen.
      for (let step = 0; step < 3; step += 1) {
        browser.history.forward();
        await browser.settle();
      }
      assert.deepEqual(page.mounted, ['welcome', 'result', 'welcome'], 'not the camera, not "Get set up"');
      assert.equal(page.screen(), 'welcome');
      assert.equal(browser.cameraStarts, 0, 'the camera never started');
      const states = browser.history.appStates();
      assert.deepEqual(
        states.map((state) => [state.screen, state.idx]),
        [
          ['welcome', 0],
          ['welcome', 1],
          ['welcome', 2],
          ['welcome', 3],
        ],
      );
      assert.ok(states.every((state) => state.session === session), 'each entry passed over now belongs to the new session');
      assert.deepEqual(
        errors.calls.map((call) => call.arguments[0]),
        ['[SecureMeasure] screen "result" failed to mount'],
        'nothing went wrong but the crash this test set up',
      );
    } finally {
      browser.uninstall();
    }
  });
});

describe('the router around a photo picker (js/app.js in a fake browser)', () => {
  test('taking the picker note off again keeps the entry this session\'s own, so Back and Forward still lead to it', async (t) => {
    const errors = t.mock.method(console, 'error', () => {}).mock;
    const browser = fakeBrowser();
    try {
      const page = await browser.open();
      const session = browser.history.state.session;
      buttonLabelled(page, welcome.strings['welcome.camera']).click();
      await browser.settle();
      assert.deepEqual(browser.history.state, { screen: 'capture', idx: 1, session });
      // No camera in a test, so the screen also offers "Use your camera app instead" and "Choose a photo".
      const pickers = page.doc.documentElement.querySelectorAll('input').filter((input) => input.type === 'file');
      assert.equal(pickers.length, 2);

      // The note goes on with the tap that opens a picker, and comes off with whichever of these shows
      // the page came through.
      for (const [n, closedBy] of ['change', 'cancel', 'visibilitychange', 'pointerdown', 'keydown'].entries()) {
        const input = pickers[n % pickers.length];
        page.doc.fire('click', clickOn(input));
        const open = browser.history.state;
        assert.equal(open.session, session, `the note keeps the session mark (${closedBy})`);
        assert.equal(typeof open.picking, 'object', `the note is on while the picker is open (${closedBy})`);
        page.doc.fire(closedBy, { type: closedBy, target: input });
        assert.deepEqual(browser.history.state, { screen: 'capture', idx: 1, session }, `taken off by "${closedBy}", and nothing else`);
      }

      // The customer changes their mind: Back to the welcome screen, then Forward to the camera again.
      browser.history.back();
      await browser.settle();
      assert.equal(page.screen(), 'welcome');
      browser.history.forward();
      await browser.settle();
      assert.equal(page.screen(), 'capture', 'the camera screen, not the welcome screen an ended journey\'s entry leads to');
      assert.deepEqual(page.mounted, ['welcome', 'capture', 'welcome', 'capture']);
      assert.deepEqual(browser.history.state, { screen: 'capture', idx: 1, session });
      assert.equal(errors.callCount(), 0, errors.calls.map((call) => call.arguments.join(' ')).join('\n'));
    } finally {
      browser.uninstall();
    }
  });
});

describe('the router around a typed size (js/app.js in a fake browser)', () => {
  /** Type `value` into the input with `id`, as the customer does (an 'input' event). */
  function typeInto(page, id, value) {
    const input = page.doc.getElementById(id);
    assert.ok(input, `no #${id} on the page`);
    input.value = value;
    for (const listener of [...(input.listeners.get('input') || [])]) listener({ type: 'input', target: input });
  }

  test('"Measure with my camera instead" after the quote\'s Edit: Forward to the quote, Edit again, and the typed size is still there to edit', async (t) => {
    const errors = t.mock.method(console, 'error', () => {}).mock;
    const browser = fakeBrowser();
    try {
      const page = await browser.open();
      buttonLabelled(page, welcome.strings['welcome.manual']).click();
      await browser.settle();
      assert.equal(page.screen(), 'result');
      typeInto(page, 'sm-result-manual-width', '820');
      typeInto(page, 'sm-result-manual-height', '2040');
      buttonLabelled(page, result.strings['result.continue']).click();
      await browser.settle();
      assert.equal(page.screen(), 'quote');

      buttonLabelled(page, quote.strings['quote.size.edit']).click();
      await browser.settle();
      assert.equal(page.screen(), 'result', "the quote's Edit");
      buttonLabelled(page, result.strings['result.manual.useCamera']).click();
      await browser.settle();
      assert.equal(page.screen(), 'capture');

      // The quote priced from the typed size is still ahead in the history.
      browser.history.forward();
      await browser.settle();
      assert.equal(page.screen(), 'quote');
      buttonLabelled(page, quote.strings['quote.size.edit']).click();
      await browser.settle();

      assert.equal(page.screen(), 'result', 'not "Get set up" or another measuring screen with nothing to show');
      assert.equal(page.doc.getElementById('sm-result-manual-width')?.value, '820', 'the manual form, with the typed width');
      assert.equal(page.doc.getElementById('sm-result-manual-height')?.value, '2040');
      assert.equal(errors.callCount(), 0, errors.calls.map((call) => call.arguments.join(' ')).join('\n'));
    } finally {
      browser.uninstall();
    }
  });
});

describe('the welcome screen for each mix of ways in (js/screens/welcome.js in a fake browser)', () => {
  const strings = buildStrings([welcome]);

  /** Mount the welcome screen on a new page of `browser`, with `methods` and the rest as shipped. */
  function mountWelcome(browser, methods, { allowManualOverride = true } = {}) {
    // No tagline: the shipped one is the company's own words, and mentions a photo.
    const config = deepMerge(SHIPPED_CONFIG, { brand: { tagline: '' }, measurement: { methods, allowManualOverride } });
    const page = browser.newPage();
    const root = page.doc.createElement('section');
    page.doc.body.append(root);
    const went = [];
    const state = createInitialState(config);
    const ctx = { config, ui, state, t: createTranslator(config, strings), go: (id) => went.push(id), busy: (fn) => fn(), toast() {}, emit() {} };
    const cleanup = welcome.mount(root, ctx);
    const style = (button, pattern) => [...button.classList].find((name) => pattern.test(name)).slice('sm-btn--'.length);
    return {
      root,
      went,
      state,
      cleanup,
      buttons: () =>
        root
          .querySelectorAll('.sm-btn')
          .map((button) => `${button.querySelector('.sm-btn__label').textContent} [${style(button, /^sm-btn--(primary|secondary|ghost)$/)} ${style(button, /^sm-btn--(sm|md|lg)$/)}]`),
      text: () => root.textContent,
    };
  }

  test('with neither photo way on, typing in a size is the way in, and nothing promises a photo', () => {
    // "AR is enough": on an iPhone, or any phone without ARCore, AR never appears.
    for (const methods of [{ ar: true, camera: false, paper: false }, { ar: false, camera: false, paper: false }]) {
      const browser = fakeBrowser();
      try {
        const screen = mountWelcome(browser, methods);
        const label = JSON.stringify(methods);
        assert.deepEqual(screen.buttons(), [`${strings['welcome.enterSize']} [primary lg]`], label);
        const text = screen.text();
        assert.ok(text.includes(strings['welcome.manualOnly.title']) && text.includes(strings['welcome.manualOnly.subtitle']), label);
        assert.doesNotMatch(text, /photo|camera|snap|no paper|null/i, label);
        assert.ok(!text.includes(strings['welcome.standardNote']), 'a typed-in size is matched to nothing');

        screen.root.querySelector('.sm-btn').click();
        assert.equal(screen.state.manualEntry, true);
        assert.deepEqual(screen.went, ['result']);
        screen.cleanup();
      } finally {
        browser.uninstall();
      }
    }
  });

  test('on a phone with AR, AR goes on top and typing in a size becomes the second button', async () => {
    const browser = fakeBrowser({ xr: { isSessionSupported: async (mode) => mode === 'immersive-ar' } });
    try {
      const screen = mountWelcome(browser, { ar: true, camera: false, paper: false });
      await browser.settle();
      assert.deepEqual(screen.buttons(), [`${strings['welcome.ar']} [primary lg]`, `${strings['welcome.enterSize']} [secondary md]`]);
      screen.cleanup();
    } finally {
      browser.uninstall();
    }
  });

  test('once AR has been refused on this page, it is offered second, under the main way in, which keeps its look', async () => {
    const browser = fakeBrowser({ xr: { isSessionSupported: async (mode) => mode === 'immersive-ar' } });
    try {
      // The phone said it could, then would not start a session (js/screens/ar.js).
      noteArRefused();
      const screen = mountWelcome(browser, { ar: true, camera: true, paper: true });
      await browser.settle();
      assert.deepEqual(screen.buttons(), [
        `${strings['welcome.camera']} [primary lg]`,
        `${strings['welcome.ar']} [secondary md]`,
        `${strings['welcome.demo']} [secondary md]`,
        `${strings['welcome.paper']} [ghost sm]`,
        `${strings['welcome.manual']} [ghost sm]`,
      ]);
      screen.root.querySelectorAll('.sm-btn')[1].click();
      assert.deepEqual(screen.went, ['ar']);
      screen.cleanup();
    } finally {
      browser.uninstall();
      resetArSupport();
    }
  });

  test('every other mix keeps its copy and buttons, with no stray "null" where a note is left out', () => {
    const demo = `${strings['welcome.demo']} [secondary md]`;
    const manual = `${strings['welcome.manual']} [ghost sm]`;
    const cases = [
      {
        methods: { ar: true, camera: true, paper: true },
        title: 'welcome.title',
        buttons: [`${strings['welcome.camera']} [primary lg]`, demo, `${strings['welcome.paper']} [ghost sm]`, manual],
        notes: ['welcome.standardNote', 'welcome.privacy'],
      },
      {
        methods: { ar: false, camera: true, paper: false },
        title: 'welcome.title',
        buttons: [`${strings['welcome.camera']} [primary lg]`, demo, manual],
        notes: ['welcome.standardNote', 'welcome.privacy'],
      },
      {
        methods: { ar: true, camera: false, paper: true },
        title: 'welcome.paperOnly.title',
        buttons: [`${strings['welcome.start']} [primary lg]`, demo, manual],
        notes: ['welcome.privacy'],
      },
      {
        // Manual sizes off as well: measurementMethods keeps paper on (js/theme.js).
        methods: { ar: true, camera: false, paper: false },
        allowManualOverride: false,
        title: 'welcome.paperOnly.title',
        buttons: [`${strings['welcome.start']} [primary lg]`, demo],
        notes: ['welcome.privacy'],
      },
    ];
    for (const { methods, allowManualOverride, title, buttons, notes } of cases) {
      const browser = fakeBrowser();
      try {
        const screen = mountWelcome(browser, methods, { allowManualOverride });
        const label = `${JSON.stringify(methods)}, manual ${allowManualOverride !== false}`;
        assert.deepEqual(screen.buttons(), buttons, label);
        const text = screen.text();
        assert.ok(text.includes(strings[title]), label);
        for (const key of ['welcome.standardNote', 'welcome.privacy']) assert.equal(text.includes(strings[key]), notes.includes(key), `${label}: ${key}`);
        assert.doesNotMatch(text, /null/, label);
        screen.cleanup();
      } finally {
        browser.uninstall();
      }
    }
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
