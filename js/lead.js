/**
 * Lead capture: validates the customer's details, builds the lead payload and
 * delivers it by webhook, by a pre-filled email, or not at all (demo mode).
 *
 * Nothing here touches window / document / location at import time, and
 * everything except the delivery step of submitLead is pure, so the module
 * runs under plain Node.
 */

/**
 * @typedef {{ id: string, label?: string, type?: string, required?: boolean }} LeadField
 * @typedef {{ ok: boolean, errors: Record<string, string> }} ValidationResult
 * @typedef {{ ok: boolean, mode: 'webhook' | 'mailto' | 'demo', error?: string }} SubmitResult
 */

/** Longest the percent-encoded mailto body may be, so the whole URL stays under the ~2000 characters mail clients accept. */
export const MAILTO_MAX_BODY_CHARS = 1800;

/** How long a webhook POST may take before it is abandoned. */
export const WEBHOOK_TIMEOUT_MS = 15000;

/**
 * Content type of the webhook POST unless config.lead.contentType names another. The body is
 * always the JSON text. text/plain keeps the request "simple" in CORS terms, so the browser sends
 * it straight away instead of asking permission first with a preflight OPTIONS request, which
 * no-code webhooks such as Zapier's refuse.
 */
export const WEBHOOK_CONTENT_TYPE = 'text/plain;charset=UTF-8';

/** Demo mode pauses this long so the UI's "sending" state is visible. */
export const DEMO_DELAY_MS = 400;

/**
 * Default validation messages. A company can override any of them through
 * config.text using the same keys ('lead.error.required.<fieldId>' also works
 * for their own field ids).
 */
export const LEAD_ERROR_STRINGS = Object.freeze({
  'lead.error.required': 'Please fill this in.',
  'lead.error.required.name': 'Please enter your name.',
  'lead.error.required.phone': 'Please enter your phone number.',
  'lead.error.required.email': 'Please enter your email address.',
  'lead.error.required.postcode': 'Please enter your postcode.',
  'lead.error.email': "That email address doesn't look right.",
  'lead.error.phone': 'Please enter a phone number with at least 8 digits.',
  'lead.error.consent': 'Please tick the box so we can contact you.',
});

/**
 * Default wording of the pre-filled email used when config.lead.mailto is set. A company can
 * override any of it through config.text using the same keys. {placeholders} are filled in.
 */
export const LEAD_MAIL_STRINGS = Object.freeze({
  'lead.mail.subject': 'Door quote request {reference}',
  'lead.mail.demoTag': '[DEMO]',
  'lead.mail.heading': 'New quote request via {brand}',
  'lead.mail.headingNoBrand': 'New quote request',
  'lead.mail.reference': 'Reference: {reference}',
  'lead.mail.doorSize': 'Door size: {size}',
  'lead.mail.size': '{width} mm wide x {height} mm high',
  'lead.mail.notProvided': 'not provided',
  'lead.mail.measuredManual': 'Measured: entered by the customer (not from a photo)',
  'lead.mail.measuredPhoto': 'Measured: from a photo',
  'lead.mail.measuredDemo': "Measured: from the built-in demo photo, not the customer's own door",
  'lead.mail.measuredEstimate':
    'Measured: estimated from one photo, matched to the nearest standard size — needs a check measure',
  // The no-paper estimate run on the bundled demo photo: the demo flag matters more than the method.
  'lead.mail.measuredDemoEstimate':
    "Measured: estimated from the built-in demo photo, not the customer's own door, matched to the nearest standard size",
  // In place of the two above when the customer picked a size other than the app's most likely one:
  // the size sent is then the customer's choice, not the app's match, and the next line names the match.
  'lead.mail.measuredEstimateChosen':
    'Measured: estimated from one photo, a standard size the customer chose — needs a check measure',
  'lead.mail.measuredDemoEstimateChosen':
    "Measured: estimated from the built-in demo photo, not the customer's own door, a standard size the customer chose",
  'lead.mail.estimateOverride': "The customer chose this over the app's most likely size, {size}",
  'lead.mail.estimateOverrideUnadjusted':
    "The customer chose this over the app's most likely size, before your fitting allowance: {size}",
  // In place of the two above when the app was not sure of its most likely size either: the result
  // screen asked the customer to pick, so their pick is an answer to the app, not an overruling of it.
  'lead.mail.estimateAnswered': 'The app asked the customer to pick, and they chose this over its most likely size, {size}',
  'lead.mail.estimateAnsweredUnadjusted':
    'The app asked the customer to pick, and they chose this over its most likely size, before your fitting allowance: {size}',
  'lead.mail.measuredAr': "Measured: with the phone's AR camera — needs a check measure",
  'lead.mail.alternatives': 'Other standard sizes it could be: {sizes}',
  // When the door size has the company's adjustments in it, the matched catalogue size is named and
  // the second line replaces the one above, so catalogue sizes are not read as quoted sizes.
  'lead.mail.standardSize': 'Matched standard size, before your fitting allowance: {size}',
  // In place of the one above when the customer picked a size other than the app's most likely one,
  // which the app did not match (the "Measured:" line says the customer chose it).
  'lead.mail.chosenStandardSize': 'Standard size the customer chose, before your fitting allowance: {size}',
  'lead.mail.alternativesUnadjusted': 'Other standard sizes it could be, before your fitting allowance: {sizes}',
  // What the result screen warned the customer about (it showed them a banner for each).
  'lead.mail.estimateNonStandard': 'The app flagged: the door may not be a standard size, so this size could be some way out',
  'lead.mail.estimateUnsure': 'The app flagged: it could not be sure which standard size this is',
  'lead.mail.estimateIssues': 'Photo checks flagged: {issues}',
  'lead.mail.sizeShort': '{width} x {height} mm',
  'lead.mail.arReading': 'AR reading of the opening: {size}',
  'lead.mail.arStandard': 'the customer chose the nearest standard size',
  'lead.mail.arOwn': 'the customer kept this reading rather than the nearest standard size',
  'lead.mail.arNoStandard': 'no standard size was close enough to offer',
  'lead.mail.arWarnings': 'AR checks flagged: {warnings}',
  'lead.mail.confidence': 'confidence {quality}',
  'lead.mail.accuracy': 'about +/- {width} mm wide, +/- {height} mm high',
  'lead.mail.product': 'Product: {product}',
  'lead.mail.notSelected': 'not selected',
  'lead.mail.options': 'Options:',
  'lead.mail.installation': 'Installation: {answer}',
  'lead.mail.yes': 'Yes',
  'lead.mail.no': 'No',
  'lead.mail.total': 'Total: {total}',
  'lead.mail.totalWithTax': 'Total: {total} (includes {tax} {taxLabel})',
  'lead.mail.tax': 'tax',
  'lead.mail.totalNotQuoted': 'Total: not quoted',
  'lead.mail.totalCustom': 'Total: no instant price, this size needs a custom quote',
  'lead.mail.totalUnavailable': 'Total: not available',
  'lead.mail.shortened': '... [shortened]',
});

