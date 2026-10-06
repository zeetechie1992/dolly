// Library (home) view: empty-state hero, recordings grid, import via picker or
// drag-and-drop, theme toggle and storage usage.

import { h, clamp, formatTime, formatRelativeDate, formatBytes, downloadBlob, slugify, isTypingTarget, copyText } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import {
  listProjects, listProjectStamps, patchProject, deleteProject, createProjectWithMedia, sweepOrphanMedia,
  getMedia, storageEstimate, onProjectChange,
} from '../lib/db.js';
import { createProject, getBackground, BACKGROUNDS } from '../lib/project.js';
import { loadVideo, probeVideo, captureThumbnail } from '../lib/media.js';
import { toast, confirmDialog, promptDialog, openMenu, applyTheme, logo } from '../lib/ui.js';
import { findInterruptedTakes, recoverInterruptedTake, discardInterruptedTake } from '../recorder/recovery.js';

const THEMES = ['system', 'light', 'dark'];
const THEME_NAMES = { system: 'System', light: 'Light', dark: 'Dark' };

const FEATURES = [
  { icon: 'zoom-in', tint: 'accent', title: 'Auto zoom', text: 'Smooth, Screen Studio-style zooms that follow the action on screen.' },
  { icon: 'captions', tint: 'orange', title: 'Captions', text: 'Your live transcript becomes captions in six polished styles.' },
  { icon: 'sparkles', tint: 'purple', title: 'Instant summary', text: 'A title, TL;DR, key points and chapters, written for you.' },
  { icon: 'aspect', tint: 'teal', title: 'Any orientation', text: 'Landscape, portrait or square, ready for every platform.' },
];

// Used when a dropped file has no MIME type (common for .mkv / some .mov files).
const VIDEO_EXTENSIONS = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  ogv: 'video/ogg', avi: 'video/x-msvideo', '3gp': 'video/3gpp', mpg: 'video/mpeg', mpeg: 'video/mpeg',
};
const MIME_EXTENSIONS = {
  'video/webm': 'webm', 'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'video/ogg': 'ogv', 'video/x-msvideo': 'avi', 'video/3gpp': '3gp', 'video/mpeg': 'mpg',
};

// The progress toast may outlive the view (an import keeps going after navigation).
let ownToastHost = null;
// Orphaned media is swept once per page session (see sweepOrphanMediaOnce).
let orphanSweepStarted = false;

/**
 * @param {HTMLElement} container
 * @returns {() => void} cleanup
 */
