/**
 * Prepare screen: how to set up the shot, which reference sheet is on the door,
 * and the two ways to hand over a photo (camera or library).
 */
import { getSheetMm, loadPhoto, setPhoto } from '../photo.js';

/** Screen id used for routing and for the `sm-screen--prepare` class. */
export const id = 'prepare';

/** Progress step this screen belongs to. */
export const step = 1;

/** Default copy for this screen; any key can be overridden through `config.text`. */
export const strings = {
  'prepare.title': 'Get set up',
  'prepare.subtitle': 'Three quick steps, then one photo.',
  'prepare.steps.label': 'How to set up your photo',
  'prepare.step1.title': 'Tape the sheet to the door',
  'prepare.step1.text': 'Stick it flat on the door itself, about halfway up, at chest height.',
  'prepare.step2.title': 'Close the door and stand back',
  'prepare.step2.text': 'Take 2 to 3 big steps back and face the door straight on.',
  'prepare.step3.title': 'Fit the whole door in',
  'prepare.step3.text': 'Hold your phone upright and leave a little space around the door.',
  'prepare.reference.title': "What's taped to your door?",
  'prepare.reference.hint': 'We use its size to work out the size of your door.',
  'prepare.reference.label': 'Sheet on your door',
  'prepare.reference.recommended': 'Recommended',
  'prepare.reference.lowAccuracy': 'Less accurate',
  'prepare.reference.custom': 'Custom size',
  'prepare.reference.size': '{label}: {width} × {height} mm',
  'prepare.reference.lowAccuracy.note': 'Small items give a rougher measurement. A full sheet of paper works best.',
  'prepare.custom.intro': 'Measure what is on your door and enter both sides.',
  'prepare.custom.short': 'Short side',
  'prepare.custom.long': 'Long side',
  'prepare.custom.unit': 'mm',
  'prepare.custom.error': 'Enter {min} to {max} mm',
  'prepare.custom.toast': 'Please check your custom size first.',
  'prepare.tips.title': 'Tips for best accuracy',
  'prepare.tips.straight': 'Stand straight on, not off to one side.',
  'prepare.tips.light': 'Use good, even light.',
  'prepare.tips.flash': 'Avoid flash glare on the sheet and the door.',
  'prepare.tips.flat': 'Keep the sheet flat, with no curling corners.',
  'prepare.tips.white': 'White or pale door? Use a coloured sheet of the same size so its edges stand out.',
  'prepare.tips.edge': 'Keep the door corners away from the very edge of the photo.',
  'prepare.take': 'Take photo',
  'prepare.choose': 'Choose a photo',
  'prepare.loading': 'Getting your photo ready…',
  'prepare.error.decode': "We couldn't open that photo. Please use a JPEG or PNG photo.",
};

/** Allowed length of each side of a custom reference, in mm. */
const CUSTOM_LIMITS = { min: 20, max: 1000 };

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

// Front view: a door with the sheet at chest height, a strip of tape across each corner.
const ART_SHEET =
  SVG_OPEN +
  '<path d="M14 89h68"/>' +
  '<rect x="30" y="7" width="36" height="82" rx="2"/>' +
  '<path d="M59 50v7"/>' +
  '<rect x="40" y="23" width="16" height="22" rx="1" fill="currentColor" fill-opacity="0.16"/>' +
  '<path d="M38 26l5-5M53 21l5 5M38 42l5 5M58 42l-5 5" stroke-width="3.5" stroke-linecap="butt"/>' +
  '</svg>';

// Side view: the closed door on the left, the customer a few steps back, phone square to the door.
const ART_STAND_BACK =
  SVG_OPEN +
  '<path d="M8 86h80"/>' +
  '<rect x="12" y="12" width="7" height="74" rx="1.5"/>' +
  '<path d="M19 50h3"/>' +
  '<circle cx="72" cy="25" r="6"/>' +
  '<path d="M72 31v27M72 58l-6 28M72 58l6 28M72 39l-13 3"/>' +
  '<rect x="53" y="35" width="5" height="10" rx="1.2"/>' +
  '<path d="M48 40H26" stroke-dasharray="1 5"/>' +
  '<path d="M27 74h30M31 70l-4 4 4 4M53 70l4 4-4 4"/>' +
  '</svg>';

