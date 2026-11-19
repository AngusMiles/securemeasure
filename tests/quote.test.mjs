import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMeasurementRules,
  calculateQuote,
  formatLength,
  formatMoney,
  QUOTE_STRINGS,
  roundPrice,
} from '../js/quote.js';

/** Recursively freeze so any accidental mutation of the config by the module fails loudly. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** Inline fixture following the shared config contract (js/config.js is deliberately not imported). */
function baseConfig() {
  return {
    brand: { name: 'Test Doors' },
    measurement: {
      adjustments: { widthMm: 0, heightMm: 0 },
      roundToMm: 1,
    },
    pricing: {
      currency: 'AUD',
      locale: 'en-AU',
      taxLabel: 'GST',
      taxRate: 0.1,
      pricesIncludeTax: true,
      roundTo: 1,
      limits: { minWidthMm: 600, maxWidthMm: 1100, minHeightMm: 1900, maxHeightMm: 2400 },
      standardSize: { maxWidthMm: 870, maxHeightMm: 2100 },
      products: [
        {
          id: 'classic',
          name: 'Classic Guard',
          description: 'Steel frame with a diamond grille.',
          features: ['Steel frame', 'Diamond grille'],
          basePrice: 890,
          oversizePerSqm: 180,
        },
        {
          id: 'premium',
          name: 'Premium Mesh',
          description: 'Stainless mesh with a clear view.',
          features: ['Stainless mesh', 'Triple lock ready'],
          basePrice: 1490,
          oversizePerSqm: 260,
          badge: 'Most popular',
        },
      ],
      options: [
        {
          id: 'colour',
          label: 'Colour',
          type: 'select',
          default: 'black',
          choices: [
            { id: 'black', label: 'Black', price: 0 },
            { id: 'white', label: 'White', price: 0 },
            { id: 'custom', label: 'Custom colour', price: 120 },
          ],
        },
        {
          id: 'lock',
          label: 'Lock',
          type: 'select',
          default: 'single',
          choices: [
            { id: 'single', label: 'Single lock', price: 0 },
            { id: 'triple', label: 'Triple lock', price: 165 },
          ],
        },
        { id: 'petdoor', label: 'Pet door', type: 'checkbox', price: 95, description: 'A flap for small pets.', default: false },
      ],
      installation: { enabled: true, label: 'Professional installation', price: 220, default: true, optional: true },
      quoteValidDays: 30,
      disclaimer: 'Subject to a final check measure.',
    },
    text: {},
  };
}

/** Frozen fixture with shallow overrides applied to the pricing section. */
function configWith(pricingOverrides = {}, extra = {}) {
  const config = baseConfig();
  Object.assign(config.pricing, pricingOverrides);
  Object.assign(config, extra);
  return deepFreeze(config);
}

const CONFIG = configWith();
const STANDARD = { widthMm: 820, heightMm: 2040, productId: 'classic' };

const cents = (amount) => Math.round(amount * 100);
const sumCents = (quote) => quote.lineItems.reduce((sum, item) => sum + cents(item.amount), 0);
const line = (quote, id) => quote.lineItems.find((item) => item.id === id);
const ids = (quote) => quote.lineItems.map((item) => item.id);

/** Invariants every result must satisfy whatever the status. */
function assertWellFormed(quote, config) {
  assert.equal(typeof quote.ok, 'boolean');
  assert.ok(['ok', 'out_of_range', 'invalid'].includes(quote.status));
  assert.equal(quote.ok, quote.status === 'ok');
  assert.ok(['standard', 'oversize'].includes(quote.sizeCategory));
  assert.ok(Array.isArray(quote.lineItems));
  assert.ok(Array.isArray(quote.messages));
  for (const key of ['areaSqm', 'subtotal', 'taxAmount', 'total']) {
    assert.ok(Number.isFinite(quote[key]), `${key} must be a finite number`);
  }
  assert.equal(typeof quote.currency, 'string');
  assert.equal(typeof quote.taxLabel, 'string');
  assert.equal(typeof quote.pricesIncludeTax, 'boolean');
  assert.doesNotThrow(() => JSON.stringify(quote));

  if (!quote.ok) {
    assert.deepEqual(quote.lineItems, []);
    assert.equal(quote.subtotal, 0);
    assert.equal(quote.taxAmount, 0);
    assert.equal(quote.total, 0);
    assert.ok(quote.messages.length > 0, 'a failed quote must explain itself');
    quote.messages.forEach((message) => assert.equal(typeof message, 'string'));
    return;
  }

  // The displayed lines add up to the pre-tax or post-tax figure, depending on how prices are entered.
  const linesTotal = sumCents(quote);
  assert.equal(linesTotal, cents(quote.pricesIncludeTax ? quote.total : quote.subtotal));
  assert.equal(cents(quote.subtotal) + cents(quote.taxAmount), cents(quote.total));

  // Every money figure is a multiple of pricing.roundTo and has no float artefacts.
  const step = cents(config.pricing.roundTo);
  const money = [quote.subtotal, quote.taxAmount, quote.total, ...quote.lineItems.map((item) => item.amount)];
  for (const amount of money) {
    assert.equal(Math.abs(cents(amount)) % step, 0, `${amount} is not a multiple of ${config.pricing.roundTo}`);
    assert.equal(amount, cents(amount) / 100, `${amount} has float noise`);
    assert.ok(!Object.is(amount, -0), 'no negative zero');
  }
  for (const item of quote.lineItems) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
  }
}

