/**
 * Result screen (step 3).
 *
 * Four modes share this screen, picked by resultMode() from how the door was measured:
 *  - paper (this module): state.measure came from the sheet of paper on the door, so we show the
 *    size read from the photo, how far to trust it, a flattened preview to sanity-check the
 *    outline, and an optional tape override;
 *  - estimate and ar (js/screens/result-standard.js): no paper, so the size is an estimate matched
 *    to the company's standard sizes (one photo) or measured with the phone's AR camera;
 *  - manual entry (this module): the customer chose "I already know my door size", so we only ask
 *    for the two numbers.
 * Every mode leaves state.size holding the size the quote is priced from.
 */
import { QUALITY_THRESHOLDS } from '../geometry.js';
import { getSheetMm } from '../photo.js';
import { formatLength } from '../quote.js';
import { measurementMethods } from '../theme.js';
import {
  addClass,
  announceMeasured,
  applyRules,
  createSizeForm,
  estimateChoices,
  hasAdjustment,
  mountAr,
  mountEstimate,
  strings as standardStrings,
} from './result-standard.js';
import { createPreview } from './result-preview.js';

/** Screen id used by the router. */
export const id = 'result';

/** Progress step this screen belongs to. */
export const step = 3;

/**
 * Default copy for this screen (all four modes); any key can be overridden through config.text.
 * The estimate and AR modes' own copy is merged in from result-standard.js, so the app's string
 * table, which is built from each screen's `strings`, holds it too.
 */
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
  'result.issue.orientation_unclear':
    'We could not tell whether the paper is upright or on its side in this photo, so the size could be a long way out. Stand square to the door and retake the photo.',
  'result.issue.high_uncertainty':
    'This photo does not let us measure very precisely. Tape the paper about halfway up the door, step in until the door just fills the photo, and retake it.',
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
  'result.manual.usePaper': 'Measure with a sheet of paper instead',

  ...standardStrings,
};

/**
 * Route guard: the screen needs either a photo measurement or the manual-entry choice.
 * @param {object} state shared app state
 * @returns {boolean}
 */
export function canEnter(state) {
  return Boolean(state && (state.measure || state.manualEntry));
}

const isLength = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

/**
 * Which mode the screen shows. measure.method tells the ways of measuring apart; a measure with no
 * method is the paper one (it predates the others). A no-paper measure with no usable size, which
 * the measuring screens never produce, falls back to asking for the size rather than showing blanks.
 *
 * @param {object} state shared app state
 * @returns {'paper' | 'estimate' | 'ar' | 'manual'}
 */
export function resultMode(state) {
  const measure = state?.measure;
  if (!measure) return 'manual';
  if (measure.method === 'estimate') return estimateChoices(measure).length > 0 ? 'estimate' : 'manual';
  if (measure.method === 'ar') return isLength(measure.widthMm) && isLength(measure.heightMm) ? 'ar' : 'manual';
  return 'paper';
}

/**
 * The manual-entry screen's way back to measuring, as config.measurement.methods allows: the no-paper
 * camera (where the welcome screen's "Measure with my camera" goes) when it is on, else the paper
 * method, else none. Each target has its own copy, so the same words always lead to the same screen.
 *
 * @param {object} config the merged config
 * @returns {{ target: 'capture' | 'prepare', label: string, icon: string } | null}
 */
export function manualAlternative(config) {
  const methods = measurementMethods(config);
  if (methods.camera) return { target: 'capture', label: 'result.manual.useCamera', icon: 'camera' };
  if (methods.paper) return { target: 'prepare', label: 'result.manual.usePaper', icon: 'paper' };
  return null;
}

/**
 * Build the screen inside `root`.
 * @param {HTMLElement} root the empty <section> for this screen
 * @param {object} ctx app context (config, t, state, go, ui, ...)
 * @returns {(() => void) | undefined} cleanup function
 */
export function mount(root, ctx) {
  switch (resultMode(ctx.state)) {
    case 'estimate':
      return mountEstimate(root, ctx);
    case 'ar':
      return mountAr(root, ctx);
    case 'paper':
      return mountMeasured(root, ctx);
    default:
      return mountManualEntry(root, ctx);
  }
}

/* ------------------------------------------------------------------ */
/* Paper and manual-entry helpers                                      */
/* (the size form and the 'measured' event are in result-standard.js)  */
/* ------------------------------------------------------------------ */

const QUALITY = {
  good: { tone: 'success', icon: 'check' },
  fair: { tone: 'warning', icon: 'info' },
  rough: { tone: 'warning', icon: 'alert' },
  poor: { tone: 'danger', icon: 'alert' },
};

// measureDoor grades a photo 'poor' for two very different reasons. These issues mean the size
// cannot be trusted (a marker is probably on the wrong thing, or the paper could be either way
// round, which makes the answer one of two sizes a long way apart), so the customer is steered
// back to fix it. A wide "plus or minus" on its own (sheet corners placed by hand, a distant or
// angled photo) is common with honest photos, is still an estimate a check measure will confirm,
// and is often not something a retake would improve: that one is shown as 'rough' and lets them
// go on.
const UNTRUSTED_ISSUES = new Set(['high_residual', 'implausible_size', 'methods_disagree', 'orientation_unclear']);

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

