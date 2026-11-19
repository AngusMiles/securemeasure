import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCustomer,
  buildLeadPayload,
  buildMailtoUrl,
  submitLead,
  leadMode,
  MAILTO_MAX_BODY_CHARS,
  WEBHOOK_CONTENT_TYPE,
  LEAD_ERROR_STRINGS,
  LEAD_MAIL_STRINGS,
  DEMO_DELAY_MS,
} from '../js/lead.js';
import { leadMeasurement, isDemoDoor, photoBacksSize, strings as detailsStrings } from '../js/screens/details.js';
import * as detailsScreen from '../js/screens/details.js';
import { installFakeDom } from './helpers/screen-dom.mjs';
import { strings as quoteStrings } from '../js/screens/quote.js';
import { strings as doneStrings } from '../js/screens/done.js';
import { estimateBannerKey, estimateChoices } from '../js/screens/result-standard.js';

/* ----------------------------------------------------------------- fixtures */

/** A config following the contract's shape (js/config.js is written by another builder). */
function makeConfig(overrides = {}) {
  const config = {
    brand: { name: 'Test Doors' },
    pricing: {
      currency: 'AUD',
      locale: 'en-AU',
      taxLabel: 'GST',
      taxRate: 0.1,
      pricesIncludeTax: true,
      roundTo: 1,
      products: [
        { id: 'classic', name: 'Classic Security Door', description: 'Steel mesh', features: [], basePrice: 990, oversizePerSqm: 250 },
      ],
      options: [
        {
          id: 'colour',
          label: 'Frame colour',
          type: 'select',
          default: 'black',
          choices: [
            { id: 'black', label: 'Black', price: 0 },
            { id: 'white', label: 'Pearl white', price: 40 },
          ],
        },
        { id: 'petMesh', label: 'Pet mesh', type: 'checkbox', price: 120, description: 'Tougher mesh', default: false },
      ],
      installation: { enabled: true, label: 'Professional installation', price: 180, default: true, optional: true },
    },
    lead: {
      endpoint: '',
      mailto: '',
      includePhoto: false,
      fields: [
        { id: 'name', label: 'Your name', type: 'text', required: true, autocomplete: 'name' },
        { id: 'phone', label: 'Mobile', type: 'tel', required: true, autocomplete: 'tel' },
        { id: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' },
        { id: 'postcode', label: 'Postcode', type: 'text', required: true, autocomplete: 'postal-code', inputmode: 'numeric' },
        { id: 'notes', label: 'Anything else we should know?', type: 'textarea', required: false },
      ],
      consentText: 'I agree to be contacted about my quote.',
      successTitle: 'Thanks',
      successMessage: 'We will be in touch.',
    },
    embed: { parentOrigin: '' },
    text: {},
  };
  config.lead = { ...config.lead, ...(overrides.lead ?? {}) };
  config.pricing = { ...config.pricing, ...(overrides.pricing ?? {}) };
  if (overrides.text) config.text = overrides.text;
  return config;
}

function makeCustomer(overrides = {}) {
  return {
    name: 'Jane Citizen',
    phone: '0412 345 678',
    email: 'jane@example.com',
    postcode: '4000',
    notes: '',
    consent: true,
    ...overrides,
  };
}

const MEASUREMENT = { widthMm: 820, heightMm: 2040, source: 'photo', quality: 'good', sigmaWidthMm: 1.84, sigmaHeightMm: 2.96 };

/** Shaped like a calculateQuote result. */
const QUOTE = {
  ok: true,
  status: 'ok',
  sizeCategory: 'standard',
  areaSqm: 1.6728,
  lineItems: [
    { id: 'product', label: 'Classic Security Door', amount: 990 },
    { id: 'petMesh', label: 'Pet mesh', amount: 120 },
    { id: 'installation', label: 'Professional installation', amount: 180, detail: 'Fitted by our team' },
  ],
  subtotal: 1172.73,
  taxAmount: 117.27,
  total: 1290,
  currency: 'AUD',
  taxLabel: 'GST',
  pricesIncludeTax: true,
  messages: [],
};

const NOW = new Date('2026-11-19T02:30:00.000Z');

function makePayload(overrides = {}) {
  const config = overrides.config ?? makeConfig();
  return buildLeadPayload({
    config,
    customer: makeCustomer(),
    measurement: MEASUREMENT,
    quote: QUOTE,
    selections: { petMesh: true },
    product: config.pricing.products[0],
    now: NOW,
    ...overrides,
  });
}

/** Split a mailto: URL back into its address and decoded header fields. */
function parseMailto(url) {
  assert.ok(url.startsWith('mailto:'), 'is a mailto: URL');
  const queryAt = url.indexOf('?');
  const to = url.slice('mailto:'.length, queryAt);
  const rawParams = url.slice(queryAt + 1).split('&');
  const params = {};
  for (const pair of rawParams) {
    const [key, value] = pair.split('=');
    params[key] = decodeURIComponent(value);
  }
  return { to, params, rawParams };
}

/* ----------------------------------------------------------------- validate */

describe('validateCustomer', () => {
  test('accepts a fully valid customer', () => {
    assert.deepEqual(validateCustomer(makeConfig(), makeCustomer()), { ok: true, errors: {} });
  });

  test('reports every missing required field, but not optional ones', () => {
    const result = validateCustomer(makeConfig(), { consent: true });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.errors).sort(), ['email', 'name', 'phone', 'postcode']);
    for (const message of Object.values(result.errors)) {
      assert.equal(typeof message, 'string');
      assert.ok(message.length > 0 && message.length < 80, 'short plain message');
    }
    assert.equal(result.errors.name, LEAD_ERROR_STRINGS['lead.error.required.name']);
  });

  test('treats whitespace-only values as missing', () => {
    const result = validateCustomer(makeConfig(), makeCustomer({ name: '   ', postcode: '\t' }));
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.errors).sort(), ['name', 'postcode']);
  });

  test('an empty optional notes field is fine, and so is a missing one', () => {
    assert.equal(validateCustomer(makeConfig(), makeCustomer({ notes: '' })).ok, true);
    const { notes, ...withoutNotes } = makeCustomer();
    assert.equal(validateCustomer(makeConfig(), withoutNotes).ok, true);
  });

  test('rejects implausible email addresses', () => {
    for (const email of ['jane', 'jane@', 'jane@example', '@example.com', 'jane doe@example.com', 'jane@@example.com', 'jane@example.c']) {
      const result = validateCustomer(makeConfig(), makeCustomer({ email }));
      assert.equal(result.ok, false, `${email} should be rejected`);
      assert.deepEqual(Object.keys(result.errors), ['email']);
      assert.equal(result.errors.email, LEAD_ERROR_STRINGS['lead.error.email']);
    }
  });

  test('accepts ordinary email addresses, trimming first', () => {
    for (const email of ['jane@example.com', '  jane@example.com  ', 'j.d+doors@mail.example.com.au', "o'brien@example.io"]) {
      assert.equal(validateCustomer(makeConfig(), makeCustomer({ email })).ok, true, `${email} should be accepted`);
    }
  });

  test('rejects phone numbers with fewer than 8 digits or with letters', () => {
    for (const phone of ['1234567', '0412 345', '+61 4', 'call me maybe', '0412 345 67x']) {
      const result = validateCustomer(makeConfig(), makeCustomer({ phone }));
      assert.equal(result.ok, false, `${phone} should be rejected`);
      assert.deepEqual(Object.keys(result.errors), ['phone']);
      assert.equal(result.errors.phone, LEAD_ERROR_STRINGS['lead.error.phone']);
    }
  });

  test('accepts phone numbers written with spaces, brackets, dashes and a leading +', () => {
    for (const phone of ['12345678', '0412 345 678', '(07) 3123 4567', '+61 412 345 678', '07-3123-4567', '+61 (0)412 345 678']) {
      assert.equal(validateCustomer(makeConfig(), makeCustomer({ phone })).ok, true, `${phone} should be accepted`);
    }
  });

  test('requires consent to be exactly true', () => {
    for (const consent of [false, undefined, 'true', 1]) {
      const result = validateCustomer(makeConfig(), makeCustomer({ consent }));
      assert.equal(result.ok, false);
      assert.deepEqual(Object.keys(result.errors), ['consent']);
      assert.equal(result.errors.consent, LEAD_ERROR_STRINGS['lead.error.consent']);
    }
  });

  test('only validates fields listed in config.lead.fields', () => {
    const config = makeConfig({
      lead: { fields: [{ id: 'name', label: 'Name', type: 'text', required: true }] },
    });
    const result = validateCustomer(config, { name: 'Jane', email: 'not-an-email', phone: '1', consent: true });
    assert.deepEqual(result, { ok: true, errors: {} });
  });

  test('an optional email or phone is only checked when filled in', () => {
    const config = makeConfig({
      lead: {
        fields: [
          { id: 'name', label: 'Name', type: 'text', required: true },
          { id: 'email', label: 'Email', type: 'email', required: false },
          { id: 'phone', label: 'Phone', type: 'tel', required: false },
        ],
      },
    });
    assert.equal(validateCustomer(config, { name: 'Jane', consent: true }).ok, true);
    const result = validateCustomer(config, { name: 'Jane', email: 'nope', phone: '123', consent: true });
    assert.deepEqual(Object.keys(result.errors).sort(), ['email', 'phone']);
  });

  test('a required custom field gets the generic message', () => {
    const config = makeConfig({
      lead: { fields: [{ id: 'suburb', label: 'Suburb', type: 'text', required: true }] },
    });
    const result = validateCustomer(config, { consent: true });
    assert.equal(result.errors.suburb, LEAD_ERROR_STRINGS['lead.error.required']);
  });

  test('never throws on a missing customer or an empty config', () => {
    const result = validateCustomer(makeConfig(), null);
    assert.equal(result.ok, false);
    assert.ok(result.errors.consent);
    assert.ok(result.errors.name);
    assert.deepEqual(validateCustomer({}, undefined), { ok: false, errors: { consent: LEAD_ERROR_STRINGS['lead.error.consent'] } });
  });

  test('messages can be overridden through config.text', () => {
    const config = makeConfig({
      text: { 'lead.error.required': 'Required', 'lead.error.email': 'Bad email', 'lead.error.consent': 'Tick me' },
    });
    const result = validateCustomer(config, { name: '', phone: '0412 345 678', email: 'x', postcode: '4000', consent: false });
    assert.deepEqual(result.errors, { name: 'Required', email: 'Bad email', consent: 'Tick me' });
  });
});

/* ------------------------------------------------------------------ payload */

