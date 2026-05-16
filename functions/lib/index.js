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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.zepSetup = exports.runTriggerEngine = exports.consolidateMemoryNightly = exports.sendStaleSessionNudges = exports.sendMorningBriefings = exports.markTaskComplete = exports.refreshTransportBadge = exports.evaluateTransportBadges = exports.triggerHealthTrendsNow = exports.sendMonthlyHealthTrends = exports.triggerWeeklyDigestNow = exports.sendWeeklyDigests = exports.createFamilyGroup = exports.sendTestSMS = void 0;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions"));
// Initialize Admin globally if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}
// STRIPE FUNCTIONS - Payment processing for memberships
__exportStar(require("./stripe"), exports);
// CHECKR - Background check initiation + webhook
__exportStar(require("./checkr"), exports);
// Export Notification Functions
__exportStar(require("./notifications"), exports);
// Export Email Functions
__exportStar(require("./email"), exports);
// Export Push Notification Functions
__exportStar(require("./pushNotifications"), exports);
// CAREGIVER CALLOUT - emergency replacement when caregiver cancels
__exportStar(require("./caregiverCallout"), exports);
// Export SMS Functions
var sms_1 = require("./sms");
Object.defineProperty(exports, "sendTestSMS", { enumerable: true, get: function () { return sms_1.sendTestSMS; } });
// INSTANT PAYOUT
__exportStar(require("./instantPayout"), exports);
// STANDARD PAYOUT (free 2-3 day)
__exportStar(require("./standardPayout"), exports);
// STRIPE CONNECT (onboarding + account status)
__exportStar(require("./stripeConnect"), exports);
// STRIPE CONNECT WEBHOOK (account.updated → sync caregiver status)
__exportStar(require("./stripeConnectWebhook"), exports);
// Appointment lifecycle: mark `completed` when scheduled end passes
__exportStar(require("./appointmentCompletion"), exports);
// Export Care Coordinator Matching Functions
__exportStar(require("./matching"), exports);
// Export AI Matching Function
__exportStar(require("./aiMatching"), exports);
// Export Semantic AI Matching Triggers (background Gemini embeddings)
__exportStar(require("./triggers/aiMatchTriggers"), exports);
// Export Job Application Triggers (maintains JobPost.applicantCount)
__exportStar(require("./triggers/jobApplicationTriggers"), exports);
// Export per-shift hours submission / review / payment
__exportStar(require("./shiftHours"), exports);
// Export booking payment-method helpers
__exportStar(require("./paymentMethods"), exports);
// Linq iMessage agent — webhook + user onCreate trigger
__exportStar(require("./linq/webhooks"), exports);
__exportStar(require("./triggers/userCreated"), exports);
// Linq Sprint 2 — proactive care alerts + emergency replacement
__exportStar(require("./triggers/journalCreated"), exports);
__exportStar(require("./triggers/appointmentUpdated"), exports);
// Linq Sprint 3 — family group thread
var familyGroupManager_1 = require("./agents/familyGroupManager");
Object.defineProperty(exports, "createFamilyGroup", { enumerable: true, get: function () { return familyGroupManager_1.createFamilyGroup; } });
// Linq Sprint 4 — weekly digest + monthly health trends
var weeklyDigest_1 = require("./scheduled/weeklyDigest");
Object.defineProperty(exports, "sendWeeklyDigests", { enumerable: true, get: function () { return weeklyDigest_1.sendWeeklyDigests; } });
Object.defineProperty(exports, "triggerWeeklyDigestNow", { enumerable: true, get: function () { return weeklyDigest_1.triggerWeeklyDigestNow; } });
var healthTrends_1 = require("./scheduled/healthTrends");
Object.defineProperty(exports, "sendMonthlyHealthTrends", { enumerable: true, get: function () { return healthTrends_1.sendMonthlyHealthTrends; } });
Object.defineProperty(exports, "triggerHealthTrendsNow", { enumerable: true, get: function () { return healthTrends_1.triggerHealthTrendsNow; } });
// Transportation badge evaluation (daily) + on-demand refresh
var transportBadge_1 = require("./scheduled/transportBadge");
Object.defineProperty(exports, "evaluateTransportBadges", { enumerable: true, get: function () { return transportBadge_1.evaluateTransportBadges; } });
Object.defineProperty(exports, "refreshTransportBadge", { enumerable: true, get: function () { return transportBadge_1.refreshTransportBadge; } });
// Cara iMessage pivot — onboarding callables
var onboardingAgent_1 = require("./agents/onboardingAgent");
Object.defineProperty(exports, "markTaskComplete", { enumerable: true, get: function () { return onboardingAgent_1.markTaskComplete; } });
// Cara scheduled jobs
var morningBriefing_1 = require("./scheduled/morningBriefing");
Object.defineProperty(exports, "sendMorningBriefings", { enumerable: true, get: function () { return morningBriefing_1.sendMorningBriefings; } });
var staleSessionNudge_1 = require("./scheduled/staleSessionNudge");
Object.defineProperty(exports, "sendStaleSessionNudges", { enumerable: true, get: function () { return staleSessionNudge_1.sendStaleSessionNudges; } });
var nightlyMemory_1 = require("./scheduled/nightlyMemory");
Object.defineProperty(exports, "consolidateMemoryNightly", { enumerable: true, get: function () { return nightlyMemory_1.consolidateMemoryNightly; } });
// Proactive trigger engine (runs every 5 min)
var triggerEngine_1 = require("./triggers/triggerEngine");
Object.defineProperty(exports, "runTriggerEngine", { enumerable: true, get: function () { return triggerEngine_1.runTriggerEngine; } });
// ── One-time Zep setup: create context template + backfill existing users ─────
// Call once with header x-setup-key: cara-zep-setup-2026, then leave in place
// (subsequent calls are safe — already-initialized users are skipped)
exports.zepSetup = functions.https.onRequest(async (req, res) => {
    var _a, _b, _c;
    if (req.headers["x-setup-key"] !== "cara-zep-setup-2026") {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { createCaraContextTemplate, initializeZepOnFirstContact, pushOnboardingDataToZep, } = await Promise.resolve().then(() => __importStar(require("./memory/zepClient")));
    const db = admin.firestore();
    const results = {
        template: false, backfilled: 0, skipped: 0, errors: [],
    };
    // 1. Create eldercare context template
    try {
        await createCaraContextTemplate();
        results.template = true;
    }
    catch (err) {
        results.errors.push(`template: ${String(err)}`);
    }
    // 2. Backfill every session that lacks a zepThreadId
    const sessions = await db.collection("agent_sessions").get();
    for (const doc of sessions.docs) {
        const session = doc.data();
        const phone = doc.id;
        if (session.zepThreadId || session.optedOut) {
            results.skipped++;
            continue;
        }
        try {
            await initializeZepOnFirstContact(phone);
            results.backfilled++;
            // Push structured data for fully-onboarded clients
            const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
            if (session.userType === "client" && d.seniorName) {
                await pushOnboardingDataToZep({
                    phone,
                    firstName: ((_b = d.firstName) !== null && _b !== void 0 ? _b : ""),
                    seniorName: ((_c = d.seniorName) !== null && _c !== void 0 ? _c : ""),
                    seniorAge: d.age ? Number(d.age) : undefined,
                    conditions: Array.isArray(d.conditions) ? d.conditions : undefined,
                    careNeeds: Array.isArray(d.careNeeds) ? d.careNeeds : undefined,
                    city: d.city,
                    relationship: d.relationship,
                    daysPerWeek: d.daysPerWeek ? Number(d.daysPerWeek) : undefined,
                    timeOfDay: d.timeOfDay,
                });
            }
        }
        catch (err) {
            results.errors.push(`${phone}: ${String(err)}`);
        }
    }
    res.json(results);
});
//# sourceMappingURL=index.js.map