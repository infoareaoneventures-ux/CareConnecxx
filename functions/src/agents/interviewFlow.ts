// Scripted, step-by-step interview-scheduling flow — mirrors bookingFlow.ts's
// pattern (session-state field machine, one question per turn, isQuestionOrOther
// guard, parseWithClaude extraction with re-ask-never-silently-default, ending
// in a structured recap + explicit YES/NO/edit).
//
// Built 2026-09-13 after a live SMS test showed schedule_interview has no
// protection at all from intent-classification hijacking: mid-way through
// scheduling an interview, the family asked "can you link to a job post" — a
// legitimate question about THIS interview — and the intent classifier
// misfired to POST_JOB, hijacking the whole session into jobPostingFlow.ts's
// own step machine with no way back out. Same root cause that got
// bookingFlow.ts built in the first place (request_booking was collected ad
// hoc inside the general qaAgent loop, exposed to the same class of misfire).
//
// Ask/show order matches the site's real "Request Interview" modal
// (components/ScheduleInterviewModal.tsx) top to bottom: Related Job Post
// (Optional) → Select Date → Select Time → Notes (Optional). No interview-
// type question — the site removed Phone/In-Person entirely on 2026-09-08
// ("every interview is a video call; no selector needed"), so this flow never
// asks either, always video, matching the site exactly.
//
// Built WITH real mid-flow back-off from the start (unlike bookingFlow.ts,
// which only got a cancel at its final confirm step): every handler below
// checks isBackOutRequest (stepHandler.ts) FIRST, ahead of isQuestionOrOther,
// so "never mind"/"cancel this" clears the flow immediately at ANY step, not
// only at the recap.
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { guardModelOutput } from "../safety/outputGuard";
import { businessTodayStr, parseScheduledTimeMs, formatInterviewTime, formatHHMMForDisplay as formatTimeForDisplay, formatDateForDisplay } from "../utils/scheduledTime";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS } from "./stepHandler";
import {
  resolveCaregiverForInterview, requestVideoInterview, VideoInterviewRequestError,
} from "./videoInterviewRequest";

const db = admin.firestore();

// ── Session data shape ────────────────────────────────────────────────────────

export interface JobPostOption {
  id:    string;
  title: string;
}

export interface InterviewFlowData {
  caregiverId:   string;
  caregiverName: string;
  // Set only when this follows accepting a specific job application — the
  // job is already known and never asked about (matches respond_to_job_
  // application's existing auto-link behavior).
  applicationId?: string;
  jobId?:         string;
  jobTitle?:      string;
  // Populated when there's at least one open job post to pick from; the
  // numbered list shown at iv_ask_job (last entry is always "No specific
  // post"). Never populated (and iv_ask_job never reached) when the client
  // has zero open job posts, or applicationId already resolved the job.
  jobOptions?:    JobPostOption[];
  date?:          string; // YYYY-MM-DD
  time?:          string; // HH:MM 24h
  notes?:         string;
}

const IV_DIDNT_CATCH = "Sorry, I didn't quite catch that.";

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
        console.warn("[interviewFlow] parseWithClaude: output guard rejected model response", { rawLength: parsed.length });
        return "__parse_error__";
      }
    }
    return parsed;
  } catch (err) {
    console.error("[interviewFlow] parseWithClaude: Anthropic call threw", err);
    return "__parse_error__";
  }
}

