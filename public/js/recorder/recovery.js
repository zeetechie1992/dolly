// Crash safety for recordings. While a take records, every chunk the Recorder produces is copied
// to IndexedDB (the "pending" store in lib/db.js), so a renderer crash, a force-quit, a power cut
// or a closed window still leaves a playable prefix of the take that can go into the library.
//
//   const backup = startTakeBackup({ mode });      // null when this browser can't (no-op then)
//   recorder.onChunk = backup.write;               // set before recorder.start()
//   backup.writeTranscript(segments);              // whenever new final segments arrive
//   backup.clear();     // the take is safely in the library, or it was thrown away
//   backup.release();   // saving failed: keep the chunks and let recovery offer them later
//
//   const takes = await findInterruptedTakes();    // takes no tab is still recording or saving
//   const project = await recoverInterruptedTake(takes[0]);   // saved Project, or null
//   await discardInterruptedTake(takes[0]);
//
// A take holds the Web Lock 'dolly-take:<id>' for as long as a view owns it, so recovery never
// offers a take that is still recording (in any tab) or still being saved after the user left.
// Recovery and discard hold the same lock, so two tabs can't recover one take twice.

import * as db from '../lib/db.js';
import { uid, clamp } from '../lib/util.js';
import { createProject } from '../lib/project.js';
import { loadVideo, probeVideo, captureThumbnail } from '../lib/media.js';

const LOCK_PREFIX = 'dolly-take:';
const CHUNK_SECONDS = 1;          // the Recorder's timeslice: one chunk ≈ one recorded second
const BUSY = Symbol('busy');
const MODES = ['screen+cam', 'screen', 'cam'];

const lockManager = () => (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function'
  ? navigator.locks
  : null);

/** True when takes can be backed up while recording and recovered later. */
export function isRecoverySupported() {
  return Boolean(lockManager())
    && typeof db.putPending === 'function'
    && typeof db.clearPending === 'function'
    && typeof db.listPendingTakes === 'function'
    && typeof db.getPendingChunks === 'function'
    && typeof db.createProjectWithMedia === 'function';
}

/**
 * Starts backing up a new take. Writes never throw and never interrupt the recording: a failed
 * write (e.g. the disk is full) only stops the backup of that track.
 * @param {{ mode: 'screen+cam'|'screen'|'cam' }} o
 * @returns {null | { id: string, write: (kind: string, seq: number, blob: Blob) => void,
 *   writeTranscript: (segments: object[]) => void, clear: () => void, release: () => void }}
 */
export function startTakeBackup({ mode }) {
  if (!isRecoverySupported()) return null;
  const id = uid('r_');
  const inflight = new Set();
  const failed = new Set();
  let unlock = null;
  let released = false;
  let cleared = false;
  let warned = false;
  let transcriptCount = -1;

  const warn = (err) => {
    if (warned) return;
    warned = true;
    console.warn('[recovery] backing up the recording failed; it is still being recorded', err);
  };

  // Nothing is written before the lock is held, so no other view ever sees this take unlocked
  // while it is in use. (`unlock` is set before anything waiting on `locked` runs.)
  const locked = new Promise((resolve) => {
    lockManager().request(LOCK_PREFIX + id, () => {
      resolve(true);
      return new Promise((r) => { unlock = r; });
    }).catch((err) => {
      warn(err);
      resolve(false);
    });
  });

  // IndexedDB runs readwrite transactions on one store in the order they were created, so a
  // clear() issued after the last write always runs after it.
  const put = (kind, seq, value) => {
    const p = locked
      .then((ok) => (ok && !cleared ? db.putPending(id, kind, seq, value) : undefined))
      .catch((err) => {
        failed.add(kind);
        warn(err);
      });
    inflight.add(p);
    p.then(() => inflight.delete(p));
  };

  put('meta', 0, { mode, createdAt: Date.now() });

  const backup = {
    id,
    /** Recorder.onChunk. Later chunks are useless after a gap, so a failed track stops there. */
    write: (kind, seq, blob) => {
      if (cleared || released || failed.has(kind) || !blob) return;
      put(kind, seq, blob);
    },
    /** Keeps the live transcript with the take (one record, rewritten when segments are added). */
    writeTranscript: (segments) => {
      if (cleared || released || !Array.isArray(segments) || segments.length === transcriptCount) return;
      transcriptCount = segments.length;
      put('transcript', 0, segments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text })));
    },
    /** Saving failed: keep what was written and let recovery offer it once queued writes land. */
    release: () => {
      if (released) return;
      released = true;
      Promise.allSettled([locked, ...inflight]).then(() => {
        const fn = unlock;
        unlock = null;
        fn?.();
      });
    },
    /** The take is in the library or was thrown away: delete the backup, then let go of the lock. */
    clear: () => {
      if (cleared) return;
      cleared = true;
      const p = locked
        .then((ok) => (ok ? db.clearPending(id) : undefined))
        .catch(warn);
      inflight.add(p); // a release() in the meantime waits for the delete too
      p.then(() => {
        inflight.delete(p);
        backup.release();
      });
    },
  };
  return backup;
}

/**
 * Takes that were cut short and that no tab is recording or saving any more, newest first.
 * Leftovers without a playable start are deleted quietly. Never throws.
 * @returns {Promise<Array<{ id: string, mode: string|null, createdAt: number, seconds: number }>>}
 */
