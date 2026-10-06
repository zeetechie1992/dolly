// Real-time exporter: replays the edit through the renderer into a private canvas and
// records that canvas (plus the recording's audio) with MediaRecorder.
//
// Pipeline: private <video>s (main unmuted → WebAudio → MediaStreamDestination only, so the
// user hears nothing) → drawFrame() into an off-screen canvas → canvas.captureStream(30)
// + audio track → MediaRecorder → Blob.

import { clamp, deepClone, sleep } from '../lib/util.js';
import { loadVideo, seekVideo } from '../lib/media.js';
import { getOutputSize, drawFrame } from './renderer.js';
import { buildCaptionChunks } from './captions.js';

const MP4_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
const WEBM_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

/** Export presets, keyed by the output's SHORT side in px. */
export const EXPORT_RESOLUTIONS = Object.freeze([
  Object.freeze({ value: 720, label: '720p', bitrate: 6_000_000 }),
  Object.freeze({ value: 1080, label: '1080p', bitrate: 12_000_000 }),
  Object.freeze({ value: 2160, label: '4K', bitrate: 35_000_000 }),
]);

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const TICK_MS = 16;                // clock resolution; frames are drawn every other tick (~30 fps)
const MIN_FRAME_GAP_MS = 22;       // a fresh video frame may be drawn this soon after the last draw (caps 60 fps sources at ~30)
const VFC_ACTIVE_MS = 100;         // rVFC counts as "delivering" if it fired this recently
const VFC_GAP_FILL_MS = 45;        // while rVFC delivers, the clock only fills gaps longer than this
const AUDIO_BPS = 160_000;
const STALL_MS = 8000;
const END_EPSILON = 0.5 / FPS;
const RECORDER_TIMESLICE_MS = 1000;

const UNSUPPORTED_MESSAGE = 'Exporting isn’t supported in this browser. Try a recent version of Chrome, Edge or Arc.';

// Tiny worker clock: dedicated-worker timers keep ticking at full rate in hidden tabs, where
// main-thread timers are throttled to ~1 Hz.
const TICKER_SRC = 'let id=0;onmessage=(e)=>{clearInterval(id);id=e.data>0?setInterval(()=>postMessage(0),e.data):0;};';

const abortError = () => new DOMException('Export cancelled', 'AbortError');
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function canCaptureCanvas() {
  return typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

function pickType(candidates) {
  try {
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  } catch {
    return '';
  }
}

/**
 * Formats this browser can export, best first (MP4 before WebM).
 * Empty when MediaRecorder or canvas capture is unavailable.
 * @returns {Array<{ id: 'mp4'|'webm', label: string, mimeType: string }>}
 */
export function supportedFormats() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function' || !canCaptureCanvas()) return [];
  const out = [];
  const mp4 = pickType(MP4_TYPES);
  if (mp4) out.push({ id: 'mp4', label: 'MP4', mimeType: mp4 });
  const webm = pickType(WEBM_TYPES);
  if (webm) out.push({ id: 'webm', label: 'WebM', mimeType: webm });
  return out;
}

/**
 * Exact pixel size of an export: the project's output aspect scaled so the SHORT side
 * equals `resolution` (720 / 1080 / 2160), rounded to even integers.
 * @returns {{ width: number, height: number }}
 */
export function getExportSize(project, resolution = 1080) {
  const base = getOutputSize(project);
  const short = Math.min(base.width, base.height) || 1080;
  const target = Number(resolution) > 0 ? clamp(Number(resolution), 144, 4320) : 1080;
  const k = target / short;
  return { width: even(base.width * k), height: even(base.height * k) };
}

