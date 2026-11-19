/**
 * SecureMeasure UI kit: the small set of DOM builders every screen is made from.
 *
 * Everything here returns real DOM nodes and writes text through textContent / text nodes,
 * never innerHTML, so config strings and customer input can be passed in safely.
 * Nothing touches the DOM at import time. Styling lives in css/base.css.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Tags h() creates in the SVG namespace (names that do not clash with HTML elements). */
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'use', 'tspan',
]);

const RING = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z';

/** Icon path data on a 24x24 grid, drawn with a 2px round stroke in currentColor. */
const ICONS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  camera: [
    'M4 8h3l1.6-2.5h6.8L17 8h3a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
    'M12 16.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z',
  ],
  image: [
    'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M9 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M20 15l-4-4L6 20',
  ],
  paper: ['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M9 13h6', 'M9 17h6'],
  tape: [
    'M10 18.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14z',
    'M10 14a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    'M10 18.5h11V15',
  ],
  phone: [
    'M8.5 2.5h7A1.5 1.5 0 0 1 17 4v16a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 20V4a1.5 1.5 0 0 1 1.5-1.5z',
    'M11 18.5h2',
  ],
  ruler: [
    'M3 8h18a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
    'M6 8v3',
    'M10 8v4',
    'M14 8v3',
    'M18 8v4',
  ],
  'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14', 'M6 13l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  info: [RING, 'M12 11v5', 'M12 8h.01'],
  help: [RING, 'M9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2 1-1.2 1.8v.3', 'M12 17h.01'],
  alert: ['M12 4.5l8.5 15h-17l8.5-15z', 'M12 10v4', 'M12 17h.01'],
  refresh: ['M20 11a8 8 0 0 0-14.4-4L4 8.5', 'M4 4v4.5h4.5', 'M4 13a8 8 0 0 0 14.4 4l1.6-1.5', 'M20 20v-4.5h-4.5'],
  lock: ['M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z', 'M8 11V7.5a4 4 0 0 1 8 0V11'],
  edit: ['M4 20h4l11-11-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  fit: ['M4 9V5a1 1 0 0 1 1-1h4', 'M15 4h4a1 1 0 0 1 1 1v4', 'M20 15v4a1 1 0 0 1-1 1h-4', 'M9 20H5a1 1 0 0 1-1-1v-4'],
  magnet: ['M6 4h4v8a2 2 0 0 0 4 0V4h4v8a6 6 0 0 1-12 0V4z', 'M6 8h4', 'M14 8h4'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  shield: ['M12 3l8 3v5.5c0 4.6-3.2 8.2-8 9.5-4.8-1.3-8-4.9-8-9.5V6l8-3z', 'M9 12l2.2 2.2L15.2 10'],
  door: ['M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17', 'M3 21h18', 'M14.5 12v1.5'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5z'],
  call: ['M5 4h3l1.5 4-2 1.5a12 12 0 0 0 7 7l1.5-2 4 1.5v3a1 1 0 0 1-1 1C10.7 20 4 13.3 4 5a1 1 0 0 1 1-1z'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
};

const CHIP_TONES = new Set(['neutral', 'success', 'warning', 'danger', 'accent']);
const BANNER_ICONS = { info: 'info', success: 'check', warning: 'alert', danger: 'alert' };
const BUTTON_VARIANTS = new Set(['primary', 'secondary', 'ghost', 'danger']);
const BUTTON_SIZES = new Set(['md', 'lg', 'sm']);
const BUTTON_ICON_PX = { sm: 18, md: 20, lg: 22 };

/** Kit-owned strings (screen copy never lives here); the shell replaces them with translated text. */
const uiStrings = { close: 'Close' };

const openSheets = new Set();
const warnedIcons = new Set();
let uidCounter = 0;

function uid(prefix) {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

function isNode(value) {
  return typeof Node !== 'undefined' && value instanceof Node;
}

function isChildLike(value) {
  return typeof value === 'string' || typeof value === 'number' || Array.isArray(value) || isNode(value);
}

function classString(value) {
  if (Array.isArray(value)) return value.map(classString).filter(Boolean).join(' ');
  if (typeof value === 'string') return value.trim();
  // { 'is-active': true } form: keep the keys whose value is truthy.
  if (value && typeof value === 'object') return Object.keys(value).filter((name) => value[name]).join(' ');
  return '';
}

function setAttr(el, name, value) {
  // A function must never be stringified into an attribute (it would become an inline handler the CSP blocks).
  if (value === null || value === undefined || value === false || typeof value === 'function') el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else if (typeof child === 'string' || typeof child === 'number') parent.appendChild(document.createTextNode(String(child)));
    else if (isNode(child)) parent.appendChild(child);
    // Kit controls such as field() return { el, ... }; accept them directly so a forgotten `.el` still renders.
    else if (isNode(child.el)) parent.appendChild(child.el);
  }
}

function applyStyle(el, style) {
  if (typeof style === 'string') {
    el.style.cssText = style;
    return;
  }
  for (const [name, value] of Object.entries(style || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('--') || name.includes('-')) el.style.setProperty(name, String(value));
    else el.style[name] = value;
  }
}

function applyProps(el, props, isSvg) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    switch (key) {
      case 'class':
      case 'className': {
        const classes = classString(value);
        if (classes) el.setAttribute('class', classes);
        break;
      }
      case 'text':
        el.textContent = value === null ? '' : String(value);
        break;
      case 'hidden':
        if (isSvg) setAttr(el, 'hidden', Boolean(value));
        else el.hidden = Boolean(value);
        break;
      case 'attrs':
        for (const [name, attrValue] of Object.entries(value || {})) setAttr(el, name, attrValue);
        break;
      case 'dataset':
        for (const [name, dataValue] of Object.entries(value || {})) {
          if (dataValue !== null && dataValue !== undefined) el.dataset[name] = String(dataValue);
        }
        break;
      case 'style':
        applyStyle(el, value);
        break;
      case 'on':
        for (const [type, listener] of Object.entries(value || {})) {
          if (typeof listener === 'function') el.addEventListener(type, listener);
        }
        break;
      case 'for':
        setAttr(el, 'for', value);
        break;
      default:
        if (value === null) break;
        if (typeof value === 'function' && /^on[A-Z]/.test(key)) {
          // React-style onClick / onInput: there is no such DOM property, so attach it as a listener.
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (isSvg || key === 'list' || key === 'form' || !(key in el)) {
          // input.list / input.form are read-only reflections of an attribute; everything unknown is an attribute too.
          setAttr(el, key, value);
        } else {
          // Any other read-only DOM property throws in strict mode; fall back to the attribute.
          try {
            el[key] = value;
          } catch {
            setAttr(el, key, value);
          }
        }
    }
  }
}

/**
 * Create an element.
 *
 * @param {string} tag Tag name. SVG drawing tags (svg, g, path, circle, rect, line, ...) are created in the SVG namespace.
 * @param {object|null} [props] Optional. `{ class, id, text, hidden, attrs: {...setAttribute}, dataset: {}, style: {}, on: { click: fn } }`
 *   plus any direct DOM property (value, checked, disabled, type, href, ...). `class` may be a string, an array (falsy entries
 *   dropped) or a `{ name: boolean }` map. Keys that are not DOM properties of the element are set as attributes, and
 *   React-style `onClick: fn` keys are attached as listeners.
 * @param {...(Node|string|number|null|undefined|false|Array)} children Nodes, text, or (nested) arrays of those; null/undefined/false are skipped.
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  // Tolerate h('p', 'text') / h('div', node): a child in the props position is treated as a child.
  if (isChildLike(props)) {
    children.unshift(props);
    props = null;
  }
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (props && typeof props === 'object') applyProps(el, props, isSvg);
  appendChildren(el, children);
  // A <select>'s value only takes once its <option> children exist.
  if (tag === 'select' && props && props.value !== undefined && props.value !== null) el.value = props.value;
  return el;
}

/**
 * Inline SVG icon drawn in currentColor (decorative: aria-hidden).
 *
 * @param {string} name One of: check, camera, image, paper, tape, phone, ruler, arrow-right, arrow-left, arrow-up, arrow-down,
 *   chevron-right, chevron-down, info, help, alert, refresh, lock, edit, fit, magnet, close, shield, door, star, call, plus, minus.
 * @param {number} [size=20] Width and height in CSS px.
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attributes = {
    class: `sm-icon sm-icon--${name}`,
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, String(value));

  const paths = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : null;
  if (!paths) {
    if (!warnedIcons.has(name)) {
      warnedIcons.add(name);
      console.warn(`[SecureMeasure] unknown icon "${name}"`);
    }
    return svg;
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Parse a STATIC, trusted SVG literal from source code into an <svg> element (for illustrations).
 * Never pass config or user strings. Scripts, foreignObject and on* attributes are stripped anyway.
 *
 * @param {string} markup A complete `<svg ...>...</svg>` string (the xmlns attribute is added if missing).
 * @returns {SVGSVGElement} The parsed element, or an empty <svg> if the markup does not parse.
 */
export function svgFromString(markup) {
  let source = String(markup).trim();
  if (!/^<svg[^>]*\sxmlns=/.test(source)) source = source.replace(/^<svg/, `<svg xmlns="${SVG_NS}"`);
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const rootEl = parsed.documentElement;
  if (!rootEl || rootEl.nodeName.toLowerCase() !== 'svg' || parsed.getElementsByTagName('parsererror').length > 0) {
    console.warn('[SecureMeasure] svgFromString: markup did not parse as SVG');
    return document.createElementNS(SVG_NS, 'svg');
  }
  for (const unsafe of Array.from(rootEl.querySelectorAll('script, foreignObject'))) unsafe.remove();
  for (const el of [rootEl, ...Array.from(rootEl.querySelectorAll('*'))]) {
    for (const attribute of Array.from(el.attributes)) {
      if (/^on/i.test(attribute.name)) el.removeAttribute(attribute.name);
    }
  }
  return document.importNode(rootEl, true);
}

/**
 * Standard screen heading block.
 *
 * @param {{ eyebrow?: string, title: string, subtitle?: string }} options
 * @returns {HTMLElement} `<header class="sm-screen-header">` containing `<h1 class="sm-title" tabindex="-1">`.
 */
export function screenHeader({ eyebrow, title, subtitle } = {}) {
  return h(
    'header',
    { class: 'sm-screen-header' },
    eyebrow ? h('p', { class: 'sm-eyebrow' }, eyebrow) : null,
    h('h1', { class: 'sm-title', attrs: { tabindex: '-1' } }, title),
    subtitle ? h('p', { class: 'sm-subtitle' }, subtitle) : null,
  );
}

function buttonClasses(variant, size, { full, iconOnly, file = false }) {
  return [
    'sm-btn',
    `sm-btn--${BUTTON_VARIANTS.has(variant) ? variant : 'primary'}`,
    `sm-btn--${BUTTON_SIZES.has(size) ? size : 'md'}`,
    full && 'sm-btn--full',
    iconOnly && 'sm-btn--icon-only',
    file && 'sm-btn--file',
  ];
}

/**
 * Button.
 *
 * @param {string} label Visible label; '' makes an icon-only button (then `ariaLabel` is required).
 * @param {object} [options]
 * @param {'primary'|'secondary'|'ghost'|'danger'} [options.variant='primary']
 * @param {'md'|'lg'|'sm'} [options.size='md']
 * @param {string} [options.icon] Icon name shown before the label.
 * @param {string} [options.iconEnd] Icon name shown after the label.
 * @param {(event: MouseEvent) => void} [options.onClick]
 * @param {boolean} [options.disabled=false]
 * @param {string} [options.type='button']
 * @param {boolean} [options.full=true] Full width. Icon-only buttons default to their natural square size instead.
 * @param {string} [options.ariaLabel]
 * @returns {HTMLButtonElement & { setLabel(text: string): void, setLoading(on: boolean): void }}
 */
export function button(label, {
  variant = 'primary', size = 'md', icon: iconName, iconEnd, onClick, disabled = false, type = 'button', full, ariaLabel,
} = {}) {
  const text = label === null || label === undefined ? '' : String(label);
  const iconOnly = text === '';
  const iconPx = BUTTON_ICON_PX[size] || 20;
  const labelEl = h('span', { class: 'sm-btn__label', text, hidden: iconOnly });
  const el = h(
    'button',
    { class: buttonClasses(variant, size, { full: full ?? !iconOnly, iconOnly }), type, disabled: Boolean(disabled) },
    iconName ? icon(iconName, iconPx) : null,
    labelEl,
    iconEnd ? icon(iconEnd, iconPx) : null,
  );
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
  if (typeof onClick === 'function') el.addEventListener('click', onClick);

  el.setLabel = (next) => {
    const value = next === null || next === undefined ? '' : String(next);
    labelEl.textContent = value;
    labelEl.hidden = value === '';
    el.classList.toggle('sm-btn--icon-only', value === '');
  };
  // While loading the button shows a spinner and ignores taps; its disabled state is left to the caller.
  el.setLoading = (on) => {
    el.classList.toggle('is-loading', Boolean(on));
    setAttr(el, 'aria-busy', on ? 'true' : null);
  };
  return el;
}

/**
 * File-picker button: a label styled as a button wrapping a visually hidden file input.
 *
 * @param {string} label
 * @param {object} [options]
 * @param {'primary'|'secondary'|'ghost'|'danger'} [options.variant='primary']
 * @param {'md'|'lg'|'sm'} [options.size='lg']
 * @param {string} [options.icon] Icon name shown before the label.
 * @param {string} [options.accept='image/*']
 * @param {string} [options.capture] e.g. 'environment' to open the rear camera directly.
 * @param {(file: File) => void} [options.onFile] Called with the chosen file; the input is cleared afterwards so the same file can be picked again.
 * @param {boolean} [options.full=true]
 * @returns {HTMLLabelElement & { input: HTMLInputElement, setLabel(text: string): void }}
 */
export function fileButton(label, {
  variant = 'primary', size = 'lg', icon: iconName, accept = 'image/*', capture, onFile, full = true,
} = {}) {
  const input = h('input', { class: 'sm-btn__file', type: 'file' });
  if (accept) input.setAttribute('accept', accept);
  if (capture) input.setAttribute('capture', capture === true ? 'environment' : String(capture));
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    try {
      if (file && typeof onFile === 'function') onFile(file);
    } finally {
      input.value = '';
    }
  });

  const labelEl = h('span', { class: 'sm-btn__label' }, label);
  const el = h(
    'label',
    { class: buttonClasses(variant, size, { full, iconOnly: false, file: true }) },
    iconName ? icon(iconName, BUTTON_ICON_PX[size] || 22) : null,
    labelEl,
    input,
  );
  el.input = input;
  el.setLabel = (next) => {
    labelEl.textContent = next === null || next === undefined ? '' : String(next);
  };
  return el;
}

