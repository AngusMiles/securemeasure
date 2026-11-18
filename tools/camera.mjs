// Dev-only pinhole camera model shared by the accuracy simulation and the synthetic demo-photo renderer.
//
// World frame = the door plane: x to the right, y DOWN, z pointing away from the camera (into the house),
// units millimetres, door surface at z = 0. Image frame: x right, y down, pixels.

const deg = (d) => (d * Math.PI) / 180;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Homography (row-major 3x3, length 9) mapping door-plane millimetres -> image pixels for a camera that
 * orbits `target` (a point on the plane) at `distanceMm`, always looking at it.
 *
 * @param {object} o
 * @param {number} o.imageWidth
 * @param {number} o.imageHeight
 * @param {number} o.focalPx          focal length in pixels (phone main camera ~ 0.72 x long image side)
 * @param {{x:number,y:number}} [o.target]  point on the plane the camera looks at (mm)
 * @param {number} [o.distanceMm]     camera-to-target distance
 * @param {number} [o.yawDeg]         + = camera stands to the right of the target
 * @param {number} [o.pitchDeg]       + = camera is lower than the target (looking up)
 * @param {number} [o.rollDeg]        rotation about the optical axis
 * @param {{x:number,y:number}} [o.principal] principal point (defaults to image centre)
 * @returns {number[]}
 */
export function cameraHomography({
  imageWidth,
  imageHeight,
  focalPx,
  target = { x: 410, y: 1020 },
  distanceMm = 2800,
  yawDeg = 0,
  pitchDeg = 0,
  rollDeg = 0,
  principal,
}) {
  const yaw = deg(yawDeg);
  const pitch = deg(pitchDeg);
  const roll = deg(rollDeg);
  // Unit vector from the target towards the camera centre.
  const d = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const C = [target.x + distanceMm * d[0], target.y + distanceMm * d[1], distanceMm * d[2]];
  const zc = [-d[0], -d[1], -d[2]];
  let xc = norm(cross([0, 1, 0], zc));
  let yc = cross(zc, xc);
  if (roll !== 0) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const xr = [c * xc[0] + s * yc[0], c * xc[1] + s * yc[1], c * xc[2] + s * yc[2]];
    const yr = [-s * xc[0] + c * yc[0], -s * xc[1] + c * yc[1], -s * xc[2] + c * yc[2]];
    xc = xr;
    yc = yr;
  }
  const t = [-dot(xc, C), -dot(yc, C), -dot(zc, C)];
  const cx = principal ? principal.x : imageWidth / 2;
  const cy = principal ? principal.y : imageHeight / 2;
  const f = focalPx;
  // H = K [r1 r2 t], where r1/r2 are the first two columns of the world->camera rotation.
  return [
    f * xc[0] + cx * zc[0], f * xc[1] + cx * zc[1], f * t[0] + cx * t[2],
    f * yc[0] + cy * zc[0], f * yc[1] + cy * zc[1], f * t[1] + cy * t[2],
    zc[0], zc[1], t[2],
  ];
}

/** Apply a row-major 3x3 homography to a point. */
export function projectPoint(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}
