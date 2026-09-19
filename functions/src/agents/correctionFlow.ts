// Scripted timesheet-correction flow — the website's Timesheets "Review
// submitted hours" modal (components/payroll/ReviewShiftHoursModal.tsx) walked
// step for step over SMS:
//
//   which timesheet (only when more than one is waiting) → proposed start
//   (KEEP = as submitted) → proposed end (KEEP) → optional reason → recap
//   with the proposed total and pay, exactly the modal's numbers → YES → the
//   SAME server write the modal's "Send correction" makes
//   (billing/reviewShiftHours.ts reviewShiftHoursAs, propose_correction).
//
//   When the caregiver has already sent a counter, the modal opens in counter
//   mode with only two buttons — "Accept counter" / "Escalate to admin" — and
//   so does this flow (ACCEPT / ESCALATE). There is no second proposal from
//   the family and no second counter from the caregiver; the site has neither.
//
// Built 2026-09-18 after two live misfires of the free-form version (a
// clock-in correction was first staged as a MEMORY fact, then collected but
// never sent). Same pattern as visitRequestFlow.ts: session-state step machine
// dispatched BEFORE intent classification, back-out check first on every step,
// isQuestionOrOther guard, deterministic KEEP / yes / no before any model call,
// one recap + explicit YES gate. Nothing is written until that YES.
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS, bareNumberPick } from "./stepHandler";
import { DEFAULT_TZ, parseScheduledTimeMs, formatClockTime, formatDateWithWeekday, businessTodayStr } from "../utils/scheduledTime";
import { shapeTimesheetRow, fmtDuration } from "./timesheetsPage";
import { resolveShiftBillableAmount } from "../billing/shiftBillingAmounts";

const db = admin.firestore();

// ── Session data shape ───────────────────────────────────────────────────────

export interface CorrectionRow {
  id: string;                 // shiftHours doc id (= appointmentId for the review write)
  appointmentId: string;
  caregiverName: string;
  date: string | null;        // YYYY-MM-DD in the business timezone
  clockIn: string;            // ISO, as submitted (final times win for corrected rows)
  clockOut: string;           // ISO
  payRate: number;
  lineItems: Array<{ type?: string; label?: string; note?: string; amount?: number }>;
  grossPay: number;
  status: "pending_client_review" | "caregiver_counter_proposed";
  // Counter mode only.
  counter?: { start: string; end: string; note: string | null };
  proposed?: { start: string; end: string };
}

export interface CorrectionFlowData {
  rows: CorrectionRow[];
  rowId?: string;
  proposedStart?: string;     // ISO
  proposedEnd?: string;       // ISO
  reason?: string;
}

const CF_DIDNT_CATCH = "Sorry, I didn't quite catch that.";
const BARE_NO = new Set(["NO", "N", "NOPE", "NAH", "NONE", "SKIP"]);
// The question says "reply KEEP" — a stated one-word protocol, like YES/NO.
const BARE_KEEP = new Set(["KEEP", "SAME", "UNCHANGED", "LEAVE IT", "KEEP IT"]);

// ── Model plumbing (same shape as visitRequestFlow.ts so tests drive it identically) ─

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
      console.warn("[correctionFlow] parseWithClaude: output guard rejected model response", { rawLength: parsed.length });
      return "__parse_error__";
    }
    return parsed;
  } catch (err) {
    console.error("[correctionFlow] parseWithClaude: Anthropic call threw", err);
    return "__parse_error__";
  }
}

