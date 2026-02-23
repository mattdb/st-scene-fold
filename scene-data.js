/**
 * Scene Fold - Data Model
 *
 * Manages scene definitions, UUID assignment, and metadata persistence.
 * All scene data is stored in chat_metadata.scene_fold and individual
 * message extra fields for stability across index shifts.
 */

const MODULE_NAME = 'scene_fold';

/**
 * Ensure a message has a stable UUID in its extra field.
 * @param {object} message - Chat message object
 * @returns {string} The UUID
 */
export function ensureMessageUUID(message, uuidv4Fn) {
    if (!message.extra) {
        message.extra = {};
    }
    if (!message.extra.scene_fold_uuid) {
        message.extra.scene_fold_uuid = uuidv4Fn();
    }
    return message.extra.scene_fold_uuid;
}

/**
 * Build a map of UUID -> chat array index for fast lookups.
 * @param {Array} chat - The chat array
 * @returns {Map<string, number>}
 */
export function buildUUIDIndex(chat) {
    const index = new Map();
    for (let i = 0; i < chat.length; i++) {
        const uuid = chat[i]?.extra?.scene_fold_uuid;
        if (uuid) {
            index.set(uuid, i);
        }
    }
    return index;
}

/**
 * Find a message's current index by its UUID.
 * @param {Array} chat - The chat array
 * @param {string} uuid - The message UUID
 * @param {Map<string, number>} [uuidIndex] - Optional cached index
 * @returns {number} The message index, or -1 if not found
 */
export function findMessageIndexByUUID(chat, uuid, uuidIndex) {
    if (uuidIndex && uuidIndex.has(uuid)) {
        const idx = uuidIndex.get(uuid);
        // Verify the index is still valid
        if (chat[idx]?.extra?.scene_fold_uuid === uuid) {
            return idx;
        }
    }
    // Fallback: linear scan
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.scene_fold_uuid === uuid) {
            return i;
        }
    }
    return -1;
}

/**
 * Get or initialize the scene_fold metadata object on chat_metadata.
 * @param {object} chatMetadata - The chat_metadata object
 * @returns {SceneFoldMetadata}
 */
export function getSceneFoldData(chatMetadata) {
    if (!chatMetadata.scene_fold) {
        chatMetadata.scene_fold = {
            scenes: {},
            settings: {
                defaultPrompt: getDefaultSummarizationPrompt(),
            },
        };
    }
    return chatMetadata.scene_fold;
}

/**
 * @returns {string} The default summarization prompt
 */
export function getDefaultSummarizationPrompt() {
    return [
        'Summarize the following scene from a roleplay conversation.',
        'Preserve key plot points, character actions, emotional beats, and any important details.',
        'Write the summary in present tense, third person, as a concise narrative paragraph.',
        'Do not add commentary or analysis - only summarize what happened.',
    ].join(' ');
}

/**
 * Create a new scene from a contiguous range of messages.
 * @param {object} chatMetadata - The chat_metadata object
 * @param {Array} chat - The chat array
 * @param {number} startIndex - First message index (inclusive)
 * @param {number} endIndex - Last message index (inclusive)
 * @param {Function} uuidv4Fn - UUID generator function
 * @param {string} [customPrompt] - Optional per-scene prompt
 * @returns {object} The created scene object
 */
export function createScene(chatMetadata, chat, startIndex, endIndex, uuidv4Fn, customPrompt = null) {
    const data = getSceneFoldData(chatMetadata);
    const sceneId = uuidv4Fn();

    // Ensure all messages in range have UUIDs
    const sourceMessageUUIDs = [];
    for (let i = startIndex; i <= endIndex; i++) {
        if (!chat[i]) continue;
        const uuid = ensureMessageUUID(chat[i], uuidv4Fn);
        sourceMessageUUIDs.push(uuid);

        // Tag the message with its scene membership
        if (!chat[i].extra.scene_fold_scenes) {
            chat[i].extra.scene_fold_scenes = [];
        }
        if (!chat[i].extra.scene_fold_scenes.includes(sceneId)) {
            chat[i].extra.scene_fold_scenes.push(sceneId);
        }
        chat[i].extra.scene_fold_role = 'source';
    }

    const scene = {
        id: sceneId,
        summaryMessageUUID: null,
        sourceMessageUUIDs,
        parentSceneId: null,
        status: 'defined', // defined | queued | summarizing | completed | error
        customPrompt: customPrompt || null,
        folded: false,
        lastError: null,
        createdAt: Date.now(),
    };

    data.scenes[sceneId] = scene;
    return scene;
}

