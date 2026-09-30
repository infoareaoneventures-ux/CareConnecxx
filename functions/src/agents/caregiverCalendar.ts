// agents/caregiverCalendar.ts — the caregiver's My Calendar page
// (components/caregiver/CaregiverCalendarPage.tsx), texted. Same three reads,
// same four views, same event detail panels; the actions on a detail are the
// Bookings page's and the Jobs page's buttons, which Evia already runs
// (START / TASKS / FINISH / CANCEL SHIFT; ACCEPT / DECLINE / propose / cancel).
//
//   reads   shifts (caregiverId, date range), video_interviews (caregiverId,
//           status in requested/accepted/scheduled/confirmed/in-progress/
//           completed), caregivers/{uid}.weeklyAvailability
//   views   Day · Week (Sun–Sat) · Month (+ the selected day, + Upcoming = next
//           4 scheduled shifts and 2 pending/accepted interviews) · List
//           (All / Upcoming / This week / This month / Last 30, grouped by day,
//           2 per day + "Show N more")
//   detail  a shift = the ShiftDetail panel; an interview = the InterviewDetail
//           panel (rows from caregiverInterviewsTab, the Jobs tab twin)
//
// Day and Week hide cancelled visits (the page does); Month and List show them.
// Keywords announced in the texts: CALENDAR (this week) · TODAY · TOMORROW ·
// WEEK / NEXT WEEK · MONTH · VISIT n · INTERVIEW n.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { businessTodayStr, DEFAULT_TZ, parseScheduledTimeMs } from "../utils/scheduledTime";
import { shiftDisplayStatus } from "./shiftReschedule";
import { fmtDate, fmtTime } from "./caregiverBookingRequests";
import { shiftStatusLabel } from "./caregiverActiveBookings";
import { fmtStamp, fmtDuration } from "./caregiverPastBookings";
import { taskItems, recipientBlocks, noteLines, startsInMinutes, START_WINDOW_MINUTES } from "./inShift";
import { listCaregiverInterviews, type CaregiverInterviewRow } from "./caregiverInterviewsTab";
import { gridFromWeekly, dayBlocksLabel, DAY_KEYS, type Grid } from "./caregiverAvailabilityGrid";
import { caregiverBlockReason, caregiverGateText } from "./caregiverAccessGate";

const db = admin.firestore();
type Doc = Record<string, unknown>;

export interface CalShift extends Doc { id: string; date: string; startTime: string; endTime?: string; status: string; clientName?: string; clientId?: string; bookingRequestId?: string }
export interface CalInterview { id: string; date: string; startTime: string; row: CaregiverInterviewRow }
export type CalEvent = { kind: "shift"; date: string; startTime: string; shift: CalShift } | { kind: "interview"; date: string; startTime: string; interview: CalInterview };

/** The page's fetchInterviews filter. */
const INTERVIEW_STATUSES = new Set(["requested", "accepted", "scheduled", "confirmed", "in-progress", "completed"]);

// ── Dates (business timezone; the page uses the browser's local date) ─────────
function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
export function addDays(dateStr: string, n: number): string { const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
export function dow(dateStr: string): number { return new Date(`${dateStr}T12:00:00Z`).getUTCDay(); }
/** Sunday of the week containing `dateStr`, offset by `weeks` (the page: today − getDay + offset×7). */
export function weekStart(dateStr: string, weeks = 0): string { return addDays(dateStr, -dow(dateStr) + weeks * 7); }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function monthLabel(ym: string): string { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; }
function monthRange(ym: string): { from: string; to: string } { const [y, m] = ym.split("-").map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` }; }
/** The page's weekLabel. */
export function weekLabel(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-").map(Number); const [, tm, td] = to.split("-").map(Number);
  return fm === tm ? `${MONTHS[fm - 1]} ${fd} – ${td}, ${fy}` : `${MONTHS[fm - 1].slice(0, 3)} ${fd} – ${MONTHS[tm - 1].slice(0, 3)} ${td}`;
}
/** An interview's scheduledTime → its business-timezone date and HH:MM (the page's parseInterview, in the browser's zone). */
export function interviewLocalParts(iso: string | null): { date: string; time: string } | null {
  if (!iso) return null;
  const ms = parseScheduledTimeMs(iso); const at = Number.isNaN(ms) ? Date.parse(iso) : ms;
  if (!Number.isFinite(at)) return null;
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at))) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}` };
}

