// Photo-scale lab page: the UI, a minimal 4-handle corner editor, storage and export.
// The maths lives in the pure modules next to this file (meta.js, afdepth.js, brick.js, stats.js).
// Everything stays on the phone: no network request is made except for this page's own files.

import { loadPhoto, getLuma, readJpegInfo, photoToJpegDataUrl } from '../../js/photo.js';
import config from '../../js/config.js';
import {
  photoFocal, intrinsics, rectifyRectangle, planeToImageFor, standardSizesFrom, estimateFromCorners,
} from '../../js/estimate.js';
import { findDoor, startingQuad } from '../../js/door-find.js';
import { warpToRect } from '../../js/vision.js';
// The product's capturePhoto is not used here: it drops a slow (over 4 s) or turned takePhoto still for a
// video frame, so the lab would never see the takePhoto bytes it is meant to inspect. labCapture below asks
// ImageCapture itself and always keeps the still's bytes for the metadata.
import { startCamera, stopCamera, cameraErrorKind } from '../../js/camera.js';
import { fitView, imageToScreen, hitTestHandle, loupeCorner } from '../../js/editor.js';
import { orderDoorQuad } from '../../js/geometry.js';
import { parseMeta } from './meta.js';
import {
  analyseAfDepth, afPointFromExif, afDepthReading, rawForHeight, impliedRawUnitMm, focalRoundingPct, AF_RAW_TO_MM,
} from './afdepth.js';
import { brickSteps, brickScale, courseFromPeriod, COURSES, V0, V1, HEIGHT_GATE_MM, HALVES_MAX_PCT } from './brick.js';
import {
  sessionSummary, rowErrors, ROUTES, GO_RULES, hasTape, cornersConfirmed, afImpliedUnit, phoneOf,
} from './stats.js';

// ---------------------------------------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------------------------------------

const STORE_ROWS = 'sm-lab-photo-scale:rows:v1';
const STORE_TRUTH = 'sm-lab-photo-scale:truth:v1';
const STORE_PREFS = 'sm-lab-photo-scale:prefs:v1';
const MAX_ROWS = 300;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const EDGE_FRAC = 0.02;
const SIZES = standardSizesFrom(config);
const REVEAL_PRESETS = { none: 0, half: 55, one: 110 };
const PREVIEW_HEIGHT_MM = 2040;
const PREVIEW_MARGIN_MM = 700;
const CANCELLED = Symbol('cancelled');
/** How long the in-page camera waits for takePhoto (the first iOS shot reconfigures the camera). */
const STILL_TIMEOUT_MS = 30000;
const STILL_TIMEOUT = 'lab_still_timeout';
/** The file input's accept value for each picker route (null: no accept attribute at all). */
const ACCEPT_BY_ROUTE = Object.freeze({
  library: 'image/*',
  library_heic: 'image/heic,image/heif,image/*',
  library_any: null,
  files: 'image/*',
  takephoto: 'image/*',
});

const $ = (id) => document.getElementById(id);
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const f0 = (v) => (isNum(v) ? String(Math.round(v)) : '-');
const fx = (v, d = 2) => (isNum(v) ? v.toFixed(d) : '-');
const signed = (v, d = 0) => {
  if (!isNum(v)) return '-';
  const t = v.toFixed(d);
  return Number(t) === 0 ? (0).toFixed(d) : `${v > 0 ? '+' : ''}${t}`;
};
const sizeText = (w, h) => (isNum(w) && isNum(h) ? `${f0(w)} x ${f0(h)} mm` : '-');
const routeLabel = (id) => (ROUTES.find((r) => r.id === id) || { label: id }).label;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** localStorage, never throwing (private mode, blocked storage, full quota). */
const store = {
  get(key, fallback) {
    try {
      const s = globalThis.localStorage.getItem(key);
      return s ? JSON.parse(s) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      // nothing to remove
    }
  },
};

/** Build an element. props: class, text, on<event>, or attributes. Children: nodes or text. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const notice = (tone, ...children) => h('div', { class: `notice ${tone}` }, ...children);

function kv(pairs) {
  return h('div', { class: 'scroll' }, h('table', { class: 'kv' }, h('tbody', null,
    pairs.filter(Boolean).map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v === null || v === undefined || v === '' ? '-' : v))))));
}

function table(headers, rows, numeric = []) {
  return h('div', { class: 'scroll' }, h('table', null,
    h('thead', null, h('tr', null, headers.map((x, i) => h('th', { class: numeric.includes(i) ? 'num' : null }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'num' : null }, c === null || c === undefined ? '-' : c)))))));
}

/** Which result sections the tester has open, so a re-render (a setting changed) keeps them open. */
const openSections = new Set(['brick']);

function section(title, key, ...children) {
  const el = h('details', openSections.has(key) ? { open: true } : null, h('summary', null, title), ...children);
  el.addEventListener('toggle', () => {
    if (el.open) openSections.add(key);
    else openSections.delete(key);
  });
  return el;
}

function setStatus(id, tone, text) {
  const box = $(id);
  if (!box) return;
  box.textContent = '';
  if (text) box.append(notice(tone, text));
}

function showProgress(id, frac) {
  const bar = $(id);
  if (!bar) return;
  bar.hidden = frac === null;
  if (frac !== null) bar.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}

/** Numbers in exported JSON: six significant digits is plenty and keeps it short. */
function compactJson(value, space) {
  return JSON.stringify(value, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v), space);
}

const REASONS = {
  no_tag: 'the photo has no AF depth (tag 0x0038)',
  not_a_number: 'the AF depth is not a number',
  not_positive: 'the AF depth is 0 (no reading)',
  out_of_range: 'the AF depth says "out of range" (1059-1079)',
  confidence_zero: 'the AF confidence is 0',
  af_point_outside_opening: 'the focus point is outside the door opening, so the distance is to something else',
  no_depth: 'no AF depth',
  no_photo_geometry: 'the photo could not be opened here',
  no_brick: 'no brick found',
  no_strong_band: 'no strip beside the door is clearly periodic',
  no_band_in_photo: 'not enough wall beside the door is in the photo',
  no_agreement: 'the periodic strips do not agree',
  no_period: 'no period in the combined strips',
  few_agreeing_bands: 'fewer than 3 strips agree on the course size',
  weak_combined_score: 'the combined strips are not clearly periodic',
  combined_peak_elsewhere: 'the combined strips peak at another period',
  left_right_disagree: `the left and right strips differ by more than ${HALVES_MAX_PCT} % (a dot may be off)`,
  top_bottom_disagree: `the top and bottom halves differ by more than ${HALVES_MAX_PCT} % (a dot may be off)`,
  height_out_of_range: `the height would be outside ${HEIGHT_GATE_MM[0]}-${HEIGHT_GATE_MM[1]} mm`,
  not_run: 'not measured yet',
  no_pick: 'no catalogue pick',
};
const reasonText = (r) => REASONS[r] || r || 'unknown';

const CAPTURE_REASONS = {
  no_image_capture: 'this browser has no ImageCapture (iOS before 18.4)',
  track_not_live: 'the camera track had ended',
  takephoto_empty_blob: 'takePhoto returned an empty file',
  still_turned_against_preview: 'the still came back turned against the preview, so the video frame was used for the corners; the metadata is still the takePhoto JPEG\'s',
};
const captureReasonText = (r) => {
  if (!r) return '';
  if (CAPTURE_REASONS[r]) return CAPTURE_REASONS[r];
  if (r.startsWith('takephoto_timeout')) return `takePhoto gave nothing within ${STILL_TIMEOUT_MS / 1000} s`;
  if (r.startsWith('takephoto_failed')) return `takePhoto failed: ${r.slice('takephoto_failed: '.length)}`;
  return r;
};

const MAKER_REASONS = {
  no_exif: 'the file has no EXIF at all, so the route stripped all camera data (or the photo never had any)',
  no_exif_ifd: 'the file has EXIF but no Exif sub-IFD',
  no_makernote_tag: 'the EXIF survived but the MakerNote (0x927C) was removed',
  not_apple: "the MakerNote is not Apple's",
  makernote_unreadable: 'the MakerNote points outside the file',
  makernote_cut_short: 'the MakerNote is cut short',
};

// ---------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------

/** The photo on screen and everything worked out for it. */
let current = null;
let photoToken = 0;
let measureToken = 0;
let cam = null;
let remeasureTimer = 0;
let rows = store.get(STORE_ROWS, []);
if (!Array.isArray(rows)) rows = [];
let truths = store.get(STORE_TRUTH, {});
if (!truths || typeof truths !== 'object') truths = {};
const prefs = store.get(STORE_PREFS, {}) || {};

function saveRows() {
  if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS);
  if (!store.set(STORE_ROWS, rows)) setStatus('export-status', 'warn', 'This browser would not keep the session (private browsing or storage full). Download the JSON before leaving the page.');
}

function savePrefs() {
  store.set(STORE_PREFS, prefs);
}

// ---------------------------------------------------------------------------------------------------------
// Step 1: route and photo
// ---------------------------------------------------------------------------------------------------------

const ROUTE_HELP = {
  library: {
    button: 'Choose photo',
    steps: ['Tap "Choose photo".', 'Tap "Photo Library".', 'Pick the photo you took with the Camera app.'],
    note: 'The picker here accepts "image/*". iOS may turn a HEIC photo into a JPEG on the way ("Most Compatible").',
  },
  library_heic: {
    button: 'Choose photo (HEIC accepted)',
    steps: ['Tap "Choose photo".', 'Tap "Photo Library".', 'Pick the same photo again.'],
    note: 'The picker here accepts "image/heic,image/heif,image/*": iOS chooses what it hands over partly from that list, so it may keep the original HEIC.',
  },
  library_any: {
    button: 'Choose photo (no filter)',
    steps: ['Tap "Choose photo".', 'Tap "Photo Library".', 'Pick the same photo again.'],
    note: 'The picker here has no accept filter at all, which can also change what iOS hands over.',
  },
  files: {
    button: 'Choose photo',
    steps: ['First, in the Photos app: open the photo, tap Share, then "Save to Files".', 'Here: tap "Choose photo", then "Choose File".', 'Find the photo in Files and tap it.'],
    note: 'Files keeps the original HEIC file.',
  },
  inpage: {
    steps: ['Tap "Start camera" and allow the camera when asked.', 'Hold the phone upright, 2-3 m back, door in the middle.', 'Tap "Take photo".'],
    note: `On iOS 18.4 and later this asks takePhoto for a full photo and waits up to ${STILL_TIMEOUT_MS / 1000} s for it; its bytes are always the ones checked. Older iPhones give only a video frame, which is logged as its own route (it never has a MakerNote).`,
  },
  takephoto: {
    button: 'Take photo with the picker',
    steps: ['Tap the button, then "Take Photo".', 'Photograph the door and tap "Use Photo".'],
    note: 'This is the control: Safari re-encodes these photos, so the MakerNote is expected to be missing.',
  },
};

function currentRoute() {
  return $('route').value;
}

function renderRouteHelp() {
  const route = currentRoute();
  const help = ROUTE_HELP[route];
  const box = $('route-help');
  box.textContent = '';
  box.append(h('ol', null, help.steps.map((s) => h('li', null, s))), h('p', null, h('em', null, help.note)));
  if (route === 'inpage' || route === 'takephoto') {
    box.append(h('p', null, 'For the focus distance: 1x, phone upright, 2-3 m back, door centred, no tap to focus. For bricks: keep at least half a metre of wall on each side in the photo.'));
  } else {
    box.append(h('p', null, 'Take the photo in the Camera app at 1x, phone upright, 2-3 m back, door centred, without tapping to focus. For bricks, keep at least half a metre of wall on each side.'));
  }
  $('pick-box').hidden = route === 'inpage';
  $('cam-box').hidden = route !== 'inpage';
  if (help.button) $('pick-text').textContent = help.button;
  // WebKit reads the accept list when the picker opens: each library route has its own.
  const input = $('file');
  const accept = route in ACCEPT_BY_ROUTE ? ACCEPT_BY_ROUTE[route] : 'image/*';
  if (accept === null) input.removeAttribute('accept');
  else input.setAttribute('accept', accept);
  if (route !== 'inpage') stopCam();
}

async function readBytes(blob) {
  const part = blob.size > MAX_READ_BYTES ? blob.slice(0, MAX_READ_BYTES) : blob;
  if (typeof part.arrayBuffer === 'function') return part.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsArrayBuffer(part);
  });
}

