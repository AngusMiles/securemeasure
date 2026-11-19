/**
 * Details screen: the customer's contact details and the "go ahead" enquiry.
 * Validates the form, builds the lead payload, hands it to submitLead and moves on
 * to the confirmation screen.
 */

import { validateCustomer, buildLeadPayload, submitLead, leadMode } from '../lead.js';
import { applyMeasurementRules, calculateQuote, formatMoney, formatLength } from '../quote.js';
import { photoToJpegDataUrl } from '../photo.js';
// The AR result screen's own test for "a standard size is on offer", so the lead says what it showed.
import { closestStandard } from './result-standard.js';

/** Screen id, used for routing and the `sm-screen--details` class. */
export const id = 'details';

/** Progress step this screen belongs to. */
export const step = 4;

/** Default copy for this screen; any key can be overridden through `config.text`. */
export const strings = {
  'details.title': 'Almost done',
  'details.subtitle': 'Where should we send your quote, and who should we call to book your free check measure?',
  'details.summaryLabel': 'Your order summary',
  'details.summarySize': 'Size',
  'details.sizeValue': '{width} wide × {height} high',
  // Under the size when it was not measured exactly, so the summary does not read as a made-to-measure size.
  'details.sizeEstimate': 'Standard size estimate, confirmed at your check measure',
  'details.sizeAr': 'AR estimate, confirmed at your check measure',
  'details.summaryProduct': 'Door',
  'details.summaryTotal': 'Estimated total',
  'details.summaryPrice': 'Price',
  'details.taxNote': 'inc. {tax}',
  'details.customQuote': 'Custom quote',
  'details.formLabel': 'Your details',
  'details.optional': '{label} (optional)',
  'details.consentFallback': 'I agree to be contacted about my quote.',
  'details.privacy': '{brand} only uses your details to prepare your quote and book your check measure.',
  'details.demoChip': 'Demo mode: nothing is sent',
  // Shown when the size came from the bundled demo photo (not the same thing as demo mode above).
  'details.demoDoor': "This size and price are for our demo door, not your own door. We'll mark your enquiry as a demo.",
  'details.submit': 'Send my enquiry',
  'details.sending': 'Sending…',
  'details.fixErrors': 'Please check the highlighted details.',
  'details.sendFailed': "We couldn't send that. Please try again.",
  'details.sendFailedCall': 'Or call us on {phone}',
};

const FORM_ID = 'sm-details-form';
const DEFAULT_INPUTMODE = { tel: 'tel', email: 'email' };

/** The note under the summary's size, by state.size.source. Paper and typed sizes need none. */
const SIZE_NOTES = { estimate: 'details.sizeEstimate', ar: 'details.sizeAr' };

// The result screen's "Which is your door?" list (estimateChoices in js/screens/result-standard.js):
// at most this many standard sizes, the most likely one always and each other one at least this
// likely. The lead's `alternatives` are the ones of these the customer did not pick, so the company
// hears about exactly the sizes the customer was offered.
const OFFERED_SIZES = 3;
const OFFERED_MIN_P = 0.05;

// 'consent' belongs to the checkbox; the others must never be written as keys of state.customer.
const RESERVED_FIELD_IDS = new Set(['', 'consent', '__proto__', 'constructor', 'prototype']);

// The send in flight, if any; resolves to whether it succeeded. Kept outside mount() so that
// leaving this screen mid-send and coming back cannot start a second one.
let inFlight = null;

/**
 * Route guard: the customer needs a final size and a chosen product first.
 * @param {object} state shared app state
 * @returns {boolean}
 */
export function canEnter(state) {
  return Boolean(state && state.size && state.quoteInput && state.quoteInput.productId);
}

/**
 * Build the screen inside `root`.
 * @param {HTMLElement} root the empty <section> for this screen
 * @param {object} ctx app context (config, t, state, go, toast, emit, ui, ...)
 * @returns {() => void} cleanup
 */
