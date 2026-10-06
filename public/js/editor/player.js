// Editor playback engine. Plays the main recording (which carries all audio)
// and keeps the optional, muted camera recording locked to it, clamped to the
// project's trim range.
//
// Events: 'time' (t) · 'frame' (t) · 'play' · 'pause' · 'ended' · 'error' (err)

import { Emitter, clamp } from '../lib/util.js';
import { loadVideo } from '../lib/media.js';

const DRIFT_TOLERANCE = 0.12;  // seconds of camera drift tolerated before a hard resync
const SEEK_TIMEOUT_MS = 1500;  // a stuck decoder must never freeze scrubbing
const END_EPSILON = 0.012;     // "within about a frame of trim.end" counts as the end
const RESTART_EPSILON = 0.05;  // play() this close to the end restarts at trim.start
const VFC_STALE_MS = 150;      // rAF takes over 'frame' events if rVFC goes quiet

const HAS_VFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

export class Player extends Emitter {
  /**
   * Loads the recordings and resolves with a ready (paused) player.
   * @param {{ project: object, mainBlob: Blob|string, cameraBlob?: Blob|string|null, store?: object|null }} opts
   * @returns {Promise<Player>}
   */
  static async create({ project, mainBlob, cameraBlob = null, store = null } = {}) {
    if (!mainBlob) throw new Error('This recording has no video.');
    const knownDuration = Number(project?.duration) > 0 ? Number(project.duration) : undefined;
    const main = toUrl(mainBlob);
    const cam = cameraBlob ? toUrl(cameraBlob) : null;

    const [mainRes, camRes] = await Promise.allSettled([
      loadVideo(main.url, { muted: false, knownDuration }),
      cam ? loadVideo(cam.url, { muted: true, knownDuration }) : Promise.resolve(null),
    ]);

    if (mainRes.status === 'rejected') {
      if (camRes.status === 'fulfilled') releaseVideo(camRes.value);
      revoke(main);
      revoke(cam);
      const reason = mainRes.reason;
      // MediaError messages are decoder internals ("DEMUXER_ERROR_…"); keep them as the cause only.
      const timedOut = /timed out/i.test(reason?.message || '');
      const err = new Error(timedOut ? 'The recording took too long to load.' : 'Your browser couldn’t decode this recording.');
      err.cause = reason;
      throw err;
    }

    let camera = null;
    if (camRes.status === 'fulfilled') camera = camRes.value;
    if (cam && !camera) {
      // The editor still works without the camera track; the bubble just stays empty.
      console.warn('[player] camera video could not be loaded; continuing without it', camRes.reason);
      revoke(cam);
    }

    const player = new Player({
      project,
      store,
      main: mainRes.value,
      camera,
      mainUrl: main.url,
      cameraUrl: camera ? cam.url : null,
      ownedUrls: [main.owned ? main.url : null, camera && cam.owned ? cam.url : null].filter(Boolean),
    });
    // Park on the first trimmed frame so the first draw already shows real pixels.
    await player.seek(player._bounds().start);
    return player;
  }

  constructor({ project, store = null, main, camera = null, mainUrl, cameraUrl = null, ownedUrls = [] }) {
    super();
    this.project = project;
    this.store = store;
    this.main = main;
    this.camera = camera;
    this.mainUrl = mainUrl || main.currentSrc || main.src;
    this.cameraUrl = cameraUrl;
    this.time = Number.isFinite(main.currentTime) ? main.currentTime : 0;
    this.playing = false;
    this.destroyed = false;

    this._ownedUrls = ownedUrls;
    this._raf = 0;
    this._vfc = null;
    this._settleVfc = null;
    this._lastVfcAt = 0;
    this._mirrorRaf = 0;
    this._seekTarget = null;
    this._seekInFlight = false;
    this._seekWaiters = [];
    this._cameraPlayPending = false;
    this._trimCheckQueued = false;

    main.addEventListener('play', this._onMainPlay);
    main.addEventListener('pause', this._onMainPause);
    main.addEventListener('ended', this._onMainEnded);
    main.addEventListener('timeupdate', this._onMainTimeUpdate);
    for (const v of [main, camera]) {
      v?.addEventListener('loadeddata', this._onLateFrame);
      v?.addEventListener('seeked', this._onLateFrame);
    }
    this._unsubStore = typeof store?.onChange === 'function' ? store.onChange(this._onProjectChange) : null;
  }

