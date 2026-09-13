// Scripted, step-by-step booking flow — mirrors jobPostingFlow.ts's pattern
// (session-state field machine, one question per turn, isQuestionOrOther
// guard, parseWithClaude extraction with re-ask-never-silently-default,
// ending in a structured recap + explicit YES/NO). Built 2026-09-13 after a
// live SMS test stalled: request_booking was only ever collected ad hoc
// inside the general qaAgent tool loop, so a mid-collection reply (e.g. "are
// you there") was exposed to intent-classification misfires (FACT_CORRECTION)
// instead of being captured deterministically, and there was no structured
// recap matching the website's own "Send Booking Request" review modal
// (components/client/PostsPage.tsx, handleSendBooking).
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
import {
  bookingTimeToMinutes, resolveInterviewLinkage, resolveBookingRate, resolveBookingCaregiverName,
  resolveCareLocation, formatCareLocationOptions, resolveRecipientAttribution, resolveEmergencyContact,
  resolveTopLevelCareNeedsAndLifestyle, enrichRecipientAgeRelationship,
  type LocationOption,
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
  hourlyRate?: number;
  scheduleKind?: "recurring" | "one_off";
  days?: string[];
  dates?: string[];
  startTime?: string;
  endTime?: string;
  careLocation?: string;
  careLocationOptions?: LocationOption[];
  recipientName?: string;
  recipientKey?: string;
  recipientResolved?: "named" | "defaulted_primary";
  careRecipients?: Array<Record<string, unknown>>;
  topLevelCareNeeds?: string[];
  lifestylePreferences?: string[];
  emergencyContact?: { name: string; phone: string; relationship?: string };
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
    ...(recipientAttribution.recipientName ? { recipientName: recipientAttribution.recipientName } : {}),
    ...(recipientAttribution.recipientKey ? { recipientKey: recipientAttribution.recipientKey } : {}),
    ...(recipientAttribution.recipientResolved ? { recipientResolved: recipientAttribution.recipientResolved } : {}),
    ...(recipientAttribution.careRecipients ? { careRecipients: recipientAttribution.careRecipients } : {}),
    ...(emergencyContact ? { emergencyContact } : {}),
  };

  // Rate: pre-fill from the linked job post if known, matching the site's
  // own default (bookingDraft.agreedRate ?? post?.rate) — skip straight past
  // bk_ask_rate when there's nothing to ask.
  const rateRes = resolveBookingRate(undefined, linkage.jobPostRate);
  if (rateRes.ok) data.hourlyRate = rateRes.hourlyRate;

  await db.collection("agent_sessions").doc(phone).update({
    bookingFlowStep: "bk_ask_rate",
    bookingFlowData: data,
    stateExpiresAt:  expiresAt,
  });

  await sendMessage(chatId, `Let's get a booking request over to ${nameRes.caregiverName}!`);
  if (data.hourlyRate) {
    await sendMessage(chatId, `Using $${data.hourlyRate}/hr from the job post — let me know if that's changed.`);
    await advanceToDays(phone, chatId, data);
  } else {
    await sendMessage(chatId, RATE_QUESTION);
  }
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
    case "bk_ask_location": return handleBkAskLocation(phone, chatId, text, session);
    case "bk_confirm":      return handleBkConfirm(phone, chatId, text, session);
    default:
      // Shouldn't happen (the flow always sets a step when active), but
      // fail safe rather than throw on an unrecognized/stale step value.
      await sendMessage(chatId, RATE_QUESTION);
  }
}

// ── Step: rate ────────────────────────────────────────────────────────────────

const RATE_QUESTION = "What hourly rate are you offering for this booking?";

async function handleBkAskRate(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  if (await isQuestionOrOther(text, RATE_QUESTION)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, RATE_QUESTION);
    return;
  }
  const raw = await parseWithClaude(
    "Extract the hourly rate as a number (e.g. \"$20\", \"18 an hour\" → 18). Reply with only the number.",
    text
  );
  const rate = parseFloat(raw);
  if (isNaN(rate) || rate <= 0) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${RATE_QUESTION}`);
    return;
  }
  await mergeFlowData(phone, { hourlyRate: rate });
  const updated = await getFlowData(phone);
  await advanceToDays(phone, chatId, updated);
}

async function advanceToDays(phone: string, chatId: string, data: BookingFlowData): Promise<void> {
  // Days are real data once a job post is linked — skip straight to times,
  // matching request_booking's own existing behavior (never ask for days
  // the family already told the site).
  if (data.jobPostDays?.length) {
    await mergeFlowData(phone, { scheduleKind: "recurring", days: data.jobPostDays });
    await updateStep(phone, "bk_ask_times");
    await sendMessage(chatId,
      `Got it — $${data.hourlyRate}/hr. Your job post already has ${data.jobPostDays.join(", ")} — ` +
      `what time should each visit run? (e.g. "9am to 3pm")`
    );
    return;
  }
  await updateStep(phone, "bk_ask_days");
  await sendMessage(chatId,
    `Got it — $${data.hourlyRate}/hr! What days would you like this to start with — ` +
    `a recurring weekly schedule (e.g. "every Tue and Thu"), or a specific one-off visit (e.g. "this Friday")?`
  );
}

// ── Step: days (recurring weekdays OR a specific date) ───────────────────────

const DAYS_QUESTION =
  "What days would you like this to start with — a recurring weekly schedule (e.g. \"every Tue and Thu\"), " +
  "or a specific one-off visit (e.g. \"this Friday\")?";

async function handleBkAskDays(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  if (await isQuestionOrOther(text, DAYS_QUESTION)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, DAYS_QUESTION);
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
    await sendMessage(chatId, `${parsed.days.join(", ")} — got it! What time should each visit run? (e.g. "9am to 3pm")`);
    return;
  }
  if (kind === "one_off" && Array.isArray(parsed.dates) && parsed.dates.length > 0) {
    await mergeFlowData(phone, { scheduleKind: "one_off", dates: parsed.dates });
    await updateStep(phone, "bk_ask_times");
    await sendMessage(chatId, `${parsed.dates.join(", ")} — got it! What time should the visit run? (e.g. "9am to 3pm")`);
    return;
  }
  await sendMessage(chatId, `${BK_DIDNT_CATCH} ${DAYS_QUESTION}`);
}

// ── Step: times ───────────────────────────────────────────────────────────────

const TIMES_QUESTION = "What time should each visit run? (e.g. \"9am to 3pm\")";

async function handleBkAskTimes(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  if (await isQuestionOrOther(text, TIMES_QUESTION)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, TIMES_QUESTION);
    return;
  }
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
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${TIMES_QUESTION}`);
    return;
  }
  await mergeFlowData(phone, { startTime: rawStart, endTime: rawEnd });
  await advanceToLocation(phone, chatId, session);
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

