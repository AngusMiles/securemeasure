/**
 * Result screen (step 3), the two no-paper modes, plus the building blocks every result mode shares.
 *
 *  - estimate: one photo, no paper. The door's corners give its height-to-width ratio, and that ratio
 *    is matched to the company's catalogue of standard sizes (js/estimate.js). A photo with no scale in
 *    it cannot give real millimetres, so this mode never shows any: it shows the nearest standard
 *    size, lets the customer pick between the few sizes that fit the photo, and says plainly that a
 *    check measure confirms it.
 *  - ar: the phone's AR camera measured the opening (js/screens/ar.js). Those are real millimetres,
 *    but only to within a few centimetres, so the measurement is shown as an "AR estimate" and, when it
 *    sits close to a standard size, the customer can choose that size instead.
 *
 * js/screens/result.js dispatches to mountEstimate / mountAr, keeps the paper measurement and manual
 * entry modes, and imports the shared pieces (the size form, the 'measured' announcement) from here.
 * Nothing in this module imports result.js, so there is no import cycle; the flattened preview lives
 * in result-preview.js for the same reason. The copy this module shares with the paper mode (the
 * readout labels, the tape-override form) stays in result.js's `strings`, which also merges in the
 * strings below, so the app's string table holds every key either module uses.
 *
 * Nothing touches the DOM at import time: the pure helpers are tested under Node (tests/result.test.mjs).
 */
import { applyMeasurementRules, formatLength } from '../quote.js';
import { planeToImageFor } from '../estimate.js';
import { createPreview } from './result-preview.js';

/** Default copy for the estimate and AR modes; any key can be overridden through config.text. */
export const strings = {
  // Shared by both modes.
  'result.size': '{width} × {height} mm',
  'result.standard.adjusted': 'Includes our fitting allowance. The standard size is {width} × {height} mm.',
  'result.standard.override.hint':
    'Enter the size of the door opening in millimetres and we will use it instead of our estimate.',

  // Estimate: one photo, matched to the nearest standard size.
  'result.estimate.subtitle':
    'Matched from your photo to the nearest standard door size. Check it looks right, then get your price.',
  'result.estimate.chip': 'Estimate',
  'result.estimate.note':
    'This is an estimate matched to a standard door size. We confirm the exact size with a check measure before your door is made.',
  'result.estimate.manualNote': 'Our estimate from your photo was {width} × {height} mm.',
  'result.estimate.useEstimate': 'Use the estimate',
  'result.estimate.choices.title': 'Which is your door?',
  'result.estimate.choices.hint': 'These standard sizes fit your photo best. Pick the one that looks right.',
  'result.estimate.mostLikely': 'Most likely',
  'result.estimate.alsoPossible': 'Also possible',
  'result.estimate.unsure':
    "We can't be sure between these sizes from one photo. Pick the one that looks most like your door. We confirm the exact size with a check measure.",
  'result.estimate.unsureOne':
    "We can't match your door to a standard size with confidence from this photo. Check the corners, or retake the photo standing square to the door.",
  'result.estimate.nonStandard':
    'Your door may not be a standard size, so this estimate could be some way out. We measure it exactly at the check measure, before anything is made.',
  'result.estimate.issues.title': 'How to get a better estimate',
  'result.estimate.issue.not_rectangular':
    "The corners don't quite make a rectangle. Tap Adjust corners and put each one exactly where the door meets the frame.",
  'result.estimate.issue.steep_angle':
    'The photo was taken on an angle, which makes the estimate less certain. Stand square to the door, hold your phone upright and retake it.',
  'result.estimate.issue.door_small':
    'The door looks small in your photo. Step closer so it fills most of the frame, then retake it.',
  'result.estimate.issue.door_near_edge':
    'The door runs right to the edge of the photo. Step back a little so there is clear space all around it, then retake it.',
  'result.estimate.preview.caption':
    'Your door, flattened to the size you picked. The outline should sit on the door opening.',
  'result.estimate.preview.alt':
    'Your door photo, flattened to {width} mm wide by {height} mm high, with the outline of the door opening.',
  'result.estimate.ownDoor': 'Measure my own door',
  'result.estimate.paper': 'Want it exact? Use a sheet of paper',

  // AR: measured with the phone's AR camera.
  'result.ar.subtitle': "Measured with your phone's AR camera. Check it looks right, then get your price.",
  'result.ar.chip': 'AR estimate',
  'result.ar.note':
    "This is an estimate from your phone's AR camera. We confirm the exact size with a check measure before your door is made.",
  'result.ar.manualNote': 'Your AR measurement was {width} × {height} mm.',
  'result.ar.useMeasurement': 'Use the AR measurement',
  'result.ar.warnings.title': 'Check your measurement',
  'result.ar.warning.base_not_level':
    "One bottom corner read higher than the other. That's fine on a sloping step; otherwise measure again and aim right at each corner.",
  'result.ar.warning.off_plane':
    'Your phone lost track of the door a little while you measured. Measure again, moving the phone slowly and steadily.',
  'result.ar.warning.widths_disagree':
    "The width at the top and the bottom didn't match. Measure again and aim right at each corner.",
  'result.ar.warning.heights_disagree':
    "The height on the left and the right didn't match. Measure again and aim right at each corner.",
  'result.ar.warning.out_of_square':
    "The corners didn't make a rectangle. Measure again and aim right at each corner.",
  'result.ar.warning.implausible_size':
    'This is an unusual size for a door. Check you tapped the corners of the door opening, or measure again. If the size is right, you can carry on.',
  'result.ar.standard.title': 'Closest standard size: {width} × {height} mm',
  'result.ar.standard.hint': 'Your measurement is close to a standard door size. If your door is that size, use it instead.',
  'result.ar.useStandard': 'Use the standard size',
  'result.ar.useMeasured': 'Use my measurement',
  'result.ar.nonStandard':
    "Your door may not be a standard size, so we'll use your measurement. We confirm the exact size with a check measure.",
  'result.ar.measureAgain': 'Measure again',
  'result.ar.usePhoto': 'Take a photo instead',
};