describe('buildLeadPayload', () => {
  test('has the contract shape', () => {
    const config = makeConfig();
    const payload = buildLeadPayload({
      config,
      customer: makeCustomer({ name: '  Jane Citizen ', notes: ' Side gate too. ' }),
      measurement: MEASUREMENT,
      quote: QUOTE,
      selections: { petMesh: true },
      product: config.pricing.products[0],
      now: NOW,
    });

    assert.deepEqual(Object.keys(payload), [
      'reference',
      'createdAt',
      'brand',
      'demo',
      'customer',
      'measurement',
      'product',
      'selections',
      'includeInstallation',
      'quote',
    ]);
    assert.match(payload.reference, /^SM-[2-9A-HJ-NP-Z]{6}$/);
    assert.equal(payload.createdAt, '2026-11-19T02:30:00.000Z');
    assert.equal(payload.brand, 'Test Doors');
    assert.equal(payload.demo, false);
    assert.deepEqual(payload.customer, {
      name: 'Jane Citizen',
      phone: '0412 345 678',
      email: 'jane@example.com',
      postcode: '4000',
      notes: 'Side gate too.',
      consent: true,
    });
    assert.deepEqual(payload.measurement, {
      widthMm: 820,
      heightMm: 2040,
      source: 'photo',
      quality: 'good',
      sigmaWidthMm: 1.8,
      sigmaHeightMm: 3,
    });
    assert.deepEqual(payload.product, { id: 'classic', name: 'Classic Security Door' });
    assert.deepEqual(payload.selections, { colour: 'black', petMesh: true });
    assert.equal(payload.includeInstallation, true);
    assert.deepEqual(payload.quote, {
      status: 'ok',
      total: 1290,
      subtotal: 1172.73,
      taxAmount: 117.27,
      currency: 'AUD',
      lineItems: [
        { id: 'product', label: 'Classic Security Door', amount: 990 },
        { id: 'petMesh', label: 'Pet mesh', amount: 120 },
        { id: 'installation', label: 'Professional installation', amount: 180, detail: 'Fitted by our team' },
      ],
    });
  });

  test('is JSON-serialisable without loss', () => {
    const payload = makePayload();
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  });

  test('the reference is deterministic', () => {
    assert.equal(makePayload().reference, makePayload().reference);
    assert.equal(makePayload().reference, makePayload({ now: new Date(NOW.getTime()) }).reference);
  });

  test('a different time or a different customer gives a different reference', () => {
    const base = makePayload().reference;
    assert.notEqual(makePayload({ now: new Date(NOW.getTime() + 1) }).reference, base);
    assert.notEqual(makePayload({ now: new Date(NOW.getTime() + 60000) }).reference, base);
    assert.notEqual(makePayload({ customer: makeCustomer({ name: 'John Citizen' }) }).reference, base);
  });

  test('references stay well-formed and rarely collide', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) {
      const { reference } = makePayload({ now: new Date(NOW.getTime() + i * 1000) });
      assert.match(reference, /^SM-[2-9A-HJ-NP-Z]{6}$/);
      seen.add(reference);
    }
    assert.ok(seen.size >= 499, `expected almost no collisions, got ${seen.size} unique of 500`);
  });

  test('never includes customer fields that are not configured', () => {
    const payload = makePayload({
      customer: makeCustomer({ creditCard: '4111 1111 1111 1111', __proto__: { sneaky: 'x' }, isAdmin: true }),
    });
    assert.deepEqual(Object.keys(payload.customer), ['name', 'phone', 'email', 'postcode', 'notes', 'consent']);
    assert.ok(!JSON.stringify(payload).includes('4111'));
  });

  test('unknown fields do not affect the reference', () => {
    assert.equal(makePayload({ customer: makeCustomer({ extra: 'ignored' }) }).reference, makePayload().reference);
  });

  test('a retry keeps the reference and time of the first attempt at the same enquiry', () => {
    const first = makePayload();
    // What the details screen does when the customer taps send again after a failed send.
    const retry = makePayload({ reference: first.reference, now: new Date(first.createdAt) });
    assert.deepEqual(retry, first, 'an unchanged retry is the same lead, not a second one');

    // Still the same enquiry when it is sent later, or after the customer corrected a detail.
    const later = new Date(NOW.getTime() + 20000);
    assert.notEqual(makePayload({ now: later }).reference, first.reference, 'without the kept reference it would differ');
    assert.equal(makePayload({ reference: first.reference, now: later }).reference, first.reference);
    const corrected = makePayload({
      reference: first.reference,
      now: new Date(first.createdAt),
      customer: makeCustomer({ phone: '0499 999 999' }),
    });
    assert.equal(corrected.reference, first.reference);
    assert.equal(corrected.createdAt, first.createdAt);
    assert.equal(corrected.customer.phone, '0499 999 999');
  });

  test('only a well-formed reference is kept; anything else gets a fresh one', () => {
    const fresh = makePayload().reference;
    for (const reference of [undefined, null, '', 'SM-', 'SM-ABC10O', 'sm-abcdef', ' SM-ABCDEF', 'SM-ABCDEFG', 42, {}]) {
      assert.equal(makePayload({ reference }).reference, fresh, `${String(reference)} is not kept`);
    }
    assert.equal(makePayload({ reference: 'SM-ABCDEF' }).reference, 'SM-ABCDEF');
  });

  test('marks a lead measured from the demo photo, and only that', () => {
    assert.equal(makePayload().demo, false);
    assert.equal(makePayload({ demo: false }).demo, false);
    assert.equal(makePayload({ demo: true }).demo, true);
    for (const demo of ['true', 1, {}, null, undefined]) {
      assert.equal(makePayload({ demo }).demo, false, 'only exactly true counts');
    }
    // A size the customer typed in is their own door, whatever photo they tried first.
    const manual = makePayload({ demo: true, measurement: { widthMm: 900, heightMm: 2100, source: 'manual' } });
    assert.equal(manual.demo, false);
    // The flag is the only difference: the measurement block keeps its documented shape.
    assert.deepEqual(makePayload({ demo: true }).measurement, makePayload().measurement);
    assert.equal(JSON.parse(JSON.stringify(makePayload({ demo: true }))).demo, true);
  });

  test('records consent as given rather than assuming it', () => {
    assert.equal(makePayload().customer.consent, true);
    assert.equal(makePayload({ customer: makeCustomer({ consent: false }) }).customer.consent, false);
  });

  test('includes the photo only when one is provided and the company asked for photos', () => {
    const dataUrl = 'data:image/jpeg;base64,AAAA';
    const withPhotos = makeConfig({ lead: { includePhoto: true } });
    assert.equal(makePayload({ config: withPhotos, photoDataUrl: dataUrl }).photo, dataUrl);
    assert.ok(!('photo' in makePayload({ config: withPhotos })));
    assert.ok(!('photo' in makePayload({ config: withPhotos, photoDataUrl: null })));
    assert.ok(!('photo' in makePayload({ photoDataUrl: dataUrl })), 'includePhoto: false keeps the photo out');
  });

  test('handles a manual size with no quote or product', () => {
    const payload = makePayload({
      measurement: { widthMm: 900, heightMm: 2100, source: 'manual' },
      quote: null,
      product: null,
      selections: undefined,
    });
    assert.deepEqual(payload.measurement, { widthMm: 900, heightMm: 2100, source: 'manual' });
    assert.equal(payload.quote, null);
    assert.equal(payload.product, null);
    assert.deepEqual(payload.selections, { colour: 'black', petMesh: false });
    assert.equal(payload.includeInstallation, true, 'falls back to installation.default');
  });

  test('keeps an out-of-range quote as a status with no prices', () => {
    const quote = { ok: false, status: 'out_of_range', lineItems: [], currency: 'AUD', messages: ['Too wide'] };
    const payload = makePayload({ quote });
    assert.deepEqual(payload.quote, {
      status: 'out_of_range',
      total: null,
      subtotal: null,
      taxAmount: null,
      currency: 'AUD',
      lineItems: [],
    });
  });

  test('never passes on the zero amounts calculateQuote reports for an unpriced door', () => {
    // What js/quote.js really returns outside pricing.limits: amounts of 0, not missing ones.
    const unpriced = {
      ok: false,
      sizeCategory: 'oversize',
      areaSqm: 3,
      lineItems: [],
      subtotal: 0,
      taxAmount: 0,
      total: 0,
      currency: 'AUD',
      taxLabel: 'GST',
      pricesIncludeTax: true,
    };
    for (const status of ['out_of_range', 'invalid']) {
      const payload = makePayload({ quote: { ...unpriced, status, messages: ['No instant price'] } });
      assert.deepEqual(payload.quote, { status, total: null, subtotal: null, taxAmount: null, currency: 'AUD', lineItems: [] });
    }
    assert.equal(makePayload().quote.total, 1290, 'a priced quote keeps its amounts');
  });

  test('accepts the whole quality object and flattens it', () => {
    const payload = makePayload({
      measurement: { ...MEASUREMENT, quality: { level: 'fair', score: 0.6, issues: ['door_near_edge'] } },
    });
    assert.equal(payload.measurement.quality, 'fair');
    assert.deepEqual(payload.measurement.qualityIssues, ['door_near_edge']);
  });

  test('works out includeInstallation from the explicit choice, then the quote, then the config', () => {
    assert.equal(makePayload({ includeInstallation: false }).includeInstallation, false);
    assert.equal(makePayload({ includeInstallation: true }).includeInstallation, true);

    const withoutInstall = { ...QUOTE, lineItems: QUOTE.lineItems.filter((item) => item.id !== 'installation') };
    assert.equal(makePayload({ quote: withoutInstall }).includeInstallation, false);
    assert.equal(makePayload({ quote: withoutInstall, includeInstallation: null }).includeInstallation, false);

    const compulsory = makeConfig({ pricing: { installation: { enabled: true, label: 'Install', price: 180, default: false, optional: false } } });
    assert.equal(makePayload({ config: compulsory, includeInstallation: false }).includeInstallation, true);

    const disabled = makeConfig({ pricing: { installation: { enabled: false, label: 'Install', price: 180, default: true, optional: true } } });
    assert.equal(makePayload({ config: disabled, includeInstallation: true }).includeInstallation, false);

    // `enabled` left out counts as off, as it does in js/quote.js, whatever the other settings say.
    const unset = makeConfig({ pricing: { installation: { label: 'Install', price: 180, default: true, optional: false } } });
    const unsetPayload = makePayload({ config: unset, quote: null, includeInstallation: true });
    assert.equal(unsetPayload.includeInstallation, false);
    const { params } = parseMailto(buildMailtoUrl(unset, unsetPayload));
    assert.ok(!params.body.includes('Installation:'), 'no installation line in the email when it is not offered');
  });

  test('falls back to option defaults for missing or invalid selections', () => {
    assert.deepEqual(makePayload({ selections: {} }).selections, { colour: 'black', petMesh: false });
    assert.deepEqual(makePayload({ selections: { colour: 'white', petMesh: true } }).selections, { colour: 'white', petMesh: true });
    assert.deepEqual(makePayload({ selections: { colour: 'chartreuse', bogus: 'x' } }).selections, { colour: 'black', petMesh: false });
  });

  test('does not mutate its inputs', () => {
    const config = makeConfig();
    const customer = makeCustomer({ name: '  Jane  ' });
    const selections = { petMesh: true };
    const quote = structuredClone(QUOTE);
    const before = JSON.stringify({ config, customer, selections, quote });
    buildLeadPayload({ config, customer, measurement: MEASUREMENT, quote, selections, product: config.pricing.products[0], now: NOW });
    assert.equal(JSON.stringify({ config, customer, selections, quote }), before);
  });
});

/* --------------------------------------------------------------------- mode */

