# Dolly — architecture & module contracts

Dolly is a Loom-style screen recorder with a Screen Studio-style editor.
Flow: **Record → Editor (Edit → Captions → Summary) → Export or Share** (share links: see "Sharing" at the end).

- Plain ES modules + CSS, **no build step, no npm, no frameworks, no TypeScript**. Runs in Chrome (primary target), works in Edge/Arc; Safari/Firefox should degrade gracefully (feature-detect, never crash).
- `python3 server.py` serves `public/` at http://localhost:8000 and provides `/api/status`, `/api/summarize` (Claude) and the share-link routes (`sharing.py`).
- `python3 tools/check.py` syntax-checks every module (via macOS `jsc`) and verifies that every named import exists. **Run it on every file you touch. It must pass.**
- All recordings live in the browser (IndexedDB). Nothing is uploaded unless the owner creates a share link: then the rendered video, its poster and the link's metadata go to Dolly's own server (see **Sharing** at the end).

## Design language ("Apple-style SaaS")

Dolly should feel like a first-party Apple app crossed with Loom: calm, precise, premium.

- **Use the tokens** in `css/tokens.css` for every color/radius/shadow/spacing/font. Never hard-code colors in view CSS (canvas drawing code may use literal colors). Both light and dark mode must look right.
- **Reuse components** from `css/base.css`: `.btn` (+ `.btn-primary`, `.btn-secondary`, `.btn-tinted`, `.btn-ghost`, `.btn-danger`, `.btn-record`, `.btn-icon`, sizes `.btn-sm/.btn-lg/.btn-xl`), `.card`, `.nav` (frosted bar), `.logo`, `.segmented`, `.switch`, `.toggle-row`, `input.slider` (call `syncSliderFill(input)` after changing value), `.input/.select/.textarea`, `.field/.label`, `.chip`, `.badge`, `.kbd`, `.swatch-grid/.swatch`, `.option-grid/.option-card`, `.panel-section/.section-title`, `.spinner`, `.progress`, `.skeleton`, `.empty-state`, `[data-tip]` tooltips, keyframes (`rise-in`, `pulse-rec`, `fade-in`, `pop-in`).
- Typography: SF Pro (system) via `--font`; tight tracking on headlines; sentence-case labels ("New recording", "Export video"). Short, friendly copy.
- Generous whitespace on a 4/8pt grid, large radii (12–22px), hairline separators (`--separator`), frosted glass bars, soft layered shadows, a single accent (`--accent`, indigo). Red (`--red`) only for recording/destructive.
- Motion: 120–420ms, `--ease-out`; buttons scale to .97 on press; content rises in (`rise-in`) with small staggers. Respect reduced motion (base.css handles it).
- Icons only from `js/lib/icons.js` → `icon(name, size)` returns an SVG string. Available names are the keys of `P` in that file — do not invent new names without adding the path there (only the foundation owner edits icons.js; if you need one, use the closest existing icon).

## Shared foundation (already written — import, do not modify unless told)

| File | Exports |
|---|---|
| `js/lib/util.js` | `$`, `$$`, `h(tag, props, ...children)`, `clamp`, `lerp`, `invLerp`, `easeInOutCubic`, `easeInOutSine`, `easeOutCubic`, `uid(prefix)`, `formatTime(sec, {ms})`, `formatRelativeDate(ts)`, `formatBytes`, `debounce` (has `.flush/.cancel`), `throttleRaf`, `sleep`, `deepClone`, `syncSliderFill(input)`, `downloadBlob(blob, name)`, `slugify`, `copyText`, `isTypingTarget(e)`, `class Emitter {on, off, emit}` |
| `js/lib/icons.js` | `icon(name, size=18, {strokeWidth, className})`, `ICON_NAMES` |
| `js/lib/db.js` | `listProjects()`, `listProjectStamps()`, `getProject(id)`, `saveProject(p)`, `createProjectWithMedia(p, {main, camera})`, `updateProject(p, baseUpdatedAt)`, `patchProject(id, patch)`, `deleteProject(id)`, `putMedia(id, kind, blob)`, `getMedia(id, kind)`, `sweepOrphanMedia()`, `onProjectChange(fn)`, `mediaKey`, `storageEstimate()`, pending-take store: `putPending`, `listPendingTakes`, `getPendingChunks`, `clearPending`; kind is `'main'` or `'camera'` (see **Persistence** below) |
| `js/lib/project.js` | `ASPECTS`, `getAspect(id)`, `BACKGROUNDS`, `getBackground(id)`, `CAPTION_STYLE_IDS`, `RECORDING_MODES`, `ZOOM_DEFAULTS`, `defaultEdit()`, `createProject({duration, mode, main, camera, transcript, title})`, `migrateProject(p)`, `trimmedDuration(p)` |
| `js/lib/media.js` | `loadVideo(blobOrUrl, {muted, knownDuration}) → Promise<HTMLVideoElement>` (fixes WebM Infinity duration), `seekVideo(video, t)`, `probeVideo(blob, knownDuration) → {duration,width,height,hasAudio}`, `captureThumbnail(video, t, w, h) → dataURL`, `pickMimeType(list)`, `RECORDING_MIME_TYPES`, `stopStream(stream)` |
| `js/lib/ui.js` | `toast(msg, {type:'info'|'success'|'error', duration}) → {el, close}` (msg may be a Node; `duration` ≤ 0, non-finite or > 2^31-1 = persistent with a × button), `openModal({title, description, content, actions, dismissible, width, onClose}) → {el, body, close}`, `confirmDialog({...}) → Promise<bool>`, `promptDialog({...}) → Promise<string|null>`, `openMenu(anchor, items)`, `getTheme/applyTheme/isDark`, `logo()` |
| `js/editor/store.js` | `createStore(project) → EditorStore` (see below) |
| `js/main.js` | hash router. Views export `mount(container, params) → cleanup fn` (may be async). Navigate with `location.hash = '#/edit/' + id`. |

## Data model (`lib/project.js`)

