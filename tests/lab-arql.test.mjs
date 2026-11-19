/**
 * AR Quick Look lab page (lab/arql/): the pure modules only. USDZ packing (exact 64-byte alignment),
 * the PNG fallback encoder, the bitmap font, the USD scene builders' geometry, the Quick Look link
 * fragment, the results maths, and that the committed static models match what the page builds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import config from '../js/config.js';
import { DEFAULT_STANDARD_SIZES, standardSizesFrom } from '../js/estimate.js';
import { decodePng } from '../tools/scene.mjs';
import { USDZ_ALIGN, crc32, entryBytes, makeUsdz, paddingFor, readEocd, readZip, utf8 } from '../lab/arql/usdz.js';
import { adler32, encodePng } from '../lab/arql/png.js';
import { createImage, drawText, fillRect, hashImage, textSize } from '../lab/arql/raster.js';
import {
  ANCHORINGS,
  STATIC_VARIANTS,
  buildDesign,
  catalogue,
  floorRuler,
  grid,
  outline,
  outlineFragment,
  quickLookFragment,
  staticFileFor,
  tapeL,
  variantKey,
  withFragment,
} from '../lab/arql/gauge.js';
import {
  arSize,
  computeRow,
  flowTruth,
  goNoGo,
  isProductSetup,
  percentile,
  rowUse,
  sameSize,
  standardForTape,
  summarize,
  summarizeFlow,
  timeAway,
  timeAwayAll,
} from '../lab/arql/stats.js';
import { MAX_USDZ_BYTES, variantOptions } from '../lab/arql/make-static.mjs';

const MODELS = fileURLToPath(new URL('../lab/arql/models/', import.meta.url));
const EPS = 1e-9;

// ---- helpers ------------------------------------------------------------------------------------

function bytesOf(n, seed) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  return b;
}

/** Every Mesh in a USDA: name, bound material, points. */
function meshes(usda) {
  const out = [];
  const re = /def Mesh "([^"]+)"[\s\S]*?rel material:binding = <([^>]+)>[\s\S]*?point3f\[\] points = \[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(usda))) {
    out.push({ name: m[1], material: m[2], points: [...m[3].matchAll(/\(([^)]*)\)/g)].map((p) => p[1].split(',').map(Number)) });
  }
  return out;
}

/** The axis-aligned boxes of every line mesh (24 points each), as { x0, x1, y0, y1, z0, z1, mesh }. */
function boxes(usda) {
  const out = [];
  for (const mesh of meshes(usda).filter((x) => x.name.startsWith('Bars_'))) {
    assert.equal(mesh.points.length % 24, 0, `${mesh.name} is made of whole boxes`);
    for (let i = 0; i < mesh.points.length; i += 24) {
      const pts = mesh.points.slice(i, i + 24);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const zs = pts.map((p) => p[2]);
      out.push({ mesh: mesh.name, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0: Math.min(...zs), z1: Math.max(...zs) });
    }
  }
  return out;
}

function near(a, b) {
  return Math.abs(a - b) < EPS;
}

// ---- checksums ----------------------------------------------------------------------------------

test('crc32 and adler32 match their published check values', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(adler32('Wikipedia'), 0x11e60398);
  assert.equal(adler32(new Uint8Array(0)), 1);
  // Long input: past zlib's NMAX block, against node:zlib's own checksum where available.
  const big = bytesOf(200_000, 3);
  if (typeof zlib.crc32 === 'function') assert.equal(crc32(big), zlib.crc32(big));
  const viaZlib = zlib.deflateSync(big, { level: 0 });
  assert.equal(adler32(big), viaZlib.readUInt32BE(viaZlib.length - 4));
});

// ---- makeUsdz -----------------------------------------------------------------------------------

test('paddingFor gives 0 or 4..67 bytes and always lands on 64', () => {
  for (let offset = 0; offset < 200; offset += 7) {
    for (let nameLen = 1; nameLen < 80; nameLen++) {
      const pad = paddingFor(offset, nameLen);
      assert.ok(pad === 0 || (pad >= 4 && pad <= USDZ_ALIGN + 3), `pad ${pad}`);
      assert.equal((offset + 30 + nameLen + pad) % USDZ_ALIGN, 0);
    }
  }
});

