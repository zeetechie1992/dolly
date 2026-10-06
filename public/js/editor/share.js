// Share links, app side: what a link carries (payload + change hashes) and the job behind
// "Create link" / "Update video": render the edit (exporter, real time) → poster frame →
// resumable upload → metadata in line with the new video.
//
// Jobs are module-level singletons per project id, so the share dialog can close and reopen,
// and the editor can unmount, while one runs. Anyone can follow a project's job with
// subscribe(projectId, fn). Rendering happens in real time in this tab, so the tab has to stay
// open until the upload finishes (a beforeunload prompt guards it while a job is active).
//
// project.share = { id, url, embedUrl, ownerToken, createdAt, version, videoHash, metaHash,
//                   burnCaptions, settings, trim, pendingMeta? }   — persisted with { history: false }.
// `trim` (an addition to the contract) is the trim of the video that is live on the link, so
// metadata patched later (shifted transcript / chapters) keeps matching that video.
// `pendingMeta` = { layout, duration } of the live video when the PATCH that should follow its
// upload failed (metaHash is null then); the dialog re-sends them with the metadata.
//
// The pure helpers (buildSharePayload, videoHash, metaHash) never touch the DOM.

import { clamp, deepClone } from '../lib/util.js';
import { loadVideo, seekVideo } from '../lib/media.js';
import { getAspect } from '../lib/project.js';
import { getProject, patchProject } from '../lib/db.js';
import { uploadVideo, uploadPoster, updateShare, failVideo, withRetry } from '../lib/share-api.js';
import { exportVideo, getExportSize, supportedFormats } from './exporter.js';
import { computeLayout } from './renderer.js';

/** Shared videos render at 1080p (short side). */
export const SHARE_RESOLUTION = 1080;
const OWNER_NAME_KEY = 'dolly.ownerName';
const ACTIVE = new Set(['rendering', 'poster', 'uploading']);
const LOCK_PREFIX = 'dolly-share-job:'; // Web Lock held while a job runs for a link (seen by other tabs)
const EMIT_EVERY_MS = 200;
const POSTER_WIDTH = 1280;
const POSTER_TIMEOUT_MS = 12_000;
const CHAPTER_EPSILON = 0.05;
const EDGE_EPSILON = 0.05;  // a trim edge within this of the recording's start/end isn't a cut

/** True while a job in this phase is still working. */
export const isActivePhase = (phase) => ACTIVE.has(phase);

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

const num = (v, fallback = 0) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const r3 = (x) => Math.round(x * 1000) / 1000;
const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The video's trim window in source seconds, sanitized. */
export function shareTrim(project, override = null) {
  const total = num(project?.duration, 0);
  const t = override || project?.edit?.trim || {};
  let start = Math.max(0, num(t.start, 0));
  let end = num(t.end, total);
  if (total > 0) {
    start = Math.min(start, total);
    end = Math.min(end, total);
  }
  if (!(end > start)) end = total > start ? total : start;
  return { start: r3(start), end: r3(end) };
}

/** Chapters moved to the shared video's timeline (0 = its first frame), inside [0, duration). */
function shiftChapters(chapters, offset, duration) {
  const list = (Array.isArray(chapters) ? chapters : [])
    .map((c) => ({ start: num(c?.start, NaN) - offset, title: oneLine(c?.title, 200) }))
    .filter((c) => Number.isFinite(c.start) && c.title)
    .sort((a, b) => a.start - b.start);
  const out = [];
  let opening = null; // the latest chapter that began before the trimmed start: it is still running at 0
  for (const c of list) {
    if (c.start <= CHAPTER_EPSILON) opening = c;
    else if (c.start < duration) out.push({ start: r3(c.start), title: c.title });
  }
  if (opening && duration > 0) out.unshift({ start: 0, title: opening.title });
  return out;
}

/**
 * Transcript segments moved to the shared timeline and clipped to [0, duration].
 * A segment that crosses a cut keeps only the words spoken inside the window (word times are
 * estimated by character weight, as captions.js buildCaptionChunks does), so speech the owner
 * trimmed away never reaches the link. An edge that isn't trimmed is not a cut (`cutStart` /
 * `cutEnd` false): timestamps running a little past the recording's end are not removed speech.
 * @returns {{ segments: Array<{start:number,end:number,text:string}>, cut: boolean }}
 *   cut — some transcribed speech lies outside the window
 */