describe('calculateQuote: standard size', () => {
  test('prices base + default options + default installation', () => {
    const quote = calculateQuote(CONFIG, STANDARD);
    assertWellFormed(quote, CONFIG);
    assert.equal(quote.ok, true);
    assert.equal(quote.status, 'ok');
    assert.equal(quote.sizeCategory, 'standard');
    assert.equal(quote.areaSqm, 1.6728);
    assert.deepEqual(quote.lineItems, [
      { id: 'product', label: 'Classic Guard', amount: 890 },
      { id: 'option:colour', label: 'Colour: Black', amount: 0 },
      { id: 'option:lock', label: 'Lock: Single lock', amount: 0 },
      { id: 'installation', label: 'Professional installation', amount: 220 },
    ]);
    assert.equal(quote.total, 1110);
    assert.equal(quote.taxAmount, 101); // 1110 / 11 = 100.91, rounded to the whole dollar
    assert.equal(quote.subtotal, 1009);
    assert.equal(quote.currency, 'AUD');
    assert.equal(quote.taxLabel, 'GST');
    assert.equal(quote.pricesIncludeTax, true);
    assert.deepEqual(quote.messages, []);
  });

  test('reports the resolved product, selections and installation', () => {
    const quote = calculateQuote(CONFIG, STANDARD);
    assert.equal(quote.productId, 'classic');
    assert.deepEqual(quote.selections, { colour: 'black', lock: 'single', petdoor: false });
    assert.equal(quote.includeInstallation, true);
  });

  test('uses the chosen product', () => {
    const quote = calculateQuote(CONFIG, { ...STANDARD, productId: 'premium' });
    assertWellFormed(quote, CONFIG);
    assert.deepEqual(line(quote, 'product'), { id: 'product', label: 'Premium Mesh', amount: 1490 });
    assert.equal(quote.total, 1710);
  });

  test('exactly at the standard size is still standard', () => {
    const quote = calculateQuote(CONFIG, { widthMm: 870, heightMm: 2100, productId: 'classic' });
    assertWellFormed(quote, CONFIG);
    assert.equal(quote.sizeCategory, 'standard');
    assert.equal(line(quote, 'oversize'), undefined);
    assert.equal(quote.total, 1110);
  });

  test('accepts numeric strings for the size', () => {
    const quote = calculateQuote(CONFIG, { widthMm: '820', heightMm: ' 2040 ', productId: 'classic' });
    assert.equal(quote.status, 'ok');
    assert.equal(quote.total, 1110);
  });
});

describe('calculateQuote: oversize surcharge', () => {
  test('width only', () => {
    // (1000 x 2100 - 870 x 2100) mm2 = 0.273 m2; x $180 = $49.14 -> $49
    const quote = calculateQuote(CONFIG, { widthMm: 1000, heightMm: 2100, productId: 'classic' });
    assertWellFormed(quote, CONFIG);
    assert.equal(quote.sizeCategory, 'oversize');
    const oversize = line(quote, 'oversize');
    assert.equal(oversize.amount, 49);
    assert.equal(oversize.label, 'Oversize surcharge');
    assert.equal(oversize.detail, '0.27 m² larger than the 870 × 2100 mm our base price covers');
    assert.doesNotMatch(oversize.detail, /standard/i, 'the threshold is not one of the standard sizes the customer was shown');
    assert.deepEqual(ids(quote), ['product', 'oversize', 'option:colour', 'option:lock', 'installation']);
    assert.equal(quote.total, 890 + 49 + 220);
  });

  test('height only', () => {
    // 870 x 200 mm = 0.174 m2; x $180 = $31.32 -> $31
    const quote = calculateQuote(CONFIG, { widthMm: 870, heightMm: 2300, productId: 'classic' });
    assertWellFormed(quote, CONFIG);
    assert.equal(quote.sizeCategory, 'oversize');
    assert.equal(line(quote, 'oversize').amount, 31);
    assert.equal(quote.total, 890 + 31 + 220);
  });

  test('both dimensions', () => {
    // 2.3 - 1.827 = 0.473 m2; x $180 = $85.14 -> $85
    const quote = calculateQuote(CONFIG, { widthMm: 1000, heightMm: 2300, productId: 'classic' });
    assertWellFormed(quote, CONFIG);
    assert.equal(quote.sizeCategory, 'oversize');
    assert.equal(line(quote, 'oversize').amount, 85);
    assert.equal(quote.areaSqm, 2.3);
  });

  test("uses the chosen product's own rate", () => {
    // 0.473 m2 x $260 = $122.98 -> $123
    const quote = calculateQuote(CONFIG, { widthMm: 1000, heightMm: 2300, productId: 'premium' });
    assert.equal(line(quote, 'oversize').amount, 123);
  });

  test('one dimension over but a smaller area than standard: oversize category, no surcharge', () => {
    const quote = calculateQuote(CONFIG, { widthMm: 900, heightMm: 2000, productId: 'classic' });
    assertWellFormed(quote, CONFIG);
    assert.equal(quote.sizeCategory, 'oversize');
    assert.equal(line(quote, 'oversize'), undefined);
    assert.equal(quote.total, 1110);
  });

  test('one millimetre over the standard width', () => {
    // 2100 mm2 = 0.0021 m2; x $180 = $0.378
    const whole = calculateQuote(CONFIG, { widthMm: 871, heightMm: 2100, productId: 'classic' });
    assert.equal(whole.sizeCategory, 'oversize');
    assert.equal(line(whole, 'oversize'), undefined, 'a surcharge that rounds to nothing is not listed');

    const toTheCent = configWith({ roundTo: 0.01 });
    const exact = calculateQuote(toTheCent, { widthMm: 871, heightMm: 2100, productId: 'classic' });
    assertWellFormed(exact, toTheCent);
    assert.equal(line(exact, 'oversize').amount, 0.38);
    assert.equal(line(exact, 'oversize').detail, '0.002 m² larger than the 870 × 2100 mm our base price covers');
  });

  test('a product without an oversize rate is not surcharged', () => {
    const config = baseConfig();
    delete config.pricing.products[0].oversizePerSqm;
    const quote = calculateQuote(config, { widthMm: 1000, heightMm: 2300, productId: 'classic' });
    assert.equal(quote.status, 'ok');
    assert.equal(quote.sizeCategory, 'oversize');
    assert.equal(line(quote, 'oversize'), undefined);
  });

  test('no standardSize configured means everything is standard', () => {
    const config = baseConfig();
    delete config.pricing.standardSize;
    const quote = calculateQuote(config, { widthMm: 1000, heightMm: 2300, productId: 'classic' });
    assert.equal(quote.status, 'ok');
    assert.equal(quote.sizeCategory, 'standard');
    assert.equal(quote.total, 1110);
  });
});