function parseJsonLoose(raw: string, where: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch {
    console.warn(`[correctionFlow] ${where}: JSON.parse failed on model output`, { raw: raw.slice(0, 300) });
    return null;
  }
}

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The question Evia just asked the family was: "${currentQuestion}"\n\n` +
    "Reply NO if the family's message is ANY attempt — even a single word, a bare number, a time, or a short/partial/vague one — " +
    "to address that specific question. A vague or incomplete attempt still counts as a direct answer. " +
    "Reply YES only if the message is a genuine question, or a comment that does not attempt to address what was asked at all. " +
    "Only reply YES or NO.",
    text,
  );
  return result.toUpperCase().startsWith("Y");
}

const CF_MIDFLOW_FALLBACK = "Good question — I don't want to guess on that one.";

async function answerQuestionMidFlow(text: string): Promise<string> {
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a family correct the clock-in/clock-out times on a caregiver's submitted " +
      "timesheet before it is paid. You see ONLY this one message, not the rest of the conversation — including anything " +
      "Evia herself said earlier. NEVER claim something was or wasn't mentioned before; you cannot know that. NEVER state " +
      "what the caregiver will decide — they may accept or counter. If the message is clearly about something OTHER than " +
      "finishing this correction, say plainly that it'll have to wait, e.g. \"That sounds like something else — let's " +
      "finish this first, and I'll help with that right after.\" Otherwise answer briefly (1–2 sentences). Be warm. NEVER " +
      "write out a URL. " + ANTI_INVENTION_CLAUSE,
    messages: [{ role: "user", content: text }],
  });
  const answer = ((response.content[0] as { text: string }).text ?? "").trim();
  if (answer && caraOutputGuardEnabled() && !guardModelOutput(answer).ok) return CF_MIDFLOW_FALLBACK;
  return answer;
}

// ── Session helpers ──────────────────────────────────────────────────────────

async function getFlowData(phone: string): Promise<CorrectionFlowData> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return (snap.data()?.correctionFlowData ?? { rows: [] }) as CorrectionFlowData;
}
async function mergeFlowData(phone: string, data: Partial<CorrectionFlowData>): Promise<void> {
  const existing = await getFlowData(phone);
  await db.collection("agent_sessions").doc(phone).update({ correctionFlowData: { ...existing, ...data } });
}
async function updateStep(phone: string, step: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ correctionFlowStep: step });
}
async function clearFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    correctionFlowStep: admin.firestore.FieldValue.delete(),
    correctionFlowData: admin.firestore.FieldValue.delete(),
    stateExpiresAt:     admin.firestore.FieldValue.delete(),
  });
}
async function handleBackOut(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await clearFlow(phone);
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: "The family decided not to send the timesheet correction after all. Warmly confirm nothing was sent and the timesheet is still waiting for their review as submitted.",
    fallback: "No problem — I haven't sent anything. The timesheet is still waiting for your review as submitted.",
    maxTokens: 80,
  }));
}

// ── Loading the page's Needs Review rows ─────────────────────────────────────

const first = (name: unknown, fallback = "your caregiver") => { const s = String(name ?? "").trim(); return s ? s.split(/\s+/)[0] : fallback; };
const clock = (iso: string) => formatClockTime(Date.parse(iso));
const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
const money = (n: number) => `$${n.toFixed(2)}`;

export async function listCorrectionRows(clientId: string): Promise<CorrectionRow[]> {
  const statuses = ["pending_client_review", "caregiver_counter_proposed"] as const;
  const snaps = await Promise.all(statuses.map((st) =>
    db.collection("shiftHours").where("clientId", "==", clientId).where("status", "==", st).get()));
  const rows: CorrectionRow[] = [];
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const raw = doc.data() as Record<string, unknown>;
      const row = shapeTimesheetRow(doc.id, raw);
      if (!row.clockIn || !row.clockOut) continue;
      const status = raw.status as CorrectionRow["status"];
      rows.push({
        id: doc.id,
        appointmentId: row.appointmentId ?? doc.id,
        caregiverName: row.caregiverName,
        date: row.date,
        clockIn: row.clockIn,
        clockOut: row.clockOut,
        payRate: row.payRate,
        lineItems: row.lineItems,
        grossPay: row.grossPay,
        status,
        ...(status === "caregiver_counter_proposed" && raw.counterStartTime && raw.counterEndTime
          ? { counter: { start: String(raw.counterStartTime), end: String(raw.counterEndTime), note: raw.counterNote ? String(raw.counterNote) : null } }
          : {}),
        ...(raw.proposedStartTime && raw.proposedEndTime
          ? { proposed: { start: String(raw.proposedStartTime), end: String(raw.proposedEndTime) } }
          : {}),
      });
    }
  }
  rows.sort((a, b) => Date.parse(b.clockIn) - Date.parse(a.clockIn));
  return rows;
}

// ── Copy ─────────────────────────────────────────────────────────────────────

function chosen(d: CorrectionFlowData): CorrectionRow | undefined {
  return d.rows.find((r) => r.id === d.rowId);
}
function describeRow(r: CorrectionRow): string {
  const when = r.date ? `${formatDateWithWeekday(r.date)}, ` : "";
  return `${r.caregiverName} — ${when}${clock(r.clockIn)}–${clock(r.clockOut)} (${fmtDuration(hoursBetween(r.clockIn, r.clockOut))})${r.status === "caregiver_counter_proposed" ? " · counter received" : ""}`;
}
function PICK_QUESTION(d: CorrectionFlowData): string {
  return `Which timesheet?\n\n${d.rows.map((r, i) => `${i + 1}. ${describeRow(r)}`).join("\n")}\n\nReply with a number.`;
}
function START_QUESTION(r: CorrectionRow): string {
  return `${first(r.caregiverName)} submitted ${clock(r.clockIn)}–${clock(r.clockOut)}${r.date ? ` on ${formatDateWithWeekday(r.date)}` : ""}. What should the clock-in be? (e.g. "10:05 PM" — or reply KEEP to leave it at ${clock(r.clockIn)})`;
}
function END_QUESTION(r: CorrectionRow): string {
  return `And the clock-out? (submitted ${clock(r.clockOut)} — reply KEEP to leave it)`;
}
const REASON_QUESTION = "Why the correction? This goes to the caregiver with your proposal — optional, reply NO to skip.";

export function buildCorrectionRecap(d: CorrectionFlowData): string {
  const r = chosen(d);
  if (!r || !d.proposedStart || !d.proposedEnd) return CF_DIDNT_CATCH;
  const submitted = resolveShiftBillableAmount({ startTime: r.clockIn, endTime: r.clockOut, bookedRateDollars: r.payRate, lineItems: r.lineItems });
  const proposed = resolveShiftBillableAmount({ startTime: d.proposedStart, endTime: d.proposedEnd, bookedRateDollars: r.payRate, lineItems: r.lineItems });
  const charges = proposed.lineItemsTotal > 0 ? ` · charges ${money(proposed.lineItemsTotal)} kept` : "";
  return [
    `Here's your correction for ${first(r.caregiverName)}'s ${r.date ? formatDateWithWeekday(r.date) : ""} timesheet:`.replace("  ", " "),
    "",
    `Submitted: ${clock(r.clockIn)}–${clock(r.clockOut)} (${fmtDuration(submitted.totalHours)}) · ${money(submitted.grossPay)}`,
    `Proposed: ${clock(d.proposedStart)}–${clock(d.proposedEnd)} (${fmtDuration(proposed.totalHours)}) · base pay ${money(proposed.basePay)} at $${r.payRate}/hr${charges} · total ${money(proposed.grossPay)}`,
    `Reason: ${d.reason ? `"${d.reason}"` : "None"}`,
    "",
    `${first(r.caregiverName)} has 24 hours to accept or send a counter; if they don't respond, your proposal is auto-accepted. Reply YES to send it, NO to cancel, or tell me what to change.`,
  ].join("\n");
}

