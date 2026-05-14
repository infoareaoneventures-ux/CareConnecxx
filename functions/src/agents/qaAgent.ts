import Anthropic from "@anthropic-ai/sdk";
import * as admin from "firebase-admin";
import { startTyping, sendMessage } from "../linq/client";
import { getPreferences, isInDND } from "../memory/preferences";
import { getRelevantFacts } from "../memory/learnedFacts";
import { getZepContext } from "../memory/zepClient";
import { getMemoryContext } from "../memory/memoryFiles";
import { MCP_TOOLS, handleToolCall } from "../mcp/server";

const db = admin.firestore();

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Context loaders ───────────────────────────────────────────────────────────

async function getSeniorProfile(seniorId: string) {
  const snap = await db.collection("seniors").doc(seniorId).get();
  return snap.data() ?? null;
}

async function getRecentJournalEntries(seniorId: string, limit = 3) {
  const snap = await db
    .collection("care_journal")
    .where("seniorId", "==", seniorId)
    .orderBy("timestamp", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data());
}

async function getNextAppointment(userId: string) {
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

async function getAgentPermissions(userId: string) {
  const snap = await db.collection("agent_permissions").doc(userId).get();
  return snap.data() ?? null;
}

async function getCaregiverProfile(caregiverId: string) {
  const snap = await db.collection("caregivers").doc(caregiverId).get();
  return snap.data() ?? null;
}

async function getCaregiverTodayAppointment(caregiverId: string) {
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

async function getConversationHistory(
  phone: string
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const snap = await db
    .collection("agent_conversations")
    .doc(phone)
    .collection("messages")
    .orderBy("timestamp", "desc")
    .limit(10)
    .get();

  return snap.docs
    .map((d) => ({
      role:    d.data().role as "user" | "assistant",
      content: d.data().content as string,
    }))
    .reverse();
}

async function saveConversationTurn(
  phone: string,
  userText: string,
  assistantReply: string
): Promise<void> {
  const col = db.collection("agent_conversations").doc(phone).collection("messages");
  const now = Date.now();
  const batch = db.batch();
  batch.set(col.doc(), { role: "user",      content: userText,       timestamp: now });
  batch.set(col.doc(), { role: "assistant", content: assistantReply, timestamp: now + 1 });
  await batch.commit().catch((err) => console.error("saveConversationTurn error:", err));
}

// ── System prompt builders ────────────────────────────────────────────────────

function buildClientSystemPrompt(
  senior: any,
  journal: any[],
  nextAppt: any | null,
  permissions: any | null,
  learnedFactsText?: string,
  zepContext?: string,
  memoryContext?: string
): string {
  const seniorName = senior?.name ?? "your loved one";
  const needs: string[] = senior?.needs ?? [];

  const journalSummary = journal.length
    ? journal
        .map((e) => {
          const mood    = e.wellness?.mood ?? "unknown";
          const ateWell = e.wellness?.ateWell ? "ate well" : "appetite concerns";
          const meds    = e.wellness?.tookMeds ? "medications taken" : "medications missed";
          const note    = e.notes ? `Notes: ${e.notes.slice(0, 200)}` : "";
          return `- Visit on ${e.timestamp?.slice(0, 10)}: mood ${mood}, ${ateWell}, ${meds}. ${note}`;
        })
        .join("\n")
    : "No recent journal entries.";

  const apptLine = nextAppt
    ? `Next visit: ${nextAppt.date} ${nextAppt.startTime ? `at ${nextAppt.startTime}` : ""} with ${nextAppt.caregiverName ?? "your caregiver"}.`
    : "No upcoming visits currently scheduled.";

  const autoBook = permissions?.canBookAutomatically
    ? "You have permission to book automatically."
    : permissions?.canBookWithConfirmation
    ? "Bookings require family confirmation."
    : "";

  const zepSection = zepContext
    ? `\n${zepContext}\n`
    : memoryContext
    ? `\nWhat Cara knows about this family:\n${memoryContext}\n`
    : "";

  const factsSection = learnedFactsText
    ? `\nWhat I know about this family:\n${learnedFactsText}\n`
    : "";

  return [
    `You are Cara — an AI care assistant texting with a family member caring for ${seniorName}.`,
    `You act; you don't describe what you could do. When you can do something, do it and report back.`,
    ``,
    `Care needs: ${needs.join(", ") || "none recorded"}.`,
    zepSection,
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
    `- For any emergency: "Please call 911 immediately." Do not follow up with conversation.`,
    `- Be warm and direct — like a knowledgeable friend who gets things done, not a customer service bot.`,
    `- Mirror the emotional tone of the person you're talking with. If they're worried, acknowledge it.`,
    `- Sign off with 💙 occasionally. Never use jargon or bullet points in replies.`,
    ``,
    `Eldercare emotional intelligence:`,
    `- Worry first: when they express concern, acknowledge the feeling first, then share data, then offer ONE clear next step.`,
    `- Grief: reflect and sit with them. Never offer platitudes like "they're in a better place" or "at least...".`,
    `- Repetition: if they ask something you've answered before, answer fully every time. Never say "as I mentioned" or "like I said".`,
    `- Health observations: attribute to the caregiver's notes ("Maria noted..." not "${seniorName} may be experiencing...").`,
    `- Never rush to action when emotions are high. Acknowledge before solving.`,
  ].join("\n");
}

function buildCaregiverSystemPrompt(
  caregiver: any,
  todayAppt: any | null,
  zepContext?: string
): string {
  const name = caregiver?.name ?? "there";
  const rate = caregiver?.hourlyRate ?? 22;

  const apptLine = todayAppt
    ? `Today's visit: ${todayAppt.date} at ${todayAppt.startTime ?? "TBD"} for client ${todayAppt.clientId ?? ""}. Address: ${todayAppt.address ?? todayAppt.location ?? "check your schedule"}.`
    : "No visits scheduled for today.";

  const zepSection = zepContext ? `\n${zepContext}\n` : "";

  return [
    `You are Cara — an AI care assistant texting with ${name}, one of our caregivers.`,
    `You act; you don't describe what you could do. When you can do something, do it and report back.`,
    ``,
    apptLine,
    zepSection,
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

async function getPrefetchedContext(phone: string): Promise<{
  seniorProfile:       any;
  recentJournal:       any[];
  nextAppointment:     any | null;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
} | null> {
  const snap = await db.collection("agent_prefetch").doc(phone).get();
  if (!snap.exists) return null;

  const data = snap.data()!;
  if (new Date(data.expiresAt) < new Date()) {
    await snap.ref.delete().catch(() => {});
    return null;
  }

  await snap.ref.delete().catch(() => {});
  return {
    seniorProfile:       data.seniorProfile,
    recentJournal:       data.recentJournal ?? [],
    nextAppointment:     data.nextAppointment ?? null,
    conversationHistory: (data.conversationHistory ?? []).map((m: any) => ({
      role:    m.role as "user" | "assistant",
      content: m.content as string,
    })),
  };
}

// ── Message splitter (≤300 chars per chunk, 1s delay) ────────────────────────

async function sendSplit(chatId: string, text: string): Promise<void> {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 300) {
    const slice  = remaining.slice(0, 300);
    const cut    = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("!\n"), slice.lastIndexOf("?\n"));
    const splitAt = cut > 100 ? cut + 1 : 300;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise<void>((r) => setTimeout(r, 1000));
    await sendMessage(chatId, chunks[i]);
  }
}

// ── Main QA function ──────────────────────────────────────────────────────────

export async function runQaAgent(params: {
  text:          string;
  phone:         string;
  chatId:        string;
  userId:        string;
  seniorId:      string;
  userType?:     "client" | "caregiver";
  caregiverId?:  string;
  zepThreadId?:  string;
}): Promise<string> {
  const { text, phone, chatId, userId, seniorId, userType = "client", caregiverId, zepThreadId } = params;

  // DND check — skip if user has quiet hours enabled
  const prefs = await getPreferences(userId).catch(() => null);
  if (prefs && isInDND(prefs)) {
    // Queue for later — silently return so the webhook doesn't send anything
    return "";
  }

  let systemPrompt: string;
  let history: Array<{ role: "user" | "assistant"; content: string }>;

  if (userType === "caregiver" && caregiverId) {
    const [caregiver, todayAppt, hist, cgZepContext] = await Promise.all([
      getCaregiverProfile(caregiverId),
      getCaregiverTodayAppointment(caregiverId),
      getConversationHistory(phone),
      zepThreadId ? getZepContext(zepThreadId).catch(() => "") : Promise.resolve(""),
    ]);
    systemPrompt = buildCaregiverSystemPrompt(caregiver, todayAppt, cgZepContext || undefined);
    history = hist;
  } else {
    const prefetched = await getPrefetchedContext(phone);

    let senior: any, journal: any[], nextAppt: any | null, permissions: any | null;

    if (prefetched) {
      senior      = prefetched.seniorProfile;
      journal     = prefetched.recentJournal;
      nextAppt    = prefetched.nextAppointment;
      history     = prefetched.conversationHistory;
      permissions = null;
    } else {
      [senior, journal, nextAppt, permissions, history] = await Promise.all([
        getSeniorProfile(seniorId),
        getRecentJournalEntries(seniorId, 3),
        getNextAppointment(userId),
        getAgentPermissions(userId),
        getConversationHistory(phone),
      ]);
    }

    // Load Zep context, memory files, and learned facts in parallel (non-blocking on failure)
    const [zepContext, memoryContext, facts] = await Promise.all([
      zepThreadId ? getZepContext(zepThreadId).catch(() => "") : Promise.resolve(""),
      getMemoryContext(userId).catch(() => ""),
      getRelevantFacts(userId).catch(() => []),
    ]);
    const factsText = facts.length
      ? facts.map((f) => `- ${f.fact} (${f.category})`).join("\n")
      : undefined;

    systemPrompt = buildClientSystemPrompt(
      senior, journal, nextAppt, permissions, factsText,
      zepContext || undefined,
      memoryContext || undefined
    );
  }

  try {
    await startTyping(chatId).catch(() => {});

    // Re-inject persona reminder every 10 turns to prevent voice drift
    const turnCount = Math.floor(history.length / 2);
    if (turnCount > 0 && turnCount % 10 === 0) {
      systemPrompt +=
        "\n\n<system_reminder>You are Cara — warm, direct, specific. " +
        "Text format only: no bullet points, no headers, no em-dashes. " +
        "Keep replies under 300 characters when possible. " +
        "Lead with the human before the data.</system_reminder>";
    }

    // Tool-use loop: Claude can call MCP tools up to 3 times before producing a final reply
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: text },
    ];

    let reply = "";
    for (let iteration = 0; iteration < 3; iteration++) {
      const response = await getClient().messages.create({
        model:       "claude-sonnet-4-6",
        max_tokens:  400,
        system:      systemPrompt,
        tools:       MCP_TOOLS as any,
        tool_choice: { type: "auto" },
        messages,
      });

      if (response.stop_reason === "tool_use") {
        // Execute all tool calls in this turn
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const result = await handleToolCall(block.name, block.input as Record<string, unknown>)
              .catch((err) => ({ error: String(err) }));
            toolResults.push({
              type:        "tool_result",
              tool_use_id: block.id,
              content:     JSON.stringify(result),
            });
          }
        }
        // Append assistant's tool call + our results to message history
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user",      content: toolResults });
      } else {
        // Final text response
        reply = response.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("")
          .trim();
        break;
      }
    }

    if (!reply) reply = "I'll look into that and get back to you shortly. 💙";

    await saveConversationTurn(phone, text, reply);
    await sendSplit(chatId, reply);

    return reply;
  } catch (err) {
    console.error("qaAgent error:", err);
    const errMsg =
      "I'm having a little trouble right now. For urgent questions, contact your caregiver directly " +
      "or reach our support team. For emergencies, call 911.";
    await sendMessage(chatId, errMsg).catch(() => {});
    return errMsg;
  }
}
