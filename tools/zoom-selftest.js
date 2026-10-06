// Self-test for the pure zoom math in public/js/editor/zoom.js (no DOM needed).
// Run: /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tools/zoom-selftest.js
// Exits non-zero (uncaught exception) on any failure.

import { zoomStateAt, clampFocus, findZoomSlot, constrainZoom, planAutoZooms, scanAutoZooms } from '../public/js/editor/zoom.js';
import { ZOOM_DEFAULTS } from '../public/js/lib/project.js';

const log = typeof print === 'function' ? print : (...a) => console.log(...a);
const T = ZOOM_DEFAULTS.transition;
const MIN = ZOOM_DEFAULTS.minDuration;
let checks = 0, failures = 0;

function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    log('FAIL ' + msg);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const fmt = (v) => JSON.stringify(v);

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let zid = 0;
const Z = (start, end, scale = 2, x = 0.5, y = 0.5) => ({ id: 'z' + ++zid, start, end, scale, x, y, auto: false });
const project = (duration, zooms = [], trim = { start: 0, end: duration }) => ({ duration, edit: { trim, zooms } });

// ---------------------------------------------------------------------------------
// clampFocus

{
  const a = clampFocus(2, 0, 1);
  ok(near(a.x, 0.25) && near(a.y, 0.75), 'clampFocus(2,0,1) → ' + fmt(a));
  const b = clampFocus(1, 0.1, 0.9);
  ok(near(b.x, 0.5) && near(b.y, 0.5), 'clampFocus at 1× centers → ' + fmt(b));
  const c = clampFocus(NaN, NaN, NaN);
  ok(near(c.x, 0.5) && near(c.y, 0.5), 'clampFocus(NaN) → ' + fmt(c));
  const d = clampFocus(4, 0.5, 0.2);
  ok(near(d.x, 0.5) && near(d.y, 0.2), 'clampFocus keeps valid focus → ' + fmt(d));
}

// ---------------------------------------------------------------------------------
// zoomStateAt: semantics

{
  const id = zoomStateAt([], 3);
  ok(id.scale === 1 && id.x === 0.5 && id.y === 0.5, 'no zooms → identity');
  ok(zoomStateAt(null, 3).scale === 1, 'null zooms → identity');

  const single = [Z(2, 6, 2, 0.3, 0.7)];
  ok(zoomStateAt(single, 1.9).scale === 1, 'before zoom → 1×');
  const hold = zoomStateAt(single, 4);
  ok(near(hold.scale, 2) && near(hold.x, 0.3) && near(hold.y, 0.7), 'hold → zoom state ' + fmt(hold));
  const mid = zoomStateAt(single, 2 + T / 2);
  ok(mid.scale > 1.01 && mid.scale < 1.99, 'mid ease-in strictly between ' + fmt(mid));
  ok(near(zoomStateAt(single, 2 + T).scale, 2), 'fully zoomed after transition');
  ok(near(zoomStateAt(single, 6 - T).scale, 2), 'still zoomed when ease-out starts');
  ok(zoomStateAt(single, 6).scale === 1, 'back to 1× at end');
  ok(zoomStateAt(single, 7).scale === 1, 'after zoom → 1×');

  // Short zoom: transition shrinks to 40% of its length, so it still reaches full scale.
  const short = [Z(1, 1.6, 3, 0.5, 0.5)];
  ok(near(zoomStateAt(short, 1 + 0.24 + 1e-9).scale, 3, 1e-5), 'short zoom reaches full scale at 40%');
  ok(near(zoomStateAt(short, 1.3).scale, 3), 'short zoom holds in the middle');

  // Chained: gap < 2T → never dips towards 1× between the zooms.
  const chained = [Z(1, 3, 2, 0.2, 0.2), Z(3.5, 6, 3, 0.8, 0.8)];
  let minScale = Infinity;
  for (let t = 3; t <= 3.5; t += 0.01) minScale = Math.min(minScale, zoomStateAt(chained, t).scale);
  ok(minScale >= 2 - 1e-9, 'chained zooms stay zoomed across the gap (min ' + minScale + ')');
  const pan = zoomStateAt(chained, 3.25);
  ok(pan.x > 0.2 + 1e-3 && pan.x < 0.8 - 1e-3, 'chained pan moves focus ' + fmt(pan));

  // Gap ≥ 2T → returns to 1× in between.
  const apart = [Z(1, 3, 2), Z(3 + 2 * T + 0.5, 8, 2)];
  ok(zoomStateAt(apart, 3 + T + 0.25).scale === 1, 'separate zooms dip to 1×');

  // Corrupt input: overlapping + unsorted must not throw and must stay valid.
  const messy = [Z(3, 6, 2.5, 0.9, 0.1), Z(1, 4, 2, 0.1, 0.9), { start: NaN, end: 2 }, null, Z(5, 5, 2)];
  const m = zoomStateAt(messy, 3.5);
  ok(m.scale >= 1 && Number.isFinite(m.x) && Number.isFinite(m.y), 'messy input handled ' + fmt(m));
}