/**
 * Sticky bottom bar for a screen's main actions (children stack vertically, primary first).
 *
 * @param {...(Node|string|null|undefined|false|Array)} children
 * @returns {HTMLDivElement} `<div class="sm-actionbar">`
 */
export function actionBar(...children) {
  return h('div', { class: 'sm-actionbar' }, children);
}

/**
 * Card container (a plain block: add `sm-stack` or your own layout class for spacing between children).
 *
 * @param {object|null} [props] As for h(); `class` is added to `sm-card`.
 * @param {...(Node|string|null|undefined|false|Array)} children
 * @returns {HTMLDivElement} `<div class="sm-card">`
 */
export function card(props, ...children) {
  if (isChildLike(props)) {
    children.unshift(props);
    props = null;
  }
  const { class: extraClass, className, ...rest } = props && typeof props === 'object' ? props : {};
  return h('div', { ...rest, class: ['sm-card', extraClass, className] }, children);
}

/**
 * Small status pill.
 *
 * @param {string} text
 * @param {{ tone?: 'neutral'|'success'|'warning'|'danger'|'accent', icon?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function chip(text, { tone = 'neutral', icon: iconName } = {}) {
  return h(
    'span',
    { class: ['sm-chip', `sm-chip--${CHIP_TONES.has(tone) ? tone : 'neutral'}`] },
    iconName ? icon(iconName, 16) : null,
    h('span', { class: 'sm-chip__label' }, text),
  );
}

/**
 * Inline message banner.
 *
 * @param {string} text Empty text hides the banner until update() gives it some.
 * @param {{ tone?: 'info'|'success'|'warning'|'danger', icon?: string }} [options] `icon` overrides the tone's default icon.
 * @returns {HTMLDivElement & { update(text: string, tone?: 'info'|'success'|'warning'|'danger'): void }}
 */