describe('leadMode', () => {
  test('is demo when neither endpoint nor mailto is set', () => {
    assert.equal(leadMode(makeConfig()), 'demo');
    assert.equal(leadMode(makeConfig({ lead: { endpoint: '   ', mailto: ' ' } })), 'demo');
    assert.equal(leadMode({}), 'demo');
    assert.equal(leadMode(undefined), 'demo');
  });

  test('is mailto when only mailto is set', () => {
    assert.equal(leadMode(makeConfig({ lead: { mailto: 'sales@testdoors.example' } })), 'mailto');
  });

  test('is webhook when an endpoint is set, even alongside mailto', () => {
    assert.equal(leadMode(makeConfig({ lead: { endpoint: 'https://hooks.example/lead' } })), 'webhook');
    assert.equal(leadMode(makeConfig({ lead: { endpoint: 'https://hooks.example/lead', mailto: 'sales@testdoors.example' } })), 'webhook');
  });
});

/* ------------------------------------------------------------------- mailto */

describe('buildMailtoUrl', () => {
  const config = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });

  test('decodes back to the expected subject and body', () => {
    const payload = makePayload({
      config,
      customer: makeCustomer({ notes: 'Side gate too please.\nDog on site & gate code is #1234?' }),
      selections: { colour: 'white', petMesh: true },
    });
    const { to, params, rawParams } = parseMailto(buildMailtoUrl(config, payload));

    assert.equal(to, 'sales@testdoors.example');
    assert.deepEqual(rawParams.map((pair) => pair.split('=')[0]), ['subject', 'body']);
    assert.equal(params.subject, `Door quote request ${payload.reference} - Jane Citizen (820 x 2040 mm)`);
    assert.equal(
      params.body,
      [
        'New quote request via Test Doors',
        '',
        `Reference: ${payload.reference}`,
        '',
        'Your name: Jane Citizen',
        'Mobile: 0412 345 678',
        'Email: jane@example.com',
        'Postcode: 4000',
        '',
        'Door size: 820 mm wide x 2040 mm high',
        'Measured: from a photo, confidence good (about +/- 4 mm wide, +/- 6 mm high)',
        'Product: Classic Security Door',
        'Options:',
        '- Frame colour: Pearl white',
        '- Pet mesh: Yes',
        'Installation: Yes',
        'Total: $1,290 (includes $117.27 GST)',
        '',
        'Anything else we should know?',
        'Side gate too please.',
        'Dog on site & gate code is #1234?',
      ].join('\r\n'),
    );
  });

  test('is fully percent-encoded so customer text cannot add headers', () => {
    const payload = makePayload({
      config,
      customer: makeCustomer({ name: 'Eve&bcc=evil@example.com', notes: 'hi?cc=other@example.com&body=replaced #frag' }),
    });
    const url = buildMailtoUrl(config, payload);
    const query = url.slice(url.indexOf('?') + 1);

    assert.equal(url.split('?').length, 2, 'exactly one query separator');
    assert.equal(query.split('&').length, 2, 'only subject and body');
    assert.ok(!/[\s#]/.test(url), 'no raw whitespace or fragment');
    const parsed = new URL(url);
    assert.deepEqual([...parsed.searchParams.keys()], ['subject', 'body']);
    assert.equal(parsed.hash, '');
    assert.ok(parsed.searchParams.get('body').includes('hi?cc=other@example.com&body=replaced #frag'));
  });

  test('uses CRLF line breaks', () => {
    const url = buildMailtoUrl(config, makePayload({ config }));
    assert.ok(url.includes('%0D%0A'));
    assert.ok(!/%0A/.test(url.replace(/%0D%0A/g, '')), 'no bare line feeds');
  });

  test('never includes the photo', () => {
    const withPhotos = makeConfig({ lead: { mailto: 'sales@testdoors.example', includePhoto: true } });
    const payload = makePayload({ config: withPhotos, photoDataUrl: 'data:image/jpeg;base64,QUJDREVGRw==' });
    assert.ok(payload.photo, 'the payload itself carries the photo');
    const url = buildMailtoUrl(withPhotos, payload);
    assert.ok(!decodeURIComponent(url).includes('base64'));
    assert.ok(!url.includes('QUJDREVGRw'));
  });

  test('shortens long notes to keep the body under the cap', () => {
    const notes = 'Please ring before you come, the dog barks. '.repeat(200);
    const payload = makePayload({ config, customer: makeCustomer({ notes }) });
    assert.ok(payload.customer.notes.length > 5000, 'the payload keeps the full notes');

    const url = buildMailtoUrl(config, payload);
    const encodedBody = url.slice(url.indexOf('&body=') + '&body='.length);
    const { params } = parseMailto(url);

    assert.ok(encodedBody.length <= MAILTO_MAX_BODY_CHARS, `encoded body is ${encodedBody.length}`);
    assert.ok(params.body.length < 1800);
    assert.ok(url.length < 2000, `url is ${url.length}`);
    assert.ok(params.body.endsWith('... [shortened]'));
    assert.ok(params.body.includes('Total: $1,290'), 'everything before the notes survives');
    assert.ok(params.body.includes('Please ring before you come'));
  });

  test('copes with emoji, non-Latin text and broken surrogates', () => {
    const notes = `${'門'.repeat(400)} \u{1F6AA}\u{1F6AA} \uD83D`;
    const payload = makePayload({ config, customer: makeCustomer({ name: 'Zoë \uDE00 Müller', notes }) });
    let url;
    assert.doesNotThrow(() => {
      url = buildMailtoUrl(config, payload);
    });
    const { params } = parseMailto(url);
    assert.ok(params.subject.includes('Zoë'));
    assert.ok(params.body.includes('Müller'));
    assert.ok(url.length < 2000);
  });

  test('describes a manual size, an out-of-range quote and declined installation', () => {
    const payload = makePayload({
      config,
      measurement: { widthMm: 1250, heightMm: 2100, source: 'manual' },
      quote: { ok: false, status: 'out_of_range', lineItems: [], currency: 'AUD', messages: [] },
      includeInstallation: false,
    });
    const { params } = parseMailto(buildMailtoUrl(config, payload));
    assert.ok(params.body.includes('Door size: 1250 mm wide x 2100 mm high'));
    assert.ok(params.body.includes('Measured: entered by the customer'));
    assert.ok(params.body.includes('Installation: No'));
    assert.ok(params.body.includes('Total: no instant price'));
    assert.ok(!params.body.includes('Anything else'), 'empty notes are left out');
  });

  test('flags a demo-photo lead at the start of the subject and in the measured line', () => {
    const demo = makePayload({ config, demo: true });
    const { params } = parseMailto(buildMailtoUrl(config, demo));
    assert.equal(params.subject, `[DEMO] Door quote request ${demo.reference} - Jane Citizen (820 x 2040 mm)`);
    assert.ok(
      params.body.includes(
        "Measured: from the built-in demo photo, not the customer's own door, confidence good (about +/- 4 mm wide, +/- 6 mm high)",
      ),
    );
    assert.ok(!params.body.includes('Measured: from a photo'));

    const real = parseMailto(buildMailtoUrl(config, makePayload({ config }))).params;
    assert.ok(real.subject.startsWith('Door quote request '), 'no flag on a real measurement');
    assert.ok(!/demo/i.test(real.subject + real.body));
  });

  test('the email wording can be overridden through config.text', () => {
    const worded = makeConfig({
      lead: { mailto: 'sales@testdoors.example' },
      text: {
        'lead.mail.subject': 'Solicitud de puerta {reference}',
        'lead.mail.demoTag': '[PRUEBA]',
        'lead.mail.heading': 'Nueva solicitud desde {brand}',
        'lead.mail.reference': 'Referencia: {reference}',
        'lead.mail.doorSize': 'Medida: {size}',
        'lead.mail.size': '{width} mm de ancho x {height} mm de alto',
        'lead.mail.measuredDemo': 'Medido: con la foto de muestra',
        'lead.mail.confidence': 'confianza {quality}',
        'lead.mail.accuracy': 'aprox. +/- {width} mm de ancho, +/- {height} mm de alto',
        'lead.mail.product': 'Producto: {product}',
        'lead.mail.options': 'Opciones:',
        'lead.mail.installation': 'Instalación: {answer}',
        'lead.mail.yes': 'Sí',
        'lead.mail.totalWithTax': 'Total: {total} (incluye {tax} de {taxLabel})',
        'lead.mail.shortened': '... [abreviado]',
        'lead.mail.no': '', // an empty override is ignored
      },
    });
    const payload = makePayload({ config: worded, demo: true, selections: { colour: 'white', petMesh: false } });
    const { params } = parseMailto(buildMailtoUrl(worded, payload));

    assert.equal(params.subject, `[PRUEBA] Solicitud de puerta ${payload.reference} - Jane Citizen (820 x 2040 mm)`);
    assert.equal(
      params.body,
      [
        'Nueva solicitud desde Test Doors',
        '',
        `Referencia: ${payload.reference}`,
        '',
        'Your name: Jane Citizen',
        'Mobile: 0412 345 678',
        'Email: jane@example.com',
        'Postcode: 4000',
        '',
        'Medida: 820 mm de ancho x 2040 mm de alto',
        'Medido: con la foto de muestra, confianza good (aprox. +/- 4 mm de ancho, +/- 6 mm de alto)',
        'Producto: Classic Security Door',
        'Opciones:',
        '- Frame colour: Pearl white',
        '- Pet mesh: No',
        'Instalación: Sí',
        'Total: $1,290 (incluye $117.27 de GST)',
      ].join('\r\n'),
    );

    const long = makePayload({ config: worded, customer: makeCustomer({ notes: 'Ring first please. '.repeat(400) }) });
    assert.ok(parseMailto(buildMailtoUrl(worded, long)).params.body.endsWith('... [abreviado]'));

    // Customer text is never read as a placeholder, and every default is a non-empty string.
    const braces = makePayload({ config, customer: makeCustomer({ name: '{reference} {brand}' }) });
    assert.ok(parseMailto(buildMailtoUrl(config, braces)).params.body.includes('Your name: {reference} {brand}'));
    assert.ok(Object.isFrozen(LEAD_MAIL_STRINGS));
    for (const [key, value] of Object.entries(LEAD_MAIL_STRINGS)) {
      assert.match(key, /^lead\.mail\.\w+$/);
      assert.ok(typeof value === 'string' && value.length > 0, key);
    }
  });

  test('tidies the address and supports several recipients', () => {
    const multi = makeConfig({ lead: { mailto: ' mailto:sales@testdoors.example, quotes+web@testdoors.example ' } });
    const { to } = parseMailto(buildMailtoUrl(multi, makePayload({ config: multi })));
    assert.equal(to, 'sales@testdoors.example,quotes%2Bweb@testdoors.example');
  });
});

/* ------------------------------------------------------- measurement sources */

// The three ways in besides the paper method, shaped like the build contract's state.measure /
// state.size (js/estimate.js and js/screens/ar.js are written by other builders).

/** A shop that makes each door 6 mm under the opening (the README's example; the shipped config adds nothing). */
function makeRulesConfig(overrides = {}) {
  return { ...makeConfig(overrides), measurement: { adjustments: { widthMm: -6, heightMm: -6 }, roundToMm: 1 } };
}

