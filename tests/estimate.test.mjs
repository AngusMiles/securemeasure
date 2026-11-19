/**
 * The no-paper estimate (js/estimate.js): rectification maths ported from the research baseline's tests,
 * plus the app wrappers on synthetic doors projected through the dev camera model (tools/camera.mjs), so
 * every corner position is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STANDARD_SIZES,
  ESTIMATE_THRESHOLDS,
  PHONE_DEFAULT_F35,
  focalPxFrom35mm,
  isFullFrameAspect,
  photoFocal,
  standardSizesFrom,
  intrinsics,
  squareToQuad,
  applyH,
  rectifyRectangle,
  aspectSigmaLn,
  classifyStandard,
  sigmaLnScaleFromP90,
  estimateFromCorners,
  planeToImageFor,
  nearestStandard,
} from '../js/estimate.js';
import { cameraHomography, projectPoint } from '../tools/camera.mjs';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cornersFromH = (H, W, Hh) => [[0, 0], [W, 0], [W, Hh], [0, Hh]].map(([x, y]) => projectPoint(H, { x, y }));
const label = (s) => `${s.widthMm ?? s.w}x${s.heightMm ?? s.h}`;

/**
 * Corners of a door photographed the way a customer would: camera aimed at the opening's middle, held
 * `cameraHeightMm` above the sill, `distanceMm` away, `yawDeg` off to the side.
 */
function doorShot({ widthMm, heightMm, imageWidth = 1536, imageHeight = 2048, focalPx = 1538, distanceMm = 2600, yawDeg = 0, rollDeg = 0, cameraHeightMm = 1400 }) {
  const target = { x: widthMm / 2, y: heightMm * 0.52 };
  const pitchDeg = (Math.asin((heightMm - cameraHeightMm - target.y) / distanceMm) * 180) / Math.PI;
  const H = cameraHomography({ imageWidth, imageHeight, focalPx, target, distanceMm, yawDeg, pitchDeg, rollDeg });
  return { corners: cornersFromH(H, widthMm, heightMm), imageWidth, imageHeight, focalPx };
}

// The research benchmark's six synthetic photos (photos.json syn-01..06), rebuilt from their poses.
const SYNTH = [
  { id: 'syn-01', width: 1536, height: 2048, focalPx: 1538, w: 820, h: 2040, distanceMm: 2500, yawDeg: -10, pitchDeg: -9.6902, rollDeg: 0.5, target: { x: 410, y: 1060.8 } },
  { id: 'syn-02', width: 1536, height: 2048, focalPx: 1538, w: 920, h: 2040, distanceMm: 3000, yawDeg: 15, pitchDeg: -9.0289, rollDeg: -0.8, target: { x: 460, y: 1060.8 } },
  { id: 'syn-03', width: 1536, height: 2048, focalPx: 1538, w: 870, h: 2100, distanceMm: 2000, yawDeg: 5, pitchDeg: -9.846, rollDeg: 0, target: { x: 435, y: 1092 } },
  { id: 'syn-04', width: 1536, height: 2048, focalPx: 1538, w: 920, h: 2340, distanceMm: 3500, yawDeg: -15, pitchDeg: -6.1803, rollDeg: 1, target: { x: 460, y: 1216.8 } },
  { id: 'syn-05', width: 2048, height: 1536, focalPx: 1538, w: 820, h: 2040, distanceMm: 3200, yawDeg: 12, pitchDeg: -5.7536, rollDeg: -0.4, target: { x: 410, y: 1060.8 } },
  { id: 'syn-06', width: 1536, height: 2048, focalPx: 2100, w: 870, h: 2100, distanceMm: 2800, yawDeg: -6, pitchDeg: -9.0825, rollDeg: 1.2, target: { x: 435, y: 1092 } },
].map((s) => {
  const { id, width, height, focalPx, w, h, ...pose } = s;
  const H = cameraHomography({ imageWidth: width, imageHeight: height, focalPx, ...pose });
  return { id, width, height, focalPx, truthMm: { w, h }, doorCornersPx: cornersFromH(H, w, h) };
});

/* ---------------------------------------------------------------- ported maths -------------------- */

test('focal from 35 mm equivalent matches the synthetic 26 mm phone camera', () => {
  assert.ok(Math.abs(focalPxFrom35mm(26, 1536, 2048) - 1538) < 1);
  assert.ok(Number.isNaN(focalPxFrom35mm(26, 0, 2048)));
  assert.ok(Number.isNaN(focalPxFrom35mm(NaN, 1536, 2048)));
  assert.equal(PHONE_DEFAULT_F35, 26);
});

test('squareToQuad maps the unit square onto the corners', () => {
  const c = [{ x: 100, y: 120 }, { x: 900, y: 80 }, { x: 950, y: 1900 }, { x: 60, y: 1800 }];
  const H = squareToQuad(c);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const p = applyH(H, u, v);
    assert.ok(Math.abs(p.x - c[i].x) < 1e-9 && Math.abs(p.y - c[i].y) < 1e-9);
  });
});

test('rectification recovers the exact aspect of all 6 synthetic benchmark photos', () => {
  for (const s of SYNTH) {
    const K = intrinsics(s.focalPx, s.width, s.height);
    const r = rectifyRectangle(s.doorCornersPx, K);
    const truth = s.truthMm.h / s.truthMm.w;
    assert.ok(Math.abs(r.aspectHW / truth - 1) < 2e-6, `${s.id} ${r.aspectHW} vs ${truth}`);
    assert.ok(r.orthogonalityErrDeg < 1e-3, `${s.id} orth ${r.orthogonalityErrDeg}`);
  }
});

test('rectification is exact for 300 random camera.mjs poses', () => {
  const rand = rng(1);
  for (let i = 0; i < 300; i++) {
    const W = 600 + 500 * rand();
    const Hh = 1900 + 500 * rand();
    const width = 1536;
    const height = 2048;
    const focalPx = 1200 + 1200 * rand();
    const H = cameraHomography({
      imageWidth: width, imageHeight: height, focalPx,
      target: { x: W / 2, y: Hh / 2 }, distanceMm: 2000 + 3000 * rand(),
      yawDeg: -35 + 70 * rand(), pitchDeg: -25 + 50 * rand(), rollDeg: -5 + 10 * rand(),
    });
    const c = cornersFromH(H, W, Hh);
    const r = rectifyRectangle(c, intrinsics(focalPx, width, height));
    assert.ok(Math.abs(r.aspectHW / (Hh / W) - 1) < 1e-9);
  }
});

test('aspectSigmaLn agrees with a Monte Carlo of corner noise', () => {
  const s = SYNTH[0];
  const K = intrinsics(s.focalPx, s.width, s.height);
  const sig = aspectSigmaLn(s.doorCornersPx, K, 3);
  const rand = rng(7);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const xs = [];
  for (let i = 0; i < 4000; i++) {
    const c = s.doorCornersPx.map((p) => ({ x: p.x + 3 * gauss(), y: p.y + 3 * gauss() }));
    xs.push(Math.log(rectifyRectangle(c, K).aspectHW));
  }
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  assert.ok(Math.abs(sd / sig - 1) < 0.1, `mc ${sd} vs linear ${sig}`);
  // The focal term only adds uncertainty.
  assert.ok(aspectSigmaLn(s.doorCornersPx, K, 3, 0.08) > sig);
});