export function mount(root, ctx) {
  const { config, ui } = ctx;
  const state = ctx.state;
  const t = (key, vars) => ctx.t(key, vars);
  if (!state.customer) state.customer = {};

  // The quote screen leaves state.quote in step with state.size, but a history jump can land
  // here after the size was changed on the result screen. Re-pricing is cheap and keeps the
  // summary and the enquiry consistent with the size they are sent with.
  state.quote = calculateQuote(config, {
    widthMm: state.size.widthMm,
    heightMm: state.size.heightMm,
    productId: state.quoteInput.productId,
    selections: state.quoteInput.selections ?? {},
    includeInstallation: state.quoteInput.includeInstallation,
  });

  // `p &&`: a product block deleted from the config with its comma left behind leaves a hole in the list.
  const products = Array.isArray(config.pricing?.products) ? config.pricing.products : [];
  const product = products.find((p) => p && p.id === state.quoteInput.productId) ?? null;
  const phone = String(config.brand?.phone ?? '').trim();

  let sending = false;
  let disposed = false;

  // Each entry: { key, control, read }, in the order the customer sees them.
  const controls = [];

  for (const fieldCfg of config.lead?.fields ?? []) {
    if (!fieldCfg || typeof fieldCfg.id !== 'string' || RESERVED_FIELD_IDS.has(fieldCfg.id)) continue;
    const type = fieldCfg.type || 'text';
    const label = fieldCfg.label ?? fieldCfg.id;
    const control = ui.field({
      id: `sm-details-${fieldCfg.id}`,
      label: fieldCfg.required ? label : t('details.optional', { label }),
      type,
      value: state.customer[fieldCfg.id] ?? '',
      required: Boolean(fieldCfg.required),
      autocomplete: fieldCfg.autocomplete,
      inputmode: fieldCfg.inputmode ?? DEFAULT_INPUTMODE[type],
      placeholder: fieldCfg.placeholder,
      hint: fieldCfg.hint,
      rows: type === 'textarea' ? 3 : undefined,
      onInput: (value) => {
        state.customer[fieldCfg.id] = value;
        control.setError(null);
      },
    });
    if (!control.input.name) control.input.name = fieldCfg.id;
    controls.push({ key: fieldCfg.id, control, read: () => control.input.value });
  }

  const consent = ui.checkbox({
    id: 'sm-details-consent',
    label: config.lead?.consentText || t('details.consentFallback'),
    checked: state.customer.consent === true,
    onChange: (checked) => {
      state.customer.consent = checked;
      consent.setError(null);
    },
  });
  controls.push({ key: 'consent', control: consent, read: () => consent.input.checked === true });

  const form = ui.h(
    'form',
    {
      id: FORM_ID,
      class: 'sm-details-form',
      attrs: { novalidate: '', 'aria-label': t('details.formLabel') },
      on: {
        submit: (event) => {
          event.preventDefault();
          submit();
        },
      },
    },
    controls.map((c) => c.control.el),
    ui.h(
      'p',
      { class: 'sm-details-privacy' },
      ui.icon('lock', 16),
      ui.h('span', null, t('details.privacy', { brand: config.brand?.name ?? '' })),
    ),
  );

  // Stays in the DOM (empty) so the failure message is announced when it is inserted.
  const alertRegion = ui.h('div', { class: 'sm-details-alert', attrs: { role: 'alert' } });

  // The button lives in the action bar, outside the form, so it is tied back to the form
  // with the `form` attribute: tapping it and pressing "Go" on the keyboard both raise
  // the form's submit event (requestSubmit() is not available on iOS 15).
  const sendBtn = ui.button(t('details.submit'), {
    variant: 'primary',
    size: 'lg',
    iconEnd: 'arrow-right',
    type: 'submit',
  });
  sendBtn.setAttribute('form', FORM_ID);

  const demoChip =
    leadMode(config) === 'demo' ? ui.chip(t('details.demoChip'), { tone: 'neutral', icon: 'info' }) : null;
  if (demoChip) demoChip.classList.add('sm-details-demo');

  // The customer tried the demo photo and carried on to here: say plainly whose door this is.
  const demoDoorNote = isDemoDoor(state) ? ui.banner(t('details.demoDoor'), { tone: 'info' }) : null;

  root.append(
    ...[
      ui.screenHeader({ title: t('details.title'), subtitle: t('details.subtitle') }),
      demoChip,
      demoDoorNote,
      buildSummary(),
      form,
      alertRegion,
      ui.actionBar(sendBtn),
    ].filter(Boolean),
  );

  // A send started before the customer left this screen is still running: wait for it.
  if (inFlight) {
    setSending(true);
    inFlight.then((ok) => {
      if (disposed) return;
      setSending(false);
      if (!ok) showFailure();
    });
  }

  function buildSummary() {
    const { widthMm, heightMm, source } = state.size;
    const quote = state.quote;
    const priced = Boolean(quote && quote.status === 'ok');
    const taxNote =
      priced && quote.taxLabel && quote.taxAmount > 0 ? t('details.taxNote', { tax: quote.taxLabel }) : null;
    // hasOwnProperty rather than Object.hasOwn, which iOS 15.0 to 15.3 lack.
    const sizeNote = Object.prototype.hasOwnProperty.call(SIZE_NOTES, source) ? t(SIZE_NOTES[source]) : null;

    return ui.card(
      { class: 'sm-details-summary' },
      ui.h(
        'dl',
        { class: 'sm-details-summary__list', attrs: { 'aria-label': t('details.summaryLabel') } },
        summaryRow(
          t('details.summarySize'),
          t('details.sizeValue', { width: noBreak(formatLength(widthMm)), height: noBreak(formatLength(heightMm)) }),
          { note: sizeNote },
        ),
        product ? summaryRow(t('details.summaryProduct'), product.name) : null,
        priced
          ? summaryRow(t('details.summaryTotal'), formatMoney(quote.total, config), { total: true, note: taxNote })
          : summaryRow(t('details.summaryPrice'), t('details.customQuote'), { total: true }),
      ),
    );
  }

  function summaryRow(label, value, { total = false, note = null } = {}) {
    return ui.h(
      'div',
      { class: `sm-details-summary__row${total ? ' sm-details-summary__row--total' : ''}` },
      ui.h('dt', null, label),
      ui.h(
        'dd',
        { class: 'sm-num' },
        value,
        note ? ui.h('span', { class: 'sm-details-summary__note' }, note) : null,
      ),
    );
  }

  /** Show (or clear) each control's message; returns the first control left invalid. */
  function applyErrors(errors) {
    let firstInvalid = null;
    for (const { key, control } of controls) {
      const message = errors[key] ?? null;
      control.setError(message);
      if (message && !firstInvalid) firstInvalid = control;
    }
    return firstInvalid;
  }

  function showFailure() {
    const parts = [ui.banner(t('details.sendFailed'), { tone: 'danger', icon: 'alert' })];
    if (phone) parts.push(callLine(ui, t('details.sendFailedCall', { phone }), phone));
    alertRegion.replaceChildren(...parts);
    alertRegion.scrollIntoView?.({ block: 'center' });
  }

  function setSending(on) {
    sending = on;
    sendBtn.disabled = on;
    sendBtn.setLabel(t(on ? 'details.sending' : 'details.submit'));
    if (on) form.setAttribute('aria-busy', 'true');
    else form.removeAttribute('aria-busy');
  }

  async function submit() {
    if (sending) return;

    // Browser autofill can change inputs without firing 'input', so read them once more.
    for (const { key, read } of controls) state.customer[key] = read();

    const check = validateCustomer(config, state.customer);
    const firstInvalid = applyErrors(check.ok ? {} : (check.errors ?? {}));
    if (!check.ok) {
      if (firstInvalid) {
        firstInvalid.input.focus();
        firstInvalid.input.scrollIntoView?.({ block: 'center' });
      }
      ctx.toast(t('details.fixErrors'), { type: 'error' });
      return;
    }

    setSending(true);
    alertRegion.replaceChildren();

    let settle;
    inFlight = new Promise((resolve) => {
      settle = resolve;
    });
    // reset() swaps a fresh object into ctx.state; the customer record is checked as well in case a
    // shell ever refills the same object instead.
    const customer = state.customer;

    let payload = null;
    let result;
    try {
      // One reference and time per enquiry. A send that looked failed here (a slow or lost reply) may
      // still have reached the company, so a retry repeats the first attempt's reference instead of
      // arriving as a second, unrelated lead. "Start again" swaps in a fresh state, and a new reference.
      const earlier = state.leadAttempt;
      payload = buildLeadPayload({
        config,
        customer,
        measurement: leadMeasurement(state, config),
        quote: leadQuote(state.quote),
        selections: state.quoteInput.selections ?? {},
        includeInstallation: effectiveInstallation(config, state.quoteInput.includeInstallation),
        product,
        photoDataUrl: leadPhoto(config, state),
        demo: isDemoDoor(state),
        reference: earlier?.reference,
        now: earlier ? new Date(earlier.createdAt) : undefined,
      });
      state.leadAttempt = { reference: payload.reference, createdAt: payload.createdAt };
      result = await submitLead(config, payload);
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) };
    }
    inFlight = null;
    settle(Boolean(result?.ok));

    if (result?.ok) {
      ctx.emit('lead', payload);
      // If the customer started again while this was in flight, the new session owns the state.
      if (ctx.state !== state || state.customer !== customer) return;
      state.submission = { payload, result };
      ctx.go('done', { replace: !disposed });
      return;
    }

    console.warn('[SecureMeasure] The enquiry could not be sent:', result?.error ?? 'unknown error');
    if (disposed) return;
    setSending(false);
    showFailure();
  }

  return () => {
    disposed = true;
  };
}

