// Scripted shift-replacement flow — the website's Find Replacement modal
// (components/client/ClientVisitsPage.tsx: ReplacementPickerModal +
// handleConfirmReplacement) walked step for step over SMS:
//
//   candidates (profile cards) + "which one, and keep the visit's date/time or
//   change it?" → [new day/time if asked] → recap → YES → the SAME
//   booking_requests write the modal's Request button makes.
//
// Built 2026-09-14 after a live test: left to the free-form agent loop,
// "who is available for replacement" ran a general caregiver search, the
// family's pick turned into an interview (the site has no interview step
// here), and a bare "yes" got hijacked mid-way. Same pattern as
// bookingFlow.ts / interviewFlow.ts: session-state step machine, back-out
// check first on every step, isQuestionOrOther guard, deterministic bare
// number / yes / no before any model call, one recap + explicit YES gate.
// Nothing is written until that YES. Shares every write with the MCP tools
// (get_callout_backups / select_callout_backup) via agents/shiftReplacement.ts.
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { logAudit } from "../observability/auditLog";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS, bareNumberPick } from "./stepHandler";
import { bookingTimeToMinutes } from "./bookingResolution";
import {
  findReplacementCandidates, loadReplacementShift, sendReplacementCandidateCards,
  createReplacementRequest, describeVisitWindow, skipReplacementShift,
} from "./shiftReplacement";

const db = admin.firestore();

// ── Session data shape ────────────────────────────────────────────────────────

export interface ReplacementFlowData {
  shiftId: string;
  candidates: Array<{ id: string; name: string; rate: number | null }>;
  // The visit as it stands (the modal's pre-filled Date / Start / End).
  visitDate: string;
  visitStart: string;
  visitEnd: string;
  // Chosen candidate (set at rp_pick).
  caregiverId?: string;
  caregiverName?: string;
  caregiverRate?: number | null;
  // Set only when the family asked to change the day/time.
  newDate?: string;
  newStart?: string;
  newEnd?: string;
}

const RP_DIDNT_CATCH = "Sorry, I didn't quite catch that.";
const BARE_NO = new Set(["NO", "N", "NOPE", "NAH"]);
// The site's second button. Offered by name in the question, so a bare
// "SKIP" is a protocol word here (like YES/NO), not intent parsing.
const BARE_SKIP = new Set(["SKIP", "SKIP IT"]);

// ── Model plumbing (same shape as bookingFlow.ts so tests drive it identically) ─

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
      console.warn("[replacementFlow] parseWithClaude: output guard rejected model response", { rawLength: parsed.length });
      return "__parse_error__";
    }
    return parsed;
  } catch (err) {
    console.error("[replacementFlow] parseWithClaude: Anthropic call threw", err);
    return "__parse_error__";
  }
}

