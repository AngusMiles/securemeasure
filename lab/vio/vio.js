/**
 * Lab page: can a web page measure a door in millimetres from a short left-right slide of the phone?
 * (visual-inertial scale: tracked door corners in the live video + devicemotion). Main thread: UI, capture,
 * logging. Detection and tracking run in track-worker.js; the maths is in solver.js, motion.js, camheight.js
 * and stats.js. Nothing is uploaded: the log stays on the phone until the tester copies, downloads or shares it.
 *
 * iOS Safari rules this file follows (research Nov 2026):
 *  - DeviceMotionEvent.requestPermission() and getUserMedia() are both started inside the tap, before any
 *    await; a refusal is remembered until Safari is fully closed.
 *  - Motion events arrive only while the page is visible: a hidden page aborts the run.
 *  - Event.timeStamp (1 ms) is set when the event is created on the main thread, so the main thread stays
 *    light: no tracking here, UI updates at <= 10 Hz, no layout changes while recording.
 *  - takePhoto() reconfigures the camera, so the lens check runs before (never during) a run.
 */
import { startCamera, stopCamera, capturePhoto, guideRect, coverMapping, priorFromGuide, cameraErrorKind } from '../../js/camera.js';
import { rectifyRectangle, PHONE_DEFAULT_F35 } from '../../js/estimate.js';
import { readJpegInfo } from '../../js/photo.js';
import { solveWith, focalPxForFrame, DEFAULT_SETTINGS, phaseWindow, median, MAPPING_MIN_RATIO } from './solver.js';
import { normaliseMotion, applyGyroMapping, parseGyroMapping, noiseFloor, tapSyncOffsets, MOTION_COLUMNS } from './motion.js';
import { cameraHeightPanel, cameraHeightInputs } from './camheight.js';
import { runSummary, sessionTable, gateText, GATE_TEXT, catalogueCompare, frameStats, osVersionFromUA, exportResults } from './stats.js';

const PAGE_VERSION = 'lab-vio 1 (2026-11-20)';
const TRACK_LONG = 960; // long side of the image the worker tracks (720 x 960 portrait)
const MOTION_CAP = 12000; // 60 s at up to 200 Hz
const FRAME_CAP = 4000; // 60 s at up to 66 fps
const CAP_MS = 60000;
const STILL_DEG_S = 3;
const STILL_MS = 1000;
const SWEEP_GOOD_S = 7;
const ROTATE_GOOD_S = 6;
const STILL10_GOOD_S = 10;
const TAP_WAIT_MS = 5000;
const TAP_JUMP_MS2 = 3; // change of the specific-force vector between two events that counts as a tap
const LOST_RUN = 5;
const UI_MS = 100;
const TILT_PAUSE_DEG = 25;
const FPS_WARN = 15;
const SLOW_STRIDE_MS = 30;
const STORE_FORM = 'sm-lab-vio-form-v1';
const STORE_SESSION = 'sm-lab-vio-session-v1';

const MODES = {
  sweep: { label: 'Sweep', phases: ['still1', 'sweep', 'still2'] },
  rotate: { label: 'Rotate-only', phases: ['still1', 'rotate', 'still2'] },
  still: { label: 'Still 10 s', phases: ['still10'] },
  tapsync: { label: 'Tap-sync', phases: ['still1', 'tap1', 'sweep', 'still2', 'tap2', 'settle'] },
};
const STEP_TEXT = {
  framing: 'Stand 2 to 2.5 m back. Hold the phone upright and fit the whole door inside the white frame.',
  manual: 'Tap the 4 corners of the door opening: top-left, top-right, bottom-right, bottom-left.',
  still1: 'Hold still',
  still2: 'Stop. Hold still',
  settle: 'Hold still',
  sweep: 'Slide the phone left and right, about a hand-width, keeping it pointing straight at the door',
  rotate: 'Keep your feet and hands in place. Turn the phone slowly left-right and up-down, about 10 degrees',
  still10: 'Hold the phone completely still (or brace it against a post)',
  tap1: 'Tap the side of the phone sharply, once',
  tap2: 'Tap the side of the phone sharply again, once',
  lens: 'Point the camera at anything. Taking one photo to read the lens...',
  starting: 'Checking the door outline on the live picture. Hold still...',
  solving: 'Working it out...',
  opening: 'Opening the camera and motion sensors...',
};

// ------------------------------------------------------------------------------------------------ storage
const store = {
  get(key, fallback) {
    try {
      const v = globalThis.localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
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
      // storage blocked: nothing to remove
    }
  },
};

