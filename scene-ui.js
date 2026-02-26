/**
 * Scene Fold - UI Module
 *
 * Handles scene selection mode, visual fold indicators,
 * and DOM manipulation for collapsible message groups.
 */

import {
    getSceneFoldData,
    getScenesInOrder,
    findMessageIndexByUUID,
    getAutoStartIndex,
    getMessageScenes,
    buildUUIDIndex,
} from './scene-data.js';

/** @type {boolean} Whether scene selection mode is active */
let selectionModeActive = false;

/** @type {number|null} Start index of current selection */
let selectionStart = null;

/** @type {number|null} End index of current selection */
let selectionEnd = null;

/** @type {number|null} Auto-start index (smart default) */
let autoStartIndex = null;

/** @type {boolean} Whether user has manually overridden auto-start */
let autoStartOverridden = false;

/** @type {((e: KeyboardEvent) => void)|null} */
let keyboardHandler = null;

/**
 * Get the jQuery chat container element.
 * @returns {JQuery}
 */
function getChatElement() {
    return $('#chat');
}

/**
 * Toggle scene selection mode on/off.
 * @param {object} context - SillyTavern.getContext() result
 * @param {object} settings - Extension settings
 */
export function toggleSelectionMode(context, settings) {
    selectionModeActive = !selectionModeActive;

    if (selectionModeActive) {
        enterSelectionMode(context, settings);
    } else {
        exitSelectionMode();
    }
}

/**
 * @returns {boolean} Whether selection mode is active
 */
export function isSelectionModeActive() {
    return selectionModeActive;
}

/**
 * Get the current selection range.
 * @returns {{ start: number|null, end: number|null }}
 */
export function getSelectionRange() {
    return { start: selectionStart, end: selectionEnd };
}

/**
 * Enter selection mode: set up auto-start, add visual indicators, bind click handlers.
 * @param {object} context
 * @param {object} settings
 */
function enterSelectionMode(context, settings) {
    const { chat, chatMetadata } = context;

    // Calculate smart auto-start
    autoStartOverridden = false;
    if (settings.smartAutoStart) {
        autoStartIndex = getAutoStartIndex(chatMetadata, chat);
        selectionStart = autoStartIndex;
        selectionEnd = chat.length - 1;
    } else {
        autoStartIndex = null;
        selectionStart = null;
        selectionEnd = null;
    }

    // Add selection mode class to chat
    getChatElement().addClass('scene-fold-selection-mode');

    // Highlight auto-start range if applicable
    if (selectionStart !== null && selectionEnd !== null) {
        updateSelectionHighlight();
    }

    // Show floating action bar
    showActionBar();
    updateActionBar();

    // Attach keyboard shortcuts for selection mode
    keyboardHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            exitSelectionMode();
            document.dispatchEvent(new CustomEvent('scene-fold-selection-exited'));
        } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            if (selectionStart !== null && selectionEnd !== null) {
                e.preventDefault();
                e.stopPropagation();
                document.dispatchEvent(new CustomEvent('scene-fold-selection-confirmed'));
            }
        }
    };
    document.addEventListener('keydown', keyboardHandler, true);
}

/**
 * Exit selection mode: clean up highlights, remove handlers, hide action bar.
 */
export function exitSelectionMode() {
    selectionModeActive = false;
    selectionStart = null;
    selectionEnd = null;
    autoStartIndex = null;
    autoStartOverridden = false;

    // Remove keyboard handler
    if (keyboardHandler) {
        document.removeEventListener('keydown', keyboardHandler, true);
        keyboardHandler = null;
    }

    getChatElement().removeClass('scene-fold-selection-mode');
    getChatElement().find('.mes').removeClass('scene-fold-selected scene-fold-selection-start scene-fold-selection-end');

    hideActionBar();
}

/**
 * Handle a message click during selection mode.
 * @param {number} messageId - The clicked message's index
 * @param {boolean} shiftKey - Whether shift was held
 * @param {object} context
 */
