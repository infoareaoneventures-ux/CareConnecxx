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
exports.runQaAgent = runQaAgent;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
let _client = null;
function getClient() {
    if (!_client) {
        _client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return _client;
}
// ── Context loaders ───────────────────────────────────────────────────────────
async function getSeniorProfile(seniorId) {
    var _a;
    const snap = await db.collection("senior_profiles").doc(seniorId).get();
    return (_a = snap.data()) !== null && _a !== void 0 ? _a : null;
}
async function getRecentJournalEntries(seniorId, limit = 3) {
    const snap = await db
        .collection("care_journal")
        .where("seniorId", "==", seniorId)
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();
    return snap.docs.map((d) => d.data());
}
async function getNextAppointment(userId) {
    const now = new Date().toISOString();
    const snap = await db
        .collection("appointments")
        .where("clientId", "==", userId)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("isoDate", ">=", now)
        .orderBy("isoDate", "asc")
        .limit(1)
        .get();
    return snap.empty ? null : snap.docs[0].data();
}
// ── Conversation memory ───────────────────────────────────────────────────────
async function getConversationHistory(phone) {
    const snap = await db
        .collection("agent_conversations")
        .doc(phone)
        .collection("messages")
        .orderBy("timestamp", "desc")
        .limit(10)
        .get();
    return snap.docs
        .map((d) => ({
        role: d.data().role,
        content: d.data().content,
    }))
        .reverse(); // chronological order for Claude
}
async function saveConversationTurn(phone, userText, assistantReply) {
    const col = db.collection("agent_conversations").doc(phone).collection("messages");
    const now = Date.now();
    const batch = db.batch();
    batch.set(col.doc(), { role: "user", content: userText, timestamp: now });
    batch.set(col.doc(), { role: "assistant", content: assistantReply, timestamp: now + 1 });
    await batch.commit().catch((err) => console.error("saveConversationTurn error:", err));
}
// ── System prompt builder ─────────────────────────────────────────────────────
function buildSystemPrompt(senior, journal, nextAppt) {
    var _a, _b;
    const seniorName = (_a = senior === null || senior === void 0 ? void 0 : senior.name) !== null && _a !== void 0 ? _a : "your loved one";
    const needs = (_b = senior === null || senior === void 0 ? void 0 : senior.needs) !== null && _b !== void 0 ? _b : [];
    const journalSummary = journal.length
        ? journal
            .map((e) => {
            var _a, _b, _c, _d, _e;
            const mood = (_b = (_a = e.wellness) === null || _a === void 0 ? void 0 : _a.mood) !== null && _b !== void 0 ? _b : "unknown";
            const ateWell = ((_c = e.wellness) === null || _c === void 0 ? void 0 : _c.ateWell) ? "ate well" : "appetite concerns";
            const meds = ((_d = e.wellness) === null || _d === void 0 ? void 0 : _d.tookMeds) ? "medications taken" : "medications missed";
            const note = e.notes ? `Notes: ${e.notes.slice(0, 200)}` : "";
            return `- Visit on ${(_e = e.timestamp) === null || _e === void 0 ? void 0 : _e.slice(0, 10)}: mood ${mood}, ${ateWell}, ${meds}. ${note}`;
        })
            .join("\n")
        : "No recent journal entries.";
    const apptLine = nextAppt
        ? `Next scheduled visit: ${nextAppt.date} at ${nextAppt.time} with ${nextAppt.caregiverName}.`
        : "No upcoming visits currently scheduled.";
    return [
        `You are a warm, concise care assistant for CareConnecxx.`,
        `You are answering a family member texting about ${seniorName}.`,
        ``,
        `Care needs: ${needs.join(", ") || "none recorded"}.`,
        ``,
        `Recent care journal:`,
        journalSummary,
        ``,
        apptLine,
        ``,
        `Rules:`,
        `- Answer in 1–2 sentences maximum.`,
        `- Never diagnose or give medical advice.`,
        `- If there's any emergency or urgent concern, say: "Please call 911 immediately."`,
        `- Be warm, human, and reassuring.`,
        `- If you don't know something, say so honestly.`,
    ].join("\n");
}
// ── Prefetch cache — populated by typing indicator handler ───────────────────
async function getPrefetchedContext(phone) {
    var _a, _b, _c;
    const snap = await db.collection("agent_prefetch").doc(phone).get();
    if (!snap.exists)
        return null;
    const data = snap.data();
    if (new Date(data.expiresAt) < new Date()) {
        // Expired — delete and return null so fresh reads happen
        await snap.ref.delete().catch(() => { });
        return null;
    }
    // Use and immediately delete so it won't be reused
    await snap.ref.delete().catch(() => { });
    return {
        seniorProfile: data.seniorProfile,
        recentJournal: (_a = data.recentJournal) !== null && _a !== void 0 ? _a : [],
        nextAppointment: (_b = data.nextAppointment) !== null && _b !== void 0 ? _b : null,
        conversationHistory: ((_c = data.conversationHistory) !== null && _c !== void 0 ? _c : []).map((m) => ({
            role: m.role,
            content: m.content,
        })),
    };
}
// ── Main QA function ──────────────────────────────────────────────────────────
async function runQaAgent(params) {
    var _a;
    const { text, phone, userId, seniorId } = params;
    // Use pre-fetched data if typing indicator fired ahead of this message
    const prefetched = await getPrefetchedContext(phone);
    const [senior, journal, nextAppt, history] = prefetched
        ? [
            prefetched.seniorProfile,
            prefetched.recentJournal,
            prefetched.nextAppointment,
            prefetched.conversationHistory,
        ]
        : await Promise.all([
            getSeniorProfile(seniorId),
            getRecentJournalEntries(seniorId, 3),
            getNextAppointment(userId),
            getConversationHistory(phone),
        ]);
    const systemPrompt = buildSystemPrompt(senior, journal, nextAppt);
    try {
        const response = await getClient().messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 150,
            system: systemPrompt,
            messages: [
                ...history,
                { role: "user", content: text },
            ],
        });
        const reply = ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
        // Persist this exchange for future context
        await saveConversationTurn(phone, text, reply);
        return reply;
    }
    catch (err) {
        console.error("qaAgent error:", err);
        return ("I'm having a little trouble right now. For urgent questions, contact your caregiver directly " +
            "or reach our support team through the CareConnecxx app. For emergencies, call 911.");
    }
}
//# sourceMappingURL=qaAgent.js.map