// ------------------------------------------------------------------------------------------------ DOM
const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'),
  overlay: $('overlay'),
  cap: $('cap'),
  hudStep: $('hud-step'),
  hudHint: $('hud-hint'),
  hudStat: $('hud-stat'),
  bYes: $('b-yes'),
  bNext: $('b-next'),
  bTaps: $('b-taps'),
  bCancel: $('b-cancel'),
  bPlay: $('b-play'),
  bStart: $('b-start'),
  bLens: $('b-lens'),
  startMsg: $('start-msg'),
  lensOut: $('lens-out'),
  result: $('result'),
  resultBody: $('result-body'),
  session: $('session-body'),
  support: $('support'),
};
const FORM_IDS = ['f-door', 'f-tapew', 'f-tapeh', 'f-phone', 'f-ios', 'f-lens', 'f-sill', 'f-stature'];
const CHECK_IDS = ['f-heights', 'f-pacing', 'f-video'];

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}
const num = (v) => (typeof v === 'number' ? v : NaN);
const fx = (v, d = 1, unit = '') => (Number.isFinite(v) ? `${v.toFixed(d)}${unit ? ` ${unit}` : ''}` : 'n/a');
const sgn = (v, d = 1, unit = '') => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}${unit ? ` ${unit}` : ''}` : 'n/a');
const RAD2DEG = 180 / Math.PI;

function readForm() {
  const val = (id) => ($(id) ? $(id).value.trim() : '');
  const n = (id) => {
    const v = parseFloat(val(id).replace(',', '.'));
    return Number.isFinite(v) ? v : NaN;
  };
  const modeInput = document.querySelector('input[name="mode"]:checked');
  return {
    doorId: val('f-door'),
    tapeW: n('f-tapew'),
    tapeH: n('f-tapeh'),
    phone: val('f-phone'),
    ios: val('f-ios'),
    lensHeight: n('f-lens'),
    sillOffset: n('f-sill'),
    stature: n('f-stature'),
    includeHeights: Boolean($('f-heights') && $('f-heights').checked),
    pacing: Boolean($('f-pacing') && $('f-pacing').checked),
    recordVideo: Boolean($('f-video') && $('f-video').checked),
    mode: modeInput && MODES[modeInput.value] ? modeInput.value : 'sweep',
  };
}
function saveForm() {
  const data = {};
  for (const id of FORM_IDS) if ($(id)) data[id] = $(id).value;
  for (const id of CHECK_IDS) if ($(id)) data[id] = $(id).checked;
  const m = document.querySelector('input[name="mode"]:checked');
  if (m) data.mode = m.value;
  store.set(STORE_FORM, data);
}
function loadForm() {
  const data = store.get(STORE_FORM, {}) || {};
  for (const id of FORM_IDS) if ($(id) && typeof data[id] === 'string') $(id).value = data[id];
  for (const id of CHECK_IDS) if ($(id) && typeof data[id] === 'boolean') $(id).checked = data[id];
  if (data.mode && MODES[data.mode]) {
    const r = document.querySelector(`input[name="mode"][value="${data.mode}"]`);
    if (r) r.checked = true;
  }
  if ($('f-ios') && !$('f-ios').value) {
    const v = osVersionFromUA(navigator.userAgent || '');
    if (v) $('f-ios').value = v;
  }
}

// ------------------------------------------------------------------------------------------------ state
const S = {
  phase: 'idle', // idle | opening | lens | framing | manual | starting | run | solving
  flow: null, // 'run' | 'lens'
  stream: null,
  track: null,
  worker: null,
  workerReady: false,
  workerBusy: false,
  workerError: null,
  motionPermission: 'not asked',
  motionListening: false,
  motionBlocked: false,
  audio: null,
  wakeLock: null,
  lens: { f35: null, source: 'prior', note: 'not checked' },
  live: makeLive(),
  rec: null,
  run: null,
  detect: null,
  manual: null,
  frameLoop: false,
  rvfc: null,
  uiTimer: null,
  trackCanvas: null,
  trackCtx: null,
  trackW: 0,
  trackH: 0,
  pending: new Map(),
  lastLog: null,
  lastResults: null,
  lastSummary: null,
  lastVideo: null,
  recorder: null,
  session: [],
};

function makeLive() {
  return {
    count: 0,
    firstAt: 0,
    lastAt: 0,
    lastMoveAt: 0,
    lastTapAt: 0,
    gyroNorm: 0,
    accG: [NaN, NaN, NaN],
    lastG: [NaN, NaN, NaN],
    frames: 0,
    framesAt: 0,
    fps: NaN,
    hz: NaN,
    hzCount: 0,
    hzAt: 0,
    // 2 s ring of horizontal motion for the sweep hints (device x of the specific force, gyro norm)
    ringT: new Float64Array(256),
    ringAx: new Float64Array(256),
    ringGyro: new Float64Array(256),
    ringN: 0,
  };
}

function makeRecorder() {
  const m = {};
  for (const k of MOTION_COLUMNS) m[k] = new Float64Array(MOTION_CAP);
  const f = {};
  for (const k of ['now', 'captureTime', 'presentationTime', 'expectedDisplayTime', 'presentedFrames', 'mediaTime', 'width', 'height']) f[k] = new Float64Array(FRAME_CAP);
  f.status = new Int8Array(FRAME_CAP).fill(3);
  return {
    on: false,
    t0: 0,
    mN: 0,
    m,
    fN: 0,
    f,
    tq: new Float64Array(FRAME_CAP * 8).fill(NaN),
    tok: new Int8Array(FRAME_CAP),
    tflag: new Int8Array(FRAME_CAP),
    treplied: new Int8Array(FRAME_CAP),
    tms: new Float64Array(FRAME_CAP).fill(NaN),
    tjump: new Float64Array(FRAME_CAP).fill(NaN),
    phases: [],
    notes: [],
  };
}

// ------------------------------------------------------------------------------------------------ motion
function onMotion(e) {
  const now = performance.now();
  const L = S.live;
  const a = e.acceleration || {};
  const g = e.accelerationIncludingGravity || {};
  const r = e.rotationRate || {};
  const gx = num(g.x);
  const gy = num(g.y);
  const gz = num(g.z);
  const ra = num(r.alpha);
  const rb = num(r.beta);
  const rg = num(r.gamma);
  if (!L.count) L.firstAt = now;
  L.count++;
  L.hzCount++;
  L.lastAt = now;
  const norm = Math.hypot(ra, rb, rg);
  L.gyroNorm = norm;
  if (!(norm < STILL_DEG_S)) L.lastMoveAt = now;
  L.accG[0] = gx;
  L.accG[1] = gy;
  L.accG[2] = gz;
  if (Math.hypot(gx - L.lastG[0], gy - L.lastG[1], gz - L.lastG[2]) > TAP_JUMP_MS2) L.lastTapAt = now;
  L.lastG = [gx, gy, gz];
  const k = L.ringN++ & 255;
  L.ringT[k] = now;
  L.ringAx[k] = gx;
  L.ringGyro[k] = norm;
  const R = S.rec;
  if (R && R.on && R.mN < MOTION_CAP) {
    const i = R.mN++;
    const m = R.m;
    m.timeStamp[i] = e.timeStamp;
    m.now[i] = now;
    m.interval[i] = num(e.interval);
    m.ax[i] = num(a.x);
    m.ay[i] = num(a.y);
    m.az[i] = num(a.z);
    m.gx[i] = gx;
    m.gy[i] = gy;
    m.gz[i] = gz;
    m.alpha[i] = ra;
    m.beta[i] = rb;
    m.gamma[i] = rg;
  }
}

/** Tilt of the phone from upright portrait (deg), from the latest gravity; NaN without motion data. */
function liveTiltDeg() {
  const g = S.live.accG;
  const n = Math.hypot(g[0], g[1], g[2]);
  return n > 0 ? Math.acos(Math.min(1, Math.abs(g[1]) / n)) * RAD2DEG : NaN;
}
function motionAvailable() {
  return S.live.count > 0 && performance.now() - S.live.lastAt < 500;
}
/** RMS of the high-passed device-x specific force and the mean gyro norm over the last `ms`. */
function recentMotion(ms) {
  const L = S.live;
  const now = performance.now();
  const n = Math.min(L.ringN, 256);
  const xs = [];
  let gsum = 0;
  for (let j = 0; j < n; j++) {
    const k = (L.ringN - 1 - j) & 255;
    if (now - L.ringT[k] > ms) break;
    xs.push(L.ringAx[k]);
    gsum += L.ringGyro[k];
  }
  if (xs.length < 5) return { axRms: NaN, gyroMean: NaN };
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { axRms: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length), gyroMean: gsum / xs.length };
}
function orientationType() {
  try {
    if (globalThis.screen && screen.orientation && screen.orientation.type) return screen.orientation.type;
  } catch {
    // older iOS: fall through
  }
  const o = num(globalThis.orientation);
  if (Number.isFinite(o)) return Math.abs(o) === 90 ? 'landscape' : 'portrait';
  return globalThis.innerWidth > globalThis.innerHeight ? 'landscape' : 'portrait';
}

// ------------------------------------------------------------------------------------------------ worker
function startWorker() {
  try {
    const w = new Worker(new URL('./track-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = onWorkerMessage;
    w.onerror = (ev) => {
      S.workerError = (ev && ev.message) || 'the tracking worker failed to load (module workers need iOS 15 or newer)';
      S.workerBusy = false;
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      renderSupport();
    };
    S.worker = w;
  } catch (err) {
    S.workerError = `the tracking worker could not start: ${(err && err.message) || err}`;
    renderSupport();
  }
}
function onWorkerMessage(ev) {
  const m = ev.data || {};
  if (m.type === 'ready') {
    S.workerReady = true;
    renderSupport();
    return;
  }
  if (m.type === 'detect') {
    S.workerBusy = false;
    onDetectReply(m);
    return;
  }
  if (m.type === 'track') {
    S.workerBusy = false;
    onTrackReply(m);
    return;
  }
  const waiter = S.pending.get(m.type);
  if (waiter) {
    S.pending.delete(m.type);
    waiter(m);
  }
}
/** Post a message (transferring `transfer`) and wait for the reply of `type` (or null after timeoutMs). */
function workerRequest(msg, type, timeoutMs, transfer = []) {
  return new Promise((resolve) => {
    if (!S.worker) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      S.pending.delete(type);
      resolve(null);
    }, timeoutMs);
    S.pending.set(type, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    S.worker.postMessage(msg, transfer);
  });
}

// ------------------------------------------------------------------------------------------------ frames
function trackSizeFor(vw, vh) {
  const s = TRACK_LONG / Math.max(vw, vh);
  return { w: Math.round(vw * s), h: Math.round(vh * s) };
}
/** The current video frame at track size as RGBA (main thread: drawImage + getImageData only). */
function grabTrackImage() {
  const v = els.video;
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!(vw > 0 && vh > 0)) return null;
  const { w, h } = trackSizeFor(vw, vh);
  if (!S.trackCanvas) {
    S.trackCanvas = document.createElement('canvas');
    S.trackCtx = S.trackCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (S.trackCanvas.width !== w || S.trackCanvas.height !== h) {
    S.trackCanvas.width = w;
    S.trackCanvas.height = h;
  }
  S.trackW = w;
  S.trackH = h;
  try {
    S.trackCtx.drawImage(v, 0, 0, w, h);
    const img = S.trackCtx.getImageData(0, 0, w, h);
    return { data: img.data, width: w, height: h };
  } catch {
    return null;
  }
}
// Each loop carries its generation: a callback still pending from an earlier loop (Cancel during framing
// stops the stream at once, so its last requestVideoFrameCallback may not fire until a new stream attaches)
// sees an old generation and ends, instead of running alongside the new loop and logging every frame twice.
// The pending handle is also cancelled where the browser allows it.
let loopGen = 0;
let loopHandle = null;
function startFrameLoop() {
  const v = els.video;
  stopFrameLoop();
  S.frameLoop = true;
  const gen = ++loopGen;
  S.rvfc = typeof v.requestVideoFrameCallback === 'function';
  if (S.rvfc) loopHandle = v.requestVideoFrameCallback((t, md) => onVideoFrame(gen, t, md));
  else loopHandle = requestAnimationFrame((t) => onAnimationFrame(gen, t));
}
function stopFrameLoop() {
  S.frameLoop = false;
  loopGen++;
  if (loopHandle !== null) {
    try {
      if (S.rvfc && typeof els.video.cancelVideoFrameCallback === 'function') els.video.cancelVideoFrameCallback(loopHandle);
      else if (!S.rvfc) cancelAnimationFrame(loopHandle);
    } catch {
      // the generation check still ends it
    }
  }
  loopHandle = null;
}
function onVideoFrame(gen, nowTs, md) {
  if (!S.frameLoop || gen !== loopGen) return;
  loopHandle = els.video.requestVideoFrameCallback((t, m) => onVideoFrame(gen, t, m));
  handleFrame(nowTs, md || {});
}
let lastMediaTime = -1;
function onAnimationFrame(gen, ts) {
  if (!S.frameLoop || gen !== loopGen) return;
  loopHandle = requestAnimationFrame((t) => onAnimationFrame(gen, t));
  const v = els.video;
  if (v.currentTime === lastMediaTime) return;
  lastMediaTime = v.currentTime;
  handleFrame(ts, { presentationTime: ts, mediaTime: v.currentTime, width: v.videoWidth, height: v.videoHeight });
}
function handleFrame(nowTs, md) {
  S.live.frames++;
  if (S.phase === 'framing') {
    maybeDetect();
    return;
  }
  if (S.phase !== 'run') return;
  const R = S.rec;
  if (!R || !R.on || R.fN >= FRAME_CAP) return;
  const i = R.fN++;
  const f = R.f;
  f.now[i] = nowTs;
  f.captureTime[i] = num(md.captureTime);
  f.presentationTime[i] = num(md.presentationTime);
  f.expectedDisplayTime[i] = num(md.expectedDisplayTime);
  f.presentedFrames[i] = num(md.presentedFrames);
  f.mediaTime[i] = num(md.mediaTime);
  f.width[i] = num(md.width);
  f.height[i] = num(md.height);
  const v = els.video;
  if (v.videoWidth !== S.run.videoSize.w || v.videoHeight !== S.run.videoSize.h) {
    S.run.sizeChanged = true;
    return;
  }
  // Stride on the frame's own parity (not on a count of posted frames, which a busy-skip does not advance:
  // that gave 0, 3, 6... = 10 fps instead of 15).
  if (S.run.stride === 2 && i % 2 === 1) {
    f.status[i] = 2;
    return;
  }
  if (S.workerBusy) {
    f.status[i] = 1; // skipped: never queue frames
    return;
  }
  const img = grabTrackImage();
  if (!img) return;
  f.status[i] = 0;
  S.workerBusy = true;
  // The frame time lets the worker scale its constant-velocity step when frames are skipped unevenly.
  const t = Number.isFinite(f.captureTime[i]) ? f.captureTime[i] : Number.isFinite(f.presentationTime[i]) ? f.presentationTime[i] : nowTs;
  S.worker.postMessage({ type: 'track', frameIndex: i, image: img, t }, [img.data.buffer]);
}

function onTrackReply(m) {
  const R = S.rec;
  const i = m.frameIndex;
  if (!R || !(i >= 0 && i < R.fN)) return;
  R.treplied[i] = 1;
  R.tok[i] = m.ok ? 1 : 0;
  R.tflag[i] = m.flagged ? 1 : 0;
  R.tms[i] = num(m.ms);
  R.tjump[i] = num(m.jumpPx);
  if (m.quad)
    for (let c = 0; c < 4; c++) {
      R.tq[8 * i + 2 * c] = m.quad[c].x;
      R.tq[8 * i + 2 * c + 1] = m.quad[c].y;
    }
  const run = S.run;
  if (S.phase !== 'run' || !run) return;
  run.msRecent.push(num(m.ms));
  if (run.stride === 1 && run.msRecent.length >= 15) {
    const p = median(run.msRecent.slice(-30));
    if (p > SLOW_STRIDE_MS) {
      run.stride = 2;
      R.notes.push({ t: performance.now(), note: `tracker p50 ${p.toFixed(1)} ms > ${SLOW_STRIDE_MS} ms: processing every second frame` });
    }
  }
  const now = performance.now();
  if (m.flagged) {
    run.flaggedRun++;
    if (run.flaggedRun >= LOST_RUN) {
      // Lost after the motion phase is complete (the final hold, or the Tap-sync tap): the sweep is all there,
      // so the run simply ends here. Lost earlier: abort, keeping the stats.
      const motionLeft = run.phaseNames.slice(run.phaseIdx).some((p) => p === 'sweep' || p === 'rotate' || p === 'still10');
      if (motionLeft) finishRun('door_lost');
      else {
        R.notes.push({ t: now, note: `door lost during ${currentPhase()}: the run ended there` });
        finishRun(null);
      }
    }
    return;
  }
  run.flaggedRun = 0;
  if (!m.quad) return;
  run.lastQuad = m.quad;
  const cx = (m.quad[0].x + m.quad[1].x + m.quad[2].x + m.quad[3].x) / 4;
  const cy = (m.quad[0].y + m.quad[1].y + m.quad[2].y + m.quad[3].y) / 4;
  run.centres.push({ t: now, x: cx, y: cy });
  if (run.centres.length > 90) run.centres.shift();
  const ph = currentPhase();
  if ((ph === 'sweep' || ph === 'rotate' || ph === 'still10') && !run.paused) {
    if (run.lastGoodAt) run.goodS += Math.min(0.1, (now - run.lastGoodAt) / 1000);
    run.lastGoodAt = now;
  } else run.lastGoodAt = 0;
}

// ------------------------------------------------------------------------------------------------ detection
function viewSize() {
  return { w: els.video.clientWidth || globalThis.innerWidth, h: els.video.clientHeight || globalThis.innerHeight };
}
function currentFocalPx(w, h) {
  return focalPxForFrame(S.lens.f35 || PHONE_DEFAULT_F35, w, h).focalPx;
}
function maybeDetect() {
  const D = S.detect;
  if (!D || D.frozen || S.workerBusy || !S.workerReady) return;
  const now = performance.now();
  if (now - D.lastPostAt < 350) return;
  const img = grabTrackImage();
  if (!img) return;
  const v = els.video;
  const view = viewSize();
  const prior = priorFromGuide({ guide: guideRect(view.w, view.h), viewW: view.w, viewH: view.h, videoW: v.videoWidth, videoH: v.videoHeight, photoW: img.width, photoH: img.height });
  D.lastPostAt = now;
  D.posted++;
  S.workerBusy = true;
  S.worker.postMessage({ type: 'detect', id: D.posted, image: img, prior, focalPx: currentFocalPx(img.width, img.height) }, [img.data.buffer]);
}
function onDetectReply(m) {
  const D = S.detect;
  if (S.phase !== 'framing' || !D || D.frozen) return;
  D.last = m;
  D.ms = m.ms;
  if (m.ok && m.options && m.options.length) {
    D.options = m.options;
    D.idx = 0;
    D.found = true;
    D.trackSize = { w: S.trackW, h: S.trackH };
  } else D.failures++;
  updateButtons();
}

// ------------------------------------------------------------------------------------------------ flow
function setHud(step, hint = '', stat) {
  if (els.hudStep.textContent !== step) els.hudStep.textContent = step;
  if (els.hudHint.textContent !== hint) els.hudHint.textContent = hint;
  if (stat !== undefined && els.hudStat.textContent !== stat) els.hudStat.textContent = stat;
}
function showButtons(map) {
  for (const [b, state] of [[els.bYes, map.yes], [els.bNext, map.next], [els.bTaps, map.taps], [els.bCancel, map.cancel], [els.bPlay, map.play]]) {
    if (!b) continue;
    b.hidden = !state;
    if (state && typeof state === 'object') {
      if (state.text && b.textContent !== state.text) b.textContent = state.text;
      b.disabled = Boolean(state.disabled);
    } else b.disabled = false;
  }
}
function updateButtons() {
  if (S.phase === 'framing') {
    const D = S.detect;
    const has = D && D.options.length > 0;
    showButtons({
      yes: { text: "Yes, that's the door", disabled: !has },
      next: { text: 'Not right', disabled: !has },
      taps: { text: 'Tap the corners' },
      cancel: { text: 'Cancel' },
      play: S.needPlay ? { text: 'Start the camera' } : null,
    });
  } else if (S.phase === 'manual') {
    const n = S.manual ? S.manual.points.length : 0;
    showButtons({ yes: { text: 'Use these corners', disabled: n < 4 }, next: { text: 'Undo last tap', disabled: n === 0 }, cancel: { text: 'Cancel' } });
  } else if (S.phase === 'run') showButtons({ cancel: { text: 'Stop' } });
  else if (S.phase === 'lens' || S.phase === 'opening' || S.phase === 'starting') showButtons({ cancel: { text: 'Cancel' } });
  else showButtons({});
}

/**
 * Open the motion sensors and the camera. MUST be the first thing a tap handler does: requestPermission()
 * and getUserMedia() (inside startCamera) both start before anything is awaited.
 */
function openSensors() {
  const DME = globalThis.DeviceMotionEvent;
  let p1;
  try {
    p1 = typeof DME !== 'undefined' && typeof DME.requestPermission === 'function' ? DME.requestPermission() : Promise.resolve(typeof DME === 'undefined' ? 'unsupported' : 'granted');
  } catch (err) {
    p1 = Promise.reject(err);
  }
  els.cap.hidden = false;
  document.body.classList.add('capturing');
  const p2 = startCamera(els.video);
  try {
    if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function')
      navigator.wakeLock.request('screen').then(
        (l) => (S.wakeLock = l),
        () => {},
      );
  } catch {
    // no wake lock on this browser: the screen may dim during a long run
  }
  if (readForm().pacing) {
    // The pacing click's AudioContext is created (or woken: iOS suspends it in the background) in the tap.
    try {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!S.audio && Ctx) S.audio = new Ctx();
      if (S.audio && S.audio.state !== 'running' && typeof S.audio.resume === 'function') S.audio.resume().catch(() => {});
    } catch {
      S.audio = null;
    }
  }
  return Promise.allSettled([p1, p2]);
}

async function startFlow(kind) {
  if (S.phase !== 'idle') return;
  S.flow = kind;
  S.phase = 'opening';
  // Synchronous part of the tap: permission + camera requests go out before the first await.
  const opened = openSensors();
  setHud(STEP_TEXT.opening, '', '');
  updateButtons();
  startUi();
  const [perm, cam] = await opened;
  S.motionPermission = perm.status === 'fulfilled' ? String(perm.value) : `error: ${(perm.reason && perm.reason.name) || perm.reason}`;
  if (S.motionPermission === 'granted' && !S.motionListening) {
    globalThis.addEventListener('devicemotion', onMotion);
    S.motionListening = true;
  }
  if (S.phase !== 'opening') {
    if (cam.status === 'fulfilled') stopCamera(cam.value.stream);
    return;
  }
  if (cam.status === 'rejected') {
    closeCapture();
    showStartMessage(cameraMessage(cam.reason));
    return;
  }
  S.stream = cam.value.stream;
  S.track = cam.value.track;
  S.needPlay = !cam.value.playing;
  if (motionMessage()) showStartMessage(motionMessage());
  if (S.track) S.track.addEventListener('ended', () => cancelFlow('The camera stopped (another app took it?).'));
  setTimeout(() => {
    if (S.motionPermission === 'granted' && S.live.count === 0) {
      S.motionBlocked = true;
      showStartMessage(motionMessage());
    }
  }, 1000);
  if (kind === 'lens') {
    S.phase = 'lens';
    updateButtons();
    runLensCheck();
    return;
  }
  S.phase = 'framing';
  S.detect = { frozen: false, options: [], idx: 0, last: null, lastPostAt: 0, posted: 0, failures: 0, found: false, startedAt: performance.now() };
  startFrameLoop();
  updateButtons();
}

function cameraMessage(err) {
  const kind = cameraErrorKind(err);
  if (kind === 'blocked')
    return 'The camera was refused. On iPhone: Settings > Safari > Camera > Allow (or tap "aA" in the address bar > Website Settings), then reload. If this page is inside another site, it needs allow="camera; accelerometer; gyroscope".';
  if (kind === 'insecure') return 'The camera needs a secure (https) page. Open this page from its https:// address.';
  if (kind === 'busy') return 'The camera is in use by another app (a call, the Camera app). Close it and try again.';
  if (kind === 'unavailable') return 'No camera could be opened in this browser.';
  return `The camera did not start (${(err && err.name) || err}).`;
}
/** The motion problem in a few words, for the fixed-size hint box of the capture view. */
function motionShort() {
  if (S.motionPermission === 'denied') return 'Motion refused: tracker-only test.';
  if (S.motionPermission === 'unsupported') return 'No motion sensors: tracker-only test.';
  if (S.motionPermission.startsWith('error')) return 'Motion permission failed: tracker-only test.';
  if (S.motionBlocked) return 'No motion events: tracker-only test.';
  return '';
}
function motionMessage() {
  if (S.motionPermission === 'denied')
    return 'Motion access was refused. Safari keeps that answer until Safari is fully closed: swipe Safari away in the app switcher, open this page again and tap Allow. The tracker-only test still runs.';
  if (S.motionPermission === 'unsupported') return 'This browser has no motion sensors API. The tracker-only test still runs.';
  if (S.motionPermission.startsWith('error')) return `Motion permission failed (${S.motionPermission}). The tracker-only test still runs.`;
  if (S.motionBlocked) return 'No motion events arrive: motion blocked (iframe without allow="accelerometer; gyroscope"? Low Power Mode?). The tracker-only test still runs.';
  return '';
}
function showStartMessage(text) {
  els.startMsg.textContent = text;
  els.startMsg.hidden = !text;
}

async function runLensCheck() {
  setHud(STEP_TEXT.lens, 'Hold the phone steady for a moment.', '');
  await new Promise((r) => setTimeout(r, 1200));
  if (S.phase !== 'lens') return;
  let note;
  try {
    const shot = await capturePhoto({ track: S.track, video: els.video });
    if (shot.capture === 'live') {
      const bytes = new Uint8Array(await shot.blob.slice(0, 256 * 1024).arrayBuffer());
      const info = readJpegInfo(bytes);
      if (info.focal35mm >= 10 && info.focal35mm <= 200) {
        S.lens = { f35: info.focal35mm, source: 'exif', note: `${info.focal35mm} mm from the photo's EXIF (${info.width || '?'} x ${info.height || '?'})` };
      } else S.lens = { f35: null, source: 'prior', note: `the photo has no focal length (iOS 18.4+ needed): using the typical ${PHONE_DEFAULT_F35} mm` };
    } else
      S.lens = {
        f35: null,
        source: 'prior',
        note: `the camera gave no full photo (${typeof globalThis.ImageCapture === 'function' ? 'takePhoto failed' : 'no ImageCapture: iOS 18.4+ needed'}): using the typical ${PHONE_DEFAULT_F35} mm`,
      };
  } catch (err) {
    S.lens = { f35: null, source: 'prior', note: `the photo failed (${(err && err.message) || err}): using the typical ${PHONE_DEFAULT_F35} mm` };
  }
  note = S.lens.note;
  closeCapture();
  els.lensOut.textContent = `Lens: ${note}.`;
}

