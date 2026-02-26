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
    getSceneFoldData,
    ensureMessageUUID,
    reconcileScenesAfterDeletion,
    reconcileDuplicatedMessages,
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
    updateToolbar,
    toggleFold,
} from './scene-ui.js';

import { SummarizationQueue } from './summarization-queue.js';

import { SlashCommandParser } from '../../../../scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../../scripts/slash-commands/SlashCommandArgument.js';
import { addOneMessage, updateViewMessageIds, substituteParamsExtended } from '../../../../script.js';

const MODULE_NAME = 'scene_fold';
const EXTENSION_NAME = new URL(import.meta.url).pathname.split('/').slice(-2, -1)[0];

/** @type {SummarizationQueue} */
let queue;

/** Default extension settings */
const DEFAULT_GUIDANCE_PREFIX = 'Additional guidance for this scene:';

const DEFAULT_SETTINGS = {
    enabled: true,
    smartAutoStart: true,
    defaultPrompt: getDefaultSummarizationPrompt(),
    guidancePrefix: DEFAULT_GUIDANCE_PREFIX,
    maxRetries: 2,
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
    $('#scene_fold_guidance_prefix').val(settings.guidancePrefix ?? DEFAULT_GUIDANCE_PREFIX);
    $('#scene_fold_max_retries').val(settings.maxRetries ?? DEFAULT_SETTINGS.maxRetries);
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
        let statusLabel = scene.status.charAt(0).toUpperCase() + scene.status.slice(1);
        if (scene.status === 'completed' && scene.stale) {
            statusLabel += ' <span class="scene-fold-stale-indicator">(stale)</span>';
        }

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
                <button class="menu_button scene-fold-undo-btn" data-scene-id="${scene.id}" title="Undo summarization">
                    <i class="fa-solid fa-up-down"></i>
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
 * @param {AbortSignal} [signal] - Optional signal for cancellation
 */
async function summarizeScene(context, sceneId, signal = null) {
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

    if (!scene || (scene.status !== 'defined' && scene.status !== 'error' && scene.status !== 'queued')) {
        console.warn(`[Scene Fold] Cannot summarize scene ${sceneId}: status=${scene?.status}`);
        toastr.warning(`Scene Fold: cannot summarize — scene status is "${scene?.status ?? 'not found'}"`);
        return;
    }

    console.log(`[Scene Fold] Scene ${sceneId}: ${scene.sourceMessageUUIDs.length} source messages, status=${scene.status}`);
    updateScene(chatMetadata, sceneId, { status: 'summarizing', lastError: null });
    renderSceneList(context);

    try {
        // Check for cancellation before starting work
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

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

        // Compose the prompt from the template.
        // {{content}} = scene messages, {{additional_guidance}} = per-scene custom prompt,
        // {{user}}/{{char}}/etc. are handled by ST's substituteParamsExtended.
        const sceneText = sourceTexts.join('\n\n');
        const prefix = settings.guidancePrefix || DEFAULT_GUIDANCE_PREFIX;
        const additionalGuidance = scene.customPrompt
            ? `\n${prefix}\n${scene.customPrompt}\n`
            : '';

        const prompt = substituteParamsExtended(settings.defaultPrompt, {
            content: sceneText,
            additional_guidance: additionalGuidance,
        });

        console.log(`[Scene Fold] Calling generateRaw (prompt length: ${prompt.length})...`);

        // Call LLM with retries for transient failures (blank responses, timeouts).
        // Content-filter refusals and auth errors are not retried.
        const maxAttempts = 1 + (settings.maxRetries ?? DEFAULT_SETTINGS.maxRetries);
        let summary = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            let result;
            try {
                console.log(`[Scene Fold] generateRaw attempt ${attempt}/${maxAttempts}...`);
                result = await generateRaw({ prompt });
            } catch (genError) {
                if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

                // Classify the error: don't retry content filters, auth, or 4xx errors
                const errMsg = (genError.message || String(genError)).toLowerCase();
                const nonRetryable = /prohibit|content.?filter|refus|safety|moderat|blocked|policy|unauthorized|forbidden|400|401|403|429/.test(errMsg);

                if (nonRetryable || attempt >= maxAttempts) {
                    throw genError; // Propagate to outer catch
                }

                console.warn(`[Scene Fold] generateRaw threw on attempt ${attempt}, retrying: ${genError.message}`);
                toastr.info(`Generation error, retrying (${attempt}/${maxAttempts - 1})...`);
                continue;
            }

            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            console.log(`[Scene Fold] generateRaw returned: ${result === null ? 'null' : result === undefined ? 'undefined' : `string(${result.length})`}`);

            // Check for non-empty result
            if (result && result.trim().length > 0) {
                // Detect content-filter refusal text (short response with refusal language)
                const trimmed = result.trim();
                if (trimmed.length < 200 && /\b(i cannot|i can't|i'm unable|i am unable|not able to|content policy|violat|against my|guidelines)\b/i.test(trimmed)) {
                    throw new Error(`LLM refused to summarize (possible content filter): "${trimmed.slice(0, 120)}..."`);
                }
                summary = trimmed;
                break;
            }

            if (attempt < maxAttempts) {
                console.warn(`[Scene Fold] Blank response on attempt ${attempt}, retrying...`);
                toastr.info(`Summary was blank, retrying (${attempt}/${maxAttempts - 1})...`);
            }
        }

        if (!summary) {
            throw new Error(`LLM returned blank summary after ${maxAttempts} attempt${maxAttempts !== 1 ? 's' : ''}`);
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

        // Render the new summary message in the DOM without a full reload.
        // DOM still has old mesids, so insertBefore the element at firstSourceIdx
        // (the first source message, which hasn't shifted in the DOM yet).
        addOneMessage(summaryMessage, {
            insertBefore: firstSourceIdx,
            scroll: false,
            showSwipes: false,
        });
        updateViewMessageIds();

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

        // Persist and apply visuals
        await saveChat();
        saveMetadataDebounced();

        const freshContext = SillyTavern.getContext();
        applyAllFoldVisuals(freshContext);
        renderSceneList(freshContext);

        console.log(`[Scene Fold] Scene ${sceneId} summarization complete`);
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log(`[Scene Fold] Summarization cancelled for scene ${sceneId}`);
            updateScene(chatMetadata, sceneId, { status: 'defined', lastError: null });
            saveMetadataDebounced();
            renderSceneList(context);
            toastr.info('Scene summarization cancelled');
            throw error; // Re-throw so the queue knows it was cancelled
        }
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
 * Prepare a scene for retry: remove existing summary, un-hide sources, reset state.
 * @param {object} context
 * @param {string} sceneId
 */
async function prepareForRetry(context, sceneId) {
    console.log(`[Scene Fold] prepareForRetry called for scene ${sceneId}`);
    const { chat, chatMetadata, saveChat, saveMetadataDebounced } = context;
    const scene = getScene(chatMetadata, sceneId);
    if (!scene) {
        console.warn(`[Scene Fold] prepareForRetry: scene ${sceneId} not found`);
        return;
    }

    // Remove existing summary message if present
    if (scene.summaryMessageUUID) {
        const summaryIdx = findMessageIndexByUUID(chat, scene.summaryMessageUUID);
        if (summaryIdx !== -1) {
            // Remove from DOM first, then from chat array
            $(`.mes[mesid="${summaryIdx}"]`).remove();
            chat.splice(summaryIdx, 1);
            updateViewMessageIds();
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
        stale: false,
    });

    await saveChat();
    saveMetadataDebounced();
    applyAllFoldVisuals(SillyTavern.getContext());
}

// ─── Memory Extension Conflict Detection ─────────────────────────────────────

/**
 * Check if ST's built-in Summarize (memory) extension is active and warn.
 * @param {object} context
 */
function checkMemoryExtensionConflict(context) {
    const { extensionSettings } = context;

    const isDisabled = extensionSettings.disabledExtensions?.includes('memory');
    const hasMemorySettings = extensionSettings.memory
        && Object.keys(extensionSettings.memory).length > 0;

    if (!isDisabled && hasMemorySettings) {
        // Inject warning into settings panel if not already present
        const warningId = 'scene_fold_memory_warning';
        if (!$(`#${warningId}`).length) {
            const warningHtml = `
                <div id="${warningId}" class="scene-fold-memory-warning">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <span>The built-in <b>Summarize</b> extension is also active.
                    Both extensions modify message visibility, which may cause conflicts.
                    Consider disabling one.</span>
                </div>
            `;
            $('.scene-fold-settings .inline-drawer-content').prepend(warningHtml);
        }

        // One-time toast per session
        const toastKey = 'scene_fold_memory_warning_shown';
        if (!sessionStorage.getItem(toastKey)) {
            toastr.warning(
                'The built-in Summarize extension is active alongside Scene Fold. They may conflict.',
                'Scene Fold Warning',
                { timeOut: 8000 },
            );
            sessionStorage.setItem(toastKey, 'true');
        }
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

/**
 * Handle CHAT_CHANGED: restore fold visuals from metadata.
 */
function onChatChanged() {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);
    if (!settings.enabled) return;

    // Cancel any in-progress queue work (switched chats)
    if (queue?.isProcessing) {
        queue.cancelAll();
    }

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
    updateToolbar(context, queue);
    checkMemoryExtensionConflict(context);
}

/**
 * Handle MESSAGE_DELETED: reconcile scene data with current chat state.
 * The event fires AFTER the message is removed from chat[].
 */
async function onMessageDeleted() {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);
    if (!settings.enabled) return;

    const { chat, chatMetadata } = context;
    const result = reconcileScenesAfterDeletion(chatMetadata, chat);

    if (result.deletedScenes.length === 0 && result.modifiedScenes.length === 0 && result.summaryLost.length === 0) {
        return;
    }

    if (result.deletedScenes.length > 0) {
        console.log(`[Scene Fold] Deleted ${result.deletedScenes.length} scene(s) with no remaining source messages`);
    }
    if (result.summaryLost.length > 0) {
        console.log(`[Scene Fold] Reset ${result.summaryLost.length} scene(s) whose summary was deleted`);
        toastr.info(`${result.summaryLost.length} scene summary(ies) deleted — scene(s) reset to defined`);
    }
    if (result.modifiedScenes.length > 0) {
        console.log(`[Scene Fold] Updated ${result.modifiedScenes.length} scene(s) after message deletion`);
    }

    context.saveMetadataDebounced();
    applyAllFoldVisuals(context);
    injectMessageButtons(context);
    renderSceneList(context);
    updateToolbar(context, queue);
}

/**
 * Handle MESSAGE_SWIPED: if the swiped message belongs to a completed scene,
 * mark that scene as stale (summary may not reflect current content).
 * @param {number} mesId - The index of the swiped message
 */
function onMessageSwiped(mesId) {
    const context = SillyTavern.getContext();
    const settings = getSettings(context.extensionSettings);
    if (!settings.enabled) return;

    const { chat, chatMetadata } = context;
    const msg = chat[mesId];
    if (!msg?.extra?.scene_fold_scenes) return;

    const data = getSceneFoldData(chatMetadata);
    let anyStale = false;

    for (const sceneId of msg.extra.scene_fold_scenes) {
        const scene = data.scenes[sceneId];
        if (scene && scene.status === 'completed' && !scene.stale) {
            scene.stale = true;
            anyStale = true;
            console.log(`[Scene Fold] Scene ${sceneId} marked stale due to swipe on message ${mesId}`);
        }
    }

    if (anyStale) {
        context.saveMetadataDebounced();
        applyAllFoldVisuals(context);
        renderSceneList(context);
    }
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

// ─── Slash Commands ──────────────────────────────────────────────────────────

/**
 * Resolve a slash command argument to a scene ID.
 * Accepts a message index (number) or falls back to UUID lookup.
 * @param {object} chatMetadata
 * @param {Array} chat
 * @param {string} arg - The argument string (message index or scene UUID)
 * @returns {string|null} The scene ID, or null if not found
 */
function resolveSceneArg(chatMetadata, chat, arg) {
    // Try as a message index first
    const idx = Number(arg);
    if (!isNaN(idx) && idx >= 0 && idx < chat.length) {
        const msg = chat[idx];
        const sceneIds = msg?.extra?.scene_fold_scenes;
        if (sceneIds && sceneIds.length > 0) {
            return sceneIds[0]; // Return the first scene this message belongs to
        }
    }

    // Fall back to direct scene UUID lookup
    const scene = getScene(chatMetadata, arg);
    if (scene) return arg;

    return null;
}

/**
 * /scene-create start=N end=N [prompt=...]
 */
async function slashSceneCreate(namedArgs) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings(ctx.extensionSettings);
    if (!settings.enabled) return 'Scene Fold is disabled';

    let start, end;

    if (namedArgs.start !== undefined && namedArgs.end !== undefined) {
        start = Number(namedArgs.start);
        end = Number(namedArgs.end);
        if (isNaN(start) || isNaN(end) || start < 0 || end < 0) {
            toastr.error('Invalid start/end indices');
            return 'Error: invalid indices';
        }
        if (start > end) [start, end] = [end, start];
        if (end >= ctx.chat.length) {
            toastr.error(`End index ${end} exceeds chat length ${ctx.chat.length}`);
            return 'Error: end index out of range';
        }
    } else if (isSelectionModeActive()) {
        const range = getSelectionRange();
        if (range.start === null || range.end === null) {
            toastr.warning('No messages selected');
            return 'Error: no selection';
        }
        start = range.start;
        end = range.end;
    } else {
        toastr.warning('Provide start= and end= arguments, or enter selection mode first');
        return 'Error: no range specified';
    }

    const overlaps = findOverlappingScenes(ctx.chatMetadata, ctx.chat, start, end);
    if (overlaps.length > 0) {
        toastr.warning('Range overlaps with an existing scene');
        return 'Error: overlap';
    }

    const customPrompt = namedArgs.prompt?.trim() || null;
    const scene = createScene(ctx.chatMetadata, ctx.chat, start, end, ctx.uuidv4, customPrompt);

    ctx.saveChat();
    ctx.saveMetadataDebounced();

    if (isSelectionModeActive()) exitSelectionMode();

    applyAllFoldVisuals(ctx);
    injectMessageButtons(ctx);
    renderSceneList(ctx);
    updateToolbar(ctx, queue);

    toastr.success(`Scene created with ${scene.sourceMessageUUIDs.length} messages`);
    return scene.id;
}

/**
 * /scene-summarize [messageIndex|all]
 */
async function slashSceneSummarize(_namedArgs, unnamedArgs) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings(ctx.extensionSettings);
    if (!settings.enabled) return 'Scene Fold is disabled';

    const arg = (typeof unnamedArgs === 'string' ? unnamedArgs : '').trim() || 'all';

    if (arg === 'all') {
        const scenes = getScenesInOrder(ctx.chatMetadata, ctx.chat);
        const pending = scenes.filter(s => s.status === 'defined' || s.status === 'error');
        if (pending.length === 0) {
            toastr.info('No pending scenes to summarize');
            return '0';
        }
        queue.addAll(pending.map(s => s.id));
        return String(pending.length);
    } else {
        const sceneId = resolveSceneArg(ctx.chatMetadata, ctx.chat, arg);
        if (!sceneId) {
            toastr.error(`No scene found at message ${arg}`);
            return 'Error: scene not found';
        }
        queue.add(sceneId);
        return sceneId;
    }
}

/**
 * /scene-expand [messageIndex|all]
 */
async function slashSceneExpand(_namedArgs, unnamedArgs) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings(ctx.extensionSettings);
    if (!settings.enabled) return 'Scene Fold is disabled';

    const arg = (typeof unnamedArgs === 'string' ? unnamedArgs : '').trim() || 'all';
    const data = getSceneFoldData(ctx.chatMetadata);
    let count = 0;

    if (arg === 'all') {
        for (const scene of Object.values(data.scenes)) {
            if (scene.status === 'completed' && scene.folded) {
                scene.folded = false;
                count++;
            }
        }
    } else {
        const sceneId = resolveSceneArg(ctx.chatMetadata, ctx.chat, arg);
        if (!sceneId) {
            toastr.error(`No scene found at message ${arg}`);
            return 'Error: scene not found';
        }
        const scene = data.scenes[sceneId];
        if (scene?.status === 'completed' && scene.folded) {
            scene.folded = false;
            count = 1;
        }
    }

    if (count > 0) {
        ctx.saveMetadataDebounced();
        applyAllFoldVisuals(ctx);
        renderSceneList(ctx);
    }

    return String(count);
}

