import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import baseConfig from '../js/config.js';
import acmeSkin from '../skins/acme.js';
import { deepMerge, loadConfig } from '../js/theme.js';
import { SHIPPED_CONFIG } from './helpers/shipped-config.mjs';

// ---------------------------------------------------------------------------
// The contract skeleton: every key the rest of the app is entitled to read,
// and its type. Leaves are a typeof name, 'array', or 'object' (free-form map).
// ---------------------------------------------------------------------------
const COLOR_KEYS = [
  'primary',
  'primaryContrast',
  'accent',
  'accentContrast',
  'background',
  'surface',
  'text',
  'muted',
  'border',
  'success',
  'warning',
  'danger',
];

const SKELETON = {
  brand: {
    name: 'string',
    tagline: 'string',
    lang: 'string',
    logoUrl: 'string',
    phone: 'string',
    email: 'string',
    website: 'string',
    colors: Object.fromEntries(COLOR_KEYS.map((key) => [key, 'string'])),
    radius: 'string',
    fontFamily: 'string',
  },
  measurement: {
    references: 'array',
    defaultReferenceId: 'string',
    allowCustomReference: 'boolean',
    maxWorkingSizePx: 'number',
    sigmaDoorPx: 'number',
    sigmaSheetRefinedPx: 'number',
    sigmaSheetManualPx: 'number',
    plausible: { minWidthMm: 'number', maxWidthMm: 'number', minHeightMm: 'number', maxHeightMm: 'number' },
    adjustments: { widthMm: 'number', heightMm: 'number' },
    roundToMm: 'number',
    allowManualOverride: 'boolean',
    demoPhotoUrl: 'string',
  },
  pricing: {
    currency: 'string',
    locale: 'string',
    taxLabel: 'string',
    taxRate: 'number',
    pricesIncludeTax: 'boolean',
    roundTo: 'number',
    limits: { minWidthMm: 'number', maxWidthMm: 'number', minHeightMm: 'number', maxHeightMm: 'number' },
    standardSize: { maxWidthMm: 'number', maxHeightMm: 'number' },
    products: 'array',
    options: 'array',
    installation: { enabled: 'boolean', label: 'string', price: 'number', default: 'boolean', optional: 'boolean' },
    quoteValidDays: 'number',
    disclaimer: 'string',
  },
  lead: {
    endpoint: 'string',
    contentType: 'string',
    mailto: 'string',
    includePhoto: 'boolean',
    fields: 'array',
    consentText: 'string',
    successTitle: 'string',
    successMessage: 'string',
  },
  embed: { parentOrigin: 'string' },
  text: 'object',
};

