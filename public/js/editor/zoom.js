// Zoom math (pure) and motion-based auto-zoom detection.
// Nothing here touches the DOM at import time; everything above detectAutoZooms is
// DOM-free so tools/zoom-selftest.js can exercise it under plain JavaScriptCore.

import { clamp, easeInOutCubic, uid } from '../lib/util.js';
import { ZOOM_DEFAULTS } from '../lib/project.js';
import { loadVideo, seekVideo } from '../lib/media.js';

const EPS = 1e-6;
const MAX_SCALE = 8;
const IDENTITY = Object.freeze({ scale: 1, x: 0.5, y: 0.5 });

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const state = (z) => ({ scale: z.scale, x: z.x, y: z.y });

/**
 * Keeps a crop of size 1/scale (normalized) centered on (x, y) inside the source.
 * @returns {{ x: number, y: number }}
 */
export function clampFocus(scale, x, y) {
  const s = Number.isFinite(scale) && scale > 1 ? scale : 1;
  const half = 0.5 / s;
  return {
    x: clamp(num(x, 0.5), half, 1 - half),
    y: clamp(num(y, 0.5), half, 1 - half),
  };
}

/** Sanitized copy: valid, sorted, non-overlapping zooms with clamped scale/focus. */
function normalizeZooms(zooms) {
  const out = [];
  if (!Array.isArray(zooms)) return out;
  let sorted = true;
  for (const z of zooms) {
    if (!z || !Number.isFinite(z.start) || !Number.isFinite(z.end) || z.end - z.start <= EPS) continue;
    const scale = clamp(num(z.scale, ZOOM_DEFAULTS.scale), 1, MAX_SCALE);
    const f = clampFocus(scale, z.x, z.y);
    if (out.length && z.start < out[out.length - 1].start) sorted = false;
    out.push({ start: z.start, end: z.end, scale, x: f.x, y: f.y });
  }
  if (!sorted) out.sort((a, b) => a.start - b.start);
  // Stored zooms never overlap, but a half-applied edit must not break playback.
  let n = 0;
  for (const z of out) {
    if (n && z.start < out[n - 1].end) z.start = out[n - 1].end;
    if (z.end - z.start > EPS) out[n++] = z;
  }
  out.length = n;
  return out;
}

/**
 * Interpolates between two zoom states. Scale moves geometrically (constant perceived
 * zoom speed) and the crop's top-left moves in proportion to the crop size, so a zoom
 * pivots about a fixed point instead of drifting sideways. Equal scales → plain pan.
 */
function blend(a, b, e) {
  if (e <= 0) return state(a);
  if (e >= 1) return state(b);
  const wa = 1 / a.scale, wb = 1 / b.scale;
  const w = wa * Math.pow(wb / wa, e);
  const k = Math.abs(wb - wa) > 1e-4 ? (w - wa) / (wb - wa) : e;
  const ax = a.x - wa / 2, ay = a.y - wa / 2;
  const bx = b.x - wb / 2, by = b.y - wb / 2;
  const scale = 1 / w;
  const f = clampFocus(scale, ax + (bx - ax) * k + w / 2, ay + (by - ay) * k + w / 2);
  return { scale, x: f.x, y: f.y };
}

const phase = (time, start, length) => (length > 0 ? easeInOutCubic(clamp((time - start) / length, 0, 1)) : 1);

/**
 * Zoom state at `time` (source seconds). Continuous for any configuration:
 *  - ease in over `transition` after start, hold, ease out over `transition` before end
 *    (transition shrinks to 40% of a short zoom);
 *  - when the gap to the next zoom is < 2·transition, stay zoomed and pan/scale straight
 *    into the next zoom over [end − t₁/2, nextStart + t₂/2] instead of dipping to 1×.
 * @returns {{ scale: number, x: number, y: number }}
 */