function parseJsonLoose(raw: string, where: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    console.warn(`[interviewFlow] ${where}: JSON.parse failed on model output`, { raw: raw.slice(0, 300) });
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

const IV_MIDFLOW_FALLBACK = "Good question — I don't want to guess on that one.";

async function answerQuestionMidFlow(text: string, caregiverName: string): Promise<string> {
  // Same fix as bookingFlow.ts/jobPostingFlow.ts: sees ONLY the current
  // message, never the rest of the conversation — including anything Evia
  // herself said earlier. Must never claim something was/wasn't mentioned
  // before, and must not force an out-of-scope question into interview terms.
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a family set up an interview with a caregiver named " +
      `${caregiverName}. You see ONLY this one message, not the rest of the conversation — including anything ` +
      "Evia herself said earlier. NEVER claim something was or wasn't mentioned before; you cannot know that. " +
      "If the message is clearly about something OTHER than finishing this interview request — a different topic " +
      "entirely (a booking, billing, a job post unrelated to this interview) — do not try to answer it or guess " +
      "what it's about. Instead say plainly that it'll have to wait, e.g. \"That sounds like something else — " +
      "let's finish this first, and I'll help with that right after.\" Otherwise answer their actual question " +
      "about this interview briefly (1–2 sentences). Be warm and helpful. NEVER write out a URL or web address, " +
      "and never claim a video call link exists yet — it doesn't until the caregiver confirms.",
    messages: [{ role: "user", content: text }],
  });
  const answer = ((response.content[0] as { text: string }).text ?? "").trim();
  if (answer && caraOutputGuardEnabled() && !guardModelOutput(answer).ok) return IV_MIDFLOW_FALLBACK;
  return answer;
}

async function getFlowData(phone: string): Promise<InterviewFlowData> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return (snap.data()?.interviewFlowData ?? {}) as InterviewFlowData;
}

async function mergeFlowData(phone: string, data: Partial<InterviewFlowData>): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const existing = (snap.data()?.interviewFlowData ?? {}) as InterviewFlowData;
  await db.collection("agent_sessions").doc(phone).update({
    interviewFlowData: { ...existing, ...data },
  });
}

async function updateStep(phone: string, step: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ interviewFlowStep: step });
}

async function clearFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    interviewFlowStep: admin.firestore.FieldValue.delete(),
    interviewFlowData: admin.firestore.FieldValue.delete(),
    stateExpiresAt:    admin.firestore.FieldValue.delete(),
  });
}

// Shared by every step handler — checked FIRST, ahead of isQuestionOrOther,
// so a genuine "never mind"/"cancel this" clears the flow immediately at ANY
// step rather than only working at the final confirm.
async function handleBackOut(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await clearFlow(phone);
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: "The family decided not to set up this interview request after all. Warmly confirm nothing was sent, and let them know you're here whenever they're ready.",
    fallback: "No problem — nothing was sent, and I've dropped that. Let me know whenever you're ready to set it up.",
    maxTokens: 70,
  }));
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function startInterviewFlow(
  phone: string, chatId: string, session: AgentSession,
  args: { caregiverId: string; applicationId?: string },
): Promise<{ started: boolean; reason?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to start this interview request. Please try again.");
    return { started: false, reason: "no_client_id" };
  }

  let resolved;
  try {
    resolved = await resolveCaregiverForInterview(args.caregiverId, phone);
  } catch (err) {
    if (err instanceof VideoInterviewRequestError && err.code === "ambiguous") {
      const names = (err.candidates ?? []).map((c) => `$${c.hourlyRate}/hr`).join(", ");
      await sendMessage(chatId, `${err.message}${names ? ` (${names})` : ""}`);
    } else {
      await sendMessage(chatId, "I couldn't find that caregiver to interview. Can you tell me who you'd like to meet?");
    }
    return { started: false, reason: "caregiver_not_found" };
  }

  const data: InterviewFlowData = {
    caregiverId:   resolved.resolvedCaregiverId,
    caregiverName: resolved.caregiverName,
  };

  // applicationId already tells us the job — never ask, matches respond_to_
  // job_application's existing auto-link (the application already IS for a
  // specific posting).
  if (args.applicationId) {
    const appSnap = await db.collection("job_applications").doc(args.applicationId).get();
    const app = appSnap.exists ? appSnap.data()! : null;
    if (app?.jobId) {
      const jobSnap = await db.collection("job_posts").doc(app.jobId as string).get();
      data.applicationId = args.applicationId;
      data.jobId = app.jobId as string;
      data.jobTitle = (jobSnap.data()?.title as string | undefined) ?? undefined;
    }
  }

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  if (!data.jobId) {
    // Related Job Post — only asked when there's actually something to pick
    // from (matches the site's own modal, which only renders this section
    // when jobPosts.length > 0). Title prefers the real `title` field first
    // (2026-09-13 fix — matches services/api.ts's normalizeJobPost fallback
    // chain), never the generic care-types synthesis list_client_jobs used to
    // fall back to.
    const jobsSnap = await db.collection("job_posts")
      .where("clientId", "==", clientId)
      .where("status", "==", "open")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();
    const jobOptions: JobPostOption[] = jobsSnap.docs.map((d) => {
      const j = d.data();
      const title = (j.title as string | undefined)
        ?? (j.summary as string | undefined)
        ?? `Care job — ${(j.careTypes as string[] ?? []).slice(0, 2).join(", ")}`;
      return { id: d.id, title };
    });
    if (jobOptions.length) {
      await db.collection("agent_sessions").doc(phone).update({
        interviewFlowStep: "iv_ask_job",
        interviewFlowData: { ...data, jobOptions },
        stateExpiresAt:    expiresAt,
      });
      // Single combined message — two separate sendMessage calls here used to
      // occasionally arrive out of order relative to the model's own trailing
      // turn reply (a live-caught delivery race, 2026-09-13). One atomic send
      // removes that risk entirely.
      await sendMessage(chatId, `Let's set up an interview with ${data.caregiverName}!\n\n${JOB_QUESTION(jobOptions)}`);
      return { started: true };
    }
  }

  await db.collection("agent_sessions").doc(phone).update({
    interviewFlowStep: "iv_ask_date",
    interviewFlowData: data,
    stateExpiresAt:    expiresAt,
  });
  await sendMessage(chatId, `Let's set up an interview with ${data.caregiverName}!\n\n${DATE_QUESTION(data.caregiverName)}`);
  return { started: true };
}