// ---------------------------------------------------------------------------------
// zoomStateAt: continuity (dense sampling + probing every breakpoint from both sides)

function breakpoints(zooms, transition) {
  const pts = [];
  for (const z of zooms) {
    const tr = Math.min(transition, 0.4 * (z.end - z.start));
    pts.push(z.start, z.end, z.start + tr, z.end - tr, z.start + tr / 2, z.end - tr / 2);
  }
  return pts;
}

function validState(s) {
  const half = 0.5 / s.scale;
  return s.scale >= 1 - 1e-9 && s.x >= half - 1e-9 && s.x <= 1 - half + 1e-9 && s.y >= half - 1e-9 && s.y <= 1 - half + 1e-9;
}

function checkContinuity(name, zooms, { transition = T, from = 0, to = null, dt = 1e-4 } = {}) {
  const end = to ?? Math.max(0, ...zooms.map((z) => z.end)) + 1;
  const n = Math.ceil((end - from) / dt);
  let prev = zoomStateAt(zooms, from, transition);
  let worst = { ds: 0, dxy: 0, t: from };
  let invalid = 0;
  for (let i = 1; i <= n; i++) {
    const t = from + i * dt;
    const s = zoomStateAt(zooms, t, transition);
    if (!validState(s)) invalid++;
    const ds = Math.abs(s.scale - prev.scale);
    const dxy = Math.max(Math.abs(s.x - prev.x), Math.abs(s.y - prev.y));
    if (ds > worst.ds) worst = { ...worst, ds, t };
    if (dxy > worst.dxy) worst = { ...worst, dxy };
    prev = s;
  }
  // Bounds assume scale ≤ 4 and zooms ≥ minDuration (steepest ease ≈ 1.5/(0.4·0.6) per second).
  ok(worst.ds < 0.01, `${name}: scale jump ${worst.ds.toFixed(5)} at t=${worst.t.toFixed(4)}`);
  ok(worst.dxy < 0.005, `${name}: focus jump ${worst.dxy.toFixed(5)}`);
  ok(invalid === 0, `${name}: ${invalid} states with the crop outside the source`);

  let edge = 0;
  for (const b of breakpoints(zooms, transition)) {
    const a = zoomStateAt(zooms, b - 1e-9, transition), c = zoomStateAt(zooms, b + 1e-9, transition);
    edge = Math.max(edge, Math.abs(a.scale - c.scale), Math.abs(a.x - c.x), Math.abs(a.y - c.y));
  }
  ok(edge < 1e-5, `${name}: jump of ${edge} across a breakpoint`);
}