/** What the file itself suggests about the way it came, to catch a wrong route choice. */
function routeHints(info, meta, capture, metaFrom) {
  const hints = [];
  const ageS = isNum(info.lastModified) ? (Date.now() - info.lastModified) / 1000 : null;
  if (metaFrom === 'still') hints.push(capture === 'frame' ? 'in-page takePhoto JPEG (corners on the video frame)' : 'in-page takePhoto JPEG');
  else if (metaFrom === 'frame') hints.push('in-page video frame');
  if (meta.container === 'heif') hints.push('original HEIC (Files keeps it)');
  if (meta.container === 'jpeg' && meta.exif && meta.exif.make) hints.push(`JPEG with ${meta.exif.make} EXIF`);
  if (capture === 'file' && /^image\.jpe?g$/i.test(info.name || '') && !meta.exif) hints.push("named image.jpg with no EXIF: looks like the picker's Take Photo");
  if (ageS !== null && ageS >= 0 && ageS < 180) hints.push(`file made ${Math.round(ageS)} s ago`);
  return hints;
}

function resetPhoto() {
  clearTimeout(remeasureTimer);
  measureToken++;
  if (current && current.photo && current.photo.canvas) {
    current.photo.canvas.width = 0;
    current.photo.canvas.height = 0;
  }
  current = null;
  $('step-corners').hidden = true;
  $('step-settings').hidden = true;
  $('step-result').hidden = true;
  $('result').textContent = '';
  $('q1-box').textContent = '';
  $('corner-status').textContent = '';
  $('door-bind').textContent = '';
  setStatus('measure-status', '', '');
  showProgress('measure-progress', null);
}

/**
 * Everything for a new photo: read the bytes, parse the metadata, decode, find the door, measure.
 * The door name is fixed on the row here, when the photo is given: typing the next door's name later must
 * not move this photo onto that door.
 *
 * @param {Blob} blob  the picture that is decoded, and its corners marked
 * @param {{ route: string, capture: 'file'|'live'|'frame', captureNote?: string, captureMs?: number,
 *           name?: string, type?: string, lastModified?: number|null,
 *           metaBlob?: Blob, metaFrom?: 'file'|'still'|'frame', captureDetail?: object, accept?: string|null }} how
 *   metaBlob: the file whose bytes are parsed for the metadata, when it is not `blob` (an in-page still that
 *   came back turned: its metadata is kept, the corners go on the video frame)
 */
