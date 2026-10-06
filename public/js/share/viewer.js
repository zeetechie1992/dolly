// Share viewer: the public watch page (/s/:id) and the embed player (/embed/:id).
// share.html (filled by the server) carries data-share-id / data-mode on <body>; this module
// fetches the PublicView and renders loading → not found / password gate / processing / failed / ready.
// Watch mode: frosted top bar, player card, reactions, title + meta, sidebar (Summary · Transcript · Comments).
// Embed mode: just the player, filling the frame.

import { h, formatTime, formatRelativeDate, copyText, uid, debounce } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { toast, applyTheme, logo, openMenu } from '../lib/ui.js';
import * as api from './api.js';
import { createPlayer } from './player.js';
import {
  REACTIONS, SHARE_ID_RE, parseTimeParam, formatTimeParam, sortComments, cleanChapters, cleanTranscript,
  lastStartedIndex, splitMatches, hasMatch, reactionCounts, avatarColor, initialOf, cleanName, isTimed,
  formatViews, embedSnippet,
} from './helpers.js';

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const body = document.body;
const root = document.getElementById('vw-root') || body.appendChild(h('div', { id: 'vw-root', class: 'vw-root' }));
const filled = (v) => typeof v === 'string' && v && !v.includes('{{');
const pathMatch = location.pathname.match(/^\/(s|embed)\/([^/?#]+)/);
const rawId = filled(body.dataset.shareId) ? body.dataset.shareId : pathMatch ? safeDecode(pathMatch[2]) : '';
const shareId = SHARE_ID_RE.test(rawId) ? rawId : null;
const mode = (filled(body.dataset.mode) ? body.dataset.mode : pathMatch?.[1] === 'embed' ? 'embed' : 'watch') === 'embed' ? 'embed' : 'watch';
const params = new URLSearchParams(location.search);
const startTime = parseTimeParam(params.get('t'));
const autoplay = params.get('autoplay') === '1';

const POLL_MS = 3000;
const FAILED_POLL_MS = 15000;   // a failed link can be re-uploaded by its owner: keep checking, slowly
const COMMENTS_POLL_MS = 30000;
const NAME_KEY = 'dolly.viewer.name';
const VIEWER_KEY = 'dolly.viewer.id';

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return ''; }
}
function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

let memoryViewerId = null;
function viewerId() {
  let id = readLocal(VIEWER_KEY);
  if (!id) {
    id = memoryViewerId || uid('v_');
    memoryViewerId = id;
    writeLocal(VIEWER_KEY, id);
  }
  return id;
}

/** App state. */
const S = {
  share: null,
  comments: [],          // server comments + optimistic ones ({ pending: true })
  commentsLoaded: false,
  commentsStarted: false,
  player: null,
  playerVersion: null,
  pollTimer: 0,
  commentsTimer: 0,
  viewSent: false,
  sideKey: '',
  tab: null,
};

/** Watch page refs (rebuilt when the share renders). */
const P = {
  shell: null,       // { app, main, copyBtn }
  layout: null,
  stage: null,
  ambient: null,
  under: null,
  reacts: null,
  actions: null,
  info: null,
  side: null,
  tabs: [],
  panels: {},        // id → { el, setTime?, render?, tabBtn }
};

if (mode === 'embed') {
  document.documentElement.setAttribute('data-theme', 'dark');
  body.classList.add('vw-is-embed');
} else {
  applyTheme();
}

// The first load keeps the static skeleton from share.html on screen (no flash).
if (!shareId) renderNotFound();
else load({ quiet: true });

/* ------------------------------------------------------------------ */
/* Loading & state transitions                                          */
/* ------------------------------------------------------------------ */

async function load({ quiet = false } = {}) {
  clearTimeout(S.pollTimer);
  if (!quiet) renderLoading();
  try {
    const share = await api.fetchShare(shareId);
    applyShare(share);
  } catch (err) {
    handleLoadError(err);
  } finally {
    root.removeAttribute('aria-busy');
  }
}

function handleLoadError(err) {
  if (err?.name === 'AbortError') return;
  if (err?.status === 404 || err?.status === 400) return renderNotFound();
  if (err?.status === 401 || err?.data?.passwordRequired) {
    api.clearAccess(shareId);
    return renderGate();
  }
  return renderError();
}

function applyShare(share) {
  if (!share || typeof share !== 'object') return renderError();
  const prev = S.share;
  S.share = share;
  setDocTitle(share.title || 'Untitled video');
  const ready = share.status === 'ready' && share.video?.url;

  if (mode === 'embed') renderEmbed(share, prev);
  else renderWatch(share, prev);

  if (!ready) schedulePoll(share.status === 'failed' ? FAILED_POLL_MS : POLL_MS);
  if (!S.commentsStarted) {
    S.commentsStarted = true;
    loadComments();
  } else if (prev && prev.version !== share.version) {
    // A new video can move timed comments (the server re-times them to a changed trim start).
    refreshComments();
  }
}

function schedulePoll(delay = POLL_MS) {
  clearTimeout(S.pollTimer);
  S.pollTimer = setTimeout(async () => {
    if (document.hidden) return schedulePoll(delay);
    try {
      applyShare(await api.fetchShare(shareId));
    } catch (err) {
      if (err?.status === 404 || err?.status === 401) handleLoadError(err);
      else schedulePoll(delay);
    }
  }, delay);
}

function setDocTitle(title) {
  document.title = `${title} · Dolly`;
}

function destroyPlayer() {
  S.player?.destroy();
  S.player = null;
  S.playerVersion = null;
}

/* ------------------------------------------------------------------ */
/* Watch shell & simple states                                          */
/* ------------------------------------------------------------------ */

function watchShell() {
  if (P.shell?.app.isConnected) return P.shell;
  const copyBtn = h('button', {
    type: 'button', class: 'btn btn-secondary btn-sm vw-nav-copy', onclick: () => copyLink(cleanUrl(), 'Link copied'),
    'aria-label': 'Copy link',
  }, h('span', { class: 'vw-nav-icon', html: icon('link', 15) }), h('span', { class: 'vw-nav-label' }, 'Copy link'));
  const cta = h('a', { class: 'btn btn-primary btn-sm vw-nav-cta', href: '/#/record' },
    h('span', { class: 'vw-nav-icon', html: icon('record', 12) }),
    h('span', { class: 'vw-nav-label-long' }, 'Record your own'),
    h('span', { class: 'vw-nav-label-short' }, 'Record'));
  const nav = h('header', { class: 'nav vw-nav' }, logo({ href: '/' }), h('div', { class: 'nav-spacer' }), copyBtn, cta);
  const main = h('main', { class: 'vw-main', id: 'vw-main' });
  const app = h('div', { class: 'vw-app' }, nav, main);
  root.replaceChildren(app);
  root.removeAttribute('aria-busy');
  P.shell = { app, main, copyBtn };
  return P.shell;
}

function resetWatchRefs() {
  P.layout = P.stage = P.ambient = P.under = P.reacts = P.actions = P.info = P.side = null;
  P.tabs = [];
  P.panels = {};
  S.sideKey = '';
}

function renderLoading() {
  destroyPlayer();
  if (mode === 'embed') {
    root.replaceChildren(h('div', { class: 'vw-embed vw-embed-center', 'aria-busy': 'true', 'aria-label': 'Loading video' }, h('div', { class: 'vw-ring' })));
    return;
  }
  const { main, copyBtn } = watchShell();
  copyBtn.hidden = false;
  resetWatchRefs();
  main.replaceChildren(h('div', { class: 'vw-layout vw-skel', 'aria-busy': 'true', 'aria-label': 'Loading video' },
    h('div', { class: 'vw-primary' },
      h('div', { class: 'vw-stage-wrap' }, h('div', { class: 'vw-stage vw-stage-skel skeleton' })),
      h('div', { class: 'vw-skel-line skeleton', style: { width: '56%', height: '30px', marginTop: '28px' } }),
      h('div', { class: 'vw-skel-line skeleton', style: { width: '32%', height: '14px', marginTop: '14px' } })),
    h('div', { class: 'vw-side card vw-side-skel' },
      h('div', { class: 'vw-skel-line skeleton', style: { height: '32px' } }),
      h('div', { class: 'vw-skel-line skeleton', style: { height: '96px', marginTop: '20px' } }),
      h('div', { class: 'vw-skel-line skeleton', style: { width: '80%', height: '14px', marginTop: '20px' } }),
      h('div', { class: 'vw-skel-line skeleton', style: { width: '64%', height: '14px', marginTop: '10px' } }))));
}

function stateCard({ iconName, iconHtml, title, text, actions = [], tone = '' }) {
  return h('div', { class: `vw-state card vw-rise ${tone}` },
    h('div', { class: 'vw-state-icon', html: iconHtml || icon(iconName, 26) }),
    h('h1', { class: 'vw-state-title' }, title),
    text ? h('p', { class: 'vw-state-text' }, text) : null,
    actions.length ? h('div', { class: 'vw-state-actions' }, actions) : null);
}

function renderNotFound() {
  destroyPlayer();
  clearTimeout(S.pollTimer);
  clearInterval(S.commentsTimer);
  setDocTitle('Video not found');
  if (mode === 'embed') {
    root.replaceChildren(h('div', { class: 'vw-embed vw-embed-center' },
      h('div', { class: 'vw-embed-msg' },
        h('div', { class: 'vw-embed-msg-icon', html: icon('film', 24) }),
        h('strong', {}, 'This video isn’t available'),
        h('p', {}, 'It may have been removed by its owner.'),
        h('a', { class: 'vw-embed-brand', href: '/', target: '_blank', rel: 'noopener' }, h('span', { class: 'logo-mark' }), 'Dolly'))));
    return;
  }
  const { main, copyBtn } = watchShell();
  copyBtn.hidden = true;
  resetWatchRefs();
  main.replaceChildren(h('div', { class: 'vw-center' }, stateCard({
    iconName: 'film',
    title: 'This video isn’t available',
    text: 'The link may be mistyped, or the owner may have removed the video.',
    actions: [
      h('a', { class: 'btn btn-primary', href: '/' }, 'Go to Dolly'),
      h('a', { class: 'btn btn-secondary', href: '/#/record' }, 'Record a video'),
    ],
  })));
}

function renderError() {
  destroyPlayer();
  setDocTitle('Dolly');
  const retry = h('button', { type: 'button', class: mode === 'embed' ? 'btn btn-sm vw-embed-btn' : 'btn btn-primary', onclick: () => load() },
    h('span', { html: icon('refresh', 15) }), 'Try again');
  if (mode === 'embed') {
    root.replaceChildren(h('div', { class: 'vw-embed vw-embed-center' },
      h('div', { class: 'vw-embed-msg' },
        h('div', { class: 'vw-embed-msg-icon', html: icon('warning', 24) }),
        h('strong', {}, 'Couldn’t load this video'),
        h('p', {}, 'Check your connection and try again.'),
        retry)));
    return;
  }
  const { main, copyBtn } = watchShell();
  copyBtn.hidden = false;
  resetWatchRefs();
  main.replaceChildren(h('div', { class: 'vw-center' }, stateCard({
    iconName: 'warning',
    title: 'Couldn’t load this video',
    text: 'Check your connection and try again.',
    actions: [retry],
  })));
}

/* ------------------------------------------------------------------ */
/* Password gate                                                        */
/* ------------------------------------------------------------------ */

function renderGate() {
  destroyPlayer();
  clearTimeout(S.pollTimer);
  clearInterval(S.commentsTimer);
  S.commentsStarted = false;
  S.commentsLoaded = false;
  S.comments = [];
  setDocTitle('Password-protected video');

  const input = h('input', {
    type: 'password', class: 'input vw-gate-input', placeholder: 'Password', autocomplete: 'current-password',
    'aria-label': 'Password', 'aria-describedby': 'vw-gate-error', spellcheck: 'false',
  });
  const reveal = h('button', {
    type: 'button', class: 'vw-gate-eye', 'aria-label': 'Show password', 'aria-pressed': 'false', html: icon('eye', 17),
    onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.innerHTML = icon(show ? 'eye-off' : 'eye', 17);
      reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      reveal.setAttribute('aria-pressed', String(show));
      input.focus();
    },
  });
  const error = h('p', { class: 'vw-gate-error', id: 'vw-gate-error', role: 'alert' });
  const submitLabel = h('span', {}, 'Unlock');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block vw-gate-submit' }, submitLabel);
  const card = h('form', { class: 'vw-gate card vw-rise', novalidate: true },
    h('div', { class: 'vw-gate-badge', 'aria-hidden': 'true' }, h('span', { class: 'vw-lock' })),
    h('h1', { class: 'vw-gate-title' }, 'This video is password-protected'),
    h('p', { class: 'vw-gate-text' }, 'Enter the password the owner shared with you to watch it.'),
    h('div', { class: 'vw-gate-field' }, input, reveal),
    error,
    submit);

  const shake = () => {
    card.classList.remove('is-shake');
    void card.offsetWidth;
    card.classList.add('is-shake');
  };
  input.addEventListener('input', () => { error.textContent = ''; card.classList.remove('has-error'); });
  card.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    const password = input.value;
    if (!password) {
      error.textContent = 'Enter the password to continue.';
      card.classList.add('has-error');
      shake();
      input.focus();
      return;
    }
    submit.disabled = true;
    submitLabel.replaceChildren(h('span', { class: 'spinner vw-btn-spinner' }), 'Unlocking…');
    try {
      await api.unlockShare(shareId, password);
      await load({ quiet: false });
    } catch (err) {
      submit.disabled = false;
      submitLabel.replaceChildren('Unlock');
      card.classList.add('has-error');
      error.textContent = err?.status === 403
        ? 'That password isn’t right. Try again.'
        : err?.status === 429
          ? 'Too many attempts. Wait a moment and try again.'
          : err?.status === 404
            ? 'This video no longer exists.'
            : err?.status === 0
              ? 'Couldn’t reach Dolly. Check your connection.'
              : (err?.message || 'Something went wrong. Try again.');
      shake();
      input.select();
    }
  });

  if (mode === 'embed') {
    root.replaceChildren(h('div', { class: 'vw-embed vw-embed-center vw-embed-gate' }, card));
  } else {
    const { main, copyBtn } = watchShell();
    copyBtn.hidden = false;
    resetWatchRefs();
    main.replaceChildren(h('div', { class: 'vw-center' }, card));
  }
  setTimeout(() => input.focus({ preventScroll: true }), 60);
}

