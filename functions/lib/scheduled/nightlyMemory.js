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
exports.consolidateMemoryNightly = void 0;
exports.analyzeBookingPatterns = analyzeBookingPatterns;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const claudeClient_1 = require("../utils/claudeClient");
const memoryFiles_1 = require("../memory/memoryFiles");
const executionAgent_1 = require("../agents/executionAgent");
const db = admin.firestore();
// ── Conversation compression ──────────────────────────────────────────────────
async function compressConversationForPhone(phone) {
    var _a, _b;
    const col = db.collection("agent_conversations").doc(phone).collection("messages");
    const allSnap = await col.orderBy("timestamp", "asc").get();
    const summaryDocs = allSnap.docs.filter(d => d.data().role === "summary");
    const realDocs = allSnap.docs.filter(d => d.data().role !== "summary");
    // Compress earlier than the previous threshold (was 30) — qaAgent only loads
    // the 10 most-recent + 1 summary, so turns 11-30 had no fallback. Triggering
    // at 15 means active users get summary continuity within a couple of days.
    if (realDocs.length <= 15)
        return;
    const toCompress = realDocs.slice(0, realDocs.length - 10);
    if (toCompress.length < 5)
        return;
    const existingSummary = (_b = (_a = summaryDocs[0]) === null || _a === void 0 ? void 0 : _a.data()) === null || _b === void 0 ? void 0 : _b.content;
    const newMessages = toCompress
        .map(d => `${d.data().role === "user" ? "User" : "Cara"}: ${d.data().content}`)
        .join("\n");
    const promptParts = existingSummary
        ? [`Existing summary:\n${existingSummary}\n\nNew messages to incorporate:\n${newMessages}`]
        : [`Conversation:\n${newMessages}`];
    const response = await (0, claudeClient_1.getSharedClient)().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: "You are summarizing a caregiving conversation for an AI assistant named Cara. Write 3-5 sentences covering: care needs mentioned, decisions made, key facts about the senior, and emotional context. Be specific — include names, dates, and care details if present. Begin your response with \"<summary>\".",
        messages: [{ role: "user", content: promptParts[0] }],
    });
    const summaryText = response.content[0].text;
    // Delete old summary and compressed messages, write new summary
    const firstRetained = realDocs[realDocs.length - 10];
    const summaryTimestamp = firstRetained.data().timestamp - 1;
    // Firebase batches are capped at 500 ops — chunk deletes if needed
    const toDelete = [...summaryDocs, ...toCompress];
    for (let i = 0; i < toDelete.length; i += 400) {
        const batch = db.batch();
        for (const doc of toDelete.slice(i, i + 400))
            batch.delete(doc.ref);
        if (i === 0)
            batch.set(col.doc(), { role: "summary", content: summaryText, timestamp: summaryTimestamp });
        await batch.commit();
    }
    console.log(`[compressConversation] Compressed ${toCompress.length} messages for ${phone}`);
}
async function compressOldConversations() {
    const convDocs = await db.collection("agent_conversations").listDocuments();
    for (const docRef of convDocs) {
        await compressConversationForPhone(docRef.id).catch(err => console.error(`[compressOldConversations] ${docRef.id}:`, err));
    }
}
// ── Booking pattern analysis ──────────────────────────────────────────────────
async function analyzeBookingPatterns() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Get all clients with completed appointments in the last 30 days
    const apptSnap = await db.collection("appointments")
        .where("status", "==", "completed")
        .where("date", ">=", thirtyDaysAgo)
        .get();
    if (apptSnap.empty)
        return;
    // Group by clientId
    const byClient = {};
    for (const doc of apptSnap.docs) {
        const d = doc.data();
        const clientId = d.clientId;
        if (!clientId || !d.date)
            continue;
        const dayOfWeek = new Date(d.date).getUTCDay();
        if (!byClient[clientId])
            byClient[clientId] = [];
        byClient[clientId].push({ day: dayOfWeek, status: d.status });
    }
    // Also get cancelled appointments in the same window
    const cancelSnap = await db.collection("appointments")
        .where("status", "in", ["cancelled_by_client", "cancelled"])
        .where("date", ">=", thirtyDaysAgo)
        .get();
    for (const doc of cancelSnap.docs) {
        const d = doc.data();
        const clientId = d.clientId;
        if (!clientId || !d.date)
            continue;
        const dayOfWeek = new Date(d.date).getUTCDay();
        if (!byClient[clientId])
            byClient[clientId] = [];
        byClient[clientId].push({ day: dayOfWeek, status: "cancelled" });
    }
    const db2 = admin.firestore();
    const batch = db2.batch();
    for (const [clientId, events] of Object.entries(byClient)) {
        // Count by day
        const dayStats = {};
        for (const e of events) {
            if (!dayStats[e.day])
                dayStats[e.day] = { completed: 0, cancelled: 0 };
            if (e.status === "completed")
                dayStats[e.day].completed++;
            else
                dayStats[e.day].cancelled++;
        }
        for (const [dayStr, stats] of Object.entries(dayStats)) {
            const day = parseInt(dayStr);
            const total = stats.completed + stats.cancelled;
            const cancelRate = total > 0 ? stats.cancelled / total : 0;
            const ref = db2.collection("booking_patterns").doc(clientId).collection("day_patterns").doc(String(day));
            batch.set(ref, { day, completedCount: stats.completed, cancelledCount: stats.cancelled, cancelRate, updatedAt: new Date().toISOString() }, { merge: true });
        }
    }
    await batch.commit().catch(err => console.error("[analyzeBookingPatterns] batch error:", err));
    console.log(`[analyzeBookingPatterns] Updated patterns for ${Object.keys(byClient).length} clients`);
}
// Runs nightly at 10 PM PT (06:00 UTC next day)
exports.consolidateMemoryNightly = functions.pubsub
    .schedule("0 6 * * *")
    .onRun(async () => {
    var _a;
    // Find all active sessions updated in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const snap = await db
        .collection("agent_sessions")
        .where("onboardingStep", "==", "complete")
        .where("optedOut", "==", false)
        .get();
    const users = [];
    for (const doc of snap.docs) {
        const data = doc.data();
        if (data.lastMessageAt && data.lastMessageAt >= sevenDaysAgo) {
            const userId = (_a = data.userId) !== null && _a !== void 0 ? _a : doc.id;
            if (userId)
                users.push({ userId, phone: doc.id });
        }
    }
    console.log(`consolidateMemoryNightly: processing ${users.length} users`);
    for (const { userId, phone } of users) {
        await (0, memoryFiles_1.consolidateMemoryForUser)(userId, phone).catch((err) => console.error(`memory consolidation error for ${userId}:`, err));
    }
    // Analyze booking patterns for proactive suggestions
    await analyzeBookingPatterns().catch(err => console.error("[nightlyMemory] analyzeBookingPatterns error:", err));
    // Compress conversations longer than 30 messages
    await compressOldConversations().catch(err => console.error("[nightlyMemory] compressOldConversations error:", err));
    // Auto-complete execution agents idle for >24 hours
    await (0, executionAgent_1.cleanupStaleExecutionAgents)().catch(err => console.error("[nightlyMemory] cleanupStaleExecutionAgents error:", err));
});
//# sourceMappingURL=nightlyMemory.js.map