/* ------------------------------------------------------------------ */
/* Shared building blocks (js/screens/result.js uses these too)        */
/* ------------------------------------------------------------------ */

const DEFAULT_PLAUSIBLE = { minWidthMm: 500, maxWidthMm: 1500, minHeightMm: 1500, maxHeightMm: 2800 };

/** Add classes after the fact so they survive however a ui.* factory treats a `class` prop. */
export function addClass(el, ...names) {
  el.classList.add(...names);
  return el;
}

/** Run the company's measurement rules over a width/height pair, returning only that pair. */
export function applyRules(measurementCfg, { widthMm, heightMm }) {
  const out = applyMeasurementRules(measurementCfg, { widthMm, heightMm });
  return { widthMm: out.widthMm, heightMm: out.heightMm };
}

/** The bare opening: rounded like a quoted size, but without the company's fitting allowance. */
function openingOf(measurementCfg, size) {
  return applyRules({ ...measurementCfg, adjustments: { widthMm: 0, heightMm: 0 } }, size);
}

/** The plausible-size limits the size form checks against (config.measurement.plausible). */
export function plausibleLimits(config) {
  return { ...DEFAULT_PLAUSIBLE, ...(config.measurement?.plausible ?? {}) };
}

/** True when the company adds a fitting allowance, so the quoted size is not the bare opening. */
export function hasAdjustment(config) {
  const adj = config.measurement?.adjustments ?? {};
  return Boolean(Number(adj.widthMm) || Number(adj.heightMm));
}

