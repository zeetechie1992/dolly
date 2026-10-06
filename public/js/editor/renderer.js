// Compositor: draws one finished output frame — background, shadowed rounded "window"
// with the (zoomed) recording, optional macOS title bar, camera bubble, captions.
// Shared by the live preview (≤ 2400px) and the exporter (≤ 4K), so it stays allocation-light.

import { clamp } from '../lib/util.js';
import { getAspect, getBackground } from '../lib/project.js';
import { drawBackground, resolveSource } from './backgrounds.js';
import { zoomStateAt } from './zoom.js';
import { drawCaptions } from './captions.js';

const PLACEHOLDER_TOP = '#2c2c2e';
const PLACEHOLDER_BOTTOM = '#1c1c1e';
const CHROME = {
  light: { fill: '#f6f6f6', hairline: 'rgba(0, 0, 0, 0.1)', outline: 'rgba(0, 0, 0, 0.1)' },
  dark: { fill: '#2a2a2c', hairline: 'rgba(0, 0, 0, 0.6)', outline: 'rgba(255, 255, 255, 0.12)' },
};
const TRAFFIC_LIGHTS = [
  ['#ff5f57', '#e0443e'],
  ['#febc2e', '#dea123'],
  ['#28c840', '#1aab29'],
];
const SHAPES = new Set(['circle', 'rounded', 'square']);
let captionErrorLogged = false;

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// 'high' is mipmapped (cheap, alias-free) when downscaling but bicubic when upscaling, and
// bicubic under a rounded clip is pathologically slow in Chrome (≈13 ms at 1080p, ≈50 ms at 4K).
// Upscaled pixels are soft either way, so bilinear costs nothing visible there.
const smoothingFor = (srcSpan, dstSpan) => (dstSpan > srcSpan * 1.001 ? 'medium' : 'high');

