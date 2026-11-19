// The AR measuring flow, js/ar-flow.js, driven with synthetic geometry: a phone held at 1.5 m in a
// WebXR 'local' frame (+Y up, metres), an 820 x 2040 mm opening standing in a vertical plane 1.8 m
// ahead, floor hit-test results that face up, and reticle rays aimed at each corner. At the end, the
// AR screen's pre-session card mounted on a fake DOM and a fake navigator.xr, for what it offers
// after a refused session.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { add, normalize, scale, sub } from '../js/xr-measure.js';
import { createArFlow, outlineSegments, HINT_KEYS, AIM_REASONS, STEPS } from '../js/ar-flow.js';
import { arRefused, resetArSupport } from '../js/ar-support.js';
import {
  strings as arStrings,
  isBlunder,
  buildArMeasure,
  BLUNDER_WARNINGS,
  cardAlternative,
  cardCopyKey,
  createHintSpeaker,
  HINT_ANNOUNCE_MS,
  mount as mountArScreen,
} from '../js/screens/ar.js';

const EYE = [0, 1.5, 0];
const DOOR_Z = -1.8;
const W = 0.82;
const H = 2.04;
const UPWARD = [0, 0, 0, 1]; // identity: the hit pose's +Y is world up, i.e. the floor
// 90 degrees about +X: the hit pose's +Y points along +Z, a wall facing the phone.
const WALL = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
// A floor a few degrees off level, as ARCore reports real floors.
const NEARLY_UP = [Math.sin((3 * Math.PI) / 360), 0, 0, Math.cos((3 * Math.PI) / 360)];

/** The opening's corners, standing on a floor at y = floorY, with its head `height` above the base. */
function opening({ width = W, height = H, base = 0 } = {}) {
  return {
    bl: [-width / 2, 0, DOOR_Z],
    br: [width / 2, 0, DOOR_Z],
    tl: [-width / 2, base + height, DOOR_Z],
    tr: [width / 2, base + height, DOOR_Z],
  };
}

const rayTo = (target, eye = EYE) => ({ origin: eye, direction: normalize(sub(target, eye)) });

/** Where a ray meets the floor (y = 0), as a hit-test result facing up. */
function floorHit(ray, orientation = UPWARD) {
  const t = -ray.origin[1] / ray.direction[1];
  return { position: add(ray.origin, scale(ray.direction, t)), orientation };
}

/** A small, repeatable wobble of the aim (about +-0.05 degrees), so the tap median has work to do. */
function wobble(target, i) {
  const d = 0.0015 * Math.sin(i * 2.399);
  return add(target, [d, 0.0015 * Math.cos(i * 1.7), 0]);
}

/** One frame aimed at `target`: floor targets get a floor hit, door-plane targets none. */
function frameAt(target, { onFloor = target[1] === 0, orientation = UPWARD, eye = EYE } = {}) {
  const ray = rayTo(target, eye);
  return { ray, hit: onFloor ? floorHit(ray, orientation) : null };
}

/** Sweep the floor in front of the door until the flow finds it. Returns the frames it took. */
function scanFloor(flow, { maxFrames = 60, orientation = NEARLY_UP } = {}) {
  for (let i = 0; i < maxFrames; i += 1) {
    const target = [-0.6 + (i % 12) * 0.1, 0, DOOR_Z + 0.4 + (i % 5) * 0.1];
    const out = flow.onFrame(frameAt(target, { orientation }));
    if (out.floorReady) return i + 1;
  }
  return Infinity;
}

/** Tap, then keep aiming at `target` (with a little wobble) until the point is placed. */
function place(flow, target, options = {}) {
  flow.onFrame(frameAt(target, options));
  assert.equal(flow.tap(), true, `tap accepted on step ${flow.step}`);
  for (let i = 0; i < 20; i += 1) {
    const aimAt = target[1] === 0 ? wobble(target, i).map((v, k) => (k === 1 ? 0 : v)) : wobble(target, i);
    const out = flow.onFrame(frameAt(aimAt, { onFloor: target[1] === 0, ...options }));
    if (out.committed) return out;
    assert.equal(out.collecting, true);
    assert.equal(out.hint, 'hold_still');
  }
  assert.fail(`no point placed on step ${flow.step}`);
  return null;
}

