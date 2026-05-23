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
exports.zepSetup = exports.chatWithCara = exports.initiateCara = exports.send1099Notifications = exports.submitGpsCheckin = exports.sendJobMatchNotifications = exports.getMatchPatterns = exports.aiProxy = exports.onRefundRequestWrite = exports.checkDisputeSLAs = exports.onDisputeCreated = exports.onAdminAlertCreated = exports.getAlertStats = exports.resolveAdminAlert = exports.listAdminAlerts = exports.runTriggerEngine = exports.wellbeingCheckinJob = exports.checkBackgroundCheckExpiry = exports.checkCaregiverInactivity = exports.expirePostVisitFeedback = exports.processDndQueue = exports.sendThirtyMinShiftReminders = exports.sendDayBeforeShiftReminders = exports.sendPreShiftFamilyCheckin = exports.sendShiftTaskNudges = exports.upcomingVisitReminder = exports.extendRecurringSchedules = exports.consolidateMemoryNightly = exports.familySilenceCheckinJob = exports.sendStaleSessionNudges = exports.sendMorningBriefings = exports.dailyContactCardShare = exports.markTaskComplete = exports.onBookingAccepted = exports.generateRollingShifts = exports.refreshTransportBadge = exports.evaluateTransportBadges = exports.runNoVisitCheck = exports.triggerHealthTrendsNow = exports.sendMonthlyHealthTrends = exports.triggerWeeklyDigestNow = exports.sendWeeklyDigests = exports.createFamilyGroup = exports.triggerFamilyEmergency = exports.onCheckinCreated = exports.sendTestSMS = void 0;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions"));
// Initialize Admin globally if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}
// BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, CREDENTIAL_VAULT_KEY are injected
// via Firebase Secret Manager on linqWebhook (runWith secrets). Locally, load from .env.
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
// Linq management utilities are imported by other modules — not exposed as Cloud Functions
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
__exportStar(require("./triggers/appointmentUpdated"), exports);
var checkinAlert_1 = require("./triggers/checkinAlert");
Object.defineProperty(exports, "onCheckinCreated", { enumerable: true, get: function () { return checkinAlert_1.onCheckinCreated; } });
var familyEmergency_1 = require("./triggers/familyEmergency");
Object.defineProperty(exports, "triggerFamilyEmergency", { enumerable: true, get: function () { return familyEmergency_1.triggerFamilyEmergency; } });
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
// Linq proactive — no-visit check-in (daily 9am ET)
var noVisitCheck_1 = require("./scheduled/noVisitCheck");
Object.defineProperty(exports, "runNoVisitCheck", { enumerable: true, get: function () { return noVisitCheck_1.runNoVisitCheck; } });
// Transportation badge evaluation (daily) + on-demand refresh
var transportBadge_1 = require("./scheduled/transportBadge");
Object.defineProperty(exports, "evaluateTransportBadges", { enumerable: true, get: function () { return transportBadge_1.evaluateTransportBadges; } });
Object.defineProperty(exports, "refreshTransportBadge", { enumerable: true, get: function () { return transportBadge_1.refreshTransportBadge; } });
// Shift generation: instant on acceptance + daily rolling window
var shiftGenerator_1 = require("./scheduled/shiftGenerator");
Object.defineProperty(exports, "generateRollingShifts", { enumerable: true, get: function () { return shiftGenerator_1.generateRollingShifts; } });
Object.defineProperty(exports, "onBookingAccepted", { enumerable: true, get: function () { return shiftGenerator_1.onBookingAccepted; } });
// Cara iMessage pivot — onboarding callables
var onboardingAgent_1 = require("./agents/onboardingAgent");
Object.defineProperty(exports, "markTaskComplete", { enumerable: true, get: function () { return onboardingAgent_1.markTaskComplete; } });
// Cara scheduled jobs
var dailyContactCardShare_1 = require("./scheduled/dailyContactCardShare");
Object.defineProperty(exports, "dailyContactCardShare", { enumerable: true, get: function () { return dailyContactCardShare_1.dailyContactCardShare; } });
var morningBriefing_1 = require("./scheduled/morningBriefing");
Object.defineProperty(exports, "sendMorningBriefings", { enumerable: true, get: function () { return morningBriefing_1.sendMorningBriefings; } });
var staleSessionNudge_1 = require("./scheduled/staleSessionNudge");
Object.defineProperty(exports, "sendStaleSessionNudges", { enumerable: true, get: function () { return staleSessionNudge_1.sendStaleSessionNudges; } });
var familySilenceCheckin_1 = require("./scheduled/familySilenceCheckin");
Object.defineProperty(exports, "familySilenceCheckinJob", { enumerable: true, get: function () { return familySilenceCheckin_1.familySilenceCheckinJob; } });
var nightlyMemory_1 = require("./scheduled/nightlyMemory");
Object.defineProperty(exports, "consolidateMemoryNightly", { enumerable: true, get: function () { return nightlyMemory_1.consolidateMemoryNightly; } });
var recurringScheduler_1 = require("./scheduled/recurringScheduler");
Object.defineProperty(exports, "extendRecurringSchedules", { enumerable: true, get: function () { return recurringScheduler_1.extendRecurringSchedules; } });
var upcomingVisitReminder_1 = require("./scheduled/upcomingVisitReminder");
Object.defineProperty(exports, "upcomingVisitReminder", { enumerable: true, get: function () { return upcomingVisitReminder_1.upcomingVisitReminder; } });
var shiftTaskNudges_1 = require("./scheduled/shiftTaskNudges");
Object.defineProperty(exports, "sendShiftTaskNudges", { enumerable: true, get: function () { return shiftTaskNudges_1.sendShiftTaskNudges; } });
var preShiftFamilyCheckin_1 = require("./scheduled/preShiftFamilyCheckin");
Object.defineProperty(exports, "sendPreShiftFamilyCheckin", { enumerable: true, get: function () { return preShiftFamilyCheckin_1.sendPreShiftFamilyCheckin; } });
var dayBeforeShiftReminder_1 = require("./scheduled/dayBeforeShiftReminder");
Object.defineProperty(exports, "sendDayBeforeShiftReminders", { enumerable: true, get: function () { return dayBeforeShiftReminder_1.sendDayBeforeShiftReminders; } });
var thirtyMinShiftReminder_1 = require("./scheduled/thirtyMinShiftReminder");
Object.defineProperty(exports, "sendThirtyMinShiftReminders", { enumerable: true, get: function () { return thirtyMinShiftReminder_1.sendThirtyMinShiftReminders; } });
var dndQueueProcessor_1 = require("./scheduled/dndQueueProcessor");
Object.defineProperty(exports, "processDndQueue", { enumerable: true, get: function () { return dndQueueProcessor_1.processDndQueue; } });
var feedbackExpiry_1 = require("./scheduled/feedbackExpiry");
Object.defineProperty(exports, "expirePostVisitFeedback", { enumerable: true, get: function () { return feedbackExpiry_1.expirePostVisitFeedback; } });
var caregiverInactivityCheck_1 = require("./scheduled/caregiverInactivityCheck");
Object.defineProperty(exports, "checkCaregiverInactivity", { enumerable: true, get: function () { return caregiverInactivityCheck_1.checkCaregiverInactivity; } });
var backgroundCheckExpiry_1 = require("./scheduled/backgroundCheckExpiry");
Object.defineProperty(exports, "checkBackgroundCheckExpiry", { enumerable: true, get: function () { return backgroundCheckExpiry_1.checkBackgroundCheckExpiry; } });
var wellbeingCheckin_1 = require("./scheduled/wellbeingCheckin");
Object.defineProperty(exports, "wellbeingCheckinJob", { enumerable: true, get: function () { return wellbeingCheckin_1.wellbeingCheckinJob; } });
// Proactive trigger engine (runs every 5 min)
var triggerEngine_1 = require("./triggers/triggerEngine");
Object.defineProperty(exports, "runTriggerEngine", { enumerable: true, get: function () { return triggerEngine_1.runTriggerEngine; } });
// Admin alerts API (list, resolve, stats)
var adminAlerts_1 = require("./adminAlerts");
Object.defineProperty(exports, "listAdminAlerts", { enumerable: true, get: function () { return adminAlerts_1.listAdminAlerts; } });
Object.defineProperty(exports, "resolveAdminAlert", { enumerable: true, get: function () { return adminAlerts_1.resolveAdminAlert; } });
Object.defineProperty(exports, "getAlertStats", { enumerable: true, get: function () { return adminAlerts_1.getAlertStats; } });
// Admin alert email notifier (Firestore trigger → admin_email_queue)
var adminAlertNotifier_1 = require("./triggers/adminAlertNotifier");
Object.defineProperty(exports, "onAdminAlertCreated", { enumerable: true, get: function () { return adminAlertNotifier_1.onAdminAlertCreated; } });
// Dispute resolution (Firestore trigger + hourly SLA check)
var disputeResolution_1 = require("./triggers/disputeResolution");
Object.defineProperty(exports, "onDisputeCreated", { enumerable: true, get: function () { return disputeResolution_1.onDisputeCreated; } });
Object.defineProperty(exports, "checkDisputeSLAs", { enumerable: true, get: function () { return disputeResolution_1.checkDisputeSLAs; } });
// Refund auto-processing (executes Stripe refund when status → "approved")
var refundProcessor_1 = require("./triggers/refundProcessor");
Object.defineProperty(exports, "onRefundRequestWrite", { enumerable: true, get: function () { return refundProcessor_1.onRefundRequestWrite; } });
// CARE PLAN HISTORY trigger (saves version on every care plan write)
__exportStar(require("./triggers/carePlanHistory"), exports);
// AI proxy — secure server-side Anthropic calls (auth-gated, rate-limited)
var aiProxy_1 = require("./aiProxy");
Object.defineProperty(exports, "aiProxy", { enumerable: true, get: function () { return aiProxy_1.aiProxy; } });
// MATCH PATTERNS — returns aggregated hire/reject outcome data for frontend Claude prompts
exports.getMatchPatterns = functions.https.onCall(async (_data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const db = admin.firestore();
    const { getOutcomePatternSummary } = await Promise.resolve().then(() => __importStar(require("./ai/outcomeAnalytics")));
    const patterns = await getOutcomePatternSummary(db);
    return { patterns };
});
// JOB MATCH NOTIFICATIONS (daily 10am — texts caregivers about high-match new jobs)
var jobMatchNotifications_1 = require("./scheduled/jobMatchNotifications");
Object.defineProperty(exports, "sendJobMatchNotifications", { enumerable: true, get: function () { return jobMatchNotifications_1.sendJobMatchNotifications; } });
// GPS CHECK-IN (callable — validates caregiver arrival within 200m, notifies family)
var gpsCheckin_1 = require("./agents/gpsCheckin");
Object.defineProperty(exports, "submitGpsCheckin", { enumerable: true, get: function () { return gpsCheckin_1.submitGpsCheckin; } });
// 1099 TAX NOTIFICATIONS (Jan 31 — notifies eligible caregivers of earnings summary)
var taxReminder_1 = require("./scheduled/taxReminder");
Object.defineProperty(exports, "send1099Notifications", { enumerable: true, get: function () { return taxReminder_1.send1099Notifications; } });
// MULTI-SENIOR MIGRATION — run once via HTTP with x-admin-secret header
__exportStar(require("./migrations/migrateSeniorsToHousehold"), exports);
// ── initiateCara — unauthenticated callable: proactively sends Cara's greeting ──
// Called from the web "Continue with Phone" screen so desktop users receive an
// outbound SMS rather than relying on the sms: URI (which silently fails on desktop).
exports.initiateCara = functions.https.onCall(async (data) => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const phone = (_a = data.phone) === null || _a === void 0 ? void 0 : _a.trim();
    const role = data.role === "caregiver" ? "caregiver" : "client";
    // Basic E.164 validation (US/CA +1 only for now)
    if (!phone || !/^\+1\d{10}$/.test(phone)) {
        throw new functions.https.HttpsError("invalid-argument", "A valid US/CA phone number is required.");
    }
    const { sendMessage, createChat, getOrCreateSession } = await Promise.resolve().then(() => __importStar(require("./linq/client")));
    const db = admin.firestore();
    const sessionRef = db.collection("agent_sessions").doc(phone);
    const sessionSnap = await sessionRef.get();
    if (sessionSnap.exists) {
        const existing = sessionSnap.data();
        // If the session has userId, it's a known user — try sending to the existing chatId.
        // This avoids creating a new Linq chat (which is slow and can hang).
        // If the existing chatId is stale, the send will fail fast (15s timeout added to axios).
        if (existing.userId && existing.chatId) {
            const greeting = "Hi! I'm Cara, your care assistant. I'm here whenever you need help with your care.";
            const sent = await sendMessage(existing.chatId, greeting).then(() => true).catch(() => false);
            if (!sent) {
                // Existing chatId is stale — open a fresh Linq thread.
                const { chat_id } = await createChat(phone, {
                    parts: [{ type: "text", value: greeting }],
                });
                await sessionRef.update({ chatId: chat_id });
            }
        }
        else {
            // Session exists but is missing userId — restore from users collection.
            const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
            if (!userQuery.empty) {
                const userDoc = userQuery.docs[0];
                const userData = userDoc.data();
                const userId = userDoc.id;
                const seniorIds = (_b = userData.seniorIds) !== null && _b !== void 0 ? _b : [];
                const seniorId = (_d = (_c = userData.seniorId) !== null && _c !== void 0 ? _c : seniorIds[0]) !== null && _d !== void 0 ? _d : "";
                const greeting = "Hi! I'm Cara, your care assistant. I'm here whenever you need help.";
                // Try sending to current chatId; open fresh chat if it fails.
                const chatId = existing.chatId;
                let finalChatId = chatId !== null && chatId !== void 0 ? chatId : "";
                if (chatId) {
                    const sent = await sendMessage(chatId, greeting).then(() => true).catch(() => false);
                    if (!sent) {
                        const { chat_id } = await createChat(phone, { parts: [{ type: "text", value: greeting }] });
                        finalChatId = chat_id;
                    }
                }
                else {
                    const { chat_id } = await createChat(phone, { parts: [{ type: "text", value: greeting }] });
                    finalChatId = chat_id;
                }
                await sessionRef.update({
                    chatId: finalChatId,
                    userId,
                    seniorId,
                    onboardingStep: "complete",
                    userType: (_e = existing.userType) !== null && _e !== void 0 ? _e : role,
                });
            }
            else {
                // No user account — just open a fresh Linq chat for onboarding.
                const { chat_id } = await createChat(phone, {
                    parts: [{ type: "text", value: "Hi! I'm Cara — your care assistant. I'm here whenever you need me." }],
                });
                await sessionRef.update({ chatId: chat_id, onboardingStep: "ask_role" });
            }
        }
    }
    else {
        // No session — look up the user's account data to pre-fill and skip re-onboarding.
        const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
        if (!userQuery.empty) {
            const userDoc = userQuery.docs[0];
            const userData = userDoc.data();
            const userId = userDoc.id;
            const seniorIds = (_f = userData.seniorIds) !== null && _f !== void 0 ? _f : [];
            const seniorId = (_h = (_g = userData.seniorId) !== null && _g !== void 0 ? _g : seniorIds[0]) !== null && _h !== void 0 ? _h : "";
            const { chat_id } = await createChat(phone, {
                parts: [{ type: "text", value: "Hi! I'm Cara — your care assistant. I'm here whenever you need me." }],
            });
            await sessionRef.set({
                chatId: chat_id,
                service: "iMessage",
                phone,
                userType: role,
                userId,
                seniorId,
                onboardingStep: "complete",
                optedIn: true,
                optedOut: false,
                createdAt: new Date().toISOString(),
            });
        }
        else {
            // No user account yet — minimal session for fresh onboarding.
            await getOrCreateSession(phone, { userType: role });
        }
    }
    return { success: true };
});
// ── chatWithCara — web callable: routes authenticated web users through qaAgent ─
// Bridges Firebase Auth UID → phone → agent_sessions so web users get the same
// Cara experience (memory, tool use, booking) as Linq iMessage users.
exports.chatWithCara = functions.https.onCall(async (data, context) => {
    var _a, _b, _c;
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const uid = context.auth.uid;
    const message = (_a = data.message) === null || _a === void 0 ? void 0 : _a.trim();
    if (!message)
        throw new functions.https.HttpsError("invalid-argument", "message is required");
    const db = admin.firestore();
    // Per-user sliding window: max 10 calls per 60 seconds
    const rateRef = db.collection("rate_limits").doc(`web_${uid}`);
    const rateSnap = await rateRef.get();
    const now = Date.now();
    const rateData = (_b = rateSnap.data()) !== null && _b !== void 0 ? _b : { count: 0, windowStart: now };
    if (rateData.windowStart < now - 60000) {
        await rateRef.set({ count: 1, windowStart: now });
    }
    else if (rateData.count >= 10) {
        return {
            available: true,
            rateLimited: true,
            reply: "I'm getting a lot of messages right now — give me a moment before trying again.",
            showMatches: false,
        };
    }
    else {
        await rateRef.update({ count: admin.firestore.FieldValue.increment(1) });
    }
    // Resolve phone from the user's Firestore doc (populated during onboarding)
    const userSnap = await db.collection("users").doc(uid).get();
    const phone = (_c = userSnap.data()) === null || _c === void 0 ? void 0 : _c.phone;
    if (!phone) {
        return { available: false, reply: "Please complete your account setup to chat with Cara." };
    }
    // Load the agent session keyed by phone
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (!sessionSnap.exists) {
        return { available: false, reply: "Your Cara account isn't set up yet. Finish onboarding first." };
    }
    const session = sessionSnap.data();
    const userId = session.userId;
    const seniorId = session.seniorId;
    const zepThreadId = session.zepThreadId;
    // Collect MCP tool names called during this invocation so we can signal the UI
    const toolsCalled = [];
    const { runQaAgent } = await Promise.resolve().then(() => __importStar(require("./agents/qaAgent")));
    let reply;
    try {
        reply = await runQaAgent({
            text: message,
            phone,
            chatId: "", // no Linq chat for web — skipSend prevents any send attempt
            userId,
            seniorId,
            zepThreadId,
            session,
            skipSend: true,
            _toolCallsOut: toolsCalled,
            sourceChannel: "[USER]",
        });
    }
    catch (err) {
        console.error("chatWithCara: qaAgent threw", err);
        throw new functions.https.HttpsError("internal", "Cara is unavailable right now.");
    }
    // Signal the frontend to surface caregiver cards when the matching flow was triggered
    const MATCH_TOOLS = new Set(["find_replacement_caregivers", "request_booking"]);
    const showMatches = toolsCalled.some(t => MATCH_TOOLS.has(t));
    return { available: true, reply, showMatches, toolsCalled };
});
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