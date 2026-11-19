// AR Quick Look lab page: the UI. Builds a life-size gauge as a USDZ on the phone (or links a committed
// copy), opens it in iOS AR Quick Look through an <a rel="ar"> link, and records what the tester saw.
//
// Questions it answers on an iPhone (see index.html): does a page-made USDZ open from Safari (blob URL vs
// static file); does it stick to the wall the right way up (vertical anchoring vs none); does the scale
// lock survive a pinch; how close is ARKit's life size to a tape (floor check, door readings); does the
// 'This size fits' banner tap reach the page; can a person pick the right standard size from 2-3 outlines.
//
// Rules: no network except this site's own files, nothing leaves the phone except what the tester copies
// or shares, every localStorage access in try/catch (state falls back to memory with a warning), camera
// only from a tap. The main app is imported read-only and never changed.

import config from '../../js/config.js';
import { estimateFromCorners, photoFocal, standardSizesFrom } from '../../js/estimate.js';
import { capturePhoto, cameraErrorKind, embedBlocksCamera, startCamera, stopCamera } from '../../js/camera.js';
import { loadPhoto } from '../../js/photo.js';
import { findDoor, startingQuad } from '../../js/door-find.js';
import { fitView, hitTestHandle, imageToScreen, screenToImage } from '../../js/editor.js';
import { makeUsdz, readZip, utf8 } from './usdz.js';
import { encodePng } from './png.js';
import {
  DESIGN_INFO,
  STATIC_VARIANTS,
  buildDesign,
  cleanCatalogue,
  outlineFragment,
  quickLookFragment,
  staticFileFor,
  variantKey,
  withFragment,
} from './gauge.js';
import {
  FITS,
  TRUE_SIZE_TOL,
  computeRow,
  flowTruth,
  goNoGo,
  num,
  rowUse,
  sameSize,
  standardForTape,
  summarize,
  summarizeFlow,
  timeAwayAll,
} from './stats.js';

const STORE_KEY = 'sm-lab-arql-v1';
const QL_TAPPED = '_apple_ar_quicklook_button_tapped';
const USDZ_TYPE = 'model/vnd.usdz+zip';
const MAX_USDZ_BYTES = 3 * 1024 * 1024;
const MAX_EVENTS = 300;
/** Ids of deleted rows kept, so another open copy of the page cannot bring them back. */
const MAX_DELETED = 1000;
/** A pending AR run older than this is not tied to the next row automatically. */
const PENDING_MAX_MS = 3 * 60 * 60 * 1000;

const SIZES = cleanCatalogue(standardSizesFrom(config));

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------------------------------------------
// State and storage
// ------------------------------------------------------------------------------------------------------

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function defaults() {
  return {
    v: 1,
    // Storage revision: every save adds one. Another copy of the page (embed.html's iframe, a second tab,
    // a page Back brought from the cache) must never write over a newer one; see saveState.
    rev: 0,
    // A new epoch on 'Clear all': copies that still hold the old results drop them instead of merging.
    epoch: newId(),
    deleted: [],
    env: { model: '', ios: '', lidar: '', ownerLeaveOk: '', ownerNote: '' },
    form: {
      design: 'A',
      anchoring: 'vertical',
      orientation: 'xy',
      lock: 'on',
      delivery: 'blob',
      downloadAttr: true,
      forcePngJs: false,
      tapeH: 2500,
      tapeW: 1300,
      gridW: 1300,
      gridH: 2500,
      outlineW: 820,
      outlineH: 2040,
      floorL: 2000,
    },
    draft: emptyDraft(),
    // The step-2 run waiting for its step-3 row, and (separately) the last step-4 outline opened.
    pending: null,
    flowPending: null,
    lastBuild: null,
    rows: [],
    flowDraft: { tape: { w: '', h: '', doorId: '', size: '' }, count: '3', useStep2: false },
    flow: null,
    flowRows: [],
    bannerSeen: false,
    events: [],
  };
}

function emptyDraft(keep = {}) {
  return {
    design: keep.design || 'A',
    anchoring: keep.anchoring || '',
    orientation: keep.orientation || '',
    lock: keep.lock || '',
    delivery: keep.delivery || '',
    opened: '',
    openedNote: '',
    stuck: '',
    stickSec: '',
    upright: '',
    drag: '',
    pinch: '',
    readBeforePinch: '',
    light: keep.light || '',
    distM: keep.distM || '',
    readings: {},
    tape: keep.tape ? { ...keep.tape } : { w: '', h: '', doorId: '' },
  };
}

const storage = { ok: true, reason: '' };
let state = defaults();

