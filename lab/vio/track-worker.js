/**
 * Module worker for the lab page (lab/vio/): door detection and frame-to-frame corner tracking, off the main
 * thread so that devicemotion events (whose timeStamp is set when the event is created on the main thread)
 * are not delayed by image work.
 *
 * Protocol (every image is { data, width, height } with `data`'s buffer transferred):
 *  { type: 'detect', id, image, prior, focalPx }  -> { type: 'detect', id, ok, quad, confidence, reason,
 *        options: [quad...] (the pick, then clearly different runners-up), ms }
 *  { type: 'start', quad, image?, focalPx? }       -> { type: 'started', ok, quad, source, support, reason,
 *        weak }. With an image (a CURRENT live frame), the quad is only a prior: the quad the tester chose
 *        can be seconds old ("Not right" freezes detection, manual corners are tapped on a frozen frame), so
 *        detectDoor runs near it (source 'redetected'), else snapQuad with a wide radius ('snapped'), and all
 *        four sides must then sit on an edge of that frame (sideSupport >= startSupportMin), else ok: false,
 *        reason 'sides_not_found', weak = the sides that did not. Without an image the quad is taken as
 *        given ('given'). Either way the next 'track' frame snaps the quad with the wider start radius.
 *  { type: 'track', frameIndex, image, t? }        -> { type: 'track', frameIndex, quad, ok, ms, jumpPx,
 *        flagged, reason, support }: constant-velocity prediction (last + (last - previous), the step scaled
 *        by dt_now / dt_prev when the frame times t (ms) are given: the page may process every second or
 *        third frame), then snapQuad
 *        with radius 12 px; jumpPx = mean corner distance from the prediction; flagged when snapping failed,
 *        jumpPx > 8, or a side lost its edge (support below half its start value: snapQuad keeps a side whose
 *        edge it cannot find, so a jamb that moved out of the search radius would otherwise pass silently).
 *        A flagged frame stays out of the solve; the tracker follows its snapped quad when all four sides are
 *        still on an edge (the hand changed speed), else coasts on the prediction. support = share of 24
 *        points along each side with a
 *        colour step across it (sideSupport).
 *  { type: 'final', focalPx }                      -> { type: 'final', ok, drift, quad, tracked }: detectDoor
 *        on the last tracked frame near the tracked quad; drift = mean corner distance between the two
 *  { type: 'reset' }                               -> { type: 'reset' }
 * Once its imports have loaded the worker posts { type: 'ready' }.
 *
 * Importing this file outside a worker (a Node test) only defines the exports, as js/door-detect-worker.js does.
 */
import { detectDoor, snapQuad } from '../../js/door-detect.js';

export const TRACK = Object.freeze({
  radiusPx: 12,
  startRadiusPx: 24,
  flagJumpPx: 8,
  keepCandidates: 3,
  supportFrac: 0.5,
  supportFloor: 0.15,
  supportIgnore: 0.2,
  startSnapFrac: 0.04, // 'start' fallback snap radius, fraction of the image diagonal (48 px at 720 x 960)
  startSupportMin: 0.3, // 'start': every side needs at least this edge support on the live frame
  maxStepRatio: 4, // the dt_now / dt_prev scaling of the predicted step is clamped to [1/4, 4]
});
const SIDE_NAMES = Object.freeze(['top', 'right', 'bottom', 'left']);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const validQuad = (q) => Array.isArray(q) && q.length === 4 && q.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
const copyQuad = (q) => q.map((p) => ({ x: p.x, y: p.y }));
const validImage = (im) => Boolean(im) && Boolean(im.data) && im.width > 0 && im.height > 0 && im.data.length >= im.width * im.height * 4;

/** Mean distance between corresponding corners of two quads, px. */
export function meanCornerDist(a, b) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return s / 4;
}
/** Constant-velocity prediction: last + ratio x (last - previous); ratio = dt_now / dt_prev (1: equal steps). */
export function predictQuad(last, prev, ratio = 1) {
  return last.map((p, i) => ({ x: p.x + ratio * (p.x - prev[i].x), y: p.y + ratio * (p.y - prev[i].y) }));
}
/** dt_now / dt_prev from the frame times (ms), clamped; 1 when any time is missing. */
export function stepRatio(tPrev, tLast, tNow) {
  const dPrev = tLast - tPrev;
  const dNow = tNow - tLast;
  if (!(Number.isFinite(dPrev) && Number.isFinite(dNow) && dPrev > 0 && dNow > 0)) return 1;
  return Math.min(TRACK.maxStepRatio, Math.max(1 / TRACK.maxStepRatio, dNow / dPrev));
}