/**
 * True when the size being sent was read off the bundled demo photo, so it is the demo door's and
 * not the customer's. Only the two photo sources count: a size the customer typed in afterwards is
 * their own, and so is an AR reading, which measures the door in front of the phone even when the
 * demo photo is still loaded from an earlier try.
 *
 * @param {object} state shared app state
 * @returns {boolean}
 */
export function isDemoDoor(state) {
  const source = state?.size?.source;
  return (source === 'photo' || source === 'estimate') && state.photo?.isDemo === true;
}

/**
 * True when state.photo is the photo behind the size being sent, so it may go with the enquiry: the
 * size was read off it (paper or estimate), or the customer typed a size over a measurement of it.
 * A photo left over from a way in the customer backed out of stays in state until a new photo
 * replaces it, and must not be sent with a size it played no part in: an AR reading, or a size
 * typed in with no measurement of that photo behind it.
 *
 * @param {object} state shared app state
 * @returns {boolean}
 */
export function photoBacksSize(state) {
  if (!state?.photo) return false;
  const source = state.size?.source;
  if (source === 'photo' || source === 'estimate') return true;
  // setPhoto clears state.measure, so any measure that is not an AR reading was taken from this photo.
  return source === 'manual' && Boolean(state.measure) && state.measure.method !== 'ar';
}

