/**
 * Scene Fold - SillyTavern Extension
 *
 * Manual scene-based summarization with hierarchical folding.
 * Users define scenes (contiguous message ranges), generate summaries via LLM,
 * and fold source messages under their summary to save prompt context.
 */

import {
    createScene,
    deleteScene,
    getScene,
    updateScene,
    getScenesInOrder,
    findMessageIndexByUUID,
    buildUUIDIndex,
    findOverlappingScenes,
    getAutoStartIndex,
    getDefaultSummarizationPrompt,
} from './scene-data.js';

import {
    toggleSelectionMode,
    isSelectionModeActive,
    getSelectionRange,
    exitSelectionMode,
    handleMessageClick,
    applyAllFoldVisuals,
    injectMessageButtons,
    injectSingleMessageButtons,
    toggleFold,
} from './scene-ui.js';

const MODULE_NAME = 'scene_fold';
const EXTENSION_NAME = 'scene-fold';

/** Default extension settings */
const DEFAULT_SETTINGS = {
    enabled: true,
    smartAutoStart: true,
    defaultPrompt: getDefaultSummarizationPrompt(),
};

/**
 * Get the extension settings, initializing defaults if needed.
 * @param {object} extensionSettings
 * @returns {object}
 */
function getSettings(extensionSettings) {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    return extensionSettings[MODULE_NAME];
}

/**
 * Load settings into the UI elements.
 * @param {object} context
 */
function loadSettingsUI(context) {
    const settings = getSettings(context.extensionSettings);
    $('#scene_fold_enabled').prop('checked', settings.enabled);
    $('#scene_fold_smart_auto_start').prop('checked', settings.smartAutoStart);
    $('#scene_fold_default_prompt').val(settings.defaultPrompt);
}

/**
 * Render the scene list in the settings panel.
 * @param {object} context
 */
function renderSceneList(context) {
    const { chat, chatMetadata } = context;
    const container = $('#scene_fold_scene_list');
    if (!container.length) return;

    const scenes = getScenesInOrder(chatMetadata, chat);

    if (scenes.length === 0) {
        container.html('<i>No scenes defined yet.</i>');
        return;
    }

    const uuidIndex = buildUUIDIndex(chat);

    const items = scenes.map(scene => {
        const firstIdx = findMessageIndexByUUID(chat, scene.sourceMessageUUIDs[0], uuidIndex);
        const lastIdx = findMessageIndexByUUID(chat, scene.sourceMessageUUIDs[scene.sourceMessageUUIDs.length - 1], uuidIndex);
        const rangeText = firstIdx >= 0 && lastIdx >= 0
            ? `Messages ${firstIdx}-${lastIdx} (${scene.sourceMessageUUIDs.length})`
            : `${scene.sourceMessageUUIDs.length} messages`;

        const statusClass = scene.status;
        const statusLabel = scene.status.charAt(0).toUpperCase() + scene.status.slice(1);

        let actions = '';
        if (scene.status === 'defined') {
            actions = `
                <button class="menu_button scene-fold-summarize-btn" data-scene-id="${scene.id}" title="Summarize this scene">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                </button>
                <button class="menu_button scene-fold-delete-btn" data-scene-id="${scene.id}" title="Delete scene">
                    <i class="fa-solid fa-trash"></i>
                </button>
            `;
        } else if (scene.status === 'completed') {
            actions = `
                <button class="menu_button scene-fold-toggle-fold-btn" data-scene-id="${scene.id}" title="${scene.folded ? 'Expand' : 'Collapse'}">
                    <i class="fa-solid ${scene.folded ? 'fa-eye' : 'fa-eye-slash'}"></i>
                </button>
                <button class="menu_button scene-fold-retry-btn" data-scene-id="${scene.id}" title="Retry summarization">
                    <i class="fa-solid fa-rotate-right"></i>
                </button>
            `;
        } else if (scene.status === 'error') {
            actions = `
                <button class="menu_button scene-fold-retry-btn" data-scene-id="${scene.id}" title="Retry summarization">
                    <i class="fa-solid fa-rotate-right"></i>
                </button>
                <button class="menu_button scene-fold-delete-btn" data-scene-id="${scene.id}" title="Delete scene">
                    <i class="fa-solid fa-trash"></i>
                </button>
            `;
        } else if (scene.status === 'summarizing' || scene.status === 'queued') {
            // Stuck in-progress state — offer retry and delete
            actions = `
                <button class="menu_button scene-fold-retry-btn" data-scene-id="${scene.id}" title="Reset and retry">
                    <i class="fa-solid fa-rotate-right"></i>
                </button>
                <button class="menu_button scene-fold-delete-btn" data-scene-id="${scene.id}" title="Delete scene">
                    <i class="fa-solid fa-trash"></i>
                </button>
            `;
        }

        return `
            <div class="scene-fold-scene-item" data-scene-id="${scene.id}">
                <div class="scene-fold-scene-info">${rangeText}</div>
                <span class="scene-fold-scene-status ${statusClass}">${statusLabel}</span>
                <div class="scene-fold-scene-actions">${actions}</div>
            </div>
        `;
    });

    container.html(items.join(''));
}

