// Captions: splits a transcript into short readable chunks, draws them onto the
// output canvas in one of six styles (shared by the live preview and the exporter),
// renders style-picker previews, and exports SRT / WebVTT.
// The pure helpers never touch the DOM, so this module also loads in a bare JS shell.

import { clamp, lerp, easeOutCubic } from '../lib/util.js';
import { CAPTION_STYLE_IDS } from '../lib/project.js';

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const STYLE_META = {
  minimal: { name: 'Minimal', description: 'Small, clean, no background' },
  clean: { name: 'Clean', description: 'Soft white card' },
  bold: { name: 'Bold', description: 'Punchy, word by word' },
  karaoke: { name: 'Karaoke', description: 'Words light up as you speak' },
  subtitle: { name: 'Subtitle', description: 'Classic cinema bar' },
  glass: { name: 'Glass', description: 'Frosted dark pill' },
};

/** Style picker entries; ids mirror CAPTION_STYLE_IDS (same order, 'minimal' first). */
export const CAPTION_STYLES = Object.freeze(CAPTION_STYLE_IDS.map((id) => Object.freeze({
  id,
  name: STYLE_META[id]?.name || id.charAt(0).toUpperCase() + id.slice(1),
  description: STYLE_META[id]?.description || '',
})));

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, "Helvetica Neue", system-ui, sans-serif';
const SIZE_SCALE = { S: 0.8, M: 1, L: 1.25 };
const ENTER_SEC = 0.15;
const POP_SEC = 0.18;
const SLIDE_SEC = 0.14;
const ACCENT = '#7d7aff';
const YELLOW = '#ffd60a';

// Sizes are px at a 1080px output short side (scaled by layout.s). padX/padY/stroke are fractions of the font size.
const STYLES = {
  minimal: { size: 40, weight: 600, lineHeight: 1.2, padX: 0, padY: 0 },
  clean: { size: 36, weight: 600, lineHeight: 1.25, padX: 0.64, padY: 0.38 },
  bold: { size: 64, weight: 900, lineHeight: 1.08, padX: 0, padY: 0, upper: true, stroke: 0.2 },
  karaoke: { size: 44, weight: 700, lineHeight: 1.26, padX: 0.62, padY: 0.36 },
  subtitle: { size: 38, weight: 500, lineHeight: 1.34, padX: 0.42, padY: 0 },
  glass: { size: 40, weight: 600, lineHeight: 1.22, padX: 0.8, padY: 0.42 },
};
const hasStyle = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(STYLES, id);

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

