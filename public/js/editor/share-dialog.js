// Share dialog.
//   Not shared yet → preview card + link settings → "Create link" (the link works at once and
//   shows "Processing" to viewers while this tab renders and uploads the video).
//   Shared → link (Copy / Open), processing progress or "Ready to watch" with views and comments,
//   "You've edited since sharing" → Update video (same URL), settings (saved as you toggle),
//   embed code, Delete link.
// The render/upload job lives in share.js, so this dialog can close and reopen while it runs.

import { h, clamp, uid, debounce, formatTime, formatRelativeDate, copyText } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { openModal, confirmDialog, toast } from '../lib/ui.js';
import { getAspect, getBackground, trimmedDuration } from '../lib/project.js';
import { getShareConfig, createShare, getOwnerView, updateShare, deleteShare } from '../lib/share-api.js';
import { supportedFormats } from './exporter.js';
import {
  buildSharePayload, videoHash, metaHash, shareMetaPatch, shareTrim, shareLayout, pickShareSettings,
  getOwnerName, setOwnerName, runShareJob, subscribe, cancelShareJob, clearShareJob,
  setProjectShare, persistShare, shareJobLockHeld, shareSummaryHidden, SHARE_RESOLUTION,
} from './share.js';

const DEFAULTS_KEY = 'dolly.shareDefaults';
const SHARE_KEY_KEY = 'dolly.shareKey';
const SETTINGS_DEBOUNCE_MS = 400;
const NAME_DEBOUNCE_MS = 700;
const POLL_MS = 5000;
const COPIED_MS = 1800;
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
const TOGGLES = ['showSummary', 'showTranscript', 'allowComments', 'allowDownload'];
const SUMMARY_TRIMMED_SUB = 'Chapters only — the summary covers parts you trimmed';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function readJSON(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function readText(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function writeText(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const hasText = (transcript) => Array.isArray(transcript) && transcript.some((s) => typeof s?.text === 'string' && s.text.trim());
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
/** The link is gone, or this browser's owner token no longer works for it. */
const isGone = (status) => status === 404 || status === 401 || status === 403;
/**
 * A gone/forbidden answer from Dolly's share API itself — not from a server without share
 * routes (an older Dolly or a plain static server: an HTML 404 with no JSON body, or server.py's
 * generic `{ error: 'not found' }` for routes it doesn't know). Only this may drop the owner token.
 */
const isGoneReply = (err) => isGone(err?.status) && typeof err?.data?.error === 'string'
  && !/^\s*not found\.?\s*$/i.test(err.data.error);

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

function phaseText(phase, pct = null) {
  const n = pct === null ? '' : ` ${pct}%`;
  if (phase === 'rendering') return `Rendering${n}…`;
  if (phase === 'poster') return 'Preparing the preview…';
  if (phase === 'uploading') return `Uploading${n}…`;
  if (phase === 'done') return 'Ready to watch';
  return '';
}

function isLoopbackUrl(url) {
  try {
    const host = new URL(url, location.href).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

const escapeAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Same iframe attributes as the viewer's "Copy embed code" (title for screen readers, autoplay). */
function embedSnippet(url, width, height, title) {
  const w = Math.max(1, Math.round(num(width, 16)));
  const ht = Math.max(1, Math.round(num(height, 9)));
  return `<iframe src="${escapeAttr(url)}" title="${escapeAttr(String(title || '').trim() || 'Dolly video')}" style="aspect-ratio:${w}/${ht};width:100%;border:0" allow="autoplay; fullscreen; picture-in-picture; clipboard-write" allowfullscreen></iframe>`;
}

/** Labelled switch row; the whole row toggles. */
function switchRow({ iconName, tone, title, sub, checked = false, disabled = false, onChange }) {
  const id = uid('sh_');
  const input = h('input', { type: 'checkbox', role: 'switch', id, 'aria-labelledby': `${id}-t`, 'aria-describedby': `${id}-s` });
  input.checked = Boolean(checked);
  input.disabled = Boolean(disabled);
  const subEl = h('span', { class: 'sh-row-sub', id: `${id}-s` }, sub);
  const el = h('label', { class: `sh-row${disabled ? ' is-disabled' : ''}`, for: id },
    h('span', { class: `sh-tile is-${tone}`, html: icon(iconName, 16) }),
    h('span', { class: 'sh-row-text' }, h('span', { class: 'sh-row-title', id: `${id}-t` }, title), subEl),
    h('span', { class: 'switch' }, input, h('span', { 'aria-hidden': 'true' })));
  input.addEventListener('change', () => onChange?.(input.checked));
  return {
    el,
    input,
    set(v) { input.checked = Boolean(v); },
    setSub(text) { subEl.textContent = text; },
    setDisabled(d) {
      input.disabled = Boolean(d);
      el.classList.toggle('is-disabled', Boolean(d));
    },
  };
}

/** Row with a text field on the right. */
function fieldRow({ iconName, tone, title, hint, input }) {
  return h('div', { class: 'sh-row sh-field-row' },
    h('span', { class: `sh-tile is-${tone}`, html: icon(iconName, 16) }),
    h('span', { class: 'sh-row-text' },
      h('label', { class: 'sh-row-title', for: input.id }, title),
      hint ? h('span', { class: 'sh-row-sub' }, hint) : null),
    input);
}

function passwordField({ placeholder, label }) {
  const input = h('input', {
    class: 'input sh-pw-input', type: 'password', placeholder, maxlength: '200',
    autocomplete: 'new-password', spellcheck: 'false', 'aria-label': label,
  });
  const eye = h('button', { type: 'button', class: 'sh-pw-eye', 'aria-label': 'Show password', 'aria-pressed': 'false', html: icon('eye', 16) });
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.innerHTML = icon(show ? 'eye-off' : 'eye', 16);
  });
  return { el: h('div', { class: 'sh-pw' }, input, eye), input };
}

function notice({ iconName = 'info', tone = 'accent', children }) {
  return h('div', { class: `sh-notice is-${tone}` },
    h('span', { class: 'sh-notice-icon', html: icon(iconName, 15) }),
    h('span', { class: 'sh-notice-text' }, children));
}

function localOnlyNotice(text) {
  return notice({
    iconName: 'monitor',
    tone: 'orange',
    children: [h('strong', {}, text), ' — see README → Sharing publicly.'],
  });
}

function hero({ tone = 'accent', iconName, title, text, actions = [] }) {
  return h('div', { class: 'sh-view sh-hero' },
    h('div', { class: `sh-hero-icon is-${tone}`, html: icon(iconName, 26) }),
    h('h3', { class: 'sh-hero-title' }, title),
    text ? h('p', { class: 'sh-hero-text' }, text) : null,
    actions.length ? h('div', { class: 'sh-hero-actions' }, actions) : null);
}

function button(label, { iconName = null, variant = 'secondary', size = 'sm', onClick } = {}) {
  return h('button', {
    type: 'button',
    class: `btn btn-${variant}${size ? ` btn-${size}` : ''}`,
    html: `${iconName ? icon(iconName, 15) : ''}<span>${label}</span>`,
    onclick: onClick,
  });
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

/**
 * Opens the Share dialog for the editor's project.
 * @param {{ store: object, mainBlob: Blob, cameraBlob?: Blob|null, onClose?: () => void }} opts
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openShareDialog({ store, mainBlob, cameraBlob = null, onClose } = {}) {
  if (!store?.project?.edit) throw new TypeError('openShareDialog: an editor store is required');
  const projectId = store.project.id;
  const project = () => store.project;
  const share = () => store.project.share || null;
  const formats = supportedFormats();

  let closed = false;
  let mode = '';
  let view = null;           // the current view's hooks: { update, onConfig, dispose }
  let config = null;
  let configError = null;
  let configPromise = null;
  let createPrefill = null;  // form state to restore when (re)building the create view
  let owner = null;          // OwnerView of the current link
  let ownerError = null;
  let ownerSeq = 0;
  let pollTimer = 0;
  let job = null;            // latest job state for the current link
  let elsewhere = false;     // another tab is rendering/uploading for the current link (its Web Lock is held)
  let metaSyncing = false;
  let modal = null;
  let descEl = null;
  let description = share() ? 'Anyone with the link can watch.' : 'Create a link anyone can watch — no account needed.';

  const viewHost = h('div', { class: 'sh-view-host' });
  const live = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const root = h('div', { class: 'sh-root' }, viewHost, live);
  const announce = (text) => {
    live.textContent = '';
    if (text) setTimeout(() => { live.textContent = text; }, 30);
  };

  // Render first so openModal's autofocus lands inside the content.
  if (share()) showShared();
  else showLoading();

  modal = openModal({
    title: 'Share',
    description,
    content: root,
    width: '600px',
    onClose: handleClosed,
  });
  modal.el.classList.add('sh-modal');
  descEl = modal.el.querySelector('.modal-header p');
  setDescription(description);

  // A confirm dialog opened from here sits on top; Escape must only close that one.
  const guardKeys = (e) => {
    if (e.key !== 'Escape' || closed) return;
    const backdrops = document.querySelectorAll('.modal-backdrop');
    const top = backdrops[backdrops.length - 1];
    if (top && top !== modal.el.parentElement) {
      e.stopImmediatePropagation();
      e.preventDefault();
      top.querySelector('.modal-footer .btn-secondary')?.click();
    }
  };
  window.addEventListener('keydown', guardKeys, true);

  const unsubscribe = subscribe(projectId, onJob);
  loadConfig();
  if (share()) loadOwner();

  return { el: modal.el, close: () => modal.close() };

  /* ---------------- lifecycle ---------------- */

  function setDescription(text) {
    description = text;
    if (descEl && descEl.textContent !== text) descEl.textContent = text;
  }

  function handleClosed() {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', guardKeys, true);
    unsubscribe();
    clearTimeout(pollTimer);
    const v = view;
    view = null;
    try { v?.dispose?.(); } catch (err) { console.error('[share] dialog cleanup failed', err); }
    try { onClose?.(); } catch (err) { console.error(err); }
  }

  function setView(name, el, hooks = {}) {
    const old = view;
    view = null;
    try { old?.dispose?.(); } catch (err) { console.error('[share] view cleanup failed', err); }
    clearTimeout(pollTimer);
    pollTimer = 0;
    mode = name;
    view = hooks;
    viewHost.replaceChildren(el);
  }

  /** Moves focus into the new view unless the user is already somewhere useful. */
  function focusSoon(el) {
    if (!el) return;
    requestAnimationFrame(() => {
      if (closed || !el.isConnected) return;
      const active = document.activeElement;
      const header = modal?.el.querySelector('.modal-header');
      if (!active || active === document.body || !active.isConnected || header?.contains(active) || !modal?.el.contains(active)) {
        el.focus({ preventScroll: true });
      }
    });
  }

  function onJob(state) {
    if (!state || state.shareId !== share()?.id) return;
    const prev = job;
    job = state;
    if (state.phase === 'done' && state.ownerView) {
      owner = state.ownerView;
      ownerError = null;
    }
    if (state.phase === 'error' && isGone(state.errorStatus)) {
      if (mode === 'shared') showGone();
      return;
    }
    if (state.active) elsewhere = false; // this tab's job takes over the link's upload
    if (prev?.active && !state.active) {
      if (state.phase === 'done') announce('Your video is ready to watch.');
      else if (state.phase === 'error') announce('Sharing didn’t finish.');
      if (state.phase !== 'done') loadOwner({ quiet: true });
    }
    view?.update?.();
    // The PATCH that follows an upload may have failed (or the edit changed meanwhile): re-send.
    if (state.phase === 'done' && prev?.active && owner) syncMetadata();
  }

  /* ---------------- data ---------------- */

  function loadConfig() {
    if (configPromise) return configPromise;
    configPromise = (async () => {
      try {
        config = await getShareConfig();
        configError = null;
      } catch (err) {
        configError = err;
      } finally {
        configPromise = null;
      }
      if (closed) return;
      if (mode === 'loading' || mode === 'error') {
        if (config && !configError) showCreate();
        else showError(configError);
      } else {
        view?.onConfig?.();
      }
    })();
    return configPromise;
  }

  async function loadOwner({ quiet = false } = {}) {
    const s = share();
    if (!s || closed) return;
    const seq = ++ownerSeq;
    clearTimeout(pollTimer);
    pollTimer = 0;
    if (!quiet && !owner) {
      ownerError = null;
      view?.update?.();
    }
    try {
      const v = await getOwnerView(s.id, s.ownerToken);
      if (closed || seq !== ownerSeq || share()?.id !== s.id) return;
      // Another tab rendering/uploading for this link holds its Web Lock: don't offer an
      // upload here that would supersede (and so cancel) that one.
      let other = false;
      if (!(job?.active && job.shareId === s.id)) {
        other = await shareJobLockHeld(s.id);
        if (closed || seq !== ownerSeq || share()?.id !== s.id) return;
      }
      owner = v;
      elsewhere = other;
      ownerError = null;
      // The server is the source of truth for the link's address: it changes when
      // DOLLY_PUBLIC_URL is set or fixed after the link was created.
      const fresh = typeof v?.url === 'string' && /^https?:\/\//.test(v.url) ? v.url : '';
      const freshEmbed = typeof v?.embedUrl === 'string' && /^https?:\/\//.test(v.embedUrl) ? v.embedUrl : '';
      if ((fresh && fresh !== s.url) || (freshEmbed && freshEmbed !== s.embedUrl)) {
        await persistShare(projectId, s.id, (sh) => {
          if (fresh) sh.url = fresh;
          if (freshEmbed) sh.embedUrl = freshEmbed;
        });
        if (closed || seq !== ownerSeq || share()?.id !== s.id) return;
      }
    } catch (err) {
      if (closed || seq !== ownerSeq || share()?.id !== s.id) return;
      if (isGoneReply(err)) {
        showGone();
        return;
      }
      if (isGone(err.status)) {
        // Not the share API's answer: a server without share routes. Keep the link (and its token).
        err.message = 'This Dolly server doesn’t support share links. Restart it with the latest version (python3 server.py) to manage this link.';
      }
      ownerError = err;
    }
    view?.update?.();
    if (owner && !ownerError) syncMetadata();
    schedulePoll();
  }

  /** While the server still says "processing" and nothing renders here, check back now and then. */
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = 0;
    if (closed || mode !== 'shared' || job?.active) return;
    if (owner?.status === 'processing' || elsewhere) pollTimer = setTimeout(() => loadOwner({ quiet: true }), POLL_MS);
  }

  /**
   * Silently PATCHes title / summary / transcript / caption style when they changed since sharing,
   * plus the live video's layout/duration when the PATCH after its upload never landed (pendingMeta).
   */
  async function syncMetadata() {
    const s = share();
    // While another tab's job runs for this link, its own PATCH after the upload wins anyway.
    if (!s || metaSyncing || job?.active || elsewhere) return;
    const hash = metaHash(project());
    const pendingMeta = s.pendingMeta && typeof s.pendingMeta === 'object' ? s.pendingMeta : null;
    if (hash === s.metaHash && !pendingMeta) return;
    metaSyncing = true;
    try {
      // r_patch applies duration before it re-clips the transcript, so one request is enough.
      const v = await updateShare(s.id, s.ownerToken, { ...(pendingMeta || {}), ...shareMetaPatch(project(), s) });
      if (v && share()?.id === s.id) owner = v;
      await persistShare(projectId, s.id, (sh) => {
        sh.metaHash = hash;
        delete sh.pendingMeta;
      });
      if (!closed && share()?.id === s.id) view?.update?.();
    } catch (err) {
      console.warn('[share] metadata sync failed', err);
      if (isGoneReply(err) && !closed && mode === 'shared' && share()?.id === s.id) showGone();
    } finally {
      metaSyncing = false;
    }
  }

  function startJob(burnCaptions) {
    if (!share()) return;
    try {
      runShareJob(project(), { mainBlob, cameraBlob, burnCaptions: Boolean(burnCaptions) });
    } catch (err) {
      console.error('[share] could not start', err);
      toast(err?.message || 'Couldn’t start sharing.', { type: 'error' });
    }
  }

  function localOnly() {
    if (config && typeof config.isLocalOnly === 'boolean') return config.isLocalOnly;
    const url = share()?.url;
    return url ? isLoopbackUrl(url) : false;
  }

  /* ---------------- views: loading / error / gone ---------------- */

  function showLoading() {
    setView('loading', h('div', { class: 'sh-view sh-loading', 'aria-busy': 'true' },
      h('span', { class: 'spinner' }),
      h('span', {}, 'Connecting to your Dolly server…')));
  }

  function showError(err) {
    const status = err?.status;
    const unsupported = status === 404 || status === 405 || status === 501;
    const offline = !unsupported && (!err || status === 0 || status === undefined);
    const retry = button('Try again', {
      iconName: 'refresh', variant: 'primary', size: '',
      onClick: () => { showLoading(); loadConfig(); },
    });
    setView('error', hero({
      tone: 'red',
      iconName: 'warning',
      title: unsupported ? 'This server can’t make links yet' : offline ? 'Can’t reach the Dolly server' : 'Sharing isn’t available right now',
      text: unsupported
        ? 'This Dolly server doesn’t support share links. Restart it with the latest version (python3 server.py), then try again.'
        : offline
          ? 'Links are hosted by the Dolly server that serves this page. Make sure it’s still running (python3 server.py), then try again.'
          : (err?.message || 'Something went wrong. Try again in a moment.'),
      actions: [retry],
    }));
    setDescription('Create a link anyone can watch — no account needed.');
    focusSoon(retry);
  }

  function showGone() {
    const old = share();
    const prefill = old?.settings ? { ...pickShareSettings(old.settings), burnCaptions: Boolean(old.burnCaptions) } : null;
    const createNew = button('Create a new link', {
      iconName: 'link', variant: 'primary', size: '',
      onClick: async () => {
        createNew.disabled = true;
        cancelShareJob(projectId); // a render for the deleted link would only fail at upload
        await setProjectShare(projectId, null);
        clearShareJob(projectId);
        owner = null;
        ownerError = null;
        job = null;
        elsewhere = false;
        if (!closed) showCreateFlow(prefill);
      },
    });
    setView('gone', hero({
      tone: 'muted',
      iconName: 'link',
      title: 'This link no longer exists',
      text: 'It was deleted from the Dolly server, or this browser can no longer manage it. Your recording is fine — create a new link to share it again.',
      actions: [createNew],
    }));
    setDescription('Anyone with the link can watch.');
    focusSoon(createNew);
  }

  function showCreateFlow(prefill = null) {
    createPrefill = prefill;
    if (config && !configError) showCreate();
    else {
      showLoading();
      loadConfig();
    }
  }

  /* ---------------- view: create ---------------- */

  function showCreate() {
    const p = project();
    const prefill = createPrefill || {};
    createPrefill = null;
    const saved = { ...(readJSON(DEFAULTS_KEY) || {}), ...prefill };
    const canBurn = Boolean(p.edit.captions?.enabled) && hasText(p.transcript);
    const form = {
      showSummary: saved.showSummary !== false,
      showTranscript: saved.showTranscript !== false,
      allowComments: saved.allowComments !== false,
      allowDownload: saved.allowDownload === true,
      burnCaptions: saved.burnCaptions === true && canBurn,
      passwordOn: Boolean(prefill.passwordOn),
    };
    // keyRequired: this browser isn't on the server's machine and the server has a share key.
    // (canCreate may be true then too — it means "possible, with the key".)
    const needsKey = Boolean(config?.keyRequired);
    const blocked = Boolean(config && !config.canCreate && !config.keyRequired);
    let creating = false;

    // Preview card
    const aspect = getAspect(p.edit.aspect);
    const duration = trimmedDuration(p);
    const thumb = p.thumbnail
      ? h('img', { src: p.thumbnail, alt: '', draggable: 'false' })
      : h('div', { class: 'sh-thumb-ph', style: { background: getBackground(p.edit.background).css }, html: icon('film', 20) });
    const facts = [aspect.name, `${SHARE_RESOLUTION}p`];
    if (p.summary) facts.push('Summary');
    if (hasText(p.transcript)) facts.push('Captions');
    const preview = h('div', { class: 'sh-preview' },
      h('div', { class: 'sh-thumb' }, thumb, h('span', { class: 'sh-thumb-time' }, formatTime(duration))),
      h('div', { class: 'sh-preview-text' },
        h('div', { class: 'sh-preview-title' }, p.title || 'Untitled recording'),
        h('div', { class: 'sh-preview-meta' }, facts.map((f, i) => [i ? h('span', { class: 'sh-dot-sep', 'aria-hidden': 'true' }, '·') : null, h('span', {}, f)]))));

    // Settings
    const pw = passwordField({ placeholder: 'Choose a password', label: 'Password' });
    if (prefill.password) pw.input.value = prefill.password;
    const reveal = h('div', { class: 'sh-reveal', hidden: !form.passwordOn }, pw.el);
    const rows = {
      showSummary: switchRow({
        iconName: 'sparkles', tone: 'purple', title: 'Show summary',
        sub: !p.summary ? 'Appears once a summary is ready'
          : shareSummaryHidden(p) ? SUMMARY_TRIMMED_SUB : 'TL;DR, key points and chapters under the video',
        checked: form.showSummary, onChange: (v) => { form.showSummary = v; },
      }),
      showTranscript: switchRow({
        iconName: 'list', tone: 'blue', title: 'Show transcript',
        sub: hasText(p.transcript) ? 'A searchable transcript next to the video' : 'This recording has no transcript yet',
        checked: form.showTranscript, onChange: (v) => { form.showTranscript = v; },
      }),
      allowComments: switchRow({
        iconName: 'text', tone: 'green', title: 'Allow comments',
        sub: 'Viewers can leave comments and reactions',
        checked: form.allowComments, onChange: (v) => { form.allowComments = v; },
      }),
      allowDownload: switchRow({
        iconName: 'download', tone: 'teal', title: 'Allow download',
        sub: 'Viewers can save the video file',
        checked: form.allowDownload, onChange: (v) => { form.allowDownload = v; },
      }),
      password: switchRow({
        iconName: 'eye-off', tone: 'orange', title: 'Password protect',
        sub: 'Only people with the password can watch',
        checked: form.passwordOn,
        onChange: (v) => {
          form.passwordOn = v;
          reveal.hidden = !v;
          if (v) requestAnimationFrame(() => pw.input.focus());
        },
      }),
      burn: switchRow({
        iconName: 'captions', tone: 'accent', title: 'Burn captions into video',
        sub: canBurn ? 'Off: viewers can toggle your styled captions'
          : hasText(p.transcript) ? 'Turn on captions in step 2 to use this' : 'Needs captions — add them in step 2',
        checked: form.burnCaptions, disabled: !canBurn,
        onChange: (v) => { form.burnCaptions = v; },
      }),
    };
    const settingsGroup = h('div', { class: 'sh-group', role: 'group', 'aria-label': 'Link settings' },
      rows.showSummary.el, rows.showTranscript.el, rows.allowComments.el, rows.allowDownload.el,
      rows.password.el, reveal, rows.burn.el);

    // Name + key
    const nameInput = h('input', {
      class: 'input sh-field-input', id: uid('sh_'), type: 'text', placeholder: 'Shown to viewers',
      maxlength: '60', autocomplete: 'name', spellcheck: 'false',
    });
    nameInput.value = prefill.ownerName ?? getOwnerName();
    let keyInput = null;
    const fieldRows = [fieldRow({ iconName: 'user', tone: 'muted', title: 'Your name', hint: 'Optional', input: nameInput })];
    if (needsKey) {
      keyInput = h('input', {
        class: 'input sh-field-input', id: uid('sh_'), type: 'password', placeholder: 'Share key',
        autocomplete: 'off', spellcheck: 'false',
      });
      keyInput.value = prefill.key ?? readText(SHARE_KEY_KEY);
      fieldRows.push(fieldRow({ iconName: 'bolt', tone: 'orange', title: 'Share key', hint: 'This Dolly server asks for a key to create links', input: keyInput }));
    }
    const fieldsGroup = h('div', { class: 'sh-group' }, fieldRows);

    // Notices
    const notices = [];
    if (!formats.length) {
      notices.push(notice({ iconName: 'warning', tone: 'red', children: 'Sharing renders your video in this browser, which needs a recent Chrome, Edge or Arc.' }));
    }
    if (blocked) {
      notices.push(notice({ iconName: 'info', tone: 'accent', children: 'This Dolly server only creates links from the computer it runs on.' }));
    }
    if (localOnly()) notices.push(localOnlyNotice('Links you create here only work on this computer'));

    const errorEl = h('div', { class: 'sh-form-error', role: 'alert', hidden: true });
    const setError = (text) => {
      errorEl.hidden = !text;
      errorEl.replaceChildren(text ? h('span', { html: icon('warning', 15) }) : '', text || '');
    };

    // Footer
    const createLabel = h('span', {}, 'Create link');
    const createBtn = h('button', {
      type: 'button', class: 'btn btn-primary sh-create', disabled: blocked || !formats.length,
      html: icon('link', 16, { strokeWidth: 2 }),
    }, createLabel);
    createBtn.addEventListener('click', onCreate);
    const footer = h('div', { class: 'sh-footer' },
      h('p', { class: 'sh-footer-note' },
        h('span', { html: icon('clock', 14) }),
        h('span', {}, `Renders in real time (about ${humanDuration(duration)}). Keep this tab open until it’s uploaded.`)),
      createBtn);

    for (const input of [pw.input, nameInput, keyInput]) {
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          onCreate();
        }
      });
    }

    const viewEl = h('div', { class: 'sh-view sh-create-view' }, preview, settingsGroup, fieldsGroup, notices, errorEl, footer);
    setView('create', viewEl, {
      onConfig: () => {
        // A key requirement discovered on retry rebuilds the form, keeping what was typed.
        if (!creating && config && Boolean(config.keyRequired) !== needsKey) {
          createPrefill = snapshot();
          showCreate();
        }
      },
    });
    setDescription('Create a link anyone can watch — no account needed.');
    if (prefill.error) {
      setError(prefill.error);
      focusSoon(keyInput || createBtn);
    } else if (!blocked && formats.length) {
      focusSoon(createBtn);
    }

    function snapshot() {
      return { ...form, password: pw.input.value, ownerName: nameInput.value, key: keyInput ? keyInput.value : undefined };
    }

    function setBusy(busy) {
      createBtn.disabled = busy || blocked || !formats.length;
      createBtn.classList.toggle('is-busy', busy);
      createLabel.textContent = busy ? 'Creating…' : 'Create link';
      createBtn.innerHTML = busy ? '<span class="spinner sh-btn-spinner" aria-hidden="true"></span>' : icon('link', 16, { strokeWidth: 2 });
      createBtn.append(createLabel);
      viewEl.classList.toggle('is-busy', busy);
    }

    async function onCreate() {
      if (creating || blocked || !formats.length) return;
      setError(null);
      const password = form.passwordOn ? pw.input.value : '';
      if (form.passwordOn && !password.trim()) {
        setError('Enter a password, or turn off password protection.');
        pw.input.focus();
        return;
      }
      const key = keyInput ? keyInput.value.trim() : '';
      if (keyInput && !key) {
        setError('Enter the share key for this Dolly server.');
        keyInput.focus();
        return;
      }

      setOwnerName(nameInput.value);
      if (keyInput) writeText(SHARE_KEY_KEY, key);
      writeJSON(DEFAULTS_KEY, {
        showSummary: form.showSummary, showTranscript: form.showTranscript, allowComments: form.allowComments,
        allowDownload: form.allowDownload, burnCaptions: form.burnCaptions,
      });

      const proj = project();
      const burn = Boolean(form.burnCaptions && canBurn);
      const settings = {
        allowDownload: form.allowDownload, showSummary: form.showSummary,
        showTranscript: form.showTranscript, allowComments: form.allowComments,
      };
      if (form.passwordOn) settings.password = password;

      creating = true;
      setBusy(true);
      let res;
      try {
        res = await createShare({ ...buildSharePayload(proj, { burnCaptions: burn }), settings }, { key: key || undefined });
        if (!res?.id || !res.ownerToken || !res.url) throw Object.assign(new Error('The Dolly server sent an incomplete reply.'), { status: 502 });
      } catch (err) {
        creating = false;
        if (closed) {
          toast(`Couldn’t create the link. ${err?.message || ''}`.trim(), { type: 'error' });
          return;
        }
        setBusy(false);
        if (err?.status === 403 && err.data?.keyRequired) {
          config = { ...(config || {}), keyRequired: true };
          if (!keyInput) {
            createPrefill = { ...snapshot(), error: 'This Dolly server needs a share key to create links. Enter it below.' };
            showCreate();
            return;
          }
          setError('That share key wasn’t accepted. Check it and try again.');
          keyInput.focus();
          keyInput.select();
          return;
        }
        setError(err?.status === 0
          ? 'Couldn’t reach the Dolly server. Check that it’s running, then try again.'
          : (err?.message || 'Couldn’t create the link. Try again.'));
        return;
      }

      const created = res.share && typeof res.share === 'object' ? res.share : null;
      const next = {
        id: res.id,
        url: res.url,
        embedUrl: res.embedUrl || '',
        ownerToken: res.ownerToken,
        createdAt: num(created?.createdAt, 0) || Date.now(),
        version: 0,
        videoHash: null,
        metaHash: metaHash(proj),
        burnCaptions: burn,
        settings: pickShareSettings(created?.settings || { ...settings, hasPassword: Boolean(settings.password) }),
        trim: shareTrim(proj),
      };
      await setProjectShare(projectId, next);
      owner = created;
      ownerError = null;
      job = null;
      creating = false;

      // The link works right away (viewers see "Processing"); render + upload now.
      const forJob = project().share?.id === next.id ? project() : { ...project(), share: next };
      try {
        runShareJob(forJob, { mainBlob, cameraBlob, burnCaptions: burn });
      } catch (err) {
        console.error('[share] could not start the upload', err);
      }

      const copied = await copyText(next.url).catch(() => false);
      if (closed) {
        toast(copied ? 'Link copied. Your video is processing…' : 'Link created. Your video is processing…', { type: 'success' });
        return;
      }
      showShared({ copied });
    }
  }

  /* ---------------- view: shared ---------------- */

  function showShared({ copied = false } = {}) {
    const s0 = share();
    if (!s0) {
      showCreateFlow();
      return;
    }
    let burnNext = Boolean(s0.burnCaptions);
    const st = pickShareSettings(s0.settings);
    let pending = {};          // settings not sent yet
    let saving = 0;
    let savedTimer = 0;
    let copyTimer = 0;
    let pwEditing = false;
    let nameDirty = false;
    let statusKey = '';
    let statusRefs = null;
    let lastPhase = '';
    let bannerShown = null;    // '' | 'update' | 'elsewhere'

    /* Link */
    const linkInput = h('input', {
      class: 'sh-link-input', type: 'text', readonly: true, spellcheck: 'false', 'aria-label': 'Share link',
    });
    linkInput.value = s0.url;
    linkInput.addEventListener('focus', () => linkInput.select());
    linkInput.addEventListener('click', () => linkInput.select());
    const copyIcon = h('span', { class: 'sh-copy-icon', html: icon('copy', 15) });
    const copyLabel = h('span', {}, 'Copy link');
    const copyBtn = h('button', { type: 'button', class: 'btn btn-primary sh-copy', autofocus: true }, copyIcon, copyLabel);
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(share()?.url || s0.url).catch(() => false);
      if (ok) markCopied();
      else toast(`Couldn’t copy. Select the link and press ${IS_MAC ? '⌘C' : 'Ctrl+C'}.`, { type: 'error' });
    });
    const openBtn = h('a', {
      class: 'btn btn-secondary sh-open', href: s0.url, target: '_blank', rel: 'noopener noreferrer',
      'aria-label': 'Open the link in a new tab', html: `${icon('arrow-right', 15)}<span>Open</span>`,
    });
    const linkBox = h('div', { class: 'sh-link' },
      h('span', { class: 'sh-link-icon', html: icon('link', 16, { strokeWidth: 2 }) }),
      linkInput,
      h('div', { class: 'sh-link-actions' }, copyBtn, openBtn));

    function markCopied() {
      clearTimeout(copyTimer);
      copyBtn.classList.add('is-copied');
      copyIcon.innerHTML = icon('check', 15, { strokeWidth: 2.4 });
      copyLabel.textContent = 'Copied';
      announce('Link copied');
      copyTimer = setTimeout(() => {
        copyBtn.classList.remove('is-copied');
        copyIcon.innerHTML = icon('copy', 15);
        copyLabel.textContent = 'Copy link';
      }, COPIED_MS);
    }

    /* Status + banner + notices */
    const statusHost = h('div', { class: 'sh-status-host' });
    const bannerHost = h('div', { class: 'sh-banner-host' });
    const noticeHost = h('div', { class: 'sh-notice-host' });

    /* Settings */
    const savedEl = h('span', { class: 'sh-saved', 'aria-live': 'polite' });
    const sendSettings = debounce(() => flushSettings(), SETTINGS_DEBOUNCE_MS);
    const toggle = (key) => (v) => {
      st[key] = v;
      pending[key] = v;
      sendSettings();
    };
    const rows = {
      showSummary: switchRow({ iconName: 'sparkles', tone: 'purple', title: 'Show summary', sub: summarySub(), checked: st.showSummary, onChange: toggle('showSummary') }),
      showTranscript: switchRow({ iconName: 'list', tone: 'blue', title: 'Show transcript', sub: 'A searchable transcript next to the video', checked: st.showTranscript, onChange: toggle('showTranscript') }),
      allowComments: switchRow({ iconName: 'text', tone: 'green', title: 'Allow comments', sub: 'Viewers can leave comments and reactions', checked: st.allowComments, onChange: toggle('allowComments') }),
      allowDownload: switchRow({ iconName: 'download', tone: 'teal', title: 'Allow download', sub: 'Viewers can save the video file', checked: st.allowDownload, onChange: toggle('allowDownload') }),
    };

    // Password: set / change / remove without ever storing it here.
    const pw = passwordField({ placeholder: 'New password', label: 'New password' });
    const pwSave = button('Set password', { variant: 'secondary', onClick: () => savePassword() });
    const pwEditor = h('div', { class: 'sh-reveal sh-pw-editor', hidden: true }, pw.el, pwSave);
    const pwChange = button('Change', { variant: 'ghost', onClick: () => { pwEditing = true; syncPassword(); requestAnimationFrame(() => pw.input.focus()); } });
    const pwSet = h('div', { class: 'sh-reveal sh-pw-set', hidden: true },
      h('span', { class: 'sh-pw-set-text', html: `${icon('check', 14, { strokeWidth: 2.4 })}<span>Password is set</span>` }), pwChange);
    const pwRow = switchRow({
      iconName: 'eye-off', tone: 'orange', title: 'Password protect', sub: 'Only people with the password can watch',
      checked: st.hasPassword,
      onChange: (on) => {
        if (on) {
          if (!st.hasPassword) {
            pwEditing = true;
            requestAnimationFrame(() => pw.input.focus());
          }
        } else {
          pwEditing = false;
          pw.input.value = '';
          if (st.hasPassword) {
            st.hasPassword = false;
            pending.password = null;
            sendSettings();
          }
        }
        syncPassword();
      },
    });
    pw.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        savePassword();
      }
    });

    function syncPassword() {
      pwRow.set(st.hasPassword || pwEditing);
      pwEditor.hidden = !pwEditing;
      pwSet.hidden = !st.hasPassword || pwEditing;
      pwSave.querySelector('span').textContent = st.hasPassword ? 'Save password' : 'Set password';
      setDescription(st.hasPassword ? 'Only people with the password can watch.' : 'Anyone with the link can watch.');
    }

    async function savePassword() {
      const value = pw.input.value;
      if (!value.trim()) {
        pw.input.focus();
        toast('Enter a password first', { type: 'error' });
        return;
      }
      pending.password = value;
      pwSave.disabled = true;
      const ok = await flushSettings();
      pwSave.disabled = false;
      if (!ok || closed) return;
      pwEditing = false;
      pw.input.value = '';
      st.hasPassword = true;
      syncPassword();
      toast('Password set', { type: 'success' });
    }

    /** What the link's summary shows: the text is left out when the live video's trim cut speech. */
    function summarySub() {
      const p = project();
      return p.summary && shareSummaryHidden(p, share()?.trim || null) ? SUMMARY_TRIMMED_SUB : 'TL;DR, key points and chapters';
    }

    // Burn captions: takes effect with the next video update.
    const canBurn = () => Boolean(project().edit.captions?.enabled) && hasText(project().transcript);
    const burnSub = () => {
      if (burnNext !== Boolean(share()?.burnCaptions)) return 'Applies when you update the video';
      return burnNext ? 'Captions are part of the video' : 'Off: viewers can toggle your styled captions';
    };
    const burnRow = switchRow({
      iconName: 'captions', tone: 'accent', title: 'Burn captions into video', sub: burnSub(),
      checked: burnNext, disabled: !canBurn() && !burnNext,
      onChange: (v) => {
        burnNext = v;
        burnRow.setSub(burnSub());
        renderBanner();
        renderStatus();
      },
    });

    // Owner name
    const nameInput = h('input', {
      class: 'input sh-field-input', id: uid('sh_'), type: 'text', placeholder: 'Shown to viewers',
      maxlength: '60', autocomplete: 'name', spellcheck: 'false',
    });
    nameInput.value = getOwnerName();
    const sendName = debounce(() => saveName(), NAME_DEBOUNCE_MS);
    nameInput.addEventListener('input', () => { nameDirty = true; sendName(); });
    nameInput.addEventListener('blur', () => { if (nameDirty) sendName.flush(); });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (nameDirty) sendName.flush();
      }
    });

    const settingsGroup = h('div', { class: 'sh-group', role: 'group', 'aria-label': 'Link settings' },
      rows.showSummary.el, rows.showTranscript.el, rows.allowComments.el, rows.allowDownload.el,
      pwRow.el, pwEditor, pwSet, burnRow.el,
      fieldRow({ iconName: 'user', tone: 'muted', title: 'Your name', hint: 'Shown as the author', input: nameInput }));
    const settingsSection = h('section', { class: 'sh-section' },
      h('div', { class: 'sh-section-head' }, h('h4', { class: 'sh-section-title' }, 'Link settings'), savedEl),
      settingsGroup);

    /* Embed */
    const embedCode = h('code', { class: 'sh-embed-code' });
    const embedCopyLabel = h('span', {}, 'Copy code');
    const embedCopy = h('button', { type: 'button', class: 'btn btn-secondary btn-sm sh-embed-copy', html: icon('copy', 14) }, embedCopyLabel);
    let embedTimer = 0;
    embedCopy.addEventListener('click', async () => {
      const ok = await copyText(embedCode.textContent).catch(() => false);
      if (!ok) {
        toast('Couldn’t copy the embed code', { type: 'error' });
        return;
      }
      clearTimeout(embedTimer);
      embedCopy.classList.add('is-copied');
      embedCopyLabel.textContent = 'Copied';
      announce('Embed code copied');
      embedTimer = setTimeout(() => {
        embedCopy.classList.remove('is-copied');
        embedCopyLabel.textContent = 'Copy code';
      }, COPIED_MS);
    });
    const embed = h('details', { class: 'sh-embed' },
      h('summary', {},
        h('span', { class: 'sh-tile is-muted', html: icon('frame', 15) }),
        h('span', { class: 'sh-embed-title' }, 'Embed'),
        h('span', { class: 'sh-embed-hint' }, 'Put the player on a website'),
        h('span', { class: 'sh-embed-chevron', html: icon('chevron-down', 16) })),
      h('div', { class: 'sh-embed-body' }, embedCode, embedCopy));

    /* Footer */
    const createdEl = h('span', { class: 'sh-created' });
    const deleteBtn = button('Delete link', { iconName: 'trash', variant: 'ghost', onClick: () => onDelete() });
    deleteBtn.classList.add('sh-delete');
    const foot = h('div', { class: 'sh-manage-foot' }, createdEl, deleteBtn);

    setView('shared', h('div', { class: 'sh-view sh-shared-view' },
      linkBox, statusHost, bannerHost, noticeHost, settingsSection, embed, foot), {
      update,
      onConfig: renderNotice,
      dispose() {
        clearTimeout(copyTimer);
        clearTimeout(embedTimer);
        clearTimeout(savedTimer);
        // Send anything still waiting for its debounce.
        if (Object.keys(pending).length) sendSettings.flush();
        else sendSettings.cancel();
        if (nameDirty) sendName.flush();
        else sendName.cancel();
      },
    });
    update();
    syncPassword();
    if (copied) markCopied();
    focusSoon(copyBtn);

    /* ---- rendering ---- */

    function currentJob() {
      return job && job.shareId === share()?.id ? job : null;
    }

    function update() {
      if (!share()) return;
      syncFromOwner();
      renderStatus();
      renderBanner();
      renderNotice();
      schedulePoll();
    }

    function syncFromOwner() {
      const s = share();
      if (s.url && linkInput.value !== s.url) {
        linkInput.value = s.url;
        openBtn.href = s.url;
      }
      createdEl.textContent = `Created ${formatRelativeDate(num(owner?.createdAt, 0) || s.createdAt || Date.now())}`;
      const layout = owner?.layout?.width && owner?.layout?.height ? owner.layout : shareLayout(project());
      embedCode.textContent = embedSnippet(s.embedUrl || s.url.replace(/\/s\//, '/embed/'), layout.width, layout.height, owner?.title || project().title);
      rows.showSummary.setSub(summarySub());
      if (!owner) return;
      const remote = pickShareSettings(owner.settings);
      for (const k of TOGGLES) {
        if (k in pending) continue;
        st[k] = remote[k];
        rows[k].set(remote[k]);
      }
      if (!('password' in pending) && !pwEditing) {
        st.hasPassword = remote.hasPassword;
        syncPassword();
      }
      if (!nameDirty && document.activeElement !== nameInput && typeof owner.ownerName === 'string') {
        nameInput.value = owner.ownerName;
      }
      // Keep the local copy in step with the server (another tab may have changed it).
      if (!Object.keys(pending).length && !saving && JSON.stringify(pickShareSettings(s.settings)) !== JSON.stringify(remote)) {
        persistShare(projectId, s.id, (sh) => { sh.settings = remote; });
      }
      burnRow.setDisabled(!canBurn() && !burnNext);
    }

    function renderNotice() {
      noticeHost.replaceChildren(localOnly() ? localOnlyNotice('This link only works on this computer') : '');
    }

    function renderBanner() {
      const s = share();
      const j = currentJob();
      const show = Boolean(s?.videoHash) && !j?.active && j?.phase !== 'error' && owner?.status !== 'failed'
        && videoHash(project(), { burnCaptions: burnNext }) !== s.videoHash;
      const key = show ? (elsewhere ? 'elsewhere' : 'update') : '';
      if (key === bannerShown) return;
      bannerShown = key;
      if (!show) {
        bannerHost.replaceChildren();
        return;
      }
      if (elsewhere) {
        // Updating here would supersede (cancel) the upload another tab is making.
        bannerHost.replaceChildren(h('div', { class: 'sh-banner', role: 'note' },
          h('span', { class: 'sh-banner-icon', html: icon('upload', 16) }),
          h('div', { class: 'sh-banner-text' },
            h('strong', {}, 'Another tab is updating this video'),
            h('span', {}, 'Viewers see the new version once it’s uploaded. Keep that tab open.'))));
        return;
      }
      const updateBtn = button('Update video', { iconName: 'refresh', variant: 'primary', onClick: () => startJob(burnNext) });
      bannerHost.replaceChildren(h('div', { class: 'sh-banner', role: 'note' },
        h('span', { class: 'sh-banner-icon', html: icon('pencil', 16) }),
        h('div', { class: 'sh-banner-text' },
          h('strong', {}, 'You’ve edited since sharing'),
          h('span', {}, 'Viewers still see the earlier version. Updating keeps the same link.')),
        updateBtn));
    }

    function statusBox({ tone, iconName, title, text, action }) {
      return h('div', { class: `sh-status is-box is-${tone}` },
        h('span', { class: 'sh-status-icon', html: icon(iconName, 16) }),
        h('div', { class: 'sh-status-text' }, h('span', { class: 'sh-status-title' }, title), text ? h('span', { class: 'sh-status-sub' }, text) : null),
        action || null);
    }

    function stat(iconName, text) {
      return h('span', { class: 'sh-stat' }, h('span', { html: icon(iconName, 14) }), text);
    }

    function renderStatus() {
      const j = currentJob();
      if (j?.active) {
        if (statusKey !== 'job') {
          statusKey = 'job';
          const fill = h('div', { style: { width: '0%' } });
          const bar = h('div', {
            class: 'progress sh-progress', role: 'progressbar', 'aria-label': 'Sharing progress',
            'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
          }, fill);
          const label = h('span', { class: 'sh-status-title' });
          const eta = h('span', { class: 'sh-status-eta' });
          const cancel = button('Cancel', { variant: 'ghost', onClick: () => cancelShareJob(projectId) });
          cancel.classList.add('sh-cancel');
          const steps = ['rendering', 'uploading'].map((ph, i) => h('span', { class: 'sh-step', dataset: { phase: ph } },
            h('span', { class: 'sh-step-num' }, String(i + 1)), ph === 'rendering' ? 'Render' : 'Upload'));
          statusRefs = { fill, bar, label, eta, steps };
          statusHost.replaceChildren(h('div', { class: 'sh-status is-working' },
            h('div', { class: 'sh-status-row' },
              h('span', { class: 'spinner sh-status-spinner', 'aria-hidden': 'true' }),
              h('div', { class: 'sh-status-text' }, label, eta),
              h('div', { class: 'sh-steps', 'aria-hidden': 'true' }, steps),
              cancel),
            bar,
            h('p', { class: 'sh-status-note' },
              h('span', { html: icon('info', 13) }),
              h('span', {}, 'Keep this tab open — Dolly renders your edit in real time, then uploads it. Until then, viewers see that the video isn’t ready yet.'))));
        }
        const pct = Math.round(clamp(num(j.progress, 0), 0, 1) * 100);
        const r = statusRefs;
        r.label.textContent = phaseText(j.phase, j.phase === 'poster' ? null : pct);
        r.eta.textContent = j.phase === 'rendering' ? etaText(j.eta) : '';
        r.fill.style.width = `${j.phase === 'poster' ? 100 : pct}%`;
        r.bar.setAttribute('aria-valuenow', String(j.phase === 'poster' ? 100 : pct));
        r.bar.setAttribute('aria-valuetext', phaseText(j.phase, j.phase === 'poster' ? null : pct));
        const order = j.phase === 'rendering' ? 0 : 1;
        r.steps.forEach((el, i) => {
          el.classList.toggle('is-active', i === order);
          el.classList.toggle('is-done', i < order);
        });
        if (j.phase !== lastPhase) {
          lastPhase = j.phase;
          announce(phaseText(j.phase));
        }
        return;
      }
      lastPhase = '';

      let key;
      let el;
      if (j?.phase === 'error') {
        key = `error:${j.endedAt}:${owner?.status}`;
        el = statusBox({
          tone: 'red', iconName: 'warning', title: 'Sharing didn’t finish',
          text: `${j.error || 'Something went wrong.'}${owner?.status === 'ready' ? ' Viewers still see the previous version.' : ''}`,
          action: button('Try again', { iconName: 'refresh', variant: 'secondary', onClick: () => startJob(j.burnCaptions) }),
        });
      } else if (!owner && ownerError) {
        const offline = ownerError.status === 0;
        key = `offline:${ownerError.status}:${ownerError.message}`;
        el = statusBox({
          tone: 'muted', iconName: 'warning',
          title: offline ? 'Can’t reach the Dolly server' : 'Couldn’t load this link',
          text: offline ? 'The link works whenever the server is running. Start it again to see views and change settings.' : ownerError.message,
          action: button('Retry', { iconName: 'refresh', variant: 'secondary', onClick: () => { ownerError = null; statusKey = ''; update(); loadOwner(); } }),
        });
      } else if (!owner) {
        key = 'loading';
        el = h('div', { class: 'sh-status is-loading' },
          h('span', { class: 'spinner sh-status-spinner', 'aria-hidden': 'true' }),
          h('span', { class: 'sh-status-title' }, 'Checking your link…'));
      } else if (owner.status === 'ready') {
        const views = num(owner.views, 0);
        const comments = num(owner.commentCount, 0);
        key = `ready:${views}:${comments}`;
        el = h('div', { class: 'sh-status is-ready' },
          h('span', { class: 'sh-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'sh-status-title' }, 'Ready to watch'),
          h('span', { class: 'sh-stats' }, stat('eye', plural(views, 'view')), stat('text', plural(comments, 'comment'))));
      } else if (elsewhere) {
        // Another tab's job holds this link's lock; "Upload video" here would cancel its upload.
        const up = owner.upload;
        const pct = num(up?.size, 0) > 0 ? Math.round(clamp(num(up.received, 0) / num(up.size, 1), 0, 1) * 100) : null;
        key = `elsewhere:${pct}`;
        el = statusBox({
          tone: 'accent', iconName: 'upload',
          title: pct === null ? 'Rendering in another tab…' : `Uploading from another tab… ${pct}%`,
          text: 'Until it finishes, viewers see that the video isn’t ready yet. Keep that tab open.',
        });
      } else {
        const failed = owner.status === 'failed';
        key = `missing:${owner.status}:${burnNext}`;
        el = statusBox({
          tone: failed ? 'red' : 'accent', iconName: failed ? 'warning' : 'upload',
          title: failed ? 'The video couldn’t be uploaded' : 'The video isn’t uploaded yet',
          text: `${failed ? 'Viewers see an error until it is.' : 'Until it is, viewers see that it isn’t ready yet.'} Rendering takes about ${humanDuration(trimmedDuration(project()))}, then it uploads.`,
          action: button('Upload video', { iconName: 'upload', variant: 'primary', onClick: () => startJob(burnNext) }),
        });
      }
      if (key === statusKey) return;
      statusKey = key;
      statusRefs = null;
      statusHost.replaceChildren(el);
    }

    /* ---- saving settings ---- */

    function setSaved(state) {
      clearTimeout(savedTimer);
      savedEl.dataset.state = state;
      if (state === 'saving') {
        savedEl.innerHTML = '<span class="spinner sh-saved-spinner" aria-hidden="true"></span><span>Saving…</span>';
      } else if (state === 'saved') {
        savedEl.innerHTML = `${icon('check', 13, { strokeWidth: 2.4 })}<span>Saved</span>`;
        savedTimer = setTimeout(() => { savedEl.dataset.state = 'idle'; }, 1600);
      } else {
        savedEl.textContent = '';
      }
    }

    /** Sends the pending settings now. Resolves true when the server accepted them. */
    async function flushSettings() {
      sendSettings.cancel();
      const patch = pending;
      pending = {};
      const s = share();
      if (!s || !Object.keys(patch).length) return true;
      saving++;
      if (!closed) setSaved('saving');
      try {
        const v = await updateShare(s.id, s.ownerToken, { settings: patch });
        if (share()?.id !== s.id) return false;
        if (v) owner = v;
        const remote = pickShareSettings(v?.settings || {
          ...s.settings, ...patch,
          hasPassword: 'password' in patch ? patch.password !== null : s.settings?.hasPassword,
        });
        await persistShare(projectId, s.id, (sh) => { sh.settings = remote; });
        if (!closed) setSaved('saved');
        return true;
      } catch (err) {
        if (closed) {
          toast(`Couldn’t update the link’s settings. ${err?.message || ''}`.trim(), { type: 'error' });
          return false;
        }
        setSaved('idle');
        if (isGoneReply(err)) {
          if (mode === 'shared') showGone();
          return false;
        }
        toast(err?.status === 0 ? 'Couldn’t reach the Dolly server. Your change wasn’t saved.' : `Couldn’t update the link. ${err?.message || ''}`.trim(), { type: 'error' });
        // Put the switches back to what the server has.
        const known = pickShareSettings(owner?.settings || s.settings);
        for (const k of TOGGLES) {
          if (k in patch && !(k in pending)) {
            st[k] = known[k];
            rows[k].set(known[k]);
          }
        }
        if ('password' in patch && !('password' in pending)) {
          st.hasPassword = known.hasPassword;
          syncPassword();
        }
        return false;
      } finally {
        saving--;
      }
    }

    async function saveName() {
      const s = share();
      if (!s) return;
      nameDirty = false;
      const value = setOwnerName(nameInput.value);
      saving++;
      if (!closed) setSaved('saving');
      try {
        const v = await updateShare(s.id, s.ownerToken, { ownerName: value });
        if (v && share()?.id === s.id) owner = v;
        if (!closed) setSaved('saved');
      } catch (err) {
        if (!closed) setSaved('idle');
        if (isGoneReply(err)) {
          if (!closed && mode === 'shared') showGone();
          return;
        }
        toast(err?.status === 0 ? 'Couldn’t reach the Dolly server. Your name wasn’t updated.' : `Couldn’t update your name. ${err?.message || ''}`.trim(), { type: 'error' });
      } finally {
        saving--;
      }
    }

    /* ---- delete ---- */

    async function onDelete() {
      const ok = await confirmDialog({
        title: 'Delete this link?',
        message: 'People with the link won’t be able to watch anymore, and its comments and views are deleted. Your recording stays in your library.',
        confirmText: 'Delete link',
        danger: true,
      });
      const s = share();
      if (!ok || closed || !s) return;
      deleteBtn.disabled = true;
      cancelShareJob(projectId);
      sendSettings.cancel();
      sendName.cancel();
      pending = {};
      nameDirty = false;
      try {
        await deleteShare(s.id, s.ownerToken);
      } catch (err) {
        if (!isGoneReply(err)) {
          deleteBtn.disabled = false;
          toast(err?.status === 0 ? 'Couldn’t reach the Dolly server, so the link wasn’t deleted.' : `Couldn’t delete the link. ${err?.message || ''}`.trim(), { type: 'error' });
          return;
        }
      }
      await setProjectShare(projectId, null);
      clearShareJob(projectId);
      owner = null;
      ownerError = null;
      job = null;
      toast('Link deleted', { type: 'success' });
      if (!closed) showCreateFlow({ ...st, burnCaptions: Boolean(s.burnCaptions) });
    }
  }
}