export function banner(text, { tone = 'info', icon: iconName } = {}) {
  const hasTone = (value) => Object.prototype.hasOwnProperty.call(BANNER_ICONS, value);
  let currentTone = hasTone(tone) ? tone : 'info';
  const iconSlot = h('span', { class: 'sm-banner__icon' });
  const textEl = h('p', { class: 'sm-banner__text' });
  const el = h('div', { class: 'sm-banner', attrs: { role: 'status' } }, iconSlot, textEl);

  el.update = (nextText, nextTone) => {
    if (hasTone(nextTone)) currentTone = nextTone;
    for (const name of Object.keys(BANNER_ICONS)) el.classList.toggle(`sm-banner--${name}`, name === currentTone);
    iconSlot.replaceChildren(icon(iconName || BANNER_ICONS[currentTone], 20));
    const value = nextText === null || nextText === undefined ? '' : String(nextText);
    textEl.textContent = value;
    el.hidden = value === '';
  };
  el.update(text, currentTone);
  return el;
}

/**
 * Labelled text input (or textarea) with hint, suffix and error wiring.
 *
 * @param {object} options
 * @param {string} [options.id] Used as the input's id and name (generated when omitted).
 * @param {string} options.label
 * @param {string} [options.type='text'] Any input type, or 'textarea'.
 * @param {string|number} [options.value='']
 * @param {boolean} [options.required=false] Sets aria-required (not the native required attribute; validate with setError).
 * @param {string} [options.autocomplete]
 * @param {string} [options.inputmode]
 * @param {string} [options.placeholder]
 * @param {string} [options.hint] Helper text under the input.
 * @param {string} [options.suffix] Short unit shown inside the input on the right, e.g. 'mm'.
 * @param {number|string} [options.min]
 * @param {number|string} [options.max]
 * @param {number|string} [options.step]
 * @param {number} [options.rows] Textarea rows (default 3).
 * @param {(value: string, event: Event) => void} [options.onInput]
 * @returns {{ el: HTMLDivElement, input: HTMLInputElement|HTMLTextAreaElement, setError(message: string|null): void }}
 */
