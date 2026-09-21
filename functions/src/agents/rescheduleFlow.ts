// Scripted visit-reschedule flow — the website's Reschedule button on My
// Bookings > Active Bookings > UPCOMING SHIFTS (components/client/
// ClientVisitsPage.tsx: handleProposeReschedule) walked step for step over
// SMS:
//
//   the family's real upcoming scheduled visits (fresh from Firestore, never
//   from memory) → which one → new day + start/end → own-visit conflict
//   check → recap → YES → the SAME reschedulePending* write the button makes.
//
// Built 2026-09-15 after a live test: left to the free-form agent loop,
// Evia asserted a visit existed on a day it didn't, applied "9/17 10am to
// 3pm" to the WRONG visit (the needs_replacement one next to the scheduled
// one), and a plain reschedule reply got hijacked by the memory-correction
// detector. Same pattern as replacementFlow.ts / bookingFlow.ts: session-
// state step machine dispatched BEFORE intent classification, back-out
// check first on every step, isQuestionOrOther guard, deterministic bare
// number / yes / no before any model call, one recap + explicit YES gate.
// Nothing is written until that YES. Shares every check and write with the
// MCP tool (manage_booking propose_reschedule) via agents/shiftReschedule.ts.
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS, bareNumberPick } from "./stepHandler";
import { businessTodayStr, formatDateWithWeekday, formatHHMMForDisplay, weekdayForDate } from "../utils/scheduledTime";
import { describeVisitWindow } from "./shiftReplacement";
import {
  listReschedulableVisits, loadReschedulableShift, proposeShiftReschedule, validateRescheduleTarget,
  type ReschedulableVisit,
} from "./shiftReschedule";

const db = admin.firestore();

// ── Session data shape ────────────────────────────────────────────────────────

export interface RescheduleFlowData {
  // The real upcoming scheduled visits at flow start (the site's list).
  visits: ReschedulableVisit[];
  // Chosen visit (set at rs_pick or on entry).
  shiftId?: string;
  caregiverName?: string;
  visitDate?: string;
  visitStart?: string;
  visitEnd?: string;
  // The proposal.
  newDate?: string;
  newStart?: string;
  newEnd?: string;
}

const RS_DIDNT_CATCH = "Sorry, I didn't quite catch that.";
const BARE_NO = new Set(["NO", "N", "NOPE", "NAH"]);

// ── Model plumbing (same shape as replacementFlow.ts so tests drive it identically) ─

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const response = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:     prompt + "\nReply with ONLY the requested value or format — no explanation, no extra text, no questions. Never invent information the user's message doesn't contain.",
      messages:   [{ role: "user", content: userText }],
    });
    const parsed = ((response.content[0] as { text: string }).text ?? "").trim();
    if (parsed && caraOutputGuardEnabled() && !guardModelOutput(parsed).ok) {
      console.warn("[rescheduleFlow] parseWithClaude: output guard rejected model response", { rawLength: parsed.length });
      return "__parse_error__";
    }
    return parsed;
  } catch (err) {
    console.error("[rescheduleFlow] parseWithClaude: Anthropic call threw", err);
    return "__parse_error__";
  }
}

