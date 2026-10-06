// Shared UI primitives: toasts, modals, confirm dialogs, popover menus, theme.

import { h } from './util.js';
import { icon } from './icons.js';

let toastStack = null;
// The longest delay setTimeout honours; anything larger (Infinity included) fires at once.
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Shows a toast at the bottom center.
 * `duration` in ms; 0, a negative or non-finite value (e.g. Infinity), or anything above
 * 2^31-1 makes the toast persistent: it stays until dismissed with its close button.
 * @param {string|Node} message
 * @param {{ type?: 'info'|'success'|'error', duration?: number }} [opts]
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function toast(message, { type = 'info', duration = 2600 } = {}) {
  if (!toastStack || !toastStack.isConnected) {
    toastStack = h('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastStack);
  }
  const iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'warning' : 'info';
  const el = h('div', { class: `toast ${type}` }, h('span', { class: 'toast-icon', html: icon(iconName, 16) }), message);
  let timer = 0;
  let leaving = false;
  const close = () => {
    if (leaving) return;
    leaving = true;
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600); // no animation (reduced motion, hidden tab)
  };
  const timed = Number.isFinite(duration) && duration > 0 && duration <= MAX_TIMEOUT;
  if (timed) {
    timer = setTimeout(close, duration);
  } else {
    el.classList.add('is-persistent');
    el.append(h('button', {
      type: 'button', class: 'btn btn-icon btn-sm toast-close', 'aria-label': 'Dismiss', html: icon('x', 14), onclick: close,
    }));
  }
  toastStack.append(el);
  return { el, close };
}

/**
 * Opens a modal dialog.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.description]
 * @param {Node|Node[]} [o.content] body content
 * @param {Array<{label:string, variant?:'primary'|'secondary'|'danger'|'ghost', onClick?:(close:Function)=>void, autofocus?:boolean}>} [o.actions]
 * @param {boolean} [o.dismissible=true] close on backdrop click / Escape
 * @param {string} [o.width] CSS width override, e.g. '640px'
 * @param {() => void} [o.onClose]
 * @returns {{ el: HTMLElement, body: HTMLElement, close: () => void }}
 */
export function openModal({ title, description, content, actions = [], dismissible = true, width, onClose }) {
  const body = h('div', { class: 'modal-body' }, content);
  const footer = actions.length
    ? h('div', { class: 'modal-footer' }, actions.map((a) => h('button', {
        class: `btn btn-${a.variant || 'secondary'}`,
        autofocus: a.autofocus || false,
        onclick: () => (a.onClick ? a.onClick(close) : close()),
      }, a.label)))
    : null;
  const closeBtn = dismissible ? h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Close', html: icon('x', 16), onclick: () => close() }) : null;
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: width ? { width: `min(${width}, 100%)` } : null },
    h('div', { class: 'modal-header' }, h('div', {}, h('h2', {}, title), description ? h('p', {}, description) : null), closeBtn),
    body,
    footer,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  backdrop.addEventListener('mousedown', (e) => { if (dismissible && e.target === backdrop) close(); });
  const onKey = (e) => { if (dismissible && e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  (modal.querySelector('[autofocus]') || modal.querySelector('button, input, select, textarea'))?.focus();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.style.animation = 'fade-in 160ms ease reverse both';
    setTimeout(() => backdrop.remove(), 150);
    onClose?.();
  }
  return { el: modal, body, close };
}

/** Promise-based confirm dialog. Resolves true/false. */
export function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      description: message,
      width: '420px',
      onClose: () => resolve(result),
      actions: [
        { label: cancelText, variant: 'secondary' },
        { label: confirmText, variant: danger ? 'danger' : 'primary', autofocus: true, onClick: (close) => { result = true; close(); } },
      ],
    });
  });
}

/** Promise-based single text prompt. Resolves the string or null. */
export function promptDialog({ title, label, value = '', confirmText = 'Save', placeholder = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'input', value, placeholder, 'aria-label': label || title });
    const m = openModal({
      title,
      width: '440px',
      content: h('div', { class: 'field' }, label ? h('label', { class: 'label' }, label) : null, input),
      onClose: () => resolve(result),
      actions: [
        { label: 'Cancel', variant: 'secondary' },
        { label: confirmText, variant: 'primary', onClick: (close) => { result = input.value.trim(); close(); } },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { result = input.value.trim(); m.close(); } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

let activeMenu = null; // the open openMenu() handle, so a new menu can fully close the old one

/**
 * Opens a popover menu anchored to an element.
 * Keyboard: focus moves to the first item; ↑/↓/Home/End move between items,
 * Escape closes and returns focus to the anchor, Tab closes and continues the
 * normal tab order from the anchor.
 * @param {HTMLElement} anchor
 * @param {Array<{label:string, icon?:string, danger?:boolean, onClick:()=>void}|'separator'>} items
 * @returns {{ close: (opts?: { restoreFocus?: boolean }) => void }}
 */
export function openMenu(anchor, items) {
  activeMenu?.close();
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu', role: 'menu' }, items.map((item) => item === 'separator'
    ? h('hr', { role: 'separator' })
    : h('button', {
        type: 'button', role: 'menuitem', tabindex: '-1', class: item.danger ? 'danger' : '',
        // A keyboard activation (detail 0) hands focus back to the anchor first; the item's
        // own action (a dialog, a navigation) may then move it elsewhere.
        onclick: (e) => { close({ restoreFocus: e.detail === 0 }); item.onClick(); },
      }, item.icon ? h('span', { html: icon(item.icon, 16) }) : null, item.label)));
  const itemEls = [...menu.querySelectorAll('[role=menuitem]')];
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  anchor.setAttribute('aria-expanded', 'true');
  // Focus synchronously: Enter activates the anchor on keydown and Space on keyup,
  // so neither can then re-fire on the newly focused item.
  itemEls[0]?.focus({ preventScroll: true });

  menu.addEventListener('keydown', (e) => {
    if (!itemEls.length) return;
    const i = itemEls.indexOf(document.activeElement);
    const move = (n) => { e.preventDefault(); itemEls[(n + itemEls.length) % itemEls.length].focus(); };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(-1);
    else if (e.key === 'Tab') close({ restoreFocus: true }); // no preventDefault: Tab then advances from the anchor
  });
  const onDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close({ restoreFocus: menu.contains(document.activeElement) || document.activeElement === anchor });
  };
  setTimeout(() => {
    if (!menu.isConnected) return; // closed before the listeners were attached
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
  });
  const handle = { close };
  activeMenu = handle;
  function close({ restoreFocus = false } = {}) {
    if (activeMenu === handle) activeMenu = null;
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey);
    if (!menu.isConnected) return;
    anchor.setAttribute('aria-expanded', 'false');
    // Only for keyboard dismissal: on an outside click focus belongs to what was clicked.
    // Focus before removing the menu so focus never drops to <body> in between.
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    menu.remove();
  }
  return handle;
}

/* Theme: 'system' | 'light' | 'dark', persisted per browser. */
const THEME_KEY = 'dolly.theme';
export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}
export function applyTheme(theme = getTheme()) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
}
/** Effective scheme after resolving 'system'. */
export function isDark() {
  const t = getTheme();
  return t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Builds the Dolly logo link. */
export function logo({ href = '#/' } = {}) {
  return h('a', { class: 'logo', href, 'aria-label': 'Dolly home' }, h('span', { class: 'logo-mark' }), 'Dolly');
}
