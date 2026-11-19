/**
 * The bundled demo photo, shared by the two screens that offer it:
 *   - the welcome screen's "Try it with a demo photo" shows the no-paper photo estimate ('estimate'), on a
 *     copy with the A4 sheet painted out (hideDemoSheet);
 *   - "Get set up" offers it for the paper method ('paper'), measured with the A4 sheet in the photo.
 *
 * Nothing here touches the DOM at import time, so the state helpers also run under Node.
 */
import { loadPhoto, setPhoto } from './photo.js';

/** The sheet taped to the door in the bundled demo photo: A4, whatever the customer picked. */
const DEMO_SHEET_MM = Object.freeze({ short: 210, long: 297 });

/** The ways a demo can be shown. Anything else is read as 'estimate', the welcome screen's default. */
const DEMO_METHODS = new Set(['estimate', 'paper']);

/**
 * The bundled demo photo, the lens it was taken with, and where the sheet taped to its door is.
 *
 * focal35mm: a PNG has no EXIF to say which lens took it, so without this the no-paper estimate would use
 * the 26 mm phone prior (js/estimate.js PHONE_DEFAULT_F35). The photo was rendered with focalPx 2100 on
 * its 2560 px diagonal (tools/scene.mjs DEMO_CAMERA): 2100 / 2560 x 43.27 mm = 35.5 mm. With the 26 mm
 * guess the estimate could never be sure of the demo door, even from its exact corners.
 *
 * sheetPx: the A4 sheet's corners in the photo's own width x height pixels (assets/demo-door.truth.json).
 * The paper demo measures from that sheet; the no-paper demo, offered right under "No tape measure, no
 * paper", must not show it, so it paints it out (hideDemoSheet).
 *
 * tests/app.test.mjs checks these numbers against tools/scene.mjs and the truth file.
 */
export const BUNDLED_DEMO_PHOTO = Object.freeze({
  path: 'assets/demo-door.png',
  focal35mm: 35.5,
  width: 1536,
  height: 2048,
  sheetPx: Object.freeze([
    Object.freeze({ x: 687.5687, y: 631.6597 }),
    Object.freeze({ x: 840.7633, y: 628.1637 }),
    Object.freeze({ x: 842.5069, y: 847.6283 }),
    Object.freeze({ x: 690.3957, y: 849.4387 }),
  ]),
});

/**
 * How far past the sheet's corners, in the bundled photo's pixels, hideDemoSheet repaints. The sheet's
 * soft contact shadow reaches 21 mm past its lower edge (tools/scene.mjs sheetShadow: 16 mm, pushed 5 mm
 * down), about 16 px at this distance, and the lens blur a pixel more: 24 px leaves none of it, and still
 * stays well inside the door's upper panel, whose smooth shading is what the fill carries across.
 */
const SHEET_CLEAR_PX = 24;

/** Base for reading a relative demo address; never fetched. */
const ADDRESS_BASE = 'https://app.invalid/';

/**
 * The demo photo's address from `config.measurement.demoPhotoUrl`, or '' when the company has none.
 * @param {object} config  the merged config
 * @returns {string}
 */
export function demoPhotoUrl(config) {
  const url = config && config.measurement ? config.measurement.demoPhotoUrl : '';
  return typeof url === 'string' ? url.trim() : '';
}

/**
 * The 35 mm-equivalent focal length of the demo photo at `url`, or null when the app does not know it.
 * Only the bundled photo's lens is known (BUNDLED_DEMO_PHOTO); a company's own demo photo is treated like
 * any other photo without EXIF.
 *
 * @param {unknown} url  the demo photo's address, as demoPhotoUrl() reads it
 * @returns {number | null}
 */
export function demoPhotoFocal35mm(url) {
  return isBundledDemo(url) ? BUNDLED_DEMO_PHOTO.focal35mm : null;
}

/**
 * Whether `url` is the bundled demo photo (whatever query it carries), the only one the app knows the
 * lens and the sheet of.
 * @param {unknown} url
 * @returns {boolean}
 */
function isBundledDemo(url) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  let address;
  try {
    address = new URL(url.trim(), ADDRESS_BASE);
  } catch {
    return false;
  }
  return `${address.origin}${address.pathname}` === `${ADDRESS_BASE}${BUNDLED_DEMO_PHOTO.path}`;
}

