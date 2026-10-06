// Pure helpers for the share viewer. No DOM access, so they also load in a bare JS shell
// (self-test: jsc -m <scratch>/viewer-selftest.js).

export const REACTIONS = Object.freeze(['👍', '❤️', '😂', '🎉', '😮', '🔥']);
export const SPEEDS = Object.freeze([0.75, 1, 1.25, 1.5, 1.75, 2]);
export const SHARE_ID_RE = /^[A-Za-z0-9]{6,16}$/;

/** Token names used for avatar colors (no red: it is reserved for recording/destructive). */
export const AVATAR_TOKENS = Object.freeze(['--accent', '--blue', '--teal', '--green', '--orange', '--pink', '--purple']);

/**
 * Parses a start-time value from a share URL (`?t=`): "90", "90.5", "1:30", "1:02:03", "1m30s", "1h2m", "45s".
 * @returns {number|null} seconds, or null when it isn't a time.
 */
export function parseTimeParam(value) {
  const str = String(value ?? '').trim().toLowerCase();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  if (/^\d+(:[0-5]?\d){1,2}$/.test(str)) return str.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  const m = str.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return null;
}

/** 102 → "1m42s" (the inverse of parseTimeParam, for "Copy link at…"). */
export function formatTimeParam(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(total / 3600), mins = Math.floor((total % 3600) / 60), secs = total % 60;
  return `${hrs ? `${hrs}h` : ''}${mins ? `${mins}m` : ''}${secs || (!hrs && !mins) ? `${secs}s` : ''}`;
}

/** Stable 32-bit FNV-1a hash. */
export function hashString(str) {
  let hash = 0x811c9dc5;
  for (const ch of String(str ?? '')) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Display name as the server stores it: trimmed, ≤ 60 chars, 'Guest' when empty. */
export function cleanName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || 'Guest';
}

/** Deterministic avatar color for a name, as a CSS `var(--token)`. */
export function avatarColor(name) {
  return `var(${AVATAR_TOKENS[hashString(cleanName(name).toLowerCase()) % AVATAR_TOKENS.length]})`;
}

/** First letter (grapheme-ish: first code point) of a name, uppercased. */
export function initialOf(name) {
  const first = [...cleanName(name)][0] || '?';
  return first.toLocaleUpperCase();
}

export const isTimed = (item) => typeof item?.time === 'number' && Number.isFinite(item.time);

/** Comments sorted by video time (timeless last), then oldest first. Does not mutate. */
export function sortComments(list) {
  return (Array.isArray(list) ? list : [])
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ta = isTimed(a.c) ? a.c.time : Infinity;
      const tb = isTimed(b.c) ? b.c.time : Infinity;
      if (ta !== tb) return ta < tb ? -1 : 1;
      const ca = Number(a.c.createdAt) || 0, cb = Number(b.c.createdAt) || 0;
      return ca - cb || a.i - b.i;
    })
    .map((x) => x.c);
}

/** Index of the last item whose `start` ≤ t (items sorted by start), or -1. */
export function lastStartedIndex(items, t) {
  if (!Array.isArray(items) || !Number.isFinite(t)) return -1;
  let lo = 0, hi = items.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(items[mid].start) <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Chapters with finite starts inside [0, duration), sorted, de-duplicated. */
export function cleanChapters(chapters, duration) {
  const max = Number(duration) > 0 ? Number(duration) : Infinity;
  const out = [];
  const sorted = (Array.isArray(chapters) ? chapters : [])
    .map((c) => ({ start: Math.max(0, Number(c?.start)), title: String(c?.title ?? '').trim() }))
    .filter((c) => Number.isFinite(c.start) && c.start < max && c.title)
    .sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    if (out.length && c.start - out[out.length - 1].start < 0.5) continue;
    out.push(c);
  }
  return out;
}

/** Transcript segments with text, sorted by start (keeps the original index as `i`). */
export function cleanTranscript(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((s, i) => ({ start: Number(s?.start), end: Number(s?.end), text: String(s?.text ?? '').replace(/\s+/g, ' ').trim(), i }))
    .filter((s) => s.text && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start || a.i - b.i);
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

/**
 * Splits `text` into parts for highlighting `query` (case-insensitive, whole phrase).
 * @returns {Array<{text:string, match:boolean}>} — a single non-match part when nothing matches.
 */
export function splitMatches(text, query) {
  const str = String(text ?? '');
  const q = String(query ?? '').trim();
  if (!q) return [{ text: str, match: false }];
  const re = new RegExp(q.replace(REGEXP_SPECIAL, '\\$&'), 'gi');
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(str))) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > last) parts.push({ text: str.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < str.length || !parts.length) parts.push({ text: str.slice(last), match: false });
  return parts;
}

export const hasMatch = (text, query) => splitMatches(text, query).some((p) => p.match);

/**
 * Groups timed comments/reactions into scrubber markers. An item closer than `minGap`
 * (a fraction of the duration) to the previous marker joins it.
 * @returns {Array<{time:number, items:object[], comments:number, reactions:number, emoji:string|null}>}
 */
