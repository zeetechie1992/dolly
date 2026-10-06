// Recording view (#/record):
//   setup card → 3-2-1 countdown → live HUD (+ floating Picture-in-Picture controls)
//   → "Preparing your video…" → editor (#/edit/:id)
//
// The camera and mic streams opened for the setup preview are reused for the recording; only the
// display capture is requested at Start. All streams, recorders, audio contexts, the PiP window,
// timers and listeners are released by the cleanup function returned from mount().

import { h, clamp, formatTime, debounce, isTypingTarget, downloadBlob } from '../lib/util.js';
import { icon } from '../lib/icons.js';
import { createProjectWithMedia, updateProject } from '../lib/db.js';
import { createProject, RECORDING_MODES } from '../lib/project.js';
import { probeVideo, stopStream } from '../lib/media.js';
import { toast, openModal, logo } from '../lib/ui.js';
import { Recorder, LevelMeter, isRecordingSupported } from '../recorder/recorder.js';
import { Transcriber } from '../recorder/transcriber.js';
import { openPip, isPipSupported, PIP_SIZE } from '../recorder/pip.js';
import {
  startTakeBackup, findInterruptedTakes, recoverInterruptedTake, discardInterruptedTake, cleanTranscript, makeThumbnail,
} from '../recorder/recovery.js';

const PREFS_KEY = 'dolly.record';
const DEFAULT_PREFS = {
  mode: 'screen+cam',
  cameraId: '',
  micId: '',          // '' = browser default, 'none' = no microphone
  systemAudio: true,
  transcript: true,
  floating: true,
  countdown: true,
};
const COUNTDOWN_SECONDS = 3;
const SETUP_METER_BARS = 18;
const HUD_METER_BARS = 10;
const TITLE_SUFFIX = ' — Dolly';
const IS_APPLE = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
// Macs label the key Return; Windows and Linux keyboards say Enter.
// TODO: switch to a shared KEY_ENTER from lib/util.js once the foundation exports one.
const KEY_ENTER = IS_APPLE ? 'Return' : 'Enter';

const TOGGLES = [
  { key: 'systemAudio', icon: 'speaker', tone: 'pink', title: 'System audio', desc: 'Include sound from the tab or screen you share' },
  { key: 'transcript', icon: 'captions', tone: 'purple', title: 'Live transcript', desc: 'Powers captions and the summary' },
  { key: 'floating', icon: 'picture-in-picture', tone: 'blue', title: 'Floating controls', desc: 'Pause or stop from any window' },
  { key: 'countdown', icon: 'timer', tone: 'teal', title: '3-second countdown', desc: 'A moment to get ready' },
];

const needsCamera = (mode) => mode === 'screen+cam' || mode === 'cam';
const liveTrack = (stream, kind) => (stream
  ? (kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks()).find((t) => t.readyState === 'live') || null
  : null);

