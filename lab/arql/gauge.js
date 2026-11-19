// Life-size measuring gauges as USD scenes, for iPhone AR Quick Look. Pure: no DOM, safe under Node.
//
// Each builder returns { usda, textures: [{ path, image: { data, width, height } }], meta }. The page turns
// the images into PNGs and packs everything with makeUsdz (usdz.js); make-static.mjs does the same under
// Node for the committed copies in models/.
//
// PRIM LAYOUT: the one three.js's USDZExporter (MIT) writes, which Google model-viewer uses to make USDZ on
// the fly for Quick Look from a blob URL, so it is known to load. Our own minimal code, no dependency:
//   Root (Xform) > Scenes (Scope, kind = "sceneLibrary") > Scene (Xform, sceneName "Scene") > Gauge > meshes
//   Materials (top-level Scope) > one Material per colour or texture
// Units are metres (metersPerUnit = 1), Y up.
//
// GEOMETRY (before the orientation option is applied; see ORIENTATIONS):
//   - content lies in the XY plane facing +Z; its back (z = 0) goes against the wall, Y is up;
//   - the origin (0, 0, 0) is the bottom-left INNER corner of the door opening. It is NOT the model's lowest
//     point: the tape L's red marker, the grid's bottom labels and the C / D bottom bars reach 20-32 mm below
//     it (meta.belowZeroMm). An upright gauge Quick Look stands on the floor (anchoring 'none', or one that
//     lands on the floor) rests on that lowest point, so its zero floats belowZeroMm above the floor and
//     cannot be dragged down: head readings then come out that much short. stats.js leaves those heights out
//     (rowUse) rather than moving the geometry, which would change every committed copy in models/;
//   - an outline of W x H has its INNER edges exactly at x = 0..W and y = 0..H, its 25 mm bars OUTSIDE the
//     opening, so a bar's width never biases a reading;
//   - a ruler tick's lower (or left) edge is exactly on its value;
//   - every line is a box 3 mm deep off the plane (so it shows at an angle); label plates and ruler strips
//     are opaque quads. Nothing is transparent.
// Materials are UsdPreviewSurface with the colour also as emissive (readable in shade), roughness 1,
// metallic 0. Textures are at most 1024 px on the long side; long rulers are cut into 0.5 m segments at
// 0.5 mm per pixel (1000 px).

import { DEFAULT_STANDARD_SIZES } from '../../js/estimate.js';
import { createImage, drawText, fitScale, textSize, fillRect } from './raster.js';

export const DESIGNS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
export const ANCHORINGS = Object.freeze(['vertical', 'none', 'horizontal']);
/**
 * 'xy': content in the XY plane facing +Z (Y up). 'xz': the same content turned -90 deg about X, so it lies
 * in the XZ plane facing +Y: (x, y, z) -> (x, z, -y), i.e. Y and Z swapped with the new Z negated. A plain
 * swap would mirror the content (text would read backwards); the turn keeps it readable. With 'xz' the
 * content's top points away from a viewer at +Z, which is how Quick Look turns a model to face you.
 */
export const ORIENTATIONS = Object.freeze(['xy', 'xz']);

export const DESIGN_INFO = Object.freeze({
  A: Object.freeze({ name: 'Tape L', anchoring: 'vertical', orientation: 'xy' }),
  B: Object.freeze({ name: 'Grid', anchoring: 'vertical', orientation: 'xy' }),
  C: Object.freeze({ name: 'Catalogue outlines', anchoring: 'vertical', orientation: 'xy' }),
  D: Object.freeze({ name: 'One outline', anchoring: 'vertical', orientation: 'xy' }),
  E: Object.freeze({ name: 'Floor ruler', anchoring: 'horizontal', orientation: 'xz' }),
});

export const TAPE_DEFAULTS = Object.freeze({ heightMm: 2500, widthMm: 1300 });
export const GRID_DEFAULTS = Object.freeze({ widthMm: 1300, heightMm: 2500 });
export const OUTLINE_DEFAULTS = Object.freeze({ widthMm: 820, heightMm: 2040 });
export const FLOOR_DEFAULTS = Object.freeze({ lengthMm: 2000 });

/** Floor ruler runs this far past lengthMm, so a reading a little over the end can still be taken. */
export const FLOOR_OVERRUN_MM = 100;

const MM = 0.001;
const LINE_DEPTH = 0.003;
/** Lines that must win where they cross others are a little deeper, so their top face is in front. */
const LINE_DEPTH_TOP = 0.0035;
const BAR = 0.025;
const PLATE_Z = 0.004;
const STRIP_Z = 0.001;
const RULER_PX_PER_MM = 2;
const SEGMENT_MM = 500;
const MAX_TEXTURE_PX = 1024;
const ATLAS_PAD_PX = 3;

/** sRGB colours. */
export const COLORS = Object.freeze({
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [225, 29, 38],
  blue: [24, 98, 255],
  green: [10, 150, 60],
  orange: [255, 128, 0],
  purple: [130, 60, 200],
  magenta: [210, 40, 160],
  teal: [0, 150, 150],
  brown: [140, 90, 40],
});

/** One colour per standard height (catalogue and outline); other heights take the spares in turn. */
const HEIGHT_COLORS = Object.freeze({ 2040: 'blue', 2100: 'green', 2340: 'orange' });
const SPARE_COLORS = Object.freeze(['purple', 'magenta', 'teal', 'brown']);