checkContinuity('single', [Z(2, 5, 2, 0.3, 0.7)]);
checkContinuity('back-to-back', [Z(1, 3, 2, 0.2, 0.2), Z(3, 5, 3, 0.8, 0.8)]);
checkContinuity('small gap', [Z(1, 3, 2, 0.2, 0.8), Z(3.5, 6, 2, 0.8, 0.2)]);
checkContinuity('gap = 2T', [Z(1, 3, 2, 0.2, 0.2), Z(3 + 2 * T, 6, 3, 0.8, 0.8)]);
checkContinuity('gap = 2T − ε', [Z(1, 3, 2, 0.2, 0.2), Z(3 + 2 * T - 1e-7, 6, 3, 0.8, 0.8)]);
checkContinuity('gap = 2T + ε', [Z(1, 3, 2, 0.2, 0.2), Z(3 + 2 * T + 1e-7, 6, 3, 0.8, 0.8)]);
checkContinuity('short chain', [Z(1, 1.6, 4, 0.1, 0.1), Z(1.6, 2.2, 1.1, 0.9, 0.9), Z(2.25, 2.85, 4, 0.9, 0.1), Z(2.9, 3.5, 2, 0.1, 0.9)]);
checkContinuity('trim edges', [Z(0, 2, 2.5, 0.1, 0.1), Z(8, 10, 2.5, 0.9, 0.9)], { from: 0, to: 10 });
checkContinuity('same scale pan', [Z(1, 3, 2, 0.25, 0.25), Z(3.2, 5, 2, 0.75, 0.75)]);
checkContinuity('overlapping input', [Z(1, 4, 2, 0.1, 0.9), Z(3, 6, 3, 0.9, 0.1)]);

{
  const rand = rng(1234);
  let failedBefore = failures;
  for (let c = 0; c < 200 && failures === failedBefore; c++) {
    const zooms = [];
    let t = rand() * 2;
    const n = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      const len = MIN + rand() * rand() * 5;
      const scale = 1.1 + rand() * 2.9;
      zooms.push(Z(t, t + len, scale, rand(), rand()));
      const r = rand();
      t += len + (r < 0.25 ? 0 : r < 0.5 ? rand() * 2 * T : rand() * 3);
    }
    checkContinuity('random #' + c + ' ' + fmt(zooms.map((z) => [z.start, z.end, z.scale].map((v) => +v.toFixed(3)))), zooms, { dt: 1e-4 });
  }
}

// ---------------------------------------------------------------------------------
// constrainZoom

{
  const A = Z(1, 3), B = Z(5, 7), C = Z(8, 9);
  const p = project(10, [A, B, C]);
  const eq = (r, s, e, msg) => ok(near(r.start, s) && near(r.end, e), `${msg}: ${fmt(r)} ≠ [${s}, ${e}]`);
  eq(constrainZoom(p, B.id, 2, 4, 'move'), 3, 5, 'move into left neighbour');
  eq(constrainZoom(p, B.id, 7, 9, 'move'), 6, 8, 'move into right neighbour');
  eq(constrainZoom(p, B.id, -5, -3, 'move'), 3, 5, 'cannot jump over a neighbour');
  eq(constrainZoom(p, B.id, 4, 6, 'move'), 4, 6, 'free move');
  eq(constrainZoom(p, B.id, 2, 7, 'start'), 3, 7, 'resize start into neighbour');
  eq(constrainZoom(p, B.id, 6.9, 7, 'start'), 7 - MIN, 7, 'resize start below min');
  eq(constrainZoom(p, B.id, 5, 9, 'end'), 5, 8, 'resize end into neighbour');
  eq(constrainZoom(p, B.id, 5, 5.1, 'end'), 5, 5 + MIN, 'resize end below min');
  eq(constrainZoom(p, C.id, 9.5, 10.5, 'move'), 9, 10, 'move past duration');
  eq(constrainZoom(p, A.id, -1, 1, 'move'), 0, 2, 'move before 0');
  eq(constrainZoom(p, B.id, 4, 4.2, 'move'), 4, 4 + MIN, 'move keeps ≥ minDuration');
  eq(constrainZoom(p, 'new', 3.5, 4.5, 'move'), 3.5, 4.5, 'unknown id: free slot kept');
  eq(constrainZoom(p, 'new', 2.5, 4.5, 'move'), 3, 5, 'unknown id: pushed out of overlap');
  const r = constrainZoom(project(10, [Z(0, 4.8), Z(5.1, 10)]), 'new', 4, 6, 'move');
  ok(r.end - r.start >= 0 && r.start >= 4.8 - 1e-9 && r.end <= 5.1 + 1e-9, 'no room: never overlaps ' + fmt(r));
}

