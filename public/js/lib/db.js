// IndexedDB persistence. Three stores:
//   projects : Project objects (see project.js), keyPath "id"
//   media    : Blobs keyed by mediaKey(projectId, kind) where kind is "main" | "camera"
//   pending  : crash backup of takes still being recorded (recorder/recovery.js), keyed
//              [takeId, kind, seq]: kind 'main' | 'camera' chunks (seq from 0), plus
//              [takeId, 'meta', 0] and [takeId, 'transcript', 0]
//
// New projects that come with media are written with createProjectWithMedia (one
// transaction), so media never exists without its project; sweepOrphanMedia relies on that.
//
// Writes that commit are announced to other tabs on BroadcastChannel('dolly') as
// { type: 'saved' | 'deleted', id, updatedAt? }; subscribe with onProjectChange().
// The same message is dispatched in this tab as a window CustomEvent
// 'dolly:projects-changed' (event.detail = message).

const DB_NAME = 'dolly';
// v1: projects + media. v2: + pending (upgrade only adds the store; existing data is kept).
const DB_VERSION = 2;
let dbPromise = null;

/** Drops the cached connection promise `p` (only if it is still the current one). */
function forget(p) {
  if (dbPromise === p) dbPromise = null;
}

/** Tells this tab's UI (main.js) that opening the database waits on / no longer waits on another tab. */
function notify(type) {
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent(type));
  } catch { /* non-window context */ }
}

function open() {
  if (dbPromise) return dbPromise;
  let blocked = false;
  const p = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Additive only: every step checks what exists, so upgrading from any older
    // version (or a fresh install) never touches stored projects or media.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        const store = db.createObjectStore('projects', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending');
    };
    req.onsuccess = () => {
      const db = req.result;
      // The browser force-closed the connection (site data cleared, eviction…):
      // the next call opens a fresh one instead of failing forever.
      db.onclose = () => forget(p);
      // Let a newer version (another tab) or a deleteDatabase go ahead.
      db.onversionchange = () => { db.close(); forget(p); };
      if (blocked) notify('dolly:db-unblocked');
      resolve(db);
    };
    req.onerror = () => {
      if (blocked) notify('dolly:db-unblocked');
      reject(req.error);
    };
    // 'blocked' is not a failure: the request stays pending and succeeds once the
    // other tabs close their connections (current tabs do so on 'versionchange'; a tab
    // still running an older Dolly may not, until it is closed or reloaded).
    req.onblocked = () => {
      console.warn('[db] open blocked by another Dolly tab');
      if (!blocked) notify('dolly:db-blocked');
      blocked = true;
    };
  });
  dbPromise = p;
  // A failed open is not cached, so "Try again" gets a fresh attempt.
  p.catch(() => forget(p));
  return p;
}

/**
 * Opens a transaction over `names` (string or array). Retries once with a fresh
 * connection if the cached one turned out to be closing/closed.
 */
async function begin(names, mode) {
  for (let attempt = 0; ; attempt++) {
    const p = open();
    const db = await p;
    try {
      return db.transaction(names, mode);
    } catch (err) {
      if (attempt === 0 && err?.name === 'InvalidStateError') {
        forget(p);
        continue;
      }
      throw err;
    }
  }
}

/** Resolves on commit; rejects with `failure()` (or the transaction error) on abort/error. */
function settle(t, value, failure = () => null) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(typeof value === 'function' ? value() : value);
    // A failed request bubbles 'error' before the transaction aborts (t.error is
    // still null then), so prefer the request's own error.
    t.onerror = (e) => reject(failure() || e?.target?.error || t.error || new Error('Transaction failed'));
    t.onabort = () => reject(failure() || t.error || new Error('Transaction aborted'));
  });
}

function tx(storeName, mode, fn) {
  return begin(storeName, mode).then((t) => new Promise((resolve, reject) => {
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = (e) => reject(e?.target?.error || t.error || new Error('Transaction failed'));
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  }));
}

/* ---------------------------------------------------------------- */
/* Cross-tab change notifications                                    */
/* ---------------------------------------------------------------- */

let channel;
const changeListeners = new Set();

function getChannel() {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel('dolly');
      // Messages posted from this same channel object are never delivered back to
      // it, so listeners only hear about writes made in other tabs/windows.
      channel.onmessage = (e) => {
        const msg = e.data;
        if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return;
        changeListeners.forEach((fn) => { try { fn(msg); } catch (err) { console.error(err); } });
      };
    }
  } catch { channel = null; }
  return channel;
}

function announce(msg) {
  try { getChannel()?.postMessage(msg); } catch { /* best effort */ }
  // A channel never hears its own messages, so tell this tab's views directly.
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('dolly:projects-changed', { detail: msg }));
    }
  } catch { /* non-window context */ }
}

