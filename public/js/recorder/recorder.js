// Recording engine.
//   Recorder   — one recording session. Builds the main stream (screen video, or camera video in
//                'cam' mode, plus mic + system audio mixed with WebAudio) and runs its MediaRecorder.
//                In 'screen+cam' mode a second, camera-only MediaRecorder starts in the same tick so
//                both files share t=0. The clock is pause-aware.
//   LevelMeter — smoothed RMS level of a mic stream, for the level meters.
//
// Stream ownership: the Recorder stops the display stream it is given (it only exists for this
// recording). Camera and mic streams belong to the caller, which also drives previews with them.

import { clamp } from '../lib/util.js';
import { pickMimeType, RECORDING_MIME_TYPES, stopStream } from '../lib/media.js';

const TIMESLICE_MS = 1000;
const MAIN_VIDEO_BPS = 8_000_000;
const CAMERA_VIDEO_BPS = 2_500_000;
const AUDIO_BPS = 160_000;
// Periodic keyframes keep seeking snappy in the editor. Chrome-only option; others ignore it.
const KEYFRAME_INTERVAL_MS = 2000;
const STOP_TIMEOUT_MS = 5000;

const AudioContextClass = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined;

/** True when this browser can record a MediaStream to a file. */
export function isRecordingSupported() {
  return typeof window !== 'undefined' && typeof window.MediaRecorder === 'function' && typeof window.MediaStream === 'function';
}

function liveTrack(stream, kind) {
  if (!stream) return null;
  const tracks = kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks();
  return tracks.find((t) => t.readyState === 'live') || null;
}

function trackSize(track) {
  if (!track || typeof track.getSettings !== 'function') return null;
  const { width, height } = track.getSettings();
  return width > 0 && height > 0 ? { width, height } : null;
}

