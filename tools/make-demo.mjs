// Writes the bundled demo photo and its ground truth:
//   assets/demo-door.png         the synthetic front-door photo behind "Try it with a demo photo"
//   assets/demo-door.truth.json  the exact door / sheet corners and sizes for that photo
// The render has no randomness, so running this twice gives byte-identical files.
//
// Usage: node tools/make-demo.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO_SCENE, encodePng, renderScene, truthToJson } from './scene.mjs';

const assetsDir = new URL('../assets/', import.meta.url);
const pngPath = fileURLToPath(new URL('demo-door.png', assetsDir));
const truthPath = fileURLToPath(new URL('demo-door.truth.json', assetsDir));

const started = Date.now();
const { image, truth } = renderScene(DEMO_SCENE);
const png = encodePng(image);
const json = truthToJson(truth, image);

mkdirSync(assetsDir, { recursive: true });
writeFileSync(pngPath, png);
writeFileSync(truthPath, `${JSON.stringify(json, null, 2)}\n`);

const fmt = (quad) => quad.map((p) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`).join('  ');
const doorHeightPx = (json.doorPx[3].y + json.doorPx[2].y - json.doorPx[0].y - json.doorPx[1].y) / 2;
console.log(`demo-door.png         ${image.width} x ${image.height}, ${(png.length / 1024).toFixed(0)} KB  (${Date.now() - started} ms)`);
console.log(`demo-door.truth.json  door ${json.widthMm} x ${json.heightMm} mm, sheet ${json.sheetMm.w} x ${json.sheetMm.h} mm`);
console.log(`  doorPx  [TL TR BR BL]  ${fmt(json.doorPx)}`);
console.log(`  sheetPx [TL TR BR BL]  ${fmt(json.sheetPx)}`);
console.log(`  door fills ${((100 * doorHeightPx) / image.height).toFixed(1)}% of the image height`);