```js
Project = {
  id: 'p_xxx', version: 1, title, createdAt, updatedAt,
  duration,                       // seconds of the main recording (source timeline)
  mode: 'screen+cam' | 'screen' | 'cam' | 'import',
  source: { width, height, hasCamera, cameraWidth, cameraHeight },
  thumbnail: dataURL | null,      // 480x270 JPEG
  transcript: [{ id: 's_xxx', start, end, text }],   // source seconds, sorted by start
  transcriptSource: 'live' | 'manual' | 'none',
  edit: {
    trim: { start, end },
    aspect: '16:9' | '9:16' | '1:1' | '4:5',          // "orientation"
    fit: 'fit' | 'fill',
    background: <BACKGROUNDS id>,
    padding: 0..0.2, radius: 0..48, shadow: 0..1,
    windowChrome: 'none' | 'light' | 'dark',
    camera: { visible, shape: 'circle'|'rounded'|'square', size: 0.1..0.45, x: 0..1, y: 0..1, mirror, border },
    zooms: [{ id: 'z_xxx', start, end, scale: 1.1..4, x: 0..1, y: 0..1, auto: bool }],  // sorted, non-overlapping, each ≥ 0.6s
    captions: { enabled, style: <CAPTION_STYLE_IDS>, position: 'bottom'|'middle'|'top', size: 'S'|'M'|'L' },
  },
  summary: null | Summary,
}
Summary = { title, tldr, key_points: string[], action_items: string[], chapters: [{start, title}],
            source: 'ai' | 'local', model: string|null, generatedAt: ms, transcriptHash: string }
```

**Time:** every time value (playhead, trim, zooms, transcript, chapters) is in **source seconds** (0…duration). Trim only limits playback/export.

**Media:** main video blob at `getMedia(id, 'main')`; camera blob (screen+cam mode only) at `getMedia(id, 'camera')`. The camera blob has **no audio**; all audio (mic + system) is in main. In `cam` mode, main *is* the camera footage and there is no camera blob. Main and camera recordings start together, so `camera.currentTime === main.currentTime` keeps them in sync.

## Persistence (`lib/db.js`)

IndexedDB `dolly`, **version 2**. Stores: `projects` (keyPath `id`, index `updatedAt`), `media` (blobs at `mediaKey(id, kind)` = `` `${id}:${kind}` ``), `pending` (crash backup of takes being recorded; added in v2 — the upgrade only creates missing stores, existing data is kept). A tab running an older Dolly can hold the old version open and block the upgrade; `db.js` then dispatches `dolly:db-blocked` / `dolly:db-unblocked` on `window` and `main.js` shows a persistent "close or reload its other tabs" toast.

```js
// Creating
createProjectWithMedia(project, { main, camera = null }) → Promise<project>
  // project + blobs in ONE transaction (all or nothing); sets updatedAt; rejects (ConstraintError) if the id exists.
  // Every new project that has media MUST be created this way (import, record, recovery).
saveProject(project)               // unconditional put, sets updatedAt; only for new projects without media
putMedia(id, kind, blob)           // replace a blob of an EXISTING project only

// Editing an existing project (never clobbers another tab's write)
updateProject(project, baseUpdatedAt) → Promise<newUpdatedAt>
  // guarded whole-record replace in one transaction: writes only if the stored updatedAt === baseUpdatedAt.
  // Does not mutate `project`. Rejects with an Error named 'NotFoundError' (deleted) or 'ConflictError' (err.current = stored record).
patchProject(id, patch) → Promise<savedRecord>   // get → Object.assign → put in one transaction, bumps updatedAt; 'NotFoundError' if missing
deleteProject(id)                  // project + both blobs in one transaction

// Reading
listProjects()                     // newest updatedAt first
listProjectStamps() → Promise<string>   // sorted `id:updatedAt` joined by '|', from the index (no records read): cheap change check
getProject(id), getMedia(id, kind)

// Change notifications: every committed write (save/create/update/patch/delete) announces
//   { type: 'saved' | 'deleted', id, updatedAt? }
onProjectChange(fn) → unsubscribe  // writes made in OTHER tabs (BroadcastChannel 'dolly')
window 'dolly:projects-changed'    // CustomEvent, detail = same message, for writes made in THIS tab

// Housekeeping
sweepOrphanMedia() → Promise<removedCount>
  // deletes media whose project doesn't exist (left by older multi-step saves), in one transaction over
  // projects + media. Safe across tabs only because all new media is written with createProjectWithMedia.
  // Pending takes live in their own store and are never touched. home.js runs it once per page session.

// Pending takes (used only by recorder/recovery.js). Keys [takeId, kind, seq]: kind 'main' | 'camera'
// chunks (seq from 0, one per recorder timeslice), [takeId, 'meta', 0] = { mode, createdAt },
// [takeId, 'transcript', 0] = segments.
putPending(takeId, kind, seq, value)
listPendingTakes() → [{ id, meta, kinds: { main: n, camera: n, … } }]   // no blobs read
getPendingChunks(takeId, kind) → values in seq order, stopping at the first gap
clearPending(takeId)
```

## EditorStore (`editor/store.js`)

```js
store.project                      // live project object (mutate ONLY via update)
store.update(p => { p.edit.padding = 0.1 }, { coalesce: 'padding' })   // undoable; autosaves (debounced)
store.update(fn, { history: false })                                     // non-undoable change
store.setSummary(summary)          // non-undoable
store.undo(); store.redo(); store.canUndo; store.canRedo
store.ui                           // { step: 'edit'|'captions'|'summary', selectedZoomId, selectedCaptionId, time, playing, saving, summaryStatus: 'idle'|'loading'|'error', summaryError, autoZoomRunning }
store.setUI({ selectedZoomId: id })
store.onChange((project, {reason}) => …) → unsubscribe    // 'change' event; reason 'undo' | 'redo' | 'summary' | free-form
store.onUI((ui, changedKeys) => …) → unsubscribe           // 'ui' event
store.on('saved', (project) => …)
store.on('save-error', (err) => …)  // err.reason: 'failed' | 'conflict' | 'deleted' (see below)
await store.flush()                // save now (call on unmount); resolves true when saved, false otherwise; never rejects
store.saveBlocked                  // null | 'conflict' | 'deleted'
await store.keepMine()             // resolve a 'conflict' by overwriting the stored version (except project.share: the stored link,
                                   // with its owner token, is kept unless the database has none); resolves true when saved
store.destroy()                    // stop listening for other tabs' writes; call after the final flush()
```
**Saving.** Autosave is debounced and serialized, and goes through `updateProject(project, base)` (optimistic concurrency on `updatedAt`). Save errors carry `err.reason`:
- `'failed'` — a storage error (e.g. quota). Retried on the next edit/flush.
- `'conflict'` — another tab saved this recording since it was loaded (detected by the guarded write, or immediately via `onProjectChange`). Autosave pauses; every save attempt re-emits `save-error` without touching the database until the user reloads (re-mount the editor) or calls `keepMine()`.
- `'deleted'` — the recording was deleted elsewhere. Terminal: nothing is ever saved again (no resurrection).

