/**
 * Result screen (step 3), the two no-paper modes, plus the building blocks every result mode shares.
 *
 *  - estimate: one photo, no paper. The door's corners give its height-to-width ratio, and that ratio
 *    is matched to the company's catalogue of standard sizes (js/estimate.js). A photo with no scale in
 *    it cannot give real millimetres, so this mode never shows any: it shows the nearest standard
 *    size, lets the customer pick between the few sizes that fit the photo (each labelled with its
 *    height, 'Standard height', 'Tall' or 'Extra tall', when they differ in height by enough to see),
 *    and says plainly that a check measure confirms it.
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
import { planeToImageFor, standardSizesFrom } from '../estimate.js';
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
  // Which of the company's heights each size on the list is (heightFamilies): the lowest heights in the
  // catalogue, the next ones up that look taller, and anything above those. Shown only when the sizes on
  // the list differ in height by that much (choiceHeightFamilies).
  'result.estimate.height.standard': 'Standard height',
  'result.estimate.height.tall': 'Tall',
  'result.estimate.height.extraTall': 'Extra tall',
  // A size's badge with its height ('Most likely · Standard height'). The no-break space keeps the dot
  // from starting a line when the badge wraps on a narrow phone.
  'result.estimate.badgeWithHeight': '{badge} · {height}',
  // Unsure between sizes of about the same height: nothing the customer can check at a glance.
  'result.estimate.unsure':
    "We can't be sure between these sizes from one photo. Pick the one that looks most like your door. We confirm the exact size with a check measure.",
  // Unsure between sizes of different heights, which the customer can tell apart by looking at the door:
  // one question for each set of heights the list can hold, naming only the heights on it.
  'result.estimate.unsureHeight.standardTall':
    'Is your door a standard height or tall? Pick the one that matches. We confirm the exact size with a check measure.',
  'result.estimate.unsureHeight.standardExtraTall':
    'Is your door a standard height or extra tall? Pick the one that matches. We confirm the exact size with a check measure.',
  'result.estimate.unsureHeight.tallExtraTall':
    'Is your door tall or extra tall? Pick the one that matches. We confirm the exact size with a check measure.',
  'result.estimate.unsureHeight.standardTallExtraTall':
    'Is your door a standard height, tall or extra tall? Pick the one that matches. We confirm the exact size with a check measure.',
  'result.estimate.unsureOne':
    "We can't match your door to a standard size with confidence from this photo. Check the corners, or retake the photo standing square to the door.",
  // The same three for the bundled demo photo (welcome's "Try it with a demo photo"). Its visitor has never
  // seen the demo door, so cannot say which height it is or which size looks like it; and the demo photo
  // cannot be retaken (resultTools offers Measure my own door instead). Each says what is unsure, what a
  // customer does about it with their own door, and that there is nothing to answer here.
  'result.estimate.demo.unsureHeight':
    "We can't be sure of the height from one photo. With a photo of your own door, you would pick the height that matches what you see. This is our demo door, so you don't need to pick. We confirm the exact size with a check measure.",
  'result.estimate.demo.unsure':
    "We can't be sure between these sizes from one photo. With a photo of your own door, you would pick the one that looks most like it. This is our demo door, so you don't need to pick. We confirm the exact size with a check measure.",
  'result.estimate.demo.unsureOne':
    "We can't match our demo door to a standard size with confidence from this photo. Tap Adjust corners to check them, or tap Measure my own door to try it with yours.",
  // The demo photo's list of sizes, which sits right under those banners. They say there is nothing to
  // pick, so it is not headed "Which is your door?": it shows what a customer's own photo would offer,
  // and the visitor can still try picking one.
  'result.estimate.demo.choices.title': 'Sizes our demo door could be',
  'result.estimate.demo.choices.hint':
    'These standard sizes fit our demo photo best. With a photo of your own door, you would pick the one that looks right; here you can try any of them.',
  'result.estimate.nonStandard':
    'Your door may not be a standard size, so this estimate could be some way out. We measure it exactly at the check measure, before anything is made.',
  'result.estimate.issues.title': 'How to get a better estimate',
  'result.estimate.issue.not_rectangular':
    "The corners don't quite make a rectangle. Tap Adjust corners and put each one exactly where the door meets the frame.",
  'result.estimate.issue.steep_angle':
    'The photo was taken on an angle, which makes the estimate less certain. Stand square to the door, hold your phone upright and retake it.',
  // The same issue for a photo the customer picked (measure.focalSource '..._file'), where it means a lens or
  // a crop the photo may really have would change the answer, or (seen 10+ deg from the side) take away a
  // sure match; the ordinary downward tilt alone does not set it (estimateIssueKeys). One line for each
  // thing that is unsure about the photo: with no EXIF ('prior_file': iOS's camera app strips it) the lens
  // is unknown; with EXIF ('exif_file') the lens is named but the photo may since have been cropped or
  // zoomed. Each in two forms: the camera on the
  // Retake photo screen is a known lens, so it is offered when it has worked on this phone ('...file' and
  // '...crop'); where it has not (camera blocked, an in-app browser), the camera app is the only way to
  // retake the photo, so the '..._app' lines say how to take it there instead.
  'result.estimate.issue.steep_angle_file':
    "We can't tell which lens took this photo, and at this angle that matters. For a better estimate, tap Retake photo, stand square to the door and take it with the camera there.",
  'result.estimate.issue.steep_angle_file_app':
    "We can't tell which lens took this photo, and at this angle that matters. For a better estimate, take it again with your camera app: stand square to the door, hold your phone upright, use the 1x lens and don't zoom or crop.",
  'result.estimate.issue.steep_angle_crop':
    "We can't tell whether this photo was cropped or zoomed, and at this angle that matters. For a better estimate, tap Retake photo, stand square to the door and take it with the camera there.",
  'result.estimate.issue.steep_angle_crop_app':
    "We can't tell whether this photo was cropped or zoomed, and at this angle that matters. For a better estimate, take it again with your camera app: stand square to the door, hold your phone upright, use the 1x lens and don't zoom or crop.",
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

/* Height families ---------------------------------------------------- */

