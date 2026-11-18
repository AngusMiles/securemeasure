/**
 * Welcome screen: the promise, what the customer needs, and the three ways in
 * (measure from a photo, try the demo photo, or type in a size they already know).
 */
import { loadPhoto, setPhoto } from '../photo.js';

/** Screen id used for routing and for the `sm-screen--welcome` class. */
export const id = 'welcome';

/** Progress step this screen belongs to. */
export const step = 1;

/** Default copy for this screen; any key can be overridden through `config.text`. */
export const strings = {
  'welcome.title': 'Measure your door in 2 minutes',
  'welcome.subtitle': 'One photo gets you an instant price. No home visit needed to get started.',
  'welcome.need.title': "What you'll need",
  'welcome.need.paper': 'A sheet of {paper}',
  'welcome.need.paper.fallback': 'A4 paper',
  'welcome.need.paper.detail': 'Any plain sheet. It gives your photo its scale.',
  'welcome.need.tape': 'Tape or Blu Tack',
  'welcome.need.tape.detail': 'To hold the sheet flat on your door.',
  'welcome.need.phone': 'Your phone',
  'welcome.need.phone.detail': 'One photo of the whole door does it.',
  'welcome.how.title': 'How it works',
  'welcome.how.photo': 'Take a photo',
  'welcome.how.mark': 'Mark the corners',
  'welcome.how.price': 'See your price',
  'welcome.privacy': 'Your photo stays on your phone unless you send us an enquiry.',
  'welcome.start': 'Start measuring',
  'welcome.demo': 'Try it with a demo photo',
  'welcome.demo.loading': 'Loading the demo photo…',
  'welcome.demo.error': "Sorry, we couldn't load the demo photo. Please try again.",
  'welcome.manual': 'I already know my door size',
};

// The icon kit has no price glyph, so the third "how it works" step uses this static one.
const ICON_PRICE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M3 4.5V11a2 2 0 0 0 .6 1.4l8 8a2 2 0 0 0 2.8 0l6-6a2 2 0 0 0 0-2.8l-8-8A2 2 0 0 0 11 3H4.5A1.5 1.5 0 0 0 3 4.5z"/>' +
  '<circle cx="7.5" cy="7.5" r="1"/>' +
  '</svg>';

// The bundled demo photo shows an A4 sheet, whatever reference the customer picked earlier.
const DEMO_SHEET_MM = { short: 210, long: 297 };

/**
 * The welcome screen can always be entered.
 * @returns {boolean}
 */
export function canEnter() {
  return true;
}

/**
 * Build the welcome screen.
 *
 * @param {HTMLElement} root  the empty <section> for this screen
 * @param {object} ctx        app context (config, state, t, go, busy, toast, ui)
 * @returns {() => void} cleanup
 */
