"use strict";
/**
 * Family-silence check-in.
 *
 * Runs daily. For each active client session (onboarding complete, opted-in,
 * not opted-out) where `lastInboundAt` is older than 3 days, send one gentle,
 * context-aware check-in message. Cap at one nudge per 7 days per phone so
 * we never spam silent users.
 *
 * Uses the existing `sendViaInteractionAgent` flow so DND, supervisor, and
 * audit logging are honored. Skips users currently in bereavement mode.
 */
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
exports.familySilenceCheckinJob = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
exports.familySilenceCheckinJob = functions.pubsub
    .schedule("0 16 * * *") // 16:00 UTC daily (~11am ET / ~9am MT) — friendly business-hour window
    .timeZone("America/New_York")
    .onRun(async () => {
    var _a, _b, _c;
    const now = Date.now();
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Pull active client sessions that:
    //   - onboardingStep === "complete"
    //   - userType === "client"
    //   - last inbound > 3 days ago
    //
    // We filter the rest in code (Firestore composite-index limits keep the
    // query simple). Hard cap of 500 sessions/run keeps cost bounded.
    const snap = await db.collection("agent_sessions")
        .where("userType", "==", "client")
        .where("onboardingStep", "==", "complete")
        .where("lastInboundAt", "<", threeDaysAgo)
        .limit(500)
        .get();
    let sent = 0;
    for (const doc of snap.docs) {
        const phone = doc.id;
        const session = doc.data();
        if (session.optedOut)
            continue;
        if (session.optedIn === false)
            continue;
        if (session.bereavementMode)
            continue; // grief — don't nudge
        if (!session.chatId)
            continue;
        // Skip if we already nudged this phone in the past 7 days
        const lastNudgeAt = session.silenceNudgeSentAt;
        if (lastNudgeAt && lastNudgeAt > sevenDaysAgo)
            continue;
        // Skip very new accounts (<7 days) — they may just be quiet on purpose
        const createdAt = ((_a = session.createdAt) !== null && _a !== void 0 ? _a : "");
        if (!createdAt || createdAt > sevenDaysAgo)
            continue;
        // Don't nudge accounts that have been silent for over 30 days; those
        // should be handled by reactivation flow, not a casual check-in.
        const lastInbound = session.lastInboundAt;
        if (!lastInbound || lastInbound < thirtyDaysAgo)
            continue;
        try {
            // Generate a warm, varied check-in. Use Claude (via caraMessage) so
            // the message reads naturally — never the same template twice.
            const seniorName = ((_c = (_b = session.onboardingData) === null || _b === void 0 ? void 0 : _b.seniorName) !== null && _c !== void 0 ? _c : "");
            const seniorPart = seniorName ? ` and ${seniorName}` : "";
            const message = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `It's been a few days since this family last messaged you. Send a brief, warm check-in — NOT pushy, NOT a sales prompt. ` +
                    `Ask how they${seniorPart} are doing, or if anything's come up. Acknowledge it's been a bit. ` +
                    `One or two sentences max. No bullets, no questions about scheduling unless they bring it up.`,
                fallback: `Hey — it's been a few days. How's everything going${seniorPart}? I'm here whenever you need anything. 💙`,
                maxTokens: 80,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: message,
                urgency: "low",
                sourceAgent: "family_silence_checkin",
                canDrop: true, // DND respects this; nudge can be skipped if user is in quiet hours
            });
            await doc.ref.update({
                silenceNudgeSentAt: new Date().toISOString(),
                silenceNudgeCount: admin.firestore.FieldValue.increment(1),
            });
            sent++;
        }
        catch (err) {
            console.error("familySilenceCheckin error for", phone, err);
        }
    }
    console.log(`[familySilenceCheckin] ${snap.size} eligible sessions, ${sent} nudges sent`);
});
//# sourceMappingURL=familySilenceCheckin.js.map