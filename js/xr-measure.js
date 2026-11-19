// Floor-anchored door-opening measurement maths for a WebXR 'immersive-ar' session.
//
// Pure functions only: no WebXR, DOM or WebGL objects. The page code copies numbers out of the
// WebXR objects and passes them in:
//   position  DOMPointReadOnly {x,y,z}   -> [x, y, z]      (or pass the {x,y,z} object, see vec3())
//   rotation  DOMPointReadOnly {x,y,z,w} -> [x, y, z, w]   (unit quaternion)
//   matrices  XRRigidTransform.matrix / XRView.projectionMatrix (Float32Array(16), COLUMN-major)
//
// Frame: the session's 'local' reference space. Units: metres in, millimetres out.
// WebXR reference spaces use +X right, +Y up, -Z forward. On Chrome/ARCore 'local' is the ARCore
// world space, whose +Y is up (against gravity), so UP = [0, 1, 0]. 'local-floor' on ARCore is only
// 'local' shifted down by a fixed 1.2 m guess, so never treat its y = 0 as the real floor.
//
// Method (see measureOpening):
//   1. BL, BR  = hit-test points on the floor at the bottom corners of the opening.
//   2. Door plane = the vertical plane through BL and BR (contains UP and the horizontal BL->BR).
//   3. TL, TR  = reticle ray from the viewer pose intersected with that plane (no hit-test needed).
//   4. Width   = horizontal distance in the plane, height = distance along UP.
//   (optional) SILL = ray-plane point on top of a raised sill; heights are then taken from it.

export const UP = Object.freeze([0, 1, 0]);

const EPS = 1e-9;
const DEG = Math.PI / 180;

/* ---------------------------------------------------------------- vectors ---------------------- */

/** Accept [x,y,z] or any {x,y,z} (e.g. DOMPointReadOnly) and return a plain [x,y,z] array. */
export function vec3(p) {
  if (Array.isArray(p) || ArrayBuffer.isView(p)) return [Number(p[0]), Number(p[1]), Number(p[2])];
  if (p && typeof p === 'object') return [Number(p.x), Number(p.y), Number(p.z)];
  return [NaN, NaN, NaN];
}

/** Accept [x,y,z,w] or {x,y,z,w} and return a plain [x,y,z,w] array. */
export function quat(q) {
  if (Array.isArray(q) || ArrayBuffer.isView(q)) return [Number(q[0]), Number(q[1]), Number(q[2]), Number(q[3])];
  if (q && typeof q === 'object') return [Number(q.x), Number(q.y), Number(q.z), Number(q.w)];
  return [NaN, NaN, NaN, NaN];
}

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const distance = (a, b) => length(sub(a, b));

/** Unit vector, or null for a (near) zero vector. */
export function normalize(a) {
  const n = length(a);
  return n > EPS ? [a[0] / n, a[1] / n, a[2] / n] : null;
}

const finite3 = (a) => Array.isArray(a) && a.length >= 3 && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

/* ---------------------------------------------------------------- rotations / matrices --------- */

/** Rotate v by unit quaternion q = [x, y, z, w]. */
export function rotateByQuaternion(q, v) {
  const [qx, qy, qz, qw] = quat(q);
  const u = [qx, qy, qz];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, qw)), cross(u, t));
}

/**
 * Surface normal of a hit-test result: the hit pose's +Y axis (WebXR Hit Test Module: the result's
 * native origin has its Y axis along the surface normal).
 */
export function surfaceNormalFromQuaternion(q) {
  return normalize(rotateByQuaternion(q, [0, 1, 0]));
}

/** Column-major 4x4 rigid transform from a position and unit quaternion (same layout as XRRigidTransform.matrix). */
export function rigidMatrix(position, orientation = [0, 0, 0, 1]) {
  const [x, y, z, w] = quat(orientation);
  const p = vec3(position);
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    p[0], p[1], p[2], 1,
  ];
}