// 32 characters, so each one carries exactly 5 bits. No 0/O/1/I: references get read out over the phone.
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const REFERENCE_PATTERN = new RegExp(`^SM-[${REFERENCE_ALPHABET}]{6}$`);

// 'consent' is reserved for the consent flag; the rest would corrupt a plain object.
const RESERVED_FIELD_IDS = new Set(['consent', '__proto__', 'constructor', 'prototype']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIMED_OUT = Symbol('timed out');

/**
 * Where a size can come from. 'photo' is the paper method (the name is older than the other ways in,
 * and is kept because CRMs already filter on it), 'estimate' the no-paper photo matched to a standard
 * size, 'ar' the phone's AR camera and 'manual' a size the customer typed in. Anything else is
 * recorded as 'photo', the original source, rather than passed on unchecked.
 */
const MEASUREMENT_SOURCES = new Set(['photo', 'estimate', 'ar', 'manual']);

/** The sources that read the size off a photo, so the only ones whose size can be the demo door's. */
const PHOTO_SOURCES = new Set(['photo', 'estimate']);

// Short, bounded lists: they are the company's catalogue and the estimate's and measureOpening's
// checks, never free text.
const MAX_ALTERNATIVES = 3;
const MAX_WARNINGS = 12;

/* ------------------------------------------------------------------ helpers */

/** @returns {LeadField[]} the configured lead fields that are safe to use as object keys */
function leadFields(config) {
  const fields = config?.lead?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter(
    (field) => field && typeof field.id === 'string' && field.id !== '' && !RESERVED_FIELD_IDS.has(field.id),
  );
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Field value as a trimmed string ('' when missing or not a primitive). */
function cleanValue(customer, fieldId) {
  if (!customer || typeof customer !== 'object' || !hasOwn(customer, fieldId)) return '';
  const raw = customer[fieldId];
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

function isPlausibleEmail(value) {
  return EMAIL_PATTERN.test(value);
}

function isPlausiblePhone(value) {
  const digits = value.replace(/[\s()[\]\-.]/g, '').replace(/^\+/, '');
  return /^\d{8,20}$/.test(digits);
}

/** First company override among the keys, otherwise the first built-in message. */
function errorMessage(config, keys) {
  const overrides = config?.text;
  if (overrides && typeof overrides === 'object') {
    for (const key of keys) {
      if (hasOwn(overrides, key) && typeof overrides[key] === 'string' && overrides[key] !== '') return overrides[key];
    }
  }
  for (const key of keys) {
    if (hasOwn(LEAD_ERROR_STRINGS, key)) return LEAD_ERROR_STRINGS[key];
  }
  return LEAD_ERROR_STRINGS['lead.error.required'];
}

/** Email wording: the company's config.text override when there is one, else the default; then {placeholders} are filled in. */
function mailText(config, key, vars) {
  const overrides = config?.text;
  const override = overrides && typeof overrides === 'object' && hasOwn(overrides, key) ? overrides[key] : undefined;
  const template = typeof override === 'string' && override !== '' ? override : LEAD_MAIL_STRINGS[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name) => (hasOwn(vars, name) ? String(vars[name]) : placeholder));
}

function requiredMessage(config, field) {
  const keys = [`lead.error.required.${field.id}`];
  if (field.type === 'tel') keys.push('lead.error.required.phone');
  if (field.type === 'email') keys.push('lead.error.required.email');
  keys.push('lead.error.required');
  return errorMessage(config, keys);
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** cyrb53-style string hash, returned as two well-mixed unsigned 32-bit halves. */
function hashString(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1 >>> 0, h2 >>> 0];
}

function makeReference(time, fields, customerValues) {
  const parts = [String(time)];
  for (const field of fields) parts.push(`${field.id}=${customerValues[field.id]}`);
  const [h1, h2] = hashString(parts.join('\u001f'));
  let reference = 'SM-';
  for (const half of [h1, h2]) {
    for (let shift = 27; shift >= 17; shift -= 5) reference += REFERENCE_ALPHABET[(half >>> shift) & 31];
  }
  return reference;
}

/** A { widthMm, heightMm } pair of finite numbers, rounded to whole mm, or null when either is unusable. */
function cleanSize(size) {
  const widthMm = finiteOrNull(size?.widthMm);
  const heightMm = finiteOrNull(size?.heightMm);
  if (widthMm === null || heightMm === null) return null;
  return { widthMm: Math.round(widthMm), heightMm: Math.round(heightMm) };
}

/** Check codes as a short list of non-empty strings (the estimate's issues, the AR warnings). */
function cleanCodes(codes) {
  const given = Array.isArray(codes) ? codes : [];
  return given.filter((code) => typeof code === 'string' && code !== '').slice(0, MAX_WARNINGS);
}

/**
 * The measurement block of the lead. Each source carries only what means something for it:
 *
 * - 'photo' (paper): the fit quality, its issue codes and the two sigmas, as before.
 * - 'estimate': `standardSize`, the standard size accepted, as listed in the catalogue (before the
 *   company's rules); `alternatives`, the other standard sizes the photo could also be; `appBest`,
 *   the app's most likely size, only when the customer accepted another one; `aspectHW`, the
 *   height-to-width ratio read from the photo; and what the customer was warned about:
 *   `nonStandard`, `confident` (about the size accepted), `appConfident` (about the app's own most
 *   likely size, so it says whether the result screen warned the customer even when they accepted
 *   another size) and the `issues` codes. No quality or sigmas: the estimate has no
 *   millimetre scale of its own, and the company must not be told a "plus or minus" nobody measured.
 * - 'ar': `measured`, the AR reading of the opening before the company's rules; `warnings`, the AR
 *   self-check codes; and `standardOffered`, whether a standard size was close enough to offer.
 * - 'manual': the size alone.
 *
 * `standard` (true when the size is a standard size from the company's list that the customer
 * accepted) is carried for any source that sets it. The estimate's warning flags and
 * `standardOffered` are carried only when the caller gives them, so a lead never claims a
 * confidence nobody worked out.
 */
function cleanMeasurement(measurement) {
  const source = MEASUREMENT_SOURCES.has(measurement?.source) ? measurement.source : 'photo';
  const out = {
    widthMm: finiteOrNull(measurement?.widthMm),
    heightMm: finiteOrNull(measurement?.heightMm),
    source,
  };
  if (typeof measurement?.standard === 'boolean') out.standard = measurement.standard;

  if (source === 'photo') {
    // Callers may hand over either the level string or the whole MeasureResult.quality object.
    const quality = measurement?.quality;
    const level = typeof quality === 'string' ? quality : quality?.level;
    if (typeof level === 'string' && level !== '') out.quality = level;
    if (quality && typeof quality === 'object' && Array.isArray(quality.issues)) {
      const issues = quality.issues.filter((issue) => typeof issue === 'string');
      if (issues.length > 0) out.qualityIssues = issues;
    }
    for (const key of ['sigmaWidthMm', 'sigmaHeightMm']) {
      const sigma = finiteOrNull(measurement?.[key]);
      if (sigma !== null) out[key] = Math.round(sigma * 10) / 10;
    }
  } else if (source === 'estimate') {
    const standardSize = cleanSize(measurement?.standardSize);
    if (standardSize) out.standardSize = standardSize;
    // Always present (possibly empty) for an estimate, so a CRM can map the field once.
    const given = Array.isArray(measurement?.alternatives) ? measurement.alternatives : [];
    out.alternatives = given.map(cleanSize).filter(Boolean).slice(0, MAX_ALTERNATIVES);
    // Only when it is not the size accepted: its presence is what says the customer overrode the app.
    const appBest = cleanSize(measurement?.appBest);
    if (appBest && !(standardSize && sameWholeMm(appBest, standardSize))) out.appBest = appBest;
    const aspect = finiteOrNull(measurement?.aspectHW);
    if (aspect !== null && aspect > 0) out.aspectHW = Math.round(aspect * 10000) / 10000;
    for (const key of ['nonStandard', 'confident', 'appConfident']) {
      if (typeof measurement?.[key] === 'boolean') out[key] = measurement[key];
    }
    if (Array.isArray(measurement?.issues)) out.issues = cleanCodes(measurement.issues);
  } else if (source === 'ar') {
    const measured = cleanSize(measurement?.measured);
    if (measured) out.measured = measured;
    out.warnings = cleanCodes(measurement?.warnings);
    if (typeof measurement?.standardOffered === 'boolean') out.standardOffered = measurement.standardOffered;
  }
  return out;
}

function cleanQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const lineItems = (Array.isArray(quote.lineItems) ? quote.lineItems : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const out = { id: String(item.id ?? ''), label: String(item.label ?? ''), amount: finiteOrNull(item.amount) };
      if (typeof item.detail === 'string' && item.detail !== '') out.detail = item.detail;
      return out;
    });
  const status = typeof quote.status === 'string' ? quote.status : quote.ok ? 'ok' : 'invalid';
  // calculateQuote reports 0 for every amount when there is no price (a custom-quote size). Sent on
  // as it is, a CRM would record a $0 quote, so only a priced quote carries amounts.
  const amount = (value) => (status === 'ok' ? finiteOrNull(value) : null);
  return {
    status,
    total: amount(quote.total),
    subtotal: amount(quote.subtotal),
    taxAmount: amount(quote.taxAmount),
    currency: typeof quote.currency === 'string' ? quote.currency : null,
    lineItems,
  };
}