export function field({
  id, label, type = 'text', value = '', required = false, autocomplete, inputmode, placeholder,
  hint, suffix, min, max, step, rows, onInput,
} = {}) {
  const inputId = id || uid('sm-field');
  const hintId = `${inputId}-hint`;
  const suffixId = `${inputId}-suffix`;
  const errorId = `${inputId}-error`;
  const isTextarea = type === 'textarea';

  const input = document.createElement(isTextarea ? 'textarea' : 'input');
  input.id = inputId;
  input.name = inputId;
  input.className = isTextarea ? 'sm-input sm-input--textarea' : 'sm-input';
  if (isTextarea) input.rows = rows || 3;
  else input.type = type;
  if (value !== null && value !== undefined) input.value = String(value);
  // aria-required only: the native attribute would make the browser block a form submit with its own
  // bubble before the screen's validation (lead.js validateCustomer -> setError) gets to run.
  if (required) input.setAttribute('aria-required', 'true');
  if (autocomplete) input.setAttribute('autocomplete', autocomplete);
  if (inputmode) input.setAttribute('inputmode', inputmode);
  if (placeholder) input.placeholder = placeholder;
  setAttr(input, 'min', min);
  setAttr(input, 'max', max);
  setAttr(input, 'step', step);
  if (typeof onInput === 'function') input.addEventListener('input', (event) => onInput(input.value, event));

  const errorEl = h('p', { class: 'sm-field__error', id: errorId, hidden: true, attrs: { 'aria-live': 'polite' } });
  const control = h(
    'div',
    { class: 'sm-field__control' },
    input,
    suffix ? h('span', { class: 'sm-field__suffix', id: suffixId }, suffix) : null,
  );
  // Tapping the unit suffix (or the control's padding) should still focus the input.
  control.addEventListener('click', (event) => {
    if (event.target !== input) input.focus();
  });

  const el = h(
    'div',
    { class: 'sm-field', dataset: { field: inputId } },
    label !== null && label !== undefined && label !== ''
      ? h('label', { class: 'sm-field__label', attrs: { for: inputId } }, label)
      : null,
    control,
    hint ? h('p', { class: 'sm-field__hint', id: hintId }, hint) : null,
    errorEl,
  );

  const describe = (hasError) => {
    const ids = [suffix ? suffixId : null, hint ? hintId : null, hasError ? errorId : null].filter(Boolean);
    setAttr(input, 'aria-describedby', ids.length ? ids.join(' ') : null);
  };
  const setError = (message) => {
    const text = message === null || message === undefined || message === false ? '' : String(message);
    errorEl.textContent = text;
    errorEl.hidden = text === '';
    el.classList.toggle('has-error', text !== '');
    setAttr(input, 'aria-invalid', text ? 'true' : null);
    describe(text !== '');
  };
  describe(false);

  return { el, input, setError };
}

