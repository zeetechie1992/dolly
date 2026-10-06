// Output backgrounds: cached mesh gradients, solid fills and a cheap live blur of
// the recording itself. Called once per output frame, so the expensive parts
// (mesh rendering, blur) are cached.

import { getBackground } from '../lib/project.js';

const MESH_CACHE_MAX = 4;
const MESH_CACHE_MAX_PIXELS = 20_000_000; // ~80 MB of RGBA across entries
const GRAIN_TILE = 128;
const GRAIN_MAX_ALPHA = 10;               // of 255 — dithers banding without reading as texture
const BLUR_LONG_SIDE = 160;               // ≈ 1/12 of a 1080p frame; fixed so preview and export blur identically
const BLUR_SIGMA = 3;                     // px at BLUR_LONG_SIDE scale
const BLUR_MARGIN = 10;                   // ≥ 3σ overscan: the soft edge fringe of the blur stays out of the visible crop
const BOX_RADIUS = 3;                     // CPU fallback: two box passes ≈ a Gaussian of σ 2.8
const BOX_PASSES = 2;
const BLUR_UPSCALE = 4;                   // bicubic pre-upscale; the final stretch is then a cheap bilinear one
const BLUR_REUSE_SEC = 0.004;             // same video frame → reuse (paused redraws, slider drags)
const BLUR_DARKEN = 'rgba(0, 0, 0, 0.16)';
const FALLBACK_COLORS = ['#2c2c2e', '#48484a', '#1c1c1e', '#636366'];

// Blob layout mirrors the swatch CSS in project.js (painted bottom → top) so the
// picker swatch and the rendered frame match. Unit space; ellipses follow the output aspect.
const BLOBS = [
  { color: 3, x: 0.5, y: 0.96, r: 0.8 },
  { color: 1, x: 0.82, y: 0.28, r: 0.72 },
  { color: 2, x: 0.18, y: 0.2, r: 0.7 },
];
// Alpha along the radius: a soft bell rather than a linear ramp, so blobs melt together.
const FALLOFF = [[0, 1], [0.22, 0.85], [0.45, 0.52], [0.7, 0.18], [0.88, 0.04], [1, 0]];

const meshCache = new Map(); // key → { image, pixels }; Map order = LRU order
let grainTile = null;
let offscreenOK = null;
let filterOK = null;

const blur = {
  canvas: null, ctx: null, useFilter: false, w: 0, h: 0, buf: null,
  up: null, upCtx: null, upW: 0, upH: 0,
  sourceId: 0, time: NaN,
  ready: false, // canvas holds a complete blur of `sourceId`
  valid: false, // …and it is exactly the frame at `time`
};
const sourceIds = new WeakMap();
let nextSourceId = 1;

function canUseOffscreen() {
  if (offscreenOK === null) {
    try {
      offscreenOK = typeof OffscreenCanvas === 'function' && Boolean(new OffscreenCanvas(1, 1).getContext('2d'));
    } catch {
      offscreenOK = false;
    }
  }
  return offscreenOK;
}

