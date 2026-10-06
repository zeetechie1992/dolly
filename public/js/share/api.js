// Viewer-side client for the public share API (the app/owner client is lib/share-api.js).
// Errors: rejects with an Error carrying `.status` (0 = network failure) and `.data` (the JSON body).
// Password-protected shares: the access token from /unlock is kept per share id and sent as X-Share-Access.

const ACCESS_PREFIX = 'dolly.share.access.';

function storageGet(kind, key) {
  try { return window[kind].getItem(key); } catch { return null; }
}
function storageSet(kind, key, value) {
  try {
    if (value == null) window[kind].removeItem(key);
    else window[kind].setItem(key, value);
  } catch { /* storage unavailable (private mode, sandboxed iframe) */ }
}

// In-memory fallback so an unlocked share keeps working when storage is blocked (e.g. third-party iframes).
const memoryAccess = new Map();

export function getAccess(id) {
  return memoryAccess.get(id) || storageGet('sessionStorage', ACCESS_PREFIX + id) || storageGet('localStorage', ACCESS_PREFIX + id) || null;
}

export function setAccess(id, token) {
  if (!token) return clearAccess(id);
  memoryAccess.set(id, token);
  storageSet('localStorage', ACCESS_PREFIX + id, token);
}

export function clearAccess(id) {
  memoryAccess.delete(id);
  storageSet('sessionStorage', ACCESS_PREFIX + id, null);
  storageSet('localStorage', ACCESS_PREFIX + id, null);
}

/**
 * One JSON request. `headers` adds request headers; `meta` (an object) receives the response's
 * `status` and `etag`. A 304 (only possible when the caller sent If-None-Match) resolves null.
 */
async function request(id, path = '', { method = 'GET', body, signal, headers: extra, meta } = {}) {
  const headers = { Accept: 'application/json' };
  const access = getAccess(id);
  if (access) headers['X-Share-Access'] = access;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (extra) Object.assign(headers, extra);
  let res;
  try {
    res = await fetch(`/api/shares/${encodeURIComponent(id)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const e = new Error('Network error');
    e.status = 0;
    e.data = {};
    throw e;
  }
  if (meta) {
    meta.status = res.status;
    meta.etag = res.headers.get('ETag');
  }
  if (res.status === 304) return null; // before the !res.ok check: 304 isn't "ok"
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { data = null; }
  }
  if (!res.ok) {
    const e = new Error((data && typeof data.error === 'string' && data.error) || `Request failed (${res.status})`);
    e.status = res.status;
    e.data = data && typeof data === 'object' ? data : {};
    throw e;
  }
  return data;
}

/** GET /api/shares/:id → PublicView. 401 { passwordRequired } / 404. */
export const fetchShare = (id, opts) => request(id, '', opts);

/** POST /unlock → stores and returns the access token. 403 on a wrong password. */
export async function unlockShare(id, password) {
  const data = await request(id, '/unlock', { method: 'POST', body: { password } });
  if (data?.access) setAccess(id, data.access);
  return data?.access || null;
}

/** POST /view → { views }. */
export const recordView = (id, viewerId) => request(id, '/view', { method: 'POST', body: { viewerId } });

const commentTags = new Map(); // share id → ETag of the last comment list we received

/**
 * GET /comments → Comment[] (sorted by createdAt), or null when the list hasn't changed since
 * the last call (the server answers our If-None-Match with a bodiless 304).
 * `fresh: true` skips that check and always returns the list (e.g. after local state was reset).
 */
export async function listComments(id, { fresh = false, ...opts } = {}) {
  const tag = fresh ? null : commentTags.get(id);
  const meta = {};
  const data = await request(id, '/comments', { ...opts, headers: tag ? { 'If-None-Match': tag } : undefined, meta });
  if (meta.status === 304) return null;
  if (meta.etag) commentTags.set(id, meta.etag);
  else commentTags.delete(id);
  return Array.isArray(data?.comments) ? data.comments : [];
}

/** POST /comments { kind, name, text, emoji, time } → Comment. 403 when off, 429 when rate limited. */
export const postComment = (id, payload) => request(id, '/comments', { method: 'POST', body: payload });