test('classifier: exact aspect picks the size; scale separates the 0.7%-apart 2040x720 / 2340x820 pair', () => {
  for (const s of DEFAULT_STANDARD_SIZES) {
    const top = classifyStandard({ aspectHW: s.heightMm / s.widthMm, sigmaLnAspect: 0.001, sizes: DEFAULT_STANDARD_SIZES })[0];
    assert.equal(label(top), label(s));
  }
  // The research shape { w, h } works too and comes back in that shape (US 80 in + UK 6'6").
  const other = [{ w: 762, h: 2032 }, { w: 813, h: 2032 }, { w: 914, h: 2032 }, { w: 762, h: 1981 }, { w: 838, h: 1981 }];
  for (const s of other) {
    const top = classifyStandard({ aspectHW: s.h / s.w, sigmaLnAspect: 0.001, sizes: other })[0];
    assert.equal(`${top.w}x${top.h}`, `${s.w}x${s.h}`);
  }
  const amb = classifyStandard({ aspectHW: 2340 / 820, sigmaLnAspect: 0.01 });
  assert.ok(amb[0].p < 0.7, 'aspect alone must stay ambiguous');
  const res = classifyStandard({ aspectHW: 2340 / 820, sigmaLnAspect: 0.01, estimateMm: { w: 800, h: 2300 }, sigmaLnScale: sigmaLnScaleFromP90(10) });
  assert.equal(label(res[0]), '820x2340');
  assert.ok(Math.abs(res.reduce((a, b) => a + b.p, 0) - 1) < 1e-12);
  assert.equal(res.length, DEFAULT_STANDARD_SIZES.length, 'default catalogue is the AU list');
  // Bad input is an empty ranking, never a throw; unusable sizes and zero-weight sizes are skipped.
  assert.deepEqual(classifyStandard({ aspectHW: NaN, sigmaLnAspect: 0.01 }), []);
  assert.deepEqual(classifyStandard({ aspectHW: 2.5, sigmaLnAspect: 0 }), []);
  assert.deepEqual(classifyStandard(), []);
  const mixed = classifyStandard({ aspectHW: 2.5, sigmaLnAspect: 0.02, sizes: [null, { widthMm: -1, heightMm: 2040 }, { widthMm: 820, heightMm: 2040 }, { widthMm: 920, heightMm: 2340 }], priors: [1, 1, 1, 0] });
  assert.deepEqual(mixed.map(label), ['820x2040']);
});

/* ---------------------------------------------------------------- app wrappers -------------------- */

test('DEFAULT_STANDARD_SIZES is the frozen Australian list', () => {
  assert.equal(DEFAULT_STANDARD_SIZES.length, 10);
  assert.ok(Object.isFrozen(DEFAULT_STANDARD_SIZES) && DEFAULT_STANDARD_SIZES.every(Object.isFrozen));
  assert.deepEqual(DEFAULT_STANDARD_SIZES.map(label), [
    '720x2040', '770x2040', '820x2040', '870x2040', '920x2040', '820x2100', '870x2100', '920x2100', '820x2340', '920x2340',
  ]);
});

test('photoFocal: a believable EXIF 35 mm focal is used, anything else gets the 26 mm phone prior', () => {
  const size = { width: 1536, height: 2048 };
  assert.deepEqual(photoFocal({ ...size, focal35mm: 28 }), { focalPx: focalPxFrom35mm(28, 1536, 2048), source: 'exif' });
  for (const focal35mm of [null, undefined, 0, 5, 250, NaN, '26']) {
    assert.deepEqual(photoFocal({ ...size, focal35mm }), { focalPx: focalPxFrom35mm(26, 1536, 2048), source: 'prior' }, String(focal35mm));
  }
  assert.equal(photoFocal({ ...size, focal35mm: 10 }).source, 'exif');
  assert.equal(photoFocal({ ...size, focal35mm: 200 }).source, 'exif');
  assert.equal(photoFocal({ ...size }).source, 'prior', 'older photo objects without the field');
  assert.ok(Number.isNaN(photoFocal(null).focalPx));
});

test("photoFocal: a picked file's EXIF is a best guess ('exif_file'); our own captures and the demo are trusted", () => {
  const size = { width: 1536, height: 2048 };
  const at = (f35) => focalPxFrom35mm(f35, 1536, 2048);
  // takePhoto(), the demo's known lens, and (for compatibility) a photo object that does not say.
  for (const capture of ['live', 'frame', 'demo', undefined]) {
    assert.deepEqual(photoFocal({ ...size, focal35mm: 28, capture }), { focalPx: at(28), source: 'exif' }, String(capture));
    assert.deepEqual(photoFocal({ ...size, focal35mm: null, capture }), { focalPx: at(26), source: 'prior' }, String(capture));
  }
  // A picked file: the same figure, as the centre of a guess, and the prior on a file is marked as such.
  assert.deepEqual(photoFocal({ ...size, focal35mm: 28, capture: 'file' }), { focalPx: at(28), source: 'exif_file' });
  assert.deepEqual(photoFocal({ ...size, focal35mm: null, capture: 'file' }), { focalPx: at(26), source: 'prior_file' });
  assert.deepEqual(photoFocal({ width: 1600, height: 3000, focal35mm: 26, capture: 'file' }), { focalPx: focalPxFrom35mm(26, 1600, 3000), source: 'prior_file' }, 'a free crop still gets the prior');

  // estimateFromCorners keeps the source, and a file's figure gets the prior's sigma, not the EXIF one.
  const shot = doorShot({ widthMm: 820, heightMm: 2040, yawDeg: 12 });
  const sigma = (focalSource) => estimateFromCorners({ ...shot, focalSource }).sigmaLnAspect;
  for (const source of ['exif', 'prior', 'exif_file', 'prior_file']) assert.equal(estimateFromCorners({ ...shot, source }).focalSource, source);
  assert.equal(estimateFromCorners({ ...shot, focalSource: 'exif_camera' }).focalSource, 'prior', 'anything else counts as the prior');
  assert.equal(sigma('exif_file'), sigma('prior'));
  assert.equal(sigma('prior_file'), sigma('prior'));
  assert.ok(sigma('exif_file') > sigma('exif'));
});

test('a gallery crop that kept the 4:3 shape and its EXIF is not trusted as the camera\'s own focal', () => {
  // A 3024 x 4032 frame at a true 26 mm, centre-cropped with the 'Original' aspect (still 4:3), so EXIF
  // keeps 26 mm and its pixel size matches the crop (readJpegInfo keeps the focal) and the shape check
  // passes. The real focal of the crop in its own pixels is then 1/crop of what 26 mm gives.
  const frame = { width: 3024, height: 4032 };
  const focalPx = focalPxFrom35mm(26, frame.width, frame.height);
  for (const { widthMm, heightMm, crop: k, yawDeg, before } of [
    { widthMm: 820, heightMm: 2040, crop: 0.6, yawDeg: 25, before: '770x2040' },
    { widthMm: 920, heightMm: 2040, crop: 0.75, yawDeg: 20, before: '920x2100' },
    { widthMm: 920, heightMm: 2040, crop: 0.6, yawDeg: 25, before: '870x2040' },
  ]) {
    const name = `${widthMm}x${heightMm}, crop ${k}, yaw ${yawDeg}`;
    const H = cameraHomography({ imageWidth: frame.width, imageHeight: frame.height, focalPx, target: { x: widthMm / 2, y: heightMm / 2 }, distanceMm: 2800 / k, yawDeg, pitchDeg: 5 });
    const crop = { width: Math.round(frame.width * k), height: Math.round(frame.height * k) };
    assert.ok(isFullFrameAspect(crop.width, crop.height), `${name}: the crop still looks like a whole frame`);
    const corners = cornersFromH(H, widthMm, heightMm).map((p) => ({ x: p.x - (frame.width - crop.width) / 2, y: p.y - (frame.height - crop.height) / 2 }));
    const shot = { corners, imageWidth: crop.width, imageHeight: crop.height };

    // What trusting the tag gave: a wrong size, confidently, with nothing to flag it.
    const trusted = estimateFromCorners({ ...shot, focalPx: focalPxFrom35mm(26, crop.width, crop.height), focalSource: 'exif' });
    assert.equal(label(trusted), before, name);
    assert.equal(trusted.confident, true, name);
    assert.deepEqual(trusted.issues, [], name);

    // Picked from the library, the same figure is only a best guess: the lens decides, so not confident.
    const focal = photoFocal({ ...crop, focal35mm: 26, capture: 'file' });
    assert.equal(focal.source, 'exif_file', name);
    const m = estimateFromCorners({ ...shot, ...focal });
    assert.equal(label(m), before, `${name}: same corners, same focal`);
    assert.deepEqual(m.issues, ['steep_angle'], name);
    assert.equal(m.confident, false, `${name}: p ${m.candidates[0].p.toFixed(2)}`);

    // The camera's own still (takePhoto) is the whole frame, so its EXIF is still trusted.
    const live = photoFocal({ ...frame, focal35mm: 26, capture: 'live' });
    assert.equal(live.source, 'exif', name);
    assert.equal(label(estimateFromCorners({ corners: cornersFromH(H, widthMm, heightMm), imageWidth: frame.width, imageHeight: frame.height, ...live })), `${widthMm}x${heightMm}`, name);
  }
});

