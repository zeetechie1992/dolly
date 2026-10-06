// Summary step: the auto-summarize driver (also called by the editor shell on mount)
// and the inspector panel that presents the summary.

import { h, formatTime, formatRelativeDate, copyText } from '../../lib/util.js';
import { icon } from '../../lib/icons.js';
import { toast } from '../../lib/ui.js';
import { generateSummary, summaryToMarkdown, transcriptHash } from '../summary.js';

/* ------------------------------------------------------------------ */
/* autoSummarize                                                       */
/* ------------------------------------------------------------------ */

/** store → in-flight run { controller, hash, promise } */
const runs = new WeakMap();

const hasText = (project) => Array.isArray(project?.transcript) && project.transcript.some((s) => String(s?.text ?? '').trim());

function safeHash(transcript) {
  try { return transcriptHash(transcript); } catch { return ''; }
}

function isAbort(err) {
  return err?.name === 'AbortError';
}

/**
 * Generates the summary when the transcript has text and there is no summary yet,
 * the transcript changed since it was written, or `force`. Drives
 * store.ui.summaryStatus / summaryError. Never rejects.
 * @param {object} store EditorStore
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<object|null>} the new summary, the current one when nothing was needed, or null
 */
export function autoSummarize(store, { force = false } = {}) {
  const project = store?.project;
  if (!project) return Promise.resolve(null);
  if (!hasText(project)) {
    // Nothing to summarize: stop a run of text that is gone so its late result can't
    // write back a summary of deleted words, and clear a status there is nothing to retry.
    const r = runs.get(store);
    if (r) {
      runs.delete(store);          // execute() now sees !current() and drops its result
      try { r.controller?.abort(); } catch { /* already settled */ }
    }
    const st = store.ui?.summaryStatus;
    if (r || st === 'loading' || st === 'error') store.setUI({ summaryStatus: 'idle', summaryError: null });
    return Promise.resolve(project.summary || null);
  }

  const hash = safeHash(project.transcript);
  const running = runs.get(store);
  if (running) {
    if (running.hash === hash) return running.promise;  // same transcript: one run is enough
    running.controller?.abort();                          // transcript changed mid-run: restart
    runs.delete(store);
  }
  const summary = project.summary;
  if (!force && summary && hash && summary.transcriptHash === hash) return Promise.resolve(summary);

  const run = { controller: typeof AbortController === 'function' ? new AbortController() : null, hash, promise: null };
  runs.set(store, run);
  run.promise = execute(store, run);
  return run.promise;
}

/**
 * Stops this store's in-flight summary run (auto or started from the panel) so it can
 * never write to the store again. Call when the editor unmounts: otherwise a late result
 * would setSummary/rename and the store's debounced save would write the editor's stale
 * project back to IndexedDB (resurrecting a deleted recording, or overwriting a rename or
 * a newer editor's edits). Leaves store.ui untouched; the store is not used afterwards.
 * @param {object} store EditorStore
 */
export function cancelAutoSummarize(store) {
  const run = store ? runs.get(store) : null;
  if (!run) return;
  runs.delete(store);         // execute() now sees !current() and drops whatever comes back
  try { run.controller?.abort(); } catch { /* already settled */ } // stop the request early
}

async function execute(store, run) {
  const current = () => runs.get(store) === run;
  store.setUI({ summaryStatus: 'loading', summaryError: null });
  try {
    const result = await generateSummary(store.project, { signal: run.controller?.signal });
    if (!current()) return null;
    if (!result || typeof result !== 'object') throw new Error('The summary came back empty.');
    const summary = { ...result, transcriptHash: result.transcriptHash || run.hash };
    store.setSummary(summary);
    store.setUI({ summaryStatus: 'idle', summaryError: null });
    return summary;
  } catch (err) {
    if (!current()) return null; // superseded: the newer run owns the status
    if (isAbort(err)) {
      store.setUI({ summaryStatus: 'idle', summaryError: null });
      return null;
    }
    console.warn('[summary] could not generate a summary', err);
    store.setUI({ summaryStatus: 'error', summaryError: err?.message || 'Something went wrong while writing the summary.' });
    return null;
  } finally {
    if (current()) runs.delete(store);
  }
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);