test('makeUsdz round-trips through readZip with every entry stored, 64-aligned and CRC-correct', () => {
  for (const count of [1, 2, 20]) {
    const entries = [{ path: 'scene.usda', bytes: utf8('#usda 1.0\n') }];
    for (let i = 1; i < count; i++) {
      // Assorted name lengths, so the padding needed runs through 0, 1-3 (needs 65-67) and the rest.
      const name = `textures/${'n'.repeat((i * 5) % 23)}${i}.png`;
      entries.push({ path: name, bytes: bytesOf((i * 97) % 300 + i, i) });
    }
    const zip = makeUsdz(entries);
    const list = readZip(zip);
    assert.equal(list.length, count);
    assert.equal(list[0].path, 'scene.usda', 'the root layer comes first');
    list.forEach((e, i) => {
      assert.equal(e.path, entries[i].path);
      assert.equal(e.dataOffset % 64, 0, `${e.path} data at ${e.dataOffset}`);
      assert.equal(e.method, 0);
      assert.equal(e.size, entries[i].bytes.length);
      assert.ok(e.crcOk);
      assert.equal(e.crc, crc32(entries[i].bytes));
      if (typeof zlib.crc32 === 'function') assert.equal(e.crc, zlib.crc32(entries[i].bytes));
      assert.equal(e.flags & 0x08, 0, 'no data descriptor');
      assert.ok(e.localExtraLen === 0 || e.localExtraLen >= 4);
      assert.deepEqual([...entryBytes(zip, e)], [...entries[i].bytes]);
    });
    const eocd = readEocd(zip);
    assert.equal(eocd.count, count);
    assert.equal(eocd.offset + 22, zip.length);
    assert.equal(eocd.centralOffset + eocd.centralSize, eocd.offset);
    const view = new DataView(zip.buffer, zip.byteOffset);
    assert.equal(view.getUint32(eocd.centralOffset, true), 0x02014b50, 'central directory starts where the EOCD says');
    const lastLocalEnd = list[count - 1].dataOffset + list[count - 1].size;
    assert.equal(eocd.centralOffset, lastLocalEnd);
  }
});

test('makeUsdz puts scene.usda first wherever it is listed, and refuses bad input', () => {
  const zip = makeUsdz([
    { path: 'textures/a.png', bytes: bytesOf(10, 1) },
    { path: 'scene.usda', bytes: utf8('#usda 1.0\n') },
  ]);
  assert.deepEqual(readZip(zip).map((e) => e.path), ['scene.usda', 'textures/a.png']);
  assert.throws(() => makeUsdz([{ path: 'textures/a.png', bytes: bytesOf(1, 1) }]), /scene\.usda/);
  assert.throws(() => makeUsdz([{ path: 'scene.usda', bytes: utf8('x') }, { path: 'scene.usda', bytes: utf8('y') }]), /twice/);
  assert.throws(() => makeUsdz([{ path: '../scene.usda', bytes: utf8('x') }]), /bad entry path/);
  assert.throws(() => makeUsdz([{ path: 'scene.usda', bytes: 'text' }]), /no bytes/);
});

// ---- png.js -------------------------------------------------------------------------------------

function pngChunks(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  for (let pos = 8; pos < png.length; ) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    chunks.push({ type, body: png.subarray(pos + 8, pos + 8 + len), crc: view.getUint32(pos + 8 + len), crcOk: crc32(png.subarray(pos + 4, pos + 8 + len)) === view.getUint32(pos + 8 + len) });
    pos += 12 + len;
  }
  return chunks;
}

test('encodePng writes a valid PNG whose IDAT inflates to h x (1 + bpp x w) bytes', () => {
  for (const opaque of [true, false]) {
    const w = 37;
    const h = 300; // over 65535 raw bytes, so more than one stored block
    const img = createImage(w, h, [10, 20, 30]);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = i & 0xff;
      img.data[i + 1] = (i >> 8) & 0xff;
      if (!opaque) img.data[i + 3] = (i >> 2) & 0xff;
    }
    if (!opaque) img.data[3] = 7;
    const png = encodePng(img);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = pngChunks(png);
    assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
    assert.ok(chunks.every((c) => c.crcOk), 'every chunk CRC is right');
    const ihdr = new DataView(chunks[0].body.buffer, chunks[0].body.byteOffset, 13);
    assert.equal(ihdr.getUint32(0), w);
    assert.equal(ihdr.getUint32(4), h);
    assert.deepEqual([...chunks[0].body.subarray(8)], [8, opaque ? 2 : 6, 0, 0, 0]);
    const bpp = opaque ? 3 : 4;
    assert.equal(zlib.inflateSync(chunks[1].body).length, h * (1 + bpp * w));
    const back = decodePng(png);
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.deepEqual([...back.data], [...img.data], 'pixels survive the round trip');
  }
});

// ---- raster.js ----------------------------------------------------------------------------------

test('drawText is deterministic and clips at the edges without throwing', () => {
  const a = createImage(64, 16);
  const b = createImage(64, 16);
  drawText(a, '2040', 1, 1, { scale: 2 });
  drawText(b, '2040', 1, 1, { scale: 2 });
  assert.equal(hashImage(a), hashImage(b));
  assert.equal(hashImage(a), 0x0f47c0a5, 'the 5 x 7 font has not changed');
  assert.deepEqual(textSize('2040', 2), { width: 46, height: 14 });
  assert.notEqual(hashImage(a), hashImage(createImage(64, 16)));

  const c = createImage(10, 10);
  assert.doesNotThrow(() => {
    drawText(c, '820 x 2040', -7, -3, { scale: 3 });
    drawText(c, 'ABC.-/x', 8, 8, { scale: 2 });
    fillRect(c, -50, -1, 500, 3, [255, 0, 0]);
    fillRect(c, 5, 5, Infinity, 2, [0, 0, 255]);
    drawText(c, '?', 0, 0);
  });
  assert.deepEqual([...c.data.subarray(0, 4)], [255, 0, 0, 255], 'clipped fill still drew its visible part');
  assert.equal(c.data.length, 400);
});