function probeStorage() {
  try {
    const k = `${STORE_KEY}-probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
  } catch (error) {
    storage.ok = false;
    storage.reason = (error && error.name) || 'blocked';
  }
}

function loadState() {
  if (!storage.ok) return null;
  let raw = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch (error) {
    storage.ok = false;
    storage.reason = (error && error.name) || 'blocked';
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function storedRev(saved) {
  return saved && Number.isFinite(saved.rev) ? saved.rev : -1;
}

function eventKey(e) {
  return e.id || `${e.t}|${e.type}|${e.detail || ''}`;
}

/** Two lists of rows joined by id (oldest first), leaving out deleted ids. */
function joinById(a, b, gone) {
  const seen = new Set();
  const out = [];
  for (const x of [...a, ...b]) {
    if (!x || !x.id || gone.has(x.id) || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out.sort((p, q) => String(p.at || '').localeCompare(String(q.at || '')));
}

/**
 * This copy's state combined with a newer stored one: rows, flow rows and events from both (deleted ones
 * left out), and the form, draft and pending runs from `mine` (keepMine: this copy is the one being used)
 * or from the stored copy (sync: another copy wrote since). A stored copy from a later 'Clear all' (new
 * epoch) replaces this copy's results.
 */
function combine(mine, theirs, keepMine) {
  const out = keepMine ? { ...mine } : { ...theirs };
  out.rev = Math.max(storedRev(mine), storedRev(theirs));
  if (mine.epoch !== theirs.epoch) {
    for (const k of ['epoch', 'rows', 'flowRows', 'events', 'deleted', 'bannerSeen']) out[k] = theirs[k];
    return out;
  }
  out.deleted = [...new Set([...theirs.deleted, ...mine.deleted])].slice(-MAX_DELETED);
  const gone = new Set(out.deleted);
  out.rows = joinById(theirs.rows, mine.rows, gone);
  out.flowRows = joinById(theirs.flowRows, mine.flowRows, gone);
  const events = new Map();
  for (const e of [...theirs.events, ...mine.events]) events.set(eventKey(e), e);
  out.events = [...events.values()].sort((p, q) => p.t - q.t).slice(-MAX_EVENTS);
  out.bannerSeen = mine.bannerSeen || theirs.bannerSeen;
  return out;
}

/**
 * Save, never over a newer copy: when another copy of the page saved since this one last read or wrote,
 * merge its results in first (see combine). Every change in this page is saved at once, so this copy
 * never holds unsaved results.
 */
function saveState() {
  if (!storage.ok) return;
  const stored = loadState();
  if (!storage.ok) {
    showStorageWarning();
    return;
  }
  if (stored && storedRev(stored) > state.rev) {
    state = combine(state, restore(stored), true);
    // Show the rows the other copy added, once the handler that is saving has finished.
    queueMicrotask(() => {
      renderSession();
      renderLog();
    });
  }
  state.rev = Math.max(state.rev, storedRev(stored)) + 1;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (error) {
    storage.ok = false;
    storage.reason = (error && error.name) || 'full';
    showStorageWarning();
  }
}

/**
 * Take in what another copy of the page saved (on pageshow, focus, visible again, and the 'storage'
 * event), so a copy restored from the back-forward cache or a second tab does not carry on from old state.
 * @returns {boolean} whether anything changed
 */
function syncFromStorage() {
  const stored = loadState();
  if (!stored || storedRev(stored) <= state.rev) return false;
  const hadFlow = state.flow ? state.flow.startedAt : null;
  state = combine(state, restore(stored), false);
  syncInputs();
  renderAll();
  // Another copy started or saved a different photo: this copy's photo and outline links are not it.
  if (!state.flow || state.flow.startedAt !== hadFlow) {
    clearFlowUi();
    restoreFlow();
  } else {
    renderFlowPick();
  }
  return true;
}

/** Merge a stored state over the defaults, keeping only the shapes this page knows. */
function restore(saved) {
  const d = defaults();
  if (!saved || typeof saved !== 'object') return d;
  const obj = (v, dflt) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...dflt, ...v } : dflt);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const form = obj(saved.form, d.form);
  const oneOf = (key, list) => {
    if (!list.includes(form[key])) form[key] = d.form[key];
  };
  oneOf('design', ['A', 'B', 'C', 'D', 'E']);
  oneOf('anchoring', ['vertical', 'none', 'horizontal']);
  oneOf('orientation', ['xy', 'xz']);
  oneOf('lock', ['on', 'off']);
  oneOf('delivery', ['blob', 'static']);
  const draft = obj(saved.draft, d.draft);
  if (!['A', 'B', 'C', 'D', 'E'].includes(draft.design)) draft.design = 'A';
  const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  return {
    ...d,
    rev: Number.isFinite(saved.rev) ? saved.rev : 0,
    epoch: typeof saved.epoch === 'string' && saved.epoch ? saved.epoch : 'first',
    deleted: Array.isArray(saved.deleted) ? saved.deleted.filter((x) => typeof x === 'string').slice(-MAX_DELETED) : [],
    env: obj(saved.env, d.env),
    form,
    draft: { ...draft, readings: obj(draft.readings, {}), tape: obj(draft.tape, d.draft.tape) },
    pending: plain(saved.pending),
    flowPending: plain(saved.flowPending),
    lastBuild: plain(saved.lastBuild),
    rows: arr(saved.rows),
    flowDraft: { ...obj(saved.flowDraft, d.flowDraft), tape: obj(saved.flowDraft && saved.flowDraft.tape, d.flowDraft.tape) },
    flow: plain(saved.flow),
    flowRows: arr(saved.flowRows),
    bannerSeen: saved.bannerSeen === true,
    events: arr(saved.events).slice(-MAX_EVENTS),
  };
}

function showStorageWarning() {
  const el = $('storage-warning');
  el.textContent =
    `This browser will not let the page save (${storage.reason || 'blocked'}; private browsing?). ` +
    'Results are kept only while this tab stays open, and iOS may reload the tab after AR. Copy results (step 5) after every row.';
  el.classList.remove('hidden');
}

// ------------------------------------------------------------------------------------------------------
// Small DOM helpers
// ------------------------------------------------------------------------------------------------------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function kvRows(table, pairs) {
  table.replaceChildren(...pairs.map(([k, v]) => h('tr', {}, h('th', { scope: 'row', text: k }), h('td', { text: v === null || v === undefined || v === '' ? '-' : v }))));
}

function dataTable(table, head, rows) {
  table.replaceChildren(
    h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { scope: 'col', text: x })))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => (c instanceof Node ? h('td', {}, c) : h('td', { text: c === null || c === undefined ? '-' : c })))))),
  );
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function status(id, text, kind = 'note') {
  const el = $(id);
  if (!text) {
    el.replaceChildren();
    el.className = '';
    return;
  }
  el.className = kind;
  el.textContent = text;
}

function show(id, on) {
  $(id).classList.toggle('hidden', !on);
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB (${bytes} bytes)`;
}

// ------------------------------------------------------------------------------------------------------
// Form binding: every [data-bind="a.b.c"] input reads and writes state.a.b.c
// ------------------------------------------------------------------------------------------------------

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

function writeInput(el, value) {
  if (el.type === 'radio') el.checked = String(value) === el.value;
  else if (el.type === 'checkbox') el.checked = Boolean(value);
  else el.value = value === undefined || value === null ? '' : String(value);
}

function readInput(el) {
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

function syncInputs(prefix = '') {
  for (const el of document.querySelectorAll('[data-bind]')) {
    if (prefix && !el.dataset.bind.startsWith(prefix)) continue;
    writeInput(el, getPath(state, el.dataset.bind));
  }
}

function bindInputs() {
  for (const el of document.querySelectorAll('[data-bind]')) {
    const live = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number' || el.type === 'tel');
    el.addEventListener(live ? 'input' : 'change', () => {
      if (el.type === 'radio' && !el.checked) return;
      setPath(state, el.dataset.bind, readInput(el));
      onBound(el.dataset.bind);
      saveState();
    });
  }
}

function onBound(path) {
  if (path === 'form.design') {
    const info = DESIGN_INFO[state.form.design];
    state.form.anchoring = info.anchoring;
    state.form.orientation = info.orientation;
    syncInputs('form.');
  }
  if (path.startsWith('form.')) {
    renderDesignHelp();
    markLinkStale();
  }
  if (path.startsWith('env.')) renderEnv();
  if (path.startsWith('draft.')) renderDraft();
  if (path.startsWith('flowDraft.')) renderFlowTruth();
}

// ------------------------------------------------------------------------------------------------------
// Event log (visibility, page show/hide, focus, AR taps, Quick Look messages)
// ------------------------------------------------------------------------------------------------------

function logEvent(type, detail = '') {
  state.events.push({ id: newId(), t: Date.now(), type, detail: String(detail).slice(0, 160) });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  saveState();
  renderLog();
  if (type === 'visibilitychange' || type === 'pageshow' || type === 'focus') renderPending();
}

function renderLog() {
  const el = $('event-log');
  const recent = state.events.slice(-40).reverse();
  el.replaceChildren(...(recent.length ? recent.map((e) => h('div', { text: `${fmtTime(e.t)}  ${e.type}${e.detail ? `  ${e.detail}` : ''}` })) : [h('div', { text: 'No events yet.' })]));
}

function watchPage() {
  // Coming back (Back from embed.html restores this page from the cache, or another tab was used): read
  // what the other copy saved before logging, so this copy never writes its older state over it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncFromStorage();
    logEvent('visibilitychange', document.visibilityState);
  });
  window.addEventListener('pagehide', (e) => {
    logEvent('pagehide', e.persisted ? 'persisted' : '');
    stopFlowCamera();
  });
  window.addEventListener('pageshow', (e) => {
    syncFromStorage();
    logEvent('pageshow', e.persisted ? 'from cache' : 'fresh');
  });
  window.addEventListener('focus', () => {
    syncFromStorage();
    logEvent('focus');
  });
  window.addEventListener('blur', () => logEvent('blur'));
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY) syncFromStorage();
  });
}

// ------------------------------------------------------------------------------------------------------
// Panel 1: environment
// ------------------------------------------------------------------------------------------------------

function relArSupported() {
  try {
    const a = document.createElement('a');
    return Boolean(a.relList && typeof a.relList.supports === 'function' && a.relList.supports('ar'));
  } catch {
    return false;
  }
}

function isFramed() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function inAppBrowser(ua) {
  const known = [
    ['CriOS', 'Chrome for iOS'],
    ['FxiOS', 'Firefox for iOS'],
    ['EdgiOS', 'Edge for iOS'],
    ['FBAN', 'Facebook app'],
    ['FBAV', 'Facebook app'],
    ['Instagram', 'Instagram app'],
    ['Line/', 'LINE app'],
    ['GSA/', 'Google app'],
  ];
  const hit = known.find(([k]) => ua.includes(k));
  return hit ? hit[1] : null;
}

/** Where this copy of the page runs: stored with every AR tap, row and flow row. */
function pageEnv() {
  const ua = navigator.userAgent || '';
  return {
    framed: isFramed(),
    relAr: relArSupported(),
    inApp: inAppBrowser(ua),
    safariVersion: (ua.match(/Version\/([\d.]+)/) || [])[1] || null,
  };
}

