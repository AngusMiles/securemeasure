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
} from '../js/lead.js';

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
