// Zoom inspector: edits the selected zoom — scale, focus point (picked on a still of
// the source frame), timing nudges, preview and delete.

import { h, clamp, formatTime, throttleRaf, debounce } from '../../lib/util.js';
import { icon } from '../../lib/icons.js';
import { getAspect, ZOOM_DEFAULTS } from '../../lib/project.js';
import { loadVideo, seekVideo } from '../../lib/media.js';
import { clampFocus, constrainZoom } from '../zoom.js';
import { panelSection, sliderControl, formatScale } from './design.js';

const MIN_SCALE = 1.1;
const MAX_SCALE = 4;
const NUDGE = 0.1;
const PREROLL = 0.3;
const FRAME_MAX_W = 720;
const FRAME_CACHE_MAX = 10;
const EPS = 1e-4;

// Stills of the source, shared across panel instances (the shell recreates this panel
// per selected zoom): `${mainUrl}|${deciseconds}` → canvas. Small LRU.
const frameCache = new Map();

function cacheGet(key) {
  const v = frameCache.get(key);
  if (v) { frameCache.delete(key); frameCache.set(key, v); }
  return v || null;
}
function cacheSet(key, canvas) {
  frameCache.set(key, canvas);
  while (frameCache.size > FRAME_CACHE_MAX) frameCache.delete(frameCache.keys().next().value);
}

/**
 * Frees the shared stills (call when the editor closes). Not from a panel's destroy():
 * the shell recreates this panel per selected zoom, and the cache is meant to outlive that.
 */
export function clearFrameCache() {
  for (const c of frameCache.values()) {
    if (c) { c.width = 0; c.height = 0; }
  }
  frameCache.clear();
}

/** "0:12.4" — rounds to tenths (formatTime floors, which shows 12.3 as 12.2 after float drift). */
function fmtTenths(t) {
  const tenths = Math.round(Math.max(0, Number(t) || 0) * 10);
  return `${formatTime(Math.floor(tenths / 10))}.${tenths % 10}`;
}

const round4 = (v) => Math.round(v * 10000) / 10000;
const round3 = (v) => Math.round(v * 1000) / 1000;

function releaseVideo(video) {
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* already torn down */ }
}

/**
 * The part of the source (normalized 0..1) the zoomed output shows — mirrors the
 * renderer: the whole source in fit mode, the cover-crop in fill mode, divided by scale.
 */
function viewportRect(project, zoom) {
  const base = baseRect(project);
  const s = Math.max(1, Number(zoom.scale) || 1);
  const w = base.w / s, hh = base.h / s;
  const f = clampFocus(s, zoom.x, zoom.y);
  return {
    x: clamp(f.x - w / 2, base.x, base.x + base.w - w),
    y: clamp(f.y - hh / 2, base.y, base.y + base.h - hh),
    w,
    h: hh,
  };
}

