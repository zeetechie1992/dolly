// Custom video player for the share page (/s/:id) and the embed (/embed/:id).
// Poster + big play button, auto-hiding control bar (play, time, chapter, volume, speed, CC, PiP,
// fullscreen, download), scrubber with buffered ranges, chapter gaps, hover time tooltip and
// comment/reaction markers, styled caption overlay drawn with editor/captions.js, keyboard shortcuts.
//
//   const player = createPlayer({ share, mode: 'watch' | 'embed', startTime, autoplay })
//   player.el · player.video · player.time · player.duration · player.paused · player.started
//   player.play() · pause() · toggle() · seek(t) · setMarkers(items) · floatEmoji(emoji) · reload(share) · destroy()
//   player.on('time' | 'play' | 'pause' | 'ended' | 'watched' (seconds actually played), fn)
//   onRetry: optional async () => fresh share (or null) used by the media-error "Try again" button.

import { h, clamp, formatTime, isTypingTarget, syncSliderFill, Emitter } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { toast } from '../lib/ui.js';
import { buildCaptionChunks, drawCaptions } from '../editor/captions.js';
import {
  SPEEDS, containRect, scaleCamera, chapterMask, bufferedFractions, clusterMarkers,
  lastStartedIndex, cleanChapters, captionsOverlayAvailable, avatarColor, initialOf, cleanName,
} from './helpers.js';

const PREF = { volume: 'dolly.viewer.volume', muted: 'dolly.viewer.muted', rate: 'dolly.viewer.rate' };
const HIDE_AFTER_MS = 2600;

function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* storage unavailable */ }
}

const speedLabel = (r) => `${r}×`;