function parseJsonLoose(raw: string, where: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    console.warn(`[replacementFlow] ${where}: JSON.parse failed on model output`, { raw: raw.slice(0, 300) });
    return null;
  }
}

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The question Evia just asked the family was: "${currentQuestion}"\n\n` +
    "Reply NO if the family's message is ANY attempt — even a single word, a bare number, a name, or a short/partial/vague one — " +
    "to address that specific question. A vague or incomplete attempt still counts as a direct answer. " +
    "Reply YES only if the message is a genuine question, or a comment that does not attempt to address what was asked at all. " +
    "Only reply YES or NO.",
    text,
  );
  return result.toUpperCase().startsWith("Y");
}

const RP_MIDFLOW_FALLBACK = "Good question — I don't want to guess on that one.";

async function answerQuestionMidFlow(text: string): Promise<string> {
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a family send a replacement request for a visit their caregiver " +
      "cancelled. You see ONLY this one message, not the rest of the conversation — including anything Evia herself " +
      "said earlier. NEVER claim something was or wasn't mentioned before; you cannot know that. If the message is " +
      "clearly about something OTHER than finishing this replacement — a different visit, billing, a job post — do " +
      "not try to answer it or guess; say plainly that it'll have to wait, e.g. \"That sounds like something else — " +
      "let's finish this first, and I'll help with that right after.\" Otherwise answer their actual question about " +
      "this replacement briefly (1–2 sentences). Be warm. NEVER write out a URL, and never claim you just sent or " +
      "will send a link. " + ANTI_INVENTION_CLAUSE,
    messages: [{ role: "user", content: text }],
  });
  const answer = ((response.content[0] as { text: string }).text ?? "").trim();
  if (answer && caraOutputGuardEnabled() && !guardModelOutput(answer).ok) return RP_MIDFLOW_FALLBACK;
  return answer;
}

// ── Session helpers ───────────────────────────────────────────────────────────

async function getFlowData(phone: string): Promise<ReplacementFlowData> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return (snap.data()?.replacementFlowData ?? {}) as ReplacementFlowData;
}

async function mergeFlowData(phone: string, data: Partial<ReplacementFlowData>): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const existing = (snap.data()?.replacementFlowData ?? {}) as ReplacementFlowData;
  await db.collection("agent_sessions").doc(phone).update({ replacementFlowData: { ...existing, ...data } });
}

async function updateStep(phone: string, step: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ replacementFlowStep: step });
}

async function clearFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    replacementFlowStep:       admin.firestore.FieldValue.delete(),
    replacementFlowData:       admin.firestore.FieldValue.delete(),
    pendingReplacementShiftId: admin.firestore.FieldValue.delete(),
    stateExpiresAt:            admin.firestore.FieldValue.delete(),
  });
}

async function handleReplacementBackOut(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await clearFlow(phone);
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: "The family decided not to send a replacement request for their cancelled visit after all. Warmly confirm nothing was sent, and that the visit still shows Needs Replacement in the app whenever they want to pick this back up.",
    fallback: "No problem — I haven't sent anything. The visit still shows Needs Replacement in the app whenever you want to pick this back up.",
    maxTokens: 80,
  }));
}

// ── Copy ──────────────────────────────────────────────────────────────────────

function effectiveWindow(d: ReplacementFlowData): string {
  return describeVisitWindow({
    date: d.newDate ?? d.visitDate,
    startTime: d.newStart ?? d.visitStart,
    endTime: d.newEnd ?? d.visitEnd,
  });
}

function candidateList(d: ReplacementFlowData): string {
  return d.candidates.map((c, i) => `${i + 1}. ${c.name}${c.rate ? ` — $${c.rate}/hr` : ""}`).join("\n");
}

// The modal's two decisions in one question: who, and keep or change the
// pre-filled Date / Start / End.
function PICK_QUESTION(d: ReplacementFlowData): string {
  return `Which one would you like to send the request to? Reply with a name or number.\n\n` +
    `I'll keep the visit as is — ${describeVisitWindow({ date: d.visitDate, startTime: d.visitStart, endTime: d.visitEnd })} — unless you tell me a different day or time. ` +
    `Or reply SKIP to cancel this visit without a replacement.`;
}

// The site's Skip button, confirmed before it happens.
function SKIP_QUESTION(d: ReplacementFlowData): string {
  return `Skip the ${describeVisitWindow({ date: d.visitDate, startTime: d.visitStart, endTime: d.visitEnd })} visit? It'll be cancelled with no replacement — the rest of the booking stays as is.\n\n` +
    `Reply YES to skip it, or NO to keep it as Needs Replacement.`;
}

function TIME_QUESTION(d: ReplacementFlowData): string {
  return `What day and time should the replacement visit be? (Currently ${describeVisitWindow({ date: d.visitDate, startTime: d.visitStart, endTime: d.visitEnd })}.)`;
}

