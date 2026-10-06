// Thin client for Dolly's share API (see ARCHITECTURE.md → Sharing).
//
// Every call rejects with an Error carrying `.status` (the HTTP status; 0 when the server
// couldn't be reached or timed out) and `.data` (the parsed JSON error body, or null) on
// failure. Aborts (an AbortSignal the caller passed) reject with the AbortError untouched.
// Pure module: nothing here touches the DOM, so it also loads in a bare JS shell.

const ID_RE = /^[A-Za-z0-9]{6,16}$/;
const CHUNK_SIZE = 8 * 1024 * 1024;   // upload slice; the server accepts ≤ 16 MB per PUT
const MAX_ATTEMPTS = 4;               // first try + 3 retries
const RETRY_BASE_MS = 800;            // backoff 0.8 s → 1.6 s → 3.2 s (±20%)
const REQUEST_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 180_000;     // one 8 MB slice over a slow uplink
const COMPLETE_TIMEOUT_MS = 120_000;  // the server moves the finished file into place

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function apiError(message, status, data = null, extra = null) {
  const err = new Error(message);
  err.name = 'ShareApiError';
  err.status = status;
  err.data = data;
  if (extra) Object.assign(err, extra);
  return err;
}

function abortError() {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
  }
}

const isAbort = (err) => err?.name === 'AbortError';

/** Network failures, timeouts, server errors and rate limits are worth another try. */
function isRetryable(err) {
  const s = err?.status;
  return s === 0 || s === 408 || s === 429 || (s >= 500 && s !== 501 && s !== 505);
}

function defaultMessage(status) {
  if (status === 401 || status === 403) return 'You don’t have permission to do that.';
  if (status === 404) return 'This share link no longer exists.';
  if (status === 409) return 'The upload got out of sync. Try again.';
  if (status === 413) return 'This video is too large for the Dolly server.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return `The Dolly server ran into a problem (error ${status}).`;
  return `The request failed (error ${status}).`;
}

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

/** A child signal that aborts with `outer` or after `timeoutMs`. */
function linkSignal(outer, timeoutMs) {
  if (typeof AbortController !== 'function') {
    return { signal: outer || undefined, timedOut: () => false, dispose() {} };
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : 0;
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const backoff = (attempt) => RETRY_BASE_MS * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);

function sharePath(id) {
  const value = String(id ?? '');
  if (!ID_RE.test(value)) throw apiError('This share link id isn’t valid.', 400, null);
  return `/api/shares/${encodeURIComponent(value)}`;
}

/**
 * One JSON request. `json` is sent as application/json; `body` (Blob/ArrayBuffer) as-is
 * with `contentType`. Resolves with the parsed JSON body (null for 204 / empty bodies).
 */
async function request(method, path, { json, body, contentType, token, key, signal, timeout = REQUEST_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw abortError();
  if (typeof fetch !== 'function') throw apiError('This browser can’t talk to the Dolly server.', 0, null, { network: true });
  const headers = { Accept: 'application/json' };
  let payload = body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  } else if (payload !== undefined && contentType) {
    headers['Content-Type'] = contentType;
  }
  if (token) headers['X-Owner-Token'] = token;
  if (key) headers['X-Dolly-Key'] = key;

  const link = linkSignal(signal, timeout);
  const fail = (err) => {
    if (signal?.aborted) return abortError();
    if (link.timedOut()) return apiError('The Dolly server took too long to respond.', 0, null, { network: true, timeout: true });
    if (isAbort(err)) return err;
    return apiError('Couldn’t reach the Dolly server. Check that it’s running, then try again.', 0, null, { network: true, cause: err });
  };

  let res;
  let data = null;
  try {
    try {
      res = await fetch(path, { method, headers, body: payload, signal: link.signal, cache: 'no-store', credentials: 'same-origin' });
    } catch (err) {
      throw fail(err);
    }
    if (res.status !== 204) {
      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        throw fail(err);
      }
      if (text) {
        try { data = JSON.parse(text); } catch { data = null; }
      }
    }
  } finally {
    link.dispose();
  }

  if (!res.ok) {
    const info = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    const message = info && typeof info.error === 'string' && info.error.trim() ? info.error.trim() : defaultMessage(res.status);
    throw apiError(message, res.status, info);
  }
  return data;
}

