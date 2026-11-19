// Unit tests for the pure maths of the photo-scale lab page (lab/photo-scale/): metadata, AF depth, brick
// courses, statistics. Every image and file is synthesised here; nothing is read from disk.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMeta } from '../lab/photo-scale/meta.js';
import {
  analyseAfDepth, afPointFromExif, afDepthReading, orientPoint, rawForHeight, gravityCheck, impliedRawUnitMm, focalRoundingPct,
} from '../lab/photo-scale/afdepth.js';
import {
  brickSteps, runBrickSync, brickScale, harmonicPeriod, heightFromCourse, courseFromPeriod, PMIN, PMAX, SPU, STRONG_SCORE, HEIGHT_GATE_MM,
} from '../lab/photo-scale/brick.js';
import {
  percentile, errorStats, methodEstimate, sessionSummary, rowErrors, cornersConfirmed, rowRoute, afImpliedUnit, GO_RULES,
  CUSTOMER_ROUTES, EFFORT_ROUTES, ROUTES,
} from '../lab/photo-scale/stats.js';
import { rectifyRectangle } from '../js/estimate.js';
import { cameraHomography, projectPoint } from '../tools/camera.mjs';

// ---------------------------------------------------------------------------------------------------------
// Byte builders
// ---------------------------------------------------------------------------------------------------------

const cat = (...parts) => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : typeof p === 'string' ? str(p) : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u16be = (n) => Uint8Array.of(n >> 8, n & 255);
const u32be = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const box = (type, ...content) => {
  const body = cat(...content);
  return cat(u32be(8 + body.length), type, body);
};

const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Bytes and count of one TIFF value. */
function encode(type, value, little) {
  if (type === 2) return { bytes: str(`${value}\0`), count: value.length + 1 };
  if (type === 7) return { bytes: value, count: value.length };
  const out = new Uint8Array(SIZES[type] * (type === 5 || type === 10 ? value.length : value.length));
  const dv = new DataView(out.buffer);
  value.forEach((v, i) => {
    if (type === 3) dv.setUint16(2 * i, v, little);
    else if (type === 4) dv.setUint32(4 * i, v, little);
    else if (type === 9) dv.setInt32(4 * i, v, little);
    else if (type === 5) {
      dv.setUint32(8 * i, v[0], little);
      dv.setUint32(8 * i + 4, v[1], little);
    } else if (type === 10) {
      dv.setInt32(8 * i, v[0], little);
      dv.setInt32(8 * i + 4, v[1], little);
    }
  });
  return { bytes: out, count: value.length };
}

/** One IFD whose out-of-line values follow it; offsets are written relative to `base` (ifdPos is the IFD's). */
function ifd(entries, little, ifdPos) {
  const enc = entries.map((e) => ({ ...e, ...encode(e.type, e.value, little) }));
  const head = 2 + 12 * enc.length + 4;
  const dataLen = enc.reduce((n, e) => n + (e.bytes.length > 4 ? e.bytes.length + (e.bytes.length & 1) : 0), 0);
  const out = new Uint8Array(head + dataLen);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, enc.length, little);
  let data = head;
  enc.forEach((e, i) => {
    const p = 2 + 12 * i;
    dv.setUint16(p, e.tag, little);
    dv.setUint16(p + 2, e.type, little);
    dv.setUint32(p + 4, e.count, little);
    if (e.bytes.length <= 4) out.set(e.bytes, p + 8);
    else {
      dv.setUint32(p + 8, ifdPos + data, little);
      out.set(e.bytes, data);
      data += e.bytes.length + (e.bytes.length & 1);
    }
  });
  return out;
}

/** Apple's MakerNote: 'Apple iOS\0', version 1, 'MM', IFD at 14 (always big-endian), offsets from its start. */
function appleMakerNote({ depth = 250, confidence = 1, accel = [[-2, 100], [-98, 100], [15, 100]] } = {}) {
  const entries = [
    { tag: 0x0001, type: 9, value: [14] },
    { tag: 0x0008, type: 10, value: accel },
    { tag: 0x0038, type: 9, value: [depth] },
    { tag: 0x003d, type: 9, value: [confidence] },
  ];
  return cat('Apple iOS\0', u16be(1), 'MM', ifd(entries, false, 14));
}

/** A TIFF block with IFD0 (Make, Model, Orientation, Exif pointer) and an Exif IFD. */
function tiff(little, { makerNote = appleMakerNote(), exposure = [1, 120], extraExif = [] } = {}) {
  const ifd0 = (exifPos) => [
    { tag: 0x010f, type: 2, value: 'Apple' },
    { tag: 0x0110, type: 2, value: 'iPhone 15 Pro' },
    { tag: 0x0112, type: 3, value: [6] },
    { tag: 0x8769, type: 4, value: [exifPos] },
  ];
  const exifEntries = [
    { tag: 0x829a, type: 5, value: [exposure] },
    { tag: 0x920a, type: 5, value: [[6765, 1000]] },
    { tag: 0x9214, type: 3, value: [2013, 1511, 2217, 1330] },
    ...(makerNote ? [{ tag: 0x927c, type: 7, value: makerNote }] : []),
    { tag: 0xa002, type: 4, value: [4032] },
    { tag: 0xa003, type: 4, value: [3024] },
    { tag: 0xa405, type: 3, value: [24] },
    ...extraExif,
  ].sort((a, b) => a.tag - b.tag);
  const first = ifd(ifd0(0), little, 8);
  const exifPos = 8 + first.length;
  const header = little ? cat('II', [42, 0], [8, 0, 0, 0]) : cat('MM', [0, 42], [0, 0, 0, 8]);
  return cat(header, ifd(ifd0(exifPos), little, 8), ifd(exifEntries, little, exifPos));
}

