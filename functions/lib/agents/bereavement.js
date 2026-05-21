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
exports.isBereavementTrigger = isBereavementTrigger;
exports.activateBereavementMode = activateBereavementMode;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client_1 = require("../linq/client");
const careMemory_1 = require("./careMemory");
const auditLog_1 = require("../observability/auditLog");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
// Fast-path keywords for obvious signals — Claude handles the nuanced cases
const OBVIOUS_BEREAVEMENT = ["passed away", "passed on", "she died", "he died", "they died",
    "funeral", "obituary", "died today", "died last night"];
async function isBereavementTrigger(text) {
    var _a;
    const lower = text.toLowerCase();
    if (OBVIOUS_BEREAVEMENT.some((kw) => lower.includes(kw)))
        return true;
    try {
        const res = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 5,
            system: "You are reading an SMS from a family using a care platform. " +
                "Reply YES if this message is informing us that their care recipient has died or passed away. " +
                "Reply NO otherwise. Reply with only YES or NO.",
            messages: [{ role: "user", content: text }],
        });
        return ((_a = res.content[0].text) !== null && _a !== void 0 ? _a : "").trim().toUpperCase().startsWith("Y");
    }
    catch (_b) {
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