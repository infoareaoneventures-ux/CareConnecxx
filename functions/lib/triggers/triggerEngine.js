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
exports.triggerEngineScheduled = exports.runTriggerEngine = void 0;
exports.scheduleTrigger = scheduleTrigger;
exports.cancelTriggerIfUserReplied = cancelTriggerIfUserReplied;
exports.markTriggerEngaged = markTriggerEngaged;
exports.checkIgnoredTriggers = checkIgnoredTriggers;
exports.checkAndTriggerRematching = checkAndTriggerRematching;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const claudeClient_1 = require("../utils/claudeClient");
const caraAgent_1 = require("../agents/caraAgent");
const client_1 = require("../linq/client");
const db = admin.firestore();
// 30-day calibration period — no proactive triggers during this window
function isInCalibrationPeriod(sessionCreatedAt) {
    const createdMs = new Date(sessionCreatedAt).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    return Date.now() - createdMs < thirtyDaysMs;
}
// Schedule a proactive trigger — no-op during calibration period
async function scheduleTrigger(trigger) {
    // Check calibration
    const sessionSnap = await db.collection("agent_sessions").doc(trigger.phone).get();
    if (sessionSnap.exists) {
        const session = sessionSnap.data();
        if (session.createdAt && isInCalibrationPeriod(session.createdAt)) {
            return ""; // Silently skip during calibration
        }
    }
    const ref = await db.collection("proactive_triggers").add(Object.assign(Object.assign({}, trigger), { createdAt: new Date().toISOString() }));
    return ref.id;
}
// ── Dynamic message generation for Claude-scheduled triggers ─────────────────
// Regenerates the message at fire time using current memory context, so the
// message feels written in the moment rather than frozen from days ago.
async function generateTriggerMessage(trigger, memoryContext) {
    var _a, _b;
    try {
        const resp = await (0, claudeClient_1.getSharedClient)().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 120,
            system: "You are Cara, an AI care assistant. Write a single brief follow-up text message (1–2 sentences).\n" +
                "Tone: warm, specific, natural — like a care coordinator who remembers the context.\n" +
                "Use the family's care context and the reason for the follow-up to make it feel relevant.\n" +
                "No bullet points. No emoji. No preamble. Output only the message text.",
            messages: [{
                    role: "user",
                    content: `Reason for this follow-up: ${(_a = trigger.intent) !== null && _a !== void 0 ? _a : "general check-in"}\n` +
                        `Original planned message: ${trigger.message}\n` +
                        `Care context:\n${memoryContext.slice(0, 600)}`,
                }],
        });
        const text = ((_b = resp.content[0].text) !== null && _b !== void 0 ? _b : "").trim();
        return text || trigger.message;
    }
    catch (_c) {
        return trigger.message; // fall back to the stored message
    }
}
// ── Context-aware suppression for Claude-scheduled triggers ───────────────────
// Checks recent conversation to see if the follow-up is still relevant before sending.
async function shouldFireTrigger(trigger, recentMessages) {
    var _a;
    if (!trigger.intent)
        return true; // no intent = system trigger = always fire
    if (recentMessages.length === 0)
        return true;
    const recentText = recentMessages
        .slice(-3)
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");
    try {
        const resp = await (0, claudeClient_1.getSharedClient)().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 5,
            system: "You decide if a scheduled follow-up message should still be sent, given recent conversation.\n" +
                "Reply YES if the follow-up is still relevant and useful.\n" +
                "Reply NO if the family already addressed this topic, the situation has resolved, or it would feel out of context.\n" +
                "One word only: YES or NO.",
            messages: [{
                    role: "user",
                    content: `Follow-up intent: ${trigger.intent}\n` +
                        `Follow-up message: ${trigger.message}\n\n` +
                        `Recent conversation:\n${recentText}`,
                }],
        });
        const answer = ((_a = resp.content[0].text) !== null && _a !== void 0 ? _a : "").trim().toUpperCase();
        return answer !== "NO";
    }
    catch (_b) {
        return true; // default open on failure
    }
}
// Called at the top of the main webhook handler (after crisis check) to cancel pending triggers
// Twin-trigger pattern: if user replied, cancel their scheduled nudge
async function cancelTriggerIfUserReplied(userId, phone) {
    const now = new Date().toISOString();
    const snap = await db
        .collection("proactive_triggers")
        .where("userId", "==", userId)
        .where("cancelledAt", "==", null)
        .where("firedAt", "==", null)
        .get();
    if (!snap.empty) {
        const batch = db.batch();
        for (const doc of snap.docs) {
            batch.update(doc.ref, { cancelledAt: now });
        }
        await batch.commit().catch(() => { });
    }
    // Mark any recently-fired triggers as engaged — user replied
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const firedSnap = await db
        .collection("proactive_triggers")
        .where("userId", "==", userId)
        .where("firedAt", ">=", oneDayAgo)
        .get();
    for (const doc of firedSnap.docs) {
        const data = doc.data();
        if (!data.firedAt || data.engagedAt)
            continue;
        await doc.ref.update({ engagedAt: now });
        await markTriggerEngaged(phone, data.type);
    }
}
// Reset consecutive-ignore count when user engages with a trigger
async function markTriggerEngaged(phone, triggerType) {
    await db.collection("trigger_engagement")
        .doc(`${phone}_${triggerType}`)
        .set({ consecutiveIgnores: 0, lastEngagedAt: new Date().toISOString() }, { merge: true });
}
async function pauseTriggerType(phone, triggerType) {
    await db.collection("trigger_engagement")
        .doc(`${phone}_${triggerType}`)
        .set({ paused: true, pausedAt: new Date().toISOString() }, { merge: true });
    // Cancel any pending triggers of this type for this user
    const snap = await db.collection("proactive_triggers")
        .where("phone", "==", phone)
        .where("type", "==", triggerType)
        .get();
    const now = new Date().toISOString();
    const batch = db.batch();
    for (const doc of snap.docs) {
        const d = doc.data();
        if (!d.firedAt && !d.cancelledAt)
            batch.update(doc.ref, { cancelledAt: now });
    }
    await batch.commit().catch(() => { });
}
// Detect triggers fired 24h+ ago with no user response; pause after 3 consecutive ignores
async function checkIgnoredTriggers() {
    var _a, _b, _c;
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const snap = await db.collection("proactive_triggers")
        .where("firedAt", "<=", oneDayAgo)
        .get();
    for (const doc of snap.docs) {
        const trigger = doc.data();
        if (!trigger.firedAt)
            continue;
        if (trigger.engagedAt)
            continue; // user did engage
        if (trigger.ignoreCounted)
            continue; // already counted
        const engRef = db.collection("trigger_engagement").doc(`${trigger.phone}_${trigger.type}`);
        const engSnap = await engRef.get();
        const prev = (_b = (_a = engSnap.data()) === null || _a === void 0 ? void 0 : _a.consecutiveIgnores) !== null && _b !== void 0 ? _b : 0;
        const consecutiveIgnores = prev + 1;
        await engRef.set({
            phone: trigger.phone,
            triggerType: trigger.type,
            consecutiveIgnores,
            lastIgnoredAt: new Date().toISOString(),
        }, { merge: true });
        await doc.ref.update({ ignoreCounted: true });
        if (consecutiveIgnores >= 3) {
            await pauseTriggerType(trigger.phone, trigger.type);
            const triggerFriendlyNames = {
                appointment_reminder: "appointment reminders",
                weekly_checkin: "weekly check-ins",
                medication_reminder: "medication reminders",
                custom: "these messages",
            };
            const friendlyName = (_c = triggerFriendlyNames[trigger.type]) !== null && _c !== void 0 ? _c : "these messages";
            await (0, caraAgent_1.sendViaInteractionAgent)(trigger.phone, {
                content: `I've paused the ${friendlyName} since you haven't been using them lately.\n\n` +
                    `Want me to turn them back on, try a different time, or skip them for now?`,
                urgency: "standard",
                sourceAgent: "trigger_engine",
                canDrop: false,
            });
        }
    }
}
// Every-5-minute executor — fires due triggers, skips cancelled/fired ones
exports.runTriggerEngine = functions.pubsub
    .schedule("*/5 * * * *")
    .onRun(async () => {
    var _a, _b, _c;
    const now = new Date().toISOString();
    const snap = await db
        .collection("proactive_triggers")
        .where("scheduledAt", "<=", now)
        .get();
    for (const doc of snap.docs) {
        const trigger = doc.data();
        // Skip already fired or cancelled
        if (trigger.firedAt || trigger.cancelledAt)
            continue;
        // Twin-trigger: check if user sent a message since trigger was created
        const lastReply = await db
            .collection("agent_conversations")
            .doc(trigger.phone)
            .collection("messages")
            .where("role", "==", "user")
            .where("timestamp", ">=", new Date(trigger.createdAt).getTime())
            .limit(1)
            .get();
        if (!lastReply.empty) {
            // User already replied — cancel the trigger
            await doc.ref.update({ cancelledAt: now });
            continue;
        }
        // Get user's session to find chatId
        const sessionSnap = await db.collection("agent_sessions").doc(trigger.phone).get();
        if (!sessionSnap.exists) {
            await doc.ref.update({ cancelledAt: now });
            continue;
        }
        const session = sessionSnap.data();
        if (session.optedOut) {
            await doc.ref.update({ cancelledAt: now });
            continue;
        }
        try {
            // Retry recurring schedule extension after 1h
            if (trigger.message.startsWith("retry_extend_schedule:")) {
                const scheduleId = trigger.message.slice("retry_extend_schedule:".length);
                const { extendRecurringScheduleById } = await Promise.resolve().then(() => __importStar(require("../scheduled/recurringScheduler")));
                await extendRecurringScheduleById(scheduleId).catch(err => console.error(`retry_extend_schedule failed for ${scheduleId}:`, err));
            }
            else if (trigger.message.startsWith("health_escalation:")) {
                const [, seniorId, alertDocId] = trigger.message.split(":");
                if (seniorId && alertDocId) {
                    await escalateHealthAlert(seniorId, alertDocId, trigger.phone).catch(err => console.error("health escalation failed:", err));
                }
            }
            else if (trigger.message.startsWith("replacement_task:")) {
                const taskId = trigger.message.slice("replacement_task:".length);
                const taskSnap = await db.collection("agent_tasks").doc(taskId).get();
                const task = taskSnap.data();
                if (task && task.status === "awaiting_approval") {
                    await autoBookBestReplacement(taskId, task);
                }
            }
            else if (trigger.message.startsWith("qa_retry:")) {
                const raw = trigger.message.slice("qa_retry:".length);
                try {
                    const params = JSON.parse(raw);
                    const { runQaAgent } = await Promise.resolve().then(() => __importStar(require("../agents/qaAgent")));
                    await runQaAgent(Object.assign(Object.assign({}, params), { isRetry: true, sourceChannel: "[SYSTEM: retry]" }));
                }
                catch (err) {
                    console.error("qa_retry: parse/run failed:", err);
                }
            }
            else if (trigger.message.startsWith("caregiver_checkin:")) {
                const appointmentId = trigger.message.slice("caregiver_checkin:".length);
                await handleCaregiverCheckin(appointmentId, trigger.phone).catch(err => console.error("caregiver_checkin failed:", err));
            }
            else if (trigger.message.startsWith("caregiver_checkin_escalation:")) {
                const appointmentId = trigger.message.slice("caregiver_checkin_escalation:".length);
                await handleCaregiverCheckinEscalation(appointmentId).catch(err => console.error("caregiver_checkin_escalation failed:", err));
            }
            else if (trigger.message.startsWith("issue_escalation:")) {
                const issueLogId = trigger.message.slice("issue_escalation:".length);
                const { escalateIssue } = await Promise.resolve().then(() => __importStar(require("../agents/issueEscalator")));
                await escalateIssue(issueLogId).catch(err => console.error("issue_escalation failed:", err));
            }
            else if (trigger.message.startsWith("issue_escalation_final:")) {
                const issueLogId = trigger.message.slice("issue_escalation_final:".length);
                const { escalateIssueFinal } = await Promise.resolve().then(() => __importStar(require("../agents/issueEscalator")));
                await escalateIssueFinal(issueLogId).catch(err => console.error("issue_escalation_final failed:", err));
            }
            else if (trigger.message.startsWith("issue_followup:")) {
                const issueLogId = trigger.message.slice("issue_followup:".length);
                const { sendIssueFollowUp } = await Promise.resolve().then(() => __importStar(require("../agents/issueEscalator")));
                await sendIssueFollowUp(issueLogId).catch(err => console.error("issue_followup failed:", err));
            }
            else if (trigger.message.startsWith("interview_followup:")) {
                const interviewId = trigger.message.slice("interview_followup:".length);
                const { sendPostInterviewFollowUp } = await Promise.resolve().then(() => __importStar(require("../agents/interviewAgent")));
                await sendPostInterviewFollowUp(interviewId).catch(err => console.error("interview_followup failed:", err));
            }
            else if (trigger.source === "claude" && trigger.intent) {
                // Claude-scheduled follow-up: check context before firing, then regenerate message
                // Load last 5 conversation turns for suppression check
                const recentMsgs = await db
                    .collection("agent_conversations")
                    .doc(trigger.phone)
                    .collection("messages")
                    .orderBy("timestamp", "desc")
                    .limit(5)
                    .get()
                    .then(s => s.docs.map(d => ({ role: d.data().role, content: d.data().content })).reverse())
                    .catch(() => []);
                // Context-aware suppression: skip if topic already addressed
                const fire = await shouldFireTrigger(trigger, recentMsgs);
                if (!fire) {
                    await doc.ref.update({ cancelledAt: now, suppressionReason: "context_resolved" });
                    console.log(`[triggerEngine] Suppressed claude trigger ${doc.id} — context already resolved`);
                    continue;
                }
                // Dynamic message: regenerate from current care context
                const { getMemoryContext } = await Promise.resolve().then(() => __importStar(require("../memory/memoryFiles")));
                const memCtx = await getMemoryContext(trigger.userId).catch(() => "");
                const content = await generateTriggerMessage(trigger, memCtx);
                const isHealthTrigger = ["health_alert", "health_check", "medication_reminder", "fall_risk", "wellness_check"].includes((_a = trigger.type) !== null && _a !== void 0 ? _a : "");
                await (0, caraAgent_1.sendViaInteractionAgent)(trigger.phone, {
                    content,
                    urgency: isHealthTrigger ? "immediate" : "standard",
                    sourceAgent: "trigger_engine",
                    canDrop: !isHealthTrigger,
                });
            }
            else {
                const isHealthTrigger = ["health_alert", "health_check", "medication_reminder", "fall_risk", "wellness_check"].includes((_b = trigger.type) !== null && _b !== void 0 ? _b : "");
                await (0, caraAgent_1.sendViaInteractionAgent)(trigger.phone, {
                    content: trigger.message,
                    urgency: isHealthTrigger ? "immediate" : "standard",
                    sourceAgent: "trigger_engine",
                    canDrop: !isHealthTrigger,
                });
            }
            await doc.ref.update({ firedAt: now });
        }
        catch (err) {
            console.error("triggerEngine: failed to send for", doc.id, err);
        }
    }
    // ── No-show detection — check for unacknowledged confirmed visits ─────────
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const noShowSnap = await db
        .collection("appointments")
        .where("status", "==", "confirmed")
        .where("startDateTime", "<=", twentyMinAgo)
        .where("noShowChecked", "==", null)
        .limit(10)
        .get();
    for (const apptDoc of noShowSnap.docs) {
        const appt = apptDoc.data();
        if (appt.arrivedAt)
            continue; // caregiver arrived, not a no-show
        await apptDoc.ref.update({ noShowChecked: now });
        try {
            const clientSnap = await db.collection("users").doc(appt.clientId).get();
            const phone = (_c = clientSnap.data()) === null || _c === void 0 ? void 0 : _c.phone;
            if (!phone)
                continue;
            const { runEmergencyReplacement } = await Promise.resolve().then(() => __importStar(require("../agents/replacementAgent")));
            await runEmergencyReplacement({
                appointmentId: apptDoc.id,
                clientId: appt.clientId,
                clientPhone: phone,
                appt,
            });
        }
        catch (err) {
            console.error("triggerEngine no-show handling error for", apptDoc.id, err);
        }
    }
    // Check for ignored triggers and pause after 3 consecutive ignores
    await checkIgnoredTriggers().catch((err) => console.error("checkIgnoredTriggers error:", err));
    // Expire stale interview requests and re-match family if no candidates remain
    await checkExpiredInterviewRequests().catch((err) => console.error("checkExpiredInterviewRequests error:", err));
    // Fire any user-defined recurring reminders that are due
    await evaluateUserTriggers().catch((err) => console.error("evaluateUserTriggers error:", err));
    // Clear expired state machine flags so users never get stuck
    await clearExpiredSessionStates().catch((err) => console.error("clearExpiredSessionStates error:", err));
});
exports.triggerEngineScheduled = exports.runTriggerEngine;
// ── Expire stale interview requests and re-match when all candidates exhausted ─
async function checkExpiredInterviewRequests() {
    var _a, _b;
    const now = new Date().toISOString();
    const snap = await db.collection("interview_requests")
        .where("status", "==", "awaiting_caregiver_availability")
        .where("expiresAt", "<=", now)
        .get();
    if (snap.empty)
        return;
    for (const doc of snap.docs) {
        const req = doc.data();
        try {
            await doc.ref.update({ status: "expired", expiredAt: now });
            const clientPhone = req.clientPhone;
            if (!clientPhone)
                continue;
            // Notify family that this caregiver didn't respond
            const caregiverName = (_a = req.caregiverName) !== null && _a !== void 0 ? _a : "The caregiver";
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: `${caregiverName} didn't respond to the interview request in time. ` +
                    `I'm looking for other options — I'll send new matches shortly.`,
                urgency: "standard",
                sourceAgent: "interview_agent",
                canDrop: false,
            }).catch(() => { });
            // Check if ALL interview requests for this client are now in terminal states
            await checkAndTriggerRematching(clientPhone, (_b = req.caregiverId) !== null && _b !== void 0 ? _b : "").catch(err => console.error(`checkExpiredInterviewRequests: re-match failed for ${clientPhone}:`, err));
        }
        catch (err) {
            console.error(`checkExpiredInterviewRequests: error for request ${doc.id}:`, err);
        }
    }
    console.log(`[checkExpiredInterviewRequests] Expired ${snap.size} interview requests`);
}
// Called when a caregiver declines or an interview expires — checks if all options
// are exhausted and kicks off a fresh matching pass if so.
async function checkAndTriggerRematching(clientPhone, excludeCaregiverId) {
    var _a, _b, _c;
    const TERMINAL = ["declined", "expired", "caregiver_declined", "client_declined", "scheduled"];
    const allReqs = await db.collection("interview_requests")
        .where("clientPhone", "==", clientPhone)
        .get();
    if (allReqs.empty)
        return;
    // Collect all tried caregiver IDs
    const triedIds = allReqs.docs.map(d => d.data().caregiverId).filter(Boolean);
    const allTerminal = allReqs.docs.every(d => { var _a; return TERMINAL.includes((_a = d.data().status) !== null && _a !== void 0 ? _a : ""); });
    const anyScheduled = allReqs.docs.some(d => d.data().status === "scheduled");
    if (!allTerminal || anyScheduled)
        return; // Still an active request, or interview already scheduled
    // All requests exhausted — trigger fresh matching with exclusions
    const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut)
        return;
    // Add excluded caregivers to session so matchingAgent skips them
    const alreadyExcluded = ((_a = session.rejectedCaregiverIds) !== null && _a !== void 0 ? _a : []);
    const newExclusions = triedIds.filter(id => !alreadyExcluded.includes(id));
    if (newExclusions.length > 0) {
        await db.collection("agent_sessions").doc(clientPhone).update({
            rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(...newExclusions),
        });
    }
    await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
        content: "All the caregivers I reached out to weren't available. Let me search for fresh options — I'll have new matches for you shortly.",
        urgency: "standard",
        sourceAgent: "interview_agent",
        canDrop: false,
    });
    // Skip if a matching agent is already running for this client
    const activeMatchSnap = await db.collection("agent_tasks_active").doc(clientPhone).get();
    if (activeMatchSnap.exists && ((_b = activeMatchSnap.data()) === null || _b === void 0 ? void 0 : _b.type) === "matching") {
        console.log(`[checkAndTriggerRematching] Skipping re-match — matching agent already active for ${clientPhone}`);
        return;
    }
    const { runMatchingForClient } = await Promise.resolve().then(() => __importStar(require("../agents/matchingAgent")));
    const chatId = (_c = session.chatId) !== null && _c !== void 0 ? _c : "";
    await runMatchingForClient(clientPhone, chatId, session, session).catch(err => console.error("checkAndTriggerRematching: runMatchingForClient failed:", err));
}
// ── Escalate health alert to emergency contact if family didn't acknowledge ────
async function escalateHealthAlert(seniorId, alertDocId, familyPhone) {
    var _a, _b, _c;
    const alertSnap = await db.collection("health_alerts_pending").doc(alertDocId).get();
    if (!alertSnap.exists)
        return;
    const alert = alertSnap.data();
    if (alert.escalated)
        return; // already escalated
    // Check if the family replied after the alert was sent
    const sentAt = alert.sentAt;
    const replied = await db.collection("agent_conversations")
        .doc(familyPhone)
        .collection("messages")
        .where("role", "==", "user")
        .where("timestamp", ">=", new Date(sentAt).getTime())
        .limit(1)
        .get();
    if (!replied.empty) {
        // Family responded — no escalation needed
        await alertSnap.ref.update({ escalated: false, familyReplied: true });
        return;
    }
    // Family has not responded — find emergency contact
    const seniorSnap = await db.collection("senior_profiles").doc(seniorId).get();
    const senior = seniorSnap.exists ? seniorSnap.data() : {};
    const ecPhone = (_a = senior.emergencyContact) === null || _a === void 0 ? void 0 : _a.phone;
    const seniorName = ((_b = senior.name) !== null && _b !== void 0 ? _b : "your loved one");
    const signals = (_c = alert.signals) !== null && _c !== void 0 ? _c : [];
    if (ecPhone && ecPhone !== familyPhone) {
        await (0, client_1.sendToPhone)(ecPhone, `Hi — this is Cara, the AI care assistant for ${seniorName}.\n\n` +
            `There were some health concerns noted in a recent care visit (${signals.slice(0, 2).join(", ")}) ` +
            `and the primary contact hasn't responded in 24 hours.\n\n` +
            `Please reach out to them or contact the care team directly.`);
    }
    // Also flag for admin
    await db.collection("admin_alerts").add({
        type: "health_alert_unacknowledged",
        seniorId,
        phone: familyPhone,
        signals,
        sentAt,
        createdAt: new Date().toISOString(),
        resolved: false,
        priority: "high",
    });
    await alertSnap.ref.update({ escalated: true, escalatedAt: new Date().toISOString() });
    console.log(`[escalateHealthAlert] Escalated health alert for senior ${seniorId}`);
}
// ── Fire user-defined recurring reminders ────────────────────────────────────
async function evaluateUserTriggers() {
    const now = new Date().toISOString();
    const snap = await db.collection("user_triggers")
        .where("active", "==", true)
        .where("nextFireAt", "<=", now)
        .get();
    if (snap.empty)
        return;
    const { calculateNextFireAt } = await Promise.resolve().then(() => __importStar(require("./userTriggerManager")));
    for (const doc of snap.docs) {
        const t = doc.data();
        try {
            await (0, caraAgent_1.sendViaInteractionAgent)(t.phone, {
                content: t.message,
                urgency: "standard",
                sourceAgent: "user_trigger",
                canDrop: false,
            });
            if (t.recurrence === "once") {
                await doc.ref.update({ active: false, firedAt: now });
            }
            else {
                const next = calculateNextFireAt(t.recurrence, t.dayOfWeek, t.hour, t.minute);
                await doc.ref.update({ nextFireAt: next, lastFiredAt: now });
            }
        }
        catch (err) {
            console.error(`[evaluateUserTriggers] Failed for trigger ${doc.id}:`, err);
        }
    }
}
// ── Auto-book best replacement when the 30-min family response window expires ──
async function autoBookBestReplacement(taskId, task) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const options = (_a = task.options) !== null && _a !== void 0 ? _a : [];
    const option = options[0];
    if (!option) {
        // No candidates were found at the time — notify family
        const { handleNoReplacementsFound } = await Promise.resolve().then(() => __importStar(require("../agents/replacementAgent")));
        const apptSnap = await db.collection("appointments").doc(task.appointmentId).get();
        const appt = (_b = apptSnap.data()) !== null && _b !== void 0 ? _b : {};
        await handleNoReplacementsFound(task.appointmentId, task.clientId, task.clientPhone, { caregiverName: (_c = appt.caregiverName) !== null && _c !== void 0 ? _c : "Your caregiver", date: (_d = appt.date) !== null && _d !== void 0 ? _d : "", time: (_e = appt.time) !== null && _e !== void 0 ? _e : "" });
        await db.collection("agent_tasks").doc(taskId).update({ status: "no_options_available" });
        return;
    }
    // Update appointment with replacement caregiver
    await db.collection("appointments").doc(task.appointmentId).update({
        caregiverId: option.caregiverId,
        caregiverName: option.name,
        status: "confirmed",
        autoBooked: true,
        bookedAt: new Date().toISOString(),
    });
    // Mark task complete
    await db.collection("agent_tasks").doc(taskId).update({
        status: "auto_booked",
        bookedAt: new Date().toISOString(),
        bookedOption: option,
    });
    // Notify family
    const apptSnap = await db.collection("appointments").doc(task.appointmentId).get();
    const appt = (_f = apptSnap.data()) !== null && _f !== void 0 ? _f : {};
    await (0, caraAgent_1.sendViaInteractionAgent)(task.clientPhone, {
        content: `You didn't respond, so I went ahead and booked ${option.name} ` +
            `for your ${(_g = appt.time) !== null && _g !== void 0 ? _g : ""} visit today — they're confirmed. ` +
            `Reply CANCEL if you need to change this.`,
        urgency: "immediate",
        sourceAgent: "emergency_replacement",
        canDrop: false,
    });
    // Clear the active task roster entry — replacement is resolved
    await db.collection("agent_tasks_active").doc(task.clientPhone).delete().catch(() => { });
    // Post-crisis emotional anchoring
    await new Promise(r => setTimeout(r, 3000));
    await (0, caraAgent_1.sendViaInteractionAgent)(task.clientPhone, {
        content: `Last-minute coverage is one of the hardest parts of care. That's exactly what I'm here for. 💙`,
        urgency: "standard",
        sourceAgent: "emergency_replacement",
        canDrop: true,
    });
    // Notify the replacement caregiver
    const cgSnap = await db.collection("caregivers").doc(option.caregiverId).get();
    const cgPhone = (_h = cgSnap.data()) === null || _h === void 0 ? void 0 : _h.phone;
    if (cgPhone) {
        await (0, client_1.sendToPhone)(cgPhone, `You've been assigned to cover a visit today.\n\n` +
            `${(_j = appt.date) !== null && _j !== void 0 ? _j : ""} at ${(_k = appt.time) !== null && _k !== void 0 ? _k : ""}\n` +
            (appt.clientName ? `${appt.clientName}\n` : "") +
            (appt.address ? `${appt.address}` : ""));
    }
    console.log(`[autoBookBestReplacement] Auto-booked ${option.caregiverId} for task ${taskId}`);
}
// ── Clear expired session state machine flags ─────────────────────────────────
async function clearExpiredSessionStates() {
    const now = new Date().toISOString();
    const { STATE_MACHINE_FLAGS, clearAllStateFlags } = await Promise.resolve().then(() => __importStar(require("../utils/sessionState")));
    const snap = await db.collection("agent_sessions")
        .where("stateExpiresAt", "<=", now)
        .get();
    if (snap.empty)
        return;
    for (const doc of snap.docs) {
        const session = doc.data();
        const hasFlag = STATE_MACHINE_FLAGS.some(f => session[f] !== undefined && session[f] !== false);
        if (!hasFlag)
            continue;
        try {
            await clearAllStateFlags(doc.id, db);
            console.log(`[clearExpiredSessionStates] Cleared flags for ${doc.id}`);
        }
        catch (err) {
            console.error(`[clearExpiredSessionStates] Failed for ${doc.id}:`, err);
        }
    }
}
// ── Caregiver check-in 2h before visit ───────────────────────────────────────
async function handleCaregiverCheckin(appointmentId, caregiverPhone) {
    var _a, _b, _c, _d, _e;
    const apptSnap = await db.collection("appointments").doc(appointmentId).get();
    if (!apptSnap.exists)
        return;
    const appt = apptSnap.data();
    // Skip if already arrived or cancelled
    if (["cancelled", "cancelled_by_client", "completed"].includes((_a = appt.status) !== null && _a !== void 0 ? _a : ""))
        return;
    if (appt.arrivedAt)
        return;
    const seniorName = (_c = (_b = appt.clientName) !== null && _b !== void 0 ? _b : appt.seniorName) !== null && _c !== void 0 ? _c : "your client";
    const startTime = (_d = appt.startTime) !== null && _d !== void 0 ? _d : "";
    await (0, client_1.sendToPhone)(caregiverPhone, `Hey — are you confirmed for today's visit with ${seniorName} at ${startTime}?\n\nReply CONFIRM if you're good to go, or LATE if you're running behind.`);
    await db.collection("appointments").doc(appointmentId).update({
        caregiverCheckInSent: true,
        caregiverCheckInSentAt: new Date().toISOString(),
    });
    // Schedule escalation in 30 min if no response
    await db.collection("proactive_triggers").add({
        userId: (_e = appt.caregiverId) !== null && _e !== void 0 ? _e : "",
        phone: caregiverPhone,
        type: "caregiver_checkin_escalation",
        scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        message: `caregiver_checkin_escalation:${appointmentId}`,
        createdAt: new Date().toISOString(),
    });
}
// ── Caregiver check-in escalation — warn family if no confirm/arrival ─────────
async function handleCaregiverCheckinEscalation(appointmentId) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const apptSnap = await db.collection("appointments").doc(appointmentId).get();
    if (!apptSnap.exists)
        return;
    const appt = apptSnap.data();
    // If caregiver confirmed or arrived — nothing to do
    if (appt.arrivedAt || appt.caregiverCheckInConfirmed)
        return;
    if (["cancelled", "cancelled_by_client", "completed"].includes((_a = appt.status) !== null && _a !== void 0 ? _a : ""))
        return;
    const seniorName = (_c = (_b = appt.clientName) !== null && _b !== void 0 ? _b : appt.seniorName) !== null && _c !== void 0 ? _c : "your client";
    const startTime = (_d = appt.startTime) !== null && _d !== void 0 ? _d : "";
    const caregiverName = (_e = appt.caregiverName) !== null && _e !== void 0 ? _e : "Your caregiver";
    // Warn family
    const clientSnap = await db.collection("users").doc((_f = appt.clientId) !== null && _f !== void 0 ? _f : "").get();
    const clientPhone = (_g = clientSnap.data()) === null || _g === void 0 ? void 0 : _g.phone;
    if (clientPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
            content: `Heads-up — ${caregiverName} hasn't confirmed today's visit at ${startTime} with ${seniorName}. ` +
                `I'm following up with them now. I'll let you know as soon as I hear back.`,
            urgency: "immediate",
            sourceAgent: "caregiver_checkin",
            canDrop: false,
        });
    }
    // Urgent re-ping caregiver
    const cgSnap = await db.collection("caregivers").doc((_h = appt.caregiverId) !== null && _h !== void 0 ? _h : "").get();
    const cgPhone = (_j = cgSnap.data()) === null || _j === void 0 ? void 0 : _j.phone;
    if (cgPhone) {
        await (0, client_1.sendToPhone)(cgPhone, `URGENT: We haven't heard back about your visit with ${seniorName} at ${startTime} today. ` +
            `Please reply CONFIRM now or call us immediately.`);
    }
    // Admin alert
    await db.collection("admin_alerts").add({
        type: "caregiver_unresponsive_checkin",
        appointmentId,
        caregiverId: (_k = appt.caregiverId) !== null && _k !== void 0 ? _k : "",
        caregiverName,
        clientId: (_l = appt.clientId) !== null && _l !== void 0 ? _l : "",
        seniorName,
        startTime,
        createdAt: new Date().toISOString(),
        resolved: false,
        priority: "high",
    });
    console.log(`[handleCaregiverCheckinEscalation] Escalated check-in for appointment ${appointmentId}`);
}
//# sourceMappingURL=triggerEngine.js.map