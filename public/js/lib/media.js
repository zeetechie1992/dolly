// Media helpers shared by recorder, editor and exporter.

/**
 * Creates a <video> for a Blob/URL and resolves once metadata is loaded AND the
 * duration is finite. MediaRecorder WebM files report duration=Infinity until
 * the browser scans to the end; we force that scan here.
 * @param {Blob|string} src
 * @param {{ muted?: boolean, knownDuration?: number }} [opts]
 * @returns {Promise<HTMLVideoElement>} video with `.src` set, paused at t=0
 */
export function loadVideo(src, { muted = true, knownDuration } = {}) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = muted;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    // We own (and must release) the object URL we create for a Blob source.
    const ownedUrl = typeof src === 'string' ? null : URL.createObjectURL(src);
    video.src = ownedUrl || src;
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (fn === reject) {
        // `arg` (e.g. video.error) was already captured by the caller. Drop the
        // media resource and the Blob registration so a failed load leaks nothing.
        video.removeAttribute('src');
        try { video.load(); } catch { /* already released */ }
        if (ownedUrl) URL.revokeObjectURL(ownedUrl);
      }
      fn(arg);
    };
    // The 15 s budget only runs while the page is visible: Chrome defers loading
    // media in a hidden tab that hasn't played anything yet and starts once the tab
    // is shown, so a load in a background tab gets a fresh window when it's shown.
    let timer = null;
    const onTimeout = () => {
      timer = null;
      // Fall back to the known duration rather than failing hard.
      if (video.readyState >= 1) done(resolve, video);
      else done(reject, new Error('Timed out loading video'));
    };
    const arm = () => {
      if (timer === null && document.visibilityState !== 'hidden') timer = setTimeout(onTimeout, 15000);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') arm();
      else { clearTimeout(timer); timer = null; }
    };
    const cleanup = () => {
      clearTimeout(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisibility);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
      video.removeEventListener('durationchange', onDurationChange);
    };
    const onError = () => done(reject, video.error || new Error('Could not load video'));
    const onDurationChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = 0;
        const finish = () => done(resolve, video);
        video.addEventListener('seeked', finish, { once: true });
        setTimeout(finish, 800);
      }
    };
    const onMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) return done(resolve, video);
      video.addEventListener('durationchange', onDurationChange);
      video.currentTime = Number.isFinite(knownDuration) && knownDuration > 0 ? knownDuration * 4 + 1e6 : 1e7;
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVisibility);
    arm();
  });
}

/** Seeks and resolves when the frame is ready. */
export function seekVideo(video, time) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) return resolve();
    const done = () => { clearTimeout(t); video.removeEventListener('seeked', done); resolve(); };
    const t = setTimeout(done, 2000);
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

/** Reads duration/size of a video Blob. */
export async function probeVideo(blob, knownDuration) {
  const video = await loadVideo(blob, { knownDuration });
  const info = {
    duration: Number.isFinite(video.duration) ? video.duration : knownDuration || 0,
    width: video.videoWidth,
    height: video.videoHeight,
    hasAudio: hasAudioTrack(video),
  };
  // Release the decoder and the Blob registration right away.
  const url = video.src;
  video.removeAttribute('src');
  try { video.load(); } catch { /* already released */ }
  if (typeof blob !== 'string' && url) URL.revokeObjectURL(url); // only the URL loadVideo created for us
  return info;
}

function hasAudioTrack(video) {
  if ('mozHasAudio' in video) return video.mozHasAudio;
  if ('webkitAudioDecodedByteCount' in video) return true; // unknown until played; assume yes
  if (video.audioTracks) return video.audioTracks.length > 0;
  return true;
}

/**
 * Draws the frame at `time` into a small JPEG data URL (cover-cropped to w x h).
 * Leaves the video seeked at `time`.
 */
export async function captureThumbnail(video, time = 0.5, w = 480, h = 270) {
  await seekVideo(video, Math.min(time, Math.max(0, (video.duration || 1) - 0.05)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const vw = video.videoWidth || w, vh = video.videoHeight || h;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return canvas.toDataURL('image/jpeg', 0.78);
}

/** Picks the best supported MediaRecorder mime type from a preference list. */
export function pickMimeType(candidates) {
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export const RECORDING_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4',
];

/** Stops every track in a MediaStream (null-safe). */
export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