async function handlePhoto(blob, how) {
  const my = ++photoToken;
  resetPhoto();
  const timings = {};
  const metaBlob = how.metaBlob || blob;
  const info = {
    name: how.name !== undefined ? how.name : metaBlob.name || '(no name)',
    type: how.type !== undefined ? how.type : metaBlob.type || '',
    size: metaBlob.size,
    lastModified: how.lastModified !== undefined ? how.lastModified : isNum(metaBlob.lastModified) ? metaBlob.lastModified : null,
  };
  const doorId = currentDoorId();
  if (isNum(how.captureMs)) timings.captureMs = how.captureMs;
  showProgress('load-progress', 0.1);
  setStatus('load-status', 'info', 'Reading the photo...');
  let bytes = null;
  let readError = null;
  try {
    const t0 = now();
    bytes = await readBytes(metaBlob);
    timings.readMs = now() - t0;
  } catch (e) {
    readError = e && e.message ? e.message : String(e);
  }
  if (my !== photoToken) return;
  const t1 = now();
  const meta = bytes ? parseMeta(bytes) : parseMeta(new ArrayBuffer(0));
  timings.metaMs = now() - t1;
  if (readError) meta.warnings.unshift(`the file could not be read: ${readError}`);
  if (metaBlob.size > MAX_READ_BYTES) meta.warnings.unshift(`only the first ${MAX_READ_BYTES / 1048576} MB were read`);
  let jpegInfo = null;
  if (bytes && meta.container === 'jpeg') {
    try {
      jpegInfo = readJpegInfo(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 262144)));
    } catch {
      jpegInfo = null;
    }
  }
  const at = new Date().toISOString();
  const metaFrom = how.metaFrom || 'file';
  current = {
    rowId: `${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    doorId,
    route: how.route,
    capture: how.capture,
    captureNote: how.captureNote || '',
    captureDetail: how.captureDetail || null,
    metaFrom,
    accept: how.accept === undefined ? null : how.accept,
    file: info,
    meta,
    jpegInfo,
    routeHints: routeHints(info, meta, how.capture, metaFrom),
    photo: null,
    decodeError: null,
    focalNote: '',
    timings,
    detection: null,
    detectedQuad: null,
    corners: null,
    cornersSource: null,
    cornersChecked: false,
    afPoint: null,
    geometry: null,
    af: null,
    brickFound: null,
    brickStale: true,
    scale: null,
  };
  saveCurrentRow();
  renderQ1();
  renderDoorBind();
  renderCornerCheck();
  renderSession();

  showProgress('load-progress', 0.4);
  setStatus('load-status', 'info', 'Opening the photo...');
  // Decoded into locals: `current.photo = await ...` would bind the old `current` before the await, and a
  // newer photo picked meanwhile would then be the one released below.
  let photo = null;
  let decodeError = null;
  try {
    const t2 = now();
    photo = await loadPhoto(blob, config, { capture: how.capture });
    timings.decodeMs = now() - t2;
  } catch (e) {
    decodeError = (e && e.cause && e.cause.message) || (e && e.message) || 'decode_failed';
  }
  if (my !== photoToken) {
    // Superseded: free this photo's own canvas, never the newer one's.
    if (photo && photo.canvas) {
      photo.canvas.width = 0;
      photo.canvas.height = 0;
    }
    return;
  }
  current.photo = photo;
  current.decodeError = decodeError;
  if (!current.photo) {
    showProgress('load-progress', null);
    setStatus('load-status', 'bad', 'This phone could not open the picture itself (an older iPhone cannot show HEIC photos in a web page). The camera data above was still read and saved.');
    saveCurrentRow();
    renderResult();
    renderSession();
    return;
  }
  useHeifFocal();
  current.afPoint = afPointFromExif(meta.exif, current.photo.width, current.photo.height);

  showProgress('load-progress', 0.7);
  setStatus('load-status', 'info', 'Looking for the door...');
  const t3 = now();
  const detection = await findDoor(current.photo, { timeoutMs: 4000 });
  timings.detectMs = now() - t3;
  if (my !== photoToken) return;
  current.detection = detection;
  current.detectedQuad = startingQuad(current.photo, detection);
  current.corners = current.detectedQuad.map((p) => ({ ...p }));
  current.cornersSource = detection && detection.ok ? 'detected' : 'default';
  showProgress('load-progress', null);
  setStatus('load-status', detection && detection.ok ? 'ok' : 'warn',
    detection && detection.ok
      ? `Photo opened (${current.photo.width} x ${current.photo.height}). The door was found: check the 4 dots in step 2.`
      : `Photo opened (${current.photo.width} x ${current.photo.height}). The door was not found (${detection ? detection.reason : 'error'}): drag the 4 dots onto it in step 2.`);
  $('step-corners').hidden = false;
  $('step-settings').hidden = false;
  editor.setPhoto(current.photo, current.corners, current.afPoint.point);
  renderCornerCheck();
  await measure();
}

/**
 * loadPhoto reads the 35 mm focal only from a JPEG. For a HEIC the Exif item has it too: use it when the EXIF
 * size has the decoded picture's shape (either way up), as readJpegInfo would.
 */
function useHeifFocal() {
  const { photo, meta } = current;
  const ex = meta.exif;
  if (!photo || photo.focal35mm || meta.container !== 'heif' || !ex || !isNum(ex.focal35)) return;
  if (ex.pixelX > 0 && ex.pixelY > 0) {
    const r = (w, hh) => Math.max(w, hh) / Math.min(w, hh);
    if (Math.abs(r(ex.pixelX, ex.pixelY) / r(photo.width, photo.height) - 1) > 0.02) {
      current.focalNote = 'the HEIF EXIF focal was not used: its pixel size has another shape (cropped?)';
      return;
    }
  }
  photo.focal35mm = ex.focal35;
  current.focalNote = 'focal from the HEIF Exif item (read by this page; loadPhoto reads JPEG only)';
}

// ---------------------------------------------------------------------------------------------------------
// In-page camera
// ---------------------------------------------------------------------------------------------------------

function cameraErrorText(error) {
  const kind = cameraErrorKind(error);
  const texts = {
    blocked: 'The camera was not allowed. In Settings > Safari > Camera, choose Ask or Allow, then try again.',
    unavailable: 'This browser offers no camera here.',
    busy: 'The camera is busy (another app may have it). Close other camera apps and try again.',
    insecure: 'The camera needs an https page.',
  };
  return texts[kind] || `The camera did not start (${error && error.name ? error.name : 'unknown error'}).`;
}

function stopCam() {
  if (cam) stopCamera(cam.stream);
  cam = null;
  const video = $('cam-video');
  if (video) {
    try {
      video.pause();
    } catch {
      // nothing playing
    }
    video.srcObject = null;
    video.hidden = true;
  }
  if ($('cam-controls')) $('cam-controls').hidden = true;
  if ($('cam-start')) $('cam-start').hidden = false;
}

function onCamStart() {
  const video = $('cam-video');
  video.hidden = false;
  setStatus('load-status', 'info', 'Starting the camera...');
  // startCamera calls getUserMedia straight away, inside this tap.
  startCamera(video).then(
    (res) => {
      cam = res;
      $('cam-start').hidden = true;
      $('cam-controls').hidden = false;
      setStatus('load-status', 'info', res.playing ? 'Camera on. Door in the middle, then tap "Take photo".' : 'Camera on. Tap "Take photo" (the first tap may only start the preview).');
    },
    (error) => {
      video.hidden = true;
      setStatus('load-status', 'bad', cameraErrorText(error));
    },
  );
}

async function onCamShoot() {
  if (!cam) return;
  const video = $('cam-video');
  if (video.paused) {
    try {
      await video.play();
    } catch {
      setStatus('load-status', 'warn', 'The preview would not start. Tap "Take photo" again.');
      return;
    }
    if (!video.videoWidth) return;
  }
  setStatus('load-status', 'info', `Taking the photo... (the first one can take several seconds; this waits up to ${STILL_TIMEOUT_MS / 1000} s)`);
  const t0 = now();
  let shot;
  try {
    shot = await labCapture(cam.track, video);
  } catch (e) {
    setStatus('load-status', 'bad', `The photo could not be taken (${e && e.message ? e.message : 'error'}). Tap "Take photo" again.`);
    return;
  }
  const captureMs = now() - t0;
  stopCam();
  const d = shot.detail;
  const captureNote = shot.metaFrom === 'still'
    ? `ImageCapture.takePhoto() JPEG, ${f0(d.stillMs)} ms${d.reason ? `; ${captureReasonText(d.reason)}` : ''}`
    : `video frame, no takePhoto still: ${captureReasonText(d.reason)}`;
  await handlePhoto(shot.geometryBlob, {
    route: shot.route,
    capture: shot.capture,
    metaBlob: shot.metaBlob,
    metaFrom: shot.metaFrom,
    captureDetail: d,
    captureNote,
    captureMs,
    name: shot.metaFrom === 'still' ? 'takePhoto.jpg' : 'video-frame.jpg',
    type: shot.metaBlob.type || 'image/jpeg',
    lastModified: Date.now(),
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(STILL_TIMEOUT)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The video's current frame on a canvas at its own size, or null. The caller releases it. */
function snapshotVideo(video) {
  const w = video ? video.videoWidth : 0;
  const hh = video ? video.videoHeight : 0;
  if (!(w > 0 && hh > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hh;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no context');
    ctx.drawImage(video, 0, 0, w, hh);
    return canvas;
  } catch {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }
}

/**
 * ImageCapture.takePhoto(), asked the way the product asks it (largest size in landscape order: with no
 * size iOS returns its smallest photo; flash off where it can be chosen), so the bytes are the ones the
 * product would get. The options are returned for the row.
 */
async function takeStillDirect(track) {
  const ic = new globalThis.ImageCapture(track);
  const options = {};
  let caps = null;
  try {
    caps = typeof ic.getPhotoCapabilities === 'function' ? await ic.getPhotoCapabilities() : null;
  } catch {
    caps = null;
  }
  let w = caps && caps.imageWidth && caps.imageWidth.max;
  let hh = caps && caps.imageHeight && caps.imageHeight.max;
  if (!(w > 0 && hh > 0) && typeof track.getSettings === 'function') {
    const s = track.getSettings() || {};
    w = s.width;
    hh = s.height;
  }
  if (w > 0 && hh > 0) {
    options.imageWidth = Math.max(w, hh);
    options.imageHeight = Math.min(w, hh);
  }
  if (caps && Array.isArray(caps.fillLightMode) && caps.fillLightMode.includes('off')) options.fillLightMode = 'off';
  const blob = await ic.takePhoto(options);
  return { blob, options };
}

/** Whether a still (readJpegInfo of its head) shows the other way up from a frame of fw x fh. */
function stillTurned(info, fw, fh) {
  if (!info || !(info.width > 0 && info.height > 0 && fw > 0 && fh > 0)) return null;
  const quarter = info.orientation >= 5 && info.orientation <= 8;
  const sw = quarter ? info.height : info.width;
  const sh = quarter ? info.width : info.height;
  const square = (r) => Math.abs(Math.log(r)) <= Math.log(1.1);
  const a = sw / sh;
  const b = fw / fh;
  return !square(a) && !square(b) && a > 1 !== b > 1;
}

/**
 * One in-page shot for the lab. The video frame is copied first (it is what the tester framed); then
 * takePhoto is asked with a long timeout. Whenever a still comes back, its bytes are the row's metadata,
 * however long it took. The still is also used for the corners unless it came back turned against the
 * preview (then the frame is, and the reason says so). With no still at all the row is a video frame, logged
 * under its own route so it never counts as "takePhoto lost the MakerNote". Every fallback reason is kept.
 *
 * @returns {Promise<{ geometryBlob: Blob, metaBlob: Blob, capture: 'live'|'frame', metaFrom: 'still'|'frame',
 *   route: 'inpage'|'inpage_frame', detail: object }>}
 */
async function labCapture(track, video) {
  const frame = snapshotVideo(video);
  const detail = {
    imageCapture: typeof globalThis.ImageCapture === 'function',
    trackState: track ? track.readyState : 'none',
    frame: frame ? { w: frame.width, h: frame.height } : null,
    stillMs: null,
    options: null,
    still: null,
    turned: null,
    reason: null,
  };
  try {
    let still = null;
    if (!detail.imageCapture) detail.reason = 'no_image_capture';
    else if (!track || track.readyState !== 'live') detail.reason = 'track_not_live';
    else {
      const t0 = now();
      try {
        const r = await withTimeout(takeStillDirect(track), STILL_TIMEOUT_MS);
        detail.options = r.options;
        if (r.blob && r.blob.size > 0) still = r.blob;
        else detail.reason = 'takephoto_empty_blob';
      } catch (e) {
        detail.reason = e && e.message === STILL_TIMEOUT
          ? `takephoto_timeout_${STILL_TIMEOUT_MS / 1000}s`
          : `takephoto_failed: ${(e && e.name) || 'Error'}${e && e.message ? ` (${e.message})` : ''}`;
      }
      detail.stillMs = now() - t0;
    }
    if (still) {
      detail.still = { bytes: still.size, type: still.type || '' };
      try {
        const info = readJpegInfo(new Uint8Array(await readBytes(still.slice(0, 262144))));
        if (info && info.width) Object.assign(detail.still, { w: info.width, h: info.height, orientation: info.orientation });
        if (frame) detail.turned = stillTurned(info, frame.width, frame.height);
      } catch {
        // No readable header: no sign either way.
      }
      if (!detail.turned || !frame) return { geometryBlob: still, metaBlob: still, capture: 'live', metaFrom: 'still', route: 'inpage', detail };
    }
    if (!frame) throw new Error(`no video frame${detail.reason ? `; ${captureReasonText(detail.reason)}` : ''}`);
    const frameBlob = await new Promise((resolve) => frame.toBlob(resolve, 'image/jpeg', 0.92));
    if (!frameBlob || !frameBlob.size) {
      if (still) return { geometryBlob: still, metaBlob: still, capture: 'live', metaFrom: 'still', route: 'inpage', detail };
      throw new Error(`the video frame could not be encoded${detail.reason ? `; ${captureReasonText(detail.reason)}` : ''}`);
    }
    if (still) {
      detail.reason = 'still_turned_against_preview';
      return { geometryBlob: frameBlob, metaBlob: still, capture: 'frame', metaFrom: 'still', route: 'inpage', detail };
    }
    return { geometryBlob: frameBlob, metaBlob: frameBlob, capture: 'frame', metaFrom: 'frame', route: 'inpage_frame', detail };
  } finally {
    if (frame) {
      frame.width = 0;
      frame.height = 0;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Step 2: the corner editor (4 handles, drag by offset, loupe)
// ---------------------------------------------------------------------------------------------------------

const LABELS = ['TL', 'TR', 'BR', 'BL'];

function createEditor(canvas) {
  const ctx = canvas.getContext('2d');
  let photo = null;
  let points = null;
  let afPoint = null;
  let view = { scale: 1, tx: 0, ty: 0 };
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let drag = null;
  let loupeSide = null;
  const listeners = [];

  function layout() {
    if (!photo) return;
    cssW = Math.max(200, canvas.parentElement.clientWidth);
    const maxH = Math.max(260, Math.round((window.innerHeight || 700) * 0.66));
    cssH = Math.min(maxH, Math.round((cssW * photo.height) / photo.width));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    view = fitView(photo.width, photo.height, cssW, cssH, 10);
    draw();
  }

  function drawHandle(p, label, active) {
    const s = imageToScreen(view, p);
    ctx.beginPath();
    ctx.arc(s.x, s.y, active ? 14 : 11, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(11, 92, 173, 0.35)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd400';
    ctx.fill();
    ctx.font = '700 13px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 3;
    ctx.strokeText(label, s.x + 14, s.y - 12);
    ctx.fillText(label, s.x + 14, s.y - 12);
  }

  function drawCross(p, size) {
    const s = imageToScreen(view, p);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffd400';
    ctx.beginPath();
    ctx.moveTo(s.x - size, s.y);
    ctx.lineTo(s.x + size, s.y);
    ctx.moveTo(s.x, s.y - size);
    ctx.lineTo(s.x, s.y + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, size * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawLoupe() {
    const pt = points[drag.i];
    const L = loupeCorner(drag.finger, cssW, cssH, { previousSide: loupeSide, diameter: 132 });
    loupeSide = L.side;
    const M = Math.max(1.5, view.scale * 5);
    const r = L.radius;
    ctx.save();
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = '#15181c';
    ctx.fill();
    ctx.clip();
    // Source rectangle kept inside the photo (older Safari draws nothing for one that is not).
    let sx = pt.x - r / M;
    let sy = pt.y - r / M;
    let sw = (2 * r) / M;
    let sh = (2 * r) / M;
    let dx = L.cx - r;
    let dy = L.cy - r;
    let dw = 2 * r;
    let dh = 2 * r;
    if (sx < 0) { dx -= sx * M; dw += sx * M; sw += sx; sx = 0; }
    if (sy < 0) { dy -= sy * M; dh += sy * M; sh += sy; sy = 0; }
    if (sx + sw > photo.width) { const over = sx + sw - photo.width; sw -= over; dw -= over * M; }
    if (sy + sh > photo.height) { const over = sy + sh - photo.height; sh -= over; dh -= over * M; }
    if (sw > 0.5 && sh > 0.5) ctx.drawImage(photo.canvas, sx, sy, sw, sh, dx, dy, dw, dh);
    const toL = (q) => ({ x: L.cx + (q.x - pt.x) * M, y: L.cy + (q.y - pt.y) * M });
    const prev = toL(points[(drag.i + 3) % 4]);
    const next = toL(points[(drag.i + 1) % 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 212, 0, 0.9)';
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(L.cx, L.cy);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(L.cx - 10, L.cy);
    ctx.lineTo(L.cx + 10, L.cy);
    ctx.moveTo(L.cx, L.cy - 10);
    ctx.lineTo(L.cx, L.cy + 10);
    ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  function draw() {
    if (!photo) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#15181c';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = true;
    try {
      ctx.drawImage(photo.canvas, view.tx, view.ty, photo.width * view.scale, photo.height * view.scale);
    } catch {
      // A released canvas: nothing to draw.
    }
    if (afPoint) drawCross(afPoint, 12);
    if (!points) return;
    const ordered = orderDoorQuad(points);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffd400';
    ctx.beginPath();
    ordered.forEach((p, i) => {
      const s = imageToScreen(view, p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.stroke();
    ordered.forEach((p, i) => {
      const index = points.findIndex((q) => q.x === p.x && q.y === p.y);
      drawHandle(p, LABELS[i], drag && drag.i === index);
    });
    if (drag) drawLoupe();
  }

  function local(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!points || drag) return;
    const p = local(e);
    const i = hitTestHandle(points, p, view, 40);
    if (i < 0) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety
    }
    drag = { i, id: e.pointerId, start: p, orig: { ...points[i] }, finger: p };
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    const p = local(e);
    const x = drag.orig.x + (p.x - drag.start.x) / view.scale;
    const y = drag.orig.y + (p.y - drag.start.y) / view.scale;
    points[drag.i] = { x: Math.max(0, Math.min(photo.width, x)), y: Math.max(0, Math.min(photo.height, y)) };
    drag.finger = p;
    draw();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    draw();
    for (const fn of listeners) fn(points.map((q) => ({ ...q })));
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 120);
  });

  return {
    setPhoto(p, pts, af) {
      photo = p;
      points = pts.map((q) => ({ ...q }));
      afPoint = af ? { ...af } : null;
      layout();
    },
    setPoints(pts) {
      points = pts.map((q) => ({ ...q }));
      draw();
    },
    onCommit(fn) {
      listeners.push(fn);
    },
    redraw: layout,
  };
}

const editor = createEditor($('editor'));
editor.onCommit((pts) => {
  if (!current || !current.photo) return;
  current.corners = pts;
  current.cornersSource = 'moved';
  // Moving a dot is the tester checking the corners; the tick can be taken off again.
  current.cornersChecked = true;
  renderCornerCheck();
  // Shape and focus distance at once (cheap); bricks again once the dots have settled.
  computeGeometry();
  current.brickStale = true;
  recompute();
  clearTimeout(remeasureTimer);
  remeasureTimer = setTimeout(() => measure(), 900);
});

// ---------------------------------------------------------------------------------------------------------
// Step 3: settings and measuring
// ---------------------------------------------------------------------------------------------------------

function readSettings() {
  const checked = document.querySelector('input[name="reveal"]:checked');
  const choice = checked ? checked.value : 'typed';
  const slider = Number($('reveal-slider').value);
  const revealMm = choice in REVEAL_PRESETS ? REVEAL_PRESETS[choice] : isNum(slider) ? slider : 125;
  const s = Number($('setback').value);
  const setbackMm = $('setback').value !== '' && isNum(s) && s >= 0 && s <= 500 ? s : 20;
  const region = $('region').value || 'AU86';
  return { revealChoice: choice, revealMm, setbackMm, region };
}

/** Shape, focal and focus-distance geometry for the current corners (cheap). */
function computeGeometry() {
  const { photo } = current;
  const quad = orderDoorQuad(current.corners);
  const focal = photoFocal(photo);
  const K = intrinsics(focal.focalPx, photo.width, photo.height);
  const rect = rectifyRectangle(quad, K);
  const est = estimateFromCorners({ corners: quad, imageWidth: photo.width, imageHeight: photo.height, focalPx: focal.focalPx, focalSource: focal.source, sizes: SIZES });
  const mx = EDGE_FRAC * photo.width;
  const my = EDGE_FRAC * photo.height;
  const nearEdge = quad.some((p) => p.x < mx || p.x > photo.width - mx || p.y < my || p.y > photo.height - my);
  current.geometry = { quad, focal, K, rect, est, nearEdge };
}

async function measure() {
  if (!current || !current.photo || !current.corners) return;
  clearTimeout(remeasureTimer);
  const my = ++measureToken;
  try {
    computeGeometry();
  } catch (e) {
    setStatus('measure-status', 'bad', `The corners could not be used (${e && e.message ? e.message : 'error'}). Move the dots onto the door and tap Measure.`);
    return;
  }
  current.brickStale = true;
  recompute();
  $('step-result').hidden = false;
  setStatus('measure-status', 'info', 'Looking for brick courses...');
  showProgress('measure-progress', 0);
  const t0 = now();
  const { quad, rect } = current.geometry;
  let found;
  try {
    found = await runChunked(brickSteps(getLuma(current.photo), quad, rect.widthOverHeight), (p) => showProgress('measure-progress', p.done / p.total), () => my !== measureToken);
  } catch (e) {
    found = { ok: false, error: e && e.message ? e.message : 'failed' };
  }
  if (found === CANCELLED || my !== measureToken || !current) return;
  current.timings.brickMs = now() - t0;
  current.brickFound = found;
  current.brickStale = false;
  showProgress('measure-progress', null);
  setStatus('measure-status', 'ok', `Measured. Bricks took ${fx(current.timings.brickMs / 1000, 1)} s. Change the settings above and the numbers update; move a dot and it measures again.`);
  recompute();
}

/** Run a generator in setTimeout chunks of about 40 ms. */
function runChunked(gen, onProgress, cancelled) {
  return new Promise((resolve) => {
    const step = () => {
      if (cancelled()) {
        resolve(CANCELLED);
        return;
      }
      const deadline = now() + 40;
      try {
        for (;;) {
          const r = gen.next();
          if (r.done) {
            resolve(r.value);
            return;
          }
          onProgress(r.value);
          if (now() > deadline) break;
        }
      } catch (e) {
        resolve({ ok: false, error: e && e.message ? e.message : 'failed' });
        return;
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

/** The cheap parts again (settings changed, corners moved): focus-distance sizes, brick scale, row, display. */
function recompute() {
  if (!current) return;
  const settings = readSettings();
  current.settings = settings;
  if (current.photo && current.geometry) {
    const { K, quad, est, rect } = current.geometry;
    const m = current.meta.maker;
    current.af = analyseAfDepth({
      corners: quad,
      K,
      point: current.afPoint.point,
      afDepthRaw: m.afDepthRaw,
      afConfidence: m.afConfidence,
      accel: m.accel,
      setbackMm: settings.setbackMm,
      sigmaLnAspect: est.ok ? est.sigmaLnAspect : null,
      sizes: SIZES,
    });
    // The same depth as if it were taken at the image centre (the iPhone's default focus area): how a picker
    // that turns or transcodes the photo treats SubjectArea is not known, and this shows what hangs on it.
    current.afCentre = current.afPoint.source !== 'centre'
      ? analyseAfDepth({
          corners: quad,
          K,
          point: { x: current.photo.width / 2, y: current.photo.height / 2 },
          afDepthRaw: m.afDepthRaw,
          afConfidence: m.afConfidence,
          setbackMm: settings.setbackMm,
        })
      : null;
    current.scale = current.brickFound && !current.brickStale
      ? brickScale(current.brickFound, { Zu: Math.abs(rect.t[0] * rect.r3[0] + rect.t[1] * rect.r3[1] + rect.t[2] * rect.r3[2]), aspectHW: rect.aspectHW, revealMm: settings.revealMm, regionId: settings.region, sigmaLnAspect: est.ok ? est.sigmaLnAspect : null, sizes: SIZES })
      : null;
    renderCornerStatus();
  }
  saveCurrentRow();
  renderResult();
  renderTruthErrors();
  renderSession();
}

function renderCornerStatus() {
  const box = $('corner-status');
  box.textContent = '';
  const g = current.geometry;
  if (!g) return;
  if (g.nearEdge) box.append(notice('warn', 'A dot is within 2 % of the photo\'s edge: the door may be cut off, so its shape (and every size below) may be off.'));
  if (!g.est.ok) box.append(notice('bad', `These 4 dots do not make a usable outline (${g.est.error}). Move them onto the door's corners.`));
  else if (g.est.issues.length) box.append(notice('info', `Shape checks: ${g.est.issues.join(', ')}.`));
  if (current.afPoint && current.af && current.af.ok && !current.af.inside) box.append(notice('warn', 'The focus point (yellow cross) is outside the door opening: the iPhone measured the distance to something else.'));
}

