import {
    chat,
    eventSource,
    event_types,
    saveChatConditional,
    updateMessageBlock,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const PATCH_FLAG = '__stChatu8SubtextPatchLoaded';
const FETCH_FLAG = '__stChatu8SubtextPatchFetchWrapped';
const PATCH_NAME = 'st-chatu8-subtext-patch';
const CHATU8_NAME = 'st-chatu8';

const BEGIN = '<!-- begin_of_Subtext_think -->';
const END = '<!-- end_of_Subtext_think -->';
const CONTENT_OPEN_RE = /<content\b[^>]*>/i;
const CONTENT_CLOSE_RE = /<\/content>/i;
const DEFAULT_START_TAG = 'image###';
const DEFAULT_END_TAG = '###';
const STREAM_ENVELOPE_RE = /\b(?:data:\s*\{|choices|finish_reason|prompt_tokens|completion_tokens|chat\.completion\.chunk|\"delta\"|\"usage\")\b/i;
const SSE_DATA_RE = /^data:\s*\{/m;
const BODY_END_MARK = '<!-- \u6b63\u6587\u7ed3\u675f -->';
const CHATU8_ACTION_RE = /chatu|image|novelai|nai|sd|comfy|banana|\u7ed8|\u56fe|\u751f\u6210|\u63d2\u56fe/i;
const CHATU8_REPLY_RE = /<images?>|<\/images?>|<Tag_think>|<\/Tag_think>|regex\s*:|image#{0,3}\s*(?:Scene Composition|$)/i;
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const ACTIVE_TTL_MS = 3 * 60 * 1000;
const PATCH_DEBOUNCE_MS = 160;

const snapshots = new Map();
const pendingTimers = new Map();
const pendingImageBlocks = new Map();

let activeMessageId = null;
let activeUntil = 0;
let saveTimer = null;
let observer = null;

function getChatu8Settings() {
    return extension_settings?.[CHATU8_NAME] || {};
}

function getImageTags() {
    const settings = getChatu8Settings();
    return {
        start: settings?.startTag || DEFAULT_START_TAG,
        end: settings?.endTag || DEFAULT_END_TAG,
    };
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildImageBlockRegex(start, end) {
    return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'gi');
}

function getImageRegexes() {
    const { start, end } = getImageTags();
    const regexes = [buildImageBlockRegex(DEFAULT_START_TAG, DEFAULT_END_TAG)];
    if (start !== DEFAULT_START_TAG || end !== DEFAULT_END_TAG) {
        regexes.push(buildImageBlockRegex(start, end));
    }
    return regexes;
}

function hasSubtextBoundaries(text) {
    return typeof text === 'string' && text.includes(BEGIN) && text.includes(END);
}

function hasContent(text) {
    return typeof text === 'string' && CONTENT_OPEN_RE.test(text) && CONTENT_CLOSE_RE.test(text);
}

function hasImageBlock(text) {
    if (typeof text !== 'string') {
        return false;
    }

    return getImageRegexes().some((regex) => {
        regex.lastIndex = 0;
        return regex.test(text);
    });
}

function snapshotScore(text) {
    if (typeof text !== 'string') {
        return -1;
    }

    let score = text.length > 0 ? 1 : 0;
    if (hasContent(text)) score += 8;
    if (hasSubtextBoundaries(text)) score += 16;
    if (text.includes(BEGIN) || text.includes(END)) score += 4;
    return score;
}

function getMessageIdFromElement(element) {
    const messageElement = element?.closest?.('.mes[mesid]');
    const rawId = messageElement?.getAttribute?.('mesid');
    const id = Number(rawId);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

function getLastAssistantMessageId() {
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i] && !chat[i].is_user) {
            return i;
        }
    }
    return null;
}

function getActiveMessageIdOnly() {
    if (Number.isInteger(activeMessageId) && Date.now() < activeUntil && chat[activeMessageId]) {
        return activeMessageId;
    }
    return null;
}

function getTargetMessageId() {
    return getActiveMessageIdOnly() ?? getLastAssistantMessageId();
}

function getActionDescriptor(element) {
    const host = element?.closest?.('button, [role="button"], a, [title], [aria-label]') || element;
    const dataset = host?.dataset || element?.dataset || {};
    const values = [
        element?.textContent,
        element?.title,
        element?.ariaLabel,
        element?.id,
        element?.className,
        host?.textContent,
        host?.title,
        host?.ariaLabel,
        host?.id,
        host?.className,
        ...Object.values(dataset),
    ];

    return values.filter(Boolean).join(' ');
}

function markActiveMessage(messageId, reason = 'unknown') {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0 || !chat[id] || chat[id].is_user) {
        return;
    }

    activeMessageId = id;
    activeUntil = Date.now() + ACTIVE_TTL_MS;
    snapshotMessage(id, reason, true);
}

function snapshotMessage(messageId, reason = 'auto', force = false) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0 || !chat[id] || chat[id].is_user) {
        return false;
    }

    const text = String(chat[id].mes ?? '');
    if (!text) {
        return false;
    }

    const current = snapshots.get(id);
    const currentScore = current ? snapshotScore(current.text) : -1;
    const nextScore = snapshotScore(text);
    const shouldKeepOld = current &&
        !force &&
        hasSubtextBoundaries(current.text) &&
        !hasSubtextBoundaries(text);

    if (shouldKeepOld) {
        return false;
    }

    if (!force && current && nextScore < currentScore) {
        return false;
    }

    snapshots.set(id, {
        text,
        score: nextScore,
        reason,
        time: Date.now(),
    });
    pruneSnapshots();
    return true;
}