/** Whole millimetres from a text input, or null when it is empty or not a number. */
export function parseMm(raw) {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Two state.size values describe the same choice: same numbers, same source, and (for the AR mode,
 * where both are possible) the same answer to "is this the standard size?".
 * @param {object | null | undefined} a
 * @param {object | null | undefined} b
 * @returns {boolean}
 */
export function sameSize(a, b) {
  return (
    Boolean(a && b) &&
    a.widthMm === b.widthMm &&
    a.heightMm === b.heightMm &&
    a.source === b.source &&
    Boolean(a.standard) === Boolean(b.standard)
  );
}

/** True when the photo is the bundled demo door rather than the customer's own. */
function isDemoPhoto(photo) {
  return photo?.isDemo === true || photo?.capture === 'demo';
}

/**
 * The 'measured' event for the size the customer is going ahead with (state.size), in the shape the
 * screen that measured it sends: the paper path adds its grade and sigmas, the estimate says it is a
 * standard size, AR says whether the standard size was chosen. `demo` marks the bundled demo photo,
 * as the enquiry does; it never applies to an AR measurement, which does not use the photo.
 *
 * @param {object} state  ctx.state (reads size, measure and photo)
 * @returns {{ widthMm: number, heightMm: number, source: string, standard?: boolean, quality?: string, sigmaWidthMm?: number, sigmaHeightMm?: number, demo?: boolean }}
 */
export function measuredPayload(state) {
  const { size, measure, photo } = state;
  const payload = { widthMm: size.widthMm, heightMm: size.heightMm, source: size.source };
  if (size.source === 'photo' && measure) {
    payload.quality = measure.quality?.level;
    payload.sigmaWidthMm = measure.sigmaWidthMm;
    payload.sigmaHeightMm = measure.sigmaHeightMm;
    if (isDemoPhoto(photo)) payload.demo = true;
  } else if (size.source === 'estimate') {
    payload.standard = true;
    if (isDemoPhoto(photo)) payload.demo = true;
  } else if (size.source === 'ar') {
    payload.standard = size.standard === true;
  }
  return payload;
}

/**
 * Tell an embedding page which size the customer is going ahead with. The screen that measured the
 * door already emitted 'measured' for what it found, so callers only use this for a size that was
 * chosen on the result screen (typed in, picked from the list, or switched back).
 */
export function announceMeasured(ctx) {
  ctx.emit?.('measured', measuredPayload(ctx.state));
}

/**
 * Width + height inputs validated against config.measurement.plausible.
 * Errors stay quiet until a field has been left (or a submit was attempted), then track live.
 * Its copy ('result.field.*', 'result.error.*', 'result.unit') is in result.js's strings.
 * @returns {{ el: HTMLElement, getValues: () => ({widthMm:number,heightMm:number}|null), submit: () => ({widthMm:number,heightMm:number}|null), isEmpty: () => boolean }}
 */
export function createSizeForm(ctx, { idPrefix, initial = null, hints = false, onChange, onSubmit }) {
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
/* Pure rules for the two no-paper modes (tested)                      */
/* ------------------------------------------------------------------ */

/** At most this many sizes are offered under "Which is your door?". */
export const MAX_CHOICES = 3;
/** A size after the most likely one is offered only when it has at least this chance of being the door. */
export const MIN_CHOICE_P = 0.05;

/** The estimate issues the screen explains, most useful first ('non_standard' gets its own banner). */
export const ESTIMATE_ISSUES = Object.freeze(['not_rectangular', 'steep_angle', 'door_small', 'door_near_edge']);

/** The AR warning codes the screen explains (measureOpening's codes). */
export const AR_WARNINGS = Object.freeze([
  'base_not_level',
  'off_plane',
  'widths_disagree',
  'heights_disagree',
  'out_of_square',
  'implausible_size',
]);

/**
 * How far an AR measurement may be from the most likely standard size for that size to be offered.
 * About the AR method's honest error on a good pass (±30-90 mm at 95 %); height gets more because the
 * top corners are further away and read less precisely. Beyond this the door is probably not a
 * standard size, and offering one would only invite the wrong door being made.
 */
export const AR_STANDARD_TOLERANCE = Object.freeze({ widthMm: 60, heightMm: 90 });

const isLength = (value) => Number.isFinite(value) && value > 0;

/** Stable id for a size, used as the radio value. */
export function choiceKey({ widthMm, heightMm }) {
  return `${widthMm}x${heightMm}`;
}

/**
 * The sizes offered under "Which is your door?", best first: the most likely size always, then up to
 * two more that each have a real chance (p >= MIN_CHOICE_P) of being the door. Unusable entries and
 * repeats (a catalogue listing one size twice) are skipped. With no usable candidate it falls back to
 * the measure's own widthMm / heightMm, which estimateFromCorners sets to the best candidate.
 *
 * @param {object | null | undefined} measure  the estimate measure
 * @returns {Array<{ widthMm: number, heightMm: number, p: number | null, key: string }>}
 */
export function estimateChoices(measure) {
  const pick = (pool) => {
    const choices = [];
    const seen = new Set();
    for (const candidate of pool) {
      if (choices.length >= MAX_CHOICES) break;
      const widthMm = Number(candidate?.widthMm);
      const heightMm = Number(candidate?.heightMm);
      if (!isLength(widthMm) || !isLength(heightMm)) continue;
      const p = Number(candidate?.p);
      // The candidates come best first: the first usable one leads whatever its chance.
      if (choices.length > 0 && !(p >= MIN_CHOICE_P)) continue;
      const key = choiceKey({ widthMm, heightMm });
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push({ widthMm, heightMm, p: Number.isFinite(p) ? p : null, key });
    }
    return choices;
  };
  const listed = pick(Array.isArray(measure?.candidates) ? measure.candidates : []);
  return listed.length ? listed : pick([{ widthMm: measure?.widthMm, heightMm: measure?.heightMm }]);
}

/** The badge on choice `index` of "Which is your door?". */
export function choiceBadgeKey(index) {
  return index === 0 ? 'result.estimate.mostLikely' : 'result.estimate.alsoPossible';
}

/**
 * The warning banner the estimate shows, or null when it is confident. A door that matches no
 * standard size well is the bigger problem, so it wins over plain uncertainty; uncertainty is worded
 * for whether there is a list of sizes to choose from.
 *
 * @param {object} measure  the estimate measure
 * @param {number} choiceCount  estimateChoices(measure).length
 * @returns {string | null} a string key
 */
export function estimateBannerKey(measure, choiceCount) {
  if (measure?.nonStandard === true) return 'result.estimate.nonStandard';
  if (measure?.confident === true) return null;
  return choiceCount > 1 ? 'result.estimate.unsure' : 'result.estimate.unsureOne';
}

/**
 * String keys for the codes in `codes` that the screen explains, in the order of `known`.
 * @param {unknown} codes  e.g. measure.issues
 * @param {readonly string[]} known
 * @param {string} prefix  e.g. 'result.estimate.issue.'
 * @returns {string[]}
 */
export function issueKeys(codes, known, prefix) {
  const present = new Set(Array.isArray(codes) ? codes : []);
  return known.filter((code) => present.has(code)).map((code) => `${prefix}${code}`);
}

/** The estimate's issue lines (string keys). */
export function estimateIssueKeys(measure) {
  return issueKeys(measure?.issues, ESTIMATE_ISSUES, 'result.estimate.issue.');
}

/** The AR measurement's warning lines (string keys). */
export function arWarningKeys(measure) {
  return issueKeys(measure?.warnings, AR_WARNINGS, 'result.ar.warning.');
}

/**
 * The standard size an AR measurement is offered, or null: the most likely standard size
 * (measure.candidates[0], from nearestStandard), only when it is within AR_STANDARD_TOLERANCE of
 * the measured opening in both directions.
 *
 * @param {object | null | undefined} measure  the AR measure
 * @param {{ widthMm: number, heightMm: number }} [tolerance]
 * @returns {{ widthMm: number, heightMm: number } | null}
 */
export function closestStandard(measure, tolerance = AR_STANDARD_TOLERANCE) {
  const best = Array.isArray(measure?.candidates) ? measure.candidates[0] : null;
  const widthMm = Number(best?.widthMm);
  const heightMm = Number(best?.heightMm);
  const measuredW = Number(measure?.widthMm);
  const measuredH = Number(measure?.heightMm);
  if (![widthMm, heightMm, measuredW, measuredH].every(isLength)) return null;
  const close =
    Math.abs(widthMm - measuredW) <= tolerance.widthMm && Math.abs(heightMm - measuredH) <= tolerance.heightMm;
  return close ? { widthMm, heightMm } : null;
}

const TOOLS = {
  adjust: { target: 'door', label: 'result.adjustCorners', icon: 'edit' },
  retake: { target: 'capture', label: 'result.retake', icon: 'camera' },
  // The demo photo cannot be retaken: start again from the ways in instead.
  ownDoor: { target: 'welcome', label: 'result.estimate.ownDoor', icon: 'door' },
  measureAgain: { target: 'ar', label: 'result.ar.measureAgain', icon: 'refresh' },
  usePhoto: { target: 'capture', label: 'result.ar.usePhoto', icon: 'camera' },
};

/**
 * The fix-it buttons under the size: where each one goes and its copy.
 * @param {'estimate' | 'ar'} mode
 * @param {{ isDemo?: boolean, methods?: { camera?: boolean } }} [options]
 *   isDemo: the estimate came from the bundled demo photo; methods: config.measurement.methods
 * @returns {Array<{ id: string, target: string, label: string, icon: string }>}
 */
export function resultTools(mode, { isDemo = false, methods = {} } = {}) {
  let ids = [];
  if (mode === 'estimate') ids = ['adjust', isDemo ? 'ownDoor' : 'retake'];
  // A company that switched the camera way in off is not offered it here either.
  else if (mode === 'ar') ids = methods?.camera === false ? ['measureAgain'] : ['measureAgain', 'usePhoto'];
  return ids.map((id) => ({ id, ...TOOLS[id] }));
}

/** True when the estimate offers "Want it exact? Use a sheet of paper" (config.measurement.methods.paper). */
export function offersPaper(config) {
  return config?.measurement?.methods?.paper !== false;
}

/* ------------------------------------------------------------------ */
/* DOM pieces the two modes share                                      */
/* ------------------------------------------------------------------ */

/**
 * The big size readout card: the two numbers, a chip saying where they came from, the check-measure
 * note, the fitting-allowance note, and (once a size has been typed in) a way back to the estimate.
 */
function createHero(ctx, { chipText, chipIcon, note, restoreLabel, onRestore }) {
  const { ui, t } = ctx;
  const { h } = ui;
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
  // Focusable so that changing the size from a button can move focus here: it scrolls the readout
  // into view and has screen readers announce the new numbers.
  const readout = h(
    'dl',
    { class: 'sm-result__readout', attrs: { tabindex: '-1' } },
    dimension(t('result.width'), widthNumber),
    dimension(t('result.height'), heightNumber),
  );
  const chipSlot = h('span', { class: 'sm-result__chip' });
  const noteEl = h('p', { class: 'sm-result__note sm-small sm-muted', text: note });
  const adjustedNote = h('p', { class: 'sm-result__note sm-small sm-muted' });
  const manualText = h('p', { class: 'sm-small sm-muted' });
  const manualNote = h(
    'div',
    { class: 'sm-result__manual-note' },
    manualText,
    ui.button(restoreLabel, { variant: 'ghost', size: 'sm', full: false, icon: 'refresh', onClick: onRestore }),
  );
  const el = addClass(
    ui.card(null, readout, h('div', { class: 'sm-result__meta' }, chipSlot), noteEl, adjustedNote, manualNote),
    'sm-result__hero',
  );

  return {
    el,
    /**
     * @param {{ size: object, adjusted: string, restore: string }} view
     *   adjusted: the fitting-allowance note ('' hides it); restore: the "our estimate was" line
     */
    render({ size, adjusted, restore }) {
      const manual = size.source === 'manual';
      widthNumber.textContent = ui.fmtMm(size.widthMm);
      heightNumber.textContent = ui.fmtMm(size.heightMm);
      chipSlot.replaceChildren(
        manual
          ? ui.chip(t('result.manualChip'), { tone: 'neutral', icon: 'edit' })
          : ui.chip(chipText, { tone: 'neutral', icon: chipIcon }),
      );
      // A size the customer typed in is theirs: the estimate's caveats are not about it.
      noteEl.hidden = manual;
      adjustedNote.textContent = adjusted;
      adjustedNote.hidden = manual || adjusted === '';
      manualText.textContent = restore;
      manualNote.hidden = !manual;
    },
    reveal() {
      readout.focus();
      el.scrollIntoView?.({ block: 'nearest' });
    },
  };
}

/** A card of plain-English lines, one per issue; null when there are none. */
function createIssues(ctx, { title, lines }) {
  const { ui } = ctx;
  const { h } = ui;
  if (!lines.length) return null;
  return addClass(
    ui.card(
      // 'fair' is the warning tone: each line is something to fix. Whether the size itself can be trusted
      // is the banner's job, not this card's: an estimate with not_rectangular or door_near_edge is also
      // not confident (js/estimate.js), so estimateBannerKey shows the unsure banner above it.
      { dataset: { level: 'fair' } },
      h('h2', { class: 'sm-result__issues-title', text: title }),
      h(
        'ul',
        { class: 'sm-result__issue-list' },
        lines.map((line) => h('li', { class: 'sm-result__issue' }, ui.icon('alert', 18), h('span', { text: line }))),
      ),
    ),
    'sm-result__issues',
  );
}

/** The fix-it buttons row. */
function createTools(ctx, tools) {
  const { ui, t } = ctx;
  return ui.h(
    'div',
    { class: 'sm-result__tools' },
    tools.map((tool) =>
      ui.button(t(tool.label), { variant: 'secondary', icon: tool.icon, onClick: () => ctx.go(tool.target) }),
    ),
  );
}

/**
 * What both modes do with the size: the tape override, "Get my price", and the 'measured' event for a
 * size chosen here. Each mode supplies its readout (`hero`), how to show the current size (`render`)
 * and the size the measuring screen announced, and calls choose() when the customer picks a size.
 *
 * @param {object} ctx
 * @param {{ hero: { reveal(): void }, announced: object, render: () => void }} options
 * @returns {{ override: HTMLElement | null, actions: HTMLElement, choose(size: object, opts?: { reveal?: boolean }): void, render(): void }}
 */
function createSizeFlow(ctx, { hero, announced, render }) {
  const { ui, t, state, config } = ctx;
  const { h } = ui;

  // The measuring screen emitted 'measured' for `announced`; arriving with another size means it was
  // chosen here on an earlier visit, and going ahead with it says so again (harmless if repeated).
  let announceOnContinue = !sameSize(state.size, announced);
  // True while the tape-override fields hold numbers that have not been applied yet.
  let overrideDirty = false;

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
          h('p', { class: 'sm-small sm-muted', text: t('result.standard.override.hint') }),
          overrideForm.el,
          ui.button(t('result.override.apply'), { variant: 'secondary', icon: 'check', onClick: applyOverride }),
        ),
      ),
      'sm-result__disclosure',
    );
  }

  const actions = ui.actionBar(ui.button(t('result.continue'), { iconEnd: 'arrow-right', onClick: goToQuote }));

  function choose(size, { reveal = false } = {}) {
    state.size = { ...size };
    // Typed numbers stay in the fields, but the customer has just chosen another size over them.
    overrideDirty = false;
    announceOnContinue = true;
    render();
    if (reveal) hero.reveal();
  }

  /** Validate the tape-override fields and, when they hold a usable size, make it state.size. */
  function commitOverride() {
    const values = overrideForm.submit();
    if (!values) return false;
    choose({ ...values, source: 'manual' });
    return true;
  }

  function applyOverride() {
    if (commitOverride()) hero.reveal();
  }

  function goToQuote() {
    // Numbers typed into the open tape override but never applied would otherwise be dropped
    // without a word: going ahead means "use what I typed" (or shows what is wrong with it).
    const pendingOverride = overrideDirty && override?.open && !overrideForm.isEmpty();
    if (pendingOverride && !commitOverride()) return;
    if (announceOnContinue) announceMeasured(ctx);
    ctx.go('quote');
  }

  return { override, actions, choose, render };
}