function envInfo() {
  const ua = navigator.userAgent || '';
  const uaOs = (ua.match(/OS (\d+(?:_\d+)*) like Mac OS X/) || [])[1];
  const where = pageEnv();
  return {
    ua,
    safariVersion: where.safariVersion,
    uaIos: uaOs ? uaOs.replace(/_/g, '.') : null,
    inApp: where.inApp,
    relAr: where.relAr,
    framed: where.framed,
    screen: `${screen.width} x ${screen.height}`,
    viewport: `${window.innerWidth} x ${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    secure: window.isSecureContext,
    touchPoints: navigator.maxTouchPoints,
    imageCapture: typeof globalThis.ImageCapture === 'function',
    share: typeof navigator.share === 'function',
    clipboard: Boolean(navigator.clipboard && navigator.clipboard.writeText),
    storage: storage.ok ? 'localStorage' : `memory only (${storage.reason})`,
    model: state.env.model,
    ios: state.env.ios,
    lidar: state.env.lidar,
    ownerLeaveOk: state.env.ownerLeaveOk,
    ownerNote: state.env.ownerNote,
  };
}

function renderEnv() {
  const e = envInfo();
  kvRows($('env-table'), [
    ['User agent', e.ua],
    ['Safari Version/', e.safariVersion],
    ['iOS in user agent', e.uaIos],
    ["relList.supports('ar')", String(e.relAr)],
    ['Page is', e.framed ? 'inside an iframe' : 'top-level'],
    ['Other browser / app', e.inApp || 'none detected'],
    ['Screen', e.screen],
    ['Window', e.viewport],
    ['devicePixelRatio', String(e.dpr)],
    ['Secure (https)', String(e.secure)],
    ['ImageCapture', String(e.imageCapture)],
    ['Share sheet', String(e.share)],
    ['Saving', e.storage],
  ]);
  const el = $('ar-support');
  if (e.relAr) {
    el.className = 'good';
    el.textContent = 'This browser supports Apple AR links. Good.';
  } else {
    el.className = 'bad';
    el.textContent =
      `This browser does not support Apple AR links${e.inApp ? ` (${e.inApp})` : ''}. Open this page in Safari for the real test. ` +
      'You can still save the .usdz file in step 2 and open it from the Files app.';
  }
  if (e.framed) {
    el.textContent += ' The page is inside an iframe: note whether AR still opens from here.';
  }
}

// ------------------------------------------------------------------------------------------------------
// Panel 2: build and open
// ------------------------------------------------------------------------------------------------------

/** This copy's step-2 link and the run it opens (not state.lastBuild: another copy may have built since). */
const link = { url: null, stale: true, run: null };

function designOptions(f) {
  const o = { anchoring: f.anchoring, orientation: f.orientation };
  if (f.design === 'A') Object.assign(o, { heightMm: num(f.tapeH), widthMm: num(f.tapeW) });
  if (f.design === 'B') Object.assign(o, { widthMm: num(f.gridW), heightMm: num(f.gridH) });
  if (f.design === 'C') o.sizes = SIZES;
  if (f.design === 'D') Object.assign(o, { widthMm: num(f.outlineW), heightMm: num(f.outlineH) });
  if (f.design === 'E') o.lengthMm = num(f.floorL);
  for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
  return o;
}

function renderDesignHelp() {
  const d = state.form.design;
  const help = {
    A: 'Two white strips with ticks: one up the left side of the opening, one along the bottom. Read where the top of the opening (head) and the right side (jamb) cross them.',
    B: 'See-through squares, a bar every 100 mm (red every 500 mm). Read all four edges; the zero does not have to be exact.',
    C: 'Every standard size as an outline from the same corner. Width lines are numbered at the top, height lines at the right. 2040 high is blue, 2100 green, 2340 orange.',
    D: "One outline with its size written in the middle. The AR view shows a 'This size fits' button.",
    E: 'A ruler for the floor. Lay a real tape beside it, zero on zero, to check the AR scale without a door.',
  };
  $('design-help').textContent = help[d] || '';
  for (const x of ['A', 'B', 'C', 'D', 'E']) show(`params-${x}`, x === d);
  $('catalogue-list').textContent = `Sizes from the settings: ${SIZES.map((s) => `${s.widthMm} x ${s.heightMm}`).join(', ')}.`;
}

function markLinkStale() {
  if (link.stale) return;
  link.stale = true;
  show('ar-area', false);
  status('build-status', 'You changed a choice. Tap "Make the AR link" again.', 'warn');
}

/** Texture images as PNG bytes: the canvas encoder, or png.js when the canvas fails (or when forced). */
async function pngBytes(image, force) {
  if (!force) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob || !blob.size) throw new Error('toBlob gave nothing');
      return { bytes: new Uint8Array(await blob.arrayBuffer()), via: 'canvas' };
    } catch {
      // Fall through to the pure encoder.
    }
  }
  return { bytes: encodePng(image), via: 'png.js' };
}

/**
 * Build a design into USDZ bytes in the page.
 * @returns {Promise<{ bytes: Uint8Array, ms: number, pngVia: string, meta: object }>}
 */
async function buildUsdz(design, opts, forcePngJs) {
  const t0 = performance.now();
  const scene = buildDesign(design, opts);
  const entries = [{ path: 'scene.usda', bytes: utf8(scene.usda) }];
  const via = new Set();
  for (const t of scene.textures) {
    const png = await pngBytes(t.image, forcePngJs);
    via.add(png.via);
    entries.push({ path: t.path, bytes: png.bytes });
  }
  const bytes = makeUsdz(entries);
  return { bytes, ms: Math.round(performance.now() - t0), pngVia: [...via].join(' + ') || 'none', meta: scene.meta };
}

/** Fetch one of this site's committed static models. */
async function fetchStatic(path) {
  const t0 = performance.now();
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`the file ${path} could not be loaded (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, ms: Math.round(performance.now() - t0), contentType: res.headers.get('content-type') || '' };
}

function fragmentFor(design, opts, lock) {
  return design === 'D' ? outlineFragment(opts.widthMm || 820, opts.heightMm || 2040, lock) : quickLookFragment({ lock });
}

async function makeLink() {
  const f = state.form;
  const button = $('make-link');
  button.disabled = true;
  show('ar-area', false);
  status('build-status', 'Making the file…');
  if (link.url) {
    URL.revokeObjectURL(link.url);
    link.url = null;
  }
  link.run = null;
  try {
    const opts = designOptions(f);
    const lock = f.lock === 'on';
    const fragment = fragmentFor(f.design, opts, lock);
    const base = { design: f.design, anchoring: f.anchoring, orientation: f.orientation, lock: f.lock, delivery: f.delivery };
    let bytes;
    let href;
    let info;
    if (f.delivery === 'static') {
      const path = staticFileFor({ design: f.design, ...opts });
      if (!path) {
        const list = STATIC_VARIANTS.map(variantKey).join(', ');
        status('build-status', `There is no ready-made file for exactly these choices (only the normal sizes). Ready-made files: ${list}. Pick "Made on this phone", or change the choices.`, 'warn');
        return;
      }
      const got = await fetchStatic(path);
      bytes = got.bytes;
      href = withFragment(path, fragment);
      info = { ms: got.ms, how: `downloaded ${path} (${got.contentType || 'no content type'})`, pngVia: 'zlib (made on a computer)', staticPath: path };
    } else {
      const built = await buildUsdz(f.design, opts, f.forcePngJs === true);
      bytes = built.bytes;
      link.url = URL.createObjectURL(new Blob([bytes], { type: USDZ_TYPE }));
      href = withFragment(link.url, fragment);
      info = { ms: built.ms, how: 'built on this phone (blob URL)', pngVia: built.pngVia, staticPath: null };
    }
    const entries = readZip(bytes);
    const name = `${variantKey({ ...base, widthMm: opts.widthMm || 820, heightMm: opts.heightMm || 2040 })}.usdz`;
    const ar = $('ar-link');
    ar.href = href;
    ar.dataset.label = f.design === 'D' ? `${opts.widthMm || 820} x ${opts.heightMm || 2040}` : `design ${f.design}`;
    if (f.downloadAttr && f.delivery === 'blob') ar.setAttribute('download', 'model.usdz');
    else ar.removeAttribute('download');
    const dl = $('dl-link');
    dl.href = link.url || withFragment(info.staticPath, '');
    dl.setAttribute('download', name);
    $('plain-link').href = href;
    $('ar-caption').textContent = `${DESIGN_INFO[f.design].name}, ${f.anchoring}, ${f.orientation}, lock ${f.lock}, ${f.delivery === 'blob' ? 'made on this phone' : 'ready-made file'}`;

    const outlineSize = f.design === 'D' ? { widthMm: opts.widthMm || 820, heightMm: opts.heightMm || 2040 } : null;
    state.lastBuild = { ...base, outline: outlineSize, bytes: bytes.length, buildMs: info.ms, pngVia: info.pngVia, entries: entries.length, fragment, staticPath: info.staticPath, builtAt: Date.now() };
    const params = Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'sizes' && k !== 'anchoring' && k !== 'orientation'));
    link.run = { where: 'build', label: ar.dataset.label, ...base, outline: outlineSize, params: JSON.stringify(params), bytes: bytes.length, buildMs: info.ms };
    saveState();

    kvRows($('build-table'), [
      ['Size', kb(bytes.length)],
      [f.delivery === 'static' ? 'Download time' : 'Build time', `${info.ms} ms`],
      ['How', info.how],
      ['Pictures (PNG)', info.pngVia],
      ['Link', href.length > 140 ? `${href.slice(0, 140)}…` : href],
      ['Every entry 64-byte aligned', String(entries.every((e) => e.aligned))],
    ]);
    dataTable(
      $('entry-table'),
      ['#', 'Entry', 'Bytes', 'Data at', '% 64', 'Stored', 'CRC'],
      entries.map((e, i) => [String(i + 1), e.path, String(e.size), String(e.dataOffset), String(e.dataOffset % 64), e.method === 0 ? 'yes' : `no (${e.method})`, e.crcOk ? 'ok' : 'BAD']),
    );
    link.stale = false;
    show('ar-area', true);
    const big = bytes.length > MAX_USDZ_BYTES ? ` Warning: over 3 MB (${(bytes.length / 1048576).toFixed(2)} MB); Quick Look may be slow or refuse it.` : '';
    status('build-status', `Ready. Now tap the blue "Open in AR" button.${big}`, big ? 'warn' : 'good');
    logEvent('built', `${variantKey({ ...base, widthMm: opts.widthMm, heightMm: opts.heightMm })} ${bytes.length} B ${info.ms} ms ${f.delivery}`);
  } catch (error) {
    status('build-status', `Could not make the file: ${(error && error.message) || error}. Try again, or try "Ready-made file".`, 'bad');
    logEvent('build-error', (error && error.message) || String(error));
  } finally {
    button.disabled = false;
  }
}

/** What makes two taps the same run: the gauge, its sizes and every choice that built it. */
function runKey(run) {
  if (!run) return '';
  const o = run.outline ? `${run.outline.widthMm}x${run.outline.heightMm}` : '';
  return [run.where, run.design, run.anchoring, run.orientation, run.lock, run.delivery, o, run.params || ''].join('|');
}