export function buildCounterText(r: CorrectionRow): string {
  const c = r.counter!;
  const amount = resolveShiftBillableAmount({ startTime: c.start, endTime: c.end, bookedRateDollars: r.payRate, lineItems: r.lineItems });
  const yours = r.proposed ? ` You proposed ${clock(r.proposed.start)}–${clock(r.proposed.end)}.` : "";
  return `${first(r.caregiverName)} sent a counter on the ${r.date ? formatDateWithWeekday(r.date) : ""} timesheet: ${clock(c.start)}–${clock(c.end)} (${fmtDuration(amount.totalHours)}) · ${money(amount.grossPay)}.${c.note ? ` Their note: "${c.note}"` : ""}${yours}\n\nReply ACCEPT to accept their counter (payment goes through at that amount), or ESCALATE to send it to our team to resolve.`.replace("  ", " ");
}

// ── Times: the family's words → an ISO instant on the visit's date ───────────

// The model is asked for 24-hour HH:MM anchored on the submitted time, but a
// bare "10:05" for a 10:03 PM visit still came back as 10:05 (live, 2026-09-18:
// the correction was stored as 10:05 AM). So the 12-hour ambiguity is settled
// here, deterministically: of the two readings (h and h+12) take the one
// nearest the submitted time. Pure arithmetic — no intent parsing.
export function hhmmToIsoNearAnchor(hh: number, mm: number, anchorIso: string): string | null {
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  const anchorMs = Date.parse(anchorIso);
  if (!Number.isFinite(anchorMs)) return null;
  const dateStr = businessTodayStr(DEFAULT_TZ, new Date(anchorMs));
  const candidates = [hh, (hh + 12) % 24]
    .map((h) => parseScheduledTimeMs(`${dateStr}T${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`, DEFAULT_TZ))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => Math.abs(a - anchorMs) - Math.abs(b - anchorMs));
  return candidates.length ? new Date(candidates[0]).toISOString() : null;
}