function RECAP(d: ReplacementFlowData): string {
  return `Send a replacement request to ${d.caregiverName}${d.caregiverRate ? ` ($${d.caregiverRate}/hr)` : ""} for ${effectiveWindow(d)}?\n\n` +
    `Reply YES to send it, NO to cancel, or tell me what to change (a different caregiver or day/time).`;
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export async function startReplacementFlow(
  phone: string, chatId: string, session: AgentSession, args: { shiftId: string },
): Promise<{ started: boolean; reason?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to look up that visit. Please try again.");
    return { started: false, reason: "no_client_id" };
  }
  const loaded = await loadReplacementShift(clientId, args.shiftId);
  if (!loaded.ok) {
    await sendMessage(chatId, loaded.code === "INVALID_INPUT"
      ? "That visit isn't waiting on a replacement anymore — nothing to do there."
      : "I couldn't find that visit. Please check your bookings in the app and try again.");
    return { started: false, reason: loaded.code.toLowerCase() };
  }
  const shift = loaded.shift;
  const candidates = await findReplacementCandidates(clientId, shift.caregiverId as string, shift as { careRecipients?: Array<{ careNeeds?: string[] }> });
  const nowIso = new Date().toISOString();
  if (candidates.length === 0) {
    // Nobody to offer — the site's only remaining button is Skip, so offer
    // exactly that (as a real flow step, so the family's YES/NO lands here).
    const empty: ReplacementFlowData = {
      shiftId: args.shiftId, candidates: [],
      visitDate: String(shift.date ?? ""), visitStart: String(shift.startTime ?? ""), visitEnd: String(shift.endTime ?? shift.startTime ?? ""),
    };
    await db.collection("agent_sessions").doc(phone).update({
      replacementFlowStep: "rp_skip_confirm",
      replacementFlowData: empty,
      stateExpiresAt:      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await sendMessage(chatId,
      `I couldn't find anyone available to cover the ${describeVisitWindow({ date: empty.visitDate, startTime: empty.visitStart, endTime: empty.visitEnd })} visit right now. ` +
      `Want me to skip it instead? It'll be cancelled with no replacement — the rest of the booking stays as is.\n\n` +
      `Reply YES to skip it, or NO to leave it as Needs Replacement and I'll let you know if someone opens up.`);
    return { started: true, reason: "no_candidates" };
  }

  await sendReplacementCandidateCards(phone, chatId, args.shiftId, candidates, nowIso);

  const data: ReplacementFlowData = {
    shiftId: args.shiftId,
    candidates: candidates.map((c) => ({ id: c.caregiverId, name: c.name, rate: c.hourlyRate ?? null })),
    visitDate: String(shift.date ?? ""),
    visitStart: String(shift.startTime ?? ""),
    visitEnd: String(shift.endTime ?? shift.startTime ?? ""),
  };
  await db.collection("agent_sessions").doc(phone).update({
    replacementFlowStep: "rp_pick",
    replacementFlowData: data,
    stateExpiresAt:      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  await sendMessage(chatId, PICK_QUESTION(data));
  return { started: true };
}

// ── Step dispatch ─────────────────────────────────────────────────────────────

export async function handleReplacementFlowStep(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const step = ((session as any).replacementFlowStep as string) ?? "";
  switch (step) {
    case "rp_pick":     return handleRpPick(phone, chatId, text, session);
    case "rp_ask_time": return handleRpAskTime(phone, chatId, text, session);
    case "rp_confirm":  return handleRpConfirm(phone, chatId, text, session);
    case "rp_skip_confirm": return handleRpSkipConfirm(phone, chatId, text, session);
    default: {
      // Unrecognized/stale step — fail safe by re-asking the pick.
      const data = await getFlowData(phone);
      await updateStep(phone, "rp_pick");
      await sendMessage(chatId, PICK_QUESTION(data));
    }
  }
}

// ── Step: pick a candidate (+ keep or change the time) ────────────────────────

function resolveCandidate(d: ReplacementFlowData, pickIndex: unknown, pickName: unknown) {
  if (typeof pickIndex === "number" && pickIndex >= 1 && pickIndex <= d.candidates.length) return d.candidates[pickIndex - 1];
  if (typeof pickName === "string" && pickName.trim()) {
    const needle = pickName.trim().toLowerCase();
    return d.candidates.find((c) => c.name.toLowerCase() === needle)
      ?? d.candidates.find((c) => c.name.toLowerCase().split(" ")[0] === needle.split(" ")[0])
      ?? d.candidates.find((c) => c.name.toLowerCase().includes(needle));
  }
  return undefined;
}

function validTime(v: unknown): v is string {
  return typeof v === "string" && bookingTimeToMinutes(v) !== null;
}

async function goToRecap(phone: string, chatId: string): Promise<void> {
  await updateStep(phone, "rp_confirm");
  const data = await getFlowData(phone);
  await sendMessage(chatId, RECAP(data));
}

async function handleRpPick(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = PICK_QUESTION(data);

  // A bare number is the pick, time kept as is — no model call.
  const bare = bareNumberPick(text, data.candidates.length);
  if (bare !== null) {
    const c = data.candidates[bare - 1];
    await mergeFlowData(phone, { caregiverId: c.id, caregiverName: c.name, caregiverRate: c.rate });
    return goToRecap(phone, chatId);
  }
  // Bare SKIP — the site's Skip button, offered by name in the question.
  if (BARE_SKIP.has(text.trim().toUpperCase().replace(/[.!?]+$/g, ""))) return goToSkipConfirm(phone, chatId);

  if (await isBackOutRequest(text, question)) return handleReplacementBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }

  const raw = await parseWithClaude(
    `Candidates, numbered:\n${candidateList(data)}\n\n` +
    `The current visit is ${describeVisitWindow({ date: data.visitDate, startTime: data.visitStart, endTime: data.visitEnd })}. ` +
    "The family is picking ONE candidate and may also be asking to change the visit's day/time. Return ONLY a JSON object: " +
    '{"pickIndex": 1-based number or null, "pickName": the candidate name they used or null, ' +
    '"skip": true ONLY if they want to skip/cancel this visit with no replacement at all, else false, ' +
    '"keepTime": true if they said to keep the current time, false if they asked for a different day/time, null if they said nothing about it, ' +
    '"newDate": "YYYY-MM-DD" or null, "newStart": "HH:MM" 24-hour or null, "newEnd": "HH:MM" 24-hour or null}. Never guess a pick.',
    text,
  );
  const parsed = parseJsonLoose(raw, "handleRpPick");
  if (parsed?.skip === true) return goToSkipConfirm(phone, chatId);
  const chosen = parsed ? resolveCandidate(data, parsed.pickIndex, parsed.pickName) : undefined;
  if (!chosen) {
    await sendMessage(chatId, `${RP_DIDNT_CATCH} ${question}`);
    return;
  }
  const patch: Partial<ReplacementFlowData> = { caregiverId: chosen.id, caregiverName: chosen.name, caregiverRate: chosen.rate };
  if (parsed.keepTime === false) {
    if (validTime(parsed.newStart) && validTime(parsed.newEnd) && bookingTimeToMinutes(parsed.newEnd)! > bookingTimeToMinutes(parsed.newStart)!) {
      patch.newStart = parsed.newStart;
      patch.newEnd = parsed.newEnd;
      if (typeof parsed.newDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.newDate)) patch.newDate = parsed.newDate;
      await mergeFlowData(phone, patch);
      return goToRecap(phone, chatId);
    }
    await mergeFlowData(phone, patch);
    await updateStep(phone, "rp_ask_time");
    await sendMessage(chatId, TIME_QUESTION(data));
    return;
  }
  await mergeFlowData(phone, patch);
  return goToRecap(phone, chatId);
}

// ── Step: new day/time (only when the family asked to change it) ──────────────

async function handleRpAskTime(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = TIME_QUESTION(data);
  if (await isBackOutRequest(text, question)) return handleReplacementBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }
  const raw = await parseWithClaude(
    `The visit is currently ${describeVisitWindow({ date: data.visitDate, startTime: data.visitStart, endTime: data.visitEnd })} (date ${data.visitDate}). ` +
    'Extract the day/time the family wants instead. Return ONLY a JSON object: {"keepOriginal": true if they said to keep it as is, else false, ' +
    '"date": "YYYY-MM-DD" or null if they didn\'t change the day, "start": "HH:MM" 24-hour or null, "end": "HH:MM" 24-hour or null}. ' +
    "If they gave only a start time and a duration, compute the end. Never invent a time they didn't state.",
    text,
  );
  const parsed = parseJsonLoose(raw, "handleRpAskTime");
  if (parsed?.keepOriginal === true) {
    await mergeFlowData(phone, { newDate: undefined, newStart: undefined, newEnd: undefined });
    return goToRecap(phone, chatId);
  }
  if (parsed && validTime(parsed.start) && validTime(parsed.end) && bookingTimeToMinutes(parsed.end)! > bookingTimeToMinutes(parsed.start)!) {
    const patch: Partial<ReplacementFlowData> = { newStart: parsed.start, newEnd: parsed.end };
    if (typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) patch.newDate = parsed.date;
    await mergeFlowData(phone, patch);
    return goToRecap(phone, chatId);
  }
  await sendMessage(chatId, `${RP_DIDNT_CATCH} ${question}`);
}

// ── Step: recap → YES sends the request ───────────────────────────────────────

async function handleRpConfirm(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const recap = RECAP(data);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");

  // Deterministic YES / NO first — a probabilistic classifier is too risky as
  // the only gate on the commit step (same rule as bookingFlow's bk_confirm).
  if (TRIVIAL_CONFIRM_WORDS.has(bare)) return commitReplacement(phone, chatId, session, data);
  if (BARE_NO.has(bare)) return handleReplacementBackOut(phone, chatId, session);

  if (await isBackOutRequest(text, recap)) return handleReplacementBackOut(phone, chatId, session);

  const raw = await parseWithClaude(
    `Evia asked: "${recap}"\nCandidates, numbered:\n${candidateList(data)}\n\n` +
    'Classify the family\'s reply. Return ONLY a JSON object: {"action": "confirm" | "cancel" | "change_caregiver" | "change_time" | "skip_visit" | "other", ' +
    '"pickIndex": 1-based number or null, "pickName": string or null, "newDate": "YYYY-MM-DD" or null, "newStart": "HH:MM" or null, "newEnd": "HH:MM" or null}. ' +
    '"confirm" = clearly wants it sent; "cancel" = doesn\'t want to send anything; "change_caregiver" = wants a different candidate ' +
    '(fill pickIndex/pickName if they named one); "change_time" = wants a different day/time (fill the fields they stated); ' +
    '"skip_visit" = wants to skip/cancel the visit itself with no replacement; "other" = a question or something else.',
    text,
  );
  const parsed = parseJsonLoose(raw, "handleRpConfirm");
  switch (parsed?.action) {
    case "confirm":
      return commitReplacement(phone, chatId, session, data);
    case "cancel":
      return handleReplacementBackOut(phone, chatId, session);
    case "skip_visit":
      return goToSkipConfirm(phone, chatId);
    case "change_caregiver": {
      const chosen = resolveCandidate(data, parsed.pickIndex, parsed.pickName);
      if (chosen) {
        await mergeFlowData(phone, { caregiverId: chosen.id, caregiverName: chosen.name, caregiverRate: chosen.rate });
        return goToRecap(phone, chatId);
      }
      await updateStep(phone, "rp_pick");
      await sendMessage(chatId, `Sure — who would you like instead?\n\n${candidateList(data)}\n\nReply with a name or number.`);
      return;
    }
    case "change_time": {
      if (validTime(parsed.newStart) && validTime(parsed.newEnd) && bookingTimeToMinutes(parsed.newEnd)! > bookingTimeToMinutes(parsed.newStart)!) {
        const patch: Partial<ReplacementFlowData> = { newStart: parsed.newStart, newEnd: parsed.newEnd };
        if (typeof parsed.newDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.newDate)) patch.newDate = parsed.newDate;
        await mergeFlowData(phone, patch);
        return goToRecap(phone, chatId);
      }
      await updateStep(phone, "rp_ask_time");
      await sendMessage(chatId, TIME_QUESTION(data));
      return;
    }
    default:
      await sendMessage(chatId, await answerQuestionMidFlow(text));
      await sendMessage(chatId, recap);
  }
}

