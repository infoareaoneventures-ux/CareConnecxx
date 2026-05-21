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
exports.wellbeingCheckinJob = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
exports.wellbeingCheckinJob = functions.pubsub
    .schedule("0 10 * * 3") // Every Wednesday at 10am UTC
    .timeZone("America/New_York")
    .onRun(async () => {
    // Only run on even ISO weeks (bi-weekly cadence)
    const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    if (weekNumber % 2 !== 0)
        return;
    const sessionsSnap = await db
        .collection("agent_sessions")
        .where("status", "==", "active")
        .where("userType", "==", "caregiver")
        .limit(500)
        .get();
    for (const doc of sessionsSnap.docs) {
        const phone = doc.id;
        const data = doc.data();
        if (data.optedOut)
            continue;
        const checkinMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: "Send a warm, brief wellbeing check-in to a caregiver. " +
                "Let them know it's a quick 3-question check-in and ask them to reply with a number 1–5 for each: " +
                "energy level this week (1=exhausted, 5=great), stress level (1=very stressed, 5=calm), and job satisfaction (1=unhappy, 5=love it). " +
                'Give a short example reply like: "4 3 5". Keep it friendly and low-pressure.',
            fallback: `Hi! Quick 3-question check-in — reply with a number 1–5 for each:\n\n` +
                `1️⃣ Energy level this week (1=exhausted, 5=great)\n` +
                `2️⃣ Stress level (1=very stressed, 5=calm)\n` +
                `3️⃣ Job satisfaction (1=unhappy, 5=love it)\n\n` +
                `Example reply: "4 3 5"`,
        });
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: checkinMsg,
            urgency: "standard",
            sourceAgent: "wellbeing_checkin",
            canDrop: true,
        }).catch(err => console.error(`wellbeingCheckin failed for ${phone}:`, err));
        await db.collection("agent_sessions").doc(phone).update({
            pendingWellbeingCheckin: true,
            wellbeingCheckinSentAt: new Date().toISOString(),
        });
    }
});
//# sourceMappingURL=wellbeingCheckin.js.map