// ---------------------------------------------------------------------------------
// findZoomSlot

{
  const D = ZOOM_DEFAULTS.duration;
  const eq = (r, s, e, msg) => ok(r && near(r.start, s) && near(r.end, e), `${msg}: ${fmt(r)} ≠ [${s}, ${e}]`);
  eq(findZoomSlot(project(10), 2), 2, 2 + D, 'empty project');
  eq(findZoomSlot(project(10), 9), 10 - D, 10, 'near end: full length, still covers playhead');
  eq(findZoomSlot(project(10), 10), 10 - D, 10, 'at end');
  eq(findZoomSlot(project(10, [Z(2, 5)]), 3), 5, 5 + D, 'inside a zoom → next gap');
  eq(findZoomSlot(project(10, [Z(2, 5)]), 1), 0, 2, 'gap shorter than the default: fills it and covers the playhead');
  eq(findZoomSlot(project(10, [], { start: 1, end: 9 }), 0), 1, 1 + D, 'before trim start');
  eq(findZoomSlot(project(10, [], { start: 1, end: 9 }), 9.5), 9 - D, 9, 'after trim end');
  eq(findZoomSlot(project(10, [Z(0, 4), Z(4.7, 10)]), 1), 4, 4.7, 'only a short gap left');
  eq(findZoomSlot(project(10), 3, 1), 3, 4, 'custom duration');
  ok(findZoomSlot(project(10, [Z(0, 10)]), 3) === null, 'no room → null');
  ok(findZoomSlot(project(10, [Z(0, 4.7), Z(5, 10)]), 1) === null, 'gap < minDuration → null');
  ok(findZoomSlot(project(0.3), 0) === null, 'recording shorter than minDuration → null');
  const slot = findZoomSlot(project(10, [Z(1, 3), Z(6, 8)]), 2);
  ok(slot && slot.start >= 3 - 1e-9 && slot.end <= 6 + 1e-9 && slot.end - slot.start >= MIN, 'slot fits between zooms ' + fmt(slot));
}

// ---------------------------------------------------------------------------------
// planAutoZooms (motion samples → zooms)

function hist(n, from, to, per) {
  const h = new Uint32Array(n);
  for (let i = Math.floor(from * n); i < Math.ceil(to * n); i++) h[i] = per;
  return h;
}
function samples(duration, events, step = 0.5) {
  const out = [];
  for (let t = 0; t + step <= duration + 1e-9; t += step) {
    const ev = events.find((e) => t >= e.from - 1e-9 && t + step <= e.to + 1e-9);
    if (!ev) out.push({ t0: t, t1: t + step, changed: 0.0002, hx: null, hy: null });
    else if (ev.global) out.push({ t0: t, t1: t + step, changed: 0.6, hx: null, hy: null });
    else out.push({ t0: t, t1: t + step, changed: ev.changed || 0.02, hx: hist(160, ev.x0, ev.x1, 12), hy: hist(90, ev.y0, ev.y1, 20) });
  }
  return out;
}