/**
 * The measurement block of the lead (buildLeadPayload's `measurement`), for each way the size can
 * have been got. Each carries only what means something for it, and only when state.measure is the
 * measurement the size came from (a stale one from an earlier try is never mixed in):
 *
 * - 'photo' (paper): the fit quality and the two sigmas.
 * - 'estimate': `standard: true`, `standardSize` (the standard size the customer is going ahead
 *   with), `alternatives` (the other ones they were offered) and, only when the customer picked a
 *   size other than the app's most likely one, `appBest` (that most likely size), all as listed in
 *   config.measurement.standardSizes; `aspectHW`; and what the result screen warned the customer
 *   about: `nonStandard`, `confident` (false too when `appBest` is set: the app was never sure of
 *   the size the customer picked), `appConfident` (whether the app was sure of its own most likely
 *   size, whichever size was picked: false means the result screen showed the customer a warning
 *   banner, the unsure one unless the nonStandard one took its place) and the `issues` codes.
 * - 'ar': `standard` (whether the customer took the nearest standard size), `standardOffered`
 *   (whether one was close enough to offer them), `measured` (the AR reading of the opening, before
 *   the company's rules) and `warnings` (the AR self-check codes).
 * - 'manual': the size alone.
 *
 * @param {object} state shared app state (state.size must be set)
 * @param {object} [config] merged app config. Its measurement rules tell exactly which standard size
 *   the customer chose; without it the nearest candidate is taken to be the chosen one.
 * @returns {object}
 */
