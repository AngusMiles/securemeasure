// Tiny RGBA drawing for the lab page's label textures. Pure: no canvas, no DOM, so the browser and the
// Node script that writes the static models (make-static.mjs) draw exactly the same pixels.
//
// Images are { data: Uint8ClampedArray (RGBA), width, height }, origin at the top-left pixel. Colours are
// [r, g, b] (0-255); everything is drawn opaque. Drawing outside the image is clipped, never thrown.

/** Glyph cell: 5 columns x 7 rows, plus 1 column of spacing between characters. */
export const GLYPH_W = 5;
export const GLYPH_H = 7;
export const GLYPH_ADVANCE = 6;

/* eslint-disable no-multi-spaces */
const FONT_ROWS = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['.....', '....#', '...#.', '..#..', '.#...', '#....', '.....'],
};
/* eslint-enable no-multi-spaces */

/** Each glyph as 7 row bitmasks (bit 4 = leftmost column). */
const FONT = Object.freeze(
  Object.fromEntries(
    Object.entries(FONT_ROWS).map(([ch, rows]) => [ch, Object.freeze(rows.map((r) => [...r].reduce((m, c) => (m << 1) | (c === '#' ? 1 : 0), 0)))]),
  ),
);

/** The characters drawText can draw (lower-case letters other than 'x' are drawn as capitals). */
export const FONT_CHARS = Object.freeze(Object.keys(FONT));

function glyphFor(ch) {
  if (FONT[ch]) return FONT[ch];
  const upper = ch.toUpperCase();
  return FONT[upper] || null;
}

/**
 * A new opaque image filled with one colour.
 * @param {number} width
 * @param {number} height
 * @param {number[]} [color]  [r, g, b], default white
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function createImage(width, height, color = [255, 255, 255]) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('createImage: width and height must be positive integers');
  }
  const image = { data: new Uint8ClampedArray(width * height * 4), width, height };
  fillRect(image, 0, 0, width, height, color);
  return image;
}

/**
 * Fill the pixels [x, x + w) x [y, y + h) (rounded to whole pixels), clipped to the image.
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number[]} color  [r, g, b]
 */
export function fillRect(image, x, y, w, h, color) {
  if (![x, y, w, h].every(Number.isFinite)) return;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(image.width, Math.round(x + w));
  const y1 = Math.min(image.height, Math.round(y + h));
  if (x1 <= x0 || y1 <= y0) return;
  const [r, g, b] = color;
  const d = image.data;
  for (let py = y0; py < y1; py++) {
    for (let px = x0, i = (py * image.width + x0) * 4; px < x1; px++, i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
}

/**
 * Size of a string drawn by drawText.
 * @param {string} text
 * @param {number} [scale]  pixels per font pixel
 * @returns {{ width: number, height: number }}
 */
export function textSize(text, scale = 1) {
  const n = String(text).length;
  return { width: n ? (n * GLYPH_ADVANCE - 1) * scale : 0, height: GLYPH_H * scale };
}

/**
 * Draw text in the built-in 5 x 7 font, top-left at (x, y), each font pixel a scale x scale square.
 * Characters the font lacks leave a blank cell. Anything past the image edge is clipped.
 *
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {{ scale?: number, color?: number[] }} [opts]  scale: positive integer (default 1); color: [r,g,b]
 * @returns {{ width: number, height: number }} the size drawn (as textSize)
 */
export function drawText(image, text, x, y, { scale = 1, color = [0, 0, 0] } = {}) {
  const s = Math.max(1, Math.round(scale));
  const str = String(text);
  const ox = Math.round(x);
  const oy = Math.round(y);
  for (let i = 0; i < str.length; i++) {
    const glyph = glyphFor(str[i]);
    if (!glyph) continue;
    const cx = ox + i * GLYPH_ADVANCE * s;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row];
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits & (1 << (GLYPH_W - 1 - col))) fillRect(image, cx + col * s, oy + row * s, s, s, color);
      }
    }
  }
  return textSize(str, s);
}

/**
 * The largest whole font scale at which `text` fits in w x h pixels (at least 1).
 * @param {string} text
 * @param {number} w
 * @param {number} h
 * @returns {number}
 */
export function fitScale(text, w, h) {
  const size = textSize(text, 1);
  if (!size.width) return 1;
  return Math.max(1, Math.floor(Math.min(w / size.width, h / size.height)));
}

/**
 * Draw text centred on (cx, cy) at the given scale.
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image
 * @param {string} text
 * @param {number} cx
 * @param {number} cy
 * @param {{ scale?: number, color?: number[] }} [opts]
 */
export function drawTextCentred(image, text, cx, cy, opts = {}) {
  const s = Math.max(1, Math.round(opts.scale || 1));
  const size = textSize(text, s);
  drawText(image, text, cx - size.width / 2, cy - size.height / 2, { ...opts, scale: s });
}

/**
 * FNV-1a hash of an image's pixels (for determinism tests).
 * @param {{ data: ArrayLike<number> }} image
 * @returns {number} unsigned 32-bit
 */
export function hashImage(image) {
  let h = 0x811c9dc5;
  const d = image.data;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
