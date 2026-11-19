/**
 * SecureMeasure pricing engine.
 *
 * Pure functions only: no DOM, no globals, safe to import under Node. Everything here is
 * defensive, because it runs straight off customer input and a config file that is edited by
 * people who are not developers: bad input produces a result with status 'invalid', never an
 * exception.
 *
 * Money is carried as integer cents internally and only converted back to currency units at the
 * very end, so results never show floating point artefacts such as 1109.9999999999998.
 */

const DEFAULT_CURRENCY = 'AUD';
const DEFAULT_TAX_LABEL = 'Tax';
const MM2_PER_SQM = 1e6;
const NO_VALUE = '—';

/**
 * Default wording for every string this module generates. A company can override any of them
 * through `config.text` using the same key, exactly like the screen strings. `{name}` placeholders
 * are filled in by the module.
 */
export const QUOTE_STRINGS = Object.freeze({
  'pricing.oversizeLabel': 'Oversize surcharge',
  'pricing.oversizeDetail': '{extraSqm} m² larger than our standard {standardWidthMm} × {standardHeightMm} mm',
  'pricing.optionLabel': '{option}: {choice}',
  'pricing.tooNarrow': 'At {size} wide, your door opening is narrower than the {limit} we can price online.',
  'pricing.tooWide': 'At {size} wide, your door opening is wider than the {limit} we can price online.',
  'pricing.tooShort': 'At {size} high, your door opening is shorter than the {limit} we can price online.',
  'pricing.tooTall': 'At {size} high, your door opening is taller than the {limit} we can price online.',
  'pricing.customQuote': 'It needs a custom quote, so we will work out your price personally.',
  'pricing.invalidSize': 'We need a valid door width and height to work out a price.',
  'pricing.noProduct': 'Choose a door to see your price.',
  'pricing.unknownProduct': 'We could not find the door "{id}".',
  'pricing.unknownOption': 'We could not find the option "{id}".',
  'pricing.unknownChoice': 'We could not find the choice "{choice}" for {option}.',
  'pricing.invalidSelection': 'The selection for {option} is not valid.',
  'pricing.invalidSelections': 'The selected options are not valid.',
  'pricing.invalidInstallation': 'The installation choice is not valid.',
  'pricing.badPrice': 'The price for {item} is not set up correctly.',
  'pricing.notConfigured': 'Pricing is not set up correctly, so we cannot show an instant price.',
});

/**
 * @typedef {object} QuoteLineItem
 * @property {string} id       'product' | 'oversize' | 'option:<optionId>' | 'installation'
 * @property {string} label
 * @property {number} amount   In currency units, already rounded to pricing.roundTo.
 * @property {string} [detail]
 */

/**
 * @typedef {object} QuoteResult
 * @property {boolean} ok                        True only when status is 'ok'.
 * @property {'ok' | 'out_of_range' | 'invalid'} status
 * @property {'standard' | 'oversize'} sizeCategory
 * @property {number} areaSqm                    Door area in square metres (0 when the size is invalid).
 * @property {QuoteLineItem[]} lineItems         Empty unless status is 'ok'.
 * @property {number} subtotal                   Amount before tax.
 * @property {number} taxAmount                  Tax added on top, or the tax component already inside the prices.
 * @property {number} total                      Amount payable; always subtotal + taxAmount.
 * @property {string} currency
 * @property {string} taxLabel
 * @property {boolean} pricesIncludeTax
 * @property {string[]} messages                 Customer-readable explanations when status is not 'ok'.
 * @property {string | null} productId           The product that was priced.
 * @property {Record<string, string | boolean>} selections   Option selections with defaults filled in.
 * @property {boolean} includeInstallation       Whether installation ended up in the price.
 */

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isPositive = (value) => Number.isFinite(value) && value > 0;

/**
 * Lenient numeric read: numbers pass through, numeric strings are parsed, anything else is NaN
 * (so null, '' and booleans never silently become 0 or 1).
 */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/** Config price in currency units -> integer cents, or null when it is not a usable number. */