// ─── Summarization ───────────────────────────────────────────────────────────

/**
 * Summarize a single scene: build prompt, call LLM, insert summary message.
 * @param {object} context
 * @param {string} sceneId
 */
async function summarizeScene(context, sceneId) {
    console.log(`[Scene Fold] summarizeScene called for scene ${sceneId}`);
    const { chat, chatMetadata, generateRaw, saveChat, saveMetadataDebounced, uuidv4 } = context;

    // Validate critical APIs exist on the context
    if (typeof generateRaw !== 'function') {
        const msg = `generateRaw is not available on context (got ${typeof generateRaw}). Available keys: ${Object.keys(context).filter(k => typeof context[k] === 'function').join(', ')}`;
        console.error(`[Scene Fold] ${msg}`);
        toastr.error(`Scene Fold: ${msg}`);
        return;
    }

    const settings = getSettings(context.extensionSettings);
    const scene = getScene(chatMetadata, sceneId);

    if (!scene || (scene.status !== 'defined' && scene.status !== 'error')) {
        console.warn(`[Scene Fold] Cannot summarize scene ${sceneId}: status=${scene?.status}`);
        toastr.warning(`Scene Fold: cannot summarize — scene status is "${scene?.status ?? 'not found'}"`);
        return;
    }

    console.log(`[Scene Fold] Scene ${sceneId}: ${scene.sourceMessageUUIDs.length} source messages, status=${scene.status}`);
    updateScene(chatMetadata, sceneId, { status: 'summarizing', lastError: null });
    renderSceneList(context);

    try {
        // Build the message text for the prompt
        const uuidIndex = buildUUIDIndex(chat);
        const sourceTexts = [];
        const sourceIndices = [];

        for (const uuid of scene.sourceMessageUUIDs) {
            const idx = findMessageIndexByUUID(chat, uuid, uuidIndex);
            if (idx === -1) {
                console.warn(`[Scene Fold] Source UUID ${uuid} not found in chat`);
                continue;
            }
            const msg = chat[idx];
            const speaker = msg.is_user ? (context.name1 || 'User') : (msg.name || context.name2 || 'Character');
            sourceTexts.push(`${speaker}: ${msg.mes}`);
            sourceIndices.push(idx);
        }

        if (sourceTexts.length === 0) {
            throw new Error('No source messages found for this scene — UUIDs may be stale');
        }

        console.log(`[Scene Fold] Built prompt from ${sourceTexts.length} messages (indices: ${sourceIndices.join(', ')})`);

        // Compose the prompt — generateRaw is bare (no chat history), so we pass
        // the summarization instructions as the system prompt and scene text as the user prompt.
        // Custom prompt is additive: appended to the default prompt as extra guidance.
        let systemPrompt = settings.defaultPrompt;
        if (scene.customPrompt) {
            systemPrompt += '\n\nAdditional guidance for this scene:\n' + scene.customPrompt;
        }
        const sceneText = sourceTexts.join('\n\n');

        console.log(`[Scene Fold] Calling generateRaw (prompt length: ${sceneText.length}, systemPrompt length: ${systemPrompt.length})...`);

        // Call the LLM (generateRaw doesn't touch is_send_press, so it runs
        // fully in parallel with normal chat generation)
        const summary = await generateRaw({ prompt: sceneText, systemPrompt });

        console.log(`[Scene Fold] generateRaw returned: ${summary === null ? 'null' : summary === undefined ? 'undefined' : `string(${summary.length})`}`);

        if (!summary || summary.trim().length === 0) {
            throw new Error('LLM returned an empty summary');
        }

        // Determine insertion point (before the first source message)
        const firstSourceIdx = Math.min(...sourceIndices);
        console.log(`[Scene Fold] Inserting summary message at index ${firstSourceIdx}`);

        // Create the summary message object
        const summaryMessage = {
            name: 'Scene Summary',
            is_user: false,
            is_system: false, // Included in prompts — this IS the replacement context
            mes: summary.trim(),
            force_avatar: '',
            extra: {
                type: 'narrator',
                scene_fold_role: 'summary',
                scene_fold_scene_id: sceneId,
                scene_fold_uuid: uuidv4(),
            },
        };

        // Insert into chat array at the correct position
        chat.splice(firstSourceIdx, 0, summaryMessage);

        // Mark source messages as hidden from prompts (indices shifted by 1 due to insertion)
        for (const uuid of scene.sourceMessageUUIDs) {
            const idx = findMessageIndexByUUID(chat, uuid);
            if (idx === -1) continue;
            chat[idx].is_system = true;
        }

        // Update scene metadata
        updateScene(chatMetadata, sceneId, {
            status: 'completed',
            folded: true,
            summaryMessageUUID: summaryMessage.extra.scene_fold_uuid,
        });

        // Persist and reload chat to correctly render all messages with proper mesid values
        console.log('[Scene Fold] Saving chat and reloading...');
        await saveChat();
        saveMetadataDebounced();
        await context.reloadCurrentChat();

        // Re-apply fold visuals after reload (context needs to be refreshed)
        const freshContext = SillyTavern.getContext();
        applyAllFoldVisuals(freshContext);
        renderSceneList(freshContext);

        console.log(`[Scene Fold] Scene ${sceneId} summarization complete`);
        toastr.success(`Scene summarized (${scene.sourceMessageUUIDs.length} messages folded)`);
    } catch (error) {
        console.error('[Scene Fold] Summarization failed:', error);
        updateScene(chatMetadata, sceneId, {
            status: 'error',
            lastError: error.message || String(error),
        });
        saveMetadataDebounced();
        renderSceneList(context);
        applyAllFoldVisuals(context);
        toastr.error(`Scene summarization failed: ${error.message}`);
    }
}