function baseRect(project) {
  const e = project.edit;
  if (e.fit !== 'fill') return { x: 0, y: 0, w: 1, h: 1 };
  const a = getAspect(e.aspect);
  const target = a.width / a.height;
  const srcAspect = (project.source?.width || 1920) / (project.source?.height || 1080);
  if (srcAspect > target) {
    const w = target / srcAspect;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const hh = srcAspect / target;
  return { x: 0, y: (1 - hh) / 2, w: 1, h: hh };
}

/** clampFocus, narrowed to the cover-crop in fill mode (so the stored focus matches what renders). */
function clampFocusFor(project, scale, x, y) {
  const s = Math.max(1, Number(scale) || 1);
  const f = clampFocus(s, x, y);
  const base = baseRect(project);
  const hw = base.w / s / 2, hh = base.h / s / 2;
  return {
    x: clamp(f.x, base.x + hw, base.x + base.w - hw),
    y: clamp(f.y, base.y + hh, base.y + base.h - hh),
  };
}

/**
 * @param {{ store: object, player?: object|null, onDelete?: (() => void)|null }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createZoomPanel({ store, player = null, onDelete = null } = {}) {
  let zoomId = store.ui.selectedZoomId;
  let destroyed = false;
  const offs = [];

  const getZoom = () => (zoomId && store.project.edit.zooms.find((z) => z.id === zoomId)) || null;
  const mirrored = () => store.project.mode === 'cam' && Boolean(store.project.edit.camera?.mirror);

  /**
   * Edits the selected zoom. Any hand edit makes it manual so a later auto-zoom pass keeps it.
   * `extra` carries a drag gesture's { history } so one drag is one undo step.
   * @returns {boolean} whether it wrote
   */
  function mutate(fn, coalesce, extra) {
    const id = zoomId;
    if (!getZoom()) return false;
    store.update((p) => {
      const z = p.edit.zooms.find((zz) => zz.id === id);
      if (!z) return;
      fn(z, p);
      z.auto = false;
    }, { ...(coalesce ? { coalesce } : {}), ...extra });
    return true;
  }

  /**
   * The part of zoom `z` that plays inside the trim, or null when it lies entirely outside it.
   * Mirrors Player._bounds() (which clamps every seek) and the timeline's `is-outside` test.
   */
  function visibleSpan(z) {
    const tr = store.project.edit.trim || {};
    const pd = Number(player?.duration);
    const d = Number(store.project.duration);
    const dur = pd > 0 && Number.isFinite(pd) ? pd : d > 0 && Number.isFinite(d) ? d : Infinity;
    const ts = clamp(Number.isFinite(tr.start) ? tr.start : 0, 0, dur);
    const te = clamp(Number.isFinite(tr.end) && tr.end > 0 ? tr.end : dur, ts, dur);
    const s = Math.max(z.start, ts), e = Math.min(z.end, te);
    return e - s > 1e-3 ? { start: s, end: e } : null;
  }

  /** While adjusting, park the (paused) playhead inside the zoom so the preview shows the result. */
  function revealInPreview() {
    const z = getZoom();
    if (!z || !player || player.playing) return;
    // Outside the trim the player can't reach it: a clamped seek would show an unzoomed frame.
    const span = visibleSpan(z);
    if (!span) return;
    const tr = Math.min(ZOOM_DEFAULTS.transition, (z.end - z.start) * 0.4);
    const t = player.time;
    if (!(t >= z.start + tr && t <= z.end - tr)) player.seek((span.start + span.end) / 2);
  }

  /* Header --------------------------------------------------------- */

  const badge = h('span', { class: 'badge' });
  const header = h('header', { class: 'pn-head' },
    h('span', { class: 'pn-head-icon', html: icon('zoom-in', 16) }),
    h('h2', { class: 'pn-head-title' }, 'Zoom'),
    badge,
    h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => store.setUI({ selectedZoomId: null }) }, 'Done'));

  /* Scale ---------------------------------------------------------- */

  const scale = sliderControl({
    label: 'Scale',
    min: MIN_SCALE,
    max: MAX_SCALE,
    step: 0.05,
    value: getZoom()?.scale ?? ZOOM_DEFAULTS.scale,
    format: formatScale,
    defaultValue: ZOOM_DEFAULTS.scale,
    onGestureStart: revealInPreview,
    onInput: (v, o) => mutate((z) => { z.scale = clamp(v, MIN_SCALE, MAX_SCALE); }, `zoom-scale:${zoomId}`, o),
  });

  /* Focus picker --------------------------------------------------- */

  const canvas = h('canvas', { class: 'pn-focus-canvas', 'aria-hidden': 'true' });
  const placeholder = h('div', { class: 'pn-focus-placeholder skeleton' });
  const unavailable = h('div', { class: 'pn-focus-unavailable', hidden: true },
    h('span', { html: icon('image', 18) }), 'Preview unavailable');
  const vp = h('div', {
    class: 'pn-focus-vp',
    tabindex: '0',
    role: 'group',
    'aria-label': 'Zoom focus. Drag, or use the arrow keys to move it.',
  });
  const focusWrap = h('div', { class: 'pn-focus is-loading' }, canvas, placeholder, unavailable, vp);
  const src = store.project.source || {};
  focusWrap.style.setProperty('--pn-ratio', String((src.width || 1920) / (src.height || 1080)));

  const focusSection = panelSection('Focus', [
    focusWrap,
    h('div', { class: 'pn-focus-foot' },
      h('p', { class: 'pn-hint' }, 'Drag the frame to choose what the zoom shows.'),
      h('button', { type: 'button', class: 'pn-link', onclick: () => { revealInPreview(); setFocus(0.5, 0.5); } }, 'Center')),
  ]);

  let frame = null;          // canvas still for the current midpoint
  let lastMirror = mirrored();

  function sizeCanvas() {
    const w = focusWrap.clientWidth, hh = focusWrap.clientHeight;
    if (!w || !hh) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const W = Math.round(w * dpr), H = Math.round(hh * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
      draw();
    }
  }

  function draw() {
    if (destroyed) return;
    let ctx = null;
    try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame) return;
    ctx.save();
    if (mirrored()) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // Private decoder so grabbing a still never disturbs playback.
  let videoPromise = null;
  let video = null;
  function ensureVideo() {
    if (!videoPromise) {
      const url = player?.mainUrl;
      if (!url) return Promise.resolve(null);
      videoPromise = loadVideo(url, { muted: true, knownDuration: store.project.duration }).then((v) => {
        if (destroyed) { releaseVideo(v); return null; }
        video = v;
        return v;
      });
    }
    return videoPromise;
  }

  function snapshot(v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh || v.readyState < 2) return null;
    const w = Math.min(FRAME_MAX_W, vw);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.max(1, Math.round((w * vh) / vw));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return c;
  }

  let wantT = null;
  let pumping = false;
  let shownKey = '';

  function requestFrame(t) {
    wantT = t;
    if (!pumping) pump();
  }

  async function pump() {
    pumping = true;
    try {
      while (wantT !== null && !destroyed) {
        const ds = Math.round(Math.max(0, wantT) * 10);
        wantT = null;
        const key = `${player?.mainUrl || ''}|${ds}`;
        if (key === shownKey && frame) continue;
        let still = cacheGet(key);
        if (!still) {
          const v = await ensureVideo();
          if (destroyed) return;
          if (!v) throw new Error('No video');
          const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : store.project.duration;
          await seekVideo(v, clamp(ds / 10, 0, Math.max(0, dur - 0.05)));
          if (destroyed) return;
          still = snapshot(v);
          if (still) cacheSet(key, still);
        }
        if (wantT === null && still) {
          frame = still;
          shownKey = key;
          focusWrap.classList.remove('is-loading', 'is-unavailable');
          unavailable.hidden = true;
          draw();
        }
      }
      if (!frame) markUnavailable();
    } catch (err) {
      if (!destroyed) {
        console.warn('[zoom panel] could not load a still of the recording', err);
        markUnavailable();
      }
    } finally {
      pumping = false;
    }
  }

  function markUnavailable() {
    if (frame || destroyed) return;
    focusWrap.classList.remove('is-loading');
    focusWrap.classList.add('is-unavailable');
    unavailable.hidden = false;
  }

  let lastMid = NaN;
  const requestFrameSoon = debounce((t) => { if (!destroyed) requestFrame(t); }, 140);

  function placeViewport() {
    const z = getZoom();
    if (!z) return;
    const r = viewportRect(store.project, z);
    const left = mirrored() ? 1 - r.x - r.w : r.x;
    vp.style.left = `${left * 100}%`;
    vp.style.top = `${r.y * 100}%`;
    vp.style.width = `${r.w * 100}%`;
    vp.style.height = `${r.h * 100}%`;
  }

  /** Pointer position → source coordinates (0..1). */
  function pointToSource(e) {
    const rect = focusWrap.getBoundingClientRect();
    let x = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
    const y = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
    if (mirrored()) x = 1 - x;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  }

  /** @returns {boolean} whether it wrote */
  function setFocus(x, y, extra) {
    if (destroyed) return false;
    const z = getZoom();
    if (!z) return false;
    const f = clampFocusFor(store.project, z.scale, x, y);
    if (Math.abs(f.x - z.x) < EPS && Math.abs(f.y - z.y) < EPS) return false;
    return mutate((zz) => { zz.x = round4(f.x); zz.y = round4(f.y); }, `zoom-focus:${z.id}`, extra);
  }

  /**
   * Focus write that belongs to drag gesture `g`: its first write is an undo step, the rest
   * join it (history:false), so pausing mid-drag never splits the drag into several steps.
   * `g` is captured when the pointer moves, so a throttled write landing after pointerup
   * still belongs to its drag.
   */
  function dragFocus(x, y, g = drag) {
    const opts = g ? { history: !g.recorded } : undefined;
    if (setFocus(x, y, opts) && g) g.recorded = true;
  }
  const dragFocusThrottled = throttleRaf(dragFocus);

  let drag = null;
  function onPointerDown(e) {
    if (e.button !== 0 || !getZoom()) return;
    e.preventDefault();
    revealInPreview();
    const z = getZoom();
    const p = pointToSource(e);
    const r = viewportRect(store.project, z);
    const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    drag = { id: e.pointerId, dx: inside ? cx - p.x : 0, dy: inside ? cy - p.y : 0, recorded: false };
    if (!inside) dragFocus(p.x, p.y);
    try { focusWrap.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    focusWrap.classList.add('is-dragging');
    vp.focus({ preventScroll: true });
  }
  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const p = pointToSource(e);
    dragFocusThrottled(p.x + drag.dx, p.y + drag.dy, drag);
  }
  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    focusWrap.classList.remove('is-dragging');
    try { focusWrap.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  }
  focusWrap.addEventListener('pointerdown', onPointerDown);
  focusWrap.addEventListener('pointermove', onPointerMove);
  focusWrap.addEventListener('pointerup', onPointerUp);
  focusWrap.addEventListener('pointercancel', onPointerUp);
  focusWrap.addEventListener('lostpointercapture', onPointerUp);

  vp.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault();
    e.stopPropagation(); // the shell uses ←/→ for seeking
    const z = getZoom();
    if (!z) return;
    revealInPreview();
    const r = viewportRect(store.project, z);
    if (mirrored()) dx = -dx;
    setFocus(r.x + r.w / 2 + dx, r.y + r.h / 2 + dy);
  });

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { if (!destroyed) sizeCanvas(); });
    ro.observe(focusWrap);
  } else {
    requestAnimationFrame(() => { if (!destroyed) sizeCanvas(); });
  }

  /* Timing --------------------------------------------------------- */

  function stepper(label, edge) {
    const value = h('button', {
      type: 'button',
      class: 'pn-time-value',
      'data-tip': 'Jump here',
      onclick: () => { const z = getZoom(); if (z) player?.seek(z[edge]); },
    });
    const dec = h('button', {
      type: 'button', class: 'pn-step-btn', 'aria-label': `${label} 0.1s earlier`, 'data-tip': '−0.1s',
      html: icon('chevron-left', 14), onclick: () => nudge(edge, -NUDGE),
    });
    const inc = h('button', {
      type: 'button', class: 'pn-step-btn', 'aria-label': `${label} 0.1s later`, 'data-tip': '+0.1s',
      html: icon('chevron-right', 14), onclick: () => nudge(edge, NUDGE),
    });
    const row = h('div', { class: 'pn-time-row' },
      h('span', { class: 'pn-time-label' }, label),
      h('div', { class: 'pn-stepper' }, dec, value, inc));
    return { row, value, dec, inc };
  }

  function nudged(z, edge, delta) {
    return edge === 'start'
      ? constrainZoom(store.project, z.id, z.start + delta, z.end, 'start')
      : constrainZoom(store.project, z.id, z.start, z.end + delta, 'end');
  }

  function nudge(edge, delta) {
    const z = getZoom();
    if (!z) return;
    const r = nudged(z, edge, delta);
    const start = round3(r.start), end = round3(r.end);
    if (Math.abs(start - z.start) < EPS && Math.abs(end - z.end) < EPS) return;
    mutate((zz) => { zz.start = start; zz.end = end; }, `zoom-nudge:${z.id}`);
  }

  const startStep = stepper('Start', 'start');
  const endStep = stepper('End', 'end');
  const durValue = h('span', { class: 'pn-time-static' });
  const timingSection = panelSection('Timing', [
    h('div', { class: 'pn-times' },
      startStep.row,
      endStep.row,
      h('div', { class: 'pn-time-row' }, h('span', { class: 'pn-time-label' }, 'Duration'), durValue)),
  ]);

  /* Actions -------------------------------------------------------- */

  async function preview() {
    const z = getZoom();
    if (!z || !player) return;
    // Entirely outside the trim: the seek would clamp to a trim edge and play() would
    // restart from trim.start, never showing this zoom. (The button is disabled then.)
    if (!visibleSpan(z)) return;
    if (player.playing) player.pause();
    // seek() clamps to the trim, so a zoom that only partly overlaps it plays its visible part.
    await player.seek(Math.max(0, z.start - PREROLL));
    player.play();
  }

  function remove() {
    if (typeof onDelete === 'function') {
      onDelete();
      return;
    }
    const id = zoomId;
    store.update((p) => { p.edit.zooms = p.edit.zooms.filter((z) => z.id !== id); });
    store.setUI({ selectedZoomId: null });
  }

  const previewBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm grow', onclick: preview, disabled: !player },
    h('span', { class: 'pn-btn-icon', html: icon('play', 13) }), 'Preview');
  const actions = h('div', { class: 'panel-section pn-section pn-zoom-actions-row' },
    previewBtn,
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm pn-danger', onclick: remove },
      h('span', { class: 'pn-btn-icon', html: icon('trash', 15) }), 'Delete'));

  /* Missing state (undo removed the zoom, or nothing selected) ----- */

  const missing = h('div', { class: 'empty-state pn-empty', hidden: true },
    h('div', { class: 'empty-icon', html: icon('zoom-in', 24) }),
    h('h3', {}, 'No zoom selected'),
    h('p', { class: 'pn-empty-text' }, 'Select a zoom on the timeline to adjust it.'));

  const body = h('div', { class: 'pn-zoom-body' },
    panelSection(null, [scale.el], { className: 'pn-scale-section' }),
    focusSection,
    timingSection,
    actions);

  const el = h('div', { class: 'pn pn-zoom' }, header, body, missing);

  /* Sync ----------------------------------------------------------- */

  function sync() {
    if (destroyed) return;
    const z = getZoom();
    body.hidden = !z;
    missing.hidden = Boolean(z);
    badge.hidden = !z;
    if (!z) return;

    badge.textContent = z.auto ? 'Auto' : 'Manual';
    badge.className = `badge ${z.auto ? 'badge-accent' : ''} pn-head-badge`;
    scale.set(z.scale);
    placeViewport();

    startStep.value.textContent = fmtTenths(z.start);
    endStep.value.textContent = fmtTenths(z.end);
    durValue.textContent = `${(Math.round((z.end - z.start) * 10) / 10).toFixed(1)}s`;
    const can = (edge, d) => {
      const r = nudged(z, edge, d);
      return Math.abs(r.start - z.start) > EPS || Math.abs(r.end - z.end) > EPS;
    };
    startStep.dec.disabled = !can('start', -NUDGE);
    startStep.inc.disabled = !can('start', NUDGE);
    endStep.dec.disabled = !can('end', -NUDGE);
    endStep.inc.disabled = !can('end', NUDGE);

    const m = mirrored();
    if (m !== lastMirror) { lastMirror = m; draw(); }

    const mid = (z.start + z.end) / 2;
    if (!Number.isFinite(lastMid)) requestFrame(mid);
    else if (Math.abs(mid - lastMid) >= 0.05) requestFrameSoon(mid);
    lastMid = mid;

    // Trim edits run through here too, so this follows the trim live.
    const outside = !visibleSpan(z);
    previewBtn.disabled = !player || outside;
    if (outside) previewBtn.dataset.tip = 'Outside the trimmed video';
    else delete previewBtn.dataset.tip;
  }

  sync();
  offs.push(store.onChange(sync));
  // ⌘Z mid-drag: the rest of the drag records a fresh step instead of editing the restored state.
  offs.push(store.onChange((p, info) => {
    if (info?.reason !== 'undo' && info?.reason !== 'redo') return;
    if (drag) drag.recorded = false;
    scale.rearm();
  }));
  offs.push(store.onUI((ui, keys) => {
    if (destroyed || !keys.includes('selectedZoomId')) return;
    // The shell normally swaps panels per zoom; follow the selection anyway.
    if (ui.selectedZoomId && ui.selectedZoomId !== zoomId) {
      zoomId = ui.selectedZoomId;
      lastMid = NaN;
      sync();
    }
  }));

  return {
    el,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off?.(); } catch { /* already gone */ } });
      requestFrameSoon.cancel();
      ro?.disconnect();
      focusWrap.removeEventListener('pointerdown', onPointerDown);
      focusWrap.removeEventListener('pointermove', onPointerMove);
      focusWrap.removeEventListener('pointerup', onPointerUp);
      focusWrap.removeEventListener('pointercancel', onPointerUp);
      focusWrap.removeEventListener('lostpointercapture', onPointerUp);
      releaseVideo(video);
      video = null;
      // A load still in flight releases its element when it resolves (see ensureVideo).
      videoPromise?.catch(() => {});
      frame = null;
    },
  };
}
