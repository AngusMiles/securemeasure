/**
 * The floor-anchored WebXR measuring maths (js/xr-measure.js), against synthetic poses and door openings
 * with exact ground truth (tests/helpers/xr.mjs). Ported unchanged from the research prototype's tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UP,
  vec3,
  dot,
  sub,
  add,
  scale,
  length,
  normalize,
  rotateByQuaternion,
  surfaceNormalFromQuaternion,
  rigidMatrix,
  transformPoint,
  multiplyMatrices,
  invertMatrix,
  rayFromPoseMatrix,
  cssToNdc,
  ndcToCss,
  viewDirectionFromNdc,
  rayThroughNdc,
  planeFromPointNormal,
  intersectRayPlane,
  tiltDeg,
  isUpwardHorizontal,
  doorPlaneFromBase,
  toPlaneCoords,
  aimPoint,
  measureOpening,
  medianPoint,
  estimateFloorY,
  combineRuns,
  projectToCss,
  projectSegmentToCss,
} from '../js/xr-measure.js';
import { lookAtPose, rigidInverse, perspective, doorScene } from './helpers/xr.mjs';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a} (tol ${tol})`);
const closeVec = (a, b, tol, msg) => a.forEach((v, i) => close(v, b[i], tol, `${msg ?? ''}[${i}]`));

// Quaternion for a rotation of `deg` about unit `axis`.
const axisAngle = (axis, deg) => {
  const h = (deg * Math.PI) / 360;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
};

/* ------------------------------------------------------------------------------------------ */

test('vec3/quat accept DOMPoint-like objects', () => {
  assert.deepEqual(vec3({ x: 1, y: 2, z: 3, w: 1 }), [1, 2, 3]);
  assert.deepEqual(vec3(new Float32Array([4, 5, 6])), [4, 5, 6]);
  assert.ok(vec3(null).every(Number.isNaN));
});

test('rotateByQuaternion and rigidMatrix agree', () => {
  const q = axisAngle([0, 1, 0], 90);
  closeVec(rotateByQuaternion(q, [1, 0, 0]), [0, 0, -1], 1e-12);
  const q2 = axisAngle(normalize([1, 2, 3]), 37);
  const m = rigidMatrix([0.5, -1, 2], q2);
  const v = [0.3, -0.7, 1.1];
  closeVec(transformPoint(m, v), add(rotateByQuaternion(q2, v), [0.5, -1, 2]), 1e-12);
});

test('invertMatrix inverts rigid and projection matrices', () => {
  const m = rigidMatrix([1, 2, 3], axisAngle(normalize([0.2, 1, -0.4]), 63));
  const I = multiplyMatrices(m, invertMatrix(m));
  I.forEach((v, i) => close(v, i % 5 === 0 ? 1 : 0, 1e-12, `I[${i}]`));
  const p = perspective({ cx: 0.03, cy: -0.02 });
  const J = multiplyMatrices(invertMatrix(p), p);
  J.forEach((v, i) => close(v, i % 5 === 0 ? 1 : 0, 1e-9, `J[${i}]`));
  assert.equal(invertMatrix(new Array(16).fill(0)), null);
});

test('surface normal of a hit pose is its +Y axis', () => {
  closeVec(surfaceNormalFromQuaternion([0, 0, 0, 1]), [0, 1, 0], 1e-12);
  // A wall facing +Z: +Y rotated 90 degrees about +X.
  closeVec(surfaceNormalFromQuaternion(axisAngle([1, 0, 0], 90)), [0, 0, 1], 1e-12);
  close(tiltDeg([0, 0, 1]), 90, 1e-9);
  assert.equal(isUpwardHorizontal(surfaceNormalFromQuaternion(axisAngle([1, 0, 0], 8))), true);
  assert.equal(isUpwardHorizontal(surfaceNormalFromQuaternion(axisAngle([1, 0, 0], 20))), false);
  assert.equal(isUpwardHorizontal([0, -1, 0]), false); // ceiling
});

test('rayFromPoseMatrix: -Z of the viewer pose', () => {
  const pose = lookAtPose([0, 1.4, 2], [0, 1.4, 0]);
  const r = rayFromPoseMatrix(pose);
  closeVec(r.origin, [0, 1.4, 2], 1e-12);
  closeVec(r.direction, [0, 0, -1], 1e-12);
});