export async function findInterruptedTakes() {
  if (!isRecoverySupported()) return [];
  let listed = [];
  try {
    listed = (await db.listPendingTakes()) || [];
  } catch (err) {
    console.warn('[recovery] listing interrupted recordings failed', err);
    return [];
  }
  const found = [];
  for (const entry of listed) {
    const id = typeof entry === 'string' ? entry : entry?.id || entry?.takeId;
    if (!id) continue;
    let take = null;
    try {
      take = await withTakeLock(id, async () => {
        const chunks = await db.getPendingChunks(id, 'main');
        if (!chunks?.length) {
          await db.clearPending(id);
          return null;
        }
        const meta = await readMeta(id, entry);
        return {
          id,
          mode: MODES.includes(meta?.mode) ? meta.mode : null,
          createdAt: Number(meta?.createdAt) || 0,
          seconds: chunks.length * CHUNK_SECONDS,
        };
      });
    } catch (err) {
      console.warn('[recovery] checking an interrupted recording failed', err);
      take = null;
    }
    if (take && take !== BUSY) found.push(take);
  }
  return found.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Puts what was captured of an interrupted take into the library, then deletes the backup.
 * Resolves with the saved project, or null when another tab is handling the take or nothing
 * playable was captured. Rejects (and keeps the backup) when it can't be saved.
 */
export async function recoverInterruptedTake(take, { title = 'Recovered recording' } = {}) {
  if (!isRecoverySupported() || !take?.id) return null;
  const result = await withTakeLock(take.id, () => recover(take.id, title));
  return result === BUSY ? null : result;
}

/** Deletes an interrupted take's backup. Resolves false when another tab is handling it. */
export async function discardInterruptedTake(take) {
  if (!isRecoverySupported() || !take?.id) return false;
  const result = await withTakeLock(take.id, () => db.clearPending(take.id).then(() => true));
  return result === true;
}

async function recover(id, title) {
  const mainChunks = await db.getPendingChunks(id, 'main');
  if (!mainChunks?.length) {
    await db.clearPending(id);
    return null;
  }
  const meta = await readMeta(id);
  const transcript = await firstPending(id, 'transcript');

  const main = joinChunks(mainChunks);
  const approx = mainChunks.length * CHUNK_SECONDS;
  const info = await probeVideo(main, approx); // loadVideo fixes the Infinity duration of an unfinished WebM
  const duration = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : approx;

  let mode = MODES.includes(meta?.mode) ? meta.mode : null;
  let camera = null;
  let cameraBlob = null;
  if (mode !== 'cam' && mode !== 'screen') {
    const cameraChunks = await db.getPendingChunks(id, 'camera').catch(() => []);
    if (cameraChunks?.length) {
      try {
        cameraBlob = joinChunks(cameraChunks);
        const c = await probeVideo(cameraBlob, cameraChunks.length * CHUNK_SECONDS);
        if (c.width > 0 && c.height > 0) camera = { width: c.width, height: c.height };
      } catch {
        camera = null; // the screen matters more than the bubble
      }
    }
    mode = camera ? 'screen+cam' : 'screen';
  }

  const project = createProject({
    duration,
    mode,
    main: { width: info.width || 1920, height: info.height || 1080 },
    camera,
    transcript: cleanTranscript(Array.isArray(transcript) ? transcript : [], duration),
    title,
  });
  if (Number(meta?.createdAt) > 0) project.createdAt = Number(meta.createdAt);
  project.thumbnail = await makeThumbnail(main, duration);
  // One transaction: the project and its media are stored together or not at all (a failure
  // leaves nothing behind and keeps the backup for another try).
  await db.createProjectWithMedia(project, { main, camera: camera ? cameraBlob : null });
  try {
    await db.clearPending(id);
  } catch (err) {
    console.warn('[recovery] the recording was recovered, but its backup could not be deleted', err);
  }
  return project;
}

function withTakeLock(id, fn) {
  return lockManager().request(LOCK_PREFIX + id, { ifAvailable: true }, (lock) => (lock ? fn() : BUSY));
}

async function firstPending(id, kind) {
  try {
    const values = await db.getPendingChunks(id, kind);
    return values?.[0] ?? null;
  } catch {
    return null;
  }
}

async function readMeta(id, entry = null) {
  if (entry && typeof entry === 'object' && entry.meta) return entry.meta;
  return firstPending(id, 'meta');
}

function joinChunks(chunks) {
  const type = String(chunks[0]?.type || 'video/webm').split(';')[0].trim() || 'video/webm';
  return new Blob(chunks, { type });
}

/* -------------------------------------------------------------------- shared with record.js */

/** Sorted, clamped, non-empty transcript segments for a recording of `duration` seconds. */
export function cleanTranscript(segments, duration) {
  return (segments || [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => ({
      id: s.id || uid('s_'),
      start: clamp(Number(s.start) || 0, 0, duration),
      end: clamp(Number(s.end) || 0, 0, duration),
      text: s.text.trim(),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

/** 480×270 JPEG data URL of an early frame, or null. */
export async function makeThumbnail(blob, duration) {
  let video = null;
  try {
    video = await loadVideo(blob, { knownDuration: duration });
    return await captureThumbnail(video, Math.min(1, duration / 2));
  } catch {
    return null;
  } finally {
    if (video) {
      const src = video.src;
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
      if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
    }
  }
}
