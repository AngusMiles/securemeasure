/**
 * Door screen (step 2): the customer drags four handles onto the corners of
 * the door opening, then we fit the sheet and the door together to get the
 * opening's width and height.
 */

import { measureDoor } from '../geometry.js';
import { applyMeasurementRules } from '../quote.js';
import { getSheetMm } from '../photo.js';
import {
  copyQuad,
  createMarkScreen,
  defaultDoorQuad,
  invalidateMeasurement,
  isQuad,
  sameQuad,
  themeColor,
} from './mark-common.js';

/** Screen id. */
export const id = 'door';
/** Progress step this screen belongs to. */
export const step = 2;

/** Default copy for this screen (override any key through config.text). */
export const strings = {
  'door.title': 'Mark the door opening',
  'door.banner': 'Drag each corner to a corner of the door opening, where the door meets the frame.',
  'door.measure': 'Measure my door',
  'door.back': 'Back to the sheet',
  'door.help.open': 'Where do the corners go?',
  'door.help.title': 'Where to put the corners',
  'door.help.diagram':
    'A door in its frame with a sheet of paper taped to it. The four corners of the door opening are highlighted. A corner of the outer trim is crossed out.',
  'door.help.opening':
    "Mark the door opening itself, where the door meets the frame. Don't mark the outer trim around it.",
  'door.help.plane':
    'All four corners need to sit on the same flat surface as the sheet of paper, so keep the door fully closed.',
  'door.help.close': 'Got it',
  'door.error.untouched': 'Drag the four corners onto your door opening first.',
  'door.error.not_convex':
    "Those corners don't make a door shape. Put one handle on each corner of the door opening, then try again.",
  'door.error.degenerate':
    "We couldn't work out a size from those corners. Check the corners of the paper and the door, then try again.",
  'door.error.no_convergence':
    "We couldn't get a steady measurement. Check each handle sits right on a corner of the door opening, then try again.",
  'door.editor.aria':
    'Your door photo. Drag the four corner handles onto the corners of the door opening.',
  'door.nudge.label': 'Fine-tune the selected corner',
  'door.nudge.up': 'Move the corner up',
  'door.nudge.down': 'Move the corner down',
  'door.nudge.left': 'Move the corner left',
  'door.nudge.right': 'Move the corner right',
  'door.fit': 'Show the whole photo',
};

const ERROR_KEYS = new Map([
  ['not_convex', 'door.error.not_convex'],
  ['degenerate', 'door.error.degenerate'],
  ['no_convergence', 'door.error.no_convergence'],
]);

const FALLBACK_ACCENT = '#f59e0b';
const FALLBACK_SUCCESS = '#16a34a';
const FALLBACK_PRIMARY = '#0f172a';
const ERROR_TOAST_MS = 6000;

// Static illustration, styled by classes in mark.css so it follows the skin.
// It carries no text: the wording lives in `strings`.
const HELP_DIAGRAM = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 272" focusable="false">
  <rect class="sm-mark__dg-wall" width="240" height="272" rx="14"/>
  <rect class="sm-mark__dg-trim" x="40" y="16" width="160" height="232"/>
  <rect class="sm-mark__dg-door" x="64" y="40" width="112" height="208"/>
  <rect class="sm-mark__dg-panel" x="80" y="56" width="76" height="78" rx="3"/>
  <rect class="sm-mark__dg-panel" x="80" y="160" width="76" height="72" rx="3"/>
  <rect class="sm-mark__dg-handle" x="162" y="140" width="7" height="24" rx="3.5"/>
  <line class="sm-mark__dg-floor" x1="14" y1="248" x2="226" y2="248"/>
  <rect class="sm-mark__dg-sheet" x="104" y="102" width="32" height="45" rx="1.5"/>
  <rect class="sm-mark__dg-tape" x="99" y="99" width="11" height="5" rx="1" transform="rotate(-40 104.5 101.5)"/>
  <rect class="sm-mark__dg-tape" x="130" y="99" width="11" height="5" rx="1" transform="rotate(40 135.5 101.5)"/>
  <rect class="sm-mark__dg-tape" x="99" y="145" width="11" height="5" rx="1" transform="rotate(40 104.5 147.5)"/>
  <rect class="sm-mark__dg-tape" x="130" y="145" width="11" height="5" rx="1" transform="rotate(-40 135.5 147.5)"/>
  <rect class="sm-mark__dg-outline" x="64" y="40" width="112" height="208"/>
  <path class="sm-mark__dg-wrong" d="M195 11l10 10M205 11l-10 10"/>
  <circle class="sm-mark__dg-ring" cx="64" cy="40" r="9"/>
  <circle class="sm-mark__dg-dot" cx="64" cy="40" r="3.5"/>
  <circle class="sm-mark__dg-ring" cx="176" cy="40" r="9"/>
  <circle class="sm-mark__dg-dot" cx="176" cy="40" r="3.5"/>
  <circle class="sm-mark__dg-ring" cx="176" cy="248" r="9"/>
  <circle class="sm-mark__dg-dot" cx="176" cy="248" r="3.5"/>
  <circle class="sm-mark__dg-ring" cx="64" cy="248" r="9"/>
  <circle class="sm-mark__dg-dot" cx="64" cy="248" r="3.5"/>
