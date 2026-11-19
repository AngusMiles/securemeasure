/**
 * Live camera for the "Allow camera" screen (js/screens/capture.js): open the rear camera in the page,
 * take one still of the door, and the geometry that ties the on-screen guide to that still.
 *
 * Why a live camera at all, when `<input type=file capture>` exists (research, Nov 2026,
 * scratchpad hybrid\results\camera.json):
 *  - On iPhone, WebKit re-encodes a camera shot from `<input capture>` and drops all EXIF, so the photo
 *    arrives with no focal length. ImageCapture.takePhoto() (Safari / iOS 18.4+, and Chrome) returns the
 *    camera's own JPEG, which may carry EXIF FocalLengthIn35mmFilm; js/estimate.js uses it when present.
 *  - The live view lets us draw a door-shaped guide, and the guide tells the door detector where to look
 *    (a "prior"), which in the research simulation took the median corner error from 60 to 11 px.
 * The native file inputs stay on the screen as fallbacks: they need no site permission and work in more
 * in-app browsers.
 *
 * The pure helpers at the top (coverMapping ... cameraConstraints) touch nothing global and are tested
 * under Node. startCamera / stopCamera / capturePhoto use browser APIs only when called, so importing
 * this module under Node is safe.
 */
import { readJpegInfo } from './photo.js';

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect  in px, x/y = top-left corner
 * @typedef {{ scale: number, offsetX: number, offsetY: number }} CoverMapping
 *   view = source * scale + offset (per axis); see coverMapping
 * @typedef {'blocked' | 'unavailable' | 'busy' | 'insecure' | 'unknown'} CameraErrorKind
 */

/**
 * Shape of the guide: the height-to-width ratio of a door opening as it looks in a photo taken square on.
 * Standard openings run from about 2.2 (920 x 2040) to 2.8 (720 x 2040), 2.5 for the common 820 x 2040.
 * The detector only uses the guide as a rough prior (every corner within 20 % of its height), so one
 * middle-of-the-range shape serves them all.
 */
const GUIDE_ASPECT = 2.4;
/**
 * The guide fills about three quarters of the viewfinder's height. A door framed like that is 2-3 big
 * steps away with a phone's main lens, its corners stay well clear of the photo edges (the estimate flags
 * a corner within 1 % of an edge), and it is far above the "door is too small" limit (30 % of the height).
 */
const GUIDE_HEIGHT_FRACTION = 0.76;
/** Never wider than this share of the view (only matters in a very short, wide view). */
const GUIDE_MAX_WIDTH_FRACTION = 0.8;
/**
 * Room kept free above the guide for the hint pill drawn over the top of the viewfinder (two lines of
 * small text plus its offset), and at most this share of a short view.
 */
const GUIDE_TOP_RESERVE_PX = 64;
const GUIDE_TOP_RESERVE_MAX_FRACTION = 0.22;
/** A sliver kept free below the guide. */
const GUIDE_BOTTOM_MARGIN_FRACTION = 0.04;

/**
 * Two frames whose aspect ratios agree this closely are treated as the same field of view. Video and
 * photo sizes are rounded to whole (often even) pixels, so 4:3 is never exactly 4:3.
 */
const SAME_ASPECT_TOLERANCE = 0.02;
/** A frame within this of square is neither portrait nor landscape (see mapRectToFrame). */
const SQUARE_TOLERANCE = 0.1;
/** A prior smaller than this share of the photo height says nothing useful about where the door is. */
const MIN_PRIOR_HEIGHT_FRACTION = 0.1;

/** JPEG quality of a grabbed video frame: high, because the customer marks corners on it. */
const FRAME_JPEG_QUALITY = 0.92;
/** How much of a still capturePhoto reads for its EXIF orientation and frame size (both sit at the start). */
const STILL_HEAD_BYTES = 256 * 1024;
/**
 * How long startCamera waits for video.play(). A live stream normally starts playing at once; a play()
 * that never settles must not leave the screen stuck on "starting" (the screen also listens for the
 * video's own 'playing' event, so a late start is still picked up).
 */
