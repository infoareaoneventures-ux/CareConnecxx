// Scripted "Request Visit" flow — the website's Calendar "+ Request Visit"
// modal (components/Schedule.tsx) walked step for step over SMS:
//
//   caregiver (from accepted bookings with visits still scheduled) → booking
//   (if that caregiver has more than one) → days → per-day time blocks
//   (checked the way the modal greys times out: overlap with the booking's
//   own schedule / this family's shifts with the caregiver is refused, a time
//   the caregiver is booked elsewhere is refused, outside their usual
//   availability is only a warning) → start date → ongoing or end date →
//   optional note → recap → YES → the SAME booking_amendments write the
//   modal's submit makes.
//
// Built 2026-09-16 (My Calendar parity). Same pattern as rescheduleFlow.ts:
// session-state step machine dispatched BEFORE intent classification,
// back-out check first on every step, isQuestionOrOther guard, deterministic
// bare number / yes / no before any model call, one recap + explicit YES
// gate. Nothing is written until that YES. Shares every check and write with
// the MCP tool (request_schedule_amendment) via agents/visitRequest.ts.
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS, bareNumberPick } from "./stepHandler";
import { businessTodayStr, formatDateWithWeekday } from "../utils/scheduledTime";
import {
  listVisitRequestCaregivers, loadCaregiverAvailability, checkVisitBlock, createScheduleAmendment,
  normDayAbbr, blockToRange, describeBlock, describeRange, ABBR_TO_FULL, DAY_ABBRS,
  type VisitRequestCaregiver, type VisitRequestBooking, type TimeBlock, type DayAbbr,
} from "./visitRequest";

const db = admin.firestore();

// ── Session data shape ────────────────────────────────────────────────────────

export interface VisitRequestFlowData {
  caregivers: VisitRequestCaregiver[];
  caregiverId?: string;
  caregiverName?: string;
  bookingId?: string;
  jobTitle?: string;
  days?: DayAbbr[];
  dayTimes?: Record<string, TimeBlock[]>;
  startDate?: string;
  ongoing?: boolean;
  endDate?: string;
  notes?: string;
  // Soft warnings from the availability check (the modal's orange hint).
  warnings?: string[];
}

const VR_DIDNT_CATCH = "Sorry, I didn't quite catch that.";
const BARE_NO = new Set(["NO", "N", "NOPE", "NAH", "NONE", "SKIP"]);

// ── Model plumbing (same shape as rescheduleFlow.ts so tests drive it identically) ─

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const response = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:     prompt + "\nReply with ONLY the requested value or format — no explanation, no extra text, no questions. Never invent information the user's message doesn't contain.",
      messages:   [{ role: "user", content: userText }],
    });
    const parsed = ((response.content[0] as { text: string }).text ?? "").trim();
    if (parsed && caraOutputGuardEnabled() && !guardModelOutput(parsed).ok) {
      console.warn("[visitRequestFlow] parseWithClaude: output guard rejected model response", { rawLength: parsed.length });
      return "__parse_error__";
    }
    return parsed;
  } catch (err) {
    console.error("[visitRequestFlow] parseWithClaude: Anthropic call threw", err);
    return "__parse_error__";
  }
}