/**
 * /scene-collapse [messageIndex|all]
 */
async function slashSceneCollapse(_namedArgs, unnamedArgs) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings(ctx.extensionSettings);
    if (!settings.enabled) return 'Scene Fold is disabled';

    const arg = (typeof unnamedArgs === 'string' ? unnamedArgs : '').trim() || 'all';
    const data = getSceneFoldData(ctx.chatMetadata);
    let count = 0;

    if (arg === 'all') {
        for (const scene of Object.values(data.scenes)) {
            if (scene.status === 'completed' && !scene.folded) {
                scene.folded = true;
                count++;
            }
        }
    } else {
        const sceneId = resolveSceneArg(ctx.chatMetadata, ctx.chat, arg);
        if (!sceneId) {
            toastr.error(`No scene found at message ${arg}`);
            return 'Error: scene not found';
        }
        const scene = data.scenes[sceneId];
        if (scene?.status === 'completed' && !scene.folded) {
            scene.folded = true;
            count = 1;
        }
    }

    if (count > 0) {
        ctx.saveMetadataDebounced();
        applyAllFoldVisuals(ctx);
        renderSceneList(ctx);
    }

    return String(count);
}

/**
 * /scene-next — scroll to the first unsummarized message (the auto-start index).
 */
function slashSceneNext() {
    const ctx = SillyTavern.getContext();
    const settings = getSettings(ctx.extensionSettings);
    if (!settings.enabled) return 'Scene Fold is disabled';

    const autoStart = getAutoStartIndex(ctx.chatMetadata, ctx.chat);
    if (autoStart >= ctx.chat.length) {
        toastr.info('No unsummarized messages');
        return '';
    }

    const el = document.querySelector(`#chat .mes[mesid="${autoStart}"]`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
        toastr.info(`Message ${autoStart} is not loaded in the current view`);
    }
    return String(autoStart);
}

