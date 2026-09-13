// Scripted, step-by-step booking flow — mirrors jobPostingFlow.ts's pattern
// (session-state field machine, one question per turn, isQuestionOrOther
// guard, parseWithClaude extraction with re-ask-never-silently-default,
// ending in a structured recap + explicit YES/NO/edit — see handleBkConfirm).
// Built 2026-09-13 after a live SMS test stalled: request_booking was only
// ever collected ad hoc inside the general qaAgent loop, so a mid-collection
// reply (e.g. "are you there") was exposed to intent-classification
// misfires (FACT_CORRECTION) instead of being captured deterministically,
// and there was no structured recap matching the website's own "Send
// Booking Request" review modal (components/client/PostsPage.tsx,
// handleSendBooking) — including that modal's own Edit affordance, which
// this flow's bk_confirm step mirrors by classifying a correction
// ("actually make it $28/hr") as its own action rather than only YES/NO.
//
// Ask/show order matches the modal's own top-to-bottom section order
// (Caregiver → Rate & Payment → Schedule → Care Recipients → Care Plan
// Details → Lifestyle & Preferences → Care Location → Emergency Contact →
// Message): Care Recipients/Care Plan Details/Lifestyle/Emergency Contact are
// never their own question (pre-filled from the care plan, same as the
// site) — only Rate & Payment, Schedule, and (when ambiguous) Care Location
// are asked, in that order, then the final recap lists every section.
//
// Deliberately requires a real starting schedule (days/times) — unlike the
// site, which can send with schedule totally unset ("Ongoing"), Evia's
// caregiver-notification path (bookingExecutor.ts's executeBookings) crashes
// on an empty appointments array. Fully-open bookings are a known,
// out-of-scope gap for a later pass.
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { businessTodayStr } from "../utils/scheduledTime";
import { normalizeCareNeeds } from "../utils/careNeedCategories";
import { isBackOutRequest } from "./stepHandler";
import {
  bookingTimeToMinutes, resolveInterviewLinkage, resolveBookingCaregiverName,
  resolveCareLocation, formatCareLocationOptions, listCareLocationOptions, resolveRecipientAttribution,
  resolveEmergencyContact, resolveTopLevelCareNeedsAndLifestyle, enrichRecipientAgeRelationship,
  listRecipientOptions, type LocationOption, type RecipientOption,
} from "./bookingResolution";

const db = admin.firestore();

// ── Session data shape ────────────────────────────────────────────────────────

export interface BookingFlowData {
  caregiverId: string;
  caregiverName: string;
  interviewId?: string;
  jobId?: string;
  jobTitle?: string;
  applicationId?: string;
  jobPostRate?: number;
  jobPostDays?: string[];
  jobPostEndDate?: string;
  hourlyRate?: number;
  scheduleKind?: "recurring" | "one_off";
  days?: string[];
  dates?: string[];
  // One-off visits only — a single shared start/end across the listed dates.
  startTime?: string;
  endTime?: string;
  // Recurring schedules only — EACH day gets its own start/end (matches the
  // site's per-day schedule builder and the real dayShiftTimes shape); never
  // a single shared time applied uniformly.
  dayTimes?: Record<string, { start: string; end: string }>;
  // Recurring schedules only — whether the arrangement is open-ended or has
  // a set end date (matches request_booking's ongoing/endDate pair and the
  // site's own recurring-booking shape). Never applies to a one-off visit.
  ongoing?: boolean;
  scheduleEndDate?: string;
  careLocation?: string;
  careLocationOptions?: LocationOption[];
  recipientName?: string;
  recipientKey?: string;
  recipientResolved?: "named" | "defaulted_all";
  careRecipients?: Array<Record<string, unknown>>;
  recipientOptions?: RecipientOption[];
  topLevelCareNeeds?: string[];
  lifestylePreferences?: string[];
  emergencyContact?: { name: string; phone: string; relationship?: string };
  // Optional note to the caregiver (matches the site's "Message to
  // {caregiver}" textarea) — never asked as its own question, only offered
  // in the recap and set via an edit at bk_confirm, same as the site never
  // forcing it.
  message?: string;
}

const BK_DIDNT_CATCH = "Sorry, I didn't quite catch that.";

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const response = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:     prompt + "\nReply with ONLY the requested value or format — no explanation, no extra text, no questions. Never invent information the user's message doesn't contain.",
      messages:   [{ role: "user", content: userText }],
    });
    const parsed = ((response.content[0] as { text: string }).text ?? "").trim();
    if (parsed) {
      const guard = caraOutputGuardEnabled() ? guardModelOutput(parsed) : { ok: true as const };
      if (!guard.ok) {
        console.warn("[bookingFlow] parseWithClaude: output guard rejected model response", { rawLength: parsed.length });
        return "__parse_error__";
      }
    }
    return parsed;
  } catch (err) {
    console.error("[bookingFlow] parseWithClaude: Anthropic call threw", err);
    return "__parse_error__";
  }
}