export function mount(container) {
  const support = detectSupport();
  const prefs = loadPrefs(support);
  const previousTitle = document.title;

  const S = {
    phase: 'setup',            // 'setup' | 'starting' | 'countdown' | 'recording' | 'saving' | 'saved' | 'error'
                               // ('saved': in the library, still adding the thumbnail before opening the editor)
    disposed: false,
    mode: prefs.mode,          // mode of the active take (may fall back to 'screen' without a camera)
    cameraStream: null,
    micStream: null,
    cam: { status: 'idle', error: null },   // 'idle' | 'loading' | 'live' | 'error' | 'off'
    mic: { status: 'idle', error: null },
    camToken: 0,
    micToken: 0,
    devices: { cams: [], mics: [], known: false },
    meter: null,
    activationArmed: false,
    recorder: null,
    transcriber: null,
    transcriptStatus: 'idle',
    pip: null,
    hud: null,
    modal: null,
    countdown: null,
    startNotice: null,
    noticeKey: '',
    result: null,
    savingStep: null,
    raf: 0,
    displaySurface: null,      // 'monitor' | 'window' | 'browser' for the active take's screen capture
    backup: null,              // crash backup of the take being recorded (recorder/recovery.js)
    interrupted: [],           // earlier takes cut short by a crash or closed window
    recovering: false,
  };

  const ticker = createHostTimer(timerHost);
  const countdownTimer = createHostTimer(timerHost);
  const setup = buildSetup();

  /* ------------------------------------------------------------------ setup UI */

  function buildSetup() {
    const refs = { modeButtons: new Map(), toggles: {} };

    const modes = h('div', { class: 'segmented lg rec-modes', role: 'radiogroup', 'aria-label': 'What to record' },
      RECORDING_MODES.map((m) => {
        const btn = h('button', {
          type: 'button', role: 'radio', 'aria-label': m.name, dataset: { mode: m.id },
          disabled: m.id !== 'cam' && !support.display,
          onclick: () => setMode(m.id),
        }, h('span', { class: 'rec-mode-icon', html: icon(m.icon, 16) }), h('span', { class: 'rec-mode-label' }, m.name));
        refs.modeButtons.set(m.id, btn);
        return btn;
      }));

    refs.camVideo = makeVideo('rec-cam-video');
    refs.camIcon = h('span', { class: 'rec-cam-icon' });
    refs.camMsg = h('p', { class: 'rec-cam-msg' });
    refs.camRetry = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => acquireCamera() }, 'Try again');
    refs.cam = h('div', { class: 'rec-cam', dataset: { status: 'idle' } },
      refs.camVideo,
      h('div', { class: 'rec-cam-ph' }, refs.camIcon, refs.camMsg, refs.camRetry));
    refs.preview = h('div', { class: 'rec-preview', dataset: { mode: prefs.mode } }, buildDesk(), refs.cam);

    refs.camSelect = h('select', { class: 'select rec-select', 'aria-label': 'Camera', onchange: (e) => onCameraSelect(e.target.value) });
    refs.meter = buildMeter(SETUP_METER_BARS);
    refs.micSelect = h('select', { class: 'select rec-select', 'aria-label': 'Microphone', onchange: (e) => onMicSelect(e.target.value) });
    refs.camRow = buildRow({ tag: 'label', iconName: 'camera', tone: 'green', title: 'Camera', control: refs.camSelect });
    refs.micRow = buildRow({ tag: 'label', iconName: 'mic', tone: 'orange', title: 'Microphone', extra: refs.meter.el, control: refs.micSelect });
    const devices = h('div', { class: 'rec-group' }, refs.camRow.el, refs.micRow.el);

    const toggles = h('div', { class: 'rec-group' }, TOGGLES.map((t) => {
      const input = h('input', {
        type: 'checkbox', role: 'switch', 'aria-label': t.title,
        onchange: (e) => { prefs[t.key] = e.target.checked; savePrefs(prefs); syncToggles(); },
      });
      const row = buildRow({
        tag: 'label', iconName: t.icon, tone: t.tone, title: t.title, desc: t.desc,
        control: h('span', { class: 'switch' }, input, h('span')),
      });
      refs.toggles[t.key] = { row: row.el, desc: row.desc, input };
      return row.el;
    }));

    refs.fieldset = h('fieldset', { class: 'rec-fieldset' }, modes, refs.preview, devices, toggles);
    refs.notices = h('div', { class: 'rec-notices' });
    refs.startBtn = h('button', { type: 'button', class: 'btn btn-record btn-xl btn-block rec-start', onclick: () => startRecording() });
    refs.hint = h('p', { class: 'rec-hint' });

    const card = h('section', { class: 'card rec-card', 'aria-labelledby': 'rec-title' },
      h('header', { class: 'rec-head' },
        h('h1', { class: 'rec-title', id: 'rec-title' }, 'New recording'),
        h('p', { class: 'rec-sub' }, 'Choose what to capture, check your camera and mic, then hit record.')),
      refs.fieldset,
      refs.notices,
      h('div', { class: 'rec-cta' }, refs.startBtn, refs.hint));

    const nav = h('header', { class: 'nav rec-nav' },
      h('a', { class: 'btn btn-ghost btn-sm rec-back', href: '#/', 'aria-label': 'Back to library' },
        h('span', { html: icon('chevron-left', 16) }), 'Library'),
      logo(),
      h('div', { class: 'nav-spacer' }),
      h('span', { class: 'rec-nav-note' }, h('span', { html: icon('check-circle', 14) }), 'Recordings stay on this device'));

    refs.root = h('div', { class: 'rec-page' }, nav,
      h('main', { class: 'rec-main' }, h('div', { class: 'rec-glow', 'aria-hidden': 'true' }), card));
    return refs;
  }

  function syncAll() {
    syncMode();
    syncCamera();
    syncMic();
  }

  function syncMode() {
    for (const [id, btn] of setup.modeButtons) {
      const on = id === prefs.mode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', String(on));
    }
    setup.preview.dataset.mode = prefs.mode;
    setup.camRow.el.hidden = !needsCamera(prefs.mode);
    syncToggles();
    syncNotices();
    syncStart();
  }

  function syncCamera() {
    const { status, error } = S.cam;
    setup.cam.dataset.status = status;
    setup.camIcon.innerHTML = icon(status === 'error' ? 'camera-off' : 'camera', 22);
    setup.camMsg.textContent = status === 'error' ? describeDeviceError(error, 'camera')
      : status === 'loading' ? 'Starting your camera…' : '';
    setup.camRetry.hidden = status !== 'error';
    setVideoStream(setup.camVideo, S.cameraStream);
    if (S.hud?.camVideo) setVideoStream(S.hud.camVideo, S.cameraStream);
    renderDeviceSelects();
    syncNotices();
    syncStart();
  }

  function syncMic() {
    setup.meter.el.classList.toggle('is-off', !S.micStream);
    renderDeviceSelects();
    syncToggles();
    syncNotices();
    syncStart();
  }

  function syncToggles() {
    for (const t of TOGGLES) {
      const { row, desc, input } = setup.toggles[t.key];
      let hidden = false;
      let reason = null;
      if (t.key === 'systemAudio') hidden = prefs.mode === 'cam';
      if (t.key === 'floating') {
        hidden = prefs.mode === 'cam';
        if (!support.pip) reason = 'Needs a recent version of Chrome, Edge or Arc';
      }
      if (t.key === 'transcript') {
        if (!support.speech) reason = 'Not available in this browser — add captions later';
        else if (prefs.micId === 'none') reason = 'Turn on a microphone to transcribe';
        else if (S.mic.status === 'error') reason = 'Needs microphone access';
      }
      row.hidden = hidden;
      row.classList.toggle('is-disabled', Boolean(reason));
      input.disabled = Boolean(reason);
      input.checked = !reason && Boolean(prefs[t.key]);
      desc.textContent = reason || t.desc;
    }
  }

  function renderDeviceSelects() {
    const { cams, mics, known } = S.devices;

    const camSel = setup.camSelect;
    camSel.replaceChildren();
    if (!cams.length) {
      camSel.append(h('option', { value: '' }, known ? 'No camera found' : 'Camera'));
      camSel.disabled = true;
    } else {
      cams.forEach((d, i) => camSel.append(h('option', { value: d.deviceId }, deviceLabel(d, i, 'Camera'))));
      camSel.disabled = false;
      selectValue(camSel, currentDeviceId(S.cameraStream, 'video') || prefs.cameraId);
    }

    const micSel = setup.micSelect;
    micSel.replaceChildren();
    if (!mics.length) micSel.append(h('option', { value: '', disabled: true }, known ? 'No microphone found' : 'Microphone'));
    mics.forEach((d, i) => micSel.append(h('option', { value: d.deviceId }, deviceLabel(d, i, 'Microphone'))));
    micSel.append(h('option', { value: 'none' }, 'No microphone'));
    selectValue(micSel, prefs.micId === 'none' ? 'none' : currentDeviceId(S.micStream, 'audio') || prefs.micId);
  }

  function syncNotices() {
    const list = [];
    if (!support.media) {
      list.push({ type: 'error', text: "Dolly can't use your camera, microphone or screen on this page. Open it from http://localhost:8000 or over https." });
    } else if (!support.recorder) {
      list.push({ type: 'error', text: "This browser can't record video. Try Chrome, Edge or Arc." });
    } else if (!support.display) {
      list.push({ type: 'warn', text: "Screen recording isn't available in this browser, but you can still record your camera. For screen recordings, use Chrome, Edge or Arc on a computer." });
    }
    if (S.startNotice) list.push(S.startNotice);
    if (S.interrupted.length) {
      const n = S.interrupted.length;
      list.push({
        type: 'info',
        text: n === 1
          ? 'A recording was interrupted before it could be saved. Recover what was captured?'
          : `${n} recordings were interrupted before they could be saved. Recover what was captured?`,
        action: 'recover',
        busy: S.recovering,
      });
    }
    if (support.media && needsCamera(prefs.mode) && S.cam.status === 'error') {
      const suffix = prefs.mode === 'screen+cam' ? ' This will be a screen-only recording.' : '';
      list.push({ type: prefs.mode === 'cam' ? 'error' : 'warn', text: describeDeviceError(S.cam.error, 'camera') + suffix, action: 'camera' });
    }
    if (support.media && prefs.micId !== 'none' && S.mic.status === 'error') {
      list.push({ type: 'warn', text: `${describeDeviceError(S.mic.error, 'microphone')} Your recording won't include your voice.`, action: 'mic' });
    }

    const key = JSON.stringify(list);
    if (key === S.noticeKey) return;
    S.noticeKey = key;
    setup.notices.replaceChildren(...list.map((n) => {
      const iconName = n.type === 'info' ? 'info' : 'warning';
      let action = null;
      if (n.action === 'recover') {
        action = h('div', { class: 'rec-notice-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm rec-notice-action', disabled: n.busy, onclick: () => discardInterrupted() }, 'Discard'),
          h('button', { type: 'button', class: 'btn btn-tinted btn-sm', disabled: n.busy, onclick: () => recoverInterrupted() },
            n.busy ? 'Recovering…' : 'Recover'));
      } else if (n.action) {
        action = h('button', { type: 'button', class: 'btn btn-ghost btn-sm rec-notice-action', onclick: () => (n.action === 'camera' ? acquireCamera() : acquireMic()) }, 'Try again');
      }
      return h('div', { class: `rec-notice is-${n.type}${n.action === 'recover' ? ' has-actions' : ''}`, role: n.type === 'error' ? 'alert' : 'status' },
        h('span', { class: 'rec-notice-icon', html: icon(iconName, 16) }),
        h('p', { class: 'rec-notice-text' }, n.text),
        action);
    }));
  }

  function startBlocker() {
    if (!support.media) return 'Recording needs a secure page';
    if (!support.recorder) return "Recording isn't supported in this browser";
    if (prefs.mode !== 'cam' && !support.display) return "Screen recording isn't supported here";
    if (needsCamera(prefs.mode) && S.cam.status === 'loading') return 'Waiting for your camera…';
    if (prefs.mode === 'cam' && !liveTrack(S.cameraStream, 'video')) return 'Turn on a camera to record';
    if (prefs.micId !== 'none' && S.mic.status === 'loading') return 'Waiting for your microphone…';
    return null;
  }

  function syncStart() {
    const btn = setup.startBtn;
    const starting = S.phase === 'starting';
    const blocker = starting ? null : startBlocker();
    btn.disabled = starting || Boolean(blocker);
    btn.classList.toggle('is-busy', starting);
    btn.replaceChildren(
      starting ? h('span', { class: 'rec-btn-spinner', 'aria-hidden': 'true' }) : h('span', { class: 'rec-start-dot', 'aria-hidden': 'true' }),
      starting ? (prefs.mode === 'cam' ? 'Starting…' : 'Choose what to share…') : 'Start recording');
    setup.fieldset.disabled = starting;
    setup.hint.classList.toggle('is-keys', !starting && !blocker);
    if (starting) setup.hint.replaceChildren(prefs.mode === 'cam' ? 'Getting ready…' : 'Pick a screen, window or tab in the browser dialog');
    else if (blocker) setup.hint.replaceChildren(blocker);
    else setup.hint.replaceChildren('Press ', h('kbd', { class: 'kbd' }, KEY_ENTER), ' to start');
  }

  function setMode(mode) {
    if (S.phase !== 'setup' || mode === prefs.mode) return;
    if (mode !== 'cam' && !support.display) return;
    prefs.mode = mode;
    savePrefs(prefs);
    S.startNotice = null;
    if (needsCamera(mode)) {
      if (!liveTrack(S.cameraStream, 'video') && S.cam.status !== 'loading') acquireCamera();
    } else {
      S.camToken += 1;
      releaseCamera();
      S.cam = { status: 'off', error: null };
    }
    syncMode();
    syncCamera();
  }

  function showSetup({ notice = null } = {}) {
    if (S.disposed) return;
    S.phase = 'setup';
    S.startNotice = notice;
    S.displaySurface = null;
    if (S.hud?.camVideo) S.hud.camVideo.srcObject = null;
    S.hud = null;
    container.replaceChildren(setup.root);
    document.title = `New recording${TITLE_SUFFIX}`;
    // Devices may have gone away while we were recording.
    if (needsCamera(prefs.mode) && !liveTrack(S.cameraStream, 'video') && S.cam.status !== 'loading') acquireCamera();
    if (prefs.micId !== 'none' && !liveTrack(S.micStream, 'audio') && S.mic.status !== 'loading') acquireMic();
    S.noticeKey = '';
    syncAll();
    setVideoStream(setup.camVideo, S.cameraStream);
  }

  /* ------------------------------------------------------------------ devices */

  const gum = (constraints) => navigator.mediaDevices.getUserMedia(constraints);

  function setCam(next) {
    S.cam = next;
    syncCamera();
  }

  function setMic(next) {
    S.mic = next;
    syncMic();
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let list = [];
    try {
      list = await navigator.mediaDevices.enumerateDevices();
    } catch {
      list = [];
    }
    if (S.disposed) return;
    S.devices = {
      cams: list.filter((d) => d.kind === 'videoinput'),
      mics: list.filter((d) => d.kind === 'audioinput'),
      known: true,
    };
    renderDeviceSelects();
  }

  /** First visit: one combined prompt for camera + mic, then fall back to each on its own. */
  async function acquireInitial() {
    if (!support.media || S.disposed) return;
    const wantCam = needsCamera(prefs.mode);
    const wantMic = prefs.micId !== 'none';
    if (!wantCam) S.cam = { status: 'off', error: null };
    if (!wantMic) S.mic = { status: 'off', error: null };
    if (wantCam && wantMic) {
      const camToken = ++S.camToken;
      const micToken = ++S.micToken;
      S.cam = { status: 'loading', error: null };
      S.mic = { status: 'loading', error: null };
      syncAll();
      let stream = null;
      let error = null;
      try {
        stream = await gum({ video: cameraConstraints(prefs.cameraId), audio: micConstraints(prefs.micId) });
      } catch (err) {
        error = err;
      }
      if (S.disposed) {
        stopStream(stream);
        return;
      }
      if (stream) {
        const video = stream.getVideoTracks();
        const audio = stream.getAudioTracks();
        if (camToken === S.camToken && video.length) adoptCamera(new MediaStream(video));
        else video.forEach((t) => t.stop());
        if (micToken === S.micToken && audio.length) adoptMic(new MediaStream(audio));
        else audio.forEach((t) => t.stop());
        refreshDevices();
        return;
      }
      // macOS has not let the browser use one of the devices ("Permission denied by system"):
      // ask for each on its own below, so each reports its own state and the other still works.
      const systemDenied = isSystemDenied(error);
      if (!systemDenied && (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')) {
        // Chrome rejects the whole call when either kind is blocked. Re-request on its own only a
        // kind that can't show a prompt (already granted), or whose prompt Chrome never got to
        // show because the other kind is blocked. A dismissed combined prompt leaves both at
        // 'prompt' and "Never allow" leaves both at 'denied', so neither is retried then.
        const [camState, micState] = error.name === 'NotAllowedError'
          ? await Promise.all([permissionState('camera'), permissionState('microphone')])
          : ['denied', 'denied'];
        if (S.disposed) return;
        const retry = (state, other) => state === 'granted' || (state === 'prompt' && other === 'denied');
        const retryCam = retry(camState, micState) && camToken === S.camToken;
        const retryMic = retry(micState, camState) && micToken === S.micToken;
        if (!retryCam && camToken === S.camToken) setCam({ status: 'error', error });
        if (!retryMic && micToken === S.micToken) setMic({ status: 'error', error });
        refreshDevices();
        await Promise.all([retryCam ? acquireCamera() : null, retryMic ? acquireMic() : null]);
        return;
      }
      // One device is missing, busy or blocked by macOS: try each separately so the other still works.
    }
    syncAll();
    await Promise.all([wantCam ? acquireCamera() : null, wantMic ? acquireMic() : null]);
  }

  async function acquireCamera({ exact = false } = {}) {
    if (!support.media || S.disposed) return;
    const token = ++S.camToken;
    releaseCamera();
    setCam({ status: 'loading', error: null });
    let stream = null;
    let error = null;
    try {
      stream = await gum({ video: cameraConstraints(prefs.cameraId, exact), audio: false });
    } catch (err) {
      error = err;
      if (prefs.cameraId && token === S.camToken && !S.disposed && isDeviceSpecificError(err)) {
        try {
          stream = await gum({ video: cameraConstraints(''), audio: false });
          error = null;
        } catch (err2) {
          error = err2;
        }
      }
    }
    if (S.disposed || token !== S.camToken) {
      stopStream(stream);
      return;
    }
    if (!stream) {
      setCam({ status: 'error', error });
      return;
    }
    adoptCamera(stream);
    refreshDevices();
  }

  async function acquireMic({ exact = false } = {}) {
    if (!support.media || S.disposed) return;
    const token = ++S.micToken;
    releaseMic();
    if (prefs.micId === 'none') {
      setMic({ status: 'off', error: null });
      return;
    }
    setMic({ status: 'loading', error: null });
    let stream = null;
    let error = null;
    try {
      stream = await gum({ audio: micConstraints(prefs.micId, exact), video: false });
    } catch (err) {
      error = err;
      if (prefs.micId && token === S.micToken && !S.disposed && isDeviceSpecificError(err)) {
        try {
          stream = await gum({ audio: micConstraints(''), video: false });
          error = null;
        } catch (err2) {
          error = err2;
        }
      }
    }
    if (S.disposed || token !== S.micToken) {
      stopStream(stream);
      return;
    }
    if (!stream) {
      setMic({ status: 'error', error });
      return;
    }
    adoptMic(stream);
    refreshDevices();
  }

  function adoptCamera(stream) {
    S.cameraStream = stream;
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', onCameraTrackEnded));
    setCam({ status: 'live', error: null });
  }

  function adoptMic(stream) {
    S.micStream = stream;
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', onMicTrackEnded));
    ensureMeter();
    setMic({ status: 'live', error: null });
  }

  function releaseCamera() {
    const stream = S.cameraStream;
    S.cameraStream = null;
    if (stream) {
      stream.getVideoTracks().forEach((t) => t.removeEventListener('ended', onCameraTrackEnded));
      stopStream(stream);
    }
    setVideoStream(setup.camVideo, null);
    if (S.hud?.camVideo) setVideoStream(S.hud.camVideo, null);
  }

  function releaseMic() {
    const stream = S.micStream;
    S.micStream = null;
    if (stream) {
      stream.getAudioTracks().forEach((t) => t.removeEventListener('ended', onMicTrackEnded));
      stopStream(stream);
    }
    S.meter?.setStream(null);
  }

  /** After a take: turn the camera light off and free the mic. */
  function releaseDevices() {
    S.camToken += 1;
    S.micToken += 1;
    releaseCamera();
    releaseMic();
    S.cam = { status: 'idle', error: null };
    S.mic = { status: 'idle', error: null };
  }

  // While recording, the Recorder deals with lost devices; these only matter on the setup screen.
  function onCameraTrackEnded() {
    if (S.phase !== 'setup' && S.phase !== 'starting') return;
    releaseCamera();
    setCam({ status: 'error', error: { name: 'Ended' } });
  }

  function onMicTrackEnded() {
    if (S.phase !== 'setup' && S.phase !== 'starting') return;
    releaseMic();
    setMic({ status: 'error', error: { name: 'Ended' } });
  }

  const onDeviceChange = debounce(async () => {
    await refreshDevices();
    if (S.disposed || S.phase !== 'setup') return;
    const recoverable = (err) => ['Ended', 'NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(err?.name);
    if (needsCamera(prefs.mode) && S.cam.status === 'error' && recoverable(S.cam.error)) acquireCamera();
    if (prefs.micId !== 'none' && S.mic.status === 'error' && recoverable(S.mic.error)) acquireMic();
  }, 400);

  function onCameraSelect(id) {
    prefs.cameraId = id;
    savePrefs(prefs);
    acquireCamera({ exact: Boolean(id) });
  }

  function onMicSelect(id) {
    prefs.micId = id;
    savePrefs(prefs);
    if (id === 'none') {
      S.micToken += 1;
      releaseMic();
      setMic({ status: 'off', error: null });
      return;
    }
    acquireMic({ exact: Boolean(id) });
  }

  /* ------------------------------------------------------------------ level meter */

  // Creating an AudioContext before any user gesture only produces a suspended context (and a
  // console warning), so the meter waits for the first gesture when the page has none yet.
  function ensureMeter() {
    if (S.disposed) return;
    if (!S.meter) {
      const activation = navigator.userActivation;
      if (activation && !activation.hasBeenActive) {
        armActivation();
        return;
      }
      S.meter = new LevelMeter();
    }
    S.meter.setStream(S.micStream);
    if (S.meter.suspended) armActivation();
  }

  function armActivation() {
    if (S.activationArmed) return;
    S.activationArmed = true;
    document.addEventListener('pointerdown', onActivation, true);
    document.addEventListener('keydown', onActivation, true);
  }

  function disarmActivation() {
    if (!S.activationArmed) return;
    S.activationArmed = false;
    document.removeEventListener('pointerdown', onActivation, true);
    document.removeEventListener('keydown', onActivation, true);
  }

  function onActivation() {
    disarmActivation();
    if (S.micStream) ensureMeter();
    S.meter?.resume();
  }

  function frame() {
    S.raf = requestAnimationFrame(frame);
    const level = S.meter && S.micStream ? S.meter.read() : 0;
    if (S.phase === 'setup' || S.phase === 'starting') setup.meter.set(level);
    else if (S.hud?.meter) S.hud.meter.set(level);
  }

  /* ------------------------------------------------------------------ start */

  function effectiveMode() {
    if (prefs.mode === 'screen+cam' && !liveTrack(S.cameraStream, 'video')) return 'screen';
    return prefs.mode;
  }

  // getDisplayMedia and documentPictureInPicture.requestWindow both need the click's transient
  // activation, so both are kicked off synchronously here before anything is awaited.
  function startRecording() {
    if (S.phase !== 'setup' || S.disposed || startBlocker()) return;
    const mode = effectiveMode();
    const wantDisplay = mode !== 'cam';
    const wantPip = wantDisplay && prefs.floating && support.pip;

    // Chrome brings a shared tab or window to the front as soon as capture starts, which would
    // hide the 3-2-1 and the HUD when no floating window shows them. Keep Dolly in front then.
    // A controller can only be used for one capture, so each start gets a new one.
    let controller = null;
    if (wantDisplay && !wantPip && prefs.countdown && typeof window.CaptureController === 'function') {
      try {
        controller = new window.CaptureController();
        controller.setFocusBehavior('no-focus-change');
      } catch {
        controller = null; // older Chrome rejects the call before capture starts: keep the default
      }
    }

    let displayPromise = Promise.resolve(null);
    if (wantDisplay) {
      try {
        displayPromise = navigator.mediaDevices.getDisplayMedia(displayOptions(prefs.systemAudio, controller));
      } catch (err) {
        displayPromise = Promise.reject(err);
      }
    }
    const pipPromise = wantPip ? openPip(PIP_SIZE) : Promise.resolve(null);

    S.phase = 'starting';
    S.startNotice = null;
    syncNotices();
    syncStart();
    Promise.allSettled([displayPromise, pipPromise]).then(([display, pip]) => onCaptureReady(mode, display, pip));
  }

  function onCaptureReady(requestedMode, displayResult, pipResult) {
    // The user may close the floating window while the screen picker is still open; drop it then,
    // so the HUD offers "Floating controls" again.
    const pip = pipResult.status === 'fulfilled' && !pipResult.value?.closed ? pipResult.value : null;
    const display = displayResult.status === 'fulfilled' ? displayResult.value : null;
    if (S.disposed || S.phase !== 'starting') {
      stopStream(display);
      pip?.close();
      return;
    }
    if (displayResult.status === 'rejected') {
      pip?.close();
      showSetup({ notice: describeDisplayError(displayResult.reason) });
      return;
    }
    S.displaySurface = display?.getVideoTracks()[0]?.getSettings?.().displaySurface || null;

    let mode = requestedMode;
    if (mode === 'screen+cam' && !liveTrack(S.cameraStream, 'video')) mode = 'screen';
    let recorder = null;
    try {
      recorder = new Recorder({
        mode,
        displayStream: display,
        cameraStream: mode === 'screen' ? null : S.cameraStream,
        micStream: S.micStream,
        onEnded: () => onSourceEnded(recorder),
        onError: (err, kind) => onRecorderError(recorder, err, kind),
      });
      recorder.prepare();
    } catch (err) {
      recorder?.destroy();
      stopStream(display);
      pip?.close();
      showSetup({ notice: { type: 'error', text: err?.message || "Couldn't start recording." } });
      return;
    }

    S.mode = mode;
    S.recorder = recorder;
    S.transcriptStatus = 'idle';
    const micTrack = liveTrack(S.micStream, 'audio');
    S.transcriber = prefs.transcript && support.speech && micTrack
      ? new Transcriber({
        getElapsed: () => recorder.elapsed,
        // The mic chosen here, not the system default input. Not a clone: the Recorder uses the
        // same track and releaseDevices() stops it after the take.
        track: micTrack,
        onUpdate: onTranscriptUpdate,
        onStatus: onTranscriptStatus,
      })
      : null;
    S.phase = 'countdown';
    if (pip) {
      attachPip(pip);
      pip.setState('ready');
      if (S.displaySurface === 'monitor') warnPipInCapture(pip);
    }
    showHud();
    beginTake(recorder);
  }

  async function beginTake(recorder) {
    if (prefs.countdown) {
      S.phase = 'countdown';
      syncHud();
      const completed = await runCountdown(COUNTDOWN_SECONDS);
      if (!completed || S.disposed || S.recorder !== recorder || S.phase !== 'countdown') return;
    }
    // Copy every chunk to IndexedDB as it arrives, so a crash or force-quit can't lose the take.
    dropBackup();
    const backup = startTakeBackup({ mode: S.mode });
    S.backup = backup;
    recorder.onChunk = backup ? backup.write : null;
    try {
      recorder.start();
    } catch (err) {
      abortSession({ type: 'error', text: `Couldn't start recording. ${err?.message || ''}`.trim() });
      return;
    }
    S.phase = 'recording';
    S.transcriber?.start();
    S.pip?.setState('recording');
    syncHud();
    startTicker();
  }

  function onSourceEnded(recorder) {
    if (recorder !== S.recorder) return;
    if (S.phase === 'countdown') {
      const text = S.mode === 'cam' ? 'Your camera turned off before recording started.' : 'Screen sharing ended before recording started.';
      if (S.countdown) cancelCountdown({ type: 'info', text });
      else abortSession({ type: 'info', text });
      return;
    }
    if (S.phase === 'recording') {
      if (S.mode === 'cam') toast('Your camera turned off — saving your recording');
      finish();
    }
  }

  function onRecorderError(recorder, err, kind) {
    if (recorder !== S.recorder) return;
    console.error(`[record] ${kind} recorder error`, err);
    if (kind === 'camera') {
      toast('The camera recording stopped. Your screen is still recording.', { type: 'error' });
      return;
    }
    if (S.phase === 'recording') {
      toast('Recording ran into a problem — saving what was captured.', { type: 'error' });
      finish();
    } else if (S.phase === 'countdown') {
      abortSession({ type: 'error', text: "Couldn't start recording. Please try again." });
    }
  }

  /* ------------------------------------------------------------------ countdown */

  function runCountdown(seconds) {
    return new Promise((resolve) => {
      const number = h('div', { class: 'rec-count-num', 'aria-live': 'assertive' });
      const overlay = h('div', { class: 'rec-countdown', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Recording starts soon' },
        h('div', { class: 'rec-count-inner' },
          h('p', { class: 'rec-count-title' }, 'Recording starts in'),
          number,
          h('button', { type: 'button', class: 'btn btn-secondary rec-count-cancel', onclick: () => cancelCountdown() },
            'Cancel', h('span', { class: 'kbd' }, 'Esc'))));
      (S.hud?.root || container).append(overlay);

      let remaining = seconds;
      const entry = {
        finish(ok) {
          if (S.countdown !== entry) return;
          S.countdown = null;
          countdownTimer.clear();
          overlay.remove();
          resolve(ok);
        },
      };
      S.countdown = entry;
      S.pip?.setState('countdown');

      const step = () => {
        if (S.countdown !== entry) return;
        if (remaining <= 0) {
          entry.finish(true);
          return;
        }
        // Fresh nodes restart the pop + ring-sweep animations for every number.
        number.replaceChildren(
          h('span', { class: 'rec-count-ring', 'aria-hidden': 'true' }),
          h('span', { class: 'rec-count-digit' }, String(remaining)));
        S.pip?.showCountdown(remaining);
        document.title = `Starting in ${remaining}…${TITLE_SUFFIX}`;
        remaining -= 1;
        countdownTimer.timeout(step, 1000);
      };
      step();
    });
  }

  function cancelCountdown(notice = null) {
    if (!S.countdown) return;
    S.countdown.finish(false);
    abortSession(notice);
  }

  /* ------------------------------------------------------------------ live HUD */

  function buildHud(recorder) {
    const mode = S.mode;
    const modeInfo = RECORDING_MODES.find((m) => m.id === mode) || RECORDING_MODES[0];
    const refs = {};

    refs.statusLabel = h('span', { class: 'rec-status-label' }, 'Get ready');
    refs.status = h('div', { class: 'rec-status', role: 'status' }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), refs.statusLabel);
    refs.timer = h('div', { class: 'rec-timer', role: 'timer', 'aria-label': 'Recorded time' }, '0:00');

    const control = (btn, label, extra = '') => h('div', { class: `rec-ctl ${extra}` }, btn, h('span', { class: 'rec-ctl-label' }, label));
    refs.pauseBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-icon rec-ctl-btn', onclick: () => togglePause() });
    refs.stopBtn = h('button', { type: 'button', class: 'btn btn-record btn-icon rec-ctl-btn', 'aria-label': 'Stop recording', html: icon('stop', 26), onclick: () => finish() });
    refs.restartBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-icon rec-ctl-btn', 'aria-label': 'Restart recording', html: icon('restart', 20), onclick: () => restartTake() });
    refs.discardBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-icon rec-ctl-btn', 'aria-label': 'Discard recording', html: icon('trash', 20), onclick: () => discardTake() });
    const pauseCtl = control(refs.pauseBtn, 'Pause');
    refs.pauseLabel = pauseCtl.querySelector('.rec-ctl-label');
    refs.controls = h('div', { class: 'rec-controls' },
      pauseCtl,
      control(refs.stopBtn, 'Stop', 'rec-ctl-stop'),
      control(refs.restartBtn, 'Restart'),
      control(refs.discardBtn, 'Discard', 'rec-ctl-discard'));

    let cam = null;
    if (mode !== 'screen' && liveTrack(S.cameraStream, 'video')) {
      refs.camVideo = makeVideo('rec-hud-video');
      cam = h('div', { class: 'rec-hud-cam' }, refs.camVideo);
    }

    refs.meter = S.micStream ? buildMeter(HUD_METER_BARS, 'sm') : null;
    refs.pipBtn = support.pip && mode !== 'cam'
      ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm rec-pip-btn', onclick: () => reopenPip() },
        h('span', { html: icon('picture-in-picture', 16) }), 'Floating controls')
      : null;
    const chip = (iconName, ...content) => h('span', { class: 'chip rec-chip' }, h('span', { class: 'rec-chip-icon', html: icon(iconName, 14) }), ...content);
    const chips = h('div', { class: 'rec-hud-chips' },
      refs.pipBtn,
      chip(modeInfo.icon, modeInfo.name),
      refs.meter ? chip('mic', h('span', { class: 'sr-only' }, 'Microphone'), refs.meter.el) : chip('mic-off', 'No mic'),
      recorder.hasSystemAudio ? chip('speaker', 'System audio') : null);

    const hint = h('p', { class: 'rec-hud-hint' },
      mode === 'cam' ? 'Look into the camera and talk naturally.' : 'Switch to what you want to show — Dolly keeps recording.',
      h('span', { class: 'rec-hud-keys' }, h('kbd', { class: 'kbd' }, 'Space'), ' to pause'));

    if (S.transcriber) {
      refs.tickerFinal = h('span', { class: 'rec-ticker-final' });
      refs.tickerInterim = h('span', { class: 'rec-ticker-interim' });
      refs.tickerEmpty = h('span', { class: 'rec-ticker-empty' }, 'Start talking — your words show up here.');
      refs.tickerState = h('span', { class: 'rec-ticker-state' }, 'Waiting');
      refs.ticker = h('section', { class: 'rec-ticker is-empty', 'aria-label': 'Live transcript' },
        h('header', { class: 'rec-ticker-head' },
          h('span', { class: 'rec-ticker-title' }, h('span', { html: icon('captions', 14) }), 'Live transcript'),
          refs.tickerState),
        h('p', { class: 'rec-ticker-text' },
          h('span', { class: 'rec-ticker-inner' }, refs.tickerEmpty, refs.tickerFinal, refs.tickerInterim)));
    }

    refs.root = h('div', { class: 'rec-hud', dataset: { mode, state: 'countdown' } },
      h('div', { class: 'rec-hud-glow', 'aria-hidden': 'true' }),
      h('header', { class: 'rec-hud-top' },
        h('span', { class: 'logo rec-hud-logo' }, h('span', { class: 'logo-mark' }), 'Dolly'),
        h('div', { class: 'nav-spacer' }),
        chips),
      h('main', { class: 'rec-hud-center', tabindex: '-1' }, cam, refs.status, refs.timer, refs.controls, hint),
      refs.ticker || h('div', { class: 'rec-ticker-spacer' }));
    return refs;
  }

  function showHud() {
    if (S.disposed) return;
    S.hud = buildHud(S.recorder);
    container.replaceChildren(S.hud.root);
    if (S.hud.camVideo) setVideoStream(S.hud.camVideo, S.cameraStream);
    renderTime(0);
    syncHud();
    // Keep Space for pause/resume instead of activating whatever button had focus.
    S.hud.root.querySelector('.rec-hud-center')?.focus({ preventScroll: true });
  }

  function syncHud() {
    const hud = S.hud;
    if (!hud) return;
    const state = S.phase === 'countdown' ? 'countdown' : S.recorder?.state === 'paused' ? 'paused' : 'recording';
    hud.root.dataset.state = state;
    hud.statusLabel.textContent = state === 'paused' ? 'Paused' : state === 'countdown' ? 'Get ready' : 'Recording';
    const paused = state === 'paused';
    hud.pauseBtn.innerHTML = icon(paused ? 'play' : 'pause', 20);
    hud.pauseBtn.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
    hud.pauseLabel.textContent = paused ? 'Resume' : 'Pause';
    const busy = state === 'countdown';
    for (const btn of [hud.pauseBtn, hud.stopBtn, hud.restartBtn, hud.discardBtn]) btn.disabled = busy;
    if (hud.pipBtn) hud.pipBtn.hidden = Boolean(S.pip);
    if (hud.tickerState) {
      const status = S.transcriptStatus;
      hud.tickerState.textContent = status === 'unavailable' ? 'Unavailable'
        : paused || status === 'paused' ? 'Paused'
          : status === 'listening' ? 'Listening' : status === 'reconnecting' ? 'Reconnecting…' : 'Waiting';
      hud.tickerState.dataset.status = paused && status !== 'unavailable' ? 'paused' : status;
    }
  }

  function renderTicker(interim, segments) {
    const hud = S.hud;
    if (!hud?.ticker) return;
    let finals = segments.slice(-6).map((s) => s.text).join(' ');
    if (finals.length > 260) finals = finals.slice(finals.indexOf(' ', finals.length - 260) + 1);
    hud.tickerFinal.textContent = finals;
    hud.tickerInterim.textContent = interim ? (finals ? ' ' : '') + interim : '';
    hud.ticker.classList.toggle('is-empty', !finals && !interim);
  }

  function onTranscriptUpdate(interim, segments) {
    renderTicker(interim, segments);
    S.backup?.writeTranscript(segments);
  }

  function onTranscriptStatus(status) {
    if (S.transcriptStatus === 'unavailable') return; // giving up is final for this session
    S.transcriptStatus = status;
    if (status === 'unavailable' && S.hud?.tickerEmpty) {
      S.hud.tickerEmpty.textContent = "Live transcript isn't available right now. You can add captions in the editor.";
    }
    syncHud();
  }

  /* ------------------------------------------------------------------ clock + PiP */

  function timerHost() {
    // The PiP window stays visible while the tab is hidden, so its timers aren't throttled.
    return S.pip && !S.pip.closed ? S.pip.window : window;
  }

  function startTicker() {
    ticker.interval(tick, 250);
    tick();
  }

  function stopTicker() {
    ticker.clear();
  }

  function tick() {
    if (S.recorder) renderTime(S.recorder.elapsed);
  }

  function renderTime(sec) {
    const text = formatTime(sec);
    if (S.hud && S.hud.timer.textContent !== text) S.hud.timer.textContent = text;
    S.pip?.setTime(sec);
    if (S.phase === 'recording') {
      const title = S.recorder?.state === 'paused' ? `Paused · ${text}${TITLE_SUFFIX}` : `● ${text}${TITLE_SUFFIX}`;
      if (document.title !== title) document.title = title;
    }
  }

  function attachPip(pip) {
    S.pip = pip;
    pip.onPause = () => pauseRecording();
    pip.onResume = () => resumeRecording();
    pip.onStop = () => finish();
    pip.onCancel = () => cancelCountdown();
    pip.onClose = () => {
      if (S.pip !== pip) return;
      S.pip = null;
      ticker.rearm();
      countdownTimer.rearm();
      syncHud();
    };
    if (pip.closed) { // the window went away before we attached
      pip.onClose();
      return;
    }
    ticker.rearm();
    countdownTimer.rearm();
  }

  function closePip() {
    const pip = S.pip;
    if (!pip) return;
    S.pip = null;
    pip.close();
    ticker.rearm();
    countdownTimer.rearm();
  }

  function reopenPip() {
    if (S.pip || (S.phase !== 'recording' && S.phase !== 'countdown')) return;
    openPip(PIP_SIZE).then((pip) => {
      if (S.disposed || S.pip || (S.phase !== 'recording' && S.phase !== 'countdown')) {
        pip.close();
        return;
      }
      attachPip(pip);
      if (S.displaySurface === 'monitor') warnPipInCapture(pip);
      if (S.phase === 'countdown') pip.setState('countdown');
      else {
        pip.setState(S.recorder?.state === 'paused' ? 'paused' : 'recording');
        pip.setTime(S.recorder?.elapsed || 0);
      }
      syncHud();
    }, () => {
      if (!S.disposed) toast("Couldn't open floating controls", { type: 'error' });
    });
  }

  /** Document PiP windows are always on top, so a full-screen capture records them too. */
  function warnPipInCapture(pip) {
    pip.setHint?.('Visible in full-screen recordings');
    toast('Floating controls show up when you record your entire screen. Close them to keep them out of the video.', { duration: 6000 });
  }

  /* ------------------------------------------------------------------ pause / restart / discard */

  function pauseRecording() {
    if (S.phase !== 'recording' || !S.recorder?.pause()) return false;
    S.transcriber?.pause();
    S.pip?.setState('paused');
    syncHud();
    tick();
    return true;
  }

  function resumeRecording() {
    if (S.phase !== 'recording' || !S.recorder?.resume()) return false;
    S.transcriber?.resume();
    S.pip?.setState('recording');
    syncHud();
    tick();
    return true;
  }

  function togglePause() {
    if (S.recorder?.state === 'paused') resumeRecording();
    else pauseRecording();
  }

  function ask({ title, message, confirmText, danger = false }) {
    closeModal();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // lets the dialog autofocus
    return new Promise((resolve) => {
      let confirmed = false;
      const modal = openModal({
        title,
        description: message,
        width: '420px',
        onClose: () => {
          if (S.modal === modal) S.modal = null;
          resolve(confirmed);
        },
        actions: [
          { label: 'Cancel', variant: 'secondary' },
          { label: confirmText, variant: danger ? 'danger' : 'primary', autofocus: true, onClick: (close) => { confirmed = true; close(); } },
        ],
      });
      S.modal = modal;
    });
  }

  function closeModal() {
    const modal = S.modal;
    S.modal = null;
    modal?.close();
  }

  /** Pauses while a confirmation is open; resumes if the user backs out. */
  async function confirmWhilePaused(options) {
    const recorder = S.recorder;
    const wasRecording = recorder?.state === 'recording';
    if (wasRecording) pauseRecording();
    const ok = await ask(options);
    const stillHere = S.phase === 'recording' && S.recorder === recorder;
    if (!ok && stillHere && wasRecording) resumeRecording();
    return ok && stillHere;
  }

  async function restartTake() {
    if (S.phase !== 'recording') return;
    const ok = await confirmWhilePaused({
      title: 'Restart recording?',
      message: 'This take will be thrown away and a new one will start.',
      confirmText: 'Restart',
    });
    if (!ok) return;
    const recorder = S.recorder;
    stopTicker();
    try {
      recorder.restart({ autoStart: false });
      dropBackup(); // the old take is gone; beginTake backs up the new one
    } catch {
      abortSession({ type: 'info', text: S.mode === 'cam' ? 'Your camera turned off. Start a new recording when you’re ready.' : 'Screen sharing has ended. Start a new recording when you’re ready.' });
      return;
    }
    S.transcriber?.reset();
    if (S.transcriber?.available) {
      S.transcriptStatus = 'idle';
      if (S.hud?.tickerEmpty) S.hud.tickerEmpty.textContent = 'Start talking — your words show up here.';
    }
    renderTicker('', []);
    S.phase = 'countdown';
    renderTime(0);
    S.pip?.setTime(0);
    syncHud();
    beginTake(recorder);
  }

  async function discardTake() {
    if (S.phase !== 'recording') return;
    const ok = await confirmWhilePaused({
      title: 'Discard this recording?',
      message: "It will be deleted right away. This can't be undone.",
      confirmText: 'Discard',
      danger: true,
    });
    if (!ok) return;
    abortSession();
    toast('Recording discarded');
  }

  /** Throws the session away and returns to the setup card (camera + mic stay on). */
  function abortSession(notice = null) {
    closeModal();
    stopTicker();
    S.countdown?.finish(false);
    countdownTimer.clear();
    closePip();
    S.transcriber?.destroy();
    S.transcriber = null;
    S.recorder?.destroy();
    S.recorder = null;
    dropBackup();
    S.displaySurface = null;
    showSetup({ notice });
  }

  /** Deletes the crash backup of a take that was thrown away. */
  function dropBackup() {
    const backup = S.backup;
    S.backup = null;
    backup?.clear();
  }

  /* ------------------------------------------------------------------ stop + save */

  async function finish() {
    if (S.phase !== 'recording' || !S.recorder) return;
    S.phase = 'saving';
    closeModal();
    stopTicker();
    closePip();
    const recorder = S.recorder;
    const transcriber = S.transcriber;
    showSaving();

    let result = null;
    let segments = [];
    try {
      [result, segments] = await Promise.all([
        recorder.stop(),
        transcriber ? transcriber.stop() : Promise.resolve([]),
      ]);
    } catch (err) {
      console.error('[record] stopping failed', err);
    }
    transcriber?.destroy();
    recorder.destroy();
    if (S.recorder === recorder) S.recorder = null;
    if (S.transcriber === transcriber) S.transcriber = null;
    releaseDevices();
    S.meter?.destroy();
    S.meter = null;
    // From here on the backup belongs to the result: cleared once it is in the library.
    const backup = S.backup;
    S.backup = null;

    if (!result) {
      backup?.release(); // whatever reached the backup can still be recovered
      showSaveError({ title: "Couldn't finish the recording", message: 'Something went wrong while stopping. Please try again.', canRetry: false });
      return;
    }
    S.result = { ...result, segments: segments || [], mode: S.mode, backup };
    await saveRecording();
  }

  async function saveRecording() {
    const r = S.result;
    if (!r) return;
    S.phase = 'saving';
    if (!S.savingStep?.isConnected) showSaving();
    if (!r.main || !r.main.size) {
      r.backup?.clear();
      showSaveError({ title: 'Nothing was recorded', message: 'The recording came out empty. Please try again.', canRetry: false });
      return;
    }

    // Store first, from the recorder's own clock and track settings, in one transaction with the
    // media. Reading the file back (probe, thumbnail) comes after: a hidden tab (the user is in the
    // app they just recorded) may not load video until it is shown, and the recording must not
    // wait on that to be safe.
    setSavingStep('Saving to your library…');
    let project = projectFromResult(r, null);
    try {
      await createProjectWithMedia(project, { main: r.main, camera: project.source.hasCamera ? r.camera : null });
    } catch (err) {
      console.error('[record] saving failed', err);
      showSaveError({ title: "Couldn't save your recording", message: describeStorageError(err), canRetry: true });
      return;
    }

    r.backup?.clear(); // safely in the library now
    S.result = null;
    S.phase = 'saved';
    setSavingStep('Creating a thumbnail…');
    project = await finishSavedRecording(project, r);
    if (S.disposed) {
      // The user left; the recording is safely in the library (which picks it up by itself).
      // Offer a direct way in.
      toast(h('span', { class: 'rec-toast-msg' }, 'Your recording was saved to the library.',
        h('button', { type: 'button', class: 'btn btn-sm btn-secondary', onclick: () => { location.hash = `#/edit/${project.id}`; } }, 'Open')),
      { type: 'success', duration: 8000 });
      return;
    }
    setSavingStep('Opening the editor…');
    location.hash = `#/edit/${project.id}`;
  }

  function showSaving() {
    if (S.disposed) return; // the container belongs to another view now
    S.savingStep = h('p', { class: 'rec-saving-step', role: 'status' }, 'Finishing up…');
    const root = h('div', { class: 'rec-saving' },
      h('div', { class: 'rec-saving-card' },
        h('div', { class: 'rec-saving-visual' }, h('div', { class: 'rec-saving-ring' }), h('span', { class: 'rec-saving-icon', html: icon('film', 26) })),
        h('h1', { class: 'rec-saving-title' }, 'Preparing your video…'),
        S.savingStep));
    container.replaceChildren(root);
    S.hud = null;
    document.title = `Preparing your video…${TITLE_SUFFIX}`;
  }

  function setSavingStep(text) {
    if (S.savingStep) S.savingStep.textContent = text;
  }

  function showSaveError({ title, message, canRetry }) {
    const r = S.result;
    if (S.disposed) {
      // The container belongs to another view now, but a failure must not go unnoticed, and the
      // toast holds the only in-memory copy, so it stays until dismissed. The crash backup is
      // handed over to recovery as well.
      S.result = null;
      r?.backup?.release();
      if (r?.main?.size) rescueToast(title, r);
      else toast(title, { type: 'error', duration: 20000 });
      return;
    }
    S.phase = 'error';
    const actions = [];
    if (r?.main?.size) {
      actions.push(h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => downloadRaw(r) },
        h('span', { html: icon('download', 16) }), 'Download recording'));
    }
    if (canRetry && r) actions.push(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => saveRecording() }, 'Try again'));
    else actions.push(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => recordAgain() }, 'Record again'));
    actions.push(h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => leaveUnsaved() }, 'Back to library'));

    const root = h('div', { class: 'rec-saving' },
      h('div', { class: 'rec-saving-card is-error' },
        h('div', { class: 'rec-saving-visual' }, h('span', { class: 'rec-saving-icon', html: icon('warning', 26) })),
        h('h1', { class: 'rec-saving-title' }, title),
        h('p', { class: 'rec-saving-step' }, message),
        h('div', { class: 'rec-saving-actions' }, actions)));
    container.replaceChildren(root);
    S.savingStep = null;
    document.title = `${title}${TITLE_SUFFIX}`;
  }

  /** Error card → library. The recording only exists in memory, so confirm first. */
  async function leaveUnsaved() {
    if (S.result?.main?.size) {
      const ok = await ask({
        title: 'Leave without saving?',
        message: "This recording isn't in your library. Download it first so you don't lose it.",
        confirmText: 'Leave',
        danger: true,
      });
      if (!ok || S.disposed || S.phase !== 'error') return;
    }
    // Cleared first so leaving doesn't also raise the "wasn't saved" toast.
    const r = S.result;
    S.result = null;
    r?.backup?.release();
    location.hash = '#/';
  }

  /** Error toast with a way to download a recording that couldn't be saved; stays until dismissed. */
  function rescueToast(title, result) {
    // Persistent (duration 0): it holds the only copy, so it stays until dismissed with its × button.
    toast(h('span', { class: 'rec-toast-msg' },
      `${title}.`,
      h('button', { type: 'button', class: 'btn btn-sm btn-secondary', onclick: () => downloadRaw(result) }, 'Download recording')),
    { type: 'error', duration: 0 });
  }

  function downloadRaw(result) {
    const ext = /mp4/.test(result.main.type) ? 'mp4' : 'webm';
    downloadBlob(result.main, `dolly-recording.${ext}`);
    if (result.camera?.size) downloadBlob(result.camera, `dolly-camera.${/mp4/.test(result.camera.type) ? 'mp4' : 'webm'}`);
  }

  function recordAgain() {
    S.result?.backup?.release(); // nothing usable is lost: the setup card offers whatever was backed up
    S.result = null;
    showSetup(); // re-opens the camera and mic released after the last take
    scanInterrupted();
  }

  /* ------------------------------------------------------------------ interrupted takes */

  async function scanInterrupted() {
    const takes = await findInterruptedTakes();
    if (S.disposed) return;
    S.interrupted = takes;
    syncNotices();
  }

  async function recoverInterrupted() {
    const take = S.interrupted[0];
    if (!take || S.recovering) return;
    S.recovering = true;
    syncNotices();
    let project = null;
    let error = null;
    try {
      project = await recoverInterruptedTake(take);
    } catch (err) {
      error = err;
      console.error('[record] recovering an interrupted recording failed', err);
    }
    S.recovering = false;
    if (project) {
      toast(h('span', { class: 'rec-toast-msg' }, 'The recording was recovered to your library.',
        h('button', { type: 'button', class: 'btn btn-sm btn-secondary', onclick: () => { location.hash = `#/edit/${project.id}`; } }, 'Open')),
      { type: 'success', duration: 8000 });
    } else if (error) {
      toast(`Couldn't recover the recording. ${describeStorageError(error)}`, { type: 'error', duration: 8000 });
    }
    if (S.disposed) return;
    syncNotices();
    scanInterrupted();
  }

  async function discardInterrupted() {
    const take = S.interrupted[0];
    if (!take || S.recovering) return;
    const ok = await ask({
      title: 'Discard the interrupted recording?',
      message: "What was captured will be deleted. This can't be undone.",
      confirmText: 'Discard',
      danger: true,
    });
    if (!ok || S.disposed) return;
    try {
      await discardInterruptedTake(take);
    } catch (err) {
      console.error('[record] discarding an interrupted recording failed', err);
    }
    scanInterrupted();
  }

  /* ------------------------------------------------------------------ keyboard + lifecycle */

  function onKeyDown(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal-backdrop')) return; // dialogs handle their own keys
    if (e.key === 'Escape' && S.countdown) {
      e.preventDefault();
      cancelCountdown();
      return;
    }
    if (isTypingTarget(e) || isInteractive(e.target) || e.repeat) return;
    if (S.phase === 'setup' && e.key === 'Enter') {
      e.preventDefault();
      startRecording();
    } else if (S.phase === 'recording' && (e.key === ' ' || e.code === 'Space')) {
      e.preventDefault();
      togglePause();
    }
  }

  function onBeforeUnload(e) {
    const unsaved = S.phase === 'error' && S.result?.main?.size > 0; // the error card holds the only copy
    if (S.phase === 'recording' || S.phase === 'countdown' || S.phase === 'saving' || unsaved) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  container.replaceChildren(setup.root);
  document.title = `New recording${TITLE_SUFFIX}`;
  if (!support.media) {
    S.cam = { status: 'off', error: null };
    S.mic = { status: 'off', error: null };
  }
  syncAll();
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', onBeforeUnload);
  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  }
  S.raf = requestAnimationFrame(frame);
  refreshDevices();
  acquireInitial();
  scanInterrupted();

  return function cleanup() {
    // A hash navigation (browser Back, swipe-back, Cmd+[) fires no beforeunload, so a take in
    // progress (recording or paused) is saved to the library instead of being thrown away.
    const rescue = S.phase === 'recording' && Boolean(S.recorder);
    // A finish() already in flight releases the recorder, transcriber and devices itself once stopped.
    const finishing = S.phase === 'saving' && Boolean(S.recorder);
    // Leaving the error card of a take that couldn't be saved (browser Back, Cmd+[): the blobs in
    // memory are the only copy, so keep offering a download after the view is gone.
    const orphan = S.phase === 'error' && S.result?.main?.size ? S.result : null;
    S.disposed = true;
    cancelAnimationFrame(S.raf);
    ticker.clear();
    countdownTimer.clear();
    onDeviceChange.cancel();
    S.countdown = null;
    closeModal();
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (navigator.mediaDevices && typeof navigator.mediaDevices.removeEventListener === 'function') {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    }
    disarmActivation();
    const pip = S.pip;
    S.pip = null;
    pip?.close();
    if (rescue) {
      // finish() stops the recorder and transcriber, releases the camera and mic once the final
      // chunks are flushed, and saves to the library. While disposed it skips all UI and navigation.
      // Not awaited: the router waits for cleanup before it mounts the next view.
      finish().catch((err) => console.error('[record] saving after leaving failed', err));
    } else if (!finishing) {
      // 'countdown' and 'starting' have no recorded data yet ('starting' is settled by onCaptureReady).
      S.transcriber?.destroy();
      S.transcriber = null;
      S.recorder?.destroy();
      S.recorder = null;
      dropBackup();
      S.camToken += 1;
      S.micToken += 1;
      releaseCamera();
      releaseMic();
    }
    if (S.phase === 'error') {
      const r = S.result;
      S.result = null;
      r?.backup?.release(); // the take stays recoverable from its crash backup too
    }
    S.displaySurface = null;
    S.meter?.destroy();
    S.meter = null;
    if (S.hud?.camVideo) S.hud.camVideo.srcObject = null;
    setup.camVideo.srcObject = null;
    S.hud = null;
    document.title = previousTitle;
    if (orphan) rescueToast("Your recording wasn't saved", orphan);
  };
}