function snapshotAll(reason = 'all') {
    for (let i = 0; i < chat.length; i += 1) {
        snapshotMessage(i, reason, false);
    }
}

function pruneSnapshots() {
    const now = Date.now();
    for (const [id, snapshot] of snapshots.entries()) {
        if (now - snapshot.time > SNAPSHOT_TTL_MS || !chat[id]) {
            snapshots.delete(id);
            pendingImageBlocks.delete(id);
        }
    }
}

function uniqueBlocks(blocks) {
    const seen = new Set();
    const result = [];

    for (const block of blocks) {
        const normalized = String(block ?? '').trim();
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }

    return result;
}

function isPollutedImageBlock(block) {
    return STREAM_ENVELOPE_RE.test(String(block ?? ''));
}

function cleanImageBlocks(blocks) {
    return uniqueBlocks(blocks).filter((block) => !isPollutedImageBlock(block));
}

function extractImageBlocks(text) {
    if (typeof text !== 'string' || !text) {
        return [];
    }

    const blocks = [];
    for (const regex of getImageRegexes()) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            blocks.push(match[0]);
        }
    }

    return cleanImageBlocks(blocks);
}

function removeImageBlocks(text) {
    let output = String(text ?? '');
    for (const regex of getImageRegexes()) {
        regex.lastIndex = 0;
        output = output.replace(regex, '');
    }
    return output.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
}

function removePollutedImageBlocks(text) {
    let output = String(text ?? '');
    for (const regex of getImageRegexes()) {
        regex.lastIndex = 0;
        output = output.replace(regex, (block) => isPollutedImageBlock(block) ? '' : block);
    }
    return output.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
}

function addPendingBlocks(messageId, blocks) {
    const id = Number(messageId);
    const cleanBlocks = cleanImageBlocks(blocks);
    if (!Number.isInteger(id) || id < 0 || cleanBlocks.length === 0) {
        return;
    }

    const bucket = pendingImageBlocks.get(id) || [];
    pendingImageBlocks.set(id, uniqueBlocks([...bucket, ...cleanBlocks]));
    schedulePatch(id, { save: true, rerender: true, reason: 'pending-image-blocks' });
}

function getInsertionIndex(base) {
    const bodyEndIndex = base.indexOf(BODY_END_MARK);
    if (bodyEndIndex >= 0) {
        return bodyEndIndex;
    }

    const closeMatch = CONTENT_CLOSE_RE.exec(base);
    if (closeMatch) {
        return closeMatch.index;
    }

    return base.length;
}

