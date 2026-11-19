// The visual-inertial scale lab page (lab/vio/): its pure maths. The solver (ported from the Nov 2026 research
// simulator) on synthetic sweeps from lab/vio/vi-synth.mjs, the devicemotion normalisation (iOS-style raw
// events: ms timestamps, deg/s, CoreMotion accelerometer sign, x/y/z packed into alpha/beta/gamma), the gyro
// axis detection, the gate, the camera-height panel, the statistics, the tracker worker's protocol, and log
// replay. Deterministic: every random number comes from a seeded generator.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cameraHomography, projectPoint } from '../tools/camera.mjs';
import { rectifyRectangle } from '../js/estimate.js';
import { integrate2, solve, solveWith, GATE, gateOf, GATE_LIMITS, visionPoses, focalPxForFrame, FLIP, mv, G, MAPPING_MIN_RATIO, solveWindow } from '../lab/vio/solver.js';
import { normaliseMotion, detectGyroMapping, parseGyroMapping, mappingLabel, applyGyroMapping, tapSyncOffsets } from '../lab/vio/motion.js';
import { jointML, doorVsGravity, tiltCam, cameraHeightPanel, downInCamera, RAD, cameraHeightWindow, cameraHeightInputs } from '../lab/vio/camheight.js';
import { pct, p50, p90, sessionTable, runSummary, gateText, catalogueCompare, tapeStandard, frameStats, sameResult, osVersionFromUA, exportResults } from '../lab/vio/stats.js';
import { handleMessage, createTracker, meanCornerDist, TRACK, stepRatio } from '../lab/vio/track-worker.js';
import { synthLog, solveSynth, SCENARIOS, NOISE_FREE, DOOR_H, DOOR_W, makeRng } from '../lab/vio/vi-synth.mjs';

const NOISE_FREE_PERFECT = { ...NOISE_FREE, perfectTiming: true };
const IOS_MAPPING = 'x=+alpha y=+beta z=+gamma';

describe('integrate2', () => {
  test("'hermite' is exact on a cubic (uniform and jittered sample times)", () => {
    const [a, b, c, d] = [0.3, -1.2, 2.5, -0.8];
    const y = (t) => a + b * t + c * t * t + d * t ** 3;
    const P = (t) => (a * t * t) / 2 + (b * t ** 3) / 6 + (c * t ** 4) / 12 + (d * t ** 5) / 20;
    const V = (t) => a * t + (b * t * t) / 2 + (c * t ** 3) / 3 + (d * t ** 4) / 4;
    for (const jitter of [0, 0.002]) {
      const te = new Float64Array(400);
      for (let i = 1; i < te.length; i++) te[i] = te[i - 1] + 1 / 60 + jitter * Math.sin(i * 1.7);
      const r = integrate2(te, Float64Array.from(te, y), 'hermite');
      for (let i = 0; i < te.length; i++) {
        assert.ok(Math.abs(r.P[i] - P(te[i])) < 1e-9, `P at ${i}: ${r.P[i]} vs ${P(te[i])}`);
        assert.ok(Math.abs(r.V[i] - V(te[i])) < 1e-9, `V at ${i}`);
      }
    }
  });
});

