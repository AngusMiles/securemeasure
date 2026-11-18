/**
 * Result screen (step 3).
 *
 * Two modes share this module:
 *  - measured: state.measure is set, so we show the size read from the photo, how far to
 *    trust it, a flattened preview to sanity-check the outline, and an optional tape override;
 *  - manual entry: the customer chose "I already know my door size", so we only ask for
 *    the two numbers.
 * Either way the screen leaves state.size holding the size the quote is priced from.
 */
import { warpToRect } from '../vision.js';
import { applyMeasurementRules, formatLength } from '../quote.js';

/** Screen id used by the router. */
export const id = 'result';

/** Progress step this screen belongs to. */
export const step = 3;

/** Default copy for this screen; any key can be overridden through config.text. */
export const strings = {
  'result.title': 'Your door size',
  'result.subtitle': 'Measured from your photo. Check it looks right, then get your price.',
  'result.width': 'Width',
  'result.height': 'Height',
  'result.unit': 'mm',
  'result.quality.good': 'Good measurement',
  'result.quality.fair': 'Fair measurement',
  'result.quality.rough': 'Rough measurement',
  'result.quality.poor': 'Check your photo',
  'result.accuracy': 'Accurate to about ±{mm} mm',
  'result.adjusted': 'Includes our fitting allowance. Your opening measured {width} × {height} mm.',
  'result.manualChip': 'Entered by you',
  'result.photoMeasured': 'Your photo measured {width} × {height} mm.',
  'result.usePhoto': 'Use the photo measurement',

  'result.preview.caption': 'Your door, flattened. The outline should sit on the door opening.',
  'result.preview.alt':
    'Your door photo, flattened, with the measured outline: {width} mm wide by {height} mm high.',

  'result.issues.title': 'How to get a better measurement',
  'result.issue.sheet_small':
    'The paper looks very small in your photo. Step closer so the door just fills the frame, then retake it.',
  'result.issue.steep_angle':
    'The photo was taken on an angle. Stand square to the door, hold your phone upright at about chest height and retake it.',
  'result.issue.high_residual':
    'The corners do not quite line up. Tap Adjust corners and place each marker exactly on its corner.',
  'result.issue.methods_disagree':
    'Our two checks gave different answers. Make sure the paper is taped flat on the door, then adjust the corners or retake the photo.',
  'result.issue.door_near_edge':
    'The door runs right to the edge of the photo. Step back a little so there is clear space all around it.',
  'result.issue.door_small':
    'The door looks small in your photo. Step closer so it fills most of the frame.',
  'result.issue.implausible_size':
    'This is an unusual size for a door. Check the markers sit on the door opening and that you picked the right paper size.',
  'result.issue.sheet_off_door':
    'The paper does not seem to be on the door. Tape it flat on the door itself, or adjust the corners if a marker has slipped.',
  'result.issue.high_uncertainty':
    'This photo does not let us measure very precisely. A sharper, straight-on photo with the paper flat on the door will tighten it up.',
  'result.issue.generic':
    'For a tighter measurement, retake the photo straight-on with the whole door in the frame and the paper taped flat.',

  'result.adjustCorners': 'Adjust corners',
  'result.retake': 'Retake photo',
  'result.continue': 'Get my price',
  'result.continueAnyway': 'Continue anyway',

  'result.override.summary': 'Measured with a tape? Enter your own size',
  'result.override.hint':
    'Enter the size of the door opening in millimetres and we will use it instead of the photo measurement.',
  'result.override.apply': 'Use this size',

  'result.field.width': 'Opening width',
  'result.field.height': 'Opening height',
  'result.field.widthHint': 'Between the frame at the narrowest point, e.g. 820',
  'result.field.heightHint': 'From the step to the top of the opening, e.g. 2040',
  'result.error.required': 'Enter a size in millimetres.',
  'result.error.width': 'Width should be between {min} and {max} mm.',
  'result.error.height': 'Height should be between {min} and {max} mm.',

  'result.manual.title': 'Enter your door size',
  'result.manual.subtitle': 'Measure the door opening with a tape measure and enter it in millimetres.',
  'result.manual.widthTip': 'Measure between the frame at the narrowest point.',
  'result.manual.heightTip': 'Measure from the step to the top of the opening.',
  'result.manual.useCamera': 'Measure with my camera instead',
};