function parseJsonLoose(raw: string, where: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    console.warn(`[bookingFlow] ${where}: JSON.parse failed on model output`, { raw: raw.slice(0, 300) });
    return null;
  }
}

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The question Evia just asked the family was: "${currentQuestion}"\n\n` +
    "Reply NO if the family's message is ANY attempt — even a single word, a bare number, or a short/partial/vague one — " +
    "to address that specific question. A vague or incomplete attempt still counts as a direct answer. " +
    "Reply YES only if the message is a genuine question, or a comment that does not attempt to address what was asked at all. " +
    "Only reply YES or NO.",
    text
  );
  return result.toUpperCase().startsWith("Y");
}

const BK_MIDFLOW_FALLBACK = "Good question — I don't want to guess on that one.";

async function answerQuestionMidFlow(text: string, caregiverName: string): Promise<string> {
  // 2026-09-08-pattern (same fix already applied to jobPostingFlow.ts/
  // modifyScheduleFlow.ts): this sees ONLY the current message, never the
  // rest of the conversation — including anything Evia herself said earlier.
  // Must never claim something was/wasn't mentioned before, and must not
  // force an out-of-scope question into booking terms.
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a family send a booking request to a caregiver named " +
      `${caregiverName}. You see ONLY this one message, not the rest of the conversation — including anything ` +
      "Evia herself said earlier. NEVER claim something was or wasn't mentioned before; you cannot know that. " +
      "If the message is clearly about something OTHER than finishing this booking — a different topic entirely " +
      "(an interview, a different booking, billing, a job post) — do not try to answer it or guess what it's " +
      "about. Instead say plainly that it'll have to wait, e.g. \"That sounds like something else — let's finish " +
      "this first, and I'll help with that right after.\" Otherwise answer their actual question about this " +
      "booking briefly (1–2 sentences). Be warm and helpful. NEVER write out a URL or web address, and never " +
      "claim you just sent, resent, or will send a link. " + ANTI_INVENTION_CLAUSE,
    messages: [{ role: "user", content: text }],
  });
  const answer = ((response.content[0] as { text: string }).text ?? "").trim();
  if (answer && caraOutputGuardEnabled() && !guardModelOutput(answer).ok) return BK_MIDFLOW_FALLBACK;
  return answer;
}

async function getFlowData(phone: string): Promise<BookingFlowData> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return (snap.data()?.bookingFlowData ?? {}) as BookingFlowData;
}

async function mergeFlowData(phone: string, data: Partial<BookingFlowData>): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const existing = (snap.data()?.bookingFlowData ?? {}) as BookingFlowData;
  await db.collection("agent_sessions").doc(phone).update({
    bookingFlowData: { ...existing, ...data },
  });
}

async function updateStep(phone: string, step: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ bookingFlowStep: step });
}

async function clearFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    bookingFlowStep: admin.firestore.FieldValue.delete(),
    bookingFlowData: admin.firestore.FieldValue.delete(),
    stateExpiresAt:  admin.firestore.FieldValue.delete(),
  });
}

// 2026-09-13: every step below used to only recognize a cancel at the FINAL
// bk_confirm step (its own YES/NO/edit classification) — anywhere earlier,
// "never mind"/"cancel this" fell through isQuestionOrOther as an off-topic
// aside, got a brief reply, and the SAME question just re-asked itself next
// turn, with no way to actually leave. Checked FIRST in every handler below,
// ahead of isQuestionOrOther, using the same shared classifier interviewFlow.
// ts/jobPostingFlow.ts were already given this same fix with.
async function handleBookingBackOut(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await clearFlow(phone);
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: "The family decided not to send the booking request after all. Warmly confirm nothing was sent, and let them know you're here whenever they're ready.",
    fallback: "No problem — I haven't sent anything. Let me know whenever you're ready.",
    maxTokens: 70,
  }));
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function startBookingFlow(
  phone: string, chatId: string, session: AgentSession,
  args: { caregiverId: string; interviewId?: string },
): Promise<{ started: boolean; reason?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to start this booking. Please try again.");
    return { started: false, reason: "no_client_id" };
  }

  const nameRes = await resolveBookingCaregiverName(args.caregiverId);
  if (!nameRes.ok) {
    await sendMessage(chatId, "I couldn't find that caregiver to book. Can you tell me who you'd like to book?");
    return { started: false, reason: "caregiver_not_found" };
  }

  const linkage = await resolveInterviewLinkage(clientId, args.caregiverId, args.interviewId);
  const recipientAttribution = await resolveRecipientAttribution(clientId, undefined, undefined);
  const emergencyContact = await resolveEmergencyContact(clientId);

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const data: BookingFlowData = {
    caregiverId:   args.caregiverId,
    caregiverName: nameRes.caregiverName,
    ...(args.interviewId ? { interviewId: args.interviewId } : {}),
    ...(linkage.jobId ? { jobId: linkage.jobId } : {}),
    ...(linkage.jobTitle ? { jobTitle: linkage.jobTitle } : {}),
    ...(linkage.applicationId ? { applicationId: linkage.applicationId } : {}),
    ...(linkage.jobPostRate !== undefined ? { jobPostRate: linkage.jobPostRate } : {}),
    ...(linkage.jobPostSchedule?.daysOfWeek?.length ? { jobPostDays: linkage.jobPostSchedule.daysOfWeek } : {}),
    ...(linkage.jobPostSchedule?.endDate ? { jobPostEndDate: linkage.jobPostSchedule.endDate } : {}),
    ...(recipientAttribution.recipientName ? { recipientName: recipientAttribution.recipientName } : {}),
    ...(recipientAttribution.recipientKey ? { recipientKey: recipientAttribution.recipientKey } : {}),
    ...(recipientAttribution.recipientResolved ? { recipientResolved: recipientAttribution.recipientResolved } : {}),
    ...(recipientAttribution.careRecipients ? { careRecipients: recipientAttribution.careRecipients } : {}),
    ...(emergencyContact ? { emergencyContact } : {}),
  };

  await db.collection("agent_sessions").doc(phone).update({
    bookingFlowStep: "bk_ask_rate",
    bookingFlowData: data,
    stateExpiresAt:  expiresAt,
  });

  // Rate is ALWAYS asked explicitly, matching the site's own "RATE & PAYMENT
  // — Required" — the modal never treats a job post's listed rate as
  // already-agreed; the field shows Required (empty) regardless. A known
  // job-post rate is offered as a suggestion in the question, never silently
  // assumed.
  await sendMessage(chatId, `Let's get a booking request over to ${nameRes.caregiverName}!`);
  await sendMessage(chatId, RATE_QUESTION(data.jobPostRate));
  return { started: true };
}

// ── Step dispatch ─────────────────────────────────────────────────────────────

export async function handleBookingFlowStep(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const step = (session as any).bookingFlowStep as string ?? "";
  switch (step) {
    case "bk_ask_rate":     return handleBkAskRate(phone, chatId, text, session);
    case "bk_ask_days":     return handleBkAskDays(phone, chatId, text, session);
    case "bk_ask_times":    return handleBkAskTimes(phone, chatId, text, session);
    case "bk_ask_ongoing":  return handleBkAskOngoing(phone, chatId, text, session);
    case "bk_ask_location": return handleBkAskLocation(phone, chatId, text, session);
    case "bk_ask_recipients": return handleBkAskRecipients(phone, chatId, text, session);
    case "bk_ask_message":  return handleBkAskMessage(phone, chatId, text, session);
    case "bk_confirm":      return handleBkConfirm(phone, chatId, text, session);
    default:
      // Shouldn't happen (the flow always sets a step when active), but
      // fail safe rather than throw on an unrecognized/stale step value.
      await sendMessage(chatId, RATE_QUESTION());
  }
}

// ── Step: rate ────────────────────────────────────────────────────────────────

// ALWAYS asked, even when a linked job post has a listed rate — matches the
// site's own "RATE & PAYMENT — Required" (the modal never treats a job
// post's rate as already-agreed; it shows Required/empty regardless). A
// known job-post rate is offered as a suggestion, never silently assumed.
const RATE_QUESTION = (jobPostRate?: number) =>
  `What hourly rate are you offering for this booking?` +
  (jobPostRate ? ` (Your job post lists $${jobPostRate}/hr — reply with that, or a different amount.)` : "");