// ---------------------------------------------------------------------------------------------------------
// Rows (what is kept and exported: never pixels)
// ---------------------------------------------------------------------------------------------------------

function currentDoorId() {
  return ($('door-id').value || '').trim().slice(0, 60);
}

function round1(p) {
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
}

function buildRow() {
  const c = current;
  const m = c.meta;
  const ex = m.exif;
  const maker = m.maker;
  const g = c.geometry;
  const af = c.af && c.af.ok ? c.af : null;
  const found = c.brickFound && !c.brickStale ? c.brickFound : null;
  const scale = c.scale;
  const regional = scale ? scale.regional : null;
  const catalogue = {
    aspect: g && g.est.ok ? { w: g.est.candidates[0].widthMm, h: g.est.candidates[0].heightMm, p: g.est.candidates[0].p } : null,
    af: af && af.snap.range[0] ? { w: af.snap.range[0].widthMm, h: af.snap.range[0].heightMm, p: af.snap.range[0].p } : null,
    brick: scale && scale.snap[0] ? { w: scale.snap[0].widthMm, h: scale.snap[0].heightMm, p: scale.snap[0].p } : null,
  };
  return {
    id: c.rowId,
    at: c.at,
    route: c.route,
    // Fixed when the photo was given (or by the "this photo is door X" button), never the box's text now.
    doorId: c.doorId,
    ua: navigator.userAgent,
    file: c.file,
    accept: c.accept,
    capture: c.capture,
    captureNote: c.captureNote,
    captureDetail: c.captureDetail,
    metaFrom: c.metaFrom,
    routeHints: c.routeHints,
    decoded: c.photo ? { w: c.photo.width, h: c.photo.height } : null,
    decodeError: c.decodeError,
    container: m.container,
    brands: m.brands,
    byteLength: m.byteLength,
    head64: m.head64,
    jpegInfo: c.jpegInfo,
    metaWarnings: m.warnings.slice(0, 40),
    exif: ex ? {
      make: ex.make, model: ex.model, software: ex.software, lensModel: ex.lensModel, orientation: ex.orientation,
      dateTime: ex.dateTime, focalLength: ex.focalLength, focal35: ex.focal35, exposureTime: ex.exposureTime,
      fNumber: ex.fNumber, iso: ex.iso, subjectArea: ex.subjectArea, subjectDistance: ex.subjectDistance,
      pixelX: ex.pixelX, pixelY: ex.pixelY, makerNoteBytes: ex.makerNoteBytes, ifd0Tags: ex.ifd0Tags, exifTags: ex.exifTags,
    } : null,
    maker: {
      present: maker.present, apple: maker.apple, reason: maker.reason, header: maker.header, version: maker.version,
      byteLength: maker.byteLength, afDepthRaw: maker.afDepthRaw, afConfidence: maker.afConfidence, accel: maker.accel,
      tags: maker.tags,
    },
    afReading: afDepthReading(maker.afDepthRaw, maker.afConfidence),
    corners: c.corners ? orderDoorQuad(c.corners).map(round1) : null,
    cornersSource: c.cornersSource,
    cornersChecked: Boolean(c.cornersChecked),
    detection: c.detection ? { ok: c.detection.ok, confidence: c.detection.confidence, reason: c.detection.reason || null } : null,
    afPoint: c.afPoint ? { ...round1(c.afPoint.point), source: c.afPoint.source, note: c.afPoint.note } : null,
    focal: g ? { px: g.focal.focalPx, source: g.focal.source, f35: c.photo.focal35mm, note: c.focalNote } : null,
    aspectHW: g ? g.rect.aspectHW : null,
    widthOverHeight: g ? g.rect.widthOverHeight : null,
    orthogonalityErrDeg: g ? g.rect.orthogonalityErrDeg : null,
    viewTiltDeg: g ? g.rect.viewTiltDeg : null,
    nearEdge: g ? g.nearEdge : null,
    estimate: g ? (g.est.ok ? { sigmaLnAspect: g.est.sigmaLnAspect, issues: g.est.issues, confident: g.est.confident, candidates: g.est.candidates } : { error: g.est.error }) : null,
    af: af ? {
      valid: af.reading.valid,
      reasons: af.reading.reasons,
      depthMm: af.reading.depthMm,
      inside: af.inside,
      nT: af.nT,
      nD: af.nD,
      dNorm: af.dNorm,
      Zu: af.Zu,
      nX: { axial: af.models.axial.nXmm, range: af.models.range.nXmm },
      setbackMm: af.setbackMm,
      offAxisDeg: af.offAxisDeg,
      incidenceDeg: af.incidenceDeg,
      variants: { axial: af.models.axial.variants, range: af.models.range.variants },
      snap: af.snap,
      gravity: af.gravity,
      fromCentrePx: c.afPoint ? Math.hypot(c.afPoint.point.x - c.photo.width / 2, c.afPoint.point.y - c.photo.height / 2) : null,
      centre: c.afCentre && c.afCentre.ok ? {
        inside: c.afCentre.inside,
        nD: c.afCentre.nD,
        dNorm: c.afCentre.dNorm,
        range: c.afCentre.headline.range,
        axial: c.afCentre.headline.axial,
      } : null,
    } : null,
    brick: found ? {
      ok: found.ok,
      found: found.found,
      reason: found.reason || found.error || null,
      bands: (found.bands || []).map((b) => ({ side: b.side, k: b.k, u0: b.u0, validFrac: b.validFrac, kept: b.kept, score: b.score, periodUnits: b.periodUnits, strong: b.strong, agree: b.agree })),
      nKept: found.nKept,
      nStrong: found.nStrong,
      nAgree: found.nAgree,
      bestScore: found.bestScore,
      medianStrongUnits: found.medianStrongUnits,
      periodUnits: found.periodUnits,
      periodScore: found.periodScore,
      left: found.left,
      right: found.right,
      top: found.top,
      bottom: found.bottom,
      agreeLRPct: found.agreeLRPct,
      agreeTBPct: found.agreeTBPct,
      wide: found.wide,
      checks: scale ? scale.checks : ['not_run'],
      Zu: scale ? scale.Zu : null,
      regionId: scale ? scale.regionId : null,
      courseMm: regional ? regional.mm : null,
      revealMm: scale ? scale.revealMm : null,
      hypotheses: scale ? scale.hypotheses.map((x) => ({ id: x.id, mm: x.mm, Hraw: x.Hraw, Wraw: x.Wraw, H: x.H, W: x.W, gateOk: x.gateOk, gate: x.gate })) : [],
      snap: scale ? scale.snap : [],
    } : null,
    catalogue,
    settings: c.settings || readSettings(),
    timings: c.timings,
  };
}

function saveCurrentRow() {
  if (!current) return;
  try {
    const row = buildRow();
    const i = rows.findIndex((r) => r.id === row.id);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    saveRows();
  } catch (e) {
    setStatus('export-status', 'warn', `This photo's numbers could not be saved (${e && e.message ? e.message : 'error'}).`);
  }
}

function currentRow() {
  return current ? rows.find((r) => r.id === current.rowId) || null : null;
}

// ---------------------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------------------

/** The question-1 answer, straight after the photo is read. */
function renderQ1() {
  const box = $('q1-box');
  box.textContent = '';
  if (!current) return;
  const { meta, route } = current;
  const m = meta.maker;
  const ex = meta.exif;
  const camLine = ex
    ? `Camera data: ${[ex.make, ex.model].filter(Boolean).join(' ') || 'no make/model'}, 35 mm focal ${ex.focal35 ? `${ex.focal35} mm` : 'not given'}${ex.software ? `, software ${ex.software}` : ''}.`
    : 'Camera data: none (no EXIF).';
  const fileLine = `File: ${current.file.type || 'no type'}, ${(current.file.size / 1048576).toFixed(2)} MB, container ${meta.container.toUpperCase()}${current.captureNote ? ` (${current.captureNote})` : ''}.`;
  if (m.present && m.apple) {
    const reading = afDepthReading(m.afDepthRaw, m.afConfidence);
    const depth = isNum(m.afDepthRaw)
      ? `AF depth (0x0038): raw ${m.afDepthRaw} = ${fx(m.afDepthRaw / 100, 2)} m if cm, confidence ${m.afConfidence === null ? 'not given' : m.afConfidence}${reading.valid ? '' : `, NOT usable: ${reading.reasons.map(reasonText).join('; ')}`}.`
      : 'AF depth (0x0038): not in this MakerNote (not a LiDAR iPhone, or not recorded for this shot).';
    box.append(notice(isNum(m.afDepthRaw) && reading.valid ? 'ok' : 'warn',
      h('strong', null, `Apple MakerNote: YES (${m.tags.length} tags) via ${routeLabel(route)}.`), h('br'), depth, h('br'), camLine, h('br'), fileLine));
  } else if (route === 'inpage_frame') {
    const why = current.captureDetail ? captureReasonText(current.captureDetail.reason) : 'unknown';
    box.append(notice('warn',
      h('strong', null, 'No takePhoto still: this is a video frame, logged as its own route.'), h('br'),
      `Why there is no still: ${why}. A video frame never has EXIF or a MakerNote, so it says nothing about what takePhoto keeps.`, h('br'), fileLine));
  } else {
    box.append(notice('bad',
      h('strong', null, `No Apple MakerNote in the photo from "${routeLabel(route)}".`), h('br'),
      `Why: ${MAKER_REASONS[m.reason] || m.reason || 'unknown'}.`, h('br'), camLine, h('br'), fileLine,
      meta.head64 ? h('div', { class: 'mono' }, `First 64 bytes: ${meta.head64}`) : null));
  }
  if (current.routeHints.length) box.append(h('p', { class: 'lead' }, `Route check: ${current.routeHints.join('; ')}.`));
}