async function handleBkAskLocation(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
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
      'Match the family\'s reply to ONE of the numbered addresses above. Return ONLY a JSON object: ' +
      '{"matchedIndex": number or null}. Never invent a match.',
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

async function advanceToConfirm(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const clientId = session.userId as string | undefined;
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
  await updateStep(phone, "bk_confirm");
  await sendMessage(chatId, buildBookingRecap(data));
}

// Mirrors the website's own "Send Booking Request" review modal section
// order: Caregiver, Rate & Payment, Schedule, Care Recipients, Care Plan
// Details, Lifestyle & Preferences, Care Location, Emergency Contact.
export function buildBookingRecap(data: BookingFlowData): string {
  const scheduleLine = data.scheduleKind === "recurring"
    ? `${(data.days ?? []).join(", ")}, ${data.startTime}–${data.endTime}`
    : `${(data.dates ?? []).join(", ")}, ${data.startTime}–${data.endTime}`;
  const recipients = data.careRecipients?.length
    ? data.careRecipients.map((r) => {
        const name = String(r.name ?? "");
        const rel  = r.relationship ? ` (${r.relationship}${r.age ? `, Age ${r.age}` : ""})` : "";
        return `${name}${rel}`;
      }).join(", ")
    : (data.recipientName ?? "your household");
  const careNeedsLine = data.topLevelCareNeeds?.length ? data.topLevelCareNeeds.join(", ") : "General care";
  const lifestyleLine = data.lifestylePreferences?.length ? data.lifestylePreferences.join(", ") : "Not specified";
  const ec = data.emergencyContact;
  const ecLine = ec?.phone ? `${ec.name || "On file"}${ec.relationship ? ` (${ec.relationship})` : ""} — ${ec.phone}` : "Not on file";

  return [
    `Here's your booking request:`,
    ``,
    `Caregiver: ${data.caregiverName}`,
    `Rate: $${data.hourlyRate}/hr`,
    `Schedule: ${scheduleLine}`,
    `Care recipients: ${recipients}`,
    `Care needs: ${careNeedsLine}`,
    `Lifestyle & preferences: ${lifestyleLine}`,
    `Care location: ${data.careLocation}`,
    `Emergency contact: ${ecLine}`,
    ``,
    `Reply YES to send it to ${data.caregiverName}, or NO to cancel.`,
  ].join("\n");
}

const CONFIRM_QUESTION_FALLBACK = "Confirming whether to send this booking request — reply YES to send it, or NO to cancel.";

async function handleBkConfirm(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  if (await isQuestionOrOther(text, CONFIRM_QUESTION_FALLBACK)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, buildBookingRecap(data));
    return;
  }

  const norm = await parseWithClaude(
    'The user is confirming or declining to send a booking request. ' +
    '"yes", "yep", "send it", "go ahead", "confirm", "looks good" = YES. ' +
    '"no", "cancel", "never mind", "stop" = NO. Reply with exactly YES or NO.',
    text
  );

  if (norm.toUpperCase() === "NO") {
    await clearFlow(phone);
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: "The family decided not to send the booking request after all. Warmly confirm nothing was sent, and let them know you're here whenever they're ready.",
      fallback: "No problem — I haven't sent anything. Let me know whenever you're ready.",
      maxTokens: 70,
    }));
    return;
  }

  if (!norm.toUpperCase().startsWith("Y")) {
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
    const startMin = bookingTimeToMinutes(data.startTime);
    const endMin   = bookingTimeToMinutes(data.endTime);
    const perVisitHours = (startMin !== null && endMin !== null) ? (endMin - startMin) / 60 : 0;
    const schedule = data.scheduleKind === "recurring"
      ? {
          dayShiftTimes: Object.fromEntries((data.days ?? []).map((d) => [d, { start: data.startTime!, end: data.endTime! }])),
          ongoing: true,
        }
      : undefined;
    // Recurring bookings carry no appointments array — totalCostOverride
    // supplies the weekly estimate (createBookingTask's totalCost otherwise
    // sums appointments.reduce, which is empty here). Matches
    // request_booking's own estimatedTotal computation.
    const totalCostOverride = schedule
      ? Math.round((data.days ?? []).length * perVisitHours * data.hourlyRate! * 100) / 100
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