/**
 * Retry summarization for a scene. Removes existing summary, un-hides sources, re-summarizes.
 * @param {object} context
 * @param {string} sceneId
 */
async function retrySummarization(context, sceneId) {
    console.log(`[Scene Fold] retrySummarization called for scene ${sceneId}`);
    const { chat, chatMetadata, saveChat, saveMetadataDebounced } = context;
    const scene = getScene(chatMetadata, sceneId);
    if (!scene) {
        console.warn(`[Scene Fold] Retry: scene ${sceneId} not found`);
        return;
    }

    // If there's an existing summary message, remove it
    if (scene.summaryMessageUUID) {
        const summaryIdx = findMessageIndexByUUID(chat, scene.summaryMessageUUID);
        if (summaryIdx !== -1) {
            chat.splice(summaryIdx, 1);
        }
    }

    // Un-hide source messages
    for (const uuid of scene.sourceMessageUUIDs) {
        const idx = findMessageIndexByUUID(chat, uuid);
        if (idx === -1) continue;
        chat[idx].is_system = false;
    }

    // Reset scene state
    updateScene(chatMetadata, sceneId, {
        status: 'defined',
        folded: false,
        summaryMessageUUID: null,
        lastError: null,
    });

    await saveChat();
    saveMetadataDebounced();

    // Reload chat to reflect removed summary message
    await context.reloadCurrentChat();

    // Now re-summarize
    const freshContext = SillyTavern.getContext();
    await summarizeScene(freshContext, sceneId);
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

/**
 * Handle CHAT_CHANGED: restore fold visuals from metadata.
 */
function onChatChanged() {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);
    if (!settings.enabled) return;

    // Exit selection mode if active
    if (isSelectionModeActive()) {
        exitSelectionMode();
    }

    // Reset any scenes stuck in transient states (summarizing/queued) — these
    // can't still be in-progress after a chat load, so they failed silently
    const { chatMetadata } = context;
    const data = chatMetadata.scene_fold;
    if (data?.scenes) {
        let resetCount = 0;
        for (const scene of Object.values(data.scenes)) {
            if (scene.status === 'summarizing' || scene.status === 'queued') {
                scene.status = 'error';
                scene.lastError = scene.lastError || 'Interrupted — scene was still in progress when chat reloaded';
                resetCount++;
            }
        }
        if (resetCount > 0) {
            console.log(`[Scene Fold] Reset ${resetCount} stuck scene(s) to error state`);
            context.saveMetadataDebounced();
        }
    }

    // Apply fold visuals and message buttons from persisted state
    applyAllFoldVisuals(context);
    injectMessageButtons(context);
    renderSceneList(context);
}

