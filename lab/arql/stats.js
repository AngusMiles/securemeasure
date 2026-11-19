// Results maths for the AR Quick Look lab page. Pure: subtraction, percentages and sorting only.
//
//   W = right - left, H = head - sill (grid); W, H read straight off the tape L (its zero is the corner);
//   catalogue / outline: W = the matched line, or that line plus or minus the mm the opening is wider or
//   narrower by (the tester says which; a blank answer is no reading, never 0), H the same;
//   error = AR - tape; floor scale error = reading / true - 1 (+ means AR reads long, so door readings
//   come out that much too big). p50 / p90 are nearest-rank percentiles of the sorted values.
//
// Which rows count (rowUse): AR opened; a door gauge (A-D) stuck to the wall or the door (one lying on the
// floor cannot be read), the floor ruler (E) on the floor; not read after a pinch resized it. An upright
// gauge with no anchoring is stood on the floor by Quick Look, so its inner sill sits 20-32 mm above the
// floor (see gauge.js) and its H is left out.
//
// The go / no-go uses the product set-up only (PRODUCT), and each named door counts once (its first run).
// Every other set-up is shown in the breakdowns (bySetup, byPage) for the comparison questions.

/** Go / no-go thresholds from the test plan. */
export const GO = Object.freeze({
  doors: 10,
  openStickMin: 8,
  floorScaleMaxPct: 2,
  hP90MaxMm: 40,
  wP90MaxMm: 25,
  flowRightMin: 9,
});

/**
 * The set-up the product would ship: made on the phone (blob URL), sticks to the wall, standing up, scale
 * lock on, opened from top-level Safari (not in an iframe or another app's browser). Door accuracy uses the
 * gauges read off a scale (A, B); C and D offsets are eyeballed.
 */
export const PRODUCT = Object.freeze({
  delivery: 'blob',
  anchoring: 'vertical',
  orientation: 'xy',
  lock: true,
  doorDesigns: Object.freeze(['A', 'B', 'C', 'D']),
  accuracyDesigns: Object.freeze(['A', 'B']),
});

/**
 * How far a tape-measured opening may be from a catalogue size and still be that size (mm). Half the
 * catalogue's steps are 25 mm (widths) and 30 mm (heights), so a reading near the middle can be within
 * reach of two sizes: then the nearest wins, and an exact tie is left to the tester to pick.
 */
export const TRUE_SIZE_TOL = Object.freeze({ wMm: 30, hMm: 40 });

/** The answers to 'how does the edge sit against the line' (catalogue and outline readings). */
export const FITS = Object.freeze(['match', 'bigger', 'smaller']);

/** @param {unknown} v */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Nearest-rank percentile: the smallest value with at least q of the values at or below it.
 * @param {number[]} values
 * @param {number} q  0..1
 * @returns {number|null} null for no values
 */
export function percentile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.min(v.length, Math.max(1, Math.ceil(q * v.length)));
  return v[rank - 1];
}