describe('calculateQuote: pricing limits', () => {
  test('exactly at the minimum and maximum limits is in range', () => {
    const smallest = calculateQuote(CONFIG, { widthMm: 600, heightMm: 1900, productId: 'classic' });
    assertWellFormed(smallest, CONFIG);
    assert.equal(smallest.status, 'ok');
    assert.equal(smallest.sizeCategory, 'standard');

    const largest = calculateQuote(CONFIG, { widthMm: 1100, heightMm: 2400, productId: 'classic' });
    assertWellFormed(largest, CONFIG);
    assert.equal(largest.status, 'ok');
    assert.equal(largest.sizeCategory, 'oversize');
    // 2.64 - 1.827 = 0.813 m2; x $180 = $146.34 -> $146
    assert.equal(line(largest, 'oversize').amount, 146);
  });

  const outside = [
    ['too narrow', { widthMm: 599, heightMm: 2040 }, /narrower than the 600 mm/],
    ['too wide', { widthMm: 1101, heightMm: 2040 }, /wider than the 1100 mm/],
    ['too short', { widthMm: 820, heightMm: 1899 }, /shorter than the 1900 mm/],
    ['too tall', { widthMm: 820, heightMm: 2401 }, /taller than the 2400 mm/],
  ];
  for (const [name, size, pattern] of outside) {
    test(`${name} -> out_of_range with a helpful message and no prices`, () => {
      const quote = calculateQuote(CONFIG, { ...size, productId: 'classic' });
      assertWellFormed(quote, CONFIG);
      assert.equal(quote.ok, false);
      assert.equal(quote.status, 'out_of_range');
      assert.deepEqual(quote.lineItems, []);
      assert.equal(quote.total, 0);
      assert.equal(quote.messages.length, 2);
      assert.match(quote.messages[0], pattern);
      assert.match(quote.messages[1], /custom quote/);
      assert.ok(quote.areaSqm > 0, 'the area is still reported');
      assert.equal(quote.currency, 'AUD');
    });
  }

  test('both dimensions out of range are both explained', () => {
    const quote = calculateQuote(CONFIG, { widthMm: 1300, heightMm: 2600, productId: 'classic' });
    assert.equal(quote.status, 'out_of_range');
    assert.equal(quote.messages.length, 3);
    assert.match(quote.messages[0], /At 1300 mm wide/);
    assert.match(quote.messages[1], /At 2600 mm high/);
    assert.equal(quote.sizeCategory, 'oversize');
  });

  test('range is reported even before a product is chosen', () => {
    const quote = calculateQuote(CONFIG, { widthMm: 1300, heightMm: 2040, productId: null });
    assert.equal(quote.status, 'out_of_range');
  });

  test('missing limits are not enforced', () => {
    const config = baseConfig();
    delete config.pricing.limits;
    const quote = calculateQuote(config, { widthMm: 3000, heightMm: 3000, productId: 'classic' });
    assert.equal(quote.status, 'ok');
  });
});

describe('calculateQuote: tax', () => {
  test('inclusive: the total is the sum and the tax is the component inside it', () => {
    const quote = calculateQuote(CONFIG, { ...STANDARD, includeInstallation: false, selections: { petdoor: true, lock: 'triple' } });
    assertWellFormed(quote, CONFIG);
    // 890 + 165 + 95 = 1150; GST inside = 1150 / 11 = 104.55 -> 105
    assert.equal(quote.total, 1150);
    assert.equal(quote.taxAmount, 105);
    assert.equal(quote.subtotal, 1045);
    assert.equal(sumCents(quote), cents(quote.total));
  });

  test('inclusive with a clean multiple of 11 has an exact tax component', () => {
    const config = configWith({
      products: [{ id: 'flat', name: 'Flat', description: '', features: [], basePrice: 1100, oversizePerSqm: 0 }],
      options: [],
      installation: { enabled: false, label: 'Install', price: 0, default: false, optional: true },
    });
    const quote = calculateQuote(config, { ...STANDARD, productId: 'flat' });
    assertWellFormed(quote, config);
    assert.equal(quote.total, 1100);
    assert.equal(quote.taxAmount, 100);
    assert.equal(quote.subtotal, 1000);
  });

  test('exclusive: tax is added on top of the summed line items', () => {
    const config = configWith({ pricesIncludeTax: false });
    const quote = calculateQuote(config, STANDARD);
    assertWellFormed(quote, config);
    assert.equal(quote.pricesIncludeTax, false);
    assert.equal(quote.subtotal, 1110);
    assert.equal(quote.taxAmount, 111);
    assert.equal(quote.total, 1221);
    assert.equal(sumCents(quote), cents(quote.subtotal));
  });

  test('exclusive with a different rate and cent rounding', () => {
    const config = configWith({ pricesIncludeTax: false, taxRate: 0.15, roundTo: 0.01, taxLabel: 'GST', currency: 'NZD', locale: 'en-NZ' });
    const quote = calculateQuote(config, { widthMm: 1000, heightMm: 2100, productId: 'classic' });
    assertWellFormed(quote, config);
    // 890 + 49.14 + 220 = 1159.14; x 0.15 = 173.871 -> 173.87
    assert.equal(quote.subtotal, 1159.14);
    assert.equal(quote.taxAmount, 173.87);
    assert.equal(quote.total, 1333.01);
    assert.equal(quote.currency, 'NZD');
  });

  test('a zero or missing tax rate means no tax either way', () => {
    for (const pricesIncludeTax of [true, false]) {
      for (const taxRate of [0, undefined, NaN, -0.1]) {
        const config = configWith({ pricesIncludeTax, taxRate });
        const quote = calculateQuote(config, STANDARD);
        assertWellFormed(quote, config);
        assert.equal(quote.taxAmount, 0);
        assert.equal(quote.subtotal, 1110);
        assert.equal(quote.total, 1110);
      }
    }
  });

  test('pricesIncludeTax defaults to true when it is not configured', () => {
    const config = baseConfig();
    delete config.pricing.pricesIncludeTax;
    const quote = calculateQuote(config, STANDARD);
    assert.equal(quote.pricesIncludeTax, true);
    assert.equal(quote.total, 1110);
  });
});