// ── Step dispatch ─────────────────────────────────────────────────────────────

export async function handleInterviewFlowStep(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const step = (session as any).interviewFlowStep as string ?? "";
  switch (step) {
    case "iv_ask_job":   return handleIvAskJob(phone, chatId, text, session);
    case "iv_ask_date":  return handleIvAskDate(phone, chatId, text, session);
    case "iv_ask_time":  return handleIvAskTime(phone, chatId, text, session);
    case "iv_ask_notes": return handleIvAskNotes(phone, chatId, text, session);
    case "iv_confirm":   return handleIvConfirm(phone, chatId, text, session);
    default:
      // Shouldn't happen (the flow always sets a step when active), but
      // fail safe rather than throw on an unrecognized/stale step value.
      await sendMessage(chatId, DATE_QUESTION(""));
  }
}

// ── Step: related job post (only asked when there's something to pick) ──────

function formatJobOptions(options: JobPostOption[]): string {
  const lines = options.map((o, i) => `${i + 1}) ${o.title}`);
  lines.push(`${options.length + 1}) No specific post`);
  return lines.join("\n");
}

const JOB_QUESTION = (options: JobPostOption[]) =>
  `Want to link this to one of your job posts?\n\n${formatJobOptions(options)}`;

async function handleIvAskJob(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const options = data.jobOptions ?? [];
  const question = JOB_QUESTION(options);
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }
  const raw = await parseWithClaude(
    `The family is picking a job post to link this interview to. Options:\n${formatJobOptions(options)}\n\n` +
    'Which number did they pick? Return ONLY a JSON object: {"index": number or null} — the LAST number ' +
    '("No specific post") if they decline/say none, or null if unclear. Never invent a pick the message doesn\'t support.',
    text
  );
  const parsed = parseJsonLoose(raw, "handleIvAskJob");
  const idx = typeof parsed?.index === "number" ? parsed.index : null;
  if (idx === null || idx < 1 || idx > options.length + 1) {
    await sendMessage(chatId, `${IV_DIDNT_CATCH} ${question}`);
    return;
  }
  if (idx <= options.length) {
    const picked = options[idx - 1];
    await mergeFlowData(phone, { jobId: picked.id, jobTitle: picked.title });
  }
  await updateStep(phone, "iv_ask_date");
  const updated = await getFlowData(phone);
  await sendMessage(chatId, DATE_QUESTION(updated.caregiverName));
}