function clipTranscript(transcript, offset, duration, { cutStart = true, cutEnd = true } = {}) {
  const segments = [];
  let cut = false;
  const lo = cutStart ? offset : -Infinity;
  const hi = cutEnd ? offset + duration : Infinity;
  for (const seg of Array.isArray(transcript) ? transcript : []) {
    const text = oneLine(seg?.text, 2000);
    const s0 = num(seg?.start, NaN);
    if (!text || !Number.isFinite(s0)) continue;
    let e0 = num(seg?.end, NaN);
    if (!Number.isFinite(e0) || e0 <= s0) e0 = s0 + 1;
    if (e0 - lo < 0.01 || hi - s0 < 0.01) { // wholly outside
      cut = true;
      continue;
    }
    let kept = text;
    let ks = s0;
    let ke = e0;
    if (s0 < lo || e0 > hi) { // crosses a cut: keep only the words inside
      const words = text.split(' ');
      const total = words.reduce((n, w) => n + w.length + 1, 0);
      let acc = 0;
      const keep = [];
      for (const w of words) {
        const ws = s0 + ((e0 - s0) * acc) / total;
        acc += w.length + 1;
        const we = s0 + ((e0 - s0) * acc) / total;
        const mid = (ws + we) / 2;
        if (mid >= lo && mid <= hi) {
          if (!keep.length) ks = ws;
          ke = we;
          keep.push(w);
        }
      }
      if (keep.length < words.length) cut = true;
      if (!keep.length) continue;
      kept = keep.join(' ');
    }
    const start = Math.max(0, ks - offset);
    const end = Math.min(duration, ke - offset);
    if (end - start < 0.01) continue;
    segments.push({ start: r3(start), end: r3(end), text: kept });
  }
  return { segments: segments.sort((a, b) => a.start - b.start || a.end - b.end), cut };
}

/** Clips the project's transcript to a trim window (source seconds); see clipTranscript. */
function clipToTrim(project, start, end) {
  const total = num(project?.duration, 0);
  return clipTranscript(project?.transcript, start, Math.max(0, end - start), {
    cutStart: start > EDGE_EPSILON,
    cutEnd: !(total > 0) || end < total - EDGE_EPSILON,
  });
}

/** The summary has text (TL;DR, points, items or a title) that could describe speech. */
function summaryHasText(s) {
  if (!s || typeof s !== 'object') return false;
  return Boolean(oneLine(s.title, 200) || String(s.tldr ?? '').trim() || cleanList(s.key_points).length || cleanList(s.action_items).length);
}

/**
 * True when the link leaves out the summary's text (title, TL;DR, key points, action items):
 * the summary is written from the whole recording, so once the trim (the link's, or the
 * project's) cuts away transcribed speech it may repeat what the owner removed.
 * Chapters are re-timed and clipped, so they are still shared.
 */
export function shareSummaryHidden(project, trim = null) {
  if (!summaryHasText(project?.summary)) return false;
  const { start, end } = shareTrim(project, trim);
  return clipToTrim(project, start, end).cut;
}

function cleanList(list, max = 20) {
  return (Array.isArray(list) ? list : []).map((s) => oneLine(s, 500)).filter(Boolean).slice(0, max);
}

/** Title / description / summary / transcript / caption style — everything but the pixels. */
function buildMeta(project, trim = null) {
  const { start, end } = shareTrim(project, trim);
  const duration = Math.max(0, end - start);
  const clipped = clipToTrim(project, start, end);
  const s = project?.summary && typeof project.summary === 'object' ? project.summary : null;
  // The summary was written from the whole recording: when the trim removes speech, its text
  // may repeat what the owner cut, so only the (re-timed, clipped) chapters are shared.
  const hideText = clipped.cut;
  const summary = s
    ? {
        title: hideText ? '' : oneLine(s.title, 200),
        tldr: hideText ? '' : String(s.tldr ?? '').trim().slice(0, 2000),
        key_points: hideText ? [] : cleanList(s.key_points),
        action_items: hideText ? [] : cleanList(s.action_items),
        chapters: shiftChapters(s.chapters, start, duration),
        source: s.source === 'ai' ? 'ai' : 'local',
        model: typeof s.model === 'string' ? s.model : null,
        generatedAt: num(s.generatedAt, 0) || null,
      }
    : null;
  const c = project?.edit?.captions || {};
  return {
    title: oneLine(project?.title, 140) || 'Untitled recording',
    description: oneLine(summary?.tldr, 500), // the same gated TL;DR (it also feeds og:description)
    summary,
    transcript: clipped.segments,
    captions: {
      enabled: Boolean(c.enabled),
      style: typeof c.style === 'string' ? c.style : 'minimal',
      position: typeof c.position === 'string' ? c.position : 'bottom',
      size: typeof c.size === 'string' ? c.size : 'M',
    },
    duration: r3(duration),
  };
}

