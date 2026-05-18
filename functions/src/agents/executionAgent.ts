import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";

const db = admin.firestore();

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

export type ExecutionAgentType = "matching" | "emergency_replacement" | "care_research";

export interface ExecutionAgentDoc {
  id:                  string;
  type:                ExecutionAgentType;
  ownerId:             string;
  ownerPhone:          string;
  status:              "active" | "paused" | "completed" | "failed";
  systemPrompt:        string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  operationalLog:      Array<{ timestamp: string; action: string; result: string }>;
  context:             Record<string, unknown>;
  createdAt:           string;
  lastActiveAt:        string;
  completedAt?:        string;
}

// ── Spawn a new persistent execution agent ───────────────────────────────────

export async function spawnExecutionAgent(params: {
  type:         ExecutionAgentType;
  ownerId:      string;
  ownerPhone:   string;
  systemPrompt: string;
  context:      Record<string, unknown>;
}): Promise<string> {
  const now = new Date().toISOString();
  const ref = await db.collection("execution_agents").add({
    type:                params.type,
    ownerId:             params.ownerId,
    ownerPhone:          params.ownerPhone,
    status:              "active",
    systemPrompt:        params.systemPrompt,
    conversationHistory: [],
    operationalLog:      [],
    context:             params.context,
    createdAt:           now,
    lastActiveAt:        now,
  });
  return ref.id;
}

// ── Roster check — find the most recently active agent for a user ─────────────

export async function getActiveAgentForUser(
  ownerPhone: string,
  type?: ExecutionAgentType
): Promise<(ExecutionAgentDoc & { id: string }) | null> {
  let query: admin.firestore.Query = db.collection("execution_agents")
    .where("ownerPhone", "==", ownerPhone)
    .where("status",     "==", "active");

  if (type) query = query.where("type", "==", type);

  const snap = await query.get().catch(() => null);
  if (!snap || snap.empty) return null;

  // Sort in memory — avoids requiring a composite Firestore index
  const sorted = snap.docs
    .map(d => ({ id: d.id, ...(d.data() as ExecutionAgentDoc) }))
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

  return sorted[0] ?? null;
}

// ── Run one turn — appends to conversation history + operational log ──────────

export async function runExecutionAgentTurn(
  agentId: string,
  input:   string
): Promise<string> {
  const agentRef  = db.collection("execution_agents").doc(agentId);
  const agentSnap = await agentRef.get();
  if (!agentSnap.exists) throw new Error(`execution_agents/${agentId} not found`);

  const agent = agentSnap.data() as ExecutionAgentDoc;
  if (agent.status !== "active") return "";

  const history: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(agent.conversationHistory ?? []),
    { role: "user", content: input },
  ];

  const response = await getClaude().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system:     agent.systemPrompt,
    messages:   history,
  });

  const replyText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("").trim();

  const now = new Date().toISOString();
  const updatedHistory = [
    ...history,
    { role: "assistant" as const, content: replyText },
  ];

  await agentRef.update({
    conversationHistory: updatedHistory,
    operationalLog:      admin.firestore.FieldValue.arrayUnion({
      timestamp: now,
      action:    "turn",
      result:    replyText.slice(0, 120),
    }),
    lastActiveAt: now,
  });

  return replyText;
}

// ── Mark agent as done ────────────────────────────────────────────────────────

export async function markExecutionAgentComplete(agentId: string): Promise<void> {
  await db.collection("execution_agents").doc(agentId).update({
    status:      "completed",
    completedAt: new Date().toISOString(),
  }).catch(() => {});
}

// ── Auto-expire stale agents (called nightly) ─────────────────────────────────

export async function cleanupStaleExecutionAgents(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const snap   = await db.collection("execution_agents")
    .where("status",       "==", "active")
    .where("lastActiveAt", "<",  cutoff)
    .get();

  if (snap.empty) return;

  const now = new Date().toISOString();
  for (const doc of snap.docs) {
    await doc.ref.update({ status: "completed", completedAt: now })
      .catch((err) => console.error(`[cleanupStaleExecutionAgents] ${doc.id}:`, err));
  }
  console.log(`[cleanupStaleExecutionAgents] Completed ${snap.size} stale agent(s)`);
}

// ── Update agent context (e.g. when match results change) ────────────────────

export async function updateExecutionAgentContext(
  agentId:             string,
  context:             Record<string, unknown>,
  systemPrompt?:       string,
  clearHistory = false
): Promise<void> {
  const update: Record<string, unknown> = {
    context,
    lastActiveAt: new Date().toISOString(),
  };
  if (systemPrompt)  update.systemPrompt        = systemPrompt;
  if (clearHistory)  update.conversationHistory = [];
  await db.collection("execution_agents").doc(agentId).update(update);
}
