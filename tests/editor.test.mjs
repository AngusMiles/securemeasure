import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QuadEditor,
  HANDLE_HIT_RADIUS_PX,
  LOUPE_DIAMETER_PX,
  LOUPE_MARGIN_PX,
  LOUPE_MIN_SCALE,
  MAX_SCALE,
  PINCH_START_MS,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  backingStoreSize,
  casingFor,
  clampPoint,
  clampView,
  ensureVisible,
  fitView,
  hitTestHandle,
  imageToScreen,
  isPinchStart,
  isTap,
  lerpView,
  loupeCorner,
  loupeScale,
  nextTabIndex,
  outlineOrder,
  panBy,
  parseCssColor,
  pinchView,
  quadBounds,
  relativeLuminance,
  scaleLimits,
  screenToImage,
  settledPoint,
  shiftView,
  viewForQuad,
  viewsEqual,
  visibleImageRect,
  wheelZoomFactor,
  zoomAt,
} from '../js/editor.js';

/* ------------------------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------------------------ */

const near = (actual, expected, eps = 1e-6, message) => {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${message ? `${message}: ` : ''}expected ${actual} to be within ${eps} of ${expected}`,
  );
};

const nearPoint = (actual, expected, eps = 1e-6, message) => {
  near(actual.x, expected.x, eps, `${message || 'point'} x`);
  near(actual.y, expected.y, eps, `${message || 'point'} y`);
};

const IMG_W = 1500;
const IMG_H = 2000;
const QUAD = () => [
  { x: 500, y: 500 },
  { x: 1000, y: 500 },
  { x: 1000, y: 1500 },
  { x: 500, y: 1500 },
];

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: fitView
 * ------------------------------------------------------------------------------------------ */

test('module imports in Node without a DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof QuadEditor, 'function');
  assert.equal(typeof fitView, 'function');
});

const FIT_CASES = [
  { name: 'portrait image in portrait container', iw: 1500, ih: 2000, vw: 360, vh: 640, scale: 0.24, tx: 0, ty: 80 },
  { name: 'portrait image in landscape container', iw: 1500, ih: 2000, vw: 800, vh: 400, scale: 0.2, tx: 250, ty: 0 },
  { name: 'landscape image in portrait container', iw: 2000, ih: 1500, vw: 360, vh: 640, scale: 0.18, tx: 0, ty: 185 },
  { name: 'landscape image in landscape container', iw: 2000, ih: 1500, vw: 800, vh: 400, scale: 400 / 1500, tx: (800 - 2000 * (400 / 1500)) / 2, ty: 0 },
];

for (const c of FIT_CASES) {
  test(`fitView: ${c.name}`, () => {
    const v = fitView(c.iw, c.ih, c.vw, c.vh);
    near(v.scale, c.scale, 1e-9, 'scale');
    near(v.tx, c.tx, 1e-9, 'tx');
    near(v.ty, c.ty, 1e-9, 'ty');

    // The whole image is inside the viewport, centred, and touches it on the limiting axis.
    const tl = imageToScreen(v, { x: 0, y: 0 });
    const br = imageToScreen(v, { x: c.iw, y: c.ih });
    assert.ok(tl.x >= -1e-9 && tl.y >= -1e-9, 'top-left inside');
    assert.ok(br.x <= c.vw + 1e-9 && br.y <= c.vh + 1e-9, 'bottom-right inside');
    near(tl.x, c.vw - br.x, 1e-9, 'horizontally centred');
    near(tl.y, c.vh - br.y, 1e-9, 'vertically centred');
    const fillsWidth = Math.abs(br.x - tl.x - c.vw) < 1e-9;
    const fillsHeight = Math.abs(br.y - tl.y - c.vh) < 1e-9;
    assert.ok(fillsWidth || fillsHeight, 'fills one axis exactly');
  });
}

test('fitView: padding shrinks the image and keeps it centred', () => {
  const v = fitView(1500, 2000, 360, 640, 20);
  near(v.scale, 320 / 1500, 1e-12);
  const tl = imageToScreen(v, { x: 0, y: 0 });
  const br = imageToScreen(v, { x: 1500, y: 2000 });
  near(tl.x, 20, 1e-9);
  near(br.x, 340, 1e-9);
  near(tl.y, 640 - br.y, 1e-9);
});

test('fitView: degenerate sizes give the identity view instead of NaN', () => {
  for (const args of [[0, 100, 300, 300], [100, 0, 300, 300], [100, 100, 0, 300], [100, 100, 300, 0], [100, 100, 30, 30, 20]]) {
    assert.deepEqual(fitView(...args), { scale: 1, tx: 0, ty: 0 });
  }
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: screen <-> image
 * ------------------------------------------------------------------------------------------ */

test('imageToScreen / screenToImage round trip at several zoom levels', () => {
  const fit = fitView(IMG_W, IMG_H, 360, 520);
  const points = [{ x: 0, y: 0 }, { x: 733.25, y: 1021.5 }, { x: 1499.999, y: 0.001 }, { x: -40, y: 2300 }];
  for (const scale of [fit.scale, 0.5, 1, 3.7, MAX_SCALE]) {
    for (const [tx, ty] of [[0, 0], [-812.5, 44.25], [123.456, -9876.5]]) {
      const view = { scale, tx, ty };
      for (const p of points) {
        const s = imageToScreen(view, p);
        nearPoint(screenToImage(view, s), p, 1e-9, `image->screen->image at scale ${scale}`);
        const q = { x: p.x / 7, y: p.y / 5 };
        nearPoint(imageToScreen(view, screenToImage(view, q)), q, 1e-9, `screen->image->screen at scale ${scale}`);
      }
    }
  }
});

test('imageToScreen applies scale then translation', () => {
  assert.deepEqual(imageToScreen({ scale: 2, tx: 10, ty: -4 }, { x: 3, y: 5 }), { x: 16, y: 6 });
  assert.deepEqual(screenToImage({ scale: 2, tx: 10, ty: -4 }, { x: 16, y: 6 }), { x: 3, y: 5 });
});

test('shiftView offsets by a constant number of image px', () => {
  const view = { scale: 4, tx: 10, ty: 20 };
  const shifted = shiftView(view, 0.5);
  nearPoint(imageToScreen(shifted, { x: 7, y: 9 }), imageToScreen(view, { x: 7.5, y: 9.5 }), 1e-12);
  assert.deepEqual(shiftView(view, 0), view);
});

test('panBy translates in screen px', () => {
  assert.deepEqual(panBy({ scale: 3, tx: 1, ty: 2 }, 10, -5), { scale: 3, tx: 11, ty: -3 });
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: zoomAt
 * ------------------------------------------------------------------------------------------ */

test('zoomAt keeps the anchor point fixed', () => {
  const start = { scale: 0.24, tx: 0, ty: 20 };
  for (const anchor of [{ x: 0, y: 0 }, { x: 180, y: 260 }, { x: 359, y: 5 }, { x: 77.5, y: 501.25 }]) {
    for (const factor of [0.5, 0.9, 1, 1.1, 2, 7.3]) {
      const before = screenToImage(start, anchor);
      const zoomed = zoomAt(start, anchor, factor);
      near(zoomed.scale, start.scale * factor, 1e-12, 'scale');
      nearPoint(screenToImage(zoomed, anchor), before, 1e-9, `anchor ${anchor.x},${anchor.y} factor ${factor}`);
    }
  }
});

test('zoomAt respects limits and still keeps the anchor fixed when a limit is hit', () => {
  const start = { scale: 2, tx: -300, ty: -500 };
  const anchor = { x: 120, y: 333 };
  const before = screenToImage(start, anchor);

  const up = zoomAt(start, anchor, 100, { minScale: 0.24, maxScale: 8 });
  assert.equal(up.scale, 8);
  nearPoint(screenToImage(up, anchor), before, 1e-9);

  const down = zoomAt(start, anchor, 0.001, { minScale: 0.24, maxScale: 8 });
  assert.equal(down.scale, 0.24);
  nearPoint(screenToImage(down, anchor), before, 1e-9);
});

test('zoomAt ignores nonsense factors', () => {
  const start = { scale: 2, tx: -300, ty: -500 };
  for (const factor of [NaN, 0, -3, Infinity]) {
    const v = zoomAt(start, { x: 10, y: 10 }, factor);
    near(v.scale, 2, 1e-12);
    near(v.tx, -300, 1e-9);
    near(v.ty, -500, 1e-9);
  }
});

test('repeated zoom in then out about one anchor returns to the start', () => {
  const start = { scale: 0.5, tx: -20, ty: 33 };
  const anchor = { x: 200, y: 150 };
  let v = start;
  for (let i = 0; i < 12; i++) v = zoomAt(v, anchor, 1.17);
  for (let i = 0; i < 12; i++) v = zoomAt(v, anchor, 1 / 1.17);
  near(v.scale, start.scale, 1e-9);
  near(v.tx, start.tx, 1e-6);
  near(v.ty, start.ty, 1e-6);
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: scaleLimits / clampView
 * ------------------------------------------------------------------------------------------ */

test('scaleLimits: fit is the minimum, MAX_SCALE the maximum', () => {
  const lim = scaleLimits(IMG_W, IMG_H, 360, 520);
  near(lim.minScale, 0.24, 1e-12);
  assert.equal(lim.maxScale, MAX_SCALE);
  // An image so tiny that the fit view is already deeper than MAX_SCALE.
  const tiny = scaleLimits(10, 10, 400, 400);
  assert.equal(tiny.minScale, 40);
  assert.equal(tiny.maxScale, 40);
});

test('clampView leaves the fit view alone', () => {
  const fit = fitView(IMG_W, IMG_H, 360, 520);
  const out = clampView(fit, IMG_W, IMG_H, 360, 520);
  near(out.scale, fit.scale, 1e-12);
  near(out.tx, fit.tx, 1e-9);
  near(out.ty, fit.ty, 1e-9);
});

test('clampView: at the fit scale the image cannot be panned at all, with or without overscroll', () => {
  const fit = fitView(IMG_W, IMG_H, 360, 520);
  for (const overscrollPx of [0, 120]) {
    for (const [dx, dy] of [[300, 0], [-300, 0], [0, 400], [0, -400], [55, -77]]) {
      const out = clampView(panBy(fit, dx, dy), IMG_W, IMG_H, 360, 520, { overscrollPx });
      near(out.tx, fit.tx, 1e-9, `tx after pan ${dx},${dy}`);
      near(out.ty, fit.ty, 1e-9, `ty after pan ${dx},${dy}`);
    }
  }
});

test('clampView limits the scale to [fit, max]', () => {
  const fit = fitView(IMG_W, IMG_H, 360, 520);
  const tooSmall = clampView({ scale: 0.01, tx: 170, ty: 250 }, IMG_W, IMG_H, 360, 520);
  near(tooSmall.scale, fit.scale, 1e-12);
  near(tooSmall.tx, fit.tx, 1e-9);
  near(tooSmall.ty, fit.ty, 1e-9);

  // Too deep: scale drops to the maximum and the image point at the viewport centre is kept.
  const deep = { scale: 20, tx: 180 - 700 * 20, ty: 260 - 900 * 20 };
  const out = clampView(deep, IMG_W, IMG_H, 360, 520);
  assert.equal(out.scale, MAX_SCALE);
  nearPoint(screenToImage(out, { x: 180, y: 260 }), { x: 700, y: 900 }, 1e-9);
});

test('clampView: a zoomed image can never leave a gap at a viewport edge (no overscroll)', () => {
  const scale = 1;
  const far = [
    { tx: 5000, ty: 5000, expectTx: 0, expectTy: 0 },
    { tx: -9000, ty: -9000, expectTx: 360 - IMG_W, expectTy: 520 - IMG_H },
  ];
  for (const f of far) {
    const out = clampView({ scale, tx: f.tx, ty: f.ty }, IMG_W, IMG_H, 360, 520);
    near(out.tx, f.expectTx, 1e-9);
    near(out.ty, f.expectTy, 1e-9);
  }
  // A legal position is untouched.
  const ok = clampView({ scale, tx: -400, ty: -700 }, IMG_W, IMG_H, 360, 520);
  assert.deepEqual(ok, { scale, tx: -400, ty: -700 });
});

test('clampView: overscroll allows a bounded gap when zoomed in, growing smoothly from the fit view', () => {
  // Deep zoom: the full allowance is available on both sides.
  const deep = clampView({ scale: 2, tx: 9999, ty: -99999 }, IMG_W, IMG_H, 360, 520, { overscrollPx: 100 });
  near(deep.tx, 100, 1e-9);
  near(deep.ty, 520 - IMG_H * 2 - 100, 1e-9);

  // Barely zoomed: the allowance is at most half of the overflow, so it vanishes at the fit view.
  const scale = 0.25; // content 375 x 500 in 360 x 520: 15 px overflow in x, none in y
  const slight = clampView({ scale, tx: 9999, ty: 9999 }, IMG_W, IMG_H, 360, 520, { overscrollPx: 100 });
  near(slight.tx, 7.5, 1e-9);
  near(slight.ty, (520 - 500) / 2, 1e-9, 'axis that still fits stays centred');

  // Whatever the input, most of the viewport is always covered by the image.
  for (const tx of [-1e6, -500, 0, 500, 1e6]) {
    const v = clampView({ scale: 3, tx, ty: tx }, IMG_W, IMG_H, 360, 520, { overscrollPx: 100 });
    const left = imageToScreen(v, { x: 0, y: 0 });
    const right = imageToScreen(v, { x: IMG_W, y: IMG_H });
    assert.ok(left.x <= 100 + 1e-9 && right.x >= 260 - 1e-9, 'image still spans the middle horizontally');
    assert.ok(left.y <= 100 + 1e-9 && right.y >= 420 - 1e-9, 'image still spans the middle vertically');
  }
});

test('clampView recovers from a broken view', () => {
  const fit = fitView(IMG_W, IMG_H, 360, 520);
  for (const bad of [null, { scale: NaN, tx: 0, ty: 0 }, { scale: 1, tx: NaN, ty: 0 }, { scale: -2, tx: 0, ty: 0 }, { scale: 1, tx: 0, ty: Infinity }]) {
    assert.deepEqual(clampView(bad, IMG_W, IMG_H, 360, 520), fit);
  }
});

test('clampView is idempotent', () => {
  for (const v of [{ scale: 0.3, tx: 50, ty: -900 }, { scale: 5, tx: -100, ty: 300 }, { scale: 99, tx: 0, ty: 0 }]) {
    const once = clampView(v, IMG_W, IMG_H, 360, 520, { overscrollPx: 80 });
    const twice = clampView(once, IMG_W, IMG_H, 360, 520, { overscrollPx: 80 });
    near(twice.scale, once.scale, 1e-12);
    near(twice.tx, once.tx, 1e-9);
    near(twice.ty, once.ty, 1e-9);
  }
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: clampPoint
 * ------------------------------------------------------------------------------------------ */

test('clampPoint keeps points on the image', () => {
  assert.deepEqual(clampPoint({ x: 10.25, y: 20.5 }, 100, 200), { x: 10.25, y: 20.5 });
  assert.deepEqual(clampPoint({ x: -5, y: -0.001 }, 100, 200), { x: 0, y: 0 });
  // Default is the canvas convention (pixel i covers [i, i + 1)): the far edge is at `size`.
  assert.deepEqual(clampPoint({ x: 150, y: 999 }, 100, 200), { x: 100, y: 200 });
  assert.deepEqual(clampPoint({ x: 150, y: 999 }, 100, 200, 'corner'), { x: 100, y: 200 });
  // When integers address pixel centres the last valid coordinate is size - 1.
  assert.deepEqual(clampPoint({ x: 150, y: 999 }, 100, 200, 'center'), { x: 99, y: 199 });
  assert.deepEqual(clampPoint({ x: NaN, y: Infinity }, 100, 200), { x: 0, y: 0 });
  // Does not mutate its input.
  const p = { x: 500, y: 500 };
  clampPoint(p, 100, 100);
  assert.deepEqual(p, { x: 500, y: 500 });
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: hitTestHandle
 * ------------------------------------------------------------------------------------------ */

test('hitTestHandle: nearest handle within the radius wins, none beyond it', () => {
  const view = { scale: 0.24, tx: 0, ty: 20 };
  const points = QUAD();
  const screen = points.map((p) => imageToScreen(view, p));

  points.forEach((_, i) => {
    assert.equal(hitTestHandle(points, screen[i], view), i, 'dead centre');
    assert.equal(hitTestHandle(points, { x: screen[i].x + 10, y: screen[i].y - 12 }, view), i, 'a little off');
    assert.equal(hitTestHandle(points, { x: screen[i].x + HANDLE_HIT_RADIUS_PX - 0.01, y: screen[i].y }, view), i, 'just inside');
  });

  // Just outside the radius of handle 0, heading away from every other handle.
  assert.equal(hitTestHandle(points, { x: screen[0].x - HANDLE_HIT_RADIUS_PX - 0.01, y: screen[0].y }, view), -1);
  // Middle of the quad is far from all four.
  assert.equal(hitTestHandle(points, { x: 180, y: 260 }, view), -1);
  // No points at all.
  assert.equal(hitTestHandle(null, { x: 0, y: 0 }, view), -1);
  assert.equal(hitTestHandle([], { x: 0, y: 0 }, view), -1);
});

test('hitTestHandle: with overlapping hit areas the closer handle is chosen', () => {
  const view = { scale: 1, tx: 0, ty: 0 };
  const points = [{ x: 100, y: 100 }, { x: 130, y: 100 }, { x: 130, y: 140 }, { x: 100, y: 140 }];
  assert.equal(hitTestHandle(points, { x: 112, y: 100 }, view), 0);
  assert.equal(hitTestHandle(points, { x: 118, y: 100 }, view), 1);
  assert.equal(hitTestHandle(points, { x: 127, y: 125 }, view), 2);
  assert.equal(hitTestHandle(points, { x: 103, y: 131 }, view), 3);
});

test('hitTestHandle: the radius is measured on screen, not in image px', () => {
  const points = [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 900 }, { x: 100, y: 900 }];
  const press = (view) => imageToScreen(view, { x: 120, y: 100 }); // 20 image px from handle 0
  const zoomedOut = { scale: 1, tx: 0, ty: 0 }; // 20 screen px away: hit
  const zoomedIn = { scale: 2, tx: -50, ty: -50 }; // 40 screen px away: miss
  assert.equal(hitTestHandle(points, press(zoomedOut), zoomedOut), 0);
  assert.equal(hitTestHandle(points, press(zoomedIn), zoomedIn), -1);
  assert.equal(hitTestHandle(points, press(zoomedIn), zoomedIn, 45), 0, 'custom radius');
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: loupe
 * ------------------------------------------------------------------------------------------ */

test('loupeCorner: the loupe goes to the top corner further from the finger', () => {
  const vw = 360;
  const vh = 520;
  const radius = LOUPE_DIAMETER_PX / 2;

  const fingerLeft = loupeCorner({ x: 40, y: 300 }, vw, vh);
  assert.equal(fingerLeft.side, 'right');
  assert.equal(fingerLeft.cx, vw - LOUPE_MARGIN_PX - radius);
  assert.equal(fingerLeft.cy, LOUPE_MARGIN_PX + radius);
  assert.equal(fingerLeft.radius, radius);

  const fingerRight = loupeCorner({ x: 300, y: 60 }, vw, vh);
  assert.equal(fingerRight.side, 'left');
  assert.equal(fingerRight.cx, LOUPE_MARGIN_PX + radius);
  assert.equal(fingerRight.cy, LOUPE_MARGIN_PX + radius);

  // Dead centre is a tie; it must still give a definite answer.
  assert.equal(loupeCorner({ x: 180, y: 10 }, vw, vh).side, 'right');
});

test('loupeCorner: the chosen corner really is the further one, and never under the finger', () => {
  for (const [vw, vh] of [[320, 420], [360, 520], [414, 700], [800, 380]]) {
    for (let x = 0; x <= vw; x += vw / 16) {
      for (const y of [0, 40, 100, vh / 2, vh]) {
        if (Math.abs(x - vw / 2) < 1e-9) continue; // tie
        const finger = { x, y };
        const spot = loupeCorner(finger, vw, vh);
        const other = loupeCorner({ x: vw - x, y }, vw, vh); // mirror image picks the other side
        assert.notEqual(spot.side, other.side);
        const dChosen = Math.hypot(finger.x - spot.cx, finger.y - spot.cy);
        const dOther = Math.hypot(finger.x - other.cx, finger.y - other.cy);
        assert.ok(dChosen >= dOther, `chosen corner is further (vw ${vw}, finger ${x},${y})`);
        assert.ok(dChosen > spot.radius, `finger is outside the loupe (vw ${vw}, finger ${x},${y})`);
        // Entirely inside the canvas.
        assert.ok(spot.cx - spot.radius >= 0 && spot.cx + spot.radius <= vw);
        assert.ok(spot.cy - spot.radius >= 0 && spot.cy + spot.radius <= vh);
      }
    }
  }
});

test('loupeCorner: hysteresis stops the loupe flickering around the centre line', () => {
  const vw = 360;
  const vh = 520;
  // Loupe is on the right (finger came from the left). Drifting slightly past centre keeps it.
  assert.equal(loupeCorner({ x: 190, y: 300 }, vw, vh, { previousSide: 'right' }).side, 'right');
  assert.equal(loupeCorner({ x: 200, y: 300 }, vw, vh, { previousSide: 'right' }).side, 'right');
  // Clearly on the right now: flip.
  assert.equal(loupeCorner({ x: 230, y: 300 }, vw, vh, { previousSide: 'right' }).side, 'left');
  // And symmetric the other way.
  assert.equal(loupeCorner({ x: 165, y: 300 }, vw, vh, { previousSide: 'left' }).side, 'left');
  assert.equal(loupeCorner({ x: 130, y: 300 }, vw, vh, { previousSide: 'left' }).side, 'right');
  // Even with hysteresis the finger never ends up underneath the loupe.
  for (let x = 0; x <= vw; x += 5) {
    for (const previousSide of ['left', 'right']) {
      const spot = loupeCorner({ x, y: 72 }, vw, vh, { previousSide });
      assert.ok(Math.abs(x - spot.cx) > spot.radius, `finger x=${x} clear of loupe on the ${spot.side}`);
    }
  }
});

test('loupeCorner: shrinks to fit a tiny container', () => {
  const spot = loupeCorner({ x: 10, y: 10 }, 100, 90);
  assert.equal(spot.radius, (90 - 2 * LOUPE_MARGIN_PX) / 2);
  assert.ok(spot.cx + spot.radius <= 100 && spot.cy + spot.radius <= 90);
  const custom = loupeCorner({ x: 10, y: 10 }, 400, 400, { diameter: 80, margin: 20 });
  assert.equal(custom.radius, 40);
  assert.equal(custom.cx, 400 - 20 - 40);
  assert.equal(custom.cy, 60);
});

test('loupeScale: about 4 screen px per image px and never less than 3x the view zoom', () => {
  assert.equal(loupeScale(0.24), LOUPE_MIN_SCALE);
  assert.equal(loupeScale(1), 4);
  near(loupeScale(1.5), 4.5, 1e-12);
  assert.equal(loupeScale(2), 6);
  assert.equal(loupeScale(MAX_SCALE), 3 * MAX_SCALE);
  for (const z of [0.05, 0.3, 1, 1.34, 2.5, 8]) {
    assert.ok(loupeScale(z) >= 4 && loupeScale(z) >= 3 * z);
  }
  assert.equal(loupeScale(NaN), LOUPE_MIN_SCALE);
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: framing a quad
 * ------------------------------------------------------------------------------------------ */

test('quadBounds', () => {
  assert.deepEqual(quadBounds(QUAD()), { x: 500, y: 500, width: 500, height: 1000 });
  assert.deepEqual(quadBounds([{ x: 3, y: 9 }]), { x: 3, y: 9, width: 0, height: 0 });
  assert.equal(quadBounds([]), null);
  assert.equal(quadBounds(null), null);
  assert.equal(quadBounds([{ x: 1, y: NaN }]), null);
});

test('viewForQuad frames the quad, centred, with padding around it', () => {
  const sheet = [{ x: 600, y: 900 }, { x: 800, y: 900 }, { x: 800, y: 1180 }, { x: 600, y: 1180 }];
  const vw = 360;
  const vh = 520;
  const v = viewForQuad(sheet, 0.35, IMG_W, IMG_H, vw, vh);
  const pad = 0.35 * 280;
  near(v.scale, Math.min(vw / (200 + 2 * pad), vh / (280 + 2 * pad)), 1e-9);
  // Bounding-box centre sits at the viewport centre.
  nearPoint(imageToScreen(v, { x: 700, y: 1040 }), { x: vw / 2, y: vh / 2 }, 1e-9);
  // Every corner is on screen with room for a thumb around it.
  for (const p of sheet) {
    const s = imageToScreen(v, p);
    assert.ok(s.x > 40 && s.x < vw - 40 && s.y > 40 && s.y < vh - 40, `corner at ${s.x},${s.y} has room`);
  }
  assert.ok(v.scale > fitView(IMG_W, IMG_H, vw, vh).scale, 'zoomed in relative to fit');
});

test('viewForQuad honours the zoom limits and the pan clamp', () => {
  const vw = 360;
  const vh = 520;
  const fit = fitView(IMG_W, IMG_H, vw, vh);

  const tiny = [{ x: 700, y: 900 }, { x: 702, y: 900 }, { x: 702, y: 903 }, { x: 700, y: 903 }];
  assert.equal(viewForQuad(tiny, 0.35, IMG_W, IMG_H, vw, vh).scale, MAX_SCALE);

  const whole = [{ x: 0, y: 0 }, { x: IMG_W, y: 0 }, { x: IMG_W, y: IMG_H }, { x: 0, y: IMG_H }];
  const all = viewForQuad(whole, 0.35, IMG_W, IMG_H, vw, vh);
  near(all.scale, fit.scale, 1e-12);
  near(all.tx, fit.tx, 1e-9);
  near(all.ty, fit.ty, 1e-9);

  // A quad in the image corner cannot drag the image off-screen.
  const corner = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 160 }, { x: 0, y: 160 }];
  const c = viewForQuad(corner, 0.35, IMG_W, IMG_H, vw, vh);
  assert.ok(c.tx <= 1e-9 && c.ty <= 1e-9, 'no gap without overscroll');
  const withSlack = viewForQuad(corner, 0.35, IMG_W, IMG_H, vw, vh, { overscrollPx: 60 });
  assert.ok(withSlack.tx > 0 && withSlack.tx <= 60 + 1e-9);

  assert.deepEqual(viewForQuad(null, 0.35, IMG_W, IMG_H, vw, vh), fit);
  assert.deepEqual(viewForQuad([{ x: NaN, y: 0 }], 0.35, IMG_W, IMG_H, vw, vh), fit);
});

test('viewForQuad: pixelOffset moves the framing by that many image px', () => {
  const sheet = [{ x: 600, y: 900 }, { x: 800, y: 900 }, { x: 800, y: 1180 }, { x: 600, y: 1180 }];
  const a = viewForQuad(sheet, 0.35, IMG_W, IMG_H, 360, 520);
  const b = viewForQuad(sheet, 0.35, IMG_W, IMG_H, 360, 520, { pixelOffset: 0.5 });
  near(b.scale, a.scale, 1e-12);
  nearPoint(imageToScreen(shiftView(b, 0.5), { x: 700, y: 1040 }), { x: 180, y: 260 }, 1e-9);
});

test('lerpView: exact endpoints, geometric scale in between', () => {
  const a = { scale: 0.25, tx: 0, ty: 10 };
  const b = { scale: 4, tx: -2500, ty: -3900 };
  assert.deepEqual(lerpView(a, b, 0, 360, 520), a);
  assert.deepEqual(lerpView(a, b, 1, 360, 520), b);
  assert.deepEqual(lerpView(a, b, -1, 360, 520), a);
  assert.deepEqual(lerpView(a, b, 2, 360, 520), b);
  const mid = lerpView(a, b, 0.5, 360, 520);
  near(mid.scale, 1, 1e-12);
  // The image point at the viewport centre moves in a straight line between the two.
  const centre = { x: 180, y: 260 };
  const ca = screenToImage(a, centre);
  const cb = screenToImage(b, centre);
  nearPoint(screenToImage(mid, centre), { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 }, 1e-9);
  // Returned views are copies.
  assert.notEqual(lerpView(a, b, 0, 360, 520), a);
});

test('viewsEqual tolerates rounding noise only', () => {
  const v = { scale: 0.24, tx: 0, ty: 20 };
  assert.ok(viewsEqual(v, { scale: 0.24 + 1e-9, tx: 1e-7, ty: 20 - 1e-7 }));
  assert.ok(!viewsEqual(v, { scale: 0.25, tx: 0, ty: 20 }));
  assert.ok(!viewsEqual(v, { scale: 0.24, tx: 1, ty: 20 }));
  assert.ok(!viewsEqual(v, { scale: 0.24, tx: 0, ty: 21 }));
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: pinch, ensureVisible, visible rect, backing store
 * ------------------------------------------------------------------------------------------ */

test('pinchView: the image point between the fingers stays between the fingers', () => {
  const start = { scale: 0.5, tx: -100, ty: -80 };
  const prevA = { x: 100, y: 200 };
  const prevB = { x: 200, y: 260 };
  const nextA = { x: 60, y: 150 };
  const nextB = { x: 280, y: 300 };
  const out = pinchView(start, prevA, prevB, nextA, nextB);
  const spreadRatio = Math.hypot(220, 150) / Math.hypot(100, 60);
  near(out.scale, start.scale * spreadRatio, 1e-12);
  const prevCentre = { x: 150, y: 230 };
  const nextCentre = { x: 170, y: 225 };
  nearPoint(screenToImage(out, nextCentre), screenToImage(start, prevCentre), 1e-9);
});

test('pinchView: equal spread is a pure two-finger pan; limits cap the zoom but not the pan', () => {
  const start = { scale: 2, tx: -300, ty: -500 };
  const pan = pinchView(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 130, y: 90 }, { x: 230, y: 90 });
  near(pan.scale, 2, 1e-12);
  near(pan.tx, -270, 1e-9);
  near(pan.ty, -510, 1e-9);

  const capped = pinchView(start, { x: 100, y: 100 }, { x: 110, y: 100 }, { x: 0, y: 100 }, { x: 310, y: 100 }, { minScale: 0.24, maxScale: 8 });
  assert.equal(capped.scale, 8);
  nearPoint(screenToImage(capped, { x: 155, y: 100 }), screenToImage(start, { x: 105, y: 100 }), 1e-9);

  // Fingers practically on top of each other: no zoom explosion.
  const pinched = pinchView(start, { x: 100, y: 100 }, { x: 101, y: 100 }, { x: 100, y: 100 }, { x: 180, y: 100 });
  near(pinched.scale, 2, 1e-12);
});

test('ensureVisible pans only as far as needed', () => {
  const view = { scale: 2, tx: -300, ty: -500 };
  assert.deepEqual(ensureVisible(view, { x: 180, y: 260 }, 360, 520, 40), view);
  assert.deepEqual(ensureVisible(view, { x: 10, y: 260 }, 360, 520, 40), { scale: 2, tx: -270, ty: -500 });
  assert.deepEqual(ensureVisible(view, { x: 400, y: 600 }, 360, 520, 40), { scale: 2, tx: -380, ty: -620 });
  assert.deepEqual(ensureVisible(view, { x: -50, y: -20 }, 360, 520, 0), { scale: 2, tx: -250, ty: -480 });
  // After the pan the point is exactly on the margin line.
  const p = { x: 900, y: 1400 };
  const start = { scale: 3, tx: -5000, ty: 100 };
  const moved = ensureVisible(start, imageToScreen(start, p), 360, 520, 48);
  const s = imageToScreen(moved, p);
  assert.ok(s.x >= 48 - 1e-9 && s.x <= 312 + 1e-9 && s.y >= 48 - 1e-9 && s.y <= 472 + 1e-9);
});

test('visibleImageRect: whole image at fit, an integer sub-rectangle when zoomed, null off-screen', () => {
  const fit = fitView(IMG_W, IMG_H, 360, 520);
  assert.deepEqual(visibleImageRect(fit, IMG_W, IMG_H, 360, 520), { x: 0, y: 0, width: IMG_W, height: IMG_H });

  const zoomed = { scale: 2.5, tx: -1234.5, ty: -2222.25 };
  const r = visibleImageRect(zoomed, IMG_W, IMG_H, 360, 520);
  for (const v of [r.x, r.y, r.width, r.height]) assert.ok(Number.isInteger(v));
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= IMG_W && r.y + r.height <= IMG_H);
  // It covers the viewport...
  const tl = imageToScreen(zoomed, { x: r.x, y: r.y });
  const br = imageToScreen(zoomed, { x: r.x + r.width, y: r.y + r.height });
  assert.ok(tl.x <= 0 && tl.y <= 0 && br.x >= 360 && br.y >= 520);
  // ...without much waste (at most one image px beyond each edge).
  assert.ok(tl.x > -2.5 - 1e-9 && tl.y > -2.5 - 1e-9 && br.x < 360 + 2.5 + 1e-9 && br.y < 520 + 2.5 + 1e-9);

  // Partially on screen: clipped to the image.
  const partial = visibleImageRect({ scale: 1, tx: 200, ty: -1900 }, IMG_W, IMG_H, 360, 520);
  assert.deepEqual(partial, { x: 0, y: 1900, width: 160, height: 100 });

  assert.equal(visibleImageRect({ scale: 1, tx: 5000, ty: 0 }, IMG_W, IMG_H, 360, 520), null);
  assert.equal(visibleImageRect({ scale: 1, tx: 0, ty: -5000 }, IMG_W, IMG_H, 360, 520), null);
});

test('backingStoreSize is device-pixel sharp but capped', () => {
  assert.deepEqual(backingStoreSize(360, 520, 3), { width: 1080, height: 1560, ratio: 3 });
  assert.deepEqual(backingStoreSize(360, 520, 2), { width: 720, height: 1040, ratio: 2 });
  assert.equal(backingStoreSize(360, 520, 4.5).ratio, 3, 'ratio capped at 3');
  assert.equal(backingStoreSize(360, 520, 0.5).ratio, 1, 'never below 1 for small canvases');
  assert.equal(backingStoreSize(360, 520, NaN).ratio, 1);

  const big = backingStoreSize(1200, 900, 3);
  assert.ok(big.width * big.height <= 4_000_000 * 1.01, 'pixel budget respected');
  near(big.width / big.height, 1200 / 900, 0.01, 'aspect kept');
  assert.ok(big.ratio < 3 && big.ratio > 1);

  const custom = backingStoreSize(100, 100, 3, { maxRatio: 2, maxPixels: 10_000 });
  assert.deepEqual(custom, { width: 100, height: 100, ratio: 1 });

  assert.deepEqual(backingStoreSize(0, 0, 2), { width: 1, height: 1, ratio: 2 });
});

/* ------------------------------------------------------------------------------------------ *
 * Pure maths: outline order, taps, lift-off, wheel, tab order, colours
 * ------------------------------------------------------------------------------------------ */

const isSimpleConvexLoop = (pts) => {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
};

test('outlineOrder: identity for a normal quad, untangles a bow-tie', () => {
  assert.deepEqual(outlineOrder(QUAD()), [0, 1, 2, 3]);
  // Perspective / rotated quads in TL, TR, BR, BL order are also left alone.
  assert.deepEqual(outlineOrder([{ x: 310, y: 180 }, { x: 905, y: 240 }, { x: 870, y: 1700 }, { x: 250, y: 1500 }]), [0, 1, 2, 3]);

  // TR and BR handles swapped by the customer: joining in index order would cross.
  const tangled = [{ x: 500, y: 500 }, { x: 1000, y: 1500 }, { x: 1000, y: 500 }, { x: 500, y: 1500 }];
  assert.ok(!isSimpleConvexLoop(tangled), 'index order is a bow-tie');
  const order = outlineOrder(tangled);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3], 'a permutation of all four');
  assert.ok(isSimpleConvexLoop(order.map((i) => tangled[i])), 'sorted order is a simple loop');

  // Degenerate input does not throw.
  assert.deepEqual(outlineOrder([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }]), [0, 1, 2, 3]);
});

test('isTap: short and still', () => {
  assert.ok(isTap(0, 0));
  assert.ok(isTap(TAP_SLOP_PX, TAP_MAX_MS));
  assert.ok(!isTap(TAP_SLOP_PX + 0.5, 100));
  assert.ok(!isTap(2, TAP_MAX_MS + 1));
});

test('isPinchStart: the second finger came quickly, or the first has barely left its spot', () => {
  // Quick second finger: a pinch however far the first one slid meanwhile.
  assert.ok(isPinchStart(0, 0));
  assert.ok(isPinchStart(17, 64));
  assert.ok(isPinchStart(200, PINCH_START_MS - 1));
  // Later than that, only a first finger that is still where it pressed.
  assert.ok(isPinchStart(TAP_SLOP_PX, PINCH_START_MS));
  assert.ok(isPinchStart(6, 5000));
  // A finger that has been somewhere for a while is dragging.
  assert.ok(!isPinchStart(TAP_SLOP_PX + 0.5, PINCH_START_MS));
  assert.ok(!isPinchStart(41, 400));
  assert.ok(PINCH_START_MS < TAP_MAX_MS, 'tighter than a tap: a short deliberate drag must still count');
});

test('settledPoint: ignores the roll of a lifting fingertip, keeps deliberate movement', () => {
  const sample = (t, x, sx) => ({ t, point: { x, y: 0 }, sx, sy: 0 });

  // Finger at rest at 100, then two jittery samples in the last 30 ms.
  const jitter = [sample(0, 90, 90), sample(500, 100, 100), sample(975, 101.5, 101.5), sample(990, 102, 102)];
  assert.deepEqual(settledPoint(jitter, 1000), { x: 100, y: 0 });

  // Finger still travelling fast when it lifts: the last position stands.
  const flick = [sample(900, 100, 100), sample(930, 120, 120), sample(960, 150, 150), sample(990, 180, 180)];
  assert.deepEqual(settledPoint(flick, 1000), { x: 180, y: 0 });

  // Nothing happened in the final moments: the last position stands.
  const still = [sample(0, 50, 50), sample(400, 100, 100)];
  assert.deepEqual(settledPoint(still, 1000), { x: 100, y: 0 });

  // The whole drag is shorter than the settling window: the last position stands.
  const brief = [sample(980, 100, 100), sample(990, 101, 101)];
  assert.deepEqual(settledPoint(brief, 1000), { x: 101, y: 0 });

  // Travel is judged in screen px (sx), not image px.
  const zoomedOut = [sample(500, 100, 100), sample(990, 110, 102)];
  assert.deepEqual(settledPoint(zoomedOut, 1000), { x: 100, y: 0 });

  assert.equal(settledPoint([], 1000), null);
  assert.equal(settledPoint(null, 1000), null);
  // Tunable.
  assert.deepEqual(settledPoint(jitter, 1000, { windowMs: 5 }), { x: 102, y: 0 });
  assert.deepEqual(settledPoint(jitter, 1000, { maxTravelPx: 1 }), { x: 102, y: 0 });
});

test('wheelZoomFactor: wheel up zooms in, bounded per event', () => {
  assert.equal(wheelZoomFactor(0), 1);
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.ok(wheelZoomFactor(100) < 1);
  near(wheelZoomFactor(-100) * wheelZoomFactor(100), 1, 1e-12, 'symmetric');
  assert.ok(wheelZoomFactor(-3, 1) > wheelZoomFactor(-3, 0), 'line mode counts for more than pixels');
  assert.ok(wheelZoomFactor(-10, 0, true) > wheelZoomFactor(-10, 0, false), 'trackpad pinch is more sensitive');
  assert.equal(wheelZoomFactor(-1e6), 2);
  assert.equal(wheelZoomFactor(1e6), 0.5);
  assert.equal(wheelZoomFactor(NaN), 1);
});

test('nextTabIndex walks the handles then lets focus go', () => {
  assert.equal(nextTabIndex(0, 4, false), 1);
  assert.equal(nextTabIndex(2, 4, false), 3);
  assert.equal(nextTabIndex(3, 4, false), null);
  assert.equal(nextTabIndex(3, 4, true), 2);
  assert.equal(nextTabIndex(0, 4, true), null);
  assert.equal(nextTabIndex(null, 4, false), null);
  assert.equal(nextTabIndex(0, 0, false), null);
});

test('parseCssColor', () => {
  assert.deepEqual(parseCssColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssColor('#FF7A00'), { r: 255, g: 122, b: 0, a: 1 });
  assert.deepEqual(parseCssColor('#0008'), { r: 0, g: 0, b: 0, a: 136 / 255 });
  assert.deepEqual(parseCssColor('#11223380'), { r: 17, g: 34, b: 51, a: 128 / 255 });
  assert.deepEqual(parseCssColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseCssColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseCssColor(' rgb(10 20 30 / 25%) '), { r: 10, g: 20, b: 30, a: 0.25 });
  assert.deepEqual(parseCssColor('rgb(100%, 0%, 50%)'), { r: 255, g: 0, b: 127.5, a: 1 });
  for (const bad of ['', 'red', 'var(--sm-accent)', '#12', '#12345', 'rgb(1, 2)', 'hsl(10 20% 30%)', null, 42]) {
    assert.equal(parseCssColor(bad), null, `"${bad}" is not parsed`);
  }
});

test('relativeLuminance and casingFor: line and casing always contrast with each other', () => {
  near(relativeLuminance({ r: 0, g: 0, b: 0 }), 0, 1e-12);
  near(relativeLuminance({ r: 255, g: 255, b: 255 }), 1, 1e-9);
  const dark = casingFor(parseCssColor('#ffffff'));
  const light = casingFor(parseCssColor('#0b1f3a'));
  assert.notEqual(dark, light);
  assert.equal(relativeLuminance(parseCssColor(dark)) < 0.05, true, 'dark casing under a light line');
  assert.equal(relativeLuminance(parseCssColor(light)) > 0.9, true, 'light casing under a dark line');
  assert.equal(casingFor(parseCssColor('#ff7a00')), dark, 'bright accent gets the dark casing');
  assert.equal(casingFor(null), dark, 'unknown colour gets the dark casing');
});

/* ------------------------------------------------------------------------------------------ *
 * QuadEditor against a stand-in DOM
 * ------------------------------------------------------------------------------------------ */

class Listeners {
  constructor() {
    this.items = [];
  }

  add(type, handler, options) {
    this.items.push({ type, handler, options });
  }

  remove(type, handler) {
    const i = this.items.findIndex((l) => l.type === type && l.handler === handler);
    if (i >= 0) this.items.splice(i, 1);
  }

  dispatch(type, event) {
    for (const l of this.items.filter((item) => item.type === type)) l.handler(event);
  }

  count(type) {
    return type ? this.items.filter((l) => l.type === type).length : this.items.length;
  }

  optionsFor(type) {
    return this.items.find((l) => l.type === type)?.options;
  }
}

const CTX_METHODS = new Set([
  'save', 'restore', 'setTransform', 'clearRect', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'closePath',
  'arc', 'arcTo', 'fill', 'stroke', 'clip', 'fillText', 'measureText', 'setLineDash', 'strokeRect', 'fillRect',
]);
const CTX_PROPS = new Set([
  'fillStyle', 'strokeStyle', 'lineWidth', 'lineJoin', 'lineCap', 'globalAlpha', 'font', 'textAlign',
  'textBaseline', 'imageSmoothingEnabled', 'imageSmoothingQuality', 'shadowColor', 'shadowBlur',
  'shadowOffsetX', 'shadowOffsetY',
]);

/**
 * A strict stand-in for CanvasRenderingContext2D: only real member names are allowed and every
 * numeric argument must be finite, so typos and NaN geometry in the drawing code fail the test
 * instead of silently drawing nothing.
 */
function makeContext(log) {
  const state = { imageSmoothingEnabled: true, globalAlpha: 1 };
  return new Proxy({}, {
    get(_target, prop) {
      if (CTX_METHODS.has(prop)) {
        return (...args) => {
          for (const a of args) {
            if (typeof a === 'number' && !Number.isFinite(a)) {
              throw new Error(`2d context: ${prop} called with a non-finite number (${args.join(', ')})`);
            }
          }
          log.push({ op: prop, args, state: { ...state } });
          if (prop === 'measureText') return { width: String(args[0]).length * 6.5 };
          return undefined;
        };
      }
      if (CTX_PROPS.has(prop)) return state[prop];
      throw new Error(`2d context: unknown member "${String(prop)}" read`);
    },
    set(_target, prop, value) {
      if (!CTX_PROPS.has(prop)) throw new Error(`2d context: unknown member "${String(prop)}" written`);
      state[prop] = value;
      return true;
    },
  });
}

function makeEnv({
  width = 360,
  height = 520,
  dpr = 2,
  reducedMotion = true,
  position = 'static',
  rectLeft = 20,
  rectTop = 100,
  focusVisible = false,
} = {}) {
  const env = {
    frames: new Map(),
    timers: new Map(),
    now: 1000,
    observers: [],
    drawLog: [],
    captured: new Set(),
    canvasListeners: new Listeners(),
    winListeners: new Listeners(),
    focusVisible,
    reducedMotion,
  };
  let seq = 0;

  env.win = {
    devicePixelRatio: dpr,
    requestAnimationFrame(cb) {
      const id = ++seq;
      env.frames.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      env.frames.delete(id);
    },
    setTimeout(cb, ms) {
      const id = ++seq;
      env.timers.set(id, { cb, at: env.now + ms });
      return id;
    },
    clearTimeout(id) {
      env.timers.delete(id);
    },
    performance: { now: () => env.now },
    matchMedia: (query) => ({ matches: env.reducedMotion && query.includes('prefers-reduced-motion') }),
    getComputedStyle: (el) => ({ position: el.computedPosition ?? '', color: '', fontFamily: '' }),
    ResizeObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.targets = [];
        this.disconnected = false;
        env.observers.push(this);
      }

      observe(target) {
        this.targets.push(target);
      }

      disconnect() {
        this.disconnected = true;
        this.targets = [];
      }
    },
    addEventListener: (type, handler, options) => env.winListeners.add(type, handler, options),
    removeEventListener: (type, handler) => env.winListeners.remove(type, handler),
  };

  // The editor creates two canvases: the main one first, then the loupe layer.
  env.canvas = null;
  env.loupe = null;
  env.loupeLog = [];
  env.loupeListeners = new Listeners();
  env.doc = {
    defaultView: env.win,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const isMain = env.canvas === null;
      assert.ok(isMain || env.loupe === null, 'no more than two canvases');
      const ctx = makeContext(isMain ? env.drawLog : env.loupeLog);
      const listeners = isMain ? env.canvasListeners : env.loupeListeners;
      const el = {
        tagName: 'CANVAS',
        className: '',
        style: {},
        attributes: {},
        width: 300,
        height: 150,
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
        addEventListener: (type, handler, options) => listeners.add(type, handler, options),
        removeEventListener: (type, handler) => listeners.remove(type, handler),
        getContext(type) {
          assert.equal(type, '2d');
          return ctx;
        },
        getBoundingClientRect: () => ({
          left: rectLeft, top: rectTop, width: env.container.clientWidth, height: env.container.clientHeight,
        }),
        setPointerCapture: (id) => env.captured.add(id),
        releasePointerCapture: (id) => env.captured.delete(id),
        hasPointerCapture: (id) => env.captured.has(id),
        matches: (selector) => selector === ':focus-visible' && env.focusVisible,
        remove() {
          if (this.parentNode) this.parentNode.removeChild(this);
        },
      };
      if (isMain) env.canvas = el;
      else env.loupe = el;
      return el;
    },
  };

  env.container = {
    ownerDocument: env.doc,
    isConnected: true,
    computedPosition: position,
    style: { position: '' },
    clientWidth: width,
    clientHeight: height,
    children: [],
    appendChild(el) {
      this.children.push(el);
      el.parentNode = this;
      return el;
    },
    removeChild(el) {
      this.children = this.children.filter((c) => c !== el);
      el.parentNode = null;
      return el;
    },
  };

  env.image = { width: IMG_W, height: IMG_H };

  /** Run every queued animation frame once (frames queued while running wait for the next flush). */
  env.flushFrames = () => {
    const batch = [...env.frames.entries()];
    env.frames.clear();
    for (const [, cb] of batch) cb(env.now);
    return batch.length;
  };

  env.advance = (ms) => {
    env.now += ms;
    for (const [id, timer] of [...env.timers.entries()]) {
      if (timer.at <= env.now) {
        env.timers.delete(id);
        timer.cb();
      }
    }
  };

  /** Dispatch an event on the canvas. x / y are canvas-local CSS px. */
  env.fire = (type, { x = 0, y = 0, ...props } = {}) => {
    const event = {
      type,
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: x + rectLeft,
      clientY: y + rectTop,
      timeStamp: env.now,
      cancelable: true,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...props,
    };
    env.canvasListeners.dispatch(type, event);
    return event;
  };
  env.down = (id, x, y, props) => env.fire('pointerdown', { pointerId: id, x, y, ...props });
  env.move = (id, x, y, props) => env.fire('pointermove', { pointerId: id, x, y, ...props });
  env.up = (id, x, y, props) => env.fire('pointerup', { pointerId: id, x, y, ...props });
  env.cancel = (id, props) => env.fire('pointercancel', { pointerId: id, ...props });
  env.key = (key, props) => env.fire('keydown', { key, ...props });

  return env;
}

function setup(envOptions = {}, editorOptions = {}) {
  const env = makeEnv(envOptions);
  const changes = [];
  const taps = [];
  const actives = [];
  const checks = [];
  const editor = new QuadEditor(env.container, {
    image: env.image,
    imageWidth: IMG_W,
    imageHeight: IMG_H,
    points: QUAD(),
    color: '#ff7a00',
    ariaLabel: 'Photo of your door. Drag the four corners.',
    onChange: (points, meta) => changes.push({ points, meta }),
    onTap: (point) => taps.push(point),
    onActiveChange: (index) => actives.push(index),
    onHandleCheck: (index) => checks.push(index),
    ...editorOptions,
  });
  /** Screen position of handle i (`offset` is 0.5 for an editor built with pixelOrigin 'center'). */
  const handleAt = (i, offset = 0) => imageToScreen(shiftView(editor.getView(), offset), editor.getPoints()[i]);
  return { env, editor, changes, taps, actives, checks, handleAt };
}

test('QuadEditor: builds an accessible canvas that fills the container', () => {
  const { env, editor } = setup();
  const canvas = env.canvas;
  assert.equal(env.container.children.length, 2);
  assert.equal(env.container.children[0], canvas);
  // The loupe layer: decorative, never in the way of a touch, hidden until needed.
  assert.equal(env.container.children[1], env.loupe);
  assert.equal(env.loupe.attributes['aria-hidden'], 'true');
  assert.equal(env.loupe.attributes.tabindex, undefined);
  assert.equal(env.loupe.style.pointerEvents, 'none');
  assert.equal(env.loupe.style.display, 'none');
  assert.equal(env.loupe.style.position, 'absolute');
  assert.ok(Number(env.loupe.style.zIndex) > 2, 'above controls the host floats over the photo');
  assert.equal(env.loupeListeners.count(), 0);
  assert.equal(canvas.attributes.tabindex, '0');
  assert.equal(canvas.attributes.role, 'application');
  assert.equal(canvas.attributes['aria-label'], 'Photo of your door. Drag the four corners.');
  assert.equal(canvas.style.touchAction, 'none');
  assert.equal(canvas.style.position, 'absolute');
  assert.equal(canvas.style.width, '100%');
  assert.equal(canvas.style.height, '100%');
  assert.equal(env.container.style.position, 'relative', 'static container becomes the positioning parent');
  // Backing store follows devicePixelRatio.
  assert.equal(canvas.width, 720);
  assert.equal(canvas.height, 1040);
  // Starts letterboxed.
  assert.deepEqual(editor.getView(), fitView(IMG_W, IMG_H, 360, 520));
  // Observes its container.
  assert.equal(env.observers.length, 1);
  assert.deepEqual(env.observers[0].targets, [env.container]);
  // Wheel and touchmove listeners must be able to preventDefault.
  assert.equal(env.canvasListeners.optionsFor('wheel').passive, false);
  assert.equal(env.canvasListeners.optionsFor('touchmove').passive, false);
  editor.destroy();
});

test('QuadEditor: leaves an already positioned container alone', () => {
  const { env, editor } = setup({ position: 'absolute' });
  assert.equal(env.container.style.position, '');
  editor.destroy();
  assert.equal(env.container.style.position, '');
});

test('QuadEditor: requires a container', () => {
  assert.throws(() => new QuadEditor(null, {}), TypeError);
  assert.throws(() => new QuadEditor({}, {}), TypeError);
});

test('QuadEditor: getPoints returns copies; setPoints clamps and does not fire onChange', () => {
  const { editor, changes } = setup();
  const a = editor.getPoints();
  assert.deepEqual(a, QUAD());
  a[0].x = -999;
  assert.deepEqual(editor.getPoints(), QUAD(), 'mutating the copy changes nothing');

  const mine = [{ x: -10, y: 5 }, { x: 5000, y: 5 }, { x: 5000, y: 5000 }, { x: 10, y: 2500 }];
  editor.setPoints(mine);
  assert.deepEqual(editor.getPoints(), [{ x: 0, y: 5 }, { x: 1500, y: 5 }, { x: 1500, y: 2000 }, { x: 10, y: 2000 }]);
  assert.deepEqual(mine[0], { x: -10, y: 5 }, 'input is not mutated');
  assert.equal(changes.length, 0);

  editor.setPoints(null);
  assert.equal(editor.getPoints(), null);
  for (const bad of [[{ x: 1, y: 1 }], 'nope', [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: NaN, y: 4 }]]) {
    editor.setPoints(QUAD());
    editor.setPoints(bad);
    assert.equal(editor.getPoints(), null, 'invalid input clears the points');
  }
  assert.equal(changes.length, 0);
  editor.destroy();
});

test('QuadEditor: dragging a handle keeps the grab offset, reports live changes and a final one', () => {
  const { env, editor, changes, actives, handleAt } = setup();
  const start = handleAt(0);
  const scale = editor.getView().scale;

  // Grab 10 px right and 6 px below the handle centre.
  const grab = { x: start.x + 10, y: start.y + 6 };
  env.down(1, grab.x, grab.y);
  assert.equal(editor.getActive(), 0);
  assert.deepEqual(actives, [0]);
  assert.ok(env.captured.has(1), 'pointer captured');
  assert.equal(changes.length, 0, 'grabbing alone changes nothing');

  // Inside the dead zone: still nothing.
  env.move(1, grab.x + 2, grab.y + 1);
  assert.equal(changes.length, 0);
  nearPoint(handleAt(0), start, 1e-9);

  // Leaving the dead zone: the handle sets off from rest (no jump).
  env.move(1, grab.x + 5, grab.y);
  assert.equal(changes.length, 0);
  nearPoint(handleAt(0), start, 1e-9);

  // From here the handle follows the finger exactly.
  env.move(1, grab.x + 45, grab.y + 30);
  nearPoint(handleAt(0), { x: start.x + 40, y: start.y + 30 }, 1e-9, 'handle moved by the finger delta');
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].meta, { final: false, index: 0 });
  nearPoint(changes[0].points[0], { x: 500 + 40 / scale, y: 500 + 30 / scale }, 1e-9);
  assert.deepEqual(changes[0].points.slice(1), QUAD().slice(1), 'other corners untouched');

  env.move(1, grab.x + 25, grab.y + 50);
  nearPoint(handleAt(0), { x: start.x + 20, y: start.y + 50 }, 1e-9);
  assert.equal(changes.length, 2);

  env.advance(400);
  env.up(1, grab.x + 25, grab.y + 50);
  assert.equal(changes.length, 3);
  assert.deepEqual(changes[2].meta, { final: true, index: 0 });
  assert.deepEqual(changes[2].points, editor.getPoints());
  nearPoint(editor.getPoints()[0], { x: 500 + 20 / scale, y: 500 + 50 / scale }, 1e-9);
  assert.ok(!env.captured.has(1), 'capture released');
  assert.equal(editor.getActive(), 0, 'handle stays active after the drag');

  // Callback arguments are copies.
  changes[2].points[0].x = 0;
  assert.notEqual(editor.getPoints()[0].x, 0);

  // A later move without a press does nothing.
  env.move(1, 10, 10);
  assert.equal(changes.length, 3);
  editor.destroy();
});

test('QuadEditor: a dragged handle is clamped to the image', () => {
  const { env, editor, changes, handleAt } = setup();
  const s = handleAt(0);
  env.down(1, s.x, s.y, { pointerType: 'mouse' });
  env.move(1, s.x - 3, s.y, { pointerType: 'mouse' });
  env.move(1, -500, -500, { pointerType: 'mouse' });
  assert.deepEqual(editor.getPoints()[0], { x: 0, y: 0 });
  env.move(1, 5000, 5000, { pointerType: 'mouse' });
  assert.deepEqual(editor.getPoints()[0], { x: IMG_W, y: IMG_H });
  env.up(1, 5000, 5000, { pointerType: 'mouse' });
  assert.equal(changes.at(-1).meta.final, true);
  editor.destroy();
});

test('QuadEditor: tapping a handle selects it without moving it', () => {
  const { env, editor, changes, taps, actives, handleAt } = setup();
  const s = handleAt(2);
  env.down(1, s.x + 8, s.y - 9);
  env.move(1, s.x + 9, s.y - 8);
  env.advance(80);
  env.up(1, s.x + 9, s.y - 8);
  assert.equal(editor.getActive(), 2);
  assert.deepEqual(actives, [2]);
  assert.equal(changes.length, 0);
  assert.equal(taps.length, 0, 'a tap on a handle is not an image tap');
  assert.deepEqual(editor.getPoints(), QUAD());
  editor.destroy();
});

test('QuadEditor: a tap or click on a handle that wobbles out of the dead zone reports nothing', () => {
  // Touch: the fingertip rolls 5 px during a 90 ms tap.
  {
    const { env, editor, changes, taps, actives, handleAt } = setup();
    const s = handleAt(2);
    env.down(1, s.x + 3, s.y - 2);
    env.advance(30);
    env.move(1, s.x + 8, s.y - 2);
    env.advance(60);
    env.up(1, s.x + 8, s.y - 2);
    assert.equal(changes.length, 0, 'touch tap');
    assert.deepEqual(editor.getPoints(), QUAD());
    assert.equal(editor.getActive(), 2, 'the tap still selects the handle');
    assert.deepEqual(actives, [2]);
    assert.equal(taps.length, 0);
    editor.destroy();
  }
  // Mouse: the pointer travels 2.8 px during the click.
  {
    const { env, editor, changes, handleAt } = setup();
    const mouse = { pointerType: 'mouse' };
    const s = handleAt(0);
    env.down(1, s.x, s.y, mouse);
    env.move(1, s.x + 2, s.y + 2, mouse);
    env.up(1, s.x + 2, s.y + 2, mouse);
    assert.equal(changes.length, 0, 'mouse click');
    assert.deepEqual(editor.getPoints(), QUAD());
    editor.destroy();
  }
  // The same wobble ended by the browser taking the gesture away.
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const { env, editor, changes, handleAt } = setup();
    const s = handleAt(1);
    env.down(1, s.x, s.y);
    env.move(1, s.x, s.y + 6);
    env.fire(ending, { pointerId: 1 });
    assert.equal(changes.length, 0, ending);
    assert.deepEqual(editor.getPoints(), QUAD());
    editor.destroy();
  }
  // A handle already against the edge of the photo, pulled further out: it cannot move.
  {
    const { env, editor, changes, handleAt } = setup();
    const corner = QUAD();
    corner[0] = { x: 0, y: 0 };
    editor.setPoints(corner);
    const s = handleAt(0);
    env.down(1, s.x, s.y, { pointerType: 'mouse' });
    env.move(1, s.x - 3, s.y, { pointerType: 'mouse' });
    env.move(1, s.x - 40, s.y - 15, { pointerType: 'mouse' });
    env.up(1, s.x - 40, s.y - 15, { pointerType: 'mouse' });
    assert.equal(changes.length, 0, 'clamped drag');
    assert.deepEqual(editor.getPoints(), corner);
    editor.destroy();
  }
});

test('QuadEditor: a handle that lift-off jitter leaves where it started is shown going back, not committed', () => {
  const { env, editor, changes, handleAt } = setup();
  const s = handleAt(0);
  env.down(1, s.x, s.y);
  env.advance(10);
  env.move(1, s.x + 5, s.y); // out of the dead zone
  env.advance(40);
  env.move(1, s.x + 5.7, s.y); // the handle follows by a hair
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].meta, { final: false, index: 0 });
  assert.notDeepEqual(changes[0].points, QUAD());
  env.advance(50);
  env.up(1, s.x + 5.7, s.y); // the roll of the lifting fingertip is taken back out
  assert.deepEqual(editor.getPoints(), QUAD(), 'the corner is exactly where it started');
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].meta, { final: false, index: 0 }, 'nothing changed, so nothing is final');
  assert.deepEqual(changes[1].points, QUAD(), 'listeners that followed the drag see the corner back in place');

  // A real move of the same handle afterwards is committed as usual.
  env.advance(500);
  env.down(1, s.x, s.y);
  env.move(1, s.x + 6, s.y);
  env.move(1, s.x + 26, s.y + 10);
  env.advance(400);
  env.up(1, s.x + 26, s.y + 10);
  assert.deepEqual(changes.at(-1).meta, { final: true, index: 0 });
  assert.notDeepEqual(changes.at(-1).points, QUAD());
  editor.destroy();
});

test('QuadEditor: a tap on empty image fires onTap with the image point', () => {
  const { env, editor, taps, changes } = setup();
  const view = editor.getView();
  env.down(1, 200, 300);
  env.move(1, 203, 304);
  env.advance(120);
  env.up(1, 203, 304);
  assert.equal(taps.length, 1);
  // Canvas convention: the point is simply where the press started, in bitmap coordinates.
  nearPoint(taps[0], screenToImage(view, { x: 200, y: 300 }), 1e-9);
  near(taps[0].x, 200 / 0.24, 1e-9);
  near(taps[0].y, (300 - 20) / 0.24, 1e-9);
  assert.equal(changes.length, 0);
  assert.equal(editor.getActive(), null);
  editor.destroy();
});

test('QuadEditor: pixelOrigin "center" shifts points half a pixel against the bitmap', () => {
  const { env, editor, taps, handleAt } = setup({}, { pixelOrigin: 'center' });
  const view = editor.getView();
  assert.deepEqual(view, fitView(IMG_W, IMG_H, 360, 520), 'the photo itself is drawn in the same place');

  // Point (500, 500) names the centre of pixel (500, 500), which the canvas draws at 500.5.
  nearPoint(handleAt(0, 0.5), imageToScreen(view, { x: 500.5, y: 500.5 }), 1e-12);
  env.down(1, 200, 300);
  env.up(1, 200, 300);
  const bitmap = screenToImage(view, { x: 200, y: 300 });
  nearPoint(taps[0], { x: bitmap.x - 0.5, y: bitmap.y - 0.5 }, 1e-9);

  // The last addressable pixel centre is size - 1.
  editor.setPoints([{ x: 0, y: 0 }, { x: 9999, y: 0 }, { x: 9999, y: 9999 }, { x: 0, y: 9999 }]);
  assert.deepEqual(editor.getPoints()[2], { x: IMG_W - 1, y: IMG_H - 1 });

  // Dragging and the loupe use the same shifted frame.
  editor.setPoints(QUAD());
  const s = handleAt(0, 0.5);
  env.down(1, s.x, s.y, { pointerType: 'mouse' });
  env.move(1, s.x + 3, s.y, { pointerType: 'mouse' });
  env.move(1, s.x + 27, s.y + 12, { pointerType: 'mouse' });
  nearPoint(handleAt(0, 0.5), { x: s.x + 24, y: s.y + 12 }, 1e-9);
  env.flushFrames();
  const loupeImage = env.loupeLog.findLast((c) => c.op === 'drawImage');
  const [, sx, sy, , , dx, dy] = loupeImage.args;
  const p = editor.getPoints()[0];
  const centre = LOUPE_MARGIN_PX + LOUPE_DIAMETER_PX / 2;
  near(dx + (p.x + 0.5 - sx) * LOUPE_MIN_SCALE, centre, 1e-6, 'pixel centre under the crosshair');
  near(dy + (p.y + 0.5 - sy) * LOUPE_MIN_SCALE, centre, 1e-6);
  env.up(1, s.x + 27, s.y + 12, { pointerType: 'mouse' });
  editor.destroy();
});

test('QuadEditor: no onTap for a drag, a long press, a cancelled press or a tap off the photo', () => {
  const { env, editor, taps } = setup();

  env.down(1, 200, 300);
  env.move(1, 200 + TAP_SLOP_PX + 5, 300);
  env.up(1, 200 + TAP_SLOP_PX + 5, 300);
  assert.equal(taps.length, 0, 'moved too far');

  env.down(1, 200, 300);
  env.advance(TAP_MAX_MS + 150);
  env.up(1, 200, 300);
  assert.equal(taps.length, 0, 'held too long');

  env.down(1, 200, 300);
  env.cancel(1);
  assert.equal(taps.length, 0, 'cancelled');

  // The photo is letterboxed with 20 px bars top and bottom in this container.
  env.down(1, 180, 8);
  env.up(1, 180, 8);
  assert.equal(taps.length, 0, 'tap on the letterbox bar');

  env.down(1, 200, 300, { pointerType: 'mouse', button: 2 });
  env.up(1, 200, 300, { pointerType: 'mouse', button: 2 });
  assert.equal(taps.length, 0, 'right mouse button');

  env.down(1, 200, 300, { pointerType: 'mouse' });
  env.up(1, 200, 300, { pointerType: 'mouse' });
  assert.equal(taps.length, 1, 'a plain click does count');
  editor.destroy();
});

test('QuadEditor: a second finger during an established handle drag commits the drag and starts a pinch', () => {
  const { env, editor, changes, handleAt } = setup();
  const s = handleAt(1);
  env.down(1, s.x, s.y);
  env.move(1, s.x + 6, s.y);
  env.move(1, s.x + 36, s.y + 20);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].meta.final, false);
  const dragged = editor.getPoints();

  // The corner has been carried well away from where it was grabbed, and not just now: a drag.
  env.advance(400);
  env.down(2, s.x - 100, s.y + 200);
  assert.equal(changes.length, 2, 'drag committed when the second finger lands');
  assert.deepEqual(changes[1].meta, { final: true, index: 1 });
  assert.deepEqual(changes[1].points, dragged);

  // Now the two fingers pinch: the view zooms and no handle moves.
  const before = editor.getView();
  env.move(1, s.x + 86, s.y + 20);
  env.move(2, s.x - 150, s.y + 200);
  assert.ok(editor.getView().scale > before.scale, 'zoomed in');
  assert.deepEqual(editor.getPoints(), dragged, 'points untouched by the pinch');
  assert.equal(changes.length, 2);

  env.up(1, s.x + 86, s.y + 20);
  env.up(2, s.x - 150, s.y + 200);
  assert.equal(changes.length, 2);
  editor.destroy();
});

test('QuadEditor: the first finger of a pinch that lands on a handle does not move it', () => {
  const { env, editor, changes, handleAt } = setup();
  const s = handleAt(1);
  // Finger 1 lands 18 px from the corner, already sliding as the hand spreads.
  env.down(1, s.x - 14, s.y + 11);
  env.advance(16);
  env.move(1, s.x - 9, s.y + 8);
  env.advance(16);
  env.move(1, s.x - 2, s.y + 3);
  env.advance(16);
  env.move(1, s.x + 3, s.y - 1);
  assert.equal(changes.length, 2, 'the corner follows the finger meanwhile');
  assert.notDeepEqual(editor.getPoints(), QUAD());

  // Finger 2 lands 64 ms after the first: the two were a pinch all along.
  env.advance(16);
  env.down(2, s.x - 120, s.y + 180);
  assert.deepEqual(editor.getPoints(), QUAD(), 'the corner is back where it was');
  assert.equal(changes.length, 3);
  assert.deepEqual(changes[2].meta, { final: false, index: 1 });
  assert.deepEqual(changes[2].points, QUAD(), 'listeners are shown the corner going back');
  assert.ok(changes.every((c) => c.meta.final === false), 'and nothing is committed');

  // The pair pinches as usual and no handle moves.
  const before = editor.getView();
  env.move(1, s.x + 43, s.y - 31);
  env.move(2, s.x - 160, s.y + 220);
  assert.ok(editor.getView().scale > before.scale, 'zoomed in');
  env.up(1, s.x + 43, s.y - 31);
  env.up(2, s.x - 160, s.y + 220);
  assert.equal(changes.length, 3);
  assert.deepEqual(editor.getPoints(), QUAD());
  assert.equal(editor.getActive(), 1);
  editor.destroy();
});

test('QuadEditor: a finger resting on a handle that only wobbles is not a drag when a second finger joins', () => {
  // However late the second finger comes, the first has stayed within a tap's travel of its spot.
  {
    const { env, editor, changes, handleAt } = setup();
    const s = handleAt(3);
    env.down(1, s.x + 6, s.y + 4);
    env.advance(500);
    env.move(1, s.x + 11, s.y + 4);
    env.advance(100);
    env.move(1, s.x + 13, s.y + 7);
    assert.equal(changes.length, 1);
    assert.notDeepEqual(editor.getPoints(), QUAD());
    env.advance(300);
    env.down(2, 300, 100);
    assert.deepEqual(editor.getPoints(), QUAD());
    assert.deepEqual(changes.at(-1).meta, { final: false, index: 3 });
    assert.deepEqual(changes.at(-1).points, QUAD());
    assert.ok(changes.every((c) => c.meta.final === false));
    env.up(1, s.x + 13, s.y + 7);
    env.up(2, 300, 100);
    assert.equal(changes.length, 2);
    editor.destroy();
  }
  // One move out of the dead zone and then the second finger: the corner never moved, so there
  // is nothing to report at all.
  {
    const { env, editor, changes, handleAt } = setup();
    const s = handleAt(0);
    env.down(1, s.x, s.y);
    env.advance(20);
    env.move(1, s.x + 5, s.y);
    env.advance(20);
    env.down(2, 300, 400);
    env.up(1, s.x + 5, s.y);
    env.up(2, 300, 400);
    assert.equal(changes.length, 0);
    assert.deepEqual(editor.getPoints(), QUAD());
    editor.destroy();
  }
});

test('QuadEditor: a pinch start puts the handle back where the host last had it', () => {
  // The host replaced the points while the finger was down.
  {
    const { env, editor, changes, handleAt } = setup();
    const s = handleAt(0);
    env.down(1, s.x, s.y);
    env.move(1, s.x + 6, s.y);
    env.move(1, s.x + 16, s.y + 8);
    const snapped = QUAD();
    snapped[0] = { x: 640, y: 610 };
    editor.setPoints(snapped);
    env.move(1, s.x + 21, s.y + 8);
    assert.notDeepEqual(editor.getPoints(), snapped);
    env.down(2, 300, 400);
    assert.deepEqual(editor.getPoints(), snapped, 'back to the corner the host set, not the one before it');
    assert.deepEqual(changes.at(-1).meta, { final: false, index: 0 });
    assert.deepEqual(changes.at(-1).points, snapped);
    assert.ok(changes.every((c) => c.meta.final === false));
    editor.destroy();
  }
  // A nudge while the finger was down was reported as final: that much stays.
  {
    const { env, editor, changes, handleAt } = setup();
    const s = handleAt(0);
    env.down(1, s.x, s.y);
    env.move(1, s.x + 6, s.y);
    env.move(1, s.x + 16, s.y + 8);
    editor.nudge(1, 0);
    const nudged = editor.getPoints();
    assert.deepEqual(changes.at(-1), { points: nudged, meta: { final: true, index: 0 } });
    env.move(1, s.x + 26, s.y + 8);
    assert.notDeepEqual(editor.getPoints(), nudged);
    env.down(2, 300, 400);
    assert.deepEqual(editor.getPoints(), nudged, 'what the host was told for good is kept');
    assert.deepEqual(changes.at(-1), { points: nudged, meta: { final: false, index: 0 } });
    assert.equal(changes.filter((c) => c.meta.final).length, 1, 'only the nudge was final');
    editor.destroy();
  }
});

test('QuadEditor: a second finger on a handle that was grabbed but not moved commits nothing', () => {
  const { env, editor, changes, handleAt } = setup();
  const s = handleAt(1);
  env.down(1, s.x, s.y);
  env.down(2, 60, 400);
  env.move(2, 40, 430);
  env.up(1, s.x, s.y);
  env.up(2, 40, 430);
  assert.equal(changes.length, 0);
  assert.deepEqual(editor.getPoints(), QUAD());
  editor.destroy();
});

test('QuadEditor: pinch zooms about the point between the fingers', () => {
  const { env, editor, taps, changes } = setup();
  const start = editor.getView();
  const anchor = screenToImage(start, { x: 150, y: 200 });

  env.down(1, 100, 200);
  env.down(2, 200, 200);
  env.move(1, 50, 200);
  env.move(2, 250, 200);
  const v = editor.getView();
  near(v.scale, start.scale * 2, 1e-9, 'spread doubled, zoom doubled');
  nearPoint(screenToImage(v, { x: 150, y: 200 }), anchor, 1e-6, 'anchor still between the fingers');

  // Lifting one finger leaves the other panning; lifting both is never a tap.
  env.up(2, 250, 200);
  env.move(1, 20, 170);
  const panned = editor.getView();
  near(panned.scale, v.scale, 1e-12);
  near(panned.tx, v.tx - 30, 1e-9);
  near(panned.ty, v.ty - 30, 1e-9);
  env.up(1, 20, 170);
  assert.equal(taps.length, 0);
  assert.equal(changes.length, 0);
  editor.destroy();
});

test('QuadEditor: pinch cannot zoom out past the fit view or in past the maximum', () => {
  const { env, editor } = setup();
  const fit = fitView(IMG_W, IMG_H, 360, 520);

  env.down(1, 60, 260);
  env.down(2, 300, 260);
  env.move(1, 170, 260);
  env.move(2, 190, 260);
  const out = editor.getView();
  near(out.scale, fit.scale, 1e-12);
  near(out.tx, fit.tx, 1e-9);
  near(out.ty, fit.ty, 1e-9);
  env.up(1, 170, 260);
  env.up(2, 190, 260);

  for (let i = 0; i < 8; i++) {
    env.down(1, 170, 260);
    env.down(2, 190, 260);
    env.move(1, 20, 260);
    env.move(2, 340, 260);
    env.up(1, 20, 260);
    env.up(2, 340, 260);
  }
  assert.equal(editor.getView().scale, MAX_SCALE);
  editor.destroy();
});

test('QuadEditor: a third finger is ignored', () => {
  const { env, editor } = setup();
  env.down(1, 100, 200);
  env.down(2, 200, 200);
  const before = editor.getView();
  env.down(3, 300, 400);
  env.move(3, 10, 10);
  env.up(3, 10, 10);
  assert.deepEqual(editor.getView(), before);
  // The original two still pinch.
  env.move(2, 260, 200);
  assert.ok(editor.getView().scale > before.scale);
  env.up(1, 100, 200);
  env.up(2, 260, 200);
  editor.destroy();
});

test('QuadEditor: one-finger drag pans only when zoomed in, and the pan is clamped', () => {
  const { env, editor, taps } = setup();
  const fit = editor.getView();

  // At the fit view there is nothing to pan.
  env.down(1, 180, 260);
  env.move(1, 240, 300);
  env.move(1, 300, 380);
  env.up(1, 300, 380);
  assert.deepEqual(editor.getView(), fit);
  assert.equal(taps.length, 0);

  // Zoom in with the wheel, then pan.
  for (let i = 0; i < 6; i++) env.fire('wheel', { x: 180, y: 260, deltaY: -400, deltaMode: 0 });
  const zoomed = editor.getView();
  assert.ok(zoomed.scale > fit.scale * 4);

  env.down(1, 180, 260);
  env.move(1, 180 + TAP_SLOP_PX + 2, 260); // leaves the tap slop; panning starts from here
  env.move(1, 180 + TAP_SLOP_PX + 42, 235);
  const panned = editor.getView();
  near(panned.scale, zoomed.scale, 1e-12);
  near(panned.tx, zoomed.tx + 40, 1e-9);
  near(panned.ty, zoomed.ty - 25, 1e-9);

  // Fling far beyond the edge: the photo stays on screen.
  env.move(1, 100000, 100000);
  env.up(1, 100000, 100000);
  const flung = editor.getView();
  const topLeft = imageToScreen(flung, { x: 0, y: 0 });
  assert.ok(topLeft.x <= 360 * 0.3 + 1e-9 && topLeft.y <= 360 * 0.3 + 1e-9, 'bounded gap at the top-left');
  assert.ok(topLeft.x >= 0 && topLeft.y >= 0);
  assert.equal(taps.length, 0);
  editor.destroy();
});

test('QuadEditor: wheel zooms about the cursor and prevents page scroll', () => {
  const { env, editor } = setup();
  const start = editor.getView();
  const cursor = { x: 250, y: 150 };
  const anchor = screenToImage(start, cursor);

  const e = env.fire('wheel', { ...cursor, deltaY: -200, deltaMode: 0, pointerType: 'mouse' });
  assert.equal(e.defaultPrevented, true);
  const v = editor.getView();
  near(v.scale, start.scale * wheelZoomFactor(-200), 1e-12);
  nearPoint(screenToImage(v, cursor), anchor, 1e-6);

  // Wheel down past the fit view stops at the fit view.
  for (let i = 0; i < 10; i++) env.fire('wheel', { ...cursor, deltaY: 600 });
  assert.deepEqual(editor.getView(), start);
  editor.destroy();
});

test('QuadEditor: pointercancel and lostpointercapture end a drag with a final change', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const { env, editor, changes, handleAt } = setup();
    const s = handleAt(3);
    env.down(1, s.x, s.y);
    env.move(1, s.x, s.y + 6);
    env.move(1, s.x + 30, s.y + 36);
    assert.equal(changes.length, 1);
    env.fire(ending, { pointerId: 1 });
    assert.equal(changes.length, 2, ending);
    assert.deepEqual(changes[1].meta, { final: true, index: 3 });
    assert.deepEqual(changes[1].points, editor.getPoints());
    // The gesture is over: further moves do nothing.
    env.move(1, s.x + 90, s.y + 90);
    assert.equal(changes.length, 2);
    // And a fresh press works normally.
    env.down(1, 200, 300);
    env.up(1, 200, 300);
    editor.destroy();
  }
});

test('QuadEditor: a pointer that never reported its release cannot poison later gestures', () => {
  // Same pointer id pressed again without a release in between.
  {
    const { env, editor, changes, taps, handleAt } = setup();
    const s = handleAt(0);
    env.down(1, s.x, s.y);
    env.move(1, s.x + 6, s.y);
    env.move(1, s.x + 30, s.y + 10);
    assert.equal(changes.at(-1).meta.final, false);
    env.down(1, 200, 300); // the release was lost; the same finger presses empty image
    assert.deepEqual(changes.at(-1).meta, { final: true, index: 0 }, 'the interrupted drag is committed');
    env.up(1, 200, 300);
    assert.equal(taps.length, 1, 'and the new press is an ordinary tap');
    editor.destroy();
  }
  // A different finger starts a brand new touch sequence (isPrimary) while a stale one is on the books.
  {
    const { env, editor, changes, taps, handleAt } = setup();
    const s = handleAt(2);
    env.down(7, s.x, s.y);
    env.move(7, s.x - 6, s.y);
    env.move(7, s.x - 40, s.y - 10);
    const dragged = editor.getPoints();
    env.down(8, 200, 300, { isPrimary: true });
    assert.deepEqual(changes.at(-1).meta, { final: true, index: 2 });
    const before = editor.getView();
    env.move(8, 204, 303);
    env.up(8, 204, 303);
    assert.deepEqual(editor.getView(), before, 'not treated as a pinch with the ghost finger');
    assert.equal(taps.length, 1);
    assert.deepEqual(editor.getPoints(), dragged);
    // A genuine second finger (not primary) still makes a pinch.
    env.down(1, 100, 300, { isPrimary: true });
    env.down(2, 200, 300, { isPrimary: false });
    env.move(2, 280, 300);
    assert.ok(editor.getView().scale > before.scale);
    env.up(1, 100, 300);
    env.up(2, 280, 300);
    editor.destroy();
  }
});

test('QuadEditor: lostpointercapture after a normal pointerup is ignored', () => {
  const { env, editor, changes, handleAt } = setup();
  const s = handleAt(0);
  env.down(1, s.x, s.y);
  env.move(1, s.x + 6, s.y);
  env.move(1, s.x + 30, s.y);
  env.advance(300);
  env.up(1, s.x + 30, s.y);
  const count = changes.length;
  env.fire('lostpointercapture', { pointerId: 1 });
  assert.equal(changes.length, count);
  editor.destroy();
});

test('QuadEditor: touch lift-off jitter is discarded, a mouse release is taken literally', () => {
  {
    const { env, editor, changes, handleAt } = setup();
    const s = handleAt(0);
    env.down(1, s.x, s.y);
    env.advance(50);
    env.move(1, s.x + 6, s.y);
    env.advance(50);
    env.move(1, s.x + 46, s.y + 30);
    const rested = editor.getPoints()[0];
    env.advance(600); // finger rests on the corner
    env.move(1, s.x + 47.5, s.y + 31); // fingertip rolls as it lifts
    env.advance(12);
    env.move(1, s.x + 48, s.y + 32);
    env.advance(10);
    env.up(1, s.x + 48, s.y + 32);
    assert.deepEqual(changes.at(-1).meta, { final: true, index: 0 });
    assert.deepEqual(changes.at(-1).points[0], rested, 'committed where the finger rested');
    assert.deepEqual(editor.getPoints()[0], rested);
    editor.destroy();
  }
  {
    const { env, editor, changes, handleAt } = setup();
    const mouse = { pointerType: 'mouse' };
    const s = handleAt(0);
    env.down(1, s.x, s.y, mouse);
    env.move(1, s.x + 6, s.y, mouse);
    env.move(1, s.x + 46, s.y + 30, mouse);
    env.advance(600);
    env.move(1, s.x + 48, s.y + 32, mouse);
    const last = editor.getPoints()[0];
    env.advance(10);
    env.up(1, s.x + 48, s.y + 32, mouse);
    assert.deepEqual(changes.at(-1).points[0], last);
    editor.destroy();
  }
});

test('QuadEditor: nudge moves the active handle by image px and reports a final change', () => {
  const { editor, changes } = setup();
  editor.nudge(1, 0);
  assert.equal(changes.length, 0, 'no active handle: nothing happens');

  editor.setActive(1);
  assert.equal(editor.getActive(), 1);
  editor.nudge(1, -2);
  assert.deepEqual(editor.getPoints()[1], { x: 1001, y: 498 });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].meta, { final: true, index: 1 });
  assert.deepEqual(changes[0].points, editor.getPoints());

  editor.nudge(0, 0);
  editor.nudge(NaN, undefined);
  assert.equal(changes.length, 1, 'zero or nonsense steps do nothing');

  // Against the image edge the handle stops, and a nudge that cannot move reports nothing.
  editor.nudge(100000, 0);
  assert.deepEqual(editor.getPoints()[1], { x: IMG_W, y: 498 });
  assert.equal(changes.length, 2);
  editor.nudge(5, 0);
  assert.equal(changes.length, 2);

  // Safe in any order.
  editor.setPoints(null);
  assert.equal(editor.getActive(), null);
  editor.nudge(1, 1);
  assert.equal(changes.length, 2);
  editor.setActive(2);
  assert.equal(editor.getActive(), null, 'cannot activate a handle that does not exist');
  editor.setPoints(QUAD());
  for (const bad of [-1, 4, 1.5, '1', NaN, undefined]) {
    editor.setActive(bad);
    assert.equal(editor.getActive(), null);
  }
  editor.destroy();
});

test('QuadEditor: setActive does not fire callbacks', () => {
  const { editor, changes, actives } = setup();
  editor.setActive(3);
  editor.setActive(null);
  editor.setActive(0);
  assert.equal(changes.length, 0);
  assert.equal(actives.length, 0);
  editor.destroy();
});

test('QuadEditor: arrow keys nudge the active handle, Shift makes it 10 px', () => {
  const { env, editor, changes, actives } = setup();

  // With nothing active the first arrow press selects the first handle instead of moving it.
  const first = env.key('ArrowRight');
  assert.equal(first.defaultPrevented, true);
  assert.equal(editor.getActive(), 0);
  assert.deepEqual(actives, [0]);
  assert.equal(changes.length, 0);

  env.key('ArrowRight');
  env.key('ArrowDown');
  assert.deepEqual(editor.getPoints()[0], { x: 501, y: 501 });
  env.key('ArrowLeft', { shiftKey: true });
  env.key('ArrowUp', { shiftKey: true });
  assert.deepEqual(editor.getPoints()[0], { x: 491, y: 491 });
  assert.equal(changes.length, 4);
  assert.ok(changes.every((c) => c.meta.final === true && c.meta.index === 0));

  // Modified arrows belong to the browser.
  const alt = env.key('ArrowLeft', { altKey: true });
  assert.equal(alt.defaultPrevented, false);
  assert.equal(changes.length, 4);

  // Without points the keys fall through.
  editor.setPoints(null);
  assert.equal(env.key('ArrowLeft').defaultPrevented, false);
  editor.destroy();
});

test('QuadEditor: Tab and Shift+Tab step through the handles, then let focus leave', () => {
  const { env, editor, actives, changes } = setup();

  // Nothing active: Tab is not intercepted.
  assert.equal(env.key('Tab').defaultPrevented, false);

  editor.setActive(0);
  for (const expected of [1, 2, 3]) {
    const e = env.key('Tab');
    assert.equal(e.defaultPrevented, true);
    assert.equal(editor.getActive(), expected);
  }
  const leave = env.key('Tab');
  assert.equal(leave.defaultPrevented, false, 'after the last handle focus moves on');
  assert.equal(editor.getActive(), 3);

  for (const expected of [2, 1, 0]) {
    const e = env.key('Tab', { shiftKey: true });
    assert.equal(e.defaultPrevented, true);
    assert.equal(editor.getActive(), expected);
  }
  const leaveBack = env.key('Tab', { shiftKey: true });
  assert.equal(leaveBack.defaultPrevented, false, 'before the first handle focus moves back');
  assert.equal(editor.getActive(), 0);

  assert.deepEqual(actives, [1, 2, 3, 2, 1, 0]);
  assert.equal(changes.length, 0, 'moving between handles is not a change');
  editor.destroy();
});

test('QuadEditor: keyboard focus selects the first handle; mouse focus does not', () => {
  {
    const { env, editor, actives } = setup({ focusVisible: true });
    env.fire('focus');
    assert.equal(editor.getActive(), 0);
    assert.deepEqual(actives, [0]);
    env.fire('blur');
    assert.equal(editor.getActive(), 0, 'selection survives blur so Shift+Tab comes back to it');
    editor.destroy();
  }
  {
    const { env, editor, actives } = setup({ focusVisible: false });
    env.fire('focus');
    assert.equal(editor.getActive(), null);
    assert.deepEqual(actives, []);
    editor.destroy();
  }
});

test('QuadEditor: onHandleCheck fires when the customer looks at a handle and leaves it where it was', () => {
  // A press let go of inside the dead zone: on the release, not the press, and with no onChange.
  {
    const { env, editor, changes, checks, handleAt } = setup();
    const s = handleAt(2);
    env.down(1, s.x, s.y);
    assert.deepEqual(checks, [], 'not on pointerdown');
    env.move(1, s.x + 2, s.y + 1);
    env.advance(80);
    env.up(1, s.x + 2, s.y + 1);
    assert.deepEqual(checks, [2]);
    assert.equal(changes.length, 0, 'onChange is not told: final: true still means the handle moved');
    assert.deepEqual(editor.getPoints(), QUAD());
    editor.destroy();
  }
  // A tap that wobbled out of the dead zone but never moved the handle is a check too; a drag is not.
  {
    const { env, editor, changes, checks, handleAt } = setup();
    const s = handleAt(1);
    env.down(1, s.x, s.y);
    env.advance(30);
    env.move(1, s.x + 6, s.y);
    env.advance(30);
    env.up(1, s.x + 6, s.y);
    assert.deepEqual(checks, [1], 'wobble');
    assert.equal(changes.length, 0);

    const t = handleAt(0);
    env.down(1, t.x, t.y);
    env.move(1, t.x + 6, t.y);
    env.move(1, t.x + 40, t.y + 20);
    env.advance(400);
    env.up(1, t.x + 40, t.y + 20);
    assert.equal(changes.at(-1).meta.final, true);
    assert.deepEqual(checks, [1], 'a drag that moved the handle is not a check');
    editor.destroy();
  }
  // Not for a cancelled press, nor for a pinch whose first finger landed on a handle.
  {
    const { env, editor, checks, handleAt } = setup();
    const s = handleAt(3);
    env.down(1, s.x, s.y);
    env.cancel(1);
    assert.deepEqual(checks, [], 'cancelled');

    env.down(1, s.x, s.y);
    env.advance(40);
    env.down(2, s.x - 120, s.y - 180);
    env.move(2, s.x - 160, s.y - 220);
    env.up(1, s.x, s.y);
    env.up(2, s.x - 160, s.y - 220);
    assert.deepEqual(checks, [], 'pinch');
    assert.equal(editor.getActive(), 3);
    editor.destroy();
  }
  // Keyboard: Enter or Space on the active handle is the keyboard's press, so a check. Only selecting a handle
  // is not: the handle selected as the canvas gets keyboard focus, the arrow that selects the first handle,
  // Tab / Shift+Tab onto one (a keyboard customer Tabs through all four to reach the buttons after the
  // photo), setActive(); nor a nudge, which reports through onChange.
  {
    const { env, editor, checks, changes } = setup({ focusVisible: true });
    env.fire('focus');
    assert.equal(editor.getActive(), 0);
    assert.deepEqual(checks, [], 'keyboard focus');
    // Tabbing past the photo: through handles 1, 2 and 3, then out.
    for (const expected of [1, 2, 3]) {
      env.key('Tab');
      assert.equal(editor.getActive(), expected);
    }
    assert.equal(env.key('Tab').defaultPrevented, false, 'focus leaves after the last handle');
    env.key('Tab', { shiftKey: true });
    assert.deepEqual(checks, [], 'Tab and Shift+Tab only select');
    editor.setActive(null);
    editor.setActive(2);
    assert.deepEqual(checks, [], 'setActive');
    editor.setActive(null);
    env.key('ArrowRight');
    assert.equal(editor.getActive(), 0);
    assert.deepEqual(checks, [], 'the arrow that selects the first handle');
    env.key('ArrowRight');
    assert.deepEqual(checks, [], 'a nudge reports through onChange');
    assert.equal(changes.length, 1);

    // Confirming the selected handle where it is.
    const enter = env.key('Enter');
    assert.equal(enter.defaultPrevented, true);
    assert.deepEqual(checks, [0], 'Enter');
    env.key('Tab');
    const space = env.key(' ');
    assert.equal(space.defaultPrevented, true, 'Space does not scroll the page');
    assert.deepEqual(checks, [0, 1], 'Space');
    env.key(' ', { repeat: true });
    env.key('Enter', { repeat: true });
    assert.deepEqual(checks, [0, 1], 'a held key is one press');
    assert.equal(env.key('Enter', { ctrlKey: true }).defaultPrevented, false, 'modified keys belong to the browser');
    assert.deepEqual(checks, [0, 1]);
    assert.equal(changes.length, 1, 'a check moves nothing');

    // Nothing selected: nothing to confirm, and the key is left alone.
    editor.setActive(null);
    assert.equal(env.key('Enter').defaultPrevented, false);
    assert.equal(env.key(' ').defaultPrevented, false);
    assert.deepEqual(checks, [0, 1]);
    editor.destroy();
    // After destroy, nothing is reported.
    env.key('Enter');
    assert.deepEqual(checks, [0, 1]);
  }
});

test('QuadEditor: + / - / 0 keys zoom about the active handle and reset', () => {
  const { env, editor, handleAt } = setup();
  const fit = editor.getView();
  editor.setActive(2);
  const before = handleAt(2);
  assert.equal(env.key('+').defaultPrevented, true);
  near(editor.getView().scale, fit.scale * 1.5, 1e-9);
  nearPoint(handleAt(2), before, 1e-6, 'active handle stays put while zooming');
  env.key('=');
  near(editor.getView().scale, fit.scale * 2.25, 1e-9);
  env.key('-');
  near(editor.getView().scale, fit.scale * 1.5, 1e-9);
  assert.equal(env.key('0').defaultPrevented, true);
  assert.deepEqual(editor.getView(), fit);
  editor.destroy();
});

test('QuadEditor: nudging a handle that is off-screen pans it back into view', () => {
  const { env, editor, handleAt } = setup();
  // Zoom deep into the bottom-right of the photo so handle 0 is far off-screen.
  for (let i = 0; i < 8; i++) env.fire('wheel', { x: 350, y: 510, deltaY: -600 });
  const s = handleAt(0);
  assert.ok(s.x < 0 || s.y < 0, 'handle 0 starts off-screen');
  editor.setActive(0);
  editor.nudge(1, 0);
  const after = handleAt(0);
  assert.ok(after.x >= 40 && after.x <= 320 && after.y >= 40 && after.y <= 480, `handle visible at ${after.x},${after.y}`);
  editor.destroy();
});

test('QuadEditor: zoomToQuad frames the quad (jumping when reduced motion is preferred)', () => {
  const { env, editor } = setup({ reducedMotion: true });
  const sheet = [{ x: 600, y: 900 }, { x: 800, y: 900 }, { x: 800, y: 1180 }, { x: 600, y: 1180 }];
  editor.zoomToQuad(sheet);
  const v = editor.getView();
  assert.ok(v.scale > fitView(IMG_W, IMG_H, 360, 520).scale * 2);
  for (const p of sheet) {
    const s = imageToScreen(v, p);
    assert.ok(s.x > 30 && s.x < 330 && s.y > 30 && s.y < 490, 'corner framed with room around it');
  }
  nearPoint(imageToScreen(v, { x: 700, y: 1040 }), { x: 180, y: 260 }, 1e-9);

  // Tighter padding zooms further.
  editor.zoomToQuad(sheet, 0.05);
  assert.ok(editor.getView().scale > v.scale);

  // Invalid quads are ignored.
  const kept = editor.getView();
  editor.zoomToQuad(null);
  editor.zoomToQuad([{ x: 1, y: 2 }]);
  assert.deepEqual(editor.getView(), kept);

  editor.resetView();
  assert.deepEqual(editor.getView(), fitView(IMG_W, IMG_H, 360, 520));
  assert.equal(env.frames.size <= 1, true, 'no animation loop left running');
  editor.destroy();
});

test('QuadEditor: zoomToQuad animates when motion is allowed and a touch interrupts it', () => {
  const { env, editor } = setup({ reducedMotion: false });
  const fit = editor.getView();
  const sheet = [{ x: 600, y: 900 }, { x: 800, y: 900 }, { x: 800, y: 1180 }, { x: 600, y: 1180 }];
  const target = viewForQuad(sheet, 0.35, IMG_W, IMG_H, 360, 520, { overscrollPx: 108 });

  editor.zoomToQuad(sheet);
  assert.deepEqual(editor.getView(), fit, 'nothing moves until the first frame');
  env.advance(80);
  env.flushFrames();
  const mid = editor.getView();
  assert.ok(mid.scale > fit.scale && mid.scale < target.scale, 'part of the way there');
  env.advance(400);
  env.flushFrames();
  const end = editor.getView();
  near(end.scale, target.scale, 1e-12);
  near(end.tx, target.tx, 1e-9);
  near(end.ty, target.ty, 1e-9);
  env.flushFrames();
  assert.equal(env.frames.size, 0, 'animation finished');

  // Start another and interrupt it with a finger: the view freezes where it was.
  editor.resetView();
  env.advance(60);
  env.flushFrames();
  const frozen = editor.getView();
  env.down(1, 180, 260);
  env.advance(500);
  env.flushFrames();
  assert.deepEqual(editor.getView(), frozen);
  env.up(1, 180, 260);
  editor.destroy();
});

test('QuadEditor: works when built before the container has a size', () => {
  const env = makeEnv({ width: 0, height: 0 });
  const editor = new QuadEditor(env.container, { image: env.image, imageWidth: IMG_W, imageHeight: IMG_H, points: QUAD() });
  const sheet = [{ x: 600, y: 900 }, { x: 800, y: 900 }, { x: 800, y: 1180 }, { x: 600, y: 1180 }];

  // None of this may throw without a layout.
  editor.zoomToQuad(sheet);
  editor.setActive(1);
  editor.nudge(3, 3);
  editor.resetView();
  editor.zoomToQuad(sheet);
  env.down(1, 10, 10);
  env.up(1, 10, 10);
  env.fire('wheel', { x: 5, y: 5, deltaY: -100 });
  env.flushFrames();
  assert.equal(env.drawLog.filter((c) => c.op === 'drawImage').length, 0, 'nothing drawn into a zero-size canvas');
  assert.deepEqual(editor.getPoints()[1], { x: 1003, y: 503 });

  // Layout arrives: the pending zoom is applied straight away and the canvas is painted.
  env.container.clientWidth = 360;
  env.container.clientHeight = 520;
  env.observers[0].cb();
  const v = editor.getView();
  nearPoint(imageToScreen(v, { x: 700, y: 1040 }), { x: 180, y: 260 }, 1e-9);
  assert.equal(env.canvas.width, 720);
  assert.ok(env.drawLog.some((c) => c.op === 'drawImage'), 'painted in the resize itself');
  editor.destroy();
});

test('QuadEditor: resize refits the fit view and keeps the centre of a zoomed view', () => {
  const { env, editor } = setup();
  // At fit: a new size gives the new fit view.
  env.container.clientWidth = 600;
  env.container.clientHeight = 400;
  editor.resize();
  assert.deepEqual(editor.getView(), fitView(IMG_W, IMG_H, 600, 400));
  assert.equal(env.canvas.width, 1200);
  assert.equal(env.canvas.height, 800);

  // Zoomed: same zoom, same image point in the middle.
  for (let i = 0; i < 5; i++) env.fire('wheel', { x: 200, y: 300, deltaY: -400 });
  const before = editor.getView();
  const centre = screenToImage(before, { x: 300, y: 200 });
  env.container.clientWidth = 360;
  env.container.clientHeight = 520;
  env.observers[0].cb();
  const after = editor.getView();
  near(after.scale, before.scale, 1e-12);
  nearPoint(screenToImage(after, { x: 180, y: 260 }), centre, 1e-6);

  // A window resize with nothing changed is harmless.
  const logLength = env.drawLog.length;
  env.winListeners.dispatch('resize', {});
  assert.deepEqual(editor.getView(), after);
  env.flushFrames();
  assert.ok(env.drawLog.length >= logLength);
  editor.destroy();
});

test('QuadEditor: redraws are coalesced into one animation frame', () => {
  const { env, editor, handleAt } = setup();
  env.flushFrames();
  const s = handleAt(0);
  env.down(1, s.x, s.y);
  env.move(1, s.x + 6, s.y);
  for (let i = 0; i < 25; i++) env.move(1, s.x + 10 + i, s.y + i);
  assert.equal(env.frames.size, 1, 'many pointer moves, one pending frame');
  const clearsBefore = env.drawLog.filter((c) => c.op === 'clearRect').length;
  env.flushFrames();
  assert.equal(env.drawLog.filter((c) => c.op === 'clearRect').length, clearsBefore + 1, 'one paint');
  env.up(1, s.x + 34, s.y + 24);
  editor.destroy();
});

test('QuadEditor: draws image, ghost, quad, handles, labels and focus ring without error', () => {
  const { env, editor } = setup(
    { focusVisible: true },
    {
      labels: ['Top left', 'Top right', 'Bottom right', 'Bottom left'],
      ghost: { points: [{ x: 600, y: 900 }, { x: 800, y: 900 }, { x: 800, y: 1180 }, { x: 600, y: 1180 }], color: '#ffffff' },
    },
  );
  env.flushFrames();
  const ops = (from = 0) => env.drawLog.slice(from).map((c) => c.op);

  // Resting state: whole photo, dashed ghost, labels.
  const first = env.drawLog;
  const image = first.find((c) => c.op === 'drawImage');
  assert.equal(image.args[0], env.image);
  assert.deepEqual(image.args.slice(1, 5), [0, 0, IMG_W, IMG_H], 'whole photo is the source');
  near(image.args[5], 0, 1e-9);
  near(image.args[6], 20, 1e-9);
  near(image.args[7], 360, 1e-9);
  near(image.args[8], 480, 1e-9);
  assert.equal(image.state.imageSmoothingEnabled, true, 'smoothed while shrunk');
  assert.ok(first.some((c) => c.op === 'setLineDash' && c.args[0].length === 2), 'ghost outline is dashed');
  assert.deepEqual(first.filter((c) => c.op === 'fillText').map((c) => c.args[0]), ['Top left', 'Top right', 'Bottom right', 'Bottom left']);
  const transform = first.find((c) => c.op === 'setTransform');
  assert.deepEqual(transform.args, [2, 0, 0, 2, 0, 0], 'drawing is in CSS px on a 2x backing store');
  assert.ok(!ops().includes('strokeRect'), 'no focus ring without keyboard focus');

  // Each frame clears, then paints the photo before any overlay.
  const lastClear = ops().lastIndexOf('clearRect');
  assert.equal(ops()[lastClear + 1], 'drawImage');

  // Quad edges stop short of the handle rings, so the corner pixels stay visible: no edge
  // segment starts or ends within a ring radius of a handle.
  const view = editor.getView();
  const handles = QUAD().map((p) => imageToScreen(view, p));
  const lineEnds = first.filter((c) => c.op === 'moveTo' || c.op === 'lineTo').map((c) => ({ x: c.args[0], y: c.args[1] }));
  const edgeEnds = lineEnds.filter((e) => handles.some((h) => Math.hypot(e.x - h.x, e.y - h.y) < 30));
  assert.ok(edgeEnds.length >= 8, 'edge end points found near the handles');
  // The interior tint path does pass through the corners (4 points); every other end keeps clear.
  const onCorner = edgeEnds.filter((e) => handles.some((h) => Math.hypot(e.x - h.x, e.y - h.y) < 1e-6));
  assert.equal(onCorner.length, 4, 'only the tint polygon touches the corners');
  for (const e of edgeEnds.filter((end) => !onCorner.includes(end))) {
    const nearest = Math.min(...handles.map((h) => Math.hypot(e.x - h.x, e.y - h.y)));
    assert.ok(nearest >= 11 - 1e-6, `edge end ${nearest} px from a handle centre`);
  }
  // The tint is faint.
  const tintFill = first.find((c) => c.op === 'fill');
  assert.ok(tintFill.state.globalAlpha <= 0.15, 'very light interior tint');

  // Keyboard focus paints a two-tone ring just inside the canvas edge.
  let mark = env.drawLog.length;
  env.fire('focus');
  env.flushFrames();
  const ring = env.drawLog.slice(mark).filter((c) => c.op === 'strokeRect');
  assert.equal(ring.length, 2, 'two-tone focus ring');
  assert.deepEqual(ring[0].args, [2.5, 2.5, 355, 515]);
  assert.notEqual(ring[0].state.strokeStyle, ring[1].state.strokeStyle);
  mark = env.drawLog.length;
  env.fire('blur');
  env.flushFrames();
  assert.ok(!ops(mark).includes('strokeRect'), 'ring goes with the focus');

  // A different colour repaints without error (dark colour: light casing).
  mark = env.drawLog.length;
  editor.setColor('#0b1f3a');
  env.flushFrames();
  const styles = new Set(env.drawLog.slice(mark).filter((c) => c.op === 'stroke').map((c) => c.state.strokeStyle));
  assert.ok(styles.has('#0b1f3a'));
  assert.ok(styles.has(casingFor(parseCssColor('#0b1f3a'))));

  // Zoomed in: only the visible part of the photo is drawn, with smoothing off at high zoom.
  for (let i = 0; i < 8; i++) env.fire('wheel', { x: 180, y: 260, deltaY: -600 });
  mark = env.drawLog.length;
  env.flushFrames();
  const zoomedImage = env.drawLog.slice(mark).find((c) => c.op === 'drawImage');
  assert.ok(zoomedImage.args[3] < 200 && zoomedImage.args[4] < 200, 'small source rectangle');
  assert.equal(zoomedImage.state.imageSmoothingEnabled, false);

  // No points at all still paints the photo.
  editor.setPoints(null);
  editor.setGhost(null);
  mark = env.drawLog.length;
  env.flushFrames();
  assert.ok(ops(mark).includes('drawImage'));
  assert.ok(!ops(mark).includes('fillText'));
  assert.equal(env.loupeLog.length, 0, 'the loupe layer was never touched');
  editor.destroy();
});

test('QuadEditor: the loupe appears on its own layer while dragging, opposite the finger', () => {
  const { env, editor, handleAt } = setup({}, { labels: ['Top left', 'Top right', 'Bottom right', 'Bottom left'] });
  env.flushFrames();
  const loupe = env.loupe;
  const layer = LOUPE_DIAMETER_PX + 2 * LOUPE_MARGIN_PX;
  const centre = layer / 2;
  assert.equal(loupe.style.display, 'none', 'hidden at rest');
  assert.equal(env.loupeLog.length, 0);

  // Grab the top-left handle (finger on the left): loupe in the top-right corner.
  const s = handleAt(0);
  env.down(1, s.x, s.y);
  env.flushFrames();
  assert.equal(loupe.style.display, 'block', 'shown as soon as the handle is grabbed');
  assert.equal(loupe.style.left, `${360 - layer}px`);
  assert.equal(loupe.style.top, '0px');
  assert.equal(loupe.style.width, `${layer}px`);
  assert.equal(loupe.style.height, `${layer}px`);
  assert.equal(loupe.width, layer * 2, 'device-pixel sharp');
  assert.equal(loupe.height, layer * 2);

  let mark = env.loupeLog.length;
  let mainMark = env.drawLog.length;
  env.move(1, s.x + 6, s.y);
  env.move(1, s.x + 16, s.y + 10);
  env.flushFrames();
  const frame = env.loupeLog.slice(mark);
  assert.deepEqual(frame[0].op, 'setTransform');
  assert.deepEqual(frame[0].args, [2, 0, 0, 2, 0, 0]);
  assert.equal(frame[1].op, 'clearRect');
  assert.deepEqual(frame[1].args, [0, 0, layer, layer]);

  // Circular: everything inside is clipped to a circle of the loupe radius.
  const clipIndex = frame.findIndex((c) => c.op === 'clip');
  const clipArc = frame.slice(0, clipIndex).findLast((c) => c.op === 'arc');
  assert.deepEqual(clipArc.args.slice(0, 3), [centre, centre, LOUPE_DIAMETER_PX / 2]);

  // The photo, magnified with hard pixels, with the handle's own position dead centre.
  const magnified = frame.find((c) => c.op === 'drawImage');
  assert.equal(magnified.args[0], env.image);
  assert.equal(magnified.state.imageSmoothingEnabled, false, 'no smoothing in the loupe');
  const [, sx, sy, sw, sh, dx, dy, dw, dh] = magnified.args;
  near(dw / sw, LOUPE_MIN_SCALE, 1e-9, 'about 4 screen px per image px at the fit view');
  near(dh / sh, LOUPE_MIN_SCALE, 1e-9);
  const p = editor.getPoints()[0];
  near(dx + (p.x - sx) * LOUPE_MIN_SCALE, centre, 1e-6);
  near(dy + (p.y - sy) * LOUPE_MIN_SCALE, centre, 1e-6);
  assert.ok(Number.isInteger(sx) && Number.isInteger(sy) && Number.isInteger(sw) && Number.isInteger(sh), 'pixel-aligned source');
  // The source covers the whole loupe circle.
  assert.ok(dx <= centre - 60 && dy <= centre - 60 && dx + dw >= centre + 60 && dy + dh >= centre + 60);

  // Crosshair: two strokes (dark under light) over arms that leave the centre open.
  const afterImage = frame.slice(frame.indexOf(magnified));
  const armEnds = afterImage.filter((c) => c.op === 'moveTo' || c.op === 'lineTo').map((c) => Math.hypot(c.args[0] - centre, c.args[1] - centre));
  assert.equal(armEnds.length, 8, 'four arms');
  assert.ok(Math.min(...armEnds) >= 4, 'centre left open');
  assert.ok(Math.max(...armEnds) <= LOUPE_DIAMETER_PX / 2, 'arms stay inside the loupe');
  const crossStrokes = afterImage.filter((c) => c.op === 'stroke').slice(0, 2);
  assert.ok(crossStrokes[0].state.lineWidth > crossStrokes[1].state.lineWidth, 'casing under core');
  assert.notEqual(crossStrokes[0].state.strokeStyle, crossStrokes[1].state.strokeStyle, 'two-tone');

  // On the main canvas the label of the handle under the finger is hidden meanwhile.
  assert.deepEqual(
    env.drawLog.slice(mainMark).filter((c) => c.op === 'fillText').map((c) => c.args[0]),
    ['Top right', 'Bottom right', 'Bottom left'],
  );

  // Drag across to the right half: the loupe swaps to the top-left corner.
  env.move(1, 300, 300);
  env.flushFrames();
  assert.equal(loupe.style.left, '0px');
  assert.equal(loupe.style.top, '0px');
  assert.equal(loupe.style.display, 'block');

  // Release: hidden again.
  env.advance(300);
  env.up(1, 300, 300);
  env.flushFrames();
  assert.equal(loupe.style.display, 'none');

  // A nudge (keyboard or on-screen arrows) shows the loupe for a moment, away from the handle.
  mark = env.loupeLog.length;
  editor.setActive(2); // bottom-right handle: loupe goes top-left
  editor.nudge(1, 0);
  env.flushFrames();
  assert.equal(loupe.style.display, 'block');
  assert.equal(loupe.style.left, '0px');
  assert.ok(env.loupeLog.length > mark);
  env.advance(600);
  editor.nudge(1, 0);
  env.advance(1000);
  env.flushFrames();
  assert.equal(loupe.style.display, 'block', 'each nudge restarts the timer');
  env.advance(1000);
  env.flushFrames();
  assert.equal(loupe.style.display, 'none', 'and it goes away by itself');

  // Deep zoom: the loupe magnifies at least three times beyond the view.
  for (let i = 0; i < 12; i++) env.fire('wheel', { x: 180, y: 260, deltaY: -600 });
  assert.equal(editor.getView().scale, MAX_SCALE);
  editor.nudge(0, 1);
  env.flushFrames();
  const deep = env.loupeLog.findLast((c) => c.op === 'drawImage');
  near(deep.args[7] / deep.args[3], 3 * MAX_SCALE, 1e-9);

  // Clearing the points hides it at once.
  editor.setPoints(null);
  env.flushFrames();
  assert.equal(loupe.style.display, 'none');
  editor.destroy();
});

test('QuadEditor: the loupe shows a dark backdrop, not garbage, past the edge of the photo', () => {
  const { env, editor } = setup();
  editor.setPoints([{ x: 0, y: 0 }, { x: 1000, y: 500 }, { x: 1000, y: 1500 }, { x: 500, y: 1500 }]);
  editor.setActive(0);
  editor.nudge(3, 2);
  env.flushFrames();
  const layer = LOUPE_DIAMETER_PX + 2 * LOUPE_MARGIN_PX;
  const img = env.loupeLog.find((c) => c.op === 'drawImage');
  const [, sx, sy, sw, sh, dx, dy] = img.args;
  assert.ok(sx >= 0 && sy >= 0 && sw > 0 && sh > 0, 'source rectangle clipped to the photo');
  assert.equal(sx, 0);
  assert.equal(sy, 0);
  // Photo pixel (0, 0) sits just up and left of centre: the rest of that quadrant is backdrop.
  near(dx, layer / 2 - 3 * LOUPE_MIN_SCALE, 1e-9);
  near(dy, layer / 2 - 2 * LOUPE_MIN_SCALE, 1e-9);
  const backdrop = env.loupeLog.find((c) => c.op === 'fill');
  assert.ok(relativeLuminance(parseCssColor(backdrop.state.fillStyle)) < 0.05, 'dark backdrop behind the photo');
  editor.destroy();
});

test('QuadEditor: an image source of a different pixel size is scaled to the declared size', () => {
  const env = makeEnv();
  const half = { width: IMG_W / 2, height: IMG_H / 2 };
  const editor = new QuadEditor(env.container, { image: half, imageWidth: IMG_W, imageHeight: IMG_H, points: QUAD() });
  env.flushFrames();
  const image = env.drawLog.find((c) => c.op === 'drawImage');
  assert.deepEqual(image.args.slice(1, 5), [0, 0, IMG_W / 2, IMG_H / 2]);
  near(image.args[7], 360, 1e-9);
  near(image.args[8], 480, 1e-9);
  editor.destroy();
});

test('QuadEditor: setPoints during a drag does not make the handle jump', () => {
  const { env, editor, handleAt } = setup();
  const s = handleAt(0);
  env.down(1, s.x, s.y);
  env.move(1, s.x + 6, s.y);
  env.move(1, s.x + 26, s.y + 20);
  // The app snaps the corner somewhere else mid-drag.
  const snapped = QUAD();
  snapped[0] = { x: 640, y: 610 };
  editor.setPoints(snapped);
  const before = handleAt(0);
  env.move(1, s.x + 31, s.y + 20);
  nearPoint(handleAt(0), { x: before.x + 5, y: before.y }, 1e-9, 'continues from the snapped position');

  // Clearing the points mid-drag abandons the drag without a final change.
  editor.setPoints(null);
  env.move(1, s.x + 60, s.y + 60);
  env.up(1, s.x + 60, s.y + 60);
  assert.equal(editor.getPoints(), null);
  editor.destroy();
});

test('QuadEditor: destroy releases everything and later calls are harmless', () => {
  const { env, editor, changes, taps, handleAt } = setup({ reducedMotion: false });
  assert.ok(env.canvasListeners.count() >= 9);
  assert.equal(env.winListeners.count('resize'), 1);

  // Leave as much as possible in flight: a drag, a pending frame, a loupe timer, an animation.
  editor.setActive(0);
  editor.nudge(1, 1);
  editor.zoomToQuad(QUAD());
  const s = handleAt(1);
  env.down(1, s.x, s.y);
  env.move(1, s.x + 6, s.y);
  env.move(1, s.x + 30, s.y);
  assert.ok(env.frames.size > 0);
  assert.ok(env.timers.size > 0);
  assert.ok(env.captured.has(1));
  const changeCount = changes.length;

  editor.destroy();
  assert.equal(env.canvasListeners.count(), 0, 'canvas listeners removed');
  assert.equal(env.winListeners.count(), 0, 'window listeners removed');
  assert.equal(env.observers[0].disconnected, true, 'ResizeObserver disconnected');
  assert.equal(env.frames.size, 0, 'animation frames cancelled');
  assert.equal(env.timers.size, 0, 'timers cleared');
  assert.equal(env.captured.size, 0, 'pointer capture released');
  assert.equal(env.container.children.length, 0, 'both canvases removed');
  assert.equal(env.canvas.parentNode, null);
  assert.equal(env.loupe.parentNode, null);
  assert.equal(env.container.style.position, '', 'container position restored');

  // Everything is a no-op afterwards.
  const drawn = env.drawLog.length;
  editor.destroy();
  editor.setPoints(QUAD());
  editor.setGhost({ points: QUAD(), color: '#fff' });
  editor.setColor('#123456');
  editor.setActive(1);
  editor.nudge(5, 5);
  editor.zoomToQuad(QUAD());
  editor.resetView();
  editor.resize();
  assert.equal(editor.getPoints(), null);
  assert.equal(editor.getActive(), null);
  assert.equal(typeof editor.getView().scale, 'number');
  env.flushFrames();
  env.advance(5000);
  assert.equal(env.drawLog.length, drawn, 'nothing drawn after destroy');
  assert.equal(env.frames.size, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(changes.length, changeCount);
  assert.equal(taps.length, 0);
});

test('QuadEditor: callbacks are optional', () => {
  const env = makeEnv();
  const editor = new QuadEditor(env.container, { image: env.image, imageWidth: IMG_W, imageHeight: IMG_H, points: QUAD() });
  const s = imageToScreen(editor.getView(), editor.getPoints()[0]);
  env.down(1, s.x, s.y);
  env.move(1, s.x + 6, s.y);
  env.move(1, s.x + 30, s.y + 30);
  env.up(1, s.x + 30, s.y + 30);
  env.down(1, 200, 300);
  env.up(1, 200, 300);
  editor.setActive(0);
  editor.nudge(1, 1);
  env.key('Tab');
  env.flushFrames();
  assert.notDeepEqual(editor.getPoints(), QUAD());
  editor.destroy();
});

test('QuadEditor: no points and no image still behaves', () => {
  const env = makeEnv();
  const taps = [];
  const editor = new QuadEditor(env.container, { imageWidth: IMG_W, imageHeight: IMG_H, points: null, onTap: (p) => taps.push(p) });
  env.flushFrames();
  assert.equal(editor.getPoints(), null);
  env.down(1, 100, 200);
  env.up(1, 100, 200);
  assert.equal(taps.length, 1, 'taps work before any quad exists (tap the sheet to detect it)');
  editor.setPoints(QUAD());
  editor.setActive(3);
  editor.nudge(-1, -1);
  assert.deepEqual(editor.getPoints()[3], { x: 499, y: 1499 });
  env.flushFrames();
  assert.ok(!env.drawLog.some((c) => c.op === 'drawImage'), 'no image to draw');
  editor.destroy();
});

test('QuadEditor: random gesture storms never throw or break the invariants', () => {
  // Small deterministic generator so a failure can be reproduced from its seed.
  const makeRandom = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  const totals = { live: 0, final: 0, taps: 0, zoomed: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const random = makeRandom(seed * 7919);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const pixelOrigin = seed % 4 === 0 ? 'center' : 'corner';
    const { env, editor, changes, taps } = setup(
      { reducedMotion: seed % 3 !== 0, width: pick([320, 360, 414, 800]), height: pick([240, 420, 520, 700]) },
      { pixelOrigin, labels: seed % 2 ? ['A', 'B', 'C', 'D'] : undefined },
    );
    const vw = env.container.clientWidth;
    const vh = env.container.clientHeight;
    const maxX = pixelOrigin === 'center' ? IMG_W - 1 : IMG_W;
    const maxY = pixelOrigin === 'center' ? IMG_H - 1 : IMG_H;
    const offset = pixelOrigin === 'center' ? 0.5 : 0;
    const where = () => {
      // Half the time aim at a handle, otherwise anywhere (including outside the canvas).
      const pts = editor.getPoints();
      if (pts && random() < 0.5) {
        const s = imageToScreen(shiftView(editor.getView(), offset), pick(pts));
        return { x: s.x + (random() - 0.5) * 40, y: s.y + (random() - 0.5) * 40 };
      }
      return { x: random() * (vw + 80) - 40, y: random() * (vh + 80) - 40 };
    };
    let epoch = 0;
    // What the host knows for good: the points it gave the editor, then every final change.
    let committed = editor.getPoints();
    let audited = 0;
    const byNudge = new Set();
    const backInPlace = new Set();
    const nudging = (act) => {
      const from = changes.length;
      act();
      for (let i = from; i < changes.length; i++) byNudge.add(i);
    };
    const audit = () => {
      for (; audited < changes.length; audited++) {
        const { points, meta } = changes[audited];
        const p = points[meta.index];
        const unmoved = committed !== null && p.x === committed[meta.index].x && p.y === committed[meta.index].y;
        if (meta.final) {
          // The end of a drag is only final when it moved the handle. (A nudge always moves it,
          // but during a drag it may happen to land on the spot the host already had.)
          assert.ok(!unmoved || byNudge.has(audited), `seed ${seed}: final change ${audited} left handle ${meta.index} where it was`);
          committed = points;
        } else if (unmoved) {
          backInPlace.add(audited);
        }
      }
    };
    const actions = [
      () => { const p = where(); env.down(pick([1, 2, 3]), p.x, p.y, { pointerType: pick(['touch', 'touch', 'mouse', 'pen']) }); },
      () => { const p = where(); env.move(pick([1, 2, 3]), p.x, p.y); },
      () => { const p = where(); env.move(pick([1, 2, 3]), p.x, p.y); },
      () => { const p = where(); env.move(pick([1, 2, 3]), p.x, p.y); },
      () => { const p = where(); env.up(pick([1, 2, 3]), p.x, p.y); },
      () => env.cancel(pick([1, 2, 3])),
      () => env.fire('lostpointercapture', { pointerId: pick([1, 2, 3]) }),
      () => {
        // A clean tap.
        const p = where();
        const id = pick([1, 2, 3]);
        env.down(id, p.x, p.y);
        env.up(id, p.x + 1, p.y - 1);
      },
      () => {
        // A clean little drag.
        const p = where();
        const id = pick([1, 2, 3]);
        env.down(id, p.x, p.y);
        for (let i = 1; i <= 4; i++) env.move(id, p.x + i * 7, p.y + i * 5);
        if (random() < 0.7) env.up(id, p.x + 28, p.y + 20);
      },
      () => { const p = where(); env.fire('wheel', { x: p.x, y: p.y, deltaY: (random() - 0.5) * 1500, deltaMode: pick([0, 0, 1]), ctrlKey: random() < 0.2 }); },
      () => nudging(() => env.key(pick(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', '+', '-', '0', 'a']), { shiftKey: random() < 0.3 })),
      () => nudging(() => editor.nudge(Math.round((random() - 0.5) * 60), Math.round((random() - 0.5) * 60))),
      () => editor.setActive(pick([null, 0, 1, 2, 3, 7])),
      () => {
        // Replacing or clearing the points is the host's doing: any drag in progress is the host's to
        // reconcile, so start a fresh epoch for the "every drag ends with a final change" check.
        editor.setPoints(pick([null, QUAD(), [{ x: -50, y: 10 }, { x: 99999, y: 10 }, { x: 700, y: 99999 }, { x: 5, y: 900 }]]));
        committed = editor.getPoints();
        if (committed === null) epoch = changes.length;
      },
      () => editor.zoomToQuad(pick([QUAD(), [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 80 }, { x: 10, y: 80 }]]), random()),
      () => editor.resetView(),
      () => editor.setGhost(pick([null, { points: QUAD(), color: 'var(--sm-accent)' }])),
      () => editor.setColor(pick(['#ff7a00', 'rgb(10, 20, 30)', 'navy', 'var(--sm-accent)', ''])),
      () => { env.container.clientWidth = pick([0, 320, vw]); env.container.clientHeight = pick([0, 300, vh]); editor.resize(); env.container.clientWidth = vw; env.container.clientHeight = vh; editor.resize(); },
      () => env.fire(pick(['focus', 'blur'])),
      () => env.flushFrames(),
      () => env.advance(random() * 400),
    ];

    for (let step = 0; step < 400; step++) {
      pick(actions)();
      audit();

      const pts = editor.getPoints();
      if (pts) {
        assert.equal(pts.length, 4);
        for (const p of pts) {
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `seed ${seed} step ${step}: finite point`);
          assert.ok(p.x >= 0 && p.x <= maxX && p.y >= 0 && p.y <= maxY, `seed ${seed} step ${step}: point ${p.x},${p.y} on the image`);
        }
      }
      const active = editor.getActive();
      assert.ok(active === null || (pts && Number.isInteger(active) && active >= 0 && active < 4), `seed ${seed} step ${step}: active ${active}`);

      const view = editor.getView();
      assert.ok(Number.isFinite(view.scale) && Number.isFinite(view.tx) && Number.isFinite(view.ty), `seed ${seed} step ${step}: finite view`);
      const limits = scaleLimits(IMG_W, IMG_H, vw, vh);
      assert.ok(view.scale >= limits.minScale - 1e-9 && view.scale <= limits.maxScale + 1e-9, `seed ${seed} step ${step}: scale ${view.scale} in range`);
      // The photo always covers the middle of the canvas: it can never be lost off-screen.
      const tl = imageToScreen(view, { x: 0, y: 0 });
      const br = imageToScreen(view, { x: IMG_W, y: IMG_H });
      const slack = Math.min(vw, vh) * 0.3 + 1e-6;
      assert.ok(tl.x <= Math.max(slack, (vw - (br.x - tl.x)) / 2 + 1e-6), `seed ${seed} step ${step}: left edge ${tl.x}`);
      assert.ok(tl.y <= Math.max(slack, (vh - (br.y - tl.y)) / 2 + 1e-6), `seed ${seed} step ${step}: top edge ${tl.y}`);
      assert.ok(br.x >= Math.min(vw - slack, (vw + (br.x - tl.x)) / 2 - 1e-6), `seed ${seed} step ${step}: right edge ${br.x}`);
      assert.ok(br.y >= Math.min(vh - slack, (vh + (br.y - tl.y)) / 2 - 1e-6), `seed ${seed} step ${step}: bottom edge ${br.y}`);
    }

    // Every change reported carried four on-image points and a valid index.
    for (const change of changes) {
      assert.equal(change.points.length, 4);
      assert.equal(typeof change.meta.final, 'boolean');
      assert.ok(Number.isInteger(change.meta.index) && change.meta.index >= 0 && change.meta.index < 4);
    }
    // A drag never leaves its listeners hanging: once every pointer has been lifted, the last
    // report for any handle is final, or it shows the handle back where the host already had it
    // (a drag that came to nothing, or the first finger of a pinch).
    for (const id of [1, 2, 3]) env.cancel(id);
    audit();
    const lastByIndex = new Map();
    changes.forEach((change, i) => {
      if (i >= epoch) lastByIndex.set(change.meta.index, change.meta.final || backInPlace.has(i));
    });
    for (const [index, settled] of lastByIndex) {
      assert.equal(settled, true, `seed ${seed}: last change for handle ${index} is final or shows it back in place`);
    }

    totals.live += changes.filter((c) => !c.meta.final).length;
    totals.final += changes.filter((c) => c.meta.final).length;
    totals.taps += taps.length;
    if (editor.getView().scale > scaleLimits(IMG_W, IMG_H, vw, vh).minScale * 1.01) totals.zoomed += 1;

    env.flushFrames();
    editor.destroy();
    assert.equal(env.frames.size, 0, `seed ${seed}: no frames left`);
    assert.equal(env.timers.size, 0, `seed ${seed}: no timers left`);
    assert.equal(env.canvasListeners.count(), 0, `seed ${seed}: no listeners left`);
  }

  // The storm must actually have exercised the editor, or the checks above mean nothing.
  assert.ok(totals.live > 200, `live drag changes: ${totals.live}`);
  assert.ok(totals.final > 300, `final changes: ${totals.final}`);
  assert.ok(totals.taps > 50, `taps: ${totals.taps}`);
  assert.ok(totals.zoomed > 5, `runs that ended zoomed in: ${totals.zoomed}`);
});