function headlineBlock(tone, k, v, s) {
  return h('div', { class: `hl ${tone}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null);
}

function renderResult() {
  const box = $('result');
  box.textContent = '';
  const row = currentRow();
  if (!row) return;
  $('step-result').hidden = false;
  box.append(renderHeadline(row));
  box.append(
    section('Photo file', 'file', renderFile(row)),
    section('Camera data (EXIF)', 'exif', renderExif(row)),
    section(`Apple MakerNote (${row.maker.present ? (row.maker.apple ? `${row.maker.tags.length} tags` : 'not Apple') : 'missing'})`, 'maker', renderMaker(row)),
  );
  if (row.decoded) {
    box.append(
      section('Door shape and lens', 'shape', renderShape(row)),
      section('Size from the focus distance', 'af', renderAf(row)),
      section('Size from the brick courses', 'brick', renderBrick(row)),
    );
  }
  const warnings = [...row.metaWarnings];
  if (row.nearEdge) warnings.push('a corner is within 2 % of the photo edge: the ratio is unreliable');
  if (warnings.length) box.append(section(`Warnings (${warnings.length})`, 'warnings', h('ul', null, warnings.map((w) => h('li', null, w)))));
  if (row.decoded && current.brickFound && !current.brickStale) drawPreview();
}

function renderHeadline(row) {
  const wrap = h('div', { class: 'headline' });
  if (!row.decoded) {
    wrap.append(headlineBlock('bad', 'Size', 'Photo could not be opened', 'The camera data was still read (see below).'));
    return wrap;
  }
  const af = row.af;
  if (af) {
    const est = methodRowEstimate(row, 'af_range');
    const r = af.variants.range.find((v) => v.setbackMm === af.setbackMm);
    const a = af.variants.axial.find((v) => v.setbackMm === af.setbackMm);
    if (est && !est.gated) {
      wrap.append(headlineBlock('ok', 'Focus distance (Apple AF depth)', sizeText(est.W, est.H),
        `range reading, leaf set back ${af.setbackMm} mm; camera ${f0(r.Zmm)} mm from the frame plane. Axial reading: ${sizeText(a.W, a.H)}.`));
    } else {
      wrap.append(headlineBlock('bad', 'Focus distance (Apple AF depth)', 'No size', est ? reasonText(est.reason) : 'not available'));
    }
  } else {
    const reading = row.afReading;
    wrap.append(headlineBlock('bad', 'Focus distance (Apple AF depth)', 'No size',
      reading.valid ? 'the 4 dots do not make a usable outline yet' : reading.reasons.map(reasonText).join('; ')));
  }
  const br = row.brick;
  if (!br) {
    wrap.append(headlineBlock('', 'Brick courses', current && current.brickStale ? 'Measuring...' : 'Not measured', ''));
  } else {
    const reg = br.hypotheses.find((x) => x.id === br.regionId);
    const course = COURSES.find((c) => c.id === br.regionId);
    if (reg && reg.gateOk) {
      wrap.append(headlineBlock('ok', `Brick courses (${course ? course.label : br.regionId} mm)`, sizeText(reg.W, reg.H),
        `reveal ${br.revealMm} mm; ${br.nAgree} strips agree; without the reveal: ${sizeText(reg.Wraw, reg.Hraw)}.`));
    } else if (!br.found) {
      wrap.append(headlineBlock('bad', 'Brick courses', `No brick found (best score ${fx(br.bestScore, 1)})`, reasonText(br.reason)));
    } else {
      wrap.append(headlineBlock('bad', `Brick courses (${course ? course.label : br.regionId} mm)`, `Rejected: ${sizeText(reg && reg.W, reg && reg.H)}`, (reg ? reg.gate : br.checks).map(reasonText).join('; ')));
    }
  }
  const cat = row.catalogue;
  const pickText = (c) => (c ? `${c.w} x ${c.h} (p ${fx(c.p, 2)})` : '-');
  wrap.append(headlineBlock('', 'Nearest standard size', pickText(cat.aspect),
    `from the shape only. With the focus distance: ${pickText(cat.af)}. With the bricks: ${pickText(cat.brick)}.`));
  return wrap;
}

function methodRowEstimate(row, id) {
  const er = rowErrors(row, truths[row.doorId] || null).find((e) => e.id === id);
  return er ? er.estimate : null;
}

function renderFile(row) {
  const ex = row.exif;
  const scale = ex && row.decoded && ex.pixelX ? `${fx(Math.max(row.decoded.w, row.decoded.h) / Math.max(ex.pixelX, ex.pixelY), 3)} (decoded long side / EXIF long side)` : '-';
  const t = row.timings || {};
  const d = row.captureDetail;
  const stillText = d && d.still
    ? `${d.still.bytes} bytes${d.still.type ? `, ${d.still.type}` : ''}${d.still.w ? `, ${d.still.w} x ${d.still.h} stored, orientation ${d.still.orientation}` : ''}, ${f0(d.stillMs)} ms${d.turned ? ', turned against the preview' : ''}`
    : d ? `none (${captureReasonText(d.reason) || 'unknown'})` : null;
  return kv([
    ['Route', routeLabel(row.route)],
    ['Door', row.doorId || '(no name)'],
    ['Route check', row.routeHints.join('; ') || '-'],
    ['Picker accept', row.route === 'inpage' || row.route === 'inpage_frame' ? '-' : row.accept === null || row.accept === undefined ? '(no accept attribute)' : row.accept],
    d ? ['takePhoto still', stillText] : null,
    d ? ['takePhoto options', d.options ? JSON.stringify(d.options) : '-'] : null,
    d ? ['Video frame', d.frame ? `${d.frame.w} x ${d.frame.h}` : 'none'] : null,
    d ? ['Metadata from / corners on', `${row.metaFrom === 'still' ? 'the takePhoto still' : 'the video frame'} / ${row.capture === 'live' ? 'the takePhoto still' : 'the video frame'}`] : null,
    ['File name', row.file.name],
    ['File type', row.file.type || '(none)'],
    ['File size', `${row.file.size} bytes (${(row.file.size / 1048576).toFixed(2)} MB)`],
    ['Last modified', isNum(row.file.lastModified) ? new Date(row.file.lastModified).toISOString() : '-'],
    ['Capture', `${row.capture}${row.captureNote ? `: ${row.captureNote}` : ''}`],
    ['Container', `${row.container}${row.brands && row.brands.length ? ` (brands ${row.brands.join(', ')})` : ''}`],
    ['Decoded (working) size', row.decoded ? `${row.decoded.w} x ${row.decoded.h}` : `not decoded: ${row.decodeError || 'error'}`],
    ['EXIF PixelX x PixelY', ex && ex.pixelX ? `${ex.pixelX} x ${ex.pixelY}` : '-'],
    ['Scale EXIF to decoded', scale],
    ['JPEG frame (readJpegInfo)', row.jpegInfo ? `${row.jpegInfo.width} x ${row.jpegInfo.height}, orientation ${row.jpegInfo.orientation}, f35 ${row.jpegInfo.focal35mm || '-'}` : '-'],
    row.head64 ? ['First 64 bytes', h('span', { class: 'mono' }, row.head64)] : null,
    ['Timings, ms', `capture ${f0(t.captureMs)}, read ${f0(t.readMs)}, metadata ${fx(t.metaMs, 1)}, decode ${f0(t.decodeMs)}, find door ${f0(t.detectMs)}, bricks ${f0(t.brickMs)}`],
    ['Browser', row.ua],
  ]);
}

function renderExif(row) {
  const ex = row.exif;
  if (!ex) return notice('warn', 'No EXIF in this file.');
  return kv([
    ['Make', ex.make], ['Model', ex.model], ['Software', ex.software], ['Lens', ex.lensModel],
    ['FocalLength', isNum(ex.focalLength) ? `${fx(ex.focalLength, 3)} mm` : '-'],
    ['FocalLengthIn35mmFilm', ex.focal35 ? `${ex.focal35} mm` : '-'],
    ['ExposureTime', isNum(ex.exposureTime) ? `1/${f0(1 / ex.exposureTime)} s` : '-'],
    ['FNumber', fx(ex.fNumber, 2)], ['ISO', ex.iso],
    ['SubjectArea (stored px)', ex.subjectArea ? ex.subjectArea.join(', ') : '-'],
    ['SubjectDistance', isNum(ex.subjectDistance) ? `${fx(ex.subjectDistance, 2)} m` : '-'],
    ['Orientation', ex.orientation], ['DateTime', ex.dateTime],
    ['MakerNote size', isNum(ex.makerNoteBytes) ? `${ex.makerNoteBytes} bytes` : '-'],
    ['IFD0 tags', h('span', { class: 'mono' }, (ex.ifd0Tags || []).join(' '))],
    ['Exif IFD tags', h('span', { class: 'mono' }, (ex.exifTags || []).join(' '))],
  ]);
}

function valueText(t) {
  if (t.error) return `(${t.error})`;
  if (typeof t.value === 'string') return JSON.stringify(t.value);
  if (Array.isArray(t.value)) return t.value.map((v) => (v === null ? 'null' : Number.isInteger(v) ? String(v) : v.toPrecision(6))).join(', ') + (t.truncated ? ', ...' : '');
  if (t.hex !== undefined) return `hex ${t.hex}${t.count > 16 ? ' ...' : ''}`;
  return '-';
}

function renderMaker(row) {
  const m = row.maker;
  if (!m.present) return notice('bad', `No MakerNote in the photo from "${routeLabel(row.route)}": ${MAKER_REASONS[m.reason] || m.reason}.`);
  const parts = [kv([
    ['Apple', m.apple ? 'yes' : `no (header "${m.header ? m.header.ascii : ''}")`],
    ['Header', m.header ? h('span', { class: 'mono' }, m.header.hex) : '-'],
    ['Version', m.version], ['Size', `${m.byteLength} bytes`],
    ['AFMeasuredDepth (0x0038)', isNum(m.afDepthRaw) ? `${m.afDepthRaw} raw = ${fx(m.afDepthRaw, 0)} cm = ${f0(m.afDepthRaw * AF_RAW_TO_MM)} mm (if cm)` : 'absent'],
    ['AFConfidence (0x003D)', m.afConfidence === null ? 'absent' : m.afConfidence],
    ['Depth usable', row.afReading.valid ? h('span', { class: 'tag-ok' }, 'yes') : h('span', { class: 'tag-bad' }, row.afReading.reasons.map(reasonText).join('; '))],
    ['AccelerationVector (0x0008)', m.accel ? `${m.accel.map((v) => fx(v, 4)).join(', ')} (|g| ${fx(Math.hypot(...m.accel), 4)})` : 'absent'],
  ])];
  if (m.tags.length) {
    parts.push(h('h3', null, `Every MakerNote tag (${m.tags.length})`));
    parts.push(table(['Tag', 'Name', 'Type', 'Count', 'Value'], m.tags.map((t) => [t.tag, t.name, t.type, t.count, h('span', { class: 'mono' }, valueText(t))]), [3]));
  }
  return parts;
}

function renderShape(row) {
  if (!row.corners) return notice('info', 'No corners yet.');
  const est = row.estimate || {};
  return [
    kv([
      ['Corners (TL, TR, BR, BL), px', h('span', { class: 'mono' }, row.corners.map((p) => `(${p.x}, ${p.y})`).join(' '))],
      ['Corners from', row.cornersSource === 'detected' ? `door finder (confidence ${fx(row.detection && row.detection.confidence, 2)})` : row.cornersSource === 'moved' ? 'moved by hand' : 'a middle box (door not found)'],
      ['Counted in the error table', cornersConfirmed(row) ? h('span', { class: 'tag-ok' }, 'yes (corners confirmed)') : h('span', { class: 'tag-warn' }, row.cornersSource === 'default' ? 'no: a middle box never counts' : 'no: tick "the 4 dots are on the corners" or move a dot')],
      ['Height / width', fx(row.aspectHW, 4)],
      ['Not-square check', `${fx(row.orthogonalityErrDeg, 2)} deg (over 2 deg: a corner is off or the lens guess is wrong)`],
      ['View tilt', `${fx(row.viewTiltDeg, 1)} deg`],
      ['Focal', row.focal ? `${fx(row.focal.px, 1)} px, source ${row.focal.source}, 35 mm ${row.focal.f35 || 'none (26 mm phone prior)'}` : '-'],
      ['Focal note', row.focal && row.focal.note ? row.focal.note : '-'],
      ['Shape sigma (ln)', fx(est.sigmaLnAspect, 4)],
      ['Shape checks', est.error ? `unusable: ${est.error}` : (est.issues || []).join(', ') || 'none'],
      ['Corner near the edge', row.nearEdge ? h('span', { class: 'tag-warn' }, 'yes: ratio unreliable') : 'no'],
    ]),
    h('p', { class: 'lead' }, 'Focal source: "exif" is the camera\'s own figure for a whole 4:3 or 3:2 frame; "_file" means a picked file, whose EXIF focal is only a best guess (a gallery crop keeps the 4:3 shape and the EXIF). Any focal error scales the distance-based sizes by the same factor.'),
    est.candidates ? table(['Size (shape only)', 'p', 'z'], est.candidates.map((c) => [`${c.widthMm} x ${c.heightMm}`, fx(c.p, 3), fx(c.zAspect, 2)]), [1, 2]) : null,
  ];
}

function renderAf(row) {
  const af = row.af;
  if (!af) return notice('info', 'Not worked out yet.');
  const truth = truths[row.doorId] || null;
  const out = [];
  out.push(kv([
    ['Depth', af.valid ? `${f0(af.depthMm)} mm (raw ${row.maker.afDepthRaw} x ${AF_RAW_TO_MM})` : h('span', { class: 'tag-bad' }, af.reasons.map(reasonText).join('; '))],
    ['Focus point', row.afPoint ? `(${row.afPoint.x}, ${row.afPoint.y}) px, ${row.afPoint.source}${row.afPoint.note ? `: ${row.afPoint.note}` : ''}` : '-'],
    ['Focus point from the image centre', isNum(af.fromCentrePx) && row.decoded ? `${f0(af.fromCentrePx)} px (${fx((100 * af.fromCentrePx) / Math.max(row.decoded.w, row.decoded.h), 1)} % of the long side)` : '-'],
    ['Focus point inside the opening', af.inside ? h('span', { class: 'tag-ok' }, 'yes') : h('span', { class: 'tag-bad' }, 'NO: the depth is of something else')],
    af.centre ? ['If it were the image centre', `range ${sizeText(af.centre.range.W, af.centre.range.H)}, axial ${sizeText(af.centre.axial.W, af.centre.axial.H)}${af.centre.inside ? '' : ' (centre is outside the opening)'}`] : null,
    ['Ray off the optical axis', `${fx(af.offAxisDeg, 2)} deg (|d| ${fx(af.dNorm, 5)})`],
    ['Ray against the door normal', `${fx(af.incidenceDeg, 2)} deg`],
    ['dot(r3, t), door heights', fx(af.nT, 5)],
    ['dot(r3, d)', fx(af.nD, 5)],
    ['Typed leaf set-back s', `${af.setbackMm} mm`],
  ]));
  const rowsT = [];
  for (const model of ['range', 'axial']) {
    for (const v of af.variants[model]) {
      rowsT.push([model, `${v.setbackMm}${v.setbackMm === af.setbackMm ? ' (typed)' : ''}`, f0(v.W), f0(v.H), f0(v.Zmm)]);
    }
  }
  out.push(h('h3', null, 'Sizes for each reading of the depth'));
  out.push(table(['Model', 's, mm', 'W, mm', 'H, mm', 'Camera to plane, mm'], rowsT, [2, 3, 4]));
  out.push(h('p', { class: 'lead' }, '"axial": the depth is along the camera\'s axis (z). "range": the depth is along the ray to the focus point. Which one Apple records is not known: the tape tells.'));
  if (hasTape(truth) && af.valid && af.inside) {
    const geom = { nT: af.nT, nD: af.nD, dNorm: af.dNorm };
    const s = isNum(truth.setbackMm) ? truth.setbackMm : af.setbackMm;
    const given = row.maker.afDepthRaw;
    const need = ['range', 'axial'].map((model) => {
      const raw = rawForHeight(geom, model, truth.hMm, s);
      const ratio = given / raw;
      return [model, fx(raw, 1), fx(ratio, 4), fx(impliedRawUnitMm(given, raw), 3)];
    });
    out.push(h('h3', null, `Raw value the tape height needs (s = ${s} mm)`));
    out.push(table(['Model', 'Raw needed', 'Ratio given / needed', 'Implied mm per raw unit'], need, [1, 2, 3]));
    const f35 = row.focal ? row.focal.f35 : null;
    out.push(h('p', { class: 'lead' },
      `Implied unit = raw needed x ${AF_RAW_TO_MM} / raw given (${AF_RAW_TO_MM} if the raw value really is in cm; 5 if it were in 5 mm steps). `
      + 'This takes the focal as exact, and a tape height alone cannot tell the focal from the depth\'s unit: H is about depth / focal, so a focal off by x % looks just like a unit off by x %. '
      + (isNum(f35) ? `The EXIF 35 mm focal here is a whole number (${f35} mm), so its rounding alone can be up to ${fx(focalRoundingPct(f35), 1)} %; how it is defined (diagonal or width) can be another few %. ` : 'This photo has no EXIF 35 mm focal, so a phone prior was used: the focal may be off by several %. ')
      + `Pool the unit per phone model over many doors (session table) before blaming either: phone ${phoneOf(row)}.`));
  }
  const gr = af.gravity;
  if (gr) {
    out.push(h('h3', null, 'Gravity check (AccelerationVector against the door\'s vertical)'));
    out.push(table(['Mapping', 'Angle to door vertical', 'Pitch', 'Roll'], [
      ['door (r2)', '-', fx(gr.door.pitchDeg, 1), fx(gr.door.rollDeg, 1)],
      [`documented ${gr.documented.mapping}`, fx(gr.documented.angleToDoorDeg, 1), fx(gr.documented.pitchDeg, 1), fx(gr.documented.rollDeg, 1)],
      [`flipped ${gr.documentedFlipped.mapping}`, fx(gr.documentedFlipped.angleToDoorDeg, 1), fx(gr.documentedFlipped.pitchDeg, 1), fx(gr.documentedFlipped.rollDeg, 1)],
      [`best of 48 ${gr.best.mapping}`, fx(gr.best.angleToDoorDeg, 1), fx(gr.best.pitchDeg, 1), fx(gr.best.rollDeg, 1)],
    ], [1, 2, 3]));
    out.push(h('p', { class: 'lead' }, `|g| = ${fx(gr.magnitudeG, 3)}. A plumb door and correct corners give an angle of a degree or two for the right mapping. Degrees.`));
  }
  const snapRows = [];
  for (const model of ['range', 'axial']) for (const c of af.snap[model] || []) snapRows.push([model, `${c.widthMm} x ${c.heightMm}`, fx(c.p, 3), fx(c.zAspect, 2), fx(c.zScale, 2)]);
  if (snapRows.length) {
    out.push(h('h3', null, 'Nearest standard sizes with the focus distance (scale taken as 3 % p90)'));
    out.push(table(['Model', 'Size', 'p', 'z shape', 'z size'], snapRows, [2, 3, 4]));
  }
  return out;
}

function renderBrick(row) {
  const br = row.brick;
  if (!br) return notice('info', current && current.brickStale ? 'Measuring...' : 'Not measured yet.');
  const out = [];
  out.push(kv([
    ['Strips', `${br.nKept} in the photo, ${br.nStrong} strong (score > 25), ${br.nAgree} agree (within 4 %)`],
    ['Best strip score', fx(br.bestScore, 1)],
    ['Median strong period', isNum(br.medianStrongUnits) ? `${fx(br.medianStrongUnits, 5)} door heights` : '-'],
    ['Final period p', isNum(br.periodUnits) ? `${fx(br.periodUnits, 5)} door heights (score ${fx(br.periodScore, 1)})` : '-'],
    ['Left / right', `${fx(br.left && br.left.units, 5)} / ${fx(br.right && br.right.units, 5)}: differ ${fx(br.agreeLRPct, 2)} %`],
    ['Top / bottom', `${fx(br.top && br.top.units, 5)} / ${fx(br.bottom && br.bottom.units, 5)}: differ ${fx(br.agreeTBPct, 2)} %`],
    ['Combined strips, whole range', br.wide ? `peak ${fx(br.wide.units, 5)}, score ${fx(br.wide.score, 1)}, ${br.wide.matches ? 'same period' : 'ANOTHER period'}` : '-'],
    ['Zu (camera to plane, door heights)', fx(br.Zu, 4)],
    ['Reveal used', `${br.revealMm} mm (adds ${f0(br.revealMm / br.Zu)} mm to H)`],
    ['Checks', br.checks.length ? h('span', { class: 'tag-bad' }, br.checks.map(reasonText).join('; ')) : h('span', { class: 'tag-ok' }, 'passed')],
  ]));
  const reg = br.hypotheses.find((x) => x.id === br.regionId);
  out.push(h('h3', null, 'Every course size'));
  out.push(table(['Course', 'H raw', 'W raw', 'H + reveal', 'W + reveal', 'Gate'], br.hypotheses.map((x) => [
    `${x.id}${x.id === br.regionId ? ' (chosen)' : ''}`, f0(x.Hraw), f0(x.Wraw), f0(x.H), f0(x.W),
    x.gateOk ? h('span', { class: 'tag-ok' }, 'pass') : h('span', { class: 'tag-bad' }, x.gate.map((g) => g.replace(/_/g, ' ')).join(', ')),
  ]), [1, 2, 3, 4]));
  if (br.snap.length) {
    out.push(h('h3', null, 'Nearest standard sizes with the bricks (scale taken as 5 % p90)'));
    out.push(table(['Size', 'p', 'z shape', 'z size'], br.snap.map((c) => [`${c.widthMm} x ${c.heightMm}`, fx(c.p, 3), fx(c.zAspect, 2), fx(c.zScale, 2)]), [1, 2, 3]));
  }
  // The course a band implies is p x (H - reveal / Zu): the brick face is nearer than the frame plane.
  const Hreg = reg && isNum(reg.H) && isNum(br.Zu) ? reg.H : null;
  out.push(h('h3', null, 'Strips beside the door'));
  out.push(table(['Side', 'k', 'u0', 'In photo', 'Score', 'Period', 'H if 86', 'mm/course'], br.bands.filter((b) => b.kept).map((b) => [
    b.side, b.k, fx(b.u0, 3), `${f0(100 * b.validFrac)} %`,
    h('span', { class: b.agree ? 'tag-ok' : b.strong ? 'tag-warn' : 'tag-bad' }, fx(b.score, 1)),
    fx(b.periodUnits, 5), f0(86 / b.periodUnits), Hreg ? fx(courseFromPeriod(b.periodUnits, Hreg, br.revealMm, br.Zu), 1) : '-',
  ]), [2, 3, 4, 5, 6, 7]));
  out.push(h('p', { class: 'lead' }, `Score colours: green = agrees, amber = strong but disagrees, red = weak. "H if 86" is without the reveal. "mm/course" is the course the strip's period implies at the chosen course's height, reveal ${br.revealMm} mm taken off: period x (H - reveal / Zu).`));
  out.push(h('h3', null, 'Flattened view (strips drawn)'));
  out.push(h('canvas', { id: 'preview', width: 600, height: 300 }));
  return out;
}

function drawPreview() {
  const canvas = $('preview');
  if (!canvas || !current || !current.geometry || !current.photo) return;
  try {
    const { quad, rect } = current.geometry;
    const woh = rect.widthOverHeight;
    const widthMm = woh * PREVIEW_HEIGHT_MM;
    const P = planeToImageFor(quad, widthMm, PREVIEW_HEIGHT_MM);
    if (!P) return;
    const img = warpToRect(current.photo.image, P, { widthMm, heightMm: PREVIEW_HEIGHT_MM, marginMm: PREVIEW_MARGIN_MM, outWidth: 600 });
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    const sx = img.width / (widthMm + 2 * PREVIEW_MARGIN_MM);
    const sy = img.height / (PREVIEW_HEIGHT_MM + 2 * PREVIEW_MARGIN_MM);
    const X = (u) => (u * PREVIEW_HEIGHT_MM + PREVIEW_MARGIN_MM) * sx;
    const Y = (v) => (v * PREVIEW_HEIGHT_MM + PREVIEW_MARGIN_MM) * sy;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(0), Y(0), X(woh) - X(0), Y(1) - Y(0));
    ctx.setLineDash([]);
    for (const b of current.brickFound.bands || []) {
      if (!b.kept) continue;
      const color = b.agree ? '46, 204, 113' : b.strong ? '241, 196, 15' : '231, 76, 60';
      ctx.fillStyle = `rgba(${color}, 0.14)`;
      ctx.strokeStyle = `rgba(${color}, 0.95)`;
      ctx.lineWidth = 1.5;
      ctx.fillRect(X(b.u0), Y(V0), X(b.u1) - X(b.u0), Y(V1) - Y(V0));
      ctx.strokeRect(X(b.u0), Y(V0), X(b.u1) - X(b.u0), Y(V1) - Y(V0));
    }
  } catch {
    // The preview is a nicety; the numbers above stand without it.
  }
}

// ---------------------------------------------------------------------------------------------------------
// Step 4: truth
// ---------------------------------------------------------------------------------------------------------

const TRUTH_FIELDS = [['t-w', 'wMm'], ['t-h', 'hMm'], ['t-reveal', 'revealMm'], ['t-courses', 'courses10Mm'], ['t-setback', 'setbackMm']];

function loadTruthInputs() {
  const id = currentDoorId();
  $('truth-door').textContent = id || '(type a door name in step 1)';
  const t = truths[id] || {};
  for (const [id, key] of TRUTH_FIELDS) $(id).value = isNum(t[key]) ? String(t[key]) : '';
  $('t-wall').value = t.wall || '';
}

function readTruthInputs() {
  const t = {};
  for (const [id, key] of TRUTH_FIELDS) {
    const raw = $(id).value;
    const v = Number(raw);
    if (raw !== '' && isNum(v)) t[key] = v;
  }
  if ($('t-wall').value) t.wall = $('t-wall').value;
  return t;
}

function onTruthChange() {
  const id = currentDoorId();
  if (!id) {
    setStatus('export-status', 'warn', 'Type a door name in step 1 first, so the tape numbers can be kept.');
    return;
  }
  truths[id] = readTruthInputs();
  store.set(STORE_TRUTH, truths);
  renderDoorIds();
  if (current) saveCurrentRow();
  renderResult();
  renderTruthErrors();
  renderSession();
}

function onDoorIdChange() {
  prefs.doorId = currentDoorId();
  savePrefs();
  loadTruthInputs();
  // The name is typed for the NEXT door while the last photo is still on screen: that photo keeps its door.
  // Only a photo given with no name at all takes the new one.
  if (current && !current.doorId && currentDoorId()) {
    current.doorId = currentDoorId();
    saveCurrentRow();
  }
  renderDoorBind();
  renderResult();
  renderTruthErrors();
  renderSession();
}

/** Under the door name: which door the photo on screen belongs to, and a button to move it on purpose. */
function renderDoorBind() {
  const box = $('door-bind');
  box.textContent = '';
  if (!current) return;
  const typed = currentDoorId();
  if (current.doorId === typed) return;
  const bind = () => {
    if (!current) return;
    current.doorId = currentDoorId();
    saveCurrentRow();
    renderDoorBind();
    renderResult();
    renderTruthErrors();
    renderSession();
  };
  box.append(notice('warn',
    `The photo on screen stays with door "${current.doorId || '(no name)'}". The next photo you give will be "${typed || '(no name)'}".`,
    typed ? h('div', null, h('button', { type: 'button', class: 'btn small secondary', onclick: safe(bind) }, `This photo is door "${typed}"`)) : null));
}

/** The "dots are on the corners" tick in step 2, for the photo on screen. */
function renderCornerCheck() {
  const box = $('corners-ok');
  const note = $('corners-ok-note');
  if (!box || !note) return;
  const src = current ? current.cornersSource : null;
  box.disabled = !current || !current.corners || src === 'default';
  box.checked = Boolean(current && src !== 'default' && current.cornersChecked);
  note.textContent = !current || !current.corners
    ? ''
    : src === 'default'
      ? 'A middle box is never counted: drag the dots onto the door.'
      : current.cornersChecked
        ? 'Counted in the session table.'
        : 'Not counted in the session table until ticked (or a dot is moved).';
}

function onCornersCheck() {
  if (!current || !current.corners || current.cornersSource === 'default') {
    renderCornerCheck();
    return;
  }
  current.cornersChecked = $('corners-ok').checked;
  renderCornerCheck();
  saveCurrentRow();
  renderResult();
  renderTruthErrors();
  renderSession();
}

function renderDoorIds() {
  const list = $('door-ids');
  list.textContent = '';
  for (const id of Object.keys(truths).sort()) list.append(h('option', { value: id }));
}

function renderTruthErrors() {
  const box = $('truth-errors');
  box.textContent = '';
  const row = currentRow();
  if (!row) return;
  const truth = truths[row.doorId] || null;
  if (!row.doorId) {
    box.append(notice('info', 'This photo has no door name: type one in step 1 and tap "This photo is door ..." to compare it with the tape.'));
    return;
  }
  if (row.doorId !== currentDoorId()) {
    box.append(notice('warn', `The photo on screen is door "${row.doorId}"; the tape boxes above are for "${currentDoorId() || '(no name)'}". The comparison below is with "${row.doorId}".`));
  }
  if (!hasTape(truth)) {
    box.append(notice('info', `No tape width and height for "${row.doorId}" yet.`));
    return;
  }
  if (!cornersConfirmed(row)) {
    box.append(notice('warn', row.cornersSource === 'default'
      ? 'Not counted in the session table: the dots are still the middle box. Move them onto the door.'
      : 'Not counted in the session table yet: tick "the 4 dots are on the corners" in step 2 (or move a dot).'));
  }
  const errors = rowErrors(row, truth);
  box.append(h('h3', null, `This photo against the tape (${truth.wMm} x ${truth.hMm} mm)`));
  box.append(table(['Method', 'W', 'H', 'W error', 'H error'], errors.filter((e) => e.estimate).map((e) => {
    if (e.estimate.gated) return [e.label, '-', '-', h('span', { class: 'tag-bad' }, reasonText(e.estimate.reason)), ''];
    return [e.label, f0(e.estimate.W), f0(e.estimate.H), `${signed(e.eW)} mm (${signed(e.eWPct, 1)} %)`, `${signed(e.eH)} mm (${signed(e.eHPct, 1)} %)`];
  }), [1, 2, 3, 4]));
  const br = row.brick;
  if (br && isNum(br.periodUnits) && isNum(br.Zu)) {
    const d = isNum(truth.revealMm) ? truth.revealMm : br.revealMm;
    const implied = courseFromPeriod(br.periodUnits, truth.hMm, d, br.Zu);
    box.append(kv([
      ['Course size the tape implies', `${fx(implied, 1)} mm (period x (H - reveal / Zu), reveal ${d} mm)`],
      ['Course size measured (10 courses / 10)', isNum(truth.courses10Mm) ? `${fx(truth.courses10Mm / 10, 1)} mm` : '-'],
    ]));
  }
}

// ---------------------------------------------------------------------------------------------------------
// Session table
// ---------------------------------------------------------------------------------------------------------

function renderSession() {
  const box = $('session');
  box.textContent = '';
  if (!rows.length) {
    box.append(h('p', { class: 'lead' }, 'No photos yet.'));
    return;
  }
  const s = sessionSummary(rows, truths);
  const R = GO_RULES;
  box.append(h('p', null, `${s.rows} photo(s) kept on this phone.`));
  box.append(h('h3', null, 'Question 1: does the MakerNote survive?'));
  box.append(table(['Route', 'Photos', 'Apple MakerNote', 'Has 0x0038', 'Usable depth'], s.routes.map((r) => [
    r.label, r.n, r.n ? `${f0(r.makerPct)} %` : '-', r.n ? `${f0(r.depthTagPct)} %` : '-', r.n ? `${f0(r.validPct)} %` : '-',
  ]), [1, 2, 3, 4]));
  box.append(h('p', { class: 'lead' }, '"In-page camera" counts only takePhoto stills (their bytes are always the ones checked); a shot where takePhoto gave nothing is a video frame, counted on its own line.'));
  box.append(h('h3', null, 'Questions 2 and 3: errors against the tape'));
  if (s.leftOut.rows) {
    const why = Object.entries(s.leftOut.bySource).map(([k, n]) => `${n} ${k === 'detected' ? 'door-finder guess(es) not ticked' : k === 'default' ? 'middle box(es)' : k === 'moved' ? 'moved but unticked' : k === 'no_corners' ? 'with no corners (not opened)' : k}`).join(', ');
    box.append(notice('info', `${s.leftOut.rows} photo(s) with a tape truth are left out because their corners were not confirmed (${why}). Tick "the 4 dots are on the corners" in step 2, or move a dot, to count a photo.`));
  }
  box.append(table(['Method', 'Photos', 'Doors', 'Gated out (photos / doors)', 'W p50 / p90', 'H p50 / p90', 'Bias W / H'], s.methods.filter((m) => m.applicable).map((m) => [
    m.label, m.applicable, m.doors, `${f0(m.gatedPct)} % / ${f0(m.doorsGatedPct)} %`,
    `${f0(m.W.p50)} / ${f0(m.W.p90)}`, `${f0(m.H.p50)} / ${f0(m.H.p90)}`, `${signed(m.W.biasMedian)} / ${signed(m.H.biasMedian)}`,
  ]), [1, 2, 3, 4, 5, 6]));
  if (!s.methods.some((m) => m.applicable)) box.append(h('p', { class: 'lead' }, 'Errors appear once a door name has a tape width and height (step 4) and a photo of it has confirmed corners.'));
  box.append(h('p', { class: 'lead' }, 'Errors in mm (|error| p50 / p90; bias is the median signed error), one value per door (the median over its photos, so one photo given through two routes counts once). Only photos with confirmed corners count. Brick rows count only doors whose wall is marked Brick in step 4.'));

  const afMethods = s.methods.filter((m) => m.kind === 'af' && m.applicable);
  if (afMethods.length) {
    box.append(h('h3', null, 'Focus distance after one scale constant per phone model'));
    box.append(table(['Method', 'Doors', 'W p50 / p90', 'H p50 / p90', 'Bias W / H'], afMethods.map((m) => [
      m.label, m.calibrated.doors, `${f0(m.calibrated.W.p50)} / ${f0(m.calibrated.W.p90)}`, `${f0(m.calibrated.H.p50)} / ${f0(m.calibrated.H.p90)}`,
      `${signed(m.calibrated.W.biasMedian)} / ${signed(m.calibrated.H.biasMedian)}`,
    ]), [1, 2, 3, 4]));
    if (s.afCalibration.byPhone.length) {
      box.append(table(['Phone', '35 mm focal', 'Doors', 'H est / tape (range / axial)', 'Implied mm per raw unit (range / axial)'], s.afCalibration.byPhone.map((p) => [
        p.phone, isNum(p.f35) ? `${p.f35} mm` : '-', p.doors, `${fx(p.ratio.range, 4)} / ${fx(p.ratio.axial, 4)}`, `${fx(p.mmPerRaw.range, 3)} / ${fx(p.mmPerRaw.axial, 3)}`,
      ]), [1, 2, 3, 4]));
    }
    box.append(h('p', { class: 'lead' }, 'Each door is divided by the median H est / tape of the OTHER doors taken with the same phone model (leave-one-door-out), which removes a constant per-model scale error; a phone with only one door has none. A tape height alone cannot tell the focal from the depth\'s unit: H is about depth / focal, and the EXIF 35 mm focal is a whole number (24 or 26 mm, up to about 2 % from rounding), so a steady ratio here may be either.'));
  }

  const g = s.go;
  box.append(h('h3', null, 'Go / no-go'));
  box.append(notice(g.af.go ? 'ok' : 'info',
    h('strong', null, `Focus distance: ${g.af.verdict}.`), ' ',
    `0x0038 survives on customer routes: ${g.af.depthSurvivesOn.map(routeLabel).join(', ') || 'none yet'}; only through Files: ${g.af.depthSurvivesOnEffort.length ? 'yes' : 'no'}. Needs a Photo Library or in-page route to keep it, and H p90 <= ${R.afHp90} mm on at least ${R.afDoors} doors (raw, or after one scale constant per phone model).`));
  box.append(notice(g.brick.go ? 'ok' : 'info',
    h('strong', null, `Bricks: ${g.brick.verdict}.`), ' ',
    `${g.brick.doorsMeasured} of ${g.brick.brickDoors} brick door(s) measured, ${g.brick.brickDoors ? `${f0(g.brick.doorsGatedPct)} %` : '-'} gated out (H p90 ${f0(g.brick.Hp90)} mm, W p90 ${f0(g.brick.Wp90)} mm); not-brick photos caught by the gates: ${g.brick.nonBrickPhotos ? `${f0(g.brick.nonBrickCaughtPct)} % of ${g.brick.nonBrickPhotos} (${g.brick.nonBrickDoors} door(s))` : 'none tested'}. Needs ${R.brickDoors} doors marked Brick, at most ${R.brickMaxGatedPct} % of them gated out, H p90 <= ${R.brickHp90} mm, W p90 <= ${R.brickWp90} mm, and every photo of ${R.nonBrickDoors}+ not-brick doors caught.`));
}

// ---------------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------------

function compactResult(row) {
  const truth = truths[row.doorId] || null;
  const reg = row.brick ? row.brick.hypotheses.find((x) => x.id === row.brick.regionId) : null;
  const pickV = (list, s) => (list ? list.find((v) => v.setbackMm === s) : null);
  return {
    kind: 'securemeasure-photo-scale-result',
    v: 1,
    at: row.at,
    ua: row.ua,
    route: row.route,
    doorId: row.doorId,
    file: row.file,
    accept: row.accept,
    capture: row.capture,
    captureNote: row.captureNote,
    captureDetail: row.captureDetail,
    metaFrom: row.metaFrom,
    decoded: row.decoded,
    container: row.container,
    camera: row.exif ? { make: row.exif.make, model: row.exif.model, software: row.exif.software, f35: row.exif.focal35, subjectArea: row.exif.subjectArea, pixelX: row.exif.pixelX, pixelY: row.exif.pixelY, orientation: row.exif.orientation } : null,
    makerNote: { present: row.maker.present, apple: row.maker.apple, reason: row.maker.reason, tags: row.maker.tags.length, tagIds: row.maker.tags.map((t) => t.tag).join(' '), afDepthRaw: row.maker.afDepthRaw, afConfidence: row.maker.afConfidence, accel: row.maker.accel },
    afReading: row.afReading,
    corners: row.corners,
    cornersSource: row.cornersSource,
    cornersChecked: row.cornersChecked,
    countedInSession: hasTape(truth) && cornersConfirmed(row),
    aspectHW: row.aspectHW,
    focal: row.focal,
    afPoint: row.afPoint,
    af: row.af ? {
      inside: row.af.inside, Zu: row.af.Zu, setbackMm: row.af.setbackMm,
      range: pickV(row.af.variants.range, row.af.setbackMm), axial: pickV(row.af.variants.axial, row.af.setbackMm),
      gravityBest: row.af.gravity ? { mapping: row.af.gravity.best.mapping, angleDeg: row.af.gravity.best.angleToDoorDeg } : null,
      fromCentrePx: row.af.fromCentrePx,
      atImageCentre: row.af.centre,
    } : null,
    brick: row.brick ? {
      found: row.brick.found, nAgree: row.brick.nAgree, bestScore: row.brick.bestScore, periodUnits: row.brick.periodUnits,
      agreeLRPct: row.brick.agreeLRPct, agreeTBPct: row.brick.agreeTBPct, Zu: row.brick.Zu, region: row.brick.regionId,
      revealMm: row.brick.revealMm, H: reg ? reg.H : null, W: reg ? reg.W : null, Hraw: reg ? reg.Hraw : null, gate: reg ? reg.gate : row.brick.checks,
    } : null,
    catalogue: row.catalogue,
    truth,
    errors: hasTape(truth) ? rowErrors(row, truth).filter((e) => e.estimate).map((e) => (e.estimate.gated ? { id: e.id, gated: e.estimate.reason } : { id: e.id, eW: e.eW, eH: e.eH })) : null,
    afCheck: afCheck(row, truth),
    timings: row.timings,
  };
}

/**
 * For pooling per phone model: H est / H tape and the mm per raw unit the tape implies, for both depth
 * models. The focal and the depth unit cannot be told apart from these alone.
 */
function afCheck(row, truth) {
  if (!hasTape(truth) || !row.af || !row.af.valid || !row.af.inside) return null;
  const errors = Object.fromEntries(rowErrors(row, truth).map((e) => [e.id, e]));
  const ratio = (id) => (errors[id] && errors[id].estimate && !errors[id].estimate.gated ? errors[id].estimate.H / truth.hMm : null);
  return {
    phone: phoneOf(row),
    f35: row.exif ? row.exif.focal35 : null,
    focalSource: row.focal ? row.focal.source : null,
    hRatio: { range: ratio('af_range'), axial: ratio('af_axial') },
    impliedMmPerRaw: { range: afImpliedUnit(row, truth, 'range'), axial: afImpliedUnit(row, truth, 'axial') },
  };
}

function sessionExport() {
  return {
    kind: 'securemeasure-photo-scale-session',
    v: 1,
    exportedAt: new Date().toISOString(),
    ua: navigator.userAgent,
    summary: sessionSummary(rows, truths),
    truth: truths,
    rows,
  };
}

function resultExport() {
  const row = currentRow();
  if (!row) return null;
  const out = { ...compactResult(row), full: row };
  if ($('include-photo').checked && current && current.photo) {
    try {
      out.photoJpeg = photoToJpegDataUrl(current.photo, 1024, 0.7);
    } catch {
      out.photoJpeg = null;
    }
  }
  return out;
}

function showFallback(text) {
  const area = $('copy-fallback');
  area.hidden = false;
  area.value = text;
  area.focus();
  area.select();
}

function copyText(text, what) {
  const done = () => setStatus('export-status', 'ok', `${what} copied (${Math.round(text.length / 1024)} KB). Paste it into a message or note.`);
  const fallback = () => {
    try {
      const area = $('copy-fallback');
      area.hidden = false;
      area.value = text;
      area.select();
      area.setSelectionRange(0, text.length);
      if (document.execCommand && document.execCommand('copy')) {
        done();
        return;
      }
    } catch {
      // fall through to manual copy
    }
    showFallback(text);
    setStatus('export-status', 'warn', 'Copying was blocked: the text is in the box below. Select it all and copy.');
  };
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done, fallback);
      return;
    }
  } catch {
    // fall back below
  }
  fallback();
}

function fileName(kind) {
  return `photo-scale-${kind}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
}

function download(text, name) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStatus('export-status', 'ok', `Saved ${name}. On iPhone it is in Files > Downloads.`);
}

function onCopyResult() {
  const row = currentRow();
  if (!row) {
    setStatus('export-status', 'warn', 'No photo yet: give a photo in step 1 first.');
    return;
  }
  const out = compactResult(row);
  if ($('include-photo').checked && current && current.photo) {
    try {
      out.photoJpeg = photoToJpegDataUrl(current.photo, 1024, 0.7);
    } catch {
      out.photoJpeg = null;
    }
  }
  copyText(compactJson(out), 'Result');
}

function onCopySession() {
  if (!rows.length) {
    setStatus('export-status', 'warn', 'The session is empty.');
    return;
  }
  copyText(compactJson(sessionExport()), 'Session');
}

function exportPayload() {
  const result = resultExport();
  return result ? { ...sessionExport(), current: result } : sessionExport();
}

function onDownload() {
  if (!rows.length) {
    setStatus('export-status', 'warn', 'Nothing to save yet.');
    return;
  }
  download(compactJson(exportPayload(), 1), fileName('session'));
}

async function onShare() {
  if (!rows.length) {
    setStatus('export-status', 'warn', 'Nothing to share yet.');
    return;
  }
  const text = compactJson(exportPayload(), 1);
  const name = fileName('session');
  try {
    if (typeof File === 'function' && navigator.canShare) {
      const file = new File([text], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Photo scale lab results' });
        setStatus('export-status', 'ok', 'Shared.');
        return;
      }
    }
    if (navigator.share && text.length < 60000) {
      await navigator.share({ title: 'Photo scale lab results', text });
      setStatus('export-status', 'ok', 'Shared as text.');
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      setStatus('export-status', 'info', 'Sharing was cancelled.');
      return;
    }
  }
  download(text, name);
}

function onClearSession() {
  // A plain confirm: this deletes the saved rows and tape numbers on this phone only.
  if (!window.confirm('Delete every saved photo row and tape number from this phone? This cannot be undone.')) return;
  rows = [];
  truths = {};
  store.remove(STORE_ROWS);
  store.remove(STORE_TRUTH);
  renderDoorIds();
  loadTruthInputs();
  if (current) saveCurrentRow();
  renderSession();
  renderTruthErrors();
  setStatus('export-status', 'ok', 'Session cleared.');
}

// ---------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------

/** Every handler goes through this: nothing may throw to the page. */
function safe(fn) {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch((e) => setStatus('load-status', 'bad', `Something went wrong: ${e && e.message ? e.message : e}. Try again.`));
    } catch (e) {
      setStatus('load-status', 'bad', `Something went wrong: ${e && e.message ? e.message : e}. Try again.`);
    }
  };
}