// ---- builders -----------------------------------------------------------------------------------

test('every design has the Quick Look header, the three.js prim layout and resolvable references', () => {
  for (const design of ['A', 'B', 'C', 'D', 'E']) {
    const scene = buildDesign(design);
    const { usda, textures } = scene;
    assert.match(usda, /^#usda 1\.0\n/);
    assert.match(usda, /defaultPrim = "Root"/);
    assert.match(usda, /metersPerUnit = 1\n/);
    assert.match(usda, /upAxis = "Y"/);
    assert.match(usda, /def Xform "Root"\n\{\n\tdef Scope "Scenes" \(\n\t\tkind = "sceneLibrary"\n\t\)/);
    assert.match(usda, /def Xform "Scene" \(\n\t\t\tcustomData = \{\n\t\t\t\tbool preliminary_collidesWithEnvironment = 0\n\t\t\t\tstring sceneName = "Scene"\n\t\t\t\}\n\t\t\tsceneName = "Scene"/);
    assert.match(usda, /\ndef Scope "Materials"\n/);
    assert.doesNotMatch(usda, /opacity = 0\.|opacityThreshold/, 'nothing transparent');
    const materials = new Set([...usda.matchAll(/def Material "([^"]+)"/g)].map((m) => `/Materials/${m[1]}`));
    const bindings = [...usda.matchAll(/rel material:binding = <([^>]+)>/g)].map((m) => m[1]);
    assert.ok(bindings.length > 0);
    for (const b of bindings) assert.ok(materials.has(b), `${design}: binding ${b} exists`);
    const files = [...usda.matchAll(/@(textures\/[^@]+)@/g)].map((m) => m[1]);
    const paths = new Set(textures.map((t) => t.path));
    for (const f of files) assert.ok(paths.has(f), `${design}: ${f} is packed`);
    assert.equal(files.length, paths.size, 'every texture is used');
    for (const t of textures) {
      assert.ok(Math.max(t.image.width, t.image.height) <= 1024, `${t.path} at most 1024 px`);
      assert.equal(t.image.data.length, t.image.width * t.image.height * 4);
    }
    for (const m of usda.matchAll(/emissiveColor = (\([^)]*\))/g)) {
      assert.match(usda, new RegExp(`diffuseColor = ${m[1].replace(/[()]/g, '\\$&')}`), 'emissive equals diffuse');
    }
    assert.ok((usda.match(/UsdPrimvarReader_float2/g) || []).length === textures.length);
  }
});

test('anchoring tokens are written for vertical and horizontal and left out for none', () => {
  for (const anchoring of ANCHORINGS) {
    const { usda } = outline({ anchoring });
    const type = /token preliminary:anchoring:type = "plane"/.test(usda);
    const align = usda.match(/token preliminary:planeAnchoring:alignment = "(\w+)"/);
    if (anchoring === 'none') {
      assert.equal(type, false);
      assert.equal(align, null);
    } else {
      assert.equal(type, true);
      assert.equal(align[1], anchoring);
    }
  }
  assert.match(floorRuler().usda, /alignment = "horizontal"/, 'the floor ruler defaults to horizontal');
});

test('outline(820, 2040): the opening edges are exactly 0, 0.82, 0 and 2.04, and no bar is inside it', () => {
  const { usda } = outline({ widthMm: 820, heightMm: 2040 });
  const b = boxes(usda);
  assert.equal(b.length, 4);
  const left = b.find((x) => x.x1 <= 0 && x.y1 > 1);
  const right = b.find((x) => x.x0 >= 0.8);
  const top = b.find((x) => x.y0 >= 2);
  const bottom = b.find((x) => x.y1 <= 0 && x.x1 > 0.5);
  assert.ok(near(left.x1, 0), `left inner edge ${left.x1}`);
  assert.ok(near(right.x0, 0.82), `right inner edge ${right.x0}`);
  assert.ok(near(bottom.y1, 0), `sill edge ${bottom.y1}`);
  assert.ok(near(top.y0, 2.04), `head edge ${top.y0}`);
  for (const x of b) assert.ok(near(Math.min(x.x1 - x.x0, x.y1 - x.y0), 0.025), 'bars are 25 mm wide');
  for (const mesh of meshes(usda).filter((m) => m.name.startsWith('Bars_'))) {
    for (const [x, y] of mesh.points) {
      assert.ok(!(x > EPS && x < 0.82 - EPS && y > EPS && y < 2.04 - EPS), `bar vertex (${x}, ${y}) inside the opening`);
    }
  }
  const all = meshes(usda).flatMap((m) => m.points);
  assert.ok(all.every((p) => p[2] >= 0), 'nothing behind the wall plane');
  assert.ok(boxes(usda).every((x) => near(x.z1 - x.z0, 0.003)), 'lines are 3 mm deep');
});

test('tapeL ticks have their lower (or left) edge exactly on k x 10 mm', () => {
  const { usda, meta } = tapeL();
  const b = boxes(usda);
  const upright = b.filter((x) => near(x.x0, 0) && x.y1 - x.y0 < 0.005 && x.y0 >= 0);
  const sill = b.filter((x) => near(x.y0, 0) && x.x1 - x.x0 < 0.005 && x.x0 >= 0.04 - EPS);
  assert.equal(upright.length, 251, 'every 10 mm from 0 to 2500');
  assert.equal(sill.length, 127, 'every 10 mm from 40 to 1300');
  for (const t of upright) {
    const k = Math.round(t.y0 / 0.01);
    assert.ok(near(t.y0, k * 0.01), `upright tick at ${t.y0}`);
  }
  for (const t of sill) {
    const k = Math.round(t.x0 / 0.01);
    assert.ok(near(t.x0, k * 0.01), `sill tick at ${t.x0}`);
  }
  const lengths = upright.map((t) => Math.round((t.x1 - t.x0) * 1000));
  assert.equal(lengths.filter((l) => l === 18).length, 26, '100 mm ticks are 18 mm long');
  assert.equal(lengths.filter((l) => l === 10).length, 25, '50 mm ticks are 10 mm long');
  assert.equal(meta.ticks.length, 378);
  assert.match(usda, /Bars_C_red/, 'has a red zero marker');
  assert.ok(boxes(usda).some((x) => near(x.x1, 0) && near(x.y1, 0) && x.mesh === 'Bars_C_red'), 'red square ends at the zero');
  // The strip textures cover the whole L.
  assert.equal(buildDesign('A').textures.length, 8);
});

test("floor ruler ticks sit on k x 10 mm and 'xz' turns Y into Z", () => {
  const xy = floorRuler({ orientation: 'xy' });
  const ticks = boxes(xy.usda).filter((x) => x.x1 - x.x0 < 0.005 && near(x.y0, 0));
  assert.equal(ticks.length, 211);
  for (const t of ticks) assert.ok(near(t.x0, Math.round(t.x0 / 0.01) * 0.01));
  for (const design of ['A', 'D', 'E']) {
    const a = meshes(buildDesign(design, { orientation: 'xy' }).usda);
    const b = meshes(buildDesign(design, { orientation: 'xz' }).usda);
    assert.equal(a.length, b.length);
    a.forEach((mesh, i) => {
      assert.equal(mesh.points.length, b[i].points.length);
      mesh.points.forEach(([x, y, z], j) => {
        const [x2, y2, z2] = b[i].points[j];
        assert.ok(near(x2, x) && near(y2, z) && near(z2, -y), `${design} ${mesh.name}[${j}]: Y and Z swapped (new Z = -old Y)`);
      });
    });
  }
  // Normals turn with the points: a front face's +Z normal becomes +Y.
  assert.match(floorRuler().usda, /normal3f\[\] normals = \[\(0, 1, 0\)/);
});

test('catalogue lines sit exactly at each standard size, one colour per height', () => {
  const sizes = standardSizesFrom(config);
  const { usda, meta } = catalogue({ sizes });
  const b = boxes(usda);
  for (const s of sizes) {
    const w = s.widthMm / 1000;
    const h = s.heightMm / 1000;
    assert.ok(b.some((x) => near(x.x0, w) && near(x.x1 - x.x0, 0.025) && x.y1 >= h - EPS), `a width line at ${s.widthMm} reaching ${s.heightMm}`);
    assert.ok(b.some((x) => near(x.y0, h) && near(x.y1 - x.y0, 0.025) && x.x1 >= w - EPS), `a height line at ${s.heightMm} reaching ${s.widthMm}`);
  }
  assert.deepEqual(meta.colors, { 2040: 'blue', 2100: 'green', 2340: 'orange' });
  // Width lines are made of steps that never overlap each other.
  for (const w of new Set(sizes.map((s) => s.widthMm))) {
    const steps = b.filter((x) => near(x.x0, w / 1000)).sort((p, q) => p.y0 - q.y0);
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i].y0 >= steps[i - 1].y1 - EPS);
  }
  assert.deepEqual(catalogue({ sizes: [] }).meta.params.sizes.length, DEFAULT_STANDARD_SIZES.length, 'falls back to the defaults');
});

test('grid bars every 100 mm (4 mm), red every 500 mm (8 mm), left/lower edge on the value', () => {
  const { usda } = grid();
  const b = boxes(usda);
  const vertical = b.filter((x) => x.y1 - x.y0 > 2);
  const horizontal = b.filter((x) => x.x1 - x.x0 > 1);
  assert.equal(vertical.length, 14);
  assert.equal(horizontal.length, 26);
  for (const x of vertical) {
    const v = Math.round(x.x0 * 10) / 10;
    assert.ok(near(x.x0, v));
    assert.ok(near(x.x1 - x.x0, Math.round(v * 1000) % 500 === 0 ? 0.008 : 0.004));
  }
});

test('builders refuse sizes that are not millimetre sizes', () => {
  assert.throws(() => outline({ widthMm: -5 }), /widthMm/);
  assert.throws(() => tapeL({ heightMm: 'tall' }), /heightMm/);
  assert.throws(() => buildDesign('Z'), /unknown design/);
  assert.throws(() => outline({ orientation: 'yz' }), /orientation/);
  assert.throws(() => outline({ anchoring: 'ceiling' }), /anchoring/);
});

// ---- link fragment ------------------------------------------------------------------------------

test('the Quick Look fragment encodes each field, joins with & and appends the lock flag last', () => {
  assert.equal(
    outlineFragment(820, 2040, false),
    'callToAction=This%20size%20fits&checkoutTitle=820%20x%202040%20mm&checkoutSubtitle=SecureMeasure%20lab',
  );
  assert.equal(
    outlineFragment(820, 2040, true),
    'callToAction=This%20size%20fits&checkoutTitle=820%20x%202040%20mm&checkoutSubtitle=SecureMeasure%20lab&allowsContentScaling=0',
  );
  assert.equal(quickLookFragment({ callToAction: 'A&B=C #1', lock: true }), `callToAction=${encodeURIComponent('A&B=C #1')}&allowsContentScaling=0`);
  assert.equal(quickLookFragment({ lock: true }), 'allowsContentScaling=0');
  assert.equal(quickLookFragment({}), '');
  assert.equal(withFragment('blob:https://x/abc#old', 'a=1'), 'blob:https://x/abc#a=1');
  assert.equal(withFragment('models/A.usdz', ''), 'models/A.usdz');
});

// ---- static copies ------------------------------------------------------------------------------

test('make-static.mjs output holds exactly the USDA the page builds, packed as a valid USDZ', () => {
  for (const v of STATIC_VARIANTS) {
    const file = `${MODELS}${variantKey(v)}.usdz`;
    assert.ok(existsSync(file), `${variantKey(v)}.usdz is committed (run node lab/arql/make-static.mjs)`);
    const bytes = new Uint8Array(readFileSync(file));
    assert.ok(bytes.length < MAX_USDZ_BYTES, `${variantKey(v)} is under 3 MB`);
    const list = readZip(bytes);
    assert.equal(list[0].path, 'scene.usda');
    assert.ok(list.every((e) => e.aligned && e.crcOk && e.method === 0), `${variantKey(v)}: stored, aligned, CRC-correct`);
    const built = buildDesign(v.design, variantOptions(v));
    assert.equal(new TextDecoder().decode(entryBytes(bytes, list[0])), built.usda, `${variantKey(v)}: USDA matches the builders`);
    assert.deepEqual(list.slice(1).map((e) => e.path), built.textures.map((t) => t.path));
    for (const e of list.slice(1)) {
      const png = decodePng(entryBytes(bytes, e));
      const tex = built.textures.find((t) => t.path === e.path);
      assert.equal(png.width, tex.image.width);
      assert.equal(png.height, tex.image.height);
      assert.equal(hashImage(png), hashImage(tex.image), `${e.path} pixels match`);
    }
  }
});

test('staticFileFor finds the committed copy only for default parameters', () => {
  assert.equal(staticFileFor({ design: 'A', anchoring: 'vertical', orientation: 'xy' }), 'models/A-vertical-xy.usdz');
  assert.equal(staticFileFor({ design: 'A', anchoring: 'vertical', orientation: 'xy', heightMm: 2400 }), null);
  assert.equal(staticFileFor({ design: 'D', anchoring: 'vertical', orientation: 'xy', widthMm: 870, heightMm: 2100 }), 'models/D-870x2100-vertical-xy.usdz');
  assert.equal(staticFileFor({ design: 'D', anchoring: 'vertical', orientation: 'xy', widthMm: 871, heightMm: 2100 }), null);
  assert.equal(staticFileFor({ design: 'E', anchoring: 'horizontal', orientation: 'xz' }), 'models/E-horizontal-xz.usdz');
  assert.equal(staticFileFor({ design: 'B', anchoring: 'horizontal', orientation: 'xy' }), null);
  assert.equal(staticFileFor({ design: 'C', anchoring: 'vertical', orientation: 'xy', sizes: standardSizesFrom(config) }), 'models/C-vertical-xy.usdz');
  assert.equal(staticFileFor({ design: 'C', anchoring: 'vertical', orientation: 'xy', sizes: [{ widthMm: 800, heightMm: 2000 }] }), null);
});

// ---- results maths ------------------------------------------------------------------------------

test('AR size by design is plain subtraction, and errors are AR - tape', () => {
  assert.deepEqual(arSize('A', { head: '2043', right: '821' }), { arW: 821, arH: 2043 });
  assert.deepEqual(arSize('B', { left: '130', right: '952', sill: '40', head: '2085' }), { arW: 822, arH: 2045 });
  assert.deepEqual(arSize('C', { wLine: '820', wFit: 'smaller', wOff: '4', hLine: '2040', hFit: 'bigger', hOff: '12' }), { arW: 816, arH: 2052 });
  assert.deepEqual(arSize('D', { wLine: '820', wFit: 'match', wOff: '7', hLine: '2040', hFit: 'match' }), { arW: 820, arH: 2040 }, 'on the line: the line');
  assert.deepEqual(arSize('D', { wLine: '820', wFit: 'smaller', wOff: '-4', hLine: '2040', hFit: 'bigger', hOff: '-6' }), { arW: 816, arH: 2046 }, 'the fit answer gives the sign');
  // A blank answer is no reading, never 0: a D draft pre-filled with the outline's own lines reads nothing.
  assert.deepEqual(arSize('D', { wLine: '820', hLine: '2040' }), { arW: null, arH: null });
  assert.deepEqual(arSize('D', { wLine: '820', wOff: '5', hLine: '2040', hFit: 'bigger' }), { arW: null, arH: null }, 'off with no mm, or mm with no way');
  assert.deepEqual(arSize('E', { r1000: '1010' }), { arW: null, arH: null });
  const row = computeRow({ design: 'B', readings: { left: 130, right: 952, sill: 40, head: 2085 }, tape: { w: 820, h: 2040 } });
  assert.equal(row.errW, 2);
  assert.equal(row.errH, 5);
  assert.equal(row.errWPct, 0.24);
  assert.equal(row.errHPct, 0.25);
  const floor = computeRow({ design: 'E', readings: { r1000: 1015, r2000: 2030 } });
  assert.equal(floor.scale1000, 0.015);
  assert.equal(floor.scale2000, 0.015);
  assert.equal(floor.floorScalePct, 1.5);
});

test('percentiles are nearest-rank on sorted values; the session table counts what was answered', () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.9), 10);
  assert.equal(percentile([], 0.5), null);
  const rows = [
    { design: 'A', opened: 'yes', stuck: 'wall', lock: true, pinch: 'no', readings: { head: 2050, right: 815 }, tape: { w: 820, h: 2040 } },
    // Floated: its readings are left out of the errors.
    { design: 'A', opened: 'yes', stuck: 'floated', lock: true, pinch: 'yes', readings: { head: 2020, right: 830 }, tape: { w: 820, h: 2040 } },
    { design: 'B', opened: 'no', lock: false },
    { design: 'E', opened: 'yes', stuck: 'floor', readings: { r1000: 990, r2000: 1980 } },
  ];
  const s = summarize(rows);
  assert.equal(s.n, 1);
  assert.equal(s.leftOut, 1);
  assert.deepEqual(s.w, { n: 1, p50: 5, p90: 5, bias: -5 });
  assert.deepEqual(s.h, { n: 1, p50: 10, p90: 10, bias: 10 });
  assert.equal(s.openedPct, 75);
  assert.equal(s.stuckPct, 67);
  assert.equal(s.lockHeldPct, 50);
  assert.equal(s.floor.p90, 1);
  assert.equal(s.floor.bias, -1);
  const f = summarizeFlow([
    { aspectTop1: { widthMm: 820, heightMm: 2040 }, arPick: { widthMm: 820, heightMm: 2040 }, arPickVia: 'banner', tape: { w: 820, h: 2040 }, unsure: false },
    { aspectTop1: { widthMm: 870, heightMm: 2040 }, arPick: { widthMm: 870, heightMm: 2100 }, arPickVia: 'banner', tape: { w: 870, h: 2100 }, unsure: true },
  ], DEFAULT_STANDARD_SIZES);
  assert.equal(f.arRight, 2);
  assert.equal(f.aspectRight, 1);
  assert.equal(f.unsureArRight, 1);
  const verdicts = goNoGo(s, f, { bannerSeen: true });
  assert.equal(verdicts.find((v) => v.id === 'banner').verdict, 'go');
  assert.equal(verdicts.find((v) => v.id === 'door_h').verdict, 'not enough data');
});

