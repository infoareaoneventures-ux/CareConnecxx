// agents/caregiverActiveBookings.ts — the caregiver Bookings page's ACTIVE
// BOOKINGS tab (components/caregiver/CaregiverBookingsPage.tsx, 2026-09-28),
// texted. Same query, same grouping, same card, same rows:
//
//   shifts where caregiverId == me and status in scheduled / in-progress,
//   ordered date asc → grouped by bookingRequestId || id (in that
//   order) → the card reads its booking-level fields off the group's base
//   shift (the LATEST-dated one, the same shift the family's card reads) →
//   header (family · Ongoing · schedule paused), Starts, day-by-day times with
//   hours, address + lifestyle chips, $rate/hr · Card, the booking's OWN note
//   (booking_requests.notes — the note typed when sending the booking), the
//   "Care plan & preferences" details → UPCOMING SHIFTS (not overdue; date/
//   start asc) each with the page's status pill, Started/Ended, the tasks
//   count, the visit's OWN note when it differs from the booking's — i.e. a
//   schedule-change note (founder 2026-09-28: "doesn't all notes show up in
//   the caregiver side") — and a pending reschedule proposal.
//
// Self-sending like show_booking_requests: the tool texts the cards itself,
// 2 per text, MORE continues; numbers are handles for follow-ups.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { shiftDisplayStatus } from "./shiftReschedule";
import { DEFAULT_TZ } from "../utils/scheduledTime";
import { clock } from "./inShift";
import {
  fmtDate, fmtTime, fmtHours, calcShiftMins, sortBlocks, ALL_DAYS_ORDER, requestDetailsLines,
  type BookingRequest, type ShiftBlock, type CareRecipient,
} from "./caregiverBookingRequests";

const db = admin.firestore();
export const PAGE_SIZE = 2;
export const EMPTY_TEXT = "No active bookings yet. When a family books you, it will appear here.";

type Doc = Record<string, unknown>;
export interface ActiveShift extends Doc {
  id: string;
  date: string;
  startTime?: string;
  endTime?: string;
  status: string;
  notes?: string;
  clientId?: string;
  clientName?: string;
  bookingRequestId?: string;
  careRecipients?: Array<CareRecipient | string>;
  tasksCompleted?: string[];
}
export interface ActiveGroup { key: string; shifts: ActiveShift[]; base: ActiveShift }

/** utils/shiftUtils.ts shiftStatusLabel, verbatim. */
export function shiftStatusLabel(status: string): string {
  switch (status) {
    case "overdue":           return "Overdue";
    case "scheduled":         return "Scheduled";
    case "in-progress":       return "In Progress";
    case "completed":         return "Completed";
    case "cancelled":         return "Cancelled";
    case "needs_replacement": return "Needs Replacement";
    default:                  return String(status);
  }
}

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
/** The page's fmtTs — a clock time in the business timezone. */
export function fmtClock(v: unknown): string | null {
  const ms = tsMs(v);
  if (ms === null) return null;
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit" });
}

/** The page's tasks total: one per care need, or one per subtask when the need has any. */
export function totalTasksFor(recipients: Array<CareRecipient | string>): number {
  return recipients.reduce((sum, r) => {
    if (typeof r === "string") return sum;
    const needs = r.careNeeds ?? [];
    const det = r.careNeedDetails ?? {};
    return sum + needs.reduce((s, n) => s + ((det[n]?.length || 0) || 1), 0);
  }, 0);
}

/** The tab's query: caregiverId ==, status in scheduled/in-progress, date asc. */
export async function loadCaregiverActiveShifts(caregiverId: string): Promise<ActiveShift[]> {
  const snap = await db.collection("shifts")
    .where("caregiverId", "==", caregiverId)
    .where("status", "in", ["scheduled", "in-progress"])
    .orderBy("date", "asc")
    .get();
  return snap.docs.map((d) => ({ ...(d.data() as Doc), id: d.id, date: String(d.data().date ?? ""), status: String(d.data().status ?? "") }));
}

/** The page's grouping (bookingRequestId || id, insertion order) and its card's base shift. */
export function groupActiveShifts(shifts: ActiveShift[]): ActiveGroup[] {
  const groups = new Map<string, ActiveShift[]>();
  for (const s of shifts) {
    const key = String(s.bookingRequestId || s.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, shifts: list, base: baseShift(list) }));
}
/** Both pages' card reads booking-level fields off the LATEST-dated shift (its schedule carries every accepted change). */
export function baseShift(list: ActiveShift[]): ActiveShift {
  return [...list].sort((a, b) => b.date.localeCompare(a.date) || String(b.startTime ?? "").localeCompare(String(a.startTime ?? "")))[0];
}