function jpeg(tiffBytes) {
  const app0 = cat([0xff, 0xe0], u16be(16), 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const xmp = cat([0xff, 0xe1], u16be(2 + 10), 'http://ns\0');
  const app1 = cat([0xff, 0xe1], u16be(2 + 6 + tiffBytes.length), 'Exif\0\0', tiffBytes);
  return cat([0xff, 0xd8], app0, xmp, app1, [0xff, 0xd9]);
}

/** A HEIF with an 'Exif' item; `split` stores the item as two extents with a gap between them. */
function heif(tiffBytes, { split = false } = {}) {
  const ftyp = box('ftyp', 'heic', u32be(0), 'mif1', 'heic');
  const hdlr = box('hdlr', u32be(0), u32be(0), 'pict', u32be(0), u32be(0), u32be(0), [0]);
  const infe = (id, type) => box('infe', [2, 0, 0, 0], u16be(id), u16be(0), type, [0]);
  const iinf = box('iinf', [0, 0, 0, 0], u16be(2), infe(1, 'hvc1'), infe(2, 'Exif'));
  const payload = cat(u32be(6), 'Exif\0\0', tiffBytes);
  const cut = split ? 37 : payload.length;
  const gap = split ? Uint8Array.of(0xde, 0xad, 0xbe, 0xef) : new Uint8Array(0);
  const extents = (offset) => (split
    ? cat(u16be(2), u32be(offset), u32be(cut), u32be(offset + cut + gap.length), u32be(payload.length - cut))
    : cat(u16be(1), u32be(offset), u32be(payload.length)));
  const iloc = (offset) => box('iloc', [1, 0, 0, 0], [0x44, 0x00], u16be(1), u16be(2), u16be(0), u16be(0), extents(offset));
  const metaFor = (offset) => box('meta', [0, 0, 0, 0], hdlr, iinf, iloc(offset));
  const offset = ftyp.length + metaFor(0).length + 8;
  return cat(ftyp, metaFor(offset), box('mdat', payload.subarray(0, cut), gap, payload.subarray(cut)));
}

function assertApple(meta, container) {
  assert.equal(meta.container, container);
  assert.equal(meta.exif.make, 'Apple');
  assert.equal(meta.exif.model, 'iPhone 15 Pro');
  assert.equal(meta.exif.orientation, 6);
  assert.equal(meta.exif.focal35, 24);
  assert.ok(Math.abs(meta.exif.focalLength - 6.765) < 1e-9);
  assert.ok(Math.abs(meta.exif.exposureTime - 1 / 120) < 1e-12);
  assert.deepEqual(meta.exif.subjectArea, [2013, 1511, 2217, 1330]);
  assert.equal(meta.exif.pixelX, 4032);
  assert.equal(meta.exif.pixelY, 3024);
  assert.equal(meta.maker.present, true);
  assert.equal(meta.maker.apple, true);
  assert.equal(meta.maker.afDepthRaw, 250);
  assert.equal(meta.maker.afConfidence, 1);
  assert.deepEqual(meta.maker.accel, [-0.02, -0.98, 0.15]);
  const named = Object.fromEntries(meta.maker.tags.map((t) => [t.tag, t]));
  assert.equal(named['0x0038'].name, 'AFMeasuredDepth');
  assert.equal(named['0x0008'].type, 'SRATIONAL');
  assert.equal(named['0x0001'].name, '');
  assert.deepEqual(named['0x0001'].value, [14]);
}

// ---------------------------------------------------------------------------------------------------------
// meta.js
// ---------------------------------------------------------------------------------------------------------

test('meta: a JPEG with Exif in either byte order and an Apple MakerNote parses fully', () => {
  for (const little of [true, false]) {
    const meta = parseMeta(jpeg(tiff(little)).buffer);
    assertApple(meta, 'jpeg');
    assert.equal(meta.exif.byteOrder, little ? 'II' : 'MM');
  }
});

test('meta: the same TIFF inside a synthetic HEIF gives the same result', () => {
  for (const little of [true, false]) {
    const fromJpeg = parseMeta(jpeg(tiff(little)));
    for (const split of [false, true]) {
      const fromHeif = parseMeta(heif(tiff(little), { split }));
      assertApple(fromHeif, 'heif');
      assert.deepEqual(fromHeif.exif, fromJpeg.exif);
      assert.deepEqual(fromHeif.maker, fromJpeg.maker);
    }
  }
});

test('meta: truncating the file at every length never throws', () => {
  for (const bytes of [jpeg(tiff(true)), jpeg(tiff(false)), heif(tiff(false)), heif(tiff(true), { split: true })]) {
    for (let n = 0; n <= bytes.length; n++) {
      const meta = parseMeta(bytes.slice(0, n).buffer);
      assert.equal(typeof meta.container, 'string');
      assert.ok(Array.isArray(meta.warnings));
      assert.equal(typeof meta.maker.present, 'boolean');
    }
  }
});

test('meta: garbage and odd inputs never throw', () => {
  for (const input of [undefined, null, 42, 'x', new ArrayBuffer(0), Uint8Array.of(0xff, 0xd8, 0xff), Uint8Array.of(1, 2, 3, 4, 5)]) {
    const meta = parseMeta(input);
    assert.ok(meta && Array.isArray(meta.warnings));
  }
  const unknown = parseMeta(Uint8Array.from({ length: 100 }, (_, i) => i));
  assert.equal(unknown.container, 'other');
  assert.equal(unknown.head64.split(' ').length, 64);
});

test('meta: a maker note that is not Apple\'s is reported as such', () => {
  const nikon = cat('Nikon\0', [2, 0x10, 0, 0], 'MM', [0, 42, 0, 0, 0, 8], [0, 0, 0, 0, 0, 0]);
  const meta = parseMeta(jpeg(tiff(true, { makerNote: nikon })));
  assert.equal(meta.maker.present, true);
  assert.equal(meta.maker.apple, false);
  assert.equal(meta.maker.reason, 'not_apple');
  assert.match(meta.maker.header.ascii, /^Nikon/);
  assert.equal(meta.maker.afDepthRaw, null);
  assert.ok(meta.warnings.some((w) => /not Apple/.test(w)));
});

test('meta: no maker note at all says so', () => {
  const meta = parseMeta(jpeg(tiff(false, { makerNote: null })));
  assert.equal(meta.maker.present, false);
  assert.equal(meta.maker.reason, 'no_makernote_tag');
  assert.equal(meta.exif.focal35, 24);
});

test('meta: zero RATIONAL denominators give null, not Infinity', () => {
  const meta = parseMeta(jpeg(tiff(true, {
    exposure: [1, 0],
    makerNote: appleMakerNote({ accel: [[1, 0], [-98, 100], [0, 0]] }),
  })));
  assert.equal(meta.exif.exposureTime, null);
  assert.equal(meta.maker.accel, null);
  const accel = meta.maker.tags.find((t) => t.tag === '0x0008');
  assert.deepEqual(accel.value, [null, -0.98, null]);
  assert.equal(accel.zeroDenominator, true);
  assert.equal(meta.maker.afDepthRaw, 250);
});

// ---------------------------------------------------------------------------------------------------------
// afdepth.js
// ---------------------------------------------------------------------------------------------------------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const DOOR = { W: 820, H: 2040 };

/** An exact camera from tools/camera.mjs, its door corners, and its pose recovered from K^-1 H. */
function exactCamera({ w = 1536, h = 2048, dist, yaw, pitch, roll = 0, target = { x: 410, y: 1020 } }) {
  const f = (26 / Math.hypot(36, 24)) * Math.hypot(w, h);
  const K = { f, cx: w / 2, cy: h / 2 };
  const Hm = cameraHomography({ imageWidth: w, imageHeight: h, focalPx: f, target, distanceMm: dist, yawDeg: yaw, pitchDeg: pitch, rollDeg: roll });
  const corners = [[0, 0], [DOOR.W, 0], [DOOR.W, DOOR.H], [0, DOOR.H]].map(([x, y]) => projectPoint(Hm, { x, y }));
  const kinv = (v) => [(v[0] - K.cx * v[2]) / K.f, (v[1] - K.cy * v[2]) / K.f, v[2]];
  const r1 = kinv([Hm[0], Hm[3], Hm[6]]);
  const r2 = kinv([Hm[1], Hm[4], Hm[7]]);
  const t = kinv([Hm[2], Hm[5], Hm[8]]);
  return { K, Hm, corners, r1, r2, t, n: cross(r1, r2), w, h };
}

/** True depth to the plane set back s mm, along the ray through image point p: axial (z) and range (|X|). */
function trueDepth(cam, p, s = 0) {
  const d = [(p.x - cam.K.cx) / cam.K.f, (p.y - cam.K.cy) / cam.K.f, 1];
  const lambda = (dot(cam.n, cam.t) + s) / dot(cam.n, d);
  return { axial: lambda, range: lambda * Math.hypot(d[0], d[1], d[2]) };
}

test('afdepth: H is recovered within 0.01 mm for the matching depth model', () => {
  let cases = 0;
  for (const dist of [1500, 2200, 3000]) {
    for (const yaw of [-20, 0, 20]) {
      for (const pitch of [-10, 0, 10]) {
        const cam = exactCamera({ dist, yaw, pitch, roll: 2 });
        assert.ok(Math.abs(Math.hypot(...cam.r1) - 1) < 1e-9);
        // The image centre, and an off-centre point that is still on the opening (its centroid).
        const centroid = { x: cam.corners.reduce((a, c) => a + c.x, 0) / 4, y: cam.corners.reduce((a, c) => a + c.y, 0) / 4 };
        for (const p of [{ x: cam.K.cx, y: cam.K.cy }, centroid]) {
          const truth = trueDepth(cam, p);
          for (const model of ['axial', 'range']) {
            const r = analyseAfDepth({ corners: cam.corners, K: cam.K, point: p, depthMm: truth[model], setbackMm: 0 });
            assert.equal(r.ok, true);
            const v = r.models[model].variants.find((x) => x.setbackMm === 0);
            assert.ok(Math.abs(v.H - DOOR.H) < 0.01, `${model} dist ${dist} yaw ${yaw} pitch ${pitch}: H ${v.H}`);
            assert.ok(Math.abs(v.W - DOOR.W) < 0.01, `W ${v.W}`);
            assert.ok(Math.abs(v.Zmm - Math.abs(dot(cam.n, cam.t))) < 0.01);
            cases++;
          }
          // Off-centre, the two models disagree: the page must show both.
          if (p === centroid && Math.hypot(p.x - cam.K.cx, p.y - cam.K.cy) > 50) {
            const wrong = analyseAfDepth({ corners: cam.corners, K: cam.K, point: p, depthMm: truth.range, setbackMm: 0 });
            assert.ok(Math.abs(wrong.models.axial.variants[0].H - DOOR.H) > 1);
          }
        }
      }
    }
  }
  assert.equal(cases, 108);
});

test('afdepth: the set-back formula is exact for an offset leaf plane', () => {
  const cam = exactCamera({ dist: 2600, yaw: 15, pitch: -8, roll: -1 });
  const p = { x: cam.K.cx + 40, y: cam.K.cy + 90 };
  for (const s of [20, 40, 63]) {
    const truth = trueDepth(cam, p, s);
    for (const model of ['axial', 'range']) {
      const r = analyseAfDepth({ corners: cam.corners, K: cam.K, point: p, depthMm: truth[model], setbackMm: s });
      assert.ok(r.inside);
      assert.ok(Math.abs(r.headline[model].H - DOOR.H) < 0.01, `${model} s ${s}: ${r.headline[model].H}`);
      // Read as if the leaf were flush, the same depth overstates H by s / Zu.
      const flush = r.models[model].variants.find((x) => x.setbackMm === 0);
      assert.ok(Math.abs(flush.H - DOOR.H - s / r.Zu) < 0.01);
      // And the raw value that would have been exact is the one given.
      assert.ok(Math.abs(rawForHeight(r.geom, model, DOOR.H, s) * 10 - truth[model]) < 1e-6);
    }
  }
});

test('afdepth: an AF point outside the opening raises the flag', () => {
  const cam = exactCamera({ dist: 2500, yaw: 5, pitch: -5 });
  const outside = { x: 5, y: 5 };
  const r = analyseAfDepth({ corners: cam.corners, K: cam.K, point: outside, afDepthRaw: 250, afConfidence: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.inside, false);
  assert.equal(r.usable, false);
  assert.deepEqual(r.snap.range, []);
  const inside = analyseAfDepth({ corners: cam.corners, K: cam.K, point: { x: cam.K.cx, y: cam.K.cy }, afDepthRaw: 250, afConfidence: 1 });
  assert.equal(inside.inside, true);
  assert.equal(inside.usable, true);
});

test('afdepth: invalid readings give their reason', () => {
  assert.deepEqual(afDepthReading(null, 1).reasons, ['no_tag']);
  assert.deepEqual(afDepthReading(250, 0).reasons, ['confidence_zero']);
  assert.deepEqual(afDepthReading(1065, 3).reasons, ['out_of_range']);
  assert.deepEqual(afDepthReading(0, 3).reasons, ['not_positive']);
  const ok = afDepthReading(250, null);
  assert.equal(ok.valid, true);
  assert.equal(ok.depthMm, 2500);
});

test('afdepth: SubjectArea is turned by the orientation and scaled to the working image', () => {
  // iPhone portrait HEIC: stored 4032 x 3024, orientation 6, working 1920 x 2560.
  const r = afPointFromExif({ subjectArea: [2013, 1511, 2217, 1330], pixelX: 4032, pixelY: 3024, orientation: 6 }, 1920, 2560);
  assert.equal(r.source, 'subject_area');
  assert.ok(Math.abs(r.point.x - ((3024 - 1511) * 1920) / 3024) < 1e-9);
  assert.ok(Math.abs(r.point.y - (2013 * 2560) / 4032) < 1e-9);
  // A picker that turned the pixels but kept the stored size and orientation 1: read as 6, said to be a guess.
  assert.equal(afPointFromExif({ subjectArea: [2013, 1511], pixelX: 4032, pixelY: 3024, orientation: 1 }, 1920, 2560).source, 'subject_area_guess');
  assert.equal(afPointFromExif(null, 100, 200).source, 'centre');
  assert.equal(afPointFromExif({ subjectArea: [10, 10], pixelX: 4032, pixelY: 2268, orientation: 1 }, 1920, 2560).source, 'centre');
  for (let o = 1; o <= 8; o++) {
    const q = orientPoint(0, 0, 40, 30, o);
    assert.ok(q.x >= 0 && q.x <= q.w && q.y >= 0 && q.y <= q.h);
  }
});

test('afdepth: gravity along the door vertical is found by the best axis mapping', () => {
  const cam = exactCamera({ dist: 2500, yaw: 8, pitch: -10, roll: 3 });
  const rect = rectifyRectangle(cam.corners, cam.K);
  // Gravity in Apple axes for the documented mapping camera = (-X, +Y, +Z).
  const g = [-rect.r2[0], rect.r2[1], rect.r2[2]];
  const r = gravityCheck(g, rect.r2);
  assert.ok(r.documented.angleToDoorDeg < 1e-6);
  assert.ok(r.best.angleToDoorDeg < 1e-6);
  assert.ok(Math.abs(r.documentedFlipped.angleToDoorDeg - 180) < 1e-6);
  assert.equal(gravityCheck(null, rect.r2), null);
});

// ---------------------------------------------------------------------------------------------------------
// brick.js
// ---------------------------------------------------------------------------------------------------------

/** The pose tools/camera.mjs uses: camera centre and axes (world mm, y down, z into the house). */
function pose({ target, dist, yaw, pitch, roll }) {
  const r = Math.PI / 180;
  const d = [Math.sin(yaw * r) * Math.cos(pitch * r), Math.sin(pitch * r), -Math.cos(yaw * r) * Math.cos(pitch * r)];
  const C = [target.x + dist * d[0], target.y + dist * d[1], dist * d[2]];
  const zc = d.map((v) => -v);
  const n = cross([0, 1, 0], zc);
  const ln = Math.hypot(...n);
  let xc = n.map((v) => v / ln);
  let yc = cross(zc, xc);
  const c = Math.cos(roll * r);
  const s = Math.sin(roll * r);
  [xc, yc] = [xc.map((v, i) => c * v + s * yc[i]), yc.map((v, i) => -s * xc[i] + c * v)];
  return { C, xc, yc, zc };
}

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

/**
 * Test renderer (inverse mapping): each pixel's ray meets the wall plane at depth Z - d (z = -d); inside the
 * brick opening it goes on to the door plane (flat door, light frame); below the floor line it is paving.
 * Wall 'brick': mortar where (height mod course) < joint, plus perpends; 'weatherboard': 165 mm boards with a
 * shadow under each lap; 'flat': plain render.
 */
function renderWall({ w = 1024, h = 1365, f, P, d = 0, e = 45, wall = 'brick', course = 86, joint = 10, seed = 7 }) {
  const random = rng(seed);
  const shade = Float64Array.from({ length: 4096 }, () => random() - 0.5);
  const data = new Float32Array(w * h);
  const { C, xc, yc, zc } = P;
  const cx = w / 2;
  const cy = h / 2;
  const wallLum = (X, Yup) => {
    if (wall === 'flat') return 150;
    if (wall === 'weatherboard') {
      const within = Yup - Math.floor(Yup / 165) * 165;
      return within < 8 ? 70 : 150 + 40 * (within / 165);
    }
    const k = Math.floor(Yup / course);
    const xo = X + (k & 1) * 120;
    const j = Math.floor(xo / 240);
    if (Yup - k * course < joint || xo - j * 240 < 10) return 205;
    return 120 + 30 * shade[(k * 7919 + j * 104729) & 4095];
  };
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let acc = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const a = (col + sx - cx) / f;
        const b = (row + sy - cy) / f;
        const D = [a * xc[0] + b * yc[0] + zc[0], a * xc[1] + b * yc[1] + zc[1], a * xc[2] + b * yc[2] + zc[2]];
        const t1 = (-d - C[2]) / D[2];
        const X1 = C[0] + t1 * D[0];
        const Y1 = C[1] + t1 * D[1];
        if (Y1 >= DOOR.H) acc += 110;
        else if (X1 > -e && X1 < DOOR.W + e && Y1 > -e) {
          const t0 = -C[2] / D[2];
          const X0 = C[0] + t0 * D[0];
          const Y0 = C[1] + t0 * D[1];
          acc += X0 >= 0 && X0 <= DOOR.W && Y0 >= 0 ? 60 : 225;
        } else acc += wallLum(X1, DOOR.H - Y1);
      }
      data[row * w + col] = acc / 4 + 4 * (random() - 0.5);
    }
  }
  return { data, width: w, height: h };
}