test('a row counts only when AR opened, it stuck where it can be read, and it was not read after a resize', () => {
  const base = { design: 'A', opened: 'yes', stuck: 'wall', anchoring: 'vertical', orientation: 'xy', readings: { head: 2045, right: 822 }, tape: { w: 820, h: 2040 } };
  assert.deepEqual(rowUse(base), { ok: true, w: true, h: true, floor: false, why: [] });
  assert.equal(rowUse({ ...base, stuck: 'door' }).ok, true);
  assert.equal(rowUse({ ...base, opened: 'no' }).ok, false);
  assert.equal(rowUse({ ...base, stuck: '' }).ok, false, 'stuck not answered');
  assert.equal(rowUse({ ...base, stuck: 'floated' }).ok, false);
  assert.equal(rowUse({ ...base, stuck: 'floor' }).ok, false, 'a door gauge lying on the floor');
  assert.equal(rowUse({ design: 'E', opened: 'yes', stuck: 'floor' }).floor, true);
  assert.equal(rowUse({ design: 'E', opened: 'yes', stuck: 'wall' }).floor, false);
  assert.equal(rowUse({ ...base, pinch: 'yes' }).ok, false, 'read after a pinch resized it');
  assert.equal(rowUse({ ...base, pinch: 'yes', readBeforePinch: 'yes' }).ok, true, 'read before the pinch');
  assert.equal(rowUse({ ...base, pinch: 'no' }).ok, true);
  // No anchoring: Quick Look stands it on the floor, its zero 20-32 mm up, so only the width counts.
  const grounded = rowUse({ ...base, anchoring: 'none' });
  assert.equal(grounded.w, true);
  assert.equal(grounded.h, false);
  assert.ok(grounded.why.length === 1);
  const s = summarize([
    { ...base, anchoring: 'none', readings: { head: 2020, right: 822 } },
    { ...base, pinch: 'yes', readings: { head: 2400, right: 1000 } },
    // A D run that never opened, with lines pre-filled and the tape carried over: not a reading.
    { design: 'D', opened: 'no', readings: { wLine: 820, hLine: 2040 }, tape: { w: 820, h: 2040 } },
  ]);
  assert.deepEqual([s.w.n, s.h.n, s.w.p90], [1, 0, 2]);
});

