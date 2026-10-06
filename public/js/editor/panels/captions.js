// Captions inspector: caption look (style, position, size) and the transcript editor
// that drives captions, the .srt download and the summary.

import { h, clamp, uid, formatTime, downloadBlob, slugify } from '../../lib/util.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/ui.js';
import { CAPTION_STYLES, buildCaptionChunks, drawCaptionPreview, toSRT } from '../captions.js';
import { panelSection, segmentedControl, switchControl } from './design.js';

const NEW_CAPTION_SEC = 2.5;
const USER_SCROLL_GRACE_MS = 2500;

const round3 = (v) => Math.round(v * 1000) / 1000;
const textOf = (seg) => String(seg?.text ?? '');

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** True when the browser sizes `.pn-cap-text` to its content itself (`field-sizing: content` in panels.css). */
const NATIVE_FIELD_SIZING = (() => {
  try { return typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content'); } catch { return false; }
})();

/** Grows a textarea to fit its content (no inner scrollbar). For a single row only; use growAll() for the list. */
function autoGrow(ta) {
  if (NATIVE_FIELD_SIZING || !ta.isConnected) return;
  ta.style.height = 'auto';
  const sh = ta.scrollHeight;
  if (!sh) return;
  ta.style.height = `${sh + (ta.offsetHeight - ta.clientHeight)}px`;
}

/**
 * @param {{ store: object, player?: object|null }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createCaptionsPanel({ store, player = null } = {}) {
  let destroyed = false;
  const offs = [];
  const transcript = () => (Array.isArray(store.project.transcript) ? store.project.transcript : []);
  const captions = () => store.project.edit.captions;
  const currentTime = () => (player && Number.isFinite(player.time) ? player.time : Number(store.ui.time) || 0);
  const setCaptions = (fn) => store.update((p) => fn(p.edit.captions));

  /* Settings ------------------------------------------------------- */

  const enabled = switchControl({
    label: 'Show captions',
    hint: 'In the preview and your export',
    checked: captions().enabled,
    onChange: (v) => setCaptions((c) => { c.enabled = v; }),
  });

  const styleCards = new Map();
  const styleGrid = h('div', { class: 'option-grid pn-style-grid', role: 'group', 'aria-label': 'Caption style' },
    CAPTION_STYLES.map((s) => {
      const canvas = h('canvas', { class: 'pn-style-canvas', width: 240, height: 135, 'aria-hidden': 'true' });
      const card = h('button', {
        type: 'button',
        class: 'option-card pn-style',
        'aria-pressed': 'false',
        'aria-label': `${s.name}: ${s.description}`,
        onclick: () => {
          const c = captions();
          if (c.style !== s.id || !c.enabled) setCaptions((cc) => { cc.style = s.id; cc.enabled = true; });
        },
      },
      canvas,
      h('span', { class: 'option-title' }, s.name),
      h('span', { class: 'option-desc' }, s.description));
      try {
        drawCaptionPreview(canvas, s.id);
      } catch (err) {
        console.warn('[captions panel] preview failed', err);
      }
      styleCards.set(s.id, card);
      return card;
    }));

  const position = segmentedControl({
    label: 'Position',
    options: [
      { value: 'top', label: 'Top' },
      { value: 'middle', label: 'Middle' },
      { value: 'bottom', label: 'Bottom' },
    ],
    value: captions().position,
    onChange: (v) => setCaptions((c) => { c.position = v; }),
  });
  const size = segmentedControl({
    label: 'Size',
    options: [
      { value: 'S', label: 'Small' },
      { value: 'M', label: 'Medium' },
      { value: 'L', label: 'Large' },
    ],
    value: captions().size,
    onChange: (v) => setCaptions((c) => { c.size = v; }),
  });

  const styleSection = panelSection('Style', [styleGrid], { className: 'pn-cap-style' });
  const placementSection = panelSection('Placement', [
    h('div', { class: 'pn-stack' },
      h('div', { class: 'pn-field' }, h('div', { class: 'pn-field-label' }, 'Position'), position.el),
      h('div', { class: 'pn-field' }, h('div', { class: 'pn-field-label' }, 'Size'), size.el)),
  ], { className: 'pn-cap-placement' });

  /* Transcript ----------------------------------------------------- */

  const countEl = h('span', { class: 'pn-aside' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => addCaption() },
    h('span', { class: 'pn-btn-icon', html: icon('plus', 14) }), 'Add at playhead');
  const srtBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => downloadSrt() },
    h('span', { class: 'pn-btn-icon', html: icon('download', 14) }), 'Download .srt');
  const toolbar = h('div', { class: 'pn-cap-toolbar' }, addBtn, srtBtn);
  const list = h('div', { class: 'pn-cap-list', role: 'list', 'aria-label': 'Transcript' });
  const empty = h('div', { class: 'empty-state pn-empty pn-cap-empty' },
    h('div', { class: 'empty-icon', html: icon('captions', 26) }),
    h('h3', {}, 'No transcript yet'),
    h('p', { class: 'pn-empty-text' },
      'Live transcription runs while you record in Chrome with a microphone. You can also write captions yourself.'),
    h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => addCaption() },
      h('span', { class: 'pn-btn-icon', html: icon('plus', 14) }), 'Add caption at playhead'));
  const transcriptSection = panelSection('Transcript', [toolbar, list, empty], { aside: countEl, className: 'pn-cap-transcript' });

  const el = h('div', { class: 'pn pn-captions' },
    panelSection('Captions', [enabled.el], { className: 'pn-cap-toggle' }),
    styleSection,
    placementSection,
    transcriptSection);

  /** id → { el, ta, seg } */
  const rows = new Map();
  let listSig = '';
  let activeId = null;
  let lastUserScroll = -Infinity;

  const isEditing = () => {
    const a = document.activeElement;
    return Boolean(a && a.tagName === 'TEXTAREA' && list.contains(a));
  };

  function buildRow(seg) {
    const id = seg.id;
    const stamp = formatTime(seg.start);
    const time = h('button', {
      type: 'button',
      class: 'pn-cap-time',
      'aria-label': `Jump to ${stamp}`,
      onclick: () => {
        store.setUI({ selectedCaptionId: id });
        player?.seek(seg.start);
      },
    }, stamp);
    const ta = h('textarea', { class: 'pn-cap-text', rows: 1, spellcheck: 'true', 'aria-label': `Caption at ${stamp}` });
    ta.value = textOf(seg);
    ta.addEventListener('input', () => {
      autoGrow(ta);
      setText(id, ta.value);
    });
    ta.addEventListener('focus', () => store.setUI({ selectedCaptionId: id }));
    ta.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Escape') {
        e.preventDefault();
        ta.blur();
      }
    });
    const del = h('button', {
      type: 'button',
      class: 'pn-icon-btn pn-cap-del',
      'aria-label': `Delete caption at ${stamp}`,
      'data-tip': 'Delete',
      html: icon('trash', 15),
      onclick: () => removeCaption(id),
    });
    const row = h('div', { class: 'pn-cap-row', role: 'listitem', dataset: { id } }, time, ta, del);
    return { el: row, ta, seg };
  }

  function renderList() {
    const tr = transcript();
    countEl.textContent = tr.length ? `${tr.length} ${tr.length === 1 ? 'line' : 'lines'}` : '';
    const isEmpty = tr.length === 0;
    empty.hidden = !isEmpty;
    list.hidden = isEmpty;
    toolbar.hidden = isEmpty;

    const sig = tr.map((s) => `${s.id}@${Number(s.start).toFixed(2)}`).join('|');
    if (sig === listSig) {
      // Same rows: update text in place (undo/redo) without disturbing the one being typed in.
      for (const s of tr) {
        const r = rows.get(s.id);
        if (!r) continue;
        r.seg = s;
        const text = textOf(s);
        if (r.ta.value !== text) {
          const focused = document.activeElement === r.ta;
          const pos = focused ? Math.min(r.ta.selectionStart, text.length) : 0;
          r.ta.value = text;
          if (focused) r.ta.setSelectionRange(pos, pos);
          autoGrow(r.ta);
        }
      }
      return;
    }
    listSig = sig;

    const a = document.activeElement;
    const focusedId = a && list.contains(a) ? a.closest('.pn-cap-row')?.dataset.id : null;
    const focusedRole = a?.tagName === 'TEXTAREA' ? 'ta' : null;
    const sel = focusedRole ? [a.selectionStart, a.selectionEnd] : null;

    rows.clear();
    activeId = null;
    const els = tr.map((s) => {
      const r = buildRow(s);
      rows.set(s.id, r);
      return r.el;
    });
    list.replaceChildren(...els);

    if (focusedId && rows.has(focusedId) && focusedRole) {
      const ta = rows.get(focusedId).ta;
      ta.focus({ preventScroll: true });
      if (sel) ta.setSelectionRange(Math.min(sel[0], ta.value.length), Math.min(sel[1], ta.value.length));
    }
    growAll();
    updateActive(currentTime(), { scroll: false });
    updateSelected(false);
  }

  /**
   * Sizes every row with one layout pass: all writes, then all reads, then all writes.
   * (Calling autoGrow per row forces a layout of the whole list per row — O(n²) on long transcripts.)
   */
  function growAll() {
    if (NATIVE_FIELD_SIZING) return;
    const tas = [];
    for (const r of rows.values()) if (r.ta.isConnected) tas.push(r.ta);
    if (!tas.length) return;
    // 1) writes only
    for (const ta of tas) ta.style.height = 'auto';
    // 2) reads only: one layout for the whole list
    const heights = tas.map((ta) => {
      const sh = ta.scrollHeight;
      return sh ? sh + (ta.offsetHeight - ta.clientHeight) : 0;
    });
    // 3) writes only; skip unrendered rows exactly like autoGrow does
    tas.forEach((ta, i) => { if (heights[i]) ta.style.height = `${heights[i]}px`; });
  }

  /* Highlighting ---------------------------------------------------- */

  /** Segment playing at `t` (transcript is sorted by start). */
  function segmentAt(t) {
    const tr = transcript();
    let lo = 0, hi = tr.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tr[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found >= 0 && t < tr[found].end ? tr[found] : null;
  }

  function gentlyReveal(rowEl) {
    if (!rowEl || isEditing() || performance.now() - lastUserScroll < USER_SCROLL_GRACE_MS) return;
    try {
      rowEl.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } catch {
      rowEl.scrollIntoView(false);
    }
  }

  function updateActive(t, { scroll = true } = {}) {
    const seg = segmentAt(t);
    const id = seg ? seg.id : null;
    if (id === activeId) return;
    if (activeId) rows.get(activeId)?.el.classList.remove('is-active');
    activeId = id;
    const r = id ? rows.get(id) : null;
    if (!r) return;
    r.el.classList.add('is-active');
    if (scroll && player?.playing) gentlyReveal(r.el);
  }

  let selectedEl = null;
  function updateSelected(scroll = true) {
    const id = store.ui.selectedCaptionId;
    const r = id ? rows.get(id) : null;
    const next = r ? r.el : null;
    if (next === selectedEl) return;
    selectedEl?.classList.remove('is-selected');
    next?.classList.add('is-selected');
    selectedEl = next;
    if (scroll && next) gentlyReveal(next);
  }

  /* Edits ---------------------------------------------------------- */

  function setText(id, text) {
    store.update((p) => {
      const seg = p.transcript.find((s) => s.id === id);
      if (seg) seg.text = text;
    }, { coalesce: `caption-text:${id}` });
  }

  function removeCaption(id) {
    const tr = transcript();
    const idx = tr.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const hadFocus = rows.get(id)?.el.contains(document.activeElement);
    const neighbour = tr[idx + 1]?.id || tr[idx - 1]?.id || null;
    store.update((p) => { p.transcript = p.transcript.filter((s) => s.id !== id); });
    if (store.ui.selectedCaptionId === id) store.setUI({ selectedCaptionId: null });
    if (hadFocus && !destroyed) {
      const next = neighbour && rows.get(neighbour);
      (next ? next.el.querySelector('.pn-cap-del') : addBtn.isConnected && !toolbar.hidden ? addBtn : null)?.focus({ preventScroll: true });
    }
  }

  function addCaption() {
    const p = store.project;
    const dur = Math.max(0, Number(p.duration) || 0);
    const t = clamp(currentTime(), 0, Math.max(0, dur - 0.5));
    const start = round3(t);
    let end = round3(Math.min(t + NEW_CAPTION_SEC, dur));
    if (!(end > start)) end = round3(start + 0.5);
    const seg = { id: uid('s_'), start, end, text: 'New caption' };
    store.update((proj) => {
      const next = Array.isArray(proj.transcript) ? proj.transcript.slice() : [];
      let i = next.findIndex((s) => s.start > start);
      if (i < 0) i = next.length;
      next.splice(i, 0, seg);
      proj.transcript = next;
      if (!proj.transcriptSource || proj.transcriptSource === 'none') proj.transcriptSource = 'manual';
    });
    if (destroyed) return;
    store.setUI({ selectedCaptionId: seg.id });
    const r = rows.get(seg.id);
    if (r) {
      r.ta.focus({ preventScroll: true });
      r.ta.select();
      try { r.el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); } catch { /* old browsers */ }
    }
  }

  function downloadSrt() {
    const p = store.project;
    let srt = '';
    try {
      // Re-timed to the trim so it lines up with the exported video.
      srt = toSRT(buildCaptionChunks(transcript()), { trim: p.edit.trim });
    } catch (err) {
      console.error('[captions panel] srt failed', err);
    }
    if (!srt.trim()) {
      toast('There are no captions inside the trimmed video.', { type: 'error' });
      return;
    }
    downloadBlob(new Blob([srt], { type: 'application/x-subrip;charset=utf-8' }), `${slugify(p.title)}.srt`);
    toast('Captions downloaded', { type: 'success' });
  }

  /* Sync ----------------------------------------------------------- */

  function syncSettings() {
    const c = captions();
    enabled.set(c.enabled);
    for (const [id, card] of styleCards) {
      const on = id === c.style;
      card.classList.toggle('active', on);
      card.setAttribute('aria-pressed', String(on));
    }
    position.set(c.position);
    size.set(c.size);
    styleSection.classList.toggle('is-off', !c.enabled);
    placementSection.classList.toggle('is-off', !c.enabled);
  }

  function sync() {
    if (destroyed) return;
    syncSettings();
    renderList();
  }

  sync();
  offs.push(store.onChange(sync));
  offs.push(store.onUI((ui, keys) => {
    if (destroyed) return;
    if (keys.includes('selectedCaptionId')) updateSelected(true);
    if (!player && keys.includes('time')) updateActive(Number(ui.time) || 0);
  }));
  if (player?.on) offs.push(player.on('time', (t) => { if (!destroyed) updateActive(t); }));

  const markUserScroll = () => { lastUserScroll = performance.now(); };
  el.addEventListener('wheel', markUserScroll, { passive: true });
  el.addEventListener('touchmove', markUserScroll, { passive: true });

  // Rows are built before the panel is attached; size them once they have a width.
  let ro = null;
  let growRaf = 0;
  const growSoon = () => {
    if (growRaf) return;
    // Next frame, not inside the observer callback: growing changes the list's height (RO loop).
    growRaf = requestAnimationFrame(() => { growRaf = 0; if (!destroyed) growAll(); });
  };
  if (typeof ResizeObserver === 'function') {
    let lastWidth = 0;
    ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width || 0;
      if (destroyed || w === lastWidth) return;
      lastWidth = w;
      growSoon();
    });
    ro.observe(list);
  } else {
    growSoon();
  }

  return {
    el,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off?.(); } catch { /* already gone */ } });
      el.removeEventListener('wheel', markUserScroll);
      el.removeEventListener('touchmove', markUserScroll);
      ro?.disconnect();
      if (growRaf) cancelAnimationFrame(growRaf);
      rows.clear();
    },
  };
}