/** A 1024 x 1365 brick scene and the brick search on its exact corners. */
function brickScene(opts) {
  const w = 1024;
  const h = 1365;
  const f = (26 / Math.hypot(36, 24)) * Math.hypot(w, h);
  const cam = { target: { x: 410, y: 1020 }, dist: 2500, yaw: 12, pitch: -8, roll: 1 };
  const P = pose(cam);
  const Hm = cameraHomography({ imageWidth: w, imageHeight: h, focalPx: f, target: cam.target, distanceMm: cam.dist, yawDeg: cam.yaw, pitchDeg: cam.pitch, rollDeg: cam.roll });
  const corners = [[0, 0], [DOOR.W, 0], [DOOR.W, DOOR.H], [0, DOOR.H]].map(([x, y]) => projectPoint(Hm, { x, y }));
  // The renderer's pose is the one tools/camera.mjs projects with.
  const proj = (X) => {
    const q = [X[0] - P.C[0], X[1] - P.C[1], X[2] - P.C[2]];
    return { x: (f * dot(q, P.xc)) / dot(q, P.zc) + w / 2, y: (f * dot(q, P.yc)) / dot(q, P.zc) + h / 2 };
  };
  const check = proj([DOOR.W, DOOR.H, 0]);
  assert.ok(Math.hypot(check.x - corners[2].x, check.y - corners[2].y) < 1e-6);
  const luma = renderWall({ w, h, f, P, ...opts });
  const K = { f, cx: w / 2, cy: h / 2 };
  if (opts.shiftTL) corners[0] = { x: corners[0].x + opts.shiftTL[0], y: corners[0].y + opts.shiftTL[1] };
  const rect = rectifyRectangle(corners, K);
  const found = runBrickSync(brickSteps(luma, corners, rect.widthOverHeight));
  return { found, rect, Zperp: Math.abs(P.C[2]), K };
}

