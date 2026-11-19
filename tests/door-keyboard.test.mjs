// The door screen (js/screens/door.js) driven from a keyboard, with its real corner editor (js/editor.js),
// in the fake browser of tests/helpers/screen-dom.mjs.
//
// What it pins: only a corner the customer confirms counts as one they placed (state.door.byHand), never one
// the keyboard merely passed over. The photo comes before the buttons in tab order, so a keyboard customer
// Tabs through all four handles just to reach "Measure my door": focus selects the first, and Tab moves on
// to the second, third and fourth before leaving. Counted as checked, those three corners were measured
// with a hand's error while still where detection put them, about 8 px out: the paper demo went from "Rough
// measurement, ±44 mm" to "Fair measurement, ±31 mm" with the height 24 mm out, the no-paper estimate grew
// surer of its size, and tabbing past on an "Adjust corners" visit dropped the measurement. Enter or Space on
// the selected handle is the keyboard's press, and checks it as a press with a finger does.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createInitialState } from '../js/app.js';
import { useDemoPhoto } from '../js/demo.js';
import { fitView, imageToScreen } from '../js/editor.js';
import * as door from '../js/screens/door.js';
import * as resultScreen from '../js/screens/result.js';
import { SHIPPED_CONFIG as config } from './helpers/shipped-config.mjs';
import { installFakeDom } from './helpers/screen-dom.mjs';

const m = config.measurement;
const ALL_DETECTED = [false, false, false, false];
const ALL_BY_HAND = [true, true, true, true];

// The bundled demo photo (assets/demo-door.png), by its own truth file.
const DEMO = JSON.parse(readFileSync(new URL('../assets/demo-door.truth.json', import.meta.url), 'utf8'));
const copy = (quad) => quad.map((p) => ({ x: p.x, y: p.y }));
// Detection a realistic ~8.5 px off on each corner (6 px each way), in directions no flat rectangle fits.
const OFFSETS = [[-6, 6], [6, -6], [-6, -6], [6, 6]];
const DETECTED = DEMO.doorPx.map((p, i) => ({ x: p.x + OFFSETS[i][0], y: p.y + OFFSETS[i][1] }));

// The photo stage in the fake browser, CSS px: the editor starts showing the whole photo in it.
const STAGE = { width: 360, height: 520 };

/** The demo photo at the door screen, the way in `method`, its door found ~8 px off (DETECTED). */
function demoState(method) {
  const state = createInitialState(config);
  const photo = { width: DEMO.imageWidth, height: DEMO.imageHeight, canvas: null, image: null, isDemo: true, focal35mm: null, _luma: null };
  useDemoPhoto(state, photo, method, m);
  if (method === 'paper') state.sheet = { points: copy(DEMO.sheetPx), refined: true, detected: true, placed: true };
  state.door.detection = { ok: true, quad: copy(DETECTED), confidence: 0.98, alternatives: [] };
  return state;
}

/** Run `fn` with the fake browser installed, and take it away again whatever happens. */
async function inBrowser(fn) {
  const dom = installFakeDom();
  try {
    return await fn(dom);
  } finally {
    dom.uninstall();
  }
}

/**
 * Focus arrives on the photo from the keyboard. The fake browser knows no pseudo-classes, so the canvas is
 * told this focus is a keyboard's (:focus-visible), as a real browser would say after a Tab.
 */
function focusByKeyboard(screen) {
  const canvas = screen.root.querySelector('canvas');
  if (!canvas) throw new Error('no photo on the door screen yet');
  const matches = canvas.matches.bind(canvas);
  canvas.matches = (selector) => selector === ':focus-visible' || matches(selector);
  canvas.dispatch('focus');
  return canvas;
}

/** Tab from the photo's first handle, through the other three, and on out to the buttons after it. */
function tabPastPhoto(screen) {
  focusByKeyboard(screen);
  for (let i = 0; i < 4; i++) screen.key('Tab');
}

/** "Measure my door" (or "Find my door size"), which must go on to the result. */
function measure(screen, label) {
  screen.press(screen.ctx.t(screen.ctx.state.method === 'estimate' ? 'door.estimate.measure' : 'door.measure'));
  assert.deepEqual(screen.toasts, [], `${label}: no message`);
  assert.equal(screen.went.at(-1), 'result', `${label}: on to the result`);
}

/** Measure the door screen on a fresh demo state, doing `before` first; returns the state. */
async function measured(method, before = () => {}) {
  return inBrowser((dom) => {
    const state = demoState(method);
    const screen = dom.mount(door, { state, config });
    before(screen, dom, state);
    measure(screen, method);
    screen.unmount();
    return state;
  });
}

/** What the result screen shows for `state`: its grade chip and its tips. */
function resultShown(dom, state) {
  const screen = dom.mount(resultScreen, { state, config });
  const texts = (selector) => screen.root.querySelectorAll(selector).map((el) => el.textContent.trim());
  const shown = { chip: texts('.sm-chip__label'), issues: texts('.sm-result__issue'), say: (key) => screen.ctx.t(key) };
  screen.unmount();
  return shown;
}