test('intersectRayPlane: hit, parallel, behind, grazing', () => {
  const plane = planeFromPointNormal([0, 0, 0], [0, 0, 1]);
  const hit = intersectRayPlane({ origin: [0.2, 1, 2], direction: [0, 0, -1] }, plane);
  closeVec(hit.point, [0.2, 1, 0], 1e-12);
  close(hit.t, 2, 1e-12);
  close(hit.cos, 1, 1e-12);
  assert.equal(intersectRayPlane({ origin: [0, 1, 2], direction: [1, 0, 0] }, plane), null, 'parallel');
  assert.equal(intersectRayPlane({ origin: [0, 1, 2], direction: [0, 0, 1] }, plane), null, 'behind');
  const grazing = { origin: [0, 1, 2], direction: normalize([1, 0, -0.05]) };
  assert.ok(intersectRayPlane(grazing, plane), 'grazing allowed by default');
  assert.equal(intersectRayPlane(grazing, plane, { minCos: 0.26 }), null, 'grazing rejected');
  assert.equal(intersectRayPlane({ origin: [0, 1, 2], direction: [0, 0, -1] }, plane, { maxT: 1.5 }), null, 'too far');
});

test('doorPlaneFromBase: vertical plane through both base corners, facing the viewer', () => {
  // Floor slopes: BR is 15 mm higher than BL.
  const bl = [0.1, 0.0, -1.0];
  const br = [0.85, 0.015, -1.3];
  const viewer = [0.5, 1.4, 0.8];
  const plane = doorPlaneFromBase(bl, br, { towards: viewer });
  close(dot(plane.normal, UP), 0, 1e-12, 'vertical');
  close(dot(plane.normal, br) + plane.d, 0, 1e-12, 'contains BR');
  close(dot(plane.normal, bl) + plane.d, 0, 1e-12, 'contains BL');
  assert.ok(dot(plane.normal, sub(viewer, bl)) > 0, 'faces viewer');
  close(plane.baseLengthM, Math.hypot(0.75, 0.3), 1e-12);
  const [x, y] = toPlaneCoords(plane, br);
  close(x, plane.baseLengthM, 1e-12);
  close(y, 0.015, 1e-12);
  assert.equal(doorPlaneFromBase(bl, [0.15, 0.5, -1.0]), null, 'degenerate: corners stacked vertically');
});

test('measureOpening: exact corners of a rotated, offset door give exact size', () => {
  for (const yawDeg of [0, 37, -120, 179]) {
    const d = doorScene({ widthM: 0.82, heightM: 2.04, floorY: -1.31, yawDeg, centre: [0.4, 0, -2.2] });
    const m = measureOpening({ ...d, towards: add(d.bl, d.normal) });
    close(m.widthMm, 820, 1e-6, `width yaw ${yawDeg}`);
    close(m.heightMm, 2040, 1e-6, `height yaw ${yawDeg}`);
    close(m.diagonalDiffMm, 0, 1e-6);
    assert.deepEqual(m.warnings, []);
    assert.equal(m.ok, true);
    assert.ok(dot(m.plane.normal, d.normal) > 0.999, 'plane normal faces outward');
  }
});

test('measureOpening flags inconsistent corners', () => {
  const d = doorScene({ widthM: 0.82, heightM: 2.04 });
  const tr = add(d.tr, [0.08, 0.09, 0]); // TR put on the architrave: 80 mm right, 90 mm up
  const m = measureOpening({ ...d, tr });
  const small = measureOpening({ ...d, tr: add(d.tr, [0.02, 0.02, 0]) }); // ordinary aim noise
  assert.equal(small.ok, true, 'ordinary noise is not a blunder');
  assert.ok(m.warnings.includes('widths_disagree'));
  assert.ok(m.warnings.includes('heights_disagree'));
  assert.ok(m.warnings.includes('out_of_square'));
  assert.equal(m.ok, false);
  const off = measureOpening({ ...d, tl: add(d.tl, [0, 0, 0.05]) });
  assert.ok(off.warnings.includes('off_plane'));
  const tiny = measureOpening({ ...doorScene({ widthM: 0.3, heightM: 0.6 }) });
  assert.ok(tiny.warnings.includes('implausible_size'));
  assert.equal(measureOpening({ bl: [0, 0, 0], br: [0, 0.01, 0], tl: [0, 2, 0], tr: [0, 2, 0] }), null);
});