function parseJsonLoose(raw: string, where: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    console.warn(`[rescheduleFlow] ${where}: JSON.parse failed on model output`, { raw: raw.slice(0, 300) });
    return null;
  }
}

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The question Evia just asked the family was: "${currentQuestion}"\n\n` +
    "Reply NO if the family's message is ANY attempt — even a single word, a bare number, a date, a time, or a short/partial/vague one — " +
    "to address that specific question. A vague or incomplete attempt still counts as a direct answer. " +
    "Reply YES only if the message is a genuine question, or a comment that does not attempt to address what was asked at all. " +
    "Only reply YES or NO.",
    text,
  );
  return result.toUpperCase().startsWith("Y");
}

const RS_MIDFLOW_FALLBACK = "Good question — I don't want to guess on that one.";

async function answerQuestionMidFlow(text: string): Promise<string> {
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a family move one of their scheduled care visits to a different " +
      "day or time. You see ONLY this one message, not the rest of the conversation — including anything Evia " +
      "herself said earlier. NEVER claim something was or wasn't mentioned before; you cannot know that. NEVER " +
      "state whether a visit exists on a given day — you cannot see the schedule. If the message is clearly about " +
      "something OTHER than finishing this reschedule — a different visit, billing, a job post — do not try to " +
      "answer it or guess; say plainly that it'll have to wait, e.g. \"That sounds like something else — let's " +
      "finish this first, and I'll help with that right after.\" Otherwise answer their actual question about " +
      "rescheduling briefly (1–2 sentences). Be warm. NEVER write out a URL, and never claim you just sent or will " +
      "send a link. " + ANTI_INVENTION_CLAUSE,
    messages: [{ role: "user", content: text }],
  });
  const answer = ((response.content[0] as { text: string }).text ?? "").trim();
  if (answer && caraOutputGuardEnabled() && !guardModelOutput(answer).ok) return RS_MIDFLOW_FALLBACK;
  return answer;
}

// ── Session helpers ───────────────────────────────────────────────────────────

async function getFlowData(phone: string): Promise<RescheduleFlowData> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return (snap.data()?.rescheduleFlowData ?? { visits: [] }) as RescheduleFlowData;
}

async function mergeFlowData(phone: string, data: Partial<RescheduleFlowData>): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const existing = (snap.data()?.rescheduleFlowData ?? { visits: [] }) as RescheduleFlowData;
  await db.collection("agent_sessions").doc(phone).update({ rescheduleFlowData: { ...existing, ...data } });
}

async function updateStep(phone: string, step: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ rescheduleFlowStep: step });
}

async function clearFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    rescheduleFlowStep: admin.firestore.FieldValue.delete(),
    rescheduleFlowData: admin.firestore.FieldValue.delete(),
    stateExpiresAt:     admin.firestore.FieldValue.delete(),
  });
}

async function handleRescheduleBackOut(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await clearFlow(phone);
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: "The family decided not to move their care visit after all. Warmly confirm nothing was changed and the visit stays exactly as scheduled.",
    fallback: "No problem — I haven't changed anything. The visit stays exactly as scheduled.",
    maxTokens: 80,
  }));
}

// ── Copy ──────────────────────────────────────────────────────────────────────

function visitLine(v: ReschedulableVisit): string {
  const pending = v.pendingDate
    ? ` (a move to ${describeVisitWindow({ date: v.pendingDate, startTime: v.pendingStart, endTime: v.pendingEnd })} is already pending)`
    : "";
  return `${describeVisitWindow({ date: v.date, startTime: v.startTime, endTime: v.endTime })} with ${v.caregiverName}${pending}`;
}

function visitList(d: RescheduleFlowData): string {
  return d.visits.map((v, i) => `${i + 1}. ${visitLine(v)}`).join("\n");
}

function currentWindow(d: RescheduleFlowData): string {
  return describeVisitWindow({ date: d.visitDate, startTime: d.visitStart, endTime: d.visitEnd });
}

function proposedWindow(d: RescheduleFlowData): string {
  return describeVisitWindow({ date: d.newDate, startTime: d.newStart, endTime: d.newEnd });
}

function PICK_QUESTION(d: RescheduleFlowData): string {
  return `Here are your upcoming scheduled visits:\n\n${visitList(d)}\n\nWhich one would you like to move? Reply with a number.`;
}

function TIME_QUESTION(d: RescheduleFlowData): string {
  return `What day and time should the ${currentWindow(d)} visit move to? (For example "Thursday 9/17, 10am to 3pm".)`;
}

function RECAP(d: RescheduleFlowData): string {
  return `Move the ${currentWindow(d)} visit with ${d.caregiverName} to ${proposedWindow(d)}?\n\n` +
    `${d.caregiverName} will need to accept before anything changes. Reply YES to send it, NO to leave it as is, or tell me a different day/time.`;
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export interface StartRescheduleArgs {
  shiftId?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  // The family's own message that triggered this (e.g. "move Wednesday's
  // visit to 9/17 10am to 3pm") — parsed against the REAL visit list so the
  // pick and the new time both come from what they actually said.
  initialText?: string;
  // Tool path: when there is nothing to reschedule, return the explanation
  // instead of texting it — the model decides once (live 2026-09-20: "set up an
  // interview with Basra" was routed here, the no-visits line went out twice,
  // and the model then replied as if an interview flow had started).
  quiet?: boolean;
}

function resolveVisit(d: RescheduleFlowData, pickIndex: unknown, pickDate: unknown): ReschedulableVisit | undefined {
  if (typeof pickIndex === "number" && pickIndex >= 1 && pickIndex <= d.visits.length) return d.visits[pickIndex - 1];
  if (typeof pickDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(pickDate)) {
    const onDate = d.visits.filter((v) => v.date === pickDate);
    if (onDate.length === 1) return onDate[0];
  }
  return undefined;
}

function validProposal(date: unknown, start: unknown, end: unknown): boolean {
  return validateRescheduleTarget(date, start, end).ok;
}

async function selectVisit(phone: string, v: ReschedulableVisit): Promise<void> {
  await mergeFlowData(phone, {
    shiftId: v.id, caregiverName: v.caregiverName, visitDate: v.date, visitStart: v.startTime, visitEnd: v.endTime,
  });
}

export async function startRescheduleFlow(
  phone: string, chatId: string, session: AgentSession, args: StartRescheduleArgs = {},
): Promise<{ started: boolean; reason?: string; message?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to look up your visits. Please try again.");
    return { started: false, reason: "no_client_id" };
  }
  // Always fresh — the family may have changed things on the site since.
  const visits = await listReschedulableVisits(clientId);
  if (visits.length === 0) {
    const message =
      "I don't see any upcoming scheduled visits to move right now. If you're expecting one, check your My Bookings page — " +
      "a visit still waiting on a caregiver's acceptance or a replacement can't be rescheduled yet.";
    if (!args.quiet) await sendMessage(chatId, message);
    return { started: false, reason: "no_visits", message };
  }

  const data: RescheduleFlowData = { visits };
  await db.collection("agent_sessions").doc(phone).update({
    rescheduleFlowStep: "rs_pick",
    rescheduleFlowData: data,
    stateExpiresAt:     new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  // 1. An explicit shiftId (from the agent) wins if it's really on the list.
  let chosen = args.shiftId ? visits.find((v) => v.id === args.shiftId) : undefined;
  let newDate = args.date, newStart = args.startTime, newEnd = args.endTime;

  // 2. Otherwise read the family's own words against the REAL list.
  if ((!chosen || !validProposal(newDate, newStart, newEnd)) && args.initialText?.trim()) {
    const raw = await parseWithClaude(
      `Today is ${formatDateWithWeekday(businessTodayStr())} (${businessTodayStr()}). The family's upcoming scheduled visits, numbered:\n${visitList(data)}\n` +
      `(dates: ${visits.map((v, i) => `${i + 1}=${v.date}`).join(", ")})\n\n` +
      "The family wants to move ONE of these visits. Return ONLY a JSON object: " +
      '{"pickIndex": 1-based number of the visit they mean or null if unclear, "pickDate": "YYYY-MM-DD" of the CURRENT visit they mean or null, ' +
      '"newDate": "YYYY-MM-DD" they want to move it TO or null, "newStart": "HH:MM" 24-hour or null, "newEnd": "HH:MM" 24-hour or null}. ' +
      "If they gave only a new time (no new day), newDate is null. If they gave a start and a duration, compute the end. Never guess a visit or a time they didn't state.",
      args.initialText,
    );
    const parsed = parseJsonLoose(raw, "startRescheduleFlow");
    if (parsed) {
      if (!chosen) chosen = resolveVisit(data, parsed.pickIndex, parsed.pickDate);
      if (!validProposal(newDate, newStart, newEnd)) {
        newStart = typeof parsed.newStart === "string" ? parsed.newStart : undefined;
        newEnd = typeof parsed.newEnd === "string" ? parsed.newEnd : undefined;
        newDate = typeof parsed.newDate === "string" ? parsed.newDate : undefined;
      }
    }
  }
  // 3. Exactly one visit → nothing to pick.
  if (!chosen && visits.length === 1) chosen = visits[0];

  if (!chosen) {
    await sendMessage(chatId, PICK_QUESTION(data));
    return { started: true };
  }
  await selectVisit(phone, chosen);
  // A time-only change keeps the visit's own day.
  if (!newDate && newStart && newEnd) newDate = chosen.date;
  if (validProposal(newDate, newStart, newEnd)) {
    await mergeFlowData(phone, { newDate, newStart, newEnd });
    return goToRecap(phone, chatId).then(() => ({ started: true }));
  }
  await updateStep(phone, "rs_ask_time");
  const d = await getFlowData(phone);
  await sendMessage(chatId, TIME_QUESTION(d));
  return { started: true };
}