const PLAY_TIMEOUT_MS = 5000;
/** getUserMedia errors worth one more try with plainer constraints (see startCamera). */
const RETRY_ERROR_NAMES = new Set(['NotReadableError', 'TrackStartError', 'AbortError', 'OverconstrainedError', 'ConstraintNotSatisfiedError']);

/** Error names (current and legacy) behind each kind of camera failure the screen explains. */
const ERROR_KINDS = new Map([
  // The customer (or a policy) said no. Chrome also reports a dismissed prompt this way, and after three
  // dismissals blocks the site silently for a week, which looks the same.
  ['NotAllowedError', 'blocked'],
  ['PermissionDeniedError', 'blocked'],
  ['PermissionDismissedError', 'blocked'],
  ['SecurityError', 'blocked'],
  // No camera to open, or none that matches (our constraints are all `ideal`, so after the plain retry
  // this means there is no camera at all).
  ['NotFoundError', 'unavailable'],
  ['DevicesNotFoundError', 'unavailable'],
  ['OverconstrainedError', 'unavailable'],
  ['ConstraintNotSatisfiedError', 'unavailable'],
  ['NotSupportedError', 'unavailable'],
  ['TypeError', 'unavailable'],
  // The camera exists but would not start: another app (a call, the Camera app) has it.
  ['NotReadableError', 'busy'],
  ['TrackStartError', 'busy'],
  ['AbortError', 'busy'],
  // Ours (startCamera): the page is not https, so the browser offers no camera at all.
  ['InsecureContextError', 'insecure'],
]);

// ---- Pure helpers ------------------------------------------------------------------------------

