import type Anthropic from "@anthropic-ai/sdk";
import { getSharedClient } from "../utils/claudeClient";
import { quickComplete, getOpenAIClient } from "../utils/openaiClient";
import * as admin from "firebase-admin";
import { startTyping, sendMessage } from "../linq/client";
import { buildClickableMessage } from "./caraAgent";
import { supervise } from "../safety/supervisor";
import { guardOutbound } from "../utils/outboundGuard";
import { getPreferences, isInDND } from "../memory/preferences";
import { getRelevantFacts } from "../memory/learnedFacts";
import { getZepContext } from "../memory/zepClient";
import { getMemoryContext } from "../memory/memoryFiles";
import {
  maybeRollUpHistory,
  buildToolResultContent,
  patchDanglingToolCalls,
  truncateOldToolCallArgs,
} from "./contextManagement";
import { createTurnMetrics, emitTurnMetrics, type TurnMetrics } from "./turnMetrics";
import { MCP_TOOLS, CAREGIVER_TOOLS, handleToolCall, handleToolCallForCaregiver } from "../mcp/server";
import { callClaudeWithRetry } from "../utils/claudeRetry";
import { getActiveAgentForUser } from "./executionAgent";
import { selectToolsForIntent } from "./toolCapabilities";
import { withToolsCacheControl } from "./toolCache";
import type { Intent } from "./intentClassifier";
import { MEMORY_GUIDELINES } from "./memoryGuidelines";
import { VOICE_EXEMPLARS } from "./voiceExemplars";
import { computeVoiceProfile, buildVoiceDirective } from "./voiceMirror";
import { decideRecovery } from "./recoveryDecision";
import { runEphemeralSubAgent } from "./ephemeralSubAgents";
import { pickSkill } from "./skillPicker";
import { findSkill, buildSkillDirective } from "./skills";
import { runAugmenters, type PromptAugmenter, type AugmenterContext } from "./promptAugmenters";
import { experimentsAugmenter } from "./promptExperiments";
import { DEFAULT_AUGMENTERS } from "./defaultPromptAugmenters";
import "./experimentRegistry"; // side-effect: registers active experiments
import { loadCheckpoint, writeCheckpoint, clearCheckpoint, hashText } from "./turnCheckpoint";
import {
  classifyEmotionalContext,
  classifyEmotionalTopic,
  blendEmotionalContext,
  buildEmotionalContextDirective,
  type EmotionalContext,
  type EmotionalTopic,
  type StoredEmotionalContext,
} from "./emotionalContext";

const db = admin.firestore();

// ── Context loaders ───────────────────────────────────────────────────────────

async function getSeniorProfile(seniorId: string) {
  if (!seniorId) return null;
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

// Sonnet 4.6 model-tuning suffix. Verbatim from LangChain's deepagents harness
// profile for anthropic:claude-sonnet-4-6, which sources these fragments from
// Anthropic's published Claude prompting best-practices. Appended last so the
// model attends to them most strongly (closest to the conversation history).
// Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
const SONNET_46_PROMPT_SUFFIX = `<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>

<investigate_before_answering>
Never speculate about facts you have not verified. If the family references a specific person, appointment, or detail, you MUST call the relevant tool to look it up before answering. Never make any claims about a senior, caregiver, schedule, or billing item before investigating unless you are certain of the correct answer — give grounded, hallucination-free answers.
</investigate_before_answering>

<tool_result_reflection>
After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your reasoning to plan and iterate based on this new information, and then take the best next action.
</tool_result_reflection>`;

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
    `You ARE Cara — an AI care assistant texting with a family member caring for ${seniorName}.`,
    `IDENTITY (non-negotiable): Speak in first person ("I", "me"). Never refer to yourself as "Cara" in the third person. Never tell the family to "reach out to Cara", "contact Cara", "message Cara", or that "a Cara team member will help" or "the Cara team will follow up" — you ARE Cara. Phrases like these are banned. If they want to connect with a caregiver, YOU connect them by calling schedule_interview or request_booking — don't tell them to reach out elsewhere.`,
    `You act; you don't describe what you could do. When you can do something, do it and report back.`,
    ``,
    `PROMISES MUST BE ACTIONS (non-negotiable): If you say "let me pull up", "let me find", "I'll check", "let me look that up", "give me a moment", "I'll get back to you with X", or any phrase implying deferred work, you MUST call the relevant tool IN THE SAME TURN. Never end your reply with a promise to do work without having already called the tool that does it. The user gets the text reply and any tool calls as one atomic turn; if the tool isn't called now, the work never happens.`,
    `Examples:`,
    `- BAD: "Got it, I'll find caregivers — let me pull up options." (no tool call → user waits forever)`,
    `- GOOD: call find_replacement_caregivers, then in your text reply say what you found or that you're pulling matches now (the tool fires before your text is sent).`,
    `- BAD: "Let me check your next visit." (no tool call)`,
    `- GOOD: call get_upcoming_appointments, then reply with the actual answer.`,
    `If you need more info from the family before you can call the tool (e.g. you don't know what they want), ASK a concrete question — don't say "let me check" first.`,
    ``,
    `CAREGIVER SEARCH — when the family asks for caregivers, options, or "give me names", call find_replacement_caregivers IMMEDIATELY. Do not re-ask about care needs if you already have them in the cached context above. The matching tool handles the search itself; you only need to invoke it. After invoking, your reply should briefly say what you're matching on ("I'm looking for caregivers near you who can help with bathing and meds — coming up.") — never "Let me pull up options" with no tool call.`,
    `When a family member expresses interest in a specific caregiver (e.g. "yes let's connect", "let's go with him", "I like her"), proactively call schedule_interview to set up an intro, or ask them for their preferred time if you don't have one yet. Do not punt them to a website or "team".`,
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
    `Never invent a city, neighborhood, address, or zip code. If you need a location, use what's in the cached context above. If it isn't there, ASK — never substitute a plausible-sounding city (e.g. don't say "Santa Clara" when the context shows "Gilroy", and don't pick a city out of thin air just because one is geographically nearby).`,
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
    `  · cara_knows — call when the family asks what you remember about ${seniorName}, what's on file, or to verify what you've been told. Summarize the returned context warmly in 2–3 sentences as prose, never a list.`,
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
    `  · get_upcoming_appointments — list ${seniorName}'s upcoming scheduled visits (dates, times, caregiver). Call when they ask "what's coming up", "who's visiting this week", or "what's on the calendar".`,
    `  · list_household_seniors — list everyone being cared for in this household. Use when a family manages care for more than one person and you need to know who's on file.`,
    `  · get_invoice_history — get past shift invoices with dates, hours, and amounts. Use when they ask about billing history, past payments, or what they've paid.`,
    `  · list_client_jobs — list the family's posted job listings. Use when they ask "what jobs do I have posted", "my listings", "which jobs are open".`,
    `  · cancel_job_post — close an open job post. Confirm before calling.`,
    `  · list_job_applicants — list caregivers who applied to a specific job. Ask which job if they have more than one open.`,
    `  · edit_job_post — edit an existing job post's rate, description, schedule, or payment method. Confirm the specific changes before calling.`,
    `  · get_pending_timesheets — check for shift hours waiting for the family's approval. Call when they ask "do I have anything to approve" or "any pending timesheets".`,
    `  · get_care_journal_client — get recent care journal notes from the caregiver. Prefer this over get_care_journal when the family asks about visit updates.`,
    `  · get_recent_messages — show recent inbox messages with a caregiver. Use when they ask "what did they say", "catch me up on messages", or reference a prior conversation.`,
    `  · create_support_ticket — LAST RESORT, only for issues no other tool can resolve. Do NOT use it for link/onboarding/signup/subscription/payment/identity requests — those you can fulfill yourself with send_onboarding_link or get_payment_update_link. Never tell someone "the team will follow up" for something you can do right now.`,
    `  · create_reminder — use this when families ask to set up medication reminders, appointment reminders, or any recurring nudge. Say "I've set that up — I'll text you a reminder." Don't ask them to use an app.`,
    `  · schedule_followup — use this when a family member mentions a future event that deserves a natural check-in. Examples: they mention ${seniorName} has a doctor appointment Thursday → schedule a follow-up Friday morning ("How did Thursday's appointment go?"). They mention trying a new medication → schedule 3 days out. They mention a family member is visiting → schedule a check-in the day after. Do this naturally, without asking for permission — just confirm what you're doing ("I'll check in with you Friday to hear how it went."). Only schedule one follow-up per event.`,
    `  · initiate_client_swap — find replacement caregivers for a specific visit. Use when the family wants to swap who's coming for a single date (vs. cancelling outright).`,
    `  · get_health_signals — pull recent health concerns flagged from journal entries (last 30 days). Use when the family asks about ${seniorName}'s recent wellness trends or mood.`,
    `  · get_recurring_schedule — read the active recurring care schedule. Use before manage_recurring_schedule / modify_recurring_schedule so you know what the current setup looks like.`,
    `  · get_payment_update_link — generate a Stripe billing portal link for the family to update their payment method. Send them the link; never ask them to type card details.`,
    `  · send_onboarding_link — generate AND send a tappable onboarding/signup link directly to the chat. Use for ANY request to (re)send a subscription/payment, identity verification, profile photo, document, background-check, or payout link. Pick linkType: client_payment, client_identity, caregiver_membership, caregiver_photo, caregiver_documents, caregiver_background_check, caregiver_payouts. The tool sends the link itself — after it succeeds, just briefly confirm (e.g. "Sent! Tap the link to verify your identity — takes about 30 seconds."). Do NOT open a support ticket for these.`,
    `  · get_invoice_details — pull the itemized breakdown for a specific invoice. Use when they ask "what was I charged for on June 3?".`,
    `  · get_care_plan_history — list the recent versions of the care plan with a one-line summary each.`,
    `  · restore_care_plan_version — roll the care plan back to a prior version. MANDATORY: confirm with the family which version they want and read back what it contains before calling.`,
    `  · get_family_group — list everyone in the care group with their role and phone.`,
    `  · update_user_profile — update the family's own name, phone, address, or photo. Read back the proposed change before calling. Phone changes need OTP re-verification on the new number.`,
    `  · update_communication_preferences — toggle newsletter / new-match alerts / review notifications / privacy. Confirm each toggle with the family.`,
    `  · request_email_change — kick off an email change. Sends a verify link to the new address; tell the family they'll need to click it from the new inbox before it takes effect.`,
    `  · get_caregiver_reviews — pull recent reviews and average rating for a caregiver. Use for "what do other families say about Alice?".`,
    `  · save_caregiver_favorite / unsave_caregiver_favorite / list_saved_caregivers — manage the family's favorite caregivers.`,
    `  · block_user — block another user from interacting with the family. MANDATORY: read back who you're about to block and wait for explicit YES.`,
    `  · unblock_user — remove an existing block.`,
    `  · report_user — file an abuse report. MANDATORY: confirm category and details with the family, then call. Tell them ops follows up within 24 hours.`,
    `  · like_journal_entry — like a care journal post when the family expresses appreciation ("loved that photo of Mom").`,
    `  · unlike_journal_entry — undo a like.`,
    `  · comment_on_journal_entry — leave a comment on a journal entry. Use when the family says "tell Maria thanks for the visit notes" — comment + the tool also notifies the caregiver.`,
    `For irreversible actions (cancel_appointment, delete_reminder, remove_family_member, cancel_subscription, manage_recurring_schedule with action 'cancel', restore_care_plan_version, block_user, report_user), always confirm with the family before calling. For everything else, act and report.`,
    ``,
    `NOTIFICATION DELIVERY (non-negotiable): When a tool result includes a "notification" field with sent:false, the action completed but the downstream message to the caregiver/family-member did NOT go through. Tell the user honestly: "I cancelled the visit, but my note to the caregiver didn't go through — want me to retry?" Never claim someone was notified if notification.sent === false.`,
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
    `PROACTIVE FOLLOW-UPS — call schedule_followup whenever the family mentions a future event you should check in on. Don't ask permission; just confirm what you're doing.`,
    `Examples that should trigger schedule_followup (followed by a natural acknowledgment, NOT "want me to follow up?"):`,
    `- "Mom has a cardiology appointment Thursday" → schedule_followup for Friday morning. Say: "Got it. I'll check in Friday to see how it went."`,
    `- "We're trying a new medication starting today" → schedule_followup for 3 days from now. Say: "I'll check back in a few days to see how she's tolerating it."`,
    `- "My sister is flying in this weekend to visit" → schedule_followup for Monday. Say: "Hope you have a great visit. I'll check in Monday."`,
    `- "He's having a tough day" → schedule_followup for tomorrow. Say: "Thinking of you both. I'll check in tomorrow."`,
    `One follow-up per event. Schedule silently if the family didn't ask — just say what you're doing as a passing acknowledgment.`,
    ``,
    `LEARN OUT LOUD — when the family shares something durable about ${seniorName} (a preference, a routine, a medical update, a person in their life, what works/doesn't work), do two things in the same turn:`,
    `1) Call update_memory_file to save it. Pick the right file: profile (basic facts, personality), health (conditions, meds, doctors), family (relationships, contacts), procedural (rules, do's/don'ts), recent_episodes (notable events).`,
    `2) Acknowledge in plain language that you're remembering it. Examples:`,
    `   - "Got it — I'll remember she prefers morning visits."`,
    `   - "Noted. I'll keep that in mind for next time you book."`,
    `   - "Good to know — I won't forget about her shellfish allergy."`,
    `Never silently log new facts. Tell the family you're noting it. This builds trust.`,
    `Skip the acknowledgment when the info is throwaway ("she's having coffee right now") or already on file.`,
    ``,
    `LEAD, DON'T ASK — when the family says hi or sends a generic open, don't ask "what do you need?". Surface the most relevant context from the cached data above (next visit, pending task, recent journal note, active matching) and offer to act. If you genuinely have nothing relevant to surface, a warm one-line hello is fine — never "what can I help you with?".`,
    ``,
    `SMART DEFAULTS — when the family asks to book a visit or hire a caregiver, look at the "Booking history" section above first. If there's a clear pattern ("Monday 9am, 4h"), propose it as the default instead of asking open-ended ("Next Monday at your usual 9am?"). Only ask for date/time if there's no pattern or they explicitly want something different.`,
    ``,
    `Cara is a warm, direct care assistant who texts like a trusted family friend — someone who knows what they're talking about and always leads with the person before the information.`,
    ``,
    `She is not a chatbot. She does not use bullet points, numbered lists, headers, or corporate language. She keeps messages short because she respects people's time.`,
    ``,
    `ONE THING AT A TIME (non-negotiable): when you need information from the family, ask for ONE thing per message. Wait for their reply. Acknowledge it in one short sentence. Then ask the next thing. Never ask for two or more pieces of information in the same message. Never use a numbered or bulleted list to collect data — that is a form, not a conversation.`,
    `WRONG (do not do this): "I need a few things: 1. Your name 2. Your mom's name 3. Your city". RIGHT: ask "What's your name?" — then on the next turn, after they answer, "Got it. And what's your mom's name?"`,
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
    `She also never refers to herself in the third person — banned phrases include "reach out to Cara", "contact Cara", "message Cara", "Cara directly", "Cara team", "Cara team member", "the team will help", "our team will reach out", "Cara will help facilitate", "I'd recommend reaching out". Cara is the one talking. When facilitation is needed, she does it herself by calling the right tool.`,
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
    ``,
    MEMORY_GUIDELINES,
    ``,
    VOICE_EXEMPLARS,
    ``,
    SONNET_46_PROMPT_SUFFIX,
  ].join("\n");
}