function videoBitrate(resolution, width, height) {
  const preset = EXPORT_RESOLUTIONS.find((r) => r.value === resolution);
  const base = preset ? preset.bitrate : 12_000_000 * Math.pow(resolution / 1080, 1.6);
  // Presets are tuned for 16:9; square / 4:5 frames carry fewer pixels.
  const reference = resolution * resolution * (16 / 9);
  return Math.round(base * clamp((width * height) / reference, 0.6, 1.25));
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function friendlyError(message, cause) {
  const err = new Error(message);
  if (cause !== undefined) err.cause = cause;
  return err;
}

function waitForData(video, timeoutMs) {
  return new Promise((resolve) => {
    if (video.readyState >= 2) return resolve();
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', done);
      video.removeEventListener('canplay', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    video.addEventListener('loadeddata', done);
    video.addEventListener('canplay', done);
  });
}

function releaseVideo(video) {
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* already gone */ }
  video.remove();
}

function createTicker(fn, intervalMs) {
  let worker = null;
  let url = '';
  let timer = 0;
  let running = false;
  const destroyWorker = () => {
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
    worker = null;
    if (url) URL.revokeObjectURL(url);
    url = '';
  };
  const loop = () => {
    if (!running) return;
    timer = setTimeout(loop, intervalMs);
    fn();
  };
  try {
    if (typeof Worker === 'function') {
      url = URL.createObjectURL(new Blob([TICKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = () => { if (running) fn(); };
      worker.onerror = (e) => {
        e.preventDefault?.();
        destroyWorker();
        if (running) { clearTimeout(timer); timer = setTimeout(loop, intervalMs); }
      };
    }
  } catch {
    destroyWorker();
  }
  return {
    get running() { return running; },
    start() {
      if (running) return;
      running = true;
      if (worker) worker.postMessage(intervalMs);
      else timer = setTimeout(loop, intervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      worker?.postMessage(0);
      clearTimeout(timer);
    },
    dispose() {
      this.stop();
      destroyWorker();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Export job                                                          */
/* ------------------------------------------------------------------ */

class ExportJob {
  constructor({ project, mainBlob, cameraBlob, format, resolution, showCaptions, signal, onProgress, onFrame }) {
    this.project = project;
    this.mainBlob = mainBlob;
    this.cameraBlob = cameraBlob;
    this.format = format;
    this.resolution = resolution;
    this.signal = signal || null;
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
    this.onFrame = typeof onFrame === 'function' ? onFrame : null;
    const size = getExportSize(project, resolution);
    this.width = size.width;
    this.height = size.height;
    this.captionChunks = showCaptions && project.edit?.captions?.enabled && project.transcript?.length
      ? buildCaptionChunks(project.transcript)
      : null;

    this.urls = [];
    this.videos = [];
    this.chunks = [];
    this.disposed = false;
    this.started = false;      // playback running, frame loop active
    this.finished = false;     // no more frames will be drawn
    this.settled = false;      // run promise resolved/rejected
    this.vfcId = 0;
    this.lastVfcAt = -Infinity;
    this.lastDraw = 0;
    this.nextDue = 0;          // phase-locked time of the next clock-driven frame
    this.lastReport = 0;
    this.lastCamSeek = 0;
    this.callbackErrorLogged = false;
    this.wakeLock = null;
    this.hasVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    this.ticker = createTicker(() => this.onTick(), TICK_MS);

    // Created synchronously so it still benefits from the click that started the export.
    this.audioCtx = null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try { this.audioCtx = new AC(); } catch (err) { console.warn('[exporter] AudioContext unavailable; exporting without sound', err); }
    }

    this.onAbort = () => this.fail(abortError());
    this.onVisibility = () => this.handleVisibility();
    this.onEnded = () => this.finish();
    this.onPause = () => this.handleUnexpectedPause();
    this.onMediaError = () => this.fail(friendlyError('The recording couldn’t be decoded while exporting.', this.main?.error));
    this.onVFC = () => this.handleVFC();
  }

  async run() {
    try {
      await this.prepare();
      return await this.record();
    } finally {
      this.dispose();
    }
  }

  /* ---------------- preparation ---------------- */

  toUrl(src) {
    if (typeof src === 'string') return src;
    const url = URL.createObjectURL(src);
    this.urls.push(url);
    return url;
  }

  trackVideo(promise) {
    return promise.then((video) => {
      if (this.disposed) releaseVideo(video);
      else this.videos.push(video);
      return video;
    });
  }

  async prepare() {
    const { project, signal } = this;
    const e = project.edit;

    this.host = document.createElement('div');
    this.host.setAttribute('aria-hidden', 'true');
    this.host.setAttribute('inert', '');
    // Attached (not display:none) so Chrome keeps decoding and painting the private media.
    Object.assign(this.host.style, {
      position: 'fixed', left: '0', top: '0', width: '1px', height: '1px',
      overflow: 'hidden', opacity: '0', pointerEvents: 'none', zIndex: '-1',
    });
    document.body.append(this.host);

    const knownDuration = Number(project.duration) > 0 ? Number(project.duration) : undefined;
    const wantsCamera = Boolean(this.cameraBlob) && project.mode !== 'cam' && Boolean(project.source?.hasCamera) && e.camera?.visible !== false;
    const mainSrc = this.toUrl(this.mainBlob);
    const camSrc = wantsCamera ? this.toUrl(this.cameraBlob) : null;

    const [mainRes, camRes] = await abortable(Promise.allSettled([
      this.trackVideo(loadVideo(mainSrc, { muted: false, knownDuration })),
      camSrc ? this.trackVideo(loadVideo(camSrc, { muted: true, knownDuration })) : Promise.resolve(null),
    ]), signal);
    if (mainRes.status === 'rejected') throw friendlyError('The recording couldn’t be loaded for export.', mainRes.reason);
    if (camRes.status === 'rejected') console.warn('[exporter] camera video unavailable; exporting without it', camRes.reason);

    this.main = mainRes.value;
    this.camera = camRes.status === 'fulfilled' ? camRes.value : null;
    for (const v of [this.main, this.camera]) {
      if (!v) continue;
      v.loop = false;
      v.playbackRate = 1;
      v.defaultPlaybackRate = 1;
      v.disableRemotePlayback = true;
      v.setAttribute('playsinline', '');
      Object.assign(v.style, { width: '1px', height: '1px', position: 'absolute', left: '0', top: '0' });
      this.host.append(v);
    }

    const mediaDuration = Number.isFinite(this.main.duration) && this.main.duration > 0 ? this.main.duration : Infinity;
    const duration = Math.min(knownDuration ?? Infinity, mediaDuration);
    const limit = Number.isFinite(duration) ? duration : Math.max(Number(e.trim?.end) || 0, 0);
    this.start = clamp(Number(e.trim?.start) || 0, 0, limit);
    this.end = clamp(Number.isFinite(Number(e.trim?.end)) && Number(e.trim.end) > 0 ? Number(e.trim.end) : limit, this.start, limit);
    this.duration = this.end - this.start;
    if (!(this.duration >= 0.2)) throw friendlyError('The trimmed video is too short to export.');

    this.setupAudio();
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      await abortable(Promise.race([this.audioCtx.resume().catch(() => {}), sleep(1500)]), signal);
    }
    if (this.audioDest && this.audioCtx.state !== 'running') {
      // A track that never produces samples can stall the muxer, so drop audio instead.
      console.warn('[exporter] audio is blocked by the browser; exporting without sound');
      this.audioTrack = null;
    }

    const camDuration = this.camera && Number.isFinite(this.camera.duration) ? this.camera.duration : Infinity;
    await abortable(Promise.all([
      seekVideo(this.main, this.start),
      this.camera ? seekVideo(this.camera, Math.min(this.start, Math.max(0, camDuration - 0.05))) : null,
    ]), signal);
    await abortable(waitForData(this.main, 4000), signal);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    Object.assign(this.canvas.style, { width: '1px', height: '1px', position: 'absolute', left: '0', top: '0' });
    this.host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw friendlyError('Your browser couldn’t create a drawing surface for the export.');

    try {
      this.canvasStream = this.canvas.captureStream(FPS);
    } catch (err) {
      throw friendlyError(UNSUPPORTED_MESSAGE, err);
    }
    const tracks = [...this.canvasStream.getVideoTracks()];
    if (this.audioTrack) tracks.push(this.audioTrack);
    this.stream = new MediaStream(tracks);
    this.createRecorder();
  }

  setupAudio() {
    this.audioTrack = null;
    if (!this.audioCtx || typeof this.audioCtx.createMediaStreamDestination !== 'function') {
      // Without a WebAudio route the element would play out loud; keep the export silent instead.
      this.main.muted = true;
      return;
    }
    try {
      this.audioSource = this.audioCtx.createMediaElementSource(this.main);
      this.audioDest = this.audioCtx.createMediaStreamDestination();
      this.audioSource.connect(this.audioDest); // deliberately NOT to ctx.destination
      this.audioTrack = this.audioDest.stream.getAudioTracks()[0] || null;
    } catch (err) {
      console.warn('[exporter] audio routing unavailable; exporting without sound', err);
      try { this.audioSource?.disconnect(); } catch { /* not connected */ }
      this.audioSource = null;
      this.audioDest = null;
      this.main.muted = true;
    }
  }

  createRecorder() {
    const videoBitsPerSecond = videoBitrate(this.resolution, this.width, this.height);
    const options = { mimeType: this.format.mimeType, videoBitsPerSecond };
    if (this.audioTrack) options.audioBitsPerSecond = AUDIO_BPS;
    try {
      this.recorder = new MediaRecorder(this.stream, options);
    } catch (err) {
      try {
        // Let the browser pick its default container rather than failing outright.
        delete options.mimeType;
        this.recorder = new MediaRecorder(this.stream, options);
      } catch {
        throw friendlyError(`This browser can’t encode ${this.format.label} at this size. Try another format or a lower resolution.`, err);
      }
    }
  }

  /* ---------------- recording ---------------- */

  record() {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      const { signal, recorder, main } = this;
      if (signal?.aborted) return this.fail(abortError());
      signal?.addEventListener('abort', this.onAbort);
      document.addEventListener('visibilitychange', this.onVisibility);
      main.addEventListener('ended', this.onEnded);
      main.addEventListener('pause', this.onPause);
      main.addEventListener('error', this.onMediaError);
      recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) this.chunks.push(ev.data); };
      recorder.onerror = (ev) => {
        const hint = this.resolution > 1080 ? ' Try exporting at 1080p.' : '';
        this.fail(friendlyError(`The video encoder stopped unexpectedly.${hint}`, ev.error || ev));
      };

      try {
        recorder.start(RECORDER_TIMESLICE_MS);
      } catch (err) {
        return this.fail(friendlyError('The video encoder couldn’t start. Try another format or a lower resolution.', err));
      }
      this.recordStartedAt = performance.now();
      this.lastProgressT = this.start;
      this.lastProgressWall = this.recordStartedAt;
      try {
        this.drawAt(this.start); // first frame lands in the stream before playback begins
      } catch (err) {
        return this.fail(friendlyError('Something went wrong while rendering the video.', err));
      }
      this.watchdog = setInterval(() => this.checkHealth(), 1000);
      this.acquireWakeLock();

      this.playMain().then(() => {
        if (this.finished) return;
        this.started = true;
        this.playStartedAt = performance.now();
        this.lastProgressWall = this.playStartedAt;
        this.camera?.play().catch(() => {});
        this.startDrivers();
      }, (err) => this.fail(err));
    });
  }

  async playMain() {
    try {
      await this.main.play();
      return;
    } catch (err) {
      if (this.finished) return;
      if (err?.name === 'NotAllowedError') {
        await this.audioCtx?.resume?.().catch(() => {});
        try {
          await this.main.play();
          return;
        } catch { /* fall through */ }
        throw friendlyError('Your browser blocked the playback that exporting needs. Click Export to try again.', err);
      }
      if (err?.name === 'AbortError') {
        // play() interrupted by a pause/seek; one retry is enough.
        try {
          await this.main.play();
          return;
        } catch { /* fall through */ }
      }
      throw friendlyError('The recording couldn’t be played for export.', err);
    }
  }

  // Frame scheduling: a worker clock draws at a steady ~30 fps in every state (hidden tabs,
  // throttled or occluded windows, static variable-frame-rate screen recordings). While the
  // tab renders normally, requestVideoFrameCallback draws each fresh decoded frame right away
  // and the clock only fills gaps, so 30 fps sources map 1:1 without judder.
  startDrivers() {
    this.ticker.start();
    this.armVFC();
  }

  handleVisibility() {
    if (!this.started || this.finished) return;
    if (!document.hidden) {
      this.armVFC();
      this.acquireWakeLock();
    }
  }

  armVFC() {
    if (this.finished || !this.hasVFC || this.vfcId || document.hidden) return;
    this.vfcId = this.main.requestVideoFrameCallback(this.onVFC);
  }

  cancelVFC() {
    if (this.vfcId) {
      try { this.main.cancelVideoFrameCallback(this.vfcId); } catch { /* element released */ }
    }
    this.vfcId = 0;
  }

  stopDrivers() {
    this.cancelVFC();
    this.ticker.stop();
    clearInterval(this.watchdog);
    this.watchdog = 0;
  }

  handleVFC() {
    this.vfcId = 0;
    if (this.finished) return;
    const now = performance.now();
    this.lastVfcAt = now;
    if (now - this.lastDraw >= MIN_FRAME_GAP_MS) this.tick();
    this.armVFC();
  }

  onTick() {
    if (this.finished || !this.started) return;
    const now = performance.now();
    const vfcActive = !document.hidden && now - this.lastVfcAt < VFC_ACTIVE_MS;
    if (vfcActive ? now - this.lastDraw >= VFC_GAP_FILL_MS : now >= this.nextDue - TICK_MS / 2) this.tick();
  }

  tick() {
    if (this.finished || !this.started) return;
    try {
      const now = performance.now();
      const t = this.main.currentTime;
      if (t > this.lastProgressT + 0.001) {
        this.lastProgressT = t;
        this.lastProgressWall = now;
      }
      if (t >= this.end - END_EPSILON || this.main.ended) {
        this.finish();
        return;
      }
      this.syncCamera(t, now);
      this.drawAt(t);
      this.lastDraw = now;
      // Keep the clock's phase when on schedule (even 33 ms cadence); re-anchor after a hiccup.
      const onSchedule = now >= this.nextDue - TICK_MS && now - this.nextDue < FRAME_MS;
      this.nextDue = onSchedule ? this.nextDue + FRAME_MS : now + FRAME_MS;
      this.report(t, false);
    } catch (err) {
      this.fail(friendlyError('Something went wrong while rendering the video.', err));
    }
  }

  drawAt(t) {
    drawFrame(this.ctx, {
      project: this.project,
      time: t,
      main: this.main,
      camera: this.camera,
      width: this.width,
      height: this.height,
      captionChunks: this.captionChunks,
      showCaptions: Boolean(this.captionChunks),
    });
    if (this.onFrame) this.safeCall(this.onFrame, this.canvas);
  }

  syncCamera(t, now) {
    const cam = this.camera;
    if (!cam || cam.readyState < 1) return;
    const camDuration = Number.isFinite(cam.duration) ? cam.duration : Infinity;
    if (t >= camDuration - 0.05) return; // camera clip ended first; renderer keeps its last frame
    if (cam.seeking) return;
    const drift = cam.currentTime - t;
    if (Math.abs(drift) > 0.3) {
      if (now - this.lastCamSeek > 1000) {
        this.lastCamSeek = now;
        cam.playbackRate = 1;
        cam.currentTime = t;
      }
    } else {
      // Small drift: nudge the rate instead of seeking (seeks stall the decoder briefly).
      const rate = Math.abs(drift) < 0.04 ? 1 : clamp(1 - drift * 1.5, 0.9, 1.1);
      if (Math.abs(cam.playbackRate - rate) > 0.005) cam.playbackRate = rate;
    }
    if (cam.paused && !cam.ended) cam.play().catch(() => {});
  }

  report(t, force) {
    if (!this.onProgress) return;
    const now = performance.now();
    if (!force && now - this.lastReport < 100) return;
    this.lastReport = now;
    const done = clamp(t - this.start, 0, this.duration);
    const fraction = this.duration > 0 ? done / this.duration : 1;
    const wall = this.playStartedAt ? (now - this.playStartedAt) / 1000 : 0;
    const speed = done > 0.5 && wall > 0.5 ? done / wall : 1;
    const eta = Math.max(0, (this.duration - done) / Math.max(0.05, speed));
    this.safeCall(this.onProgress, fraction, eta);
  }

  safeCall(fn, ...args) {
    try {
      fn(...args);
    } catch (err) {
      if (!this.callbackErrorLogged) {
        this.callbackErrorLogged = true;
        console.error('[exporter] callback failed', err);
      }
    }
  }

  handleUnexpectedPause() {
    if (this.finished || !this.started) return;
    const m = this.main;
    if (m.ended || m.currentTime >= this.end - 0.05) {
      this.finish();
      return;
    }
    // Paused by something else (media keys, global media controls) — keep going.
    m.play().catch(() => {});
  }

  checkHealth() {
    if (this.finished) return;
    const now = performance.now();
    if (this.started) {
      // Last resort if the clock worker died; also refreshes stall tracking.
      if (now - this.lastDraw > 400) this.tick();
      if (this.finished) return;
      const t = this.main.currentTime;
      if (t > this.lastProgressT + 0.001) {
        this.lastProgressT = t;
        this.lastProgressWall = now;
      }
    }
    if (now - this.lastProgressWall > STALL_MS) {
      this.fail(friendlyError('Export stalled because the video stopped playing. Keep this tab open and try again.'));
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.stopDrivers();
    this.complete().catch((err) => this.fail(err?.name === 'AbortError' ? err : friendlyError('The video couldn’t be finalized.', err)));
  }

  async complete() {
    try {
      this.drawAt(clamp(this.main.currentTime, this.start, this.end));
    } catch { /* the previous frame is already in the stream */ }
    this.main.pause();
    this.camera?.pause();
    this.report(this.end, true);
    // Give the encoder a moment to receive the final frame and audio before flushing.
    await sleep(150);
    if (this.settled) return;

    const recorder = this.recorder;
    if (recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        recorder.addEventListener('stop', () => { clearTimeout(timer); resolve(); }, { once: true });
        try { recorder.stop(); } catch { clearTimeout(timer); resolve(); }
      });
    }
    const durationMs = performance.now() - this.recordStartedAt;
    if (this.settled) return;

    const mimeType = recorder.mimeType || this.format.mimeType || '';
    const isMp4 = /mp4/i.test(mimeType);
    let blob = new Blob(this.chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
    this.chunks = [];
    if (!blob.size) throw friendlyError('The export produced an empty file. Try again, or pick a lower resolution.');
    if (!isMp4) blob = await fixWebmDuration(blob, durationMs);
    if (this.settled) return;
    this.settled = true;
    this.resolve({ blob, mimeType, extension: isMp4 ? '.mp4' : '.webm' });
  }

  fail(err) {
    if (this.settled) return;
    this.settled = true;
    this.finished = true;
    this.stopDrivers();
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch { /* already stopped */ }
    this.reject?.(err);
  }

  async acquireWakeLock() {
    if (this.wakeLock || this.disposed || !navigator.wakeLock?.request || document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (this.disposed || this.finished) {
        lock.release().catch(() => {});
        return;
      }
      this.wakeLock = lock;
      lock.addEventListener?.('release', () => { if (this.wakeLock === lock) this.wakeLock = null; });
    } catch { /* optional nicety */ }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.finished = true;
    this.stopDrivers();
    this.ticker.dispose();
    this.signal?.removeEventListener('abort', this.onAbort);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.main) {
      this.main.removeEventListener('ended', this.onEnded);
      this.main.removeEventListener('pause', this.onPause);
      this.main.removeEventListener('error', this.onMediaError);
    }
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onerror = null;
      try { if (this.recorder.state !== 'inactive') this.recorder.stop(); } catch { /* already stopped */ }
    }
    this.chunks = [];
    this.canvasStream?.getTracks().forEach((t) => t.stop());
    this.audioDest?.stream.getTracks().forEach((t) => t.stop());
    try { this.audioSource?.disconnect(); } catch { /* not connected */ }
    if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close().catch(() => {});
    this.videos.forEach(releaseVideo);
    this.videos = [];
    if (this.canvas) {
      // Frees the (possibly 4K) backing store right away.
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.host?.remove();
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}

/**
 * Renders the edited video in real time and records it.
 * @param {object} o
 * @param {object} o.project
 * @param {Blob|string} o.mainBlob
 * @param {Blob|string|null} [o.cameraBlob]
 * @param {'mp4'|'webm'} [o.format]       falls back to the best supported format
 * @param {720|1080|2160} [o.resolution]  output short side in px
 * @param {boolean} [o.showCaptions=true] burn in captions (when enabled in the project)
 * @param {AbortSignal} [o.signal]        abort → rejects with DOMException('Export cancelled', 'AbortError')
 * @param {(fraction: number, etaSec: number) => void} [o.onProgress]
 * @param {(canvas: HTMLCanvasElement) => void} [o.onFrame] called after every drawn frame
 * @returns {Promise<{ blob: Blob, mimeType: string, extension: '.mp4'|'.webm' }>}
 */
export async function exportVideo({
  project,
  mainBlob,
  cameraBlob = null,
  format = 'mp4',
  resolution = 1080,
  showCaptions = true,
  signal = null,
  onProgress = null,
  onFrame = null,
} = {}) {
  if (signal?.aborted) throw abortError();
  if (!project?.edit) throw new TypeError('exportVideo: a project is required');
  if (!mainBlob) throw friendlyError('This recording has no video to export.');
  if (typeof document === 'undefined') throw friendlyError(UNSUPPORTED_MESSAGE);
  const formats = supportedFormats();
  if (!formats.length) throw friendlyError(UNSUPPORTED_MESSAGE);
  const fmt = formats.find((f) => f.id === format) || formats[0];
  const res = Number(resolution) > 0 ? Number(resolution) : 1080;

  const job = new ExportJob({
    // A snapshot keeps the render consistent if the project changes mid-export.
    project: deepClone(project),
    mainBlob,
    cameraBlob,
    format: fmt,
    resolution: res,
    showCaptions: showCaptions !== false,
    signal,
    onProgress,
    onFrame,
  });
  return job.run();
}

/* ------------------------------------------------------------------ */
/* WebM duration fix                                                   */
/* ------------------------------------------------------------------ */
// MediaRecorder writes live WebM without a Duration, so players can't show length or seek
// well. We insert Segment › Info › Duration. Anything unexpected → return the blob untouched.

const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const SEEKHEAD_ID = 0x114d9b74;
const CLUSTER_ID = 0x1f43b675;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;

function readVint(bytes, pos, keepMarker) {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > bytes.length) return null;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    const b = bytes[pos + i];
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function encodeSize(value, minLength = 1) {
  let length = clamp(minLength, 1, 8);
  while (length < 8 && value >= Math.pow(2, 7 * length) - 1) length++;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function readUint(bytes, pos, length) {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + bytes[pos + i];
  return v;
}

/**
 * Adds a Duration to a MediaRecorder WebM blob. Never throws; returns the original on doubt.
 * @param {Blob} blob
 * @param {number} durationMs
 * @returns {Promise<Blob>}
 */
export async function fixWebmDuration(blob, durationMs) {
  try {
    if (!(durationMs > 0) || !blob?.size) return blob;
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 18)).arrayBuffer());

    const ebml = readVint(head, 0, true);
    if (!ebml || ebml.value !== EBML_ID) return blob;
    const ebmlSize = readVint(head, ebml.length);
    if (!ebmlSize || ebmlSize.unknown) return blob;
    let pos = ebml.length + ebmlSize.length + ebmlSize.value;

    const seg = readVint(head, pos, true);
    if (!seg || seg.value !== SEGMENT_ID) return blob;
    const segSizePos = pos + seg.length;
    const segSize = readVint(head, segSizePos);
    if (!segSize) return blob;
    pos = segSizePos + segSize.length;

    while (pos < head.length) {
      const id = readVint(head, pos, true);
      if (!id) return blob;
      const size = readVint(head, pos + id.length);
      if (!size || size.unknown) return blob;
      const dataStart = pos + id.length + size.length;
      const dataEnd = dataStart + size.value;
      // A SeekHead would hold absolute offsets that our insertion shifts.
      if (id.value === SEEKHEAD_ID || id.value === CLUSTER_ID) return blob;
      if (id.value === INFO_ID) {
        if (dataEnd > head.length) return blob;
        return patchInfo(blob, head, {
          segSizePos, segSize, infoSizePos: pos + id.length, infoSize: size, dataStart, dataEnd, durationMs,
        });
      }
      pos = dataEnd;
    }
    return blob;
  } catch {
    return blob;
  }
}