export function leadMeasurement(state, config) {
  const { widthMm, heightMm, source } = state.size;
  const measurement = { widthMm, heightMm, source };
  const measure = state.measure;

  if (source === 'estimate') {
    // A size matched from the photo is always one of the company's standard sizes.
    measurement.standard = true;
    if (measure?.method === 'estimate') {
      const candidates = usableCandidates(measure);
      const chosen = chosenCandidate(state.size, candidates, config);
      // The catalogue size itself: state.size has the company's fitting allowance in it, the
      // alternatives do not, and the email names the chosen size so the two can be told apart.
      if (chosen >= 0) {
        measurement.standardSize = { widthMm: candidates[chosen].widthMm, heightMm: candidates[chosen].heightMm };
      }
      measurement.alternatives = offeredAlternatives(candidates, chosen);
      // The customer picked a size under "Which is your door?" other than the one the app thought most
      // likely: the company is told which size the app put first, so it does not read the chosen one
      // as the app's own match.
      const overridden = chosen > 0;
      if (overridden) measurement.appBest = { widthMm: candidates[0].widthMm, heightMm: candidates[0].heightMm };
      measurement.aspectHW = measure.aspectHW;
      // The customer was shown a warning banner for these (estimateBannerKey: not confident, or not a
      // standard size at all), so the company hears it too: a priced standard size may really be a
      // door wider than any it sells. Read the way the banner reads them.
      measurement.nonStandard = measure.nonStandard === true;
      // measure.confident is about the app's most likely size (candidates[0]) alone. The lead's
      // `confident` is about the size it carries, so a size the customer picked over that one is never
      // sent as confident (its chance is at most even, and the 0.8 bar is about the first size only).
      measurement.confident = measure.confident === true && !overridden;
      // The app's own confidence is sent as well, because `confident: false` alone cannot say why: with
      // appBest set, it covers both a customer answering the unsure banner's "pick the one that matches"
      // and one overruling a size the app was sure of (no banner). This one tells the two apart.
      measurement.appConfident = measure.confident === true;
      const issues = Array.isArray(measure.issues) ? measure.issues : [];
      measurement.issues = issues.filter((code) => typeof code === 'string');
    }
  } else if (source === 'ar') {
    measurement.standard = state.size.standard === true;
    if (measure?.method === 'ar') {
      measurement.measured = { widthMm: measure.widthMm, heightMm: measure.heightMm };
      measurement.warnings = Array.isArray(measure.warnings) ? [...measure.warnings] : [];
      // standard: false means either "turned the standard size down" or "none was close enough to
      // offer" (the result screen's 'may not be a standard size' banner); this tells them apart.
      measurement.standardOffered = closestStandard(measure) !== null;
    }
  } else if (source === 'photo' && measure && (measure.method == null || measure.method === 'paper')) {
    // Fit quality and uncertainty only mean something for the paper method.
    measurement.quality = measure.quality?.level;
    measurement.sigmaWidthMm = measure.sigmaWidthMm;
    measurement.sigmaHeightMm = measure.sigmaHeightMm;
  }
  return measurement;
}

/** The estimate's candidate standard sizes that have a usable width and height, best first. */
function usableCandidates(measure) {
  const usable = (c) => c && Number.isFinite(c.widthMm) && Number.isFinite(c.heightMm);
  return (Array.isArray(measure.candidates) ? measure.candidates : []).filter(usable);
}