/** @param {number[]} values */
function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function round(v, digits = 1) {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * The AR width and height a row's readings give, by design.
 * @param {string} design
 * @param {object} r  readings (strings or numbers)
 * @returns {{ arW: number|null, arH: number|null }}
 */
export function arSize(design, r = {}) {
  const d = String(design || '').toUpperCase();
  if (d === 'A') return { arW: num(r.right), arH: num(r.head) };
  if (d === 'B') {
    const left = num(r.left);
    const right = num(r.right);
    const sill = num(r.sill);
    const head = num(r.head);
    return { arW: left !== null && right !== null ? right - left : null, arH: sill !== null && head !== null ? head - sill : null };
  }
  if (d === 'C' || d === 'D') return { arW: lineReading(r.wLine, r.wFit, r.wOff), arH: lineReading(r.hLine, r.hFit, r.hOff) };
  return { arW: null, arH: null };
}

/**
 * A catalogue / outline reading: the line when the edge is on it, else the line plus or minus the offset
 * (its sign is ignored: the fit answer says which way). No fit answer, or no offset for one that is off,
 * is no reading.
 */
function lineReading(line, fit, off) {
  const l = num(line);
  if (l === null) return null;
  if (fit === 'match') return l;
  const o = num(off);
  if (o === null) return null;
  if (fit === 'bigger') return l + Math.abs(o);
  if (fit === 'smaller') return l - Math.abs(o);
  return null;
}

/** @param {unknown} design */
function up(design) {
  return String(design || '').toUpperCase();
}

/** A door name as a key: trimmed, lower case; null for none. */
export function doorKey(id) {
  const s = id === null || id === undefined ? '' : String(id).trim().toLowerCase();
  return s || null;
}

/** Whether an opened run stuck where it can be read: a door gauge on the wall or door, the ruler on the floor. */
export function stuckOk(row) {
  if (!row || row.opened !== 'yes') return false;
  return up(row.design) === 'E' ? row.stuck === 'floor' : row.stuck === 'wall' || row.stuck === 'door';
}

/**
 * Whether a row's readings count, and why not.
 * @param {object} row
 * @returns {{ ok: boolean, w: boolean, h: boolean, floor: boolean, why: string[] }}
 */
export function rowUse(row) {
  const r = row || {};
  const d = up(r.design);
  const why = [];
  if (r.opened !== 'yes') why.push('AR did not open');
  else if (!r.stuck) why.push('where it stuck is not answered');
  else if (!stuckOk(r)) {
    why.push(d === 'E' ? 'the ruler was not on the floor' : r.stuck === 'floor' ? 'a door gauge lying on the floor cannot be read' : 'it never stuck');
  }
  if (r.pinch === 'yes' && r.readBeforePinch !== 'yes') why.push('it was read after a pinch resized it');
  const ok = why.length === 0;
  const door = PRODUCT.doorDesigns.includes(d);
  const grounded = door && r.anchoring === 'none' && r.orientation !== 'xz';
  if (ok && grounded) why.push('no anchoring stands it on the floor, 20-32 mm below its zero: height left out');
  return { ok, w: ok && door, h: ok && door && !grounded, floor: ok && d === 'E', why };
}

/** Whether a row (or flow row) was run in the product set-up (PRODUCT), from top-level Safari. */
export function isProductSetup(row) {
  return Boolean(
    row &&
      row.delivery === PRODUCT.delivery &&
      row.anchoring === PRODUCT.anchoring &&
      row.orientation === PRODUCT.orientation &&
      row.lock === PRODUCT.lock &&
      row.framed === false &&
      !row.inApp,
  );
}

/** Where a row was run, for the by-page breakdown. */
export function pageKind(row) {
  if (!row || (row.framed !== true && row.framed !== false)) return 'not recorded';
  if (row.framed) return 'inside an iframe';
  return row.inApp ? `other browser (${row.inApp})` : 'top-level';
}

/**
 * Everything the page works out for one After-AR row.
 * @param {{ design: string, readings?: object, tape?: { w?: unknown, h?: unknown } }} row
 * @returns {{ arW: number|null, arH: number|null, errW: number|null, errH: number|null,
 *   errWPct: number|null, errHPct: number|null, scale1000: number|null, scale2000: number|null,
 *   floorScalePct: number|null }}
 */
export function computeRow(row) {
  const { arW, arH } = arSize(row.design, row.readings);
  const tw = num(row.tape && row.tape.w);
  const th = num(row.tape && row.tape.h);
  const errW = arW !== null && tw !== null ? arW - tw : null;
  const errH = arH !== null && th !== null ? arH - th : null;
  const r = row.readings || {};
  const r1000 = String(row.design).toUpperCase() === 'E' ? num(r.r1000) : null;
  const r2000 = String(row.design).toUpperCase() === 'E' ? num(r.r2000) : null;
  const scale1000 = r1000 !== null ? r1000 / 1000 - 1 : null;
  const scale2000 = r2000 !== null ? r2000 / 2000 - 1 : null;
  // The longer distance says more about scale; the 1000 mm mark stands in when it is all there is.
  const floor = scale2000 !== null ? scale2000 : scale1000;
  return {
    arW: round(arW),
    arH: round(arH),
    errW: round(errW),
    errH: round(errH),
    errWPct: errW !== null && tw ? round((errW / tw) * 100, 2) : null,
    errHPct: errH !== null && th ? round((errH / th) * 100, 2) : null,
    scale1000: round(scale1000, 5),
    scale2000: round(scale2000, 5),
    floorScalePct: floor !== null ? round(floor * 100, 2) : null,
  };
}

function errStats(values) {
  const abs = values.map(Math.abs);
  return { n: values.length, p50: round(percentile(abs, 0.5)), p90: round(percentile(abs, 0.9)), bias: round(mean(values)) };
}

function pct(part, whole) {
  return whole ? round((part / whole) * 100, 0) : null;
}

/** Opened / stuck / lock-held counts of some runs. */
function runCounts(list) {
  const answeredOpen = list.filter((r) => r.opened);
  const answeredStuck = list.filter((r) => r.opened === 'yes' && r.stuck);
  const locked = list.filter((r) => r.lock === true && (r.pinch === 'yes' || r.pinch === 'no'));
  return {
    runs: list.length,
    openAnswered: answeredOpen.length,
    opened: answeredOpen.filter((r) => r.opened === 'yes').length,
    stuckAnswered: answeredStuck.length,
    stuck: answeredStuck.filter(stuckOk).length,
    lockRuns: locked.length,
    lockHeld: locked.filter((r) => r.pinch === 'no').length,
  };
}

/** Runs grouped by a key, in first-seen order, each with its counts. */
function breakdown(list, keyOf) {
  const groups = new Map();
  for (const r of list) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups].map(([key, rs]) => ({ key, ...runCounts(rs) }));
}