function toCents(value) {
  const amount = toNumber(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/** pricing.roundTo (currency units) -> rounding step in cents; missing or non-positive means one cent. */
function roundingStepCents(pricing) {
  const roundTo = toNumber(pricing.roundTo);
  if (!isPositive(roundTo)) return 1;
  return Math.max(1, Math.round(roundTo * 100));
}

/**
 * Round a (possibly fractional) cent amount to the nearest multiple of `step`, halves away from
 * zero. The quotient is snapped to six decimals first so float noise such as 2.4999999999 cannot
 * flip a genuine tie the wrong way.
 */
function roundToStep(cents, step) {
  const quotient = Math.round((cents / step) * 1e6) / 1e6;
  return Math.sign(quotient) * Math.round(Math.abs(quotient)) * step + 0;
}

/** Look up a string (company override first, then the default) and fill in {placeholders}. */
function text(config, key, vars = {}) {
  const overrides = isObject(config) && isObject(config.text) ? config.text : null;
  const override = overrides && hasOwn(overrides, key) ? overrides[key] : undefined;
  const template = typeof override === 'string' ? override : QUOTE_STRINGS[key];
  return template.replace(/\{(\w+)\}/g, (match, name) => (hasOwn(vars, name) ? String(vars[name]) : match));
}

const labelOf = (item, fallback) =>
  typeof item.label === 'string' && item.label !== '' ? item.label : String(fallback);

/** Extra area shown with as few decimals as still say something (0.27, 0.009). */
function formatExtraArea(sqm) {
  return String(Number(sqm.toFixed(sqm >= 0.01 ? 2 : 3)));
}

function quoteMeta(pricing) {
  const currency = pricing && typeof pricing.currency === 'string' && pricing.currency !== '';
  const taxLabel = pricing && typeof pricing.taxLabel === 'string' && pricing.taxLabel !== '';
  return {
    currency: currency ? pricing.currency : DEFAULT_CURRENCY,
    taxLabel: taxLabel ? pricing.taxLabel : DEFAULT_TAX_LABEL,
    pricesIncludeTax: !pricing || pricing.pricesIncludeTax !== false,
  };
}

/** A complete, price-free result, so callers can rely on every field existing whatever the status. */
function emptyResult(status, meta, messages) {
  return {
    ok: false,
    status,
    sizeCategory: 'standard',
    areaSqm: 0,
    lineItems: [],
    subtotal: 0,
    taxAmount: 0,
    total: 0,
    currency: meta.currency,
    taxLabel: meta.taxLabel,
    pricesIncludeTax: meta.pricesIncludeTax,
    messages,
    productId: null,
    selections: {},
    includeInstallation: false,
  };
}

/** One message per limit the opening breaks; empty when the size can be priced instantly. */
function outOfRangeMessages(config, pricing, widthMm, heightMm) {
  const limits = isObject(pricing.limits) ? pricing.limits : {};
  const checks = [
    ['pricing.tooNarrow', widthMm, limits.minWidthMm, -1],
    ['pricing.tooWide', widthMm, limits.maxWidthMm, 1],
    ['pricing.tooShort', heightMm, limits.minHeightMm, -1],
    ['pricing.tooTall', heightMm, limits.maxHeightMm, 1],
  ];
  const messages = [];
  for (const [key, size, rawLimit, direction] of checks) {
    const limit = toNumber(rawLimit);
    // A missing limit is simply not enforced; the limits themselves are in range (inclusive).
    if (Number.isFinite(limit) && (size - limit) * direction > 0) {
      messages.push(text(config, key, { size: formatLength(size), limit: formatLength(limit) }));
    }
  }
  return messages;
}

function computeQuote(config, input) {
  const pricing = isObject(config) && isObject(config.pricing) ? config.pricing : null;
  const meta = quoteMeta(pricing);
  const say = (key, vars) => text(config, key, vars);
  const fail = (status, messages, known) => ({ ...emptyResult(status, meta, messages), ...known });

  if (!pricing) return fail('invalid', [say('pricing.notConfigured')]);

  const args = isObject(input) ? input : {};
  const widthMm = toNumber(args.widthMm);
  const heightMm = toNumber(args.heightMm);
  if (!isPositive(widthMm) || !isPositive(heightMm)) return fail('invalid', [say('pricing.invalidSize')]);

  const standard = isObject(pricing.standardSize) ? pricing.standardSize : {};
  const standardWidthMm = toNumber(standard.maxWidthMm);
  const standardHeightMm = toNumber(standard.maxHeightMm);
  const isOversize = widthMm > standardWidthMm || heightMm > standardHeightMm; // NaN (not configured) compares false
  const known = { sizeCategory: isOversize ? 'oversize' : 'standard', areaSqm: (widthMm * heightMm) / MM2_PER_SQM };

  // Range is checked before the product so a screen can ask "can this size be priced at all?"
  // before the customer has picked a door.
  const rangeMessages = outOfRangeMessages(config, pricing, widthMm, heightMm);
  if (rangeMessages.length > 0) {
    return fail('out_of_range', [...rangeMessages, say('pricing.customQuote')], known);
  }

  const { productId } = args;
  if (productId === undefined || productId === null || productId === '') {
    return fail('invalid', [say('pricing.noProduct')], known);
  }
  const products = Array.isArray(pricing.products) ? pricing.products.filter(isObject) : [];
  const product = products.find((candidate) => candidate.id === productId);
  if (!product) return fail('invalid', [say('pricing.unknownProduct', { id: String(productId) })], known);
  known.productId = product.id;

  const productName = typeof product.name === 'string' && product.name !== '' ? product.name : String(product.id);
  const badPrice = (item) => fail('invalid', [say('pricing.badPrice', { item })], known);
  const step = roundingStepCents(pricing);

  /** @type {{ id: string, label: string, cents: number, detail?: string }[]} */
  const items = [];

  const baseCents = toCents(product.basePrice);
  if (baseCents === null || baseCents < 0) return badPrice(productName);
  items.push({ id: 'product', label: productName, cents: baseCents });

  if (isOversize && isPositive(standardWidthMm) && isPositive(standardHeightMm)) {
    const rateCents = toCents(product.oversizePerSqm === undefined ? 0 : product.oversizePerSqm);
    if (rateCents === null) return badPrice(productName);
    // An opening can be over in one dimension yet smaller in area than the standard size: no surcharge then.
    const extraMm2 = Math.max(0, widthMm * heightMm - standardWidthMm * standardHeightMm);
    const cents = (Math.max(0, rateCents) * extraMm2) / MM2_PER_SQM;
    if (roundToStep(cents, step) > 0) {
      items.push({
        id: 'oversize',
        label: say('pricing.oversizeLabel'),
        cents,
        detail: say('pricing.oversizeDetail', {
          extraSqm: formatExtraArea(extraMm2 / MM2_PER_SQM),
          standardWidthMm: Math.round(standardWidthMm),
          standardHeightMm: Math.round(standardHeightMm),
        }),
      });
    }
  }

  const given = args.selections === undefined || args.selections === null ? {} : args.selections;
  if (!isObject(given)) return fail('invalid', [say('pricing.invalidSelections')], known);
  const options = Array.isArray(pricing.options) ? pricing.options.filter(isObject) : [];
  const optionIds = new Set(options.map((option) => String(option.id)));
  for (const key of Object.keys(given)) {
    if (!optionIds.has(key)) return fail('invalid', [say('pricing.unknownOption', { id: key })], known);
  }

  const resolved = [];
  for (const option of options) {
    const key = String(option.id);
    const optionLabel = labelOf(option, key);
    const value = hasOwn(given, key) ? given[key] : undefined;
    const explicit = value !== undefined && value !== null;

    if (option.type === 'select') {
      const choices = Array.isArray(option.choices) ? option.choices.filter(isObject) : [];
      let choice;
      if (explicit) {
        choice = choices.find((candidate) => candidate.id === value);
        if (!choice) {
          return fail('invalid', [say('pricing.unknownChoice', { choice: String(value), option: optionLabel })], known);
        }
      } else {
        // A missing or misspelt default is the company's typo, not the customer's: use the first choice.
        choice = choices.find((candidate) => candidate.id === option.default) || choices[0];
        if (!choice) continue;
      }
      const choiceLabel = labelOf(choice, choice.id);
      const cents = toCents(choice.price === undefined ? 0 : choice.price);
      if (cents === null) return badPrice(choiceLabel);
      resolved.push([key, choice.id]);
      // Zero-priced choices are listed too, so the summary always shows what was chosen (e.g. the colour).
      items.push({
        id: `option:${key}`,
        label: say('pricing.optionLabel', { option: optionLabel, choice: choiceLabel }),
        cents,
      });
    } else if (option.type === 'checkbox') {
      const checked = explicit ? value : option.default === true;
      if (typeof checked !== 'boolean') {
        return fail('invalid', [say('pricing.invalidSelection', { option: optionLabel })], known);
      }
      resolved.push([key, checked]);
      if (checked) {
        const cents = toCents(option.price === undefined ? 0 : option.price);
        if (cents === null) return badPrice(optionLabel);
        items.push({ id: `option:${key}`, label: optionLabel, cents });
      }
    }
  }
  // fromEntries defines own properties, so even an option called '__proto__' cannot touch a prototype.
  known.selections = Object.fromEntries(resolved);

  const installation = isObject(pricing.installation) && pricing.installation.enabled ? pricing.installation : null;
  let includeInstallation = false;
  if (installation) {
    const requested = args.includeInstallation;
    if (installation.optional === false) includeInstallation = true;
    else if (requested === undefined || requested === null) includeInstallation = installation.default === true;
    else if (typeof requested === 'boolean') includeInstallation = requested;
    else return fail('invalid', [say('pricing.invalidInstallation')], known);
  }
  if (includeInstallation) {
    const label = labelOf(installation, 'Installation');
    const cents = toCents(installation.price === undefined ? 0 : installation.price);
    if (cents === null) return badPrice(label);
    items.push({ id: 'installation', label, cents });
  }

  // Each line is rounded on its own and the totals are built from the rounded lines, so what the
  // customer sees always adds up exactly.
  let sumCents = 0;
  const lineItems = items.map((item) => {
    const cents = roundToStep(item.cents, step);
    sumCents += cents;
    const line = { id: item.id, label: item.label, amount: cents / 100 };
    if (item.detail) line.detail = item.detail;
    return line;
  });

  const rawTaxRate = toNumber(pricing.taxRate);
  const taxRate = isPositive(rawTaxRate) ? rawTaxRate : 0;
  let subtotalCents;
  let taxCents;
  let totalCents;
  if (meta.pricesIncludeTax) {
    totalCents = sumCents;
    taxCents = roundToStep(totalCents - totalCents / (1 + taxRate), step);
    subtotalCents = totalCents - taxCents;
  } else {
    subtotalCents = sumCents;
    taxCents = roundToStep(subtotalCents * taxRate, step);
    totalCents = subtotalCents + taxCents;
  }

  return {
    ok: true,
    status: 'ok',
    sizeCategory: known.sizeCategory,
    areaSqm: known.areaSqm,
    lineItems,
    subtotal: subtotalCents / 100,
    taxAmount: taxCents / 100,
    total: totalCents / 100,
    currency: meta.currency,
    taxLabel: meta.taxLabel,
    pricesIncludeTax: meta.pricesIncludeTax,
    messages: [],
    productId: product.id,
    selections: known.selections,
    includeInstallation,
  };
}

/**
 * Turn a measured (or manually entered) door opening into the size the company quotes and makes:
 * adds `measurementCfg.adjustments` and rounds to the nearest `measurementCfg.roundToMm`
 * (missing or non-positive means 1 mm). Never throws; a size that is not a number comes back as NaN.
 *
 * @param {{ adjustments?: { widthMm?: number, heightMm?: number }, roundToMm?: number }} measurementCfg  config.measurement
 * @param {{ widthMm: number, heightMm: number }} size  Opening size in mm.
 * @returns {{ widthMm: number, heightMm: number }}
 */
export function applyMeasurementRules(measurementCfg, size) {
  const cfg = isObject(measurementCfg) ? measurementCfg : {};
  const adjustments = isObject(cfg.adjustments) ? cfg.adjustments : {};
  const rawStep = toNumber(cfg.roundToMm);
  const step = isPositive(rawStep) ? rawStep : 1;
  const apply = (value, adjustment) => {
    const extra = toNumber(adjustment);
    const adjusted = toNumber(value) + (Number.isFinite(extra) ? extra : 0);
    // The final snap removes float noise that fractional steps (0.1, 0.5) would otherwise leave behind.
    return Math.round(Math.round(adjusted / step) * step * 1e6) / 1e6;
  };
  const source = isObject(size) ? size : {};
  return {
    widthMm: apply(source.widthMm, adjustments.widthMm),
    heightMm: apply(source.heightMm, adjustments.heightMm),
  };
}

/**
 * Price a door from the company's pricing config.
 *
 * Price = product base price + oversize surcharge (product.oversizePerSqm x the area beyond the
 * standard-size area, only when either dimension exceeds pricing.standardSize) + the selected
 * options + installation. Every line item is rounded to pricing.roundTo and the totals are built
 * from the rounded lines, so they always add up: with tax-inclusive prices `total` is the sum of
 * the line items and `taxAmount` is the component already inside it; with tax-exclusive prices
 * `subtotal` is the sum and tax is added on top. In both modes subtotal + taxAmount === total.
 *
 * Never throws. Sizes outside pricing.limits give status 'out_of_range' (no prices); anything
 * unusable (unknown product, NaN or negative size, unknown option or choice) gives 'invalid'.
 *
 * @param {object} config  The merged app config (uses config.pricing, and config.text for wording overrides).
 * @param {object} input
 * @param {number} input.widthMm   Final (rule-adjusted) opening width in mm.
 * @param {number} input.heightMm  Final (rule-adjusted) opening height in mm.
 * @param {string} input.productId
 * @param {Record<string, string | boolean>} [input.selections]  { [optionId]: choiceId | boolean }; missing entries use the option's default.
 * @param {boolean | null} [input.includeInstallation]  undefined/null falls back to installation.default; ignored (always true) when installation.optional is false.
 * @returns {QuoteResult}
 */
export function calculateQuote(config, input) {
  try {
    return computeQuote(config, input);
  } catch {
    // Only reachable with a hostile or badly broken config object (e.g. a throwing getter).
    return emptyResult('invalid', quoteMeta(null), [QUOTE_STRINGS['pricing.notConfigured']]);
  }
}

const formatterCache = new Map();

function currencyFormatter(locale, currency, whole) {
  const key = `${locale}|${currency}|${whole}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    const options = { style: 'currency', currency };
    // Whole amounts drop the decimals; anything else keeps the currency's own precision (two for most).
    if (whole) Object.assign(options, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    formatter = new Intl.NumberFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/**
 * Format a money amount for display using pricing.locale and pricing.currency. Whole amounts show
 * no decimals ('$1,650'), anything else shows cents ('$1,650.50'). Never throws: an unusable
 * amount gives an em dash, and an unknown locale or currency code falls back gracefully.
 *
 * @param {number} amount  In currency units.
 * @param {object} config  The merged app config (a bare pricing section is accepted too).
 * @returns {string}
 */
export function formatMoney(amount, config) {
  const value = toNumber(amount);
  if (!Number.isFinite(value)) return NO_VALUE;

  let pricing = {};
  if (isObject(config)) pricing = isObject(config.pricing) ? config.pricing : config;
  const currency = typeof pricing.currency === 'string' && pricing.currency !== '' ? pricing.currency : DEFAULT_CURRENCY;
  const locale = typeof pricing.locale === 'string' && pricing.locale !== '' ? pricing.locale : undefined;

  const cents = Math.round(value * 100);
  const whole = cents % 100 === 0;
  const rounded = cents / 100 + 0; // + 0 turns -0 into 0 so a tiny negative never prints as '-$0'

  try {
    return currencyFormatter(locale, currency, whole).format(rounded);
  } catch {
    // Unknown locale: retry with the runtime's default before giving up on Intl altogether.
  }
  try {
    return currencyFormatter(undefined, currency, whole).format(rounded);
  } catch {
    return `${currency} ${rounded.toFixed(whole ? 0 : 2)}`;
  }
}

/**
 * Format a length in millimetres for display, rounded to the nearest whole millimetre: '2040 mm'.
 *
 * @param {number} mm
 * @returns {string}
 */
export function formatLength(mm) {
  const value = toNumber(mm);
  if (!Number.isFinite(value)) return NO_VALUE;
  return `${Math.round(value) + 0} mm`;
}

/**
 * A configured price as calculateQuote() charges it on a line: whole cents, then the nearest
 * multiple of pricing.roundTo, halves away from zero. The quote screen shows its price tags
 * through this, so a tag beside a door or option always equals the line it adds to the quote.
 *
 * @param {number} amount  In currency units (a numeric string is accepted, as in the config).
 * @param {object} config  The merged app config.
 * @returns {number} In currency units, or NaN when the amount is not a usable number.
 */
export function roundPrice(amount, config) {
  const pricing = isObject(config) && isObject(config.pricing) ? config.pricing : {};
  const cents = toCents(amount);
  return cents === null ? NaN : roundToStep(cents, roundingStepCents(pricing)) / 100;
}