/** Attach the tap and Quick Look message handlers to an <a rel="ar">. */
function wireArAnchor(anchor, describe) {
  anchor.addEventListener('click', () => {
    // A real tap follows the link; this only notes it. Save first: iOS may reload a backgrounded page.
    // Free the camera first: Quick Look's AR session needs it, and pagehide may not fire for its overlay.
    const hadCamera = Boolean(flowUi.stream);
    stopFlowCamera();
    if (hadCamera) status('flow-status', 'The camera was stopped for AR. Tap "Photo the door" to start it again.', 'note');
    const run = describe();
    const now = Date.now();
    const what = `${run.label} | ${run.design} ${run.anchoring} ${run.orientation} lock ${run.lock} ${run.delivery}`;
    if (run.where === 'flow') {
      // Step-4 outlines have their own slot: they never touch a step-3 row being filled in.
      state.flowPending = { ...run, ...pageEnv(), tapAt: now };
      logEvent('ar-tap', `flow: ${what}`);
      return;
    }
    const p = pendingRun();
    if (p && runKey(p) === runKey(run)) {
      // The same gauge again (Quick Look opened on Object, a failed stick and a retry): keep what is
      // already typed in step 3, and the first tap, so time away covers every visit.
      p.taps = [...(Array.isArray(p.taps) ? p.taps : [p.tapAt]), now];
      logEvent('ar-tap', `again (${p.taps.length}): ${what}`);
    } else {
      state.pending = { ...run, ...pageEnv(), tapAt: now, taps: [now] };
      state.draft = emptyDraft({ ...state.draft, design: run.design, anchoring: run.anchoring, orientation: run.orientation, lock: run.lock, delivery: run.delivery });
      // The outline's own lines are the only ones on offer; the tester still says how each edge sits.
      if (run.design === 'D' && run.outline) {
        state.draft.readings = { wLine: String(run.outline.widthMm), hLine: String(run.outline.heightMm) };
      }
      logEvent('ar-tap', what);
      syncInputs('draft.');
    }
    renderDraft();
    renderPending();
  });
  anchor.addEventListener(
    'message',
    (ev) => {
      const run = describe();
      logEvent('message', `${typeof ev.data === 'string' ? ev.data.slice(0, 80) : typeof ev.data} on ${run.label}`);
      if (ev.data !== QL_TAPPED) return;
      state.bannerSeen = true;
      logEvent('banner-tap', run.label);
      if (run.where === 'flow' && run.outline) recordFlowPick(run.outline, 'banner');
      toast(`"This size fits" tapped on ${run.label}`);
      saveState();
      renderSession();
      renderPending();
    },
    false,
  );
}

function panel2Run() {
  if (link.run) return { ...link.run };
  const b = state.lastBuild || {};
  return {
    where: 'build',
    label: $('ar-link').dataset.label || 'gauge',
    design: b.design,
    anchoring: b.anchoring,
    orientation: b.orientation,
    lock: b.lock,
    delivery: b.delivery,
    outline: b.outline,
    bytes: b.bytes,
    buildMs: b.buildMs,
  };
}

// ------------------------------------------------------------------------------------------------------
// Panel 3: after AR
// ------------------------------------------------------------------------------------------------------

function pendingRun() {
  const p = state.pending;
  if (!p || !Number.isFinite(p.tapAt)) return null;
  const last = Math.max(p.tapAt, ...tapsOf(p));
  return Date.now() - last > PENDING_MAX_MS ? null : p;
}

/** Every tap of a pending run (older saves kept only the one). */
function tapsOf(p) {
  if (!p) return [];
  const taps = Array.isArray(p.taps) ? p.taps.filter((t) => Number.isFinite(t)) : [];
  return taps.length ? taps : Number.isFinite(p.tapAt) ? [p.tapAt] : [];
}

function renderPending() {
  const p = pendingRun();
  const el = $('pending-run');
  if (!p) {
    el.className = 'note';
    el.textContent = 'No AR run waiting. Make and open a gauge in step 2 first (or fill this in by hand).';
    return;
  }
  const taps = tapsOf(p);
  const away = timeAwayAll(state.events, taps);
  const banner = state.events.filter((e) => e.type === 'banner-tap' && e.t >= p.tapAt).map((e) => e.detail);
  el.className = 'note';
  el.textContent =
    `AR tap at ${fmtTime(p.tapAt)}${taps.length > 1 ? ` (opened ${taps.length} times, last at ${fmtTime(taps[taps.length - 1])})` : ''}: ` +
    `${p.label}, ${p.anchoring}, ${p.orientation}, lock ${p.lock}, ${p.delivery === 'blob' ? 'made on phone' : 'ready-made'}${p.framed ? ', inside an iframe' : ''}. ` +
    (away.awaySec !== null ? `Away from the page ${away.awaySec} s. ` : 'Not back from AR yet (or the page never went to the background). ') +
    (banner.length ? `Banner tapped on: ${banner.join(', ')}.` : '');
}

function renderReadingFields() {
  const d = state.draft.design;
  show('readings-A', d === 'A');
  show('readings-B', d === 'B');
  show('readings-C', d === 'C' || d === 'D');
  show('readings-E', d === 'E');
  show('tape-truth', d !== 'E');
  $('readings-C-legend').textContent = d === 'D' ? 'Outline readings' : 'Which lines matched';
  const fill = (select, values) => {
    const current = String(getPath(state, select.dataset.bind) ?? '');
    const opts = [h('option', { value: '', text: 'Choose…' }), ...values.map((v) => h('option', { value: String(v), text: `${v}` }))];
    select.replaceChildren(...opts);
    const ok = values.map(String).includes(current);
    select.value = ok ? current : '';
    // A line that is not on offer any more (another gauge or outline) must not count as a reading.
    if (!ok && current) setPath(state, select.dataset.bind, '');
  };
  const p = pendingRun();
  const outlineSize = d === 'D' ? (p && p.outline) || { widthMm: num(state.form.outlineW) || 820, heightMm: num(state.form.outlineH) || 2040 } : null;
  fill($('wline-select'), outlineSize ? [outlineSize.widthMm] : [...new Set(SIZES.map((s) => s.widthMm))].sort((a, b) => a - b));
  fill($('hline-select'), outlineSize ? [outlineSize.heightMm] : [...new Set(SIZES.map((s) => s.heightMm))].sort((a, b) => a - b));
}

function rowFromDraft() {
  const d = state.draft;
  const p = pendingRun();
  const taps = tapsOf(p);
  const away = timeAwayAll(state.events, taps);
  const banner = p ? state.events.filter((e) => e.type === 'banner-tap' && e.t >= p.tapAt).map((e) => e.detail) : [];
  const readings = {};
  const lines = ['wLine', 'wOff', 'hLine', 'hOff'];
  const keys = { A: ['head', 'right'], B: ['left', 'right', 'sill', 'head'], C: lines, D: lines, E: ['r1000', 'r2000'] }[d.design] || [];
  for (const k of keys) readings[k] = num(d.readings[k]);
  if (d.design === 'C' || d.design === 'D') {
    for (const k of ['wFit', 'hFit']) readings[k] = FITS.includes(d.readings[k]) ? d.readings[k] : null;
  }
  return {
    id: newId(),
    at: new Date().toISOString(),
    design: d.design,
    anchoring: d.anchoring || (p && p.anchoring) || null,
    orientation: d.orientation || (p && p.orientation) || null,
    lock: (d.lock || (p && p.lock)) === 'on',
    delivery: d.delivery || (p && p.delivery) || null,
    // Where the AR link was tapped (an iframe, another app's browser), from the tap; unknown for a row
    // filled in by hand, which the go / no-go then leaves out.
    framed: p && typeof p.framed === 'boolean' ? p.framed : null,
    relAr: p && typeof p.relAr === 'boolean' ? p.relAr : null,
    inApp: p ? p.inApp || null : null,
    safariVersion: p ? p.safariVersion || null : null,
    bytes: p ? p.bytes : null,
    buildMs: p ? p.buildMs : null,
    tapAt: p ? new Date(p.tapAt).toISOString() : null,
    arOpens: taps.length,
    awaySec: away.awaySec,
    hiddenSec: away.hiddenSec,
    banner: banner.join(', ') || null,
    opened: d.opened || null,
    openedNote: d.openedNote || null,
    stuck: d.stuck || null,
    stickSec: num(d.stickSec),
    upright: d.upright || null,
    drag: d.drag || null,
    pinch: d.pinch || null,
    readBeforePinch: d.pinch === 'yes' ? d.readBeforePinch || null : null,
    light: d.light || null,
    distM: num(d.distM),
    readings,
    tape: d.design === 'E' ? null : { w: num(d.tape.w), h: num(d.tape.h), doorId: d.tape.doorId || null },
  };
}