// "10:05", "10:05 pm", "five past ten" → HH:MM (24h) anchored on the submitted
// time so a bare "10:05" for a 10:03 PM visit means 22:05, not 10:05 AM.
async function parseClockTime(text: string, anchorIso: string, which: "clock-in" | "clock-out"): Promise<{ kind: "time"; iso: string } | { kind: "keep" } | { kind: "none" }> {
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  if (BARE_KEEP.has(bare)) return { kind: "keep" };
  const anchorMs = Date.parse(anchorIso);
  const raw = await parseWithClaude(
    `The family is giving a corrected ${which} time for a caregiver visit. The caregiver submitted ${formatClockTime(anchorMs)} on ${formatDateWithWeekday(businessTodayStr(DEFAULT_TZ, new Date(anchorMs)))}. ` +
    'Return ONLY a JSON object: {"time": "HH:MM"} in 24-hour time. If the family gives a time without AM/PM, choose the reading closest to the submitted time. ' +
    'If they say to keep/leave the submitted time, return {"keep": true}. If the message is not a time at all (a question, a comment, something else), return {"time": null}.',
    text,
  );
  const parsed = parseJsonLoose(raw, `parseClockTime:${which}`);
  if (parsed?.keep === true) return { kind: "keep" };
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(parsed?.time ?? ""));
  if (!m) return { kind: "none" };
  const iso = hhmmToIsoNearAnchor(Number(m[1]), Number(m[2]), anchorIso);
  return iso ? { kind: "time", iso } : { kind: "none" };
}

// ── Entry ────────────────────────────────────────────────────────────────────

export async function startCorrectionFlow(
  phone: string, chatId: string, session: AgentSession, args: { appointmentId?: string; initialText?: string } = {},
): Promise<{ started: boolean; reason?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to look up your timesheets. Please try again.");
    return { started: false, reason: "no_client_id" };
  }
  const rows = await listCorrectionRows(clientId);
  if (rows.length === 0) {
    await sendMessage(chatId, "There's nothing waiting for your review on the Timesheets page right now — once a caregiver submits hours, I'll text you and you can correct them here.");
    return { started: false, reason: "nothing_to_review" };
  }
  const data: CorrectionFlowData = { rows };
  await db.collection("agent_sessions").doc(phone).update({
    correctionFlowStep: "cf_pick",
    correctionFlowData: data,
    stateExpiresAt:     new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  let row = args.appointmentId ? rows.find((r) => r.id === args.appointmentId || r.appointmentId === args.appointmentId) : undefined;
  if (!row && rows.length === 1) row = rows[0];
  if (!row) {
    await sendMessage(chatId, PICK_QUESTION(data));
    return { started: true };
  }
  await selectRow(phone, chatId, row, args.initialText);
  return { started: true };
}

async function selectRow(phone: string, chatId: string, r: CorrectionRow, initialText?: string): Promise<void> {
  await mergeFlowData(phone, { rowId: r.id });
  if (r.status === "caregiver_counter_proposed" && r.counter) {
    await updateStep(phone, "cf_respond_counter");
    await sendMessage(chatId, buildCounterText(r));
    return;
  }
  // The family's own words may already carry the corrected time(s).
  if (initialText?.trim()) {
    const raw = await parseWithClaude(
      `The family wants to correct a caregiver's submitted timesheet (submitted ${clock(r.clockIn)}–${clock(r.clockOut)}). ` +
      'If their message states a corrected clock-in and/or clock-out time, return ONLY {"start": "HH:MM" | null, "end": "HH:MM" | null} in 24-hour time, choosing the reading closest to the submitted times when AM/PM is missing. ' +
      'If it states no actual time (e.g. "can you change the clock in time"), return {"start": null, "end": null}.',
      initialText,
    );
    const parsed = parseJsonLoose(raw, "selectRow:initialText");
    const toIso = (hhmm: unknown, anchor: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""));
      if (!m) return undefined;
      return hhmmToIsoNearAnchor(Number(m[1]), Number(m[2]), anchor) ?? undefined;
    };
    const start = toIso(parsed?.start, r.clockIn);
    const end = toIso(parsed?.end, r.clockOut);
    if (start) await mergeFlowData(phone, { proposedStart: start });
    if (start && end && Date.parse(end) > Date.parse(start)) {
      await mergeFlowData(phone, { proposedEnd: end });
      await updateStep(phone, "cf_ask_reason");
      await sendMessage(chatId, `Got it — ${clock(start)} to ${clock(end)}. ${REASON_QUESTION}`);
      return;
    }
    if (start) {
      await updateStep(phone, "cf_ask_end");
      await sendMessage(chatId, `Clock-in ${clock(start)}, got it. ${END_QUESTION(r)}`);
      return;
    }
  }
  await updateStep(phone, "cf_ask_start");
  await sendMessage(chatId, START_QUESTION(r));
}