  /** Source duration in seconds (project.duration, falling back to the media). */
  get duration() {
    const d = Number(this._project()?.duration);
    if (Number.isFinite(d) && d > 0) return d;
    const md = this.main?.duration;
    return Number.isFinite(md) && md > 0 ? md : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Transport                                                           */
  /* ------------------------------------------------------------------ */

  /** Starts playback (from trim.start when at/after the end). Never rejects. */
  play() {
    if (this.destroyed || this.playing) return Promise.resolve();
    const { start, end } = this._bounds();
    if (end - start <= END_EPSILON) return Promise.resolve();

    let t = this._seekTarget ?? this.time;
    if (t < start || t >= end - RESTART_EPSILON) t = start;
    this._seekTarget = null;
    if (Math.abs(this.main.currentTime - t) > 0.001) this.main.currentTime = t;
    this._placeCamera(t);
    this.time = t;

    this.playing = true;
    this._startLoops();
    this.emit('play');
    this.emit('time', t);
    this._mirror(true);

    let attempt;
    try {
      attempt = this.main.play();
    } catch (err) {
      attempt = Promise.reject(err);
    }
    return Promise.resolve(attempt).then(
      () => { if (this.playing && !this.destroyed) this._syncCamera(); },
      (err) => {
        // AbortError: pause()/seek interrupted the request — expected, not a failure.
        if (this.destroyed || !this.playing || err?.name === 'AbortError') return;
        this._halt();
        this.emit('pause');
        this._mirror(true);
        this.emit('error', err);
      },
    );
  }

  pause() {
    if (this.destroyed || !this.playing) return;
    const { start, end } = this._bounds();
    this._halt();
    this.time = clamp(this.main.currentTime, start, end);
    this.emit('pause');
    this._mirror(true);
    // Settle the camera exactly on the paused main frame (it may be up to DRIFT_TOLERANCE off).
    this.seek(this.time);
  }

  toggle() {
    if (this.playing) {
      this.pause();
      return Promise.resolve();
    }
    return this.play();
  }

  /**
   * Seeks both videos (clamped to the trim range). 'time' fires immediately for
   * responsive UI; 'frame' fires once the decoded frame is ready. Rapid calls
   * (scrubbing) are coalesced: at most one seek is in flight, always to the latest target.
   * @returns {Promise<void>} resolves when the latest target is showing
   */
  seek(t) {
    if (this.destroyed) return Promise.resolve();
    const { start, end } = this._bounds();
    const target = clamp(Number.isFinite(Number(t)) ? Number(t) : start, start, end);
    this.time = target;
    this._seekTarget = target;
    this.emit('time', target);
    this._mirror();
    const done = new Promise((resolve) => this._seekWaiters.push(resolve));
    if (!this._seekInFlight) this._drainSeeks();
    return done;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playing = false;
    this._stopLoops();
    this._cancelSettle();
    if (this._mirrorRaf) cancelAnimationFrame(this._mirrorRaf);
    this._mirrorRaf = 0;
    this._unsubStore?.();
    this._unsubStore = null;
    this.main.removeEventListener('play', this._onMainPlay);
    this.main.removeEventListener('pause', this._onMainPause);
    this.main.removeEventListener('ended', this._onMainEnded);
    this.main.removeEventListener('timeupdate', this._onMainTimeUpdate);
    for (const v of [this.main, this.camera]) {
      v?.removeEventListener('loadeddata', this._onLateFrame);
      v?.removeEventListener('seeked', this._onLateFrame);
    }
    releaseVideo(this.main);
    releaseVideo(this.camera);
    for (const url of this._ownedUrls) URL.revokeObjectURL(url);
    this._ownedUrls = [];
    this._seekWaiters.splice(0).forEach((resolve) => resolve());
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  _project() {
    return this.store?.project || this.project;
  }

  /** Effective trim range, sanitized against the duration. */
  _bounds() {
    const dur = this.duration;
    const trim = this._project()?.edit?.trim || {};
    let start = Number.isFinite(trim.start) ? trim.start : 0;
    let end = Number.isFinite(trim.end) && trim.end > 0 ? trim.end : dur;
    if (dur > 0) {
      start = clamp(start, 0, dur);
      end = clamp(end, start, dur);
    } else {
      start = Math.max(0, start);
      end = Math.max(start, end);
    }
    return { start, end };
  }

  async _drainSeeks() {
    this._seekInFlight = true;
    try {
      while (this._seekTarget !== null && !this.destroyed) {
        const t = this._seekTarget;
        this._seekTarget = null;
        await Promise.all([seekElement(this.main, t), this._seekCamera(t)]);
        if (this.destroyed) return;
        // A newer target arrived meanwhile: show this intermediate frame while scrubbing.
        if (this._seekTarget !== null) this.emit('frame', this.time);
      }
    } finally {
      this._seekInFlight = false;
    }
    if (this.destroyed) return;
    this.emit('time', this.time);
    this.emit('frame', this.time);
    this._mirror();
    this._requestSettleFrame();
    this._seekWaiters.splice(0).forEach((resolve) => resolve());
  }

  _seekCamera(t) {
    const cam = this.camera;
    if (!cam) return Promise.resolve();
    return seekElement(cam, cameraTime(cam, t));
  }

  /** Sets the camera position without waiting (used when starting playback). */
  _placeCamera(t) {
    const cam = this.camera;
    if (!cam || cam.readyState < 1) return;
    const ct = cameraTime(cam, t);
    if (Math.abs(cam.currentTime - ct) > 0.001) cam.currentTime = ct;
  }

  /** Keeps the camera locked to main while playing. Cheap; runs every frame. */
  _syncCamera() {
    const cam = this.camera;
    if (!cam || cam.readyState < 1 || this.destroyed) return;
    const main = this.main;
    const t = this.time;
    if (cam.playbackRate !== main.playbackRate) cam.playbackRate = main.playbackRate;

    const camDur = Number.isFinite(cam.duration) ? cam.duration : Infinity;
    if (t >= camDur - 0.05) {
      // Camera recording ended a touch earlier than main: hold its last frame.
      if (!cam.paused) cam.pause();
      return;
    }

    if (!cam.seeking && Math.abs(cam.currentTime - t) > DRIFT_TOLERANCE) cam.currentTime = t;

    const mainAdvancing = this.playing && !main.paused && !main.seeking && main.readyState >= 3;
    if (mainAdvancing && cam.paused && !this._cameraPlayPending) {
      this._cameraPlayPending = true;
      let p;
      try { p = cam.play(); } catch (err) { p = Promise.reject(err); }
      Promise.resolve(p).catch(() => {}).then(() => { this._cameraPlayPending = false; });
    } else if (!mainAdvancing && !cam.paused) {
      // Main is buffering or seeking: don't let the camera run ahead.
      cam.pause();
    }
  }

  _tick = () => {
    this._raf = 0;
    if (!this.playing || this.destroyed) return;
    // Re-arm first so listeners that schedule their own rAF (the preview) run after us next frame.
    this._raf = requestAnimationFrame(this._tick);
    if (this._seekTarget === null) this.time = this.main.currentTime;
    const { end } = this._bounds();
    if (this.time >= end - END_EPSILON || this.main.ended) {
      this._reachEnd();
      return;
    }
    this._syncCamera();
    this.emit('time', this.time);
    if (!HAS_VFC || performance.now() - this._lastVfcAt > VFC_STALE_MS) this.emit('frame', this.time);
    this._mirror(true);
  };

  _onVideoFrame = () => {
    this._vfc = null;
    if (!this.playing || this.destroyed) return;
    this._lastVfcAt = performance.now();
    this._vfc = this.main.requestVideoFrameCallback(this._onVideoFrame);
    // Runs just before this frame's rAF callbacks: report the time of the frame being presented.
    if (this._seekTarget === null) this.time = this.main.currentTime;
    this.emit('frame', this.time);
  };

  _startLoops() {
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
    if (HAS_VFC && this._vfc === null) {
      this._lastVfcAt = 0;
      try {
        this._vfc = this.main.requestVideoFrameCallback(this._onVideoFrame);
      } catch {
        this._vfc = null;
      }
    }
  }

  _stopLoops() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this._vfc !== null) {
      try { this.main.cancelVideoFrameCallback(this._vfc); } catch { /* already fired */ }
      this._vfc = null;
    }
  }