// ── Step: date ────────────────────────────────────────────────────────────────

const DATE_QUESTION = (caregiverName: string) => `What day would you like the interview with ${caregiverName}?`;

async function handleIvAskDate(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const question = DATE_QUESTION(data.caregiverName);
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }
  const today = businessTodayStr();
  const raw = await parseWithClaude(
    `Today is ${today}. Extract the date the family wants for this interview, resolved relative to today. ` +
    'Return ONLY a JSON object: {"date": "YYYY-MM-DD" or null}. Never invent a date the message doesn\'t support.',
    text
  );
  const parsed = parseJsonLoose(raw, "handleIvAskDate");
  const date = typeof parsed?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null;
  if (!date || date < today) {
    await sendMessage(chatId, `${IV_DIDNT_CATCH} ${question}`);
    return;
  }
  await mergeFlowData(phone, { date });
  await updateStep(phone, "iv_ask_time");
  await sendMessage(chatId, `${formatDateForDisplay(date)} — got it! ${TIME_QUESTION(date)}`);
}

// ── Step: time ────────────────────────────────────────────────────────────────

// `date` stays raw "YYYY-MM-DD" internally (parsing/comparisons need it) —
// only formatted for display, here at render time.
const TIME_QUESTION = (date: string) => `What time on ${formatDateForDisplay(date)} works?`;

async function handleIvAskTime(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const question = TIME_QUESTION(data.date ?? "");
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }
  const raw = await parseWithClaude(
    'Extract the time from this message. Return HH:MM in 24-hour format (e.g. "9am" → "09:00", "2:30pm" → "14:30"). ' +
    'Return ONLY a JSON object: {"time": "HH:MM" or null}.',
    text
  );
  const parsed = parseJsonLoose(raw, "handleIvAskTime");
  const time = typeof parsed?.time === "string" && /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : null;
  if (!time) {
    await sendMessage(chatId, `${IV_DIDNT_CATCH} ${question}`);
    return;
  }
  await mergeFlowData(phone, { time });
  await updateStep(phone, "iv_ask_notes");
  const updated = await getFlowData(phone);
  await sendMessage(chatId, NOTES_QUESTION(updated.caregiverName));
}

// ── Step: notes (proactive, matches the site's own optional field position) ─

const NOTES_QUESTION = (caregiverName: string) =>
  `Anything you'd like to flag for the interview with ${caregiverName} — topics to discuss, etc.? Reply with what you'd like to say, or "no" to skip.`;

async function handleIvAskNotes(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);
  const question = NOTES_QUESTION(data.caregiverName);
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
    await sendMessage(chatId, question);
    return;
  }
  const decision = await parseWithClaude(
    'Is the family declining/skipping a note ("no", "skip", "nothing", "nope", "no thanks", "not needed"), or is ' +
    "this message itself the note they want flagged for the interview? Reply with exactly SKIP or NOTE.",
    text
  );
  if (decision.toUpperCase().startsWith("SKIP")) {
    await updateStep(phone, "iv_confirm");
    const updated = await getFlowData(phone);
    await sendMessage(chatId, buildInterviewRecap(updated));
    return;
  }
  const trimmed = text.trim().slice(0, 2000);
  if (!trimmed) {
    await sendMessage(chatId, `${IV_DIDNT_CATCH} ${question}`);
    return;
  }
  await mergeFlowData(phone, { notes: trimmed });
  await updateStep(phone, "iv_confirm");
  const updated = await getFlowData(phone);
  await sendMessage(chatId, buildInterviewRecap(updated));
}

// ── Confirm / recap ───────────────────────────────────────────────────────────

