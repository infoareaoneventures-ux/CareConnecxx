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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendViaInteractionAgent = sendViaInteractionAgent;
exports.processEvent = processEvent;
exports.runInteractionAgent = runInteractionAgent;
exports.runExecutionAgent = runExecutionAgent;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client_1 = require("../linq/client");
const matchingAgent_1 = require("./matchingAgent");
const bookingExecutor_1 = require("./bookingExecutor");
const preferences_1 = require("../memory/preferences");
const supervisor_1 = require("../safety/supervisor");
const auditLog_1 = require("../observability/auditLog");
const claudeRetry_1 = require("../utils/claudeRetry");
const intentClassifier_1 = require("./intentClassifier");
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
// Sources that route to the family group thread when groupChatId exists
const GROUP_SOURCE_AGENTS = new Set([
    "visit_summary",
    "health_watch",
    "emergency_replacement",
    "arrival_notification",
    "weekly_digest",
]);
// ── Wait tool — decides whether to send a non-immediate message ───────────────
async function shouldSend(output, phone, prefs, session) {
    var _a;
    if (output.urgency === "immediate")
        return true;
    if (prefs.dndEnabled && (0, preferences_1.isInDND)(prefs))
        return false;
    if (!(0, preferences_1.isActiveHour)(prefs))
        return false;
    const lastSentAt = session.lastMessageSentAt;
    if (lastSentAt) {
        const minutesSinceLast = (Date.now() - new Date(lastSentAt).getTime()) / 60000;
        if (minutesSinceLast < 5 && output.urgency === "low")
            return false;
    }
    // LLM judgment for standard urgency
    if (output.urgency === "standard") {
        try {
            const result = await (0, claudeRetry_1.callClaudeWithRetry)(getClaude(), {
                model: "claude-haiku-4-5-20251001",
                max_tokens: 5,
                system: "You decide if a care update should be sent to a family right now.\n" +
                    "Consider: Is this new info? Is it timely? Would a human coordinator send this now?\n" +
                    "Reply SEND or WAIT — one word only.",
                messages: [{
                        role: "user",
                        content: `Message: "${output.content.slice(0, 200)}"\n` +
                            `Last sent: ${lastSentAt !== null && lastSentAt !== void 0 ? lastSentAt : "never"}\n` +
                            `Current UTC hour: ${new Date().getUTCHours()}`,
                    }],
            }, { timeoutMs: 5000, maxAttempts: 2 });
            return ((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "").trim().toUpperCase() === "SEND";
        }
        catch (_b) {
            console.warn("shouldSend Claude timeout — defaulting to SEND");
            return true; // default open on failure
        }
    }
    return true;
}
// Split long messages at sentence boundaries, keeping each chunk under maxLen
function splitMessage(text, maxLen = 1000) {
    if (text.length <= maxLen)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf(". ", maxLen);
        if (cut < maxLen / 2)
            cut = remaining.lastIndexOf("\n", maxLen);
        if (cut < 0)
            cut = maxLen;
        chunks.push(remaining.slice(0, cut + 1).trim());
        remaining = remaining.slice(cut + 1).trim();
    }
    if (remaining)
        chunks.push(remaining);
    return chunks;
}
// ── sendViaInteractionAgent — the ONLY path for user-facing messages ──────────
async function sendViaInteractionAgent(phone, output) {
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut)
        return;
    // Determine target chat (group thread for group-appropriate sources)
    const useGroup = GROUP_SOURCE_AGENTS.has(output.sourceAgent) && !!session.groupChatId;
    const targetChatId = useGroup ? session.groupChatId : session.chatId;
    const prefs = await (0, preferences_1.getPreferences)(phone);
    // Wait tool judgment — may suppress non-critical messages
    if (output.canDrop) {
        const send = await shouldSend(output, phone, prefs, session);
        if (!send) {
            (0, auditLog_1.logAudit)({
                eventType: "message_sent",
                userId: phone,
                phone,
                data: { suppressed: true, reason: "wait_tool", sourceAgent: output.sourceAgent, preview: output.content.slice(0, 50) },
            }).catch(() => { });
            return;
        }
    }
    // Run through supervisor (which also lints internally)
    const safe = await (0, supervisor_1.supervise)(output.content, { phone }).catch((err) => {
        console.error("caraAgent: supervisor threw, sending message unsupervised", err instanceof Error ? err.message : err);
        return output.content;
    });
    // Send in chunks with 1s delay between
    const chunks = splitMessage(safe);
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0)
            await new Promise(r => setTimeout(r, 1000));
        await (0, client_1.sendMessage)(targetChatId, chunks[i]);
    }
    // Update lastMessageSentAt
    db.collection("agent_sessions").doc(phone)
        .update({ lastMessageSentAt: new Date().toISOString() })
        .catch((err) => console.error("caraAgent: failed to update lastMessageSentAt", err));
    // HIPAA audit log
    (0, auditLog_1.logAudit)({
        eventType: "message_sent",
        userId: phone,
        phone,
        data: { preview: safe.slice(0, 100), urgency: output.urgency, sourceAgent: output.sourceAgent, chatId: targetChatId },
    }).catch((err) => console.error("caraAgent: audit log write failed", err));
}
// ── processEvent — internal natural language event dispatch ───────────────────
async function processEvent(eventType, payload) {
    switch (eventType) {
        case "journal.created":
            await handleJournalEvent(payload);
            break;
        case "appointment.cancelled":
            await handleAppointmentCancelledEvent(payload);
            break;
        case "caregiver.arrived":
            await handleCaregiverArrivedEvent(payload);
            break;
        case "interview.scheduled":
            await handleInterviewScheduledEvent(payload);
            break;
        default:
            console.warn(`processEvent: unknown eventType "${eventType}"`);
    }
}
// ── Event handlers ────────────────────────────────────────────────────────────
async function handleJournalEvent(payload) {
    var _a, _b, _c, _d;
    const { seniorId, caregiverId, journalId } = payload;
    if (!seniorId)
        return;
    const clientDoc = await db.collection("users").doc(seniorId).get();
    const phone = (_a = clientDoc.data()) === null || _a === void 0 ? void 0 : _a.phone;
    if (!phone)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut || session.optedIn === false)
        return;
    // Prefer inline payload fields; fall back to Firestore fetch when only journalId is provided
    let notes = payload.notes;
    let wellness = payload.wellness;
    let activities = payload.activities;
    if (journalId && !notes) {
        const journalSnap = await db.collection("care_journal").doc(journalId).get();
        if (!journalSnap.exists)
            return;
        const j = journalSnap.data();
        notes = j.notes;
        wellness = j.wellness;
        activities = j.activities;
    }
    const { detectHealthSignals } = await Promise.resolve().then(() => __importStar(require("./healthSignalDetector")));
    const signals = await detectHealthSignals(notes !== null && notes !== void 0 ? notes : "", {
        ateWell: wellness === null || wellness === void 0 ? void 0 : wellness.ateWell,
        tookMeds: wellness === null || wellness === void 0 ? void 0 : wellness.tookMeds,
        wasActive: wellness === null || wellness === void 0 ? void 0 : wellness.wasActive,
        mood: wellness === null || wellness === void 0 ? void 0 : wellness.mood,
    }, Array.isArray(activities) ? activities : []).catch(() => null);
    if (!signals || signals.severity === "none")
        return;
    const caregiverSnap = caregiverId
        ? await db.collection("caregivers").doc(caregiverId).get().catch(() => null)
        : null;
    const caregiverName = (_c = (_b = caregiverSnap === null || caregiverSnap === void 0 ? void 0 : caregiverSnap.data()) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : "your caregiver";
    await sendViaInteractionAgent(phone, {
        content: `${caregiverName} noted: ${signals.summary}`,
        urgency: signals.severity === "flag" ? "immediate" : "standard",
        sourceAgent: signals.severity === "flag" ? "health_watch" : "visit_summary",
        canDrop: signals.severity !== "flag",
    });
    if (signals.severity === "flag") {
        db.collection("health_flags").add({
            userId: (_d = session.userId) !== null && _d !== void 0 ? _d : phone,
            seniorId,
            journalId: journalId !== null && journalId !== void 0 ? journalId : null,
            signals: signals.signals,
            summary: signals.summary,
            caregiverId: caregiverId !== null && caregiverId !== void 0 ? caregiverId : null,
            createdAt: new Date().toISOString(),
        }).catch(() => { });
    }
}
async function handleInterviewScheduledEvent(payload) {
    const { clientPhone, caregiverPhone, caregiverName, scheduledAt, interviewUrl } = payload;
    const dateStr = scheduledAt
        ? new Date(scheduledAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
        : "soon";
    if (clientPhone) {
        await sendViaInteractionAgent(clientPhone, {
            content: `Your interview with ${caregiverName !== null && caregiverName !== void 0 ? caregiverName : "a caregiver"} is set for ${dateStr}.` +
                (interviewUrl ? ` Join here: ${interviewUrl}` : ""),
            urgency: "standard",
            sourceAgent: "interview_scheduler",
            canDrop: false,
        });
    }
    if (caregiverPhone) {
        await sendViaInteractionAgent(caregiverPhone, {
            content: `You have a video interview scheduled for ${dateStr}.` +
                (interviewUrl ? ` Join here: ${interviewUrl}` : ""),
            urgency: "standard",
            sourceAgent: "interview_scheduler",
            canDrop: false,
        });
    }
}
async function handleAppointmentCancelledEvent(payload) {
    const { clientPhone, caregiverName, date } = payload;
    if (!clientPhone)
        return;
    await sendViaInteractionAgent(clientPhone, {
        content: `Heads up — ${caregiverName !== null && caregiverName !== void 0 ? caregiverName : "your caregiver"}'s visit on ${date !== null && date !== void 0 ? date : "today"} has been cancelled.\n\n` +
            `Want me to find a replacement? Reply YES and I'll get on it right away.`,
        urgency: "immediate",
        sourceAgent: "appointment_cancelled",
        canDrop: false,
    });
}
async function handleCaregiverArrivedEvent(payload) {
    const { clientPhone, caregiverName } = payload;
    if (!clientPhone)
        return;
    await sendViaInteractionAgent(clientPhone, {
        content: `${caregiverName !== null && caregiverName !== void 0 ? caregiverName : "Your caregiver"} has arrived for today's visit.`,
        urgency: "immediate",
        sourceAgent: "arrival_notification",
        canDrop: false,
    });
}
// ── Interaction Agent — NLU only, reads only ──────────────────────────────────
async function runInteractionAgent(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const norm = text.trim().toUpperCase();
    // Active goal guard — if a booking goal is in progress and user selects 1/2/3,
    // route directly to matching/interview selection without re-doing NLU
    const activeGoal = session.activeGoal;
    if ((activeGoal === null || activeGoal === void 0 ? void 0 : activeGoal.type) === "booking" && /^[123]$/.test(norm)) {
        return {
            type: "matching",
            payload: { clientId: (_a = session.userId) !== null && _a !== void 0 ? _a : phone, phone, chatId },
        };
    }
    // Delegate hire intent → booking execution
    if (norm === "HIRE") {
        const outcome = session.pendingInterviewOutcome;
        if (outcome) {
            return {
                type: "booking",
                payload: {
                    mode: "hire",
                    caregiverName: outcome.caregiverName,
                    caregiverId: outcome.caregiverId,
                    phone,
                    chatId,
                },
            };
        }
    }
    // Delegate YES to pending booking task → execution
    if (norm === "YES" || norm === "Y") {
        const taskSnap = await db
            .collection("agent_tasks")
            .where("clientPhone", "==", phone)
            .where("status", "==", "awaiting_approval")
            .limit(1).get();
        if (!taskSnap.empty) {
            return {
                type: "booking",
                payload: { taskId: taskSnap.docs[0].id, phone, chatId },
            };
        }
    }
    // NLU intent classification — all free-form text routes through Claude
    const intent = await (0, intentClassifier_1.classifyIntent)(text, false);
    if (intent === "FIND_CAREGIVER" || intent === "REBOOK_REQUEST") {
        return {
            type: "matching",
            payload: { clientId: (_b = session.userId) !== null && _b !== void 0 ? _b : phone, phone, chatId },
        };
    }
    if (intent === "CANCEL_REQUEST") {
        return {
            type: "qa",
            payload: {
                text,
                phone,
                chatId,
                userId: (_c = session.userId) !== null && _c !== void 0 ? _c : phone,
                seniorId: (_e = (_d = session.seniorId) !== null && _d !== void 0 ? _d : session.userId) !== null && _e !== void 0 ? _e : phone,
                userType: (_f = session.userType) !== null && _f !== void 0 ? _f : "client",
                caregiverId: session.caregiverId,
            },
        };
    }
    if (intent === "SCHEDULE_REQUEST" || intent === "BOOKING_CONFIRM") {
        return {
            type: "booking",
            payload: { phone, chatId },
        };
    }
    // Default: hand off to QA agent
    return {
        type: "qa",
        payload: {
            text,
            phone,
            chatId,
            userId: (_g = session.userId) !== null && _g !== void 0 ? _g : phone,
            seniorId: (_j = (_h = session.seniorId) !== null && _h !== void 0 ? _h : session.userId) !== null && _j !== void 0 ? _j : phone,
            userType: (_k = session.userType) !== null && _k !== void 0 ? _k : "client",
            caregiverId: session.caregiverId,
        },
    };
}
// ── Execution Agents — write to Firestore, no Claude calls ───────────────────
async function runExecutionAgent(task) {
    switch (task.type) {
        case "booking":
            await bookingAgent(task.payload);
            break;
        case "matching":
            await matchingAgent(task.payload);
            break;
        case "alert":
            await alertAgent(task.payload);
            break;
        case "memory_update":
            await memoryAgent(task.payload);
            break;
        case "wait":
            break;
        case "qa":
            // QA is handled separately in webhooks.ts via runQaAgent
            break;
    }
}
// ── Execution agent implementations ──────────────────────────────────────────
async function bookingAgent(payload) {
    const { taskId, phone } = payload;
    if (taskId) {
        await (0, bookingExecutor_1.executeBookings)(taskId, phone);
    }
    else if (payload.mode === "hire") {
        const { caregiverName, phone: p, chatId: c } = payload;
        await db.collection("agent_sessions").doc(p).update({
            hireMode: caregiverName,
            pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
        });
        await sendViaInteractionAgent(p, {
            content: `Great choice. What date should the first visit be? (e.g. "this Monday" or "June 15")`,
            urgency: "immediate",
            sourceAgent: "booking",
            canDrop: false,
        });
        // Fallback if phone session not found — use chatId directly
        void c; // chatId kept for reference; sendViaInteractionAgent uses session.chatId
    }
}
async function matchingAgent(payload) {
    var _a;
    const { phone, chatId } = payload;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    const session = (_a = sessionSnap.data()) !== null && _a !== void 0 ? _a : {};
    await (0, matchingAgent_1.runMatchingForClient)(phone, chatId, session, session);
}
async function alertAgent(payload) {
    var _a;
    const { phone, message, type, metadata } = payload;
    if (!phone || !message)
        return;
    await sendViaInteractionAgent(phone, {
        content: message,
        urgency: "immediate",
        sourceAgent: (_a = type) !== null && _a !== void 0 ? _a : "agent_alert",
        canDrop: false,
    });
    db.collection("agent_alerts_log").add(Object.assign({ type: type !== null && type !== void 0 ? type : "agent_alert", sentAt: new Date().toISOString() }, (typeof metadata === "object" && metadata !== null ? metadata : {}))).catch(() => { });
}
async function memoryAgent(payload) {
    const { userId, text, phone } = payload;
    if (!userId || !text)
        return;
    const zepUserId = phone ? phone.replace(/\D/g, "") : undefined;
    const { extractAndStoreFacts } = await Promise.resolve().then(() => __importStar(require("../memory/learnedFacts")));
    await extractAndStoreFacts(userId, text, zepUserId).catch(() => { });
}
//# sourceMappingURL=caraAgent.js.map