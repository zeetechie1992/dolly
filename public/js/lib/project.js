// Project data model, defaults and shared constants. This file is the single
// source of truth for the shape of a project — see ARCHITECTURE.md.

import { uid, clamp } from './util.js';

/** Output canvas sizes per aspect ratio ("orientation"). */
export const ASPECTS = [
  { id: '16:9', name: 'Landscape', hint: 'YouTube, Loom', icon: 'landscape', width: 1920, height: 1080 },
  { id: '9:16', name: 'Portrait', hint: 'Reels, TikTok, Shorts', icon: 'portrait', width: 1080, height: 1920 },
  { id: '1:1', name: 'Square', hint: 'Feeds', icon: 'square', width: 1080, height: 1080 },
  { id: '4:5', name: 'Vertical', hint: 'Instagram, LinkedIn', icon: 'portrait', width: 1080, height: 1350 },
];
export const getAspect = (id) => ASPECTS.find((a) => a.id === id) || ASPECTS[0];

/**
 * Background presets. `kind`:
 *   mesh  — soft multi-point gradient; `colors` are 3–4 hex stops (renderer blends them as radial blobs over colors[0])
 *   solid — single `colors[0]`
 *   blur  — blurred, enlarged copy of the recording itself (colors unused)
 * `css` is a CSS background used for swatches in the UI.
 */
export const BACKGROUNDS = [
  { id: 'sonoma', name: 'Sonoma', kind: 'mesh', colors: ['#ff9a62', '#ff5e8a', '#ffc46b', '#c86bff'], css: 'radial-gradient(at 20% 20%, #ffc46b, transparent 55%), radial-gradient(at 80% 30%, #ff5e8a, transparent 55%), radial-gradient(at 50% 90%, #c86bff, transparent 60%), #ff9a62' },
  { id: 'ventura', name: 'Ventura', kind: 'mesh', colors: ['#4f46e5', '#22d3ee', '#a855f7', '#1e3a8a'], css: 'radial-gradient(at 15% 25%, #22d3ee, transparent 55%), radial-gradient(at 85% 20%, #a855f7, transparent 55%), radial-gradient(at 50% 95%, #1e3a8a, transparent 60%), #4f46e5' },
  { id: 'dolly', name: 'Dolly', kind: 'mesh', colors: ['#5e5ce6', '#a35bf0', '#7a78ff', '#ff7ac6'], css: 'radial-gradient(at 20% 20%, #7a78ff, transparent 55%), radial-gradient(at 80% 25%, #a35bf0, transparent 55%), radial-gradient(at 60% 95%, #ff7ac6, transparent 60%), #5e5ce6' },
  { id: 'aurora', name: 'Aurora', kind: 'mesh', colors: ['#0f766e', '#34d399', '#22d3ee', '#065f46'], css: 'radial-gradient(at 20% 20%, #34d399, transparent 55%), radial-gradient(at 80% 30%, #22d3ee, transparent 55%), radial-gradient(at 50% 95%, #065f46, transparent 60%), #0f766e' },
  { id: 'sunset', name: 'Sunset', kind: 'mesh', colors: ['#f97316', '#facc15', '#ef4444', '#7c2d12'], css: 'radial-gradient(at 20% 20%, #facc15, transparent 55%), radial-gradient(at 80% 30%, #ef4444, transparent 55%), radial-gradient(at 50% 95%, #7c2d12, transparent 60%), #f97316' },
  { id: 'cotton', name: 'Cotton', kind: 'mesh', colors: ['#fbcfe8', '#c7d2fe', '#bae6fd', '#fde68a'], css: 'radial-gradient(at 20% 20%, #c7d2fe, transparent 55%), radial-gradient(at 80% 30%, #bae6fd, transparent 55%), radial-gradient(at 50% 95%, #fde68a, transparent 60%), #fbcfe8' },
  { id: 'midnight', name: 'Midnight', kind: 'mesh', colors: ['#0b1020', '#312e81', '#1e1b4b', '#0e7490'], css: 'radial-gradient(at 20% 20%, #312e81, transparent 55%), radial-gradient(at 80% 30%, #1e1b4b, transparent 55%), radial-gradient(at 50% 95%, #0e7490, transparent 60%), #0b1020' },
  { id: 'graphite', name: 'Graphite', kind: 'mesh', colors: ['#2c2c2e', '#48484a', '#1c1c1e', '#636366'], css: 'radial-gradient(at 20% 20%, #48484a, transparent 55%), radial-gradient(at 80% 30%, #1c1c1e, transparent 55%), radial-gradient(at 50% 95%, #636366, transparent 60%), #2c2c2e' },
  { id: 'blur', name: 'Blurred', kind: 'blur', colors: [], css: 'linear-gradient(135deg, #8e8e93, #c7c7cc)' },
  { id: 'white', name: 'White', kind: 'solid', colors: ['#ffffff'], css: '#ffffff' },
  { id: 'paper', name: 'Paper', kind: 'solid', colors: ['#f2efe9'], css: '#f2efe9' },
  { id: 'black', name: 'Black', kind: 'solid', colors: ['#000000'], css: '#000000' },
];
export const getBackground = (id) => BACKGROUNDS.find((b) => b.id === id) || BACKGROUNDS[0];