/**
 * Delete a scene definition. Does NOT modify messages (caller should handle unhiding).
 * @param {object} chatMetadata
 * @param {Array} chat
 * @param {string} sceneId
 */
export function deleteScene(chatMetadata, chat, sceneId) {
    const data = getSceneFoldData(chatMetadata);
    const scene = data.scenes[sceneId];
    if (!scene) return;

    // Remove scene tags from source messages
    for (const uuid of scene.sourceMessageUUIDs) {
        const idx = findMessageIndexByUUID(chat, uuid);
        if (idx === -1) continue;
        const msg = chat[idx];
        if (msg.extra?.scene_fold_scenes) {
            msg.extra.scene_fold_scenes = msg.extra.scene_fold_scenes.filter(id => id !== sceneId);
            if (msg.extra.scene_fold_scenes.length === 0) {
                delete msg.extra.scene_fold_scenes;
                delete msg.extra.scene_fold_role;
            }
        }
    }

    delete data.scenes[sceneId];
}

/**
 * Get all scenes, sorted by the position of their first source message.
 * @param {object} chatMetadata
 * @param {Array} chat
 * @returns {Array<object>} Sorted scene objects
 */
export function getScenesInOrder(chatMetadata, chat) {
    const data = getSceneFoldData(chatMetadata);
    const scenes = Object.values(data.scenes);

    // Sort by position of first source message in chat
    scenes.sort((a, b) => {
        const aIdx = findMessageIndexByUUID(chat, a.sourceMessageUUIDs[0]);
        const bIdx = findMessageIndexByUUID(chat, b.sourceMessageUUIDs[0]);
        return aIdx - bIdx;
    });

    return scenes;
}

/**
 * Find the index of the message immediately after the last completed scene's summary.
 * Used for smart auto-start.
 * @param {object} chatMetadata
 * @param {Array} chat
 * @returns {number} The auto-start index, or 0 if no completed scenes
 */
export function getAutoStartIndex(chatMetadata, chat) {
    const data = getSceneFoldData(chatMetadata);
    const allScenes = Object.values(data.scenes);

    if (allScenes.length === 0) return 0;

    // Find the last message belonging to ANY scene (not just completed ones)
    let maxIndex = -1;
    for (const scene of allScenes) {
        for (const uuid of scene.sourceMessageUUIDs) {
            const idx = findMessageIndexByUUID(chat, uuid);
            if (idx > maxIndex) maxIndex = idx;
        }
        if (scene.summaryMessageUUID) {
            const idx = findMessageIndexByUUID(chat, scene.summaryMessageUUID);
            if (idx > maxIndex) maxIndex = idx;
        }
    }

    // Auto-start at the message after the last scene message
    return maxIndex >= 0 ? maxIndex + 1 : 0;
}

/**
 * Get a scene by its ID.
 * @param {object} chatMetadata
 * @param {string} sceneId
 * @returns {object|null}
 */
export function getScene(chatMetadata, sceneId) {
    const data = getSceneFoldData(chatMetadata);
    return data.scenes[sceneId] || null;
}

/**
 * Update a scene's properties.
 * @param {object} chatMetadata
 * @param {string} sceneId
 * @param {object} updates - Partial scene object to merge
 */
export function updateScene(chatMetadata, sceneId, updates) {
    const data = getSceneFoldData(chatMetadata);
    const scene = data.scenes[sceneId];
    if (!scene) return;
    Object.assign(scene, updates);
}

/**
 * Reconcile duplicated messages: when a message is duplicated, the copy shares
 * the same scene_fold_uuid. Detect duplicates and give each a fresh UUID,
 * adding the new UUID to the appropriate scene(s).
 * @param {object} chatMetadata
 * @param {Array} chat
 * @param {Function} uuidv4Fn - UUID generator
 * @returns {number} Number of messages fixed
 */