export function zoomStateAt(zooms, time, transition = ZOOM_DEFAULTS.transition) {
  const list = normalizeZooms(zooms);
  if (!list.length || !Number.isFinite(time)) return { ...IDENTITY };
  const T = Number.isFinite(transition) && transition > 0 ? transition : 0;
  const tr = (z) => Math.min(T, 0.4 * (z.end - z.start));

  let chainedIn = false;
  for (let i = 0; i < list.length; i++) {
    const z = list[i];
    const next = list[i + 1];
    if (!chainedIn && time < z.start) return { ...IDENTITY };
    const tz = tr(z);
    const chainOut = Boolean(next) && next.start - z.end < 2 * T;
    const regionEnd = chainOut ? next.start + tr(next) / 2 : z.end;
    if (time < regionEnd) {
      if (!chainedIn && time < z.start + tz) return blend(IDENTITY, z, phase(time, z.start, tz));
      if (chainOut) {
        const panStart = z.end - tz / 2;
        if (time >= panStart) return blend(z, next, phase(time, panStart, regionEnd - panStart));
      } else if (time > z.end - tz) {
        return blend(z, IDENTITY, phase(time, z.end - tz, tz));
      }
      return state(z);
    }
    chainedIn = chainOut;
  }
  return { ...IDENTITY };
}

function trimRange(project) {
  const total = Math.max(0, num(project?.duration, 0));
  const trim = project?.edit?.trim || {};
  const lo = clamp(num(trim.start, 0), 0, total);
  const hi = clamp(num(trim.end, total), lo, total);
  return { lo, hi };
}

/**
 * Free slot for a new zoom at/after `time`, inside the trim range.
 * Prefers [time, time + duration]; when the playhead sits near the end of a free gap the
 * slot is shifted back (still covering the playhead) so the zoom gets its full length.
 * @returns {{ start: number, end: number } | null} null when no gap ≥ minDuration exists
 */
export function findZoomSlot(project, time, duration = ZOOM_DEFAULTS.duration) {
  const minLen = ZOOM_DEFAULTS.minDuration;
  const want = Math.max(minLen, num(duration, ZOOM_DEFAULTS.duration));
  const { lo, hi } = trimRange(project);
  if (hi - lo < minLen - EPS) return null;
  const t = clamp(num(time, lo), lo, hi);

  // Free gaps inside [lo, hi].
  const gaps = [];
  let cursor = lo;
  for (const z of normalizeZooms(project?.edit?.zooms)) {
    if (z.end <= lo) continue;
    if (z.start >= hi) break;
    if (z.start > cursor) gaps.push([cursor, z.start]);
    cursor = Math.max(cursor, z.end);
  }
  if (cursor < hi) gaps.push([cursor, hi]);

  for (const [gs, ge] of gaps) {
    if (ge - gs < minLen - EPS) continue;
    if (ge <= t && !(t === hi && ge === hi)) continue;
    if (gs <= t) {
      const end = Math.min(t + want, ge);
      return { start: Math.max(gs, Math.min(t, end - want)), end };
    }
    return { start: gs, end: Math.min(gs + want, ge) };
  }
  return null;
}

/**
 * Constrains a proposed [start, end] for zoom `zoomId` during a drag.
 * mode 'move' keeps the length, 'start' / 'end' resize that edge only.
 * Result never overlaps a neighbour, is ≥ minDuration and lies inside [0, duration].
 * @returns {{ start: number, end: number }}
 */