/**
 * Route guard: the screen needs either a photo measurement or the manual-entry choice.
 * @param {object} state shared app state
 * @returns {boolean}
 */
export function canEnter(state) {
  return Boolean(state && (state.measure || state.manualEntry));
}

/**
 * Build the screen inside `root`.
 * @param {HTMLElement} root the empty <section> for this screen
 * @param {object} ctx app context (config, t, state, go, ui, ...)
 * @returns {(() => void) | undefined} cleanup function
 */
export function mount(root, ctx) {
  return ctx.state.measure ? mountMeasured(root, ctx) : mountManualEntry(root, ctx);
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const QUALITY = {
  good: { tone: 'success', icon: 'check' },
  fair: { tone: 'warning', icon: 'info' },
  rough: { tone: 'warning', icon: 'alert' },
  poor: { tone: 'danger', icon: 'alert' },
};

// measureDoor grades a photo 'poor' for two very different reasons. These issues mean a marker is
// probably on the wrong thing, so the size cannot be trusted and the customer is steered back to
// fix it. A wide "plus or minus" on its own (sheet corners placed by hand, a distant or angled
// photo) is common with honest photos, is still an estimate a check measure will confirm, and is
// often not something a retake would improve: that one is shown as 'rough' and lets them go on.
const UNTRUSTED_ISSUES = new Set(['high_residual', 'implausible_size', 'methods_disagree']);

const DEFAULT_PLAUSIBLE = { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 };

const PREVIEW_MARGIN_MM = 60;
const PREVIEW_MAX_PX = 720;
// Used only when the preview frame has no layout width yet (e.g. it is inside a hidden parent).
const PREVIEW_FALLBACK_CSS_PX = 280;

// Canvas overlay colours are fixed on purpose: a dark halo under a white core stays
// readable over any photo, which a brand colour cannot guarantee.
const INK = 'rgba(15, 23, 42, 0.85)';
const PAPER = '#ffffff';
const SAFE_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Static, trusted illustration for the manual-entry mode (door opening with the two
// distances to measure). Coloured from css/screens/result.css.
const DOOR_ART = `<svg class="sm-result__art" viewBox="0 0 96 132" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <rect class="sm-result__art-leaf" x="27" y="17" width="42" height="105"/>
  <path class="sm-result__art-frame" d="M24 122V14h48v108"/>
  <path class="sm-result__art-frame" d="M6 122h84"/>
  <circle class="sm-result__art-handle" cx="62" cy="76" r="2.5"/>
  <path class="sm-result__art-measure" d="M27 46h42M32 41l-5 5 5 5M64 41l5 5-5 5"/>
  <path class="sm-result__art-measure" d="M12 17v103M7 22l5-5 5 5M7 115l5 5 5-5"/>
</svg>`;

/** Add classes after the fact so they survive however a ui.* factory treats a `class` prop. */
function addClass(el, ...names) {
  el.classList.add(...names);
  return el;
}

/** Run the company's measurement rules over a width/height pair, returning only that pair. */
function applyRules(measurementCfg, { widthMm, heightMm }) {
  const out = applyMeasurementRules(measurementCfg, { widthMm, heightMm });
  return { widthMm: out.widthMm, heightMm: out.heightMm };
}

function plausibleLimits(config) {
  return { ...DEFAULT_PLAUSIBLE, ...(config.measurement?.plausible ?? {}) };
}

function hasAdjustment(config) {
  const adj = config.measurement?.adjustments ?? {};
  return Boolean(Number(adj.widthMm) || Number(adj.heightMm));
}

/** "±N mm" figure: two sigma of the worse dimension, never claiming better than 2 mm. */
function accuracyFromSigmas(measure) {
  const sigma = Math.max(Number(measure.sigmaWidthMm), Number(measure.sigmaHeightMm));
  return Number.isFinite(sigma) ? Math.max(2, Math.ceil(2 * sigma)) : null;
}

/** Whole millimetres from a text input, or null when it is empty or not a number. */
function parseMm(raw) {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Tell an embedding page which size the customer is going ahead with. The door screen already
 * emits 'measured' for a fresh photo measurement, so callers only use this for a size that was
 * chosen on this screen (typed in, or switched back to the photo).
 */
function announceMeasured(ctx) {
  const { size, measure } = ctx.state;
  const payload = { widthMm: size.widthMm, heightMm: size.heightMm, source: size.source };
  if (size.source === 'photo' && measure) {
    payload.quality = measure.quality?.level;
    payload.sigmaWidthMm = measure.sigmaWidthMm;
    payload.sigmaHeightMm = measure.sigmaHeightMm;
  }
  ctx.emit?.('measured', payload);
}

/**
 * Width + height inputs validated against config.measurement.plausible.
 * Errors stay quiet until a field has been left (or a submit was attempted), then track live.
 * @returns {{ el: HTMLElement, getValues: () => ({widthMm:number,heightMm:number}|null), submit: () => ({widthMm:number,heightMm:number}|null), isEmpty: () => boolean }}
 */
function createSizeForm(ctx, { idPrefix, initial = null, hints = false, onChange, onSubmit }) {
  const { ui, t } = ctx;
  const limits = plausibleLimits(ctx.config);
  const specs = [
    {
      key: 'widthMm',
      slug: 'width',
      min: limits.minWidthMm,
      max: limits.maxWidthMm,
      label: 'result.field.width',
      hint: 'result.field.widthHint',
      error: 'result.error.width',
    },
    {
      key: 'heightMm',
      slug: 'height',
      min: limits.minHeightMm,
      max: limits.maxHeightMm,
      label: 'result.field.height',
      hint: 'result.field.heightHint',
      error: 'result.error.height',
    },
  ];
  const fields = new Map();
  const touched = new Set();

  const check = (spec) => {
    const mm = parseMm(fields.get(spec.key).input.value);
    if (mm === null) return { value: null, error: t('result.error.required') };
    if (mm < spec.min || mm > spec.max) {
      return { value: null, error: t(spec.error, { min: spec.min, max: spec.max }) };
    }
    return { value: mm, error: null };
  };

  const getValues = () => {
    const values = {};
    for (const spec of specs) {
      const { value } = check(spec);
      if (value === null) return null;
      values[spec.key] = value;
    }
    return values;
  };

  const submit = () => {
    let firstInvalid = null;
    for (const spec of specs) {
      const field = fields.get(spec.key);
      const { error } = check(spec);
      touched.add(spec.key);
      field.setError(error);
      if (error && !firstInvalid) firstInvalid = field.input;
    }
    if (firstInvalid) {
      firstInvalid.focus();
      return null;
    }
    return getValues();
  };

  const isEmpty = () => specs.every((spec) => fields.get(spec.key).input.value.trim() === '');

  for (const spec of specs) {
    const field = ui.field({
      id: `${idPrefix}-${spec.slug}`,
      label: t(spec.label),
      type: 'number',
      inputmode: 'numeric',
      required: true,
      value: initial ? String(initial[spec.key]) : '',
      suffix: t('result.unit'),
      min: spec.min,
      max: spec.max,
      step: 1,
      hint: hints ? t(spec.hint) : undefined,
      onInput: () => {
        if (touched.has(spec.key)) field.setError(check(spec).error);
        onChange?.(getValues());
      },
    });
    field.input.addEventListener('change', () => {
      if (field.input.value !== '') touched.add(spec.key);
      if (touched.has(spec.key)) field.setError(check(spec).error);
      // Some input methods (autofill, steppers) commit without an input event.
      onChange?.(getValues());
    });
    field.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      onSubmit?.();
    });
    fields.set(spec.key, field);
  }

  const el = ui.h(
    'form',
    {
      class: 'sm-result__form sm-stack',
      attrs: { novalidate: '' },
      on: { submit: (event) => event.preventDefault() },
    },
    specs.map((spec) => fields.get(spec.key).el),
  );

  return { el, getValues, submit, isEmpty };
}

/* ------------------------------------------------------------------ */
/* Mode A: measured from the photo                                     */
/* ------------------------------------------------------------------ */

function mountMeasured(root, ctx) {
  const { ui, t, state, config } = ctx;
  const { h } = ui;
  const measure = state.measure;
  const graded = ['good', 'fair', 'poor'].includes(measure.quality?.level) ? measure.quality.level : 'fair';
  const issueCodes = Array.isArray(measure.quality?.issues) ? [...new Set(measure.quality.issues)] : [];
  // What the screen shows: the grade, with 'poor' split into 'poor' (do not trust it) and 'rough'.
  const level = graded === 'poor' && !issueCodes.some((code) => UNTRUSTED_ISSUES.has(code)) ? 'rough' : graded;

  // photoSize is what we quote from; `opening` is the bare measured opening (rounded only),
  // which is what the preview outline and the "your photo measured" notes describe.
  const photoSize = { ...applyRules(config.measurement, measure), source: 'photo' };
  const opening = applyRules(
    { ...config.measurement, adjustments: { widthMm: 0, heightMm: 0 } },
    measure,
  );
  if (!state.size || state.size.source !== 'manual') state.size = { ...photoSize };

  // The door screen emitted 'measured' for the photo size when it produced this measurement,
  // so going ahead with it unchanged is not news; a size chosen on this screen is.
  let announceOnContinue = state.size.source === 'manual';
  // True while the tape-override fields hold numbers that have not been applied yet.
  let overrideDirty = false;

  const openingVars = { width: ui.fmtMm(opening.widthMm), height: ui.fmtMm(opening.heightMm) };
  const accuracyMm = accuracyFromSigmas(measure);

  const header = ui.screenHeader({ title: t('result.title'), subtitle: t('result.subtitle') });

  /* Hero readout */
  const widthNumber = h('span', { class: 'sm-result__number sm-num' });
  const heightNumber = h('span', { class: 'sm-result__number sm-num' });
  const dimension = (label, numberEl) =>
    h(
      'div',
      { class: 'sm-result__dim' },
      h('dt', { class: 'sm-result__label', text: label }),
      h(
        'dd',
        { class: 'sm-result__value' },
        numberEl,
        h('span', { class: 'sm-result__unit', text: t('result.unit') }),
      ),
    );
  // Focusable so that changing the size can move focus here: it scrolls the readout into
  // view and has screen readers announce the new numbers.
  const readout = h(
    'dl',
    { class: 'sm-result__readout', attrs: { tabindex: '-1' } },
    dimension(t('result.width'), widthNumber),
    dimension(t('result.height'), heightNumber),
  );
  const chipSlot = h('span', { class: 'sm-result__chip' });
  const accuracy = h('span', {
    class: 'sm-result__accuracy sm-small sm-muted',
    text: accuracyMm === null ? '' : t('result.accuracy', { mm: accuracyMm }),
  });
  const adjustedNote = h('p', {
    class: 'sm-result__note sm-small sm-muted',
    text: t('result.adjusted', openingVars),
  });
  const manualNote = h(
    'div',
    { class: 'sm-result__manual-note' },
    h('p', { class: 'sm-small sm-muted', text: t('result.photoMeasured', openingVars) }),
    ui.button(t('result.usePhoto'), {
      variant: 'ghost',
      size: 'sm',
      full: false,
      icon: 'refresh',
      onClick: usePhotoSize,
    }),
  );
  const hero = addClass(
    ui.card(
      null,
      readout,
      h('div', { class: 'sm-result__meta' }, chipSlot, accuracy),
      adjustedNote,
      manualNote,
    ),
    'sm-result__hero',
  );

  /* Issue list: one plain-English line per known issue code */
  const issueLines = issueCodes
    .map((code) => `result.issue.${code}`)
    .filter((key) => Object.prototype.hasOwnProperty.call(strings, key))
    .map((key) => t(key));
  // 'fair' with no issue code is what a clean, straight-on photo scores with hand-placed door
  // corners (the bundled demo included), so there is nothing to tell that customer to redo.
  if (issueLines.length === 0 && (level === 'poor' || level === 'rough')) issueLines.push(t('result.issue.generic'));
  const issuesCard = issueLines.length
    ? addClass(
        ui.card(
          { dataset: { level } },
          h('h2', { class: 'sm-result__issues-title', text: t('result.issues.title') }),
          h(
            'ul',
            { class: 'sm-result__issue-list' },
            issueLines.map((line) =>
              h('li', { class: 'sm-result__issue' }, ui.icon('alert', 18), h('span', { text: line })),
            ),
          ),
        ),
        'sm-result__issues',
      )
    : null;

  /* Flattened preview */
  const canvas = h('canvas', {
    class: 'sm-result__canvas',
    attrs: { role: 'img', 'aria-label': t('result.preview.alt', openingVars) },
  });
  const frame = h('div', { class: 'sm-result__frame' }, canvas);
  const previewCard = addClass(
    ui.card(
      null,
      h(
        'figure',
        { class: 'sm-result__figure' },
        frame,
        h('figcaption', {
          class: 'sm-result__caption sm-small sm-muted',
          text: t('result.preview.caption'),
        }),
      ),
    ),
    'sm-result__preview',
  );

  /* Fix-it tools */
  const adjustTool = ui.button(t('result.adjustCorners'), {
    variant: 'secondary',
    icon: 'edit',
    onClick: () => ctx.go('door'),
  });
  const retakeTool = ui.button(t('result.retake'), {
    variant: 'secondary',
    icon: 'camera',
    onClick: retake,
  });
  const tools = h('div', { class: 'sm-result__tools' }, adjustTool, retakeTool);

  /* Tape override */
  let overrideForm = null;
  let override = null;
  if (config.measurement?.allowManualOverride) {
    overrideForm = createSizeForm(ctx, {
      idPrefix: 'sm-result-override',
      initial: state.size.source === 'manual' ? state.size : null,
      hints: true,
      onChange: () => {
        overrideDirty = true;
      },
      onSubmit: applyOverride,
    });
    override = addClass(
      ui.disclosure(
        {
          summary: t('result.override.summary'),
          open: state.size.source === 'manual' || Boolean(state.manualEntry),
        },
        h(
          'div',
          { class: 'sm-result__override sm-stack' },
          h('p', { class: 'sm-small sm-muted', text: t('result.override.hint') }),
          overrideForm.el,
          ui.button(t('result.override.apply'), {
            variant: 'secondary',
            icon: 'check',
            onClick: applyOverride,
          }),
        ),
      ),
      'sm-result__disclosure',
    );
  }

  /* Action bar: its contents depend on whether we trust the photo size */
  const retakePrimary = ui.button(t('result.retake'), { icon: 'camera', onClick: retake });
  const continueAnyway = ui.button(t('result.continueAnyway'), {
    variant: 'secondary',
    onClick: goToQuote,
  });
  const getPrice = ui.button(t('result.continue'), { iconEnd: 'arrow-right', onClick: goToQuote });
  const actions = ui.actionBar();

  function renderSize() {
    const size = state.size;
    const manual = size.source === 'manual';
    const steerToRetake = level === 'poor' && !manual;

    widthNumber.textContent = ui.fmtMm(size.widthMm);
    heightNumber.textContent = ui.fmtMm(size.heightMm);
    chipSlot.replaceChildren(
      manual
        ? ui.chip(t('result.manualChip'), { tone: 'neutral', icon: 'edit' })
        : ui.chip(t(`result.quality.${level}`), QUALITY[level]),
    );
    accuracy.hidden = manual || accuracyMm === null;
    adjustedNote.hidden = manual || !hasAdjustment(config);
    manualNote.hidden = !manual;

    // "Retake photo" is promoted to the action bar for a poor photo; showing it twice
    // would put two identically named buttons on one screen.
    retakeTool.hidden = steerToRetake;
    actions.replaceChildren(...(steerToRetake ? [retakePrimary, continueAnyway] : [getPrice]));
  }

  function showReadout() {
    readout.focus();
    hero.scrollIntoView?.({ block: 'nearest' });
  }

  /** Validate the tape-override fields and, when they hold a usable size, make it state.size. */
  function commitOverride() {
    const values = overrideForm.submit();
    if (!values) return false;
    state.size = { ...values, source: 'manual' };
    overrideDirty = false;
    announceOnContinue = true;
    renderSize();
    return true;
  }

  function applyOverride() {
    if (commitOverride()) showReadout();
  }

  function usePhotoSize() {
    state.size = { ...photoSize };
    // The typed numbers stay in the fields, but the customer has just chosen the photo over them.
    overrideDirty = false;
    announceOnContinue = true;
    renderSize();
    showReadout();
  }

  function retake() {
    ctx.go('prepare');
  }

  function goToQuote() {
    // Numbers typed into the open tape override but never applied would otherwise be dropped
    // without a word: going ahead means "use what I typed" (or shows what is wrong with it).
    const pendingOverride = overrideDirty && override?.open && !overrideForm.isEmpty();
    if (pendingOverride && !commitOverride()) return;
    if (announceOnContinue) announceMeasured(ctx);
    ctx.go('quote');
  }

  renderSize();
  root.append(...[header, hero, issuesCard, previewCard, tools, override, actions].filter(Boolean));

  /* Render the preview once the screen has painted, so the numbers never wait for the warp */
  const doorW = Number(measure.widthMm);
  const doorH = Number(measure.heightMm);
  const canPreview =
    Boolean(state.photo?.image) &&
    Array.isArray(measure.planeToImage) &&
    Number.isFinite(doorW) &&
    Number.isFinite(doorH) &&
    doorW > 0 &&
    doorH > 0;
  let frameA = 0;
  let frameB = 0;

  if (canPreview) {
    // Low-res placeholder with the final aspect ratio, so nothing jumps when the real
    // pixels arrive.
    canvas.width = Math.max(1, Math.round((doorW + 2 * PREVIEW_MARGIN_MM) / 10));
    canvas.height = Math.max(1, Math.round((doorH + 2 * PREVIEW_MARGIN_MM) / 10));
    frameA = requestAnimationFrame(() => {
      frameB = requestAnimationFrame(() => {
        try {
          renderPreview(canvas, frame, state.photo.image, measure, {
            widthLabel: formatLength(opening.widthMm),
            heightLabel: formatLength(opening.heightMm),
          });
          canvas.classList.add('is-ready');
        } catch (error) {
          console.warn('[SecureMeasure] Could not draw the flattened preview.', error);
          previewCard.hidden = true;
        }
      });
    });
  } else {
    previewCard.hidden = true;
  }

  return () => {
    cancelAnimationFrame(frameA);
    cancelAnimationFrame(frameB);
  };
}

/* ------------------------------------------------------------------ */
/* Flattened preview drawing                                           */
/* ------------------------------------------------------------------ */

/**
 * Warp the photo to a fronto-parallel view of the door (plus a margin) and annotate it.
 * Throws on any failure; the caller hides the preview.
 */
function renderPreview(canvas, frame, photoImage, measure, labels) {
  const cssWidth = frame.clientWidth || PREVIEW_FALLBACK_CSS_PX;
  const dpr = globalThis.devicePixelRatio || 1;
  const outWidth = Math.max(1, Math.min(PREVIEW_MAX_PX, Math.round(cssWidth * dpr)));

  const image = warpToRect(photoImage, measure.planeToImage, {
    widthMm: measure.widthMm,
    heightMm: measure.heightMm,
    marginMm: PREVIEW_MARGIN_MM,
    outWidth,
  });

  canvas.width = image.width;
  canvas.height = image.height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no_canvas_context');
  g.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

  drawDimensions(g, {
    width: image.width,
    height: image.height,
    doorW: measure.widthMm,
    doorH: measure.heightMm,
    marginMm: PREVIEW_MARGIN_MM,
    // Canvas pixels per CSS pixel, so strokes and text keep their on-screen size.
    unit: Math.max(1, image.width / cssWidth),
    fontFamily: typeof getComputedStyle === 'function' ? getComputedStyle(canvas).fontFamily : '',
    ...labels,
  });
}

/** Door outline plus width (top margin) and height (left margin) dimension lines. */
function drawDimensions(g, { width, height, doorW, doorH, marginMm, unit, fontFamily, widthLabel, heightLabel }) {
  const sx = width / (doorW + 2 * marginMm);
  const sy = height / (doorH + 2 * marginMm);
  const x0 = marginMm * sx;
  const y0 = marginMm * sy;
  const w = doorW * sx;
  const hgt = doorH * sy;

  g.save();

  // Door opening outline: mitred so the corners stay crisp for checking against the photo.
  g.lineJoin = 'miter';
  g.lineCap = 'butt';
  strokeTwoTone(g, unit, 1.5, () => g.rect(x0, y0, w, hgt));

  // Dimension lines run down the middle of the margin strips, with a tick at each end.
  g.lineCap = 'round';
  const topY = y0 / 2;
  const leftX = x0 / 2;
  const tickX = Math.min(4 * unit, x0 * 0.4);
  const tickY = Math.min(4 * unit, y0 * 0.4);
  strokeTwoTone(g, unit, 1.25, () => {
    g.moveTo(x0, topY);
    g.lineTo(x0 + w, topY);
    g.moveTo(x0, topY - tickY);
    g.lineTo(x0, topY + tickY);
    g.moveTo(x0 + w, topY - tickY);
    g.lineTo(x0 + w, topY + tickY);
  });
  strokeTwoTone(g, unit, 1.25, () => {
    g.moveTo(leftX, y0);
    g.lineTo(leftX, y0 + hgt);
    g.moveTo(leftX - tickX, y0);
    g.lineTo(leftX + tickX, y0);
    g.moveTo(leftX - tickX, y0 + hgt);
    g.lineTo(leftX + tickX, y0 + hgt);
  });

  // Labels are slightly thicker than the margin strip on small previews, so keep them
  // fully on the canvas and let them overlap the outline instead of being clipped.
  const fontPx = Math.round(11 * unit);
  const thickness = fontPx + 5 * unit;
  const inset = thickness / 2 + unit;
  g.font = `600 ${fontPx}px ${SAFE_FONT_STACK}`;
  // An unparsable family is ignored by the canvas, leaving the safe stack in place.
  if (fontFamily) g.font = `600 ${fontPx}px ${fontFamily}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  drawLabel(g, widthLabel, x0 + w / 2, Math.max(topY, inset), 0, { unit, thickness });
  drawLabel(g, heightLabel, Math.max(leftX, inset), y0 + hgt / 2, -Math.PI / 2, { unit, thickness });

  g.restore();
}

/** Stroke one path twice: a dark halo, then a light core on top. */
function strokeTwoTone(g, unit, coreWidth, buildPath) {
  g.beginPath();
  buildPath();
  g.strokeStyle = INK;
  g.lineWidth = (coreWidth + 2) * unit;
  g.stroke();
  g.strokeStyle = PAPER;
  g.lineWidth = coreWidth * unit;
  g.stroke();
}

/** Dark pill with light text, centred on (cx, cy) and rotated by `angle`. */
function drawLabel(g, text, cx, cy, angle, { unit, thickness }) {
  const w = g.measureText(text).width + 12 * unit;
  const r = thickness / 2;
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);
  // Hand-built rounded rectangle: CanvasRenderingContext2D.roundRect is missing on iOS 15.
  g.beginPath();
  g.moveTo(-w / 2 + r, -r);
  g.arcTo(w / 2, -r, w / 2, r, r);
  g.arcTo(w / 2, r, -w / 2, r, r);
  g.arcTo(-w / 2, r, -w / 2, -r, r);
  g.arcTo(-w / 2, -r, w / 2, -r, r);
  g.closePath();
  g.fillStyle = INK;
  g.fill();
  g.strokeStyle = PAPER;
  g.lineWidth = unit;
  g.stroke();
  g.fillStyle = PAPER;
  g.fillText(text, 0, 0.5 * unit);
  g.restore();
}

/* ------------------------------------------------------------------ */
/* Mode B: the customer types the size in                              */
/* ------------------------------------------------------------------ */

function mountManualEntry(root, ctx) {
  const { ui, t, state } = ctx;
  const { h } = ui;

  const header = ui.screenHeader({
    title: t('result.manual.title'),
    subtitle: t('result.manual.subtitle'),
  });

  const tip = (label, text) =>
    h('li', { class: 'sm-result__tip' }, h('strong', { text: label }), h('span', { text }));
  const howTo = addClass(
    ui.card(
      null,
      addClass(ui.svgFromString(DOOR_ART), 'sm-result__art'),
      h(
        'ul',
        { class: 'sm-result__tips' },
        tip(t('result.width'), t('result.manual.widthTip')),
        tip(t('result.height'), t('result.manual.heightTip')),
      ),
    ),
    'sm-result__howto',
  );

  const getPrice = ui.button(t('result.continue'), {
    iconEnd: 'arrow-right',
    disabled: true,
    onClick: submit,
  });
  const form = createSizeForm(ctx, {
    idPrefix: 'sm-result-manual',
    initial: state.size?.source === 'manual' ? state.size : null,
    onChange: (values) => {
      getPrice.disabled = !values;
    },
    onSubmit: submit,
  });
  getPrice.disabled = !form.getValues();

  const useCamera = ui.button(t('result.manual.useCamera'), {
    variant: 'ghost',
    icon: 'camera',
    onClick: () => {
      state.manualEntry = false;
      ctx.go('prepare');
    },
  });

  function submit() {
    const values = form.submit();
    if (!values) return;
    state.size = { ...values, source: 'manual' };
    announceMeasured(ctx);
    ctx.go('quote');
  }

  root.append(
    header,
    howTo,
    addClass(ui.card(null, form.el), 'sm-result__entry'),
    ui.actionBar(getPrice, useCamera),
  );
  return undefined;
}