describe('the door screen from a keyboard: Tab only selects a corner, Enter or Space checks it', () => {
  test('the fixture: the measure buttons are the ones this file presses', async () => {
    await inBrowser((dom) => {
      for (const method of ['paper', 'estimate']) {
        const screen = dom.mount(door, { state: demoState(method), config });
        const key = method === 'estimate' ? 'door.estimate.measure' : 'door.measure';
        assert.ok(screen.button(screen.ctx.t(key)), `${method}: "${screen.ctx.t(key)}"`);
        screen.unmount();
      }
    });
  });

  test('paper: Tabbing past the photo to the buttons checks no corner, and measures as untouched', async () => {
    const untouched = await measured('paper');
    assert.deepEqual(untouched.door.byHand, ALL_DETECTED);
    assert.equal(untouched.measure.quality.level, 'poor', 'the fixture: detection ~8 px off reads rough');

    const tabbed = await measured('paper', (screen) => tabPastPhoto(screen));
    assert.deepEqual(tabbed.door.byHand, ALL_DETECTED, 'no corner was looked at');
    assert.deepEqual(tabbed.measure.doorCornersByHand, ALL_DETECTED);
    assert.deepEqual(tabbed.measure, untouched.measure, 'the same ±, grade and size as measured untouched');

    await inBrowser((dom) => {
      const view = resultShown(dom, tabbed);
      assert.deepEqual(view.chip, [view.say('result.quality.rough')], 'not "Fair measurement"');
      assert.deepEqual(view.issues, [view.say('result.issue.corners_detected')], 'still asks for the corners to be checked');
    });
  });

  test('no paper: Tabbing past the photo leaves the estimate exactly as sure as untouched', async () => {
    const untouched = await measured('estimate');
    assert.equal(untouched.measure.ok, true);
    const tabbed = await measured('estimate', (screen) => tabPastPhoto(screen));
    assert.deepEqual(tabbed.door.byHand, ALL_DETECTED);
    assert.equal(tabbed.measure.sigmaLnAspect, untouched.measure.sigmaLnAspect, 'detection\'s corner error, not a tap\'s');
    assert.deepEqual(tabbed.measure.candidates, untouched.measure.candidates, 'the same p for each size');
    assert.equal(tabbed.measure.confident, untouched.measure.confident);
  });

  test('back from "Adjust corners", Tabbing past the photo keeps the measurement', async () => {
    await inBrowser((dom) => {
      const state = demoState('paper');
      const first = dom.mount(door, { state, config });
      measure(first, 'first visit');
      first.unmount();
      const kept = state.measure;
      assert.ok(kept);

      const again = dom.mount(door, { state, config });
      tabPastPhoto(again);
      assert.equal(state.measure, kept, 'not dropped: no corner moved or was checked');
      assert.deepEqual(state.door.byHand, ALL_DETECTED);
      again.unmount();
    });
  });

  test('Enter or Space on each corner in turn checks it, as pressing it with a finger does', async () => {
    // Keyboard: focus selects the first handle; confirm it, Tab on, confirm the next, and so on.
    const keyed = await measured('paper', (screen, dom, state) => {
      focusByKeyboard(screen);
      const confirms = ['Enter', ' ', 'Enter', ' '];
      for (let i = 0; i < 4; i++) {
        if (i > 0) screen.key('Tab');
        assert.deepEqual(state.door.byHand ?? ALL_DETECTED, ALL_BY_HAND.map((_, j) => j < i), `before corner ${i}`);
        screen.key(confirms[i]);
      }
      assert.deepEqual(state.door.byHand, ALL_BY_HAND, 'all four checked');
      assert.equal(state.measure, null, 'checked corners have a new ±: nothing measured before stands');
    });
    assert.deepEqual(keyed.door.points, DETECTED, 'nothing moved');
    assert.deepEqual(keyed.measure.doorCornersByHand, ALL_BY_HAND);

    // A finger: each handle pressed and let go inside the editor's dead zone.
    const pressed = await measured('paper', (screen, dom, state) => {
      const canvas = screen.root.querySelector('canvas');
      const view = fitView(state.photo.width, state.photo.height, STAGE.width, STAGE.height);
      const finger = (type, at) => canvas.dispatch(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: at.x, clientY: at.y });
      for (const corner of DETECTED) {
        const at = imageToScreen(view, corner);
        finger('pointerdown', at);
        finger('pointerup', { x: at.x + 2, y: at.y + 1 });
        dom.flushFrames();
      }
      assert.deepEqual(state.door.byHand, ALL_BY_HAND);
    });
    assert.deepEqual(keyed.measure, pressed.measure, 'the keyboard\'s check is a finger\'s');
  });
});