/**
 * /scene-convert-rememory — detect ReMemory scenes and convert to Scene Fold.
 */
async function slashConvertRememory() {
    const ctx = SillyTavern.getContext();
    const settings = getSettings(ctx.extensionSettings);
    if (!settings.enabled) return 'Scene Fold is disabled';

    const { chat, chatMetadata, uuidv4, saveChat, saveMetadataDebounced, reloadCurrentChat } = ctx;

    if (!chat || chat.length === 0) {
        toastr.warning('No chat loaded');
        return '0';
    }

    // Step 1: Detect ReMemory summary messages.
    // In MESSAGE mode, ReMemory increments mes_id, inserts a /comment at that index,
    // then sets rmr_scene=true on chat[mes_id] — the summary message itself.
    // So rmr_scene marks the SUMMARY, not the last source message.
    let summaryIndices = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.rmr_scene === true) {
            summaryIndices.push(i);
        }
    }

    // Fallback: if no rmr_scene markers, look for /comment messages (extra.type === "comment")
    // or messages named "Note" that aren't from the user
    if (summaryIndices.length === 0) {
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (msg?.is_user) continue;
            if (msg?.extra?.type === 'comment' || msg?.name === 'Note') {
                summaryIndices.push(i);
            }
        }
    }

    if (summaryIndices.length === 0) {
        toastr.info('No ReMemory scenes detected in this chat');
        return '0';
    }

    // Step 2: Build scene ranges.
    // Each summary's sources are all messages between the previous summary and this one.
    // Layout: [source...] [summary] [source...] [summary] [trailing...]
    const scenesToConvert = [];
    let prevSummaryIdx = -1;

    for (const summaryIdx of summaryIndices) {
        const startIdx = prevSummaryIdx + 1;
        const sourceEnd = summaryIdx - 1;
        prevSummaryIdx = summaryIdx;

        if (sourceEnd < startIdx) {
            console.warn(`[Scene Fold] Skipping empty scene at summary index ${summaryIdx}`);
            continue;
        }

        // Skip if already converted to Scene Fold
        let alreadyConverted = false;
        for (let i = startIdx; i <= sourceEnd; i++) {
            if (chat[i]?.extra?.scene_fold_scenes?.length > 0) {
                alreadyConverted = true;
                break;
            }
        }
        if (alreadyConverted) {
            console.log(`[Scene Fold] Skipping already-converted range ${startIdx}-${sourceEnd}`);
            continue;
        }

        scenesToConvert.push({ startIdx, endIdx: sourceEnd, summaryIdx });
    }

    if (scenesToConvert.length === 0) {
        toastr.info('All ReMemory scenes are already converted or no valid scenes found');
        return '0';
    }

    console.log(`[Scene Fold] Converting ${scenesToConvert.length} ReMemory scene(s):`,
        scenesToConvert.map(s => `sources ${s.startIdx}-${s.endIdx}, summary ${s.summaryIdx}`));

    // Step 3: Reorder and convert each scene.
    // Scene Fold expects: [summary] [source1] ... [sourceN]
    // ReMemory has:       [source1] ... [sourceN] [summary]
    // Process in reverse order so earlier indices aren't affected by later splices.
    let converted = 0;
    for (let si = scenesToConvert.length - 1; si >= 0; si--) {
        const { startIdx, endIdx, summaryIdx } = scenesToConvert[si];

        // Move summary from after sources to before them
        const [summaryMsg] = chat.splice(summaryIdx, 1);
        chat.splice(startIdx, 0, summaryMsg);
        // Now: chat[startIdx] = summary, sources at startIdx+1 through endIdx+1
        // (net effect on array length is zero: one remove + one insert)

        const summaryUUID = ensureMessageUUID(summaryMsg, uuidv4);

        // Tag summary message with Scene Fold metadata
        if (!summaryMsg.extra) summaryMsg.extra = {};
        summaryMsg.extra.scene_fold_role = 'summary';
        summaryMsg.is_system = false; // Summary must be included in prompts

        // Create the scene from the source range (shifted +1 by summary insertion)
        const sourceStart = startIdx + 1;
        const sourceEnd = endIdx + 1;
        const scene = createScene(chatMetadata, chat, sourceStart, sourceEnd, uuidv4);

        // Link summary to the scene
        summaryMsg.extra.scene_fold_scene_id = scene.id;

        // Mark source messages as hidden from prompts
        for (let i = sourceStart; i <= sourceEnd; i++) {
            chat[i].is_system = true;
        }

        // Update scene to completed + folded
        updateScene(chatMetadata, scene.id, {
            status: 'completed',
            folded: true,
            summaryMessageUUID: summaryUUID,
        });

        converted++;
    }

    // Step 4: Save and reload
    await saveChat();
    saveMetadataDebounced();
    await reloadCurrentChat();

    const freshCtx = SillyTavern.getContext();
    applyAllFoldVisuals(freshCtx);
    renderSceneList(freshCtx);
    updateToolbar(freshCtx, queue);

    toastr.success(`Converted ${converted} ReMemory scene(s) to Scene Fold`);
    return String(converted);
}

