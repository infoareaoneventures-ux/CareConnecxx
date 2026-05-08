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
exports.startTyping = startTyping;
exports.stopTyping = stopTyping;
exports.sendVoiceMemo = sendVoiceMemo;
exports.shareContactCard = shareContactCard;
exports.updateChatName = updateChatName;
exports.addParticipant = addParticipant;
exports.getOrCreateSession = getOrCreateSession;
exports.sendToPhone = sendToPhone;
const axios_1 = __importDefault(require("axios"));
const admin = __importStar(require("firebase-admin"));
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
// ── Capability check ──────────────────────────────────────────────────────────
async function checkCapability(phone) {
    var _a, _b;
    try {
        const { data } = await axios_1.default.post(`${cfg().baseUrl}/capability_checks`, { handles: [phone] }, { headers: headers() });
        const result = (_b = (_a = data === null || data === void 0 ? void 0 : data.handles) === null || _a === void 0 ? void 0 : _a[phone]) !== null && _b !== void 0 ? _b : {};
        return { iMessage: !!result.iMessage, RCS: !!result.RCS };
    }
    catch (_c) {
        return { iMessage: false, RCS: false };
    }
}
// ── Core send ─────────────────────────────────────────────────────────────────
async function createChat(phone, message) {
    var _a, _b;
    const { data } = await axios_1.default.post(`${cfg().baseUrl}/chats`, { from: cfg().phoneNumber, to: [phone], message }, { headers: headers() });
    return { chat_id: (_a = data.chat_id) !== null && _a !== void 0 ? _a : data.id, service: (_b = data.service) !== null && _b !== void 0 ? _b : "SMS" };
}
async function sendMessage(chatId, textOrMessage) {
    const message = typeof textOrMessage === "string"
        ? { parts: [{ type: "text", value: textOrMessage }] }
        : textOrMessage;
    await axios_1.default.post(`${cfg().baseUrl}/chats/${chatId}/messages`, message, { headers: headers() });
}
async function startTyping(chatId) {
    await axios_1.default.post(`${cfg().baseUrl}/chats/${chatId}/typing`, {}, { headers: headers() });
}
async function stopTyping(chatId) {
    await axios_1.default
        .delete(`${cfg().baseUrl}/chats/${chatId}/typing`, { headers: headers() })
        .catch(() => { });
}
async function sendVoiceMemo(chatId, voiceMemoUrl) {
    await axios_1.default.post(`${cfg().baseUrl}/chats/${chatId}/voicememo`, { voice_memo_url: voiceMemoUrl }, { headers: headers() });
}
async function shareContactCard(chatId) {
    await axios_1.default
        .post(`${cfg().baseUrl}/chats/${chatId}/share_contact_card`, {}, { headers: headers() })
        .catch(() => { });
}
async function updateChatName(chatId, displayName) {
    await axios_1.default
        .put(`${cfg().baseUrl}/chats/${chatId}`, { display_name: displayName }, { headers: headers() })
        .catch(() => { });
}
async function addParticipant(chatId, phone) {
    await axios_1.default.post(`${cfg().baseUrl}/chats/${chatId}/participants`, { handle: phone }, { headers: headers() });
}
// ── Session management (get-or-create) ───────────────────────────────────────
async function getOrCreateSession(phone, meta) {
    const ref = db.collection("agent_sessions").doc(phone);
    const snap = await ref.get();
    if (snap.exists) {
        return snap.data();
    }
    const capability = await checkCapability(phone);
    const service = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";
    // First message is a silent thread-opener; real content comes from the caller
    const { chat_id } = await createChat(phone, {
        parts: [{ type: "text", value: "CareConnecxx care assistant is here whenever you need us." }],
    });
    const session = Object.assign({ chatId: chat_id, service, optedOut: false, createdAt: new Date().toISOString() }, meta);
    await ref.set(session);
    return session;
}
// ── High-level helper: send to a phone number ────────────────────────────────
async function sendToPhone(phone, textOrMessage) {
    var _a, _b;
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
        await ref.set({
            chatId: chat_id,
            service,
            optedOut: false,
            createdAt: new Date().toISOString(),
        });
    }
    catch (err) {
        const e = err;
        console.error("Linq sendToPhone error:", (_b = (_a = e.response) === null || _a === void 0 ? void 0 : _a.data) !== null && _b !== void 0 ? _b : e.message);
        throw err;
    }
}
//# sourceMappingURL=client.js.map