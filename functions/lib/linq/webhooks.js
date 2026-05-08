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
Object.defineProperty(exports, "__esModule", { value: true });
exports.linqWebhook = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
const client_1 = require("./client");
const intentClassifier_1 = require("../agents/intentClassifier");
const qaAgent_1 = require("../agents/qaAgent");
const taskApprovalHandler_1 = require("../agents/taskApprovalHandler");
const sms_1 = require("../sms");
const db = admin.firestore();
// ── Signature verification ────────────────────────────────────────────────────
function verifySignature(rawBody, timestamp, signature, secret) {
    const payload = `${timestamp}.${rawBody}`;
    const expected = crypto
        .createHmac("sha256", secret)
        .update(payload)
        .digest("hex");
    try {
        return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
    }
    catch (_a) {
        return false;
    }
}
// ── Rate limiting ─────────────────────────────────────────────────────────────
async function isRateLimited(phone) {
    var _a, _b;
    const rateRef = db.collection("agent_rate").doc(phone);
    const snap = await rateRef.get();
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const calls = ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.calls) !== null && _b !== void 0 ? _b : []).filter(t => t > hourAgo);
    if (calls.length >= 10)
        return true;
    await rateRef.set({ calls: [...calls, now] });
    return false;
}
// ── Opt-in confirmation handler ───────────────────────────────────────────────
async function handleOptIn(phone, chatId, session) {
    var _a, _b, _c, _d, _e;
    await db.collection("agent_sessions").doc(phone).update({ optedIn: true });
    // Load first name for personalised welcome
    let firstName = "there";
    if (session.userId) {
        const userDoc = await db.collection("users").doc(session.userId).get();
        firstName = (_e = (_b = (_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.firstName) !== null && _b !== void 0 ? _b : (_d = (_c = userDoc.data()) === null || _c === void 0 ? void 0 : _c.name) === null || _d === void 0 ? void 0 : _d.split(" ")[0]) !== null && _e !== void 0 ? _e : "there";
    }
    await (0, client_1.sendMessage)(chatId, `You're all set, ${firstName}! 🎉\n\n` +
        `I'll send you real-time updates after every care visit — mood, meals, meds, and more.\n\n` +
        `Here's what you can ask me anytime:\n` +
        `· "How is [name] doing?"\n` +
        `· "When is the next visit?"\n` +
        `· "What did she eat today?"\n` +
        `· "Show me this week's updates"\n\n` +
        `Reply STOP anytime to unsubscribe.`);
    // Share CareConnecxx as a saved contact now that they've opted in
    await (0, client_1.shareContactCard)(chatId).catch(() => { });
}
// ── Inbound message handler ───────────────────────────────────────────────────
async function handleInbound(event) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const phone = (_b = (_a = event.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.value;
    const text = ((_f = (_e = (_d = (_c = event.data) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.value) !== null && _f !== void 0 ? _f : "");
    const chatId = (_h = (_g = event.data) === null || _g === void 0 ? void 0 : _g.chat) === null || _h === void 0 ? void 0 : _h.id;
    if (!phone || !chatId)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "CANCEL", "END"]);
    const normalized = text.trim().toUpperCase();
    if (session.optedOut)
        return;
    // STOP — opt out immediately, works at any stage
    if (stopWords.has(normalized)) {
        await (0, sms_1.optOutPhoneNumber)(phone);
        await (0, client_1.sendMessage)(chatId, "You've been unsubscribed from CareConnecxx messages. Reply START anytime to reactivate.");
        return;
    }
    // TCPA opt-in gate — session exists but user hasn't confirmed yet
    if (session.optedIn === false) {
        if (normalized === "YES" || normalized === "START") {
            await handleOptIn(phone, chatId, session);
        }
        else {
            await (0, client_1.sendMessage)(chatId, "Reply YES to activate care updates, or STOP to opt out.");
        }
        return;
    }
    // Rate limit — max 10 Claude calls per phone per hour
    if (await isRateLimited(phone)) {
        await (0, client_1.sendMessage)(chatId, "I'm getting a lot of messages right now — try again in a bit! 😊");
        return;
    }
    // Check for pending task (emergency replacement flow)
    const taskSnap = await db
        .collection("agent_tasks")
        .where("clientPhone", "==", phone)
        .where("status", "==", "awaiting_approval")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();
    const pendingTask = taskSnap.empty ? null : taskSnap.docs[0];
    // Show typing indicator — family sees "..." while Claude thinks
    await (0, client_1.startTyping)(chatId).catch(() => { });
    try {
        const intent = await (0, intentClassifier_1.classifyIntent)(text, !!pendingTask);
        if (intent === "TASK_REPLY" && pendingTask && ["1", "2", "3"].includes(text.trim())) {
            await (0, taskApprovalHandler_1.handleTaskApproval)(pendingTask, text.trim(), session, chatId);
            return; // handleTaskApproval sends its own messages
        }
        const reply = await (0, qaAgent_1.runQaAgent)({
            text,
            phone,
            userId: (_j = session.userId) !== null && _j !== void 0 ? _j : "",
            seniorId: (_l = (_k = session.seniorId) !== null && _k !== void 0 ? _k : session.userId) !== null && _l !== void 0 ? _l : "",
        });
        await (0, client_1.sendMessage)(chatId, reply);
    }
    catch (err) {
        console.error("handleInbound error:", err);
        await (0, client_1.stopTyping)(chatId);
        await (0, client_1.sendMessage)(chatId, "I'm having trouble right now. For urgent concerns, please call 911.");
    }
}
// ── Webhook HTTPS function ────────────────────────────────────────────────────
exports.linqWebhook = functions.https.onRequest(async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    // Always return 200 immediately — Linq expects a fast ack
    res.status(200).send("ok");
    if (req.method !== "POST")
        return;
    // Signature verification (skip if no secret configured — dev mode)
    const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
    if (webhookSecret) {
        const timestamp = (_a = req.headers["x-webhook-timestamp"]) !== null && _a !== void 0 ? _a : "";
        const signature = (_b = req.headers["x-webhook-signature"]) !== null && _b !== void 0 ? _b : "";
        const rawBody = JSON.stringify(req.body);
        if (!verifySignature(rawBody, timestamp, signature, webhookSecret)) {
            console.warn("linqWebhook: invalid signature — ignoring");
            return;
        }
    }
    const event = req.body;
    // Route by event type
    switch (event.type) {
        case "message.received":
            await handleInbound(event).catch((err) => console.error("linqWebhook handleInbound:", err));
            break;
        case "message.read":
            // Log read receipts for engagement tracking (Sprint 4)
            await db.collection("agent_read_receipts").add({
                chatId: (_d = (_c = event.data) === null || _c === void 0 ? void 0 : _c.chat) === null || _d === void 0 ? void 0 : _d.id,
                messageId: (_e = event.data) === null || _e === void 0 ? void 0 : _e.message_id,
                phone: (_g = (_f = event.data) === null || _f === void 0 ? void 0 : _f.sender_handle) === null || _g === void 0 ? void 0 : _g.value,
                readAt: new Date().toISOString(),
            }).catch(() => { });
            break;
        case "reaction.added":
            await db.collection("agent_reactions").add({
                chatId: (_j = (_h = event.data) === null || _h === void 0 ? void 0 : _h.chat) === null || _j === void 0 ? void 0 : _j.id,
                messageId: (_k = event.data) === null || _k === void 0 ? void 0 : _k.message_id,
                reaction: (_l = event.data) === null || _l === void 0 ? void 0 : _l.reaction,
                phone: (_o = (_m = event.data) === null || _m === void 0 ? void 0 : _m.sender_handle) === null || _o === void 0 ? void 0 : _o.value,
                reactedAt: new Date().toISOString(),
            }).catch(() => { });
            break;
        default:
            break;
    }
});
//# sourceMappingURL=webhooks.js.map