**Undo for gestures.** One gesture = one undo step. Slider drags (`sliderControl` passes `{ history: true }` for the first write and `{ history: false }` after), the camera-bubble drag in the preview and timeline trim/zoom-pill drags record their first write with history and the rest without. If ⌘Z / ⇧⌘Z lands mid-gesture (`reason` 'undo'/'redo'), the gesture is re-armed (`slider.rearm()`, `gesture.recorded = false`, `drag.recorded = false`) so the rest of it opens a fresh undo step instead of silently editing the restored state. Keyboard and other discrete edits use `coalesce` keys.

## Module contracts

### Renderer — `editor/renderer.js`, `editor/backgrounds.js`, `editor/zoom.js`

```js
// renderer.js
getOutputSize(project, maxLongSide = Infinity) → { width, height }      // from ASPECTS, scaled down to fit maxLongSide (rounded to even ints)
computeLayout(project, width, height) → Layout
  Layout = { width, height, s,                       // s = min(width,height)/1080 (scale for px constants)
             frame: { x, y, w, h, radius },          // the rounded "window" (includes chrome bar)
             content: { x, y, w, h },                // where video pixels go (frame minus chrome bar)
             chrome: { x, y, w, h } | null,
             camera: { x, y, size, shape } | null }  // bubble bounding box (top-left + size px); null if hidden/no camera
drawFrame(ctx, { project, time, main, camera = null, width, height, captionChunks = null, showCaptions = true })
  // Draws one complete output frame for `time` (source seconds) assuming `main`/`camera` (HTMLVideoElement)
  // are already showing that time. Order: background → shadow → frame clip → zoomed content → chrome → camera bubble → captions.
  // Captions drawn via captions.drawCaptions when showCaptions && captionChunks && project.edit.captions.enabled.
  // Must not throw when videos have no frame yet (readyState < 2) — draw background + frame placeholder.
hitTestCamera(project, width, height, x, y) → boolean   // x,y in output px
```
Layout math: `s = min(W,H)/1080`. **fit**: `pad = padding * min(W,H)`; chrome bar height `round(30*s)` when `windowChrome !== 'none'`; largest content rect with the source aspect such that frame fits in `(W-2pad) × (H-2pad)`; frame centered; `radius * s` corner radius; shadow strength from `shadow`. **fill**: content = whole output, cover-cropped, no frame radius/shadow/chrome. Camera bubble: diameter `camera.size * min(W,H)`, centered at `(camera.x*W, camera.y*H)`, clamped to stay ≥ `16*s` inside the output; `circle` | `rounded` (radius 22% of size) | `square` (radius 6*s); optional 3*s white border and soft shadow; mirrored if `camera.mirror`; cover-crop the camera video to a square. In `cam` mode mirror the main video when `camera.mirror`. Background: `mesh` = colors[0] fill + 3 large soft radial blobs of the other colors (+ subtle grain), cached per (id, W, H) in an offscreen canvas; `solid`; `blur` = main video drawn into a tiny (~1/10) offscreen canvas then upscaled (cheap blur) with a slight darken.
Zoom: with state `{scale, x, y}`, source crop `sw = srcW/scale, sh = srcH/scale`, centered on `(x*srcW, y*srcH)`, clamped inside the source (in fill mode, inside the cover-crop rect), drawn into `content`.

```js
// zoom.js
zoomStateAt(zooms, time, transition = ZOOM_DEFAULTS.transition) → { scale, x, y }   // x,y = focus (0..1); scale 1 when no zoom
  // Ease in over `transition` seconds after zoom.start, hold, ease out over `transition` before zoom.end
  // (transition shrinks to ≤ 40% of a short zoom). Smooth (easeInOutCubic). If the gap between two zooms is
  // < 2*transition, stay zoomed and pan/scale smoothly from the first to the second instead of dipping to 1×.
clampFocus(scale, x, y) → { x, y }           // keeps the crop inside the source
findZoomSlot(project, time, duration = ZOOM_DEFAULTS.duration) → { start, end } | null   // free gap starting at/after time within trim; null if < minDuration
constrainZoom(project, zoomId, start, end, mode: 'move'|'start'|'end') → { start, end }   // no overlap with neighbours, ≥ minDuration, inside [0, duration]
detectAutoZooms(mainBlobOrUrl, { duration, trim, signal, onProgress }) → Promise<Zoom[]>   // auto:true zooms, ids via uid('z_')
  // Motion analysis: sample frames (downscaled ~160px wide) every max(0.5, duration/600) s using a private <video>
  // (when that step is over 0.6 s, runs of localized change are re-sampled at 0.5 s — shortest first, at most ~600
  // extra frames — so long and short recordings give the same zooms),
  // diff consecutive frames, find sustained (≥1.2s) bursts of *localized* change (changed-pixel bbox < ~45% of frame);
  // focus = change centroid, scale from bbox size (1.5–2.4). Merge nearby bursts, max ~1 zoom per 6s, skip global changes (scrolls/page switches).
```

### Captions & summary — `editor/captions.js`, `editor/summary.js`

```js
// captions.js
CAPTION_STYLES → [{ id, name, description }]       // ids === CAPTION_STYLE_IDS, same order. 'minimal' first.
  // minimal: small clean white text, soft shadow, no box  · clean: white rounded card, dark text (Apple-like)
  // bold: big heavy uppercase, 1–3 words at a time, pop-in, active word in accent yellow  · karaoke: line with words lighting up progressively
  // subtitle: classic translucent black bar  · glass: frosted dark pill, active word brighter
buildCaptionChunks(transcript, { maxWords = 7, maxChars = 42 } = {}) → [{ start, end, text, words: [{ text, start, end }] }]
  // splits segments into short lines; word times distributed across the segment by character length
activeChunkAt(chunks, time) → chunk | null
drawCaptions(ctx, { chunks, time, captions: project.edit.captions, layout })     // positions relative to the output (layout.width/height, layout.s); avoid overlapping the camera bubble when it sits in the same area
drawCaptionPreview(canvas, styleId) → void          // sample caption on a small gradient, for the style picker cards
toSRT(chunks) → string; toVTT(chunks) → string
```

```js
// summary.js
aiStatus() → Promise<{ ai: boolean, model: string|null }>    // GET /api/status, cached; never throws
transcriptHash(transcript) → string
localSummary(project) → Summary                     // extractive fallback (no network): title from keywords, tldr = top sentence(s), 3–5 key points, chapters by time buckets; source:'local'
generateSummary(project, { signal } = {}) → Promise<Summary>   // POST /api/summarize {segments, duration}; on 503/network failure falls back to localSummary; throws only on abort
summaryToMarkdown(summary, project) → string
```

### Player — `editor/player.js`

