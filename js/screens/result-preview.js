/**
 * The result screen's flattened preview: the photo warped to a straight-on view of the door
 * (plus a margin), with the door outline and its two dimensions drawn on top.
 *
 * Shared by the paper measurement (js/screens/result.js) and the no-paper estimate
 * (js/screens/result-standard.js). This module imports nothing from either of them, so the
 * result modules form a one-way chain (result.js -> result-standard.js -> result-preview.js)
 * with no import cycle. Nothing here touches the DOM at import time, so the pure helpers can
 * be tested under Node.
 */
import { warpToRect } from '../vision.js';

/** Door plane shown around the opening on every side, in mm (tests/e2e.test.mjs mirrors it). */
export const PREVIEW_MARGIN_MM = 60;
const PREVIEW_MAX_PX = 720;
// Used only when the preview frame has no layout width yet (e.g. it is inside a hidden parent).
const PREVIEW_FALLBACK_CSS_PX = 280;

// Canvas overlay colours are fixed on purpose: a dark halo under a white core stays
// readable over any photo, which a brand colour cannot guarantee.
const INK = 'rgba(15, 23, 42, 0.85)';
const PAPER = '#ffffff';
const SAFE_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * @typedef {object} PreviewPlane
 * @property {number[]} planeToImage  row-major 3x3 homography from door-plane mm to photo pixels
 * @property {number} widthMm   the door rectangle the homography describes
 * @property {number} heightMm
 */

/**
 * True when there is enough to draw a preview: a decoded photo and a usable door rectangle.
 *
 * @param {{ data?: ArrayLike<number>, width?: number, height?: number } | null | undefined} photoImage  photo.image
 * @param {PreviewPlane | null | undefined} plane
 * @returns {boolean}
 */
export function canPreview(photoImage, plane) {
  const w = Number(plane?.widthMm);
  const h = Number(plane?.heightMm);
  return (
    Boolean(photoImage) &&
    Array.isArray(plane?.planeToImage) &&
    plane.planeToImage.length === 9 &&
    plane.planeToImage.every(Number.isFinite) &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0
  );
}

/**
 * The preview card: a figure holding the canvas and its caption. draw() paints the picture after
 * the screen has painted, so the numbers never wait for the warp, and can be called again to show
 * the door at another size (the estimate's "Which is your door?" choice): the old picture then
 * stays up until the new one is ready instead of flashing blank.
 *
 * @param {object} ui  ctx.ui
 * @param {{ caption: string }} copy
 * @returns {{
 *   el: HTMLElement,
 *   draw(photoImage: object, plane: PreviewPlane, labels: { widthLabel: string, heightLabel: string, alt: string }): void,
 *   hide(): void,
 *   destroy(): void,
 * }}
 */
export function createPreview(ui, { caption }) {
  const { h } = ui;
  const canvas = h('canvas', { class: 'sm-result__canvas', attrs: { role: 'img' } });
  const frame = h('div', { class: 'sm-result__frame' }, canvas);
  const el = ui.card(
    null,
    h(
      'figure',
      { class: 'sm-result__figure' },
      frame,
      h('figcaption', { class: 'sm-result__caption sm-small sm-muted', text: caption }),
    ),
  );
  el.classList.add('sm-result__preview');

  let frameA = 0;
  let frameB = 0;
  let drawn = false;

  const cancel = () => {
    cancelAnimationFrame(frameA);
    cancelAnimationFrame(frameB);
  };

  function hide() {
    cancel();
    el.hidden = true;
  }

  function draw(photoImage, plane, { widthLabel, heightLabel, alt }) {
    cancel();
    if (!canPreview(photoImage, plane)) {
      hide();
      return;
    }
    el.hidden = false;
    canvas.setAttribute('aria-label', alt);
    if (!drawn) {
      // Low-res placeholder with the final aspect ratio, so nothing jumps when the real
      // pixels arrive.
      canvas.width = Math.max(1, Math.round((plane.widthMm + 2 * PREVIEW_MARGIN_MM) / 10));
      canvas.height = Math.max(1, Math.round((plane.heightMm + 2 * PREVIEW_MARGIN_MM) / 10));
    }
    frameA = requestAnimationFrame(() => {
      frameB = requestAnimationFrame(() => {
        try {
          renderPreview(canvas, frame, photoImage, plane, { widthLabel, heightLabel });
          canvas.classList.add('is-ready');
          drawn = true;
        } catch (error) {
          console.warn('[SecureMeasure] Could not draw the flattened preview.', error);
          el.hidden = true;
        }
      });
    });
  }

  return { el, draw, hide, destroy: cancel };
}

/**
 * Warp the photo to a fronto-parallel view of the door (plus a margin) and annotate it.
 * Throws on any failure; the caller hides the preview.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} frame  the canvas's container, whose width picks the resolution
 * @param {object} photoImage  photo.image (RGBA)
 * @param {PreviewPlane} plane
 * @param {{ widthLabel: string, heightLabel: string }} labels
 */