test('end to end: floor hits for the base, ray-plane for the top, from four different poses', () => {
  const d = doorScene({ widthM: 0.87, heightM: 2.1, floorY: -1.35, yawDeg: 12, centre: [0.1, 0, -1.9] });
  const floor = planeFromPointNormal([0, -1.35, 0], UP); // what the hit test reports
  const eyes = [
    [-0.2, 0.05, 0.1],
    [0.35, 0.0, 0.05],
    [0.0, 0.1, 0.2],
    [0.25, 0.08, 0.15],
  ];
  // Bottom corners: the reticle ray hits the floor plane (simulated hit-test result).
  const bottom = (eye, target) => {
    const ray = rayFromPoseMatrix(lookAtPose(eye, target));
    const h = intersectRayPlane(ray, floor);
    return aimPoint({ step: 'bl', ray, hit: { position: h.point, normal: UP } });
  };
  const bl = bottom(eyes[0], d.bl);
  assert.equal(bl.ok, true);
  const rayBR = rayFromPoseMatrix(lookAtPose(eyes[1], d.br));
  const hBR = intersectRayPlane(rayBR, floor);
  const br = aimPoint({ step: 'br', ray: rayBR, hit: { position: hBR.point, orientation: [0, 0, 0, 1] }, bl: bl.point });
  assert.equal(br.ok, true, br.reason);
  const plane = doorPlaneFromBase(bl.point, br.point, { towards: eyes[1] });
  const tl = aimPoint({ step: 'tl', ray: rayFromPoseMatrix(lookAtPose(eyes[2], d.tl)), plane });
  const tr = aimPoint({ step: 'tr', ray: rayFromPoseMatrix(lookAtPose(eyes[3], d.tr)), plane });
  assert.equal(tl.ok, true, tl.reason);
  assert.equal(tr.ok, true, tr.reason);
  closeVec(tl.point, d.tl, 1e-9, 'TL');
  closeVec(tr.point, d.tr, 1e-9, 'TR');
  const m = measureOpening({ bl: bl.point, br: br.point, tl: tl.point, tr: tr.point, towards: eyes[3] });
  close(m.widthMm, 870, 1e-6);
  close(m.heightMm, 2100, 1e-6);
  assert.equal(m.ok, true);
});

test('aimPoint guard rails', () => {
  const ray = { origin: [0, 0, 1.5], direction: normalize([0, -1.3, -1.5]) };
  assert.equal(aimPoint({ step: 'bl', ray, hit: { position: [0, -1.3, 0], normal: [0, 0, 1] } }).reason, 'not_floor');
  assert.equal(aimPoint({ step: 'bl', ray }).reason, 'no_surface');
  const viaFloor = aimPoint({ step: 'bl', ray, floorY: -1.3 });
  assert.equal(viaFloor.ok, true);
  assert.equal(viaFloor.source, 'floor');
  closeVec(viaFloor.point, [0, -1.3, 0], 1e-12);
  assert.equal(aimPoint({ step: 'bl', ray, hit: { position: [0, -1.3, -6] } }).reason, 'too_far');
  const bl = [0, -1.3, 0];
  assert.equal(aimPoint({ step: 'br', ray, hit: { position: [0.2, -1.3, 0] }, bl }).reason, 'too_narrow');
  assert.equal(aimPoint({ step: 'br', ray, hit: { position: [2.5, -1.3, 0] }, bl }).reason, 'too_wide');
  assert.equal(aimPoint({ step: 'br', ray, hit: { position: [0.8, -1.2, 0] }, bl }).reason, 'not_level');
  assert.equal(aimPoint({ step: 'br', ray, hit: { position: [0.8, -1.3, 0] } }).reason, 'need_bl');

  const plane = doorPlaneFromBase(bl, [0.82, -1.3, 0], { towards: [0.4, 0, 2] });
  assert.equal(aimPoint({ step: 'tl', ray, plane: null }).reason, 'no_plane');
  const up = (target) => ({ origin: [0.4, 0, 1.6], direction: normalize(sub(target, [0.4, 0, 1.6])) });
  assert.equal(aimPoint({ step: 'tl', ray: up([0, 0.74, 0]), plane }).ok, true);
  assert.equal(aimPoint({ step: 'tl', ray: up([0, -0.5, 0]), plane }).reason, 'too_low');
  assert.equal(aimPoint({ step: 'tl', ray: up([0, 2.5, 0]), plane }).reason, 'too_high');
  assert.equal(aimPoint({ step: 'tl', ray: up([-1.5, 0.74, 0]), plane }).reason, 'off_opening');
  assert.equal(aimPoint({ step: 'tl', ray: { origin: [0.4, 0, 1.6], direction: [0, 0, 1] }, plane }).reason, 'behind');
  const graze = { origin: [-3, 0.7, 0.3], direction: normalize([1, 0, -0.1]) };
  assert.equal(aimPoint({ step: 'tl', ray: graze, plane, limits: { maxDistanceM: 10 } }).reason, 'grazing');
  assert.equal(aimPoint({ step: 'xx', ray, plane }).reason, 'bad_step');
});

