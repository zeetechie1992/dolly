// Live speech-to-text with the Web Speech API (SpeechRecognition / webkitSpeechRecognition).
// Segments are timed against the recording clock (getElapsed), not wall time, so pauses don't
// skew captions. Never throws: unsupported browsers, network hiccups and permission errors only
// end up as a status ('unavailable') the UI can show.

import { uid } from '../lib/util.js';

const SpeechRecognitionClass = typeof window !== 'undefined'
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : undefined;

const LEAD_IN = 0.3;             // the first interim result lags the first spoken word a little
const MIN_SEGMENT = 0.2;
const MAX_HARD_FAILURES = 3;     // consecutive not-allowed / audio-capture errors before giving up
const RESTART_DELAY_MS = 150;
const MAX_BACKOFF_MS = 8000;
const HARD_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);
const WARN_AFTER_FAILURES = 2;   // consecutive failed sessions before the status says 'reconnecting'

const round3 = (n) => Math.round(n * 1000) / 1000;

function tidy(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** Rough speaking time, used only when an utterance arrives final without any interim results. */
function estimateSpoken(text) {
  const words = text.split(' ').length;
  return Math.min(6, Math.max(0.6, words * 0.32));
}

export function isTranscriptionSupported() {
  return Boolean(SpeechRecognitionClass);
}

/**
 * const t = new Transcriber({ getElapsed: () => recorder.elapsed, onUpdate(interim, segments) {} });
 * t.start(); t.pause(); t.resume(); const segments = await t.stop();
 * Segment: { id: 's_xxx', start, end, text } in recording seconds, sorted, non-overlapping.
 */
export class Transcriber {
  static get supported() { return Boolean(SpeechRecognitionClass); }

  /** (interimText: string, segments: Segment[]) => void */
  onUpdate = null;
  /**
   * (status: 'listening'|'reconnecting'|'paused'|'stopped'|'unavailable', detail?: string) => void
   * 'reconnecting' means sessions keep failing (offline, flaky network) and are being retried;
   * 'listening' follows once a session works again. Only 'unavailable' is final.
   */
  onStatus = null;

  #getElapsed;
  #lang;
  #track = null;          // the mic to listen to (falls back to the system default input)
  #rec = null;
  #running = false;       // a recognition session is open
  #active = false;        // the caller wants transcription (between start and stop)
  #paused = false;
  #destroyed = false;
  #gaveUp = false;
  #segments = [];
  #interim = '';
  #utteranceStart = null;
  #lastFinalIndex = -1;
  #restartTimer = 0;
  #failures = 0;
  #hardFailures = 0;
  #reconnecting = false;  // sessions keep failing; the status says so until one works again
  #sessionFailed = false; // the current session hit a real error (not no-speech / aborted)
  #triedFallbackLang = false;
  #endWaiters = [];

  /**
   * @param {{ getElapsed: () => number, onUpdate?: Function, onStatus?: Function, lang?: string,
   *   track?: MediaStreamTrack }} opts  track: the audio track to transcribe (the mic chosen in
   *   Dolly). Browsers that can't listen to a given track use the system default input instead.
   */
  constructor({ getElapsed, onUpdate = null, onStatus = null, lang, track = null } = {}) {
    this.#getElapsed = typeof getElapsed === 'function' ? getElapsed : () => 0;
    this.#track = track && track.kind === 'audio' ? track : null;
    this.#lang = lang || (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
  }

  get segments() { return this.#segments.slice(); }
  get interim() { return this.#interim; }
  get active() { return this.#active && !this.#gaveUp; }
  get available() { return Boolean(SpeechRecognitionClass) && !this.#gaveUp && !this.#destroyed; }

  start() {
    if (!SpeechRecognitionClass) {
      this.#emitStatus('unavailable', 'unsupported');
      return false;
    }
    if (this.#destroyed || this.#active || this.#gaveUp) return false;
    this.#active = true;
    this.#paused = false;
    this.#launch();
    return true;
  }

  /** Stops listening; any pending words are finalized at the paused clock time. */
  pause() {
    if (!this.#active || this.#paused || this.#gaveUp) return;
    this.#paused = true;
    clearTimeout(this.#restartTimer);
    if (this.#running && this.#rec) {
      try { this.#rec.stop(); } catch { /* not started */ }
    }
    this.#emitStatus('paused');
  }

  resume() {
    if (!this.#active || !this.#paused || this.#gaveUp) return;
    this.#paused = false;
    // If the previous session is still closing, its 'end' handler relaunches.
    if (!this.#running) this.#launch();
  }

  /** Stops, waits briefly for the last final result, and resolves with every segment. */
  async stop({ timeout = 1500 } = {}) {
    if (this.#destroyed) return this.segments;
    this.#active = false;
    this.#paused = false;
    clearTimeout(this.#restartTimer);
    const rec = this.#rec;
    if (rec && this.#running) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, timeout);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.#endWaiters.push(done);
        try { rec.stop(); } catch { done(); }
      });
    }
    this.#flushInterim();
    this.#detach();
    this.#emitStatus('stopped');
    return this.segments;
  }

  /** Discards all text (for "Restart"). The instance can be started again unless it gave up. */
  reset() {
    this.#active = false;
    this.#paused = false;
    clearTimeout(this.#restartTimer);
    this.#detach();
    this.#segments = [];
    this.#interim = '';
    this.#utteranceStart = null;
    this.#failures = 0;
    this.#hardFailures = 0;
    this.#reconnecting = false;
    this.#sessionFailed = false;
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#active = false;
    clearTimeout(this.#restartTimer);
    this.#detach();
    this.onUpdate = null;
    this.onStatus = null;
  }

  #launch() {
    if (!this.#active || this.#paused || this.#destroyed || this.#gaveUp || this.#running) return;
    let rec;
    try {
      rec = new SpeechRecognitionClass();
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = this.#lang;
    } catch {
      this.#giveUp('unsupported');
      return;
    }
    rec.onresult = (e) => this.#handleResult(rec, e);
    rec.onerror = (e) => this.#handleError(rec, e);
    rec.onend = () => this.#handleEnd(rec);
    this.#rec = rec;
    this.#lastFinalIndex = -1;
    this.#sessionFailed = false;
    try {
      // Listen to the mic chosen in Dolly, not the system default input. Browsers without the
      // start(track) overload ignore the argument; the TypeError branch is only a guard.
      const track = this.#track?.readyState === 'live' ? this.#track : null;
      if (track) {
        try {
          rec.start(track);
        } catch (err) {
          if (err?.name !== 'TypeError') throw err;
          rec.start();
        }
      } else {
        rec.start();
      }
      this.#running = true;
      // While sessions keep failing, a new attempt is not yet proof that it works.
      this.#emitStatus(this.#reconnecting ? 'reconnecting' : 'listening');
    } catch {
      // e.g. InvalidStateError while Chrome is still tearing down the previous session
      this.#unbind(rec);
      this.#rec = null;
      this.#noteFailure('start-failed');
      this.#scheduleRestart();
    }
  }

  #handleResult(rec, e) {
    if (rec !== this.#rec || this.#destroyed) return;
    this.#failures = 0;
    this.#hardFailures = 0;
    if (this.#reconnecting) {
      this.#reconnecting = false;
      this.#emitStatus('listening');
    }
    const now = this.#getElapsed();
    const results = e.results;
    let interim = '';
    const from = Math.max(0, Math.min(e.resultIndex, this.#lastFinalIndex + 1));
    for (let i = from; i < results.length; i++) {
      const result = results[i];
      const text = result[0] ? result[0].transcript : '';
      if (result.isFinal) {
        if (i > this.#lastFinalIndex) {
          this.#lastFinalIndex = i;
          this.#commit(text, now);
        }
      } else {
        interim += text;
      }
    }
    this.#interim = tidy(interim);
    if (this.#interim && this.#utteranceStart === null) this.#utteranceStart = now;
    this.#emitUpdate();
  }

  #handleError(rec, e) {
    if (rec !== this.#rec || this.#destroyed) return;
    const code = e.error || 'unknown';
    if (code === 'aborted' || code === 'no-speech') return; // benign: 'end' follows and we relaunch
    if (code === 'language-not-supported') {
      if (!this.#triedFallbackLang && this.#lang !== 'en-US') {
        this.#triedFallbackLang = true;
        this.#lang = 'en-US';
        return;
      }
      this.#giveUp(code);
      return;
    }
    if (HARD_ERRORS.has(code)) {
      this.#hardFailures += 1;
      if (this.#hardFailures >= MAX_HARD_FAILURES) {
        this.#giveUp(code);
        return;
      }
    }
    this.#noteFailure(code); // network etc.: retry with backoff
  }

  /** A real error: back off before the next attempt, and say so once it keeps happening. */
  #noteFailure(code) {
    this.#sessionFailed = true;
    this.#failures += 1;
    if (!this.#reconnecting && this.#failures >= WARN_AFTER_FAILURES) {
      this.#reconnecting = true;
      this.#emitStatus('reconnecting', code);
    }
  }

  #handleEnd(rec) {
    if (rec !== this.#rec) return;
    this.#running = false;
    this.#unbind(rec);
    this.#rec = null;
    this.#flushInterim(); // a session can end (silence, network) without finalizing its last words
    const waiters = this.#endWaiters.splice(0);
    waiters.forEach((fn) => fn());
    const relaunch = this.#active && !this.#paused && !this.#gaveUp && !this.#destroyed;
    if (!this.#sessionFailed) {
      // Ending on silence (no-speech) or cleanly means the service works: restart quickly.
      this.#failures = 0;
      if (this.#reconnecting) {
        this.#reconnecting = false;
        if (relaunch) this.#emitStatus('listening');
      }
    }
    if (relaunch) this.#scheduleRestart();
  }

  #scheduleRestart() {
    clearTimeout(this.#restartTimer);
    const delay = this.#failures ? Math.min(MAX_BACKOFF_MS, 400 * 2 ** (this.#failures - 1)) : RESTART_DELAY_MS;
    this.#restartTimer = setTimeout(() => this.#launch(), delay);
  }

  #commit(rawText, now) {
    const text = tidy(rawText);
    const startedAt = this.#utteranceStart;
    this.#utteranceStart = null;
    if (!text) return;
    const end = Math.max(0, now);
    let start = startedAt !== null ? startedAt - LEAD_IN : end - estimateSpoken(text);
    const prev = this.#segments[this.#segments.length - 1];
    if (prev) start = Math.max(start, prev.end);
    start = Math.max(0, Math.min(start, end));
    this.#segments.push({
      id: uid('s_'),
      start: round3(start),
      end: round3(Math.max(end, start + MIN_SEGMENT)),
      text,
    });
  }

  #flushInterim() {
    if (!this.#interim) return;
    const text = this.#interim;
    this.#interim = '';
    this.#commit(text, this.#getElapsed());
    this.#emitUpdate();
  }

  #giveUp(code) {
    if (this.#gaveUp) return;
    this.#gaveUp = true;
    clearTimeout(this.#restartTimer);
    this.#flushInterim();
    this.#detach();
    this.#emitStatus('unavailable', code);
  }

  #unbind(rec) {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
  }

  /** Drops the current session without waiting for results. */
  #detach() {
    const rec = this.#rec;
    this.#rec = null;
    this.#running = false;
    if (rec) {
      this.#unbind(rec);
      try { rec.abort(); } catch { /* not started */ }
    }
    const waiters = this.#endWaiters.splice(0);
    waiters.forEach((fn) => fn());
  }

  #emitUpdate() {
    try {
      this.onUpdate?.(this.#interim, this.segments);
    } catch (err) {
      console.error('[transcriber] onUpdate failed', err);
    }
  }

  #emitStatus(status, detail) {
    try {
      this.onStatus?.(status, detail);
    } catch (err) {
      console.error('[transcriber] onStatus failed', err);
    }
  }
}
