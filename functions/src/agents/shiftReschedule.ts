// Shift reschedule — backend port of the website's own Reschedule button on
// My Bookings > Active Bookings > UPCOMING SHIFTS (components/client/
// ClientVisitsPage.tsx: fetchOwnShiftsForDate + rangeConflicts +
// handleProposeReschedule). One implementation shared by the MCP tool
// (manage_booking action:"propose_reschedule") and the scripted
// rescheduleFlow.ts, so the tool path and the conversation path can never
// drift apart in what they check or write.
//
// 2026-09-15 (live-caught): left to the free-form agent loop, "9/17 10am to
// 3pm" got applied to the WRONG visit (the needs_replacement one instead of
// the scheduled one next to it), and the tool had no double-booking check at
// all — the site refuses a proposal that overlaps another visit with the
// same caregiver that day. Both are fixed here.
import * as admin from "firebase-admin";
import { businessTodayStr, businessNowMinutes } from "../utils/scheduledTime";
import { bookingTimeToMinutes } from "./bookingResolution";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

// The site's shiftDisplayStatus() (utils/shiftUtils.ts): a 'scheduled' visit
// whose date has passed, or whose end time has passed today, shows as
// Overdue — and the site hides its Reschedule button ("that's a no-show/
// dispute situation, not something to just move"). Same rule here, in the
// business timezone. Midnight-crossing visits (end < start) end next day.
export function isShiftOverdue(
  v: { status?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown },
  todayStr: string = businessTodayStr(),
  nowMinutes: number = businessNowMinutes(),
): boolean {
  if (v.status !== "scheduled") return false;
  const date = String(v.date ?? "");
  if (!date) return false;
  const startMin = bookingTimeToMinutes(v.startTime ?? "00:00") ?? 0;
  const endMin = bookingTimeToMinutes(v.endTime ?? "23:59") ?? 23 * 60 + 59;
  const effectiveEnd = endMin < startMin ? endMin + 1440 : endMin;
  return date < todayStr || (date === todayStr && effectiveEnd <= nowMinutes);
}

export interface ReschedulableVisit {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  caregiverId: string;
  caregiverName: string;
  // A proposal already sitting on this visit (from either side).
  pendingDate?: string;
  pendingStart?: string;
  pendingEnd?: string;
  pendingBy?: string;
}

// The visits the site's Reschedule button appears on: this client's
// 'scheduled' shifts from today on, soonest first. Same query shape as
// get_upcoming_appointments (same composite index), filtered in memory.
export async function listReschedulableVisits(clientId: string, limit = 10): Promise<ReschedulableVisit[]> {
  const today = businessTodayStr();
  const snap = await db.collection("shifts")
    .where("clientId", "==", clientId)
    .where("status", "in", ["scheduled", "in-progress", "needs_replacement"])
    .where("date", ">=", today)
    .orderBy("date", "asc")
    .limit(limit * 2)
    .get();
  return snap.docs
    // The page shows the Reschedule button only when it's the family's turn:
    // status scheduled, not Overdue, and no proposal of their OWN still out
    // (rescheduledBy === 'client'). A caregiver's proposal still qualifies
    // ("propose a different time").
    .filter((d) => d.data().status === "scheduled" && !isShiftOverdue(d.data()) && !(d.data().reschedulePendingDate && d.data().rescheduledBy === "client"))
    .map((d) => {
      const s = d.data();
      return {
        id: d.id,
        date: String(s.date ?? ""),
        startTime: String(s.startTime ?? ""),
        endTime: String(s.endTime ?? s.startTime ?? ""),
        caregiverId: String(s.caregiverId ?? ""),
        caregiverName: String(s.caregiverName ?? "your caregiver"),
        ...(s.reschedulePendingDate ? {
          pendingDate: String(s.reschedulePendingDate),
          pendingStart: String(s.reschedulePendingStartTime ?? ""),
          pendingEnd: String(s.reschedulePendingEndTime ?? ""),
          pendingBy: String(s.rescheduledBy ?? ""),
        } : {}),
      };
    })
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
    .slice(0, limit);
}