async function handleBkAskRate(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  if (await isBackOutRequest(text)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);
  const question = RATE_QUESTION(data.jobPostRate);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }
  const raw = await parseWithClaude(
    "Extract the hourly rate as a number (e.g. \"$20\", \"18 an hour\" → 18). Reply with only the number.",
    text
  );
  const rate = parseFloat(raw);
  if (isNaN(rate) || rate <= 0) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${question}`);
    return;
  }
  await mergeFlowData(phone, { hourlyRate: rate });
  const updated = await getFlowData(phone);
  await advanceToDays(phone, chatId, updated);
}

async function advanceToDays(phone: string, chatId: string, data: BookingFlowData): Promise<void> {
  // ALWAYS asked, even when a job post already lists days — matches the
  // site's own behavior of never treating anything as already-agreed
  // without the family seeing and confirming it (same principle as the rate
  // fix above). A known job-post day list is offered as a suggestion in the
  // question, never silently assumed.
  await updateStep(phone, "bk_ask_days");
  await sendMessage(chatId, `Got it — $${data.hourlyRate}/hr! ${DAYS_QUESTION(data.jobPostDays)}`);
}

// ── Step: days (recurring weekdays OR a specific date) ───────────────────────

const DAYS_QUESTION = (jobPostDays?: string[]) =>
  "What days would you like this to start with — a recurring weekly schedule (e.g. \"every Tue and Thu\"), " +
  "or a specific one-off visit (e.g. \"this Friday\")?" +
  (jobPostDays?.length ? ` (Your job post lists ${jobPostDays.join(", ")} — reply with that, or different days.)` : "");

async function handleBkAskDays(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  if (await isBackOutRequest(text)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);
  const question = DAYS_QUESTION(data.jobPostDays);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }

  const today = businessTodayStr();
  const raw = await parseWithClaude(
    `Today is ${today}. Classify what the family wants for a caregiver booking's schedule. ` +
    'Return ONLY a JSON object: {"kind": "recurring" | "one_off" | "unclear", ' +
    '"days": ["Monday", ...] (recurring only, full weekday names — "weekdays"=Mon-Fri, "every Tue and Thu"=[Tuesday,Thursday]), ' +
    '"dates": ["YYYY-MM-DD", ...] (one_off only, resolved relative to today)}. ' +
    '"unclear" if the message doesn\'t clearly pick either. Never invent days/dates the message doesn\'t support.',
    text
  );
  const parsed = parseJsonLoose(raw, "handleBkAskDays");
  const kind = parsed?.kind;
  if (kind === "recurring" && Array.isArray(parsed.days) && parsed.days.length > 0) {
    await mergeFlowData(phone, { scheduleKind: "recurring", days: parsed.days });
    await updateStep(phone, "bk_ask_times");
    await sendMessage(chatId, `${parsed.days.join(", ")} — got it! ${TIMES_QUESTION(parsed.days)}`);
    return;
  }
  if (kind === "one_off" && Array.isArray(parsed.dates) && parsed.dates.length > 0) {
    await mergeFlowData(phone, { scheduleKind: "one_off", dates: parsed.dates });
    await updateStep(phone, "bk_ask_times");
    await sendMessage(chatId, `${parsed.dates.join(", ")} — got it! What time should the visit run? (e.g. "9am to 3pm")`);
    return;
  }
  await sendMessage(chatId, `${BK_DIDNT_CATCH} ${question}`);
}

// ── Step: times (recurring schedules require a start/end for EVERY day) ─────

const TIMES_QUESTION = (days: string[]) =>
  days.length > 1
    ? `What time should each day run? One time for all works (e.g. "9am to 5pm"), or different times per day ` +
      `(e.g. "${days[0]} 9am-5pm, ${days[1]} 10am-2pm") — every day needs its own start and end time.`
    : `What time should this run? (e.g. "9am to 3pm")`;

