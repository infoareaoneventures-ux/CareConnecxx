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
const client_1 = require("../linq/client");
const preferences_1 = require("../memory/preferences");
const learnedFacts_1 = require("../memory/learnedFacts");
const server_1 = require("../mcp/server");
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
    const snap = await db.collection("seniors").doc(seniorId).get();
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
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db
        .collection("appointments")
        .where("clientId", "==", userId)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("date", ">=", today)
        .orderBy("date", "asc")
        .limit(1)
        .get();
    return snap.empty ? null : snap.docs[0].data();
}
async function getAgentPermissions(userId) {
    var _a;
    const snap = await db.collection("agent_permissions").doc(userId).get();
    return (_a = snap.data()) !== null && _a !== void 0 ? _a : null;
}
async function getCaregiverProfile(caregiverId) {
    var _a;
    const snap = await db.collection("caregivers").doc(caregiverId).get();
    return (_a = snap.data()) !== null && _a !== void 0 ? _a : null;
}
async function getCaregiverTodayAppointment(caregiverId) {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db
        .collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", today)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .orderBy("startTime", "asc")
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
        .reverse();
}
async function saveConversationTurn(phone, userText, assistantReply) {
    const col = db.collection("agent_conversations").doc(phone).collection("messages");
    const now = Date.now();
    const batch = db.batch();
    batch.set(col.doc(), { role: "user", content: userText, timestamp: now });
    batch.set(col.doc(), { role: "assistant", content: assistantReply, timestamp: now + 1 });
    await batch.commit().catch((err) => console.error("saveConversationTurn error:", err));
}
// ── System prompt builders ────────────────────────────────────────────────────
function buildClientSystemPrompt(senior, journal, nextAppt, permissions, learnedFactsText) {
    var _a, _b, _c;
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
        ? `Next visit: ${nextAppt.date} ${nextAppt.startTime ? `at ${nextAppt.startTime}` : ""} with ${(_c = nextAppt.caregiverName) !== null && _c !== void 0 ? _c : "your caregiver"}.`
        : "No upcoming visits currently scheduled.";
    const autoBook = (permissions === null || permissions === void 0 ? void 0 : permissions.canBookAutomatically)
        ? "You have permission to book automatically."
        : (permissions === null || permissions === void 0 ? void 0 : permissions.canBookWithConfirmation)
            ? "Bookings require family confirmation."
            : "";
    const factsSection = learnedFactsText
        ? `\nWhat I know about this family:\n${learnedFactsText}\n`
        : "";
    return [
        `You are Cara — an AI care assistant texting with a family member caring for ${seniorName}.`,
        `You act; you don't describe what you could do. When you can do something, do it and report back.`,
        ``,
        `Care needs: ${needs.join(", ") || "none recorded"}.`,
        factsSection,
        `Recent care journal:`,
        journalSummary,
        ``,
        apptLine,
        autoBook ? `\n${autoBook}` : "",
        ``,
        `Rules:`,
        `- Keep answers to 1–3 sentences maximum (you are in an iMessage thread).`,
        `- Never diagnose or give medical advice.`,
        `- For any emergency: "Please call 911 immediately."`,
        `- Be warm and direct — like a knowledgeable friend who gets things done, not a customer service bot.`,
        `- Mirror the emotional tone of the person you're talking with. If they're worried, acknowledge it.`,
        `- Sign off with 💙 occasionally. Never use jargon or bullet points in replies.`,
    ].join("\n");
}
function buildCaregiverSystemPrompt(caregiver, todayAppt) {
    var _a, _b, _c, _d, _e, _f;
    const name = (_a = caregiver === null || caregiver === void 0 ? void 0 : caregiver.name) !== null && _a !== void 0 ? _a : "there";
    const rate = (_b = caregiver === null || caregiver === void 0 ? void 0 : caregiver.hourlyRate) !== null && _b !== void 0 ? _b : 22;
    const apptLine = todayAppt
        ? `Today's visit: ${todayAppt.date} at ${(_c = todayAppt.startTime) !== null && _c !== void 0 ? _c : "TBD"} for client ${(_d = todayAppt.clientId) !== null && _d !== void 0 ? _d : ""}. Address: ${(_f = (_e = todayAppt.address) !== null && _e !== void 0 ? _e : todayAppt.location) !== null && _f !== void 0 ? _f : "check your schedule"}.`
        : "No visits scheduled for today.";
    return [
        `You are Cara — an AI care assistant texting with ${name}, one of our caregivers.`,
        `You act; you don't describe what you could do. When you can do something, do it and report back.`,
        ``,
        apptLine,
        ``,
        `The caregiver earns $${rate}/hr. Payments are processed automatically after each visit.`,
        ``,
        `Rules:`,
        `- Keep answers to 1–3 sentences maximum.`,
        `- Be supportive and practical — they are doing important work.`,
        `- For medical emergencies at a client's home: "Call 911 immediately."`,
        `- Never promise specific payment dates.`,
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
        await snap.ref.delete().catch(() => { });
        return null;
    }
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
// ── Message splitter (≤300 chars per chunk, 1s delay) ────────────────────────
async function sendSplit(chatId, text) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > 300) {
        const slice = remaining.slice(0, 300);
        const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("!\n"), slice.lastIndexOf("?\n"));
        const splitAt = cut > 100 ? cut + 1 : 300;
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining)
        chunks.push(remaining);
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0)
            await new Promise((r) => setTimeout(r, 1000));
        await (0, client_1.sendMessage)(chatId, chunks[i]);
    }
}
// ── Main QA function ──────────────────────────────────────────────────────────
async function runQaAgent(params) {
    const { text, phone, chatId, userId, seniorId, userType = "client", caregiverId } = params;
    // DND check — skip if user has quiet hours enabled
    const prefs = await (0, preferences_1.getPreferences)(userId).catch(() => null);
    if (prefs && (0, preferences_1.isInDND)(prefs)) {
        // Queue for later — silently return so the webhook doesn't send anything
        return "";
    }
    let systemPrompt;
    let history;
    if (userType === "caregiver" && caregiverId) {
        const [caregiver, todayAppt, hist] = await Promise.all([
            getCaregiverProfile(caregiverId),
            getCaregiverTodayAppointment(caregiverId),
            getConversationHistory(phone),
        ]);
        systemPrompt = buildCaregiverSystemPrompt(caregiver, todayAppt);
        history = hist;
    }
    else {
        const prefetched = await getPrefetchedContext(phone);
        let senior, journal, nextAppt, permissions;
        if (prefetched) {
            senior = prefetched.seniorProfile;
            journal = prefetched.recentJournal;
            nextAppt = prefetched.nextAppointment;
            history = prefetched.conversationHistory;
            permissions = null;
        }
        else {
            [senior, journal, nextAppt, permissions, history] = await Promise.all([
                getSeniorProfile(seniorId),
                getRecentJournalEntries(seniorId, 3),
                getNextAppointment(userId),
                getAgentPermissions(userId),
                getConversationHistory(phone),
            ]);
        }
        // Load learned facts for richer context (non-blocking on failure)
        const facts = await (0, learnedFacts_1.getRelevantFacts)(userId).catch(() => []);
        const factsText = facts.length
            ? facts.map((f) => `- ${f.fact} (${f.category})`).join("\n")
            : undefined;
        systemPrompt = buildClientSystemPrompt(senior, journal, nextAppt, permissions, factsText);
    }
    try {
        await (0, client_1.startTyping)(chatId).catch(() => { });
        // Tool-use loop: Claude can call MCP tools up to 3 times before producing a final reply
        const messages = [
            ...history,
            { role: "user", content: text },
        ];
        let reply = "";
        for (let iteration = 0; iteration < 3; iteration++) {
            const response = await getClient().messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 400,
                system: systemPrompt,
                tools: server_1.MCP_TOOLS,
                tool_choice: { type: "auto" },
                messages,
            });
            if (response.stop_reason === "tool_use") {
                // Execute all tool calls in this turn
                const toolResults = [];
                for (const block of response.content) {
                    if (block.type === "tool_use") {
                        const result = await (0, server_1.handleToolCall)(block.name, block.input)
                            .catch((err) => ({ error: String(err) }));
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: JSON.stringify(result),
                        });
                    }
                }
                // Append assistant's tool call + our results to message history
                messages.push({ role: "assistant", content: response.content });
                messages.push({ role: "user", content: toolResults });
            }
            else {
                // Final text response
                reply = response.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text)
                    .join("")
                    .trim();
                break;
            }
        }
        if (!reply)
            reply = "I'll look into that and get back to you shortly. 💙";
        await saveConversationTurn(phone, text, reply);
        await sendSplit(chatId, reply);
        // Extract and store facts from the conversation in the background
        (0, learnedFacts_1.extractAndStoreFacts)(userId, text).catch(() => { });
        return reply;
    }
    catch (err) {
        console.error("qaAgent error:", err);
        const errMsg = "I'm having a little trouble right now. For urgent questions, contact your caregiver directly " +
            "or reach our support team. For emergencies, call 911.";
        await (0, client_1.sendMessage)(chatId, errMsg).catch(() => { });
        return errMsg;
    }
}
//# sourceMappingURL=qaAgent.js.map