/** Output size of the shared video + the camera bubble box in output px (for caption placement). */
export function shareLayout(project) {
  const { width, height } = getExportSize(project, SHARE_RESOLUTION);
  let camera = null;
  try {
    const box = computeLayout(project, width, height)?.camera;
    if (box) camera = { x: Math.round(box.x), y: Math.round(box.y), size: Math.round(box.size), shape: box.shape };
  } catch (err) {
    console.warn('[share] camera layout unavailable', err);
  }
  return { aspect: getAspect(project?.edit?.aspect).id, width, height, camera };
}

/** The viewer-facing name stored in this browser ('' when none). */
export function getOwnerName() {
  try {
    return oneLine(localStorage.getItem(OWNER_NAME_KEY), 60);
  } catch {
    return '';
  }
}

export function setOwnerName(name) {
  const value = oneLine(name, 60);
  try {
    if (value) localStorage.setItem(OWNER_NAME_KEY, value);
    else localStorage.removeItem(OWNER_NAME_KEY);
  } catch { /* storage unavailable */ }
  return value;
}

/**
 * Everything a link carries except its settings.
 * Times are moved to the shared video's timeline (0 = its first frame) and clipped to its length.
 * @param {object} project
 * @param {{ burnCaptions?: boolean, trim?: {start:number,end:number}|null }} [opts]
 *   trim — override the project's trim (the trim of the video that is live on the link)
 * @returns {{ title, description, ownerName, summary, transcript, captions, layout, duration }}
 */
export function buildSharePayload(project, { burnCaptions = false, trim = null } = {}) {
  const meta = buildMeta(project, trim);
  return {
    title: meta.title,
    description: meta.description,
    ownerName: getOwnerName(),
    summary: meta.summary,
    transcript: meta.transcript,
    captions: { ...(project?.edit?.captions || {}), ...meta.captions, burned: Boolean(burnCaptions) },
    layout: shareLayout(project),
    duration: meta.duration,
  };
}