/**
 * Handle message render events: inject buttons and apply fold visuals.
 * @param {number} messageId
 */
function onMessageRendered(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);
    if (!settings.enabled) return;

    injectSingleMessageButtons(context, messageId);

    // Apply fold visuals if this message is part of a scene
    const msg = context.chat[messageId];
    if (msg?.extra?.scene_fold_scene_id || msg?.extra?.scene_fold_scenes) {
        applyAllFoldVisuals(context);
    }
}

// ─── Initialization ──────────────────────────────────────────────────────────

jQuery(async () => {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);

    // Load the settings HTML template
    const settingsHtml = await $.get(`/scripts/extensions/third-party/${EXTENSION_NAME}/settings.html`);
    $('#extensions_settings2').append(settingsHtml);

    // Populate UI with current settings
    loadSettingsUI(context);

    // ─── Settings Event Handlers ─────────────────────────────────────────

    $('#scene_fold_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        context.saveSettingsDebounced();
        if (!settings.enabled && isSelectionModeActive()) {
            exitSelectionMode();
        }
    });

    $('#scene_fold_smart_auto_start').on('change', function () {
        settings.smartAutoStart = $(this).prop('checked');
        context.saveSettingsDebounced();
    });

    $('#scene_fold_default_prompt').on('input', function () {
        settings.defaultPrompt = $(this).val();
        context.saveSettingsDebounced();
    });

    // ─── Control Button Handlers ─────────────────────────────────────────

    $('#scene_fold_select_mode_btn').on('click', function () {
        const ctx = SillyTavern.getContext();
        const s = getSettings(ctx.extensionSettings);
        if (!s.enabled) {
            toastr.warning('Scene Fold is disabled. Enable it first.');
            return;
        }
        toggleSelectionMode(ctx, s);

        // Update button text
        $(this).find('span').text(isSelectionModeActive() ? 'Exit Selection Mode' : 'Scene Selection Mode');
        $(this).toggleClass('active', isSelectionModeActive());
    });

    $('#scene_fold_summarize_all_btn').on('click', async function () {
        const ctx = SillyTavern.getContext();
        const scenes = getScenesInOrder(ctx.chatMetadata, ctx.chat);
        const pendingScenes = scenes.filter(s => s.status === 'defined');
        console.log(`[Scene Fold] Summarize All clicked: ${pendingScenes.length} pending of ${scenes.length} total`);

        if (pendingScenes.length === 0) {
            toastr.info('No pending scenes to summarize.');
            return;
        }

        toastr.info(`Summarizing ${pendingScenes.length} scene(s)...`);

        for (const scene of pendingScenes) {
            const freshCtx = SillyTavern.getContext();
            await summarizeScene(freshCtx, scene.id);
        }
    });

    // ─── Chat Click Handler (Selection Mode) ─────────────────────────────

    $(document).on('click', '#chat .mes', function (event) {
        if (!isSelectionModeActive()) return;

        // Don't interfere with button clicks inside messages
        if ($(event.target).closest('.mes_buttons, .mes_button, .scene-fold-toggle, a, button').length) return;

        event.preventDefault();
        event.stopPropagation();

        const messageId = Number($(this).attr('mesid'));
        if (isNaN(messageId)) return;

        const ctx = SillyTavern.getContext();
        handleMessageClick(messageId, event.shiftKey, ctx);
    });

    // ─── Action Bar Handlers ─────────────────────────────────────────────

    $(document).on('click', '#scene-fold-create-btn', function () {
        const ctx = SillyTavern.getContext();
        const range = getSelectionRange();
        console.log(`[Scene Fold] Create Scene clicked, range: ${range.start}-${range.end}`);
        if (range.start === null || range.end === null) return;

        // Check for overlaps
        const overlaps = findOverlappingScenes(ctx.chatMetadata, ctx.chat, range.start, range.end);
        if (overlaps.length > 0) {
            toastr.warning('Selected messages overlap with an existing scene. Please adjust your selection.');
            return;
        }

        // Get custom prompt from action bar
        const customPrompt = $('#scene-fold-custom-prompt').val()?.trim() || null;

        // Create the scene
        const scene = createScene(ctx.chatMetadata, ctx.chat, range.start, range.end, ctx.uuidv4, customPrompt);
        console.log(`[Scene Fold] Scene created: id=${scene.id}, messages=${scene.sourceMessageUUIDs.length}, UUIDs=${scene.sourceMessageUUIDs.join(', ')}`);

        // Persist
        ctx.saveChat();
        ctx.saveMetadataDebounced();

        // Exit selection mode
        exitSelectionMode();
        $('#scene_fold_select_mode_btn').find('span').text('Scene Selection Mode');
        $('#scene_fold_select_mode_btn').removeClass('active');

        // Refresh UI
        applyAllFoldVisuals(ctx);
        renderSceneList(ctx);

        toastr.success(`Scene created with ${scene.sourceMessageUUIDs.length} messages`);
    });

    $(document).on('click', '#scene-fold-cancel-btn', function () {
        exitSelectionMode();
        $('#scene_fold_select_mode_btn').find('span').text('Scene Selection Mode');
        $('#scene_fold_select_mode_btn').removeClass('active');
    });

    // ─── Scene List Action Handlers ──────────────────────────────────────

    $(document).on('click', '.scene-fold-summarize-btn', async function () {
        const sceneId = $(this).data('scene-id');
        console.log(`[Scene Fold] Summarize button clicked for scene ${sceneId}`);
        const ctx = SillyTavern.getContext();
        await summarizeScene(ctx, sceneId);
    });

    $(document).on('click', '.scene-fold-delete-btn', async function () {
        const sceneId = $(this).data('scene-id');
        console.log(`[Scene Fold] Delete button clicked for scene ${sceneId}`);
        const ctx = SillyTavern.getContext();
        const scene = getScene(ctx.chatMetadata, sceneId);
        if (!scene) return;

        // If the scene has a summary, remove it
        if (scene.summaryMessageUUID) {
            const summaryIdx = findMessageIndexByUUID(ctx.chat, scene.summaryMessageUUID);
            if (summaryIdx !== -1) {
                ctx.chat.splice(summaryIdx, 1);
            }
        }

        // Un-hide source messages
        for (const uuid of scene.sourceMessageUUIDs) {
            const idx = findMessageIndexByUUID(ctx.chat, uuid);
            if (idx === -1) continue;
            ctx.chat[idx].is_system = false;
        }

        deleteScene(ctx.chatMetadata, ctx.chat, sceneId);

        await ctx.saveChat();
        ctx.saveMetadataDebounced();
        await ctx.reloadCurrentChat();

        toastr.info('Scene deleted');
    });

    // ─── Prompt Editor Handlers ─────────────────────────────────────────

    // Toggle prompt editor visibility
    $(document).on('click', '.scene-fold-edit-prompt-btn', function () {
        const sceneId = $(this).data('scene-id');
        const editor = $(this).closest('.scene-fold-inline-actions').find(`.scene-fold-prompt-editor[data-scene-id="${sceneId}"]`);
        editor.toggleClass('scene-fold-prompt-visible');
        $(this).toggleClass('active');
    });

    // Save prompt on change
    $(document).on('input', '.scene-fold-prompt-textarea', function () {
        const sceneId = $(this).data('scene-id');
        const value = $(this).val().trim() || null;
        const ctx = SillyTavern.getContext();
        updateScene(ctx.chatMetadata, sceneId, { customPrompt: value });
        ctx.saveMetadataDebounced();
    });

    $(document).on('click', '.scene-fold-toggle-fold-btn', function () {
        const sceneId = $(this).data('scene-id');
        const ctx = SillyTavern.getContext();
        toggleFold(ctx, sceneId);
        ctx.saveMetadataDebounced();
        renderSceneList(ctx);
    });

    $(document).on('click', '.scene-fold-retry-btn', async function () {
        const sceneId = $(this).data('scene-id');
        console.log(`[Scene Fold] Retry button clicked for scene ${sceneId}`);
        const ctx = SillyTavern.getContext();
        await retrySummarization(ctx, sceneId);
    });

    // ─── Fold Toggle Click (in chat) ─────────────────────────────────────

    $(document).on('click', '.scene-fold-toggle', function () {
        const sceneId = $(this).data('scene-id');
        const ctx = SillyTavern.getContext();
        toggleFold(ctx, sceneId);
        ctx.saveMetadataDebounced();
        renderSceneList(ctx);
    });

    // ─── Message Action Button Handlers ────────────────────────────────

    // "Scene to here" — one-click scene creation from auto-start to this message
    $(document).on('click', '.scene-fold-scene-to-here', function () {
        const ctx = SillyTavern.getContext();
        const s = getSettings(ctx.extensionSettings);
        if (!s.enabled) return;

        const mesId = Number($(this).data('mesid'));
        if (isNaN(mesId)) return;

        const autoStart = getAutoStartIndex(ctx.chatMetadata, ctx.chat);
        console.log(`[Scene Fold] "Scene to here" clicked: autoStart=${autoStart}, end=${mesId}`);

        if (mesId < autoStart) {
            toastr.warning('This message is before the auto-start boundary.');
            return;
        }

        // Check for overlaps
        const overlaps = findOverlappingScenes(ctx.chatMetadata, ctx.chat, autoStart, mesId);
        if (overlaps.length > 0) {
            toastr.warning('Range overlaps with an existing scene. Use scene selection mode for manual control.');
            return;
        }

        const scene = createScene(ctx.chatMetadata, ctx.chat, autoStart, mesId, ctx.uuidv4);
        console.log(`[Scene Fold] Quick scene created: id=${scene.id}, range=${autoStart}-${mesId}`);

        ctx.saveChat();
        ctx.saveMetadataDebounced();

        applyAllFoldVisuals(ctx);
        injectMessageButtons(ctx);
        renderSceneList(ctx);

        toastr.success(`Scene created with ${scene.sourceMessageUUIDs.length} messages`);
    });

    // "Select scene..." — enter selection mode with this message as the end
    $(document).on('click', '.scene-fold-enter-selection', function () {
        const ctx = SillyTavern.getContext();
        const s = getSettings(ctx.extensionSettings);
        if (!s.enabled) {
            toastr.warning('Scene Fold is disabled. Enable it first.');
            return;
        }

        const mesId = Number($(this).data('mesid'));

        // If already in selection mode, exit first
        if (isSelectionModeActive()) {
            exitSelectionMode();
        }

        toggleSelectionMode(ctx, s);

        // Set clicked message as the end of selection
        if (!isNaN(mesId)) {
            handleMessageClick(mesId, false, ctx);
        }

        // Update the settings panel button to reflect active state
        $('#scene_fold_select_mode_btn').find('span').text('Exit Selection Mode');
        $('#scene_fold_select_mode_btn').addClass('active');
    });

    // ─── Register Events ─────────────────────────────────────────────────

    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);

    // Initial render if a chat is already loaded
    if (context.chat && context.chat.length > 0) {
        applyAllFoldVisuals(context);
        injectMessageButtons(context);
        renderSceneList(context);
    }

    // ─── Startup Diagnostics ────────────────────────────────────────────
    const criticalAPIs = ['generateRaw', 'generateQuietPrompt', 'saveChat', 'saveChatConditional', 'saveMetadataDebounced', 'reloadCurrentChat', 'uuidv4'];
    const apiStatus = criticalAPIs.map(name => `${name}: ${typeof context[name]}`).join(', ');
    console.log(`[Scene Fold] Context API check: ${apiStatus}`);
    if (typeof context.generateRaw !== 'function') {
        console.warn('[Scene Fold] WARNING: generateRaw not found on context — summarization will fail');
    }

    console.log('[Scene Fold] Extension loaded');
});