export function mount(root, ctx) {
  const { ui, config } = ctx;
  const { h } = ui;
  const t = (key, vars) => ctx.t(key, vars);
  const brand = config.brand || {};
  const measurement = config.measurement || {};

  let alive = true;
  let loading = false;

  const header = ui.screenHeader({
    eyebrow: brand.tagline || undefined,
    title: t('welcome.title'),
    subtitle: t('welcome.subtitle'),
  });

  const paper = defaultReferenceLabel(measurement) || t('welcome.need.paper.fallback');
  const needs = [
    { icon: 'paper', title: t('welcome.need.paper', { paper }), detail: t('welcome.need.paper.detail') },
    { icon: 'tape', title: t('welcome.need.tape'), detail: t('welcome.need.tape.detail') },
    { icon: 'phone', title: t('welcome.need.phone'), detail: t('welcome.need.phone.detail') },
  ];
  const needsCard = ui.card(
    { class: 'sm-welcome__needs' },
    h(
      'div',
      { class: 'sm-stack' },
      h('h2', { class: 'sm-welcome__heading', text: t('welcome.need.title') }),
      h(
        'ul',
        { class: 'sm-welcome__list', attrs: { role: 'list' } },
        needs.map((need) =>
          h(
            'li',
            { class: 'sm-welcome__item' },
            h('span', { class: 'sm-welcome__tile' }, ui.icon(need.icon, 22)),
            h(
              'div',
              { class: 'sm-welcome__item-text' },
              h('p', { class: 'sm-welcome__item-title', text: need.title }),
              h('p', { class: 'sm-welcome__item-detail', text: need.detail }),
            ),
          ),
        ),
      ),
    ),
  );

  const howSteps = [
    { glyph: ui.icon('camera', 22), label: t('welcome.how.photo') },
    { glyph: ui.icon('ruler', 22), label: t('welcome.how.mark') },
    { glyph: ui.svgFromString(ICON_PRICE), label: t('welcome.how.price') },
  ];
  const how = h(
    'section',
    { class: 'sm-welcome__how', attrs: { 'aria-labelledby': 'sm-welcome-how-title' } },
    h('h2', { class: 'sm-welcome__heading', id: 'sm-welcome-how-title', text: t('welcome.how.title') }),
    h(
      'ol',
      { class: 'sm-welcome__steps', attrs: { role: 'list' } },
      howSteps.map((item, index) =>
        h(
          'li',
          { class: 'sm-welcome__step' },
          h(
            'span',
            { class: 'sm-welcome__step-icon' },
            item.glyph,
            h('span', { class: 'sm-welcome__step-num sm-num', text: String(index + 1), attrs: { 'aria-hidden': 'true' } }),
          ),
          h('span', { class: 'sm-welcome__step-label', text: item.label }),
        ),
      ),
    ),
  );

  const privacy = h(
    'p',
    { class: 'sm-welcome__privacy' },
    ui.icon('lock', 18),
    h('span', { text: t('welcome.privacy') }),
  );

  async function startDemo() {
    if (loading) return;
    loading = true;
    try {
      const photo = await ctx.busy(
        () => loadPhoto(measurement.demoPhotoUrl, config, { isDemo: true }),
        t('welcome.demo.loading'),
      );
      if (!alive) return;
      const state = ctx.state;
      setPhoto(state, photo);
      selectDemoReference(state, measurement);
      ctx.go('sheet');
    } catch {
      if (alive) ctx.toast(t('welcome.demo.error'), { type: 'error' });
    } finally {
      loading = false;
    }
  }

  function startManual() {
    ctx.state.manualEntry = true;
    ctx.go('result');
  }

  const actions = [
    ui.button(t('welcome.start'), {
      variant: 'primary',
      size: 'lg',
      iconEnd: 'arrow-right',
      onClick: () => ctx.go('prepare'),
    }),
  ];
  if (measurement.demoPhotoUrl) {
    actions.push(ui.button(t('welcome.demo'), { variant: 'secondary', icon: 'image', onClick: startDemo }));
  }
  // A company that turns manual sizes off wants photo-backed measurements only.
  if (measurement.allowManualOverride !== false) {
    actions.push(ui.button(t('welcome.manual'), { variant: 'ghost', size: 'sm', onClick: startManual }));
  }

  root.append(header, needsCard, how, privacy, ui.actionBar(...actions));

  return () => {
    alive = false;
  };
}

/**
 * Label of the reference sheet the customer will be asked for by default.
 * @param {object} measurement  config.measurement
 * @returns {string}
 */
function defaultReferenceLabel(measurement) {
  const references = Array.isArray(measurement.references) ? measurement.references : [];
  const reference = references.find((ref) => ref.id === measurement.defaultReferenceId) || references[0];
  return reference && reference.label ? String(reference.label) : '';
}

/**
 * Point the state at an A4 reference so the demo photo measures correctly even if the customer
 * had chosen another sheet (or the company's default is not A4).
 *
 * @param {object} state        shared app state (mutated)
 * @param {object} measurement  config.measurement
 */
function selectDemoReference(state, measurement) {
  const references = Array.isArray(measurement.references) ? measurement.references : [];
  const a4 = references.find(
    (ref) =>
      Math.min(ref.widthMm, ref.heightMm) === DEMO_SHEET_MM.short &&
      Math.max(ref.widthMm, ref.heightMm) === DEMO_SHEET_MM.long,
  );
  if (a4) {
    state.referenceId = a4.id;
  } else {
    state.referenceId = 'custom';
    state.customReference = { widthMm: DEMO_SHEET_MM.short, heightMm: DEMO_SHEET_MM.long };
  }
}