/** The first item per named door (in saved order), and how many had no name. */
function firstPerDoor(items, doorOf) {
  const doors = new Map();
  let unnamed = 0;
  for (const x of items) {
    const k = doorKey(doorOf(x));
    if (!k) unnamed++;
    else if (!doors.has(k)) doors.set(k, x);
  }
  return { first: [...doors.values()], unnamed };
}

function distinctDoors(items, doorOf) {
  return new Set(items.map((x) => doorKey(doorOf(x))).filter(Boolean)).size;
}

/**
 * The session table.
 * @param {Array<object>} rows  After-AR rows (each with design, opened, stuck, lock, pinch, readBeforePinch,
 *   anchoring, orientation, delivery, framed, inApp, readings, tape)
 * @returns {object}
 */
export function summarize(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const items = list.map((r) => ({ r, c: computeRow(r), use: rowUse(r) }));
  const doorOf = (x) => x.r.tape && x.r.tape.doorId;
  const wItems = items.filter((x) => x.use.w && x.c.errW !== null);
  const hItems = items.filter((x) => x.use.h && x.c.errH !== null);
  const floor = items.filter((x) => x.use.floor && x.c.floorScalePct !== null).map((x) => x.c.floorScalePct);
  const read = items.filter((x) => x.c.errW !== null || x.c.errH !== null || x.c.floorScalePct !== null);
  const counts = runCounts(list);

  // Go / no-go: the product set-up only. Opens and sticks: a door gauge's first run on each named door.
  const productDoor = items.filter((x) => PRODUCT.doorDesigns.includes(up(x.r.design)) && isProductSetup(x.r) && x.r.opened);
  const perDoor = firstPerDoor(productDoor, doorOf);
  const accurate = (x) => isProductSetup(x.r) && PRODUCT.accuracyDesigns.includes(up(x.r.design));
  const pw = wItems.filter(accurate);
  const ph = hItems.filter(accurate);

  return {
    rows: list.length,
    n: items.filter((x) => (x.use.w && x.c.errW !== null) || (x.use.h && x.c.errH !== null)).length,
    leftOut: read.filter((x) => !x.use.ok).length,
    w: errStats(wItems.map((x) => x.c.errW)),
    h: errStats(hItems.map((x) => x.c.errH)),
    floor: { n: floor.length, p50: round(percentile(floor.map(Math.abs), 0.5), 2), p90: round(percentile(floor.map(Math.abs), 0.9), 2), bias: round(mean(floor), 2) },
    openedPct: pct(counts.opened, counts.openAnswered),
    stuckPct: pct(counts.stuck, counts.stuckAnswered),
    lockHeldPct: pct(counts.lockHeld, counts.lockRuns),
    lockRuns: counts.lockRuns,
    product: {
      runs: productDoor.length,
      runsOk: productDoor.filter((x) => stuckOk(x.r)).length,
      doors: perDoor.first.length,
      doorsOk: perDoor.first.filter((x) => stuckOk(x.r)).length,
      unnamedRuns: perDoor.unnamed,
      w: { ...errStats(pw.map((x) => x.c.errW)), doors: distinctDoors(pw, doorOf) },
      h: { ...errStats(ph.map((x) => x.c.errH)), doors: distinctDoors(ph, doorOf) },
    },
    bySetup: breakdown(list, (r) => `${r.anchoring || '?'} / ${r.orientation || '?'} / ${r.delivery || '?'}`),
    byPage: breakdown(list, pageKind),
  };
}