test('brick: the course period and H are recovered, with the reveal correction', () => {
  for (const d of [0, 120]) {
    const { found, rect, Zperp } = brickScene({ d });
    assert.equal(found.found, true, JSON.stringify(found.reason));
    assert.ok(found.nAgree >= 3, `agreeing ${found.nAgree}`);
    const expected = (86 / DOOR.H) * (Zperp / (Zperp - d));
    const err = found.periodUnits / expected - 1;
    assert.ok(Math.abs(err) < 0.005, `d ${d}: period ${found.periodUnits} vs ${expected} (${(100 * err).toFixed(3)} %)`);
    const scale = brickScale(found, { Zu: Math.abs(dot(rect.r3, rect.t)), aspectHW: rect.aspectHW, revealMm: d, regionId: 'AU86', sigmaLnAspect: 0.012 });
    assert.deepEqual(scale.checks, []);
    assert.ok(found.agreeLRPct < 0.5 && found.agreeTBPct < 0.5, `halves ${found.agreeLRPct} / ${found.agreeTBPct}`);
    const H = scale.regional.H;
    assert.ok(Math.abs(H / DOOR.H - 1) < 0.01, `d ${d}: H ${H}`);
    assert.ok(Math.abs(scale.regional.W / DOOR.W - 1) < 0.012, `d ${d}: W ${scale.regional.W}`);
    assert.equal(scale.regional.gateOk, true);
    assert.equal(scale.snap[0].widthMm, 820);
    assert.equal(scale.snap[0].heightMm, 2040);
    if (d > 0) {
      // Without the correction the nearer brick face reads the door too small.
      assert.ok(DOOR.H - scale.regional.Hraw > 0.03 * DOOR.H);
    }
  }
});