/** @param {unknown} value */
function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** @param {unknown} rect */
function isRect(rect) {
  return (
    Boolean(rect) &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

/**
 * How a source image of srcW x srcH px is drawn into a view of viewW x viewH px by CSS
 * `object-fit: cover` (centred, scaled up or down until it fills the view, the overflow cropped):
 * `viewX = srcX * scale + offsetX`, `viewY = srcY * scale + offsetY`. The offsets are <= 0, since the
 * source overhangs the view on the cropped axis.
 *
 * @param {number} srcW  intrinsic width (for a <video>, videoWidth)
 * @param {number} srcH
 * @param {number} viewW  rendered width of the element in CSS px
 * @param {number} viewH
 * @returns {CoverMapping | null} null when any size is not a positive number
 */
export function coverMapping(srcW, srcH, viewW, viewH) {
  if (!isPositive(srcW) || !isPositive(srcH) || !isPositive(viewW) || !isPositive(viewH)) return null;
  const scale = Math.max(viewW / srcW, viewH / srcH);
  return {
    scale,
    offsetX: (viewW - srcW * scale) / 2,
    offsetY: (viewH - srcH * scale) / 2,
  };
}

/**
 * A rectangle in view px (e.g. the guide drawn over the viewfinder) in the source image's px, through
 * a coverMapping. The inverse of drawing: `srcX = (viewX - offsetX) / scale`.
 *
 * @param {Rect} rect
 * @param {CoverMapping | null} mapping
 * @returns {Rect | null} null when the rect or the mapping is unusable
 */
export function viewRectToSource(rect, mapping) {
  if (!isRect(rect) || !mapping || !isPositive(mapping.scale)) return null;
  if (!Number.isFinite(mapping.offsetX) || !Number.isFinite(mapping.offsetY)) return null;
  return {
    x: (rect.x - mapping.offsetX) / mapping.scale,
    y: (rect.y - mapping.offsetY) / mapping.scale,
    width: rect.width / mapping.scale,
    height: rect.height / mapping.scale,
  };
}

/**
 * The door-shaped guide drawn over a viewfinder of viewW x viewH px: a tall rectangle about three
 * quarters of the view's height (GUIDE_ASPECT tall to 1 wide), centred across, and centred down unless
 * that would put it under the hint pill at the top, in which case it sits just below the pill.
 *
 * @param {number} viewW
 * @param {number} viewH
 * @returns {Rect | null} in view px; null when the view has no size yet
 */
export function guideRect(viewW, viewH) {
  if (!isPositive(viewW) || !isPositive(viewH)) return null;
  const reserve = Math.min(GUIDE_TOP_RESERVE_PX, viewH * GUIDE_TOP_RESERVE_MAX_FRACTION);
  const bottomMargin = viewH * GUIDE_BOTTOM_MARGIN_FRACTION;
  let height = Math.min(viewH * GUIDE_HEIGHT_FRACTION, viewH - reserve - bottomMargin);
  let width = height / GUIDE_ASPECT;
  if (width > viewW * GUIDE_MAX_WIDTH_FRACTION) {
    width = viewW * GUIDE_MAX_WIDTH_FRACTION;
    height = width * GUIDE_ASPECT;
  }
  const y = Math.min(Math.max((viewH - height) / 2, reserve), viewH - height);
  return { x: (viewW - width) / 2, y: Math.max(0, y), width, height };
}

/**
 * Carry a rectangle from one picture of the camera's view to another picture of the same view taken at
 * a different size: from the live video frame to the still that takePhoto() returned, say.
 *
 * Both are assumed to be centred crops of the same sensor, each spanning it fully in one direction (how
 * both phone browsers serve a stream or a photo whose aspect ratio differs from the sensor's). Phone
 * sensors are 4:3, so of two pictures the one whose long-to-short ratio is closer to square is the fuller
 * view: a 16:9 video is the middle band of a 4:3 photo. Pictures of the same shape simply scale.
 *
 * One known blind spot: Chrome on Android crops the preview for stabilisation by an amount the page
 * cannot see, so a video rect lands a little too large (about the middle) in the still. For a detection
 * prior that is close enough.
 *
 * @param {Rect} rect  in `from` px
 * @param {number} fromW
 * @param {number} fromH
 * @param {number} toW
 * @param {number} toH
 * @returns {Rect | null} in `to` px (not clipped); null when the inputs are unusable or one picture is
 *   portrait and the other landscape (a camera that left its JPEG unrotated: the two do not line up)
 */
export function mapRectToFrame(rect, fromW, fromH, toW, toH) {
  if (!isRect(rect) || !isPositive(fromW) || !isPositive(fromH) || !isPositive(toW) || !isPositive(toH)) return null;
  const fromAspect = fromW / fromH;
  const toAspect = toW / toH;
  if (turnedAgainst(fromW, fromH, toW, toH)) return null;

  // Where the whole `from` picture lies in `to` px.
  let region;
  if (Math.abs(Math.log(fromAspect / toAspect)) <= Math.log(1 + SAME_ASPECT_TOLERANCE)) {
    region = { x: 0, y: 0, width: toW, height: toH };
  } else {
    const ratio = (aspect) => Math.max(aspect, 1 / aspect);
    // `from` the narrower crop: it fits inside `to` (contain). Otherwise it overhangs `to` (cover).
    const fit = ratio(fromAspect) >= ratio(toAspect) ? Math.min : Math.max;
    const scale = fit(toW / fromW, toH / fromH);
    const width = fromW * scale;
    const height = fromH * scale;
    region = { x: (toW - width) / 2, y: (toH - height) / 2, width, height };
  }
  const sx = region.width / fromW;
  const sy = region.height / fromH;
  return {
    x: region.x + rect.x * sx,
    y: region.y + rect.y * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
}

/**
 * Whether one picture is portrait and the other landscape. A picture within SQUARE_TOLERANCE of square
 * is neither, so it is never turned against anything. Sizes must be positive numbers.
 *
 * @param {number} aW
 * @param {number} aH
 * @param {number} bW
 * @param {number} bH
 * @returns {boolean}
 */
function turnedAgainst(aW, aH, bW, bH) {
  const nearSquare = (aspect) => Math.abs(Math.log(aspect)) <= Math.log(1 + SQUARE_TOLERANCE);
  const a = aW / aH;
  const b = bW / bH;
  return !nearSquare(a) && !nearSquare(b) && a > 1 !== b > 1;
}

/**
 * A rectangle as the four corners of a quad, in the order the editor and the detector use.
 * @param {Rect} rect
 * @returns {Point[]} [TL, TR, BR, BL]
 */
export function rectToQuad(rect) {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return [
    { x: rect.x, y: rect.y },
    { x: right, y: rect.y },
    { x: right, y: bottom },
    { x: rect.x, y: bottom },
  ];
}

/**
 * The on-screen guide as a door-detection prior in photo px (findDoor's `prior`): guide (view px) ->
 * the video frame behind it (object-fit: cover) -> the captured photo (normalised to its size, see
 * mapRectToFrame) -> clipped to the photo.
 *
 * Only meaningful for a photo taken from this live view ('live' or 'frame'); a picked file has no guide.
 *
 * @param {object} view  what was on screen when the shutter was pressed
 * @param {Rect} view.guide     guide rect in view px
 * @param {number} view.viewW   rendered size of the <video>
 * @param {number} view.viewH
 * @param {number} view.videoW  video.videoWidth / videoHeight at that moment
 * @param {number} view.videoH
 * @param {number} view.photoW  size of the photo the detector runs on (photo.width / height)
 * @param {number} view.photoH
 * @returns {Point[] | null} [TL, TR, BR, BL], or null when there is no sensible prior
 */
export function priorFromGuide({ guide, viewW, viewH, videoW, videoH, photoW, photoH } = {}) {
  const inVideo = viewRectToSource(guide, coverMapping(videoW, videoH, viewW, viewH));
  if (!inVideo) return null;
  const inPhoto = mapRectToFrame(inVideo, videoW, videoH, photoW, photoH);
  if (!inPhoto) return null;
  const left = Math.max(0, inPhoto.x);
  const top = Math.max(0, inPhoto.y);
  const right = Math.min(photoW, inPhoto.x + inPhoto.width);
  const bottom = Math.min(photoH, inPhoto.y + inPhoto.height);
  if (!(right > left) || !(bottom - top >= photoH * MIN_PRIOR_HEIGHT_FRACTION)) return null;
  return rectToQuad({ x: left, y: top, width: right - left, height: bottom - top });
}

/**
 * What kind of failure a camera error is, for the screen to explain:
 *  - 'blocked'      the customer or the browser said no (NotAllowedError and its relatives)
 *  - 'unavailable'  no camera, or no camera API, in this browser
 *  - 'busy'         the camera exists but would not start (another app has it)
 *  - 'insecure'     the page is not https, so the browser offers no camera
 *  - 'unknown'      anything else
 *
 * @param {unknown} error  what getUserMedia / startCamera rejected with (DOMException, Error, or junk)
 * @returns {CameraErrorKind}
 */
export function cameraErrorKind(error) {
  const name = error && typeof error === 'object' && typeof error.name === 'string' ? error.name : '';
  return ERROR_KINDS.get(name) || 'unknown';
}

/**
 * The getUserMedia request: the rear camera, 4:3 at 1920 x 1440, no sound. A new object every call.
 *
 * Why these numbers (research, scratchpad hybrid\results\camera.json):
 *  - Everything is `ideal`, never `exact`: a laptop or a phone without a rear camera still gets a camera
 *    rather than an OverconstrainedError.
 *  - 4:3 because that is the whole phone sensor, the same field of view as the still; 16:9 would crop the
 *    top and bottom off.
 *  - Sizes in landscape (sensor) terms, width > height, even for a phone held upright: both engines match
 *    them against the sensor's native landscape formats and then rotate. A portrait request can push
 *    WebKit into cropping.
 *  - 1920 x 1440 is about 1.7 mm per pixel on a door 2.5 m away; the full-size still comes from
 *    takePhoto() anyway.
 *  - No zoom: in Chrome it pulls in the pan-tilt-zoom permission, and the default is the 1x main lens.
 *
 * @returns {MediaStreamConstraints}
 */
export function cameraConstraints() {
  return {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
      aspectRatio: { ideal: 4 / 3 },
    },
    audio: false,
  };
}

/** The plainer request startCamera tries once when the first one fails to start the camera. */
function plainConstraints() {
  return { video: { facingMode: { ideal: 'environment' } }, audio: false };
}

/**
 * Settle with `promise`, or reject with Error('timeout') after `ms`. The timer is cleared either way.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), Math.max(0, ms));
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** An Error with a DOMException-style name, for failures startCamera detects itself. */
function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

// ---- Browser helpers ---------------------------------------------------------------------------

/**
 * Open the rear camera and show it in `video`.
 *
 * getUserMedia is called synchronously, before anything is awaited, so a tap that calls this keeps its
 * user gesture (iOS needs one for the permission prompt to feel expected, and for play()).
 *
 * The video is set up the way iOS insists on (muted, playsinline: otherwise it refuses to play or goes
 * full screen), given the stream, and played. iOS can still refuse play() without a fresh tap
 * (NotAllowedError); the stream is then kept and returned with `playing: false`, and the screen shows its
 * "Allow camera" button, whose tap calls video.play() again.
 *
 * If the camera would not start (NotReadableError: often a stream that is still closing, or another app;
 * AbortError; OverconstrainedError) it is asked once more with only `facingMode`.
 *
 * `signal` lets the caller drop a request it no longer wants while the browser is still deciding: a
 * prompt the page can be used around (Firefox for Android's, on the address bar) can be left unanswered
 * for ever, so the screen must be able to ask again without waiting for it. getUserMedia itself cannot
 * be called off, so once it settles an aborted request stops its stream at once, never touches `video`
 * (a newer request's stream may be on it by then) and rejects with an 'AbortError'.
 *
 * @param {HTMLVideoElement} video
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ stream: MediaStream, track: MediaStreamTrack, playing: boolean }>}
 * @throws the getUserMedia error (classify it with cameraErrorKind), an 'InsecureContextError' on an http
 *   page, a 'NotSupportedError' when this browser has no getUserMedia, or an 'AbortError' once `signal`
 *   has aborted
 */
export async function startCamera(video, { signal } = {}) {
  const nav = globalThis.navigator;
  const devices = nav && nav.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== 'function') {
    // Browsers hide navigator.mediaDevices entirely outside https (and localhost).
    if (globalThis.isSecureContext === false) throw namedError('InsecureContextError', 'camera needs a secure context');
    throw namedError('NotSupportedError', 'getUserMedia is not available');
  }

  const dropped = () => Boolean(signal && signal.aborted);
  prepareVideo(video);
  let stream;
  try {
    stream = await devices.getUserMedia(cameraConstraints());
  } catch (error) {
    if (!error || !RETRY_ERROR_NAMES.has(error.name) || dropped()) throw error;
    stream = await devices.getUserMedia(plainConstraints());
  }
  if (dropped()) {
    stopCamera(stream);
    throw namedError('AbortError', 'the camera request was dropped');
  }

  const track = stream && typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks()[0] : null;
  if (!track) {
    stopCamera(stream);
    throw namedError('NotFoundError', 'the stream has no video track');
  }

  video.srcObject = stream;
  let playing = true;
  try {
    await withTimeout(video.play(), PLAY_TIMEOUT_MS);
  } catch {
    // NotAllowedError (iOS without a fresh tap) above all; also a play() that never settles. The stream
    // is fine, so keep it: the screen asks for a tap and calls play() again.
    playing = false;
  }
  return { stream, track, playing };
}

/**
 * The attributes iOS needs before it will play a camera stream inline.
 * @param {HTMLVideoElement} video
 */
function prepareVideo(video) {
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  if (typeof video.setAttribute === 'function') {
    // The attributes too: older WebKit reads `playsinline` only from the markup.
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('muted', '');
  }
  if ('disablePictureInPicture' in video) video.disablePictureInPicture = true;
}

/**
 * Stop every track of a stream, so the camera (and its "in use" light) is released straight away.
 * Leaving one running would also stop the AR screen from starting its own session.
 * Safe to call with null or a stream that is already stopped.
 *
 * @param {MediaStream | null | undefined} stream
 */
export function stopCamera(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track that is already gone has nothing left to release.
    }
  }
}