export function constrainZoom(project, zoomId, start, end, mode = 'move') {
  const minLen = ZOOM_DEFAULTS.minDuration;
  const total = Math.max(0, num(project?.duration, 0));
  const zooms = Array.isArray(project?.edit?.zooms) ? project.edit.zooms : [];
  const self = zooms.find((z) => z && z.id === zoomId && Number.isFinite(z.start) && Number.isFinite(z.end)) || null;
  let s = num(start, self ? self.start : 0);
  let e = num(end, self ? self.end : s + minLen);

  // Neighbours are classified relative to the zoom's current (pre-drag) position, so a
  // drag can push against a neighbour but never jump over it.
  const ref = self ? (self.start + self.end) / 2 : (s + e) / 2;
  let lo = 0, hi = total;
  for (const z of zooms) {
    if (!z || z === self || (zoomId != null && z.id === zoomId)) continue;
    if (!Number.isFinite(z.start) || !Number.isFinite(z.end)) continue;
    if ((z.start + z.end) / 2 <= ref) lo = Math.max(lo, z.end);
    else hi = Math.min(hi, z.start);
  }
  // Only reachable with corrupt data: avoid overlap rather than enforce the minimum.
  if (hi - lo < minLen) return { start: lo, end: Math.max(lo, hi) };

  if (mode === 'start') {
    e = clamp(e, lo + minLen, hi);
    s = clamp(s, lo, e - minLen);
  } else if (mode === 'end') {
    s = clamp(s, lo, hi - minLen);
    e = clamp(e, s + minLen, hi);
  } else {
    const len = clamp(e - s, minLen, hi - lo);
    s = clamp(s, lo, hi - len);
    e = s + len;
  }
  return { start: s, end: e };
}

// ---------------------------------------------------------------------------------
// Auto zoom: motion analysis.

const AUTO = {
  width: 240,          // analysis frame width (px) — wide enough to see typing
  step: 0.5,           // seconds between analysed frames…
  maxSamples: 600,     // …stretched on long recordings so the first pass reads at most this many frames
  diff: 24,            // luminance delta that counts as "changed"
  minChanged: 0.0004,  // below: compression noise
  maxChanged: 0.35,    // above: global change (scroll, page switch)
  maxArea: 0.45,       // robust bbox area must stay below this to count as localized
  maxSide: 0.85,
  minBurst: 1.2,       // seconds of sustained localized change
  mergeGap: 1.5,
  spacing: 4,          // at most one zoom per this many seconds
  lead: 0.4,
  tail: 0.8,
  minScale: 1.5,
  maxScale: 2.4,
  minUseful: 1.3,      // activity that would need less magnification than this isn't worth a zoom
  maxDrift: 0.28,      // a burst splits when activity moves this far (normalized) from its running centre
};

/** Robust 1-D extent of a histogram: 5th–95th percentile range + trimmed mean (normalized). */
function robustRange(hist) {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (!total) return null;
  const at = (p) => {
    const target = p * total;
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
      acc += hist[i];
      if (acc > target) return i;
    }
    return hist.length - 1;
  };
  const lo = at(0.05), hi = at(0.95);
  let sum = 0, count = 0;
  for (let i = lo; i <= hi; i++) { sum += i * hist[i]; count += hist[i]; }
  const n = hist.length;
  return {
    min: lo / n,
    max: (hi + 1) / n,
    size: (hi + 1 - lo) / n,
    mean: count ? (sum / count + 0.5) / n : (lo + hi + 1) / 2 / n,
  };
}

function localizedBox(sample) {
  if (!sample || !sample.hx || !sample.hy) return null;
  if (!(sample.changed >= AUTO.minChanged && sample.changed <= AUTO.maxChanged)) return null;
  const bx = robustRange(sample.hx), by = robustRange(sample.hy);
  if (!bx || !by) return null;
  if (bx.size * by.size > AUTO.maxArea || bx.size > AUTO.maxSide || by.size > AUTO.maxSide) return null;
  return { bx, by };
}

function sumHistograms(items, key) {
  const out = new Float64Array(items[0][key].length);
  for (const it of items) {
    const h = it[key];
    for (let i = 0; i < out.length && i < h.length; i++) out[i] += h[i];
  }
  return out;
}

const ceil3 = (v) => Math.ceil(v * 1000 - 1e-6) / 1000;
const floor3 = (v) => Math.floor(v * 1000 + 1e-6) / 1000;

/**
 * Runs of localized change ({ start, end, items, cx, cy }), tolerating a single quiet/odd sample
 * inside — but only a short one: on a coarse grid (long recordings) one quiet sample is seconds of
 * nothing happening, and that ends the moment.
 */