/** Keys allowed on the items of each config list: name -> [type, required]. */
const ITEM_SHAPES = {
  reference: {
    id: ['string', true],
    label: ['string', true],
    widthMm: ['number', true],
    heightMm: ['number', true],
    recommended: ['boolean', false],
    lowAccuracy: ['boolean', false],
  },
  product: {
    id: ['string', true],
    name: ['string', true],
    description: ['string', true],
    features: ['array', true],
    basePrice: ['number', true],
    oversizePerSqm: ['number', true],
    badge: ['string', false],
  },
  selectOption: {
    id: ['string', true],
    label: ['string', true],
    type: ['string', true],
    default: ['string', true],
    choices: ['array', true],
  },
  choice: {
    id: ['string', true],
    label: ['string', true],
    price: ['number', true],
  },
  checkboxOption: {
    id: ['string', true],
    label: ['string', true],
    type: ['string', true],
    price: ['number', true],
    description: ['string', true],
    default: ['boolean', true],
  },
  field: {
    id: ['string', true],
    label: ['string', true],
    type: ['string', true],
    required: ['boolean', true],
    autocomplete: ['string', false],
    inputmode: ['string', false],
  },
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function typeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

const describeType = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

/** Collects every place `value` is missing a skeleton key or holds the wrong type. */
function shapeErrors(value, shape, path = 'config') {
  if (typeof shape === 'string') {
    return typeMatches(value, shape) ? [] : [`${path}: expected ${shape}, got ${describeType(value)}`];
  }
  if (!isPlainObject(value)) return [`${path}: expected an object, got ${describeType(value)}`];
  return Object.entries(shape).flatMap(([key, sub]) =>
    key in value ? shapeErrors(value[key], sub, `${path}.${key}`) : [`${path}.${key}: missing`],
  );
}

/** Collects every key that is present in `value` but not named by the skeleton. */
function extraKeys(value, shape, path = 'config') {
  if (typeof shape === 'string' || !isPlainObject(value)) return [];
  return Object.keys(value).flatMap((key) =>
    key in shape ? extraKeys(value[key], shape[key], `${path}.${key}`) : [`${path}.${key}`],
  );
}

function itemErrors(item, shapeName, path) {
  if (!isPlainObject(item)) return [`${path}: expected an object, got ${describeType(item)}`];
  const shape = ITEM_SHAPES[shapeName];
  const errors = [];
  for (const [key, [type, required]] of Object.entries(shape)) {
    if (!(key in item)) {
      if (required) errors.push(`${path}.${key}: missing`);
    } else if (!typeMatches(item[key], type)) {
      errors.push(`${path}.${key}: expected ${type}, got ${describeType(item[key])}`);
    }
  }
  for (const key of Object.keys(item)) {
    if (!(key in shape)) errors.push(`${path}.${key}: not part of the contract`);
  }
  return errors;
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function assertUniqueIds(items, what) {
  const ids = items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, `${what} ids must be unique: ${ids.join(', ')}`);
  for (const id of ids) assert.match(id, ID_PATTERN, `${what} id "${id}" should be lower-case letters, numbers and dashes`);
}

// ---------------------------------------------------------------------------
// WCAG 2.x contrast, computed here rather than trusted from the config comments.
// ---------------------------------------------------------------------------
const HEX6 = /^#[0-9a-f]{6}$/i;

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((start) => {
    const c = parseInt(hex.slice(start, start + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_TEXT = 4.5;

/** [foreground key, background key] pairs that carry body-size text. */
const REQUIRED_TEXT_PAIRS = [
  ['primaryContrast', 'primary'],
  ['accentContrast', 'accent'],
  ['text', 'background'],
  ['text', 'surface'],
  ['muted', 'background'],
  ['muted', 'surface'],
];

/** Not demanded by the contract, but these colours are bound to be used for text too. */
const EXTRA_TEXT_PAIRS = [
  ['primary', 'background'],
  ['primary', 'surface'],
  ['success', 'background'],
  ['success', 'surface'],
  ['warning', 'background'],
  ['warning', 'surface'],
  ['danger', 'background'],
  ['danger', 'surface'],
];

test('the contrast helper matches known WCAG values', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(Math.abs(contrastRatio('#ffffff', '#ffffff') - 1) < 1e-9);
  // #767676 on white is the textbook "just passes AA" grey (4.54:1).
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.01);
  assert.equal(contrastRatio('#123456', '#fedcba'), contrastRatio('#fedcba', '#123456'));
});

// ---------------------------------------------------------------------------
// Two groups of checks, each run against the default config and the
// acme-skinned config:
//   "is a valid config"  rules every config must obey for the app to work. They
//                        should still pass after a door company edits js/config.js.
//   "as shipped"         pins the demo content this repo ships with. Expect to
//                        adjust or delete these once the demo content is replaced.
// ---------------------------------------------------------------------------
const variants = {
  'default config': () => baseConfig,
  'acme-skinned config': () => loadConfig('?skin=acme'),
};

for (const [variantName, getConfig] of Object.entries(variants)) {
  describe(`${variantName} is a valid config`, () => {
    test('has every key in the contract skeleton with the right type', async () => {
      const config = await getConfig();
      assert.deepEqual(shapeErrors(config, SKELETON), []);
    });

    test('survives a JSON round trip (plain data only, no functions or undefined)', async () => {
      const config = await getConfig();
      assert.deepEqual(JSON.parse(JSON.stringify(config)), config);
    });

    test('brand settings are usable', async () => {
      const { brand } = await getConfig();
      assert.ok(nonEmpty(brand.name), 'brand.name is required');
      // '' keeps the language written in index.html; anything else must be a language tag (js/theme.js applies it).
      if (brand.lang !== '') assert.match(brand.lang, /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i, `brand.lang = ${JSON.stringify(brand.lang)}`);
      if (brand.email !== '') assert.match(brand.email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
      if (brand.website !== '') assert.match(brand.website, /^https?:\/\//);
      assert.match(brand.radius, /^\d*\.?\d+(px|rem|em)$/);
      assert.ok(nonEmpty(brand.fontFamily));
      assert.ok(!/url\(|@import/i.test(brand.fontFamily), 'no web fonts: system font stack only');
      assert.ok(!brand.logoUrl.startsWith('/'), 'logoUrl must be relative so the app works under a sub-path');
    });

    test('all colours are valid 6-digit hex', async () => {
      const { colors } = (await getConfig()).brand;
      assert.deepEqual(Object.keys(colors).sort(), [...COLOR_KEYS].sort());
      for (const key of COLOR_KEYS) {
        assert.match(colors[key], HEX6, `brand.colors.${key} = ${JSON.stringify(colors[key])}`);
      }
    });

    test('every required text/background pair meets WCAG AA (4.5:1)', async () => {
      const { colors } = (await getConfig()).brand;
      for (const [fg, bg] of REQUIRED_TEXT_PAIRS) {
        const ratio = contrastRatio(colors[fg], colors[bg]);
        assert.ok(ratio >= AA_TEXT, `${fg} ${colors[fg]} on ${bg} ${colors[bg]} is only ${ratio.toFixed(2)}:1`);
      }
    });

    test('primary and status colours are also readable as text on the page and on cards', async () => {
      const { colors } = (await getConfig()).brand;
      for (const [fg, bg] of EXTRA_TEXT_PAIRS) {
        const ratio = contrastRatio(colors[fg], colors[bg]);
        assert.ok(ratio >= AA_TEXT, `${fg} ${colors[fg]} on ${bg} ${colors[bg]} is only ${ratio.toFixed(2)}:1`);
      }
    });

    test('references have positive sizes, unique ids, and the default exists', async () => {
      const { measurement } = await getConfig();
      const { references } = measurement;
      assert.ok(references.length >= 1);
      assert.deepEqual(references.flatMap((ref, i) => itemErrors(ref, 'reference', `references[${i}]`)), []);
      assertUniqueIds(references, 'reference');
      for (const ref of references) {
        assert.ok(nonEmpty(ref.label));
        assert.ok(ref.widthMm > 0, `${ref.id}.widthMm`);
        assert.ok(ref.heightMm > 0, `${ref.id}.heightMm`);
        assert.notEqual(ref.id, 'custom', "'custom' is reserved for the customer's own sheet size");
      }
      assert.ok(
        references.some((ref) => ref.id === measurement.defaultReferenceId),
        `defaultReferenceId "${measurement.defaultReferenceId}" is not one of the references`,
      );
    });

    test('measurement numbers are sane', async () => {
      const { measurement } = await getConfig();
      assert.ok(measurement.maxWorkingSizePx >= 1024);
      for (const key of ['sigmaDoorPx', 'sigmaSheetRefinedPx', 'sigmaSheetManualPx']) {
        assert.ok(measurement[key] > 0, key);
      }
      assert.ok(measurement.sigmaSheetRefinedPx <= measurement.sigmaSheetManualPx, 'refined corners are the more precise ones');
      const p = measurement.plausible;
      assert.ok(0 < p.minWidthMm && p.minWidthMm < p.maxWidthMm);
      assert.ok(0 < p.minHeightMm && p.minHeightMm < p.maxHeightMm);
      assert.ok(measurement.roundToMm > 0);
      assert.ok(!measurement.demoPhotoUrl.startsWith('/'), 'demoPhotoUrl must be relative so the app works under a sub-path');
      assert.ok(!/^[a-z]+:/i.test(measurement.demoPhotoUrl), 'the demo photo must be a local file: no network requests');
    });

    test('pricing basics are sane', async () => {
      const { pricing } = await getConfig();
      assert.match(pricing.currency, /^[A-Z]{3}$/);
      assert.doesNotThrow(() => new Intl.NumberFormat(pricing.locale, { style: 'currency', currency: pricing.currency }).format(1290));
      assert.ok(nonEmpty(pricing.taxLabel));
      assert.ok(pricing.taxRate >= 0 && pricing.taxRate < 1, 'taxRate is a fraction, e.g. 0.10 for 10%');
      assert.ok(pricing.roundTo > 0);
      assert.ok(Number.isInteger(pricing.quoteValidDays) && pricing.quoteValidDays > 0);
      assert.ok(nonEmpty(pricing.disclaimer));
    });

    test('pricing.limits is a real range that contains pricing.standardSize', async () => {
      const { limits, standardSize } = (await getConfig()).pricing;
      assert.ok(0 < limits.minWidthMm && limits.minWidthMm < limits.maxWidthMm);
      assert.ok(0 < limits.minHeightMm && limits.minHeightMm < limits.maxHeightMm);
      assert.ok(limits.minWidthMm <= standardSize.maxWidthMm && standardSize.maxWidthMm <= limits.maxWidthMm, 'standard width inside limits');
      assert.ok(limits.minHeightMm <= standardSize.maxHeightMm && standardSize.maxHeightMm <= limits.maxHeightMm, 'standard height inside limits');
    });

    test('the plausible measurement range contains pricing.limits', async () => {
      const config = await getConfig();
      const { plausible } = config.measurement;
      const { limits } = config.pricing;
      // Otherwise a door could be priced instantly while being flagged as an implausible measurement.
      assert.ok(plausible.minWidthMm <= limits.minWidthMm && limits.maxWidthMm <= plausible.maxWidthMm);
      assert.ok(plausible.minHeightMm <= limits.minHeightMm && limits.maxHeightMm <= plausible.maxHeightMm);
    });

    test('every product has a positive basePrice and a non-negative oversizePerSqm', async () => {
      const { products } = (await getConfig()).pricing;
      assert.ok(products.length >= 1);
      assert.deepEqual(products.flatMap((product, i) => itemErrors(product, 'product', `products[${i}]`)), []);
      assertUniqueIds(products, 'product');
      for (const product of products) {
        assert.ok(nonEmpty(product.name), `${product.id}.name`);
        assert.ok(nonEmpty(product.description), `${product.id}.description`);
        assert.ok(product.basePrice > 0, `${product.id}.basePrice`);
        assert.ok(product.oversizePerSqm >= 0, `${product.id}.oversizePerSqm`);
        for (const feature of product.features) assert.ok(nonEmpty(feature), `${product.id} has an empty feature`);
        if ('badge' in product) assert.ok(nonEmpty(product.badge), `${product.id}.badge`);
      }
    });

    test("every select option's default exists among its choices", async () => {
      const { options } = (await getConfig()).pricing;
      assertUniqueIds(options, 'option');
      // A company may delete every option of one kind (or all of them): only the ones present are checked.
      const selects = options.filter((option) => option.type === 'select');
      for (const option of selects) {
        assert.deepEqual(itemErrors(option, 'selectOption', `option ${option.id}`), []);
        assert.ok(option.choices.length >= 2, `${option.id} needs at least two choices`);
        assert.deepEqual(option.choices.flatMap((choice, i) => itemErrors(choice, 'choice', `${option.id}.choices[${i}]`)), []);
        assertUniqueIds(option.choices, `${option.id} choice`);
        for (const choice of option.choices) {
          assert.ok(nonEmpty(choice.label));
          assert.ok(choice.price >= 0, `${option.id}.${choice.id}.price`);
        }
        assert.ok(
          option.choices.some((choice) => choice.id === option.default),
          `option "${option.id}" default "${option.default}" is not one of its choices`,
        );
      }
    });

    test('checkbox options are well formed', async () => {
      const { options } = (await getConfig()).pricing;
      for (const option of options) {
        assert.ok(['select', 'checkbox'].includes(option.type), `option ${option.id} has unknown type "${option.type}"`);
      }
      const checkboxes = options.filter((option) => option.type === 'checkbox');
      for (const option of checkboxes) {
        assert.deepEqual(itemErrors(option, 'checkboxOption', `option ${option.id}`), []);
        assert.ok(nonEmpty(option.label));
        assert.ok(nonEmpty(option.description));
        assert.ok(option.price >= 0, `${option.id}.price`);
      }
    });

    test('installation is well formed', async () => {
      const { installation } = (await getConfig()).pricing;
      assert.ok(nonEmpty(installation.label));
      assert.ok(installation.price >= 0);
    });

    test('lead.fields ids are unique and the fields are well formed', async () => {
      const { lead } = await getConfig();
      assert.ok(lead.fields.length >= 1);
      assert.deepEqual(lead.fields.flatMap((field, i) => itemErrors(field, 'field', `fields[${i}]`)), []);
      assertUniqueIds(lead.fields, 'lead field');
      for (const field of lead.fields) {
        assert.ok(nonEmpty(field.label), `${field.id}.label`);
        assert.ok(['text', 'tel', 'email', 'textarea'].includes(field.type), `${field.id} has unknown type "${field.type}"`);
        assert.notEqual(field.id, 'consent', "'consent' is reserved for the consent tick-box");
      }
      assert.ok(nonEmpty(lead.consentText));
      assert.ok(nonEmpty(lead.successTitle));
      assert.ok(nonEmpty(lead.successMessage));
    });

    test('lead.contentType is empty (plain text, no preflight) or a media type', async () => {
      const { lead } = await getConfig();
      // It becomes the value of a request header, so it must be one line that looks like 'type/subtype'.
      if (lead.contentType.trim() !== '') {
        assert.match(lead.contentType.trim(), /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(\s*;\s*[a-z0-9-]+=[^\s;]+)*$/i, `lead.contentType = ${JSON.stringify(lead.contentType)}`);
      }
    });

    test('text overrides are strings keyed by dotted string ids', async () => {
      const { text } = await getConfig();
      for (const [key, value] of Object.entries(text)) {
        assert.match(key, /^[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.-]+$/, `text key "${key}"`);
        assert.ok(nonEmpty(value), `text["${key}"]`);
      }
    });

    test('contains no emoji', async () => {
      const config = await getConfig();
      assert.ok(!/\p{Extended_Pictographic}/u.test(JSON.stringify(config)));
    });
  });

  describe(`${variantName} as shipped`, () => {
    test('has contact details filled in', async () => {
      const { brand } = await getConfig();
      assert.ok(nonEmpty(brand.tagline));
      assert.ok(nonEmpty(brand.phone));
      assert.ok(nonEmpty(brand.email));
      assert.match(brand.website, /^https:\/\//);
    });

    test('offers the contract references (A4 default, US Letter, bank card)', async () => {
      const { measurement } = await getConfig();
      const byId = Object.fromEntries(measurement.references.map((ref) => [ref.id, ref]));
      assert.deepEqual(Object.keys(byId), ['a4', 'letter', 'card']);
      assert.equal(measurement.defaultReferenceId, 'a4');
      assert.deepEqual([byId.a4.widthMm, byId.a4.heightMm], [210, 297]);
      assert.equal(byId.a4.recommended, true);
      assert.deepEqual([byId.letter.widthMm, byId.letter.heightMm], [215.9, 279.4]);
      assert.deepEqual([byId.card.widthMm, byId.card.heightMm], [85.6, 53.98]);
      assert.equal(byId.card.lowAccuracy, true);
    });

    test('offers three tiers, cheapest first, with one badge and 3-4 features each', async () => {
      const { products } = (await getConfig()).pricing;
      assert.equal(products.length, 3);
      const prices = products.map((product) => product.basePrice);
      assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
      assert.equal(products.filter((product) => 'badge' in product).length, 1);
      assert.ok(products.some((product) => /316/.test(product.name + product.features.join(' '))), 'a 316 stainless tier');
      for (const product of products) {
        assert.ok(product.features.length >= 3 && product.features.length <= 4, `${product.id} should list 3-4 features`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// As shipped: the default config against the contract's stated defaults.
// ---------------------------------------------------------------------------
describe('default config as shipped: contract defaults', () => {
  test('adds no keys beyond the contract skeleton', () => {
    assert.deepEqual(
      extraKeys(baseConfig, SKELETON),
      [],
      'js/config.js has keys the contract does not name. If they are intentional, add them to SKELETON in this test.',
    );
    assert.deepEqual(Object.keys(baseConfig), ['brand', 'measurement', 'pricing', 'lead', 'embed', 'text'], 'sections in top-down order');
  });

  test('matches the contract defaults', () => {
    const { brand, measurement, pricing, lead, embed, text } = baseConfig;
    assert.equal(brand.name, 'SecureMeasure');
    assert.equal(brand.lang, 'en-AU', 'the language index.html declares for the built-in wording');
    assert.equal(brand.logoUrl, '');
    assert.equal(brand.radius, '14px');

    assert.equal(measurement.allowCustomReference, true);
    assert.equal(measurement.maxWorkingSizePx, 2560);
    assert.equal(measurement.sigmaDoorPx, 2.5);
    assert.equal(measurement.sigmaSheetRefinedPx, 0.5);
    assert.equal(measurement.sigmaSheetManualPx, 2);
    assert.deepEqual(measurement.plausible, { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 });
    assert.deepEqual(measurement.adjustments, { widthMm: 0, heightMm: 0 });
    assert.equal(measurement.roundToMm, 1);
    assert.equal(measurement.allowManualOverride, true);
    assert.equal(measurement.demoPhotoUrl, 'assets/demo-door.png');

    assert.equal(pricing.currency, 'AUD');
    assert.equal(pricing.locale, 'en-AU');
    assert.equal(pricing.taxLabel, 'GST');
    assert.equal(pricing.taxRate, 0.1);
    assert.equal(pricing.pricesIncludeTax, true);
    assert.equal(pricing.roundTo, 1);
    assert.deepEqual(pricing.limits, { minWidthMm: 600, maxWidthMm: 1100, minHeightMm: 1900, maxHeightMm: 2400 });
    assert.deepEqual(pricing.standardSize, { maxWidthMm: 870, maxHeightMm: 2100 });
    assert.deepEqual(pricing.installation, {
      enabled: true,
      label: pricing.installation.label,
      price: pricing.installation.price,
      default: true,
      optional: true,
    });
    assert.equal(pricing.quoteValidDays, 30);

    assert.equal(lead.endpoint, '', 'ships in demo mode');
    assert.equal(lead.contentType, '', 'ships with the plain-text label, which needs no preflight');
    assert.equal(lead.mailto, '', 'ships in demo mode');
    assert.equal(lead.includePhoto, false);
    assert.deepEqual(
      lead.fields.map(({ label, ...rest }) => rest),
      [
        { id: 'name', type: 'text', required: true, autocomplete: 'name' },
        { id: 'phone', type: 'tel', required: true, autocomplete: 'tel' },
        { id: 'email', type: 'email', required: true, autocomplete: 'email' },
        { id: 'postcode', type: 'text', required: true, autocomplete: 'postal-code', inputmode: 'numeric' },
        { id: 'notes', type: 'textarea', required: false },
      ],
    );

    assert.deepEqual(embed, { parentOrigin: '' });
    assert.deepEqual(text, {});
  });

  test('offers the contract options: frame colour, triple lock, pet door, door closer', () => {
    const { options } = baseConfig.pricing;
    assert.deepEqual(
      options.map((option) => option.type),
      ['select', 'checkbox', 'checkbox', 'checkbox'],
    );
    const colour = options[0];
    assert.ok(colour.choices.filter((choice) => choice.price === 0).length >= 2, 'standard colours are free');
    assert.ok(colour.choices.filter((choice) => choice.price > 0).length >= 2, 'a couple of colours carry a surcharge');
    assert.equal(colour.choices.find((choice) => choice.id === colour.default).price, 0, 'the default colour is a free one');
    for (const option of options.slice(1)) assert.equal(option.default, false);
  });

  test('the demo door (820 x 2040 mm) prices as a standard size', () => {
    const { limits, standardSize } = baseConfig.pricing;
    assert.ok(820 >= limits.minWidthMm && 820 <= standardSize.maxWidthMm);
    assert.ok(2040 >= limits.minHeightMm && 2040 <= standardSize.maxHeightMm);
  });

  test('is the configuration the end-to-end tests are pinned to (tests/helpers/shipped-config.mjs)', () => {
    // The measuring, pricing and lead tests run on that fixed copy, so that an edited js/config.js cannot
    // fail them. This check is what keeps the copy honest while js/config.js is still the shipped one.
    assert.deepEqual(
      baseConfig,
      SHIPPED_CONFIG,
      'js/config.js differs from tests/helpers/shipped-config.mjs. If you have made js/config.js your own, that is expected: ' +
        'adjust or delete this "as shipped" group. If you changed the defaults this repo ships, make the same change in the helper.',
    );
  });
});

// ---------------------------------------------------------------------------
// The acme skin file itself.
// ---------------------------------------------------------------------------
describe('acme skin', () => {
  /** Every key path in the skin, stopping at arrays and at the free-form text map. */
  function overridePaths(value, path = []) {
    if (!isPlainObject(value) || path[0] === 'text') return [path];
    return Object.entries(value).flatMap(([key, sub]) => overridePaths(sub, [...path, key]));
  }

  const lookup = (object, path) => path.reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), object);

  test('only overrides settings that exist in js/config.js', () => {
    for (const path of overridePaths(acmeSkin)) {
      assert.notEqual(lookup(baseConfig, path), undefined, `skins/acme.js sets "${path.join('.')}", which js/config.js does not have`);
    }
  });

  test('is a partial config, not a copy of the whole thing', () => {
    assert.ok(shapeErrors(acmeSkin, SKELETON).length > 0, 'a skin should hold only the differences');
    assert.equal('measurement' in acmeSkin, false);
    assert.equal('lead' in acmeSkin, false);
  });

  test('changes what a skin is meant to change', async () => {
    assert.deepEqual(await loadConfig('?skin=acme'), deepMerge(baseConfig, acmeSkin));

    // What the example skin changes is judged against the shipped defaults, not against js/config.js: a
    // company that has edited js/config.js may have picked the same corner radius or a similar colour.
    const shipped = SHIPPED_CONFIG;
    const merged = deepMerge(shipped, acmeSkin);
    assert.equal(merged.brand.name, 'Acme Security Doors');
    assert.notEqual(merged.brand.phone, shipped.brand.phone);
    assert.notEqual(merged.brand.radius, shipped.brand.radius);

    // A visibly different palette: the two colours that carry the brand must both change.
    for (const key of ['primary', 'accent', 'background']) {
      assert.notEqual(merged.brand.colors[key].toLowerCase(), shipped.brand.colors[key].toLowerCase(), `colors.${key}`);
    }

    const baseProducts = shipped.pricing.products;
    const acmeProducts = merged.pricing.products;
    const baseNames = new Set(baseProducts.map((product) => product.name));
    for (const product of acmeProducts) assert.equal(baseNames.has(product.name), false, `${product.name} should be renamed`);
    assert.notDeepEqual(
      acmeProducts.map((product) => product.basePrice),
      baseProducts.map((product) => product.basePrice),
    );

    assert.equal(Object.keys(merged.text).length, 2);
    assert.ok('welcome.title' in merged.text);
  });
});
