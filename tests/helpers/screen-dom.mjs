// Just enough of a phone's browser to mount a screen under Node and press its buttons.
//
// js/ui.js builds its elements here, and the corner editor (js/editor.js) runs on them as it does in the
// app: it keeps the handles, moves them for the arrow keys and reports each move to the screen. It gets
// no 2-D context (canvas.getContext() is null, as when a browser has run out of them), so it draws
// nothing. Animation frames wait until flushFrames(), so a test decides when the browser paints; timers
// are Node's own. Events reach only the element they are fired on: there is no capture or bubbling.
//
// The screens' measuring code is not stood in for. A test sees what reached it from what the screen
// keeps in the app state (state.measure is the result itself).

import * as ui from '../../js/ui.js';
import { buildStrings, createTranslator } from '../../js/strings.js';

/** The photo stage's size on a phone, CSS px (the banner and the action bar take the rest of the screen). */
const VIEWPORT = Object.freeze({ width: 360, height: 520 });
// A screen that keeps asking for frames would otherwise hang the test.
const MAX_FRAME_ROUNDS = 50;
const GLOBALS = ['document', 'window', 'Node', 'DOMParser', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'];

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeElement);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    const text = value === null || value === undefined ? '' : String(value);
    this.replaceChildren(...(text ? [text] : []));
  }

  /** In the document, as the editor and the hold-to-repeat buttons ask. */
  get isConnected() {
    for (let at = this; at; at = at.parentNode) if (at === this.ownerDocument.documentElement) return true;
    return false;
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

  removeChild(node) {
    node.remove();
    return node;
  }

  /** As in a browser, append() and friends write anything that is not a node as text. */
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

  // Every element is laid out at the photo stage's size: the mark screens size the editor from it.
  get clientWidth() {
    return VIEWPORT.width;
  }

  get clientHeight() {
    return VIEWPORT.height;
  }

  getBoundingClientRect() {
    const { width, height } = VIEWPORT;
    return { left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, width, height };
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

  /** Fire an event at this element's own listeners; returns the event. */
  dispatch(type, props = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: performance.now(),
      ...props,
    };
    event.preventDefault = () => {
      event.defaultPrevented = true;
    };
    event.stopPropagation = () => {};
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }

  /** A keyboard or assistive-technology click: no pointer press before it. */
  click() {
    if (this.disabled) return;
    this.dispatch('click');
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  // The canvas: no 2-D context, so the editor draws nothing (see the top of this file).
  getContext() {
    return null;
  }

  setPointerCapture() {}

  releasePointerCapture() {}

  hasPointerCapture() {
    return false;
  }

  /** Tag, .class and [attr] / [attr="value"] selectors, in lists; never a pseudo-class such as :focus-visible. */
  matches(selector) {
    return selector.split(',').some((part) => {
      if (part.includes(':')) return false;
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

  closest(selector) {
    for (let at = this; at instanceof FakeElement; at = at.parentNode) if (at.matches(selector)) return at;
    return null;
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
  constructor(win) {
    this.defaultView = win;
    this.readyState = 'complete';
    this.visibilityState = 'visible';
    this.activeElement = null;
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
}

/** Parses nothing: every static SVG a screen draws becomes an empty <svg>, which is all a test needs. */
class FakeDOMParser {
  parseFromString() {
    return { documentElement: globalThis.document.createElementNS('http://www.w3.org/2000/svg', 'svg'), getElementsByTagName: () => [] };
  }
}

/**
 * Install the fake browser's globals. Call `uninstall()` (in a `finally`) to put back what was there;
 * unmount every screen first.
 * @returns {{
 *   document: FakeDocument,
 *   window: object,
 *   flushFrames: () => number,
 *   mount: (screen: object, options: { state: object, config: object }) => MountedScreen,
 *   uninstall: () => void,
 * }} flushFrames runs the animation frames asked for so far, and any they ask for, and says how many ran.
 */
export function installFakeDom() {
  const saved = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const frames = new Map();
  let frameSeq = 0;
  const listeners = new Map();
  const win = {
    devicePixelRatio: 2,
    scrollX: 0,
    scrollY: 0,
    performance,
    requestAnimationFrame(callback) {
      frameSeq += 1;
      frames.set(frameSeq, callback);
      return frameSeq;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
    clearTimeout: (id) => clearTimeout(id),
    // Reduced motion: the editor's zooms land at once instead of animating over frames.
    matchMedia: (query) => ({ matches: /prefers-reduced-motion:\s*reduce/.test(query), addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ position: 'relative', color: '', fontFamily: '', getPropertyValue: () => '' }),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((fn) => fn !== listener));
    },
    scrollTo() {},
  };
  const doc = new FakeDocument(win);
  win.document = doc;

  const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set('document', doc);
  set('window', win);
  set('Node', FakeNode);
  set('DOMParser', FakeDOMParser);
  set('requestAnimationFrame', win.requestAnimationFrame);
  set('cancelAnimationFrame', win.cancelAnimationFrame);
  set('getComputedStyle', win.getComputedStyle);

  function flushFrames() {
    let ran = 0;
    for (let round = 0; round < MAX_FRAME_ROUNDS && frames.size > 0; round++) {
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(performance.now());
      ran += batch.length;
    }
    return ran;
  }

  /**
   * @typedef {object} MountedScreen
   * @property {FakeElement} root The screen's <section>.
   * @property {object} ctx The app context it was mounted with.
   * @property {string[]} went Screens it asked for with ctx.go, in order.
   * @property {{ type: string, payload: unknown }[]} emitted ctx.emit calls.
   * @property {{ text: string }[]} toasts ctx.toast calls, with their options.
   * @property {(label: string) => FakeElement | null} button The .sm-btn with this label.
   * @property {(label: string) => void} press Click that button (it must be there), then let the browser paint.
   * @property {(key: string, props?: object) => void} key A key press on the photo (the editor's canvas).
   * @property {() => void} unmount Run the screen's cleanup and take it off the page.
   */

  /**
   * Mount a screen module the way the router does: an empty <section> in the page, the app context
   * (`ctx.go`, `ctx.emit` and `ctx.toast` are recorded), then a paint, which creates the corner editor.
   * @param {{ id: string, mount: Function, strings?: object }} screen
   * @param {{ state: object, config: object }} options
   * @returns {MountedScreen}
   */
  function mount(screen, { state, config }) {
    const root = doc.createElement('section');
    root.dataset.screen = screen.id;
    doc.body.append(root);
    const went = [];
    const emitted = [];
    const toasts = [];
    const ctx = {
      config,
      state,
      ui,
      t: createTranslator(config, buildStrings([screen])),
      go: (id) => went.push(id),
      back: () => went.push('back'),
      reset() {},
      busy: (fn) => fn(),
      toast: (text, options = {}) => toasts.push({ text, ...options }),
      emit: (type, payload) => emitted.push({ type, payload }),
    };
    const cleanup = screen.mount(root, ctx);
    flushFrames();

    const button = (label) =>
      root.querySelectorAll('.sm-btn').find((el) => el.querySelector('.sm-btn__label')?.textContent === label) || null;
    return {
      root,
      ctx,
      went,
      emitted,
      toasts,
      button,
      press(label) {
        const el = button(label);
        if (!el) throw new Error(`no "${label}" button on the ${screen.id} screen`);
        el.click();
        flushFrames();
      },
      key(key, props = {}) {
        const canvas = root.querySelector('canvas');
        if (!canvas) throw new Error(`no photo on the ${screen.id} screen yet`);
        canvas.dispatch('keydown', { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...props });
        flushFrames();
      },
      unmount() {
        cleanup();
        root.remove();
        flushFrames();
      },
    };
  }

  return {
    document: doc,
    window: win,
    flushFrames,
    mount,
    uninstall() {
      frames.clear();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}