/* ------------------------------------------------------------------ */
/* Estimate mode: one photo, nearest standard size                     */
/* ------------------------------------------------------------------ */

/**
 * Build the estimate mode inside `root` (state.measure.method === 'estimate'). The measure must offer
 * at least one size (estimateChoices); result.js's resultMode() sends anything else to manual entry.
 * @param {HTMLElement} root  the empty screen <section>
 * @param {object} ctx  app context
 * @returns {() => void} cleanup
 */
export function mountEstimate(root, ctx) {
  const { ui, t, state, config } = ctx;
  const { h } = ui;
  const measure = state.measure;
  const choices = estimateChoices(measure);
  const sizeOf = (choice) => ({ ...applyRules(config.measurement, choice), source: 'estimate', standard: true });
  const offered = choices.map(sizeOf);
  const vars = (size) => ({ width: ui.fmtMm(size.widthMm), height: ui.fmtMm(size.heightMm) });

  // Keep a size chosen on an earlier visit (one of the offered sizes, or one typed in); anything
  // else starts from the most likely size, which is what the door screen announced.
  let shown = state.size?.source === 'estimate' ? offered.findIndex((size) => sameSize(size, state.size)) : -1;
  if (shown < 0) {
    shown = 0;
    if (state.size?.source !== 'manual') state.size = { ...offered[0] };
  }

  const header = ui.screenHeader({ title: t('result.title'), subtitle: t('result.estimate.subtitle') });

  const hero = createHero(ctx, {
    chipText: t('result.estimate.chip'),
    chipIcon: 'info',
    note: t('result.estimate.note'),
    restoreLabel: t('result.estimate.useEstimate'),
    onRestore: () => flow.choose(offered[shown], { reveal: true }),
  });

  const bannerKey = estimateBannerKey(measure, choices.length);
  const banner = bannerKey ? addClass(ui.banner(t(bannerKey), { tone: 'warning' }), 'sm-result__banner') : null;

  /* "Which is your door?": only worth asking when the photo fits more than one size */
  const picker =
    choices.length > 1
      ? ui.radioCards({
          ariaLabel: t('result.estimate.choices.title'),
          options: choices.map((choice, index) => ({
            value: choice.key,
            title: t('result.size', vars(choice)),
            badge: t(choiceBadgeKey(index)),
          })),
          value: state.size.source === 'manual' ? null : choices[shown].key,
          onChange: (key) => {
            const index = choices.findIndex((choice) => choice.key === key);
            if (index < 0) return;
            shown = index;
            // Not revealed: focus stays in the radio group so the arrow keys keep working.
            flow.choose(offered[index]);
            drawPreview();
          },
        })
      : null;
  const choicesCard = picker
    ? addClass(
        ui.card(
          null,
          h('h2', { class: 'sm-result__section-title', text: t('result.estimate.choices.title') }),
          h('p', { class: 'sm-result__section-hint sm-small sm-muted', text: t('result.estimate.choices.hint') }),
          picker.el,
        ),
        'sm-result__choices',
      )
    : null;

  const issuesCard = createIssues(ctx, {
    title: t('result.estimate.issues.title'),
    lines: estimateIssueKeys(measure).map((key) => t(key)),
  });

  const preview = createPreview(ui, { caption: t('result.estimate.preview.caption') });

  const tools = createTools(ctx, resultTools('estimate', { isDemo: isDemoPhoto(state.photo), methods: config.measurement?.methods }));
  const paperLink = offersPaper(config)
    ? addClass(
        ui.button(t('result.estimate.paper'), { variant: 'ghost', size: 'sm', icon: 'paper', onClick: () => ctx.go('prepare') }),
        'sm-result__paper',
      )
    : null;

  const flow = createSizeFlow(ctx, {
    hero,
    // The door screen announced the most likely size.
    announced: offered[0],
    render: () => {
      const manual = state.size.source === 'manual';
      const choice = choices[shown];
      hero.render({
        size: state.size,
        adjusted: hasAdjustment(config) ? t('result.standard.adjusted', vars(choice)) : '',
        restore: t('result.estimate.manualNote', vars(choice)),
      });
      picker?.setValue(manual ? null : choice.key);
    },
  });

  /** Flatten the photo to the size on show, so the customer can see whether its outline fits. */
  function drawPreview() {
    const choice = choices[shown];
    let plane = null;
    try {
      plane = { planeToImage: planeToImageFor(measure.corners, choice.widthMm, choice.heightMm), ...choice };
    } catch (error) {
      console.warn('[SecureMeasure] Could not map the door for the preview.', error);
    }
    preview.draw(state.photo?.image, plane, {
      widthLabel: formatLength(choice.widthMm),
      heightLabel: formatLength(choice.heightMm),
      alt: t('result.estimate.preview.alt', vars(choice)),
    });
  }

  flow.render();
  root.append(
    ...[header, hero.el, banner, choicesCard, issuesCard, preview.el, tools, paperLink, flow.override, flow.actions].filter(
      Boolean,
    ),
  );
  drawPreview();

  return () => preview.destroy();
}

