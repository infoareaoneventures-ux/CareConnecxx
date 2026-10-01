// The caregiver Payments page › Timesheets tab, texted
// (components/caregiver/CaregiverPaymentsPage.tsx + components/payroll/SubmitShiftHoursModal.tsx).
//
// Same two reads as the page (shiftHours for this caregiver; completed shifts),
// the same three chips (Unsubmitted = completed shifts with no shiftHours doc;
// Pending = pending_client_review / correction_proposed / caregiver_counter_proposed /
// payment_failed; History = everything else), the same cards, the same two
// modals as scripted flows:
//   - Submit hours worked: clock in/out are the shift's own stamps (read-only on
//     the page too), only additional charges are asked, then SUBMIT runs the
//     site's own server write (shiftHours.ts submitShiftHoursAs) and texts the
//     page's toast.
//   - Review correction (only a correction_proposed row): ACCEPT, or COUNTER →
//     start, end, charge amounts, note, SEND → the same server write
//     (respondToCorrectionAs) and the page's toast.
// The History chip's Report (date range → shifts / total hours / total earnings)
// is a keyword; the CSV itself is content a text can't carry.
//
// Numbered lists: every texted chip stores lastTimesheetList on the session, and
// SUBMIT n / REVIEW n / DETAILS n / VIEW n resolve to document ids from it — never
// by name or guess. Nothing a person reads carries an id.
import * as admin from "firebase-admin";
import { sendMessage, type AgentSession } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { isBackOutRequest, isQuestionOrOther, answerMidFlow } from "./stepHandler";
import { businessTodayStr, parseScheduledTimeMs, DEFAULT_TZ } from "../utils/scheduledTime";
import { visitDetailText, type PastShift } from "./caregiverPastBookings";
import { getAppUrl } from "../config/appUrl";

const db = admin.firestore();
const FLOW_TTL_MS = 60 * 60 * 1000;
const DIDNT_CATCH = "Sorry, I didn't quite catch that.";
const HISTORY_PAGE = 5;
/** Same threshold as the modal / shiftBillingPolicy: gross over $500 needs the family's explicit approval. */
const EXPLICIT_APPROVAL_THRESHOLD_DOLLARS = 500;
const SCHEDULE_GRACE_MS = 15 * 60 * 1000;

type Doc = Record<string, unknown>;
export interface TimesheetRow extends Doc { id: string; status: string }
export interface SubmittableShift extends Doc { id: string }
export type Chip = "unsubmitted" | "pending" | "history";

export const PENDING_STATUSES = ["pending_client_review", "correction_proposed", "caregiver_counter_proposed", "payment_failed"];
/** The page's STATUS_LABEL map, verbatim. */
export const STATUS_LABEL: Record<string, string> = {
  pending_client_review: "Pending client review",
  correction_proposed: "Correction Received",
  caregiver_counter_proposed: "Counter sent",
  approved: "Approved",
  auto_approved: "Auto-approved",
  disputed_admin_review: "Admin reviewing",
  requires_admin_review: "Under review",
  paid: "Paid",
  payment_failed: "Awaiting Payment",
};
const HISTORY_ACTION_LABEL: Record<string, string> = {
  submitted: "Submitted by caregiver",
  proposed_correction: "Client proposed correction",
  counter_proposed: "Caregiver sent counter",
  accepted: "Accepted",
  escalated: "Escalated to admin",
  admin_resolved: "Resolved by admin",
};
export const EMPTY_UNSUBMITTED = "No shifts waiting on you to submit hours.";
export const EMPTY_PENDING = "Nothing pending.";
export const EMPTY_HISTORY = "No completed shifts yet.";
export const EMPTY_REPORT = "No history records match the selected date range.";

// ── formatters (the page's fmtTime / fmtDate / fmtDateTime / fmtDuration, business timezone) ──
export function tsMs(v: unknown): number | null {
  if (!v) return null;
  if (typeof v === "string") { const ms = Date.parse(v); return Number.isNaN(ms) ? null : ms; }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    const o = v as { toMillis?: () => number; toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof o.toMillis === "function") return o.toMillis();
    if (typeof o.toDate === "function") return o.toDate().getTime();
    const s = typeof o.seconds === "number" ? o.seconds : typeof o._seconds === "number" ? o._seconds : null;
    return s === null ? null : s * 1000;
  }
  return null;
}
export const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
export const clockShort = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit", hour12: true });
export const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, month: "short", day: "numeric" });
export const longDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, month: "short", day: "numeric", year: "numeric" });
export const dateTime = (ms: number) => `${shortDate(ms)}, ${clock(ms)}`;
export const stampShort = (ms: number) => `${shortDate(ms)}, ${clockShort(ms)}`;
/** The page's fmtDuration: hours → "H:MM:SS". */
export function dur(hours: number): string {
  const total = Math.max(0, Math.round(hours * 3600));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** The page's `localDate` (en-CA → YYYY-MM-DD) in the business timezone. */
export const localDay = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: DEFAULT_TZ });
/** "2026-09-01" → "Sep 1" (a stored YYYY-MM-DD, no timezone shift). */
export function fmtDay(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}
const monthLabel = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, month: "long", year: "numeric" });

// ── the page's reads ────────────────────────────────────────────────────────
export interface TimesheetsTab { submittable: SubmittableShift[]; pending: TimesheetRow[]; history: TimesheetRow[]; corrections: TimesheetRow[] }
export async function loadTimesheetsTab(caregiverId: string): Promise<TimesheetsTab> {
  const [hoursSnap, shiftsSnap] = await Promise.all([
    db.collection("shiftHours").where("caregiverId", "==", caregiverId).get(),
    db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "==", "completed").get(),
  ]);
  const rows: TimesheetRow[] = hoursSnap.docs.map((d) => ({ ...(d.data() as Doc), id: d.id, status: String(d.data().status ?? "") }));
  rows.sort((a, b) => (tsMs(b.submittedAt) ?? 0) - (tsMs(a.submittedAt) ?? 0)); // the page's orderBy submittedAt desc
  const withHours = new Set(rows.map((r) => String(r.appointmentId ?? r.id)));
  const submittable: SubmittableShift[] = shiftsSnap.docs
    .map((d) => ({ ...(d.data() as Doc), id: d.id }))
    .filter((s) => !withHours.has(s.id))
    .sort((a, b) => (shiftStartMs(b) ?? 0) - (shiftStartMs(a) ?? 0));
  const pending = rows.filter((r) => PENDING_STATUSES.includes(r.status));
  const history = rows.filter((r) => !PENDING_STATUSES.includes(r.status));
  return { submittable, pending, history, corrections: pending.filter((r) => r.status === "correction_proposed") };
}

/** The modal's actual / scheduled times for an Unsubmitted shift. */
export function shiftTimes(s: Doc): { startMs: number | null; endMs: number | null; scheduledStartMs: number; scheduledEndMs: number; actual: boolean } {
  const date = String(s.date ?? "");
  const startTime = String(s.startTime ?? "00:00");
  const endTime = typeof s.endTime === "string" && s.endTime ? s.endTime : null;
  const scheduledStartMs = parseScheduledTimeMs(`${date}T${startTime}:00`);
  let scheduledEndMs = endTime ? parseScheduledTimeMs(`${date}T${endTime}:00`) : scheduledStartMs + 3_600_000;
  if (Number.isFinite(scheduledEndMs) && Number.isFinite(scheduledStartMs) && scheduledEndMs <= scheduledStartMs) scheduledEndMs += 24 * 3_600_000;
  const a = tsMs(s.startedAt), b = tsMs(s.completedAt);
  const actual = a !== null && b !== null;
  return { startMs: a ?? (Number.isFinite(scheduledStartMs) ? scheduledStartMs : null), endMs: b ?? (Number.isFinite(scheduledEndMs) ? scheduledEndMs : null), scheduledStartMs, scheduledEndMs, actual };
}
function shiftStartMs(s: Doc): number | null { return shiftTimes(s).startMs; }