function mergeBlocksIntoBase(baseText, blocks) {
    const cleanBlocks = cleanImageBlocks(blocks);
    if (cleanBlocks.length === 0) {
        return baseText;
    }

    let base = removeImageBlocks(baseText);
    const insertionIndex = getInsertionIndex(base);
    const before = base.slice(0, insertionIndex).replace(/[ \t]+$/g, '');
    const after = base.slice(insertionIndex);
    const needsLeadingNewline = before.length > 0 && !before.endsWith('\n');
    const needsTrailingNewline = after.length > 0 && !after.startsWith('\n');
    const insertion = `${needsLeadingNewline ? '\n' : ''}${cleanBlocks.join('\n')}${needsTrailingNewline ? '\n' : ''}`;

    return `${before}${insertion}${after}`;
}

function chooseBaseText(messageId, currentText) {
    const snapshot = snapshots.get(messageId)?.text;
    if (!snapshot) {
        return currentText;
    }

    if (hasSubtextBoundaries(snapshot) && !hasSubtextBoundaries(currentText)) {
        return snapshot;
    }

    if (hasContent(snapshot) && !hasContent(currentText)) {
        return snapshot;
    }

    return snapshotScore(snapshot) >= snapshotScore(currentText) ? snapshot : currentText;
}

function shouldRepairFromSnapshot(messageId, currentText, blocks) {
    const snapshot = snapshots.get(messageId)?.text;
    if (!snapshot) {
        return false;
    }

    const lostSubtextTags = hasSubtextBoundaries(snapshot) && !hasSubtextBoundaries(currentText);
    const hasNewImageBlocks = blocks.some((block) => !snapshot.includes(block));
    const imageOutsideSnapshotBase = hasImageBlock(currentText) && !hasImageBlock(snapshot);

    return lostSubtextTags || hasNewImageBlocks || imageOutsideSnapshotBase;
}

async function patchMessage(messageId, { save = false, rerender = true, reason = 'event' } = {}) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0 || !chat[id] || chat[id].is_user) {
        return false;
    }

    const message = chat[id];
    const rawCurrentText = String(message.mes ?? '');
    const unwrappedText = unwrapSseEnvelopeText(rawCurrentText);
    const currentText = removePollutedImageBlocks(unwrappedText);
    const currentBlocks = extractImageBlocks(currentText);
    const queuedBlocks = pendingImageBlocks.get(id) || [];
    const allBlocks = cleanImageBlocks([...currentBlocks, ...queuedBlocks]);
    const snapshot = snapshots.get(id)?.text;

    if (!snapshot && allBlocks.length === 0) {
        if (currentText !== rawCurrentText) {
            message.mes = currentText;
            if (rerender) {
                updateMessageBlock(id, message);
            }
            if (save) {
                scheduleSave();
            }
            return true;
        }
        snapshotMessage(id, reason, false);
        return false;
    }

    let patched = currentText;

    if (snapshot && isSseEnvelopeText(rawCurrentText) && allBlocks.length === 0) {
        patched = snapshot;
    }

    if (allBlocks.length > 0 || shouldRepairFromSnapshot(id, currentText, allBlocks)) {
        const base = chooseBaseText(id, currentText);
        patched = allBlocks.length > 0 ? mergeBlocksIntoBase(base, allBlocks) : base;
    }

    if (snapshot && hasSubtextBoundaries(snapshot) && !hasSubtextBoundaries(patched)) {
        patched = allBlocks.length > 0 ? mergeBlocksIntoBase(snapshot, allBlocks) : snapshot;
    }

    if (patched === rawCurrentText) {
        snapshotMessage(id, reason, false);
        return false;
    }

    message.mes = patched;
    pendingImageBlocks.delete(id);
    snapshots.set(id, {
        text: patched,
        score: snapshotScore(patched),
        reason: `patched:${reason}`,
        time: Date.now(),
    });

    if (rerender) {
        updateMessageBlock(id, message);
    }

    if (save) {
        scheduleSave();
    }

    console.info(`[${PATCH_NAME}] repaired message ${id}`, {
        reason,
        blocks: allBlocks.length,
    });
    return true;
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveChatConditional();
    }, 500);
}

