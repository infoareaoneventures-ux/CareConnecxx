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
exports.isBereavementTrigger = isBereavementTrigger;
exports.activateBereavementMode = activateBereavementMode;
const admin = __importStar(require("firebase-admin"));
const openaiClient_1 = require("../utils/openaiClient");
const client_1 = require("../linq/client");
const careMemory_1 = require("./careMemory");
const auditLog_1 = require("../observability/auditLog");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
// Fast-path keywords for obvious signals — Claude handles the nuanced cases
const OBVIOUS_BEREAVEMENT = ["passed away", "passed on", "she died", "he died", "they died",
    "funeral", "obituary", "died today", "died last night"];
// Short binary acks / fillers — can never be a death disclosure on their own,
// and feeding "Yes" to a YES/NO classifier reliably produces a false "YES" echo.
const TRIVIAL_ACKS = new Set([
    "y", "n", "yes", "no", "yeah", "yep", "yup", "nope", "nah",
    "ok", "okay", "k", "kk", "sure", "fine", "alright", "got it",
    "thanks", "thank you", "ty", "thx", "cool", "great", "perfect",
    "maybe", "idk", "hi", "hello", "hey",
]);
async function isBereavementTrigger(text) {
    const lower = text.toLowerCase().trim();
    if (OBVIOUS_BEREAVEMENT.some((kw) => lower.includes(kw)))
        return true;
    // Guard: bare acks like "Yes" / "ok" must not be classified as a death disclosure.
    // They almost always answer a prior question from Cara, and the YES/NO classifier
    // tends to echo the user's "Yes" back as a positive label.
    const stripped = lower.replace(/[.!?]+$/g, "");
    if (TRIVIAL_ACKS.has(stripped))
        return false;
    if (stripped.length < 8)
        return false;
    try {
        const raw = await (0, openaiClient_1.quickComplete)("You are reading an SMS from a family using a care platform. " +
            "Reply YES only if this message is clearly informing us that their care recipient has died or passed away " +
            "(e.g. mentions death, dying, passing, funeral, obituary, or hospice end-of-life). " +
            "A bare acknowledgment like \"yes\", \"ok\", or \"sure\" is NEVER a death disclosure — reply NO for those. " +
            "Reply NO if you are unsure. Reply with only YES or NO.", text, { maxTokens: 5 });
        return raw.trim().toUpperCase().startsWith("Y");
    }
    catch (_a) {
        return false;
    }
}
async function activateBereavementMode(userId, chatId, phone, seniorName) {
    var _a, _b;
    // 1. Set bereavementMode with activation timestamp
    await db.collection("agent_sessions").doc(phone).update({
        bereavementMode: true,
        bereavementActivatedAt: new Date().toISOString(),
    });
    // 2. Cancel all pending proactive triggers
    const triggerSnap = await db
        .collection("proactive_triggers")
        .where("userId", "==", userId)
        .where("firedAt", "==", null)
        .where("cancelledAt", "==", null)
        .get();
    if (!triggerSnap.empty) {
        const batch = db.batch();
        const now = new Date().toISOString();
        for (const doc of triggerSnap.docs) {
            batch.update(doc.ref, { cancelledAt: now, cancelReason: "bereavement" });
        }
        await batch.commit().catch(() => { });
    }
    // 3. Send compassionate opening message
    const condolenceMsg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara just learned that ${seniorName} has passed away. Send heartfelt condolences to the family. The tone should be warm, gentle, and compassionate — not clinical. Cara may use a heart emoji (💙) if appropriate.`,
        fallback: `I'm so sorry for the loss of ${seniorName}. 💙\n\nPlease take all the time you need. I'm here whenever you're ready.`,
        maxTokens: 100,
    });
    await (0, client_1.sendMessage)(chatId, condolenceMsg);
    // 4. Generate care memory keepsake (non-blocking — takes a moment)
    const seniorSnap = await db.collection("users").doc(userId).get();
    const seniorId = (_b = (_a = seniorSnap.data()) === null || _a === void 0 ? void 0 : _a.seniorId) !== null && _b !== void 0 ? _b : userId;
    (0, careMemory_1.generateCareMemoryKeepsake)(seniorId, userId)
        .then(async (url) => {
        if (!url) {
            // Keepsake generation failed — send a compassionate fallback so family isn't left in silence.
            const keepsakePromiseMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Cara is promising to create a care memory keepsake for ${seniorName} — a record of their journey and all the love that surrounded them. The tone should be warm, gentle, and compassionate — not clinical. Cara may use a heart emoji (💙) if appropriate.`,
                fallback: `I'll put together a care memory for ${seniorName} — a record of their journey and all the love that surrounded them. I'll send it to you shortly. 💙`,
                maxTokens: 100,
            });
            await (0, client_1.sendMessage)(chatId, keepsakePromiseMsg).catch(() => { });
            return;
        }
        const keepsakeDeliveryMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "family",
            context: `Cara is delivering the care memory keepsake for ${seniorName} — a record of their journey and all the love that surrounded them. The tone should be warm, gentle, and compassionate — not clinical. Cara may use a heart emoji (💙) if appropriate.`,
            fallback: `I've put together a care memory for you — a record of ${seniorName}'s journey and all the love that surrounded them. 💙`,
            maxTokens: 100,
        });
        await (0, client_1.sendMessage)(chatId, keepsakeDeliveryMsg);
        await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: url }] });
    })
        .catch((err) => console.error("bereavement keepsake error:", err));
    // 5. Audit log
    (0, auditLog_1.logAudit)({
        eventType: "session_created",
        userId,
        phone,
        data: { event: "bereavement_mode_activated", seniorName },
    }).catch(() => { });
}
//# sourceMappingURL=bereavement.js.map