function rowStart(r: Doc): number | null { return tsMs(r.finalStartTime ?? r.submittedStartTime); }
function rowEnd(r: Doc): number | null { return tsMs(r.finalEndTime ?? r.submittedEndTime); }
function rowHours(r: Doc): number {
  const s = rowStart(r), e = rowEnd(r);
  if (s !== null && e !== null && e > s) return (e - s) / 3_600_000;
  return Number(r.finalTotalHours ?? r.submittedTotalHours ?? 0) || 0;
}
function rowGross(r: Doc): number {
  if (typeof r.grossPay === "number") return r.grossPay;
  if (typeof r.basePay === "number") return r.basePay;
  return round2(rowHours(r) * (Number(r.payRate) || 0));
}
function items(v: unknown): Array<{ type?: string; label?: string; note?: string; amount?: number }> { return Array.isArray(v) ? (v as Array<Doc>) : []; }
const itemLabel = (li: { type?: string; label?: string }) => (li.type === "custom" ? (li.label || "Custom") : (li.label || li.type || "Custom"));
/** The page's "Corrected" badge rule. */
export function isCorrected(r: Doc): boolean {
  const by = String(r.resolvedBy ?? "");
  if (["caregiver", "admin", "system_auto_accept"].includes(by)) return true;
  const hist = items(r.correctionHistory) as Array<{ action?: string }>;
  return by === "client" && hist.some((h) => h.action === "correction_proposed" || h.action === "proposed_correction" || h.action === "counter_proposed");
}

// ── rows + chip texts ───────────────────────────────────────────────────────
export interface ListItem { number: number; kind: "shift" | "timesheet"; id: string; status?: string }
export interface LastTimesheetList { at: string; chip: Chip; items: ListItem[]; offset?: number; total?: number }

function groupByClient<T extends Doc>(rows: T[]): Array<{ name: string; rows: T[] }> {
  const map = new Map<string, { name: string; rows: T[] }>();
  for (const r of rows) {
    const key = String(r.clientId || r.clientName || "unknown");
    const g = map.get(key) ?? { name: String(r.clientName || "Client"), rows: [] };
    g.rows.push(r); map.set(key, g);
  }
  return [...map.values()];
}

export function unsubmittedRowLine(n: number, s: Doc): string {
  const t = shiftTimes(s);
  const hours = t.startMs !== null && t.endMs !== null && t.endMs > t.startMs ? (t.endMs - t.startMs) / 3_600_000 : 0;
  const rate = Number(s.rate) || 0;
  const bits = [
    t.startMs !== null ? shortDate(t.startMs) : fmtDay(String(s.date ?? "")),
    `${t.actual ? "In" : "Sched in"} ${t.startMs !== null ? clock(t.startMs) : "—"}`,
    `${t.actual ? "Out" : "Sched out"} ${t.endMs !== null ? clock(t.endMs) : "—"}`,
    hours > 0 ? dur(hours) : "—",
    hours > 0 && rate > 0 ? `Est. pay ${money(hours * rate)}` : "Est. pay —",
    "Card",
    s.loggedManually === true ? "Logged" : "",
    "Not submitted",
  ].filter(Boolean);
  return `${n}. ${bits.join(" · ")}`;
}
export function unsubmittedText(shifts: SubmittableShift[]): { text: string; items: ListItem[] } {
  if (shifts.length === 0) return { text: EMPTY_UNSUBMITTED, items: [] };
  const items: ListItem[] = []; let n = 0;
  const blocks = groupByClient(shifts).map((g) => [
    `${g.name} · ${g.rows.length} shift${g.rows.length === 1 ? "" : "s"}`,
    ...g.rows.map((s) => { n++; items.push({ number: n, kind: "shift", id: s.id }); return unsubmittedRowLine(n, s); }),
  ].join("\n"));
  return { text: [`Timesheets · Unsubmitted (${shifts.length})`, "", blocks.join("\n\n"), "", "Reply SUBMIT n to submit a visit's hours, or VIEW n for the visit. PENDING or HISTORY for the other tabs."].join("\n"), items };
}

export function timesheetRowLine(n: number, r: TimesheetRow): string {
  const s = rowStart(r), e = rowEnd(r);
  const label = STATUS_LABEL[r.status] ?? r.status;
  const bits = [
    s !== null ? shortDate(s) : "—",
    s !== null && e !== null ? `${clock(s)} – ${clock(e)}` : "",
    dur(rowHours(r)),
    money(rowGross(r)),
    r.loggedManually === true ? "Logged" : "",
    isCorrected(r) && !PENDING_STATUSES.includes(r.status) ? "Corrected" : "",
    r.status === "correction_proposed" ? `${label} — reply REVIEW ${n}` : label,
  ].filter(Boolean);
  return `${n}. ${bits.join(" · ")}`;
}
export function pendingText(rows: TimesheetRow[]): { text: string; items: ListItem[] } {
  if (rows.length === 0) return { text: EMPTY_PENDING, items: [] };
  const items: ListItem[] = []; let n = 0;
  const blocks = groupByClient(rows).map((g) => [
    `${g.name} · ${g.rows.length} shift${g.rows.length === 1 ? "" : "s"}`,
    ...g.rows.map((r) => { n++; items.push({ number: n, kind: "timesheet", id: r.id, status: r.status }); return timesheetRowLine(n, r); }),
  ].join("\n"));
  const corrections = rows.filter((r) => r.status === "correction_proposed").length;
  const footer = [corrections > 0 ? `${corrections} correction${corrections === 1 ? " needs" : "s need"} your answer — reply REVIEW n.` : "", "Reply DETAILS n for the full card, or VIEW n for the visit."].filter(Boolean).join(" ");
  return { text: [`Timesheets · Pending (${rows.length})`, "", blocks.join("\n\n"), "", footer].join("\n"), items };
}
export function historyText(rows: TimesheetRow[], from = 0): { text: string; items: ListItem[]; shown: number; remaining: number } {
  if (rows.length === 0) return { text: EMPTY_HISTORY, items: [], shown: 0, remaining: 0 };
  const sorted = [...rows].sort((a, b) => (rowStart(b) ?? tsMs(b.submittedAt) ?? 0) - (rowStart(a) ?? tsMs(a.submittedAt) ?? 0));
  const page = sorted.slice(from, from + HISTORY_PAGE);
  const items: ListItem[] = []; let n = from;
  // The page's month groups (label + "n shifts · $total") — totals cover the whole month, rows are the ones on this text.
  const months = new Map<string, { label: string; all: TimesheetRow[]; here: TimesheetRow[] }>();
  for (const r of sorted) {
    const ms = rowStart(r) ?? tsMs(r.submittedAt) ?? 0;
    const key = localDay(ms).slice(0, 7);
    const m = months.get(key) ?? { label: monthLabel(ms), all: [], here: [] };
    m.all.push(r); if (page.includes(r)) m.here.push(r); months.set(key, m);
  }
  const blocks: string[] = [];
  for (const m of months.values()) {
    if (m.here.length === 0) continue;
    const lines = [`${m.label} · ${m.all.length} shift${m.all.length === 1 ? "" : "s"} · ${money(m.all.reduce((s, r) => s + rowGross(r), 0))}`];
    // Within the month the page groups by client (avatar, name, "n shifts").
    for (const g of groupByClient(m.here)) {
      lines.push(`${g.name} · ${g.rows.length} shift${g.rows.length === 1 ? "" : "s"}`);
      for (const r of g.rows) { n++; items.push({ number: n, kind: "timesheet", id: r.id, status: r.status }); lines.push(timesheetRowLine(n, r)); }
    }
    blocks.push(lines.join("\n"));
  }
  const remaining = Math.max(0, sorted.length - (from + page.length));
  const footer = [remaining > 0 ? `Reply MORE for ${remaining} older.` : "", "Reply DETAILS n for the full card, VIEW n for the visit, or REPORT for totals (e.g. REPORT Sep 1 to Sep 30)."].filter(Boolean).join(" ");
  return { text: [from === 0 ? `Timesheets · History (${rows.length})` : "More history:", "", blocks.join("\n\n"), "", footer].join("\n"), items, shown: page.length, remaining };
}