function chaptersOf(summary) {
  return (Array.isArray(summary?.chapters) ? summary.chapters : [])
    .map((c) => ({ start: Number(c?.start), title: String(c?.title ?? '').trim() }))
    .filter((c) => Number.isFinite(c.start) && c.title)
    .sort((a, b) => a.start - b.start);
}

/**
 * @param {{ store: object, player?: object|null }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createSummaryPanel({ store, player = null } = {}) {
  let destroyed = false;
  const offs = [];
  const root = h('div', { class: 'pn pn-summary' });
  const doneItems = new WeakMap();   // summary → Set of checked action-item indexes (visual only)
  const autoTried = new Set();       // transcript hashes this panel already kicked off
  let renderKey = '';
  let chapterRows = [];
  let currentChapter = -1;

  const currentTime = () => (player && Number.isFinite(player.time) ? player.time : Number(store.ui.time) || 0);

  function state() {
    const p = store.project;
    const has = hasText(p);
    const summary = p.summary && typeof p.summary === 'object' ? p.summary : null;
    const hash = has ? safeHash(p.transcript) : '';
    return {
      p,
      has,
      summary,
      hash,
      status: store.ui.summaryStatus || 'idle',
      error: store.ui.summaryError,
      stale: Boolean(summary && has && hash && summary.transcriptHash !== hash),
      // A summary of captions that have all been removed: nothing to update it from.
      orphan: Boolean(summary && !has),
    };
  }

  /* Pieces --------------------------------------------------------- */

  const btnIcon = (name, size = 14) => h('span', { class: 'pn-btn-icon', html: icon(name, size) });

  const eyebrow = () => h('div', { class: 'pn-sum-eyebrow' },
    h('span', { class: 'pn-sum-spark', html: icon('sparkles', 14) }),
    h('span', { class: 'pn-sum-eyebrow-text' }, 'Summary'));

  function block(title, content, className = '') {
    return h('section', { class: `pn-sum-block ${className}`.trim() }, h('h3', { class: 'section-title' }, title), content);
  }

  function emptyView() {
    return h('div', { class: 'empty-state pn-empty' },
      h('div', { class: 'empty-icon', html: icon('sparkles', 26) }),
      h('h3', {}, 'Nothing to summarize yet'),
      h('p', { class: 'pn-empty-text' },
        'Summaries are written from what you say. Record in Chrome with a microphone for a live transcript, or add captions yourself.'),
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => store.setUI({ step: 'captions' }) },
        btnIcon('captions', 15), 'Go to Captions'));
  }

  function readyView() {
    return h('div', { class: 'empty-state pn-empty' },
      h('div', { class: 'empty-icon', html: icon('sparkles', 26) }),
      h('h3', {}, 'Ready to summarize'),
      h('p', { class: 'pn-empty-text' }, 'Get a title, a TL;DR, key points and chapters from your transcript.'),
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => autoSummarize(store, { force: true }) },
        btnIcon('sparkles', 15), 'Write summary'));
  }

  function loadingView() {
    const line = (w, hgt = 12) => h('div', { class: 'skeleton pn-sum-skel', style: { width: w, height: `${hgt}px` } });
    return [
      h('div', { class: 'pn-sum-hero-wrap is-loading' },
        h('div', { class: 'pn-sum-hero', 'aria-busy': 'true' },
          eyebrow(),
          h('div', { class: 'pn-sum-skel-stack pn-sum-skel-title' }, line('86%', 20), line('58%', 20)),
          h('div', { class: 'pn-sum-skel-stack' }, line('100%'), line('94%'), line('72%')),
          h('div', { class: 'pn-sum-status', role: 'status' }, h('span', { class: 'spinner pn-spinner-sm' }), 'Writing your summary…'))),
      block('Key points', h('div', { class: 'pn-sum-skel-stack' }, line('92%'), line('80%'), line('86%'))),
      block('Chapters', h('div', { class: 'pn-sum-skel-stack' }, line('70%', 14), line('62%', 14), line('76%', 14))),
    ];
  }

  function alertView({ kind, title, message, actionLabel, onAction, iconName = null }) {
    return h('div', { class: `pn-sum-alert is-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'pn-sum-alert-icon', html: icon(iconName || (kind === 'error' ? 'warning' : 'refresh'), 15) }),
      h('div', { class: 'grow' }, h('strong', {}, title), message ? h('p', {}, message) : null),
      h('button', { type: 'button', class: `btn btn-sm ${kind === 'error' ? 'btn-secondary' : 'btn-tinted'}`, onclick: onAction }, actionLabel));
  }

  function actionItem(summary, text, i) {
    let set = doneItems.get(summary);
    if (!set) doneItems.set(summary, (set = new Set()));
    const btn = h('button', { type: 'button', class: 'pn-sum-action', 'aria-pressed': String(set.has(i)) },
      h('span', { class: 'pn-sum-check', html: icon('check', 12, { strokeWidth: 2.6 }) }),
      h('span', { class: 'pn-sum-action-text' }, text));
    btn.classList.toggle('is-done', set.has(i));
    btn.addEventListener('click', () => {
      if (set.has(i)) set.delete(i); else set.add(i);
      btn.classList.toggle('is-done', set.has(i));
      btn.setAttribute('aria-pressed', String(set.has(i)));
    });
    return h('li', {}, btn);
  }

  function summaryView(summary, p) {
    const out = [];
    const tldr = String(summary.tldr ?? '').trim();
    out.push(h('div', { class: 'pn-sum-hero-wrap' },
      h('article', { class: 'pn-sum-hero' },
        eyebrow(),
        h('h2', { class: 'pn-sum-title' }, String(summary.title ?? '').trim() || p.title || 'Untitled recording'),
        tldr ? h('p', { class: 'pn-sum-tldr' }, tldr) : null)));

    const points = strings(summary.key_points);
    if (points.length) out.push(block('Key points', h('ul', { class: 'pn-sum-points' }, points.map((t) => h('li', {}, t)))));

    const items = strings(summary.action_items);
    if (items.length) out.push(block('Action items', h('ul', { class: 'pn-sum-actions' }, items.map((t, i) => actionItem(summary, t, i)))));

    const chapters = chaptersOf(summary);
    if (chapters.length) {
      chapterRows = chapters.map((c, i) => {
        const btn = h('button', {
          type: 'button',
          class: 'pn-sum-chapter',
          'aria-label': `Chapter ${i + 1}: ${c.title}, at ${formatTime(c.start)}`,
          onclick: () => {
            player?.seek(c.start);
            highlightChapter(c.start);
          },
        },
        h('span', { class: 'pn-sum-chapter-time' }, formatTime(c.start)),
        h('span', { class: 'pn-sum-chapter-title' }, c.title));
        return { start: c.start, el: btn };
      });
      out.push(block('Chapters', h('ol', { class: 'pn-sum-chapters' }, chapterRows.map((r) => h('li', {}, r.el)))));
    }
    return out;
  }

  function footerView(summary, has) {
    const badge = h('span', { class: 'badge pn-sum-badge' }, h('span', { html: icon('sparkles', 11, { strokeWidth: 2 }) }), 'Auto summary');
    const when = Number(summary.generatedAt) > 0 ? h('span', { class: 'pn-sum-meta' }, formatRelativeDate(summary.generatedAt)) : null;
    return h('footer', { class: 'pn-sum-footer' },
      h('div', { class: 'pn-sum-source' }, badge, when),
      h('div', { class: 'pn-sum-buttons' },
        h('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm grow',
          disabled: !has,
          onclick: () => autoSummarize(store, { force: true }),
        }, btnIcon('refresh'), 'Regenerate'),
        // No transcript: the summary describes words that are gone, so don't offer to share it.
        has ? h('button', { type: 'button', class: 'btn btn-primary btn-sm grow', onclick: copyMarkdown }, btnIcon('copy'), 'Copy Markdown') : null));
  }

  async function copyMarkdown() {
    const s = store.project.summary;
    if (!s || !hasText(store.project)) return;
    let md = '';
    try { md = summaryToMarkdown(s, store.project); } catch (err) { console.error('[summary] markdown failed', err); }
    const ok = md ? await copyText(md) : false;
    toast(ok ? 'Summary copied as Markdown' : 'Couldn’t copy the summary', { type: ok ? 'success' : 'error' });
  }

  /* Render --------------------------------------------------------- */

  function render(force = false) {
    if (destroyed) return;
    const v = state();
    const key = [
      v.has, v.status, v.stale, v.orphan,
      v.summary ? `${v.summary.generatedAt}|${v.summary.title}|${v.summary.source}` : '-',
      v.status === 'error' ? v.error : '',
    ].join('§');
    if (!force && key === renderKey) return;
    renderKey = key;
    chapterRows = [];
    currentChapter = -1;

    const parts = [];
    const loading = v.status === 'loading';
    if (loading) {
      parts.push(...loadingView());
    } else if (!v.summary && !v.has) {
      parts.push(emptyView());
    } else {
      if (v.orphan) {
        // Checked first: with no transcript, "Try again" / "Update" could do nothing.
        parts.push(alertView({
          kind: 'info',
          iconName: 'info',
          title: 'Transcript is empty',
          message: 'This summary was written from captions you’ve since removed.',
          actionLabel: 'Remove summary',
          onAction: () => store.setSummary(null),
        }));
      } else if (v.status === 'error') {
        parts.push(alertView({
          kind: 'error',
          title: 'Couldn’t write the summary',
          message: v.error || 'Please try again.',
          actionLabel: 'Try again',
          onAction: () => autoSummarize(store, { force: true }),
        }));
      } else if (v.stale) {
        parts.push(alertView({
          kind: 'info',
          title: 'Transcript changed',
          message: 'Update the summary to match your edits.',
          actionLabel: 'Update',
          onAction: () => autoSummarize(store),
        }));
      }
      if (v.summary) parts.push(...summaryView(v.summary, v.p));
      else if (v.status !== 'error') parts.push(maybeAutoStart(v) ? loadingView() : readyView());
    }

    const bodyEl = h('div', { class: 'pn-sum-body' }, parts);
    if (v.summary && !loading) root.replaceChildren(bodyEl, footerView(v.summary, v.has));
    else root.replaceChildren(bodyEl);
    highlightChapter(currentTime());
  }

  /** Transcript but no summary yet (e.g. captions were just written): start one, once per transcript. */
  function maybeAutoStart(v) {
    if (!v.has || v.summary || v.status !== 'idle' || autoTried.has(v.hash)) return false;
    autoTried.add(v.hash);
    // Deferred: autoSummarize updates store.ui synchronously, which re-renders this panel.
    queueMicrotask(() => { if (!destroyed) autoSummarize(store); });
    return true;
  }

  function highlightChapter(t) {
    if (!chapterRows.length) return;
    let idx = -1;
    for (let i = 0; i < chapterRows.length; i++) {
      if (chapterRows[i].start <= t + 0.05) idx = i;
      else break;
    }
    if (idx === currentChapter) return;
    if (currentChapter >= 0) {
      const prev = chapterRows[currentChapter]?.el;
      prev?.classList.remove('is-current');
      prev?.removeAttribute('aria-current');
    }
    currentChapter = idx;
    const el = idx >= 0 ? chapterRows[idx].el : null;
    el?.classList.add('is-current');
    el?.setAttribute('aria-current', 'true');
  }

  // Transcript emptied (now or before this panel opened): stop a run of the removed text and
  // drop an error there is nothing to retry. autoSummarize only touches store.ui when needed.
  let hadText = hasText(store.project);
  if (!hadText) queueMicrotask(() => { if (!destroyed && !hasText(store.project)) autoSummarize(store); });

  render(true);
  offs.push(store.onChange(() => {
    if (destroyed) return;
    const has = hasText(store.project);
    const emptied = hadText && !has;
    hadText = has;
    if (emptied) autoSummarize(store); // its setUI re-renders via onUI
    render();
  }));
  offs.push(store.onUI((ui, keys) => {
    if (keys.includes('summaryStatus') || keys.includes('summaryError')) render();
    if (!player && keys.includes('time')) highlightChapter(Number(ui.time) || 0);
  }));
  if (player?.on) offs.push(player.on('time', (t) => { if (!destroyed) highlightChapter(t); }));

  return {
    el: root,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off?.(); } catch { /* already gone */ } });
      chapterRows = [];
    },
  };
}