/** The height families, lowest first: the catalogue's lowest heights, the next, and all the rest. */
export const HEIGHT_FAMILIES = Object.freeze(['standard', 'tall', 'extraTall']);

/**
 * Catalogue heights less than this apart look the same on a door, so they are one family. The
 * families are there to ask a question the customer can answer by looking at the door, without a
 * tape: 2040 against 2340 mm (300 mm, about 15 %) is plain to see, but 2040 against 2100 (the
 * Australian standard and its taller size, 60 mm or 3 %) or 2032 against 2134 (80 in and 7 ft, 102 mm
 * or 5 %) is not, and labelling those 'Standard height' and 'Tall' would steer a customer whose door
 * looks ordinary to the shorter size whatever its real height.
 */
export const HEIGHT_FAMILY_MERGE_MM = 150;

/**
 * A size's height counts as one of the catalogue's heights when it is within this of it (heightFamilyOf).
 * Every size the estimate offers is a catalogue size, so this only keeps a label off a height that is
 * not, where it would be a guess.
 */
export const HEIGHT_MATCH_MM = 20;

/**
 * The catalogue's height families, lowest first.
 *
 * Most of the doubt a no-paper photo leaves is between sizes of nearly the same shape: 820 x 2040,
 * the most common Australian door, is within about 2 % of 920 x 2340 in height-to-width ratio, so it
 * is almost never matched with confidence. Those sizes differ mostly in height, though, and whether a
 * door is a standard height or 300 mm taller is something the customer can tell at a glance. So each
 * size on the list says which of the company's heights it is, and the banner asks that question, when
 * the sizes on the list differ in height by that much (choiceHeightFamilies).
 *
 * The families come from the company's own distinct heights (standardSizesFrom(config)), grouped so
 * that heights which look the same are one family (HEIGHT_FAMILY_MERGE_MM): the lowest group is
 * 'standard', the next 'tall', and every group above that 'extraTall'. So the Australian catalogue's
 * 2040 and 2100 are both 'standard' and 2340 is 'tall'. A catalogue whose heights all look the same
 * has no families, and the list then shows no height labels.
 *
 * Each height joins the group of the next one down when the two are less than HEIGHT_FAMILY_MERGE_MM
 * apart, so heights in two different families are always at least that far apart: a label or a
 * question never splits two sizes the customer cannot tell apart. A run of close heights (2040, 2100,
 * 2160 ...) is therefore one family even where its ends differ by more, and its sizes go unlabelled
 * rather than labelled by a difference nobody can see.
 *
 * @param {unknown} sizes  the catalogue, [{ widthMm, heightMm }]
 * @returns {Array<{ id: 'standard' | 'tall' | 'extraTall', heightsMm: number[] }>}  [] for one height
 */
