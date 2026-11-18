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

// 32 characters, so each one carries exactly 5 bits. No 0/O/1/I: references get read out over the phone.
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// 'consent' is reserved for the consent flag; the rest would corrupt a plain object.
const RESERVED_FIELD_IDS = new Set(['consent', '__proto__', 'constructor', 'prototype']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TRUNCATION_MARK = ' ... [shortened]';
const TIMED_OUT = Symbol('timed out');

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

function cleanMeasurement(measurement) {
  const out = {
    widthMm: finiteOrNull(measurement?.widthMm),
    heightMm: finiteOrNull(measurement?.heightMm),
    source: measurement?.source === 'manual' ? 'manual' : 'photo',
  };
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
 * @param {{ widthMm: number, heightMm: number, source: 'photo' | 'manual', quality?: string | { level: string, issues?: string[] }, sigmaWidthMm?: number, sigmaHeightMm?: number }} input.measurement
 * @param {object | null} [input.quote] a calculateQuote result
 * @param {Record<string, string | boolean>} [input.selections] chosen options keyed by option id
 * @param {{ id: string, name: string } | null} [input.product] the chosen product from config.pricing.products
 * @param {boolean | null} [input.includeInstallation] the customer's installation choice; worked out from the quote / config default when omitted
 * @param {string | null} [input.photoDataUrl] attached as 'photo' only when config.lead.includePhoto is true
 * @param {Date} [input.now]
 * @returns {object} { reference, createdAt, brand, customer, measurement, product, selections, includeInstallation, quote, photo? }
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
  now = new Date(),
} = {}) {
  const fields = leadFields(config);
  const customerOut = {};
  for (const field of fields) customerOut[field.id] = cleanValue(customer, field.id);

  let when = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(when.getTime())) when = new Date();
  const reference = makeReference(when.getTime(), fields, customerOut);

  // Recorded as given rather than assumed, so a caller that skipped validation can never fabricate consent.
  customerOut.consent = Boolean(customer) && customer.consent === true;

  const payload = {
    reference,
    createdAt: when.toISOString(),
    brand: typeof config?.brand?.name === 'string' ? config.brand.name : '',
    customer: customerOut,
    measurement: cleanMeasurement(measurement),
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

/** Longest prefix of text (plus a marker) whose percent-encoded form fits in maxEncoded characters. */
function fitEncoded(text, maxEncoded) {
  if (encode(text).length <= maxEncoded) return text;
  const budget = maxEncoded - encode(TRUNCATION_MARK).length;
  let used = 0;
  let kept = '';
  // Iterating by code point keeps surrogate pairs whole; encoding is additive per code point.
  for (const ch of text) {
    const cost = encode(ch).length;
    if (used + cost > budget) break;
    used += cost;
    kept += ch;
  }
  return kept.trimEnd() + TRUNCATION_MARK;
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
      lines.push(labelled(label, value ? 'Yes' : 'No'));
    } else if (value !== null && value !== undefined && value !== '') {
      const choice = Array.isArray(option?.choices) ? option.choices.find((c) => c && c.id === value) : null;
      lines.push(labelled(label, oneLine(choice?.label ?? value)));
    }
  }
  return lines;
}

function measuredLine(measurement) {
  if (measurement?.source === 'manual') return 'Measured: entered by the customer (not from a photo)';
  let text = 'Measured: from a photo';
  if (measurement?.quality) text += `, confidence ${oneLine(measurement.quality)}`;
  const { sigmaWidthMm, sigmaHeightMm } = measurement ?? {};
  if (Number.isFinite(sigmaWidthMm) && Number.isFinite(sigmaHeightMm)) {
    // Two sigma, never claiming better than 2 mm: the same "accurate to about" rule the customer was shown
    // on the result screen, so the company is not told a tighter figure than the customer was.
    const wide = Math.max(2, Math.ceil(2 * sigmaWidthMm));
    const high = Math.max(2, Math.ceil(2 * sigmaHeightMm));
    text += ` (about +/- ${wide} mm wide, +/- ${high} mm high)`;
  }
  return text;
}

function totalLine(config, quote) {
  if (!quote) return 'Total: not quoted';
  if (quote.status === 'out_of_range') return 'Total: no instant price, this size needs a custom quote';
  if (quote.status !== 'ok' || !Number.isFinite(quote.total)) return 'Total: not available';
  const locale = config?.pricing?.locale;
  const currency = quote.currency || config?.pricing?.currency;
  let text = `Total: ${formatMoney(quote.total, currency, locale)}`;
  if (Number.isFinite(quote.taxAmount) && quote.taxAmount > 0) {
    const taxLabel = oneLine(config?.pricing?.taxLabel || 'tax');
    text += ` (includes ${formatMoney(quote.taxAmount, currency, locale)} ${taxLabel})`;
  }
  return text;
}

function sizeText(measurement) {
  const { widthMm, heightMm } = measurement ?? {};
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)) return '';
  return `${Math.round(widthMm)} mm wide x ${Math.round(heightMm)} mm high`;
}

function mailSubject(payload) {
  const customer = payload?.customer ?? {};
  const name = oneLine(customer.name);
  const { widthMm, heightMm } = payload?.measurement ?? {};
  let subject = `Door quote request ${oneLine(payload?.reference)}`;
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
  const lines = [brand ? `New quote request via ${brand}` : 'New quote request', ''];
  lines.push(`Reference: ${oneLine(payload?.reference)}`, '');

  const contact = [];
  for (const field of fields) {
    if (field.type === 'textarea') continue;
    const value = oneLine(cleanValue(customer, field.id));
    if (value) contact.push(labelled(field.label || field.id, value));
  }
  if (contact.length > 0) lines.push(...contact, '');

  lines.push(`Door size: ${sizeText(payload?.measurement) || 'not provided'}`);
  lines.push(measuredLine(payload?.measurement));
  lines.push(`Product: ${oneLine(payload?.product?.name) || 'not selected'}`);
  const options = optionLines(config, payload?.selections);
  if (options.length > 0) lines.push('Options:', ...options.map((line) => `- ${line}`));
  const installation = config?.pricing?.installation;
  if (installation && installation.enabled) {
    lines.push(`Installation: ${payload?.includeInstallation ? 'Yes' : 'No'}`);
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
 * included.
 *
 * @param {object} config merged app config
 * @param {object} payload a buildLeadPayload result
 * @returns {string} mailto: URL
 */
export function buildMailtoUrl(config, payload) {
  const to = mailtoAddress(config?.lead?.mailto);
  const subject = encode(mailSubject(payload));
  const body = encode(fitEncoded(mailBody(config, payload), MAILTO_MAX_BODY_CHARS));
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

async function postToWebhook(endpoint, payload, timeoutMs) {
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
    const request = globalThis.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
 * - webhook: POSTs the payload as JSON to config.lead.endpoint; ok only on a
 *   2xx response. error is 'http_<status>', 'network', 'timeout' or
 *   'invalid_payload'. Customer data only ever travels in the request body.
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
      return await postToWebhook(config.lead.endpoint.trim(), payload, timeoutMs);
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