function buildCaregiverSystemPrompt(
  caregiver: any,
  todayAppt: any | null,
  zepContext?: string,
  contextFlags?: { pendingPayoutNotificationAck?: string; pendingBgCheckAck?: string },
): string {
  const name = caregiver?.name ?? "there";
  const rate = caregiver?.hourlyRate ?? 22;

  const apptLine = todayAppt
    ? `Today's visit: ${todayAppt.date} at ${todayAppt.startTime ?? "TBD"} for client ${todayAppt.clientId ?? ""}. Address: ${todayAppt.address ?? todayAppt.location ?? "check your schedule"}.`
    : "No visits scheduled for today.";

  const zepSection = zepContext ? `\n${zepContext}\n` : "";

  // Context-flag overlay — surfaces recent notifications the caregiver may be replying to.
  const ctxLines: string[] = [];
  if (contextFlags?.pendingPayoutNotificationAck) {
    ctxLines.push(
      `RECENT CONTEXT: This caregiver was just notified about a payout (${contextFlags.pendingPayoutNotificationAck}). ` +
      `If their message is a question about the payment (timing, amount, fees, status), use get_payout_history / get_caregiver_earnings / get_billing_summary to answer accurately.`,
    );
  }
  if (contextFlags?.pendingBgCheckAck) {
    const status = contextFlags.pendingBgCheckAck;
    const statusLine = status === "clear"
      ? "their background check just cleared — they are now approved"
      : status === "review"
        ? "their background check is in 'consider/review' status — our team is following up"
        : status === "suspended"
          ? "their background check is on hold while Checkr gathers more info"
          : `background check status: ${status}`;
    ctxLines.push(
      `RECENT CONTEXT: This caregiver was just notified that ${statusLine}. ` +
      `Answer follow-up questions about the BG check, what families will see, and next steps. ` +
      `Do not promise specific timing for re-runs; redirect to support if needed.`,
    );
  }
  const contextSection = ctxLines.length ? `\n${ctxLines.join("\n")}\n` : "";

  return [
    `You ARE Cara — an AI care assistant texting with ${name}, one of our caregivers.`,
    `IDENTITY: Speak in first person. Never refer to yourself as "Cara" in the third person. Never say "reach out to Cara", "the Cara team will help", or anything that treats Cara as a separate entity. You ARE Cara.`,
    `You act; you don't describe what you could do. When you can do something, do it and report back.`,
    ``,
    apptLine,
    zepSection,
    contextSection,
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
    `- pause_account: pause your account so you stop getting job matches (vacation, a break). Pass until as 'YYYY-MM-DD' or 'indefinite'`,
    `- reactivate_account: come back from a pause and start receiving job matches again`,
    `- accept_shift / decline_shift: accept or decline the shift offer you were just sent (resolves your current pending offer)`,
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
    `- get_caregiver_info: look up your own profile details (rate, bio, city, availability)`,
    `- get_caregiver_reviews: see your own ratings and recent reviews from families`,
    `- get_background_check_status: check the status of your background check`,
    `- get_job_recommendations: get jobs matched to your skills, rate, and location`,
    `- request_shift_swap / accept_shift_swap / cancel_shift_swap: request coverage for a shift you can't make, accept a peer's open swap, or cancel a swap you requested`,
    `- submit_gps_checkin: record a GPS check-in at the start of a visit`,
    `- get_tax_summary: see your 1099 / earnings tax summary`,
    `- send_onboarding_link: (re)send yourself a setup link — membership payment, profile photo, documents, background check, or payout setup. Picks linkType caregiver_membership / caregiver_photo / caregiver_documents / caregiver_background_check / caregiver_payouts. The tool sends the link itself; just briefly confirm after.`,
    `- send_client_message: send a message to a client on your behalf`,
    `- get_recent_messages: see recent messages with a client`,
    `- create_support_ticket: LAST RESORT only — for issues no other tool can resolve. Never tell a caregiver "the team will follow up" for something you can do right now with the tools above (status checks, links, swaps, payouts, earnings).`,
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
    ``,
    SONNET_46_PROMPT_SUFFIX,
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
  if (!snap.exists) {
    // Instrumentation: log prefetch miss so we can measure hit rate over time
    // (helps decide whether back-to-back inbound races are actually hurting users).
    console.info("qaAgent.prefetch: miss", { phone });
    return null;
  }

  const data = snap.data()!;
  if (new Date(data.expiresAt) < new Date()) {
    console.info("qaAgent.prefetch: expired", { phone, ageMs: Date.now() - new Date(data.cachedAt).getTime() });
    await snap.ref.delete().catch(() => {});
    return null;
  }

  console.info("qaAgent.prefetch: hit", { phone, ageMs: Date.now() - new Date(data.cachedAt).getTime() });
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
    await sendMessage(chatId, buildClickableMessage(chunks[i]));
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

// Sprint 8: confident-speculation detector. Catches the failure mode where
// Cara asserts a fact about a specific caregiver/availability/condition that
// she hasn't actually verified — distinct from hedging (handled above).
// LOG-ONLY this sprint: we measure the false-positive rate before deciding
// whether to add a rewrite path.
const CONFIDENCE_CLAIM_PATTERNS = [
  // Proper-name + availability/state claim ("Maria is free", "Alice is sick")
  /\b[A-Z][a-z]+(?:'s| is)\s+(free|available|booked|coming|out|sick|here|on|off|done)\b/,
  // "I confirmed/scheduled/cancelled X" without any tool record
  /\b(I (?:confirmed|scheduled|cancelled|booked|moved|paid|refunded))\b/i,
];

export function detectConfidenceClaim(reply: string): boolean {
  return CONFIDENCE_CLAIM_PATTERNS.some((r) => r.test(reply));
}

// Sprint 8: promise-without-tool-call detector. The system prompt bans
// phrases like "let me check" unless a tool was actually called the same
// turn, but the prompt rule isn't enforced. This flag lets us measure how
// often Cara violates the rule, without changing reply text.
// Match either "let me check/look/..." OR "I'll check/look/..." with up to two
// intervening words between the verb's particle (e.g. "look ... up"). The
// adverb/object slot covers "look that up", "look it up for you", etc.
const PROMISE_PATTERNS = /\b(let me\s+(?:check|look|pull|find|see|grab|get)|I'?ll\s+(?:check|look|pull|find|grab|get|come back))\b/i;

export function detectPromiseWithoutToolCall(reply: string, toolCalls: number): boolean {
  if (toolCalls > 0) return false;
  return PROMISE_PATTERNS.test(reply);
}

// Sprint 8: empathy-opener detector for tone-warmth-v1 adherence. Matches the
// reflection patterns the experiment's treatment arm asks for ("That sounds…",
// "I hear you", "That fear makes sense", etc.) on the first sentence of the
// reply. Deliberately permissive on the opener but anchored at string start.
export const WARMTH_REFLECTION_OPENERS =
  /^(that (sounds|makes sense|fear|must|'s a lot|'s hard|'s scary)|i (hear|can hear|can imagine|can only imagine)|i'?m so sorry|you('| a)re (right|not alone)|of course you|it makes sense|hearing that)/i;

// ── List-shape detector ───────────────────────────────────────────────────────
// Returns true when the reply looks like a numbered or bulleted list:
//   - 2+ lines starting with digits followed by ". " or ") "
//   - 2+ lines starting with "- " or "* " or "• "
//   - inline numbered enumeration on a single line ("1. foo 2. bar 3. baz")
// Conservative on purpose — we don't want to trigger on prose that happens to
// include "1 thing" or a single inline reference. Two distinct list markers is
// the bar.
export function hasListShape(reply: string): boolean {
  const numberedLineMatches = reply.match(/^\s*\d+[.)]\s+\S/gm);
  if (numberedLineMatches && numberedLineMatches.length >= 2) return true;

  const bulletLineMatches = reply.match(/^\s*[-*•]\s+\S/gm);
  if (bulletLineMatches && bulletLineMatches.length >= 2) return true;

  // Inline numbered enumeration — "1. foo 2. bar" on the same line.
  const inlineNumbered = reply.match(/\b\d+\.\s+\S+/g);
  if (inlineNumbered && inlineNumbered.length >= 3) return true;

  return false;
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
    // Tell Claude there was an old goal so it can acknowledge the gap instead
    // of behaving as if no prior context existed. Previously the goal expired
    // silently mid-turn and the user would see a "fresh" response that ignored
    // the conversation they were continuing.
    const ageHours = Math.max(1, Math.round(goalAge / (60 * 60 * 1000)));
    return {
      goalContext:
        `\n\n<expired_goal>The user had an active goal (${goal.description}) from ~${ageHours}h ago. ` +
        "It has expired. If their current message references that goal (\"the booking\", \"that caregiver\", " +
        "\"what we were doing\"), acknowledge the gap and ask if they want to pick it up or start fresh. " +
        "Do not pretend the prior context is still loaded.</expired_goal>",
    };
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
  // Classified intent from the webhook — used to filter the tool list to a
  // capability-relevant subset. Optional: when absent (web callable, agent
  // callers), the full tool list is bound.
  intent?:        Intent | null;
}): Promise<string> {
  const { text, phone, chatId, userId, seniorId, userType = "client", caregiverId, zepThreadId, session, isRetry, skipSend, _toolCallsOut, sourceChannel, intent } = params;

  // Tag the input so Claude can apply different judgment per channel.
  // [USER] messages may require a reply; [TRIGGER] / [AGENT] inputs may not.
  const channel = sourceChannel ?? "[USER]";
  const taggedText = channel === "[USER]" ? text : `${channel}\n${text}`;

  // Telemetry: one structured log per turn. Mutated through the function;
  // emitted once at return (success or error path). See turnMetrics.ts.
  const inputChannel = ((): TurnMetrics["inputChannel"] => {
    const c = channel.replace(/^\[/, "").replace(/[\]:].*$/, "");
    return c === "USER" || c === "TRIGGER" || c === "AGENT" || c === "SYSTEM" ? c : "USER";
  })();
  const metrics = createTurnMetrics({
    phone,
    userId,
    userType,
    pathway:      "qa",
    isRetry,
    inputChannel,
  });

  // DND check — skip if user has quiet hours enabled
  const prefs = await getPreferences(userId).catch(() => null);
  if (prefs && isInDND(prefs)) {
    if (!skipSend) {
      // Don't leave the family in silence — acknowledge the message respectfully
      await sendSplit(chatId,
        "You're in quiet hours right now. I'll hold your message and follow up when they end."
      ).catch(() => {});
    }
    return "";
  }

  // Sprint 8: post-process turn resume. If a prior attempt at THIS exact inbound
  // produced a reply but then crashed in the post-process phase (grounding/
  // format/supervise/send), a non-expired checkpoint exists. Resume from it:
  // re-run the safety supervisor and send, WITHOUT re-invoking Claude or any
  // tool — so no booking/message side effects fire twice. No-op unless the
  // CARA_CHECKPOINT_RESUME flag is on and the stored text hash matches.
  if (!skipSend) {
    const checkpoint = await loadCheckpoint(phone, text).catch(() => null);
    if (checkpoint) {
      metrics.resumedFromCheckpoint = true;
      metrics.checkpointPhase = checkpoint.phase;
      console.info("qaAgent: resuming from checkpoint", { phone, phase: checkpoint.phase });
      let resumedReply = checkpoint.reply;
      // Re-run the safety supervisor (a gate, not optional style polish). Fail
      // open to the raw reply if it throws — getting the message out beats
      // re-silencing the family.
      resumedReply = await supervise(resumedReply, { phone, role: userType }).catch(() => resumedReply);
      await saveConversationTurn(phone, text, resumedReply);
      await sendSplit(chatId, resumedReply);
      await clearCheckpoint(phone);
      await maybeRollUpHistory(phone);
      emitTurnMetrics(metrics, { reply: resumedReply });
      return resumedReply;
    }
  }

  // Precompute the inbound hash once — reused by the loop_complete checkpoint
  // write below. Cheap (FNV-1a over the trimmed text).
  const turnTextHash = hashText(text);

  // Kick off emotional-posture classification in parallel with the heavy I/O
  // below. Result is awaited once at prompt-build time. Latency cost is hidden
  // behind the existing Firestore / Zep fetches. Errors → "calm" (the
  // classifier already swallows them), so this is fire-and-await-safe.
  const emotionalClassifyPromise: Promise<EmotionalContext> = channel === "[USER]"
    ? classifyEmotionalContext(text)
    : Promise.resolve("calm");

  // Skill picker — same parallel pattern. At most one skill is chosen per turn
  // and its body is injected into the system prompt below. Failure → null,
  // which means "no skill" (Sonnet falls back to its base behavior).
  const skillPickPromise = channel === "[USER]"
    ? pickSkill(text).then(r => r.skill).catch(() => null as string | null)
    : Promise.resolve(null as string | null);

  let systemPrompt: string;
  let history: Array<{ role: "user" | "assistant"; content: string }>;

  // Sentinel injected when Zep fails. Claude sees this in the system prompt and
  // knows long-term memory (allergies, meds, conditions) is missing this turn,
  // so it must hedge medical-adjacent answers and confirm before acting on them.
  // Empty string is reserved for "no zepThreadId" / "no memory expected."
  const ZEP_UNAVAILABLE_MARKER =
    "[SYSTEM: memory_unavailable] Long-term memory service is unavailable this turn. " +
    "Stored health facts (allergies, medications, conditions, doctor names) are NOT loaded. " +
    "If the user asks about any of these, say you don't have it available right now and ask them to confirm; " +
    "do not state any health fact you can't see in the cached context or learned facts above.";

  // 4s hard cap on Zep — past calls have hung 30s+ when Zep is unhealthy.
  // On timeout OR throw, we inject the marker so Claude knows context is missing.
  const withZepTimeout = (p: Promise<string>, role: "client" | "caregiver"): Promise<string> =>
    Promise.race([
      p,
      new Promise<string>((r) => setTimeout(() => {
        console.warn(`qaAgent: Zep context timed out (${role}, 4s cap) — injecting memory_unavailable marker`);
        r(ZEP_UNAVAILABLE_MARKER);
      }, 4_000)),
    ]);

  if (userType === "caregiver" && caregiverId) {
    const [caregiver, todayAppt, hist, cgZepContext] = await Promise.all([
      getCaregiverProfile(caregiverId),
      getCaregiverTodayAppointment(caregiverId),
      getConversationHistory(phone),
      zepThreadId ? withZepTimeout(getZepContext(zepThreadId).catch((err) => {
        console.warn("qaAgent: Zep context unavailable (caregiver)", err instanceof Error ? err.message : err);
        return ZEP_UNAVAILABLE_MARKER;
      }), "caregiver") : Promise.resolve(""),
    ]);
    const contextFlags = session ? {
      pendingPayoutNotificationAck: (session as any).pendingPayoutNotificationAck as string | undefined,
      pendingBgCheckAck:            (session as any).pendingBgCheckAck            as string | undefined,
    } : undefined;
    systemPrompt = buildCaregiverSystemPrompt(caregiver, todayAppt, cgZepContext || undefined, contextFlags);
    history = hist;

    // Clear the context flags after a reply consumes them — they're one-shot context.
    // 48h expiry is also enforced by the router so this only fires for genuine acks.
    if (contextFlags?.pendingPayoutNotificationAck || contextFlags?.pendingBgCheckAck) {
      await db.collection("agent_sessions").doc(phone).update({
        pendingPayoutNotificationAck:      admin.firestore.FieldValue.delete(),
        pendingPayoutNotificationAckSetAt: admin.firestore.FieldValue.delete(),
        pendingBgCheckAck:                 admin.firestore.FieldValue.delete(),
        pendingBgCheckAckSetAt:            admin.firestore.FieldValue.delete(),
      }).catch(() => {});
    }
  } else {
    // Unconfirmed-identity gate — phone is in the system but onboarding never
    // completed, so any seniorId/userId/seniorIds on this session may point at
    // a different person we linked them to (e.g. invited family contact, or a
    // sandbox→live migration artifact). Suppress cross-entity context so Cara
    // doesn't surface someone else's appointments or care plan as if it were
    // theirs. Conversation history with THIS phone stays — that's their own
    // SMS thread with Cara, not someone else's data.
    const unconfirmedIdentity = !!(session as any)?.__unconfirmedIdentity;

    const prefetched = unconfirmedIdentity ? null : await getPrefetchedContext(phone);
    metrics.prefetchHit = !!prefetched;

    let senior: any, journal: any[], nextAppt: any | null, permissions: any | null;

    if (prefetched) {
      senior      = prefetched.seniorProfile;
      journal     = prefetched.recentJournal;
      nextAppt    = prefetched.nextAppointment;
      history     = prefetched.conversationHistory;
      permissions = null;
    } else if (unconfirmedIdentity) {
      senior      = null;
      journal     = [];
      nextAppt    = null;
      permissions = null;
      history     = await getConversationHistory(phone);
    } else {
      [senior, journal, nextAppt, permissions, history] = await Promise.all([
        getSeniorProfile(seniorId),
        getRecentJournalEntries(seniorId, 3),
        getNextAppointment(userId),
        getAgentPermissions(userId),
        getConversationHistory(phone),
      ]);
    }

    // Detect and apply fact corrections before building context — reload facts if applied.
    // Skipped for unconfirmed identity: we don't know whose facts these would be.
    let correctionApplied = false;
    if (!unconfirmedIdentity) {
      try {
        const { detectAndApplyCorrection } = await import("../memory/learnedFacts");
        correctionApplied = await detectAndApplyCorrection(userId, text, zepThreadId ? phone.replace(/\D/g, "") : undefined);
      } catch {
        // Non-critical
      }
    }

    // Load Zep context, memory files, learned facts, active visit, and booking patterns in parallel.
    // Unconfirmed-identity sessions skip all of these — they all key off userId
    // and would surface another person's care data on a linked phone.
    const [zepContext, memoryContext, facts, activeVisit, bookingPatterns] = unconfirmedIdentity
      ? ["", "", [] as Array<{ fact: string; category: string }>, null, ""]
      : await Promise.all([
        zepThreadId ? withZepTimeout(getZepContext(zepThreadId).catch((err) => {
          console.warn("qaAgent: Zep context unavailable (client)", err instanceof Error ? err.message : err);
          return ZEP_UNAVAILABLE_MARKER;
        }), "client") : Promise.resolve(""),
        getMemoryContext(userId).catch(() => ""),
        getRelevantFacts(userId).catch(() => []),
        getActiveVisit(userId).catch(() => null),
        getBookingPatterns(userId),
      ]);

    // Lazy-bootstrap memory files for users who completed onboarding before the
    // memory-files code shipped, or whose initial write silently failed. Runs
    // once per user (idempotent — initializeMemoryFiles overwrites if needed
    // but next turn memoryContext will be non-empty and this branch is skipped).
    if (!memoryContext && userId) {
      const sd = (session as any)?.onboardingData ?? {};
      const seniorDoc = senior as Record<string, unknown> | null;
      const initData = {
        seniorName:   (sd.seniorName ?? (seniorDoc as any)?.name)        as string | undefined,
        seniorAge:    (sd.age        ?? (seniorDoc as any)?.age)         as string | number | undefined,
        conditions:   (sd.conditions ?? (seniorDoc as any)?.conditions ?? []) as string[] | undefined,
        careNeeds:    (sd.careNeeds  ?? (seniorDoc as any)?.needs ?? [])      as string[] | undefined,
        city:         (sd.city ?? "")        as string,
        clientName:   (sd.firstName ?? "")   as string,
        relationship: (sd.relationship ?? "") as string,
      };
      if (initData.seniorName || initData.conditions || initData.careNeeds) {
        // Fire-and-forget — next conversation turn will read populated files
        const { initializeMemoryFiles } = await import("../memory/memoryFiles");
        initializeMemoryFiles(userId, initData).catch((err) =>
          console.warn("qaAgent: lazy initializeMemoryFiles failed", err instanceof Error ? err.message : err),
        );
      }
    }

    const factsText = facts.length
      ? facts.map((f) => `- ${f.fact} (${f.category})`).join("\n")
      : undefined;

    // Sprint 8: record which memory tier supplied context this turn. Derived
    // from the already-loaded locals — no extra reads, no loader signature
    // changes. Zep is "available" only when it returned real content (not the
    // injected unavailable marker).
    const zepLive = !!zepContext && zepContext !== ZEP_UNAVAILABLE_MARKER;
    metrics.memoryRecallTier = zepLive
      ? "zep"
      : memoryContext
        ? "memoryFiles"
        : facts.length
          ? "learnedFacts"
          : "none";
    metrics.memoryFactsRetrieved = facts.length;
    if (zepContext === ZEP_UNAVAILABLE_MARKER) metrics.zepUnavailable = true;

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

  // Voice mirror — derive style stats from the family's own inbound history
  // and inject a one-line directive so Cara's surface register (length, emoji
  // use, language, formality) tracks theirs. No-op when the sample is too
  // small to be meaningful, so brand-new conversations get default voice.
  const voiceDirective = buildVoiceDirective(computeVoiceProfile(history));
  if (voiceDirective) {
    systemPrompt += `\n\n${voiceDirective}`;
  }

  // Emotional context — blend the current turn's classification with any
  // 12h-TTL stored posture (grief/anxiety persists across turns). Inject
  // directive at end of prompt (highest model attention). Persist when the
  // posture changes or a non-calm signal arrives.
  const currentEmotion: EmotionalContext = await emotionalClassifyPromise.catch(() => "calm" as const);
  const storedEmotion  = (session as Record<string, unknown> | undefined)?.emotionalContext as
    | StoredEmotionalContext
    | undefined;
  const blended = blendEmotionalContext(storedEmotion, currentEmotion);
  metrics.emotionalContext = blended.value;

  // Sprint 8: classify topic (health / logistics / general) — synchronous,
  // regex-based, no model call. Threaded into the directive so anxious-about-
  // health gets different guidance than anxious-about-logistics.
  const emotionalTopic: EmotionalTopic = channel === "[USER]"
    ? classifyEmotionalTopic(text)
    : "general";
  metrics.emotionalTopic = emotionalTopic;

  const emotionalDirective = buildEmotionalContextDirective(blended.value, emotionalTopic);
  if (emotionalDirective) {
    systemPrompt += `\n\n${emotionalDirective}`;
  }

  // Skill injection — at most one skill body per turn, picked in parallel
  // above. Anchored at the end where Sonnet attends most. Falls back to no
  // skill on any error.
  const pickedSkillName = await skillPickPromise.catch(() => null);
  if (pickedSkillName) {
    const skill = findSkill(pickedSkillName);
    if (skill) {
      systemPrompt += `\n\n${buildSkillDirective(skill)}`;
      metrics.skill = skill.name;
    }
  }
  if (blended.persist) {
    db.collection("agent_sessions").doc(phone).update({
      emotionalContext: blended.persist,
    }).catch(() => { /* non-critical */ });
  }

  // Inject session identifiers — Claude must never ask the user for clientId, userId, or phone.
  // These are always known from the session and are also auto-injected into every tool call.
  systemPrompt += `\n\nSESSION (do not ask the user for these — use them when tools require clientId, userId, or phone):\nclientId = "${userId}" | userId = "${userId}" | phone = "${phone}"`;

  // Pending caregiver matches overlay (client only). When Cara has just shown
  // the family a list of caregivers, the family's next message may be a request
  // to interview/meet one of them — by name ("let's meet Imran"), by pronoun
  // ("set him up"), by number ("1"), or as an answer to a scheduling question
  // ("Today at 11am"). Surface that list with caregiver IDs so the agent calls
  // schedule_interview with the right caregiverId instead of starting a brand
  // new search. Without this the agent had no idea which caregiver was meant.
  if (userType !== "caregiver") {
    const pendingMatches = (session as Record<string, unknown> | undefined)?.pendingMatches as
      | Array<{ id?: string; name?: string; rate?: number }>
      | undefined;
    if (pendingMatches && pendingMatches.length) {
      const list = pendingMatches
        .map((m, i) => `  ${i + 1}. ${m.name ?? "Caregiver"}${m.rate ? ` ($${m.rate}/hr)` : ""} — caregiverId="${m.id ?? ""}"`)
        .join("\n");
      systemPrompt +=
        `\n\nCAREGIVERS YOU JUST SHOWED THIS FAMILY (most recent match list):\n${list}\n` +
        `If the family wants to interview or meet one of them — whether they name the caregiver, say "him"/"her", give a number, or are answering your question about a preferred interview date/time — call schedule_interview with that caregiverId (NOT a new search). ` +
        `If you don't yet have their preferred date and time, ask for it first, then call schedule_interview. ` +
        `If it's unclear which of these caregivers they mean, ask them to confirm by name or number before scheduling. ` +
        `Do NOT run find_replacement_caregivers again just because they replied with a time or a name from this list.`;
    }
  }

  // Sprint 7 — composable prompt augmenters. Today this only runs the A/B
  // experiments augmenter; future PRs migrate the inline `systemPrompt += ...`
  // chain below into this registry one directive at a time. The pipeline is
  // append-only and predicate-gated, so it can't break existing behavior.
  const augmenterCtx: AugmenterContext = {
    text,
    phone,
    userId,
    seniorId,
    userType,
    session,
    turnCount: Math.floor(history.length / 2),
    metrics,
  };
  const PIPELINE: PromptAugmenter[] = [
    experimentsAugmenter,
    ...DEFAULT_AUGMENTERS,
  ];
  const augResult = await runAugmenters(systemPrompt, PIPELINE, augmenterCtx);
  systemPrompt = augResult.systemPrompt;
  if (augResult.applied.length) {
    metrics.augmentersApplied = augResult.applied;
  }

  // Profile review mode — flipped by the inbound webhook when classifyIntent
  // returns UPDATE_ONBOARDING. The user is already-onboarded but wants Cara to
  // walk through what's on file and fix what's wrong. Without this directive
  // Claude defaults to "ask for everything as a numbered list" — exactly the
  // failure mode that prompted this code path. The directive forces her to:
  //   1) read what's already on file (no re-asking for known fields)
  //   2) summarize it in prose, ending with ONE question
  //   3) patch corrections one at a time via update_senior_profile /
  //      update_care_plan / update_memory_file (with the existing read-back-
  //      and-confirm rule from the main system prompt)
  // The 20-minute TTL is enforced here so a stale flag doesn't accidentally
  // hijack an unrelated future conversation.
  const reviewExpiresAt = (session as any)?.profileReviewExpiresAt as string | undefined;
  const reviewModeActive =
    !!(session as any)?.profileReviewMode &&
    (!reviewExpiresAt || new Date(reviewExpiresAt).getTime() > Date.now());
  if (reviewModeActive && userType !== "caregiver") {
    systemPrompt +=
      "\n\nPROFILE REVIEW MODE (active this turn): The family just asked you to redo, fix, or update what's on file for their senior. " +
      "Do NOT re-collect data from scratch. Do NOT send a numbered list. Do NOT ask for more than one thing in a single message. " +
      "Step 1 — On your FIRST reply this mode is active, call get_care_plan to pull the current care plan, and combine it with the senior profile and learned facts already in your context above. " +
      "Step 2 — Summarize what's on file in ONE short, warm prose sentence (e.g. \"I have Anita, 78, in Gilroy, needing help with bathing and meds.\") and end with ONE open question (\"Is any of that wrong?\" or \"What should we update?\"). Never invent a city or detail you can't see in the context. " +
      "Step 3 — Wait for the family to name what's wrong. When they do, read the proposed change back in plain English (\"Got it — updating her name to Anita. Confirm?\") and wait for an explicit yes before calling the update tool. " +
      "Step 4 — Use update_senior_profile for emergency contact, physician, diagnoses, allergies. Use update_care_plan for medications, careNeeds, dietary, special instructions. Use update_memory_file for durable narrative facts (personality, routines, family). " +
      "Step 5 — After each successful patch, ask if there's anything else to fix (ONE question). When the family says \"that's it\", \"all good\", \"nothing else\", or equivalent, keep the closing reply warm and short. " +
      "EXIT SIGNAL: when and only when the family has confirmed they're done, end your reply with the literal token [[EXIT_PROFILE_REVIEW]] on its own line. The post-processor strips the token before sending and clears the session flag. Do NOT emit the token while the user is still correcting fields.";
  }

  // Unconfirmed-identity short-circuits: skip all per-phone task/goal/agent
  // context — they may reference work on behalf of a different linked person.
  const skipCrossEntity = !!(session as any)?.__unconfirmedIdentity;

  // Inject active goal context if present
  if (session && !skipCrossEntity) {
    const { goalContext } = await resumeActiveGoal(phone, session);
    if (goalContext) systemPrompt += goalContext;
  }

  // Inject active background task status (e.g. emergency replacement in progress)
  if (!skipCrossEntity) {
    const activeTaskSnap = await db.collection("agent_tasks_active").doc(phone).get().catch(() => null);
    if (activeTaskSnap?.exists) {
      const t = activeTaskSnap.data()!;
      systemPrompt +=
        `\n\nACTIVE BACKGROUND TASK:\nType: ${t.type as string}\nStatus: ${t.status as string}\nDetails: ${t.description as string}\n` +
        `If the family asks for an update or "what's happening", report this status directly.`;
    }
  }

  // Roster check — inject active execution agent context so Claude can route follow-up questions
  if (userType !== "caregiver" && !skipCrossEntity) {
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

  // Context load is everything from function entry up to here: DND check,
  // prefetch lookup, parallel context fetch, system prompt assembly, session
  // overlays. Captured before the typing indicator so we don't include the
  // (network-bound) typing call in this measurement.
  metrics.contextLoadMs = Date.now() - metrics.startedAt;

  // Did a tool already deliver a user-facing artifact (e.g. send_onboarding_link
  // sent a tappable link straight to this chat) this turn? Declared out here so
  // the outer catch can read it. If set, the user already got what they asked
  // for — so a downstream throw or an exhausted loop must NOT (a) contradict it
  // with a "give me a few minutes" deflection, nor (b) schedule a retry that
  // re-runs the turn and double-sends the link (client_payment even mints a
  // fresh Stripe Checkout session each time).
  let deliveredToUser = false;

  try {
    if (!skipSend) await startTyping(chatId).catch(() => {});

    // The persona-reinject + epistemic guard now ships via the
    // personaReinjectAugmenter (every 4th turn, or after a lint violation) —
    // see defaultPromptAugmenters.ts. Other inline append blocks below will
    // migrate the same way as we expand the augmenter registry.

    const turnCount = Math.floor(history.length / 2);

    // Working-memory checklist (DeepAgents TodoListMiddleware port). When the
    // session has a non-empty todos list, surface it so Claude can pick up where
    // she left off across turns. Cleared/managed by the write_todos tool.
    const sessionTodos = (session as Record<string, unknown> | undefined)?.todos;
    if (Array.isArray(sessionTodos) && sessionTodos.length > 0) {
      const lines = sessionTodos.map((t: any, i: number) => {
        const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "·";
        return `${mark} ${i + 1}. ${t.task}`;
      }).join("\n");
      systemPrompt +=
        "\n\n<active_todos>\nFrom earlier in this conversation, the outstanding checklist is:\n" +
        lines +
        "\n\nKeep working through these. Call write_todos again to update statuses as you finish each, " +
        "or to add new items if scope grows. Don't repeat work already marked completed.\n</active_todos>";
    } else if (turnCount === 0) {
      // First inbound — gently nudge Claude to scaffold a checklist for genuinely
      // multi-step requests. (Don't nag on every turn — once they get going,
      // the in-prompt active_todos block above carries the load.)
      systemPrompt +=
        "\n\n<planning_hint>If this request has 3+ distinct steps " +
        "(e.g. cancel X, find replacement Y, notify Z), call write_todos first to scaffold " +
        "the plan before doing any of them. Skip for simple single-step asks.</planning_hint>";
    }

    // Select tools based on user type — caregivers get a focused subset
    // (~35 of ~88 tools). For clients, filter further by the classified
    // intent's required capabilities; broad / ambiguous intents (QUESTION,
    // TASK_REPLY, UPDATE_ONBOARDING, null) keep the full surface. Filtering
    // reduces wrong-tool calls and prompt-cache decode cost; core tools
    // (senior profile, pending tasks, etc.) are always included.
    const baseTools = userType === "caregiver" ? CAREGIVER_TOOLS : MCP_TOOLS;
    const activeTools = userType === "caregiver"
      ? baseTools
      : selectToolsForIntent(baseTools, intent ?? null);
    if (activeTools.length !== baseTools.length) {
      console.info("qaAgent: tool surface filtered", {
        userId, intent, before: baseTools.length, after: activeTools.length,
      });
    }

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

    // Cache the tools block too. With ~88 tool schemas cycled up to 5x per turn,
    // the tools array is a big share of input tokens; an uncached array was
    // re-tokenized every iteration. A cache breakpoint on the LAST tool caches
    // the whole stable block (separate from the system-prompt breakpoint).
    const cachedTools = withToolsCacheControl(activeTools);

    let reply = "";
    // Budget guard: cap wall-clock at ~60s so users never wait 3+ min while the
    // tool loop iterates. Each Claude call gets a tight timeout; we exit early
    // once the running total exceeds the budget.
    const TURN_BUDGET_MS = 60_000;
    const turnStart = Date.now();
    // Recovery tracking — if Sonnet hits two consecutive iterations where every
    // tool_use returned an error, ask the recovery sub-agent for a different
    // plan ONCE and inject it into the next user message. Fires at most one
    // time per turn so we don't compound latency.
    let consecutiveErrorIterations = 0;
    let recoveryFired              = false;
    const toolErrorTrail: { tool: string; preview: string }[] = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      // On the final allowed iteration, or once the wall-clock budget is spent,
      // force a text-only completion (tool_choice:none) so the model MUST emit a
      // user-facing reply instead of calling another tool and leaving us in the
      // exhausted "Give me a moment" + 30s-retry fallback. Deterministic
      // completion beats the fragile no-text heuristic.
      const budgetExceeded = Date.now() - turnStart > TURN_BUDGET_MS;
      const forceTextReply = budgetExceeded || iteration === 4;
      if (budgetExceeded) {
        console.warn("qaAgent: turn budget exceeded — forcing final text reply", { userId, iteration });
      }
      // Clip oversized tool_use args in older messages — the result is what
      // matters past the first turn or two, and full args bloat every cached
      // prompt thereafter. Cheap pre-pass before patch + Claude call.
      const argsClipped = truncateOldToolCallArgs(messages);
      if (argsClipped > 0) {
        metrics.toolArgsTruncated = (metrics.toolArgsTruncated ?? 0) + argsClipped;
      }

      // Defensive: ensure every assistant tool_use has a matching tool_result
      // before we hand the array to Claude. Normally a no-op; non-zero patches
      // indicate either max_tokens truncation on the previous iteration or a
      // bug in the loop pairing.
      const patched = patchDanglingToolCalls(messages);
      if (patched > 0) {
        console.warn("qaAgent: patched dangling tool calls", { userId, iteration, patched });
        metrics.patchedOrphans = (metrics.patchedOrphans ?? 0) + patched;
      }
      metrics.iterations = (metrics.iterations ?? 0) + 1;
      const response = await callClaudeWithRetry(getSharedClient(), {
        model:       "claude-sonnet-4-6",
        max_tokens:  1024,
        system:      cachedSystem as any,
        tools:       cachedTools as any,
        tool_choice: forceTextReply ? { type: "none" } : { type: "auto" },
        messages,
      }, { timeoutMs: 15_000, maxAttempts: 1 });

      // max_tokens cutoff while emitting tool_use blocks → tool input JSON may
      // be truncated. We can't safely execute partially-specified tool calls
      // (booking with missing args, message with missing body, etc.). Push the
      // assistant message, let patchDanglingToolCalls inject placeholder tool
      // results on the next iteration, and continue so Claude can recover.
      if (
        response.stop_reason === "max_tokens" &&
        response.content.some((b) => b.type === "tool_use")
      ) {
        console.warn("qaAgent: max_tokens with tool_use blocks — treating as truncated", {
          userId,
          iteration,
          toolNames: response.content
            .filter((b) => b.type === "tool_use")
            .map((b) => (b as { type: "tool_use"; name: string }).name),
        });
        metrics.truncations = (metrics.truncations ?? 0) + 1;
        messages.push({ role: "assistant", content: response.content });
        // patchDanglingToolCalls at the top of the next iteration injects the
        // placeholder tool_results, which Claude reads and recovers from.
        continue;
      }

      if (response.stop_reason === "tool_use") {
        // Execute all tool calls in this turn
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        let iterationToolCalls = 0;
        let iterationToolErrors = 0;
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
            // Auto-inject session identifiers so Claude never needs to ask the user for them.
            // Only inject non-empty values — an empty string is falsy and fails tool validation.
            const enrichedInput: Record<string, unknown> = {
              ...(block.input as Record<string, unknown>),
              phone,
              chatId,
              ...(userId ? { clientId: userId, userId } : {}),
              // For caregiver conversations, inject the acting caregiver's own ID
              // authoritatively (last, so it overrides any model-guessed value).
              // Caregiver action tools (earnings, availability, shift hours,
              // payouts, reviews, bg-status…) all require caregiverId, which the
              // model otherwise has no reliable way to know. Only inject when the
              // SPEAKER is the caregiver, so client tools that legitimately target
              // a specific caregiver (send_caregiver_message, submit_review,
              // get_caregiver_reviews) keep the client-supplied id.
              ...(userType === "caregiver" && caregiverId ? { caregiverId } : {}),
            };
            const toolStart = Date.now();
            const result = await toolHandler(block.name, enrichedInput)
              .catch((err) => {
                console.error(`qaAgent: tool call failed [${block.name}]`, err);
                return {
                  _toolError: true,
                  message: "Tool unavailable — tell the user you don't have that information right now and offer to try again.",
                };
              });
            metrics.toolCalls = (metrics.toolCalls ?? 0) + 1;
            (metrics.toolNames ??= []).push(block.name);
            iterationToolCalls += 1;
            const errored = !!(result as { _toolError?: boolean; error?: unknown })?._toolError
              || !!(result as { error?: unknown })?.error;
            if (errored) {
              metrics.toolErrors = (metrics.toolErrors ?? 0) + 1;
              iterationToolErrors += 1;
              if (toolErrorTrail.length < 6) {
                toolErrorTrail.push({
                  tool:    block.name,
                  preview: JSON.stringify(result).slice(0, 200),
                });
              }
            } else if ((result as { sent?: boolean })?.sent === true) {
              // A self-delivering tool (send_onboarding_link) already pushed a
              // tappable artifact to this chat. Remember it so the exhausted-loop
              // and outer-catch paths confirm rather than contradict — and never
              // schedule a retry that would re-send / re-mint the link.
              deliveredToUser = true;
            }

            // Instrumentation for D4 — track success rate on the cancel path so
            // we can decide if a dedicated cancelFlow is needed. Same pattern
            // works for any high-stakes tool.
            if (block.name === "cancel_appointment" || block.name === "cancel_subscription") {
              const succeeded = !(result as any)?._toolError && !(result as any)?.error;
              console.info("qaAgent.toolUse", {
                tool:     block.name,
                phone,
                userId,
                succeeded,
                durationMs: Date.now() - toolStart,
              });
              db.collection("agent_tool_metrics").add({
                tool:        block.name,
                phone,
                userId,
                succeeded,
                durationMs:  Date.now() - toolStart,
                errorPreview: succeeded ? null : JSON.stringify(result).slice(0, 200),
                ranAt:       new Date().toISOString(),
              }).catch(() => {/* non-critical */});
            }

            toolResults.push({
              type:        "tool_result",
              tool_use_id: block.id,
              content:     await buildToolResultContent(userId, block.name, result),
            });
          }
        }
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user",      content: toolResults });

        // Recovery — delegated to the pure policy in recoveryDecision.ts.
        // Fires on the 2nd consecutive iteration where every tool_use errored,
        // at most once per turn. Appends a <recovery_suggestion> user-channel
        // block so Sonnet attends to it on the next iteration.
        const decision = decideRecovery(
          { consecutiveErrorIterations, alreadyFired: recoveryFired },
          { toolCalls: iterationToolCalls, toolErrors: iterationToolErrors },
        );
        consecutiveErrorIterations = decision.consecutiveErrorIterations;
        if (decision.shouldFire) {
          recoveryFired = true;
          metrics.recoveryFired = true;
          try {
            const errSummary = toolErrorTrail
              .map(e => `- ${e.tool}: ${e.preview}`)
              .join("\n");
            const recoveryDescription =
              `Original user request: ${text.slice(0, 400)}\n\n` +
              `Tools tried and the errors they returned:\n${errSummary}\n\n` +
              `Suggest a different approach.`;
            const rec = await runEphemeralSubAgent({
              subagentType: "recovery",
              description:  recoveryDescription,
              maxTokens:    200,
            });
            messages.push({
              role:    "user",
              content: `<recovery_suggestion>\n${rec.output}\n</recovery_suggestion>`,
            });
            console.info("qaAgent.recoveryFired", {
              userId,
              consecutiveErrorIterations,
              durationMs: rec.durationMs,
            });
          } catch (err) {
            console.warn("qaAgent: recovery sub-agent threw — continuing without hint", err);
          }
        }
      } else {
        reply = response.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("")
          .trim();
        break;
      }
    }

    // Sprint 8: did the tool loop produce a genuine reply (vs. the exhausted
    // fallback below)? Only genuine replies are checkpointed — the exhausted
    // path schedules its own retry via proactive_triggers and must not resume.
    const loopProducedReply = !!reply;

    if (!reply) {
      console.warn("qaAgent: tool-use loop exhausted without text reply", { userId, isRetry, preview: text.slice(0, 80), deliveredToUser });

      if (deliveredToUser) {
        // The link/artifact already went out this turn; the only thing missing
        // is Cara's confirming sentence. Supply it directly and DO NOT schedule
        // a retry — re-running would call send_onboarding_link again (duplicate
        // link, and a fresh Stripe Checkout session for client_payment).
        reply = "There you go — tap the link I just sent to finish up. Anything else I can help with? 💙";
      } else if (!isRetry) {
        // Schedule a retry in 30 seconds via the trigger engine — the retry
        // will reply with the real answer when it succeeds.
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
        reply = "Give me a moment on that — I'm pulling it up.";
      } else {
        // Retry also exhausted — escalate to admin silently. User-facing
        // message is natural and warm, not "broken".
        db.collection("admin_alerts").add({
          type:      "qa_loop_exhausted",
          userId,
          phone,
          question:  text.slice(0, 300),
          severity:  "medium",
          createdAt: new Date().toISOString(),
          resolved:  false,
        }).catch(() => {});
        reply = "Let me come back to you on that one shortly.";
      }
    }

    // Sprint 8: checkpoint the raw reply now that the tool loop is done. If the
    // post-process phase below (grounding/format/supervise) or the send crashes,
    // a retry resumes from here instead of re-running the whole tool loop. Fire-
    // and-forget (no-op unless CARA_CHECKPOINT_RESUME is on). Only genuine loop
    // replies — never the exhausted fallback stubs.
    if (loopProducedReply && !skipSend) {
      writeCheckpoint(phone, "loop_complete", turnTextHash, reply).catch(() => {});
    }

    // Grounding revision — when medical claims + hedging co-occur, ask Claude to strip speculation
    const MEDICAL_CLAIM = /\b(doctor|diagnosis|medication|dosage|mg|ml|blood pressure|heart rate|fall|injury|hospital|symptom|condition)\b/i;
    if (detectLowConfidence(reply) && MEDICAL_CLAIM.test(reply)) {
      console.warn("qaAgent: grounding revision triggered", { userId, preview: reply.slice(0, 100) });
      metrics.groundingTriggered = true;
      db.collection("agent_uncertainty_log").add({
        userId, phone,
        question: text.slice(0, 200),
        reply:    reply.slice(0, 500),
        detectedAt: new Date().toISOString(),
        groundingTriggered: true,
      }).catch(() => {});
      try {
        const groundedController = new AbortController();
        const groundedTimer = setTimeout(() => groundedController.abort(), 8_000);
        const grounded = await quickComplete(
          "You are a grounding editor. Revise the message below to remove all speculation, hedging, " +
            "and probabilistic language about medical or health topics. " +
            "Replace hedged claims with 'I don't have that information' or attribute them to documented sources. " +
            "Keep the same warm tone and length. Output only the revised message.",
          reply,
          { maxTokens: 300, signal: groundedController.signal },
        );
        clearTimeout(groundedTimer);
        if (grounded.trim() && grounded.trim() !== reply) {
          reply = grounded.trim();
          metrics.groundingRewriteApplied = true;
        }
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

    // Format revision — if Claude produced list-shaped output (numbered list,
    // bullet list, or multi-line "1.", "2.", "-", "•") despite the no-lists
    // rule in the system prompt, rewrite to conversational prose before the
    // user sees it. Same fail-open / 8-second timeout pattern as the grounding
    // pass above. Defense in depth — the prompt is supposed to prevent this
    // but the screenshot that started this fix proves Claude still slips up.
    if (hasListShape(reply)) {
      console.warn("qaAgent: format revision triggered (list-shaped reply)", { userId, preview: reply.slice(0, 120) });
      metrics.formatRevisionTriggered = true;
      db.collection("agent_uncertainty_log").add({
        userId, phone,
        question: text.slice(0, 200),
        reply:    reply.slice(0, 500),
        detectedAt: new Date().toISOString(),
        formatRevisionTriggered: true,
      }).catch(() => {});
      try {
        const fmtController = new AbortController();
        const fmtTimer = setTimeout(() => fmtController.abort(), 8_000);
        const rewritten = await quickComplete(
          "You are a tone editor for Cara, a warm SMS care assistant. " +
            "Rewrite the message below into conversational prose. " +
            "Strict rules: NO numbered lists, NO bullet points, NO dashes-as-bullets, NO headers, NO markdown. " +
            "If the message asks for multiple pieces of information, keep ONLY the first question and drop the rest — Cara asks one thing at a time. " +
            "Preserve warm, direct tone. Output only the revised message; no explanation.",
          reply,
          { maxTokens: 300, signal: fmtController.signal },
        );
        clearTimeout(fmtTimer);
        if (rewritten.trim() && rewritten.trim() !== reply) {
          reply = rewritten.trim();
          metrics.formatRewriteApplied = true;
        }
      } catch {
        // Non-critical — proceed with original reply (the linter / supervisor still run)
      }
    }

    // Profile review exit — Claude appends [[EXIT_PROFILE_REVIEW]] when the
    // family has confirmed everything looks good. Strip the token before the
    // user sees it and clear the session flag so subsequent turns get normal
    // routing. Doing this BEFORE supervise() so the supervisor never sees the
    // sentinel and accidentally "rewrites" it.
    if (reply.includes("[[EXIT_PROFILE_REVIEW]]")) {
      reply = reply.replace(/\[\[EXIT_PROFILE_REVIEW\]\]/g, "").trim();
      db.collection("agent_sessions").doc(phone).update({
        profileReviewMode:      admin.firestore.FieldValue.delete(),
        profileReviewExpiresAt: admin.firestore.FieldValue.delete(),
      }).catch(() => { /* non-critical — TTL guard in build handles stale flags */ });
    }

    // Sprint 8: log-only conversational-quality detectors. Run on the final
    // reply BEFORE supervise() rewrites it so the metrics reflect what Claude
    // actually produced, not the post-processed version. Pure observation —
    // no reply text changes.
    if (detectConfidenceClaim(reply)) {
      metrics.confidenceClaimDetected = true;
    }
    if (detectPromiseWithoutToolCall(reply, metrics.toolCalls ?? 0)) {
      metrics.promiseWithoutToolCall = true;
    }

    const preSuperviseReply = reply;
    reply = await supervise(reply, { phone, role: userType }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("qaAgent: supervisor threw, sending unsupervised", errMsg);
      const minuteBucket = new Date().toISOString().slice(0, 16);
      db.collection("admin_alerts").add({
        type:      "supervisor_fail_open",
        phone,
        userId,
        error:     errMsg.slice(0, 500),
        preview:   reply.slice(0, 200),
        source:    "qaAgent",
        dedupeKey: `supervisor_fail_open:${minuteBucket}`,
        severity:  "high",
        resolved:  false,
        createdAt: new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      return reply;
    });
    metrics.supervisorRewriteApplied = reply !== preSuperviseReply;
    metrics.exhausted = !preSuperviseReply.trim();

    // Sprint 8: postProcessModified is now DERIVED from the three discrete
    // rewrite-applied flags (kept for one sprint of dashboard compatibility).
    metrics.postProcessModified =
      !!metrics.groundingRewriteApplied ||
      !!metrics.formatRewriteApplied ||
      !!metrics.supervisorRewriteApplied;

    // Sprint 8: tone-warmth-v1 adherence proxy. Did Cara open with an empathy
    // reflection on a non-calm turn? Regex on the first sentence — cheap,
    // deterministic, no extra LLM call. Measured on the FINAL (post-supervise)
    // reply since that's what the family actually receives.
    if (metrics.emotionalContext && metrics.emotionalContext !== "calm") {
      const firstSentence = reply.split(/(?<=[.!?])\s/)[0] ?? reply;
      metrics.warmthReflectionIncluded = WARMTH_REFLECTION_OPENERS.test(firstSentence);
    }

    // Persist the lint-violation signal for the NEXT turn's persona re-inject
    // decision. Written unconditionally (true/false) so the flag doesn't go stale.
    db.collection("agent_sessions").doc(phone).update({
      recentLintViolation: metrics.postProcessModified,
    }).catch(() => { /* non-critical telemetry */ });

    await saveConversationTurn(phone, text, reply);
    if (!skipSend) await sendSplit(chatId, reply);

    // Sprint 8: turn finished cleanly — clear any checkpoint so a later inbound
    // never resumes this (now-delivered) reply. No-op if the flag is off or no
    // checkpoint was written.
    if (!skipSend) await clearCheckpoint(phone).catch(() => {});

    // After the reply is sent: fold older turns into the rolling summary so long
    // conversations stay coherent without bloating the per-turn context.
    await maybeRollUpHistory(phone);

    emitTurnMetrics(metrics, { reply });
    return reply;
  } catch (err) {
    console.error("qaAgent error:", err);
    if (skipSend) {
      emitTurnMetrics(metrics, { error: err });
      throw err;
    }
    // Don't broadcast brokenness. Send a natural-sounding deflection that
    // doesn't tell the user Cara is failing, and create an admin alert so
    // the team can follow up if needed.
    //
    // BUT: if a tool already delivered the artifact the user asked for (e.g.
    // send_onboarding_link pushed a tappable link to this chat) and the throw
    // happened afterward — while generating the confirming sentence — a
    // "give me a few minutes" deflection contradicts the link that's sitting
    // right above it. Confirm the delivery instead.
    const errMsg = deliveredToUser
      ? "There you go — tap the link I just sent to finish up. Anything else I can help with? 💙"
      : "Give me a few minutes on that — I'll come back to you shortly.";
    await sendMessage(chatId, errMsg).catch(() => {});
    db.collection("admin_alerts").add({
      type:      "qa_agent_failure",
      phone,
      userId,
      question:  text.slice(0, 300),
      error:     err instanceof Error ? err.message : String(err),
      severity:  "medium",
      createdAt: new Date().toISOString(),
      resolved:  false,
    }).catch(() => {});
    emitTurnMetrics(metrics, { reply: errMsg, error: err });
    return errMsg;
  }
}

// ── runQuickReply — gpt-4o-mini fast path for trivial messages ─────────────────
//
// Bypasses the full tool-use loop, MCP context, Zep, etc. Suitable only when:
//   - intent classified as QUESTION (Cara's default fallback bucket)
//   - text is short (≤ 30 chars)
//   - text has no entity markers (digits, @, mid-sentence proper nouns)
//
// Caller in webhooks.ts decides eligibility and falls through to runQaAgent
// when any condition fails. Saves ~3–5s on simple greetings.
export async function runQuickReply(params: {
  text:    string;
  phone:   string;
  chatId:  string;
  userId?:  string;
  seniorId?: string;
  userType?: "client" | "caregiver";
}): Promise<string> {
  const { text, phone, chatId, userId, seniorId, userType = "client" } = params;

  const metrics = createTurnMetrics({
    phone,
    userId,
    userType,
    pathway:      "quick",
    inputChannel: "USER",
  });

  // Pre-fetch lightweight context in parallel — used to make greetings smart.
  // Each loader is wrapped so a single failure doesn't break the reply.
  const [history, nextAppt, pendingTask, pendingTimesheets, activeAgent, seniorProfile] = await Promise.all([
    getConversationHistory(phone).catch(() => []),
    userType === "client" && userId ? getNextAppointment(userId).catch(() => null) : Promise.resolve(null),
    userType === "client"
      ? db.collection("agent_tasks")
          .where("clientPhone", "==", phone)
          .where("status",      "==", "awaiting_approval")
          .orderBy("createdAt", "desc")
          .limit(1)
          .get()
          .then(s => s.empty ? null : s.docs[0].data())
          .catch(() => null)
      : Promise.resolve(null),
    userType === "client" && userId
      ? db.collection("shift_hours")
          .where("clientId", "==", userId)
          .where("status",   "==", "submitted")
          .limit(1)
          .get()
          .then(s => s.empty ? 0 : s.size)
          .catch(() => 0)
      : Promise.resolve(0),
    getActiveAgentForUser(phone).catch(() => null),
    userType === "client" && seniorId ? getSeniorProfile(seniorId).catch(() => null) : Promise.resolve(null),
  ]);

  metrics.contextLoadMs = Date.now() - metrics.startedAt;

  const recent = history.slice(-4);

  // Build a context snippet listing the most relevant fact Cara could lead with.
  // Cara picks one (or none) to mention naturally — she doesn't list them all.
  const contextLines: string[] = [];
  const seniorName = (seniorProfile as any)?.name ?? "your loved one";
  if (activeAgent) {
    const goal = (activeAgent as any).goal?.description ?? "an open task";
    contextLines.push(`OPEN GOAL: You're in the middle of "${goal}" with this family — pick up where you left off.`);
  }
  if (pendingTask) {
    contextLines.push(`PENDING APPROVAL: There's a booking/task awaiting their reply ("${(pendingTask as any).summary ?? (pendingTask as any).type ?? "action needed"}").`);
  }
  if (pendingTimesheets > 0) {
    contextLines.push(`PENDING TIMESHEETS: ${pendingTimesheets} caregiver shift hours waiting for their approval.`);
  }
  if (nextAppt) {
    const caregiverName = (nextAppt as any).caregiverName ?? "their caregiver";
    const date = (nextAppt as any).date ?? "soon";
    const time = (nextAppt as any).startTime ? ` at ${(nextAppt as any).startTime}` : "";
    contextLines.push(`NEXT VISIT: ${caregiverName} is coming on ${date}${time}.`);
  }

  const contextSection = contextLines.length
    ? `\n\nKnown context (use ONE of these naturally if relevant; do NOT list them; do NOT mention items you weren't asked about unless they directly help right now):\n${contextLines.map(l => `- ${l}`).join("\n")}`
    : "";

  const persona =
    userType === "caregiver"
      ? `You ARE Cara. Speak in first person. Never refer to yourself as "Cara" in the third person, and never tell the user to "reach out to Cara" or that "a Cara team member will help" — you are Cara. You are texting a caregiver as their care-team coordinator. Keep replies short (under 200 chars), conversational, no bullet points, no emoji unless they used one first. Acknowledge briefly and move forward. If they ask for something you can't handle in this quick reply (booking, schedule changes, payments), say you're pulling that up — don't fake an answer.`
      : `You ARE Cara — an AI care assistant texting with a family caring for ${seniorName}. Speak in first person. Never refer to yourself as "Cara" in the third person, and never tell the user to "reach out to Cara" or that "a Cara team member will help" — you are Cara. Keep replies short (under 200 chars), conversational, warm. No bullet points, no headers, no markdown.\n\nWhen the family sends a pure greeting ("hi", "hey", "thanks"), DO NOT reply with "what can I help you with?" or any open-ended ask. Instead, open with the most relevant context item below if there is one — naturally, like a friend would. If there's no context to lead with, give a warm short hello like "Hey! How's everything?" — never a generic "what do you need?".\n\nExamples of good context-led greetings:\n- (after "hi" with NEXT VISIT context) "Hey! Maria's coming Thursday at 3 — anything you want me to pass along?"\n- (after "hi" with PENDING APPROVAL context) "Hey! Quick heads up — you still have that booking waiting for your yes/no. Want me to pull it up?"\n- (after "thanks" with no special context) "Anytime. 💙"${contextSection}`;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: persona },
    ...recent.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: text },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let reply: string;
  try {
    const res = await getOpenAIClient().chat.completions.create(
      {
        model:      "gpt-4o-mini",
        max_tokens: 150,
        messages,
      },
      { signal: controller.signal },
    );
    clearTimeout(timer);
    reply = (res.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    clearTimeout(timer);
    console.warn("runQuickReply error — falling back to context-aware default", err instanceof Error ? err.message : err);
    // Context-aware fallback: lead with the most useful known fact instead of
    // a generic "what can I help you with" (which is on Cara's banned list).
    if (pendingTask) reply = "Hey! You still have that booking waiting on a yes/no — want me to pull it up?";
    else if (pendingTimesheets > 0) reply = `Hey! ${pendingTimesheets > 1 ? `${pendingTimesheets} timesheets are` : "A timesheet is"} waiting for your approval whenever you're ready.`;
    else if (nextAppt) {
      const cg = (nextAppt as any).caregiverName ?? "your caregiver";
      const d = (nextAppt as any).date ?? "soon";
      reply = `Hey! ${cg} is coming ${d} — anything you want me to pass along?`;
    }
    else if (activeAgent) reply = "Hey! Picking up where we left off — give me a sec.";
    else reply = "Hey! How's everything going?";
  }

  if (!reply) reply = "Hey! How's everything going?";

  // Quick replies bypass the full supervisor (lint + constitution check) that
  // runQaAgent runs — guardOutbound is the lightweight stand-in: PII redaction
  // plus the same lint pass, no extra LLM latency. Fails open for normal text.
  const guarded = await guardOutbound(reply, {
    audience: userType === "caregiver" ? "caregiver" : "family",
    phone,
  });
  reply = guarded.text || "Hey! How's everything going?";

  await saveConversationTurn(phone, text, reply);
  await sendMessage(chatId, buildClickableMessage(reply)).catch(() => {});
  await maybeRollUpHistory(phone);
  emitTurnMetrics(metrics, { reply });
  return reply;
}

// Trivial-message eligibility check used by the webhook before runQaAgent.
// Returns true when text qualifies for the runQuickReply fast path.
//
// Conservative: only true for pure social pleasantries. Any hint of an
// action verb, a request for data, or an entity reference falls through to
// the full QA agent — which has tools to actually do things.
//
// Action verbs include words like "connect", "book", "schedule", "call",
// "hire", "find", "show", "tell" — these are all things Cara needs tools
// to do, so the bypass would just produce a generic "I'll look into it"
// reply (which is wrong; users want Cara to actually act).
const ACTION_VERBS = /\b(connect|book|schedule|call|hire|find|show|tell|send|cancel|reschedule|rebook|reschedule|approve|deny|reject|accept|update|change|set up|setup|set\s+up|search|look|check|get|give|need|want|add|remove|delete|fix|help|pay|refill|reorder|order|forward|share)\b/i;
const REQUEST_PATTERNS = /\b(yes\s+(let|please|do|go|sure|ok)|let'?s|can\s+you|could\s+you|would\s+you|please|i\s+(need|want|would)|tell\s+(me|him|her|them))\b/i;

export function isTrivialQuickReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 30) return false;
  // Any digit or @ → likely contains entity data; use full QA agent
  if (/[\d@]/.test(t)) return false;
  // Action verb or request pattern → user wants something done; use full QA agent
  if (ACTION_VERBS.test(t) || REQUEST_PATTERNS.test(t)) return false;
  // Proper noun in the middle (after the first word) suggests names/places.
  // First word can be capitalized (sentence start); subsequent ones flag it.
  const words = t.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[.,!?]/g, "");
    if (w.length > 1 && /^[A-Z][a-z]+$/.test(w)) return false;
  }
  return true;
}