export function heightFamilies(sizes) {
  const heights = [...new Set((Array.isArray(sizes) ? sizes : []).map((size) => Number(size?.heightMm)))]
    .filter(isLength)
    .sort((a, b) => a - b);
  const groups = [];
  for (const heightMm of heights) {
    const group = groups[groups.length - 1];
    if (group && heightMm - group[group.length - 1] < HEIGHT_FAMILY_MERGE_MM) group.push(heightMm);
    else groups.push([heightMm]);
  }
  if (groups.length < 2) return [];
  return [groups[0], groups[1], groups.slice(2).flat()]
    .map((heightsMm, index) => ({ id: HEIGHT_FAMILIES[index], heightsMm }))
    .filter((family) => family.heightsMm.length > 0);
}

/**
 * The height family of a size on the list: the family of the nearest catalogue height, or null when
 * the catalogue has one height (no families) or the height is not one of its heights, give or take
 * HEIGHT_MATCH_MM (a label would then be a guess).
 *
 * @param {number} heightMm  a choice's height (estimateChoices: a catalogue height)
 * @param {ReturnType<typeof heightFamilies>} families
 * @returns {'standard' | 'tall' | 'extraTall' | null}
 */
export function heightFamilyOf(heightMm, families) {
  const height = Number(heightMm);
  if (!isLength(height) || !Array.isArray(families)) return null;
  let best = null;
  let bestGap = Infinity;
  for (const family of families) {
    for (const familyHeight of Array.isArray(family?.heightsMm) ? family.heightsMm : []) {
      const gap = Math.abs(familyHeight - height);
      if (gap < bestGap) {
        best = family.id;
        bestGap = gap;
      }
    }
  }
  return bestGap <= HEIGHT_MATCH_MM && HEIGHT_FAMILIES.includes(best) ? best : null;
}

/**
 * The height label each size on the list shows (heightFamilyOf), or none at all when the sizes on
 * offer are all of one family. A label is there to tell the sizes apart by something the customer can
 * see; on a list of one height it would tell them apart by nothing, and the banner then asks no height
 * question either (heightQuestionKey). The labels and the question always go together.
 *
 * @param {Array<{ heightMm: number }>} choices  estimateChoices(measure)
 * @param {ReturnType<typeof heightFamilies>} families  heightFamilies(the catalogue)
 * @returns {Array<'standard' | 'tall' | 'extraTall' | null>}  one per choice
 */
export function choiceHeightFamilies(choices, families) {
  const each = (Array.isArray(choices) ? choices : []).map((choice) => heightFamilyOf(choice?.heightMm, families));
  return heightQuestionKey(each) ? each : each.map(() => null);
}

/** The string key of a height family's label, or null for anything else. */
export function heightFamilyKey(family) {
  return HEIGHT_FAMILIES.includes(family) ? `result.estimate.height.${family}` : null;
}