  /** After a paused seek, redraw once more when the compositor actually has the new frame. */
  _requestSettleFrame() {
    if (!HAS_VFC || this.playing || this.destroyed) return;
    this._cancelSettle();
    try {
      this._settleVfc = this.main.requestVideoFrameCallback(() => {
        this._settleVfc = null;
        if (!this.destroyed && !this.playing) this.emit('frame', this.time);
      });
    } catch {
      this._settleVfc = null;
    }
  }

  _cancelSettle() {
    if (this._settleVfc === null) return;
    try { this.main.cancelVideoFrameCallback(this._settleVfc); } catch { /* already fired */ }
    this._settleVfc = null;
  }

  /** Stops the media and loops without emitting anything. */
  _halt() {
    this.playing = false;
    this._stopLoops();
    this.main.pause();
    this.camera?.pause();
  }

  _reachEnd() {
    if (this.destroyed) return;
    const { end } = this._bounds();
    this._halt();
    this.time = end;
    this.emit('pause');
    this.emit('ended');
    this._mirror(true);
    this.seek(end);
  }

  /** Mirrors { time, playing } into store.ui — at most once per animation frame unless immediate. */
  _mirror(immediate = false) {
    if (!this.store?.setUI || this.destroyed) return;
    if (immediate) {
      if (this._mirrorRaf) cancelAnimationFrame(this._mirrorRaf);
      this._mirrorRaf = 0;
      this.store.setUI({ time: this.time, playing: this.playing });
      return;
    }
    if (this._mirrorRaf) return;
    this._mirrorRaf = requestAnimationFrame(() => {
      this._mirrorRaf = 0;
      if (!this.destroyed) this.store.setUI({ time: this.time, playing: this.playing });
    });
  }