test('photoFocal trusts EXIF only for a whole camera frame (4:3 or 3:2, either way up, within 2 %)', () => {
  for (const [width, height] of [[1536, 2048], [2048, 1536], [3024, 4032], [4080, 3072], [3024, 4000], [4000, 6000], [6000, 4000]]) {
    assert.ok(isFullFrameAspect(width, height), `${width}x${height}`);
    assert.deepEqual(photoFocal({ width, height, focal35mm: 26 }), { focalPx: focalPxFrom35mm(26, width, height), source: 'exif' }, `${width}x${height}`);
  }
  // A gallery crop that kept the camera's EXIF, a 16:9 or square camera mode, a 4 % trim: the figure may
  // describe a bigger picture, so the prior (and its wider sigma) is used instead.
  for (const [width, height] of [[1600, 3000], [1080, 1920], [1920, 1080], [2000, 2000], [3024, 4200], [1200, 3000]]) {
    assert.equal(isFullFrameAspect(width, height), false, `${width}x${height}`);
    assert.deepEqual(photoFocal({ width, height, focal35mm: 26 }), { focalPx: focalPxFrom35mm(26, width, height), source: 'prior' }, `${width}x${height}`);
  }
  for (const [width, height] of [[0, 2048], [1536, NaN], [undefined, 2048], ['1536', 2048], [-1536, 2048]]) {
    assert.equal(isFullFrameAspect(width, height), false, `${width}x${height}`);
  }
});

test('a cropped gallery photo that kept its EXIF is not read with the crop-shortened focal', () => {
  // 3024 x 4032 phone frame at a true 26 mm, door photographed side-on (pure yaw), then centre-cropped to
  // 1600 x 3000 in a gallery app that copied the EXIF (still 26 mm).
  const frame = { width: 3024, height: 4032 };
  const crop = { width: 1600, height: 3000 };
  const focalPx = focalPxFrom35mm(26, frame.width, frame.height);
  const shots = [
    { widthMm: 920, heightMm: 2040, yawDeg: 25 },
    { widthMm: 870, heightMm: 2100, yawDeg: 35 },
  ];
  for (const { widthMm, heightMm, yawDeg } of shots) {
    const H = cameraHomography({ imageWidth: frame.width, imageHeight: frame.height, focalPx, target: { x: widthMm / 2, y: heightMm / 2 }, distanceMm: 3200, yawDeg });
    const full = cornersFromH(H, widthMm, heightMm);
    const corners = full.map((p) => ({ x: p.x - (frame.width - crop.width) / 2, y: p.y - (frame.height - crop.height) / 2 }));
    assert.ok(corners.every((p) => p.x > 0 && p.x < crop.width && p.y > 0 && p.y < crop.height), 'the door is inside the crop');
    const name = `${widthMm}x${heightMm} at ${yawDeg} deg`;

    // What trusting the copied tag gave: a wrong size, confidently, with nothing to flag it.
    const trusted = estimateFromCorners({ corners, imageWidth: crop.width, imageHeight: crop.height, focalPx: focalPxFrom35mm(26, crop.width, crop.height), focalSource: 'exif' });
    assert.notEqual(label(trusted), `${widthMm}x${heightMm}`, name);
    assert.equal(trusted.confident, true, name);
    assert.deepEqual(trusted.issues, [], name);

    // Now: the crop's shape sends it to the prior, which is never confident here: either the match is
    // unsure, or the angle makes the lens guess matter ('steep_angle').
    const focal = photoFocal({ ...crop, focal35mm: 26, capture: 'file' });
    assert.equal(focal.source, 'prior_file', name);
    const m = estimateFromCorners({ corners, imageWidth: crop.width, imageHeight: crop.height, ...focal });
    assert.equal(m.focalSource, 'prior_file', name);
    assert.equal(m.confident, false, `${name}: ${label(m)} p ${m.candidates[0].p.toFixed(2)} ${m.issues}`);

    // The uncropped frame still uses its EXIF figure and finds the right size, from takePhoto() or picked.
    for (const capture of ['live', 'file']) {
      const whole = estimateFromCorners({ corners: full, imageWidth: frame.width, imageHeight: frame.height, ...photoFocal({ ...frame, focal35mm: 26, capture }) });
      assert.equal(whole.focalSource, capture === 'live' ? 'exif' : 'exif_file', name);
      assert.equal(label(whole), `${widthMm}x${heightMm}`, `${name}, ${capture}`);
    }
  }
});

test('standardSizesFrom: the config list when usable (bad entries dropped), else the defaults', () => {
  const sizes = [{ widthMm: 762, heightMm: 2032 }, { widthMm: 813, heightMm: 2032 }];
  assert.deepEqual(standardSizesFrom({ measurement: { standardSizes: sizes } }), sizes);
  assert.notEqual(standardSizesFrom({ measurement: { standardSizes: sizes } })[0], sizes[0], 'fresh objects');
  assert.deepEqual(
    standardSizesFrom({ measurement: { standardSizes: [{ widthMm: 820, heightMm: 2040, label: 'x' }, { widthMm: '870', heightMm: 2040 }, null, { widthMm: 820, heightMm: 2040 }, { widthMm: 0, heightMm: 2040 }, { widthMm: 900, heightMm: 1e9 }] } }),
    [{ widthMm: 820, heightMm: 2040 }],
  );
  const defaults = DEFAULT_STANDARD_SIZES.map((s) => ({ ...s }));
  for (const config of [undefined, null, {}, { measurement: {} }, { measurement: { standardSizes: 'AU' } }, { measurement: { standardSizes: [] } }, { measurement: { standardSizes: [{}] } }]) {
    assert.deepEqual(standardSizesFrom(config), defaults);
  }
  const copy = standardSizesFrom({});
  copy[0].widthMm = 1;
  assert.equal(DEFAULT_STANDARD_SIZES[0].widthMm, 720, 'the defaults cannot be changed through a result');
});