function parseJsonLoose(raw: string, where: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch {
    console.warn(`[visitRequestFlow] ${where}: JSON.parse failed on model output`, { raw: raw.slice(0, 300) });
    return null;
  }
}

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The question Evia just asked the family was: "${currentQuestion}"\n\n` +
    "Reply NO if the family's message is ANY attempt — even a single word, a bare number, a day name, a time, or a short/partial/vague one — " +
    "to address that specific question. A vague or incomplete attempt still counts as a direct answer. " +
    "Reply YES only if the message is a genuine question, or a comment that does not attempt to address what was asked at all. " +
    "Only reply YES or NO.",
    text,
  );
  return result.toUpperCase().startsWith("Y");
}

const VR_MIDFLOW_FALLBACK = "Good question — I don't want to guess on that one.";

async function answerQuestionMidFlow(text: string): Promise<string> {
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a family request an additional care visit (a new day/time) on one of " +
      "their existing bookings. You see ONLY this one message, not the rest of the conversation — including anything " +
      "Evia herself said earlier. NEVER claim something was or wasn't mentioned before; you cannot know that. NEVER " +
      "state whether a caregiver is available at a time — you cannot see their schedule. If the message is clearly " +
      "about something OTHER than finishing this visit request, say plainly that it'll have to wait, e.g. \"That sounds " +
      "like something else — let's finish this first, and I'll help with that right after.\" Otherwise answer briefly " +
      "(1–2 sentences). Be warm. NEVER write out a URL. " + ANTI_INVENTION_CLAUSE,
    messages: [{ role: "user", content: text }],
  });
  const answer = ((response.content[0] as { text: string }).text ?? "").trim();
  if (answer && caraOutputGuardEnabled() && !guardModelOutput(answer).ok) return VR_MIDFLOW_FALLBACK;
  return answer;
}

// ── Session helpers ───────────────────────────────────────────────────────────

async function getFlowData(phone: string): Promise<VisitRequestFlowData> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return (snap.data()?.visitRequestFlowData ?? { caregivers: [] }) as VisitRequestFlowData;
}
async function mergeFlowData(phone: string, data: Partial<VisitRequestFlowData>): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const existing = (snap.data()?.visitRequestFlowData ?? { caregivers: [] }) as VisitRequestFlowData;
  await db.collection("agent_sessions").doc(phone).update({ visitRequestFlowData: { ...existing, ...data } });
}
async function updateStep(phone: string, step: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ visitRequestFlowStep: step });
}
async function clearFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    visitRequestFlowStep: admin.firestore.FieldValue.delete(),
    visitRequestFlowData: admin.firestore.FieldValue.delete(),
    stateExpiresAt:       admin.firestore.FieldValue.delete(),
  });
}
async function handleBackOut(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await clearFlow(phone);
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: "The family decided not to request the extra care visit after all. Warmly confirm nothing was sent and their schedule is unchanged.",
    fallback: "No problem — I haven't sent anything. Your schedule stays exactly as it is.",
    maxTokens: 80,
  }));
}

// ── Copy ──────────────────────────────────────────────────────────────────────

function chosenCaregiver(d: VisitRequestFlowData): VisitRequestCaregiver | undefined {
  return d.caregivers.find((c) => c.id === d.caregiverId);
}
function chosenBooking(d: VisitRequestFlowData): VisitRequestBooking | undefined {
  return chosenCaregiver(d)?.bookings.find((b) => b.bookingId === d.bookingId);
}
function fullDays(days: readonly string[]): string {
  return days.map((d) => ABBR_TO_FULL[d] ?? d).join(", ");
}
function CAREGIVER_QUESTION(d: VisitRequestFlowData): string {
  return `Which caregiver is this visit for?\n\n${d.caregivers.map((c, i) => `${i + 1}. ${c.name}`).join("\n")}\n\nReply with a number.`;
}
function BOOKING_QUESTION(d: VisitRequestFlowData): string {
  const cg = chosenCaregiver(d);
  const list = (cg?.bookings ?? []).map((b, i) => `${i + 1}. ${b.jobTitle}${b.address ? ` — ${b.address}` : ""}`).join("\n");
  return `Which of your bookings with ${cg?.name ?? "them"} should this be added to?\n\n${list}\n\nReply with a number.`;
}
function DAYS_QUESTION(d: VisitRequestFlowData): string {
  const b = chosenBooking(d);
  const current = b && Object.keys(b.schedule).length
    ? ` (${d.caregiverName} currently comes ${DAY_ABBRS.filter((a) => b.schedule[a]).map((a) => `${ABBR_TO_FULL[a]} ${b.schedule[a].map(describeBlock).join(" & ")}`).join(", ")}.)`
    : "";
  return `Which day or days would you like to add?${current}`;
}
function TIMES_QUESTION(d: VisitRequestFlowData): string {
  const days = d.days ?? [];
  return days.length === 1
    ? `What time on ${ABBR_TO_FULL[days[0]]}? (e.g. "9am to 1pm", or two blocks like "9–11 and 2–4")`
    : `What times? You can give one time for all of them (e.g. "9am to 1pm each day") or per day (e.g. "${days.map((a) => `${a} 9–1`).join(", ")}").`;
}
const START_QUESTION = 'When should this start? (e.g. "this week", "September 22", or "today")';
const END_QUESTION = "Is this ongoing, or should it end on a certain date?";
function NOTES_QUESTION(d: VisitRequestFlowData): string {
  return `Any notes for ${d.caregiverName ?? "the caregiver"}? Reply NO to skip.`;
}
// "Tuesday 2:00 PM–3:00 PM (1h)" — the modal shows each day's hours next to it.
function describeDayLine(d: VisitRequestFlowData, a: string): string {
  const blocks = d.dayTimes?.[a] ?? [];
  const hours = blocks.reduce((sum, b) => { const r = blockToRange(b); return sum + (r ? (r.e - r.s) / 60 : 0); }, 0);
  const hoursLabel = hours > 0 ? ` (${hours % 1 === 0 ? hours : hours.toFixed(2)}h)` : "";
  return `${ABBR_TO_FULL[a]} ${blocks.map(describeBlock).join(" & ")}${hoursLabel}`;
}

export function buildVisitRequestRecap(d: VisitRequestFlowData): string {
  const lines = (d.days ?? []).map((a) => describeDayLine(d, a));
  const span = d.ongoing ? "ongoing" : d.endDate ? `through ${formatDateWithWeekday(d.endDate)}` : "";
  return [
    "Here's your visit request:",
    "",
    `Caregiver: ${d.caregiverName}`,
    `Booking: ${d.jobTitle}`,
    `Days & times: ${lines.join("; ")}`,
    `Starting: ${d.startDate ? formatDateWithWeekday(d.startDate) : "today"}${span ? ` (${span})` : ""}`,
    `Notes: ${d.notes ? `"${d.notes}"` : "None"}`,
    ...(d.warnings?.length ? ["", ...d.warnings.map((w) => `Note: ${w}`)] : []),
    "",
    `${d.caregiverName} will need to accept before these visits are added. Reply YES to send it, NO to cancel, or tell me what to change.`,
  ].join("\n");
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export async function startVisitRequestFlow(
  phone: string, chatId: string, session: AgentSession, args: { caregiverId?: string; initialText?: string } = {},
): Promise<{ started: boolean; reason?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to look up your bookings. Please try again.");
    return { started: false, reason: "no_client_id" };
  }
  const caregivers = await listVisitRequestCaregivers(clientId);
  if (caregivers.length === 0) {
    await sendMessage(chatId,
      "A visit request adds a day to a booking that's already active, and I don't see an active booking with visits on the calendar right now. " +
      "Once a caregiver has accepted a booking, I can add days to it — or I can help you send a new booking request.");
    return { started: false, reason: "no_active_booking" };
  }
  const data: VisitRequestFlowData = { caregivers };
  await db.collection("agent_sessions").doc(phone).update({
    visitRequestFlowStep: "vr_pick_caregiver",
    visitRequestFlowData: data,
    stateExpiresAt:       new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  let cg = args.caregiverId ? caregivers.find((c) => c.id === args.caregiverId) : undefined;
  if (!cg && caregivers.length === 1) cg = caregivers[0];
  if (!cg && args.initialText?.trim()) {
    const raw = await parseWithClaude(
      `Caregivers, numbered:\n${caregivers.map((c, i) => `${i + 1}. ${c.name}`).join("\n")}\n\n` +
      "If the family's message clearly names one of these caregivers, return ONLY that number. Otherwise return 0.",
      args.initialText,
    );
    const n = parseInt(raw.trim(), 10);
    if (n >= 1 && n <= caregivers.length) cg = caregivers[n - 1];
  }
  if (!cg) {
    await sendMessage(chatId, CAREGIVER_QUESTION(data));
    return { started: true };
  }
  await selectCaregiver(phone, chatId, cg, args.initialText);
  return { started: true };
}

async function selectCaregiver(phone: string, chatId: string, cg: VisitRequestCaregiver, initialText?: string): Promise<void> {
  await mergeFlowData(phone, { caregiverId: cg.id, caregiverName: cg.name });
  if (cg.bookings.length > 1) {
    await updateStep(phone, "vr_pick_booking");
    await sendMessage(chatId, BOOKING_QUESTION(await getFlowData(phone)));
    return;
  }
  await selectBooking(phone, chatId, cg.bookings[0], initialText);
}

async function selectBooking(phone: string, chatId: string, b: VisitRequestBooking, initialText?: string): Promise<void> {
  await mergeFlowData(phone, { bookingId: b.bookingId, jobTitle: b.jobTitle });
  const data = await getFlowData(phone);
  // The family's own words may already carry the day(s) and time(s)
  // ("add Thursdays 9 to 1 with Basra") — read them against the real booking.
  if (initialText?.trim()) {
    const parsed = await parseDaysAndTimes(initialText, data);
    if (parsed) {
      const applied = await applyDaysAndTimes(phone, chatId, parsed, data);
      if (applied) return;
    }
  }
  await updateStep(phone, "vr_ask_days");
  await sendMessage(chatId, `Adding a visit for ${data.caregiverName}. ${DAYS_QUESTION(data)}`);
}

// ── Step dispatch ─────────────────────────────────────────────────────────────

export async function handleVisitRequestFlowStep(
  phone: string, chatId: string, text: string, session: AgentSession,
): Promise<void> {
  const step = ((session as any).visitRequestFlowStep as string) ?? "";
  switch (step) {
    case "vr_pick_caregiver": return handlePickCaregiver(phone, chatId, text, session);
    case "vr_pick_booking":   return handlePickBooking(phone, chatId, text, session);
    case "vr_ask_days":       return handleAskDays(phone, chatId, text, session);
    case "vr_ask_times":      return handleAskTimes(phone, chatId, text, session);
    case "vr_ask_start":      return handleAskStart(phone, chatId, text, session);
    case "vr_ask_end":        return handleAskEnd(phone, chatId, text, session);
    case "vr_ask_notes":      return handleAskNotes(phone, chatId, text, session);
    case "vr_confirm":        return handleConfirm(phone, chatId, text, session);
    default: {
      const data = await getFlowData(phone);
      await updateStep(phone, "vr_pick_caregiver");
      await sendMessage(chatId, CAREGIVER_QUESTION(data));
    }
  }
}

// Shared guard: back-out → question → false (caller proceeds to parse).
async function guarded(phone: string, chatId: string, text: string, session: AgentSession, question: string): Promise<boolean> {
  if (await isBackOutRequest(text, question)) { await handleBackOut(phone, chatId, session); return true; }
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerQuestionMidFlow(text));
    await sendMessage(chatId, question);
    return true;
  }
  return false;
}

// ── Steps: pick caregiver / booking ───────────────────────────────────────────

async function handlePickCaregiver(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = CAREGIVER_QUESTION(data);
  let idx = bareNumberPick(text, data.caregivers.length);
  if (idx === null) {
    if (await guarded(phone, chatId, text, session, question)) return;
    const raw = await parseWithClaude(
      `Caregivers, numbered:\n${data.caregivers.map((c, i) => `${i + 1}. ${c.name}`).join("\n")}\n\nReturn ONLY the number (1-based) the family picked, or 0 if unclear. Never guess.`,
      text,
    );
    idx = parseInt(raw.trim(), 10);
    if (isNaN(idx) || idx < 1 || idx > data.caregivers.length) { await sendMessage(chatId, `${VR_DIDNT_CATCH} ${question}`); return; }
  }
  await selectCaregiver(phone, chatId, data.caregivers[idx - 1], text);
}

async function handlePickBooking(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const bookings = chosenCaregiver(data)?.bookings ?? [];
  const question = BOOKING_QUESTION(data);
  let idx = bareNumberPick(text, bookings.length);
  if (idx === null) {
    if (await guarded(phone, chatId, text, session, question)) return;
    const raw = await parseWithClaude(
      `Bookings, numbered:\n${bookings.map((b, i) => `${i + 1}. ${b.jobTitle}`).join("\n")}\n\nReturn ONLY the number (1-based) the family picked, or 0 if unclear. Never guess.`,
      text,
    );
    idx = parseInt(raw.trim(), 10);
    if (isNaN(idx) || idx < 1 || idx > bookings.length) { await sendMessage(chatId, `${VR_DIDNT_CATCH} ${question}`); return; }
  }
  await selectBooking(phone, chatId, bookings[idx - 1]);
}

// ── Steps: days + times ───────────────────────────────────────────────────────

interface ParsedDaysTimes { days: DayAbbr[]; dayTimes: Record<string, TimeBlock[]> }

async function parseDaysAndTimes(text: string, data: VisitRequestFlowData): Promise<ParsedDaysTimes | null> {
  const raw = await parseWithClaude(
    `The family is adding a visit for ${data.caregiverName}. Extract the day(s) of the week and any time block(s) they stated. ` +
    'Return ONLY a JSON object: {"days": ["Tue", ...] 3-letter abbreviations or [] if no day stated, ' +
    '"dayTimes": {"Tue": [{"start": "HH:MM", "end": "HH:MM"}], ...} 24-hour, only for days whose times they actually stated, ' +
    '"allDays": {"start": "HH:MM", "end": "HH:MM"} or null if they gave one time meant for every day}. ' +
    '"weekdays" = Mon-Fri, "weekends" = Sat+Sun. A day can have more than one block ("9-11 and 2-4"). Never invent a day or a time.',
    text,
  );
  const parsed = parseJsonLoose(raw, "parseDaysAndTimes");
  if (!parsed) return null;
  const days = Array.from(new Set(((Array.isArray(parsed.days) ? parsed.days : []) as unknown[]).map(normDayAbbr).filter(Boolean))) as DayAbbr[];
  const dayTimes: Record<string, TimeBlock[]> = {};
  const rawDT = (parsed.dayTimes ?? {}) as Record<string, Array<{ start?: unknown; end?: unknown }>>;
  for (const [k, blocks] of Object.entries(rawDT)) {
    const abbr = normDayAbbr(k);
    if (!abbr || !Array.isArray(blocks)) continue;
    const valid = blocks.map((b) => ({ start: String(b?.start ?? ""), end: String(b?.end ?? "") })).filter((b) => blockToRange(b));
    if (valid.length) { dayTimes[abbr] = valid; if (!days.includes(abbr)) days.push(abbr); }
  }
  const all = parsed.allDays as { start?: unknown; end?: unknown } | null;
  if (all && days.length) {
    const b = { start: String(all.start ?? ""), end: String(all.end ?? "") };
    if (blockToRange(b)) for (const d of days) if (!dayTimes[d]) dayTimes[d] = [b];
  }
  if (!days.length) return null;
  return { days, dayTimes };
}

// Runs the modal's checks on the given blocks. Hard problems are returned as
// messages (nothing stored); soft ones are stored as warnings for the recap.
async function applyDaysAndTimes(phone: string, chatId: string, p: ParsedDaysTimes, data: VisitRequestFlowData): Promise<boolean> {
  const missing = p.days.filter((d) => !p.dayTimes[d]?.length);
  await mergeFlowData(phone, { days: p.days, dayTimes: p.dayTimes });
  if (missing.length) {
    await updateStep(phone, "vr_ask_times");
    await sendMessage(chatId, `${fullDays(p.days)}, got it. ${TIMES_QUESTION({ ...data, days: p.days })}`);
    return true;
  }
  const problems = await checkAllBlocks(phone, data, p.days, p.dayTimes);
  if (problems.length) {
    await updateStep(phone, "vr_ask_times");
    await sendMessage(chatId, `${problems.join(" ")} ${TIMES_QUESTION({ ...data, days: p.days })}`);
    return true;
  }
  await updateStep(phone, "vr_ask_start");
  await sendMessage(chatId, `${fullDays(p.days)}, got it. ${START_QUESTION}`);
  return true;
}

async function checkAllBlocks(phone: string, data: VisitRequestFlowData, days: DayAbbr[], dayTimes: Record<string, TimeBlock[]>): Promise<string[]> {
  const clientId = (await db.collection("agent_sessions").doc(phone).get()).data()?.userId as string | undefined;
  if (!clientId || !data.caregiverId) return [];
  const avail = await loadCaregiverAvailability(clientId, data.caregiverId);
  const booking = chosenBooking(data);
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const day of days) {
    for (const block of dayTimes[day] ?? []) {
      const c = checkVisitBlock(day, block, booking, avail);
      if (c.overlap) problems.push(`${ABBR_TO_FULL[day]} ${describeBlock(block)} overlaps a visit you already have with ${data.caregiverName} (${describeBlock(c.overlap)}).`);
      else if (c.busy) problems.push(`${data.caregiverName} is already booked ${ABBR_TO_FULL[day]} ${describeRange(c.busy)}, which overlaps ${describeBlock(block)}.`);
      else if (c.outsidePreferred) warnings.push(`${ABBR_TO_FULL[day]} ${describeBlock(block)} is outside ${data.caregiverName}'s usual availability — they may not be able to accept it.`);
    }
    // Two of the family's own blocks on the same day overlapping each other.
    const ranges = (dayTimes[day] ?? []).map(blockToRange);
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j];
      if (a && b && a.s < b.e && b.s < a.e) problems.push(`Two of the ${ABBR_TO_FULL[day]} times overlap each other.`);
    }
  }
  await mergeFlowData(phone, { warnings });
  return problems;
}