/* ------------------------------------------------------------------ */
/* Stage: player / processing / failed                                  */
/* ------------------------------------------------------------------ */

function stageAspect(share) {
  const w = Number(share.video?.width) || Number(share.layout?.width) || 16;
  const hgt = Number(share.video?.height) || Number(share.layout?.height) || 9;
  return w / hgt;
}

function processingView(share) {
  const bg = h('div', { class: 'vw-process-bg' });
  if (share.posterUrl) {
    bg.classList.add('has-poster');
    bg.style.backgroundImage = cssUrl(share.posterUrl);
  }
  return h('div', { class: 'vw-process', role: 'status' },
    bg,
    h('div', { class: 'vw-process-inner' },
      h('div', { class: 'vw-ring' }),
      // Also shown while nothing is uploading (the owner cancelled, or their tab closed), so no
      // promise that it's moments away.
      h('h2', { class: 'vw-process-title' }, 'This video isn’t ready yet'),
      h('p', { class: 'vw-process-text' }, mode === 'embed'
        ? 'The owner hasn’t finished uploading it yet. It’ll play here when it’s ready.'
        : 'The owner hasn’t finished uploading this video yet. This page updates on its own when it’s ready.')));
}

function failedView() {
  return h('div', { class: 'vw-process is-failed', role: 'alert' },
    h('div', { class: 'vw-process-bg' }),
    h('div', { class: 'vw-process-inner' },
      h('div', { class: 'vw-process-icon', html: icon('warning', 24) }),
      h('h2', { class: 'vw-process-title' }, 'This video couldn’t be processed'),
      h('p', { class: 'vw-process-text' }, 'The owner can share it again from Dolly.')));
}

