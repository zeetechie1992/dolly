// Timeline: transport toolbar, adaptive time ruler, filmstrip with trim handles,
// zoom track and captions track. Every time value is in source seconds.
//
//   const timeline = new Timeline({ store, player });   // mount timeline.el
//   timeline.addZoomAtPlayhead(); timeline.deleteSelected(); timeline.runAutoZoom(); timeline.destroy();

import { h, clamp, uid, formatTime, debounce, throttleRaf, syncSliderFill, sleep } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { ZOOM_DEFAULTS, trimmedDuration } from '../lib/project.js';
import { loadVideo, seekVideo } from '../lib/media.js';
import { toast } from '../lib/ui.js';
import { findZoomSlot, constrainZoom, detectAutoZooms } from './zoom.js';

const PAD = 16;                // content inset (px) so trim handles at 0 / duration stay grabbable (= --tl-pad)
const HANDLE_W = 12;           // trim handle width (= --tl-handle-w)
const MIN_ZOOM = 1;
const MAX_ZOOM = 20;           // zoom cap floor (× fit-to-width); long videos allow more, see _maxZoom()
const TARGET_MAX_PPS = 120;    // px per source second at full zoom-in
const ZOOM_STEP = 1.6;
const MIN_TRIM = 0.5;          // shortest trimmed length (s)
const SNAP_PX = 6;
const DRAG_PX = 3;             // travel before a press becomes a drag
const DOUBLE_CLICK_MS = 400;
const EDGE_PX = 36;            // auto-scroll zone near the viewport edges while dragging
const EDGE_SPEED = 16;         // px per frame at full depth
const FOLLOW_PAUSE_MS = 1500;  // manual scrolling suspends playhead-follow this long
const MIN_LABEL_PX = 60;
const MIN_TICK_PX = 7;
const THUMB_CACHE_MAX = 240;
const NARROW_PX = 820;
const COMPACT_PX = 620;
const EPS = 1e-6;

// Render flags (batched into one rAF).
const R_LAYOUT = 1, R_TRIM = 2, R_ZOOMS = 4, R_CAPS = 8, R_TOOLBAR = 16;
const R_MODEL = R_TRIM | R_ZOOMS | R_CAPS | R_TOOLBAR;

// [major label interval (s), preferred minor subdivisions]
const TICKS = [
  [0.5, [5]], [1, [10, 5, 2]], [2, [4, 2]], [5, [5]], [10, [10, 5, 2]], [15, [3]], [30, [6, 3]],
  [60, [6, 4, 2]], [120, [4, 2]], [300, [5]], [600, [10, 5, 2]], [900, [3]], [1800, [6, 3]], [3600, [6, 4, 2]],
];

/** Convenience factory mirroring the other editor modules. */
export function createTimeline(opts) {
  return new Timeline(opts);
}