/** The History chip's Report panel: the page's date filter + Shifts / Total hours / Total earnings. */
export function reportText(history: TimesheetRow[], range: { from?: string; to?: string } = {}): string {
  const rows = history.filter((r) => {
    if (!range.from && !range.to) return true;
    const raw = rowStart(r) ?? tsMs(r.submittedAt);
    if (raw === null) return false;
    const d = localDay(raw);
    if (range.from && d < range.from) return false;
    if (range.to && d > range.to) return false;
    return true;
  });
  const title = range.from || range.to ? `Report · ${range.from ? fmtDay(range.from) : "start"} – ${range.to ? fmtDay(range.to) : "today"}` : "Report · All history";
  if (rows.length === 0) return [title, "", EMPTY_REPORT].join("\n");
  const hours = rows.reduce((s, r) => s + rowHours(r), 0);
  const pay = rows.reduce((s, r) => s + rowGross(r), 0);
  return [title, `Shifts ${rows.length}`, `Total hours ${dur(hours)}`, `Total earnings ${money(pay)}`, "", `The CSV export is on your Payments page: ${getAppUrl()}/caregiver/payments?tab=timesheets`].join("\n");
}

/** The expanded card (Pending or History row), the History timeline included. */
export function timesheetDetailText(r: TimesheetRow, n?: number): string {
  const s = rowStart(r), e = rowEnd(r);
  const rate = Number(r.payRate) || 0;
  const hours = rowHours(r);
  const lis = items(r.lineItems);
  const base = typeof r.basePay === "number" ? r.basePay : round2(hours * rate);
  const gross = rowGross(r);
  const head = [String(r.clientName || "Client"), s !== null ? shortDate(s) : "", STATUS_LABEL[r.status] ?? r.status, isCorrected(r) && !PENDING_STATUSES.includes(r.status) ? "Corrected" : ""].filter(Boolean).join(" · ");
  const lines = [head];
  if (rate > 0) lines.push(`Rate $${rate}/hr`);
  if (s !== null && e !== null) lines.push(`${r.loggedManually === true ? "Reported in / out" : "Clock in / out"} ${dateTime(s)} – ${dateTime(e)}`);
  lines.push(`Total hours ${dur(hours)}`);
  if (lis.length > 0) {
    lines.push(`Base pay ${money(base)}`);
    for (const li of lis) lines.push(`${itemLabel(li)}${li.note ? ` · ${li.note}` : ""} +${money(Number(li.amount) || 0)}`);
    lines.push(`Total ${money(gross)}`);
  } else lines.push(`Gross pay ${money(gross)}`);
  if (r.status === "pending_client_review" || r.status === "payment_failed") {
    const auto = tsMs(r.autoApproveAt);
    lines.push(`Auto-approves ${auto !== null ? stampShort(auto) : r.status === "pending_client_review" ? "No — needs the family's approval" : "—"}`);
  }
  if (!PENDING_STATUSES.includes(r.status)) { const sub = tsMs(r.submittedAt); if (sub !== null) lines.push(`Submitted ${longDate(sub)}`); }
  if (r.status === "payment_failed" && typeof r.stripeFailureReason === "string" && r.stripeFailureReason) lines.push(`⚠ ${r.stripeFailureReason}`);
  const hist = items(r.correctionHistory) as Array<{ action?: string; at?: string; startTime?: string; endTime?: string; hours?: number; basePay?: number; grossPay?: number; note?: string; lineItems?: unknown }>;
  // The page: a counter / correction row shows the timeline whenever it has entries; every other row only once
  // something beyond the submission happened — and then it lists ALL entries, the submission included.
  const showTimeline = hist.length > 0 && ((r.status === "caregiver_counter_proposed" || r.status === "correction_proposed") || hist.some((h) => h.action !== "submitted"));
  if (showTimeline) {
    lines.push("", "History");
    for (const h of hist) {
      const at = tsMs(h.at);
      const bits = [`${HISTORY_ACTION_LABEL[String(h.action)] ?? String(h.action)}${at !== null ? ` — ${stampShort(at)}` : ""}`];
      const hs = tsMs(h.startTime), he = tsMs(h.endTime);
      if (hs !== null && he !== null && typeof h.hours === "number") {
        const hBase = typeof h.basePay === "number" ? h.basePay : h.action === "submitted" ? base : round2(h.hours * rate);
        const hItems = items(h.action === "submitted" ? (h.lineItems ?? r.lineItems) : h.lineItems);
        const hGross = typeof h.grossPay === "number" ? h.grossPay : h.action === "submitted" ? gross : round2(hBase + hItems.reduce((t, li) => t + (Number(li.amount) || 0), 0));
        bits.push(`${clockShort(hs)} – ${clockShort(he)} · ${dur(h.hours)}`, `$${rate}/hr · Base ${money(hBase)}`, ...hItems.map((li) => `${itemLabel(li)} +${money(Number(li.amount) || 0)}`), `Total ${money(hGross)}`);
      }
      if (h.note) bits.push(`"${h.note}"`);
      lines.push(`• ${bits.join(" · ")}`);
    }
  }
  lines.push("", r.status === "correction_proposed" ? `Reply REVIEW${n ? ` ${n}` : ""} to accept the correction or send a counter.` : `Reply VIEW${n ? ` ${n}` : ""} for the visit.`);
  return lines.join("\n");
}

