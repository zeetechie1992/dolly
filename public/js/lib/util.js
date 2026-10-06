// Small shared helpers. No dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Hyperscript element builder.
 *   h('button', { class: 'btn', onclick: fn, dataset: { id: 1 }, style: { width: '10px' } }, 'Label', childNode)
 * - `html` prop sets innerHTML (use for icons: { html: icon('play') }).
 * - on* props become event listeners; boolean false/null/undefined props are skipped.
 * - children may be strings, nodes, arrays, or falsy (skipped).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class' || key === 'className') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

/** Smooth ease used for zoom transitions (cubic in-out). */
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Softer, Screen Studio-like ease (quintic-ish ease-out on both ends). */
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export function uid(prefix = '') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return prefix + rand[0].toString(36) + rand[1].toString(36);
}

/** 75.4 -> "1:15"; 3725 -> "1:02:05". With `ms`, appends tenths: "1:15.4". */
export function formatTime(seconds, { ms = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  let tenths = 0;
  if (ms) {
    const T = Math.round(seconds * 10);
    seconds = Math.floor(T / 10);
    tenths = T % 10;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  let out = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  if (ms) out += '.' + tenths;
  return out;
}

/** "Just now", "5 min ago", "Yesterday", "Mar 4" */
export function formatRelativeDate(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 172800) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: diff > 31536000 ? 'numeric' : undefined });
}

export function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

export function debounce(fn, wait = 300) {
  let t;
  const debounced = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  debounced.flush = (...args) => { clearTimeout(t); fn(...args); };
  debounced.cancel = () => clearTimeout(t);
  return debounced;
}

export function throttleRaf(fn) {
  let queued = false, lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function deepClone(obj) {
  return typeof structuredClone === 'function' ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
}

/** Keeps a range slider's filled track in sync (base.css uses --fill). Call after setting value. */
export function syncSliderFill(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100);
  input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min || 1)) * 100}%`);
}

/** Download a Blob with a filename. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Filesystem-safe name from a title. */
export function slugify(text) {
  return (text || 'dolly-video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'dolly-video';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** True when the keyboard event target is a text field (skip global shortcuts). */
export function isTypingTarget(e) {
  const t = e.target;
  return t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) && t.type !== 'range' && t.type !== 'checkbox';
}

/** Minimal event emitter. */
export class Emitter {
  #handlers = new Map();
  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this.#handlers.get(event)?.delete(fn); }
  emit(event, ...args) { this.#handlers.get(event)?.forEach((fn) => { try { fn(...args); } catch (err) { console.error(err); } }); }
}