{
  const one = planAutoZooms(samples(30, [{ from: 5, to: 8, x0: 0.6, x1: 0.8, y0: 0.1, y1: 0.3 }, { from: 15, to: 18, global: true }]), { start: 0, end: 30 });
  ok(one.length === 1, 'one localized burst → one zoom ' + fmt(one));
  if (one.length === 1) {
    const z = one[0];
    ok(near(z.start, 4.6, 1e-3) && near(z.end, 8.8, 1e-3), 'zoom = burst −0.4 / +0.8 ' + fmt(z));
    ok(z.scale >= 1.5 && z.scale <= 2.4, 'scale in [1.5, 2.4] ' + z.scale);
    ok(near(z.x, 0.7, 0.03), 'focus x ≈ centroid ' + z.x);
    const f = clampFocus(z.scale, z.x, z.y);
    ok(near(f.x, z.x) && near(f.y, z.y), 'focus is clamped ' + fmt(z));
    ok(z.auto === true, 'auto flag');
  }

  ok(planAutoZooms(samples(30, [{ from: 5, to: 6, x0: 0.6, x1: 0.8, y0: 0.1, y1: 0.3 }])).length === 0, 'burst < 1.2s ignored');
  ok(planAutoZooms(samples(30, [{ from: 5, to: 10, global: true }])).length === 0, 'global change ignored');
  ok(planAutoZooms(samples(30, [{ from: 5, to: 10, x0: 0, x1: 1, y0: 0, y1: 1, changed: 0.3 }])).length === 0, 'frame-wide change ignored');

  const merged = planAutoZooms(samples(30, [{ from: 5, to: 7, x0: 0.1, x1: 0.3, y0: 0.6, y1: 0.8 }, { from: 8, to: 10, x0: 0.1, x1: 0.3, y0: 0.6, y1: 0.8 }]), { start: 0, end: 30 });
  ok(merged.length === 1 && near(merged[0].start, 4.6, 1e-3) && near(merged[0].end, 10.8, 1e-3), 'bursts < 1.5s apart merge ' + fmt(merged));

  const spaced = planAutoZooms(samples(40, [
    { from: 5, to: 7, x0: 0.1, x1: 0.3, y0: 0.1, y1: 0.3, changed: 0.01 },
    { from: 8, to: 12, x0: 0.6, x1: 0.8, y0: 0.6, y1: 0.8, changed: 0.05 },
    { from: 25, to: 27, x0: 0.4, x1: 0.6, y0: 0.4, y1: 0.6 },
  ]), { start: 0, end: 40 });
  ok(spaced.length === 2, 'max one zoom per ~4s ' + fmt(spaced));
  ok(spaced.length === 2 && near(spaced[0].start, 7.6, 1e-3), 'stronger burst wins ' + fmt(spaced));
  const drift = planAutoZooms(samples(30, [{ from: 5, to: 8, x0: 0.05, x1: 0.2, y0: 0.05, y1: 0.2 }, { from: 8, to: 11, x0: 0.75, x1: 0.9, y0: 0.75, y1: 0.9 }]), { start: 0, end: 30 });
  ok(drift.length >= 1 && drift.every((z) => z.scale >= 1.5), 'activity that moves across the screen splits instead of one huge zoom ' + fmt(drift));
  let overlap = false;
  for (let i = 1; i < spaced.length; i++) overlap ||= spaced[i].start < spaced[i - 1].end;
  ok(!overlap, 'auto zooms never overlap');

  const trimmed = planAutoZooms(samples(30, [{ from: 5, to: 8, x0: 0.6, x1: 0.8, y0: 0.1, y1: 0.3 }]), { start: 4.8, end: 8.5 });
  ok(trimmed.length === 1 && near(trimmed[0].start, 4.8) && near(trimmed[0].end, 8.5), 'clamped to trim ' + fmt(trimmed));

  const gappy = samples(30, [{ from: 5, to: 8, x0: 0.6, x1: 0.8, y0: 0.1, y1: 0.3 }]);
  gappy[12] = { ...gappy[12], changed: 0.0002, hx: null, hy: null }; // one quiet sample inside the burst
  ok(planAutoZooms(gappy, { start: 0, end: 30 }).length === 1, 'single-sample gap tolerated');
  ok(planAutoZooms([], {}).length === 0 && planAutoZooms(null).length === 0, 'empty input');

  // Coarse grids (long recordings sample every length/600 s): one sample can hold a change that
  // came and went, so it is never "sustained" on its own, and a seconds-long quiet sample ends a burst.
  const corner = { x0: 0.75, x1: 0.95, y0: 0.03, y1: 0.13 };
  ok(planAutoZooms(samples(60, [{ from: 30, to: 33, ...corner }], 3), { start: 0, end: 60 }).length === 0, 'one 3s sample is not sustained');
  ok(planAutoZooms(samples(60, [{ from: 29.9, to: 31.3, ...corner }], 1.2), { start: 0, end: 60 }).length === 0, 'one 1.2s sample is not sustained');
  ok(planAutoZooms(samples(60, [{ from: 30, to: 33, ...corner }, { from: 36, to: 39, ...corner }], 3), { start: 0, end: 60 }).length === 0,
    'a 3s quiet sample is not tolerated inside a burst');
  ok(planAutoZooms(samples(60, [{ from: 30, to: 39, ...corner }], 3), { start: 0, end: 60 }).length === 1, 'three coarse samples in a row still zoom');
  const halfGap = samples(30, [{ from: 5, to: 5.5, ...corner }, { from: 6, to: 6.5, ...corner }]);
  ok(planAutoZooms(halfGap, { start: 0, end: 30 }).length === 1, '0.5s grid unchanged: change, quiet, change still zooms');
}