export function reconcileDuplicatedMessages(chatMetadata, chat, uuidv4Fn) {
    const data = getSceneFoldData(chatMetadata);
    let fixedCount = 0;

    // Build a map of UUID -> list of indices where it appears
    const uuidOccurrences = new Map();
    for (let i = 0; i < chat.length; i++) {
        const uuid = chat[i]?.extra?.scene_fold_uuid;
        if (!uuid) continue;
        if (!uuidOccurrences.has(uuid)) {
            uuidOccurrences.set(uuid, []);
        }
        uuidOccurrences.get(uuid).push(i);
    }

    for (const [originalUUID, indices] of uuidOccurrences) {
        if (indices.length <= 1) continue;

        // First occurrence keeps the original UUID; later occurrences are duplicates
        for (let d = 1; d < indices.length; d++) {
            const dupIdx = indices[d];
            const dupMsg = chat[dupIdx];
            const newUUID = uuidv4Fn();

            // Assign fresh UUID
            dupMsg.extra.scene_fold_uuid = newUUID;

            // Find which scene(s) the original belongs to and add the duplicate
            const sceneIds = dupMsg.extra.scene_fold_scenes || [];
            for (const sceneId of sceneIds) {
                const scene = data.scenes[sceneId];
                if (!scene) continue;

                // Insert new UUID right after the original in sourceMessageUUIDs
                const origPos = scene.sourceMessageUUIDs.indexOf(originalUUID);
                if (origPos !== -1) {
                    scene.sourceMessageUUIDs.splice(origPos + 1, 0, newUUID);
                } else {
                    scene.sourceMessageUUIDs.push(newUUID);
                }
            }

            fixedCount++;
            console.log(`[Scene Fold] Fixed duplicated message: assigned new UUID ${newUUID.slice(0, 8)}... (was ${originalUUID.slice(0, 8)}...)`);
        }
    }

    return fixedCount;
}

/**
 * Check if a message (by chat index) is part of any scene.
 * @param {Array} chat
 * @param {number} messageIndex
 * @returns {string[]} Array of scene IDs
 */
export function getMessageScenes(chat, messageIndex) {
    const msg = chat[messageIndex];
    return msg?.extra?.scene_fold_scenes || [];
}

/**
 * Reconcile all scenes against the current chat state after message deletion.
 * Removes orphaned UUIDs from scenes. Deletes scenes with no remaining sources.
 * Resets scenes whose summary message was deleted.
 * @param {object} chatMetadata
 * @param {Array} chat
 * @returns {{ modifiedScenes: string[], deletedScenes: string[], summaryLost: string[] }}
 */
export function reconcileScenesAfterDeletion(chatMetadata, chat) {
    const data = getSceneFoldData(chatMetadata);
    const uuidIndex = buildUUIDIndex(chat);
    const result = { modifiedScenes: [], deletedScenes: [], summaryLost: [] };

    for (const [sceneId, scene] of Object.entries(data.scenes)) {
        let modified = false;

        // Check source message UUIDs
        const validSources = scene.sourceMessageUUIDs.filter(uuid => {
            return findMessageIndexByUUID(chat, uuid, uuidIndex) !== -1;
        });

        if (validSources.length !== scene.sourceMessageUUIDs.length) {
            modified = true;
            scene.sourceMessageUUIDs = validSources;
        }

        // If no source messages remain, delete the scene entirely
        if (validSources.length === 0) {
            if (scene.summaryMessageUUID) {
                const summaryIdx = findMessageIndexByUUID(chat, scene.summaryMessageUUID, uuidIndex);
                if (summaryIdx !== -1) {
                    delete chat[summaryIdx].extra.scene_fold_scene_id;
                    delete chat[summaryIdx].extra.scene_fold_role;
                }
            }
            delete data.scenes[sceneId];
            result.deletedScenes.push(sceneId);
            continue;
        }

        // Check summary message UUID
        if (scene.summaryMessageUUID) {
            const summaryIdx = findMessageIndexByUUID(chat, scene.summaryMessageUUID, uuidIndex);
            if (summaryIdx === -1) {
                // Summary was deleted — reset scene to defined, un-hide sources
                scene.summaryMessageUUID = null;
                scene.status = 'defined';
                scene.folded = false;
                result.summaryLost.push(sceneId);
                modified = true;

                for (const uuid of scene.sourceMessageUUIDs) {
                    const idx = findMessageIndexByUUID(chat, uuid, uuidIndex);
                    if (idx !== -1) {
                        chat[idx].is_system = false;
                    }
                }
            }
        }

        if (modified && !result.deletedScenes.includes(sceneId)) {
            result.modifiedScenes.push(sceneId);
        }
    }

    return result;
}

/**
 * Check if a message range overlaps with any existing scene.
 * @param {object} chatMetadata
 * @param {Array} chat
 * @param {number} startIndex
 * @param {number} endIndex
 * @returns {string[]} Array of overlapping scene IDs
 */
export function findOverlappingScenes(chatMetadata, chat, startIndex, endIndex) {
    const overlapping = new Set();
    for (let i = startIndex; i <= endIndex; i++) {
        const scenes = getMessageScenes(chat, i);
        for (const sceneId of scenes) {
            overlapping.add(sceneId);
        }
    }
    return [...overlapping];
}