/** The expanded Unsubmitted card: rate, the scheduled window, the clock stamps, who was cared for, the two buttons as reply words. */
export function unsubmittedDetailText(s: SubmittableShift, n?: number): string {
  const t = shiftTimes(s);
  const rate = Number(s.rate) || 0;
  const lines = [`${String(s.clientName || "Client")} · ${t.startMs !== null ? shortDate(t.startMs) : fmtDay(String(s.date ?? ""))} · Not submitted${s.loggedManually === true ? " · Logged" : ""}`];
  if (rate > 0) lines.push(`Rate $${rate}/hr`);
  if (Number.isFinite(t.scheduledStartMs) && Number.isFinite(t.scheduledEndMs)) lines.push(`Scheduled ${shortDate(t.scheduledStartMs)} · ${clock(t.scheduledStartMs)}–${clock(t.scheduledEndMs)}`);
  if (t.actual && t.startMs !== null && t.endMs !== null) {
    const logged = s.loggedManually === true;
    lines.push(`${logged ? "Reported in" : "Clock in"} ${dateTime(t.startMs)}`, `${logged ? "Reported out" : "Clock out"} ${dateTime(t.endMs)}`, `Duration ${dur((t.endMs - t.startMs) / 3_600_000)}`);
    if (rate > 0) lines.push(`Est. pay ${money(((t.endMs - t.startMs) / 3_600_000) * rate)}`);
  }
  const recipients = (Array.isArray(s.careRecipients) ? s.careRecipients : []) as Array<{ name?: string } | string>;
  const names = recipients.map((r) => (typeof r === "string" ? r : r.name)).filter((x): x is string => !!x);
  if (names.length > 0) lines.push(`${names.length === 1 ? "Recipient" : "Recipients"} ${names.join(", ")}`);
  lines.push("", `Reply SUBMIT${n ? ` ${n}` : ""} to submit hours, or VIEW${n ? ` ${n}` : ""} for the visit.`);
  return lines.join("\n");
}

// ── send + resolve ──────────────────────────────────────────────────────────
export async function sendCaregiverTimesheets(phone: string, chatId: string, caregiverId: string, chip: Chip, opts: { more?: boolean } = {}) {
  const tab = await loadTimesheetsTab(caregiverId);
  let from = 0;
  if (chip === "history" && opts.more) {
    const s = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    const prev = s?.data()?.lastTimesheetList as LastTimesheetList | undefined;
    if (prev?.chip === "history") from = Number(prev.offset ?? 0);
  }
  const r = chip === "unsubmitted" ? { ...unsubmittedText(tab.submittable), shown: tab.submittable.length, remaining: 0 }
    : chip === "pending" ? { ...pendingText(tab.pending), shown: tab.pending.length, remaining: 0 }
    : historyText(tab.history, from);
  await sendMessage(chatId, r.text);
  const list: LastTimesheetList = { at: new Date().toISOString(), chip, items: r.items, offset: from + r.shown, total: chip === "unsubmitted" ? tab.submittable.length : chip === "pending" ? tab.pending.length : tab.history.length };
  await db.collection("agent_sessions").doc(phone).set({ lastTimesheetList: list }, { merge: true }).catch(() => {});
  return { sent: true, chip, count: r.shown, remaining: r.remaining, items: r.items, badge: tab.submittable.length + tab.corrections.length };
}

/** SUBMIT n / REVIEW n / DETAILS n / VIEW n → the document the last texted list named. */
export function resolveTimesheetRef(session: Record<string, unknown>, ref: { number?: unknown; id?: unknown }): ListItem | null {
  if (typeof ref.id === "string" && ref.id) return { number: 0, kind: "timesheet", id: ref.id };
  const list = session.lastTimesheetList as LastTimesheetList | undefined;
  const n = Number(ref.number);
  const it = list?.items.find((x) => x.number === n);
  return it ?? null;
}

export async function sendTimesheetDetail(chatId: string, caregiverId: string, ref: ListItem): Promise<boolean> {
  if (ref.kind === "shift") {
    const snap = await db.collection("shifts").doc(ref.id).get();
    if (!snap.exists || snap.data()?.caregiverId !== caregiverId) { await sendMessage(chatId, "That visit isn't on your Timesheets tab."); return false; }
    await sendMessage(chatId, unsubmittedDetailText({ ...(snap.data() as Doc), id: snap.id }, ref.number || undefined));
    return true;
  }
  const snap = await db.collection("shiftHours").doc(ref.id).get();
  if (!snap.exists || snap.data()?.caregiverId !== caregiverId) { await sendMessage(chatId, "That timesheet isn't on your Timesheets tab."); return false; }
  await sendMessage(chatId, timesheetDetailText({ ...(snap.data() as Doc), id: snap.id, status: String(snap.data()?.status ?? "") }, ref.number || undefined));
  return true;
}
/** VIEW n → the "View shift" modal (the visit's tasks and notes). */
export async function sendTimesheetVisit(chatId: string, caregiverId: string, ref: ListItem): Promise<boolean> {
  let shiftId = ref.id;
  if (ref.kind === "timesheet") {
    const snap = await db.collection("shiftHours").doc(ref.id).get();
    if (!snap.exists || snap.data()?.caregiverId !== caregiverId) { await sendMessage(chatId, "That timesheet isn't on your Timesheets tab."); return false; }
    shiftId = String(snap.data()?.shiftId ?? snap.data()?.appointmentId ?? ref.id);
  }
  const snap = await db.collection("shifts").doc(shiftId).get();
  if (!snap.exists || snap.data()?.caregiverId !== caregiverId) { await sendMessage(chatId, "Shift not found."); return false; }
  await sendMessage(chatId, visitDetailText({ ...(snap.data() as Doc), id: snap.id, date: String(snap.data()?.date ?? ""), status: String(snap.data()?.status ?? "") } as PastShift));
  return true;
}

// ── Submit hours worked — the modal as a scripted flow ──────────────────────
export interface SubmitHoursFlowData {
  shiftId: string; clientName: string; date: string;
  startIso: string; endIso: string; totalHours: number; rate: number;
  scheduledStartMs: number | null; scheduledEndMs: number | null;
  items: Array<{ type: "custom"; label: string; amount: number; note?: string }>;
}
const modalHeader = (d: SubmitHoursFlowData) => `Submit hours worked — ${d.clientName} · ${shortDate(Date.parse(d.startIso))}`;
const basePayLine = (d: SubmitHoursFlowData) => `Base pay (${dur(d.totalHours)} @ $${d.rate}/hr) ${money(d.totalHours * d.rate)}`;
const ITEMS_Q = (d: SubmitHoursFlowData) => [
  modalHeader(d),
  `Clock in ${clock(Date.parse(d.startIso))}, ${shortDate(Date.parse(d.startIso))}`,
  `Clock out ${clock(Date.parse(d.endIso))}, ${shortDate(Date.parse(d.endIso))}`,
  `Duration ${dur(d.totalHours)}`,
  d.rate > 0 ? basePayLine(d) : null,
  "",
  `Any additional charges (overtime, mileage, supplies)? Reply one like "Mileage 12.50" (add a note after a dash: "Mileage 12.50 - 20 miles"), or NONE.`,
].filter((l) => l !== null).join("\n");
const ANOTHER_Q = (li: { label: string; amount: number }) => `Added ${li.label} · ${money(li.amount)}. Another charge? Reply it, or DONE.`;
/** The modal's payment note — its exact two sentences, its exact reason. */
export function approvalNote(d: SubmitHoursFlowData): string {
  const hasItems = d.items.some((li) => li.amount > 0);
  const s = Date.parse(d.startIso), e = Date.parse(d.endIso);
  const outside = d.scheduledStartMs !== null && d.scheduledEndMs !== null && Number.isFinite(s) && Number.isFinite(e)
    && (s < d.scheduledStartMs - SCHEDULE_GRACE_MS || e > d.scheduledEndMs + SCHEDULE_GRACE_MS);
  const total = d.totalHours * d.rate + d.items.reduce((t, li) => t + li.amount, 0);
  const over = total > EXPLICIT_APPROVAL_THRESHOLD_DOLLARS;
  if (hasItems || outside || over) {
    const reason = hasItems ? "submissions with extra charges" : outside ? "hours that don't match the scheduled time" : `totals over $${EXPLICIT_APPROVAL_THRESHOLD_DOLLARS}`;
    return `Payment method: Card. The client needs to review and approve this manually — there's no automatic approval for ${reason}.`;
  }
  return "Payment method: Card. Client has 24 hours to approve or propose a correction. After that, hours auto-approve and Stripe processes payment.";
}
const SUBMIT_CONFIRM_Q = (d: SubmitHoursFlowData) => {
  const base = d.totalHours * d.rate;
  const itemsTotal = d.items.reduce((t, li) => t + li.amount, 0);
  return [
    modalHeader(d),
    d.rate > 0 ? basePayLine(d) : `Duration ${dur(d.totalHours)}`,
    ...d.items.map((li) => `${li.label}${li.note ? ` · ${li.note}` : ""} ${money(li.amount)}`),
    d.items.length > 0 ? `Total ${money(base + itemsTotal)}` : null,
    "",
    approvalNote(d),
    "",
    "Reply SUBMIT to submit, or CANCEL.",
  ].filter((l) => l !== null).join("\n");
};

