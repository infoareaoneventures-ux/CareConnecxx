// agents/caregiverPastBookings.ts — the caregiver Bookings page's PAST BOOKINGS
// tab (components/caregiver/CaregiverBookingsPage.tsx PastBookingGroupCard,
// 2026-09-29), texted. Same queries, same grouping, same card, same buttons:
//
//   past    = shifts where caregiverId == me and status in completed / cancelled,
//             date desc
//   missed  = shifts where caregiverId == me and status scheduled, date <= today,
//             kept only when the page would show them Overdue
//   grouped by bookingRequestId || clientId || id, missed first (the page merges
//   [...overdue, ...past]); the card = family · "N completed · N missed · N
//   cancelled" badges; two rows then "Show N more"; a completed row shows the
//   actual Started – Ended stamps and the duration; a missed row shows the
//   Log Hours button (replaced by the gate button while blocked); clicking a
//   completed row expands: scheduled + actual times, tasks per recipient
//   (done / not done), the visit notes log and the closing note.
//
//   Log Hours (the modal) = a scripted flow: actual start, actual end, tasks
//   done, a note, confirm → the page's exact write
//   {status:'completed', startedAt, completedAt, loggedManually:true,
//    tasksCompleted, completionNotes?, updatedAt} + its toast
//   "Hours logged successfully".
//
// Keywords announced in the texts: PAST (the tab), PAST VISITS (every visit),
// VISIT n (a completed visit's detail), LOG n (log hours for a missed visit).
import * as admin from "firebase-admin";
import { sendMessage, type AgentSession } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { isBackOutRequest, isQuestionOrOther, answerMidFlow } from "./stepHandler";
import { businessTodayStr, parseScheduledTimeMs, DEFAULT_TZ } from "../utils/scheduledTime";
import { shiftDisplayStatus } from "./shiftReschedule";
import { fmtDate, fmtTime } from "./caregiverBookingRequests";
import { taskItems, recipientBlocks, type TaskItem } from "./inShift";
import { checkCaregiverAccess, textCaregiverGateBlock } from "./caregiverAccessGate";

const db = admin.firestore();
export const PAGE_SIZE = 2;
export const EMPTY_TEXT = "No past bookings. Completed and cancelled shifts will appear here.";
const FLOW_TTL_MS = 60 * 60 * 1000;
const DIDNT_CATCH = "Sorry, I didn't quite catch that.";

type Doc = Record<string, unknown>;
export interface PastShift extends Doc { id: string; date: string; status: string; startTime?: string; endTime?: string; clientName?: string; clientId?: string; bookingRequestId?: string }
export interface PastGroup { key: string; clientName: string; clientId: string; shifts: PastShift[] }

