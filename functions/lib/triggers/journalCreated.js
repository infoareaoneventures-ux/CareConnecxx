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
exports.onJournalCreated = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const healthSignalDetector_1 = require("../agents/healthSignalDetector");
const voiceSummary_1 = require("../agents/voiceSummary");
const permissionsConversation_1 = require("../agents/permissionsConversation");
const db = admin.firestore();
exports.onJournalCreated = functions.firestore
    .document("care_journal/{journalId}")
    .onCreate(async (snap) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
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
                    await (0, client_1.sendMessage)(session.chatId, `📊 Heads up — I've noticed "${signalType}" has come up ${recentSignals.size} times this week for ${seniorName}.\n\n` +
                        `This might be worth a conversation with their doctor or care team. 💙`);
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
        const baseMessage = `${caregiverName} finished today's visit (${visitDate}).\n${summary}`;
        // Send photo inline if available (renders natively in iMessage)
        if ((photos === null || photos === void 0 ? void 0 : photos.length) > 0) {
            await (0, client_1.sendMessage)(session.chatId, {
                parts: [
                    { type: "text", value: baseMessage },
                    { type: "media", url: photos[0] },
                ],
            });
        }
        else {
            await (0, client_1.sendMessage)(session.chatId, baseMessage);
        }
        // Follow-up for flagged health signals
        if (severity === "flag" && signals.length > 0) {
            await (0, client_1.sendMessage)(session.chatId, `⚠️ Worth noting: ${signals.join(", ")}. Might be worth mentioning to the doctor at the next visit.`);
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
    }
    catch (err) {
        console.error("onJournalCreated error:", err);
    }
});
//# sourceMappingURL=journalCreated.js.map