/**
 * Paint the taped sheet out of a loaded copy of the bundled demo photo, for the no-paper demo.
 *
 * The welcome screen offers that demo right under "No tape measure, no paper", and a door with a sheet
 * taped to it (also shown, flattened, on the result screen) tells a first-time visitor the opposite. The
 * paper demo needs the sheet, so the one photo serves both, and this runs on the no-paper copy only.
 *
 * The sheet sits in the middle of the door's upper panel, whose shading is smooth (a lighting gradient,
 * no grain or noise), so a Coons patch from the panel pixels just around the sheet and its shadow fills
 * the gap as the panel would have looked: exact for any shading that is bilinear across the box, and
 * within a level or two of the photo rendered with no sheet at all (tests/app.test.mjs). The pixels are
 * changed in place in photo.image, which the estimate, the result's preview and the door finder read,
 * and copied onto photo.canvas, which the door screen and the enquiry's photo draw from.
 *
 * Only for a photo with the bundled one's shape: the working copy may be scaled down (never cropped), so
 * the sheet is scaled with it; any other shape is not the bundled photo and is left alone.
 *
 * @param {{ image?: ImageData, canvas?: HTMLCanvasElement, _luma?: object|null }} photo  the loaded
 *   bundled demo photo (mutated)
 * @returns {boolean} true when the sheet was painted out
 */
