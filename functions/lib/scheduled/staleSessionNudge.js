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
exports.sendStaleSessionNudges = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const db = admin.firestore();
// Runs daily at 10 AM PT (17:00 UTC)
exports.sendStaleSessionNudges = functions.pubsub
    .schedule("0 17 * * *")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const now = Date.now();
    const fortyEightHoursAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const seventyTwoHoursAgo = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    // ── Auto-recover sessions stuck waiting for a webhook for 7+ days ─────────
    const WEBHOOK_AWAITING_STEPS = [
        "caregiver_awaiting_bgcheck",
        "caregiver_awaiting_stripe",
        "caregiver_awaiting_membership",
        "caregiver_awaiting_photo",
        "caregiver_awaiting_documents",
        "client_awaiting_payment",
        "client_awaiting_identity",
    ];
    const stuckSnap = await db.collection("agent_sessions")
        .where("onboardingStep", "in", WEBHOOK_AWAITING_STEPS)
        .get();
    for (const doc of stuckSnap.docs) {
        const session = doc.data();
        if (session.optedOut)
            continue;
        // Only recover sessions stuck > 7 days
        const updatedAt = ((_b = (_a = session.updatedAt) !== null && _a !== void 0 ? _a : session.createdAt) !== null && _b !== void 0 ? _b : "");
        if (!updatedAt || updatedAt > sevenDaysAgo)
            continue;
        // Idempotency: don't re-send more than once per 7 days
        if (session.stuckRecoverySentAt && session.stuckRecoverySentAt > sevenDaysAgo)
            continue;
        try {
            const { resendStuckStep } = await Promise.resolve().then(() => __importStar(require("../agents/onboardingConversation")));
            const sent = await resendStuckStep(doc.id);
            if (sent) {
                await doc.ref.update({ stuckRecoverySentAt: new Date().toISOString() });
                console.log(`[staleSessionNudge] Re-sent stuck step for ${doc.id} (step: ${session.onboardingStep})`);
            }
        }
        catch (err) {
            console.error(`[staleSessionNudge] resendStuckStep failed for ${doc.id}:`, err);
        }
    }
    // Sessions that started onboarding but never completed
    const snap = await db.collection("agent_sessions")
        .where("onboardingStep", "!=", "complete")
        .get();
    for (const doc of snap.docs) {
        const session = doc.data();
        // Skip opted-out users
        if (session.optedOut)
            continue;
        // Must be older than 48h (stale)
        if (!session.createdAt || session.createdAt > fortyEightHoursAgo)
            continue;
        // Don't nudge again within 72h of last nudge
        if (session.nudgeSentAt && session.nudgeSentAt > seventyTwoHoursAgo)
            continue;
        // Cap at 2 nudges total
        if (((_c = session.nudgeCount) !== null && _c !== void 0 ? _c : 0) >= 2)
            continue;
        if (!session.chatId)
            continue;
        try {
            const step = (_d = session.onboardingStep) !== null && _d !== void 0 ? _d : "ask_role";
            const firstName = ((_h = (_f = (_e = session.onboardingData) === null || _e === void 0 ? void 0 : _e.firstName) !== null && _f !== void 0 ? _f : (_g = session.onboardingData) === null || _g === void 0 ? void 0 : _g.name) !== null && _h !== void 0 ? _h : "");
            const greeting = firstName ? `Hey ${firstName}!` : "Hey there!";
            const userType = session.userType;
            let message;
            if (!userType || step === "ask_role") {
                message =
                    `Hi${firstName ? ` ${firstName}` : ""}, still thinking about care?\n\n` +
                        `Just reply when you're ready:\n\n` +
                        `1️⃣ I need care for someone\n` +
                        `2️⃣ I'm a caregiver`;
            }
            else if (userType === "caregiver") {
                if (step === "caregiver_send_bgcheck" || step === "caregiver_awaiting_bgcheck") {
                    message =
                        `${greeting} Your background check is the last step before you can start getting booked.\n\n` +
                            `Families can't book you until it's done. It takes about 5 minutes. ` +
                            `Reply here and I'll send the link again.`;
                }
                else if (step === "caregiver_ask_rate") {
                    message =
                        `${greeting} Still thinking about your hourly rate?\n\n` +
                            `Most caregivers on Cara charge $18-28/hr. ` +
                            `You can always update it later. No pressure to get it perfect now.`;
                }
                else if (step === "caregiver_send_photo" || step === "caregiver_awaiting_photo") {
                    message =
                        `${greeting} Your profile is almost live.\n\n` +
                            `Adding a photo makes families much more likely to request an interview. ` +
                            `A clear headshot is all you need. Reply here and I'll send the link again.`;
                }
                else if (step === "caregiver_send_membership" || step === "caregiver_awaiting_membership") {
                    message =
                        `${greeting} You're one step from being able to apply to jobs near you.\n\n` +
                            `Activating your $24.95/year membership unlocks getting booked and Cara's payout tools. ` +
                            `Reply here and I'll send the link again.`;
                }
                else if (step === "caregiver_send_documents" || step === "caregiver_awaiting_documents") {
                    message =
                        `${greeting} Almost done — just your certifications left (CNA, CPR, etc.).\n\n` +
                            `You can upload them now or reply SKIP to keep going. ` +
                            `Reply here and I'll send the upload link again.`;
                }
                else {
                    message =
                        `${greeting} Your caregiver profile is almost done.\n\n` +
                            `Reply here whenever you're ready to continue.`;
                }
            }
            else {
                if (step === "client_send_payment" || step === "client_awaiting_payment") {
                    message =
                        `${greeting} The last step is adding a payment method so caregivers can get paid after each visit.\n\n` +
                            `Takes about 30 seconds. No charges until you book a caregiver.`;
                }
                else if (step === "client_awaiting_identity") {
                    message =
                        `${greeting} Just one quick identity check left — it's a 30-second step that keeps every family on the platform safe.\n\n` +
                            `Reply here and I'll send you a fresh link.`;
                }
                else if (step === "client_ask_schedule") {
                    message =
                        `${greeting} Almost there. Just need to know how often you need care ` +
                            `and I'll start searching for caregivers.`;
                }
                else {
                    message =
                        `${greeting} I'm here whenever you're ready to continue.\n\n` +
                            `Just reply and I'll pick up where we left off.`;
                }
            }
            await (0, caraAgent_1.sendViaInteractionAgent)(doc.id, {
                content: message,
                urgency: "low",
                sourceAgent: "stale_nudge",
                canDrop: true,
            });
            await doc.ref.update({
                nudgeSentAt: new Date().toISOString(),
                nudgeCount: admin.firestore.FieldValue.increment(1),
            });
        }
        catch (err) {
            console.error("staleSessionNudge error for", doc.id, err);
        }
    }
});
//# sourceMappingURL=staleSessionNudge.js.map