function schedulePatch(messageId, options = {}) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) {
        return;
    }

    clearTimeout(pendingTimers.get(id));
    pendingTimers.set(id, setTimeout(async () => {
        pendingTimers.delete(id);
        await patchMessage(id, options);
    }, PATCH_DEBOUNCE_MS));
}

function patchAll(options = {}) {
    for (let i = 0; i < chat.length; i += 1) {
        schedulePatch(i, options);
    }
}

function collectStrings(value, result = []) {
    if (typeof value === 'string') {
        result.push(value);
        return result;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectStrings(item, result);
        }
        return result;
    }

    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
            collectStrings(item, result);
        }
    }

    return result;
}

function collectSseContent(responseText) {
    const parts = [];
    const events = String(responseText ?? '').split(/\r?\n\r?\n/);

    for (const event of events) {
        const lines = event.split(/\r?\n/);
        for (const line of lines) {
            if (!line.startsWith('data:')) {
                continue;
            }

            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
                continue;
            }

            try {
                const parsed = JSON.parse(payload);
                const deltaContent = parsed?.choices?.[0]?.delta?.content;
                const messageContent = parsed?.choices?.[0]?.message?.content;
                const text = deltaContent ?? messageContent;
                if (typeof text === 'string') {
                    parts.push(text);
                }
            } catch {
                // Ignore non-JSON SSE lines.
            }
        }
    }

    return parts.join('');
}

function collectJsonContent(responseText) {
    try {
        const parsed = JSON.parse(responseText);
        const preferred = [
            parsed?.choices?.[0]?.message?.content,
            parsed?.choices?.[0]?.delta?.content,
            parsed?.message?.content,
            parsed?.content,
            parsed?.text,
        ].filter((item) => typeof item === 'string');

        if (preferred.length > 0) {
            return preferred.join('');
        }

        return collectStrings(parsed).join('\n');
    } catch {
        return '';
    }
}

