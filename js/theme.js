/**
 * Config loading and theming.
 *
 * Merges an optional skin over js/config.js and pushes the brand settings into
 * CSS custom properties. Nothing here touches the DOM at import time, so the
 * module also runs under Node for tests.
 */

import baseConfig from './config.js';

/** Keys that could reach Object.prototype if copied from untrusted data. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The skin name becomes part of a dynamic import path, so it is restricted to
 * characters that can never form a path separator, a dot segment or a URL scheme.
 */
const SKIN_NAME_PATTERN = /^[a-z0-9-]{1,40}$/;

/** brand.colors key -> CSS custom property. */
const COLOR_PROPERTIES = {
  primary: '--sm-primary',
  primaryContrast: '--sm-primary-contrast',
  accent: '--sm-accent',
  accentContrast: '--sm-accent-contrast',
  background: '--sm-bg',
  surface: '--sm-surface',
  text: '--sm-text',
  muted: '--sm-muted',
  border: '--sm-border',
  success: '--sm-success',
  warning: '--sm-warning',
  danger: '--sm-danger',
};

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CSS_LENGTH_PATTERN = /^\d*\.?\d+(?:px|rem|em)$/;
const BARE_NUMBER_PATTERN = /^\d*\.?\d+$/;
/** A language tag such as 'en-AU', 'en', 'de' or 'zh-Hant-TW': a 2 or 3 letter language, then optional dash-separated parts. */
const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;

const LOG_PREFIX = '[SecureMeasure]';

/** Lowest WCAG contrast ratio at which the primary colour is still used as a text colour. */
const MIN_TEXT_CONTRAST = 4.5;

/**
 * @param {string} hex a colour accepted by toHexColor (#rgb, #rgba, #rrggbb or #rrggbbaa; alpha is ignored)
 * @returns {number} WCAG relative luminance, from 0 (black) to 1 (white)
 */
function luminance(hex) {
  const digits = hex.length <= 5 ? hex.slice(1).replace(/./g, '$&$&') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(digits.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * @param {string} a hex colour
 * @param {string} b hex colour
 * @returns {number} WCAG contrast ratio between the two, from 1 to 21
 */
function contrastRatio(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * @param {unknown} value
 * @returns {boolean} true for object literals and Object.create(null) objects only
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copies plain objects and arrays so a merge result never shares mutable
 * structure with its inputs. Anything else (primitives, functions, class
 * instances) is returned as is.
 * @param {unknown} value
 * @returns {unknown}
 */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = clone(value[key]);
  }
  return out;
}

/**
 * Recursively merges `override` over `base` and returns a new value.
 *
 * Plain objects are merged key by key. Arrays, primitives and null in
 * `override` replace the base value outright (an array is never merged item by
 * item). An `undefined` override, at the top level or for a single key, means
 * "not specified" and keeps the base value. Neither input is mutated and the
 * result shares no objects or arrays with them. The keys `__proto__`,
 * `constructor` and `prototype` are dropped wherever they appear.
 *
 * @template T
 * @param {T} base
 * @param {unknown} override
 * @returns {T} merged deep copy
 */
export function deepMerge(base, override) {
  if (override === undefined) return /** @type {T} */ (clone(base));
  if (!isPlainObject(base) || !isPlainObject(override)) return /** @type {T} */ (clone(override));

  const out = {};
  for (const key of Object.keys(base)) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = clone(base[key]);
  }
  for (const key of Object.keys(override)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (override[key] === undefined) continue;
    out[key] = deepMerge(base[key], override[key]);
  }
  return /** @type {T} */ (out);
}

/**
 * Reads the requested skin name from a query string.
 * @param {unknown} search e.g. '?skin=acme' (a URLSearchParams is accepted too)
 * @returns {string | null} the raw (unvalidated) name, or null when none was requested
 */
function requestedSkin(search) {
  try {
    const name = new URLSearchParams(search ?? '').get('skin');
    return name ? name : null;
  } catch {
    return null;
  }
}

/**
 * Loads the app configuration: js/config.js, with skins/<name>.js deep-merged
 * over it when the page was opened with `?skin=<name>`.
 *
 * The name must match /^[a-z0-9-]{1,40}$/. An invalid name, a missing skin file
 * or a skin that fails to load logs a console warning and yields the base
 * config, so the app always starts. Every call returns a fresh copy that is
 * safe to mutate.
 *
 * @param {string} [search] query string to read; defaults to the page's own
 * @returns {Promise<object>} the merged config
 */
