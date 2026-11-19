// Test/simulation helpers: synthetic camera poses, projection matrices and a door opening with exact
// ground truth, all in a WebXR-style 'local' space (+Y up, metres, column-major matrices).
// Used by tests/xr-measure.test.mjs (and free for the AR flow tests to reuse).

import { normalize, cross, sub, add, scale } from '../../js/xr-measure.js';

/**
 * Camera-to-world (pose) matrix for a camera at `eye` looking at `target` (-Z forward, +Y up-ish),
 * i.e. what viewerPose.transform.matrix would be.
 */
export function lookAtPose(eye, target, worldUp = [0, 1, 0]) {
  const f = normalize(sub(target, eye)); // forward = -Z
  const z = scale(f, -1);
  const x = normalize(cross(worldUp, z));
  const y = cross(z, x);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, eye[0], eye[1], eye[2], 1];
}

/** Rigid inverse of a pose matrix (world -> view), i.e. view.transform.inverse.matrix. */
export function rigidInverse(m) {
  // R^T and -R^T t
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0];
  const t = [m[12], m[13], m[14]];
  const tx = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]);
  const ty = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]);
  const tz = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
  return [r[0], r[1], r[2], 0, r[4], r[5], r[6], 0, r[8], r[9], r[10], 0, tx, ty, tz, 1];
}

/**
 * OpenGL-style off-axis perspective (column-major), like XRView.projectionMatrix on a phone:
 * vertical FOV, aspect, optional principal-point shift in NDC units (cx, cy).
 */
export function perspective({ fovYDeg = 60, aspect = 9 / 19.5, near = 0.1, far = 1000, cx = 0, cy = 0 } = {}) {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    -cx, -cy, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ];
}

/**
 * A door opening standing on the floor (y = floorY) in an arbitrary place/orientation.
 * yawDeg rotates the door about +Y; the opening's outward normal faces +Z before rotation.
 * Returns exact corners and the plane-facing direction.
 */
export function doorScene({ widthM = 0.82, heightM = 2.04, floorY = 0, yawDeg = 0, centre = [0, 0, 0] } = {}) {
  const a = (yawDeg * Math.PI) / 180;
  const right = [Math.cos(a), 0, -Math.sin(a)];
  const normal = [Math.sin(a), 0, Math.cos(a)];
  const base = [centre[0], floorY, centre[2]];
  const bl = add(base, scale(right, -widthM / 2));
  const br = add(base, scale(right, widthM / 2));
  const tl = add(bl, [0, heightM, 0]);
  const tr = add(br, [0, heightM, 0]);
  return { bl, br, tl, tr, right, normal, widthM, heightM };
}

/** Deterministic PRNG (mulberry32) and a standard normal sampler. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = uniform();
    while (v === 0) v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return { uniform, normal };
}

/** Rotate a unit direction by a small random angle (sigmaDeg per axis, perpendicular to it). */
export function jitterDirection(dir, sigmaDeg, R) {
  if (!sigmaDeg) return dir;
  const helper = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalize(cross(dir, helper));
  const e2 = cross(dir, e1);
  const s = (sigmaDeg * Math.PI) / 180;
  return normalize(add(dir, add(scale(e1, Math.tan(s * R.normal())), scale(e2, Math.tan(s * R.normal())))));
}