/** Rounded-rect subpath; uses native roundRect when available. */
function roundRectPath(ctx, x, y, w, h, r) {
  if (!(w > 0 && h > 0)) return;
  const rr = Math.max(0, Math.min(num(r, 0), w / 2, h / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function cameraRadius(shape, size, s) {
  if (shape === 'circle') return size / 2;
  if (shape === 'rounded') return size * 0.22;
  return Math.min(6 * s, size / 2);
}

/** Largest rect with `aspect` (w/h) inside a w×h source, centered (cover crop). */
function coverCrop(w, h, aspect) {
  if (!(aspect > 0)) return { x: 0, y: 0, w, h };
  if (w / h > aspect) {
    const cw = h * aspect;
    return { x: (w - cw) / 2, y: 0, w: cw, h };
  }
  const ch = w / aspect;
  return { x: 0, y: (h - ch) / 2, w, h: ch };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Output pixel size for the project's aspect, scaled down (never up) to fit `maxLongSide`.
 * @returns {{ width: number, height: number }} even integers
 */
export function getOutputSize(project, maxLongSide = Infinity) {
  const aspect = getAspect(project?.edit?.aspect);
  let w = aspect.width, h = aspect.height;
  const limit = Number.isFinite(maxLongSide) && maxLongSide > 0 ? maxLongSide : Infinity;
  const long = Math.max(w, h);
  if (long > limit) {
    const k = limit / long;
    w *= k;
    h *= k;
  }
  let width = even(w), height = even(h);
  if (width > limit && width > 2) width -= 2;
  if (height > limit && height > 2) height -= 2;
  return { width, height };
}

function cameraLayout(project, W, H, s) {
  const cam = project?.edit?.camera;
  if (!cam || !cam.visible || !project?.source?.hasCamera || project.mode === 'cam') return null;
  const minSide = Math.min(W, H);
  const margin = 16 * s;
  const size = Math.max(2, Math.min(clamp(num(cam.size, 0.22), 0.02, 1) * minSide, minSide - 2 * margin));
  const x = clamp(num(cam.x, 0.86) * W - size / 2, margin, Math.max(margin, W - margin - size));
  const y = clamp(num(cam.y, 0.8) * H - size / 2, margin, Math.max(margin, H - margin - size));
  return { x, y, size, shape: SHAPES.has(cam.shape) ? cam.shape : 'circle' };
}

/**
 * Geometry of every element of the output frame.
 * @returns {{ width, height, s, frame: {x,y,w,h,radius}, content: {x,y,w,h}, chrome: {x,y,w,h}|null,
 *            camera: {x,y,size,shape}|null }}
 */
export function computeLayout(project, width, height) {
  const W = Math.max(1, num(width, 1920));
  const H = Math.max(1, num(height, 1080));
  const e = project?.edit || {};
  const minSide = Math.min(W, H);
  const s = minSide / 1080;
  const srcW = project?.source?.width > 0 ? project.source.width : 1920;
  const srcH = project?.source?.height > 0 ? project.source.height : 1080;
  const aspect = srcW / srcH;

  let frame, content, chrome = null;
  if (e.fit === 'fill') {
    frame = { x: 0, y: 0, w: W, h: H, radius: 0 };
    content = { x: 0, y: 0, w: W, h: H };
  } else {
    const pad = clamp(num(e.padding, 0.08), 0, 0.2) * minSide;
    const bar = e.windowChrome === 'light' || e.windowChrome === 'dark' ? Math.round(30 * s) : 0;
    const availW = Math.max(1, W - 2 * pad);
    const availH = Math.max(1, H - 2 * pad - bar);
    const cw = Math.max(1, Math.round(Math.min(availW, availH * aspect)));
    const ch = Math.max(1, Math.round(cw / aspect));
    const fh = ch + bar;
    // Whole-pixel edges keep the recording crisp.
    const fx = Math.round((W - cw) / 2);
    const fy = Math.round((H - fh) / 2);
    frame = { x: fx, y: fy, w: cw, h: fh, radius: clamp(num(e.radius, 18) * s, 0, Math.min(cw, fh) / 2) };
    content = { x: fx, y: fy + bar, w: cw, h: ch };
    if (bar > 0) chrome = { x: fx, y: fy, w: cw, h: bar };
  }
  return { width: W, height: H, s, frame, content, chrome, camera: cameraLayout(project, W, H, s) };
}

function resetState(ctx) {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  if ('filter' in ctx) ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
}

function drawFrameShadow(ctx, L, strength) {
  const k = clamp(num(strength, 0), 0, 1);
  if (k < 0.001) return;
  const { frame, s } = L;
  // Inset by 1px so the casting shape is fully hidden under the content (no dark AA fringe).
  const inset = Math.min(1, frame.w / 4, frame.h / 4);
  ctx.save();
  ctx.shadowColor = `rgba(0, 0, 0, ${(0.35 * k + 0.05).toFixed(3)})`;
  ctx.shadowBlur = 40 * s * k;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 18 * s * k;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  roundRectPath(ctx, frame.x + inset, frame.y + inset, frame.w - 2 * inset, frame.h - 2 * inset, Math.max(0, frame.radius - inset));
  ctx.fill();
  ctx.restore();
}

function drawPlaceholder(ctx, r) {
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  g.addColorStop(0, PLACEHOLDER_TOP);
  g.addColorStop(1, PLACEHOLDER_BOTTOM);
  ctx.fillStyle = g;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

/** Draws the main video (`src` from resolveSource) into `content` with the zoom crop applied. False if it could not. */
function drawMainVideo(ctx, L, project, time, src) {
  const { content } = L;
  const e = project.edit || {};
  // Base crop: the whole source in fit mode (same aspect), a cover crop in fill mode.
  const base = coverCrop(src.w, src.h, content.w / content.h);
  const z = zoomStateAt(e.zooms, time);
  let sx = base.x, sy = base.y, sw = base.w, sh = base.h;
  if (z.scale > 1.0001) {
    sw = base.w / z.scale;
    sh = base.h / z.scale;
    sx = clamp(z.x * src.w - sw / 2, base.x, base.x + base.w - sw);
    sy = clamp(z.y * src.h - sh / 2, base.y, base.y + base.h - sh);
  }
  ctx.save();
  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = smoothingFor(sw, content.w);
    if (project.mode === 'cam' && e.camera?.mirror) {
      ctx.translate(content.x * 2 + content.w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(src.image, sx, sy, sw, sh, content.x, content.y, content.w, content.h);
    return true;
  } catch {
    return false; // e.g. a decoder hiccup in Firefox (NS_ERROR_NOT_AVAILABLE)
  } finally {
    ctx.restore();
  }
}

function drawChrome(ctx, L, variant) {
  const { chrome: r, frame, s } = L;
  const look = CHROME[variant] || CHROME.light;
  ctx.fillStyle = look.fill;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const hair = Math.max(1, Math.round(s));
  ctx.fillStyle = look.hairline;
  ctx.fillRect(r.x, r.y + r.h - hair, r.w, hair);

  const dot = Math.max(1.5, 6 * s);
  const gap = Math.max(dot * 2 + 2, 20 * s);
  const cy = r.y + r.h / 2;
  let cx = r.x + Math.max(dot + 4, 18 * s);
  ctx.lineWidth = Math.max(0.5, 0.6 * s);
  for (const [fill, ring] of TRAFFIC_LIGHTS) {
    if (cx + dot > r.x + r.w) break;
    ctx.beginPath();
    ctx.arc(cx, cy, dot, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = ring;
    ctx.stroke();
    cx += gap;
  }

  // Window outline (inner half of a 2px stroke, the clip hides the outer half), like a macOS window edge.
  ctx.beginPath();
  roundRectPath(ctx, frame.x, frame.y, frame.w, frame.h, frame.radius);
  ctx.lineWidth = hair * 2;
  ctx.strokeStyle = look.outline;
  ctx.stroke();
}

function drawWindow(ctx, L, project, time, main) {
  const { frame, content, chrome } = L;
  ctx.save();
  try {
    if (frame.radius > 0.25 || chrome) {
      ctx.beginPath();
      roundRectPath(ctx, frame.x, frame.y, frame.w, frame.h, frame.radius);
      ctx.clip();
    }
    const src = resolveSource(main);
    if (!src || !drawMainVideo(ctx, L, project, time, src)) drawPlaceholder(ctx, content);
    if (chrome) drawChrome(ctx, L, project.edit?.windowChrome);
  } finally {
    ctx.restore();
  }
}

function bubblePath(ctx, shape, x, y, size, r) {
  if (shape === 'circle') ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  else roundRectPath(ctx, x, y, size, size, r);
}

function drawCameraBubble(ctx, L, video, cfg) {
  const { camera: c, s } = L;
  const r = cameraRadius(c.shape, c.size, s);
  const border = cfg?.border !== false ? Math.max(1, 3 * s) : 0;
  const src = resolveSource(video);

  // Base: white ring (or dark fill) casting a soft shadow.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = 28 * s;
  ctx.shadowOffsetY = 10 * s;
  ctx.fillStyle = border ? '#ffffff' : PLACEHOLDER_BOTTOM;
  ctx.beginPath();
  // Without a ring, inset the caster so no dark fringe peeks around the video edge.
  const inset = border ? 0 : Math.min(1, c.size / 4);
  bubblePath(ctx, c.shape, c.x + inset, c.y + inset, c.size - 2 * inset, Math.max(0, r - inset));
  ctx.fill();
  ctx.restore();

  const ix = c.x + border, iy = c.y + border;
  const inner = Math.max(1, c.size - 2 * border);
  ctx.save();
  try {
    ctx.beginPath();
    bubblePath(ctx, c.shape, ix, iy, inner, Math.max(0, r - border));
    ctx.clip();
    let drawn = false;
    if (src) {
      const side = Math.min(src.w, src.h);
      const sx = (src.w - side) / 2, sy = (src.h - side) / 2;
      ctx.save();
      try {
        if (cfg?.mirror) {
          ctx.translate(ix * 2 + inner, 0);
          ctx.scale(-1, 1);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = smoothingFor(side, inner);
        ctx.drawImage(src.image, sx, sy, side, side, ix, iy, inner, inner);
        drawn = true;
      } catch {
        drawn = false;
      } finally {
        ctx.restore();
      }
    }
    if (!drawn) drawPlaceholder(ctx, { x: ix, y: iy, w: inner, h: inner });
  } finally {
    ctx.restore();
  }
}

/**
 * Draws one complete output frame for `time` (source seconds). `main` / `camera` must
 * already show that time. Never throws for videos without a decoded frame.
 * @returns {object|null} the Layout used (handy for hit testing / overlays)
 */
export function drawFrame(ctx, { project, time = 0, main = null, camera = null, width, height, captionChunks = null, showCaptions = true } = {}) {
  if (!ctx || !project) return null;
  const W = num(width, ctx.canvas?.width || 1920);
  const H = num(height, ctx.canvas?.height || 1080);
  const L = computeLayout(project, W, H);
  const e = project.edit || {};
  const t = num(time, 0);

  ctx.save();
  try {
    resetState(ctx);
    // In fill mode the recording covers everything, so the background would be wasted work.
    if (e.fit !== 'fill') {
      drawBackground(ctx, { background: getBackground(e.background), width: L.width, height: L.height, main });
      drawFrameShadow(ctx, L, num(e.shadow, 0.6));
    }
    drawWindow(ctx, L, project, t, main);
    if (L.camera && camera) drawCameraBubble(ctx, L, camera, e.camera);
    if (showCaptions && captionChunks && e.captions?.enabled) {
      ctx.save();
      try {
        drawCaptions(ctx, { chunks: captionChunks, time: t, captions: e.captions, layout: L });
      } catch (err) {
        // A caption bug must not blank the preview or abort a long export; report it once.
        if (!captionErrorLogged) {
          captionErrorLogged = true;
          console.error('[renderer] drawCaptions failed', err);
        }
      } finally {
        ctx.restore();
      }
    }
  } finally {
    ctx.restore();
  }
  return L;
}

/** True when output-pixel point (x, y) lies inside the camera bubble's shape. */
export function hitTestCamera(project, width, height, x, y) {
  const L = computeLayout(project, width, height);
  const c = L.camera;
  if (!c || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const lx = x - c.x, ly = y - c.y;
  if (lx < 0 || ly < 0 || lx > c.size || ly > c.size) return false;
  // Distance to the shape's inner "core" rect works for circle, rounded and square alike.
  const r = cameraRadius(c.shape, c.size, L.s);
  const dx = lx - clamp(lx, r, c.size - r);
  const dy = ly - clamp(ly, r, c.size - r);
  return dx * dx + dy * dy <= r * r;
}