export class Timeline {
  /**
   * @param {{ store: import('./store.js').EditorStore, player: import('./player.js').Player }} opts
   */
  constructor({ store, player }) {
    this.store = store;
    this.player = player;

    this._destroyed = false;
    this._zoom = MIN_ZOOM;
    this._vw = 0;
    this._pps = 0;
    this._trackW = 0;
    this._dirty = 0;
    this._raf = 0;
    this._edgeRaf = 0;
    this._drag = null;
    this._cleanups = [];

    this._pills = new Map();
    this._caps = new Map();
    this._pillsReady = false;
    this._zoomSig = '';
    this._capSig = '';
    this._trimSig = '';

    this._tiles = new Map();
    this._tilePool = [];
    this._cache = new Map();
    this._failedKeys = new Set();
    this._tileW = 0;
    this._tileH = 0;
    this._dpr = 0;
    this._secPerTile = 1;
    this._thumbVideo = null;
    this._thumbVideoP = null;
    this._thumbRunning = false;
    this._thumbsFailed = false;

    this._userScrollAt = 0;
    this._progScroll = null;
    this._lastLaneClick = null;
    this._phX = NaN;
    this._timeStr = '';
    this._shownPlaying = null;
    this._durIconName = '';
    this._autoAbort = null;
    this._autoPromise = null;
    this._autoPct = -1;

    this._reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._seekThrottled = throttleRaf((t) => { if (!this._destroyed) this.player.seek(t); });
    this._kickThumbsSoon = debounce(() => this._kickThumbs(), 140);

    this._build();
    this._bind();
    this._syncPlay();
    this._updateTime(this.player.time);
    this._syncToolbar();
    this._syncZoomControls();
    this._schedule(R_LAYOUT);
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  /** Adds a zoom at the playhead (findZoomSlot) and selects it. Returns the zoom or null. */
  addZoomAtPlayhead() {
    return this._addZoomAt(this.player.time, 'No room for a zoom at the playhead');
  }

  /** Deletes store.ui.selectedZoomId. Returns true when something was deleted. */
  deleteSelected() {
    if (this._destroyed) return false;
    const id = this.store.ui.selectedZoomId;
    if (!id) return false;
    if (!this._zoomById(id)) {
      this.store.setUI({ selectedZoomId: null });
      return false;
    }
    this.store.update((p) => { p.edit.zooms = p.edit.zooms.filter((z) => z.id !== id); }, { reason: 'zoom-delete' });
    this.store.setUI({ selectedZoomId: null });
    return true;
  }

  /**
   * Motion-analyses the recording and replaces existing auto zooms (manual zooms that
   * don't overlap a new one are kept). Resolves with the number of zooms added, 0 when
   * nothing was found, or null when cancelled / failed. Re-entrant calls share one run.
   */
  runAutoZoom() {
    if (this._autoPromise) return this._autoPromise;
    if (this._destroyed) return Promise.resolve(null);
    const ac = new AbortController();
    this._autoAbort = ac;
    this._setAutoRunning(true);
    const project = this.store.project;
    const run = (async () => {
      // Yield first so `finally` (which clears _autoPromise) can never run before the
      // assignment below, even when the body fails synchronously.
      await null;
      try {
        if (!this.player.mainUrl) throw new Error('No video to analyze');
        const found = await detectAutoZooms(this.player.mainUrl, {
          duration: project.duration,
          trim: { ...project.edit.trim },
          signal: ac.signal,
          onProgress: (f) => { if (!this._destroyed && this._autoAbort === ac) this._setAutoProgress(f); },
        });
        if (this._destroyed || ac.signal.aborted) return null;
        const fresh = (Array.isArray(found) ? found : [])
          .filter((z) => z && Number.isFinite(z.start) && Number.isFinite(z.end) && z.end > z.start)
          .map((z) => ({ ...z, id: z.id || uid('z_'), auto: true }));
        if (!fresh.length) {
          toast('No obvious zoom moments found');
          return 0;
        }
        this.store.update((p) => {
          const keep = p.edit.zooms.filter((z) => !z.auto && !fresh.some((n) => n.start < z.end && z.start < n.end));
          p.edit.zooms = [...keep, ...fresh].sort((a, b) => a.start - b.start);
        }, { reason: 'auto-zoom' });
        const sel = this.store.ui.selectedZoomId;
        if (sel && !this._zoomById(sel)) this.store.setUI({ selectedZoomId: null });
        toast(`Added ${fresh.length} zoom${fresh.length === 1 ? '' : 's'}`, { type: 'success' });
        return fresh.length;
      } catch (err) {
        if (err?.name === 'AbortError' || ac.signal.aborted || this._destroyed) return null;
        console.error('[timeline] auto zoom failed', err);
        toast('Auto zoom couldn’t analyze this video', { type: 'error' });
        return null;
      } finally {
        if (this._autoAbort === ac) this._autoAbort = null;
        this._autoPromise = null;
        if (!this._destroyed) {
          this._setAutoRunning(false);
          this.store.setUI({ autoZoomRunning: false });
        }
      }
    })();
    this._autoPromise = run;
    // After the assignment, so listeners (the Design panel) can pick the run up via autoZoomJob.
    this.store.setUI({ autoZoomRunning: true });
    return run;
  }

  /** The in-flight auto-zoom run (the promise runAutoZoom() returned), or null. */
  get autoZoomJob() { return this._autoPromise; }

  /**
   * Timeline zoom, from fit-to-width (1×) up to _maxZoom() (at least 20×, more for long
   * videos so full zoom-in reaches ~120 px per second). Anchored on the playhead when it is visible.
   */
  zoomIn() { this._setZoom(this._zoom * ZOOM_STEP); }
  zoomOut() { this._setZoom(this._zoom / ZOOM_STEP); }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    const d = this._drag;
    this._drag = null;
    if (d) {
      try { this.content.releasePointerCapture(d.pointerId); } catch { /* already released */ }
    }
    this._autoAbort?.abort();
    this._autoAbort = null;
    // The aborted run's finally skips _setAutoRunning once destroyed.
    if (this.store.ui?.autoZoomRunning) this.store.setUI({ autoZoomRunning: false });
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._edgeRaf) cancelAnimationFrame(this._edgeRaf);
    this._raf = this._edgeRaf = 0;
    this._kickThumbsSoon.cancel();
    for (const off of this._cleanups.splice(0)) {
      try { off(); } catch { /* listener target already gone */ }
    }
    releaseVideo(this._thumbVideo);
    this._thumbVideo = null;
    for (const c of this._cache.values()) freeCanvas(c);
    this._cache.clear();
    for (const tile of this._tiles.values()) freeCanvas(tile.el);
    for (const tile of this._tilePool) freeCanvas(tile.el);
    this._tiles.clear();
    this._tilePool = [];
    this._pills.clear();
    this._caps.clear();
    this.el.remove();
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  _build() {
    const ic = (name, size = 16, opts) => h('span', { class: 'tl-ic', html: icon(name, size, opts) });

    // Toolbar ------------------------------------------------------------
    this.playBtn = h('button', {
      type: 'button', class: 'btn btn-icon tl-play', 'aria-label': 'Play', 'data-tip': 'Play (Space)',
      html: icon('play', 15), onclick: () => this.player.toggle(),
    });
    this.timeCur = h('span', { class: 'tl-time-cur' }, '0:00.0');
    this.timeTotal = h('span', { class: 'tl-time-total' }, '0:00.0');
    const time = h('div', { class: 'tl-time' }, this.timeCur, h('span', { class: 'tl-time-sep' }, '/'), this.timeTotal);

    this.addBtn = h('button', {
      type: 'button', class: 'btn btn-tinted btn-sm tl-add', 'aria-label': 'Add zoom at playhead', 'data-tip': 'Add zoom (Z)',
      onclick: () => this.addZoomAtPlayhead(),
    }, ic('zoom-in', 15), h('span', { class: 'tl-label' }, 'Zoom'));

    this.autoBtn = h('button', {
      type: 'button', class: 'btn btn-secondary btn-sm tl-auto', 'aria-label': 'Auto zoom', 'data-tip': 'Find zoom moments automatically',
      onclick: () => this.runAutoZoom(),
    }, ic('sparkles', 15), h('span', { class: 'tl-label' }, 'Auto zoom'));

    this.autoPct = h('span', { class: 'tl-auto-pct' }, '0%');
    this.autoRun = h('div', { class: 'tl-auto-run', role: 'status', hidden: true },
      h('span', { class: 'spinner tl-auto-spinner', 'aria-hidden': 'true' }),
      h('span', { class: 'tl-auto-text' }, 'Analyzing'),
      this.autoPct,
      h('button', {
        type: 'button', class: 'tl-auto-cancel', 'aria-label': 'Cancel auto zoom', 'data-tip': 'Cancel',
        html: icon('x', 13, { strokeWidth: 2.2 }), onclick: () => this._autoAbort?.abort(),
      }));

    this.delBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon btn-sm tl-del', 'aria-label': 'Delete selected zoom', 'data-tip': 'Delete zoom (⌫)',
      disabled: true, html: icon('trash', 16), onclick: () => this.deleteSelected(),
    });

    this.zoomOutBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon btn-sm tl-zoom-btn', 'aria-label': 'Zoom out timeline', 'data-tip': 'Zoom out',
      html: icon('zoom-out', 16), onclick: () => this.zoomOut(),
    });
    this.zoomSlider = h('input', {
      type: 'range', class: 'slider tl-zoom-slider', min: '0', max: '100', step: '1', value: '0', 'aria-label': 'Timeline zoom',
    });
    this.zoomInBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon btn-sm tl-zoom-btn', 'aria-label': 'Zoom in timeline', 'data-tip': 'Zoom in',
      html: icon('zoom-in', 16), onclick: () => this.zoomIn(),
    });
    this.durIcon = h('span', { class: 'tl-ic' });
    this.durText = h('span', { class: 'tl-dur-text' }, '0:00.0');
    this.durChip = h('div', { class: 'chip tl-dur', 'data-tip': 'Length' }, this.durIcon, this.durText);

    this.toolbar = h('div', { class: 'tl-toolbar' },
      h('div', { class: 'tl-tb-left' }, this.playBtn, time),
      h('div', { class: 'tl-tb-center' }, this.addBtn, this.autoBtn, this.autoRun, h('span', { class: 'tl-tb-sep', 'aria-hidden': 'true' }), this.delBtn),
      h('div', { class: 'tl-tb-right' }, this.zoomOutBtn, this.zoomSlider, this.zoomInBtn, this.durChip));

    // Tracks -------------------------------------------------------------
    this.rulerCanvas = h('canvas', { class: 'tl-ruler-canvas', 'aria-hidden': 'true' });
    this.ruler = h('div', { class: 'tl-ruler' }, this.rulerCanvas);

    this.trimOutStart = h('div', { class: 'tl-trim-out is-start' });
    this.trimOutEnd = h('div', { class: 'tl-trim-out is-end' });
    this.film = h('div', { class: 'tl-film is-loading' }, this.trimOutStart, this.trimOutEnd);
    this.trimFrame = h('div', { class: 'tl-trim-frame', 'aria-hidden': 'true' });
    this.trimStartHandle = h('div', {
      class: 'tl-trim-handle is-start', role: 'slider', tabindex: '0', 'aria-label': 'Trim start', dataset: { edge: 'start' },
    });
    this.trimEndHandle = h('div', {
      class: 'tl-trim-handle is-end', role: 'slider', tabindex: '0', 'aria-label': 'Trim end', dataset: { edge: 'end' },
    });
    this.laneVideo = h('div', { class: 'tl-lane tl-lane-video', role: 'group', 'aria-label': 'Video' },
      this.film, this.trimFrame, this.trimStartHandle, this.trimEndHandle);

    this.zoomHint = h('span', { class: 'tl-lane-hint' }, 'Double-click to add a zoom');
    this.laneZoom = h('div', { class: 'tl-lane tl-lane-zoom', role: 'group', 'aria-label': 'Zooms' }, this.zoomHint);

    this.capHint = h('span', { class: 'tl-lane-hint' }, 'No captions yet');
    this.laneCap = h('div', { class: 'tl-lane tl-lane-cap', role: 'group', 'aria-label': 'Captions' }, this.capHint);

    this.hoverLabel = h('span', { class: 'tl-hover-label' });
    this.hoverLine = h('div', { class: 'tl-hover', 'aria-hidden': 'true' }, this.hoverLabel);
    this.snapLine = h('div', { class: 'tl-snap', 'aria-hidden': 'true' });
    this.bubble = h('div', { class: 'tl-bubble', 'aria-hidden': 'true' });
    this.knob = h('div', { class: 'tl-playhead-knob' });
    this.playhead = h('div', { class: 'tl-playhead', 'aria-hidden': 'true' }, h('div', { class: 'tl-playhead-line' }), this.knob);

    this.content = h('div', { class: 'tl-content' },
      this.ruler, this.laneVideo, this.laneZoom, this.laneCap, this.hoverLine, this.snapLine, this.bubble, this.playhead);
    this.scroller = h('div', { class: 'tl-scroll' }, this.content);

    const gutter = h('div', { class: 'tl-gutter', 'aria-hidden': 'true' },
      h('div', { class: 'tl-gutter-row is-video', 'data-tip': 'Video', html: icon('film', 15) }),
      h('div', { class: 'tl-gutter-row is-zoom', 'data-tip': 'Zooms', html: icon('zoom-in', 15) }),
      h('div', { class: 'tl-gutter-row is-cap', 'data-tip': 'Captions', html: icon('captions', 15) }));

    this.tracks = h('div', { class: 'tl-tracks' }, gutter, this.scroller);
    this.el = h('div', { class: 'tl-root', role: 'region', 'aria-label': 'Timeline' }, this.toolbar, this.tracks);
  }

  _listen(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    this._cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  _bind() {
    const { store, player } = this;
    this._cleanups.push(store.onChange(this._onStoreChange));
    this._cleanups.push(store.onUI(this._onUI));
    this._cleanups.push(player.on('time', this._onTime));
    for (const ev of ['play', 'pause', 'ended']) this._cleanups.push(player.on(ev, this._syncPlay));

    // Toolbar buttons never take focus from a mouse click (Space stays play/pause).
    this._listen(this.toolbar, 'mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('button')) e.preventDefault();
    });
    this._listen(this.zoomSlider, 'input', () => {
      this._setZoom(Math.pow(this._maxZoom(), Number(this.zoomSlider.value) / 100));
    });

    const c = this.content;
    this._listen(c, 'pointerdown', this._onPointerDown);
    this._listen(c, 'pointermove', this._onPointerMove);
    this._listen(c, 'pointerup', this._onPointerUp);
    this._listen(c, 'pointercancel', this._onPointerCancel);
    this._listen(c, 'lostpointercapture', this._onPointerCancel);
    this._listen(c, 'pointerleave', this._hideHover);
    // Pills and handles are keyboard-focusable but should not grab focus on click.
    this._listen(c, 'mousedown', (e) => e.preventDefault());
    this._listen(c, 'keydown', this._onKeyDown);
    this._listen(this.scroller, 'scroll', this._onScroll, { passive: true });
    this._listen(this.tracks, 'wheel', this._onWheel, { passive: false });

    if (typeof window !== 'undefined' && 'GestureEvent' in window) {
      // Safari trackpad pinch.
      let base = 1;
      this._listen(this.tracks, 'gesturestart', (e) => { e.preventDefault(); base = this._zoom; });
      this._listen(this.tracks, 'gesturechange', (e) => {
        e.preventDefault();
        const r = this.scroller.getBoundingClientRect();
        this._setZoom(base * e.scale, clamp(e.clientX - r.left, 0, r.width));
      });
      this._listen(this.tracks, 'gestureend', (e) => e.preventDefault());
    }

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this._onResize());
      ro.observe(this.el);
      ro.observe(this.scroller);
      this._cleanups.push(() => ro.disconnect());
    } else {
      this._listen(window, 'resize', () => this._onResize());
    }

    // The ruler canvas reads token colors; redraw when the theme flips.
    const redraw = () => this._drawRuler();
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq?.addEventListener) this._listen(mq, 'change', redraw);
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(redraw);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this._cleanups.push(() => mo.disconnect());
    }
  }

  /* ------------------------------------------------------------------ */
  /* Store / player events                                               */
  /* ------------------------------------------------------------------ */

  _onStoreChange = (project, info) => {
    if (this._destroyed || info?.reason === 'summary') return;
    // ⌘Z mid-drag (trim / zoom pill): the rest of the gesture opens a fresh undo step instead of
    // editing the restored state without history. Scrub drags have no `recorded` flag.
    if ((info?.reason === 'undo' || info?.reason === 'redo') && this._drag && 'recorded' in this._drag) this._drag.recorded = false;
    const dur = this._dur();
    if (this._layoutDur !== undefined && Math.abs(dur - this._layoutDur) > EPS) this._schedule(R_LAYOUT);
    this._schedule(R_MODEL);
  };

  _onUI = (ui, keys) => {
    if (this._destroyed) return;
    if (keys.includes('selectedZoomId')) this._schedule(R_ZOOMS | R_TOOLBAR);
    if (keys.includes('selectedCaptionId')) this._schedule(R_CAPS);
    if (keys.includes('playing')) this._syncPlay();
  };

  _onTime = (t) => {
    if (this._destroyed) return;
    this._updatePlayhead(t);
    this._updateTime(t);
    this._follow(t);
  };

  _syncPlay = () => {
    if (this._destroyed) return;
    const playing = Boolean(this.player.playing);
    if (playing === this._shownPlaying) return;
    this._shownPlaying = playing;
    this.playBtn.innerHTML = icon(playing ? 'pause' : 'play', 15);
    this.playBtn.classList.toggle('is-playing', playing);
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.playBtn.dataset.tip = playing ? 'Pause (Space)' : 'Play (Space)';
  };

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  _schedule(flags) {
    this._dirty |= flags;
    if (!this._raf && !this._destroyed) this._raf = requestAnimationFrame(this._flush);
  }

  _flush = () => {
    this._raf = 0;
    if (this._destroyed) return;
    const d = this._dirty;
    this._dirty = 0;
    if (d & R_LAYOUT) {
      this._layout();
    } else if (this._pps) {
      if (d & R_TRIM) this._renderTrim();
      if (d & R_ZOOMS) this._renderZooms();
      if (d & R_CAPS) this._renderCaps();
    }
    if (d & (R_TOOLBAR | R_LAYOUT)) this._syncToolbar();
  };

  /** Recomputes px-per-second and repositions everything. Returns false while unmeasurable. */
  _layout() {
    const vw = this.scroller.clientWidth;
    if (!vw) return false;
    const dur = this._dur();
    this._vw = vw;
    this._layoutDur = dur;
    // A resize or a duration change can lower the cap; keep the zoom inside it.
    this._zoom = Math.min(this._zoom, this._maxZoom());
    const basePps = Math.max(EPS, (vw - 2 * PAD) / dur);
    this._pps = basePps * this._zoom;
    this._trackW = dur * this._pps;
    const contentW = this._zoom <= MIN_ZOOM + EPS ? vw : Math.ceil(this._trackW + 2 * PAD);
    this._contentW = contentW;
    this.content.style.width = `${contentW}px`;
    this.film.style.width = `${this._trackW}px`;
    this.ruler.style.width = `${vw}px`;
    this._tileH = this.film.clientHeight || 42;

    this._renderTrim(true);
    this._renderZooms(true);
    this._renderCaps(true);
    this._drawRuler();
    this._renderTiles();
    this._phX = NaN;
    this._updatePlayhead(this.player.time);
    this._syncZoomControls();
    return true;
  }

  _renderTrim(force = false) {
    const pps = this._pps;
    if (!pps) return;
    const dur = this._dur();
    const { start, end } = this._trim();
    const sig = `${pps}|${start}|${end}|${dur}`;
    if (!force && sig === this._trimSig) return;
    this._trimSig = sig;

    const xs = PAD + start * pps;
    const xe = PAD + end * pps;
    this.trimOutStart.style.width = `${start * pps}px`;
    this.trimOutEnd.style.left = `${end * pps}px`;
    this.trimOutEnd.style.width = `${Math.max(0, (dur - end) * pps)}px`;
    this.trimFrame.style.left = `${xs - HANDLE_W}px`;
    this.trimFrame.style.width = `${xe - xs + 2 * HANDLE_W}px`;
    this.trimStartHandle.style.left = `${xs - HANDLE_W}px`;
    this.trimEndHandle.style.left = `${xe}px`;
    this.laneVideo.classList.toggle('is-trimmed', start > 0.01 || end < dur - 0.01);

    const minLen = Math.min(MIN_TRIM, dur);
    setSliderAria(this.trimStartHandle, start, 0, Math.max(0, end - minLen));
    setSliderAria(this.trimEndHandle, end, Math.min(dur, start + minLen), dur);
  }

  _renderZooms(force = false) {
    const pps = this._pps;
    if (!pps) return;
    const zooms = this.store.project.edit.zooms || [];
    const sel = this.store.ui.selectedZoomId;
    const { start: ts, end: te } = this._trim();
    let sig = `${pps}|${sel}|${ts}|${te}`;
    for (const z of zooms) sig += `|${z?.id},${z?.start},${z?.end},${z?.scale},${z?.auto ? 1 : 0}`;
    if (!force && sig === this._zoomSig) return;
    this._zoomSig = sig;

    const seen = new Set();
    const animate = this._pillsReady && !this._reducedMotion?.matches;
    let fresh = 0;
    for (const z of zooms) {
      if (!z || !z.id || !Number.isFinite(z.start) || !Number.isFinite(z.end)) continue;
      seen.add(z.id);
      let el = this._pills.get(z.id);
      if (!el) {
        el = this._createPill(z.id);
        this._pills.set(z.id, el);
        this.laneZoom.append(el);
        if (animate) {
          el.style.animationDelay = `${Math.min(fresh++, 12) * 28}ms`;
          el.classList.add('is-new');
          el.addEventListener('animationend', () => { el.classList.remove('is-new'); el.style.animationDelay = ''; }, { once: true });
        }
      }
      const x = PAD + z.start * pps;
      const w = Math.max(4, (z.end - z.start) * pps);
      el.style.left = `${x}px`;
      el.style.width = `${w}px`;
      const selected = z.id === sel;
      el.classList.toggle('is-selected', selected);
      el.classList.toggle('is-auto', Boolean(z.auto));
      el.classList.toggle('is-outside', z.end <= ts + 1e-3 || z.start >= te - 1e-3);
      el.classList.toggle('is-sm', w < 78);
      el.classList.toggle('is-xs', w < 34);
      const label = formatScale(z.scale);
      if (el._label.textContent !== label) el._label.textContent = label;
      el.setAttribute('aria-pressed', String(selected));
      el.setAttribute('aria-label', `${z.auto ? 'Auto zoom' : 'Zoom'} ${label}, ${fmtMs(z.start)} to ${fmtMs(z.end)}`);
    }
    for (const [id, el] of this._pills) {
      if (!seen.has(id)) {
        el.remove();
        this._pills.delete(id);
      }
    }
    this._pillsReady = true;
    this.zoomHint.hidden = seen.size > 0;
  }

  _createPill(id) {
    const label = h('span', { class: 'tl-zoom-label' });
    const el = h('div', { class: 'tl-zoom', role: 'button', tabindex: '0', dataset: { id } },
      h('span', { class: 'tl-zoom-handle is-start', dataset: { edge: 'start' } }),
      h('span', { class: 'tl-zoom-body' },
        h('span', { class: 'tl-zoom-icon', html: icon('zoom-in', 12, { strokeWidth: 2.2 }) }),
        label,
        h('span', { class: 'tl-zoom-auto', html: `${icon('sparkles', 10, { strokeWidth: 2.2 })}<span>Auto</span>` })),
      h('span', { class: 'tl-zoom-handle is-end', dataset: { edge: 'end' } }));
    el._label = label;
    return el;
  }

  _renderCaps(force = false) {
    const pps = this._pps;
    if (!pps) return;
    const transcript = Array.isArray(this.store.project.transcript) ? this.store.project.transcript : [];
    const sel = this.store.ui.selectedCaptionId;
    const { start: ts, end: te } = this._trim();
    let sig = `${pps}|${sel}|${ts}|${te}|${transcript.length}`;
    for (const s of transcript) sig += `|${s?.id},${s?.start},${s?.end},${s?.text}`;
    if (!force && sig === this._capSig) return;
    this._capSig = sig;

    const seen = new Set();
    transcript.forEach((s, i) => {
      if (!s || !Number.isFinite(s.start)) return;
      const key = s.id || `#${i}`;
      if (seen.has(key)) return;
      seen.add(key);
      let el = this._caps.get(key);
      if (!el) {
        el = h('div', { class: 'tl-cap', dataset: { key } });
        this._caps.set(key, el);
        this.laneCap.append(el);
      }
      const end = Number.isFinite(s.end) && s.end > s.start ? s.end : s.start + 0.5;
      const w = Math.max(3, (end - s.start) * pps);
      el.style.left = `${PAD + s.start * pps}px`;
      el.style.width = `${w}px`;
      const text = String(s.text || '').trim();
      if (el.textContent !== text) {
        el.textContent = text;
        el.title = text;
      }
      el.classList.toggle('is-selected', Boolean(s.id) && s.id === sel);
      el.classList.toggle('is-outside', end <= ts + 1e-3 || s.start >= te - 1e-3);
      el.classList.toggle('is-tiny', w < 16);
    });
    for (const [key, el] of this._caps) {
      if (!seen.has(key)) {
        el.remove();
        this._caps.delete(key);
      }
    }
    this.capHint.hidden = seen.size > 0;
  }

  _syncToolbar() {
    if (this._destroyed) return;
    const p = this.store.project;
    const sel = this.store.ui.selectedZoomId;
    this.delBtn.disabled = !(sel && this._zoomById(sel));

    const dur = this._dur();
    const { start, end } = this._trim();
    const trimmed = start > 0.01 || end < dur - 0.01;
    const total = fmtMs(dur);
    if (this.timeTotal.textContent !== total) this.timeTotal.textContent = total;
    const len = fmtMs(trimmedDuration(p));
    if (this.durText.textContent !== len) this.durText.textContent = len;
    const iconName = trimmed ? 'scissors' : 'clock';
    if (iconName !== this._durIconName) {
      this._durIconName = iconName;
      this.durIcon.innerHTML = icon(iconName, 13);
    }
    this.durChip.classList.toggle('is-trimmed', trimmed);
    this.durChip.dataset.tip = trimmed ? 'Length after trim' : 'Length';
  }

  _syncZoomControls() {
    const mz = this._maxZoom();
    this.zoomOutBtn.disabled = this._zoom <= MIN_ZOOM + 1e-3;
    this.zoomInBtn.disabled = this._zoom >= mz - 1e-3;
    const v = String(Math.round((Math.log(this._zoom) / Math.log(mz)) * 100));
    if (this.zoomSlider.value !== v) this.zoomSlider.value = v;
    syncSliderFill(this.zoomSlider);
  }

  _updatePlayhead(t = this.player.time) {
    if (!this._pps) return;
    const x = PAD + clamp(Number(t) || 0, 0, this._dur()) * this._pps;
    if (x === this._phX) return;
    this._phX = x;
    this.playhead.style.transform = `translate3d(${x}px,0,0)`;
  }

  _updateTime(t) {
    const s = fmtMs(Number(t) || 0);
    if (s === this._timeStr) return;
    this._timeStr = s;
    this.timeCur.textContent = s;
  }

  /* ------------------------------------------------------------------ */
  /* Ruler                                                               */
  /* ------------------------------------------------------------------ */

  _drawRuler() {
    const vw = this._vw, pps = this._pps;
    if (!vw || !pps || this._destroyed) return;
    const canvas = this.rulerCanvas;
    const H = this.ruler.clientHeight || 24;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const bw = Math.round(vw * dpr), bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, H);

    const cs = getComputedStyle(this.ruler);
    const labelColor = cs.color || '#8e8e93';
    const tickColor = cs.getPropertyValue('--tl-tick').trim() || 'rgba(128,128,128,0.4)';
    const mono = cs.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';

    const dur = this._dur();
    const sl = this.scroller.scrollLeft;
    const { major, div } = pickTicks(pps);
    const minor = major / div;
    const t0 = Math.max(0, (sl - PAD) / pps - major);
    const t1 = Math.min(dur, (sl - PAD + vw) / pps + major);
    const lineW = Math.max(1, Math.round(dpr)) / dpr;

    ctx.fillStyle = tickColor;
    const k0 = Math.ceil(t0 / minor - EPS), k1 = Math.floor(t1 / minor + EPS);
    for (let k = k0; k <= k1; k++) {
      const x = Math.round((PAD + k * minor * pps - sl) * dpr) / dpr;
      const th = k % div === 0 ? 7 : 4;
      ctx.fillRect(x - lineW / 2, H - th, lineW, th);
    }
    // End-of-recording marker.
    const xEnd = Math.round((PAD + dur * pps - sl) * dpr) / dpr;
    if (xEnd >= 0 && xEnd <= vw) ctx.fillRect(xEnd - lineW / 2, H - 10, lineW, 10);

    ctx.fillStyle = labelColor;
    ctx.font = `500 10px ${mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Labels near the content edges are nudged inward so they never clip.
    const contentL = -sl, contentR = (this._contentW || vw) - sl;
    const m0 = Math.ceil(t0 / major - EPS), m1 = Math.floor(t1 / major + EPS);
    for (let m = m0; m <= m1; m++) {
      const t = m * major;
      const label = major < 1 ? fmtMs(t) : formatTime(t);
      const half = ctx.measureText(label).width / 2;
      const x = clamp(PAD + t * pps - sl, contentL + half + 1, Math.max(contentL + half + 1, contentR - half - 1));
      ctx.fillText(label, Math.round(x), 8.5);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Filmstrip thumbnails                                                */
  /* ------------------------------------------------------------------ */

  _renderTiles() {
    if (!this._pps || !this._vw || this._destroyed) return;
    const dur = this._dur();
    const src = this.store.project.source || {};
    const aspect = src.width > 0 && src.height > 0 ? src.width / src.height : 16 / 9;
    const tileH = this._tileH || 42;
    const tileW = clamp(Math.round(tileH * aspect), 28, 160);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (tileW !== this._tileW || dpr !== this._dpr) {
      // Frame size changed: everything cached is the wrong size.
      for (const tile of this._tiles.values()) { tile.el.remove(); freeCanvas(tile.el); }
      for (const tile of this._tilePool) freeCanvas(tile.el);
      for (const c of this._cache.values()) freeCanvas(c);
      this._tiles.clear();
      this._tilePool = [];
      this._cache.clear();
      this._failedKeys.clear();
      this._tileW = tileW;
      this._dpr = dpr;
    }

    const count = Math.max(1, Math.ceil(this._trackW / tileW));
    const secPerTile = tileW / this._pps;
    this._secPerTile = secPerTile;
    // Frame times sit on a power-of-two grid so zooming reuses most cached frames.
    const grid = Math.max(1 / 32, Math.pow(2, Math.floor(Math.log2(secPerTile))));
    const maxT = Math.max(0, dur - 0.1);
    const sl = this.scroller.scrollLeft;
    const over = this._vw * 0.5;
    const from = Math.max(0, Math.floor((sl - PAD - over) / tileW));
    const to = Math.min(count - 1, Math.floor((sl - PAD + this._vw + over) / tileW));

    for (const [i, tile] of this._tiles) {
      if (i < from || i > to) {
        tile.el.remove();
        this._tiles.delete(i);
        this._tilePool.push(tile);
      }
    }
    for (let i = from; i <= to; i++) {
      let tile = this._tiles.get(i);
      if (!tile) {
        tile = this._tilePool.pop() || this._makeTile(tileW, tileH, dpr);
        tile.key = -1;
        tile.el.style.left = `${i * tileW}px`;
        this.film.insertBefore(tile.el, this.trimOutStart);
        this._tiles.set(i, tile);
      }
      const center = Math.min((i + 0.5) * secPerTile, dur);
      const key = Math.round(clamp(Math.round(center / grid) * grid, 0, maxT) * 1000);
      if (tile.key !== key) this._paintTile(tile, key);
    }
    this._updateFilmState();
    this._kickThumbsSoon();
  }

  _makeTile(tileW, tileH, dpr) {
    const el = h('canvas', { class: 'tl-tile', 'aria-hidden': 'true' });
    el.width = Math.max(1, Math.round(tileW * dpr));
    el.height = Math.max(1, Math.round(tileH * dpr));
    el.style.width = `${tileW}px`;
    return { el, ctx: el.getContext('2d'), key: -1, exact: false, shownKey: null };
  }

  _paintTile(tile, key) {
    let src = this._cache.get(key) || null;
    const exact = Boolean(src);
    let shownKey = exact ? key : null;
    if (exact) {
      this._cache.delete(key); // LRU touch
      this._cache.set(key, src);
    } else {
      const near = this._nearestFrame(key);
      if (near) { src = near.canvas; shownKey = near.key; }
    }
    const { el, ctx } = tile;
    if (ctx) {
      if (src) ctx.drawImage(src, 0, 0, el.width, el.height);
      else ctx.clearRect(0, 0, el.width, el.height);
    }
    el.classList.toggle('is-painted', Boolean(src));
    tile.key = key;
    tile.exact = exact;
    tile.shownKey = shownKey;
  }

  _nearestFrame(key) {
    const maxDist = Math.max(1000, this._secPerTile * 3000);
    let best = null, bestD = maxDist;
    for (const [k, canvas] of this._cache) {
      const d = Math.abs(k - key);
      if (d <= bestD) { bestD = d; best = { key: k, canvas }; }
    }
    return best;
  }

  _updateFilmState() {
    let loading = false;
    if (!this._thumbsFailed) {
      for (const tile of this._tiles.values()) {
        if (!tile.exact && !this._failedKeys.has(tile.key)) { loading = true; break; }
      }
    }
    this.film.classList.toggle('is-loading', loading);
    this.film.classList.toggle('is-failed', this._thumbsFailed);
  }

  _kickThumbs() {
    if (this._thumbRunning || this._thumbsFailed || this._destroyed) return;
    if (!this._nextThumbKey()) return;
    this._thumbRunning = true;
    this._thumbLoop()
      .catch((err) => { if (!this._destroyed) console.warn('[timeline] thumbnails stopped', err); })
      .finally(() => {
        this._thumbRunning = false;
        if (!this._destroyed) this._updateFilmState();
      });
  }

  /** Missing frame closest to the viewport center, or null. */
  _nextThumbKey() {
    const centerPx = this.scroller.scrollLeft - PAD + this._vw / 2;
    let best = null, bestD = Infinity;
    for (const [i, tile] of this._tiles) {
      if (tile.exact || tile.key < 0 || this._failedKeys.has(tile.key) || this._cache.has(tile.key)) continue;
      const d = Math.abs((i + 0.5) * this._tileW - centerPx);
      if (d < bestD) { bestD = d; best = tile.key; }
    }
    return best;
  }

  async _thumbLoop() {
    const video = await this._ensureThumbVideo();
    if (!video) return;
    while (!this._destroyed) {
      const key = this._nextThumbKey();
      if (key === null) break;
      await seekVideo(video, key / 1000);
      if (this._destroyed) return;
      const frame = video.readyState >= 2 && video.videoWidth ? this._captureFrame(video) : null;
      if (!frame) {
        this._failedKeys.add(key);
        continue;
      }
      this._cache.set(key, frame);
      while (this._cache.size > THUMB_CACHE_MAX) {
        const [oldKey, old] = this._cache.entries().next().value;
        this._cache.delete(oldKey);
        freeCanvas(old);
      }
      for (const tile of this._tiles.values()) {
        if (!tile.exact) this._paintTile(tile, tile.key);
      }
      this._updateFilmState();
      // Stay out of the way of playback decoding.
      await sleep(this.player.playing ? 120 : 0);
    }
  }

  _captureFrame(video) {
    const w = Math.max(1, Math.round(this._tileW * this._dpr));
    const hgt = Math.max(1, Math.round((this._tileH || 42) * this._dpr));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hgt;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(w / vw, hgt / vh);
    const sw = w / s, sh = hgt / s;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, hgt);
    } catch {
      freeCanvas(c);
      return null;
    }
    return c;
  }

  /** A private, muted copy of the main video used only for thumbnails. */
  _ensureThumbVideo() {
    if (!this._thumbVideoP) {
      const url = this.player.mainUrl;
      if (!url) {
        this._thumbsFailed = true;
        this._updateFilmState();
        this._thumbVideoP = Promise.resolve(null);
      } else {
        this._thumbVideoP = loadVideo(url, { muted: true, knownDuration: this._dur() }).then(
          (video) => {
            if (this._destroyed) { releaseVideo(video); return null; }
            this._thumbVideo = video;
            return video;
          },
          (err) => {
            if (!this._destroyed) {
              console.warn('[timeline] thumbnails unavailable', err);
              this._thumbsFailed = true;
              this._updateFilmState();
            }
            return null;
          },
        );
      }
    }
    return this._thumbVideoP;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry, scrolling, zoom                                           */
  /* ------------------------------------------------------------------ */

  _dur() {
    const d = Number(this.store.project.duration);
    if (Number.isFinite(d) && d > 0) return d;
    const pd = Number(this.player.duration);
    return Number.isFinite(pd) && pd > 0 ? pd : 1;
  }

  _trim() {
    const dur = this._dur();
    const tr = this.store.project.edit.trim || {};
    const start = clamp(Number.isFinite(tr.start) ? tr.start : 0, 0, dur);
    const end = clamp(Number.isFinite(tr.end) && tr.end > 0 ? tr.end : dur, start, dur);
    return { start, end };
  }

  _zoomById(id) {
    return (this.store.project.edit.zooms || []).find((z) => z && z.id === id) || null;
  }

  /** Source time under a viewport x coordinate. */
  _tAt(clientX) {
    const rect = this._drag?.rect || this.scroller.getBoundingClientRect();
    return (clientX - rect.left + this.scroller.scrollLeft - PAD) / (this._pps || 1);
  }

  _setScroll(left, user = false) {
    const sc = this.scroller;
    const max = Math.max(0, sc.scrollWidth - sc.clientWidth);
    const v = clamp(left, 0, max);
    if (Math.abs(v - sc.scrollLeft) < 0.5) return;
    this._progScroll = user ? null : v;
    sc.scrollLeft = v;
  }

  /**
   * Zoom cap (× fit-to-width). At least MAX_ZOOM so short videos are unchanged; for long
   * videos it grows so full zoom-in reaches TARGET_MAX_PPS px per source second.
   */
  _maxZoom() {
    const vw = this._vw || this.scroller.clientWidth || 0;
    if (!vw) return MAX_ZOOM;
    return Math.max(MAX_ZOOM, (TARGET_MAX_PPS * this._dur()) / Math.max(1, vw - 2 * PAD));
  }

  _setZoom(z, anchorX) {
    if (this._destroyed) return;
    let next = clamp(Number(z) || MIN_ZOOM, MIN_ZOOM, this._maxZoom());
    if (next < MIN_ZOOM + 0.01) next = MIN_ZOOM; // avoid a 1px phantom scroll at "1×"
    if (Math.abs(next - this._zoom) < 1e-4) return;
    if (!this._pps || !this._vw) {
      this._zoom = next;
      this._syncZoomControls();
      return;
    }
    if (anchorX === undefined) {
      const px = PAD + this.player.time * this._pps - this.scroller.scrollLeft;
      anchorX = px >= 0 && px <= this._vw ? px : this._vw / 2;
    }
    const t = (this.scroller.scrollLeft + anchorX - PAD) / this._pps;
    this._zoom = next;
    this._layout();
    this._setScroll(PAD + t * this._pps - anchorX, true);
    this._userScrollAt = performance.now();
    this._drawRuler();
    this._renderTiles();
  }

  _onResize() {
    if (this._destroyed) return;
    const w = this.el.clientWidth;
    this.el.classList.toggle('is-narrow', w > 0 && w < NARROW_PX);
    this.el.classList.toggle('is-compact', w > 0 && w < COMPACT_PX);
    const vw = this.scroller.clientWidth;
    if (!vw || (vw === this._vw && this._pps)) return;
    const anchorT = this._pps ? this.scroller.scrollLeft / this._pps : 0;
    if (this._layout() && anchorT > 0) this._setScroll(anchorT * this._pps, true);
  }

  _onScroll = () => {
    if (this._destroyed) return;
    const sl = this.scroller.scrollLeft;
    if (this._progScroll !== null && Math.abs(sl - this._progScroll) <= 1.5) this._progScroll = null;
    else if (!this._drag) this._userScrollAt = performance.now();
    this._drawRuler();
    this._renderTiles();
  };

  _onWheel = (e) => {
    if (this._destroyed || !this._pps) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this._vw : 1;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel; zoom around the cursor.
      e.preventDefault();
      const factor = clamp(Math.exp(-e.deltaY * unit * 0.005), 0.6, 1.66);
      const r = this.scroller.getBoundingClientRect();
      this._setZoom(this._zoom * factor, clamp(e.clientX - r.left, 0, r.width));
      return;
    }
    if (this.scroller.scrollWidth <= this.scroller.clientWidth + 1) return;
    this._userScrollAt = performance.now();
    if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      this._setScroll(this.scroller.scrollLeft + e.deltaY * unit, true);
    }
  };

  /** Keeps the playhead visible: follows it while playing, reveals it after a seek. */
  _follow(t) {
    if (this._drag || !this._pps || !this._vw) return;
    const sc = this.scroller;
    if (sc.scrollWidth <= sc.clientWidth + 1) return;
    const vw = this._vw;
    const xAbs = PAD + t * this._pps;
    const x = xAbs - sc.scrollLeft;
    const margin = Math.min(96, vw * 0.15);
    if (this.player.playing) {
      if (performance.now() - this._userScrollAt < FOLLOW_PAUSE_MS) return;
      if (x > vw - margin) this._setScroll(xAbs - (vw - margin));
      else if (x < 0) this._setScroll(xAbs - margin);
    } else if (x < 0 || x > vw) {
      this._setScroll(xAbs - vw / 2);
    }
  }

  _revealRange(start, end) {
    if (!this._pps || !this._vw) return;
    const sl = this.scroller.scrollLeft, vw = this._vw;
    const xs = PAD + start * this._pps, xe = PAD + end * this._pps;
    if (xs < sl + 8) this._setScroll(xs - 32);
    else if (xe > sl + vw - 8) this._setScroll(Math.min(xs - 32, xe - vw + 32));
  }

  /* ------------------------------------------------------------------ */
  /* Pointer interactions                                                */
  /* ------------------------------------------------------------------ */

  _onPointerDown = (e) => {
    if (this._destroyed || e.button !== 0 || !e.isPrimary || !this._pps) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (this._drag) this._endDrag(true); // a lost pointerup must never wedge the timeline
    this._hideHover();
    // A focused text field elsewhere (e.g. the title) would otherwise swallow Space.
    const active = document.activeElement;
    if (active && active !== document.body && !this.el.contains(active) && typeof active.blur === 'function') active.blur();

    if (t.closest('.tl-playhead-knob')) return this._startScrub(e, false);
    if (t.closest('.tl-ruler')) return this._startScrub(e, true);
    const handle = t.closest('.tl-trim-handle');
    if (handle) return this._startTrim(e, handle.dataset.edge === 'end' ? 'end' : 'start');
    const pill = t.closest('.tl-zoom');
    if (pill) {
      const zh = t.closest('.tl-zoom-handle');
      return this._startZoomDrag(e, pill.dataset.id, zh ? zh.dataset.edge : 'move');
    }
    const cap = t.closest('.tl-cap');
    if (cap) return this._selectCaption(cap.dataset.key);
    if (t.closest('.tl-lane-zoom')) return this._pressZoomLane(e);
    return this._startScrub(e, true);
  };

  _onPointerMove = (e) => {
    const d = this._drag;
    if (!d) { this._hover(e); return; }
    if (e.pointerId !== d.pointerId) return;
    d.lastX = e.clientX;
    d.altKey = e.altKey;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < DRAG_PX) return;
      d.moved = true;
      d.onStart?.();
    }
    d.onMove(e.clientX);
    this._updateEdgeScroll(e.clientX);
  };

  _onPointerUp = (e) => {
    if (this._drag && e.pointerId === this._drag.pointerId) this._endDrag(false);
  };

  _onPointerCancel = (e) => {
    if (this._drag && e.pointerId === this._drag.pointerId) this._endDrag(true);
  };

  _beginDrag(e, d) {
    Object.assign(d, {
      pointerId: e.pointerId,
      startX: e.clientX,
      lastX: e.clientX,
      altKey: e.altKey,
      moved: false,
      edgeV: 0,
      rect: this.scroller.getBoundingClientRect(),
    });
    this._drag = d;
    try { this.content.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    this.el.classList.add('is-dragging');
    if (d.cls) this.el.classList.add(d.cls);
    return d;
  }

  _endDrag(cancelled) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    if (this._edgeRaf) { cancelAnimationFrame(this._edgeRaf); this._edgeRaf = 0; }
    try {
      if (this.content.hasPointerCapture?.(d.pointerId)) this.content.releasePointerCapture(d.pointerId);
    } catch { /* already released */ }
    this.el.classList.remove('is-dragging');
    if (d.cls) this.el.classList.remove(d.cls);
    this._showSnap(null);
    this.bubble.classList.remove('is-visible');
    try { d.onEnd?.(cancelled, d.moved); } catch (err) { console.error('[timeline] drag end failed', err); }
  }

  _updateEdgeScroll(clientX) {
    const d = this._drag;
    if (!d || !d.moved) return;
    if (this.scroller.scrollWidth <= this.scroller.clientWidth + 1) { d.edgeV = 0; return; }
    const r = d.rect;
    let v = 0;
    if (clientX < r.left + EDGE_PX) v = -Math.min(1.5, (r.left + EDGE_PX - clientX) / EDGE_PX);
    else if (clientX > r.right - EDGE_PX) v = Math.min(1.5, (clientX - (r.right - EDGE_PX)) / EDGE_PX);
    d.edgeV = v;
    if (v && !this._edgeRaf) this._edgeRaf = requestAnimationFrame(this._edgeTick);
  }

  _edgeTick = () => {
    this._edgeRaf = 0;
    const d = this._drag;
    if (!d || !d.edgeV || this._destroyed) return;
    const before = this.scroller.scrollLeft;
    this._setScroll(before + d.edgeV * EDGE_SPEED, true);
    if (Math.abs(this.scroller.scrollLeft - before) < 0.1) return; // hit the end
    d.onMove(d.lastX);
    if (this._drag === d) this._edgeRaf = requestAnimationFrame(this._edgeTick);
  };

  _seekTo(t) {
    this._seekThrottled(clamp(t, 0, this._dur()));
  }

  /** Ruler / empty-track scrubbing, and playhead knob drags. */
  _startScrub(e, immediate) {
    if (immediate) this._seekTo(this._tAt(e.clientX));
    const d = {
      cls: 'is-scrubbing',
      resume: false,
      onStart: () => {
        if (this.player.playing) {
          d.resume = true;
          this.player.pause();
        }
      },
      onMove: (cx) => this._seekTo(this._tAt(cx)),
      onEnd: () => {
        if (d.resume && !this._destroyed) this.player.play();
      },
    };
    this._beginDrag(e, d);
  }

  _startTrim(e, edge) {
    const orig = this._trim()[edge];
    const t0 = this._tAt(e.clientX);
    const targets = this._snapTargets(null);
    const d = {
      cls: 'is-trimming',
      recorded: false,
      onStart: () => { if (this.player.playing) this.player.pause(); },
      onMove: (cx) => {
        const thr = SNAP_PX / (this._pps || 1);
        let v = orig + (this._tAt(cx) - t0);
        const snapAt = d.altKey ? null : nearestTarget(v, targets, thr);
        if (snapAt !== null) v = snapAt;
        // First write opens the undo step (a fresh one: no coalesce key, so a quick
        // second gesture never merges into this one); the rest folds in via history:false.
        const res = this._setTrimEdge(edge, v, { history: !d.recorded });
        if (res.changed) d.recorded = true;
        const applied = res.value;
        this._showSnap(snapAt !== null && Math.abs(applied - snapAt) < 1e-4 ? snapAt : null);
        this._seekTo(applied);
        this._showBubble(fmtMs(applied), PAD + applied * this._pps, this.laneVideo.offsetTop - 22);
      },
      onEnd: (cancelled, moved) => {
        if (!moved && !cancelled && !this._destroyed) this.player.seek(this._trim()[edge]);
      },
    };
    this._beginDrag(e, d);
  }

  /**
   * Writes one trim edge (clamped, ≥ MIN_TRIM long).
   * @returns {{ value: number, changed: boolean }}
   */
  _setTrimEdge(edge, value, { coalesce, history = true } = {}) {
    const dur = this._dur();
    const minLen = Math.min(MIN_TRIM, dur);
    const { start, end } = this._trim();
    const v = edge === 'start'
      ? clamp(value, 0, Math.max(0, end - minLen))
      : clamp(value, Math.min(dur, start + minLen), dur);
    if (Math.abs(v - (edge === 'start' ? start : end)) < EPS) return { value: v, changed: false };
    this.store.update((p) => { p.edit.trim[edge] = v; }, { coalesce, history, reason: 'trim' });
    return { value: v, changed: true };
  }

  _startZoomDrag(e, id, mode) {
    const z = this._zoomById(id);
    if (!z) return;
    if (this.store.ui.selectedZoomId !== id) this.store.setUI({ selectedZoomId: id });
    const orig = { start: z.start, end: z.end };
    const t0 = this._tAt(e.clientX);
    const targets = this._snapTargets(id);
    const d = {
      cls: mode === 'move' ? 'is-moving' : 'is-resizing',
      // First write opens a fresh undo step (no coalesce key, so a quick re-grab is its
      // own step); the rest of the gesture folds into it via history:false.
      recorded: false,
      onMove: (cx) => {
        const pps = this._pps || 1;
        const dt = this._tAt(cx) - t0;
        const thr = SNAP_PX / pps;
        let s = orig.start + (mode === 'end' ? 0 : dt);
        let en = orig.end + (mode === 'start' ? 0 : dt);
        let snapAt = null;
        if (!d.altKey) {
          if (mode === 'move') {
            const a = nearestTarget(s, targets, thr), b = nearestTarget(en, targets, thr);
            const da = a === null ? Infinity : a - s;
            const db = b === null ? Infinity : b - en;
            if (Number.isFinite(da) || Number.isFinite(db)) {
              const useA = Math.abs(da) <= Math.abs(db);
              const delta = useA ? da : db;
              s += delta;
              en += delta;
              snapAt = useA ? a : b;
            }
          } else if (mode === 'start') {
            const a = nearestTarget(s, targets, thr);
            if (a !== null) { s = a; snapAt = a; }
          } else {
            const b = nearestTarget(en, targets, thr);
            if (b !== null) { en = b; snapAt = b; }
          }
        }
        const c = constrainZoom(this.store.project, id, s, en, mode);
        if (snapAt !== null && Math.abs(c.start - snapAt) > 1e-4 && Math.abs(c.end - snapAt) > 1e-4) snapAt = null;
        this._showSnap(snapAt);
        const cur = this._zoomById(id);
        if (!cur) { this._endDrag(true); return; }
        if (Math.abs(cur.start - c.start) > EPS || Math.abs(cur.end - c.end) > EPS) {
          this.store.update((p) => {
            const zz = p.edit.zooms.find((q) => q.id === id);
            if (!zz) return;
            zz.start = c.start;
            zz.end = c.end;
            zz.auto = false; // hand-tuned: a later auto-zoom pass must not replace it
          }, { history: !d.recorded, reason: 'zoom-drag' });
          d.recorded = true;
        }
        const text = mode === 'move'
          ? `${fmtMs(c.start)} – ${fmtMs(c.end)}`
          : `${(c.end - c.start).toFixed(1)}s`;
        this._showBubble(text, PAD + ((c.start + c.end) / 2) * pps, this.laneZoom.offsetTop - 22);
      },
      onEnd: (cancelled, moved) => {
        if (cancelled || moved || this._destroyed) return;
        const cur = this._zoomById(id);
        if (cur) this.player.seek(cur.start);
      },
    };
    this._beginDrag(e, d);
  }

  /** Empty zoom-track press: deselect + scrub; a double-click adds a zoom there. */
  _pressZoomLane(e) {
    const now = performance.now();
    const last = this._lastLaneClick;
    if (last && now - last.at < DOUBLE_CLICK_MS && Math.abs(e.clientX - last.x) < 6) {
      this._lastLaneClick = null;
      this._addZoomAt(this._tAt(e.clientX), 'No room for a zoom here');
      return;
    }
    this._lastLaneClick = { at: now, x: e.clientX };
    if (this.store.ui.selectedZoomId) this.store.setUI({ selectedZoomId: null });
    this._startScrub(e, true);
  }

  _selectCaption(key) {
    const transcript = this.store.project.transcript || [];
    const seg = transcript.find((s, i) => s && (s.id || `#${i}`) === key);
    if (!seg) return;
    if (seg.id) this.store.setUI({ selectedCaptionId: seg.id });
    this.player.seek(seg.start);
  }

  _addZoomAt(t, noRoomMessage) {
    if (this._destroyed) return null;
    const slot = findZoomSlot(this.store.project, t);
    if (!slot) {
      toast(noRoomMessage || 'No room for a zoom here');
      return null;
    }
    const zoom = { id: uid('z_'), start: slot.start, end: slot.end, scale: ZOOM_DEFAULTS.scale, x: 0.5, y: 0.5, auto: false };
    this.store.update((p) => { p.edit.zooms.push(zoom); }, { reason: 'zoom-add' });
    this.store.setUI({ selectedZoomId: zoom.id });
    this._revealRange(zoom.start, zoom.end);
    return { ...zoom };
  }

  _snapTargets(excludeZoomId) {
    const p = this.store.project;
    const { start, end } = this._trim();
    const out = [0, this._dur(), start, end, this.player.time];
    for (const z of p.edit.zooms || []) {
      if (z && z.id !== excludeZoomId) out.push(z.start, z.end);
    }
    return out.filter(Number.isFinite);
  }

  _onKeyDown = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.classList.contains('tl-trim-handle')) {
      const edge = t.dataset.edge === 'end' ? 'end' : 'start';
      const cur = this._trim()[edge];
      let next = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - (e.shiftKey ? 1 : 0.1);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + (e.shiftKey ? 1 : 0.1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = this._dur();
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.player.seek(this._setTrimEdge(edge, next, { coalesce: 'trim-key' }).value);
      return;
    }
    if (t.classList.contains('tl-zoom') && e.key === 'Enter') {
      e.preventDefault();
      const z = this._zoomById(t.dataset.id);
      if (!z) return;
      this.store.setUI({ selectedZoomId: z.id });
      this.player.seek(z.start);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Transient overlays                                                  */
  /* ------------------------------------------------------------------ */

  _hover(e) {
    if (e.pointerType === 'touch' || !this._pps) return;
    const t = e.target instanceof Element ? e.target : null;
    const inZone = t && t.closest('.tl-ruler, .tl-lane-video, .tl-lane-cap') && !t.closest('.tl-trim-handle, .tl-playhead-knob');
    if (!inZone) { this._hideHover(); return; }
    const time = clamp(this._tAt(e.clientX), 0, this._dur());
    this.hoverLine.style.transform = `translate3d(${PAD + time * this._pps}px,0,0)`;
    const s = fmtMs(time);
    if (this.hoverLabel.textContent !== s) this.hoverLabel.textContent = s;
    this.hoverLine.classList.add('is-visible');
  }

  _hideHover = () => {
    this.hoverLine.classList.remove('is-visible');
  };

  _showSnap(t) {
    if (t === null || t === undefined || !this._pps) {
      this.snapLine.classList.remove('is-visible');
      return;
    }
    this.snapLine.style.transform = `translate3d(${PAD + t * this._pps}px,0,0)`;
    this.snapLine.classList.add('is-visible');
  }

  _showBubble(text, x, top) {
    const b = this.bubble;
    if (b.textContent !== text) b.textContent = text;
    b.style.top = `${Math.max(0, top)}px`;
    const w = b.offsetWidth || 60;
    const sl = this.scroller.scrollLeft;
    const left = clamp(x - w / 2, sl + 4, Math.max(sl + 4, sl + this._vw - w - 4));
    b.style.transform = `translate3d(${left}px,0,0)`;
    b.classList.add('is-visible');
  }

  /* ------------------------------------------------------------------ */
  /* Auto zoom UI                                                        */
  /* ------------------------------------------------------------------ */

  _setAutoRunning(running) {
    this.autoBtn.hidden = running;
    this.autoRun.hidden = !running;
    this._autoPct = -1;
    if (running) this._setAutoProgress(0);
  }

  _setAutoProgress(f) {
    const pct = Math.round(clamp(Number(f) || 0, 0, 1) * 100);
    if (pct === this._autoPct) return;
    this._autoPct = pct;
    this.autoPct.textContent = `${pct}%`;
    this.autoRun.style.setProperty('--p', `${pct}%`);
  }
}

/* -------------------------------------------------------------------- */
/* Helpers                                                               */
/* -------------------------------------------------------------------- */

function pickTicks(pps) {
  const [major, divs] = TICKS.find(([m]) => m * pps >= MIN_LABEL_PX) || TICKS[TICKS.length - 1];
  const div = divs.find((n) => (major / n) * pps >= MIN_TICK_PX) || 1;
  return { major, div };
}

function nearestTarget(t, targets, threshold) {
  let best = null, bestD = threshold;
  for (const g of targets) {
    const d = Math.abs(g - t);
    if (d <= bestD) { bestD = d; best = g; }
  }
  return best;
}

/**
 * "1:05.3" — formatted from an integer count of tenths, so float noise
 * (2.3 % 1 = 0.2999…) never shows as 2.2. Non-finite/negative input → "0:00.0".
 */
function fmtMs(t) {
  const v = Number(t);
  const tenths = Number.isFinite(v) && v > 0 ? Math.round(v * 10) : 0;
  return `${formatTime(Math.floor(tenths / 10))}.${tenths % 10}`;
}

/** 1.8 → "1.8×", 2 → "2×" */
function formatScale(scale) {
  const v = Math.round((Number(scale) || 1) * 10) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}×`;
}

function setSliderAria(el, value, min, max) {
  el.setAttribute('aria-valuemin', min.toFixed(1));
  el.setAttribute('aria-valuemax', max.toFixed(1));
  el.setAttribute('aria-valuenow', value.toFixed(1));
  el.setAttribute('aria-valuetext', fmtMs(value));
}

function freeCanvas(c) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

/** Drops the decoder of a private video without touching its (player-owned) URL. */
function releaseVideo(video) {
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* already torn down */ }
}
