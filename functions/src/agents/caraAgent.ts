import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { AgentSession, sendMessage } from "../linq/client";
import { runMatchingForClient } from "./matchingAgent";
import { executeBookings } from "./bookingExecutor";
import { getPreferences, isInDND, isActiveHour, CaraPreferences } from "../memory/preferences";
import { supervise } from "../safety/supervisor";
import { logAudit } from "../observability/auditLog";
import { callClaudeWithRetry } from "../utils/claudeRetry";
import { classifyIntent, Intent } from "./intentClassifier";

const db = admin.firestore();

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

// Sources that route to the family group thread when groupChatId exists
const GROUP_SOURCE_AGENTS = new Set([
  "visit_summary",
  "health_watch",
  "emergency_replacement",
  "arrival_notification",
  "weekly_digest",
  "shift_end_family_update",
  "shift_task_family_update",
  "pre_shift_checkin",
  "shift_confirm_family_update",
]);

// ── AgentOutput — returned by execution agents, consumed by Interaction Agent ──

export interface AgentOutput {
  content:     string;
  urgency:     "immediate" | "standard" | "low";
  sourceAgent: string;
  canDrop:     boolean; // if false, always send regardless of DND/recency
}

// ── ExecutionTask — returned by Interaction Agent, consumed by Execution Agent ──

export interface ExecutionTask {
  type:
    | "booking"
    | "matching"
    | "alert"
    | "memory_update"
    | "wait"
    | "qa";
  payload: Record<string, unknown>;
}

// ── Wait tool — decides whether to send a non-immediate message ───────────────

async function shouldSend(
  output: AgentOutput,
  phone:  string,
  prefs:  CaraPreferences,
  session: Record<string, unknown>
): Promise<boolean> {
  if (output.urgency === "immediate") return true;
  if (prefs.dndEnabled && isInDND(prefs)) return false;
  if (!isActiveHour(prefs)) return false;

  const lastSentAt = session.lastMessageSentAt as string | undefined;
  if (lastSentAt) {
    const minutesSinceLast = (Date.now() - new Date(lastSentAt).getTime()) / 60_000;
    if (minutesSinceLast < 5 && output.urgency === "low") return false;
  }

  // LLM judgment for standard urgency
  if (output.urgency === "standard") {
    try {
      const result = await callClaudeWithRetry(getClaude(), {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 5,
        system:
          "You decide if a care update should be sent to a family right now.\n" +
          "Consider: Is this new info? Is it timely? Would a human coordinator send this now?\n" +
          "Reply SEND or WAIT — one word only.",
        messages: [{
          role:    "user",
          content:
            `Message: "${output.content.slice(0, 200)}"\n` +
            `Last sent: ${lastSentAt ?? "never"}\n` +
            `Current UTC hour: ${new Date().getUTCHours()}`,
        }],
      }, { timeoutMs: 5_000, maxAttempts: 2 });
      return ((result.content[0] as { text: string }).text ?? "").trim().toUpperCase() === "SEND";
    } catch {
      console.warn("shouldSend Claude timeout — defaulting to SEND");
      return true; // default open on failure
    }
  }

  return true;
}

