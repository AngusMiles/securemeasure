// Statistics for the lab page (lab/vio/): percentiles, the per-run one-line summary, the session table, the
// gate text, the catalogue comparison and the frame / tracker numbers. Pure ES module, no DOM.

import { classifyStandard, aspectSigmaLn, sigmaLnScaleFromP90, DEFAULT_STANDARD_SIZES } from '../../js/estimate.js';
import { GATE_TEXT } from './solver.js';

const toNum = (v) => (typeof v === 'number' ? v : v === null || v === undefined ? NaN : Number(v));
const finite = (a) => Array.from(a || [], toNum).filter(Number.isFinite);

/**
 * Percentile with linear interpolation between order statistics (numpy's default): p in 0..100, over the
 * finite values only; NaN when there are none.
 */
export function pct(values, p) {
  const s = finite(values).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = (s.length - 1) * (p / 100);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}
export const p50 = (v) => pct(v, 50);
export const p90 = (v) => pct(v, 90);
export function mean(values) {
  const s = finite(values);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
}
export function sd(values) {
  const s = finite(values);
  if (s.length < 2) return NaN;
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1));
}
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** 'PASS' or 'FAIL: reason; reason'. */
export function gateText(gate) {
  if (!gate) return 'FAIL: no result';
  return gate.pass ? 'PASS' : `FAIL: ${(gate.reasons || []).join('; ') || 'no result'}`;
}
export { GATE_TEXT };

// ------------------------------------------------------------------------------------------------ catalogue
const sizeKey = (s) => `${s.widthMm}x${s.heightMm}`;

/**
 * The standard size the tape says the door is: the catalogue size nearest in ln space, if it is within 3 % on
 * both sides; null for a non-standard door (then no exact-hit is scored).
 */
export function tapeStandard(tape, sizes = DEFAULT_STANDARD_SIZES) {
  const w = toNum(tape && tape.w);
  const h = toNum(tape && tape.h);
  if (!(w > 0 && h > 0)) return null;
  let best = null;
  for (const s of sizes) {
    const d = Math.hypot(Math.log(w / s.widthMm), Math.log(h / s.heightMm));
    if (!best || d < best.d) best = { d, s };
  }
  if (!best || Math.abs(Math.log(w / best.s.widthMm)) > Math.log(1.03) || Math.abs(Math.log(h / best.s.heightMm)) > Math.log(1.03)) return null;
  return sizeKey(best.s);
}

/**
 * Catalogue match with the measured scale and from the aspect alone.
 * @param {object} o
 * @param {number} o.aspectHW      median rectified height / width
 * @param {{x,y}[]} o.corners      a representative frame's corners (for the aspect sigma)
 * @param {{f,cx,cy}} o.K
 * @param {number} o.focalSigmaLn  0.02 with EXIF, 0.08 with the prior
 * @param {number} [o.Hmm]         measured height (mm); with Wmm, the scale prior is used
 * @param {number} [o.Wmm]
 * @param {{w?: number, h?: number}} [o.tape]
 */
export function catalogueCompare({ aspectHW, corners, K, focalSigmaLn = 0.08, cornerSigmaPx = 1.5, Hmm, Wmm, tape, sizes = DEFAULT_STANDARD_SIZES } = {}) {
  let sigA = NaN;
  try {
    sigA = aspectSigmaLn(corners, K, cornerSigmaPx, focalSigmaLn) + 0.01;
  } catch {
    sigA = NaN;
  }
  if (!Number.isFinite(sigA)) sigA = 0.05;
  const top = (list) => list.slice(0, 3).map((c) => ({ size: sizeKey(c), p: round(c.p, 3) }));
  const withScale =
    Number.isFinite(Hmm) && Number.isFinite(Wmm)
      ? classifyStandard({ aspectHW, sigmaLnAspect: sigA, estimateMm: { w: Wmm, h: Hmm }, sigmaLnScale: sigmaLnScaleFromP90(5), sizes })
      : [];
  const aspectOnly = classifyStandard({ aspectHW, sigmaLnAspect: sigA, sizes });
  const truth = tapeStandard(tape, sizes);
  const hit = (list) => (truth && list.length ? sizeKey(list[0]) === truth : null);
  return { sigmaLnAspect: sigA, withScale: top(withScale), aspectOnly: top(aspectOnly), truth, hitScale: hit(withScale), hitAspect: hit(aspectOnly) };
}