async function parse(prompt: string, text: string): Promise<string> {
  return quickComplete(prompt + "\nReply with ONLY the requested value — no explanation.", text, { maxTokens: 80 }).catch(() => "__parse_error__");
}
/** One additional charge from free text → {label, amount, note} | NONE | DONE | INVALID (missing amount / label). */
export async function parseCharge(text: string): Promise<{ kind: "none" } | { kind: "item"; label: string; amount: number; note?: string } | { kind: "no_amount" } | { kind: "no_label" } | null> {
  const norm = text.trim().toUpperCase();
  if (norm === "NONE" || norm === "NO" || norm === "DONE" || norm === "SKIP") return { kind: "none" };
  const raw = await parse(`The caregiver is naming ONE additional charge for a completed visit (overtime, mileage, supplies, a bonus, or anything custom) with a dollar amount and an optional note. Reply JSON {"label": string, "amount": number, "note": string|null}. Use null for a missing label or a missing/zero amount. If they are saying there are no charges, reply NONE.`, text);
  if (raw.trim().toUpperCase().startsWith("NONE")) return { kind: "none" };
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { label?: unknown; amount?: unknown; note?: unknown };
    const amount = round2(Number(j.amount));
    const label = typeof j.label === "string" ? j.label.trim() : "";
    if (!(amount > 0)) return { kind: "no_amount" };
    if (!label) return { kind: "no_label" };
    return { kind: "item", label: label.slice(0, 100), amount, note: typeof j.note === "string" && j.note.trim() ? j.note.trim().slice(0, 500) : undefined };
  } catch { return null; }
}

export async function startSubmitHoursFlow(phone: string, chatId: string, _session: AgentSession, args: { caregiverId: string; shiftId: string }): Promise<{ started: boolean; reason?: string }> {
  const snap = await db.collection("shifts").doc(args.shiftId).get();
  const shift = snap.data() as Doc | undefined;
  if (!snap.exists || !shift || shift.caregiverId !== args.caregiverId) { await sendMessage(chatId, "That visit isn't on your Timesheets tab."); return { started: false, reason: "not_found" }; }
  if (shift.status !== "completed") { await sendMessage(chatId, `That visit is ${String(shift.status)} — hours can only be submitted for a completed visit.`); return { started: false, reason: "not_completed" }; }
  const existing = await db.collection("shiftHours").doc(String(shift.appointmentId || snap.id)).get();
  if (existing.exists) { await sendMessage(chatId, `Hours for that visit were already submitted — it's ${STATUS_LABEL[String(existing.data()?.status)] ?? String(existing.data()?.status)}. Reply PENDING or HISTORY to see it.`); return { started: false, reason: "already_submitted" }; }
  const t = shiftTimes(shift);
  if (t.startMs === null || t.endMs === null || t.endMs <= t.startMs) { await sendMessage(chatId, "End time must be after start time."); return { started: false, reason: "bad_times" }; }
  const data: SubmitHoursFlowData = {
    shiftId: snap.id, clientName: String(shift.clientName || "the family"), date: String(shift.date ?? localDay(t.startMs)),
    startIso: new Date(t.startMs).toISOString(), endIso: new Date(t.endMs).toISOString(),
    totalHours: (t.endMs - t.startMs) / 3_600_000, rate: Number(shift.rate) || 0,
    scheduledStartMs: Number.isFinite(t.scheduledStartMs) ? t.scheduledStartMs : null, scheduledEndMs: Number.isFinite(t.scheduledEndMs) ? t.scheduledEndMs : null,
    items: [],
  };
  await db.collection("agent_sessions").doc(phone).update({ submitHoursFlowStep: "sh_items", submitHoursFlowData: data, stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() });
  await sendMessage(chatId, ITEMS_Q(data));
  return { started: true };
}

export async function handleSubmitHoursFlowStep(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const step = (session as unknown as Record<string, unknown>).submitHoursFlowStep as string;
  const data = (((session as unknown as Record<string, unknown>).submitHoursFlowData ?? {}) as SubmitHoursFlowData);
  const ref = db.collection("agent_sessions").doc(phone);
  const clear = () => ref.update({ submitHoursFlowStep: admin.firestore.FieldValue.delete(), submitHoursFlowData: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete() });
  const cancelled = async () => { await clear(); await sendMessage(chatId, "Okay — nothing was submitted. The visit still shows under Unsubmitted."); };
  const next = async (patch: Partial<SubmitHoursFlowData>, stepName: string, question: string) => {
    await ref.update({ submitHoursFlowStep: stepName, submitHoursFlowData: { ...data, ...patch } });
    await sendMessage(chatId, question);
  };

  if (step === "sh_items") {
    const q = data.items.length === 0 ? ITEMS_Q(data) : ANOTHER_Q(data.items[data.items.length - 1]);
    if (text.trim().toUpperCase() === "CANCEL" || await isBackOutRequest(text, q)) return cancelled();
    const parsed = await parseCharge(text);
    if (parsed === null || parsed.kind === "no_amount" || parsed.kind === "no_label") {
      if (parsed === null && await isQuestionOrOther(text, q)) { await sendMessage(chatId, await answerMidFlow(text, q)); return; }
      // The modal's own validation messages.
      const msg = parsed?.kind === "no_amount" ? "Please enter an amount for each additional charge." : parsed?.kind === "no_label" ? "Please enter a label for each Custom charge." : DIDNT_CATCH;
      await sendMessage(chatId, `${msg} ${q}`); return;
    }
    if (parsed.kind === "none") return next({}, "sh_confirm", SUBMIT_CONFIRM_Q(data));
    const items = [...data.items, { type: "custom" as const, label: parsed.label, amount: parsed.amount, ...(parsed.note ? { note: parsed.note } : {}) }];
    return next({ items }, "sh_items", ANOTHER_Q(items[items.length - 1]));
  }
  if (step === "sh_confirm") {
    const q = SUBMIT_CONFIRM_Q(data);
    const norm = text.trim().toUpperCase();
    let action: "submit" | "cancel" | "other";
    if (norm === "SUBMIT" || norm === "SUBMIT HOURS" || norm === "CONFIRM" || norm === "YES" || norm === "SEND") action = "submit";
    else if (norm === "CANCEL" || norm === "NO") action = "cancel";
    else if (await isBackOutRequest(text, q)) action = "cancel";
    else {
      const v = await parse("Evia asked the caregiver to reply SUBMIT to submit the hours, or CANCEL. Classify: SUBMIT, CANCEL, or OTHER (a question / a change).", text);
      action = v.toUpperCase().startsWith("SUBMIT") ? "submit" : v.toUpperCase().startsWith("CANCEL") ? "cancel" : "other";
    }
    if (action === "cancel") return cancelled();
    if (action === "other") {
      if (await isQuestionOrOther(text, q)) await sendMessage(chatId, await answerMidFlow(text, q));
      else await sendMessage(chatId, `${DIDNT_CATCH} ${q}`);
      return;
    }
    await clear();
    const sess = (await ref.get().catch(() => null))?.data() as Record<string, unknown> | undefined;
    const caregiverId = String(sess?.caregiverId ?? (session as unknown as Record<string, unknown>).caregiverId ?? "");
    // The modal's write: the site's own server function, same fields, same validation.
    const { submitShiftHoursAs } = await import("../shiftHours");
    try {
      await submitShiftHoursAs(caregiverId, { shiftId: data.shiftId, startTime: data.startIso, endTime: data.endIso, lineItems: data.items.filter((li) => li.amount > 0) });
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "Failed to submit hours";
      await sendMessage(chatId, msg); // the page's error toast
      return;
    }
    await sendMessage(chatId, "Hours submitted — awaiting client approval"); // the page's toast
    return;
  }
  await clear();
}