/**
 * Checkbox with a label (e.g. the consent tick).
 *
 * @param {object} options
 * @param {string} [options.id]
 * @param {string|Node} options.label
 * @param {boolean} [options.checked=false]
 * @param {(checked: boolean) => void} [options.onChange]
 * @returns {{ el: HTMLDivElement, input: HTMLInputElement, setError(message: string|null): void }}
 */
export function checkbox({ id, label, checked = false, onChange } = {}) {
  const inputId = id || uid('sm-check');
  const labelId = `${inputId}-label`;
  const errorId = `${inputId}-error`;
  const input = h('input', { class: 'sm-check__input', type: 'checkbox', id: inputId, checked: Boolean(checked) });
  input.name = inputId;
  if (typeof onChange === 'function') input.addEventListener('change', () => onChange(input.checked));

  // The visible text is the checkbox's name. Being inside the <label> is not enough for everything
  // that reads the page: some tools announce the checkbox's value ("on") instead. aria-labelledby
  // ties the two together outright; aria-label says the same for anything that does not follow it.
  const labelEl = h('span', { class: 'sm-check__label', id: labelId }, label);
  input.setAttribute('aria-labelledby', labelId);
  const labelText = labelEl.textContent.trim();
  if (labelText) input.setAttribute('aria-label', labelText);

  const errorEl = h('p', { class: 'sm-field__error', id: errorId, hidden: true, attrs: { 'aria-live': 'polite' } });
  const el = h(
    'div',
    { class: 'sm-check' },
    h(
      'label',
      { class: 'sm-check__row', attrs: { for: inputId } },
      input,
      h('span', { class: 'sm-check__box', attrs: { 'aria-hidden': 'true' } }, icon('check', 16)),
      labelEl,
    ),
    errorEl,
  );

  const setError = (message) => {
    const text = message === null || message === undefined || message === false ? '' : String(message);
    errorEl.textContent = text;
    errorEl.hidden = text === '';
    el.classList.toggle('has-error', text !== '');
    setAttr(input, 'aria-invalid', text ? 'true' : null);
    setAttr(input, 'aria-describedby', text ? errorId : null);
  };

  return { el, input, setError };
}