/**
 * The customer's choices with option defaults filled in, so the company sees
 * every option's value rather than only the ones the customer touched.
 */
function resolveSelections(config, selections) {
  const given = selections && typeof selections === 'object' ? selections : {};
  const options = config?.pricing?.options;
  const out = {};
  if (Array.isArray(options) && options.length > 0) {
    for (const option of options) {
      if (!option || typeof option.id !== 'string' || UNSAFE_KEYS.has(option.id)) continue;
      const value = hasOwn(given, option.id) ? given[option.id] : undefined;
      if (option.type === 'checkbox') {
        out[option.id] = typeof value === 'boolean' ? value : option.default === true;
      } else {
        const choices = Array.isArray(option.choices) ? option.choices : [];
        const isValid = choices.some((choice) => choice && choice.id === value);
        out[option.id] = isValid ? value : (option.default ?? choices[0]?.id ?? null);
      }
    }
    return out;
  }
  for (const [key, value] of Object.entries(given)) {
    if (!UNSAFE_KEYS.has(key) && (typeof value === 'string' || typeof value === 'boolean')) out[key] = value;
  }
  return out;
}

function resolveInstallation(config, explicit, quote) {
  const installation = config?.pricing?.installation;
  // Truthy test, as in js/quote.js: a config that leaves `enabled` out charges no installation.
  if (!installation || !installation.enabled) return false;
  if (installation.optional === false) return true;
  if (typeof explicit === 'boolean') return explicit;
  // No explicit answer: a priced quote says it best (it either charged for installation or it did not).
  if (quote && quote.status === 'ok' && Array.isArray(quote.lineItems)) {
    return quote.lineItems.some(
      (item) => item && (item.id === 'installation' || (installation.label && item.label === installation.label)),
    );
  }
  return installation.default === true;
}