export type ReschedulableShiftLoad =
  | { ok: true; shift: FirebaseFirestore.DocumentData; ref: FirebaseFirestore.DocumentReference }
  | { ok: false; code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT"; message: string };

// The visit must exist, belong to this client, and be 'scheduled' — the one
// status the site's Reschedule button appears on.
export async function loadReschedulableShift(clientId: string, shiftId: string): Promise<ReschedulableShiftLoad> {
  const ref = db.collection("shifts").doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: "NOT_FOUND", message: "Visit not found" };
  const shift = snap.data()!;
  if (shift.clientId !== clientId) return { ok: false, code: "PERMISSION_DENIED", message: "Visit does not belong to this client" };
  if (shift.status !== "scheduled") {
    return { ok: false, code: "INVALID_INPUT", message: `Only a scheduled visit can be rescheduled this way (status: ${shift.status})` };
  }
  if (isShiftOverdue(shift)) {
    return { ok: false, code: "INVALID_INPUT", message: "This visit has already passed (it shows as Overdue) and can't be rescheduled" };
  }
  if (shift.reschedulePendingDate && shift.rescheduledBy === "client") {
    return {
      ok: false, code: "INVALID_INPUT",
      message: `You already proposed moving this visit and it's waiting on ${String(shift.caregiverName ?? "your caregiver")} to confirm — withdraw that proposal first if you want a different time`,
    };
  }
  return { ok: true, shift, ref };
}

// ── Conflict check (byte-close to ClientVisitsPage.tsx) ──────────────────────

function toMinutesOfDay(t: string): number {
  const nextDay = t.startsWith("~");
  const raw = nextDay ? t.slice(1) : t;
  const [h, m] = raw.split(":").map(Number);
  return (nextDay ? 1440 : 0) + (h || 0) * 60 + (m || 0);
}

export function timeRangesOverlap(startA: string, endA: string | undefined, startB: string, endB: string | undefined): boolean {
  const aStart = toMinutesOfDay(startA), aEnd = toMinutesOfDay(endA || startA);
  const bStart = toMinutesOfDay(startB), bEnd = toMinutesOfDay(endB || startB);
  return aStart < bEnd && bStart < aEnd;
}

export interface OwnShiftConflict { startTime: string; endTime?: string }

// This SAME caregiver's other active visits with this client on the target
// date, excluding the visit being moved — the site's fetchOwnShiftsForDate.
// Deliberately scoped to (this client, this caregiver): two DIFFERENT
// caregivers at overlapping times is legitimate (a two-person care team).
export async function findOwnShiftConflict(args: {
  clientId: string; caregiverId: string; date: string; startTime: string; endTime: string; excludeShiftId: string;
}): Promise<OwnShiftConflict | null> {
  if (!args.date) return null;
  const snap = await db.collection("shifts")
    .where("clientId", "==", args.clientId)
    .where("status", "in", ["scheduled", "in-progress"])
    .where("date", "==", args.date)
    .get();
  const others: OwnShiftConflict[] = snap.docs
    .filter((d) => d.id !== args.excludeShiftId && d.data().caregiverId === args.caregiverId)
    .map((d) => ({ startTime: String(d.data().startTime ?? ""), endTime: d.data().endTime ? String(d.data().endTime) : undefined }));
  return others.find((c) => timeRangesOverlap(args.startTime, args.endTime, c.startTime, c.endTime)) ?? null;
}

/** CaregiverBookingsPage.tsx fetchOwnShiftsForDate + rangeConflicts: the caregiver's OTHER scheduled / in-progress visits that day that overlap the range. */
export async function findCaregiverOwnShiftConflict(args: {
  caregiverId: string; date: string; startTime: string; endTime: string; excludeShiftId: string;
}): Promise<OwnShiftConflict | null> {
  if (!args.date) return null;
  const snap = await db.collection("shifts")
    .where("caregiverId", "==", args.caregiverId)
    .where("status", "in", ["scheduled", "in-progress"])
    .where("date", "==", args.date)
    .get();
  const others: OwnShiftConflict[] = snap.docs
    .filter((d) => d.id !== args.excludeShiftId && d.data().caregiverId === args.caregiverId && String(d.data().date ?? args.date) === args.date)
    .map((d) => ({ startTime: String(d.data().startTime ?? ""), endTime: d.data().endTime ? String(d.data().endTime) : undefined }));
  return others.find((c) => timeRangesOverlap(args.startTime, args.endTime, c.startTime, c.endTime)) ?? null;
}