// ── Reads ─────────────────────────────────────────────────────────────────────
export async function loadCalendarShifts(caregiverId: string, from: string, to: string): Promise<CalShift[]> {
  const snap = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("date", ">=", from).where("date", "<=", to).orderBy("date", "asc").get();
  return snap.docs.map((d): CalShift => ({ ...(d.data() as Doc), id: d.id, date: String(d.data().date ?? ""), startTime: String(d.data().startTime ?? ""), status: String(d.data().status ?? "") }))
    .filter((s) => s.caregiverId === caregiverId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}
export async function loadCalendarInterviews(caregiverId: string): Promise<CalInterview[]> {
  const tab = await listCaregiverInterviews(caregiverId, "all");
  const out: CalInterview[] = [];
  for (const row of tab.interviews) {
    if (!INTERVIEW_STATUSES.has(row.rawStatus)) continue;
    const parts = interviewLocalParts(row.scheduledTime);
    if (!parts) continue;
    out.push({ id: row.interviewId, date: parts.date, startTime: parts.time, row });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}
export async function loadGrid(caregiverId: string): Promise<Grid> {
  const snap = await db.collection("caregivers").doc(caregiverId).get();
  return gridFromWeekly(snap.data()?.weeklyAvailability);
}

// ── Lines ─────────────────────────────────────────────────────────────────────
const times = (s: { startTime?: string; endTime?: string }) => `${fmtTime(s.startTime)}${s.endTime ? ` – ${fmtTime(s.endTime)}` : ""}`;
function interviewStatusLabel(row: CaregiverInterviewRow): string {
  if (row.status === "pending") return "Pending";
  if (row.rawStatus === "in-progress") return "In Progress";
  return row.status.charAt(0).toUpperCase() + row.status.slice(1);
}
export function eventLine(n: number, e: CalEvent): string {
  if (e.kind === "shift") return `${n}. ${times(e.shift)} · ${e.shift.clientName || "Client"} · ${shiftStatusLabel(shiftDisplayStatus(e.shift))}`;
  const iv = e.interview;
  return `${n}. ${fmtTime(iv.startTime)} · Interview · ${iv.row.clientName}${iv.row.jobTitle && iv.row.jobTitle !== "Interview" ? ` · ${iv.row.jobTitle}` : ""} · ${interviewStatusLabel(iv.row)}`;
}
function events(shifts: CalShift[], interviews: CalInterview[], opts: { hideCancelled: boolean }): CalEvent[] {
  const all: CalEvent[] = [
    ...shifts.filter((s) => !opts.hideCancelled || s.status !== "cancelled").map((s): CalEvent => ({ kind: "shift", date: s.date, startTime: s.startTime, shift: s })),
    ...interviews.map((iv): CalEvent => ({ kind: "interview", date: iv.date, startTime: iv.startTime, interview: iv })),
  ];
  return all.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}
function dayHeader(dateStr: string, today: string, grid: Grid): string {
  const avail = dayBlocksLabel(grid, DAY_KEYS[dow(dateStr)]);
  return `${DAY_ABBR[dow(dateStr)]} ${Number(dateStr.slice(8))}${dateStr === today ? " (today)" : ""}${avail ? ` · Available: ${avail}` : ""}`;
}

export interface LastCalendarList { at: string; items: Array<{ number: number; kind: "shift" | "interview"; id: string; status: string; clientName: string; date: string }> }
type Built = { text: string; items: LastCalendarList["items"] };
const FOOTER = "Reply VISIT n or INTERVIEW n for details. TODAY, TOMORROW, WEEK, NEXT WEEK or MONTH for another view.";

function numbered(list: CalEvent[], start = 0): { lines: string[]; items: LastCalendarList["items"] } {
  const lines: string[] = []; const items: LastCalendarList["items"] = [];
  list.forEach((e, i) => {
    const n = start + i + 1;
    lines.push(eventLine(n, e));
    items.push(e.kind === "shift"
      ? { number: n, kind: "shift", id: e.shift.id, status: e.shift.status, clientName: String(e.shift.clientName || "Client"), date: e.date }
      : { number: n, kind: "interview", id: e.interview.id, status: e.interview.row.status, clientName: e.interview.row.clientName, date: e.date });
  });
  return { lines, items };
}

/** Day view: the day's non-cancelled visits + interviews, with the day's Available blocks. */
export function dayText(dateStr: string, shifts: CalShift[], interviews: CalInterview[], grid: Grid, today: string): Built {
  const list = events(shifts.filter((s) => s.date === dateStr), interviews.filter((iv) => iv.date === dateStr), { hideCancelled: true });
  const { lines, items } = numbered(list);
  const head = `${fmtDate(dateStr)}${dateStr === today ? " (today)" : ""}`;
  const avail = dayBlocksLabel(grid, DAY_KEYS[dow(dateStr)]);
  return { text: [head, avail ? `Available: ${avail}` : "Not marked available this day.", "", ...(lines.length ? lines : ["Nothing scheduled."]), "", FOOTER].join("\n"), items };
}
/** Week view: Sun → Sat, each day's Available blocks and events; cancelled hidden. */
export function weekText(from: string, shifts: CalShift[], interviews: CalInterview[], grid: Grid, today: string): Built {
  const to = addDays(from, 6);
  const blocks: string[] = []; const items: LastCalendarList["items"] = []; let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const list = events(shifts.filter((s) => s.date === d), interviews.filter((iv) => iv.date === d), { hideCancelled: true });
    const built = numbered(list, n); n += list.length; items.push(...built.items);
    blocks.push([dayHeader(d, today, grid), ...(built.lines.length ? built.lines : ["—"])].join("\n"));
  }
  return { text: [`Week of ${weekLabel(from, to)}`, "", blocks.join("\n\n"), "", FOOTER].join("\n"), items };
}
/** Month view: the page's dots as counts per day with events, then the Upcoming panel. */
export function monthText(ym: string, shifts: CalShift[], interviews: CalInterview[], today: string): Built {
  const { from, to } = monthRange(ym);
  const inMonth = events(shifts.filter((s) => s.date >= from && s.date <= to), interviews.filter((iv) => iv.date >= from && iv.date <= to), { hideCancelled: false });
  const byDay = new Map<string, CalEvent[]>();
  for (const e of inMonth) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date)!.push(e); }
  const dayLines = [...byDay.entries()].map(([d, list]) => {
    const counts = new Map<string, number>();
    for (const e of list) { const k = e.kind === "shift" ? shiftStatusLabel(shiftDisplayStatus(e.shift)).toLowerCase() : "interview"; counts.set(k, (counts.get(k) ?? 0) + 1); }
    const parts = [...counts.entries()].map(([k, c]) => `${c} ${k}${c === 1 ? "" : k.endsWith("s") ? "" : "s"}`);
    return `${DAY_ABBR[dow(d)]} ${Number(d.slice(8))}${d === today ? " (today)" : ""}: ${parts.join(", ")}`;
  });
  // Upcoming — next 4 scheduled shifts and next 2 pending/accepted interviews from today.
  const upShifts = shifts.filter((s) => s.date >= today && s.status === "scheduled").slice(0, 4);
  const upIvs = interviews.filter((iv) => iv.date >= today && (iv.row.status === "pending" || iv.row.status === "accepted")).slice(0, 2);
  const upcoming = events(upShifts, upIvs, { hideCancelled: true });
  const built = numbered(upcoming);
  const upLines = built.lines.map((l, i) => l.replace(/^\d+\. /, `${i + 1}. ${fmtDate(upcoming[i].date)} · `));
  return {
    text: [monthLabel(ym), "", ...(dayLines.length ? dayLines : ["No events this month."]), "", "Upcoming", ...(upLines.length ? upLines : ["No upcoming events"]), "", FOOTER].join("\n"),
    items: built.items,
  };
}
export type ListFilter = "all" | "upcoming" | "this-week" | "this-month" | "last-30";
/** List view: the page's filters, grouped by day, two events per day + "Show N more" (numbers count the hidden ones too, so VISIT n still works). */
export function listText(filter: ListFilter, shifts: CalShift[], interviews: CalInterview[], today: string, opts: { from?: number; perPage?: number } = {}): Built & { remaining: number } {
  const ws = weekStart(today); const we = addDays(ws, 6);
  const { from: mFrom, to: mTo } = monthRange(today.slice(0, 7));
  const inRange = (d: string) => filter === "upcoming" ? d >= today : filter === "this-week" ? d >= ws && d <= we : filter === "this-month" ? d >= mFrom && d <= mTo : filter === "last-30" ? d >= addDays(today, -30) && d <= today : true;
  const all = events(shifts, interviews, { hideCancelled: false }).filter((e) => inRange(e.date));
  const dates = [...new Set(all.map((e) => e.date))].sort();
  const perPage = opts.perPage ?? 5; const start = opts.from ?? 0;
  const shownDates = dates.slice(start, start + perPage);
  const items: LastCalendarList["items"] = []; let n = 0; const blocks: string[] = [];
  for (const d of dates) {
    const list = all.filter((e) => e.date === d);
    const built = numbered(list, n); n += list.length; items.push(...built.items);
    if (!shownDates.includes(d)) continue;
    const visible = built.lines.slice(0, 2); const hidden = built.lines.length - visible.length;
    blocks.push([`${fmtDate(d)}${d === today ? " (today)" : ""}`, ...visible, ...(hidden > 0 ? [`+${hidden} more that day — reply TODAY or TOMORROW, or ask me for that day.`] : [])].join("\n"));
  }
  const label: Record<ListFilter, string> = { all: "All", upcoming: "Upcoming", "this-week": "This Week", "this-month": "This Month", "last-30": "Last 30 Days" };
  const remaining = Math.max(0, dates.length - (start + shownDates.length));
  return {
    text: [`Calendar · ${label[filter]}`, "", ...(blocks.length ? [blocks.join("\n\n")] : ["No events for this period"]), "", `${FOOTER}${remaining > 0 ? " Reply MORE for more days." : ""}`].join("\n"),
    items, remaining,
  };
}