const cssUrl = (url) => `url("${String(url).replace(/["\\\n\r]/g, (c) => `\\${c === '\n' ? 'a ' : c === '\r' ? 'd ' : c}`)}")`;

/** Fills `host` with the right content for the share's status. Returns true when a player is showing. */
function renderStage(host, share) {
  const ready = share.status === 'ready' && share.video?.url;
  if (ready) {
    if (S.player && S.player.el.isConnected && S.player.el.parentNode === host) {
      if (S.playerVersion !== share.version) {
        S.player.reload(share);
        S.playerVersion = share.version;
      }
      return true;
    }
    destroyPlayer();
    const player = createPlayer({
      share, mode, startTime, autoplay,
      onRetry: async () => {
        try {
          const next = await api.fetchShare(shareId);
          if (next && typeof next === 'object') {
            // player.retry() reloads itself with `next`; matching the version keeps renderStage from reloading it twice.
            S.playerVersion = next.version;
            applyShare(next);   // title, info, actions (download link), sidebar timeline, doc title
          }
          return next;
        } catch { return null; }
      },
    });
    S.player = player;
    S.playerVersion = share.version;
    host.dataset.view = 'player';
    host.replaceChildren(player.el);
    wirePlayer(player);
    player.setMarkers(S.comments);
    return true;
  }
  destroyPlayer();
  // Polls re-render every few seconds: keep the same placeholder (and its animation) when nothing changed.
  const key = share.status === 'failed' ? 'failed' : `processing:${share.posterUrl || ''}`;
  if (host.dataset.view !== key || !host.firstElementChild) {
    host.dataset.view = key;
    host.replaceChildren(share.status === 'failed' ? failedView() : processingView(share));
  }
  return false;
}