test('brick: a flat wall scores under 25 and finds no brick', () => {
  const { found } = brickScene({ wall: 'flat' });
  assert.ok(found.nKept > 0);
  assert.ok(found.bestScore < STRONG_SCORE, `best score ${found.bestScore}`);
  assert.equal(found.found, false);
  const scale = brickScale(found, { Zu: 1.2, aspectHW: 2.5, revealMm: 0 });
  assert.equal(scale.regional.gateOk, false);
  assert.deepEqual(scale.snap, []);
});

test('brick: 165 mm weatherboard under AU86 is rejected by the height gate', () => {
  const { found, rect } = brickScene({ wall: 'weatherboard' });
  assert.equal(found.found, true);
  const scale = brickScale(found, { Zu: Math.abs(dot(rect.r3, rect.t)), aspectHW: rect.aspectHW, revealMm: 0, regionId: 'AU86', sigmaLnAspect: 0.012 });
  assert.equal(scale.regional.gateOk, false);
  assert.ok(scale.regional.gate.includes('height_out_of_range'), scale.regional.gate.join(','));
  assert.ok(scale.regional.H < HEIGHT_GATE_MM[0], `H ${scale.regional.H}`);
});

test('brick: a corner dot 40 px off is caught by the halves check', () => {
  const { found, rect } = brickScene({ shiftTL: [40, 40] });
  assert.equal(found.found, true);
  const halves = Math.max(found.agreeLRPct || 0, found.agreeTBPct || 0);
  assert.ok(halves > 5, `halves differ ${halves} %`);
  const scale = brickScale(found, { Zu: Math.abs(dot(rect.r3, rect.t)), aspectHW: rect.aspectHW, revealMm: 0 });
  assert.ok(scale.checks.some((c) => c === 'left_right_disagree' || c === 'top_bottom_disagree'), scale.checks.join(','));
  assert.equal(scale.regional.gateOk, false);
});

test('brick: on a pulse train the periodogram picks the fundamental, not 2x', () => {
  // A plain pulse train has every harmonic about as strong as the fundamental, which is what trips a plain
  // periodogram into picking 2x; the mortar-like pair (both edges of a 10 mm joint in an 86 mm course) too.
  for (const period of [70.3, 41.7, 96.2]) {
    const single = Float64Array.from({ length: 1439 }, (_, i) => ((i + 0.37) % period < 2 ? 1 : 0));
    const joint = (10 / 86) * period;
    const pair = Float64Array.from({ length: 1439 }, (_, i) => {
      const ph = (i + 0.37) % period;
      return (ph < 1.5 ? 1 : 0) + (Math.abs(ph - joint) < 0.75 ? 1 : 0);
    });
    for (const prof of [single, pair]) {
      const r = harmonicPeriod(prof, PMIN, PMAX);
      assert.ok(Math.abs(r.period / period - 1) < 0.005, `period ${period}: found ${r.period}`);
      assert.ok(r.score > STRONG_SCORE);
    }
  }
  assert.ok(PMIN < 70.3 / 2 && PMAX > 70.3 * 2 - 1);
  assert.equal(SPU, 1500);
});

// ---------------------------------------------------------------------------------------------------------
// stats.js
// ---------------------------------------------------------------------------------------------------------

test('stats: p50 and p90 match hand-computed values', () => {
  const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
  assert.equal(percentile(ten, 50), 5.5);
  assert.ok(Math.abs(percentile(ten, 90) - 9.1) < 1e-12);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([10, 20], 90), 19);
  assert.ok(Number.isNaN(percentile([], 50)));
  const s = errorStats([-3, 1, 2, -10, NaN]);
  assert.equal(s.n, 4);
  assert.equal(s.p50, 2.5);
  assert.ok(Math.abs(s.p90 - 7.9) < 1e-12);
  assert.equal(s.biasMedian, -1);
  assert.equal(s.biasMean, -2.5);
});

const QUAD = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 850 }, { x: 100, y: 850 }];

