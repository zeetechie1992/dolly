// Editor view (#/edit/:id): top bar + stage (live preview) + inspector + timeline.
// Owns the lifecycle of the store, player, preview, timeline and inspector panels.

import { h, isTypingTarget, copyText } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { getProject, getMedia } from '../lib/db.js';
import { migrateProject } from '../lib/project.js';
import { toast, openModal } from '../lib/ui.js';
import { createStore } from '../editor/store.js';
import { Player } from '../editor/player.js';
import { createPreview } from '../editor/preview.js';
import { Timeline } from '../editor/timeline.js';
import { createDesignPanel } from '../editor/panels/design.js';
import { createZoomPanel, clearFrameCache } from '../editor/panels/zoom.js';
import { createCaptionsPanel } from '../editor/panels/captions.js';
import { createSummaryPanel, autoSummarize, cancelAutoSummarize } from '../editor/panels/summary.js';
import { openExportDialog } from '../editor/export-dialog.js';
import { openShareDialog } from '../editor/share-dialog.js';
import { subscribe as subscribeShareJob, attachShareStore } from '../editor/share.js';
import { clearBackgroundCache } from '../editor/backgrounds.js';

const STEPS = [
  { id: 'edit', label: 'Edit' },
  { id: 'captions', label: 'Captions' },
  { id: 'summary', label: 'Summary' },
];
const NARROW_WIDTH = 1000;
const NARROW_DISMISS_KEY = 'dolly.editor.narrowDismissed';
const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const SHIFT = IS_MAC ? '⇧' : 'Shift';
const DEL = IS_MAC ? '⌫' : 'Del';

/**
 * Mounts the editor. Returns its cleanup synchronously so the router can tear it
 * down even while the project is still loading.
 * @param {HTMLElement} container
 * @param {{ id: string }} params
 * @returns {() => Promise<void>}
 */
export function mount(container, { id } = {}) {
  const root = h('div', { class: 'ed-root is-loading', 'aria-busy': 'true' });
  container.append(root);

  const prevDocTitle = document.title;
  let disposed = false;
  let teardown = null; // set once the full editor is built

  renderLoading(root);
  load();

  async function load() {
    root.className = 'ed-root is-loading';
    root.setAttribute('aria-busy', 'true');
    renderLoading(root);

    let project;
    let mainBlob = null;
    let cameraBlob = null;
    try {
      const raw = id ? await getProject(id) : null;
      if (disposed) return;
      if (!raw) {
        renderState(root, {
          kind: 'not-found',
          iconName: 'film',
          title: 'Recording not found',
          message: 'It may have been deleted, or it was recorded in a different browser.',
        });
        return;
      }
      project = migrateProject(raw);
      document.title = `${project.title || 'Untitled'} · Dolly`;
      const wantsCamera = Boolean(project.source?.hasCamera) && project.mode !== 'cam';
      [mainBlob, cameraBlob] = await Promise.all([
        getMedia(project.id, 'main'),
        wantsCamera ? getMedia(project.id, 'camera').catch(() => null) : Promise.resolve(null),
      ]);
      if (disposed) return;
    } catch (err) {
      if (disposed) return;
      console.error('[editor] failed to load project', err);
      renderState(root, {
        kind: 'error',
        iconName: 'warning',
        title: 'Couldn’t open this recording',
        message: err?.message || 'Something went wrong while reading your library.',
        onRetry: load,
      });
      return;
    }

    if (!mainBlob) {
      renderState(root, {
        kind: 'error',
        iconName: 'film',
        title: 'This recording’s video is missing',
        message: 'The project exists, but its video file could not be found in this browser’s storage.',
      });
      return;
    }

    const store = createStore(project);
    let player;
    try {
      player = await Player.create({ project: store.project, mainBlob, cameraBlob: cameraBlob || null, store });
    } catch (err) {
      if (disposed) return;
      console.warn('[editor] failed to load media', err, err?.cause);
      renderState(root, {
        kind: 'error',
        iconName: 'warning',
        title: 'Couldn’t play this recording',
        message: `${err?.message || 'The video could not be decoded.'} Dolly works best in Chrome, Edge or Arc.`,
        onRetry: load,
      });
      return;
    }
    if (disposed) {
      player.destroy();
      return;
    }

    teardown = buildEditor(root, { store, player, mainBlob, cameraBlob: cameraBlob || null, onReload: reload });
  }

  /** "Reload" after a save conflict: drop this copy (unsaved edits included) and open the stored version. */
  async function reload() {
    const t = teardown;
    teardown = null;
    try {
      if (t) await t({ discard: true });
    } catch (err) {
      console.error('[editor] cleanup before reload failed', err);
    }
    if (!disposed) load();
  }

  return async function cleanup() {
    if (disposed) return;
    disposed = true;
    try {
      if (teardown) await teardown();
    } catch (err) {
      console.error('[editor] cleanup failed', err);
    }
    teardown = null;
    document.title = prevDocTitle;
    root.remove();
  };
}

/* ====================================================================== */
/* Full editor                                                             */
/* ====================================================================== */