// ── The card ─────────────────────────────────────────────────────────────────
export function activeCardLines(g: ActiveGroup, opts: { schedulePaused?: boolean; bookingNote?: string | null; allVisits?: boolean } = {}): string[] {
  const base = g.base;
  // The header note is the booking's own (booking_requests.notes); the shift copy only when no booking doc was found.
  const headerNote = opts.bookingNote !== undefined ? opts.bookingNote : (base.notes ? String(base.notes) : null);
  const out: string[] = [];
  out.push(`${base.clientName || "Client"} · Ongoing${opts.schedulePaused ? " · Schedule paused — family's membership inactive" : ""}`);
  const sch = (base.schedule ?? {}) as { startDate?: string; endDate?: string; ongoing?: boolean; dayShiftTimes?: Record<string, ShiftBlock[]> };
  const dst = sch.dayShiftTimes ?? {};
  if (Object.keys(dst).length > 0) {
    if (sch.startDate) out.push(`Starts ${fmtDate(sch.startDate)}${!sch.ongoing && sch.endDate ? ` → ${fmtDate(sch.endDate)}` : ""}`);
    for (const day of ALL_DAYS_ORDER.filter((d) => dst[d]?.length)) {
      const blocks = sortBlocks(dst[day]);
      const mins = blocks.reduce((s, b) => s + calcShiftMins(b.start, b.end), 0);
      out.push(`${day} ${blocks.map((b) => `${fmtTime(b.start)} – ${fmtTime(b.end)}`).join(", ")}${mins > 0 ? ` (${fmtHours(mins)})` : ""}`);
    }
  }
  if (base.address) {
    out.push(String(base.address));
    const prefs = Array.isArray(base.lifestylePreferences) ? (base.lifestylePreferences as string[]) : [];
    if (prefs.length) out.push(prefs.join(" · "));
  }
  if (base.rate != null) out.push(`$${base.rate}/hr · Card`);
  if (headerNote) out.push(`Notes: ${headerNote}`);
  // "Care plan & preferences" — the page's details toggle, opened.
  const details = requestDetailsLines({ ...(base as unknown as BookingRequest), notes: "" });
  if (details.length) out.push("", "Care plan & preferences", ...details);

  // UPCOMING SHIFTS — not overdue, date/start asc.
  const upcoming = g.shifts
    .filter((s) => shiftDisplayStatus(s) !== "overdue")
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")));
  const recipients = Array.isArray(base.careRecipients) ? base.careRecipients : [];
  const totalTasks = totalTasksFor(recipients);
  out.push("", "Upcoming shifts");
  if (upcoming.length === 0) out.push("No upcoming visits.");
  // The page shows two visits and a "Show N more" button; VISITS shows them all.
  const shownVisits = opts.allVisits ? upcoming : upcoming.slice(0, 2);
  for (const s of shownVisits) {
    const done = Array.isArray(s.tasksCompleted) ? s.tasksCompleted.length : 0;
    out.push(`${fmtDate(s.date)} · ${fmtTime(s.startTime)}${s.endTime ? ` – ${fmtTime(s.endTime)}` : ""} · ${shiftStatusLabel(shiftDisplayStatus(s))}${totalTasks > 0 ? ` · ${done}/${totalTasks} tasks` : ""}`);
    if (s.startedAt) {
      const started = fmtClock(s.startedAt);
      const ended = fmtClock(s.completedAt);
      if (started) out.push(`  Started ${started}${ended ? ` · Ended ${ended}` : ""}`);
    }
    // The page's Visit notes block under a visit in progress — the running log lines.
    const log = Array.isArray(s.notesLog) ? (s.notesLog as Array<{ at?: string; text?: string }>) : [];
    if (s.status === "in-progress" && log.length > 0) {
      out.push("  Visit notes:");
      for (const n of log) { const t = fmtClock(n.at); out.push(`    ${t ? `${t} — ` : ""}${String(n.text ?? "")}`); }
    }
    // The visit's own note (the note on the schedule-change request that
    // created it) — only when it differs from the booking's note above.
    if (s.notes && s.notes !== headerNote) out.push(`  ${String(s.notes)}`);
    if (s.status === "scheduled" && s.reschedulePendingDate) {
      const when = `${fmtDate(String(s.reschedulePendingDate))}, ${fmtTime(s.reschedulePendingStartTime as string | undefined)}${s.reschedulePendingEndTime ? ` – ${fmtTime(s.reschedulePendingEndTime as string)}` : ""}`;
      out.push(s.rescheduledBy === "client"
        ? `  ${base.clientName || "The family"} proposed moving this visit to ${when} — reply to accept or decline.`
        : `  You proposed moving this visit to ${when} — waiting on the family to confirm.`);
    }
    // The page's "Show reschedule history (N)" — one line per past change.
    const history = Array.isArray(s.rescheduleHistory) ? (s.rescheduleHistory as Array<Record<string, any>>) : [];
    if (history.length > 0) {
      out.push(`  Reschedule history (${history.length}):`);
      for (const h of history) {
        const range = (x: Record<string, any> | undefined) => x ? `${fmtDate(String(x.date ?? ""))}, ${fmtTime(x.startTime)}${x.endTime ? `–${fmtTime(x.endTime)}` : ""}` : "";
        const legacyBy = h.changedBy as string | undefined;
        const who = (p: unknown) => (p === "client" ? "family" : "you");
        const stamp = (iso: unknown) => { const ms = typeof iso === "string" ? Date.parse(iso) : NaN; return Number.isFinite(ms) ? `${new Date(ms).toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, month: "short", day: "numeric" })}, ${clock(ms)}` : ""; };
        const meta = legacyBy && !h.proposedBy
          ? `requested by ${who(legacyBy)} · confirmed by ${legacyBy === "client" ? "you" : "family"} on ${stamp(h.changedAt)}`
          : `requested by ${who(h.proposedBy)} on ${stamp(h.proposedAt)} · confirmed by ${who(h.acceptedBy)} on ${stamp(h.acceptedAt)}`;
        out.push(`    ${range(h.from)} → ${range(h.to)} (${meta})`);
      }
    }
  }
  const hidden = upcoming.length - shownVisits.length;
  if (hidden > 0) out.push(`+${hidden} more visit${hidden === 1 ? "" : "s"} — reply VISITS to see them all.`);
  return out;
}