/**
 * Listen for project writes committed in OTHER tabs. (Writes made in this tab are
 * dispatched as the window event 'dolly:projects-changed' instead.)
 * @param {(msg: { type: 'saved' | 'deleted', id: string, updatedAt?: number }) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onProjectChange(fn) {
  getChannel();
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/* ---------------------------------------------------------------- */
/* Projects                                                          */
/* ---------------------------------------------------------------- */

export const mediaKey = (projectId, kind) => `${projectId}:${kind}`;

/** All projects, newest first. */
export async function listProjects() {
  const all = await tx('projects', 'readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getProject(id) {
  return tx('projects', 'readonly', (s) => s.get(id));
}

/**
 * Cheap change check: every project's `id:updatedAt`, sorted and joined with '|',
 * read from the updatedAt index without loading any project record.
 * @returns {Promise<string>}
 */
export async function listProjectStamps() {
  const t = await begin('projects', 'readonly');
  const out = [];
  const req = t.objectStore('projects').index('updatedAt').openKeyCursor();
  req.onsuccess = () => {
    const c = req.result;
    if (!c) return;
    out.push(`${c.primaryKey}:${c.key}`);
    c.continue();
  };
  return settle(t, () => out.sort().join('|'));
}

/**
 * Insert or replace, unconditionally. Sets updatedAt automatically. Returns the
 * saved project. Use for creating new projects without media; a new project that
 * comes with its video goes through createProjectWithMedia. Edits to an existing
 * project go through updateProject / patchProject so they can't clobber other tabs' writes.
 */
export async function saveProject(project) {
  project.updatedAt = Date.now();
  await tx('projects', 'readwrite', (s) => s.put(project));
  announce({ type: 'saved', id: project.id, updatedAt: project.updatedAt });
  return project;
}

/**
 * Guarded replace of an existing project, in one readwrite transaction.
 * Writes only if the stored record still exists and its updatedAt equals
 * `baseUpdatedAt` (the version this copy was loaded from / last saved as).
 * Does not mutate `project`. Resolves with the new updatedAt stamp.
 * Rejects with an Error named 'NotFoundError' (record deleted) or
 * 'ConflictError' (changed elsewhere; `err.current` is the stored record).
 */
export async function updateProject(project, baseUpdatedAt) {
  const t = await begin('projects', 'readwrite');
  const s = t.objectStore('projects');
  const stamp = Math.max(Date.now(), (baseUpdatedAt || 0) + 1);
  let fail = null;
  const g = s.get(project.id);
  g.onsuccess = () => {
    const cur = g.result;
    if (!cur) {
      fail = Object.assign(new Error('This recording was deleted'), { name: 'NotFoundError' });
      t.abort();
      return;
    }
    if ((cur.updatedAt || 0) !== (baseUpdatedAt || 0)) {
      fail = Object.assign(new Error('This recording was changed elsewhere'), { name: 'ConflictError', current: cur });
      t.abort();
      return;
    }
    s.put({ ...project, updatedAt: stamp });
  };
  await settle(t, null, () => fail);
  announce({ type: 'saved', id: project.id, updatedAt: stamp });
  return stamp;
}

/**
 * get → Object.assign(record, patch) → put, in one readwrite transaction, bumping
 * updatedAt. Resolves with the saved record; rejects with an Error named
 * 'NotFoundError' if the project no longer exists.
 */
export async function patchProject(id, patch) {
  const t = await begin('projects', 'readwrite');
  const s = t.objectStore('projects');
  let fail = null;
  let saved = null;
  const g = s.get(id);
  g.onsuccess = () => {
    const cur = g.result;
    if (!cur) {
      fail = Object.assign(new Error('This recording was deleted'), { name: 'NotFoundError' });
      t.abort();
      return;
    }
    saved = Object.assign(cur, patch, { id, updatedAt: Math.max(Date.now(), (cur.updatedAt || 0) + 1) });
    s.put(saved);
  };
  await settle(t, null, () => fail);
  announce({ type: 'saved', id, updatedAt: saved.updatedAt });
  return saved;
}

/**
 * Creates a new project together with its media in ONE transaction: either the
 * project and its blobs are all stored, or nothing is (no orphaned multi-GB blobs
 * when a tab closes mid-save). Sets updatedAt. Rejects with a 'ConstraintError'
 * if a project with this id already exists. Resolves with the project.
 * @param {object} project
 * @param {{ main: Blob, camera?: Blob|null }} media
 */
export async function createProjectWithMedia(project, { main, camera = null } = {}) {
  if (!main) throw new TypeError('createProjectWithMedia: the main video is required');
  project.updatedAt = Date.now();
  const t = await begin(['projects', 'media'], 'readwrite');
  // All requests are queued in this same tick, before anything is awaited.
  const media = t.objectStore('media');
  media.put(main, mediaKey(project.id, 'main'));
  if (camera) media.put(camera, mediaKey(project.id, 'camera'));
  t.objectStore('projects').add(project);
  await settle(t);
  announce({ type: 'saved', id: project.id, updatedAt: project.updatedAt });
  return project;
}

/**
 * Deletes media whose project no longer exists (left behind by older, multi-step
 * saves that were interrupted). Safe while other tabs work because every media
 * write for a new project is atomic with the project (createProjectWithMedia), and
 * this runs in one readwrite transaction over both stores. Resolves with the number
 * of blobs removed.
 */
export async function sweepOrphanMedia() {
  const t = await begin(['projects', 'media'], 'readwrite');
  const media = t.objectStore('media');
  const ids = t.objectStore('projects').getAllKeys();
  const keys = media.getAllKeys();
  let removed = 0;
  // Requests in one transaction complete in order, so `ids` is ready here.
  keys.onsuccess = () => {
    const live = new Set(ids.result || []);
    for (const key of keys.result || []) {
      const s = String(key);
      const i = s.lastIndexOf(':');
      if (live.has(i > 0 ? s.slice(0, i) : s)) continue;
      media.delete(key);
      removed++;
    }
  };
  return settle(t, () => removed);
}

/** Deletes a project and all of its media atomically (one transaction). */
export async function deleteProject(id) {
  const t = await begin(['projects', 'media'], 'readwrite');
  t.objectStore('projects').delete(id);
  const media = t.objectStore('media');
  media.delete(mediaKey(id, 'main'));
  media.delete(mediaKey(id, 'camera'));
  await settle(t);
  announce({ type: 'deleted', id });
}

/**
 * Stores (or replaces) one blob of an EXISTING project. Not for new projects: media
 * written before its project exists counts as orphaned and is removed by
 * sweepOrphanMedia; use createProjectWithMedia instead.
 */
export function putMedia(projectId, kind, blob) {
  return tx('media', 'readwrite', (s) => s.put(blob, mediaKey(projectId, kind)));
}

/** Returns the Blob or undefined. */
export function getMedia(projectId, kind) {
  return tx('media', 'readonly', (s) => s.get(mediaKey(projectId, kind)));
}

/* ---------------------------------------------------------------- */
/* Pending takes (crash backup while recording; see recorder/recovery.js) */
/* ---------------------------------------------------------------- */

const pendingRange = (takeId, kind) => IDBKeyRange.bound([takeId, kind, 0], [takeId, kind, Infinity]);

/** Stores one record of a take's backup at key [takeId, kind, seq]. */
export function putPending(takeId, kind, seq, value) {
  return tx('pending', 'readwrite', (s) => s.put(value, [takeId, kind, seq]));
}

/**
 * Every take with a backup: `{ id, meta, kinds }` where `meta` is the record at
 * [id, 'meta', 0] (or null) and `kinds` counts the other records per kind
 * (e.g. { main: 42, camera: 42, transcript: 1 }). Blobs are not read.
 */
export async function listPendingTakes() {
  const t = await begin('pending', 'readonly');
  const s = t.objectStore('pending');
  const byId = new Map();
  const req = s.getAllKeys();
  req.onsuccess = () => {
    for (const key of req.result || []) {
      if (!Array.isArray(key) || typeof key[0] !== 'string') continue;
      const [id, kind] = key;
      let take = byId.get(id);
      if (!take) {
        take = { id, meta: null, kinds: {} };
        byId.set(id, take);
      }
      if (kind === 'meta') {
        const g = s.get(key);
        g.onsuccess = () => { take.meta = g.result ?? null; };
      } else {
        take.kinds[kind] = (take.kinds[kind] || 0) + 1;
      }
    }
  };
  return settle(t, () => [...byId.values()]);
}

/**
 * The take's records of `kind` in seq order, stopping at the first gap (chunks
 * after a missing one can't be decoded). [] when there are none.
 */
export async function getPendingChunks(takeId, kind) {
  const t = await begin('pending', 'readonly');
  const s = t.objectStore('pending');
  const range = pendingRange(takeId, kind);
  const k = s.getAllKeys(range);
  const v = s.getAll(range);
  return settle(t, () => {
    const keys = k.result || [];
    const values = v.result || [];
    const out = [];
    for (let i = 0; i < keys.length && keys[i][2] === i; i++) out.push(values[i]);
    return out;
  });
}

/** Deletes everything stored for a take. */
export function clearPending(takeId) {
  // [takeId] sorts before and [takeId, []] after every [takeId, kind, seq] key.
  return tx('pending', 'readwrite', (s) => s.delete(IDBKeyRange.bound([takeId], [takeId, []])));
}

/** Rough storage usage, if the browser supports it. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