/**
 * Single-choice radio group styled as wrapping chips.
 *
 * @param {object} options
 * @param {string} [options.name] Radio group name (generated when omitted).
 * @param {string} [options.ariaLabel]
 * @param {Array<{ value: any, label: string, hint?: string, badge?: string }>} options.options
 * @param {any} [options.value] Initially selected value.
 * @param {(value: any) => void} [options.onChange] Called on user selection only (not by setValue).
 * @returns {{ el: HTMLDivElement, setValue(value: any): void, getValue(): any }}
 */
export function segmented({ name, ariaLabel, options = [], value, onChange } = {}) {
  const groupName = name || uid('sm-seg');
  let current = value;
  const items = [];
  const el = h('div', { class: 'sm-segmented', attrs: { role: 'radiogroup', 'aria-label': ariaLabel || null } });

  for (const option of options || []) {
    if (!option) continue;
    const input = h('input', {
      class: 'sm-seg__input', type: 'radio', name: groupName, value: String(option.value), checked: sameValue(option.value, value),
    });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      current = option.value;
      if (typeof onChange === 'function') onChange(option.value);
    });
    items.push({ value: option.value, input });
    el.appendChild(h(
      'label',
      { class: 'sm-seg' },
      input,
      h(
        'span',
        { class: 'sm-seg__body' },
        h(
          'span',
          { class: 'sm-seg__top' },
          h('span', { class: 'sm-seg__label' }, option.label),
          option.badge ? h('span', { class: 'sm-seg__badge' }, option.badge) : null,
        ),
        option.hint ? h('span', { class: 'sm-seg__hint' }, option.hint) : null,
      ),
    ));
  }

  return {
    el,
    setValue(next) {
      current = next;
      for (const item of items) item.input.checked = sameValue(item.value, next);
    },
    getValue() {
      return current;
    },
  };
}