/**
 * Which of the candidates the customer is going ahead with, or -1 when there are none. state.size
 * has the company's rules applied, so each candidate is put through the same rules to find the
 * chosen one; failing that (no config), the candidate nearest the size is taken.
 */
function chosenCandidate(size, candidates, config) {
  if (candidates.length === 0) return -1;
  const rules = config?.measurement;
  const chosen = candidates.findIndex((c) => {
    const ruled = applyMeasurementRules(rules, c);
    return ruled.widthMm === size.widthMm && ruled.heightMm === size.heightMm;
  });
  if (chosen >= 0) return chosen;
  const gap = (c) => Math.abs(c.widthMm - size.widthMm) + Math.abs(c.heightMm - size.heightMm);
  return candidates.reduce((best, c, i) => (gap(c) < gap(candidates[best]) ? i : best), 0);
}

/**
 * The standard sizes the result screen offered besides the chosen one (`chosen`, an index into
 * `candidates`), best first, as listed in the company's catalogue (opening sizes, before its
 * fitting allowance).
 */
function offeredAlternatives(candidates, chosen) {
  // As the result screen offers them: the most likely size whatever its chance (a long catalogue can
  // leave even the best below OFFERED_MIN_P), the others only with a chance of at least OFFERED_MIN_P.
  return candidates
    .slice(0, OFFERED_SIZES)
    .filter((c, i) => i !== chosen && (i === 0 || Number(c.p) >= OFFERED_MIN_P))
    .map((c) => ({ widthMm: c.widthMm, heightMm: c.heightMm }));
}

/**
 * calculateQuote reports 0 for every amount when it has no price (a custom-quote size). The
 * company must not receive that as a $0 quote, so the amounts are blanked; lead.js sends null.
 */
function leadQuote(quote) {
  if (!quote || quote.status === 'ok') return quote ?? null;
  return { ...quote, total: null, subtotal: null, taxAmount: null };
}

/**
 * Resolve the installation choice the same way calculateQuote does, so the lead says
 * yes or no even when the customer never touched the toggle (state holds null).
 */
function effectiveInstallation(config, chosen) {
  const installation = config.pricing?.installation;
  if (!installation || !installation.enabled) return false;
  if (installation.optional === false) return true;
  return typeof chosen === 'boolean' ? chosen : Boolean(installation.default);
}

/**
 * The photo to send with the enquiry (buildLeadPayload's `photoDataUrl`), as a JPEG data URL, or
 * undefined when none may go: the company has not asked for photos, the photo is not the one the
 * size came from (photoBacksSize), or it is the bundled demo image behind a size that is not the
 * demo door's. Exported so it can be called on its own; tests/lead.test.mjs checks submit's use of it
 * by mounting this screen and sending, since only that catches a submit that stops calling it.
 * The photo is a nice-to-have for the company: never let it block the enquiry.
 *
 * @param {object} config merged app config
 * @param {object} state shared app state
 * @returns {string | undefined}
 */
export function leadPhoto(config, state) {
  // Only the photo the size was measured from: never one left over from a way in the customer abandoned.
  if (!config.lead?.includePhoto || !photoBacksSize(state)) return undefined;
  // The bundled demo image is not the customer's door: it only goes with an enquiry marked as a demo.
  if (state.photo.isDemo && !isDemoDoor(state)) return undefined;
  try {
    return photoToJpegDataUrl(state.photo);
  } catch {
    return undefined;
  }
}

/** "Or call us on <number>", with only the number as the tel: link. */
function callLine(ui, sentence, phone) {
  const link = ui.h('a', { class: 'sm-details-alert__link', href: telHref(phone) }, phone);
  const at = sentence.indexOf(phone);
  return ui.h(
    'p',
    { class: 'sm-details-alert__call' },
    at < 0 ? [sentence, ' ', link] : [sentence.slice(0, at), link, sentence.slice(at + phone.length)],
  );
}

function telHref(phone) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** Non-breaking spaces, so a narrow summary only ever wraps the size at the "×". */
function noBreak(text) {
  return String(text).replace(/ /g, ' ');
}