async function handleBkAskTimes(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  if (await isBackOutRequest(text)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);
  const days = data.days ?? [];
  const question = data.scheduleKind === "recurring" ? TIMES_QUESTION(days) : `What time should the visit run? (e.g. "9am to 3pm")`;
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }

  if (data.scheduleKind === "one_off") {
    const rawStart = await parseWithClaude(
      'Extract the START time from this message. Return HH:MM in 24-hour format (e.g. "9am" → "09:00"). Return only the time string.',
      text
    );
    const rawEnd = await parseWithClaude(
      'Extract the END time from this message. Return HH:MM in 24-hour format (e.g. "3pm" → "15:00"). Return only the time string.',
      text
    );
    const startMin = bookingTimeToMinutes(rawStart);
    const endMin   = bookingTimeToMinutes(rawEnd);
    if (startMin === null || endMin === null || endMin <= startMin) {
      await sendMessage(chatId, `${BK_DIDNT_CATCH} ${question}`);
      return;
    }
    await mergeFlowData(phone, { startTime: rawStart, endTime: rawEnd });
    await advanceFromTimes(phone, chatId, session);
    return;
  }

  // Recurring — every day needs its OWN start/end (matches the site's
  // per-day schedule builder, dayShiftTimes). A message giving one shared
  // time is applied to every day; the model is instructed to do that, but
  // EVERY day must still come back with a valid, real start/end — a
  // partially-answered set re-asks rather than silently leaving days blank.
  const raw = await parseWithClaude(
    `The family's recurring days are: ${days.join(", ")}. Extract the start/end time for EVERY one of these days. ` +
    "If the family gave a single time for all days, apply it to every day listed. " +
    'Return ONLY a JSON object mapping each day name to {"start":"HH:MM","end":"HH:MM"} in 24-hour format, e.g. ' +
    '{"Monday":{"start":"09:00","end":"17:00"},"Wednesday":{"start":"10:00","end":"14:00"}}. Include EVERY day ' +
    "listed above — never omit one, never invent a day not listed or a time not stated/implied.",
    text
  );
  const parsed = parseJsonLoose(raw, "handleBkAskTimes");
  const dayTimes: Record<string, { start: string; end: string }> = {};
  let allValid = Boolean(parsed);
  for (const d of days) {
    const entry = parsed?.[d];
    const startMin = bookingTimeToMinutes(entry?.start);
    const endMin   = bookingTimeToMinutes(entry?.end);
    if (startMin === null || endMin === null || endMin <= startMin) { allValid = false; break; }
    dayTimes[d] = { start: entry.start, end: entry.end };
  }
  if (!allValid) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${question}`);
    return;
  }
  await mergeFlowData(phone, { dayTimes });
  await advanceFromTimes(phone, chatId, session);
}

// ── Step: ongoing vs. a set end date (recurring schedules only) ─────────────

const ONGOING_QUESTION =
  "Is this an ongoing arrangement with no end date, or does it have a specific end date? " +
  "(e.g. \"ongoing\" or \"through December 1\")";

async function advanceFromTimes(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  if (data.scheduleKind !== "recurring") {
    return advanceToLocation(phone, chatId, session);
  }
  if (data.jobPostEndDate) {
    // Matches request_booking's own existing fallback — a job post with a
    // real end date on file is used silently, never re-asked.
    await mergeFlowData(phone, { ongoing: false, scheduleEndDate: data.jobPostEndDate });
    return advanceToLocation(phone, chatId, session);
  }
  await updateStep(phone, "bk_ask_ongoing");
  await sendMessage(chatId, ONGOING_QUESTION);
}

async function handleBkAskOngoing(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  if (await isBackOutRequest(text)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);
  if (await isQuestionOrOther(text, ONGOING_QUESTION)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, ONGOING_QUESTION);
    return;
  }
  const today = businessTodayStr();
  const raw = await parseWithClaude(
    `Today is ${today}. Does the family want this recurring arrangement to be ongoing (no end date), or does it ` +
    'have a specific end date? Return ONLY a JSON object: {"ongoing": true or false, "endDate": "YYYY-MM-DD" or ' +
    'null — required when ongoing is false, resolved relative to today}. Never invent a date the message doesn\'t support.',
    text
  );
  const parsed = parseJsonLoose(raw, "handleBkAskOngoing");
  if (parsed?.ongoing === true) {
    await mergeFlowData(phone, { ongoing: true });
    return advanceToLocation(phone, chatId, session);
  }
  if (parsed?.ongoing === false && typeof parsed.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.endDate)) {
    await mergeFlowData(phone, { ongoing: false, scheduleEndDate: parsed.endDate });
    return advanceToLocation(phone, chatId, session);
  }
  await sendMessage(chatId, `${BK_DIDNT_CATCH} ${ONGOING_QUESTION}`);
}

// ── Step: location (only asked when ambiguous) ───────────────────────────────

async function advanceToLocation(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const clientId = session.userId as string | undefined;
  const locRes = clientId ? await resolveCareLocation(clientId, undefined) : { ok: false as const, ambiguous: false as const, reason: "" };
  if (locRes.ok) {
    await mergeFlowData(phone, { careLocation: locRes.location });
    return advanceToConfirm(phone, chatId, session);
  }
  if (locRes.ambiguous) {
    await mergeFlowData(phone, { careLocationOptions: locRes.options });
    await updateStep(phone, "bk_ask_location");
    await sendMessage(chatId,
      `Which address is this for?\n\n${formatCareLocationOptions(locRes.options)}\n\n` +
      "Reply with a number, or mention which one (e.g. by the smoking/pets tag)."
    );
    return;
  }
  // No address on file at all and none resolvable — ask for it directly.
  await updateStep(phone, "bk_ask_location");
  await mergeFlowData(phone, { careLocationOptions: [] });
  await sendMessage(chatId, "Where will this care take place? (street address + zip)");
}

// Explicit "change the address" edit from bk_confirm — unlike advanceToLocation,
// this always shows the real options (even just one) rather than silently
// re-picking the same on-file address, since the whole point is to change it.
async function promptLocationEdit(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const clientId = session.userId as string | undefined;
  const options = clientId ? await listCareLocationOptions(clientId) : [];
  await mergeFlowData(phone, { careLocationOptions: options });
  await updateStep(phone, "bk_ask_location");
  await sendMessage(chatId,
    options.length
      ? `Which address should this be instead?\n\n${formatCareLocationOptions(options)}\n\nReply with a number, or a new street address + zip.`
      : "Where should this care take place instead? (street address + zip)"
  );
}

// ── Step: recipients (only reached via an explicit edit) ─────────────────────
// Never asked during initial collection (pre-filled to every household
// recipient, matching the site's default) — only reachable by saying "change
// who this is for" at bk_confirm, mirroring the site's own Care Recipients
// section, where any card can be selected or deselected, not just all-or-
// nothing.

function formatRecipientOptions(options: RecipientOption[]): string {
  return options.map((o, i) => `${i + 1}) ${o.name}`).join("\n");
}

async function promptRecipientEdit(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const clientId = session.userId as string | undefined;
  const options = clientId ? await listRecipientOptions(clientId) : [];
  await mergeFlowData(phone, { recipientOptions: options });
  await updateStep(phone, "bk_ask_recipients");
  await sendMessage(chatId,
    options.length
      ? `Who should this booking be for?\n\n${formatRecipientOptions(options)}\n\nReply with one or more numbers (e.g. "1, 2").`
      : "Who is this booking for?"
  );
}

// Applies a new recipient selection: re-derives careRecipients/recipientKey/
// recipientName via the same resolver used at flow start, then recomputes
// the fields that depend on it (care-needs union, lifestyle tags, age/
// relationship) before returning to the recap.
async function applyRecipientSelection(phone: string, chatId: string, session: AgentSession, names: string[]): Promise<void> {
  const clientId = session.userId as string | undefined;
  if (!clientId || !names.length) return;
  const attribution = await resolveRecipientAttribution(
    clientId,
    names.length === 1 ? names[0] : undefined,
    names.length > 1 ? names : undefined,
  );
  await mergeFlowData(phone, {
    careRecipients:    attribution.careRecipients,
    recipientName:     attribution.recipientName,
    recipientKey:      attribution.recipientKey,
    recipientResolved: attribution.recipientResolved,
  });
  const data = await refreshDerivedRecipientFields(phone, clientId);
  await updateStep(phone, "bk_confirm");
  await sendMessage(chatId, buildBookingRecap(data));
}

async function handleBkAskRecipients(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  if (await isBackOutRequest(text)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);
  const options = data.recipientOptions ?? [];
  const QUESTION = options.length
    ? `Who should this booking be for?\n\n${formatRecipientOptions(options)}`
    : "Who is this booking for?";
  if (await isQuestionOrOther(text, QUESTION)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, QUESTION);
    return;
  }
  if (!options.length) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${QUESTION}`);
    return;
  }
  const raw = await parseWithClaude(
    `Known recipients:\n${formatRecipientOptions(options)}\n\n` +
    'Which of the numbered recipients above does the family want this booking for (one or more)? Return ONLY a ' +
    'JSON array of the selected numbers, e.g. [1,3]. Never invent a selection the message doesn\'t support.',
    text
  );
  const parsed = parseJsonLoose(raw, "handleBkAskRecipients");
  const selected: number[] = Array.isArray(parsed)
    ? parsed.filter((n: unknown): n is number => typeof n === "number" && n >= 1 && n <= options.length)
    : [];
  if (!selected.length) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${QUESTION}`);
    return;
  }
  await applyRecipientSelection(phone, chatId, session, selected.map((i) => options[i - 1].name));
}

// ── Step: message note ────────────────────────────────────────────────────────
// Proactively asked once, right before the final recap (matches the site's
// modal position — Message to {caregiver} sits right above Send) — Hamse
// asked for this to be actively brought up rather than left as a passive
// recap line, in case the family has something specific to mention. Optional
// either way: a plain decline ("no"/"skip") moves straight to the recap with
// no note attached, same as leaving the site's textarea empty.

const MESSAGE_QUESTION = (caregiverName: string) =>
  `Want to include a note for ${caregiverName}? Reply with what you'd like to say, or "no" to skip.`;