async function handleAskDays(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = DAYS_QUESTION(data);
  if (await guarded(phone, chatId, text, session, question)) return;
  const parsed = await parseDaysAndTimes(text, data);
  if (!parsed) { await sendMessage(chatId, `${VR_DIDNT_CATCH} ${question}`); return; }
  await applyDaysAndTimes(phone, chatId, parsed, data);
}

async function handleAskTimes(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const question = TIMES_QUESTION(data);
  if (await guarded(phone, chatId, text, session, question)) return;
  const days = data.days ?? [];
  const raw = await parseWithClaude(
    `The family is giving times for these days: ${fullDays(days)}. Return ONLY a JSON object: ` +
    '{"dayTimes": {"Tue": [{"start": "HH:MM", "end": "HH:MM"}], ...} 24-hour, for each day they gave a time for, ' +
    '"allDays": {"start": "HH:MM", "end": "HH:MM"} or null if they gave one time meant for every day}. ' +
    "A day can have more than one block. If they say a time with no day, it applies to every day. Never invent a time.",
    text,
  );
  const parsed = parseJsonLoose(raw, "handleAskTimes");
  if (!parsed) { await sendMessage(chatId, `${VR_DIDNT_CATCH} ${question}`); return; }
  const dayTimes: Record<string, TimeBlock[]> = { ...(data.dayTimes ?? {}) };
  const rawDT = (parsed.dayTimes ?? {}) as Record<string, Array<{ start?: unknown; end?: unknown }>>;
  for (const [k, blocks] of Object.entries(rawDT)) {
    const abbr = normDayAbbr(k);
    if (!abbr || !Array.isArray(blocks)) continue;
    const valid = blocks.map((b) => ({ start: String(b?.start ?? ""), end: String(b?.end ?? "") })).filter((b) => blockToRange(b));
    if (valid.length) dayTimes[abbr] = valid;
  }
  const all = parsed.allDays as { start?: unknown; end?: unknown } | null;
  if (all) {
    const b = { start: String(all.start ?? ""), end: String(all.end ?? "") };
    if (blockToRange(b)) for (const d of days) if (!rawDT[d]) dayTimes[d] = [b];
  }
  const missing = days.filter((d) => !dayTimes[d]?.length);
  if (missing.length === days.length) { await sendMessage(chatId, `${VR_DIDNT_CATCH} ${question}`); return; }
  await mergeFlowData(phone, { dayTimes });
  if (missing.length) {
    await sendMessage(chatId, `Got it. And what time on ${fullDays(missing)}?`);
    return;
  }
  const problems = await checkAllBlocks(phone, data, days, dayTimes);
  if (problems.length) { await sendMessage(chatId, `${problems.join(" ")} ${question}`); return; }
  await updateStep(phone, "vr_ask_start");
  await sendMessage(chatId, START_QUESTION);
}