function renderDraft() {
  renderReadingFields();
  const row = rowFromDraft();
  const c = computeRow(row);
  const el = $('row-result');
  el.className = 'note';
  const parts = [];
  if (row.design === 'E') {
    parts.push(
      c.floorScalePct !== null
        ? `Floor scale error ${c.floorScalePct > 0 ? '+' : ''}${c.floorScalePct} % (reading / true - 1). At 1000 mm: ${fmtPct(c.scale1000)}, at 2000 mm: ${fmtPct(c.scale2000)}.`
        : 'Enter the AR readings at the real tape\'s 1000 and 2000 mm marks.',
    );
  } else {
    parts.push(c.arW !== null || c.arH !== null ? `AR says ${c.arW ?? '?'} x ${c.arH ?? '?'} mm (width x height).` : 'Enter the readings to see the AR size.');
    if (c.errW !== null || c.errH !== null) {
      parts.push(`Error (AR - tape): width ${signed(c.errW)} mm (${signed(c.errWPct)} %), height ${signed(c.errH)} mm (${signed(c.errHPct)} %).`);
    }
    const r = row.readings;
    if (row.design === 'B' && r.left !== null && r.right !== null) parts.push(`W = ${r.right} - ${r.left}; H = ${r.head ?? '?'} - ${r.sill ?? '?'}.`);
    if ((row.design === 'C' || row.design === 'D') && ((r.wLine !== null && !r.wFit) || (r.hLine !== null && !r.hFit))) {
      parts.push('Say how each edge sits against its line (on it, or wider / taller or narrower / shorter by how many mm).');
    }
    if (row.design !== 'E' && !(row.tape && row.tape.doorId)) parts.push('Give the door a name: the go / no-go counts each named door once.');
  }
  const use = rowUse(row);
  if (row.opened && use.why.length) {
    parts.push(use.ok ? `Note: ${use.why.join('; ')}.` : `This row will not count in the results: ${use.why.join('; ')}.`);
  }
  el.className = row.opened && !use.ok ? 'warn' : 'note';
  el.textContent = parts.join(' ');
}

function signed(v) {
  if (v === null || v === undefined) return '?';
  return v > 0 ? `+${v}` : String(v);
}

function fmtPct(v) {
  return v === null ? '-' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)} %`;
}

function saveRow() {
  const row = rowFromDraft();
  if (!row.opened) {
    status('row-result', 'Please answer "Did AR open?" first.', 'warn');
    return;
  }
  // A run that never opened has nothing to read: readings typed (or carried over) for it are not kept.
  if (row.opened !== 'yes') row.readings = {};
  state.rows.push(row);
  state.pending = null;
  state.draft = emptyDraft({ design: state.draft.design, light: state.draft.light, distM: state.draft.distM, tape: state.draft.tape });
  saveState();
  syncInputs('draft.');
  renderDraft();
  renderPending();
  renderSession();
  toast(`Row ${state.rows.length} saved.`);
}

function deleteRow(list, id, what) {
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return;
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Delete ${what} ${i + 1}? This cannot be undone.`)) return;
  list.splice(i, 1);
  // Remembered, so another open copy of the page that still has the row does not bring it back.
  state.deleted = [...state.deleted, id].slice(-MAX_DELETED);
  saveState();
  renderSession();
}

function renderSession() {
  const s = summarize(state.rows);
  const f = summarizeFlow(state.flowRows, SIZES);
  kvRows($('summary-table'), [
    ['Rows', String(s.rows)],
    ['Door rows with an error that counts (n)', String(s.n)],
    ['Rows with readings left out', s.leftOut ? `${s.leftOut} (not opened, not stuck to the wall or door, or read after a pinch resized it)` : '0'],
    ['Width |error| p50 / p90', s.w.n ? `${s.w.p50} / ${s.w.p90} mm` : '-'],
    ['Height |error| p50 / p90', s.h.n ? `${s.h.p50} / ${s.h.p90} mm` : '-'],
    ['Signed bias (mean AR - tape)', s.w.n || s.h.n ? `width ${signed(s.w.bias)} mm, height ${signed(s.h.bias)} mm` : '-'],
    ['Floor scale error p50 / p90 / bias', s.floor.n ? `${s.floor.p50} / ${s.floor.p90} / ${signed(s.floor.bias)} % (n ${s.floor.n})` : '-'],
    ['Opened', s.openedPct === null ? '-' : `${s.openedPct} %`],
    ['Stuck (of opened)', s.stuckPct === null ? '-' : `${s.stuckPct} %`],
    ['Scale lock held (pinch did not resize)', s.lockHeldPct === null ? '-' : `${s.lockHeldPct} % of ${s.lockRuns} locked runs`],
    ['Banner event seen', state.bannerSeen ? 'yes' : 'not yet'],
  ]);
  const countsRow = (g) => [
    g.key,
    String(g.runs),
    g.openAnswered ? `${g.opened} of ${g.openAnswered}` : '-',
    g.stuckAnswered ? `${g.stuck} of ${g.stuckAnswered}` : '-',
    g.lockRuns ? `${g.lockHeld} of ${g.lockRuns}` : '-',
  ];
  dataTable($('setup-table'), ['Sticks to / way / file', 'Runs', 'Opened', 'Stuck (wall, door; floor for E)', 'Lock held'], s.bySetup.map(countsRow));
  dataTable($('page-table'), ['Page', 'Runs', 'Opened', 'Stuck (wall, door; floor for E)', 'Lock held'], s.byPage.map(countsRow));
  const verdicts = goNoGo(s, f, { bannerSeen: state.bannerSeen });
  $('go-table').replaceChildren(
    ...verdicts.map((v) =>
      h(
        'tr',
        {},
        h('th', { scope: 'row', text: v.text }),
        h('td', {}, h('span', { class: v.verdict === 'go' ? 'verdict-go' : v.verdict === 'no-go' ? 'verdict-no-go' : 'verdict-wait', text: v.verdict }), ` ${v.value}`),
      ),
    ),
  );
  dataTable(
    $('rows-table'),
    ['#', 'Time', 'Door', 'Gauge', 'Sticks to', 'Way', 'Lock', 'File', 'Page', 'Opened', 'Stuck', 'Upright', 'Pinch resized', 'Counts', 'AR W x H', 'Tape W x H', 'Err W', 'Err H', 'Floor %', 'Away s', 'Banner', ''],
    state.rows.map((r, i) => {
      const c = computeRow(r);
      const use = rowUse(r);
      return [
        String(i + 1),
        r.at ? r.at.slice(11, 19) : '-',
        (r.tape && r.tape.doorId) || '-',
        r.design,
        r.anchoring,
        r.orientation,
        r.lock ? 'on' : 'off',
        r.delivery,
        r.framed === true ? 'iframe' : r.framed === false ? r.inApp || 'top' : '-',
        r.opened,
        r.stuck,
        r.upright,
        r.pinch === 'yes' ? `yes${r.readBeforePinch === 'yes' ? ' (read before)' : ''}` : r.pinch,
        use.ok ? (use.h || r.design === 'E' ? 'yes' : 'W only') : 'no',
        c.arW !== null || c.arH !== null ? `${c.arW ?? '?'} x ${c.arH ?? '?'}` : '-',
        r.tape && (r.tape.w || r.tape.h) ? `${r.tape.w ?? '?'} x ${r.tape.h ?? '?'}` : '-',
        c.errW === null ? '-' : signed(c.errW),
        c.errH === null ? '-' : signed(c.errH),
        c.floorScalePct === null ? '-' : signed(c.floorScalePct),
        r.awaySec === null || r.awaySec === undefined ? '-' : String(r.awaySec),
        r.banner || '-',
        h('button', { type: 'button', class: 'danger small', text: 'Delete', onclick: () => deleteRow(state.rows, r.id, 'row') }),
      ];
    }),
  );
  kvRows($('flow-summary'), [
    ['Flow rows', String(f.rows)],
    ['Rows with no known standard size (not judged)', String(f.unknownSize)],
    ['AR pick right (every set-up)', f.judged ? `${f.arRight} of ${f.judged}` : '-'],
    ['AR pick right (product set-up, first try per named door)', f.product.doors ? `${f.product.arRight} of ${f.product.doors}` : '-'],
    ['Photo-only top pick right', f.judged ? `${f.aspectRight} of ${f.judged}` : '-'],
    ['Unsure photos the AR pick got right', f.unsure ? `${f.unsureArRight} of ${f.unsure}` : '-'],
    ['Picks that came from the banner event', `${f.bannerEvents} of ${f.arPicked}`],
    ['Median time, photo to pick', f.secsP50 === null ? '-' : `${f.secsP50} s`],
  ]);
  dataTable(
    $('flow-table'),
    ['#', 'Door', 'Photo top-1', 'p', 'Unsure', 'AR pick', 'Via', 'Tape', 'True size', 'Outlines', 'Photo right', 'AR right', 'Secs', ''],
    state.flowRows.map((r, i) => {
      const truth = flowTruth(r, SIZES);
      const via = r.trueSizeVia === 'picked' ? 'picked' : r.trueSizeVia === 'none' ? '' : 'from tape';
      return [
        String(i + 1),
        r.doorId || '-',
        r.aspectTop1 ? `${r.aspectTop1.widthMm} x ${r.aspectTop1.heightMm}` : '-',
        r.aspectTop1 ? r.aspectTop1.p.toFixed(2) : '-',
        r.unsure ? 'yes' : 'no',
        r.arPick ? `${r.arPick.widthMm} x ${r.arPick.heightMm}` : '-',
        r.arPickVia || '-',
        r.tape && r.tape.w ? `${r.tape.w} x ${r.tape.h}` : '-',
        truth ? `${truth.widthMm} x ${truth.heightMm}${via ? ` (${via})` : ''}` : r.trueSizeVia === 'none' ? 'not standard' : '-',
        r.anchoring ? `${r.anchoring} ${r.orientation} lock ${r.lock ? 'on' : 'off'} ${r.delivery}${r.framed ? ' iframe' : ''}` : '-',
        yesNo(sameSize(r.aspectTop1, truth)),
        yesNo(truth ? sameSize(r.arPick, truth) ?? false : null),
        r.secs === null || r.secs === undefined ? '-' : String(r.secs),
        h('button', { type: 'button', class: 'danger small', text: 'Delete', onclick: () => deleteRow(state.flowRows, r.id, 'flow row') }),
      ];
    }),
  );
}

