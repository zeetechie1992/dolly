// Editor state: the project being edited (persisted, undoable) plus transient
// UI state (selection, active step). Everything in the editor reads from and
// writes through one store instance.

import { Emitter, debounce, deepClone } from '../lib/util.js';
import { updateProject, getProject, onProjectChange } from '../lib/db.js';

const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

/**
 * @param {object} project a migrated project (see lib/project.js)
 * @returns {EditorStore}
 */
export function createStore(project) {
  return new EditorStore(project);
}

export class EditorStore extends Emitter {
  constructor(project) {
    super();
    this.project = project;
    /** Transient UI state — not saved, not undoable. */
    this.ui = {
      step: 'edit',            // 'edit' | 'captions' | 'summary'
      selectedZoomId: null,
      selectedCaptionId: null,
      time: project.edit.trim.start, // current playhead (source seconds) — mirrored from the player
      playing: false,
      saving: false,
      summaryStatus: 'idle',   // 'idle' | 'loading' | 'error'
      summaryError: null,      // string when summaryStatus === 'error'
      autoZoomRunning: false,  // an auto-zoom analysis is in flight (set by the timeline)
    };
    this.undoStack = [];
    this.redoStack = [];
    this._lastCoalesce = null;
    this._persist = debounce(() => this._saveNow(), 600);
    // Optimistic concurrency: the stored record's updatedAt this copy is based on.
    // Saves only go through while the record still exists with this stamp.
    this._base = project.updatedAt;
    /** Set once saving stops: an Error with `reason` 'deleted' | 'conflict'. */
    this._blocked = null;
    this._saving = null;     // tail of the serialized save chain
    this._queued = null;     // a save that is queued but not started yet
    this._offRemote = null;
    this._listenForOtherTabs();
  }

  /** Undoable fields of the project. */
  _snapshot() {
    const { title, edit, transcript, transcriptSource } = this.project;
    return deepClone({ title, edit, transcript, transcriptSource });
  }

  _restore(snap) {
    Object.assign(this.project, deepClone(snap));
  }