export interface LastActiveBookingList { at: string; items: Array<{ number: number; bookingRequestId: string; clientName: string }>; offset?: number; total?: number }

export interface BookingCardInfo { schedulePaused: boolean; bookingNote?: string | null }
export function activeBookingsText(groups: ActiveGroup[], infoByBooking: Map<string, BookingCardInfo>, opts: { from?: number; allVisits?: boolean } = {}): { text: string; shown: ActiveGroup[]; remaining: number } {
  const from = opts.from ?? 0;
  if (groups.length === 0) return { text: EMPTY_TEXT, shown: [], remaining: 0 };
  const shown = groups.slice(from, from + PAGE_SIZE);
  const remaining = Math.max(0, groups.length - (from + shown.length));
  if (shown.length === 0) return { text: "That's all your active bookings.", shown, remaining: 0 };
  const blocks = shown.map((g, i) => {
    const info = infoByBooking.get(g.key);
    const [head, ...rest] = activeCardLines(g, { schedulePaused: info?.schedulePaused === true, allVisits: opts.allVisits === true, ...(info && "bookingNote" in info ? { bookingNote: info.bookingNote } : {}) });
    return [`${from + i + 1}. ${head}`, ...rest].join("\n").replace(/\n{3,}/g, "\n\n");
  });
  const footer = remaining > 0 ? "Reply MORE to see more." : "";
  return { text: [from === 0 ? "Active bookings:" : "More bookings:", "", blocks.join("\n\n"), ...(footer ? ["", footer] : [])].join("\n"), shown, remaining };
}

export async function sendCaregiverActiveBookings(phone: string, chatId: string, caregiverId: string, opts: { more?: boolean; allVisits?: boolean } = {}) {
  const groups = groupActiveShifts(await loadCaregiverActiveShifts(caregiverId));
  // The booking doc: the page's "Schedule paused" chip (schedulePausedAt) and the header note (notes).
  const infoByBooking = new Map<string, BookingCardInfo>();
  await Promise.all(groups.filter((g) => g.base.bookingRequestId).map(async (g) => {
    const snap = await db.collection("booking_requests").doc(String(g.base.bookingRequestId)).get().catch(() => null);
    const d = snap?.exists ? snap.data() ?? {} : null;
    infoByBooking.set(g.key, d ? { schedulePaused: !!d.schedulePausedAt, bookingNote: d.notes ? String(d.notes) : null } : { schedulePaused: false });
  }));
  let prev: LastActiveBookingList | undefined;
  if (opts.more) {
    const sess = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    prev = (sess?.data()?.lastActiveBookingList as LastActiveBookingList | undefined) ?? undefined;
  }
  const from = opts.more && prev ? (prev.offset ?? prev.items.length) : 0;
  const { text, shown, remaining } = activeBookingsText(groups, infoByBooking, { from, allVisits: opts.allVisits === true });
  await sendMessage(chatId, text);
  const newItems = shown.map((g, i) => ({ number: from + i + 1, bookingRequestId: g.key, clientName: String(g.base.clientName ?? "") }));
  // The visit ids behind the rows, for start_shift / update_shift_task / add_visit_note / complete_shift / manage_shift_reschedule.
  const visits = shown.flatMap((g) => g.shifts
    .filter((s) => shiftDisplayStatus(s) !== "overdue")
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")))
    .map((s) => ({ shiftId: s.id, bookingRequestId: g.key, clientName: String(g.base.clientName ?? ""), date: s.date, startTime: s.startTime ?? null, endTime: s.endTime ?? null, status: shiftDisplayStatus(s) })));
  const items = from > 0 && prev ? [...prev.items.filter((it) => it.number <= from), ...newItems] : newItems;
  await db.collection("agent_sessions").doc(phone).set(
    { lastActiveBookingList: { at: new Date().toISOString(), items, offset: from + shown.length, total: groups.length } satisfies LastActiveBookingList },
    { merge: true },
  ).catch(() => {});
  return { sent: true, count: shown.length, total: groups.length, remaining, items: newItems, visits };
}