// ── Detail panels ─────────────────────────────────────────────────────────────
/** The page's ShiftDetail panel. `booking` = booking_requests/{bookingRequestId} (recipients' tasks, the booking note, emergency contact). */
export function shiftDetailText(shift: CalShift, booking: Doc | null, opts: { gate?: "membership" | "background" | "transport" | null; nowMs?: number } = {}): string {
  const nowMs = opts.nowMs ?? Date.now();
  const status = shiftDisplayStatus(shift);
  const lines = [`${shift.status === "in-progress" ? "In Progress" : shiftStatusLabel(status)} · ${shift.clientName || "Client"}`, `${fmtDate(shift.date)} · ${times(shift)}`];
  if (shift.rate != null) lines.push(`$${shift.rate}/hr`);
  if (shift.address) lines.push(String(shift.address));
  const prefs = Array.isArray(shift.lifestylePreferences) ? (shift.lifestylePreferences as string[]) : [];
  if (prefs.length) lines.push(prefs.join(" · "));
  lines.push(...noteLines(shift, typeof booking?.notes === "string" ? (booking.notes as string) : null));
  const a = fmtStamp(shift.startedAt), b = fmtStamp(shift.completedAt), dur = fmtDuration(shift.startedAt, shift.completedAt);
  if (a || b) lines.push(`Scheduled ${times(shift)}`, `Started ${a ?? "—"}${b ? ` · Ended ${b}` : ""}${dur ? ` · ${dur}` : ""}`);
  // Tasks — grouped by recipient like the panel; the recipients come from the booking when the shift copy is missing.
  const source: Doc = Array.isArray(shift.careRecipients) && (shift.careRecipients as unknown[]).length ? shift : { ...shift, careRecipients: booking?.careRecipients ?? [] };
  const items = taskItems(source);
  if (items.length) {
    const done = items.filter((t) => t.done).length;
    lines.push("", `Tasks ${done}/${items.length}`, ...recipientBlocks(source, items, { withNotes: true, withDone: true }));
  }
  // Actions — the panel's buttons under the page's conditions, as the words Evia already answers to.
  lines.push("");
  if (shift.status === "scheduled") {
    const mins = startsInMinutes(shift, nowMs);
    const canStart = mins !== null && mins <= START_WINDOW_MINUTES && status !== "overdue";
    if (status === "overdue") lines.push("This visit was missed — reply LOG to log the hours.");
    else if (canStart) lines.push(opts.gate && opts.gate !== "transport" ? caregiverGateText(opts.gate) : "Reply START to start this shift.");
    else lines.push(`Start available ${START_WINDOW_MINUTES} min before the shift.`);
    if (status !== "overdue") lines.push("Reply CANCEL SHIFT to cancel it.");
  } else if (shift.status === "in-progress") {
    lines.push("In progress — reply DONE n to check off a task, NOTE followed by anything the family should see, TASKS to re-list, or FINISH when the visit is over.");
  } else if (shift.status === "completed") {
    lines.push("Shift Completed");
    const log = (Array.isArray(shift.notesLog) ? shift.notesLog : []) as Array<{ at?: string; text?: string }>;
    const notes = log.filter((n) => typeof n.text === "string" && n.text.trim());
    if (notes.length) { lines.push("Visit notes"); for (const n of notes) { const ms = typeof n.at === "string" ? Date.parse(n.at) : NaN; const t = Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit" }) : ""; lines.push(`• ${t ? `${t} — ` : ""}${String(n.text).trim()}`); } }
    if (typeof shift.completionNotes === "string" && shift.completionNotes.trim()) lines.push("Caregiver note", shift.completionNotes.trim());
  } else if (shift.status === "cancelled") {
    lines.push("Shift Cancelled");
  } else if (shift.status === "needs_replacement") {
    lines.push("You cancelled this visit — the family is picking a replacement.");
  }
  lines.push(`To message ${shift.clientName || "the family"}, just tell me what to send.`);
  const ec = booking?.emergencyContact as { name?: string; relationship?: string; phone?: string } | undefined;
  if (ec?.name) lines.push("", `Emergency contact: ${ec.name}${ec.relationship ? ` · ${ec.relationship}` : ""}${ec.phone ? ` · ${ec.phone}` : ""}`);
  return lines.join("\n");
}

/** The page's InterviewDetail panel, from the Jobs-tab twin's row. */
export function interviewDetailText(row: CaregiverInterviewRow, job: Doc | null): string {
  const lines = [`Interview · ${interviewStatusLabel(row)} · ${row.clientName}`];
  // The panel: "Mon, Sep 28 · 9:00 AM" (weekday short, month short, day · clock), business timezone.
  const ms = row.scheduledTime ? parseScheduledTimeMs(row.scheduledTime) : NaN;
  lines.push(Number.isFinite(ms)
    ? `${new Date(ms).toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, weekday: "short", month: "short", day: "numeric" })} · ${new Date(ms).toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit" })}`
    : row.scheduledTimeLocal ?? "Time to be set");
  lines.push(row.interviewType === "Video" ? "Video Call" : row.interviewType === "Phone" ? "Phone Call" : "In Person");
  const location = (job?.location as string) || ([job?.city, job?.state].filter(Boolean).join(", ") || null) || row.jobLocation;
  if (location) lines.push(location);
  const careTypes = (Array.isArray(job?.careTypes) ? job!.careTypes : Array.isArray(job?.requirements) ? job!.requirements : []) as string[];
  if (careTypes.length) lines.push(careTypes.join(" · "));
  const days = Array.isArray(job?.daysOfWeek) ? (job!.daysOfWeek as string[]) : [];
  if (days.length) lines.push(`Days: ${days.join(", ")}`);
  const tod = Array.isArray(job?.timeOfDay) ? (job!.timeOfDay as string[]).map((t) => t.charAt(0).toUpperCase() + t.slice(1)) : [];
  if (tod.length) lines.push(`Time: ${tod.join(", ")}`);
  const freq = typeof job?.jobFrequency === "string" ? (job!.jobFrequency as string).replace("-", " ") : "";
  const rate = job?.rate != null ? `$${job!.rate}/hr` : row.rate;
  if (freq || rate) lines.push([freq, rate].filter(Boolean).join(" · "));
  if (row.notes) lines.push(`Notes: ${row.notes}`);
  if (row.proposal) lines.push("", row.proposal.banner);
  lines.push("");
  const acts: string[] = [];
  for (const a of row.actions) {
    if (a === "Accept") acts.push("Reply ACCEPT to accept");
    else if (a === "Decline") acts.push("DECLINE to decline");
    else if (a === "Propose different time") acts.push("or tell me a different time to propose");
    else if (a === "Accept new time") acts.push("Reply ACCEPT to take the new time, or DECLINE");
    else if (a === "Join video call" && row.joinVideoCall) acts.push(`Join: ${row.joinVideoCall}`);
    else if (a === "Cancel") acts.push("Tell me if you need to cancel this interview");
    else if (a === "Activate Membership" || a === "Complete Verification") acts.push(caregiverGateText(a === "Activate Membership" ? "membership" : "background"));
  }
  if (acts.length) lines.push(acts.join(". ").replace(/\.\./g, ".") + (acts[acts.length - 1].endsWith(".") ? "" : "."));
  lines.push(`To message ${row.clientName}, just tell me what to send.`);
  return lines.join("\n");
}

// ── Send ──────────────────────────────────────────────────────────────────────
export type CalendarView = { view: "day"; date?: string } | { view: "week"; offset?: number } | { view: "month"; month?: string } | { view: "list"; filter?: ListFilter; more?: boolean };

export async function sendCaregiverCalendar(phone: string, chatId: string, caregiverId: string, req: CalendarView): Promise<{ sent: true; count: number; items: LastCalendarList["items"]; remaining?: number }> {
  const today = businessTodayStr();
  const grid = await loadGrid(caregiverId);
  let range: { from: string; to: string };
  if (req.view === "day") { const d = req.date ?? today; range = { from: d, to: d }; }
  else if (req.view === "week") { const from = weekStart(today, req.offset ?? 0); range = { from, to: addDays(from, 6) }; }
  else if (req.view === "month") range = monthRange(req.month ?? today.slice(0, 7));
  else range = req.filter === "last-30" ? { from: addDays(today, -30), to: today } : req.filter === "this-week" ? { from: weekStart(today), to: addDays(weekStart(today), 6) } : req.filter === "this-month" ? monthRange(today.slice(0, 7)) : { from: req.filter === "upcoming" ? today : addDays(today, -400), to: addDays(today, 400) };
  // Month view's Upcoming panel reaches past the month; the page's shifts query spans month−1 … month+2.
  const shiftRange = req.view === "month" ? { from: range.from < today ? range.from : today, to: addDays(range.to, 62) } : range;
  const [shifts, interviews] = await Promise.all([loadCalendarShifts(caregiverId, shiftRange.from, shiftRange.to), loadCalendarInterviews(caregiverId)]);
  let built: Built & { remaining?: number };
  if (req.view === "day") built = dayText(req.date ?? today, shifts, interviews, grid, today);
  else if (req.view === "week") built = weekText(range.from, shifts, interviews, grid, today);
  else if (req.view === "month") built = monthText(req.month ?? today.slice(0, 7), shifts, interviews, today);
  else {
    let from = 0;
    if (req.more) { const s = await db.collection("agent_sessions").doc(phone).get().catch(() => null); from = Number((s?.data()?.lastCalendarList as { offset?: number } | undefined)?.offset ?? 0); }
    built = listText(req.filter ?? "upcoming", shifts, interviews, today, { from });
    await db.collection("agent_sessions").doc(phone).set({ lastCalendarList: { at: new Date().toISOString(), items: built.items, offset: from + 5, filter: req.filter ?? "upcoming" } }, { merge: true }).catch(() => {});
    await sendMessage(chatId, built.text);
    return { sent: true, count: built.items.length, items: built.items, remaining: built.remaining };
  }
  await sendMessage(chatId, built.text);
  await db.collection("agent_sessions").doc(phone).set({ lastCalendarList: { at: new Date().toISOString(), items: built.items } satisfies LastCalendarList }, { merge: true }).catch(() => {});
  return { sent: true, count: built.items.length, items: built.items };
}

export function resolveCalendarRef(session: Record<string, unknown>, n: number, kind?: "shift" | "interview"): LastCalendarList["items"][number] | null {
  const list = session.lastCalendarList as LastCalendarList | undefined;
  const it = list?.items.find((x) => x.number === n && (!kind || x.kind === kind));
  return it ?? null;
}
/** Is the calendar the most recent numbered list this caregiver was texted? (VISIT n then means the calendar's numbering.) */
export function calendarListIsLatest(session: Record<string, unknown>): boolean {
  const cal = (session.lastCalendarList as LastCalendarList | undefined)?.at;
  if (!cal) return false;
  const others = [(session.lastPastBookingList as { at?: string } | undefined)?.at, (session.lastActiveBookingList as { at?: string } | undefined)?.at].filter((x): x is string => typeof x === "string");
  return others.every((o) => o < cal);
}

export async function sendCalendarShiftDetail(chatId: string, caregiverId: string, shiftId: string): Promise<boolean> {
  const snap = await db.collection("shifts").doc(shiftId).get();
  const s = snap.data() as Doc | undefined;
  if (!snap.exists || !s || s.caregiverId !== caregiverId) { await sendMessage(chatId, "That visit isn't on your calendar."); return false; }
  const [bookingSnap, cgSnap] = await Promise.all([
    s.bookingRequestId ? db.collection("booking_requests").doc(String(s.bookingRequestId)).get().catch(() => null) : Promise.resolve(null),
    db.collection("caregivers").doc(caregiverId).get().catch(() => null),
  ]);
  const gate = caregiverBlockReason((cgSnap?.data() ?? {}) as Record<string, unknown>);
  await sendMessage(chatId, shiftDetailText({ ...s, id: snap.id, date: String(s.date ?? ""), startTime: String(s.startTime ?? ""), status: String(s.status ?? "") }, (bookingSnap?.data() as Doc | undefined) ?? null, { gate }));
  return true;
}
export async function sendCalendarInterviewDetail(chatId: string, caregiverId: string, interviewId: string): Promise<boolean> {
  const tab = await listCaregiverInterviews(caregiverId, "all");
  const row = tab.interviews.find((r) => r.interviewId === interviewId);
  if (!row) { await sendMessage(chatId, "That interview isn't on your calendar."); return false; }
  const job = row.jobId ? (await db.collection("job_posts").doc(row.jobId).get().catch(() => null))?.data() ?? null : null;
  await sendMessage(chatId, interviewDetailText(row, (job as Doc | null)));
  return true;
}

// ── Keywords (routeCaregiver) ─────────────────────────────────────────────────
export async function handleCalendarKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const raw = text.trim(); const upper = raw.toUpperCase().replace(/\s+/g, " ");
  const view: CalendarView | null =
    upper === "CALENDAR" || upper === "MY CALENDAR" || upper === "WEEK" || upper === "THIS WEEK" ? { view: "week" }
    : upper === "NEXT WEEK" ? { view: "week", offset: 1 }
    : upper === "TODAY" ? { view: "day" }
    : upper === "TOMORROW" ? { view: "day", date: addDays(businessTodayStr(), 1) }
    : upper === "MONTH" || upper === "THIS MONTH" ? { view: "month" }
    : null;
  if (view) { await sendCaregiverCalendar(phone, chatId, caregiverId, view); return "handled"; }
  const iv = /^INTERVIEW\s+(\d+)$/i.exec(raw);
  if (iv) {
    const ref = resolveCalendarRef(session, Number(iv[1]), "interview");
    if (!ref) { await sendMessage(chatId, `I don't have an interview ${iv[1]} on the last list — reply CALENDAR to see this week.`); return "handled"; }
    await sendCalendarInterviewDetail(chatId, caregiverId, ref.id); return "handled";
  }
  const visit = /^VISIT\s+(\d+)$/i.exec(raw);
  if (visit && calendarListIsLatest(session)) {
    const ref = resolveCalendarRef(session, Number(visit[1]));
    if (!ref) { await sendMessage(chatId, `I don't have a visit ${visit[1]} on the last list — reply CALENDAR to see this week.`); return "handled"; }
    if (ref.kind === "interview") await sendCalendarInterviewDetail(chatId, caregiverId, ref.id);
    else await sendCalendarShiftDetail(chatId, caregiverId, ref.id);
    return "handled";
  }
  return "passthrough";
}