/**
 * Take one still from the live camera.
 *
 * ImageCapture.takePhoto() first (Chrome; Safari on iOS 18.4+): the camera's own full-resolution JPEG,
 * from the whole sensor (no stabilisation crop) and possibly with EXIF focal length. It is asked for the
 * largest size the camera offers, in landscape order (larger number first): with no size iOS returns its
 * smallest photo, and a portrait-order size can make it jump to a 48 MP one. The flash is turned off
 * where that can be chosen, because flash glare on a glossy door hides its edges.
 *
 * If that is missing, fails or takes longer than `timeoutMs` (the first iOS shot reconfigures the camera;
 * Chrome restarts its capture session), the video frame that was showing when this was called is encoded
 * as a JPEG at the video's own size instead. That frame is copied before takePhoto is even asked: the
 * preview keeps running meanwhile, and seconds later the phone may point at the floor, while the guide
 * prior the caller noted belongs to the moment of the press. A video frame has no EXIF, so the estimate
 * assumes a typical phone lens.
 *
 * The frame also stands in for a still that comes back turned against the live view (portrait when the
 * video was landscape, or the other way round, once its EXIF orientation is applied). WebKit never sets
 * the orientation of the connection its takePhoto() output uses, so on an iPhone or iPad held on its
 * side the JPEG says the camera's default way up while the live frames follow the phone (seen in
 * WebKit's AVVideoCaptureSource.mm); an Android camera that ignores JPEG_ORIENTATION does the same. Kept,
 * that still would put the door on its side: the customer would mark a sideways door and the estimate
 * would read its height-to-width ratio upside down. Which way to turn it back cannot be told from the
 * file, whereas the frame is exactly what the customer saw.
 *
 * The stream is left running; the caller stops it.
 *
 * @param {{ track: MediaStreamTrack | null, video: HTMLVideoElement, timeoutMs?: number }} options
 * @returns {Promise<{ blob: Blob, capture: 'live' | 'frame' }>}
 * @throws Error('no_frame') when takePhoto gave nothing and the video had no frame to copy
 */