export function mount(container) {
  let alive = true;
  let state = 'loading';
  let projects = [];
  let signatureCache = '';
  let query = '';
  let importing = false;
  let importProgress = null;
  let menu = null;
  let menuAnchor = null;
  let dialogs = 0;
  let dragDepth = 0;
  let loadSeq = 0;
  let flashOnRender = null; // id of a card to highlight once it appears (a recovered recording)
  const cards = new Map(); // id -> { el, project, link, more }
  const busy = new Set();
  const disposers = [];
  const timers = new Set();

  // Library DOM (rebuilt by renderLibrary)
  let grid = null;
  let countEl = null;
  let noResults = null;
  let noResultsTitle = null;

  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    disposers.push(() => target.removeEventListener(type, fn, opts));
  };
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const cancelLater = (id) => { clearTimeout(id); timers.delete(id); };

  /* ---------- Static chrome: nav, footer, drop overlay ---------- */

  const fileInput = h('input', { type: 'file', accept: 'video/*', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });

  const searchInput = h('input', {
    class: 'input home-search-input', type: 'search', placeholder: 'Search', autocomplete: 'off',
    spellcheck: 'false', 'aria-label': 'Search recordings by title',
  });
  const searchKbd = h('span', { class: 'kbd home-search-kbd', 'aria-hidden': 'true' }, '/');
  const searchClear = h('button', {
    class: 'home-search-clear', type: 'button', hidden: true, 'aria-label': 'Clear search',
    html: icon('x', 11, { strokeWidth: 2.6 }),
  });
  const searchWrap = h('div', { class: 'home-search', role: 'search', hidden: true },
    h('span', { class: 'home-search-icon', html: icon('search', 15, { strokeWidth: 2 }) }),
    searchInput, searchKbd, searchClear);

  const themeBtn = h('button', { class: 'btn btn-ghost btn-icon home-theme', type: 'button', 'data-tip-pos': 'bottom' });

  const importBtn = h('button', { class: 'btn btn-ghost home-nav-btn', type: 'button', 'aria-label': 'Import a video' },
    iconEl('upload', 17), h('span', { class: 'home-btn-label' }, 'Import'));

  const newBtn = h('a', { class: 'btn btn-primary home-nav-btn home-nav-new', href: '#/record', 'aria-label': 'New recording' },
    iconEl('record', 13), h('span', { class: 'home-btn-label' }, 'New recording'));

  const nav = h('nav', { class: 'nav home-nav', 'aria-label': 'Library' },
    logo(), h('div', { class: 'nav-spacer' }), searchWrap, themeBtn, importBtn, newBtn);

  const main = h('main', { class: 'home-main', 'aria-busy': 'true' });
  // Interrupted-recording banner (crash backup from recorder/recovery.js); empty when none.
  const recoverHost = h('div', { class: 'home-recover-host', hidden: true });

  const meterFill = h('span');
  const storageMeter = h('span', { class: 'home-meter', hidden: true, 'aria-hidden': 'true' }, meterFill);
  const storageText = h('span');
  const storageEl = h('span', { class: 'home-storage', hidden: true }, storageMeter, storageText);
  const footer = h('footer', { class: 'home-footer' },
    h('span', { class: 'home-footer-note' }, 'Recordings are stored privately in this browser'),
    storageEl);

  const dropIcon = h('div', { class: 'home-drop-icon', html: icon('upload', 30, { strokeWidth: 2 }) });
  const dropTitle = h('h2', { class: 'home-drop-title' }, 'Drop to import');
  const dropText = h('p', { class: 'home-drop-text' }, 'MP4, MOV or WebM. It stays on this device.');
  const overlay = h('div', { class: 'home-drop', hidden: true, 'aria-hidden': 'true' },
    h('div', { class: 'home-drop-frame' }, dropIcon, dropTitle, dropText));

  const glow = h('div', { class: 'home-glow', 'aria-hidden': 'true' },
    h('span', { class: 'home-glow-blob home-glow-a' }),
    h('span', { class: 'home-glow-blob home-glow-b' }),
    h('span', { class: 'home-glow-blob home-glow-c' }));

  const root = h('div', { class: 'home', dataset: { state: 'loading' } }, glow, nav, recoverHost, main, footer, overlay, fileInput);
  container.append(root);

  /* ---------- Theme ---------- */

  const schemeQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  // The attribute applied by applyTheme() is the source of truth (localStorage may be unavailable).
  const currentTheme = () => {
    const attr = document.documentElement.getAttribute('data-theme');
    return attr === 'light' || attr === 'dark' ? attr : 'system';
  };
  const nextTheme = (theme) => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

  function syncThemeButton() {
    const theme = currentTheme();
    const dark = theme === 'dark' || (theme === 'system' && Boolean(schemeQuery?.matches));
    themeBtn.innerHTML = icon(dark ? 'moon' : 'sun', 18);
    themeBtn.classList.toggle('is-auto', theme === 'system');
    const tip = theme === 'system' ? `Appearance: System (${dark ? 'Dark' : 'Light'})` : `Appearance: ${THEME_NAMES[theme]}`;
    themeBtn.dataset.tip = tip;
    themeBtn.setAttribute('aria-label', `${tip}. Switch to ${THEME_NAMES[nextTheme(theme)]}.`);
  }

  function cycleTheme() {
    applyTheme(nextTheme(currentTheme()));
    syncThemeButton();
  }

  /* ---------- Loading & rendering ---------- */

  let refreshTimer = 0;
  let lastQuietRefresh = -Infinity;

  /** Quiet reload soon; waits while a menu, dialog or action is open so the grid isn't swapped under it. */
  function requestRefresh(delay = 0) {
    if (!alive || refreshTimer) return;
    refreshTimer = later(() => {
      refreshTimer = 0;
      // Hidden: returning to the tab refreshes anyway (onReturn).
      if (!alive || document.visibilityState !== 'visible') return;
      if (state === 'loading' || importing || busy.size || dialogs || menuIsOpen()) {
        requestRefresh(1200);
        return;
      }
      lastQuietRefresh = performance.now();
      load({ quiet: true });
    }, delay);
  }

  let lastReturn = -Infinity;
  function onReturn() {
    if (document.visibilityState !== 'visible') return;
    const now = performance.now();
    // visibilitychange and focus fire together on tab return.
    if (now - lastReturn < 1000 || now - lastQuietRefresh < 1000) return;
    lastReturn = now;
    requestRefresh();
    scanInterrupted();
  }

  async function load({ quiet = false } = {}) {
    const seq = ++loadSeq;
    const skeletonTimer = quiet ? null : later(() => {
      if (alive && seq === loadSeq && state === 'loading') main.replaceChildren(renderSkeleton());
    }, 220);
    try {
      if (quiet) {
        // Keys-only check first, so returning to the tab doesn't deserialize every
        // thumbnail, transcript and summary just to find that nothing changed.
        const stamps = await listProjectStamps().catch(() => null);
        if (!alive || seq !== loadSeq) return;
        if (stamps === signatureCache) return;
      }
      const list = await listProjects();
      if (!alive || seq !== loadSeq) return;
      const next = (list || []).filter((p) => p && p.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const sig = signature(next);
      if (quiet && sig === signatureCache) return;
      projects = next;
      signatureCache = sig;
      render({ animate: !quiet });
    } catch (err) {
      if (!alive || seq !== loadSeq) return;
      console.warn('[home] could not load the library', err);
      if (!quiet) renderError(err);
    } finally {
      if (skeletonTimer) cancelLater(skeletonTimer);
    }
    refreshStorage();
  }

  function setState(next, content) {
    state = next;
    root.dataset.state = next;
    searchWrap.hidden = next !== 'library';
    if (next !== 'library' && query) setQuery('', { silent: true });
    main.setAttribute('aria-busy', String(next === 'loading'));
    main.replaceChildren(content);
  }

  function render({ animate = true } = {}) {
    closeMenu();
    cards.clear();
    if (projects.length) {
      setState('library', renderLibrary(animate));
      applyFilter();
    } else {
      setState('empty', renderEmpty(animate));
    }
    if (flashOnRender && cards.has(flashOnRender)) {
      flash(cards.get(flashOnRender).link);
      flashOnRender = null;
    }
  }

  function renderSkeleton() {
    const card = () => h('div', { class: 'home-card home-card-skel', 'aria-hidden': 'true' },
      h('div', { class: 'skeleton home-skel-thumb' }),
      h('div', { class: 'home-card-meta' },
        h('div', { class: 'home-card-text' },
          h('div', { class: 'skeleton home-skel-line' }),
          h('div', { class: 'skeleton home-skel-line home-skel-short' }))));
    return h('section', { class: 'home-library' },
      h('header', { class: 'home-lib-head' },
        h('div', {}, h('div', { class: 'skeleton home-skel-title' }), h('div', { class: 'skeleton home-skel-line home-skel-count' }))),
      h('div', { class: 'home-grid' }, Array.from({ length: 6 }, card)));
  }

  function renderError(err) {
    setState('error', h('div', { class: 'empty-state home-error' },
      h('div', { class: 'empty-icon', html: icon('warning', 26) }),
      h('h3', {}, 'Your library couldn’t be opened'),
      h('p', {}, err?.message || 'Something went wrong while reading your recordings.'),
      h('div', { class: 'home-error-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => load() }, 'Try again'),
        h('a', { class: 'btn btn-primary', href: '#/record' }, iconEl('record', 13), 'New recording'))));
  }

  /* ---------- Empty state ---------- */

  function renderEmpty(animate) {
    const rise = (el, delay) => {
      if (animate) {
        el.classList.add('home-rise');
        el.style.animationDelay = `${delay}ms`;
      }
      return el;
    };

    const hero = h('section', { class: 'home-hero', 'aria-labelledby': 'home-hero-title' },
      rise(h('div', { class: 'home-eyebrow' }, iconEl('sparkles', 14), 'Auto zoom, captions and instant summaries'), 0),
      rise(h('h1', { class: 'home-hero-title', id: 'home-hero-title' },
        'Record. ', h('span', { class: 'home-hero-accent' }, 'Polish.'), ' Share.'), 70),
      rise(h('p', { class: 'home-hero-sub' },
        'Capture your screen and camera. Dolly turns it into a polished video with smooth zooms, captions and an instant summary.'), 140),
      rise(h('div', { class: 'home-hero-ctas' },
        h('a', { class: 'btn btn-record btn-xl home-cta', href: '#/record' }, iconEl('record', 16), 'Start recording'),
        h('button', { class: 'btn btn-secondary btn-xl home-cta', type: 'button', onclick: openPicker }, iconEl('upload', 19), 'Import a video')), 210),
      rise(h('p', { class: 'home-hero-hint' },
        'Press ', h('span', { class: 'kbd' }, 'R'), ' to record, or drop a video anywhere on this page.'), 280));

    const features = h('ul', { class: 'home-features', 'aria-label': 'Features' },
      FEATURES.map((f, i) => rise(h('li', { class: `home-feature home-tint-${f.tint}` },
        h('span', { class: 'home-feature-icon', html: icon(f.icon, 20) }),
        h('h3', { class: 'home-feature-title' }, f.title),
        h('p', { class: 'home-feature-text' }, f.text)), 460 + i * 60)));

    return h('div', { class: 'home-empty' }, hero, rise(buildMock(), 360), features);
  }

  /** A CSS-only mock of the editor, to show what Dolly does before the first recording. */
  function buildMock() {
    const bg = getBackground('sonoma').css;
    const swatches = BACKGROUNDS.filter((b) => b.kind === 'mesh').slice(0, 6);
    const bars = [38, 52, 44, 63, 57, 71, 92, 66, 74, 58];
    const fakeSlider = (value) => {
      const el = h('div', { class: 'home-mock-slider' }, h('b'), h('i'));
      el.style.setProperty('--v', `${value}%`);
      return el;
    };
    const section = (label, ...children) => h('div', { class: 'home-mock-section' },
      h('div', { class: 'home-mock-label' }, label), ...children);

    const screen = h('div', { class: 'home-mock-screen' },
      h('div', { class: 'home-mock-zoomer' },
        h('div', { class: 'home-mock-appbar' }, h('i'), h('i'), h('i'), h('b')),
        h('div', { class: 'home-mock-side' }, h('i', { class: 'is-active' }), h('i'), h('i'), h('i'), h('i')),
        h('div', { class: 'home-mock-heading' }),
        h('div', { class: 'home-mock-subheading' }),
        h('div', { class: 'home-mock-stats' },
          ['accent', 'orange', 'green'].map((tint) => h('div', { class: `home-mock-stat home-tint-${tint}` }, h('span'), h('b'), h('i')))),
        h('div', { class: 'home-mock-chart' }, bars.map((v, i) => {
          const bar = h('i', { class: i === 6 ? 'is-focus' : '' });
          bar.style.height = `${v}%`;
          return bar;
        })),
        h('span', { class: 'home-mock-cursor', html: icon('cursor', 16, { strokeWidth: 1.4 }) })));

    const canvas = h('div', { class: 'home-mock-canvas', style: { background: bg } },
      screen,
      h('div', { class: 'home-mock-cam' }, h('span', { class: 'home-mock-face' })),
      h('div', { class: 'home-mock-caption' },
        h('span', { class: 'home-mock-cap home-mock-cap-a' }, 'Here’s the new dashboard'),
        h('span', { class: 'home-mock-cap home-mock-cap-b' }, 'Revenue is up 24% this week')));

    const inspector = h('div', { class: 'home-mock-inspector' },
      section('Background', h('div', { class: 'home-mock-swatches' }, swatches.map((b, i) => h('i', {
        class: i === 0 ? 'is-active' : '', style: { background: b.css },
      })))),
      section('Padding', fakeSlider(42)),
      section('Roundness', fakeSlider(64)),
      h('div', { class: 'home-mock-section home-mock-row' }, h('span', {}, 'Camera'), h('span', { class: 'home-mock-switch' })),
      section('Orientation', h('div', { class: 'home-mock-aspects' },
        h('i', { class: 'is-active home-mock-a169' }), h('i', { class: 'home-mock-a916' }), h('i', { class: 'home-mock-a11' }), h('i', { class: 'home-mock-a45' }))));

    const film = h('div', { class: 'home-mock-film' }, Array.from({ length: 12 }, () => h('i', { style: { background: bg } })));
    const timeline = h('div', { class: 'home-mock-timeline' },
      h('div', { class: 'home-mock-transport' },
        h('span', { class: 'home-mock-play', html: icon('play', 10) }),
        h('span', { class: 'home-mock-time' }, '0:12 / 0:42'),
        h('span', { class: 'home-mock-spacer' }),
        h('span', { class: 'home-mock-chip' }, iconEl('plus', 11, { strokeWidth: 2.4 }), 'Zoom'),
        h('span', { class: 'home-mock-chip' }, iconEl('sparkles', 11, { strokeWidth: 2 }), 'Auto zoom')),
      h('div', { class: 'home-mock-tracks' },
        film,
        h('div', { class: 'home-mock-track' }, h('span', { class: 'home-mock-zoom' }, iconEl('zoom-in', 11, { strokeWidth: 2.2 }), '1.7×')),
        h('div', { class: 'home-mock-track home-mock-track-caps' },
          h('span', { class: 'home-mock-capblock home-mock-capblock-a' }), h('span', { class: 'home-mock-capblock home-mock-capblock-b' })),
        h('span', { class: 'home-mock-playhead' })));

    return h('div', { class: 'home-mock-wrap', 'aria-hidden': 'true' },
      h('div', { class: 'home-mock' },
        h('div', { class: 'home-mock-bar' },
          h('div', { class: 'home-mock-lights' }, h('i'), h('i'), h('i')),
          h('div', { class: 'home-mock-steps' },
            h('span', { class: 'is-active' }, '1 Edit'), h('span', {}, '2 Captions'), h('span', {}, '3 Summary')),
          h('div', { class: 'home-mock-bar-end' }, h('span', { class: 'home-mock-export' }, 'Export'))),
        h('div', { class: 'home-mock-main' },
          h('div', { class: 'home-mock-stage' }, canvas),
          inspector),
        timeline));
  }

  /* ---------- Library ---------- */

  function renderLibrary(animate) {
    countEl = h('p', { class: 'home-lib-count', 'aria-live': 'polite' });
    grid = h('div', { class: 'home-grid', role: 'list' });
    projects.forEach((p, i) => grid.append(buildCard(p, i, animate)));
    noResultsTitle = h('h3', {});
    noResults = h('div', { class: 'empty-state home-no-results', hidden: true },
      h('div', { class: 'empty-icon', html: icon('search', 24) }),
      noResultsTitle,
      h('p', {}, 'Try another word, or clear the search to see everything.'),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => { setQuery(''); searchInput.focus(); } }, 'Clear search'));
    const section = h('section', { class: 'home-library', 'aria-labelledby': 'home-lib-title' },
      h('header', { class: 'home-lib-head' + (animate ? ' home-rise' : '') },
        h('div', {}, h('h1', { class: 'home-lib-title', id: 'home-lib-title' }, 'Library'), countEl)),
      grid,
      noResults);
    return section;
  }

  function buildCard(p, index, animate) {
    const title = p.title || 'Untitled recording';
    const href = `#/edit/${encodeURIComponent(p.id)}`;

    const thumb = h('div', { class: 'home-card-thumb' });
    if (p.thumbnail) {
      const img = h('img', { src: p.thumbnail, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      img.addEventListener('error', () => img.replaceWith(thumbPlaceholder(p)), { once: true });
      thumb.append(img);
    } else {
      thumb.append(thumbPlaceholder(p));
    }
    thumb.append(
      h('span', { class: 'home-card-play', 'aria-hidden': 'true', html: icon('play', 20) }),
      h('span', { class: 'home-card-duration' }, formatTime(displayDuration(p))));
    if (shareUrl(p)) {
      thumb.append(h('span', { class: 'home-card-shared', title: 'Shared — anyone with the link can watch' },
        h('span', { html: icon('link', 11, { strokeWidth: 2.4 }) }), 'Shared'));
    }

    const link = h('a', { class: 'home-card-link', href, title }, title);
    const ts = p.createdAt || p.updatedAt || Date.now();
    const sub = h('div', { class: 'home-card-sub' },
      h('time', { class: 'home-card-date', datetime: new Date(ts).toISOString() }, formatRelativeDate(ts)));
    if (p.summary) sub.append(h('span', { class: 'home-card-flag', 'data-tip': 'Has a summary', html: icon('sparkles', 13) }));
    if (Array.isArray(p.transcript) && p.transcript.length) sub.append(h('span', { class: 'home-card-flag', 'data-tip': 'Has captions', html: icon('captions', 13) }));

    const more = h('button', {
      class: 'btn btn-ghost btn-icon btn-sm home-card-more', type: 'button',
      'aria-label': `More actions for ${title}`, 'aria-haspopup': 'menu', html: icon('more', 18),
    });
    more.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCardMenu(p.id, more);
    });

    const card = h('article', { class: 'home-card', role: 'listitem', dataset: { id: p.id } },
      thumb,
      h('div', { class: 'home-card-meta' }, h('div', { class: 'home-card-text' }, link, sub), more));

    if (animate) {
      card.classList.add('home-card-enter');
      card.style.animationDelay = `${Math.min(index, 14) * 45}ms`;
      // Drop the entrance animation once played so filtering (display toggles) doesn't replay it.
      const onEnd = (e) => {
        if (e.target !== card) return;
        card.removeEventListener('animationend', onEnd);
        card.classList.remove('home-card-enter');
        card.style.animationDelay = '';
      };
      card.addEventListener('animationend', onEnd);
    }

    cards.set(p.id, { el: card, project: p, link, more });
    return card;
  }

  function thumbPlaceholder(p) {
    const el = h('div', { class: 'home-card-placeholder' }, h('span', { html: icon('film', 22) }));
    el.style.background = getBackground(p.edit?.background).css;
    return el;
  }

  function applyFilter() {
    if (state !== 'library' || !grid) return;
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    let shown = 0;
    let totalSeconds = 0;
    for (const { el, project } of cards.values()) {
      const haystack = normalize(project.title || 'Untitled recording');
      const match = terms.every((t) => haystack.includes(t));
      el.hidden = !match;
      if (match) shown++;
      totalSeconds += displayDuration(project);
    }
    const total = cards.size;
    if (terms.length) {
      countEl.textContent = `${shown} of ${total} ${plural(total, 'recording')}`;
    } else {
      countEl.textContent = `${total} ${plural(total, 'recording')}${totalSeconds >= 1 ? ` · ${formatTotal(totalSeconds)}` : ''}`;
    }
    const empty = terms.length > 0 && shown === 0;
    noResults.hidden = !empty;
    if (empty) noResultsTitle.textContent = `No results for “${query.trim()}”`;
  }

  function setQuery(value, { silent = false } = {}) {
    query = value;
    if (searchInput.value !== value) searchInput.value = value;
    searchClear.hidden = !value;
    searchKbd.hidden = Boolean(value);
    if (!silent) applyFilter();
  }

  /* ---------- Card actions ---------- */

  function closeMenu() {
    menu?.close();
    menu = null;
    menuAnchor = null;
  }

  // openMenu() closes itself on outside clicks without telling us, so check the DOM.
  const menuIsOpen = () => Boolean(menu && document.querySelector('.menu'));

  function toggleCardMenu(id, anchor) {
    const openForAnchor = menuIsOpen() && menuAnchor === anchor;
    closeMenu();
    if (openForAnchor || !cards.has(id)) return;
    menuAnchor = anchor;
    const url = shareUrl(cards.get(id).project);
    menu = openMenu(anchor, [
      { label: 'Open', icon: 'arrow-right', onClick: () => { location.hash = `#/edit/${encodeURIComponent(id)}`; } },
      url ? { label: 'Copy share link', icon: 'link', onClick: () => copyShareLink(url) } : null,
      { label: 'Rename…', icon: 'pencil', onClick: () => renameProject(id) },
      { label: 'Download original', icon: 'download', onClick: () => downloadOriginal(id) },
      'separator',
      { label: 'Delete…', icon: 'trash', danger: true, onClick: () => removeProject(id) },
    ].filter(Boolean));
  }

  async function copyShareLink(url) {
    const ok = await copyText(url).catch(() => false);
    toast(ok ? 'Link copied' : 'Couldn’t copy the link', { type: ok ? 'success' : 'error' });
  }

  async function renameProject(id) {
    const entry = cards.get(id);
    if (!entry || busy.has(id)) return;
    const current = entry.project.title || '';
    let name = null;
    dialogs++;
    try {
      name = await promptDialog({ title: 'Rename recording', label: 'Title', value: current, placeholder: 'Untitled recording', confirmText: 'Save' });
    } finally {
      dialogs--;
    }
    if (!alive || name === null) return;
    const title = name.replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!title || title === current) return;

    busy.add(id);
    try {
      // One read-modify-write transaction: never clobbers an edit another tab saved meanwhile.
      let fresh;
      try {
        fresh = await patchProject(id, { title });
      } catch (err) {
        if (err?.name !== 'NotFoundError') throw err;
        toast('This recording no longer exists', { type: 'error' });
        if (alive) requestRefresh();
        return;
      }
      entry.project.title = title;
      entry.project.updatedAt = fresh.updatedAt;
      signatureCache = signature(projects);
      if (!alive) return;
      entry.link.textContent = title;
      entry.link.title = title;
      entry.more.setAttribute('aria-label', `More actions for ${title}`);
      flash(entry.link);
      applyFilter();
    } catch (err) {
      console.warn('[home] rename failed', err);
      if (alive) toast('Couldn’t rename this recording', { type: 'error' });
    } finally {
      busy.delete(id);
    }
  }

  async function downloadOriginal(id) {
    const entry = cards.get(id);
    if (!entry) return;
    try {
      const blob = await getMedia(id, 'main');
      if (!blob) {
        toast('The video for this recording is missing', { type: 'error' });
        return;
      }
      downloadBlob(blob, `${slugify(entry.project.title)}.${extensionFor(blob)}`);
      toast('Download started', { type: 'success' });
    } catch (err) {
      console.warn('[home] download failed', err);
      toast('Couldn’t download this video', { type: 'error' });
    }
  }

  async function removeProject(id) {
    const entry = cards.get(id);
    if (!entry || busy.has(id)) return;
    const title = entry.project.title || 'Untitled recording';
    let ok = false;
    dialogs++;
    try {
      ok = await confirmDialog({
        title: 'Delete this recording?',
        message: `“${title}” will be permanently removed from this browser. This can’t be undone.${shareUrl(entry.project) ? ' Its share link keeps working — delete the link from the Share dialog first if you want it gone.' : ''}`,
        confirmText: 'Delete',
        danger: true,
      });
    } finally {
      dialogs--;
    }
    if (!ok || !alive || !cards.has(id)) return;

    busy.add(id);
    entry.el.classList.add('is-deleting');
    try {
      await deleteProject(id);
    } catch (err) {
      console.warn('[home] delete failed', err);
      busy.delete(id);
      entry.el.classList.remove('is-deleting');
      if (alive) toast('Couldn’t delete this recording', { type: 'error' });
      return;
    }
    busy.delete(id);
    projects = projects.filter((p) => p.id !== id);
    signatureCache = signature(projects);
    if (!alive) return;
    cards.delete(id);
    toast('Recording deleted', { type: 'success' });
    refreshStorage();
    await animateCardOut(entry.el, projects.length > 0);
    if (!alive) return;
    if (!projects.length) render();
    else applyFilter();
  }

  /** Fades the card out, then slides the remaining cards into place (FLIP). */
  function animateCardOut(card, reflow) {
    return new Promise((resolve) => {
      if (!card.isConnected || prefersReducedMotion() || typeof card.animate !== 'function') {
        card.remove();
        resolve();
        return;
      }
      const out = card.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.92)' }],
        { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        const parent = card.parentElement;
        const siblings = reflow && parent ? Array.from(parent.children).filter((c) => c !== card && !c.hidden) : [];
        const before = new Map(siblings.map((c) => [c, c.getBoundingClientRect()]));
        card.remove();
        for (const c of siblings) {
          const a = before.get(c);
          const b = c.getBoundingClientRect();
          const dx = a.left - b.left;
          const dy = a.top - b.top;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
          c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
        }
        resolve();
      };
      out.addEventListener('finish', finish);
      out.addEventListener('cancel', finish);
    });
  }

  /* ---------- Import ---------- */

  function openPicker() {
    if (importing) {
      importProgress?.nudge();
      return;
    }
    fileInput.click();
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const video = files.find((f) => videoMimeFor(f));
    if (!video) {
      toast(files.length > 1 ? 'None of those files are videos' : `“${shorten(files[0].name)}” isn’t a video file`, { type: 'error' });
      return;
    }
    importFile(video);
  }

  async function importFile(file) {
    if (importing) {
      importProgress?.nudge();
      return;
    }
    const type = videoMimeFor(file);
    if (!type) {
      toast(`“${shorten(file.name)}” isn’t a video file`, { type: 'error' });
      return;
    }
    if (!file.size) {
      toast('That video file is empty', { type: 'error' });
      return;
    }

    importing = true;
    root.classList.add('is-importing');
    const title = titleFromFileName(file.name);
    const progress = createProgressToast(title);
    importProgress = progress;
    const blob = file.type === type ? file : new Blob([file], { type });

    try {
      progress.set(0.08, 'Reading video…');
      const info = await probeVideo(blob);
      if (!info || !(info.duration > 0)) throw Object.assign(new Error('unreadable'), { code: 'unreadable' });
      if (!info.width || !info.height) throw Object.assign(new Error('no video track'), { code: 'no-video' });

      const project = createProject({
        duration: info.duration,
        mode: 'import',
        main: { width: info.width, height: info.height },
        camera: null,
        transcript: [],
        title,
      });
      project.edit.aspect = aspectFor(info.width, info.height);

      // Thumbnail first, from the in-memory file, so storing is the last and only write.
      progress.set(0.3, 'Creating thumbnail…');
      project.thumbnail = await makeThumbnail(blob, info.duration);

      // Project and video in one transaction, so a tab closed mid-import can't leave a
      // multi-GB blob without a project.
      progress.set(0.55, 'Saving to your library…');
      await createProjectWithMedia(project, { main: blob });
      progress.set(1, 'Ready');
      progress.close();

      if (alive) location.hash = `#/edit/${project.id}`;
      else toast(`Imported “${shorten(title)}”`, { type: 'success' });
    } catch (err) {
      console.warn('[home] import failed', err);
      progress.close();
      const message = importErrorMessage(err);
      toast(message, { type: 'error', duration: message.length > 80 ? 6500 : 4200 });
    } finally {
      importing = false;
      if (importProgress === progress) importProgress = null;
      root.classList.remove('is-importing');
    }
  }

  async function makeThumbnail(blob, duration) {
    const url = URL.createObjectURL(blob);
    let video = null;
    try {
      video = await loadVideo(url, { muted: true, knownDuration: duration });
      return await captureThumbnail(video, clamp(duration * 0.15, 0, 2), 480, 270);
    } catch (err) {
      console.warn('[home] thumbnail failed', err);
      return null;
    } finally {
      if (video) {
        video.removeAttribute('src');
        try { video.load(); } catch { /* already released */ }
      }
      URL.revokeObjectURL(url);
    }
  }

  /* ---------- Drag & drop ---------- */

  const dragHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  function dragLooksLikeVideo(e) {
    const items = Array.from(e.dataTransfer?.items || []).filter((it) => it.kind === 'file');
    // Item types are hidden during drag in some browsers; assume a video until the drop.
    if (!items.length) return true;
    return items.some((it) => !it.type || it.type === 'application/octet-stream' || it.type.startsWith('video/'));
  }

  function showDrop(e) {
    const reject = importing || !dragLooksLikeVideo(e);
    overlay.classList.toggle('is-reject', reject);
    dropIcon.innerHTML = icon(reject ? 'warning' : 'upload', 30, { strokeWidth: 2 });
    dropTitle.textContent = importing ? 'Finishing the current import' : reject ? 'Only videos can be imported' : 'Drop to import';
    dropText.textContent = importing ? 'Try again in a moment.' : reject ? 'Choose an MP4, MOV or WebM file.' : 'MP4, MOV or WebM. It stays on this device.';
    overlay.hidden = false;
  }

  function hideDrop() {
    dragDepth = 0;
    overlay.hidden = true;
  }

  function onDragEnter(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (dialogs > 0) return;
    dragDepth++;
    if (overlay.hidden) showDrop(e);
  }

  function onDragOver(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (dialogs > 0) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = importing ? 'none' : 'copy';
    if (overlay.hidden) showDrop(e);
  }

  function onDragLeave(e) {
    if (!dragHasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideDrop();
  }

  function onDrop(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault(); // keep the browser from navigating to the file
    hideDrop();
    if (dialogs > 0 || !alive) return;
    if (importing) {
      importProgress?.nudge();
      return;
    }
    handleFiles(e.dataTransfer.files);
  }

  /* ---------- Keyboard ---------- */

  function onKeyDown(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (isTypingTarget(e) || dialogs > 0 || document.querySelector('.modal-backdrop')) return;
    if (e.key === 'r' || e.key === 'R') {
      if (e.repeat) return;
      e.preventDefault();
      location.hash = '#/record';
    } else if (e.key === '/' && state === 'library') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  }

  /* ---------- Interrupted recordings ---------- */

  let interrupted = [];   // takes no tab is recording or saving any more, newest first
  let recovering = null;  // 'recover' | 'discard' while an action runs
  let scanTask = null;    // the scan in flight
  let rescan = false;

  /**
   * Never rejects. Scans run one at a time, and never during an action: each briefly holds the
   * take's lock, so overlapping work would see the take as busy (being handled elsewhere).
   */
  function scanInterrupted() {
    if (scanTask || recovering) {
      rescan = true;
      return scanTask || Promise.resolve();
    }
    scanTask = (async () => {
      try {
        do {
          rescan = false;
          const takes = await findInterruptedTakes();
          if (!alive) return;
          interrupted = takes;
        } while (rescan && !recovering);
        if (!recovering) renderRecover();
      } finally {
        scanTask = null;
      }
    })();
    return scanTask;
  }

  function renderRecover() {
    const take = interrupted[0];
    if (!take) {
      recoverHost.hidden = true;
      recoverHost.replaceChildren();
      return;
    }
    const n = interrupted.length;
    const facts = [];
    if (take.seconds > 0) facts.push(`about ${formatTime(take.seconds)}`);
    if (take.createdAt > 0) {
      const when = formatRelativeDate(take.createdAt);
      facts.push(/^(Just now|Yesterday)$/.test(when) ? when.toLowerCase() : when);
    }
    const lead = n === 1 ? 'Dolly kept what was captured' : 'Dolly kept what was captured. Newest first';
    const busyNow = Boolean(recovering);
    const banner = h('section', { class: `home-recover${recoverHost.hidden ? ' home-rise' : ''}`, role: 'status', 'aria-label': 'Interrupted recording' },
      h('span', { class: 'home-recover-icon', html: icon('restart', 18, { strokeWidth: 2 }) }),
      h('div', { class: 'home-recover-text' },
        h('h2', { class: 'home-recover-title' }, n === 1 ? 'A recording was interrupted' : `${n} recordings were interrupted`),
        h('p', { class: 'home-recover-sub' }, `${lead}${facts.length ? `: ${facts.join(', ')}` : ''}.`)),
      h('div', { class: 'home-recover-actions' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: busyNow, onclick: discardTake }, 'Discard'),
        h('button', { class: 'btn btn-tinted btn-sm home-recover-go', type: 'button', disabled: busyNow, 'aria-busy': String(recovering === 'recover'), onclick: recoverTake },
          recovering === 'recover' ? h('span', { class: 'spinner home-recover-spinner', 'aria-hidden': 'true' }) : null,
          recovering === 'recover' ? 'Recovering…' : 'Recover')));
    recoverHost.replaceChildren(banner);
    recoverHost.hidden = false;
  }

  async function recoverTake() {
    const take = interrupted[0];
    if (!take || recovering) return;
    recovering = 'recover';
    renderRecover();
    await scanTask; // let a scan in flight release the take's lock first
    let project = null;
    let error = null;
    try {
      project = await recoverInterruptedTake(take);
    } catch (err) {
      error = err;
      console.warn('[home] recovering an interrupted recording failed', err);
    }
    recovering = null;
    // Recovered, or handled elsewhere: drop it now rather than flash it again until the rescan.
    if (!error) interrupted = interrupted.filter((t) => t.id !== take.id);
    if (project) {
      const id = project.id;
      toast(h('span', { class: 'home-toast-msg' }, 'Recording recovered to your library.',
        h('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: () => { location.hash = `#/edit/${encodeURIComponent(id)}`; } }, 'Open')),
      { type: 'success', duration: 8000 });
      // Highlight its card: now if the list already picked it up, else on the next render.
      if (alive && cards.has(id)) flash(cards.get(id).link);
      else if (alive) {
        flashOnRender = id;
        requestRefresh();
      }
    } else if (error) {
      const quota = error?.name === 'QuotaExceededError' || /quota/i.test(String(error?.message || ''));
      toast(quota ? 'Not enough storage space to recover this recording' : 'Couldn’t recover this recording. Please try again.', { type: 'error', duration: 5000 });
    } else {
      toast('Nothing to recover. It may have been handled in another window.');
    }
    if (!alive) return;
    renderRecover();
    scanInterrupted();
  }

  async function discardTake() {
    const take = interrupted[0];
    if (!take || recovering) return;
    let ok = false;
    dialogs++;
    try {
      ok = await confirmDialog({
        title: 'Discard the interrupted recording?',
        message: 'What was captured will be deleted. This can’t be undone.',
        confirmText: 'Discard',
        danger: true,
      });
    } finally {
      dialogs--;
    }
    if (!ok || !alive || recovering) return;
    recovering = 'discard';
    renderRecover();
    await scanTask;
    try {
      await discardInterruptedTake(take);
      interrupted = interrupted.filter((t) => t.id !== take.id);
    } catch (err) {
      console.warn('[home] discarding an interrupted recording failed', err);
      if (alive) toast('Couldn’t discard this recording', { type: 'error' });
    }
    recovering = null;
    if (!alive) return;
    renderRecover();
    scanInterrupted();
    refreshStorage();
  }

  /* ---------- Storage ---------- */

  async function refreshStorage() {
    const est = await storageEstimate();
    if (!alive) return;
    if (!est || !Number.isFinite(est.usage)) {
      storageEl.hidden = true;
      return;
    }
    const used = formatBytes(est.usage);
    const hasQuota = Number.isFinite(est.quota) && est.quota > 0;
    storageText.textContent = hasQuota ? `${used} of ${formatBytes(est.quota)} used` : `${used} used`;
    storageMeter.hidden = !hasQuota;
    if (hasQuota) meterFill.style.width = `${clamp((est.usage / est.quota) * 100, 1.5, 100)}%`;
    storageEl.hidden = false;
  }

  /* ---------- Wiring ---------- */

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // allow picking the same file again
    if (file && alive) importFile(file);
  });
  importBtn.addEventListener('click', openPicker);
  themeBtn.addEventListener('click', cycleTheme);
  searchInput.addEventListener('input', () => setQuery(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (searchInput.value) setQuery('');
    else searchInput.blur();
  });
  searchClear.addEventListener('click', () => { setQuery(''); searchInput.focus(); });

  listen(document, 'keydown', onKeyDown);
  listen(window, 'dragenter', onDragEnter);
  listen(window, 'dragover', onDragOver);
  listen(window, 'dragleave', onDragLeave);
  listen(window, 'drop', onDrop);
  listen(window, 'dragend', hideDrop);

  // Keep the list current: writes in this tab ('dolly:projects-changed': a recording that
  // finished saving after the user came here, a recovered one), writes in other tabs
  // (onProjectChange), and returning to the tab. Quiet loads compare stamps first, so this is cheap.
  listen(document, 'visibilitychange', onReturn);
  listen(window, 'focus', onReturn);
  listen(window, 'dolly:projects-changed', () => requestRefresh(120));
  disposers.push(onProjectChange(() => requestRefresh(120)));

  if (schemeQuery) {
    if (typeof schemeQuery.addEventListener === 'function') listen(schemeQuery, 'change', syncThemeButton);
    else if (typeof schemeQuery.addListener === 'function') {
      schemeQuery.addListener(syncThemeButton);
      disposers.push(() => schemeQuery.removeListener(syncThemeButton));
    }
  }

  syncThemeButton();
  load().then(() => sweepOrphanMediaOnce((removed) => { if (alive && removed) refreshStorage(); }));
  scanInterrupted();

  return () => {
    alive = false;
    loadSeq++;
    closeMenu();
    // confirmDialog/promptDialog expose no handle; their Escape handler closes them cleanly.
    if (dialogs > 0) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch { /* ignore */ }
    }
    for (const id of timers) clearTimeout(id);
    timers.clear();
    hideDrop();
    cards.clear();
    root.remove();
  };
}