function tsMs(v: unknown): number | null {
  if (!v) return null;
  if (typeof v === "string") { const ms = Date.parse(v); return Number.isNaN(ms) ? null : ms; }
  if (typeof v === "object") {
    const o = v as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof o.toMillis === "function") return o.toMillis();
    const s = typeof o.seconds === "number" ? o.seconds : typeof o._seconds === "number" ? o._seconds : null;
    return s === null ? null : s * 1000;
  }
  return null;
}
/** The page's fmtTs: "Sep 29, 8:45:51 PM" (business timezone). */
export function fmtStamp(v: unknown): string | null {
  const ms = tsMs(v);
  if (ms === null) return null;
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, month: "short", day: "numeric" })}, ${d.toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}`;
}
/** The page's fmtDuration: "0:09:08". */
export function fmtDuration(startV: unknown, endV: unknown): string | null {
  const s = tsMs(startV), e = tsMs(endV);
  if (s === null || e === null) return null;
  const total = Math.round((e - s) / 1000);
  if (total <= 0) return null;
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
const isMissed = (s: PastShift) => s.status === "scheduled" || s.status === "pending";
const scheduledTimes = (s: PastShift) => `${fmtTime(s.startTime)}${s.endTime ? ` – ${fmtTime(s.endTime)}` : ""}`;

/** The tab's two listeners, merged and grouped the way the page does. */
export async function loadPastTab(caregiverId: string): Promise<PastGroup[]> {
  const today = businessTodayStr();
  const [pastSnap, overdueSnap] = await Promise.all([
    db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "in", ["completed", "cancelled"]).orderBy("date", "desc").get(),
    db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "in", ["scheduled"]).where("date", "<=", today).get(),
  ]);
  const toShift = (d: FirebaseFirestore.QueryDocumentSnapshot): PastShift => ({ ...(d.data() as Doc), id: d.id, date: String(d.data().date ?? ""), status: String(d.data().status ?? "") });
  const past = pastSnap.docs.map(toShift).filter((s) => s.caregiverId === caregiverId && (s.status === "completed" || s.status === "cancelled"))
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.startTime ?? "").localeCompare(String(a.startTime ?? "")));
  const missed = overdueSnap.docs.map(toShift).filter((s) => s.caregiverId === caregiverId && s.status === "scheduled" && s.date <= today && shiftDisplayStatus(s) === "overdue");
  const groups = new Map<string, PastGroup>();
  for (const s of [...missed, ...past]) {
    const key = String(s.bookingRequestId || s.clientId || s.id);
    if (!groups.has(key)) groups.set(key, { key, clientName: String(s.clientName || "Client"), clientId: String(s.clientId ?? ""), shifts: [] });
    groups.get(key)!.shifts.push(s);
  }
  return [...groups.values()];
}

// ── The card ─────────────────────────────────────────────────────────────────
export function badgeLine(g: PastGroup): string {
  const completed = g.shifts.filter((s) => s.status === "completed").length;
  const cancelled = g.shifts.filter((s) => s.status === "cancelled").length;
  const missed = g.shifts.filter(isMissed).length;
  const badges = [completed > 0 ? `${completed} completed` : "", missed > 0 ? `${missed} missed` : "", cancelled > 0 ? `${cancelled} cancelled` : ""].filter(Boolean);
  return `${g.clientName}${badges.length ? ` · ${badges.join(" · ")}` : ""}`;
}
/** One row, numbered across the whole tab so VISIT n / LOG n are unambiguous. */
export function rowLine(n: number, s: PastShift): string {
  if (isMissed(s)) return `${n}. ${fmtDate(s.date)} · ${scheduledTimes(s)} · Missed — reply LOG ${n} to log hours`;
  if (s.status === "completed") {
    const a = fmtStamp(s.startedAt), b = fmtStamp(s.completedAt), d = fmtDuration(s.startedAt, s.completedAt);
    const times = a && b ? `${a} – ${b}${d ? ` · ${d}` : ""}` : scheduledTimes(s);
    return `${n}. ${fmtDate(s.date)} · ${times} · Completed`;
  }
  return `${n}. ${fmtDate(s.date)} · ${scheduledTimes(s)} · Cancelled`;
}

export interface LastPastBookingList { at: string; items: Array<{ number: number; shiftId: string; status: string; clientName: string }>; offset?: number; total?: number }

export function pastTabText(groups: PastGroup[], opts: { from?: number; allVisits?: boolean } = {}): { text: string; shown: PastGroup[]; remaining: number; items: LastPastBookingList["items"] } {
  const from = opts.from ?? 0;
  if (groups.length === 0) return { text: EMPTY_TEXT, shown: [], remaining: 0, items: [] };
  const shown = groups.slice(from, from + PAGE_SIZE);
  const remaining = Math.max(0, groups.length - (from + shown.length));
  if (shown.length === 0) return { text: "That's all your past bookings.", shown, remaining: 0, items: [] };
  // Numbers run across the whole tab (all groups, all visits) so a later VISIT n / LOG n is exact.
  const items: LastPastBookingList["items"] = [];
  let n = 0;
  const numberFor = new Map<string, number>();
  for (const g of groups) for (const s of g.shifts) { n += 1; numberFor.set(s.id, n); items.push({ number: n, shiftId: s.id, status: isMissed(s) ? "missed" : s.status, clientName: g.clientName }); }
  const blocks = shown.map((g) => {
    const visible = opts.allVisits ? g.shifts : g.shifts.slice(0, 2);
    const lines = [badgeLine(g), ...visible.map((s) => rowLine(numberFor.get(s.id)!, s))];
    const hidden = g.shifts.length - visible.length;
    if (hidden > 0) lines.push(`+${hidden} more visit${hidden === 1 ? "" : "s"} — reply PAST VISITS to see them all.`);
    return lines.join("\n");
  });
  const footer = [`Reply VISIT n for a completed visit's tasks and notes.`, remaining > 0 ? "Reply MORE for the next bookings." : ""].filter(Boolean).join(" ");
  return { text: [from === 0 ? "Past bookings:" : "More past bookings:", "", blocks.join("\n\n"), "", footer].join("\n"), shown, remaining, items };
}