export function buildInterviewRecap(data: InterviewFlowData): string {
  const jobLine = data.jobTitle ?? "No specific post";
  const notesLine = data.notes ? `"${data.notes}"` : "None";
  const timeLabel = data.time ? formatTimeForDisplay(data.time) : data.time;
  const dateLabel = data.date ? formatDateForDisplay(data.date) : data.date;
  return [
    `Here's the interview request:`,
    ``,
    `Caregiver: ${data.caregiverName}`,
    `Related job post: ${jobLine}`,
    `Date & time: ${dateLabel} at ${timeLabel}`,
    `Notes: ${notesLine}`,
    ``,
    `Reply YES to send it, or tell me what to change.`,
  ].join("\n");
}

const CONFIRM_QUESTION_FALLBACK = "Confirming whether to send this interview request — reply YES to send it, or NO to cancel.";

async function classifyIvConfirmReply(text: string): Promise<any | null> {
  const raw = await parseWithClaude(
    "The family is reviewing an interview request summary before it sends. Classify their reply. Return ONLY a " +
    'JSON object: {"action": "confirm" | "cancel" | "edit_job" | "edit_date" | "edit_time" | "edit_notes" | ' +
    '"other", "jobIndex": number or null, "newDate": "YYYY-MM-DD" or null, "newTime": "HH:MM" or null, ' +
    '"newNotes": string or null}. ' +
    '"confirm" = yes/send it/go ahead/looks good. "cancel" = no/never mind/stop. ' +
    '"edit_job" = wants to change which job post this links to (or link/unlink one) — set jobIndex to the number ' +
    "they picked from the job-post list if THIS message states one, else null. " +
    '"edit_date" = wants to change the day — set newDate (YYYY-MM-DD) ONLY if this exact message states one, else null. ' +
    '"edit_time" = wants to change the time — set newTime (HH:MM 24h) ONLY if this exact message states one, else null. ' +
    '"edit_notes" = wants to add/change the note for this interview — set newNotes to the exact text stated, else null. ' +
    '"other" = a genuine question, or anything that isn\'t a decision or a change to one of those things. ' +
    "Never invent a date, time, note, or job pick the message doesn't state.",
    text
  );
  return parseJsonLoose(raw, "handleIvConfirm");
}