describe('calculateQuote: options', () => {
  test('missing selections fall back to each option default', () => {
    for (const selections of [undefined, null, {}]) {
      const quote = calculateQuote(CONFIG, { ...STANDARD, selections });
      assert.equal(quote.status, 'ok');
      assert.deepEqual(quote.selections, { colour: 'black', lock: 'single', petdoor: false });
      assert.equal(line(quote, 'option:petdoor'), undefined);
      assert.equal(quote.total, 1110);
    }
  });

  test('zero-priced select choices are still listed so the summary shows them', () => {
    const quote = calculateQuote(CONFIG, { ...STANDARD, selections: { colour: 'white' } });
    assert.deepEqual(line(quote, 'option:colour'), { id: 'option:colour', label: 'Colour: White', amount: 0 });
    assert.equal(quote.total, 1110);
  });

  test('explicit selections are priced', () => {
    const selections = { colour: 'custom', lock: 'triple', petdoor: true };
    const quote = calculateQuote(CONFIG, { ...STANDARD, selections });
    assertWellFormed(quote, CONFIG);
    assert.deepEqual(quote.lineItems, [
      { id: 'product', label: 'Classic Guard', amount: 890 },
      { id: 'option:colour', label: 'Colour: Custom colour', amount: 120 },
      { id: 'option:lock', label: 'Lock: Triple lock', amount: 165 },
      { id: 'option:petdoor', label: 'Pet door', amount: 95 },
      { id: 'installation', label: 'Professional installation', amount: 220 },
    ]);
    assert.equal(quote.total, 1490);
    assert.deepEqual(quote.selections, selections);
  });

  test('a partial selection keeps the other defaults', () => {
    const quote = calculateQuote(CONFIG, { ...STANDARD, selections: { lock: 'triple' } });
    assert.deepEqual(quote.selections, { colour: 'black', lock: 'triple', petdoor: false });
    assert.equal(quote.total, 1110 + 165);
  });

  test('null or undefined for one option means "use the default"', () => {
    const quote = calculateQuote(CONFIG, { ...STANDARD, selections: { colour: null, petdoor: undefined } });
    assert.equal(quote.status, 'ok');
    assert.deepEqual(quote.selections, { colour: 'black', lock: 'single', petdoor: false });
  });

  test('a checkbox that defaults to on is included until switched off', () => {
    const config = baseConfig();
    config.pricing.options[2].default = true;
    const on = calculateQuote(config, STANDARD);
    assert.equal(line(on, 'option:petdoor').amount, 95);
    assert.equal(on.total, 1110 + 95);
    const off = calculateQuote(config, { ...STANDARD, selections: { petdoor: false } });
    assert.equal(line(off, 'option:petdoor'), undefined);
    assert.equal(off.total, 1110);
  });

  test('a misspelt default falls back to the first choice', () => {
    const config = baseConfig();
    config.pricing.options[0].default = 'blak';
    const quote = calculateQuote(config, STANDARD);
    assert.equal(quote.status, 'ok');
    assert.equal(quote.selections.colour, 'black');
  });

  test('no options configured at all', () => {
    const config = baseConfig();
    delete config.pricing.options;
    const quote = calculateQuote(config, STANDARD);
    assert.equal(quote.status, 'ok');
    assert.deepEqual(ids(quote), ['product', 'installation']);
    assert.deepEqual(quote.selections, {});
  });

  test('a discount (negative price) choice reduces the total', () => {
    const config = baseConfig();
    config.pricing.options[1].choices.push({ id: 'none', label: 'No lock', price: -40 });
    const quote = calculateQuote(config, { ...STANDARD, selections: { lock: 'none' } });
    assertWellFormed(quote, config);
    assert.equal(line(quote, 'option:lock').amount, -40);
    assert.equal(quote.total, 1070);
  });
});

describe('calculateQuote: installation', () => {
  test('optional: undefined and null fall back to the default (on)', () => {
    for (const includeInstallation of [undefined, null]) {
      const quote = calculateQuote(CONFIG, { ...STANDARD, includeInstallation });
      assert.equal(quote.includeInstallation, true);
      assert.equal(line(quote, 'installation').amount, 220);
    }
  });

  test('optional: an explicit choice wins over the default', () => {
    const without = calculateQuote(CONFIG, { ...STANDARD, includeInstallation: false });
    assertWellFormed(without, CONFIG);
    assert.equal(without.includeInstallation, false);
    assert.equal(line(without, 'installation'), undefined);
    assert.equal(without.total, 890);

    const withIt = calculateQuote(CONFIG, { ...STANDARD, includeInstallation: true });
    assert.equal(withIt.total, 1110);
  });

  test('optional with default off', () => {
    const config = configWith({ installation: { enabled: true, label: 'Install', price: 220, default: false, optional: true } });
    assert.equal(calculateQuote(config, STANDARD).total, 890);
    assert.equal(calculateQuote(config, STANDARD).includeInstallation, false);
    assert.equal(calculateQuote(config, { ...STANDARD, includeInstallation: true }).total, 1110);
  });

  test('forced (optional: false) is always included', () => {
    const config = configWith({ installation: { enabled: true, label: 'Install', price: 220, default: false, optional: false } });
    for (const includeInstallation of [undefined, null, false, true]) {
      const quote = calculateQuote(config, { ...STANDARD, includeInstallation });
      assertWellFormed(quote, config);
      assert.equal(quote.includeInstallation, true);
      assert.deepEqual(line(quote, 'installation'), { id: 'installation', label: 'Install', amount: 220 });
      assert.equal(quote.total, 1110);
    }
  });

  test('disabled is never included', () => {
    const config = configWith({ installation: { enabled: false, label: 'Install', price: 220, default: true, optional: false } });
    for (const includeInstallation of [undefined, null, false, true]) {
      const quote = calculateQuote(config, { ...STANDARD, includeInstallation });
      assert.equal(quote.status, 'ok');
      assert.equal(quote.includeInstallation, false);
      assert.equal(line(quote, 'installation'), undefined);
      assert.equal(quote.total, 890);
    }
  });

  test('no installation section behaves as disabled', () => {
    const config = baseConfig();
    delete config.pricing.installation;
    const quote = calculateQuote(config, { ...STANDARD, includeInstallation: true });
    assert.equal(quote.status, 'ok');
    assert.equal(quote.total, 890);
  });
});