/** An estimateFromCorners result: best first, at most 4, only from the catalogue. */
const ESTIMATE_MEASURE = Object.freeze({
  method: 'estimate',
  ok: true,
  corners: [
    { x: 520, y: 300 },
    { x: 1010, y: 310 },
    { x: 1000, y: 1520 },
    { x: 515, y: 1510 },
  ],
  imageWidth: 1536,
  imageHeight: 2048,
  aspectHW: 2.4878049,
  sigmaLnAspect: 0.016,
  focalPx: 1560,
  focalSource: 'prior',
  orthogonalityErrDeg: 0.6,
  viewTiltDeg: 7,
  candidates: [
    { widthMm: 820, heightMm: 2040, p: 0.71, zAspect: 0.2 },
    { widthMm: 870, heightMm: 2100, p: 0.2, zAspect: -1.1 },
    { widthMm: 820, heightMm: 2100, p: 0.06, zAspect: 1.9 },
    { widthMm: 920, heightMm: 2340, p: 0.03, zAspect: 2.6 },
  ],
  nonStandard: false,
  confident: false,
  issues: [],
  widthMm: 820,
  heightMm: 2040,
  planeToImage: [0.6, 0, 520, 0, 0.6, 300, 0, 0, 1],
});

/** What js/screens/ar.js builds from measureOpening + nearestStandard. */
const AR_MEASURE = Object.freeze({
  method: 'ar',
  ok: true,
  widthMm: 823.38,
  heightMm: 2046.61,
  minWidthMm: 818.9,
  minHeightMm: 2040.2,
  sillHeightMm: 0,
  warnings: ['base_not_level'],
  candidates: [{ widthMm: 820, heightMm: 2040, p: 0.82, zAspect: 0.3 }],
  runs: 1,
});

/** A measureDoor result (the paper method), with only the fields the lead reads. */
const PAPER_MEASURE = Object.freeze({
  widthMm: 820.4,
  heightMm: 2040.9,
  quality: { level: 'good', issues: [] },
  sigmaWidthMm: 1.84,
  sigmaHeightMm: 2.96,
});

function makeState({ size, measure = null, isDemo = false }) {
  return { size, measure, photo: { isDemo }, method: null };
}

describe('measurement sources: the lead payload', () => {
  test('a photo estimate carries standard, the other offered sizes and the ratio, and nothing paper-only', () => {
    const payload = makePayload({
      measurement: {
        widthMm: 814,
        heightMm: 2034,
        source: 'estimate',
        standard: true,
        alternatives: [
          { widthMm: 870, heightMm: 2100 },
          { widthMm: 820, heightMm: 2100 },
        ],
        aspectHW: 2.48780487,
        // Paper-only fields a caller might hand over by mistake: never passed on for an estimate.
        quality: 'good',
        sigmaWidthMm: 2,
        sigmaHeightMm: 3,
      },
    });
    assert.deepEqual(payload.measurement, {
      widthMm: 814,
      heightMm: 2034,
      source: 'estimate',
      standard: true,
      alternatives: [
        { widthMm: 870, heightMm: 2100 },
        { widthMm: 820, heightMm: 2100 },
      ],
      aspectHW: 2.4878,
    });
    assert.equal(payload.demo, false);
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  });

  test('an estimate always has an alternatives list, cleaned, rounded and capped at three', () => {
    const bare = makePayload({ measurement: { widthMm: 814, heightMm: 2034, source: 'estimate', standard: true } });
    assert.deepEqual(bare.measurement, { widthMm: 814, heightMm: 2034, source: 'estimate', standard: true, alternatives: [] });

    const messy = makePayload({
      measurement: {
        widthMm: 814,
        heightMm: 2034,
        source: 'estimate',
        alternatives: [
          { widthMm: 869.6, heightMm: 2100.2 },
          null,
          { widthMm: 'wide', heightMm: 2040 },
          { widthMm: 820 },
          { widthMm: 920, heightMm: 2340 },
          { widthMm: 770, heightMm: 2040 },
          { widthMm: 720, heightMm: 2040 },
        ],
        aspectHW: -2,
      },
    });
    assert.deepEqual(messy.measurement.alternatives, [
      { widthMm: 870, heightMm: 2100 },
      { widthMm: 920, heightMm: 2340 },
      { widthMm: 770, heightMm: 2040 },
    ]);
    assert.ok(!('aspectHW' in messy.measurement), 'a ratio that is not a positive number is left out');
    assert.ok(!('standard' in messy.measurement), 'standard is only carried when it is set');
  });

  test("an estimate carries the matched standard size and the result screen's warnings, cleaned", () => {
    const payload = makePayload({
      measurement: {
        widthMm: 914,
        heightMm: 2034,
        source: 'estimate',
        standard: true,
        standardSize: { widthMm: 919.6, heightMm: 2040.2 },
        nonStandard: true,
        confident: false,
        issues: ['non_standard', 42, '', null, 'steep_angle', ...Array.from({ length: 20 }, (_, i) => `code_${i}`)],
      },
    });
    const { measurement } = payload;
    assert.deepEqual(measurement.standardSize, { widthMm: 920, heightMm: 2040 });
    assert.equal(measurement.nonStandard, true);
    assert.equal(measurement.confident, false);
    assert.deepEqual(measurement.issues.slice(0, 2), ['non_standard', 'steep_angle']);
    assert.equal(measurement.issues.length, 12, 'a short, bounded list of codes');
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);

    // Only booleans, and only when given: an estimate built without them never claims a confidence.
    const vague = makePayload({
      measurement: { widthMm: 814, heightMm: 2034, source: 'estimate', nonStandard: 'yes', confident: 1, issues: 'steep_angle', standardSize: { widthMm: 820 } },
    }).measurement;
    for (const key of ['nonStandard', 'confident', 'issues', 'standardSize']) assert.ok(!(key in vague), `no ${key}`);
    // Never on another source.
    const paper = makePayload({ measurement: { ...MEASUREMENT, nonStandard: true, confident: false, issues: ['x'], standardOffered: true } }).measurement;
    for (const key of ['nonStandard', 'confident', 'issues', 'standardOffered']) assert.ok(!(key in paper), `paper has no ${key}`);
  });

  test('an AR reading says whether a standard size was offered, only as a boolean', () => {
    const offered = (standardOffered) =>
      makePayload({ measurement: { widthMm: 1174, heightMm: 2041, source: 'ar', standard: false, standardOffered } }).measurement;
    assert.equal(offered(false).standardOffered, false);
    assert.equal(offered(true).standardOffered, true);
    assert.ok(!('standardOffered' in offered('no')));
    assert.ok(!('standardOffered' in offered(undefined)));
  });

  test('an AR reading carries standard, the raw reading and the AR warnings', () => {
    const payload = makePayload({
      measurement: {
        widthMm: 814,
        heightMm: 2034,
        source: 'ar',
        standard: true,
        measured: { widthMm: 823.38, heightMm: 2046.61 },
        warnings: ['base_not_level', 42, '', 'off_plane'],
        sigmaWidthMm: 9,
        sigmaHeightMm: 12,
      },
    });
    assert.deepEqual(payload.measurement, {
      widthMm: 814,
      heightMm: 2034,
      source: 'ar',
      standard: true,
      measured: { widthMm: 823, heightMm: 2047 },
      warnings: ['base_not_level', 'off_plane'],
    });

    const own = makePayload({ measurement: { widthMm: 817, heightMm: 2041, source: 'ar', standard: false } });
    assert.deepEqual(own.measurement, { widthMm: 817, heightMm: 2041, source: 'ar', standard: false, warnings: [] });
  });

  test('an unknown source is recorded as a photo (paper) measurement', () => {
    for (const source of [undefined, null, '', 'lidar', 'Photo', 'AR', 42, {}, '__proto__', 'toString']) {
      const payload = makePayload({ measurement: { ...MEASUREMENT, source } });
      assert.equal(payload.measurement.source, 'photo', `${String(source)} becomes 'photo'`);
      assert.equal(payload.measurement.quality, 'good', 'and keeps the paper fields');
    }
    assert.equal(makePayload({ measurement: undefined }).measurement.source, 'photo');
  });

  test('the quality and sigmas belong to the paper method only', () => {
    for (const source of ['manual', 'estimate', 'ar']) {
      const { measurement } = makePayload({ measurement: { ...MEASUREMENT, quality: { level: 'fair', issues: ['door_small'] }, source } });
      for (const key of ['quality', 'qualityIssues', 'sigmaWidthMm', 'sigmaHeightMm']) {
        assert.ok(!(key in measurement), `${source} has no ${key}`);
      }
    }
    const paper = makePayload({ measurement: { ...MEASUREMENT, standard: false } }).measurement;
    assert.equal(paper.standard, false, 'standard is carried for any source that sets it');
    assert.equal(makePayload({ measurement: { ...MEASUREMENT, standard: 'yes' } }).measurement.standard, undefined);
  });

  test('the demo flag is kept for the two photo sources, never for AR or a typed size', () => {
    const size = { widthMm: 814, heightMm: 2034 };
    assert.equal(makePayload({ demo: true }).demo, true, 'paper');
    assert.equal(makePayload({ demo: true, measurement: { ...size, source: 'estimate', standard: true } }).demo, true, 'estimate');
    assert.equal(makePayload({ demo: true, measurement: { ...size, source: 'lidar' } }).demo, true, 'unknown means photo');
    // AR measures the door in front of the phone, even if the demo photo is still loaded from an earlier try.
    assert.equal(makePayload({ demo: true, measurement: { ...size, source: 'ar', standard: false } }).demo, false, 'ar');
    assert.equal(makePayload({ demo: true, measurement: { ...size, source: 'manual' } }).demo, false, 'manual');
    assert.equal(makePayload({ demo: 'true', measurement: { ...size, source: 'estimate' } }).demo, false);
  });
});

