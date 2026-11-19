import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deepMerge, loadConfig, applyTheme, measurementMethods, normaliseConfig } from '../js/theme.js';
import { DEFAULT_STANDARD_SIZES } from '../js/estimate.js';
import liveConfig from '../js/config.js';
import acmeSkin from '../skins/acme.js';
// js/config.js is there to be edited, so only the loadConfig tests read it (and compare against whatever
// it holds). The applyTheme tests need known colours and run on the fixed copy of the shipped settings.
import { SHIPPED_CONFIG as baseConfig } from './helpers/shipped-config.mjs';

/** The exact custom property names from the build contract. */
const THEME_PROPERTIES = [
  '--sm-primary',
  '--sm-primary-contrast',
  '--sm-accent',
  '--sm-accent-contrast',
  '--sm-bg',
  '--sm-surface',
  '--sm-text',
  '--sm-muted',
  '--sm-border',
  '--sm-success',
  '--sm-warning',
  '--sm-danger',
  '--sm-radius',
  '--sm-font',
];

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Silences console.warn for one test and returns the recorded calls. */
function captureWarnings(t) {
  return t.mock.method(console, 'warn', () => {}).mock;
}

const warningText = (warnings) => warnings.calls.map((call) => String(call.arguments[0])).join('\n');

describe('deepMerge', () => {
  test('merges nested plain objects key by key', () => {
    const merged = deepMerge(
      { a: { b: 1, c: 2, deep: { x: 1, y: 2 } }, keep: 'yes' },
      { a: { c: 3, d: 4, deep: { y: 20 } } },
    );
    assert.deepEqual(merged, { a: { b: 1, c: 3, d: 4, deep: { x: 1, y: 20 } }, keep: 'yes' });
  });

  test('replaces arrays whole instead of merging them', () => {
    const merged = deepMerge({ list: [1, 2, 3], nested: { list: [{ id: 'a' }, { id: 'b' }] } }, { list: [9], nested: { list: [] } });
    assert.deepEqual(merged, { list: [9], nested: { list: [] } });
  });

  test('a skin replaces the standard sizes whole, never entry by entry', () => {
    const base = { measurement: { standardSizes: liveConfig.measurement.standardSizes, roundToMm: 1 } };
    const usSizes = [
      { widthMm: 762, heightMm: 2032 },
      { widthMm: 813, heightMm: 2032 },
    ];
    const merged = deepMerge(base, { measurement: { standardSizes: usSizes } });
    // Merged index by index, the result would keep the base list's later sizes after the two US ones.
    assert.deepEqual(merged.measurement.standardSizes, usSizes);
    assert.equal(merged.measurement.roundToMm, 1, 'the rest of the group is still merged');
    assert.notEqual(merged.measurement.standardSizes, usSizes, 'and it is a copy');
    assert.notEqual(merged.measurement.standardSizes[0], usSizes[0]);

    // A skin that only switches a method off keeps the base sizes and the other methods.
    const noAr = deepMerge(liveConfig, { measurement: { methods: { ar: false } } });
    assert.deepEqual(noAr.measurement.methods, { ...liveConfig.measurement.methods, ar: false });
    assert.deepEqual(noAr.measurement.standardSizes, liveConfig.measurement.standardSizes);
  });

  test('replaces primitives, and swaps objects and primitives either way', () => {
    assert.deepEqual(deepMerge({ a: 1, b: 'x', c: true }, { a: 2, b: 'y', c: false }), { a: 2, b: 'y', c: false });
    assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: 5 }), { a: 5 });
    assert.deepEqual(deepMerge({ a: 5 }, { a: { b: 1 } }), { a: { b: 1 } });
    assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: [1] }), { a: [1] });
    assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: null }), { a: null });
    assert.deepEqual(deepMerge({ a: 'kept' }, { a: '' }), { a: '' });
    assert.deepEqual(deepMerge({ a: 1 }, { a: 0 }), { a: 0 });
  });

  test('treats undefined as "not specified"', () => {
    assert.deepEqual(deepMerge({ a: 1, b: { c: 2 } }, { a: undefined, b: { c: undefined } }), { a: 1, b: { c: 2 } });
    assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
    assert.deepEqual(deepMerge({ a: 1 }, {}), { a: 1 });
  });

  test('adds keys that exist only in the override', () => {
    assert.deepEqual(deepMerge({ text: {} }, { text: { 'welcome.title': 'Hi' }, extra: { n: 1 } }), {
      text: { 'welcome.title': 'Hi' },
      extra: { n: 1 },
    });
  });

  test('never mutates its inputs', () => {
    const base = { a: { b: 1, list: [1, { n: 2 }] }, c: 'x' };
    const override = { a: { b: 2, added: { deep: [3] } }, d: [{ e: 1 }] };
    const baseSnapshot = structuredClone(base);
    const overrideSnapshot = structuredClone(override);

    // Frozen inputs make any attempted write throw in strict mode.
    const merged = deepMerge(deepFreeze(base), deepFreeze(override));

    assert.deepEqual(base, baseSnapshot);
    assert.deepEqual(override, overrideSnapshot);
    assert.deepEqual(merged, { a: { b: 2, list: [1, { n: 2 }], added: { deep: [3] } }, c: 'x', d: [{ e: 1 }] });
  });

  test('returns a result that shares no objects or arrays with the inputs', () => {
    const base = { a: { list: [1, { n: 2 }] }, untouched: { v: 1 } };
    const override = { b: { items: [{ id: 'x' }] } };
    const merged = deepMerge(base, override);

    assert.notEqual(merged.a, base.a);
    assert.notEqual(merged.a.list, base.a.list);
    assert.notEqual(merged.a.list[1], base.a.list[1]);
    assert.notEqual(merged.untouched, base.untouched);
    assert.notEqual(merged.b, override.b);
    assert.notEqual(merged.b.items, override.b.items);
    assert.notEqual(merged.b.items[0], override.b.items[0]);

    merged.a.list.push('new');
    merged.b.items[0].id = 'changed';
    assert.deepEqual(base.a.list, [1, { n: 2 }]);
    assert.equal(override.b.items[0].id, 'x');
  });

  test('ignores prototype-pollution keys at every depth', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":"top"},"safe":1,"nested":{"__proto__":{"polluted":"nested"},"ok":true},' +
        '"constructor":{"prototype":{"polluted":"ctor"}},"prototype":{"polluted":"proto"},' +
        '"list":[{"__proto__":{"polluted":"array"},"id":1}]}',
    );
    const merged = deepMerge({ nested: { base: 1 } }, hostile);

    assert.equal({}.polluted, undefined, 'Object.prototype must stay clean');
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(merged.polluted, undefined);
    assert.equal(merged.nested.polluted, undefined);
    assert.equal(merged.list[0].polluted, undefined);
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
    assert.equal(Object.getPrototypeOf(merged.nested), Object.prototype);
    assert.equal(Object.getPrototypeOf(merged.list[0]), Object.prototype);
    assert.equal(Object.hasOwn(merged, '__proto__'), false);
    assert.equal(Object.hasOwn(merged, 'constructor'), false);
    assert.equal(Object.hasOwn(merged, 'prototype'), false);
    assert.deepEqual(merged, { nested: { base: 1, ok: true }, safe: 1, list: [{ id: 1 }] });
  });

  test('drops prototype-pollution keys coming from the base too', () => {
    const base = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
    const merged = deepMerge(base, { b: 2 });
    assert.deepEqual(merged, { a: 1, b: 2 });
    assert.equal(merged.polluted, undefined);
  });

  test('passes non-plain objects through by reference', () => {
    const when = new Date(0);
    const merged = deepMerge({ when: { nested: true } }, { when });
    assert.equal(merged.when, when);
  });
});

