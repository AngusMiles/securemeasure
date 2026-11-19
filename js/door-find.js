/**
 * Finding the door in a photo without blocking the page: runs the classical detector (js/door-detect.js)
 * in a module worker on a copy of the photo's pixels, and falls back to the main thread when workers are
 * not available (old engines, Node) or fail. The result places the starting corner handles; the customer
 * always checks them. Nothing here touches the DOM, so it also runs under Node.
 *
 * Why a worker: detection is ~50 ms on a desktop but several times that on an older phone, and it runs
 * straight after a capture, exactly when the "Finding your door…" spinner must keep animating.
 * Why a COPY of the pixels: transferring `photo.image.data.buffer` itself would detach it, and every later
 * screen (corner editor, preview, enquiry photo) still needs those pixels.
 */
import { detectDoor, suggestDefaultQuad } from './door-detect.js';

/** @typedef {{ x: number, y: number }} Point */
/**
 * @typedef {object} Detection
 * @property {boolean} ok
 * @property {Point[]|null} quad              [TL, TR, BR, BL] in photo px, or null when nothing was found
 * @property {number} confidence              0..1; above CONFIDENT the screens may say "we found your door"
 * @property {Point[][]} alternatives         up to two clearly different runner-up outlines ("not this one?")
 * @property {string} [reason]                why not ok: 'bad_input' | 'no_lines' | 'no_candidate' |
 *                                            'no_candidate_at_hint' | 'error' | 'timeout'
 */

/** detection.confidence above this = "we found your door" (no wrong ones in the benchmark above it). */
export const CONFIDENT = 0.6;

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Whether a detection is confident enough to tell the customer we found their door (they still check it).
 * @param {Detection|null|undefined} detection
 * @returns {boolean}
 */
export function isConfident(detection) {
  return Boolean(
    detection &&
      detection.ok === true &&
      isQuad(detection.quad) &&
      typeof detection.confidence === 'number' &&
      detection.confidence > CONFIDENT,
  );
}

/**
 * The corner handles to start from: the detected outline when there is one, otherwise a door-shaped
 * rectangle in the middle of the photo (about half as far from a real door as the old full-frame default).
 * Points are fresh objects, kept inside the photo so every handle can be reached.
 *
 * @param {{ width: number, height: number }} photo
 * @param {Detection|null|undefined} detection  findDoor's result for this photo, or null
 * @returns {Point[]} [TL, TR, BR, BL]
 */
export function startingQuad(photo, detection) {
  const width = positiveOr(photo && photo.width, 1);
  const height = positiveOr(photo && photo.height, 1);
  const quad = detection && detection.ok === true && isQuad(detection.quad) ? detection.quad : suggestDefaultQuad(width, height);
  return quad.map((p) => ({ x: clamp(p.x, 0, width), y: clamp(p.y, 0, height) }));
}

/**
 * Look for the door opening in a loaded photo. Never throws and never rejects.
 *
 * @param {{ image: { data: Uint8ClampedArray, width: number, height: number } }} photo  from loadPhoto
 * @param {{ prior?: Point[]|null, timeoutMs?: number }} [options]
 *   prior: a rough opening quad [TL, TR, BR, BL] in photo px (the capture guide the customer lined the
 *   door up with); outlines far from it are ignored, and if none is near it the whole photo is searched.
 *   timeoutMs: give up after this long when the worker is slow (default 4000 ms).
 * @returns {Promise<Detection>}
 */