// ── Step dispatch ─────────────────────────────────────────────────────────────

export async function handleRescheduleFlowStep(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const step = ((session as any).rescheduleFlowStep as string) ?? "";
  switch (step) {
    case "rs_pick":     return handleRsPick(phone, chatId, text, session);
    case "rs_ask_time": return handleRsAskTime(phone, chatId, text, session);
    case "rs_confirm":  return handleRsConfirm(phone, chatId, text, session);
    default: {
      const data = await getFlowData(phone);
      await updateStep(phone, "rs_pick");
      await sendMessage(chatId, PICK_QUESTION(data));
    }
  }
}

async function goToRecap(phone: string, chatId: string): Promise<void> {
  await updateStep(phone, "rs_confirm");
  const data = await getFlowData(phone);
  await sendMessage(chatId, RECAP(data));
}

// ── Step: which visit ─────────────────────────────────────────────────────────

async function handleRsPick(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = PICK_QUESTION(data);

  // A bare number is the pick — no model call.
  const bare = bareNumberPick(text, data.visits.length);
  if (bare !== null) {
    await selectVisit(phone, data.visits[bare - 1]);
    await updateStep(phone, "rs_ask_time");
    await sendMessage(chatId, TIME_QUESTION(await getFlowData(phone)));
    return;
  }

  if (await isBackOutRequest(text, question)) return handleRescheduleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }

  const raw = await parseWithClaude(
    `Today is ${businessTodayStr()}. Visits, numbered:\n${visitList(data)}\n(dates: ${data.visits.map((v, i) => `${i + 1}=${v.date}`).join(", ")})\n\n` +
    "The family is picking ONE visit to move and may also be giving the new day/time. Return ONLY a JSON object: " +
    '{"pickIndex": 1-based number or null, "pickDate": "YYYY-MM-DD" of the CURRENT visit they mean or null, ' +
    '"newDate": "YYYY-MM-DD" or null, "newStart": "HH:MM" 24-hour or null, "newEnd": "HH:MM" 24-hour or null}. Never guess a pick.',
    text,
  );
  const parsed = parseJsonLoose(raw, "handleRsPick");
  const chosen = parsed ? resolveVisit(data, parsed.pickIndex, parsed.pickDate) : undefined;
  if (!chosen) {
    await sendMessage(chatId, `${RS_DIDNT_CATCH} ${question}`);
    return;
  }
  await selectVisit(phone, chosen);
  const newDate = typeof parsed.newDate === "string" ? parsed.newDate : (parsed.newStart && parsed.newEnd ? chosen.date : undefined);
  if (validProposal(newDate, parsed.newStart, parsed.newEnd)) {
    await mergeFlowData(phone, { newDate, newStart: parsed.newStart, newEnd: parsed.newEnd });
    return goToRecap(phone, chatId);
  }
  await updateStep(phone, "rs_ask_time");
  await sendMessage(chatId, TIME_QUESTION(await getFlowData(phone)));
}