test('an 820 x 2040 door comes back as 820 x 2040 from several poses with the true focal', () => {
  const poses = [
    { yawDeg: 0, distanceMm: 2600 },
    { yawDeg: -15, distanceMm: 2200, rollDeg: 1 },
    { yawDeg: 12, distanceMm: 3200, rollDeg: -0.6 },
    { yawDeg: 20, distanceMm: 2800, cameraHeightMm: 1550 },
    { yawDeg: -8, distanceMm: 3500, imageWidth: 2048, imageHeight: 1536, focalPx: 2100 },
  ];
  for (const pose of poses) {
    const shot = doorShot({ widthMm: 820, heightMm: 2040, ...pose });
    const m = estimateFromCorners({ ...shot, focalSource: 'exif' });
    assert.equal(m.ok, true, JSON.stringify(pose));
    assert.equal(m.method, 'estimate');
    assert.equal(label(m.candidates[0]), '820x2040', JSON.stringify(pose));
    assert.ok(Math.abs(m.aspectHW / (2040 / 820) - 1) < 1e-6);
    assert.equal(m.nonStandard, false);
    assert.deepEqual(m.issues, [], JSON.stringify(pose));
    assert.equal(m.widthMm, 820);
    assert.equal(m.heightMm, 2040);
    assert.equal(m.focalSource, 'exif');
    assert.equal(m.focalPx, shot.focalPx);
    assert.equal(m.imageWidth, shot.imageWidth);
    assert.equal(m.imageHeight, shot.imageHeight);
    assert.ok(m.orthogonalityErrDeg < 1e-3);
    assert.ok(m.candidates.length <= 4);
    assert.ok(m.candidates.every((c) => DEFAULT_STANDARD_SIZES.some((s) => label(s) === label(c))));
    assert.deepEqual(Object.keys(m.candidates[0]).sort(), ['heightMm', 'p', 'widthMm', 'zAspect']);
    for (let i = 1; i < m.candidates.length; i++) assert.ok(m.candidates[i].p <= m.candidates[i - 1].p);
    m.corners.forEach((c, i) => assert.ok(Math.abs(c.x - shot.corners[i].x) < 1e-9 && Math.abs(c.y - shot.corners[i].y) < 1e-9));
  }
});

test('near-frontal photos need no EXIF: the 26 mm prior still gives 820 x 2040 with a 24-28 mm lens', () => {
  for (const f35 of [24, 26, 28]) {
    for (const yawDeg of [-5, 0, 5]) {
      const focalPx = focalPxFrom35mm(f35, 1536, 2048);
      const shot = doorShot({ widthMm: 820, heightMm: 2040, focalPx, yawDeg, rollDeg: 0.6 });
      const m = estimateFromCorners({ ...shot, ...photoFocal({ width: 1536, height: 2048, focal35mm: null }) });
      assert.equal(m.ok, true);
      assert.equal(m.focalSource, 'prior', 'photoFocal spreads in as { focalPx, source }');
      assert.ok(Math.abs(m.focalPx - focalPxFrom35mm(26, 1536, 2048)) < 1e-9);
      assert.equal(label(m.candidates[0]), '820x2040', `${f35} mm, yaw ${yawDeg}`);
      assert.ok(!m.issues.includes('steep_angle'));
    }
  }
});

test('the prior focal is less certain than EXIF, and an oblique prior-focal photo says so', () => {
  const shot = doorShot({ widthMm: 820, heightMm: 2040, yawDeg: 12 });
  const exif = estimateFromCorners({ ...shot, focalSource: 'exif' });
  const prior = estimateFromCorners({ ...shot, focalSource: 'prior' });
  const unknown = estimateFromCorners({ ...shot });
  assert.ok(prior.sigmaLnAspect > exif.sigmaLnAspect);
  assert.equal(unknown.focalSource, 'prior', 'no source counts as the prior');
  assert.ok(exif.sigmaLnAspect >= 0.01, 'never more certain than the 1 % floor');
  const steep = estimateFromCorners({ ...doorShot({ widthMm: 820, heightMm: 2040, yawDeg: 30 }), focalSource: 'prior' });
  assert.ok(steep.viewTiltDeg > 18);
  assert.ok(steep.issues.includes('steep_angle'));
  assert.ok(!estimateFromCorners({ ...doorShot({ widthMm: 820, heightMm: 2040, yawDeg: 30 }), focalSource: 'exif' }).issues.includes('steep_angle'));
});

/** What `confident` comes to from p and the other issues alone, leaving out the 'steep_angle' rule. */
const confidentApartFromAngle = (m) =>
  m.candidates[0].p >= ESTIMATE_THRESHOLDS.confidentP &&
  !m.nonStandard &&
  !m.issues.includes('not_rectangular') &&
  !m.issues.includes('door_near_edge');

test('a steep picked photo with the 26 mm prior is never confident, even when one size looks sure', () => {
  // The research case: an 870 x 2100 door 35 deg off to the side on a 26 mm phone (3024 x 4032 frame),
  // cropped to 1600 x 3000 in a gallery app and picked. The crop's shape rightly sends it to the prior,
  // which is then 0.67x the real focal; off-axis that moves the ratio onto another size, at a high p.
  const frame = { width: 3024, height: 4032 };
  const crop = { width: 1600, height: 3000 };
  const focalPx = focalPxFrom35mm(26, frame.width, frame.height);
  const H = cameraHomography({ imageWidth: frame.width, imageHeight: frame.height, focalPx, target: { x: 435, y: 1050 }, distanceMm: 3200, yawDeg: 35 });
  const corners = cornersFromH(H, 870, 2100).map((p) => ({ x: p.x - (frame.width - crop.width) / 2, y: p.y - (frame.height - crop.height) / 2 }));
  const shot = { corners, imageWidth: crop.width, imageHeight: crop.height };

  const prior = estimateFromCorners({ ...shot, ...photoFocal({ ...crop, focal35mm: 26, capture: 'file' }) });
  assert.equal(prior.focalSource, 'prior_file');
  assert.deepEqual(prior.issues, ['steep_angle']);
  assert.equal(label(prior), '770x2040', 'a wrong size');
  assert.ok(prior.candidates[0].p >= ESTIMATE_THRESHOLDS.confidentP, `that looks sure (p ${prior.candidates[0].p.toFixed(2)})`);
  assert.equal(confidentApartFromAngle(prior), true, 'only the angle rule stops it');
  assert.equal(prior.confident, false);

  // The same corners with the lens's true focal as a trusted EXIF figure: the right size, no 'steep_angle'
  // although the view is just as steep, and `confident` from p as usual (at 35 deg p is honestly below 0.8).
  const exif = estimateFromCorners({ ...shot, focalPx, focalSource: 'exif' });
  assert.equal(label(exif), '870x2100');
  assert.ok(exif.viewTiltDeg > prior.viewTiltDeg + 5, `the guessed focal understates the angle (${prior.viewTiltDeg.toFixed(1)} vs ${exif.viewTiltDeg.toFixed(1)} deg)`);
  assert.deepEqual(exif.issues, []);
  assert.equal(exif.confident, confidentApartFromAngle(exif));
});