/**
 * The colour name for each height in a catalogue (2040 blue, 2100 green, 2340 orange, others in turn).
 * @param {number[]} heights
 * @returns {Map<number, string>}
 */
export function heightColors(heights) {
  const map = new Map();
  let spare = 0;
  for (const h of [...new Set(heights)].sort((a, b) => a - b)) {
    map.set(h, HEIGHT_COLORS[h] || SPARE_COLORS[spare++ % SPARE_COLORS.length]);
  }
  return map;
}

// ------------------------------------------------------------------------------------------------------
// Scene accumulator
// ------------------------------------------------------------------------------------------------------

class SceneBuilder {
  constructor() {
    /** @type {Map<string, { name: string, color?: number[], texture?: string }>} */
    this.materials = new Map();
    /** @type {Map<string, object>} */
    this.meshes = new Map();
    /** @type {Array<{ path: string, image: object }>} */
    this.textures = [];
  }

  color(colorName) {
    const name = `C_${colorName}`;
    if (!this.materials.has(name)) {
      const rgb = COLORS[colorName];
      if (!rgb) throw new Error(`gauge: unknown colour '${colorName}'`);
      this.materials.set(name, { name, color: rgb });
    }
    return name;
  }

  texture(texName, image) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(texName)) throw new Error(`gauge: bad texture name '${texName}'`);
    if (Math.max(image.width, image.height) > MAX_TEXTURE_PX) throw new Error(`gauge: texture '${texName}' is over ${MAX_TEXTURE_PX} px`);
    const name = `T_${texName}`;
    if (this.materials.has(name)) throw new Error(`gauge: texture '${texName}' added twice`);
    const path = `textures/${texName}.png`;
    this.textures.push({ path, image });
    this.materials.set(name, { name, texture: path });
    return name;
  }

  mesh(kind, material) {
    const name = `${kind}_${material}`;
    let mesh = this.meshes.get(name);
    if (!mesh) {
      mesh = { name, kind, material, points: [], normals: [], st: [], counts: [], indices: [] };
      this.meshes.set(name, mesh);
    }
    return mesh;
  }

  /** One face of 4 corners [x,y,z], put in counter-clockwise order as seen from the normal's side. */
  face(mesh, corners, normal, st) {
    const [a, b, c] = corners;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const flip = n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2] < 0;
    const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
    const base = mesh.points.length;
    for (const i of order) {
      mesh.points.push(corners[i]);
      mesh.normals.push(normal);
      if (st) mesh.st.push(st[i]);
    }
    mesh.counts.push(4);
    mesh.indices.push(base, base + 1, base + 2, base + 3);
  }

  /**
   * A box line, x0..x1 by y0..y1 (metres), from z0 to z1 off the plane.
   */
  box(colorName, x0, y0, x1, y1, z0 = 0, z1 = LINE_DEPTH) {
    const mesh = this.mesh('Bars', this.color(colorName));
    const f = (a, b, c, d, n) => this.face(mesh, [a, b, c, d], n);
    f([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    f([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
    f([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
    f([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0]);
    f([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]);
    f([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  }

  /** A flat textured plate facing +Z at depth z, mapped to [u0, v0, u1, v1] of its texture. */
  plate(material, x0, y0, x1, y1, z, uv = [0, 0, 1, 1]) {
    const mesh = this.mesh('Plates', material);
    const [u0, v0, u1, v1] = uv;
    this.face(mesh, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [0, 0, 1], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
  }
}

// ------------------------------------------------------------------------------------------------------
// USDA writer
// ------------------------------------------------------------------------------------------------------

/**
 * A number as USDA text: at most 6 decimals (1 micrometre), no trailing zeros, never '-0'.
 * @param {number} n
 * @returns {string}
 */
export function fmt(n) {
  if (!Number.isFinite(n)) throw new RangeError('gauge: non-finite number');
  let s = n.toFixed(6).replace(/\.?0+$/, '');
  if (s === '-0' || s === '') s = '0';
  return s;
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function colorText(rgb) {
  return `(${rgb.map((c) => Number(srgbToLinear(c).toFixed(4))).map(fmt).join(', ')})`;
}

/** The orientation turn applied to every point and normal at write time. */
function orient(orientation) {
  if (orientation === 'xy') return (p) => p;
  if (orientation === 'xz') return (p) => [p[0], p[2], -p[1]];
  throw new RangeError(`gauge: unknown orientation '${orientation}'`);
}

function tuple(p) {
  return `(${p.map(fmt).join(', ')})`;
}

function writeMesh(mesh, turn, ind) {
  const points = mesh.points.map(turn);
  const normals = mesh.normals.map(turn);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < lo[i]) lo[i] = p[i];
      if (p[i] > hi[i]) hi[i] = p[i];
    }
  }
  const lines = [
    `${ind}def Mesh "${mesh.name}" (`,
    `${ind}\tprepend apiSchemas = ["MaterialBindingAPI"]`,
    `${ind})`,
    `${ind}{`,
    `${ind}\tfloat3[] extent = [${tuple(lo)}, ${tuple(hi)}]`,
    `${ind}\tint[] faceVertexCounts = [${mesh.counts.join(', ')}]`,
    `${ind}\tint[] faceVertexIndices = [${mesh.indices.join(', ')}]`,
    `${ind}\trel material:binding = </Materials/${mesh.material}>`,
    `${ind}\tnormal3f[] normals = [${normals.map(tuple).join(', ')}] (`,
    `${ind}\t\tinterpolation = "vertex"`,
    `${ind}\t)`,
    `${ind}\tpoint3f[] points = [${points.map(tuple).join(', ')}]`,
  ];
  if (mesh.st.length) {
    lines.push(
      `${ind}\ttexCoord2f[] primvars:st = [${mesh.st.map(tuple).join(', ')}] (`,
      `${ind}\t\tinterpolation = "vertex"`,
      `${ind}\t)`,
    );
  }
  lines.push(`${ind}\tuniform token subdivisionScheme = "none"`, `${ind}}`, '');
  return lines.join('\n');
}

function writeMaterial(m) {
  const path = `/Materials/${m.name}`;
  const lines = [
    `\tdef Material "${m.name}"`,
    '\t{',
    `\t\ttoken outputs:surface.connect = <${path}/PreviewSurface.outputs:surface>`,
    '',
    '\t\tdef Shader "PreviewSurface"',
    '\t\t{',
    '\t\t\tuniform token info:id = "UsdPreviewSurface"',
  ];
  if (m.texture) {
    lines.push(
      `\t\t\tcolor3f inputs:diffuseColor.connect = <${path}/Texture.outputs:rgb>`,
      `\t\t\tcolor3f inputs:emissiveColor.connect = <${path}/Texture.outputs:rgb>`,
    );
  } else {
    lines.push(`\t\t\tcolor3f inputs:diffuseColor = ${colorText(m.color)}`, `\t\t\tcolor3f inputs:emissiveColor = ${colorText(m.color)}`);
  }
  lines.push(
    '\t\t\tfloat inputs:metallic = 0',
    '\t\t\tfloat inputs:opacity = 1',
    '\t\t\tfloat inputs:roughness = 1',
    '\t\t\tint inputs:useSpecularWorkflow = 0',
    '\t\t\ttoken outputs:surface',
    '\t\t}',
  );
  if (m.texture) {
    lines.push(
      '',
      '\t\tdef Shader "PrimvarReader_st"',
      '\t\t{',
      '\t\t\tuniform token info:id = "UsdPrimvarReader_float2"',
      '\t\t\tfloat2 inputs:fallback = (0, 0)',
      '\t\t\ttoken inputs:varname = "st"',
      '\t\t\tfloat2 outputs:result',
      '\t\t}',
      '',
      '\t\tdef Shader "Texture"',
      '\t\t{',
      '\t\t\tuniform token info:id = "UsdUVTexture"',
      `\t\t\tasset inputs:file = @${m.texture}@`,
      `\t\t\tfloat2 inputs:st.connect = <${path}/PrimvarReader_st.outputs:result>`,
      '\t\t\ttoken inputs:sourceColorSpace = "sRGB"',
      '\t\t\ttoken inputs:wrapS = "clamp"',
      '\t\t\ttoken inputs:wrapT = "clamp"',
      '\t\t\tfloat3 outputs:rgb',
      '\t\t}',
    );
  }
  lines.push('\t}', '');
  return lines.join('\n');
}

/**
 * The scene as USDA text.
 * @param {SceneBuilder} scene
 * @param {{ anchoring: string, orientation: string, label: string }} opts
 * @returns {string}
 */
function writeUsda(scene, { anchoring, orientation, label }) {
  if (!ANCHORINGS.includes(anchoring)) throw new RangeError(`gauge: unknown anchoring '${anchoring}'`);
  const turn = orient(orientation);
  const anchorLines =
    anchoring === 'none'
      ? []
      : ['\t\t\ttoken preliminary:anchoring:type = "plane"', `\t\t\ttoken preliminary:planeAnchoring:alignment = "${anchoring}"`, ''];
  const meshes = [...scene.meshes.values()].map((m) => writeMesh(m, turn, '\t\t\t\t'));
  const materials = [...scene.materials.values()].map(writeMaterial);
  return [
    '#usda 1.0',
    '(',
    '\tcustomLayerData = {',
    '\t\tstring creator = "SecureMeasure lab arql"',
    `\t\tstring gauge = "${label.replace(/["\\]/g, '')}"`,
    '\t}',
    '\tdefaultPrim = "Root"',
    '\tmetersPerUnit = 1',
    '\tupAxis = "Y"',
    ')',
    '',
    'def Xform "Root"',
    '{',
    '\tdef Scope "Scenes" (',
    '\t\tkind = "sceneLibrary"',
    '\t)',
    '\t{',
    '\t\tdef Xform "Scene" (',
    '\t\t\tcustomData = {',
    '\t\t\t\tbool preliminary_collidesWithEnvironment = 0',
    '\t\t\t\tstring sceneName = "Scene"',
    '\t\t\t}',
    '\t\t\tsceneName = "Scene"',
    '\t\t)',
    '\t\t{',
    ...anchorLines,
    '\t\t\tdef Xform "Gauge"',
    '\t\t\t{',
    ...meshes,
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
    '',
    'def Scope "Materials"',
    '{',
    ...materials,
    '}',
    '',
  ].join('\n');
}

function finish(scene, opts, meta) {
  const anchoring = opts.anchoring || DESIGN_INFO[meta.design].anchoring;
  const orientation = opts.orientation || DESIGN_INFO[meta.design].orientation;
  const label = `${meta.design} ${meta.title} ${anchoring} ${orientation}`;
  // How far the lowest point of the content (before the orientation turn) is below the opening's zero.
  let minY = 0;
  for (const m of scene.meshes.values()) for (const p of m.points) if (p[1] < minY) minY = p[1];
  return {
    usda: writeUsda(scene, { anchoring, orientation, label }),
    textures: scene.textures,
    meta: {
      ...meta,
      anchoring,
      orientation,
      belowZeroMm: minY < 0 ? Math.round((-minY / MM) * 1000) / 1000 : 0,
      lineBoxes: [...scene.meshes.values()].filter((m) => m.kind === 'Bars').reduce((acc, m) => acc + m.counts.length / 6, 0),
      plates: [...scene.meshes.values()].filter((m) => m.kind === 'Plates').reduce((acc, m) => acc + m.counts.length, 0),
    },
  };
}

// ------------------------------------------------------------------------------------------------------
// Textures: ruler strips and label atlases
// ------------------------------------------------------------------------------------------------------

/**
 * Opaque ruler strip cut into 0.5 m textured segments, aligned on multiples of 0.5 m from the origin.
 *
 * @param {SceneBuilder} scene
 * @param {object} o
 * @param {string} o.name           texture name prefix
 * @param {'x'|'y'} o.axis          the strip's long direction
 * @param {number} o.fromMm         start along the axis
 * @param {number} o.toMm           end along the axis
 * @param {number} o.acrossFromMm   strip edge across the axis
 * @param {number} o.acrossToMm
 * @param {Array<{ alongMm: number, acrossMm: number, text: string, scale: number, color?: number[] }>} o.labels
 *        label centres, in mm
 */
function rulerStrip(scene, { name, axis, fromMm, toMm, acrossFromMm, acrossToMm, labels }) {
  const acrossPx = Math.round((acrossToMm - acrossFromMm) * RULER_PX_PER_MM);
  let segLo = fromMm;
  let index = 0;
  while (segLo < toMm) {
    const segHi = Math.min(toMm, (Math.floor(segLo / SEGMENT_MM) + 1) * SEGMENT_MM);
    const alongPx = Math.round((segHi - segLo) * RULER_PX_PER_MM);
    const image = axis === 'y' ? createImage(acrossPx, alongPx) : createImage(alongPx, acrossPx);
    // mm -> pixel of this segment's image (row 0 is the top: high y, or high "across" for an x strip).
    const toPx = (alongMm, acrossMm) =>
      axis === 'y'
        ? { x: (acrossMm - acrossFromMm) * RULER_PX_PER_MM, y: (segHi - alongMm) * RULER_PX_PER_MM }
        : { x: (alongMm - segLo) * RULER_PX_PER_MM, y: (acrossToMm - acrossMm) * RULER_PX_PER_MM };
    for (const label of labels) {
      const size = textSize(label.text, label.scale);
      // Keep the whole label on the strip: the '0' at the very end would otherwise be cut in half.
      const halfAlongMm = (axis === 'y' ? size.height : size.width) / 2 / RULER_PX_PER_MM + 0.5;
      const along = Math.min(Math.max(label.alongMm, fromMm + halfAlongMm), toMm - halfAlongMm);
      if (along < segLo - 40 || along > segHi + 40) continue;
      const c = toPx(along, label.acrossMm);
      drawText(image, label.text, Math.round(c.x - size.width / 2), Math.round(c.y - size.height / 2), {
        scale: label.scale,
        color: label.color || COLORS.black,
      });
    }
    const material = scene.texture(`${name}_${index}`, image);
    if (axis === 'y') scene.plate(material, acrossFromMm * MM, segLo * MM, acrossToMm * MM, segHi * MM, STRIP_Z);
    else scene.plate(material, segLo * MM, acrossFromMm * MM, segHi * MM, acrossToMm * MM, STRIP_Z);
    segLo = segHi;
    index++;
  }
}

/**
 * Pack label plates into atlas textures (shelf packing, at most 1024 x 1024 each) and add the plates.
 *
 * @param {SceneBuilder} scene
 * @param {string} name  texture name prefix
 * @param {Array<{ text: string, x0: number, y0: number, x1: number, y1: number, fg: string, bg?: string }>} plates
 *        rectangles in mm, colour names
 * @param {number} pxPerMm
 */
function labelPlates(scene, name, plates, pxPerMm) {
  const cells = new Map();
  const order = [];
  for (const p of plates) {
    const wPx = Math.round((p.x1 - p.x0) * pxPerMm);
    const hPx = Math.round((p.y1 - p.y0) * pxPerMm);
    const key = `${p.text}|${wPx}|${hPx}|${p.fg}|${p.bg || 'white'}`;
    if (!cells.has(key)) {
      const cell = { key, text: p.text, wPx, hPx, fg: COLORS[p.fg], bg: COLORS[p.bg || 'white'] };
      if (wPx + 2 * ATLAS_PAD_PX > MAX_TEXTURE_PX || hPx + 2 * ATLAS_PAD_PX > MAX_TEXTURE_PX) {
        throw new Error(`gauge: label '${p.text}' is too big for one texture`);
      }
      cells.set(key, cell);
      order.push(cell);
    }
  }
  // Layout: rows left to right, pages top to bottom.
  const pages = [];
  let page = { rows: [], width: 0, height: 0 };
  let row = null;
  for (const cell of order) {
    const cw = cell.wPx + 2 * ATLAS_PAD_PX;
    const ch = cell.hPx + 2 * ATLAS_PAD_PX;
    if (!row || row.width + cw > MAX_TEXTURE_PX) {
      if (row && page.height + ch > MAX_TEXTURE_PX) {
        pages.push(page);
        page = { rows: [], width: 0, height: 0 };
      }
      row = { y: page.height, width: 0, height: 0 };
      page.rows.push(row);
    }
    cell.page = pages.length;
    cell.px = row.width;
    cell.py = row.y;
    row.width += cw;
    row.height = Math.max(row.height, ch);
    page.height = row.y + row.height;
    page.width = Math.max(page.width, row.width);
  }
  pages.push(page);
  const materials = pages.map((pg, i) => {
    const image = createImage(Math.max(1, pg.width), Math.max(1, pg.height));
    for (const cell of order.filter((c) => c.page === i)) {
      fillRect(image, cell.px, cell.py, cell.wPx + 2 * ATLAS_PAD_PX, cell.hPx + 2 * ATLAS_PAD_PX, cell.bg);
      const margin = Math.max(2, Math.round(Math.min(cell.wPx, cell.hPx) * 0.14));
      const scale = fitScale(cell.text, cell.wPx - 2 * margin, cell.hPx - 2 * margin);
      const size = textSize(cell.text, scale);
      const x = cell.px + ATLAS_PAD_PX + Math.round((cell.wPx - size.width) / 2);
      const y = cell.py + ATLAS_PAD_PX + Math.round((cell.hPx - size.height) / 2);
      drawText(image, cell.text, x, y, { scale, color: cell.fg });
    }
    return { image, material: scene.texture(pages.length > 1 ? `${name}_${i}` : name, image) };
  });
  for (const p of plates) {
    const wPx = Math.round((p.x1 - p.x0) * pxPerMm);
    const hPx = Math.round((p.y1 - p.y0) * pxPerMm);
    const cell = cells.get(`${p.text}|${wPx}|${hPx}|${p.fg}|${p.bg || 'white'}`);
    const { image, material } = materials[cell.page];
    const u0 = (cell.px + ATLAS_PAD_PX) / image.width;
    const u1 = (cell.px + ATLAS_PAD_PX + cell.wPx) / image.width;
    const v1 = 1 - (cell.py + ATLAS_PAD_PX) / image.height;
    const v0 = 1 - (cell.py + ATLAS_PAD_PX + cell.hPx) / image.height;
    scene.plate(material, p.x0 * MM, p.y0 * MM, p.x1 * MM, p.y1 * MM, PLATE_Z, [u0, v0, u1, v1]);
  }
}

// ------------------------------------------------------------------------------------------------------
// Designs
// ------------------------------------------------------------------------------------------------------

function positiveInt(value, fallback, name) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) throw new RangeError(`gauge: ${name} must be a size in mm (1-10000)`);
  return Math.round(n);
}

/** Tick length and width for a 10 mm step k on the tape (mm). */
function tapeTick(k) {
  if (k % 10 === 0) return { len: 18, width: 2 };
  if (k % 5 === 0) return { len: 10, width: 2 };
  return { len: 5, width: 1.5 };
}

/**
 * A. Two opaque white 40 mm strips forming an L: up the left jamb (inside the opening, x 0..40 mm) and
 * along the sill (y 0..40 mm). Black ticks every 10 mm (5 mm long), 50 mm (10 mm) and 100 mm (18 mm, with a
 * cm label such as '210' for 2100 mm); a red 0 marker at the corner. Readings: the head on the upright strip
 * (H) and the right jamb on the sill strip (W).
 *
 * @param {{ heightMm?: number, widthMm?: number, anchoring?: string, orientation?: string }} [opts]
 */
export function tapeL(opts = {}) {
  const H = positiveInt(opts.heightMm, TAPE_DEFAULTS.heightMm, 'heightMm');
  const W = positiveInt(opts.widthMm, TAPE_DEFAULTS.widthMm, 'widthMm');
  const STRIP = 40;
  const scene = new SceneBuilder();
  const ticks = [];

  // Upright strip: ticks are horizontal bars from the jamb edge (x = 0), lower edge on the value.
  const upLabels = [];
  for (let k = 0; k * 10 <= H; k++) {
    const v = k * 10;
    const t = tapeTick(k);
    scene.box(k === 0 ? 'red' : 'black', 0, v * MM, t.len * MM, (v + t.width) * MM);
    ticks.push({ axis: 'y', valueMm: v });
    if (k % 10 === 0) upLabels.push({ alongMm: v + 1, acrossMm: 29.5, text: String(v / 10), scale: 2, color: k === 0 ? COLORS.red : COLORS.black });
  }
  rulerStrip(scene, { name: 'tape_up', axis: 'y', fromMm: 0, toMm: H, acrossFromMm: 0, acrossToMm: STRIP, labels: upLabels });

  // Sill strip: starts where the upright strip ends (x = 40 mm), ticks are vertical bars, left edge on the value.
  const sillLabels = [];
  for (let k = STRIP / 10; k * 10 <= W; k++) {
    const v = k * 10;
    const t = tapeTick(k);
    scene.box('black', v * MM, 0, (v + t.width) * MM, t.len * MM);
    ticks.push({ axis: 'x', valueMm: v });
    if (k % 10 === 0) sillLabels.push({ alongMm: v + 1, acrossMm: 29.5, text: String(v / 10), scale: 2 });
  }
  if (W > STRIP) rulerStrip(scene, { name: 'tape_sill', axis: 'x', fromMm: STRIP, toMm: W, acrossFromMm: 0, acrossToMm: STRIP, labels: sillLabels });

  // Red 0 marker: a square whose top-right corner is the zero (the opening's bottom-left inner corner).
  scene.box('red', -20 * MM, -20 * MM, 0, 0);

  return finish(scene, opts, {
    design: 'A',
    title: `tape L ${H} x ${W}`,
    params: { heightMm: H, widthMm: W },
    ticks,
    readings: 'H = the head on the upright strip. W = the right jamb on the sill strip. Numbers are cm.',
  });
}

/**
 * B. See-through graph paper: black bars 4 mm wide every 100 mm, red bars 8 mm wide every 500 mm (lower or
 * left edge on the value), with small opaque label plates (cm) along the left and bottom edges. Read BOTH
 * edges of the opening: W = right - left, H = head - sill, so the grid needs no exact zero.
 *
 * @param {{ widthMm?: number, heightMm?: number, anchoring?: string, orientation?: string }} [opts]
 */
export function grid(opts = {}) {
  const W = positiveInt(opts.widthMm, GRID_DEFAULTS.widthMm, 'widthMm');
  const H = positiveInt(opts.heightMm, GRID_DEFAULTS.heightMm, 'heightMm');
  const scene = new SceneBuilder();
  const plates = [];
  const bars = [];
  for (let k = 0; k * 100 <= W; k++) {
    const v = k * 100;
    const red = k % 5 === 0;
    const bw = red ? 8 : 4;
    scene.box(red ? 'red' : 'black', v * MM, 0, (v + bw) * MM, H * MM, 0, red ? LINE_DEPTH_TOP : LINE_DEPTH);
    bars.push({ axis: 'x', valueMm: v, widthMm: bw });
    const cx = v + bw / 2;
    plates.push({ text: String(v / 10), x0: cx - 20, y0: -32, x1: cx + 20, y1: -10, fg: red ? 'red' : 'black' });
  }
  for (let k = 0; k * 100 <= H; k++) {
    const v = k * 100;
    const red = k % 5 === 0;
    const bw = red ? 8 : 4;
    scene.box(red ? 'red' : 'black', 0, v * MM, W * MM, (v + bw) * MM, 0, red ? LINE_DEPTH_TOP : LINE_DEPTH);
    bars.push({ axis: 'y', valueMm: v, widthMm: bw });
    const cy = v + bw / 2;
    plates.push({ text: String(v / 10), x0: -52, y0: cy - 11, x1: -10, y1: cy + 11, fg: red ? 'red' : 'black' });
  }
  labelPlates(scene, 'grid_labels', plates, 4);
  return finish(scene, opts, {
    design: 'B',
    title: `grid ${W} x ${H}`,
    params: { widthMm: W, heightMm: H },
    bars,
    readings: 'Read both edges: W = right - left, H = head - sill. Bars every 100 mm, red every 500 mm; labels are cm.',
  });
}

/**
 * The usable, distinct sizes of a catalogue (falls back to DEFAULT_STANDARD_SIZES).
 * @param {Array<{ widthMm: number, heightMm: number }>} [sizes]
 * @returns {Array<{ widthMm: number, heightMm: number }>}
 */
export function cleanCatalogue(sizes) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(sizes) ? sizes : []) {
    const w = Math.round(Number(s && s.widthMm));
    const h = Math.round(Number(s && s.heightMm));
    if (!(w > 0 && h > 0 && w <= 10000 && h <= 10000)) continue;
    const key = `${w}x${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ widthMm: w, heightMm: h });
  }
  return out.length ? out : DEFAULT_STANDARD_SIZES.map((s) => ({ widthMm: s.widthMm, heightMm: s.heightMm }));
}

/**
 * C. Every standard size as an outline sharing the bottom-left inner corner. One colour per height (2040
 * blue, 2100 green, 2340 orange). Drawn without overlaps: one black bar up the left and one along the
 * bottom (shared), one line per height (its lower edge at the height, as far right as the widest size of
 * that height), and one line per width (its left edge at the width, as high as the tallest size of that
 * width, coloured by height in steps). Width lines are a little deeper so they show where lines cross.
 * Label plates: the width above each width line's top end, the height right of each height line's end.
 *
 * @param {{ sizes?: Array<{ widthMm: number, heightMm: number }>, anchoring?: string, orientation?: string }} [opts]
 */
export function catalogue(opts = {}) {
  const sizes = cleanCatalogue(opts.sizes);
  const B = BAR / MM;
  const colors = heightColors(sizes.map((s) => s.heightMm));
  const heights = [...colors.keys()];
  const widths = [...new Set(sizes.map((s) => s.widthMm))].sort((a, b) => a - b);
  const maxW = (h) => Math.max(...sizes.filter((s) => s.heightMm === h).map((s) => s.widthMm));
  const maxH = (w) => Math.max(...sizes.filter((s) => s.widthMm === w).map((s) => s.heightMm));
  const allW = Math.max(...widths);
  const allH = Math.max(...heights);
  const scene = new SceneBuilder();
  const plates = [];
  const lines = [];

  scene.box('black', -BAR, -BAR, 0, (allH + B) * MM);
  scene.box('black', 0, -BAR, (allW + B) * MM, 0);
  for (const h of heights) {
    const right = maxW(h) + B;
    scene.box(colors.get(h), 0, h * MM, right * MM, (h + B) * MM);
    lines.push({ axis: 'y', valueMm: h, color: colors.get(h) });
    plates.push({ text: String(h), x0: right + 6, y0: h + B / 2 - 11, x1: right + 66, y1: h + B / 2 + 11, fg: colors.get(h) });
  }
  for (const w of widths) {
    const hs = [...new Set(sizes.filter((s) => s.widthMm === w).map((s) => s.heightMm))].sort((a, b) => a - b);
    let from = 0;
    for (const h of hs) {
      scene.box(colors.get(h), w * MM, from * MM, (w + B) * MM, (h + B) * MM, 0, LINE_DEPTH_TOP);
      from = h + B;
    }
    lines.push({ axis: 'x', valueMm: w });
    const top = maxH(w) + B;
    plates.push({ text: String(w), x0: w + B / 2 - 22, y0: top + 6, x1: w + B / 2 + 22, y1: top + 28, fg: 'black' });
  }
  labelPlates(scene, 'catalogue_labels', plates, 4);
  return finish(scene, opts, {
    design: 'C',
    title: `catalogue ${sizes.length} sizes`,
    params: { sizes },
    lines,
    colors: Object.fromEntries(colors),
    readings: 'Which width line meets the right jamb, which height line meets the head, and how many mm off.',
  });
}

/**
 * D. One outline, inner edges exactly at x = 0..W and y = 0..H, 25 mm bars outside the opening, coloured
 * by height, with a 'W x H' label plate in the opening at 1.5 m.
 *
 * @param {{ widthMm?: number, heightMm?: number, anchoring?: string, orientation?: string }} [opts]
 */
export function outline(opts = {}) {
  const W = positiveInt(opts.widthMm, OUTLINE_DEFAULTS.widthMm, 'widthMm');
  const H = positiveInt(opts.heightMm, OUTLINE_DEFAULTS.heightMm, 'heightMm');
  const color = heightColors([2040, 2100, 2340, H]).get(H);
  const w = W * MM;
  const h = H * MM;
  const scene = new SceneBuilder();
  scene.box(color, -BAR, -BAR, 0, h + BAR);
  scene.box(color, w, -BAR, w + BAR, h + BAR);
  scene.box(color, 0, h, w, h + BAR);
  scene.box(color, 0, -BAR, w, 0);
  const text = `${W} x ${H}`;
  const plateW = Math.min(300, Math.max(120, W - 60));
  labelPlates(scene, 'outline_label', [{ text, x0: W / 2 - plateW / 2, y0: 1500, x1: W / 2 + plateW / 2, y1: 1550, fg: color }], 3);
  return finish(scene, opts, {
    design: 'D',
    title: `outline ${W} x ${H}`,
    params: { widthMm: W, heightMm: H },
    color,
    readings: 'Does the outline sit on the opening? How many mm is each edge off (+ = the opening is bigger)?',
  });
}

/**
 * E. A flat ruler for the floor (horizontal anchoring, XZ plane by default): ticks every 10 mm (lower edge
 * on the value), cm labels every 100 mm, a red 0 marker. It runs FLOOR_OVERRUN_MM past lengthMm. Laid
 * beside a real tape, its reading at the tape's 1000 and 2000 mm marks checks ARKit's scale with no door.
 *
 * @param {{ lengthMm?: number, anchoring?: string, orientation?: string }} [opts]
 */
export function floorRuler(opts = {}) {
  const L = positiveInt(opts.lengthMm, FLOOR_DEFAULTS.lengthMm, 'lengthMm');
  const end = L + FLOOR_OVERRUN_MM;
  const STRIP = 60;
  const scene = new SceneBuilder();
  const labels = [];
  const ticks = [];
  for (let k = 0; k * 10 <= end; k++) {
    const v = k * 10;
    const len = k % 10 === 0 ? 22 : k % 5 === 0 ? 14 : 7;
    const width = k % 5 === 0 ? 2 : 1.5;
    scene.box(k === 0 ? 'red' : 'black', v * MM, 0, (v + width) * MM, len * MM);
    ticks.push({ axis: 'x', valueMm: v });
    if (k % 10 === 0) labels.push({ alongMm: v + 1, acrossMm: 42, text: String(v / 10), scale: 4, color: k === 0 ? COLORS.red : COLORS.black });
  }
  rulerStrip(scene, { name: 'floor', axis: 'x', fromMm: 0, toMm: end, acrossFromMm: 0, acrossToMm: STRIP, labels });
  scene.box('red', -20 * MM, 0, 0, STRIP * MM);
  return finish(scene, { anchoring: 'horizontal', orientation: 'xz', ...stripUndefined(opts) }, {
    design: 'E',
    title: `floor ruler ${L}`,
    params: { lengthMm: L },
    ticks,
    readings: 'Lay it beside a real tape, zero on zero. Note the AR reading at the tape\'s 1000 and 2000 mm marks.',
  });
}

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/**
 * Build one design by letter with its options (anchoring and orientation default per DESIGN_INFO).
 * @param {'A'|'B'|'C'|'D'|'E'} design
 * @param {object} [opts]
 */
export function buildDesign(design, opts = {}) {
  const d = String(design || '').toUpperCase();
  if (!DESIGNS.includes(d)) throw new RangeError(`gauge: unknown design '${design}'`);
  const o = { ...DESIGN_INFO[d], ...stripUndefined(opts) };
  if (d === 'A') return tapeL(o);
  if (d === 'B') return grid(o);
  if (d === 'C') return catalogue(o);
  if (d === 'D') return outline(o);
  return floorRuler(o);
}

// ------------------------------------------------------------------------------------------------------
// Quick Look link fragment
// ------------------------------------------------------------------------------------------------------

/**
 * The URL fragment Quick Look reads: banner fields encoded with encodeURIComponent, joined with '&', and
 * 'allowsContentScaling=0' last when the scale lock is on.
 * @param {{ callToAction?: string, checkoutTitle?: string, checkoutSubtitle?: string, lock?: boolean }} [o]
 * @returns {string} without the leading '#'
 */
export function quickLookFragment({ callToAction, checkoutTitle, checkoutSubtitle, lock } = {}) {
  const parts = [];
  if (callToAction) parts.push(`callToAction=${encodeURIComponent(callToAction)}`);
  if (checkoutTitle) parts.push(`checkoutTitle=${encodeURIComponent(checkoutTitle)}`);
  if (checkoutSubtitle) parts.push(`checkoutSubtitle=${encodeURIComponent(checkoutSubtitle)}`);
  if (lock) parts.push('allowsContentScaling=0');
  return parts.join('&');
}

/** The banner text of a design-D outline link. */
export const BANNER_ACTION = 'This size fits';
export const BANNER_SUBTITLE = 'SecureMeasure lab';

/**
 * Fragment for a design-D outline: a 'This size fits' banner titled 'W x H mm'.
 * @param {number} widthMm
 * @param {number} heightMm
 * @param {boolean} lock
 */
export function outlineFragment(widthMm, heightMm, lock) {
  return quickLookFragment({ callToAction: BANNER_ACTION, checkoutTitle: `${widthMm} x ${heightMm} mm`, checkoutSubtitle: BANNER_SUBTITLE, lock });
}

/**
 * `url` with `fragment` as its hash (any old hash dropped; no '#' for an empty fragment).
 * @param {string} url
 * @param {string} fragment
 */
export function withFragment(url, fragment) {
  const base = String(url).split('#')[0];
  return fragment ? `${base}#${fragment}` : base;
}

// ------------------------------------------------------------------------------------------------------
// Static copies (make-static.mjs writes them, the page links them)
// ------------------------------------------------------------------------------------------------------

/**
 * File name (no folder) for a variant: 'A-vertical-xy', 'D-820x2040-none-xy'.
 * @param {{ design: string, anchoring: string, orientation: string, widthMm?: number, heightMm?: number }} v
 */
export function variantKey(v) {
  const size = v.design === 'D' ? `-${v.widthMm}x${v.heightMm}` : '';
  return `${v.design}${size}-${v.anchoring}-${v.orientation}`;
}

/**
 * The variants committed under models/, all with each design's default parameters (C with the default
 * catalogue). D comes in every default standard size (vertical, xy), so the product flow can fall back to
 * static files too.
 */
export const STATIC_VARIANTS = Object.freeze(
  [
    { design: 'A', anchoring: 'vertical', orientation: 'xy' },
    { design: 'A', anchoring: 'none', orientation: 'xy' },
    { design: 'A', anchoring: 'vertical', orientation: 'xz' },
    { design: 'B', anchoring: 'vertical', orientation: 'xy' },
    { design: 'B', anchoring: 'none', orientation: 'xy' },
    { design: 'C', anchoring: 'vertical', orientation: 'xy' },
    { design: 'C', anchoring: 'none', orientation: 'xy' },
    { design: 'D', anchoring: 'none', orientation: 'xy', widthMm: 820, heightMm: 2040 },
    { design: 'D', anchoring: 'vertical', orientation: 'xz', widthMm: 820, heightMm: 2040 },
    ...DEFAULT_STANDARD_SIZES.map((s) => ({ design: 'D', anchoring: 'vertical', orientation: 'xy', widthMm: s.widthMm, heightMm: s.heightMm })),
    { design: 'E', anchoring: 'horizontal', orientation: 'xz' },
    { design: 'E', anchoring: 'none', orientation: 'xz' },
  ].map((v) => Object.freeze(v)),
);

function sameCatalogue(sizes) {
  const a = cleanCatalogue(sizes);
  const b = cleanCatalogue(DEFAULT_STANDARD_SIZES);
  return a.length === b.length && a.every((s, i) => s.widthMm === b[i].widthMm && s.heightMm === b[i].heightMm);
}

/**
 * The committed static copy that matches a build exactly, or null. Only the default parameters were
 * written (see STATIC_VARIANTS).
 * @param {{ design: string, anchoring: string, orientation: string, heightMm?: number, widthMm?: number,
 *   lengthMm?: number, sizes?: object[] }} o
 * @returns {string|null} path relative to the page, e.g. 'models/A-vertical-xy.usdz'
 */
export function staticFileFor(o) {
  const d = o.design;
  const num = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : Number(v));
  if (d === 'A' && (num(o.heightMm, 2500) !== TAPE_DEFAULTS.heightMm || num(o.widthMm, 1300) !== TAPE_DEFAULTS.widthMm)) return null;
  if (d === 'B' && (num(o.widthMm, 1300) !== GRID_DEFAULTS.widthMm || num(o.heightMm, 2500) !== GRID_DEFAULTS.heightMm)) return null;
  if (d === 'C' && o.sizes && !sameCatalogue(o.sizes)) return null;
  if (d === 'E' && num(o.lengthMm, 2000) !== FLOOR_DEFAULTS.lengthMm) return null;
  const want = { design: d, anchoring: o.anchoring, orientation: o.orientation, widthMm: num(o.widthMm, 820), heightMm: num(o.heightMm, 2040) };
  const hit = STATIC_VARIANTS.find((v) => variantKey(v) === variantKey(want));
  return hit ? `models/${variantKey(hit)}.usdz` : null;
}