async function handleIvConfirm(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const data = await getFlowData(phone);

  // 2026-09-14 — same fix as bookingFlow.ts's handleBkConfirm: a bare,
  // unambiguous affirmative can never reasonably mean "cancel", so it skips
  // the probabilistic isBackOutRequest/classify calls entirely instead of
  // trusting them to get a borderline call right against a long recap.
  const bareYes = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  let action: string | undefined;
  let parsed: any | null = null;
  if (TRIVIAL_CONFIRM_WORDS.has(bareYes)) {
    action = "confirm";
  } else {
    if (await isBackOutRequest(text, buildInterviewRecap(data))) return handleBackOut(phone, chatId, session);
    parsed = await classifyIvConfirmReply(text);
    action = parsed?.action;
  }

  if (action === "cancel") return handleBackOut(phone, chatId, session);

  if (action === "edit_job") {
    const options = data.jobOptions ?? [];
    if (!options.length) {
      await sendMessage(chatId, "I don't see any open job posts on file to link this to.");
      await sendMessage(chatId, buildInterviewRecap(data));
      return;
    }
    const idx = typeof parsed?.jobIndex === "number" ? parsed.jobIndex : null;
    if (idx !== null && idx >= 1 && idx <= options.length + 1) {
      if (idx <= options.length) {
        const picked = options[idx - 1];
        await mergeFlowData(phone, { jobId: picked.id, jobTitle: picked.title });
      } else {
        await mergeFlowData(phone, { jobId: undefined, jobTitle: undefined });
      }
      const updated = await getFlowData(phone);
      await sendMessage(chatId, buildInterviewRecap(updated));
      return;
    }
    await updateStep(phone, "iv_ask_job");
    await sendMessage(chatId, JOB_QUESTION(options));
    return;
  }

  if (action === "edit_date") {
    if (typeof parsed?.newDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.newDate) && parsed.newDate >= businessTodayStr()) {
      await mergeFlowData(phone, { date: parsed.newDate });
      const updated = await getFlowData(phone);
      await sendMessage(chatId, buildInterviewRecap(updated));
      return;
    }
    await updateStep(phone, "iv_ask_date");
    await sendMessage(chatId, DATE_QUESTION(data.caregiverName));
    return;
  }

  if (action === "edit_time") {
    if (typeof parsed?.newTime === "string" && /^\d{2}:\d{2}$/.test(parsed.newTime)) {
      await mergeFlowData(phone, { time: parsed.newTime });
      const updated = await getFlowData(phone);
      await sendMessage(chatId, buildInterviewRecap(updated));
      return;
    }
    await updateStep(phone, "iv_ask_time");
    await sendMessage(chatId, TIME_QUESTION(data.date ?? ""));
    return;
  }

  if (action === "edit_notes") {
    if (typeof parsed?.newNotes === "string" && parsed.newNotes.trim()) {
      await mergeFlowData(phone, { notes: parsed.newNotes.trim().slice(0, 2000) });
      const updated = await getFlowData(phone);
      await sendMessage(chatId, buildInterviewRecap(updated));
      return;
    }
    await updateStep(phone, "iv_ask_notes");
    await sendMessage(chatId, NOTES_QUESTION(data.caregiverName));
    return;
  }

  if (action !== "confirm") {
    // 2026-09-13 (same live-caught repetition fix as bookingFlow.ts): a real
    // question gets answered plus a short reminder, not the whole recap
    // again — only a truly unclassifiable reply re-shows the full recap.
    if (await isQuestionOrOther(text, CONFIRM_QUESTION_FALLBACK)) {
      await sendMessage(chatId, await answerQuestionMidFlow(text, data.caregiverName));
      await sendMessage(chatId, CONFIRM_QUESTION_FALLBACK);
      return;
    }
    await sendMessage(chatId, buildInterviewRecap(data));
    return;
  }

  // YES — commit. Calls requestVideoInterview directly (mirrors bookingFlow.
  // ts's createBookingTask pattern) — no MCP tool, no pending-action gate:
  // this flow owns its own confirm step already.
  const clientId = session.userId as string | undefined;
  if (!clientId || !data.date || !data.time) {
    await sendMessage(chatId, "I couldn't find enough details to send this interview request. Please try again.");
    return;
  }
  try {
    const startMs = parseScheduledTimeMs(`${data.date}T${data.time}:00`);
    if (Number.isNaN(startMs)) throw new VideoInterviewRequestError("invalid-argument", "Could not resolve the date/time");
    const interview = await requestVideoInterview({
      clientId, caregiverId: data.caregiverId,
      scheduledTime: new Date(startMs).toISOString(),
      ...(data.jobId ? { jobId: data.jobId } : {}),
      ...(data.jobTitle ? { jobTitle: data.jobTitle } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
      source: "interviewFlow",
      phone,
    });
    await clearFlow(phone);
    const { resolveCommitment } = await import("./commitmentTracker");
    await resolveCommitment(phone, "interview", "scheduled").catch(() => {});
    await sendMessage(chatId,
      `Sent to ${interview.caregiverName} for ${formatInterviewTime(startMs)} — I'll let you know as soon as they confirm. No video link exists yet; I'll share it the moment they accept.`
    );
  } catch (err) {
    if (err instanceof VideoInterviewRequestError) {
      const message = err.code === "resource-exhausted"
        ? "You've hit today's limit of interview requests — please try again tomorrow."
        : err.code === "failed-precondition"
        ? "That caregiver isn't available for interviews right now."
        : "Something went wrong scheduling that interview — please try again.";
      await sendMessage(chatId, message);
      return;
    }
    console.error("[interviewFlow] requestVideoInterview error:", err);
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: "Something went wrong while sending the family's interview request. Warmly apologize and ask them to try again.",
      fallback: "Sorry, I ran into a problem sending that interview request. Please try again.",
      maxTokens: 70,
    }));
  }
}
