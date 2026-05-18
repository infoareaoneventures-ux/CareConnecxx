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
const client_1 = require("../linq/client");
const careMemory_1 = require("./careMemory");
const auditLog_1 = require("../observability/auditLog");
const db = admin.firestore();
const BEREAVEMENT_KEYWORDS = [
    "passed away",
    "passed on",
    "she passed",
    "he passed",
    "they passed",
    "she died",
    "he died",
    "she's gone",
    "he's gone",
    "she has died",
    "he has died",
    "died today",
    "died last night",
    "funeral",
    "obituary",
    "rest in peace",
    "no longer with us",
    "we lost her",
    "we lost him",
    "gone to heaven",
];
function isBereavementTrigger(text) {
    const lower = text.toLowerCase();
    return BEREAVEMENT_KEYWORDS.some((kw) => lower.includes(kw));
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
    await (0, client_1.sendMessage)(chatId, `I'm so sorry for the loss of ${seniorName}. 💙\n\n` +
        `Please take all the time you need. I'm here whenever you're ready.`);
    // 4. Generate care memory keepsake (non-blocking — takes a moment)
    const seniorSnap = await db.collection("users").doc(userId).get();
    const seniorId = (_b = (_a = seniorSnap.data()) === null || _a === void 0 ? void 0 : _a.seniorId) !== null && _b !== void 0 ? _b : userId;
    (0, careMemory_1.generateCareMemoryKeepsake)(seniorId, userId)
        .then(async (url) => {
        if (!url)
            return;
        await (0, client_1.sendMessage)(chatId, `I've put together a care memory for you — a record of ${seniorName}'s journey and all the love that surrounded them. 💙`);
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