test('gauges A-D have their lowest point 20-32 mm below the opening zero; the floor ruler at it', () => {
  assert.deepEqual(['A', 'B', 'C', 'D', 'E'].map((d) => buildDesign(d).meta.belowZeroMm), [20, 32, 25, 25, 0]);
});

/** A row in the product set-up on a named door. */
function productRow(door, extra = {}) {
  return {
    design: 'A',
    anchoring: 'vertical',
    orientation: 'xy',
    delivery: 'blob',
    lock: true,
    framed: false,
    inApp: null,
    opened: 'yes',
    stuck: 'wall',
    pinch: 'no',
    readings: { head: 2045, right: 818 },
    tape: { w: 820, h: 2040, doorId: door },
    ...extra,
  };
}

test('the go / no-go counts the product set-up only, each named door once (its first run)', () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(productRow(`Door ${i}`, { readings: { head: 2040 + i, right: 820 - (i % 3) } }));
  // Door 10's first run floated; its retry stuck. The first run decides.
  rows[9] = productRow('door 10', { stuck: 'floated' });
  rows.push(productRow(' DOOR 10 ', { readings: { head: 2050, right: 821 } }));
  // Variants that must not move the go / no-go (wild readings), but do show in the breakdowns.
  rows.push(productRow('door 1', { anchoring: 'none', readings: { head: 1800, right: 600 } }));
  rows.push(productRow('door 2', { delivery: 'static', readings: { head: 1800, right: 600 } }));
  rows.push(productRow('door 3', { lock: false, readings: { head: 1800, right: 600 } }));
  rows.push(productRow('door 4', { framed: true, readings: { head: 1800, right: 600 } }));
  rows.push(productRow('door 5', { inApp: 'Chrome for iOS', readings: { head: 1800, right: 600 } }));
  rows.push(productRow('door 6', { design: 'C', readings: { wLine: 820, wFit: 'bigger', wOff: 200, hLine: 2040, hFit: 'match' } }));
  rows.push(productRow('', { readings: { head: 1800, right: 600 } }));
  const s = summarize(rows);
  assert.equal(s.product.doors, 10, 'door names are trimmed and case-blind');
  assert.equal(s.product.doorsOk, 9);
  assert.equal(s.product.unnamedRuns, 1);
  assert.equal(s.product.h.doors, 10);
  assert.ok(s.product.h.p90 <= 10, `product H p90 ${s.product.h.p90}`);
  assert.ok(s.product.w.p90 <= 2, `product W p90 ${s.product.w.p90}`);
  assert.ok(s.w.p90 >= 200, 'every set-up together still shows the bad variants');
  assert.ok(isProductSetup(rows[0]));
  assert.equal(isProductSetup({ ...rows[0], framed: undefined }), false, 'where it ran must be known');
  const setups = Object.fromEntries(s.bySetup.map((g) => [g.key, g.runs]));
  assert.equal(setups['vertical / xy / blob'], 16);
  assert.equal(setups['none / xy / blob'], 1);
  assert.equal(setups['vertical / xy / static'], 1);
  const pages = Object.fromEntries(s.byPage.map((g) => [g.key, g.runs]));
  assert.deepEqual(pages, { 'top-level': 16, 'inside an iframe': 1, 'other browser (Chrome for iOS)': 1 });

  const flow = [];
  for (let i = 1; i <= 10; i++) {
    const pick = i <= 9 ? { widthMm: 820, heightMm: 2040 } : { widthMm: 870, heightMm: 2040 };
    flow.push({ ...productRow(), doorId: `d${i}`, tape: { w: 818, h: 2043 }, aspectTop1: { widthMm: 820, heightMm: 2040, p: 0.5 }, arPick: pick, unsure: i === 10 });
  }
  // Not the product set-up: does not count for the verdict.
  flow.push({ ...productRow(), anchoring: 'horizontal', orientation: 'xz', doorId: 'd11', tape: { w: 818, h: 2043 }, aspectTop1: { widthMm: 820, heightMm: 2040, p: 0.5 }, arPick: null });
  const f = summarizeFlow(flow, DEFAULT_STANDARD_SIZES);
  assert.equal(f.judged, 11);
  assert.equal(f.arRight, 9);
  assert.deepEqual([f.product.doors, f.product.arRight, f.product.unsure, f.product.unsureArRight], [10, 9, 1, 0]);
  const v = Object.fromEntries(goNoGo(s, f).map((x) => [x.id, x.verdict]));
  assert.equal(v.open_stick, 'go', '9 of 10 doors');
  assert.equal(v.door_h, 'go');
  assert.equal(v.door_w, 'go');
  assert.equal(v.flow, 'go', '9 of 10 picks right');
  flow[8] = { ...flow[8], arPick: { widthMm: 870, heightMm: 2100 } };
  assert.equal(goNoGo(s, summarizeFlow(flow, DEFAULT_STANDARD_SIZES)).find((x) => x.id === 'flow').verdict, 'no-go', '8 of 10');
});