describe('loadConfig', () => {
  test('with no skin returns the base config', async () => {
    assert.deepEqual(await loadConfig(''), liveConfig);
    assert.deepEqual(await loadConfig('?other=1'), liveConfig);
    assert.deepEqual(await loadConfig('?skin='), liveConfig);
  });

  test('works with no argument where there is no page location (Node)', async () => {
    assert.equal(typeof globalThis.location, 'undefined');
    assert.deepEqual(await loadConfig(), liveConfig);
  });

  test('returns an independent copy on every call', async () => {
    const before = structuredClone(liveConfig);
    const first = await loadConfig('');
    first.brand.name = `${first.brand.name} (changed)`;
    first.pricing.products.length = 0;
    first.text['welcome.title'] = 'Changed';

    const second = await loadConfig('');
    assert.notEqual(second, first);
    assert.equal(second.brand.name, before.brand.name);
    assert.ok(second.pricing.products.length > 0);
    assert.deepEqual(second.text, before.text);
    assert.deepEqual(liveConfig, before, 'the default export itself must not be touched');
  });

  test('with ?skin=acme merges the skin over the base', async (t) => {
    const warnings = captureWarnings(t);
    const config = await loadConfig('?skin=acme');

    assert.equal(warnings.callCount(), 0);
    assert.deepEqual(config, deepMerge(liveConfig, acmeSkin));

    // Overridden by the skin.
    assert.equal(config.brand.name, 'Acme Security Doors');
    assert.equal(config.brand.colors.primary, acmeSkin.brand.colors.primary);
    assert.equal(config.brand.radius, acmeSkin.brand.radius);
    assert.deepEqual(config.pricing.products, acmeSkin.pricing.products);
    assert.equal(config.text['welcome.title'], acmeSkin.text['welcome.title']);

    // Inherited untouched from the base.
    assert.equal(config.brand.fontFamily, liveConfig.brand.fontFamily);
    assert.equal(config.brand.colors.success, liveConfig.brand.colors.success);
    assert.deepEqual(config.measurement, liveConfig.measurement);
    assert.deepEqual(config.pricing.options, liveConfig.pricing.options);
    assert.deepEqual(config.pricing.limits, liveConfig.pricing.limits);
    assert.deepEqual(config.lead, liveConfig.lead);
    assert.deepEqual(config.embed, liveConfig.embed);
  });

  test('finds the skin among other query parameters', async () => {
    const config = await loadConfig('?utm_source=mail&skin=acme&x=1');
    assert.equal(config.brand.name, 'Acme Security Doors');
    const noQuestionMark = await loadConfig('skin=acme');
    assert.equal(noQuestionMark.brand.name, 'Acme Security Doors');
  });

  const invalidNames = {
    'a path traversal': '?skin=../x',
    'an encoded path traversal': '?skin=%2e%2e%2fx',
    'a traversal back to a real module': '?skin=../js/config',
    'upper case': '?skin=ACME',
    'an overly long name': `?skin=${'a'.repeat(41)}`,
    'a file extension': '?skin=acme.js',
    'a URL': '?skin=https://evil.example/skin',
    'a data URL': '?skin=data:text/javascript,export%20default%20{}',
    'a backslash path': '?skin=..%5Cx',
    'surrounding spaces': '?skin=%20acme%20',
    'a trailing newline': '?skin=acme%0A',
    'a null byte': '?skin=acme%00',
  };
  for (const [label, search] of Object.entries(invalidNames)) {
    test(`with ${label} warns and returns the base config`, async (t) => {
      const warnings = captureWarnings(t);
      const config = await loadConfig(search);
      assert.deepEqual(config, liveConfig);
      assert.equal(warnings.callCount(), 1);
      // The "invalid name" warning proves the name was rejected before any import was attempted.
      assert.match(warningText(warnings), /invalid skin name/i);
    });
  }

  test('accepts the longest allowed name shape (and falls back when the file is missing)', async (t) => {
    const warnings = captureWarnings(t);
    const config = await loadConfig(`?skin=${'a'.repeat(40)}`);
    assert.deepEqual(config, liveConfig);
    assert.equal(warnings.callCount(), 1);
    assert.match(warningText(warnings), /could not load skin/i);
  });

  test('with a missing skin warns and returns the base config', async (t) => {
    const warnings = captureWarnings(t);
    const config = await loadConfig('?skin=no-such-skin-9');
    assert.deepEqual(config, liveConfig);
    assert.equal(warnings.callCount(), 1);
    assert.match(warningText(warnings), /could not load skin "no-such-skin-9"/i);
  });

  test('tolerates a non-string argument', async () => {
    assert.deepEqual(await loadConfig(null), liveConfig);
    assert.deepEqual(await loadConfig(12345), liveConfig);
    const viaParams = await loadConfig(new URLSearchParams('skin=acme'));
    assert.equal(viaParams.brand.name, 'Acme Security Doors');
  });

  test('hands back the measuring settings normaliseConfig settles, with no warning for good ones', async (t) => {
    const warnings = captureWarnings(t);
    for (const search of ['', '?skin=acme']) {
      const { measurement } = await loadConfig(search);
      assert.deepEqual(Object.keys(measurement.methods).sort(), ['ar', 'camera', 'paper']);
      for (const value of Object.values(measurement.methods)) assert.equal(typeof value, 'boolean');
      assert.ok(Array.isArray(measurement.standardSizes) && measurement.standardSizes.length > 0);
    }
    assert.equal(warnings.callCount(), 0);
  });
});