function localizedBursts(samples) {
  const bursts = [];
  let cur = null, misses = 0;
  for (const sample of samples || []) {
    const box = localizedBox(sample);
    if (box) {
      const cx = box.bx.mean, cy = box.by.mean;
      // Activity jumped to another part of the screen: that's a new moment, not the same burst.
      if (cur && Math.hypot(cx - cur.cx, cy - cur.cy) > AUTO.maxDrift) {
        bursts.push(cur);
        cur = null;
      }
      if (!cur) cur = { start: sample.t0, end: sample.t1, items: [], cx, cy };
      cur.end = sample.t1;
      cur.items.push(sample);
      const n = cur.items.length;
      cur.cx += (cx - cur.cx) / n;
      cur.cy += (cy - cur.cy) / n;
      misses = 0;
    } else if (cur && (++misses > 1 || sample.t1 - sample.t0 > AUTO.minBurst / 2 + EPS)) {
      bursts.push(cur);
      cur = null;
      misses = 0;
    }
  }
  if (cur) bursts.push(cur);
  return bursts;
}

/**
 * Turns per-interval motion samples into auto zooms (without ids). Pure; exported for the
 * self-test. A sample describes the change between frames at t0 and t1:
 *   { t0, t1, changed: fraction of pixels changed, hx: per-column counts, hy: per-row counts }
 * (hx/hy may be null when the sample is clearly noise or a global change).
 * @returns {Array<{ start, end, scale, x, y, auto: true }>}
 */