export async function sendCaregiverPastBookings(phone: string, chatId: string, caregiverId: string, opts: { more?: boolean; allVisits?: boolean } = {}) {
  const groups = await loadPastTab(caregiverId);
  let prev: LastPastBookingList | undefined;
  if (opts.more) {
    const sess = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    prev = (sess?.data()?.lastPastBookingList as LastPastBookingList | undefined) ?? undefined;
  }
  const from = opts.more && prev ? (prev.offset ?? 0) : 0;
  const r = pastTabText(groups, { from, allVisits: opts.allVisits === true });
  await sendMessage(chatId, r.text);
  await db.collection("agent_sessions").doc(phone).set(
    { lastPastBookingList: { at: new Date().toISOString(), items: r.items, offset: from + r.shown.length, total: groups.length } satisfies LastPastBookingList },
    { merge: true },
  ).catch(() => {});
  return { sent: true, count: r.shown.length, total: groups.length, remaining: r.remaining, items: r.items };
}

/** VISIT n / LOG n → the shift it named (from the last texted list). */
export function resolvePastRef(session: Record<string, unknown>, ref: { number?: unknown; shiftId?: unknown }): { shiftId: string; status?: string } | null {
  if (typeof ref.shiftId === "string" && ref.shiftId) return { shiftId: ref.shiftId };
  const list = session.lastPastBookingList as LastPastBookingList | undefined;
  const n = Number(ref.number);
  const it = list?.items.find((x) => x.number === n);
  return it ? { shiftId: it.shiftId, status: it.status } : null;
}