describe('measurement sources: the pre-filled email', () => {
  const config = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });

  const estimateMeasurement = {
    widthMm: 814,
    heightMm: 2034,
    source: 'estimate',
    standard: true,
    alternatives: [
      { widthMm: 870, heightMm: 2100 },
      { widthMm: 820, heightMm: 2100 },
    ],
    aspectHW: 2.4878,
  };
  const arMeasurement = {
    widthMm: 814,
    heightMm: 2034,
    source: 'ar',
    standard: true,
    measured: { widthMm: 823.4, heightMm: 2046.6 },
    warnings: ['base_not_level', 'off_plane'],
  };

  /** The size block of the body: from "Door size:" up to the product line. */
  function sizeLines(payload, worded = config) {
    const lines = parseMailto(buildMailtoUrl(worded, payload)).params.body.split('\r\n');
    const from = lines.findIndex((line) => line.startsWith('Door size:') || line.startsWith('Medida:'));
    const to = lines.findIndex((line, i) => i > from && /^(Product|Producto):/.test(line));
    return lines.slice(from, to);
  }

  test('an estimate says it was matched to a standard size and lists the other sizes it could be', () => {
    const payload = makePayload({ config, measurement: estimateMeasurement });
    assert.deepEqual(sizeLines(payload), [
      'Door size: 814 mm wide x 2034 mm high',
      'Measured: estimated from one photo, matched to the nearest standard size — needs a check measure',
      'Other standard sizes it could be: 870 x 2100 mm, 820 x 2100 mm',
    ]);
    const { params } = parseMailto(buildMailtoUrl(config, payload));
    assert.ok(!params.body.includes('+/-'), 'no accuracy figure the customer was never shown');
    assert.ok(!params.body.includes('confidence'));
    assert.equal(params.subject, `Door quote request ${payload.reference} - Jane Citizen (814 x 2034 mm)`);

    const single = makePayload({ config, measurement: { ...estimateMeasurement, alternatives: [] } });
    assert.equal(sizeLines(single).length, 2, 'no alternatives line when there is nothing else it could be');
  });

  test('an estimate from the demo photo is flagged in the subject and the measured line', () => {
    const payload = makePayload({ config, demo: true, measurement: estimateMeasurement });
    const { params } = parseMailto(buildMailtoUrl(config, payload));
    assert.ok(params.subject.startsWith('[DEMO] Door quote request '));
    assert.deepEqual(sizeLines(payload).slice(1), [
      "Measured: estimated from the built-in demo photo, not the customer's own door, matched to the nearest standard size",
      'Other standard sizes it could be: 870 x 2100 mm, 820 x 2100 mm',
    ]);
  });

  test('an AR reading says so and gives the raw reading, the standard-size choice and the checks it failed', () => {
    const payload = makePayload({ config, measurement: arMeasurement });
    assert.deepEqual(sizeLines(payload), [
      'Door size: 814 mm wide x 2034 mm high',
      "Measured: with the phone's AR camera — needs a check measure",
      'AR reading of the opening: 823 mm wide x 2047 mm high (the customer chose the nearest standard size)',
      'AR checks flagged: base_not_level, off_plane',
    ]);
    const own = makePayload({ config, measurement: { ...arMeasurement, standard: false, warnings: [] } });
    assert.deepEqual(sizeLines(own).slice(2), ['AR reading of the opening: 823 mm wide x 2047 mm high']);

    // Never a demo: the subject and body stay clear of it even when the demo photo was loaded.
    const { params } = parseMailto(buildMailtoUrl(config, makePayload({ config, demo: true, measurement: arMeasurement })));
    assert.ok(!/demo/i.test(params.subject + params.body));
    assert.ok(!params.body.includes('+/-'));
  });

  test('the paper and typed-size lines are unchanged', () => {
    assert.deepEqual(sizeLines(makePayload({ config })), [
      'Door size: 820 mm wide x 2040 mm high',
      'Measured: from a photo, confidence good (about +/- 4 mm wide, +/- 6 mm high)',
    ]);
    const manual = makePayload({ config, measurement: { widthMm: 900, heightMm: 2100, source: 'manual' } });
    assert.deepEqual(sizeLines(manual), [
      'Door size: 900 mm wide x 2100 mm high',
      'Measured: entered by the customer (not from a photo)',
    ]);
  });

  test('long notes are still shortened under the cap, and the estimate and AR lines survive', () => {
    const notes = 'Please ring before you come, the dog barks. '.repeat(200);
    for (const measurement of [estimateMeasurement, arMeasurement]) {
      const payload = makePayload({ config, measurement, customer: makeCustomer({ notes }) });
      const url = buildMailtoUrl(config, payload);
      const encodedBody = url.slice(url.indexOf('&body=') + '&body='.length);
      const { params } = parseMailto(url);
      assert.ok(encodedBody.length <= MAILTO_MAX_BODY_CHARS, `${measurement.source}: encoded body is ${encodedBody.length}`);
      assert.ok(url.length < 2000, `${measurement.source}: url is ${url.length}`);
      assert.ok(params.body.endsWith('... [shortened]'));
      assert.ok(params.body.includes('needs a check measure'));
      assert.ok(params.body.includes(measurement.source === 'ar' ? 'AR checks flagged:' : 'Other standard sizes'));
      assert.ok(params.body.includes('Total: $1,290'));
    }
  });

  test('the new wording can be overridden through config.text', () => {
    const worded = makeConfig({
      lead: { mailto: 'sales@testdoors.example' },
      text: {
        'lead.mail.doorSize': 'Medida: {size}',
        'lead.mail.size': '{width} x {height} mm',
        'lead.mail.product': 'Producto: {product}',
        'lead.mail.measuredEstimate': 'Medido: estimado con una foto',
        'lead.mail.measuredAr': 'Medido: con RA',
        'lead.mail.alternatives': 'También: {sizes}',
        'lead.mail.sizeShort': '{width}×{height}',
        'lead.mail.arReading': 'Lectura RA: {size}',
        'lead.mail.arStandard': 'eligió la medida estándar',
        'lead.mail.arWarnings': 'Avisos: {warnings}',
      },
    });
    const estimate = makePayload({ config: worded, measurement: estimateMeasurement });
    assert.deepEqual(sizeLines(estimate, worded), [
      'Medida: 814 x 2034 mm',
      'Medido: estimado con una foto',
      'También: 870×2100, 820×2100',
    ]);
    const ar = makePayload({ config: worded, measurement: arMeasurement });
    assert.deepEqual(sizeLines(ar, worded), [
      'Medida: 814 x 2034 mm',
      'Medido: con RA',
      'Lectura RA: 823 x 2047 mm (eligió la medida estándar)',
      'Avisos: base_not_level, off_plane',
    ]);
  });
});