function yesNo(v) {
  return v === null ? '-' : v ? 'yes' : 'no';
}

// ------------------------------------------------------------------------------------------------------
// Panel 4: product flow (photo -> photo estimate -> outlines in AR -> 'This size fits')
// ------------------------------------------------------------------------------------------------------

const flowUi = { stream: null, track: null, photo: null, corners: null, view: null, drag: -1, abort: null, urls: [], busy: false };

function stopFlowCamera() {
  if (flowUi.abort) flowUi.abort.abort();
  flowUi.abort = null;
  if (flowUi.stream) stopCamera(flowUi.stream);
  flowUi.stream = null;
  flowUi.track = null;
  show('camera-box', false);
}

const CAMERA_MESSAGES = {
  blocked: 'The camera was not allowed. In Safari tap "aA" in the address bar > Website Settings > Camera > Allow, then try again. Or use "Pick a photo instead".',
  unavailable: 'No camera could be found. Use "Pick a photo instead".',
  busy: 'The camera is busy (another app, or a call). Close it and try again, or use "Pick a photo instead".',
  insecure: 'The camera needs the https address of this page.',
  unknown: 'The camera did not start. Try again, or use "Pick a photo instead".',
};

function startFlow() {
  state.flow = { startedAt: Date.now(), estimate: null, detection: null, pick: null, capture: null };
  saveState();
  $('outline-links').replaceChildren();
  show('flow-pick', false);
  $('save-flow').disabled = true;
}

const EMBED_BLOCKED =
  'The camera is blocked inside this frame (the page around it did not allow it). Open the page on its own (not inside another page), or use "Pick a photo instead".';

async function onPhotoStart() {
  // Always try the camera: embed.html allows it, and Safari has no policy API to ask first, so
  // embedBlocksCamera() only explains a refusal (as in the main app).
  stopFlowCamera();
  startFlow();
  status('flow-status', 'Starting the camera… allow it if asked.');
  show('camera-box', true);
  const video = $('camera-video');
  flowUi.abort = new AbortController();
  try {
    const { stream, track, playing } = await startCamera(video, { signal: flowUi.abort.signal });
    flowUi.stream = stream;
    flowUi.track = track;
    status('flow-status', playing ? 'Frame the whole door with a little wall around it, then tap "Take photo".' : 'Tap the black picture once to start the camera, then "Take photo".', playing ? 'note' : 'warn');
    if (!playing) video.addEventListener('click', () => video.play().catch(() => {}), { once: true });
    logEvent('camera', `started ${track.label || ''}`.trim());
  } catch (error) {
    show('camera-box', false);
    if (error && error.name === 'AbortError') return;
    const kind = cameraErrorKind(error);
    const embedded = kind === 'blocked' && embedBlocksCamera();
    status('flow-status', embedded ? EMBED_BLOCKED : CAMERA_MESSAGES[kind] || CAMERA_MESSAGES.unknown, 'bad');
    logEvent('camera-error', `${(error && error.name) || String(error)}${isFramed() ? ' (in an iframe)' : ''}`);
  }
}

async function onPhotoTake() {
  if (!flowUi.stream) return;
  $('photo-take').disabled = true;
  status('flow-status', 'Taking the photo…');
  try {
    const { blob, capture } = await capturePhoto({ track: flowUi.track, video: $('camera-video') });
    stopFlowCamera();
    const photo = await loadPhoto(blob, config, { capture });
    await usePhoto(photo, capture);
  } catch (error) {
    status('flow-status', `The photo did not work (${(error && error.message) || error}). Try again, or pick a photo.`, 'bad');
  } finally {
    $('photo-take').disabled = false;
  }
}

async function onPhotoFile(file) {
  if (!file) return;
  stopFlowCamera();
  startFlow();
  status('flow-status', 'Opening the photo…');
  try {
    const photo = await loadPhoto(file, config, { capture: 'file' });
    await usePhoto(photo, 'file');
  } catch {
    status('flow-status', 'That photo could not be opened. Try another one (JPEG or PNG).', 'bad');
  }
}

async function usePhoto(photo, capture) {
  flowUi.photo = photo;
  state.flow.capture = capture;
  status('flow-status', 'Looking for the door…');
  const detection = await findDoor(photo);
  state.flow.detection = { ok: detection.ok, confidence: Number(detection.confidence) || 0, reason: detection.reason || null };
  flowUi.corners = startingQuad(photo, detection);
  show('editor-box', true);
  layoutEditor();
  status(
    'flow-status',
    detection.ok ? `Door found (confidence ${(detection.confidence || 0).toFixed(2)}). Check the four dots.` : 'Could not find the door by itself. Drag the four dots onto the inside corners of the opening.',
    detection.ok ? 'note' : 'warn',
  );
  runEstimate();
}

function layoutEditor() {
  const canvas = $('editor-canvas');
  const photo = flowUi.photo;
  if (!photo) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  flowUi.view = fitView(photo.width, photo.height, rect.width, rect.height, 16);
  drawEditor();
}

function drawEditor() {
  const canvas = $('editor-canvas');
  const photo = flowUi.photo;
  const view = flowUi.view;
  if (!photo || !view) return;
  const ctx = canvas.getContext('2d');
  const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(photo.canvas, view.tx, view.ty, photo.width * view.scale, photo.height * view.scale);
  const pts = flowUi.corners.map((p) => imageToScreen(view, p));
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffd400';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = i === flowUi.drag ? 'rgba(255, 212, 0, 0.9)' : 'rgba(11, 92, 213, 0.85)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  });
}

function wireEditor() {
  const canvas = $('editor-canvas');
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!flowUi.photo || !flowUi.view) return;
    const i = hitTestHandle(flowUi.corners, local(e), flowUi.view, 40);
    if (i < 0) return;
    flowUi.drag = i;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Without capture the drag still works while the finger stays on the canvas.
    }
    e.preventDefault();
    drawEditor();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (flowUi.drag < 0) return;
    const q = screenToImage(flowUi.view, local(e));
    const photo = flowUi.photo;
    flowUi.corners[flowUi.drag] = { x: Math.min(Math.max(q.x, 0), photo.width), y: Math.min(Math.max(q.y, 0), photo.height) };
    drawEditor();
  });
  const end = () => {
    if (flowUi.drag < 0) return;
    flowUi.drag = -1;
    drawEditor();
    runEstimate();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => {
    if (flowUi.photo && !$('editor-box').classList.contains('hidden')) layoutEditor();
  });
}