describe('calculateQuote: rounding', () => {
  const oversize = { widthMm: 1000, heightMm: 2100, productId: 'classic' }; // raw surcharge $49.14

  test('to the whole dollar', () => {
    const quote = calculateQuote(CONFIG, oversize);
    assertWellFormed(quote, CONFIG);
    assert.equal(line(quote, 'oversize').amount, 49);
    assert.equal(quote.total, 1159);
    assert.equal(quote.taxAmount, 105); // 1159 / 11 = 105.36
    assert.equal(quote.subtotal, 1054);
  });

  test('to the nearest 5', () => {
    const config = configWith({ roundTo: 5 });
    const quote = calculateQuote(config, oversize);
    assertWellFormed(quote, config);
    assert.equal(line(quote, 'oversize').amount, 50);
    assert.equal(quote.total, 1160);
    assert.equal(quote.taxAmount, 105); // 1160 / 11 = 105.45
    assert.equal(quote.subtotal, 1055);
  });

  test('to the nearest 0.05', () => {
    const config = configWith({ roundTo: 0.05 });
    const quote = calculateQuote(config, oversize);
    assertWellFormed(quote, config);
    assert.equal(line(quote, 'oversize').amount, 49.15);
    assert.equal(quote.total, 1159.15);
    assert.equal(quote.taxAmount, 105.4); // 1159.15 / 11 = 105.377
    assert.equal(quote.subtotal, 1053.75);
  });

  test('to the nearest 0.05 with tax on top', () => {
    const config = configWith({ roundTo: 0.05, pricesIncludeTax: false });
    const quote = calculateQuote(config, oversize);
    assertWellFormed(quote, config);
    assert.equal(quote.subtotal, 1159.15);
    assert.equal(quote.taxAmount, 115.9); // 115.915 -> 115.90
    assert.equal(quote.total, 1275.05);
  });

  test('to the cent', () => {
    const config = configWith({ roundTo: 0.01 });
    const quote = calculateQuote(config, oversize);
    assertWellFormed(quote, config);
    assert.equal(line(quote, 'oversize').amount, 49.14);
    assert.equal(quote.total, 1159.14);
  });

  test('to the nearest 10 rounds every line, and the total is the sum of the rounded lines', () => {
    const config = configWith({ roundTo: 10 });
    const quote = calculateQuote(config, { ...oversize, selections: { petdoor: true, lock: 'triple' } });
    assertWellFormed(quote, config);
    assert.equal(line(quote, 'oversize').amount, 50);
    assert.equal(line(quote, 'option:petdoor').amount, 100); // 95: a tie rounds up
    assert.equal(line(quote, 'option:lock').amount, 170); // 165: a tie rounds up
    assert.equal(quote.total, 890 + 50 + 170 + 100 + 220);
  });

  test('a missing, zero or negative roundTo means cents', () => {
    for (const roundTo of [undefined, 0, -5, NaN, null]) {
      const config = configWith({ roundTo });
      const quote = calculateQuote(config, oversize);
      assert.equal(quote.status, 'ok');
      assert.equal(line(quote, 'oversize').amount, 49.14);
      assert.equal(quote.total, 1159.14);
    }
  });

  test('prices with cents never produce float artefacts', () => {
    const config = configWith({
      roundTo: 0.01,
      products: [{ id: 'odd', name: 'Odd', description: '', features: [], basePrice: 0.1, oversizePerSqm: 0 }],
      options: [{ id: 'extra', label: 'Extra', type: 'checkbox', price: 0.2, description: '', default: true }],
      installation: { enabled: true, label: 'Install', price: 19.99, default: true, optional: true },
    });
    const quote = calculateQuote(config, { ...STANDARD, productId: 'odd' });
    assertWellFormed(quote, config);
    assert.equal(quote.total, 20.29); // 0.1 + 0.2 + 19.99 in floating point is 20.290000000000003
  });
});