// ── Steps: start / end / notes ────────────────────────────────────────────────

async function handleAskStart(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await guarded(phone, chatId, text, session, START_QUESTION)) return;
  const today = businessTodayStr();
  const raw = await parseWithClaude(
    `Today is ${formatDateWithWeekday(today)} (${today}). Extract the date the family wants the new visits to start. ` +
    'Return ONLY a JSON object: {"date": "YYYY-MM-DD" or null}. "today"/"asap"/"right away"/"this week" → today. ' +
    "A weekday name → the next such date on or after today. Never invent a date.",
    text,
  );
  const parsed = parseJsonLoose(raw, "handleAskStart");
  const date = typeof parsed?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null;
  if (!date) { await sendMessage(chatId, `${VR_DIDNT_CATCH} ${START_QUESTION}`); return; }
  if (date < today) { await sendMessage(chatId, `${formatDateWithWeekday(date)} has already passed — ${START_QUESTION}`); return; }
  await mergeFlowData(phone, { startDate: date });
  await updateStep(phone, "vr_ask_end");
  await sendMessage(chatId, `Starting ${formatDateWithWeekday(date)}. ${END_QUESTION}`);
}

async function handleAskEnd(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await guarded(phone, chatId, text, session, END_QUESTION)) return;
  const data = await getFlowData(phone);
  const today = businessTodayStr();
  const raw = await parseWithClaude(
    `Today is ${today}; the visits start ${data.startDate ?? today}. Is the arrangement ongoing (no end date) or does it end on a date? ` +
    'Return ONLY a JSON object: {"ongoing": true or false, "endDate": "YYYY-MM-DD" or null}. ' +
    '"ongoing"/"indefinitely"/"until further notice"/"no end" → ongoing true. Never invent a date.',
    text,
  );
  const parsed = parseJsonLoose(raw, "handleAskEnd");
  if (parsed?.ongoing === true) {
    await mergeFlowData(phone, { ongoing: true, endDate: undefined });
  } else {
    const end = typeof parsed?.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.endDate) ? parsed.endDate : null;
    if (!end) { await sendMessage(chatId, `${VR_DIDNT_CATCH} ${END_QUESTION}`); return; }
    if (end < (data.startDate ?? today)) { await sendMessage(chatId, `The end date needs to be on or after the start date. ${END_QUESTION}`); return; }
    await mergeFlowData(phone, { ongoing: false, endDate: end });
  }
  await updateStep(phone, "vr_ask_notes");
  await sendMessage(chatId, NOTES_QUESTION(data));
}