describe('solver on synthetic sweeps', () => {
  test('noise-free sweep: H within 0.3 % and W within 0.5 %', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = solveSynth(NOISE_FREE_PERFECT, seed);
      assert.ok(r.ok, `seed ${seed}: ${r.reason}`);
      assert.ok(Math.abs(r.errScalePct) < 0.3, `seed ${seed}: H ${r.errScalePct.toFixed(3)} %`);
      assert.ok(Math.abs(r.errWPct) < 0.5, `seed ${seed}: W ${r.errWPct.toFixed(3)} %`);
      assert.ok(r.gate.pass, `seed ${seed}: ${r.gate.reasons}`);
    }
  });

  test('IDEAL + WebKit 60 Hz polling (S1), through the iOS-style log: H within 1 % on 20 seeds', () => {
    for (let i = 0; i < 20; i++) {
      const r = solveWith(synthLog(SCENARIOS.S1, 1000 + i));
      assert.ok(r.ok, `seed ${1000 + i}: ${r.reason}`);
      const e = (r.Hm / DOOR_H - 1) * 100;
      assert.ok(Math.abs(e) < 1, `seed ${1000 + i}: H ${e.toFixed(3)} %`);
    }
  });

  test('baseline (S2), 100 seeds through the full page pipeline: median |scale error| < 1.5 %, p90 < 4 %', () => {
    const errs = [];
    let wrongMapping = 0;
    for (let i = 0; i < 100; i++) {
      const r = solveWith(synthLog(SCENARIOS.S2, 1000 + i));
      assert.ok(r.ok, `seed ${1000 + i}: ${r.reason}`);
      if (r.prep.mapping.label !== IOS_MAPPING) wrongMapping++;
      errs.push(Math.abs((r.Hm / DOOR_H - 1) * 100));
    }
    assert.equal(wrongMapping, 0);
    assert.ok(p50(errs) < 1.5, `median ${p50(errs).toFixed(3)} %`);
    assert.ok(p90(errs) < 4, `p90 ${p90(errs).toFixed(3)} %`);
  });

  test('an injected 40 ms camera-IMU offset is recovered within 3 ms (noise-free)', () => {
    for (const off of [0.04, -0.04]) {
      const r = solveWith(synthLog(NOISE_FREE_PERFECT, 3, { frameOffsetS: off, solver: { gyroMapping: IOS_MAPPING } }));
      assert.ok(r.ok, r.reason);
      // IMU time = video time + delta, and the video clock was shifted by +off
      assert.ok(Math.abs(r.dTr + off) < 0.003, `dTr ${r.dTr} for offset ${off}`);
      assert.ok(Math.abs(r.dRot + off) < 0.003, `dRot ${r.dRot} for offset ${off}`);
      assert.ok(Math.abs(r.Hm / DOOR_H - 1) < 0.003);
    }
  });

  test('the focal self-estimate recovers the true lens (24 / 28 mm against the 26 mm prior)', () => {
    for (const f of [24, 28]) {
      const r = solveWith(synthLog({ ...NOISE_FREE_PERFECT, focal35: [f, f] }, 5));
      assert.ok(r.ok, r.reason);
      assert.ok(Math.abs(r.focal35Est - f) < 0.3, `true ${f}: estimate ${r.focal35Est}`);
    }
  });

  test('Rotate-only: no apparent translation with a true focal; it follows the rotation with OIS or a wrong focal', () => {
    const rot = { ...NOISE_FREE_PERFECT, rotateOnly: true, rotWobbleDeg: 5 };
    const mmOf = (r) => r.centreRmsXYH * DOOR_H * 1000;
    const imuOf = (r) => r.centreRmsXYImuH * DOOR_H * 1000;
    const clean = solveSynth(rot, 2);
    assert.equal(GATE(clean), false, 'no translation: the gate must not pass');
    assert.ok(mmOf(clean) < 1, `true focal: ${mmOf(clean).toFixed(2)} mm`);
    assert.ok(imuOf(clean) < 1, `true focal, IMU-compensated: ${imuOf(clean).toFixed(2)} mm`);
    const wrongFocal = solveSynth({ ...rot, focal35: [24, 24] }, 2);
    assert.ok(mmOf(wrongFocal) > 3 * Math.max(1, mmOf(clean)), `24 mm lens taken for 26 mm: ${mmOf(wrongFocal).toFixed(2)} mm`);
    // a focal error explains that motion: little is left after fitting ln f on the centres
    assert.ok(wrongFocal.centreRmsXYAfterFocalH < 0.2 * wrongFocal.centreRmsXYH);
    assert.ok(Math.abs(wrongFocal.lnFocalFromCentres - Math.log(26 / 24)) < 0.02, `ln f ${wrongFocal.lnFocalFromCentres}`);
    // the IMU-compensated number keeps it (the IMU-to-lens offset cannot absorb a focal error), and its focal
    // fit removes it
    assert.ok(imuOf(wrongFocal) > 10, `wrong focal, IMU-compensated: ${imuOf(wrongFocal).toFixed(2)} mm`);
    assert.ok(wrongFocal.centreRmsXYImuAfterFocalH < 0.05 * wrongFocal.centreRmsXYImuH);
    const ois = solveSynth({ ...rot, ois: 1, oisFc: 0.3 }, 2);
    assert.ok(mmOf(ois) > 10, `OIS: ${mmOf(ois).toFixed(2)} mm`);
    assert.ok(imuOf(ois) > 10 && ois.centreRmsXYImuAfterFocalH * DOOR_H * 1000 > 10, `OIS, IMU-compensated: ${imuOf(ois).toFixed(2)} mm`);
  });

  test('Rotate-only turned about the wrist: the lens really moves, the IMU sees it, and the check takes it out', () => {
    // A phone turned about a wrist 10 cm below the lens: the raw centre moves several mm with no OIS at all,
    // which used to fail the go criterion; the IMU-compensated number stays at the noise floor.
    const rot = { ...NOISE_FREE_PERFECT, rotateOnly: true, rotWobbleDeg: 5, rotatePivot: [0, -0.1, 0.03] };
    const r = solveSynth(rot, 2);
    assert.ok(r.centreRmsXYH * DOOR_H * 1000 > 4, `raw ${(r.centreRmsXYH * DOOR_H * 1000).toFixed(2)} mm`);
    assert.ok(r.centreRmsXYImuH * DOOR_H * 1000 < 0.5, `IMU-compensated ${(r.centreRmsXYImuH * DOOR_H * 1000).toFixed(2)} mm`);
    // through the page pipeline (Rotate-only phases, ideal sensors with WebKit timing): the summary's
    // appTransMm is the compensated number, appTransRawMm the raw one
    const raws = [];
    const imus = [];
    for (let i = 0; i < 4; i++) {
      const log = synthLog({ ...SCENARIOS.S1, rotateOnly: true, rotWobbleDeg: 5, rotatePivot: [0, -0.1, 0.03], still: 1.2, sweepDur: [6, 7] }, 3000 + i, { mode: 'rotate' });
      const res = solveWith(log);
      assert.equal(res.prep.window.phase, 'rotate');
      const s = runSummary({ mode: 'rotate', truth: { tapeW: 820, tapeH: 2040 }, solve: res });
      raws.push(s.appTransRawMm);
      imus.push(s.appTransMm);
    }
    assert.ok(p50(raws) > 6, `raw p50 ${p50(raws)} mm`);
    assert.ok(p50(imus) < 4, `IMU-compensated p50 ${p50(imus)} mm`);
  });

  test("the page's run lengths (still 1.2 s, sweep 7-8 s): the gate passes >= 80 %, and only the sweep +- 0.6 s is solved", () => {
    // The page records still-1 >= 1 s, 7 s of sweep, still-2 >= 1 s. The research gate (6 mm on one whole-run
    // fit) rejected most such runs at unchanged accuracy (S2: 11 of 40 untrimmed).
    const N = 30;
    let pass = 0;
    let passWholeFit = 0;
    const errs = [];
    for (let i = 0; i < N; i++) {
      const log = synthLog({ ...SCENARIOS.S2, still: 1.2, sweepDur: [7, 8] }, 1000 + i);
      const r = solveWith(log);
      assert.ok(r.ok, `seed ${1000 + i}: ${r.reason}`);
      const sw = log.phases.find((p) => p.name === 'sweep');
      assert.ok(Math.abs(r.prep.window.t0 - (sw.t0 / 1000 - 0.6)) < 1e-9 && Math.abs(r.prep.window.t1 - (sw.t1 / 1000 + 0.6)) < 1e-9);
      assert.ok(r.prep.nFramesUsed < r.prep.nFramesLogged, 'the still phases beyond the margin are left out');
      assert.ok(r.windows.every((w) => Number.isFinite(w.rmsXmm)));
      if (r.gate.pass) pass++;
      if (GATE({ ...r, rmsXWinMm: NaN })) passWholeFit++;
      errs.push(Math.abs((r.Hm / DOOR_H - 1) * 100));
    }
    assert.ok(pass >= 0.8 * N, `gate pass ${pass} of ${N}`);
    assert.ok(passWholeFit < 0.7 * N, `the whole-run 6 mm test would pass ${passWholeFit} of ${N}`);
    assert.ok(p50(errs) < 1.5 && p90(errs) < 4, `|error| p50 ${p50(errs).toFixed(2)} p90 ${p90(errs).toFixed(2)} %`);
  });

  test('the window gate still rejects OIS (S10, research durations)', () => {
    let pass = 0;
    for (let i = 0; i < 20; i++) if (solveWith(synthLog(SCENARIOS.S10, 1000 + i)).gate.pass) pass++;
    assert.ok(pass <= 3, `S10 gate pass ${pass} of 20`);
  });

  test('Tap-sync: the solve leaves the taps out, so a 15 m/s^2 tap sample changes nothing', () => {
    const cfg = { ...SCENARIOS.S2, still: 1.5, sweepDur: [4, 5] };
    for (const seed of [1000, 1001]) {
      const clean = solveWith(synthLog(cfg, seed, { mode: 'tapsync' }));
      const tapped = solveWith(synthLog(cfg, seed, { mode: 'tapsync', tapSpikeMs2: 15 }));
      assert.ok(clean.ok && tapped.ok);
      for (const k of ['Hm', 'Wm', 'split', 'rmsXWinMm', 'dTr', 'dRot']) assert.equal(tapped[k], clean[k], k);
      const w = tapped.prep.window;
      assert.equal(w.tapZones.length, 2);
      for (const [z0, z1] of w.tapZones) assert.ok(w.eventT1 <= z0 || w.eventT0 >= z1, `events [${w.eventT0}, ${w.eventT1}] reach the tap zone [${z0}, ${z1}]`);
      // solved straight across the taps (the old behaviour), the same sample wrecks the fit
      const whole = solveWith(synthLog(cfg, seed, { mode: 'tapsync', tapSpikeMs2: 15 }), { trim: null });
      const wholeClean = solveWith(synthLog(cfg, seed, { mode: 'tapsync' }), { trim: null });
      assert.ok(whole.rmsMm[0] > 2 * wholeClean.rmsMm[0], `whole-run x residual ${whole.rmsMm[0]} vs ${wholeClean.rmsMm[0]}`);
    }
  });

  test('solveWindow: motion phase +- margin; a tap phase with no tap seen is left out whole; null without phases', () => {
    const log = { phases: [{ name: 'still1', t0: 0, t1: 300 }, { name: 'tap1', t0: 300, t1: 5300 }, { name: 'sweep', t0: 5300, t1: 12300 }, { name: 'still2', t0: 12300, t1: 13500 }], taps: [{ phase: 'tap1', at: null }] };
    const w = solveWindow(log, 0.6);
    assert.equal(w.phase, 'sweep');
    // no tap seen: the zone is the whole tap1 phase - 0.3 s .. + 0.6 s, then EVENT_PAD_S for the events
    assert.ok(Math.abs(w.eventT0 - 5.9) < 1e-9 && Math.abs(w.t0 - 6.2) < 1e-9, JSON.stringify(w));
    assert.ok(Math.abs(w.t1 - 12.9) < 1e-9);
    assert.equal(solveWindow({ phases: [] }, 0.6), null);
    assert.equal(solveWindow(log, null), null);
    assert.equal(solveWindow({ phases: [{ name: 'still10', t0: 0, t1: 10000 }] }, 0.6).phase, 'still10');
  });

  test('the solver returns a reason, never throws, on empty, short or NaN input', () => {
    const good = synthLog(NOISE_FREE_PERFECT, 4);
    const cases = [
      undefined,
      {},
      { frames: [], events: [], width: 720, height: 960, focalPx: 700 },
      { frames: null, events: null, width: 720, height: 960, focalPx: 700 },
      { frames: [{ t: 0, corners: [] }], events: [{ ts: 0 }], width: 720, height: 960, focalPx: 700 },
      { frames: [], events: [], width: NaN, height: 960, focalPx: 700 },
      {
        frames: Array.from({ length: 40 }, (_, i) => ({ t: i / 30, corners: [{ x: NaN, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 2 }] })),
        events: Array.from({ length: 100 }, (_, i) => ({ ts: i / 60, accG: [NaN, 9.8, 0], rot: [0, 0, 0] })),
        width: 720,
        height: 960,
        focalPx: 700,
      },
      {
        frames: Array.from({ length: 10 }, (_, i) => ({ t: i / 30, corners: [{ x: 300, y: 100 }, { x: 420, y: 100 }, { x: 420, y: 800 }, { x: 300, y: 800 }] })),
        events: Array.from({ length: 100 }, (_, i) => ({ ts: i / 60, accG: [0, 9.8, 0], rot: [0, 0, 0] })),
        width: 720,
        height: 960,
        focalPx: 700,
      },
    ];
    for (const c of cases) {
      const r = solve(c);
      assert.equal(r.ok, false);
      assert.equal(typeof r.reason, 'string');
    }
    for (const log of [null, {}, { frames: {}, tracker: {}, motion: {}, env: {} }, { ...good, motion: { n: 0 } }, { ...good, tracker: { ...good.tracker, ok: good.tracker.ok.map(() => 0) } }]) {
      const r = solveWith(log);
      assert.equal(r.ok, false);
      assert.equal(typeof r.reason, 'string');
      assert.equal(r.gate.pass, false);
    }
  });
});