test("a flow door is judged against its standard size, not the tape's raw millimetres", () => {
  const sizes = DEFAULT_STANDARD_SIZES;
  assert.deepEqual(standardForTape({ w: 818, h: 2043 }, sizes), { widthMm: 820, heightMm: 2040 });
  assert.deepEqual(standardForTape({ w: '846', h: '2095' }, sizes), { widthMm: 870, heightMm: 2100 });
  assert.equal(standardForTape({ w: 845, h: 2040 }, sizes), null, 'half way between 820 and 870: the tester picks');
  assert.equal(standardForTape({ w: 820, h: 2070 }, sizes), null, 'half way between 2040 and 2100');
  assert.equal(standardForTape({ w: 1000, h: 2040 }, sizes), null, 'no catalogue size that near');
  assert.equal(standardForTape({ w: '', h: 2040 }, sizes), null);
  assert.equal(sameSize({ widthMm: 820, heightMm: 2040 }, { widthMm: 820, heightMm: 2040 }), true);
  assert.equal(sameSize({ widthMm: 820, heightMm: 2040 }, null), null);
  // Picked by the tester, or 'none of these' (trueSize null), wins over the tape.
  assert.deepEqual(flowTruth({ trueSize: { widthMm: 870, heightMm: 2040 }, tape: { w: 818, h: 2043 } }, sizes), { widthMm: 870, heightMm: 2040 });
  assert.equal(flowTruth({ trueSize: null, trueSizeVia: 'none', tape: { w: 818, h: 2043 } }, sizes), null);
  const f = summarizeFlow(
    [
      { tape: { w: 818, h: 2043 }, aspectTop1: { widthMm: 820, heightMm: 2040 }, arPick: { widthMm: 820, heightMm: 2040 } },
      { trueSize: null, trueSizeVia: 'none', tape: { w: 1000, h: 2200 }, aspectTop1: { widthMm: 920, heightMm: 2100 }, arPick: { widthMm: 920, heightMm: 2100 } },
      { tape: { w: 821, h: 2038 }, aspectTop1: { widthMm: 820, heightMm: 2040 }, arPick: null },
    ],
    sizes,
  );
  assert.deepEqual([f.judged, f.arRight, f.aspectRight, f.unknownSize], [2, 1, 2, 1], 'no AR pick on a judged door is a miss');
});

