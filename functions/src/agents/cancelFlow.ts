// Scripted cancel flow — the website's cancel buttons on My Bookings, walked
// over SMS: what can be cancelled right now (per-visit ✕ / Skip, Cancel
// Booking, Cancel Request on a pending booking or schedule change, the
// replacement request's Cancel) read fresh → which one → the site's own
// confirm-dialog wording → YES → the identical write (agents/bookingCancel.ts,
// shared with manage_booking).
//
// Built 2026-09-17, replacing the legacy CANCEL_REQUEST path (retired
// `appointments` lookup + a pendingCancelConfirm flag consumed by YES/NO
// router branches). Same pattern as rescheduleFlow.ts: dispatched BEFORE
// intent classification, back-out check first, isQuestionOrOther guard,
// deterministic bare number / yes / no before any model call, nothing
// written before YES, fresh re-check at commit.
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS, bareNumberPick } from "./stepHandler";
import { listCancellables, applyCancel, type CancelOption } from "./bookingCancel";

const db = admin.firestore();

export interface CancelFlowData {
  options: CancelOption[];
  pickIndex?: number; // 0-based into options
}

const CX_DIDNT_CATCH = "Sorry, I didn't quite catch that.";
const BARE_NO = new Set(["NO", "N", "NOPE", "NAH"]);

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const response = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:     prompt + "\nReply with ONLY the requested value or format — no explanation, no extra text, no questions. Never invent information the user's message doesn't contain.",
      messages:   [{ role: "user", content: userText }],
    });
    const parsed = ((response.content[0] as { text: string }).text ?? "").trim();
    if (parsed && caraOutputGuardEnabled() && !guardModelOutput(parsed).ok) return "__parse_error__";
    return parsed;
  } catch (err) {
    console.error("[cancelFlow] parseWithClaude: Anthropic call threw", err);
    return "__parse_error__";
  }
}

function parseJsonLoose(raw: string, where: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch {
    console.warn(`[cancelFlow] ${where}: JSON.parse failed on model output`, { raw: raw.slice(0, 300) });
    return null;
  }
}

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The question Evia just asked the family was: "${currentQuestion}"\n\n` +
    "Reply NO if the family's message is ANY attempt — even a single word, a bare number, or a short/partial one — to address that question. " +
    "Reply YES only if the message is a genuine question, or a comment that does not attempt to address what was asked at all. Only reply YES or NO.",
    text,
  );
  return result.toUpperCase().startsWith("Y");
}

async function answerQuestionMidFlow(text: string): Promise<string> {
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a family cancel a care visit, booking, or request. You see ONLY this one " +
      "message. NEVER claim something was or wasn't mentioned before, and NEVER state whether anything has been cancelled — " +
      "you cannot see the schedule. If the message is about something else, say plainly it'll have to wait until this is " +
      "finished. Otherwise answer briefly (1–2 sentences). Be warm. NEVER write out a URL. " + ANTI_INVENTION_CLAUSE,
    messages: [{ role: "user", content: text }],
  });
  const answer = ((response.content[0] as { text: string }).text ?? "").trim();
  if (answer && caraOutputGuardEnabled() && !guardModelOutput(answer).ok) return "Good question — I don't want to guess on that one.";
  return answer;
}

async function getFlowData(phone: string): Promise<CancelFlowData> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return (snap.data()?.cancelFlowData ?? { options: [] }) as CancelFlowData;
}
async function mergeFlowData(phone: string, data: Partial<CancelFlowData>): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const existing = (snap.data()?.cancelFlowData ?? { options: [] }) as CancelFlowData;
  await db.collection("agent_sessions").doc(phone).update({ cancelFlowData: { ...existing, ...data } });
}
async function updateStep(phone: string, step: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ cancelFlowStep: step });
}
async function clearFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    cancelFlowStep: admin.firestore.FieldValue.delete(),
    cancelFlowData: admin.firestore.FieldValue.delete(),
    stateExpiresAt: admin.firestore.FieldValue.delete(),
  });
}
async function handleBackOut(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await clearFlow(phone);
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: "The family decided not to cancel anything after all. Warmly confirm nothing was changed and everything stays as scheduled.",
    fallback: "No problem — nothing was cancelled. Everything stays as scheduled.",
    maxTokens: 70,
  }));
}

function PICK_QUESTION(d: CancelFlowData): string {
  return `Here's what you can cancel right now:\n\n${d.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}\n\nWhich one? Reply with a number.`;
}
function CONFIRM_QUESTION(o: CancelOption): string {
  return `${o.confirmText}\n\nReply YES to cancel it, or NO to keep it.`;
}