// ── Step: new day/time ────────────────────────────────────────────────────────

function timeProblemCopy(date: unknown, start: unknown, end: unknown): string | null {
  const check = validateRescheduleTarget(date, start, end);
  if (check.ok) return null;
  if (check.reason === "past_date") return `${formatDateWithWeekday(String(date))} has already passed — what day would you like instead?`;
  if (check.reason === "end_before_start") return "The end time needs to be after the start time — what start and end time would you like?";
  return null;
}

async function handleRsAskTime(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = TIME_QUESTION(data);
  if (await isBackOutRequest(text, question)) return handleRescheduleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }
  const raw = await parseWithClaude(
    `Today is ${formatDateWithWeekday(businessTodayStr())} (${businessTodayStr()}). The visit is currently ${currentWindow(data)} (date ${data.visitDate}). ` +
    'Extract the day/time the family wants to move it to. Return ONLY a JSON object: {"date": "YYYY-MM-DD" or null if they didn\'t give a new day, ' +
    '"start": "HH:MM" 24-hour or null, "end": "HH:MM" 24-hour or null}. If they gave a weekday name, resolve it to the next such date on or after today. ' +
    "If they gave only a start time and a duration, compute the end. If they gave only a new day and no times, leave start/end null. Never invent a time they didn't state.",
    text,
  );
  const parsed = parseJsonLoose(raw, "handleRsAskTime");
  if (!parsed) {
    await sendMessage(chatId, `${RS_DIDNT_CATCH} ${question}`);
    return;
  }
  const date = typeof parsed.date === "string" ? parsed.date : data.visitDate;
  // A new day with no times keeps the visit's own hours (the site pre-fills them).
  const start = typeof parsed.start === "string" ? parsed.start : (typeof parsed.date === "string" ? data.visitStart : undefined);
  const end = typeof parsed.end === "string" ? parsed.end : (typeof parsed.date === "string" ? data.visitEnd : undefined);
  if (validProposal(date, start, end)) {
    await mergeFlowData(phone, { newDate: date, newStart: start, newEnd: end });
    return goToRecap(phone, chatId);
  }
  const problem = timeProblemCopy(date, start, end);
  await sendMessage(chatId, problem ?? `${RS_DIDNT_CATCH} ${question}`);
}