// ── Step: the site's Skip button — YES cancels the visit in place ─────────────

async function goToSkipConfirm(phone: string, chatId: string): Promise<void> {
  await updateStep(phone, "rp_skip_confirm");
  await sendMessage(chatId, SKIP_QUESTION(await getFlowData(phone)));
}

async function handleRpSkipConfirm(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = SKIP_QUESTION(data);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");

  if (TRIVIAL_CONFIRM_WORDS.has(bare)) return commitSkip(phone, chatId, session, data);
  if (BARE_NO.has(bare)) return declineSkip(phone, chatId, session, data);

  if (await isBackOutRequest(text, question)) return declineSkip(phone, chatId, session, data);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }
  const raw = await parseWithClaude(
    `Evia asked: "${question}"\n\nDoes the family want the visit skipped (cancelled, no replacement)? Reply YES if they clearly do, NO if they clearly don't, or UNCLEAR.`,
    text,
  );
  const verdict = raw.toUpperCase();
  if (verdict.startsWith("YES")) return commitSkip(phone, chatId, session, data);
  if (verdict.startsWith("NO")) return declineSkip(phone, chatId, session, data);
  await sendMessage(chatId, `${RP_DIDNT_CATCH} ${question}`);
}

// NO to skipping: back to the candidates if there are any, otherwise the
// visit simply stays Needs Replacement (what the site shows too).
async function declineSkip(phone: string, chatId: string, _session: AgentSession, data: ReplacementFlowData): Promise<void> {
  if (data.candidates.length > 0) {
    await updateStep(phone, "rp_pick");
    await sendMessage(chatId, `Okay — the visit stays as Needs Replacement. ${PICK_QUESTION(data)}`);
    return;
  }
  await clearFlow(phone);
  await sendMessage(chatId, "Okay — I'll leave it as Needs Replacement and let you know if someone opens up. You can also use Find Replacement or Skip on your My Bookings page anytime.");
}

