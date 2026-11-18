/**
 * Sheet screen (step 2): the customer taps the taped sheet of paper in their
 * photo. We detect it and refine its corners; they confirm or adjust the four
 * handles before moving on to the door.
 */

import { detectSheet, refineQuad } from '../vision.js';
import { getLuma, getSheetMm } from '../photo.js';
import {
  copyQuad,
  createMarkScreen,
  defaultSheetQuad,
  invalidateMeasurement,
  isQuad,
  sheetOutlineIsPlausible,
  themeColor,
} from './mark-common.js';

/** Screen id. */
export const id = 'sheet';
/** Progress step this screen belongs to. */
export const step = 2;

/** Default copy for this screen (override any key through config.text). */
export const strings = {
  'sheet.title': 'Mark the sheet of paper',
  'sheet.banner.tap': 'Tap the sheet of paper in your photo',
  'sheet.banner.check': 'Check each corner sits exactly on a corner of the paper. Drag to adjust.',
  'sheet.banner.manual':
    "We couldn't find the sheet automatically. Drag the 4 corners onto the corners of the paper.",
  'sheet.busy': 'Finding the sheet…',
  'sheet.chip.detected': 'Auto-detected',
  'sheet.hint.tap': 'Pinch to zoom in if the sheet looks small.',
  'sheet.hint.adjust': 'Pinch to zoom in. Tap a corner, then use the arrows for fine adjustments.',
  'sheet.snap': 'Snap to edges',
  'sheet.snap.success': "Snapped to the paper's edges",
  'sheet.snap.fail': "Couldn't snap. Adjust the corners by hand.",
  'sheet.restart': 'Start again',
  'sheet.next': 'Next: mark the door',
  'sheet.editor.aria':
    'Your door photo. Tap the sheet of paper, then drag its four corner handles onto the corners of the paper.',
  'sheet.nudge.label': 'Fine-tune the selected corner',
  'sheet.nudge.up': 'Move the corner up',
  'sheet.nudge.down': 'Move the corner down',
  'sheet.nudge.left': 'Move the corner left',
  'sheet.nudge.right': 'Move the corner right',
  'sheet.fit': 'Show the whole photo',
};

const FALLBACK_ACCENT = '#f59e0b';
// How much photo to leave around the placeholder quad after a failed detection,
// so the real corners of the paper are still in view to drag the handles onto.
const MANUAL_ZOOM_PAD = 1;

/**
 * The sheet screen needs a photo to work on.
 * @param {object} state
 * @returns {boolean}
 */
export function canEnter(state) {
  return Boolean(state && state.photo);
}

/**
 * Build the sheet screen.
 * @param {HTMLElement} root The empty screen <section>.
 * @param {object} ctx App context.
 * @returns {() => void} Cleanup.
 */