export function clusterMarkers(items, duration, minGap = 0.014) {
  const d = Number(duration);
  if (!(d > 0) || !Array.isArray(items)) return [];
  const timed = items
    .filter((it) => isTimed(it) && it.time >= 0 && it.time <= d + 0.5)
    .sort((a, b) => a.time - b.time);
  const out = [];
  let cur = null;
  for (const it of timed) {
    if (cur && (it.time - cur.time) / d < minGap) cur.items.push(it);
    else { cur = { time: Math.min(it.time, d), items: [it] }; out.push(cur); }
  }
  for (const m of out) {
    const counts = new Map();
    m.comments = 0;
    m.reactions = 0;
    for (const it of m.items) {
      if (it.kind === 'reaction') {
        m.reactions++;
        counts.set(it.emoji, (counts.get(it.emoji) || 0) + 1);
      } else m.comments++;
    }
    let best = null, bestN = 0;
    for (const [emoji, n] of counts) if (n > bestN) { best = emoji; bestN = n; }
    m.emoji = best;
  }
  return out;
}

/** Reaction counts per emoji: { '👍': 2, … } (only REACTIONS). */
export function reactionCounts(items) {
  const out = Object.fromEntries(REACTIONS.map((e) => [e, 0]));
  for (const it of Array.isArray(items) ? items : []) {
    if (it?.kind === 'reaction' && Object.prototype.hasOwnProperty.call(out, it.emoji)) out[it.emoji]++;
  }
  return out;
}

/** Rect of a `vw × vh` picture drawn with object-fit: contain inside a `cw × ch` box. */
export function containRect(cw, ch, vw, vh) {
  if (!(cw > 0 && ch > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  if (!(vw > 0 && vh > 0)) return { x: 0, y: 0, w: cw, h: ch };
  // Fit the limiting side exactly (no rounding drift on it).
  const byWidth = cw / vw <= ch / vh;
  const w = byWidth ? cw : (vw * ch) / vh;
  const h = byWidth ? (vh * cw) / vw : ch;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/** share.layout.camera (output px) scaled to a `W × H` canvas, or null. */
export function scaleCamera(layout, W, H) {
  const cam = layout?.camera;
  const lw = Number(layout?.width), lh = Number(layout?.height);
  if (!cam || !(lw > 0) || !(lh > 0) || !(W > 0) || !(H > 0)) return null;
  const x = Number(cam.x), y = Number(cam.y), size = Number(cam.size);
  if (![x, y, size].every(Number.isFinite)) return null;
  const sx = W / lw, sy = H / lh;
  return { x: x * sx, y: y * sy, size: size * Math.min(sx, sy), shape: cam.shape };
}

/** CSS mask-image that cuts `gapPx` gaps into a horizontal bar at chapter starts ('' when none). */
export function chapterMask(chapters, duration, gapPx = 3) {
  const d = Number(duration);
  if (!(d > 0) || !Array.isArray(chapters)) return '';
  const cuts = [];
  for (const c of chapters) {
    const t = Number(c?.start);
    if (!(t > 0.25 && t < d - 0.25)) continue;
    const p = (t / d) * 100;
    if (cuts.length && p - cuts[cuts.length - 1] < 0.6) continue;
    cuts.push(p);
  }
  if (!cuts.length) return '';
  const half = gapPx / 2;
  const stops = ['#000 0%'];
  for (const p of cuts) {
    const at = `${p.toFixed(3)}%`;
    stops.push(`#000 calc(${at} - ${half}px)`, `transparent calc(${at} - ${half}px)`, `transparent calc(${at} + ${half}px)`, `#000 calc(${at} + ${half}px)`);
  }
  stops.push('#000 100%');
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Buffered TimeRanges → [[startFraction, endFraction], …]. */
export function bufferedFractions(ranges, duration) {
  const d = Number(duration);
  const out = [];
  if (!ranges || !(d > 0)) return out;
  for (let i = 0; i < ranges.length; i++) {
    const a = Math.max(0, Math.min(1, ranges.start(i) / d));
    const b = Math.max(0, Math.min(1, ranges.end(i) / d));
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** "1 view", "1,204 views". */
export function formatViews(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return `${v.toLocaleString('en-US')} ${v === 1 ? 'view' : 'views'}`;
}

/** Escapes a string for an HTML attribute value (embed snippet). */
export function escapeAttr(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Responsive iframe snippet for /embed/<id> keeping the video's aspect ratio. */
export function embedSnippet({ origin, id, title, width, height }) {
  const ratio = Number(width) > 0 && Number(height) > 0 ? (Number(height) / Number(width)) * 100 : 56.25;
  const src = `${String(origin || '').replace(/\/+$/, '')}/embed/${encodeURIComponent(id)}`;
  return `<div style="position:relative;padding-bottom:${ratio.toFixed(4).replace(/\.?0+$/, '')}%;height:0;overflow:hidden;">`
    + `<iframe src="${escapeAttr(src)}" title="${escapeAttr(title || 'Dolly video')}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" `
    + 'allow="autoplay; fullscreen; picture-in-picture; clipboard-write" allowfullscreen></iframe></div>';
}

/** Whether a share can draw styled captions over the video (not burned in, has text). */
export function captionsOverlayAvailable(share) {
  const c = share?.captions;
  return Boolean(c && c.enabled && !c.burned && cleanTranscript(share.transcript).length);
}
