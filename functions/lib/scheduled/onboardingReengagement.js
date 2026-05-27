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
exports.sendOnboardingReengagement = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
/**
 * Daily re-engagement nudge for caregivers who stalled mid-onboarding.
 *
 * Target: agent_sessions where userType="caregiver", onboardingStep ≠ "complete",
 * and lastInboundAt is between 24h and 14 days ago. Caps at one nudge per 72h
 * per caregiver via `lastReengagementNudgeAt` to avoid pestering.
 *
 * The companion stale-session checkpoint logic in webhooks.ts already handles
 * RESUME/START OVER replies; this job's job is just to remind them to come back.
 */
exports.sendOnboardingReengagement = functions.pubsub
    .schedule("0 18 * * *") // 10am PT = 18:00 UTC daily
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
    var _a, _b, _c;
    const now = Date.now();
    const twentyFourHrAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const fourteenDayAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const seventyTwoHrAgo = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    // We can't compound-filter on userType + onboardingStep + lastInboundAt without
    // a composite index. Filter on userType and let in-loop checks handle the rest.
    const sessionsSnap = await db.collection("agent_sessions")
        .where("userType", "==", "caregiver")
        .get();
    if (sessionsSnap.empty) {
        console.log("[onboardingReengagement] No caregiver sessions found.");
        return;
    }
    let nudgesSent = 0;
    let skipped = 0;
    for (const sessionDoc of sessionsSnap.docs) {
        const session = sessionDoc.data();
        const phone = sessionDoc.id;
        try {
            const onboardingStep = session.onboardingStep;
            if (!onboardingStep || onboardingStep === "complete") {
                skipped++;
                continue;
            }
            // Skip if opted out or no chatId
            if (session.optedOut === true) {
                skipped++;
                continue;
            }
            if (!session.chatId) {
                skipped++;
                continue;
            }
            const lastInboundAt = session.lastInboundAt;
            if (!lastInboundAt) {
                skipped++;
                continue;
            }
            // Must be stale (>= 24h) but not abandoned (< 14d)
            if (lastInboundAt > twentyFourHrAgo) {
                skipped++;
                continue;
            }
            if (lastInboundAt < fourteenDayAgo) {
                skipped++;
                continue;
            }
            // Throttle: one nudge per 72h
            const lastNudge = session.lastReengagementNudgeAt;
            if (lastNudge && lastNudge > seventyTwoHrAgo) {
                skipped++;
                continue;
            }
            const onboardingData = ((_a = session.onboardingData) !== null && _a !== void 0 ? _a : {});
            const firstName = ((_c = (_b = onboardingData.name) !== null && _b !== void 0 ? _b : onboardingData.firstName) !== null && _c !== void 0 ? _c : "there");
            const stepLabel = humanLabelForStep(onboardingStep);
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: `Caregiver first name: ${firstName.split(" ")[0]}. ` +
                    `They started signing up but stalled at: "${stepLabel}". ` +
                    "Send a short warm reminder (1-2 sentences) inviting them to pick up where they left off. " +
                    "Mention that they're close to being able to take jobs. Don't be pushy.",
                fallback: `Hey ${firstName.split(" ")[0]}, you're just a step or two away from being able to take jobs on CareConnex. ` +
                    `Want to pick up where you left off? Reply RESUME to continue.`,
                maxTokens: 100,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: msg,
                urgency: "low",
                sourceAgent: "onboarding_reengagement",
                canDrop: true,
            }).catch(() => { });
            await sessionDoc.ref.update({
                lastReengagementNudgeAt: new Date().toISOString(),
            });
            nudgesSent++;
            console.log(`[onboardingReengagement] Nudged ${phone} (step: ${onboardingStep})`);
        }
        catch (err) {
            console.error(`[onboardingReengagement] Error for session ${phone}:`, err);
        }
    }
    console.log(`[onboardingReengagement] Done. Nudges sent: ${nudgesSent}, skipped: ${skipped}`);
});
function humanLabelForStep(step) {
    var _a;
    const map = {
        verify_phone: "verifying your phone number",
        ask_role: "picking a role",
        caregiver_ask_name: "sharing your name",
        caregiver_ask_location: "telling me your city",
        caregiver_ask_experience: "sharing your experience",
        caregiver_ask_specialties: "listing your specialties",
        caregiver_ask_availability: "sharing your availability",
        caregiver_ask_job_type: "choosing job type",
        caregiver_ask_rate: "setting your rate",
        caregiver_ask_email: "sharing your email",
        caregiver_ask_bio: "writing your bio",
        caregiver_send_photo: "uploading your photo",
        caregiver_awaiting_photo: "uploading your photo",
        caregiver_send_documents: "uploading certifications",
        caregiver_awaiting_documents: "uploading certifications",
        caregiver_ask_mvr: "the MVR question",
        caregiver_send_membership: "completing your membership payment",
        caregiver_awaiting_membership: "completing your membership payment",
        caregiver_send_bgcheck: "starting your background check",
        caregiver_awaiting_bgcheck: "finishing your background check",
        caregiver_send_stripe_connect: "setting up your payout account",
        caregiver_awaiting_stripe: "setting up your payout account",
    };
    return (_a = map[step]) !== null && _a !== void 0 ? _a : "finishing your profile";
}
//# sourceMappingURL=onboardingReengagement.js.map