// ── Review correction — the modal as a scripted flow ────────────────────────
export interface ReviewCorrectionFlowData {
  appointmentId: string; clientName: string; payRate: number;
  proposedStart: string; proposedEnd: string; proposedHours: number; proposedGross: number;
  proposedItems: Array<{ type?: string; label?: string; note?: string; amount?: number }>;
  reason: string | null;
  counterStart?: string; counterEnd?: string;
  counterItems?: Array<{ type?: string; label?: string; note?: string; amount?: number }>;
  note?: string;
}
const proposedBlock = (d: ReviewCorrectionFlowData) => {
  const s = Date.parse(d.proposedStart), e = Date.parse(d.proposedEnd);
  const base = round2(d.proposedHours * d.payRate);
  return [
    `Review correction — ${d.clientName}`,
    `Client proposed: ${clock(s)} – ${clock(e)} · ${dur(d.proposedHours)}`,
    `$${d.payRate}/hr · Base ${money(base)}`,
    ...d.proposedItems.map((li) => `${itemLabel(li)} +${money(Number(li.amount) || 0)}`),
    `Total ${money(d.proposedGross)}`,
    d.reason ? `"${d.reason}"` : null,
  ].filter((l) => l !== null).join("\n");
};
const CHOICE_Q = (d: ReviewCorrectionFlowData) => `${proposedBlock(d)}\n\nReply ACCEPT to accept ${money(d.proposedGross)}, or COUNTER to send a counter.`;
const C_START_Q = (d: ReviewCorrectionFlowData) => `Counter start — reply a time like 2:05 PM, or KEEP for ${clockShort(Date.parse(d.proposedStart))}.`;
const C_END_Q = (d: ReviewCorrectionFlowData) => `Counter end — reply a time, or KEEP for ${clockShort(Date.parse(d.proposedEnd))}.`;
const C_ITEMS_Q = (d: ReviewCorrectionFlowData) => `Additional charges: ${d.proposedItems.map((li) => `${itemLabel(li)} ${money(Number(li.amount) || 0)}`).join(", ")}. Reply a new amount for any of them, like "Mileage 10", or KEEP.`;
const C_NOTE_Q = "Note (optional) — why do you disagree? Reply the note, or SKIP.";
function counterGross(d: ReviewCorrectionFlowData): { hours: number; base: number; gross: number } {
  const s = Date.parse(d.counterStart ?? ""), e = Date.parse(d.counterEnd ?? "");
  const hours = Number.isFinite(s) && Number.isFinite(e) && e > s ? (e - s) / 3_600_000 : 0;
  const base = round2(hours * d.payRate);
  const itemsTotal = (d.counterItems ?? d.proposedItems).reduce((t, li) => t + (Number(li.amount) || 0), 0);
  return { hours, base, gross: round2(base + itemsTotal) };
}
const C_CONFIRM_Q = (d: ReviewCorrectionFlowData) => {
  const g = counterGross(d);
  return [
    `Your counter — ${d.clientName}`,
    `${clock(Date.parse(d.counterStart ?? ""))} – ${clock(Date.parse(d.counterEnd ?? ""))} · ${dur(g.hours)}`,
    `$${d.payRate}/hr · Base ${money(g.base)}`,
    ...(d.counterItems ?? d.proposedItems).map((li) => `${itemLabel(li)} +${money(Number(li.amount) || 0)}`),
    `Your total ${money(g.gross)}`,
    d.note ? `Note: "${d.note}"` : null,
    "",
    "Reply SEND to send the counter, or CANCEL.",
  ].filter((l) => l !== null).join("\n");
};
/** "2:05 pm" / "14:05" / "KEEP" → an ISO instant on the proposed day (Pacific); an explicit date is honoured. */
async function parseCounterTime(text: string, keepIso: string): Promise<string | null> {
  const norm = text.trim().toUpperCase();
  if (norm === "KEEP" || norm === "SAME") return keepIso;
  const raw = await parse(`Today is ${businessTodayStr()} (Pacific). The caregiver is naming the ACTUAL clock time of a visit that already happened. Reply "YYYY-MM-DD HH:MM" (24-hour) when they gave a date too, otherwise "HH:MM" alone. Reply NONE if no time is given.`, text);
  const dt = /(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/.exec(raw);
  const day = dt ? dt[1] : localDay(Date.parse(keepIso));
  const t = dt ? { h: dt[2], m: dt[3] } : (() => { const x = /(\d{1,2}):(\d{2})/.exec(raw); return x ? { h: x[1], m: x[2] } : null; })();
  if (!t) return null;
  const ms = parseScheduledTimeMs(`${day}T${t.h.padStart(2, "0")}:${t.m}:00`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export async function startReviewCorrectionFlow(phone: string, chatId: string, _session: AgentSession, args: { caregiverId: string; appointmentId: string }): Promise<{ started: boolean; reason?: string }> {
  const snap = await db.collection("shiftHours").doc(args.appointmentId).get();
  const row = snap.data() as Doc | undefined;
  if (!snap.exists || !row || row.caregiverId !== args.caregiverId) { await sendMessage(chatId, "That timesheet isn't on your Timesheets tab."); return { started: false, reason: "not_found" }; }
  if (row.status !== "correction_proposed") { await sendMessage(chatId, `That timesheet is ${STATUS_LABEL[String(row.status)] ?? String(row.status)} — Review & Respond is only for a correction the family sent.`); return { started: false, reason: "not_correction" }; }
  const proposedItems = items(row.proposedLineItems ?? row.lineItems);
  const payRate = Number(row.payRate) || 0;
  const hours = Number(row.proposedTotalHours) || (Date.parse(String(row.proposedEndTime)) - Date.parse(String(row.proposedStartTime))) / 3_600_000;
  const gross = typeof row.proposedGrossPay === "number" ? row.proposedGrossPay : round2(hours * payRate + proposedItems.reduce((t, li) => t + (Number(li.amount) || 0), 0));
  const data: ReviewCorrectionFlowData = {
    appointmentId: snap.id, clientName: String(row.clientName || "the family"), payRate,
    proposedStart: String(row.proposedStartTime), proposedEnd: String(row.proposedEndTime), proposedHours: hours, proposedGross: gross,
    proposedItems, reason: typeof row.proposalReason === "string" && row.proposalReason ? row.proposalReason : null,
  };
  await db.collection("agent_sessions").doc(phone).update({ reviewCorrectionFlowStep: "rc_choice", reviewCorrectionFlowData: data, stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() });
  await sendMessage(chatId, CHOICE_Q(data));
  return { started: true };
}

export async function handleReviewCorrectionFlowStep(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const step = (session as unknown as Record<string, unknown>).reviewCorrectionFlowStep as string;
  const data = (((session as unknown as Record<string, unknown>).reviewCorrectionFlowData ?? {}) as ReviewCorrectionFlowData);
  const ref = db.collection("agent_sessions").doc(phone);
  const clear = () => ref.update({ reviewCorrectionFlowStep: admin.firestore.FieldValue.delete(), reviewCorrectionFlowData: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete() });
  const cancelled = async () => { await clear(); await sendMessage(chatId, "Okay — nothing was sent. The correction is still waiting for your answer under Pending."); };
  const next = async (patch: Partial<ReviewCorrectionFlowData>, stepName: string, question: string) => {
    await ref.update({ reviewCorrectionFlowStep: stepName, reviewCorrectionFlowData: { ...data, ...patch } });
    await sendMessage(chatId, question);
  };
  const caregiverId = async () => {
    const sess = (await ref.get().catch(() => null))?.data() as Record<string, unknown> | undefined;
    return String(sess?.caregiverId ?? (session as unknown as Record<string, unknown>).caregiverId ?? "");
  };
  const norm = text.trim().toUpperCase();

  if (step === "rc_choice") {
    const q = CHOICE_Q(data);
    let action: "accept" | "counter" | "cancel" | "other";
    if (norm === "ACCEPT" || norm === "YES") action = "accept";
    else if (norm === "COUNTER" || norm === "SEND COUNTER" || norm === "NO") action = "counter";
    else if (norm === "CANCEL") action = "cancel";
    else if (await isBackOutRequest(text, q)) action = "cancel";
    else {
      const v = await parse("Evia asked the caregiver to reply ACCEPT (accept the family's corrected hours) or COUNTER (send different hours back). Classify: ACCEPT, COUNTER, CANCEL, or OTHER (a question).", text);
      action = v.toUpperCase().startsWith("ACCEPT") ? "accept" : v.toUpperCase().startsWith("COUNTER") ? "counter" : v.toUpperCase().startsWith("CANCEL") ? "cancel" : "other";
    }
    if (action === "cancel") return cancelled();
    if (action === "other") {
      if (await isQuestionOrOther(text, q)) await sendMessage(chatId, await answerMidFlow(text, q));
      else await sendMessage(chatId, `${DIDNT_CATCH} ${q}`);
      return;
    }
    if (action === "counter") return next({}, "rc_start", C_START_Q(data));
    await clear();
    const { respondToCorrectionAs } = await import("../shiftHours");
    try { await respondToCorrectionAs(await caregiverId(), { appointmentId: data.appointmentId, action: "accept" }); }
    catch (err) { await sendMessage(chatId, err instanceof Error && err.message ? err.message : "Failed to respond"); return; }
    await sendMessage(chatId, "Correction accepted"); // the page's toast
    return;
  }
  if (step === "rc_start") {
    const q = C_START_Q(data);
    if (norm === "CANCEL" || await isBackOutRequest(text, q)) return cancelled();
    if (await isQuestionOrOther(text, q)) { await sendMessage(chatId, await answerMidFlow(text, q)); return; }
    const iso = await parseCounterTime(text, data.proposedStart);
    if (!iso) { await sendMessage(chatId, `${DIDNT_CATCH} ${q}`); return; }
    return next({ counterStart: iso }, "rc_end", C_END_Q(data));
  }
  if (step === "rc_end") {
    const q = C_END_Q(data);
    if (norm === "CANCEL" || await isBackOutRequest(text, q)) return cancelled();
    if (await isQuestionOrOther(text, q)) { await sendMessage(chatId, await answerMidFlow(text, q)); return; }
    const iso = await parseCounterTime(text, data.proposedEnd);
    if (!iso) { await sendMessage(chatId, `${DIDNT_CATCH} ${q}`); return; }
    if (Date.parse(iso) <= Date.parse(data.counterStart ?? "")) { await sendMessage(chatId, `The end has to be after the start (${clockShort(Date.parse(data.counterStart ?? ""))}). ${q}`); return; }
    if (data.proposedItems.length > 0) return next({ counterEnd: iso }, "rc_items", C_ITEMS_Q(data));
    return next({ counterEnd: iso, counterItems: [] }, "rc_note", C_NOTE_Q);
  }
  if (step === "rc_items") {
    const q = C_ITEMS_Q(data);
    if (norm === "CANCEL" || await isBackOutRequest(text, q)) return cancelled();
    if (norm === "KEEP" || norm === "SAME" || norm === "SKIP") return next({ counterItems: data.proposedItems }, "rc_note", C_NOTE_Q);
    if (await isQuestionOrOther(text, q)) { await sendMessage(chatId, await answerMidFlow(text, q)); return; }
    // The modal lets only the AMOUNTS change (no add, no remove).
    const raw = await parse(`The existing charges are: ${data.proposedItems.map((li, i) => `${i + 1}. ${itemLabel(li)} $${Number(li.amount) || 0}`).join("; ")}. The caregiver is giving a new dollar amount for one or more of them. Reply JSON {"<index>": <amount>, ...} using the 1-based index. Reply NONE if no amount is given.`, text);
    let patch: Record<string, number> = {};
    try { patch = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { patch = {}; }
    const entries = Object.entries(patch).filter(([k, v]) => Number(k) >= 1 && Number(k) <= data.proposedItems.length && Number(v) >= 0);
    if (entries.length === 0) { await sendMessage(chatId, `${DIDNT_CATCH} ${q}`); return; }
    const counterItems = data.proposedItems.map((li, i) => { const hit = entries.find(([k]) => Number(k) === i + 1); return hit ? { ...li, amount: round2(Number(hit[1])) } : li; });
    return next({ counterItems }, "rc_note", C_NOTE_Q);
  }
  if (step === "rc_note") {
    if (norm === "CANCEL" || await isBackOutRequest(text, C_NOTE_Q)) return cancelled();
    if (norm === "SKIP" || norm === "NONE" || norm === "NO") return next({}, "rc_confirm", C_CONFIRM_Q(data));
    return next({ note: text.trim().slice(0, 500) }, "rc_confirm", C_CONFIRM_Q({ ...data, note: text.trim() }));
  }
  if (step === "rc_confirm") {
    const q = C_CONFIRM_Q(data);
    let action: "send" | "cancel" | "other";
    if (norm === "SEND" || norm === "SEND COUNTER" || norm === "CONFIRM" || norm === "YES") action = "send";
    else if (norm === "CANCEL" || norm === "NO") action = "cancel";
    else if (await isBackOutRequest(text, q)) action = "cancel";
    else {
      const v = await parse("Evia asked the caregiver to reply SEND to send the counter-proposal, or CANCEL. Classify: SEND, CANCEL, or OTHER.", text);
      action = v.toUpperCase().startsWith("SEND") ? "send" : v.toUpperCase().startsWith("CANCEL") ? "cancel" : "other";
    }
    if (action === "cancel") return cancelled();
    if (action === "other") {
      if (await isQuestionOrOther(text, q)) await sendMessage(chatId, await answerMidFlow(text, q));
      else await sendMessage(chatId, `${DIDNT_CATCH} ${q}`);
      return;
    }
    await clear();
    const { respondToCorrectionAs } = await import("../shiftHours");
    try {
      await respondToCorrectionAs(await caregiverId(), {
        appointmentId: data.appointmentId, action: "counter_propose",
        counterStartTime: data.counterStart, counterEndTime: data.counterEnd,
        counterNote: data.note || undefined,
        counterLineItems: data.proposedItems.length > 0 ? (data.counterItems ?? data.proposedItems) : undefined,
      });
    } catch (err) { await sendMessage(chatId, err instanceof Error && err.message ? err.message : "Failed to respond"); return; }
    await sendMessage(chatId, "Counter-proposal sent to client"); // the page's toast
    return;
  }
  await clear();
}

// ── Keywords (routeCaregiver): TIMESHEETS · UNSUBMITTED · PENDING · HISTORY · REPORT · SUBMIT n · REVIEW n · DETAILS n · VIEW n ──
export async function handleTimesheetsKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const raw = text.trim(); const upper = raw.toUpperCase();
  const list = session.lastTimesheetList as LastTimesheetList | undefined;
  if (upper === "TIMESHEETS" || upper === "TIMESHEET" || upper === "HOURS" || upper === "MY HOURS" || upper === "UNSUBMITTED") { await sendCaregiverTimesheets(phone, chatId, caregiverId, "unsubmitted"); return "handled"; }
  if (upper === "PENDING" || upper === "PENDING HOURS") { await sendCaregiverTimesheets(phone, chatId, caregiverId, "pending"); return "handled"; }
  if (upper === "HISTORY" || upper === "TIMESHEET HISTORY") { await sendCaregiverTimesheets(phone, chatId, caregiverId, "history"); return "handled"; }
  if (upper === "MORE" && list?.chip === "history" && listIsLatest(session)) { await sendCaregiverTimesheets(phone, chatId, caregiverId, "history", { more: true }); return "handled"; }
  if (upper === "REPORT" || upper.startsWith("REPORT ")) {
    const tab = await loadTimesheetsTab(caregiverId);
    const range = upper === "REPORT" ? {} : await parseReportRange(raw.slice(6).trim());
    if (range === null) { await sendMessage(chatId, `${DIDNT_CATCH} Reply REPORT for all history, or a range like "REPORT Sep 1 to Sep 30".`); return "handled"; }
    await sendMessage(chatId, reportText(tab.history, range)); return "handled";
  }
  // Bare SUBMIT — one unsubmitted visit → straight into its modal; several → the tab, numbered.
  if (upper === "SUBMIT" || upper === "SUBMIT HOURS") {
    const tab = await loadTimesheetsTab(caregiverId);
    if (tab.submittable.length === 1) { await startSubmitHoursFlow(phone, chatId, session as unknown as AgentSession, { caregiverId, shiftId: tab.submittable[0].id }); return "handled"; }
    if (tab.submittable.length === 0) { await sendMessage(chatId, EMPTY_UNSUBMITTED); return "handled"; }
    await sendCaregiverTimesheets(phone, chatId, caregiverId, "unsubmitted");
    await sendMessage(chatId, "Which one? Reply SUBMIT with the visit's number.");
    return "handled";
  }
  const submit = /^SUBMIT\s+(\d+)$/i.exec(raw);
  if (submit) {
    const r = resolveTimesheetRef(session, { number: Number(submit[1]) });
    if (!r || r.kind !== "shift") { await sendMessage(chatId, `I don't have an unsubmitted visit ${submit[1]} on the last list — reply TIMESHEETS to see them.`); return "handled"; }
    await startSubmitHoursFlow(phone, chatId, session as unknown as AgentSession, { caregiverId, shiftId: r.id }); return "handled";
  }
  // Bare REVIEW — one correction waiting → its modal; several → Pending, numbered.
  if (upper === "REVIEW" || upper === "REVIEW CORRECTION") {
    const tab = await loadTimesheetsTab(caregiverId);
    if (tab.corrections.length === 1) { await startReviewCorrectionFlow(phone, chatId, session as unknown as AgentSession, { caregiverId, appointmentId: tab.corrections[0].id }); return "handled"; }
    if (tab.corrections.length === 0) { await sendMessage(chatId, "No corrections are waiting for your answer."); return "handled"; }
    await sendCaregiverTimesheets(phone, chatId, caregiverId, "pending");
    await sendMessage(chatId, "Which one? Reply REVIEW with its number.");
    return "handled";
  }
  const review = /^REVIEW\s+(\d+)$/i.exec(raw);
  if (review) {
    const r = resolveTimesheetRef(session, { number: Number(review[1]) });
    if (!r || r.kind !== "timesheet") { await sendMessage(chatId, `I don't have a timesheet ${review[1]} on the last list — reply PENDING to see them.`); return "handled"; }
    await startReviewCorrectionFlow(phone, chatId, session as unknown as AgentSession, { caregiverId, appointmentId: r.id }); return "handled";
  }
  const details = /^DETAILS\s+(\d+)$/i.exec(raw);
  if (details && list && listIsLatest(session)) {
    const r = resolveTimesheetRef(session, { number: Number(details[1]) });
    if (!r) { await sendMessage(chatId, `I don't have a ${details[1]} on the last list — reply TIMESHEETS, PENDING or HISTORY to see them.`); return "handled"; }
    await sendTimesheetDetail(chatId, caregiverId, r); return "handled";
  }
  const view = /^VIEW\s+(\d+)$/i.exec(raw);
  if (view && list && listIsLatest(session)) {
    const r = resolveTimesheetRef(session, { number: Number(view[1]) });
    if (!r) { await sendMessage(chatId, `I don't have a ${view[1]} on the last list — reply TIMESHEETS, PENDING or HISTORY to see them.`); return "handled"; }
    await sendTimesheetVisit(chatId, caregiverId, r); return "handled";
  }
  return "passthrough";
}

/** The Timesheets list owns MORE / DETAILS n / VIEW n only while it is the most recent numbered list texted. */
export function listIsLatest(session: Record<string, unknown>): boolean {
  const mine = tsMs((session.lastTimesheetList as LastTimesheetList | undefined)?.at) ?? 0;
  if (!mine) return false;
  for (const k of ["lastPastBookingList", "lastCalendarList", "lastFamilyList", "lastActiveBookingList", "lastBookingRequestList"]) {
    const other = tsMs((session[k] as { at?: string } | undefined)?.at) ?? 0;
    if (other > mine) return false;
  }
  return true;
}

/** "Sep 1 to Sep 30" / "last month" / "September" → {from, to} as YYYY-MM-DD (business timezone). */
export async function parseReportRange(text: string): Promise<{ from?: string; to?: string } | null> {
  const raw = await parse(`Today is ${businessTodayStr()} (Pacific). The caregiver is naming a DATE RANGE for an earnings report. Reply JSON {"from": "YYYY-MM-DD" | null, "to": "YYYY-MM-DD" | null}. A single month means its first and last day; "last month" / "this week" etc. are relative to today. Reply NONE if no range is given.`, text);
  if (raw.trim().toUpperCase().startsWith("NONE")) return null;
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { from?: unknown; to?: unknown };
    const ok = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const out: { from?: string; to?: string } = {};
    if (ok(j.from)) out.from = j.from; if (ok(j.to)) out.to = j.to;
    return out.from || out.to ? out : null;
  } catch { return null; }
}
