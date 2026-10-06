// Design inspector (Edit step, no zoom selected): orientation, layout, background,
// frame, camera and a zoom overview. Also exports the small control builders that
// the other inspector panels share, so every panel looks and behaves the same.

import { h, clamp, syncSliderFill, formatTime } from '../../lib/util.js';
import { icon } from '../../lib/icons.js';
import { ASPECTS, BACKGROUNDS, getAspect, getBackground, defaultEdit } from '../../lib/project.js';

/* ------------------------------------------------------------------ */
/* Shared control builders                                             */
/* ------------------------------------------------------------------ */

/** "1.8×", "2×", "2.25×" */
export function formatScale(v) {
  return `${Number((Number(v) || 1).toFixed(2))}×`;
}

const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

/**
 * Inspector section with an uppercase title and an optional right-aligned aside.
 * @returns {HTMLElement}
 */
export function panelSection(title, children = [], { aside = null, className = '' } = {}) {
  const asideEl = aside instanceof Node ? aside : aside != null ? h('span', { class: 'pn-aside' }, String(aside)) : null;
  return h('section', { class: `panel-section pn-section ${className}`.trim() },
    title ? h('h3', { class: 'section-title' }, h('span', {}, title), asideEl) : null,
    children);
}

/**
 * Range slider with its name on the left and the live value on the right.
 * `set(v)` updates it in place (no events), so store sync never fights a drag.
 * Double-click resets to `defaultValue` when given.
 *
 * `onInput(value, opts)`: during a pointer drag `opts` is `{ history: true }` for the first
 * write and `{ history: false }` for the rest, so one drag is exactly one undo step however
 * long the user pauses mid-drag; pass it through to store.update. Keyboard and reset writes
 * get no `opts` (they rely on the caller's coalesce key). Call `rearm()` after an undo/redo
 * so a drag still in progress records a fresh step instead of editing the restored state.
 * @returns {{ el: HTMLElement, input: HTMLInputElement, set: (v:number) => void, rearm: () => void }}
 */
export function sliderControl({ label, min, max, step, value, format = String, onInput, defaultValue, onGestureStart }) {
  const valueEl = h('span', { class: 'value pn-slider-value' });
  const input = h('input', { type: 'range', class: 'slider', min: String(min), max: String(max), step: String(step), 'aria-label': label });
  const el = h('div', { class: 'field pn-slider' },
    h('div', { class: 'label' }, h('span', {}, label), valueEl),
    input);

  const show = (v) => {
    const text = format(v);
    valueEl.textContent = text;
    input.setAttribute('aria-valuetext', text);
    syncSliderFill(input);
  };
  const set = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const c = clamp(n, min, max);
    if (Number(input.value) !== c) input.value = String(c);
    show(c);
  };

  let gesture = null; // { recorded } while a pointer holds the slider
  const endGesture = () => {
    gesture = null;
    window.removeEventListener('pointerup', endGesture, true);
    window.removeEventListener('pointercancel', endGesture, true);
  };
  input.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    gesture = { recorded: false };
    window.addEventListener('pointerup', endGesture, true);
    window.addEventListener('pointercancel', endGesture, true);
    onGestureStart?.();
  });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    show(v);
    const opts = gesture ? { history: !gesture.recorded } : undefined;
    if (gesture) gesture.recorded = true;
    onInput?.(v, opts);
  });
  if (defaultValue !== undefined) {
    input.addEventListener('dblclick', () => {
      set(defaultValue);
      onInput?.(Number(defaultValue)); // a reset is its own step
    });
  }
  const rearm = () => { if (gesture) gesture.recorded = false; };
  set(value);
  return { el, input, set, rearm };
}

/**
 * Apple-style segmented control.
 * @param {{ options: Array<{value:any,label?:string,icon?:string,tip?:string}>, value:any, onChange:(v:any)=>void, label?:string }} o
 * @returns {{ el: HTMLElement, set: (v:any) => void }}
 */
