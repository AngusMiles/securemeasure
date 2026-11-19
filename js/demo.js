/**
 * The bundled demo photo, shared by the two screens that offer it:
 *   - the welcome screen's "Try it with a demo photo" shows the no-paper photo estimate ('estimate');
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
 * The bundled demo photo and the lens it was taken with, as a 35 mm-equivalent focal length.
 *
 * A PNG has no EXIF to say which lens took it, so without this the no-paper estimate would use the 26 mm
 * phone prior (js/estimate.js PHONE_DEFAULT_F35). The photo was rendered with focalPx 2100 on its 2560 px
 * diagonal (tools/scene.mjs DEMO_CAMERA): 2100 / 2560 x 43.27 mm = 35.5 mm. With the 26 mm guess the
 * estimate could never be sure of the demo door, even from its exact corners. tests/app.test.mjs checks
 * this number against tools/scene.mjs.
 */
export const BUNDLED_DEMO_PHOTO = Object.freeze({ path: 'assets/demo-door.png', focal35mm: 35.5 });

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
  if (typeof url !== 'string' || url.trim() === '') return null;
  let address;
  try {
    address = new URL(url.trim(), ADDRESS_BASE);
  } catch {
    return null;
  }
  const bundled = `${ADDRESS_BASE}${BUNDLED_DEMO_PHOTO.path}`;
  return `${address.origin}${address.pathname}` === bundled ? BUNDLED_DEMO_PHOTO.focal35mm : null;
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