// ── Step: recap → YES sends the proposal ──────────────────────────────────────

async function handleRsConfirm(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const recap = RECAP(data);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");

  // Deterministic YES / NO first — a probabilistic classifier is too risky as
  // the only gate on the commit step (same rule as bookingFlow's bk_confirm).
  if (TRIVIAL_CONFIRM_WORDS.has(bare)) return commitReschedule(phone, chatId, session, data);
  if (BARE_NO.has(bare)) return handleRescheduleBackOut(phone, chatId, session);

  if (await isBackOutRequest(text, recap)) return handleRescheduleBackOut(phone, chatId, session);

  const raw = await parseWithClaude(
    `Today is ${businessTodayStr()}. Evia asked: "${recap}"\nVisits, numbered:\n${visitList(data)}\n\n` +
    'Classify the family\'s reply. Return ONLY a JSON object: {"action": "confirm" | "cancel" | "change_visit" | "change_time" | "other", ' +
    '"pickIndex": 1-based number or null, "newDate": "YYYY-MM-DD" or null, "newStart": "HH:MM" or null, "newEnd": "HH:MM" or null}. ' +
    '"confirm" = clearly wants it sent; "cancel" = doesn\'t want to move anything; "change_visit" = wants to move a different visit ' +
    '(fill pickIndex if they said which); "change_time" = wants a different new day/time (fill the fields they stated); "other" = a question or something else.',
    text,
  );
  const parsed = parseJsonLoose(raw, "handleRsConfirm");
  switch (parsed?.action) {
    case "confirm":
      return commitReschedule(phone, chatId, session, data);
    case "cancel":
      return handleRescheduleBackOut(phone, chatId, session);
    case "change_visit": {
      const chosen = resolveVisit(data, parsed.pickIndex, null);
      if (chosen) {
        await selectVisit(phone, chosen);
        await updateStep(phone, "rs_ask_time");
        await sendMessage(chatId, TIME_QUESTION(await getFlowData(phone)));
        return;
      }
      await updateStep(phone, "rs_pick");
      await sendMessage(chatId, `Sure — which visit instead?\n\n${visitList(data)}\n\nReply with a number.`);
      return;
    }
    case "change_time": {
      const date = typeof parsed.newDate === "string" ? parsed.newDate : (data.newDate ?? data.visitDate);
      const start = typeof parsed.newStart === "string" ? parsed.newStart : data.newStart;
      const end = typeof parsed.newEnd === "string" ? parsed.newEnd : data.newEnd;
      if (validProposal(date, start, end)) {
        await mergeFlowData(phone, { newDate: date, newStart: start, newEnd: end });
        return goToRecap(phone, chatId);
      }
      await updateStep(phone, "rs_ask_time");
      await sendMessage(chatId, TIME_QUESTION(data));
      return;
    }
    default:
      await sendMessage(chatId, await answerQuestionMidFlow(text));
      await sendMessage(chatId, recap);
  }
}