export function handleMessageClick(messageId, shiftKey, context) {
    if (!selectionModeActive) return;

    if (selectionStart === null || shiftKey) {
        // First click or shift-click: set start
        if (selectionStart !== null && selectionEnd !== null && shiftKey) {
            // Shift+click adjusts the end
            selectionEnd = messageId;
        } else {
            selectionStart = messageId;
            selectionEnd = messageId;
            autoStartOverridden = true;
        }
    } else {
        // Subsequent click: set end (ensure start <= end)
        selectionEnd = messageId;
    }

    // Normalize so start <= end
    if (selectionStart !== null && selectionEnd !== null && selectionStart > selectionEnd) {
        [selectionStart, selectionEnd] = [selectionEnd, selectionStart];
    }

    updateSelectionHighlight();
    updateActionBar();
}

/**
 * Update the CSS highlight on selected messages.
 */
function updateSelectionHighlight() {
    const chatEl = getChatElement();
    chatEl.find('.mes').removeClass('scene-fold-selected scene-fold-selection-start scene-fold-selection-end');

    if (selectionStart === null || selectionEnd === null) return;

    for (let i = selectionStart; i <= selectionEnd; i++) {
        const msgEl = chatEl.find(`.mes[mesid="${i}"]`);
        msgEl.addClass('scene-fold-selected');
        if (i === selectionStart) msgEl.addClass('scene-fold-selection-start');
        if (i === selectionEnd) msgEl.addClass('scene-fold-selection-end');
    }
}

/**
 * Show the floating action bar for scene creation.
 */
function showActionBar() {
    let bar = $('#scene-fold-action-bar');
    if (bar.length === 0) {
        bar = $(`
            <div id="scene-fold-action-bar" class="scene-fold-action-bar">
                <span class="scene-fold-action-bar-info"></span>
                <textarea id="scene-fold-custom-prompt"
                    class="scene-fold-custom-prompt"
                    placeholder="Optional: scene-specific summarization guidance..."
                    rows="2"></textarea>
                <div class="scene-fold-action-bar-buttons">
                    <button id="scene-fold-create-btn" class="menu_button">Create Scene</button>
                    <button id="scene-fold-cancel-btn" class="menu_button">Cancel</button>
                </div>
            </div>
        `);
        $('body').append(bar);
    }
    bar.show();
}

/**
 * Update the action bar info text.
 */
function updateActionBar() {
    const bar = $('#scene-fold-action-bar');
    if (!bar.length) return;

    const info = bar.find('.scene-fold-action-bar-info');
    if (selectionStart !== null && selectionEnd !== null) {
        const count = selectionEnd - selectionStart + 1;
        info.text(`${count} message${count !== 1 ? 's' : ''} selected (${selectionStart} - ${selectionEnd})`);
        bar.find('#scene-fold-create-btn').prop('disabled', false);
    } else {
        info.text('Click messages to select a scene range');
        bar.find('#scene-fold-create-btn').prop('disabled', true);
    }
}

/**
 * Hide the floating action bar.
 */
function hideActionBar() {
    $('#scene-fold-action-bar').hide();
}

// ─── Message Action Buttons ──────────────────────────────────────────────────

/**
 * Inject Scene Fold buttons into message action button areas.
 * Adds "Scene to here" and "Select scene..." to each message's extraMesButtons.
 * @param {object} context
 */
export function injectMessageButtons(context) {
    const { chat, chatMetadata } = context;
    const chatEl = getChatElement();
    const autoStart = getAutoStartIndex(chatMetadata, chat);

    chatEl.find('.mes').each(function () {
        const mesEl = $(this);
        const mesId = Number(mesEl.attr('mesid'));
        if (isNaN(mesId)) return;

        const extraButtons = mesEl.find('.extraMesButtons');
        if (!extraButtons.length) return;

        // Skip if we already injected
        if (extraButtons.find('.scene-fold-mes-btn').length) return;

        // "Scene to here" — one-click scene creation from auto-start through this message
        // Only show if this message is at or after auto-start and not already in a completed scene
        const scenes = getMessageScenes(chat, mesId);
        const data = getSceneFoldData(chatMetadata);
        const inCompletedScene = scenes.some(id => data.scenes[id]?.status === 'completed');

        if (!inCompletedScene && mesId >= autoStart) {
            extraButtons.prepend(
                `<div class="mes_button scene-fold-mes-btn scene-fold-scene-to-here"
                      data-mesid="${mesId}" title="Create scene from message ${autoStart} to here">
                    <i class="fa-solid fa-scissors"></i>
                </div>`,
            );
        }

        extraButtons.prepend(
            `<div class="mes_button scene-fold-mes-btn scene-fold-enter-selection"
                  data-mesid="${mesId}" title="Start scene selection from here">
                <i class="fa-solid fa-object-group"></i>
            </div>`,
        );
    });
}

