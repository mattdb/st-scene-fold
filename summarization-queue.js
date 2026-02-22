/**
 * Scene Fold - Summarization Queue
 *
 * Processes scene summarizations one at a time with cancel support
 * and progress tracking. Decoupled from summarization logic via
 * a worker callback.
 */

import { getScene, updateScene } from './scene-data.js';

export class SummarizationQueue {
    /**
     * @param {object} options
     * @param {(sceneId: string, signal: AbortSignal) => Promise<void>} options.worker
     * @param {() => void} options.onUpdate - Called on every state change for UI refresh
     */
    constructor({ worker, onUpdate }) {
        this._worker = worker;
        this._onUpdate = onUpdate || (() => {});

        /** @type {string[]} */
        this._pending = [];
        /** @type {string|null} */
        this._activeId = null;
        /** @type {AbortController|null} */
        this._activeAbort = null;
        /** @type {boolean} */
        this._processing = false;
        /** @type {number} */
        this._batchTotal = 0;
        /** @type {number} */
        this._batchDone = 0;
    }

    /** Enqueue one scene. Starts processing if idle. */
    add(sceneId) {
        if (this._pending.includes(sceneId) || this._activeId === sceneId) {
            return;
        }
        this._pending.push(sceneId);
        this._batchTotal++;

        const ctx = SillyTavern.getContext();
        updateScene(ctx.chatMetadata, sceneId, { status: 'queued' });
        ctx.saveMetadataDebounced();

        this._onUpdate();

        if (!this._processing) {
            this._processNext();
        }
    }

    /** Enqueue multiple scenes at once. */
    addAll(sceneIds) {
        // Reset batch counters for a fresh batch
        this._batchTotal = this._pending.length + (this._activeId ? 1 : 0);
        this._batchDone = 0;

        for (const id of sceneIds) {
            this.add(id);
        }
    }

    /** Cancel a single scene: remove from queue or abort if active. */
    cancel(sceneId) {
        // Case 1: pending — just remove
        const idx = this._pending.indexOf(sceneId);
        if (idx !== -1) {
            this._pending.splice(idx, 1);
            const ctx = SillyTavern.getContext();
            const scene = getScene(ctx.chatMetadata, sceneId);
            if (scene && scene.status === 'queued') {
                updateScene(ctx.chatMetadata, sceneId, { status: 'defined' });
                ctx.saveMetadataDebounced();
            }
            this._batchDone++;
            this._onUpdate();
            return;
        }

        // Case 2: active — abort the LLM call
        if (this._activeId === sceneId && this._activeAbort) {
            this._activeAbort.abort();
        }
    }

    /** Cancel everything: abort active + clear pending. */
    cancelAll() {
        if (this._activeAbort) {
            this._activeAbort.abort();
        }

        const ctx = SillyTavern.getContext();
        for (const id of this._pending) {
            const scene = getScene(ctx.chatMetadata, id);
            if (scene && scene.status === 'queued') {
                updateScene(ctx.chatMetadata, id, { status: 'defined' });
            }
        }
        this._pending = [];
        this._batchTotal = 0;
        this._batchDone = 0;
        ctx.saveMetadataDebounced();
        this._onUpdate();
    }

    /** Whether a scene is queued or currently active. */
    has(sceneId) {
        return this._pending.includes(sceneId) || this._activeId === sceneId;
    }

    /** Whether the queue is currently processing. */
    get isProcessing() {
        return this._processing;
    }

    /** The scene ID currently being summarized, or null. */
    get activeSceneId() {
        return this._activeId;
    }

    /** Read-only copy of pending IDs. */
    get pendingIds() {
        return [...this._pending];
    }

    /** Progress info for the current batch. */
    get progress() {
        return {
            current: this._batchDone + 1,
            total: this._batchTotal,
            activeId: this._activeId,
            pendingCount: this._pending.length,
        };
    }

    /** Process loop: dequeue, call worker, handle result, continue. */
    async _processNext() {
        if (this._pending.length === 0) {
            this._processing = false;
            this._activeId = null;
            this._activeAbort = null;
            this._batchTotal = 0;
            this._batchDone = 0;
            this._onUpdate();
            return;
        }

        this._processing = true;
        const sceneId = this._pending.shift();
        this._activeId = sceneId;
        this._activeAbort = new AbortController();
        this._onUpdate();

        try {
            await this._worker(sceneId, this._activeAbort.signal);
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log(`[Scene Fold] Queue: summarization cancelled for ${sceneId}`);
                // Safety net: ensure scene isn't stuck in summarizing
                const ctx = SillyTavern.getContext();
                const scene = getScene(ctx.chatMetadata, sceneId);
                if (scene && scene.status === 'summarizing') {
                    updateScene(ctx.chatMetadata, sceneId, { status: 'defined', lastError: null });
                    ctx.saveMetadataDebounced();
                }
            }
            // Non-abort errors: worker already sets status to 'error'.
            // Either way, continue to next scene.
        }

        this._batchDone++;
        this._activeId = null;
        this._activeAbort = null;
        this._onUpdate();

        // Give the UI a frame to settle after chat reload before next scene
        setTimeout(() => this._processNext(), 100);
    }
}