describe('motion normalisation', () => {
  test('accelerometer sign: -1 for iOS-style data, +1 for W3C data', () => {
    const ios = normaliseMotion(synthLog(SCENARIOS.S1, 1001).motion);
    const w3c = normaliseMotion(synthLog(SCENARIOS.S1, 1001, { style: 'w3c' }).motion);
    assert.ok(ios.ok && w3c.ok);
    assert.equal(ios.stats.accelSign, -1);
    assert.equal(w3c.stats.accelSign, 1);
    assert.ok(ios.stats.gStill[1] > 9);
    assert.equal(ios.stats.intervalUnit, 's');
    assert.equal(w3c.stats.intervalUnit, 'ms');
    // after the sign flip both give the same specific force
    assert.deepEqual(ios.events[10].accG, w3c.events[10].accG);
  });

  test('repeats, not-later events and gaps are counted and dropped', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push({ t: i * 16, v: [0.01 * i, 0, 0, 0.1, 9.8 + 0.001 * i, 0.2, i, 2 * i, 3 * i] });
    rows.splice(10, 0, { t: 10 * 16 + 8, v: rows[9].v.slice() }); // exact repeat of the previous event, later time
    rows.splice(20, 0, { t: rows[19].t, v: [9, 9, 9, 0.1, 9.8, 0.2, 9, 9, 9] }); // same time, other values
    for (let i = 25; i < rows.length; i++) rows[i].t += 40; // one 56 ms gap
    const cols = { n: rows.length, timeStamp: [], now: [], interval: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [], alpha: [], beta: [], gamma: [] };
    for (const r of rows) {
      cols.timeStamp.push(r.t);
      cols.now.push(r.t + 1);
      cols.interval.push(16);
      ['ax', 'ay', 'az', 'gx', 'gy', 'gz', 'alpha', 'beta', 'gamma'].forEach((k, j) => cols[k].push(r.v[j]));
    }
    const out = normaliseMotion(cols);
    assert.ok(out.ok, out.reason);
    assert.equal(out.stats.repeats, 1);
    assert.equal(out.stats.notLater, 1);
    assert.equal(out.stats.gaps25, 1);
    assert.equal(out.stats.nKept, rows.length - 2);
    assert.equal(out.events.length, rows.length - 2);
    assert.ok(Math.abs(out.events[1].rotRaw[0] - RAD) < 1e-12, 'deg/s -> rad/s');
    // a JSON round trip (NaN -> null) changes nothing
    const again = normaliseMotion(JSON.parse(JSON.stringify(cols)));
    assert.deepEqual(again.stats, out.stats);
  });

  test('refuses a phone that is not upright or a gravity outside 9.3-10.3 m/s^2', () => {
    const mk = (g) => {
      const c = { n: 40, timeStamp: [], now: [], interval: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [], alpha: [], beta: [], gamma: [] };
      for (let i = 0; i < 40; i++) {
        c.timeStamp.push(i * 16);
        c.now.push(i * 16);
        c.interval.push(16);
        c.ax.push(0);
        c.ay.push(0);
        c.az.push(0);
        c.gx.push(g[0]);
        c.gy.push(g[1] + 1e-3 * i);
        c.gz.push(g[2]);
        c.alpha.push(i);
        c.beta.push(0);
        c.gamma.push(0);
      }
      return c;
    };
    assert.equal(normaliseMotion(mk([0, 9.8, 0])).ok, true);
    assert.equal(normaliseMotion(mk([7, 6.9, 0])).reason, 'not_upright');
    assert.equal(normaliseMotion(mk([0, 8.5, 0])).reason, 'gravity_out_of_range');
    assert.equal(normaliseMotion({ n: 0 }).reason, 'no_motion');
  });

  test('detectGyroMapping recovers random signed permutations with a residual ratio > 5', () => {
    const rng = makeRng(77);
    const names = ['alpha', 'beta', 'gamma'];
    const labels = ['x=+beta y=+gamma z=+alpha', IOS_MAPPING];
    while (labels.length < 6) {
      const perm = [0, 1, 2];
      for (let i = 2; i > 0; i--) {
        const j = Math.floor(rng.u() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      const signs = [0, 1, 2].map(() => (rng.u() < 0.5 ? -1 : 1));
      labels.push(mappingLabel(perm, signs));
    }
    for (const label of labels) {
      const log = synthLog(SCENARIOS.S1, 1002, { style: label });
      const w = log.env.trackSize.w;
      const h = log.env.trackSize.h;
      const norm = normaliseMotion(log.motion);
      const frames = log.frames.captureTime.map((t, i) => ({ t: t / 1000, corners: [0, 1, 2, 3].map((c) => ({ x: log.tracker.quad[8 * i + 2 * c], y: log.tracker.quad[8 * i + 2 * c + 1] })) }));
      const poses = visionPoses(frames, focalPxForFrame(26, w, h).focalPx, w, h);
      const m = detectGyroMapping(poses, norm.events);
      assert.ok(m.ok);
      assert.equal(m.label, label);
      assert.ok(m.ratio > 5, `${label}: ratio ${m.ratio}`);
      assert.deepEqual(parseGyroMapping(label), { ok: true, perm: m.perm, signs: m.signs, label });
    }
    assert.equal(names.length, 3);
    assert.equal(parseGyroMapping('x=+alpha y=+alpha z=+gamma'), null);
    assert.equal(parseGyroMapping('nonsense'), null);
    const mapped = applyGyroMapping([{ ts: 0, acc: [0, 0, 0], accG: [0, 9.8, 0], rotRaw: [1, 2, 3] }], parseGyroMapping('x=+beta y=-gamma z=+alpha'));
    assert.deepEqual(mapped[0].rot, [2, -3, 1]);
  });

  test('a Still run cannot determine the gyro mapping: marked as not determined, and kept out of the summary', () => {
    const still = { ...SCENARIOS.S2, rotateOnly: true, rotWobbleDeg: 0, still: 2, sweepDur: [8, 8] };
    for (const seed of [2001, 2002]) {
      const r = solveWith(synthLog(still, seed, { mode: 'still' }));
      const m = r.prep.mapping;
      assert.ok(m.ok && m.ratio < MAPPING_MIN_RATIO, `ratio ${m.ratio}`);
      assert.equal(m.determined, false);
      const s = runSummary({ mode: 'still', truth: {}, solve: r });
      assert.equal(s.map, null);
      assert.equal(s.mapOk, false);
      assert.equal(s.mapGuess, m.label);
    }
    const sweep = solveWith(synthLog(SCENARIOS.S1, 1004));
    assert.equal(sweep.prep.mapping.determined, true);
    assert.equal(runSummary({ mode: 'sweep', truth: {}, solve: sweep }).mapOk, true);
    assert.equal(solveWith(synthLog(SCENARIOS.S1, 1004), { gyroMapping: IOS_MAPPING }).prep.mapping.determined, true, 'a mapping set by hand counts');
  });

  test('tapSyncOffsets sees a tap frame the tracker flagged, and needs the jump to stand out', () => {
    const events = Array.from({ length: 120 }, (_, i) => ({ ts: i / 60, accG: [i === 60 ? 6 : 0, 9.8, 0] })); // the tap at 1.0 s
    const frames = Array.from({ length: 60 }, (_, i) => ({ t: i / 30 + 0.001, jumpPx: i === 31 ? 20 : 1 + 0.2 * Math.sin(i) }));
    const [r] = tapSyncOffsets(events, frames, [[0.5, 1.5]]);
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.offsetMs - (1.0 - frames[31].t) * 1000) < 1e-9, `offset ${r.offsetMs}`);
    // without the (flagged, > 8 px) tap frame the biggest jump is tracking noise: no offset
    const [r2] = tapSyncOffsets(events, frames.filter((_, i) => i !== 31), [[0.5, 1.5]]);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'no_frame_jump');
    const [r3] = tapSyncOffsets(events.map((e) => ({ ...e, accG: [0, 9.8, 0] })), frames, [[0.5, 1.5]]);
    assert.equal(r3.reason, 'no_imu_spike');
  });
});