/**
 * Runs `fn` until it succeeds, retrying retryable failures (network errors, timeouts, 408, 429,
 * 5xx) with exponential backoff. For requests that are safe to send again (e.g. a PATCH).
 */
export async function withRetry(fn, signal, attempts = MAX_ATTEMPTS) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw signal?.aborted ? abortError() : err;
      if (attempt >= attempts || !isRetryable(err)) throw err;
      await wait(backoff(attempt), signal);
    }
  }
}

/** The byte offset a 409 asks us to resume from, or null when the error isn't a resync. */
function expectedOffsetOf(err, size) {
  if (err?.status !== 409) return null;
  const raw = err.data?.expectedOffset;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(size, Math.floor(n));
}

function baseMimeType(type) {
  const base = String(type || '').split(';')[0].trim().toLowerCase();
  return base || 'video/mp4';
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

/** @returns {Promise<{ canCreate: boolean, keyRequired: boolean, publicBase: string, isLocalOnly: boolean }>} */
export async function getShareConfig({ signal } = {}) {
  return request('GET', '/api/share-config', { signal });
}

/**
 * Creates a link (status 'processing' until a video upload completes).
 * @param {object} payload { title, description, ownerName?, summary, transcript, captions, layout, duration, settings }
 * @param {{ key?: string, signal?: AbortSignal }} [opts] key → X-Dolly-Key (needed from non-loopback clients)
 * @returns {Promise<{ id: string, ownerToken: string, url: string, embedUrl: string, share: object }>}
 */
export async function createShare(payload, { key, signal } = {}) {
  return request('POST', '/api/shares', { json: payload, key: key || undefined, signal });
}

/** @returns {Promise<object>} OwnerView */
export async function getOwnerView(id, ownerToken, { signal } = {}) {
  return request('GET', `${sharePath(id)}/owner`, { token: ownerToken, signal });
}

/**
 * PATCH any of title, description, ownerName, summary, transcript, captions, layout, duration,
 * settings (settings merge; settings.password: string sets, null clears, omitted keeps).
 * @returns {Promise<object>} OwnerView
 */
export async function updateShare(id, ownerToken, patch, { signal } = {}) {
  return request('PATCH', sharePath(id), { json: patch || {}, token: ownerToken, signal });
}

/** Removes the link and everything stored for it. Resolves null (204). */
export async function deleteShare(id, ownerToken, { signal } = {}) {
  return request('DELETE', sharePath(id), { token: ownerToken, signal });
}

/**
 * Reports a render/upload that won't finish. `version` names the upload the caller started
 * (from uploadVideo's onStart); the server then drops only that upload, never one another tab
 * started. Without a version no upload in flight is touched. The link only turns 'failed'
 * when it has no earlier ready video, and never for `cancelled` (the owner stopped it: a new
 * link stays 'processing', which viewers see as "not uploaded yet").
 * @returns {Promise<object>} OwnerView
 */
export async function failVideo(id, ownerToken, error, { signal, version, cancelled = false } = {}) {
  const json = { error: String(error || 'Upload failed').slice(0, 500) };
  if (version !== undefined && version !== null) json.version = version;
  if (cancelled) json.cancelled = true;
  return request('POST', `${sharePath(id)}/video/fail`, { json, token: ownerToken, signal });
}

/** Uploads the poster frame (JPEG ≤ 5 MB). Resolves null (204). */
export async function uploadPoster(id, ownerToken, jpegBlob, { signal } = {}) {
  const path = `${sharePath(id)}/poster`;
  return withRetry(() => request('PUT', path, { body: jpegBlob, contentType: 'image/jpeg', token: ownerToken, signal, timeout: 60_000 }), signal, 2);
}

/**
 * Resumable chunked upload: start → 8 MB slices → complete. Each request is retried
 * (3 retries, exponential backoff) on network errors / 5xx / 429; a 409 with
 * `expectedOffset` resumes from the byte the server actually has. The previous ready
 * video stays live until `complete` succeeds.
 * @param {string} id
 * @param {string} ownerToken
 * @param {Blob} blob
 * @param {{ mimeType?: string, width?: number, height?: number, duration?: number,
 *          sourceStart?: number|null, prevSourceStart?: number|null }} meta
 *   sourceStart — where this video starts in the recording (its trim start, seconds);
 *   prevSourceStart — the same for the video live now. The server re-times timed comments by
 *   their difference when this upload completes.
 * @param {{ onProgress?: (fraction: number) => void, onStart?: (version) => void, signal?: AbortSignal }} [opts]
 *   onStart — called with the upload version once `video/start` succeeds (for failVideo)
 * @returns {Promise<object>} OwnerView after completion (status 'ready')
 */
export async function uploadVideo(id, ownerToken, blob, {
  mimeType, width, height, duration, sourceStart = null, prevSourceStart = null,
} = {}, { onProgress, onStart, signal } = {}) {
  const base = sharePath(id);
  const size = Number(blob?.size);
  if (!blob || typeof blob.slice !== 'function' || !(size > 0)) throw new TypeError('uploadVideo: the video is empty');
  if (signal?.aborted) throw abortError();

  let lastReported = -1;
  const report = (bytes) => {
    if (typeof onProgress !== 'function') return;
    const fraction = Math.max(0, Math.min(1, bytes / size));
    if (fraction === lastReported) return;
    lastReported = fraction;
    try { onProgress(fraction); } catch (err) { console.error('[share-api] onProgress failed', err); }
  };

  const started = await withRetry(() => request('POST', `${base}/video/start`, {
    json: { mimeType: baseMimeType(mimeType || blob.type), size, width, height, duration, sourceStart, prevSourceStart },
    token: ownerToken,
    signal,
  }), signal);
  const version = started?.version;
  if (version === undefined || version === null || version === '') {
    throw apiError('The Dolly server didn’t start the upload.', 502, started && typeof started === 'object' ? started : null);
  }
  if (typeof onStart === 'function') {
    try { onStart(version); } catch (err) { console.error('[share-api] onStart failed', err); }
  }
  const v = encodeURIComponent(String(version));
  let offset = Math.max(0, Math.min(size, Math.floor(Number(started.offset) || 0)));
  report(offset);

  // 409 resyncs can legitimately repeat (a retried slice the server already had), but
  // never more often than there are slices, plus some slack.
  const maxResyncs = 8 + Math.ceil(size / CHUNK_SIZE);
  let resyncs = 0;

  for (;;) {
    while (offset < size) {
      const at = offset;
      const end = Math.min(size, at + CHUNK_SIZE);
      let res;
      try {
        res = await withRetry(() => request('PUT', `${base}/video?version=${v}&offset=${at}`, {
          body: blob.slice(at, end),
          contentType: 'application/octet-stream',
          token: ownerToken,
          signal,
          timeout: CHUNK_TIMEOUT_MS,
        }), signal);
      } catch (err) {
        const expected = expectedOffsetOf(err, size);
        if (expected === null || ++resyncs > maxResyncs) throw err;
        offset = expected;
        report(offset);
        continue;
      }
      const received = Number(res?.received);
      offset = Number.isFinite(received) && received >= at && received <= size ? received : end;
      // A server that acknowledges nothing would loop forever.
      if (offset === at) {
        if (++resyncs > maxResyncs) throw apiError('The Dolly server isn’t accepting the upload.', 502, null);
        offset = end;
      }
      report(offset);
    }

    try {
      const view = await completeUpload();
      report(size);
      return view;
    } catch (err) {
      // The server is missing bytes (e.g. a slice it acknowledged was lost): resend from there.
      const expected = expectedOffsetOf(err, size);
      if (expected === null || expected >= size || ++resyncs > maxResyncs) throw err;
      offset = expected;
      report(offset);
    }
  }

  async function completeUpload() {
    let lostResponse = false;
    for (let attempt = 1; ; attempt++) {
      try {
        return await request('POST', `${base}/video/complete?version=${v}`, { token: ownerToken, signal, timeout: COMPLETE_TIMEOUT_MS });
      } catch (err) {
        if (isAbort(err) || signal?.aborted) throw signal?.aborted ? abortError() : err;
        if (lostResponse && err.status >= 400 && err.status < 500 && err.status !== 404 && expectedOffsetOf(err, size) === null) {
          // An earlier attempt may have completed even though its response never arrived.
          const view = await getOwnerView(id, ownerToken, { signal }).catch(() => null);
          if (view && view.status === 'ready' && Number(view.version) >= Number(version)) return view;
        }
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
        if (err.status === 0) lostResponse = true;
        await wait(backoff(attempt), signal);
      }
    }
  }
}