/** Deterministic JSON: sorted keys, numbers rounded to 4 decimals. */
function stable(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1e4) / 1e4) : 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/** 64-bit (two 32-bit lanes) string hash → 16 hex chars. */
function hashString(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Changes whenever the rendered pixels or audio would: the source, every edit setting
 * (trim, zooms, aspect, fit, background, frame, camera) and — when captions are burned in —
 * the caption style and the transcript text/timing.
 */
export function videoHash(project, { burnCaptions = false } = {}) {
  const e = project?.edit || {};
  const { captions = {}, zooms = [], trim, ...rest } = e;
  const burn = Boolean(burnCaptions);
  return hashString(stable({
    v: 1,
    id: project?.id ?? null,
    mode: project?.mode ?? null,
    duration: num(project?.duration, 0),
    source: project?.source ?? null,
    edit: {
      ...rest,
      trim: shareTrim(project),
      zooms: (Array.isArray(zooms) ? zooms : []).map((z) => ({ start: z?.start, end: z?.end, scale: z?.scale, x: z?.x, y: z?.y })),
    },
    burn,
    captions: burn ? { enabled: Boolean(captions.enabled), style: captions.style, position: captions.position, size: captions.size } : null,
    transcript: burn && captions.enabled
      ? (Array.isArray(project?.transcript) ? project.transcript : []).map((s) => [s?.start, s?.end, oneLine(s?.text, 2000)])
      : null,
  }));
}

/**
 * Changes whenever the link's metadata would: title, summary, transcript, caption settings.
 * v2: transcripts/summaries leave out trimmed speech, so links shared before re-send once.
 */
export function metaHash(project) {
  const m = buildMeta(project);
  return hashString(stable({ v: 2, title: m.title, description: m.description, summary: m.summary, transcript: m.transcript, captions: m.captions }));
}

/**
 * The fields to PATCH so a link's metadata matches the project, built against the trim of the
 * video that is live on the link. Never includes layout/duration (those change with the video).
 */
export function shareMetaPatch(project, share = project?.share) {
  const meta = buildMeta(project, share?.trim || null);
  return {
    title: meta.title,
    description: meta.description,
    summary: meta.summary,
    transcript: meta.transcript,
    captions: { ...(project?.edit?.captions || {}), ...meta.captions, burned: Boolean(share?.burnCaptions) },
  };
}

/** The settings we keep locally (never the password itself). */
export function pickShareSettings(settings) {
  const s = settings || {};
  return {
    showSummary: s.showSummary !== false,
    showTranscript: s.showTranscript !== false,
    allowComments: s.allowComments !== false,
    allowDownload: Boolean(s.allowDownload),
    hasPassword: Boolean(s.hasPassword ?? s.password),
  };
}

/* ------------------------------------------------------------------ */
/* Persisting project.share                                            */
/* ------------------------------------------------------------------ */

const stores = new Map(); // projectId → the mounted editor's store

/**
 * Lets jobs persist link state through the mounted editor's store (so its autosave
 * never conflicts with a direct database write). Returns a detach function.
 */
export function attachShareStore(store) {
  const id = store?.project?.id;
  if (!id) return () => {};
  stores.set(id, store);
  return () => {
    if (stores.get(id) === store) stores.delete(id);
  };
}

/**
 * Replaces project.share (null removes it): through the mounted editor's store when there is
 * one (undo never touches it), otherwise straight to the database. Resolves true when saved
 * or queued for the editor's autosave.
 */
export async function setProjectShare(projectId, share) {
  const store = stores.get(projectId);
  if (store) {
    store.update((p) => { p.share = share; }, { history: false, reason: 'share' });
    if (!store.saveBlocked) return true;
  }
  try {
    await patchProject(projectId, { share });
    return true;
  } catch (err) {
    console.warn('[share] couldn’t save the link', err);
    return false;
  }
}

/**
 * Applies `mutate(share)` to the project's link (only while it is still link `shareId`):
 * through the mounted editor's store when there is one, otherwise straight to the database.
 */
export async function persistShare(projectId, shareId, mutate) {
  const store = stores.get(projectId);
  if (store) {
    if (store.project?.share?.id === shareId) {
      store.update((p) => { mutate(p.share); }, { history: false, reason: 'share' });
    }
    if (!store.saveBlocked) return;
  }
  try {
    const record = await getProject(projectId);
    if (!record?.share || record.share.id !== shareId) return;
    const next = { ...record.share };
    mutate(next);
    await patchProject(projectId, { share: next });
  } catch (err) {
    console.warn('[share] couldn’t save the link’s state', err);
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

const jobs = new Map();      // projectId → ShareJob (the latest; kept after it ends so a reopened dialog sees the outcome)
const listeners = new Map(); // projectId → Set<fn>

/**
 * Follow the share job of a project (current and future runs). `fn(state)` is called right
 * away when a job exists, then on every change:
 *   state = { projectId, shareId, phase: 'rendering'|'poster'|'uploading'|'done'|'error'|'cancelled',
 *             progress (0..1 within the phase), eta (seconds, rendering only), error (message|null),
 *             errorStatus (HTTP status|null), active, burnCaptions, ownerView (when done), startedAt, endedAt }
 * @returns {() => void} unsubscribe
 */
export function subscribe(projectId, fn) {
  if (!projectId || typeof fn !== 'function') return () => {};
  let set = listeners.get(projectId);
  if (!set) listeners.set(projectId, (set = new Set()));
  set.add(fn);
  const job = jobs.get(projectId);
  if (job) {
    try { fn(job.snapshot()); } catch (err) { console.error('[share] listener failed', err); }
  }
  return () => {
    const s = listeners.get(projectId);
    if (!s) return;
    s.delete(fn);
    if (!s.size) listeners.delete(projectId);
  };
}

/** The latest job state for a project, or null. */
export function getShareJob(projectId) {
  return jobs.get(projectId)?.snapshot() || null;
}

/** Cancels the project's running job (no-op when none). */
export function cancelShareJob(projectId) {
  const job = jobs.get(projectId);
  if (job?.active) job.cancel();
}

/** Forgets a finished job's outcome (e.g. after its link was deleted). */
export function clearShareJob(projectId) {
  const job = jobs.get(projectId);
  if (job && !job.active) jobs.delete(projectId);
}

/** The name of the Web Lock a tab holds while it renders/uploads for link `shareId`. */
export const shareJobLockName = (shareId) => `${LOCK_PREFIX}${shareId}`;

/**
 * Resolves true when some tab (this one included) is running a share job for link `shareId`,
 * judged by its Web Lock; false when none is, or when this browser has no Web Locks.
 */
export async function shareJobLockHeld(shareId) {
  try {
    const q = await navigator.locks?.query?.();
    const name = shareJobLockName(shareId);
    return Boolean(q?.held?.some((l) => l.name === name));
  } catch {
    return false;
  }
}

/**
 * Renders the project at 1080p (MP4 when this browser can, else WebM), extracts a poster
 * frame and uploads both to the project's existing link (project.share must be set).
 * One job per project id: while one runs for the same link, this returns the running job;
 * one still running for another link (deleted or replaced meanwhile) is cancelled.
 * @param {object} project
 * @param {{ mainBlob: Blob, cameraBlob?: Blob|null, burnCaptions?: boolean, onState?: (state) => void }} opts
 * @returns {{ cancel: () => void, done: Promise<object>, readonly state: object }}
 */
export function runShareJob(project, { mainBlob, cameraBlob = null, burnCaptions = false, onState } = {}) {
  if (!project?.id || !project.edit) throw new TypeError('runShareJob: a project is required');
  const share = project.share;
  if (!share?.id || !share.ownerToken) throw new TypeError('runShareJob: the project has no share link yet');
  const running = jobs.get(project.id);
  if (running?.active) {
    if (running.share.id === share.id) {
      if (typeof onState === 'function') running.own.add(onState);
      return running.handle;
    }
    running.cancel(); // its link is gone or replaced: render for the new link instead
  }
  const job = new ShareJob({ project, mainBlob, cameraBlob, burnCaptions, onState });
  jobs.set(project.id, job);
  job.start();
  return job.handle;
}

let unloadGuarded = false;
function onBeforeUnload(e) {
  if (![...jobs.values()].some((j) => j.active)) return;
  e.preventDefault();
  e.returnValue = ''; // older Chromium builds need this to show the prompt
}
function syncUnloadGuard() {
  if (typeof window === 'undefined') return;
  const any = [...jobs.values()].some((j) => j.active);
  if (any && !unloadGuarded) window.addEventListener('beforeunload', onBeforeUnload);
  else if (!any && unloadGuarded) window.removeEventListener('beforeunload', onBeforeUnload);
  unloadGuarded = any;
}

function abortError() {
  try {
    return new DOMException('Sharing cancelled', 'AbortError');
  } catch {
    return Object.assign(new Error('Sharing cancelled'), { name: 'AbortError' });
  }
}

class ShareJob {
  constructor({ project, mainBlob, cameraBlob, burnCaptions, onState }) {
    this.projectId = project.id;
    this.project = deepClone(project); // what gets rendered, even if the edit changes meanwhile
    this.share = { id: project.share.id, ownerToken: project.share.ownerToken, version: num(project.share.version, 0) };
    // Trim start of the video live on the link now: lets the server re-time comments when this
    // upload changes it (a fallback for links whose server meta has no sourceStart yet).
    const prevStart = num(project.share.trim?.start, NaN);
    this.prevStart = Number.isFinite(prevStart) ? r3(prevStart) : null;
    this.mainBlob = mainBlob;
    this.cameraBlob = cameraBlob || null;
    this.burn = Boolean(burnCaptions);
    this.ctrl = new AbortController();
    this.own = new Set(typeof onState === 'function' ? [onState] : []);
    this.state = {
      phase: 'rendering', progress: 0, eta: null, error: null, errorStatus: null,
      ownerView: null, startedAt: Date.now(), endedAt: null,
    };
    this.lastEmit = 0;
    this.emitTimer = 0;
    const job = this;
    this.handle = {
      cancel: () => job.cancel(),
      done: null,
      get state() { return job.snapshot(); },
    };
  }

  get active() { return ACTIVE.has(this.state.phase); }

  snapshot() {
    return Object.freeze({
      projectId: this.projectId,
      shareId: this.share.id,
      burnCaptions: this.burn,
      active: this.active,
      ...this.state,
    });
  }

  start() {
    syncUnloadGuard();
    this.emit();
    this.handle.done = this.run().then(() => this.snapshot());
    // Other tabs see a job for this link through its Web Lock (released when the job ends or
    // the tab closes), so they don't offer an upload that would supersede this one.
    try {
      navigator.locks?.request?.(shareJobLockName(this.share.id), { mode: 'shared' }, () => this.handle.done.catch(() => {}))
        ?.catch?.(() => {});
    } catch { /* Web Locks unavailable */ }
  }

  cancel() {
    if (this.active) this.ctrl.abort();
  }

  set(patch, force = false) {
    const phaseChanged = patch.phase && patch.phase !== this.state.phase;
    Object.assign(this.state, patch);
    const now = Date.now();
    if (force || phaseChanged || now - this.lastEmit >= EMIT_EVERY_MS) {
      this.emit();
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => { this.emitTimer = 0; this.emit(); }, EMIT_EVERY_MS - (now - this.lastEmit));
    }
  }

  emit() {
    clearTimeout(this.emitTimer);
    this.emitTimer = 0;
    this.lastEmit = Date.now();
    const snap = this.snapshot();
    // Project subscribers only hear the project's current job (a superseded job's late
    // 'cancelled' must not hide the progress of the job that replaced it).
    const current = jobs.get(this.projectId) === this;
    const fns = [...this.own, ...(current ? (listeners.get(this.projectId) || []) : [])];
    for (const fn of fns) {
      try { fn(snap); } catch (err) { console.error('[share] listener failed', err); }
    }
  }

  async run() {
    const { project: p, share, ctrl } = this;
    const signal = ctrl.signal;
    const trim = shareTrim(p);
    const vHash = videoHash(p, { burnCaptions: this.burn });
    const mHash = metaHash(p);
    const payload = buildSharePayload(p, { burnCaptions: this.burn });
    const { ownerName, ...fields } = payload; // the owner name is managed by the dialog
    let startedVersion = null; // the upload version this job started (video/fail only touches that one)
    try {
      const formats = supportedFormats();
      if (!formats.length) throw new Error('Sharing needs a browser that can render video, like Chrome, Edge or Arc.');
      const format = (formats.find((f) => f.id === 'mp4') || formats[0]).id;

      // 1. Render (real time).
      const result = await exportVideo({
        project: p,
        mainBlob: this.mainBlob,
        cameraBlob: this.cameraBlob,
        format,
        resolution: SHARE_RESOLUTION,
        showCaptions: this.burn,
        signal,
        onProgress: (fraction, eta) => this.set({ progress: clamp(num(fraction, 0), 0, 1), eta: Number.isFinite(eta) ? eta : null }),
      });
      if (signal.aborted) throw abortError();
      const size = getExportSize(p, SHARE_RESOLUTION);

      // 2. Poster (non-fatal). A brand-new link gets it right away so the "processing" page
      //    has a picture; an update sends it once the new video is live.
      this.set({ phase: 'poster', progress: 0, eta: null });
      const poster = await extractPoster(result.blob, payload.duration, signal);
      if (signal.aborted) throw abortError();
      let posterSent = false;
      if (poster && !(share.version > 0)) posterSent = await this.sendPoster(poster, signal);

      // 3. Upload (resumable).
      this.set({ phase: 'uploading', progress: 0 });
      const uploaded = await uploadVideo(share.id, share.ownerToken, result.blob, {
        mimeType: result.blob.type || result.mimeType,
        width: size.width,
        height: size.height,
        duration: payload.duration,
        sourceStart: trim.start,
        prevSourceStart: this.prevStart,
      }, {
        signal,
        onStart: (version) => { startedVersion = version; },
        onProgress: (fraction) => this.set({ progress: fraction }),
      });

      // 4. The new video is live: bring the metadata (burned captions, shifted transcript, layout,
      //    duration) in line right away, before the poster, retried like the upload. If it still
      //    fails, the link is marked out of date (metaHash null + this video's layout/duration in
      //    pendingMeta) and the dialog re-sends it.
      let view = uploaded;
      let metaSynced = false;
      try {
        view = (await withRetry(() => updateShare(share.id, share.ownerToken, fields, { signal }), signal)) || uploaded;
        metaSynced = true;
      } catch (err) {
        console.warn('[share] metadata update after upload failed; it is retried when the dialog opens', err);
      }
      if (poster && !posterSent) await this.sendPoster(poster, signal);

      await persistShare(this.projectId, share.id, (s) => {
        s.version = num(view?.version, s.version || 0);
        s.videoHash = vHash;
        s.burnCaptions = this.burn;
        s.trim = trim;
        if (metaSynced) {
          s.metaHash = mHash;
          delete s.pendingMeta;
        } else {
          s.metaHash = null;
          s.pendingMeta = { layout: fields.layout, duration: fields.duration };
        }
        if (view?.settings) s.settings = pickShareSettings(view.settings);
      });
      this.finish({ phase: 'done', progress: 1, ownerView: view || null });
    } catch (err) {
      const cancelled = signal.aborted;
      const status = Number.isFinite(err?.status) ? err.status : null;
      const message = cancelled ? null : (err?.message || 'Something went wrong while sharing.');
      if (!cancelled) console.warn('[share] job failed', err);
      // Tell the server unless the link itself is gone or no longer ours, or a newer upload
      // (410: another tab pressed "Update video") took over — failing would cancel that one.
      // Only the upload this job started is dropped (none started → nothing in flight is touched).
      // A cancel is reported as such, so a brand-new link stays 'processing' ("not uploaded yet")
      // instead of telling viewers it failed; one before any upload started changes nothing.
      const report = cancelled ? startedVersion !== null : status !== 404 && status !== 401 && status !== 403 && status !== 410;
      if (report) {
        failVideo(share.id, share.ownerToken, cancelled ? 'Cancelled' : message, { version: startedVersion, cancelled }).catch(() => {});
      }
      this.finish({ phase: cancelled ? 'cancelled' : 'error', error: message, errorStatus: cancelled ? null : status });
    }
  }

  async sendPoster(poster, signal) {
    try {
      await uploadPoster(this.share.id, this.share.ownerToken, poster, { signal });
      return true;
    } catch (err) {
      if (!signal.aborted) console.warn('[share] poster upload failed (the link works without it)', err);
      return false;
    }
  }

  finish(patch) {
    this.set({ ...patch, eta: null, endedAt: Date.now() }, true);
    this.mainBlob = null;
    this.cameraBlob = null;
    syncUnloadGuard();
  }
}

/* ------------------------------------------------------------------ */
/* Poster                                                              */
/* ------------------------------------------------------------------ */

function releaseVideo(video) {
  if (!video) return;
  const url = video.currentSrc || video.src || '';
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* already released */ }
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b && b.size ? b : null), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * A ~1280px-wide JPEG of the rendered video about 10% in (at least ~1 s when it's long
 * enough). Resolves null instead of failing — the link works without a poster.
 */
export function extractPoster(blob, duration, signal = null) {
  if (typeof document === 'undefined' || !blob) return Promise.resolve(null);
  const work = (async () => {
    const video = await loadVideo(blob, { muted: true, knownDuration: duration > 0 ? duration : undefined });
    try {
      const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Math.max(0, num(duration, 0));
      const t = clamp(d * 0.1, Math.min(1, d / 2), Math.max(0, d - 0.05));
      await seekVideo(video, t);
      if (video.readyState < 2) {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); video.removeEventListener('loadeddata', done); resolve(); };
          const timer = setTimeout(done, 2000);
          video.addEventListener('loadeddata', done);
        });
      }
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const width = Math.min(POSTER_WIDTH, vw);
      const height = Math.max(2, Math.round((width * vh) / vw));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(video, 0, 0, width, height);
      const jpeg = await canvasToJpeg(canvas, 0.86);
      canvas.width = 0;
      canvas.height = 0;
      return jpeg;
    } finally {
      releaseVideo(video);
    }
  })().catch((err) => {
    console.warn('[share] poster frame unavailable', err);
    return null;
  });

  let timer = 0;
  let onAbort = null;
  const giveUp = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), POSTER_TIMEOUT_MS);
    if (signal) {
      onAbort = () => resolve(null);
      if (signal.aborted) resolve(null);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([work, giveUp]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}