/** A config with only the measuring settings under test, the rest as shipped. */
function withMeasurement(measurement) {
  const config = deepMerge(baseConfig, { measurement: {} });
  config.measurement = { ...config.measurement, ...measurement };
  return config;
}

const builtInSizes = () => DEFAULT_STANDARD_SIZES.map(({ widthMm, heightMm }) => ({ widthMm, heightMm }));

describe('measurementMethods', () => {
  test('every way in is on unless it is set to false', () => {
    assert.deepEqual(measurementMethods(withMeasurement({ methods: { ar: true, camera: true, paper: true } })), {
      ar: true,
      camera: true,
      paper: true,
    });
    assert.deepEqual(measurementMethods(withMeasurement({ methods: { ar: false } })), { ar: false, camera: true, paper: true });
    assert.deepEqual(measurementMethods(withMeasurement({ methods: { camera: false, paper: false } })), {
      ar: true,
      camera: false,
      paper: false,
    });
  });

  test('reads anything that is not true or false as on', () => {
    for (const methods of [undefined, null, 'none', [], 0, { ar: 'no', camera: 0, paper: null }]) {
      assert.deepEqual(measurementMethods(withMeasurement({ methods })), { ar: true, camera: true, paper: true }, JSON.stringify(methods));
    }
    assert.deepEqual(measurementMethods({}), { ar: true, camera: true, paper: true });
    assert.deepEqual(measurementMethods(undefined), { ar: true, camera: true, paper: true });
  });

  test('keeps paper on when nothing else would work on every phone and manual sizes are off', () => {
    const allOff = { ar: false, camera: false, paper: false };
    assert.deepEqual(measurementMethods(withMeasurement({ methods: allOff, allowManualOverride: false })), { ...allOff, paper: true });
    // AR alone is no way in on an iPhone.
    assert.deepEqual(measurementMethods(withMeasurement({ methods: { ...allOff, ar: true }, allowManualOverride: false })), {
      ar: true,
      camera: false,
      paper: true,
    });
    // A typed-in size is a way in: a company may run the app as a price calculator only.
    assert.deepEqual(measurementMethods(withMeasurement({ methods: allOff, allowManualOverride: true })), allOff);
  });
});