function wirePlayer(player) {
  player.on('time', (t) => {
    for (const panel of Object.values(P.panels)) panel.setTime?.(t);
  });
  player.on('play', () => {
    P.panels.comments?.onPlay?.();
  });
  player.on('watched', (secs) => {
    if (secs < 2 || S.viewSent) return;
    S.viewSent = true;
    api.recordView(shareId, viewerId())
      .then((data) => { if (Number.isFinite(data?.views)) setViews(data.views); })
      .catch((err) => { if (err?.status === 0) S.viewSent = false; });
  });
}

/* ------------------------------------------------------------------ */
/* Embed                                                               */
/* ------------------------------------------------------------------ */

function renderEmbed(share) {
  let frame = root.querySelector(':scope > .vw-embed-stage');
  if (!frame) {
    frame = h('div', { class: 'vw-embed vw-embed-stage' });
    root.replaceChildren(frame);
  }
  frame.style.setProperty('--vw-ar', String(stageAspect(share)));
  renderStage(frame, share);
}

/* ------------------------------------------------------------------ */
/* Watch page                                                          */
/* ------------------------------------------------------------------ */

function renderWatch(share, prev) {
  const { main, copyBtn } = watchShell();
  copyBtn.hidden = false;

  if (!P.layout || !P.layout.isConnected) {
    resetWatchRefs();
    P.ambient = h('div', { class: 'vw-ambient', 'aria-hidden': 'true' });
    P.stage = h('div', { class: 'vw-stage' });
    P.reacts = h('div', { class: 'vw-reacts', role: 'group', 'aria-label': 'React to this video' });
    P.actions = h('div', { class: 'vw-actions' });
    P.under = h('div', { class: 'vw-under' }, P.reacts, P.actions);
    P.info = h('div', { class: 'vw-info' });
    P.side = h('aside', { class: 'vw-side card', 'aria-label': 'Video details' });
    P.layout = h('div', { class: 'vw-layout' },
      h('section', { class: 'vw-primary', 'aria-label': 'Video' },
        h('div', { class: 'vw-stage-wrap' }, P.ambient, P.stage),
        P.under,
        P.info),
      P.side);
    main.replaceChildren(P.layout);
  }

  P.layout.querySelector('.vw-primary').style.setProperty('--vw-ar', String(stageAspect(share)));
  if (share.posterUrl) {
    P.ambient.style.backgroundImage = cssUrl(share.posterUrl);
    P.ambient.classList.add('has-poster');
  }

  const hasPlayer = renderStage(P.stage, share);
  renderReactions(hasPlayer);
  renderActions(share, hasPlayer);
  renderInfo(share);
  renderSide(share, prev);
}

function renderInfo(share) {
  const meta = [];
  const owner = String(share.ownerName || '').trim();
  if (owner) {
    const av = h('span', { class: 'vw-avatar vw-avatar-sm', 'aria-hidden': 'true' }, initialOf(owner));
    av.style.setProperty('--c', avatarColor(owner));
    meta.push(h('span', { class: 'vw-meta-owner' }, av, h('span', {}, owner)));
  }
  if (Number(share.createdAt)) {
    meta.push(h('time', { class: 'vw-meta-item', datetime: new Date(share.createdAt).toISOString(), title: new Date(share.createdAt).toLocaleString() },
      formatRelativeDate(share.createdAt)));
  }
  meta.push(h('span', { class: 'vw-meta-item vw-views' }, formatViews(share.views)));
  const metaEl = h('div', { class: 'vw-meta' });
  meta.forEach((m, i) => {
    if (i) metaEl.append(h('span', { class: 'vw-meta-sep', 'aria-hidden': 'true' }, '·'));
    metaEl.append(m);
  });
  // The description defaults to the TL;DR: skip it when the Summary panel already shows that text.
  const desc = String(share.description || '').trim();
  const flat = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const descFlat = flat(desc);
  const tldrFlat = flat(share.summary?.tldr);
  const dupOfTldr = Boolean(share.settings?.showSummary && tldrFlat && descFlat && tldrFlat.startsWith(descFlat));
  // Native replaceChildren() would render a null argument as the text "null".
  P.info.replaceChildren(...[
    h('h1', { class: 'vw-title' }, share.title || 'Untitled video'),
    metaEl,
    (desc && !dupOfTldr) ? h('p', { class: 'vw-desc' }, desc) : null,
  ].filter(Boolean));
}

function setViews(n) {
  if (!S.share) return;
  S.share.views = n;
  const el = P.info?.querySelector('.vw-views');
  if (el) el.textContent = formatViews(n);
}

function renderActions(share, hasPlayer) {
  const items = [];
  const dl = share.video?.downloadUrl;
  if (hasPlayer && dl) {
    items.push(h('a', { class: 'btn btn-secondary btn-sm vw-dl', href: dl, download: '', 'aria-label': 'Download video' },
      h('span', { html: icon('download', 15) }), h('span', { class: 'vw-dl-label' }, 'Download')));
  }
  const more = h('button', {
    type: 'button', class: 'btn btn-secondary btn-icon btn-sm vw-more', 'aria-label': 'More sharing options', 'aria-haspopup': 'menu',
    html: icon('share', 16),
    onclick: () => {
      const menu = [{ label: 'Copy link', icon: 'link', onClick: () => copyLink(cleanUrl(), 'Link copied') }];
      const t = S.player?.time || 0;
      if (S.player && t >= 1) {
        menu.push({
          label: `Copy link at ${formatTime(t)}`, icon: 'clock',
          onClick: () => copyLink(cleanUrl({ t: formatTimeParam(t) }), `Link to ${formatTime(t)} copied`),
        });
      }
      menu.push({
        label: 'Copy embed code', icon: 'frame',
        onClick: () => copyLink(embedSnippet({ origin: location.origin, id: shareId, title: share.title, width: share.layout?.width || share.video?.width, height: share.layout?.height || share.video?.height }), 'Embed code copied'),
      });
      openMenu(more, menu);
    },
  });
  items.push(more);
  P.actions.replaceChildren(...items);
}

/** The page URL without a `t` parameter (optionally with new params). */
function cleanUrl(extra = {}) {
  const url = new URL(location.href);
  url.searchParams.delete('t');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  url.hash = '';
  return url.toString();
}