describe('gate', () => {
  const base = { ok: true, split: 0.01, motionRmsMm: 50, rmsMm: [3, 3, 3] };
  test('boundary cases', () => {
    assert.equal(GATE(base), true);
    assert.equal(GATE({ ...base, split: GATE_LIMITS.split }), false);
    assert.equal(GATE({ ...base, split: 0.0299 }), true);
    assert.equal(GATE({ ...base, motionRmsMm: 25 }), false);
    assert.equal(GATE({ ...base, motionRmsMm: 25.01 }), true);
    assert.equal(GATE({ ...base, rmsMm: [6, 0, 0] }), false);
    assert.equal(GATE({ ...base, rmsMm: [5.99, 99, 99] }), true);
    assert.equal(GATE({ ...base, split: NaN }), false);
    assert.equal(GATE({ ...base, ok: false }), false);
    assert.equal(GATE(null), false);
    // the window median, when there is one, is tested against 4 mm instead of the whole-run fit's 6 mm
    assert.equal(GATE({ ...base, rmsXWinMm: 3.99, rmsMm: [9, 9, 9] }), true);
    assert.equal(GATE({ ...base, rmsXWinMm: GATE_LIMITS.rmsXWinMm }), false);
    assert.equal(GATE({ ...base, rmsXWinMm: NaN, rmsMm: [5.99, 0, 0] }), true);
    assert.match(gateText(gateOf({ ...base, rmsXWinMm: 4.5 })), /x residual 4\.5 mm \(median of the window fits\) is not under 4 mm/);
  });
  test('gateOf gives one plain reason per failed test, and agrees with GATE', () => {
    assert.deepEqual(gateOf(base), { pass: true, reasons: [] });
    const g = gateOf({ ...base, split: 0.05, motionRmsMm: 10, rmsMm: [7, 0, 0] });
    assert.equal(g.pass, false);
    assert.equal(g.reasons.length, 3);
    assert.match(gateText(g), /^FAIL: window spread 5\.0 %/);
    assert.equal(gateText(gateOf(base)), 'PASS');
    assert.equal(gateOf({ ok: false, reason: 'few_frames' }).reasons[0], 'no result (few_frames)');
    for (const r of [base, { ...base, split: 0.031 }, { ...base, motionRmsMm: 24 }, { ...base, rmsMm: [6.5, 0, 0] }]) assert.equal(gateOf(r).pass, GATE(r));
  });
});

