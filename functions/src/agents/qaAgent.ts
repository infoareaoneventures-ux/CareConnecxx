import Anthropic from "@anthropic-ai/sdk";
import * as admin from "firebase-admin";

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
  const snap = await db.collection("senior_profiles").doc(seniorId).get();
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
    .reverse(); // chronological order for Claude
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

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(
  senior: any,
  journal: any[],
  nextAppt: any | null
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
    // Expired — delete and return null so fresh reads happen
    await snap.ref.delete().catch(() => {});
    return null;
  }

  // Use and immediately delete so it won't be reused
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

// ── Main QA function ──────────────────────────────────────────────────────────

export async function runQaAgent(params: {
  text:     string;
  phone:    string;
  userId:   string;
  seniorId: string;
}): Promise<string> {
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
      model:      "claude-sonnet-4-6",
      max_tokens: 150,
      system:     systemPrompt,
      messages:   [
        ...history,
        { role: "user", content: text },
      ],
    });

    const reply = ((response.content[0] as { text: string }).text ?? "").trim();

    // Persist this exchange for future context
    await saveConversationTurn(phone, text, reply);

    return reply;
  } catch (err) {
    console.error("qaAgent error:", err);
    return (
      "I'm having a little trouble right now. For urgent questions, contact your caregiver directly " +
      "or reach our support team through the CareConnecxx app. For emergencies, call 911."
    );
  }
}