```js
const player = await Player.create({ project, mainBlob, cameraBlob })   // uses loadVideo; main unmuted, camera muted
player.main, player.camera (HTMLVideoElement|null), player.mainUrl, player.cameraUrl
player.time, player.playing, player.duration
player.play(); player.pause(); player.toggle(); player.seek(t)          // seek clamps to project.edit.trim (reads store/project live)
player.on('time', t) // every animation frame while playing, and after seeks
player.on('play') / ('pause') / ('ended')                               // stops at trim.end
player.on('frame')  // the frame for player.time is ready to draw (after seeked / each rAF while playing)
player.destroy()    // pauses, revokes URLs
```
Player keeps camera in sync with main (resync if drift > 0.12s) and mirrors `time/playing` into `store.ui` via `store.setUI` when constructed with `{ store }` too: `Player.create({ project, mainBlob, cameraBlob, store })`.

### Preview — `editor/preview.js`

```js
const preview = createPreview({ store, player })   // → { el, destroy(), redraw() }
```
Canvas fitted (letterboxed) into its container with the output aspect, backing size = CSS size × devicePixelRatio (long side ≤ 2400). Redraws on player 'frame'/'time', store change, resize. Caption chunks rebuilt when transcript changes. Drag the camera bubble to move it (`store.update(..., {coalesce:'camera-move'})`, cursor `grab`); plain click toggles play.

### Timeline — `editor/timeline.js` (+ `css/timeline.css`)

```js
const timeline = new Timeline({ store, player })   // timeline.el → mount at the bottom of the editor
timeline.addZoomAtPlayhead()   // uses findZoomSlot; selects the new zoom; toast if no room
timeline.deleteSelected()      // deletes store.ui.selectedZoomId
timeline.runAutoZoom()         // detectAutoZooms on player.mainUrl → replaces existing auto zooms (keeps manual ones that don't overlap); progress + cancel. Re-entrant calls share one run.
timeline.autoZoomJob           // getter: the in-flight run's promise, or null; while it runs store.ui.autoZoomRunning === true
timeline.destroy()
```
Contents: toolbar (play/pause, `current / total` time in mono, "+ Zoom", "Auto zoom" (sparkles), delete-selected, timeline zoom −/+), time ruler, video track (thumbnail filmstrip with trim handles; outside-trim area dimmed), zoom track (pills showing scale e.g. "1.8×"; drag to move, drag edges to resize, click to select, double-click empty space to add), captions track (read-only blocks from transcript; click selects caption `selectedCaptionId` and seeks). Draggable red playhead; click/drag ruler to scrub. Horizontal scroll when zoomed in. Uses `constrainZoom` for all zoom drags, `coalesce` for drags.

### Editor shell — `views/editor.js` (+ `css/editor.css`)

`mount(container, { id })`: loads project (`getProject` → `migrateProject`) and media, creates store, player, preview, timeline, panels. Shows a polished loading state and a friendly "not found" state.
Layout (full viewport, no page scroll): **top bar** (frosted): back to library, inline-editable title, save status ("Saved" / "Saving…"), centered **stepper** segmented control `1 Edit · 2 Captions · 3 Summary`, right side: undo/redo, keyboard-shortcuts button, **Share** (⇧⌘S → `openShareDialog`; a progress pill next to it while a share job renders/uploads), **Export** primary → `openExportDialog`. **Stage** (left/center, `--stage` background) holds the preview. **Inspector** (right, `--inspector-width`) shows the panel for the current step; on the Edit step it shows the Zoom panel while a zoom is selected, otherwise the Design panel. **Timeline** across the bottom.
Global shortcuts: Space play/pause · ←/→ ±1s (Shift ±5s) · Z add zoom · Delete/Backspace delete selected zoom · Esc deselect · ⌘Z / ⇧⌘Z undo/redo · 1/2/3 switch steps · ⌘E export · ? shortcuts sheet. Ignore when `isTypingTarget(e)`.
On mount call `autoSummarize(store)` so the summary is ready by the time the user reaches step 3. Cleanup flushes the store (unless saving is blocked), destroys everything, calls `clearBackgroundCache()` (backgrounds.js) and `clearFrameCache()` (panels/zoom.js) to free module-level canvases, then `store.destroy()`.
Save status: "Saving…" / "Saved" / "Not saved" (storage error; toast once until a save succeeds) / "Deleted". A blocked store shows a banner over the stage (`.ed-alert`): **conflict** → "This recording changed in another tab" with **Reload** (tears the editor down without saving and mounts the stored version in place) and **Keep mine** (`store.keepMine()`); **deleted** → can't be saved, can still be exported, "Back to library". `beforeunload` asks before leaving when edits would be lost (failed save, or unsaved edits during a conflict).

### Inspector panels — `editor/panels/*.js` (+ `css/panels.css`)

Each exports a factory returning `{ el, destroy() }`; all take `{ store, player }`.
- `panels/design.js` → `createDesignPanel`: **Orientation** (aspect cards from `ASPECTS` with icon + name + hint), **Layout** fit/fill segmented, **Background** swatch grid from `BACKGROUNDS`, **Frame** padding / roundness / shadow sliders + window chrome segmented (None/Light/Dark), **Camera** (only if `source.hasCamera`): show toggle, shape segmented, size slider, mirror toggle, border toggle, corner quick-position buttons; **Zooms** summary: count + "Auto zoom" button (calls `onAutoZoom` option if given) + hint "Press Z to add a zoom at the playhead". Accepts `{ store, player, onAutoZoom, autoZoomJob }`; `autoZoomJob()` returns the run in flight (the shell passes `() => timeline.autoZoomJob`) so a rebuilt panel, or a run started from the timeline toolbar (`store.ui.autoZoomRunning`), shows the button as busy. Also exports `sliderControl` (with `rearm()`), `segmentedControl`, `panelSection`, `formatScale`.
- `panels/zoom.js` → `createZoomPanel({ store, player, onDelete })` (+ `clearFrameCache()`: frees the source stills shared across panel instances; the shell calls it on unmount, never a panel's own destroy): for the selected zoom: scale slider (1.1–4×), **focus picker** (a mini canvas showing the source frame at the zoom's start with a draggable rectangle representing the zoomed viewport; dragging sets x/y), start/end/duration readout, "Preview zoom" (seek to start & play), Delete, Done (deselect).
- `panels/captions.js` → `createCaptionsPanel`: enable switch, **style picker** (option cards with `drawCaptionPreview` canvases; 'minimal' first), position segmented, size segmented, **transcript editor** (list of segments with timestamp + editable text; editing updates store with coalesce; click timestamp seeks; delete segment; "Add caption at playhead"); empty state explaining live transcription when transcript is empty. Download .srt button.
- `panels/summary.js` → `createSummaryPanel` and `autoSummarize(store, { force = false } = {})`: autoSummarize generates when transcript non-empty and (no summary or `transcriptHash` changed or force), driving `store.ui.summaryStatus/summaryError`, then `store.setSummary`; if the title is still the default ("Recording – …"/import filename) and the summary is AI, set `project.title` (history:false). Panel: beautiful summary card (title, TL;DR, key points, action items with checkbox look, chapters list with timestamps that seek the player), source badge ("AI summary · model" or "Basic summary" with hint to set ANTHROPIC_API_KEY), Regenerate, Copy as Markdown, empty state when no transcript, shimmering skeleton while loading.