/* ------------------------------------------------------------------ */
/* AR mode: measured with the phone's AR camera                        */
/* ------------------------------------------------------------------ */

/**
 * Build the AR mode inside `root` (state.measure.method === 'ar', with a measured width and height;
 * result.js's resultMode() checks).
 * @param {HTMLElement} root  the empty screen <section>
 * @param {object} ctx  app context
 * @returns {undefined}
 */
export function mountAr(root, ctx) {
  const { ui, t, state, config } = ctx;
  const { h } = ui;
  const measure = state.measure;
  const vars = (size) => ({ width: ui.fmtMm(size.widthMm), height: ui.fmtMm(size.heightMm) });

  // `measured` is what the AR screen set and announced; `opening` is the bare measured opening
  // (rounded only), which the notes describe.
  const measured = { ...applyRules(config.measurement, measure), source: 'ar', standard: false };
  const opening = openingOf(config.measurement, measure);
  const standardOpening = closestStandard(measure);
  const standard = standardOpening
    ? { ...applyRules(config.measurement, standardOpening), source: 'ar', standard: true }
    : null;

  // Keep a size typed in, or the standard size when it is still on offer; otherwise the measurement.
  const keep = state.size?.source === 'manual' || (standard !== null && sameSize(state.size, standard));
  if (!keep) state.size = { ...measured };

  const header = ui.screenHeader({ title: t('result.title'), subtitle: t('result.ar.subtitle') });

  const hero = createHero(ctx, {
    chipText: t('result.ar.chip'),
    chipIcon: 'phone',
    note: t('result.ar.note'),
    restoreLabel: t('result.ar.useMeasurement'),
    onRestore: () => flow.choose(measured, { reveal: true }),
  });

  const warningsCard = createIssues(ctx, {
    title: t('result.ar.warnings.title'),
    lines: arWarningKeys(measure).map((key) => t(key)),
  });

  /* Closest standard size, or why there is none */
  let toggle = null;
  let standardCard = null;
  if (standard) {
    const title = t('result.ar.standard.title', vars(standardOpening));
    toggle = ui.segmented({
      ariaLabel: title,
      options: [
        { value: 'standard', label: t('result.ar.useStandard'), hint: t('result.size', vars(standardOpening)) },
        { value: 'measured', label: t('result.ar.useMeasured'), hint: t('result.size', vars(opening)) },
      ],
      value: toggleValue(),
      // Not revealed: focus stays on the choice so the arrow keys keep working.
      onChange: (value) => flow.choose(value === 'standard' ? standard : measured),
    });
    standardCard = addClass(
      ui.card(
        null,
        h('h2', { class: 'sm-result__section-title', text: title }),
        h('p', { class: 'sm-result__section-hint sm-small sm-muted', text: t('result.ar.standard.hint') }),
        toggle.el,
      ),
      'sm-result__standard',
    );
  }
  const nonStandard = standard ? null : addClass(ui.banner(t('result.ar.nonStandard'), { tone: 'info' }), 'sm-result__banner');

  const tools = createTools(ctx, resultTools('ar', { methods: config.measurement?.methods }));

  const flow = createSizeFlow(ctx, {
    hero,
    announced: measured,
    render: () => {
      const usingStandard = state.size.source === 'ar' && state.size.standard === true;
      let adjusted = '';
      if (hasAdjustment(config)) {
        adjusted = usingStandard ? t('result.standard.adjusted', vars(standardOpening)) : t('result.adjusted', vars(opening));
      }
      hero.render({ size: state.size, adjusted, restore: t('result.ar.manualNote', vars(opening)) });
      toggle?.setValue(toggleValue());
    },
  });

  function toggleValue() {
    if (state.size.source === 'manual') return null;
    return state.size.standard === true ? 'standard' : 'measured';
  }

  flow.render();
  root.append(...[header, hero.el, warningsCard, standardCard, nonStandard, tools, flow.override, flow.actions].filter(Boolean));
  return undefined;
}