async function handleBkAskMessage(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  if (await isBackOutRequest(text)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);
  const QUESTION = MESSAGE_QUESTION(data.caregiverName);
  if (await isQuestionOrOther(text, QUESTION)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, QUESTION);
    return;
  }
  const decision = await parseWithClaude(
    'Is the family declining/skipping a note ("no", "skip", "nothing", "nope", "no thanks", "not needed"), or is ' +
    "this message itself the note they want sent to the caregiver? Reply with exactly SKIP or NOTE.",
    text
  );
  if (decision.toUpperCase().startsWith("SKIP")) {
    await updateStep(phone, "bk_confirm");
    const updated = await getFlowData(phone);
    await sendMessage(chatId, buildBookingRecap(updated));
    return;
  }
  const trimmed = text.trim().slice(0, 500);
  if (!trimmed) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${QUESTION}`);
    return;
  }
  await mergeFlowData(phone, { message: trimmed });
  await updateStep(phone, "bk_confirm");
  const updated = await getFlowData(phone);
  await sendMessage(chatId, buildBookingRecap(updated));
}

async function handleBkAskLocation(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  if (await isBackOutRequest(text)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);
  const options = data.careLocationOptions ?? [];
  const QUESTION = options.length
    ? `Which address is this for?\n\n${formatCareLocationOptions(options)}`
    : "Where will this care take place? (street address + zip)";
  if (await isQuestionOrOther(text, QUESTION)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, QUESTION);
    return;
  }

  if (options.length) {
    const raw = await parseWithClaude(
      `Known addresses:\n${formatCareLocationOptions(options)}\n\n` +
      "Match the family's reply to ONE of the numbered addresses above, OR extract a NEW street address if they " +
      'gave one not on the list. Return ONLY a JSON object: {"matchedIndex": number or null, "newAddress": string ' +
      "or null}. Never invent a match or an address.",
      text
    );
    const parsed = parseJsonLoose(raw, "handleBkAskLocation");
    const idx = typeof parsed?.matchedIndex === "number" ? parsed.matchedIndex : null;
    if (idx && idx >= 1 && idx <= options.length) {
      const a = options[idx - 1];
      const location = [a.street, a.city, a.state, a.zipCode].filter(Boolean).join(", ");
      await mergeFlowData(phone, { careLocation: location });
      return advanceToConfirm(phone, chatId, session);
    }
    if (typeof parsed?.newAddress === "string" && parsed.newAddress.trim().length >= 5) {
      await mergeFlowData(phone, { careLocation: parsed.newAddress.trim() });
      return advanceToConfirm(phone, chatId, session);
    }
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${QUESTION}`);
    return;
  }

  // Free-typed address (no saved options at all).
  const trimmed = text.trim();
  if (trimmed.length < 5) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${QUESTION}`);
    return;
  }
  await mergeFlowData(phone, { careLocation: trimmed });
  await advanceToConfirm(phone, chatId, session);
}

// ── Confirm / recap ───────────────────────────────────────────────────────────

// Recomputes the fields derived from WHICH recipients/location are currently
// selected (top-level care-needs union, address pet/smoking tags, per-
// recipient age+relationship) — shared by the initial advance into
// bk_confirm and by any later edit that changes recipients or location,
// since both invalidate the same derived fields.
async function refreshDerivedRecipientFields(phone: string, clientId: string | undefined): Promise<BookingFlowData> {
  let data = await getFlowData(phone);
  if (clientId && data.careLocation) {
    const { topLevelCareNeeds, lifestylePreferences } =
      await resolveTopLevelCareNeedsAndLifestyle(clientId, data.careRecipients, data.recipientKey, data.careLocation);
    const enrichedRecipients = await enrichRecipientAgeRelationship(clientId, data.careRecipients);
    await mergeFlowData(phone, {
      ...(topLevelCareNeeds ? { topLevelCareNeeds } : {}),
      ...(lifestylePreferences ? { lifestylePreferences } : {}),
      ...(enrichedRecipients ? { careRecipients: enrichedRecipients } : {}),
    });
    data = await getFlowData(phone);
  }
  return data;
}

async function advanceToConfirm(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const clientId = session.userId as string | undefined;
  const data = await refreshDerivedRecipientFields(phone, clientId);
  // Proactively ask about a note ONCE, right before the recap (matches the
  // site's modal position, right above Send) — optional either way, "no"/
  // "skip" moves straight on. Only fires on this first arrival at confirm;
  // edits that return to bk_confirm later go straight to buildBookingRecap.
  await updateStep(phone, "bk_ask_message");
  await sendMessage(chatId, MESSAGE_QUESTION(data.caregiverName));
}

// Mirrors the website's own "Send Booking Request" review modal section
// order: Caregiver, Rate & Payment, Schedule, Care Recipients, Care Plan
// Details (each recipient's OWN care needs — the modal shows a separate
// card per person, not one flattened list, so this does too), Lifestyle &
// Preferences, Care Location, Emergency Contact, Message.
// Per-recipient lifestyle object shape, per update_care_plan's own field
// description: a partial object of any of {favoriteActivities[],
// entertainment[], enjoysConversation, prefersQuiet, familyInArea,
// familyVisitFreq, friendsVisitors, friendsVisitFreq, hasAppointments,
// appointmentsDetails}. Renders only the keys actually set.
function formatRecipientLifestyle(lifestyle: unknown): string {
  if (!lifestyle || typeof lifestyle !== "object") return "";
  const l = lifestyle as Record<string, unknown>;
  const parts: string[] = [];
  const activities = Array.isArray(l.favoriteActivities) ? (l.favoriteActivities as string[]) : [];
  if (activities.length) parts.push(`enjoys ${activities.join(", ")}`);
  const entertainment = Array.isArray(l.entertainment) ? (l.entertainment as string[]) : [];
  if (entertainment.length) parts.push(`likes ${entertainment.join(", ")}`);
  if (l.enjoysConversation === true) parts.push("enjoys conversation");
  if (l.prefersQuiet === true) parts.push("prefers quiet");
  if (l.familyInArea === true) parts.push(`family in area${l.familyVisitFreq ? ` (visits ${l.familyVisitFreq})` : ""}`);
  if (l.friendsVisitors === true) parts.push(`friends visit${l.friendsVisitFreq ? ` ${l.friendsVisitFreq}` : ""}`);
  if (l.hasAppointments === true) parts.push(`has appointments${l.appointmentsDetails ? `: ${l.appointmentsDetails}` : ""}`);
  return parts.join("; ");
}

export function buildBookingRecap(data: BookingFlowData): string {
  const spanLine = data.ongoing ? "(ongoing)" : data.scheduleEndDate ? `(through ${data.scheduleEndDate})` : "";
  const scheduleLine = data.scheduleKind === "recurring"
    ? `${(data.days ?? []).map((d) => {
        const t = data.dayTimes?.[d];
        return t ? `${d} ${t.start}–${t.end}` : d;
      }).join(", ")} ${spanLine}`
    : `${(data.dates ?? []).join(", ")}, ${data.startTime}–${data.endTime}`;

  const recipientLines: string[] = [];
  if (data.careRecipients?.length) {
    for (const r of data.careRecipients) {
      const name = String(r.name ?? "");
      const rel  = r.relationship ? ` (${r.relationship}${r.age ? `, Age ${r.age}` : ""})` : "";
      const needs = Array.isArray(r.careNeeds) && r.careNeeds.length ? (r.careNeeds as string[]).join(", ") : "General care";
      const lifestyle = formatRecipientLifestyle(r.lifestyle);
      const notes = typeof r.notes === "string" ? r.notes.trim() : "";
      recipientLines.push(`- ${name}${rel}: ${needs}`);
      recipientLines.push(`  Notes: ${notes || "None"}`);
      recipientLines.push(`  Lifestyle: ${lifestyle || "Not specified"}`);
    }
  } else {
    const needs = data.topLevelCareNeeds?.length ? data.topLevelCareNeeds.join(", ") : "General care";
    recipientLines.push(`- ${data.recipientName ?? "your household"}: ${needs}`);
  }

  // Address pet/smoking tags travel with the location line (matches the
  // original one-line preview's `at {location} ({tags})` shape) — this is a
  // property attribute, not a per-recipient preference, so it's kept
  // separate from each recipient's own Lifestyle line above.
  const locationTags = data.lifestylePreferences?.length ? ` (${data.lifestylePreferences.join(", ")})` : "";
  const ec = data.emergencyContact;
  const ecLine = ec?.phone ? `${ec.name || "On file"}${ec.relationship ? ` (${ec.relationship})` : ""} — ${ec.phone}` : "Not on file";
  const messageLine = data.message ? `"${data.message}"` : "None — reply with a note if you'd like to add one";

  return [
    `Here's your booking request:`,
    ``,
    `Caregiver: ${data.caregiverName}`,
    `Agreed rate: $${data.hourlyRate}/hr`,
    `Schedule: ${scheduleLine}`,
    `Care recipients:`,
    ...recipientLines,
    `Care location: ${data.careLocation}${locationTags}`,
    `Emergency contact: ${ecLine}`,
    `Message to ${data.caregiverName}: ${messageLine}`,
    ``,
    `Reply YES to send it to ${data.caregiverName}, or NO to cancel.`,
  ].join("\n");
}