// ── Validation shared by the tool and the flow ───────────────────────────────

export type RescheduleTimeCheck =
  | { ok: true }
  | { ok: false; reason: "bad_format" | "end_before_start" | "past_date" };

export function validateRescheduleTarget(date: unknown, startTime: unknown, endTime: unknown): RescheduleTimeCheck {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: "bad_format" };
  const startMin = bookingTimeToMinutes(startTime);
  const endMin = bookingTimeToMinutes(endTime);
  if (startMin === null || endMin === null) return { ok: false, reason: "bad_format" };
  if (endMin <= startMin) return { ok: false, reason: "end_before_start" };
  if (date < businessTodayStr()) return { ok: false, reason: "past_date" };
  return { ok: true };
}

// ── The write (the site's handleProposeReschedule) ───────────────────────────

export type ProposeRescheduleResult =
  | { ok: true; shiftId: string; date: string; startTime: string; endTime: string; caregiverName: string }
  | { ok: false; code: "CONFLICT"; conflict: OwnShiftConflict }
  | { ok: false; code: "INVALID_INPUT"; message: string };

// Stores the proposal in the separate reschedulePending* fields and NEVER
// touches the real date/startTime/endTime — those move only when the
// caregiver accepts. onShiftStatusChanged (notificationTriggers.ts) watches
// this exact field combination and texts the caregiver — no manual send.
export async function proposeShiftReschedule(args: {
  clientId: string;
  shiftId: string;
  shift: FirebaseFirestore.DocumentData;
  shiftRef: FirebaseFirestore.DocumentReference;
  date: string;
  startTime: string;
  endTime: string;
  nowIso: string;
  source: string;
}): Promise<ProposeRescheduleResult> {
  const check = validateRescheduleTarget(args.date, args.startTime, args.endTime);
  if (!check.ok) {
    const message = check.reason === "past_date"
      ? "The new date has already passed"
      : check.reason === "end_before_start"
        ? "endTime must be after startTime"
        : "date must be YYYY-MM-DD and startTime/endTime must be HH:MM";
    return { ok: false, code: "INVALID_INPUT", message };
  }
  const conflict = await findOwnShiftConflict({
    clientId: args.clientId,
    caregiverId: String(args.shift.caregiverId ?? ""),
    date: args.date, startTime: args.startTime, endTime: args.endTime,
    excludeShiftId: args.shiftId,
  });
  if (conflict) return { ok: false, code: "CONFLICT", conflict };

  await args.shiftRef.update({
    reschedulePendingDate: args.date,
    reschedulePendingStartTime: args.startTime,
    reschedulePendingEndTime: args.endTime,
    reschedulePendingAt: args.nowIso,
    rescheduledBy: "client",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logAudit({ eventType: "shift_reschedule_proposed", userId: args.clientId, data: { source: args.source, shiftId: args.shiftId } }).catch(() => {});
  return {
    ok: true, shiftId: args.shiftId, date: args.date, startTime: args.startTime, endTime: args.endTime,
    caregiverName: String(args.shift.caregiverName ?? "your caregiver"),
  };
}

// ── The page's status pill (utils/shiftUtils.ts shiftDisplayStatus) ─────────
export function shiftDisplayStatus(v: { status?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown }): string {
  // Mirrors the page: a needs_replacement visit whose window passed is Overdue.
  if (v.status === "needs_replacement") return isShiftOverdue({ ...v, status: "scheduled" }) ? "overdue" : "needs_replacement";
  if (v.status !== "scheduled") return String(v.status ?? "");
  return isShiftOverdue(v) ? "overdue" : "scheduled";
}

// ── Accept / decline / withdraw a pending proposal ───────────────────────────
// The page's handleAcceptReschedule / handleClearReschedule, same shift doc
// throughout. Accept is the moment the real date/startTime/endTime change;
// it first checks the family's OWN other visits with this caregiver on the
// new date (fetchOwnShiftsForDate + rangeConflicts) exactly as the page does.
// onShiftStatusChanged (notificationTriggers.ts) texts the caregiver on both.

export type RescheduleDecisionResult =
  | { ok: true; shiftId: string; caregiverName: string; date?: string; startTime?: string; endTime?: string }
  | { ok: false; code: "CONFLICT"; conflict: OwnShiftConflict }
  | { ok: false; code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT"; message: string };

async function loadOwnShift(clientId: string, shiftId: string) {
  const ref = db.collection("shifts").doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false as const, code: "NOT_FOUND" as const, message: "Visit not found" };
  const shift = snap.data()!;
  if (shift.clientId !== clientId) return { ok: false as const, code: "PERMISSION_DENIED" as const, message: "Visit does not belong to this client" };
  if (!shift.reschedulePendingDate) return { ok: false as const, code: "INVALID_INPUT" as const, message: "There's no pending reschedule proposal on this visit" };
  return { ok: true as const, shift, ref };
}

export async function acceptRescheduleProposal(clientId: string, shiftId: string, nowIso: string, source: string): Promise<RescheduleDecisionResult> {
  const loaded = await loadOwnShift(clientId, shiftId);
  if (!loaded.ok) return loaded;
  const { shift, ref } = loaded;
  if (shift.rescheduledBy !== "caregiver") {
    return { ok: false, code: "INVALID_INPUT", message: "This proposal is your own — nothing to accept (withdraw it instead)" };
  }
  const pendingStart = String(shift.reschedulePendingStartTime ?? "");
  const pendingEnd = String(shift.reschedulePendingEndTime ?? pendingStart);
  const conflict = await findOwnShiftConflict({
    clientId, caregiverId: String(shift.caregiverId ?? ""),
    date: String(shift.reschedulePendingDate), startTime: pendingStart, endTime: pendingEnd,
    excludeShiftId: shiftId,
  });
  if (conflict) return { ok: false, code: "CONFLICT", conflict };
  await ref.update({
    date: shift.reschedulePendingDate,
    startTime: shift.reschedulePendingStartTime,
    endTime: shift.reschedulePendingEndTime,
    reschedulePendingDate: admin.firestore.FieldValue.delete(),
    reschedulePendingStartTime: admin.firestore.FieldValue.delete(),
    reschedulePendingEndTime: admin.firestore.FieldValue.delete(),
    reschedulePendingAt: admin.firestore.FieldValue.delete(),
    rescheduledBy: admin.firestore.FieldValue.delete(),
    rescheduleHistory: admin.firestore.FieldValue.arrayUnion({
      from: { date: shift.date, startTime: shift.startTime, endTime: shift.endTime ?? null },
      to:   { date: shift.reschedulePendingDate, startTime: shift.reschedulePendingStartTime, endTime: shift.reschedulePendingEndTime ?? null },
      proposedBy: shift.rescheduledBy,
      proposedAt: shift.reschedulePendingAt ?? null,
      acceptedBy: "client",
      acceptedAt: nowIso,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logAudit({ eventType: "shift_reschedule_accepted", userId: clientId, data: { source, shiftId } }).catch(() => {});
  return {
    ok: true, shiftId, caregiverName: String(shift.caregiverName ?? "your caregiver"),
    date: String(shift.reschedulePendingDate), startTime: pendingStart, endTime: String(shift.reschedulePendingEndTime ?? ""),
  };
}

/** Decline the caregiver's proposal, or withdraw your own — clears the pending fields only. */
export async function clearRescheduleProposal(clientId: string, shiftId: string, source: string): Promise<RescheduleDecisionResult> {
  const loaded = await loadOwnShift(clientId, shiftId);
  if (!loaded.ok) return loaded;
  const { shift, ref } = loaded;
  await ref.update({
    reschedulePendingDate: admin.firestore.FieldValue.delete(),
    reschedulePendingStartTime: admin.firestore.FieldValue.delete(),
    reschedulePendingEndTime: admin.firestore.FieldValue.delete(),
    reschedulePendingAt: admin.firestore.FieldValue.delete(),
    rescheduledBy: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logAudit({ eventType: "shift_reschedule_cleared", userId: clientId, data: { source, shiftId } }).catch(() => {});
  return { ok: true, shiftId, caregiverName: String(shift.caregiverName ?? "your caregiver") };
}