function patchInfo(blob, head, { segSizePos, segSize, infoSizePos, infoSize, dataStart, dataEnd, durationMs }) {
  let scale = 1_000_000;
  let existing = null;
  let pos = dataStart;
  while (pos < dataEnd) {
    const id = readVint(head, pos, true);
    if (!id) return blob;
    const size = readVint(head, pos + id.length);
    if (!size || size.unknown) return blob;
    const start = pos + id.length + size.length;
    if (start + size.value > dataEnd) return blob;
    if (id.value === TIMECODE_SCALE_ID && size.value >= 1 && size.value <= 8) scale = readUint(head, start, size.value) || scale;
    if (id.value === DURATION_ID) existing = { start, length: size.value };
    pos = start + size.value;
  }
  const duration = (durationMs * 1_000_000) / scale;

  if (existing) {
    const view = new DataView(head.buffer, head.byteOffset + existing.start, existing.length);
    const current = existing.length === 8 ? view.getFloat64(0) : existing.length === 4 ? view.getFloat32(0) : NaN;
    if (current > 0 || !(existing.length === 8 || existing.length === 4)) return blob;
    const bytes = new Uint8Array(existing.length);
    const out = new DataView(bytes.buffer);
    if (existing.length === 8) out.setFloat64(0, duration);
    else out.setFloat32(0, duration);
    return new Blob([blob.slice(0, existing.start), bytes, blob.slice(existing.start + existing.length)], { type: blob.type });
  }

  // Duration element: ID 0x4489, 1-byte size (8), float64 big-endian.
  const element = new Uint8Array(11);
  element.set([0x44, 0x89, 0x88]);
  new DataView(element.buffer).setFloat64(3, duration);
  const newInfoSize = encodeSize(infoSize.value + element.length, infoSize.length);
  const delta = element.length + (newInfoSize.length - infoSize.length);

  const parts = [];
  if (segSize.unknown) {
    parts.push(blob.slice(0, infoSizePos));
  } else {
    parts.push(blob.slice(0, segSizePos), encodeSize(segSize.value + delta, segSize.length), blob.slice(segSizePos + segSize.length, infoSizePos));
  }
  parts.push(newInfoSize, blob.slice(dataStart, dataEnd), element, blob.slice(dataEnd));
  return new Blob(parts, { type: blob.type });
}
