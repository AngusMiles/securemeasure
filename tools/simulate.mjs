// Monte Carlo accuracy report for js/geometry.js (dev only).
//
//   node tools/simulate.mjs                  readable table, 5000 trials per scenario
//   node tools/simulate.mjs --json           the same numbers as JSON
//   node tools/simulate.mjs --trials 500 --seed 7
//   node tools/simulate.mjs --sheet-band 0.3   keep the sheet centre within the middle 30% of the door height
//
// Each trial: a random but realistic camera pose in front of an 820 x 2040 mm door, a reference sheet
// taped somewhere on it, Gaussian pixel noise on the eight marked corners, then measureDoor().
// The run is fully reproducible (seeded mulberry32).

import { pathToFileURL } from 'node:url';
import { cameraHomography, projectPoint } from './camera.mjs';
import { measureDoor } from '../js/geometry.js';

const IMAGE = { width: 1920, height: 2560 };
const FOCAL_PX = 0.72 * IMAGE.height;
const DOOR = { w: 820, h: 2040 };
const A4 = { w: 210, h: 297 };
const CARD = { w: 85.6, h: 53.98 };
const SHEET_MARGIN_MM = 60;

/** The four scenarios of the report. Sigmas are 1-sigma corner noise in px (sheet / door). */
export const SCENARIOS = [
  { id: 'a4-refined', label: 'A4, refined corners', sheetMm: A4, sigmaSheetPx: 0.3, sigmaDoorPx: 2 },
  { id: 'a4-manual', label: 'A4, manual corners', sheetMm: A4, sigmaSheetPx: 2, sigmaDoorPx: 2 },
  { id: 'card-refined', label: 'Bank card, refined corners', sheetMm: CARD, sigmaSheetPx: 0.3, sigmaDoorPx: 2 },
  { id: 'card-manual', label: 'Bank card, manual corners', sheetMm: CARD, sigmaSheetPx: 2, sigmaDoorPx: 2 },
];

/**
 * Small, fast, seedable PRNG.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sampler (Box-Muller) on top of a uniform PRNG. */
function gaussianSampler(rand) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const r = Math.sqrt(-2 * Math.log(1 - rand()));
    const a = 2 * Math.PI * rand();
    spare = r * Math.sin(a);
    return r * Math.cos(a);
  };
}

const uniform = (rand, lo, hi) => lo + (hi - lo) * rand();

/**
 * Draw one scene (true corner positions in px), or null when the door does not fit in the image.
 * sheetBand = fraction of the door height, centred on its middle, that the sheet centre may fall in.
 */
function drawScene(rand, sheetMm, sheetBand) {
  const P = cameraHomography({
    imageWidth: IMAGE.width,
    imageHeight: IMAGE.height,
    focalPx: FOCAL_PX,
    target: { x: DOOR.w / 2 + uniform(rand, -100, 100), y: DOOR.h / 2 + uniform(rand, -150, 150) },
    distanceMm: uniform(rand, 2200, 3500),
    yawDeg: uniform(rand, -15, 15),
    pitchDeg: uniform(rand, -8, 8),
    rollDeg: uniform(rand, -3, 3),
  });
  // Sheet: small tilt, anywhere on the door with the whole sheet at least SHEET_MARGIN_MM inside it.
  const theta = (uniform(rand, -5, 5) * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const halfX = (Math.abs(c) * sheetMm.w + Math.abs(s) * sheetMm.h) / 2 + SHEET_MARGIN_MM;
  const halfY = (Math.abs(s) * sheetMm.w + Math.abs(c) * sheetMm.h) / 2 + SHEET_MARGIN_MM;
  const cx = uniform(rand, halfX, DOOR.w - halfX);
  const bandHalf = (sheetBand * DOOR.h) / 2;
  const cy = uniform(rand, Math.max(halfY, DOOR.h / 2 - bandHalf), Math.min(DOOR.h - halfY, DOOR.h / 2 + bandHalf));

  const doorPx = [{ x: 0, y: 0 }, { x: DOOR.w, y: 0 }, { x: DOOR.w, y: DOOR.h }, { x: 0, y: DOOR.h }].map((p) => projectPoint(P, p));
  if (doorPx.some((p) => p.x < 0 || p.x > IMAGE.width || p.y < 0 || p.y > IMAGE.height)) return null;
  const sheetPx = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx * sheetMm.w) / 2;
    const y = (sy * sheetMm.h) / 2;
    return projectPoint(P, { x: cx + c * x - s * y, y: cy + s * x + c * y });
  });
  return { doorPx, sheetPx };
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function errorStats(errors) {
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  const rms = Math.sqrt(errors.reduce((acc, e) => acc + e * e, 0) / Math.max(1, errors.length));
  return { medianAbsMm: percentile(abs, 0.5), p95AbsMm: percentile(abs, 0.95), rmsMm: rms };
}

