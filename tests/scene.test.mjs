import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { DEMO_SCENE, decodePng, encodePng, renderScene, sceneTruth, truthToJson } from '../tools/scene.mjs';

// Explicit colours so the expectations below do not depend on the renderer's default palette.
const COLORS = {
  wall: '#c0b0a0',
  architrave: '#f0f0f0',
  door: '#204060',
  doorPanel: '#102030',
  gap: '#000000',
  step: '#b0b0b0',
  floor: '#909090',
  floorJoint: '#606060',
};
const RGB = {
  wall: [192, 176, 160],
  architrave: [240, 240, 240],
  door: [32, 64, 96],
  doorPanel: [16, 32, 48],
  step: [176, 176, 176],
  floor: [144, 144, 144],
  floorJoint: [96, 96, 96],
  sheet: [255, 255, 255],
};

// Fronto-parallel view at exactly 0.25 px per mm: the door spans x 60..265, y 50..560 and the default
// A4 sheet (centre 410, 700) spans x 136.25..188.75, y 187.875..262.125.
const FLAT = {
  width: 320,
  height: 640,
  planeToImage: [0.25, 0, 60, 0, 0.25, 50, 0, 0, 1],
  lighting: 0,
  decor: false,
  supersample: 4,
  colors: COLORS,
  sheet: { color: '#ffffff' },
};

const CAMERA = { focalPx: 820, target: { x: 410, y: 1090 }, distanceMm: 2900, yawDeg: 8, pitchDeg: -5, rollDeg: 1.2 };
const PERSPECTIVE = {
  width: 600,
  height: 800,
  camera: CAMERA,
  planeToImage: cameraHomography({ imageWidth: 600, imageHeight: 800, ...CAMERA }),
  lighting: 0,
  decor: false,
  supersample: 4,
  colors: COLORS,
  sheet: { color: '#ffffff' },
};

const rgbAt = (image, x, y) => {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
};
const lumaAt = (image, x, y) => {
  const [r, g, b] = rgbAt(image, x, y);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};
