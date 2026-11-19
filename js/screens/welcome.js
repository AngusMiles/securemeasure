/**
 * Welcome screen: the promise, what the customer needs, and the ways in, best first:
 *   1. Measure with AR (Android phones with ARCore only, added once the phone has said it can),
 *   2. Measure with my camera (one photo, matched to the nearest standard door size),
 *   3. Try it with a demo photo,
 *   4. Measure exactly with a sheet of paper,
 *   5. I already know my door size.
 * The company switches any of the photo ways off with config.measurement.methods. With neither the
 * camera nor the paper method on, typing in a size is the main way in, and the copy promises no photo.
 */
import { arRefused, arSupported } from '../ar-support.js';
import { demoPhotoUrl, dropDemoMeasure, loadDemo } from '../demo.js';
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
  // Only the camera way is matched to a standard size: AR keeps its own reading unless the customer
  // picks the standard one, and the paper method measures exactly. So the match is promised for the
  // camera alone, and the check measure, which every way in gets, for all of them.
  'welcome.standardNote':
    'Measure with your camera and we match your door to the nearest standard size. We confirm the exact size with a check measure before your door is made.',
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
  // The copy for a company that offers neither photo way (methods.camera and methods.paper both false):
  // most phones, every iPhone among them, can then only type in a size, so the screen promises no photo.
  'welcome.manualOnly.title': 'Get your door price in a minute',
  'welcome.manualOnly.subtitle': 'Enter your door size for an instant price. No home visit needed to get started.',
  'welcome.need.tapeMeasure': 'A tape measure',
  'welcome.need.tapeMeasure.detail': 'To measure the door opening, where the door meets the frame.',
  'welcome.need.size': 'The width and height',
  'welcome.need.size.detail': 'In millimetres. If you already know your door size, you are all set.',
  'welcome.how.measure': 'Measure your door',
  'welcome.how.enter': 'Enter the size',
  'welcome.enterSize': 'Enter my door size',
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
  // With neither photo way on, a typed-in size is the way in on most phones: AR, where the company
  // offers it, only ever appears on some Android phones (see showAr below). The screen then promises
  // no photo, and typing in a size is the main button. (measurementMethods keeps paper on when manual
  // sizes are off too, so this screen always has the manual button.)
  const manualCopy = !methods.camera && !methods.paper;
  const copyKey = (key) => (manualCopy ? `welcome.manualOnly.${key}` : paperCopy ? `welcome.paperOnly.${key}` : `welcome.${key}`);

  const header = ui.screenHeader({
    eyebrow: brand.tagline || undefined,
    title: t(copyKey('title')),
    subtitle: t(copyKey('subtitle')),
  });

  // ---- What you'll need ----------------------------------------------------------------------

  const paper = defaultReferenceLabel(measurement) || t('welcome.need.paper.fallback');
  const needs = manualCopy
    ? [
        { glyph: ui.icon('tape', 22), title: t('welcome.need.tapeMeasure'), detail: t('welcome.need.tapeMeasure.detail') },
        { glyph: ui.icon('edit', 22), title: t('welcome.need.size'), detail: t('welcome.need.size.detail') },
      ]
    : paperCopy
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

  const howSteps = manualCopy
    ? [
        { glyph: ui.icon('ruler', 22), label: t('welcome.how.measure') },
        { glyph: ui.icon('edit', 22), label: t('welcome.how.enter') },
        { glyph: ui.svgFromString(ICON_PRICE), label: t('welcome.how.price') },
      ]
    : paperCopy
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

  // A photo with no scale in it cannot give raw millimetres: say up front what the camera customer
  // gets, so the result screen holds no surprise. The note sits above every way in on offer (AR goes on
  // top of it on some Android phones, the exact paper method under it), so its wording promises the
  // standard size for the camera way only. A typed-in size is matched to nothing and there is no photo
  // to keep private, so neither note belongs on the manual-entry copy.
  const standardNote =
    paperCopy || manualCopy
      ? null
      : h('p', { class: 'sm-welcome__note sm-welcome__note--standard' }, ui.icon('info', 18), h('span', { text: t('welcome.standardNote') }));
  const privacy = manualCopy
    ? null
    : h('p', { class: 'sm-welcome__note sm-welcome__note--privacy' }, ui.icon('lock', 18), h('span', { text: t('welcome.privacy') }));

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
    // A size left over from the demo is the demo door's, and the result screen would show it ahead of
    // the size form: a customer who has said they know their own size gets the form (dropDemoMeasure).
    dropDemoMeasure(ctx.state);
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
  // A company that turns manual sizes off wants photo-backed measurements only. With no photo way on
  // offer, typing in a size is the way in, so it is the main button, worded for it.
  const manualButton =
    measurement.allowManualOverride === false
      ? null
      : manualCopy
      ? ui.button(t('welcome.enterSize'), { variant: 'primary', size: 'lg', iconEnd: 'arrow-right', onClick: startManual })
      : ui.button(t('welcome.manual'), { variant: 'ghost', size: 'sm', onClick: startManual });

  const bar = ui.actionBar(
    cameraButton,
    paperPrimary,
    demoButton,
    paperPrimary ? null : paperAlternative,
    manualButton,
  );
  bar.classList.add('sm-welcome__actions');

  // Element.append() writes a null as the text "null", so the notes left out are dropped first.
  root.append(...[header, needsCard, how, standardNote, privacy, bar].filter(Boolean));

  // ---- AR, on the phones that have it --------------------------------------------------------

  // Only Android Chrome with ARCore can do it, and asking takes a moment, so the button joins the bar
  // when the answer comes in. It goes on top: the bar is pinned to the bottom of the screen and grows
  // upwards, so no button the customer may be reaching for moves. The button that was the main one
  // becomes a plain one in place (the same element, so keyboard focus stays where it was).
  // Once AR has been refused on this page (arRefused: the phone said yes, then would not start a session),
  // it goes second instead, under the main way in, which keeps its look: the customer has just been sent
  // back from AR, and AR stays on offer only because the refusal may have been a prompt dismissed by
  // mistake.
  function showAr() {
    if (!alive || bar.querySelector('.sm-welcome__ar')) return;
    if (arRefused()) {
      const retry = ui.button(t('welcome.ar'), { variant: 'secondary', size: 'md', onClick: () => ctx.go('ar') });
      retry.classList.add('sm-welcome__ar');
      const glyph = ui.svgFromString(ICON_AR);
      // Drawn at the size the kit uses for this button's size, like any other icon on it.
      glyph.setAttribute('width', String(ICON_PX.md));
      glyph.setAttribute('height', String(ICON_PX.md));
      retry.prepend(glyph);
      const main = cameraButton || paperPrimary || (manualCopy ? manualButton : null);
      bar.insertBefore(retry, main && main.parentNode === bar ? main.nextSibling : bar.firstChild);
      return;
    }
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
    } else if (manualCopy && manualButton) {
      // Typing in a size stays the screen's way in (its copy says so), just no longer the main button.
      restyle(manualButton, 'secondary', 'md');
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
