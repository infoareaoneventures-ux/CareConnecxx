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
exports.checkBackgroundCheckExpiry = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
// Background checks expire after 2 years (730 days).
// Warning window: 23–24 months old (30-day warning before expiry).
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const TWENTY_THREE_MONTHS_MS = (23 * 30 + 15) * 24 * 60 * 60 * 1000; // ~23.5 months — start of warning window
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
exports.checkBackgroundCheckExpiry = functions.pubsub
    .schedule("0 16 * * *") // 8am PT = 16:00 UTC daily
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
    var _a, _b, _c;
    const now = Date.now();
    const thirtyDaysAgoTs = new Date(now - THIRTY_DAYS_MS).toISOString();
    const caregiversSnap = await db.collection("caregivers")
        .where("status", "==", "active")
        .where("backgroundCheckData.status", "==", "clear")
        .get();
    if (caregiversSnap.empty) {
        console.log("[backgroundCheckExpiry] No active caregivers with clear background checks.");
        return;
    }
    let expiredCount = 0;
    let warningCount = 0;
    for (const cgDoc of caregiversSnap.docs) {
        const cg = cgDoc.data();
        const cgId = cgDoc.id;
        const bgCheckData = cg.backgroundCheckData;
        const completedAtRaw = bgCheckData === null || bgCheckData === void 0 ? void 0 : bgCheckData.completedAt;
        const caregiverName = ((_a = cg.name) !== null && _a !== void 0 ? _a : `${(_b = cg.firstName) !== null && _b !== void 0 ? _b : ""} ${(_c = cg.lastName) !== null && _c !== void 0 ? _c : ""}`.trim()) || "Unknown";
        // Skip if no completedAt date
        if (!completedAtRaw)
            continue;
        const completedAtMs = new Date(completedAtRaw).getTime();
        if (isNaN(completedAtMs))
            continue;
        const ageMs = now - completedAtMs;
        // Skip checks under 23 months old — not in any action window yet
        if (ageMs < TWENTY_THREE_MONTHS_MS)
            continue;
        const expiryDate = new Date(completedAtMs + TWO_YEARS_MS).toISOString();
        // Guard: de-dup nudges — skip if a nudge was sent within the last 30 days
        const lastNudge = cg.bgCheckExpiryNudgeSentAt;
        const nudgeCooledDown = !lastNudge || lastNudge < thirtyDaysAgoTs;
        try {
            // ── Expired (>= 2 years old) ─────────────────────────────────────────
            if (ageMs >= TWO_YEARS_MS) {
                // Mark the background check as expired on the caregiver doc
                await cgDoc.ref.update({
                    "backgroundCheckData.backgroundCheckStatus": "expired",
                });
                // Write admin alert (gated by same 30-day nudge field to avoid duplicate alerts)
                if (nudgeCooledDown) {
                    await db.collection("admin_alerts").add({
                        type: "background_check_expired",
                        caregiverId: cgId,
                        caregiverName,
                        expiryDate,
                        createdAt: new Date().toISOString(),
                        resolved: false,
                        priority: "high",
                    });
                    // Send caregiver message
                    const cgSessionSnap = await db.collection("agent_sessions")
                        .where("userId", "==", cgId)
                        .limit(1)
                        .get();
                    if (!cgSessionSnap.empty) {
                        const cgPhone = cgSessionSnap.docs[0].id;
                        const expiredMsg = await (0, caraMessage_1.generateCaraMessage)({
                            audience: "caregiver",
                            context: "A caregiver's background check has expired. Let them know clearly that new bookings are paused until it's renewed. " +
                                "Tell them to reply RENEW and you'll send them a new link. " +
                                "Be direct but not harsh — explain the situation matter-of-factly.",
                            fallback: "Your background check has expired. New bookings are paused until it's renewed. " +
                                "Reply RENEW and I'll send you a new link.",
                            maxTokens: 80,
                        });
                        await (0, caraAgent_1.sendViaInteractionAgent)(cgPhone, {
                            content: expiredMsg,
                            urgency: "standard",
                            sourceAgent: "bg_check_expiry",
                            canDrop: false,
                        });
                        await cgDoc.ref.update({
                            bgCheckExpiryNudgeSentAt: new Date().toISOString(),
                        });
                    }
                    expiredCount++;
                    console.log(`[backgroundCheckExpiry] Background check expired for caregiver ${cgId}`);
                }
                // ── Expiring soon (23–24 months old, ~30-day warning window) ─────────
            }
            else if (ageMs >= TWENTY_THREE_MONTHS_MS) {
                if (nudgeCooledDown) {
                    await db.collection("admin_alerts").add({
                        type: "background_check_expiring_soon",
                        caregiverId: cgId,
                        caregiverName,
                        expiryDate,
                        createdAt: new Date().toISOString(),
                        resolved: false,
                        priority: "medium",
                    });
                    const cgSessionSnap = await db.collection("agent_sessions")
                        .where("userId", "==", cgId)
                        .limit(1)
                        .get();
                    if (!cgSessionSnap.empty) {
                        const cgPhone = cgSessionSnap.docs[0].id;
                        const expiringMsg = await (0, caraMessage_1.generateCaraMessage)({
                            audience: "caregiver",
                            context: "A caregiver's background check expires in about 30 days. Give them a heads-up and let them know they should reply RENEW to stay verified and keep getting booked. " +
                                "Keep the tone proactive and encouraging, not urgent or scary.",
                            fallback: "Your background check expires in about 30 days. " +
                                "Reply RENEW to stay verified and keep getting booked.",
                            maxTokens: 80,
                        });
                        await (0, caraAgent_1.sendViaInteractionAgent)(cgPhone, {
                            content: expiringMsg,
                            urgency: "standard",
                            sourceAgent: "bg_check_expiry",
                            canDrop: false,
                        });
                        await cgDoc.ref.update({
                            bgCheckExpiryNudgeSentAt: new Date().toISOString(),
                        });
                    }
                    warningCount++;
                    console.log(`[backgroundCheckExpiry] 30-day expiry warning for caregiver ${cgId}`);
                }
            }
        }
        catch (err) {
            console.error(`[backgroundCheckExpiry] Error processing caregiver ${cgId}:`, err);
        }
    }
    console.log(`[backgroundCheckExpiry] Done. Expired: ${expiredCount}, expiring-soon warnings: ${warningCount}`);
});
//# sourceMappingURL=backgroundCheckExpiry.js.map