export function planAutoZooms(samples, { start = 0, end = Infinity, minDuration = ZOOM_DEFAULTS.minDuration } = {}) {
  // 1. Bursts of localized change.
  const bursts = localizedBursts(samples);

  // 2. Sustained bursts only, then merge the ones that nearly touch. One sample is never
  //    "sustained", however long it is (a long step can hold a change that came and went).
  const merged = [];
  for (const b of bursts) {
    if (b.items.length < 2 || b.end - b.start < AUTO.minBurst - EPS) continue;
    const last = merged[merged.length - 1];
    if (last && b.start - last.end < AUTO.mergeGap && Math.hypot(b.cx - last.cx, b.cy - last.cy) <= AUTO.maxDrift) {
      last.end = Math.max(last.end, b.end);
      last.items.push(...b.items);
    } else {
      merged.push({ start: b.start, end: b.end, items: b.items.slice(), cx: b.cx, cy: b.cy });
    }
  }

  // 3. Geometry: robust bbox → scale, trimmed-mean centroid → focus.
  const candidates = [];
  for (const b of merged) {
    const bx = robustRange(sumHistograms(b.items, 'hx'));
    const by = robustRange(sumHistograms(b.items, 'hy'));
    if (!bx || !by) continue;
    const zs = ceil3(Math.max(start, b.start - AUTO.lead));
    const ze = floor3(Math.min(end, b.end + AUTO.tail));
    if (ze - zs < minDuration - EPS) continue;
    const fitScale = 0.8 / Math.max(bx.size, by.size, EPS);
    if (fitScale < AUTO.minUseful) continue; // activity spans most of the screen
    const scale = Math.round(clamp(fitScale, AUTO.minScale, AUTO.maxScale) * 100) / 100;
    const f = clampFocus(scale, bx.mean, by.mean);
    let strength = 0;
    for (const it of b.items) strength += it.changed * Math.max(0, it.t1 - it.t0);
    candidates.push({ start: zs, end: ze, scale, x: f.x, y: f.y, strength });
  }

  // 4. Strongest first; at most one per ~6s and never overlapping.
  candidates.sort((a, b) => b.strength - a.strength);
  const kept = [];
  for (const c of candidates) {
    if (kept.some((k) => Math.abs(k.start - c.start) < AUTO.spacing)) continue;
    // Overlaps that come only from lead-in/tail padding are clipped, not discarded:
    // adjacent zooms chain into a smooth pan (see zoomStateAt).
    for (const k of kept) {
      if (!(c.start < k.end && k.start < c.end)) continue;
      if (c.start < k.start) c.end = Math.min(c.end, k.start);
      else c.start = Math.max(c.start, k.end);
    }
    if (c.end - c.start >= minDuration - EPS && !kept.some((k) => c.start < k.end - EPS && k.start < c.end - EPS)) kept.push(c);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept.map((c) => {
    // Rounding focus to 3 decimals must not push the crop outside the source.
    const f = clampFocus(c.scale, Math.round(c.x * 1000) / 1000, Math.round(c.y * 1000) / 1000);
    return { start: c.start, end: c.end, scale: c.scale, x: f.x, y: f.y, auto: true };
  });
}

/**
 * Scans [start, end] for auto zooms (without ids). DOM-free; exported for the self-test.
 * `sampleSpan(from, to, step, onProgress)` must resolve to the motion samples (see planAutoZooms)
 * between consecutive frames at from, from + step, … ≤ to.
 *
 * Long recordings are first scanned on a coarser grid to bound the work, and there one sample can
 * hold a whole transient: a notification that appears and leaves between three frames shows up as
 * two back-to-back localized changes, which reads like sustained activity. So every run of coarse
 * localized samples is re-scanned at the normal step and decided like on a short recording —
 * shortest runs first (that's where transients hide), within a budget of about AUTO.maxSamples
 * extra frames (so at most ~2× the work); long runs that don't fit are activity that kept going
 * anyway and keep the coarse verdict.
 * @param {(from: number, to: number, step: number, onProgress: (f: number) => void) => Promise<object[]>} sampleSpan
 * @param {{ start?: number, end: number, last?: number, onProgress?: (f: number) => void }} opts
 *   `last` = latest time a frame may be read at (defaults to `end`).
 */
export async function scanAutoZooms(sampleSpan, { start = 0, end, last = end, onProgress } = {}) {
  const report = (f) => { if (typeof onProgress === 'function') onProgress(clamp(f, 0, 1)); };
  const step = Math.max(AUTO.step, (end - start) / AUTO.maxSamples);
  const coarse = step > AUTO.minBurst / 2 + EPS; // same threshold as the quiet-sample tolerance
  const share = coarse ? 0.7 : 1;
  let samples = await sampleSpan(start, last, step, (f) => report(f * share));

  if (coarse) {
    // A lone sample is never sustained, so only runs of two or more can become a zoom.
    const runs = localizedBursts(samples).filter((b) => b.items.length >= 2);
    runs.sort((a, b) => a.items.length - b.items.length || a.start - b.start);
    const chosen = [];
    let budget = AUTO.maxSamples, total = 0;
    for (const b of runs) {
      const n = Math.max(1, Math.ceil((b.end - b.start) / AUTO.step - EPS));
      if (n > budget) continue;
      budget -= n;
      total += n;
      chosen.push({ run: b, n });
    }
    chosen.sort((a, b) => a.run.start - b.run.start); // read the video front to back
    const replaced = new Set();
    const dense = [];
    let done = 0;
    for (const { run, n } of chosen) {
      // Frames land exactly on the run's ends, so the dense samples tile the coarse ones they replace.
      const span = await sampleSpan(run.start, run.end, (run.end - run.start) / n, (f) => report(share + ((1 - share) * (done + f * n)) / total));
      done += n;
      if (!span.length) continue; // nothing decodable there: keep the coarse evidence
      for (const it of run.items) replaced.add(it);
      dense.push(...span);
    }
    if (dense.length) samples = samples.filter((s) => !replaced.has(s)).concat(dense).sort((a, b) => a.t0 - b.t0);
  }
  report(1);
  return planAutoZooms(samples, { start, end });
}

function abortError() {
  try {
    return new DOMException('Auto zoom was cancelled', 'AbortError');
  } catch {
    const err = new Error('Auto zoom was cancelled');
    err.name = 'AbortError';
    return err;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** Settles with `promise`, or rejects with AbortError as soon as `signal` aborts. */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

function releaseVideo(video) {
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* already torn down */ }
}

function toLuminance(rgba, out) {
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
}

function diffFrames(prev, cur, w, h, t0, t1) {
  const hx = new Uint32Array(w), hy = new Uint32Array(h);
  const T = AUTO.diff;
  let count = 0;
  for (let y = 0, i = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++, i++) {
      const d = cur[i] - prev[i];
      if (d > T || d < -T) { hx[x]++; row++; }
    }
    hy[y] = row;
    count += row;
  }
  const changed = count / (w * h);
  const keep = changed >= AUTO.minChanged && changed <= AUTO.maxChanged;
  return { t0, t1, changed, hx: keep ? hx : null, hy: keep ? hy : null };
}

/**
 * Finds moments of sustained, localized on-screen activity and proposes zooms on them.
 * Uses a private muted <video>; the caller's video/URL is never touched.
 * @param {Blob|string} mainBlobOrUrl
 * @param {{ duration?: number, trim?: {start:number,end:number}, signal?: AbortSignal, onProgress?: (f:number)=>void }} [opts]
 * @returns {Promise<Array<{ id, start, end, scale, x, y, auto: true }>>} rejects with AbortError on cancel
 */
export async function detectAutoZooms(mainBlobOrUrl, { duration, trim, signal, onProgress } = {}) {
  const report = (p) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(clamp(p, 0, 1)); } catch (err) { console.error(err); }
  };
  throwIfAborted(signal);
  if (!mainBlobOrUrl) throw new TypeError('detectAutoZooms needs a video Blob or URL');

  // A Blob gets a private object URL that we always revoke; a string URL belongs to the caller.
  const ownUrl = typeof mainBlobOrUrl === 'string' ? null : URL.createObjectURL(mainBlobOrUrl);
  const revoke = () => { if (ownUrl) URL.revokeObjectURL(ownUrl); };
  const loading = loadVideo(ownUrl || mainBlobOrUrl, { muted: true, knownDuration: duration });
  let video;
  try {
    video = await abortable(loading, signal);
  } catch (err) {
    // Tear down only once the load settles: revoking a blob URL mid-request logs a network error.
    loading.then((v) => { releaseVideo(v); revoke(); }, revoke);
    throw err;
  }

  let canvas = null;
  try {
    throwIfAborted(signal);
    const total = num(duration, 0) > 0 ? duration : num(video.duration, 0);
    const ts = clamp(num(trim?.start, 0), 0, total);
    const te = clamp(num(trim?.end, total), ts, total);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || te - ts < AUTO.minBurst) {
      report(1);
      return [];
    }

    const w = Math.min(AUTO.width, vw);
    const h = Math.max(2, Math.round((w * vh) / vw));
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx) {
      report(1);
      return [];
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high'; // area-average the downscale so diffs are not aliasing noise

    const lastT = Math.max(ts, te - 0.05); // the very last timestamp may have no decodable frame
    const buffers = [new Uint8Array(w * h), new Uint8Array(w * h)];
    let frames = 0, failures = 0;

    // Motion samples between consecutive frames at from, from + step, … ≤ to.
    const sampleSpan = async (from, to, step, progress) => {
      const count = Math.floor((to - from) / step + EPS) + 1;
      const samples = [];
      let next = 0, prev = null, prevT = from;
      for (let k = 0; k < count; k++) {
        const t = from + k * step;
        await abortable(seekVideo(video, t), signal);
        frames++;
        let lum = buffers[next];
        try {
          ctx.drawImage(video, 0, 0, w, h);
          toLuminance(ctx.getImageData(0, 0, w, h).data, lum);
        } catch {
          lum = null; // undecodable frame: treat as a gap rather than a change
          failures++;
        }
        if (lum) {
          if (prev) samples.push(diffFrames(prev, lum, w, h, prevT, t));
          prev = lum;
          prevT = t;
          next ^= 1;
        } else {
          prev = null;
        }
        progress((k + 1) / count);
      }
      if (failures === frames) throw new Error('Could not read frames from this video');
      return samples;
    };

    const planned = await scanAutoZooms(sampleSpan, { start: ts, end: te, last: lastT, onProgress: (f) => report(f * 0.98) });
    const zooms = planned.map((z) => ({ id: uid('z_'), ...z }));
    report(1);
    return zooms;
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    releaseVideo(video);
    revoke();
  }
}