/* ----------------------------------------------------------------- validate */

/**
 * Check the customer's details against the configured lead fields.
 *
 * Only fields listed in config.lead.fields are looked at. Values are trimmed
 * first. Required fields must be non-empty; an email field must look like
 * something@something.tld; a tel field needs at least 8 digits once spaces,
 * brackets, dashes, dots and a leading + are removed; customer.consent must be
 * exactly true.
 *
 * @param {object} config merged app config
 * @param {Record<string, unknown>} customer field values keyed by field id, plus consent
 * @returns {ValidationResult} errors holds one short message per failing field id (and 'consent')
 */
export function validateCustomer(config, customer) {
  /** @type {Record<string, string>} */
  const errors = {};
  for (const field of leadFields(config)) {
    const value = cleanValue(customer, field.id);
    if (value === '') {
      if (field.required) errors[field.id] = requiredMessage(config, field);
    } else if (field.type === 'email' && !isPlausibleEmail(value)) {
      errors[field.id] = errorMessage(config, ['lead.error.email']);
    } else if (field.type === 'tel' && !isPlausiblePhone(value)) {
      errors[field.id] = errorMessage(config, ['lead.error.phone']);
    }
  }
  if (!customer || customer.consent !== true) errors.consent = errorMessage(config, ['lead.error.consent']);
  return { ok: Object.keys(errors).length === 0, errors };
}

/* ------------------------------------------------------------------ payload */