describe('calculateQuote: invalid input never throws', () => {
  const invalid = (quote, pattern) => {
    assertWellFormed(quote, CONFIG);
    assert.equal(quote.ok, false);
    assert.equal(quote.status, 'invalid');
    if (pattern) assert.match(quote.messages[0], pattern);
  };

  test('unknown productId', () => {
    invalid(calculateQuote(CONFIG, { ...STANDARD, productId: 'nope' }), /"nope"/);
    invalid(calculateQuote(CONFIG, { ...STANDARD, productId: 42 }));
    invalid(calculateQuote(CONFIG, { ...STANDARD, productId: {} }));
  });

  test('missing productId asks the customer to choose', () => {
    for (const productId of [undefined, null, '']) {
      invalid(calculateQuote(CONFIG, { ...STANDARD, productId }), /Choose a door/);
    }
  });

  test('NaN, negative, zero, infinite and non-numeric sizes', () => {
    const bad = [NaN, -820, 0, Infinity, -Infinity, 'abc', '', null, undefined, true, {}, [820]];
    for (const value of bad) {
      invalid(calculateQuote(CONFIG, { ...STANDARD, widthMm: value }), /valid door width and height/);
      invalid(calculateQuote(CONFIG, { ...STANDARD, heightMm: value }), /valid door width and height/);
    }
    assert.equal(calculateQuote(CONFIG, { ...STANDARD, widthMm: NaN }).areaSqm, 0);
  });

  test('unknown option id', () => {
    invalid(calculateQuote(CONFIG, { ...STANDARD, selections: { sparkle: true } }), /"sparkle"/);
  });

  test('unknown choice id', () => {
    invalid(calculateQuote(CONFIG, { ...STANDARD, selections: { colour: 'purple' } }), /"purple" for Colour/);
    invalid(calculateQuote(CONFIG, { ...STANDARD, selections: { colour: true } }));
  });

  test('a non-boolean checkbox value', () => {
    invalid(calculateQuote(CONFIG, { ...STANDARD, selections: { petdoor: 'yes' } }), /Pet door/);
    invalid(calculateQuote(CONFIG, { ...STANDARD, selections: { petdoor: 1 } }));
  });

  test('selections that are not an object', () => {
    invalid(calculateQuote(CONFIG, { ...STANDARD, selections: 'colour=black' }));
    invalid(calculateQuote(CONFIG, { ...STANDARD, selections: ['black'] }));
  });

  test('a __proto__ key in selections is just an unknown option', () => {
    const selections = JSON.parse('{"__proto__": "black"}');
    invalid(calculateQuote(CONFIG, { ...STANDARD, selections }), /__proto__/);
    assert.equal({}.black, undefined);
  });

  test('a non-boolean includeInstallation', () => {
    invalid(calculateQuote(CONFIG, { ...STANDARD, includeInstallation: 'yes' }), /installation/);
  });

  test('missing or malformed arguments', () => {
    invalid(calculateQuote(CONFIG));
    invalid(calculateQuote(CONFIG, null));
    invalid(calculateQuote(CONFIG, 'door'));
    invalid(calculateQuote(CONFIG, {}));
  });

  test('missing or malformed config', () => {
    for (const config of [undefined, null, {}, { pricing: null }, { pricing: 'free' }, 'config', 7]) {
      const quote = calculateQuote(config, STANDARD);
      assert.equal(quote.ok, false);
      assert.equal(quote.status, 'invalid');
      assert.deepEqual(quote.lineItems, []);
      assert.equal(quote.total, 0);
      assert.equal(quote.currency, 'AUD');
      assert.ok(quote.messages.length > 0);
    }
  });

  test('a pricing section with no products', () => {
    invalid(calculateQuote({ pricing: {} }, STANDARD));
    invalid(calculateQuote({ pricing: { products: 'none' } }, STANDARD));
  });

  test('a misconfigured price', () => {
    for (const basePrice of [undefined, null, NaN, 'lots', -1]) {
      const config = baseConfig();
      config.pricing.products[0].basePrice = basePrice;
      invalid(calculateQuote(config, STANDARD), /Classic Guard/);
    }
    const config = baseConfig();
    config.pricing.options[0].choices[0].price = 'free';
    invalid(calculateQuote(config, STANDARD), /Black/);
  });

  test('a config that throws when read', () => {
    const hostile = {
      get pricing() {
        throw new Error('boom');
      },
    };
    let quote;
    assert.doesNotThrow(() => {
      quote = calculateQuote(hostile, STANDARD);
    });
    assert.equal(quote.status, 'invalid');
    assert.equal(quote.ok, false);
  });
});

