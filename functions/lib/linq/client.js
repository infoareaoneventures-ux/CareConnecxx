"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkCapability = checkCapability;
exports.createChat = createChat;
exports.sendMessage = sendMessage;
exports.getMessage = getMessage;
exports.listMessages = listMessages;
exports.editMessage = editMessage;
exports.deleteMessage = deleteMessage;
exports.addReaction = addReaction;
exports.removeReaction = removeReaction;
exports.startTyping = startTyping;
exports.stopTyping = stopTyping;
exports.sendVoiceMemo = sendVoiceMemo;
exports.createOrUpdateContactCard = createOrUpdateContactCard;
exports.getContactCard = getContactCard;
exports.setContactCard = setContactCard;
exports.shareContactCard = shareContactCard;
exports.listPhoneNumbers = listPhoneNumbers;
exports.updateChatName = updateChatName;
exports.updateChatIcon = updateChatIcon;
exports.markChatRead = markChatRead;
exports.addParticipant = addParticipant;
exports.removeParticipant = removeParticipant;
exports.getOrCreateSession = getOrCreateSession;
exports.safeSend = safeSend;
exports.sendToPhone = sendToPhone;
const axios_1 = __importDefault(require("axios"));
const admin = __importStar(require("firebase-admin"));
const uuid_1 = require("uuid");
const supervisor_1 = require("../safety/supervisor");
const auditLog_1 = require("../observability/auditLog");
const db = admin.firestore();
// ── Config ────────────────────────────────────────────────────────────────────
function cfg() {
    var _a, _b, _c;
    return {
        apiKey: (_a = process.env.LINQ_API_KEY) !== null && _a !== void 0 ? _a : "",
        phoneNumber: (_b = process.env.LINQ_PHONE_NUMBER) !== null && _b !== void 0 ? _b : "",
        baseUrl: (_c = process.env.LINQ_BASE_URL) !== null && _c !== void 0 ? _c : "https://api.linqapp.com/api/partner/v3",
    };
}
function headers() {
    return {
        Authorization: `Bearer ${cfg().apiKey}`,
        "Content-Type": "application/json",
    };
}
// ── Retry helper — exponential backoff for 5xx and 3xxx transient errors ──────
async function withRetry(fn, attempts = 3) {
    var _a, _b, _c, _d, _e, _f;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            const status = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.status;
            const code = (_c = (_b = err === null || err === void 0 ? void 0 : err.response) === null || _b === void 0 ? void 0 : _b.data) === null || _c === void 0 ? void 0 : _c.code;
            // Retry on server errors and transient 3xxx codes; respect Retry-After for 429
            if (status === 429) {
                const retryAfter = parseInt((_f = (_e = (_d = err === null || err === void 0 ? void 0 : err.response) === null || _d === void 0 ? void 0 : _d.headers) === null || _e === void 0 ? void 0 : _e["retry-after"]) !== null && _f !== void 0 ? _f : "5", 10);
                if (i < attempts - 1) {
                    await new Promise((r) => setTimeout(r, retryAfter * 1000));
                    continue;
                }
            }
            // Never retry on ETIMEDOUT — the Linq API is not responding; fail fast.
            if ((err === null || err === void 0 ? void 0 : err.code) === "ETIMEDOUT" ||
                (err === null || err === void 0 ? void 0 : err.code) === "ECONNABORTED")
                throw err;
            const isTransient = (status === 500 || status === 503 || status === 504) ||
                (typeof code === "number" && code >= 3000 && code < 4000);
            if (!isTransient || i === attempts - 1)
                throw err;
            await new Promise((r) => setTimeout(r, Math.pow(2, i) * 1000));
        }
    }
    throw lastErr;
}
// ── Capability check ──────────────────────────────────────────────────────────
// Docs: use `address` field (not `handle`) per /guides/chats/capability-checks/
async function checkCapability(phone, from) {
    var _a, _b;
    try {
        const body = Object.assign({ address: phone }, (from ? { from } : {}));
        const [imsgRes, rcsRes] = await Promise.allSettled([
            axios_1.default.post(`${cfg().baseUrl}/capability/check_imessage`, body, { headers: headers(), timeout: 10000 }),
            axios_1.default.post(`${cfg().baseUrl}/capability/check_rcs`, body, { headers: headers(), timeout: 10000 }),
        ]);
        const iMessage = imsgRes.status === "fulfilled" ? !!((_a = imsgRes.value.data) === null || _a === void 0 ? void 0 : _a.available) : false;
        const RCS = rcsRes.status === "fulfilled" ? !!((_b = rcsRes.value.data) === null || _b === void 0 ? void 0 : _b.available) : false;
        return { iMessage, RCS };
    }
    catch (_c) {
        return { iMessage: false, RCS: false };
    }
}
// ── Core send ─────────────────────────────────────────────────────────────────
async function createChat(phone, message) {
    var _a, _b, _c, _d, _e, _f;
    const res = await withRetry(() => {
        var _a;
        return axios_1.default.post(`${cfg().baseUrl}/chats`, {
            from: cfg().phoneNumber,
            to: [phone],
            message: Object.assign(Object.assign({}, message), { idempotency_key: (_a = message.idempotency_key) !== null && _a !== void 0 ? _a : (0, uuid_1.v4)() }),
        }, { headers: headers(), timeout: 15000 });
    });
    const traceId = res.headers["x-trace-id"];
    if (traceId)
        console.info("Linq createChat trace_id:", traceId);
    return {
        chat_id: (_b = (_a = res.data.chat_id) !== null && _a !== void 0 ? _a : res.data.id) !== null && _b !== void 0 ? _b : (_c = res.data.chat) === null || _c === void 0 ? void 0 : _c.id,
        service: (_f = (_d = res.data.service) !== null && _d !== void 0 ? _d : (_e = res.data.chat) === null || _e === void 0 ? void 0 : _e.service) !== null && _f !== void 0 ? _f : "SMS",
    };
}
async function sendMessage(chatId, textOrMessage) {
    var _a, _b, _c, _d, _e, _f;
    const message = typeof textOrMessage === "string"
        ? { parts: [{ type: "text", value: textOrMessage }] }
        : textOrMessage;
    // Linq v3 POST /chats/{id}/messages requires the message nested under a "message" key.
    // Top-level parts (without the wrapper) returns error 1005 "at least one part required".
    const body = { message: Object.assign(Object.assign({}, message), { idempotency_key: (_a = message.idempotency_key) !== null && _a !== void 0 ? _a : (0, uuid_1.v4)() }) };
    let res;
    try {
        res = await withRetry(() => axios_1.default.post(`${cfg().baseUrl}/chats/${chatId}/messages`, body, { headers: headers(), timeout: 15000 }));
    }
    catch (err) {
        const axErr = err;
        console.error("Linq sendMessage failed", {
            chatId,
            status: (_b = axErr === null || axErr === void 0 ? void 0 : axErr.response) === null || _b === void 0 ? void 0 : _b.status,
            data: JSON.stringify((_d = (_c = axErr === null || axErr === void 0 ? void 0 : axErr.response) === null || _c === void 0 ? void 0 : _c.data) !== null && _d !== void 0 ? _d : {}),
        });
        throw err;
    }
    const traceId = res.headers["x-trace-id"];
    if (traceId)
        console.info("Linq sendMessage trace_id:", traceId, "chatId:", chatId);
    return { message_id: (_f = (_e = res.data.id) !== null && _e !== void 0 ? _e : res.data.message_id) !== null && _f !== void 0 ? _f : "" };
}
// ── Message retrieval + editing + deletion ───────────────────────────────────
async function getMessage(messageId) {
    const res = await withRetry(() => axios_1.default.get(`${cfg().baseUrl}/messages/${messageId}`, { headers: headers() }));
    return res.data;
}
async function listMessages(params) {
    var _a, _b;
    const query = new URLSearchParams();
    if (params.cursor)
        query.set("cursor", params.cursor);
    if (params.limit)
        query.set("limit", String(Math.min(params.limit, 100)));
    if (params.order)
        query.set("order", params.order);
    const res = await withRetry(() => axios_1.default.get(`${cfg().baseUrl}/messages/${params.messageId}/thread?${query}`, { headers: headers() }));
    return { messages: (_a = res.data.messages) !== null && _a !== void 0 ? _a : [], next_cursor: (_b = res.data.next_cursor) !== null && _b !== void 0 ? _b : null };
}
async function editMessage(messageId, newText) {
    await withRetry(() => axios_1.default.post(`${cfg().baseUrl}/messages/${messageId}/update`, { text: newText }, { headers: headers() }));
}
async function deleteMessage(messageId) {
    await withRetry(() => axios_1.default.post(`${cfg().baseUrl}/messages/${messageId}/delete`, {}, { headers: headers() }));
}
// ── Reactions ─────────────────────────────────────────────────────────────────
async function addReaction(params) {
    await withRetry(() => axios_1.default.post(`${cfg().baseUrl}/messages/${params.messageId}/reactions`, Object.assign(Object.assign({ operation: "add", type: params.type }, (params.customEmoji ? { custom_emoji: params.customEmoji } : {})), (params.partIndex !== undefined ? { part_index: params.partIndex } : {})), { headers: headers() }));
}
async function removeReaction(params) {
    await withRetry(() => axios_1.default.post(`${cfg().baseUrl}/messages/${params.messageId}/reactions`, Object.assign(Object.assign({ operation: "remove", type: params.type }, (params.customEmoji ? { custom_emoji: params.customEmoji } : {})), (params.partIndex !== undefined ? { part_index: params.partIndex } : {})), { headers: headers() }));
}
// ── Typing indicators ─────────────────────────────────────────────────────────
async function startTyping(chatId) {
    await axios_1.default
        .post(`${cfg().baseUrl}/chats/${chatId}/typing`, {}, { headers: headers() })
        .catch(() => { });
}
async function stopTyping(chatId) {
    await axios_1.default
        .delete(`${cfg().baseUrl}/chats/${chatId}/typing`, { headers: headers() })
        .catch(() => { });
}
// ── Voice memos ───────────────────────────────────────────────────────────────
async function sendVoiceMemo(chatId, source) {
    const body = "url" in source
        ? { voice_memo_url: source.url }
        : { attachment_id: source.attachment_id };
    await withRetry(() => axios_1.default.post(`${cfg().baseUrl}/chats/${chatId}/voicememo`, body, { headers: headers() }));
}
// ── Contact card ──────────────────────────────────────────────────────────────
// Docs schema: first_name, last_name?, image_url? (not display_name/profile_photo_url)
async function createOrUpdateContactCard(params) {
    var _a, _b;
    // Try create first; if 2014 (already exists) fall back to PATCH update
    try {
        await withRetry(() => axios_1.default.post(`${cfg().baseUrl}/contact_card`, params, { headers: headers() }));
    }
    catch (err) {
        const code = (_b = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.code;
        if (code === 2014) {
            await withRetry(() => axios_1.default.patch(`${cfg().baseUrl}/contact_card`, params, { headers: headers() })).catch(() => { });
        }
        // Other errors are non-critical for brand identity
    }
}
async function getContactCard() {
    try {
        const res = await withRetry(() => axios_1.default.get(`${cfg().baseUrl}/contact_card`, { headers: headers() }));
        return res.data;
    }
    catch (_a) {
        return null;
    }
}
/** @deprecated Use createOrUpdateContactCard — this alias kept for backward compat */
async function setContactCard(params) {
    const [first_name, ...rest] = params.display_name.split(" ");
    await createOrUpdateContactCard({
        phone_number: params.phone_number,
        first_name: first_name !== null && first_name !== void 0 ? first_name : params.display_name,
        last_name: rest.join(" ") || undefined,
        image_url: params.profile_photo_url,
    });
}
async function shareContactCard(chatId) {
    await axios_1.default
        .post(`${cfg().baseUrl}/chats/${chatId}/share_contact_card`, {}, { headers: headers() })
        .catch(() => { });
}
// ── Phone numbers ─────────────────────────────────────────────────────────────
async function listPhoneNumbers() {
    var _a, _b, _c;
    try {
        const res = await withRetry(() => axios_1.default.get(`${cfg().baseUrl}/phone_numbers`, { headers: headers() }));
        return ((_c = (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.phone_numbers) !== null && _b !== void 0 ? _b : res.data) !== null && _c !== void 0 ? _c : []);
    }
    catch (_d) {
        return [];
    }
}
// ── Chat management ───────────────────────────────────────────────────────────
async function updateChatName(chatId, displayName) {
    await axios_1.default
        .put(`${cfg().baseUrl}/chats/${chatId}`, { display_name: displayName }, { headers: headers() })
        .catch(() => { });
}
async function updateChatIcon(chatId, iconUrl) {
    await axios_1.default
        .put(`${cfg().baseUrl}/chats/${chatId}`, { group_chat_icon: iconUrl }, { headers: headers() })
        .catch(() => { });
}
async function markChatRead(chatId) {
    var _a;
    // Linq API path is /chats/{id}/read (returns 204 No Content).
    // Docs page slug says "mark_as_read" but the actual endpoint is /read.
    try {
        await axios_1.default.post(`${cfg().baseUrl}/chats/${chatId}/read`, {}, { headers: headers(), timeout: 5000 });
    }
    catch (err) {
        const e = err;
        console.warn("markChatRead failed", {
            chatId,
            status: (_a = e.response) === null || _a === void 0 ? void 0 : _a.status,
            msg: e.message,
        });
    }
}
async function addParticipant(chatId, phone) {
    await withRetry(() => axios_1.default.post(`${cfg().baseUrl}/chats/${chatId}/participants`, { handle: phone }, { headers: headers() }));
}
async function removeParticipant(chatId, phone) {
    await withRetry(() => axios_1.default.delete(`${cfg().baseUrl}/chats/${chatId}/participants/${encodeURIComponent(phone)}`, { headers: headers() }));
}
// ── Session management (get-or-create) ───────────────────────────────────────
async function getOrCreateSession(phone, meta) {
    const ref = db.collection("agent_sessions").doc(phone);
    // Atomically claim the creation slot so concurrent calls don't each create a separate Linq chat.
    let isCreator = false;
    let existingSession = null;
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
            const data = snap.data();
            if (data.chatId) {
                existingSession = data;
            }
            // else: _creating sentinel is present — another invocation owns creation
        }
        else {
            tx.set(ref, { _creating: true, phone, createdAt: new Date().toISOString() });
            isCreator = true;
        }
    });
    if (existingSession)
        return existingSession;
    if (!isCreator) {
        // Another concurrent invocation is creating the session — wait briefly for it to finish
        await new Promise((r) => setTimeout(r, 2000));
        const retry = (await ref.get()).data();
        if (retry === null || retry === void 0 ? void 0 : retry.chatId)
            return retry;
        throw new Error(`getOrCreateSession: concurrent creation timed out for ${phone}`);
    }
    // We won the race — make external API calls outside the transaction
    try {
        const capability = await checkCapability(phone);
        const service = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";
        // First message is a silent thread-opener; real content comes from the caller.
        // Per best-practices: no links or media in first message.
        const { chat_id } = await createChat(phone, {
            parts: [{ type: "text", value: "Hi! I'm Cara — your care assistant. I'm here whenever you need me." }],
        });
        const session = Object.assign({ chatId: chat_id, service, optedOut: false, createdAt: new Date().toISOString(), phone }, meta);
        await ref.set(session);
        // Best-practice: share contact card once after first outbound (non-blocking)
        if (service === "iMessage") {
            shareContactCard(chat_id).catch(() => { });
        }
        return session;
    }
    catch (err) {
        // Remove sentinel so the next call can retry rather than hanging
        await ref.delete().catch(() => { });
        throw err;
    }
}
// ── Circuit breaker — checked before every supervised send ───────────────────
// State is written by handlePhoneNumberStatusUpdated when the line is FLAGGED or CRITICAL.
// Cached in-process for 60s to avoid a Firestore read on every message.
let _cbCache = { open: false, cachedAt: 0 };
async function isCircuitOpen() {
    var _a;
    if (Date.now() - _cbCache.cachedAt < 60000)
        return _cbCache.open;
    try {
        const snap = await db.collection("system_config").doc("linq_circuit_breaker").get();
        const open = snap.exists && ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.status) === "open";
        _cbCache = { open, cachedAt: Date.now() };
        return open;
    }
    catch (_b) {
        return false; // fail open — don't block sends on Firestore errors
    }
}
// ── Per-pair rate limiter (Linq cap: 30 messages per 60s per sender-recipient) ─
async function checkPairRateLimit(chatId) {
    const windowMs = 60000;
    const maxPerMin = 28; // stay under Linq's 30 hard cap with a 2-message buffer
    const now = Date.now();
    const windowKey = Math.floor(now / windowMs);
    const ref = db.collection("linq_pair_rate").doc(`${chatId}:${windowKey}`);
    try {
        const count = await db.runTransaction(async (tx) => {
            var _a, _b;
            const snap = await tx.get(ref);
            const cur = (_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.count) !== null && _b !== void 0 ? _b : 0;
            if (cur >= maxPerMin)
                return cur;
            tx.set(ref, { count: cur + 1, expiresAt: now + windowMs * 2 }, { merge: true });
            return cur + 1;
        });
        return count <= maxPerMin;
    }
    catch (_a) {
        return true; // fail open — don't block sends on Firestore errors
    }
}
// ── safeSend — lints + supervises then sends ─────────────────────────────────
async function safeSend(chatId, message, context) {
    var _a;
    if (await isCircuitOpen()) {
        console.warn("safeSend: circuit breaker open (line FLAGGED/CRITICAL), dropping message", { chatId });
        return;
    }
    if (!(await checkPairRateLimit(chatId))) {
        console.warn("safeSend: per-pair rate limit reached, dropping message", { chatId });
        return;
    }
    let finalText = "";
    if (typeof message === "string") {
        const safe = await (0, supervisor_1.supervise)(message, context).catch(() => message);
        finalText = safe;
        await sendMessage(chatId, safe);
    }
    else {
        // For structured messages (media, links), only lint text parts
        const parts = (_a = message.parts) !== null && _a !== void 0 ? _a : [];
        const safeParts = await Promise.all(parts.map(async (p) => {
            if (p.type === "text" && p.value) {
                const safe = await (0, supervisor_1.supervise)(p.value, context).catch(() => { var _a; return (_a = p.value) !== null && _a !== void 0 ? _a : ""; });
                if (!finalText)
                    finalText = safe;
                return Object.assign(Object.assign({}, p), { value: safe });
            }
            return p;
        }));
        await sendMessage(chatId, Object.assign(Object.assign({}, message), { parts: safeParts }));
    }
    // Append-only audit log entry for every outbound message (non-blocking)
    if (context.phone) {
        (0, auditLog_1.logMessageSent)(context.phone, context.phone, chatId, finalText || "[structured message]").catch(() => { });
    }
}
// ── High-level helper: send to a phone number ────────────────────────────────
async function sendToPhone(phone, textOrMessage) {
    var _a, _b;
    if (await isCircuitOpen()) {
        console.warn("sendToPhone: circuit breaker open, dropping message", { phone });
        return;
    }
    const ref = db.collection("agent_sessions").doc(phone);
    const snap = await ref.get();
    if (snap.exists) {
        const session = snap.data();
        if (session.optedOut || session.optedIn === false)
            return;
        await sendMessage(session.chatId, textOrMessage);
        return;
    }
    // No session yet — create chat with this message as the opener
    const message = typeof textOrMessage === "string"
        ? { parts: [{ type: "text", value: textOrMessage }] }
        : textOrMessage;
    const capability = await checkCapability(phone);
    const service = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";
    try {
        const { chat_id } = await createChat(phone, message);
        const newSession = {
            chatId: chat_id,
            service,
            optedOut: false,
            createdAt: new Date().toISOString(),
            phone,
        };
        await ref.set(newSession);
        // Best-practice: share contact card after first outbound on iMessage (non-blocking)
        if (service === "iMessage") {
            shareContactCard(chat_id).catch(() => { });
        }
    }
    catch (err) {
        const e = err;
        console.error("Linq sendToPhone error:", (_b = (_a = e.response) === null || _a === void 0 ? void 0 : _a.data) !== null && _b !== void 0 ? _b : e.message);
        throw err;
    }
}
//# sourceMappingURL=client.js.map