export async function capturePhoto({ track, video, timeoutMs = 4000 } = {}) {
  // Before anything is awaited, so it is the frame the customer framed.
  const frame = snapshotFrame(video);
  try {
    if (typeof globalThis.ImageCapture === 'function' && track && track.readyState === 'live') {
      try {
        const blob = await withTimeout(takeStill(track), timeoutMs);
        if (isUsableBlob(blob) && !(frame && (await stillTurnedAgainst(blob, frame.width, frame.height)))) {
          return { blob, capture: 'live' };
        }
      } catch {
        // Unsupported on this camera, the track ended, or too slow: the frame copied above still works.
      }
    }
    if (!frame) throw new Error('no_frame');
    return { blob: await encodeFrame(frame), capture: 'frame' };
  } finally {
    // iOS counts every live canvas against a hard memory budget; hand this one back now.
    releaseCanvas(frame);
  }
}

/**
 * @param {MediaStreamTrack} track
 * @returns {Promise<Blob>}
 */
async function takeStill(track) {
  const imageCapture = new globalThis.ImageCapture(track);
  const options = {};
  let capabilities = null;
  try {
    capabilities = typeof imageCapture.getPhotoCapabilities === 'function' ? await imageCapture.getPhotoCapabilities() : null;
  } catch {
    capabilities = null;
  }
  let size = rangeMaxSize(capabilities && capabilities.imageWidth, capabilities && capabilities.imageHeight);
  if (!size && typeof track.getSettings === 'function') {
    // No photo sizes on offer: ask for at least the stream's own size rather than iOS's smallest photo.
    const settings = track.getSettings() || {};
    if (isPositive(settings.width) && isPositive(settings.height)) size = [settings.width, settings.height];
  }
  if (size) {
    options.imageWidth = Math.max(size[0], size[1]);
    options.imageHeight = Math.min(size[0], size[1]);
  }
  if (capabilities && Array.isArray(capabilities.fillLightMode) && capabilities.fillLightMode.includes('off')) {
    options.fillLightMode = 'off';
  }
  return imageCapture.takePhoto(options);
}