function buildEditor(root, { store, player, mainBlob, cameraBlob, onReload }) {
  const offs = [];
  let destroyed = false;
  let timeline = null;
  let preview = null;
  let panel = null;
  let panelKey = '';
  let shortcutsModal = null;
  let shareDialog = null;
  let saveError = false;
  let saveFailed = false; // the last save attempt failed; stays set until a save succeeds
  let failedToasted = false; // the out-of-storage toast was shown since the last successful save
  let playErrorToasted = false;

  // Dirty tracking: only write on leave when something actually changed, so
  // merely opening a recording doesn't bump it to the top of the library.
  let changeSeq = 0;
  let savedSeq = 0;
  let saveStartSeq = 0;
  const isDirty = () => changeSeq !== savedSeq || store.ui.saving;

  /* ---------------------------------------------------------------- */
  /* Top bar                                                           */
  /* ---------------------------------------------------------------- */

  const backBtn = h('a', {
    class: 'btn btn-ghost btn-icon btn-sm ed-back',
    href: '#/',
    'aria-label': 'Back to library',
    'data-tip': 'Library',
    'data-tip-pos': 'bottom',
    html: icon('chevron-left', 18, { strokeWidth: 2.1 }),
  });

  const titleInput = h('input', {
    class: 'ed-title-input',
    type: 'text',
    size: '1', // intrinsic width must not inflate the auto-sizing field
    spellcheck: 'false',
    autocomplete: 'off',
    maxlength: '140',
    'aria-label': 'Recording title',
    placeholder: 'Untitled',
  });
  const titleField = h('label', { class: 'ed-title' }, titleInput);
  let titleCancelled = false;
  let titleAtFocus = null; // what the field showed when editing began (null when not editing)
  const normTitle = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  const saveEl = h('div', { class: 'ed-save', role: 'status', 'aria-live': 'polite' });

  const stepButtons = new Map();
  const stepper = h('div', { class: 'segmented ed-stepper', role: 'group', 'aria-label': 'Editor steps' },
    STEPS.map((step, i) => {
      const btn = h('button', {
        type: 'button',
        class: 'ed-step',
        'aria-keyshortcuts': String(i + 1),
        dataset: { step: step.id },
        onclick: () => setStep(step.id),
      },
      h('span', { class: 'ed-step-num' }, String(i + 1)),
      h('span', { class: 'ed-step-label' }, step.label),
      step.id === 'summary' ? h('span', { class: 'ed-step-busy', 'aria-hidden': 'true' }) : null);
      stepButtons.set(step.id, btn);
      return btn;
    }));

  const undoBtn = iconButton('undo', `Undo  ${MOD}Z`, () => store.undo());
  const redoBtn = iconButton('redo', `Redo  ${SHIFT}${MOD}Z`, () => store.redo());
  const keysBtn = iconButton('keyboard', 'Keyboard shortcuts  ?', () => openShortcuts());
  const shareBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary btn-sm ed-share',
    // Fixed name (the label is visually hidden at narrow widths).
    'aria-label': 'Share link',
    'aria-keyshortcuts': IS_MAC ? 'Meta+Shift+S' : 'Control+Shift+S',
    'data-tip': `Share  ${SHIFT}${MOD}S`,
    'data-tip-pos': 'bottom',
    html: `${icon('link', 15, { strokeWidth: 2 })}<span class="ed-share-label">Share</span>`,
    onclick: () => openShare(),
  });
  // Progress of a running share job (render → upload); opens the Share dialog.
  const shareRing = h('span', {
    class: 'sh-pill-ring',
    'aria-hidden': 'true',
    html: '<svg viewBox="0 0 20 20" width="18" height="18"><circle class="sh-pill-track" cx="10" cy="10" r="8"/><circle class="sh-pill-bar" cx="10" cy="10" r="8" pathLength="100"/></svg>',
  });
  const shareStateIcon = h('span', { class: 'sh-pill-icon', 'aria-hidden': 'true' });
  const sharePillLabel = h('span', { class: 'sh-pill-label' });
  const sharePill = h('button', {
    type: 'button',
    class: 'sh-pill',
    hidden: true,
    'data-tip': 'Keep this tab open while sharing',
    'data-tip-pos': 'bottom',
    onclick: () => openShare(),
  }, shareRing, shareStateIcon, sharePillLabel);
  const exportBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary btn-sm ed-export',
    // Fixed name: the label is visually hidden at narrow widths, and the hover tooltip's
    // ::after text must not leak into the accessible name.
    'aria-label': 'Export video',
    'aria-keyshortcuts': IS_MAC ? 'Meta+E' : 'Control+E',
    'data-tip': `Export  ${MOD}E`,
    'data-tip-pos': 'bottom',
    html: `${icon('download', 15, { strokeWidth: 2 })}<span class="ed-export-label">Export</span>`,
    onclick: () => openExport(),
  });

  const topbar = h('header', { class: 'nav ed-topbar' },
    h('div', { class: 'ed-top-left' }, backBtn, titleField, saveEl),
    h('div', { class: 'ed-top-center' }, stepper),
    h('div', { class: 'ed-top-right' },
      h('div', { class: 'ed-top-group' }, undoBtn, redoBtn, keysBtn),
      h('span', { class: 'ed-top-sep', 'aria-hidden': 'true' }),
      sharePill,
      shareBtn,
      exportBtn));

  /* ---------------------------------------------------------------- */
  /* Stage, inspector, timeline                                        */
  /* ---------------------------------------------------------------- */

  const stage = h('main', { class: 'ed-stage', 'aria-label': 'Preview' });
  const inspectorBody = h('div', { class: 'ed-inspector-body' });
  const inspector = h('aside', { class: 'ed-inspector', 'aria-label': 'Inspector' }, inspectorBody);
  const timelineHost = h('section', { class: 'ed-timeline', 'aria-label': 'Timeline' });

  root.className = 'ed-root is-ready';
  root.removeAttribute('aria-busy');
  root.replaceChildren(topbar, stage, inspector, timelineHost);

  try {
    preview = createPreview({ store, player });
    stage.append(preview.el);
  } catch (err) {
    console.error('[editor] preview failed', err);
    stage.append(inlineError('Preview unavailable', 'The live preview could not be started in this browser.'));
  }

  try {
    timeline = new Timeline({ store, player });
    if (timeline?.el) timelineHost.append(timeline.el);
  } catch (err) {
    console.error('[editor] timeline failed', err);
    timeline = null;
    timelineHost.append(h('div', { class: 'ed-timeline-error' }, h('span', { html: icon('warning', 15) }), 'The timeline could not be loaded.'));
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  function setStep(step) {
    if (!STEPS.some((s) => s.id === step)) return;
    store.setUI({ step });
  }

  function addZoom() {
    if (!timeline) return;
    setStep('edit');
    try { timeline.addZoomAtPlayhead(); } catch (err) { console.error('[editor] add zoom failed', err); }
  }

  function deleteSelectedZoom() {
    const zid = store.ui.selectedZoomId;
    if (!zid) return;
    if (timeline) {
      try { timeline.deleteSelected(); } catch (err) { console.error('[editor] delete zoom failed', err); }
      return;
    }
    store.update((p) => { p.edit.zooms = p.edit.zooms.filter((z) => z.id !== zid); });
    store.setUI({ selectedZoomId: null });
  }

  function runAutoZoom() {
    if (!timeline) {
      toast('Auto zoom isn’t available right now.', { type: 'error' });
      return undefined;
    }
    try {
      return timeline.runAutoZoom();
    } catch (err) {
      console.error('[editor] auto zoom failed', err);
      toast('Auto zoom couldn’t start.', { type: 'error' });
      return undefined;
    }
  }

  function openExport() {
    if (document.querySelector('.modal-backdrop')) return;
    player.pause();
    try {
      openExportDialog({ project: store.project, mainBlob, cameraBlob, onShare: () => openShare() });
    } catch (err) {
      console.error('[editor] export dialog failed', err);
      toast('Export couldn’t be opened.', { type: 'error' });
    }
  }

  function openShare() {
    if (shareDialog) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (store.saveBlocked === 'deleted') {
      toast('This recording was deleted in another tab, so it can’t be shared from here.', { type: 'error' });
      return;
    }
    player.pause();
    // The dialog shows a failed run's details; the pill has done its job.
    if (sharePill.dataset.state === 'error') hideSharePill();
    try {
      shareDialog = openShareDialog({ store, mainBlob, cameraBlob, onClose: () => { shareDialog = null; } });
    } catch (err) {
      shareDialog = null;
      console.error('[editor] share dialog failed', err);
      toast('Sharing couldn’t be opened.', { type: 'error' });
    }
  }

  function openShortcuts() {
    if (shortcutsModal) return;
    if (document.querySelector('.modal-backdrop')) return;
    shortcutsModal = openModal({
      title: 'Keyboard shortcuts',
      description: 'Edit without reaching for the mouse.',
      content: shortcutsSheet(),
      width: '600px',
      onClose: () => { shortcutsModal = null; },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Title                                                             */
  /* ---------------------------------------------------------------- */

  function syncTitle() {
    const title = store.project.title || '';
    if (document.activeElement !== titleInput) {
      if (titleInput.value !== title) titleInput.value = title;
    } else if (titleAtFocus !== null && titleInput.value !== title && normTitle(titleInput.value) === normTitle(titleAtFocus)) {
      // Focused but untouched (e.g. an undo/redo changed the title while the field had focus): show the
      // new title right away, keeping a select-all if there was one.
      const allSelected = titleInput.value.length > 0 && titleInput.selectionStart === 0 && titleInput.selectionEnd === titleInput.value.length;
      titleInput.value = title;
      titleAtFocus = title;
      if (allSelected) titleInput.select();
    }
    titleField.dataset.value = titleInput.value || titleInput.placeholder;
    const docTitle = `${title || 'Untitled'} · Dolly`;
    if (document.title !== docTitle) document.title = docTitle;
  }

  function commitTitle() {
    // Only an actual edit writes to the store. Otherwise a title that changed while the field
    // had focus (e.g. by undo/redo) would be overwritten with the stale text the field still showed.
    const edited = titleAtFocus === null || normTitle(titleInput.value) !== normTitle(titleAtFocus);
    titleAtFocus = null;
    if (titleCancelled) {
      titleCancelled = false;
      syncTitle();
      return;
    }
    const next = normTitle(titleInput.value);
    if (!edited || !next || next === store.project.title) {
      titleInput.value = store.project.title || '';
      syncTitle();
      return;
    }
    store.update((p) => { p.title = next; }, { reason: 'title' });
  }

  titleInput.addEventListener('focus', () => { titleAtFocus = titleInput.value; });
  titleInput.addEventListener('input', () => { titleField.dataset.value = titleInput.value || titleInput.placeholder; });
  titleInput.addEventListener('blur', commitTitle);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      titleCancelled = true;
      titleInput.value = store.project.title || '';
      titleInput.blur();
    }
  });

  /* ---------------------------------------------------------------- */
  /* Sharing                                                           */
  /* ---------------------------------------------------------------- */

  let shareState = null;
  let sharePillTimer = 0;

  function hideSharePill() {
    clearTimeout(sharePillTimer);
    sharePillTimer = 0;
    sharePill.hidden = true;
    sharePill.dataset.state = '';
  }

  function setSharePill(state, label, fraction = 0) {
    clearTimeout(sharePillTimer);
    sharePillTimer = 0;
    sharePill.hidden = false;
    sharePill.dataset.state = state;
    sharePillLabel.textContent = label;
    sharePill.setAttribute('aria-label', `${label}. Open sharing`);
    const bar = shareRing.querySelector('.sh-pill-bar');
    if (bar) bar.style.strokeDashoffset = String(100 - Math.round(Math.min(1, Math.max(0, fraction)) * 100));
    shareStateIcon.innerHTML = state === 'done' ? icon('check', 13, { strokeWidth: 2.6 }) : state === 'error' ? icon('warning', 13, { strokeWidth: 2.2 }) : '';
    sharePill.dataset.tip = state === 'working' ? 'Keep this tab open while sharing' : state === 'error' ? 'Sharing didn’t finish. Open for details' : 'Your link is ready';
  }

  /** Follows this recording's share job (it outlives the dialog, and this editor). */
  function onShareState(state) {
    if (destroyed) return;
    const prev = shareState;
    shareState = state;
    if (state.active) {
      const pct = Math.round(Math.min(1, Math.max(0, Number(state.progress) || 0)) * 100);
      const label = state.phase === 'rendering' ? `Rendering ${pct}%` : state.phase === 'uploading' ? `Uploading ${pct}%` : 'Preparing…';
      setSharePill('working', label, state.phase === 'poster' ? 1 : pct / 100);
      return;
    }
    // A run that ended before this editor opened has nothing to say here.
    if (!prev?.active) return;
    if (state.phase === 'done') {
      setSharePill('done', 'Link ready', 1);
      sharePillTimer = setTimeout(hideSharePill, 4000);
      if (!shareDialog) {
        const url = store.project.share?.id === state.shareId ? store.project.share.url : null;
        const copyBtn = url
          ? h('button', {
              type: 'button',
              class: 'sh-toast-btn',
              onclick: async () => {
                const ok = await copyText(url).catch(() => false);
                copyBtn.textContent = ok ? 'Copied' : 'Couldn’t copy';
              },
            }, 'Copy link')
          : null;
        toast(h('span', { class: 'sh-toast' }, h('span', {}, 'Your shared video is ready to watch'), copyBtn), { type: 'success', duration: 6000 });
      }
    } else if (state.phase === 'error') {
      if (shareDialog) hideSharePill();
      else {
        setSharePill('error', 'Sharing failed', 0);
        toast(`Sharing didn’t finish. ${state.error || ''}`.trim(), { type: 'error', duration: 6000 });
      }
    } else {
      hideSharePill();
    }
  }

  function syncShareButton() {
    const shared = Boolean(store.project.share);
    shareBtn.classList.toggle('is-shared', shared);
    shareBtn.dataset.tip = `${shared ? 'Manage link' : 'Share'}  ${SHIFT}${MOD}S`;
  }

  /* ---------------------------------------------------------------- */
  /* Status sync                                                       */
  /* ---------------------------------------------------------------- */

  let lastSaveState = '';
  function renderSave() {
    // store.saveBlocked outlives `saveError` (which every edit resets): while blocked, never "Saved".
    const blocked = store.saveBlocked;
    const state = blocked ? `error-${blocked}` : saveError ? 'error' : isDirty() ? 'saving' : 'saved';
    if (state === lastSaveState) return;
    lastSaveState = state;
    saveEl.dataset.state = blocked ? 'error' : state;
    if (state === 'error-deleted') {
      saveEl.title = 'This recording was deleted in another tab, so changes here can’t be saved.';
      saveEl.innerHTML = `${icon('warning', 13, { strokeWidth: 2 })}<span class="ed-save-label">Deleted</span>`;
    } else if (blocked) {
      saveEl.title = 'This recording changed in another tab. Reload it, or keep your version.';
      saveEl.innerHTML = `${icon('warning', 13, { strokeWidth: 2 })}<span class="ed-save-label">Not saved</span>`;
    } else if (state === 'error') {
      saveEl.title = 'Your latest changes couldn’t be saved. Check available storage.';
      saveEl.innerHTML = `${icon('warning', 13, { strokeWidth: 2 })}<span class="ed-save-label">Not saved</span>`;
    } else if (state === 'saving') {
      saveEl.title = '';
      // The spinner keeps the state visible when the label is visually hidden (narrow windows).
      saveEl.innerHTML = '<span class="spinner ed-save-spinner" aria-hidden="true"></span><span class="ed-save-label">Saving…</span>';
    } else {
      saveEl.title = 'All changes saved in this browser';
      saveEl.innerHTML = `${icon('check', 13, { strokeWidth: 2.4 })}<span class="ed-save-label">Saved</span>`;
    }
  }

  /*
   * Blocked saves (store.saveBlocked) get a banner over the stage:
   *   'conflict' — another tab saved this recording: Reload (open that version) or Keep mine (overwrite it).
   *   'deleted'  — it was deleted elsewhere: nothing can be saved, but it can still be exported.
   */
  let saveAlert = null;
  let saveAlertKey = '';
  let keepingMine = false;

  function syncSaveAlert() {
    if (destroyed) return;
    const reason = store.saveBlocked;
    const key = reason ? `${reason}:${keepingMine}` : '';
    if (key === saveAlertKey) return;
    saveAlertKey = key;
    const old = saveAlert;
    saveAlert = null;
    old?.remove();
    stage.classList.toggle('has-alert', Boolean(reason));
    if (!reason) return;

    const deleted = reason === 'deleted';
    const actions = deleted
      ? [h('a', { class: 'btn btn-secondary btn-sm', href: '#/' }, 'Back to library')]
      : [
          h('button', {
            type: 'button', class: 'btn btn-secondary btn-sm', disabled: keepingMine,
            'data-tip': 'Open the other tab’s version. Your changes here are discarded.', 'data-tip-pos': 'bottom',
            onclick: () => onReload?.(),
          }, 'Reload'),
          h('button', {
            type: 'button', class: 'btn btn-primary btn-sm', disabled: keepingMine,
            'data-tip': 'Save this version over the other one', 'data-tip-pos': 'bottom',
            onclick: () => keepMine(),
          }, keepingMine ? h('span', { class: 'spinner ed-alert-spinner', 'aria-hidden': 'true' }) : null, keepingMine ? 'Saving…' : 'Keep mine'),
        ];
    saveAlert = h('div', { class: `ed-alert is-${reason}`, role: 'alert' },
      h('span', { class: 'ed-alert-icon', html: icon(deleted ? 'trash' : 'warning', 16, { strokeWidth: 2 }) }),
      h('div', { class: 'ed-alert-text' },
        h('strong', {}, deleted ? 'This recording was deleted in another tab.' : 'This recording changed in another tab.'),
        h('span', {}, deleted ? ' Changes here can’t be saved, but you can still export it.' : ' Reload to see that version, or keep yours.')),
      h('div', { class: 'ed-alert-actions' }, actions));
    stage.append(saveAlert);
  }

  async function keepMine() {
    if (keepingMine || store.saveBlocked !== 'conflict') return;
    keepingMine = true;
    syncSaveAlert();
    let ok = false;
    try {
      ok = await store.keepMine();
    } catch (err) {
      console.error('[editor] keep mine failed', err);
    }
    keepingMine = false;
    if (destroyed) return;
    syncSaveAlert();
    renderSave();
    if (ok) toast('Your version was saved', { type: 'success' });
  }

  /** Leaving now would lose edits that are only in this tab. */
  function unsavedAtRisk() {
    const blocked = store.saveBlocked;
    if (blocked === 'deleted') return false; // nothing can be saved anyway
    if (blocked === 'conflict') return isDirty();
    return saveFailed;
  }

  function syncUndo() {
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
  }

  function syncStepper() {
    const step = store.ui.step;
    for (const [sid, btn] of stepButtons) {
      const active = sid === step;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    const busy = store.ui.summaryStatus === 'loading';
    stepButtons.get('summary')?.classList.toggle('is-busy', busy);
  }

  /* ---------------------------------------------------------------- */
  /* Inspector                                                         */
  /* ---------------------------------------------------------------- */

  function computePanelKey() {
    const { step, selectedZoomId } = store.ui;
    if (step === 'captions') return 'captions';
    if (step === 'summary') return 'summary';
    if (selectedZoomId && store.project.edit.zooms.some((z) => z.id === selectedZoomId)) return `zoom:${selectedZoomId}`;
    return 'design';
  }

  function createPanel(key) {
    try {
      let res;
      if (key === 'captions') res = createCaptionsPanel({ store, player });
      else if (key === 'summary') res = createSummaryPanel({ store, player });
      else if (key.startsWith('zoom:')) res = createZoomPanel({ store, player, onDelete: deleteSelectedZoom });
      else res = createDesignPanel({ store, player, onAutoZoom: runAutoZoom, autoZoomJob: () => timeline?.autoZoomJob ?? null });
      if (res?.el instanceof Node) return res;
      throw new Error('panel factory returned no element');
    } catch (err) {
      console.error(`[editor] could not open the ${key.split(':')[0]} panel`, err);
      return { el: inlineError('Couldn’t load this panel', 'Try switching steps, or reload the page.'), destroy() {} };
    }
  }

  function syncInspector() {
    if (destroyed) return;
    const key = computePanelKey();
    if (key === panelKey) return;
    panelKey = key;
    const old = panel;
    panel = null;
    if (old) {
      try { old.destroy?.(); } catch (err) { console.error('[editor] panel cleanup failed', err); }
      old.el?.remove();
    }
    const next = createPanel(key);
    panel = next;
    const wrap = h('div', { class: 'ed-panel', dataset: { panel: key.split(':')[0] } }, next.el);
    inspectorBody.replaceChildren(wrap);
    inspector.scrollTop = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Narrow-window banner                                              */
  /* ---------------------------------------------------------------- */

  let banner = null;
  let bannerSpent = readSession(NARROW_DISMISS_KEY) === '1';
  function syncBanner() {
    const narrow = window.innerWidth < NARROW_WIDTH;
    if (narrow && !banner && !bannerSpent) {
      bannerSpent = true; // warn once per editor session
      const close = h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-icon btn-sm ed-banner-close',
        'aria-label': 'Dismiss',
        html: icon('x', 14),
        onclick: () => {
          writeSession(NARROW_DISMISS_KEY, '1');
          hideBanner();
        },
      });
      banner = h('div', { class: 'ed-banner', role: 'note' },
        h('span', { class: 'ed-banner-icon', html: icon('expand', 15) }),
        h('span', {}, 'The editor works best in a wider window.'),
        close);
      stage.append(banner);
    } else if (!narrow && banner) {
      hideBanner();
    }
  }
  function hideBanner() {
    if (!banner) return;
    const b = banner;
    banner = null;
    b.classList.add('is-leaving');
    setTimeout(() => b.remove(), 200);
  }
  let resizeRaf = 0;
  const onResize = () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (!destroyed) syncBanner();
    });
  };

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  function onKeyDown(e) {
    if (destroyed || e.defaultPrevented || e.isComposing) return;
    if (isTypingTarget(e)) return;
    if (document.querySelector('.modal-backdrop')) return;
    const target = e.target instanceof Element ? e.target : null;
    const key = e.key;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && !e.altKey) {
      const k = key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (k === 'y' && !IS_MAC && !e.shiftKey) {
        e.preventDefault();
        store.redo();
      } else if (k === 'e' && !e.shiftKey) {
        e.preventDefault();
        openExport();
      } else if (k === 's' && e.shiftKey) {
        e.preventDefault();
        openShare();
      }
      return;
    }
    if (mod || e.altKey) return;

    switch (key) {
      case ' ':
      case 'Spacebar': {
        if (target?.matches('input[type="checkbox"], input[type="radio"]')) return;
        e.preventDefault();
        // Otherwise the focused button would also be "clicked" on keyup.
        if (target?.matches('button, a, [role="button"]')) target.blur();
        if (!e.repeat) player.toggle();
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (target?.matches('input[type="range"], [role="slider"]')) return;
        e.preventDefault();
        const delta = (key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1);
        player.seek(player.time + delta);
        return;
      }
      case 'z':
      case 'Z':
        if (e.shiftKey || e.repeat) return;
        e.preventDefault();
        addZoom();
        return;
      case 'Delete':
      case 'Backspace':
        if (!store.ui.selectedZoomId) return;
        e.preventDefault();
        deleteSelectedZoom();
        return;
      case 'Escape':
        if (store.ui.selectedZoomId || store.ui.selectedCaptionId) {
          e.preventDefault();
          store.setUI({ selectedZoomId: null, selectedCaptionId: null });
        }
        return;
      case '1':
      case '2':
      case '3':
        e.preventDefault();
        setStep(STEPS[Number(key) - 1].id);
        return;
      case '?':
        e.preventDefault();
        openShortcuts();
        return;
      default:
    }
  }

  /* ---------------------------------------------------------------- */
  /* Persistence                                                       */
  /* ---------------------------------------------------------------- */

  const onBeforeUnload = (e) => {
    if (isDirty() && !store.saveBlocked) store.flush().catch(() => {});
    // The last save failed (or saving is paused by a conflict), so these edits will very
    // likely be lost: ask before throwing them away.
    if (unsavedAtRisk()) {
      e.preventDefault();
      e.returnValue = ''; // older Chromium builds need this to show the dialog
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && isDirty() && !store.saveBlocked) store.flush().catch(() => {});
  };

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  offs.push(store.onChange(() => {
    changeSeq++;
    saveError = false;
    renderSave();
    syncUndo();
    syncTitle();
    syncShareButton();
    syncInspector(); // the selected zoom may have just been removed
  }));
  offs.push(store.onUI((ui, keys) => {
    if (keys.includes('saving')) {
      if (ui.saving) saveStartSeq = changeSeq;
      renderSave();
    }
    if (keys.includes('step') || keys.includes('summaryStatus')) syncStepper();
    if (keys.includes('step') || keys.includes('selectedZoomId')) syncInspector();
  }));
  offs.push(store.on('saved', () => {
    savedSeq = saveStartSeq;
    saveError = false;
    saveFailed = false;
    failedToasted = false;
    renderSave();
    syncSaveAlert();
  }));
  // err.reason: 'failed' (storage error; retried on the next edit) | 'conflict' | 'deleted'
  // (blocked: the store re-emits on every save attempt, so only the banner reacts to those).
  offs.push(store.on('save-error', (err) => {
    const reason = err?.reason || store.saveBlocked || 'failed';
    saveError = true;
    saveFailed = reason !== 'deleted';
    renderSave();
    syncSaveAlert();
    if (reason === 'failed' && !failedToasted) {
      failedToasted = true;
      toast('Couldn’t save your changes. Your browser may be out of storage.', { type: 'error', duration: 4200 });
    }
  }));
  offs.push(player.on('error', (err) => {
    if (playErrorToasted) return;
    playErrorToasted = true;
    const blocked = err?.name === 'NotAllowedError';
    toast(blocked ? 'Playback was blocked by the browser. Press play to try again.' : 'This recording couldn’t be played.', { type: 'error' });
  }));

  // Share jobs persist link state through this store while the editor is open.
  offs.push(attachShareStore(store));
  offs.push(subscribeShareJob(store.project.id, onShareState));

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibility);

  syncTitle();
  syncShareButton();
  renderSave();
  syncSaveAlert(); // another tab may have written while this one was loading
  syncUndo();
  syncStepper();
  syncInspector();
  syncBanner();

  // Kick off the summary now so it's ready by step 3 (cached by transcript hash).
  if (store.project.transcript?.length) {
    try {
      Promise.resolve(autoSummarize(store)).catch((err) => console.warn('[editor] auto summary failed', err));
    } catch (err) {
      console.warn('[editor] auto summary failed', err);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * @param {{ discard?: boolean }} [opts] discard — drop unsaved edits without saving or
   *   warning (the user chose "Reload" after a conflict).
   */
  return async function destroy({ discard = false } = {}) {
    if (destroyed) return;
    destroyed = true;
    try { cancelAutoSummarize(store); } catch (err) { console.error('[editor] summary cancel failed', err); }
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('visibilitychange', onVisibility);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    titleInput.removeEventListener('blur', commitTitle);
    // Keep an in-progress title edit.
    if (!discard && document.activeElement === titleInput) commitTitle();
    offs.splice(0).forEach((off) => { try { off(); } catch { /* already removed */ } });
    shortcutsModal?.close();
    shortcutsModal = null;
    // A running share job keeps going (share.js); only the dialog closes.
    shareDialog?.close();
    shareDialog = null;
    clearTimeout(sharePillTimer);

    const safe = (label, fn) => { try { fn(); } catch (err) { console.error(`[editor] ${label} cleanup failed`, err); } };
    safe('panel', () => panel?.destroy?.());
    panel = null;
    safe('timeline', () => timeline?.destroy?.());
    timeline = null;
    safe('preview', () => preview?.destroy());
    preview = null;
    safe('player', () => player.destroy());
    // Module-level caches hold full-size canvases and video frames; the next editor rebuilds them.
    safe('background cache', () => clearBackgroundCache());
    safe('zoom stills', () => clearFrameCache());

    const blocked = store.saveBlocked;
    if (discard) {
      // Nothing to save: the user chose the other tab's version.
    } else if (blocked) {
      // A blocked store never writes, so don't try; say what happened to edits made here.
      if (blocked === 'conflict' && isDirty()) {
        toast('Your latest edits weren’t saved because this recording changed in another tab.', { type: 'error', duration: 10000 });
      }
    } else if (isDirty() || saveError || saveFailed) {
      // flush() never rejects (the store reports failures as 'save-error'), and our own
      // listeners are already gone, so watch this last save directly.
      let failed = false;
      const offErr = store.on('save-error', () => { failed = true; });
      try {
        await store.flush();
      } catch (err) {
        failed = true;
        console.error('[editor] final save failed', err);
      } finally {
        offErr();
      }
      // The toast stack lives on <body>, so this stays visible in the next view.
      if (failed) {
        const why = store.saveBlocked === 'deleted' ? 'This recording was deleted in another tab.'
          : store.saveBlocked === 'conflict' ? 'This recording changed in another tab.'
          : 'Your browser may be out of storage.';
        toast(`Your latest edits couldn’t be saved. ${why}`, { type: 'error', duration: 10000 });
      }
    }
    // Stop listening for other tabs' writes (after the final save, which may still need them).
    safe('store', () => store.destroy());
  };
}

/* ====================================================================== */
/* Loading / empty states                                                  */
/* ====================================================================== */

function renderLoading(root) {
  const line = (cls, style) => h('div', { class: `skeleton ${cls}`, style });
  const topbar = h('header', { class: 'nav ed-topbar' },
    h('div', { class: 'ed-top-left' },
      h('a', { class: 'btn btn-ghost btn-icon btn-sm ed-back', href: '#/', 'aria-label': 'Back to library', html: icon('chevron-left', 18, { strokeWidth: 2.1 }) }),
      line('ed-skel-title')),
    h('div', { class: 'ed-top-center' }, line('ed-skel-stepper')),
    h('div', { class: 'ed-top-right' }, line('ed-skel-btn'), line('ed-skel-btn ed-skel-btn-wide')));

  const stage = h('main', { class: 'ed-stage ed-skel-stage' },
    h('div', { class: 'ed-skel-canvas' }),
    h('div', { class: 'ed-skel-label' }, h('span', { class: 'spinner' }), 'Opening your recording…'));

  const inspector = h('aside', { class: 'ed-inspector ed-skel-inspector', 'aria-hidden': 'true' },
    h('div', { class: 'ed-skel-section' },
      line('ed-skel-heading'),
      h('div', { class: 'ed-skel-grid' }, line('ed-skel-card'), line('ed-skel-card'), line('ed-skel-card'), line('ed-skel-card'))),
    h('div', { class: 'ed-skel-section' },
      line('ed-skel-heading'),
      line('ed-skel-seg')),
    h('div', { class: 'ed-skel-section' },
      line('ed-skel-heading'),
      h('div', { class: 'ed-skel-swatches' }, Array.from({ length: 12 }, () => line('ed-skel-swatch')))),
    h('div', { class: 'ed-skel-section' },
      line('ed-skel-heading'),
      line('ed-skel-row'), line('ed-skel-row'), line('ed-skel-row')));

  const timeline = h('section', { class: 'ed-timeline ed-skel-timeline', 'aria-hidden': 'true' },
    h('div', { class: 'ed-skel-toolbar' }, line('ed-skel-chip'), line('ed-skel-chip ed-skel-chip-wide'), line('ed-skel-chip')),
    line('ed-skel-track ed-skel-track-video'),
    line('ed-skel-track'));

  root.replaceChildren(topbar, stage, inspector, timeline);
}

function renderState(root, { kind, iconName, title, message, onRetry }) {
  root.className = `ed-root is-state is-${kind}`;
  root.removeAttribute('aria-busy');
  const actions = h('div', { class: 'ed-state-actions' },
    h('a', { class: `btn ${onRetry ? 'btn-secondary' : 'btn-primary'}`, href: '#/', html: `${icon('arrow-left', 16)}<span>Back to library</span>` }),
    onRetry ? h('button', { type: 'button', class: 'btn btn-primary', html: `${icon('refresh', 16)}<span>Try again</span>`, onclick: onRetry }) : null);
  root.replaceChildren(
    h('header', { class: 'nav ed-state-nav' },
      h('a', { class: 'btn btn-ghost btn-icon btn-sm ed-back', href: '#/', 'aria-label': 'Back to library', html: icon('chevron-left', 18, { strokeWidth: 2.1 }) }),
      h('a', { class: 'logo ed-state-logo', href: '#/', 'aria-label': 'Dolly home' }, h('span', { class: 'logo-mark' }), 'Dolly')),
    h('div', { class: 'ed-state-body' },
      h('div', { class: 'empty-state ed-state-card' },
        h('div', { class: 'empty-icon', html: icon(iconName, 26) }),
        h('h3', {}, title),
        h('p', {}, message),
        actions)));
}

function inlineError(title, message) {
  return h('div', { class: 'empty-state ed-inline-error' },
    h('div', { class: 'empty-icon', html: icon('warning', 22) }),
    h('h3', {}, title),
    h('p', {}, message));
}

/* ====================================================================== */
/* Shortcuts sheet                                                         */
/* ====================================================================== */

function shortcutsSheet() {
  const groups = [
    {
      title: 'Playback',
      rows: [
        [[['Space']], 'Play / pause'],
        [[['←']], 'Back 1 second'],
        [[['→']], 'Forward 1 second'],
        [[[SHIFT, '←']], 'Back 5 seconds'],
        [[[SHIFT, '→']], 'Forward 5 seconds'],
      ],
    },
    {
      title: 'Editing',
      rows: [
        [[['Z']], 'Add zoom at playhead'],
        [[[DEL]], 'Delete selected zoom'],
        [[['Esc']], 'Deselect'],
        [[[MOD, 'Z']], 'Undo'],
        [IS_MAC ? [[SHIFT, MOD, 'Z']] : [[MOD, 'Y'], [SHIFT, MOD, 'Z']], 'Redo'],
      ],
    },
    {
      title: 'Steps',
      rows: [
        [[['1']], 'Edit'],
        [[['2']], 'Captions'],
        [[['3']], 'Summary'],
      ],
    },
    {
      title: 'General',
      rows: [
        [[[MOD, 'E']], 'Export video'],
        [[[SHIFT, MOD, 'S']], 'Share link'],
        [[['?']], 'Show shortcuts'],
      ],
    },
  ];
  const combo = (keys) => h('span', { class: 'ed-sc-combo' }, keys.map((k) => h('kbd', { class: 'kbd' }, k)));
  return h('div', { class: 'ed-shortcuts' }, groups.map((g) => h('section', { class: 'ed-sc-group' },
    h('h4', { class: 'ed-sc-title' }, g.title),
    g.rows.map(([combos, label]) => h('div', { class: 'ed-sc-row' },
      h('span', { class: 'ed-sc-label' }, label),
      h('span', { class: 'ed-sc-keys' }, combos.flatMap((c, i) => (i ? [h('span', { class: 'ed-sc-or' }, 'or'), combo(c)] : [combo(c)]))))))));
}

/* ====================================================================== */
/* Helpers                                                                 */
/* ====================================================================== */

function iconButton(name, tip, onclick) {
  return h('button', {
    type: 'button',
    class: 'btn btn-ghost btn-icon btn-sm ed-icon-btn',
    'aria-label': tip.split('  ')[0],
    'data-tip': tip,
    'data-tip-pos': 'bottom',
    html: icon(name, 17),
    onclick,
  });
}

function readSession(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function writeSession(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