  /**
   * Mutate the project. `mutator(project)` changes it in place.
   * @param {(p: object) => void} mutator
   * @param {{ history?: boolean, coalesce?: string, reason?: string }} [opts]
   *   history  — record an undo step (default true)
   *   coalesce — consecutive updates with the same key within 800ms share one undo step
   *              (use for slider drags / timeline drags, e.g. `zoom-move:${id}`)
   *   reason   — free-form string passed to listeners
   */
  update(mutator, { history = true, coalesce, reason } = {}) {
    if (history) {
      const now = performance.now();
      const merge = coalesce && this._lastCoalesce && this._lastCoalesce.key === coalesce && now - this._lastCoalesce.at < COALESCE_MS;
      if (!merge) {
        this.undoStack.push(this._snapshot());
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
      this._lastCoalesce = coalesce ? { key: coalesce, at: now } : null;
    }
    mutator(this.project);
    this.project.edit.zooms.sort((a, b) => a.start - b.start);
    this.emit('change', this.project, { reason });
    this._persist();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this._lastCoalesce = null;
    this._fixSelection();
    this.emit('change', this.project, { reason: 'undo' });
    this._persist();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this._lastCoalesce = null;
    this._fixSelection();
    this.emit('change', this.project, { reason: 'redo' });
    this._persist();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** Patch transient UI state; emits 'ui' with (ui, changedKeys). */
  setUI(patch) {
    const changed = Object.keys(patch).filter((k) => this.ui[k] !== patch[k]);
    if (!changed.length) return;
    Object.assign(this.ui, patch);
    this.emit('ui', this.ui, changed);
  }

  /** Set the summary without creating an undo step (it is generated, not edited). */
  setSummary(summary) {
    this.project.summary = summary;
    this.emit('change', this.project, { reason: 'summary' });
    this._persist();
  }

  _fixSelection() {
    if (this.ui.selectedZoomId && !this.project.edit.zooms.some((z) => z.id === this.ui.selectedZoomId)) this.setUI({ selectedZoomId: null });
    if (this.ui.selectedCaptionId && !this.project.transcript.some((s) => s.id === this.ui.selectedCaptionId)) this.setUI({ selectedCaptionId: null });
  }

  /**
   * Why autosave is stopped, or null while it works:
   *   'deleted'  — the recording was deleted (e.g. in another tab); nothing more is saved.
   *   'conflict' — another tab saved this recording since it was loaded here; nothing
   *                is saved until the user picks: reload, or keepMine() to overwrite.
   * While blocked, every save attempt (edits, flush) emits 'save-error' again with the
   * same error, so a status that resets on change stays accurate.
   */
  get saveBlocked() { return this._blocked?.reason || null; }

  /**
   * Resolve a 'conflict' by overwriting the other tab's version with this one.
   * Resolves true once saved (false if the recording is gone or the save failed).
   */
  async keepMine() {
    if (this._blocked?.reason !== 'conflict') return false;
    let cur;
    try {
      cur = await getProject(this.project.id);
    } catch (err) {
      console.error('[store] save failed', err);
      this.emit('save-error', withReason(err, 'failed'));
      return false;
    }
    if (this._blocked?.reason !== 'conflict') return false; // deleted meanwhile
    if (!cur) {
      this._block(notFoundError(), 'deleted');
      return false;
    }
    // project.share mirrors a server-side link whose owner token exists only in this database
    // and is written outside undo (also straight to the database while saving is blocked), so
    // keep the stored link; this tab's copy is used only when the database has none.
    if (cur.share?.id || !this.project.share?.id) {
      const next = cur.share ?? null;
      if (JSON.stringify(next) !== JSON.stringify(this.project.share ?? null)) {
        this.project.share = next;
        this.emit('change', this.project, { reason: 'share' });
      }
    }
    this._base = cur.updatedAt;
    this._blocked = null;
    this._persist.cancel();
    return this._saveNow();
  }

  /** Stop listening for other tabs' writes. Call after the final flush() on unmount. */
  destroy() {
    this._offRemote?.();
    this._offRemote = null;
  }

  /**
   * Saves are serialized: a flush() during an in-flight save waits for it (and
   * then compares against the stamp that save produced). Calls made while a save
   * is already queued share it. Resolves true when saved, false otherwise; never rejects.
   */
  _saveNow() {
    if (this._queued) return this._queued;
    const run = (this._saving || Promise.resolve()).then(() => {
      this._queued = null;
      return this._doSave();
    });
    this._queued = run;
    this._saving = run;
    return run;
  }

  async _doSave() {
    if (this._blocked) {
      this.emit('save-error', this._blocked);
      return false;
    }
    this.setUI({ saving: true });
    try {
      const stamp = await updateProject(this.project, this._base);
      // Only after the transaction committed.
      this.project.updatedAt = stamp;
      this._base = stamp;
      this.emit('saved', this.project);
      return true;
    } catch (err) {
      if (err?.name === 'NotFoundError') this._block(err, 'deleted');
      else if (err?.name === 'ConflictError') this._block(err, 'conflict');
      else {
        console.error('[store] save failed', err);
        this.emit('save-error', withReason(err, 'failed'));
      }
      return false;
    } finally {
      this.setUI({ saving: false });
    }
  }

  _block(err, reason) {
    if (this._blocked?.reason === 'deleted') return; // terminal
    this._blocked = withReason(err, reason);
    this._persist.cancel();
    if (reason === 'deleted') console.warn('[store] recording was deleted elsewhere; autosave stopped');
    else console.warn('[store] recording changed elsewhere; autosave paused');
    this.emit('save-error', this._blocked);
  }

  /** Immediate notice of other tabs' writes (the guard in updateProject is what prevents data loss). */
  _listenForOtherTabs() {
    if (typeof WeakRef !== 'function') return;
    // Hold the store weakly so a store whose editor never called destroy() can still be collected.
    const ref = new WeakRef(this);
    const off = onProjectChange((msg) => {
      const store = ref.deref();
      if (!store) { off(); return; }
      store._onOtherTab(msg);
    });
    this._offRemote = off;
  }

  _onOtherTab(msg) {
    if (msg.id !== this.project.id) return;
    if (msg.type === 'deleted') {
      this._block(notFoundError(), 'deleted');
    } else if (msg.type === 'saved' && !this._blocked) {
      // Ignore notices for versions this copy already has (or older ones delivered late).
      if (Number.isFinite(msg.updatedAt) && Number.isFinite(this._base) && msg.updatedAt <= this._base) return;
      this._block(Object.assign(new Error('This recording was changed in another tab'), { name: 'ConflictError', current: null }), 'conflict');
    }
  }

  /** Flush pending save immediately (call before navigating away). Resolves true when saved. */
  async flush() {
    this._persist.cancel();
    return this._saveNow();
  }

  /** Listen helpers with typed names. Returns an unsubscribe function. */
  onChange(fn) { return this.on('change', fn); }
  onUI(fn) { return this.on('ui', fn); }
}

function notFoundError() {
  return Object.assign(new Error('This recording was deleted'), { name: 'NotFoundError' });
}

function withReason(err, reason) {
  const e = err instanceof Error ? err : new Error(String(err ?? 'Save failed'));
  e.reason = reason;
  return e;
}
