/**
 * Welcome screen: the promise, what the customer needs, and the ways in, best first:
 *   1. Measure with AR (Android phones with ARCore only, added once the phone has said it can),
 *   2. Measure with my camera (one photo, matched to the nearest standard door size),
 *   3. Try it with a demo photo,
 *   4. Measure exactly with a sheet of paper,
 *   5. I already know my door size.
 * The company switches any of the photo ways off with config.measurement.methods.
 */
import { arSupported } from '../ar-support.js';
import { demoPhotoUrl, loadDemo } from '../demo.js';
import { findDoor } from '../door-find.js';
import { measurementMethods } from '../theme.js';

/** Screen id used for routing and for the `sm-screen--welcome` class. */
export const id = 'welcome';

/** Progress step this screen belongs to. */
export const step = 1;

/** Default copy for this screen; any key can be overridden through `config.text`. */
export const strings = {
  'welcome.title': 'Measure your door in a minute',
  'welcome.subtitle': 'Point your phone at your door for an instant price. No tape measure, no paper.',
  'welcome.need.title': "What you'll need",
  'welcome.need.justPhone': 'Just your phone',
  'welcome.need.justPhone.detail': 'Nothing to print, tape up or hold against the door.',
  'welcome.need.view': 'A clear view of the whole door',
  'welcome.need.view.detail': 'Stand back far enough to fit the whole frame in, top to bottom.',
  'welcome.need.light': 'Good light',
  'welcome.need.light.detail': 'Daylight or the lights on, so the edges of the door are easy to see.',
  'welcome.how.title': 'How it works',
  'welcome.how.camera': 'Allow camera',
  'welcome.how.snap': 'Snap your door',
  'welcome.how.price': 'See your price',
  'welcome.standardNote':
    'We match your door to the nearest standard size. We confirm the exact size with a check measure before your door is made.',
  'welcome.privacy': 'Your photo stays on your phone unless you send us an enquiry.',
  'welcome.ar': 'Measure with AR',
  'welcome.camera': 'Measure with my camera',
  'welcome.demo': 'Try it with a demo photo',
  'welcome.demo.loading': 'Loading the demo photo…',
  'welcome.demo.error': "Sorry, we couldn't load the demo photo. Please try again.",
  'welcome.paper': 'Measure exactly with a sheet of paper',
  'welcome.start': 'Start measuring',
  'welcome.manual': 'I already know my door size',
  // The paper method's own copy, shown instead of the no-paper copy above when the company has
  // switched the camera method off (config.measurement.methods.camera: false).
  'welcome.paperOnly.title': 'Measure your door in 2 minutes',
  'welcome.paperOnly.subtitle': 'One photo gets you an instant price. No home visit needed to get started.',
  'welcome.need.paper': 'A sheet of {paper}',
  'welcome.need.paper.fallback': 'A4 paper',
  'welcome.need.paper.detail': 'Any plain sheet. It gives your photo its scale.',
  'welcome.need.tape': 'Tape or Blu Tack',
  'welcome.need.tape.detail': 'To hold the sheet flat on your door, at the corners only.',
  'welcome.need.phone': 'Your phone',
  'welcome.need.phone.detail': 'One photo of the whole door does it.',
  'welcome.how.photo': 'Take a photo',
  'welcome.how.mark': 'Mark the corners',
};

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" class="sm-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

// The icon kit has no price, light or AR glyph, so those three are static ones drawn here.
const ICON_PRICE =
  SVG_OPEN +
  '<path d="M3 4.5V11a2 2 0 0 0 .6 1.4l8 8a2 2 0 0 0 2.8 0l6-6a2 2 0 0 0 0-2.8l-8-8A2 2 0 0 0 11 3H4.5A1.5 1.5 0 0 0 3 4.5z"/>' +
  '<circle cx="7.5" cy="7.5" r="1"/>' +
  '</svg>';

const ICON_LIGHT =
  SVG_OPEN +
  '<circle cx="12" cy="12" r="4"/>' +
  '<path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>' +
  '</svg>';