// The phone held upright with the whole door inside the frame and space around it.
const ART_FRAME =
  SVG_OPEN +
  '<rect x="25" y="4" width="46" height="88" rx="8"/>' +
  '<path d="M32 21v-6h6M58 15h6v6M32 67v6h6M64 67v6h-6"/>' +
  '<rect x="39" y="21" width="18" height="46" rx="1"/>' +
  '<path d="M53 44v4" stroke-width="2"/>' +
  '<rect x="44.5" y="28" width="7" height="10" rx="0.8" stroke-width="2" fill="currentColor" fill-opacity="0.16"/>' +
  '<circle cx="48" cy="82" r="4"/>' +
  '</svg>';

/**
 * The prepare screen can always be entered.
 * @returns {boolean}
 */
export function canEnter() {
  return true;
}

/**
 * Build the prepare screen.
 *
 * @param {HTMLElement} root  the empty <section> for this screen
 * @param {object} ctx        app context (config, state, t, go, busy, toast, ui)
 * @returns {() => void} cleanup
 */
export function mount(root, ctx) {
  const { ui, config } = ctx;
  const { h } = ui;
  const t = (key, vars) => ctx.t(key, vars);
  const measurement = config.measurement || {};
  const references = Array.isArray(measurement.references) ? measurement.references : [];
  const allowCustom = Boolean(measurement.allowCustomReference);

  let alive = true;
  let loading = false;

  // A photo measurement is only true for the sheet size it was worked out with. The customer can
  // come back here, pick a different sheet and then use the browser's Forward button, so a change
  // of sheet size has to drop that measurement (the door screen simply measures again).
  const sheetKey = () => {
    const sheet = getSheetMm(ctx.state, config);
    return `${sheet.w}x${sheet.h}`;
  };
  let measuredSheet = sheetKey();

  function sheetSizeChanged() {
    const key = sheetKey();
    if (key === measuredSheet) return;
    measuredSheet = key;
    ctx.state.measure = null;
    if (ctx.state.size && ctx.state.size.source === 'photo') ctx.state.size = null;
  }

  // ---- 1. The three set-up steps -------------------------------------------------------------

  const steps = [
    { art: ART_SHEET, title: t('prepare.step1.title'), text: t('prepare.step1.text') },
    { art: ART_STAND_BACK, title: t('prepare.step2.title'), text: t('prepare.step2.text') },
    { art: ART_FRAME, title: t('prepare.step3.title'), text: t('prepare.step3.text') },
  ];
  const stepList = h(
    'ol',
    { class: 'sm-prepare__steps', attrs: { role: 'list', 'aria-label': t('prepare.steps.label') } },
    steps.map((item, index) =>
      h(
        'li',
        { class: 'sm-prepare__step-item' },
        ui.card(
          { class: 'sm-prepare__step' },
          h(
            'div',
            { class: 'sm-prepare__step-body' },
            h(
              'div',
              { class: 'sm-prepare__art', attrs: { 'aria-hidden': 'true' } },
              ui.svgFromString(item.art),
              h('span', { class: 'sm-prepare__badge sm-num', text: String(index + 1) }),
            ),
            h(
              'div',
              { class: 'sm-prepare__step-text' },
              h('h2', { class: 'sm-prepare__step-title', text: item.title }),
              h('p', { class: 'sm-prepare__step-desc', text: item.text }),
            ),
          ),
        ),
      ),
    ),
  );

  // ---- 2. Which reference is on the door -----------------------------------------------------

  const options = references.map((ref) => ({
    value: ref.id,
    label: ref.label,
    badge: ref.recommended ? t('prepare.reference.recommended') : undefined,
    hint: ref.lowAccuracy ? t('prepare.reference.lowAccuracy') : undefined,
  }));
  if (allowCustom) options.push({ value: 'custom', label: t('prepare.reference.custom') });

  // A stale selection (e.g. 'custom' left over from the demo, or a skin without that sheet)
  // must not survive silently: fall back to the default reference.
  if (options.length > 0 && !options.some((option) => option.value === ctx.state.referenceId)) {
    const fallback = options.find((option) => option.value === measurement.defaultReferenceId) || options[0];
    ctx.state.referenceId = fallback.value;
  }
  if (!ctx.state.customReference) ctx.state.customReference = { widthMm: null, heightMm: null };
  sheetSizeChanged();

  const rangeMessage = t('prepare.custom.error', CUSTOM_LIMITS);

  function makeSideField(key, labelKey) {
    const field = ui.field({
      id: `sm-prepare-custom-${key}`,
      label: t(labelKey),
      type: 'number',
      value: formatSide(ctx.state.customReference[key]),
      required: true,
      inputmode: 'decimal',
      suffix: t('prepare.custom.unit'),
      min: CUSTOM_LIMITS.min,
      max: CUSTOM_LIMITS.max,
      step: 'any',
      onInput: (value) => {
        const mm = parseMm(value);
        const ok = isValidSide(mm);
        ctx.state.customReference[key] = ok ? mm : null;
        sheetSizeChanged();
        if (ok) field.setError(null);
      },
    });
    // Only complain once they have finished typing something that cannot be right.
    field.input.addEventListener('blur', () => {
      const typed = String(field.input.value || '').trim() !== '';
      field.setError(typed && !isValidSide(ctx.state.customReference[key]) ? rangeMessage : null);
    });
    return { key, field };
  }

  const sideFields = [makeSideField('widthMm', 'prepare.custom.short'), makeSideField('heightMm', 'prepare.custom.long')];

  const customReady = () =>
    ctx.state.referenceId !== 'custom' || sideFields.every(({ key }) => isValidSide(ctx.state.customReference[key]));

  function showCustomErrors(focus) {
    let firstBad = null;
    for (const { key, field } of sideFields) {
      const ok = isValidSide(ctx.state.customReference[key]);
      field.setError(ok ? null : rangeMessage);
      if (!ok && !firstBad) firstBad = field;
    }
    if (focus && firstBad) firstBad.input.focus();
  }

  const referenceNote = h('p', { class: 'sm-prepare__note sm-num' });
  const lowAccuracyBanner = ui.banner(t('prepare.reference.lowAccuracy.note'), { tone: 'warning', icon: 'alert' });
  const customPanel = h(
    'div',
    { class: 'sm-prepare__custom' },
    sideFields.map(({ field }) => field.el),
  );

  function syncReference() {
    const selected = ctx.state.referenceId;
    const isCustom = selected === 'custom';
    const reference = references.find((ref) => ref.id === selected);
    if (isCustom) {
      referenceNote.textContent = t('prepare.custom.intro');
    } else if (reference) {
      referenceNote.textContent = t('prepare.reference.size', {
        label: reference.label,
        width: formatSide(reference.widthMm),
        height: formatSide(reference.heightMm),
      });
    } else {
      referenceNote.textContent = '';
    }
    referenceNote.hidden = referenceNote.textContent === '';
    lowAccuracyBanner.hidden = !(reference && reference.lowAccuracy);
    customPanel.hidden = !isCustom;
  }

  const chooser = ui.segmented({
    name: 'sm-prepare-reference',
    ariaLabel: t('prepare.reference.label'),
    options,
    value: ctx.state.referenceId,
    onChange: (value) => {
      ctx.state.referenceId = value;
      sheetSizeChanged();
      syncReference();
      if (value === 'custom' && !customReady()) sideFields[0].field.input.focus();
    },
  });
  syncReference();

  // With a single fixed reference there is nothing to choose. A custom size on its own still
  // needs the card, because that is where its two fields live.
  const referenceCard =
    options.length > 1 || allowCustom
      ? ui.card(
          { class: 'sm-prepare__reference' },
          h(
            'div',
            { class: 'sm-stack' },
            h(
              'div',
              { class: 'sm-prepare__reference-head' },
              h('h2', { class: 'sm-prepare__heading', text: t('prepare.reference.title') }),
              h('p', { class: 'sm-prepare__hint', text: t('prepare.reference.hint') }),
            ),
            chooser.el,
            h('div', { class: 'sm-stack', attrs: { 'aria-live': 'polite' } }, referenceNote, lowAccuracyBanner),
            customPanel,
          ),
        )
      : null;

  // ---- 3. Tips -------------------------------------------------------------------------------

  const tips = [
    t('prepare.tips.straight'),
    t('prepare.tips.light'),
    t('prepare.tips.flash'),
    t('prepare.tips.flat'),
    t('prepare.tips.white'),
    t('prepare.tips.edge'),
  ];
  const tipsDisclosure = ui.disclosure(
    { summary: t('prepare.tips.title') },
    h(
      'ul',
      { class: 'sm-prepare__tips', attrs: { role: 'list' } },
      tips.map((text) => h('li', { class: 'sm-prepare__tip' }, ui.icon('check', 18), h('span', { text }))),
    ),
  );

  // ---- 4. Hand over a photo ------------------------------------------------------------------

  function rejectCustom(focus) {
    showCustomErrors(focus);
    ctx.toast(t('prepare.custom.toast'), { type: 'error' });
  }

  async function onFile(file) {
    if (!file || loading) return;
    if (!customReady()) {
      rejectCustom(true);
      return;
    }
    loading = true;
    try {
      const photo = await ctx.busy(() => loadPhoto(file, config), t('prepare.loading'));
      if (!alive) return;
      setPhoto(ctx.state, photo);
      ctx.go('sheet');
    } catch {
      if (alive) ctx.toast(t('prepare.error.decode'), { type: 'error', duration: 6000 });
    } finally {
      loading = false;
    }
  }

  // Stop the camera / picker from opening at all while the custom size is unusable, rather than
  // letting the customer take a photo we would then have to throw away.
  function guardPicker(event) {
    if (customReady()) return;
    event.preventDefault();
    rejectCustom(true);
  }

  const takeButton = ui.fileButton(t('prepare.take'), {
    variant: 'primary',
    size: 'lg',
    icon: 'camera',
    accept: 'image/*',
    capture: 'environment',
    onFile,
  });
  const chooseButton = ui.fileButton(t('prepare.choose'), {
    variant: 'secondary',
    size: 'md',
    icon: 'image',
    accept: 'image/*',
    onFile,
  });
  takeButton.addEventListener('click', guardPicker, true);
  chooseButton.addEventListener('click', guardPicker, true);

  const header = ui.screenHeader({ title: t('prepare.title'), subtitle: t('prepare.subtitle') });
  const content = [header, stepList, referenceCard, tipsDisclosure, ui.actionBar(takeButton, chooseButton)];
  root.append(...content.filter(Boolean));

  return () => {
    alive = false;
  };
}

/**
 * @param {unknown} raw  text from a number field (a decimal comma is accepted)
 * @returns {number|null}
 */
function parseMm(raw) {
  const value = Number.parseFloat(String(raw == null ? '' : raw).replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** @param {unknown} mm */
function isValidSide(mm) {
  return typeof mm === 'number' && Number.isFinite(mm) && mm >= CUSTOM_LIMITS.min && mm <= CUSTOM_LIMITS.max;
}

/**
 * A side length without trailing zeros ('210', '215.9', '53.98'); '' for no value.
 * @param {unknown} mm
 * @returns {string}
 */
function formatSide(mm) {
  return typeof mm === 'number' && Number.isFinite(mm) ? String(Math.round(mm * 100) / 100) : '';
}