### Export — `editor/exporter.js`, `editor/export-dialog.js` (+ `css/export.css`)

```js
supportedFormats() → [{ id: 'mp4'|'webm', label, mimeType }]    // mp4 first when MediaRecorder supports it
exportVideo({ project, mainBlob, cameraBlob, format, resolution: 720|1080|2160, showCaptions = true, signal, onProgress(fraction, etaSec), onFrame?(canvas) })
  → Promise<{ blob, mimeType, extension }>
  // Real-time render: private videos (main unmuted → WebAudio MediaElementSource → MediaStreamDestination only, so it's silent to the user),
  // private canvas (attached off-screen) → captureStream(30) + audio track → MediaRecorder (~12 Mbps @1080p).
  // Seek to trim.start, play, draw each frame with drawFrame (+captions), stop at trim.end. Keep camera synced.
  // Works if the user switches tabs (fallback timer loop when document.hidden). Rejects with AbortError on cancel.
openExportDialog({ project, mainBlob, cameraBlob, onShare? }) → void
  // Modal: format segmented, resolution segmented (720p/1080p/4K — label shows output px for the current aspect), "Burn in captions" switch
  // (disabled when no transcript), live preview thumbnail during export, progress bar + ETA, Cancel; on success: Download button
  // (auto-download too), file size, plus "Download captions (.srt)" when the transcript has text and "Copy summary" when there is a
  // summary AND transcript text (marked "Out of date" when summary.transcriptHash no longer matches); "Copy share link" (project.share.url; its subtitle says only people with
  // the password can watch when settings.hasPassword) when the recording has a link, otherwise "Create a share link" → closes the dialog and calls onShare() (the editor opens the Share dialog).
```

### Home — `views/home.js` (+ `css/home.css`)

Frosted nav (logo, search, theme toggle cycling system/light/dark, "Import video", primary "New recording" → `#/record`). Empty library: beautiful hero ("Record. Polish. Share." with gradient text, subcopy, big primary CTA, secondary Import, a row of 4 feature tiles: Auto zoom, Captions, AI summary, Any orientation). With recordings: a short header and a responsive grid of cards (16:9 thumbnail with duration badge, hover play overlay, title, relative date, "…" menu: Open, Rename, Download original, Delete with confirm). Import via file picker and drag-and-drop anywhere (overlay): `probeVideo` → `createProject({ mode: 'import', title: <filename without extension>, ... })` → thumbnail → `createProjectWithMedia` → open editor. Rename uses `patchProject` (never clobbers an editor in another tab). The list refreshes quietly (stamps first via `listProjectStamps`) on `dolly:projects-changed`, `onProjectChange`, and tab return — deferred while a menu, dialog or action is open. **Interrupted recordings:** on mount (and on tab return) `findInterruptedTakes()`; if any, a banner above the library — "A recording was interrupted" with **Discard** (confirm → `discardInterruptedTake`) and **Recover** (`recoverInterruptedTake` → toast with Open, card highlighted). After the first load, `sweepOrphanMedia()` once per page session. Keyboard: R = new recording. Storage usage line at the bottom.

### Recording — `views/record.js`, `recorder/recorder.js`, `recorder/transcriber.js`, `recorder/pip.js` (+ `css/record.css`)

Setup page (frosted nav with back + logo; centered card): mode segmented (`RECORDING_MODES`), camera select + live mirrored circular preview, mic select + live level meter, toggles: system audio (screen modes), live transcript (when `SpeechRecognition`/`webkitSpeechRecognition` exists; explains it powers captions + summary), floating controls (when `documentPictureInPicture` exists), 3-second countdown. Big red "Start recording" button. Remember choices in localStorage (try/catch).
Recording: `getDisplayMedia({ video: { frameRate: 30, width: {ideal: 3840}, height: {ideal: 2160} }, audio: systemAudio, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include' })`; camera via getUserMedia (video only, 1280×720 ideal); mic via getUserMedia (echoCancellation, noiseSuppression). Mix mic + system audio with WebAudio into main. Separate MediaRecorders for main and camera started in the same tick (timeslice 1000ms). Pause/resume both + transcriber. Elapsed clock excludes paused time. If the user clicks the browser's "Stop sharing", stop gracefully and continue to the editor.
Live HUD page while recording: pulsing red dot + big mono timer, Pause/Resume, Stop (primary), Restart, Discard (confirm), camera preview, live transcript ticker. Floating controls in a Document Picture-in-Picture window (timer, pause, stop) styled like a macOS HUD; countdown shown there too when open.
Transcriber: continuous + interimResults, auto-restarts on `end` while recording, segment start = elapsed time at the first interim result of an utterance (minus ~0.3s), end = elapsed at final → `{ id: uid('s_'), start, end, text }`. Never crash if unsupported or if the network/permission errors.
Stop → "Preparing your video…" state → `createProject` from the recorder's clock and track sizes → `createProjectWithMedia` (main, camera; atomic, so the take is safe even if the tab is hidden and can't decode video yet) → clear the crash backup → `probeVideo` + thumbnail → guarded `updateProject` with the exact duration/size/thumbnail (skipped if someone edited it meanwhile) → `location.hash = '#/edit/' + id`. A failed save keeps the take in memory (error card with Download / Try again) and in its crash backup. Friendly errors for permission denied / unsupported. Unmount stops all tracks and closes PiP.

**Crash recovery — `recorder/recovery.js`:** while a take records, every recorder chunk (`recorder.onChunk(kind, seq, blob)`) and the live transcript are copied to the `pending` store under the Web Lock `dolly-take:<id>` (held for as long as a view owns the take, so no other tab offers it while it is recording or saving).
```js
startTakeBackup({ mode }) → null | { id, write(kind, seq, blob), writeTranscript(segments), clear(), release() }
  // clear(): the take is in the library or was thrown away. release(): saving failed — keep it for recovery.
findInterruptedTakes() → [{ id, mode, createdAt, seconds }]   // newest first; skips locked takes; deletes empty leftovers; never throws
recoverInterruptedTake(take, { title }) → Project | null       // joins chunks → probe → createProjectWithMedia → clearPending;
                                                                // null if another tab is handling it; rejects (keeping the backup) if saving fails
discardInterruptedTake(take) → boolean
isRecoverySupported(), cleanTranscript(segments, duration), makeThumbnail(blob, duration)
```
Both the record setup card and the library offer Recover / Discard.

