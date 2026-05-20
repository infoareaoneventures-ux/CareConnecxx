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
exports.linqWebhook = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
const client_1 = require("./client");
const intentClassifier_1 = require("../agents/intentClassifier");
const qaAgent_1 = require("../agents/qaAgent");
const taskApprovalHandler_1 = require("../agents/taskApprovalHandler");
const sms_1 = require("../sms");
const onboardingConversation_1 = require("../agents/onboardingConversation");
const permissionsConversation_1 = require("../agents/permissionsConversation");
const interviewAgent_1 = require("../agents/interviewAgent");
const bookingExecutor_1 = require("../agents/bookingExecutor");
const crisisDetector_1 = require("../safety/crisisDetector");
const triggerEngine_1 = require("../triggers/triggerEngine");
const auditLog_1 = require("../observability/auditLog");
const bereavement_1 = require("../agents/bereavement");
const caraAgent_1 = require("../agents/caraAgent");
const jobPostingFlow_1 = require("../agents/jobPostingFlow");
const modifyScheduleFlow_1 = require("../agents/modifyScheduleFlow");
const refundHandler_1 = require("../agents/refundHandler");
const sessionState_1 = require("../utils/sessionState");
const dndGuard_1 = require("../utils/dndGuard");
const feedback_1 = require("../ai/feedback");
const jobNotifications_1 = require("../triggers/jobNotifications");
const zepClient_1 = require("../memory/zepClient");
const db = admin.firestore();
// ── Signature verification ────────────────────────────────────────────────────
function verifySignature(rawBody, timestamp, signature, secret) {
    const secretKey = Buffer.from(secret, "base64");
    const payload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
    const hmac = crypto.createHmac("sha256", secretKey).update(payload);
    const expectedB64 = hmac.digest("base64");
    const expectedHex = crypto.createHmac("sha256", secretKey).update(payload).digest("hex");
    try {
        if (signature.length === expectedB64.length)
            return crypto.timingSafeEqual(Buffer.from(expectedB64), Buffer.from(signature));
        if (signature.length === expectedHex.length)
            return crypto.timingSafeEqual(Buffer.from(expectedHex), Buffer.from(signature));
        return false;
    }
    catch (_a) {
        return false;
    }
}
// ── Rate limiting ─────────────────────────────────────────────────────────────
async function isRateLimited(phone) {
    var _a, _b;
    const rateRef = db.collection("agent_rate").doc(phone);
    const snap = await rateRef.get();
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const calls = ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.calls) !== null && _b !== void 0 ? _b : []).filter((t) => t > hourAgo);
    if (calls.length >= 10)
        return true;
    await rateRef.set({ calls: [...calls, now] });
    return false;
}
// ── Opt-in for existing (non-onboarding) users ────────────────────────────────
// ── Typing indicator — pre-fetch context so Claude responds faster ─────────────
async function handleTypingStarted(event) {
    var _a, _b, _c, _d, _e, _f, _g;
    const ev = event;
    const phone = (_b = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.value;
    const chatId = (_d = (_c = ev.data) === null || _c === void 0 ? void 0 : _c.chat) === null || _d === void 0 ? void 0 : _d.id;
    if (!phone || !chatId)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut || session.optedIn === false)
        return;
    const seniorId = (_f = (_e = session.seniorId) !== null && _e !== void 0 ? _e : session.userId) !== null && _f !== void 0 ? _f : "";
    const userId = (_g = session.userId) !== null && _g !== void 0 ? _g : "";
    const now = new Date().toISOString();
    const [seniorSnap, journalSnap, apptSnap, historySnap] = await Promise.all([
        db.collection("senior_profiles").doc(seniorId).get(),
        db.collection("care_journal")
            .where("seniorId", "==", seniorId)
            .orderBy("timestamp", "desc").limit(3).get(),
        db.collection("appointments")
            .where("clientId", "==", userId)
            .where("isoDate", ">=", now.slice(0, 10))
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .orderBy("isoDate", "asc").limit(1).get(),
        db.collection("agent_conversations").doc(phone)
            .collection("messages").orderBy("timestamp", "desc").limit(10).get(),
    ]).catch(() => [null, null, null, null]);
    if (!seniorSnap)
        return;
    await db.collection("agent_prefetch").doc(phone).set({
        seniorProfile: seniorSnap.exists ? seniorSnap.data() : null,
        recentJournal: journalSnap ? journalSnap.docs.map((d) => d.data()) : [],
        nextAppointment: apptSnap && !apptSnap.empty ? apptSnap.docs[0].data() : null,
        conversationHistory: historySnap
            ? historySnap.docs.map((d) => d.data()).reverse()
            : [],
        cachedAt: now,
        expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
}
// ── Caregiver keyword handlers ────────────────────────────────────────────────
async function handleArrived(phone, chatId, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    // Find today's appointment for this caregiver
    const today = new Date().toISOString().slice(0, 10);
    const caregiverId = session.caregiverId;
    if (!caregiverId)
        return;
    const snap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", today)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .limit(1).get();
    if (snap.empty) {
        await (0, client_1.sendMessage)(chatId, "I don't see a scheduled visit for you today. Let me know if something looks wrong.");
        return;
    }
    const appt = snap.docs[0];
    const apptData = appt.data();
    const arrivedAt = new Date().toISOString();
    await appt.ref.update({ arrivedAt, status: "in-progress" });
    // Track lateness if caregiver arrived >= 15 min after scheduled start
    const scheduledStart = (_b = (_a = apptData.startTime) !== null && _a !== void 0 ? _a : apptData.time) !== null && _b !== void 0 ? _b : "";
    if (scheduledStart && session.caregiverId) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const schedMs = new Date(`${todayStr}T${scheduledStart.slice(0, 5)}:00`).getTime();
        const minutesLate = Math.round((Date.now() - schedMs) / 60000);
        if (minutesLate >= 15) {
            const cgSnap = await db.collection("caregivers").doc(session.caregiverId).get();
            const cgName = (_d = (_c = cgSnap.data()) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : "Unknown";
            const { recordLatenessEvent, checkLatenessPattern } = await Promise.resolve().then(() => __importStar(require("../agents/latenessTracker")));
            recordLatenessEvent({
                caregiverId: session.caregiverId,
                caregiverName: cgName,
                appointmentId: appt.id,
                clientId: (_e = apptData.clientId) !== null && _e !== void 0 ? _e : "",
                date: todayStr,
                scheduledTime: scheduledStart.slice(0, 5),
                minutesLate,
                selfReported: false,
            }).catch(() => { });
            checkLatenessPattern(session.caregiverId, cgName).catch(() => { });
        }
    }
    // Notify family (DND-aware: high urgency — queued but priority delivery)
    const clientPhone = await getClientPhoneForAppt(apptData);
    if (clientPhone) {
        const cgName2 = session.caregiverId
            ? (_g = (_f = (await db.collection("caregivers").doc(session.caregiverId).get()).data()) === null || _f === void 0 ? void 0 : _f.name) !== null && _g !== void 0 ? _g : "Your caregiver"
            : "Your caregiver";
        await (0, dndGuard_1.sendIfNotDND)(clientPhone, {
            content: `${cgName2} just arrived for ${(_h = apptData.clientName) !== null && _h !== void 0 ? _h : "the visit"}.`,
            urgency: "immediate",
            sourceAgent: "arrived_notification",
            canDrop: false,
        }, "high");
    }
    await (0, client_1.sendMessage)(chatId, "Got it — I've let the family know you're there. Have a good visit.");
}
async function handleDone(phone, chatId, session) {
    const caregiverId = session.caregiverId;
    if (!caregiverId)
        return;
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", today)
        .where("status", "==", "in-progress")
        .limit(1).get();
    if (!snap.empty) {
        await snap.docs[0].ref.update({ completedAt: new Date().toISOString() });
    }
    // Store that we're awaiting care notes
    await db.collection("agent_sessions").doc(phone).update({
        awaitingCareNotes: true,
        careNotesApptId: snap.empty ? "" : snap.docs[0].id,
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await (0, client_1.sendMessage)(chatId, "How did the visit go? Tell me in your own words — I'll handle the notes.");
}
async function handleRunningLate(phone, chatId) {
    await db.collection("agent_sessions").doc(phone).update({
        awaitingLateMinutes: true,
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await (0, client_1.sendMessage)(chatId, "How late do you think you'll be?");
}
async function handleIssue(phone, chatId) {
    await db.collection("agent_sessions").doc(phone).update({
        awaitingIssueDescription: true,
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await (0, client_1.sendMessage)(chatId, "I'm sorry to hear that. Can you describe what's happening?");
}
async function getClientPhoneForAppt(appt) {
    var _a;
    const clientId = appt.clientId;
    if (!clientId)
        return null;
    const snap = await db.collection("agent_sessions")
        .where("userId", "==", clientId).limit(1).get();
    if (snap.empty)
        return null;
    return (_a = snap.docs[0].data().phone) !== null && _a !== void 0 ? _a : snap.docs[0].id;
}
// ── Caregiver voice/text → structured journal ─────────────────────────────────
async function handleCareNotes(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _s, _t;
    const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const structured = await claude.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: "Convert this caregiver note into a structured care journal entry. " +
            'Reply in JSON: {"overallWellness":1,"mood":"happy|neutral|agitated|confused|tired",' +
            '"appetite":"good|fair|poor|refused","activities":[],"medications":[],' +
            '"observations":"","notes":""}',
        messages: [{ role: "user", content: text }],
    });
    let entry = {};
    try {
        entry = JSON.parse((_a = structured.content[0].text) !== null && _a !== void 0 ? _a : "{}");
    }
    catch (_u) {
        entry = { notes: text };
    }
    const apptId = (_b = session.careNotesApptId) !== null && _b !== void 0 ? _b : "";
    const caregiverId = (_c = session.caregiverId) !== null && _c !== void 0 ? _c : "";
    // Get clientId from appointment and re-validate status
    let clientId = "";
    let seniorId = "";
    if (apptId) {
        const apptSnap = await db.collection("appointments").doc(apptId).get();
        const apptData = apptSnap.data();
        clientId = (_d = apptData === null || apptData === void 0 ? void 0 : apptData.clientId) !== null && _d !== void 0 ? _d : "";
        seniorId = (_e = apptData === null || apptData === void 0 ? void 0 : apptData.seniorId) !== null && _e !== void 0 ? _e : clientId;
        // Re-validate: only write notes if appointment was actually in progress or just completed
        const validStatuses = ["in-progress", "completed", "confirmed"];
        if (apptData && !validStatuses.includes((_f = apptData.status) !== null && _f !== void 0 ? _f : "")) {
            await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
            await (0, client_1.sendMessage)(chatId, "I wasn't able to save those notes — it looks like that visit was cancelled.");
            return;
        }
        // Dedup + write in a single transaction to prevent duplicate journal entries if
        // two requests race (e.g. duplicate webhook delivery or fast caregiver retap).
        let alreadyExists = false;
        const journalRef = db.collection("care_journal").doc();
        const sessionRef = db.collection("agent_sessions").doc(phone);
        await db.runTransaction(async (t) => {
            var _a, _b, _c, _d;
            const existingSnap = await db.collection("care_journal")
                .where("appointmentId", "==", apptId)
                .limit(1)
                .get();
            if (!existingSnap.empty) {
                alreadyExists = true;
                return;
            }
            t.set(journalRef, {
                caregiverId,
                seniorId,
                appointmentId: apptId,
                timestamp: new Date().toISOString(),
                notes: (_a = entry.notes) !== null && _a !== void 0 ? _a : text,
                wellness: {
                    ateWell: entry.appetite === "good",
                    tookMeds: Array.isArray(entry.medications) && entry.medications.length > 0,
                    wasActive: Array.isArray(entry.activities) && entry.activities.length > 0,
                    mood: (_b = entry.mood) !== null && _b !== void 0 ? _b : "neutral",
                },
                activities: (_c = entry.activities) !== null && _c !== void 0 ? _c : [],
                observations: (_d = entry.observations) !== null && _d !== void 0 ? _d : "",
            });
            t.update(sessionRef, { awaitingCareNotes: false, careNotesApptId: "" });
        });
        if (alreadyExists) {
            await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
            await (0, client_1.sendMessage)(chatId, "Notes for this visit are already saved.");
            return;
        }
    }
    else {
        // No apptId — write without dedup guard and clear flag
        await db.collection("care_journal").add({
            caregiverId,
            seniorId,
            appointmentId: apptId,
            timestamp: new Date().toISOString(),
            notes: (_g = entry.notes) !== null && _g !== void 0 ? _g : text,
            wellness: {
                ateWell: entry.appetite === "good",
                tookMeds: Array.isArray(entry.medications) && entry.medications.length > 0,
                wasActive: Array.isArray(entry.activities) && entry.activities.length > 0,
                mood: (_h = entry.mood) !== null && _h !== void 0 ? _h : "neutral",
            },
            activities: (_j = entry.activities) !== null && _j !== void 0 ? _j : [],
            observations: (_k = entry.observations) !== null && _k !== void 0 ? _k : "",
        });
        await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
    }
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const hourlyRate = (_m = (_l = cgSnap.data()) === null || _l === void 0 ? void 0 : _l.hourlyRate) !== null && _m !== void 0 ? _m : 20;
    const apptSnap = apptId
        ? await db.collection("appointments").doc(apptId).get()
        : null;
    const durationHours = (_p = (_o = apptSnap === null || apptSnap === void 0 ? void 0 : apptSnap.data()) === null || _o === void 0 ? void 0 : _o.durationHours) !== null && _p !== void 0 ? _p : 4;
    const pay = (hourlyRate * durationHours).toFixed(2);
    // Fire visit billing (fire-and-forget so it doesn't block caregiver confirmation)
    if (apptId && clientId) {
        const { createVisitPayment } = await Promise.resolve().then(() => __importStar(require("../billing/visitBilling")));
        createVisitPayment({
            appointmentId: apptId,
            clientId,
            clientPhone: "", // Family phone looked up inside createVisitPayment if needed
            caregiverId,
            caregiverName: (_s = (_q = cgSnap.data()) === null || _q === void 0 ? void 0 : _q.name) !== null && _s !== void 0 ? _s : "Your caregiver",
            caregiverPhone: phone,
            durationHours,
            hourlyRate,
            date: new Date().toISOString().slice(0, 10),
        }).catch((err) => console.error("createVisitPayment error:", err));
    }
    // Find next appointment for this caregiver
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextSnap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", ">=", tomorrow.toISOString().slice(0, 10))
        .where("status", "in", ["confirmed"])
        .orderBy("date", "asc").limit(1).get();
    const nextLine = nextSnap.empty
        ? "No upcoming visits scheduled yet."
        : `Next visit: ${nextSnap.docs[0].data().date} at ${(_t = nextSnap.docs[0].data().startTime) !== null && _t !== void 0 ? _t : ""}`;
    await (0, client_1.sendMessage)(chatId, `Got it — notes saved.\n\n` +
        `Your payment of $${pay} will be processed tonight.\n` +
        `${nextLine}\n\n` +
        `Have a great rest of your day.`);
}
// ── Post-visit feedback sentiment classifier ──────────────────────────────────
async function classifyFeedbackSentiment(text) {
    var _a;
    try {
        const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
        const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const res = await claude.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 10,
            system: "Classify this feedback about a home care visit as positive, negative, or neutral. " +
                "Consider tone, context, and nuance — not just keywords. " +
                "Reply with one word: POSITIVE, NEGATIVE, or NEUTRAL.",
            messages: [{ role: "user", content: text }],
        });
        const label = ((_a = res.content[0].text) !== null && _a !== void 0 ? _a : "").trim().toUpperCase();
        if (label === "POSITIVE")
            return "positive";
        if (label === "NEGATIVE")
            return "negative";
    }
    catch (err) {
        console.error("classifyFeedbackSentiment error:", err);
    }
    return "neutral";
}
async function handleVisitFeedback(params) {
    const sentiment = await classifyFeedbackSentiment(params.text);
    const numericRating = sentiment === "positive" ? 5 : sentiment === "negative" ? 2 : 3;
    if (sentiment !== "neutral" && params.clientId && params.caregiverId) {
        await (0, feedback_1.writeFeedbackSignal)({
            clientId: params.clientId,
            caregiverId: params.caregiverId,
            signal: sentiment === "positive" ? 1 : -1,
            source: "post_visit_feedback",
            appointmentId: params.appointmentId,
            rawText: params.text,
        }).catch((err) => console.error("writeFeedbackSignal error:", err));
    }
    // Write to post_visit_feedback collection for rating aggregation
    if (params.caregiverId && params.clientId) {
        await db.collection("post_visit_feedback").add({
            caregiverId: params.caregiverId,
            clientId: params.clientId,
            appointmentId: params.appointmentId,
            rating: numericRating,
            sentiment,
            rawText: params.text.slice(0, 500),
            status: "submitted",
            createdAt: new Date().toISOString(),
        }).catch(() => { });
        // Aggregate ratings back into the caregiver doc
        const { onFeedbackSubmitted } = await Promise.resolve().then(() => __importStar(require("../agents/feedbackAggregator")));
        onFeedbackSubmitted(params.caregiverId, numericRating, params.appointmentId, params.clientId)
            .catch((err) => console.error("onFeedbackSubmitted error:", err));
    }
    await db.collection("proactive_triggers").doc(params.triggerId)
        .update({ feedbackReceived: new Date().toISOString() })
        .catch(() => { });
    const response = sentiment === "positive"
        ? "Glad to hear it — I'll keep that in mind for future matches. 💙"
        : sentiment === "negative"
            ? "Thank you for letting me know. I'll take that into account and make sure future caregivers are a better fit."
            : "Got it — noted.";
    await (0, caraAgent_1.sendViaInteractionAgent)(params.phone, {
        content: response,
        urgency: "standard",
        sourceAgent: "feedback",
        canDrop: false,
    });
}
// ── Recurring schedule: YES confirmation ─────────────────────────────────────
async function handleRecurringConfirm(phone, chatId, session) {
    var _a, _b, _c, _d;
    const pending = session.pendingRecurringSchedule;
    if (!pending) {
        await db.collection("agent_sessions").doc(phone).update({
            awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
        });
        return;
    }
    const clientId = (_a = session.userId) !== null && _a !== void 0 ? _a : phone;
    const seniorName = (_d = (_c = (_b = session.onboardingData) === null || _b === void 0 ? void 0 : _b.seniorName) !== null && _c !== void 0 ? _c : session.seniorName) !== null && _d !== void 0 ? _d : "";
    const today = new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { generateRecurringDates } = await Promise.resolve().then(() => __importStar(require("../scheduled/recurringScheduler")));
    const dates = generateRecurringDates(today, pending.days, 4);
    if (dates.length === 0) {
        await (0, client_1.sendMessage)(chatId, "I couldn't generate dates for that schedule — the days may not be valid. Let me know if you'd like to try again.");
        await db.collection("agent_sessions").doc(phone).update({
            awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
        }).catch(() => { });
        return;
    }
    const scheduleRef = db.collection("recurring_schedules").doc();
    const batch = db.batch();
    batch.set(scheduleRef, {
        clientId,
        caregiverId: pending.caregiverId,
        caregiverName: pending.caregiverName,
        clientPhone: phone,
        seniorName,
        days: pending.days,
        startTime: pending.startTime,
        endTime: pending.endTime,
        durationHours: pending.durationHours,
        hourlyRate: pending.hourlyRate,
        status: "active",
        startDate: today,
        weeksBookedAhead: 4,
        lastExtendedAt: now,
        createdAt: now,
    });
    for (const { date } of dates) {
        const apptRef = db.collection("appointments").doc();
        batch.set(apptRef, {
            clientId,
            caregiverId: pending.caregiverId,
            caregiverName: pending.caregiverName,
            date,
            startTime: pending.startTime,
            endTime: pending.endTime,
            durationHours: pending.durationHours,
            hourlyRate: pending.hourlyRate,
            status: "confirmed",
            recurringScheduleId: scheduleRef.id,
            humanApproved: true,
            createdByAgent: true,
            createdAt: now,
        });
    }
    await batch.commit();
    await db.collection("agent_sessions").doc(phone).update({
        awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
        pendingRecurringSchedule: admin.firestore.FieldValue.delete(),
        activeRecurringScheduleId: scheduleRef.id,
    }).catch(() => { });
    const schedDesc = `${pending.days.join("/")}s ${pending.startTime}–${pending.endTime}`;
    await (0, client_1.sendMessage)(chatId, `Set up! ${pending.caregiverName} is booked every ${schedDesc} for the next 4 weeks — ` +
        `and I'll keep extending it automatically.\n\n` +
        `To pause or stop anytime, just text me PAUSE SCHEDULE or CANCEL SCHEDULE.`);
}
// ── Recurring schedule: PAUSE / CANCEL / RESUME ───────────────────────────────
async function handleRecurringPause(phone, chatId, session) {
    const scheduleId = session.activeRecurringScheduleId;
    if (!scheduleId) {
        await (0, client_1.sendMessage)(chatId, "I don't see an active recurring schedule. Let me know if you need anything else.");
        return;
    }
    await db.collection("recurring_schedules").doc(scheduleId).update({
        status: "paused",
        pausedAt: new Date().toISOString(),
        pausedReason: "client_request",
    });
    await (0, client_1.sendMessage)(chatId, "Recurring schedule paused. Future visits won't be booked automatically.\n\n" +
        "Text RESUME SCHEDULE whenever you're ready to start again.");
}
async function handleRecurringCancel(phone, chatId, session) {
    const scheduleId = session.activeRecurringScheduleId;
    if (!scheduleId) {
        await (0, client_1.sendMessage)(chatId, "I don't see an active recurring schedule. Let me know if you need anything else.");
        return;
    }
    const today = new Date().toISOString().split("T")[0];
    // Cancel all future unconfirmed visits from this schedule
    const futureSnap = await db.collection("appointments")
        .where("recurringScheduleId", "==", scheduleId)
        .where("date", ">", today)
        .where("status", "in", ["confirmed"])
        .get();
    const batch = db.batch();
    batch.update(db.collection("recurring_schedules").doc(scheduleId), { status: "cancelled", cancelledAt: new Date().toISOString() });
    for (const doc of futureSnap.docs) {
        batch.update(doc.ref, { status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
    }
    await batch.commit();
    await db.collection("agent_sessions").doc(phone).update({
        activeRecurringScheduleId: admin.firestore.FieldValue.delete(),
    }).catch(() => { });
    await (0, client_1.sendMessage)(chatId, `Recurring schedule cancelled. ${futureSnap.size > 0 ? `${futureSnap.size} upcoming visit${futureSnap.size !== 1 ? "s" : ""} have been removed.` : ""}\n\n` +
        `You can still book individual visits anytime.`.trim());
}
async function handleRecurringResume(phone, chatId, session) {
    var _a;
    const scheduleId = session.activeRecurringScheduleId;
    if (!scheduleId) {
        await (0, client_1.sendMessage)(chatId, "I don't see a paused schedule. Let me know if you need anything else.");
        return;
    }
    const schedSnap = await db.collection("recurring_schedules").doc(scheduleId).get();
    if (!schedSnap.exists || ((_a = schedSnap.data()) === null || _a === void 0 ? void 0 : _a.status) !== "paused") {
        await (0, client_1.sendMessage)(chatId, "That schedule isn't currently paused.");
        return;
    }
    const sched = schedSnap.data();
    const today = new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { generateRecurringDates } = await Promise.resolve().then(() => __importStar(require("../scheduled/recurringScheduler")));
    const dates = generateRecurringDates(today, sched.days, 4);
    const batch = db.batch();
    batch.update(schedSnap.ref, {
        status: "active",
        pausedAt: admin.firestore.FieldValue.delete(),
        pausedReason: admin.firestore.FieldValue.delete(),
        lastExtendedAt: now,
        weeksBookedAhead: 4,
    });
    for (const { date } of dates) {
        const apptRef = db.collection("appointments").doc();
        batch.set(apptRef, {
            clientId: sched.clientId,
            caregiverId: sched.caregiverId,
            caregiverName: sched.caregiverName,
            date,
            startTime: sched.startTime,
            endTime: sched.endTime,
            durationHours: sched.durationHours,
            hourlyRate: sched.hourlyRate,
            status: "confirmed",
            recurringScheduleId: scheduleId,
            humanApproved: true,
            createdByAgent: true,
            createdAt: now,
        });
    }
    await batch.commit();
    const schedDesc = `${sched.days.join("/")}s ${sched.startTime}–${sched.endTime}`;
    await (0, client_1.sendMessage)(chatId, `Resumed! ${sched.caregiverName} is booked every ${schedDesc} for the next 4 weeks.`);
}
// ── Main inbound handler ──────────────────────────────────────────────────────
async function handleInbound(event) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41, _42, _43, _44, _45, _46, _47, _48, _49, _50, _51, _52, _53, _54, _55, _56, _57, _58, _59, _60, _61, _62, _63, _64, _65, _66, _67, _68, _69, _70, _71, _72, _73, _74, _75, _76, _77, _78, _79, _80, _81, _82, _83, _84, _85, _86, _87, _88, _89, _90, _91, _92, _93, _94, _95, _96, _97, _98, _99, _100, _101, _102, _103, _104, _105, _106, _107, _108, _109, _110, _111, _112, _113, _114, _115, _116, _117, _118, _119, _120, _121, _122, _123, _124, _125, _126, _127, _128, _129, _130;
    const ev = event;
    const phone = (_b = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.value;
    const text = ((_f = (_e = (_d = (_c = ev.data) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.value) !== null && _f !== void 0 ? _f : "");
    const chatId = (_h = (_g = ev.data) === null || _g === void 0 ? void 0 : _g.chat) === null || _h === void 0 ? void 0 : _h.id;
    const service = ((_o = (_k = (_j = ev.data) === null || _j === void 0 ? void 0 : _j.service) !== null && _k !== void 0 ? _k : (_m = (_l = ev.data) === null || _l === void 0 ? void 0 : _l.chat) === null || _m === void 0 ? void 0 : _m.service) !== null && _o !== void 0 ? _o : "SMS");
    if (!phone || !chatId)
        return;
    // Fire typing indicator immediately — before any async work — so the family
    // never sees silence during the ~200ms session load + routing decisions.
    if (service === "iMessage")
        (0, client_1.startTyping)(chatId).catch(() => { });
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    // ── New user — texted first (MO consent) ────────────────────────────────────
    if (!sessionSnap.exists) {
        // Check if this phone belongs to a secondary family group member
        const groupSnap = await db.collection("agent_sessions")
            .where("groupMembers", "array-contains", phone)
            .limit(1)
            .get();
        if (!groupSnap.empty) {
            // Route as secondary family member using primary's session context
            const primarySession = groupSnap.docs[0].data();
            const primaryPhone = groupSnap.docs[0].id;
            // Create a lightweight session for this member pointing to the primary
            await db.collection("agent_sessions").doc(phone).set({
                chatId,
                phone,
                service: "iMessage",
                userType: "client",
                onboardingStep: "complete",
                optedIn: true,
                optedOut: false,
                userId: primarySession.userId,
                seniorId: primarySession.seniorId,
                primaryPhone,
                isSecondaryMember: true,
                createdAt: new Date().toISOString(),
            });
            // Start Zep memory for this secondary member too — awaited so zepThreadId lands before
            // their first message is processed.
            await (0, zepClient_1.initializeZepOnFirstContact)(phone).catch((err) => console.error("Zep init failed (secondary member):", err));
            await (0, client_1.sendMessage)(chatId, `Hi, I'm Cara — the care assistant for ${(_q = (_p = primarySession.onboardingData) === null || _p === void 0 ? void 0 : _p.seniorName) !== null && _q !== void 0 ? _q : "your family"}. ` +
                `I've added you to the care group. You'll get the same updates and can ask me anything.`);
            return;
        }
        const capability = await (0, client_1.checkCapability)(phone);
        const service = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";
        const linqPhone = (_s = process.env.LINQ_PHONE_NUMBER) !== null && _s !== void 0 ? _s : "";
        await (0, client_1.setContactCard)({ phone_number: linqPhone, display_name: "Cara" }).catch(() => { });
        await (0, client_1.shareContactCard)(chatId).catch(() => { });
        await db.collection("agent_sessions").doc(phone).set({
            chatId,
            phone,
            service,
            userType: null,
            onboardingStep: "ask_role",
            optedIn: true,
            optedOut: false,
            createdAt: new Date().toISOString(),
        });
        // Start Zep memory immediately — awaited so zepThreadId is written before
        // the next message arrives (fast: ~200ms HTTP call).
        await (0, zepClient_1.initializeZepOnFirstContact)(phone).catch((err) => console.error("Zep init failed (first contact):", err));
        if (service === "iMessage")
            await (0, client_1.startTyping)(chatId).catch(() => { });
        await (0, client_1.sendMessage)(chatId, `Hi — I'm Cara. I help families find and manage care for aging parents, all through text. No app needed.\n\n` +
            `Are you looking for care for someone, or are you a caregiver?\n\n` +
            `1️⃣ I need care for someone\n` +
            `2️⃣ I'm a caregiver`);
        return;
    }
    const session = sessionSnap.data();
    const norm = text.trim().toUpperCase();
    const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END"]);
    if (session.optedOut)
        return;
    // ── Expired state machine — save checkpoint for onboarding, clear otherwise ─
    {
        const stateExpiresAt = session.stateExpiresAt;
        const hasStateFlag = sessionState_1.STATE_MACHINE_FLAGS.filter(f => f !== "stateExpiresAt")
            .some(f => !!session[f]);
        if (hasStateFlag && stateExpiresAt && new Date(stateExpiresAt) < new Date()) {
            // If mid-onboarding, save a checkpoint so the user can resume instead of restarting
            const isOnboarding = session.onboardingStep && session.onboardingStep !== "complete";
            if (isOnboarding) {
                await db.collection("agent_sessions").doc(phone).update({
                    onboardingCheckpoint: {
                        step: session.onboardingStep,
                        onboardingData: (_t = session.onboardingData) !== null && _t !== void 0 ? _t : {},
                        savedAt: new Date().toISOString(),
                    },
                }).catch(() => { });
            }
            await (0, sessionState_1.clearAllStateFlags)(phone, db);
            if (isOnboarding) {
                await (0, client_1.sendMessage)(chatId, "Your session timed out. No worries — I saved your progress!\n\n" +
                    "Reply RESUME to pick up where you left off, or START OVER to begin fresh.");
            }
            else {
                await (0, client_1.sendMessage)(chatId, "Your previous session timed out — just text me if you'd like to continue.");
            }
            return;
        }
    }
    // ── Onboarding resume from checkpoint ────────────────────────────────────────
    {
        const checkpoint = session.onboardingCheckpoint;
        const isResumeCommand = norm === "RESUME" || norm === "CONTINUE" || norm === "PICK UP WHERE I LEFT OFF";
        const isStartOver = norm === "START OVER" || norm === "RESTART" || norm === "BEGIN AGAIN";
        if (checkpoint && (isResumeCommand || isStartOver)) {
            await db.collection("agent_sessions").doc(phone).update({
                onboardingCheckpoint: admin.firestore.FieldValue.delete(),
            });
            if (isStartOver) {
                await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "ask_role", onboardingData: {} });
                await (0, client_1.sendMessage)(chatId, "Starting fresh! Are you looking for care for someone, or are you a caregiver?\n\n" +
                    "1️⃣  I need care for someone\n" +
                    "2️⃣  I'm a caregiver");
            }
            else {
                // Resume: restore checkpoint data and re-ask the current step's question
                await db.collection("agent_sessions").doc(phone).update({
                    onboardingStep: checkpoint.step,
                    onboardingData: checkpoint.onboardingData,
                    stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });
                const resumedSession = Object.assign(Object.assign({}, session), { onboardingStep: checkpoint.step, onboardingData: checkpoint.onboardingData });
                await (0, client_1.sendMessage)(chatId, "Picking up where we left off!");
                await (0, onboardingConversation_1.handleOnboardingStep)(phone, chatId, "__RESUME__", resumedSession);
            }
            return;
        }
        // If checkpoint exists but user sent a normal message (not resume/start-over),
        // nudge them to choose before processing normally
        if (checkpoint && session.onboardingStep !== "complete") {
            await (0, client_1.sendMessage)(chatId, "You have a saved onboarding session. Reply RESUME to continue, or START OVER to begin fresh.");
            return;
        }
    }
    // STOP — works at any stage (CANCEL is NOT here — it cancels a visit, not the account)
    if (stopWords.has(norm)) {
        await (0, sms_1.optOutPhoneNumber)(phone);
        await (0, client_1.sendMessage)(chatId, "You've been unsubscribed from Cara messages. Reply START anytime to reactivate.");
        return;
    }
    // ── Subscription lapse — graceful degradation for clients with lapsed billing ─
    if (session.userType === "client" && session.onboardingStep === "complete") {
        const userId = (_u = session.userId) !== null && _u !== void 0 ? _u : phone;
        const userSnap = await db.collection("users").doc(userId).get().catch(() => null);
        const subStatus = (_v = userSnap === null || userSnap === void 0 ? void 0 : userSnap.data()) === null || _v === void 0 ? void 0 : _v.subscriptionStatus;
        if (subStatus === "past_due" || subStatus === "canceled" || subStatus === "unpaid") {
            await (0, client_1.sendMessage)(chatId, "Your Cara membership needs attention — there was an issue with your payment.\n\n" +
                "To keep your care coordination active, please update your billing at cara.app/billing or reply HELP to reach our support team.");
            return;
        }
    }
    // ── Twin-trigger cancel — user replied, cancel any pending proactive nudges ─
    (0, triggerEngine_1.cancelTriggerIfUserReplied)((_w = session.userId) !== null && _w !== void 0 ? _w : phone, phone).catch(() => { });
    // ── Crisis detection — checked before everything else ──────────────────────
    const crisis = (0, crisisDetector_1.detectCrisis)(text);
    if (crisis === "medical") {
        await (0, client_1.sendMessage)(chatId, crisisDetector_1.MEDICAL_RESPONSE);
        (0, auditLog_1.logCrisisDetected)(phone, "medical", text).catch(() => { });
        return;
    }
    if (crisis === "emotional") {
        await (0, client_1.sendMessage)(chatId, crisisDetector_1.EMOTIONAL_RESPONSE);
        (0, auditLog_1.logCrisisDetected)(phone, "emotional", text).catch(() => { });
        return;
    }
    // ── Bereavement detection — before intent classification ───────────────────
    if (await (0, bereavement_1.isBereavementTrigger)(text) && !session.bereavementMode) {
        const seniorName = (_x = session.seniorName) !== null && _x !== void 0 ? _x : "your loved one";
        await (0, bereavement_1.activateBereavementMode)((_y = session.userId) !== null && _y !== void 0 ? _y : phone, chatId, phone, seniorName);
        return;
    }
    // If already in bereavement mode — allow explicit exit or send gentle acknowledgment
    if (session.bereavementMode) {
        let isExit = false;
        try {
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const res = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 5,
                system: "The user is in bereavement mode after losing a loved one. " +
                    "Reply YES if they are clearly expressing that they are ready to resume normal service " +
                    "(e.g. they need a caregiver, want to continue, are ready). " +
                    "Reply NO if they are still grieving or just checking in. " +
                    "Reply with only YES or NO.",
                messages: [{ role: "user", content: text }],
            });
            isExit = ((_z = res.content[0].text) !== null && _z !== void 0 ? _z : "").trim().toUpperCase().startsWith("Y");
        }
        catch (_131) {
            isExit = false;
        }
        if (isExit) {
            await db.collection("agent_sessions").doc(phone).update({ bereavementMode: admin.firestore.FieldValue.delete() });
            await (0, client_1.sendMessage)(chatId, "Of course. I'm here whenever you need me. What can I help you with?");
        }
        else {
            // After 30 days, gently offer to resume — don't trap them forever
            const activatedAt = session.bereavementActivatedAt;
            const daysSince = activatedAt
                ? (Date.now() - new Date(activatedAt).getTime()) / (1000 * 60 * 60 * 24)
                : 0;
            if (daysSince > 30) {
                await (0, client_1.sendMessage)(chatId, "I'm here with you. 💙 Whenever you're ready to arrange care again, just let me know.");
            }
            else {
                await (0, client_1.sendMessage)(chatId, "I'm here with you. 💙 Take all the time you need.");
            }
        }
        return;
    }
    // ── Zep lazy-init — backfill for users onboarded before Zep was added ──────
    if (!session.zepThreadId && session.onboardingStep === "complete") {
        (0, zepClient_1.initializeZepOnFirstContact)(phone).catch((err) => console.error("Zep lazy-init error:", err));
    }
    // ── ONBOARDING gate — route to state machine if not complete ─────────────
    const step = (_0 = session.onboardingStep) !== null && _0 !== void 0 ? _0 : "";
    if (step && step !== "complete") {
        // Log every onboarding message to Zep — this is where names, conditions,
        // and care needs are shared, so Zep starts building the knowledge graph now
        const onboardingZepThreadId = session.zepThreadId;
        if (onboardingZepThreadId) {
            (0, zepClient_1.addUserMessageToZep)({
                threadId: onboardingZepThreadId,
                content: text,
                userName: (_2 = (_1 = session.onboardingData) === null || _1 === void 0 ? void 0 : _1.firstName) !== null && _2 !== void 0 ? _2 : "User",
                sentAt: new Date(),
            }).catch(console.error);
        }
        // Permissions steps
        if (step === "client_permissions_contact" || step === "client_permissions_booking" || step === "client_permissions_autobook") {
            const userId = (_3 = session.userId) !== null && _3 !== void 0 ? _3 : phone;
            await (0, permissionsConversation_1.handleClientPermissionsReply)(phone, chatId, text, session, userId);
            return;
        }
        if (step === "caregiver_permissions_decline" || step === "caregiver_permissions_arrival") {
            const caregiverId = (_4 = session.caregiverId) !== null && _4 !== void 0 ? _4 : phone;
            await (0, permissionsConversation_1.handleCaregiverPermissionsReply)(phone, chatId, text, session, caregiverId);
            return;
        }
        await (0, onboardingConversation_1.handleOnboardingStep)(phone, chatId, text, session);
        // After each onboarding step, push the progress event to Zep as structured JSON
        // so Zep's knowledge graph captures names, conditions, care needs as they're collected.
        if (onboardingZepThreadId) {
            const afterSnap = await db.collection("agent_sessions").doc(phone).get();
            const afterData = (_5 = afterSnap.data()) !== null && _5 !== void 0 ? _5 : {};
            const newStep = (_6 = afterData.onboardingStep) !== null && _6 !== void 0 ? _6 : step;
            const oData = (_7 = afterData.onboardingData) !== null && _7 !== void 0 ? _7 : {};
            (0, zepClient_1.addBusinessDataToZep)({
                userId: (0, zepClient_1.getZepUserId)(phone),
                data: {
                    event_type: "onboarding_step",
                    step_completed: step,
                    step_next: newStep,
                    user_type: (_8 = afterData.userType) !== null && _8 !== void 0 ? _8 : "unknown",
                    user_name: (_10 = (_9 = oData.firstName) !== null && _9 !== void 0 ? _9 : oData.name) !== null && _10 !== void 0 ? _10 : "",
                    senior_name: (_11 = oData.seniorName) !== null && _11 !== void 0 ? _11 : "",
                    senior_age: (_12 = oData.age) !== null && _12 !== void 0 ? _12 : null,
                    senior_conditions: (_13 = oData.conditions) !== null && _13 !== void 0 ? _13 : [],
                    senior_care_needs: (_14 = oData.careNeeds) !== null && _14 !== void 0 ? _14 : [],
                    senior_city: (_15 = oData.city) !== null && _15 !== void 0 ? _15 : "",
                    timestamp: new Date().toISOString(),
                },
            }).catch((err) => console.error("onboarding Zep push error:", err));
        }
        return;
    }
    // Rate limit
    if (await isRateLimited(phone)) {
        await (0, client_1.sendMessage)(chatId, "I'm getting a lot of messages right now — try again in a bit.");
        return;
    }
    // ── Universal state-machine escape hatch ──────────────────────────────────────
    {
        const ESCAPE_WORDS = new Set(["NEVERMIND", "QUIT", "EXIT", "BACK", "START OVER", "RESET", "FORGET IT"]);
        const hasStateFlagEscape = sessionState_1.STATE_MACHINE_FLAGS.filter(f => f !== "stateExpiresAt")
            .some(f => !!session[f]);
        if (hasStateFlagEscape &&
            (ESCAPE_WORDS.has(norm) ||
                norm.startsWith("NEVER MIND") ||
                norm.startsWith("FORGET IT"))) {
            await (0, sessionState_1.clearAllStateFlags)(phone, db);
            await (0, client_1.sendMessage)(chatId, "No problem, starting fresh. What can I help you with?");
            return;
        }
    }
    // ── Post-visit feedback reply — check before general routing ──────────────
    {
        const pendingFeedback = await db.collection("proactive_triggers")
            .where("phone", "==", phone)
            .where("type", "==", "post_visit_feedback")
            .where("firedAt", "!=", null)
            .where("feedbackReceived", "==", null)
            .orderBy("firedAt", "desc")
            .limit(1)
            .get();
        if (!pendingFeedback.empty) {
            const triggerDoc = pendingFeedback.docs[0];
            const meta = (_16 = triggerDoc.data().metadata) !== null && _16 !== void 0 ? _16 : {};
            await handleVisitFeedback({
                phone,
                chatId,
                text,
                caregiverId: (_17 = meta.caregiverId) !== null && _17 !== void 0 ? _17 : "",
                clientId: (_19 = (_18 = meta.clientId) !== null && _18 !== void 0 ? _18 : session.userId) !== null && _19 !== void 0 ? _19 : "",
                appointmentId: (_20 = meta.appointmentId) !== null && _20 !== void 0 ? _20 : "",
                triggerId: triggerDoc.id,
            });
            return;
        }
    }
    // ── Caregiver keyword handling ──────────────────────────────────────────────
    if (session.userType === "caregiver") {
        const KEYWORDS = {
            ARRIVED: () => handleArrived(phone, chatId, session),
            DONE: () => handleDone(phone, chatId, session),
            LATE: () => handleRunningLate(phone, chatId),
            ISSUE: () => handleIssue(phone, chatId),
            CONFIRM: async () => {
                var _a, _b, _c;
                // Find most recent appointment for this caregiver not yet confirmed
                const now = new Date().toISOString();
                const apptSnap = await db.collection("appointments")
                    .where("caregiverId", "==", (_a = session.caregiverId) !== null && _a !== void 0 ? _a : "")
                    .where("status", "==", "confirmed")
                    .where("caregiverConfirmed", "!=", true)
                    .orderBy("caregiverConfirmed")
                    .orderBy("date", "asc")
                    .limit(1).get();
                if (!apptSnap.empty) {
                    const appt = apptSnap.docs[0].data();
                    const updateFields = { caregiverConfirmed: true, caregiverConfirmedAt: now };
                    // Mark check-in confirmed so escalation guard skips it
                    if (appt.caregiverCheckInSent) {
                        updateFields.caregiverCheckInConfirmed = true;
                        updateFields.caregiverCheckInAt = now;
                    }
                    await apptSnap.docs[0].ref.update(updateFields);
                    // Notify family
                    const familySnap = await db.collection("agent_sessions").doc((_b = appt.clientId) !== null && _b !== void 0 ? _b : appt.clientPhone).get();
                    if (familySnap.exists) {
                        await (0, client_1.sendMessage)(familySnap.data().chatId, `${(_c = appt.caregiverName) !== null && _c !== void 0 ? _c : "Your caregiver"} confirmed the visit on ${appt.date}. You're all set.`);
                    }
                    await (0, client_1.sendMessage)(chatId, "Confirmed! See you then. 👍");
                }
                else {
                    await (0, client_1.sendMessage)(chatId, "Got it — confirmed! 👍");
                }
            },
            RESCHEDULE: async () => {
                await db.collection("agent_sessions").doc(phone).update({
                    caregiverRescheduling: true,
                    stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });
                await (0, client_1.sendMessage)(chatId, "No problem — text me 2–3 times that work for you and I'll let the family know right away.");
            },
            PASS: async () => {
                var _a;
                await (0, interviewAgent_1.handleCaregiverAvailabilityReply)(phone, (_a = session.caregiverId) !== null && _a !== void 0 ? _a : "", "", chatId, "PASS");
            },
        };
        if (norm in KEYWORDS) {
            if (session.service === "iMessage")
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                await KEYWORDS[norm]();
            }
            finally {
                if (session.service === "iMessage")
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // YES / NO to replacement candidate request
        if (norm === "YES" || norm === "NO") {
            const candidateSnap = await db.collection("replacement_candidates")
                .where("phone", "==", phone)
                .where("status", "==", "contacted")
                .orderBy("contactedAt", "desc")
                .limit(1)
                .get();
            if (!candidateSnap.empty) {
                const candidate = candidateSnap.docs[0].data();
                const taskSnap = await db.collection("agent_tasks").doc(candidate.taskId).get();
                const task = taskSnap.data();
                if (task && task.status === "awaiting_approval") {
                    if (norm === "YES") {
                        await candidateSnap.docs[0].ref.update({ status: "available", respondedAt: new Date().toISOString() });
                        await (0, client_1.sendMessage)(chatId, "Got it — we'll confirm with the family and follow up shortly.");
                    }
                    else {
                        await candidateSnap.docs[0].ref.update({ status: "declined", respondedAt: new Date().toISOString() });
                        await (0, client_1.sendMessage)(chatId, "No worries — thanks for letting us know!");
                    }
                    return;
                }
            }
        }
        // Awaiting care notes after DONE
        if (session.awaitingCareNotes) {
            const cnExpiry = session.stateExpiresAt;
            if (cnExpiry && new Date(cnExpiry) < new Date()) {
                await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => { });
            }
            else {
                await handleCareNotes(phone, chatId, text, session);
                return;
            }
        }
        // Awaiting late minutes
        if (session.awaitingLateMinutes) {
            const lmExpiry = session.stateExpiresAt;
            if (lmExpiry && new Date(lmExpiry) < new Date()) {
                await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => { });
                // fall through to normal message processing
            }
            else {
                await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: false });
                const today2 = new Date().toISOString().slice(0, 10);
                const lateApptSnap = await db.collection("appointments")
                    .where("caregiverId", "==", (_21 = session.caregiverId) !== null && _21 !== void 0 ? _21 : "")
                    .where("date", "==", today2).limit(1).get();
                const clientPhone = lateApptSnap.empty ? null : await getClientPhoneForAppt(lateApptSnap.docs[0].data());
                // Record lateness event
                if (!lateApptSnap.empty && session.caregiverId) {
                    const lateApptData = lateApptSnap.docs[0].data();
                    const minutesLateNum = parseInt(text.replace(/\D/g, ""), 10);
                    if (!isNaN(minutesLateNum) && minutesLateNum > 0) {
                        const cgSnap2 = await db.collection("caregivers").doc(session.caregiverId).get();
                        const cgName2 = (_23 = (_22 = cgSnap2.data()) === null || _22 === void 0 ? void 0 : _22.name) !== null && _23 !== void 0 ? _23 : "Unknown";
                        const { recordLatenessEvent, checkLatenessPattern } = await Promise.resolve().then(() => __importStar(require("../agents/latenessTracker")));
                        recordLatenessEvent({
                            caregiverId: session.caregiverId,
                            caregiverName: cgName2,
                            appointmentId: lateApptSnap.docs[0].id,
                            clientId: (_24 = lateApptData.clientId) !== null && _24 !== void 0 ? _24 : "",
                            date: today2,
                            scheduledTime: ((_25 = lateApptData.startTime) !== null && _25 !== void 0 ? _25 : "").slice(0, 5),
                            minutesLate: minutesLateNum,
                            selfReported: true,
                        }).catch(() => { });
                        checkLatenessPattern(session.caregiverId, cgName2).catch(() => { });
                    }
                }
                if (clientPhone) {
                    const cgSnap = session.caregiverId
                        ? await db.collection("caregivers").doc(session.caregiverId).get()
                        : null;
                    const cgName = (_27 = (_26 = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _26 === void 0 ? void 0 : _26.name) !== null && _27 !== void 0 ? _27 : "Your caregiver";
                    const origTime = lateApptSnap.empty ? "" : ` (originally ${lateApptSnap.docs[0].data().startTime})`;
                    await (0, dndGuard_1.sendIfNotDND)(clientPhone, {
                        content: `${cgName} is running about ${text} late. They're on their way${origTime}.`,
                        urgency: "immediate",
                        sourceAgent: "late_notification",
                        canDrop: false,
                    }, "high");
                }
                await (0, client_1.sendMessage)(chatId, "I've notified the family. Drive safe.");
                return;
            }
        }
        // Awaiting issue description — smart classification + multi-level escalation
        if (session.awaitingIssueDescription) {
            const idExpiry = session.stateExpiresAt;
            if (idExpiry && new Date(idExpiry) < new Date()) {
                await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => { });
                // fall through to normal message processing
            }
            else {
                await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: false });
                const issueToday = new Date().toISOString().slice(0, 10);
                const issueApptSnap = await db.collection("appointments")
                    .where("caregiverId", "==", (_28 = session.caregiverId) !== null && _28 !== void 0 ? _28 : "")
                    .where("date", "==", issueToday)
                    .where("status", "in", ["confirmed", "in-progress"])
                    .limit(1).get();
                const issueAppt = issueApptSnap.empty ? null : issueApptSnap.docs[0].data();
                const clientPhone = issueApptSnap.empty ? null : await getClientPhoneForAppt(issueAppt);
                const cgSnap = session.caregiverId
                    ? await db.collection("caregivers").doc(session.caregiverId).get()
                    : null;
                const cgName = (_30 = (_29 = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _29 === void 0 ? void 0 : _29.name) !== null && _30 !== void 0 ? _30 : "Your caregiver";
                const seniorId = (_32 = (_31 = issueAppt === null || issueAppt === void 0 ? void 0 : issueAppt.seniorId) !== null && _31 !== void 0 ? _31 : issueAppt === null || issueAppt === void 0 ? void 0 : issueAppt.clientId) !== null && _32 !== void 0 ? _32 : "";
                const seniorSnap = seniorId ? await db.collection("senior_profiles").doc(seniorId).get() : null;
                const seniorName = (_35 = (_34 = (_33 = seniorSnap === null || seniorSnap === void 0 ? void 0 : seniorSnap.data()) === null || _33 === void 0 ? void 0 : _33.name) !== null && _34 !== void 0 ? _34 : issueAppt === null || issueAppt === void 0 ? void 0 : issueAppt.clientName) !== null && _35 !== void 0 ? _35 : "your client";
                const { handleCaregiverIssue } = await Promise.resolve().then(() => __importStar(require("../agents/issueEscalator")));
                await handleCaregiverIssue({
                    caregiverId: (_36 = session.caregiverId) !== null && _36 !== void 0 ? _36 : phone,
                    caregiverPhone: phone,
                    caregiverName: cgName,
                    appointmentId: issueApptSnap.empty ? "" : issueApptSnap.docs[0].id,
                    clientId: (_37 = issueAppt === null || issueAppt === void 0 ? void 0 : issueAppt.clientId) !== null && _37 !== void 0 ? _37 : "",
                    clientPhone: clientPhone !== null && clientPhone !== void 0 ? clientPhone : "",
                    seniorId,
                    seniorName,
                    description: text,
                }).catch(async (err) => {
                    var _a;
                    console.error("handleCaregiverIssue failed:", err);
                    // Fallback: write plain admin alert
                    await db.collection("admin_alerts").add({
                        type: "caregiver_issue",
                        caregiverId: (_a = session.caregiverId) !== null && _a !== void 0 ? _a : phone,
                        phone, description: text, severity: "medium",
                        createdAt: new Date().toISOString(), resolved: false,
                    });
                });
                await (0, client_1.sendMessage)(chatId, "I've flagged this for our team and notified the family. Thank you for letting me know.");
                return;
            } // end stateExpiresAt else
        }
        // Awaiting issue closure check (sent 20h after an ISSUE was filed)
        if (session.awaitingIssueClosureCheck) {
            const issueLogId = session.awaitingIssueClosureCheck;
            await db.collection("agent_sessions").doc(phone).update({
                awaitingIssueClosureCheck: admin.firestore.FieldValue.delete(),
            });
            const normReply = text.trim().toUpperCase();
            if (normReply === "YES" || normReply.startsWith("YES")) {
                await db.collection("issue_log").doc(issueLogId).update({
                    resolvedAt: new Date().toISOString(),
                }).catch(() => { });
                await (0, client_1.sendMessage)(chatId, "Good to hear — glad everything's okay.");
            }
            else {
                await (0, client_1.sendMessage)(chatId, "Thanks for the update — I've noted it. Let me know if anything changes.");
            }
            return;
        }
        // ── Wellbeing check-in response: "4 3 5" style reply ──────────────────────
        if (session.pendingWellbeingCheckin) {
            const parts = text.trim().split(/\s+/).map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 5);
            if (parts.length === 3) {
                const [energy, stress, satisfaction] = parts;
                await db.collection("wellbeing_checkins").add({
                    caregiverId: (_39 = (_38 = session.caregiverId) !== null && _38 !== void 0 ? _38 : session.userId) !== null && _39 !== void 0 ? _39 : phone,
                    phone,
                    energy,
                    stress,
                    satisfaction,
                    recordedAt: new Date().toISOString(),
                });
                await db.collection("agent_sessions").doc(phone).update({
                    pendingWellbeingCheckin: admin.firestore.FieldValue.delete(),
                });
                const avg = (energy + stress + satisfaction) / 3;
                const reply = avg < 3
                    ? `Thank you for being honest 💙 Your scores tell me you might need some support. Would you like to:\n\n1. Adjust your schedule\n2. Talk to our support team\n3. Get info on mental health resources\n\nReply 1, 2, or 3 — or just ignore this if you're okay.`
                    : `Thanks for checking in! Glad things are going well 😊 Keep up the great work — your clients are lucky to have you.`;
                await (0, client_1.sendMessage)(chatId, reply);
                return;
            }
        }
        // Caregiver rescheduling — parse new times and notify family
        if (session.caregiverRescheduling) {
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            let timeList = [];
            try {
                const parsed = await claude.messages.create({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 100,
                    system: "Extract interview time proposals from this message as a JSON array of human-readable strings. " +
                        "Reply with only a JSON array, e.g. [\"Tuesday 2pm\",\"Wednesday 10am\"]. Keep them short.",
                    messages: [{ role: "user", content: text }],
                });
                timeList = JSON.parse((_40 = parsed.content[0].text) !== null && _40 !== void 0 ? _40 : "[]");
            }
            catch ( /* fall through — use raw text below */_132) { /* fall through — use raw text below */ }
            const timesText = timeList.length > 0 ? timeList.join(", ") : text;
            // Find the relevant interview request
            const caregiverId = (_41 = session.caregiverId) !== null && _41 !== void 0 ? _41 : "";
            const cgSnap = caregiverId ? await db.collection("caregivers").doc(caregiverId).get() : null;
            const cgName = (_43 = (_42 = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _42 === void 0 ? void 0 : _42.name) !== null && _43 !== void 0 ? _43 : "Your caregiver";
            const reqSnap = await db.collection("interview_requests")
                .where("caregiverId", "==", caregiverId)
                .where("status", "in", ["scheduled", "awaiting_client_confirmation"])
                .orderBy("createdAt", "desc").limit(1).get();
            if (!reqSnap.empty) {
                const reqData = reqSnap.docs[0].data();
                const familyPhone = reqData.clientPhone;
                const familySession = await db.collection("agent_sessions").doc(familyPhone).get();
                if (familySession.exists) {
                    await (0, client_1.sendMessage)(familySession.data().chatId, `${cgName} needs to reschedule the interview.\n\n` +
                        `They're available: ${timesText}\n\n` +
                        `Reply with which time works, or PASS to find someone new.`);
                    // Let family's next reply be handled as a time selection
                    await db.collection("agent_sessions").doc(familyPhone).update({
                        pendingTimeSelection: { interviewRequestId: reqSnap.docs[0].id, caregiverName: cgName },
                        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    });
                }
                await reqSnap.docs[0].ref.update({ status: "awaiting_client_confirmation", caregiverAvailability: timeList });
            }
            // Clear the flag only after the family has been notified successfully
            await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: admin.firestore.FieldValue.delete() });
            await (0, client_1.sendMessage)(chatId, "Got it — I've sent those times to the family. I'll let you know once they confirm.");
            return;
        }
        // Caregiver availability reply (for interview scheduling)
        if (session.pendingInterviewAvailabilityRequest) {
            await (0, interviewAgent_1.handleCaregiverAvailabilityReply)(phone, (_44 = session.caregiverId) !== null && _44 !== void 0 ? _44 : "", "", chatId, text);
            return;
        }
        // ── Job alert: YES/NO/natural-language response ────────────────────────
        if (session.awaitingJobResponse === true) {
            if (session.service === "iMessage")
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                await (0, jobNotifications_1.handleJobResponse)(phone, text, chatId, session);
            }
            finally {
                if (session.service === "iMessage")
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── Job alert: availability confirmation (any text) ─────────────────────
        if (session.awaitingAvailabilityConfirmation === true) {
            if (session.service === "iMessage")
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                await (0, jobNotifications_1.handleAvailabilityConfirmation)(phone, text, chatId, session);
            }
            finally {
                if (session.service === "iMessage")
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
    }
    // ── Emergency contact capture — family replies with EC name + phone ──────────
    if (session.awaitingEmergencyContactUpdate) {
        await db.collection("agent_sessions").doc(phone).update({
            awaitingEmergencyContactUpdate: admin.firestore.FieldValue.delete(),
        });
        // Try to extract a phone number from the reply
        const ecPhoneMatch = text.match(/\+?[\d\s\-().]{10,}/);
        const ecPhone = ecPhoneMatch ? ecPhoneMatch[0].replace(/[\s\-().]/g, "") : null;
        const ecName = text.replace(/\+?[\d\s\-().]{10,}/g, "").trim().replace(/^[,;]+|[,;]+$/g, "").trim();
        const seniorId = (_46 = (_45 = session.seniorId) !== null && _45 !== void 0 ? _45 : session.userId) !== null && _46 !== void 0 ? _46 : "";
        if (ecPhone && seniorId) {
            await db.collection("senior_profiles").doc(seniorId).set({ emergencyContact: { phone: ecPhone, name: ecName || "Emergency Contact" } }, { merge: true });
            await (0, client_1.sendMessage)(chatId, `Got it — I've saved ${ecName || "your emergency contact"} (${ecPhone}) for ${(_48 = (_47 = session.onboardingData) === null || _47 === void 0 ? void 0 : _47.seniorName) !== null && _48 !== void 0 ? _48 : "your family member"}. They'll be contacted if there's ever an urgent issue.`);
        }
        else {
            await (0, client_1.sendMessage)(chatId, "I wasn't able to find a phone number in that message. Please reply with your emergency contact's name and phone number (e.g. 'John Smith 555-000-1234').");
            await db.collection("agent_sessions").doc(phone).update({ awaitingEmergencyContactUpdate: true });
        }
        return;
    }
    // ── Shift hours APPROVE / DISPUTE (client iMessage reply) ───────────────────
    if (session.pendingShiftApproval && (norm === "APPROVE" || norm.startsWith("DISPUTE"))) {
        const { appointmentId, amount, caregiverName } = session.pendingShiftApproval;
        if (norm === "APPROVE") {
            const { approveShiftHoursForClient } = await Promise.resolve().then(() => __importStar(require("../shiftHours")));
            await approveShiftHoursForClient(appointmentId);
            await (0, client_1.sendMessage)(chatId, `Approved. ${caregiverName} will be paid $${amount}.`);
        }
        else {
            // Create admin alert and set a pending state to capture the follow-up detail
            const alertRef = await db.collection("admin_alerts").add({
                type: "shift_hours_disputed",
                appointmentId,
                caregiverName,
                amount,
                clientPhone: phone,
                createdAt: new Date().toISOString(),
                resolved: false,
                detail: null,
            });
            await db.collection("agent_sessions").doc(phone).update({
                pendingShiftApproval: admin.firestore.FieldValue.delete(),
                pendingDisputeDetail: { alertId: alertRef.id, caregiverName },
            });
            await (0, client_1.sendMessage)(chatId, `Got it — flagged for review. Our team will follow up within 24 hours.\n\n` +
                `What looks wrong with the hours? (reply to add details, or just ignore this message)`);
            return;
        }
        await db.collection("agent_sessions").doc(phone).update({ pendingShiftApproval: admin.firestore.FieldValue.delete() });
        return;
    }
    // ── Shift hours dispute detail — follow-up message after DISPUTE ────────────
    if (session.pendingDisputeDetail) {
        const { alertId, caregiverName: cgName } = session.pendingDisputeDetail;
        await db.collection("admin_alerts").doc(alertId).update({ detail: text });
        await db.collection("agent_sessions").doc(phone).update({
            pendingDisputeDetail: admin.firestore.FieldValue.delete(),
        });
        await (0, client_1.sendMessage)(chatId, `Thanks — I've added your note to the dispute. Our team will review the hours for ${cgName} and get back to you.`);
        return;
    }
    // ── Credential collection (portal logins) ─────────────────────────────────
    // Must run before intent classification — password messages must not be logged.
    if (session.collectingCredential) {
        const { handleCredentialReply } = await Promise.resolve().then(() => __importStar(require("../browser/credentialCollector")));
        const handled = await handleCredentialReply({
            phone,
            userId: (_49 = session.userId) !== null && _49 !== void 0 ? _49 : "",
            text,
            session: session,
        });
        if (handled)
            return;
    }
    // ── Job posting flow — multi-step state machine for returning clients ───────
    if (session.jobPostingStep) {
        const jpExpiry = session.stateExpiresAt;
        if (jpExpiry && new Date(jpExpiry) < new Date()) {
            await db.collection("agent_sessions").doc(phone).update({
                jobPostingStep: admin.firestore.FieldValue.delete(),
                jobPostingData: admin.firestore.FieldValue.delete(),
                stateExpiresAt: admin.firestore.FieldValue.delete(),
            });
            await (0, client_1.sendMessage)(chatId, "Your job posting session timed out. Text me anytime to start a new one!");
            return;
        }
        if (session.service === "iMessage" && !session.groupChatId)
            await (0, client_1.startTyping)(chatId).catch(() => { });
        try {
            await (0, jobPostingFlow_1.handleJobPostingStep)(phone, chatId, text, session);
        }
        finally {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.stopTyping)(chatId).catch(() => { });
        }
        return;
    }
    // ── Recurring schedule modification flow ─────────────────────────────────
    if (session.modifyScheduleStep) {
        if (session.service === "iMessage" && !session.groupChatId)
            await (0, client_1.startTyping)(chatId).catch(() => { });
        try {
            await (0, modifyScheduleFlow_1.handleModifyScheduleStep)(phone, chatId, text, session);
        }
        finally {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.stopTyping)(chatId).catch(() => { });
        }
        return;
    }
    // ── Refund self-service flow (multi-step state machine) ───────────────────
    if (session.refundStep) {
        if (session.service === "iMessage" && !session.groupChatId)
            await (0, client_1.startTyping)(chatId).catch(() => { });
        try {
            const refundClientId = ((_50 = session.userId) !== null && _50 !== void 0 ? _50 : phone);
            await (0, refundHandler_1.handleRefundRequest)(refundClientId, text, session, (msg) => (0, client_1.sendMessage)(chatId, msg));
        }
        finally {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.stopTyping)(chatId).catch(() => { });
        }
        return;
    }
    // ── Pending rematching after interview cancelled due to availability change ──
    if (session.pendingRematch && (norm === "YES" || norm === "Y")) {
        await db.collection("agent_sessions").doc(phone).update({ pendingRematch: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete() });
        const sd = (_51 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _51 !== void 0 ? _51 : {};
        const { runMatchingForClient: rmfcPendingRematch } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
        await rmfcPendingRematch(phone, chatId, sd, sd);
        return;
    }
    // ── Check for pending task (booking / emergency replacement) ───────────────
    const taskSnap = await db
        .collection("agent_tasks")
        .where("clientPhone", "==", phone)
        .where("status", "==", "awaiting_approval")
        .orderBy("createdAt", "desc").limit(1).get();
    const pendingTask = taskSnap.empty ? null : taskSnap.docs[0];
    if (session.service === "iMessage" && !session.groupChatId)
        await (0, client_1.startTyping)(chatId).catch(() => { });
    try {
        const intent = await (0, intentClassifier_1.classifyIntent)(text, !!pendingTask);
        // ── Emergency replacement: 1/2/3 ─────────────────────────────────────────
        if (intent === "TASK_REPLY" && pendingTask && ["1", "2", "3"].includes(text.trim())) {
            await (0, taskApprovalHandler_1.handleTaskApproval)(pendingTask, text.trim(), session, chatId);
            return;
        }
        // ── BOOKING_CONFIRM — natural language YES ("sure", "sounds good", etc.) ──
        if (intent === "BOOKING_CONFIRM") {
            if (session.awaitingRecurringConfirmation) {
                await handleRecurringConfirm(phone, chatId, session);
                return;
            }
            if (pendingTask && pendingTask.data().type === "booking_confirmation") {
                try {
                    await (0, bookingExecutor_1.executeBookings)(pendingTask.id, phone);
                }
                catch (err) {
                    console.error("executeBookings failed (BOOKING_CONFIRM):", err);
                    await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
                    await (0, client_1.sendMessage)(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
                    const sd = (_52 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _52 !== void 0 ? _52 : {};
                    const { runMatchingForClient: rmfc } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
                    await rmfc(phone, chatId, sd, sd).catch(() => { });
                }
                return;
            }
            if (session.pendingInterviewConfirm) {
                await (0, interviewAgent_1.handleInterviewConfirm)(phone, chatId, session);
                return;
            }
            if (session.pendingCancelConfirm) {
                const { appointmentId } = session.pendingCancelConfirm;
                const apptRef = db.collection("appointments").doc(appointmentId);
                const apptSnap = await apptRef.get();
                if (apptSnap.exists) {
                    const appt = apptSnap.data();
                    await apptRef.update({ status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
                    const cgSnap = await db.collection("caregivers").doc(appt.caregiverId).get();
                    const cgPhone = (_53 = cgSnap.data()) === null || _53 === void 0 ? void 0 : _53.phone;
                    if (cgPhone) {
                        const cgSess = await (await Promise.resolve().then(() => __importStar(require("./client")))).getOrCreateSession(cgPhone);
                        await (0, client_1.sendMessage)(cgSess.chatId, `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`);
                    }
                }
                await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
                await (0, client_1.sendMessage)(chatId, "Cancelled. Want me to find a replacement for that day?");
                return;
            }
        }
        // ── BOOKING_DECLINE — natural language NO ("never mind", "don't book", etc.) ──
        if (intent === "BOOKING_DECLINE") {
            if (session.awaitingRecurringConfirmation) {
                await db.collection("agent_sessions").doc(phone).update({
                    awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
                    pendingRecurringSchedule: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, "No problem — I'll keep each visit booked individually. You can set up a recurring schedule anytime.");
                return;
            }
            if (pendingTask && pendingTask.data().type === "booking_confirmation") {
                await pendingTask.ref.update({ status: "declined" });
                await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
                await (0, client_1.sendMessage)(chatId, "No problem — booking cancelled. Want me to look at different dates or a different caregiver?");
                return;
            }
            if (session.pendingInterviewConfirm) {
                const pending = session.pendingInterviewConfirm;
                await db.collection("agent_sessions").doc(phone).update({ pendingInterviewConfirm: admin.firestore.FieldValue.delete() });
                const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
                const availability = ((_55 = (_54 = reqSnap.data()) === null || _54 === void 0 ? void 0 : _54.caregiverAvailability) !== null && _55 !== void 0 ? _55 : []);
                const remaining = availability.filter(t => t !== pending.mutualTime);
                if (remaining.length > 0) {
                    const timesList = remaining.map((t, i) => `${i + 1}. ${t}`).join("\n");
                    await db.collection("agent_sessions").doc(phone).update({
                        pendingTimeSelection: { interviewRequestId: pending.docId, caregiverName: pending.caregiverName },
                        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    });
                    await (0, client_1.sendMessage)(chatId, `No problem! ${pending.caregiverName} also offered:\n\n${timesList}\n\nReply with which time works, or PASS to find someone else.`);
                }
                else {
                    // No more times — mark request client_declined and check if all candidates exhausted
                    await db.collection("interview_requests").doc(pending.docId).update({ status: "client_declined", clientDeclinedAt: new Date().toISOString() }).catch(() => { });
                    const { checkAndTriggerRematching } = await Promise.resolve().then(() => __importStar(require("../triggers/triggerEngine")));
                    await checkAndTriggerRematching(phone, "").catch(() => { });
                }
                return;
            }
            if (session.pendingCancelConfirm) {
                await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
                await (0, client_1.sendMessage)(chatId, "Got it — visit is still on! Let me know if you need anything.");
                return;
            }
        }
        // ── HIRE_CAREGIVER — "let's go with Maria", "hire James" ─────────────────
        if (intent === "HIRE_CAREGIVER") {
            const pending = session.pendingInterviewOutcome;
            if (pending) {
                let caregiverId = (_56 = pending.caregiverId) !== null && _56 !== void 0 ? _56 : "";
                if (!caregiverId && pending.interviewId) {
                    const reqSnap = await db.collection("interview_requests")
                        .where("interviewId", "==", pending.interviewId).limit(1).get();
                    if (!reqSnap.empty)
                        caregiverId = (_57 = reqSnap.docs[0].data().caregiverId) !== null && _57 !== void 0 ? _57 : "";
                }
                await db.collection("agent_sessions").doc(phone).update({
                    hireMode: { caregiverName: pending.caregiverName, caregiverId },
                    pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });
                if (caregiverId)
                    (0, interviewAgent_1.writeInterviewOutcomeSignal)((_58 = session.userId) !== null && _58 !== void 0 ? _58 : phone, caregiverId, "hire").catch(() => { });
                await (0, client_1.sendMessage)(chatId, `${pending.caregiverName} sounds like a great fit. When would you like care to start?`);
                return;
            }
            await (0, client_1.sendMessage)(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
            return;
        }
        // ── CAREGIVER_DECLINE_JOB — natural language job decline from caregiver ──
        if (intent === "CAREGIVER_DECLINE_JOB" && session.userType === "caregiver") {
            if (session.pendingJobId) {
                await (0, jobNotifications_1.handleJobResponse)(phone, "NO", chatId, session);
            }
            else {
                await (0, client_1.sendMessage)(chatId, "No worries — I'll reach out when something comes up.");
            }
            return;
        }
        // ── YES — booking, recurring setup, or interview confirmation ───────────────
        if (norm === "YES" || norm === "Y") {
            // YES to recurring schedule setup
            if (session.awaitingRecurringConfirmation) {
                await handleRecurringConfirm(phone, chatId, session);
                return;
            }
            if (pendingTask && pendingTask.data().type === "booking_confirmation") {
                try {
                    await (0, bookingExecutor_1.executeBookings)(pendingTask.id, phone);
                }
                catch (err) {
                    console.error("executeBookings failed (YES):", err);
                    await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
                    await (0, client_1.sendMessage)(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
                    const sd = (_59 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _59 !== void 0 ? _59 : {};
                    const { runMatchingForClient: rmfc4 } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
                    await rmfc4(phone, chatId, sd, sd).catch(() => { });
                }
                return;
            }
            if (session.pendingInterviewConfirm) {
                await (0, interviewAgent_1.handleInterviewConfirm)(phone, chatId, session);
                return;
            }
            // YES to cancel confirmation
            if (session.pendingCancelConfirm) {
                const { appointmentId } = session.pendingCancelConfirm;
                const apptRef = db.collection("appointments").doc(appointmentId);
                const apptSnap = await apptRef.get();
                if (apptSnap.exists) {
                    const appt = apptSnap.data();
                    await apptRef.update({ status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
                    // Notify caregiver
                    const cgSnap = await db.collection("caregivers").doc(appt.caregiverId).get();
                    const cgPhone = (_60 = cgSnap.data()) === null || _60 === void 0 ? void 0 : _60.phone;
                    if (cgPhone) {
                        const cgSess = await (await Promise.resolve().then(() => __importStar(require("./client")))).getOrCreateSession(cgPhone);
                        await (0, client_1.sendMessage)(cgSess.chatId, `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`);
                    }
                }
                await db.collection("agent_sessions").doc(phone).update({
                    pendingCancelConfirm: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, "Cancelled. Want me to find a replacement for that day?");
                return;
            }
        }
        // ── NO — recurring setup declined, booking declined, or interview time rejected ──
        if (norm === "NO" || norm === "N") {
            // NO to recurring schedule setup
            if (session.awaitingRecurringConfirmation) {
                await db.collection("agent_sessions").doc(phone).update({
                    awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
                    pendingRecurringSchedule: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, "No problem — I'll keep each visit booked individually. You can set up a recurring schedule anytime.");
                return;
            }
            // NO to booking summary
            if (pendingTask && pendingTask.data().type === "booking_confirmation") {
                await pendingTask.ref.update({ status: "declined" });
                await db.collection("agent_sessions").doc(phone).update({
                    pendingCancelConfirm: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, "No problem — booking cancelled. Want me to look at different dates or a different caregiver?");
                return;
            }
            // NO to interview time — show other available times or offer alternatives
            if (session.pendingInterviewConfirm) {
                const pending = session.pendingInterviewConfirm;
                await db.collection("agent_sessions").doc(phone).update({
                    pendingInterviewConfirm: admin.firestore.FieldValue.delete(),
                });
                // Check if caregiver offered more times
                const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
                const availability = ((_62 = (_61 = reqSnap.data()) === null || _61 === void 0 ? void 0 : _61.caregiverAvailability) !== null && _62 !== void 0 ? _62 : []);
                // Remove the time we just rejected
                const remaining = availability.filter(t => t !== pending.mutualTime);
                if (remaining.length > 0) {
                    const timesList = remaining.map((t, i) => `${i + 1}. ${t}`).join("\n");
                    await db.collection("agent_sessions").doc(phone).update({
                        pendingTimeSelection: { interviewRequestId: pending.docId, caregiverName: pending.caregiverName },
                        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    });
                    await (0, client_1.sendMessage)(chatId, `No problem! ${pending.caregiverName} also offered:\n\n${timesList}\n\nReply with which time works, or PASS to find someone else.`);
                }
                else {
                    await (0, client_1.sendMessage)(chatId, `Understood. Want me to ask ${pending.caregiverName} for different times, or reach out to the next best caregiver?`);
                }
                return;
            }
            // NO to cancel confirmation — abort the cancellation
            if (session.pendingCancelConfirm) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingCancelConfirm: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, "Got it — visit is still on! Let me know if you need anything.");
                return;
            }
        }
        // ── CONFIRM / SKIP — finalizes a pending task selection made by 1/2/3 ──────
        if (norm === "CONFIRM" && session.pendingTaskConfirm) {
            const { finalizeTaskApproval } = await Promise.resolve().then(() => __importStar(require("../agents/taskApprovalHandler")));
            await finalizeTaskApproval(phone, chatId, session);
            return;
        }
        if (norm === "SKIP" && session.pendingTaskConfirm) {
            await db.collection("agent_sessions").doc(phone).update({
                pendingTaskConfirm: admin.firestore.FieldValue.delete(),
            });
            await (0, client_1.sendMessage)(chatId, "No problem — want me to find a different caregiver?");
            return;
        }
        // ── Post-interview outcome: classify natural language as HIRE/MAYBE/PASS ──
        const pendingOutcome = session.pendingInterviewOutcome;
        if (pendingOutcome && norm !== "HIRE" && norm !== "MAYBE" && norm !== "PASS") {
            try {
                const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
                const _ac = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
                const _r = await _ac.messages.create({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 10,
                    system: "The user just interviewed a caregiver and is sharing their thoughts. " +
                        "Classify as HIRE (positive, wants to proceed), MAYBE (uncertain, not sure), " +
                        "or PASS (negative, concerns, didn't click). Reply with one word only.",
                    messages: [{ role: "user", content: text }],
                });
                const classified = ((_63 = _r.content[0].text) !== null && _63 !== void 0 ? _63 : "").trim().toUpperCase();
                if (classified === "HIRE" || classified === "MAYBE" || classified === "PASS") {
                    // Re-enter with classified keyword — will be picked up by the checks below
                    text; // text is const; shadow norm instead
                    Object.assign(session, {}); // keep session reference
                    // Override norm for the blocks below
                    const resolvedNorm = classified;
                    if (resolvedNorm === "HIRE") {
                        let caregiverId = (_64 = pendingOutcome.caregiverId) !== null && _64 !== void 0 ? _64 : "";
                        if (!caregiverId && pendingOutcome.interviewId) {
                            const reqSnap = await db.collection("interview_requests")
                                .doc(pendingOutcome.interviewId).get();
                            if (reqSnap.exists)
                                caregiverId = (_66 = (_65 = reqSnap.data()) === null || _65 === void 0 ? void 0 : _65.caregiverId) !== null && _66 !== void 0 ? _66 : "";
                        }
                        await db.collection("agent_sessions").doc(phone).update({
                            hireMode: { caregiverName: pendingOutcome.caregiverName, caregiverId },
                            pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                        });
                        if (caregiverId) {
                            (0, interviewAgent_1.writeInterviewOutcomeSignal)((_67 = session.userId) !== null && _67 !== void 0 ? _67 : phone, caregiverId, "hire").catch(() => { });
                        }
                        await (0, client_1.sendMessage)(chatId, `${pendingOutcome.caregiverName} sounds like a great fit. When would you like care to start?`);
                    }
                    else if (resolvedNorm === "MAYBE") {
                        const updates = {
                            pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                        };
                        if (pendingOutcome.caregiverId) {
                            updates.rejectedCaregiverIds = admin.firestore.FieldValue.arrayUnion(pendingOutcome.caregiverId);
                        }
                        await db.collection("agent_sessions").doc(phone).update(updates);
                        await (0, client_1.sendMessage)(chatId, `That's okay — want me to reach out to anyone else in the meantime?`);
                    }
                    else {
                        const updates = {
                            pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                        };
                        if (pendingOutcome.caregiverId) {
                            updates.rejectedCaregiverIds = admin.firestore.FieldValue.arrayUnion(pendingOutcome.caregiverId);
                            (0, interviewAgent_1.writeInterviewOutcomeSignal)((_68 = session.userId) !== null && _68 !== void 0 ? _68 : phone, pendingOutcome.caregiverId, "pass").catch(() => { });
                        }
                        await db.collection("agent_sessions").doc(phone).update(updates);
                        await (0, client_1.sendMessage)(chatId, `Understood. Want me to search for more caregivers? Reply YES and I'll get started.`);
                    }
                    return;
                }
            }
            catch (err) {
                console.error("interview outcome classification error:", err);
            }
        }
        // ── HIRE — post-interview decision ────────────────────────────────────────
        if (norm === "HIRE") {
            const pending = session.pendingInterviewOutcome;
            if (pending) {
                // Resolve caregiverId from interview_requests if not already on pending
                let caregiverId = (_69 = pending.caregiverId) !== null && _69 !== void 0 ? _69 : "";
                if (!caregiverId && pending.interviewId) {
                    const reqSnap = await db.collection("interview_requests")
                        .where("interviewId", "==", pending.interviewId)
                        .limit(1).get();
                    if (!reqSnap.empty)
                        caregiverId = (_70 = reqSnap.docs[0].data().caregiverId) !== null && _70 !== void 0 ? _70 : "";
                }
                await db.collection("agent_sessions").doc(phone).update({
                    hireMode: { caregiverName: pending.caregiverName, caregiverId },
                    pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });
                if (caregiverId) {
                    (0, interviewAgent_1.writeInterviewOutcomeSignal)((_71 = session.userId) !== null && _71 !== void 0 ? _71 : phone, caregiverId, "hire").catch(() => { });
                }
                await (0, client_1.sendMessage)(chatId, `${pending.caregiverName} sounds like a great fit. When would you like care to start?`);
                return;
            }
            // No pending outcome — ask who
            await (0, client_1.sendMessage)(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
            return;
        }
        // ── MAYBE / PASS — post-interview ─────────────────────────────────────────
        if (norm === "MAYBE" || norm === "PASS") {
            const pending = session.pendingInterviewOutcome;
            if (pending) {
                const updates = {
                    pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                };
                if (pending.caregiverId) {
                    updates.rejectedCaregiverIds = admin.firestore.FieldValue.arrayUnion(pending.caregiverId);
                    if (norm === "PASS") {
                        (0, interviewAgent_1.writeInterviewOutcomeSignal)((_72 = session.userId) !== null && _72 !== void 0 ? _72 : phone, pending.caregiverId, "pass").catch(() => { });
                    }
                }
                await db.collection("agent_sessions").doc(phone).update(updates);
                if (norm === "MAYBE") {
                    await (0, client_1.sendMessage)(chatId, `Got it — I'll keep ${pending.caregiverName} in mind. Want me to reach out to anyone else?`);
                }
                else {
                    await (0, client_1.sendMessage)(chatId, `Understood. Want me to search for more caregivers? Reply YES and I'll get started.`);
                }
                return;
            }
        }
        // ── Caregiver selection (numbers after match presentation) ────────────────
        if (((_73 = session.pendingMatches) === null || _73 === void 0 ? void 0 : _73.length) > 0 && /[123]|all/i.test(text)) {
            await (0, interviewAgent_1.handleInterviewSelection)(phone, chatId, text, session);
            return;
        }
        // ── Recurring schedule: RESUME keyword ───────────────────────────────────
        if (norm === "RESUME SCHEDULE" || norm === "RESUME") {
            if (session.activeRecurringScheduleId) {
                await handleRecurringResume(phone, chatId, session);
                return;
            }
        }
        // ── Recurring schedule: PAUSE / CANCEL via intent ─────────────────────────
        if (intent === "PAUSE_SCHEDULE") {
            await handleRecurringPause(phone, chatId, session);
            return;
        }
        if (intent === "CANCEL_SCHEDULE") {
            await handleRecurringCancel(phone, chatId, session);
            return;
        }
        // ── Permission update ─────────────────────────────────────────────────────
        if (intent === "PERMISSION_UPDATE") {
            const userId = (_75 = (_74 = session.userId) !== null && _74 !== void 0 ? _74 : session.caregiverId) !== null && _75 !== void 0 ? _75 : phone;
            const userType = (_76 = session.userType) !== null && _76 !== void 0 ? _76 : "client";
            await (0, permissionsConversation_1.updatePermissionFromText)(userId, userType, phone, chatId, text);
            return;
        }
        if (intent === "MEMORY_QUERY") {
            const zepUserId = (0, zepClient_1.getZepUserId)(phone);
            const zepFacts = await (0, zepClient_1.searchZepMemory)(zepUserId, text).catch(() => "");
            const memUserId = (_78 = (_77 = session.userId) !== null && _77 !== void 0 ? _77 : session.caregiverId) !== null && _78 !== void 0 ? _78 : phone;
            const { handleMemoryQuery } = await Promise.resolve().then(() => __importStar(require("../memory/memoryFiles")));
            await handleMemoryQuery(memUserId, chatId, client_1.sendMessage, zepFacts || undefined);
            return;
        }
        if (intent === "ADD_FAMILY_MEMBER") {
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const extraction = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 80,
                system: "Extract the name and phone number from this message. Reply with JSON only: {\"name\": \"...\", \"phone\": \"+1...\"}. If no phone found, phone = null.",
                messages: [{ role: "user", content: text }],
            });
            let memberName = null;
            let memberPhone = null;
            try {
                const parsed = JSON.parse((_79 = extraction.content[0].text) !== null && _79 !== void 0 ? _79 : "{}");
                memberName = (_80 = parsed.name) !== null && _80 !== void 0 ? _80 : null;
                memberPhone = (_81 = parsed.phone) !== null && _81 !== void 0 ? _81 : null;
            }
            catch ( /* */_133) { /* */ }
            if (!memberPhone) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch a phone number — please include it (e.g. 'add my sister Sarah at +1 555 000 1234').");
                return;
            }
            // Add to groupMembers array in session
            await db.collection("agent_sessions").doc(phone).update({
                groupMembers: admin.firestore.FieldValue.arrayUnion(memberPhone),
            });
            // Add to family_group_members collection
            await db.collection("family_group_members").add({
                primaryPhone: phone,
                memberPhone,
                memberName: memberName !== null && memberName !== void 0 ? memberName : "Family member",
                userId: (_82 = session.userId) !== null && _82 !== void 0 ? _82 : phone,
                addedAt: new Date().toISOString(),
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: `Done — ${memberName !== null && memberName !== void 0 ? memberName : memberPhone} is now in your care group. They'll get the same updates you do.`,
                urgency: "standard",
                sourceAgent: "family_group",
                canDrop: false,
            });
            return;
        }
        if (intent === "REMOVE_FAMILY_MEMBER") {
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const extraction = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 80,
                system: "Extract the name and/or phone number of the person to remove from this message. Reply with JSON only: {\"name\": \"...\", \"phone\": \"+1...\"}. If no phone found, phone = null.",
                messages: [{ role: "user", content: text }],
            });
            let targetName = null;
            let targetPhone = null;
            try {
                const parsed = JSON.parse((_83 = extraction.content[0].text) !== null && _83 !== void 0 ? _83 : "{}");
                targetName = (_84 = parsed.name) !== null && _84 !== void 0 ? _84 : null;
                targetPhone = (_85 = parsed.phone) !== null && _85 !== void 0 ? _85 : null;
            }
            catch ( /* */_134) { /* */ }
            // If no phone provided, try to resolve by name from family_group_members
            if (!targetPhone && targetName) {
                const memberSnap = await db.collection("family_group_members")
                    .where("primaryPhone", "==", phone)
                    .get();
                const match = memberSnap.docs.find(d => { var _a; return ((_a = d.data().memberName) !== null && _a !== void 0 ? _a : "").toLowerCase().includes(targetName.toLowerCase()); });
                if (match)
                    targetPhone = match.data().memberPhone;
            }
            if (!targetPhone) {
                await (0, client_1.sendMessage)(chatId, "I didn't find that person in your care group. Try including their phone number (e.g. 'remove +1 555 000 1234').");
                return;
            }
            // Look up seniorId from session
            const seniorId = (_87 = (_86 = session.seniorId) !== null && _86 !== void 0 ? _86 : session.userId) !== null && _87 !== void 0 ? _87 : phone;
            const { removeMemberFromGroup } = await Promise.resolve().then(() => __importStar(require("../agents/familyGroupManager")));
            const result = await removeMemberFromGroup(seniorId, targetPhone);
            if (result.removed) {
                // Also remove from family_group_members collection and session
                const memberSnap = await db.collection("family_group_members")
                    .where("primaryPhone", "==", phone)
                    .where("memberPhone", "==", targetPhone)
                    .limit(1)
                    .get();
                if (!memberSnap.empty)
                    await memberSnap.docs[0].ref.delete();
                await db.collection("agent_sessions").doc(phone).update({
                    groupMembers: admin.firestore.FieldValue.arrayRemove(targetPhone),
                }).catch(() => { });
                await (0, client_1.sendMessage)(chatId, `Done — ${targetName !== null && targetName !== void 0 ? targetName : targetPhone} has been removed from your care group. They'll no longer receive updates.`);
            }
            else {
                await (0, client_1.sendMessage)(chatId, `I couldn't find ${targetName !== null && targetName !== void 0 ? targetName : targetPhone} in your care group. Let me know if you need help.`);
            }
            return;
        }
        // ── hireMode step B — schedule reply ─────────────────────────────────────
        if (session.hireMode && session.hireModeDate) {
            const hire = session.hireMode;
            const dateStr = session.hireModeDate;
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsedSchedule = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 120,
                system: "Extract a weekly care schedule from this message. " +
                    "Reply with only a JSON object: { \"days\": [\"Monday\",\"Wednesday\",\"Friday\"], " +
                    "\"startTime\": \"9:00 AM\", \"endTime\": \"1:00 PM\", \"durationHours\": 4 }. " +
                    "days must be full day names. durationHours is a number.",
                messages: [{ role: "user", content: text }],
            });
            let schedule = null;
            try {
                schedule = JSON.parse((_88 = parsedSchedule.content[0].text) !== null && _88 !== void 0 ? _88 : "null");
            }
            catch ( /* */_135) { /* */ }
            if (!schedule || !((_89 = schedule.days) === null || _89 === void 0 ? void 0 : _89.length)) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch that — could you try again? (e.g. '3 days, Mon/Wed/Fri, 9am–1pm')");
                return;
            }
            // Fetch actual hourly rate from caregiver doc
            const cgDoc = await db.collection("caregivers").doc(hire.caregiverId).get();
            const hourlyRate = ((_91 = (_90 = cgDoc.data()) === null || _90 === void 0 ? void 0 : _90.hourlyRate) !== null && _91 !== void 0 ? _91 : 20);
            // Build one appointment per day starting from the hire date's week
            const startDate = new Date(dateStr + "T12:00:00Z");
            const dayIndexMap = {
                Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
            };
            const appointments = [];
            for (const day of schedule.days) {
                const target = (_92 = dayIndexMap[day]) !== null && _92 !== void 0 ? _92 : -1;
                if (target < 0)
                    continue;
                const d = new Date(startDate);
                const diff = (target - d.getUTCDay() + 7) % 7;
                d.setUTCDate(d.getUTCDate() + diff);
                appointments.push({
                    date: d.toISOString().slice(0, 10),
                    startTime: schedule.startTime,
                    endTime: schedule.endTime,
                    durationHours: schedule.durationHours,
                });
            }
            const clientId = (_93 = session.userId) !== null && _93 !== void 0 ? _93 : phone;
            const taskId = await (0, bookingExecutor_1.createBookingTask)({
                clientPhone: phone,
                clientId,
                caregiverId: hire.caregiverId,
                caregiverName: hire.caregiverName,
                appointments,
                hourlyRate,
            });
            await db.collection("agent_sessions").doc(phone).update({
                hireMode: admin.firestore.FieldValue.delete(),
                hireModeDate: admin.firestore.FieldValue.delete(),
            });
            const perms = await (0, permissionsConversation_1.getPermissions)((_94 = session.userId) !== null && _94 !== void 0 ? _94 : phone).catch(() => null);
            if (perms === null || perms === void 0 ? void 0 : perms.canBookAutomatically) {
                try {
                    await (0, bookingExecutor_1.executeBookings)(taskId, phone);
                }
                catch (err) {
                    console.error("executeBookings failed (hireMode):", err);
                    await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
                    await (0, client_1.sendMessage)(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
                    const sd = (_95 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _95 !== void 0 ? _95 : {};
                    const { runMatchingForClient: rmfc2 } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
                    await rmfc2(phone, chatId, sd, sd).catch(() => { });
                }
            }
            else {
                const totalCost = (appointments.length * schedule.durationHours * hourlyRate).toFixed(2);
                const lines = appointments.map(a => `${a.date} · ${a.startTime}–${a.endTime}`).join("\n");
                await (0, client_1.sendMessage)(chatId, `Here's your booking summary:\n\n${lines}\n${hire.caregiverName} · $${totalCost} total\n\nReply YES to confirm or NO to cancel.`);
            }
            return;
        }
        // ── hireMode step A — date reply ──────────────────────────────────────────
        if (session.hireMode && !session.hireModeDate) {
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsedDate = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 20,
                system: `Today is ${new Date().toISOString().slice(0, 10)}. ` +
                    "The user is choosing a start date for care. Reply with only a YYYY-MM-DD date string, nothing else.",
                messages: [{ role: "user", content: text }],
            });
            const dateStr = ((_96 = parsedDate.content[0].text) !== null && _96 !== void 0 ? _96 : "").trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch that date — could you try again? (e.g. \"next Monday\" or \"May 19\")");
                return;
            }
            await db.collection("agent_sessions").doc(phone).update({
                hireModeDate: dateStr,
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            await (0, client_1.sendMessage)(chatId, `Got it — starting ${dateStr}.\n\nHow many days a week and what hours? (e.g. "3 days, Mon/Wed/Fri, 9am–1pm")`);
            return;
        }
        // ── pendingTimeSelection — family picking from caregiver's offered times ──
        if (session.pendingTimeSelection) {
            const sel = session.pendingTimeSelection;
            if (norm === "PASS") {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingTimeSelection: admin.firestore.FieldValue.delete(),
                });
                await db.collection("interview_requests").doc(sel.interviewRequestId).update({ status: "client_declined" });
                await (0, client_1.sendMessage)(chatId, `No problem — want me to reach out to the next best caregiver? Reply YES and I'll get on it.`);
                return;
            }
            // Parse which time the family chose
            const reqSnap = await db.collection("interview_requests").doc(sel.interviewRequestId).get();
            const availability = ((_98 = (_97 = reqSnap.data()) === null || _97 === void 0 ? void 0 : _97.caregiverAvailability) !== null && _98 !== void 0 ? _98 : []);
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsed = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 60,
                system: `Available times: ${availability.join(", ")}. ` +
                    "The user picked one of these times. Reply with only the exact string from the list that best matches their reply, or 'NONE' if no match.",
                messages: [{ role: "user", content: text }],
            });
            const chosen = ((_99 = parsed.content[0].text) !== null && _99 !== void 0 ? _99 : "").trim();
            if (chosen === "NONE" || !availability.includes(chosen)) {
                await (0, client_1.sendMessage)(chatId, `I didn't catch that — which of these works for you?\n\n${availability.join("\n")}\n\nOr reply PASS to find someone else.`);
                return;
            }
            // Book the chosen time
            await db.collection("agent_sessions").doc(phone).update({
                pendingTimeSelection: admin.firestore.FieldValue.delete(),
                pendingInterviewConfirm: { docId: sel.interviewRequestId, caregiverName: sel.caregiverName, mutualTime: chosen, formatted: chosen },
            });
            await (0, interviewAgent_1.handleInterviewConfirm)(phone, chatId, Object.assign(Object.assign({}, session), { pendingInterviewConfirm: { docId: sel.interviewRequestId, caregiverName: sel.caregiverName, mutualTime: chosen, formatted: chosen } }));
            return;
        }
        // ── CANCEL intent — cancel a visit, NOT an opt-out ────────────────────────
        if (intent === "CANCEL_REQUEST" || norm === "CANCEL") {
            const clientId = (_100 = session.userId) !== null && _100 !== void 0 ? _100 : phone;
            const upcoming = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "==", "confirmed")
                .orderBy("date", "asc").limit(1).get();
            if (upcoming.empty) {
                await (0, client_1.sendMessage)(chatId, "I don't see any upcoming visits to cancel. What were you looking to change?");
                return;
            }
            const appt = upcoming.docs[0].data();
            await db.collection("agent_sessions").doc(phone).update({
                pendingCancelConfirm: { appointmentId: upcoming.docs[0].id },
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            await (0, client_1.sendMessage)(chatId, `Cancel ${appt.caregiverName}'s visit on ${appt.date} (${appt.startTime}–${appt.endTime})?\n\nReply YES to confirm or NO to keep it.`);
            return;
        }
        // ── Pending rebook — waiting for client to supply a date ─────────────────
        if (session.pendingRebook) {
            const rebook = session.pendingRebook;
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsedDate = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 20,
                system: `Today is ${new Date().toISOString().slice(0, 10)}. ` +
                    "The user is choosing a date for a care visit. Reply with only a YYYY-MM-DD date string, nothing else.",
                messages: [{ role: "user", content: text }],
            });
            const dateStr = ((_101 = parsedDate.content[0].text) !== null && _101 !== void 0 ? _101 : "").trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch that date — could you try again? (e.g. \"May 19\" or \"next Monday\")");
                return;
            }
            const clientId = (_102 = session.userId) !== null && _102 !== void 0 ? _102 : phone;
            const taskId = await (0, bookingExecutor_1.createBookingTask)({
                clientPhone: phone,
                clientId,
                caregiverId: rebook.caregiverId,
                caregiverName: rebook.caregiverName,
                appointments: [{ date: dateStr, startTime: rebook.startTime, endTime: rebook.endTime, durationHours: rebook.durationHours }],
                hourlyRate: 20,
            });
            await db.collection("agent_sessions").doc(phone).update({ pendingRebook: admin.firestore.FieldValue.delete() });
            const perms = await (0, permissionsConversation_1.getPermissions)((_103 = session.userId) !== null && _103 !== void 0 ? _103 : phone).catch(() => null);
            if (perms === null || perms === void 0 ? void 0 : perms.canBookAutomatically) {
                try {
                    await (0, bookingExecutor_1.executeBookings)(taskId, phone);
                }
                catch (err) {
                    console.error("executeBookings failed (rebook):", err);
                    await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
                    await (0, client_1.sendMessage)(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
                    const sd = (_104 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _104 !== void 0 ? _104 : {};
                    const { runMatchingForClient: rmfc3 } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
                    await rmfc3(phone, chatId, sd, sd).catch(() => { });
                }
            }
            else {
                const cost = (rebook.durationHours * 20).toFixed(2);
                await (0, client_1.sendMessage)(chatId, `Here's your booking summary:\n\n` +
                    `${dateStr} · ${rebook.startTime}–${rebook.endTime}\n` +
                    `${rebook.caregiverName} · $${cost}\n\n` +
                    `Reply YES to confirm or NO to cancel.`);
            }
            return;
        }
        // ── Rebook request ────────────────────────────────────────────────────────
        if (intent === "REBOOK_REQUEST") {
            const clientId = (_105 = session.userId) !== null && _105 !== void 0 ? _105 : phone;
            const lastApptSnap = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "==", "confirmed")
                .orderBy("date", "desc").limit(1).get();
            if (lastApptSnap.empty) {
                await (0, client_1.sendMessage)(chatId, "I don't have any past bookings to rebook from. Want me to search for a caregiver? Just let me know!");
                return;
            }
            const last = lastApptSnap.docs[0].data();
            const caregiverId = last.caregiverId;
            const caregiverName = last.caregiverName;
            const startTime = last.startTime;
            const endTime = last.endTime;
            const durationHours = ((_106 = last.durationHours) !== null && _106 !== void 0 ? _106 : 4);
            await db.collection("agent_sessions").doc(phone).update({
                pendingRebook: { caregiverId, caregiverName, startTime, endTime, durationHours },
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            await (0, client_1.sendMessage)(chatId, `Got it — same schedule with ${caregiverName} (${startTime}–${endTime})?\n\n` +
                `What date should the visit be?`);
            return;
        }
        // ── Schedule request — set up a personal recurring reminder ─────────────
        if (intent === "SCHEDULE_REQUEST") {
            const { handleScheduleRequest } = await Promise.resolve().then(() => __importStar(require("../agents/schedulingHandler")));
            await handleScheduleRequest(phone, text, session);
            return;
        }
        // ── Trigger management — view or cancel personal reminders ───────────────
        if (intent === "TRIGGER_MANAGEMENT") {
            const { handleTriggerManagement } = await Promise.resolve().then(() => __importStar(require("../agents/schedulingHandler")));
            await handleTriggerManagement(phone, text, session);
            return;
        }
        // ── POST_JOB — start the conversational job posting state machine ────────
        if (intent === "POST_JOB" && session.userType !== "caregiver") {
            await (0, jobPostingFlow_1.startJobPostingFlow)(phone, chatId, session);
            return;
        }
        // ── RESCHEDULE_REQUEST (caregiver) — natural language reschedule, mirrors RESCHEDULE keyword ──
        if (intent === "RESCHEDULE_REQUEST" && session.userType === "caregiver") {
            await db.collection("agent_sessions").doc(phone).update({
                caregiverRescheduling: true,
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            await (0, client_1.sendMessage)(chatId, "No problem — text me 2–3 times that work for you and I'll let the family know right away.");
            return;
        }
        // ── RESCHEDULE_REQUEST — move an existing appointment to a new date/time ──
        if (intent === "RESCHEDULE_REQUEST" && session.userType !== "caregiver") {
            const qaReplyReschedule = await (0, qaAgent_1.runQaAgent)({
                text,
                phone,
                chatId,
                userId: (_107 = session.userId) !== null && _107 !== void 0 ? _107 : "",
                seniorId: (_109 = (_108 = session.seniorId) !== null && _108 !== void 0 ? _108 : session.userId) !== null && _109 !== void 0 ? _109 : "",
                userType: "client",
                caregiverId: session.caregiverId,
                zepThreadId: session.zepThreadId,
                session: session,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: qaReplyReschedule,
                urgency: "standard",
                sourceAgent: "qa_reschedule",
                canDrop: false,
            });
            return;
        }
        // ── MODIFY_SCHEDULE — change days/times of recurring care schedule ────────
        if (intent === "MODIFY_SCHEDULE" && session.userType !== "caregiver") {
            await (0, modifyScheduleFlow_1.startModifyScheduleFlow)(phone, chatId, session);
            return;
        }
        // ── UPDATE_PAYMENT_METHOD — generate Stripe billing portal link ───────────
        if (intent === "UPDATE_PAYMENT_METHOD" && session.userType !== "caregiver") {
            const clientId = (_110 = session.userId) !== null && _110 !== void 0 ? _110 : phone;
            try {
                const { handleToolCall } = await Promise.resolve().then(() => __importStar(require("../mcp/server")));
                const result = await handleToolCall("get_payment_update_link", { clientId });
                if ((result === null || result === void 0 ? void 0 : result.success) && (result === null || result === void 0 ? void 0 : result.url)) {
                    await (0, client_1.sendMessage)(chatId, `Here's a secure link to update your payment method:\n\n${result.url}\n\n` +
                        `This link expires in 5 minutes. Once updated, your next scheduled payment will use the new method.`);
                }
                else {
                    await (0, client_1.sendMessage)(chatId, "I wasn't able to generate a payment update link right now. Please visit the app settings to update your billing, or reply again and I'll try once more.");
                }
            }
            catch (err) {
                console.error("UPDATE_PAYMENT_METHOD error:", err);
                await (0, client_1.sendMessage)(chatId, "I ran into an issue generating your billing link. You can update your payment method in the app under Settings → Billing.");
            }
            return;
        }
        // ── REQUEST_REFUND — start the refund self-service state machine ─────────
        if (intent === "REQUEST_REFUND" && session.userType !== "caregiver") {
            const refundClientId = ((_111 = session.userId) !== null && _111 !== void 0 ? _111 : phone);
            // Initialise the state machine by calling with step = "identify_visit"
            await (0, refundHandler_1.handleRefundRequest)(refundClientId, text, session, (msg) => (0, client_1.sendMessage)(chatId, msg));
            return;
        }
        // ── VIEW_INVOICE / VIEW_CARE_PLAN_HISTORY — routed to QA agent ───────────
        if ((intent === "VIEW_INVOICE" && session.userType !== "caregiver") ||
            (intent === "VIEW_CARE_PLAN_HISTORY" && session.userType !== "caregiver")) {
            const qaReplyInvoice = await (0, qaAgent_1.runQaAgent)({
                text,
                phone,
                chatId,
                userId: (_112 = session.userId) !== null && _112 !== void 0 ? _112 : "",
                seniorId: (_114 = (_113 = session.seniorId) !== null && _113 !== void 0 ? _113 : session.userId) !== null && _114 !== void 0 ? _114 : "",
                userType: "client",
                caregiverId: session.caregiverId,
                zepThreadId: session.zepThreadId,
                session: session,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: qaReplyInvoice,
                urgency: "standard",
                sourceAgent: "qa",
                canDrop: false,
            });
            return;
        }
        // ── Platform-action intents — routed to QA agent with new MCP tools ─────
        if (intent === "VIEW_MY_JOBS" ||
            intent === "VIEW_APPLICANTS" ||
            intent === "VIEW_JOURNAL" ||
            intent === "APPROVE_TIMESHEET" ||
            intent === "VIEW_EARNINGS" ||
            intent === "UPDATE_AVAILABILITY" ||
            intent === "BROWSE_JOB_BOARD") {
            const qaReplyPlatform = await (0, qaAgent_1.runQaAgent)({
                text,
                phone,
                chatId,
                userId: (_115 = session.userId) !== null && _115 !== void 0 ? _115 : "",
                seniorId: (_117 = (_116 = session.seniorId) !== null && _116 !== void 0 ? _116 : session.userId) !== null && _117 !== void 0 ? _117 : "",
                userType: (_118 = session.userType) !== null && _118 !== void 0 ? _118 : "client",
                caregiverId: session.caregiverId,
                zepThreadId: session.zepThreadId,
                session: session,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: qaReplyPlatform,
                urgency: "standard",
                sourceAgent: "qa",
                canDrop: false,
            });
            return;
        }
        // ── Credential management — "what logins do you have", "remove my CVS login" ─
        if (intent === "CREDENTIAL_MANAGEMENT" && session.userType !== "caregiver") {
            const qaReply = await (0, qaAgent_1.runQaAgent)({
                text,
                phone,
                chatId,
                userId: (_119 = session.userId) !== null && _119 !== void 0 ? _119 : "",
                seniorId: (_121 = (_120 = session.seniorId) !== null && _120 !== void 0 ? _120 : session.userId) !== null && _121 !== void 0 ? _121 : "",
                userType: "client",
                caregiverId: session.caregiverId,
                zepThreadId: session.zepThreadId,
                session: session,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: qaReply,
                urgency: "standard",
                sourceAgent: "qa",
                canDrop: false,
            });
            return;
        }
        // ── Find caregiver — post-onboarding matching request ────────────────────
        if (intent === "FIND_CAREGIVER" && session.userType !== "caregiver") {
            const { runMatchingForClient } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
            const sessionSnap2 = await db.collection("agent_sessions").doc(phone).get();
            const sessionData = (_122 = sessionSnap2.data()) !== null && _122 !== void 0 ? _122 : {};
            await runMatchingForClient(phone, chatId, sessionData, sessionData);
            return;
        }
        // ── Fact correction — user is correcting a known fact ────────────────────
        if (intent === "FACT_CORRECTION") {
            const { detectAndApplyCorrection } = await Promise.resolve().then(() => __importStar(require("../memory/learnedFacts")));
            const factUserId = session.userType === "caregiver"
                ? ((_124 = (_123 = session.caregiverId) !== null && _123 !== void 0 ? _123 : session.userId) !== null && _124 !== void 0 ? _124 : phone)
                : ((_125 = session.userId) !== null && _125 !== void 0 ? _125 : phone);
            const zepUserId2 = session.zepThreadId ? phone.replace(/\D/g, "") : undefined;
            const applied = await detectAndApplyCorrection(factUserId, text, zepUserId2).catch(() => false);
            if (applied) {
                await (0, client_1.sendMessage)(chatId, "Got it — I've updated that.");
                return;
            }
            // Fall through to QA agent if we couldn't match a specific known fact
        }
        // ── Default: QA agent ─────────────────────────────────────────────────────
        const zepThreadId = session.zepThreadId;
        if (zepThreadId) {
            (0, zepClient_1.addUserMessageToZep)({
                threadId: zepThreadId,
                content: text,
                userName: (_126 = session.firstName) !== null && _126 !== void 0 ? _126 : "Family",
                sentAt: new Date(),
            }).catch(console.error);
        }
        const qaReply = await (0, qaAgent_1.runQaAgent)({
            text,
            phone,
            chatId,
            userId: (_127 = session.userId) !== null && _127 !== void 0 ? _127 : "",
            seniorId: (_129 = (_128 = session.seniorId) !== null && _128 !== void 0 ? _128 : session.userId) !== null && _129 !== void 0 ? _129 : "",
            userType: (_130 = session.userType) !== null && _130 !== void 0 ? _130 : "client",
            caregiverId: session.caregiverId,
            zepThreadId,
            session: session,
        });
        if (zepThreadId && qaReply) {
            (0, zepClient_1.addAssistantMessageToZep)({
                threadId: zepThreadId,
                content: qaReply,
            }).catch(console.error);
        }
        // Extract persistent facts from the user's message and store them (fire-and-forget).
        // Only for client messages — caregiver messages don't carry care-situation facts.
        if (session.userType !== "caregiver" && session.userId) {
            const { extractAndStoreFacts } = await Promise.resolve().then(() => __importStar(require("../memory/learnedFacts")));
            extractAndStoreFacts(session.userId, text, session.zepThreadId ? (0, zepClient_1.getZepUserId)(phone) : undefined).catch(() => { });
        }
    }
    catch (err) {
        console.error("handleInbound error:", err);
        await (0, client_1.stopTyping)(chatId).catch(() => { });
        await (0, client_1.sendMessage)(chatId, "I'm having trouble right now. For urgent concerns, please call 911.");
        await db.collection("agent_error_log").add({
            phone, error: String(err), text, createdAt: new Date().toISOString(),
        }).catch(() => { });
    }
    finally {
        await (0, client_1.stopTyping)(chatId).catch(() => { });
    }
}
// ── message.failed handler ────────────────────────────────────────────────────
async function handleMessageFailed(event) {
    var _a, _b, _c, _d, _e, _f;
    const ev = event;
    const chatId = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.chat_id;
    const messageId = (_b = ev.data) === null || _b === void 0 ? void 0 : _b.message_id;
    const errorCode = (_c = ev.data) === null || _c === void 0 ? void 0 : _c.error_code;
    const reason = (_d = ev.data) === null || _d === void 0 ? void 0 : _d.reason;
    const now = new Date().toISOString();
    await db.collection("agent_error_log").add({
        type: "message.failed",
        chatId,
        messageId,
        errorCode,
        reason,
        failedAt: (_f = (_e = ev.data) === null || _e === void 0 ? void 0 : _e.failed_at) !== null && _f !== void 0 ? _f : now,
        createdAt: now,
    }).catch(() => { });
    await db.collection("admin_alerts").add({
        type: "linq_message_failed",
        chatId,
        messageId,
        errorCode,
        reason,
        severity: (errorCode === 4001 || errorCode === 4002) ? "high" : "medium",
        createdAt: now,
        resolved: false,
    }).catch(() => { });
    console.warn("linqWebhook: message.failed", { chatId, messageId, errorCode, reason });
}
// ── phone_number.status_updated handler ───────────────────────────────────────
async function handlePhoneNumberStatusUpdated(event) {
    var _a, _b, _c;
    const ev = event;
    const phoneNumber = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.phone_number;
    const newHealth = (_b = ev.data) === null || _b === void 0 ? void 0 : _b.new_health_status;
    const prevHealth = (_c = ev.data) === null || _c === void 0 ? void 0 : _c.previous_health_status;
    const now = new Date().toISOString();
    if (!phoneNumber)
        return;
    await db.collection("linq_phone_health").doc(phoneNumber).set({
        phoneNumber,
        healthStatus: newHealth,
        updatedAt: now,
    }, { merge: true }).catch(() => { });
    const degraded = newHealth === "at_risk" || newHealth === "critical";
    if (degraded) {
        await db.collection("admin_alerts").add({
            type: "linq_phone_health_degraded",
            phoneNumber,
            prevHealth,
            newHealth,
            severity: newHealth === "critical" ? "critical" : "high",
            message: `Linq line ${phoneNumber} health changed from ${prevHealth !== null && prevHealth !== void 0 ? prevHealth : "unknown"} to ${newHealth}. ${newHealth === "critical" ? "Pause outbound messaging immediately." : "Reduce send volume."}`,
            createdAt: now,
            resolved: false,
        }).catch(() => { });
        console.error("linqWebhook: phone number health degraded", { phoneNumber, prevHealth, newHealth });
        if (newHealth === "critical") {
            await db.collection("system_config").doc("linq_circuit_breaker").set({
                status: "open",
                reason: `Linq line ${phoneNumber} status went critical`,
                openedAt: now,
                phone: phoneNumber,
            }, { merge: true }).catch(() => { });
            console.error("linqWebhook: circuit breaker OPENED for outbound messaging — Linq line critical", { phoneNumber });
        }
    }
}
// ── iMessage emoji reaction → task confirmation ───────────────────────────────
// Positive emojis (👍 ❤️ 😍 🎉 ✅ 👏 💙) → YES / confirm pending task
// Negative emojis (👎 ✖️) → NO / decline pending task
const POSITIVE_REACTIONS = new Set(["thumbsup", "love", "ha", "emphasize", "like", "heart", "👍", "❤️", "😍", "🎉", "✅", "👏", "💙", "🙌"]);
const NEGATIVE_REACTIONS = new Set(["thumbsdown", "dislike", "👎", "✖️", "❌"]);
async function handleReactionAdded(event) {
    var _a, _b, _c, _d, _e, _f, _g;
    const phone = (_b = (_a = event.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.value;
    const reaction = ((_d = (_c = event.data) === null || _c === void 0 ? void 0 : _c.reaction) !== null && _d !== void 0 ? _d : "");
    const chatId = (_f = (_e = event.data) === null || _e === void 0 ? void 0 : _e.chat) === null || _f === void 0 ? void 0 : _f.id;
    const now = new Date().toISOString();
    // Audit log regardless
    await db.collection("agent_reactions").add({
        chatId,
        messageId: (_g = event.data) === null || _g === void 0 ? void 0 : _g.message_id,
        reaction,
        phone,
        reactedAt: now,
    }).catch(() => { });
    if (!phone || !chatId)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut)
        return;
    const isYes = POSITIVE_REACTIONS.has(reaction);
    const isNo = NEGATIVE_REACTIONS.has(reaction);
    if (!isYes && !isNo)
        return;
    // Check for a pending agent_task awaiting approval
    const taskSnap = await db
        .collection("agent_tasks")
        .where("clientPhone", "==", phone)
        .where("status", "==", "awaiting_approval")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();
    if (!taskSnap.empty && isYes) {
        const taskDoc = taskSnap.docs[0];
        if (taskDoc.data().type === "booking_confirmation") {
            const { executeBookings } = await Promise.resolve().then(() => __importStar(require("../agents/bookingExecutor")));
            await executeBookings(taskDoc.id, phone).catch(err => console.error("handleReactionAdded: executeBookings failed:", err));
        }
        else {
            // Generic approval for other task types (e.g. replacement selection)
            await (0, taskApprovalHandler_1.handleTaskApproval)(taskDoc, "1", session, chatId);
        }
        return;
    }
    if (!taskSnap.empty && isNo) {
        const taskDoc = taskSnap.docs[0];
        await taskDoc.ref.update({ status: "declined_by_reaction", declinedAt: now });
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: "Got it — I'll leave it for now. Let me know if you'd like a different option.",
            urgency: "immediate",
            sourceAgent: "reaction_handler",
            canDrop: false,
        }).catch(() => { });
        return;
    }
    // No pending task — check if there's a pending recurring schedule confirmation in session
    if (isYes && session.awaitingRecurringConfirmation) {
        const setAt = session.pendingRecurringConfirmationSetAt;
        if (setAt && Date.now() - new Date(setAt).getTime() > 2 * 60 * 60 * 1000) {
            // Confirmation window expired — clear state
            await db.collection("agent_sessions").doc(phone).update({
                awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
                pendingRecurringSchedule: admin.firestore.FieldValue.delete(),
            }).catch(() => { });
            return;
        }
        await handleRecurringConfirm(phone, chatId, session);
        return;
    }
}
// ── Webhook HTTPS function ────────────────────────────────────────────────────
exports.linqWebhook = functions
    .runWith({ secrets: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "CREDENTIAL_VAULT_KEY"] })
    .https.onRequest(async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    res.status(200).send("ok");
    if (req.method !== "POST")
        return;
    const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
    if (webhookSecret) {
        const timestamp = (_a = req.headers["x-webhook-timestamp"]) !== null && _a !== void 0 ? _a : "";
        const signature = (_b = req.headers["x-webhook-signature"]) !== null && _b !== void 0 ? _b : "";
        const rawBody = (_c = req.rawBody) !== null && _c !== void 0 ? _c : Buffer.from(JSON.stringify(req.body));
        if (!verifySignature(rawBody, timestamp, signature, webhookSecret)) {
            console.warn("linqWebhook: invalid signature — ignoring");
            return;
        }
        // FIX 9 — reject stale events (replay attack protection)
        const tsNum = parseInt(timestamp, 10);
        if (!isNaN(tsNum) && Math.abs(Date.now() / 1000 - tsNum) > 300) {
            console.warn("linqWebhook: stale timestamp — ignoring");
            return;
        }
    }
    const event = req.body;
    // Deduplicate all event types by event_id (Linq delivers at-least-once)
    const eventId = (_d = event.event_id) !== null && _d !== void 0 ? _d : event.id;
    if (eventId) {
        const logRef = db.collection("agent_event_log").doc(eventId);
        const existing = await logRef.get();
        if (existing.exists)
            return; // already processed
        await logRef.set({ type: event.type, processedAt: new Date().toISOString() });
    }
    switch (event.type) {
        case "message.received":
            await handleInbound(event).catch((err) => console.error("linqWebhook handleInbound:", err));
            break;
        case "message.read":
            await db.collection("agent_read_receipts").add({
                chatId: (_f = (_e = event.data) === null || _e === void 0 ? void 0 : _e.chat) === null || _f === void 0 ? void 0 : _f.id,
                messageId: (_g = event.data) === null || _g === void 0 ? void 0 : _g.message_id,
                phone: (_j = (_h = event.data) === null || _h === void 0 ? void 0 : _h.sender_handle) === null || _j === void 0 ? void 0 : _j.value,
                readAt: new Date().toISOString(),
            }).catch(() => { });
            break;
        case "reaction.added":
            await handleReactionAdded(event).catch((err) => console.error("linqWebhook handleReactionAdded:", err));
            break;
        case "chat.typing_indicator.started":
            await handleTypingStarted(event).catch((err) => console.error("linqWebhook handleTypingStarted:", err));
            break;
        case "message.delivered":
            await db.collection("agent_conversations")
                .where("messageId", "==", (_k = event.data) === null || _k === void 0 ? void 0 : _k.message_id)
                .limit(1)
                .get()
                .then(async (snap) => {
                var _a, _b;
                if (!snap.empty) {
                    await snap.docs[0].ref.update({ deliveredAt: (_b = (_a = event.data) === null || _a === void 0 ? void 0 : _a.delivered_at) !== null && _b !== void 0 ? _b : new Date().toISOString() });
                }
            })
                .catch(() => { });
            break;
        case "message.failed":
            await handleMessageFailed(event).catch((err) => console.error("linqWebhook handleMessageFailed:", err));
            break;
        case "phone_number.status_updated":
            await handlePhoneNumberStatusUpdated(event).catch((err) => console.error("linqWebhook handlePhoneNumberStatusUpdated:", err));
            break;
        default:
            console.warn(`linqWebhook: unhandled event type "${(_l = event === null || event === void 0 ? void 0 : event.type) !== null && _l !== void 0 ? _l : "unknown"}"`);
            break;
    }
});
//# sourceMappingURL=webhooks.js.map