test('an iPhone camera-app photo on the 2x lens is not confidently the wrong size, though its angle reads small', () => {
  // 'Use your camera app instead' on an iPhone: `<input capture>` strips EXIF, so the 26 mm prior is used,
  // but the customer tapped 2x (52 mm) and stood 20 deg off to the side of an 820 x 2100 door, 5.2 m back.
  const imageWidth = 1920;
  const imageHeight = 2560;
  const focalPx = focalPxFrom35mm(52, imageWidth, imageHeight);
  const shot = doorShot({ widthMm: 820, heightMm: 2100, imageWidth, imageHeight, focalPx, distanceMm: 5200, yawDeg: 20 });
  const truth = estimateFromCorners({ ...shot, focalSource: 'exif' });
  assert.equal(label(truth), '820x2100');

  const focal = photoFocal({ width: imageWidth, height: imageHeight, focal35mm: null, capture: 'file' });
  assert.equal(focal.source, 'prior_file');
  assert.ok(Math.abs(focal.focalPx / focalPx - 0.5) < 1e-9, 'the guess is half the real focal');
  const m = estimateFromCorners({ ...shot, ...focal });
  // Measured with that focal the view looks nearly square: the angle cannot tell whether the lens matters.
  assert.ok(m.viewTiltDeg < 12 && m.viewTiltDeg < 0.6 * truth.viewTiltDeg, `tilt ${m.viewTiltDeg.toFixed(1)} vs ${truth.viewTiltDeg.toFixed(1)} deg`);
  assert.equal(label(m), '770x2040', 'a wrong size');
  assert.ok(m.candidates[0].p > 0.99, `that looks sure (p ${m.candidates[0].p.toFixed(3)})`);
  assert.deepEqual(m.issues, ['steep_angle']);
  assert.equal(m.confident, false);

  // The whole catalogue, 10-30 deg either side, with exact corners: never confidently a wrong size.
  const shots = [];
  let flagged = 0;
  for (const { widthMm, heightMm } of DEFAULT_STANDARD_SIZES) {
    for (const yawDeg of [-30, -25, -20, -15, -10, 10, 15, 20, 25, 30]) {
      const exact = doorShot({ widthMm, heightMm, imageWidth, imageHeight, focalPx, distanceMm: 5200, yawDeg });
      const e = estimateFromCorners({ ...exact, ...focal });
      if (e.issues.includes('steep_angle')) flagged++;
      if (e.confident) assert.equal(label(e), `${widthMm}x${heightMm}`, `${widthMm}x${heightMm}, yaw ${yawDeg}: confident, so right`);
      shots.push({ exact, truth: `${widthMm}x${heightMm}` });
    }
  }
  assert.ok(flagged > 50, `the lens is flagged as deciding on most of the 100 shots (${flagged})`);

  // With 3 px taps it is rarely confidently wrong: a tap or two can still pull the ratio onto the next size
  // at a lens that does not change the answer. Counted over 40 seeds of 5 tapped versions of each shot, so
  // the rate is what is checked and not one seed's luck: 56 of 1063 confident estimates are wrong (5.3 %;
  // 0-5 a seed). Before the lens was asked, 67 % were (3374 of 5015); asking every lens from half to twice
  // for a sure match, which also took the sure answer from most square-on photos, 2.1 % (16 of 748).
  const sigmaPx = (3 * imageHeight) / 2048;
  let confident = 0;
  let wrong = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    for (const { exact, truth } of shots) {
      for (let k = 0; k < 5; k++) {
        const corners = exact.corners.map((p) => ({ x: p.x + sigmaPx * gauss(), y: p.y + sigmaPx * gauss() }));
        const n = estimateFromCorners({ ...exact, corners, ...focal });
        if (n.confident) {
          confident++;
          if (label(n) !== truth) wrong++;
        }
      }
    }
  }
  assert.ok(confident > 500, `${confident} confident estimates`);
  assert.ok(wrong <= 0.08 * confident, `${wrong} of ${confident} confident estimates wrong`);
});

test('a free-form gallery crop (prior 0.6-0.7x the real focal) is never confidently the wrong size', () => {
  // A 26 mm, 3024 x 4032 photo cropped around the door to a shape that is no camera frame's, so the
  // prior is used on the crop's diagonal: 0.62-0.67x the real focal.
  const frame = { width: 3024, height: 4032 };
  const focalPx = focalPxFrom35mm(26, frame.width, frame.height);
  let n = 0;
  for (const { widthMm, heightMm } of DEFAULT_STANDARD_SIZES) {
    for (const [cw, ch] of [[0.5, 0.75], [0.45, 0.7], [0.6, 0.8]]) {
      for (const yawDeg of [15, 20, 25, 30, 35]) {
        for (const pitchDeg of [0, 6]) {
          const H = cameraHomography({ imageWidth: frame.width, imageHeight: frame.height, focalPx, target: { x: widthMm / 2, y: heightMm / 2 }, distanceMm: 3200, yawDeg, pitchDeg });
          const full = cornersFromH(H, widthMm, heightMm);
          const crop = { width: Math.round(frame.width * cw), height: Math.round(frame.height * ch) };
          const xs = full.map((p) => p.x);
          const ys = full.map((p) => p.y);
          const ox = (Math.min(...xs) + Math.max(...xs)) / 2 - crop.width / 2;
          const oy = (Math.min(...ys) + Math.max(...ys)) / 2 - crop.height / 2;
          const corners = full.map((p) => ({ x: p.x - ox, y: p.y - oy }));
          if (corners.some((p) => p.x < 0.02 * crop.width || p.y < 0.02 * crop.height || p.x > 0.98 * crop.width || p.y > 0.98 * crop.height)) continue;
          const focal = photoFocal({ ...crop, focal35mm: 26, capture: 'file' });
          assert.equal(focal.source, 'prior_file');
          const m = estimateFromCorners({ corners, imageWidth: crop.width, imageHeight: crop.height, ...focal });
          n++;
          if (m.confident) assert.equal(label(m), `${widthMm}x${heightMm}`, `${widthMm}x${heightMm}, crop ${crop.width}x${crop.height}, yaw ${yawDeg}, pitch ${pitchDeg}`);
        }
      }
    }
  }
  assert.ok(n > 200, `${n} crops`);
});

test('a door square to the phone but off to one side of the photo is not said to be on an angle', () => {
  // A portrait photo with no EXIF, the phone facing the wall squarely, the door in the lower right. The line
  // of sight to the door is 18 deg off its normal, but its ratio is the same with every lens.
  const imageWidth = 1920;
  const imageHeight = 2560;
  const f = focalPxFrom35mm(26, imageWidth, imageHeight);
  for (const { widthMm, heightMm } of [{ widthMm: 870, heightMm: 2100 }, { widthMm: 920, heightMm: 2040 }]) {
    // The door's centre 800 mm right of and 300 mm below the optical axis, 2.6 m away.
    const cx = widthMm / 2 - 800;
    const cy = heightMm / 2 - 300;
    const corners = [[0, 0], [widthMm, 0], [widthMm, heightMm], [0, heightMm]].map(([x, y]) => ({
      x: imageWidth / 2 + (f * (x - cx)) / 2600,
      y: imageHeight / 2 + (f * (y - cy)) / 2600,
    }));
    for (const capture of ['frame', 'file']) {
      const name = `${widthMm}x${heightMm}, ${capture}`;
      const m = estimateFromCorners({ corners, imageWidth, imageHeight, ...photoFocal({ width: imageWidth, height: imageHeight, focal35mm: null, capture }) });
      assert.ok(m.viewTiltDeg > 18, `${name}: line-of-sight tilt ${m.viewTiltDeg.toFixed(1)} deg`);
      const K = intrinsics(m.focalPx, imageWidth, imageHeight);
      for (const k of [0.5, 2]) assert.ok(Math.abs(rectifyRectangle(m.corners, { ...K, f: f * k }).aspectHW / m.aspectHW - 1) < 1e-9, `${name}: same ratio at ${k}x`);
      assert.deepEqual(m.issues, [], name);
      assert.equal(label(m), `${widthMm}x${heightMm}`, name);
      assert.equal(m.confident, true, `${name}: p ${m.candidates[0].p.toFixed(2)}`);
    }
  }
});