/**
 * Edge support of each side of a quad [top, right, bottom, left]: the share of 24 points along the side
 * (10-90 % of its length) where some colour channel differs by >= minStep between offsetPx outside and inside.
 * Canvas pixel convention (pixel i spans [i, i+1)).
 */
export function sideSupport(image, quad, { offsetPx = 2, minStep = 10, samples = 24 } = {}) {
  const { data, width: W, height: H } = image;
  const out = [];
  for (let k = 0; k < 4; k++) {
    const p = quad[k];
    const q = quad[(k + 1) % 4];
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    if (!(L > 0)) {
      out.push(0);
      continue;
    }
    const nx = -(q.y - p.y) / L;
    const ny = (q.x - p.x) / L;
    let hit = 0;
    let n = 0;
    for (let i = 0; i < samples; i++) {
      const t = 0.1 + (0.8 * (i + 0.5)) / samples;
      const bx = p.x + (q.x - p.x) * t;
      const by = p.y + (q.y - p.y) * t;
      const xa = Math.floor(bx + nx * offsetPx);
      const ya = Math.floor(by + ny * offsetPx);
      const xb = Math.floor(bx - nx * offsetPx);
      const yb = Math.floor(by - ny * offsetPx);
      if (xa < 0 || ya < 0 || xb < 0 || yb < 0 || xa >= W || xb >= W || ya >= H || yb >= H) continue;
      const ia = 4 * (ya * W + xa);
      const ib = 4 * (yb * W + xb);
      n++;
      if (Math.max(Math.abs(data[ia] - data[ib]), Math.abs(data[ia + 1] - data[ib + 1]), Math.abs(data[ia + 2] - data[ib + 2])) >= minStep) hit++;
    }
    out.push(n ? hit / n : 0);
  }
  return out;
}

/** Fresh tracker state (one per worker). tLast / tPrev: frame times (ms) of last / prev, NaN when not given. */
export function createTracker() {
  return { last: null, prev: null, image: null, starting: false, support0: null, tLast: NaN, tPrev: NaN };
}

/**
 * Answer one message. Never throws: a malformed message gets { type, ok: false, reason }.
 * @param {object} state  createTracker()
 * @param {object} msg
 */
export function handleMessage(state, msg) {
  const type = msg && typeof msg === 'object' ? msg.type : undefined;
  try {
    if (type === 'detect') return detect(msg);
    if (type === 'start') return start(state, msg);
    if (type === 'track') return track(state, msg);
    if (type === 'final') return final(state, msg);
    if (type === 'reset') {
      Object.assign(state, createTracker());
      return { type: 'reset', ok: true };
    }
    return { type: 'error', ok: false, reason: 'unknown_type' };
  } catch (err) {
    return { type: type || 'error', ok: false, reason: 'error', error: String((err && err.message) || err), frameIndex: msg && msg.frameIndex };
  }
}

function detect(msg) {
  const t0 = now();
  if (!validImage(msg.image)) return { type: 'detect', id: msg.id, ok: false, reason: 'bad_input', ms: 0, options: [] };
  const opts = { keepCandidates: TRACK.keepCandidates };
  if (validQuad(msg.prior)) opts.prior = msg.prior;
  if (msg.focalPx > 0) opts.focalPx = msg.focalPx;
  const r = detectDoor(msg.image, opts);
  const diag = Math.hypot(msg.image.width, msg.image.height);
  const options = [];
  const push = (q) => {
    if (!validQuad(q)) return;
    if (options.some((o) => Math.max(...o.map((p, i) => Math.hypot(p.x - q[i].x, p.y - q[i].y))) <= 0.03 * diag)) return;
    options.push(copyQuad(q));
  };
  if (r.ok) push(r.quad);
  for (const q of r.alternatives || []) push(q);
  for (const c of r.candidates || []) push(c.quad);
  return { type: 'detect', id: msg.id, ok: Boolean(r.ok), quad: r.ok ? r.quad : null, confidence: r.confidence || 0, reason: r.reason || null, options, ms: now() - t0 };
}