</svg>`.trim();

/**
 * The door screen needs a photo and a marked sheet. The stand-in rectangle the sheet screen shows
 * after a failed detection does not count until the customer has moved a corner (`placed`).
 * @param {object} state
 * @returns {boolean}
 */
export function canEnter(state) {
  return Boolean(state && state.photo && state.sheet && isQuad(state.sheet.points) && state.sheet.placed !== false);
}

/**
 * Colour of the door quad: a high-visibility green, unless the skin's accent
 * (used for the sheet outline drawn alongside it) is that same colour.
 * @param {object} config
 * @param {string} accent
 * @returns {string}
 */
function doorColor(config, accent) {
  const colors = config.brand?.colors ?? {};
  const success = themeColor('--sm-success', colors.success || FALLBACK_SUCCESS);
  if (success.toLowerCase() !== accent.toLowerCase()) return success;
  return themeColor('--sm-primary', colors.primary || FALLBACK_PRIMARY);
}

/**
 * Build the door screen.
 * @param {HTMLElement} root The empty screen <section>.
 * @param {object} ctx App context.
 * @returns {() => void} Cleanup.
 */
export function mount(root, ctx) {
  const { state, config, ui } = ctx;
  const t = (key, vars) => ctx.t(key, vars);
  const photo = state.photo;

  // Measuring the untouched starting rectangle would give a confident-looking
  // but meaningless size, so require at least one corner to have been placed.
  let touched = isQuad(state.door.points);
  // Where the handles were last put down, starting with what the editor is given. A press on a
  // handle that leaves it exactly there has placed nothing.
  let committed = touched ? copyQuad(state.door.points) : defaultDoorQuad(photo.width, photo.height);

  const accent = themeColor('--sm-accent', config.brand?.colors?.accent || FALLBACK_ACCENT);

  const measureBtn = ui.button(t('door.measure'), { icon: 'ruler', onClick: measure });
  // Not ctx.back(): after "Adjust corners" on the result screen the previous
  // history entry is that screen, not the sheet this button names.
  const backBtn = ui.button(t('door.back'), {
    variant: 'ghost',
    icon: 'arrow-left',
    onClick: () => ctx.go('sheet'),
  });

  const diagram = ui.svgFromString(HELP_DIAGRAM);
  diagram.classList.add('sm-mark__diagram');
  diagram.removeAttribute('aria-hidden');
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', t('door.help.diagram'));

  const guidance = (iconName, key) =>
    ui.h(
      'li',
      { class: 'sm-mark__help-item' },
      ui.h('span', { class: 'sm-mark__help-icon' }, ui.icon(iconName, 20)),
      ui.h('span', { class: 'sm-grow', text: t(key) }),
    );

  // The bottom sheet is appended to <body>, outside this screen's root, so its
  // content carries the sm-mark class itself to pick up the mark.css rules.
  const help = ui.bottomSheet(
    { title: t('door.help.title') },
    ui.h(
      'div',
      { class: 'sm-mark sm-mark--help' },
      diagram,
      ui.h(
        'ul',
        { class: 'sm-mark__help-list' },
        guidance('door', 'door.help.opening'),
        guidance('paper', 'door.help.plane'),
      ),
      ui.button(t('door.help.close'), { variant: 'secondary', onClick: () => help.close() }),
    ),
  );

  const helpBtn = ui.h(
    'button',
    {
      class: 'sm-mark__float sm-mark__fab',
      type: 'button',
      attrs: {
        'aria-label': t('door.help.open'),
        'aria-haspopup': 'dialog',
        title: t('door.help.open'),
      },
      on: { click: () => help.open() },
    },
    ui.icon('help', 22),
  );

  const mark = createMarkScreen(root, ctx, {
    title: t('door.title'),
    banner: { text: t('door.banner'), tone: 'info' },
    labels: {
      nudge: t('door.nudge.label'),
      up: t('door.nudge.up'),
      down: t('door.nudge.down'),
      left: t('door.nudge.left'),
      right: t('door.nudge.right'),
      fit: t('door.fit'),
    },
    actions: [measureBtn, backBtn],
    editor: {
      points: committed,
      color: doorColor(config, accent),
      ariaLabel: t('door.editor.aria'),
      ghost: { points: copyQuad(state.sheet.points), color: accent },
      onChange,
      onTap,
    },
  });
  mark.tools.append(helpBtn);

  function onChange(points, meta) {
    if (!meta.final || sameQuad(points, committed)) return;
    committed = points;
    touched = true;
    state.door.points = points;
    invalidateMeasurement(state);
  }

  function onTap() {
    // A tap on the photo lets go of the selected corner, which frees up any
    // handle sitting under the nudge pad.
    const editor = mark.editor;
    if (!editor) return;
    editor.setActive(null);
    mark.sync();
  }

  function measure() {
    const editor = mark.editor;
    if (!editor || !isQuad(state.sheet.points)) return;
    const points = editor.getPoints();
    if (!isQuad(points)) return;
    if (!touched) {
      ctx.toast(t('door.error.untouched'), { type: 'info' });
      return;
    }

    const m = config.measurement;
    let r;
    try {
      r = measureDoor({
        sheetPx: state.sheet.points,
        doorPx: points,
        sheetMm: getSheetMm(state, config),
        imageSize: { width: photo.width, height: photo.height },
        sigmaSheetPx: state.sheet.refined ? m.sigmaSheetRefinedPx : m.sigmaSheetManualPx,
        sigmaDoorPx: m.sigmaDoorPx,
        plausible: m.plausible,
      });
    } catch {
      r = { ok: false, error: 'degenerate' };
    }
    if (!r || !r.ok) {
      const key = (r && ERROR_KEYS.get(r.error)) || ERROR_KEYS.get('degenerate');
      ctx.toast(t(key), { type: 'error', duration: ERROR_TOAST_MS });
      return;
    }

    state.door.points = copyQuad(points);
    state.measure = r;
    state.size = {
      ...applyMeasurementRules(m, { widthMm: r.widthMm, heightMm: r.heightMm }),
      source: 'photo',
    };
    // Same payload shape as the result screen sends for a size chosen there.
    const measured = {
      widthMm: state.size.widthMm,
      heightMm: state.size.heightMm,
      source: 'photo',
      quality: r.quality.level,
      sigmaWidthMm: r.sigmaWidthMm,
      sigmaHeightMm: r.sigmaHeightMm,
    };
    // The bundled demo door, not the customer's own: said here as it is on the enquiry.
    if (photo.isDemo === true) measured.demo = true;
    ctx.emit('measured', measured);
    ctx.go('result');
  }

  return () => {
    mark.destroy();
    // Close the help sheet if it is still open, so nothing is left on <body>.
    try {
      help.close();
      help.el.remove();
    } catch {
      // The sheet was never opened, so there is nothing to tidy up.
    }
  };
}
