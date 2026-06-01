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
exports.sendPaywallWinback = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
/**
 * Daily win-back for families who hit the subscription paywall but didn't
 * subscribe. The web gate (`useAccessGates`) stamps `lastPaywallViewedAt` and
 * `paywallContext` (the caregiver they tried to reach) on the user doc when the
 * PlanSelectModal opens. This job nudges those who are still unconverted.
 *
 * Targets users where:
 *   - lastPaywallViewedAt is between 24h and 7d ago (intent is hot but cooling)
 *   - they are NOT subscribed (subscriptionActive falsy, membership not active/trialing)
 *   - we haven't already win-backed them in the last 72h
 *
 * Channel reuses the existing Cara SMS infra: we resolve the family's phone the
 * same way the billing flow does (agent_sessions where userId == uid), so this
 * only reaches families who onboarded via Cara and aren't opted out.
 */
exports.sendPaywallWinback = functions.pubsub
    .schedule("0 18 * * *") // 10am PT = 18:00 UTC daily
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
    var _a, _b, _c;
    const now = Date.now();
    const twentyFourHrAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const sevenDayAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const seventyTwoHrAgo = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    // Only users who have ever seen the paywall are candidates.
    const usersSnap = await db
        .collection("users")
        .where("lastPaywallViewedAt", ">=", sevenDayAgo)
        .get();
    if (usersSnap.empty) {
        console.log("[paywallWinback] No recent paywall views.");
        return;
    }
    let nudgesSent = 0;
    let skipped = 0;
    for (const userDoc of usersSnap.docs) {
        const user = userDoc.data();
        const uid = userDoc.id;
        try {
            const viewedAt = user.lastPaywallViewedAt;
            if (!viewedAt) {
                skipped++;
                continue;
            }
            // Hot-but-cooling window: stale enough to need a nudge, recent enough to care.
            if (viewedAt > twentyFourHrAgo) {
                skipped++;
                continue;
            }
            if (viewedAt < sevenDayAgo) {
                skipped++;
                continue;
            }
            // Already converted — never nudge a paying member.
            const isSubscribed = !!user.subscriptionActive
                || user.membershipStatus === "active"
                || user.membershipStatus === "trialing";
            if (isSubscribed) {
                skipped++;
                continue;
            }
            // Throttle: one win-back per 72h.
            const lastWinback = user.lastPaywallWinbackAt;
            if (lastWinback && lastWinback > seventyTwoHrAgo) {
                skipped++;
                continue;
            }
            // Resolve the family's phone the same way billing does.
            const sessionSnap = await db
                .collection("agent_sessions")
                .where("userId", "==", uid)
                .where("optedOut", "==", false)
                .limit(1)
                .get();
            if (sessionSnap.empty) {
                skipped++;
                continue;
            }
            const phone = sessionSnap.docs[0].id;
            const ctx = ((_a = user.paywallContext) !== null && _a !== void 0 ? _a : {});
            const caregiverName = ctx.caregiverName || "";
            const firstName = ((_c = (_b = user.name) !== null && _b !== void 0 ? _b : user.displayName) !== null && _c !== void 0 ? _c : "there").split(" ")[0];
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Family member first name: ${firstName}. ` +
                    (caregiverName
                        ? `They looked at subscribing so they could reach ${caregiverName}, a caregiver they matched with, but didn't finish. `
                        : "They looked at subscribing to contact their caregiver matches but didn't finish. ") +
                    "Send a short, warm reminder (1-2 sentences) that their match is still available and a CareConnex " +
                    "membership lets them message, interview, and book. Don't be pushy or salesy.",
                fallback: caregiverName
                    ? `Hi ${firstName}, ${caregiverName} is still available on CareConnex. ` +
                        `A membership lets you message and book them whenever you're ready — just head back to your dashboard.`
                    : `Hi ${firstName}, your caregiver matches are still waiting on CareConnex. ` +
                        `A membership lets you message and book them whenever you're ready — just head back to your dashboard.`,
                maxTokens: 100,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: msg,
                urgency: "low",
                sourceAgent: "paywall_winback",
                canDrop: true,
            }).catch(() => { });
            await userDoc.ref.update({
                lastPaywallWinbackAt: new Date().toISOString(),
            });
            nudgesSent++;
            console.log(`[paywallWinback] Nudged ${uid} (caregiver: ${caregiverName || "n/a"})`);
        }
        catch (err) {
            console.error(`[paywallWinback] Error for user ${uid}:`, err);
        }
    }
    console.log(`[paywallWinback] Done. Nudges sent: ${nudgesSent}, skipped: ${skipped}`);
});
//# sourceMappingURL=paywallWinback.js.map