/**
 * Build the JSON-serialisable lead that is sent to the company.
 *
 * @param {object} input
 * @param {object} input.config merged app config
 * @param {Record<string, unknown>} input.customer field values keyed by field id, plus consent
 * @param {object} input.measurement the size and how it was got:
 *   `{ widthMm, heightMm, source, standard? }` plus, by source, 'photo' (paper):
 *   `quality?` (a level string or the whole { level, issues } object), `sigmaWidthMm?`, `sigmaHeightMm?`;
 *   'estimate': `standardSize?: { widthMm, heightMm }`, `alternatives?: { widthMm, heightMm }[]`,
 *   `appBest?: { widthMm, heightMm }` (the app's most likely size, when the customer chose another), `aspectHW?`,
 *   `nonStandard?: boolean`, `confident?: boolean` (about the size sent), `appConfident?: boolean` (about
 *   the app's most likely size), `issues?: string[]`; 'ar': `measured?: { widthMm, heightMm }`,
 *   `warnings?: string[]`, `standardOffered?: boolean`; 'manual': nothing more. An unknown source is recorded as 'photo'.
 * @param {object | null} [input.quote] a calculateQuote result
 * @param {Record<string, string | boolean>} [input.selections] chosen options keyed by option id
 * @param {{ id: string, name: string } | null} [input.product] the chosen product from config.pricing.products
 * @param {boolean | null} [input.includeInstallation] the customer's installation choice; worked out from the quote / config default when omitted
 * @param {string | null} [input.photoDataUrl] attached as 'photo' only when config.lead.includePhoto is true
 * @param {boolean} [input.demo] true when the size was read off the bundled demo photo rather than the customer's own door; only kept for the photo sources ('photo', 'estimate')
 * @param {string | null} [input.reference] the reference of an earlier attempt at this same enquiry, kept so that a retry is not a second lead; a new one is made when omitted
 * @param {Date} [input.now] a retry passes the first attempt's time, so createdAt stays the same too
 * @returns {object} { reference, createdAt, brand, demo, customer, measurement, product, selections, includeInstallation, quote, photo? }
 */
export function buildLeadPayload({
  config,
  customer,
  measurement,
  quote = null,
  selections = {},
  product = null,
  includeInstallation = null,
  photoDataUrl = null,
  demo = false,
  reference = null,
  now = new Date(),
} = {}) {
  const fields = leadFields(config);
  const customerOut = {};
  for (const field of fields) customerOut[field.id] = cleanValue(customer, field.id);

  let when = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(when.getTime())) when = new Date();
  const kept = typeof reference === 'string' && REFERENCE_PATTERN.test(reference);
  const referenceOut = kept ? reference : makeReference(when.getTime(), fields, customerOut);

  // Recorded as given rather than assumed, so a caller that skipped validation can never fabricate consent.
  customerOut.consent = Boolean(customer) && customer.consent === true;

  const measurementOut = cleanMeasurement(measurement);

  const payload = {
    reference: referenceOut,
    createdAt: when.toISOString(),
    brand: typeof config?.brand?.name === 'string' ? config.brand.name : '',
    // Only a size read off a photo (paper or estimate) can be the demo door's. One the customer typed
    // in is their own, and so is an AR reading: AR measures the door in front of the phone, never a photo.
    demo: demo === true && PHOTO_SOURCES.has(measurementOut.source),
    customer: customerOut,
    measurement: measurementOut,
    product:
      product && typeof product === 'object' && product.id != null
        ? { id: String(product.id), name: String(product.name ?? product.id) }
        : null,
    selections: resolveSelections(config, selections),
    includeInstallation: resolveInstallation(config, includeInstallation, quote),
    quote: cleanQuote(quote),
  };
  if (config?.lead?.includePhoto === true && typeof photoDataUrl === 'string' && photoDataUrl !== '') {
    payload.photo = photoDataUrl;
  }
  return payload;
}

/* ------------------------------------------------------------------- mailto */