// ---------------------------------------------------------------------------------
// scanAutoZooms: the same screen activity must give the same zooms whatever the recording length

// Screen model: `typing` changes its region continuously while active; `toast` is static while
// visible, so it only changes the frame when it appears and when it leaves.
function screen(events) {
  const visible = (e, t) => t >= e.from && t < e.to;
  const sampleAt = (t0, t1) => {
    const hx = new Uint32Array(160), hy = new Uint32Array(90);
    let changed = 0;
    for (const e of events) {
      const hit = e.kind === 'typing' ? t0 < e.to && t1 > e.from : visible(e, t0) !== visible(e, t1);
      if (!hit) continue;
      const ex = hist(160, e.x0, e.x1, 12), ey = hist(90, e.y0, e.y1, 20);
      for (let i = 0; i < 160; i++) hx[i] += ex[i];
      for (let i = 0; i < 90; i++) hy[i] += ey[i];
      changed += e.kind === 'typing' ? 0.02 : 0.01;
    }
    return changed ? { t0, t1, changed, hx, hy } : { t0, t1, changed: 0.0002, hx: null, hy: null };
  };
  const stats = { frames: 0, spans: [] };
  const sampleSpan = async (from, to, step, progress) => {
    const count = Math.floor((to - from) / step + 1e-6) + 1;
    stats.spans.push({ from, to, step, count });
    const out = [];
    for (let k = 0; k < count; k++) {
      stats.frames++;
      if (k) out.push(sampleAt(from + (k - 1) * step, from + k * step));
      progress((k + 1) / count);
      await null;
    }
    return out;
  };
  return { sampleSpan, stats };
}

const typing = (from, to) => ({ kind: 'typing', from, to, x0: 0.1, x1: 0.3, y0: 0.6, y1: 0.8 });
const toast = (from, to) => ({ kind: 'toast', from, to, x0: 0.75, x1: 0.95, y0: 0.03, y1: 0.13 });
const inCorner = (z) => z.x > 0.5 && z.y < 0.5;
const covers = (zs, from, to) => zs.some((z) => z.start <= from + 1e-9 && z.end >= to - 1e-9 && !inCorner(z));