async function handleAskNotes(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  if (BARE_NO.has(bare)) return goToRecap(phone, chatId);
  const question = NOTES_QUESTION(data);
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, session);
  // The modal's Notes box stores whatever the family types, verbatim. Over
  // SMS the only thing to detect is a plain decline ("no thanks", "nothing")
  // — and even then only for a short reply. 2026-09-17 (live-caught): "this
  // adding a shift" was judged a skip and the note was lost; anything with
  // real words in it is the note.
  const words = text.trim().split(/\s+/).length;
  if (words <= 4) {
    const verdict = await parseWithClaude(
      'The family was asked for an optional note to their caregiver. Reply DECLINE only if this short message is purely declining to add one ' +
      '("no thanks", "nothing", "no notes", "skip it", "none"). Reply NOTE if it contains anything they might want passed along. Only reply DECLINE or NOTE.',
      text,
    );
    if (verdict.toUpperCase().startsWith("DECLINE")) return goToRecap(phone, chatId);
  }
  await mergeFlowData(phone, { notes: text.trim() });
  return goToRecap(phone, chatId);
}

async function goToRecap(phone: string, chatId: string): Promise<void> {
  await updateStep(phone, "vr_confirm");
  await sendMessage(chatId, buildVisitRequestRecap(await getFlowData(phone)));
}