// ── Step dispatch ────────────────────────────────────────────────────────────

export async function handleCorrectionFlowStep(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const step = ((session as any).correctionFlowStep as string) ?? "";
  switch (step) {
    case "cf_pick":            return handlePick(phone, chatId, text, session);
    case "cf_ask_start":       return handleAskStart(phone, chatId, text, session);
    case "cf_ask_end":         return handleAskEnd(phone, chatId, text, session);
    case "cf_ask_reason":      return handleAskReason(phone, chatId, text, session);
    case "cf_confirm":         return handleConfirm(phone, chatId, text, session);
    case "cf_respond_counter": return handleRespondCounter(phone, chatId, text, session);
    default: {
      console.warn("[correctionFlow] unknown step, clearing", { phone, step });
      await clearFlow(phone);
      await sendMessage(chatId, "Let's start that over — which timesheet did you want to correct?");
    }
  }
}

async function handlePick(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = PICK_QUESTION(data);
  const n = bareNumberPick(text, data.rows.length);
  if (n) return selectRow(phone, chatId, data.rows[n - 1]);
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }
  const raw = await parseWithClaude(
    `Timesheets, numbered:\n${data.rows.map((r, i) => `${i + 1}. ${describeRow(r)}`).join("\n")}\n\nIf the family's message clearly picks one (by number, caregiver name, or date), return ONLY that number. Otherwise return 0.`,
    text,
  );
  const k = parseInt(raw.trim(), 10);
  if (k >= 1 && k <= data.rows.length) return selectRow(phone, chatId, data.rows[k - 1]);
  await sendMessage(chatId, `${CF_DIDNT_CATCH} ${question}`);
}

async function handleAskStart(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const r = chosen(data);
  if (!r) return handleCorrectionFlowStep(phone, chatId, text, { ...session, correctionFlowStep: "cf_pick" } as any);
  const question = START_QUESTION(r);
  const t = await parseClockTime(text, r.clockIn, "clock-in");
  if (t.kind === "keep") { await mergeFlowData(phone, { proposedStart: r.clockIn }); return askEnd(phone, chatId, r, `Keeping ${clock(r.clockIn)}.`); }
  if (t.kind === "time") { await mergeFlowData(phone, { proposedStart: t.iso }); return askEnd(phone, chatId, r, `Clock-in ${clock(t.iso)}, got it.`); }
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }
  await sendMessage(chatId, `${CF_DIDNT_CATCH} ${question}`);
}

async function askEnd(phone: string, chatId: string, r: CorrectionRow, lead: string): Promise<void> {
  await updateStep(phone, "cf_ask_end");
  await sendMessage(chatId, `${lead} ${END_QUESTION(r)}`);
}