/**
 * The badge text on choice `index` of "Which is your door?": 'Most likely' or 'Also possible', with the
 * size's height family when it has one ('Most likely · Standard height'). The badge is inside the
 * option's <label>, so screen readers read the height as part of the radio button's name.
 *
 * The height label's spaces are no-break spaces: on a 320 px phone the badge wraps, and it should
 * wrap after the dot ('Also possible ·' / 'Standard height'), never inside the height.
 *
 * @param {(key: string, vars?: object) => string} t  ctx.t
 * @param {number} index  the choice's place in the list
 * @param {string | null} [family]  the choice's entry in choiceHeightFamilies(choices, families)
 * @returns {string}
 */
export function choiceBadgeText(t, index, family = null) {
  const badge = t(choiceBadgeKey(index));
  const heightKey = heightFamilyKey(family);
  if (!heightKey) return badge;
  return t('result.estimate.badgeWithHeight', { badge, height: t(heightKey).replace(/ /g, ' ') });
}

// The height question for each set of families a list can span, keyed by the families in
// HEIGHT_FAMILIES order. Whole sentences rather than one assembled from parts, so each reads (and
// translates through config.text) naturally, and names only the heights the customer can pick.
const HEIGHT_QUESTIONS = Object.freeze({
  'standard tall': 'result.estimate.unsureHeight.standardTall',
  'standard extraTall': 'result.estimate.unsureHeight.standardExtraTall',
  'tall extraTall': 'result.estimate.unsureHeight.tallExtraTall',
  'standard tall extraTall': 'result.estimate.unsureHeight.standardTallExtraTall',
});

/**
 * The banner asking which height the door is, for the height families of the sizes on offer; null
 * when they are all one height (or have none), where asking would not help.
 *
 * @param {unknown} families  the family of each offered size (heightFamilyOf; null for none)
 * @returns {string | null} a string key
 */
export function heightQuestionKey(families) {
  const present = new Set(Array.isArray(families) ? families : []);
  const spanned = HEIGHT_FAMILIES.filter((family) => present.has(family));
  return spanned.length > 1 ? HEIGHT_QUESTIONS[spanned.join(' ')] : null;
}

/**
 * The warning banner the estimate shows, or null when it is confident. A door that matches no
 * standard size well is the bigger problem, so it wins over plain uncertainty. Uncertainty is worded
 * for whether there is a list of sizes to choose from and, when there is, whether the sizes on it
 * differ in height: that is a question the customer can answer by looking at the door, so it is asked
 * plainly (heightFamilies explains why this is the usual case).
 *
 * The bundled demo photo (`isDemo`) gets the 'result.estimate.demo.' form of each unsure banner: its
 * visitor has never seen the demo door, so a question about "your door" is one only we could answer. It
 * is the usual demo outcome, not a rare one: corners left where detection put them are measured with
 * detection's error, and on the demo photo that leaves 820 x 2040 short of the estimate's confidence. The
 * demo copy still says the estimate is unsure, and what a customer would do about it with their own door.
 * 'nonStandard' is left as it is: it is about the size the demo is priced at, not a question.
 *
 * @param {object} measure  the estimate measure
 * @param {number} choiceCount  estimateChoices(measure).length
 * @param {Array<string | null>} [choiceFamilies]  the height family of each choice (choiceHeightFamilies)
 * @param {{ isDemo?: boolean }} [options]  isDemo: the estimate came from the bundled demo photo
 * @returns {string | null} a string key
 */