function runEstimate() {
  const photo = flowUi.photo;
  if (!photo) return;
  const focal = photoFocal(photo);
  const res = estimateFromCorners({ corners: flowUi.corners, imageWidth: photo.width, imageHeight: photo.height, ...focal, sizes: SIZES });
  show('estimate-box', true);
  if (!res.ok) {
    state.flow.estimate = null;
    $('estimate-top').replaceChildren(h('p', { class: 'bad', text: 'Those four dots do not make a door shape. Move them onto the corners of the opening.' }));
    $('estimate-table').replaceChildren();
    $('make-outlines').disabled = true;
    saveState();
    return;
  }
  const candidates = res.candidates.map((c) => ({ widthMm: c.widthMm, heightMm: c.heightMm, p: Math.round(c.p * 1000) / 1000 }));
  state.flow.estimate = {
    aspectHW: round(res.aspectHW, 4),
    sigmaLnAspect: round(res.sigmaLnAspect, 4),
    focalPx: round(res.focalPx, 1),
    focalSource: res.focalSource,
    viewTiltDeg: round(res.viewTiltDeg, 1),
    orthogonalityErrDeg: round(res.orthogonalityErrDeg, 2),
    confident: res.confident,
    issues: res.issues,
    candidates,
    imageWidth: photo.width,
    imageHeight: photo.height,
    corners: res.corners.map((p) => ({ x: round(p.x, 1), y: round(p.y, 1) })),
  };
  state.flow.pick = null;
  saveState();
  $('estimate-top').replaceChildren(
    h('p', { class: 'big-number', text: `${candidates[0].widthMm} x ${candidates[0].heightMm} mm` }),
    h('p', { class: res.confident ? 'good' : 'warn', text: res.confident ? 'Photo-only answer: sure.' : `Photo-only answer: unsure${res.issues.length ? ` (${res.issues.join(', ')})` : ''}. The AR check matters most here.` }),
  );
  kvRows($('estimate-table'), [
    ['Top 3 by shape (p)', candidates.slice(0, 3).map((c) => `${c.widthMm} x ${c.heightMm} (${c.p.toFixed(2)})`).join(', ')],
    ['Height / width', `${state.flow.estimate.aspectHW} (1 sigma ${(res.sigmaLnAspect * 100).toFixed(1)} %)`],
    ['Focal length', `${state.flow.estimate.focalPx} px (${res.focalSource})`],
    ['View tilt', `${state.flow.estimate.viewTiltDeg} deg`],
    ['Corner squareness error', `${state.flow.estimate.orthogonalityErrDeg} deg`],
    ['Photo', `${photo.width} x ${photo.height} px, ${state.flow.capture}`],
    ['Door finder', state.flow.detection ? `${state.flow.detection.ok ? 'found' : 'not found'} (confidence ${state.flow.detection.confidence.toFixed(2)})` : '-'],
    ['Corners (px)', state.flow.estimate.corners.map((p) => `${p.x},${p.y}`).join('  ')],
  ]);
  $('make-outlines').disabled = false;
  if ($('outline-links').childElementCount) {
    $('outline-links').replaceChildren(h('p', { class: 'warn', text: 'The corners changed. Tap "Make the outline links" again.' }));
  }
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function revokeFlowUrls() {
  for (const u of flowUi.urls) URL.revokeObjectURL(u);
  flowUi.urls = [];
}

async function makeOutlineLinks() {
  const est = state.flow && state.flow.estimate;
  if (!est) {
    status('flow-status', 'Take or pick a photo first.', 'warn');
    return;
  }
  const button = $('make-outlines');
  button.disabled = true;
  revokeFlowUrls();
  const box = $('outline-links');
  box.replaceChildren(h('p', { text: 'Making the outlines…' }));
  const f = state.form;
  // Gauge D's own placement (wall, standing up) unless the tester asks for step 2's: picking gauge E in
  // step 2 sets floor / lying flat, which would lay the outlines on the floor. Snapshot the set-up, so the
  // taps and the saved row say what the outlines were built with, whatever step 2 says later.
  const useStep2 = state.flowDraft.useStep2 === true;
  const setup = {
    anchoring: useStep2 ? f.anchoring : DESIGN_INFO.D.anchoring,
    orientation: useStep2 ? f.orientation : DESIGN_INFO.D.orientation,
    lock: f.lock,
    delivery: f.delivery,
    downloadAttr: f.downloadAttr === true,
    ...pageEnv(),
  };
  state.flow.setup = setup;
  saveState();
  const count = state.flowDraft.count === '2' ? 2 : 3;
  const lock = setup.lock === 'on';
  const cards = [];
  try {
    for (const [i, c] of est.candidates.slice(0, count).entries()) {
      const opts = { widthMm: c.widthMm, heightMm: c.heightMm, anchoring: setup.anchoring, orientation: setup.orientation };
      const fragment = outlineFragment(c.widthMm, c.heightMm, lock);
      let href;
      let size;
      if (setup.delivery === 'static') {
        const path = staticFileFor({ design: 'D', ...opts });
        if (!path) {
          cards.push(h('div', { class: 'cand' }, h('strong', { text: `${c.widthMm} x ${c.heightMm}` }), h('span', { class: 'warn', text: 'No ready-made file for this size and these choices. Use "Made on this phone" in step 2.' })));
          continue;
        }
        href = withFragment(path, fragment);
        size = 'ready-made';
      } else {
        const built = await buildUsdz('D', opts, f.forcePngJs === true);
        const url = URL.createObjectURL(new Blob([built.bytes], { type: USDZ_TYPE }));
        flowUi.urls.push(url);
        href = withFragment(url, fragment);
        size = `${(built.bytes.length / 1024).toFixed(0)} KB, ${built.ms} ms`;
      }
      const outline = { widthMm: c.widthMm, heightMm: c.heightMm };
      const label = `${c.widthMm} x ${c.heightMm}`;
      const anchor = h('a', { class: 'ar-link', rel: 'ar', href }, h('img', { src: 'ar-icon.svg', alt: `Open ${label} in AR`, width: '300', height: '75' }));
      if (setup.downloadAttr && setup.delivery === 'blob') anchor.setAttribute('download', 'model.usdz');
      wireArAnchor(anchor, () => ({ where: 'flow', label, outline, design: 'D', anchoring: setup.anchoring, orientation: setup.orientation, lock: setup.lock, delivery: setup.delivery }));
      const manual = h('button', { type: 'button', class: 'secondary small', text: 'This one fits (if the banner did nothing)', onclick: () => recordFlowPick(outline, 'manual') });
      cards.push(h('div', { class: 'cand', 'data-size': label }, h('span', { class: 'caption', text: `${i + 1}. ${label} mm (photo p ${c.p.toFixed(2)})` }), anchor, h('span', { class: 'muted', text: size }), manual));
    }
    box.replaceChildren(h('p', { class: 'muted', text: `Outlines: ${setup.anchoring}, ${setup.orientation}, lock ${setup.lock}, ${setup.delivery === 'blob' ? 'made on this phone' : 'ready-made files'}.` }), ...cards);
    logEvent('outlines', `${est.candidates.slice(0, count).map((c) => `${c.widthMm}x${c.heightMm}`).join(' ')} | ${setup.anchoring} ${setup.orientation} lock ${setup.lock} ${setup.delivery}`);
    renderFlowPick();
  } catch (error) {
    box.replaceChildren(h('p', { class: 'bad', text: `Could not make the outlines: ${(error && error.message) || error}` }));
  } finally {
    button.disabled = false;
  }
}

function recordFlowPick(outline, via) {
  if (!state.flow) state.flow = { startedAt: null, estimate: null };
  state.flow.pick = { widthMm: outline.widthMm, heightMm: outline.heightMm, via, at: Date.now() };
  saveState();
  renderFlowPick();
}

function renderFlowPick() {
  const pick = state.flow && state.flow.pick;
  const el = $('flow-pick');
  for (const card of $('outline-links').querySelectorAll('.cand')) {
    card.classList.toggle('picked', Boolean(pick) && card.dataset.size === `${pick.widthMm} x ${pick.heightMm}`);
  }
  if (!pick) {
    show('flow-pick', false);
    $('save-flow').disabled = !(state.flow && state.flow.estimate);
    return;
  }
  const secs = state.flow.startedAt ? Math.round((pick.at - state.flow.startedAt) / 1000) : null;
  el.className = 'good';
  el.textContent = `Picked ${pick.widthMm} x ${pick.heightMm} mm (${pick.via === 'banner' ? "from the 'This size fits' button in AR" : 'by hand on this page'})${secs !== null ? `, ${secs} s after the photo started` : ''}.`;
  $('save-flow').disabled = false;
}

function saveFlowRow() {
  const flow = state.flow;
  if (!flow || !flow.estimate) {
    status('flow-status', 'Take or pick a photo first.', 'warn');
    return;
  }
  const t = state.flowDraft.tape;
  const tape = { w: num(t.w), h: num(t.h) };
  const truth = draftTruth();
  const top = flow.estimate.candidates[0];
  const pick = flow.pick;
  const setup = flow.setup && typeof flow.setup === 'object' ? flow.setup : null;
  const row = {
    id: newId(),
    at: new Date().toISOString(),
    doorId: t.doorId || null,
    tape,
    // The door's real standard size (picked, or the catalogue size the tape is within TRUE_SIZE_TOL of):
    // a tape reads 818 x 2043, never exactly 820 x 2040, so picks are judged against this, not the raw mm.
    trueSize: truth.size,
    trueSizeVia: truth.via,
    aspectTop1: top ? { widthMm: top.widthMm, heightMm: top.heightMm, p: top.p } : null,
    candidates: flow.estimate.candidates.slice(0, 3),
    confident: flow.estimate.confident,
    unsure: !flow.estimate.confident,
    issues: flow.estimate.issues,
    aspectHW: flow.estimate.aspectHW,
    focalSource: flow.estimate.focalSource,
    viewTiltDeg: flow.estimate.viewTiltDeg,
    capture: flow.capture,
    detection: flow.detection,
    arPick: pick ? { widthMm: pick.widthMm, heightMm: pick.heightMm } : null,
    arPickVia: pick ? pick.via : null,
    secs: pick && flow.startedAt ? Math.round((pick.at - flow.startedAt) / 1000) : null,
    aspectCorrect: sameSize(top, truth.size),
    arCorrect: truth.size ? sameSize(pick, truth.size) === true : null,
    // The set-up the outlines were built with (null when no outlines were made), and where.
    anchoring: setup ? setup.anchoring : null,
    orientation: setup ? setup.orientation : null,
    lock: setup ? setup.lock === 'on' : null,
    delivery: setup ? setup.delivery : null,
    ...(setup ? { framed: setup.framed, relAr: setup.relAr, inApp: setup.inApp || null, safariVersion: setup.safariVersion || null } : pageEnv()),
  };
  if (!truth.via) {
    // eslint-disable-next-line no-alert
    if (!window.confirm("This door's standard size is not known yet (no tape, or the tape is not near exactly one size). It will not be judged. Save anyway? (You cannot add it later.)")) return;
  }
  state.flowRows.push(row);
  state.flow = null;
  state.flowPending = null;
  state.flowDraft.tape = { w: '', h: '', doorId: '', size: '' };
  saveState();
  syncInputs('flowDraft.');
  clearFlowUi();
  renderFlowTruth();
  status('flow-status', `Flow row ${state.flowRows.length} saved. Next door: enter its tape size and tap "Photo the door".`, 'good');
  renderSession();
}

/** Empty the step-4 photo, estimate and outline links (not the saved state). */
function clearFlowUi() {
  revokeFlowUrls();
  $('outline-links').replaceChildren();
  show('estimate-box', false);
  show('editor-box', false);
  show('flow-pick', false);
  $('save-flow').disabled = true;
  flowUi.photo = null;
}

/**
 * The door's standard size from step 4: the size the tester picked, 'none of these', or else the one
 * catalogue size the tape is within TRUE_SIZE_TOL of.
 * @returns {{ size: { widthMm: number, heightMm: number }|null, via: 'picked'|'none'|'tape'|null }}
 */
function draftTruth() {
  const t = state.flowDraft.tape;
  if (t.size === 'none') return { size: null, via: 'none' };
  const picked = SIZES.find((s) => `${s.widthMm}x${s.heightMm}` === t.size);
  if (picked) return { size: { widthMm: picked.widthMm, heightMm: picked.heightMm }, via: 'picked' };
  const fromTape = standardForTape(t, SIZES);
  return fromTape ? { size: fromTape, via: 'tape' } : { size: null, via: null };
}

function renderFlowTruth() {
  const el = $('flow-truth');
  const t = state.flowDraft.tape;
  const truth = draftTruth();
  const tol = `${TRUE_SIZE_TOL.wMm} mm wide and ${TRUE_SIZE_TOL.hMm} mm high`;
  el.className = truth.via ? 'note' : 'warn';
  if (truth.via === 'none') el.textContent = 'Not a standard size: this door will be saved but not judged.';
  else if (truth.via === 'picked') el.textContent = `Picks are judged against ${truth.size.widthMm} x ${truth.size.heightMm} (picked).`;
  else if (truth.via === 'tape') el.textContent = `From the tape this door is ${truth.size.widthMm} x ${truth.size.heightMm} (within ${tol}). Picks are judged against that.`;
  else if (num(t.w) !== null && num(t.h) !== null) {
    el.textContent = `The tape is not within ${tol} of exactly one catalogue size. Pick the door's standard size above, or "None of these".`;
  } else el.textContent = "Enter the tape, or pick the door's standard size.";
}

function fillTrueSizeSelect() {
  const select = $('true-size-select');
  select.replaceChildren(
    h('option', { value: '', text: 'Work it out from the tape' }),
    ...SIZES.map((s) => h('option', { value: `${s.widthMm}x${s.heightMm}`, text: `${s.widthMm} x ${s.heightMm}` })),
    h('option', { value: 'none', text: 'None of these (not a standard size)' }),
  );
  const current = state.flowDraft.tape.size || '';
  const ok = [...select.options].some((o) => o.value === current);
  select.value = ok ? current : '';
  if (!ok) state.flowDraft.tape.size = '';
}

/** After a reload the photo is gone, but the estimate and any pick were saved: offer the outlines again. */
function restoreFlow() {
  const flow = state.flow;
  if (!flow || !flow.estimate) return;
  show('estimate-box', true);
  const c = flow.estimate.candidates;
  $('estimate-top').replaceChildren(
    h('p', { class: 'big-number', text: `${c[0].widthMm} x ${c[0].heightMm} mm` }),
    h('p', { class: 'warn', text: 'The page was reloaded. The photo is gone but its estimate was kept: tap "Make the outline links" to carry on, or take a new photo.' }),
  );
  kvRows($('estimate-table'), [
    ['Top 3 by shape (p)', c.slice(0, 3).map((x) => `${x.widthMm} x ${x.heightMm} (${x.p.toFixed(2)})`).join(', ')],
    ['Height / width', String(flow.estimate.aspectHW)],
    ['Photo-only answer', flow.estimate.confident ? 'sure' : `unsure (${flow.estimate.issues.join(', ') || 'close sizes'})`],
  ]);
  $('make-outlines').disabled = false;
  renderFlowPick();
}

// ------------------------------------------------------------------------------------------------------
// Panel 5: export
// ------------------------------------------------------------------------------------------------------

function resultsJson() {
  const s = summarize(state.rows);
  const f = summarizeFlow(state.flowRows);
  return JSON.stringify({
    v: 1,
    page: 'lab/arql',
    at: new Date().toISOString(),
    env: envInfo(),
    summary: s,
    flowSummary: f,
    goNoGo: goNoGo(s, f, { bannerSeen: state.bannerSeen }).map((x) => ({ id: x.id, verdict: x.verdict, value: x.value })),
    rows: state.rows.map((r) => ({ ...r, computed: computeRow(r) })),
    flow: state.flowRows,
    events: state.events.slice(-150),
  });
}

async function copyResults() {
  const text = resultsJson();
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    status('export-status', `Copied ${state.rows.length} rows and ${state.flowRows.length} flow rows (${text.length} characters). Paste them into a message or email.`, 'good');
    show('export-text', false);
  } catch {
    const area = $('export-text');
    area.value = text;
    show('export-text', true);
    area.focus();
    area.select();
    status('export-status', 'Copying was blocked here. The results are in the box below: press and hold in it, Select All, then Copy.', 'warn');
  }
}