async function handleAskEnd(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const r = chosen(data);
  if (!r || !data.proposedStart) { await updateStep(phone, "cf_ask_start"); if (r) await sendMessage(chatId, START_QUESTION(r)); return; }
  const question = END_QUESTION(r);
  const t = await parseClockTime(text, r.clockOut, "clock-out");
  const end = t.kind === "keep" ? r.clockOut : t.kind === "time" ? t.iso : null;
  if (end) {
    // The modal refuses "End must be after start." — same rule here.
    if (Date.parse(end) <= Date.parse(data.proposedStart)) {
      await sendMessage(chatId, `The clock-out has to be after the clock-in (${clock(data.proposedStart)}). ${question}`);
      return;
    }
    await mergeFlowData(phone, { proposedEnd: end });
    await updateStep(phone, "cf_ask_reason");
    await sendMessage(chatId, `${t.kind === "keep" ? `Keeping ${clock(end)}.` : `Clock-out ${clock(end)}, got it.`} ${REASON_QUESTION}`);
    return;
  }
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }
  await sendMessage(chatId, `${CF_DIDNT_CATCH} ${question}`);
}

async function handleAskReason(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  if (BARE_NO.has(bare)) return goToRecap(phone, chatId);
  if (await isBackOutRequest(text, REASON_QUESTION)) return handleBackOut(phone, chatId, session);
  // The modal's Reason box stores whatever the family types, verbatim. Only a
  // short, plain decline is a skip; anything with real words in it is the reason.
  const words = text.trim().split(/\s+/).length;
  if (words <= 4) {
    const verdict = await parseWithClaude(
      'The family was asked for an optional reason for a timesheet correction. Reply DECLINE only if this short message is purely declining to give one ' +
      '("no thanks", "nothing", "no reason", "skip it", "none"). Reply REASON if it contains anything that explains the correction. Only reply DECLINE or REASON.',
      text,
    );
    if (verdict.toUpperCase().startsWith("DECLINE")) return goToRecap(phone, chatId);
  }
  await mergeFlowData(phone, { reason: text.trim() });
  return goToRecap(phone, chatId);
}

async function goToRecap(phone: string, chatId: string): Promise<void> {
  await updateStep(phone, "cf_confirm");
  await sendMessage(chatId, buildCorrectionRecap(await getFlowData(phone)));
}

// ── Step: recap → YES sends the correction ───────────────────────────────────

async function handleConfirm(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const recap = buildCorrectionRecap(data);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  if (TRIVIAL_CONFIRM_WORDS.has(bare)) return commit(phone, chatId, session, data);
  if (BARE_NO.has(bare)) return handleBackOut(phone, chatId, session);
  if (await isBackOutRequest(text, recap)) return handleBackOut(phone, chatId, session);

  const raw = await parseWithClaude(
    `Evia asked: "${recap}"\n\nClassify the family's reply. Return ONLY a JSON object: ` +
    '{"action": "confirm" | "cancel" | "change_start" | "change_end" | "change_reason" | "other"}. ' +
    '"confirm" = clearly wants it sent; "cancel" = doesn\'t want to send anything; the change_* values = wants to change that part; "other" = a question or something else.',
    text,
  );
  const parsed = parseJsonLoose(raw, "handleConfirm");
  const r = chosen(data);
  switch (parsed?.action) {
    case "confirm": return commit(phone, chatId, session, data);
    case "cancel":  return handleBackOut(phone, chatId, session);
    case "change_start":
      await mergeFlowData(phone, { proposedStart: undefined, proposedEnd: undefined });
      await updateStep(phone, "cf_ask_start");
      if (r) await sendMessage(chatId, START_QUESTION(r));
      return;
    case "change_end":
      await mergeFlowData(phone, { proposedEnd: undefined });
      await updateStep(phone, "cf_ask_end");
      if (r) await sendMessage(chatId, END_QUESTION(r));
      return;
    case "change_reason":
      await updateStep(phone, "cf_ask_reason");
      await sendMessage(chatId, REASON_QUESTION);
      return;
    default:
      await sendMessage(chatId, await answerQuestionMidFlow(text));
      await sendMessage(chatId, recap);
  }
}