export function hideDemoSheet(photo) {
  const image = photo ? photo.image : null;
  if (!image || !image.data || !(image.width >= 3) || !(image.height >= 3)) return false;
  const { width, height, data } = image;
  const sx = width / BUNDLED_DEMO_PHOTO.width;
  const sy = height / BUNDLED_DEMO_PHOTO.height;
  if (Math.abs(sx / sy - 1) > 0.01) return false;

  const xs = BUNDLED_DEMO_PHOTO.sheetPx.map((p) => p.x * sx);
  const ys = BUNDLED_DEMO_PHOTO.sheetPx.map((p) => p.y * sy);
  // The box repainted, inclusive, with a row and a column of untouched pixels on every side to fill from.
  const x0 = Math.max(1, Math.floor(Math.min(...xs) - SHEET_CLEAR_PX * sx));
  const x1 = Math.min(width - 2, Math.ceil(Math.max(...xs) + SHEET_CLEAR_PX * sx));
  const y0 = Math.max(1, Math.floor(Math.min(...ys) - SHEET_CLEAR_PX * sy));
  const y1 = Math.min(height - 2, Math.ceil(Math.max(...ys) + SHEET_CLEAR_PX * sy));
  if (x1 < x0 || y1 < y0) return false;

  const left = x0 - 1;
  const right = x1 + 1;
  const top = y0 - 1;
  const bottom = y1 + 1;
  const at = (x, y, c) => data[(y * width + x) * 4 + c];
  for (let c = 0; c < 3; c += 1) {
    const topLeft = at(left, top, c);
    const topRight = at(right, top, c);
    const bottomLeft = at(left, bottom, c);
    const bottomRight = at(right, bottom, c);
    for (let y = y0; y <= y1; y += 1) {
      const v = (y - top) / (bottom - top);
      const fromLeft = at(left, y, c);
      const fromRight = at(right, y, c);
      for (let x = x0; x <= x1; x += 1) {
        const u = (x - left) / (right - left);
        // Coons patch: the two straight-line blends between opposite sides, less the corners' blend,
        // which both of them count. The border pixels are outside the box, so the writes never reach them.
        const value =
          (1 - u) * fromLeft +
          u * fromRight +
          (1 - v) * at(x, top, c) +
          v * at(x, bottom, c) -
          ((1 - u) * (1 - v) * topLeft + u * (1 - v) * topRight + (1 - u) * v * bottomLeft + u * v * bottomRight);
        data[(y * width + x) * 4 + c] = Math.min(255, Math.max(0, Math.round(value)));
      }
    }
  }
  // A greyscale copy made before now would still show the sheet.
  photo._luma = null;
  const ctx = photo.canvas && typeof photo.canvas.getContext === 'function' ? photo.canvas.getContext('2d') : null;
  if (ctx) ctx.putImageData(image, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  return true;
}

/**
 * Load the bundled demo photo and make it the session's photo, ready for `method`.
 *
 * The caller wraps this in ctx.busy() (with anything else that belongs to the same wait, such as
 * finding the door) and moves on to the next screen itself. Pass `isCurrent` when the screen that asked
 * may have been left while the photo was loading: if it returns false once the photo has arrived, the
 * photo is dropped and nothing in the state changes, so a customer who has moved on (or started again,
 * which swaps in a new state) never finds the demo door in their session.
 *
 * @param {object} ctx  app context (config, state)
 * @param {{ method?: 'estimate' | 'paper', isCurrent?: () => boolean }} [options]
 * @returns {Promise<object>} the loaded photo, now `ctx.state.photo`
 * @throws {Error} Error('no_demo') when there is no demo photo, Error('demo_dropped') when `isCurrent`
 *   said no, or loadPhoto's Error('decode_failed')
 */
export async function loadDemo(ctx, { method = 'estimate', isCurrent } = {}) {
  const { config } = ctx;
  const url = demoPhotoUrl(config);
  if (!url) throw new Error('no_demo');
  const photo = await loadPhoto(url, config, { isDemo: true });
  if (typeof isCurrent === 'function' && !isCurrent()) {
    // iOS Safari counts every live canvas against a hard memory budget, so hand this one back now.
    if (photo.canvas) {
      photo.canvas.width = 0;
      photo.canvas.height = 0;
    }
    throw new Error('demo_dropped');
  }
  // The file cannot say which lens took it (see BUNDLED_DEMO_PHOTO); a focal length it does carry wins.
  if (photo.focal35mm == null) photo.focal35mm = demoPhotoFocal35mm(url);
  // The no-paper demo (anything but 'paper', as useDemoPhoto reads it) shows the door with no sheet on
  // it. Each demo loads its own copy, so the paper demo still finds the sheet it measures from.
  if (method !== 'paper' && isBundledDemo(url)) hideDemoSheet(photo);
  useDemoPhoto(ctx.state, photo, method, config.measurement || {});
  return photo;
}

/**
 * Make a loaded demo photo the session's photo: setPhoto (which clears everything worked out from the
 * previous photo), then the way in. The paper demo also points the state at an A4 sheet.
 *
 * @param {object} state        shared app state (mutated)
 * @param {object} photo        the loaded demo photo
 * @param {string} method       'estimate' or 'paper'
 * @param {object} measurement  config.measurement
 * @returns {void}
 */
export function useDemoPhoto(state, photo, method, measurement) {
  setPhoto(state, photo);
  // setPhoto leaves state.method alone on purpose: the caller says which way in this photo is for.
  state.method = DEMO_METHODS.has(method) ? method : 'estimate';
  if (state.method === 'paper') selectDemoReference(state, measurement);
}

/**
 * Forget a measurement read off the bundled demo photo, for a customer who has just said they will type
 * in their own door size ("I already know my door size").
 *
 * The result screen shows a measurement in preference to the typed-size form (resultMode in
 * js/screens/result.js), and leaving the demo does not clear it: "Measure my own door" only goes back to
 * the welcome screen. Without this, the customer who asked to type in their size would be shown the demo
 * door's size, and "Get my price" would price it.
 *
 * Kept, because they are the customer's own: a size they typed in over the demo, which the size form
 * then starts from; an AR reading, which measures the door in front of the phone even when the demo
 * photo is still loaded from an earlier try; and any measurement of their own photo, which the result
 * screen shows with the typed-size form open, as it always has. The demo photo stays loaded: the next
 * photo replaces it (setPhoto), and a typed-in size never sends it with the enquiry.
 *
 * @param {object} state  shared app state (mutated)
 * @returns {boolean} true when a demo measurement was dropped
 */
export function dropDemoMeasure(state) {
  const measure = state ? state.measure : null;
  const photo = state ? state.photo : null;
  // The same test as the door and result screens': either mark means the bundled demo photo.
  const isDemo = Boolean(photo) && (photo.isDemo === true || photo.capture === 'demo');
  // setPhoto clears state.measure, so a measure that is not an AR reading was taken from this photo.
  if (!measure || !isDemo || measure.method === 'ar') return false;
  state.measure = null;
  if (!state.size || state.size.source !== 'manual') state.size = null;
  return true;
}

/**
 * Point the state at an A4 reference so the demo photo measures correctly even if the customer
 * had chosen another sheet (or the company's default is not A4).
 *
 * That choice is not lost: it is set aside in state.ownReference for as long as the demo photo is
 * loaded. The prepare screen shows and edits it there, and puts it back into the state when the
 * customer's own photo replaces the demo photo.
 *
 * The no-paper demo needs no sheet at all, so it leaves the sheet choice exactly as it is.
 *
 * @param {object} state        shared app state (mutated)
 * @param {object} measurement  config.measurement
 * @returns {void}
 */
export function selectDemoReference(state, measurement) {
  // A second go at the demo finds the demo's A4 in the state, which is not the customer's choice.
  if (!state.ownReference) {
    state.ownReference = { referenceId: state.referenceId, customReference: state.customReference };
  }
  const references = measurement && Array.isArray(measurement.references) ? measurement.references : [];
  const a4 = references.find(
    (ref) =>
      ref &&
      Math.min(ref.widthMm, ref.heightMm) === DEMO_SHEET_MM.short &&
      Math.max(ref.widthMm, ref.heightMm) === DEMO_SHEET_MM.long,
  );
  if (a4) {
    state.referenceId = a4.id;
  } else {
    state.referenceId = 'custom';
    state.customReference = { widthMm: DEMO_SHEET_MM.short, heightMm: DEMO_SHEET_MM.long };
  }
}