## File ownership (one owner per file)

| Owner | Files |
|---|---|
| foundation | `css/tokens.css`, `css/base.css`, `js/lib/*`, `js/editor/store.js`, `js/main.js`, `index.html`, `server.py`, `tools/check.py` |
| home | `js/views/home.js`, `css/home.css` |
| record | `js/views/record.js`, `js/recorder/*.js`, `css/record.css` |
| renderer | `js/editor/renderer.js`, `js/editor/backgrounds.js`, `js/editor/zoom.js` |
| captions-summary | `js/editor/captions.js`, `js/editor/summary.js` |
| timeline | `js/editor/timeline.js`, `css/timeline.css` |
| shell | `js/views/editor.js`, `js/editor/player.js`, `js/editor/preview.js`, `css/editor.css` |
| panels | `js/editor/panels/*.js`, `css/panels.css` |
| export | `js/editor/exporter.js`, `js/editor/export-dialog.js`, `css/export.css` |

CSS class names must be prefixed by owner to avoid collisions: `.home-*`, `.rec-*`, `.ed-*` (shell), `.tl-*` (timeline), `.pn-*` (panels), `.ex-*` (export).

## Sharing (share links)

Flow: editor **Share** → link is created *instantly* (status `processing`) → the edited video renders in real time (exporter) → resumable chunked upload → status `ready`. Anyone with the link watches at `/s/<id>`; `/embed/<id>` is the iframe player. The owner can update the video (same URL), change settings, or delete the link.

Hosting: shares are stored by Dolly's own Python server on disk (`DOLLY_DATA_DIR`, default `./data`). Links reach other people only when that server is reachable (LAN with `DOLLY_HOST=0.0.0.0`, a tunnel, or a deployed host — see README "Sharing publicly"). Python 3.9 stdlib only (`from __future__ import annotations`; no `X | Y` runtime types, no `match`).

### Server env