/**
 * True when measureDoor could not safely tell an upright sheet from one on its side, and the two
 * possible sizes are far enough apart to matter. Under QUALITY_THRESHOLDS.orientationMinMargin it
 * folds half the gap between them into the sigmas, and that is read here from what it leaves
 * behind: a 'poor' grade with 'high_uncertainty' and a low fit.orientationMargin. Unlike an honest
 * wide "plus or minus", the size is then a coin flip between two answers, and a square-on retake
 * does fix it. A nearly square sheet (a custom 300 x 302 mm, say) can never be told either way
 * round, but its two answers are only millimetres apart: when that half-gap is within
 * QUALITY_THRESHOLDS.poorSigmaMm the wide "plus or minus" comes from somewhere else (sheet corners
 * placed by hand) and the result stays an ordinary rough one.
 *
 * @param {object} measure  measureDoor's result
 * @param {string} graded  measure.quality.level
 * @param {string[]} issueCodes  measure.quality.issues
 * @param {{ w: number, h: number }} sheetMm  the reference sheet it was measured with (getSheetMm)
 * @returns {boolean}
 */
export function orientationUnclear(measure, graded, issueCodes, sheetMm) {
  // Nothing to work out if the measurement names the problem itself.
  if (issueCodes.includes('orientation_unclear')) return true;
  const margin = measure.fit?.orientationMargin;
  const undecided =
    graded === 'poor' &&
    issueCodes.includes('high_uncertainty') &&
    // null for a square sheet, where there is no choice to make: only a real number counts.
    typeof margin === 'number' &&
    margin < QUALITY_THRESHOLDS.orientationMinMargin;
  if (!undecided) return false;
  // Turning the sheet round scales the door by about the sheet's long-to-short ratio, so the two
  // answers are about (ratio - 1) x the door's longer side apart.
  const ratio = Math.max(Number(sheetMm?.w), Number(sheetMm?.h)) / Math.min(Number(sheetMm?.w), Number(sheetMm?.h));
  const halfGapMm = ((ratio - 1) * Math.max(Number(measure.widthMm), Number(measure.heightMm))) / 2;
  // An unknown sheet size (NaN) keeps the cautious answer.
  return !(halfGapMm <= QUALITY_THRESHOLDS.poorSigmaMm);
}

/** "±N mm" figure: two sigma of the worse dimension, never claiming better than 2 mm. */
function accuracyFromSigmas(measure) {
  const sigma = Math.max(Number(measure.sigmaWidthMm), Number(measure.sigmaHeightMm));
  return Number.isFinite(sigma) ? Math.max(2, Math.ceil(2 * sigma)) : null;
}

/* ------------------------------------------------------------------ */
/* Paper mode: measured from the photo with the sheet of paper         */
/* ------------------------------------------------------------------ */

function mountMeasured(root, ctx) {
  const { ui, t, state, config } = ctx;
  const { h } = ui;
  const measure = state.measure;
  const graded = ['good', 'fair', 'poor'].includes(measure.quality?.level) ? measure.quality.level : 'fair';
  const reportedCodes = Array.isArray(measure.quality?.issues) ? [...new Set(measure.quality.issues)] : [];
  // An undecided sheet orientation is why the "plus or minus" is wide, so its own tip goes first
  // and stands in for the general one.
  const issueCodes = orientationUnclear(measure, graded, reportedCodes, getSheetMm(state, config))
    ? ['orientation_unclear', ...reportedCodes.filter((code) => code !== 'orientation_unclear' && code !== 'high_uncertainty')]
    : reportedCodes;
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
  // 'good' or 'fair' with no issue code is what a clean, straight-on photo scores with hand-placed
  // door corners (the bundled demo grades good), so there is nothing to tell that customer to redo.
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
  const preview = createPreview(ui, { caption: t('result.preview.caption') });

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
  root.append(...[header, hero, issuesCard, preview.el, tools, override, actions].filter(Boolean));

  // Drawn once the screen has painted, so the numbers never wait for the warp; hidden when the
  // photo or the measured door rectangle is missing.
  preview.draw(state.photo?.image, measure, {
    widthLabel: formatLength(opening.widthMm),
    heightLabel: formatLength(opening.heightMm),
    alt: t('result.preview.alt', openingVars),
  });

  return () => preview.destroy();
}

/* ------------------------------------------------------------------ */
/* Manual entry: the customer types the size in                        */
/* ------------------------------------------------------------------ */

function mountManualEntry(root, ctx) {
  const { ui, t, state, config } = ctx;
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

  const alternative = manualAlternative(config);
  const measureInstead = alternative
    ? ui.button(t(alternative.label), {
        variant: 'ghost',
        icon: alternative.icon,
        onClick: () => {
          state.manualEntry = false;
          ctx.go(alternative.target);
        },
      })
    : null;

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
    ui.actionBar(getPrice, measureInstead),
  );
  return undefined;
}