/* ---------- Progress toast ---------- */

// Joins the shared .toast-stack from ui.js when it exists so toasts never overlap.
function placeToast(el) {
  const shared = Array.from(document.querySelectorAll('.toast-stack')).find((s) => s !== ownToastHost);
  if (shared) {
    if (el.parentElement !== shared) shared.append(el);
    releaseOwnHost();
    return;
  }
  if (el.parentElement) return;
  if (!ownToastHost || !ownToastHost.isConnected) {
    ownToastHost = h('div', { class: 'toast-stack home-toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(ownToastHost);
  }
  ownToastHost.append(el);
}

function releaseOwnHost() {
  if (ownToastHost && !ownToastHost.childElementCount) {
    ownToastHost.remove();
    ownToastHost = null;
  }
}

function createProgressToast(name) {
  const fill = h('div', { style: { width: '0%' } });
  const bar = h('div', { class: 'progress home-import-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const step = h('span', { class: 'home-import-step' }, 'Preparing…');
  const el = h('div', { class: 'toast home-import-toast' },
    h('span', { class: 'home-import-spinner', 'aria-hidden': 'true' }),
    h('div', { class: 'home-import-body' },
      h('div', { class: 'home-import-title' }, `Importing “${shorten(name, 36)}”`),
      bar,
      step));
  placeToast(el);
  // Move into ui.js's stack the moment it appears so the two stacks never overlap.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => placeToast(el)) : null;
  observer?.observe(document.body, { childList: true });
  let closed = false;
  return {
    set(fraction, label) {
      if (closed) return;
      placeToast(el);
      const pct = Math.round(clamp(fraction, 0, 1) * 100);
      fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
      if (label) step.textContent = label;
    },
    nudge() {
      if (closed) return;
      el.classList.remove('home-nudge');
      void el.offsetWidth; // restart the animation
      el.classList.add('home-nudge');
    },
    close() {
      if (closed) return;
      closed = true;
      observer?.disconnect();
      el.classList.remove('home-nudge');
      el.classList.add('leaving');
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        el.remove();
        releaseOwnHost();
      };
      el.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, 450);
    },
  };
}

/* ---------- Helpers ---------- */

function iconEl(name, size = 18, opts) {
  const tpl = document.createElement('template');
  tpl.innerHTML = icon(name, size, opts);
  return tpl.content.firstElementChild;
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The project's share link URL, or '' when it isn't shared. */
function shareUrl(p) {
  const url = p?.share?.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

/** Order-independent `id:updatedAt` list; same format as db.listProjectStamps(). */
function signature(list) {
  return list.map((p) => `${p.id}:${p.updatedAt || 0}`).sort().join('|');
}

/**
 * Deletes media left without a project by an interrupted save (older, multi-step saves),
 * once per page session. Safe across tabs because every new project is now written together
 * with its media (createProjectWithMedia in import, record and recovery).
 */
function sweepOrphanMediaOnce(onDone) {
  if (orphanSweepStarted) return;
  orphanSweepStarted = true;
  sweepOrphanMedia().then(onDone, (err) => {
    orphanSweepStarted = false; // try again the next time the library opens
    console.warn('[home] could not clean up unused media', err);
  });
}

/** Length of the edited (trimmed) video, falling back to the full duration. */
function displayDuration(p) {
  const duration = Number(p.duration) || 0;
  const trim = p.edit?.trim;
  if (trim && Number.isFinite(trim.start) && Number.isFinite(trim.end) && trim.end > trim.start) {
    return Math.max(0, Math.min(trim.end, duration || trim.end) - Math.max(0, trim.start));
  }
  return duration;
}

function formatTotal(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

const plural = (n, word) => (n === 1 ? word : `${word}s`);

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function shorten(text, max = 48) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function flash(el) {
  el.classList.remove('home-flash');
  void el.offsetWidth;
  el.classList.add('home-flash');
}

/** Returns the video MIME type for a file, or null if it is not a video. */
function videoMimeFor(file) {
  const type = (file?.type || '').toLowerCase();
  if (type.startsWith('video/')) return file.type;
  const ext = (/\.([a-z0-9]+)$/i.exec(file?.name || '')?.[1] || '').toLowerCase();
  if ((!type || type === 'application/octet-stream') && VIDEO_EXTENSIONS[ext]) return VIDEO_EXTENSIONS[ext];
  return null;
}

function extensionFor(blob) {
  const type = (blob.type || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXTENSIONS[type]) return MIME_EXTENSIONS[type];
  const fromName = /\.([a-z0-9]{2,4})$/i.exec(blob.name || '')?.[1];
  if (fromName) return fromName.toLowerCase();
  const subtype = type.startsWith('video/') ? type.slice(6).replace(/^x-/, '').replace(/[^a-z0-9]/g, '') : '';
  return subtype || 'webm';
}

function titleFromFileName(name) {
  const base = String(name || '').replace(/\.[^./\\]+$/, '').trim();
  return (base || 'Imported video').slice(0, 140);
}

/** Picks the output orientation that best matches an imported video. */
function aspectFor(width, height) {
  const r = width / height;
  if (r < 0.7) return '9:16';
  if (r < 0.9) return '4:5';
  if (r <= 1.12) return '1:1';
  return '16:9';
}

function importErrorMessage(err) {
  const name = err?.name || '';
  const message = String(err?.message || '');
  if (name === 'QuotaExceededError' || /quota/i.test(message)) return 'Not enough storage space to import this video';
  if (err?.code === 'no-video') return 'This file has no video Dolly can play (audio-only or an unsupported codec like ProRes). Try an H.264 MP4 or WebM.';
  const unreadable = err?.code === 'unreadable'
    || (typeof MediaError !== 'undefined' && err instanceof MediaError)
    || /load video|timed out/i.test(message);
  if (unreadable) return 'Dolly couldn’t read this video. Try an MP4 or WebM file.';
  return 'Import failed. Please try again.';
}