describe('camera-height panel', () => {
  // A true camera from tools/camera.mjs: H = K [r1 r2 t] (door plane, mm, y down).
  const W = 720;
  const Hpx = 960;
  const f = 721;
  const door = { w: 820, h: 2040 };
  function camera({ yawDeg = 6, pitchDeg = -8, rollDeg = 1.2, distanceMm = 2300 } = {}) {
    const H = cameraHomography({ imageWidth: W, imageHeight: Hpx, focalPx: f, target: { x: 410, y: 1020 }, distanceMm, yawDeg, pitchDeg, rollDeg });
    const K = { f, cx: W / 2, cy: Hpx / 2 };
    const kinv = (j) => [(H[j] - K.cx * H[6 + j]) / K.f, (H[3 + j] - K.cy * H[6 + j]) / K.f, H[6 + j]];
    const n = Math.hypot(...kinv(0));
    const r1 = kinv(0).map((v) => v / n);
    const r2 = kinv(1).map((v) => v / n);
    const t = kinv(2).map((v) => v / n);
    const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
    // X_cam = R X + t with R = [r1 r2 r3] (columns), so the camera centre is C = -R^T t.
    const C = [r1, r2, r3].map((r) => -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]));
    const corners = [[0, 0], [door.w, 0], [door.w, door.h], [0, door.h]].map(([x, y]) => projectPoint(H, { x, y }));
    return { K, corners, down: r2, C };
  }

  test('jointML is exact (under 0.1 mm) with exact inputs', () => {
    for (const pose of [{}, { yawDeg: -12, pitchDeg: -15, rollDeg: -2 }, { distanceMm: 2800, pitchDeg: 3 }]) {
      const cam = camera(pose);
      const drop = door.h - cam.C[1]; // lens above the sill line (y down)
      const r = jointML(cam.corners, cam.K, cam.down, drop, { sigmaPx: 2, sigmaG: 0.6 * RAD, sigmaDrop: 20, sigmaLnF: 0.02 });
      assert.ok(r, 'a solution');
      assert.ok(Math.abs(r.w - door.w) < 0.1, `W ${r.w}`);
      assert.ok(Math.abs(r.h - door.h) < 0.1, `H ${r.h}`);
    }
  });

  test('the gravity-vs-door angle equals an injected tilt', () => {
    const cam = camera();
    for (const [p, r] of [[0.7, 0], [-1.3, 0], [0, 0.9], [0, -2.1]]) {
      const tilt = doorVsGravity(cam.corners, cam.K, tiltCam(cam.down, p * RAD, r * RAD));
      // The injected axis comes back exactly. Each angle is measured in its own projected plane and this
      // camera is pitched 8 deg and rolled 1.2 deg, so the other axis picks up a little (< 0.02 deg) and the
      // total angle is within 1 % of the injected one.
      if (p) assert.ok(Math.abs(tilt.pitchDeg - p) < 1e-6 && Math.abs(tilt.rollDeg) < 0.02, `pitch ${tilt.pitchDeg} roll ${tilt.rollDeg} vs ${p}`);
      else assert.ok(Math.abs(tilt.rollDeg - r) < 1e-6 && Math.abs(tilt.pitchDeg) < 0.02, `roll ${tilt.rollDeg} pitch ${tilt.pitchDeg} vs ${r}`);
      assert.ok(Math.abs(tilt.angleDeg / Math.hypot(p, r) - 1) < 0.01, `total ${tilt.angleDeg}`);
    }
    assert.ok(doorVsGravity(cam.corners, cam.K, cam.down).angleDeg < 1e-3, 'no tilt, no angle');
    const both = doorVsGravity(cam.corners, cam.K, tiltCam(cam.down, 0.8 * RAD, -0.6 * RAD));
    assert.ok(Math.abs(both.pitchDeg - 0.8) < 0.01 && Math.abs(both.rollDeg + 0.6) < 0.01);
  });

  test('the panel turns still-1 gravity (W3C device frame) into camera down, and solves from the heights', () => {
    const cam = camera();
    const fDevice = mv(FLIP, cam.down.map((v) => -v * G)); // specific force points up
    const down = downInCamera(fDevice);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(down[i] - cam.down[i]) < 1e-12);
    const drop = door.h - cam.C[1];
    const panel = cameraHeightPanel({ corners: cam.corners, width: W, height: Hpx, focalPx: f, exifFocal: true, gravityDevice: fDevice, lensHeightMm: drop + 150, sillOffsetMm: 150, statureMm: drop + 150 - 20 + 110 + 60, tapeMm: door });
    assert.ok(panel.ok);
    assert.ok(Math.abs(panel.tilt.angleDeg) < 1e-3);
    assert.ok(Math.abs(panel.taped.errHmm) < 0.1 && Math.abs(panel.taped.errWmm) < 0.1);
    assert.ok(Math.abs(panel.stature.errHmm) < 0.1);
    assert.equal(cameraHeightPanel({ corners: cam.corners, width: W, height: Hpx, focalPx: f }).reason, 'no_gravity');
  });

  test('corners and gravity come from the same verified-still second (the end of still-1), not the tap on "Yes"', () => {
    const log = synthLog({ ...SCENARIOS.S1, still: 2 }, 1003);
    assert.deepEqual(cameraHeightWindow(log.phases), { phase: 'still1', t0: 1000, t1: 2000 });
    assert.deepEqual(cameraHeightWindow([{ name: 'still10', t0: 0, t1: 10000 }]), { phase: 'still10', t0: 0, t1: 10000 });
    assert.equal(cameraHeightWindow([]), null);
    const framesOf = (lg) => lg.frames.captureTime.map((t, i) => ({ t: t / 1000, corners: [0, 1, 2, 3].map((c) => ({ x: lg.tracker.quad[8 * i + 2 * c], y: lg.tracker.quad[8 * i + 2 * c + 1] })) }));
    const a = cameraHeightInputs(log, framesOf(log));
    assert.ok(a.ok, a.reason);
    assert.ok(a.nFrames >= 25 && a.nEvents >= 50, `${a.nFrames} frames, ${a.nEvents} events`);
    // The tap on the screen and the settling at the start of still-1: the phone turned 2 deg and the picture
    // moved 10 px for the first 0.6 s.
    const bumped = JSON.parse(JSON.stringify(log));
    const c = Math.cos(2 * RAD);
    const s = Math.sin(2 * RAD);
    for (let i = 0; i < bumped.motion.n; i++) {
      if (bumped.motion.now[i] >= 600) continue;
      const [gx, gy] = [bumped.motion.gx[i], bumped.motion.gy[i]];
      bumped.motion.gx[i] = c * gx - s * gy;
      bumped.motion.gy[i] = s * gx + c * gy;
    }
    const fb = framesOf(bumped).map((fr) => (fr.t < 0.6 ? { ...fr, corners: fr.corners.map((p) => ({ x: p.x + 10, y: p.y })) } : fr));
    const b = cameraHeightInputs(bumped, fb);
    assert.deepEqual(b.gravityDevice, a.gravityDevice);
    assert.deepEqual(b.corners, a.corners);
    // the whole still-1 mean (what the panel used to take) picks the bump up
    const whole = normaliseMotion(bumped.motion, { stillMs: [0, 2000] }).stats.gStill;
    const ang = Math.acos(Math.min(1, (whole[0] * a.gravityDevice[0] + whole[1] * a.gravityDevice[1] + whole[2] * a.gravityDevice[2]) / (Math.hypot(...whole) * Math.hypot(...a.gravityDevice)))) / RAD;
    assert.ok(ang > 0.3, `whole still-1 gravity is off by ${ang.toFixed(2)} deg`);
    assert.equal(cameraHeightInputs({ phases: [] }, []).reason, 'no_still_window');
  });
});