const CONFIRM_QUESTION_FALLBACK = "Confirming whether to send this booking request — reply YES to send it, or NO to cancel.";

// Mirrors the site's own Edit button (which reveals every section for
// in-place changes rather than forcing a cancel-and-restart) — added
// 2026-09-13 after Hamse asked whether the recap supported editing. A
// correction ("actually make it $28/hr") is classified here as its own
// action, distinct from YES/NO/a genuine question, so it never gets
// mis-routed into the mid-flow question answerer or silently ignored.
async function handleBkConfirm(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  if (await isBackOutRequest(text)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);

  const raw = await parseWithClaude(
    "The family is reviewing a booking request summary before it sends. Classify their reply. Return ONLY a JSON " +
    'object: {"action": "confirm" | "cancel" | "edit_rate" | "edit_schedule" | "edit_location" | "edit_recipients" ' +
    '| "edit_care_needs" | "edit_lifestyle" | "edit_notes" | "edit_message" | "other", "newRate": number or null, ' +
    '"recipientNames": array of first names or null, "newMessage": string or null, "careNeedsRecipient": first ' +
    'name or null, "addCareNeeds": array of care need phrases or null, "removeCareNeeds": array of care need ' +
    'phrases or null, "lifestyleRecipient": first name or null, "lifestyleText": string or null, ' +
    '"notesRecipient": first name or null, "notesText": string or null}. ' +
    '"confirm" = yes/send it/go ahead/looks good. "cancel" = no/never mind/stop. ' +
    '"edit_rate" = wants to change the hourly rate/price — set newRate to the new dollar amount ONLY if this ' +
    "exact message states one, else null. " +
    '"edit_schedule" = wants to change the days/times/how long the arrangement runs. ' +
    '"edit_location" = wants to change the address/where care happens. ' +
    '"edit_recipients" = wants to change WHO this booking is for (add/remove/limit to specific people) — set ' +
    "recipientNames to the first names actually stated in THIS message, else null. " +
    '"edit_care_needs" = wants to add or remove a specific CARE NEED/task (e.g. "add mobility assistance for ' +
    'Samira", "remove bathing") rather than change who the booking covers — set careNeedsRecipient to whose needs ' +
    "this is about if a name is stated (else null), and addCareNeeds/removeCareNeeds to the care need phrases " +
    "actually mentioned (else null). " +
    '"edit_lifestyle" = wants to add/update LIFESTYLE & PREFERENCES info (favorite activities, whether they enjoy ' +
    "conversation or prefer quiet, family/friends visiting, upcoming appointments — NOT a care need/task) — set " +
    "lifestyleRecipient to whose preferences this is about if a name is stated (else null), and lifestyleText to " +
    "the exact preference details stated, else null. " +
    '"edit_notes" = wants to add/change a general free-text NOTE about a care recipient (e.g. "add a note that ' +
    'she likes to go shopping") — distinct from a care need/task or a lifestyle preference — set notesRecipient ' +
    "to whose note this is if a name is stated (else null), and notesText to the exact note content stated, else " +
    "null. " +
    '"edit_message" = wants to add/change the note sent to the CAREGIVER (not a note about the care recipient) — ' +
    "set newMessage to the exact text stated, else null. " +
    '"other" = a genuine question, or anything that isn\'t a decision or a change to one of those things. ' +
    "Never invent a rate, name, note, care need, or preference the message doesn't state.",
    text
  );
  const parsed = parseJsonLoose(raw, "handleBkConfirm");
  const action = parsed?.action;

  if (action === "cancel") return handleBookingBackOut(phone, chatId, session);

  if (action === "edit_rate") {
    if (typeof parsed?.newRate === "number" && parsed.newRate > 0) {
      await mergeFlowData(phone, { hourlyRate: parsed.newRate });
      const updated = await getFlowData(phone);
      await sendMessage(chatId, `Got it — $${parsed.newRate}/hr.`);
      await sendMessage(chatId, buildBookingRecap(updated));
      return;
    }
    await updateStep(phone, "bk_ask_rate");
    await sendMessage(chatId, RATE_QUESTION(data.jobPostRate));
    return;
  }

  if (action === "edit_schedule") {
    // Full redo (matches the site's Edit button revealing the whole
    // Schedule section at once) — the next real answer at each step simply
    // overwrites days/times/ongoing/scheduleEndDate the same way it does
    // during initial collection, so nothing needs clearing here.
    await updateStep(phone, "bk_ask_days");
    await sendMessage(chatId, "No problem — let's redo the schedule.");
    await sendMessage(chatId, DAYS_QUESTION(data.jobPostDays));
    return;
  }

  if (action === "edit_location") {
    await promptLocationEdit(phone, chatId, session);
    return;
  }

  if (action === "edit_recipients") {
    const names = Array.isArray(parsed?.recipientNames)
      ? (parsed.recipientNames as unknown[]).map(String).filter(Boolean)
      : [];
    if (names.length) {
      await applyRecipientSelection(phone, chatId, session, names);
      return;
    }
    await promptRecipientEdit(phone, chatId, session);
    return;
  }

  if (action === "edit_care_needs") {
    const addRaw = Array.isArray(parsed?.addCareNeeds) ? (parsed.addCareNeeds as unknown[]).map(String) : [];
    const removeRaw = Array.isArray(parsed?.removeCareNeeds) ? (parsed.removeCareNeeds as unknown[]).map(String) : [];
    if (!addRaw.length && !removeRaw.length) {
      await sendMessage(chatId, "What care need would you like to add or remove?");
      return;
    }
    const recipients = data.careRecipients ?? [];
    let targetIndex = 0;
    if (recipients.length > 1) {
      const stated = typeof parsed?.careNeedsRecipient === "string" ? parsed.careNeedsRecipient.trim().toLowerCase() : "";
      const idx = stated ? recipients.findIndex((r) => String(r.name ?? "").toLowerCase().startsWith(stated)) : -1;
      if (idx === -1) {
        await sendMessage(chatId, `Whose care needs would you like to change — ${recipients.map((r) => r.name).join(" or ")}?`);
        return;
      }
      targetIndex = idx;
    }
    const addNeeds    = addRaw.length ? normalizeCareNeeds(addRaw) : [];
    const removeNeeds = removeRaw.length ? normalizeCareNeeds(removeRaw) : [];

    // Single-household fallback shape (no per-recipient careRecipients array
    // at all) — edit the flat topLevelCareNeeds list directly.
    if (!recipients.length) {
      const merged = new Set(data.topLevelCareNeeds ?? []);
      for (const n of addNeeds) merged.add(n);
      for (const n of removeNeeds) merged.delete(n);
      await mergeFlowData(phone, { topLevelCareNeeds: Array.from(merged) });
      const updated = await getFlowData(phone);
      await sendMessage(chatId, buildBookingRecap(updated));
      return;
    }

    const updatedRecipients = recipients.map((r, i) => {
      if (i !== targetIndex) return r;
      const existing = Array.isArray(r.careNeeds) ? (r.careNeeds as string[]) : [];
      const merged = new Set(existing);
      for (const n of addNeeds) merged.add(n);
      for (const n of removeNeeds) merged.delete(n);
      return { ...r, careNeeds: Array.from(merged) };
    });
    // Top-level careNeeds is a deduped union across every recipient (matches
    // the website's own booking_requests shape) — recomputed in-memory here,
    // no DB re-fetch needed since it's purely derived from careRecipients.
    const topLevelCareNeeds = Array.from(new Set(
      updatedRecipients.flatMap((r) => (Array.isArray(r.careNeeds) ? (r.careNeeds as string[]) : [])),
    ));
    await mergeFlowData(phone, { careRecipients: updatedRecipients, topLevelCareNeeds });
    const updated = await getFlowData(phone);
    await sendMessage(chatId, buildBookingRecap(updated));
    return;
  }

  if (action === "edit_lifestyle") {
    const lifestyleText = typeof parsed?.lifestyleText === "string" ? parsed.lifestyleText.trim() : "";
    if (!lifestyleText) {
      await sendMessage(chatId, "What would you like to add for lifestyle & preferences?");
      return;
    }
    const recipients = data.careRecipients ?? [];
    if (!recipients.length) {
      // No per-recipient care plan on file to attach this to (fail-soft —
      // shouldn't normally happen once resolveRecipientAttribution always
      // populates careRecipients).
      await sendMessage(chatId, "I couldn't find a care plan to update that on — reply YES to send as-is, or NO to cancel.");
      return;
    }
    let targetIndex = 0;
    if (recipients.length > 1) {
      const stated = typeof parsed?.lifestyleRecipient === "string" ? parsed.lifestyleRecipient.trim().toLowerCase() : "";
      const idx = stated ? recipients.findIndex((r) => String(r.name ?? "").toLowerCase().startsWith(stated)) : -1;
      if (idx === -1) {
        await sendMessage(chatId, `Whose lifestyle & preferences would you like to update — ${recipients.map((r) => r.name).join(" or ")}?`);
        return;
      }
      targetIndex = idx;
    }
    // Structures the free text into the same partial-lifestyle shape
    // update_care_plan already uses, so this stays consistent with how the
    // rest of Evia edits this same field outside the booking flow.
    const raw = await parseWithClaude(
      'Extract lifestyle & preference details from this message into a partial JSON object using ONLY these keys ' +
      '(omit any not mentioned): {"favoriteActivities": string[], "entertainment": string[], ' +
      '"enjoysConversation": boolean, "prefersQuiet": boolean, "familyInArea": boolean, "familyVisitFreq": string, ' +
      '"friendsVisitors": boolean, "friendsVisitFreq": string, "hasAppointments": boolean, "appointmentsDetails": ' +
      "string}. Return ONLY the JSON object. Never invent details the message doesn't state.",
      lifestyleText,
    );
    const parsedLifestyle = (parseJsonLoose(raw, "handleBkConfirm.lifestyle") ?? {}) as Record<string, unknown>;
    const updatedRecipients = recipients.map((r, i) => {
      if (i !== targetIndex) return r;
      const existing = (r.lifestyle && typeof r.lifestyle === "object") ? (r.lifestyle as Record<string, unknown>) : {};
      const merged: Record<string, unknown> = { ...existing };
      for (const [key, value] of Object.entries(parsedLifestyle)) {
        if (value === null || value === undefined) continue;
        // Array fields (favoriteActivities/entertainment) union with
        // whatever's already there; scalar fields (booleans/strings) replace.
        if (Array.isArray(value)) {
          const existingArr = Array.isArray(existing[key]) ? (existing[key] as unknown[]) : [];
          merged[key] = Array.from(new Set([...existingArr, ...value]));
        } else {
          merged[key] = value;
        }
      }
      return { ...r, lifestyle: merged };
    });
    await mergeFlowData(phone, { careRecipients: updatedRecipients });
    const updated = await getFlowData(phone);
    await sendMessage(chatId, buildBookingRecap(updated));
    return;
  }

  if (action === "edit_notes") {
    const notesText = typeof parsed?.notesText === "string" ? parsed.notesText.trim() : "";
    if (!notesText) {
      await sendMessage(chatId, "What would you like the note to say?");
      return;
    }
    const recipients = data.careRecipients ?? [];
    if (!recipients.length) {
      await sendMessage(chatId, "I couldn't find a care plan to update that on — reply YES to send as-is, or NO to cancel.");
      return;
    }
    let targetIndex = 0;
    if (recipients.length > 1) {
      const stated = typeof parsed?.notesRecipient === "string" ? parsed.notesRecipient.trim().toLowerCase() : "";
      const idx = stated ? recipients.findIndex((r) => String(r.name ?? "").toLowerCase().startsWith(stated)) : -1;
      if (idx === -1) {
        await sendMessage(chatId, `Whose notes would you like to update — ${recipients.map((r) => r.name).join(" or ")}?`);
        return;
      }
      targetIndex = idx;
    }
    // Matches the site's own Notes field — a single free-text box that's
    // overwritten, not appended to (unlike care needs/lifestyle, which merge).
    const updatedRecipients = recipients.map((r, i) => (i === targetIndex ? { ...r, notes: notesText.slice(0, 500) } : r));
    await mergeFlowData(phone, { careRecipients: updatedRecipients });
    const updated = await getFlowData(phone);
    await sendMessage(chatId, buildBookingRecap(updated));
    return;
  }

  if (action === "edit_message") {
    if (typeof parsed?.newMessage === "string" && parsed.newMessage.trim()) {
      await mergeFlowData(phone, { message: parsed.newMessage.trim().slice(0, 500) });
      const updated = await getFlowData(phone);
      await sendMessage(chatId, buildBookingRecap(updated));
      return;
    }
    await updateStep(phone, "bk_ask_message");
    await sendMessage(chatId, MESSAGE_QUESTION(data.caregiverName));
    return;
  }

  if (action !== "confirm") {
    // "other" (a genuine question) or an unclassifiable reply — answer if
    // it's a real question, then re-show the recap either way.
    if (await isQuestionOrOther(text, CONFIRM_QUESTION_FALLBACK)) {
      await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    }
    await sendMessage(chatId, buildBookingRecap(data));
    return;
  }

  // YES — commit. Calls createBookingTask directly (mirrors
  // jobPostingFlow.ts's buildAndSaveJobPost pattern) — no MCP tool, no
  // pending-action gate: this flow owns its own confirm step already.
  const clientId = session.userId as string | undefined;
  const phoneForTask = (session as any).phone as string | undefined ?? phone;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to send this booking. Please try again.");
    return;
  }
  try {
    const { createBookingTask } = await import("./bookingExecutor");
    const appointments = data.scheduleKind === "one_off"
      ? (data.dates ?? []).map((d) => ({
          date: d, startTime: data.startTime!, endTime: data.endTime!,
          durationHours: ((bookingTimeToMinutes(data.endTime) ?? 0) - (bookingTimeToMinutes(data.startTime) ?? 0)) / 60,
        }))
      : [];
    const schedule = data.scheduleKind === "recurring"
      ? {
          dayShiftTimes: data.dayTimes ?? {},
          ongoing: data.ongoing === true,
          ...(data.ongoing !== true && data.scheduleEndDate ? { endDate: data.scheduleEndDate } : {}),
        }
      : undefined;
    // Recurring bookings carry no appointments array — totalCostOverride
    // supplies the weekly estimate (createBookingTask's totalCost otherwise
    // sums appointments.reduce, which is empty here). Matches
    // request_booking's own estimatedTotal computation. Summed per-day since
    // each day can now have its own start/end.
    const totalCostOverride = schedule
      ? Math.round(Object.values(data.dayTimes ?? {}).reduce((sum, t) => {
          const s = bookingTimeToMinutes(t.start);
          const e = bookingTimeToMinutes(t.end);
          return sum + ((s !== null && e !== null) ? (e - s) / 60 : 0);
        }, 0) * data.hourlyRate! * 100) / 100
      : undefined;

    const taskId = await createBookingTask({
      clientPhone:   phoneForTask,
      clientId,
      caregiverId:   data.caregiverId,
      caregiverName: data.caregiverName,
      appointments,
      hourlyRate:    data.hourlyRate!,
      ...(schedule ? { schedule, totalCostOverride } : {}),
      careLocation:  data.careLocation!,
      ...(data.careRecipients ? { careRecipients: data.careRecipients } : {}),
      ...(data.topLevelCareNeeds ? { careNeeds: data.topLevelCareNeeds } : {}),
      ...(data.lifestylePreferences ? { lifestylePreferences: data.lifestylePreferences } : {}),
      ...(data.emergencyContact ? { emergencyContact: data.emergencyContact } : {}),
      ...(data.message ? { message: data.message } : {}),
      ...(data.recipientName ? { recipientName: data.recipientName } : {}),
      ...(data.recipientKey ? { recipientKey: data.recipientKey } : {}),
      ...(data.jobId ? { jobId: data.jobId } : {}),
      ...(data.jobTitle ? { jobTitle: data.jobTitle } : {}),
      ...(data.interviewId ? { interviewId: data.interviewId } : {}),
      ...(data.applicationId ? { applicationId: data.applicationId } : {}),
    });

    await clearFlow(phone);

    if (!taskId) {
      // createBookingTask returns "" when it blocks the booking (e.g. bgcheck
      // pending) and has already messaged the family — nothing more to send.
      return;
    }

    await sendMessage(chatId,
      `Sent to ${data.caregiverName} — I'll let you know as soon as they respond.`
    );
  } catch (err) {
    console.error("[bookingFlow] createBookingTask error:", err);
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: "Something went wrong while sending the family's booking request. Warmly apologize and ask them to try again.",
      fallback: "Sorry, I ran into a problem sending that booking request. Please try again.",
      maxTokens: 70,
    }));
  }
}