/**
 * Single-choice radio group of large selectable cards (e.g. products).
 *
 * @param {object} options
 * @param {string} [options.name] Radio group name (generated when omitted).
 * @param {string} [options.ariaLabel]
 * @param {Array<{ value: any, title: string, description?: string, features?: string[], badge?: string, price?: string }>} options.options
 *   `price` is a ready-formatted string.
 * @param {any} [options.value] Initially selected value.
 * @param {(value: any) => void} [options.onChange] Called on user selection only (not by setValue).
 * @returns {{ el: HTMLDivElement, setValue(value: any): void, getValue(): any }}
 */
export function radioCards({ name, ariaLabel, options = [], value, onChange } = {}) {
  const groupName = name || uid('sm-cards');
  let current = value;
  const items = [];
  const el = h('div', { class: 'sm-radiocards', attrs: { role: 'radiogroup', 'aria-label': ariaLabel || null } });

  for (const option of options || []) {
    if (!option) continue;
    const input = h('input', {
      class: 'sm-radiocard__input', type: 'radio', name: groupName, value: String(option.value), checked: sameValue(option.value, value),
    });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      current = option.value;
      if (typeof onChange === 'function') onChange(option.value);
    });
    items.push({ value: option.value, input });

    const features = Array.isArray(option.features) ? option.features.filter((feature) => feature !== null && feature !== undefined && feature !== '') : [];
    el.appendChild(h(
      'label',
      { class: 'sm-radiocard', dataset: { value: String(option.value) } },
      input,
      h(
        'span',
        { class: 'sm-radiocard__body' },
        h('span', { class: 'sm-radiocard__dot', attrs: { 'aria-hidden': 'true' } }),
        h(
          'span',
          { class: 'sm-radiocard__main' },
          h(
            'span',
            { class: 'sm-radiocard__head' },
            h(
              'span',
              { class: 'sm-radiocard__titles' },
              option.badge ? h('span', { class: 'sm-radiocard__badge' }, option.badge) : null,
              h('span', { class: 'sm-radiocard__title' }, option.title),
            ),
            option.price !== null && option.price !== undefined && option.price !== ''
              ? h('span', { class: 'sm-radiocard__price sm-num' }, option.price)
              : null,
          ),
          option.description ? h('span', { class: 'sm-radiocard__desc' }, option.description) : null,
          features.length
            ? h('ul', { class: 'sm-radiocard__features' }, features.map((feature) => h('li', null, icon('check', 16), h('span', null, feature))))
            : null,
        ),
      ),
    ));
  }

  return {
    el,
    setValue(next) {
      current = next;
      for (const item of items) item.input.checked = sameValue(item.value, next);
    },
    getValue() {
      return current;
    },
  };
}

/**
 * Switch row: label and optional description on the left, optional short trailing text, switch on the right.
 *
 * @param {object} options
 * @param {string} [options.id]
 * @param {string} options.label
 * @param {string} [options.description]
 * @param {string} [options.trailing] Short string such as '+$180'.
 * @param {boolean} [options.checked=false]
 * @param {(checked: boolean) => void} [options.onChange]
 * @returns {{ el: HTMLLabelElement, input: HTMLInputElement, setTrailing(text: string|null): void }}
 */
export function toggleRow({ id, label, description, trailing, checked = false, onChange } = {}) {
  const inputId = id || uid('sm-toggle');
  const input = h('input', {
    class: 'sm-toggle__input', type: 'checkbox', id: inputId, checked: Boolean(checked), attrs: { role: 'switch' },
  });
  input.name = inputId;
  if (typeof onChange === 'function') input.addEventListener('change', () => onChange(input.checked));

  const trailingEl = h('span', { class: 'sm-toggle__trailing sm-num' });
  const setTrailing = (text) => {
    const value = text === null || text === undefined ? '' : String(text);
    trailingEl.textContent = value;
    trailingEl.hidden = value === '';
  };
  setTrailing(trailing);

  const el = h(
    'label',
    { class: 'sm-toggle', attrs: { for: inputId } },
    h(
      'span',
      { class: 'sm-toggle__text' },
      h('span', { class: 'sm-toggle__label' }, label),
      description ? h('span', { class: 'sm-toggle__desc' }, description) : null,
    ),
    trailingEl,
    h('span', { class: 'sm-toggle__control' }, input, h('span', { class: 'sm-toggle__switch', attrs: { 'aria-hidden': 'true' } })),
  );

  return { el, input, setTrailing };
}