| Var | Default | Meaning |
|---|---|---|
| `DOLLY_HOST` | `127.0.0.1` | bind address (`0.0.0.0` for LAN/deploy) |
| `PORT` | `8000` | port |
| `DOLLY_DATA_DIR` | `./data` | share storage root (`shares/<id>/…`, `secret.key`) |
| `DOLLY_PUBLIC_URL` | — | base for generated links, e.g. `https://dolly.example.com` (else derived from the request's Host; if that is localhost while bound to 0.0.0.0, use the machine's LAN IP) |
| `DOLLY_SHARE_KEY` | — | when set, every client (loopback included) must send it in `X-Dolly-Key` to create shares (10 attempts/min per IP, 0.6 s delay on a wrong key); keys under 16 chars or `change-me` / `paste-a-long-random-secret-here` are ignored with a warning. If unset, only loopback clients may create shares. |
| `DOLLY_TRUST_PROXY` | on in a container, else off | believe `X-Forwarded-For` from a private (non-loopback) peer for rate-limit keys (`1`/`0`; a loopback peer's is always believed) |
| `DOLLY_MAX_UPLOAD_MB` | `4096` | max video size |

### Server files

`server.py` (routing glue, existing summary API, static files) imports `sharing.py` (all share logic: storage, auth, validation, templates, Range responses). Storage per share: `data/shares/<id>/meta.json` (atomic tmp+rename writes, per-share `threading.Lock`), `video-<version>.<ext>`, `upload-<version>.part`, `poster.jpg`, `comments.json`, `viewers.json`. Server secret: `data/secret.key` (32 random bytes, created on first run) for HMAC access tokens.

### Data shapes

```js
ShareMeta (server, private) = {
  id,                         // 10 chars [A-Za-z0-9]; validate every id against /^[A-Za-z0-9]{6,16}$/
  ownerTokenHash,             // sha256 hex of the owner token; the token itself is returned once on create
  createdAt, updatedAt,       // ms
  status: 'processing' | 'ready' | 'failed',   // 'processing' = no video yet (rendering, uploading, or the owner
                              // cancelled / closed the tab); 'failed' only after a real error with no ready video
  version,                    // int, bumps on every completed video upload
  upload: null | { version, mimeType, size, width, height, duration, received, sourceStart, prevSourceStart },
  sourceStart?,               // trim start (recording seconds) of the live video; absent when the uploader didn't send it
  title, description,         // description = TL;DR (≤ 500 chars)
  ownerName,                  // optional display name (≤ 60)
  summary: Summary | null,    // times already shifted to the shared video's timeline
  transcript: [{ start, end, text }],   // shifted (0 = first frame of the shared video), clipped to [0, duration]
  captions: { enabled, style, position, size, burned },  // burned=true → captions are in the pixels; viewer must not overlay
  layout: { aspect, width, height, camera: { x, y, size, shape } | null },  // output px + camera bubble box in output px (for caption placement)
  duration,
  video: null | { mimeType, size, ext, width, height, duration },
  poster: bool,
  settings: { allowDownload, showSummary, showTranscript, allowComments, password: null | { salt, hash } },  // pbkdf2_hmac sha256, 200k iterations
  views,
}
Comment = { id, kind: 'comment' | 'reaction', name, text, emoji, time /* seconds or null */, createdAt }
// reactions: emoji ∈ ['👍','❤️','😂','🎉','😮','🔥'], text ''. comments: text 1..2000 chars, name 1..60 (default 'Guest').
```

### HTTP API (JSON bodies; errors are `{ error: string, ...extra }` with a proper status)

Auth headers: owner actions send `X-Owner-Token: <token>`; creation sends `X-Dolly-Key` whenever the server has a share key; password-protected reads send `X-Share-Access: <access>` (or `?a=<access>` for media URLs).

| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/share-config` | anyone | → `{ canCreate, keyRequired, publicBase, isLocalOnly }` (`isLocalOnly` = links would only work on this machine) |
| `POST /api/shares` | key if configured, else loopback | `{ title, description, ownerName?, summary, transcript, captions, layout, duration, settings: { allowDownload, showSummary, showTranscript, allowComments, password?: string } }` → **201** `{ id, ownerToken, url, embedUrl, share: OwnerView }`; 403 `{ keyRequired: true }`; always `Content-Type: application/json`, even with an empty body (else 415); 429 + Retry-After after 10 attempts/min per IP while a key is set |
| `GET /api/shares/:id/owner` | owner | → `OwnerView` = PublicView + `{ commentCount, upload, settings incl. hasPassword }` |
| `PATCH /api/shares/:id` | owner | any of `title, description, ownerName, summary, transcript, captions, layout, duration, settings` (settings merge; `password: string` sets, `null` clears, omitted keeps) → `OwnerView` |
| `DELETE /api/shares/:id` | owner | → 204 (removes the directory) |
| `POST /api/shares/:id/video/start` | owner | `{ mimeType, size, width, height, duration, sourceStart?, prevSourceStart? }` → `{ version, offset: 0 }` (previous ready video stays live until complete). `sourceStart` = this video's trim start in the recording, `prevSourceStart` = the live video's (fallback when the meta has no `sourceStart`); non-numbers are ignored |
| `PUT /api/shares/:id/video?version=V&offset=N` | owner | raw bytes (`application/octet-stream`, ≤ 16 MB per chunk) → `{ received }`; 409 `{ expectedOffset }` if N ≠ bytes received so far; 410 if V isn't the upload in flight |
| `POST /api/shares/:id/video/complete?version=V` | owner | → `OwnerView` (size must match; atomically becomes `video-<V>.<ext>`, older videos deleted, `status: 'ready'`; 410 for a stale version). When it replaces a ready video, timed comments and reactions move by (old `sourceStart` − new `sourceStart`); a time that lands outside [0, new duration] becomes `null` (the comment stays, untimed) |
| `POST /api/shares/:id/video/fail` | owner | `{ error, version?, cancelled? }` → OwnerView. Drops the upload in flight only when `version` names it (another tab's newer upload, or any upload when no version is sent, is never touched). With nothing left in flight and no ready video the link turns `failed` — unless `cancelled: true` (the owner stopped it), which leaves the status alone, so a new link stays `processing` |
| `PUT /api/shares/:id/poster` | owner | raw `image/jpeg` ≤ 5 MB → 204 |
| `GET /api/shares/:id` | public (+access if password) | → `PublicView` or 401 `{ passwordRequired: true, title: null }` / 404 |
| `POST /api/shares/:id/unlock` | public | `{ password }` → `{ access }` (HMAC token valid 7 days) or 403 (≈0.6s delay on failure) |
| `POST /api/shares/:id/view` | public (+access) | `{ viewerId }` → `{ views }` (unique per viewerId, stores sha256 of it, cap 100k) |
| `GET /api/shares/:id/comments` | public (+access) | → `{ comments: Comment[] }` (sorted by createdAt); weak `ETag`, `If-None-Match` → bodiless 304 (comments-off answers carry `W/"c-off"`) |
| `POST /api/shares/:id/comments` | public (+access) | `{ kind, name, text, emoji, time }` → `Comment` (403 if comments disabled; 429 rate limit ~10/min per IP, 60/min per share) |
| `DELETE /api/shares/:id/comments/:cid` | owner | → 204 |
| `GET /media/:id/video?v=V[&a=…][&download=1]` | public (+access) | the video with **HTTP Range** support (206, Accept-Ranges, Content-Range), `Cache-Control: private, max-age=3600`; `download=1` → `Content-Disposition: attachment` and 403 unless allowDownload |
| `GET /media/:id/poster.jpg[?a=…]` | public (+access) | poster |
| `GET /s/:id`, `GET /embed/:id` | public | `public/share.html` template filled server-side (see below) |

```js
PublicView = { id, title, description /* '' if !showSummary (it is the TL;DR) */, ownerName, createdAt, updatedAt, status, version, duration,
               summary /* null if !showSummary */, transcript /* [] if !showTranscript && !(captions.enabled && !captions.burned) */,
               captions, layout,
               video: null | { url, mimeType, width, height, duration, downloadUrl /* null unless allowDownload */ },
               posterUrl /* null if none */,
               settings: { allowDownload, showSummary, showTranscript, allowComments, hasPassword },
               views }
// url/downloadUrl/posterUrl are site-relative paths that already include v= and a= (access) when needed.
```

### `public/share.html` template (owned by the viewer)

A full HTML document using absolute asset paths (`/css/tokens.css`, `/css/base.css`, `/css/viewer.css`, `/js/share/viewer.js`). The server replaces these placeholders, HTML-escaping every value: `{{TITLE}}` (page + og:title), `{{DESCRIPTION}}` (meta + og:description; empty when showSummary is off: the description is the TL;DR), `{{URL}}` (canonical/og:url, absolute), `{{OG_IMAGE}}` (absolute poster URL or absolute `/og-default.png`… use the poster when public and ready, else empty string → omit tag content), `{{OG_VIDEO}}` (absolute video URL when public & ready, else empty), `{{OG_VIDEO_TYPE}}` (that video's MIME type, `video/mp4` | `video/webm`, else empty), `{{SHARE_ID}}`, `{{MODE}}` (`watch` | `embed`). The body carries `data-share-id="{{SHARE_ID}}" data-mode="{{MODE}}"`. Password-protected shares get title "Password-protected video" and no description/image/video in the meta tags. Unknown ids still render the template (viewer shows "not found") with status 404.

### Front-end modules

| Owner | Files |
|---|---|
| share-server | `server.py`, `sharing.py`, `tools/test_sharing.py`, `Dockerfile`, `.dockerignore`, `.gitignore`, README "Sharing publicly" section |
| share-viewer | `public/share.html`, `public/js/share/viewer.js`, `public/js/share/*.js` (viewer-only helpers), `public/css/viewer.css` (prefix `.vw-*`) |
| share-app | `public/js/lib/share-api.js`, `public/js/editor/share.js`, `public/js/editor/share-dialog.js`, `public/css/share.css` (prefix `.sh-*`), plus the Share wiring in `public/js/views/editor.js` and the shared badge / "Copy link" menu item in `public/js/views/home.js` (+ minimal CSS in `css/editor.css` / `css/home.css` if needed), and `index.html` link for `css/share.css` |

```js
// lib/share-api.js — thin fetch client (throws Error with .status and .data on non-2xx)
getShareConfig() → Promise<{ canCreate, keyRequired, publicBase, isLocalOnly }>
createShare(payload, { key }) → Promise<{ id, ownerToken, url, embedUrl, share }>
getOwnerView(id, ownerToken) / updateShare(id, ownerToken, patch) / deleteShare(id, ownerToken)
uploadVideo(id, ownerToken, blob, { mimeType, width, height, duration, sourceStart?, prevSourceStart? },
            { onProgress(fraction), onStart(version), signal }) → Promise<OwnerView>
  // start → 8 MB chunks with retry (4 attempts, backoff; on 409 resume from expectedOffset) → complete;
  // onStart(version) fires once video/start succeeded (pass that version to failVideo)
failVideo(id, ownerToken, error, { version, cancelled, signal })   // see video/fail
withRetry(fn, signal, attempts = 4)   // retries network errors, timeouts, 408, 429, 5xx with backoff (used for the PATCH after an upload)
uploadPoster(id, ownerToken, jpegBlob)

// editor/share.js — app-side orchestration
buildSharePayload(project, { burnCaptions, trim }) → { title, description, ownerName, summary, transcript, captions, layout, duration }
  // shifts transcript/summary chapters by -trim.start, clips to trimmed duration; layout from getExportSize + computeLayout (camera box in output px).
  // Speech the trim removed never reaches the link: a segment crossing a cut keeps only the words inside it, and when the
  // trim cuts any transcribed speech the summary's title/TL;DR/key points/action items are blanked (only re-timed chapters
  // are sent; description = that gated TL;DR). shareSummaryHidden(project, trim) tells the dialog.
videoHash(project, { burnCaptions }) / metaHash(project) → string   // detect "edited since shared"
runShareJob(project, { mainBlob, cameraBlob, burnCaptions, onState }) → { cancel(), done, state }
  // render (exportVideo 1080p mp4→webm) → poster → upload (sourceStart = trim.start, prevSourceStart = share.trim.start)
  // → PATCH metadata (withRetry). One job per project id (a running job for another, deleted link is cancelled);
  // holds the Web Lock 'dolly-share-job:<shareId>' so other tabs don't offer an upload that would supersede it.
  // On error/cancel it reports video/fail with the version it started (cancel: `cancelled: true`, and nothing at all
  // when no upload had started) unless the reply was 404/401/403/410.
project.share = { id, url, embedUrl, ownerToken, createdAt, version, videoHash, metaHash, burnCaptions, settings, trim, pendingMeta? } | null
  // persisted via store.update(..., { history: false }) (or patchProject when no editor is mounted / saving is blocked);
  // never part of undo, and store.keepMine() keeps the stored record's share (the owner token must never be lost).
  // pendingMeta = { layout, duration } of the live video while the PATCH after its upload failed (metaHash is null then);
  // the dialog re-sends it with the metadata.
```
The viewer may import `/js/editor/captions.js` (pure drawing: `buildCaptionChunks`, `drawCaptions`) to overlay styled captions, and `/js/lib/util.js`, `/js/lib/icons.js`, `/js/lib/ui.js` (toast, applyTheme, logo, openMenu).

### As built (details beyond the table above)

- `GET /api/share-config`: `canCreate` = loopback client or a share key is configured; `keyRequired` = a key is configured (it applies to every client, loopback included, so a same-host proxy or tunnel can't make everyone look local). Loopback means peer 127.0.0.0/8 or ::1, no `X-Forwarded-For` / `Forwarded` / `X-Real-IP`, a loopback `Host` (blocks DNS rebinding and tunnels), no cross-site `Sec-Fetch-Site` and an `Origin` (if any) matching `Host`. `POST /api/shares` 403 carries `keyRequired: false` when no key is configured.
- JSON bodies must be sent with `Content-Type: application/json` (else 415). Empty bodies are fine only on the owner-token routes such as `video/complete`; `POST /api/shares` always requires the JSON Content-Type, even with an empty body (an HTML form can't send it, and a cross-site fetch that does needs a CORS preflight this server never grants).
- Upload: every `video/start` allocates a new version and supersedes an upload in flight. `PUT`/`complete` with a stale or unknown version → **410** (start again; the client does not report `video/fail` then, and `video/fail` itself only drops the upload whose `version` it names, so a stale job can't cancel another tab's newer upload). A concurrent `PUT` waits ≤ 30 s, then 409 `{ expectedOffset }`. `complete` is idempotent for the version just completed, sniffs the container (WebM/MP4; the stored `mimeType` follows the bytes; anything else → 415, the upload is dropped and a link without a ready video turns `failed`). Status becomes `processing` on start only when no ready video exists.
- Cancel: the owner stopping the very first render/upload of a link reports `video/fail` with `cancelled: true` (or nothing, if no upload had started), so the link stays `processing`; viewers see "This video isn't ready yet — the owner hasn't finished uploading this video yet" (the same page shown while it renders/uploads, or after the owner's tab closed), keep polling, and the owner's dialog offers **Upload video**. Only real errors show viewers "This video couldn't be processed" (the viewer keeps polling a failed link every 15 s and picks up a re-upload).
- Client upload (`share-api.js`): 8 MB slices, 4 attempts per request (backoff 0.8/1.6/3.2 s ±20%) on network errors, 408, 429 and 5xx; 409 `{ expectedOffset }` resyncs; a `complete` whose response was lost is confirmed via the owner view.
- `GET /media/:id/video?v=` with a version that isn't current → 404 `{ currentVersion }` (older files are deleted); the viewer's "Try again" refetches the share. ETag / If-None-Match / If-Range / HEAD supported.
- Access tokens (`X-Share-Access` header or `?a=`, accepted on every protected route) are bound to the share id and its password salt, so changing or clearing the password revokes every token handed out before (viewers see the password gate again). `settings.password: ''` clears like `null`. Unlock: 0.6 s delay on failure, 20 attempts/min per IP bucket and 30 failures per 10 min per share (429 + Retry-After); at most cpu_count/2 password checks run at once (else 429).
- OwnerView = PublicView with the full summary/transcript (regardless of show* settings) + `{ commentCount, upload, url, embedUrl }`; its media URLs carry a fresh access token on protected shares. `PublicView.video` also has `size`; `posterUrl` is versioned `?v=<posterAt>`.
- Comments: POST → 201; text > 2000 chars → 400; name truncated to 60; time clamped to the video duration (non-number → null); 5000 per share or ~2 MB stored, then 403 `{ limitReached: true }` (distinct from "comments off"); 10 posts/min per IP and 60 posts/min per share (429 + Retry-After); public GET returns `[]` while comments are off (the owner still gets them). `comments.json` is UTF-8. Viewers poll every 30 s with `If-None-Match` (`api.listComments` resolves `null` for an unchanged list; the first load, e.g. after the password gate, asks with `fresh: true`) and re-read them when the video version changes, since a new trim start re-times them.
- Rate-limit key: the peer IP (IPv6 bucketed by /64), or the right-most `X-Forwarded-For` entry when the peer is loopback, or a private address and Dolly runs in a container / `DOLLY_TRUST_PROXY=1`. Views: 120/min/IP (excess silently not counted).
- `project.share` also stores `trim` (the trim of the video that is live on the link), so metadata patched later stays aligned with that video. Right after an upload completes the job PATCHes title/description/summary/transcript/captions/layout/duration (not ownerName) through `withRetry`; if that still fails it sets `metaHash: null` + `pendingMeta`, and the dialog re-sends them (on open, and as soon as a job finishes).