describe('details screen: the measurement block it sends', () => {
  const config = makeRulesConfig();

  test('paper: the size with the fit quality and sigmas', () => {
    const state = makeState({ size: { widthMm: 814, heightMm: 2035, source: 'photo' }, measure: PAPER_MEASURE });
    assert.deepEqual(leadMeasurement(state, config), {
      widthMm: 814,
      heightMm: 2035,
      source: 'photo',
      quality: 'good',
      sigmaWidthMm: 1.84,
      sigmaHeightMm: 2.96,
    });
    // The door screen may tag the paper result; it is still the paper method.
    const tagged = makeState({ size: state.size, measure: { ...PAPER_MEASURE, method: 'paper' } });
    assert.equal(leadMeasurement(tagged, config).quality, 'good');
  });

  test('estimate: standard, the sizes the customer was offered but did not pick, and the ratio', () => {
    const state = makeState({ size: { widthMm: 814, heightMm: 2034, source: 'estimate', standard: true }, measure: ESTIMATE_MEASURE });
    assert.deepEqual(leadMeasurement(state, config), {
      widthMm: 814,
      heightMm: 2034,
      source: 'estimate',
      standard: true,
      // The catalogue size behind the 814 x 2034 the company's rules made of it.
      standardSize: { widthMm: 820, heightMm: 2040 },
      // Catalogue sizes as listed; the fourth candidate (p 0.03) was never offered.
      alternatives: [
        { widthMm: 870, heightMm: 2100 },
        { widthMm: 820, heightMm: 2100 },
      ],
      aspectHW: ESTIMATE_MEASURE.aspectHW,
      // What the result screen made of it: not confident (p 0.71), so the customer saw the "unsure" banner.
      nonStandard: false,
      confident: false,
      appConfident: false,
      issues: [],
    });

    // The customer picked "Also possible: 870 x 2100": that one is now the size, the most likely one an alternative.
    const picked = makeState({ size: { widthMm: 864, heightMm: 2094, source: 'estimate', standard: true }, measure: ESTIMATE_MEASURE });
    assert.deepEqual(leadMeasurement(picked, config).standardSize, { widthMm: 870, heightMm: 2100 });
    assert.deepEqual(leadMeasurement(picked, config).alternatives, [
      { widthMm: 820, heightMm: 2040 },
      { widthMm: 820, heightMm: 2100 },
    ]);
    // Without the config the chosen size is still recognised, as the candidate nearest the size.
    assert.deepEqual(leadMeasurement(picked).alternatives, leadMeasurement(picked, config).alternatives);
    assert.deepEqual(leadMeasurement(picked).standardSize, { widthMm: 870, heightMm: 2100 });
  });

  test('estimate: the warnings the customer was shown go with the lead, in the data and the email', () => {
    // A 1200 x 2100 opening, wider than any size sold: estimateFromCorners still puts 920 x 2040 first
    // with p about 1, but flags it as not a standard size, and the customer saw the nonStandard banner.
    const wide = {
      ...ESTIMATE_MEASURE,
      aspectHW: 1.75,
      candidates: [
        { widthMm: 920, heightMm: 2040, p: 1, zAspect: -19.05 },
        { widthMm: 920, heightMm: 2100, p: 0, zAspect: -20.1 },
        { widthMm: 870, heightMm: 2040, p: 0, zAspect: -21.3 },
      ],
      nonStandard: true,
      confident: false,
      issues: ['non_standard'],
    };
    const mailConfig = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });
    const state = makeState({ size: { widthMm: 920, heightMm: 2040, source: 'estimate', standard: true }, measure: wide });
    const payload = makePayload({ config: mailConfig, measurement: leadMeasurement(state, mailConfig) });
    assert.deepEqual(payload.measurement, {
      widthMm: 920,
      heightMm: 2040,
      source: 'estimate',
      standard: true,
      standardSize: { widthMm: 920, heightMm: 2040 },
      alternatives: [],
      aspectHW: 1.75,
      nonStandard: true,
      confident: false,
      appConfident: false,
      issues: ['non_standard'],
    });
    const body = parseMailto(buildMailtoUrl(mailConfig, payload)).params.body;
    assert.ok(
      body.includes('The app flagged: the door may not be a standard size, so this size could be some way out'),
      body,
    );
    assert.ok(body.includes('Photo checks flagged: non_standard'));

    // A likely size, but the door ran to the edge of the photo: the customer saw "can't match with
    // confidence", and the lead is no longer byte-identical to a confident one.
    const edge = { ...ESTIMATE_MEASURE, candidates: [{ widthMm: 820, heightMm: 2040, p: 0.97, zAspect: 0.1 }], confident: false, issues: ['door_near_edge'] };
    const sure = { ...edge, confident: true, issues: [] };
    const size = { widthMm: 820, heightMm: 2040, source: 'estimate', standard: true };
    const edgeLead = makePayload({ config: mailConfig, measurement: leadMeasurement(makeState({ size, measure: edge }), mailConfig) });
    const sureLead = makePayload({ config: mailConfig, measurement: leadMeasurement(makeState({ size, measure: sure }), mailConfig) });
    assert.notDeepEqual(edgeLead.measurement, sureLead.measurement);
    assert.equal(edgeLead.measurement.confident, false);
    assert.deepEqual(edgeLead.measurement.issues, ['door_near_edge']);
    const edgeBody = parseMailto(buildMailtoUrl(mailConfig, edgeLead)).params.body;
    assert.ok(edgeBody.includes('The app flagged: it could not be sure which standard size this is'), edgeBody);
    assert.ok(edgeBody.includes('Photo checks flagged: door_near_edge'));
    const sureBody = parseMailto(buildMailtoUrl(mailConfig, sureLead)).params.body;
    assert.ok(!sureBody.includes('flagged'), 'a confident estimate with no issues flags nothing');
  });

  test('estimate: with a fitting allowance, the email names the matched standard size and labels the others', () => {
    const mailConfig = makeRulesConfig({ lead: { mailto: 'sales@testdoors.example' } });
    const state = makeState({ size: { widthMm: 814, heightMm: 2034, source: 'estimate', standard: true }, measure: ESTIMATE_MEASURE });
    const payload = makePayload({ config: mailConfig, measurement: leadMeasurement(state, mailConfig) });
    const lines = parseMailto(buildMailtoUrl(mailConfig, payload)).params.body.split('\r\n');
    const from = lines.findIndex((line) => line.startsWith('Door size:'));
    assert.deepEqual(lines.slice(from, from + 6), [
      'Door size: 814 mm wide x 2034 mm high',
      'Measured: estimated from one photo, matched to the nearest standard size — needs a check measure',
      'Matched standard size, before your fitting allowance: 820 x 2040 mm',
      'Other standard sizes it could be, before your fitting allowance: 870 x 2100 mm, 820 x 2100 mm',
      'The app flagged: it could not be sure which standard size this is',
      'Product: Classic Security Door',
    ]);

    // No allowance: the door size is the catalogue size, so the lines stay as they were.
    const plain = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });
    const plainState = makeState({ size: { widthMm: 820, heightMm: 2040, source: 'estimate', standard: true }, measure: ESTIMATE_MEASURE });
    const plainBody = parseMailto(buildMailtoUrl(plain, makePayload({ config: plain, measurement: leadMeasurement(plainState, plain) }))).params.body;
    assert.ok(plainBody.includes('Other standard sizes it could be: 870 x 2100 mm, 820 x 2100 mm'));
    assert.ok(!plainBody.includes('Matched standard size'));
    assert.ok(!plainBody.includes('before your fitting allowance'));
  });

  test("estimate: a size the customer picked over the app's most likely one is not sent as the app's confident match", () => {
    // The app is 86% sure of 920 x 2100, so `confident` is true and no banner shows, but 920 x 2040
    // (p 0.09) is still offered under "Which is your door?" and the customer picks it.
    const sure = {
      ...ESTIMATE_MEASURE,
      aspectHW: 2.2826,
      candidates: [
        { widthMm: 920, heightMm: 2100, p: 0.86, zAspect: 0.2 },
        { widthMm: 920, heightMm: 2040, p: 0.09, zAspect: -1.6 },
        { widthMm: 870, heightMm: 2040, p: 0.04, zAspect: 2.1 },
      ],
      nonStandard: false,
      confident: true,
      issues: [],
    };
    const mailConfig = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });
    const lead = (size, measure = sure, cfg = mailConfig, demo = false) =>
      makePayload({ config: cfg, demo, measurement: leadMeasurement(makeState({ size, measure }), cfg) });
    const body = (payload, cfg = mailConfig) => parseMailto(buildMailtoUrl(cfg, payload)).params.body.split('\r\n');
    const sizeBlock = (payload, cfg = mailConfig) => {
      const lines = body(payload, cfg);
      const from = lines.findIndex((line) => line.startsWith('Door size:'));
      return lines.slice(from, lines.findIndex((line, i) => i > from && line.startsWith('Product:')));
    };

    const picked = lead({ widthMm: 920, heightMm: 2040, source: 'estimate', standard: true });
    assert.deepEqual(picked.measurement, {
      widthMm: 920,
      heightMm: 2040,
      source: 'estimate',
      standard: true,
      standardSize: { widthMm: 920, heightMm: 2040 },
      alternatives: [{ widthMm: 920, heightMm: 2100 }],
      appBest: { widthMm: 920, heightMm: 2100 },
      aspectHW: 2.2826,
      nonStandard: false,
      // The app was sure of 920 x 2100, never of the 920 x 2040 the company is asked to quote.
      confident: false,
      // But it was sure of its own size, so no banner asked the customer to pick: they overruled it.
      appConfident: true,
      issues: [],
    });
    // The most likely size is named once, on the line that says the customer chose over it, and is not
    // listed again among the other sizes (920 x 2100 was the only other one, so there is no such line).
    assert.deepEqual(sizeBlock(picked), [
      'Door size: 920 mm wide x 2040 mm high',
      'Measured: estimated from one photo, a standard size the customer chose — needs a check measure',
      "The customer chose this over the app's most likely size, 920 x 2100 mm",
    ]);
    assert.ok(!body(picked).join('\n').includes('nearest standard size'), 'the app did not match this size');

    // Going ahead with the app's own size is unchanged: confident, no appBest, "matched to the nearest".
    const taken = lead({ widthMm: 920, heightMm: 2100, source: 'estimate', standard: true });
    assert.equal(taken.measurement.confident, true);
    assert.ok(!('appBest' in taken.measurement));
    assert.deepEqual(sizeBlock(taken), [
      'Door size: 920 mm wide x 2100 mm high',
      'Measured: estimated from one photo, matched to the nearest standard size — needs a check measure',
      'Other standard sizes it could be: 920 x 2040 mm',
    ]);

    // With a fitting allowance the most likely size is labelled as a catalogue size, like the others,
    // and the catalogue size of the customer's pick is the one they chose, not one the app "matched".
    const rules = makeRulesConfig({ lead: { mailto: 'sales@testdoors.example' } });
    const ruled = lead({ widthMm: 914, heightMm: 2034, source: 'estimate', standard: true }, sure, rules);
    assert.deepEqual(ruled.measurement.appBest, { widthMm: 920, heightMm: 2100 });
    assert.deepEqual(sizeBlock(ruled, rules).slice(1), [
      'Measured: estimated from one photo, a standard size the customer chose — needs a check measure',
      'Standard size the customer chose, before your fitting allowance: 920 x 2040 mm',
      "The customer chose this over the app's most likely size, before your fitting allowance: 920 x 2100 mm",
    ]);
    assert.ok(!body(ruled, rules).join('\n').includes('Matched standard size'), 'the app did not match this size');

    // The demo photo keeps its own wording, without "nearest" either.
    const demo = lead({ widthMm: 920, heightMm: 2040, source: 'estimate', standard: true }, sure, mailConfig, true);
    assert.equal(
      sizeBlock(demo)[1],
      "Measured: estimated from the built-in demo photo, not the customer's own door, a standard size the customer chose",
    );
  });

  test('estimate: a customer answering the unsure banner is told apart from one overruling a sure match', () => {
    // Unsure between 820 x 2040 (p 0.55) and 820 x 2100 (p 0.40): the result screen shows a banner
    // asking the customer to pick. Sure of 820 x 2040 (p 0.82): no banner, but 820 x 2100 (p 0.15) is
    // still offered. Either way the customer picks 820 x 2100.
    const unsure = {
      ...ESTIMATE_MEASURE,
      aspectHW: 2.52,
      candidates: [
        { widthMm: 820, heightMm: 2040, p: 0.55, zAspect: 0.4 },
        { widthMm: 820, heightMm: 2100, p: 0.4, zAspect: -0.6 },
      ],
      nonStandard: false,
      confident: false,
      issues: [],
    };
    const sure = {
      ...unsure,
      aspectHW: 2.5,
      candidates: [
        { widthMm: 820, heightMm: 2040, p: 0.82, zAspect: 0.1 },
        { widthMm: 820, heightMm: 2100, p: 0.15, zAspect: -1.5 },
      ],
      confident: true,
    };
    // What the customer saw, from the result screen's own functions: the picker both times, a banner once.
    for (const measure of [unsure, sure]) assert.equal(estimateChoices(measure).length, 2);
    assert.ok(estimateBannerKey(unsure, 2), 'the unsure estimate asks the customer to pick');
    assert.equal(estimateBannerKey(sure, 2), null, 'the sure one shows no banner');

    const mailConfig = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });
    const lead = (size, measure, cfg = mailConfig) =>
      makePayload({ config: cfg, measurement: leadMeasurement(makeState({ size, measure }), cfg) });
    const sizeBlock = (payload, cfg = mailConfig) => {
      const lines = parseMailto(buildMailtoUrl(cfg, payload)).params.body.split('\r\n');
      const from = lines.findIndex((line) => line.startsWith('Door size:'));
      return lines.slice(from, lines.findIndex((line, i) => i > from && line.startsWith('Product:')));
    };
    const tall = { widthMm: 820, heightMm: 2100, source: 'estimate', standard: true };
    const answered = lead(tall, unsure);
    const overruled = lead(tall, sure);

    // In the data: both carry the customer's pick, not sent as confident, with the app's size beside it;
    // only appConfident says whether the app had asked.
    for (const payload of [answered, overruled]) {
      assert.deepEqual(payload.measurement.standardSize, { widthMm: 820, heightMm: 2100 });
      assert.deepEqual(payload.measurement.appBest, { widthMm: 820, heightMm: 2040 });
      assert.equal(payload.measurement.confident, false);
    }
    assert.equal(answered.measurement.appConfident, false);
    assert.equal(overruled.measurement.appConfident, true);

    // In the email: an answer to the app, and the banner the customer was shown, against an overruling.
    assert.deepEqual(sizeBlock(answered), [
      'Door size: 820 mm wide x 2100 mm high',
      'Measured: estimated from one photo, a standard size the customer chose — needs a check measure',
      'The app asked the customer to pick, and they chose this over its most likely size, 820 x 2040 mm',
      'The app flagged: it could not be sure which standard size this is',
    ]);
    assert.deepEqual(sizeBlock(overruled), [
      'Door size: 820 mm wide x 2100 mm high',
      'Measured: estimated from one photo, a standard size the customer chose — needs a check measure',
      "The customer chose this over the app's most likely size, 820 x 2040 mm",
    ]);

    // With a fitting allowance (-10 wide, -15 high): the pick's catalogue size is named as the customer's
    // choice, not as "matched", and the app's size is not listed again among the other sizes.
    const allowance = {
      ...makeConfig({ lead: { mailto: 'sales@testdoors.example' } }),
      measurement: { adjustments: { widthMm: -10, heightMm: -15 }, roundToMm: 1 },
    };
    const three = { ...unsure, candidates: [...unsure.candidates, { widthMm: 870, heightMm: 2040, p: 0.05, zAspect: 2 }] };
    const ruled = lead({ widthMm: 810, heightMm: 2085, source: 'estimate', standard: true }, three, allowance);
    assert.deepEqual(ruled.measurement.standardSize, { widthMm: 820, heightMm: 2100 });
    assert.deepEqual(ruled.measurement.alternatives, [
      { widthMm: 820, heightMm: 2040 },
      { widthMm: 870, heightMm: 2040 },
    ], 'the data still lists every size offered');
    assert.deepEqual(sizeBlock(ruled, allowance), [
      'Door size: 810 mm wide x 2085 mm high',
      'Measured: estimated from one photo, a standard size the customer chose — needs a check measure',
      'Standard size the customer chose, before your fitting allowance: 820 x 2100 mm',
      'The app asked the customer to pick, and they chose this over its most likely size, before your fitting allowance: 820 x 2040 mm',
      'Other standard sizes it could be, before your fitting allowance: 870 x 2040 mm',
      'The app flagged: it could not be sure which standard size this is',
    ]);

    // appConfident is passed on only as a boolean, and only for an estimate.
    const base = { widthMm: 820, heightMm: 2100, source: 'estimate', standard: true };
    assert.ok(!('appConfident' in makePayload({ measurement: { ...base, appConfident: 'no' } }).measurement));
    assert.ok(!('appConfident' in makePayload({ measurement: { ...MEASUREMENT, appConfident: false } }).measurement));
  });

  test('estimate: a lead without appConfident keeps the email it had', () => {
    // Built by a caller that sends only `confident`: unsure is read from it while there is no appBest,
    // and an override is worded as one, since nothing says the app asked.
    const mailConfig = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });
    const body = (measurement) => parseMailto(buildMailtoUrl(mailConfig, makePayload({ config: mailConfig, measurement }))).params.body;
    const base = { widthMm: 820, heightMm: 2100, source: 'estimate', standard: true, standardSize: { widthMm: 820, heightMm: 2100 }, alternatives: [] };
    assert.ok(body({ ...base, confident: false }).includes('The app flagged: it could not be sure which standard size this is'));
    const override = body({ ...base, appBest: { widthMm: 820, heightMm: 2040 }, confident: false });
    assert.ok(override.includes("The customer chose this over the app's most likely size, 820 x 2040 mm"), override);
    assert.ok(!override.includes('could not be sure'), override);
  });

  test('estimate: appBest is only carried as a whole size that differs from the one accepted', () => {
    const base = { widthMm: 920, heightMm: 2040, source: 'estimate', standard: true, standardSize: { widthMm: 920, heightMm: 2040 } };
    const appBest = (value) => makePayload({ measurement: { ...base, appBest: value } }).measurement.appBest;
    assert.deepEqual(appBest({ widthMm: 919.6, heightMm: 2100.3 }), { widthMm: 920, heightMm: 2100 });
    assert.equal(appBest({ widthMm: 920, heightMm: 2040 }), undefined, 'the accepted size is not an override');
    assert.equal(appBest({ widthMm: 920 }), undefined);
    assert.equal(appBest('920 x 2100'), undefined);
    const paper = makePayload({ measurement: { ...MEASUREMENT, appBest: { widthMm: 920, heightMm: 2100 } } }).measurement;
    assert.ok(!('appBest' in paper), 'never on another source');
  });

  test('estimate: unlikely candidates are not passed on, and standard is always true', () => {
    const measure = {
      ...ESTIMATE_MEASURE,
      candidates: [
        { widthMm: 820, heightMm: 2040, p: 0.93, zAspect: 0.1 },
        { widthMm: 870, heightMm: 2100, p: 0.04, zAspect: -2.2 },
        { widthMm: 820, heightMm: 2100, p: 0.03, zAspect: 2.4 },
      ],
    };
    const state = makeState({ size: { widthMm: 814, heightMm: 2034, source: 'estimate' }, measure });
    const measurement = leadMeasurement(state, config);
    assert.deepEqual(measurement.alternatives, []);
    assert.equal(measurement.standard, true);
  });

  test('AR: standard as chosen, the raw reading and the warnings', () => {
    const standard = makeState({ size: { widthMm: 814, heightMm: 2034, source: 'ar', standard: true }, measure: AR_MEASURE });
    assert.deepEqual(leadMeasurement(standard, config), {
      widthMm: 814,
      heightMm: 2034,
      source: 'ar',
      standard: true,
      standardOffered: true,
      measured: { widthMm: 823.38, heightMm: 2046.61 },
      warnings: ['base_not_level'],
    });
    const own = makeState({ size: { widthMm: 817, heightMm: 2041, source: 'ar', standard: false }, measure: AR_MEASURE });
    assert.equal(leadMeasurement(own, config).standard, false);
    assert.equal(leadMeasurement(own, config).standardOffered, true, 'offered, and turned down');
    assert.notEqual(leadMeasurement(own, config).warnings, AR_MEASURE.warnings, 'a copy, not the measure itself');
  });

  test('AR: standard: false says whether a standard size was turned down or never on offer', () => {
    // 1180 mm wide: the nearest standard size is 260 mm out, so the result screen offered none.
    const wide = { ...AR_MEASURE, widthMm: 1180.4, heightMm: 2046.6, candidates: [{ widthMm: 920, heightMm: 2040, p: 1, zAspect: -9 }] };
    const state = makeState({ size: { widthMm: 1174, heightMm: 2041, source: 'ar', standard: false }, measure: wide });
    const measurement = leadMeasurement(state, config);
    assert.equal(measurement.standard, false);
    assert.equal(measurement.standardOffered, false);

    const mailConfig = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });
    const readingLine = (m) =>
      parseMailto(buildMailtoUrl(mailConfig, makePayload({ config: mailConfig, measurement: m })))
        .params.body.split('\r\n')
        .find((line) => line.startsWith('AR reading'));
    assert.equal(readingLine(measurement), 'AR reading of the opening: 1180 mm wide x 2047 mm high (no standard size was close enough to offer)');
    const own = leadMeasurement(makeState({ size: { widthMm: 817, heightMm: 2041, source: 'ar', standard: false }, measure: AR_MEASURE }), config);
    assert.equal(
      readingLine(own),
      'AR reading of the opening: 823 mm wide x 2047 mm high (the customer kept this reading rather than the nearest standard size)',
    );
  });

  test('manual: the typed size alone, whatever was measured before', () => {
    for (const measure of [null, PAPER_MEASURE, ESTIMATE_MEASURE, AR_MEASURE]) {
      const state = makeState({ size: { widthMm: 900, heightMm: 2100, source: 'manual' }, measure });
      assert.deepEqual(leadMeasurement(state, config), { widthMm: 900, heightMm: 2100, source: 'manual' });
    }
  });

  test('a measurement from another way in is never mixed into the size', () => {
    const paperSize = { widthMm: 814, heightMm: 2035, source: 'photo' };
    assert.deepEqual(leadMeasurement(makeState({ size: paperSize, measure: ESTIMATE_MEASURE }), config), paperSize);
    const estimateSize = { widthMm: 814, heightMm: 2034, source: 'estimate', standard: true };
    assert.deepEqual(leadMeasurement(makeState({ size: estimateSize, measure: AR_MEASURE }), config), estimateSize);
    const arSize = { widthMm: 814, heightMm: 2034, source: 'ar', standard: false };
    assert.deepEqual(leadMeasurement(makeState({ size: arSize, measure: PAPER_MEASURE }), config), arSize);
  });

  test('only a size read off the demo photo is the demo door', () => {
    const size = (source) => ({ widthMm: 814, heightMm: 2034, source });
    assert.equal(isDemoDoor(makeState({ size: size('photo'), isDemo: true })), true);
    assert.equal(isDemoDoor(makeState({ size: size('estimate'), isDemo: true })), true);
    assert.equal(isDemoDoor(makeState({ size: size('ar'), isDemo: true })), false, 'AR after trying the demo');
    assert.equal(isDemoDoor(makeState({ size: size('manual'), isDemo: true })), false);
    assert.equal(isDemoDoor(makeState({ size: size('estimate'), isDemo: false })), false);
    assert.equal(isDemoDoor({ size: size('estimate'), photo: null }), false);
  });

  test('a photo goes with the enquiry only when the size was measured from it', () => {
    const size = (source, extra = {}) => ({ widthMm: 814, heightMm: 2034, source, ...extra });
    const libraryPicture = { isDemo: false };
    // Read off the photo, by either photo way in.
    assert.equal(photoBacksSize({ size: size('photo'), measure: PAPER_MEASURE, photo: libraryPicture }), true);
    assert.equal(photoBacksSize({ size: size('estimate', { standard: true }), measure: ESTIMATE_MEASURE, photo: libraryPicture }), true);
    // A size typed over a measurement of that photo: still the customer's door, as they photographed it.
    assert.equal(photoBacksSize({ size: size('manual'), measure: ESTIMATE_MEASURE, photo: libraryPicture }), true);
    assert.equal(photoBacksSize({ size: size('manual'), measure: PAPER_MEASURE, photo: libraryPicture }), true);

    // "Choose a photo", the wrong picture, Back twice, then AR: ar.js leaves state.photo as it was, but
    // the AR reading never used it, so the unrelated picture must not be uploaded with it.
    assert.equal(photoBacksSize({ size: size('ar', { standard: false }), measure: AR_MEASURE, photo: libraryPicture }), false);
    // The same, then a typed size over the AR reading, or straight from the welcome screen.
    assert.equal(photoBacksSize({ size: size('manual'), measure: AR_MEASURE, photo: libraryPicture }), false);
    assert.equal(photoBacksSize({ size: size('manual'), measure: null, photo: libraryPicture }), false);
    assert.equal(photoBacksSize({ size: size('estimate'), measure: ESTIMATE_MEASURE, photo: null }), false, 'no photo');
  });

  test('the submit path sends a leftover library photo with an AR enquiry never, and the measured one always', async (context) => {
    // js/screens/details.js itself, mounted in a fake browser (tests/helpers/screen-dom.mjs) and sent, so
    // this checks the enquiry its submit really emits, not one put together here from its parts. No
    // endpoint or mailto: demo lead mode, where submitLead sends nothing and resolves ok after
    // DEMO_DELAY_MS, which the mocked clock skips.
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const withPhotos = makeConfig({ lead: { includePhoto: true } });
    const ENCODED = 'data:image/jpeg;base64,TElCUkFSWQ==';
    const libraryPicture = { isDemo: false, width: 1536, height: 2048, canvas: {} };
    const demoPicture = { ...libraryPicture, isDemo: true };

    /** Mount the details screen on this size, press Send, and return the lead it emitted and how many photos it encoded. */
    async function send({ size, measure, photo }, config = withPhotos) {
      const dom = installFakeDom();
      // photoToJpegDataUrl draws on a canvas, which the fake DOM's cannot do, so a canvas that counts the
      // encodes stands in. Without it a wrongly attempted encode would throw, be swallowed as "no photo"
      // and hide the very leak this test is for.
      let encodes = 0;
      const createElement = dom.document.createElement.bind(dom.document);
      dom.document.createElement = (tag) => {
        if (tag !== 'canvas') return createElement(tag);
        const toDataURL = () => {
          encodes += 1;
          return ENCODED;
        };
        return { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL };
      };
      let screen = null;
      try {
        const state = {
          size,
          measure,
          photo,
          method: null,
          quoteInput: { productId: 'classic', selections: {}, includeInstallation: null },
          customer: {},
        };
        screen = dom.mount(detailsScreen, { state, config });
        // Filled in and ticked as the customer does it.
        const { consent, ...fields } = makeCustomer();
        for (const [field, value] of Object.entries(fields)) {
          const input = dom.document.getElementById(`sm-details-${field}`);
          input.value = value;
          input.dispatch('input');
        }
        const consentBox = dom.document.getElementById('sm-details-consent');
        consentBox.checked = consent;
        consentBox.dispatch('change');
        // In a browser, tapping Send raises the form's submit event (the button is tied to the form by its
        // `form` attribute); the fake DOM has no default actions, so the event is fired at the form here.
        screen.root.querySelector('form').dispatch('submit');
        assert.deepEqual(screen.toasts, [], 'the filled-in form was accepted');
        context.mock.timers.tick(DEMO_DELAY_MS);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(screen.went, ['done'], 'the enquiry was sent');
        const leads = screen.emitted.filter((event) => event.type === 'lead');
        assert.equal(leads.length, 1);
        return { lead: leads[0].payload, encodes };
      } finally {
        screen?.unmount();
        dom.uninstall();
      }
    }

    // "Choose a photo", the wrong picture, Back twice, then AR: ar.js leaves the picture in state.photo.
    const ar = await send({ size: { widthMm: 814, heightMm: 2034, source: 'ar', standard: true }, measure: AR_MEASURE, photo: libraryPicture });
    assert.equal(ar.lead.measurement.source, 'ar');
    assert.ok(!('photo' in ar.lead), 'the AR enquiry carries no photo');
    assert.equal(ar.encodes, 0, 'the leftover photo is never even encoded');
    // The same, with a size typed over the AR reading.
    const typed = await send({ size: { widthMm: 900, heightMm: 2100, source: 'manual' }, measure: AR_MEASURE, photo: libraryPicture });
    assert.ok(!('photo' in typed.lead), 'a size typed over an AR reading carries no photo');
    assert.equal(typed.encodes, 0);

    // The photo the size was estimated from does go.
    const estimate = { size: { widthMm: 814, heightMm: 2034, source: 'estimate', standard: true }, measure: ESTIMATE_MEASURE, photo: libraryPicture };
    const measured = await send(estimate);
    assert.equal(measured.lead.photo, ENCODED);
    assert.equal(measured.encodes, 1);
    // And not when the company has not asked for photos.
    const unasked = await send(estimate, makeConfig());
    assert.ok(!('photo' in unasked.lead), 'includePhoto is off');
    assert.equal(unasked.encodes, 0);
    // Nor the bundled demo image behind a size the customer typed in, which is their own door's.
    const overDemo = await send({ size: { widthMm: 900, heightMm: 2100, source: 'manual' }, measure: ESTIMATE_MEASURE, photo: demoPicture });
    assert.ok(!('photo' in overDemo.lead), 'the demo image is not the customer door');
    assert.equal(overDemo.encodes, 0);
  });

  test('end to end: each way in gives the documented lead measurement', () => {
    const cases = [
      [
        makeState({ size: { widthMm: 814, heightMm: 2035, source: 'photo' }, measure: PAPER_MEASURE }),
        { widthMm: 814, heightMm: 2035, source: 'photo', quality: 'good', sigmaWidthMm: 1.8, sigmaHeightMm: 3 },
      ],
      [
        makeState({ size: { widthMm: 814, heightMm: 2034, source: 'estimate', standard: true }, measure: ESTIMATE_MEASURE, isDemo: true }),
        {
          widthMm: 814,
          heightMm: 2034,
          source: 'estimate',
          standard: true,
          standardSize: { widthMm: 820, heightMm: 2040 },
          alternatives: [
            { widthMm: 870, heightMm: 2100 },
            { widthMm: 820, heightMm: 2100 },
          ],
          aspectHW: 2.4878,
          nonStandard: false,
          confident: false,
          appConfident: false,
          issues: [],
        },
      ],
      [
        makeState({ size: { widthMm: 814, heightMm: 2034, source: 'ar', standard: true }, measure: AR_MEASURE, isDemo: true }),
        {
          widthMm: 814,
          heightMm: 2034,
          source: 'ar',
          standard: true,
          standardOffered: true,
          measured: { widthMm: 823, heightMm: 2047 },
          warnings: ['base_not_level'],
        },
      ],
      [makeState({ size: { widthMm: 900, heightMm: 2100, source: 'manual' }, measure: AR_MEASURE }), { widthMm: 900, heightMm: 2100, source: 'manual' }],
    ];
    for (const [state, expected] of cases) {
      const payload = makePayload({ config, measurement: leadMeasurement(state, config), demo: isDemoDoor(state) });
      assert.deepEqual(payload.measurement, expected, state.size.source);
      assert.equal(payload.demo, state.size.source === 'estimate', `${state.size.source}: demo flag`);
    }
  });
});