/* -------------------------------------------------------------------- helpers */

function detectSupport() {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return {
    media: Boolean(md && typeof md.getUserMedia === 'function'),
    display: Boolean(md && typeof md.getDisplayMedia === 'function'),
    recorder: isRecordingSupported(),
    speech: Transcriber.supported,
    pip: isPipSupported(),
  };
}

function loadPrefs(support) {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const prefs = { ...DEFAULT_PREFS };
  for (const [key, fallback] of Object.entries(DEFAULT_PREFS)) {
    if (typeof saved[key] === typeof fallback) prefs[key] = saved[key];
  }
  if (!RECORDING_MODES.some((m) => m.id === prefs.mode)) prefs.mode = DEFAULT_PREFS.mode;
  if (!support.display && prefs.mode !== 'cam') prefs.mode = 'cam';
  return prefs;
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode) — choices just aren't remembered */
  }
}

function displayOptions(systemAudio, controller = null) {
  const options = {
    video: { frameRate: 30, width: { ideal: 3840 }, height: { ideal: 2160 } },
    audio: Boolean(systemAudio),
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  };
  if (systemAudio) options.systemAudio = 'include';
  if (controller) options.controller = controller;
  return options;
}

function cameraConstraints(deviceId, exact = false) {
  const c = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (deviceId) c.deviceId = exact ? { exact: deviceId } : { ideal: deviceId };
  return c;
}