/**
 * The largest width and height of two MediaSettingsRange-like objects, or null.
 * @param {{ max?: number } | undefined} width
 * @param {{ max?: number } | undefined} height
 * @returns {[number, number] | null}
 */
function rangeMaxSize(width, height) {
  const w = width && width.max;
  const h = height && height.max;
  return isPositive(w) && isPositive(h) ? [w, h] : null;
}

/** @param {unknown} blob */
function isUsableBlob(blob) {
  return Boolean(blob) && typeof blob === 'object' && typeof blob.size === 'number' && blob.size > 0;
}

/**
 * Whether a still from takePhoto() shows the other way up from a video frame of frameW x frameH px, once
 * its EXIF orientation is applied (as loadPhoto decodes it). A still whose header cannot be read (not a
 * JPEG, cut short) gives no sign either way and counts as not turned.
 *
 * @param {Blob} blob
 * @param {number} frameW
 * @param {number} frameH
 * @returns {Promise<boolean>}
 */
async function stillTurnedAgainst(blob, frameW, frameH) {
  let info;
  try {
    info = readJpegInfo(new Uint8Array(await blob.slice(0, STILL_HEAD_BYTES).arrayBuffer()));
  } catch {
    return false;
  }
  if (!info || !isPositive(info.width) || !isPositive(info.height) || !isPositive(frameW) || !isPositive(frameH)) return false;
  // EXIF orientations 5-8 turn the stored picture a quarter turn, which swaps its sides.
  const quarterTurn = info.orientation >= 5 && info.orientation <= 8;
  const shownW = quarterTurn ? info.height : info.width;
  const shownH = quarterTurn ? info.width : info.height;
  return turnedAgainst(shownW, shownH, frameW, frameH);
}