export async function loadConfig(search = globalThis.location?.search ?? '') {
  const base = deepMerge(baseConfig, undefined);

  const name = requestedSkin(search);
  if (name === null) return base;

  if (!SKIN_NAME_PATTERN.test(name)) {
    // The rejected value is not echoed: it is attacker-controlled and unbounded.
    console.warn(`${LOG_PREFIX} Ignoring invalid skin name. Use lower-case letters, numbers and dashes (40 at most).`);
    return base;
  }

  try {
    const module = await import(`../skins/${name}.js`);
    if (!isPlainObject(module.default)) {
      throw new TypeError('a skin must "export default" a settings object');
    }
    return deepMerge(base, module.default);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Could not load skin "${name}"; using the default settings.`, error);
    return base;
  }
}

/**
 * @param {unknown} value
 * @returns {string | null} a trimmed hex colour, or null when the value is not one
 */
function toHexColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * @param {unknown} value '14px', '0.5rem', '14' or 14
 * @returns {string | null} a CSS length (bare numbers are read as px), or null when unusable
 */
function toCssLength(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? `${value}px` : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (BARE_NUMBER_PATTERN.test(trimmed)) return `${trimmed}px`;
  return CSS_LENGTH_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * @param {unknown} value
 * @returns {string | null} a font-family list, or null when empty or not plain declaration text
 */
function toFontFamily(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed !== '' && !/[;{}<>]/.test(trimmed) ? trimmed : null;
}

/**
 * @param {unknown} value
 * @returns {string | null} a trimmed language tag, or null when the value is not one
 */
function toLanguageTag(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return LANGUAGE_TAG_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Applies the brand to the page: the 14 `--sm-*` custom properties on `root`,
 * the page language (`brand.lang`, as the `lang` attribute of `root`), the
 * document title, and `<meta name="theme-color">` (created if absent).
 *
 * A setting that is missing or malformed (for example a typo in a hex colour)
 * is skipped with a console warning rather than written, so the default from
 * css/base.css stays in force instead of an invalid value blanking the colour.
 * A missing `brand.lang` is skipped silently: the language written in
 * index.html then stays.
 *
 * One more property, `--sm-ink-primary`, is written only when the primary
 * colour is too light (or too dark) to read as text on the surface and
 * background colours: labels drawn in the primary colour then use the text
 * colour instead, and a console warning says so.
 *
 * @param {object} config the merged config from loadConfig
 * @param {{ style?: { setProperty: Function }, setAttribute?: Function, ownerDocument?: object | null }} [root]
 *   element that receives the custom properties and the language; defaults to the <html> element
 * @returns {void}
 */
export function applyTheme(config, root = globalThis.document?.documentElement) {
  const brand = isPlainObject(config?.brand) ? config.brand : {};
  const colors = isPlainObject(brand.colors) ? brand.colors : {};

  const style = root?.style;
  if (style && typeof style.setProperty === 'function') {
    const set = (property, value, settingName) => {
      if (value === null) {
        console.warn(`${LOG_PREFIX} ${settingName} is missing or not valid; keeping the default.`);
        return;
      }
      style.setProperty(property, value);
    };

    for (const [key, property] of Object.entries(COLOR_PROPERTIES)) {
      set(property, toHexColor(colors[key]), `brand.colors.${key}`);
    }

    // The primary colour is also drawn as text and icons on the surface and page colours (header name,
    // links, outline buttons: --sm-ink-primary in css/base.css). A light brand colour cannot be read
    // there, so those labels take the text colour instead; fills and borders keep the primary colour.
    const [primary, text, surface, background] = ['primary', 'text', 'surface', 'background'].map((key) => toHexColor(colors[key]));
    if (primary && text && surface && background) {
      const onPage = (colour) => Math.min(contrastRatio(colour, surface), contrastRatio(colour, background));
      const contrast = onPage(primary);
      if (contrast < MIN_TEXT_CONTRAST && onPage(text) > contrast) {
        style.setProperty('--sm-ink-primary', text);
        console.warn(
          `${LOG_PREFIX} brand.colors.primary is hard to read as text on the surface and background colours (contrast ${contrast.toFixed(1)} to 1; ${MIN_TEXT_CONTRAST} is needed), so labels in that colour use brand.colors.text instead. To keep a light brand colour, put it in accent and choose a dark primary.`,
        );
      }
    }

    set('--sm-radius', toCssLength(brand.radius), 'brand.radius');
    set('--sm-font', toFontFamily(brand.fontFamily), 'brand.fontFamily');
  }

  // The language the wording is written in. Screen readers pick their voice from it, so a translated
  // config or skin has to be able to change it; index.html only knows the language of the default wording.
  if (brand.lang !== undefined && brand.lang !== null && brand.lang !== '') {
    const lang = toLanguageTag(brand.lang);
    if (lang === null) {
      console.warn(`${LOG_PREFIX} brand.lang is not a language tag such as 'en-AU' or 'de'; keeping the page's own language.`);
    } else if (typeof root?.setAttribute === 'function') {
      root.setAttribute('lang', lang);
    }
  }

  const doc = root?.ownerDocument ?? globalThis.document;
  if (!doc) return;

  const name = typeof brand.name === 'string' ? brand.name.trim() : '';
  const tagline = typeof brand.tagline === 'string' ? brand.tagline.trim() : '';
  if (name) doc.title = tagline ? `${name} | ${tagline}` : name;

  // The browser chrome (status bar / address bar tint) takes the brand colour.
  const themeColor = toHexColor(colors.primary);
  if (themeColor) {
    let meta = typeof doc.querySelector === 'function' ? doc.querySelector('meta[name="theme-color"]') : null;
    if (!meta && doc.head && typeof doc.createElement === 'function') {
      meta = doc.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      doc.head.appendChild(meta);
    }
    if (meta) meta.setAttribute('content', themeColor);
  }
}
