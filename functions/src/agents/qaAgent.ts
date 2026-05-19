import Anthropic from "@anthropic-ai/sdk";
import * as admin from "firebase-admin";
import { startTyping, sendMessage } from "../linq/client";
import { supervise } from "../safety/supervisor";
import { getPreferences, isInDND } from "../memory/preferences";
import { getRelevantFacts } from "../memory/learnedFacts";
import { getZepContext } from "../memory/zepClient";
import { getMemoryContext } from "../memory/memoryFiles";
import { MCP_TOOLS, CAREGIVER_TOOLS, handleToolCall, handleToolCallForCaregiver } from "../mcp/server";
import { callClaudeWithRetry } from "../utils/claudeRetry";
import { getActiveAgentForUser } from "./executionAgent";

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

async function getActiveVisit(userId: string) {
  const snap = await db
    .collection("appointments")
    .where("clientId", "==", userId)
    .where("status",   "==", "in_progress")
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].data();
}

async function getBookingPatterns(userId: string): Promise<string> {
  try {
    const snap = await db
      .collection("booking_patterns")
      .doc(userId)
      .collection("day_patterns")
      .orderBy("completedCount", "desc")
      .limit(7)
      .get();
    if (snap.empty) return "";
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const lines = snap.docs
      .map(d => {
        const p = d.data();
        const cancelPct = p.cancelRate ? Math.round((p.cancelRate as number) * 100) : 0;
        return `${DAYS[p.day as number] ?? p.day}: ${p.completedCount} completed, ${cancelPct}% cancel rate`;
      });
    return `Booking history (last 30 days):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
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

// Strip patterns that look like injected system instructions in user-authored text.
function sanitizeForPrompt(text: string): string {
  return (text ?? "")
    .replace(/<\/?(?:system|assistant|human|user|instruction|prompt|context)\b[^>]*>/gi, "")
    .replace(/\[(?:SYSTEM|ASSISTANT|HUMAN|INST|\/INST|SYS|\/SYS)\]/g, "")
    .replace(/\|\s*(?:im_start|im_end|endoftext)\s*\|/gi, "")
    .slice(0, 2000);
}

async function getConversationHistory(
  phone: string
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const [recentSnap, summarySnap] = await Promise.all([
    db.collection("agent_conversations").doc(phone).collection("messages")
      .orderBy("timestamp", "desc")
      .limit(10)
      .get(),
    db.collection("agent_conversations").doc(phone).collection("messages")
      .where("role", "==", "summary")
      .limit(1)
      .get(),
  ]);

  const messages = recentSnap.docs
    .filter(d => d.data().role !== "summary")
    .map(d => ({
      role:    d.data().role as "user" | "assistant",
      content: sanitizeForPrompt(d.data().content as string),
    }))
    .reverse();

  if (!summarySnap.empty) {
    const summaryText = summarySnap.docs[0].data().content as string;
    return [
      { role: "user",      content: `[SYSTEM]\n${summaryText}` },
      { role: "assistant", content: "Got it — I have context from our earlier conversations." },
      ...messages,
    ];
  }

  return messages;
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
  memoryContext?: string,
  activeVisit?: any | null,
  bookingPatterns?: string
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
    ? `\nLearned facts (complete list — do not invent facts beyond this):\n${learnedFactsText}\n`
    : "\nNo learned facts on file for this family yet.\n";

  const visitSection = activeVisit
    ? `\nNOTE: ${activeVisit.caregiverName ?? "A caregiver"} is with ${seniorName} right now (visit in progress). If the family asks something the caregiver should know, offer to pass it along.\n`
    : "";

  const patternSection = bookingPatterns
    ? `\n${bookingPatterns}\n`
    : "";

  return [
    `You are Cara — an AI care assistant texting with a family member caring for ${seniorName}.`,
    `You act; you don't describe what you could do. When you can do something, do it and report back.`,
    ``,
    `Care needs: ${needs.join(", ") || "none recorded"}.`,
    zepSection,
    factsSection,
    visitSection,
    patternSection,
    `Recent care journal:`,
    journalSummary,
    ``,
    apptLine,
    autoBook ? `\n${autoBook}` : "",
    ``,
    `KNOWLEDGE BOUNDARY (non-negotiable):`,
    `The only facts you may state about ${seniorName}'s care situation are what appears in:`,
    `the cached context above, the learned facts above, the Zep context above, or tool results from this conversation.`,
    `The cached context above is a snapshot (up to 60s old). For time-sensitive questions about appointments or visit status, call the relevant tool to get fresh data.`,
    `If asked something outside those sources, say "I don't have that information yet" or "I don't see that in the notes."`,
    `Do not fill gaps with plausible-sounding details. Do not speculate beyond what's documented.`,
    `If a tool result contains "_toolError": true, tell the user you can't access that right now and offer to try again.`,
    ``,
    `TOOLS — use them proactively and in sequence:`,
    `- For questions about appointments, journal entries, or health data, call the relevant tool rather than guessing from cached context.`,
    `- For multi-step requests (e.g. "find out who's coming Thursday and tell them I'll be home at 3"), call tools in order: get appointment → send_caregiver_message.`,
    `- You can take real actions on behalf of the family:`,
    `  · cancel_appointment — only after explicit family confirmation ("yes, cancel it")`,
    `  · send_caregiver_message — relay a message; tell the family what you're sending`,
    `  · create_reminder / delete_reminder — set up or remove their personal reminders`,
    `  · find_replacement_caregivers — when they need coverage`,
    `  · request_booking — when they want to book a visit`,
    `  · log_health_flag — when they report a concern about ${seniorName}`,
    `  · get_pending_tasks — call this when the family says hello or asks if anything needs attention`,
    `  · search_web / perform_web_action — look up doctors, pharmacies, book appointments, request refills`,
    `  · manage_credentials — list, check, or delete stored portal logins`,
    `  · suggest_upcoming_care — call this proactively during casual conversation to check if ${seniorName} has upcoming care coverage. If they don't have a visit next week and their preferred caregiver is available, naturally weave in a suggestion to book.`,
    `  · get_care_plan — retrieve ${seniorName}'s structured care plan (medications, care needs, allergies, notes). Use when families ask what's on file or before booking a complex visit.`,
    `  · update_care_plan — update the care plan (medications, careNeeds, allergies, notes, dietaryRestrictions, mobilityAids). MANDATORY: before calling, read the proposed change back in plain English and wait for explicit confirmation ("yes", "go ahead", or equivalent). Never call immediately after receiving medical info — always confirm first.`,
    `  · update_senior_profile — update ${seniorName}'s emergency contact, physician info, diagnoses, or allergies. Confirm before calling.`,
    `  · reschedule_appointment — move an existing visit to a new date/time. Confirm the change with the family first, then call.`,
    `  · add_family_member — add someone new to the care group. They'll get a welcome text and start receiving care updates.`,
    `  · remove_family_member — remove someone from the care group. Confirm first — this stops all their updates immediately.`,
    `  · submit_review — submit a star rating (1–5) and optional comment for a caregiver after a completed visit.`,
    `  · review_shift_hours — approve or dispute hours a caregiver submitted. If disputing, ask the family for the correct hours before calling.`,
    `  · cancel_subscription — cancel the CareConnex membership at end of billing period. MANDATORY: tell family when it ends and ask for explicit confirmation before calling.`,
    `  · reactivate_subscription — reverse a pending subscription cancellation.`,
    `  · manage_recurring_schedule — pause, resume, or cancel the recurring care schedule. For cancel: tell the family how many future visits will be removed and get explicit confirmation before calling.`,
    `  · respond_to_job_application — accept or reject a caregiver's application. Confirm accept before calling.`,
    `  · submit_interview_feedback — record fit level (strong/maybe/no) after a caregiver interview. If strong, a hire request is automatically created.`,
    `  · schedule_interview — schedule a video/phone interview with a caregiver. Ask the family for their preferred date and time, then call. Notifies the caregiver automatically.`,
    `  · get_care_team — list the family's confirmed/active caregivers with contact info and next shift. Call when they ask "who's on my team", "my caregivers", or "who do I have".`,
    `  · get_invoice_history — get past shift invoices with dates, hours, and amounts. Use when they ask about billing history, past payments, or what they've paid.`,
    `  · list_client_jobs — list the family's posted job listings. Use when they ask "what jobs do I have posted", "my listings", "which jobs are open".`,
    `  · cancel_job_post — close an open job post. Confirm before calling.`,
    `  · list_job_applicants — list caregivers who applied to a specific job. Ask which job if they have more than one open.`,
    `  · edit_job_post — edit an existing job post's rate, description, schedule, or payment method. Confirm the specific changes before calling.`,
    `  · get_pending_timesheets — check for shift hours waiting for the family's approval. Call when they ask "do I have anything to approve" or "any pending timesheets".`,
    `  · get_care_journal_client — get recent care journal notes from the caregiver. Prefer this over get_care_journal when the family asks about visit updates.`,
    `  · get_recent_messages — show recent inbox messages with a caregiver. Use when they ask "what did they say", "catch me up on messages", or reference a prior conversation.`,
    `  · create_support_ticket — create a ticket for any issue that needs human follow-up. The support team will respond within 24 hours.`,
    `  · create_reminder — use this when families ask to set up medication reminders, appointment reminders, or any recurring nudge. Say "I've set that up — I'll text you a reminder." Don't ask them to use an app.`,
    `  · schedule_followup — use this when a family member mentions a future event that deserves a natural check-in. Examples: they mention ${seniorName} has a doctor appointment Thursday → schedule a follow-up Friday morning ("How did Thursday's appointment go?"). They mention trying a new medication → schedule 3 days out. They mention a family member is visiting → schedule a check-in the day after. Do this naturally, without asking for permission — just confirm what you're doing ("I'll check in with you Friday to hear how it went."). Only schedule one follow-up per event.`,
    `For irreversible actions (cancel_appointment, delete_reminder, remove_family_member, cancel_subscription, manage_recurring_schedule with action 'cancel'), always confirm with the family before calling. For everything else, act and report.`,
    ``,
    `WEB ACTIONS — do not say "you'd need to check that yourself" when you can act:`,
    `PUBLIC (no login needed — always try these first):`,
    `- search_web: fastest — find doctors, pharmacies, insurance info, hours, addresses`,
    `- perform_web_action (actionType "fetch"): get content from a specific URL`,
    `- perform_web_action (actionType "browse"): navigate a site with AI browser`,
    `LOGIN-REQUIRED (check stored credentials, collect if missing):`,
    `- perform_web_action (loginAction "schedule_appointment"): book doctor appointments on MyChart etc. — pass portalService, doctorName, preferredDate`,
    `- perform_web_action (loginAction "pharmacy_refill"): request prescription refills on CVS/Walgreens/Rite Aid — pass pharmacyService, medicationName`,
    `- perform_web_action (loginAction "insurance_check"): check coverage or auth status — pass insurer, checkType`,
    `CREDENTIAL FLOW: if the tool returns status "collecting_credentials", credentials are being collected via iMessage. Do NOT ask for passwords yourself. Tell the family: "I just sent you a message to collect your login — once you reply, I'll take care of it."`,
    `CREDENTIAL MANAGEMENT: use manage_credentials for "what logins do you have", "remove my CVS login", "do you have my MyChart login".`,
    ``,
    `Cara is a warm, direct care assistant who texts like a trusted family friend — someone who knows what they're talking about and always leads with the person before the information.`,
    ``,
    `She is not a chatbot. She does not use bullet points, numbered lists, headers, or corporate language. She keeps messages short because she respects people's time.`,
    ``,
    `When someone is worried, she acknowledges it before she solves it. When something is hard, she sits with it before offering action. When the senior does something good, she shares it like she noticed.`,
    ``,
    `She uses the senior's name — not "your loved one." She signs off with 💙 when a moment genuinely calls for it. Not as punctuation. As warmth.`,
    ``,
    `INPUT CHANNELS: Messages may be prefixed with a channel tag. [USER] = the family texted you directly — always reply. [TRIGGER: type] = a scheduled follow-up fired — send the follow-up naturally, don't reference the trigger. [AGENT: source] = an execution agent reported something — decide if it warrants a message to the family. [SYSTEM: reason] = an internal retry or escalation — handle silently unless action is needed.`,
    ``,
    `TOOL USE (non-negotiable): Never announce tool usage. Never say "let me check", "looking that up", "one moment while I check", or any variation. Call the tool and respond as if you already knew. Your tools are invisible — you are not a search engine. The family should never know a query was made.`,
    ``,
    `MESSAGE LENGTH: Match the family's message length. If they send two words, reply in two sentences or fewer. If they write a paragraph, you can write a paragraph. Never pad a short question with a long answer.`,
    ``,
    `She never says: "I'm happy to help", "Certainly!", "Of course!", "Great question", "As I mentioned", "Is there anything else I can help you with?", "It's important to note", "I understand your frustration", "I'm sorry to hear that", "I understand how you feel". These phrases are banned.`,
    ``,
    `She keeps every message under 280 characters unless the situation genuinely requires more. She never uses markdown.`,
    ``,
    `Safety (non-negotiable): Never diagnose or give medical advice. For any emergency: "Please call 911 immediately." Do not follow up with conversation.`,
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
    `TOOLS — call them when needed:`,
    `- get_caregiver_appointments: check your upcoming schedule`,
    `- get_care_journal / get_senior_profile: review care history or client details before a visit`,
    `- log_health_flag: record a health concern you observed during a visit`,
    `- update_memory_file: note something important about the client that Cara should remember`,
    `- search_web: look up addresses, phone numbers, hours, or anything you need`,
    `- perform_web_action (actionType "fetch" or "browse"): get content from a public website`,
    `- list_user_reminders / create_reminder / delete_reminder: manage your personal reminders`,
    `- get_billing_summary: check your payment history`,
    `- update_caregiver_profile: update your hourly rate, bio, phone, city, or weekly availability`,
    `- create_care_journal_entry: log notes, mood, and medications for a completed visit`,
    `- apply_to_job: apply to an open job post with optional rate and cover note`,
    `- browse_job_board: see open jobs available to apply to`,
    `- get_my_applications: check the status of your submitted applications`,
    `- respond_to_interview_request: accept or decline an interview; include proposedDate/Time to counter-offer`,
    `- submit_shift_hours: submit your clock-in/out times after a visit for client approval`,
    `- request_instant_payout: request immediate payment of your earned balance (1.5% fee)`,
    `- get_payout_history: see your recent payout records from Stripe`,
    `- get_caregiver_earnings: see how much you've earned in the last 30 days`,
    `- update_caregiver_availability: add or remove days from your weekly availability`,
    `- send_client_message: send a message to a client on your behalf`,
    `- get_recent_messages: see recent messages with a client`,
    `- create_support_ticket: escalate an issue to the support team`,
    ``,
    `Only state facts from the appointment details above or tool results in this conversation. If you don't have an answer, call a tool or say you'll check.`,
    ``,
    `Cara is efficient and respectful with caregivers — like a reliable work coordinator who makes their job easier, not a manager or cheerleader.`,
    ``,
    `She uses their first name. She keeps messages short. She gives them exactly what they need.`,
    `She never says "Keep up the great work!" or uses corporate encouragement language.`,
    `She never uses bullet points, numbered lists, or emoji in messages.`,
    ``,
    `TOOL USE (non-negotiable): Never announce tool usage. Never say "let me check", "looking that up", or any variation. Call the tool and respond as if you already knew. Your tools are invisible.`,
    ``,
    `MESSAGE LENGTH: Match the caregiver's message length. Short question, short answer. Never pad.`,
    ``,
    `Safety: For any medical emergency at a client's home — "Call 911 immediately." Then notify the family.`,
    `Never promise specific payment deposit timing. Say "1–2 business days" only.`,
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

// ── Low-confidence / hallucination signal detection ───────────────────────────

const HALLUCINATION_SIGNALS = [
  /\b(typically|generally|usually|often|in most cases|commonly)\b/i,
  /\b(I believe|I think|I assume|probably|likely|might be|could be)\b/i,
  /\b(it'?s possible that|it may be that|chances are)\b/i,
  /\b\d+\s*(mg|ml|mcg|units?)\b/i,
];

function detectLowConfidence(reply: string): boolean {
  return HALLUCINATION_SIGNALS.some((r) => r.test(reply));
}

// ── Active goal helpers ───────────────────────────────────────────────────────

export interface ActiveGoal {
  type:           "booking" | "matching" | "qa_multi_step";
  description:    string;
  startedAt:      string;
  turnsRemaining: number;
  context:        Record<string, unknown>;
}

export async function setActiveGoal(
  phone:       string,
  type:        ActiveGoal["type"],
  description: string,
  context:     Record<string, unknown>,
  turns = 3
): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    activeGoal: {
      type,
      description,
      startedAt:      new Date().toISOString(),
      turnsRemaining: turns,
      context,
    } as ActiveGoal,
  });
}