async function resolveByText(text: string, d: CancelFlowData): Promise<number | null> {
  const raw = await parseWithClaude(
    `Things the family could cancel, numbered:\n${d.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}\n\n` +
    'If the family\'s message clearly refers to exactly ONE of these, return ONLY a JSON object {"pickIndex": that 1-based number}. ' +
    'If it could mean more than one, or none, return {"pickIndex": null}. Never guess.',
    text,
  );
  const parsed = parseJsonLoose(raw, "resolveByText");
  const n = parsed?.pickIndex;
  return typeof n === "number" && n >= 1 && n <= d.options.length ? n - 1 : null;
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export async function startCancelFlow(
  phone: string, chatId: string, session: AgentSession, args: { initialText?: string } = {},
): Promise<{ started: boolean; reason?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to look up your bookings. Please try again.");
    return { started: false, reason: "no_client_id" };
  }
  const options = await listCancellables(clientId);
  if (options.length === 0) {
    await sendMessage(chatId,
      "I don't see anything on your My Bookings page that can be cancelled right now — no upcoming visits, active bookings, or pending requests. " +
      "If you meant an interview, tell me which one and I'll take care of that.");
    return { started: false, reason: "nothing_to_cancel" };
  }
  const data: CancelFlowData = { options };
  await db.collection("agent_sessions").doc(phone).update({
    cancelFlowStep: "cx_pick",
    cancelFlowData: data,
    stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  // The family's own words may already say which one ("cancel Thursday's visit").
  let idx: number | null = null;
  if (args.initialText?.trim() && options.length > 1) idx = await resolveByText(args.initialText, data);
  if (options.length === 1) idx = 0;
  if (idx === null) {
    await sendMessage(chatId, PICK_QUESTION(data));
    return { started: true };
  }
  await mergeFlowData(phone, { pickIndex: idx });
  await updateStep(phone, "cx_confirm");
  await sendMessage(chatId, CONFIRM_QUESTION(options[idx]));
  return { started: true };
}

// ── Steps ─────────────────────────────────────────────────────────────────────

export async function handleCancelFlowStep(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const step = ((session as any).cancelFlowStep as string) ?? "";
  switch (step) {
    case "cx_pick":    return handlePick(phone, chatId, text, session);
    case "cx_confirm": return handleConfirm(phone, chatId, text, session);
    default: {
      const data = await getFlowData(phone);
      await updateStep(phone, "cx_pick");
      await sendMessage(chatId, PICK_QUESTION(data));
    }
  }
}

async function handlePick(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = PICK_QUESTION(data);
  let idx: number | null = null;
  const bare = bareNumberPick(text, data.options.length);
  if (bare !== null) idx = bare - 1;
  else {
    if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
    if (await isQuestionOrOther(text, question)) {
      await sendMessage(chatId, await answerQuestionMidFlow(text));
      await sendMessage(chatId, question);
      return;
    }
    idx = await resolveByText(text, data);
    if (idx === null) { await sendMessage(chatId, `${CX_DIDNT_CATCH} ${question}`); return; }
  }
  await mergeFlowData(phone, { pickIndex: idx });
  await updateStep(phone, "cx_confirm");
  await sendMessage(chatId, CONFIRM_QUESTION(data.options[idx]));
}

async function handleConfirm(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const opt = data.pickIndex !== undefined ? data.options[data.pickIndex] : undefined;
  if (!opt) { await updateStep(phone, "cx_pick"); await sendMessage(chatId, PICK_QUESTION(data)); return; }
  const question = CONFIRM_QUESTION(opt);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  if (TRIVIAL_CONFIRM_WORDS.has(bare)) return commit(phone, chatId, session, opt);
  if (BARE_NO.has(bare)) return handleBackOut(phone, chatId, session);
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  const raw = await parseWithClaude(
    `Evia asked: "${question}"\nOther things they could cancel instead, numbered:\n${data.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}\n\n` +
    'Classify the reply. Return ONLY a JSON object: {"action": "confirm" | "keep" | "change" | "other", "pickIndex": 1-based number or null}. ' +
    '"confirm" = clearly wants it cancelled; "keep" = doesn\'t want to cancel; "change" = wants to cancel a DIFFERENT item (fill pickIndex if clear); "other" = a question.',
    text,
  );
  const parsed = parseJsonLoose(raw, "handleConfirm");
  switch (parsed?.action) {
    case "confirm": return commit(phone, chatId, session, opt);
    case "keep":    return handleBackOut(phone, chatId, session);
    case "change": {
      const n = parsed.pickIndex;
      if (typeof n === "number" && n >= 1 && n <= data.options.length) {
        await mergeFlowData(phone, { pickIndex: n - 1 });
        await sendMessage(chatId, CONFIRM_QUESTION(data.options[n - 1]));
        return;
      }
      await updateStep(phone, "cx_pick");
      await sendMessage(chatId, PICK_QUESTION(data));
      return;
    }
    default:
      await sendMessage(chatId, await answerQuestionMidFlow(text));
      await sendMessage(chatId, question);
  }
}

async function commit(phone: string, chatId: string, session: AgentSession, opt: CancelOption): Promise<void> {
  const clientId = session.userId as string;
  // applyCancel re-reads the record: a visit/request that changed on the site
  // since the question was asked is refused, not overwritten.
  const result = await applyCancel(clientId, opt, "cancelFlow");
  await clearFlow(phone);
  if (!result.ok) {
    await sendMessage(chatId, "That one isn't in a state I can cancel anymore (it may have changed on the site since), so I didn't touch it — it's up to date on your My Bookings page.");
    return;
  }
  const done: Record<string, string> = {
    visit:               `Done — the ${result.detail} visit is cancelled. The rest of your booking is unchanged, and ${opt.caregiverName} has been notified.`,
    booking:             `Done — the whole booking with ${result.detail} is cancelled, including every upcoming visit. ${result.detail} has been notified.`,
    pending_request:     `Done — the booking request to ${result.detail} is withdrawn. They've been told.`,
    replacement_request: `Done — the replacement request to ${result.detail} is cancelled. The visit still shows Needs Replacement, so you can pick someone else anytime.`,
    amendment:           `Done — the schedule-change request to ${result.detail} is cancelled. Nothing was added to the calendar.`,
  };
  await sendMessage(chatId, `${done[result.kind]} It's updated on your My Bookings page.`);
}