describe('calculateQuote: invariants', () => {
  test('totals always equal the sum of the line items, in every mode', () => {
    const widths = [600, 733, 820, 870, 871, 905, 1000, 1099, 1100];
    const heights = [1900, 2040, 2100, 2101, 2250, 2400];
    const selectionSets = [
      {},
      { colour: 'custom' },
      { lock: 'triple', petdoor: true },
      { colour: 'white', lock: 'triple', petdoor: true },
    ];
    let checked = 0;
    for (const roundTo of [1, 5, 10, 0.05, 0.01]) {
      for (const pricesIncludeTax of [true, false]) {
        for (const taxRate of [0.1, 0.15, 0.0825, 0]) {
          const config = configWith({ roundTo, pricesIncludeTax, taxRate });
          for (const productId of ['classic', 'premium']) {
            for (const widthMm of widths) {
              for (const heightMm of heights) {
                for (const selections of selectionSets) {
                  for (const includeInstallation of [true, false]) {
                    const quote = calculateQuote(config, { widthMm, heightMm, productId, selections, includeInstallation });
                    assert.equal(quote.status, 'ok');
                    assertWellFormed(quote, config);
                    checked += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    assert.ok(checked > 10000);
  });

  test('is deterministic and does not mutate its inputs', () => {
    const input = deepFreeze({ ...STANDARD, selections: { lock: 'triple' }, includeInstallation: true });
    const first = calculateQuote(CONFIG, input); // CONFIG is deep-frozen: a write would throw and surface as 'invalid'
    const second = calculateQuote(CONFIG, input);
    assert.equal(first.status, 'ok');
    assert.deepEqual(first, second);
    assert.notEqual(first.lineItems, second.lineItems);
  });

  test('a bigger door never costs less', () => {
    let previous = 0;
    for (let widthMm = 600; widthMm <= 1100; widthMm += 10) {
      const quote = calculateQuote(CONFIG, { widthMm, heightMm: 2300, productId: 'premium' });
      assert.ok(quote.total >= previous, `price dropped at ${widthMm} mm`);
      previous = quote.total;
    }
  });
});

describe('calculateQuote: wording overrides', () => {
  test('config.text can reword the generated strings', () => {
    const config = configWith({}, {
      text: {
        'pricing.oversizeLabel': 'Custom size fee',
        'pricing.oversizeDetail': '+{extraSqm} sq m',
        'pricing.optionLabel': '{option} - {choice}',
        'pricing.tooWide': 'Too wide: {size} (max {limit}).',
      },
    });
    const quote = calculateQuote(config, { widthMm: 1000, heightMm: 2100, productId: 'classic' });
    assert.equal(line(quote, 'oversize').label, 'Custom size fee');
    assert.equal(line(quote, 'oversize').detail, '+0.27 sq m');
    assert.equal(line(quote, 'option:colour').label, 'Colour - Black');

    const tooWide = calculateQuote(config, { widthMm: 1200, heightMm: 2100, productId: 'classic' });
    assert.equal(tooWide.messages[0], 'Too wide: 1200 mm (max 1100 mm).');
    assert.equal(tooWide.messages[1], QUOTE_STRINGS['pricing.customQuote']);
  });

  test('non-string overrides are ignored', () => {
    const config = configWith({}, { text: { 'pricing.oversizeLabel': 42 } });
    const quote = calculateQuote(config, { widthMm: 1000, heightMm: 2100, productId: 'classic' });
    assert.equal(line(quote, 'oversize').label, 'Oversize surcharge');
  });

  test('every default string key is namespaced under pricing.', () => {
    for (const [key, value] of Object.entries(QUOTE_STRINGS)) {
      assert.match(key, /^pricing\.[a-zA-Z]+$/);
      assert.equal(typeof value, 'string');
    }
    assert.ok(Object.isFrozen(QUOTE_STRINGS));
  });
});

describe('applyMeasurementRules', () => {
  test('adds nothing and rounds to the millimetre by default', () => {
    const cfg = { adjustments: { widthMm: 0, heightMm: 0 }, roundToMm: 1 };
    assert.deepEqual(applyMeasurementRules(cfg, { widthMm: 819.6, heightMm: 2040.4 }), { widthMm: 820, heightMm: 2040 });
    assert.deepEqual(applyMeasurementRules(cfg, { widthMm: 819.5, heightMm: 2039.49 }), { widthMm: 820, heightMm: 2039 });
  });

  test('adds the adjustments before rounding', () => {
    const cfg = { adjustments: { widthMm: -6, heightMm: 10 }, roundToMm: 1 };
    assert.deepEqual(applyMeasurementRules(cfg, { widthMm: 820.4, heightMm: 2040.2 }), { widthMm: 814, heightMm: 2050 });
  });

  test('rounds to the nearest 5 mm', () => {
    const cfg = { adjustments: { widthMm: 0, heightMm: 0 }, roundToMm: 5 };
    assert.deepEqual(applyMeasurementRules(cfg, { widthMm: 822.4, heightMm: 2037.5 }), { widthMm: 820, heightMm: 2040 });
    assert.deepEqual(applyMeasurementRules(cfg, { widthMm: 822.5, heightMm: 2042.6 }), { widthMm: 825, heightMm: 2045 });
  });

  test('rounds to fractional steps without float noise', () => {
    const half = { adjustments: { widthMm: 0, heightMm: 0 }, roundToMm: 0.5 };
    assert.deepEqual(applyMeasurementRules(half, { widthMm: 820.3, heightMm: 2040.74 }), { widthMm: 820.5, heightMm: 2040.5 });
    const tenth = { adjustments: { widthMm: 0, heightMm: 0 }, roundToMm: 0.1 };
    assert.deepEqual(applyMeasurementRules(tenth, { widthMm: 820.14, heightMm: 2040.27 }), { widthMm: 820.1, heightMm: 2040.3 });
  });

  test('a missing, zero or negative roundToMm means 1 mm', () => {
    for (const roundToMm of [undefined, null, 0, -5, NaN, 'abc']) {
      const cfg = { adjustments: { widthMm: 0, heightMm: 0 }, roundToMm };
      assert.deepEqual(applyMeasurementRules(cfg, { widthMm: 819.6, heightMm: 2040.4 }), { widthMm: 820, heightMm: 2040 });
    }
  });

  test('missing adjustments or config count as zero', () => {
    const size = { widthMm: 819.6, heightMm: 2040.4 };
    const expected = { widthMm: 820, heightMm: 2040 };
    assert.deepEqual(applyMeasurementRules({ roundToMm: 1 }, size), expected);
    assert.deepEqual(applyMeasurementRules({ adjustments: { widthMm: NaN }, roundToMm: 1 }, size), expected);
    assert.deepEqual(applyMeasurementRules({}, size), expected);
    assert.deepEqual(applyMeasurementRules(undefined, size), expected);
    assert.deepEqual(applyMeasurementRules(null, size), expected);
  });

  test('does not mutate its inputs and returns a fresh object', () => {
    const cfg = deepFreeze({ adjustments: { widthMm: 2, heightMm: 3 }, roundToMm: 1 });
    const size = deepFreeze({ widthMm: 820, heightMm: 2040 });
    const result = applyMeasurementRules(cfg, size);
    assert.deepEqual(result, { widthMm: 822, heightMm: 2043 });
    assert.notEqual(result, size);
    assert.deepEqual(Object.keys(result), ['widthMm', 'heightMm']);
  });

  test('accepts numeric strings (e.g. straight from a manual-entry field)', () => {
    const cfg = { adjustments: { widthMm: 0, heightMm: 0 }, roundToMm: 1 };
    assert.deepEqual(applyMeasurementRules(cfg, { widthMm: '820', heightMm: '2040.4' }), { widthMm: 820, heightMm: 2040 });
  });

  test('never throws: unusable sizes come back as NaN and then fail the quote cleanly', () => {
    const cfg = { adjustments: { widthMm: 0, heightMm: 0 }, roundToMm: 1 };
    for (const size of [undefined, null, {}, { widthMm: 'abc', heightMm: null }, 'big']) {
      const result = applyMeasurementRules(cfg, size);
      assert.ok(Number.isNaN(result.widthMm));
      assert.ok(Number.isNaN(result.heightMm));
      assert.equal(calculateQuote(CONFIG, { ...result, productId: 'classic' }).status, 'invalid');
    }
  });

  test('feeds straight into calculateQuote', () => {
    const cfg = { adjustments: { widthMm: -4, heightMm: -4 }, roundToMm: 1 };
    const size = applyMeasurementRules(cfg, { widthMm: 823.7, heightMm: 2044.2 });
    assert.deepEqual(size, { widthMm: 820, heightMm: 2040 });
    assert.equal(calculateQuote(CONFIG, { ...size, productId: 'classic' }).total, 1110);
  });
});

describe('formatMoney', () => {
  test('whole amounts show no decimals', () => {
    assert.equal(formatMoney(1650, CONFIG), '$1,650');
    assert.equal(formatMoney(0, CONFIG), '$0');
    assert.equal(formatMoney(95, CONFIG), '$95');
    assert.equal(formatMoney(1234567, CONFIG), '$1,234,567');
  });

  test('other amounts show two decimals', () => {
    assert.equal(formatMoney(1650.5, CONFIG), '$1,650.50');
    assert.equal(formatMoney(49.15, CONFIG), '$49.15');
    assert.equal(formatMoney(0.05, CONFIG), '$0.05');
  });

  test('sub-cent noise does not force decimals', () => {
    assert.equal(formatMoney(1109.9999999999998, CONFIG), '$1,110');
    assert.equal(formatMoney(20.290000000000003, CONFIG), '$20.29');
    assert.equal(formatMoney(12.004, CONFIG), '$12');
  });

  test('negative amounts and negative zero', () => {
    assert.equal(formatMoney(-40, CONFIG), '-$40');
    assert.equal(formatMoney(-0, CONFIG), '$0');
    assert.equal(formatMoney(-0.001, CONFIG), '$0');
  });

  test('uses the configured locale and currency', () => {
    const us = configWith({ currency: 'USD', locale: 'en-US' });
    assert.equal(formatMoney(1650, us), '$1,650');
    assert.equal(formatMoney(1650.5, us), '$1,650.50');

    const uk = configWith({ currency: 'GBP', locale: 'en-GB' });
    assert.equal(formatMoney(1650, uk), '£1,650');

    const de = configWith({ currency: 'EUR', locale: 'de-DE' });
    assert.match(formatMoney(1650.5, de), /^1\.650,50\s€$/);
    assert.match(formatMoney(1650, de), /^1\.650\s€$/);
  });

  test('formats quote results', () => {
    const quote = calculateQuote(CONFIG, STANDARD);
    assert.equal(formatMoney(quote.total, CONFIG), '$1,110');
    assert.equal(formatMoney(quote.taxAmount, CONFIG), '$101');
  });

  test('accepts numeric strings', () => {
    assert.equal(formatMoney('1650', CONFIG), '$1,650');
  });

  test('unusable amounts give a dash instead of "$NaN"', () => {
    for (const amount of [NaN, Infinity, -Infinity, undefined, null, '', 'abc', {}, true]) {
      assert.equal(formatMoney(amount, CONFIG), '—');
    }
  });

  test('never throws on a bad or missing config', () => {
    const badLocale = configWith({ locale: 'not a locale' });
    assert.match(formatMoney(1650, badLocale), /1,?650/);

    const badCurrency = configWith({ currency: 'dollars' });
    assert.equal(formatMoney(1650, badCurrency), 'dollars 1650');
    assert.equal(formatMoney(1650.5, badCurrency), 'dollars 1650.50');

    for (const config of [undefined, null, {}, { pricing: null }, 'config']) {
      assert.match(formatMoney(1650, config), /1,?650/);
    }
  });

  test('also accepts a bare pricing section', () => {
    assert.equal(formatMoney(1650.5, CONFIG.pricing), '$1,650.50');
  });
});

describe('formatLength', () => {
  test('formats millimetres', () => {
    assert.equal(formatLength(2040), '2040 mm');
    assert.equal(formatLength(820), '820 mm');
    assert.equal(formatLength(0), '0 mm');
  });

  test('rounds to the whole millimetre', () => {
    assert.equal(formatLength(819.6), '820 mm');
    assert.equal(formatLength(2040.4), '2040 mm');
    assert.equal(formatLength(-0.2), '0 mm');
  });

  test('accepts numeric strings', () => {
    assert.equal(formatLength('2040'), '2040 mm');
  });

  test('unusable values give a dash', () => {
    for (const value of [NaN, Infinity, undefined, null, '', 'tall', {}]) {
      assert.equal(formatLength(value), '—');
    }
  });
});

describe('roundPrice', () => {
  test('rounds a configured price to pricing.roundTo, halves away from zero', () => {
    assert.equal(roundPrice(89.5, { pricing: { roundTo: 1 } }), 90);
    assert.equal(roundPrice(1299, { pricing: { roundTo: 10 } }), 1300);
    assert.equal(roundPrice(1294.99, { pricing: { roundTo: 10 } }), 1290);
    assert.equal(roundPrice(-20.5, { pricing: { roundTo: 1 } }), -21);
    assert.equal(roundPrice('89.5', { pricing: { roundTo: 1 } }), 90, 'a numeric string, as the engine reads the config');
    assert.ok(Object.is(roundPrice(0.4, { pricing: { roundTo: 1 } }), 0), 'never -0');
  });

  test('a missing, zero or negative roundTo means cents', () => {
    for (const config of [{}, { pricing: {} }, { pricing: { roundTo: 0 } }, { pricing: { roundTo: -5 } }, null]) {
      assert.equal(roundPrice(89.506, config), 89.51);
      assert.equal(roundPrice(19.99, config), 19.99);
      assert.equal(roundPrice(0.1 + 0.2, config), 0.3);
    }
  });

  test('gives the same figure as the line calculateQuote charges for it', () => {
    for (const roundTo of [1, 5, 10, 0.05, 0.01]) {
      const config = configWith({
        roundTo,
        options: [{ id: 'extra', label: 'Extra', type: 'checkbox', price: 87.55, description: '', default: true }],
      });
      const quote = calculateQuote(config, { ...STANDARD, productId: 'classic' });
      assert.equal(quote.status, 'ok', `roundTo ${roundTo}`);
      assert.equal(line(quote, 'option:extra').amount, roundPrice(87.55, config), `roundTo ${roundTo}`);
      assert.equal(line(quote, 'product').amount, roundPrice(config.pricing.products[0].basePrice, config), `roundTo ${roundTo}`);
    }
  });

  test('is NaN when the price is not a usable number', () => {
    for (const amount of ['abc', '', null, undefined, NaN, Infinity, {}]) {
      assert.ok(Number.isNaN(roundPrice(amount, {})), `roundPrice(${String(amount)})`);
    }
  });
});

describe('module purity', () => {
  test('exports exactly the contract functions plus the default strings', async () => {
    const module = await import('../js/quote.js');
    assert.deepEqual(Object.keys(module).sort(), [
      'QUOTE_STRINGS',
      'applyMeasurementRules',
      'calculateQuote',
      'formatLength',
      'formatMoney',
      'roundPrice',
    ]);
  });
});