const close = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} +- ${tol}, got ${actual}`);

describe('createArFlow: the floor scan', () => {
  test('starts on the floor scan and finds the floor after about 15 agreeing upward hits', () => {
    const flow = createArFlow();
    assert.equal(flow.step, 'floor');
    assert.equal(flow.floorReady, false);
    const first = flow.onFrame(frameAt([0, 0, -1.4]));
    assert.equal(first.hint, 'scan_floor');
    assert.equal(first.aim.ok, true);
    const frames = 1 + scanFloor(flow);
    assert.ok(frames >= 15 && frames <= 16, `took ${frames} frames`);
    assert.equal(flow.step, 'bl');
    assert.equal(flow.floorReady, true);
    close(flow.floorY, 0, 1e-9, 'floor height');
  });

  test('walls, missing hits and floors that do not agree never count as the floor', () => {
    const flow = createArFlow();
    for (let i = 0; i < 40; i += 1) {
      const out = flow.onFrame(frameAt([0, 1, DOOR_Z], { onFloor: true, orientation: WALL }));
      assert.equal(out.aim.reason, 'not_floor');
      flow.onFrame({ ray: rayTo([0, 0, -1.4]), hit: null });
    }
    assert.equal(flow.step, 'floor');
    // Three heights 5 cm apart: no 15 of the last 30 are within 2 cm of their median.
    for (let i = 0; i < 60; i += 1) {
      const y = [0, 0.05, 0.1][i % 3];
      const ray = rayTo([0.1 * (i % 7), y, -1.2]);
      flow.onFrame({ ray, hit: { position: [0.1 * (i % 7), y, -1.2], orientation: UPWARD } });
    }
    assert.equal(flow.step, 'floor');
    assert.equal(flow.floorReady, false);
  });

  test('a tap during the floor scan places nothing', () => {
    const flow = createArFlow();
    assert.equal(flow.tap(), false);
    assert.equal(flow.collecting, false);
  });
});

describe('createArFlow: measuring the opening', () => {
  test('rays at each corner measure the 820 x 2040 opening', () => {
    const flow = createArFlow();
    const d = opening();
    scanFloor(flow);
    const bl = place(flow, d.bl);
    assert.deepEqual(bl.committed.step, 'bl');
    assert.equal(flow.step, 'br');
    place(flow, d.br);
    assert.equal(flow.step, 'sill');
    assert.ok(flow.plane, 'the door plane exists once both bottom corners are in');
    assert.equal(flow.skipSill(), true);
    assert.equal(flow.step, 'tl');
    assert.equal(flow.result(), null, 'no result before every corner is in');
    place(flow, d.tl);
    place(flow, d.tr);
    assert.equal(flow.step, 'done');

    const m = flow.result();
    close(m.widthMm, 820, 2, 'width');
    close(m.heightMm, 2040, 2, 'height');
    close(m.sillHeightMm, 0, 1e-9, 'no sill');
    assert.deepEqual(m.warnings, []);
    const points = flow.points;
    for (const key of ['bl', 'br', 'tl', 'tr']) {
      points[key].forEach((v, i) => close(v, d[key][i], 0.003, `${key}[${i}]`));
    }
    assert.equal(points.sill, null);
    // Done: nothing more to tap.
    assert.equal(flow.tap(), false);
    assert.equal(flow.onFrame(frameAt(d.tr)).hint, null);
  });

  test('a tap takes the median of the next 9 usable aims and skips the unusable ones', () => {
    const flow = createArFlow();
    const d = opening();
    scanFloor(flow);
    assert.equal(flow.tap(), true);
    assert.equal(flow.tap(), false, 'a second tap while collecting is ignored');
    let frames = 0;
    let committed = null;
    for (let i = 0; i < 30 && !committed; i += 1) {
      frames += 1;
      let frame;
      if (i % 3 === 2) frame = frameAt([d.bl[0], 1, DOOR_Z], { onFloor: true, orientation: WALL }); // unusable
      else if (i === 4) frame = frameAt([d.bl[0] + 0.25, 0, DOOR_Z]); // one wild but usable aim
      else frame = frameAt(d.bl);
      committed = flow.onFrame(frame).committed;
    }
    assert.ok(committed, 'placed');
    assert.equal(frames, 13, '9 usable aims among 4 unusable ones');
    committed.point.forEach((v, i) => close(v, d.bl[i], 1e-9, `bl[${i}]`));
  });

  test('a tap gives up when the aim stays unusable, and asks to hold steady', () => {
    const flow = createArFlow();
    scanFloor(flow);
    flow.tap();
    for (let i = 0; i < 45; i += 1) flow.onFrame(frameAt([0, 1, DOOR_Z], { onFloor: true, orientation: WALL }));
    assert.equal(flow.collecting, false);
    assert.equal(flow.step, 'bl');
    assert.equal(flow.points.bl, null);
    assert.equal(flow.onFrame(frameAt(opening().bl)).hint, 'hold_steady');
  });

  test('a 25 mm sill: bottom corners on the ground plus one tap on the sill top measure from the sill', () => {
    const sill = 0.025;
    const d = opening({ base: sill }); // head 2040 above the sill top, jamb feet on the ground
    const flow = createArFlow();
    scanFloor(flow);
    place(flow, d.bl);
    place(flow, d.br);
    assert.equal(flow.step, 'sill');
    const s = place(flow, [0, sill, DOOR_Z]);
    assert.equal(s.committed.step, 'sill');
    assert.equal(flow.step, 'tl');
    place(flow, d.tl);
    place(flow, d.tr);
    const m = flow.result();
    close(m.sillHeightMm, 25, 2, 'sill height');
    close(m.heightMm, 2040, 2, 'height from the sill');
    close(m.widthMm, 820, 2, 'width');
    assert.deepEqual(m.warnings, []);

    // The same corners without the sill tap read the height from the ground: 25 mm too tall.
    const noSill = createArFlow();
    scanFloor(noSill);
    place(noSill, d.bl);
    place(noSill, d.br);
    noSill.skipSill();
    place(noSill, d.tl);
    place(noSill, d.tr);
    close(noSill.result().heightMm, 2065, 2, 'height from the ground');
  });

  test('rejected aims give their reason as the hint', () => {
    const flow = createArFlow();
    const d = opening();
    scanFloor(flow);

    // Bottom corner aimed at a wall hit: not the floor.
    const wall = flow.onFrame(frameAt([d.bl[0], 0.3, DOOR_Z], { onFloor: true, orientation: WALL }));
    assert.equal(wall.aim.ok, false);
    assert.equal(wall.aim.reason, 'not_floor');
    assert.equal(wall.hint, 'not_floor');
    // A floor hit 6 m away.
    const far = flow.onFrame({ ray: rayTo([0, 0, -6]), hit: { position: [0, 0, -6], orientation: UPWARD } });
    assert.equal(far.hint, 'too_far');
    // No hit at all: the floor height found by the scan stands in.
    const noHit = flow.onFrame({ ray: rayTo(d.bl), hit: null });
    assert.equal(noHit.aim.ok, true);
    assert.equal(noHit.aim.source, 'floor');
    assert.equal(noHit.hint, null);

    place(flow, d.bl);
    // Bottom-right too close to bottom-left.
    assert.equal(flow.onFrame(frameAt([d.bl[0] + 0.2, 0, DOOR_Z])).hint, 'too_narrow');
    place(flow, d.br);
    flow.skipSill();

    // Top corner with the phone side-on to the door: the ray grazes the door plane.
    const grazing = flow.onFrame({ ray: { origin: EYE, direction: normalize([1, 0.1, -0.2]) }, hit: null });
    assert.equal(grazing.aim.reason, 'grazing');
    assert.equal(grazing.hint, 'grazing');
    // Pointing away from the door.
    assert.equal(flow.onFrame({ ray: { origin: EYE, direction: [0, 0, 1] }, hit: null }).hint, 'behind');
    // Too low for the head of a door.
    assert.equal(flow.onFrame(frameAt([d.tl[0], 1, DOOR_Z])).hint, 'too_low');
    // Every hint the flow can give is a known key.
    for (const reason of AIM_REASONS) assert.ok(HINT_KEYS.includes(reason));
  });
});

describe('createArFlow: undo, skipSill and reset', () => {
  test('undo steps back one point at a time, and drops a tap still collecting', () => {
    const flow = createArFlow();
    const d = opening();
    scanFloor(flow);
    assert.equal(flow.undo(), false, 'nothing to undo yet');
    assert.equal(flow.step, 'bl');

    place(flow, d.bl);
    place(flow, d.br);
    assert.ok(flow.plane);
    assert.equal(flow.undo(), true);
    assert.equal(flow.step, 'br');
    assert.equal(flow.points.br, null);
    assert.ok(flow.points.bl);
    assert.equal(flow.plane, null, 'the door plane goes with the corner');

    flow.tap();
    flow.onFrame(frameAt(d.br));
    assert.equal(flow.collecting, true);
    assert.equal(flow.undo(), true);
    assert.equal(flow.collecting, false);
    assert.equal(flow.step, 'br', 'undoing a tap in progress keeps the step');

    place(flow, d.br);
    flow.skipSill();
    place(flow, d.tl);
    place(flow, d.tr);
    assert.equal(flow.step, 'done');
    assert.equal(flow.undo(), true);
    assert.equal(flow.step, 'tr');
    assert.equal(flow.result(), null);
    assert.equal(flow.undo(), true);
    assert.equal(flow.step, 'tl');
    assert.equal(flow.undo(), true, 'undoing "No step" brings the sill step back');
    assert.equal(flow.step, 'sill');
    assert.equal(flow.undo(), true);
    assert.equal(flow.step, 'br');
    assert.equal(flow.undo(), true);
    assert.equal(flow.step, 'bl');
    assert.equal(flow.undo(), false);
    assert.equal(flow.floorReady, true, 'undo never loses the floor');
  });

  test('skipSill only works on the sill step', () => {
    const flow = createArFlow();
    const d = opening();
    assert.equal(flow.skipSill(), false);
    scanFloor(flow);
    assert.equal(flow.skipSill(), false);
    place(flow, d.bl);
    place(flow, d.br);
    assert.equal(flow.skipSill(), true);
    assert.equal(flow.step, 'tl');
    assert.equal(flow.skipSill(), false);
  });

  test('reset starts again from the floor scan; keepFloor starts again at the first corner', () => {
    const flow = createArFlow();
    const d = opening();
    scanFloor(flow);
    place(flow, d.bl);
    place(flow, d.br);
    flow.tap();
    flow.reset({ keepFloor: true });
    assert.equal(flow.step, 'bl');
    assert.equal(flow.floorReady, true);
    assert.equal(flow.collecting, false);
    assert.deepEqual(flow.points, { bl: null, br: null, sill: null, tl: null, tr: null });
    assert.equal(flow.plane, null);

    place(flow, d.bl);
    flow.reset();
    assert.equal(flow.step, 'floor');
    assert.equal(flow.floorReady, false);
    assert.equal(flow.floorY, null);
    assert.deepEqual(flow.points, { bl: null, br: null, sill: null, tl: null, tr: null });
    assert.equal(flow.undo(), false);
    // And it measures again from scratch.
    scanFloor(flow);
    place(flow, d.bl);
    place(flow, d.br);
    flow.skipSill();
    place(flow, d.tl);
    place(flow, d.tr);
    close(flow.result().widthMm, 820, 2);
  });

  test('updatePoints moves placed points (anchors) and the door plane with them', () => {
    const flow = createArFlow();
    const d = opening();
    scanFloor(flow);
    place(flow, d.bl);
    place(flow, d.br);
    flow.updatePoints({ br: { x: d.br[0] + 0.01, y: 0, z: DOOR_Z }, tl: [9, 9, 9] });
    close(flow.points.br[0], d.br[0] + 0.01, 1e-12);
    assert.equal(flow.points.tl, null, 'a point not placed yet is not created');
    close(flow.plane.baseLengthM, 0.83, 0.003);
  });
});

describe('outlineSegments', () => {
  test('a rubber-band bottom edge to the live aim, then the four sides and the sill', () => {
    const d = opening({ base: 0.025 });
    const flow = createArFlow();
    scanFloor(flow);
    place(flow, d.bl);
    const live = flow.onFrame(frameAt(d.br));
    const band = outlineSegments(flow.points, flow.plane, { step: flow.step, aim: live.aim });
    assert.equal(band.length, 1);
    assert.equal(band[0].id, 'bottom');
    assert.equal(band[0].live, true);
    close(band[0].mm, 820, 1);

    place(flow, d.br);
    place(flow, [0, 0.025, DOOR_Z]);
    place(flow, d.tl);
    place(flow, d.tr);
    const all = outlineSegments(flow.points, flow.plane, null);
    const byId = Object.fromEntries(all.map((s) => [s.id, s]));
    assert.deepEqual(Object.keys(byId).sort(), ['bottom', 'left', 'right', 'sill', 'top']);
    close(byId.top.mm, 820, 2);
    close(byId.left.mm, 2040, 2, 'left height from the sill');
    close(byId.right.mm, 2040, 2, 'right height from the sill');
    close(byId.sill.mm, 25, 2);
    assert.ok(all.every((s) => !s.live));
  });
});

describe('the AR screen', () => {
  test('has a customer string for every hint the flow and the session can give', () => {
    for (const key of [...HINT_KEYS, 'tracking', 'paused', 'restarted']) {
      assert.equal(typeof arStrings[`ar.hint.${key}`], 'string', `ar.hint.${key}`);
    }
    assert.equal(arStrings['ar.hint.too_far'], 'Step closer');
    assert.equal(arStrings['ar.hint.grazing'], 'Face the door');
    for (const flowStep of STEPS) {
      if (flowStep === 'done') continue;
      assert.equal(typeof arStrings[`ar.${flowStep}.title`], 'string', `ar.${flowStep}.title`);
    }
  });

  test('blunders are retried in the session; imperfect but real doors go on to the result', () => {
    assert.equal(isBlunder(null), true);
    for (const warning of BLUNDER_WARNINGS) assert.equal(isBlunder({ widthMm: 820, heightMm: 2040, warnings: [warning] }), true, warning);
    assert.equal(isBlunder({ widthMm: 820, heightMm: 2040, warnings: ['base_not_level', 'off_plane'] }), false);
    assert.equal(isBlunder({ widthMm: 820, heightMm: 2040, warnings: [] }), false);
    assert.equal(isBlunder({ widthMm: 1700, heightMm: 2040, warnings: ['implausible_size'] }), false, 'an unusual size is not a blunder');
  });

  test('an unusual but real opening, with every corner accepted, goes on to the result instead of looping', () => {
    // Inside aimPoint's guard rails (up to 2 m wide, top corners from 1.5 m) but outside
    // measureOpening's usual door range (500-1600 wide, 1700-2800 high).
    for (const [name, size] of [
      ['a 1700 mm double-door opening', { width: 1.7 }],
      ['a 1600 mm high cellar door', { height: 1.6 }],
    ]) {
      const flow = createArFlow();
      const d = opening(size);
      scanFloor(flow);
      place(flow, d.bl);
      place(flow, d.br);
      flow.skipSill();
      place(flow, d.tl);
      place(flow, d.tr);
      assert.equal(flow.step, 'done', name);
      const m = flow.result();
      assert.deepEqual(m.warnings, ['implausible_size'], name);
      assert.equal(isBlunder(m), false, name);
      // The result screen explains it (result-standard AR_WARNINGS) and keeps the warning on the measure.
      assert.deepEqual(buildArMeasure(m, [{ widthMm: 820, heightMm: 2040 }]).warnings, ['implausible_size'], name);
    }
  });

  test('the card offers the photo, else paper, else a typed size, and its copy only offers what is there', () => {
    const config = (methods, extra = {}) => ({ measurement: { methods, ...extra } });
    assert.equal(cardAlternative(config({ ar: true, camera: true, paper: true })), 'photo');
    assert.equal(cardAlternative({}), 'photo', 'a config without methods offers everything');
    assert.equal(cardAlternative(config({ ar: true, camera: false, paper: true })), 'paper');
    assert.equal(cardAlternative(config({ ar: true, camera: false, paper: false })), 'manual');
    assert.equal(cardAlternative(config({ ar: true, camera: false, paper: false }, { allowManualOverride: false })), null);

    const bases = ['ar.unsupported', 'ar.unsupported.inApp', 'ar.failed', 'ar.error.ended'];
    assert.equal(cardCopyKey('ar.failed', 'photo'), 'ar.failed');
    assert.equal(cardCopyKey('ar.failed', 'paper'), 'ar.failed.paper');
    assert.equal(cardCopyKey('ar.failed', null), 'ar.failed.none');
    for (const alternative of ['photo', 'paper', 'manual', null]) {
      for (const base of bases) {
        const key = cardCopyKey(base, alternative);
        const value = arStrings[key];
        assert.equal(typeof value, 'string', key);
        if (alternative !== 'photo') assert.doesNotMatch(value, /photo/i, `${key} offers a photo that is not there`);
        if (alternative !== 'paper') assert.doesNotMatch(value, /paper/i, `${key} offers paper that is not there`);
      }
    }
    for (const key of ['ar.photo', 'ar.paper', 'ar.manual']) assert.equal(typeof arStrings[key], 'string', key);
  });

  test('screen readers hear a hint only once it has held, never the flicker of a sweep', () => {
    assert.ok(HINT_ANNOUNCE_MS >= 500, 'well above the few frames a hint needs to be shown');
    const speak = createHintSpeaker(1000);
    // Hints flipping every 100 ms while the phone sweeps the floor: none is spoken.
    const sweep = ['no_surface', 'not_floor', 'too_far', null];
    for (let i = 0; i < 40; i += 1) assert.equal(speak(sweep[i % sweep.length], i * 100), null, `frame ${i}`);
    // One that stays up is spoken once it has held for a second, and stays spoken while it is up.
    assert.equal(speak('not_floor', 5000), null);
    assert.equal(speak('not_floor', 5500), null);
    assert.equal(speak('not_floor', 6000), 'not_floor');
    assert.equal(speak('not_floor', 6100), 'not_floor');
    // A new hint drops the spoken one at once, and is spoken itself after holding.
    assert.equal(speak('too_far', 6200), null);
    assert.equal(speak('too_far', 7200), 'too_far');
    // No hint: nothing spoken.
    assert.equal(speak(null, 7300), null);
    assert.equal(speak(null, 9000), null);
    assert.equal(speak(undefined, 9100), null);
  });

  test('builds the AR measure with the nearest standard sizes', () => {
    const flow = createArFlow();
    const d = opening();
    scanFloor(flow);
    place(flow, d.bl);
    place(flow, d.br);
    flow.skipSill();
    place(flow, d.tl);
    place(flow, d.tr);
    const measure = buildArMeasure(flow.result(), [
      { widthMm: 720, heightMm: 2040 },
      { widthMm: 820, heightMm: 2040 },
      { widthMm: 920, heightMm: 2040 },
    ]);
    assert.equal(measure.method, 'ar');
    assert.equal(measure.ok, true);
    assert.equal(measure.runs, 1);
    close(measure.widthMm, 820, 2);
    assert.ok(measure.candidates.length >= 1 && measure.candidates.length <= 3);
    assert.equal(measure.candidates[0].widthMm, 820);
    assert.equal(measure.candidates[0].heightMm, 2040);
    for (const key of ['minWidthMm', 'minHeightMm', 'sillHeightMm']) assert.ok(Number.isFinite(measure[key]), key);
    assert.deepEqual(measure.warnings, []);
  });
});

// ---- The pre-session card, mounted -------------------------------------------------------------

/** Just enough of a DOM element to mount the AR screen under Node. */
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.textContent = '';
    const names = new Set();
    this.classList = {
      add: (...list) => list.forEach((name) => names.add(name)),
      remove: (...list) => list.forEach((name) => names.delete(name)),
      toggle: (name, on = !names.has(name)) => {
        if (on) names.add(name);
        else names.delete(name);
        return on;
      },
      contains: (name) => names.has(name),
    };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  append(...kids) {
    for (const kid of kids.flat(Infinity)) {
      if (!kid) continue;
      kid.remove();
      kid.parentNode = this;
      this.children.push(kid);
    }
  }

  appendChild(kid) {
    this.append(kid);
    return kid;
  }

  prepend(...kids) {
    const rest = this.children;
    this.children = [];
    this.append(...kids);
    this.children.push(...rest.filter((kid) => !this.children.includes(kid)));
  }

  replaceChildren(...kids) {
    for (const kid of this.children) kid.parentNode = null;
    this.children = [];
    this.append(...kids);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((kid) => kid !== this);
    this.parentNode = null;
  }

  focus() {}

  click() {
    for (const fn of this.listeners.click || []) fn({ type: 'click' });
  }

  *descendants() {
    for (const kid of this.children) {
      yield kid;
      yield* kid.descendants();
    }
  }

  /** Only the two selector shapes the screen uses: a tag name, or '.class'. */
  querySelector(selector) {
    for (const el of this.descendants()) {
      if (selector.startsWith('.') ? el.classList.contains(selector.slice(1)) : el.tag === selector) return el;
    }
    return null;
  }
}

function fakeH(tag, props = {}, ...kids) {
  const el = new FakeElement(tag);
  for (const name of String(props.class || '').split(/\s+/).filter(Boolean)) el.classList.add(name);
  if (props.text !== undefined) el.textContent = String(props.text);
  if (props.hidden) el.hidden = true;
  for (const [name, value] of Object.entries(props.attrs || {})) el.setAttribute(name, value);
  for (const [type, fn] of Object.entries(props.on || {})) el.addEventListener(type, fn);
  el.append(...kids);
  return el;
}

/** The parts of the ui kit the AR screen uses. A button remembers its variant for the assertions. */
const fakeUi = {
  h: fakeH,
  icon: () => fakeH('svg'),
  svgFromString: () => fakeH('svg'),
  card: (props, ...kids) => fakeH('div', props, ...kids),
  screenHeader: () => fakeH('header'),
  actionBar: () => fakeH('div', { class: 'test-bar' }),
  banner(text) {
    const el = fakeH('div', { class: 'test-banner' });
    el.update = (next) => {
      el.textContent = next || '';
      el.hidden = !next;
    };
    el.update(text);
    return el;
  },
  button(label, { variant = 'primary', onClick } = {}) {
    const el = fakeH('button', { text: label });
    el.variant = variant;
    if (onClick) el.addEventListener('click', onClick);
    el.setLoading = (on) => {
      el.loading = Boolean(on);
    };
    return el;
  },
  fmtMm: (mm) => String(Math.round(mm)),
};

/** A granted session. Its frames never run: these tests only look at the card around it. */
class FakeSession {
  constructor() {
    this.listeners = {};
    this.enabledFeatures = ['hit-test', 'dom-overlay'];
    this.visibilityState = 'visible';
    this.renderState = {};
    this.over = false;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  updateRenderState() {}

  async requestReferenceSpace() {
    return { addEventListener() {} };
  }

  async requestHitTestSource() {
    return { cancel() {} };
  }

  requestAnimationFrame() {
    return 1;
  }

  /** The session ends: asked for by the page, or by the phone itself (system Back, an app switch). */
  fireEnd() {
    if (this.over) return;
    this.over = true;
    for (const fn of this.listeners.end || []) fn({ session: this });
  }

  async end() {
    this.fireEnd();
  }
}

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 12; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const PHONE_GLOBALS = ['navigator', 'isSecureContext', 'document', 'XRWebGLLayer'];
const savedGlobals = Object.fromEntries(PHONE_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/**
 * An Android Chrome phone that says it can do AR (isSessionSupported true). `refuse` is how many of
 * the next requestSession() calls are refused, as on a phone that is not ARCore-certified or whose
 * owner turned down "Google Play Services for AR"; `webgl: false` makes a granted session fail to
 * set up.
 */
function fakeArPhone() {
  const phone = { refuse: 0, webgl: true, sessions: [], body: new FakeElement('body') };
  defineGlobal('navigator', {
    userAgent: ANDROID_CHROME,
    xr: {
      isSessionSupported: async () => true,
      requestSession: async () => {
        if (phone.refuse > 0) {
          phone.refuse -= 1;
          throw Object.assign(new Error('The specified session configuration is not supported.'), { name: 'NotSupportedError' });
        }
        const session = new FakeSession();
        phone.sessions.push(session);
        return session;
      },
    },
  });
  defineGlobal('isSecureContext', true);
  defineGlobal('document', {
    body: phone.body,
    createElement(tag) {
      const el = new FakeElement(tag);
      el.getContext = () => (phone.webgl ? { makeXRCompatible: async () => {}, getExtension: () => null } : null);
      return el;
    },
  });
  defineGlobal('XRWebGLLayer', class {});
  return phone;
}

/** Mount the AR screen; ctx.t returns the string key itself, so the card reads as keys. */
function mountCard() {
  const root = new FakeElement('section');
  const toasts = [];
  const ctx = {
    ui: fakeUi,
    config: { measurement: {} },
    t: (key) => key,
    toast: (message) => toasts.push(message),
    go() {},
    state: {},
    emit() {},
  };
  const cleanup = mountArScreen(root, ctx);
  const bar = root.querySelector('.test-bar');
  const banner = root.querySelector('.test-banner');
  return {
    toasts,
    cleanup,
    /** The banner (null when hidden) and the card's buttons in order, as 'label:variant'. */
    card: () => ({ banner: banner.hidden ? null : banner.textContent, buttons: bar.children.map((b) => `${b.textContent}:${b.variant}`) }),
    press: (label) => bar.children.find((b) => b.textContent === label).click(),
  };
}

/** Let every pending promise in the screen settle. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const AR_FIRST = ['ar.start:primary', 'ar.photo:secondary'];
const PHOTO_FIRST = ['ar.photo:primary', 'ar.start:secondary'];

describe('the AR card after a refused session', () => {
  beforeEach(() => resetArSupport());
  afterEach(() => {
    for (const name of PHONE_GLOBALS) {
      if (savedGlobals[name]) Object.defineProperty(globalThis, name, savedGlobals[name]);
      else delete globalThis[name];
    }
    resetArSupport();
  });

  test('a refusal puts the photo first and is remembered when the customer comes back', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const phone = fakeArPhone();
    phone.refuse = 2;
    let screen = mountCard();
    await settle();
    assert.deepEqual(screen.card(), { banner: null, buttons: AR_FIRST });

    screen.press('ar.start');
    await settle();
    assert.deepEqual(screen.card(), { banner: 'ar.failed', buttons: PHOTO_FIRST });
    assert.deepEqual(screen.toasts, ['ar.error.start']);
    assert.equal(arRefused(), true, 'the welcome screen can see the refusal');

    // Header Back to the welcome screen, then AR again: the photo stays first.
    screen.cleanup();
    screen = mountCard();
    await settle();
    assert.deepEqual(screen.card(), { banner: 'ar.failed', buttons: PHOTO_FIRST });
    screen.press('ar.start');
    await settle();
    assert.deepEqual(screen.card(), { banner: 'ar.failed', buttons: PHOTO_FIRST });
    assert.equal(arRefused(), true);
    screen.cleanup();
  });

  test('a refused try, then one that runs: once it ends the card does not say AR didn’t start', async (t) => {
    t.mock.method(console, 'warn', () => {});
    for (const ending of ['cancel', 'system']) {
      resetArSupport();
      const phone = fakeArPhone();
      phone.refuse = 1;
      const screen = mountCard();
      await settle();
      screen.press('ar.start');
      await settle();
      assert.deepEqual(screen.card(), { banner: 'ar.failed', buttons: PHOTO_FIRST }, ending);

      // The customer allows it this time, and the session runs.
      screen.press('ar.start');
      await settle();
      assert.equal(phone.sessions.length, 1, ending);
      assert.ok(phone.body.querySelector('.sm-ar-overlay').classList.contains('is-live'), `${ending}: overlay live`);
      assert.equal(arRefused(), false, `${ending}: AR has run on this phone`);

      if (ending === 'cancel') phone.body.querySelector('.sm-ar-bar__cancel').click();
      else phone.sessions[0].fireEnd();
      await settle();
      assert.equal(phone.body.querySelector('.sm-ar-overlay'), null, `${ending}: overlay gone`);
      assert.deepEqual(screen.card(), { banner: null, buttons: AR_FIRST }, ending);
      const expectedToasts = ending === 'cancel' ? ['ar.error.start'] : ['ar.error.start', 'ar.error.ended'];
      assert.deepEqual(screen.toasts, expectedToasts, ending);
      screen.cleanup();
    }
  });

  test('a granted session that cannot be set up counts as refused', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const phone = fakeArPhone();
    phone.webgl = false;
    const screen = mountCard();
    await settle();
    screen.press('ar.start');
    await settle();
    assert.equal(phone.sessions.length, 1);
    assert.equal(phone.sessions[0].over, true, 'the session was ended');
    assert.deepEqual(screen.card(), { banner: 'ar.failed', buttons: PHOTO_FIRST });
    assert.deepEqual(screen.toasts, ['ar.error.start']);
    assert.equal(arRefused(), true);
    screen.cleanup();
  });
});
