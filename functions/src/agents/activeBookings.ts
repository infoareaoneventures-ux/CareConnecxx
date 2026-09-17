// agents/activeBookings.ts — the website's My Bookings > Active Bookings tab,
// read exactly the way components/client/ClientVisitsPage.tsx builds it
// (2026-09-17). One implementation behind the `get_active_bookings` MCP tool so
// what Evia describes is what the family sees on the page:
//
//   shifts where clientId == me and status in scheduled/in-progress/
//   needs_replacement (activeShifts) → grouped by bookingRequestId || id
//   (groupByBooking) → the card reads its booking-level fields off the
//   group's LATEST shift (`base = shifts[0]` with the page's date-desc
//   ordering) → UPCOMING SHIFTS sorted date/start asc with the page's own
//   shiftDisplayStatus (Overdue) and per-row buttons.
//
// Booking-level data (schedule, address, rate, notes, care recipients,
// emergency contact) lives ON the shift docs — shiftGenerator.ts copies it
// from the accepted booking_requests doc — so no second read is needed, same
// as the page.
import * as admin from "firebase-admin";
import { bookingTimeToMinutes } from "./bookingResolution";
import { shiftDisplayStatus } from "./shiftReschedule";
import { weekdayForDate } from "../utils/scheduledTime";

const db = admin.firestore();
const DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ClientVisitsPage.tsx calcShiftMins / fmtHours, verbatim semantics.
function calcShiftMins(start: unknown, end: unknown): number {
  if (!start || !end) return 0;
  const a = bookingTimeToMinutes(start);
  const b = bookingTimeToMinutes(end);
  if (a === null || b === null) return 0;
  const diff = b - a;
  return diff > 0 ? diff : 0;
}
export function fmtHours(mins: number): string {
  if (mins === 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export type ActiveShiftAction =
  | "cancel_visit" | "propose_reschedule"
  | "accept_reschedule" | "decline_reschedule" | "withdraw_reschedule"
  | "find_replacement" | "skip" | "choose_someone_else";

export interface ActiveBookingShift {
  id:            string;
  date:          string;
  dayOfWeek:     string | null;
  startTime:     string | null;
  endTime:       string | null;
  /** The page's pill: scheduled | overdue | in-progress | needs_replacement */
  displayStatus: string;
  /** Only when it differs from the booking's own note (the page hides repeats). */
  notes?:        string;
  reschedulePending?: {
    date: string; startTime: string | null; endTime: string | null;
    proposedBy: "client" | "caregiver" | null; proposedAt: string | null;
    /** "you" = the caregiver proposed and the family must accept/decline; "caregiver" = the family's own proposal is out. */
    waitingOn: "you" | "caregiver";
  };
  rescheduleHistory?: unknown[];
  replacement?: { status: "waiting_on_caregiver"; requestId: string; caregiverName: string | null } | { status: "needs_choice" };
  /** The buttons the page shows on this row, under the same conditions. */
  actions: ActiveShiftAction[];
}

export interface ActiveBooking {
  bookingRequestId:  string | null;
  caregiverId:       string | null;
  caregiverName:     string;
  caregiverPhotoURL: string | null;
  ongoing:           boolean;
  endDate:           string | null;
  startDate:         string | null;
  weeklySchedule:    Array<{ day: string; blocks: Array<{ start: string; end: string }>; hours: string }>;
  weeklyHours:       string;
  address:           string;
  rate:              number | null;
  paymentMethod:     string | null;
  /** The page's label: 'credit' renders as "Card". */
  paymentLabel:      string | null;
  notes:             string | null;
  careRecipients:    Array<Record<string, unknown>>;
  emergencyContact:  Record<string, unknown> | null;
  upcomingShifts:    ActiveBookingShift[];
  /** Card-level buttons: Message, Cancel Booking. */
  actions:           Array<"message" | "cancel_booking">;
}

type ShiftDoc = FirebaseFirestore.DocumentData & { id: string };

function shiftRow(s: ShiftDoc, base: ShiftDoc): ActiveBookingShift {
  const ds = shiftDisplayStatus(s as { status?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown });
  const actions: ActiveShiftAction[] = [];
  // Cancel single shift — only a 'scheduled' row has the ✕.
  if (s.status === "scheduled") actions.push("cancel_visit");
  // Reschedule — "only when your turn (no proposal out, or reviewing the
  // caregiver's) … and not once the shift is overdue".
  if (s.status === "scheduled" && s.rescheduledBy !== "client" && ds !== "overdue") actions.push("propose_reschedule");
  if (s.status === "scheduled" && s.reschedulePendingDate) {
    if (s.rescheduledBy === "caregiver") actions.push("accept_reschedule", "decline_reschedule");
    else actions.push("withdraw_reschedule");
  }
  if (s.status === "needs_replacement") {
    if (s.replacementRequestId) actions.push("choose_someone_else");
    else actions.push("find_replacement", "skip");
  }
  return {
    id: s.id,
    date: String(s.date ?? ""),
    dayOfWeek: weekdayForDate(String(s.date ?? "")),
    startTime: (s.startTime as string | undefined) ?? null,
    endTime: (s.endTime as string | undefined) ?? null,
    displayStatus: ds,
    ...(s.notes && s.notes !== base.notes ? { notes: String(s.notes) } : {}),
    ...(s.reschedulePendingDate ? {
      reschedulePending: {
        date: String(s.reschedulePendingDate),
        startTime: (s.reschedulePendingStartTime as string | undefined) ?? null,
        endTime: (s.reschedulePendingEndTime as string | undefined) ?? null,
        proposedBy: (s.rescheduledBy as "client" | "caregiver" | undefined) ?? null,
        proposedAt: (s.reschedulePendingAt as string | undefined) ?? null,
        waitingOn: s.rescheduledBy === "client" ? "caregiver" as const : "you" as const,
      },
    } : {}),
    ...(Array.isArray(s.rescheduleHistory) && s.rescheduleHistory.length > 0 ? { rescheduleHistory: s.rescheduleHistory as unknown[] } : {}),
    ...(s.status === "needs_replacement" ? {
      replacement: s.replacementRequestId
        ? { status: "waiting_on_caregiver" as const, requestId: String(s.replacementRequestId), caregiverName: (s.replacementCaregiverName as string | undefined) ?? null }
        : { status: "needs_choice" as const },
    } : {}),
    actions,
  };
}

export async function listActiveBookings(clientId: string): Promise<ActiveBooking[]> {
  const snap = await db.collection("shifts")
    .where("clientId", "==", clientId)
    .where("status", "in", ["scheduled", "in-progress", "needs_replacement"])
    .get();
  // The page's listener orders by date desc, so each group's first shift
  // (the card's `base`) is its latest-dated one.
  const shifts: ShiftDoc[] = snap.docs
    .map((d): ShiftDoc => ({ ...d.data(), id: d.id }))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")) || String(b.startTime ?? "").localeCompare(String(a.startTime ?? "")));
  const groups = new Map<string, ShiftDoc[]>();
  for (const s of shifts) {
    const key = String(s.bookingRequestId || s.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const out: ActiveBooking[] = [];
  for (const [, list] of groups) {
    const base = list[0];
    const sorted = [...list].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")) || String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")));
    const schedule = (base.schedule ?? {}) as Record<string, unknown>;
    const dst = (schedule.dayShiftTimes ?? {}) as Record<string, Array<{ start?: string; end?: string }>>;
    const days = DAY_ORDER.filter((d) => (dst[d] ?? []).some((b) => b.start && b.end));
    let weeklyMinutes = 0;
    const weeklySchedule = days.map((day) => {
      const blocks = (dst[day] ?? []).filter((b) => b.start && b.end) as Array<{ start: string; end: string }>;
      const mins = blocks.reduce((sum, b) => sum + calcShiftMins(b.start, b.end), 0);
      weeklyMinutes += mins;
      return { day, blocks: blocks.map((b) => ({ start: b.start, end: b.end })), hours: fmtHours(mins) };
    });
    const ongoing = Boolean(schedule.ongoing ?? base.recurringWeekly ?? false);
    const paymentMethod = (base.paymentMethod as string | undefined) ?? null;
    out.push({
      bookingRequestId:  (base.bookingRequestId as string | undefined) ?? null,
      caregiverId:       (base.caregiverId as string | undefined) ?? null,
      caregiverName:     String(base.caregiverName ?? "Caregiver"),
      caregiverPhotoURL: (base.caregiverPhotoURL as string | undefined) ?? null,
      ongoing,
      endDate:           ongoing ? null : ((schedule.endDate as string | undefined) ?? null),
      startDate:         (schedule.startDate as string | undefined) ?? null,
      weeklySchedule,
      weeklyHours:       fmtHours(weeklyMinutes),
      address:           String(base.address ?? ""),
      rate:              (base.rate as number | undefined) ?? null,
      paymentMethod,
      paymentLabel:      paymentMethod === "credit" ? "Card" : paymentMethod,
      notes:             base.notes ? String(base.notes) : null,
      careRecipients:    Array.isArray(base.careRecipients) ? (base.careRecipients as Array<Record<string, unknown>>) : [],
      emergencyContact:  (base.emergencyContact as Record<string, unknown> | undefined) ?? null,
      upcomingShifts:    sorted.map((s) => shiftRow(s, base)),
      actions:           ["message", "cancel_booking"],
    });
  }
  return out;
}