test("a picked photo taken square on, tilted down at the door's middle as usual, is judged as our own camera's", () => {
  // Nearly every photo is taken from chest height aimed at the opening's middle, so tilted down 6-10 deg. A
  // longer lens or a crop reads that tilt as steeper, which moves the ratio a little (870 x 2040 from 2.6 m
  // becomes 870 x 2100 on twice the focal), but only with the camera far higher than anyone holds a phone.
  // So a square-on photo is not said to be on an angle, whether it came from the camera app or the library:
  // an iPhone camera-app photo (no EXIF) is judged like a frame from our camera, an Android one (EXIF
  // 26 mm) like takePhoto().
  let sure = 0;
  for (const [imageWidth, imageHeight] of [[1920, 2560], [3000, 4000]]) {
    const focalPx = focalPxFrom35mm(26, imageWidth, imageHeight);
    for (const { widthMm, heightMm } of DEFAULT_STANDARD_SIZES) {
      for (const distanceMm of [2600, 3000]) {
        for (const pitchDeg of [-6, -8, -10]) {
          const target = { x: widthMm / 2, y: heightMm / 2 };
          const H = cameraHomography({ imageWidth, imageHeight, focalPx, target, distanceMm, pitchDeg });
          const shot = { corners: cornersFromH(H, widthMm, heightMm), imageWidth, imageHeight };
          for (const [focal35mm, own, picked] of [[null, 'frame', 'prior_file'], [26, 'live', 'exif_file']]) {
            const name = `${widthMm}x${heightMm}, ${imageWidth}x${imageHeight}, ${distanceMm} mm, pitch ${pitchDeg}, ${picked}`;
            const photo = { width: imageWidth, height: imageHeight, focal35mm };
            const ours = estimateFromCorners({ ...shot, ...photoFocal({ ...photo, capture: own }) });
            const file = estimateFromCorners({ ...shot, ...photoFocal({ ...photo, capture: 'file' }) });
            assert.equal(file.focalSource, picked, name);
            assert.equal(label(file), label(ours), name);
            if (!ours.confident) continue;
            sure++;
            assert.deepEqual(file.issues, [], `${name}: p ${file.candidates[0].p.toFixed(2)}`);
            assert.equal(file.confident, true, `${name}: p ${file.candidates[0].p.toFixed(2)}`);
          }
        }
      }
    }
  }
  assert.ok(sure >= 100, `${sure} confident from our own camera`);

  // The review's cases: 870 x 2040 and 920 x 2040 from 2.6 m, aimed at the middle (pitch -6 and -9 deg),
  // and the test photo of this file (camera 1.4 m up, 2.6 m back), picked with and without EXIF.
  const imageWidth = 1920;
  const imageHeight = 2560;
  const focalPx = focalPxFrom35mm(26, imageWidth, imageHeight);
  for (const widthMm of [870, 920]) {
    const shots = [-6, -9].map((pitchDeg) => {
      const H = cameraHomography({ imageWidth, imageHeight, focalPx, target: { x: widthMm / 2, y: 1020 }, distanceMm: 2600, pitchDeg });
      return { corners: cornersFromH(H, widthMm, 2040), imageWidth, imageHeight };
    });
    shots.push(doorShot({ widthMm, heightMm: 2040 }));
    for (const shot of shots) {
      for (const focal35mm of [null, 26]) {
        const m = estimateFromCorners({ ...shot, ...photoFocal({ width: shot.imageWidth, height: shot.imageHeight, focal35mm, capture: 'file' }) });
        const name = `${widthMm}x2040, ${m.focalSource}, tilt ${m.viewTiltDeg.toFixed(1)} deg`;
        assert.equal(label(m), `${widthMm}x2040`, name);
        assert.deepEqual(m.issues, [], name);
        assert.equal(m.confident, true, `${name}: p ${m.candidates[0].p.toFixed(2)}`);
      }
    }
  }
});

test('picked photos taken the usual way are about as often confident as our own camera\'s, and as rarely wrong', () => {
  // 400 camera-app shots: phone 1.3-1.5 m up, aimed at the opening's middle from 2.2-3.2 m, up to 8 deg off
  // to the side and 1.5 deg rolled, corners tapped (3 px at 2048). Before picked photos were asked only
  // about the lenses that fit where a phone is held, 'prior_file' and 'exif_file' were each confident on 42
  // and 'steep_angle' came with 220; from our own camera ('frame') 141 were confident.
  const rand = rng(11);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const between = (a, b) => a + (b - a) * rand();
  const imageWidth = 1920;
  const imageHeight = 2560;
  const focalPx = focalPxFrom35mm(26, imageWidth, imageHeight);
  const sigmaPx = (3 * imageHeight) / 2048;
  const count = {};
  for (const source of ['prior', 'prior_file', 'exif', 'exif_file']) count[source] = { confident: 0, wrong: 0, steep: 0 };
  let n = 0;
  while (n < 400) {
    const { widthMm, heightMm } = DEFAULT_STANDARD_SIZES[Math.floor(rand() * DEFAULT_STANDARD_SIZES.length)];
    const cameraMm = between(1300, 1500);
    const distanceMm = between(2200, 3200);
    const pitchDeg = (-Math.atan2(cameraMm - heightMm / 2, distanceMm) * 180) / Math.PI;
    const target = { x: widthMm / 2, y: heightMm / 2 };
    const H = cameraHomography({ imageWidth, imageHeight, focalPx, target, distanceMm, yawDeg: between(-8, 8), pitchDeg, rollDeg: between(-1.5, 1.5) });
    const corners = cornersFromH(H, widthMm, heightMm).map((p) => ({ x: p.x + sigmaPx * gauss(), y: p.y + sigmaPx * gauss() }));
    if (corners.some((p) => p.x < 0.02 * imageWidth || p.y < 0.02 * imageHeight || p.x > 0.98 * imageWidth || p.y > 0.98 * imageHeight)) continue;
    n++;
    for (const [focal35mm, capture] of [[null, 'frame'], [null, 'file'], [26, 'live'], [26, 'file']]) {
      const m = estimateFromCorners({ corners, imageWidth, imageHeight, ...photoFocal({ width: imageWidth, height: imageHeight, focal35mm, capture }) });
      const c = count[m.focalSource];
      if (m.issues.includes('steep_angle')) c.steep++;
      if (m.confident) {
        c.confident++;
        if (label(m) !== `${widthMm}x${heightMm}`) c.wrong++;
      }
    }
  }
  const summary = JSON.stringify(count);
  // Measured: 'prior' 141 confident (1 wrong), 'prior_file' 136 (1), 'exif' 143 (1), 'exif_file' 138 (1).
  assert.ok(count.prior.confident >= 120, summary);
  assert.ok(count.prior_file.confident >= 0.85 * count.prior.confident, summary);
  assert.ok(count.exif_file.confident >= 0.85 * count.exif.confident, summary);
  assert.ok(count.prior_file.wrong <= count.prior.wrong && count.exif_file.wrong <= count.exif.wrong, summary);
  assert.ok(count.prior_file.steep <= 0.1 * n && count.exif_file.steep <= 0.1 * n, summary);
});

test('a steep frame from the live camera is unsure; the same shot with its EXIF focal is judged on p as usual', () => {
  // A 24 mm main camera (recent iPhone Pro) 25 deg off to the side of a 920 x 2040 door. As a grabbed video
  // frame (no EXIF) the 26 mm prior is used; the size happens to come out right and sure, but at this angle
  // a lens a little way off the guess (inside the live camera's +-25 % range) would make it 920 x 2100, so
  // it is not a sure match.
  const focalPx = focalPxFrom35mm(24, 1536, 2048);
  const shot = doorShot({ widthMm: 920, heightMm: 2040, focalPx, yawDeg: 25 });
  const frame = estimateFromCorners({ ...shot, ...photoFocal({ width: 1536, height: 2048, focal35mm: null, capture: 'frame' }) });
  assert.equal(frame.focalSource, 'prior');
  assert.deepEqual(frame.issues, ['steep_angle']);
  assert.equal(label(frame), '920x2040');
  assert.ok(frame.candidates[0].p >= ESTIMATE_THRESHOLDS.confidentP, `p ${frame.candidates[0].p.toFixed(2)}`);
  assert.equal(frame.confident, false);

  // takePhoto() with the 24 mm in its EXIF: the angle no longer rests on a lens guess.
  const photo = estimateFromCorners({ ...shot, ...photoFocal({ width: 1536, height: 2048, focal35mm: 24, capture: 'live' }) });
  assert.equal(photo.focalSource, 'exif');
  assert.ok(photo.viewTiltDeg > 20, `tilt ${photo.viewTiltDeg.toFixed(1)} deg`);
  assert.deepEqual(photo.issues, []);
  assert.equal(label(photo), '920x2040');
  assert.equal(photo.confident, true, `p ${photo.candidates[0].p.toFixed(2)}`);
});

