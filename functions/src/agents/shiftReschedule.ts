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
import { businessTodayStr } from "../utils/scheduledTime";
import { bookingTimeToMinutes } from "./bookingResolution";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

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
    .filter((d) => d.data().status === "scheduled")
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
  });
  logAudit({ eventType: "shift_reschedule_proposed", userId: args.clientId, data: { source: args.source, shiftId: args.shiftId } }).catch(() => {});
  return {
    ok: true, shiftId: args.shiftId, date: args.date, startTime: args.startTime, endTime: args.endTime,
    caregiverName: String(args.shift.caregiverName ?? "your caregiver"),
  };
}