async function copyLink(text, message) {
  const ok = await copyText(text);
  toast(ok ? message : 'Couldn’t copy. Select the address bar and copy it instead.', { type: ok ? 'success' : 'error' });
}

/* ---------------- reactions ---------------- */

let reactErrorAt = 0;

function renderReactions(hasPlayer) {
  const allowed = Boolean(S.share?.settings?.allowComments);
  P.reacts.hidden = !(hasPlayer && allowed);
  if (P.reacts.hidden) { P.reacts.replaceChildren(); return; }
  const counts = reactionCounts(S.comments);
  if (!P.reacts.childElementCount) {
    P.reacts.append(...REACTIONS.map((emoji) => {
      const count = h('span', { class: 'vw-react-count', 'aria-hidden': 'true' });
      return h('button', {
        type: 'button', class: 'vw-react', dataset: { emoji }, 'aria-label': `React with ${emoji}`,
        onclick: (e) => react(emoji, e.currentTarget),
      }, h('span', { class: 'vw-react-emoji' }, emoji), count);
    }));
  }
  for (const btn of P.reacts.children) {
    const n = counts[btn.dataset.emoji] || 0;
    const badge = btn.querySelector('.vw-react-count');
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = n === 0;
    btn.setAttribute('aria-label', `React with ${btn.dataset.emoji}${n ? ` (${n})` : ''}`);
  }
}

function react(emoji, btn) {
  const player = S.player;
  if (!player) return;
  player.floatEmoji(emoji);
  btn?.classList.remove('is-pop');
  void btn?.offsetWidth;
  btn?.classList.add('is-pop');
  const time = Math.round(player.time * 10) / 10;
  const name = cleanName(readLocal(NAME_KEY));
  const temp = { id: uid('tmp_'), kind: 'reaction', name, text: '', emoji, time, createdAt: Date.now(), pending: true };
  S.comments.push(temp);
  commentsChanged();
  api.postComment(shareId, { kind: 'reaction', name, text: '', emoji, time })
    .then((saved) => replaceComment(temp.id, saved))
    .catch((err) => {
      removeComment(temp.id);
      if (Date.now() - reactErrorAt > 4000) {
        reactErrorAt = Date.now();
        toast(postErrorMessage(err, 'reaction'), { type: 'error' });
      }
      handlePostError(err);
    });
}

/* ---------------- sidebar ---------------- */

function renderSide(share, prev) {
  const settings = share.settings || {};
  const transcript = cleanTranscript(share.transcript);
  const showSummary = Boolean(settings.showSummary && share.summary);
  const showTranscript = Boolean(settings.showTranscript && transcript.length);
  const commentCount = S.comments.filter((c) => c.kind !== 'reaction').length;
  const showComments = Boolean(settings.allowComments || commentCount > 0);

  // Rebuild summary/transcript only when their inputs changed; the comments panel keeps its draft.
  const key = JSON.stringify([showSummary && share.summary, showTranscript && transcript, settings.allowComments, share.duration]);
  if (key !== S.sideKey || !P.side.childElementCount) {
    S.sideKey = key;
    const keepComments = P.panels.comments;
    P.panels = {};
    if (showSummary) P.panels.summary = buildSummaryPanel(share);
    if (showTranscript) P.panels.transcript = buildTranscriptPanel(transcript);
    if (showComments) {
      P.panels.comments = keepComments && keepComments.allow === Boolean(settings.allowComments)
        ? keepComments
        : buildCommentsPanel(share);
    }
    P.tabs = [
      showSummary && { id: 'summary', label: 'Summary' },
      showTranscript && { id: 'transcript', label: 'Transcript' },
      showComments && { id: 'comments', label: 'Comments' },
    ].filter(Boolean);
    buildSideDom();
  } else if (!showComments !== !P.panels.comments) {
    S.sideKey = '';
    return renderSide(share, prev);
  }
  updateCommentsTab();
  P.panels.comments?.sync?.();
}