const SENTENCE_END = /[.!?…]["'’”)\]]*$/;
const CLAUSE_END = /[,;:—–]["'’”)\]]*$/;
// Ending a line on one of these reads badly ("…show you the / new dashboard").
const WEAK_TAIL = new Set([
  'a', 'an', 'the', 'to', 'of', 'and', 'or', 'but', 'nor', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'into',
  'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be',
  'i', 'we', 'they', 'if', 'so', 'than', "i'm", "we're", "you're", "it's", "let's",
]);

// Starting a line on one of these reads naturally ("…a CSV file / with every metric").
const PHRASE_START = new Set([
  'with', 'and', 'but', 'or', 'so', 'because', 'to', 'for', 'in', 'on', 'at', 'from', 'by', 'which', 'that', 'when',
  'where', 'while', 'if', 'then', 'using', 'without', 'into', 'after', 'before', 'until', 'unless', 'since', 'though',
]);

const cleanText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const bareWord = (word) => word.toLowerCase().replace(/^["'“‘(]+|["'’”),.!?;:]+$/g, '').replace(/’/g, "'");

/**
 * Splits transcript segments into short caption lines with per-word timings.
 * Word times are spread across each segment proportionally to character length (+1 per word).
 * Chunks are sorted and never overlap.
 * @param {Array<{id?:string,start:number,end:number,text:string}>} transcript
 * @param {{ maxWords?: number, maxChars?: number }} [opts]
 * @returns {Array<{start:number,end:number,text:string,words:Array<{text:string,start:number,end:number}>,segmentId:string|null}>}
 */
export function buildCaptionChunks(transcript, { maxWords = 7, maxChars = 42 } = {}) {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];
  const wordLimit = Math.max(1, Math.floor(Number(maxWords)) || 7);
  const charLimit = Math.max(8, Math.floor(Number(maxChars)) || 42);

  const segs = transcript
    .map((s, i) => ({ id: s?.id ?? null, start: Number(s?.start), end: Number(s?.end), text: cleanText(s?.text), i }))
    .filter((s) => s.text && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start || a.i - b.i);

  const chunks = [];
  let cursor = 0;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    const words = seg.text.split(' ');
    const nextStart = k + 1 < segs.length ? segs[k + 1].start : Infinity;
    const start = Math.max(seg.start, cursor, 0);
    let end = Number.isFinite(seg.end) && seg.end > start ? seg.end : start + clamp(words.length * 0.32, 0.8, 6);
    // Very short segments would flash by; give them a readable minimum…
    end = Math.max(end, start + clamp(words.length * 0.12, 0.4, 1.2));
    // …but never run into the next segment (unless the data itself overlaps).
    if (nextStart > start + 0.25 && end > nextStart) end = nextStart;
    cursor = end;

    // Word boundaries: cumulative character weight (+1 per word for the gap).
    const times = new Array(words.length + 1);
    const total = words.reduce((sum, w) => sum + w.length + 1, 0);
    let acc = 0;
    times[0] = start;
    for (let w = 0; w < words.length; w++) {
      acc += words[w].length + 1;
      times[w + 1] = start + ((end - start) * acc) / total;
    }
    times[words.length] = end;

    for (const [from, to] of splitIntoLines(words, wordLimit, charLimit)) {
      const lineWords = [];
      for (let w = from; w < to; w++) lineWords.push({ text: words[w], start: times[w], end: times[w + 1] });
      chunks.push({ start: times[from], end: times[to], text: words.slice(from, to).join(' '), words: lineWords, segmentId: seg.id });
    }
  }
  return chunks;
}

/** Optimal line breaking (small DP): respects the limits, prefers punctuation, avoids orphans. */
function splitIntoLines(words, maxWords, maxChars) {
  const n = words.length;
  const totalChars = words.reduce((sum, w) => sum + w.length, 0) + n - 1;
  if (n <= maxWords && totalChars <= maxChars) return [[0, n]];
  const cost = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(0);
  cost[0] = 0;
  for (let j = 1; j <= n; j++) {
    let chars = -1;
    for (let i = j - 1; i >= 0 && j - i <= maxWords; i--) {
      chars += words[i].length + 1;
      if (chars > maxChars && j - i > 1) break; // a single over-long word may stand alone
      const c = cost[i] + lineCost(words, i, j, n, chars, maxWords, maxChars);
      if (c < cost[j]) { cost[j] = c; from[j] = i; }
    }
  }
  const ranges = [];
  for (let j = n; j > 0; j = from[j]) ranges.unshift([from[j], j]);
  return ranges;
}

function lineCost(words, i, j, n, chars, maxWords, maxChars) {
  const count = j - i;
  const fill = Math.min(1, Math.max(count / maxWords, chars / maxChars));
  let c = 3 + 3 * (1 - fill) ** 2; // fewer, fuller lines
  if (j < n) {
    const last = words[j - 1];
    if (SENTENCE_END.test(last)) c += 0;
    else if (CLAUSE_END.test(last)) c += 1.5;
    else c += WEAK_TAIL.has(bareWord(last)) ? 8 : 5;
    if (PHRASE_START.has(bareWord(words[j])) && !WEAK_TAIL.has(bareWord(last))) c -= 1.5;
  }
  if (n > 1 && count === 1) c += 4;
  else if (n > 2 && count === 2) c += 1;
  return c;
}

/** Index of the chunk showing at `time`, or -1. Chunks are sorted and non-overlapping. */
function chunkIndexAt(chunks, time) {
  let lo = 0, hi = chunks.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].start <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 && time < chunks[found].end ? found : -1;
}

/** The chunk on screen at `time` (source seconds), or null. */
export function activeChunkAt(chunks, time) {
  const t = Number(time);
  if (!Array.isArray(chunks) || chunks.length === 0 || !Number.isFinite(t)) return null;
  const i = chunkIndexAt(chunks, t);
  return i >= 0 ? chunks[i] : null;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

const wordCache = new WeakMap();   // chunk -> words (for chunks built elsewhere without words)
const groupCache = new WeakMap();  // chunk -> bold word groups
const layoutCache = new WeakMap(); // words array -> Map(key -> text layout)

function wordsOf(chunk) {
  if (Array.isArray(chunk.words) && chunk.words.length && chunk.words.every((w) => w && typeof w.text === 'string')) return chunk.words;
  let words = wordCache.get(chunk);
  if (words) return words;
  const parts = cleanText(chunk.text).split(' ').filter(Boolean);
  const total = parts.reduce((sum, w) => sum + w.length + 1, 0) || 1;
  const start = Number(chunk.start) || 0;
  const span = Math.max(0, (Number(chunk.end) || start) - start);
  let acc = 0;
  words = parts.map((text) => {
    const ws = start + (span * acc) / total;
    acc += text.length + 1;
    return { text, start: ws, end: start + (span * acc) / total };
  });
  wordCache.set(chunk, words);
  return words;
}

/** Bold shows 1–3 words at a time; groups break after punctuation and stay short. */
function boldGroups(chunk, words) {
  let groups = groupCache.get(chunk);
  if (groups) return groups;
  groups = [];
  let cur = [];
  let chars = 0;
  const flush = () => {
    if (cur.length) groups.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
    chars = 0;
  };
  for (const w of words) {
    if (cur.length && (cur.length >= 3 || chars + 1 + w.text.length > 16)) flush();
    cur.push(w);
    chars += (cur.length > 1 ? 1 : 0) + w.text.length;
    if (SENTENCE_END.test(w.text) || CLAUSE_END.test(w.text)) flush();
  }
  flush();
  // Fold a lone trailing word into a short previous group.
  if (groups.length > 1) {
    const last = groups[groups.length - 1], prev = groups[groups.length - 2];
    const prevText = prev.words[prev.words.length - 1].text;
    if (last.words.length === 1 && prev.words.length < 3 && !SENTENCE_END.test(prevText) && !CLAUSE_END.test(prevText)) {
      prev.words = prev.words.concat(last.words);
      prev.end = last.end;
      groups.pop();
    }
  }
  groupCache.set(chunk, groups);
  return groups;
}

function groupAt(groups, t) {
  let pick = groups[0];
  for (const g of groups) {
    if (g.start <= t) pick = g;
    else break;
  }
  return pick;
}

function activeWordIndex(words, t) {
  for (let i = 0; i < words.length; i++) if (t >= words[i].start && t < words[i].end) return i;
  if (words.length && t >= words[words.length - 1].end) return words.length - 1;
  return words.length && t < words[0].start ? -1 : 0;
}

const fontString = (weight, px) => `${weight} ${Math.max(1, px).toFixed(1)}px ${FONT_STACK}`;

/** Measures and wraps `words` into at most 2 balanced lines, shrinking the font if needed. Cached. */
function layoutWords(ctx, words, def, fontSize, maxWidth) {
  let cache = layoutCache.get(words);
  if (!cache) { cache = new Map(); layoutCache.set(words, cache); }
  const key = `${def.weight}|${def.upper ? 1 : 0}|${fontSize.toFixed(2)}|${Math.round(maxWidth)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const texts = words.map((w) => (def.upper ? w.text.toUpperCase() : w.text));
  const minSize = fontSize * 0.6;
  let size = fontSize, font, widths, space, lines;
  for (;;) {
    font = fontString(def.weight, size);
    ctx.font = font;
    space = ctx.measureText(' ').width;
    widths = texts.map((text) => ctx.measureText(text).width);
    lines = wrapBalanced(texts, widths, space, maxWidth);
    if (lines || size <= minSize) break;
    size = Math.max(minSize, size * 0.92);
  }
  if (!lines) lines = wrapGreedy(widths, space, maxWidth);

  const offsets = new Array(texts.length).fill(0);
  let maxLineWidth = 0;
  const outLines = lines.map(([from, to]) => {
    let x = 0;
    for (let k = from; k < to; k++) {
      offsets[k] = x;
      x += widths[k] + (k < to - 1 ? space : 0);
    }
    maxLineWidth = Math.max(maxLineWidth, x);
    return { from, to, width: x, text: texts.slice(from, to).join(' ') };
  });
  const result = { font, fontSize: size, texts, widths, offsets, lines: outLines, maxLineWidth };
  if (cache.size >= 6) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

function wrapBalanced(texts, widths, space, maxWidth) {
  const n = widths.length;
  const span = (a, b) => {
    let w = 0;
    for (let k = a; k < b; k++) w += widths[k];
    return w + space * Math.max(0, b - a - 1);
  };
  if (span(0, n) <= maxWidth) return [[0, n]];
  if (n < 2) return null;
  let best = null, bestCost = Infinity;
  for (let b = 1; b < n; b++) {
    const w1 = span(0, b), w2 = span(b, n);
    if (w1 > maxWidth || w2 > maxWidth) continue;
    // Balanced lines, a slightly shorter top line, breaks after punctuation, never after "the".
    let cost = Math.max(w1, w2) + (w1 > w2 ? (w1 - w2) * 0.15 : 0);
    if (SENTENCE_END.test(texts[b - 1]) || CLAUSE_END.test(texts[b - 1])) cost -= maxWidth * 0.06;
    if (WEAK_TAIL.has(bareWord(texts[b - 1]))) cost += maxWidth * 0.05;
    if (cost < bestCost) { bestCost = cost; best = [[0, b], [b, n]]; }
  }
  return best;
}

function wrapGreedy(widths, space, maxWidth) {
  const lines = [];
  let from = 0, w = 0;
  for (let k = 0; k < widths.length; k++) {
    const add = (k > from ? space : 0) + widths[k];
    if (k > from && w + add > maxWidth) {
      lines.push([from, k]);
      from = k;
      w = widths[k];
    } else w += add;
  }
  lines.push([from, widths.length]);
  return lines;
}

/** Top edge of the caption block for the requested position, nudged clear of the camera bubble. */
function placeBlock(layout, position, blockW, blockH, W, H, s) {
  const edge = 12 * s;
  const margin = H * 0.09;
  let top = position === 'top' ? margin : position === 'middle' ? (H - blockH) / 2 : H - margin - blockH;
  const cam = layout.camera;
  if (cam && cam.size > 0 && Number.isFinite(cam.x) && Number.isFinite(cam.y)) {
    const gap = 16 * s;
    const left = (W - blockW) / 2, right = left + blockW;
    const camTop = cam.y - gap, camBottom = cam.y + cam.size + gap;
    const overlapX = left < cam.x + cam.size + gap && right > cam.x - gap;
    const overlapY = top < camBottom && top + blockH > camTop;
    if (overlapX && overlapY) {
      const above = camTop - blockH, below = camBottom;
      const fitsAbove = above >= edge, fitsBelow = below + blockH <= H - edge;
      if (position === 'top') top = fitsBelow || !fitsAbove ? below : above;
      else if (position === 'middle') {
        if (fitsAbove && fitsBelow) top = Math.abs(above - top) <= Math.abs(below - top) ? above : below;
        else top = fitsBelow && !fitsAbove ? below : above;
      } else top = fitsAbove || !fitsBelow ? above : below;
    }
  }
  return clamp(top, edge, Math.max(edge, H - edge - blockH));
}

function resetCtx(ctx) {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  clearShadow(ctx);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  if ('filter' in ctx) ctx.filter = 'none';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  if ('wordSpacing' in ctx) ctx.wordSpacing = '0px';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
}

function setShadow(ctx, color, blur, x, y) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = x;
  ctx.shadowOffsetY = y;
}

function clearShadow(ctx) {
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function roundRectPath(ctx, x, y, w, h, r, fresh = true) {
  if (!(w > 0 && h > 0)) return;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (fresh) ctx.beginPath();
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

/**
 * Draws the caption for `time` onto an output frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ chunks: Array, time: number, captions: {style:string, position:string, size:string}, layout: {width:number,height:number,s:number,camera?:object|null} }} o
 */
export function drawCaptions(ctx, { chunks, time, captions, layout } = {}) {
  if (!ctx || !layout || !Array.isArray(chunks) || chunks.length === 0) return;
  const t = Number(time);
  const W = Number(layout.width), H = Number(layout.height);
  if (!Number.isFinite(t) || !(W > 0) || !(H > 0)) return;
  const index = chunkIndexAt(chunks, t);
  if (index < 0) return;
  const chunk = chunks[index];
  const opts = captions || {};
  const styleId = hasStyle(opts.style) ? opts.style : 'minimal';
  const def = STYLES[styleId];
  const s = layout.s > 0 ? layout.s : Math.min(W, H) / 1080;
  const k = SIZE_SCALE[opts.size] || 1;

  let words = wordsOf(chunk);
  if (!words.length) return;
  let enterAt = chunk.start;
  // Back-to-back lines keep their box steady; only the text eases in.
  let fresh = !(index > 0 && chunk.start - chunks[index - 1].end < 0.05);
  if (styleId === 'bold') {
    const group = groupAt(boldGroups(chunk, words), t);
    words = group.words;
    enterAt = group.start;
    fresh = true;
  }

  ctx.save();
  try {
    resetCtx(ctx);
    const size0 = def.size * s * k;
    const boxExtra = 2 * def.padX * size0 + (def.stroke || 0) * size0;
    const maxWidth = Math.max(size0 * 2, W * 0.8 - boxExtra);
    const tl = layoutWords(ctx, words, def, size0, maxWidth);
    const fs = tl.fontSize;
    const lineH = fs * def.lineHeight;
    const padX = def.padX * fs, padY = def.padY * fs;
    const blockW = tl.maxLineWidth + 2 * padX + (def.stroke || 0) * fs;
    const blockH = tl.lines.length * lineH + 2 * padY;
    const top = placeBlock(layout, opts.position, blockW, blockH, W, H, s);
    const p = easeOutCubic(clamp((t - enterAt) / ENTER_SEC, 0, 1));
    const rise = (1 - p) * (fresh ? 10 : 5) * s * k;
    PAINTERS[styleId]({
      ctx, tl, fs, lineH, padX, padY, blockW, blockH, top, cx: W / 2, s, k, t, words,
      active: activeWordIndex(words, t), p, fresh, boxDy: fresh ? rise : 0, textDy: rise,
    });
  } finally {
    ctx.restore();
  }
}

/** Calls fn(text, centerX, baseline) per line. */
function eachLine(f, fn) {
  f.tl.lines.forEach((line, i) => fn(line.text, f.cx, baselineOf(f, i), line));
}

/** Calls fn(index, x, baseline, width, lineIndex) per word. */
function eachWord(f, fn) {
  f.tl.lines.forEach((line, i) => {
    const left = f.cx - line.width / 2;
    const y = baselineOf(f, i);
    for (let w = line.from; w < line.to; w++) fn(w, left + f.tl.offsets[w], y, f.tl.widths[w], i);
  });
}

// 0.35em below the line's center sits the baseline, which optically centers caps and x-height.
const baselineOf = (f, i) => f.top + f.padY + i * f.lineH + f.lineH / 2 + f.fs * 0.35 + f.textDy;

function boxRect(f) {
  return { x: f.cx - f.blockW / 2, y: f.top + f.boxDy, w: f.blockW, h: f.blockH };
}

const PAINTERS = {
  minimal(f) {
    const { ctx, s, k } = f;
    ctx.font = f.tl.font;
    ctx.textAlign = 'center';
    ctx.globalAlpha = f.p;
    ctx.fillStyle = '#ffffff';
    // White-on-white screen UIs are common, so a soft dark halo (wide shadow + a hairline
    // translucent outline) keeps the text legible while still reading as "no background".
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.2 * s * k;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.42)';
    setShadow(ctx, 'rgba(0, 0, 0, 0.55)', 18 * s * k, 0, 2 * s * k);
    eachLine(f, (text, x, y) => ctx.strokeText(text, x, y));
    setShadow(ctx, 'rgba(0, 0, 0, 0.45)', 3 * s * k, 0, 1 * s * k);
    eachLine(f, (text, x, y) => ctx.fillText(text, x, y));
  },

  clean(f) {
    const { ctx, s, k } = f;
    const r = boxRect(f);
    ctx.globalAlpha = f.fresh ? f.p : 1;
    setShadow(ctx, 'rgba(0, 0, 0, 0.22)', 30 * s * k, 0, 10 * s * k);
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 0.52 * f.fs);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
    ctx.fill();
    clearShadow(ctx);
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.stroke();
    ctx.globalAlpha = f.p;
    ctx.font = f.tl.font;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#1d1d1f';
    eachLine(f, (text, x, y) => ctx.fillText(text, x, y));
  },

  subtitle(f) {
    const { ctx } = f;
    ctx.globalAlpha = f.fresh ? f.p : 1;
    ctx.beginPath();
    f.tl.lines.forEach((line, i) => {
      const w = line.width + 2 * f.padX;
      const y = f.top + f.boxDy + i * f.lineH - (i > 0 ? 0.5 : 0); // overlap by half a px so stacked bars have no seam
      roundRectPath(ctx, f.cx - w / 2, y, w, f.lineH + (i > 0 ? 0.5 : 0), 0.12 * f.fs, false);
    });
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fill('nonzero');
    ctx.globalAlpha = f.p;
    ctx.font = f.tl.font;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    eachLine(f, (text, x, y) => ctx.fillText(text, x, y));
  },

  glass(f) {
    const { ctx, s, k } = f;
    const r = boxRect(f);
    const radius = Math.min(r.h / 2, f.fs * 1.05);
    ctx.globalAlpha = f.fresh ? f.p : 1;
    setShadow(ctx, 'rgba(0, 0, 0, 0.28)', 32 * s * k, 0, 10 * s * k);
    roundRectPath(ctx, r.x, r.y, r.w, r.h, radius);
    ctx.fillStyle = 'rgba(20, 20, 22, 0.62)';
    ctx.fill();
    clearShadow(ctx);
    // Faux frosted material: a top sheen and a hairline rim.
    const sheen = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
    sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0.04)');
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = sheen;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.4 * s * k);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.stroke();
    ctx.font = f.tl.font;
    eachWord(f, (i, x, y) => {
      ctx.globalAlpha = f.p;
      ctx.fillStyle = i === f.active ? '#ffffff' : 'rgba(255, 255, 255, 0.7)';
      ctx.fillText(f.tl.texts[i], x, y);
    });
  },

  karaoke(f) {
    const { ctx } = f;
    const r = boxRect(f);
    ctx.globalAlpha = f.fresh ? f.p : 1;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 0.5 * f.fs);
    ctx.fillStyle = 'rgba(14, 14, 18, 0.62)';
    ctx.fill();

    // Accent highlight behind the current word; it glides over from the previous word.
    const rects = [];
    eachWord(f, (i, x, y, w, line) => { rects[i] = { x, y, w, line }; });
    const cur = rects[f.active];
    if (cur) {
      const padX = 0.16 * f.fs, h = 1.2 * f.fs;
      let x = cur.x - padX, w = cur.w + 2 * padX, alpha = f.p;
      const prev = rects[f.active - 1];
      const dt = f.t - f.words[f.active].start;
      if (dt >= 0 && dt < SLIDE_SEC) {
        const e = easeOutCubic(dt / SLIDE_SEC);
        if (prev && prev.line === cur.line) {
          x = lerp(prev.x - padX, x, e);
          w = lerp(prev.w + 2 * padX, w, e);
        } else if (f.active > 0) alpha *= e;
      }
      ctx.globalAlpha = alpha;
      roundRectPath(ctx, x, cur.y - f.fs * 0.35 - h / 2, w, h, 0.3 * f.fs);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }

    ctx.font = f.tl.font;
    eachWord(f, (i, x, y) => {
      ctx.globalAlpha = f.p;
      ctx.fillStyle = i <= f.active ? '#ffffff' : 'rgba(255, 255, 255, 0.45)';
      ctx.fillText(f.tl.texts[i], x, y);
    });
  },

  bold(f) {
    const { ctx, fs } = f;
    const centerY = f.top + f.blockH / 2 + f.textDy;
    // Pop-in for the whole group, then a small pop on every word change.
    const groupScale = 0.9 + 0.1 * f.p;
    ctx.globalAlpha = f.p;
    ctx.translate(f.cx, centerY);
    ctx.scale(groupScale, groupScale);
    ctx.translate(-f.cx, -centerY);
    ctx.font = f.tl.font;
    ctx.lineWidth = (STYLES.bold.stroke || 0.2) * fs;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(8, 8, 12, 0.92)';

    const wordScale = (i) => {
      if (i !== f.active) return 1;
      const q = clamp((f.t - f.words[i].start) / POP_SEC, 0, 1);
      return 1 + 0.08 * Math.sin(Math.PI * q);
    };
    const drawWord = (i, x, y, w, paint) => {
      const sc = wordScale(i);
      const midY = y - fs * 0.35;
      ctx.save();
      ctx.translate(x + w / 2, midY);
      ctx.scale(sc, sc);
      paint(f.tl.texts[i], -w / 2, fs * 0.35);
      ctx.restore();
    };

    // All strokes first so a popping word's outline never covers its neighbour's fill.
    setShadow(ctx, 'rgba(0, 0, 0, 0.5)', 0.16 * fs, 0, 0.07 * fs);
    eachWord(f, (i, x, y, w) => drawWord(i, x, y, w, (text, tx, ty) => ctx.strokeText(text, tx, ty)));
    clearShadow(ctx);
    eachWord(f, (i, x, y, w) => drawWord(i, x, y, w, (text, tx, ty) => {
      ctx.fillStyle = i === f.active ? YELLOW : '#ffffff';
      ctx.fillText(text, tx, ty);
    }));
  },
};

/* ------------------------------------------------------------------ */
/* Style picker preview                                                */
/* ------------------------------------------------------------------ */

const PREVIEW_TEXT = 'Here is how captions look';
const PREVIEW_ACTIVE_WORD = 2; // "how" — mid-sentence, so karaoke/bold show their highlight
const previewState = new WeakMap();
let previewChunk = null;
let previewObserver = null;

/**
 * Renders a static sample caption in `styleId` on a soft indigo/violet gradient.
 * CSS size: the canvas's CSS-driven size once laid out, otherwise its width/height attributes
 * (in that case the inline style is pinned to that size so the HiDPI backing store can't enlarge it).
 */
export function drawCaptionPreview(canvas, styleId) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const state = previewState.get(canvas) || { styleId, watching: false };
  state.styleId = styleId;
  previewState.set(canvas, state);
  const size = previewSize(canvas);
  renderPreview(canvas, styleId, size);
  // Panels usually draw before the card is in the DOM: re-render once it has a real layout size.
  if (!size.settled && !state.watching) watchPreview(canvas, state);
}

function watchPreview(canvas, state) {
  if (typeof ResizeObserver === 'function') {
    if (!previewObserver) {
      previewObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const target = entry.target;
          const st = previewState.get(target);
          const size = previewSize(target);
          if (!size.settled) continue;
          previewObserver.unobserve(target);
          if (st) {
            st.watching = false;
            renderPreview(target, st.styleId, size);
          }
        }
      });
    }
    state.watching = true;
    previewObserver.observe(canvas);
    return;
  }
  if (typeof requestAnimationFrame !== 'function') return;
  state.watching = true;
  let tries = 0;
  const check = () => {
    const size = previewSize(canvas);
    if (size.settled) {
      state.watching = false;
      renderPreview(canvas, state.styleId, size);
    } else if (++tries < 120) requestAnimationFrame(check);
    else state.watching = false;
  };
  requestAnimationFrame(check);
}

function previewSize(canvas) {
  const ds = canvas.dataset;
  const style = canvas.style;
  if (!ds || !style) return { w: canvas.width || 300, h: canvas.height || 150, settled: true }; // e.g. OffscreenCanvas
  if (!ds.captionBaseW) {
    ds.captionBaseW = String(canvas.width || 300);
    ds.captionBaseH = String(canvas.height || 150);
  }
  const base = { w: Number(ds.captionBaseW) || 300, h: Number(ds.captionBaseH) || 150 };
  if (ds.captionPinned === '1') return { ...base, settled: true };
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!canvas.isConnected || !(cw > 0 && ch > 0)) return { ...base, settled: false };
  // Displayed size differs from the backing store → CSS sizes the canvas; follow it from now on.
  if (ds.captionCss === '1' || style.width || style.height || cw !== canvas.width || ch !== canvas.height) {
    ds.captionCss = '1';
    return { w: cw, h: ch, settled: true };
  }
  style.width = `${base.w}px`;
  style.height = 'auto';
  style.maxWidth = '100%';
  ds.captionPinned = '1';
  return { ...base, settled: true };
}

function renderPreview(canvas, styleId, { w, h }) {
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
  if (!ctx) return;
  const dpr = typeof window !== 'undefined' ? clamp(Number(window.devicePixelRatio) || 1, 1, 3) : 1;
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;

  if (!previewChunk) previewChunk = buildCaptionChunks([{ id: 'preview', start: 0, end: 2.6, text: PREVIEW_TEXT }], { maxWords: 12, maxChars: 80 })[0];
  const word = previewChunk.words[PREVIEW_ACTIVE_WORD];
  const time = word.start + Math.min(0.22, (word.end - word.start) * 0.9);
  // Captions are scaled up relative to a real frame so they read at thumbnail size.
  const s = Math.min(w / 460, h / 260) * dpr;

  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    resetCtx(ctx);
    ctx.clearRect(0, 0, W, H);
    paintPreviewBackdrop(ctx, W, H, s);
    drawCaptions(ctx, {
      chunks: [previewChunk],
      time,
      captions: { enabled: true, style: hasStyle(styleId) ? styleId : 'minimal', position: 'middle', size: 'M' },
      layout: { width: W, height: H, s, camera: null },
    });
  } finally {
    ctx.restore();
  }
}

function paintPreviewBackdrop(ctx, W, H, s) {
  const base = ctx.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, '#7a78ff');
  base.addColorStop(0.5, '#5e5ce6');
  base.addColorStop(1, '#9a5bf0');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  const blob = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  const R = Math.max(W, H);
  blob(W * 0.12, H * 0.05, R * 0.6, 'rgba(170, 190, 255, 0.45)');
  blob(W * 0.95, H * 1.05, R * 0.65, 'rgba(255, 122, 198, 0.38)');
  // A faint "window" suggests a recording behind the caption.
  const inset = Math.round(Math.min(W, H) * 0.12);
  roundRectPath(ctx, inset, inset, W - inset * 2, H - inset * 2, 10 * s);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, s);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.stroke();
}

/* ------------------------------------------------------------------ */
/* SRT / WebVTT                                                        */
/* ------------------------------------------------------------------ */

const pad = (n, len = 2) => String(n).padStart(len, '0');

function stamp(ms, sep) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/**
 * Valid, sorted, non-overlapping cues in integer milliseconds.
 * With `trim` ({start, end}), cues are clipped to it and re-timed to start at trim.start.
 */
function cues(chunks, trim) {
  const lo = trim && Number.isFinite(Number(trim.start)) ? Math.max(0, Number(trim.start)) : 0;
  const hi = trim && Number.isFinite(Number(trim.end)) ? Number(trim.end) : Infinity;
  const list = (Array.isArray(chunks) ? chunks : [])
    .map((c) => ({ start: Number(c?.start), end: Number(c?.end), text: cleanText(c?.text) }))
    .filter((c) => c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > lo && c.start < hi)
    .sort((a, b) => a.start - b.start);
  const out = [];
  let prevEnd = 0;
  for (const c of list) {
    let start = Math.round((Math.max(c.start, lo) - lo) * 1000);
    const end = Math.round((Math.min(c.end, hi) - lo) * 1000);
    start = Math.max(start, prevEnd);
    if (end <= start) continue;
    out.push({ start, end, text: c.text });
    prevEnd = end;
  }
  return out;
}

/** SubRip: "1\n00:00:01,000 --> 00:00:03,500\ntext\n\n…". Optional `{ trim }` re-times to a trimmed export. */
export function toSRT(chunks, { trim = null } = {}) {
  return cues(chunks, trim)
    .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text.replace(/-->/g, '→')}\n`)
    .join('\n');
}

/** WebVTT: "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\ntext\n…". Optional `{ trim }` re-times to a trimmed export. */
export function toVTT(chunks, { trim = null } = {}) {
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = cues(chunks, trim)
    .map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${escape(c.text)}\n`)
    .join('\n');
  return body ? `WEBVTT\n\n${body}` : 'WEBVTT\n';
}