function resultsFile() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return new File([resultsJson()], `arql-results-${stamp}.json`, { type: 'application/json' });
}

function downloadResults() {
  try {
    const file = resultsFile();
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: file.name, class: 'hidden' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status('export-status', `Saved ${file.name}. On iPhone it is in the Files app, under Downloads.`, 'good');
  } catch (error) {
    status('export-status', `The download did not work (${(error && error.message) || error}). Use Copy results instead.`, 'bad');
  }
}

async function shareResults() {
  let file;
  try {
    file = resultsFile();
  } catch {
    status('export-status', 'This browser cannot make a file to share. Use Copy results instead.', 'bad');
    return;
  }
  if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [file] })) {
    status('export-status', 'This browser cannot share files. Use Copy results or Download JSON instead.', 'warn');
    return;
  }
  try {
    await navigator.share({ files: [file], title: 'AR Quick Look lab results' });
    status('export-status', 'Shared.', 'good');
  } catch (error) {
    if (error && error.name === 'AbortError') status('export-status', 'Sharing was cancelled.', 'note');
    else status('export-status', `Sharing did not work (${(error && error.message) || error}). Use Copy results instead.`, 'bad');
  }
}

function clearAll() {
  // eslint-disable-next-line no-alert
  if (!window.confirm('Delete every row, flow row and event saved on this phone? This cannot be undone. (Copy the results first if you need them.)')) return;
  // Catch up with any other open copy first, so the clear (a new epoch) is the newest save and wins.
  syncFromStorage();
  const { env, rev } = state;
  state = defaults();
  state.env = env;
  state.rev = rev;
  saveState();
  syncInputs();
  clearFlowUi();
  renderAll();
  toast('All results cleared.');
}

// ------------------------------------------------------------------------------------------------------
// Start
// ------------------------------------------------------------------------------------------------------

function renderAll() {
  renderEnv();
  renderDesignHelp();
  renderDraft();
  renderPending();
  renderSession();
  renderLog();
  fillTrueSizeSelect();
  renderFlowTruth();
}

function start() {
  probeStorage();
  const saved = loadState();
  state = restore(saved);
  if (!storage.ok) showStorageWarning();
  fillTrueSizeSelect();
  syncInputs();
  bindInputs();
  watchPage();
  wireArAnchor($('ar-link'), panel2Run);
  wireEditor();

  $('make-link').addEventListener('click', makeLink);
  $('save-row').addEventListener('click', saveRow);
  $('photo-start').addEventListener('click', onPhotoStart);
  $('photo-take').addEventListener('click', onPhotoTake);
  $('photo-cancel').addEventListener('click', () => {
    stopFlowCamera();
    status('flow-status', '');
  });
  $('photo-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    onPhotoFile(file);
  });
  $('make-outlines').addEventListener('click', makeOutlineLinks);
  $('save-flow').addEventListener('click', saveFlowRow);
  $('copy-results').addEventListener('click', copyResults);
  $('download-results').addEventListener('click', downloadResults);
  $('share-results').addEventListener('click', shareResults);
  $('clear-all').addEventListener('click', clearAll);

  const p = pendingRun();
  logEvent('load', p ? `page loaded ${Math.round((Date.now() - p.tapAt) / 1000)} s after the last AR tap` : '');
  if (saved) {
    const note = $('restore-note');
    note.textContent = p
      ? 'The page was reloaded after AR (iOS does this sometimes). Your choices and results are back. Fill in step 3, then make the AR link again for the next run.'
      : 'Your earlier choices and results were restored from this phone.';
    note.classList.remove('hidden');
  }
  renderAll();
  restoreFlow();
}

start();