export function estimateBannerKey(measure, choiceCount, choiceFamilies = [], { isDemo = false } = {}) {
  if (measure?.nonStandard === true) return 'result.estimate.nonStandard';
  if (measure?.confident === true) return null;
  const demo = isDemo === true;
  if (!(choiceCount > 1)) return demo ? 'result.estimate.demo.unsureOne' : 'result.estimate.unsureOne';
  const question = heightQuestionKey(choiceFamilies);
  if (demo) return question ? 'result.estimate.demo.unsureHeight' : 'result.estimate.demo.unsure';
  return question ?? 'result.estimate.unsure';
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

// 'steep_angle' on a picked photo, by its focalSource and by whether the live camera can retake it
// (see the strings above).
const STEEP_ANGLE_FILE_KEYS = Object.freeze({
  prior_file: { live: 'result.estimate.issue.steep_angle_file', app: 'result.estimate.issue.steep_angle_file_app' },
  exif_file: { live: 'result.estimate.issue.steep_angle_crop', app: 'result.estimate.issue.steep_angle_crop_app' },
});

/**
 * The estimate's issue lines (string keys).
 *
 * 'steep_angle' on a picked photo (focalSource 'exif_file' or 'prior_file', see photoFocal in
 * js/estimate.js) gets its own line: there the lens or a crop is unknown, and it means one the photo may
 * really have would change the answer, or (seen 10+ deg from the side) take away a sure match. (The
 * ordinary downward tilt of a phone aimed at the door's middle does not set it: see estimateFromCorners.)
 * Taking the photo with our own camera clears that unknown, but only when our camera works on this
 * phone: a customer whose browser blocked it, or an in-app browser that has none, picked the photo
 * because the camera app was the only way on, and Retake photo would only take them back there. So the camera here is offered only when it has gone
 * live (`liveCamera`, from state.liveCamera, which js/screens/capture.js sets); otherwise, and when that
 * is not known, the line says how to take a better photo with the camera app.
 *
 * @param {object | null | undefined} measure  the estimate measure
 * @param {{ liveCamera?: boolean }} [options]  liveCamera: the capture screen's live camera has worked
 * @returns {string[]}
 */
export function estimateIssueKeys(measure, { liveCamera = false } = {}) {
  const picked = STEEP_ANGLE_FILE_KEYS[measure?.focalSource];
  return issueKeys(measure?.issues, ESTIMATE_ISSUES, 'result.estimate.issue.').map((key) => {
    if (!picked || key !== 'result.estimate.issue.steep_angle') return key;
    return liveCamera === true ? picked.live : picked.app;
  });
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
      // not confident (js/estimate.js), so estimateBannerKey shows an unsure banner above it.
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

  // Which of the company's heights each offered size is: shown on the list, and an unsure estimate whose
  // sizes differ in height asks the customer which height their door is (heightFamilies explains why).
  // Neither when the sizes on offer all look the same height (choiceHeightFamilies).
  const choiceFamilies = choiceHeightFamilies(choices, heightFamilies(standardSizesFrom(config)));
  const isDemo = isDemoPhoto(state.photo);

  // The demo photo's banner asks nothing about "your door" (estimateBannerKey), and nor does the list of
  // sizes under it: that banner says there is nothing to pick, so a list headed "Which is your door?"
  // would ask the very question it has just said needs no answer. Its sizes keep their height labels,
  // which show what a customer's own photo would offer.
  const bannerKey = estimateBannerKey(measure, choices.length, choiceFamilies, { isDemo });
  const banner = bannerKey ? addClass(ui.banner(t(bannerKey), { tone: 'warning' }), 'sm-result__banner') : null;
  const choicesTitle = isDemo ? t('result.estimate.demo.choices.title') : t('result.estimate.choices.title');
  const choicesHint = isDemo ? t('result.estimate.demo.choices.hint') : t('result.estimate.choices.hint');

  /* "Which is your door?": only worth asking when the photo fits more than one size */
  const picker =
    choices.length > 1
      ? ui.radioCards({
          ariaLabel: choicesTitle,
          options: choices.map((choice, index) => ({
            value: choice.key,
            title: t('result.size', vars(choice)),
            badge: choiceBadgeText(t, index, choiceFamilies[index]),
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
          h('h2', { class: 'sm-result__section-title', text: choicesTitle }),
          h('p', { class: 'sm-result__section-hint sm-small sm-muted', text: choicesHint }),
          picker.el,
        ),
        'sm-result__choices',
      )
    : null;

  const issuesCard = createIssues(ctx, {
    title: t('result.estimate.issues.title'),
    lines: estimateIssueKeys(measure, { liveCamera: state.liveCamera === true }).map((key) => t(key)),
  });

  const preview = createPreview(ui, { caption: t('result.estimate.preview.caption') });

  const tools = createTools(ctx, resultTools('estimate', { isDemo, methods: config.measurement?.methods }));
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