async function commitReschedule(phone: string, chatId: string, session: AgentSession, data: RescheduleFlowData): Promise<void> {
  const clientId = session.userId as string;
  if (!data.shiftId) {
    await updateStep(phone, "rs_pick");
    await sendMessage(chatId, PICK_QUESTION(data));
    return;
  }
  if (!validProposal(data.newDate, data.newStart, data.newEnd)) {
    await updateStep(phone, "rs_ask_time");
    await sendMessage(chatId, TIME_QUESTION(data));
    return;
  }
  // Fresh load: the visit may have been cancelled, moved, or completed on the
  // site since the recap — never write against a stale picture.
  const loaded = await loadReschedulableShift(clientId, data.shiftId);
  if (!loaded.ok) {
    await clearFlow(phone);
    await sendMessage(chatId,
      "That visit isn't a scheduled visit anymore (it may have changed on the site since), so I didn't move anything — " +
      "it's up to date on your My Bookings page.");
    return;
  }
  const result = await proposeShiftReschedule({
    clientId, shiftId: data.shiftId, shift: loaded.shift, shiftRef: loaded.ref,
    date: data.newDate!, startTime: data.newStart!, endTime: data.newEnd!,
    nowIso: new Date().toISOString(), source: "rescheduleFlow",
  });
  if (!result.ok) {
    if (result.code === "CONFLICT") {
      // The site's own alert, worded for SMS — and back to the time question.
      await mergeFlowData(phone, { newDate: undefined, newStart: undefined, newEnd: undefined });
      await updateStep(phone, "rs_ask_time");
      await sendMessage(chatId,
        `That overlaps another visit you already have with ${data.caregiverName} at ` +
        `${formatHHMMForDisplay(result.conflict.startTime)}${result.conflict.endTime ? `–${formatHHMMForDisplay(result.conflict.endTime)}` : ""} ` +
        `on ${weekdayForDate(data.newDate!) ?? "that day"} — choose a different time. ${TIME_QUESTION(data)}`);
      return;
    }
    await updateStep(phone, "rs_ask_time");
    await sendMessage(chatId, `${result.message}. ${TIME_QUESTION(data)}`);
    return;
  }
  await clearFlow(phone);
  // Honest wording: the caregiver still has to accept — the real date/time
  // don't change until they do, exactly as on the site.
  await sendMessage(chatId,
    `Sent — I asked ${result.caregiverName} to move the ${currentWindow(data)} visit to ${proposedWindow(data)}. ` +
    `The visit stays as scheduled until they accept; I'll text you as soon as they respond. It shows as pending on your My Bookings page too.`);
}
