import {
    chat,
    eventSource,
    event_types,
    saveChatConditional,
    updateMessageBlock,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const PATCH_FLAG = '__stChatu8SubtextPatchLoaded';
const PATCH_NAME = 'st-chatu8-subtext-patch';
const CHATU8_NAME = 'st-chatu8';

const BEGIN = '<!-- begin_of_Subtext_think -->';
const END = '<!-- end_of_Subtext_think -->';
const THINK_START_MARK = '<!-- 1\u00b7\u601d\u8003\u5f00\u59cb -->';
const THINK_END_MARK = '<!-- 1\u00b7\u601d\u8003\u7ed3\u675f -->';
const OUTPUT_START_MARK = '<!-- 2\u00b7\u8f93\u51fa\u5f00\u59cb -->';
const BODY_START_MARK = '<!-- \u6b63\u6587\u5f00\u59cb -->';
const BODY_END_MARK = '<!-- \u6b63\u6587\u7ed3\u675f -->';
const CONTENT_OPEN_RE = /<content\b[^>]*>/i;
const CONTENT_CLOSE_RE = /<\/content>/i;
const IMAGE_TAG_RE = /(?:^|\n)[ \t]*(image###[\s\S]*?###)[ \t]*(?=\n|$)/gi;
const PATCH_DEBOUNCE_MS = 120;

const pending = new Map();
let saveTimer = null;
let observer = null;

function getChatu8Settings() {
    return extension_settings?.[CHATU8_NAME] || {};
}

function getImageTags() {
    const settings = getChatu8Settings();
    return {
        start: settings?.startTag || 'image###',
        end: settings?.endTag || '###',
    };
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildImageBlockRegex() {
    const { start, end } = getImageTags();
    return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'gi');
}

function hasSubtextHints(text) {
    return text.includes(THINK_START_MARK) ||
        text.includes(THINK_END_MARK) ||
        text.includes(OUTPUT_START_MARK) ||
        text.includes(BEGIN) ||
        text.includes(END);
}

function hasImageTag(text) {
    IMAGE_TAG_RE.lastIndex = 0;
    return buildImageBlockRegex().test(text) || IMAGE_TAG_RE.test(text);
}

function normalizeImageBlocks(text) {
    const { start, end } = getImageTags();
    if (start === 'image###' && end === '###') {
        return text;
    }

    const customRe = buildImageBlockRegex();
    return text.replace(customRe, (match) => {
        if (!match.startsWith(start) || !match.endsWith(end)) {
            return match;
        }

        const inner = match.slice(start.length, match.length - end.length);
        return `image###${inner}###`;
    });
}

function collectImageBlocksOutsideBody(text) {
    const bodyStart = text.indexOf(BODY_START_MARK);
    if (bodyStart < 0) {
        return { text, moved: false };
    }

    const bodyEnd = text.indexOf(BODY_END_MARK, bodyStart + BODY_START_MARK.length);
    if (bodyEnd < 0) {
        return { text, moved: false };
    }

    const body = text.slice(bodyStart, bodyEnd);
    const blocks = [];
    let changed = false;

    const stripFromSegment = (segment) => segment.replace(IMAGE_TAG_RE, (full, block) => {
        blocks.push(block.trim());
        changed = true;
        return full.startsWith('\n') ? '\n' : '';
    });

    const before = stripFromSegment(text.slice(0, bodyStart));
    const middle = text.slice(bodyStart, bodyEnd);
    const after = stripFromSegment(text.slice(bodyEnd));

    if (!changed || blocks.length === 0) {
        return { text, moved: false };
    }

    const uniqueBlocks = [...new Set(blocks)].filter((block) => !body.includes(block));
    if (uniqueBlocks.length === 0) {
        return {
            text: `${before}${middle}${after}`.replace(/\n{3,}/g, '\n\n'),
            moved: true,
        };
    }

    const insertion = `\n${uniqueBlocks.join('\n')}`;
    const patchedBody = `${middle.replace(/\s*$/, '')}${insertion}\n`;

    return {
        text: `${before}${patchedBody}${after}`.replace(/\n{3,}/g, '\n\n'),
        moved: true,
    };
}

function ensureSubtextBoundaries(text) {
    let output = text;

    if (!output.includes(BEGIN) && output.includes(THINK_START_MARK)) {
        output = output.replace(THINK_START_MARK, `${THINK_START_MARK}\n${BEGIN}`);
    }

    if (!output.includes(END)) {
        if (output.includes(THINK_END_MARK)) {
            output = output.replace(THINK_END_MARK, `${END}\n${THINK_END_MARK}`);
        } else if (output.includes(OUTPUT_START_MARK)) {
            output = output.replace(OUTPUT_START_MARK, `${END}\n${OUTPUT_START_MARK}`);
        } else if (CONTENT_OPEN_RE.test(output)) {
            output = output.replace(CONTENT_OPEN_RE, `${END}\n$&`);
        }
    }

    return output;
}

function moveImageBlocksIntoBody(text) {
    let output = normalizeImageBlocks(text);
    const moved = collectImageBlocksOutsideBody(output);
    if (moved.moved) {
        output = moved.text;
    }

    if (!output.includes('image###')) {
        return output;
    }

    const bodyStart = output.indexOf(BODY_START_MARK);
    const bodyEnd = output.indexOf(BODY_END_MARK);
    if (bodyStart >= 0 && bodyEnd > bodyStart) {
        return output;
    }

    const contentOpen = output.search(CONTENT_OPEN_RE);
    const contentClose = output.search(CONTENT_CLOSE_RE);
    if (contentOpen >= 0 && contentClose > contentOpen && !output.includes(BODY_START_MARK)) {
        output = output.replace(CONTENT_OPEN_RE, `$&\n${BODY_START_MARK}`);
        output = output.replace(CONTENT_CLOSE_RE, `${BODY_END_MARK}\n$&`);
    }

    return output;
}

function patchText(text) {
    if (typeof text !== 'string' || !text) {
        return text;
    }

    if (!hasSubtextHints(text) && !hasImageTag(text)) {
        return text;
    }

    let output = ensureSubtextBoundaries(text);
    output = moveImageBlocksIntoBody(output);
    return output;
}

async function patchMessage(messageId, { save = false, rerender = true } = {}) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0 || !chat[id] || chat[id].is_user) {
        return false;
    }

    const message = chat[id];
    const original = String(message.mes ?? '');
    const patched = patchText(original);

    if (patched === original) {
        return false;
    }

    message.mes = patched;

    if (rerender) {
        updateMessageBlock(id, message);
    }

    if (save) {
        scheduleSave();
    }

    console.info(`[${PATCH_NAME}] fixed message`, id);
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

    clearTimeout(pending.get(id));
    pending.set(id, setTimeout(async () => {
        pending.delete(id);
        await patchMessage(id, options);
    }, PATCH_DEBOUNCE_MS));
}

function patchAll(options = {}) {
    for (let i = 0; i < chat.length; i += 1) {
        schedulePatch(i, options);
    }
}

function bindEvents() {
    const afterChatu8Options = { save: true, rerender: true };
    const bindLast = typeof eventSource.makeLast === 'function'
        ? eventSource.makeLast.bind(eventSource)
        : eventSource.on.bind(eventSource);

    bindLast(event_types.MESSAGE_UPDATED, (messageId) => schedulePatch(messageId, afterChatu8Options));
    bindLast(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => schedulePatch(messageId, afterChatu8Options));
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => schedulePatch(messageId, afterChatu8Options));
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => schedulePatch(messageId, afterChatu8Options));
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(() => patchAll({ save: false, rerender: true }), 250));
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
                const id = messageElement?.getAttribute?.('mesid');
                if (id !== null && id !== undefined && !seen.has(id)) {
                    seen.add(id);
                    schedulePatch(id, { save: true, rerender: true });
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
    bindEvents();
    observeChatDom();
    setTimeout(() => patchAll({ save: false, rerender: true }), 500);
    console.info(`[${PATCH_NAME}] loaded`);
}

init();
