// Floating recording controls in a Document Picture-in-Picture window: a compact, always-dark
// macOS-style HUD (red dot, mono timer, pause/resume, stop) that also shows the 3-2-1 countdown.
//
//   const pip = await openPip();          // call synchronously from a click (needs user activation)
//   pip.onPause = …; pip.onResume = …; pip.onStop = …; pip.onCancel = …; pip.onClose = …;
//   pip.setState('countdown'); pip.showCountdown(3); pip.setState('recording'); pip.setTime(12.4);
//   pip.close();

import { icon } from '../lib/icons.js';
import { formatTime } from '../lib/util.js';

export const PIP_SIZE = { width: 320, height: 72 };

export function isPipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window && window.isSecureContext !== false;
}

/**
 * Opens the floating controls window. requestWindow() is called synchronously, so call this in
 * the same task as the user's click, before awaiting anything.
 * @returns {Promise<PipController>}
 */
export function openPip({ width = PIP_SIZE.width, height = PIP_SIZE.height } = {}) {
  if (!isPipSupported()) return Promise.reject(new Error('Floating controls are not supported in this browser.'));
  let request;
  try {
    request = window.documentPictureInPicture.requestWindow({ width, height });
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.resolve(request).then((win) => createController(win));
}

// Literal values only as a fallback when tokens.css can't be copied into the PiP document.
const FALLBACK_TOKENS = `
:root {
  --red: #ff453a; --red-soft: rgba(255, 69, 58, 0.18); --orange: #ff9f0a;
  --bg-elevated: #1c1c1e; --bg-hover: rgba(255, 255, 255, 0.06); --bg-active: rgba(255, 255, 255, 0.1);
  --separator: rgba(255, 255, 255, 0.09); --separator-strong: rgba(255, 255, 255, 0.16);
  --text: #f5f5f7; --text-secondary: #a1a1a6; --accent-contrast: #ffffff;
  --focus-ring: 0 0 0 3px rgba(125, 122, 255, 0.45);
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}`;

const PIP_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body {
  background: var(--bg-elevated); color: var(--text);
  font-family: var(--font); font-size: 13px; letter-spacing: -0.01em;
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none; cursor: default;
}
svg { display: block; }
.hud {
  position: relative; height: 100%; display: flex; align-items: center; gap: 12px; padding: 0 12px 0 18px;
  background: linear-gradient(180deg, var(--bg-hover), transparent 75%);
}
.status { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; }
.dot {
  flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--red);
  box-shadow: 0 0 0 4px var(--red-soft); animation: pulse 1.6s ease-in-out infinite;
}
.meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; line-height: 1.1; }
.label { font-size: 10px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-secondary); }
.time { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 22px; font-weight: 600; letter-spacing: -0.03em; }
.actions { display: flex; gap: 8px; flex: none; }
.btn {
  width: 40px; height: 40px; border-radius: 50%; border: 0; padding: 0; display: grid; place-items: center;
  background: var(--bg-active); color: var(--text); cursor: pointer; font: inherit;
  transition: background 120ms ease, transform 120ms ease, filter 120ms ease;
}
.btn:hover { background: var(--separator-strong); }
.btn:active { transform: scale(0.94); }
.btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.btn.stop { background: var(--red); color: var(--accent-contrast); }
.btn.stop:hover { filter: brightness(1.08); }
.btn.small { width: 32px; height: 32px; }
[data-state="paused"] .dot { background: var(--orange); box-shadow: none; animation: none; }
[data-state="paused"] .time { color: var(--text-secondary); }
.overlay {
  position: absolute; inset: 0; display: none; align-items: center; gap: 14px; padding: 0 12px 0 18px;
  background: var(--bg-elevated);
}
[data-state="countdown"] .overlay, [data-state="ready"] .overlay { display: flex; }
.count {
  flex: none; width: 34px; text-align: center; font-family: var(--font-display); font-size: 40px; font-weight: 700;
  letter-spacing: -0.04em; line-height: 1; font-variant-numeric: tabular-nums;
}
.count.tick { animation: count 1s var(--ease-out) both; }
.spin {
  flex: none; width: 20px; height: 20px; margin: 0 7px; border-radius: 50%;
  border: 2px solid var(--separator-strong); border-top-color: var(--text); animation: spin 0.8s linear infinite;
}
[data-state="countdown"] .spin, [data-state="ready"] .count { display: none; }
/* The page can't cancel the browser's screen picker, so ✕ only shows during the countdown. */
[data-state="ready"] .overlay .btn.small { display: none; }
.copy { flex: 1; min-width: 0; line-height: 1.25; }
.copy strong { display: block; font-size: 14px; font-weight: 600; }
.copy span { display: block; font-size: 12px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes count {
  0% { opacity: 0; transform: scale(1.6); }
  22% { opacity: 1; transform: scale(1); }
  78% { opacity: 1; transform: scale(0.97); }
  100% { opacity: 0.15; transform: scale(0.8); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
}`;

/** Copies the app's design tokens so the HUD uses the same palette (forced dark below). */
function copyTokens() {
  for (const sheet of Array.from(document.styleSheets)) {
    if (!sheet.href || !/\/css\/tokens\.css(?:[?#]|$)/.test(sheet.href)) continue;
    try {
      return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * @typedef {object} PipController
 * @property {Window} window
 * @property {boolean} closed
 * @property {(sec: number) => void} setTime
 * @property {(state: 'ready'|'countdown'|'recording'|'paused') => void} setState
 * @property {(n: number) => void} showCountdown
 * @property {(text: string) => void} setHint  replaces the subtitle shown before recording starts
 * @property {() => void} close
 * @property {Function|null} onPause @property {Function|null} onResume @property {Function|null} onStop
 * @property {Function|null} onCancel  countdown cancelled from the window (Esc or ✕); only fires during the countdown
 * @property {Function|null} onClose   the user closed the window
 */
function createController(win) {
  const doc = win.document;
  const el = (tag, className, html) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (html) node.innerHTML = html;
    return node;
  };

  doc.title = 'Dolly';
  doc.documentElement.lang = document.documentElement.lang || 'en';
  doc.documentElement.setAttribute('data-theme', 'dark');
  const style = el('style');
  style.textContent = `${FALLBACK_TOKENS}\n${copyTokens()}\n${PIP_CSS}`;
  doc.head.append(style);

  const hud = el('div', 'hud');
  hud.dataset.state = 'ready';

  const label = el('span', 'label');
  label.textContent = 'Recording';
  const time = el('span', 'time');
  time.textContent = '0:00';
  const meta = el('div', 'meta');
  meta.append(label, time);
  const status = el('div', 'status');
  status.append(el('span', 'dot'), meta);

  const pauseBtn = el('button', 'btn', icon('pause', 18));
  pauseBtn.type = 'button';
  pauseBtn.title = 'Pause';
  pauseBtn.setAttribute('aria-label', 'Pause');
  const stopBtn = el('button', 'btn stop', icon('stop', 18));
  stopBtn.type = 'button';
  stopBtn.title = 'Stop and edit';
  stopBtn.setAttribute('aria-label', 'Stop recording');
  const actions = el('div', 'actions');
  actions.append(pauseBtn, stopBtn);

  const count = el('span', 'count');
  const copyTitle = el('strong');
  const copyText = el('span');
  const copy = el('div', 'copy');
  copy.append(copyTitle, copyText);
  const cancelBtn = el('button', 'btn small', icon('x', 16));
  cancelBtn.type = 'button';
  cancelBtn.title = 'Cancel';
  cancelBtn.setAttribute('aria-label', 'Cancel recording');
  const overlay = el('div', 'overlay');
  overlay.append(count, el('span', 'spin'), copy, cancelBtn);

  hud.append(status, actions, overlay);
  doc.body.append(hud);

  let state = 'ready';
  let closed = false;
  let lastTime = '0:00';
  let hint = '';

  const call = (name) => {
    const fn = ctrl[name];
    if (typeof fn === 'function') {
      try { fn(); } catch (err) { console.error(`[pip] ${name} failed`, err); }
    }
  };

  const ctrl = {
    window: win,
    onPause: null,
    onResume: null,
    onStop: null,
    onCancel: null,
    onClose: null,
    get closed() { return closed || win.closed; },
    get state() { return state; },

    setTime(sec) {
      const text = formatTime(sec);
      if (text !== lastTime) {
        lastTime = text;
        time.textContent = text;
      }
    },

    setState(next) {
      if (closed) return;
      state = next;
      hud.dataset.state = next;
      const paused = next === 'paused';
      label.textContent = paused ? 'Paused' : 'Recording';
      pauseBtn.innerHTML = icon(paused ? 'play' : 'pause', 18);
      pauseBtn.title = paused ? 'Resume' : 'Pause';
      pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
      if (next === 'ready') {
        copyTitle.textContent = 'Getting ready…';
        copyText.textContent = hint || 'Choose what to share';
      } else if (next === 'countdown') {
        copyTitle.textContent = 'Recording starts…';
        copyText.textContent = hint || 'Press Esc to cancel';
      }
    },

    setHint(text) {
      hint = text || '';
      if (state === 'ready' || state === 'countdown') ctrl.setState(state);
    },

    showCountdown(n) {
      if (closed) return;
      if (state !== 'countdown') ctrl.setState('countdown');
      count.textContent = String(n);
      // Restart the pop animation for every number.
      count.classList.remove('tick');
      void count.offsetWidth;
      count.classList.add('tick');
    },

    close() {
      if (closed) return;
      closed = true;
      try { win.close(); } catch { /* already closed */ }
    },
  };

  pauseBtn.addEventListener('click', () => call(state === 'paused' ? 'onResume' : 'onPause'));
  stopBtn.addEventListener('click', () => call('onStop'));
  cancelBtn.addEventListener('click', () => call('onCancel'));
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state === 'countdown') {
      e.preventDefault();
      call('onCancel');
    } else if ((e.key === ' ' || e.code === 'Space') && !e.repeat && (state === 'recording' || state === 'paused')
      && !(e.target instanceof win.HTMLButtonElement)) {
      e.preventDefault();
      call(state === 'paused' ? 'onResume' : 'onPause');
    }
  });
  win.addEventListener('pagehide', () => {
    if (closed) return; // closed by us: no callback
    closed = true;
    call('onClose');
  }, { once: true });

  ctrl.setState('ready');
  return ctrl;
}