  /* Media element events — keep state honest when something outside us
     (hardware media keys, the browser's media controls, natural end) acts. */

  _onMainPlay = () => {
    if (this.destroyed || this.playing || this.main.paused) return;
    const { start, end } = this._bounds();
    const t = this.main.currentTime;
    if (t < start - END_EPSILON || t >= end - END_EPSILON) {
      this.main.pause();
      return;
    }
    this.time = t;
    this.playing = true;
    this._startLoops();
    this.emit('play');
    this._mirror(true);
  };

  _onMainPause = () => {
    if (this.destroyed || !this.playing || !this.main.paused) return;
    if (this.main.ended) this._reachEnd();
    else this.pause();
  };

  _onMainEnded = () => {
    if (!this.destroyed && this.playing) this._reachEnd();
  };

  // rAF stops in background tabs; timeupdate (~4Hz) still enforces trim.end there.
  _onMainTimeUpdate = () => {
    if (this.destroyed || !this.playing) return;
    const { end } = this._bounds();
    if (this.main.currentTime >= end - END_EPSILON) this._reachEnd();
  };

  // Data that arrives after a seek timed out (slow decoder) or after the first load: redraw once it lands.
  _onLateFrame = () => {
    if (!this.destroyed && !this.playing && !this._seekInFlight) this.emit('frame', this.time);
  };

  _onProjectChange = () => {
    if (this._trimCheckQueued || this.destroyed) return;
    this._trimCheckQueued = true;
    // Deferred so we never seek re-entrantly from inside another module's store.update().
    queueMicrotask(() => {
      this._trimCheckQueued = false;
      if (this.destroyed) return;
      const { start, end } = this._bounds();
      if (this.time < start - 1e-3 || this.time > end + 1e-3) this.seek(this.time);
    });
  };
}

/* -------------------------------------------------------------------- */
/* Helpers                                                               */
/* -------------------------------------------------------------------- */

function toUrl(src) {
  if (typeof src === 'string') return { url: src, owned: false };
  return { url: URL.createObjectURL(src), owned: true };
}

function revoke(entry) {
  if (entry?.owned) URL.revokeObjectURL(entry.url);
}

/** Camera recordings can end slightly earlier than main; never seek past them. */
function cameraTime(cam, t) {
  const d = cam.duration;
  return Number.isFinite(d) && d > 0 ? Math.min(t, Math.max(0, d - 0.001)) : t;
}

/** Seeks one element and resolves on 'seeked' (or after a timeout). */
function seekElement(video, t) {
  return new Promise((resolve) => {
    if (!video) return resolve();
    if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.0005) return resolve();
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.addEventListener('error', done);
    timer = setTimeout(done, SEEK_TIMEOUT_MS);
    try {
      video.currentTime = t;
    } catch {
      done();
    }
  });
}

function releaseVideo(video) {
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load(); // drops the decoder and buffered data immediately
  } catch { /* element already torn down */ }
}
