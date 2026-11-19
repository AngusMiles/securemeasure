// Writes the static USDZ copies the lab page can link instead of a generated blob, so the two ways of
// delivering the same scene can be compared on a phone. Node only. Run from the repo root:
//
//   node lab/arql/make-static.mjs
//
// Uses the same scene builders as the page (gauge.js) and the same USDZ writer (usdz.js); only the PNG
// encoder differs (tools/scene.mjs encodePng, which compresses with node:zlib, where the page uses the
// browser's canvas). So the USDA inside each file is byte-for-byte what the page builds for the same
// options; tests/lab-arql.test.mjs checks that. Commit the output (lab/arql/models/*.usdz).

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

import config from '../../js/config.js';
import { standardSizesFrom } from '../../js/estimate.js';
import { encodePng } from '../../tools/scene.mjs';
import { STATIC_VARIANTS, buildDesign, variantKey } from './gauge.js';
import { makeUsdz, utf8 } from './usdz.js';

export const MODELS_DIR = fileURLToPath(new URL('./models/', import.meta.url));
export const MAX_USDZ_BYTES = 3 * 1024 * 1024;

/**
 * The builder options for a static variant (the page passes the same for the same picks).
 * @param {{ design: string, anchoring: string, orientation: string, widthMm?: number, heightMm?: number }} v
 */
export function variantOptions(v) {
  const o = { anchoring: v.anchoring, orientation: v.orientation };
  if (v.design === 'C') o.sizes = standardSizesFrom(config);
  if (v.design === 'D') {
    o.widthMm = v.widthMm;
    o.heightMm = v.heightMm;
  }
  return o;
}

/**
 * Build one variant's USDZ bytes.
 * @param {object} v  one of STATIC_VARIANTS
 * @returns {{ name: string, bytes: Uint8Array, usda: string }}
 */
export function buildStatic(v) {
  const scene = buildDesign(v.design, variantOptions(v));
  const entries = [
    { path: 'scene.usda', bytes: utf8(scene.usda) },
    ...scene.textures.map((t) => ({ path: t.path, bytes: new Uint8Array(encodePng(t.image)) })),
  ];
  return { name: `${variantKey(v)}.usdz`, bytes: makeUsdz(entries), usda: scene.usda };
}

function main() {
  mkdirSync(MODELS_DIR, { recursive: true });
  const written = new Set();
  let total = 0;
  for (const v of STATIC_VARIANTS) {
    const { name, bytes } = buildStatic(v);
    if (bytes.length > MAX_USDZ_BYTES) throw new Error(`${name} is ${bytes.length} bytes, over the 3 MB limit`);
    writeFileSync(join(MODELS_DIR, name), bytes);
    written.add(name);
    total += bytes.length;
    console.log(`${name.padEnd(34)} ${(bytes.length / 1024).toFixed(0).padStart(5)} KB`);
  }
  for (const file of readdirSync(MODELS_DIR)) {
    if (file.endsWith('.usdz') && !written.has(file)) {
      unlinkSync(join(MODELS_DIR, file));
      console.log(`removed stale ${file}`);
    }
  }
  console.log(`${written.size} files, ${(total / 1024).toFixed(0)} KB in ${MODELS_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