export function segmentedControl({ options, value, onChange, label, className = '' }) {
  let current;
  const buttons = new Map();
  const el = h('div', { class: `segmented pn-segmented ${className}`.trim(), role: 'group', 'aria-label': label || null });
  for (const opt of options) {
    const btn = h('button', {
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': opt.label ? null : opt.tip || String(opt.value),
      'data-tip': opt.tip || null,
      onclick: () => { if (current !== opt.value) onChange?.(opt.value); },
    },
    opt.icon ? h('span', { class: 'pn-seg-icon', html: icon(opt.icon, 14) }) : null,
    opt.label ? h('span', {}, opt.label) : null);
    buttons.set(opt.value, btn);
    el.append(btn);
  }
  const set = (v) => {
    current = v;
    for (const [val, btn] of buttons) {
      const on = val === v;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  };
  set(value);
  return { el, set };
}

/**
 * Labelled switch row (the whole row is clickable).
 * @returns {{ el: HTMLElement, input: HTMLInputElement, set: (on:boolean) => void }}
 */
export function switchControl({ label, hint = null, checked = false, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange?.(input.checked));
  const el = h('label', { class: 'toggle-row pn-toggle' },
    h('span', { class: 'pn-toggle-text' }, h('span', {}, label), hint ? h('span', { class: 'pn-toggle-hint' }, hint) : null),
    h('span', { class: 'switch' }, input, h('span', { 'aria-hidden': 'true' })));
  const set = (on) => { if (input.checked !== Boolean(on)) input.checked = Boolean(on); };
  return { el, input, set };
}

/** Small labelled block (label above a control). */
function fieldBlock(label, control) {
  return h('div', { class: 'pn-field' }, h('div', { class: 'pn-field-label' }, label), control);
}

/* ------------------------------------------------------------------ */
/* Camera corners                                                      */
/* ------------------------------------------------------------------ */

const CORNERS = [
  { id: 'tl', label: 'Top left' },
  { id: 'tr', label: 'Top right' },
  { id: 'bl', label: 'Bottom left' },
  { id: 'br', label: 'Bottom right' },
];
const CORNER_MARGIN = 0.05;   // of the output's shorter side
const CORNER_TOLERANCE = 0.07;

/** Normalized bubble center that tucks the camera into `corner` for the current size/aspect. */
function cornerPosition(edit, corner) {
  const a = getAspect(edit.aspect);
  const short = Math.min(a.width, a.height);
  const d = clamp(Number(edit.camera?.size) || 0.22, 0.1, 0.45) * short;
  const off = CORNER_MARGIN * short + d / 2;
  const cx = off / a.width, cy = off / a.height;
  return {
    x: Math.round((corner[1] === 'l' ? cx : 1 - cx) * 10000) / 10000,
    y: Math.round((corner[0] === 't' ? cy : 1 - cy) * 10000) / 10000,
  };
}

/** The corner the bubble currently sits in (within a tolerance), or null. */
function cornerOf(edit) {
  const cam = edit.camera || {};
  for (const c of CORNERS) {
    const p = cornerPosition(edit, c.id);
    if (Math.abs(p.x - cam.x) <= CORNER_TOLERANCE && Math.abs(p.y - cam.y) <= CORNER_TOLERANCE) return c.id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Design panel                                                        */
/* ------------------------------------------------------------------ */

// store → the auto-zoom run a Design panel started and is waiting on. The shell rebuilds
// this panel (step switches, zoom select → Done), so a fresh instance picks the run back up
// even when the shell passes no `autoZoomJob`.
const autoJobs = new WeakMap();

/**
 * @param {{ store: object, player?: object|null, onAutoZoom?: (() => any)|null,
 *           autoZoomJob?: (() => Promise<any>|null)|null }} opts
 *   `autoZoomJob` returns the auto-zoom run in flight (from any trigger), or null.
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createDesignPanel({ store, player = null, onAutoZoom = null, autoZoomJob = null } = {}) {
  const project = store.project;
  const defaults = defaultEdit(project.duration, { hasCamera: project.source?.hasCamera, mode: project.mode });
  const hasCamera = Boolean(project.source?.hasCamera);
  const offs = [];
  let destroyed = false;

  // `extra` carries a slider gesture's { history } (see sliderControl).
  const edit = (fn, coalesce, extra) => store.update((p) => fn(p.edit, p), { ...(coalesce ? { coalesce } : {}), ...extra });

  /* Orientation ---------------------------------------------------- */

  const aspectCards = new Map();
  const aspectGrid = h('div', { class: 'option-grid pn-aspect-grid', role: 'group', 'aria-label': 'Orientation' },
    ASPECTS.map((a) => {
      // Equal-area glyphs read as "the same canvas, different shape".
      const ratio = a.width / a.height;
      const gw = Math.sqrt(560 * ratio), gh = Math.sqrt(560 / ratio);
      const card = h('button', {
        type: 'button',
        class: 'option-card pn-aspect',
        'aria-pressed': 'false',
        'aria-label': `${a.name} ${a.id}, ${a.hint}`,
        onclick: () => {
          if (store.project.edit.aspect === a.id) return;
          edit((e) => {
            const corner = hasCamera ? cornerOf(e) : null;
            e.aspect = a.id;
            if (corner) Object.assign(e.camera, cornerPosition(e, corner));
          });
        },
      },
      h('span', { class: 'pn-aspect-top' },
        h('span', { class: 'pn-aspect-glyph-box' },
          h('span', { class: 'pn-aspect-glyph', style: { width: `${gw.toFixed(1)}px`, height: `${gh.toFixed(1)}px` } })),
        h('span', { class: 'pn-aspect-ratio' }, a.id)),
      h('span', { class: 'option-title' }, a.name),
      h('span', { class: 'option-desc' }, a.hint));
      aspectCards.set(a.id, card);
      return card;
    }));

  /* Layout --------------------------------------------------------- */

  const fitSeg = segmentedControl({
    label: 'Layout',
    options: [
      { value: 'fit', label: 'Fit', icon: 'frame' },
      { value: 'fill', label: 'Fill', icon: 'expand' },
    ],
    value: project.edit.fit,
    onChange: (v) => edit((e) => { e.fit = v; }),
  });
  const fitHint = h('p', { class: 'pn-hint' });

  // Camera-only recordings have no Camera section (no separate camera take), yet the
  // renderer mirrors their main video by `camera.mirror`, so offer the switch here.
  const camOnlyMirror = project.mode === 'cam' && !hasCamera
    ? switchControl({
        label: 'Mirror video',
        hint: 'Turn off so text reads correctly.',
        checked: Boolean(project.edit.camera?.mirror),
        onChange: (v) => edit((e) => { e.camera = { ...e.camera, mirror: v }; }),
      })
    : null;
  camOnlyMirror?.el.classList.add('pn-layout-mirror');

  /* Background ----------------------------------------------------- */

  const bgName = h('span', { class: 'pn-aside' });
  const swatches = new Map();
  const swatchGrid = h('div', { class: 'swatch-grid pn-swatches', role: 'group', 'aria-label': 'Background' },
    BACKGROUNDS.map((b) => {
      const sw = h('button', {
        type: 'button',
        class: `swatch pn-swatch${b.kind === 'blur' ? ' pn-swatch-blur' : ''}`,
        'data-tip': b.kind === 'blur' ? 'Blurred recording' : b.name,
        'aria-label': b.kind === 'blur' ? 'Blurred recording' : b.name,
        'aria-pressed': 'false',
        style: { background: b.css },
        onclick: () => { if (store.project.edit.background !== b.id) edit((e) => { e.background = b.id; }); },
      }, b.kind === 'blur' ? h('span', { class: 'pn-swatch-badge', html: icon('image', 13) }) : null);
      swatches.set(b.id, sw);
      return sw;
    }));

  /* Frame ---------------------------------------------------------- */

  const padding = sliderControl({
    label: 'Padding', min: 0, max: 0.2, step: 0.005, value: project.edit.padding, format: pct,
    defaultValue: defaults.padding,
    onInput: (v, o) => edit((e) => { e.padding = v; }, 'padding', o),
  });
  const radius = sliderControl({
    label: 'Roundness', min: 0, max: 48, step: 1, value: project.edit.radius, format: (v) => String(Math.round(v)),
    defaultValue: defaults.radius,
    onInput: (v, o) => edit((e) => { e.radius = v; }, 'radius', o),
  });
  const shadow = sliderControl({
    label: 'Shadow', min: 0, max: 1, step: 0.01, value: project.edit.shadow, format: pct,
    defaultValue: defaults.shadow,
    onInput: (v, o) => edit((e) => { e.shadow = v; }, 'shadow', o),
  });
  const chromeSeg = segmentedControl({
    label: 'Window',
    options: [
      { value: 'none', label: 'None' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
    value: project.edit.windowChrome,
    onChange: (v) => edit((e) => { e.windowChrome = v; }),
  });
  const fillNote = h('div', { class: 'pn-note', hidden: true },
    h('span', { class: 'pn-note-icon', html: icon('info', 15) }),
    h('span', { class: 'grow' }, 'Frame styling applies in Fit layout.'),
    h('button', { type: 'button', class: 'pn-link', onclick: () => edit((e) => { e.fit = 'fit'; }) }, 'Use Fit'));
  const frameControls = h('div', { class: 'pn-stack' }, padding.el, radius.el, shadow.el, fieldBlock('Window', chromeSeg.el));
  const frameSection = panelSection('Frame', [fillNote, frameControls]);

  /* Camera --------------------------------------------------------- */

  let cameraSection = null;
  let cam = null;
  if (hasCamera) {
    const c0 = project.edit.camera;
    const show = switchControl({ label: 'Show camera', checked: c0.visible, onChange: (v) => edit((e) => { e.camera.visible = v; }) });
    const shape = segmentedControl({
      label: 'Shape',
      options: [
        { value: 'circle', label: 'Circle' },
        { value: 'rounded', label: 'Rounded' },
        { value: 'square', label: 'Square' },
      ],
      value: c0.shape,
      onChange: (v) => edit((e) => { e.camera.shape = v; }),
    });
    const size = sliderControl({
      label: 'Size', min: 0.1, max: 0.45, step: 0.01, value: c0.size, format: pct,
      defaultValue: defaults.camera.size,
      onInput: (v, o) => edit((e) => {
        // A bubble tucked into a corner stays tucked in as it grows or shrinks.
        const corner = cornerOf(e);
        e.camera.size = v;
        if (corner) Object.assign(e.camera, cornerPosition(e, corner));
      }, 'camera-size', o),
    });
    const cornerButtons = new Map();
    const corners = h('div', { class: 'pn-corners', role: 'group', 'aria-label': 'Camera position' },
      CORNERS.map((c) => {
        const b = h('button', {
          type: 'button',
          class: 'pn-corner',
          dataset: { corner: c.id },
          'data-tip': c.label,
          'aria-label': `Move camera to ${c.label.toLowerCase()}`,
          'aria-pressed': 'false',
          onclick: () => edit((e) => { Object.assign(e.camera, cornerPosition(e, c.id)); e.camera.visible = true; }),
        }, h('span', { class: 'pn-corner-glyph', 'aria-hidden': 'true' }));
        cornerButtons.set(c.id, b);
        return b;
      }));
    const mirror = switchControl({ label: 'Mirror', checked: c0.mirror, onChange: (v) => edit((e) => { e.camera.mirror = v; }) });
    const border = switchControl({ label: 'Border', checked: c0.border, onChange: (v) => edit((e) => { e.camera.border = v; }) });
    const body = h('div', { class: 'pn-stack pn-camera-body' },
      fieldBlock('Shape', shape.el),
      size.el,
      h('div', { class: 'pn-field' },
        h('div', { class: 'pn-field-label' }, 'Position'),
        corners,
        h('p', { class: 'pn-hint' }, 'Or drag the bubble in the preview.')),
      h('div', {}, mirror.el, border.el));
    cameraSection = panelSection('Camera', [show.el, body], { className: 'pn-camera' });
    cam = { show, shape, size, cornerButtons, mirror, border, body };
  }

  /* Zooms ---------------------------------------------------------- */

  const zoomCount = h('span', { class: 'pn-aside' });
  const zoomList = h('div', { class: 'pn-zoom-list' });
  const zoomEmpty = h('p', { class: 'pn-muted' }, 'No zooms yet. Add one at the playhead, or let Dolly find the moments that matter.');
  const autoLabel = h('span', {}, 'Auto zoom');
  const autoIcon = h('span', { class: 'pn-btn-icon', html: icon('sparkles', 15) });
  const autoBtn = typeof onAutoZoom === 'function'
    ? h('button', { type: 'button', class: 'btn btn-tinted btn-sm pn-auto-btn', onclick: runAuto }, autoIcon, autoLabel)
    : null;
  const zoomHint = h('p', { class: 'pn-hint' }, 'Press ', h('kbd', { class: 'kbd' }, 'Z'), ' to add a zoom at the playhead');
  let zoomSig = '';
  let zoomRows = [];
  let autoBusy = false;

  function runAuto() {
    if (autoBusy || typeof onAutoZoom !== 'function') return;
    let result;
    try {
      result = onAutoZoom();
    } catch (err) {
      console.error('[design] auto zoom failed', err);
      return;
    }
    // (Already tracked when the store's autoZoomRunning notice arrived during the call.)
    if (result && typeof result.then === 'function' && !autoBusy) trackAuto(result);
  }

  /** Shows the button as busy until run `p` settles (and remembers it for a rebuilt panel). */
  function trackAuto(p) {
    setAutoBusy(true);
    autoJobs.set(store, p);
    Promise.resolve(p).catch(() => {}).then(() => {
      if (autoJobs.get(store) === p) autoJobs.delete(store);
      if (!destroyed) setAutoBusy(false);
    });
  }

  function setAutoBusy(busy) {
    autoBusy = busy;
    if (!autoBtn) return;
    autoBtn.disabled = busy;
    autoBtn.classList.toggle('is-busy', busy);
    autoIcon.innerHTML = busy ? '<span class="spinner pn-spinner-sm"></span>' : icon('sparkles', 15);
    autoLabel.textContent = busy ? 'Finding moments…' : 'Auto zoom';
  }

  /** Attaches the button to a run already going (from any trigger); true when there was one. */
  function attachToRunningAuto({ remembered = true } = {}) {
    if (!autoBtn || autoBusy) return false;
    let pending = null;
    if (typeof autoZoomJob === 'function') {
      try { pending = autoZoomJob(); } catch { pending = null; }
    }
    if (remembered && !(pending && typeof pending.then === 'function')) pending = autoJobs.get(store) || null;
    if (!(pending && typeof pending.then === 'function')) return false;
    trackAuto(pending);
    return true;
  }

  // Rebuilt mid-analysis: attach to the run that is already going instead of showing idle.
  attachToRunningAuto();
  // A run started elsewhere (the timeline toolbar) while this panel is open.
  offs.push(store.onUI((ui, keys) => {
    if (!destroyed && keys.includes('autoZoomRunning') && ui.autoZoomRunning) attachToRunningAuto({ remembered: false });
  }));

  function renderZooms() {
    const zooms = store.project.edit.zooms || [];
    const sig = zooms.map((z) => `${z.id}:${z.start.toFixed(2)}:${z.end.toFixed(2)}:${z.scale}:${z.auto ? 1 : 0}`).join('|');
    zoomCount.textContent = zooms.length ? `${zooms.length} ${zooms.length === 1 ? 'zoom' : 'zooms'}` : '';
    if (sig === zoomSig) return;
    zoomSig = sig;
    zoomEmpty.hidden = zooms.length > 0;
    zoomList.hidden = zooms.length === 0;
    zoomRows = zooms.map((z) => {
      const row = h('button', {
        type: 'button',
        class: 'pn-zoom-item',
        'aria-label': `${z.auto ? 'Auto zoom' : 'Zoom'} ${formatScale(z.scale)} from ${formatTime(z.start)} to ${formatTime(z.end)}`,
        onclick: () => {
          player?.seek(z.start);
          store.setUI({ selectedZoomId: z.id });
        },
      },
      h('span', { class: 'pn-zoom-item-icon', html: icon('zoom-in', 14) }),
      h('span', { class: 'pn-zoom-item-scale' }, formatScale(z.scale)),
      h('span', { class: 'pn-zoom-item-range' }, `${formatTime(z.start)} – ${formatTime(z.end)}`),
      z.auto ? h('span', { class: 'badge badge-accent pn-zoom-item-badge' }, 'Auto') : null,
      h('span', { class: 'pn-zoom-item-chevron', html: icon('chevron-right', 14) }));
      return { start: z.start, end: z.end, el: row };
    });
    zoomList.replaceChildren(...zoomRows.map((r) => r.el));
    highlightZoom(currentTime());
  }

  let litZoom = null;
  function highlightZoom(t) {
    const row = zoomRows.find((r) => t >= r.start && t < r.end)?.el || null;
    if (row === litZoom) return;
    litZoom?.classList.remove('is-live');
    row?.classList.add('is-live');
    litZoom = row;
  }

  const currentTime = () => (player && Number.isFinite(player.time) ? player.time : Number(store.ui.time) || 0);

  /* Assemble ------------------------------------------------------- */

  const el = h('div', { class: 'pn pn-design' },
    panelSection('Orientation', [aspectGrid]),
    panelSection('Layout', [fitSeg.el, fitHint, camOnlyMirror?.el || null]),
    panelSection('Background', [swatchGrid], { aside: bgName }),
    frameSection,
    cameraSection,
    panelSection('Zooms', [
      zoomEmpty,
      zoomList,
      h('div', { class: 'pn-zoom-actions' }, autoBtn, zoomHint),
    ], { aside: zoomCount }));

  /* Sync ----------------------------------------------------------- */

  function sync() {
    if (destroyed) return;
    const e = store.project.edit;
    for (const [id, card] of aspectCards) {
      const on = id === e.aspect;
      card.classList.toggle('active', on);
      card.setAttribute('aria-pressed', String(on));
    }
    fitSeg.set(e.fit);
    fitHint.textContent = e.fit === 'fill'
      ? 'Your recording fills the canvas, cropped at the edges.'
      : 'Your recording floats on the background.';
    camOnlyMirror?.set(Boolean(e.camera?.mirror));

    const bg = getBackground(e.background);
    bgName.textContent = bg.kind === 'blur' ? 'Blurred' : bg.name;
    for (const [id, sw] of swatches) {
      const on = id === bg.id;
      sw.classList.toggle('active', on);
      sw.setAttribute('aria-pressed', String(on));
    }

    padding.set(e.padding);
    radius.set(e.radius);
    shadow.set(e.shadow);
    chromeSeg.set(e.windowChrome);
    const fill = e.fit === 'fill';
    fillNote.hidden = !fill;
    frameControls.classList.toggle('is-inactive', fill);

    if (cam) {
      const c = e.camera;
      cam.show.set(c.visible);
      cam.shape.set(c.shape);
      cam.size.set(c.size);
      cam.mirror.set(c.mirror);
      cam.border.set(c.border);
      const corner = cornerOf(e);
      for (const [id, b] of cam.cornerButtons) {
        const on = id === corner;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      cam.body.classList.toggle('is-disabled', !c.visible);
      if ('inert' in cam.body) cam.body.inert = !c.visible;
    }

    renderZooms();
  }

  sync();
  offs.push(store.onChange(sync));
  // ⌘Z works mid-drag (range inputs aren't typing targets): the rest of that drag starts a new step.
  const sliders = [padding, radius, shadow, cam?.size].filter(Boolean);
  offs.push(store.onChange((p, info) => {
    if (info?.reason === 'undo' || info?.reason === 'redo') sliders.forEach((s) => s.rearm());
  }));
  if (player?.on) offs.push(player.on('time', (t) => { if (!destroyed) highlightZoom(t); }));

  return {
    el,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off?.(); } catch { /* already gone */ } });
    },
  };
}