describe('stats', () => {
  test('p50 / p90 match hand-computed values', () => {
    const v = [7, 1, 10, 3, 5, 2, 9, 4, 6, 8];
    assert.equal(p50(v), 5.5);
    assert.ok(Math.abs(p90(v) - 9.1) < 1e-12); // (n-1) * 0.9 = 8.1: 9 + 0.1 * (10 - 9)
    assert.equal(pct([4, NaN, null, 2], 50), 3);
    assert.equal(pct([5], 90), 5);
    assert.ok(Number.isNaN(p50([])));
  });

  test('tape -> catalogue size, and the catalogue comparison', () => {
    assert.equal(tapeStandard({ w: 818, h: 2043 }), '820x2040');
    assert.equal(tapeStandard({ w: 1000, h: 2400 }), null);
    const K = { f: 721, cx: 360, cy: 480 };
    const bottom = 150 + (120 * 2040) / 820; // a square-on 820 x 2040 opening, 120 px wide
    const corners = [{ x: 300, y: 150 }, { x: 420, y: 150 }, { x: 420, y: bottom }, { x: 300, y: bottom }];
    const aspectHW = rectifyRectangle(corners, K).aspectHW;
    const c = catalogueCompare({ aspectHW, corners, K, Hmm: 2045, Wmm: 818, tape: { w: 820, h: 2040 } });
    assert.equal(c.truth, '820x2040');
    assert.equal(c.withScale[0].size, '820x2040');
    assert.equal(c.hitScale, true);
    assert.equal(c.aspectOnly.length, 3);
  });

  test('session table and go / no-go', () => {
    const rows = [];
    const mk = (door, phone, errH, gate, extra = {}) => ({ mode: 'sweep', door, phone, ok: true, gate, errH, errW: errH / 2.5, errHPct: (errH / 2040) * 100, hit: true, hitA: false, f35Est: 24, ...extra });
    for (const d of ['A', 'B', 'C', 'D', 'E']) for (let k = 0; k < 3; k++) rows.push(mk(d, k % 2 ? 'P1' : 'P2', 10 * (k + 1), true));
    rows.push(mk('A', 'P1', 300, false, { ok: false }));
    rows.push({ mode: 'rotate', appTransMm: 4 }, { mode: 'still' });
    const T = sessionTable(rows);
    assert.equal(T.overall.n, 16);
    assert.ok(Math.abs(T.overall.passPct - 93.75) < 1e-9);
    assert.ok(Math.abs(T.overall.noResultPct - 6.25) < 1e-9);
    assert.equal(T.overall.H.p50, 20);
    assert.equal(T.perDoor.find((d) => d.door === 'A').n, 4);
    assert.equal(T.overall.hitScalePct, 100);
    assert.equal(T.overall.hitAspectPct, 0);
    assert.equal(T.go.verdict, 'GO');
    rows.push({ mode: 'rotate', appTransMm: 40 }, { mode: 'rotate', appTransMm: 40 });
    assert.match(sessionTable(rows).go.verdict, /STOP/);
    assert.equal(sessionTable([]).go.verdict, 'not enough runs yet');
  });

  test('go / no-go: judged on gated runs only; a Rotate-only run with no measurement is "not yet"; Tap-sync apart', () => {
    const mk = (door, phone, errH, gate, extra = {}) => ({ mode: 'sweep', door, phone, ok: true, gate, errH, errW: errH / 2.5, errHPct: (errH / 2040) * 100, hit: true, hitA: false, f35Est: 24, ...extra });
    const rows = [];
    for (const d of ['A', 'B', 'C', 'D', 'E']) for (let k = 0; k < 3; k++) rows.push(mk(d, k % 2 ? 'P1' : 'P2', 10 * (k + 1), true, { f35Est: 24 + 0.1 * k }));
    rows.push({ mode: 'rotate', appTransMm: 4 }, { mode: 'still' });
    assert.equal(sessionTable(rows).go.verdict, 'GO');
    // two gate-failed sweeps with junk focal estimates, and a stopped run (gate false) that hit only on aspect
    rows.push(mk('A', 'P1', 300, false, { f35Est: 31 }), mk('B', 'P2', 280, false, { f35Est: 19 }));
    rows.push(mk('C', 'P1', 5, false, { reason: 'door_lost', f35Est: 40, hit: false, hitA: true }));
    // a gated run on a non-standard door has no exact-hit verdict on either list
    rows.push(mk('D', 'P2', 12, true, { hit: null, hitA: null }));
    const T = sessionTable(rows);
    assert.equal(T.go.verdict, 'GO', JSON.stringify(T.go.checks));
    assert.equal(T.overall.hitScalePct, 100);
    assert.equal(T.overall.hitAspectPct, 0);
    assert.equal(T.overall.nHit, 15);
    assert.ok(T.phones.every((p) => p.f35EstP90 < 25));
    // the only Rotate-only run lost the door: no measurement, so the check is "not yet", never a NaN failure
    const noRot = sessionTable([...rows.filter((r) => r.mode !== 'rotate'), { mode: 'rotate', ok: false, reason: 'door_lost' }]);
    const rc = noRot.go.checks.find((x) => x.name.startsWith('Rotate-only'));
    assert.equal(rc.pass, null);
    assert.equal(noRot.rotate.n, 0);
    assert.equal(noRot.rotate.nAll, 1);
    assert.doesNotMatch(noRot.go.verdict, /STOP/);
    // Tap-sync runs: their own line, not in the sweep numbers or the doors
    const withTaps = sessionTable([...rows, ...[1, 2, 3].map(() => ({ ...mk('Z', 'P1', 500, false), mode: 'tapsync', tapMs: [-30, -34] }))]);
    assert.equal(withTaps.overall.n, T.overall.n);
    assert.equal(withTaps.tapsync.n, 3);
    assert.equal(withTaps.tapsync.nTaps, 6);
    assert.ok(!withTaps.perDoor.some((d) => d.door === 'Z'));
    assert.equal(withTaps.go.verdict, 'GO');
  });

  test('Download / Share leave out everything worked out from the heights unless consented', () => {
    const results = {
      solve: { ok: true },
      motionStats: { gStill: [0, 9.8, 0] },
      camheight: { ok: true, tilt: { pitchDeg: 0.4 }, taped: { ok: true, dropMm: 1300, wMm: 821, hMm: 2043, distMm: 2300, errWmm: 1, errHmm: 3 }, stature: { ok: true, dropMm: 1290, wMm: 818, hMm: 2030, distMm: 2290 } },
    };
    const out = exportResults(results, false);
    assert.deepEqual(out.camheight.taped, { omitted: 'heights not included' });
    assert.deepEqual(out.camheight.stature, { omitted: 'heights not included' });
    assert.equal(out.camheight.tilt.pitchDeg, 0.4);
    assert.equal(out.motionStats, undefined);
    assert.ok(!JSON.stringify(out).includes('2043') && !JSON.stringify(out).includes('1300'));
    assert.equal(exportResults(results, true).camheight.taped.dropMm, 1300);
    assert.equal(results.camheight.taped.hMm, 2043, 'the input is not changed');
  });

  test('the iOS version pre-fill does not trust the frozen OS 18_6 token', () => {
    const ios = (os, tail) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${tail}`;
    assert.equal(osVersionFromUA(ios('18_6', 'Version/26.0 Mobile/15E148 Safari/604.1')), '26.0');
    assert.equal(osVersionFromUA(ios('18_6', 'Version/27.1 Mobile/15E148 Safari/604.1')), '27.1');
    assert.equal(osVersionFromUA(ios('17_5', 'Version/17.5 Mobile/15E148 Safari/604.1')), '17.5');
    assert.equal(osVersionFromUA(ios('18_6', 'CriOS/140.0 Mobile/15E148 Safari/604.1')), '', 'Chrome on iOS: maybe a frozen token');
    assert.equal(osVersionFromUA(ios('17_2_1', 'CriOS/120.0 Mobile/15E148 Safari/604.1')), '17.2.1');
    assert.equal(osVersionFromUA('Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'), 'Android 14');
    assert.equal(osVersionFromUA(undefined), '');
  });

  test('runSummary of a synthetic run is one line of JSON with the key numbers', () => {
    const log = synthLog(SCENARIOS.S1, 1004);
    const solveRes = solveWith(log);
    const s = runSummary({ at: 'x', mode: 'sweep', truth: { doorId: 'D1', tapeW: 820, tapeH: 2040, phone: 'synthetic' }, solve: solveRes, frames: frameStats(log.frames, log.tracker), tracker: { drift: 0.5 } });
    assert.equal(s.ok, true);
    assert.equal(s.gate, true);
    assert.ok(Math.abs(s.errH) < 20);
    assert.equal(s.map, IOS_MAPPING);
    assert.equal(s.accelSign, -1);
    assert.ok(!JSON.stringify(s).includes('\n'));
    assert.ok(Math.abs(s.fps - 30) < 1, `fps ${s.fps}`);
  });
});

describe('replay', () => {
  test('solveWith on a stored log reproduces the stored result within 1e-9', () => {
    const log = synthLog(SCENARIOS.S2, 1007);
    log.results = { solve: JSON.parse(JSON.stringify(solveWith(log))) };
    const stored = JSON.parse(JSON.stringify(log)); // as downloaded: typed values, NaN -> null
    const again = JSON.parse(JSON.stringify(solveWith(stored)));
    assert.equal(sameResult(again, stored.results.solve, 1e-9), null);
    assert.ok(stored.results.solve.ok);
    // an override changes the answer, and the comparison notices
    const other = JSON.parse(JSON.stringify(solveWith(stored, { window: 1.5 })));
    assert.notEqual(sameResult(other, stored.results.solve, 1e-9), null);
  });
});

describe('tracker worker protocol', () => {
  // A dark door opening on a light wall, moved a few px between frames.
  function frame(dx, w = 360, h = 480) {
    const data = new Uint8ClampedArray(w * h * 4);
    const x0 = 140 + dx;
    const x1 = 220 + dx;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const inside = x >= x0 && x < x1 && y >= 60 && y < 420;
        const v = inside ? 60 : 200 + ((x * 7 + y * 13) % 9);
        const k = 4 * (y * w + x);
        data[k] = v;
        data[k + 1] = v;
        data[k + 2] = inside ? 40 : v;
        data[k + 3] = 255;
      }
    return { data, width: w, height: h };
  }
  const truth = (dx) => [{ x: 140 + dx, y: 60 }, { x: 220 + dx, y: 60 }, { x: 220 + dx, y: 420 }, { x: 140 + dx, y: 420 }];

  test('start, then track: constant-velocity prediction, snap, jump and flags', () => {
    const state = createTracker();
    assert.equal(handleMessage(state, { type: 'track', frameIndex: 0, image: frame(0) }).reason, 'not_started');
    const rough = truth(0).map((p) => ({ x: p.x + 5, y: p.y - 4 }));
    assert.equal(handleMessage(state, { type: 'start', quad: rough }).ok, true);
    const first = handleMessage(state, { type: 'track', frameIndex: 0, image: frame(0) });
    assert.equal(first.ok, true);
    assert.equal(first.flagged, false);
    assert.ok(meanCornerDist(first.quad, truth(0)) < 1.5, `start snap ${meanCornerDist(first.quad, truth(0))}`);
    let last = first;
    for (let k = 1; k <= 4; k++) {
      last = handleMessage(state, { type: 'track', frameIndex: k, image: frame(3 * k) });
      assert.equal(last.flagged, false, `frame ${k}`);
      assert.ok(meanCornerDist(last.quad, truth(3 * k)) < 1.5, `frame ${k}: ${meanCornerDist(last.quad, truth(3 * k))}`);
    }
    assert.ok(last.jumpPx < 2, `steady motion is predicted: jump ${last.jumpPx}`);
    // a sudden 20 px jump against the prediction is flagged and coasts
    const jumped = handleMessage(state, { type: 'track', frameIndex: 5, image: frame(12 + 3 + 20) });
    assert.equal(jumped.flagged, true);
    assert.ok(TRACK.flagJumpPx === 8);
    const fin = handleMessage(state, { type: 'final', focalPx: 400 });
    assert.equal(fin.type, 'final');
    assert.equal(handleMessage(state, { type: 'nonsense' }).ok, false);
    assert.equal(handleMessage(state, null).ok, false);
    assert.equal(handleMessage(state, { type: 'track', frameIndex: 1, image: { data: new Uint8Array(4), width: 10, height: 10 } }).reason, 'bad_input');
  });

  test('the predicted step scales with the frame times (frames processed unevenly)', () => {
    const state = createTracker();
    handleMessage(state, { type: 'start', quad: truth(0) });
    handleMessage(state, { type: 'track', frameIndex: 0, image: frame(0), t: 0 });
    handleMessage(state, { type: 'track', frameIndex: 1, image: frame(3), t: 33 });
    const r = handleMessage(state, { type: 'track', frameIndex: 3, image: frame(9), t: 100 }); // two frames later
    assert.ok(r.jumpPx < 1, `with frame times: jump ${r.jumpPx}`);
    const old = createTracker();
    handleMessage(old, { type: 'start', quad: truth(0) });
    handleMessage(old, { type: 'track', frameIndex: 0, image: frame(0) });
    handleMessage(old, { type: 'track', frameIndex: 1, image: frame(3) });
    const r2 = handleMessage(old, { type: 'track', frameIndex: 3, image: frame(9) });
    assert.ok(r2.jumpPx > 2.5, `without frame times the step is one frame's: jump ${r2.jumpPx}`);
    assert.ok(Math.abs(stepRatio(0, 33, 100) - 67 / 33) < 1e-12);
    assert.equal(stepRatio(NaN, 33, 100), 1);
    assert.equal(stepRatio(0, 0, 100), 1);
    assert.equal(stepRatio(0, 10, 1000), TRACK.maxStepRatio);
  });

  test("'start' with a live frame re-finds a stale outline, and needs all four sides on an edge", () => {
    // A wider door than frame() (detectDoor needs an image aspect under 4); the live frame has it at x 110..250.
    function wide({ bottom = true } = {}, w = 360, h = 480) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const inside = x >= 110 && x < 250 && y >= 60 && (!bottom || y < 420);
          const v = inside ? 60 : 200 + ((x * 7 + y * 13) % 9);
          const k = 4 * (y * w + x);
          data[k] = v;
          data[k + 1] = v;
          data[k + 2] = inside ? 40 : v;
          data[k + 3] = 255;
        }
      return { data, width: w, height: h };
    }
    const at = (dx) => [{ x: 110 + dx, y: 60 }, { x: 250 + dx, y: 60 }, { x: 250 + dx, y: 420 }, { x: 110 + dx, y: 420 }];
    // the outline was chosen seconds ago, 30 px away (beyond the 24 px start snap)
    const state = createTracker();
    const r = handleMessage(state, { type: 'start', quad: at(30), image: wide(), focalPx: 400 });
    assert.equal(r.ok, true, r.reason);
    assert.ok(meanCornerDist(r.quad, at(0)) < 1.5, `re-found ${JSON.stringify(r.quad)}`);
    assert.ok(r.support.every((v) => v >= TRACK.startSupportMin));
    assert.ok(meanCornerDist(state.last, at(0)) < 1.5, 'tracking starts from the re-found outline');
    // a side with no edge on the live frame: refused, naming it
    const r2 = handleMessage(createTracker(), { type: 'start', quad: at(0), image: wide({ bottom: false }), focalPx: 400 });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'sides_not_found');
    assert.deepEqual(r2.weak, ['bottom']);
    // without an image the quad is taken as given
    assert.equal(handleMessage(createTracker(), { type: 'start', quad: at(0) }).source, 'given');
  });

  test('detect returns the opening and de-duplicated options', () => {
    const r = handleMessage(createTracker(), { type: 'detect', id: 1, image: frame(0), prior: null, focalPx: 400 });
    assert.equal(r.type, 'detect');
    assert.equal(r.id, 1);
    if (r.ok) {
      assert.ok(r.options.length >= 1);
      assert.ok(meanCornerDist(r.options[0], truth(0)) < 3, `detected ${JSON.stringify(r.options[0])}`);
    } else assert.equal(typeof r.reason, 'string');
  });
});