test('raised sill bias: aiming at a sill corner but hitting the porch floor overstates the size', () => {
  // Documents a real failure mode for the UI copy: the bottom hit must be ON the surface the
  // opening is measured from. Sill 30 mm above the porch, phone at 1.3 m, 1.5 m from the door.
  const sill = 0.03;
  const eyeY = 1.3;
  const d = doorScene({ widthM: 0.82, heightM: 2.04, floorY: sill, centre: [0.41, 0, 0] });
  const eye = [0.41, eyeY, 1.5];
  const porch = planeFromPointNormal([0, 0, 0], UP);
  const hitPorch = (target) => intersectRayPlane(rayFromPoseMatrix(lookAtPose(eye, target)), porch).point;
  const bl = hitPorch(d.bl);
  const br = hitPorch(d.br);
  const plane = doorPlaneFromBase(bl, br, { towards: eye });
  const top = (t) => intersectRayPlane(rayFromPoseMatrix(lookAtPose(eye, t)), plane).point;
  const m = measureOpening({ bl, br, tl: top(d.tl), tr: top(d.tr), towards: eye });
  // Hand calculation: floor hit lands k = eyeY / (eyeY - sill) = 1.0236 x further away, and the
  // height is then counted from the porch, not the sill:
  //   width  ~ 820 * k                       = +19 mm
  //   height ~ (2040 + 30 - 1300) * k + 1300 = 2088 mm, i.e. +48 mm
  const k = eyeY / (eyeY - sill);
  close(m.widthMm, 820 * k, 0.5);
  close(m.heightMm, ((2.04 + sill - eyeY) * k + eyeY) * 1000, 0.5);
  assert.ok(m.heightMm - 2040 > 40, 'a 30 mm sill costs > 40 mm of height');
});

test('raised sill fixed: base on the floor at the jamb foot, plus one sill tap', () => {
  const sill = 0.03;
  const eye = [0.41, 1.3, 1.5];
  const d = doorScene({ widthM: 0.82, heightM: 2.04, floorY: sill, centre: [0.41, 0, 0] });
  const porch = planeFromPointNormal([0, 0, 0], UP);
  const ray = (t) => rayFromPoseMatrix(lookAtPose(eye, t));
  // The user aims where each jamb meets the porch floor (sill face flush with the frame).
  const bl = intersectRayPlane(ray(sub(d.bl, [0, sill, 0])), porch).point;
  const br = intersectRayPlane(ray(sub(d.br, [0, sill, 0])), porch).point;
  const plane = doorPlaneFromBase(bl, br, { towards: eye });
  const s = aimPoint({ step: 'sill', ray: ray([0.41, sill, 0]), plane });
  assert.equal(s.ok, true, s.reason);
  const tl = aimPoint({ step: 'tl', ray: ray(d.tl), plane });
  const tr = aimPoint({ step: 'tr', ray: ray(d.tr), plane });
  const m = measureOpening({ bl, br, tl: tl.point, tr: tr.point, sill: s.point, towards: eye });
  close(m.widthMm, 820, 1e-6);
  close(m.heightMm, 2040, 1e-6);
  close(m.sillHeightMm, 30, 1e-6);
  assert.equal(m.ok, true);
  assert.equal(aimPoint({ step: 'sill', ray: ray([0.41, 0.6, 0]), plane }).reason, 'too_high');
});

test('cssToNdc / ndcToCss round trip', () => {
  const [nx, ny] = cssToNdc(100, 300, 400, 800);
  close(nx, -0.5, 1e-12);
  close(ny, 0.25, 1e-12);
  const [x, y] = ndcToCss(nx, ny, 400, 800);
  close(x, 100, 1e-9);
  close(y, 300, 1e-9);
});