/** encodeURIComponent that survives lone surrogates (which make the native function throw). */
function encode(text) {
  try {
    return encodeURIComponent(text);
  } catch {
    const repaired = Array.from(text, (ch) => (ch.length === 1 && /[\uD800-\uDFFF]/.test(ch) ? '�' : ch));
    return encodeURIComponent(repaired.join(''));
  }
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 'Label: value', or 'Label? value' when the label already ends in punctuation. */
function labelled(label, value, separator = ' ') {
  const text = oneLine(label).replace(/\s*:$/, '');
  return `${/[?!.]$/.test(text) ? text : `${text}:`}${separator}${value}`;
}

function formatMoney(amount, currency, locale) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || ''} ${amount}`.trim();
  }
}

/** Longest prefix of text (plus the marker) whose percent-encoded form fits in maxEncoded characters. */
function fitEncoded(text, maxEncoded, mark) {
  if (encode(text).length <= maxEncoded) return text;
  const budget = maxEncoded - encode(mark).length;
  let used = 0;
  let kept = '';
  // Iterating by code point keeps surrogate pairs whole; encoding is additive per code point.
  for (const ch of text) {
    const cost = encode(ch).length;
    if (used + cost > budget) break;
    used += cost;
    kept += ch;
  }
  return kept.trimEnd() + mark;
}

function mailtoAddress(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => encode(address).replace(/%40/g, '@'))
    .join(',');
}

function optionLines(config, selections) {
  const options = Array.isArray(config?.pricing?.options) ? config.pricing.options : [];
  const lines = [];
  for (const [id, value] of Object.entries(selections && typeof selections === 'object' ? selections : {})) {
    const option = options.find((candidate) => candidate && candidate.id === id);
    const label = option?.label || id;
    if (typeof value === 'boolean') {
      lines.push(labelled(label, mailText(config, value ? 'lead.mail.yes' : 'lead.mail.no')));
    } else if (value !== null && value !== undefined && value !== '') {
      const choice = Array.isArray(option?.choices) ? option.choices.find((c) => c && c.id === value) : null;
      lines.push(labelled(label, oneLine(choice?.label ?? value)));
    }
  }
  return lines;
}

function measuredLine(config, payload) {
  const measurement = payload?.measurement;
  const source = measurement?.source;
  if (source === 'manual') return mailText(config, 'lead.mail.measuredManual');
  // Neither of these has a "plus or minus" the customer was shown, so none is given to the company:
  // the wording itself says the size is an estimate that a check measure confirms.
  if (source === 'estimate') {
    // A size the customer picked over the app's most likely one was not "matched" by the app.
    const chosen = cleanSize(measurement.appBest) !== null;
    const demo = payload?.demo === true;
    if (chosen) return mailText(config, demo ? 'lead.mail.measuredDemoEstimateChosen' : 'lead.mail.measuredEstimateChosen');
    return mailText(config, demo ? 'lead.mail.measuredDemoEstimate' : 'lead.mail.measuredEstimate');
  }
  if (source === 'ar') return mailText(config, 'lead.mail.measuredAr');
  let text = mailText(config, payload?.demo === true ? 'lead.mail.measuredDemo' : 'lead.mail.measuredPhoto');
  if (measurement?.quality) text += `, ${mailText(config, 'lead.mail.confidence', { quality: oneLine(measurement.quality) })}`;
  const { sigmaWidthMm, sigmaHeightMm } = measurement ?? {};
  if (Number.isFinite(sigmaWidthMm) && Number.isFinite(sigmaHeightMm)) {
    // Two sigma, never claiming better than 2 mm: the same "accurate to about" rule the customer was shown
    // on the result screen, so the company is not told a tighter figure than the customer was.
    const wide = Math.max(2, Math.ceil(2 * sigmaWidthMm));
    const high = Math.max(2, Math.ceil(2 * sigmaHeightMm));
    text += ` (${mailText(config, 'lead.mail.accuracy', { width: wide, height: high })})`;
  }
  return text;
}

function totalLine(config, quote) {
  if (!quote) return mailText(config, 'lead.mail.totalNotQuoted');
  if (quote.status === 'out_of_range') return mailText(config, 'lead.mail.totalCustom');
  if (quote.status !== 'ok' || !Number.isFinite(quote.total)) return mailText(config, 'lead.mail.totalUnavailable');
  const locale = config?.pricing?.locale;
  const currency = quote.currency || config?.pricing?.currency;
  const total = formatMoney(quote.total, currency, locale);
  if (Number.isFinite(quote.taxAmount) && quote.taxAmount > 0) {
    const taxLabel = oneLine(config?.pricing?.taxLabel || mailText(config, 'lead.mail.tax'));
    const tax = formatMoney(quote.taxAmount, currency, locale);
    return mailText(config, 'lead.mail.totalWithTax', { total, tax, taxLabel });
  }
  return mailText(config, 'lead.mail.total', { total });
}

function sizeText(config, measurement, key = 'lead.mail.size') {
  const { widthMm, heightMm } = measurement ?? {};
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)) return '';
  return mailText(config, key, { width: Math.round(widthMm), height: Math.round(heightMm) });
}

/** Whether two sizes are the same once rounded to whole mm, as the email shows them. */
function sameWholeMm(a, b) {
  return Math.round(a.widthMm) === Math.round(b.widthMm) && Math.round(a.heightMm) === Math.round(b.heightMm);
}

/**
 * The lines under "Measured:" that only an estimate or an AR reading has. For an estimate: the
 * app's most likely size when the customer chose another (and whether the app had asked them to
 * pick, being unsure of it), the other standard sizes it could be, so whoever books the check
 * measure knows what to expect, and anything the customer was warned about. For AR: the reading itself, whether a standard size was
 * chosen, turned down or never on offer, and any self-check it failed, so a priced standard size
 * can be told from what was measured.
 */
function sourceDetailLines(config, measurement) {
  const lines = [];
  if (measurement?.source === 'estimate') {
    // The door size has the company's adjustments in it; the standard sizes are as its catalogue lists
    // them. When the two differ, the catalogue size sent is named and the list says which it is.
    const matched = sizeText(config, measurement.standardSize, 'lead.mail.sizeShort');
    const adjusted =
      matched !== '' && sizeText(config, measurement) !== '' && !sameWholeMm(measurement.standardSize, measurement);
    // The customer picked another size than the app put first (appBest names that one): the app did
    // not match the size sent, so it is never called "matched", here or on the "Measured:" line.
    const appBest = sizeText(config, measurement.appBest, 'lead.mail.sizeShort');
    if (adjusted) {
      const key = appBest !== '' ? 'lead.mail.chosenStandardSize' : 'lead.mail.standardSize';
      lines.push(mailText(config, key, { size: matched }));
    }
    // Was the app unsure of its own most likely size, so the customer was shown a warning banner? Said
    // by `appConfident`; a lead without it (built by older code) has only `confident`, which says so
    // when the customer kept the app's size. Only when the caller said so: an estimate with no flags
    // given is not reported as unsure.
    const unsure = measurement.appConfident === false || (measurement.confident === false && appBest === '');
    // Say which size the app put first, so the company does not quote believing the app matched the
    // size it was sent; and whether the customer overruled a size the app was sure of, or answered the
    // result screen asking them to pick because it was not.
    if (appBest !== '') {
      const keys = unsure
        ? ['lead.mail.estimateAnsweredUnadjusted', 'lead.mail.estimateAnswered']
        : ['lead.mail.estimateOverrideUnadjusted', 'lead.mail.estimateOverride'];
      lines.push(mailText(config, adjusted ? keys[0] : keys[1], { size: appBest }));
    }
    // The line above has already named the app's most likely size, so it is not listed again here.
    const alternatives = Array.isArray(measurement.alternatives) ? measurement.alternatives : [];
    const sizes = alternatives
      .map((size) => sizeText(config, size, 'lead.mail.sizeShort'))
      .filter((text) => text !== '' && text !== appBest);
    if (sizes.length > 0) {
      const key = adjusted ? 'lead.mail.alternativesUnadjusted' : 'lead.mail.alternatives';
      lines.push(mailText(config, key, { sizes: sizes.join(', ') }));
    }
    // The banner the customer saw: a door that may not be standard wins over plain uncertainty, as it
    // does on the result screen (estimateBannerKey). Reported whichever size the customer then picked.
    if (measurement.nonStandard === true) lines.push(mailText(config, 'lead.mail.estimateNonStandard'));
    else if (unsure) lines.push(mailText(config, 'lead.mail.estimateUnsure'));
    const issues = (Array.isArray(measurement.issues) ? measurement.issues : []).map(oneLine).filter(Boolean);
    if (issues.length > 0) lines.push(mailText(config, 'lead.mail.estimateIssues', { issues: issues.join(', ') }));
  } else if (measurement?.source === 'ar') {
    const reading = sizeText(config, measurement.measured);
    if (reading) {
      let line = mailText(config, 'lead.mail.arReading', { size: reading });
      if (measurement.standard === true) line += ` (${mailText(config, 'lead.mail.arStandard')})`;
      else if (measurement.standardOffered === true) line += ` (${mailText(config, 'lead.mail.arOwn')})`;
      else if (measurement.standardOffered === false) line += ` (${mailText(config, 'lead.mail.arNoStandard')})`;
      lines.push(line);
    }
    const warnings = (Array.isArray(measurement.warnings) ? measurement.warnings : []).map(oneLine).filter(Boolean);
    if (warnings.length > 0) lines.push(mailText(config, 'lead.mail.arWarnings', { warnings: warnings.join(', ') }));
  }
  return lines;
}

function mailSubject(config, payload) {
  const customer = payload?.customer ?? {};
  const name = oneLine(customer.name);
  const { widthMm, heightMm } = payload?.measurement ?? {};
  let subject = mailText(config, 'lead.mail.subject', { reference: oneLine(payload?.reference) });
  // Up front, where the company's inbox shows it: this size is the demo door's, not the customer's.
  if (payload?.demo === true) subject = `${mailText(config, 'lead.mail.demoTag')} ${subject}`;
  if (name) subject += ` - ${name}`;
  if (Number.isFinite(widthMm) && Number.isFinite(heightMm)) {
    subject += ` (${Math.round(widthMm)} x ${Math.round(heightMm)} mm)`;
  }
  return subject;
}

function mailBody(config, payload) {
  const customer = payload?.customer && typeof payload.customer === 'object' ? payload.customer : {};
  const fields = leadFields(config);
  const brand = oneLine(payload?.brand || config?.brand?.name);
  const heading = brand ? mailText(config, 'lead.mail.heading', { brand }) : mailText(config, 'lead.mail.headingNoBrand');
  const lines = [heading, ''];
  lines.push(mailText(config, 'lead.mail.reference', { reference: oneLine(payload?.reference) }), '');

  const contact = [];
  for (const field of fields) {
    if (field.type === 'textarea') continue;
    const value = oneLine(cleanValue(customer, field.id));
    if (value) contact.push(labelled(field.label || field.id, value));
  }
  if (contact.length > 0) lines.push(...contact, '');

  const size = sizeText(config, payload?.measurement) || mailText(config, 'lead.mail.notProvided');
  lines.push(mailText(config, 'lead.mail.doorSize', { size }));
  lines.push(measuredLine(config, payload), ...sourceDetailLines(config, payload?.measurement));
  const productName = oneLine(payload?.product?.name) || mailText(config, 'lead.mail.notSelected');
  lines.push(mailText(config, 'lead.mail.product', { product: productName }));
  const options = optionLines(config, payload?.selections);
  if (options.length > 0) lines.push(mailText(config, 'lead.mail.options'), ...options.map((line) => `- ${line}`));
  const installation = config?.pricing?.installation;
  if (installation && installation.enabled) {
    const answer = mailText(config, payload?.includeInstallation ? 'lead.mail.yes' : 'lead.mail.no');
    lines.push(mailText(config, 'lead.mail.installation', { answer }));
  }
  lines.push(totalLine(config, payload?.quote));

  // Free-text answers go last: they are the only unbounded part, so they are what gets shortened.
  for (const field of fields) {
    if (field.type !== 'textarea') continue;
    const value = cleanValue(customer, field.id).replace(/\r\n?|\n/g, '\r\n');
    if (value) lines.push('', labelled(field.label || field.id, value, '\r\n'));
  }
  return lines.join('\r\n');
}

/**
 * Build the mailto: URL used when config.lead.mailto is set: a subject plus a
 * readable multi-line body (reference, contact details, size, product,
 * options, total, notes). Everything is percent-encoded, so customer text can
 * never add headers such as bcc. The encoded body is capped at
 * MAILTO_MAX_BODY_CHARS (long notes are shortened) and the photo is never
 * included. The wording comes from LEAD_MAIL_STRINGS and can be changed
 * through config.text. A lead measured from the demo photo (payload.demo) has
 * a subject that starts with '[DEMO] '.
 *
 * @param {object} config merged app config
 * @param {object} payload a buildLeadPayload result
 * @returns {string} mailto: URL
 */
export function buildMailtoUrl(config, payload) {
  const to = mailtoAddress(config?.lead?.mailto);
  const subject = encode(mailSubject(config, payload));
  const mark = ` ${mailText(config, 'lead.mail.shortened')}`;
  const body = encode(fitEncoded(mailBody(config, payload), MAILTO_MAX_BODY_CHARS, mark));
  return `mailto:${to}?subject=${subject}&body=${body}`;
}

/* ------------------------------------------------------------------- submit */

/**
 * How leads are delivered for this config.
 *
 * @param {object} config merged app config
 * @returns {'webhook' | 'mailto' | 'demo'} webhook when lead.endpoint is set, else mailto when lead.mailto is set, else demo
 */
export function leadMode(config) {
  const lead = config?.lead;
  if (typeof lead?.endpoint === 'string' && lead.endpoint.trim() !== '') return 'webhook';
  if (typeof lead?.mailto === 'string' && lead.mailto.trim() !== '') return 'mailto';
  return 'demo';
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function positiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** config.lead.contentType when the company set one (their own server may insist on application/json), else text/plain. */
function webhookContentType(config) {
  const chosen = config?.lead?.contentType;
  return typeof chosen === 'string' && chosen.trim() !== '' ? chosen.trim() : WEBHOOK_CONTENT_TYPE;
}

async function postToWebhook(endpoint, payload, timeoutMs, contentType) {
  const fail = (error) => ({ ok: false, mode: 'webhook', error });
  if (typeof globalThis.fetch !== 'function') return fail('network');

  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    return fail('invalid_payload');
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  let timer;
  // Raced against the request as well as aborting it, so the cap holds even if fetch ignores the signal.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  try {
    // Content-Type is the only header and no credentials mode is asked for: with the default
    // text/plain this is a CORS "simple" request, which the browser sends without a preflight.
    const request = globalThis.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal: controller?.signal,
    });
    const response = await Promise.race([request, timeout]);
    if (response === TIMED_OUT) return fail('timeout');
    const status = Number(response?.status);
    if (!Number.isFinite(status)) return response?.ok === true ? { ok: true, mode: 'webhook' } : fail('network');
    if (status >= 200 && status < 300) return { ok: true, mode: 'webhook' };
    return fail(status > 0 ? `http_${status}` : 'network');
  } catch (error) {
    return fail(timedOut || error?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver a lead. Never throws.
 *
 * - webhook: POSTs the payload as JSON text to config.lead.endpoint; ok only
 *   on a 2xx response. error is 'http_<status>', 'network', 'timeout' or
 *   'invalid_payload'. Customer data only ever travels in the request body.
 *   The body is sent as text/plain (WEBHOOK_CONTENT_TYPE), so a cross-origin
 *   endpoint gets no preflight request; config.lead.contentType overrides
 *   that, for example 'application/json' for a server that answers preflights.
 * - mailto: opens the customer's email app with a pre-filled message (it
 *   cannot know whether they then press send). error 'unavailable' when there
 *   is no location to navigate.
 * - demo: sends nothing and resolves ok after a short pause.
 *
 * @param {object} config merged app config
 * @param {object} payload a buildLeadPayload result
 * @param {{ timeoutMs?: number, demoDelayMs?: number }} [options] overrides for the 15 s webhook timeout and the demo pause (used by tests)
 * @returns {Promise<SubmitResult>}
 */
export async function submitLead(config, payload, options = {}) {
  const mode = leadMode(config);
  try {
    if (mode === 'webhook') {
      const timeoutMs = positiveOr(options?.timeoutMs, WEBHOOK_TIMEOUT_MS);
      return await postToWebhook(config.lead.endpoint.trim(), payload, timeoutMs, webhookContentType(config));
    }
    if (mode === 'mailto') {
      if (!globalThis.location) return { ok: false, mode, error: 'unavailable' };
      globalThis.location.href = buildMailtoUrl(config, payload);
      return { ok: true, mode };
    }
    await delay(positiveOr(options?.demoDelayMs, DEMO_DELAY_MS));
    return { ok: true, mode };
  } catch {
    return { ok: false, mode, error: 'unexpected' };
  }
}