export async function findDoor(photo, options = {}) {
  try {
    // Destructured inside the try: a null options object must not turn into a rejected promise.
    const { prior = null, timeoutMs = DEFAULT_TIMEOUT_MS } = options || {};
    const image = photo && photo.image;
    if (!isImage(image)) return failure('bad_input');
    const opts = isQuad(prior) ? { prior: copyQuad(prior) } : {};
    const limit = isPositive(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const viaWorker = await detectInWorker(image, opts, limit);
    if (viaWorker) return viaWorker;
    // No usable worker: run here, after yielding once so the busy indicator gets painted first. The work
    // cannot be interrupted, so its result is used even if it took longer than the timeout.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return runDetection(image, opts);
  } catch {
    return failure('error');
  }
}

/**
 * detectDoor plus the app's policy, shaped as a small plain Detection: if a prior was given and no outline
 * lies near it (the customer did not line the door up with the guide), the whole photo is searched instead.
 * Shared by the worker and the main-thread fallback so both answer exactly alike.
 *
 * @param {{ data: ArrayLike<number>, width: number, height: number }} image  RGBA pixels
 * @param {{ prior?: Point[] }} [opts]
 * @returns {Detection}
 */
export function runDetection(image, opts = {}) {
  try {
    if (!isImage(image)) return failure('bad_input');
    const prior = opts && isQuad(opts.prior) ? copyQuad(opts.prior) : null;
    let result = detectDoor(image, prior ? { prior } : {});
    if (prior && result && !result.ok && result.reason === 'no_candidate_near_prior') result = detectDoor(image, {});
    return toDetection(result);
  } catch {
    return failure('error');
  }
}

/**
 * Run the detector in a module worker. Resolves null when no worker can be used (so the caller falls
 * back to the main thread), and a 'timeout' failure when the worker does not answer in time.
 *
 * @param {{ data: ArrayLike<number>, width: number, height: number }} image
 * @param {{ prior?: Point[] }} opts
 * @param {number} timeoutMs
 * @returns {Promise<Detection|null>}
 */
function detectInWorker(image, opts, timeoutMs) {
  if (typeof Worker !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let worker = null;
    let timer = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        try {
          worker.terminate();
        } catch {
          // Already gone.
        }
      }
      resolve(value);
    };
    try {
      worker = new Worker(new URL('./door-detect-worker.js', import.meta.url), { type: 'module' });
      const id = nextRequestId();
      worker.onmessage = (event) => {
        const message = event && event.data;
        if (!message || message.id !== id) return;
        finish(toDetection(message.result));
      };
      // A worker that cannot load (no module workers in this engine, a blocked script) or crashes, and a
      // reply that cannot be read, all mean: do it on the main thread instead.
      worker.onerror = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        finish(null);
      };
      worker.onmessageerror = () => finish(null);
      timer = setTimeout(() => finish(failure('timeout')), timeoutMs);
      const data = new Uint8ClampedArray(image.data); // the copy; photo.image keeps its own pixels
      worker.postMessage({ id, image: { data, width: image.width, height: image.height }, opts }, [data.buffer]);
    } catch {
      finish(null);
    }
  });
}

let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return requestCounter;
}

/**
 * The small, plain Detection the app stores in state.door.detection (drops the detector's debug fields).
 * @param {any} result  detectDoor output, or a message from the worker
 * @returns {Detection}
 */
function toDetection(result) {
  if (!result || typeof result !== 'object') return failure('error');
  if (result.ok === true && isQuad(result.quad)) {
    const confidence = Number.isFinite(result.confidence) ? Math.max(0, Math.min(1, result.confidence)) : 0;
    const alternatives = Array.isArray(result.alternatives) ? result.alternatives.filter(isQuad).map(copyQuad) : [];
    return { ok: true, quad: copyQuad(result.quad), confidence, alternatives };
  }
  return failure(typeof result.reason === 'string' && result.reason ? result.reason : 'error');
}

/** @param {string} reason */
function failure(reason) {
  return { ok: false, quad: null, confidence: 0, alternatives: [], reason };
}

/** @param {unknown} image */
function isImage(image) {
  return Boolean(
    image &&
      typeof image === 'object' &&
      image.data &&
      typeof image.data.length === 'number' &&
      Number.isInteger(image.width) &&
      Number.isInteger(image.height) &&
      image.width > 0 &&
      image.height > 0 &&
      image.data.length >= image.width * image.height * 4,
  );
}

/** @param {unknown} q */
function isQuad(q) {
  return Array.isArray(q) && q.length === 4 && q.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** @param {Point[]} q */
function copyQuad(q) {
  return q.map((p) => ({ x: p.x, y: p.y }));
}

/** @param {unknown} value */
function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveOr(value, fallback) {
  return isPositive(value) ? value : fallback;
}

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
