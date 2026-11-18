/**
 * Details screen: the customer's contact details and the "go ahead" enquiry.
 * Validates the form, builds the lead payload, hands it to submitLead and moves on
 * to the confirmation screen.
 */

import { validateCustomer, buildLeadPayload, submitLead, leadMode } from '../lead.js';
import { calculateQuote, formatMoney, formatLength } from '../quote.js';
import { photoToJpegDataUrl } from '../photo.js';

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
  'details.submit': 'Send my enquiry',
  'details.sending': 'Sending…',
  'details.fixErrors': 'Please check the highlighted details.',
  'details.sendFailed': "We couldn't send that. Please try again.",
  'details.sendFailedCall': 'Or call us on {phone}',
};

const FORM_ID = 'sm-details-form';
const DEFAULT_INPUTMODE = { tel: 'tel', email: 'email' };

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

  root.append(
    ...[
      ui.screenHeader({ title: t('details.title'), subtitle: t('details.subtitle') }),
      demoChip,
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
    const { widthMm, heightMm } = state.size;
    const quote = state.quote;
    const priced = Boolean(quote && quote.status === 'ok');
    const taxNote =
      priced && quote.taxLabel && quote.taxAmount > 0 ? t('details.taxNote', { tax: quote.taxLabel }) : null;

    return ui.card(
      { class: 'sm-details-summary' },
      ui.h(
        'dl',
        { class: 'sm-details-summary__list', attrs: { 'aria-label': t('details.summaryLabel') } },
        summaryRow(
          t('details.summarySize'),
          t('details.sizeValue', { width: noBreak(formatLength(widthMm)), height: noBreak(formatLength(heightMm)) }),
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
      payload = buildLeadPayload({
        config,
        customer,
        measurement: leadMeasurement(state),
        quote: leadQuote(state.quote),
        selections: state.quoteInput.selections ?? {},
        includeInstallation: effectiveInstallation(config, state.quoteInput.includeInstallation),
        product,
        photoDataUrl: leadPhoto(config, state),
      });
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
 * The measurement block of the lead. Fit quality and uncertainty only mean something
 * for a photo measurement, so they are left out when the customer typed the size in.
 */
function leadMeasurement(state) {
  const { widthMm, heightMm, source } = state.size;
  const measurement = { widthMm, heightMm, source };
  if (source !== 'manual' && state.measure) {
    measurement.quality = state.measure.quality?.level;
    measurement.sigmaWidthMm = state.measure.sigmaWidthMm;
    measurement.sigmaHeightMm = state.measure.sigmaHeightMm;
  }
  return measurement;
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

/** The photo is a nice-to-have for the company: never let it block the enquiry. */
function leadPhoto(config, state) {
  if (!config.lead?.includePhoto || !state.photo) return undefined;
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