export function renderPreview(canvas, frame, photoImage, plane, labels) {
  const cssWidth = frame.clientWidth || PREVIEW_FALLBACK_CSS_PX;
  const dpr = globalThis.devicePixelRatio || 1;
  const outWidth = Math.max(1, Math.min(PREVIEW_MAX_PX, Math.round(cssWidth * dpr)));

  const image = warpToRect(photoImage, plane.planeToImage, {
    widthMm: plane.widthMm,
    heightMm: plane.heightMm,
    marginMm: PREVIEW_MARGIN_MM,
    outWidth,
  });

  canvas.width = image.width;
  canvas.height = image.height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no_canvas_context');
  g.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

  drawDimensions(g, {
    width: image.width,
    height: image.height,
    doorW: plane.widthMm,
    doorH: plane.heightMm,
    marginMm: PREVIEW_MARGIN_MM,
    // Canvas pixels per CSS pixel, so strokes and text keep their on-screen size.
    unit: Math.max(1, image.width / cssWidth),
    fontFamily: typeof getComputedStyle === 'function' ? getComputedStyle(canvas).fontFamily : '',
    ...labels,
  });
}

/** Door outline plus width (top margin) and height (left margin) dimension lines. */
export function drawDimensions(g, { width, height, doorW, doorH, marginMm, unit, fontFamily, widthLabel, heightLabel }) {
  const sx = width / (doorW + 2 * marginMm);
  const sy = height / (doorH + 2 * marginMm);
  const x0 = marginMm * sx;
  const y0 = marginMm * sy;
  const w = doorW * sx;
  const hgt = doorH * sy;

  g.save();

  // Door opening outline: mitred so the corners stay crisp for checking against the photo.
  g.lineJoin = 'miter';
  g.lineCap = 'butt';
  strokeTwoTone(g, unit, 1.5, () => g.rect(x0, y0, w, hgt));

  // Dimension lines run down the middle of the margin strips, with a tick at each end.
  g.lineCap = 'round';
  const topY = y0 / 2;
  const leftX = x0 / 2;
  const tickX = Math.min(4 * unit, x0 * 0.4);
  const tickY = Math.min(4 * unit, y0 * 0.4);
  strokeTwoTone(g, unit, 1.25, () => {
    g.moveTo(x0, topY);
    g.lineTo(x0 + w, topY);
    g.moveTo(x0, topY - tickY);
    g.lineTo(x0, topY + tickY);
    g.moveTo(x0 + w, topY - tickY);
    g.lineTo(x0 + w, topY + tickY);
  });
  strokeTwoTone(g, unit, 1.25, () => {
    g.moveTo(leftX, y0);
    g.lineTo(leftX, y0 + hgt);
    g.moveTo(leftX - tickX, y0);
    g.lineTo(leftX + tickX, y0);
    g.moveTo(leftX - tickX, y0 + hgt);
    g.lineTo(leftX + tickX, y0 + hgt);
  });

  // Labels are slightly thicker than the margin strip on small previews, so keep them
  // fully on the canvas and let them overlap the outline instead of being clipped.
  const fontPx = Math.round(11 * unit);
  const thickness = fontPx + 5 * unit;
  const inset = thickness / 2 + unit;
  g.font = `600 ${fontPx}px ${SAFE_FONT_STACK}`;
  // An unparsable family is ignored by the canvas, leaving the safe stack in place.
  if (fontFamily) g.font = `600 ${fontPx}px ${fontFamily}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  drawLabel(g, widthLabel, x0 + w / 2, Math.max(topY, inset), 0, { unit, thickness });
  drawLabel(g, heightLabel, Math.max(leftX, inset), y0 + hgt / 2, -Math.PI / 2, { unit, thickness });

  g.restore();
}

/** Stroke one path twice: a dark halo, then a light core on top. */
export function strokeTwoTone(g, unit, coreWidth, buildPath) {
  g.beginPath();
  buildPath();
  g.strokeStyle = INK;
  g.lineWidth = (coreWidth + 2) * unit;
  g.stroke();
  g.strokeStyle = PAPER;
  g.lineWidth = coreWidth * unit;
  g.stroke();
}

/** Dark pill with light text, centred on (cx, cy) and rotated by `angle`. */
export function drawLabel(g, text, cx, cy, angle, { unit, thickness }) {
  const w = g.measureText(text).width + 12 * unit;
  const r = thickness / 2;
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);
  // Hand-built rounded rectangle: CanvasRenderingContext2D.roundRect is missing on iOS 15.
  g.beginPath();
  g.moveTo(-w / 2 + r, -r);
  g.arcTo(w / 2, -r, w / 2, r, r);
  g.arcTo(w / 2, r, -w / 2, r, r);
  g.arcTo(-w / 2, r, -w / 2, -r, r);
  g.arcTo(-w / 2, -r, w / 2, -r, r);
  g.closePath();
  g.fillStyle = INK;
  g.fill();
  g.strokeStyle = PAPER;
  g.lineWidth = unit;
  g.stroke();
  g.fillStyle = PAPER;
  g.fillText(text, 0, 0.5 * unit);
  g.restore();
}