/** Column-major 4x4 times [x, y, z, w]. */
export function transformVec4(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

/** Transform a point (w = 1) by a rigid/affine column-major matrix. */
export function transformPoint(m, p) {
  const r = transformVec4(m, [p[0], p[1], p[2], 1]);
  return [r[0], r[1], r[2]];
}

/** Transform a direction (w = 0). */
export function transformDirection(m, d) {
  const r = transformVec4(m, [d[0], d[1], d[2], 0]);
  return [r[0], r[1], r[2]];
}

/** a * b for column-major 4x4 matrices. */
export function multiplyMatrices(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** General 4x4 inverse (works for projection matrices too). Returns null when singular. */
export function invertMatrix(m) {
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  for (let i = 0; i < 16; i++) inv[i] /= det;
  return inv;
}

/* ---------------------------------------------------------------- rays ------------------------- */

/**
 * The reticle ray of a pose: origin = the pose's position, direction = its -Z axis.
 * Pass viewerPose.transform.matrix (or view.transform.matrix) from frame.getViewerPose(localSpace).
 * This is the same ray a hit-test source created with { space: viewerSpace } and no offsetRay uses.
 */
export function rayFromPoseMatrix(m) {
  return { origin: [m[12], m[13], m[14]], direction: normalize([-m[8], -m[9], -m[10]]) };
}

/** CSS pixels (origin top-left, y down) -> normalized device coordinates (-1..1, y up). */
export function cssToNdc(x, y, width, height) {
  return [(2 * x) / width - 1, 1 - (2 * y) / height];
}

/** Normalized device coordinates -> CSS pixels of the DOM overlay (its visual extent equals the XR viewport). */
export function ndcToCss(ndcX, ndcY, width, height) {
  return [((ndcX + 1) / 2) * width, ((1 - ndcY) / 2) * height];
}

/**
 * View-space unit direction of the ray through an NDC point, by unprojecting it at two depths.
 * Correct for off-centre (asymmetric) projection matrices, which phone AR cameras often have.
 */
export function viewDirectionFromNdc(projectionMatrix, ndcX, ndcY) {
  const inv = invertMatrix(projectionMatrix);
  if (!inv) return null;
  const a = transformVec4(inv, [ndcX, ndcY, -1, 1]);
  const b = transformVec4(inv, [ndcX, ndcY, 0, 1]);
  if (Math.abs(a[3]) < EPS || Math.abs(b[3]) < EPS) return null;
  const pa = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
  const pb = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
  return normalize(sub(pb, pa));
}

/**
 * Ray in the reference space through an NDC point of a view.
 * @param {ArrayLike<number>} viewTransformMatrix view.transform.matrix (view -> reference space)
 * @param {ArrayLike<number>} projectionMatrix   view.projectionMatrix
 */
export function rayThroughNdc(viewTransformMatrix, projectionMatrix, ndcX, ndcY) {
  const d = viewDirectionFromNdc(projectionMatrix, ndcX, ndcY);
  if (!d) return null;
  return {
    origin: [viewTransformMatrix[12], viewTransformMatrix[13], viewTransformMatrix[14]],
    direction: normalize(transformDirection(viewTransformMatrix, d)),
  };
}

/* ---------------------------------------------------------------- planes ----------------------- */

/** Plane through `point` with unit `normal`: dot(normal, x) + d = 0. */
export function planeFromPointNormal(point, normal) {
  const n = normalize(vec3(normal));
  const p = vec3(point);
  if (!n || !finite3(p)) return null;
  return { point: p, normal: n, d: -dot(n, p) };
}

/** Signed distance of p from a plane (positive on the normal's side). */
export function signedDistance(plane, p) {
  return dot(plane.normal, p) + plane.d;
}

/**
 * Ray-plane intersection: origin + t * direction with t > 0.
 * Returns null when the ray is parallel to (or grazes, below `minCos`) the plane, or the plane is
 * behind the ray. `cos` is |cos| of the angle between the ray and the plane normal (1 = head-on).
 *
 * @param {{origin:number[], direction:number[]}} ray
 * @param {{normal:number[], d:number}} plane
 * @param {{minCos?: number, maxT?: number}} [opts]
 * @returns {{point:number[], t:number, cos:number} | null}
 */
export function intersectRayPlane(ray, plane, { minCos = 1e-6, maxT = Infinity } = {}) {
  if (!ray || !plane) return null;
  const dir = normalize(vec3(ray.direction));
  const o = vec3(ray.origin);
  if (!dir || !finite3(o)) return null;
  const denom = dot(plane.normal, dir);
  const cos = Math.abs(denom);
  if (cos < Math.max(minCos, EPS)) return null;
  const t = -(dot(plane.normal, o) + plane.d) / denom;
  if (!(t > 0) || t > maxT) return null;
  return { point: add(o, scale(dir, t)), t, cos };
}

/** Angle in degrees between a surface normal and `up` (0 = an upward-facing horizontal surface). */
export function tiltDeg(normal, up = UP) {
  const n = normalize(vec3(normal));
  const u = normalize(vec3(up));
  if (!n || !u) return NaN;
  return Math.acos(Math.min(1, Math.max(-1, dot(n, u)))) / DEG;
}

/** True when the normal points up within maxTiltDeg (floor, sill, step). */
export function isUpwardHorizontal(normal, { up = UP, maxTiltDeg = 12 } = {}) {
  const t = tiltDeg(normal, up);
  return Number.isFinite(t) && t <= maxTiltDeg;
}

/** Remove the `up` component of v (project onto the horizontal plane). */
export function horizontal(v, up = UP) {
  const u = normalize(vec3(up));
  return sub(v, scale(u, dot(v, u)));
}

/**
 * The door plane: the vertical plane through the two bottom corners.
 * right = horizontal unit vector BL -> BR; normal = right x up, flipped to face `towards`
 * (pass the viewer position) when given. Both corners lie in the plane even if their heights differ.
 *
 * @returns {{origin:number[], right:number[], up:number[], normal:number[], d:number, baseLengthM:number} | null}
 *          null when the corners are closer than minBaseM horizontally (degenerate).
 */
export function doorPlaneFromBase(bl, br, { up = UP, towards = null, minBaseM = 0.2 } = {}) {
  const a = vec3(bl);
  const b = vec3(br);
  const u = normalize(vec3(up));
  if (!finite3(a) || !finite3(b) || !u) return null;
  const h = horizontal(sub(b, a), u);
  const baseLengthM = length(h);
  if (!(baseLengthM >= minBaseM)) return null;
  const right = scale(h, 1 / baseLengthM);
  let normal = normalize(cross(right, u));
  if (towards && finite3(vec3(towards)) && dot(normal, sub(vec3(towards), a)) < 0) normal = scale(normal, -1);
  return { origin: a, right, up: u, normal, d: -dot(normal, a), baseLengthM };
}

/** 2D coordinates of p in the door plane, metres: [along right from BL, along up from BL]. */
export function toPlaneCoords(plane, p) {
  const v = sub(vec3(p), plane.origin);
  return [dot(v, plane.right), dot(v, plane.up)];
}

/* ---------------------------------------------------------------- picking ---------------------- */

export const DEFAULT_LIMITS = Object.freeze({
  maxDistanceM: 4, // beyond this ARCore tracking/plane error grows fast; ask the user to step closer
  maxFloorTiltDeg: 12, // floor/sill hits must face up
  minPlaneCos: 0.26, // top-corner ray must be within ~75 degrees of the door normal
  minWidthM: 0.4,
  maxWidthM: 2.0,
  maxBaseStepM: 0.08, // BL and BR must be on (nearly) the same floor level
  minHeightM: 1.5,
  maxHeightM: 3.2,
  minSillM: -0.05, // sill top relative to BL (step 'sill')
  maxSillM: 0.35,
  sideSlackM: 0.3, // top corners must be roughly above the base segment
});

/**
 * Turn the current aim (reticle ray + hit-test result) into a corner point, with guard rails.
 *
 * step 'bl' | 'br': uses the hit-test point on an upward-facing surface; if there is no hit but the
 *                   floor height is known (floorY, along `up`), intersects the ray with that floor.
 * step 'tl' | 'tr': intersects the ray with the door plane (from doorPlaneFromBase).
 * step 'sill':      optional; the top of a raised sill/threshold, by intersection with the door plane.
 *
 * @param {object} o
 * @param {'bl'|'br'|'tl'|'tr'|'sill'} o.step
 * @param {{origin:number[], direction:number[]}} o.ray      reticle ray in 'local' space
 * @param {{position:number[]|object, normal?:number[], orientation?:number[]|object} | null} [o.hit]
 *        first hit-test result: position from getPose(local).transform.position, orientation likewise
 * @param {number|null} [o.floorY]   floor height along `up` (see estimateFloorY)
 * @param {object|null} [o.plane]    door plane (required for top steps)
 * @param {number[]|null} [o.bl]     already placed bottom-left (required for 'br')
 * @param {number[]} [o.up]
 * @param {object} [o.limits]        overrides for DEFAULT_LIMITS
 * @returns {{ok:true, point:number[], source:'hit'|'floor'|'plane'} | {ok:false, reason:string}}
 */
export function aimPoint({ step, ray, hit = null, floorY = null, plane = null, bl = null, up = UP, limits = {} }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (!ray || !normalize(vec3(ray.direction || [0, 0, 0]))) return { ok: false, reason: 'no_ray' };
  const origin = vec3(ray.origin);
  const u = normalize(vec3(up));

  if (step === 'bl' || step === 'br') {
    let point = null;
    let source = null;
    if (hit && hit.position) {
      const normal = hit.normal ? normalize(vec3(hit.normal)) : hit.orientation ? surfaceNormalFromQuaternion(hit.orientation) : null;
      if (normal && !isUpwardHorizontal(normal, { up: u, maxTiltDeg: L.maxFloorTiltDeg })) return { ok: false, reason: 'not_floor' };
      point = vec3(hit.position);
      source = 'hit';
    } else if (Number.isFinite(floorY)) {
      const floor = { normal: u, d: -floorY };
      const r = intersectRayPlane(ray, floor, { minCos: 0.1 });
      if (!r) return { ok: false, reason: 'no_surface' };
      point = r.point;
      source = 'floor';
    } else {
      return { ok: false, reason: 'no_surface' };
    }
    if (!finite3(point)) return { ok: false, reason: 'no_surface' };
    if (distance(point, origin) > L.maxDistanceM) return { ok: false, reason: 'too_far' };
    if (step === 'br') {
      if (!bl) return { ok: false, reason: 'need_bl' };
      const b = vec3(bl);
      const w = length(horizontal(sub(point, b), u));
      if (w < L.minWidthM) return { ok: false, reason: 'too_narrow' };
      if (w > L.maxWidthM) return { ok: false, reason: 'too_wide' };
      if (Math.abs(dot(sub(point, b), u)) > L.maxBaseStepM) return { ok: false, reason: 'not_level' };
    }
    return { ok: true, point, source };
  }

  if (step === 'tl' || step === 'tr' || step === 'sill') {
    if (!plane) return { ok: false, reason: 'no_plane' };
    const r = intersectRayPlane(ray, plane, { minCos: 0 });
    if (!r) return { ok: false, reason: 'behind' };
    if (r.cos < L.minPlaneCos) return { ok: false, reason: 'grazing' };
    if (r.t > L.maxDistanceM) return { ok: false, reason: 'too_far' };
    const [x, y] = toPlaneCoords(plane, r.point);
    // 'sill': optional tap on the top of a raised sill/threshold, in the door plane, so the height is
    // measured from the sill and not from the floor the base corners were hit on.
    const [lo, hi] = step === 'sill' ? [L.minSillM, L.maxSillM] : [L.minHeightM, L.maxHeightM];
    if (y < lo) return { ok: false, reason: 'too_low' };
    if (y > hi) return { ok: false, reason: 'too_high' };
    if (x < -L.sideSlackM || x > plane.baseLengthM + L.sideSlackM) return { ok: false, reason: 'off_opening' };
    return { ok: true, point: r.point, source: 'plane' };
  }

  return { ok: false, reason: 'bad_step' };
}

/* ---------------------------------------------------------------- measuring -------------------- */

// Blunder detectors, not accuracy gates. In the error model (tools/simulate-ar.mjs, 0.3 deg aim
// error) top-vs-bottom width mismatch is ~17 mm median, ~50 mm p95, ~64 mm p99 on a GOOD pass, so
// tighter limits would reject most honest passes. These catch a corner put on the wrong edge.
export const DEFAULT_TOLERANCES = Object.freeze({
  edgeMismatchMm: 60, // top vs bottom width, left vs right height
  diagonalMismatchMm: 60,
  baseStepMm: 25, // BL vs BR height: a sloping porch or a hit on a doormat/step
  offPlaneMm: 10,
  widthRangeMm: [500, 1600],
  heightRangeMm: [1700, 2800],
});

/**
 * Width/height of the opening from four corners (metres, 'local' space).
 * The plane comes from BL/BR; TL/TR are expressed in that plane (if they were produced by
 * aimPoint they lie in it exactly; anchored points that moved may be slightly off it: offPlaneMm).
 *
 * widthMm / heightMm are the means of the two opposite edges (best estimate for a quote);
 * minWidthMm / minHeightMm are the tighter edges. warnings flag self-inconsistency: a real opening is
 * close to a rectangle, so large edge/diagonal disagreement means a bad corner or tracking error.
 * With `sill` (from aimPoint step 'sill') both heights are measured from the sill top instead of
 * from the floor hits.
 */
export function measureOpening({ bl, br, tl, tr, sill = null, up = UP, towards = null, tolerances = {} }) {
  const T = { ...DEFAULT_TOLERANCES, ...tolerances };
  const plane = doorPlaneFromBase(bl, br, { up, towards, minBaseM: 0.05 });
  if (!plane) return null;
  const P = [bl, br, tl, tr].map(vec3);
  if (!P.every(finite3)) return null;
  const [cBL, cBR, cTL, cTR] = P.map((p) => toPlaneCoords(plane, p));
  const mm = (m) => m * 1000;
  const baseStepMm = mm(cBR[1] - cBL[1]);
  let sillHeightMm = 0;
  if (sill) {
    const s = vec3(sill);
    if (!finite3(s)) return null;
    const sillY = toPlaneCoords(plane, s)[1];
    sillHeightMm = mm(sillY);
    cBL[1] = sillY;
    cBR[1] = sillY;
  }

  const bottomWidthMm = mm(cBR[0] - cBL[0]);
  const topWidthMm = mm(cTR[0] - cTL[0]);
  const leftHeightMm = mm(cTL[1] - cBL[1]);
  const rightHeightMm = mm(cTR[1] - cBR[1]);
  const d1 = Math.hypot(cTR[0] - cBL[0], cTR[1] - cBL[1]);
  const d2 = Math.hypot(cTL[0] - cBR[0], cTL[1] - cBR[1]);
  const diagonalDiffMm = mm(Math.abs(d1 - d2));
  const offPlaneMm = mm(Math.max(Math.abs(signedDistance(plane, P[2])), Math.abs(signedDistance(plane, P[3]))));

  const widthMm = (bottomWidthMm + topWidthMm) / 2;
  const heightMm = (leftHeightMm + rightHeightMm) / 2;

  const warnings = [];
  if (Math.abs(topWidthMm - bottomWidthMm) > T.edgeMismatchMm) warnings.push('widths_disagree');
  if (Math.abs(leftHeightMm - rightHeightMm) > T.edgeMismatchMm) warnings.push('heights_disagree');
  if (diagonalDiffMm > T.diagonalMismatchMm) warnings.push('out_of_square');
  if (Math.abs(baseStepMm) > T.baseStepMm) warnings.push('base_not_level');
  if (offPlaneMm > T.offPlaneMm) warnings.push('off_plane');
  if (widthMm < T.widthRangeMm[0] || widthMm > T.widthRangeMm[1] || heightMm < T.heightRangeMm[0] || heightMm > T.heightRangeMm[1]) {
    warnings.push('implausible_size');
  }

  return {
    widthMm,
    heightMm,
    minWidthMm: Math.min(bottomWidthMm, topWidthMm),
    minHeightMm: Math.min(leftHeightMm, rightHeightMm),
    bottomWidthMm,
    topWidthMm,
    leftHeightMm,
    rightHeightMm,
    diagonalDiffMm,
    baseStepMm,
    sillHeightMm,
    offPlaneMm,
    plane,
    warnings,
    ok: warnings.length === 0,
  };
}

/* ---------------------------------------------------------------- robust helpers --------------- */

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Per-axis median of several samples of one point (e.g. the hit point over the ~10 frames after a tap). */
export function medianPoint(points) {
  const P = points.map(vec3).filter(finite3);
  if (!P.length) return null;
  return [median(P.map((p) => p[0])), median(P.map((p) => p[1])), median(P.map((p) => p[2]))];
}

/**
 * Floor height along `up` from hit-test samples collected while the user scans the floor.
 * Ignores non-horizontal hits. Returns null when there is no usable sample.
 * @param {Array<{position:any, normal?:any, orientation?:any}>} samples
 */
export function estimateFloorY(samples, { up = UP, maxTiltDeg = 12 } = {}) {
  const u = normalize(vec3(up));
  const ys = [];
  for (const s of samples || []) {
    if (!s || !s.position) continue;
    const n = s.normal ? vec3(s.normal) : s.orientation ? surfaceNormalFromQuaternion(s.orientation) : null;
    if (n && !isUpwardHorizontal(n, { up: u, maxTiltDeg })) continue;
    ys.push(dot(vec3(s.position), u));
  }
  return ys.length ? median(ys) : null;
}

/**
 * Combine repeated passes (the UI should ask for two). Median of each dimension plus the spread;
 * agree = both spreads within maxSpreadMm. Disagreement is the cheapest available detector of an
 * ARCore scale/tracking fault, which no single pass can reveal.
 */
export function combineRuns(runs, { maxSpreadMm = 20 } = {}) {
  const ok = (runs || []).filter((r) => r && Number.isFinite(r.widthMm) && Number.isFinite(r.heightMm));
  if (!ok.length) return null;
  const ws = ok.map((r) => r.widthMm);
  const hs = ok.map((r) => r.heightMm);
  const spreadWidthMm = Math.max(...ws) - Math.min(...ws);
  const spreadHeightMm = Math.max(...hs) - Math.min(...hs);
  return {
    widthMm: median(ws),
    heightMm: median(hs),
    spreadWidthMm,
    spreadHeightMm,
    runs: ok.length,
    agree: ok.length >= 2 && spreadWidthMm <= maxSpreadMm && spreadHeightMm <= maxSpreadMm,
  };
}

/* ---------------------------------------------------------------- drawing (DOM overlay) -------- */

/**
 * Project a 'local'-space point to CSS pixels of the DOM overlay.
 * @param {ArrayLike<number>} viewMatrix       view.transform.inverse.matrix (reference space -> view)
 * @param {ArrayLike<number>} projectionMatrix view.projectionMatrix
 * @param {number[]} point
 * @param {number} width   overlay root clientWidth (CSS px)
 * @param {number} height  overlay root clientHeight (CSS px)
 * @returns {{x:number, y:number, ndcZ:number, inFront:boolean, onScreen:boolean}}
 */
export function projectToCss(viewMatrix, projectionMatrix, point, width, height) {
  const v = transformVec4(viewMatrix, [point[0], point[1], point[2], 1]);
  const c = transformVec4(projectionMatrix, v);
  if (!(c[3] > EPS)) return { x: NaN, y: NaN, ndcZ: NaN, inFront: false, onScreen: false };
  const nx = c[0] / c[3];
  const ny = c[1] / c[3];
  const nz = c[2] / c[3];
  const [x, y] = ndcToCss(nx, ny, width, height);
  return { x, y, ndcZ: nz, inFront: true, onScreen: Math.abs(nx) <= 1 && Math.abs(ny) <= 1 };
}

/**
 * Project a 3D segment, clipped against the near plane (view-space z <= -near) so a dimension line
 * with one end behind the camera is still drawn correctly. Returns null when fully behind.
 */
export function projectSegmentToCss(viewMatrix, projectionMatrix, a, b, width, height, near = 0.01) {
  let va = transformPoint(viewMatrix, a);
  let vb = transformPoint(viewMatrix, b);
  const inA = va[2] <= -near;
  const inB = vb[2] <= -near;
  if (!inA && !inB) return null;
  if (!inA || !inB) {
    const t = (-near - va[2]) / (vb[2] - va[2]);
    const cut = add(va, scale(sub(vb, va), t));
    if (inA) vb = cut;
    else va = cut;
  }
  const proj = (p) => {
    const c = transformVec4(projectionMatrix, [p[0], p[1], p[2], 1]);
    return ndcToCss(c[0] / c[3], c[1] / c[3], width, height);
  };
  const [ax, ay] = proj(va);
  const [bx, by] = proj(vb);
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}