test('stats: methods gate and score rows against the door truth', () => {
  const row = {
    route: 'files',
    doorId: 'D1',
    corners: QUAD,
    cornersSource: 'moved',
    aspectHW: 2040 / 820,
    maker: { present: true, apple: true, afDepthRaw: 250 },
    afReading: { valid: true },
    af: { valid: true, inside: true, nT: 1.2, nX: { axial: 1.2 * 2050 + 20, range: 1.2 * 2030 + 20 }, setbackMm: 20 },
    brick: { checks: [], periodUnits: 86 / 2040, Zu: 1.2, courseMm: 86, revealMm: 0 },
    catalogue: { aspect: { w: 820, h: 2040 }, af: { w: 820, h: 2040 }, brick: { w: 820, h: 2040 } },
  };
  const truth = { wMm: 820, hMm: 2040, setbackMm: 20, revealMm: 0, courses10Mm: 860, wall: 'brick' };
  assert.ok(Math.abs(methodEstimate(row, truth, 'af_axial').H - 2050) < 1e-9);
  assert.ok(Math.abs(methodEstimate(row, truth, 'af_range').H - 2030) < 1e-9);
  assert.ok(Math.abs(methodEstimate(row, truth, 'brick').H - 2040) < 1e-9);
  assert.equal(methodEstimate(row, { wMm: 820, hMm: 2040 }, 'af_range_true_s'), null);
  const errors = Object.fromEntries(rowErrors(row, truth).map((e) => [e.id, e]));
  assert.ok(Math.abs(errors.af_axial.eH - 10) < 1e-9);
  assert.ok(Math.abs(errors.brick_true_course.eH) < 1e-9);
  const outside = { ...row, af: { ...row.af, inside: false } };
  assert.equal(methodEstimate(outside, truth, 'af_range').reason, 'af_point_outside_opening');
  const board = { ...row, doorId: 'D2', brick: { ...row.brick, periodUnits: 165 / 2040 } };
  assert.equal(methodEstimate(board, truth, 'brick').reason, 'height_out_of_range');

  const summary = sessionSummary([row, outside, board, { route: 'takephoto', maker: { present: false } }], {
    D1: truth,
    D2: { ...truth, wall: 'other' },
  });
  const files = summary.routes.find((r) => r.id === 'files');
  assert.equal(files.n, 3);
  assert.equal(files.makerPct, 100);
  assert.equal(summary.routes.find((r) => r.id === 'takephoto').makerPct, 0);
  const af = summary.methods.find((m) => m.id === 'af_axial');
  assert.equal(af.applicable, 3);
  assert.equal(af.gated, 1);
  assert.equal(af.H.n, 2);
  const brick = summary.methods.find((m) => m.id === 'brick');
  assert.equal(brick.applicable, 2); // the weatherboard door is judged by the gate check instead
  assert.equal(summary.go.brick.nonBrickPhotos, 1);
  assert.equal(summary.go.brick.nonBrickCaughtPct, 100);
  // Files keeps 0x0038 here, but that is not a route a customer takes: it is listed apart.
  assert.deepEqual(summary.go.af.depthSurvivesOn, []);
  assert.deepEqual(summary.go.af.depthSurvivesOnEffort, ['files']);
  assert.equal(summary.go.af.go, false);
  assert.match(summary.go.af.verdict, /only through Files/);
});

// ---------------------------------------------------------------------------------------------------------
// stats.js: which rows count, one value per door, brick coverage, per-phone calibration
// ---------------------------------------------------------------------------------------------------------

/** A synthetic row whose AF-depth H is exactly `H` mm (s = 0) and whose brick H is `brickH` mm. */
function synthRow({ door, H = 2040, W = 820, brickH = 2040, route = 'library', phone = 'iPhone 15 Pro', source = 'moved', checked, brickChecks = [] }) {
  const nT = 1.2;
  const row = {
    route,
    doorId: door,
    corners: QUAD,
    cornersSource: source,
    exif: { model: phone, focal35: 24 },
    aspectHW: H / W,
    maker: { present: true, apple: true, afDepthRaw: 250 },
    afReading: { valid: true },
    af: { valid: true, inside: true, nT, nX: { axial: nT * H, range: nT * H }, setbackMm: 0 },
    brick: { checks: brickChecks, periodUnits: 86 / brickH, Zu: 1.2, courseMm: 86, revealMm: 0 },
    catalogue: { aspect: { w: 820, h: 2040 }, af: { w: 820, h: 2040 }, brick: { w: 820, h: 2040 } },
  };
  if (checked !== undefined) row.cornersChecked = checked;
  return row;
}

test('stats: only rows with confirmed corners count, and the rest are reported', () => {
  assert.equal(cornersConfirmed(synthRow({ door: 'A', source: 'moved' })), true);
  assert.equal(cornersConfirmed(synthRow({ door: 'A', source: 'moved', checked: false })), false);
  assert.equal(cornersConfirmed(synthRow({ door: 'A', source: 'detected' })), false);
  assert.equal(cornersConfirmed(synthRow({ door: 'A', source: 'detected', checked: true })), true);
  assert.equal(cornersConfirmed(synthRow({ door: 'A', source: 'default', checked: true })), false);
  assert.equal(cornersConfirmed({ ...synthRow({ door: 'A' }), corners: null }), false);

  const truth = { wMm: 820, hMm: 2040, wall: 'brick' };
  // The middle box gives a valid but wrong H (2500): it must not reach the statistics.
  const rows = [
    synthRow({ door: 'A', H: 2050 }),
    synthRow({ door: 'B', H: 2500, source: 'default' }),
    synthRow({ door: 'C', H: 2600, source: 'detected' }),
    synthRow({ door: 'D', H: 2030, source: 'detected', checked: true }),
  ];
  const s = sessionSummary(rows, { A: truth, B: truth, C: truth, D: truth });
  assert.equal(s.counted, 2);
  assert.equal(s.leftOut.rows, 2);
  assert.deepEqual(s.leftOut.bySource, { default: 1, detected: 1 });
  const af = s.methods.find((m) => m.id === 'af_range');
  assert.equal(af.applicable, 2);
  assert.equal(af.doors, 2);
  assert.ok(af.H.p90 <= 10 + 1e-9, `H p90 ${af.H.p90}`);
});

test('stats: several photos of one door count once (the median of their errors)', () => {
  const truth = { wMm: 820, hMm: 2040, wall: 'brick' };
  // Door A given through Library and Files (+60 each), door B once (+10): two doors, not three photos.
  const rows = [
    synthRow({ door: 'A', H: 2100, route: 'library' }),
    synthRow({ door: 'A', H: 2100, route: 'files' }),
    synthRow({ door: 'B', H: 2050 }),
  ];
  const af = sessionSummary(rows, { A: truth, B: truth }).methods.find((m) => m.id === 'af_range');
  assert.equal(af.applicable, 3);
  assert.equal(af.doors, 2);
  assert.equal(af.H.n, 2);
  assert.ok(Math.abs(af.H.p50 - 35) < 1e-9, `p50 ${af.H.p50}`);
  // Two photos of one door with different errors give their median.
  const two = sessionSummary([synthRow({ door: 'A', H: 2060 }), synthRow({ door: 'A', H: 2080 })], { A: truth });
  assert.ok(Math.abs(two.methods.find((m) => m.id === 'af_range').H.biasMedian - 30) < 1e-9);
});