function buildSideDom() {
  const tabs = P.tabs;
  P.layout.classList.toggle('no-side', tabs.length === 0);
  P.side.hidden = tabs.length === 0;
  if (!tabs.length) { P.side.replaceChildren(); return; }
  if (!tabs.some((t) => t.id === S.tab)) S.tab = tabs[0].id;

  const tablist = h('div', { class: 'segmented lg vw-tabs', role: 'tablist', 'aria-label': 'Video details' });
  for (const t of tabs) {
    const panel = P.panels[t.id];
    const btn = h('button', {
      type: 'button', role: 'tab', id: `vw-tab-${t.id}`, 'aria-controls': `vw-panel-${t.id}`,
      onclick: () => selectTab(t.id, false),
    }, t.label, t.id === 'comments' ? h('span', { class: 'vw-tab-count' }) : null);
    panel.tabBtn = btn;
    panel.el.id = `vw-panel-${t.id}`;
    panel.el.setAttribute('role', 'tabpanel');
    panel.el.setAttribute('aria-labelledby', btn.id);
    tablist.append(btn);
  }
  tablist.addEventListener('keydown', (e) => {
    const ids = tabs.map((t) => t.id);
    const i = ids.indexOf(S.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
    else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
    else if (e.key === 'Home') next = ids[0];
    else if (e.key === 'End') next = ids[ids.length - 1];
    if (next) { e.preventDefault(); selectTab(next, true); }
  });
  const head = h('div', { class: 'vw-side-head' }, tabs.length > 1 ? tablist : h('h2', { class: 'vw-side-title' }, tabs[0].label));
  if (tabs.length === 1) {
    // A single section: a plain heading instead of a one-button segmented control.
    const only = P.panels[tabs[0].id];
    only.el.removeAttribute('role');
    only.el.removeAttribute('aria-labelledby');
    only.tabBtn = null;
  }
  P.side.replaceChildren(head, ...tabs.map((t) => P.panels[t.id].el));
  selectTab(S.tab, false);
  if (S.player) for (const p of Object.values(P.panels)) p.setTime?.(S.player.time, { initial: true });
}

function selectTab(id, focus) {
  S.tab = id;
  for (const t of P.tabs) {
    const panel = P.panels[t.id];
    const on = t.id === id;
    panel.el.hidden = !on;
    if (panel.tabBtn) {
      panel.tabBtn.classList.toggle('active', on);
      panel.tabBtn.setAttribute('aria-selected', String(on));
      panel.tabBtn.tabIndex = on ? 0 : -1;
      if (on && focus) panel.tabBtn.focus();
    }
    if (on) panel.onShow?.();
  }
}

function updateCommentsTab() {
  const panel = P.panels.comments;
  if (!panel) return;
  const n = S.comments.filter((c) => c.kind !== 'reaction').length;
  const badge = panel.tabBtn?.querySelector('.vw-tab-count');
  if (badge) {
    badge.textContent = String(n);
    badge.hidden = n === 0;
  }
  const title = P.side.querySelector('.vw-side-title');
  if (title && P.tabs.length === 1 && P.tabs[0].id === 'comments') title.textContent = n ? `Comments · ${n}` : 'Comments';
}

/** Seeks the player and plays; brings the player into view when it is scrolled away (stacked layout). */
function seekTo(t) {
  const player = S.player;
  if (!player) return;
  player.seek(t);
  player.play();
  const r = P.stage?.getBoundingClientRect();
  if (r && (r.bottom < 80 || r.top > window.innerHeight - 80)) {
    P.stage.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }
}

/* ---------------- summary panel ---------------- */

function buildSummaryPanel(share) {
  const sum = share.summary || {};
  const chapters = cleanChapters(sum.chapters, share.duration);
  const points = (Array.isArray(sum.key_points) ? sum.key_points : []).map((s) => String(s || '').trim()).filter(Boolean);
  const actions = (Array.isArray(sum.action_items) ? sum.action_items : []).map((s) => String(s || '').trim()).filter(Boolean);
  const tldr = String(sum.tldr || '').trim();

  const chapterBtns = chapters.map((c) => h('button', {
    type: 'button', class: 'vw-chap', onclick: () => seekTo(c.start), 'aria-label': `${c.title}, ${formatTime(c.start)}`,
  }, h('span', { class: 'vw-chap-time t-mono' }, formatTime(c.start)), h('span', { class: 'vw-chap-title' }, c.title)));

  const block = (title, content) => h('section', { class: 'vw-sum-block' }, h('h3', { class: 'section-title' }, title), content);
  const el = h('div', { class: 'vw-panel vw-sum' },
    tldr ? h('div', { class: 'vw-sum-hero' },
      h('div', { class: 'vw-sum-eyebrow' }, h('span', { class: 'vw-sum-spark', html: icon('sparkles', 14) }), h('span', {}, 'TL;DR')),
      h('p', { class: 'vw-sum-tldr' }, tldr)) : null,
    points.length ? block('Key points', h('ul', { class: 'vw-sum-points' }, points.map((p) => h('li', {}, p)))) : null,
    actions.length ? block('Action items', h('ul', { class: 'vw-sum-actions' }, actions.map((a) => h('li', {},
      h('span', { class: 'vw-sum-check', 'aria-hidden': 'true' }), h('span', {}, a))))) : null,
    chapters.length ? block('Chapters', h('div', { class: 'vw-chaps' }, chapterBtns)) : null,
    !tldr && !points.length && !actions.length && !chapters.length
      ? h('div', { class: 'empty-state vw-empty' }, h('div', { class: 'empty-icon', html: icon('sparkles', 24) }), h('h3', {}, 'No summary yet'))
      : null);

  let current = -2;
  return {
    el,
    setTime(t) {
      const idx = chapters.length ? lastStartedIndex(chapters, t + 0.05) : -1;
      if (idx === current) return;
      current = idx;
      chapterBtns.forEach((b, i) => {
        b.classList.toggle('is-current', i === idx);
        if (i === idx) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      });
    },
  };
}

/* ---------------- transcript panel ---------------- */

function buildTranscriptPanel(segments) {
  const input = h('input', {
    type: 'search', class: 'input vw-tx-input', placeholder: 'Search transcript', 'aria-label': 'Search transcript',
    autocomplete: 'off', spellcheck: 'false',
  });
  const count = h('span', { class: 'vw-tx-count', 'aria-live': 'polite' });
  const list = h('ol', { class: 'vw-tx-list' });
  const empty = h('div', { class: 'vw-tx-empty', hidden: true });
  const segs = segments;
  const rows = segments.map((seg) => {
    const text = h('span', { class: 'vw-tx-text' }, seg.text);
    const li = h('li', { class: 'vw-tx-item' },
      h('button', { type: 'button', class: 'vw-tx-row', onclick: () => seekTo(seg.start) },
        h('span', { class: 'vw-tx-time t-mono' }, formatTime(seg.start)), text));
    return { seg, li, text };
  });
  list.append(...rows.map((r) => r.li));

  let query = '';
  let active = -1;
  let userScrollUntil = 0;
  const holdScroll = () => { userScrollUntil = performance.now() + 4000; };
  for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) list.addEventListener(type, holdScroll, { passive: true });

  function applyFilter() {
    query = input.value.trim();
    let shown = 0;
    for (const r of rows) {
      const ok = !query || hasMatch(r.seg.text, query);
      r.li.hidden = !ok;
      if (!ok) continue;
      shown++;
      r.text.replaceChildren(...splitMatches(r.seg.text, query).map((p) => (p.match ? h('mark', { class: 'vw-mark' }, p.text) : p.text)));
    }
    count.textContent = query ? (shown ? `${shown} ${shown === 1 ? 'match' : 'matches'}` : '') : '';
    empty.hidden = !query || shown > 0;
    empty.textContent = `No results for “${query}”`;
    if (!query && active >= 0) scrollToActive(true);
  }
  const debounced = debounce(applyFilter, 120);
  input.addEventListener('input', debounced);
  input.addEventListener('search', () => debounced.flush());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; debounced.flush(); }
  });

  const el = h('div', { class: 'vw-panel vw-tx' },
    h('div', { class: 'vw-tx-search' }, h('span', { class: 'vw-tx-search-icon', html: icon('search', 15) }), input, count),
    h('div', { class: 'vw-tx-scroll' }, list, empty));

  function scrollToActive(force) {
    const row = rows[active];
    if (!row || row.li.hidden || el.hidden) return;
    if (!force && performance.now() < userScrollUntil) return;
    const scroller = list.parentElement;
    if (scroller.scrollHeight <= scroller.clientHeight + 2) return;
    const top = row.li.offsetTop - scroller.clientHeight / 2 + row.li.offsetHeight / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  return {
    el,
    setTime(t) {
      const idx = lastStartedIndex(segs, t + 0.05);
      if (idx === active) return;
      rows[active]?.li.classList.remove('is-active');
      active = idx;
      rows[active]?.li.classList.add('is-active');
      if (S.player && !S.player.paused) scrollToActive(false);
    },
    onShow() { requestAnimationFrame(() => scrollToActive(true)); },
  };
}