describe('measurement sources: screen wording', () => {
  test('the quote, details and confirmation screens name an estimated size as one', () => {
    assert.equal(quoteStrings['quote.size.estimate'], 'Standard size estimate');
    assert.equal(quoteStrings['quote.size.ar'], 'AR estimate');
    assert.ok(quoteStrings['quote.size.manual']);
    for (const key of ['details.sizeEstimate', 'details.sizeAr']) assert.match(detailsStrings[key], /check measure/);
    for (const key of ['done.sizeEstimate', 'done.sizeAr', 'done.next2Estimate']) assert.ok(doneStrings[key], key);
    // Honest about accuracy: no fixed tolerance is promised anywhere in this copy (the paper method's
    // "+/- {width} mm" is filled in from its own measured sigmas).
    const copy = JSON.stringify([quoteStrings, detailsStrings, doneStrings, LEAD_MAIL_STRINGS]);
    assert.ok(!/±|\+\/-\s*\d/.test(copy));
  });
});

/* ------------------------------------------------------------------- submit */

describe('submitLead', () => {
  const realFetch = globalThis.fetch;
  const hadLocation = 'location' in globalThis;
  const realLocation = globalThis.location;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (hadLocation) globalThis.location = realLocation;
    else delete globalThis.location;
  });

  const webhookConfig = makeConfig({ lead: { endpoint: 'https://hooks.example/lead' } });

  test('demo mode sends nothing and resolves ok after a short pause', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 };
    };
    const started = performance.now();
    const result = await submitLead(makeConfig(), makePayload());
    const elapsed = performance.now() - started;

    assert.deepEqual(result, { ok: true, mode: 'demo' });
    assert.equal(fetchCalls, 0);
    assert.ok(elapsed >= 300, `expected a visible pause, got ${elapsed.toFixed(0)} ms`);
    assert.ok(elapsed < 3000);
  });

  test('demo pause can be shortened', async () => {
    const started = performance.now();
    assert.deepEqual(await submitLead(makeConfig(), makePayload(), { demoDelayMs: 0 }), { ok: true, mode: 'demo' });
    assert.ok(performance.now() - started < 250);
  });

  test('webhook mode POSTs the payload as JSON and is ok on 2xx', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201 };
    };
    const payload = makePayload({ config: webhookConfig });
    const result = await submitLead(webhookConfig, payload);

    assert.deepEqual(result, { ok: true, mode: 'webhook' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://hooks.example/lead', 'no customer data in the URL');
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=UTF-8' });
    assert.equal(typeof init.body, 'string');
    assert.deepEqual(JSON.parse(init.body), payload);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
  });

  test('webhook mode sends a CORS "simple" request, so no preflight is needed', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    };
    const payload = makePayload({ config: webhookConfig });
    assert.ok(!('contentType' in webhookConfig.lead), 'the setting is absent from this config');
    assert.deepEqual(await submitLead(webhookConfig, payload), { ok: true, mode: 'webhook' });

    const { init } = calls[0];
    // text/plain is one of the three content types a browser will POST cross-origin without first
    // asking the endpoint (which Zapier-style webhooks refuse); the body is still the JSON text.
    assert.equal(WEBHOOK_CONTENT_TYPE, 'text/plain;charset=UTF-8');
    assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=UTF-8' }, 'the only header');
    assert.deepEqual(Object.keys(init).sort(), ['body', 'headers', 'method', 'signal'], 'no credentials or mode options');
    assert.deepEqual(JSON.parse(init.body), payload);
    // The same thing as the platform sees it.
    const request = new Request('https://hooks.example/lead', init);
    assert.equal(request.headers.get('content-type'), 'text/plain;charset=UTF-8');
    assert.deepEqual([...request.headers.keys()], ['content-type']);
  });

  test('config.lead.contentType overrides the content type; blank or missing means text/plain', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(init);
      return { ok: true, status: 200 };
    };
    const send = async (contentType) => {
      const config = makeConfig({ lead: { endpoint: 'https://crm.example/leads', contentType } });
      const payload = makePayload({ config });
      assert.deepEqual(await submitLead(config, payload), { ok: true, mode: 'webhook' });
      const init = calls.pop();
      assert.deepEqual(JSON.parse(init.body), payload, 'the body is the same JSON text either way');
      return init.headers;
    };

    assert.deepEqual(await send('application/json'), { 'Content-Type': 'application/json' });
    assert.deepEqual(await send('  application/json; charset=utf-8 '), { 'Content-Type': 'application/json; charset=utf-8' });
    for (const unset of [undefined, null, '', '   ', 42, true, {}]) {
      assert.deepEqual(await send(unset), { 'Content-Type': 'text/plain;charset=UTF-8' }, `${String(unset)} means the default`);
    }
  });

  test('webhook mode is not ok on a 500', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    assert.deepEqual(await submitLead(webhookConfig, makePayload()), { ok: false, mode: 'webhook', error: 'http_500' });
  });

  test('webhook mode is not ok on other non-2xx statuses', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await submitLead(webhookConfig, makePayload()), { ok: false, mode: 'webhook', error: 'http_404' });
    globalThis.fetch = async () => ({ ok: false, status: 302 });
    assert.deepEqual(await submitLead(webhookConfig, makePayload()), { ok: false, mode: 'webhook', error: 'http_302' });
    globalThis.fetch = async () => ({ ok: false, status: 0, type: 'opaque' });
    assert.deepEqual(await submitLead(webhookConfig, makePayload()), { ok: false, mode: 'webhook', error: 'network' });
  });

  test('webhook mode reports a rejected fetch as a network error', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    assert.deepEqual(await submitLead(webhookConfig, makePayload()), { ok: false, mode: 'webhook', error: 'network' });

    globalThis.fetch = () => {
      throw new Error('synchronous failure');
    };
    assert.deepEqual(await submitLead(webhookConfig, makePayload()), { ok: false, mode: 'webhook', error: 'network' });
  });

  test('webhook mode aborts a slow request and reports a timeout', async () => {
    let seenSignal = null;
    globalThis.fetch = (url, init) =>
      new Promise((resolve, reject) => {
        seenSignal = init.signal;
        init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    const started = performance.now();
    const result = await submitLead(webhookConfig, makePayload(), { timeoutMs: 30 });

    assert.deepEqual(result, { ok: false, mode: 'webhook', error: 'timeout' });
    assert.equal(seenSignal.aborted, true);
    assert.ok(performance.now() - started < 2000);
  });

  test('webhook mode times out even when fetch ignores the abort signal', async () => {
    globalThis.fetch = () => new Promise(() => {});
    const result = await submitLead(webhookConfig, makePayload(), { timeoutMs: 30 });
    assert.deepEqual(result, { ok: false, mode: 'webhook', error: 'timeout' });
  });

  test('webhook mode never throws, even for an unserialisable payload or no fetch at all', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 };
    };
    const circular = {};
    circular.self = circular;
    assert.deepEqual(await submitLead(webhookConfig, circular), { ok: false, mode: 'webhook', error: 'invalid_payload' });
    assert.equal(fetchCalls, 0);

    globalThis.fetch = undefined;
    assert.deepEqual(await submitLead(webhookConfig, makePayload()), { ok: false, mode: 'webhook', error: 'network' });
  });

  test('mailto mode opens the pre-filled email and sends nothing itself', async () => {
    const mailtoConfig = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 };
    };
    globalThis.location = { href: 'https://testdoors.example/measure/' };
    const payload = makePayload({ config: mailtoConfig });
    const result = await submitLead(mailtoConfig, payload);

    assert.deepEqual(result, { ok: true, mode: 'mailto' });
    assert.equal(globalThis.location.href, buildMailtoUrl(mailtoConfig, payload));
    assert.equal(fetchCalls, 0);
  });

  test('mailto mode resolves not-ok instead of throwing when there is no location', async () => {
    const mailtoConfig = makeConfig({ lead: { mailto: 'sales@testdoors.example' } });
    delete globalThis.location;
    assert.deepEqual(await submitLead(mailtoConfig, makePayload({ config: mailtoConfig })), {
      ok: false,
      mode: 'mailto',
      error: 'unavailable',
    });
  });
});