describe('normaliseConfig', () => {
  test('leaves good settings exactly as they are, without a warning', (t) => {
    const warnings = captureWarnings(t);
    const methods = { ar: false, camera: true, paper: true };
    const standardSizes = [
      { widthMm: 762, heightMm: 2032 },
      { widthMm: 813, heightMm: 2032 },
    ];
    const config = withMeasurement({ methods, standardSizes });
    const before = structuredClone(config);
    assert.equal(normaliseConfig(config), config, 'fixes in place and returns the same object');
    assert.deepEqual(config, before);
    assert.deepEqual(normaliseConfig(deepMerge(liveConfig, undefined)), liveConfig);
    assert.equal(warnings.callCount(), 0);
  });

  test('fills in missing settings quietly (a config from before they existed)', (t) => {
    const warnings = captureWarnings(t);
    const config = withMeasurement({});
    delete config.measurement.methods;
    delete config.measurement.standardSizes;
    normaliseConfig(config);
    assert.deepEqual(config.measurement.methods, { ar: true, camera: true, paper: true });
    assert.deepEqual(config.measurement.standardSizes, builtInSizes());
    assert.equal(Object.isFrozen(config.measurement.standardSizes[0]), false, 'a copy the app may change, not the frozen list');
    assert.equal(warnings.callCount(), 0);
  });

  test('turns malformed methods into the defaults, with a warning for each mistake', (t) => {
    const warnings = captureWarnings(t);
    const notAGroup = normaliseConfig(withMeasurement({ methods: 'camera' }));
    assert.deepEqual(notAGroup.measurement.methods, { ar: true, camera: true, paper: true });
    assert.equal(warnings.callCount(), 1);
    assert.match(warningText(warnings), /measurement\.methods/);

    const typos = normaliseConfig(withMeasurement({ methods: { ar: 'false', camara: false, paper: false } }));
    assert.deepEqual(typos.measurement.methods, { ar: true, camera: true, paper: false }, 'only known keys, as booleans');
    assert.equal(warnings.callCount(), 3);
    assert.match(warningText(warnings), /measurement\.methods\.ar should be true or false/);
    assert.match(warningText(warnings), /measurement\.methods\.camara is not a setting/);
  });

  test('says so when it has to keep paper on', (t) => {
    const warnings = captureWarnings(t);
    const config = normaliseConfig(
      withMeasurement({ methods: { ar: true, camera: false, paper: false }, allowManualOverride: false }),
    );
    assert.deepEqual(config.measurement.methods, { ar: true, camera: false, paper: true });
    assert.equal(warnings.callCount(), 1);
    assert.match(warningText(warnings), /keeping paper on/);
  });

  test('drops unusable and repeated standard sizes, keeping the good ones in order', (t) => {
    const warnings = captureWarnings(t);
    const config = normaliseConfig(
      withMeasurement({
        standardSizes: [
          { widthMm: 820, heightMm: 2040 },
          { widthMm: '870', heightMm: 2040 },
          null,
          { widthMm: 920 },
          { widthMm: -820, heightMm: 2040 },
          { widthMm: 820, heightMm: 20400000 },
          { widthMm: Number.NaN, heightMm: 2040 },
          { widthMm: 820, heightMm: 2040 },
          { widthMm: 920, heightMm: 2100 },
        ],
      }),
    );
    assert.deepEqual(config.measurement.standardSizes, [
      { widthMm: 820, heightMm: 2040 },
      { widthMm: 920, heightMm: 2100 },
    ]);
    assert.equal(warnings.callCount(), 7);
    assert.match(warningText(warnings), /standardSizes\[1\]/);
    assert.match(warningText(warnings), /820 x 2040 more than once/);
  });

  test('falls back to the built-in sizes when none is usable', (t) => {
    const warnings = captureWarnings(t);
    for (const standardSizes of [[], [{ w: 820, h: 2040 }], 'AU', { widthMm: 820, heightMm: 2040 }, null]) {
      const config = normaliseConfig(withMeasurement({ standardSizes }));
      assert.deepEqual(config.measurement.standardSizes, builtInSizes(), JSON.stringify(standardSizes));
    }
    assert.ok(warnings.callCount() >= 5, 'each one is reported');
    assert.match(warningText(warnings), /using the built-in sizes/);
  });

  test('copes with a config that has no measurement group at all', () => {
    assert.deepEqual(normaliseConfig({}), {});
    assert.equal(normaliseConfig(undefined), undefined);
    assert.deepEqual(normaliseConfig({ measurement: null }), { measurement: null });
  });
});