/* ---------------- comments panel ---------------- */

function buildCommentsPanel(share) {
  const allow = Boolean(share.settings?.allowComments);
  const list = h('ol', { class: 'vw-cm-list', 'aria-label': 'Comments' });
  const empty = h('div', { class: 'vw-cm-empty' },
    h('div', { class: 'vw-cm-empty-icon', html: icon('pencil', 20) }),
    h('strong', {}, allow ? 'No comments yet' : 'No comments'),
    allow ? h('p', {}, 'Be the first to share a thought. Comments can point to a moment in the video.') : null);
  const scroller = h('div', { class: 'vw-cm-scroll' }, list, empty);
  const nodes = new Map();   // comment id → li

  let composer = null;
  let atOn = false;
  let atManual = false;
  let posting = false;
  let atLabel = null, atChip = null, textarea = null, nameInput = null, postBtn = null;

  if (allow) {
    nameInput = h('input', {
      class: 'input vw-cm-name', placeholder: 'Your name', maxlength: '60', autocomplete: 'name', 'aria-label': 'Your name',
      value: readLocal(NAME_KEY) || '',
    });
    const nameAvatar = h('span', { class: 'vw-avatar vw-avatar-sm', 'aria-hidden': 'true' });
    const syncAvatar = () => {
      nameAvatar.textContent = initialOf(nameInput.value);
      nameAvatar.style.setProperty('--c', avatarColor(nameInput.value));
    };
    syncAvatar();
    nameInput.addEventListener('input', syncAvatar);
    nameInput.addEventListener('change', () => writeLocal(NAME_KEY, nameInput.value.trim().slice(0, 60)));

    textarea = h('textarea', {
      class: 'textarea vw-cm-input', placeholder: 'Add a comment…', rows: '2', maxlength: '2000', 'aria-label': 'Comment',
    });
    atLabel = h('span', {}, 'Add at 0:00');
    atChip = h('button', {
      type: 'button', class: 'chip vw-at-chip', 'aria-pressed': 'false', hidden: true,
      onclick: () => { atManual = true; atOn = !atOn; renderAt(); },
    }, h('span', { html: icon('clock', 13) }), atLabel);
    postBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-sm vw-cm-post', disabled: true }, 'Post');
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    composer = h('form', { class: 'vw-composer', novalidate: true },
      h('div', { class: 'vw-cm-who' }, nameAvatar, nameInput),
      textarea,
      h('div', { class: 'vw-cm-row' },
        atChip,
        h('span', { class: 'vw-cm-hint', 'aria-hidden': 'true' }, h('span', { class: 'kbd' }, isMac ? '⌘' : 'Ctrl'), h('span', { class: 'kbd' }, '↵')),
        postBtn));

    const autosize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(160, textarea.scrollHeight + 2)}px`;
    };
    textarea.addEventListener('input', () => { postBtn.disabled = !textarea.value.trim() || posting; autosize(); });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    composer.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  } else {
    composer = h('div', { class: 'vw-cm-off' }, h('span', { html: icon('info', 16) }), 'Comments are turned off for this video.');
  }

  function renderAt() {
    if (!atChip) return;
    atChip.hidden = !S.player;
    const t = S.player?.time || 0;
    atLabel.textContent = `Add at ${formatTime(t)}`;
    atChip.classList.toggle('active', atOn);
    atChip.setAttribute('aria-pressed', String(atOn));
    atChip.setAttribute('aria-label', atOn ? `Comment will be attached to ${formatTime(t)}` : 'Attach the current time to the comment');
  }

  async function submit() {
    if (posting || !textarea) return;
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    const rawName = nameInput.value.trim().slice(0, 60);
    writeLocal(NAME_KEY, rawName);
    const name = cleanName(rawName);
    const time = atOn && S.player && !atChip.hidden ? Math.round(S.player.time * 10) / 10 : null;
    const temp = { id: uid('tmp_'), kind: 'comment', name, text, emoji: '', time, createdAt: Date.now(), pending: true };
    posting = true;
    postBtn.disabled = true;
    textarea.value = '';
    textarea.style.height = '';
    S.comments.push(temp);
    commentsChanged();
    reveal(temp.id);
    try {
      const saved = await api.postComment(shareId, { kind: 'comment', name, text, emoji: '', time });
      replaceComment(temp.id, saved);
    } catch (err) {
      removeComment(temp.id);
      if (!textarea.value) textarea.value = text;
      toast(postErrorMessage(err, 'comment'), { type: 'error' });
      handlePostError(err);
    } finally {
      posting = false;
      if (textarea) postBtn.disabled = !textarea.value.trim();
    }
  }

  function reveal(id) {
    const li = nodes.get(id);
    if (!li) return;
    requestAnimationFrame(() => {
      const top = li.offsetTop - scroller.clientHeight / 2;
      if (scroller.scrollHeight > scroller.clientHeight) scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      else li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function node(c) {
    const name = cleanName(c.name);
    const av = h('span', { class: 'vw-avatar', 'aria-hidden': 'true' }, initialOf(name));
    av.style.setProperty('--c', avatarColor(name));
    const created = Number(c.createdAt) || Date.now();
    const date = h('time', {
      class: 'vw-cm-date', datetime: new Date(created).toISOString(), title: new Date(created).toLocaleString(),
    }, c.pending ? 'Posting…' : formatRelativeDate(created));
    const chip = isTimed(c)
      ? h('button', { type: 'button', class: 'vw-time-chip t-mono', onclick: () => seekTo(c.time), 'aria-label': `Jump to ${formatTime(c.time)}` }, formatTime(c.time))
      : null;
    const li = h('li', { class: `vw-cm-item${c.pending ? ' is-pending' : ''}`, dataset: { id: c.id } },
      av,
      h('div', { class: 'vw-cm-main' },
        h('div', { class: 'vw-cm-head' }, h('span', { class: 'vw-cm-author' }, name), date),
        h('p', { class: 'vw-cm-text' }, chip, chip ? ' ' : null, String(c.text || ''))));
    li._date = date;
    li._created = created;
    li._pending = Boolean(c.pending);
    return li;
  }

  function render() {
    const items = sortComments(S.comments.filter((c) => c.kind !== 'reaction'));
    const seen = new Set();
    let prevEl = null;
    for (const c of items) {
      seen.add(c.id);
      let li = nodes.get(c.id);
      if (li && li._pending !== Boolean(c.pending)) { li.remove(); li = null; }
      if (!li) { li = node(c); nodes.set(c.id, li); }
      else if (!c.pending) li._date.textContent = formatRelativeDate(li._created);
      const expected = prevEl ? prevEl.nextSibling : list.firstChild;
      if (expected !== li) list.insertBefore(li, expected);
      prevEl = li;
    }
    for (const [id, li] of nodes) if (!seen.has(id)) { li.remove(); nodes.delete(id); }
    empty.hidden = items.length > 0 || !S.commentsLoaded;
    list.hidden = items.length === 0;
  }

  const el = h('div', { class: 'vw-panel vw-cm' }, scroller, composer);
  render();
  renderAt();
  let lastAt = '';
  return {
    el,
    allow,
    render,
    sync: () => renderAt(),
    setTime(t) {
      const label = formatTime(t);
      if (label !== lastAt) { lastAt = label; renderAt(); }
    },
    onPlay() {
      if (!atManual && !atOn) { atOn = true; renderAt(); }
    },
    disable() {
      // Comments were switched off while the page was open.
      if (!textarea) return;
      textarea = null;
      composer.replaceWith(h('div', { class: 'vw-cm-off' }, h('span', { html: icon('info', 16) }), 'Comments are turned off for this video.'));
    },
  };
}

/* ---------------- comments data ---------------- */

async function loadComments() {
  try {
    // fresh: S.comments may have been reset (password gate) since the last list we saw.
    const server = await api.listComments(shareId, { fresh: true });
    if (server) mergeComments(server);
    S.commentsLoaded = true;
  } catch {
    S.commentsLoaded = true;
  }
  commentsChanged();
  clearInterval(S.commentsTimer);
  S.commentsTimer = setInterval(() => {
    if (document.hidden || !S.share) return;
    refreshComments();
  }, COMMENTS_POLL_MS);
}

/** Re-reads the comments; an unchanged list costs the server a 304 and us nothing. */
async function refreshComments() {
  try {
    const server = await api.listComments(shareId);
    if (!server) return; // unchanged
    mergeComments(server);
    commentsChanged();
  } catch { /* keep what we have */ }
}

function mergeComments(server) {
  const pending = S.comments.filter((c) => c.pending);
  S.comments = [...server.filter((c) => c && c.id), ...pending];
}

function replaceComment(tempId, saved) {
  const i = S.comments.findIndex((c) => c.id === tempId);
  if (i < 0) return;
  if (saved && saved.id) {
    if (S.comments.some((c) => c.id === saved.id)) S.comments.splice(i, 1);   // a poll already brought it in
    else S.comments[i] = saved;
  } else {
    S.comments[i] = { ...S.comments[i], pending: false };
  }
  commentsChanged();
}

function removeComment(tempId) {
  S.comments = S.comments.filter((c) => c.id !== tempId);
  commentsChanged();
}

function commentsChanged() {
  S.player?.setMarkers(S.comments);
  if (mode !== 'watch' || !S.share || !P.side) return;
  const settings = S.share.settings || {};
  const n = S.comments.filter((c) => c.kind !== 'reaction').length;
  if (!P.panels.comments && (settings.allowComments || n > 0)) {
    S.sideKey = '';
    renderSide(S.share, S.share);
  }
  P.panels.comments?.render();
  updateCommentsTab();
  if (P.reacts && !P.reacts.hidden) renderReactions(Boolean(S.player));
}

function postErrorMessage(err, what) {
  const status = err?.status;
  if (status === 429) {
    const wait = Math.ceil(Number(err?.data?.retryAfter) || 0);
    return wait > 0 && wait < 120
      ? `You’re going a little fast. Try again in ${wait} second${wait === 1 ? '' : 's'}.`
      : 'You’re going a little fast. Try again in a minute.';
  }
  if (status === 403 && err?.data?.limitReached) return err?.message || 'This video can’t take any more comments.';
  if (status === 403 && !err?.data?.passwordRequired) return 'Comments and reactions are turned off for this video.';
  if (status === 401 || err?.data?.passwordRequired) return 'Your access expired. Reload the page to unlock the video again.';
  if (status === 404) return 'This video no longer exists.';
  if (status === 0) return `You’re offline. Your ${what} wasn’t posted.`;
  if (status === 400 || status === 413) return err?.message || `That ${what} couldn’t be posted.`;
  return `Couldn’t post your ${what}. Try again.`;
}

function handlePostError(err) {
  if (err?.status === 403 && !err?.data?.passwordRequired && !err?.data?.limitReached && S.share?.settings) {
    S.share.settings.allowComments = false;
    P.panels.comments?.disable?.();
    if (P.reacts) { P.reacts.hidden = true; P.reacts.replaceChildren(); }
  }
}