/**
 * Register Scene Fold slash commands with SillyTavern.
 */
function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-create',
        callback: slashSceneCreate,
        helpString: 'Create a scene from a range of messages. Uses current selection if no args provided.',
        namedArgumentList: [
            new SlashCommandNamedArgument('start', 'Start message index (inclusive)', ARGUMENT_TYPE.NUMBER, false),
            new SlashCommandNamedArgument('end', 'End message index (inclusive)', ARGUMENT_TYPE.NUMBER, false),
            new SlashCommandNamedArgument('prompt', 'Custom summarization prompt for this scene', ARGUMENT_TYPE.STRING, false),
        ],
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-summarize',
        callback: slashSceneSummarize,
        helpString: 'Summarize a scene containing the given message index, or "all" to summarize all pending scenes.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message index within the scene, or "all"',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'all',
            }),
        ],
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-expand',
        callback: slashSceneExpand,
        helpString: 'Expand (unfold) the scene containing the given message index, or "all" to expand all folded scenes.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message index within the scene, or "all"',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'all',
            }),
        ],
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-collapse',
        callback: slashSceneCollapse,
        helpString: 'Collapse (fold) the scene containing the given message index, or "all" to collapse all completed scenes.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message index within the scene, or "all"',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'all',
            }),
        ],
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-convert-rememory',
        callback: slashConvertRememory,
        helpString: 'Convert ReMemory extension scenes in the current chat to Scene Fold scenes.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-next',
        callback: slashSceneNext,
        helpString: 'Scroll to the first unsummarized message (where the next scene would start).',
        returns: ARGUMENT_TYPE.STRING,
    }));
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

    // ─── Initialize Summarization Queue ──────────────────────────────────

    queue = new SummarizationQueue({
        async worker(sceneId, signal) {
            const ctx = SillyTavern.getContext();
            const scene = getScene(ctx.chatMetadata, sceneId);

            // If tagged for retry, clean up first
            if (scene?._needsRetry) {
                delete scene._needsRetry;
                await prepareForRetry(ctx, sceneId);
                await summarizeScene(SillyTavern.getContext(), sceneId, signal);
            } else {
                await summarizeScene(ctx, sceneId, signal);
            }
        },
        onUpdate() {
            const ctx = SillyTavern.getContext();
            applyAllFoldVisuals(ctx);
            renderSceneList(ctx);
            updateToolbar(ctx, queue);
        },
    });

    // ─── Register Slash Commands ─────────────────────────────────────────
    registerSlashCommands();

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

    $('#scene_fold_guidance_prefix').on('input', function () {
        settings.guidancePrefix = $(this).val();
        context.saveSettingsDebounced();
    });

    $('#scene_fold_max_retries').on('input', function () {
        const val = parseInt($(this).val(), 10);
        settings.maxRetries = isNaN(val) ? DEFAULT_SETTINGS.maxRetries : Math.max(0, Math.min(val, 10));
        $(this).val(settings.maxRetries);
        context.saveSettingsDebounced();
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

        // Refresh UI
        applyAllFoldVisuals(ctx);
        renderSceneList(ctx);
        updateToolbar(ctx, queue);

        toastr.success(`Scene created with ${scene.sourceMessageUUIDs.length} messages`);
    });

    $(document).on('click', '#scene-fold-cancel-btn', function () {
        exitSelectionMode();
        updateToolbar(SillyTavern.getContext(), queue);
    });

    // ─── Scene List Action Handlers ──────────────────────────────────────

    $(document).on('click', '.scene-fold-summarize-btn', function () {
        const sceneId = $(this).data('scene-id');
        console.log(`[Scene Fold] Summarize button clicked for scene ${sceneId}`);
        queue.add(sceneId);
    });

    $(document).on('click', '.scene-fold-delete-btn', async function () {
        const sceneId = $(this).data('scene-id');
        console.log(`[Scene Fold] Delete button clicked for scene ${sceneId}`);

        // Cancel if queued or active
        queue.cancel(sceneId);

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

    // ─── Cancel Handlers ──────────────────────────────────────────────────

    $(document).on('click', '.scene-fold-cancel-btn', function () {
        const sceneId = $(this).data('scene-id');
        console.log(`[Scene Fold] Cancel button clicked for scene ${sceneId}`);
        queue.cancel(sceneId);
    });

    $(document).on('click', '.scene-fold-cancel-all', function () {
        console.log('[Scene Fold] Cancel All clicked');
        queue.cancelAll();
    });

    // Toolbar: Summarize All
    $(document).on('click', '.scene-fold-toolbar-summarize-all', function () {
        const ctx = SillyTavern.getContext();
        const scenes = getScenesInOrder(ctx.chatMetadata, ctx.chat);
        const pendingScenes = scenes.filter(s => s.status === 'defined' || s.status === 'error');
        if (pendingScenes.length === 0) return;
        queue.addAll(pendingScenes.map(s => s.id));
    });

    // Toolbar: Select Scene Mode
    $(document).on('click', '.scene-fold-toolbar-select-mode', function () {
        const ctx = SillyTavern.getContext();
        const s = getSettings(ctx.extensionSettings);
        if (!s.enabled) {
            toastr.warning('Scene Fold is disabled. Enable it first.');
            return;
        }
        toggleSelectionMode(ctx, s);
        updateToolbar(ctx, queue);
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

    $(document).on('click', '.scene-fold-retry-btn', function () {
        const sceneId = $(this).data('scene-id');
        console.log(`[Scene Fold] Retry button clicked for scene ${sceneId}`);
        const ctx = SillyTavern.getContext();
        const scene = getScene(ctx.chatMetadata, sceneId);
        if (!scene) return;

        // Tag for retry so the worker knows to clean up first
        scene._needsRetry = true;
        queue.add(sceneId);
    });

    $(document).on('click', '.scene-fold-undo-btn', async function () {
        const sceneId = $(this).data('scene-id');
        console.log(`[Scene Fold] Undo button clicked for scene ${sceneId}`);
        const ctx = SillyTavern.getContext();
        await prepareForRetry(ctx, sceneId);
        const freshCtx = SillyTavern.getContext();
        applyAllFoldVisuals(freshCtx);
        renderSceneList(freshCtx);
        updateToolbar(freshCtx, queue);
        toastr.info('Scene unfolded — original messages restored');
    });

    // ─── Fold Toggle Click (in chat) ─────────────────────────────────────

    $(document).on('click', '.scene-fold-inline-actions-row', function (event) {
        // Don't toggle when clicking buttons, inputs, or textareas within the row
        if ($(event.target).closest('button, input, textarea, .scene-fold-inline-buttons').length) return;

        const sceneId = $(this).closest('[data-scene-id]').data('scene-id');
        const ctx = SillyTavern.getContext();
        toggleFold(ctx, sceneId);
        ctx.saveMetadataDebounced();
        renderSceneList(ctx);
    });

    $(document).on('click', '.scene-fold-collapse-tail', function () {
        const sceneId = $(this).data('scene-id');
        const ctx = SillyTavern.getContext();
        const scene = getScene(ctx.chatMetadata, sceneId);
        toggleFold(ctx, sceneId);
        ctx.saveMetadataDebounced();
        renderSceneList(ctx);

        // Scroll to the summary message so it's visible after collapse
        if (scene?.summaryMessageUUID) {
            const summaryIdx = findMessageIndexByUUID(ctx.chat, scene.summaryMessageUUID);
            if (summaryIdx !== -1) {
                const summaryEl = document.querySelector(`.mes[mesid="${summaryIdx}"]`);
                if (summaryEl) {
                    summaryEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        }
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
        updateToolbar(ctx, queue);

        toastr.success(`Scene created with ${scene.sourceMessageUUIDs.length} messages`);
    });

    // "Select scene..." — enter selection mode with this message as the start
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

        // Set clicked message as the start of selection
        if (!isNaN(mesId)) {
            handleMessageClick(mesId, false, ctx);
        }

        updateToolbar(ctx, queue);
    });

    // ─── Keyboard Shortcut Events (from scene-ui.js) ──────────────────

    document.addEventListener('scene-fold-selection-exited', () => {
        updateToolbar(SillyTavern.getContext(), queue);
    });

    document.addEventListener('scene-fold-selection-confirmed', () => {
        $('#scene-fold-create-btn').trigger('click');
    });

    // ─── Register Events ─────────────────────────────────────────────────

    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(eventTypes.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(eventTypes.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, () => {
        const ctx = SillyTavern.getContext();
        const s = getSettings(ctx.extensionSettings);
        if (!s.enabled) return;

        // Remember the earliest summary before new batch gets visuals applied
        const prevFirstSummary = document.querySelector('#chat .mes.scene-fold-summary');
        const anchorMesId = prevFirstSummary?.getAttribute('mesid');

        applyAllFoldVisuals(ctx);
        updateToolbar(ctx, queue);

        // Scroll back to the summary that was previously at the top
        if (anchorMesId !== null) {
            const anchor = document.querySelector(`#chat .mes[mesid="${anchorMesId}"]`);
            if (anchor) {
                anchor.scrollIntoView({ block: 'start' });
            }
        }
    });

    // ─── MutationObserver for Message Duplication ────────────────────────
    // ST's message duplication (structuredClone + splice + DOM insert) does
    // NOT fire MESSAGE_RENDERED events, so we watch for new .mes elements
    // added to #chat and reconcile duplicate UUIDs when detected.

    const chatEl = document.getElementById('chat');
    if (chatEl) {
        const duplicationObserver = new MutationObserver((mutations) => {
            const ctx = SillyTavern.getContext();
            const s = getSettings(ctx.extensionSettings);
            if (!s.enabled || !ctx.chat?.length) return;

            // Quick filter: only proceed if any added .mes element corresponds
            // to a chat message that has a scene_fold_uuid (i.e. was part of a
            // scene). This is O(k) where k = added elements (usually 1), so it
            // cheaply skips the vast majority of DOM additions.
            let hasSceneMessage = false;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE || !node.classList?.contains('mes')) continue;
                    const mesid = Number(node.getAttribute('mesid'));
                    if (!isNaN(mesid) && ctx.chat[mesid]?.extra?.scene_fold_uuid) {
                        hasSceneMessage = true;
                        break;
                    }
                }
                if (hasSceneMessage) break;
            }
            if (!hasSceneMessage) return;

            const fixed = reconcileDuplicatedMessages(ctx.chatMetadata, ctx.chat, ctx.uuidv4);
            if (fixed > 0) {
                console.log(`[Scene Fold] Detected and fixed ${fixed} duplicated message(s)`);
                ctx.saveChat();
                ctx.saveMetadataDebounced();
                applyAllFoldVisuals(ctx);
                renderSceneList(ctx);
                updateToolbar(ctx, queue);
            }
        });
        duplicationObserver.observe(chatEl, { childList: true });

        // Watch for is_system attribute changes (user toggling message visibility)
        // to update the "visible" badge on scene fold controls.
        let visibilityUpdatePending = false;
        const visibilityObserver = new MutationObserver((mutations) => {
            if (visibilityUpdatePending) return;
            for (const mutation of mutations) {
                if (mutation.attributeName === 'is_system') {
                    visibilityUpdatePending = true;
                    requestAnimationFrame(() => {
                        visibilityUpdatePending = false;
                        const ctx = SillyTavern.getContext();
                        const s = getSettings(ctx.extensionSettings);
                        if (!s.enabled) return;
                        applyAllFoldVisuals(ctx);
                    });
                    return;
                }
            }
        });
        visibilityObserver.observe(chatEl, { subtree: true, attributes: true, attributeFilter: ['is_system'] });
    }

    // Initial render if a chat is already loaded
    if (context.chat && context.chat.length > 0) {
        applyAllFoldVisuals(context);
        injectMessageButtons(context);
        renderSceneList(context);
        updateToolbar(context, queue);
    }

    checkMemoryExtensionConflict(context);

    // ─── Startup Diagnostics ────────────────────────────────────────────
    const criticalAPIs = ['generateRaw', 'generateQuietPrompt', 'saveChat', 'saveChatConditional', 'saveMetadataDebounced', 'reloadCurrentChat', 'uuidv4'];
    const apiStatus = criticalAPIs.map(name => `${name}: ${typeof context[name]}`).join(', ');
    console.log(`[Scene Fold] Context API check: ${apiStatus}`);
    if (typeof context.generateRaw !== 'function') {
        console.warn('[Scene Fold] WARNING: generateRaw not found on context — summarization will fail');
    }

    console.log('[Scene Fold] Extension loaded');
});