/**
 * Run one scenario.
 * @param {{id:string,label:string,sheetMm:{w:number,h:number},sigmaSheetPx:number,sigmaDoorPx:number}} scenario
 * @param {{trials:number, seed:number, sheetBand?:number}} opts
 */
export function runScenario(scenario, { trials, seed, sheetBand = 1 }) {
  // Every scenario starts from the same seed, so all four see the same sequence of camera poses.
  const rand = mulberry32(seed);
  const gauss = gaussianSampler(rand);
  const joint = { w: [], h: [] };
  const sheetOnly = { w: [], h: [] };
  const grades = { good: 0, fair: 0, poor: 0 };
  const issues = {};
  const failures = {};
  let rejected = 0;
  let measured = 0;
  let sheetOnlyInvalid = 0;
  let wrongWayRound = 0;
  let within3 = 0;
  let within5 = 0;
  let sumSigmaW = 0;
  let sumSigmaH = 0;
  let zW = 0;
  let zH = 0;
  let elapsedMs = 0;

  let done = 0;
  while (done < trials) {
    const scene = drawScene(rand, scenario.sheetMm, sheetBand);
    if (!scene) {
      rejected++;
      continue;
    }
    done++;
    const noisy = (pts, sigma) => pts.map((p) => ({ x: p.x + sigma * gauss(), y: p.y + sigma * gauss() }));
    const input = {
      sheetPx: noisy(scene.sheetPx, scenario.sigmaSheetPx),
      doorPx: noisy(scene.doorPx, scenario.sigmaDoorPx),
      sheetMm: scenario.sheetMm,
      imageSize: IMAGE,
      sigmaSheetPx: scenario.sigmaSheetPx,
      sigmaDoorPx: scenario.sigmaDoorPx,
    };
    const t0 = performance.now();
    const res = measureDoor(input);
    elapsedMs += performance.now() - t0;
    if (!res.ok) {
      failures[res.error] = (failures[res.error] || 0) + 1;
      continue;
    }
    measured++;
    const ew = res.widthMm - DOOR.w;
    const eh = res.heightMm - DOOR.h;
    joint.w.push(ew);
    joint.h.push(eh);
    if (res.sheetOnly.valid) {
      sheetOnly.w.push(res.sheetOnly.widthMm - DOOR.w);
      sheetOnly.h.push(res.sheetOnly.heightMm - DOOR.h);
    } else {
      sheetOnlyInvalid++;
    }
    grades[res.quality.level]++;
    for (const code of res.quality.issues) issues[code] = (issues[code] || 0) + 1;
    // The sheet is always taped the same way round in this simulation (w along the door's width).
    const expected = scenario.sheetMm.h >= scenario.sheetMm.w ? 'portrait' : 'landscape';
    if (res.sheetOrientation !== expected) wrongWayRound++;
    if (Math.abs(ew) <= 3 && Math.abs(eh) <= 3) within3++;
    if (Math.abs(ew) <= 5 && Math.abs(eh) <= 5) within5++;
    sumSigmaW += res.sigmaWidthMm;
    sumSigmaH += res.sigmaHeightMm;
    zW += (ew / res.sigmaWidthMm) ** 2;
    zH += (eh / res.sigmaHeightMm) ** 2;
  }

  const n = Math.max(1, measured);
  const frac = (count) => count / n;
  return {
    id: scenario.id,
    label: scenario.label,
    sheetMm: scenario.sheetMm,
    sigmaSheetPx: scenario.sigmaSheetPx,
    sigmaDoorPx: scenario.sigmaDoorPx,
    trials,
    measured,
    rejectedDoorOutOfFrame: rejected,
    failures,
    joint: { width: errorStats(joint.w), height: errorStats(joint.h) },
    sheetOnly: { width: errorStats(sheetOnly.w), height: errorStats(sheetOnly.h), invalid: sheetOnlyInvalid },
    quality: { good: frac(grades.good), fair: frac(grades.fair), poor: frac(grades.poor) },
    issues: Object.fromEntries(Object.entries(issues).sort((a, b) => b[1] - a[1]).map(([code, count]) => [code, frac(count)])),
    wrongWayRound: frac(wrongWayRound),
    within3mm: frac(within3),
    within5mm: frac(within5),
    reportedSigma: { meanWidthMm: sumSigmaW / n, meanHeightMm: sumSigmaH / n },
    // RMS of (error / reported sigma): 1.0 means the reported uncertainty is exactly calibrated.
    calibration: { width: Math.sqrt(zW / n), height: Math.sqrt(zH / n) },
    msPerMeasure: elapsedMs / Math.max(1, trials),
  };
}