// ── A completed visit, expanded (the page's click-through) ───────────────────
export function visitDetailText(s: PastShift): string {
  if (isMissed(s)) return `${fmtDate(s.date)} · ${scheduledTimes(s)} — this visit was missed. Reply LOG with its number to log the hours.`;
  if (s.status !== "completed") return `${fmtDate(s.date)} · ${scheduledTimes(s)} — this visit was cancelled; there's nothing to show.`;
  const lines = [`${fmtDate(s.date)} · Scheduled ${scheduledTimes(s)}`];
  const a = fmtStamp(s.startedAt), b = fmtStamp(s.completedAt), d = fmtDuration(s.startedAt, s.completedAt);
  if (a || b) lines.push(`Started ${a ?? "—"} · Ended ${b ?? "—"}${d ? ` · ${d}` : ""}`);
  const items = taskItems(s);
  if (items.length > 0) {
    const done = items.filter((t) => t.done).length;
    lines.push("", `Tasks (${done}/${items.length} done)`);
    const recipients = (Array.isArray(s.careRecipients) ? s.careRecipients : []) as Array<{ name?: string; relationship?: string } | string>;
    recipients.forEach((r, ri) => {
      if (typeof r === "string") return;
      const mine = items.filter((t) => t.recipientIndex === ri);
      if (mine.length === 0) return;
      lines.push(`${r.name}${r.relationship ? ` (${r.relationship})` : ""}`, ...mine.map((t) => `• ${t.label} — ${t.done ? "done" : "not done"}`));
    });
  }
  const log = (Array.isArray(s.notesLog) ? s.notesLog : []) as Array<{ at?: string; text?: string }>;
  const notes = log.filter((n) => typeof n.text === "string" && n.text.trim());
  if (notes.length) {
    lines.push("", "Visit notes");
    for (const n of notes) { const ms = typeof n.at === "string" ? Date.parse(n.at) : NaN; const t = Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit" }) : ""; lines.push(`• ${t ? `${t} — ` : ""}${String(n.text).trim()}`); }
  }
  const closing = typeof s.completionNotes === "string" ? s.completionNotes.trim() : "";
  if (closing) lines.push("", "Caregiver note", closing);
  return lines.join("\n");
}

export async function sendPastVisitDetail(chatId: string, caregiverId: string, shiftId: string): Promise<boolean> {
  const snap = await db.collection("shifts").doc(shiftId).get();
  if (!snap.exists || snap.data()?.caregiverId !== caregiverId) { await sendMessage(chatId, "That visit isn't on your Past Bookings tab."); return false; }
  await sendMessage(chatId, visitDetailText({ ...(snap.data() as Doc), id: snap.id, date: String(snap.data()?.date ?? ""), status: String(snap.data()?.status ?? "") }));
  return true;
}

// ── Log Hours — the modal as a scripted flow ─────────────────────────────────
export interface LogHoursFlowData {
  shiftId: string; clientName: string; date: string; startTime: string; endTime: string;
  startDate?: string; startAt?: string; endDate?: string; endAt?: string;
  tasks?: string[]; note?: string;
  taskList: Array<{ number: number; key: string; label: string; recipientName: string }>;
}
const START_Q = (d: LogHoursFlowData) => `Log hours for ${d.clientName}, ${fmtDate(d.date)}. What time did you actually start? Reply a time like 7:30 PM, or KEEP for the scheduled ${fmtTime(d.startTime)}.`;
const END_Q = (d: LogHoursFlowData) => `And what time did you finish? Reply a time, or KEEP for the scheduled ${fmtTime(d.endTime)}.`;
const TASKS_Q = (d: LogHoursFlowData, shift: Doc) => [`Which tasks were done?`, ...recipientBlocks(shift, taskItems(shift) as TaskItem[], { withNotes: true }), "", "Reply the numbers (e.g. 1, 3), ALL, or NONE."].join("\n");
const NOTE_Q = "Any notes about the visit? Reply with the note, or SKIP.";
function totalLabel(d: LogHoursFlowData): string | null {
  const s = parseScheduledTimeMs(`${d.startDate}T${d.startAt}:00`), e = parseScheduledTimeMs(`${d.endDate}T${d.endAt}:00`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  const mins = Math.round((e - s) / 60000);
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
const CONFIRM_Q = (d: LogHoursFlowData) => {
  const doneCount = (d.tasks ?? []).length;
  return [
    `Log hours for ${d.clientName}, ${fmtDate(d.date)}:`,
    `Started ${fmtDate(d.startDate ?? d.date)} ${fmtTime(d.startAt)} · Ended ${fmtDate(d.endDate ?? d.date)} ${fmtTime(d.endAt)}${totalLabel(d) ? ` · ${totalLabel(d)}` : ""}`,
    `Tasks done: ${doneCount}/${d.taskList.length}`,
    d.note ? `Note: ${d.note}` : "No note.",
    "", "Reply LOG to save, or CANCEL.",
  ].join("\n");
};

async function parse(prompt: string, text: string): Promise<string> {
  return quickComplete(prompt + "\nReply with ONLY the requested value — no explanation.", text, { maxTokens: 60 }).catch(() => "__parse_error__");
}
/** "7:30 pm" / "19:30" / "KEEP" → HH:MM; an explicit date ("Sep 29 at 7pm") is returned too. */
async function parseWhen(text: string, keepTime: string, defaultDate: string): Promise<{ time: string; date: string } | null> {
  const norm = text.trim().toUpperCase();
  if (norm === "KEEP" || norm === "SAME") return { time: keepTime, date: defaultDate };
  const raw = await parse(`Today is ${businessTodayStr()} (Pacific). The caregiver is naming the ACTUAL clock time of a visit that already happened. Reply "YYYY-MM-DD HH:MM" (24-hour) when they gave a date too, otherwise "HH:MM" alone. Reply NONE if no time is given.`, text);
  const dt = /(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/.exec(raw);
  if (dt) return { date: dt[1], time: `${dt[2].padStart(2, "0")}:${dt[3]}` };
  const t = /(\d{1,2}):(\d{2})/.exec(raw);
  if (!t) return null;
  return { date: defaultDate, time: `${t[1].padStart(2, "0")}:${t[2]}` };
}

export async function startLogHoursFlow(phone: string, chatId: string, session: AgentSession, args: { caregiverId: string; shiftId: string }): Promise<{ started: boolean; reason?: string }> {
  const snap = await db.collection("shifts").doc(args.shiftId).get();
  const shift = snap.data() as Doc | undefined;
  if (!snap.exists || !shift || shift.caregiverId !== args.caregiverId) { await sendMessage(chatId, "That visit isn't on your Past Bookings tab."); return { started: false, reason: "not_found" }; }
  const asPast: PastShift = { ...shift, id: snap.id, date: String(shift.date ?? ""), status: String(shift.status ?? "") };
  if (!isMissed(asPast) || shiftDisplayStatus(asPast) !== "overdue") { await sendMessage(chatId, `That visit is ${asPast.status === "completed" ? "already completed" : asPast.status} — Log Hours is only for a missed visit.`); return { started: false, reason: "not_missed" }; }
  // The page swaps Log Hours for the gate button while blocked.
  const access = await checkCaregiverAccess(args.caregiverId);
  if (!access.ok && access.block !== "transport") { await textCaregiverGateBlock(phone, chatId, access.block, access.caregiver as Record<string, unknown>); return { started: false, reason: "gated" }; }
  const items = taskItems(shift);
  const data: LogHoursFlowData = {
    shiftId: snap.id, clientName: String(shift.clientName || "the family"), date: asPast.date,
    startTime: String(shift.startTime ?? ""), endTime: String(shift.endTime ?? shift.startTime ?? ""),
    taskList: items.map((t) => ({ number: t.number, key: t.key, label: t.label, recipientName: t.recipientName })),
  };
  await db.collection("agent_sessions").doc(phone).update({ logHoursFlowStep: "lh_start", logHoursFlowData: data, stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() });
  await sendMessage(chatId, START_Q(data));
  return { started: true };
}

export async function handleLogHoursFlowStep(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const step = (session as unknown as Record<string, unknown>).logHoursFlowStep as string;
  const data = (((session as unknown as Record<string, unknown>).logHoursFlowData ?? {}) as LogHoursFlowData);
  const ref = db.collection("agent_sessions").doc(phone);
  const clear = () => ref.update({ logHoursFlowStep: admin.firestore.FieldValue.delete(), logHoursFlowData: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete() });
  const cancelled = async () => { await clear(); await sendMessage(chatId, "Okay — nothing was logged. The visit still shows as missed."); };
  const next = async (patch: Partial<LogHoursFlowData>, stepName: string, question: string) => {
    await ref.update({ logHoursFlowStep: stepName, logHoursFlowData: { ...data, ...patch } });
    await sendMessage(chatId, question);
  };

  if (step === "lh_start") {
    const q = START_Q(data);
    if (await isBackOutRequest(text, q)) return cancelled();
    if (await isQuestionOrOther(text, q)) { await sendMessage(chatId, await answerMidFlow(text, q)); return; }
    const w = await parseWhen(text, data.startTime, data.date);
    if (!w) { await sendMessage(chatId, `${DIDNT_CATCH} ${q}`); return; }
    return next({ startDate: w.date, startAt: w.time }, "lh_end", END_Q(data));
  }
  if (step === "lh_end") {
    const q = END_Q(data);
    if (await isBackOutRequest(text, q)) return cancelled();
    if (await isQuestionOrOther(text, q)) { await sendMessage(chatId, await answerMidFlow(text, q)); return; }
    // The page defaults the end DATE to the next day when the scheduled end is before the start (crosses midnight).
    const crosses = (data.endTime || "") < (data.startTime || "");
    const defaultEndDate = crosses ? addDays(data.startDate ?? data.date, 1) : (data.startDate ?? data.date);
    const w = await parseWhen(text, data.endTime, defaultEndDate);
    if (!w) { await sendMessage(chatId, `${DIDNT_CATCH} ${q}`); return; }
    // Like the modal: the end date is the start date (next day when the scheduled visit crosses midnight) unless they name one; an earlier clock is refused, not guessed.
    const endDate = w.date;
    if (parseScheduledTimeMs(`${endDate}T${w.time}:00`) <= parseScheduledTimeMs(`${data.startDate}T${data.startAt}:00`)) {
      await sendMessage(chatId, `The end has to be after the start (${fmtTime(data.startAt)}). ${q}`); return;
    }
    const withEnd = { endDate, endAt: w.time };
    if (data.taskList.length === 0) return next({ ...withEnd, tasks: [] }, "lh_note", NOTE_Q);
    const snap = await db.collection("shifts").doc(data.shiftId).get();
    return next(withEnd, "lh_tasks", TASKS_Q(data, (snap.data() ?? {}) as Doc));
  }
  if (step === "lh_tasks") {
    const q = "Which tasks were done? Reply the numbers (e.g. 1, 3), ALL, or NONE.";
    if (await isBackOutRequest(text, q)) return cancelled();
    const norm = text.trim().toUpperCase();
    let keys: string[] | null = null;
    if (norm === "ALL") keys = data.taskList.map((t) => t.key);
    else if (norm === "NONE") keys = [];
    else {
      const nums = (text.match(/\d+/g) ?? []).map(Number);
      if (nums.length) {
        const bad = nums.find((n) => !data.taskList.some((t) => t.number === n));
        if (bad !== undefined) { await sendMessage(chatId, `There's no task ${bad} — the list runs 1 to ${data.taskList.length}. ${q}`); return; }
        keys = data.taskList.filter((t) => nums.includes(t.number)).map((t) => t.key);
      }
    }
    if (keys === null) {
      if (await isQuestionOrOther(text, q)) { await sendMessage(chatId, await answerMidFlow(text, q)); return; }
      await sendMessage(chatId, `${DIDNT_CATCH} ${q}`); return;
    }
    return next({ tasks: keys }, "lh_note", NOTE_Q);
  }
  if (step === "lh_note") {
    if (await isBackOutRequest(text, NOTE_Q)) return cancelled();
    const norm = text.trim().toUpperCase();
    let note = "";
    if (norm !== "SKIP" && norm !== "NONE" && norm !== "NO") {
      const kind = await parse("A caregiver was asked: \"Any notes about the visit? Reply with the note, or SKIP.\" Classify: NOTE if the message is the note itself, QUESTION if it is a question or something else.", text);
      if (kind.toUpperCase().startsWith("Q")) { await sendMessage(chatId, await answerMidFlow(text, NOTE_Q)); return; }
      note = text.trim();
    }
    const merged = { ...data, note };
    await ref.update({ logHoursFlowStep: "lh_confirm", logHoursFlowData: merged });
    await sendMessage(chatId, CONFIRM_Q(merged));
    return;
  }
  if (step === "lh_confirm") {
    const q = CONFIRM_Q(data);
    const norm = text.trim().toUpperCase();
    let action: "log" | "cancel" | "other";
    // The page's button is "Log Hours"; CONFIRM is what a caregiver who just used the site will type (founder 2026-09-29). Fixed words, matched before any classifier.
    if (norm === "LOG" || norm === "LOG HOURS" || norm === "CONFIRM" || norm === "YES" || norm === "SAVE") action = "log";
    else if (norm === "CANCEL" || norm === "NO") action = "cancel";
    else if (await isBackOutRequest(text, q)) action = "cancel";
    else {
      const v = await parse("Evia asked the caregiver to reply LOG to save the hours, or CANCEL. Classify: LOG (save), CANCEL (don't), or OTHER (a question / a change).", text);
      action = v.toUpperCase().startsWith("LOG") ? "log" : v.toUpperCase().startsWith("CANCEL") ? "cancel" : "other";
    }
    if (action === "cancel") return cancelled();
    if (action === "other") {
      if (await isQuestionOrOther(text, q)) await sendMessage(chatId, await answerMidFlow(text, q));
      else await sendMessage(chatId, `${DIDNT_CATCH} ${q}`);
      return;
    }
    const startMs = parseScheduledTimeMs(`${data.startDate}T${data.startAt}:00`);
    const endMs = parseScheduledTimeMs(`${data.endDate}T${data.endAt}:00`);
    const shiftRef = db.collection("shifts").doc(data.shiftId);
    const cur = (await shiftRef.get()).data() as Doc | undefined;
    await clear();
    if (!cur || cur.status !== "scheduled") { await sendMessage(chatId, `That visit is already ${String(cur?.status ?? "gone")} — nothing to log.`); return; }
    // The modal's write, field for field.
    await shiftRef.update({
      status: "completed",
      startedAt: admin.firestore.Timestamp.fromMillis(startMs),
      completedAt: admin.firestore.Timestamp.fromMillis(endMs),
      loggedManually: true,
      tasksCompleted: data.tasks ?? [],
      ...(data.note ? { completionNotes: data.note } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await sendMessage(chatId, "Hours logged successfully. Reply SUBMIT to submit them for payment."); // the page's toast + the Timesheets tab's next step
    return;
  }
  await clear();
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}

// ── Keywords (routeCaregiver): PAST · PAST VISITS · VISIT n · LOG n ──────────
export async function handlePastBookingsKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const raw = text.trim(); const upper = raw.toUpperCase();
  if (upper === "PAST" || upper === "PAST BOOKINGS") { await sendCaregiverPastBookings(phone, chatId, caregiverId); return "handled"; }
  if (upper === "PAST VISITS") { await sendCaregiverPastBookings(phone, chatId, caregiverId, { allVisits: true }); return "handled"; }
  const visit = /^VISIT\s+(\d+)$/i.exec(raw);
  if (visit) {
    const r = resolvePastRef(session, { number: Number(visit[1]) });
    if (!r) { await sendMessage(chatId, `I don't have a visit ${visit[1]} on the last list — reply PAST to see your past bookings.`); return "handled"; }
    await sendPastVisitDetail(chatId, caregiverId, r.shiftId); return "handled";
  }
  // Bare LOG — what the missed-visit reminder announces (scheduled/shiftEndReminder.ts).
  // One missed visit → straight into its Log Hours flow; several → the tab, numbered.
  if (upper === "LOG" || upper === "LOG HOURS") {
    const missed = (await loadPastTab(caregiverId)).flatMap((g) => g.shifts).filter(isMissed);
    if (missed.length === 1) { await startLogHoursFlow(phone, chatId, session as unknown as AgentSession, { caregiverId, shiftId: missed[0].id }); return "handled"; }
    if (missed.length === 0) { await sendMessage(chatId, "You have no missed visits to log — every past visit is already completed or cancelled."); return "handled"; }
    await sendCaregiverPastBookings(phone, chatId, caregiverId, { allVisits: true });
    await sendMessage(chatId, "Which one? Reply LOG with the visit's number.");
    return "handled";
  }
  const log = /^LOG\s+(\d+)$/i.exec(raw);
  if (log) {
    const r = resolvePastRef(session, { number: Number(log[1]) });
    if (!r) { await sendMessage(chatId, `I don't have a visit ${log[1]} on the last list — reply PAST to see your past bookings.`); return "handled"; }
    await startLogHoursFlow(phone, chatId, session as unknown as AgentSession, { caregiverId, shiftId: r.shiftId }); return "handled";
  }
  return "passthrough";
}