/**
 * Inject Scene Fold buttons into a single rendered message.
 * @param {object} context
 * @param {number} messageId
 */
export function injectSingleMessageButtons(context, messageId) {
    const { chat, chatMetadata } = context;
    const chatEl = getChatElement();
    const mesEl = chatEl.find(`.mes[mesid="${messageId}"]`);
    if (!mesEl.length) return;

    const extraButtons = mesEl.find('.extraMesButtons');
    if (!extraButtons.length || extraButtons.find('.scene-fold-mes-btn').length) return;

    const autoStart = getAutoStartIndex(chatMetadata, chat);
    const scenes = getMessageScenes(chat, messageId);
    const data = getSceneFoldData(chatMetadata);
    const inCompletedScene = scenes.some(id => data.scenes[id]?.status === 'completed');

    if (!inCompletedScene && messageId >= autoStart) {
        extraButtons.prepend(
            `<div class="mes_button scene-fold-mes-btn scene-fold-scene-to-here"
                  data-mesid="${messageId}" title="Create scene from message ${autoStart} to here">
                <i class="fa-solid fa-scissors"></i>
            </div>`,
        );
    }

    extraButtons.prepend(
        `<div class="mes_button scene-fold-mes-btn scene-fold-enter-selection"
              data-mesid="${messageId}" title="Start scene selection from here">
            <i class="fa-solid fa-object-group"></i>
        </div>`,
    );
}

// ─── Fold Visualization ─────────────────────────────────────────────────────

/**
 * Apply fold visuals to all scenes in the current chat.
 * Called on CHAT_CHANGED and after summarization completes.
 * @param {object} context
 */
export function applyAllFoldVisuals(context) {
    const { chat, chatMetadata } = context;
    const data = getSceneFoldData(chatMetadata);
    const chatEl = getChatElement();
    const debugOverlay = !!context.extensionSettings?.scene_fold?.debugOverlay;

    // Clear all existing fold visuals
    chatEl.find('.mes').removeClass('scene-fold-source scene-fold-hidden scene-fold-summary');
    chatEl.find('.scene-fold-toggle').remove();
    chatEl.find('.scene-fold-badge').remove();
    chatEl.find('.scene-fold-scene-border').remove();
    chatEl.find('.scene-fold-collapse-tail').remove();
    chatEl.find('.scene-fold-status-badge').remove();
    chatEl.find('.scene-fold-inline-actions').remove();
    chatEl.find('.scene-fold-debug').remove();

    const uuidIndex = buildUUIDIndex(chat);

    for (const scene of Object.values(data.scenes)) {
        applySceneFoldVisuals(context, scene, uuidIndex);
    }

    // Debug overlay pass — show mesid on every message, extra scene metadata when present
    if (debugOverlay) {
        chatEl.find('.mes').each(function () {
            const mesEl = $(this);
            const mesId = Number(mesEl.attr('mesid'));
            if (isNaN(mesId)) return;

            const parts = [`mesid=${mesId}`];

            if (chat[mesId]) {
                const msg = chat[mesId];
                const extra = msg.extra || {};
                if (extra.scene_fold_uuid) parts.push(`uuid=${extra.scene_fold_uuid.slice(0, 8)}`);
                if (extra.scene_fold_role) parts.push(`role=${extra.scene_fold_role}`);
                if (extra.scene_fold_scenes?.length) {
                    parts.push(`scenes=[${extra.scene_fold_scenes.map(id => id.slice(0, 8)).join(', ')}]`);
                }
                if (extra.scene_fold_scene_id) parts.push(`scene_id=${extra.scene_fold_scene_id.slice(0, 8)}`);
                parts.push(`is_system=${!!msg.is_system}`);
            }

            mesEl.find('.mes_block').prepend(
                `<div class="scene-fold-debug">${parts.join('  |  ')}</div>`,
            );
        });
    }
}