/**
 * Collapsible section built on <details>.
 *
 * @param {{ summary: string, open?: boolean }} options
 * @param {...(Node|string|null|undefined|false|Array)} children
 * @returns {HTMLDetailsElement} `<details class="sm-disclosure">`
 */
export function disclosure({ summary, open = false } = {}, ...children) {
  return h(
    'details',
    { class: 'sm-disclosure', open: Boolean(open) },
    h('summary', { class: 'sm-disclosure__summary' }, h('span', { class: 'sm-disclosure__label' }, summary), icon('chevron-down', 20)),
    h('div', { class: 'sm-disclosure__body' }, children),
  );
}

/**
 * Modal bottom sheet built on <dialog>. It is appended to document.body when opened and removed when closed.
 * Closes on the close button, a tap on the backdrop, or Escape.
 *
 * @param {{ title: string }} options
 * @param {...(Node|string|null|undefined|false|Array)} children
 * @returns {{ el: HTMLDialogElement, open(): void, close(): void }}
 */
export function bottomSheet({ title } = {}, ...children) {
  const titleId = uid('sm-sheet-title');
  const closeButton = button('', { variant: 'ghost', size: 'sm', icon: 'close', ariaLabel: uiStrings.close, onClick: () => close() });
  closeButton.classList.add('sm-sheet__close');

  const el = h(
    'dialog',
    { class: 'sm-sheet', attrs: { 'aria-labelledby': titleId } },
    h(
      'div',
      { class: 'sm-sheet__panel' },
      h('span', { class: 'sm-sheet__grip', attrs: { 'aria-hidden': 'true' } }),
      h('header', { class: 'sm-sheet__header' }, h('h2', { class: 'sm-sheet__title', id: titleId }, title), closeButton),
      h('div', { class: 'sm-sheet__body' }, children),
    ),
  );

  // iOS Safari before 15.4 has no <dialog>; there the sheet is shown as a plain fixed panel over its own backdrop.
  const native = typeof el.showModal === 'function';
  let isOpen = false;
  let backdrop = null;
  let returnFocus = null;
  const api = { el, open, close };

  const onKeydown = (event) => {
    if (event.key === 'Escape') close();
  };

  function open() {
    if (isOpen) return;
    isOpen = true;
    returnFocus = document.activeElement;
    closeButton.setAttribute('aria-label', uiStrings.close);
    if (native) {
      document.body.appendChild(el);
      el.showModal();
    } else {
      backdrop = h('div', { class: 'sm-sheet-backdrop', on: { click: () => close() } });
      el.classList.add('sm-sheet--fallback');
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('open', '');
      document.body.append(backdrop, el);
      document.addEventListener('keydown', onKeydown);
      closeButton.focus();
    }
    openSheets.add(api);
  }

  function finish() {
    if (!isOpen) return;
    isOpen = false;
    openSheets.delete(api);
    document.removeEventListener('keydown', onKeydown);
    if (backdrop) backdrop.remove();
    backdrop = null;
    el.removeAttribute('open');
    el.remove();
    if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }

  function close() {
    if (!isOpen) return;
    if (native && el.open) el.close();
    finish();
  }

  // With zero dialog padding, a click whose target is the dialog itself landed on the backdrop.
  el.addEventListener('click', (event) => {
    if (event.target === el) close();
  });
  // Escape closes a native dialog by itself; this keeps our state in step with it. The event is
  // queued, so after close() + open() in one tick it can arrive while the sheet is open again.
  el.addEventListener('close', () => {
    if (!el.open) finish();
  });

  return api;
}

/**
 * Close every open bottom sheet. The shell calls this when it leaves a screen.
 */
export function closeOpenSheets() {
  for (const sheet of Array.from(openSheets)) sheet.close();
}

/**
 * Replace the kit's own (non-screen) strings with translated text. Called once by the shell.
 *
 * @param {{ close?: string }} strings
 */
export function setUiStrings(strings) {
  for (const [key, value] of Object.entries(strings || {})) {
    if (typeof value === 'string' && value) uiStrings[key] = value;
  }
}

/**
 * Format a millimetre value as a rounded integer string, e.g. 819.6 -> '820'.
 *
 * @param {number} n
 * @returns {string} '' when n is not a finite number.
 */
export function fmtMm(n) {
  const value = Number(n);
  if (n === null || n === undefined || n === '' || !Number.isFinite(value)) return '';
  return String(Math.round(value));
}