test('a near-frontal prior-focal photo is unaffected by the angle rule, and a confident estimate is the right size', () => {
  for (const f35 of [24, 26, 28]) {
    for (const yawDeg of [-5, 0, 5]) {
      const name = `${f35} mm, yaw ${yawDeg}`;
      const shot = doorShot({ widthMm: 920, heightMm: 2040, focalPx: focalPxFrom35mm(f35, 1536, 2048), yawDeg, rollDeg: 0.6 });
      const m = estimateFromCorners({ ...shot, ...photoFocal({ width: 1536, height: 2048, focal35mm: null, capture: 'frame' }) });
      assert.equal(m.focalSource, 'prior', name);
      assert.deepEqual(m.issues, [], name);
      assert.equal(label(m), '920x2040', name);
      assert.equal(m.confident, true, `${name}: p ${m.candidates[0].p.toFixed(2)}`);
    }
  }

  // The whole catalogue, lenses from ultra-wide to 2x, angles to 35 deg, every way a photo arrives:
  // 'steep_angle' never comes with the camera's own EXIF and always means not confident; wherever it is
  // absent `confident` is the rule it was; and a confident estimate is always the right size. The live
  // camera ('frame') is always the 1x main lens, so it is only tried with 24-28 mm.
  let steep = 0;
  let plain = 0;
  let sure = 0;
  for (const { widthMm, heightMm } of DEFAULT_STANDARD_SIZES) {
    for (const f35 of [13, 24, 26, 28, 52]) {
      for (const yawDeg of [-35, -20, -10, 0, 10, 20, 35]) {
        const shot = doorShot({ widthMm, heightMm, focalPx: focalPxFrom35mm(f35, 1536, 2048), yawDeg, distanceMm: f35 > 30 ? 5200 : 2600 });
        const photos = [
          { focal35mm: null, capture: 'file' }, // iOS camera app, or a library photo without EXIF
          { focal35mm: f35, capture: 'file' }, // Android camera app, or a library photo with EXIF
          { focal35mm: f35, capture: 'live' }, // takePhoto()
        ];
        if (f35 >= 24 && f35 <= 28) photos.push({ focal35mm: null, capture: 'frame' });
        for (const photo of photos) {
          const name = `${widthMm}x${heightMm}, ${f35} mm, yaw ${yawDeg}, EXIF ${photo.focal35mm}, ${photo.capture}`;
          const m = estimateFromCorners({ ...shot, ...photoFocal({ width: 1536, height: 2048, ...photo }) });
          assert.equal(m.ok, true, name);
          if (m.issues.includes('steep_angle')) {
            steep++;
            assert.notEqual(m.focalSource, 'exif', name);
            assert.equal(m.confident, false, name);
          } else {
            plain++;
            assert.equal(m.confident, confidentApartFromAngle(m), name);
          }
          if (m.confident) {
            sure++;
            assert.equal(label(m), `${widthMm}x${heightMm}`, `${name}: confident, so right (p ${m.candidates[0].p.toFixed(2)})`);
          }
        }
      }
    }
  }
  assert.ok(steep > 0 && plain > 0 && sure > 0, `all kinds covered (${steep} steep, ${plain} not, ${sure} confident)`);
});

test('a clean shot of a well-separated size is confident; a 1000 x 1900 door is non-standard', () => {
  const clean = estimateFromCorners({ ...doorShot({ widthMm: 920, heightMm: 2040 }), focalSource: 'exif' });
  assert.equal(label(clean.candidates[0]), '920x2040');
  assert.ok(clean.candidates[0].p >= 0.8);
  assert.equal(clean.confident, true);

  for (const pose of [{ yawDeg: 0 }, { yawDeg: 10, distanceMm: 3000 }]) {
    const m = estimateFromCorners({ ...doorShot({ widthMm: 1000, heightMm: 1900, ...pose }), focalSource: 'exif' });
    assert.equal(m.ok, true);
    assert.equal(m.nonStandard, true);
    assert.ok(Math.abs(m.candidates[0].zAspect) > 3);
    assert.ok(m.issues.includes('non_standard'));
    assert.equal(m.confident, false);
    assert.ok(Math.abs(m.aspectHW - 1.9) < 1e-6, 'the ratio itself is still right');
  }
});

test('issues: corners that are not a rectangle, a door cut off at the edge, a door that is too small', () => {
  const shot = doorShot({ widthMm: 820, heightMm: 2040 });
  const bent = shot.corners.map((p, i) => (i === 1 ? { x: p.x + 60, y: p.y - 40 } : p));
  const m = estimateFromCorners({ ...shot, corners: bent, focalSource: 'exif' });
  assert.ok(m.orthogonalityErrDeg > 2);
  assert.ok(m.issues.includes('not_rectangular'));
  assert.equal(m.confident, false);

  const near = estimateFromCorners({ ...doorShot({ widthMm: 820, heightMm: 2040, distanceMm: 1500 }), focalSource: 'exif' });
  assert.ok(near.issues.includes('door_near_edge'));
  assert.equal(near.confident, false);
  const far = estimateFromCorners({ ...doorShot({ widthMm: 820, heightMm: 2040, distanceMm: 6000 }), focalSource: 'exif' });
  assert.ok(far.issues.includes('door_small'));
  assert.ok(!far.issues.includes('door_near_edge'));
});

test('a door cut off at the photo edge is never confident, however sure the ratio looks', () => {
  // Standing too close: the sill is below the photo, so the customer drags the bottom corners to the
  // bottom edge, along the jambs. The ratio is then short by the cut, but still matches some size well.
  const imageWidth = 1536;
  const imageHeight = 2048;
  const focalPx = focalPxFrom35mm(PHONE_DEFAULT_F35, imageWidth, imageHeight);
  // About 3 %, 7.5 % and 3 % of the opening's height cut off.
  for (const { widthMm, heightMm, distanceMm } of [
    { widthMm: 870, heightMm: 2100, distanceMm: 1700 },
    { widthMm: 870, heightMm: 2100, distanceMm: 1550 },
    { widthMm: 820, heightMm: 2040, distanceMm: 1600 },
  ]) {
    const target = { x: widthMm / 2, y: heightMm * 0.4 };
    const pitchDeg = (Math.asin((heightMm - 1400 - target.y) / distanceMm) * 180) / Math.PI;
    const H = cameraHomography({ imageWidth, imageHeight, focalPx, target, distanceMm, pitchDeg });
    const [tl, tr, br, bl] = cornersFromH(H, widthMm, heightMm);
    const name = `${widthMm}x${heightMm} from ${distanceMm} mm`;
    assert.ok(br.y > imageHeight && bl.y > imageHeight && tl.y > 0.05 * imageHeight && tr.y > 0.05 * imageHeight, `${name}: only the sill is out of the photo`);
    const onEdge = (top, bottom) => {
      const t = (imageHeight - 0.5 - top.y) / (bottom.y - top.y);
      return { x: top.x + t * (bottom.x - top.x), y: imageHeight - 0.5 };
    };
    const corners = [tl, tr, onEdge(tr, br), onEdge(tl, bl)];
    const m = estimateFromCorners({ corners, imageWidth, imageHeight, ...photoFocal({ width: imageWidth, height: imageHeight, focal35mm: null }) });
    assert.equal(m.ok, true, name);
    assert.ok(m.issues.includes('door_near_edge'), name);
    assert.ok(m.candidates[0].p >= 0.8, `${name}: the cut ratio still looks like one size (${label(m)}, p ${m.candidates[0].p.toFixed(2)})`);
    assert.notEqual(label(m), `${widthMm}x${heightMm}`, `${name}: and it is the wrong one`);
    assert.equal(m.confident, false, name);
  }
});