function parseArgs(argv) {
  const opts = { json: false, trials: 5000, seed: 20240607, sheetBand: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (name === '--json') opts.json = true;
    else if (name === '--trials') opts.trials = Math.max(1, Math.floor(Number(value())) || 0);
    else if (name === '--seed') opts.seed = Number(value()) >>> 0;
    else if (name === '--sheet-band') opts.sheetBand = Math.min(1, Math.max(0, Number(value()) || 0));
    else if (name === '--help' || name === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

const fmt = (v, digits = 1, width = 8) => (v === null || !Number.isFinite(v) ? '-' : v.toFixed(digits)).padStart(width);
const pct = (v, width = 7) => `${(100 * v).toFixed(1)}%`.padStart(width);

function printReport(results, opts) {
  const lines = [];
  lines.push('SecureMeasure accuracy simulation');
  lines.push(
    `${opts.trials} trials per scenario, seed ${opts.seed}. Image ${IMAGE.width} x ${IMAGE.height} px, focal ${FOCAL_PX.toFixed(0)} px, ` +
      `door ${DOOR.w} x ${DOOR.h} mm.`,
  );
  const where = opts.sheetBand >= 1 ? 'anywhere on the door' : `centre within the middle ${(100 * opts.sheetBand).toFixed(0)}% of the door height`;
  lines.push(`Camera 2.2-3.5 m away, yaw +-15 deg, pitch +-8 deg, roll +-3 deg; sheet ${where}, tilted +-5 deg.`);
  lines.push('Absolute error in mm. "joint" = all 8 corners fitted together; "sheet-only" = homography from the sheet alone.');
  lines.push('');
  const head1 = `${'Scenario (sigma sheet / door px)'.padEnd(38)}${'Method'.padEnd(12)}${'Width error'.padStart(17)}${'Height error'.padStart(19)}`;
  const head2 = `${''.padEnd(38)}${''.padEnd(12)}${'median'.padStart(8)}${'95th'.padStart(9)}${'median'.padStart(10)}${'95th'.padStart(9)}`;
  lines.push(head1, head2, '-'.repeat(head1.length));
  for (const r of results) {
    const name = `${r.label} (${r.sigmaSheetPx} / ${r.sigmaDoorPx})`;
    const row = (label, method, s) =>
      `${label.padEnd(38)}${method.padEnd(12)}${fmt(s.width.medianAbsMm)}${fmt(s.width.p95AbsMm, 1, 9)}${fmt(s.height.medianAbsMm, 1, 10)}${fmt(s.height.p95AbsMm, 1, 9)}`;
    lines.push(row(name, 'joint', r.joint));
    lines.push(row('', 'sheet-only', r.sheetOnly));
  }
  lines.push('');
  const qHead = `${'Scenario'.padEnd(30)}${'good'.padStart(7)}${'fair'.padStart(8)}${'poor'.padStart(8)}${'<=3mm'.padStart(9)}${'<=5mm'.padStart(8)}${'sigma W'.padStart(9)}${'sigma H'.padStart(9)}${'calib W'.padStart(9)}${'calib H'.padStart(9)}`;
  lines.push(qHead, '-'.repeat(qHead.length));
  for (const r of results) {
    lines.push(
      `${r.label.padEnd(30)}${pct(r.quality.good)}${pct(r.quality.fair, 8)}${pct(r.quality.poor, 8)}${pct(r.within3mm, 9)}${pct(r.within5mm, 8)}` +
        `${fmt(r.reportedSigma.meanWidthMm, 1, 9)}${fmt(r.reportedSigma.meanHeightMm, 1, 9)}${fmt(r.calibration.width, 2, 9)}${fmt(r.calibration.height, 2, 9)}`,
    );
  }
  lines.push('');
  lines.push('good / fair / poor = share of trials by quality grade. <=3mm / <=5mm = share with BOTH width and height inside that error.');
  lines.push('sigma = mean reported 1-sigma (mm). calib = RMS of error / reported sigma (1.00 = perfectly calibrated).');
  lines.push('');
  for (const r of results) {
    const issueText = Object.entries(r.issues).map(([code, share]) => `${code} ${(100 * share).toFixed(1)}%`).join(', ') || 'none';
    const failed = Object.entries(r.failures).map(([code, count]) => `${code} x${count}`).join(', ') || 'none';
    lines.push(`${r.label}: issues: ${issueText}.`);
    lines.push(
      `  failed fits: ${failed}; sheet wrong way round: ${(100 * r.wrongWayRound).toFixed(2)}%; ` +
        `poses redrawn (door out of frame): ${r.rejectedDoorOutOfFrame}; ${r.msPerMeasure.toFixed(3)} ms per measurement.`,
    );
  }
  console.log(lines.join('\n'));
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log('Usage: node tools/simulate.mjs [--json] [--trials N] [--seed N] [--sheet-band 0..1]');
    return;
  }
  const results = SCENARIOS.map((scenario) => runScenario(scenario, opts));
  if (opts.json) {
    console.log(JSON.stringify({ trials: opts.trials, seed: opts.seed, sheetBand: opts.sheetBand, image: IMAGE, focalPx: FOCAL_PX, doorMm: DOOR, scenarios: results }, null, 2));
  } else {
    printReport(results, opts);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