function micConstraints(deviceId, exact = false) {
  const c = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId && deviceId !== 'none') c.deviceId = exact ? { exact: deviceId } : { ideal: deviceId };
  return c;
}

/** NotAllowedError from the OS (e.g. macOS Privacy & Security), not from the site's permission. */
const isSystemDenied = (err) => err?.name === 'NotAllowedError' && /system/i.test(String(err?.message || ''));

/** 'granted' | 'denied' | 'prompt', or 'unknown' when the browser can't tell. */
async function permissionState(name) {
  try {
    return (await navigator.permissions.query({ name })).state;
  } catch {
    return 'unknown';
  }
}

const isDeviceSpecificError = (err) => ['OverconstrainedError', 'NotFoundError', 'NotReadableError', 'AbortError'].includes(err?.name);

function currentDeviceId(stream, kind) {
  const track = liveTrack(stream, kind);
  if (!track || typeof track.getSettings !== 'function') return '';
  return track.getSettings().deviceId || '';
}

function deviceLabel(device, index, fallback) {
  // Chrome appends USB vendor:product ids, e.g. "FaceTime HD Camera (05ac:8514)".
  const label = (device.label || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
  return label || `${fallback} ${index + 1}`;
}

function selectValue(select, value) {
  if (value && Array.from(select.options).some((o) => o.value === value)) select.value = value;
}

function isInteractive(target) {
  return Boolean(target && target.closest && target.closest('button, a[href], select, input, textarea, [contenteditable="true"]'));
}

function makeVideo(className) {
  const video = document.createElement('video');
  video.className = className;
  video.muted = true;
  video.defaultMuted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.disablePictureInPicture = true;
  return video;
}

function setVideoStream(video, stream) {
  if (!video) return;
  if (video.srcObject !== stream) video.srcObject = stream || null;
  if (stream && video.isConnected && video.paused) video.play().catch(() => {});
}

function buildRow({ tag = 'div', iconName, tone, title, desc, extra = null, control }) {
  const descEl = desc !== undefined ? h('span', { class: 'rec-row-desc' }, desc) : null;
  const el = h(tag, { class: 'rec-row' },
    h('span', { class: `rec-tile rec-tile-${tone}`, html: icon(iconName, 16) }),
    h('span', { class: 'rec-row-main' }, h('span', { class: 'rec-row-title' }, title), descEl, extra),
    control);
  return { el, desc: descEl };
}

function buildMeter(count, extraClass = '') {
  const bars = Array.from({ length: count }, (_, i) => h('i', {
    class: i >= Math.round(count * 0.9) ? 'peak' : i >= Math.round(count * 0.7) ? 'hot' : '',
  }));
  const el = h('span', { class: `rec-meter ${extraClass}`.trim(), 'aria-hidden': 'true' }, bars);
  let lit = -1;
  return {
    el,
    set(level) {
      const n = Math.round(clamp(level, 0, 1) * count);
      if (n === lit) return;
      lit = n;
      bars.forEach((bar, i) => bar.classList.toggle('on', i < n));
    },
  };
}

function buildDesk() {
  const lines = (n, className = '') => Array.from({ length: n }, () => h('i', { class: className }));
  return h('div', { class: 'rec-desk', 'aria-hidden': 'true' },
    h('div', { class: 'rec-desk-window' },
      h('div', { class: 'rec-desk-bar' }, h('i'), h('i'), h('i'), h('span', { class: 'rec-desk-url' })),
      h('div', { class: 'rec-desk-body' },
        h('div', { class: 'rec-desk-side' }, lines(5)),
        h('div', { class: 'rec-desk-content' },
          h('i', { class: 'rec-desk-heading' }),
          h('i', { class: 'rec-desk-line' }),
          h('i', { class: 'rec-desk-line is-short' }),
          h('div', { class: 'rec-desk-cards' }, lines(3))))),
    h('span', { class: 'rec-desk-cursor', html: icon('cursor', 18, { strokeWidth: 1.6 }) }));
}

/**
 * Host-aware timer: runs on the PiP window when it is open (never throttled while the tab is
 * hidden) and can be moved between windows with rearm() when the PiP window opens or closes.
 */
function createHostTimer(getHost) {
  let host = null;
  let id = null;
  let fn = null;
  let every = 0;
  let due = 0;
  const disarm = () => {
    if (id !== null && host) {
      try {
        if (every) host.clearInterval(id);
        else host.clearTimeout(id);
      } catch {
        /* the host window is gone */
      }
    }
    id = null;
  };
  const arm = () => {
    host = getHost();
    if (every) {
      id = host.setInterval(() => { if (fn) fn(); }, every);
    } else {
      id = host.setTimeout(() => {
        id = null;
        const cb = fn;
        fn = null;
        if (cb) cb();
      }, Math.max(0, due - performance.now()));
    }
  };
  return {
    timeout(cb, ms) { disarm(); every = 0; fn = cb; due = performance.now() + ms; arm(); },
    interval(cb, ms) { disarm(); every = ms; fn = cb; arm(); },
    rearm() { if (id !== null) { disarm(); arm(); } },
    clear() { disarm(); fn = null; },
  };
}

function describeDisplayError(err) {
  const name = err?.name || '';
  const message = String(err?.message || '');
  if (name === 'NotAllowedError') {
    if (/system/i.test(message)) {
      return {
        type: 'error',
        text: "Your browser isn't allowed to record the screen. On a Mac, open System Settings → Privacy & Security → Screen & System Audio Recording, turn on your browser, then restart it.",
      };
    }
    return { type: 'info', text: 'Screen sharing was cancelled. Pick a screen, window or tab to start recording.' };
  }
  if (name === 'NotFoundError') return { type: 'error', text: 'There is no screen available to record.' };
  if (name === 'NotReadableError' || name === 'AbortError') {
    return { type: 'error', text: "Couldn't start screen capture. Close other apps that might be recording, then try again." };
  }
  if (name === 'InvalidStateError') return { type: 'error', text: 'Click “Start recording” again to choose what to share.' };
  if (name === 'TypeError' || name === 'NotSupportedError') return { type: 'error', text: "Screen recording isn't supported in this browser." };
  return { type: 'error', text: message ? `Couldn't start screen capture: ${message}` : "Couldn't start screen capture." };
}

function describeDeviceError(err, kind) {
  const Kind = kind.charAt(0).toUpperCase() + kind.slice(1);
  if (isSystemDenied(err)) {
    // The address bar already shows the site as allowed; the block is in the OS privacy settings.
    return IS_APPLE
      ? `Your Mac isn't letting your browser use the ${kind}. Open System Settings → Privacy & Security → ${Kind}, turn on your browser, then try again (restart the browser if it still doesn't work).`
      : `Your computer's privacy settings aren't letting your browser use the ${kind}. Allow ${kind} access for your browser in your system settings, then try again.`;
  }
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `${Kind} access is blocked. Allow it from the address bar, then try again.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${kind} was found.`;
    case 'NotReadableError':
    case 'AbortError':
      return `Your ${kind} is being used by another app.`;
    case 'Ended':
      return `Your ${kind} was disconnected.`;
    default:
      return `Couldn't start your ${kind}.`;
  }
}