// A cube inside a viewfinder: the phone placing something in the room.
const ICON_AR =
  SVG_OPEN +
  '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>' +
  '<path d="M12 7l4.5 2.5v5L12 17l-4.5-2.5v-5L12 7z"/>' +
  '<path d="M7.5 9.5L12 12l4.5-2.5M12 12v5"/>' +
  '</svg>';

/** Button sizes the kit draws each icon at (js/ui.js), for a button restyled after it was built. */
const ICON_PX = { sm: 18, md: 20, lg: 22 };

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
  const methods = measurementMethods(config);

  let alive = true;
  let loading = false;

  // Without the camera method the photo way most customers see is the paper one, and the no-paper
  // promise ("no tape measure, no paper") would not be true: the screen keeps the paper method's copy.
  const paperCopy = !methods.camera && methods.paper;

  const header = ui.screenHeader({
    eyebrow: brand.tagline || undefined,
    title: t(paperCopy ? 'welcome.paperOnly.title' : 'welcome.title'),
    subtitle: t(paperCopy ? 'welcome.paperOnly.subtitle' : 'welcome.subtitle'),
  });

  // ---- What you'll need ----------------------------------------------------------------------

  const paper = defaultReferenceLabel(measurement) || t('welcome.need.paper.fallback');
  const needs = paperCopy
    ? [
        { glyph: ui.icon('paper', 22), title: t('welcome.need.paper', { paper }), detail: t('welcome.need.paper.detail') },
        { glyph: ui.icon('tape', 22), title: t('welcome.need.tape'), detail: t('welcome.need.tape.detail') },
        { glyph: ui.icon('phone', 22), title: t('welcome.need.phone'), detail: t('welcome.need.phone.detail') },
      ]
    : [
        { glyph: ui.icon('phone', 22), title: t('welcome.need.justPhone'), detail: t('welcome.need.justPhone.detail') },
        { glyph: ui.icon('fit', 22), title: t('welcome.need.view'), detail: t('welcome.need.view.detail') },
        { glyph: ui.svgFromString(ICON_LIGHT), title: t('welcome.need.light'), detail: t('welcome.need.light.detail') },
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
            h('span', { class: 'sm-welcome__tile' }, need.glyph),
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

  // ---- How it works --------------------------------------------------------------------------

  const howSteps = paperCopy
    ? [
        { glyph: ui.icon('camera', 22), label: t('welcome.how.photo') },
        { glyph: ui.icon('ruler', 22), label: t('welcome.how.mark') },
        { glyph: ui.svgFromString(ICON_PRICE), label: t('welcome.how.price') },
      ]
    : [
        { glyph: ui.icon('camera', 22), label: t('welcome.how.camera') },
        { glyph: ui.icon('door', 22), label: t('welcome.how.snap') },
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

  // ---- The small print -----------------------------------------------------------------------

  // A photo with no scale in it cannot give raw millimetres, and AR is an estimate too: say up front
  // what the customer gets, so the result screen holds no surprise.
  const standardNote = paperCopy
    ? null
    : h('p', { class: 'sm-welcome__note sm-welcome__note--standard' }, ui.icon('info', 18), h('span', { text: t('welcome.standardNote') }));
  const privacy = h(
    'p',
    { class: 'sm-welcome__note sm-welcome__note--privacy' },
    ui.icon('lock', 18),
    h('span', { text: t('welcome.privacy') }),
  );

  // ---- The ways in ---------------------------------------------------------------------------

  // The demo shows the way most customers will use: the no-paper photo, or paper when that is off.
  const demoMethod = methods.camera ? 'estimate' : methods.paper ? 'paper' : null;

  async function startDemo() {
    if (loading) return;
    loading = true;
    try {
      // One wait for the customer: the photo, then the door in it, under the same overlay.
      await ctx.busy(async () => {
        const photo = await loadDemo(ctx, { method: demoMethod, isCurrent: () => alive });
        if (demoMethod !== 'estimate') return;
        // The door screen starts its corner handles from this (findDoor never throws).
        const detection = await findDoor(photo);
        if (ctx.state.photo === photo) ctx.state.door.detection = detection;
      }, t('welcome.demo.loading'));
      if (!alive) return;
      ctx.go(demoMethod === 'paper' ? 'sheet' : 'door');
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

  const cameraButton = methods.camera
    ? ui.button(t('welcome.camera'), { variant: 'primary', size: 'lg', icon: 'camera', onClick: () => ctx.go('capture') })
    : null;
  // With neither the camera nor AR on offer, the paper method is the way in, as it always was.
  const paperPrimary =
    methods.paper && !methods.camera
      ? ui.button(t('welcome.start'), { variant: 'primary', size: 'lg', iconEnd: 'arrow-right', onClick: () => ctx.go('prepare') })
      : null;
  const paperAlternative = methods.paper
    ? ui.button(t('welcome.paper'), { variant: 'ghost', size: 'sm', onClick: () => ctx.go('prepare') })
    : null;
  const demoButton =
    demoMethod && demoPhotoUrl(config)
      ? ui.button(t('welcome.demo'), { variant: 'secondary', icon: 'image', onClick: startDemo })
      : null;
  // A company that turns manual sizes off wants photo-backed measurements only.
  const manualButton =
    measurement.allowManualOverride !== false
      ? ui.button(t('welcome.manual'), { variant: 'ghost', size: 'sm', onClick: startManual })
      : null;

  const bar = ui.actionBar(
    cameraButton,
    paperPrimary,
    demoButton,
    paperPrimary ? null : paperAlternative,
    manualButton,
  );
  bar.classList.add('sm-welcome__actions');

  root.append(header, needsCard, how, standardNote, privacy, bar);

  // ---- AR, on the phones that have it --------------------------------------------------------

  // Only Android Chrome with ARCore can do it, and asking takes a moment, so the button joins the bar
  // when the answer comes in. It goes on top: the bar is pinned to the bottom of the screen and grows
  // upwards, so no button the customer may be reaching for moves. The button that was the main one
  // becomes a plain one in place (the same element, so keyboard focus stays where it was).
  function showAr() {
    if (!alive || bar.querySelector('.sm-welcome__ar')) return;
    const arButton = ui.button(t('welcome.ar'), { variant: 'primary', size: 'lg', onClick: () => ctx.go('ar') });
    arButton.classList.add('sm-welcome__ar');
    arButton.prepend(ui.svgFromString(ICON_AR));
    bar.prepend(arButton);

    if (cameraButton) {
      restyle(cameraButton, 'secondary', 'md');
    } else if (paperPrimary && paperAlternative) {
      // "Start measuring" would now be ambiguous next to AR: the paper way becomes the quiet
      // alternative, in its usual place under the demo.
      const hadFocus = root.ownerDocument.activeElement === paperPrimary;
      bar.insertBefore(paperAlternative, manualButton && manualButton.parentNode === bar ? manualButton : null);
      paperPrimary.remove();
      if (hadFocus) paperAlternative.focus({ preventScroll: true });
    }
  }

  if (methods.ar) {
    // arSupported() never rejects, and caches its answer; the catch is only for an AR module that
    // fails in a way nobody planned for, which must never cost the customer the other ways in.
    Promise.resolve()
      .then(() => arSupported())
      .then((supported) => {
        if (supported === true) showAr();
      })
      .catch(() => {});
  }

  return () => {
    alive = false;
  };
}

/**
 * Give a kit button another variant and size in place, so its listeners and any focus stay.
 * @param {HTMLElement} button  a button made by ui.button
 * @param {'primary'|'secondary'|'ghost'} variant
 * @param {'sm'|'md'|'lg'} size
 */
function restyle(button, variant, size) {
  for (const name of Array.from(button.classList)) {
    if (/^sm-btn--(primary|secondary|ghost|danger|sm|md|lg)$/.test(name)) button.classList.remove(name);
  }
  button.classList.add(`sm-btn--${variant}`, `sm-btn--${size}`);
  for (const glyph of Array.from(button.querySelectorAll('.sm-icon'))) {
    glyph.setAttribute('width', String(ICON_PX[size]));
    glyph.setAttribute('height', String(ICON_PX[size]));
  }
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
