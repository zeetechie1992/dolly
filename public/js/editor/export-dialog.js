// Export dialog: settings → live progress → done (download, captions, summary) or error.

import { h, clamp, formatTime, formatBytes, slugify, downloadBlob, copyText } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { openModal, toast } from '../lib/ui.js';
import { getAspect, trimmedDuration } from '../lib/project.js';
import { supportedFormats, exportVideo, getExportSize, EXPORT_RESOLUTIONS } from './exporter.js';
import { CAPTION_STYLES, buildCaptionChunks, toSRT } from './captions.js';
import { summaryToMarkdown, transcriptHash } from './summary.js';

const PREFS_KEY = 'dolly.export';
const FORMAT_INFO = {
  mp4: { label: 'MP4', hint: 'Best compatibility — plays everywhere' },
  webm: { label: 'WebM', hint: 'Smaller files, made for the web' },
};
const PREVIEW_LONG_SIDE = 720;   // backing px of the live preview
const PREVIEW_EVERY = 6;         // copy one of every N exported frames into the preview
const MIN_DURATION = 0.2;

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function savePrefs(state) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ format: state.format, resolution: state.resolution, captions: state.burnCaptions }));
  } catch { /* storage unavailable */ }
}

const hasText = (transcript) => Array.isArray(transcript) && transcript.some((s) => typeof s?.text === 'string' && s.text.trim());

/** The summary was written for a different transcript (captions edited since). */
function summaryIsStale(project) {
  const stamp = project.summary?.transcriptHash;
  if (!stamp) return false;
  try {
    return stamp !== transcriptHash(project.transcript);
  } catch {
    return false;
  }
}

