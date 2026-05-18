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
exports.spawnExecutionAgent = spawnExecutionAgent;
exports.getActiveAgentForUser = getActiveAgentForUser;
exports.runExecutionAgentTurn = runExecutionAgentTurn;
exports.markExecutionAgentComplete = markExecutionAgentComplete;
exports.cleanupStaleExecutionAgents = cleanupStaleExecutionAgents;
exports.updateExecutionAgentContext = updateExecutionAgentContext;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
// ── Spawn a new persistent execution agent ───────────────────────────────────
async function spawnExecutionAgent(params) {
    const now = new Date().toISOString();
    const ref = await db.collection("execution_agents").add({
        type: params.type,
        ownerId: params.ownerId,
        ownerPhone: params.ownerPhone,
        status: "active",
        systemPrompt: params.systemPrompt,
        conversationHistory: [],
        operationalLog: [],
        context: params.context,
        createdAt: now,
        lastActiveAt: now,
    });
    return ref.id;
}
// ── Roster check — find the most recently active agent for a user ─────────────
async function getActiveAgentForUser(ownerPhone, type) {
    var _a;
    let query = db.collection("execution_agents")
        .where("ownerPhone", "==", ownerPhone)
        .where("status", "==", "active");
    if (type)
        query = query.where("type", "==", type);
    const snap = await query.get().catch(() => null);
    if (!snap || snap.empty)
        return null;
    // Sort in memory — avoids requiring a composite Firestore index
    const sorted = snap.docs
        .map(d => (Object.assign({ id: d.id }, d.data())))
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    return (_a = sorted[0]) !== null && _a !== void 0 ? _a : null;
}
// ── Run one turn — appends to conversation history + operational log ──────────
async function runExecutionAgentTurn(agentId, input) {
    var _a;
    const agentRef = db.collection("execution_agents").doc(agentId);
    const agentSnap = await agentRef.get();
    if (!agentSnap.exists)
        throw new Error(`execution_agents/${agentId} not found`);
    const agent = agentSnap.data();
    if (agent.status !== "active")
        return "";
    const history = [
        ...((_a = agent.conversationHistory) !== null && _a !== void 0 ? _a : []),
        { role: "user", content: input },
    ];
    const response = await getClaude().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: agent.systemPrompt,
        messages: history,
    });
    const replyText = response.content
        .filter((b) => b.type === "text")
        .map(b => b.text)
        .join("").trim();
    const now = new Date().toISOString();
    const updatedHistory = [
        ...history,
        { role: "assistant", content: replyText },
    ];
    await agentRef.update({
        conversationHistory: updatedHistory,
        operationalLog: admin.firestore.FieldValue.arrayUnion({
            timestamp: now,
            action: "turn",
            result: replyText.slice(0, 120),
        }),
        lastActiveAt: now,
    });
    return replyText;
}
// ── Mark agent as done ────────────────────────────────────────────────────────
async function markExecutionAgentComplete(agentId) {
    await db.collection("execution_agents").doc(agentId).update({
        status: "completed",
        completedAt: new Date().toISOString(),
    }).catch(() => { });
}
// ── Auto-expire stale agents (called nightly) ─────────────────────────────────
async function cleanupStaleExecutionAgents() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const snap = await db.collection("execution_agents")
        .where("status", "==", "active")
        .where("lastActiveAt", "<", cutoff)
        .get();
    if (snap.empty)
        return;
    const now = new Date().toISOString();
    for (const doc of snap.docs) {
        await doc.ref.update({ status: "completed", completedAt: now })
            .catch((err) => console.error(`[cleanupStaleExecutionAgents] ${doc.id}:`, err));
    }
    console.log(`[cleanupStaleExecutionAgents] Completed ${snap.size} stale agent(s)`);
}
// ── Update agent context (e.g. when match results change) ────────────────────
async function updateExecutionAgentContext(agentId, context, systemPrompt, clearHistory = false) {
    const update = {
        context,
        lastActiveAt: new Date().toISOString(),
    };
    if (systemPrompt)
        update.systemPrompt = systemPrompt;
    if (clearHistory)
        update.conversationHistory = [];
    await db.collection("execution_agents").doc(agentId).update(update);
}
//# sourceMappingURL=executionAgent.js.map