/**
 * Apply fold visuals for a single scene.
 * @param {object} context
 * @param {object} scene
 * @param {Map<string, number>} [uuidIndex]
 */
export function applySceneFoldVisuals(context, scene, uuidIndex) {
    const { chat } = context;
    const chatEl = getChatElement();

    if (!uuidIndex) {
        uuidIndex = buildUUIDIndex(chat);
    }

    // Mark source messages
    const lastSourceUUID = scene.sourceMessageUUIDs[scene.sourceMessageUUIDs.length - 1];
    for (const uuid of scene.sourceMessageUUIDs) {
        const idx = findMessageIndexByUUID(chat, uuid, uuidIndex);
        if (idx === -1) continue;

        const msgEl = chatEl.find(`.mes[mesid="${idx}"]`);
        msgEl.addClass('scene-fold-source');

        if (scene.folded && scene.status === 'completed') {
            msgEl.addClass('scene-fold-hidden');
        }

        // Add scene color border
        if (!msgEl.find('.scene-fold-scene-border').length) {
            msgEl.prepend(`<div class="scene-fold-scene-border" data-scene-id="${scene.id}"></div>`);
        }

        // Add collapse control on the last source message of completed, expanded scenes
        if (uuid === lastSourceUUID && scene.status === 'completed' && !scene.folded) {
            if (!msgEl.find('.scene-fold-collapse-tail').length) {
                const count = scene.sourceMessageUUIDs.length;
                msgEl.find('.mes_text').after(`
                    <div class="scene-fold-collapse-tail" data-scene-id="${scene.id}">
                        <span class="scene-fold-toggle-icon fa-solid fa-chevron-up"></span>
                        <span>Collapse ${count} message${count !== 1 ? 's' : ''}</span>
                    </div>
                `);
            }
        }
    }

    // Build the shared prompt editor HTML for any scene state
    const promptValue = (scene.customPrompt || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const promptEditorHtml = `
        <div class="scene-fold-prompt-editor" data-scene-id="${scene.id}">
            <textarea class="scene-fold-prompt-textarea" data-scene-id="${scene.id}"
                placeholder="Extra guidance for this scene (appended to the default prompt)..."
                rows="2">${scene.customPrompt || ''}</textarea>
        </div>
    `;

    // Mark and enhance summary message
    if (scene.summaryMessageUUID && scene.status === 'completed') {
        const summaryIdx = findMessageIndexByUUID(chat, scene.summaryMessageUUID, uuidIndex);
        if (summaryIdx === -1) return;

        const summaryEl = chatEl.find(`.mes[mesid="${summaryIdx}"]`);
        summaryEl.addClass('scene-fold-summary');

        const count = scene.sourceMessageUUIDs.length;

        // Count source messages that are visible to the LLM (is_system !== true)
        let visibleCount = 0;
        for (const uuid of scene.sourceMessageUUIDs) {
            const idx = findMessageIndexByUUID(chat, uuid, uuidIndex);
            if (idx !== -1 && !chat[idx].is_system) visibleCount++;
        }
        const visibleHtml = visibleCount > 0 ? `
            <span class="scene-fold-visible-badge" title="${visibleCount} source message${visibleCount !== 1 ? 's are' : ' is'} visible to the AI">
                <i class="fa-solid fa-circle"></i> ${visibleCount} visible
            </span>
        ` : '';

        const staleHtml = scene.stale ? `
            <span class="scene-fold-stale-badge" title="Source messages modified since summarization. Consider re-summarizing.">
                <i class="fa-solid fa-triangle-exclamation"></i> Stale
            </span>
        ` : '';
        const toggleHtml = `
            <div class="scene-fold-inline-actions" data-scene-id="${scene.id}">
                <div class="scene-fold-inline-actions-row">
                    <div class="scene-fold-toggle" data-scene-id="${scene.id}">
                        <span class="scene-fold-toggle-icon fa-solid ${scene.folded ? 'fa-chevron-right' : 'fa-chevron-down'}"></span>
                        <span class="scene-fold-badge">${count} message${count !== 1 ? 's' : ''} ${scene.folded ? 'folded' : 'expanded'}</span>
                        ${visibleHtml}
                    </div>
                    ${staleHtml}
                    <div class="scene-fold-inline-buttons">
                        <button class="scene-fold-inline-btn scene-fold-edit-prompt-btn" data-scene-id="${scene.id}" title="Edit scene prompt">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="scene-fold-inline-btn scene-fold-undo-btn" data-scene-id="${scene.id}" title="Undo summarization (restore original messages)">
                            <i class="fa-solid fa-up-down"></i>
                        </button>
                        <button class="scene-fold-inline-btn scene-fold-retry-btn" data-scene-id="${scene.id}" title="Re-summarize">
                            <i class="fa-solid fa-rotate-right"></i>
                        </button>
                        <button class="scene-fold-inline-btn scene-fold-delete-btn" data-scene-id="${scene.id}" title="Remove scene">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
                ${promptEditorHtml}
            </div>
        `;
        summaryEl.find('.mes_text').after(toggleHtml);
    }

    // Inline controls for scenes that haven't been summarized yet
    if (scene.status === 'defined' || scene.status === 'error' || scene.status === 'summarizing' || scene.status === 'queued') {
        const firstIdx = findMessageIndexByUUID(chat, scene.sourceMessageUUIDs[0], uuidIndex);
        if (firstIdx === -1) return;

        const firstEl = chatEl.find(`.mes[mesid="${firstIdx}"]`);
        const count = scene.sourceMessageUUIDs.length;

        let statusText, statusClass;
        if (scene.status === 'defined') {
            statusText = `Scene: ${count} message${count !== 1 ? 's' : ''}`;
            statusClass = '';
        } else if (scene.status === 'queued') {
            statusText = 'Queued...';
            statusClass = 'scene-fold-status-queued';
        } else if (scene.status === 'summarizing') {
            statusText = 'Summarizing...';
            statusClass = 'scene-fold-status-active';
        } else {
            statusText = `Error: ${scene.lastError || 'unknown'}`;
            statusClass = 'scene-fold-status-error';
        }

        const canSummarize = scene.status === 'defined' || scene.status === 'error';
        const canCancel = scene.status === 'queued' || scene.status === 'summarizing';
        const actionsHtml = `
            <div class="scene-fold-inline-actions ${statusClass}" data-scene-id="${scene.id}">
                <div class="scene-fold-inline-actions-row">
                    <span class="scene-fold-inline-status">${statusText}</span>
                    <div class="scene-fold-inline-buttons">
                        <button class="scene-fold-inline-btn scene-fold-edit-prompt-btn" data-scene-id="${scene.id}" title="Edit scene prompt">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        ${canSummarize ? `
                            <button class="scene-fold-inline-btn scene-fold-summarize-btn" data-scene-id="${scene.id}" title="Summarize this scene">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> Summarize
                            </button>
                        ` : ''}
                        ${canCancel ? `
                            <button class="scene-fold-inline-btn scene-fold-cancel-btn" data-scene-id="${scene.id}" title="Cancel">
                                <i class="fa-solid fa-xmark"></i> Cancel
                            </button>
                        ` : ''}
                        <button class="scene-fold-inline-btn scene-fold-delete-btn" data-scene-id="${scene.id}" title="Remove scene">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
                ${promptEditorHtml}
            </div>
        `;
        firstEl.find('.mes_block').prepend(actionsHtml);
    }
}

/**
 * Toggle a scene's fold state (expand/collapse source messages).
 * @param {object} context
 * @param {string} sceneId
 */
export function toggleFold(context, sceneId) {
    const { chatMetadata } = context;
    const data = getSceneFoldData(chatMetadata);
    const scene = data.scenes[sceneId];
    if (!scene || scene.status !== 'completed') return;

    scene.folded = !scene.folded;

    // Re-apply visuals
    applyAllFoldVisuals(context);
}

// ─── Chat Toolbar ───────────────────────────────────────────────────────────

/**
 * Create or update the sticky toolbar at the top of the chat column.
 * Shows scene counts + action buttons when idle, progress + cancel when processing.
 * @param {object} context
 * @param {import('./summarization-queue.js').SummarizationQueue} queue
 */
export function updateToolbar(context, queue) {
    const { chat, chatMetadata } = context;

    // Ensure toolbar element exists
    let toolbar = $('#scene-fold-toolbar');
    if (toolbar.length === 0) {
        toolbar = $(`
            <div id="scene-fold-toolbar" class="scene-fold-toolbar" style="display:none">
                <div class="scene-fold-toolbar-idle">
                    <span class="scene-fold-toolbar-info"></span>
                    <div class="scene-fold-toolbar-buttons">
                        <button class="scene-fold-toolbar-btn scene-fold-toolbar-select-mode" title="Enter scene selection mode">
                            <i class="fa-solid fa-object-group"></i> Select Scene
                        </button>
                        <button class="scene-fold-toolbar-btn scene-fold-toolbar-summarize-all" title="Summarize all pending scenes">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Summarize All
                        </button>
                    </div>
                </div>
                <div class="scene-fold-toolbar-active" style="display:none">
                    <span class="scene-fold-toolbar-progress-label"></span>
                    <div class="scene-fold-progress-bar">
                        <div class="scene-fold-progress-fill"></div>
                    </div>
                    <button class="scene-fold-toolbar-btn scene-fold-cancel-all" title="Cancel all queued summarizations">
                        <i class="fa-solid fa-stop"></i> Cancel All
                    </button>
                </div>
            </div>
        `);
        getChatElement().prepend(toolbar);
    }

    if (!chat || chat.length === 0) {
        toolbar.fadeOut(200);
        return;
    }

    const scenes = getScenesInOrder(chatMetadata, chat);
    const isProcessing = queue?.isProcessing;

    // Count scenes by status
    const counts = { defined: 0, completed: 0, error: 0, queued: 0 };
    for (const scene of scenes) {
        if (counts[scene.status] !== undefined) counts[scene.status]++;
    }

    const hasPending = counts.defined > 0 || counts.error > 0 || counts.queued > 0;
    const shouldShow = hasPending || isProcessing;

    if (shouldShow) {
        if (!toolbar.is(':visible')) toolbar.fadeIn(200);
    } else {
        if (toolbar.is(':visible')) toolbar.fadeOut(200);
        return;
    }

    if (isProcessing) {
        // Active state: show progress
        toolbar.find('.scene-fold-toolbar-idle').hide();
        toolbar.find('.scene-fold-toolbar-active').show();

        const progress = queue.progress;
        const done = progress.current - 1;
        const pct = progress.total > 0 ? Math.round(done / progress.total * 100) : 0;
        const remaining = progress.total - done;
        toolbar.find('.scene-fold-toolbar-progress-label').text(
            `Summarizing ${progress.current} of ${progress.total} (${remaining} remaining)`,
        );
        toolbar.find('.scene-fold-progress-fill').css('width', `${pct}%`);
    } else {
        // Idle state: show scene counts + buttons
        toolbar.find('.scene-fold-toolbar-idle').show();
        toolbar.find('.scene-fold-toolbar-active').hide();

        const parts = [];
        if (counts.defined > 0) parts.push(`${counts.defined} pending`);
        if (counts.error > 0) parts.push(`${counts.error} failed`);
        if (counts.queued > 0) parts.push(`${counts.queued} queued`);

        const pendingTotal = counts.defined + counts.error + counts.queued;
        const infoText = `${pendingTotal} scene${pendingTotal !== 1 ? 's' : ''} awaiting summary`;
        toolbar.find('.scene-fold-toolbar-info').text(infoText);

        // Update select mode button text
        const selectBtn = toolbar.find('.scene-fold-toolbar-select-mode');
        if (selectionModeActive) {
            selectBtn.html('<i class="fa-solid fa-xmark"></i> Exit Selection');
        } else {
            selectBtn.html('<i class="fa-solid fa-object-group"></i> Select Scene');
        }

        toolbar.find('.scene-fold-toolbar-summarize-all').prop('disabled', !hasPending);
    }
}