// Split long messages at sentence boundaries, keeping each chunk under maxLen
function splitMessage(text: string, maxLen = 1000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf(". ", maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── sendViaInteractionAgent — the ONLY path for user-facing messages ──────────

export async function sendViaInteractionAgent(
  phone:  string,
  output: AgentOutput
): Promise<void> {
  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as AgentSession & Record<string, unknown>;
  if (session.optedOut) return;

  // Determine target chat (group thread for group-appropriate sources)
  const useGroup = GROUP_SOURCE_AGENTS.has(output.sourceAgent) && !!(session as any).groupChatId;
  const targetChatId = useGroup ? (session as any).groupChatId as string : session.chatId;

  const prefs = await getPreferences(phone);

  // Wait tool judgment — may suppress non-critical messages
  if (output.canDrop) {
    const send = await shouldSend(output, phone, prefs, session as Record<string, unknown>);
    if (!send) {
      logAudit({
        eventType: "message_sent",
        userId:    phone,
        phone,
        data: { suppressed: true, reason: "wait_tool", sourceAgent: output.sourceAgent, preview: output.content.slice(0, 50) },
      }).catch(() => {});
      return;
    }
  }

  // Run through supervisor (which also lints internally)
  const safe = await supervise(output.content, { phone }).catch((err) => {
    console.error("caraAgent: supervisor threw, sending message unsupervised", err instanceof Error ? err.message : err);
    return output.content;
  });

  // Send in chunks with 1s delay between
  const chunks = splitMessage(safe);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise<void>(r => setTimeout(r, 1000));
    await sendMessage(targetChatId, chunks[i]);
  }

  // Update lastMessageSentAt
  db.collection("agent_sessions").doc(phone)
    .update({ lastMessageSentAt: new Date().toISOString() })
    .catch((err) => console.error("caraAgent: failed to update lastMessageSentAt", err));

  // HIPAA audit log
  logAudit({
    eventType: "message_sent",
    userId:    phone,
    phone,
    data: { preview: safe.slice(0, 100), urgency: output.urgency, sourceAgent: output.sourceAgent, chatId: targetChatId },
  }).catch((err) => console.error("caraAgent: audit log write failed", err));
}

// ── Interaction Agent — NLU only, reads only ──────────────────────────────────

export async function runInteractionAgent(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<ExecutionTask> {
  const norm = text.trim().toUpperCase();

  // Active goal guard — if a booking goal is in progress and user selects 1/2/3,
  // route directly to matching/interview selection without re-doing NLU
  const activeGoal = (session as any).activeGoal as { type: string } | null | undefined;
  if (activeGoal?.type === "booking" && /^[123]$/.test(norm)) {
    return {
      type: "matching",
      payload: { clientId: session.userId ?? phone, phone, chatId },
    };
  }

  // Delegate hire intent → booking execution
  if (norm === "HIRE") {
    const outcome = (session as any).pendingInterviewOutcome as
      { caregiverName: string; caregiverId: string } | undefined;

    if (outcome) {
      return {
        type: "booking",
        payload: {
          mode:          "hire",
          caregiverName: outcome.caregiverName,
          caregiverId:   outcome.caregiverId,
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
      .where("status",      "==", "awaiting_approval")
      .limit(1).get();

    if (!taskSnap.empty) {
      return {
        type: "booking",
        payload: { taskId: taskSnap.docs[0].id, phone, chatId },
      };
    }
  }

  // NLU intent classification — all free-form text routes through Claude
  const intent: Intent = await classifyIntent(text, false);

  if (intent === "FIND_CAREGIVER" || intent === "REBOOK_REQUEST") {
    return {
      type: "matching",
      payload: { clientId: session.userId ?? phone, phone, chatId },
    };
  }

  if (intent === "CANCEL_REQUEST") {
    return {
      type: "qa",
      payload: {
        text,
        phone,
        chatId,
        userId:      session.userId ?? phone,
        seniorId:    session.seniorId ?? session.userId ?? phone,
        userType:    session.userType ?? "client",
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
      userId:      session.userId ?? phone,
      seniorId:    session.seniorId ?? session.userId ?? phone,
      userType:    session.userType ?? "client",
      caregiverId: session.caregiverId,
    },
  };
}

// ── Execution Agents — write to Firestore, no Claude calls ───────────────────

export async function runExecutionAgent(task: ExecutionTask): Promise<void> {
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

async function bookingAgent(payload: Record<string, unknown>): Promise<void> {
  const { taskId, phone } = payload;

  if (taskId) {
    await executeBookings(taskId as string, phone as string);
  } else if (payload.mode === "hire") {
    const { caregiverName, phone: p, chatId: c } = payload;
    await db.collection("agent_sessions").doc(p as string).update({
      hireMode: caregiverName,
      pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
    });
    await sendViaInteractionAgent(p as string, {
      content:
        `Great choice. What date should the first visit be? (e.g. "this Monday" or "June 15")`,
      urgency:     "immediate",
      sourceAgent: "booking",
      canDrop:     false,
    });
    // Fallback if phone session not found — use chatId directly
    void c; // chatId kept for reference; sendViaInteractionAgent uses session.chatId
  }
}

async function matchingAgent(payload: Record<string, unknown>): Promise<void> {
  const { phone, chatId } = payload;
  const sessionSnap = await db.collection("agent_sessions").doc(phone as string).get();
  const session = sessionSnap.data() ?? {};
  await runMatchingForClient(
    phone as string,
    chatId as string,
    session as Record<string, unknown>,
    session as Record<string, unknown>
  );
}

async function alertAgent(payload: Record<string, unknown>): Promise<void> {
  const { phone, message, type, metadata } = payload;
  if (!phone || !message) return;

  await sendViaInteractionAgent(phone as string, {
    content:     message as string,
    urgency:     "immediate",
    sourceAgent: (type as string) ?? "agent_alert",
    canDrop:     false,
  });

  db.collection("agent_alerts_log").add({
    type:    type ?? "agent_alert",
    sentAt:  new Date().toISOString(),
    ...(typeof metadata === "object" && metadata !== null ? metadata as Record<string, unknown> : {}),
  }).catch(() => {});
}

async function memoryAgent(payload: Record<string, unknown>): Promise<void> {
  const { userId, text, phone } = payload;
  if (!userId || !text) return;

  const zepUserId = phone ? (phone as string).replace(/\D/g, "") : undefined;

  const { extractAndStoreFacts } = await import("../memory/learnedFacts");
  await extractAndStoreFacts(userId as string, text as string, zepUserId).catch(() => {});
}