test('stats: brick GO counts only walls marked brick, and gates on the share of brick doors gated out', () => {
  const R = GO_RULES;
  const truths = {};
  const rows = [];
  for (let i = 0; i < R.brickDoors; i++) {
    truths[`B${i}`] = { wMm: 820, hMm: 2040, wall: 'brick' };
    rows.push(synthRow({ door: `B${i}`, brickH: 2040 + (i % 3) * 5 }));
  }
  for (let i = 0; i < R.nonBrickDoors; i++) {
    truths[`N${i}`] = { wMm: 820, hMm: 2040, wall: 'other' };
    rows.push(synthRow({ door: `N${i}`, brickChecks: ['no_brick'] }));
  }
  const pass = sessionSummary(rows, truths).go.brick;
  assert.equal(pass.go, true, pass.verdict);
  assert.equal(pass.verdict, 'GO');
  assert.equal(pass.doorsGatedPct, 0);

  // Walls with no type set are not brick doors: with them alone the brick GO has nothing to count.
  const unsaid = Object.fromEntries(Object.entries(truths).map(([k, t]) => [k, t.wall === 'brick' ? { ...t, wall: undefined } : t]));
  const none = sessionSummary(rows, unsaid);
  assert.equal(none.go.brick.doorsMeasured, 0);
  assert.equal(none.go.brick.go, false);
  assert.equal(none.methods.find((m) => m.id === 'brick').applicable, 0);

  // The same 15 passing doors plus 10 brick doors whose every photo was gated out: 40 % gated, NO-GO.
  const more = [...rows];
  const moreTruths = { ...truths };
  for (let i = 0; i < 10; i++) {
    moreTruths[`G${i}`] = { wMm: 820, hMm: 2040, wall: 'brick' };
    more.push(synthRow({ door: `G${i}`, brickChecks: ['no_strong_band'] }));
  }
  const gated = sessionSummary(more, moreTruths).go.brick;
  assert.equal(gated.doorsMeasured, R.brickDoors);
  assert.equal(gated.brickDoors, R.brickDoors + 10);
  assert.ok(Math.abs(gated.doorsGatedPct - 40) < 1e-9);
  assert.equal(gated.go, false);
  assert.equal(gated.verdict, 'NO-GO on these numbers');
});

test('stats: a constant per-phone scale error fails raw but passes after the leave-one-door-out constant', () => {
  const truths = {};
  const rows = [];
  // 12 doors on one phone, H read 3 % high (a rounded focal, say) with +-10 mm scatter: raw p90 about 70 mm.
  for (let i = 0; i < 12; i++) {
    const hMm = 2000 + 10 * i;
    truths[`D${i}`] = { wMm: 820, hMm, wall: 'brick' };
    rows.push(synthRow({ door: `D${i}`, H: hMm * 1.03 + (i % 2 ? 10 : -10), W: 820 * 1.03 }));
  }
  const s = sessionSummary(rows, truths);
  const af = s.methods.find((m) => m.id === 'af_range');
  assert.ok(af.H.p90 > GO_RULES.afHp90, `raw p90 ${af.H.p90}`);
  assert.equal(af.calibrated.doors, 12);
  assert.ok(af.calibrated.H.p90 < 20, `calibrated p90 ${af.calibrated.H.p90}`);
  assert.equal(s.afCalibration.byPhone.length, 1);
  assert.equal(s.afCalibration.byPhone[0].phone, 'iPhone 15 Pro');
  assert.ok(Math.abs(s.afCalibration.byPhone[0].ratio.range - 1.03) < 0.006);
  // And the go/no-go says so, as long as a customer route keeps the depth (these rows are Library rows).
  assert.deepEqual(s.go.af.methodsPassing, []);
  assert.deepEqual(s.go.af.methodsPassingCalibrated.sort(), ['af_axial', 'af_range']);
  assert.equal(s.go.af.go, true);
  assert.match(s.go.af.verdict, /per-phone scale constant/);
  // A phone with a single door has nothing to calibrate against.
  const lone = sessionSummary([synthRow({ door: 'X', H: 2100, phone: 'iPhone 12 Pro' })], { X: { wMm: 820, hMm: 2040 } });
  assert.equal(lone.methods.find((m) => m.id === 'af_range').calibrated.doors, 0);
});

test('stats: the implied depth unit is raw needed x 10 / raw given, not its inverse', () => {
  const cam = exactCamera({ dist: 2600, yaw: 10, pitch: -6, roll: 1 });
  const p = { x: cam.K.cx, y: cam.K.cy };
  const s = 20;
  for (const model of ['range', 'axial']) {
    const trueMm = trueDepth(cam, p, s)[model];
    // Suppose the raw value were really in 5 mm steps: the photo would say trueMm / 5.
    const rawGiven = trueMm / 5;
    const r = analyseAfDepth({ corners: cam.corners, K: cam.K, point: p, afDepthRaw: rawGiven, afConfidence: 1, setbackMm: s });
    const needed = rawForHeight(r.geom, model, DOOR.H, s);
    assert.ok(Math.abs(impliedRawUnitMm(rawGiven, needed) - 5) < 1e-9);
    // The same figure straight from the stored row.
    const row = { af: { valid: true, inside: true, nT: r.nT, nX: { [model]: r.models[model].nXmm }, setbackMm: s } };
    assert.ok(Math.abs(afImpliedUnit(row, { wMm: DOOR.W, hMm: DOOR.H, setbackMm: s }, model) - 5) < 1e-9);
  }
  assert.ok(Number.isNaN(impliedRawUnitMm(0, 10)));
  assert.ok(Math.abs(focalRoundingPct(24) - 50 / 24) < 1e-12);
  assert.ok(Number.isNaN(focalRoundingPct(null)));
});