/** Caption style ids — the visual implementation lives in editor/captions.js. */
export const CAPTION_STYLE_IDS = ['minimal', 'clean', 'bold', 'karaoke', 'subtitle', 'glass'];

export const RECORDING_MODES = [
  { id: 'screen+cam', name: 'Screen + Camera', icon: 'screen-cam' },
  { id: 'screen', name: 'Screen only', icon: 'monitor' },
  { id: 'cam', name: 'Camera only', icon: 'camera' },
];

export const ZOOM_DEFAULTS = { scale: 1.8, duration: 2.5, minDuration: 0.6, transition: 0.65 };

/** Default edit settings — also used by migrateProject to fill missing keys. */
export function defaultEdit(duration = 0, { hasCamera = false, mode = 'screen' } = {}) {
  const isCamOnly = mode === 'cam';
  return {
    trim: { start: 0, end: duration },
    aspect: '16:9',
    fit: 'fit',                    // 'fit' (letterbox inside background) | 'fill' (crop to fill output)
    background: isCamOnly ? 'graphite' : 'sonoma',
    padding: isCamOnly ? 0.06 : 0.08, // fraction of the output's shorter side, 0..0.2
    radius: 18,                    // px at 1080p-equivalent (scaled by output short side / 1080), 0..48
    shadow: 0.6,                   // 0..1
    windowChrome: 'none',          // 'none' | 'light' | 'dark' (macOS-style title bar above the recording)
    camera: {
      visible: hasCamera,
      shape: 'circle',             // 'circle' | 'rounded' | 'square'
      size: 0.22,                  // diameter as a fraction of the output's shorter side, 0.1..0.45
      x: 0.86, y: 0.8,             // normalized center position within the output
      mirror: true,
      border: true,
    },
    zooms: [],                     // [{ id, start, end, scale, x, y, auto }] — sorted by start, never overlapping
    captions: {
      enabled: true,
      style: 'minimal',            // one of CAPTION_STYLE_IDS
      position: 'bottom',          // 'bottom' | 'middle' | 'top'
      size: 'M',                   // 'S' | 'M' | 'L'
    },
  };
}

/**
 * Creates a new project object (not yet saved).
 * @param {object} p
 * @param {number} p.duration seconds of the main recording
 * @param {'screen'|'screen+cam'|'cam'|'import'} p.mode
 * @param {{width:number,height:number}} p.main  main video pixel size
 * @param {{width:number,height:number}|null} p.camera camera video pixel size, if recorded
 * @param {Array} [p.transcript]
 * @param {string} [p.title]
 */
export function createProject({ duration, mode, main, camera = null, transcript = [], title }) {
  const now = Date.now();
  const hasCamera = Boolean(camera);
  return {
    id: uid('p_'),
    version: 1,
    title: title || defaultTitle(now),
    createdAt: now,
    updatedAt: now,
    duration,
    mode,
    source: {
      width: main?.width || 1920,
      height: main?.height || 1080,
      hasCamera,
      cameraWidth: camera?.width || 0,
      cameraHeight: camera?.height || 0,
    },
    thumbnail: null,               // small JPEG data URL
    transcript,                    // [{ id, start, end, text }] — seconds, source timeline
    transcriptSource: transcript.length ? 'live' : 'none', // 'live' | 'manual' | 'none'
    edit: defaultEdit(duration, { hasCamera, mode }),
    summary: null,                 // see summary shape in ARCHITECTURE.md
  };
}

function defaultTitle(ts) {
  const d = new Date(ts);
  return `Recording – ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** Fills in any keys missing from older/partial projects. Mutates and returns the project. */
export function migrateProject(p) {
  const defaults = defaultEdit(p.duration, { hasCamera: p.source?.hasCamera, mode: p.mode });
  p.edit = { ...defaults, ...(p.edit || {}) };
  p.edit.trim = { ...defaults.trim, ...(p.edit.trim || {}) };
  p.edit.camera = { ...defaults.camera, ...(p.edit.camera || {}) };
  p.edit.captions = { ...defaults.captions, ...(p.edit.captions || {}) };
  p.edit.zooms = Array.isArray(p.edit.zooms) ? p.edit.zooms : [];
  p.transcript = Array.isArray(p.transcript) ? p.transcript : [];
  p.edit.trim.start = clamp(p.edit.trim.start, 0, p.duration);
  p.edit.trim.end = clamp(p.edit.trim.end || p.duration, p.edit.trim.start, p.duration);
  return p;
}

/** Trimmed length in seconds. */
export const trimmedDuration = (p) => Math.max(0, p.edit.trim.end - p.edit.trim.start);
