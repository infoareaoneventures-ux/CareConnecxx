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
exports.onJournalCreated = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client_1 = require("../linq/client");
const caraAgent_1 = require("../agents/caraAgent");
const healthSignalDetector_1 = require("../agents/healthSignalDetector");
const voiceSummary_1 = require("../agents/voiceSummary");
const permissionsConversation_1 = require("../agents/permissionsConversation");
const zepClient_1 = require("../memory/zepClient");
const triggerEngine_1 = require("./triggerEngine");
const feedback_1 = require("../ai/feedback");
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
async function generateVisitSummary(caregiverName, seniorName, notes, wellness) {
    var _a, _b;
    try {
        const resp = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 120,
            system: "You write one-to-two sentence visit summaries for families receiving care updates via text.\n" +
                "Tone: warm, specific, direct — like a trusted care coordinator. No bullet points, no headers.\n" +
                "Lead with what the senior did or felt. Include one concrete detail from the notes.\n" +
                "End with one brief observation worth watching if anything stands out (optional).\n" +
                "Never mention the caregiver's name in the observation — only in the lead.\n" +
                "Output the summary only. No preamble.",
            messages: [{
                    role: "user",
                    content: `Caregiver: ${caregiverName}\n` +
                        `Senior: ${seniorName !== null && seniorName !== void 0 ? seniorName : "the senior"}\n` +
                        `Notes: ${notes.slice(0, 400)}\n` +
                        `Wellness: ate_well=${wellness.ateWell}, meds_taken=${wellness.tookMeds}, mood=${(_a = wellness.mood) !== null && _a !== void 0 ? _a : "unknown"}`,
                }],
        });
        const text = ((_b = resp.content[0].text) !== null && _b !== void 0 ? _b : "").trim();
        return text || null;
    }
    catch (_c) {
        return null;
    }
}
const db = admin.firestore();
exports.onJournalCreated = functions.firestore
    .document("care_journal/{journalId}")
    .onCreate(async (snap) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    try {
        const journal = snap.data();
        const { seniorId, caregiverId, notes, photos, wellness, activities, timestamp } = journal;
        if (!seniorId)
            return;
        // seniorId === clientId for single-senior households
        const clientDoc = await db.collection("users").doc(seniorId).get();
        const phone = (_a = clientDoc.data()) === null || _a === void 0 ? void 0 : _a.phone;
        if (!phone)
            return;
        const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
        if (!sessionSnap.exists) {
            // No session yet — send transactional message via get-or-create
            const { summary } = await (0, healthSignalDetector_1.detectHealthSignals)(notes !== null && notes !== void 0 ? notes : "", wellness !== null && wellness !== void 0 ? wellness : {}, activities !== null && activities !== void 0 ? activities : []);
            await (0, client_1.sendToPhone)(phone, summary);
            return;
        }
        const session = sessionSnap.data();
        if (session.optedOut || session.optedIn === false)
            return;
        // Check permission before sending health alerts
        const perms = await (0, permissionsConversation_1.getPermissions)((_b = session.userId) !== null && _b !== void 0 ? _b : seniorId).catch(() => null);
        if (perms !== null && perms.canSendHealthAlerts === false)
            return;
        // Run health signal detection
        const { signals, severity, summary } = await (0, healthSignalDetector_1.detectHealthSignals)(notes !== null && notes !== void 0 ? notes : "", wellness !== null && wellness !== void 0 ? wellness : {}, activities !== null && activities !== void 0 ? activities : []);
        const nowIso = new Date().toISOString();
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        // Save signals and check for duplicates + trends
        if (signals.length > 0) {
            for (const signalType of signals) {
                // De-dup: skip if same signal was already sent in past 24h
                const recentAlert = await db.collection("agent_alerts_log")
                    .where("seniorId", "==", seniorId)
                    .where("signalType", "==", signalType)
                    .where("sentAt", ">=", oneDayAgo)
                    .limit(1)
                    .get();
                if (!recentAlert.empty)
                    continue;
                // Log this signal
                const sigRef = await db.collection("health_signals").add({
                    seniorId,
                    signalType,
                    severity,
                    journalEntryId: snap.id,
                    detectedAt: nowIso,
                    trendAlertSent: false,
                });
                // Trend check: 3+ of same signal in the past 7 days → escalate
                const recentSignals = await db.collection("health_signals")
                    .where("seniorId", "==", seniorId)
                    .where("signalType", "==", signalType)
                    .where("detectedAt", ">=", sevenDaysAgo)
                    .orderBy("detectedAt", "desc")
                    .get();
                if (recentSignals.size >= 3 && !recentSignals.docs[0].data().trendAlertSent) {
                    const seniorDoc = await db.collection("users").doc(seniorId).get();
                    const seniorName = ((_f = (_d = (_c = seniorDoc.data()) === null || _c === void 0 ? void 0 : _c.seniorName) !== null && _d !== void 0 ? _d : (_e = seniorDoc.data()) === null || _e === void 0 ? void 0 : _e.displayName) !== null && _f !== void 0 ? _f : "your loved one");
                    await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                        content: `Heads up — I've noticed "${signalType}" has come up ${recentSignals.size} times this week for ${seniorName}.\n\n` +
                            `This might be worth a conversation with their doctor or care team. 💙`,
                        urgency: "standard",
                        sourceAgent: "health_watch",
                        canDrop: true,
                    });
                    await sigRef.update({ trendAlertSent: true });
                    await db.collection("agent_alerts_log").add({
                        type: "health_trend",
                        seniorId,
                        clientId: seniorId,
                        phone,
                        signalType,
                        count: recentSignals.size,
                        sentAt: nowIso,
                    });
                }
            }
            await db.collection("health_signals").add({
                seniorId,
                signals,
                severity,
                journalEntryId: snap.id,
                detectedAt: nowIso,
            });
        }
        // Lookup caregiver name
        const caregiverDoc = await db.collection("caregivers").doc(caregiverId).get();
        const caregiverName = (_h = (_g = caregiverDoc.data()) === null || _g === void 0 ? void 0 : _g.name) !== null && _h !== void 0 ? _h : "Your caregiver";
        const visitDate = (_j = timestamp === null || timestamp === void 0 ? void 0 : timestamp.slice(0, 10)) !== null && _j !== void 0 ? _j : "today";
        const seniorName = ((_o = (_l = (_k = clientDoc.data()) === null || _k === void 0 ? void 0 : _k.seniorName) !== null && _l !== void 0 ? _l : (_m = clientDoc.data()) === null || _m === void 0 ? void 0 : _m.displayName) !== null && _o !== void 0 ? _o : null);
        const opening = seniorName
            ? `${caregiverName} just finished up with ${seniorName}.`
            : `${caregiverName} just finished up.`;
        let baseMessage;
        if (severity === "flag" || severity === "watch") {
            // Health signal path: use the detected signal summary
            baseMessage = `${opening} ${summary}`.trim();
        }
        else if (notes && notes.length > 50) {
            // Rich notes available: ask Claude to generate a warm, specific summary
            const aiSummary = await generateVisitSummary(caregiverName, seniorName, notes, wellness);
            baseMessage = aiSummary !== null && aiSummary !== void 0 ? aiSummary : `${opening} ${summary || "Visit went smoothly."}`.trim();
        }
        else {
            // Fallback: boolean wellness template
            const goods = [];
            if (wellness === null || wellness === void 0 ? void 0 : wellness.ateWell)
                goods.push("ate well");
            if (wellness === null || wellness === void 0 ? void 0 : wellness.tookMeds)
                goods.push("took their medication");
            const mood = wellness === null || wellness === void 0 ? void 0 : wellness.mood;
            if (mood === "happy" || mood === "positive")
                goods.push("was in good spirits");
            const observation = goods.length > 0
                ? `They ${goods.join(" and ")} today.`
                : (summary || "Visit went smoothly.");
            baseMessage = `${opening} ${observation}`.trim();
        }
        // Send photo inline if available (renders natively in iMessage)
        if ((photos === null || photos === void 0 ? void 0 : photos.length) > 0) {
            // Structured message — send directly (supervisor handles text part separately)
            await (0, client_1.sendMessage)(session.chatId, {
                parts: [
                    { type: "text", value: baseMessage },
                    { type: "media", url: photos[0] },
                ],
            });
        }
        else {
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: baseMessage,
                urgency: "standard",
                sourceAgent: "visit_summary",
                canDrop: true,
            });
        }
        // Follow-up for flagged health signals
        if (severity === "flag" && signals.length > 0) {
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: `Worth keeping an eye on. If you notice the same thing at the next visit, it might be worth mentioning to their doctor.`,
                urgency: "standard",
                sourceAgent: "health_watch",
                canDrop: true,
            });
            // Schedule 24h escalation to emergency contact if family doesn't acknowledge
            const alertLogRef = await db.collection("health_alerts_pending").add({
                seniorId,
                phone,
                signals,
                severity,
                sentAt: nowIso,
                escalated: false,
            });
            // Write directly to proactive_triggers to bypass calibration gating
            await db.collection("proactive_triggers").add({
                userId: seniorId,
                phone,
                type: "custom",
                scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                message: `health_escalation:${seniorId}:${alertLogRef.id}`,
                createdAt: nowIso,
            });
            // Write mild negative signal — health concern during this visit
            if (caregiverId && seniorId) {
                (0, feedback_1.writeFeedbackSignal)({
                    clientId: seniorId,
                    caregiverId,
                    signal: -1,
                    source: "health_signal",
                    appointmentId: snap.id,
                }).catch((err) => console.error("writeFeedbackSignal health_signal error:", err));
            }
        }
        // Schedule post-visit feedback ask 30 minutes after summary
        if (caregiverId && seniorId) {
            (0, triggerEngine_1.scheduleTrigger)({
                userId: seniorId,
                phone,
                type: "post_visit_feedback",
                message: `How did today's visit go with ${caregiverName}?\n\n` +
                    `👍 great — or just tell me if anything felt off.`,
                scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                metadata: {
                    caregiverId,
                    clientId: seniorId,
                    appointmentId: snap.id,
                    visitDate: new Date().toISOString().slice(0, 10),
                },
                urgency: "low",
                canDrop: true,
            }).catch((err) => console.error("scheduleTrigger post_visit_feedback error:", err));
        }
        // Send voice memo on iMessage — family taps play to hear the update
        if (session.service === "iMessage") {
            await (0, voiceSummary_1.sendVoiceSummary)(session.chatId, summary, seniorId).catch((err) => console.error("voiceSummary error (non-critical):", err));
        }
        // Log alert for admin audit trail
        await db.collection("agent_alerts_log").add({
            type: "journal_summary",
            clientId: seniorId,
            seniorId,
            phone,
            severity,
            sentAt: nowIso,
        });
        // Send care journal to Zep so health facts are extracted and dated
        const seniorNameForZep = seniorName !== null && seniorName !== void 0 ? seniorName : "Senior";
        (0, zepClient_1.sendCareJournalToZep)({
            phone,
            seniorName: seniorNameForZep,
            caregiverName,
            date: visitDate,
            mood: wellness === null || wellness === void 0 ? void 0 : wellness.mood,
            ateWell: wellness === null || wellness === void 0 ? void 0 : wellness.ateWell,
            medicationsTaken: wellness === null || wellness === void 0 ? void 0 : wellness.tookMeds,
            healthObservations: signals.length > 0 ? signals : undefined,
            notes: notes,
        }).catch((err) => console.error("sendCareJournalToZep error:", err));
    }
    catch (err) {
        console.error("onJournalCreated error:", err);
    }
});
//# sourceMappingURL=journalCreated.js.map