function createCanvas(w, h) {
  if (canUseOffscreen()) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Canvas `filter` is missing in older Safari; there we blur on the CPU instead. */
function supportsCanvasFilter() {
  if (filterOK === null) {
    try {
      const g = createCanvas(1, 1).getContext('2d');
      g.filter = 'blur(2px)';
      filterOK = g.filter === 'blur(2px)';
    } catch {
      filterOK = false;
    }
  }
  return filterOK;
}

function disposeImage(image) {
  if (!image) return;
  if (typeof image.close === 'function') image.close();
  else { image.width = 0; image.height = 0; }
}

function parseHex(hex) {
  let s = String(hex || '').trim().replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Last good frame per <video>. Mid-seek, Chrome drops readyState to HAVE_METADATA and
// paints nothing, so a redraw while scrubbing would flash a placeholder; holding the
// previous frame lets the preview keep showing it until the new one decodes.
const HAS_VIDEO_FRAME = typeof VideoFrame === 'function';
const heldFrames = new WeakMap(); // video → holder
const liveHolders = new Set();
const finalizer = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((slot) => dropHeld(slot)) : null;

function dropHeld(slot) {
  const img = slot.image;
  slot.image = null;
  slot.time = NaN;
  liveHolders.delete(slot);
  if (!img) return;
  if (slot.kind === 'frame') {
    try { img.close(); } catch { /* already closed */ }
  } else {
    img.width = 0;
    img.height = 0;
  }
}

function slotFor(video) {
  let slot = heldFrames.get(video);
  if (!slot) {
    slot = { image: null, kind: null, time: NaN, w: 0, h: 0 };
    heldFrames.set(video, slot);
    finalizer?.register(video, slot); // closes the frame if the element is dropped without 'emptied'
    video.addEventListener('emptied', () => dropHeld(slot)); // src removed / reloaded
  }
  return slot;
}

/** Keeps a reference (VideoFrame: zero-copy) or, without WebCodecs, a paused-only copy of the current frame. */
function holdFrame(video, w, h) {
  const t = video.currentTime;
  const slot = slotFor(video);
  if (slot.image && slot.time === t && slot.w === w && slot.h === h) return;
  let image = null, kind = null;
  if (HAS_VIDEO_FRAME) {
    try {
      image = new VideoFrame(video);
      kind = 'frame';
    } catch {
      image = null;
    }
  }
  if (!image) {
    if (!video.paused) return; // copying every playing frame is not worth it; scrubbing happens paused
    try {
      const reuse = slot.kind === 'canvas' && slot.image && slot.w === w && slot.h === h;
      const c = reuse ? slot.image : createCanvas(w, h);
      const g = c.getContext('2d');
      if (!g) return;
      g.drawImage(video, 0, 0, w, h);
      if (reuse) {
        slot.time = t;
        return;
      }
      image = c;
      kind = 'canvas';
    } catch {
      return;
    }
  }
  dropHeld(slot);
  Object.assign(slot, { image, kind, time: t, w, h });
  liveHolders.add(slot);
}

/**
 * What to draw for a source right now, or null when there is nothing to show yet.
 * For a <video> mid-seek this is the last frame it showed (see above), so callers can
 * draw `image` unconditionally. `w`/`h` are the image's intrinsic pixel size; `time` is the
 * media time of that frame (NaN for non-video sources).
 * @returns {{ image: CanvasImageSource, w: number, h: number, time: number } | null}
 */
export function resolveSource(src) {
  if (!src) return null;
  if ('videoWidth' in src) {
    const w = src.videoWidth, h = src.videoHeight;
    const hasSize = w > 0 && h > 0;
    if (hasSize && src.readyState >= 2 && !src.seeking) {
      holdFrame(src, w, h);
      return { image: src, w, h, time: src.currentTime };
    }
    const held = heldFrames.get(src);
    if (held?.image) return { image: held.image, w: held.w, h: held.h, time: held.time };
    // A seek the browser could serve without dropping readyState still paints the current frame.
    return hasSize && src.readyState >= 2 ? { image: src, w, h, time: src.currentTime } : null;
  }
  const w = src.naturalWidth || src.displayWidth || src.width;
  const h = src.naturalHeight || src.displayHeight || src.height;
  return w > 0 && h > 0 ? { image: src, w, h, time: NaN } : null;
}

/** Deterministic noise tile (same grain in preview and export). */
function getGrainTile() {
  if (grainTile) return grainTile;
  const tile = createCanvas(GRAIN_TILE, GRAIN_TILE);
  const g = tile.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(GRAIN_TILE, GRAIN_TILE);
  const d = img.data;
  let seed = 0x2f6b9a1d;
  const rand = () => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < d.length; i += 4) {
    // Half lighten, half darken → no net shift in brightness.
    const v = rand() < 0.5 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = Math.round(rand() * GRAIN_MAX_ALPHA);
  }
  g.putImageData(img, 0, 0);
  grainTile = tile;
  return tile;
}

function renderMesh(bg, w, h) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const colors = Array.isArray(bg.colors) && bg.colors.length ? bg.colors : FALLBACK_COLORS;
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.scale(w, h);
  for (const blob of BLOBS) {
    const [r, g, b] = parseHex(colors[Math.min(blob.color, colors.length - 1)]);
    const grad = ctx.createRadialGradient(blob.x, blob.y, 0, blob.x, blob.y, blob.r);
    for (const [stop, a] of FALLOFF) grad.addColorStop(stop, `rgba(${r},${g},${b},${a})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1, 1);
  }
  ctx.restore();

  const tile = getGrainTile();
  const pattern = tile && ctx.createPattern(tile, 'repeat');
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
  }
  // An ImageBitmap is immutable and GPU-friendly, and can be freed explicitly on eviction.
  if (typeof canvas.transferToImageBitmap === 'function') {
    try { return canvas.transferToImageBitmap(); } catch { /* fall through to the canvas */ }
  }
  return canvas;
}

function getMesh(bg, w, h) {
  const colors = Array.isArray(bg.colors) ? bg.colors.join(',') : '';
  const key = `${bg.id}|${colors}|${w}x${h}`;
  const hit = meshCache.get(key);
  if (hit) {
    meshCache.delete(key); // refresh LRU position
    meshCache.set(key, hit);
    return hit.image;
  }
  const image = renderMesh(bg, w, h);
  if (!image) return null;
  meshCache.set(key, { image, pixels: w * h });
  let pixels = 0;
  for (const entry of meshCache.values()) pixels += entry.pixels;
  while (meshCache.size > 1 && (meshCache.size > MESH_CACHE_MAX || pixels > MESH_CACHE_MAX_PIXELS)) {
    const [oldKey, old] = meshCache.entries().next().value;
    meshCache.delete(oldKey);
    pixels -= old.pixels;
    disposeImage(old.image);
  }
  return image;
}

function sourceId(src) {
  let id = sourceIds.get(src);
  if (!id) {
    id = nextSourceId++;
    sourceIds.set(src, id);
  }
  return id;
}

/** Separable running-sum box blur (RGB; alpha forced opaque). */
function blurLine(src, dst, w, h, r, horizontal) {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const step = horizontal ? 4 : w * 4;
  const lineStep = horizontal ? w * 4 : 4;
  const last = len - 1;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let sr = 0, sg = 0, sb = 0;
    for (let k = -r; k <= r; k++) {
      const i = base + Math.min(last, Math.max(0, k)) * step;
      sr += src[i]; sg += src[i + 1]; sb += src[i + 2];
    }
    for (let p = 0; p < len; p++) {
      const o = base + p * step;
      dst[o] = sr * inv;
      dst[o + 1] = sg * inv;
      dst[o + 2] = sb * inv;
      dst[o + 3] = 255;
      const a = base + Math.min(last, p + r + 1) * step;
      const b = base + Math.max(0, p - r) * step;
      sr += src[a] - src[b];
      sg += src[a + 1] - src[b + 1];
      sb += src[a + 2] - src[b + 2];
    }
  }
}

function ensureBlurCanvas(w, h) {
  if (blur.ctx && blur.w === w && blur.h === h) return true;
  if (!blur.canvas) {
    blur.useFilter = supportsCanvasFilter();
    blur.canvas = createCanvas(w, h);
    // The filter path stays on the GPU; only the CPU fallback reads pixels back every frame.
    blur.ctx = blur.canvas.getContext('2d', blur.useFilter ? {} : { willReadFrequently: true });
  } else {
    blur.canvas.width = w;
    blur.canvas.height = h;
  }
  blur.w = w;
  blur.h = h;
  blur.buf = blur.useFilter ? null : new Uint8ClampedArray(w * h * 4);
  blur.ready = false;
  blur.valid = false;
  return Boolean(blur.ctx);
}

/** Bicubic upscale of the visible part of the blur into a mid-size canvas (redone only when the blur changes). */
function upscaleBlur(m, tw, th) {
  const uw = tw * BLUR_UPSCALE, uh = th * BLUR_UPSCALE;
  if (!blur.up) {
    blur.up = createCanvas(uw, uh);
    blur.upCtx = blur.up.getContext('2d', { alpha: false });
  } else if (blur.upW !== uw || blur.upH !== uh) {
    blur.up.width = uw;
    blur.up.height = uh;
  }
  blur.upW = uw;
  blur.upH = uh;
  const u = blur.upCtx;
  if (!u) return false;
  u.imageSmoothingEnabled = true;
  u.imageSmoothingQuality = 'high';
  u.drawImage(blur.canvas, m, m, tw, th, 0, 0, uw, uh);
  return true;
}

/** Cover-fits `src` into the small blur canvas and blurs it in place. Throws on decode/readback errors. */
function renderBlur(src) {
  const { ctx: b, w, h } = blur;
  const k = Math.max(w / src.w, h / src.h);
  const dw = src.w * k, dh = src.h * k;
  const dx = (w - dw) / 2, dy = (h - dh) / 2;
  b.imageSmoothingEnabled = true;
  b.imageSmoothingQuality = 'high';
  if (blur.useFilter) {
    b.clearRect(0, 0, w, h);
    b.filter = `blur(${BLUR_SIGMA}px)`;
    try {
      b.drawImage(src.image, dx, dy, dw, dh);
    } finally {
      b.filter = 'none';
    }
    return;
  }
  b.drawImage(src.image, dx, dy, dw, dh);
  const img = b.getImageData(0, 0, w, h);
  for (let i = 0; i < BOX_PASSES; i++) {
    blurLine(img.data, blur.buf, w, h, BOX_RADIUS, true);
    blurLine(blur.buf, img.data, w, h, BOX_RADIUS, false);
  }
  b.putImageData(img, 0, 0);
}

/** Draws the blurred recording; false when there is no frame to blur. */
function drawBlur(ctx, main, W, H) {
  const src = resolveSource(main);
  if (!src) return false;
  const tw = W >= H ? BLUR_LONG_SIDE : Math.max(8, Math.round((BLUR_LONG_SIDE * W) / H));
  const th = W >= H ? Math.max(8, Math.round((BLUR_LONG_SIDE * H) / W)) : BLUR_LONG_SIDE;
  const m = BLUR_MARGIN;
  if (!ensureBlurCanvas(tw + 2 * m, th + 2 * m)) return false;

  const id = sourceId(main);
  const t = src.time;
  // Same element, same media time → same frame (paused redraws, slider drags, mid-seek).
  const reuse = blur.ready && blur.valid && blur.sourceId === id && Math.abs(t - blur.time) < BLUR_REUSE_SEC;
  if (!reuse || blur.upW !== tw * BLUR_UPSCALE || blur.upH !== th * BLUR_UPSCALE) {
    try {
      renderBlur(src);
      if (!upscaleBlur(m, tw, th)) throw new Error('no 2d context');
    } catch {
      blur.ready = false;
      blur.valid = false;
      return false;
    }
    blur.ready = true;
    blur.valid = Number.isFinite(t);
    blur.sourceId = id;
    blur.time = t;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(blur.up, 0, 0, blur.upW, blur.upH, 0, 0, W, H);
  ctx.fillStyle = BLUR_DARKEN;
  ctx.fillRect(0, 0, W, H);
  return true;
}

/**
 * Paints the output background over the whole [0, width] × [0, height] area.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ background: object|string, width: number, height: number, main?: HTMLVideoElement|null }} opts
 *   background — a BACKGROUNDS entry (an id string is accepted too); main is used by 'blur'.
 */
export function drawBackground(ctx, { background, width, height, main = null } = {}) {
  if (!ctx) return;
  const W = Number.isFinite(width) && width > 0 ? width : ctx.canvas?.width || 1;
  const H = Number.isFinite(height) && height > 0 ? height : ctx.canvas?.height || 1;
  let bg = typeof background === 'string' ? getBackground(background) : background || getBackground();

  ctx.save();
  try {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = 'rgba(0, 0, 0, 0)';
    ctx.shadowBlur = 0;

    if (bg.kind === 'blur') {
      if (drawBlur(ctx, main, W, H)) return;
      bg = getBackground('graphite'); // no frame yet: calm neutral stand-in
    }
    const colors = Array.isArray(bg.colors) ? bg.colors : [];
    if (bg.kind === 'solid' || colors.length === 1) {
      ctx.fillStyle = colors[0] || '#000000';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const mesh = getMesh(bg, Math.max(1, Math.round(W)), Math.max(1, Math.round(H)));
    if (mesh) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(mesh, 0, 0, W, H);
    } else {
      ctx.fillStyle = colors[0] || FALLBACK_COLORS[0];
      ctx.fillRect(0, 0, W, H);
    }
  } finally {
    ctx.restore();
  }
}

/** Frees cached mesh images, held video frames and the blur buffers (e.g. when leaving the editor). */
export function clearBackgroundCache() {
  for (const slot of [...liveHolders]) dropHeld(slot);
  for (const entry of meshCache.values()) disposeImage(entry.image);
  meshCache.clear();
  for (const c of [blur.canvas, blur.up]) {
    if (c) { c.width = 0; c.height = 0; }
  }
  Object.assign(blur, {
    canvas: null, ctx: null, useFilter: false, w: 0, h: 0, buf: null,
    up: null, upCtx: null, upW: 0, upH: 0, sourceId: 0, time: NaN, ready: false, valid: false,
  });
}
