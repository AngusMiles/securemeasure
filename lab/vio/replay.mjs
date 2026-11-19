#!/usr/bin/env node
// Re-run the lab page's solver on downloaded logs, so the solver can be tuned without new captures.
//
//   node lab/vio/replay.mjs log.json [more.json ...] [--window=2.5] [--fit=forward] [--gyroMapping="x=+beta y=+gamma z=+alpha"]
//                                    [--timeSource=presentationTime] [--f35=24] [--trim=null] [--json]
//
// Any DEFAULT_SETTINGS key of lab/vio/solver.js can be overridden (numbers, true/false and null are parsed).
// --trim=null solves the whole run instead of the motion phase +- 0.6 s (taps included).
// With no overrides the result must equal the one stored in the log (results.solve): the "same" column says
// whether it does (within 1e-9). With several logs it also prints the p50 / p90 of |error| against the tape.

import { readFileSync } from 'node:fs';
import { solveWith, DEFAULT_SETTINGS } from './solver.js';
import { pct, sameResult } from './stats.js';

const args = process.argv.slice(2);
const files = [];
const overrides = {};
let asJson = false;
for (const a of args) {
  if (a === '--json') asJson = true;
  else if (a === '--help' || a === '-h') {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 10).join('\n'));
    process.exit(0);
  } else if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const raw = eq > 0 ? a.slice(eq + 1) : 'true';
    if (!(key in DEFAULT_SETTINGS)) {
      console.error(`unknown setting --${key} (known: ${Object.keys(DEFAULT_SETTINGS).join(', ')})`);
      process.exit(2);
    }
    overrides[key] = raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  } else files.push(a);
}
if (!files.length) {
  console.error('usage: node lab/vio/replay.mjs log.json [more.json ...] [--key=value ...] [--json]');
  process.exit(2);
}

const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const errsH = [];
const errsW = [];
const out = [];
console.log(['file', 'mode', 'H mm', 'W mm', 'err H', 'err W', 'gate', 'split %', 'dTr ms', 'f35 est', 'mapping', 'same'].join('\t'));
for (const file of files) {
  let log;
  try {
    log = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.log(`${file}\tunreadable: ${err.message}`);
    continue;
  }
  const r = solveWith(log, overrides);
  // JSON round trip so the comparison sees what a stored log holds (NaN -> null).
  const now = JSON.parse(JSON.stringify(r));
  const stored = log.results && log.results.solve;
  const diff = stored ? sameResult(now, stored) : 'no stored result';
  const tH = log.truth && Number.isFinite(log.truth.tapeH) ? log.truth.tapeH : NaN;
  const tW = log.truth && Number.isFinite(log.truth.tapeW) ? log.truth.tapeW : NaN;
  const eH = r.ok ? r.Hm * 1000 - tH : NaN;
  const eW = r.ok ? r.Wm * 1000 - tW : NaN;
  if (r.ok && r.gate.pass && Number.isFinite(eH)) {
    errsH.push(Math.abs(eH));
    errsW.push(Math.abs(eW));
  }
  out.push({ file, result: now });
  console.log(
    [
      file,
      log.mode,
      r.ok ? f(r.Hm * 1000, 0) : `no result (${r.reason})`,
      r.ok ? f(r.Wm * 1000, 0) : '',
      f(eH, 0),
      f(eW, 0),
      r.gate && r.gate.pass ? 'PASS' : `FAIL ${(r.gate && r.gate.reasons.join('; ')) || ''}`,
      f(r.split * 100, 2),
      f(r.dTr * 1000, 1),
      f(r.focal35Est, 2),
      r.prep && r.prep.mapping ? r.prep.mapping.label : '',
      Object.keys(overrides).length ? '(overrides)' : diff ? `NO (${diff})` : 'yes',
    ].join('\t'),
  );
}
if (errsH.length > 1) console.log(`gated n ${errsH.length}: |err H| p50 ${f(pct(errsH, 50), 0)} p90 ${f(pct(errsH, 90), 0)} mm; |err W| p50 ${f(pct(errsW, 50), 0)} p90 ${f(pct(errsW, 90), 0)} mm`);
if (asJson) console.log(JSON.stringify(out, null, 1));