export function createPlayer({ share, mode = 'watch', startTime = null, autoplay = false, onRetry = null }) {
  const events = new Emitter();
  let current = share;
  let destroyed = false;
  let started = false;
  let active = false;          // recent pointer/keyboard activity → chrome visible
  let hideTimer = 0;
  let rafId = 0;
  let seekRaf = 0;
  let scrubbing = null;        // { time, wasPlaying }
  let menuOpen = false;
  let ccOn = false;
  let ccCtx = null;
  let ccRect = { x: 0, y: 0, w: 0, h: 0 };
  let markerItems = [];
  let watched = 0;
  let lastTick = null;
  let lastPointer = 'mouse';
  let osdTimer = 0;
  let lastTimeText = '';
  let chapterIdx = -2;

  const knownDuration = () => Number(current.video?.duration) || Number(current.duration) || 0;
  const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : knownDuration());
  let chapters = [];

  /* ---------------- DOM ---------------- */

  const video = h('video', {
    class: 'vw-video', playsinline: true, 'webkit-playsinline': true, preload: 'metadata', tabindex: '-1',
    'aria-label': current.title || 'Video',
  });
  if (current.posterUrl) video.poster = current.posterUrl;

  const ccCanvas = h('canvas', { class: 'vw-cc', 'aria-hidden': 'true' });
  const floatLayer = h('div', { class: 'vw-floats', 'aria-hidden': 'true' });
  const buffering = h('div', { class: 'vw-buffering', 'aria-hidden': 'true' }, h('div', { class: 'vw-ring' }));
  const osd = h('div', { class: 'vw-osd', 'aria-hidden': 'true' });

  const bigPlay = h('button', {
    type: 'button', class: 'vw-bigplay', 'aria-label': 'Play video', html: icon('play', 30),
    onclick: (e) => {
      e.stopPropagation();
      play();
      // The button fades out and goes hidden once playing: hand focus to the player so Space keeps meaning
      // play/pause instead of re-clicking an invisible button. (`root` is declared below; it exists by click time.)
      if (document.activeElement === bigPlay) root.focus({ preventScroll: true });
    },
  });
  const durBadge = h('div', { class: 'vw-dur-badge t-mono', 'aria-hidden': 'true' }, formatTime(knownDuration()));

  const errTitle = h('strong');
  const errText = h('p');
  const errBox = h('div', { class: 'vw-perror', role: 'alert', hidden: true },
    h('div', { class: 'vw-perror-icon', html: icon('warning', 22) }),
    errTitle, errText,
    h('button', { type: 'button', class: 'btn btn-sm vw-perror-retry', onclick: () => retry() }, h('span', { html: icon('refresh', 15) }), 'Try again'),
  );

  // Embed: title + Dolly badge, shown on hover / pause.
  const watchHref = `/s/${encodeURIComponent(current.id)}`;
  const embedTitle = mode === 'embed'
    ? h('a', { class: 'vw-etitle', href: watchHref, target: '_blank', rel: 'noopener' }, current.title || 'Untitled video')
    : null;
  const embedTop = mode === 'embed'
    ? h('div', { class: 'vw-etop' },
        embedTitle,
        h('a', { class: 'vw-ebadge', href: watchHref, target: '_blank', rel: 'noopener', 'aria-label': 'Watch on Dolly (opens in a new tab)' },
          h('span', { class: 'logo-mark', 'aria-hidden': 'true' }), 'Dolly'))
    : null;

  // Scrubber
  const bufferedEl = h('div', { class: 'vw-track-buffered' });
  const hoverFill = h('div', { class: 'vw-track-hover' });
  const playedFill = h('div', { class: 'vw-track-played' });
  const track = h('div', { class: 'vw-track' }, h('div', { class: 'vw-track-bg' }), bufferedEl, hoverFill, playedFill);
  const thumb = h('div', { class: 'vw-thumb', 'aria-hidden': 'true' });
  const tipTitle = h('span', { class: 'vw-tip-title' });
  const tipTime = h('span', { class: 'vw-tip-time t-mono' });
  const tip = h('div', { class: 'vw-tip', 'aria-hidden': 'true' }, tipTitle, tipTime);
  const scrub = h('div', {
    class: 'vw-scrub', role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0',
  }, track, thumb, tip);
  const markerLayer = h('div', { class: 'vw-markers' });
  const markerTip = h('div', { class: 'vw-mtip', role: 'tooltip', hidden: true });

  // Control buttons (mousedown preventDefault keeps focus off them, so Space keeps meaning play/pause).
  const noFocus = (e) => e.preventDefault();
  const ctl = (cls, label, iconName, onClick, tipPos) => h('button', {
    type: 'button', class: `vw-ctl ${cls}`, 'aria-label': label, 'data-tip': label, 'data-tip-align': tipPos || false,
    html: icon(iconName, 20), onclick: onClick, onmousedown: noFocus,
  });
  const setLabel = (btn, label) => { btn.setAttribute('aria-label', label); btn.dataset.tip = label; };

  const playBtn = ctl('vw-ctl-play', 'Play (k)', 'play', () => toggle(), 'start');
  const muteBtn = ctl('vw-ctl-mute', 'Mute (m)', 'speaker', () => toggleMute());
  const volSlider = h('input', {
    type: 'range', class: 'slider vw-vol-slider', min: '0', max: '1', step: '0.01', 'aria-label': 'Volume',
  });
  const volume = h('div', { class: 'vw-vol' }, muteBtn, volSlider);
  const timeCur = h('span', { class: 'vw-time-cur' }, '0:00');
  const timeDur = h('span', { class: 'vw-time-dur' }, formatTime(knownDuration()));
  const timeEl = h('div', { class: 'vw-time t-mono', 'aria-hidden': 'true' }, timeCur, h('span', { class: 'vw-time-sep' }, '/'), timeDur);
  const chapterLabel = h('div', { class: 'vw-chapter-label', hidden: true });

  const speedText = h('span', { class: 'vw-speed-text' }, '1×');
  const speedBtn = h('button', {
    type: 'button', class: 'vw-ctl vw-ctl-speed', 'aria-label': 'Playback speed', 'data-tip': 'Speed',
    'aria-haspopup': 'menu', 'aria-expanded': 'false', onmousedown: noFocus, onclick: () => toggleSpeedMenu(),
  }, speedText);
  const speedItems = SPEEDS.map((rate) => h('button', {
    type: 'button', class: 'vw-pop-item', role: 'menuitemradio', 'aria-checked': 'false', dataset: { rate: String(rate) },
    // Keyboard selection (detail 0) hands focus back to the speed button; a mouse pick leaves it free so Space keeps meaning play/pause.
    onclick: (e) => { setRate(rate); closeSpeedMenu(e.detail === 0); },
  }, h('span', { class: 'vw-pop-check', html: icon('check', 14) }), rate === 1 ? 'Normal' : speedLabel(rate)));
  const speedMenu = h('div', { class: 'vw-pop', role: 'menu', 'aria-label': 'Playback speed', hidden: true },
    h('div', { class: 'vw-pop-title' }, 'Playback speed'), speedItems);

  const ccBtn = ctl('vw-ctl-cc', 'Captions (c)', 'captions', () => toggleCaptions());
  const pipBtn = ctl('vw-ctl-pip', 'Picture in picture', 'picture-in-picture', () => togglePiP());
  const fsBtn = ctl('vw-ctl-fs', 'Full screen (f)', 'expand', () => toggleFullscreen(), 'end');
  const dlBtn = h('a', {
    class: 'vw-ctl vw-ctl-dl', 'aria-label': 'Download video', 'data-tip': 'Download', 'data-tip-align': 'end',
    download: '', html: icon('download', 20), onmousedown: noFocus,
  });

  const controls = h('div', { class: 'vw-controls' },
    markerLayer,
    scrub,
    h('div', { class: 'vw-bar' },
      h('div', { class: 'vw-bar-group' }, playBtn, volume, timeEl, chapterLabel),
      h('div', { class: 'vw-bar-group vw-bar-right' }, h('div', { class: 'vw-speed' }, speedBtn, speedMenu), ccBtn, pipBtn, dlBtn, fsBtn),
    ),
  );

  const root = h('div', {
    class: `vw-player vw-player-${mode}`, tabindex: '-1', 'aria-label': `Video player: ${current.title || 'Untitled video'}`, role: 'region',
  },
    video, ccCanvas, floatLayer, embedTop, durBadge, bigPlay, buffering, osd, errBox, h('div', { class: 'vw-shade', 'aria-hidden': 'true' }), controls, markerTip);

  const vw0 = Number(current.video?.width) || Number(current.layout?.width) || 16;
  const vh0 = Number(current.video?.height) || Number(current.layout?.height) || 9;
  root.style.setProperty('--vw-ar', String(vw0 / vh0));

  /* ---------------- feature detection ---------------- */

  const fsEnabled = (document.fullscreenEnabled ?? document.webkitFullscreenEnabled) !== false
    && Boolean(root.requestFullscreen || root.webkitRequestFullscreen || video.webkitEnterFullscreen);
  fsBtn.hidden = !fsEnabled;
  pipBtn.hidden = !(document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function');

  /* ---------------- source & prefs ---------------- */

  function applySource(next) {
    const hadCC = ccAvailable;
    current = next;
    chapters = cleanChapters(current.summary?.chapters, knownDuration());
    ccAvailable = captionsOverlayAvailable(current);
    chunks = ccAvailable ? buildCaptionChunks(current.transcript) : [];
    if (!ccAvailable) ccOn = false;
    else if (!hadCC) ccOn = true;   // captions became available (default on)
    ccBtn.hidden = !ccAvailable;
    root.classList.toggle('has-cc', ccAvailable);
    ccCanvas.classList.toggle('is-bottom', (current.captions?.position || 'bottom') === 'bottom');
    const dl = current.video?.downloadUrl;
    dlBtn.hidden = !dl;
    if (dl) dlBtn.href = dl; else dlBtn.removeAttribute('href');
    if (current.posterUrl) video.poster = current.posterUrl;
    renderChapters();
    renderMarkers();
    renderTime();
    if (initialized) {
      renderCC();
      layoutOverlay();
    }
  }

  const savedVolume = Number(readPref(PREF.volume));
  if (readPref(PREF.volume) !== null && Number.isFinite(savedVolume)) video.volume = clamp(savedVolume, 0, 1);
  video.muted = readPref(PREF.muted) === '1';
  const savedRate = Number(readPref(PREF.rate));
  if (SPEEDS.includes(savedRate)) { video.defaultPlaybackRate = savedRate; video.playbackRate = savedRate; }

  let initialized = false;
  let ccAvailable = false;
  let chunks = [];
  applySource(current);
  video.src = current.video?.url || '';
  if (mode === 'embed' && autoplay) { video.muted = true; video.autoplay = true; }

  /* ---------------- playback ---------------- */

  function play() {
    if (video.error) { retry(); return; }   // a failed source can't play: reload it instead
    clearError();
    const p = video.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err?.name === 'NotAllowedError') {
          // Playback without a user gesture was blocked: back to the poster + play button.
          if (video.paused && !video.currentTime) {
            started = false;
            root.classList.remove('is-started');
            updateChrome();
          }
        } else if (err?.name !== 'AbortError') {
          console.warn('[viewer] play failed', err);
        }
      });
    }
  }
  function pause() { video.pause(); }
  function toggle() {
    if (video.paused || video.ended) play();
    else pause();
  }
  function seek(t, { show = false } = {}) {
    const d = duration();
    const target = clamp(Number(t) || 0, 0, d > 0 ? Math.max(0, d - 0.05) : Math.max(0, Number(t) || 0));
    try { video.currentTime = target; } catch { /* not seekable yet */ }
    root.classList.remove('is-ended');
    renderTime(target);
    drawCC();
    events.emit('time', target);
    if (show) poke();
  }
  function seekBy(delta) {
    seek(video.currentTime + delta, { show: true });
    flashOsd(delta > 0 ? `+${delta}s` : `−${Math.abs(delta)}s`);
  }

  /* ---------------- chrome visibility ---------------- */

  function keyboardFocusInControls() {
    if (!controls.contains(document.activeElement)) return false;
    try { return document.activeElement.matches(':focus-visible'); } catch { return true; }
  }
  function updateChrome() {
    const visible = started && (video.paused || video.ended || active || Boolean(scrubbing) || menuOpen || keyboardFocusInControls());
    root.classList.toggle('is-chrome', visible);
  }
  function poke() {
    active = true;
    updateChrome();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (controls.matches(':hover') && lastPointer === 'mouse') { poke(); return; }   // resting on the bar
      active = false;
      updateChrome();
    }, HIDE_AFTER_MS);
  }

  root.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);
  root.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') poke(); });
  root.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse' || scrubbing || menuOpen) return;
    clearTimeout(hideTimer);
    active = false;
    updateChrome();
  });
  root.addEventListener('focusin', () => updateChrome());
  root.addEventListener('focusout', () => setTimeout(updateChrome));

  video.addEventListener('click', (e) => {
    if (lastPointer === 'touch' && started && !root.classList.contains('is-chrome')) { poke(); return; }
    if (e.detail === 2) {
      // Second click of a double-click: undo the first click's toggle and go full screen.
      toggle();
      if (fsEnabled) toggleFullscreen();
      return;
    }
    if (e.detail > 2) return;
    toggle();
    if (lastPointer === 'touch') poke();
  });

  /* ---------------- render: time, buffered, chapters, markers ---------------- */

  function renderTime(t = scrubbing ? scrubbing.time : video.currentTime) {
    const d = duration();
    const frac = d > 0 ? clamp(t / d, 0, 1) : 0;
    playedFill.style.transform = `scaleX(${frac})`;
    thumb.style.left = `${frac * 100}%`;
    const text = formatTime(t);
    if (text !== lastTimeText) {
      lastTimeText = text;
      timeCur.textContent = text;
      scrub.setAttribute('aria-valuenow', String(Math.round(t)));
      scrub.setAttribute('aria-valuetext', `${text} of ${formatTime(d)}`);
    }
    const idx = chapters.length ? lastStartedIndex(chapters, t + 0.05) : -1;
    if (idx !== chapterIdx) {
      chapterIdx = idx;
      chapterLabel.hidden = idx < 0;
      chapterLabel.textContent = idx >= 0 ? chapters[idx].title : '';
    }
  }

  function renderDuration() {
    const d = duration();
    timeDur.textContent = formatTime(d);
    durBadge.textContent = formatTime(d);
    scrub.setAttribute('aria-valuemax', String(Math.round(d)));
  }

  function renderBuffered() {
    const ranges = bufferedFractions(video.buffered, duration());
    const kids = bufferedEl.children;
    while (kids.length > ranges.length) kids[kids.length - 1].remove();
    ranges.forEach(([a, b], i) => {
      const el = kids[i] || bufferedEl.appendChild(h('div'));
      el.style.left = `${a * 100}%`;
      el.style.width = `${(b - a) * 100}%`;
    });
  }

  function renderChapters() {
    const mask = chapterMask(chapters, duration(), 3);
    track.style.webkitMaskImage = mask || '';
    track.style.maskImage = mask || '';
  }

  function renderMarkers() {
    markerLayer.replaceChildren();
    hideMarkerTip();
    const d = duration();
    const clusters = clusterMarkers(markerItems, d);
    root.classList.toggle('has-markers', clusters.length > 0);
    for (const m of clusters) {
      const firstComment = m.items.find((it) => it.kind !== 'reaction');
      const label = markerLabel(m);
      const el = h('button', {
        type: 'button',
        class: `vw-marker ${firstComment ? 'is-comment' : 'is-reaction'}`,
        'aria-label': label,
        onmousedown: noFocus,
        onclick: (e) => { e.stopPropagation(); seek(m.time, { show: true }); },
        onmouseenter: () => showMarkerTip(m, el),
        onmouseleave: () => hideMarkerTip(),
        onfocus: () => showMarkerTip(m, el),
        onblur: () => hideMarkerTip(),
      }, firstComment ? initialOf(firstComment.name) : m.emoji);
      el.style.left = `${clamp(m.time / d, 0, 1) * 100}%`;
      if (firstComment) el.style.setProperty('--c', avatarColor(firstComment.name));
      if (m.items.length > 1) el.dataset.count = String(m.items.length);
      markerLayer.append(el);
    }
  }

  function markerLabel(m) {
    const parts = [];
    if (m.comments) parts.push(`${m.comments} comment${m.comments === 1 ? '' : 's'}`);
    if (m.reactions) parts.push(`${m.reactions} reaction${m.reactions === 1 ? '' : 's'}`);
    return `${parts.join(', ')} at ${formatTime(m.time)}`;
  }

  function showMarkerTip(m, el) {
    const comments = m.items.filter((it) => it.kind !== 'reaction');
    const reactions = m.items.filter((it) => it.kind === 'reaction');
    const rows = comments.slice(0, 3).map((c) => h('div', { class: 'vw-mtip-row' },
      h('span', { class: 'vw-mtip-name' }, cleanName(c.name)),
      h('span', { class: 'vw-mtip-text' }, String(c.text || ''))));
    if (comments.length > 3) rows.push(h('div', { class: 'vw-mtip-more' }, `+${comments.length - 3} more`));
    if (reactions.length) {
      const counts = new Map();
      for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
      rows.push(h('div', { class: 'vw-mtip-reacts' }, [...counts].map(([emoji, n]) => h('span', {}, `${emoji}${n > 1 ? ` ${n}` : ''}`))));
    }
    markerTip.replaceChildren(...rows, h('div', { class: 'vw-mtip-time t-mono' }, formatTime(m.time)));
    markerTip.hidden = false;
    const pr = root.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const w = markerTip.offsetWidth;
    const x = clamp(er.left + er.width / 2 - pr.left - w / 2, 8, Math.max(8, pr.width - w - 8));
    markerTip.style.left = `${x}px`;
    markerTip.style.bottom = `${pr.bottom - er.top + 8}px`;
    markerTip.style.maxHeight = `${Math.max(48, er.top - pr.top - 16)}px`;   // stay inside short players
  }
  function hideMarkerTip() { markerTip.hidden = true; }

  /* ---------------- scrubbing ---------------- */

  const fracAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
  };

  function showTip(frac) {
    const d = duration();
    const t = frac * d;
    tipTime.textContent = formatTime(t);
    const idx = chapters.length ? lastStartedIndex(chapters, t) : -1;
    tipTitle.textContent = idx >= 0 ? chapters[idx].title : '';
    tipTitle.hidden = idx < 0;
    hoverFill.style.transform = `scaleX(${frac})`;
    scrub.classList.add('is-hover');
    const w = track.clientWidth;
    const tw = tip.offsetWidth;
    tip.style.transform = `translateX(${clamp(frac * w - tw / 2, -6, Math.max(-6, w - tw + 6))}px)`;
  }
  function hideTip() { scrub.classList.remove('is-hover'); }

  function scrubTo(frac) {
    const t = frac * duration();
    scrubbing.time = t;
    renderTime(t);
    if (!seekRaf) {
      seekRaf = requestAnimationFrame(() => {
        seekRaf = 0;
        if (!scrubbing) return;
        try {
          if (typeof video.fastSeek === 'function') video.fastSeek(scrubbing.time);
          else video.currentTime = scrubbing.time;
        } catch { /* not seekable yet */ }
        drawCC();
      });
    }
  }

  scrub.addEventListener('pointermove', (e) => {
    const f = fracAt(e.clientX);
    if (e.pointerType === 'mouse' || scrubbing) showTip(f);
    if (scrubbing) scrubTo(f);
  });
  scrub.addEventListener('pointerleave', () => { if (!scrubbing) hideTip(); });
  scrub.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(duration() > 0)) return;
    e.preventDefault();
    try { scrub.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    scrubbing = { time: video.currentTime, wasPlaying: !video.paused && !video.ended };
    root.classList.add('is-scrubbing');
    root.classList.remove('is-ended');
    if (scrubbing.wasPlaying) video.pause();
    showTip(fracAt(e.clientX));
    scrubTo(fracAt(e.clientX));
    updateChrome();
  });
  const endScrub = (e) => {
    if (!scrubbing) return;
    const s = scrubbing;
    scrubbing = null;
    root.classList.remove('is-scrubbing');
    if (e.pointerType !== 'mouse') hideTip();
    seek(s.time);
    if (s.wasPlaying) play();
    poke();
  };
  scrub.addEventListener('pointerup', endScrub);
  scrub.addEventListener('pointercancel', endScrub);
  scrub.addEventListener('keydown', (e) => {
    if (e.key === 'Home') { e.preventDefault(); seek(0, { show: true }); }
    else if (e.key === 'End') { e.preventDefault(); seek(duration(), { show: true }); }
    else if (e.key === 'PageUp') { e.preventDefault(); seekBy(10); }
    else if (e.key === 'PageDown') { e.preventDefault(); seekBy(-10); }
  });

  /* ---------------- volume & speed ---------------- */

  function renderVolume() {
    const muted = video.muted || video.volume === 0;
    muteBtn.classList.toggle('is-muted', muted);
    setLabel(muteBtn, muted ? 'Unmute (m)' : 'Mute (m)');
    volSlider.value = String(muted ? 0 : video.volume);
    syncSliderFill(volSlider);
  }
  function toggleMute() {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.5;
    } else video.muted = true;
  }
  function changeVolume(delta) {
    video.muted = false;
    video.volume = clamp(Math.round((video.volume + delta) * 100) / 100, 0, 1);
    flashOsd(`Volume ${Math.round(video.volume * 100)}%`);
  }
  volSlider.addEventListener('input', () => {
    const v = Number(volSlider.value);
    video.volume = v;
    video.muted = v === 0;
    syncSliderFill(volSlider);
  });
  video.addEventListener('volumechange', () => {
    renderVolume();
    if (video.volume > 0) writePref(PREF.volume, video.volume);
    if (!(mode === 'embed' && autoplay && !started)) writePref(PREF.muted, video.muted ? '1' : '0');
  });

  function setRate(rate) {
    video.playbackRate = rate;
    video.defaultPlaybackRate = rate;
  }
  function renderRate() {
    const r = video.playbackRate;
    speedText.textContent = speedLabel(r);
    speedBtn.classList.toggle('is-changed', r !== 1);
    speedItems.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.rate) === r)));
  }
  video.addEventListener('ratechange', () => {
    renderRate();
    if (SPEEDS.includes(video.playbackRate)) writePref(PREF.rate, video.playbackRate);
  });

  function onDocPointer(e) {
    if (!speedMenu.contains(e.target) && !speedBtn.contains(e.target)) closeSpeedMenu(false);
  }
  function toggleSpeedMenu() {
    if (menuOpen) closeSpeedMenu(true);
    else {
      menuOpen = true;
      // Fit the menu into the room above the speed button (the player clips with overflow: hidden).
      const room = speedBtn.getBoundingClientRect().top - root.getBoundingClientRect().top - 16;   // 8px gap + 8px margin
      speedMenu.style.maxHeight = `${Math.max(96, Math.floor(room))}px`;
      speedMenu.hidden = false;
      speedBtn.setAttribute('aria-expanded', 'true');
      const target = speedItems.find((b) => b.getAttribute('aria-checked') === 'true') || speedItems[0];
      target.focus({ preventScroll: true });
      // preventScroll keeps the page still, so bring the checked item into view inside the menu by hand.
      speedMenu.scrollTop = Math.max(0, target.offsetTop - (speedMenu.clientHeight - target.offsetHeight) / 2);
      document.addEventListener('pointerdown', onDocPointer, true);
      updateChrome();
    }
  }
  function closeSpeedMenu(restoreFocus) {
    if (!menuOpen) return;
    menuOpen = false;
    speedMenu.hidden = true;
    speedBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocPointer, true);
    if (restoreFocus) speedBtn.focus({ preventScroll: true });
    else if (speedMenu.contains(document.activeElement)) document.activeElement.blur();
    updateChrome();
  }
  speedMenu.addEventListener('keydown', (e) => {
    const i = speedItems.indexOf(document.activeElement);
    const move = (n) => { e.preventDefault(); e.stopPropagation(); speedItems[(n + speedItems.length) % speedItems.length].focus(); };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(-1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSpeedMenu(true); }
    else if (e.key === 'Tab') closeSpeedMenu(false);
  });

  /* ---------------- captions overlay ---------------- */

  function layoutOverlay() {
    if (!ccAvailable) return;
    const cw = video.clientWidth, ch = video.clientHeight;
    const r = containRect(cw, ch, video.videoWidth || vw0, video.videoHeight || vh0);
    ccRect = r;
    Object.assign(ccCanvas.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(r.w * dpr)), H = Math.max(1, Math.round(r.h * dpr));
    if (ccCanvas.width !== W || ccCanvas.height !== H) {
      ccCanvas.width = W;
      ccCanvas.height = H;
    }
    layoutCaptionLift();
    drawCC();
  }

  /** Lifts bottom captions above the control bar while it is showing. */
  function layoutCaptionLift() {
    if (!ccAvailable || !ccRect.h) return;
    const below = video.clientHeight - (ccRect.y + ccRect.h);
    const lift = Math.max(0, controls.offsetHeight + 6 - below - ccRect.h * 0.09);
    ccCanvas.style.setProperty('--cc-lift', `${Math.round(lift)}px`);
  }

  function drawCC() {
    if (!ccAvailable) return;
    if (!ccCtx) ccCtx = ccCanvas.getContext('2d');
    if (!ccCtx) return;
    const W = ccCanvas.width, H = ccCanvas.height;
    ccCtx.clearRect(0, 0, W, H);
    if (!ccOn || !started) return;
    try {
      drawCaptions(ccCtx, {
        chunks,
        time: scrubbing ? scrubbing.time : video.currentTime,
        captions: current.captions,
        layout: { width: W, height: H, s: Math.min(W, H) / 1080, camera: scaleCamera(current.layout, W, H) },
      });
    } catch (err) {
      console.warn('[viewer] captions failed', err);
    }
  }

  function renderCC() {
    ccBtn.classList.toggle('is-on', ccOn);
    ccBtn.setAttribute('aria-pressed', String(ccOn));
    setLabel(ccBtn, ccOn ? 'Turn off captions (c)' : 'Turn on captions (c)');
    ccCanvas.hidden = !ccOn;
  }
  function toggleCaptions() {
    if (!ccAvailable) return;
    ccOn = !ccOn;
    renderCC();
    drawCC();
    flashOsd(ccOn ? 'Captions on' : 'Captions off');
  }

  /* ---------------- PiP & fullscreen ---------------- */

  async function togglePiP() {
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      toast('Picture in picture isn’t available right now.', { type: 'error' });
    }
  }

  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  function toggleFullscreen() {
    if (fsElement() === root) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
    } else if (root.requestFullscreen) {
      root.requestFullscreen().catch(() => {});
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();   // iPhone: native player
    }
  }
  function onFullscreenChange() {
    const on = fsElement() === root;
    root.classList.toggle('is-fullscreen', on);
    setLabel(fsBtn, on ? 'Exit full screen (f)' : 'Full screen (f)');
    requestAnimationFrame(layoutOverlay);
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  /* ---------------- OSD & floating emoji ---------------- */

  function flashOsd(text) {
    osd.textContent = text;
    osd.classList.remove('is-on');
    void osd.offsetWidth; // restart the animation
    osd.classList.add('is-on');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.remove('is-on'), 900);
  }

  function floatEmoji(emoji) {
    const el = h('span', { class: 'vw-float' }, emoji);
    el.style.left = `${12 + Math.random() * 76}%`;
    el.style.setProperty('--drift', `${Math.round((Math.random() * 2 - 1) * 36)}px`);
    el.style.setProperty('--tilt', `${Math.round((Math.random() * 2 - 1) * 14)}deg`);
    el.style.setProperty('--rise', `${Math.round(Math.max(120, root.clientHeight * 0.55))}px`);
    floatLayer.append(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 3000);
  }

  /* ---------------- errors ---------------- */

  function onMediaError() {
    const err = video.error;
    if (!err || !video.currentSrc && !video.getAttribute('src')) return;
    const [title, text] = err.code === 2
      ? ['Playback was interrupted', 'Check your connection and try again.']
      : err.code === 3
        ? ['This video couldn’t be decoded', 'Try again, or open it in another browser.']
        : ['This video can’t be played right now', 'It may still be uploading, or this browser can’t play its format.'];
    errTitle.textContent = title;
    errText.textContent = text;
    errBox.hidden = false;
    root.classList.add('is-error');
    root.classList.remove('is-waiting');
  }
  function clearError() {
    if (errBox.hidden) return;
    errBox.hidden = true;
    root.classList.remove('is-error');
  }
  async function retry() {
    clearError();
    root.classList.add('is-waiting');
    let next = current;
    if (typeof onRetry === 'function') {
      try { next = (await onRetry()) || current; } catch { next = current; }
    }
    if (destroyed) return;
    root.classList.remove('is-waiting');
    reload(next);
  }

  /** Points the player at a (possibly new) version of the share, keeping the position. */
  function reload(next) {
    const t = video.currentTime;
    const wasPlaying = !video.paused && !video.ended;
    applySource(next);
    const url = next.video?.url || '';
    const sameUrl = video.getAttribute('src') === url;
    if (!sameUrl) video.src = url;
    video.load();
    video.addEventListener('loadedmetadata', () => {
      if (t > 0) { try { video.currentTime = t; } catch { /* ignore */ } }
      if (wasPlaying) play();
    }, { once: true });
  }

  /* ---------------- video events ---------------- */

  function frame() {
    rafId = 0;
    if (destroyed) return;
    renderTime();
    drawCC();
    events.emit('time', video.currentTime);
    if (!video.paused) rafId = requestAnimationFrame(frame);
  }
  const startLoop = () => { if (!rafId) rafId = requestAnimationFrame(frame); };

  video.addEventListener('play', () => {
    if (!started) {
      started = true;
      root.classList.add('is-started');
    }
    root.classList.remove('is-ended');
    root.classList.add('is-playing');
    root.classList.remove('is-paused');
    playBtn.innerHTML = icon('pause', 20);
    setLabel(playBtn, 'Pause (k)');
    lastTick = video.currentTime;
    startLoop();
    poke();
    events.emit('play');
  });
  video.addEventListener('pause', () => {
    root.classList.remove('is-playing', 'is-waiting');
    root.classList.add('is-paused');
    playBtn.innerHTML = icon('play', 20);
    setLabel(playBtn, 'Play (k)');
    renderTime();
    updateChrome();
    if (!scrubbing) events.emit('pause');
  });
  video.addEventListener('ended', () => {
    root.classList.add('is-ended');
    bigPlay.innerHTML = icon('restart', 28);
    bigPlay.setAttribute('aria-label', 'Replay');
    updateChrome();
    events.emit('ended');
  });
  video.addEventListener('playing', () => {
    root.classList.remove('is-waiting');
    bigPlay.innerHTML = icon('play', 30);
    bigPlay.setAttribute('aria-label', 'Play video');
  });
  video.addEventListener('waiting', () => { if (!video.paused) root.classList.add('is-waiting'); });
  for (const type of ['canplay', 'seeked', 'emptied']) video.addEventListener(type, () => root.classList.remove('is-waiting'));
  video.addEventListener('seeking', () => { lastTick = null; });
  video.addEventListener('seeked', () => {
    lastTick = video.currentTime;
    renderTime();
    drawCC();
    events.emit('time', video.currentTime);
  });
  video.addEventListener('timeupdate', () => {
    const t = video.currentTime;
    if (!video.paused && !video.seeking && lastTick !== null) {
      const dt = t - lastTick;
      if (dt > 0 && dt < 1.5) {
        watched += dt;
        events.emit('watched', watched);
      }
    }
    lastTick = t;
    if (video.paused) { renderTime(); drawCC(); }
    renderBuffered();
  });
  video.addEventListener('progress', renderBuffered);
  video.addEventListener('loadedmetadata', () => {
    renderDuration();
    renderChapters();
    renderMarkers();
    layoutOverlay();
    if (Number(startTime) > 0 && !started) {
      seek(Math.min(Number(startTime), Math.max(0, duration() - 0.5)));
      startTime = null;
    }
  });
  video.addEventListener('durationchange', () => { renderDuration(); renderChapters(); renderMarkers(); });
  video.addEventListener('resize', layoutOverlay);
  video.addEventListener('error', onMediaError);
  video.addEventListener('enterpictureinpicture', () => root.classList.add('is-pip'));
  video.addEventListener('leavepictureinpicture', () => root.classList.remove('is-pip'));

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layoutOverlay()) : null;
  ro?.observe(root);
  const onWinResize = () => layoutOverlay();
  if (!ro) window.addEventListener('resize', onWinResize);

  /* ---------------- keyboard ---------------- */

  function onKey(e) {
    if (destroyed || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e)) return;
    const t = e.target instanceof Element ? e.target : null;
    const inPlayer = Boolean(t && root.contains(t));
    const onControl = Boolean(t?.closest?.('button, a[href], input, select, summary, [role="tab"], [role="button"], [role="menuitem"], [role="menuitemradio"]'));
    const inWidget = Boolean(t?.closest?.('[role="tablist"], [role="menu"], .menu, input[type="range"]'));
    // ↑/↓ belong to the player when it has focus, in full screen / the embed, or when the page can't scroll;
    // otherwise they keep scrolling the watch page.
    const pageScrolls = document.documentElement.scrollHeight > window.innerHeight + 4;
    const pageLevel = inPlayer || mode === 'embed' || fsElement() === root
      || ((!t || t === document.body || t === document.documentElement) && !pageScrolls);
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    switch (key) {
      case ' ':
        if (onControl) return;      // let the focused button / tab activate
        toggle();
        flashOsd(video.paused ? 'Paused' : 'Play');
        break;
      case 'k':
        toggle();
        flashOsd(video.paused ? 'Paused' : 'Play');
        break;
      case 'j': seekBy(-10); break;
      case 'l': seekBy(10); break;
      case 'ArrowLeft':
        if (inWidget && t !== scrub) return;
        seekBy(-5);
        break;
      case 'ArrowRight':
        if (inWidget && t !== scrub) return;
        seekBy(5);
        break;
      case 'ArrowUp':
        if (!pageLevel || inWidget) return;
        changeVolume(0.05);
        break;
      case 'ArrowDown':
        if (!pageLevel || inWidget) return;
        changeVolume(-0.05);
        break;
      case 'm':
        toggleMute();
        flashOsd(video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
        break;
      case 'f':
        if (!fsEnabled) return;
        toggleFullscreen();
        break;
      case 'c':
        if (!ccAvailable) return;
        toggleCaptions();
        break;
      default:
        if (/^[0-9]$/.test(key)) {
          const d = duration();
          if (!(d > 0)) return;
          seek((d * Number(key)) / 10, { show: true });
        } else handled = false;
    }
    if (handled) e.preventDefault();
  }
  document.addEventListener('keydown', onKey);

  /* ---------------- initial render ---------------- */

  initialized = true;
  renderVolume();
  renderRate();
  renderCC();
  renderDuration();
  root.classList.add('is-paused');
  if (mode === 'embed' && autoplay) play();

  return {
    el: root,
    video,
    get time() { return video.currentTime; },
    get duration() { return duration(); },
    get paused() { return video.paused; },
    get started() { return started; },
    get chapters() { return chapters; },
    on: (type, fn) => events.on(type, fn),
    play, pause, toggle, seek,
    focus: () => root.focus({ preventScroll: true }),
    setMarkers(items) { markerItems = Array.isArray(items) ? items : []; renderMarkers(); },
    floatEmoji,
    reload,
    layout: layoutOverlay,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(seekRaf);
      clearTimeout(hideTimer);
      clearTimeout(osdTimer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      document.removeEventListener('pointerdown', onDocPointer, true);
      window.removeEventListener('resize', onWinResize);
      ro?.disconnect();
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      root.remove();
    },
  };
}