async function commitSkip(phone: string, chatId: string, session: AgentSession, data: ReplacementFlowData): Promise<void> {
  const clientId = session.userId as string;
  // Fresh load inside: the visit may have been covered or skipped on the site since.
  const result = await skipReplacementShift(clientId, data.shiftId);
  await clearFlow(phone);
  if (!result.ok) {
    await sendMessage(chatId, "That visit isn't waiting on a replacement anymore, so I didn't change anything — it's up to date on your My Bookings page.");
    return;
  }
  logAudit({
    eventType: "shift_cancelled", userId: clientId,
    data: { source: "replacementFlow:skip", shiftId: data.shiftId },
  }).catch(() => {});
  await sendMessage(chatId,
    `Done — I skipped the ${describeVisitWindow({ date: result.date, startTime: result.startTime, endTime: result.endTime })} visit. ` +
    `It's cancelled with no replacement, and the rest of your booking is unchanged. You'll see it updated on your My Bookings page.`);
}

async function commitReplacement(phone: string, chatId: string, session: AgentSession, data: ReplacementFlowData): Promise<void> {
  const clientId = session.userId as string;
  if (!data.caregiverId || !data.caregiverName) {
    await updateStep(phone, "rp_pick");
    await sendMessage(chatId, PICK_QUESTION(data));
    return;
  }
  // Fresh load: the visit may have been skipped or covered since the recap.
  const loaded = await loadReplacementShift(clientId, data.shiftId);
  if (!loaded.ok) {
    await clearFlow(phone);
    await sendMessage(chatId, "That visit isn't waiting on a replacement anymore, so I didn't send anything — it's up to date on your My Bookings page.");
    return;
  }
  const created = await createReplacementRequest({
    clientId, shiftId: data.shiftId, shift: loaded.shift, shiftRef: loaded.ref,
    backupCaregiverId: data.caregiverId,
    ...(data.newDate ? { date: data.newDate } : {}),
    ...(data.newStart ? { startTime: data.newStart } : {}),
    ...(data.newEnd ? { endTime: data.newEnd } : {}),
    nowIso: new Date().toISOString(),
  });
  if (!created.ok) {
    await clearFlow(phone);
    await sendMessage(chatId, `I couldn't reach ${data.caregiverName}'s profile to send that, so nothing was sent. You can pick someone else from the app's Find Replacement button, or ask me again.`);
    return;
  }
  logAudit({
    eventType: "callout_backup_selected", userId: clientId,
    data: { source: "replacementFlow", shiftId: data.shiftId, backupCaregiverId: data.caregiverId, bookingRequestId: created.bookingRequestId },
  }).catch(() => {});
  await clearFlow(phone);
  // Honest wording: the candidate still has to accept — the visit stays
  // "Needs Replacement" until they do, exactly as on the site.
  await sendMessage(chatId,
    `Sent — I asked ${created.caregiverName} to cover ${describeVisitWindow({ date: created.date, startTime: created.startTime, endTime: created.endTime })}. ` +
    `Nothing changes until they accept; I'll text you as soon as they respond. It's on your My Bookings page too.`);
}
