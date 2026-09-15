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
import { businessTodayStr, formatHHMMForDisplay as formatTimeForDisplay, formatDateForDisplay } from "../utils/scheduledTime";
import { normalizeCareNeeds } from "../utils/careNeedCategories";
import { normDay } from "../scheduled/shiftGenerator";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS, bareNumberPick } from "./stepHandler";
import {
  bookingTimeToMinutes, resolveInterviewLinkage, resolveBookingCaregiverName,
  resolveCareLocation, formatCareLocationOptions, listCareLocationOptions, resolveRecipientAttribution,
  resolveEmergencyContact, resolveTopLevelCareNeedsAndLifestyle, enrichRecipientAgeRelationship,
  listRecipientOptions, findSendBookingEligibleInterviews, type LocationOption, type RecipientOption,
  type SendBookingEligibleInterview,
} from "./bookingResolution";

const db = admin.firestore();

// ── Session data shape ────────────────────────────────────────────────────────

export interface BookingFlowData {
  // Required from bk_ask_rate onward. While bookingFlowStep === "bk_ask_interview"
  // and no caregiver was named yet (options may span several caregivers),
  // these are placeholder "" — always resolved (to the picked option's own
  // caregiverId/caregiverName) before advancing past that step.
  caregiverId: string;
  caregiverName: string;
  interviewId?: string;
  // Populated when start_booking_flow was called with no interviewId and
  // there are 2+ interviews eligible for a fresh booking — scoped to one
  // caregiver if the family named one, or across ALL of the client's
  // caregivers otherwise (matches the site's own per-row "Send Booking" —
  // see findSendBookingEligibleInterviews). Never populated (and
  // bk_ask_interview never reached) when there's exactly 1 eligible
  // interview (auto-links with nothing to ask) — and there is NO path that
  // proceeds with 0 eligible interviews: the site itself never shows a
  // "Send Booking" button without a completed interview behind it, so Evia
  // doesn't invent one either (see startBookingFlow's 0-eligible branch).
  interviewOptions?: SendBookingEligibleInterview[];
  jobId?: string;
  jobTitle?: string;
  applicationId?: string;
  jobPostRate?: number;
  jobPostDays?: string[];
  jobPostEndDate?: string;
  hourlyRate?: number;
  // 2026-09-14: unified to match the site's OWN single schedule model
  // exactly (its "Send Booking Request" modal never distinguishes
  // "recurring" from "one-off" — it always just has day-of-week chips, a
  // start date, and an Ongoing checkbox or a set end date; even a single
  // one-time visit is "days=[Fri], startDate=endDate=that Friday,
  // ongoing=false"). Evia previously forked into a separate "one_off" shape
  // (a raw dates[] list, no startDate at all) — that false dichotomy is what
  // caused "recurring weekly" (confirming only the type) to get misread as
  // every day of the week, and the recurring path never asked for a start
  // date at all despite the site always having one.
  days?: string[];
  startDate?: string;
  // EACH day gets its own start/end (matches the site's per-day schedule
  // builder, dayShiftTimes) — never a single shared time silently applied,
  // even when there's only one day.
  dayTimes?: Record<string, { start: string; end: string }>;
  // Whether the arrangement is open-ended or has a set end date (matches
  // the site's own Ongoing checkbox / End date pair) — always asked,
  // regardless of how many days were picked, same as the site.
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

async function answerQuestionMidFlow(text: string, caregiverName?: string): Promise<string> {
  // 2026-09-08-pattern (same fix already applied to jobPostingFlow.ts/
  // modifyScheduleFlow.ts): this sees ONLY the current message, never the
  // rest of the conversation — including anything Evia herself said earlier.
  // Must never claim something was/wasn't mentioned before, and must not
  // force an out-of-scope question into booking terms.
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a family send a booking request" +
      (caregiverName ? ` to a caregiver named ${caregiverName}` : "") +
      ". You see ONLY this one message, not the rest of the conversation — including anything " +
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

// 2026-09-13 (live-caught): "on the site I can see it and know which one
// I'm clicking to send booking for" — clicking Send Booking on a specific
// interview row makes the context unambiguous there; naming only the
// caregiver here left the family with no equivalent upfront signal for
// WHICH interview/job post this follows. Named in the very first message
// now, not just (as of the fix right below this) the final recap.
function openingLine(caregiverName: string, jobTitle?: string): string {
  return jobTitle
    ? `Let's get a booking request over to ${caregiverName}, following ${jobTitle}!`
    : `Let's get a booking request over to ${caregiverName}!`;
}

// ── Step: which interview (only asked when 2+ eligible) ─────────────────────

function INTERVIEW_PICK_QUESTION(options: SendBookingEligibleInterview[]): string {
  const lines = options.map((o, i) =>
    `${i + 1}. ${o.caregiverName}${o.jobTitle ? ` — ${o.jobTitle}` : ""} (${o.scheduledLabel})`
  );
  return `Which interview is this booking for?\n\n${lines.join("\n")}`;
}

async function handleBkAskInterview(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const options = data.interviewOptions ?? [];
  const question = INTERVIEW_PICK_QUESTION(options);
  let idx = bareNumberPick(text, options.length);
  if (idx === null) {
    if (await isBackOutRequest(text, question)) return handleBookingBackOut(phone, chatId, session);
    if (await isQuestionOrOther(text, question)) {
      await sendMessage(chatId, await answerQuestionMidFlow(text));
      await sendMessage(chatId, question);
      return;
    }
    const raw = await parseWithClaude(
      `The family is picking which of ${options.length} interviews this booking follows. Return ONLY the number ` +
      "(1-based) they picked, or \"0\" if the message doesn't clearly pick one. Never guess.",
      text
    );
    idx = parseInt(raw.trim(), 10);
    if (isNaN(idx) || idx < 1 || idx > options.length) {
      await sendMessage(chatId, `${BK_DIDNT_CATCH} ${question}`);
      return;
    }
  }
  const chosen = options[idx - 1];
  const clientId = session.userId as string | undefined;
  const linkage = clientId ? await resolveInterviewLinkage(clientId, chosen.caregiverId, chosen.id) : {};
  await mergeFlowData(phone, {
    caregiverId:   chosen.caregiverId,
    caregiverName: chosen.caregiverName,
    interviewId:   chosen.id,
    ...(linkage.jobId ? { jobId: linkage.jobId } : {}),
    ...(linkage.jobTitle ? { jobTitle: linkage.jobTitle } : {}),
    ...(linkage.applicationId ? { applicationId: linkage.applicationId } : {}),
    ...(linkage.jobPostRate !== undefined ? { jobPostRate: linkage.jobPostRate } : {}),
    ...(linkage.jobPostSchedule?.daysOfWeek?.length ? { jobPostDays: linkage.jobPostSchedule.daysOfWeek } : {}),
    ...(linkage.jobPostSchedule?.endDate ? { jobPostEndDate: linkage.jobPostSchedule.endDate } : {}),
  });
  const updated = await getFlowData(phone);
  // Same recipients-ambiguity check every other path into rate goes through
  // (2026-09-14 fix: this used to skip straight to advanceToRate, bypassing
  // bk_confirm_recipients entirely for the one path that resolves the
  // caregiver from a pick instead of from an already-known caregiverId).
  if (clientId) return resolveRecipientsAndAdvance(phone, chatId, session, clientId, updated);
  await advanceToRate(phone, chatId, updated);
}

// Resolves recipients/emergency contact for a caregiver+interview that's
// already settled (either passed in directly, auto-linked from exactly one
// eligible interview, or just picked from 2+), then either asks the upfront
// recipients-confirm question (when the default is genuinely ambiguous) or
// goes straight to the rate question — same branch, one shared home, so
// every entry path into the flow gets identical treatment.
async function resolveRecipientsAndAdvance(
  phone: string, chatId: string, session: AgentSession, clientId: string, base: BookingFlowData,
): Promise<void> {
  const recipientAttribution = await resolveRecipientAttribution(clientId, undefined, undefined);
  const emergencyContact = await resolveEmergencyContact(clientId);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const data: BookingFlowData = {
    ...base,
    ...(recipientAttribution.recipientName ? { recipientName: recipientAttribution.recipientName } : {}),
    ...(recipientAttribution.recipientKey ? { recipientKey: recipientAttribution.recipientKey } : {}),
    ...(recipientAttribution.recipientResolved ? { recipientResolved: recipientAttribution.recipientResolved } : {}),
    ...(recipientAttribution.careRecipients ? { careRecipients: recipientAttribution.careRecipients } : {}),
    ...(emergencyContact ? { emergencyContact } : {}),
  };

  // 2026-09-13 (live-caught): the site's own job_posts doc only ever records
  // a recipientsCount NUMBER, never which specific household member a given
  // posting/interview was actually for — so "defaulted_all" (every recipient
  // ever mentioned across this account's job posts) is genuinely the best
  // available default, matching the site's own pre-selected-all checkboxes.
  // But silently defaulting and only surfacing it in the FINAL recap left
  // the family with no idea upfront who a booking actually covers until
  // they'd already answered rate/schedule/location — confirmed live: two
  // unrelated names (another job post's recipient, the account holder's own
  // onboarding self-entry) got swept into a booking meant for one person.
  // Ask upfront, right away, whenever the default is genuinely ambiguous
  // (2+ recipients and none explicitly named) — one number/name reply either
  // confirms or narrows it before anything else is asked.
  const recipients = data.careRecipients ?? [];
  if (data.recipientResolved === "defaulted_all" && recipients.length > 1) {
    await db.collection("agent_sessions").doc(phone).update({
      bookingFlowStep: "bk_confirm_recipients",
      bookingFlowData: data,
      stateExpiresAt:  expiresAt,
    });
    const names = recipients.map((r) => String(r.name ?? "")).filter(Boolean);
    await sendMessage(chatId, `${openingLine(data.caregiverName, data.jobTitle)}\n\n${RECIPIENTS_CONFIRM_QUESTION(names)}`);
    return;
  }

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
  // Single combined message — two separate sendMessage calls here used to
  // occasionally arrive out of order relative to the model's own trailing
  // turn reply (a live-caught delivery race, 2026-09-13), reading as
  // confusing/backwards. One atomic send removes that risk entirely.
  await sendMessage(chatId, `${openingLine(data.caregiverName, data.jobTitle)}\n\n${RATE_QUESTION(data.jobPostRate)}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function startBookingFlow(
  phone: string, chatId: string, session: AgentSession,
  args: { caregiverId?: string; interviewId?: string },
): Promise<{ started: boolean; reason?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to start this booking. Please try again.");
    return { started: false, reason: "no_client_id" };
  }

  // Case A: the caller already resolved a specific interview (e.g. right
  // after a "strong" submit_interview_feedback result) — trust it directly,
  // no eligibility scan needed, since this IS the interview being discussed.
  if (args.interviewId) {
    const ivSnap = await db.collection("video_interviews").doc(args.interviewId).get();
    const iv = ivSnap.data();
    if (!iv || iv.clientId !== clientId) {
      await sendMessage(chatId, "I couldn't find that interview to book from. Who would you like to book?");
      return { started: false, reason: "interview_not_found" };
    }
    const caregiverId = args.caregiverId ?? (iv.caregiverId as string | undefined);
    if (!caregiverId) {
      await sendMessage(chatId, "I couldn't tell which caregiver that interview was with. Who would you like to book?");
      return { started: false, reason: "caregiver_not_found" };
    }
    const nameRes = await resolveBookingCaregiverName(caregiverId);
    if (!nameRes.ok) {
      await sendMessage(chatId, "I couldn't find that caregiver to book. Can you tell me who you'd like to book?");
      return { started: false, reason: "caregiver_not_found" };
    }
    const linkage = await resolveInterviewLinkage(clientId, caregiverId, args.interviewId);
    await resolveRecipientsAndAdvance(phone, chatId, session, clientId, {
      caregiverId, caregiverName: nameRes.caregiverName, interviewId: args.interviewId,
      ...(linkage.jobId ? { jobId: linkage.jobId } : {}),
      ...(linkage.jobTitle ? { jobTitle: linkage.jobTitle } : {}),
      ...(linkage.applicationId ? { applicationId: linkage.applicationId } : {}),
      ...(linkage.jobPostRate !== undefined ? { jobPostRate: linkage.jobPostRate } : {}),
      ...(linkage.jobPostSchedule?.daysOfWeek?.length ? { jobPostDays: linkage.jobPostSchedule.daysOfWeek } : {}),
      ...(linkage.jobPostSchedule?.endDate ? { jobPostEndDate: linkage.jobPostSchedule.endDate } : {}),
    });
    return { started: true };
  }

  // Case B: no specific interview given — one single process regardless of
  // whether a caregiver was named: find what's eligible (scoped to that
  // caregiver if named, across all of them otherwise), then branch only on
  // COUNT. 2026-09-14 (site-parity, Hamse-confirmed): the site itself never
  // shows a "Send Booking" button without a completed, non-declined
  // interview behind it — there is NO direct/no-interview booking path on
  // the site at all — so 0 eligible here must stop, never proceed.
  let caregiverName: string | undefined;
  if (args.caregiverId) {
    const nameRes = await resolveBookingCaregiverName(args.caregiverId);
    if (!nameRes.ok) {
      await sendMessage(chatId, "I couldn't find that caregiver to book. Can you tell me who you'd like to book?");
      return { started: false, reason: "caregiver_not_found" };
    }
    caregiverName = nameRes.caregiverName;
  }

  const eligible = await findSendBookingEligibleInterviews(clientId, args.caregiverId);

  if (eligible.length === 0) {
    await sendMessage(chatId, caregiverName
      ? `There's no completed interview with ${caregiverName} ready for a booking yet — once one's marked as a fit, I can send the booking from there.`
      : "I don't see any completed interviews ready for a booking yet — once one's marked as a fit, I can send the booking from there.");
    return { started: false, reason: "no_eligible_interview" };
  }

  if (eligible.length > 1) {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const data: BookingFlowData = {
      caregiverId:   args.caregiverId ?? "",
      caregiverName: caregiverName ?? "",
      interviewOptions: eligible,
    };
    await db.collection("agent_sessions").doc(phone).update({
      bookingFlowStep: "bk_ask_interview",
      bookingFlowData: data,
      stateExpiresAt:  expiresAt,
    });
    // The pick is the WHOLE first message — nothing before it (2026-09-14,
    // Hamse-confirmed: naming a caregiver upfront doesn't make sense yet
    // when the options themselves might span more than one caregiver).
    await sendMessage(chatId, INTERVIEW_PICK_QUESTION(eligible));
    return { started: true };
  }

  // Exactly one eligible interview — auto-link with nothing to ask.
  const only = eligible[0];
  const linkage = await resolveInterviewLinkage(clientId, only.caregiverId, only.id);
  await resolveRecipientsAndAdvance(phone, chatId, session, clientId, {
    caregiverId: only.caregiverId, caregiverName: only.caregiverName, interviewId: only.id,
    ...(linkage.jobId ? { jobId: linkage.jobId } : {}),
    ...(linkage.jobTitle ? { jobTitle: linkage.jobTitle } : {}),
    ...(linkage.applicationId ? { applicationId: linkage.applicationId } : {}),
    ...(linkage.jobPostRate !== undefined ? { jobPostRate: linkage.jobPostRate } : {}),
    ...(linkage.jobPostSchedule?.daysOfWeek?.length ? { jobPostDays: linkage.jobPostSchedule.daysOfWeek } : {}),
    ...(linkage.jobPostSchedule?.endDate ? { jobPostEndDate: linkage.jobPostSchedule.endDate } : {}),
  });
  return { started: true };
}

// ── Step: recipients confirm (proactive, only when the default is genuinely ambiguous) ──

const RECIPIENTS_CONFIRM_QUESTION = (names: string[]) =>
  `Just to confirm — this booking is for: ${names.join(", ")}. Reply "yes" if that's right, or tell me who it's actually for.`;

async function handleBkConfirmRecipients(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const names = (data.careRecipients ?? []).map((r) => String(r.name ?? "")).filter(Boolean);
  const question = RECIPIENTS_CONFIRM_QUESTION(names);
  if (await isBackOutRequest(text, question)) return handleBookingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }
  const raw = await parseWithClaude(
    `Currently listed recipients for this booking: ${names.join(", ")}. The family is confirming whether that's ` +
    'correct, or naming who it should ACTUALLY be for. Return ONLY a JSON object: {"confirmed": true or false, ' +
    '"recipientNames": array of first names actually stated, or null}. "confirmed" is true for a plain yes/looks ' +
    "good/that's right with no names stated. Never invent a name the message doesn't state.",
    text
  );
  const parsed = parseJsonLoose(raw, "handleBkConfirmRecipients");
  if (parsed?.confirmed === true) {
    return advanceToRate(phone, chatId, data);
  }
  const stated = Array.isArray(parsed?.recipientNames) ? (parsed.recipientNames as unknown[]).map(String).filter(Boolean) : [];
  if (stated.length) {
    await resolveAndMergeRecipients(phone, session, stated);
    const updated = await getFlowData(phone);
    return advanceToRate(phone, chatId, updated);
  }
  await sendMessage(chatId, `${BK_DIDNT_CATCH} ${question}`);
}

async function advanceToRate(phone: string, chatId: string, data: BookingFlowData): Promise<void> {
  await updateStep(phone, "bk_ask_rate");
  await sendMessage(chatId, RATE_QUESTION(data.jobPostRate));
}

// ── Step dispatch ─────────────────────────────────────────────────────────────

export async function handleBookingFlowStep(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const step = (session as any).bookingFlowStep as string ?? "";
  switch (step) {
    case "bk_ask_interview": return handleBkAskInterview(phone, chatId, text, session);
    case "bk_ask_rate":     return handleBkAskRate(phone, chatId, text, session);
    case "bk_ask_days":     return handleBkAskDays(phone, chatId, text, session);
    case "bk_ask_start_date": return handleBkAskStartDate(phone, chatId, text, session);
    case "bk_ask_times":    return handleBkAskTimes(phone, chatId, text, session);
    case "bk_ask_ongoing":  return handleBkAskOngoing(phone, chatId, text, session);
    case "bk_ask_location": return handleBkAskLocation(phone, chatId, text, session);
    case "bk_ask_recipients": return handleBkAskRecipients(phone, chatId, text, session);
    case "bk_confirm_recipients": return handleBkConfirmRecipients(phone, chatId, text, session);
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
  `What's the agreed hourly rate for this booking?` +
  (jobPostRate ? ` (Your job post lists $${jobPostRate}/hr — reply with that, or the different rate you agreed on.)` : "");

async function handleBkAskRate(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const question = RATE_QUESTION(data.jobPostRate);
  if (await isBackOutRequest(text, question)) return handleBookingBackOut(phone, chatId, session);
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

// ── Step: days of the week ───────────────────────────────────────────────────

const DAYS_QUESTION = (jobPostDays?: string[]) =>
  'What days of the week would you like — e.g. "every Tue and Thu", "weekdays", "every day", or just one day ' +
  'like "Friday"?' +
  (jobPostDays?.length ? ` (Your job post lists ${jobPostDays.join(", ")} — reply with that, or different days.)` : "");

async function handleBkAskDays(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const question = DAYS_QUESTION(data.jobPostDays);
  if (await isBackOutRequest(text, question)) return handleBookingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }

  const raw = await parseWithClaude(
    "Extract which days of the week the family wants, as full weekday names. Return ONLY a JSON object: " +
    '{"days": ["Monday", ...]}. "weekdays" = Monday-Friday. "every day"/"all week" = all 7. "weekends" = ' +
    'Saturday+Sunday. "every Tue and Thu" = [Tuesday,Thursday]. A single day name = just that one day. Never ' +
    "invent a day the message doesn't name or clearly imply — an empty array is correct if none is stated.",
    text
  );
  const parsed = parseJsonLoose(raw, "handleBkAskDays");
  const days: string[] = Array.isArray(parsed?.days) ? parsed.days.filter((d: unknown) => typeof d === "string") : [];
  if (!days.length) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${question}`);
    return;
  }
  await mergeFlowData(phone, { days });
  await updateStep(phone, "bk_ask_start_date");
  await sendMessage(chatId, `${days.join(", ")} — got it! ${START_DATE_QUESTION}`);
}

// ── Step: start date (matches the site's own separate Start date field) ────

const START_DATE_QUESTION = 'What date would you like this to start? (e.g. "tomorrow", "this Friday", "March 5")';

async function handleBkAskStartDate(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const question = START_DATE_QUESTION;
  if (await isBackOutRequest(text, question)) return handleBookingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }

  const today = businessTodayStr();
  const raw = await parseWithClaude(
    `Today is ${today}. Extract the date the family wants this to start, resolved to an absolute date relative ` +
    'to today. Return ONLY a JSON object: {"date": "YYYY-MM-DD" or null}. Never invent a date the message ' +
    "doesn't state or clearly imply.",
    text
  );
  const parsed = parseJsonLoose(raw, "handleBkAskStartDate");
  const startDate = typeof parsed?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null;
  if (!startDate) {
    await sendMessage(chatId, `${BK_DIDNT_CATCH} ${question}`);
    return;
  }
  await mergeFlowData(phone, { startDate });
  await updateStep(phone, "bk_ask_times");
  await sendMessage(chatId, `Starting ${formatDateForDisplay(startDate)} — got it! ${TIMES_QUESTION(data.days ?? [])}`);
}

// ── Step: times (every day needs its own start/end) ─────────────────────────

const TIMES_QUESTION = (days: string[]) =>
  days.length > 1
    ? `What time should each day run? One time for all works (e.g. "9am to 5pm"), or different times per day ` +
      `(e.g. "${days[0]} 9am-5pm, ${days[1]} 10am-2pm") — every day needs its own start and end time.`
    : `What time should this run? (e.g. "9am to 3pm")`;

async function handleBkAskTimes(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const days = data.days ?? [];
  const question = TIMES_QUESTION(days);
  if (await isBackOutRequest(text, question)) return handleBookingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }

  // Every day needs its OWN start/end (matches the site's
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

// ── Step: ongoing vs. a set end date — ALWAYS asked, matching the site's own
// Ongoing checkbox / End date pair, which is present regardless of how many
// days were picked (even a single one-time visit still shows it). ─────────

const ONGOING_QUESTION =
  "Is this an ongoing arrangement with no end date, or does it have a specific end date — e.g. if this is just a " +
  "single one-time visit, say so? (e.g. \"ongoing\", \"just this once\", or \"through December 1\")";

async function advanceFromTimes(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
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
  if (await isBackOutRequest(text, ONGOING_QUESTION)) return handleBookingBackOut(phone, chatId, session);
  const data = await getFlowData(phone);
  if (await isQuestionOrOther(text, ONGOING_QUESTION)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, ONGOING_QUESTION);
    return;
  }
  const today = businessTodayStr();
  const raw = await parseWithClaude(
    `Today is ${today}. This booking starts ${data.startDate ?? "an unspecified date"}. Does the family want this ` +
    "arrangement to be ongoing (no end date), or does it have a specific end date? Return ONLY a JSON object: " +
    '{"ongoing": true or false, "endDate": "YYYY-MM-DD" or null — required when ongoing is false, resolved ' +
    'relative to today}. A reply like "just once", "just this one time", or "one-time only" means NOT ongoing ' +
    "with endDate equal to the booking's own start date given above. Never invent a date the message doesn't " +
    "support otherwise.",
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
      "Reply with a number, or the street name."
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
// Shared by both the recap's "edit_recipients" action and the proactive
// upfront confirm (bk_confirm_recipients) — only the resolve+merge, no
// navigation, since the two callers land on different next steps (the
// former returns to the final recap, the latter continues on to rate).
async function resolveAndMergeRecipients(phone: string, session: AgentSession, names: string[]): Promise<void> {
  const clientId = session.userId as string | undefined;
  if (!clientId || !names.length) return;
  const attribution = await resolveRecipientAttribution(
    clientId,
    names.length === 1 ? names[0] : undefined,
    names.length > 1 ? names : undefined,
  );
  // 2026-09-13 (live-caught): age/relationship/photo enrichment used to only
  // happen inside refreshDerivedRecipientFields — which requires careLocation
  // to already be known, so it's a no-op this early in the flow. The
  // proactive bk_confirm_recipients narrowing ("for samira") runs BEFORE
  // location is ever asked, so a narrowed recipient shipped with none of
  // this: no age, no relationship, no photo — just a bare name, unlike the
  // site's own booking cards. Age/relationship/photo don't depend on
  // location at all, so enrich here immediately instead of waiting.
  const enrichedRecipients = await enrichRecipientAgeRelationship(clientId, attribution.careRecipients);
  await mergeFlowData(phone, {
    careRecipients:    enrichedRecipients ?? attribution.careRecipients,
    recipientName:     attribution.recipientName,
    recipientKey:      attribution.recipientKey,
    recipientResolved: attribution.recipientResolved,
  });
}

async function applyRecipientSelection(phone: string, chatId: string, session: AgentSession, names: string[]): Promise<void> {
  const clientId = session.userId as string | undefined;
  await resolveAndMergeRecipients(phone, session, names);
  const data = await refreshDerivedRecipientFields(phone, clientId);
  await updateStep(phone, "bk_confirm");
  await sendMessage(chatId, buildBookingRecap(data));
}

async function handleBkAskRecipients(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const options = data.recipientOptions ?? [];
  const QUESTION = options.length
    ? `Who should this booking be for?\n\n${formatRecipientOptions(options)}`
    : "Who is this booking for?";
  if (await isBackOutRequest(text, QUESTION)) return handleBookingBackOut(phone, chatId, session);
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
  const data = await getFlowData(phone);
  const QUESTION = MESSAGE_QUESTION(data.caregiverName);
  if (await isBackOutRequest(text, QUESTION)) return handleBookingBackOut(phone, chatId, session);
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
  const data = await getFlowData(phone);
  const options = data.careLocationOptions ?? [];
  const QUESTION = options.length
    ? `Which address is this for?\n\n${formatCareLocationOptions(options)}`
    : "Where will this care take place? (street address + zip)";
  const picked = bareNumberPick(text, options.length);
  if (picked !== null) {
    const a = options[picked - 1];
    await mergeFlowData(phone, { careLocation: [a.street, a.city, a.state, a.zipCode].filter(Boolean).join(", ") });
    return advanceToConfirm(phone, chatId, session);
  }
  if (await isBackOutRequest(text, QUESTION)) return handleBookingBackOut(phone, chatId, session);
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
  const spanLine = data.ongoing ? "(ongoing)" : data.scheduleEndDate ? `(through ${formatDateForDisplay(data.scheduleEndDate)})` : "";
  const scheduleLine =
    `${(data.days ?? []).map((d) => {
      const t = data.dayTimes?.[d];
      return t ? `${d} ${formatTimeForDisplay(t.start)}–${formatTimeForDisplay(t.end)}` : d;
    }).join(", ")}` +
    `${data.startDate ? `, starting ${formatDateForDisplay(data.startDate)}` : ""} ${spanLine}`;

  const recipientLines: string[] = [];
  if (data.careRecipients?.length) {
    data.careRecipients.forEach((r, i) => {
      const name = String(r.name ?? "");
      const rel  = r.relationship ? ` (${r.relationship}${r.age ? `, Age ${r.age}` : ""})` : "";
      const needs = Array.isArray(r.careNeeds) && r.careNeeds.length ? (r.careNeeds as string[]).join(", ") : "General care";
      const lifestyle = formatRecipientLifestyle(r.lifestyle);
      const notes = typeof r.notes === "string" ? r.notes.trim() : "";
      recipientLines.push(`${i + 1}. ${name}${rel}: ${needs}`);
      // 2026-09-13 (live-caught): "Notes: None" per recipient read as if that
      // literal placeholder gets forwarded to the caregiver — it never does
      // (the site's own caregiver booking view doesn't render per-recipient
      // notes at all; only the top-level "Message to {caregiver}" field ever
      // reaches them, and only when non-empty). Omit the line entirely
      // instead of asserting an absence nobody needs stated.
      if (notes) recipientLines.push(`   Notes: ${notes}`);
      recipientLines.push(`   Lifestyle: ${lifestyle || "Not specified"}`);
    });
  } else {
    const needs = data.topLevelCareNeeds?.length ? data.topLevelCareNeeds.join(", ") : "General care";
    recipientLines.push(`1. ${data.recipientName ?? "your household"}: ${needs}`);
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
    // 2026-09-13 (live-caught): unlike the site — where clicking "Send
    // Booking" on a specific interview/job row makes it unambiguous what
    // you're sending — nothing here ever named WHICH interview/job post
    // this booking follows, even though jobTitle is already tracked.
    ...(data.jobTitle ? [`Following: ${data.jobTitle}`] : []),
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

async function classifyBkConfirmReply(text: string): Promise<any | null> {
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
    '"edit_notes" = wants to add/change a general free-text NOTE ABOUT A CARE RECIPIENT specifically — ONLY when ' +
    'the message names or clearly implies a specific person being cared for (e.g. "add a note that Samira likes ' +
    'to go shopping", "note for her: prefers mornings") — distinct from a care need/task or a lifestyle ' +
    "preference — set notesRecipient to whose note this is if a name is stated (else null), and notesText to the " +
    "exact note content stated, else null. " +
    '"edit_message" = wants to add/change the optional note sent TO THE CAREGIVER — this is the default for any ' +
    '"add/change a note" request that does NOT specifically name or imply a care recipient (matches the site\'s ' +
    'own single "Message to {caregiver}" field, which is what most families mean by a plain "add a note" with no ' +
    'one else specified) — e.g. "add this note: running late today", "can you add a note saying thanks" both set ' +
    'newMessage to the actual note text (strip only a leading instruction like "add this note"/"add a note that " ' +
    'if present, e.g. "add this note. this is for a testing" -> newMessage "this is for a testing"). Set ' +
    "newMessage to the exact remaining text stated, else null if truly no text follows. " +
    '"other" = a genuine question, or anything that isn\'t a decision or a change to one of those things. ' +
    "Never invent a rate, name, note, care need, or preference the message doesn't state.",
    text
  );
  return parseJsonLoose(raw, "handleBkConfirm");
}

// Mirrors the site's own Edit button (which reveals every section for
// in-place changes rather than forcing a cancel-and-restart) — added
// 2026-09-13 after Hamse asked whether the recap supported editing. A
// correction ("actually make it $28/hr") is classified here as its own
// action, distinct from YES/NO/a genuine question, so it never gets
// mis-routed into the mid-flow question answerer or silently ignored.
async function handleBkConfirm(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);

  // 2026-09-14 (live-caught, twice in one session): a bare "yes" against this
  // long, multi-section recap got misclassified by isBackOutRequest as a
  // cancel request — a probabilistic classifier call is too risky as the
  // ONLY gate on a money-moving confirm step. An unambiguous affirmative
  // (the same canonical word set approvalHandler.ts treats as a real YES
  // everywhere else) can never reasonably mean "cancel", so it skips both
  // the back-out check and the full classify call entirely and goes
  // straight to commit — removing the misclassification risk by construction
  // instead of hoping the model gets a borderline call right.
  const bareYes = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  let action: string | undefined;
  let parsed: any | null = null;
  if (TRIVIAL_CONFIRM_WORDS.has(bareYes)) {
    action = "confirm";
  } else {
    if (await isBackOutRequest(text, buildBookingRecap(data))) return handleBookingBackOut(phone, chatId, session);
    parsed = await classifyBkConfirmReply(text);
    action = parsed?.action as string | undefined;
  }

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
    // 2026-09-13 (live-caught, "it's keep repeating"): re-sending the WHOLE
    // recap after every genuine mid-flow question made the confirm step
    // feel like a broken record. A real question gets answered plus a SHORT
    // reminder now — only a truly unclassifiable reply re-shows the full
    // recap, to help the family re-orient when nothing else matched.
    if (await isQuestionOrOther(text, CONFIRM_QUESTION_FALLBACK)) {
      await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
      await sendMessage(chatId, CONFIRM_QUESTION_FALLBACK);
      return;
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
    const { createBookingTask, executeBookings } = await import("./bookingExecutor");
    // 2026-09-14: unified to match the site's own schedule shape exactly —
    // always days + startDate + ongoing/endDate, never a separate raw
    // appointments-dates path. onBookingAccepted (shiftGenerator.ts, the
    // SAME trigger the site's own bookings rely on) correctly generates
    // exactly one shift for a single-day, non-ongoing schedule (startDate
    // === endDate), so a genuine one-time visit needs nothing special here.
    const appointments: never[] = [];
    // 2026-09-14 (live-caught): the site's own dayShiftTimes shape is an
    // ARRAY of blocks per day (it supports more than one time block on the
    // same day) — writing a bare {start,end} object per day instead meant
    // shiftGenerator.ts's onBookingAccepted trigger (which calls
    // .filter()/.forEach() on each day's value) silently never generated any
    // real shifts docs at all for an Evia-originated booking, and the
    // client's own booking card (same array-length check) rendered a blank
    // schedule line.
    //
    // 2026-09-14 (live-caught, SAME session, found right after the above):
    // data.days/data.dayTimes are keyed by FULL weekday names ("Monday") —
    // asked for that way so the SMS recap reads naturally ("Monday,
    // Wednesday") — but the site's OWN dayShiftTimes convention (PostsPage.
    // tsx's booking modal, and both CaregiverBookingsPage.tsx's and
    // ClientVisitsPage.tsx's summary-line rendering) keys it by the 3-letter
    // abbreviation ("Mon"). Writing full names meant the weekly-schedule
    // SUMMARY LINE silently rendered blank on both dashboards for every
    // Evia-originated recurring booking — even though shiftGenerator.ts's
    // own internal normDay() call still generated the real per-visit shift
    // docs correctly, masking the bug in practice. normDay is the same
    // normalizer shiftGenerator.ts itself uses, imported here so this can
    // never drift from that canonical mapping.
    const schedule = {
      dayShiftTimes: Object.fromEntries(
        Object.entries(data.dayTimes ?? {}).map(([day, t]) => [normDay(day), [t]])
      ),
      ongoing: data.ongoing === true,
      startDate: data.startDate ?? businessTodayStr(),
      ...(data.ongoing !== true && data.scheduleEndDate ? { endDate: data.scheduleEndDate } : {}),
    };
    // No appointments array to sum — totalCostOverride supplies the
    // per-cycle estimate instead (matches request_booking's own
    // estimatedTotal computation). Summed per-day since each day can have
    // its own start/end.
    const totalCostOverride = Math.round(Object.values(data.dayTimes ?? {}).reduce((sum, t) => {
      const s = bookingTimeToMinutes(t.start);
      const e = bookingTimeToMinutes(t.end);
      return sum + ((s !== null && e !== null) ? (e - s) / 60 : 0);
    }, 0) * data.hourlyRate! * 100) / 100;

    const taskId = await createBookingTask({
      clientPhone:   phoneForTask,
      clientId,
      caregiverId:   data.caregiverId,
      caregiverName: data.caregiverName,
      appointments,
      hourlyRate:    data.hourlyRate!,
      schedule,
      totalCostOverride,
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

    // 2026-09-13 (live-caught): createBookingTask only STAGES an agent_tasks
    // doc (status: "awaiting_approval") — it never touches booking_requests,
    // the collection the site's own UI and the caregiver's shift-offer flow
    // actually read from. Evia told the family "Sent to Basra Yousuf" while
    // the site still showed "Send Booking" available and the caregiver was
    // never notified at all. executeBookings is the second step every other
    // caller of createBookingTask already goes through (taskApprovalHandler,
    // routeIntent's approval paths) — it does the real booking_requests
    // write, accepts the caregiver's application, and sends the caregiver's
    // shift offer. It also sends its OWN "request sent, awaiting their
    // confirmation" message to the family, so this flow must NOT also send
    // one — that would be a second, redundant confirmation.
    await executeBookings(taskId, phoneForTask);
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