// ── Step: recap → YES sends the request ───────────────────────────────────────

async function handleConfirm(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const recap = buildVisitRequestRecap(data);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  if (TRIVIAL_CONFIRM_WORDS.has(bare)) return commit(phone, chatId, session, data);
  if (BARE_NO.has(bare)) return handleBackOut(phone, chatId, session);
  if (await isBackOutRequest(text, recap)) return handleBackOut(phone, chatId, session);

  const raw = await parseWithClaude(
    `Evia asked: "${recap}"\n\nClassify the family's reply. Return ONLY a JSON object: ` +
    '{"action": "confirm" | "cancel" | "change_days" | "change_times" | "change_start" | "change_end" | "change_notes" | "change_caregiver" | "other"}. ' +
    '"confirm" = clearly wants it sent; "cancel" = doesn\'t want to send anything; the change_* values = wants to change that part; "other" = a question or something else.',
    text,
  );
  const parsed = parseJsonLoose(raw, "handleConfirm");
  switch (parsed?.action) {
    case "confirm": return commit(phone, chatId, session, data);
    case "cancel":  return handleBackOut(phone, chatId, session);
    case "change_days":
    case "change_times": {
      // Re-read the new days/times from this very message if it carries them.
      const p = await parseDaysAndTimes(text, data);
      if (p) { await applyDaysAndTimes(phone, chatId, p, data); return; }
      await mergeFlowData(phone, { days: [], dayTimes: {}, warnings: [] });
      await updateStep(phone, "vr_ask_days");
      await sendMessage(chatId, DAYS_QUESTION(data));
      return;
    }
    case "change_start": await updateStep(phone, "vr_ask_start"); await sendMessage(chatId, START_QUESTION); return;
    case "change_end":   await updateStep(phone, "vr_ask_end");   await sendMessage(chatId, END_QUESTION); return;
    case "change_notes": await updateStep(phone, "vr_ask_notes"); await sendMessage(chatId, NOTES_QUESTION(data)); return;
    case "change_caregiver":
      await mergeFlowData(phone, { caregiverId: undefined, caregiverName: undefined, bookingId: undefined, jobTitle: undefined });
      await updateStep(phone, "vr_pick_caregiver");
      await sendMessage(chatId, CAREGIVER_QUESTION(data));
      return;
    default:
      await sendMessage(chatId, await answerQuestionMidFlow(text));
      await sendMessage(chatId, recap);
  }
}