/** A minimal stand-in for <html> and its document: just what applyTheme touches. */
function fakeDom({ withMeta = true } = {}) {
  const makeElement = (tagName) => {
    const attributes = new Map();
    return {
      tagName,
      attributes,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: (name) => attributes.get(name) ?? null,
    };
  };

  const head = {
    children: [],
    appendChild(element) {
      this.children.push(element);
      return element;
    },
  };
  if (withMeta) {
    const meta = makeElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#000000');
    head.appendChild(meta);
  }

  const doc = {
    title: 'Loading',
    head,
    createElement: makeElement,
    querySelector(selector) {
      assert.equal(selector, 'meta[name="theme-color"]');
      return head.children.find((el) => el.tagName === 'meta' && el.getAttribute('name') === 'theme-color') ?? null;
    },
  };

  const properties = new Map();
  const root = {
    ownerDocument: doc,
    style: { setProperty: (name, value) => properties.set(name, value) },
  };
  return { root, doc, head, properties };
}

describe('applyTheme', () => {
  test('sets all 14 custom properties from the default config', () => {
    const { root, properties } = fakeDom();
    applyTheme(baseConfig, root);

    assert.deepEqual([...properties.keys()].sort(), [...THEME_PROPERTIES].sort());
    const { colors, radius, fontFamily } = baseConfig.brand;
    assert.deepEqual(Object.fromEntries(properties), {
      '--sm-primary': colors.primary,
      '--sm-primary-contrast': colors.primaryContrast,
      '--sm-accent': colors.accent,
      '--sm-accent-contrast': colors.accentContrast,
      '--sm-bg': colors.background,
      '--sm-surface': colors.surface,
      '--sm-text': colors.text,
      '--sm-muted': colors.muted,
      '--sm-border': colors.border,
      '--sm-success': colors.success,
      '--sm-warning': colors.warning,
      '--sm-danger': colors.danger,
      '--sm-radius': radius,
      '--sm-font': fontFamily,
    });
    for (const value of properties.values()) {
      assert.equal(typeof value, 'string');
      assert.notEqual(value, '');
    }
  });

  test('sets all 14 custom properties from the acme-skinned config', () => {
    const config = deepMerge(baseConfig, acmeSkin);
    const { root, properties } = fakeDom();
    applyTheme(config, root);

    assert.equal(properties.size, 14);
    for (const name of THEME_PROPERTIES) assert.ok(properties.has(name), `${name} was not set`);
    assert.equal(properties.get('--sm-primary'), acmeSkin.brand.colors.primary);
    assert.equal(properties.get('--sm-accent'), acmeSkin.brand.colors.accent);
    assert.equal(properties.get('--sm-accent-contrast'), acmeSkin.brand.colors.accentContrast);
    assert.equal(properties.get('--sm-radius'), acmeSkin.brand.radius);
    assert.equal(properties.get('--sm-success'), baseConfig.brand.colors.success);
  });

  test('writes every brand setting in js/config.js as it stands: none is skipped as not valid', (t) => {
    // The one applyTheme test that reads js/config.js. It pins no colour: it only checks that each of the
    // 14 settings is usable. (A primary colour too light to read as text is allowed: that is handled, with
    // a console warning, and adds --sm-ink-primary.)
    captureWarnings(t);
    const { root, properties } = fakeDom();
    applyTheme(liveConfig, root);
    for (const name of THEME_PROPERTIES) {
      assert.ok(properties.has(name), `${name} was not set: the matching brand setting in js/config.js is missing or not valid`);
    }
  });

  test('sets the document title from the brand', () => {
    const { root, doc } = fakeDom();
    applyTheme(baseConfig, root);
    assert.ok(doc.title.startsWith(baseConfig.brand.name));
    assert.ok(doc.title.includes(baseConfig.brand.tagline));

    const noTagline = fakeDom();
    applyTheme(deepMerge(baseConfig, { brand: { name: 'Acme', tagline: '' } }), noTagline.root);
    assert.equal(noTagline.doc.title, 'Acme');
  });

  test('updates an existing theme-color meta tag', () => {
    const { root, head } = fakeDom();
    applyTheme(baseConfig, root);
    assert.equal(head.children.length, 1);
    assert.equal(head.children[0].getAttribute('content'), baseConfig.brand.colors.primary);
  });

  test('creates the theme-color meta tag when the page has none', () => {
    const { root, head } = fakeDom({ withMeta: false });
    applyTheme(baseConfig, root);
    assert.equal(head.children.length, 1);
    assert.equal(head.children[0].tagName, 'meta');
    assert.equal(head.children[0].getAttribute('name'), 'theme-color');
    assert.equal(head.children[0].getAttribute('content'), baseConfig.brand.colors.primary);
  });

  test('skips a malformed setting with a warning instead of writing it', (t) => {
    const warnings = captureWarnings(t);
    const { root, properties, head } = fakeDom();
    const broken = deepMerge(baseConfig, {
      brand: { colors: { accent: 'orange; background: url(//evil.example)', primary: '#12345' }, radius: 'big', fontFamily: '' },
    });
    applyTheme(broken, root);

    for (const name of ['--sm-accent', '--sm-primary', '--sm-radius', '--sm-font']) {
      assert.equal(properties.has(name), false, `${name} should have been skipped`);
    }
    assert.equal(properties.size, 10);
    assert.equal(warnings.callCount(), 4);
    assert.match(warningText(warnings), /brand\.colors\.accent/);
    assert.match(warningText(warnings), /brand\.radius/);
    assert.equal(head.children[0].getAttribute('content'), '#000000', 'an invalid primary must not reach theme-color');
  });

  test('reads a bare number radius as pixels', () => {
    const numeric = fakeDom();
    applyTheme(deepMerge(baseConfig, { brand: { radius: 8 } }), numeric.root);
    assert.equal(numeric.properties.get('--sm-radius'), '8px');

    const bareString = fakeDom();
    applyTheme(deepMerge(baseConfig, { brand: { radius: '10' } }), bareString.root);
    assert.equal(bareString.properties.get('--sm-radius'), '10px');

    const rem = fakeDom();
    applyTheme(deepMerge(baseConfig, { brand: { radius: '0.75rem' } }), rem.root);
    assert.equal(rem.properties.get('--sm-radius'), '0.75rem');
  });

  test('a primary colour too light to read as text hands its labels to the text colour', (t) => {
    const warnings = captureWarnings(t);
    const { root, properties } = fakeDom();
    applyTheme(deepMerge(baseConfig, { brand: { colors: { primary: '#ffd400', primaryContrast: '#111111' } } }), root);
    assert.equal(properties.get('--sm-primary'), '#ffd400', 'fills and borders keep the brand colour');
    assert.equal(properties.get('--sm-ink-primary'), baseConfig.brand.colors.text);
    assert.equal(properties.size, 15);
    assert.equal(warnings.callCount(), 1);
    assert.match(warningText(warnings), /brand\.colors\.primary/);
  });

  test('a light primary on a dark page is readable, so it is left alone', (t) => {
    const warnings = captureWarnings(t);
    const { root, properties } = fakeDom();
    const dark = { primary: '#ffd400', primaryContrast: '#111111', surface: '#1b1b1f', background: '#101014', text: '#f5f5f5' };
    applyTheme(deepMerge(baseConfig, { brand: { colors: dark } }), root);
    assert.equal(properties.has('--sm-ink-primary'), false);
    assert.equal(properties.size, 14);
    assert.equal(warnings.callCount(), 0);
  });

  /** fakeDom, with a root that keeps attributes the way <html> does. It starts with the language index.html declares. */
  function fakeDomWithLang() {
    const dom = fakeDom();
    const attributes = new Map([['lang', 'en-AU']]);
    dom.root.setAttribute = (name, value) => attributes.set(name, String(value));
    return { ...dom, attributes };
  }

  test('sets the page language from brand.lang', (t) => {
    const warnings = captureWarnings(t);
    for (const [lang, expected] of [[baseConfig.brand.lang, baseConfig.brand.lang], ['de', 'de'], [' fr-CA ', 'fr-CA'], ['zh-Hant-TW', 'zh-Hant-TW']]) {
      const { root, attributes, properties } = fakeDomWithLang();
      applyTheme(deepMerge(baseConfig, { brand: { lang } }), root);
      assert.equal(attributes.get('lang'), expected);
      assert.equal(properties.size, 14, 'the language is an attribute, not a custom property');
    }
    assert.equal(warnings.callCount(), 0);
  });

  test('keeps the page language when brand.lang is missing, and warns when it is not a language tag', (t) => {
    const warnings = captureWarnings(t);
    for (const lang of ['', null]) {
      const { root, attributes } = fakeDomWithLang();
      applyTheme(deepMerge(baseConfig, { brand: { lang } }), root);
      assert.equal(attributes.get('lang'), 'en-AU');
    }
    assert.equal(warnings.callCount(), 0, 'not set is not a mistake');

    for (const lang of ['English', 'en_AU', 'de"><script>', 42]) {
      const { root, attributes } = fakeDomWithLang();
      applyTheme(deepMerge(baseConfig, { brand: { lang } }), root);
      assert.equal(attributes.get('lang'), 'en-AU', `${JSON.stringify(lang)} must not reach the page`);
    }
    assert.equal(warnings.callCount(), 4);
    assert.match(warningText(warnings), /brand\.lang/);
  });

  test('copes with a root that has no document, and with a missing config', (t) => {
    captureWarnings(t);
    const properties = new Map();
    const bareRoot = { style: { setProperty: (name, value) => properties.set(name, value) } };
    assert.doesNotThrow(() => applyTheme(baseConfig, bareRoot));
    assert.equal(properties.size, 14);

    const { root, doc, properties: none } = fakeDom();
    assert.doesNotThrow(() => applyTheme({}, root));
    assert.doesNotThrow(() => applyTheme(undefined, root));
    assert.equal(none.size, 0);
    assert.equal(doc.title, 'Loading');

    assert.doesNotThrow(() => applyTheme(baseConfig), 'no document at all (Node) must not throw');
  });
});