/**
 * A copy of the video's current frame on a canvas, at the video's intrinsic size (videoWidth x
 * videoHeight, already rotated upright by the browser), never the cropped part the viewfinder shows: the
 * corners the customer marks and the guide prior are both worked out against the whole frame.
 * Synchronous, so it is the frame on screen now. The caller releases the canvas (releaseCanvas).
 *
 * @param {HTMLVideoElement} video
 * @returns {HTMLCanvasElement | null} null when the video has no frame yet (or no canvas can be had)
 */
function snapshotFrame(video) {
  const width = video ? video.videoWidth : 0;
  const height = video ? video.videoHeight : 0;
  const doc = globalThis.document;
  if (!isPositive(width) || !isPositive(height) || !doc || typeof doc.createElement !== 'function') return null;
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no_frame');
    context.drawImage(video, 0, 0, width, height);
    return canvas;
  } catch {
    releaseCanvas(canvas);
    return null;
  }
}

/**
 * @param {HTMLCanvasElement} canvas  from snapshotFrame
 * @returns {Promise<Blob>} the frame as a JPEG
 */
async function encodeFrame(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', FRAME_JPEG_QUALITY));
  if (!isUsableBlob(blob)) throw new Error('no_frame');
  return blob;
}

/** @param {HTMLCanvasElement | null} canvas */
function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Whether a 'blocked' camera error (see cameraErrorKind) most likely comes from the site that embeds this
 * page, not from the customer: an iframe from another site that lacks allow="camera" fails getUserMedia
 * with NotAllowedError, exactly as a refused prompt does. Site settings cannot change that, and asking
 * again fails the same way every time.
 *
 * Outside an iframe: false. Inside one, the browser's own policy answer where it gives one (Chrome's
 * document.featurePolicy); otherwise (Safari) true, as the camera app is then the sure way on anyway.
 *
 * @param {Window} [win]
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function embedBlocksCamera(win = globalThis.window, doc = globalThis.document) {
  if (!win) return false;
  let framed;
  try {
    framed = win.self !== win.top;
  } catch {
    // Reading top can only fail inside a frame.
    framed = true;
  }
  if (!framed) return false;
  const policy = doc && (doc.permissionsPolicy || doc.featurePolicy);
  if (policy && typeof policy.allowsFeature === 'function') {
    try {
      return !policy.allowsFeature('camera');
    } catch {
      // No answer: as for a browser without the API.
    }
  }
  return true;
}