function collectBlocksFromResponseText(responseText) {
    const text = String(responseText ?? '');
    const blocks = [];
    const sseContent = collectSseContent(text);
    const jsonContent = collectJsonContent(text);

    if (sseContent) {
        blocks.push(...extractImageBlocks(sseContent));
    }

    if (jsonContent) {
        blocks.push(...extractImageBlocks(jsonContent));
    }

    if (!sseContent && !jsonContent && !/^data:\s*\{/m.test(text)) {
        blocks.push(...extractImageBlocks(text));
    }

    return cleanImageBlocks(blocks);
}

function isSseEnvelopeText(text) {
    return SSE_DATA_RE.test(String(text ?? '')) && /\"delta\"\s*:\s*\{/.test(String(text ?? ''));
}

function contentToOpenAiJson(content) {
    return JSON.stringify({
        choices: [
            {
                message: { content },
                delta: { content },
                finish_reason: 'stop',
            },
        ],
    });
}

function shouldNormalizeFetchResponse(responseText, content = collectSseContent(responseText)) {
    if (!isSseEnvelopeText(responseText)) {
        return false;
    }

    if (CHATU8_REPLY_RE.test(content) || hasImageBlock(content)) {
        return true;
    }

    return false;
}

function makeNormalizedResponse(originalResponse, responseText, content = collectSseContent(responseText)) {
    if (!content) {
        return originalResponse;
    }

    const headers = new Headers(originalResponse.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.delete('content-length');

    return new Response(contentToOpenAiJson(content), {
        status: originalResponse.status,
        statusText: originalResponse.statusText,
        headers,
    });
}

function wrapFetch() {
    if (window[FETCH_FLAG] || typeof window.fetch !== 'function') {
        return;
    }

    window[FETCH_FLAG] = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
        const targetId = getTargetMessageId();
        const response = await originalFetch(...args);

        try {
            const cloned = response.clone();
            const text = await cloned.text();
            const sseContent = collectSseContent(text);
            const blocks = collectBlocksFromResponseText(text);
            if (blocks.length > 0 && targetId !== null) {
                addPendingBlocks(targetId, blocks);
            }

            if (shouldNormalizeFetchResponse(text, sseContent, targetId)) {
                return makeNormalizedResponse(response, text, sseContent);
            }
        } catch {
            // Some streamed responses cannot be cloned in every browser path.
        }

        return response;
    };
}

function unwrapSseEnvelopeText(text) {
    if (!isSseEnvelopeText(text)) {
        return text;
    }

    const content = collectSseContent(text);
    return content || text;
}

function onPossibleChatu8Action(event) {
    const target = event.target;
    const id = getMessageIdFromElement(target);
    const descriptor = getActionDescriptor(target);

    if (id !== null && CHATU8_ACTION_RE.test(descriptor)) {
        markActiveMessage(id, event.type);
    }
}

function bindEvents() {
    const afterOptions = { save: true, rerender: true };
    const bindFirst = typeof eventSource.makeFirst === 'function'
        ? eventSource.makeFirst.bind(eventSource)
        : eventSource.on.bind(eventSource);
    const bindLast = typeof eventSource.makeLast === 'function'
        ? eventSource.makeLast.bind(eventSource)
        : eventSource.on.bind(eventSource);

    bindFirst(event_types.MESSAGE_RECEIVED, (messageId) => snapshotMessage(messageId, 'MESSAGE_RECEIVED:first', true));
    bindFirst(event_types.MESSAGE_UPDATED, (messageId) => snapshotMessage(messageId, 'MESSAGE_UPDATED:first', false));
    bindFirst(event_types.MESSAGE_SWIPED, (messageId) => snapshotMessage(messageId, 'MESSAGE_SWIPED:first', true));

    bindLast(event_types.MESSAGE_UPDATED, (messageId) => schedulePatch(messageId, { ...afterOptions, reason: 'MESSAGE_UPDATED' }));
    bindLast(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        snapshotMessage(messageId, 'CHARACTER_MESSAGE_RENDERED', false);
        schedulePatch(messageId, { ...afterOptions, reason: 'CHARACTER_MESSAGE_RENDERED' });
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        snapshotMessage(messageId, 'MESSAGE_RECEIVED', true);
        schedulePatch(messageId, { ...afterOptions, reason: 'MESSAGE_RECEIVED' });
    });
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
        snapshotMessage(messageId, 'MESSAGE_SWIPED', true);
        schedulePatch(messageId, { ...afterOptions, reason: 'MESSAGE_SWIPED' });
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            snapshotAll('CHAT_CHANGED');
            patchAll({ save: false, rerender: true, reason: 'CHAT_CHANGED' });
        }, 250);
    });

    document.addEventListener('pointerdown', onPossibleChatu8Action, true);
    document.addEventListener('click', onPossibleChatu8Action, true);
}

function observeChatDom() {
    const chatRoot = document.getElementById('chat');
    if (!chatRoot || observer) {
        return;
    }

    observer = new MutationObserver((mutations) => {
        const seen = new Set();
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
                const messageElement = element?.matches?.('.mes[mesid]')
                    ? element
                    : element?.closest?.('.mes[mesid]');
                const id = messageElement ? Number(messageElement.getAttribute('mesid')) : NaN;
                if (Number.isInteger(id) && id >= 0 && !seen.has(id)) {
                    seen.add(id);
                    snapshotMessage(id, 'dom', false);
                    schedulePatch(id, { save: true, rerender: true, reason: 'dom' });
                }
            }
        }
    });

    observer.observe(chatRoot, { childList: true, subtree: true });
}

function init() {
    if (window[PATCH_FLAG]) {
        return;
    }

    window[PATCH_FLAG] = true;
    wrapFetch();
    bindEvents();
    observeChatDom();
    setTimeout(() => {
        snapshotAll('init');
        patchAll({ save: false, rerender: true, reason: 'init' });
    }, 500);
    console.info(`[${PATCH_NAME}] loaded`);
}

init();