/** Colour of the pixel nearest to where a plane point (mm) lands. */
const rgbAtPlane = (image, H, p) => {
  const q = projectPoint(H, p);
  return rgbAt(image, Math.round(q.x), Math.round(q.y));
};
const closeTo = (actual, expected, tol, label) => {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} +/- ${tol}, got ${actual}`);
};
const assertQuadClose = (actual, expected, tol, label) => {
  assert.equal(actual.length, 4, `${label}: four corners`);
  actual.forEach((p, i) => {
    closeTo(p.x, expected[i].x, tol, `${label}[${i}].x`);
    closeTo(p.y, expected[i].y, tol, `${label}[${i}].y`);
  });
};

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Split a PNG into its chunks, checking each CRC independently of the encoder's own table. */
function readChunks(png) {
  const chunks = [];
  for (let pos = 8; pos < png.length; ) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    const crcOk = crc32(png.subarray(pos + 4, pos + 8 + length)) === png.readUInt32BE(pos + 8 + length);
    chunks.push({ type, data, crcOk });
    pos += 12 + length;
  }
  return chunks;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const flat = renderScene(FLAT);
const perspective = renderScene(PERSPECTIVE);

describe('renderScene truth', () => {
  test('door and sheet corners are the direct projection, in [TL, TR, BR, BL] order', () => {
    const H = PERSPECTIVE.planeToImage;
    const { truth } = perspective;
    const door = [{ x: 0, y: 0 }, { x: 820, y: 0 }, { x: 820, y: 2040 }, { x: 0, y: 2040 }];
    const sheet = [{ x: 305, y: 551.5 }, { x: 515, y: 551.5 }, { x: 515, y: 848.5 }, { x: 305, y: 848.5 }];
    assertQuadClose(truth.doorPx, door.map((p) => projectPoint(H, p)), 1e-9, 'doorPx');
    assertQuadClose(truth.sheetPx, sheet.map((p) => projectPoint(H, p)), 1e-9, 'sheetPx');
    assert.deepEqual(truth.doorMm, { w: 820, h: 2040 });
    assert.deepEqual(truth.sheetMm, { w: 210, h: 297 });
    assert.deepEqual(truth.planeToImage, H);
  });

  test('flat view puts the corners exactly where the scale says', () => {
    const { truth } = flat;
    assertQuadClose(truth.doorPx, [{ x: 60, y: 50 }, { x: 265, y: 50 }, { x: 265, y: 560 }, { x: 60, y: 560 }], 1e-9, 'doorPx');
    assertQuadClose(
      truth.sheetPx,
      [{ x: 136.25, y: 187.875 }, { x: 188.75, y: 187.875 }, { x: 188.75, y: 262.125 }, { x: 136.25, y: 262.125 }],
      1e-9,
      'sheetPx',
    );
  });

  test('sceneTruth matches renderScene without rendering', () => {
    assert.deepEqual(sceneTruth(PERSPECTIVE), perspective.truth);
    assert.deepEqual(sceneTruth(FLAT), flat.truth);
  });

  test('a rotated sheet is rotated clockwise about its centre and re-ordered for the image', () => {
    const a = (20 * Math.PI) / 180;
    const rot = (lx, ly) => ({ x: 410 + lx * Math.cos(a) - ly * Math.sin(a), y: 700 + lx * Math.sin(a) + ly * Math.cos(a) });
    const expected = [rot(-105, -148.5), rot(105, -148.5), rot(105, 148.5), rot(-105, 148.5)].map((p) =>
      projectPoint(FLAT.planeToImage, p),
    );
    const tilted = sceneTruth({ ...FLAT, sheet: { rotDeg: 20 } });
    assertQuadClose(tilted.sheetPx, expected, 1e-9, 'sheetPx at 20 degrees');
    // Clockwise on screen means the top-right corner sits lower than the top-left one.
    assert.ok(tilted.sheetPx[1].y > tilted.sheetPx[0].y);

    const sideways = sceneTruth({ ...FLAT, sheet: { rotDeg: 90 } });
    const [tl, tr, br, bl] = sideways.sheetPx;
    closeTo(tr.x - tl.x, 297 * 0.25, 1e-9, 'landscape width in px');
    closeTo(bl.y - tl.y, 210 * 0.25, 1e-9, 'landscape height in px');
    closeTo(br.x - bl.x, 297 * 0.25, 1e-9, 'landscape bottom width in px');
    assert.ok(tl.x < tr.x && tl.y < bl.y, 'first corner is the top-left one in the image');
    assert.deepEqual(sideways.sheetMm, { w: 210, h: 297 }, 'sheetMm keeps the side lengths as given');
  });

  test('sheet: null renders a bare door', () => {
    const bare = renderScene({ ...FLAT, sheet: null });
    assert.equal(bare.truth.sheetPx, null);
    assert.equal(bare.truth.sheetMm, null);
    assert.deepEqual(rgbAt(bare.image, 162, 225), RGB.doorPanel);
  });

  test('custom door and sheet sizes flow through to the truth', () => {
    const truth = sceneTruth({ ...FLAT, doorMm: { w: 900, h: 2100 }, sheet: { cx: 450, cy: 650, w: 215.9, h: 279.4 } });
    assert.deepEqual(truth.doorMm, { w: 900, h: 2100 });
    assert.deepEqual(truth.sheetMm, { w: 215.9, h: 279.4 });
    closeTo(truth.doorPx[2].x, 60 + 900 * 0.25, 1e-9, 'door BR x');
    closeTo(truth.doorPx[2].y, 50 + 2100 * 0.25, 1e-9, 'door BR y');
    closeTo(truth.sheetPx[0].x, 60 + (450 - 107.95) * 0.25, 1e-9, 'sheet TL x');
  });

  test('planeToImage is required, and can be derived from a full camera pose', () => {
    assert.throws(() => renderScene({ width: 32, height: 32 }), /planeToImage/);
    assert.throws(() => renderScene(), /options/);
    assert.throws(() => renderScene({ width: 32, height: 32, planeToImage: [1, 0, 0, 0, 1, 0, 0, 0, 0] }), /singular/);
    const derived = sceneTruth({ width: 600, height: 800, camera: CAMERA });
    assert.deepEqual(derived.planeToImage, PERSPECTIVE.planeToImage);
  });
});

describe('renderScene pixels', () => {
  test('image has the requested size and is fully opaque RGBA', () => {
    const { image } = flat;
    assert.equal(image.width, 320);
    assert.equal(image.height, 640);
    assert.ok(image.data instanceof Uint8ClampedArray);
    assert.equal(image.data.length, 320 * 640 * 4);
    for (let i = 3; i < image.data.length; i += 4) assert.equal(image.data[i], 255);
  });

  test('materials land where the plane says they are', () => {
    const { image } = flat;
    const H = FLAT.planeToImage;
    assert.deepEqual(rgbAtPlane(image, H, { x: 410, y: 700 }), RGB.sheet, 'middle of the sheet');
    assert.deepEqual(rgbAtPlane(image, H, { x: 57, y: 1020 }), RGB.door, 'middle of the left stile');
    assert.deepEqual(rgbAtPlane(image, H, { x: 410, y: 60 }), RGB.door, 'top rail');
    assert.deepEqual(rgbAtPlane(image, H, { x: 410, y: 300 }), RGB.doorPanel, 'upper panel field');
    assert.deepEqual(rgbAtPlane(image, H, { x: 250, y: 1500 }), RGB.doorPanel, 'lower left panel field');
    assert.deepEqual(rgbAtPlane(image, H, { x: -35, y: 1000 }), RGB.architrave, 'left architrave leg');
    assert.deepEqual(rgbAtPlane(image, H, { x: 410, y: -35 }), RGB.architrave, 'architrave head');
    assert.deepEqual(rgbAtPlane(image, H, { x: 855, y: 1000 }), RGB.architrave, 'right architrave leg');
    assert.deepEqual(rgbAtPlane(image, H, { x: -160, y: 1000 }), RGB.wall, 'wall left of the frame');
    assert.deepEqual(rgbAtPlane(image, H, { x: 410, y: -140 }), RGB.wall, 'wall above the frame');
    assert.deepEqual(rgbAtPlane(image, H, { x: 410, y: 2120 }), RGB.step, 'step below the door');
    const ground = rgbAtPlane(image, H, { x: 410, y: 2330 });
    assert.ok([RGB.floor, RGB.floorJoint].some((c) => c.join() === ground.join()), `path below the step, got ${ground}`);
  });

  test('the handle sits on the lock rail of the right stile and can be switched off', () => {
    const H = FLAT.planeToImage;
    const spot = { x: 820 - 57.4, y: 0.53 * 2040 + 60 };
    assert.deepEqual(rgbAtPlane(flat.image, H, spot), [201, 162, 75], 'brass back plate');
    const plain = renderScene({ ...FLAT, handle: false });
    assert.deepEqual(rgbAtPlane(plain.image, H, spot), RGB.door);
  });

  test('sheet in the perspective view is the sheet colour, the stile is the door colour', () => {
    const { image, truth } = perspective;
    const H = PERSPECTIVE.planeToImage;
    const cx = Math.round(truth.sheetPx.reduce((s, p) => s + p.x, 0) / 4);
    const cy = Math.round(truth.sheetPx.reduce((s, p) => s + p.y, 0) / 4);
    assert.deepEqual(rgbAt(image, cx, cy), RGB.sheet);
    assert.deepEqual(rgbAtPlane(image, H, { x: 57, y: 1020 }), RGB.door);
    assert.deepEqual(rgbAtPlane(image, H, { x: 410, y: 420 }), RGB.doorPanel);
  });

  test('edges are anti-aliased with exact area coverage', () => {
    const { image } = flat;
    // The sheet's left edge is at x = 136.25; pixel 136 covers 135.5..136.5, so it is 3/4 panel, 1/4 sheet.
    assert.deepEqual(rgbAt(image, 135, 225), RGB.doorPanel);
    assert.deepEqual(rgbAt(image, 137, 225), RGB.sheet);
    const mixed = rgbAt(image, 136, 225);
    mixed.forEach((v, c) => closeTo(v, 0.75 * RGB.doorPanel[c] + 0.25 * RGB.sheet[c], 1, `blended channel ${c}`));
    // Right edge at 188.75: pixel 189 covers 188.5..189.5, so 1/4 sheet again.
    const right = rgbAt(image, 189, 225);
    right.forEach((v, c) => closeTo(v, 0.75 * RGB.doorPanel[c] + 0.25 * RGB.sheet[c], 1, `right edge channel ${c}`));
  });

  test('supersample: 1 gives hard edges', () => {
    const hard = renderScene({ ...FLAT, supersample: 1 });
    for (let x = 130; x <= 195; x++) {
      const px = rgbAt(hard.image, x, 225).join();
      assert.ok(px === RGB.doorPanel.join() || px === RGB.sheet.join(), `pixel ${x} is a pure material, got ${px}`);
    }
  });

  test('adaptive and brute-force supersampling agree around the sheet', () => {
    const brute = renderScene({ ...FLAT, adaptive: false });
    for (let y = 180; y <= 270; y++) {
      for (let x = 128; x <= 197; x++) {
        assert.deepEqual(rgbAt(flat.image, x, y), rgbAt(brute.image, x, y), `pixel ${x},${y}`);
      }
    }
  });

  test('rendered sheet edges sit on the truth edges to sub-pixel accuracy under perspective', () => {
    const { image, truth } = perspective;
    const [tl, tr, , bl] = truth.sheetPx;
    const coverage = (x, y) => (rgbAt(image, x, y)[0] - RGB.doorPanel[0]) / (RGB.sheet[0] - RGB.doorPanel[0]);
    let checked = 0;

    // Left edge: walk rows, integrate sheet coverage across the transition.
    for (let y = Math.ceil(tl.y) + 8; y <= Math.floor(bl.y) - 8; y += 5) {
      const edgeX = tl.x + ((bl.x - tl.x) * (y - tl.y)) / (bl.y - tl.y);
      const i1 = Math.floor(edgeX) + 3;
      let sum = 0;
      for (let x = i1 - 6; x <= i1; x++) sum += coverage(x, y);
      closeTo(i1 + 0.5 - sum, edgeX, 0.05, `left edge at row ${y}`);
      checked++;
    }
    // Top edge: walk columns.
    for (let x = Math.ceil(tl.x) + 8; x <= Math.floor(tr.x) - 8; x += 5) {
      const edgeY = tl.y + ((tr.y - tl.y) * (x - tl.x)) / (tr.x - tl.x);
      const j1 = Math.floor(edgeY) + 3;
      let sum = 0;
      for (let y = j1 - 6; y <= j1; y++) sum += coverage(x, y);
      closeTo(j1 + 0.5 - sum, edgeY, 0.05, `top edge at column ${x}`);
      checked++;
    }
    assert.ok(checked >= 15, 'enough edge samples were checked');
  });

  test("pixelOrigin: 'corner' shifts the raster by half a pixel but not the truth", () => {
    const corner = renderScene({ ...FLAT, pixelOrigin: 'corner' });
    assert.deepEqual(corner.truth, flat.truth);
    // Pixel 136 now covers 136..137, so the edge at 136.25 leaves it 1/4 panel, 3/4 sheet.
    const mixed = rgbAt(corner.image, 136, 225);
    mixed.forEach((v, c) => closeTo(v, 0.25 * RGB.doorPanel[c] + 0.75 * RGB.sheet[c], 1, `channel ${c}`));
    assert.throws(() => renderScene({ ...FLAT, pixelOrigin: 'middle' }), /pixelOrigin/);
  });

  test('blur softens edges and leaves flat areas alone', () => {
    const soft = renderScene({ ...FLAT, blurPx: 1.5 });
    const between = (image) => {
      let n = 0;
      for (let x = 126; x <= 146; x++) {
        const r = rgbAt(image, x, 225)[0];
        if (r > RGB.doorPanel[0] + 3 && r < RGB.sheet[0] - 3) n++;
      }
      return n;
    };
    assert.equal(between(flat.image), 1);
    assert.ok(between(soft.image) >= 4, 'a blurred edge spreads over several pixels');
    assert.deepEqual(rgbAt(soft.image, 162, 225), RGB.sheet);
    assert.deepEqual(rgbAt(soft.image, 10, 300), RGB.wall);
    // The blur is symmetric, so the half-way level stays on the edge (136.25).
    const cov = (x) => (rgbAt(soft.image, x, 225)[0] - RGB.doorPanel[0]) / (RGB.sheet[0] - RGB.doorPanel[0]);
    let sum = 0;
    for (let x = 126; x <= 146; x++) sum += cov(x);
    closeTo(146.5 - sum, 136.25, 0.05, 'edge position after blur');
  });

  test('noise is seeded, repeatable and roughly the requested sigma', () => {
    const a = renderScene({ ...FLAT, noiseSigma: 5, seed: 3 });
    const b = renderScene({ ...FLAT, noiseSigma: 5, seed: 3 });
    const c = renderScene({ ...FLAT, noiseSigma: 5, seed: 4 });
    assert.deepEqual(a.image.data, b.image.data);
    assert.notDeepEqual(a.image.data, c.image.data);
    // Wall patch left of the frame: flat colour in the clean render.
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let y = 100; y < 500; y++) {
      for (let x = 2; x < 40; x++) {
        for (let ch = 0; ch < 3; ch++) {
          const d = a.image.data[(y * 320 + x) * 4 + ch] - flat.image.data[(y * 320 + x) * 4 + ch];
          n++;
          sum += d;
          sumSq += d * d;
        }
      }
    }
    const mean = sum / n;
    closeTo(mean, 0, 0.15, 'noise mean');
    closeTo(Math.sqrt(sumSq / n - mean * mean), 5, 0.4, 'noise sigma');
  });

  test('lighting adds smooth shading without moving any edge, and 0 switches it off', () => {
    const lit = renderScene({ ...FLAT, lighting: 1 });
    // Lit from the upper left: the top of the wall is brighter than the bottom.
    assert.ok(lumaAt(lit.image, 20, 60) > lumaAt(lit.image, 20, 520) + 3);
    // The door darkens towards the bottom too.
    assert.ok(lumaAt(lit.image, 74, 150) > lumaAt(lit.image, 74, 500) + 3);
    // Soft contact shadow just below the sheet darkens the panel there.
    assert.ok(lumaAt(lit.image, 162, 265) < lumaAt(lit.image, 162, 285) - 2);
    // The sheet stays far brighter than the door around it and its edge has not moved.
    assert.ok(lumaAt(lit.image, 162, 225) - lumaAt(lit.image, 120, 225) > 150);
    const lo = lumaAt(lit.image, 133, 225);
    const hi = lumaAt(lit.image, 139, 225);
    let sum = 0;
    for (let x = 133; x <= 139; x++) sum += (lumaAt(lit.image, x, 225) - lo) / (hi - lo);
    closeTo(139.5 - sum, 136.25, 0.06, 'left sheet edge under lighting');
  });

  test('a camera with a focal length gives real 3D ground; without one the step is drawn flat', () => {
    const H = PERSPECTIVE.planeToImage;
    // 300 mm "below" the threshold in the door plane: with a camera the ray meets the front of the
    // step first; in the flat fallback that spot is already path.
    const spot = { x: 410, y: 2040 + 300 };
    assert.deepEqual(rgbAtPlane(perspective.image, H, spot), RGB.step, '3D: front face of the step');
    assert.deepEqual(rgbAtPlane(perspective.image, H, { x: 410, y: 2040 + 40 }), RGB.step, '3D: top of the step');
    const beside = rgbAtPlane(perspective.image, H, { x: -420, y: 2040 + 300 });
    assert.ok([RGB.floor, RGB.floorJoint].some((c) => c.join() === beside.join()), `3D: path beside the step, got ${beside}`);
    assert.deepEqual(rgbAtPlane(perspective.image, H, { x: -420, y: 2040 + 100 }), RGB.wall, '3D: wall runs down to the path');

    const { camera, ...noCamera } = PERSPECTIVE;
    const flatGround = renderScene(noCamera);
    const below = rgbAtPlane(flatGround.image, H, spot);
    assert.ok([RGB.floor, RGB.floorJoint].some((c) => c.join() === below.join()), `flat: path, got ${below}`);
    assert.deepEqual(rgbAtPlane(flatGround.image, H, { x: 410, y: 2040 + 40 }), RGB.step, 'flat: step band');
    // Everything in the door plane above the threshold is identical either way.
    for (let my = -250; my <= 2030; my += 40) {
      for (let mx = -700; mx <= 1500; mx += 37) {
        const q = projectPoint(H, { x: mx, y: my });
        const x = Math.round(q.x);
        const y = Math.round(q.y);
        if (x < 0 || y < 0 || x >= 600 || y >= 800) continue;
        assert.deepEqual(rgbAt(flatGround.image, x, y), rgbAt(perspective.image, x, y), `plane point ${mx},${my}`);
      }
    }
  });

  test('decor never covers the door opening, the frame or the sheet', () => {
    // Second view: standing well to the left, where the pot plant is between the camera and the door.
    const steepCamera = { focalPx: 700, target: { x: 410, y: 1000 }, distanceMm: 2600, yawDeg: -38, pitchDeg: 6, rollDeg: -2 };
    const steep = {
      ...PERSPECTIVE,
      camera: steepCamera,
      planeToImage: cameraHomography({ imageWidth: 600, imageHeight: 800, ...steepCamera }),
      // Sheet on the wall beside the plant rather than on the door.
      sheet: { cx: -330, cy: 1900, color: '#ffffff' },
    };
    for (const base of [PERSPECTIVE, steep]) {
      const plain = renderScene({ ...base, lighting: 1, decor: false });
      const dressed = renderScene({ ...base, lighting: 1, decor: true });
      const H = base.planeToImage;
      let differing = 0;
      for (let i = 0; i < plain.image.data.length; i += 4) if (plain.image.data[i] !== dressed.image.data[i]) differing++;
      assert.ok(differing > 500, 'decor draws something');
      const same = (mx, my) => {
        const q = projectPoint(H, { x: mx, y: my });
        const x = Math.round(q.x);
        const y = Math.round(q.y);
        if (x < 0 || y < 0 || x >= 600 || y >= 800) return;
        assert.deepEqual(rgbAt(dressed.image, x, y), rgbAt(plain.image, x, y), `plane point ${mx},${my}`);
      };
      // The opening plus the architrave, on a grid.
      for (let my = -60; my <= 2030; my += 55) for (let mx = -60; mx <= 880; mx += 47) same(mx, my);
      // The sheet, wherever it is.
      const s = { cx: 410, cy: 700, ...base.sheet };
      for (let my = s.cy - 140; my <= s.cy + 140; my += 20) for (let mx = s.cx - 98; mx <= s.cx + 98; mx += 14) same(mx, my);
    }
  });

  test('rendering does not mutate its options', () => {
    const opts = structuredClone({ ...PERSPECTIVE, decor: true, lighting: 1 });
    const before = structuredClone(opts);
    renderScene(opts);
    assert.deepEqual(opts, before);
  });
});

describe('encodePng', () => {
  const gradient = (width, height, alpha = () => 255) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = (x * 255) / Math.max(1, width - 1);
        data[i + 1] = (y * 255) / Math.max(1, height - 1);
        data[i + 2] = (x * 7 + y * 13) % 256;
        data[i + 3] = alpha(x, y);
      }
    }
    return { data, width, height };
  };

  test('writes a valid signature, IHDR and chunk CRCs', () => {
    const png = encodePng(gradient(7, 5));
    assert.ok(Buffer.isBuffer(png));
    assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE);
    const chunks = readChunks(png);
    assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
    assert.ok(chunks.every((c) => c.crcOk), 'every chunk CRC is correct');
    const ihdr = chunks[0].data;
    assert.equal(ihdr.length, 13);
    assert.equal(ihdr.readUInt32BE(0), 7);
    assert.equal(ihdr.readUInt32BE(4), 5);
    assert.equal(ihdr[8], 8, 'bit depth');
    assert.equal(ihdr[9], 2, 'opaque image is stored as truecolour RGB');
    assert.deepEqual([...ihdr.subarray(10)], [0, 0, 0], 'deflate, adaptive filtering, no interlace');
    assert.equal(chunks[2].data.length, 0);
  });

  test('image data inflates to one filter byte plus the pixels per row', () => {
    const rgb = readChunks(encodePng(gradient(7, 5)));
    const raw = zlib.inflateSync(rgb[1].data);
    assert.equal(raw.length, (7 * 3 + 1) * 5);
    for (let y = 0; y < 5; y++) assert.ok(raw[y * 22] <= 4, 'filter type 0..4');

    const translucent = gradient(7, 5, (x, y) => (x === 3 && y === 2 ? 10 : 255));
    const rgba = readChunks(encodePng(translucent));
    assert.equal(rgba[0].data[9], 6, 'any transparency switches to RGBA');
    assert.equal(zlib.inflateSync(rgba[1].data).length, (7 * 4 + 1) * 5);
  });

  test('round-trips exactly through decodePng', () => {
    const opaque = gradient(31, 17);
    assert.deepEqual(decodePng(encodePng(opaque)), opaque);
    const translucent = gradient(31, 17, (x, y) => (x * 9 + y * 5) % 256);
    assert.deepEqual(decodePng(encodePng(translucent)), translucent);
    assert.deepEqual(decodePng(encodePng(flat.image)), flat.image);
    assert.deepEqual(decodePng(encodePng({ data: new Uint8ClampedArray([1, 2, 3, 255]), width: 1, height: 1 })).data, new Uint8ClampedArray([1, 2, 3, 255]));
  });

  test('accepts tightly packed RGB input', () => {
    const png = encodePng({ data: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 8, 7]), width: 2, height: 2 });
    assert.deepEqual([...decodePng(png).data], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 8, 7, 255]);
  });

  test('filtering makes smooth gradients tiny', () => {
    const width = 256;
    const height = 256;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = x;
        data[i + 1] = y;
        data[i + 2] = (x + y) >> 1;
        data[i + 3] = 255;
      }
    }
    const png = encodePng({ data, width, height });
    assert.ok(png.length < (width * height * 3) / 50, `gradient PNG is ${png.length} bytes`);
    assert.deepEqual(decodePng(png).data, data);
  });

  test('is deterministic and rejects mismatched sizes', () => {
    assert.ok(encodePng(flat.image).equals(encodePng(flat.image)));
    assert.throws(() => encodePng({ data: new Uint8ClampedArray(10), width: 2, height: 2 }), /length/);
    assert.throws(() => encodePng({ data: new Uint8ClampedArray(0), width: 0, height: 2 }), /positive/);
    assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
  });
});

describe('demo assets', () => {
  const pngBytes = readFileSync(new URL('../assets/demo-door.png', import.meta.url));
  const truthJson = JSON.parse(readFileSync(new URL('../assets/demo-door.truth.json', import.meta.url), 'utf8'));
  const demoTruth = sceneTruth(DEMO_SCENE);
  const demoImage = decodePng(pngBytes);
  // The demo is rasterised in the canvas convention: pixel i covers i .. i + 1, so the pixel holding the
  // continuous coordinate x is floor(x), and pixel i's centre is at i + 0.5.
  const pixelOf = (v) => Math.floor(v);
  const PIXEL_CENTRE = 0.5;

  test('DEMO_SCENE describes the photo the brief asks for', () => {
    assert.equal(DEMO_SCENE.width, 1536);
    assert.equal(DEMO_SCENE.height, 2048);
    assert.deepEqual(DEMO_SCENE.doorMm, { w: 820, h: 2040 });
    assert.equal(DEMO_SCENE.sheet.w, 210);
    assert.equal(DEMO_SCENE.sheet.h, 297);
    assert.equal(DEMO_SCENE.sheet.rotDeg, 0);
    assert.equal(DEMO_SCENE.sheet.cx, 410);
    closeTo(DEMO_SCENE.sheet.cy, 700, 50, 'sheet centre height');
    closeTo(DEMO_SCENE.camera.distanceMm, 2900, 150, 'camera distance');
    assert.ok(Math.abs(DEMO_SCENE.camera.yawDeg) >= 2 && Math.abs(DEMO_SCENE.camera.yawDeg) <= 10);
    assert.ok(Math.abs(DEMO_SCENE.camera.pitchDeg) >= 2 && Math.abs(DEMO_SCENE.camera.pitchDeg) <= 10);
    assert.equal(DEMO_SCENE.noiseSigma, 0, 'no noise, so the PNG stays small and repeatable');
    assert.equal(DEMO_SCENE.pixelOrigin, 'corner', 'canvas pixel convention, the one js/vision.js and the editor use');
    assert.ok(Object.isFrozen(DEMO_SCENE) && Object.isFrozen(DEMO_SCENE.sheet) && Object.isFrozen(DEMO_SCENE.planeToImage));
    assert.deepEqual(
      [...DEMO_SCENE.planeToImage],
      cameraHomography({ imageWidth: 1536, imageHeight: 2048, ...DEMO_SCENE.camera }),
      'planeToImage is exactly the camera in DEMO_SCENE.camera',
    );
  });

  test('door fills 70-75% of the height with clear margins and mild perspective', () => {
    const [tl, tr, br, bl] = demoTruth.doorPx;
    const leftPx = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const rightPx = Math.hypot(br.x - tr.x, br.y - tr.y);
    const topPx = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const bottomPx = Math.hypot(br.x - bl.x, br.y - bl.y);
    const fill = (leftPx + rightPx) / 2 / 2048;
    assert.ok(fill >= 0.7 && fill <= 0.75, `door fills ${(fill * 100).toFixed(1)}% of the image height`);
    for (const p of demoTruth.doorPx) {
      assert.ok(p.x >= 0.06 * 1536 && p.x <= 0.94 * 1536, `corner x ${p.x} is clear of the border`);
      assert.ok(p.y >= 0.06 * 2048 && p.y <= 0.94 * 2048, `corner y ${p.y} is clear of the border`);
    }
    const sideRatio = Math.max(leftPx, rightPx) / Math.min(leftPx, rightPx);
    const widthRatio = Math.max(topPx, bottomPx) / Math.min(topPx, bottomPx);
    assert.ok(sideRatio > 1.005 && sideRatio < 1.1, `left/right ratio ${sideRatio}`);
    assert.ok(widthRatio > 1.005 && widthRatio < 1.1, `top/bottom ratio ${widthRatio}`);
    // Sheet centre is inside the door and the sheet is comfortably large for corner refinement.
    const [stl, str, , sbl] = demoTruth.sheetPx;
    assert.ok(Math.hypot(str.x - stl.x, str.y - stl.y) > 120, 'sheet short side is well over 60 px');
    assert.ok(Math.hypot(sbl.x - stl.x, sbl.y - stl.y) > Math.hypot(str.x - stl.x, str.y - stl.y), 'sheet is portrait');
  });

  test('committed PNG is a valid 1536 x 2048 image under 1.2 MB', () => {
    assert.deepEqual([...pngBytes.subarray(0, 8)], PNG_SIGNATURE);
    const chunks = readChunks(pngBytes);
    assert.equal(chunks[0].type, 'IHDR');
    assert.equal(chunks[0].data.readUInt32BE(0), 1536);
    assert.equal(chunks[0].data.readUInt32BE(4), 2048);
    assert.equal(chunks[0].data[8], 8);
    assert.ok(chunks.every((c) => c.crcOk));
    assert.equal(chunks.at(-1).type, 'IEND');
    assert.ok(pngBytes.length < 1.2 * 1024 * 1024, `demo PNG is ${pngBytes.length} bytes`);
    assert.equal(demoImage.width, 1536);
    assert.equal(demoImage.height, 2048);
  });

  test('truth JSON matches DEMO_SCENE', () => {
    assert.deepEqual(Object.keys(truthJson).sort(), ['doorPx', 'heightMm', 'imageHeight', 'imageWidth', 'sheetMm', 'sheetPx', 'widthMm']);
    assert.equal(truthJson.widthMm, 820);
    assert.equal(truthJson.heightMm, 2040);
    assert.deepEqual(truthJson.sheetMm, { w: 210, h: 297 });
    assert.equal(truthJson.imageWidth, 1536);
    assert.equal(truthJson.imageHeight, 2048);
    assertQuadClose(truthJson.doorPx, demoTruth.doorPx, 1e-3, 'doorPx');
    assertQuadClose(truthJson.sheetPx, demoTruth.sheetPx, 1e-3, 'sheetPx');
    assert.deepEqual(truthToJson(demoTruth, DEMO_SCENE), truthJson, 'file is exactly what make-demo writes');
  });

  test('committed PNG is the DEMO_SCENE render', () => {
    const { image, truth } = renderScene(DEMO_SCENE);
    assert.deepEqual(truth, demoTruth);
    assert.equal(image.data.length, demoImage.data.length);
    // Allow one level of slack so a different libm cannot fail this; a stale asset differs by far more.
    let worst = 0;
    for (let i = 0; i < image.data.length; i++) {
      const d = Math.abs(image.data[i] - demoImage.data[i]);
      if (d > worst) worst = d;
    }
    assert.ok(worst <= 1, `largest difference from a fresh render is ${worst} levels`);
  });

  test('demo photo has strong contrast where the app needs it', () => {
    const H = DEMO_SCENE.planeToImage;
    const lumaAtPlane = (p) => {
      const q = projectPoint(H, p);
      return lumaAt(demoImage, pixelOf(q.x), pixelOf(q.y));
    };
    const sheet = lumaAtPlane({ x: 410, y: 700 });
    assert.ok(sheet > 235, `sheet is near white (${sheet})`);
    // All round the sheet, 25 mm outside its outline, the door is dark.
    for (const p of [{ x: 280, y: 700 }, { x: 540, y: 700 }, { x: 410, y: 526 }, { x: 410, y: 874 }, { x: 280, y: 526 }, { x: 540, y: 874 }]) {
      assert.ok(sheet - lumaAtPlane(p) > 150, `sheet vs door at ${p.x},${p.y}`);
    }
    // Door leaf against the white architrave on every side, and against the step below.
    assert.ok(lumaAtPlane({ x: -35, y: 1020 }) - lumaAtPlane({ x: 40, y: 1020 }) > 130, 'left jamb');
    assert.ok(lumaAtPlane({ x: 855, y: 1020 }) - lumaAtPlane({ x: 800, y: 600 }) > 130, 'right jamb');
    assert.ok(lumaAtPlane({ x: 410, y: -35 }) - lumaAtPlane({ x: 410, y: 60 }) > 130, 'head');
    // Just in front of the threshold (below the door's bottom edge in the image) is pale stone.
    const bottom = projectPoint(H, { x: 60, y: 2040 });
    const stone = lumaAt(demoImage, pixelOf(bottom.x), pixelOf(bottom.y) + 8);
    assert.ok(stone - lumaAtPlane({ x: 60, y: 2000 }) > 60, 'threshold');
  });

  test('a flood fill from the middle of the demo sheet stops at its outline', () => {
    // The crudest possible sheet detector: if this leaks or stalls, the photo is a poor demo.
    const { width, height } = demoImage;
    const quad = demoTruth.sheetPx;
    const seedX = pixelOf((quad[0].x + quad[2].x) / 2);
    const seedY = pixelOf((quad[0].y + quad[2].y) / 2);
    const seedLuma = lumaAt(demoImage, seedX, seedY);
    const seen = new Uint8Array(width * height);
    const stack = [seedY * width + seedX];
    seen[stack[0]] = 1;
    let area = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p - x) / width;
      area++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (seen[q] || Math.abs(lumaAt(demoImage, nx, ny) - seedLuma) > 60) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    let quadArea = 0;
    for (let i = 0; i < 4; i++) quadArea += quad[i].x * quad[(i + 1) % 4].y - quad[(i + 1) % 4].x * quad[i].y;
    quadArea = Math.abs(quadArea) / 2;
    closeTo(area, quadArea, quadArea * 0.02, 'filled area vs sheet area');
    // Filled pixels minX..maxX cover the continuous span minX .. maxX + 1.
    closeTo(minX, Math.min(quad[0].x, quad[3].x), 1.5, 'left extent');
    closeTo(maxX + 1, Math.max(quad[1].x, quad[2].x), 1.5, 'right extent');
    closeTo(minY, Math.min(quad[0].y, quad[1].y), 1.5, 'top extent');
    closeTo(maxY + 1, Math.max(quad[2].y, quad[3].y), 1.5, 'bottom extent');
  });

  test('demo sheet outline in the PNG sits on the truth quad', () => {
    // Where the profile across each edge crosses from door to sheet (by integrating coverage over a
    // short window), compared with the truth edge at several places along it. The soft contact shadow
    // just outside the paper darkens the "door" side towards the edge, which biases this simple
    // estimator by up to about 0.08 px depending on where the edge falls within a pixel (flat-lit, the
    // same measurement is within 0.03 px), hence a tenth of a pixel.
    const tol = 0.1;
    const [tl, tr, br, bl] = demoTruth.sheetPx;
    const edgeFrom = (get, expected) => {
      const from = pixelOf(expected) - 3;
      const to = pixelOf(expected) + 3;
      const rising = get(to) > get(from);
      const dark = rising ? get(from) : get(to);
      const light = rising ? get(to) : get(from);
      let sum = 0;
      for (let i = from; i <= to; i++) sum += (get(i) - dark) / (light - dark);
      // Pixels from..to span from .. to + 1; `sum` pixels' worth of that span is sheet.
      return rising ? to + 1 - sum : from + sum;
    };
    const along = (a, b, t) => a + (b - a) * t;
    for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const rowIndex = pixelOf(along(tl.y, bl.y, t));
      const columnIndex = pixelOf(along(tl.x, tr.x, t));
      // A pixel row / column samples the scene along the line through its pixel centres.
      const y = rowIndex + PIXEL_CENTRE;
      const x = columnIndex + PIXEL_CENTRE;
      const leftX = along(tl.x, bl.x, (y - tl.y) / (bl.y - tl.y));
      const rightX = along(tr.x, br.x, (y - tr.y) / (br.y - tr.y));
      const topY = along(tl.y, tr.y, (x - tl.x) / (tr.x - tl.x));
      const bottomY = along(bl.y, br.y, (x - bl.x) / (br.x - bl.x));
      const row = (i) => lumaAt(demoImage, i, rowIndex);
      const col = (j) => lumaAt(demoImage, columnIndex, j);
      closeTo(edgeFrom(row, leftX), leftX, tol, `left edge at row ${rowIndex}`);
      closeTo(edgeFrom(row, rightX), rightX, tol, `right edge at row ${rowIndex}`);
      closeTo(edgeFrom(col, topY), topY, tol, `top edge at column ${columnIndex}`);
      closeTo(edgeFrom(col, bottomY), bottomY, tol, `bottom edge at column ${columnIndex}`);
    }
  });
});