async function commit(phone: string, chatId: string, session: AgentSession, data: VisitRequestFlowData): Promise<void> {
  const clientId = session.userId as string;
  if (!data.caregiverId || !data.bookingId || !data.days?.length || !data.dayTimes) {
    await updateStep(phone, "vr_pick_caregiver");
    await sendMessage(chatId, CAREGIVER_QUESTION(data));
    return;
  }
  // Fresh check against the live schedule — the site may have changed since the recap.
  const problems = await checkAllBlocks(phone, data, data.days, data.dayTimes);
  if (problems.length) {
    await updateStep(phone, "vr_ask_times");
    await sendMessage(chatId, `${problems.join(" ")} ${TIMES_QUESTION(data)}`);
    return;
  }
  const newDays: Record<string, TimeBlock[]> = {};
  for (const d of data.days) if (data.dayTimes[d]?.length) newDays[d] = data.dayTimes[d];
  const { amendmentId } = await createScheduleAmendment({
    clientId,
    bookingRequestId: data.bookingId,
    caregiverId: data.caregiverId,
    caregiverName: data.caregiverName ?? "Caregiver",
    newDays,
    notes: data.notes ?? "",
    startDate: data.startDate ?? businessTodayStr(),
    endDate: data.ongoing ? null : (data.endDate ?? null),
    ongoing: data.ongoing !== false,
    source: "visitRequestFlow",
  });
  void amendmentId;
  await clearFlow(phone);
  const lines = data.days.map((a) => describeDayLine(data, a)).join("; ");
  await sendMessage(chatId,
    `Sent — I asked ${data.caregiverName} to add ${lines}${data.startDate ? ` starting ${formatDateWithWeekday(data.startDate)}` : ""}. ` +
    `Nothing is added to the calendar until they accept; I'll text you as soon as they respond. It shows under Requests on your My Bookings page too.`);
}