function cancelFlow(message) {
  if (S.phase === 'run') {
    finishRun('stopped');
    return;
  }
  closeCapture();
  if (message) showStartMessage(message);
}
function closeCapture() {
  stopFrameLoop();
  stopUi();
  stopCamera(S.stream);
  S.stream = null;
  S.track = null;
  try {
    els.video.srcObject = null;
  } catch {
    // nothing to detach
  }
  if (S.wakeLock) {
    S.wakeLock.release().catch(() => {});
    S.wakeLock = null;
  }
  S.phase = 'idle';
  S.detect = null;
  S.manual = null;
  els.cap.hidden = true;
  document.body.classList.remove('capturing');
  updateButtons();
}

// ---- manual corners
function enterManual() {
  if (S.phase !== 'framing') return;
  const v = els.video;
  const view = viewSize();
  // Freeze the frame the tester taps on (drawn behind the taps); the live video keeps running underneath.
  const fr = document.createElement('canvas');
  fr.width = Math.round(view.w);
  fr.height = Math.round(view.h);
  const map = coverMapping(v.videoWidth, v.videoHeight, view.w, view.h);
  if (!map) return; // no video frame yet
  try {
    fr.getContext('2d').drawImage(v, map.offsetX, map.offsetY, v.videoWidth * map.scale, v.videoHeight * map.scale);
  } catch {
    // the frozen picture is only a visual aid
  }
  S.detect.frozen = true;
  S.manual = { points: [], frozen: fr, map, videoW: v.videoWidth, videoH: v.videoHeight, view };
  S.phase = 'manual';
  updateButtons();
}
function onOverlayTap(ev) {
  if (S.phase !== 'manual' || !S.manual || S.manual.points.length >= 4) return;
  const rect = els.overlay.getBoundingClientRect();
  S.manual.points.push({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
  updateButtons();
}
function manualQuadTrackPx() {
  const M = S.manual;
  const { w, h } = trackSizeFor(M.videoW, M.videoH);
  return M.points.map((p) => ({ x: ((p.x - M.map.offsetX) / M.map.scale) * (w / M.videoW), y: ((p.y - M.map.offsetY) / M.map.scale) * (h / M.videoH) }));
}

// ---- the run
function currentPhase() {
  const run = S.run;
  return run && run.phaseIdx >= 0 && run.phaseIdx < run.phaseNames.length ? run.phaseNames[run.phaseIdx] : null;
}
/**
 * Start from the outline the tester chose, but first find it again on a CURRENT live frame: "Not right"
 * freezes detection and manual corners are tapped on a frozen frame, so the chosen quad can be seconds old.
 * The worker re-detects near it (or snaps with a wide radius) and needs all four sides on an edge of that
 * frame; otherwise the run does not start and the tester lines the door up again.
 */
async function confirmStart(quad, source) {
  if (S.phase !== 'framing' && S.phase !== 'manual') return;
  const img = grabTrackImage();
  S.phase = 'starting';
  if (S.detect) S.detect.frozen = true;
  updateButtons();
  const reply = img ? await workerRequest({ type: 'start', quad, image: img, focalPx: currentFocalPx(img.width, img.height) }, 'started', 4000, [img.data.buffer]) : null;
  if (S.phase !== 'starting') return; // cancelled meanwhile
  if (reply && reply.ok) {
    beginRun(reply.quad, source, { chosenQuad: quad, check: reply.source, support: reply.support });
    return;
  }
  const why = !img
    ? 'no live video frame yet'
    : !reply
      ? 'the tracker did not answer'
      : reply.reason === 'sides_not_found'
        ? `the ${(reply.weak || []).join(', ')} side${(reply.weak || []).length > 1 ? 's were' : ' was'} not found`
        : reply.reason || 'no outline';
  S.phase = 'framing';
  S.manual = null;
  if (S.detect) Object.assign(S.detect, { frozen: false, options: [], idx: 0, found: false, note: `Could not start: ${why} on the live picture. Line the door up again and tap "Yes", or tap the corners.`, noteUntil: performance.now() + 6000 });
  updateButtons();
}
function beginRun(quad, source, startCheck = null) {
  const form = readForm();
  const v = els.video;
  S.rec = makeRecorder();
  const now = performance.now();
  let settings = null;
  let capabilities = null;
  try {
    settings = S.track && typeof S.track.getSettings === 'function' ? S.track.getSettings() : null;
  } catch {
    settings = null;
  }
  try {
    capabilities = S.track && typeof S.track.getCapabilities === 'function' ? S.track.getCapabilities() : null;
  } catch {
    capabilities = null;
  }
  const ts = trackSizeFor(v.videoWidth, v.videoHeight);
  S.run = {
    form,
    mode: form.mode,
    phaseNames: MODES[form.mode].phases,
    phaseIdx: -1,
    phaseT0: now,
    goodS: 0,
    lastGoodAt: 0,
    flaggedRun: 0,
    paused: false,
    stride: 1,
    msRecent: [],
    centres: [],
    lastQuad: quad,
    initQuad: quad,
    initSource: source,
    startCheck,
    taps: [],
    videoSize: { w: v.videoWidth, h: v.videoHeight },
    trackSize: ts,
    startAt: now,
    env: { trackSettings: settings, trackCapabilities: capabilities, orientationType: orientationType() },
    nextClickAt: 0,
    clickSide: 0,
    sizeChanged: false,
  };
  // (the worker was started on this quad by confirmStart)
  startVideoRecording(form);
  S.rec.on = true;
  S.rec.t0 = now;
  S.phase = 'run';
  nextPhase();
  updateButtons();
}
function nextPhase() {
  const run = S.run;
  const now = performance.now();
  const R = S.rec;
  if (run.phaseIdx >= 0 && R.phases.length) R.phases[R.phases.length - 1].t1 = now;
  run.phaseIdx++;
  run.phaseT0 = now;
  run.goodS = 0;
  run.lastGoodAt = 0;
  if (run.phaseIdx >= run.phaseNames.length) {
    finishRun(null);
    return;
  }
  R.phases.push({ name: run.phaseNames[run.phaseIdx], t0: now, t1: NaN });
}

function runTick(now) {
  const run = S.run;
  const ph = currentPhase();
  if (!ph) return;
  if (now - S.rec.t0 > CAP_MS) {
    finishRun('time_cap');
    return;
  }
  if (run.sizeChanged) {
    finishRun('video_size_changed');
    return;
  }
  const tilt = liveTiltDeg();
  const landscape = orientationType().startsWith('landscape');
  run.paused = landscape || tilt > TILT_PAUSE_DEG;
  const elapsed = now - run.phaseT0;
  const motion = motionAvailable();
  const quadStill = () => {
    const c = run.centres.filter((p) => now - p.t < 500);
    if (c.length < 4) return false;
    const dt = (c[c.length - 1].t - c[0].t) / 1000;
    return dt > 0 && Math.hypot(c[c.length - 1].x - c[0].x, c[c.length - 1].y - c[0].y) / dt < 15;
  };
  if (ph === 'still1' || ph === 'still2') {
    const stillFor = motion ? now - Math.max(S.live.lastMoveAt, run.phaseT0) : quadStill() ? elapsed : 0;
    if (!run.paused && stillFor >= STILL_MS) nextPhase();
  } else if (ph === 'settle') {
    if (elapsed >= 500) nextPhase();
  } else if (ph === 'sweep') {
    if (run.goodS >= SWEEP_GOOD_S) nextPhase();
  } else if (ph === 'rotate') {
    if (run.goodS >= ROTATE_GOOD_S) nextPhase();
  } else if (ph === 'still10') {
    if (run.goodS >= STILL10_GOOD_S) nextPhase();
  } else if (ph === 'tap1' || ph === 'tap2') {
    const tapAt = S.live.lastTapAt;
    if (tapAt > run.phaseT0 && now - tapAt > 600) {
      run.taps.push({ phase: ph, at: tapAt });
      nextPhase();
    } else if (elapsed > TAP_WAIT_MS) {
      run.taps.push({ phase: ph, at: null });
      nextPhase();
    }
  }
  if (S.audio && run.form.pacing && (ph === 'sweep' || ph === 'rotate')) pacingClick();
}

function pacingClick() {
  const run = S.run;
  const ctx = S.audio;
  try {
    if (!run.nextClickAt || run.nextClickAt < ctx.currentTime) run.nextClickAt = ctx.currentTime + 0.1;
    while (run.nextClickAt < ctx.currentTime + 0.3) {
      const o = ctx.createOscillator();
      const gn = ctx.createGain();
      o.frequency.value = run.clickSide++ % 2 ? 660 : 990;
      gn.gain.setValueAtTime(0.0001, run.nextClickAt);
      gn.gain.exponentialRampToValueAtTime(0.4, run.nextClickAt + 0.005);
      gn.gain.exponentialRampToValueAtTime(0.0001, run.nextClickAt + 0.05);
      o.connect(gn).connect(ctx.destination);
      o.start(run.nextClickAt);
      o.stop(run.nextClickAt + 0.06);
      run.nextClickAt += 0.5; // a click at each end of a 1 Hz sweep
    }
  } catch {
    S.audio = null;
  }
}

function sweepHint(now) {
  const run = S.run;
  if (run.paused) return 'Hold the phone upright (portrait)';
  const q = run.lastQuad;
  const w = run.trackSize.w;
  const h = run.trackSize.h;
  if (q && q.some((p) => p.x < 0.02 * w || p.x > 0.98 * w || p.y < 0.02 * h || p.y > 0.98 * h)) return 'Door out of view: keep the whole door on the screen';
  if (run.flaggedRun >= 2) return 'Door out of view, or moving too fast: slower';
  const c = run.centres.filter((p) => now - p.t < 300);
  const speed = c.length >= 2 ? Math.hypot(c[c.length - 1].x - c[0].x, c[c.length - 1].y - c[0].y) / Math.max(0.001, (c[c.length - 1].t - c[0].t) / 1000) : 0;
  const mot = recentMotion(2000);
  if (speed > 450 || mot.gyroMean > 60) return 'Slower';
  if (currentPhase() === 'rotate') return mot.axRms > 1.5 ? 'Only turn the phone: do not slide it' : 'Good: keep turning gently';
  const c2 = run.centres.filter((p) => now - p.t < 2000);
  const range = c2.length ? Math.max(...c2.map((p) => p.x)) - Math.min(...c2.map((p) => p.x)) : 0;
  if (Number.isFinite(mot.axRms) && mot.axRms < 0.7 && range < 25) return 'A bit more: slide about a hand-width';
  if (mot.gyroMean > 20 && mot.axRms < 0.7) return 'Keep it pointing straight: slide, do not turn';
  return 'Good: keep going';
}

async function finishRun(abortReason) {
  if (S.phase !== 'run') return;
  const run = S.run;
  const R = S.rec;
  const now = performance.now();
  if (R.phases.length && !Number.isFinite(R.phases[R.phases.length - 1].t1)) R.phases[R.phases.length - 1].t1 = now;
  R.on = false;
  S.phase = 'solving';
  stopFrameLoop();
  updateButtons();
  setHud(STEP_TEXT.solving, abortReason ? `Run stopped: ${abortText(abortReason)}` : '', '');
  const videoBlob = await stopVideoRecording();
  const fin = await workerRequest({ type: 'final', focalPx: currentFocalPx(run.trackSize.w, run.trackSize.h) }, 'final', 4000);
  S.worker.postMessage({ type: 'reset' });
  closeCapture();
  let log = null;
  try {
    log = buildLog(run, abortReason, fin);
  } catch (err) {
    showStartMessage(`The run could not be logged: ${(err && err.message) || err}`);
    return;
  }
  present(log, run.form, videoBlob, { save: true });
}

/** Work out, store (log.results), summarise and show a run. `save` adds it to the session. */
function present(log, form, videoBlob, { save }) {
  S.lastLog = log;
  S.lastForm = form;
  S.lastVideo = videoBlob;
  try {
    const t0 = performance.now();
    const results = computeResults(log, form, { sessionMapping: log.mode === 'still' ? sessionMappingLabel() : null });
    results.solveMs = performance.now() - t0;
    log.results = exportResults(results, form.includeHeights);
    const summary = runSummary({
      at: log.createdAt,
      mode: log.mode,
      truth: { doorId: form.doorId, tapeW: form.tapeW, tapeH: form.tapeH, phone: form.phone, ios: form.ios },
      solve: results.solve,
      frames: results.frames,
      tracker: { drift: log.tracker.final && log.tracker.final.ok ? log.tracker.final.drift : NaN },
      catalogue: results.catalogue,
      camheight: results.camheight,
      tapSync: results.tapSync,
      noise: results.noise,
      aborted: log.aborted,
      includeHeights: form.includeHeights,
    });
    S.lastResults = results;
    S.lastSummary = summary;
    if (save) {
      S.session.push(summary);
      if (S.session.length > 300) S.session.splice(0, S.session.length - 300);
      if (!store.set(STORE_SESSION, S.session)) S.storageWarning = true;
    }
    renderResult();
  } catch (err) {
    showStartMessage(`Something went wrong working out the result: ${(err && err.message) || err}. Download log still works.`);
    S.lastResults = null;
    renderLogOnly(err);
  }
  renderSession();
}

/** When the result cannot be shown, keep the log downloadable. */
function renderLogOnly(err) {
  const body = els.resultBody;
  body.textContent = '';
  body.append(el('p', { class: 'warn', text: `No result could be shown (${(err && err.message) || err}). The raw log can still be downloaded.` }));
  const bar = el('div', { class: 'buttons' });
  bar.append(el('button', { type: 'button', text: 'Download log', onclick: downloadLog }));
  body.append(bar, el('p', { id: 'copy-msg', class: 'note', role: 'status' }));
  els.result.hidden = false;
}

/** A synthetic sweep (vi-synth.mjs, research S2 baseline), to see what a result looks like. Never saved. */
async function showSyntheticExample() {
  try {
    const { synthLog, SCENARIOS } = await import('./vi-synth.mjs');
    const seed = 1000 + Math.floor(Math.random() * 100);
    const log = synthLog(SCENARIOS.S2, seed);
    Object.assign(log, { createdAt: new Date().toISOString(), page: PAGE_VERSION, mode: 'sweep', aborted: null, taps: [], notes: [{ t: 0, note: `SYNTHETIC example (research S2 baseline, seed ${seed}): not a measurement` }] });
    Object.assign(log.env, { videoSize: { w: 1440, h: 1920 }, orientationType: 'portrait-primary (synthetic)', trackSettings: null, rvfc: true, motionPermission: 'synthetic', motionBlocked: false });
    Object.assign(log.tracker, { init: { quad: null, source: 'synthetic' }, final: null, stride: 1, replied: log.tracker.ok.slice() });
    const form = { ...readForm(), doorId: 'SYNTHETIC', tapeW: 820, tapeH: 2040, phone: 'synthetic', includeHeights: false };
    present(log, form, null, { save: false });
  } catch (err) {
    showStartMessage(`The synthetic example could not load: ${(err && err.message) || err}`);
  }
}
function abortText(r) {
  return (
    {
      door_lost: 'the door was lost (5 frames in a row did not match). Keep the whole door on the screen and slide a little slower.',
      page_hidden: 'the page was hidden (motion events stop while Safari is in the background).',
      time_cap: 'the 60 s limit was reached.',
      stopped: 'you stopped it.',
      video_size_changed: 'the video changed size (was the phone turned?).',
    }[r] || r
  );
}

// ---- optional video
function startVideoRecording(form) {
  S.recorder = null;
  if (!form.recordVideo || typeof globalThis.MediaRecorder !== 'function' || !S.stream) return;
  const types = ['video/mp4', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = types.find((t) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(t)) || '';
  try {
    const rec = new MediaRecorder(S.stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    rec.start(1000);
    S.recorder = { rec, chunks, mime: rec.mimeType || mime, startAt: performance.now() };
  } catch (err) {
    S.recorder = { error: String((err && err.message) || err) };
  }
}
function stopVideoRecording() {
  const R = S.recorder;
  if (!R || !R.rec) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = () => resolve(new Blob(R.chunks, { type: R.mime || 'video/mp4' }));
    R.rec.onstop = done;
    try {
      R.rec.stop();
    } catch {
      done();
    }
    setTimeout(done, 3000);
  });
}

// ------------------------------------------------------------------------------------------------ log
function buildLog(run, abortReason, fin) {
  const R = S.rec;
  const n = R.mN;
  const motion = { n };
  for (const k of MOTION_COLUMNS) motion[k] = Array.from(R.m[k].subarray(0, n));
  const nF = R.fN;
  const frames = { n: nF };
  for (const k of Object.keys(R.f)) frames[k] = Array.from(R.f[k].subarray(0, nF));
  const form = run.form;
  const truth = { doorId: form.doorId, tapeW: num(form.tapeW), tapeH: num(form.tapeH) };
  if (form.includeHeights) Object.assign(truth, { lensHeight: num(form.lensHeight), sillOffset: num(form.sillOffset), stature: num(form.stature) });
  return {
    schema: 'securemeasure-lab-vio/1',
    createdAt: new Date().toISOString(),
    page: PAGE_VERSION,
    mode: run.mode,
    aborted: abortReason || null,
    env: {
      userAgent: navigator.userAgent,
      phoneModel: form.phone,
      osVersion: form.ios,
      screen: { w: globalThis.screen ? screen.width : NaN, h: globalThis.screen ? screen.height : NaN, dpr: globalThis.devicePixelRatio || 1 },
      orientationType: run.env.orientationType,
      trackSettings: run.env.trackSettings,
      trackCapabilities: run.env.trackCapabilities,
      videoSize: run.videoSize,
      trackSize: run.trackSize,
      rvfc: S.rvfc,
      focal: { f35: S.lens.f35 || PHONE_DEFAULT_F35, source: S.lens.source, note: S.lens.note },
      motionPermission: S.motionPermission,
      motionBlocked: S.motionBlocked,
      pacing: Boolean(S.audio) && form.pacing,
      video: S.recorder ? { mime: S.recorder.mime || null, startAt: S.recorder.startAt || null, error: S.recorder.error || null } : null,
    },
    settings: { mode: run.mode, solver: { ...DEFAULT_SETTINGS } },
    truth,
    phases: R.phases,
    taps: run.taps,
    notes: R.notes,
    motion,
    frames,
    tracker: {
      quad: Array.from(R.tq.subarray(0, nF * 8)),
      ok: Array.from(R.tok.subarray(0, nF)),
      flagged: Array.from(R.tflag.subarray(0, nF)),
      replied: Array.from(R.treplied.subarray(0, nF)),
      ms: Array.from(R.tms.subarray(0, nF)),
      jumpPx: Array.from(R.tjump.subarray(0, nF)),
      init: { quad: run.initQuad, source: run.initSource, startCheck: run.startCheck || null },
      final: fin || null,
      stride: run.stride,
    },
    results: null,
  };
}

function computeResults(log, form, { sessionMapping = null } = {}) {
  const solve = solveWith(log);
  const prep = solve.prep || {};
  const frames = frameStats(log.frames, log.tracker);
  const w = log.env.trackSize.w;
  const h = log.env.trackSize.h;
  const focal = prep.focal || focalPxForFrame(log.env.focal.f35, w, h);
  const focalPx = focal.focalPx;
  const exif = log.env.focal.source === 'exif';
  const K = { f: focalPx, cx: w / 2, cy: h / 2 };
  const out = { solve, frames, drift: log.tracker.final && log.tracker.final.ok ? log.tracker.final.drift : NaN };
  // Catalogue: median rectified aspect of the frames the solver used (or of every tracked frame).
  const used = trackedFrames(log, prep.timeSource || 'presentationTime');
  const aspects = [];
  for (const f of used) {
    try {
      const a = rectifyRectangle(f.corners, K).aspectHW;
      if (Number.isFinite(a)) aspects.push(a);
    } catch {
      // a degenerate quad has no aspect
    }
  }
  const aspectHW = solve.ok ? solve.aspectHW : median(aspects);
  if (Number.isFinite(aspectHW) && used.length) {
    out.catalogue = catalogueCompare({
      aspectHW,
      corners: used[Math.floor(used.length / 2)].corners,
      K,
      focalSigmaLn: exif ? 0.02 : 0.08,
      Hmm: solve.ok ? solve.Hm * 1000 : NaN,
      Wmm: solve.ok ? solve.Wm * 1000 : NaN,
      tape: { w: form.tapeW, h: form.tapeH },
    });
  }
  // Camera-height panel (secondary): the mean corners and the mean specific force over the SAME verified-still
  // second (the end of still-1), not the first frame against the whole still-1 mean.
  const norm = normaliseMotion(log.motion, { stillMs: phaseWindow(log.phases, 'still1') });
  const chIn = cameraHeightInputs(log, used);
  out.camheight = chIn.ok
    ? cameraHeightPanel({
        corners: chIn.corners,
        width: w,
        height: h,
        focalPx,
        exifFocal: exif,
        gravityDevice: chIn.gravityDevice,
        lensHeightMm: form.lensHeight,
        sillOffsetMm: form.sillOffset,
        statureMm: form.stature,
        tapeMm: { w: form.tapeW, h: form.tapeH },
      })
    : { ok: false, reason: chIn.reason };
  out.camheight.window = chIn.window ? { phase: chIn.window.phase, ms: chIn.window.t1 - chIn.window.t0, nFrames: chIn.nFrames ?? 0, nEvents: chIn.nEvents ?? 0 } : null;
  if (log.mode === 'tapsync' && norm.events.length) {
    const wins = log.phases.filter((p) => p.name === 'tap1' || p.name === 'tap2').map((p) => [(p.t0 - 300) / 1000, (p.t1 + 300) / 1000]);
    // Every frame the tracker answered, FLAGGED ONES TOO: a tap that shakes the picture by more than 8 px flags
    // its own frame, and that frame is the one the offset needs.
    out.tapSync = tapSyncOffsets(norm.events, repliedFrames(log, prep.timeSource || 'presentationTime'), wins);
  }
  if (log.mode === 'still' && norm.events.length) {
    // A Still run barely turns, so it cannot determine the gyro mapping (ratio ~1.0-1.4): use the mapping this
    // session's sweeps determined, else report the raw alpha / beta / gamma, never a near-random guess.
    const m = prep.mapping;
    let mapping = null;
    let axes = 'alpha/beta/gamma';
    if (m && m.ok && m.determined) {
      mapping = m;
      axes = 'x/y/z';
    } else if (sessionMapping && parseGyroMapping(sessionMapping)) {
      mapping = parseGyroMapping(sessionMapping);
      axes = `x/y/z (mapping ${sessionMapping} from this session's sweeps)`;
    }
    const evs = mapping ? applyGyroMapping(norm.events, mapping) : norm.events.map((e) => ({ ...e, rot: e.rotRaw }));
    out.noise = noiseFloor(evs, used, axes);
  }
  out.motionStats = norm.stats;
  return out;
}
/** Every tracked, unflagged frame of a log as { t (s), corners, index }. */
function trackedFrames(log, timeSource) {
  const F = log.frames;
  const T = log.tracker;
  const tArr = timeSource === 'captureTime' ? F.captureTime : F.presentationTime;
  const out = [];
  for (let i = 0; i < F.n; i++) {
    if (T.ok[i] !== 1 || T.flagged[i] === 1) continue;
    const q = [0, 1, 2, 3].map((c) => ({ x: T.quad[8 * i + 2 * c], y: T.quad[8 * i + 2 * c + 1] }));
    if (!q.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) || !Number.isFinite(tArr[i])) continue;
    out.push({ t: tArr[i] / 1000, corners: q, index: i });
  }
  return out;
}
/** Every frame the tracker replied to with a finite jump, flagged or not, as { t (s), jumpPx, flagged }. */
function repliedFrames(log, timeSource) {
  const F = log.frames;
  const T = log.tracker;
  const tArr = timeSource === 'captureTime' ? F.captureTime : F.presentationTime;
  const replied = T.replied || T.ok; // older logs: ok
  const out = [];
  for (let i = 0; i < F.n; i++) {
    if (replied[i] !== 1 || !Number.isFinite(T.jumpPx[i]) || !Number.isFinite(tArr[i])) continue;
    out.push({ t: tArr[i] / 1000, jumpPx: T.jumpPx[i], flagged: T.flagged[i] === 1 });
  }
  return out;
}
/** The most frequent gyro mapping this session's runs determined (sweeps), or null. */
function sessionMappingLabel() {
  const count = new Map();
  for (const r of S.session) if (r && r.mapOk && typeof r.map === 'string') count.set(r.map, (count.get(r.map) || 0) + 1);
  let best = null;
  for (const [label, n] of count) if (!best || n > best.n) best = { label, n };
  return best ? best.label : null;
}

// ------------------------------------------------------------------------------------------------ UI loop
function startUi() {
  stopUi();
  S.uiTimer = setInterval(uiTick, UI_MS);
}
function stopUi() {
  if (S.uiTimer) clearInterval(S.uiTimer);
  S.uiTimer = null;
}
let statAt = 0;
function uiTick() {
  const now = performance.now();
  const L = S.live;
  if (now - L.framesAt >= 1000) {
    L.fps = ((L.frames - (L.framesPrev || 0)) * 1000) / Math.max(1, now - L.framesAt);
    L.framesPrev = L.frames;
    L.framesAt = now;
    L.hz = (L.hzCount * 1000) / Math.max(1, now - (L.hzAt || now - 1000));
    L.hzCount = 0;
    L.hzAt = now;
  }
  if (S.phase === 'run') runTick(now);
  let step = STEP_TEXT[S.phase] || '';
  let hint = '';
  if (S.phase === 'framing') {
    const D = S.detect;
    if (S.workerError) hint = `Tracker unavailable: ${S.workerError}`;
    else if (D && D.note && now < D.noteUntil) hint = D.note;
    else if (D && D.options.length) hint = 'Green outline on the door opening? Tap "Yes". If not, "Not right".';
    else if (D && now - D.startedAt > 6000) hint = 'No door found yet. Fit the whole door inside the frame, or tap "Tap the corners".';
    else hint = 'Looking for the door...';
    if (liveTiltDeg() > TILT_PAUSE_DEG || orientationType().startsWith('landscape')) hint = 'Hold the phone upright (portrait). iPhone cannot lock the page in portrait, so turn it back by hand.';
    const mm = motionShort();
    if (mm) hint = `${hint} ${mm}`;
  } else if (S.phase === 'manual') {
    const n = S.manual ? S.manual.points.length : 0;
    hint = n < 4 ? `Next: ${['top-left', 'top-right', 'bottom-right', 'bottom-left'][n]}` : 'Tap "Use these corners", then hold still.';
  } else if (S.phase === 'run') {
    const ph = currentPhase();
    step = STEP_TEXT[ph] || '';
    const run = S.run;
    if (ph === 'still1' || ph === 'still2') {
      const left = Math.max(0, STILL_MS - (now - Math.max(S.live.lastMoveAt, run.phaseT0))) / 1000;
      hint = run.paused ? 'Hold the phone upright (portrait)' : motionAvailable() ? `${left.toFixed(1)} s` : 'Hold still...';
    } else if (ph === 'sweep' || ph === 'rotate') hint = sweepHint(now);
    else if (ph === 'still10') hint = run.paused ? 'Hold the phone upright (portrait)' : `${Math.max(0, STILL10_GOOD_S - run.goodS).toFixed(0)} s left`;
    else if (ph === 'tap1' || ph === 'tap2') hint = `Waiting for the tap... (${Math.max(0, (TAP_WAIT_MS - (now - run.phaseT0)) / 1000).toFixed(0)} s)`;
    const mm = motionShort();
    if (mm) hint = `${hint}. ${mm}`;
  }
  let stat;
  if (now - statAt > 500) {
    statAt = now;
    const ms = S.phase === 'run' && S.run ? median(S.run.msRecent.slice(-30)) : S.detect ? S.detect.ms : NaN;
    const fpsWarn = Number.isFinite(L.fps) && L.fps > 0 && L.fps < FPS_WARN && (S.phase === 'run' || S.phase === 'framing') ? ' LOW FPS' : '';
    stat = `motion ${fx(L.hz, 0)} Hz | video ${fx(L.fps, 0)} fps${fpsWarn} | tracker ${fx(ms, 0)} ms | tilt ${fx(liveTiltDeg(), 0)} deg`;
  }
  setHud(step, hint, stat);
  draw(now);
}

function draw(now) {
  const c = els.overlay;
  const dpr = globalThis.devicePixelRatio || 1;
  const view = viewSize();
  const W = Math.round(view.w * dpr);
  const H = Math.round(view.h * dpr);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = els.video;
  const map = coverMapping(v.videoWidth, v.videoHeight, view.w, view.h);
  const toView = (q, tw, th) => q.map((p) => ({ x: p.x * (v.videoWidth / tw) * map.scale + map.offsetX, y: p.y * (v.videoHeight / th) * map.scale + map.offsetY }));
  const poly = (pts, colour, width, dash = []) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.setLineDash(dash);
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (S.phase === 'framing' && map) {
    const g = guideRect(view.w, view.h);
    if (g) poly([{ x: g.x, y: g.y }, { x: g.x + g.width, y: g.y }, { x: g.x + g.width, y: g.y + g.height }, { x: g.x, y: g.y + g.height }], 'rgba(255,255,255,0.8)', 2, [10, 8]);
    const D = S.detect;
    if (D && D.options.length && D.trackSize) poly(toView(D.options[D.idx], D.trackSize.w, D.trackSize.h), '#22e06b', 4);
  } else if (S.phase === 'manual' && S.manual) {
    ctx.drawImage(S.manual.frozen, 0, 0, view.w, view.h);
    const pts = S.manual.points;
    ctx.fillStyle = '#ffd400';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, 2 * Math.PI);
      ctx.fill();
    }
    if (pts.length === 4) poly(pts, '#ffd400', 3);
  } else if (S.phase === 'run' && map && S.run) {
    const run = S.run;
    if (run.lastQuad) poly(toView(run.lastQuad, run.trackSize.w, run.trackSize.h), run.flaggedRun ? '#ff4d4d' : '#22e06b', 4);
    const ph = currentPhase();
    const target = ph === 'sweep' ? SWEEP_GOOD_S : ph === 'rotate' ? ROTATE_GOOD_S : ph === 'still10' ? STILL10_GOOD_S : 0;
    if (target) {
      const cx = view.w / 2;
      const cy = view.h - 150;
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.arc(cx, cy, 40, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.strokeStyle = run.paused ? '#ffb000' : '#22e06b';
      ctx.beginPath();
      ctx.arc(cx, cy, 40, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, run.goodS / target));
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.floor(run.goodS)}/${target}`, cx, cy);
    }
  }
}

// ------------------------------------------------------------------------------------------------ results
function kvTable(rows) {
  const t = el('table', { class: 'kv' });
  for (const [k, v, cls] of rows) {
    if (v === undefined) continue;
    t.append(el('tr', cls ? { class: cls } : {}, el('th', { text: k }), el('td', { text: v })));
  }
  return t;
}
function renderResult() {
  const res = S.lastResults;
  const log = S.lastLog;
  const sum = S.lastSummary;
  const s = res.solve;
  const p = s.prep || {};
  const m = res.motionStats || {};
  const fr = res.frames || {};
  const form = S.lastForm;
  const body = els.resultBody;
  body.textContent = '';
  const tapeH = num(form.tapeH);
  const tapeW = num(form.tapeW);
  const ok = s.ok && !log.aborted;
  // Headline
  const sizeMode = log.mode === 'sweep' || log.mode === 'tapsync';
  const head = el('div', { class: `headline ${s.ok ? (s.gate && s.gate.pass && !log.aborted ? 'pass' : 'fail') : 'none'}` });
  if (log.mode === 'rotate' && Number.isFinite(sum.appTransMm)) {
    head.className = `headline ${sum.appTransMm < 10 && !log.aborted ? 'pass' : 'fail'}`;
    head.append(el('p', { class: 'big-num', text: `${fx(sum.appTransMm, 1)} mm` }), el('p', { text: 'camera movement the picture shows but the motion sensors do not (RMS), while only turning: about 0 is right' }));
  } else if (log.mode === 'still' && res.noise) {
    head.className = 'headline pass';
    head.append(el('p', { class: 'big-num', text: `${fx(res.noise.cornerSdMeanPx, 2)} px` }), el('p', { text: 'corner noise of a still phone (the motion noise is below)' }));
  } else if (s.ok) {
    head.append(el('p', { class: 'big-num', text: `${fx(s.Wm * 1000, 0)} x ${fx(s.Hm * 1000, 0)} mm` }), el('p', { text: sizeMode ? 'width x height, measured' : 'width x height (meaningless in this mode)' }));
  } else head.append(el('p', { class: 'big-num', text: 'No result' }), el('p', { text: `Reason: ${s.reason}${s.error ? ` (${s.error})` : ''}` }));
  if (log.aborted) head.append(el('p', { class: 'warn', text: `Run stopped early: ${abortText(log.aborted)} The numbers below are for diagnosis only.` }));
  else if (s.ok && !(s.gate && s.gate.pass) && log.mode !== 'rotate' && log.mode !== 'still') head.append(el('p', { class: 'warn', text: 'The gate failed: do not trust this size. See the reasons below and try again.' }));
  if (log.mode === 'rotate')
    head.append(
      el('p', {
        class: 'gate',
        text: `Rotate-only check: ${fx(sum.appTransMm, 1, 'mm')} RMS of camera movement the motion sensors did not see (go needs under 10 mm; ${fx(sum.appTransAfterFocalMm, 1, 'mm')} left after a focal fit; movement a focal fit cannot remove points to OIS). The lens itself moved ${fx(sum.appTransRawMm, 1, 'mm')} RMS (turning about the hand moves it; the sensors measure that part and it is taken out).`,
      }),
    );
  if (log.mode === 'still' && res.noise)
    head.append(el('p', { text: `Still check: gyro noise (${res.noise.gyroAxes}) ${res.noise.gyroSdDegS.map((v) => v.toFixed(3)).join(' / ')} deg/s, accel noise ${res.noise.accSd.map((v) => v.toFixed(3)).join(' / ')} m/s2, corner noise ${fx(res.noise.cornerSdMeanPx, 2, 'px')}.` }));
  const tapWhy = (t) => (t.reason === 'no_frame_jump' ? 'no frame jump stood out' : t.reason === 'no_imu_spike' ? 'no tap in the motion data' : 'not found');
  if (log.mode === 'tapsync' && res.tapSync)
    head.append(el('p', { text: `Tap-sync: ${res.tapSync.map((t, i) => `tap ${i + 1} offset ${t.ok ? fx(t.offsetMs, 0, 'ms') : tapWhy(t)}`).join(', ')}; solver ${fx(s.dTr * 1000, 0, 'ms')} (from the sweep, taps left out). Tap-sync runs are not counted with the Sweep runs.` }));
  head.append(el('p', { class: 'gate', text: `Gate: ${gateText(s.gate)}` }));
  if (s.ok && Number.isFinite(tapeH))
    head.append(el('p', { text: `Against the tape (${fx(tapeW, 0)} x ${fx(tapeH, 0)} mm): width ${sgn(s.Wm * 1000 - tapeW, 0, 'mm')} (${sgn((s.Wm * 1000 / tapeW - 1) * 100, 1, '%')}), height ${sgn(s.Hm * 1000 - tapeH, 0, 'mm')} (${sgn((s.Hm * 1000 / tapeH - 1) * 100, 1, '%')})` }));
  body.append(head);

  // Run
  const wins = (s.windows || []).map((w) => `${w.t0.toFixed(2)} s: ${(w.s * 1000).toFixed(0)}`).join(', ');
  const f35 = p.focal ? p.focal.f35 : NaN;
  const lensSwitch = Number.isFinite(s.focal35Est) && (s.focal35Est < 22 || s.focal35Est > 30) ? ' (outside 22-30 mm: the camera may have switched lens)' : '';
  const cat = res.catalogue;
  const rows = [
    ['Mode', MODES[log.mode].label],
    ['Door', form.doorId || '(no id)'],
    ['Height H', s.ok ? fx(s.Hm * 1000, 1, 'mm') : 'n/a'],
    ['Width W', s.ok ? fx(s.Wm * 1000, 1, 'mm') : 'n/a'],
    ['Gate', `${gateText(s.gate)} | rule: ${GATE_TEXT}`],
    ['Per-window H (mm)', wins || 'n/a'],
    ['Window spread (1.48 MAD)', fx(s.split * 100, 2, '%')],
    ['Residual RMS x / y / z (whole fit)', s.rmsMm ? s.rmsMm.map((v) => v.toFixed(2)).join(' / ') + ' mm' : 'n/a'],
    ['x residual, median of the window fits (gate)', fx(s.rmsXWinMm, 2, 'mm')],
    ['Solved part of the run', p.window ? `${p.window.phase} ${fx(p.window.t1 - p.window.t0, 2, 's')} of frames (motion phase +- ${fx(p.settings && p.settings.trim, 1, 's')}${p.window.tapZones && p.window.tapZones.length ? ', clear of the taps' : ''}), ${p.nFramesUsed ?? 'n/a'} of ${p.nFramesLogged ?? 'n/a'} frames` : 'the whole run'],
    ['Vision motion RMS', fx(s.motionRmsMm, 1, 'mm')],
    ['Sweep peak-to-peak', fx(s.sweepPpMm, 0, 'mm')],
    ['Time offset dRot / dTr', `${fx(s.dRot * 1000, 1)} / ${fx(s.dTr * 1000, 1)} ms (IMU = video + offset)`],
    ['Gyro bias x / y / z', s.gyroBiasEst ? s.gyroBiasEst.map((v) => (v * RAD2DEG).toFixed(3)).join(' / ') + ' deg/s' : 'n/a'],
    ['Rotation fit RMS', fx(s.rotRmsDeg, 3, 'deg')],
    ['Focal used', `${fx(f35, 1, 'mm')} (${p.focal ? p.focal.source : '?'}), ${fx(p.focal && p.focal.focalPx, 1, 'px')} at ${log.env.trackSize.w} x ${log.env.trackSize.h}${p.focal && p.focal.frameAssumed !== 'as_logged' ? ' (4:3 crop assumed)' : ''}`],
    ['Focal self-estimate', `${fx(s.focal35Est, 2, 'mm')}${lensSwitch} (ln error ${fx(s.lnFocalErr, 4)})`],
    ['rho (W/H) / median aspect (H/W)', `${fx(s.rho, 4)} / ${fx(s.aspectHW, 4)}`],
    [
      'Camera-centre motion RMS: not seen by the IMU / raw (about 0 / small only in Rotate-only)',
      Number.isFinite(sum.appTransMm) || Number.isFinite(sum.appTransRawMm)
        ? `${fx(sum.appTransMm, 1, 'mm')} (after a focal fit ${fx(sum.appTransAfterFocalMm, 1, 'mm')}) / raw ${fx(sum.appTransRawMm, 1, 'mm')} (after a focal fit ${fx(sum.appTransRawAfterFocalMm, 1, 'mm')}), x ${sum.appTransBasis} height; IMU-to-lens offset ${s.imuLensOffsetM ? s.imuLensOffsetM.map((v) => (v * 100).toFixed(1)).join(' / ') : 'n/a'} cm; ln f from centres ${fx(s.lnFocalFromCentres, 3)}`
        : 'n/a',
    ],
    ['Catalogue (with scale)', cat ? cat.withScale.map((c) => `${c.size} (${c.p})`).join(', ') || 'n/a' : 'n/a'],
    ['Catalogue (aspect only)', cat ? cat.aspectOnly.map((c) => `${c.size} (${c.p})`).join(', ') || 'n/a' : 'n/a'],
    ['Tape size in the catalogue', cat ? `${cat.truth || 'not a catalogue size'}${cat.truth ? ` | exact hit: with scale ${cat.hitScale ? 'yes' : 'no'}, aspect only ${cat.hitAspect ? 'yes' : 'no'}` : ''}` : 'n/a'],
    ['Solve time', fx(res.solveMs, 0, 'ms')],
  ];
  if (res.tapSync)
    rows.push([
      'Tap-sync offsets',
      res.tapSync.map((t, i) => `tap ${i + 1}: ${t.ok ? `${fx(t.offsetMs, 1, 'ms')} (spike ${fx(t.peakMs2, 1)} m/s2, jump ${fx(t.jumpPx, 1)} px, window median ${fx(t.jumpMedianPx, 1)} px)` : `${tapWhy(t)}${Number.isFinite(t.jumpPx) ? ` (biggest jump ${fx(t.jumpPx, 1)} px, median ${fx(t.jumpMedianPx, 1)} px, spike ${fx(t.peakMs2, 1)} m/s2)` : ''}`}`).join('; '),
    ]);
  if (res.noise)
    rows.push(
      ['Noise: accel sd x/y/z', res.noise.accSd.map((v) => v.toFixed(4)).join(' / ') + ' m/s2'],
      [`Noise: gyro sd ${res.noise.gyroAxes}`, res.noise.gyroSdDegS.map((v) => v.toFixed(3)).join(' / ') + ' deg/s'],
      [`Noise: gyro mean ${res.noise.gyroAxes}`, res.noise.gyroMeanDegS.map((v) => v.toFixed(3)).join(' / ') + ' deg/s'],
      ['Noise: corners sd / lag-1', `${fx(res.noise.cornerSdMeanPx, 2, 'px')} / ${fx(res.noise.cornerLag1Mean, 2)}`],
    );
  body.append(el('h3', { text: 'Run' }), kvTable(rows));

  // Sensors
  const map = p.mapping || {};
  const ch = res.camheight || {};
  const srows = [
    ['Motion permission', `${log.env.motionPermission}${log.env.motionBlocked ? ' (no events arrived: blocked)' : ''}`],
    ['Motion rate (unique / delivered)', `${fx(m.hz, 1)} / ${fx(m.rawHz, 1)} Hz`],
    ['Event dt mean / sd / p95 / max', `${fx(m.dtMeanMs, 2)} / ${fx(m.dtSdMs, 2)} / ${fx(m.dtP95Ms, 1)} / ${fx(m.dtMaxMs, 1)} ms`],
    ['Raw e.interval', `${fx(m.intervalRaw, 5)} (${m.intervalUnit || '?'})`],
    ['Repeats / gaps > 25 ms', `${fx(m.repeatsPct, 1, '%')} (${m.repeats ?? 'n/a'}) / ${m.gaps25 ?? 'n/a'}`],
    ['Clock', `${m.timeBase || 'n/a'}; handler now - timeStamp ${fx(m.timeStampLagMs, 2, 'ms')}`],
    ['Accelerometer sign', m.accelSign === -1 ? '-1 (CoreMotion sign, flipped to W3C)' : m.accelSign === 1 ? '+1 (W3C)' : 'n/a'],
    [
      'Gyro mapping',
      !map.label
        ? `n/a${map.reason ? ` (${map.reason})` : ''}`
        : map.fixed
          ? `${map.label} (set by hand)`
          : map.determined
            ? `${map.label} | residual ratio ${fx(map.ratio, 1)} (runner-up ${map.runnerUp}) | ${fx(map.rmsDeg, 3, 'deg')} RMS`
            : `NOT DETERMINED: residual ratio ${fx(map.ratio, 1)} is under ${MAPPING_MIN_RATIO} (too little rotation); best guess ${map.label}, not evidence of the axis order`,
    ],
    ['|g| still / tilt', `${fx(m.gNorm, 3, 'm/s2')} / ${fx(m.tiltDeg, 1, 'deg')}`],
    ['Door vs gravity pitch / roll', ch.ok ? `${sgn(ch.tilt.pitchDeg, 2)} / ${sgn(ch.tilt.rollDeg, 2)} deg (total ${fx(ch.tilt.angleDeg, 2)})` : 'n/a'],
    ['Video fps (callbacks / presented)', `${fx(fr.callbackFps, 1)} / ${fx(fr.presentedFps, 1)}${fr.callbackFps < FPS_WARN ? '  LOW: under 15 fps' : ''}`],
    ['rVFC / captureTime', `${log.env.rvfc ? 'yes' : 'no (rAF fallback)'} / ${fr.captureTimePresent ? `yes (${fr.captureTimeFrames} of ${fr.n})` : 'no'}; solver used ${p.timeSource || 'n/a'}`],
    ['captureTime - presentationTime', fx(fr.captureMinusPresentationMs, 2, 'ms')],
    ['Frames tracked / skipped / strided / flagged', `${fr.tracked ?? 0} (${fx(fr.trackedPct, 0, '%')}) / ${fr.skipped ?? 0} / ${fr.strided ?? 0} / ${fr.flagged ?? 0} (${fx(fr.flaggedPct, 1, '%')}) of ${fr.n ?? 0}`],
    ['Lost', log.aborted === 'door_lost' ? 'yes' : 'no'],
    ['Tracker ms p50 / p95', `${fx(fr.trackerMsP50, 1)} / ${fx(fr.trackerMsP95, 1)}${log.tracker.stride === 2 ? ' (every second frame)' : ''}`],
    ['End drift', Number.isFinite(res.drift) ? fx(res.drift, 1, 'px') : `n/a${log.tracker.final && log.tracker.final.reason ? ` (${log.tracker.final.reason})` : ''}`],
    ['Start outline', `${log.tracker.init.source}${log.tracker.init.startCheck ? ` | live-frame check: ${log.tracker.init.startCheck.check}, side support ${(log.tracker.init.startCheck.support || []).map((v) => v.toFixed(2)).join(' / ')}` : ''}`],
    ['Track size / video size', `${log.env.trackSize.w} x ${log.env.trackSize.h} / ${log.env.videoSize.w} x ${log.env.videoSize.h}`],
    ['Orientation', log.env.orientationType],
    ['Video getSettings()', JSON.stringify(log.env.trackSettings)],
  ];
  if (log.notes.length) srows.push(['Notes', log.notes.map((n) => n.note).join('; ')]);
  body.append(el('h3', { text: 'Sensors' }), kvTable(srows));

  // Camera-height panel
  const crow = [];
  if (ch.window) crow.push(['Averaged over', `the last ${fx(ch.window.ms / 1000, 1, 's')} of ${ch.window.phase} (${ch.window.nFrames} frames, ${ch.window.nEvents} motion events)`]);
  if (!ch.ok) crow.push(['Status', `n/a (${ch.reason || 'no data'})`]);
  else {
    crow.push(['(a) Door vertical vs sensor gravity', `pitch ${sgn(ch.tilt.pitchDeg, 2)} deg, roll ${sgn(ch.tilt.rollDeg, 2)} deg, total ${fx(ch.tilt.angleDeg, 2)} deg`]);
    const show = (r) => (r && r.ok ? `${fx(r.wMm, 0)} x ${fx(r.hMm, 0)} mm${Number.isFinite(r.errHmm) ? ` | error W ${sgn(r.errWmm, 0)} H ${sgn(r.errHmm, 0)} mm` : ''} | distance ${fx(r.distMm / 1000, 2)} m` : 'no solution');
    crow.push(['(b) From the taped lens height', ch.taped ? show(ch.taped) : 'type the lens height (and sill offset) to try it']);
    crow.push(['(c) From your height', ch.stature ? show(ch.stature) : 'type your height to try it']);
  }
  body.append(el('h3', { text: 'Camera-height method (secondary)' }), kvTable(crow));
  body.append(
    el('p', {
      class: 'note',
      text: 'Heights stay on this phone. Unless the box in step 1 is ticked, Download and Share leave out the heights and everything worked out from them (the sizes, distances and errors of (b) and (c)), and Copy keeps only the (b) / (c) errors against the tape, never a height.',
    }),
  );

  // Exports
  const bar = el('div', { class: 'buttons' });
  bar.append(el('button', { type: 'button', text: 'Copy result', onclick: () => copyOut(JSON.stringify(S.lastSummary), 'Result copied.') }));
  bar.append(el('button', { type: 'button', text: 'Download log', onclick: downloadLog }));
  if (S.storageWarning) body.append(el('p', { class: 'warn', text: 'This browser would not store the session (private browsing?): copy each result before closing the page.' }));
  if (canShareFiles()) bar.append(el('button', { type: 'button', text: 'Share', onclick: shareLog }));
  if (S.lastVideo && S.lastVideo.size) bar.append(el('button', { type: 'button', text: 'Download video', onclick: () => downloadBlob(S.lastVideo, `vio-video-${stamp()}.${S.lastVideo.type.includes('webm') ? 'webm' : 'mp4'}`) }));
  bar.append(el('button', { type: 'button', text: 'Run again', onclick: () => $('measure').scrollIntoView({ behavior: 'smooth' }) }));
  body.append(bar, el('p', { id: 'copy-msg', class: 'note', role: 'status' }));
  body.append(el('details', {}, el('summary', { text: 'One-line summary (selectable)' }), el('pre', { class: 'json', text: JSON.stringify(S.lastSummary) })));
  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!ok) els.result.classList.add('noresult');
  else els.result.classList.remove('noresult');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function logFileName() {
  const door = (S.lastLog.truth.doorId || 'door').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24);
  return `vio-log-${door}-${S.lastLog.mode}-${stamp()}.json`;
}
function downloadLog() {
  downloadBlob(new Blob([JSON.stringify(S.lastLog)], { type: 'application/json' }), logFileName());
}
function shareFiles() {
  const files = [new File([JSON.stringify(S.lastLog)], logFileName(), { type: 'application/json' })];
  if (S.lastVideo && S.lastVideo.size) files.push(new File([S.lastVideo], `vio-video-${stamp()}.${S.lastVideo.type.includes('webm') ? 'webm' : 'mp4'}`, { type: S.lastVideo.type || 'video/mp4' }));
  return files;
}
function canShareFiles() {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] });
  } catch {
    return false;
  }
}
async function shareLog() {
  try {
    const files = shareFiles();
    const data = navigator.canShare({ files }) ? { files, title: 'VIO lab log' } : { files: files.slice(0, 1), title: 'VIO lab log' };
    await navigator.share(data);
  } catch (err) {
    if (!err || err.name !== 'AbortError') setCopyMsg(`Share failed (${(err && err.name) || err}). Use Download log instead.`);
  }
}
function setCopyMsg(text) {
  const e = $('copy-msg') || $('session-msg');
  if (e) e.textContent = text;
}
async function copyOut(text, done) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = el('textarea', { readonly: '', class: 'offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
  }
  setCopyMsg(ok ? done : 'Copy did not work here: select the text and copy it by hand.');
}

function renderSession() {
  const body = els.session;
  body.textContent = '';
  const rows = S.session;
  if (!rows.length) {
    body.append(el('p', { text: 'No runs yet.' }));
    return;
  }
  const T = sessionTable(rows);
  const head = ['Door', 'n', 'gate pass', 'no result', 'W |err| p50 / p90', 'H |err| p50 / p90', 'bias W / H', 'scale p90', 'exact hit: scale / aspect'];
  const t = el('table', { class: 'grid' }, el('tr', {}, ...head.map((h) => el('th', { text: h }))));
  const line = (name, g) =>
    el(
      'tr',
      {},
      ...[
        name,
        String(g.n),
        fx(g.passPct, 0, '%'),
        fx(g.noResultPct, 0, '%'),
        `${fx(g.W.p50, 0)} / ${fx(g.W.p90, 0)} mm`,
        `${fx(g.H.p50, 0)} / ${fx(g.H.p90, 0)} mm`,
        `${sgn(g.W.bias, 0)} / ${sgn(g.H.bias, 0)} mm`,
        fx(g.scaleP90Pct, 2, '%'),
        `${fx(g.hitScalePct, 0, '%')} / ${fx(g.hitAspectPct, 0, '%')} (n ${g.nHit})`,
      ].map((v) => el('td', { text: v })),
    );
  for (const d of T.perDoor) t.append(line(d.door, d));
  t.append(line('ALL sweeps', T.overall));
  if (T.tapsync.n) t.append(line('Tap-sync (own line, not in the go / no-go)', T.tapsync));
  body.append(
    el('p', { class: 'note', text: 'Sweep runs per door, then Tap-sync runs on their own line. Errors, scale p90 and both exact-hit rates are over runs that passed the gate and were not stopped early; "no result" counts runs with no solve or stopped early.' }),
    el('div', { class: 'scroll' }, t),
  );
  body.append(
    kvTable([
      ['Rotate-only runs', `${T.rotate.n} measured${T.rotate.nAll > T.rotate.n ? ` (+${T.rotate.nAll - T.rotate.n} with no measurement)` : ''}; apparent translation p50 ${fx(T.rotate.appTransP50, 1, 'mm')}, p90 ${fx(T.rotate.appTransP90, 1, 'mm')}, max ${fx(T.rotate.appTransMax, 1, 'mm')}`],
      ...(T.tapsync.n ? [['Tap-sync offsets', `p50 ${fx(T.tapsync.tapMsP50, 1, 'ms')} over ${T.tapsync.nTaps} taps; solver dTr p50 ${fx(T.tapsync.dTrMsP50, 1, 'ms')} (gated runs)`]] : []),
      ['Still runs', String(T.still.n)],
      ...T.phones.map((ph) => [`Focal self-estimate: ${ph.phone}`, `p50 ${fx(ph.f35EstP50, 2, 'mm')}, p10-p90 ${fx(ph.f35EstP10, 2)}-${fx(ph.f35EstP90, 2)} mm (n ${ph.n})`]),
      ['Test set', T.go.set],
      ...T.go.checks.map((c) => [c.name, `${c.pass === null ? 'not yet' : c.pass ? 'yes' : 'NO'}: ${c.detail}`]),
      ['Verdict', T.go.verdict],
    ]),
  );
  const bar = el('div', { class: 'buttons' });
  bar.append(el('button', { type: 'button', text: 'Copy session', onclick: () => copyOut(S.session.map((r) => JSON.stringify(r)).join('\n'), `${S.session.length} runs copied.`) }));
  bar.append(
    el('button', {
      type: 'button',
      class: 'quiet',
      text: 'Clear session',
      onclick: () => {
        if (!globalThis.confirm(`Delete all ${S.session.length} run summaries from this phone? This cannot be undone.`)) return;
        S.session = [];
        store.remove(STORE_SESSION);
        renderSession();
      },
    }),
  );
  body.append(bar, el('p', { id: 'session-msg', class: 'note', role: 'status' }));
}

function renderSupport() {
  const v = document.createElement('video');
  const items = [
    ['HTTPS page', globalThis.isSecureContext ? 'yes' : 'NO: open the https:// address'],
    ['Inside an iframe', (() => {
      try {
        return globalThis.self !== globalThis.top ? 'yes (needs allow="camera; accelerometer; gyroscope")' : 'no';
      } catch {
        return 'yes';
      }
    })()],
    ['Camera API', navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'yes' : 'no'],
    ['Motion API', typeof globalThis.DeviceMotionEvent === 'undefined' ? 'no' : typeof DeviceMotionEvent.requestPermission === 'function' ? 'yes (asks permission)' : 'yes'],
    ['requestVideoFrameCallback', typeof v.requestVideoFrameCallback === 'function' ? 'yes' : 'no (iOS 15.4+): frames timed by the screen refresh'],
    ['Module worker', S.workerError ? `NO: ${S.workerError}` : S.workerReady ? 'ready' : 'loading...'],
    ['Photo EXIF (ImageCapture)', typeof globalThis.ImageCapture === 'function' ? 'yes' : 'no (iOS 18.4+ needed for the lens check)'],
    ['Video recording', typeof globalThis.MediaRecorder === 'function' ? 'yes' : 'no'],
  ];
  els.support.textContent = '';
  els.support.append(kvTable(items));
}

// ------------------------------------------------------------------------------------------------ wiring
function wire() {
  loadForm();
  S.session = (store.get(STORE_SESSION, []) || []).filter((r) => r && typeof r === 'object');
  for (const id of [...FORM_IDS, ...CHECK_IDS]) if ($(id)) $(id).addEventListener('change', saveForm);
  for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener('change', saveForm);
  els.bStart.addEventListener('click', () => {
    if (S.workerError) {
      showStartMessage(`The tracker cannot run here: ${S.workerError}`);
      return;
    }
    const f = readForm();
    if (!Number.isFinite(f.tapeW) || !Number.isFinite(f.tapeH)) showStartMessage('Tip: type the tape width and height in step 1 so the page can show its error.');
    else showStartMessage('');
    startFlow('run');
  });
  els.bLens.addEventListener('click', () => startFlow('lens'));
  if ($('b-example')) $('b-example').addEventListener('click', showSyntheticExample);
  els.bCancel.addEventListener('click', () => cancelFlow(''));
  els.bYes.addEventListener('click', () => {
    if (S.phase === 'framing' && S.detect && S.detect.options.length) {
      const D = S.detect;
      const q = D.options[D.idx];
      confirmStart(q, D.idx === 0 ? 'auto' : `alternative ${D.idx + 1}`);
    } else if (S.phase === 'manual' && S.manual && S.manual.points.length === 4) {
      confirmStart(manualQuadTrackPx(), 'manual');
    }
  });
  els.bNext.addEventListener('click', () => {
    if (S.phase === 'framing' && S.detect && S.detect.options.length) {
      const D = S.detect;
      D.frozen = true;
      if (D.idx + 1 < D.options.length) D.idx++;
      else enterManual();
      updateButtons();
    } else if (S.phase === 'manual' && S.manual) {
      S.manual.points.pop();
      updateButtons();
    }
  });
  els.bTaps.addEventListener('click', enterManual);
  if (els.bPlay)
    els.bPlay.addEventListener('click', () => {
      els.video.play().then(
        () => {
          S.needPlay = false;
          updateButtons();
        },
        () => {},
      );
    });
  els.overlay.addEventListener('pointerdown', onOverlayTap);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (S.phase === 'run') finishRun('page_hidden');
    else if (S.phase !== 'idle' && S.phase !== 'solving') cancelFlow('The page was hidden, so the camera was closed. Tap Start again.');
  });
  startWorker();
  renderSupport();
  renderSession();
  els.lensOut.textContent = `Lens: ${PHONE_DEFAULT_F35} mm (typical; not checked).`;
}

wire();
// For Safari Web Inspector only (nothing reads it).
globalThis.__vioLab = S;