function start(state, msg) {
  const t0 = now();
  if (!validQuad(msg.quad)) return { type: 'started', ok: false, reason: 'bad_quad' };
  let quad = copyQuad(msg.quad);
  let source = 'given';
  let support = null;
  if (validImage(msg.image)) {
    const opts = { prior: quad };
    if (msg.focalPx > 0) opts.focalPx = msg.focalPx;
    const r = detectDoor(msg.image, opts);
    if (r.ok && validQuad(r.quad)) {
      quad = copyQuad(r.quad);
      source = 'redetected';
    } else {
      const s = snapQuad(msg.image, quad, { radiusPx: Math.max(TRACK.startRadiusPx, TRACK.startSnapFrac * Math.hypot(msg.image.width, msg.image.height)) });
      if (s.ok) {
        quad = copyQuad(s.quad);
        source = 'snapped';
      }
    }
    support = sideSupport(msg.image, quad);
    const weak = SIDE_NAMES.filter((_, k) => !(support[k] >= TRACK.startSupportMin));
    if (weak.length) return { type: 'started', ok: false, reason: 'sides_not_found', weak, support, quad, source, ms: now() - t0 };
    state.image = msg.image;
  }
  state.last = quad;
  state.prev = copyQuad(quad);
  state.starting = true;
  state.support0 = null;
  state.tLast = NaN;
  state.tPrev = NaN;
  return { type: 'started', ok: true, quad: copyQuad(quad), source, support, ms: now() - t0 };
}

function track(state, msg) {
  const t0 = now();
  const frameIndex = msg.frameIndex;
  if (!validImage(msg.image)) return { type: 'track', frameIndex, ok: false, flagged: true, reason: 'bad_input', ms: 0, jumpPx: NaN, quad: null };
  if (!state.last) return { type: 'track', frameIndex, ok: false, flagged: true, reason: 'not_started', ms: 0, jumpPx: NaN, quad: null };
  state.image = msg.image;
  const starting = state.starting;
  const tNow = typeof msg.t === 'number' ? msg.t : NaN;
  const predicted = starting ? copyQuad(state.last) : predictQuad(state.last, state.prev, stepRatio(state.tPrev, state.tLast, tNow));
  const r = snapQuad(msg.image, predicted, { radiusPx: starting ? TRACK.startRadiusPx : TRACK.radiusPx });
  const jumpPx = meanCornerDist(r.quad, predicted);
  const support = sideSupport(msg.image, r.quad);
  if (starting && r.ok) state.support0 = support;
  const s0 = state.support0 || support;
  const edgeLost = support.some((v, k) => s0[k] >= TRACK.supportIgnore && v < Math.max(TRACK.supportFloor, TRACK.supportFrac * s0[k]));
  const flagged = !r.ok || (!starting && (jumpPx > TRACK.flagJumpPx || edgeLost));
  // A frame flagged only for its jump (all four sides still on an edge) is kept out of the solve, but the
  // tracker follows it: the hand changed speed. Without edges it coasts on the prediction.
  const follow = r.ok && !edgeLost;
  state.prev = starting ? (follow ? copyQuad(r.quad) : predicted) : state.last;
  state.last = follow ? copyQuad(r.quad) : predicted;
  // the times travel with the quads (while starting, prev = last: no velocity yet)
  state.tPrev = starting ? tNow : state.tLast;
  state.tLast = tNow;
  if (follow) state.starting = false;
  const reason = !r.ok ? 'no_edges' : starting ? null : jumpPx > TRACK.flagJumpPx ? 'jump' : edgeLost ? 'edge_lost' : null;
  return { type: 'track', frameIndex, quad: copyQuad(r.quad), ok: Boolean(r.ok), ms: now() - t0, jumpPx, flagged, reason, support, starting };
}

function final(state, msg) {
  if (!state.image || !state.last) return { type: 'final', ok: false, reason: 'no_frame' };
  const opts = { prior: state.last };
  if (msg.focalPx > 0) opts.focalPx = msg.focalPx;
  const t0 = now();
  const r = detectDoor(state.image, opts);
  if (!r.ok) return { type: 'final', ok: false, reason: r.reason || 'no_detection', tracked: copyQuad(state.last), ms: now() - t0 };
  return { type: 'final', ok: true, drift: meanCornerDist(state.last, r.quad), quad: r.quad, tracked: copyQuad(state.last), ms: now() - t0 };
}

// Only a dedicated worker scope has both of these; the main thread and Node have neither as a pair.
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const state = createTracker();
  self.onmessage = (event) => {
    self.postMessage(handleMessage(state, event.data));
  };
  self.postMessage({ type: 'ready' });
}