/** A { widthMm, heightMm } with two positive numbers, or null. */
function sizeOf(s) {
  if (!s || typeof s !== 'object') return null;
  const w = Number(s.widthMm);
  const h = Number(s.heightMm);
  return w > 0 && h > 0 ? { widthMm: w, heightMm: h } : null;
}

/**
 * Whether two catalogue sizes are the same size (exactly: both come from the catalogue).
 * @param {{ widthMm?: number, heightMm?: number }|null} a
 * @param {{ widthMm?: number, heightMm?: number }|null} b
 * @returns {boolean|null} null when either is missing
 */
export function sameSize(a, b) {
  const x = sizeOf(a);
  const y = sizeOf(b);
  if (!x || !y) return null;
  return x.widthMm === y.widthMm && x.heightMm === y.heightMm;
}

/**
 * The catalogue size a tape-measured opening is: the nearest within TRUE_SIZE_TOL (distance in units of the
 * tolerance), or null when none is that near or two are equally near.
 * @param {{ w?: unknown, h?: unknown }|null} tape
 * @param {Array<{ widthMm: number, heightMm: number }>} sizes
 * @returns {{ widthMm: number, heightMm: number }|null}
 */
export function standardForTape(tape, sizes) {
  const w = num(tape && tape.w);
  const h = num(tape && tape.h);
  if (w === null || h === null) return null;
  let best = null;
  let bestD = Infinity;
  let tie = false;
  for (const raw of Array.isArray(sizes) ? sizes : []) {
    const s = sizeOf(raw);
    if (!s) continue;
    const dw = Math.abs(w - s.widthMm);
    const dh = Math.abs(h - s.heightMm);
    if (dw > TRUE_SIZE_TOL.wMm || dh > TRUE_SIZE_TOL.hMm) continue;
    const d = Math.hypot(dw / TRUE_SIZE_TOL.wMm, dh / TRUE_SIZE_TOL.hMm);
    if (d < bestD - 1e-9) {
      best = s;
      bestD = d;
      tie = false;
    } else if (Math.abs(d - bestD) <= 1e-9 && !sameSize(s, best)) {
      tie = true;
    }
  }
  return best && !tie ? best : null;
}

/**
 * The standard size a flow row's door really is: the one the tester picked or said is none (trueSize),
 * else the catalogue size its tape belongs to (rows saved before trueSize existed).
 * @param {object} row
 * @param {Array<{ widthMm: number, heightMm: number }>} [sizes]
 */
export function flowTruth(row, sizes = []) {
  if (!row) return null;
  if (Object.prototype.hasOwnProperty.call(row, 'trueSize')) return sizeOf(row.trueSize);
  return standardForTape(row.tape, sizes);
}