function describeStorageError(err) {
  if (err?.name === 'QuotaExceededError') {
    return 'Your browser is out of storage space for Dolly. Download this recording, then delete old recordings to free up space.';
  }
  return err?.message ? `Something went wrong while saving (${err.message}).` : 'Something went wrong while saving.';
}

/**
 * A new project for a finished take. `info` is probeVideo's result, or null to go by the
 * recorder's own clock and track settings.
 */
function projectFromResult(r, info) {
  const duration = info && Number.isFinite(info.duration) && info.duration > 0 ? info.duration : Math.max(0.1, r.duration || 0);
  const main = {
    width: info?.width || r.mainSize?.width || 1920,
    height: info?.height || r.mainSize?.height || 1080,
  };
  const camera = r.camera && r.camera.size
    ? { width: r.cameraSize?.width || 1280, height: r.cameraSize?.height || 720 }
    : null;
  const mode = r.mode === 'screen+cam' && !camera ? 'screen' : r.mode;
  return createProject({ duration, mode, main, camera, transcript: cleanTranscript(r.segments, duration) });
}

/**
 * The take is already in the library: read the file back for its exact duration and size, add
 * a thumbnail, and update the stored project, but only while nobody has edited it yet (a
 * guarded write). Resolves with the stored project; never rejects.
 */
async function finishSavedRecording(saved, r) {
  let info = null;
  try {
    info = await probeVideo(r.main, r.duration);
  } catch {
    info = null; // keep the recorder's clock and track settings
  }
  const next = projectFromResult(r, info);
  Object.assign(next, { id: saved.id, title: saved.title, createdAt: saved.createdAt });
  next.thumbnail = await makeThumbnail(r.main, next.duration);
  const same = next.duration === saved.duration
    && next.source.width === saved.source.width
    && next.source.height === saved.source.height;
  if (same && !next.thumbnail) return saved;
  try {
    next.updatedAt = await updateProject(next, saved.updatedAt);
    return next;
  } catch (err) {
    // ConflictError: it was opened and edited meanwhile, so that version wins. NotFoundError:
    // deleted meanwhile. Otherwise the recording is safe, just without the extra details.
    if (err?.name !== 'ConflictError' && err?.name !== 'NotFoundError') console.warn('[record] could not finish saving the recording details', err);
    return saved;
  }
}