{
  const events = [
    typing(50, 70),         // a long session
    typing(100.3, 104.6),   // a short burst
    toast(149.5, 151.5),    // 2s toast: straddles one frame on every coarse grid
    toast(200.2, 205.2),    // 5s notification banner
    toast(250.5, 252.5), toast(256.5, 258.5), // two toasts back to back: a 3-sample run at a 6s step
  ];
  const results = {};
  for (const length of [300, 720.6, 900, 1234.5, 1800, 3600]) {
    const { sampleSpan, stats } = screen(events);
    const progress = [];
    const zs = await scanAutoZooms(sampleSpan, { start: 0, end: length, last: length - 0.05, onProgress: (f) => progress.push(f) });
    results[length] = zs;
    const tag = ` (${length}s recording) ` + fmt(zs.map((z) => [z.start, z.end, z.x, z.y]));
    ok(!zs.some(inCorner), 'toasts and banners never zoom' + tag);
    ok(covers(zs, 50, 70), 'long typing session zooms' + tag);
    ok(covers(zs, 100.3, 104.6), 'short typing burst zooms' + tag);
    ok(zs.length === 2, 'exactly the two typing moments' + tag);
    ok(stats.frames <= 2 * 600 + 2 * stats.spans.length, `at most ~2× the frames of one pass (${stats.frames} frames, ${stats.spans.length} spans)` + tag);
    ok(stats.spans.every((s) => s.from >= -1e-9 && s.from + (s.count - 1) * s.step <= length - 0.05 + 1e-6), 'frames stay inside [start, last]' + tag);
    ok(progress.length > 0 && progress.every((f, i) => f >= 0 && f <= 1 && (!i || f >= progress[i - 1] - 1e-12)) && progress[progress.length - 1] === 1,
      'progress is monotonic and ends at 1' + tag);
    if (length <= 300) ok(stats.spans.length === 1 && near(stats.spans[0].step, 0.5), 'short recordings: one plain 0.5s pass' + tag);
  }
  // Grids that stay on the 0.5s lattice give exactly the short-recording answer.
  for (const length of [900, 1800, 3600]) {
    ok(fmt(results[length]) === fmt(results[300]), `${length}s recording plans the same zooms as 300s: ` + fmt(results[length]) + ' vs ' + fmt(results[300]));
  }

  // Before the re-scan, a 2-sample run on a 6s grid looked sustained (shown here on the coarse samples alone).
  const coarseOnly = [];
  await screen([toast(149.5, 151.5)]).sampleSpan(0, 600, 6, () => {}).then((s) => coarseOnly.push(...s));
  ok(planAutoZooms(coarseOnly, { start: 0, end: 600 }).length === 1, 'coarse samples alone would zoom on a 2s toast (why the re-scan exists)');

  // Budget: an hour of typing is one huge run that doesn't fit; the short toast runs still get re-scanned.
  const busy = screen([typing(10, 3000), toast(3299.5, 3301.5), toast(3400.2, 3405.2)]);
  const busyZooms = await scanAutoZooms(busy.sampleSpan, { start: 0, end: 3600, last: 3599.95 });
  ok(!busyZooms.some(inCorner) && busyZooms.some((z) => !inCorner(z) && z.start < 20), 'over-budget run keeps its coarse verdict, toasts are still re-scanned ' + fmt(busyZooms));
  ok(busy.stats.frames <= 2 * 600 + 2 * busy.stats.spans.length, `budget respected (${busy.stats.frames} frames)`);

  // Many transients: re-scanning stops at the budget instead of growing with the recording.
  const many = [];
  for (let t = 23.5; t < 3500; t += 30) many.push(toast(t, t + 2)); // each straddles a 6s frame
  const flood = screen(many);
  await scanAutoZooms(flood.sampleSpan, { start: 0, end: 3600, last: 3599.95 });
  ok(flood.stats.frames <= 2 * 600 + 2 * flood.stats.spans.length && flood.stats.spans.length > 1, `re-scan is capped (${flood.stats.frames} frames, ${flood.stats.spans.length} spans)`);
}

// ---------------------------------------------------------------------------------

log(`${checks - failures}/${checks} checks passed`);
if (failures) throw new Error(`${failures} zoom self-test check(s) failed`);