function init() {
  const region = $('region');
  for (const c of COURSES) region.append(h('option', { value: c.id }, `${c.label} mm`));
  if (prefs.route && [...$('route').options].some((o) => o.value === prefs.route)) $('route').value = prefs.route;
  if (prefs.region && COURSES.some((c) => c.id === prefs.region)) region.value = prefs.region;
  if (isNum(prefs.setbackMm)) $('setback').value = String(prefs.setbackMm);
  if (isNum(prefs.revealSlider)) $('reveal-slider').value = String(prefs.revealSlider);
  if (prefs.revealChoice) {
    const radio = document.querySelector(`input[name="reveal"][value="${prefs.revealChoice}"]`);
    if (radio) radio.checked = true;
  }
  $('reveal-typed-out').textContent = $('reveal-slider').value;
  if (typeof prefs.doorId === 'string') $('door-id').value = prefs.doorId;

  $('route').addEventListener('change', safe(() => {
    prefs.route = currentRoute();
    savePrefs();
    renderRouteHelp();
  }));
  $('file').addEventListener('change', safe(async (e) => {
    const input = e.target;
    const file = input.files && input.files[0];
    const accept = input.hasAttribute('accept') ? input.getAttribute('accept') : null;
    input.value = '';
    if (!file) return;
    await handlePhoto(file, { route: currentRoute(), capture: 'file', accept });
  }));
  $('cam-start').addEventListener('click', safe(onCamStart));
  $('cam-shoot').addEventListener('click', safe(onCamShoot));
  $('cam-stop').addEventListener('click', safe(() => {
    stopCam();
    setStatus('load-status', 'info', 'Camera off.');
  }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCam();
  });

  $('corners-detected').addEventListener('click', safe(() => {
    if (!current || !current.detectedQuad) return;
    current.corners = current.detectedQuad.map((p) => ({ ...p }));
    current.cornersSource = current.detection && current.detection.ok ? 'detected' : 'default';
    // New dots: they are not checked until the tester says so again.
    current.cornersChecked = false;
    editor.setPoints(current.corners);
    renderCornerCheck();
    measure();
  }));
  $('corners-default').addEventListener('click', safe(() => {
    if (!current || !current.photo) return;
    current.corners = startingQuad(current.photo, null);
    current.cornersSource = 'default';
    current.cornersChecked = false;
    editor.setPoints(current.corners);
    renderCornerCheck();
    measure();
  }));
  $('corners-ok').addEventListener('change', safe(onCornersCheck));

  const onSettings = safe(() => {
    const st = readSettings();
    prefs.region = st.region;
    prefs.setbackMm = st.setbackMm;
    prefs.revealChoice = st.revealChoice;
    prefs.revealSlider = Number($('reveal-slider').value);
    savePrefs();
    $('reveal-typed-out').textContent = $('reveal-slider').value;
    recompute();
  });
  for (const radio of document.querySelectorAll('input[name="reveal"]')) radio.addEventListener('change', onSettings);
  $('reveal-slider').addEventListener('input', safe(() => {
    const typed = document.querySelector('input[name="reveal"][value="typed"]');
    if (typed) typed.checked = true;
    onSettings();
  }));
  $('setback').addEventListener('change', onSettings);
  $('region').addEventListener('change', onSettings);
  $('measure').addEventListener('click', safe(() => {
    if (!current || !current.photo) {
      setStatus('measure-status', 'warn', 'Give a photo in step 1 first.');
      return;
    }
    measure();
  }));

  $('door-id').addEventListener('change', safe(onDoorIdChange));
  for (const [id] of TRUTH_FIELDS) $(id).addEventListener('change', safe(onTruthChange));
  $('t-wall').addEventListener('change', safe(onTruthChange));

  $('copy-result').addEventListener('click', safe(onCopyResult));
  $('copy-session').addEventListener('click', safe(onCopySession));
  $('download').addEventListener('click', safe(onDownload));
  $('share').addEventListener('click', safe(onShare));
  $('clear-session').addEventListener('click', safe(onClearSession));

  window.addEventListener('error', (e) => setStatus('load-status', 'bad', `Something went wrong: ${e.message || 'error'}.`));
  window.addEventListener('unhandledrejection', (e) => setStatus('load-status', 'bad', `Something went wrong: ${(e.reason && e.reason.message) || 'error'}.`));

  renderRouteHelp();
  renderDoorIds();
  loadTruthInputs();
  renderSession();
}

try {
  init();
} catch (e) {
  setStatus('load-status', 'bad', `The page did not start: ${e && e.message ? e.message : e}.`);
}

// For debugging in the browser console only.
globalThis.__photoScaleLab = { get current() { return current; }, get rows() { return rows; }, clone };