/**
 * The product-flow table.
 * @param {Array<{ aspectTop1?: object, arPick?: object, trueSize?: object|null, tape?: object, unsure?: boolean,
 *   secs?: number, doorId?: string }>} flowRows
 * @param {Array<{ widthMm: number, heightMm: number }>} [sizes]  the catalogue, for rows with only a tape
 */
export function summarizeFlow(flowRows, sizes = []) {
  const list = Array.isArray(flowRows) ? flowRows.filter((r) => r && typeof r === 'object') : [];
  const items = list.map((r) => {
    const truth = flowTruth(r, sizes);
    return { r, truth, ar: sameSize(r.arPick, truth), photo: sameSize(r.aspectTop1, truth) };
  });
  // A judged door has a known standard size and a photo answer; no AR pick on it is a miss.
  const judged = items.filter((x) => x.truth && (x.r.arPick || x.r.aspectTop1));
  const unsure = judged.filter((x) => x.r.unsure);
  const secs = list.map((r) => num(r.secs)).filter((v) => v !== null);
  const perDoor = firstPerDoor(judged.filter((x) => isProductSetup(x.r)), (x) => x.r.doorId);
  const pUnsure = perDoor.first.filter((x) => x.r.unsure);
  return {
    rows: list.length,
    judged: judged.length,
    unknownSize: list.length - items.filter((x) => x.truth).length,
    arRight: judged.filter((x) => x.ar === true).length,
    arPicked: list.filter((r) => r.arPick).length,
    aspectRight: judged.filter((x) => x.photo === true).length,
    unsure: unsure.length,
    unsureArRight: unsure.filter((x) => x.ar === true).length,
    bannerEvents: list.filter((r) => r.arPick && r.arPickVia === 'banner').length,
    secsP50: round(percentile(secs, 0.5), 0),
    product: {
      doors: perDoor.first.length,
      arRight: perDoor.first.filter((x) => x.ar === true).length,
      unsure: pUnsure.length,
      unsureArRight: pUnsure.filter((x) => x.ar === true).length,
      unnamed: perDoor.unnamed,
    },
  };
}

/**
 * The go / no-go criteria, each 'go', 'no-go' or 'not enough data'. Product set-up only (see summarize).
 * @param {ReturnType<typeof summarize>} s
 * @param {ReturnType<typeof summarizeFlow>} f
 * @param {{ bannerSeen: boolean }} extra
 */
export function goNoGo(s, f, { bannerSeen = false } = {}) {
  const verdict = (enough, ok) => (!enough ? 'not enough data' : ok ? 'go' : 'no-go');
  const p = s.product;
  const fp = f.product;
  const unnamed = (n, what) => (n ? ` (+${n} ${what} with no door name, not counted)` : '');
  const gauges = PRODUCT.accuracyDesigns.join(', ');
  return [
    {
      id: 'open_stick',
      text: `Opens from Safari and sticks on at least ${GO.openStickMin} of ${GO.doors} doors (first run on each named door)`,
      value: p.doors ? `${p.doorsOk} of ${p.doors} doors; runs ${p.runsOk} of ${p.runs}${unnamed(p.unnamedRuns, 'runs')}` : `-${unnamed(p.unnamedRuns, 'runs')}`,
      verdict: verdict(p.doors >= GO.doors, p.doors > 0 && p.doorsOk / p.doors >= GO.openStickMin / GO.doors),
    },
    {
      id: 'floor_scale',
      text: `Floor-check scale error ${GO.floorScaleMaxPct} % or less (p90)`,
      value: s.floor.n ? `p90 ${s.floor.p90} %` : '-',
      verdict: verdict(s.floor.n >= 3, s.floor.p90 !== null && s.floor.p90 <= GO.floorScaleMaxPct),
    },
    {
      id: 'door_h',
      text: `Door readings (gauges ${gauges}): H p90 ${GO.hP90MaxMm} mm or less, on ${GO.doors} named doors`,
      value: p.h.n ? `p90 ${p.h.p90} mm (n ${p.h.n}, ${p.h.doors} doors)` : '-',
      verdict: verdict(p.h.doors >= GO.doors, p.h.p90 !== null && p.h.p90 <= GO.hP90MaxMm),
    },
    {
      id: 'door_w',
      text: `Door readings (gauges ${gauges}): W p90 ${GO.wP90MaxMm} mm or less, on ${GO.doors} named doors`,
      value: p.w.n ? `p90 ${p.w.p90} mm (n ${p.w.n}, ${p.w.doors} doors)` : '-',
      verdict: verdict(p.w.doors >= GO.doors, p.w.p90 !== null && p.w.p90 <= GO.wP90MaxMm),
    },
    {
      id: 'banner',
      text: "The 'This size fits' event arrives",
      value: bannerSeen ? 'seen' : 'not yet',
      verdict: bannerSeen ? 'go' : 'not enough data',
    },
    {
      id: 'flow',
      text: `Product flow: the AR pick is right on at least ${GO.flowRightMin} of ${GO.doors} doors, unsure ones included (first try on each named door)`,
      value: fp.doors ? `${fp.arRight} of ${fp.doors} (unsure: ${fp.unsureArRight} of ${fp.unsure})${unnamed(fp.unnamed, 'rows')}` : `-${unnamed(fp.unnamed, 'rows')}`,
      verdict: verdict(fp.doors >= GO.doors, fp.doors > 0 && fp.arRight / fp.doors >= GO.flowRightMin / GO.doors),
    },
  ];
}