/** 'video/webm;codecs=vp9,opus' → 'video/webm;codecs=vp9' when supported (for video-only streams). */
function videoOnlyMime(mime) {
  const match = /^([^;]+);\s*codecs=(.+)$/i.exec(mime || '');
  if (!match) return mime || '';
  const codecs = match[2].replace(/["']/g, '').split(',').map((c) => c.trim())
    .filter((c) => c && !/^(opus|vorbis|mp4a|aac|pcm)/i.test(c));
  const candidate = codecs.length ? `${match[1]};codecs=${codecs.join(',')}` : match[1];
  try {
    return MediaRecorder.isTypeSupported(candidate) ? candidate : mime;
  } catch {
    return mime;
  }
}

const baseType = (mime) => (mime || '').split(';')[0].trim() || 'video/webm';

function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * States: 'idle' → prepare() → 'ready' → start() → 'recording' ⇄ 'paused'
 *         → stop() → 'stopping' → 'stopped'   |   cancel() → 'cancelled'
 */
export class Recorder {
  /** Called once when the main video track ends (e.g. the browser's "Stop sharing" button). */
  onEnded = null;
  /** Called with (error, 'main' | 'camera') when a MediaRecorder fails. */
  onError = null;
  /**
   * Called with ('main' | 'camera', seq, Blob) for every chunk as it arrives (seq counts from 0
   * per take), so the caller can back the take up while it is still recording. Chunks of a
   * discarded take (restart, cancel) are never forwarded.
   */
  onChunk = null;

  #mode;
  #displayStream;
  #cameraStream;
  #micStream;
  #bitrates;
  #state = 'idle';
  #videoTrack = null;
  #cameraTrack = null;
  #audioTrack = null;
  #ownsAudioTrack = false;
  #hasSystemAudio = false;
  #audioCtx = null;
  #audioNodes = [];
  #mainStream = null;
  #mainMime = '';
  #cameraMime = '';
  #takes = { main: null, camera: null };
  #startedAt = 0;
  #pausedAt = 0;
  #pausedTotal = 0;
  #frozenElapsed = null;
  #stopPromise = null;
  #endedFired = false;
  #tornDown = false;

  /**
   * @param {object} o
   * @param {'screen+cam'|'screen'|'cam'} o.mode
   * @param {MediaStream|null} [o.displayStream] required unless mode is 'cam' (owned: stopped on stop/cancel)
   * @param {MediaStream|null} [o.cameraStream]  required for 'cam'; recorded separately in 'screen+cam'
   * @param {MediaStream|null} [o.micStream]
   */
  constructor({ mode = 'screen', displayStream = null, cameraStream = null, micStream = null, onEnded = null, onError = null,
    mainBitrate = MAIN_VIDEO_BPS, cameraBitrate = CAMERA_VIDEO_BPS } = {}) {
    this.#mode = mode;
    this.#displayStream = displayStream;
    this.#cameraStream = cameraStream;
    this.#micStream = micStream;
    this.#bitrates = { main: mainBitrate, camera: cameraBitrate };
    this.onEnded = onEnded;
    this.onError = onError;
  }

  get state() { return this.#state; }
  get mode() { return this.#mode; }
  get hasAudio() { return Boolean(this.#audioTrack); }
  get hasSystemAudio() { return this.#hasSystemAudio; }
  get hasCamera() { return Boolean(this.#cameraTrack); }
  get mimeType() { return this.#mainMime; }

  /** Recorded seconds, excluding paused time. Frozen once stopped. */
  get elapsed() {
    if (this.#frozenElapsed !== null) return this.#frozenElapsed;
    if (this.#state !== 'recording' && this.#state !== 'paused') return 0;
    const now = this.#state === 'paused' ? this.#pausedAt : performance.now();
    return Math.max(0, (now - this.#startedAt - this.#pausedTotal) / 1000);
  }

  /** Builds the streams (audio mix included). Throws when the required video source is missing. */
  prepare() {
    if (this.#state !== 'idle') return this;
    if (!isRecordingSupported()) throw new Error("This browser can't record video.");
    const video = this.#mode === 'cam' ? liveTrack(this.#cameraStream, 'video') : liveTrack(this.#displayStream, 'video');
    if (!video) throw new Error(this.#mode === 'cam' ? 'Your camera is not available.' : 'Screen capture is not available.');

    this.#videoTrack = video;
    this.#cameraTrack = this.#mode === 'screen+cam' ? liveTrack(this.#cameraStream, 'video') : null;
    const systemTracks = this.#displayStream ? this.#displayStream.getAudioTracks().filter((t) => t.readyState === 'live') : [];
    this.#hasSystemAudio = systemTracks.length > 0;
    this.#audioTrack = this.#buildAudio([liveTrack(this.#micStream, 'audio'), ...systemTracks].filter(Boolean));
    this.#mainStream = new MediaStream(this.#audioTrack ? [video, this.#audioTrack] : [video]);

    const mime = pickMimeType(RECORDING_MIME_TYPES);
    this.#mainMime = this.#audioTrack ? mime : videoOnlyMime(mime);
    this.#cameraMime = videoOnlyMime(mime);

    video.addEventListener('ended', this.#handleTrackEnded);
    this.#state = 'ready';
    return this;
  }

  /** Starts the main (and camera) MediaRecorders in the same tick. */
  start() {
    if (this.#state !== 'ready') throw new Error(`Can't start while ${this.#state}.`);
    if (!this.#videoTrack || this.#videoTrack.readyState !== 'live') throw new Error('The video source has ended.');

    const main = this.#createTake('main', this.#mainStream, this.#mainMime, this.#bitrates.main, Boolean(this.#audioTrack));
    let camera = null;
    if (this.#cameraTrack && this.#cameraTrack.readyState === 'live') {
      try {
        camera = this.#createTake('camera', new MediaStream([this.#cameraTrack]), this.#cameraMime, this.#bitrates.camera, false);
      } catch {
        camera = null; // the main recording matters more than the bubble
      }
    }
    if (this.#audioCtx && this.#audioCtx.state === 'suspended') this.#audioCtx.resume().catch(() => {});

    main.rec.start(TIMESLICE_MS);
    if (camera) {
      try {
        camera.rec.start(TIMESLICE_MS);
      } catch {
        camera.discarded = true;
        camera = null;
      }
    }
    this.#takes = { main, camera };
    this.#startedAt = performance.now();
    this.#pausedAt = 0;
    this.#pausedTotal = 0;
    this.#frozenElapsed = null;
    this.#state = 'recording';
    return this;
  }

  pause() {
    if (this.#state !== 'recording') return false;
    for (const take of this.#liveTakes()) {
      if (take.rec.state === 'recording') {
        try { take.rec.pause(); } catch { /* already inactive */ }
      }
    }
    this.#pausedAt = performance.now();
    this.#state = 'paused';
    return true;
  }

  resume() {
    if (this.#state !== 'paused') return false;
    for (const take of this.#liveTakes()) {
      if (take.rec.state === 'paused') {
        try { take.rec.resume(); } catch { /* already inactive */ }
      }
    }
    this.#pausedTotal += performance.now() - this.#pausedAt;
    this.#pausedAt = 0;
    this.#state = 'recording';
    return true;
  }

  /**
   * Finalizes the recording and releases the display stream + audio graph.
   * @returns {Promise<{ main: Blob, camera: Blob|null, duration: number, mimeType: string, hasAudio: boolean,
   *   hasSystemAudio: boolean, mainSize: {width,height}|null, cameraSize: {width,height}|null }>}
   */
  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#state !== 'recording' && this.#state !== 'paused') return Promise.reject(new Error('Nothing is being recorded.'));
    this.#stopPromise = this.#finalize();
    return this.#stopPromise;
  }

  async #finalize() {
    const duration = this.elapsed;
    this.#frozenElapsed = duration;
    this.#state = 'stopping';
    this.#videoTrack?.removeEventListener('ended', this.#handleTrackEnded);
    // Read sizes before the display track is stopped.
    const mainSize = trackSize(this.#videoTrack);
    const cameraSize = trackSize(this.#cameraTrack);

    const takes = this.#liveTakes();
    for (const take of takes) {
      if (take.rec.state !== 'inactive') {
        try { take.rec.stop(); } catch { /* already stopped */ }
      }
    }
    await Promise.all(takes.map((take) => settleWithin(take.done, STOP_TIMEOUT_MS)));

    const toBlob = (take, fallbackMime) => (take && take.chunks.length
      ? new Blob(take.chunks, { type: baseType(take.rec.mimeType || fallbackMime) })
      : null);
    const { main, camera } = this.#takes;
    const mainBlob = toBlob(main, this.#mainMime) || new Blob([], { type: baseType(this.#mainMime) });
    const cameraBlob = toBlob(camera, this.#cameraMime);
    const result = {
      main: mainBlob,
      camera: cameraBlob,
      duration,
      mimeType: mainBlob.type,
      hasAudio: Boolean(this.#audioTrack),
      hasSystemAudio: this.#hasSystemAudio,
      mainSize,
      cameraSize: cameraBlob ? cameraSize : null,
    };
    this.#takes = { main: null, camera: null };
    this.#teardown();
    this.#state = 'stopped';
    return result;
  }

  /** Throws the current take away and releases everything. */
  cancel() {
    if (this.#state === 'cancelled' || this.#state === 'stopped' || this.#state === 'stopping') return;
    this.#discardTakes();
    this.#teardown();
    this.#frozenElapsed = 0;
    this.#state = 'cancelled';
  }

  /**
   * Discards the current take but keeps the sources, ready for a fresh start.
   * Throws when the video source has ended (the caller should then cancel).
   */
  restart({ autoStart = true } = {}) {
    if (!['ready', 'recording', 'paused'].includes(this.#state)) throw new Error(`Can't restart while ${this.#state}.`);
    this.#discardTakes();
    this.#state = 'ready';
    this.#startedAt = 0;
    this.#pausedAt = 0;
    this.#pausedTotal = 0;
    this.#frozenElapsed = null;
    if (!this.#videoTrack || this.#videoTrack.readyState !== 'live') throw new Error('The video source has ended.');
    if (autoStart) this.start();
    return this;
  }

  /** Idempotent cleanup for unmount. */
  destroy() {
    if (this.#state === 'ready' || this.#state === 'recording' || this.#state === 'paused') this.cancel();
    else this.#teardown();
    this.onEnded = null;
    this.onError = null;
    this.onChunk = null;
  }

  #handleTrackEnded = () => {
    if (this.#endedFired) return;
    if (this.#state !== 'ready' && this.#state !== 'recording' && this.#state !== 'paused') return;
    this.#endedFired = true;
    try {
      this.onEnded?.();
    } catch (err) {
      console.error('[recorder] onEnded handler failed', err);
    }
  };

  #buildAudio(sources) {
    if (!sources.length) return null;
    // A single source needs no mixing (and can't be silenced by a suspended AudioContext).
    if (sources.length === 1 || !AudioContextClass) {
      this.#ownsAudioTrack = false;
      return sources[0];
    }
    try {
      const ctx = new AudioContextClass();
      const destination = ctx.createMediaStreamDestination();
      for (const track of sources) {
        const node = ctx.createMediaStreamSource(new MediaStream([track]));
        node.connect(destination);
        this.#audioNodes.push(node);
      }
      this.#audioCtx = ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const mixed = destination.stream.getAudioTracks()[0] || null;
      this.#ownsAudioTrack = Boolean(mixed);
      return mixed || sources[0];
    } catch {
      this.#closeAudio();
      this.#ownsAudioTrack = false;
      return sources[0];
    }
  }

  #createTake(kind, stream, mime, videoBitsPerSecond, withAudio) {
    const options = { videoBitsPerSecond, videoKeyFrameIntervalDuration: KEYFRAME_INTERVAL_MS };
    if (withAudio) options.audioBitsPerSecond = AUDIO_BPS;
    if (mime) options.mimeType = mime;
    let rec;
    try {
      rec = new MediaRecorder(stream, options);
    } catch {
      rec = new MediaRecorder(stream, { videoBitsPerSecond });
    }
    const take = { kind, rec, chunks: [], discarded: false, done: null };
    take.done = new Promise((resolve) => rec.addEventListener('stop', () => resolve(), { once: true }));
    let seq = 0;
    rec.addEventListener('dataavailable', (e) => {
      if (take.discarded || !e.data || !e.data.size) return;
      take.chunks.push(e.data);
      const n = seq++; // counted even without a listener, so seq always matches the chunk's place in the file
      try {
        this.onChunk?.(kind, n, e.data);
      } catch (err) {
        console.error('[recorder] onChunk failed', err);
      }
    });
    rec.addEventListener('error', (e) => {
      if (take.discarded) return;
      try {
        this.onError?.(e.error || new Error('Recording failed'), kind);
      } catch (err) {
        console.error('[recorder] onError handler failed', err);
      }
    });
    return take;
  }

  #liveTakes() {
    return [this.#takes.main, this.#takes.camera].filter(Boolean);
  }

  #discardTakes() {
    for (const take of this.#liveTakes()) {
      take.discarded = true;
      take.chunks = [];
      if (take.rec.state !== 'inactive') {
        try { take.rec.stop(); } catch { /* already stopped */ }
      }
    }
    this.#takes = { main: null, camera: null };
  }

  #closeAudio() {
    for (const node of this.#audioNodes) {
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
    this.#audioNodes = [];
    if (this.#audioCtx) {
      try { this.#audioCtx.close().catch(() => {}); } catch { /* closed */ }
      this.#audioCtx = null;
    }
  }

  #teardown() {
    if (this.#tornDown) return;
    this.#tornDown = true;
    this.#videoTrack?.removeEventListener('ended', this.#handleTrackEnded);
    stopStream(this.#displayStream);
    if (this.#ownsAudioTrack) this.#audioTrack?.stop();
    this.#closeAudio();
  }
}

/** Smoothed 0..1 RMS level of a microphone stream. Call read() once per animation frame. */
export class LevelMeter {
  #ctx = null;
  #source = null;
  #analyser = null;
  #buffer = null;
  #bytes = null;
  #level = 0;
  #closed = false;

  constructor(stream = null) {
    if (stream) this.setStream(stream);
  }

  get suspended() { return Boolean(this.#ctx) && this.#ctx.state === 'suspended'; }

  /** Switches to another stream (or null for silence). Creates the AudioContext on first use. */
  setStream(stream) {
    this.#disconnect();
    const track = liveTrack(stream, 'audio');
    if (!track || this.#closed || !AudioContextClass) return;
    try {
      if (!this.#ctx) this.#ctx = new AudioContextClass();
      this.#analyser = this.#ctx.createAnalyser();
      this.#analyser.fftSize = 1024;
      this.#analyser.smoothingTimeConstant = 0;
      this.#source = this.#ctx.createMediaStreamSource(new MediaStream([track]));
      this.#source.connect(this.#analyser);
      this.#buffer = new Float32Array(this.#analyser.fftSize);
      this.resume();
    } catch {
      this.#disconnect();
    }
  }

  resume() {
    if (this.#ctx && this.#ctx.state === 'suspended') this.#ctx.resume().catch(() => {});
  }

  /** Fast attack, slow release, mapped from roughly -56..-8 dBFS. */
  read() {
    let target = 0;
    const analyser = this.#analyser;
    if (analyser && this.#ctx && this.#ctx.state === 'running') {
      const n = analyser.fftSize;
      let sum = 0;
      if (typeof analyser.getFloatTimeDomainData === 'function') {
        analyser.getFloatTimeDomainData(this.#buffer);
        for (let i = 0; i < n; i++) sum += this.#buffer[i] * this.#buffer[i];
      } else {
        if (!this.#bytes) this.#bytes = new Uint8Array(n);
        analyser.getByteTimeDomainData(this.#bytes);
        for (let i = 0; i < n; i++) {
          const v = (this.#bytes[i] - 128) / 128;
          sum += v * v;
        }
      }
      const rms = Math.sqrt(sum / n);
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      target = clamp((db + 56) / 48, 0, 1);
    }
    this.#level += (target - this.#level) * (target > this.#level ? 0.5 : 0.12);
    if (this.#level < 0.002) this.#level = 0;
    return this.#level;
  }

  destroy() {
    this.#closed = true;
    this.#disconnect();
    if (this.#ctx) {
      try { this.#ctx.close().catch(() => {}); } catch { /* closed */ }
      this.#ctx = null;
    }
  }

  #disconnect() {
    try { this.#source?.disconnect(); } catch { /* already disconnected */ }
    this.#source = null;
    this.#analyser = null;
  }
}