export async function clearActiveGoal(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone)
    .update({ activeGoal: admin.firestore.FieldValue.delete() })
    .catch(() => {});
}

async function resumeActiveGoal(
  phone:   string,
  session: Record<string, unknown>
): Promise<{ goalContext: string }> {
  const goal = (session as any).activeGoal as ActiveGoal | null | undefined;

  if (!goal) return { goalContext: "" };

  // Auto-expire goals older than 24 hours — prevents stale booking context from resurfacing days later.
  const goalAge = goal.startedAt
    ? Date.now() - new Date(goal.startedAt).getTime()
    : Infinity;
  const isStale = goal.turnsRemaining <= 0 || goalAge > 24 * 60 * 60 * 1000;

  if (isStale) {
    await db.collection("agent_sessions").doc(phone)
      .update({ activeGoal: admin.firestore.FieldValue.delete() })
      .catch(() => {});
    return { goalContext: "" };
  }

  // Decrement turns remaining (fire-and-forget)
  db.collection("agent_sessions").doc(phone).update({
    "activeGoal.turnsRemaining": goal.turnsRemaining - 1,
  }).catch(() => {});

  const goalContext =
    `\n\n<active_goal>Goal: ${goal.description}. Context: ${JSON.stringify(goal.context)}.</active_goal>`;
  return { goalContext };
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
  session?:      Record<string, unknown>;
  isRetry?:      boolean;
  // If true, skip sending via Linq (used by web callable — reply is returned directly)
  skipSend?:     boolean;
  // Mutable array populated with MCP tool names called during this invocation (web caller reads this)
  _toolCallsOut?: string[];
  // Input channel tag — tells Claude what kind of input this is.
  // [USER] = family/caregiver texted directly
  // [TRIGGER: type] = fired by the scheduled trigger engine
  // [AGENT: source] = report from an execution agent (health signal, journal, etc.)
  // [SYSTEM: reason] = internal system event (retry, escalation)
  sourceChannel?: string;
}): Promise<string> {
  const { text, phone, chatId, userId, seniorId, userType = "client", caregiverId, zepThreadId, session, isRetry, skipSend, _toolCallsOut, sourceChannel } = params;

  // Tag the input so Claude can apply different judgment per channel.
  // [USER] messages may require a reply; [TRIGGER] / [AGENT] inputs may not.
  const channel = sourceChannel ?? "[USER]";
  const taggedText = channel === "[USER]" ? text : `${channel}\n${text}`;

  // DND check — skip if user has quiet hours enabled
  const prefs = await getPreferences(userId).catch(() => null);
  if (prefs && isInDND(prefs)) {
    return "";
  }

  let systemPrompt: string;
  let history: Array<{ role: "user" | "assistant"; content: string }>;

  if (userType === "caregiver" && caregiverId) {
    const [caregiver, todayAppt, hist, cgZepContext] = await Promise.all([
      getCaregiverProfile(caregiverId),
      getCaregiverTodayAppointment(caregiverId),
      getConversationHistory(phone),
      zepThreadId ? getZepContext(zepThreadId).catch((err) => {
        console.warn("qaAgent: Zep context unavailable (caregiver)", err instanceof Error ? err.message : err);
        return "";
      }) : Promise.resolve(""),
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

    // Detect and apply fact corrections before building context — reload facts if applied
    let correctionApplied = false;
    try {
      const { detectAndApplyCorrection } = await import("../memory/learnedFacts");
      correctionApplied = await detectAndApplyCorrection(userId, text, zepThreadId ? phone.replace(/\D/g, "") : undefined);
    } catch {
      // Non-critical
    }

    // Load Zep context, memory files, learned facts, active visit, and booking patterns in parallel
    const [zepContext, memoryContext, facts, activeVisit, bookingPatterns] = await Promise.all([
      zepThreadId ? getZepContext(zepThreadId).catch((err) => {
        console.warn("qaAgent: Zep context unavailable (client)", err instanceof Error ? err.message : err);
        return "";
      }) : Promise.resolve(""),
      getMemoryContext(userId).catch(() => ""),
      getRelevantFacts(userId).catch(() => []),
      getActiveVisit(userId).catch(() => null),
      getBookingPatterns(userId),
    ]);

    const factsText = facts.length
      ? facts.map((f) => `- ${f.fact} (${f.category})`).join("\n")
      : undefined;

    systemPrompt = buildClientSystemPrompt(
      senior, journal, nextAppt, permissions, factsText,
      zepContext || undefined,
      memoryContext || undefined,
      activeVisit,
      bookingPatterns || undefined
    );

    // If correction was applied, log it so caller knows (useful for debugging)
    if (correctionApplied) {
      console.info("qaAgent: fact correction applied before prompt build", { userId });
    }
  }

  // Inject active goal context if present
  if (session) {
    const { goalContext } = await resumeActiveGoal(phone, session);
    if (goalContext) systemPrompt += goalContext;
  }

  // Inject active background task status (e.g. emergency replacement in progress)
  const activeTaskSnap = await db.collection("agent_tasks_active").doc(phone).get().catch(() => null);
  if (activeTaskSnap?.exists) {
    const t = activeTaskSnap.data()!;
    systemPrompt +=
      `\n\nACTIVE BACKGROUND TASK:\nType: ${t.type as string}\nStatus: ${t.status as string}\nDetails: ${t.description as string}\n` +
      `If the family asks for an update or "what's happening", report this status directly.`;
  }

  // Roster check — inject active execution agent context so Claude can route follow-up questions
  if (userType !== "caregiver") {
    const activeAgent = await getActiveAgentForUser(phone).catch(() => null);
    if (activeAgent) {
      const lastAction = activeAgent.operationalLog?.at(-1)?.result ?? "none";
      systemPrompt +=
        `\n\nACTIVE EXECUTION AGENT:\nType: ${activeAgent.type}\nAgent ID: ${activeAgent.id}\n` +
        `Last action: ${lastAction}\n` +
        `Context summary: ${JSON.stringify(activeAgent.context).slice(0, 400)}\n\n` +
        `If the family's message is a follow-up question about this task (asking about a specific caregiver, rates, experience, etc.), ` +
        `call the 'resume_execution_agent' tool with agentId="${activeAgent.id}" and their message. ` +
        `Return the tool's reply EXACTLY as-is.`;
    }
  }

  try {
    if (!skipSend) await startTyping(chatId).catch(() => {});

    // Re-inject persona + epistemic reminder every 10 turns to prevent voice drift
    const turnCount = Math.floor(history.length / 2);
    if (turnCount > 0 && turnCount % 10 === 0) {
      systemPrompt +=
        "\n\n<system_reminder>You are Cara — warm, direct, specific. " +
        "Text format only: no bullet points, no headers, no em-dashes. " +
        "Keep replies under 300 characters when possible. " +
        "Lead with the human before the data. " +
        "Epistemic: only state facts from your context or tool results. If uncertain, say 'I don't have that info' rather than guessing. " +
        "Tools available — use them for fresh data and to take real actions.</system_reminder>";
    }

    // Select tools based on user type — caregivers get a focused subset
    const activeTools = userType === "caregiver" ? CAREGIVER_TOOLS : MCP_TOOLS;

    // Tool-use loop — Claude calls tools until it has what it needs, then produces a reply
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: taggedText },
    ];

    // Cache the system prompt — it's large, stable within a session, and called up to 8x per turn.
    // Prompt caching cuts latency and cost on every tool-use iteration after the first.
    const cachedSystem: Anthropic.TextBlockParam[] = [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } } as any,
    ];

    let reply = "";
    for (let iteration = 0; iteration < 8; iteration++) {
      const response = await callClaudeWithRetry(getClient(), {
        model:       "claude-sonnet-4-6",
        max_tokens:  600,
        system:      cachedSystem as any,
        tools:       activeTools as any,
        tool_choice: { type: "auto" },
        messages,
      }, { timeoutMs: 25_000, maxAttempts: 2 });

      if (response.stop_reason === "tool_use") {
        // Execute all tool calls in this turn
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            _toolCallsOut?.push(block.name);
            // For browser actions that take 15-30s: send a brief acknowledgment so
            // the family knows something is happening and doesn't think Cara went silent.
            if (
              !skipSend &&
              block.name === "perform_web_action" &&
              ((block.input as any)?.actionType === "browse" || (block.input as any)?.loginAction)
            ) {
              await sendSplit(chatId, "On it — give me a moment.").catch(() => {});
            }

            const toolHandler = userType === "caregiver" ? handleToolCallForCaregiver : handleToolCall;
            const result = await toolHandler(block.name, block.input as Record<string, unknown>)
              .catch((err) => {
                console.error(`qaAgent: tool call failed [${block.name}]`, err);
                return {
                  _toolError: true,
                  message: "Tool unavailable — answer from what you already know or say you don't have that information right now.",
                };
              });
            toolResults.push({
              type:        "tool_result",
              tool_use_id: block.id,
              content:     JSON.stringify(result),
            });
          }
        }
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user",      content: toolResults });
      } else {
        reply = response.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("")
          .trim();
        break;
      }
    }

    if (!reply) {
      console.warn("qaAgent: tool-use loop exhausted without text reply", { userId, isRetry, preview: text.slice(0, 80) });

      if (!isRetry) {
        // Schedule a retry in 30 seconds via the trigger engine
        db.collection("proactive_triggers").add({
          userId,
          phone,
          type:        "custom",
          scheduledAt: new Date(Date.now() + 30_000).toISOString(),
          message:     `qa_retry:${JSON.stringify({ text: text.slice(0, 500), chatId, userId, seniorId, userType, caregiverId, zepThreadId })}`,
          firedAt:     null,
          cancelledAt: null,
          createdAt:   new Date().toISOString(),
        }).catch(() => {});
        reply = "I'm looking into that — I'll get back to you in a moment.";
      } else {
        // Retry also exhausted — escalate to admin
        db.collection("admin_alerts").add({
          type:      "qa_loop_exhausted",
          userId,
          phone,
          question:  text.slice(0, 300),
          severity:  "medium",
          createdAt: new Date().toISOString(),
          resolved:  false,
        }).catch(() => {});
        reply = "I wasn't able to get a complete answer — our team has been notified and will follow up.";
      }
    }

    // Grounding revision — when medical claims + hedging co-occur, ask Claude to strip speculation
    const MEDICAL_CLAIM = /\b(doctor|diagnosis|medication|dosage|mg|ml|blood pressure|heart rate|fall|injury|hospital|symptom|condition)\b/i;
    if (detectLowConfidence(reply) && MEDICAL_CLAIM.test(reply)) {
      console.warn("qaAgent: grounding revision triggered", { userId, preview: reply.slice(0, 100) });
      db.collection("agent_uncertainty_log").add({
        userId, phone,
        question: text.slice(0, 200),
        reply:    reply.slice(0, 500),
        detectedAt: new Date().toISOString(),
        groundingTriggered: true,
      }).catch(() => {});
      try {
        const groundedResponse = await callClaudeWithRetry(getClient(), {
          model:      "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system:
            "You are a grounding editor. Revise the message below to remove all speculation, hedging, " +
            "and probabilistic language about medical or health topics. " +
            "Replace hedged claims with 'I don't have that information' or attribute them to documented sources. " +
            "Keep the same warm tone and length. Output only the revised message.",
          messages: [{ role: "user", content: reply }],
        }, { timeoutMs: 8_000, maxAttempts: 1 });
        const grounded = ((groundedResponse.content[0] as { text: string }).text ?? "").trim();
        if (grounded) reply = grounded;
      } catch {
        // Non-critical — proceed with original reply
      }
    } else if (detectLowConfidence(reply)) {
      console.warn("qaAgent: low-confidence reply (no medical claims)", { userId, preview: reply.slice(0, 100) });
      db.collection("agent_uncertainty_log").add({
        userId, phone,
        question: text.slice(0, 200),
        reply:    reply.slice(0, 500),
        detectedAt: new Date().toISOString(),
      }).catch(() => {});
    }

    reply = await supervise(reply, { phone, role: userType }).catch(() => reply);
    await saveConversationTurn(phone, text, reply);
    if (!skipSend) await sendSplit(chatId, reply);

    return reply;
  } catch (err) {
    console.error("qaAgent error:", err);
    if (skipSend) throw err;
    const errMsg =
      "I'm having a little trouble right now. For urgent questions, contact your caregiver directly " +
      "or reach our support team. For emergencies, call 911.";
    await sendMessage(chatId, errMsg).catch(() => {});
    return errMsg;
  }
}