async function commit(phone: string, chatId: string, session: AgentSession, data: CorrectionFlowData): Promise<void> {
  const clientId = session.userId as string;
  const r = chosen(data);
  if (!r || !data.proposedStart || !data.proposedEnd) {
    await updateStep(phone, "cf_ask_start");
    if (r) await sendMessage(chatId, START_QUESTION(r));
    return;
  }
  // The modal's "Send correction": the same server function the website's
  // callable runs, with its own status guards (the caregiver may have moved
  // first since the recap — the guard's message is passed straight through).
  const { reviewShiftHoursAs } = await import("../billing/reviewShiftHours");
  try {
    await reviewShiftHoursAs(clientId, {
      appointmentId: r.appointmentId, action: "propose_correction",
      proposedStartTime: data.proposedStart, proposedEndTime: data.proposedEnd,
      proposalReason: data.reason || undefined,
    });
  } catch (err) {
    await clearFlow(phone);
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `I couldn't send that correction — ${msg}. Check the Timesheets page for where this one stands.`);
    return;
  }
  await clearFlow(phone);
  const proposed = resolveShiftBillableAmount({ startTime: data.proposedStart, endTime: data.proposedEnd, bookedRateDollars: r.payRate, lineItems: r.lineItems });
  await sendMessage(chatId,
    `Sent — I proposed ${clock(data.proposedStart)}–${clock(data.proposedEnd)} (${fmtDuration(proposed.totalHours)}, ${money(proposed.grossPay)}) to ${first(r.caregiverName)}. ` +
    `They have 24 hours to accept or send a counter; if they don't respond, it's auto-accepted. I'll text you as soon as they answer. It shows as "Correction Sent" on your Timesheets page too.`);
}

// ── Counter mode: ACCEPT / ESCALATE, the modal's only two buttons ───────────

async function handleRespondCounter(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const r = chosen(data);
  if (!r || !r.counter) { await clearFlow(phone); await sendMessage(chatId, "That counter isn't waiting on you any more — check the Timesheets page for where it stands."); return; }
  const question = buildCounterText(r);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  let action: "accept_counter" | "escalate" | null = bare === "ACCEPT" ? "accept_counter" : bare === "ESCALATE" ? "escalate" : null;
  if (!action) {
    if (await isBackOutRequest(text, question)) {
      await clearFlow(phone);
      await sendMessage(chatId, "No problem — nothing changed. The counter is still waiting for you on the Timesheets page.");
      return;
    }
    const raw = await parseWithClaude(
      `Evia asked: "${question}"\n\nClassify the family's reply. Return ONLY a JSON object: {"action": "accept" | "escalate" | "other"}. ` +
      '"accept" = clearly accepts the caregiver\'s counter; "escalate" = wants Evia\'s team to look at it / disputes it; "other" = a question or anything else (including a new time of their own — the site offers no second proposal).',
      text,
    );
    const parsed = parseJsonLoose(raw, "handleRespondCounter");
    action = parsed?.action === "accept" ? "accept_counter" : parsed?.action === "escalate" ? "escalate" : null;
  }
  if (!action) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return;
  }
  const { reviewShiftHoursAs } = await import("../billing/reviewShiftHours");
  try {
    await reviewShiftHoursAs(session.userId as string, { appointmentId: r.appointmentId, action });
  } catch (err) {
    await clearFlow(phone);
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `I couldn't do that — ${msg}. Check the Timesheets page for where this one stands.`);
    return;
  }
  await clearFlow(phone);
  const c = r.counter;
  const amount = resolveShiftBillableAmount({ startTime: c.start, endTime: c.end, bookedRateDollars: r.payRate, lineItems: r.lineItems });
  await sendMessage(chatId, action === "accept_counter"
    ? `Done — ${first(r.caregiverName)}'s counter is accepted: ${clock(c.start)}–${clock(c.end)} (${fmtDuration(amount.totalHours)}), ${money(amount.grossPay)} goes on your card on file.`
    : `Escalated — our team will look at this one and settle it within 48 hours. Nothing is charged until then; you'll hear from me when it's resolved.`);
}
