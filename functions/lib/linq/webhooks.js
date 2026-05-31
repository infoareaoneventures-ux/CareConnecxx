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
const uuid_1 = require("uuid");
const client_1 = require("./client");
const intentClassifier_1 = require("../agents/intentClassifier");
const qaAgent_1 = require("../agents/qaAgent");
const taskApprovalHandler_1 = require("../agents/taskApprovalHandler");
const pendingActions_1 = require("../agents/pendingActions");
const approvalHandler_1 = require("../agents/approvalHandler");
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
const profileCompleteness_1 = require("../agents/profileCompleteness");
const jobPostingFlow_1 = require("../agents/jobPostingFlow");
const modifyScheduleFlow_1 = require("../agents/modifyScheduleFlow");
const refundHandler_1 = require("../agents/refundHandler");
const timesheetHandler_1 = require("../agents/timesheetHandler");
const earningsHandler_1 = require("../agents/earningsHandler");
const availabilityHandler_1 = require("../agents/availabilityHandler");
const caregiverSwapHandler_1 = require("../agents/caregiverSwapHandler");
const clientSwapRequestHandler_1 = require("../agents/clientSwapRequestHandler");
const caregiverCancelShiftHandler_1 = require("../agents/caregiverCancelShiftHandler");
const caregiverProfileHandler_1 = require("../agents/caregiverProfileHandler");
const sessionState_1 = require("../utils/sessionState");
const caraMessage_1 = require("../utils/caraMessage");
const dndGuard_1 = require("../utils/dndGuard");
const feedback_1 = require("../ai/feedback");
const jobNotifications_1 = require("../triggers/jobNotifications");
const zepClient_1 = require("../memory/zepClient");
const openaiClient_1 = require("../utils/openaiClient");
const voiceTranscription_1 = require("../utils/voiceTranscription");
const personaShiftDetector_1 = require("../utils/personaShiftDetector");
const language_1 = require("../utils/language");
const db = admin.firestore();
// ── Signature verification ────────────────────────────────────────────────────
function verifySignature(rawBody, timestamp, signature, secret) {
    // Signature is HMAC-SHA256 over `{timestamp}.{payload}` (per Linq docs).
    const payload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
    // Linq's docs don't pin down the secret's encoding or the signature's output
    // encoding, so derive the HMAC key both ways and compare the signature against
    // every common digest encoding. A match in any pair proves the sender holds the
    // secret (which is the whole point); the extra candidates don't weaken anything
    // since each still requires knowing the secret.
    const keyCandidates = [
        Buffer.from(secret, "utf8"), // secret used as a raw string key (Stripe-style; most providers)
        Buffer.from(secret, "base64"), // secret used as base64-encoded key bytes
    ];
    const safeEqual = (a, b) => {
        if (a.length !== b.length)
            return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
        }
        catch (_a) {
            return false;
        }
    };
    for (const key of keyCandidates) {
        const hmac = crypto.createHmac("sha256", key).update(payload).digest();
        const expectedB64 = hmac.toString("base64");
        const expectedB64Url = hmac.toString("base64url");
        const expectedHex = hmac.toString("hex");
        if (safeEqual(expectedB64, signature) ||
            safeEqual(expectedB64Url, signature) ||
            safeEqual(expectedHex, signature)) {
            return true;
        }
    }
    return false;
}
// ── Rate limiting ─────────────────────────────────────────────────────────────
// Per-phone hourly rate limit — only triggers on runaway scripts / abuse,
// not legitimate active conversations. A normal care/onboarding flow can
// easily run 30+ messages in an hour. Linq's per-pair rate limit (28 msgs
// per 60s in client.ts) handles outbound spam separately.
async function isRateLimited(phone) {
    var _a, _b;
    const rateRef = db.collection("agent_rate").doc(phone);
    const snap = await rateRef.get();
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const calls = ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.calls) !== null && _b !== void 0 ? _b : []).filter((t) => t > hourAgo);
    if (calls.length >= 120)
        return true; // ~2 msgs/min sustained for an hour = clearly automated
    await rateRef.set({ calls: [...calls, now] });
    return false;
}
// ── Opt-in for existing (non-onboarding) users ────────────────────────────────
// ── Typing indicator — pre-fetch context so Claude responds faster ─────────────
async function handleTypingStarted(event) {
    var _a, _b, _c, _d, _e, _f, _g;
    const ev = event;
    const phone = (_b = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.handle;
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
        const noVisitMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: "Caregiver texted ARRIVED but no active appointment was found for them today. Let them know and invite them to flag if something looks wrong.",
            fallback: "I don't see a scheduled visit for you today. Let me know if something looks wrong.",
        });
        await (0, client_1.sendMessage)(chatId, noVisitMsg);
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
    const arrivedAckMsg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `Caregiver just arrived at the client's home${apptData.clientName ? ` for ${apptData.clientName}` : ""}. The family has been notified. Wish them a good visit.`,
        fallback: "Got it — I've let the family know you're there. Have a good visit.",
    });
    await (0, client_1.sendMessage)(chatId, arrivedAckMsg);
    // Send caregiver a care plan task overview for the shift (fire-and-forget)
    sendArrivalCarePlanBriefing(chatId, apptData).catch(() => { });
}
// ── Day-before shift confirmation handler ────────────────────────────────────
// Family replied "NOTIFY" after a medical-crisis message. Alert the care team:
// a guaranteed critical admin alert, plus best-effort SMS to family-group members
// and the senior's assigned caregiver(s).
async function handleCrisisNotify(phone, chatId, session, pending) {
    var _a, _b, _c, _d, _e, _f;
    // Clear the armed flag first so a repeat NOTIFY doesn't double-fire.
    await db.collection("agent_sessions").doc(phone).update({
        pendingCrisisNotify: admin.firestore.FieldValue.delete(),
    }).catch(() => { });
    const lang = (0, language_1.languageFromSession)(session);
    const userId = (_a = session.userId) !== null && _a !== void 0 ? _a : phone;
    const seniorName = (_d = (_b = session.seniorName) !== null && _b !== void 0 ? _b : (_c = session.onboardingData) === null || _c === void 0 ? void 0 : _c.seniorName) !== null && _d !== void 0 ? _d : "your loved one";
    // 1) GUARANTEED: critical admin alert so support staff is paged.
    await db.collection("admin_alerts").add({
        type: "crisis_notify_requested",
        severity: "critical",
        phone,
        userId,
        seniorName,
        crisisText: (_e = pending === null || pending === void 0 ? void 0 : pending.text) !== null && _e !== void 0 ? _e : "",
        createdAt: new Date().toISOString(),
    }).catch((err) => console.error("[handleCrisisNotify] admin_alert write failed:", err));
    // 2) BEST-EFFORT: alert family-group members.
    try {
        const membersSnap = await db.collection("family_group_members")
            .where("primaryPhone", "==", phone).get();
        await Promise.all(membersSnap.docs.map((d) => {
            const mPhone = d.data().memberPhone;
            if (!mPhone)
                return Promise.resolve();
            return (0, caraAgent_1.sendViaInteractionAgent)(mPhone, {
                content: `⚠️ A medical emergency was just reported for ${seniorName}. If you can help, please reach out now. Call 911 if it's life-threatening.`,
                urgency: "immediate",
                sourceAgent: "crisis_notify",
                canDrop: false,
            }).catch(() => { });
        }));
    }
    catch (err) {
        console.error("[handleCrisisNotify] family notify failed:", err);
    }
    // 3) BEST-EFFORT: alert the assigned caregiver(s) on the senior's active appointments.
    try {
        const apptSnap = await db.collection("appointments")
            .where("clientId", "==", userId)
            .where("status", "in", ["confirmed", "in-progress", "pending_caregiver_confirmation"])
            .limit(5).get();
        const caregiverPhones = new Set();
        for (const doc of apptSnap.docs) {
            const cgId = doc.data().caregiverId;
            if (!cgId)
                continue;
            const cgSnap = await db.collection("caregivers").doc(cgId).get();
            const cgPhone = (_f = cgSnap.data()) === null || _f === void 0 ? void 0 : _f.phone;
            if (cgPhone)
                caregiverPhones.add(cgPhone);
        }
        await Promise.all([...caregiverPhones].map((cgPhone) => (0, caraAgent_1.sendViaInteractionAgent)(cgPhone, {
            content: `⚠️ A medical emergency was just reported for ${seniorName}, your care client. Please check in if you're able. Call 911 if it's life-threatening.`,
            urgency: "immediate",
            sourceAgent: "crisis_notify",
            canDrop: false,
        }).catch(() => { })));
    }
    catch (err) {
        console.error("[handleCrisisNotify] caregiver notify failed:", err);
    }
    // 4) Confirm to the family.
    await (0, client_1.sendMessage)(chatId, language_1.t.crisis_notify_sent(lang));
}
async function handleShiftConfirmation(phone, chatId, text, session) {
    const info = session.pendingShiftConfirmation;
    // Parse YES / NO / question
    const parseRaw = await (0, openaiClient_1.quickComplete)("The caregiver is responding to a shift confirmation request for tomorrow. " +
        "Reply CONFIRM if they said yes, they'll be there. " +
        "Reply CANCEL if they said no, they can't make it. " +
        "Reply QUESTION if it is a question or unclear. " +
        "Reply with exactly one word.", text, { maxTokens: 10 }).catch(() => "");
    const decision = parseRaw.trim().toUpperCase();
    // Always clear the state flag
    await db.collection("agent_sessions").doc(phone).update({
        pendingShiftConfirmation: admin.firestore.FieldValue.delete(),
        stateExpiresAt: admin.firestore.FieldValue.delete(),
    });
    const cgFirstName = info.caregiverName.split(" ")[0] || "Your caregiver";
    const displayDate = info.appointmentDisplay || info.appointmentDate;
    if (decision === "CONFIRM") {
        await db.collection("appointments").doc(info.appointmentId).update({
            caregiverDayBeforeConfirmed: true,
            caregiverDayBeforeConfirmedAt: new Date().toISOString(),
        });
        const confirmMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: `${cgFirstName} just confirmed they'll be at ${info.seniorName}'s shift ` +
                `on ${displayDate}${info.startTime ? " at " + info.startTime : ""}. ` +
                `Write a warm, brief thank-you confirming you've got them set. Sound genuinely grateful.`,
            fallback: `You're all set — thanks for confirming, ${cgFirstName}! See you at ${info.seniorName}'s on ${displayDate}.`,
        });
        await (0, client_1.sendMessage)(chatId, confirmMsg);
        // Notify family
        const clientPhone = await getClientPhoneByClientId(info.clientId);
        if (clientPhone) {
            const familyMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `${cgFirstName} just confirmed they'll be at ${info.seniorName}'s care visit ` +
                    `on ${displayDate}${info.startTime ? " at " + info.startTime : ""}. ` +
                    `Write a warm, reassuring message letting the family know everything's confirmed. ` +
                    `Sound like a coordinator who genuinely cares about their peace of mind.`,
                fallback: `Great news! ${cgFirstName} has confirmed they'll be there for ${info.seniorName}'s visit ` +
                    `on ${displayDate}${info.startTime ? " at " + info.startTime : ""}. You're all set — no action needed!`,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: familyMsg,
                urgency: "standard",
                sourceAgent: "shift_confirm_family_update",
                canDrop: true,
            });
        }
    }
    else if (decision === "CANCEL") {
        await db.collection("appointments").doc(info.appointmentId).update({
            caregiverDayBeforeCancelled: true,
            caregiverDayBeforeCancelledAt: new Date().toISOString(),
        });
        const cancelMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: `${cgFirstName} just let you know they can't make ${info.seniorName}'s shift on ${displayDate}. ` +
                `Write a brief, understanding response — acknowledge the situation without judgment, ` +
                `let them know the family will be notified and you'll take care of it from here. ` +
                `Be warm, not cold.`,
            fallback: `Understood, ${cgFirstName} — I'll let the family know and start working on coverage for ${displayDate}. ` +
                `I appreciate you letting me know ahead of time.`,
        });
        await (0, client_1.sendMessage)(chatId, cancelMsg);
        // Alert family with urgency
        const clientPhone = await getClientPhoneByClientId(info.clientId);
        if (clientPhone) {
            const alertMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Unfortunately ${cgFirstName} just let us know they can't make ${info.seniorName}'s visit ` +
                    `on ${displayDate}${info.startTime ? " at " + info.startTime : ""}. ` +
                    `Write an urgent but calm message to the family alerting them. ` +
                    `Let them know we're already working on finding a replacement. ` +
                    `Tell them to reply HELP if they need immediate support. ` +
                    `Be direct but not alarming — this is being handled.`,
                fallback: `Heads up — ${cgFirstName} won't be able to make ${info.seniorName}'s visit on ${displayDate}. ` +
                    `I'm already working on finding coverage. Reply HELP if you need anything in the meantime.`,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: alertMsg,
                urgency: "immediate",
                sourceAgent: "shift_confirm_family_update",
                canDrop: false,
            });
        }
        // Trigger replacement agent (fire-and-forget). runEmergencyReplacement requires
        // { appointmentId, clientId, clientPhone, appt } — we must load the appointment to
        // build `appt` (caregiverId/time/date) and pass the family's phone. A failure here
        // is safety-critical (the family was just told coverage is being found), so we alert
        // admins on any error instead of silently swallowing it.
        if (clientPhone) {
            (async () => {
                var _a;
                try {
                    const apptSnap = await db.collection("appointments").doc(info.appointmentId).get();
                    const appt = Object.assign(Object.assign({}, (apptSnap.data() || {})), { caregiverName: info.caregiverName, date: info.appointmentDate, time: info.startTime });
                    const { runEmergencyReplacement } = await Promise.resolve().then(() => __importStar(require("../agents/replacementAgent")));
                    if (typeof runEmergencyReplacement === "function") {
                        await runEmergencyReplacement({
                            appointmentId: info.appointmentId,
                            clientId: info.clientId,
                            clientPhone,
                            appt,
                        });
                    }
                }
                catch (err) {
                    console.error("[handleShiftConfirmation] emergency replacement failed:", err);
                    await db.collection("admin_alerts").add({
                        type: "emergency_replacement_failed",
                        severity: "critical",
                        appointmentId: info.appointmentId,
                        clientId: info.clientId,
                        clientPhone,
                        seniorName: info.seniorName,
                        error: String((_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : err),
                        createdAt: new Date().toISOString(),
                    }).catch(() => { });
                }
            })();
        }
        else {
            console.error("[handleShiftConfirmation] no clientPhone for appointment", info.appointmentId, "— cannot run replacement");
            await db.collection("admin_alerts").add({
                type: "emergency_replacement_no_client_phone",
                severity: "critical",
                appointmentId: info.appointmentId,
                clientId: info.clientId,
                seniorName: info.seniorName,
                createdAt: new Date().toISOString(),
            }).catch(() => { });
        }
    }
    else {
        // QUESTION or unclear — answer the question, then re-ask the confirmation.
        // Generate the answer inline so we control message ordering (otherwise the
        // re-ask can land before the interaction agent's reply).
        let answer = "";
        try {
            answer = await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant. A caregiver was asked to confirm they'll be at " +
                `${info.seniorName}'s shift on ${info.appointmentDate} (start ${info.startTime}). ` +
                "Instead they sent the message below — likely a question about the shift, address, client, or logistics. " +
                "Answer briefly (1–2 sentences). Do NOT ask them to confirm — that prompt comes next.", text, { maxTokens: 180 });
        }
        catch (_a) {
            answer = "Let me get back to you on that. In the meantime —";
        }
        await (0, client_1.sendMessage)(chatId, answer);
        // Re-set the flag and re-ask (sequentially so the question is acknowledged first)
        await db.collection("agent_sessions").doc(phone).update({
            pendingShiftConfirmation: info,
            stateExpiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        });
        await (0, client_1.sendMessage)(chatId, `So — can you confirm you'll be at ${info.seniorName}'s shift on ${info.appointmentDate}? Reply YES or NO.`);
    }
}
// ── Pre-shift family task check-in handler ───────────────────────────────────
async function handlePreShiftUpdate(phone, chatId, text, session) {
    var _a, _b;
    const info = session.awaitingPreShiftUpdate;
    // isQuestionOrOther check — CLAUDE.md requirement
    const questionRaw = await (0, openaiClient_1.quickComplete)("Is this message a question unrelated to adding care tasks, or is it about something completely different? " +
        "Reply only YES or NO.", text, { maxTokens: 5 }).catch(() => "");
    const isQuestion = questionRaw.trim().toUpperCase().startsWith("Y");
    if (isQuestion) {
        // Generate the answer inline so we control message ordering. The previous
        // implementation sent the raw user text to sendViaInteractionAgent (which
        // generates a reply asynchronously) and immediately followed with the
        // re-ask, so the re-ask could arrive before the answer.
        let answer = "";
        try {
            answer = await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant. A family member was asked if they want to add tasks for today's " +
                `visit with ${(_a = info.caregiverName) !== null && _a !== void 0 ? _a : "the caregiver"} for ${info.seniorName}. Instead they asked a question — ` +
                "answer it briefly (1–2 sentences). Do NOT ask them to add tasks — that prompt comes next.", text, { maxTokens: 180 });
        }
        catch (_c) {
            answer = "Let me get back to you on that. In the meantime —";
        }
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, `So — did you want to add any tasks for ${info.seniorName}'s visit today?`);
        return;
    }
    // Parse action: decline or new tasks
    const parseRaw = await (0, openaiClient_1.quickComplete)("The family was asked if they want to add tasks to today's care visit. " +
        "Extract their response. Reply JSON only: " +
        '{"action":"decline"|"addTasks","tasks":["task description 1","task description 2"]}. ' +
        '"decline" means they said no, nothing to add, or the plan is fine. ' +
        '"addTasks" means they listed one or more things they want done.', text, { maxTokens: 200 }).catch(() => "{}");
    let action = "decline";
    let tasks = [];
    try {
        const parsed = JSON.parse(parseRaw || "{}");
        action = ((_b = parsed.action) !== null && _b !== void 0 ? _b : "decline");
        tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter(Boolean) : [];
    }
    catch ( /* default to decline */_d) { /* default to decline */ }
    // Clear state regardless of action
    await db.collection("agent_sessions").doc(phone).update({
        awaitingPreShiftUpdate: admin.firestore.FieldValue.delete(),
        stateExpiresAt: admin.firestore.FieldValue.delete(),
    });
    if (action === "addTasks" && tasks.length > 0) {
        // Store on the appointment as dayOfVisitTasks
        await db.collection("appointments").doc(info.appointmentId).update({
            dayOfVisitTasks: admin.firestore.FieldValue.arrayUnion(...tasks),
        });
        const cgFirstName = info.caregiverName.split(" ")[0] || info.caregiverName;
        const taskList = tasks.map(t => `• ${t}`).join("\n");
        const addMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "family",
            context: `The family just added ${tasks.length} task${tasks.length > 1 ? "s" : ""} to ` +
                `${info.seniorName}'s care visit today: ${tasks.join(", ")}. ` +
                `${cgFirstName} will be notified when they check in. ` +
                `Write a warm 2-sentence confirmation back to the family. ` +
                `List what was added and reassure them ${cgFirstName} will have it.`,
            fallback: `Got it — I've added ${tasks.length === 1 ? "that" : "those"} to today's plan:\n\n` +
                `${taskList}\n\n` +
                `${cgFirstName} will see ${tasks.length === 1 ? "it" : "them"} when they check in.`,
        });
        await (0, client_1.sendMessage)(chatId, addMsg);
    }
    else {
        const declineMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "family",
            context: `The family said no additional tasks for ${info.seniorName}'s care visit today — ` +
                `the regular care plan is all set. Write a brief, warm 1-sentence confirmation back to them.`,
            fallback: `Perfect — the regular care plan is all set for today's visit!`,
            maxTokens: 60,
        });
        await (0, client_1.sendMessage)(chatId, declineMsg);
    }
}
// ── Care plan briefing sent to caregiver at arrival ───────────────────────────
async function sendArrivalCarePlanBriefing(chatId, apptData) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const clientId = ((_a = apptData.clientId) !== null && _a !== void 0 ? _a : "");
    const seniorId = ((_b = apptData.seniorId) !== null && _b !== void 0 ? _b : clientId);
    const seniorName = ((_c = apptData.clientName) !== null && _c !== void 0 ? _c : "your client");
    // Load care plan (same dual-path as shiftTaskNudges)
    let dailyRoutine = [];
    let medications = [];
    for (const [collection, docId] of [
        ["senior_profiles", seniorId],
        ["senior_profiles", clientId],
    ]) {
        if (!docId)
            continue;
        const snap = await db.collection(collection).doc(docId)
            .collection("care_plans").doc("default").get().catch(() => null);
        if (snap === null || snap === void 0 ? void 0 : snap.exists) {
            const d = snap.data();
            dailyRoutine = ((_d = d.dailyRoutine) !== null && _d !== void 0 ? _d : []);
            medications = ((_e = d.medications) !== null && _e !== void 0 ? _e : []);
            break;
        }
    }
    if (!dailyRoutine.length && !medications.length) {
        // Try legacy flat collection
        const snap = await db.collection("care_plans").doc(clientId).get().catch(() => null);
        if (snap === null || snap === void 0 ? void 0 : snap.exists) {
            const d = snap.data();
            dailyRoutine = ((_f = d.dailyRoutine) !== null && _f !== void 0 ? _f : []);
            medications = ((_g = d.medications) !== null && _g !== void 0 ? _g : []);
        }
    }
    // Day-of tasks added by family (via pre-shift check-in)
    const dayOfVisitTasks = ((_h = apptData.dayOfVisitTasks) !== null && _h !== void 0 ? _h : []);
    if (!dailyRoutine.length && !medications.length && !dayOfVisitTasks.length)
        return;
    // Sort tasks by time (unparseable times go to end)
    const sorted = [...dailyRoutine].sort((a, b) => {
        const toMin = (t) => {
            const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
            if (m) {
                let h = parseInt(m[1], 10);
                if (m[3].toUpperCase() === "AM" && h === 12)
                    h = 0;
                if (m[3].toUpperCase() === "PM" && h !== 12)
                    h += 12;
                return h * 60 + parseInt(m[2], 10);
            }
            const h24 = t.match(/^(\d{1,2}):(\d{2})$/);
            return h24 ? parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10) : 9999;
        };
        return toMin(a.time) - toMin(b.time);
    });
    const lines = sorted.map(t => `• ${t.time} — ${t.description}`);
    if (medications.length > 0) {
        const medLine = medications
            .slice(0, 3)
            .map(m => `${m.name} ${m.dosage} (${m.frequency})`)
            .join(", ");
        lines.push(`\nMedications: ${medLine}`);
    }
    // Day-of tasks added by family today (highest priority — show first)
    let dayOfSection = "";
    if (dayOfVisitTasks.length > 0) {
        const dayOfLines = dayOfVisitTasks.map(t => `• ${t}`).join("\n");
        dayOfSection = `Added for today's visit by the family:\n${dayOfLines}\n\n`;
    }
    const planSection = lines.length > 0
        ? `Regular care plan:\n${lines.join("\n")}`
        : "";
    const cgFirstName = ((_j = apptData.caregiverName) !== null && _j !== void 0 ? _j : "").split(" ")[0] || "there";
    const opening = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `Write one warm, brief opening line (1 sentence) welcoming ${cgFirstName} to ${seniorName}'s visit. ` +
            `${dayOfVisitTasks.length > 0 ? "Mention there are some family additions to the plan today." : "Keep it encouraging."}`,
        fallback: `You're checked in — here's the plan for ${seniorName}'s visit today!`,
        maxTokens: 60,
    });
    const body = `${opening}\n\n` +
        dayOfSection +
        planSection +
        `\n\nReply DONE when the visit is complete, or ISSUE if anything comes up.`;
    await (0, client_1.sendMessage)(chatId, body);
}
async function handleDone(phone, chatId, session, text) {
    var _a, _b, _c, _d, _e;
    const caregiverId = session.caregiverId;
    if (!caregiverId)
        return;
    // If DONE arrived with extra text (e.g. "DONE but I need to ask you something"),
    // surface a question check. The pure-keyword path passes text === "DONE" and
    // we skip the LLM hop.
    if (text && text.trim().toUpperCase() !== "DONE" && text.trim().length > 8) {
        const qRaw = await (0, openaiClient_1.quickComplete)("A caregiver just signaled they're done with a visit. " +
            "Reply YES if their message also contains a question they need answered. " +
            "Reply NO if it's only a sign-off. Only reply YES or NO.", text, { maxTokens: 5 }).catch(() => "NO");
        if (qRaw.trim().toUpperCase().startsWith("Y")) {
            let answer = "";
            try {
                answer = await (0, openaiClient_1.quickComplete)("You are Cara. A caregiver said they're done with a visit and also asked a question. " +
                    "Answer it briefly (1-2 sentences). Do NOT ask them for visit notes yet — that prompt comes next.", text, { maxTokens: 180 });
            }
            catch (_f) {
                answer = "Let me get back to you on that. In the meantime —";
            }
            await (0, client_1.sendMessage)(chatId, answer);
        }
    }
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", today)
        .where("status", "==", "in-progress")
        .limit(1).get();
    const apptData = snap.empty ? null : snap.docs[0].data();
    if (!snap.empty) {
        await snap.docs[0].ref.update({ completedAt: new Date().toISOString() });
    }
    // Store that we're awaiting care notes
    await db.collection("agent_sessions").doc(phone).update({
        awaitingCareNotes: true,
        careNotesApptId: snap.empty ? "" : snap.docs[0].id,
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const seniorName = ((_b = (_a = apptData === null || apptData === void 0 ? void 0 : apptData.clientName) !== null && _a !== void 0 ? _a : apptData === null || apptData === void 0 ? void 0 : apptData.seniorName) !== null && _b !== void 0 ? _b : "your client");
    const cgFirstName = session.caregiverId
        ? ((_e = (_d = (_c = (await db.collection("caregivers").doc(session.caregiverId).get().catch(() => null))) === null || _c === void 0 ? void 0 : _c.data()) === null || _d === void 0 ? void 0 : _d.name) !== null && _e !== void 0 ? _e : "").split(" ")[0]
        : "";
    const doneMessage = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `${cgFirstName ? cgFirstName + " just" : "The caregiver just"} finished their shift with ${seniorName}. ` +
            `Write a warm, celebratory wrap-up message asking them to share how the visit went. ` +
            `Ask them to mention: what they did with ${seniorName}, how ${seniorName} was feeling/acting, ` +
            `notes on any tasks completed, and anything ${seniorName} asked for that wasn't in the regular plan. ` +
            `Tell them you'll put together a nice update for the family. ` +
            `Sound genuinely appreciative of their work — like a coordinator who cares.`,
        fallback: `Amazing work today${cgFirstName ? ", " + cgFirstName : ""}! 🙌 ` +
            `Before I send the family an update — tell me how it went with ${seniorName}. ` +
            `What did you two get up to, how was ${seniorName} feeling, and anything special to note? ` +
            `I'll take it from there.`,
        maxTokens: 200,
    });
    await (0, client_1.sendMessage)(chatId, doneMessage);
}
async function handleRunningLate(phone, chatId) {
    await db.collection("agent_sessions").doc(phone).update({
        awaitingLateMinutes: true,
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const howLateMsg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: "Caregiver said they're running late. Cara is asking how late they expect to be.",
        fallback: "How late do you think you'll be?",
        maxTokens: 60,
    });
    await (0, client_1.sendMessage)(chatId, howLateMsg);
}
async function handleIssue(phone, chatId) {
    await db.collection("agent_sessions").doc(phone).update({
        awaitingIssueDescription: true,
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const issuePromptMsg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: "Caregiver reported an issue during a visit. Cara is asking them to describe what's happening.",
        fallback: "I'm sorry to hear that. Can you describe what's happening?",
        maxTokens: 80,
    });
    await (0, client_1.sendMessage)(chatId, issuePromptMsg);
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
async function getClientPhoneByClientId(clientId) {
    var _a;
    if (!clientId)
        return null;
    const snap = await db.collection("agent_sessions")
        .where("userId", "==", clientId).limit(1).get();
    if (snap.empty)
        return null;
    return (_a = snap.docs[0].data().phone) !== null && _a !== void 0 ? _a : snap.docs[0].id;
}
// ── Mid-shift family micro-update (task completed) ────────────────────────────
async function sendFamilyTaskUpdate(params) {
    var _a, _b, _c, _d, _e, _f;
    const { taskDescription, taskCategory, notes, clientId, seniorId, clientPhone, caregiverId } = params;
    // Resolve names
    let seniorName = "";
    if (seniorId) {
        const snap = await db.collection("senior_profiles").doc(seniorId).get().catch(() => null);
        seniorName = ((_b = (_a = snap === null || snap === void 0 ? void 0 : snap.data()) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "");
    }
    if (!seniorName && clientId) {
        const snap = await db.collection("users").doc(clientId).get().catch(() => null);
        seniorName = ((_d = (_c = snap === null || snap === void 0 ? void 0 : snap.data()) === null || _c === void 0 ? void 0 : _c.seniorName) !== null && _d !== void 0 ? _d : "");
    }
    if (!seniorName)
        seniorName = "your loved one";
    let cgFirstName = "";
    if (caregiverId) {
        const snap = await db.collection("caregivers").doc(caregiverId).get().catch(() => null);
        const name = ((_f = (_e = snap === null || snap === void 0 ? void 0 : snap.data()) === null || _e === void 0 ? void 0 : _e.name) !== null && _f !== void 0 ? _f : "");
        cgFirstName = name.split(" ")[0] || name;
    }
    if (!cgFirstName)
        cgFirstName = "Your caregiver";
    let content;
    try {
        const raw = await (0, openaiClient_1.quickComplete)("You write a brief 1-2 sentence real-time care update for a family member.\n" +
            "Tone: warm, direct, reassuring. From Cara (a care coordinator), not the caregiver.\n" +
            "Keep it short — this is a mid-shift task update. No emoji. Output only the message text.", `Task just completed: ${taskDescription}\n` +
            `Category: ${taskCategory}\n` +
            `Caregiver notes: ${notes || "no additional notes"}\n` +
            `Senior: ${seniorName}\n` +
            `Caregiver: ${cgFirstName}`, { maxTokens: 120 });
        content = raw.trim();
        if (!content)
            throw new Error("empty");
    }
    catch (_g) {
        content = `${cgFirstName} just completed ${taskDescription} for ${seniorName}.${notes ? " " + notes : ""}`;
    }
    await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
        content,
        urgency: "standard",
        sourceAgent: "shift_task_family_update",
        canDrop: true,
    });
}
// ── Shift-end family update (after care notes parsed) ────────────────────────
async function sendFamilyShiftEndUpdate(params) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const { caregiverName, clientId, seniorId, apptData, entry } = params;
    const clientPhone = await getClientPhoneByClientId(clientId);
    if (!clientPhone)
        return;
    // Resolve senior name
    let seniorName = ((_a = apptData === null || apptData === void 0 ? void 0 : apptData.clientName) !== null && _a !== void 0 ? _a : "");
    if (!seniorName && seniorId) {
        const snap = await db.collection("senior_profiles").doc(seniorId).get().catch(() => null);
        seniorName = ((_c = (_b = snap === null || snap === void 0 ? void 0 : snap.data()) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : "");
    }
    if (!seniorName)
        seniorName = "your loved one";
    const cgFirstName = caregiverName.split(" ")[0] || caregiverName;
    const mood = ((_d = entry.mood) !== null && _d !== void 0 ? _d : "");
    const appetite = ((_e = entry.appetite) !== null && _e !== void 0 ? _e : "");
    const activities = ((_f = entry.activities) !== null && _f !== void 0 ? _f : []);
    const observations = ((_g = entry.observations) !== null && _g !== void 0 ? _g : "");
    const notes = ((_h = entry.notes) !== null && _h !== void 0 ? _h : "");
    const unplannedActivities = ((_j = entry.unplannedActivities) !== null && _j !== void 0 ? _j : []);
    const taskNotes = ((_k = entry.taskNotes) !== null && _k !== void 0 ? _k : "");
    let content;
    try {
        const unplannedLine = unplannedActivities.length > 0
            ? `Unplanned activities (requested by senior): ${unplannedActivities.join(", ")}`
            : "No unplanned activities";
        const raw = await (0, openaiClient_1.quickComplete)("You write a warm, personal text message to a family member after their loved one's care visit.\n" +
            "Tone: warm and reassuring, like a trusted care coordinator. From Cara, not the caregiver.\n" +
            "Structure: 1) Start with the visit wrapping up and overall mood/meals. " +
            "2) Mention planned tasks completed with any notes. " +
            "3) If the senior asked for anything outside the plan, mention it clearly. " +
            "4) End with whether there are any concerns.\n" +
            "Keep it to 4-5 sentences. No bullet points. No emoji. Output only the message text, no greeting or sign-off.", `Senior: ${seniorName}\n` +
            `Caregiver: ${cgFirstName}\n` +
            `Mood: ${mood || "not reported"}\n` +
            `Appetite: ${appetite || "not reported"}\n` +
            `Activities completed: ${activities.length > 0 ? activities.join(", ") : "not reported"}\n` +
            `Notes on completed tasks: ${taskNotes || "none"}\n` +
            `${unplannedLine}\n` +
            `Observations: ${observations || "none"}\n` +
            `Additional notes: ${notes || "none"}`, { maxTokens: 280 });
        content = raw.trim();
        if (!content)
            throw new Error("empty");
    }
    catch (_l) {
        const moodLine = mood ? ` ${seniorName} was in a ${mood} mood.` : "";
        const ateLine = appetite ? ` Appetite was ${appetite}.` : "";
        const actLine = activities.length > 0 ? ` Activities: ${activities.slice(0, 2).join(" and ")}.` : "";
        const unplannedNote = unplannedActivities.length > 0
            ? ` ${seniorName} also asked for: ${unplannedActivities.join(", ")}.`
            : "";
        const obsLine = observations ? ` ${observations}` : "";
        content =
            `${cgFirstName} just finished their visit with ${seniorName}.` +
                moodLine + ateLine + actLine + unplannedNote + obsLine +
                " No concerns to flag.";
    }
    await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
        content,
        urgency: "standard",
        sourceAgent: "shift_end_family_update",
        canDrop: true,
    });
}
// ── Task acknowledgment handler ───────────────────────────────────────────────
async function handleTaskAck(phone, chatId, text, session) {
    var _a, _b, _c;
    const taskInfo = session.awaitingTaskAck;
    // isQuestionOrOther check — CLAUDE.md requirement
    const questionRaw = await (0, openaiClient_1.quickComplete)("Is this message a question or completely unrelated to completing a care task? " +
        "Reply only YES or NO.", text, { maxTokens: 5 }).catch(() => "");
    const isQuestion = questionRaw.trim().toUpperCase().startsWith("Y");
    if (isQuestion) {
        // Let the normal caraAgent handle the question, then re-ask about the task
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: text,
            urgency: "standard",
            sourceAgent: "task_ack_question",
            canDrop: true,
        });
        await (0, client_1.sendMessage)(chatId, `By the way — did you complete ${taskInfo.taskDescription}?`);
        return;
    }
    // Parse completion + any brief notes
    const ackRaw = await (0, openaiClient_1.quickComplete)("Did the caregiver confirm completing the task? Also extract any brief notes about how it went. " +
        'Reply JSON only: {"completed":"YES"|"NO"|"UNCLEAR","notes":"brief detail or empty string"}', text, { maxTokens: 80 }).catch(() => "{}");
    let completed = true; // default to trusting the caregiver
    let notes = "";
    try {
        const parsed = JSON.parse(ackRaw || "{}");
        completed = ((_a = parsed.completed) !== null && _a !== void 0 ? _a : "YES") !== "NO";
        notes = ((_b = parsed.notes) !== null && _b !== void 0 ? _b : "").trim();
    }
    catch ( /* keep defaults */_d) { /* keep defaults */ }
    if (completed) {
        // Mark task done on appointment doc
        await db.collection("appointments").doc(taskInfo.appointmentId).update({
            completedTaskIds: admin.firestore.FieldValue.arrayUnion(taskInfo.taskId),
        }).catch(() => { });
        // Send family micro-update
        const clientPhone = await getClientPhoneByClientId(taskInfo.clientId);
        if (clientPhone) {
            sendFamilyTaskUpdate({
                taskDescription: taskInfo.taskDescription,
                taskCategory: taskInfo.taskCategory,
                notes,
                clientId: taskInfo.clientId,
                seniorId: taskInfo.seniorId,
                clientPhone,
                caregiverId: (_c = session.caregiverId) !== null && _c !== void 0 ? _c : "",
            }).catch(err => console.error("[handleTaskAck] sendFamilyTaskUpdate error:", err));
        }
        const ackMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: notes
                ? `The caregiver just confirmed completing "${taskInfo.taskDescription}" for ${taskInfo.seniorName} ` +
                    `and added a brief note: "${notes}". Write a warm 1-sentence acknowledgment — thank them and ` +
                    `mention you'll pass the update along to the family.`
                : `The caregiver just confirmed completing "${taskInfo.taskDescription}" for ${taskInfo.seniorName}. ` +
                    `Write a warm, brief 1-sentence acknowledgment.`,
            fallback: notes ? `Got it — I'll let the family know!` : `Got it — great work!`,
            maxTokens: 60,
        });
        await (0, client_1.sendMessage)(chatId, ackMsg);
    }
    else {
        const notDoneMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: `The caregiver said they haven't completed "${taskInfo.taskDescription}" for ` +
                `${taskInfo.seniorName} yet. Write a gentle, understanding 1-sentence reply — ` +
                `no pressure, Cara will follow up with them again soon.`,
            fallback: `No worries — I'll check back with you soon!`,
            maxTokens: 60,
        });
        await (0, client_1.sendMessage)(chatId, notDoneMsg);
    }
    // Clear state
    await db.collection("agent_sessions").doc(phone).update({
        awaitingTaskAck: admin.firestore.FieldValue.delete(),
        stateExpiresAt: admin.firestore.FieldValue.delete(),
    });
}
// ── Caregiver voice/text → structured journal ─────────────────────────────────
async function handleCareNotes(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u;
    // ── isQuestionOrOther — if caregiver is asking a question alongside (or
    // instead of) shift notes, answer it first then re-prompt. Skip the LLM
    // hop for short messages that look like a clear answer (< 30 chars).
    if (text.trim().length >= 30) {
        const questionRaw = await (0, openaiClient_1.quickComplete)("A caregiver was asked to share notes about a care visit they just finished " +
            "(mood, meals, activities, anything notable). " +
            "Reply YES if their message is primarily a question to the assistant rather than visit notes. " +
            "Reply NO if it is visit notes (even if a small question is buried inside). Only reply YES or NO.", text, { maxTokens: 5 }).catch(() => "NO");
        if (questionRaw.trim().toUpperCase().startsWith("Y")) {
            let answer = "";
            try {
                answer = await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant. A caregiver just finished a shift and was asked for visit notes, " +
                    "but instead they asked a question. Answer it briefly (1-2 sentences). " +
                    "Do NOT ask them for notes — that prompt comes next.", text, { maxTokens: 180 });
            }
            catch (_v) {
                answer = "Let me get back to you on that. In the meantime —";
            }
            await (0, client_1.sendMessage)(chatId, answer);
            await (0, client_1.sendMessage)(chatId, "Now — tell me how the visit went so I can send the family an update. (Mood, meals, activities, anything notable.)");
            return;
        }
    }
    const structuredRaw = await (0, openaiClient_1.quickComplete)("Convert this caregiver note into a structured care journal entry. " +
        'Reply in JSON: {"overallWellness":1,"mood":"happy|neutral|agitated|confused|tired",' +
        '"appetite":"good|fair|poor|refused","activities":[],"medications":[],' +
        '"observations":"","notes":"","unplannedActivities":[],"taskNotes":""}', text, { maxTokens: 300 }).catch(() => "{}");
    let entry = {};
    try {
        entry = JSON.parse(structuredRaw || "{}");
    }
    catch (_w) {
        entry = { notes: text };
    }
    const apptId = (_a = session.careNotesApptId) !== null && _a !== void 0 ? _a : "";
    const caregiverId = (_b = session.caregiverId) !== null && _b !== void 0 ? _b : "";
    // Get clientId from appointment and re-validate status
    let clientId = "";
    let seniorId = "";
    if (apptId) {
        const apptSnap = await db.collection("appointments").doc(apptId).get();
        const apptData = apptSnap.data();
        clientId = (_c = apptData === null || apptData === void 0 ? void 0 : apptData.clientId) !== null && _c !== void 0 ? _c : "";
        seniorId = (_d = apptData === null || apptData === void 0 ? void 0 : apptData.seniorId) !== null && _d !== void 0 ? _d : clientId;
        // Re-validate: only write notes if appointment was actually in progress or just completed
        const validStatuses = ["in-progress", "completed", "confirmed"];
        if (apptData && !validStatuses.includes((_e = apptData.status) !== null && _e !== void 0 ? _e : "")) {
            await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
            const cancelledNotesMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: "Caregiver submitted care notes but the visit was cancelled so notes cannot be saved. Let them know apologetically.",
                fallback: "I wasn't able to save those notes — it looks like that visit was cancelled.",
                maxTokens: 80,
            });
            await (0, client_1.sendMessage)(chatId, cancelledNotesMsg);
            return;
        }
        // Dedup + write in a single transaction to prevent duplicate journal entries if
        // two requests race (e.g. duplicate webhook delivery or fast caregiver retap).
        let alreadyExists = false;
        const journalRef = db.collection("care_journal").doc();
        const sessionRef = db.collection("agent_sessions").doc(phone);
        await db.runTransaction(async (t) => {
            var _a, _b, _c, _d;
            const existingSnap = await t.get(db.collection("care_journal")
                .where("appointmentId", "==", apptId)
                .limit(1));
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
            const notesAlreadySavedMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: "Caregiver tried to submit notes but notes for this visit are already saved. Let them know briefly.",
                fallback: "Notes for this visit are already saved.",
                maxTokens: 60,
            });
            await (0, client_1.sendMessage)(chatId, notesAlreadySavedMsg);
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
            notes: (_f = entry.notes) !== null && _f !== void 0 ? _f : text,
            wellness: {
                ateWell: entry.appetite === "good",
                tookMeds: Array.isArray(entry.medications) && entry.medications.length > 0,
                wasActive: Array.isArray(entry.activities) && entry.activities.length > 0,
                mood: (_g = entry.mood) !== null && _g !== void 0 ? _g : "neutral",
            },
            activities: (_h = entry.activities) !== null && _h !== void 0 ? _h : [],
            observations: (_j = entry.observations) !== null && _j !== void 0 ? _j : "",
        });
        await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
    }
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const hourlyRate = (_l = (_k = cgSnap.data()) === null || _k === void 0 ? void 0 : _k.hourlyRate) !== null && _l !== void 0 ? _l : 20;
    const apptSnap = apptId
        ? await db.collection("appointments").doc(apptId).get()
        : null;
    const durationHours = (_o = (_m = apptSnap === null || apptSnap === void 0 ? void 0 : apptSnap.data()) === null || _m === void 0 ? void 0 : _m.durationHours) !== null && _o !== void 0 ? _o : 4;
    const pay = (hourlyRate * durationHours).toFixed(2);
    // Fire shift-end family update (fire-and-forget — alreadyExists early-returns above, so if we
    // reach here the journal entry was newly written)
    if (apptId && clientId) {
        sendFamilyShiftEndUpdate({
            caregiverName: (_q = (_p = cgSnap.data()) === null || _p === void 0 ? void 0 : _p.name) !== null && _q !== void 0 ? _q : "Your caregiver",
            clientId,
            seniorId,
            apptData: (_r = apptSnap === null || apptSnap === void 0 ? void 0 : apptSnap.data()) !== null && _r !== void 0 ? _r : null,
            entry,
        }).catch(err => console.error("[handleCareNotes] family update error:", err));
    }
    // Fire visit billing (fire-and-forget so it doesn't block caregiver confirmation)
    if (apptId && clientId) {
        const { createVisitPayment } = await Promise.resolve().then(() => __importStar(require("../billing/visitBilling")));
        createVisitPayment({
            appointmentId: apptId,
            clientId,
            clientPhone: "", // Family phone looked up inside createVisitPayment if needed
            caregiverId,
            caregiverName: (_t = (_s = cgSnap.data()) === null || _s === void 0 ? void 0 : _s.name) !== null && _t !== void 0 ? _t : "Your caregiver",
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
        : `Next visit: ${nextSnap.docs[0].data().date} at ${(_u = nextSnap.docs[0].data().startTime) !== null && _u !== void 0 ? _u : ""}`;
    await (0, client_1.sendMessage)(chatId, `Got it — notes saved.\n\n` +
        `Your payment of $${pay} will be processed tonight.\n` +
        `${nextLine}\n\n` +
        `Have a great rest of your day.`);
}
// ── Post-visit feedback sentiment classifier ──────────────────────────────────
async function classifyFeedbackSentiment(text) {
    try {
        const raw = await (0, openaiClient_1.quickComplete)("Classify this feedback about a home care visit as positive, negative, or neutral. " +
            "Consider tone, context, and nuance — not just keywords. " +
            "Reply with one word: POSITIVE, NEGATIVE, or NEUTRAL.", text, { maxTokens: 10 });
        const label = raw.trim().toUpperCase();
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41, _42, _43, _44, _45, _46, _47, _48, _49, _50, _51, _52, _53, _54, _55, _56, _57, _58, _59, _60, _61, _62, _63, _64, _65, _66, _67, _68, _69, _70, _71, _72, _73, _74, _75, _76, _77, _78, _79, _80, _81, _82, _83, _84, _85, _86, _87, _88, _89, _90, _91, _92, _93, _94, _95, _96, _97, _98, _99, _100, _101, _102, _103, _104, _105, _106, _107, _108, _109, _110, _111, _112, _113, _114, _115, _116, _117, _118, _119, _120, _121, _122, _123, _124, _125, _126, _127, _128, _129, _130, _131, _132, _133, _134, _135, _136, _137, _138, _139, _140, _141, _142, _143, _144, _145, _146, _147, _148, _149, _150, _151, _152, _153, _154, _155, _156, _157, _158, _159, _160, _161, _162, _163, _164, _165, _166, _167, _168, _169, _170, _171, _172, _173, _174, _175, _176, _177, _178;
    const ev = event;
    const phone = (_b = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.handle;
    const chatId = (_d = (_c = ev.data) === null || _c === void 0 ? void 0 : _c.chat) === null || _d === void 0 ? void 0 : _d.id;
    const service = ((_j = (_f = (_e = ev.data) === null || _e === void 0 ? void 0 : _e.service) !== null && _f !== void 0 ? _f : (_h = (_g = ev.data) === null || _g === void 0 ? void 0 : _g.chat) === null || _h === void 0 ? void 0 : _h.service) !== null && _j !== void 0 ? _j : "SMS");
    if (!phone || !chatId)
        return;
    // Collect text from all text-type parts (handles multi-part messages).
    // Non-text parts (sticker, audio, media) have no value — detect media-only messages.
    const inboundParts = ((_l = (_k = ev.data) === null || _k === void 0 ? void 0 : _k.parts) !== null && _l !== void 0 ? _l : []);
    let text = inboundParts
        .filter((p) => p.type === "text" && p.value)
        .map((p) => String(p.value))
        .join(" ")
        .trim();
    let isMediaOnly = text === "" && inboundParts.length > 0;
    // Mark the inbound as read so iMessage shows the "Read" receipt immediately —
    // this is what surfaces the blue "Read" indicator under the user's bubble.
    (0, client_1.markChatRead)(chatId).catch(() => { });
    // Fire typing indicator immediately — before any async work — so the family
    // never sees silence during the ~200ms session load + routing decisions.
    // For voice memos this matters even more: Whisper takes a few seconds.
    if (service === "iMessage")
        (0, client_1.startTyping)(chatId).catch(() => { });
    // ── Voice memo → Whisper transcription ─────────────────────────────────────
    // Users who can't easily type tap-and-hold to send a voice memo. Transcribe
    // it and fall through to normal text processing so the rest of Cara doesn't
    // need to care that the input was spoken.
    if (text === "") {
        const voicePart = (0, voiceTranscription_1.extractVoiceMemoPart)(inboundParts);
        if (voicePart) {
            try {
                const transcript = await (0, voiceTranscription_1.transcribeVoiceMemo)(voicePart);
                if (transcript) {
                    text = transcript;
                    isMediaOnly = false;
                    // Re-mark read now that the audio attachment is fully committed on
                    // Linq's side. The initial markChatRead at t=0 races with audio
                    // ingestion, so a voice memo otherwise shows "Delivered" but not
                    // "Read" (unlike text, which is committed before the webhook fires).
                    (0, client_1.markChatRead)(chatId).catch(() => { });
                    console.info("voiceMemo transcribed", {
                        phone,
                        chatId,
                        chars: transcript.length,
                        duration_ms: voicePart.duration_ms,
                    });
                }
            }
            catch (err) {
                console.error("voiceMemo transcription failed", {
                    phone,
                    chatId,
                    err: err === null || err === void 0 ? void 0 : err.message,
                });
            }
        }
    }
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    // Track last-inbound time so the silence detector (scheduled function) can
    // find users who haven't messaged in 3+ days and send a gentle check-in.
    // Also keep session chatId in sync with the actual Linq thread (Linq webhook
    // delivers on the chat where the user replied, which may differ from the
    // chatId we created — replying to a stale chatId returns 400).
    if (sessionSnap.exists) {
        const stored = sessionSnap.data();
        const update = { lastInboundAt: new Date().toISOString() };
        if (stored.chatId && stored.chatId !== chatId) {
            update.chatId = chatId;
            update.service = service;
        }
        await db.collection("agent_sessions").doc(phone).update(update).catch(() => { });
    }
    // ── New user — texted first (MO consent) ────────────────────────────────────
    if (!sessionSnap.exists) {
        // Check if this phone belongs to a secondary family group member.
        // Two sources must be reconciled: the SMS-keyword path writes the primary
        // session's `groupMembers` array, while the MCP `add_family_member` tool path
        // writes the `family_group_members` collection. Check BOTH or an MCP-added
        // member ("add my sister") would fall through to fresh onboarding and create a
        // DUPLICATE account.
        let primarySession = null;
        let primaryPhone = "";
        const groupSnap = await db.collection("agent_sessions")
            .where("groupMembers", "array-contains", phone)
            .limit(1)
            .get();
        if (!groupSnap.empty) {
            primarySession = groupSnap.docs[0].data();
            primaryPhone = groupSnap.docs[0].id;
        }
        else {
            // Fallback: look up the collection-based membership record (MCP-added members).
            const memberSnap = await db.collection("family_group_members")
                .where("memberPhone", "==", phone)
                .limit(1)
                .get();
            if (!memberSnap.empty) {
                const pPhone = memberSnap.docs[0].data().primaryPhone;
                if (pPhone) {
                    const pSnap = await db.collection("agent_sessions").doc(pPhone).get();
                    if (pSnap.exists) {
                        primarySession = pSnap.data();
                        primaryPhone = pPhone;
                    }
                }
            }
        }
        if (primarySession) {
            // Detect messaging capability so session reflects real service (SMS vs iMessage vs RCS)
            const secondaryCap = await (0, client_1.checkCapability)(phone);
            const secondaryService = secondaryCap.iMessage ? "iMessage" : secondaryCap.RCS ? "RCS" : "SMS";
            // Create a lightweight session for this member pointing to the primary
            await db.collection("agent_sessions").doc(phone).set({
                chatId,
                phone,
                service: secondaryService,
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
            await (0, client_1.sendMessage)(chatId, `Hi, I'm Cara — the care assistant for ${(_o = (_m = primarySession.onboardingData) === null || _m === void 0 ? void 0 : _m.seniorName) !== null && _o !== void 0 ? _o : "your family"}. ` +
                `I've added you to the care group. You'll get the same updates and can ask me anything.`);
            return;
        }
        const capability = await (0, client_1.checkCapability)(phone);
        const service = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";
        await (0, sms_1.setupCaraContactCard)().catch(() => { });
        // Detect language from the first message so OTP + onboarding speak the
        // family's language from the start.
        const detected = await (0, language_1.detectLanguage)(text).catch(() => null);
        const preferredLanguage = detected !== null && detected !== void 0 ? detected : "en";
        // ── Web-onboarding bridge ──────────────────────────────────────────────────
        // If this phone just verified through Firebase Phone Auth on the web and is
        // awaiting their first inbound, skip the SMS-side OTP entirely — phone
        // possession is already proven by the Firebase token they presented when
        // calling createWebOnboardingSession. Route them straight into the role's
        // first onboarding step.
        const webSessionRef = db.collection("web_onboarding_sessions").doc(phone);
        const webSessionSnap = await webSessionRef.get();
        if (webSessionSnap.exists && ((_p = webSessionSnap.data()) === null || _p === void 0 ? void 0 : _p.status) === "awaiting_inbound") {
            const webRole = ((_q = webSessionSnap.data()) === null || _q === void 0 ? void 0 : _q.role) === "caregiver" ? "caregiver" : "client";
            const firstStep = webRole === "caregiver" ? "caregiver_ask_name" : "client_ask_name";
            // Returning user — phone already linked to an account. Skip re-onboarding;
            // restore their account context and greet them as a known user. Without
            // this, a returning user who re-verified on /start would be walked through
            // onboarding from scratch.
            const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
            const isReturning = !userQuery.empty;
            if (isReturning) {
                const userDoc = userQuery.docs[0];
                const userData = userDoc.data();
                const seniorIds = (_r = userData.seniorIds) !== null && _r !== void 0 ? _r : [];
                const seniorId = (_t = (_s = userData.seniorId) !== null && _s !== void 0 ? _s : seniorIds[0]) !== null && _t !== void 0 ? _t : "";
                await db.collection("agent_sessions").doc(phone).set({
                    chatId,
                    phone,
                    service,
                    userType: (_u = userData.userType) !== null && _u !== void 0 ? _u : webRole,
                    userId: userDoc.id,
                    seniorId,
                    onboardingStep: "complete",
                    optedIn: true,
                    optedOut: false,
                    preferredLanguage,
                    createdAt: new Date().toISOString(),
                    webOnboardingUid: (_w = (_v = webSessionSnap.data()) === null || _v === void 0 ? void 0 : _v.uid) !== null && _w !== void 0 ? _w : null,
                });
            }
            else {
                await db.collection("agent_sessions").doc(phone).set({
                    chatId,
                    phone,
                    service,
                    userType: webRole,
                    onboardingStep: firstStep,
                    optedIn: true,
                    optedOut: false,
                    preferredLanguage,
                    createdAt: new Date().toISOString(),
                    webOnboardingUid: (_y = (_x = webSessionSnap.data()) === null || _x === void 0 ? void 0 : _x.uid) !== null && _y !== void 0 ? _y : null,
                });
            }
            // Mark the web bridge as connected so the desktop/mobile tab can flip to
            // the success state via its onSnapshot listener.
            await webSessionRef.update({
                status: "connected",
                connectedAt: admin.firestore.Timestamp.now(),
                chatId,
            }).catch(() => { });
            await (0, zepClient_1.initializeZepOnFirstContact)(phone).catch((err) => console.error("Zep init failed (web bridge):", err));
            if (service === "iMessage")
                await (0, client_1.startTyping)(chatId).catch(() => { });
            let welcome;
            if (isReturning) {
                welcome = preferredLanguage === "es"
                    ? "¡Hola otra vez! Soy Cara. Me alegra verte de nuevo — ¿en qué te puedo ayudar hoy?"
                    : "Welcome back! It's Cara. Good to hear from you again — how can I help today?";
            }
            else {
                // Role-aware welcome — mirrors what handleAskRole sends so the user
                // experiences the same conversational onboarding from message #1.
                welcome = webRole === "caregiver"
                    ? (preferredLanguage === "es"
                        ? "¡Hola! Soy Cara — tu asistente para encontrar trabajo de cuidado. Configurar tu perfil toma unos 5 minutos y todo pasa aquí por mensaje.\n\n¿Cómo te llamas?"
                        : "Hi! I'm Cara — your assistant for finding caregiving work. Setting up your profile takes about 5 minutes and everything happens right here.\n\nWhat's your name?")
                    : (preferredLanguage === "es"
                        ? "¡Hola! Soy Cara, tu coordinadora de cuidados. Me encantaría ayudarte.\n\n¿Cómo te llamas?"
                        : "Hi! I'm Cara, your care coordinator. I'd love to help.\n\nWhat's your name?");
            }
            await (0, client_1.sendMessage)(chatId, welcome);
            if (service === "iMessage")
                (0, client_1.shareContactCard)(chatId).catch(() => { });
            return;
        }
        // No web session and no prior history — a cold inbound. Phone verification
        // happens on the WEBSITE (Firebase Phone Auth) before createWebOnboardingSession,
        // not over SMS — so we do NOT gate the thread behind an OTP. Lead with a proper
        // Cara intro and start onboarding right here in the thread; the inbound number
        // is the conversation identity.
        await db.collection("agent_sessions").doc(phone).set({
            chatId,
            phone,
            service,
            userType: null,
            onboardingStep: "ask_role",
            optedIn: true,
            optedOut: false,
            preferredLanguage,
            createdAt: new Date().toISOString(),
        });
        // Start Zep memory immediately — awaited so zepThreadId is written before
        // the next message arrives (fast: ~200ms HTTP call).
        await (0, zepClient_1.initializeZepOnFirstContact)(phone).catch((err) => console.error("Zep init failed (first contact):", err));
        if (service === "iMessage")
            await (0, client_1.startTyping)(chatId).catch(() => { });
        const coldIntro = preferredLanguage === "es"
            ? "¡Hola! Soy Cara, tu coordinadora de cuidados con IA. Ayudo a las familias a encontrar cuidadores de " +
                "confianza con verificación de antecedentes — y a los cuidadores a encontrar trabajo — todo aquí por mensaje.\n\n" +
                "¿Buscas cuidado para un ser querido, o eres un cuidador?\n\n" +
                "1️⃣  Necesito cuidado para alguien\n" +
                "2️⃣  Soy cuidador buscando trabajo"
            : "Hi — I'm Cara, your AI care coordinator. I help families find trusted, background-checked caregivers — " +
                "and help caregivers find work — all right here by text.\n\n" +
                "Are you looking for care for a loved one, or are you a caregiver?\n\n" +
                "1️⃣  I need care for someone\n" +
                "2️⃣  I'm a caregiver looking for work";
        await (0, client_1.sendMessage)(chatId, coldIntro);
        // Share contact card AFTER the first outbound message — Linq requires at least
        // one outbound message in history before the share endpoint accepts the call.
        if (service === "iMessage")
            (0, client_1.shareContactCard)(chatId).catch(() => { });
        return;
    }
    const session = sessionSnap.data();
    const norm = text.trim().toUpperCase();
    const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END", "OPTOUT"]);
    // ── Chat health gate — honour OPTED_OUT; do NOT mute direct replies ───────────
    // We only hard-stop on OPTED_OUT (a real user opt-out we must respect). CRITICAL
    // health reflects line/deliverability risk that matters for PROACTIVE/bulk sends
    // (reminders, digests) — those are already gated by the global circuit breaker and
    // sendIfNotDND. Suppressing a direct reply to a user who just texted in makes Cara
    // look broken, so we log CRITICAL for observability but still respond. If Linq
    // genuinely rejects the send, sendMessage surfaces that downstream.
    const chatHealth = ((_2 = (_1 = (_0 = (_z = ev.data) === null || _z === void 0 ? void 0 : _z.chat) === null || _0 === void 0 ? void 0 : _0.health_status) === null || _1 === void 0 ? void 0 : _1.status) !== null && _2 !== void 0 ? _2 : "HEALTHY");
    if (chatHealth === "OPTED_OUT" && !session.optedOut) {
        await db.collection("agent_sessions").doc(phone).update({ optedOut: true }).catch(() => { });
        return;
    }
    if (chatHealth === "CRITICAL") {
        console.warn("handleInbound: chat health CRITICAL — replying anyway (active inbound)", { phone, chatId });
    }
    // START — opt back in (must run BEFORE the opted-out early return, otherwise
    // opted-out users can never reach this handler).
    if (session.optedOut) {
        const startWords = new Set(["START", "UNSTOP", "RESUBSCRIBE", "YES", "SI", "SÍ"]);
        if (startWords.has(norm)) {
            await (0, sms_1.optInPhoneNumber)(phone);
            const lang = (0, language_1.languageFromSession)(session);
            // TCPA opt-in confirmation must land reliably — force SMS, never iMessage.
            await (0, client_1.sendMessage)(chatId, language_1.t.opt_in_welcome_back(lang), { preferredService: "SMS" });
            return;
        }
        return;
    }
    // ── Sticker / voice memo / media-only — no text to process ──────────────────
    // Stickers are inbound-only (API doesn't support sending them). Voice memos
    // are transcribed above; if that failed we still land here. Other media
    // parts have no value field — react warmly and exit before the intent
    // classifier receives an empty string.
    if (isMediaOnly) {
        await (0, client_1.stopTyping)(chatId).catch(() => { });
        // Re-mark read now the media attachment is fully committed on Linq's side.
        // The initial markChatRead at t=0 races with attachment ingestion, so
        // media (stickers, voice memos, images) otherwise shows "Delivered" but
        // not "Read" (unlike text, which is committed before the webhook fires).
        (0, client_1.markChatRead)(chatId).catch(() => { });
        const partTypes = inboundParts.map((p) => { var _a; return String((_a = p.type) !== null && _a !== void 0 ? _a : "").toLowerCase(); });
        const hasVoiceMemo = (0, voiceTranscription_1.extractVoiceMemoPart)(inboundParts) !== null;
        if (partTypes.includes("sticker")) {
            await (0, client_1.sendMessage)(chatId, "Love it! 😊 What can I help you with today?");
        }
        else if (hasVoiceMemo) {
            await (0, client_1.sendMessage)(chatId, "I got your voice memo but couldn't quite make it out — could you send it again, or type what you need? I'm here either way.");
        }
        else {
            await (0, client_1.sendMessage)(chatId, "Got your message! If you have a question or need help, just type it out.");
        }
        return;
    }
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
                        onboardingData: (_3 = session.onboardingData) !== null && _3 !== void 0 ? _3 : {},
                        savedAt: new Date().toISOString(),
                    },
                }).catch(() => { });
            }
            // Identify which non-onboarding flow was active so the user gets a
            // contextual timeout message instead of the generic "session timed out".
            // Names track the state-flag families defined in utils/sessionState.ts.
            const flowKey = session.jobPostingStep ? "job_posting" :
                session.refundStep ? "refund" :
                    session.modifyScheduleStep ? "modify_schedule" :
                        session.clientSwapStep ? "client_swap" :
                            session.healthcareFlowStep ? "healthcare" :
                                session.collectingCredential ? "credential" :
                                    session.hireMode ? "hire" :
                                        session.pendingMatches ? "matches" :
                                            session.pendingTaskConfirm ? "booking_confirm" :
                                                null;
            const lang = (0, language_1.languageFromSession)(session);
            await (0, sessionState_1.clearAllStateFlags)(phone, db);
            if (isOnboarding) {
                await (0, client_1.sendMessage)(chatId, language_1.t.session_timeout_onboarding(lang));
            }
            else if (flowKey) {
                await (0, client_1.sendMessage)(chatId, language_1.t.session_timeout_flow((0, language_1.flowLabel)(flowKey, lang), lang));
            }
            else {
                await (0, client_1.sendMessage)(chatId, language_1.t.session_timeout_generic(lang));
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
        const lang = (0, language_1.languageFromSession)(session);
        // TCPA opt-out confirmation must land reliably — force SMS, never iMessage.
        await (0, client_1.sendMessage)(chatId, language_1.t.opt_out_confirmation(lang), { preferredService: "SMS" });
        return;
    }
    // ── Subscription lapse — graceful degradation for clients with lapsed billing ─
    if (session.userType === "client" && session.onboardingStep === "complete") {
        const userId = (_4 = session.userId) !== null && _4 !== void 0 ? _4 : phone;
        const userSnap = await db.collection("users").doc(userId).get().catch(() => null);
        const subStatus = (_5 = userSnap === null || userSnap === void 0 ? void 0 : userSnap.data()) === null || _5 === void 0 ? void 0 : _5.subscriptionStatus;
        if (subStatus === "past_due" || subStatus === "canceled" || subStatus === "unpaid") {
            await (0, client_1.sendMessage)(chatId, "Your Cara membership needs attention — there was an issue with your payment.\n\n" +
                "To keep your care coordination active, please update your billing at cara.app/billing or reply HELP to reach our support team.", { preferredService: "SMS" } // billing/legal notice — force SMS, never iMessage
            );
            return;
        }
    }
    // ── Twin-trigger cancel — user replied, cancel any pending proactive nudges ─
    (0, triggerEngine_1.cancelTriggerIfUserReplied)((_6 = session.userId) !== null && _6 !== void 0 ? _6 : phone, phone).catch(() => { });
    // ── Crisis detection — checked before everything else ──────────────────────
    // Keyword fast-path identifies POTENTIAL crisis (sub-millisecond). For real
    // hits we then run a 1.2s LLM verification to filter out quotes/jokes/
    // hypotheticals — fail-safe to crisis on timeout/error.
    // ── Crisis "NOTIFY" follow-up ───────────────────────────────────────────────
    // The medical-crisis message tells the family "reply NOTIFY" to alert the care
    // team. Catch that reply here (strict keyword protocol — allowed without an LLM)
    // before crisis re-detection, so it isn't routed to the generic QA agent.
    {
        const pendingNotify = session.pendingCrisisNotify;
        const normNotify = text.trim().toUpperCase();
        if (pendingNotify && (normNotify.includes("NOTIFY") || normNotify.includes("NOTIFICAR"))) {
            await handleCrisisNotify(phone, chatId, session, pendingNotify);
            return;
        }
    }
    // ── Caregiver "RENEW" — re-issue an expired/expiring background check link ───
    // The bg-check expiry nudge tells caregivers to "reply RENEW". Strict keyword
    // protocol (allowed without an LLM), gated to caregiver sessions.
    {
        const normRenew = text.trim().toUpperCase();
        if (session.userType === "caregiver" && (normRenew === "RENEW" || normRenew === "RENOVAR")) {
            const { sendBgCheckRenewalLink } = await Promise.resolve().then(() => __importStar(require("../agents/onboardingConversation")));
            await sendBgCheckRenewalLink(phone, chatId, session);
            return;
        }
    }
    const crisis = (0, crisisDetector_1.detectCrisis)(text);
    const sessionLang = (0, language_1.languageFromSession)(session);
    if (crisis === "medical") {
        if (await (0, crisisDetector_1.isLikelyRealCrisis)(text, "medical")) {
            await (0, client_1.sendMessage)(chatId, language_1.t.crisis_medical(sessionLang));
            (0, auditLog_1.logCrisisDetected)(phone, "medical", text).catch(() => { });
            // Arm the NOTIFY follow-up so the family's "NOTIFY" reply reaches the care team.
            await db.collection("agent_sessions").doc(phone).update({
                pendingCrisisNotify: { text: text.slice(0, 500), detectedAt: new Date().toISOString() },
            }).catch(() => { });
            return;
        }
        console.info("crisisDetector: medical keyword matched but LLM judged as non-crisis — proceeding normally", { phone });
    }
    if (crisis === "emotional") {
        if (await (0, crisisDetector_1.isLikelyRealCrisis)(text, "emotional")) {
            await (0, client_1.sendMessage)(chatId, language_1.t.crisis_emotional(sessionLang));
            (0, auditLog_1.logCrisisDetected)(phone, "emotional", text).catch(() => { });
            return;
        }
        console.info("crisisDetector: emotional keyword matched but LLM judged as non-crisis — proceeding normally", { phone });
    }
    // ── Persona-shift resolution ────────────────────────────────────────────────
    // If we previously asked "is this still about [seniorName]?", interpret
    // this inbound as the answer and either resume or block the original action.
    {
        const pending = session.pendingPersonaResolve;
        if (pending) {
            // Quick yes/no classify — was the user confirming the session person or not?
            let isSame = false;
            try {
                const verdict = await (0, openaiClient_1.quickComplete)(`Cara asked: "Is this still about ${(_7 = pending.seniorName) !== null && _7 !== void 0 ? _7 : "the person on file"}?" ` +
                    "Reply YES if the user confirms it is still about them. " +
                    "Reply NO if the user says it is a different person or family. " +
                    "Reply UNCLEAR if you cannot tell. Only reply one word.", text, { maxTokens: 5 });
                const v = verdict.trim().toUpperCase();
                isSame = v.startsWith("Y");
                if (v.startsWith("U")) {
                    await (0, client_1.sendMessage)(chatId, `Just to be sure — is this message about ${(_8 = pending.seniorName) !== null && _8 !== void 0 ? _8 : "the person on file"}? Reply YES or NO.`);
                    return;
                }
            }
            catch (_179) {
                await (0, client_1.sendMessage)(chatId, `Just to be sure — is this message about ${(_9 = pending.seniorName) !== null && _9 !== void 0 ? _9 : "the person on file"}? Reply YES or NO.`);
                return;
            }
            await db.collection("agent_sessions").doc(phone).update({
                pendingPersonaResolve: admin.firestore.FieldValue.delete(),
            }).catch(() => { });
            if (!isSame) {
                await (0, client_1.sendMessage)(chatId, `Got it — different person. I keep one care plan per phone number, so I can't mix them up.\n\n` +
                    `If you want a separate setup, the person you're asking about needs to text me from their own phone. ` +
                    `Or ask whoever set this up for ${(_10 = pending.seniorName) !== null && _10 !== void 0 ? _10 : "the person on file"} to add you as a family member, ` +
                    `which lets you get care updates without overwriting their plan.`);
                return;
            }
            // isSame === true → fall through and process the ORIGINAL text as if just received
            text = pending.originalText;
        }
    }
    // ── Persona shift detection — flag and pause when a different person seems to be texting ─
    // Only relevant for complete client sessions; onboarding flows already self-reset via START OVER.
    if (session.onboardingStep === "complete" && session.userType === "client") {
        const sessionSeniorName = (_12 = (_11 = session.onboardingData) === null || _11 === void 0 ? void 0 : _11.seniorName) !== null && _12 !== void 0 ? _12 : session.seniorName;
        const shift = await (0, personaShiftDetector_1.detectPersonaShift)({
            text,
            sessionSenior: sessionSeniorName,
            sessionRole: session.userType,
        }).catch(() => null);
        if (shift) {
            await db.collection("agent_sessions").doc(phone).update({
                pendingPersonaResolve: {
                    originalText: text,
                    seniorName: sessionSeniorName !== null && sessionSeniorName !== void 0 ? sessionSeniorName : "",
                    detectedAt: new Date().toISOString(),
                },
            }).catch(() => { });
            await (0, client_1.sendMessage)(chatId, sessionSeniorName
                ? `I see this phone is set up for ${sessionSeniorName}'s care plan, but your message sounds like it's about someone else. ` +
                    `Is this still about ${sessionSeniorName}? Reply YES to continue, or NO if it's a different family member.`
                : `Quick check — your message sounds like it might be about someone other than the person I have on file for this phone. ` +
                    `Is this for the same person? Reply YES or NO.`);
            return;
        }
    }
    // ── Bereavement detection — before intent classification ───────────────────
    if (await (0, bereavement_1.isBereavementTrigger)(text) && !session.bereavementMode) {
        const seniorName = (_13 = session.seniorName) !== null && _13 !== void 0 ? _13 : "your loved one";
        await (0, bereavement_1.activateBereavementMode)((_14 = session.userId) !== null && _14 !== void 0 ? _14 : phone, chatId, phone, seniorName);
        return;
    }
    // If already in bereavement mode — allow explicit exit or send gentle acknowledgment
    if (session.bereavementMode) {
        let isExit = false;
        try {
            const raw = await (0, openaiClient_1.quickComplete)("The user is in bereavement mode after losing a loved one. " +
                "Reply YES if they are clearly expressing that they are ready to resume normal service " +
                "(e.g. they need a caregiver, want to continue, are ready). " +
                "Reply NO if they are still grieving or just checking in. " +
                "Reply with only YES or NO.", text, { maxTokens: 5 });
            isExit = raw.trim().toUpperCase().startsWith("Y");
        }
        catch (_180) {
            isExit = false;
        }
        if (isExit) {
            await db.collection("agent_sessions").doc(phone).update({ bereavementMode: admin.firestore.FieldValue.delete() });
            const bereavementExitMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: "Family asked to exit bereavement support mode. Cara is gently transitioning back to normal and offering help.",
                fallback: "Of course. I'm here whenever you need me. What can I help you with?",
                maxTokens: 80,
            });
            await (0, client_1.sendMessage)(chatId, bereavementExitMsg);
        }
        else {
            // After 30 days, gently offer to resume — don't trap them forever
            const activatedAt = session.bereavementActivatedAt;
            const daysSince = activatedAt
                ? (Date.now() - new Date(activatedAt).getTime()) / (1000 * 60 * 60 * 24)
                : 0;
            if (daysSince > 30) {
                const bereavementCheckinMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "family",
                    context: "30-day bereavement check-in — Cara is gently reaching out to see if the family is ready to think about care again. Tone should be warm and not pushy.",
                    fallback: "I'm here with you. 💙 Whenever you're ready to arrange care again, just let me know.",
                    maxTokens: 80,
                });
                await (0, client_1.sendMessage)(chatId, bereavementCheckinMsg);
            }
            else {
                const bereavementSupportMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "family",
                    context: "Family is in bereavement mode and has messaged. Cara is being supportive and not rushing them.",
                    fallback: "I'm here with you. 💙 Take all the time you need.",
                    maxTokens: 60,
                });
                await (0, client_1.sendMessage)(chatId, bereavementSupportMsg);
            }
        }
        return;
    }
    // ── Zep lazy-init — backfill for users onboarded before Zep was added ──────
    if (!session.zepThreadId && session.onboardingStep === "complete") {
        (0, zepClient_1.initializeZepOnFirstContact)(phone).catch((err) => console.error("Zep lazy-init error:", err));
    }
    // ── ONBOARDING gate — route to state machine if not complete ─────────────
    // If the session exists but has no onboardingStep (e.g. created by an old
    // initiateCara that only stored chatId/userType), try to recover account data
    // from the users collection before routing. Without userId/seniorId the QA agent
    // will crash with an invalid Firestore path.
    // Recovers corrupted sessions: any missing userId triggers a users-collection
    // lookup. Previously only ran when step !== "complete" — but "complete with
    // no userId" is also corrupt (e.g. signup completed then user account write
    // failed) and was producing downstream crashes when qaAgent tried to load
    // senior context from an empty seniorId.
    if (!session.userId) {
        const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
        if (!userQuery.empty) {
            const userDoc = userQuery.docs[0];
            const userData = userDoc.data();
            const userId = userDoc.id;
            const seniorIds = (_15 = userData.seniorIds) !== null && _15 !== void 0 ? _15 : [];
            const seniorId = (_17 = (_16 = userData.seniorId) !== null && _16 !== void 0 ? _16 : seniorIds[0]) !== null && _17 !== void 0 ? _17 : "";
            await db.collection("agent_sessions").doc(phone).update({
                userId,
                seniorId,
                onboardingStep: "complete",
            });
            // Reload the session so downstream code sees the updated fields
            session.userId = userId;
            session.seniorId = seniorId;
            session.onboardingStep = "complete";
        }
        else if (!session.onboardingStep || session.onboardingStep !== "complete") {
            // No user account found and not complete — start onboarding from the beginning
            await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "ask_role" });
            session.onboardingStep = "ask_role";
        }
        else {
            // Complete but no user record and no users-collection match — session
            // is orphaned. Tell the user something went wrong and offer a restart
            // rather than crashing through qaAgent.
            await (0, client_1.sendMessage)(chatId, "Something's off with this account — I can't find your details. " +
                "Reply START OVER and I'll get you set up again.");
            console.error("handleInbound: complete session with no userId and no users record", { phone });
            return;
        }
    }
    // ── Profile completeness gate ────────────────────────────────────────────
    // Catches "phone is in the system but onboarding never completed" — sandbox→
    // live migrations and old-format stubs that carry a chatId but no real
    // account. Runs AFTER the recovery block above so that recoverable sessions
    // (no userId in the session, but a users-collection record exists) have
    // already been restored to ONBOARDED and are NOT mis-offered re-setup.
    // classifyCompleteness treats any session with a linked userId/caregiverId +
    // step "complete" as ONBOARDED regardless of onboardingData, so real clients
    // whose name lives in the users/seniors docs are never false-flagged.
    // Skipped entirely when the user is actively mid-onboarding.
    {
        const inOnboardingFlow = session.onboardingStep && session.onboardingStep !== "complete";
        if (!inOnboardingFlow && (0, profileCompleteness_1.classifyCompleteness)(session) === "PARTIAL") {
            const offerState = session.onboardingOfferState;
            if (offerState === "pending") {
                const reply = await (0, profileCompleteness_1.classifyOfferReply)(text);
                if (reply === "accept") {
                    await (0, profileCompleteness_1.markOfferAccepted)(phone);
                    await (0, client_1.sendMessage)(chatId, "Great — let's get you set up.\n\n" +
                        "Are you looking for care for a loved one, or are you a caregiver?\n\n" +
                        "1️⃣  I need care for someone\n" +
                        "2️⃣  I'm a caregiver looking for work");
                    return;
                }
                if (reply === "decline") {
                    await (0, profileCompleteness_1.markOfferDeclined)(phone);
                    await (0, client_1.sendMessage)(chatId, "No problem — we can do it whenever you're ready. What can I help with right now?");
                    return;
                }
                // QUESTION → fall through to QA (cross-entity context suppressed below),
                // leaving offerState=pending so the offer stays implicitly on the table.
                session.__unconfirmedIdentity = true;
            }
            else if (!offerState || (0, profileCompleteness_1.shouldReoffer)(session)) {
                await (0, profileCompleteness_1.sendOnboardingOffer)(phone, chatId, session);
                return;
            }
            else {
                // offerState === "declined" and not yet time to re-offer → answer freely
                // but with cross-entity context suppressed.
                session.__unconfirmedIdentity = true;
            }
        }
    }
    const step = (_18 = session.onboardingStep) !== null && _18 !== void 0 ? _18 : "";
    if (step && step !== "complete") {
        // Soft-resume ack — when a user comes back mid-onboarding after a notable
        // gap (>=10 min, but inside the 30-min state-expiry window), prepend a
        // one-liner so they know we picked up where they left off instead of
        // continuing mid-question as if nothing happened. Skipped for verify_phone
        // because the OTP context speaks for itself.
        const previousInboundAt = session.lastInboundAt;
        if (previousInboundAt && step !== "verify_phone") {
            const gapMs = Date.now() - new Date(previousInboundAt).getTime();
            if (gapMs >= 10 * 60 * 1000 && gapMs <= 30 * 60 * 1000) {
                const lang = (0, language_1.languageFromSession)(session);
                await (0, client_1.sendMessage)(chatId, language_1.t.welcome_back(lang));
            }
        }
        // Log every onboarding message to Zep — this is where names, conditions,
        // and care needs are shared, so Zep starts building the knowledge graph now
        const onboardingZepThreadId = session.zepThreadId;
        if (onboardingZepThreadId) {
            (0, zepClient_1.addUserMessageToZep)({
                threadId: onboardingZepThreadId,
                content: text,
                userName: (_20 = (_19 = session.onboardingData) === null || _19 === void 0 ? void 0 : _19.firstName) !== null && _20 !== void 0 ? _20 : "User",
                sentAt: new Date(),
            }).catch(console.error);
        }
        // Permissions steps
        if (step === "client_permissions_contact" || step === "client_permissions_booking" || step === "client_permissions_autobook") {
            const userId = (_21 = session.userId) !== null && _21 !== void 0 ? _21 : phone;
            await (0, permissionsConversation_1.handleClientPermissionsReply)(phone, chatId, text, session, userId);
            return;
        }
        if (step === "caregiver_permissions_decline" || step === "caregiver_permissions_arrival") {
            const caregiverId = (_22 = session.caregiverId) !== null && _22 !== void 0 ? _22 : phone;
            await (0, permissionsConversation_1.handleCaregiverPermissionsReply)(phone, chatId, text, session, caregiverId);
            return;
        }
        await (0, onboardingConversation_1.handleOnboardingStep)(phone, chatId, text, session);
        // After each onboarding step, push the progress event to Zep as structured JSON
        // so Zep's knowledge graph captures names, conditions, care needs as they're collected.
        if (onboardingZepThreadId) {
            const afterSnap = await db.collection("agent_sessions").doc(phone).get();
            const afterData = (_23 = afterSnap.data()) !== null && _23 !== void 0 ? _23 : {};
            const newStep = (_24 = afterData.onboardingStep) !== null && _24 !== void 0 ? _24 : step;
            const oData = (_25 = afterData.onboardingData) !== null && _25 !== void 0 ? _25 : {};
            (0, zepClient_1.addBusinessDataToZep)({
                userId: (0, zepClient_1.getZepUserId)(phone),
                data: {
                    event_type: "onboarding_step",
                    step_completed: step,
                    step_next: newStep,
                    user_type: (_26 = afterData.userType) !== null && _26 !== void 0 ? _26 : "unknown",
                    user_name: (_28 = (_27 = oData.firstName) !== null && _27 !== void 0 ? _27 : oData.name) !== null && _28 !== void 0 ? _28 : "",
                    senior_name: (_29 = oData.seniorName) !== null && _29 !== void 0 ? _29 : "",
                    senior_age: (_30 = oData.age) !== null && _30 !== void 0 ? _30 : null,
                    senior_conditions: (_31 = oData.conditions) !== null && _31 !== void 0 ? _31 : [],
                    senior_care_needs: (_32 = oData.careNeeds) !== null && _32 !== void 0 ? _32 : [],
                    senior_city: (_33 = oData.city) !== null && _33 !== void 0 ? _33 : "",
                    timestamp: new Date().toISOString(),
                },
            }).catch((err) => console.error("onboarding Zep push error:", err));
        }
        return;
    }
    // Rate limit — only triggers on actual abuse (120+ msgs/hr from one phone).
    // Drop silently instead of sending a "broken" reply to the user. Log so we
    // can see if a real user ever hits it.
    if (await isRateLimited(phone)) {
        console.warn("handleInbound: phone exceeded 120 msgs/hr rate limit — dropping silently", { phone });
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
            .where("feedbackReceived", "==", null)
            .orderBy("firedAt", "desc")
            .limit(1)
            .get();
        if (!pendingFeedback.empty) {
            const triggerDoc = pendingFeedback.docs[0];
            const meta = (_34 = triggerDoc.data().metadata) !== null && _34 !== void 0 ? _34 : {};
            await handleVisitFeedback({
                phone,
                chatId,
                text,
                caregiverId: (_35 = meta.caregiverId) !== null && _35 !== void 0 ? _35 : "",
                clientId: (_37 = (_36 = meta.clientId) !== null && _36 !== void 0 ? _36 : session.userId) !== null && _37 !== void 0 ? _37 : "",
                appointmentId: (_38 = meta.appointmentId) !== null && _38 !== void 0 ? _38 : "",
                triggerId: triggerDoc.id,
            });
            return;
        }
    }
    // ── Pending irreversible-action approval — runtime-enforced HITL gate ──────
    // When Cara proposed a high-risk action (cancel_appointment, cancel_subscription,
    // remove_family_member, etc.) on a prior turn, the MCP gate stored a
    // pending_action doc and Cara texted the family for confirmation. This block
    // intercepts the family's reply BEFORE intent classification so we catch
    // natural-language YES/NO ("yeah", "go ahead", "actually no") that the
    // generalist 50-intent classifier would misroute. See pendingActions.ts +
    // approvalHandler.ts for the full design.
    {
        const pending = await (0, pendingActions_1.getLatestPending)(phone).catch((err) => {
            console.error("handleInbound: getLatestPending failed", err);
            return null;
        });
        if (pending) {
            const result = await (0, approvalHandler_1.handlePendingApproval)({
                phone,
                chatId,
                text,
                userId: session.userId,
                userType: session.userType === "caregiver" ? "caregiver" : "client",
                pending,
            });
            if (result.outcome === "handled")
                return;
            // result.outcome === "fallthrough" — the family asked a question instead
            // of approving/declining. Let the normal flow run so Cara can answer it;
            // the pending action stays awaiting until they answer YES/NO or it expires.
        }
    }
    // ── Caregiver keyword handling ──────────────────────────────────────────────
    if (session.userType === "caregiver") {
        // ── Swap acceptance/decline — when another caregiver was asked to cover ──
        // Stale shift-swap requests (> 4h old) shouldn't hijack unrelated caregiver
        // messages weeks later. Clear the lingering field on stale state.
        if (session.pendingSwapRequestId) {
            const swapSetAt = session.pendingSwapSetAt;
            const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
            if (swapSetAt && swapSetAt < fourHoursAgo) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingSwapRequestId: admin.firestore.FieldValue.delete(),
                    pendingSwapFromName: admin.firestore.FieldValue.delete(),
                    pendingSwapSetAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
                session.pendingSwapRequestId = undefined;
            }
        }
        if (session.pendingSwapRequestId) {
            const swapRequestId = session.pendingSwapRequestId;
            const fromName = (_39 = session.pendingSwapFromName) !== null && _39 !== void 0 ? _39 : "A caregiver";
            const swapRaw = await (0, openaiClient_1.quickComplete)("The caregiver is responding to a shift-swap request. " +
                "Reply ACCEPT if they agree to cover the shift. " +
                "Reply DECLINE if they refuse. " +
                "Reply UNSURE if it is unclear. " +
                "Reply with exactly one word.", text, { maxTokens: 10 }).catch(() => "");
            const swapDecision = swapRaw.trim().toUpperCase();
            if (swapDecision === "ACCEPT") {
                const cgName = session.caregiverId
                    ? (_41 = (_40 = (await db.collection("caregivers").doc(session.caregiverId).get()).data()) === null || _40 === void 0 ? void 0 : _40.name) !== null && _41 !== void 0 ? _41 : "Caregiver"
                    : "Caregiver";
                await db.collection("agent_sessions").doc(phone).update({
                    pendingSwapRequestId: admin.firestore.FieldValue.delete(),
                    pendingSwapFromName: admin.firestore.FieldValue.delete(),
                });
                if (session.service === "iMessage")
                    await (0, client_1.startTyping)(chatId).catch(() => { });
                try {
                    await (0, caregiverSwapHandler_1.handleSwapAcceptance)((_42 = session.caregiverId) !== null && _42 !== void 0 ? _42 : phone, cgName, swapRequestId, chatId);
                }
                finally {
                    if (session.service === "iMessage")
                        await (0, client_1.stopTyping)(chatId).catch(() => { });
                }
                return;
            }
            if (swapDecision === "DECLINE") {
                await db.collection("shift_swap_requests").doc(swapRequestId).update({
                    candidateResponses: admin.firestore.FieldValue.arrayUnion({
                        caregiverId: (_43 = session.caregiverId) !== null && _43 !== void 0 ? _43 : phone,
                        response: "declined",
                        at: new Date().toISOString(),
                    }),
                }).catch(() => { });
                await db.collection("agent_sessions").doc(phone).update({
                    pendingSwapRequestId: admin.firestore.FieldValue.delete(),
                    pendingSwapFromName: admin.firestore.FieldValue.delete(),
                });
                const swapDeclineMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "caregiver",
                    context: `Caregiver declined a shift swap request from ${fromName}. Cara is acknowledging the decline and thanking them for letting the coordinator know.`,
                    fallback: `No problem — thanks for letting ${fromName}'s coordinator know!`,
                    maxTokens: 60,
                });
                await (0, client_1.sendMessage)(chatId, swapDeclineMsg);
                return;
            }
            // UNSURE — fall through to normal routing so Claude can answer the message
        }
        const KEYWORDS = {
            ARRIVED: () => handleArrived(phone, chatId, session),
            DONE: () => handleDone(phone, chatId, session, text),
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
                const rescheduleMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "caregiver",
                    context: "Caregiver wants to reschedule a visit. Cara is asking them to suggest 2–3 times that work and will relay them to the family.",
                    fallback: "No problem — text me 2–3 times that work for you and I'll let the family know right away.",
                    maxTokens: 80,
                });
                await (0, client_1.sendMessage)(chatId, rescheduleMsg);
            },
            PASS: async () => {
                var _a;
                await (0, interviewAgent_1.handleCaregiverAvailabilityReply)(phone, (_a = session.caregiverId) !== null && _a !== void 0 ? _a : "", "", chatId, "PASS");
            },
            PAYOUT: async () => {
                if (!session.caregiverId) {
                    await (0, client_1.sendMessage)(chatId, "I couldn't find your caregiver profile. Please contact support.");
                    return;
                }
                const { startInstantPayout } = await Promise.resolve().then(() => __importStar(require("../agents/instantPayoutHandler")));
                await startInstantPayout(session.caregiverId, phone, chatId);
            },
            REACTIVATE: async () => {
                if (!session.caregiverId)
                    return;
                await (0, caregiverProfileHandler_1.handleCaregiverProfileUpdate)(session.caregiverId, phone, text, session, chatId, "reactivate");
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
                        const jobConfirmMsg = await (0, caraMessage_1.generateCaraMessage)({
                            audience: "caregiver",
                            context: "Caregiver indicated availability for a job. Cara will confirm with the family and follow up shortly.",
                            fallback: "Got it — we'll confirm with the family and follow up shortly.",
                            maxTokens: 60,
                        });
                        await (0, client_1.sendMessage)(chatId, jobConfirmMsg);
                    }
                    else {
                        await candidateSnap.docs[0].ref.update({ status: "declined", respondedAt: new Date().toISOString() });
                        const jobDeclineMsg = await (0, caraMessage_1.generateCaraMessage)({
                            audience: "caregiver",
                            context: "Caregiver declined a job offer. Cara is acknowledging gracefully.",
                            fallback: "No worries — thanks for letting us know!",
                            maxTokens: 60,
                        });
                        await (0, client_1.sendMessage)(chatId, jobDeclineMsg);
                    }
                    return;
                }
            }
        }
        // Day-before shift confirmation reply
        if (session.pendingShiftConfirmation) {
            const scExpiry = session.stateExpiresAt;
            if (scExpiry && new Date(scExpiry) < new Date()) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingShiftConfirmation: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
                // fall through to normal routing
            }
            else {
                await handleShiftConfirmation(phone, chatId, text, session);
                return;
            }
        }
        // Day-before CLIENT shift confirmation reply (CONFIRM / CANCEL / question)
        if (session.pendingClientShiftConfirm) {
            const csExpiry = session.stateExpiresAt;
            if (csExpiry && new Date(csExpiry) < new Date()) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingClientShiftConfirm: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
                // fall through to normal routing
            }
            else {
                const { handleClientShiftConfirm } = await Promise.resolve().then(() => __importStar(require("../agents/clientShiftConfirmHandler")));
                await handleClientShiftConfirm(phone, chatId, text, session);
                return;
            }
        }
        // Awaiting task acknowledgment after a mid-shift nudge
        if (session.awaitingTaskAck) {
            const taskAckExpiry = session.stateExpiresAt;
            if (taskAckExpiry && new Date(taskAckExpiry) < new Date()) {
                await db.collection("agent_sessions").doc(phone).update({
                    awaitingTaskAck: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
            }
            else {
                await handleTaskAck(phone, chatId, text, session);
                return;
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
                    .where("caregiverId", "==", (_44 = session.caregiverId) !== null && _44 !== void 0 ? _44 : "")
                    .where("date", "==", today2).limit(1).get();
                const clientPhone = lateApptSnap.empty ? null : await getClientPhoneForAppt(lateApptSnap.docs[0].data());
                // Record lateness event
                if (!lateApptSnap.empty && session.caregiverId) {
                    const lateApptData = lateApptSnap.docs[0].data();
                    const minutesLateNum = parseInt(text.replace(/\D/g, ""), 10);
                    if (!isNaN(minutesLateNum) && minutesLateNum > 0) {
                        const cgSnap2 = await db.collection("caregivers").doc(session.caregiverId).get();
                        const cgName2 = (_46 = (_45 = cgSnap2.data()) === null || _45 === void 0 ? void 0 : _45.name) !== null && _46 !== void 0 ? _46 : "Unknown";
                        const { recordLatenessEvent, checkLatenessPattern } = await Promise.resolve().then(() => __importStar(require("../agents/latenessTracker")));
                        recordLatenessEvent({
                            caregiverId: session.caregiverId,
                            caregiverName: cgName2,
                            appointmentId: lateApptSnap.docs[0].id,
                            clientId: (_47 = lateApptData.clientId) !== null && _47 !== void 0 ? _47 : "",
                            date: today2,
                            scheduledTime: ((_48 = lateApptData.startTime) !== null && _48 !== void 0 ? _48 : "").slice(0, 5),
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
                    const cgName = (_50 = (_49 = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _49 === void 0 ? void 0 : _49.name) !== null && _50 !== void 0 ? _50 : "Your caregiver";
                    const origTime = lateApptSnap.empty ? "" : ` (originally ${lateApptSnap.docs[0].data().startTime})`;
                    await (0, dndGuard_1.sendIfNotDND)(clientPhone, {
                        content: `${cgName} is running about ${text} late. They're on their way${origTime}.`,
                        urgency: "immediate",
                        sourceAgent: "late_notification",
                        canDrop: false,
                    }, "high");
                }
                const driveMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "caregiver",
                    context: "Caregiver said how late they'll be and Cara has already notified the family. Send a brief acknowledgment and wish them a safe drive.",
                    fallback: "I've notified the family. Drive safe.",
                    maxTokens: 60,
                });
                await (0, client_1.sendMessage)(chatId, driveMsg);
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
                    .where("caregiverId", "==", (_51 = session.caregiverId) !== null && _51 !== void 0 ? _51 : "")
                    .where("date", "==", issueToday)
                    .where("status", "in", ["confirmed", "in-progress"])
                    .limit(1).get();
                const issueAppt = issueApptSnap.empty ? null : issueApptSnap.docs[0].data();
                const clientPhone = issueApptSnap.empty ? null : await getClientPhoneForAppt(issueAppt);
                const cgSnap = session.caregiverId
                    ? await db.collection("caregivers").doc(session.caregiverId).get()
                    : null;
                const cgName = (_53 = (_52 = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _52 === void 0 ? void 0 : _52.name) !== null && _53 !== void 0 ? _53 : "Your caregiver";
                const seniorId = (_55 = (_54 = issueAppt === null || issueAppt === void 0 ? void 0 : issueAppt.seniorId) !== null && _54 !== void 0 ? _54 : issueAppt === null || issueAppt === void 0 ? void 0 : issueAppt.clientId) !== null && _55 !== void 0 ? _55 : "";
                const seniorSnap = seniorId ? await db.collection("senior_profiles").doc(seniorId).get() : null;
                const seniorName = (_58 = (_57 = (_56 = seniorSnap === null || seniorSnap === void 0 ? void 0 : seniorSnap.data()) === null || _56 === void 0 ? void 0 : _56.name) !== null && _57 !== void 0 ? _57 : issueAppt === null || issueAppt === void 0 ? void 0 : issueAppt.clientName) !== null && _58 !== void 0 ? _58 : "your client";
                const { handleCaregiverIssue } = await Promise.resolve().then(() => __importStar(require("../agents/issueEscalator")));
                await handleCaregiverIssue({
                    caregiverId: (_59 = session.caregiverId) !== null && _59 !== void 0 ? _59 : phone,
                    caregiverPhone: phone,
                    caregiverName: cgName,
                    appointmentId: issueApptSnap.empty ? "" : issueApptSnap.docs[0].id,
                    clientId: (_60 = issueAppt === null || issueAppt === void 0 ? void 0 : issueAppt.clientId) !== null && _60 !== void 0 ? _60 : "",
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
                const issueFlaggedMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "caregiver",
                    context: "Caregiver reported an issue during a visit. Cara has escalated it to the team and notified the family. Thank them for letting Cara know.",
                    fallback: "I've flagged this for our team and notified the family. Thank you for letting me know.",
                    maxTokens: 80,
                });
                await (0, client_1.sendMessage)(chatId, issueFlaggedMsg);
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
                const issueResolvedMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "caregiver",
                    context: "Caregiver confirmed the issue from a prior visit is resolved. Cara is glad to hear it and wraps up the check-in.",
                    fallback: "Good to hear — glad everything's okay.",
                    maxTokens: 60,
                });
                await (0, client_1.sendMessage)(chatId, issueResolvedMsg);
            }
            else {
                const issueUpdateMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "caregiver",
                    context: "Caregiver gave an update on an ongoing issue rather than confirming it's resolved. Cara acknowledges the update and notes it.",
                    fallback: "Thanks for the update — I've noted it. Let me know if anything changes.",
                    maxTokens: 60,
                });
                await (0, client_1.sendMessage)(chatId, issueUpdateMsg);
            }
            return;
        }
        // ── Wellbeing check-in response: "4 3 5" style reply ──────────────────────
        // Only fires if the message is ONLY three numbers separated by whitespace
        // — otherwise "I'm 32, need help 3 mornings" used to hijack this handler.
        // Also gated to 7 days of staleness from when the check-in was sent.
        if (session.pendingWellbeingCheckin) {
            const sentAtIso = session.wellbeingCheckinSentAt;
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const isFresh = !sentAtIso || sentAtIso > sevenDaysAgo;
            const trimmed = text.trim();
            const isPureRatingReply = /^[1-5](?:\s+[1-5]){2}$/.test(trimmed);
            if (!isFresh) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingWellbeingCheckin: admin.firestore.FieldValue.delete(),
                    wellbeingCheckinSentAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
                session.pendingWellbeingCheckin = undefined;
            }
            else if (!isPureRatingReply) {
                // Don't hijack — message isn't a rating answer. Fall through.
            }
            else {
                const parts = trimmed.split(/\s+/).map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 5);
                if (parts.length === 3) {
                    const [energy, stress, satisfaction] = parts;
                    await db.collection("wellbeing_checkins").add({
                        caregiverId: (_62 = (_61 = session.caregiverId) !== null && _61 !== void 0 ? _61 : session.userId) !== null && _62 !== void 0 ? _62 : phone,
                        phone,
                        energy,
                        stress,
                        satisfaction,
                        recordedAt: new Date().toISOString(),
                    });
                    await db.collection("agent_sessions").doc(phone).update({
                        pendingWellbeingCheckin: admin.firestore.FieldValue.delete(),
                        wellbeingCheckinSentAt: admin.firestore.FieldValue.delete(),
                    });
                    const avg = (energy + stress + satisfaction) / 3;
                    const reply = avg < 3
                        ? `Thank you for being honest 💙 Your scores tell me you might need some support. Would you like to:\n\n1. Adjust your schedule\n2. Talk to our support team\n3. Get info on mental health resources\n\nReply 1, 2, or 3 — or just ignore this if you're okay.`
                        : `Checked in. Sounds like things are going well — your clients are in good hands.`;
                    await (0, client_1.sendMessage)(chatId, reply);
                    return;
                }
            }
        }
        // Caregiver rescheduling — parse new times and notify family
        if (session.caregiverRescheduling) {
            let timeList = [];
            try {
                const parsedRaw = await (0, openaiClient_1.quickComplete)("Extract interview time proposals from this message as a JSON array of human-readable strings. " +
                    "Reply with only a JSON array, e.g. [\"Tuesday 2pm\",\"Wednesday 10am\"]. Keep them short.", text, { maxTokens: 100 });
                timeList = JSON.parse(parsedRaw || "[]");
            }
            catch ( /* fall through — use raw text below */_181) { /* fall through — use raw text below */ }
            const timesText = timeList.length > 0 ? timeList.join(", ") : text;
            // Find the relevant interview request
            const caregiverId = (_63 = session.caregiverId) !== null && _63 !== void 0 ? _63 : "";
            const cgSnap = caregiverId ? await db.collection("caregivers").doc(caregiverId).get() : null;
            const cgName = (_65 = (_64 = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _64 === void 0 ? void 0 : _64.name) !== null && _65 !== void 0 ? _65 : "Your caregiver";
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
            await (0, interviewAgent_1.handleCaregiverAvailabilityReply)(phone, (_66 = session.caregiverId) !== null && _66 !== void 0 ? _66 : "", "", chatId, text);
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
        // ── Caregiver shift swap — multi-step state machine ───────────────────
        if (session.swapStep) {
            if (session.service === "iMessage")
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                const cgDoc = session.caregiverId
                    ? await db.collection("caregivers").doc(session.caregiverId).get()
                    : null;
                await (0, caregiverSwapHandler_1.handleCaregiverSwapRequest)((_67 = session.caregiverId) !== null && _67 !== void 0 ? _67 : phone, (_69 = (_68 = cgDoc === null || cgDoc === void 0 ? void 0 : cgDoc.data()) === null || _68 === void 0 ? void 0 : _68.name) !== null && _69 !== void 0 ? _69 : "Caregiver", phone, text, session, chatId);
            }
            finally {
                if (session.service === "iMessage")
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── Caregiver-initiated shift cancellation — multi-step state machine ─
        if (session.cancelStep) {
            const expiry = session.stateExpiresAt;
            if (expiry && new Date(expiry) < new Date()) {
                await db.collection("agent_sessions").doc(phone).update({
                    cancelStep: admin.firestore.FieldValue.delete(),
                    cancelCandidates: admin.firestore.FieldValue.delete(),
                    cancelShiftId: admin.firestore.FieldValue.delete(),
                    cancelShiftDate: admin.firestore.FieldValue.delete(),
                    cancelShiftClientId: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
            }
            else {
                if (session.service === "iMessage")
                    await (0, client_1.startTyping)(chatId).catch(() => { });
                try {
                    const cgDoc = session.caregiverId
                        ? await db.collection("caregivers").doc(session.caregiverId).get()
                        : null;
                    await (0, caregiverCancelShiftHandler_1.handleCaregiverCancelShift)((_70 = session.caregiverId) !== null && _70 !== void 0 ? _70 : phone, (_72 = (_71 = cgDoc === null || cgDoc === void 0 ? void 0 : cgDoc.data()) === null || _71 === void 0 ? void 0 : _71.name) !== null && _72 !== void 0 ? _72 : "Caregiver", phone, text, session, chatId);
                }
                finally {
                    if (session.service === "iMessage")
                        await (0, client_1.stopTyping)(chatId).catch(() => { });
                }
                return;
            }
        }
        // ── Profile update flow (rate / skills / bio / photo / pause / reactivate)
        if (session.profileUpdateStep) {
            const expiry = session.stateExpiresAt;
            if (expiry && new Date(expiry) < new Date()) {
                await db.collection("agent_sessions").doc(phone).update({
                    profileUpdateStep: admin.firestore.FieldValue.delete(),
                    profileUpdateField: admin.firestore.FieldValue.delete(),
                    profileUpdateValue: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
            }
            else if (session.caregiverId) {
                if (session.service === "iMessage")
                    await (0, client_1.startTyping)(chatId).catch(() => { });
                try {
                    await (0, caregiverProfileHandler_1.handleCaregiverProfileUpdate)(session.caregiverId, phone, text, session, chatId);
                }
                finally {
                    if (session.service === "iMessage")
                        await (0, client_1.stopTyping)(chatId).catch(() => { });
                }
                return;
            }
        }
        // ── PAYOUT instant-payout YES/NO confirmation ──────────────────────────
        if (session.pendingInstantPayoutConfirm) {
            const setAt = session.pendingInstantPayoutConfirm;
            const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            if (setAt < tenMinAgo) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingInstantPayoutConfirm: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
            }
            else {
                const { handleInstantPayoutConfirm } = await Promise.resolve().then(() => __importStar(require("../agents/instantPayoutHandler")));
                await handleInstantPayoutConfirm((_73 = session.caregiverId) !== null && _73 !== void 0 ? _73 : phone, phone, text, chatId);
                return;
            }
        }
        // ── Caregiver NLU fallback — handle natural-language keyword variants ──
        // Runs only when no exact keyword matched and no state machine is active.
        // Catches "I just arrived", "I'm done now", "running about 10 min late", etc.
        {
            const nluRaw = await (0, openaiClient_1.quickComplete)("Classify this caregiver message as one of: ARRIVED, DONE, LATE, ISSUE, CONFIRM, RESCHEDULE, NONE. " +
                "ARRIVED = caregiver arrived at or is entering a care visit. " +
                "DONE = caregiver has finished a care visit. " +
                "LATE = caregiver is running late to a visit. " +
                "ISSUE = caregiver is reporting a problem or concern during a visit. " +
                "CONFIRM = caregiver is confirming an upcoming appointment. " +
                "RESCHEDULE = caregiver wants to change the time of an appointment. " +
                "NONE = does not fit any of the above. " +
                "Reply with exactly one word.", text, { maxTokens: 15 }).catch(() => "");
            const nluAction = nluRaw.trim().toUpperCase();
            if (nluAction in KEYWORDS) {
                if (session.service === "iMessage")
                    await (0, client_1.startTyping)(chatId).catch(() => { });
                try {
                    await KEYWORDS[nluAction]();
                }
                finally {
                    if (session.service === "iMessage")
                        await (0, client_1.stopTyping)(chatId).catch(() => { });
                }
                return;
            }
        }
    }
    // ── Pre-shift family task check-in reply ────────────────────────────────────
    if (session.awaitingPreShiftUpdate) {
        const psExpiry = session.stateExpiresAt;
        if (psExpiry && new Date(psExpiry) < new Date()) {
            await db.collection("agent_sessions").doc(phone).update({
                awaitingPreShiftUpdate: admin.firestore.FieldValue.delete(),
                stateExpiresAt: admin.firestore.FieldValue.delete(),
            }).catch(() => { });
        }
        else {
            await handlePreShiftUpdate(phone, chatId, text, session);
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
        const seniorId = (_75 = (_74 = session.seniorId) !== null && _74 !== void 0 ? _74 : session.userId) !== null && _75 !== void 0 ? _75 : "";
        if (ecPhone && seniorId) {
            await db.collection("senior_profiles").doc(seniorId).set({ emergencyContact: { phone: ecPhone, name: ecName || "Emergency Contact" } }, { merge: true });
            await (0, client_1.sendMessage)(chatId, `Got it — I've saved ${ecName || "your emergency contact"} (${ecPhone}) for ${(_77 = (_76 = session.onboardingData) === null || _76 === void 0 ? void 0 : _76.seniorName) !== null && _77 !== void 0 ? _77 : "your family member"}. They'll be contacted if there's ever an urgent issue.`);
        }
        else {
            await (0, client_1.sendMessage)(chatId, "I wasn't able to find a phone number in that message. Please reply with your emergency contact's name and phone number (e.g. 'John Smith 555-000-1234').");
            await db.collection("agent_sessions").doc(phone).update({ awaitingEmergencyContactUpdate: true });
        }
        return;
    }
    // ── Shift hours APPROVE / DISPUTE (client iMessage reply) ───────────────────
    // Clear stale pending approvals (>72h old) so APPROVE/DISPUTE replies don't
    // hit a long-resolved shift.
    if (session.pendingShiftApproval) {
        const setAt = session.pendingShiftApprovalSetAt;
        const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
        if (setAt && setAt < seventyTwoHoursAgo) {
            await db.collection("agent_sessions").doc(phone).update({
                pendingShiftApproval: admin.firestore.FieldValue.delete(),
                pendingShiftApprovalSetAt: admin.firestore.FieldValue.delete(),
            }).catch(() => { });
            session.pendingShiftApproval = undefined;
        }
    }
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
            userId: (_78 = session.userId) !== null && _78 !== void 0 ? _78 : "",
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
    // ── Healthcare agentic flow — provider search, appt booking, Rx refill ────
    if (session.healthcareFlowStep && session.userType !== "caregiver") {
        if (session.service === "iMessage" && !session.groupChatId)
            await (0, client_1.startTyping)(chatId).catch(() => { });
        try {
            const { resumeHealthcareFlow } = await Promise.resolve().then(() => __importStar(require("../agents/healthcareHandler")));
            await resumeHealthcareFlow(phone, chatId, text, session, (msg) => (0, client_1.sendMessage)(chatId, msg));
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
            const refundClientId = ((_79 = session.userId) !== null && _79 !== void 0 ? _79 : phone);
            await (0, refundHandler_1.handleRefundRequest)(refundClientId, text, session, (msg) => (0, client_1.sendMessage)(chatId, msg));
        }
        finally {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.stopTyping)(chatId).catch(() => { });
        }
        return;
    }
    // ── Timesheet approval flow (multi-step state machine) ───────────────────
    // Drop stale timesheet state (>7 days) so old APPROVE/DISPUTE prompts don't
    // hijack unrelated future replies.
    if (session.timesheetStep) {
        const setAt = session.pendingTimesheetSetAt;
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        if (setAt && setAt < sevenDaysAgo) {
            await db.collection("agent_sessions").doc(phone).update({
                timesheetStep: admin.firestore.FieldValue.delete(),
                pendingTimesheetId: admin.firestore.FieldValue.delete(),
                pendingTimesheetDesc: admin.firestore.FieldValue.delete(),
                pendingTimesheetQueue: admin.firestore.FieldValue.delete(),
                pendingTimesheetSetAt: admin.firestore.FieldValue.delete(),
            }).catch(() => { });
            session.timesheetStep = undefined;
        }
    }
    if (session.timesheetStep) {
        if (session.service === "iMessage" && !session.groupChatId)
            await (0, client_1.startTyping)(chatId).catch(() => { });
        try {
            await (0, timesheetHandler_1.handleTimesheetApproval)(((_80 = session.userId) !== null && _80 !== void 0 ? _80 : phone), phone, text, session, (msg) => (0, client_1.sendMessage)(chatId, msg));
        }
        finally {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.stopTyping)(chatId).catch(() => { });
        }
        return;
    }
    // ── Availability update flow (multi-step state machine) ──────────────────
    if (session.availabilityStep) {
        if (session.service === "iMessage" && !session.groupChatId)
            await (0, client_1.startTyping)(chatId).catch(() => { });
        try {
            await (0, availabilityHandler_1.handleAvailabilityUpdate)(((_82 = (_81 = session.caregiverId) !== null && _81 !== void 0 ? _81 : session.userId) !== null && _82 !== void 0 ? _82 : phone), phone, text, session, (msg) => (0, client_1.sendMessage)(chatId, msg));
        }
        finally {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.stopTyping)(chatId).catch(() => { });
        }
        return;
    }
    // ── Client caregiver swap flow — multi-step state machine ───────────────
    if (session.clientSwapStep) {
        if (session.service === "iMessage" && !session.groupChatId)
            await (0, client_1.startTyping)(chatId).catch(() => { });
        try {
            await (0, clientSwapRequestHandler_1.handleClientSwapRequest)((_83 = session.userId) !== null && _83 !== void 0 ? _83 : phone, phone, text, session, chatId);
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
        const sd = (_84 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _84 !== void 0 ? _84 : {};
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
            // Interview and cancel confirm are time-sensitive — check before recurring to avoid stale flag collision
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
                    const cgPhone = (_85 = cgSnap.data()) === null || _85 === void 0 ? void 0 : _85.phone;
                    if (cgPhone) {
                        const cgSess = await (await Promise.resolve().then(() => __importStar(require("./client")))).getOrCreateSession(cgPhone);
                        const cancelNotifMsgA = await (0, caraMessage_1.generateCaraMessage)({
                            audience: "caregiver",
                            context: `The family has cancelled the visit on ${appt.date}. Notify the caregiver and apologize for the inconvenience.`,
                            fallback: `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`,
                            maxTokens: 80,
                        });
                        await (0, client_1.sendMessage)(cgSess.chatId, cancelNotifMsgA);
                    }
                }
                await db.collection("agent_sessions").doc(phone).update({ pendingCancelConfirm: admin.firestore.FieldValue.delete() });
                const cancelConfirmMsgA = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "family",
                    context: "Visit has been cancelled. Cara is confirming and offering to find a replacement for that day.",
                    fallback: "Cancelled. Want me to find a replacement for that day?",
                    maxTokens: 60,
                });
                await (0, client_1.sendMessage)(chatId, cancelConfirmMsgA);
                return;
            }
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
                    const sd = (_86 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _86 !== void 0 ? _86 : {};
                    const { runMatchingForClient: rmfc } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
                    await rmfc(phone, chatId, sd, sd).catch(() => { });
                }
                return;
            }
        }
        // ── BOOKING_DECLINE — natural language NO ("never mind", "don't book", etc.) ──
        if (intent === "BOOKING_DECLINE") {
            // Interview and cancel confirms are time-sensitive — check before recurring to avoid stale flag collision
            if (session.pendingInterviewConfirm) {
                const pending = session.pendingInterviewConfirm;
                await db.collection("agent_sessions").doc(phone).update({ pendingInterviewConfirm: admin.firestore.FieldValue.delete() });
                const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
                const availability = ((_88 = (_87 = reqSnap.data()) === null || _87 === void 0 ? void 0 : _87.caregiverAvailability) !== null && _88 !== void 0 ? _88 : []);
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
                    // No more times — mark request client_declined
                    await db.collection("interview_requests").doc(pending.docId).update({ status: "client_declined", clientDeclinedAt: new Date().toISOString() }).catch(() => { });
                    // Notify the caregiver so they aren't left waiting
                    const _bdReqSnap = await db.collection("interview_requests").doc(pending.docId).get().catch(() => null);
                    const _bdCgId = (_89 = _bdReqSnap === null || _bdReqSnap === void 0 ? void 0 : _bdReqSnap.data()) === null || _89 === void 0 ? void 0 : _89.caregiverId;
                    if (_bdCgId) {
                        const _bdCgSnap = await db.collection("caregivers").doc(_bdCgId).get().catch(() => null);
                        const _bdCgPhone = (_90 = _bdCgSnap === null || _bdCgSnap === void 0 ? void 0 : _bdCgSnap.data()) === null || _90 === void 0 ? void 0 : _90.phone;
                        if (_bdCgPhone) {
                            const _bdCgSess = await (await Promise.resolve().then(() => __importStar(require("./client")))).getOrCreateSession(_bdCgPhone);
                            await (0, client_1.sendMessage)(_bdCgSess.chatId, `Hi ${pending.caregiverName}, the family was not able to find a time that works right now. ` +
                                `Thank you for your interest — I'll be in touch when there's a new opening that fits.`).catch(() => { });
                        }
                    }
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
        }
        // ── HIRE_CAREGIVER — "let's go with Maria", "hire James" ─────────────────
        if (intent === "HIRE_CAREGIVER") {
            const pending = session.pendingInterviewOutcome;
            if (pending) {
                let caregiverId = (_91 = pending.caregiverId) !== null && _91 !== void 0 ? _91 : "";
                if (!caregiverId && pending.interviewId) {
                    const reqSnap = await db.collection("interview_requests")
                        .where("interviewId", "==", pending.interviewId).limit(1).get();
                    if (!reqSnap.empty)
                        caregiverId = (_92 = reqSnap.docs[0].data().caregiverId) !== null && _92 !== void 0 ? _92 : "";
                }
                await db.collection("agent_sessions").doc(phone).update({
                    hireMode: { caregiverName: pending.caregiverName, caregiverId },
                    pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });
                if (caregiverId)
                    (0, interviewAgent_1.writeInterviewOutcomeSignal)((_93 = session.userId) !== null && _93 !== void 0 ? _93 : phone, caregiverId, "hire").catch(() => { });
                const hireMsgA = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "family",
                    context: `Family wants to hire caregiver ${pending.caregiverName}. Cara is affirming the choice and asking when they'd like care to start.`,
                    fallback: `${pending.caregiverName} sounds like a great fit. When would you like care to start?`,
                    maxTokens: 80,
                });
                await (0, client_1.sendMessage)(chatId, hireMsgA);
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
                const noJobMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "caregiver",
                    context: "Caregiver responded to a job offer but there was no pending job in session. Cara acknowledges and lets them know it will reach out when something comes up.",
                    fallback: "No worries — I'll reach out when something comes up.",
                    maxTokens: 60,
                });
                await (0, client_1.sendMessage)(chatId, noJobMsg);
            }
            return;
        }
        // ── YES — booking, recurring setup, or interview confirmation ───────────────
        if (norm === "YES" || norm === "Y") {
            // Interview and cancel confirm are time-sensitive — check before recurring to avoid stale flag collision
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
                    const cgPhone = (_94 = cgSnap.data()) === null || _94 === void 0 ? void 0 : _94.phone;
                    if (cgPhone) {
                        const cgSess = await (await Promise.resolve().then(() => __importStar(require("./client")))).getOrCreateSession(cgPhone);
                        const cancelNotifMsgB = await (0, caraMessage_1.generateCaraMessage)({
                            audience: "caregiver",
                            context: `The family has cancelled the visit on ${appt.date}. Notify the caregiver and apologize for the inconvenience.`,
                            fallback: `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`,
                            maxTokens: 80,
                        });
                        await (0, client_1.sendMessage)(cgSess.chatId, cancelNotifMsgB);
                    }
                }
                await db.collection("agent_sessions").doc(phone).update({
                    pendingCancelConfirm: admin.firestore.FieldValue.delete(),
                });
                const cancelConfirmMsgB = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "family",
                    context: "Visit has been cancelled. Cara is confirming and offering to find a replacement for that day.",
                    fallback: "Cancelled. Want me to find a replacement for that day?",
                    maxTokens: 60,
                });
                await (0, client_1.sendMessage)(chatId, cancelConfirmMsgB);
                return;
            }
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
                    const sd = (_95 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _95 !== void 0 ? _95 : {};
                    const { runMatchingForClient: rmfc4 } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
                    await rmfc4(phone, chatId, sd, sd).catch(() => { });
                }
                return;
            }
        }
        // ── NO — recurring setup declined, booking declined, or interview time rejected ──
        if (norm === "NO" || norm === "N") {
            // Interview and cancel confirms are time-sensitive — check before recurring to avoid stale flag collision
            if (session.pendingInterviewConfirm) {
                const pending = session.pendingInterviewConfirm;
                await db.collection("agent_sessions").doc(phone).update({
                    pendingInterviewConfirm: admin.firestore.FieldValue.delete(),
                });
                // Check if caregiver offered more times
                const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
                const availability = ((_97 = (_96 = reqSnap.data()) === null || _96 === void 0 ? void 0 : _96.caregiverAvailability) !== null && _97 !== void 0 ? _97 : []);
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
        }
        // ── CONFIRM / SKIP — finalizes a pending task selection made by 1/2/3 ──────
        // Drop stale pendingTaskConfirm (>1h old) so an old caregiver-selection
        // doesn't get finalized weeks later by an unrelated CONFIRM/SKIP keyword.
        if (session.pendingTaskConfirm) {
            const setAt = session.pendingTaskConfirmSetAt;
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            if (setAt && setAt < oneHourAgo) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingTaskConfirm: admin.firestore.FieldValue.delete(),
                    pendingTaskConfirmSetAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
                session.pendingTaskConfirm = undefined;
            }
        }
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
                const classRaw = await (0, openaiClient_1.quickComplete)("The user just interviewed a caregiver and is sharing their thoughts. " +
                    "Classify as HIRE (positive, wants to proceed), MAYBE (uncertain, not sure), " +
                    "or PASS (negative, concerns, didn't click). Reply with one word only.", text, { maxTokens: 10 });
                const classified = classRaw.trim().toUpperCase();
                if (classified === "HIRE" || classified === "MAYBE" || classified === "PASS") {
                    // Re-enter with classified keyword — will be picked up by the checks below
                    text; // text is const; shadow norm instead
                    Object.assign(session, {}); // keep session reference
                    // Override norm for the blocks below
                    const resolvedNorm = classified;
                    if (resolvedNorm === "HIRE") {
                        let caregiverId = (_98 = pendingOutcome.caregiverId) !== null && _98 !== void 0 ? _98 : "";
                        if (!caregiverId && pendingOutcome.interviewId) {
                            const reqSnap = await db.collection("interview_requests")
                                .doc(pendingOutcome.interviewId).get();
                            if (reqSnap.exists)
                                caregiverId = (_100 = (_99 = reqSnap.data()) === null || _99 === void 0 ? void 0 : _99.caregiverId) !== null && _100 !== void 0 ? _100 : "";
                        }
                        await db.collection("agent_sessions").doc(phone).update({
                            hireMode: { caregiverName: pendingOutcome.caregiverName, caregiverId },
                            pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                        });
                        if (caregiverId) {
                            (0, interviewAgent_1.writeInterviewOutcomeSignal)((_101 = session.userId) !== null && _101 !== void 0 ? _101 : phone, caregiverId, "hire").catch(() => { });
                        }
                        const hireMsgB = await (0, caraMessage_1.generateCaraMessage)({
                            audience: "family",
                            context: `Family wants to hire caregiver ${pendingOutcome.caregiverName}. Cara is affirming the choice and asking when they'd like care to start.`,
                            fallback: `${pendingOutcome.caregiverName} sounds like a great fit. When would you like care to start?`,
                            maxTokens: 80,
                        });
                        await (0, client_1.sendMessage)(chatId, hireMsgB);
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
                            (0, interviewAgent_1.writeInterviewOutcomeSignal)((_102 = session.userId) !== null && _102 !== void 0 ? _102 : phone, pendingOutcome.caregiverId, "pass").catch(() => { });
                            // Notify caregiver of the outcome
                            db.collection("caregivers").doc(pendingOutcome.caregiverId).get().then(async (cgSnap) => {
                                var _a, _b, _c;
                                const cgPhone = (_a = cgSnap.data()) === null || _a === void 0 ? void 0 : _a.phone;
                                const cgName = (_c = (_b = cgSnap.data()) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : "Caregiver";
                                if (!cgPhone)
                                    return;
                                const cgSess = await (await Promise.resolve().then(() => __importStar(require("./client")))).getOrCreateSession(cgPhone);
                                await (0, client_1.sendMessage)(cgSess.chatId, `Hi ${cgName}, the family has decided not to move forward at this time. ` +
                                    `Thank you for interviewing — I'll reach out when there's a new opportunity that's a great fit.`);
                            }).catch(() => { });
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
                let caregiverId = (_103 = pending.caregiverId) !== null && _103 !== void 0 ? _103 : "";
                if (!caregiverId && pending.interviewId) {
                    const reqSnap = await db.collection("interview_requests")
                        .where("interviewId", "==", pending.interviewId)
                        .limit(1).get();
                    if (!reqSnap.empty)
                        caregiverId = (_104 = reqSnap.docs[0].data().caregiverId) !== null && _104 !== void 0 ? _104 : "";
                }
                await db.collection("agent_sessions").doc(phone).update({
                    hireMode: { caregiverName: pending.caregiverName, caregiverId },
                    pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                    stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });
                if (caregiverId) {
                    (0, interviewAgent_1.writeInterviewOutcomeSignal)((_105 = session.userId) !== null && _105 !== void 0 ? _105 : phone, caregiverId, "hire").catch(() => { });
                }
                const hireMsgC = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "family",
                    context: `Family wants to hire caregiver ${pending.caregiverName}. Cara is affirming the choice and asking when they'd like care to start.`,
                    fallback: `${pending.caregiverName} sounds like a great fit. When would you like care to start?`,
                    maxTokens: 80,
                });
                await (0, client_1.sendMessage)(chatId, hireMsgC);
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
                        (0, interviewAgent_1.writeInterviewOutcomeSignal)((_106 = session.userId) !== null && _106 !== void 0 ? _106 : phone, pending.caregiverId, "pass").catch(() => { });
                        // Notify caregiver of the outcome so they aren't left waiting
                        db.collection("caregivers").doc(pending.caregiverId).get().then(async (cgSnap) => {
                            var _a, _b, _c;
                            const cgPhone = (_a = cgSnap.data()) === null || _a === void 0 ? void 0 : _a.phone;
                            const cgName = (_c = (_b = cgSnap.data()) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : "Caregiver";
                            if (!cgPhone)
                                return;
                            const cgSess = await (await Promise.resolve().then(() => __importStar(require("./client")))).getOrCreateSession(cgPhone);
                            await (0, client_1.sendMessage)(cgSess.chatId, `Hi ${cgName}, the family has decided not to move forward at this time. ` +
                                `Thank you for interviewing — I'll reach out when there's a new opportunity that's a great fit.`);
                        }).catch(() => { });
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
        // Only fire when ALL of:
        //   - pendingMatches is non-empty
        //   - pendingMatches was set within the last 2 hours (older state is stale)
        //   - text is JUST a selection answer ("1", "2", "1 and 2", "all", "1,3"),
        //     not a sentence that happens to contain a digit ("3 mornings a week"
        //     used to trip the old loose /[123]/ regex)
        // Anything else falls through to the normal intent routing. If the user
        // explicitly says "find a caregiver" while pendingMatches is stale, we
        // clear it below so they get a fresh search instead of being asked to
        // pick from a list they never saw.
        const stalePendingMatches = session.pendingMatches;
        if (stalePendingMatches && stalePendingMatches.length > 0) {
            const setAt = session.pendingMatchesSetAt;
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
            const isFresh = !setAt || setAt > twoHoursAgo;
            const trimmedNorm = norm.replace(/[.!?]+$/, "").trim();
            const isPureSelectionAnswer = /^(?:all|none|skip|pass|[1-9](?:\s*(?:,|and|&|\s)\s*[1-9])*)$/i.test(trimmedNorm);
            if (isFresh && isPureSelectionAnswer) {
                await (0, interviewAgent_1.handleInterviewSelection)(phone, chatId, text, session);
                return;
            }
            // ── Mid-match refilter ─────────────────────────────────────────────
            // "show me cheaper ones", "any with dementia experience", "anyone Saturday?"
            // — detect criterion changes and re-run matching with the new filters.
            if (isFresh) {
                const { detectMatchRefilter } = await Promise.resolve().then(() => __importStar(require("../utils/matchRefilterDetector")));
                const refilter = await detectMatchRefilter(text).catch(() => null);
                if (refilter) {
                    const baseIntake = ((_107 = session.onboardingData) !== null && _107 !== void 0 ? _107 : {});
                    const mergedIntake = Object.assign({}, baseIntake);
                    // Merge refilter overrides into intake
                    if ((_108 = refilter.skills) === null || _108 === void 0 ? void 0 : _108.length) {
                        const existing = (_109 = baseIntake.careNeeds) !== null && _109 !== void 0 ? _109 : [];
                        mergedIntake.careNeeds = Array.from(new Set([...existing, ...refilter.skills]));
                    }
                    if ((_110 = refilter.languages) === null || _110 === void 0 ? void 0 : _110.length) {
                        mergedIntake.languagePreference = refilter.languages[0];
                    }
                    if (refilter.genderPreference) {
                        mergedIntake.genderPreference = refilter.genderPreference;
                    }
                    if (refilter.rate) {
                        mergedIntake.rateDirection = refilter.rate.direction;
                    }
                    if (refilter.availability) {
                        mergedIntake.availabilityOverride = refilter.availability;
                    }
                    if (refilter.distance) {
                        mergedIntake.distanceDirection = refilter.distance.direction;
                    }
                    if ((_111 = refilter.experienceYears) === null || _111 === void 0 ? void 0 : _111.min) {
                        mergedIntake.minExperienceYears = refilter.experienceYears.min;
                    }
                    await db.collection("agent_sessions").doc(phone).update({
                        pendingMatches: admin.firestore.FieldValue.delete(),
                        pendingMatchesSetAt: admin.firestore.FieldValue.delete(),
                        lastRefilterSummary: refilter.summary,
                    }).catch(() => { });
                    await (0, client_1.sendMessage)(chatId, `Searching for ${refilter.summary} — coming up.`);
                    // Fire matching with merged intake; runs async with its own send.
                    const { runMatchingForClient } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
                    await runMatchingForClient(phone, chatId, mergedIntake, session);
                    return;
                }
            }
            // User isn't picking from the list — if their intent is to start a new
            // search (FIND_CAREGIVER, REBOOK_REQUEST) or the list is stale, clear
            // the lingering state so it doesn't keep hijacking unrelated messages.
            const isFreshSearchIntent = intent === "FIND_CAREGIVER" || intent === "REBOOK_REQUEST" || intent === "POST_JOB";
            if (!isFresh || isFreshSearchIntent) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingMatches: admin.firestore.FieldValue.delete(),
                    pendingMatchesSetAt: admin.firestore.FieldValue.delete(),
                }).catch(() => { });
                session.pendingMatches = undefined;
            }
            // Otherwise fall through to normal intent routing.
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
            const userId = (_113 = (_112 = session.userId) !== null && _112 !== void 0 ? _112 : session.caregiverId) !== null && _113 !== void 0 ? _113 : phone;
            const userType = (_114 = session.userType) !== null && _114 !== void 0 ? _114 : "client";
            await (0, permissionsConversation_1.updatePermissionFromText)(userId, userType, phone, chatId, text);
            return;
        }
        if (intent === "MEMORY_QUERY") {
            const zepUserId = (0, zepClient_1.getZepUserId)(phone);
            const zepFacts = await (0, zepClient_1.searchZepMemory)(zepUserId, text).catch(() => "");
            const memUserId = (_116 = (_115 = session.userId) !== null && _115 !== void 0 ? _115 : session.caregiverId) !== null && _116 !== void 0 ? _116 : phone;
            const { handleMemoryQuery } = await Promise.resolve().then(() => __importStar(require("../memory/memoryFiles")));
            await handleMemoryQuery(memUserId, chatId, client_1.sendMessage, zepFacts || undefined);
            return;
        }
        if (intent === "ADD_FAMILY_MEMBER") {
            const extractionRaw = await (0, openaiClient_1.quickComplete)("Extract the name and phone number from this message. Reply with JSON only: {\"name\": \"...\", \"phone\": \"+1...\"}. If no phone found, phone = null.", text, { maxTokens: 80 }).catch(() => "{}");
            let memberName = null;
            let memberPhone = null;
            try {
                const parsed = JSON.parse(extractionRaw || "{}");
                memberName = (_117 = parsed.name) !== null && _117 !== void 0 ? _117 : null;
                memberPhone = (_118 = parsed.phone) !== null && _118 !== void 0 ? _118 : null;
            }
            catch ( /* */_182) { /* */ }
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
                userId: (_119 = session.userId) !== null && _119 !== void 0 ? _119 : phone,
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
            const extractionRaw = await (0, openaiClient_1.quickComplete)("Extract the name and/or phone number of the person to remove from this message. Reply with JSON only: {\"name\": \"...\", \"phone\": \"+1...\"}. If no phone found, phone = null.", text, { maxTokens: 80 }).catch(() => "{}");
            let targetName = null;
            let targetPhone = null;
            try {
                const parsed = JSON.parse(extractionRaw || "{}");
                targetName = (_120 = parsed.name) !== null && _120 !== void 0 ? _120 : null;
                targetPhone = (_121 = parsed.phone) !== null && _121 !== void 0 ? _121 : null;
            }
            catch ( /* */_183) { /* */ }
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
            const seniorId = (_123 = (_122 = session.seniorId) !== null && _122 !== void 0 ? _122 : session.userId) !== null && _123 !== void 0 ? _123 : phone;
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
            const parsedScheduleRaw = await (0, openaiClient_1.quickComplete)("Extract a weekly care schedule from this message. " +
                "Reply with only a JSON object: { \"days\": [\"Monday\",\"Wednesday\",\"Friday\"], " +
                "\"startTime\": \"9:00 AM\", \"endTime\": \"1:00 PM\", \"durationHours\": 4 }. " +
                "days must be full day names. durationHours is a number.", text, { maxTokens: 120 }).catch(() => "null");
            let schedule = null;
            try {
                schedule = JSON.parse(parsedScheduleRaw || "null");
            }
            catch ( /* */_184) { /* */ }
            if (!schedule || !((_124 = schedule.days) === null || _124 === void 0 ? void 0 : _124.length)) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch that — could you try again? (e.g. '3 days, Mon/Wed/Fri, 9am–1pm')");
                return;
            }
            // Fetch actual hourly rate from caregiver doc
            const cgDoc = await db.collection("caregivers").doc(hire.caregiverId).get();
            const hourlyRate = ((_126 = (_125 = cgDoc.data()) === null || _125 === void 0 ? void 0 : _125.hourlyRate) !== null && _126 !== void 0 ? _126 : 20);
            // Build one appointment per day starting from the hire date's week
            const startDate = new Date(dateStr + "T12:00:00Z");
            const dayIndexMap = {
                Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
            };
            const appointments = [];
            for (const day of schedule.days) {
                const target = (_127 = dayIndexMap[day]) !== null && _127 !== void 0 ? _127 : -1;
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
            const clientId = (_128 = session.userId) !== null && _128 !== void 0 ? _128 : phone;
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
            const perms = await (0, permissionsConversation_1.getPermissions)((_129 = session.userId) !== null && _129 !== void 0 ? _129 : phone).catch(() => null);
            if (perms === null || perms === void 0 ? void 0 : perms.canBookAutomatically) {
                try {
                    await (0, bookingExecutor_1.executeBookings)(taskId, phone);
                }
                catch (err) {
                    console.error("executeBookings failed (hireMode):", err);
                    await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
                    await (0, client_1.sendMessage)(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
                    const sd = (_130 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _130 !== void 0 ? _130 : {};
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
            const parsedDateRaw = await (0, openaiClient_1.quickComplete)(`Today is ${new Date().toISOString().slice(0, 10)}. ` +
                "The user is choosing a start date for care. Reply with only a YYYY-MM-DD date string, nothing else.", text, { maxTokens: 20 }).catch(() => "");
            const dateStr = parsedDateRaw.trim();
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
            const availability = ((_132 = (_131 = reqSnap.data()) === null || _131 === void 0 ? void 0 : _131.caregiverAvailability) !== null && _132 !== void 0 ? _132 : []);
            const parsedChosen = await (0, openaiClient_1.quickComplete)(`Available times: ${availability.join(", ")}. ` +
                "The user picked one of these times. Reply with only the exact string from the list that best matches their reply, or 'NONE' if no match.", text, { maxTokens: 60 }).catch(() => "");
            const chosen = parsedChosen.trim();
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
            const clientId = (_133 = session.userId) !== null && _133 !== void 0 ? _133 : phone;
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
            const parsedDateRaw = await (0, openaiClient_1.quickComplete)(`Today is ${new Date().toISOString().slice(0, 10)}. ` +
                "The user is choosing a date for a care visit. Reply with only a YYYY-MM-DD date string, nothing else.", text, { maxTokens: 20 }).catch(() => "");
            const dateStr = parsedDateRaw.trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch that date — could you try again? (e.g. \"May 19\" or \"next Monday\")");
                return;
            }
            const clientId = (_134 = session.userId) !== null && _134 !== void 0 ? _134 : phone;
            const taskId = await (0, bookingExecutor_1.createBookingTask)({
                clientPhone: phone,
                clientId,
                caregiverId: rebook.caregiverId,
                caregiverName: rebook.caregiverName,
                appointments: [{ date: dateStr, startTime: rebook.startTime, endTime: rebook.endTime, durationHours: rebook.durationHours }],
                hourlyRate: 20,
            });
            await db.collection("agent_sessions").doc(phone).update({ pendingRebook: admin.firestore.FieldValue.delete() });
            const perms = await (0, permissionsConversation_1.getPermissions)((_135 = session.userId) !== null && _135 !== void 0 ? _135 : phone).catch(() => null);
            if (perms === null || perms === void 0 ? void 0 : perms.canBookAutomatically) {
                try {
                    await (0, bookingExecutor_1.executeBookings)(taskId, phone);
                }
                catch (err) {
                    console.error("executeBookings failed (rebook):", err);
                    await db.collection("admin_alerts").add({ type: "booking_execution_failed", phone, error: String(err), createdAt: new Date().toISOString(), resolved: false });
                    await (0, client_1.sendMessage)(chatId, "I ran into a problem locking that in. Let me find an alternative — I'll get back to you shortly.");
                    const sd = (_136 = (await db.collection("agent_sessions").doc(phone).get()).data()) !== null && _136 !== void 0 ? _136 : {};
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
            const clientId = (_137 = session.userId) !== null && _137 !== void 0 ? _137 : phone;
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
            const durationHours = ((_138 = last.durationHours) !== null && _138 !== void 0 ? _138 : 4);
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
            const rescheduleNlMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: "Caregiver wants to reschedule a visit. Cara is asking them to suggest 2–3 times that work and will relay them to the family.",
                fallback: "No problem — text me 2–3 times that work for you and I'll let the family know right away.",
                maxTokens: 80,
            });
            await (0, client_1.sendMessage)(chatId, rescheduleNlMsg);
            return;
        }
        // ── RESCHEDULE_REQUEST — move an existing appointment to a new date/time ──
        if (intent === "RESCHEDULE_REQUEST" && session.userType !== "caregiver") {
            const qaReplyReschedule = await (0, qaAgent_1.runQaAgent)({
                text,
                phone,
                chatId,
                userId: (_139 = session.userId) !== null && _139 !== void 0 ? _139 : "",
                seniorId: (_141 = (_140 = session.seniorId) !== null && _140 !== void 0 ? _140 : session.userId) !== null && _141 !== void 0 ? _141 : "",
                userType: "client",
                caregiverId: session.caregiverId,
                zepThreadId: session.zepThreadId,
                session: session,
                intent,
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
        // ── SWAP_REQUEST — caregiver looking for coverage on one of their shifts ──
        if (intent === "SWAP_REQUEST" && session.userType === "caregiver") {
            if (session.service === "iMessage")
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                const cgDoc = session.caregiverId
                    ? await db.collection("caregivers").doc(session.caregiverId).get()
                    : null;
                await (0, caregiverSwapHandler_1.handleCaregiverSwapRequest)((_142 = session.caregiverId) !== null && _142 !== void 0 ? _142 : phone, (_144 = (_143 = cgDoc === null || cgDoc === void 0 ? void 0 : cgDoc.data()) === null || _143 === void 0 ? void 0 : _143.name) !== null && _144 !== void 0 ? _144 : "Caregiver", phone, text, 
                // Session has no swapStep yet — handler defaults to "identify_shift"
                session, chatId);
            }
            finally {
                if (session.service === "iMessage")
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── CANCEL_SHIFT — caregiver proactively cancels one of their shifts ───
        if (intent === "CANCEL_SHIFT" && session.userType === "caregiver") {
            if (session.service === "iMessage")
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                const cgDoc = session.caregiverId
                    ? await db.collection("caregivers").doc(session.caregiverId).get()
                    : null;
                await (0, caregiverCancelShiftHandler_1.handleCaregiverCancelShift)((_145 = session.caregiverId) !== null && _145 !== void 0 ? _145 : phone, (_147 = (_146 = cgDoc === null || cgDoc === void 0 ? void 0 : cgDoc.data()) === null || _146 === void 0 ? void 0 : _146.name) !== null && _147 !== void 0 ? _147 : "Caregiver", phone, text, session, chatId);
            }
            finally {
                if (session.service === "iMessage")
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── Caregiver profile updates (rate / skills / bio / photo / pause / reactivate) ──
        {
            const profileField = (0, caregiverProfileHandler_1.profileFieldFromIntent)(intent);
            if (profileField && session.userType === "caregiver" && session.caregiverId) {
                if (session.service === "iMessage")
                    await (0, client_1.startTyping)(chatId).catch(() => { });
                try {
                    // Seed the session state with the requested field and entry step so the
                    // handler enters "collect" cleanly.
                    await db.collection("agent_sessions").doc(phone).update({
                        profileUpdateStep: "collect",
                        profileUpdateField: profileField,
                        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    });
                    const enrichedSession = Object.assign(Object.assign({}, session), { profileUpdateStep: "collect", profileUpdateField: profileField });
                    await (0, caregiverProfileHandler_1.handleCaregiverProfileUpdate)(session.caregiverId, phone, text, enrichedSession, chatId, profileField);
                }
                finally {
                    if (session.service === "iMessage")
                        await (0, client_1.stopTyping)(chatId).catch(() => { });
                }
                return;
            }
        }
        // ── INSTANT_PAYOUT — PAYOUT keyword / "cash out now" / etc. ────────────
        if (intent === "INSTANT_PAYOUT" && session.userType === "caregiver" && session.caregiverId) {
            if (session.service === "iMessage")
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                const { startInstantPayout } = await Promise.resolve().then(() => __importStar(require("../agents/instantPayoutHandler")));
                await startInstantPayout(session.caregiverId, phone, chatId);
            }
            finally {
                if (session.service === "iMessage")
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── CLIENT_SWAP_REQUEST — client wants a different caregiver for a visit ──
        if (intent === "CLIENT_SWAP_REQUEST" && session.userType !== "caregiver") {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                await (0, clientSwapRequestHandler_1.handleClientSwapRequest)((_148 = session.userId) !== null && _148 !== void 0 ? _148 : phone, phone, text, 
                // Session has no clientSwapStep yet — handler defaults to "identify_appointment"
                session, chatId);
            }
            finally {
                if (session.service === "iMessage" && !session.groupChatId)
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── UPDATE_PAYMENT_METHOD — generate Stripe billing portal link ───────────
        if (intent === "UPDATE_PAYMENT_METHOD" && session.userType !== "caregiver") {
            const clientId = (_149 = session.userId) !== null && _149 !== void 0 ? _149 : phone;
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
            const refundClientId = ((_150 = session.userId) !== null && _150 !== void 0 ? _150 : phone);
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
                userId: (_151 = session.userId) !== null && _151 !== void 0 ? _151 : "",
                seniorId: (_153 = (_152 = session.seniorId) !== null && _152 !== void 0 ? _152 : session.userId) !== null && _153 !== void 0 ? _153 : "",
                userType: "client",
                caregiverId: session.caregiverId,
                zepThreadId: session.zepThreadId,
                session: session,
                intent,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: qaReplyInvoice,
                urgency: "standard",
                sourceAgent: "qa",
                canDrop: false,
            });
            return;
        }
        // ── APPROVE_TIMESHEET — client approves shift hours via dedicated handler ─
        if (intent === "APPROVE_TIMESHEET" && session.userType !== "caregiver") {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                await (0, timesheetHandler_1.handleTimesheetApproval)(((_154 = session.userId) !== null && _154 !== void 0 ? _154 : phone), phone, text, Object.assign(Object.assign({}, session), { timesheetStep: "start" }), (msg) => (0, client_1.sendMessage)(chatId, msg));
            }
            finally {
                if (session.service === "iMessage" && !session.groupChatId)
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── VIEW_EARNINGS — caregiver views their pay summary ────────────────────
        if (intent === "VIEW_EARNINGS" && session.userType === "caregiver") {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                const cgId = ((_156 = (_155 = session.caregiverId) !== null && _155 !== void 0 ? _155 : session.userId) !== null && _156 !== void 0 ? _156 : phone);
                await (0, earningsHandler_1.handleEarningsView)(cgId, (msg) => (0, client_1.sendMessage)(chatId, msg));
            }
            finally {
                if (session.service === "iMessage" && !session.groupChatId)
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── UPDATE_AVAILABILITY — caregiver updates their schedule ───────────────
        if (intent === "UPDATE_AVAILABILITY" && session.userType === "caregiver") {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                const cgId = ((_158 = (_157 = session.caregiverId) !== null && _157 !== void 0 ? _157 : session.userId) !== null && _158 !== void 0 ? _158 : phone);
                await (0, availabilityHandler_1.handleAvailabilityUpdate)(cgId, phone, text, Object.assign(Object.assign({}, session), { availabilityStep: "start" }), (msg) => (0, client_1.sendMessage)(chatId, msg));
            }
            finally {
                if (session.service === "iMessage" && !session.groupChatId)
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── Platform-action intents — routed to QA agent with new MCP tools ─────
        if (intent === "VIEW_MY_JOBS" ||
            intent === "VIEW_APPLICANTS" ||
            intent === "VIEW_JOURNAL" ||
            intent === "BROWSE_JOB_BOARD") {
            const qaReplyPlatform = await (0, qaAgent_1.runQaAgent)({
                text,
                phone,
                chatId,
                userId: (_159 = session.userId) !== null && _159 !== void 0 ? _159 : "",
                seniorId: (_161 = (_160 = session.seniorId) !== null && _160 !== void 0 ? _160 : session.userId) !== null && _161 !== void 0 ? _161 : "",
                userType: (_162 = session.userType) !== null && _162 !== void 0 ? _162 : "client",
                caregiverId: session.caregiverId,
                zepThreadId: session.zepThreadId,
                session: session,
                intent,
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
                userId: (_163 = session.userId) !== null && _163 !== void 0 ? _163 : "",
                seniorId: (_165 = (_164 = session.seniorId) !== null && _164 !== void 0 ? _164 : session.userId) !== null && _165 !== void 0 ? _165 : "",
                userType: "client",
                caregiverId: session.caregiverId,
                zepThreadId: session.zepThreadId,
                session: session,
                intent,
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
            const sessionData = (_166 = sessionSnap2.data()) !== null && _166 !== void 0 ? _166 : {};
            await runMatchingForClient(phone, chatId, sessionData, sessionData);
            return;
        }
        // ── Healthcare intents — provider search, appointment booking, Rx ────────
        if ((intent === "FIND_NEARBY_PROVIDER" ||
            intent === "BOOK_DOCTOR_APPOINTMENT" ||
            intent === "PRESCRIPTION_REFILL" ||
            intent === "NEW_PRESCRIPTION") &&
            session.userType !== "caregiver") {
            if (session.service === "iMessage" && !session.groupChatId)
                await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                const { startHealthcareFlow } = await Promise.resolve().then(() => __importStar(require("../agents/healthcareHandler")));
                await startHealthcareFlow(phone, chatId, text, session, intent, (msg) => (0, client_1.sendMessage)(chatId, msg));
            }
            finally {
                if (session.service === "iMessage" && !session.groupChatId)
                    await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // ── Fact correction — user is correcting a known fact ────────────────────
        if (intent === "FACT_CORRECTION") {
            const { detectAndApplyCorrection } = await Promise.resolve().then(() => __importStar(require("../memory/learnedFacts")));
            const factUserId = session.userType === "caregiver"
                ? ((_168 = (_167 = session.caregiverId) !== null && _167 !== void 0 ? _167 : session.userId) !== null && _168 !== void 0 ? _168 : phone)
                : ((_169 = session.userId) !== null && _169 !== void 0 ? _169 : phone);
            const zepUserId2 = session.zepThreadId ? phone.replace(/\D/g, "") : undefined;
            const applied = await detectAndApplyCorrection(factUserId, text, zepUserId2).catch(() => false);
            if (applied) {
                await (0, client_1.sendMessage)(chatId, "Got it — I've updated that.");
                return;
            }
            // Fall through to QA agent if we couldn't match a specific known fact
        }
        // ── Update onboarding — already-onboarded user wants to review/fix profile ─
        // PARTIAL users (no userId/seniorId) hit the onboarding offer earlier in
        // this handler and never reach here. For ONBOARDED users, flip a session
        // flag and fall through to runQaAgent — qaAgent reads the flag and runs a
        // structured profile-review sub-prompt (read current state, confirm in
        // prose, patch fields one at a time via update_senior_profile /
        // update_care_plan). 20-minute TTL prevents stale flags surviving across
        // unrelated future conversations.
        if (intent === "UPDATE_ONBOARDING" && session.userType !== "caregiver") {
            const ttlMs = 20 * 60 * 1000;
            const expiresAt = new Date(Date.now() + ttlMs).toISOString();
            await db.collection("agent_sessions").doc(phone).update({
                profileReviewMode: true,
                profileReviewExpiresAt: expiresAt,
            }).catch((err) => console.warn("profileReviewMode set failed", err));
            // Mutate the in-memory session too so the directive fires THIS turn.
            session.profileReviewMode = true;
            session.profileReviewExpiresAt = expiresAt;
            // Fall through to runQaAgent below.
        }
        // ── Default: QA agent ─────────────────────────────────────────────────────
        const zepThreadId = session.zepThreadId;
        if (zepThreadId) {
            (0, zepClient_1.addUserMessageToZep)({
                threadId: zepThreadId,
                content: text,
                userName: (_170 = session.firstName) !== null && _170 !== void 0 ? _170 : "Family",
                sentAt: new Date(),
            }).catch(console.error);
        }
        // ── Trivial quick-reply bypass — short generic greetings/thanks ─────────
        // For QUESTION-intent messages with no entity content, skip the full
        // tool-use loop and answer with gpt-4o-mini in ~1s. Conservative heuristic:
        // anything ambiguous falls through to runQaAgent below.
        if (intent === "QUESTION" && (0, qaAgent_1.isTrivialQuickReply)(text)) {
            const quickReply = await (0, qaAgent_1.runQuickReply)({
                text,
                phone,
                chatId,
                userId: (_171 = session.userId) !== null && _171 !== void 0 ? _171 : "",
                seniorId: (_173 = (_172 = session.seniorId) !== null && _172 !== void 0 ? _172 : session.userId) !== null && _173 !== void 0 ? _173 : "",
                userType: (_174 = session.userType) !== null && _174 !== void 0 ? _174 : "client",
            });
            if (zepThreadId && quickReply) {
                (0, zepClient_1.addAssistantMessageToZep)({ threadId: zepThreadId, content: quickReply }).catch(console.error);
            }
            return;
        }
        const qaReply = await (0, qaAgent_1.runQaAgent)({
            text,
            phone,
            chatId,
            userId: (_175 = session.userId) !== null && _175 !== void 0 ? _175 : "",
            seniorId: (_177 = (_176 = session.seniorId) !== null && _176 !== void 0 ? _176 : session.userId) !== null && _177 !== void 0 ? _177 : "",
            userType: (_178 = session.userType) !== null && _178 !== void 0 ? _178 : "client",
            caregiverId: session.caregiverId,
            zepThreadId,
            session: session,
            intent,
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
        // Don't broadcast brokenness. Send a warm, natural deflection and route
        // the error to the admin alert table so the team can follow up.
        await (0, client_1.sendMessage)(chatId, "Give me a moment on that — I'll come back to you shortly.").catch(() => { });
        await db.collection("agent_error_log").add({
            phone, error: String(err), text, createdAt: new Date().toISOString(),
        }).catch(() => { });
        await db.collection("admin_alerts").add({
            type: "handle_inbound_failure",
            phone,
            error: String(err),
            text: text.slice(0, 300),
            severity: "medium",
            createdAt: new Date().toISOString(),
            resolved: false,
        }).catch(() => { });
    }
    finally {
        await (0, client_1.stopTyping)(chatId).catch(() => { });
    }
}
// ── message.failed handler ────────────────────────────────────────────────────
async function handleMessageFailed(event) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
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
    // ── Forced-iMessage → SMS retry ─────────────────────────────────────────────
    // Forced iMessage has no automatic fallback, so a failure here means the
    // recipient isn't reachable on iMessage. If this message was a tracked
    // forced-iMessage send, re-send the identical content over SMS instead of
    // paging ops. (Records are written by trackForcedIMessage in client.ts.)
    if (messageId) {
        const retryRef = db.collection("agent_imessage_retry").doc(messageId);
        const retrySnap = await retryRef.get().catch(() => null);
        if (retrySnap === null || retrySnap === void 0 ? void 0 : retrySnap.exists) {
            const rec = retrySnap.data();
            if (!rec.retried) {
                // Resolve phone via the session that owns this chat to honour opt-out.
                const sessSnap = await db.collection("agent_sessions")
                    .where("chatId", "==", (_g = rec.chatId) !== null && _g !== void 0 ? _g : chatId)
                    .limit(1)
                    .get()
                    .catch(() => null);
                const sess = (_h = sessSnap === null || sessSnap === void 0 ? void 0 : sessSnap.docs[0]) === null || _h === void 0 ? void 0 : _h.data();
                await retryRef.update({ retried: true, retriedAt: now }).catch(() => { });
                if ((sess === null || sess === void 0 ? void 0 : sess.optedOut) || (sess === null || sess === void 0 ? void 0 : sess.optedIn) === false) {
                    console.warn("message.failed: forced-iMessage failed but recipient opted out — no SMS retry", { chatId, messageId });
                    await retryRef.delete().catch(() => { });
                }
                else {
                    try {
                        await (0, client_1.sendMessage)((_j = rec.chatId) !== null && _j !== void 0 ? _j : chatId, { parts: ((_k = rec.parts) !== null && _k !== void 0 ? _k : []) }, { preferredService: "SMS" });
                        await db.collection("agent_error_log").add({
                            type: "message.failed.retried_sms",
                            chatId: (_l = rec.chatId) !== null && _l !== void 0 ? _l : chatId,
                            messageId,
                            errorCode,
                            reason,
                            createdAt: now,
                        }).catch(() => { });
                        await retryRef.delete().catch(() => { });
                        console.info("message.failed: forced-iMessage failed, re-sent over SMS", { chatId, messageId });
                        return; // recovered — skip the high-severity admin alert below
                    }
                    catch (retryErr) {
                        console.error("message.failed: SMS retry failed", { chatId, messageId, retryErr });
                        await db.collection("admin_alerts").add({
                            type: "linq_imessage_sms_retry_failed",
                            chatId: (_m = rec.chatId) !== null && _m !== void 0 ? _m : chatId,
                            messageId,
                            errorCode,
                            reason,
                            severity: "high",
                            createdAt: now,
                            resolved: false,
                        }).catch(() => { });
                        console.warn("linqWebhook: message.failed", { chatId, messageId, errorCode, reason });
                        return;
                    }
                }
            }
        }
    }
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const ev = event;
    const phoneNumber = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.phone_number;
    const newStatus = (_c = (_b = ev.data) === null || _b === void 0 ? void 0 : _b.new_status) === null || _c === void 0 ? void 0 : _c.toUpperCase();
    const newHealth = (_e = (_d = ev.data) === null || _d === void 0 ? void 0 : _d.new_health_status) === null || _e === void 0 ? void 0 : _e.toLowerCase();
    const prevHealth = (_g = (_f = ev.data) === null || _f === void 0 ? void 0 : _f.previous_health_status) === null || _g === void 0 ? void 0 : _g.toLowerCase();
    const now = new Date().toISOString();
    if (!phoneNumber)
        return;
    await db.collection("linq_phone_health").doc(phoneNumber).set({
        phoneNumber,
        status: newStatus,
        healthStatus: newHealth,
        updatedAt: now,
    }, { merge: true }).catch(() => { });
    // ── FLAGGED: line is actively degraded — open circuit breaker immediately ────
    if (newStatus === "FLAGGED") {
        await db.collection("system_config").doc("linq_circuit_breaker").set({
            status: "open",
            reason: `Linq line ${phoneNumber} status FLAGGED`,
            openedAt: now,
            phone: phoneNumber,
        }, { merge: true }).catch(() => { });
        await db.collection("admin_alerts").add({
            type: "linq_line_flagged",
            phoneNumber,
            severity: "critical",
            message: `Linq line ${phoneNumber} is FLAGGED — message delivery degraded. Halting outbound sends.`,
            createdAt: now,
            resolved: false,
        }).catch(() => { });
        console.error("linqWebhook: circuit breaker OPENED — Linq line FLAGGED", { phoneNumber });
        return;
    }
    // ── ACTIVE restored: close circuit breaker if it was opened for this line ────
    if (newStatus === "ACTIVE") {
        const cb = await db.collection("system_config").doc("linq_circuit_breaker").get().catch(() => null);
        if (((_h = cb === null || cb === void 0 ? void 0 : cb.data()) === null || _h === void 0 ? void 0 : _h.phone) === phoneNumber && ((_j = cb === null || cb === void 0 ? void 0 : cb.data()) === null || _j === void 0 ? void 0 : _j.status) === "open") {
            await db.collection("system_config").doc("linq_circuit_breaker").set({
                status: "closed", closedAt: now,
            }, { merge: true }).catch(() => { });
            console.info("linqWebhook: circuit breaker CLOSED — Linq line restored ACTIVE", { phoneNumber });
        }
    }
    // ── Health status degraded ────────────────────────────────────────────────────
    const degraded = newHealth === "at_risk" || newHealth === "critical";
    if (degraded) {
        await db.collection("admin_alerts").add({
            type: "linq_phone_health_degraded",
            phoneNumber,
            prevHealth,
            newHealth,
            severity: newHealth === "critical" ? "critical" : "high",
            message: `Linq line ${phoneNumber} health: ${prevHealth !== null && prevHealth !== void 0 ? prevHealth : "unknown"} → ${newHealth}. ${newHealth === "critical" ? "Pause outbound messaging immediately." : "Reduce send volume."}`,
            createdAt: now,
            resolved: false,
        }).catch(() => { });
        console.error("linqWebhook: phone number health degraded", { phoneNumber, prevHealth, newHealth });
        if (newHealth === "critical") {
            await db.collection("system_config").doc("linq_circuit_breaker").set({
                status: "open",
                reason: `Linq line ${phoneNumber} health went critical`,
                openedAt: now,
                phone: phoneNumber,
            }, { merge: true }).catch(() => { });
            console.error("linqWebhook: circuit breaker OPENED — Linq line health critical", { phoneNumber });
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
    const phone = (_b = (_a = event.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.handle;
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
    .runWith({
    memory: "1GB",
    timeoutSeconds: 180,
    secrets: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "CREDENTIAL_VAULT_KEY"],
})
    .https.onRequest(async (req, res) => {
    // IMPORTANT: do NOT call res.send before the work — Cloud Functions Gen 1
    // throttles CPU after the HTTP response is sent, which causes every async
    // call (Firestore, Claude, OpenAI, Linq) to take 60–90s instead of milliseconds.
    // We respond 200 at the end so the function gets full CPU during processing.
    // Linq's webhook timeout is generous (≥10s); for slower turns the dedup
    // logic skips Linq's retry delivery.
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39, _40, _41;
    if (req.method !== "POST") {
        res.status(405).send("method not allowed");
        return;
    }
    // Single deferred response — fires at the end no matter which branch ran.
    let sent = false;
    const sendOk = () => { if (!sent) {
        sent = true;
        res.status(200).send("ok");
    } };
    try {
        const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
        if (!webhookSecret) {
            // Fail closed. If the secret is unset, we cannot verify any inbound event,
            // which means replays, spoofed senders, and signature tampering are all
            // accepted as authentic. A missing secret is a deploy-time misconfig, not
            // a runtime condition we degrade through. Return 500 so Linq retries until
            // an operator notices and the secret is restored.
            console.error("linqWebhook: LINQ_WEBHOOK_SECRET is not set — rejecting all inbound until configured");
            res.status(500).send("webhook secret not configured");
            sent = true;
            return;
        }
        const timestamp = (_a = req.headers["x-webhook-timestamp"]) !== null && _a !== void 0 ? _a : "";
        const signature = (_b = req.headers["x-webhook-signature"]) !== null && _b !== void 0 ? _b : "";
        const rawBody = (_c = req.rawBody) !== null && _c !== void 0 ? _c : Buffer.from(JSON.stringify(req.body));
        if (!verifySignature(rawBody, timestamp, signature, webhookSecret)) {
            console.warn("linqWebhook: invalid signature — ignoring");
            sendOk();
            return;
        }
        // Reject stale events (replay attack protection). Enforced regardless of
        // signature outcome above — both must pass.
        const tsNum = parseInt(timestamp, 10);
        if (!isNaN(tsNum) && Math.abs(Date.now() / 1000 - tsNum) > 300) {
            console.warn("linqWebhook: stale timestamp — ignoring");
            sendOk();
            return;
        }
        const event = req.body;
        // Linq v3 envelope uses event_type; fall back to X-Webhook-Event header for safety
        const eventType = (_e = (_d = event.event_type) !== null && _d !== void 0 ? _d : req.headers["x-webhook-event"]) !== null && _e !== void 0 ? _e : "";
        // Deduplicate all event types by event_id (Linq delivers at-least-once).
        // Transaction makes the check-and-write atomic so concurrent deliveries don't both pass.
        const eventId = (_f = event.event_id) !== null && _f !== void 0 ? _f : event.id;
        if (eventId) {
            const logRef = db.collection("agent_event_log").doc(eventId);
            let alreadyProcessed = false;
            await db.runTransaction(async (tx) => {
                const existing = await tx.get(logRef);
                if (existing.exists) {
                    alreadyProcessed = true;
                    return;
                }
                tx.set(logRef, { type: eventType, processedAt: new Date().toISOString() });
            });
            if (alreadyProcessed) {
                sendOk();
                return;
            }
        }
        switch (eventType) {
            case "message.received":
                await handleInbound(event).catch((err) => console.error("linqWebhook handleInbound:", err));
                break;
            case "message.read":
                await db.collection("agent_read_receipts").add({
                    chatId: (_h = (_g = event.data) === null || _g === void 0 ? void 0 : _g.chat) === null || _h === void 0 ? void 0 : _h.id,
                    messageId: (_j = event.data) === null || _j === void 0 ? void 0 : _j.message_id,
                    phone: (_l = (_k = event.data) === null || _k === void 0 ? void 0 : _k.sender_handle) === null || _l === void 0 ? void 0 : _l.handle,
                    readAt: new Date().toISOString(),
                }).catch(() => { });
                break;
            case "reaction.added":
                await handleReactionAdded(event).catch((err) => console.error("linqWebhook handleReactionAdded:", err));
                break;
            case "chat.typing_indicator.started":
                await handleTypingStarted(event).catch((err) => console.error("linqWebhook handleTypingStarted:", err));
                break;
            case "message.delivered": {
                const delivMsgId = (_q = (_o = (_m = event.data) === null || _m === void 0 ? void 0 : _m.message_id) !== null && _o !== void 0 ? _o : (_p = event.data) === null || _p === void 0 ? void 0 : _p.id) !== null && _q !== void 0 ? _q : (_s = (_r = event.data) === null || _r === void 0 ? void 0 : _r.message) === null || _s === void 0 ? void 0 : _s.id;
                if (!delivMsgId)
                    break;
                await db.collection("agent_conversations")
                    .where("messageId", "==", delivMsgId)
                    .limit(1)
                    .get()
                    .then(async (snap) => {
                    var _a, _b;
                    if (!snap.empty) {
                        await snap.docs[0].ref.update({ deliveredAt: (_b = (_a = event.data) === null || _a === void 0 ? void 0 : _a.delivered_at) !== null && _b !== void 0 ? _b : new Date().toISOString() });
                    }
                })
                    .catch(() => { });
                // Delivered = the forced-iMessage send succeeded; drop its retry record.
                // (Stragglers without a delivered/failed event auto-expire via TTL.)
                await db.collection("agent_imessage_retry").doc(delivMsgId).delete().catch(() => { });
                break;
            }
            case "message.failed":
                await handleMessageFailed(event).catch((err) => console.error("linqWebhook handleMessageFailed:", err));
                break;
            case "phone_number.status_updated":
                await handlePhoneNumberStatusUpdated(event).catch((err) => console.error("linqWebhook handlePhoneNumberStatusUpdated:", err));
                break;
            case "message.sent": {
                // Linq message.sent event shape can vary — log it once so we know the structure
                const sentChatId = (_x = (_v = (_u = (_t = event.data) === null || _t === void 0 ? void 0 : _t.chat) === null || _u === void 0 ? void 0 : _u.id) !== null && _v !== void 0 ? _v : (_w = event.data) === null || _w === void 0 ? void 0 : _w.chat_id) !== null && _x !== void 0 ? _x : (_z = (_y = event.data) === null || _y === void 0 ? void 0 : _y.message) === null || _z === void 0 ? void 0 : _z.chat_id;
                const sentMsgId = (_3 = (_1 = (_0 = event.data) === null || _0 === void 0 ? void 0 : _0.id) !== null && _1 !== void 0 ? _1 : (_2 = event.data) === null || _2 === void 0 ? void 0 : _2.message_id) !== null && _3 !== void 0 ? _3 : (_5 = (_4 = event.data) === null || _4 === void 0 ? void 0 : _4.message) === null || _5 === void 0 ? void 0 : _5.id;
                console.info("linqWebhook message.sent data keys:", Object.keys((_6 = event.data) !== null && _6 !== void 0 ? _6 : {}), "chatId:", sentChatId, "msgId:", sentMsgId);
                if (!sentChatId)
                    break;
                await db.collection("agent_conversations")
                    .where("chatId", "==", sentChatId)
                    .where("direction", "==", "outbound")
                    .orderBy("createdAt", "desc")
                    .limit(1)
                    .get()
                    .then(async (snap) => {
                    var _a, _b, _c;
                    if (!snap.empty) {
                        await snap.docs[0].ref.update({
                            messageId: sentMsgId,
                            service: (_a = event.data) === null || _a === void 0 ? void 0 : _a.service,
                            sentAt: (_c = (_b = event.data) === null || _b === void 0 ? void 0 : _b.sent_at) !== null && _c !== void 0 ? _c : new Date().toISOString(),
                        });
                    }
                })
                    .catch(() => { });
                break;
            }
            case "message.edited": {
                // Store latest text for the edited part
                const editMsgId = (_10 = (_8 = (_7 = event.data) === null || _7 === void 0 ? void 0 : _7.id) !== null && _8 !== void 0 ? _8 : (_9 = event.data) === null || _9 === void 0 ? void 0 : _9.message_id) !== null && _10 !== void 0 ? _10 : (_12 = (_11 = event.data) === null || _11 === void 0 ? void 0 : _11.message) === null || _12 === void 0 ? void 0 : _12.id;
                if (!editMsgId)
                    break;
                await db.collection("agent_conversations")
                    .where("messageId", "==", editMsgId)
                    .limit(1)
                    .get()
                    .then(async (snap) => {
                    var _a, _b, _c, _d;
                    if (!snap.empty) {
                        await snap.docs[0].ref.update({
                            editedText: (_b = (_a = event.data) === null || _a === void 0 ? void 0 : _a.part) === null || _b === void 0 ? void 0 : _b.text,
                            editedAt: (_d = (_c = event.data) === null || _c === void 0 ? void 0 : _c.edited_at) !== null && _d !== void 0 ? _d : new Date().toISOString(),
                        });
                    }
                })
                    .catch(() => { });
                break;
            }
            case "reaction.removed":
                await db.collection("agent_reactions").add({
                    chatId: (_13 = event.data) === null || _13 === void 0 ? void 0 : _13.chat_id,
                    messageId: (_14 = event.data) === null || _14 === void 0 ? void 0 : _14.message_id,
                    reaction: (_16 = (_15 = event.data) === null || _15 === void 0 ? void 0 : _15.reaction_type) !== null && _16 !== void 0 ? _16 : (_17 = event.data) === null || _17 === void 0 ? void 0 : _17.reaction,
                    phone: (_18 = event.data) === null || _18 === void 0 ? void 0 : _18.from,
                    operation: "removed",
                    reactedAt: (_20 = (_19 = event.data) === null || _19 === void 0 ? void 0 : _19.reacted_at) !== null && _20 !== void 0 ? _20 : new Date().toISOString(),
                }).catch(() => { });
                break;
            case "chat.created":
                // Log new chat creation; check chat health on first contact
                await db.collection("agent_event_log").doc(eventId !== null && eventId !== void 0 ? eventId : (0, uuid_1.v4)()).set({
                    type: "chat.created",
                    chatId: (_21 = event.data) === null || _21 === void 0 ? void 0 : _21.id,
                    service: (_22 = event.data) === null || _22 === void 0 ? void 0 : _22.service,
                    isGroup: (_24 = (_23 = event.data) === null || _23 === void 0 ? void 0 : _23.is_group) !== null && _24 !== void 0 ? _24 : false,
                    createdAt: (_26 = (_25 = event.data) === null || _25 === void 0 ? void 0 : _25.created_at) !== null && _26 !== void 0 ? _26 : new Date().toISOString(),
                }, { merge: true }).catch(() => { });
                break;
            case "chat.typing_indicator.stopped":
                // No action needed — started is used for prefetch; stopped is informational
                break;
            case "participant.added":
                await db.collection("agent_group_events").add({
                    type: "participant.added",
                    chatId: (_27 = event.data) === null || _27 === void 0 ? void 0 : _27.chat_id,
                    handle: (_28 = event.data) === null || _28 === void 0 ? void 0 : _28.handle,
                    joinedAt: (_30 = (_29 = event.data) === null || _29 === void 0 ? void 0 : _29.added_at) !== null && _30 !== void 0 ? _30 : new Date().toISOString(),
                }).catch(() => { });
                break;
            case "participant.removed":
                await db.collection("agent_group_events").add({
                    type: "participant.removed",
                    chatId: (_31 = event.data) === null || _31 === void 0 ? void 0 : _31.chat_id,
                    handle: (_32 = event.data) === null || _32 === void 0 ? void 0 : _32.handle,
                    leftAt: (_34 = (_33 = event.data) === null || _33 === void 0 ? void 0 : _33.removed_at) !== null && _34 !== void 0 ? _34 : new Date().toISOString(),
                }).catch(() => { });
                break;
            case "chat.group_name_updated":
            case "chat.group_icon_updated":
                await db.collection("agent_group_events").add({
                    type: eventType,
                    chatId: (_35 = event.data) === null || _35 === void 0 ? void 0 : _35.chat_id,
                    oldValue: (_36 = event.data) === null || _36 === void 0 ? void 0 : _36.old_value,
                    newValue: (_37 = event.data) === null || _37 === void 0 ? void 0 : _37.new_value,
                    updatedAt: (_39 = (_38 = event.data) === null || _38 === void 0 ? void 0 : _38.updated_at) !== null && _39 !== void 0 ? _39 : new Date().toISOString(),
                }).catch(() => { });
                break;
            case "chat.group_name_update_failed":
            case "chat.group_icon_update_failed":
                console.warn(`linqWebhook: ${eventType}`, {
                    chatId: (_40 = event.data) === null || _40 === void 0 ? void 0 : _40.chat_id,
                    errorCode: (_41 = event.data) === null || _41 === void 0 ? void 0 : _41.error_code,
                });
                break;
            default:
                console.warn(`linqWebhook: unhandled event type "${eventType || "unknown"}"`);
                break;
        }
    }
    catch (err) {
        console.error("linqWebhook: top-level error", err);
    }
    finally {
        sendOk();
    }
});
//# sourceMappingURL=webhooks.js.map