test('stats: video-frame rows count as their own route, and the route groups are disjoint', () => {
  assert.equal(rowRoute({ route: 'inpage', capture: 'frame' }), 'inpage_frame'); // a row saved before the change
  assert.equal(rowRoute({ route: 'inpage', capture: 'frame', metaFrom: 'still' }), 'inpage'); // still kept, corners on the frame
  assert.equal(rowRoute({ route: 'inpage_frame', capture: 'frame', metaFrom: 'frame' }), 'inpage_frame');
  assert.equal(rowRoute({ route: 'inpage', capture: 'live', metaFrom: 'still' }), 'inpage');
  const ids = ROUTES.map((r) => r.id);
  for (const id of [...CUSTOMER_ROUTES, ...EFFORT_ROUTES]) assert.ok(ids.includes(id), id);
  assert.ok(!CUSTOMER_ROUTES.includes('files'));
  assert.ok(!CUSTOMER_ROUTES.includes('inpage_frame'));
  for (const id of ['library_heic', 'library_any']) assert.ok(CUSTOMER_ROUTES.includes(id));
  const s = sessionSummary([
    { route: 'inpage', capture: 'frame', maker: { present: false } },
    { route: 'inpage', capture: 'live', metaFrom: 'still', maker: { present: true, apple: true, afDepthRaw: 250 }, afReading: { valid: true } },
  ], {});
  const inpage = s.routes.find((r) => r.id === 'inpage');
  assert.equal(inpage.n, 1);
  assert.equal(inpage.makerPct, 100);
  assert.equal(s.routes.find((r) => r.id === 'inpage_frame').n, 1);
  assert.deepEqual(s.go.af.depthSurvivesOn, ['inpage']);
});

// ---------------------------------------------------------------------------------------------------------
// brick.js: the course a band implies
// ---------------------------------------------------------------------------------------------------------

test('brick: the course a period implies takes the reveal off (inverse of heightFromCourse)', () => {
  for (const [course, reveal, Zu] of [[86, 125, 1.2], [76, 0, 1.5], [86, 55, 0.9]]) {
    const p = 0.0421;
    const H = heightFromCourse(course, p, reveal, Zu);
    assert.ok(Math.abs(courseFromPeriod(p, H, reveal, Zu) - course) < 1e-9);
  }
  // p x H alone (the old "mm/course") reads a 125 mm reveal at Zu 1.2 about 5 % large.
  const H = heightFromCourse(86, 0.0421, 125, 1.2);
  assert.ok(0.0421 * H / 86 - 1 > 0.04);
});

// ---------------------------------------------------------------------------------------------------------
// meta.js: several Exif items in one HEIF
// ---------------------------------------------------------------------------------------------------------

/** A HEIF with several items; `items` with a `payload` get an iloc extent, `refs` go in an iref box. */
function heifItems(items, { primary = 1, refs = [] } = {}) {
  const ftyp = box('ftyp', 'heic', u32be(0), 'mif1', 'heic');
  const hdlr = box('hdlr', u32be(0), u32be(0), 'pict', u32be(0), u32be(0), u32be(0), [0]);
  const infe = (id, type) => box('infe', [2, 0, 0, 0], u16be(id), u16be(0), type, [0]);
  const iinf = box('iinf', [0, 0, 0, 0], u16be(items.length), ...items.map((it) => infe(it.id, it.type)));
  const pitm = box('pitm', [0, 0, 0, 0], u16be(primary));
  const iref = refs.length
    ? box('iref', [0, 0, 0, 0], ...refs.map((r) => box(r.type, u16be(r.from), u16be(r.to.length), ...r.to.map((t) => u16be(t)))))
    : new Uint8Array(0);
  const stored = items.filter((it) => it.payload);
  const iloc = (base) => {
    let at = base;
    const entries = stored.map((it) => {
      const e = cat(u16be(it.id), u16be(0), u16be(0), u16be(1), u32be(at), u32be(it.payload.length));
      at += it.payload.length;
      return e;
    });
    return box('iloc', [1, 0, 0, 0], [0x44, 0x00], u16be(stored.length), ...entries);
  };
  const metaFor = (base) => box('meta', [0, 0, 0, 0], hdlr, pitm, iinf, iref, iloc(base));
  const base = ftyp.length + metaFor(0).length + 8;
  return cat(ftyp, metaFor(base), box('mdat', ...stored.map((it) => it.payload)));
}

const exifPayload = (tiffBytes) => cat(u32be(6), 'Exif\0\0', tiffBytes);

test('meta: with several Exif items, the one linked to the primary item is read and all are listed', () => {
  // Item 2: Exif for the gain map (item 5), no MakerNote, listed first. Item 3: Exif for the primary item 1.
  const items = [
    { id: 1, type: 'hvc1' },
    { id: 5, type: 'hvc1' },
    { id: 2, type: 'Exif', payload: exifPayload(tiff(false, { makerNote: null })) },
    { id: 3, type: 'Exif', payload: exifPayload(tiff(false)) },
  ];
  const refs = [{ type: 'cdsc', from: 2, to: [5] }, { type: 'cdsc', from: 3, to: [1] }];
  const meta = parseMeta(heifItems(items, { primary: 1, refs }));
  assertApple(meta, 'heif');
  assert.ok(meta.warnings.some((w) => /2 Exif item\(s\)/.test(w) && /item 3 was read/.test(w) && /describes item 5/.test(w)), meta.warnings.join(' | '));
  assert.ok(meta.warnings.some((w) => /Exif item 2 \(not read\): no Apple MakerNote/.test(w)), meta.warnings.join(' | '));

  // The other way round: the first item describes the primary; the second's MakerNote is reported.
  const swapped = parseMeta(heifItems(items, { primary: 1, refs: [{ type: 'cdsc', from: 2, to: [1] }, { type: 'cdsc', from: 3, to: [5] }] }));
  assert.equal(swapped.maker.present, false);
  assert.ok(swapped.warnings.some((w) => /Exif item 3 \(not read\): Apple MakerNote with 4 tags, 0x0038 = 250/.test(w)), swapped.warnings.join(' | '));

  // No iref at all: the first Exif item, with a warning naming both.
  const unlinked = parseMeta(heifItems(items, { primary: 1 }));
  assert.equal(unlinked.maker.present, false);
  assert.ok(unlinked.warnings.some((w) => /none describes the primary item/.test(w)));

  // A single Exif item for the primary image gives no extra warning.
  const single = parseMeta(heifItems([{ id: 1, type: 'hvc1' }, { id: 3, type: 'Exif', payload: exifPayload(tiff(true)) }], { primary: 1, refs: [{ type: 'cdsc', from: 3, to: [1] }] }));
  assertApple(single, 'heif');
  assert.ok(!single.warnings.some((w) => /Exif item/.test(w)), single.warnings.join(' | '));

  // Cut short anywhere, it still never throws.
  const bytes = heifItems(items, { primary: 1, refs });
  for (let n = 0; n <= bytes.length; n += 3) assert.equal(typeof parseMeta(bytes.slice(0, n)).container, 'string');
});
