// Live preview: draws the composed output frame (background, frame, zoom,
// camera bubble, captions) into a canvas letterboxed inside the editor stage.
// Drag the camera bubble to move it; a plain click toggles playback.

import { h, clamp } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { getOutputSize, computeLayout, drawFrame, hitTestCamera } from './renderer.js';
import { buildCaptionChunks } from './captions.js';

const MAX_BACKING_LONG_SIDE = 2400;
const DRAG_THRESHOLD = 4;        // CSS px of travel before a press becomes a drag
const SCRUB_FADE_MS = 700;       // play overlay stays hidden this long after a paused seek
const END_EPSILON = 0.05;
const MIN_PLAY_FRAME_MS = 1000 / 64; // ~60fps cap on high-refresh displays

/**
 * @param {{ store: import('./store.js').EditorStore, player: import('./player.js').Player }} opts
 * @returns {{ el: HTMLElement, destroy: () => void, redraw: () => void }}
 */
export function createPreview({ store, player }) {
  const canvas = h('canvas', { class: 'ed-canvas', role: 'img', 'aria-label': 'Video preview' });
  const ring = h('div', { class: 'ed-cam-ring', 'aria-hidden': 'true' });
  const playBtn = h('button', { class: 'ed-play-overlay', type: 'button', 'aria-label': 'Play', html: icon('play', 30) });
  const frame = h('div', { class: 'ed-canvas-wrap' }, canvas, ring, playBtn);
  const el = h('div', { class: 'ed-preview' }, frame);

  const ctx = canvas.getContext('2d', { alpha: false });

  let destroyed = false;
  let rafId = 0;
  let lastDrawTs = -Infinity;
  let avail = { w: 0, h: 0 };    // stage content box (CSS px)
  let cssScale = 1;              // CSS px per backing px
  let lastAspect = store.project.edit.aspect;
  let drawErrorLogged = false;
  let chunkErrorLogged = false;

  // Caption chunks are cached; rebuilt only when the transcript changes.
  let chunks = null;
  let chunkRef = null;
  let chunkSig = '';

  // Pointer state.
  let gesture = null;            // { id, x0, y0, onCamera, moved, dx, dy, recorded }
  let hovering = false;
  let pendingDragPt = null;
  let dragRaf = 0;
  let hoverRaf = 0;
  let lastHoverEvent = null;

  let scrubTimer = 0;
  let ignoreScrubUntil = 0;
  let overlayIcon = '';

  /* ------------------------------------------------------------------ */
  /* Drawing                                                             */
  /* ------------------------------------------------------------------ */

  function requestDraw() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(onFrame);
  }

  // While playing the preview redraws every display frame (zoom easing is time-based,
  // so it must not be limited to the recording's frame rate), capped near 60fps.
  function onFrame(ts) {
    rafId = 0;
    if (destroyed) return;
    if (player.playing) {
      rafId = requestAnimationFrame(onFrame);
      if (ts - lastDrawTs < MIN_PLAY_FRAME_MS) return;
    }
    lastDrawTs = ts;
    draw();
  }

  /** Restarts the rAF chain so it is queued after the player's tick (fresh player.time each frame). */
  function restartLoop() {
    if (destroyed) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(onFrame);
  }

  function draw() {
    if (destroyed || !ctx) return;
    const W = canvas.width, H = canvas.height;
    if (W < 2 || H < 2) return;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawFrame(ctx, {
        project: store.project,
        time: player.time,
        main: player.main,
        camera: player.camera,
        width: W,
        height: H,
        captionChunks: chunks,
        showCaptions: true,
      });
    } catch (err) {
      if (!drawErrorLogged) {
        drawErrorLogged = true;
        console.error('[preview] drawFrame failed', err);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#1c1c1e';
      ctx.fillRect(0, 0, W, H);
    } finally {
      ctx.restore();
    }
    if (hovering || gesture?.onCamera) updateRing();
  }

  /** Letterboxes the canvas into the stage and sizes its backing store. */
  function fit() {
    if (destroyed) return;
    const out = safeOutputSize();
    const aspect = out.width / out.height;
    let w = avail.w, hgt = w / aspect;
    if (hgt > avail.h) {
      hgt = avail.h;
      w = hgt * aspect;
    }
    w = Math.floor(w);
    hgt = Math.floor(hgt);
    if (w < 2 || hgt < 2) {
      frame.style.visibility = 'hidden';
      return;
    }
    frame.style.visibility = '';
    frame.style.width = `${w}px`;
    frame.style.height = `${hgt}px`;

    const dpr = window.devicePixelRatio || 1;
    let bw = Math.round(w * dpr), bh = Math.round(hgt * dpr);
    const long = Math.max(bw, bh);
    if (long > MAX_BACKING_LONG_SIDE) {
      const k = MAX_BACKING_LONG_SIDE / long;
      bw = Math.round(bw * k);
      bh = Math.round(bh * k);
    }
    cssScale = w / bw;
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      // Resizing clears the canvas: paint synchronously so there is no blank flash.
      draw();
    } else {
      requestDraw();
    }
    if (hovering || gesture?.onCamera) updateRing();
  }

  function safeOutputSize() {
    try {
      const s = getOutputSize(store.project);
      if (s && s.width > 0 && s.height > 0) return s;
    } catch { /* fall through to 16:9 */ }
    return { width: 1920, height: 1080 };
  }

  /* ------------------------------------------------------------------ */
  /* Captions                                                            */
  /* ------------------------------------------------------------------ */

  function ensureChunks() {
    const tr = store.project.transcript;
    if (!Array.isArray(tr) || tr.length === 0) {
      chunks = null;
      chunkRef = tr;
      chunkSig = '';
      return;
    }
    const sig = transcriptSignature(tr);
    if (tr === chunkRef && sig === chunkSig) return;
    chunkRef = tr;
    chunkSig = sig;
    try {
      chunks = buildCaptionChunks(tr);
    } catch (err) {
      chunks = null;
      if (!chunkErrorLogged) {
        chunkErrorLogged = true;
        console.error('[preview] buildCaptionChunks failed', err);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Camera bubble: hover ring + drag                                    */
  /* ------------------------------------------------------------------ */

  // No camera video (failed to load) means no bubble is drawn, so nothing to grab either.
  function cameraBox() {
    const W = canvas.width, H = canvas.height;
    if (W < 2 || H < 2 || !player.camera) return null;
    try {
      return computeLayout(store.project, W, H)?.camera || null;
    } catch {
      return null;
    }
  }

  function updateRing() {
    const active = hovering || Boolean(gesture?.onCamera);
    const box = active ? cameraBox() : null;
    ring.classList.toggle('is-visible', Boolean(box));
    ring.classList.toggle('is-dragging', Boolean(box && gesture?.onCamera && gesture.moved));
    if (!box) return;
    const k = cssScale;
    const s = Math.min(canvas.width, canvas.height) / 1080;
    const radius = box.shape === 'circle' ? '50%'
      : box.shape === 'rounded' ? `${box.size * 0.22 * k}px`
      : `${6 * s * k}px`;
    ring.style.left = `${box.x * k}px`;
    ring.style.top = `${box.y * k}px`;
    ring.style.width = `${box.size * k}px`;
    ring.style.height = `${box.size * k}px`;
    ring.style.borderRadius = radius;
  }

  function toOutput(e) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }

  function hitsCamera(pt) {
    const W = canvas.width, H = canvas.height;
    if (W < 2 || H < 2 || !player.camera) return false;
    try {
      return Boolean(hitTestCamera(store.project, W, H, pt.x, pt.y));
    } catch {
      return false;
    }
  }

  function setHover(next) {
    if (hovering === next) return;
    hovering = next;
    canvas.style.cursor = next ? 'grab' : '';
    updateRing();
  }

  function onPointerDown(e) {
    if (e.button !== 0 || gesture) return;
    const pt = toOutput(e);
    const onCamera = hitsCamera(pt);
    gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, onCamera, moved: false, dx: 0, dy: 0, recorded: false };
    if (onCamera) {
      // Grab offset from the bubble's *drawn* center, so it never jumps on pick-up.
      const box = cameraBox();
      if (box) {
        gesture.dx = pt.x - (box.x + box.size / 2);
        gesture.dy = pt.y - (box.y + box.size / 2);
      }
      canvas.style.cursor = 'grabbing';
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!gesture) {
      if (e.pointerType === 'touch') return;
      lastHoverEvent = e;
      if (!hoverRaf) {
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          if (destroyed || gesture || !lastHoverEvent) return;
          setHover(hitsCamera(toOutput(lastHoverEvent)));
        });
      }
      return;
    }
    if (e.pointerId !== gesture.id) return;
    if (!gesture.moved) {
      if (Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) < DRAG_THRESHOLD) return;
      gesture.moved = true;
      if (gesture.onCamera) {
        el.classList.add('is-dragging-camera');
        updateRing();
      }
    }
    if (!gesture.onCamera) return;
    pendingDragPt = toOutput(e);
    if (!dragRaf) dragRaf = requestAnimationFrame(applyDrag);
  }

  function applyDrag() {
    dragRaf = 0;
    if (destroyed || !gesture?.onCamera || !pendingDragPt) return;
    const pt = pendingDragPt;
    pendingDragPt = null;
    const W = canvas.width, H = canvas.height;
    const cam = store.project.edit.camera;
    const minSide = Math.min(W, H);
    const s = minSide / 1080;
    // Mirror the renderer's clamp (bubble stays ≥ 16·s inside) so dragging back has no dead zone.
    const r = ((Number(cam.size) || 0.22) * minSide) / 2;
    const margin = 16 * s;
    const loX = (r + margin) / W, loY = (r + margin) / H;
    const nx = round4(clamp((pt.x - gesture.dx) / W, Math.min(loX, 0.5), Math.max(1 - loX, 0.5)));
    const ny = round4(clamp((pt.y - gesture.dy) / H, Math.min(loY, 0.5), Math.max(1 - loY, 0.5)));
    if (nx === cam.x && ny === cam.y) return;
    // One drag = one undo step, however long the user pauses mid-gesture. The first write
    // opens the step (no coalesce key, so it never merges with a previous drag); every later
    // write in the same gesture folds into it without touching history.
    store.update((p) => {
      p.edit.camera.x = nx;
      p.edit.camera.y = ny;
    }, gesture.recorded ? { history: false } : {});
    gesture.recorded = true;
  }

  function endGesture(e, cancelled) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const g = gesture;
    if (g.onCamera && pendingDragPt) applyDrag();
    gesture = null;
    pendingDragPt = null;
    if (dragRaf) cancelAnimationFrame(dragRaf);
    dragRaf = 0;
    el.classList.remove('is-dragging-camera');
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!cancelled && !g.moved) player.toggle();
    const over = !cancelled && e.pointerType !== 'touch' && hitsCamera(toOutput(e));
    hovering = !over; // force setHover to re-apply cursor + ring
    setHover(over);
  }

  const onPointerUp = (e) => endGesture(e, false);
  const onPointerCancel = (e) => endGesture(e, true);
  const onPointerLeave = () => {
    if (!gesture) {
      lastHoverEvent = null;
      setHover(false);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Play overlay                                                        */
  /* ------------------------------------------------------------------ */

  function syncOverlay() {
    el.classList.toggle('is-playing', player.playing);
    if (player.playing) return;
    const atEnd = player.time >= (store.project.edit.trim?.end ?? player.duration) - END_EPSILON;
    const name = atEnd ? 'restart' : 'play';
    if (name === overlayIcon) return;
    overlayIcon = name;
    playBtn.innerHTML = icon(name, atEnd ? 28 : 30);
    playBtn.classList.toggle('is-replay', atEnd);
    playBtn.setAttribute('aria-label', atEnd ? 'Replay' : 'Play');
  }

  function onPlayState() {
    ignoreScrubUntil = performance.now() + 200;
    clearTimeout(scrubTimer);
    el.classList.remove('is-scrubbing');
    syncOverlay();
    if (player.playing) restartLoop();
    else requestDraw();
  }

  function onTime() {
    requestDraw();
    if (player.playing) return;
    syncOverlay();
    if (performance.now() < ignoreScrubUntil) return;
    // Paused seeks (scrubbing, arrow keys): get the overlay out of the way briefly.
    el.classList.add('is-scrubbing');
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => el.classList.remove('is-scrubbing'), SCRUB_FADE_MS);
  }

  const onPlayClick = (e) => {
    e.stopPropagation();
    player.play();
  };
  const onContextMenu = (e) => e.preventDefault();
  playBtn.addEventListener('click', onPlayClick);

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('contextmenu', onContextMenu);

  const offs = [
    player.on('frame', requestDraw),
    player.on('time', onTime),
    player.on('play', onPlayState),
    player.on('pause', onPlayState),
    player.on('ended', onPlayState),
    store.onChange((project, info) => {
      // ⌘Z / ⇧⌘Z mid-drag: the rest of the camera drag opens a fresh undo step instead of
      // silently editing the restored state (which would leave it outside history).
      if (gesture && (info?.reason === 'undo' || info?.reason === 'redo')) gesture.recorded = false;
      ensureChunks();
      if (project.edit.aspect !== lastAspect) {
        lastAspect = project.edit.aspect;
        fit();
      } else {
        requestDraw();
      }
      if (hovering || gesture?.onCamera) updateRing();
      if (!player.playing) syncOverlay();
    }),
  ];

  // Size tracking: ResizeObserver on the stage box, plus DPR changes (window moved between displays).
  let ro = null;
  const onWindowResize = () => {
    avail = contentBox(el);
    fit();
  };
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r) return;
      avail = { w: r.width, h: r.height };
      fit();
    });
    ro.observe(el);
  } else {
    window.addEventListener('resize', onWindowResize);
    requestAnimationFrame(onWindowResize);
  }

  let dprQuery = null;
  const onDprChange = () => {
    watchDpr();
    fit();
  };
  function watchDpr() {
    if (dprQuery) removeMqListener(dprQuery, onDprChange);
    dprQuery = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
    if (dprQuery) addMqListener(dprQuery, onDprChange);
  }
  watchDpr();

  ensureChunks();
  syncOverlay();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    offs.forEach((off) => { try { off(); } catch { /* already removed */ } });
    ro?.disconnect();
    window.removeEventListener('resize', onWindowResize);
    if (dprQuery) removeMqListener(dprQuery, onDprChange);
    [rafId, dragRaf, hoverRaf].forEach((id) => id && cancelAnimationFrame(id));
    rafId = dragRaf = hoverRaf = 0;
    clearTimeout(scrubTimer);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('lostpointercapture', onPointerCancel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    playBtn.removeEventListener('click', onPlayClick);
    gesture = null;
    // Release the backing store right away instead of waiting for GC.
    canvas.width = 0;
    canvas.height = 0;
    el.remove();
  }

  return { el, destroy, redraw: requestDraw };
}

/* -------------------------------------------------------------------- */
/* Helpers                                                               */
/* -------------------------------------------------------------------- */

const round4 = (v) => Math.round(v * 10000) / 10000;

function contentBox(node) {
  const cs = getComputedStyle(node);
  const px = (v) => parseFloat(v) || 0;
  return {
    w: Math.max(0, node.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight)),
    h: Math.max(0, node.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)),
  };
}

/** Cheap content hash so in-place transcript edits are detected without deep compares. */
function transcriptSignature(tr) {
  let hash = 2166136261;
  const mix = (n) => { hash = Math.imul(hash ^ n, 16777619); };
  for (const seg of tr) {
    mix(Math.round((Number(seg?.start) || 0) * 1000));
    mix(Math.round((Number(seg?.end) || 0) * 1000));
    const text = String(seg?.text ?? '');
    for (let i = 0; i < text.length; i++) mix(text.charCodeAt(i));
    mix(31);
  }
  return `${tr.length}:${hash >>> 0}`;
}

function addMqListener(mq, fn) {
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
  else if (typeof mq.addListener === 'function') mq.addListener(fn);
}

function removeMqListener(mq, fn) {
  if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', fn);
  else if (typeof mq.removeListener === 'function') mq.removeListener(fn);
}