test('corners in any order describe the same opening', () => {
  const shot = doorShot({ widthMm: 870, heightMm: 2040, yawDeg: 7 });
  const base = estimateFromCorners({ ...shot, focalSource: 'exif' });
  const [tl, tr, br, bl] = shot.corners;
  for (const corners of [[br, bl, tl, tr], [tr, tl, bl, br], [bl, br, tr, tl]]) {
    const m = estimateFromCorners({ ...shot, corners, focalSource: 'exif' });
    assert.deepEqual(m, base);
  }
});

test('a steep, rolled view whose head slopes past 45 deg is still read head first, in every handle order', () => {
  // Seen well off to one side and from below with the phone rolled: TR is the corner nearest the photo's
  // top-left, and starting there would read the opening a corner round (0.40 high-to-wide, non-standard).
  const corners = [{ x: 536, y: 672 }, { x: 992, y: 173 }, { x: 1804, y: 2490 }, { x: 924, y: 2519 }];
  const input = { imageWidth: 1920, imageHeight: 2560, focalPx: focalPxFrom35mm(PHONE_DEFAULT_F35, 1920, 2560), focalSource: 'prior' };
  const [tl, tr, br, bl] = corners;
  for (const order of [corners, [tr, br, bl, tl], [br, tl, bl, tr], [bl, br, tr, tl]]) {
    const m = estimateFromCorners({ ...input, corners: order });
    assert.equal(m.ok, true);
    assert.ok(Math.abs(m.aspectHW - 2.49) < 0.01, `aspect ${m.aspectHW.toFixed(3)}`);
    assert.equal(label(m.candidates[0]), '820x2040');
    assert.equal(m.issues.includes('non_standard'), false);
    // The result preview draws from these: the same corners, head first.
    assert.deepEqual(m.corners, corners);
    assert.deepEqual(m.planeToImage, planeToImageFor(corners, 820, 2040));
  }
});

test('cornerSigmaPx: a known corner error replaces the tap sigma; anything else keeps the tap sigma', () => {
  const shot = doorShot({ widthMm: 870, heightMm: 2040, yawDeg: 9 });
  const base = estimateFromCorners({ ...shot, focalSource: 'exif' });
  // The door screen's figure for corners still where detection put them: 9 px at 2048 px.
  const detected = estimateFromCorners({ ...shot, focalSource: 'exif', cornerSigmaPx: 9 });
  assert.ok(detected.sigmaLnAspect > base.sigmaLnAspect * 1.5, `${detected.sigmaLnAspect} vs ${base.sigmaLnAspect}`);
  assert.ok(detected.candidates[0].p < base.candidates[0].p);
  // The tap sigma given explicitly is the default exactly.
  const tap = (ESTIMATE_THRESHOLDS.tapSigmaPxAt2048 * Math.max(shot.imageWidth, shot.imageHeight)) / 2048;
  assert.deepEqual(estimateFromCorners({ ...shot, focalSource: 'exif', cornerSigmaPx: tap }), base);
  for (const bad of [0, -3, NaN, Infinity, '9', null]) {
    assert.deepEqual(estimateFromCorners({ ...shot, focalSource: 'exif', cornerSigmaPx: bad }), base, String(bad));
  }
});

test('only the catalogue it is given is ever offered; unusable catalogues fall back to the defaults', () => {
  const shot = doorShot({ widthMm: 820, heightMm: 2040, yawDeg: 6 });
  const sizes = [{ widthMm: 762, heightMm: 2032 }, { widthMm: 813, heightMm: 2032 }, { widthMm: 914, heightMm: 2032 }];
  const us = estimateFromCorners({ ...shot, focalSource: 'exif', sizes });
  assert.equal(us.candidates.length, 3);
  assert.ok(us.candidates.every((c) => sizes.some((s) => label(s) === label(c))));
  assert.equal(label(us.candidates[0]), '813x2032');
  for (const bad of [null, 'AU', [], [{ widthMm: 'x' }]]) {
    const m = estimateFromCorners({ ...shot, focalSource: 'exif', sizes: bad });
    assert.equal(label(m.candidates[0]), '820x2040');
    assert.equal(m.candidates.length, 4);
  }
});

test('bad corners or inputs give { ok: false, error } and never throw', () => {
  const shot = doorShot({ widthMm: 820, heightMm: 2040 });
  const [tl, tr, br, bl] = shot.corners;
  // One corner dragged inside the triangle of the other three: no order of these points is convex.
  const dent = { x: (tl.x + br.x + bl.x) / 3, y: (tl.y + br.y + bl.y) / 3 };
  assert.deepEqual(estimateFromCorners({ ...shot, corners: [tl, dent, br, bl] }), { ok: false, error: 'not_convex' });
  const cases = [
    { ...shot, corners: [tl, tl, br, bl] },
    { ...shot, corners: [tl, { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }, br, bl] },
    { ...shot, corners: [tl, tr, br] },
    { ...shot, corners: [tl, tr, br, { x: NaN, y: 3 }] },
    { ...shot, corners: null },
    { ...shot, focalPx: 0 },
    { ...shot, focalPx: NaN },
    { ...shot, imageWidth: 0 },
    { ...shot, imageHeight: undefined },
    { corners: shot.corners },
    null,
    undefined,
    'corners',
  ];
  for (const input of cases) assert.deepEqual(estimateFromCorners(input), { ok: false, error: 'degenerate' });
});

test('planeToImageFor maps (0,0), (W,0), (W,H), (0,H) mm onto the corners', () => {
  const shot = doorShot({ widthMm: 820, heightMm: 2040, yawDeg: -11, rollDeg: 0.8 });
  for (const [W, H] of [[820, 2040], [920, 2340], [1, 1]]) {
    const P = planeToImageFor(shot.corners, W, H);
    assert.equal(P.length, 9);
    [[0, 0], [W, 0], [W, H], [0, H]].forEach(([x, y], i) => {
      const p = projectPoint(P, { x, y });
      assert.ok(Math.abs(p.x - shot.corners[i].x) < 1e-6 && Math.abs(p.y - shot.corners[i].y) < 1e-6, `${W}x${H} corner ${i}`);
    });
  }
  const m = estimateFromCorners({ ...shot, focalSource: 'exif' });
  assert.deepEqual(m.planeToImage, planeToImageFor(m.corners, m.widthMm, m.heightMm));
  assert.equal(planeToImageFor(shot.corners, 0, 2040), null);
  assert.equal(planeToImageFor(shot.corners.slice(0, 3), 820, 2040), null);
  assert.equal(planeToImageFor(null, 820, 2040), null);
});

test('nearestStandard: an AR measurement of 823 x 2051 is 820 x 2040', () => {
  const r = nearestStandard({ widthMm: 823, heightMm: 2051 });
  assert.equal(label(r[0]), '820x2040');
  assert.ok(r.length <= 3);
  assert.deepEqual(Object.keys(r[0]).sort(), ['heightMm', 'p', 'widthMm', 'zAspect']);
  assert.ok(r.reduce((a, b) => a + b.p, 0) <= 1 + 1e-12);
  // Size counts as well as shape: 872 x 2108 is 870 x 2100, not the similar-shaped 820 x 2040 family.
  assert.equal(label(nearestStandard({ widthMm: 872, heightMm: 2108 })[0]), '870x2100');
  const us = nearestStandard({ widthMm: 815, heightMm: 2030, sizes: [{ widthMm: 762, heightMm: 2032 }, { widthMm: 813, heightMm: 2032 }] });
  assert.equal(label(us[0]), '813x2032');
  assert.equal(us.length, 2);
  assert.deepEqual(nearestStandard({ widthMm: 0, heightMm: 2040 }), []);
  assert.deepEqual(nearestStandard({ widthMm: 820 }), []);
  assert.deepEqual(nearestStandard(), []);
});