export function mount(root, ctx) {
  const { state, config, ui } = ctx;
  const t = (key, vars) => ctx.t(key, vars);
  const photo = state.photo;

  let disposed = false;
  let detecting = false;
  let mode = isQuad(state.sheet.points) ? 'adjust' : 'tap';
  // Coming back to corners that were placed or moved by hand: offer the snap straight away.
  let snapAvailable = mode === 'adjust' && !state.sheet.refined;

  const accent = themeColor('--sm-accent', config.brand?.colors?.accent || FALLBACK_ACCENT);

  const nextBtn = ui.button(t('sheet.next'), {
    iconEnd: 'arrow-right',
    disabled: mode === 'tap',
    onClick: () => {
      if (isQuad(state.sheet.points)) ctx.go('door');
    },
  });

  const snapBtn = ui.button(t('sheet.snap'), {
    variant: 'secondary',
    icon: 'magnet',
    onClick: snap,
  });
  snapBtn.classList.add('sm-mark__snap');
  const hint = ui.h('p', { class: 'sm-mark__hint sm-small sm-muted sm-center' });
  // The hint and the snap button share one grid cell (see mark.css) and only
  // swap visibility, so revealing the button never changes the height of the
  // action bar and the photo does not jump right after a corner is dropped.
  const slot = ui.h('div', { class: 'sm-mark__slot' }, hint, snapBtn);

  const chip = ui.chip(t('sheet.chip.detected'), { tone: 'success', icon: 'check' });
  const restartBtn = ui.h(
    'button',
    { class: 'sm-mark__float sm-mark__pill', type: 'button', on: { click: restart } },
    ui.icon('refresh', 16),
    ui.h('span', { text: t('sheet.restart') }),
  );

  const mark = createMarkScreen(root, ctx, {
    title: t('sheet.title'),
    banner:
      mode === 'adjust'
        ? { text: t('sheet.banner.check'), tone: state.sheet.detected ? 'success' : 'info' }
        : { text: t('sheet.banner.tap'), tone: 'info' },
    labels: {
      nudge: t('sheet.nudge.label'),
      up: t('sheet.nudge.up'),
      down: t('sheet.nudge.down'),
      left: t('sheet.nudge.left'),
      right: t('sheet.nudge.right'),
      fit: t('sheet.fit'),
    },
    actions: [nextBtn, slot],
    editor: {
      points: mode === 'adjust' ? state.sheet.points : null,
      color: accent,
      ariaLabel: t('sheet.editor.aria'),
      onChange,
      onTap,
    },
    onReady: (editor) => {
      if (mode === 'adjust') editor.zoomToQuad(copyQuad(state.sheet.points));
    },
  });
  mark.chips.append(chip);
  mark.tools.append(restartBtn);
  render();

  function render() {
    const adjusting = mode === 'adjust';
    const showSnap = adjusting && snapAvailable;
    nextBtn.disabled = !adjusting;
    chip.hidden = !(adjusting && state.sheet.detected);
    restartBtn.hidden = !adjusting;
    hint.textContent = t(adjusting ? 'sheet.hint.adjust' : 'sheet.hint.tap');
    slot.classList.toggle('sm-mark__slot--snap', showSnap);
    snapBtn.disabled = !showSnap;
  }

  /** Switch to adjust mode around the quad now in state.sheet. */
  function showQuad(bannerKey, tone, zoomPad) {
    const editor = mark.editor;
    mode = 'adjust';
    snapAvailable = false;
    mark.banner.update(t(bannerKey), tone);
    render();
    if (editor) {
      // The banner may now wrap to a different height: let the editor pick up
      // the new stage size before the view is framed around the quad.
      mark.flushLayout();
      editor.setPoints(copyQuad(state.sheet.points));
      if (zoomPad === undefined) editor.zoomToQuad(copyQuad(state.sheet.points));
      else editor.zoomToQuad(copyQuad(state.sheet.points), zoomPad);
    }
    mark.sync();
  }

  async function onTap(point) {
    const editor = mark.editor;
    if (!editor) return;
    if (mode !== 'tap') {
      // No re-detection while adjusting. A tap on the photo only lets go of the
      // selected corner, which frees up any handle sitting under the nudge pad.
      editor.setActive(null);
      mark.sync();
      return;
    }
    if (detecting) return;
    detecting = true;
    let result = null;
    try {
      result = await ctx.busy(
        async () => detectSheet(photo.image, point, { luma: getLuma(photo) }),
        t('sheet.busy'),
      );
    } catch {
      result = null;
    } finally {
      detecting = false;
    }
    if (disposed || mode !== 'tap') return;

    invalidateMeasurement(state);
    const sheetMm = getSheetMm(state, config);
    // A clean quad is not yet the sheet: a tap on a door panel or the step finds one too. Anything
    // the wrong shape or size for the chosen reference goes the manual way instead of being
    // announced as found.
    const found =
      result &&
      result.ok &&
      isQuad(result.quad) &&
      sheetOutlineIsPlausible(result.quad, sheetMm, photo.width, photo.height, config.measurement?.plausible);
    if (found) {
      state.sheet = { points: copyQuad(result.quad), refined: Boolean(result.refined), detected: true };
      showQuad('sheet.banner.check', 'success');
    } else {
      const quad = defaultSheetQuad(point, sheetMm, photo.width, photo.height);
      state.sheet = { points: quad, refined: false, detected: false };
      showQuad('sheet.banner.manual', 'warning', MANUAL_ZOOM_PAD);
    }
  }

  function onChange(points, meta) {
    if (!meta.final || mode !== 'adjust') return;
    state.sheet.points = points;
    state.sheet.refined = false;
    invalidateMeasurement(state);
    snapAvailable = true;
    render();
  }

  function snap() {
    const editor = mark.editor;
    if (!editor || mode !== 'adjust') return;
    const points = editor.getPoints();
    if (!isQuad(points)) return;
    let result = null;
    try {
      result = refineQuad(getLuma(photo), points);
    } catch {
      result = null;
    }
    if (!result || !result.ok || !isQuad(result.quad)) {
      ctx.toast(t('sheet.snap.fail'), { type: 'info' });
      return;
    }
    const hadFocus = root.ownerDocument.activeElement === snapBtn;
    state.sheet.points = copyQuad(result.quad);
    state.sheet.refined = true;
    invalidateMeasurement(state);
    editor.setPoints(copyQuad(result.quad));
    snapAvailable = false;
    render();
    mark.sync();
    // The button has just been hidden; keep keyboard focus somewhere useful.
    if (hadFocus) nextBtn.focus({ preventScroll: true });
    ctx.toast(t('sheet.snap.success'), { type: 'success' });
  }

  function restart() {
    const editor = mark.editor;
    state.sheet = { points: null, refined: false, detected: false };
    invalidateMeasurement(state);
    mode = 'tap';
    snapAvailable = false;
    mark.banner.update(t('sheet.banner.tap'), 'info');
    render();
    if (editor) {
      mark.flushLayout();
      editor.setActive(null);
      editor.setPoints(null);
      editor.resetView();
    }
    mark.sync();
    // "Start again" has just been hidden; move focus back to the instruction.
    mark.banner.focus({ preventScroll: true });
  }

  return () => {
    disposed = true;
    mark.destroy();
  };
}