function humanDuration(sec) {
  if (!(sec > 0)) return 'a moment';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} sec`;
  return `${Math.max(1, Math.round(sec / 60))} min`;
}

function etaText(sec) {
  if (!Number.isFinite(sec)) return '';
  if (sec < 1.5) return 'Finishing…';
  if (sec < 10) return 'A few seconds left';
  if (sec < 57.5) return `About ${Math.ceil(sec / 5) * 5} sec left`;
  return `About ${Math.max(1, Math.round(sec / 60))} min left`;
}

function describeCause(cause) {
  if (!cause) return '';
  if (typeof cause === 'string') return cause;
  const text = [cause.name, cause.message].filter(Boolean).join(': ');
  if (text) return text;
  return cause.code ? `Media error ${cause.code}` : '';
}

/** Mirrors progress into the tab title, then puts back whatever title is current. */
function createTitleTracker() {
  let base = null;
  let last = null;
  return {
    set(text) {
      if (base === null || document.title !== last) base = document.title;
      last = `${text} · ${base}`;
      document.title = last;
    },
    restore() {
      if (base !== null && document.title === last) document.title = base;
      base = null;
      last = null;
    },
  };
}

/** Apple-style segmented control. */
function segmented({ label, options, value, onChange }) {
  const el = h('div', { class: 'segmented ex-seg', role: 'group', 'aria-label': label });
  const buttons = options.map((o) => h('button', {
    type: 'button',
    class: o.value === value ? 'active' : '',
    'aria-pressed': String(o.value === value),
    disabled: Boolean(o.disabled),
    title: o.title || null,
    onclick: () => select(o.value),
  }, o.label));
  el.append(...buttons);
  function select(v) {
    buttons.forEach((b, i) => {
      const on = options[i].value === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    onChange(v);
  }
  return el;
}

function settingRow({ title, sub, control, disabled = false }) {
  return h('div', { class: `ex-row${disabled ? ' is-disabled' : ''}` },
    h('div', { class: 'ex-row-text' }, h('span', { class: 'ex-row-title' }, title), sub),
    h('div', { class: 'ex-row-control' }, control));
}

function actionRow({ iconName, tone, title, sub, onClick, disabled = false, badge = null }) {
  const subEl = h('span', { class: 'ex-action-sub' }, sub);
  const trail = h('span', { class: 'ex-action-trail' });
  const resetTrail = () => {
    trail.replaceChildren();
    if (badge) trail.append(h('span', { class: 'badge' }, badge));
    else trail.innerHTML = icon('chevron-right', 16);
  };
  resetTrail();
  let timer = 0;
  const api = {
    el: null,
    flash(text) {
      clearTimeout(timer);
      subEl.textContent = text;
      trail.innerHTML = icon('check', 16, { strokeWidth: 2.4 });
      api.el.classList.add('is-done');
      timer = setTimeout(() => {
        subEl.textContent = sub;
        resetTrail();
        api.el.classList.remove('is-done');
      }, 2200);
    },
  };
  api.el = h('button', {
    type: 'button',
    class: 'ex-action',
    disabled,
    onclick: () => onClick?.(api),
  },
  h('span', { class: `ex-tile is-${tone}`, html: icon(iconName, 17) }),
  h('span', { class: 'ex-action-text' }, h('span', { class: 'ex-action-title' }, title), subEl),
  trail);
  return api;
}

function hero({ badge, title, text, extra = null }) {
  return h('div', { class: 'ex-hero' }, badge, h('h3', { class: 'ex-hero-title' }, title), text ? h('p', { class: 'ex-hero-text' }, text) : null, extra);
}

/**
 * Opens the export modal for a project.
 * @param {{ project: object, mainBlob: Blob|string, cameraBlob?: Blob|string|null }} opts
 */
/**
 * @param {{ project, mainBlob, cameraBlob?, onShare?: () => void }} opts
 *   onShare — opens the Share dialog (offered on the done screen when the recording has no link yet).
 */
export function openExportDialog({ project, mainBlob, cameraBlob = null, onShare = null } = {}) {
  if (!project?.edit) throw new TypeError('openExportDialog: a project is required');

  const formats = supportedFormats();
  const supportedIds = new Set(formats.map((f) => f.id));
  const prefs = loadPrefs();
  const aspect = getAspect(project.edit.aspect);
  const duration = trimmedDuration(project);
  const state = {
    format: supportedIds.has(prefs.format) ? prefs.format : (formats[0]?.id || 'mp4'),
    resolution: EXPORT_RESOLUTIONS.some((r) => r.value === prefs.resolution) ? prefs.resolution : 1080,
    burnCaptions: prefs.captions !== false,
  };

  let job = null;      // { ctrl, ui } while an export runs
  let result = null;   // { blob, mimeType, extension, filename, width, height }
  let closed = false;
  let modal = null;
  const titleTracker = createTitleTracker();
  const root = h('div', { class: 'ex-root' });

  // Render before openModal so its autofocus lands on our primary button.
  if (formats.length) showSettings();
  else showUnsupported();

  modal = openModal({
    title: 'Export video',
    description: `${formatTime(duration)} · ${aspect.name} ${aspect.id}`,
    content: root,
    width: '560px',
    onClose: handleClosed,
  });
  modal.el.classList.add('ex-modal');
  const backdrop = modal.el.parentElement;
  const closeBtn = modal.el.querySelector('.modal-header button[aria-label="Close"]');

  // While exporting, Escape / backdrop / ✕ ask before cancelling instead of closing outright.
  // Window capture runs before openModal's own document-level handlers.
  window.addEventListener('keydown', guardKeys, true);
  window.addEventListener('mousedown', guardBackdrop, true);
  modal.el.addEventListener('click', guardCloseButton, true);
  window.addEventListener('hashchange', onHashChange);

  function isTopModal() {
    const all = document.querySelectorAll('.modal-backdrop');
    return all[all.length - 1] === backdrop;
  }

  function guardKeys(e) {
    if (e.key !== 'Escape' || !job || !isTopModal()) return;
    e.stopPropagation();
    e.preventDefault();
    job.ui.toggleConfirm();
  }

  function guardBackdrop(e) {
    if (!job || e.target !== backdrop) return;
    e.stopPropagation();
    e.preventDefault();
    job.ui.showConfirm();
  }

  function guardCloseButton(e) {
    if (!job || !closeBtn || !closeBtn.contains(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    job.ui.showConfirm();
  }

  function onHashChange() {
    // Leaving the editor closes an idle dialog; a running export keeps going.
    if (!job) modal.close();
  }

  function onBeforeUnload(e) {
    if (!job) return;
    e.preventDefault();
    e.returnValue = '';
  }

  function handleClosed() {
    closed = true;
    if (job) {
      job.ctrl.abort();
      job = null;
    }
    window.removeEventListener('keydown', guardKeys, true);
    window.removeEventListener('mousedown', guardBackdrop, true);
    window.removeEventListener('hashchange', onHashChange);
    window.removeEventListener('beforeunload', onBeforeUnload);
    modal.el.removeEventListener('click', guardCloseButton, true);
    titleTracker.restore();
    result = null;
  }

  function setView(node, focusEl = null) {
    root.replaceChildren(node);
    if (focusEl && modal) focusEl.focus({ preventScroll: true });
  }

  function captionInfo() {
    if (!hasText(project.transcript)) {
      return { available: false, hint: 'No transcript yet — add captions in the Captions step' };
    }
    if (project.edit.captions?.enabled === false) {
      return { available: false, hint: 'Captions are turned off in the Captions step' };
    }
    const style = CAPTION_STYLES.find((s) => s.id === project.edit.captions?.style);
    return { available: true, hint: style ? `Drawn onto the video · ${style.name} style` : 'Drawn onto the video' };
  }

  /* ---------------- settings ---------------- */

  function showSettings() {
    const formatHint = h('span', { class: 'ex-row-sub' });
    const sizeHint = h('span', { class: 'ex-row-sub ex-nums' });
    const caps = captionInfo();

    const updateFormat = () => {
      formatHint.textContent = supportedIds.has('mp4') ? FORMAT_INFO[state.format].hint : 'MP4 isn’t available in this browser';
    };
    const updateSize = () => {
      const { width, height } = getExportSize(project, state.resolution);
      const srcShort = Math.min(project.source?.width || 0, project.source?.height || 0);
      let text = `${width} × ${height} px`;
      if (srcShort > 0 && state.resolution > srcShort * 1.5) text += ` · upscaled from ${srcShort}p`;
      else if (state.resolution >= 2160) text += ' · best on a fast computer';
      sizeHint.textContent = text;
    };

    const formatSeg = segmented({
      label: 'Format',
      value: state.format,
      options: ['mp4', 'webm'].map((id) => ({
        value: id,
        label: FORMAT_INFO[id].label,
        disabled: !supportedIds.has(id),
        title: supportedIds.has(id) ? null : `${FORMAT_INFO[id].label} isn’t supported by this browser`,
      })),
      onChange: (v) => { state.format = v; savePrefs(state); updateFormat(); },
    });
    const resSeg = segmented({
      label: 'Resolution',
      value: state.resolution,
      options: EXPORT_RESOLUTIONS.map((r) => ({ value: r.value, label: r.label })),
      onChange: (v) => { state.resolution = v; savePrefs(state); updateSize(); },
    });
    const capInput = h('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': 'Burn in captions',
      checked: caps.available && state.burnCaptions,
      disabled: !caps.available,
      onchange: (e) => { state.burnCaptions = e.target.checked; savePrefs(state); },
    });
    updateFormat();
    updateSize();

    const tooShort = duration < MIN_DURATION;
    const exportBtn = h('button', {
      type: 'button',
      class: 'btn btn-primary ex-primary',
      autofocus: true,
      disabled: tooShort,
      onclick: startExport,
      html: `${icon('download', 16, { strokeWidth: 2 })}<span>Export</span>`,
    });

    const view = h('div', { class: 'ex-view' },
      h('div', { class: 'ex-group' },
        settingRow({ title: 'Format', sub: formatHint, control: formatSeg }),
        settingRow({ title: 'Resolution', sub: sizeHint, control: resSeg }),
        settingRow({
          title: 'Burn in captions',
          sub: h('span', { class: 'ex-row-sub' }, caps.hint),
          control: h('label', { class: 'switch' }, capInput, h('span')),
          disabled: !caps.available,
        })),
      h('div', { class: 'ex-note' },
        h('span', { class: 'ex-note-icon', html: icon(tooShort ? 'warning' : 'timer', 16) }),
        h('span', {}, tooShort
          ? 'The trimmed video is too short to export. Widen the trim on the timeline.'
          : `Export runs in real time — keep this tab open. It takes about ${humanDuration(duration)}.`)),
      h('div', { class: 'ex-footer' },
        h('div', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => modal.close() }, 'Cancel'),
        exportBtn));
    setView(view, exportBtn);
  }

  /* ---------------- exporting ---------------- */

  function showExporting() {
    const { width, height } = getExportSize(project, state.resolution);
    const k = PREVIEW_LONG_SIDE / Math.max(width, height);
    const preview = h('canvas', { class: 'ex-preview-canvas', 'aria-hidden': 'true' });
    preview.width = Math.max(2, Math.round(width * k));
    preview.height = Math.max(2, Math.round(height * k));
    const pctx = preview.getContext('2d', { alpha: false });
    if (pctx) pctx.imageSmoothingQuality = 'medium';
    const wait = h('div', { class: 'ex-preview-wait' }, h('div', { class: 'spinner' }));
    const frameBox = h('div', { class: 'ex-preview' }, preview, wait);
    frameBox.style.setProperty('--ex-ar', String(width / height));
    const live = h('span', { class: 'ex-live' }, 'Preparing');

    const pct = h('span', { class: 'ex-percent' }, '0%');
    const status = h('span', { class: 'ex-status' }, 'Preparing…');
    const eta = h('span', { class: 'ex-eta' });
    const fill = h('div', { style: { width: '0%' } });
    const bar = h('div', {
      class: 'progress ex-progress is-indeterminate',
      role: 'progressbar',
      'aria-label': 'Export progress',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    }, fill);
    const timeEl = h('span', { class: 'ex-nums' }, `0:00 / ${formatTime(duration)}`);
    const formatLabel = FORMAT_INFO[state.format]?.label || 'Video';

    const cancelBtn = h('button', { type: 'button', class: 'btn btn-secondary', onclick: cancelExport }, 'Cancel');
    const keepBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => hideConfirm() }, 'Keep exporting');
    const stopBtn = h('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: stopAndClose }, 'Stop export');
    const footer = h('div', { class: 'ex-footer' },
      h('span', { class: 'ex-footer-note' }, h('span', { html: icon('info', 14) }), 'Keep this tab open until it’s done'),
      h('div', { class: 'grow' }),
      cancelBtn);
    const confirm = h('div', { class: 'ex-confirm', role: 'alert', hidden: true },
      h('span', { class: 'ex-confirm-icon', html: icon('warning', 16) }),
      h('span', { class: 'ex-confirm-text' }, 'Stop the export and close?'),
      keepBtn,
      stopBtn);

    const view = h('div', { class: 'ex-view' },
      h('div', { class: 'ex-stage' }, live, frameBox),
      h('div', { class: 'ex-progress-wrap' },
        h('div', { class: 'ex-progress-head' },
          h('div', { class: 'ex-progress-title' }, pct, status),
          eta),
        bar,
        h('div', { class: 'ex-progress-foot' },
          timeEl,
          h('span', {}, `${formatLabel} · ${width} × ${height}`))),
      confirm,
      footer);
    setView(view, cancelBtn);

    let started = false;
    let shownFrame = false;
    let lastPct = -1;

    function showConfirm() {
      if (!confirm.hidden) return;
      confirm.hidden = false;
      footer.hidden = true;
      keepBtn.focus({ preventScroll: true });
    }
    function hideConfirm() {
      if (confirm.hidden) return;
      confirm.hidden = true;
      footer.hidden = false;
      cancelBtn.focus({ preventScroll: true });
    }

    return {
      showConfirm,
      hideConfirm,
      toggleConfirm: () => (confirm.hidden ? showConfirm() : hideConfirm()),
      progress(fraction, etaSec) {
        const f = clamp(Number(fraction) || 0, 0, 1);
        if (!started) {
          started = true;
          bar.classList.remove('is-indeterminate');
          status.textContent = 'Exporting';
          live.textContent = 'Rendering';
          live.classList.add('is-live');
        }
        const p = Math.floor(f * 100);
        fill.style.width = `${f * 100}%`;
        if (p !== lastPct) {
          lastPct = p;
          pct.textContent = `${p}%`;
          bar.setAttribute('aria-valuenow', String(p));
          titleTracker.set(`Exporting ${p}%`);
        }
        eta.textContent = f >= 0.995 ? 'Finishing…' : etaText(etaSec);
        timeEl.textContent = `${formatTime(f * duration)} / ${formatTime(duration)}`;
      },
      frame(canvas) {
        if (!pctx) return;
        try {
          pctx.drawImage(canvas, 0, 0, preview.width, preview.height);
        } catch {
          return;
        }
        if (!shownFrame) {
          shownFrame = true;
          wait.classList.add('is-hidden');
        }
      },
    };
  }

  function startExport() {
    if (job || closed || !formats.length) return;
    const ctrl = new AbortController();
    const ui = showExporting();
    const current = { ctrl, ui };
    job = current;
    window.addEventListener('beforeunload', onBeforeUnload);
    const { width, height } = getExportSize(project, state.resolution);
    let frames = 0;

    // Called synchronously from the click so the exporter's AudioContext inherits the user gesture.
    exportVideo({
      project,
      mainBlob,
      cameraBlob,
      format: state.format,
      resolution: state.resolution,
      showCaptions: captionInfo().available && state.burnCaptions,
      signal: ctrl.signal,
      onProgress: (fraction, etaSec) => { if (job === current) ui.progress(fraction, etaSec); },
      onFrame: (canvas) => {
        if (job !== current || document.hidden) return;
        if (frames++ % PREVIEW_EVERY === 0) ui.frame(canvas);
      },
    }).then((out) => {
      if (job !== current || closed) return;
      endJob();
      const filename = `${slugify(project.title)}${out.extension || ''}`;
      result = { ...out, filename, width, height };
      showDone();
      downloadBlob(out.blob, filename);
    }, (err) => {
      if (job !== current || closed) return;
      endJob();
      if (err?.name === 'AbortError') {
        showSettings();
        return;
      }
      console.error('[export] failed', err);
      showError(err);
    });
  }

  function endJob() {
    job = null;
    window.removeEventListener('beforeunload', onBeforeUnload);
    titleTracker.restore();
  }

  function cancelExport() {
    job?.ctrl.abort();
  }

  function stopAndClose() {
    job?.ctrl.abort();
    modal.close();
  }

  /* ---------------- done ---------------- */

  function showDone() {
    if (!result) return;
    const { blob, filename, width, height, extension } = result;
    const formatLabel = extension === '.mp4' ? 'MP4' : 'WebM';
    const check = h('div', { class: 'ex-check', html: icon('check', 38, { strokeWidth: 2.6 }) });

    const rows = [];
    if (hasText(project.transcript)) {
      rows.push(actionRow({
        iconName: 'captions',
        tone: 'orange',
        title: 'Download captions (.srt)',
        sub: 'Subtitles timed to this export',
        onClick: (row) => downloadCaptions(row),
      }).el);
    }
    // A summary of a transcript that has since been emptied describes nothing in this video.
    if (project.summary && hasText(project.transcript)) {
      rows.push(actionRow({
        iconName: 'sparkles',
        tone: 'accent',
        title: 'Copy summary',
        sub: summaryIsStale(project) ? 'Out of date: captions changed since it was written' : 'Markdown for Notion, Slack or email',
        onClick: (row) => copySummary(row),
      }).el);
    }
    const shareUrl = typeof project.share?.url === 'string' ? project.share.url : '';
    if (shareUrl) {
      rows.push(actionRow({
        iconName: 'link',
        tone: 'muted',
        title: 'Copy share link',
        sub: project.share?.settings?.hasPassword ? 'Only people with the password can watch' : 'Anyone with the link can watch in the browser',
        onClick: async (row) => {
          if (await copyText(shareUrl).catch(() => false)) row.flash('Link copied');
          else toast('Couldn’t copy the link.', { type: 'error' });
        },
      }).el);
    } else if (typeof onShare === 'function') {
      rows.push(actionRow({
        iconName: 'link',
        tone: 'muted',
        title: 'Create a share link',
        sub: 'A link anyone can watch in the browser',
        onClick: () => {
          modal.close();
          // Open once this dialog's backdrop is gone (one modal at a time).
          setTimeout(() => onShare(), 200);
        },
      }).el);
    }

    const doneBtn = h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => modal.close() }, 'Done');
    const view = h('div', { class: 'ex-view' },
      hero({
        badge: check,
        title: 'Your video is ready',
        text: null,
        extra: h('div', { class: 'ex-file' },
          h('span', { class: 'ex-file-name', title: filename }, filename),
          h('span', { class: 'ex-file-meta' },
            h('strong', {}, formatBytes(blob.size)),
            h('span', { class: 'ex-dot' }, '·'), formatLabel,
            h('span', { class: 'ex-dot' }, '·'), `${width} × ${height}`)),
      }),
      h('div', { class: 'ex-list' }, rows),
      h('div', { class: 'ex-footer' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => showSettings() }, 'Export again'),
        h('div', { class: 'grow' }),
        doneBtn,
        h('button', {
          type: 'button',
          class: 'btn btn-primary ex-primary',
          onclick: () => { if (result) downloadBlob(result.blob, result.filename); },
          html: `${icon('download', 16, { strokeWidth: 2 })}<span>Download again</span>`,
        })));
    setView(view, doneBtn);
  }

  function downloadCaptions(row) {
    const srt = toSRT(buildCaptionChunks(project.transcript), { trim: project.edit.trim });
    if (!srt.trim()) {
      toast('There are no captions inside the trimmed part of the video.');
      return;
    }
    downloadBlob(new Blob([srt], { type: 'application/x-subrip' }), `${slugify(project.title)}.srt`);
    row.flash('Downloaded');
  }

  async function copySummary(row) {
    const md = project.summary ? summaryToMarkdown(project.summary, project) : '';
    if (!md) {
      toast('There’s no summary to copy yet.');
      return;
    }
    const ok = await copyText(md);
    if (closed) return;
    if (ok) row.flash('Copied to clipboard');
    else toast('Couldn’t copy — the browser blocked clipboard access.', { type: 'error' });
  }

  /* ---------------- error / unsupported ---------------- */

  function showError(err) {
    const message = err?.message || 'Something went wrong while exporting.';
    const detail = describeCause(err?.cause);
    const retryBtn = h('button', {
      type: 'button',
      class: 'btn btn-primary ex-primary',
      onclick: startExport,
      html: `${icon('refresh', 16, { strokeWidth: 2 })}<span>Try again</span>`,
    });
    const view = h('div', { class: 'ex-view' },
      hero({
        badge: h('div', { class: 'ex-alert', html: icon('warning', 30) }),
        title: 'Export failed',
        text: message,
        extra: detail
          ? h('details', { class: 'ex-details' }, h('summary', {}, 'Technical details'), h('code', {}, detail))
          : null,
      }),
      h('div', { class: 'ex-footer' },
        h('div', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => showSettings() }, 'Back'),
        retryBtn));
    setView(view, retryBtn);
  }

  function showUnsupported() {
    const closeButton = h('button', { type: 'button', class: 'btn btn-primary', autofocus: true, onclick: () => modal.close() }, 'Close');
    const view = h('div', { class: 'ex-view' },
      hero({
        badge: h('div', { class: 'ex-alert is-neutral', html: icon('film', 30) }),
        title: 'Export isn’t available here',
        text: 'Dolly exports with your browser’s built-in video encoder, which this browser doesn’t provide. Try a recent version of Chrome, Edge or Arc.',
      }),
      h('div', { class: 'ex-footer' }, h('div', { class: 'grow' }), closeButton));
    setView(view, closeButton);
  }
}