/**
 * Seconds spent away from the page after an AR tap, from the page's own event log: the first time the
 * page is visible again (visibilitychange, pageshow, focus or a fresh load) after it was hidden, minus
 * the tap time. A page iOS reloaded without logging that it went away counts from the tap to the load.
 * @param {Array<{ t: number, type: string, detail?: string }>} events  sorted by time
 * @param {number} tapAt  ms
 * @returns {{ awaySec: number|null, hiddenSec: number|null }}
 */
export function timeAway(events, tapAt) {
  if (!Number.isFinite(tapAt)) return { awaySec: null, hiddenSec: null };
  const after = (events || []).filter((e) => e.t >= tapAt);
  const hidden = after.find((e) => (e.type === 'visibilitychange' && e.detail === 'hidden') || e.type === 'pagehide' || e.type === 'blur');
  if (!hidden) {
    const load = after.find((e) => e.type === 'load');
    return load ? { awaySec: round((load.t - tapAt) / 1000, 1), hiddenSec: null } : { awaySec: null, hiddenSec: null };
  }
  const back = after.find(
    (e) => e.t > hidden.t && ((e.type === 'visibilitychange' && e.detail === 'visible') || e.type === 'pageshow' || e.type === 'focus' || e.type === 'load'),
  );
  if (!back) return { awaySec: null, hiddenSec: null };
  return { awaySec: round((back.t - tapAt) / 1000, 1), hiddenSec: round((back.t - hidden.t) / 1000, 1) };
}

/**
 * Time away over every AR tap of one run (the same gauge opened again after Object view or a failed
 * stick): the sum of each tap's timeAway, each looking only at the events before the next tap.
 * @param {Array<{ t: number, type: string, detail?: string }>} events  sorted by time
 * @param {number[]} taps  ms
 * @returns {{ awaySec: number|null, hiddenSec: number|null, sessions: number }}
 */
export function timeAwayAll(events, taps) {
  const list = (Array.isArray(taps) ? taps : []).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  let away = null;
  let hidden = null;
  list.forEach((tap, i) => {
    const next = i + 1 < list.length ? list[i + 1] : Infinity;
    const r = timeAway((events || []).filter((e) => e.t < next), tap);
    if (r.awaySec !== null) away = (away || 0) + r.awaySec;
    if (r.hiddenSec !== null) hidden = (hidden || 0) + r.hiddenSec;
  });
  return { awaySec: round(away, 1), hiddenSec: round(hidden, 1), sessions: list.length };
}