// ------------------------------------------------------------------------------------------------ frames
/**
 * Video and tracker numbers from a log's frame and tracker arrays.
 * status: 0 posted to the worker, 1 skipped (worker busy), 2 strided (every second frame), 3 not tracked.
 */
export function frameStats(frames, tracker) {
  const n = Math.min(toNum(frames && frames.n) || 0, (frames && frames.now ? frames.now.length : 0));
  const out = { n };
  if (!n) return out;
  const now = Array.from(frames.now, toNum).slice(0, n);
  const cap = Array.from(frames.captureTime || [], toNum).slice(0, n);
  const pres = Array.from(frames.presentationTime || [], toNum).slice(0, n);
  const pf = Array.from(frames.presentedFrames || [], toNum).slice(0, n);
  const span = (now[n - 1] - now[0]) / 1000;
  out.callbackFps = span > 0 ? (n - 1) / span : NaN;
  const pfFin = pf.filter(Number.isFinite);
  out.presentedFps = span > 0 && pfFin.length > 1 ? (pfFin[pfFin.length - 1] - pfFin[0]) / span : NaN;
  out.missedCallbacks = pfFin.length > 1 ? pfFin[pfFin.length - 1] - pfFin[0] + 1 - pfFin.length : 0;
  const capN = cap.filter(Number.isFinite).length;
  out.captureTimeFrames = capN;
  out.captureTimePresent = capN > 0;
  const lags = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(cap[i]) && Number.isFinite(pres[i])) lags.push(cap[i] - pres[i]);
  out.captureMinusPresentationMs = mean(lags);
  const st = Array.from(frames.status || [], toNum).slice(0, n);
  out.posted = st.filter((s) => s === 0).length;
  out.skipped = st.filter((s) => s === 1).length;
  out.strided = st.filter((s) => s === 2).length;
  out.notTracked = st.filter((s) => s === 3).length;
  if (tracker) {
    const ok = Array.from(tracker.ok || [], toNum).slice(0, n);
    const fl = Array.from(tracker.flagged || [], toNum).slice(0, n);
    const ms = Array.from(tracker.ms || [], toNum).slice(0, n);
    let tracked = 0;
    let flagged = 0;
    let run = 0;
    let maxRun = 0;
    for (let i = 0; i < n; i++) {
      if (st[i] !== 0) continue;
      if (fl[i] === 1) {
        flagged++;
        run++;
        maxRun = Math.max(maxRun, run);
      } else if (ok[i] === 1) {
        tracked++;
        run = 0;
      }
    }
    out.tracked = tracked;
    out.flagged = flagged;
    out.maxFlaggedRun = maxRun;
    out.trackedPct = (100 * tracked) / n;
    out.skippedPct = (100 * out.skipped) / n;
    out.flaggedPct = (100 * flagged) / n;
    out.trackerMsP50 = p50(ms);
    out.trackerMsP95 = pct(ms, 95);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ summary
/**
 * The one-line JSON summary of a run ('Copy result', and a row of the session).
 * @param {object} run  { at, mode, truth, solve, sensors, frames, tracker, catalogue, camheight, tapSync,
 *   noise, aborted, includeHeights }
 */
export function runSummary(run) {
  const s = run.solve || {};
  const t = run.truth || {};
  const ok = Boolean(s.ok) && !run.aborted;
  const Hmm = s.ok ? s.Hm * 1000 : NaN;
  const Wmm = s.ok ? s.Wm * 1000 : NaN;
  const tapeH = toNum(t.tapeH);
  const tapeW = toNum(t.tapeW);
  const m = (s.prep && s.prep.motion) || {};
  const map = (s.prep && s.prep.mapping) || {};
  const f = run.frames || {};
  const out = {
    v: 1,
    at: run.at,
    mode: run.mode,
    door: t.doorId || '',
    phone: t.phone || '',
    ios: t.ios || '',
    tapeW: round(tapeW, 0),
    tapeH: round(tapeH, 0),
    ok,
    reason: run.aborted || (s.ok ? null : s.reason || 'no_result'),
    gate: Boolean(s.gate && s.gate.pass) && !run.aborted,
    why: s.gate && !s.gate.pass ? s.gate.reasons : [],
    Hmm: round(Hmm, 0),
    Wmm: round(Wmm, 0),
    errH: round(Hmm - tapeH, 1),
    errW: round(Wmm - tapeW, 1),
    errHPct: round((Hmm / tapeH - 1) * 100, 2),
    errWPct: round((Wmm / tapeW - 1) * 100, 2),
    splitPct: round(s.split * 100, 2),
    motionRmsMm: round(s.motionRmsMm, 1),
    sweepPpMm: round(s.sweepPpMm, 0),
    rmsMm: (s.rmsMm || []).map((v) => round(v, 2)),
    rmsXWinMm: round(s.rmsXWinMm, 2),
    dRotMs: round(s.dRot * 1000, 1),
    dTrMs: round(s.dTr * 1000, 1),
    gyroBiasDegS: (s.gyroBiasEst || []).map((v) => round((v * 180) / Math.PI, 3)),
    f35: s.prep && s.prep.focal ? s.prep.focal.f35 : null,
    fSrc: s.prep && s.prep.focal ? s.prep.focal.source : null,
    f35Est: round(s.focal35Est, 2),
    rho: round(s.rho, 4),
    aspect: round(s.aspectHW, 4),
    nFrames: s.nFrames || 0,
    hz: round(m.hz, 1),
    dtSdMs: round(m.dtSdMs, 2),
    repeatsPct: round(m.repeatsPct, 1),
    gaps25: m.gaps25 ?? null,
    accelSign: m.accelSign ?? null,
    // The gyro mapping only when the vision rotation determined it (ratio >= 5, or set by hand); a Still run's
    // near-random pick is kept apart (mapGuess) so that it is not read as WebKit's alpha / beta / gamma order.
    map: map.label && map.determined ? map.label : null,
    mapOk: Boolean(map.label && map.determined),
    mapGuess: map.label && !map.determined ? map.label : undefined,
    mapRatio: round(map.ratio, 1),
    g: round(m.gNorm, 3),
    fps: round(f.callbackFps, 1),
    capT: f.captureTimePresent ?? null,
    trackedPct: round(f.trackedPct, 1),
    flaggedPct: round(f.flaggedPct, 1),
    trkP50: round(f.trackerMsP50, 1),
    trkP95: round(f.trackerMsP95, 1),
    drift: round(run.tracker && run.tracker.drift, 1),
  };
  // Apparent camera translation in mm (door-height units x the taped height, or a nominal 2040 mm door when no
  // tape was typed). appTransMm is the motion vision sees and the IMU does not (solver imuCentreMotion): a
  // hand-held phone turned about the wrist really moves its lens, which the IMU sees too, so in a Rotate-only
  // run this should be about 0 unless OIS (or a wrong focal) moves the picture. appTransRawMm is the raw
  // gyro-aided centre motion, lever arm included.
  const basis = Number.isFinite(tapeH) && tapeH > 0 ? tapeH : 2040;
  if (Number.isFinite(s.centreRmsXYImuH)) {
    out.appTransMm = round(s.centreRmsXYImuH * basis, 1);
    out.appTransAfterFocalMm = round(s.centreRmsXYImuAfterFocalH * basis, 1);
  }
  if (Number.isFinite(s.centreRmsXYH)) {
    out.appTransRawMm = round(s.centreRmsXYH * basis, 1);
    out.appTransRawAfterFocalMm = round(s.centreRmsXYAfterFocalH * basis, 1);
  }
  if (Number.isFinite(s.centreRmsXYImuH) || Number.isFinite(s.centreRmsXYH)) out.appTransBasis = basis === tapeH ? 'tape' : 'nominal 2040';
  const c = run.catalogue;
  if (c) {
    out.cat = c.withScale.map((x) => `${x.size} ${x.p}`);
    out.catA = c.aspectOnly.map((x) => `${x.size} ${x.p}`);
    out.hit = c.hitScale;
    out.hitA = c.hitAspect;
  }
  const ch = run.camheight;
  if (ch && ch.ok) {
    out.chPitch = round(ch.tilt.pitchDeg, 2);
    out.chRoll = round(ch.tilt.rollDeg, 2);
    if (ch.taped && ch.taped.ok) out.chTaped = { errW: round(ch.taped.errWmm, 0), errH: round(ch.taped.errHmm, 0) };
    if (ch.stature && ch.stature.ok) out.chStature = { errW: round(ch.stature.errWmm, 0), errH: round(ch.stature.errHmm, 0) };
    if (run.includeHeights) {
      if (ch.taped) out.chTapedDrop = round(ch.taped.dropMm, 0);
      if (ch.stature) out.chStatureDrop = round(ch.stature.dropMm, 0);
    }
  }
  if (run.tapSync) out.tapMs = run.tapSync.map((x) => (x.ok ? round(x.offsetMs, 1) : null));
  if (run.noise) {
    out.noise = {
      gyroAxes: run.noise.gyroAxes || 'x/y/z',
      accSd: run.noise.accSd.map((v) => round(v, 4)),
      gyroSdDegS: run.noise.gyroSdDegS.map((v) => round(v, 3)),
      gyroMeanDegS: run.noise.gyroMeanDegS.map((v) => round(v, 3)),
      cornerSdPx: round(run.noise.cornerSdMeanPx, 2),
      cornerLag1: round(run.noise.cornerLag1Mean, 2),
    };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ session
// Only Sweep runs count towards the go / no-go. Tap-sync runs are a timing cross-check: their taps are cut out
// of the solve, but the runs are reported on their own line, not pooled with the sweeps.
const SWEEP_MODES = new Set(['sweep']);

/**
 * Error, gate and catalogue numbers of a group of runs. Everything that judges a result (errors, scale p90,
 * both exact-hit rates) is over the same runs: those that passed the gate and were not stopped early
 * (row.gate is false for a stopped run).
 */
function groupStats(rows) {
  const n = rows.length;
  const gated = rows.filter((r) => r.gate === true);
  const solved = rows.filter((r) => r.ok);
  const absW = gated.map((r) => Math.abs(toNum(r.errW)));
  const absH = gated.map((r) => Math.abs(toNum(r.errH)));
  const absS = gated.map((r) => Math.abs(toNum(r.errHPct)));
  // Both hit rates over the gated runs that have both a with-scale and an aspect-only verdict.
  const hitRows = gated.filter((r) => (r.hit === true || r.hit === false) && (r.hitA === true || r.hitA === false));
  return {
    n,
    passPct: n ? (100 * gated.length) / n : NaN,
    noResultPct: n ? (100 * (n - solved.length)) / n : NaN,
    nGated: gated.length,
    W: { p50: p50(absW), p90: p90(absW), bias: mean(gated.map((r) => r.errW)) },
    H: { p50: p50(absH), p90: p90(absH), bias: mean(gated.map((r) => r.errH)) },
    Hall: { p50: p50(solved.map((r) => Math.abs(toNum(r.errH)))), p90: p90(solved.map((r) => Math.abs(toNum(r.errH)))) },
    scaleP90Pct: p90(absS),
    hitScalePct: hitRows.length ? (100 * hitRows.filter((r) => r.hit).length) / hitRows.length : NaN,
    hitAspectPct: hitRows.length ? (100 * hitRows.filter((r) => r.hitA).length) / hitRows.length : NaN,
    nHit: hitRows.length,
  };
}

/**
 * The session table: Sweep runs per door and overall, Tap-sync runs on their own, the Rotate-only and Still
 * runs, the focal self-estimate per phone (over gated sweeps), and the go / no-go checks.
 * @param {object[]} summaries  runSummary rows
 */
export function sessionTable(summaries) {
  const rows = (summaries || []).filter((r) => r && typeof r === 'object');
  const sweeps = rows.filter((r) => SWEEP_MODES.has(r.mode));
  const doors = [...new Set(sweeps.map((r) => r.door || '(no id)'))];
  const perDoor = doors.map((d) => ({ door: d, ...groupStats(sweeps.filter((r) => (r.door || '(no id)') === d)) }));
  const overall = groupStats(sweeps);
  const taps = rows.filter((r) => r.mode === 'tapsync');
  const tapMs = taps.flatMap((r) => (Array.isArray(r.tapMs) ? r.tapMs : []));
  const tapsync = { ...groupStats(taps), tapMsP50: p50(tapMs), nTaps: finite(tapMs).length, dTrMsP50: p50(taps.filter((r) => r.gate === true).map((r) => r.dTrMs)) };
  // Rotate-only: only runs with a measured apparent translation count (a run that lost the door or had no
  // motion has none); with none the check is "not yet", never a NaN that fails it.
  const rot = rows.filter((r) => r.mode === 'rotate' && Number.isFinite(toNum(r.appTransMm)));
  const rotAll = rows.filter((r) => r.mode === 'rotate');
  const rotate = { n: rot.length, nAll: rotAll.length, appTransP50: p50(rot.map((r) => r.appTransMm)), appTransP90: p90(rot.map((r) => r.appTransMm)), appTransMax: Math.max(...finite(rot.map((r) => r.appTransMm)), -Infinity) };
  if (!Number.isFinite(rotate.appTransMax)) rotate.appTransMax = NaN;
  const still = rows.filter((r) => r.mode === 'still');
  // The focal self-estimate of a run the gate rejected (or that stopped early) is junk: gated sweeps only.
  const gatedSweeps = sweeps.filter((r) => r.gate === true);
  const phones = [...new Set(sweeps.map((r) => r.phone || '(no model)'))].map((ph) => {
    const est = gatedSweeps.filter((r) => (r.phone || '(no model)') === ph).map((r) => r.f35Est);
    return { phone: ph, n: finite(est).length, f35EstP50: p50(est), f35EstP10: pct(est, 10), f35EstP90: pct(est, 90) };
  });
  return { perDoor, overall, tapsync, rotate, still: { n: still.length }, phones, go: goNoGo({ overall, rotate, phones, sweeps, doors, rot, still }) };
}

/**
 * Go only if: >= 70 % of sweeps pass the gate; gated |scale error| p90 <= 4 % (H about 80 mm or less);
 * Rotate-only apparent translation RMS < 10 mm. Stop if OIS shows up (Rotate-only fails, or the focal
 * estimate wanders) or the gate rejects most sweeps. Also says whether the test set is complete yet.
 * Sweep runs only (not Tap-sync); `rot` holds only Rotate-only runs with a measured apparent translation.
 */
export function goNoGo({ overall, rotate, phones, sweeps, doors, rot, still }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  add('sweeps passing the gate >= 70 %', overall.n ? overall.passPct >= 70 : null, `${fmt(overall.passPct, 0)} % of ${overall.n}`);
  add('gated |scale error| p90 <= 4 %', overall.nGated ? overall.scaleP90Pct <= 4 : null, `${fmt(overall.scaleP90Pct, 2)} % (H p90 ${fmt(overall.H.p90, 0)} mm)`);
  const rotNote = rotate.nAll > rotate.n ? ` (${rotate.nAll - rotate.n} more with no measurement)` : '';
  add('Rotate-only apparent translation RMS < 10 mm', rotate.n ? rotate.appTransP90 < 10 : null, `p90 ${fmt(rotate.appTransP90, 1)} mm, max ${fmt(rotate.appTransMax, 1)} mm over ${rotate.n}${rotNote}`);
  const wander = phones.filter((p) => p.n >= 3 && p.f35EstP90 - p.f35EstP10 > 2);
  add('focal self-estimate steady (p10-p90 within 2 mm per phone, gated sweeps)', phones.some((p) => p.n >= 3) ? wander.length === 0 : null, phones.map((p) => `${p.phone}: ${fmt(p.f35EstP10, 1)}-${fmt(p.f35EstP90, 1)} mm (n ${p.n})`).join('; ') || 'no sweeps');
  const perDoorMin = doors.length ? Math.min(...doors.map((d) => sweeps.filter((r) => (r.door || '(no id)') === d).length)) : 0;
  const nPhones = new Set(sweeps.map((r) => r.phone).filter(Boolean)).size;
  const complete = nPhones >= 2 && doors.length >= 5 && perDoorMin >= 3 && rot.length >= 1 && still.length >= 1;
  const set = `${nPhones} phones, ${doors.length} doors, min ${perDoorMin} sweeps per door, ${rot.length} rotate-only, ${still.length} still`;
  const decided = checks.filter((c) => c.pass !== null);
  let verdict = 'not enough runs yet';
  if (decided.some((c) => c.pass === false)) verdict = 'STOP / NO-GO on the runs so far';
  else if (complete && decided.length === checks.length) verdict = 'GO';
  else if (decided.length) verdict = 'on track (test set not complete)';
  return { verdict, complete, set, checks };
}
const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

// ------------------------------------------------------------------------------------------------ export
/**
 * A run's results as stored in the log (Download, Share). Without consent (includeHeights false) nothing
 * derived from the typed heights goes out: not the drop, and not the camera-height sizes, distances or
 * errors of panels (b) and (c) either, because the log also holds the corners and the gravity, from which
 * the drop is about h x dot(down, mid) and the stature follows. Panel (a) (door vs gravity) stays.
 * motionStats (a copy of solve.prep.motion) is left out.
 */
export function exportResults(results, includeHeights) {
  const out = JSON.parse(JSON.stringify({ ...results, motionStats: undefined }));
  if (!includeHeights && out.camheight) {
    for (const k of ['taped', 'stature']) if (out.camheight[k]) out.camheight[k] = { omitted: 'heights not included' };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ form
/**
 * A guess at the OS version for the page to pre-fill (the tester can correct it), or '' to leave the field
 * empty. iPhone: Safari 26 and later are reported to freeze the "OS 18_6 like Mac OS X" token, so Safari's
 * own Version/NN.N (which follows the iOS version) comes first. Without it (Chrome or Firefox on iOS) the OS
 * token is only trusted below 18.6: 18.6 itself may be the frozen value of a newer iOS, so the field stays
 * empty for the tester to type.
 */
export function osVersionFromUA(ua) {
  const s = typeof ua === 'string' ? ua : '';
  if (/iPhone|iPad|iPod/.test(s)) {
    const ver = s.match(/Version\/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (ver) return `${ver[1]}.${ver[2]}${ver[3] ? `.${ver[3]}` : ''}`;
    const os = s.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/);
    if (os && (Number(os[1]) < 18 || (Number(os[1]) === 18 && Number(os[2]) < 6))) return `${os[1]}.${os[2]}${os[3] ? `.${os[3]}` : ''}`;
    return '';
  }
  const a = s.match(/Android (\d+(?:\.\d+)?)/);
  return a ? `Android ${a[1]}` : '';
}

// ------------------------------------------------------------------------------------------------ replay
/**
 * First path at which two results differ (relative tolerance), or null when they agree. null in a JSON log
 * stands for NaN. Used by replay.mjs and the tests to check that a stored log reproduces its result.
 */
export function sameResult(a, b, tol = 1e-9, path = '') {
  const n = (v) => (v === null || v === undefined ? NaN : v);
  if (typeof a === 'number' || typeof b === 'number' || a === null || b === null) {
    const x = n(a);
    const y = n(b);
    if (Number.isNaN(x) && Number.isNaN(y)) return null;
    if (typeof x !== 'number' || typeof y !== 'number') return path || '(root)';
    return Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y)) ? null : path || '(root)';
  }
  if (typeof a !== typeof b) return path || '(root)';
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return path;
    for (let i = 0; i < a.length; i++) {
      const d = sameResult(a[i], b[i], tol, `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[k] === undefined && b[k] === undefined) continue;
      const d = sameResult(a[k], b[k], tol, path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : path || '(root)';
}