test('viewDirectionFromNdc handles an off-centre projection; rayThroughNdc round-trips through projectToCss', () => {
  const P = perspective({ fovYDeg: 62, aspect: 1080 / 2340, cx: 0.04, cy: -0.03 });
  // The optical axis (-Z) projects to the principal point, not the screen centre.
  closeVec(viewDirectionFromNdc(P, 0.04, -0.03), [0, 0, -1], 1e-9);
  const pose = lookAtPose([0.2, 0.1, 1.2], [0.0, 0.6, -0.8]);
  const V = rigidInverse(pose);
  const W = 412;
  const H = 892;
  for (const [cssX, cssY] of [[W / 2, H / 2], [30, 50], [400, 880]]) {
    const [nx, ny] = cssToNdc(cssX, cssY, W, H);
    const ray = rayThroughNdc(pose, P, nx, ny);
    const pt = add(ray.origin, scale(ray.direction, 2.3));
    const s = projectToCss(V, P, pt, W, H);
    assert.equal(s.inFront, true);
    close(s.x, cssX, 1e-6);
    close(s.y, cssY, 1e-6);
  }
  // A point 1 m along the pose's -Z lands on the principal point: draw the crosshair there,
  // not at the CSS centre, so the drawn reticle matches the hit-test ray exactly.
  const fwd = add(rayFromPoseMatrix(pose).origin, rayFromPoseMatrix(pose).direction);
  const c = projectToCss(V, P, fwd, W, H);
  close(c.x, ((0.04 + 1) / 2) * W, 1e-6);
  close(c.y, ((1 + 0.03) / 2) * H, 1e-6);
});

test('projectToCss: centre, behind camera, off screen', () => {
  const pose = lookAtPose([0, 1.4, 2], [0, 1.4, 0]);
  const V = rigidInverse(pose);
  const P = perspective({ fovYDeg: 60, aspect: 0.5 });
  const centre = projectToCss(V, P, [0, 1.4, 0], 400, 800);
  close(centre.x, 200, 1e-9);
  close(centre.y, 400, 1e-9);
  assert.equal(centre.onScreen, true);
  assert.equal(projectToCss(V, P, [0, 1.4, 3], 400, 800).inFront, false);
  assert.equal(projectToCss(V, P, [5, 1.4, 0], 400, 800).onScreen, false);
});

test('projectSegmentToCss clips at the near plane', () => {
  const pose = lookAtPose([0, 0, 0], [0, 0, -1]);
  const V = rigidInverse(pose);
  const P = perspective({ fovYDeg: 60, aspect: 1 });
  assert.equal(projectSegmentToCss(V, P, [0, 0, 1], [0, 1, 2], 100, 100), null, 'fully behind');
  const s = projectSegmentToCss(V, P, [0.5, 0, -2], [0.5, 0, 1], 100, 100, 0.1);
  assert.ok(s, 'partly visible');
  assert.ok(Number.isFinite(s.a.x) && Number.isFinite(s.b.x));
  // The clipped end is the point at z = -0.1 on the segment: x = 0.5 in view space.
  const f = 1 / Math.tan(Math.PI / 6);
  close(s.b.x, ((0.5 * f) / 0.1 + 1) * 50, 1e-6);
  const both = projectSegmentToCss(V, P, [0, 0, -1], [0.1, 0, -2], 100, 100);
  close(both.a.x, 50, 1e-9);
});

test('medianPoint, estimateFloorY, combineRuns', () => {
  closeVec(medianPoint([[0, 0, 0], [1, 1, 1], [0.2, 0.1, 0.3], [9, 9, 9], [0.1, 0.2, 0.2]]), [0.2, 0.2, 0.3], 1e-12);
  assert.equal(medianPoint([]), null);
  const samples = [
    { position: [0, -1.31, 0], orientation: [0, 0, 0, 1] },
    { position: [0.3, -1.29, -0.2], normal: [0, 1, 0] },
    { position: [0.1, -1.30, 0.1] },
    { position: [0, 0.2, -1], normal: [0, 0, 1] }, // wall: ignored
  ];
  close(estimateFloorY(samples), -1.3, 1e-12); // median of -1.31, -1.29, -1.30; the wall hit is ignored
  assert.equal(estimateFloorY([{ position: [0, 0, 0], normal: [1, 0, 0] }]), null);
  const agree = combineRuns([{ widthMm: 818, heightMm: 2046 }, { widthMm: 826, heightMm: 2038 }]);
  assert.equal(agree.agree, true);
  close(agree.widthMm, 822, 1e-12);
  const disagree = combineRuns([{ widthMm: 818, heightMm: 2046 }, { widthMm: 860, heightMm: 2120 }]);
  assert.equal(disagree.agree, false);
  assert.equal(combineRuns([{ widthMm: 820, heightMm: 2040 }]).agree, false, 'one run cannot self-check');
  assert.equal(combineRuns([]), null);
});

test('length/normalize sanity', () => {
  close(length([3, 4, 12]), 13, 1e-12);
  assert.equal(normalize([0, 0, 0]), null);
});