test('time away is measured from the AR tap to the page being visible again', () => {
  const events = [
    { t: 1000, type: 'ar-tap' },
    { t: 1100, type: 'visibilitychange', detail: 'hidden' },
    { t: 31100, type: 'visibilitychange', detail: 'visible' },
    { t: 31200, type: 'focus' },
  ];
  assert.deepEqual(timeAway(events, 1000), { awaySec: 30.1, hiddenSec: 30 });
  assert.deepEqual(timeAway(events.slice(0, 2), 1000), { awaySec: null, hiddenSec: null });
  assert.deepEqual(timeAway([{ t: 5, type: 'blur' }, { t: 2005, type: 'focus' }], 0), { awaySec: 2, hiddenSec: 2 });
  assert.deepEqual(timeAway([{ t: 0, type: 'ar-tap' }, { t: 45000, type: 'load' }], 0), { awaySec: 45, hiddenSec: null }, 'a reload with no hide event');
  // The same gauge opened twice: both visits count.
  const twice = [
    { t: 0, type: 'ar-tap' },
    { t: 100, type: 'visibilitychange', detail: 'hidden' },
    { t: 10100, type: 'visibilitychange', detail: 'visible' },
    { t: 20000, type: 'ar-tap' },
    { t: 20100, type: 'visibilitychange', detail: 'hidden' },
    { t: 50100, type: 'visibilitychange', detail: 'visible' },
  ];
  assert.deepEqual(timeAwayAll(twice, [0, 20000]), { awaySec: 40.2, hiddenSec: 40, sessions: 2 });
  assert.deepEqual(timeAwayAll(twice, [20000]), { awaySec: 30.1, hiddenSec: 30, sessions: 1 });
  assert.deepEqual(timeAwayAll(twice, []), { awaySec: null, hiddenSec: null, sessions: 0 });
});
