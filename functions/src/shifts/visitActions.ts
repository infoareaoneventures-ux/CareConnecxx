// shifts/visitActions.ts — the caregiver's four shift writes, ONCE, server-side
// (founder 2026-10-11: "3 fix. not leaving it for later"). Before this file the
// membership + background gate, the Start window and one-visit-at-a-time were
// enforced only in the browser, and firestore.rules let a caregiver write ANY
// status on their own shift. Now:
//
//   startVisit   — scheduled → in-progress   {status, startedAt, updatedAt}
//                  caller is the shift's caregiver; membership active AND
//                  background cleared (agents/caregiverAccessGate.ts, the
//                  site's useCaregiverGate); no OTHER visit of theirs in
//                  progress (any date); not overdue (the site's
//                  shiftDisplayStatus: the visit's end has not passed); not
//                  more than 15 minutes before the start.
//   endVisit     — in-progress → completed   {status, completedAt, updatedAt,
//                  completionNotes?}  caller is the caregiver; the visit is in
//                  progress (already completed → ok, nothing written).
//   cancelVisit  — scheduled → needs_replacement (starts within 24h) | cancelled
//                  {status, cancelledBy, updatedAt}; the caregiver's ✕. The
//                  family's notice is onShiftStatusChanged's, as on the site.
//   cancelBooking — the Cancel Booking button: cancelVisit's patch on this
//                  visit + every future scheduled visit of the booking (batch),
//                  then booking_requests → cancelled when none was urgent.
//   logHours     — a MISSED visit (scheduled, overdue) → completed
//                  {status, startedAt, completedAt, loggedManually: true,
//                  tasksCompleted, completionNotes?, updatedAt}; gated like
//                  the page's Log Hours button; end after start.
//
// Callers: the website through the visit_action_requests queue
// (triggers/visitActionQueue.ts — the GCP org policy blocks new public
// functions, so the site writes a request doc and this runs as admin), Evia's
// inShift.ts / visitMode.ts / caregiverPastBookings.ts /
// caregiverCancelShiftHandler.ts (same functions, their own texts around the
// result), and the lock path in triggers/caregiverAccountEvents.ts (system
// cancel). firestore.rules no longer lets a caregiver set in-progress /
// completed / cancelled / needs_replacement directly — only the Tasks
// checklist and the visit-notes log on an in-progress visit stay client writes.
//
// The checks are pure (`*Refusal` functions take loaded data) so they can be
// tested without Firestore; the `startVisit` … `logHours` functions load, check
// and write.
import { careZoneOf, wallToInstantMs } from "../utils/careTime";
import * as admin from "firebase-admin";
import { isShiftOverdue } from "../agents/shiftReschedule";
import { checkCaregiverAccess, caregiverGateText, type CaregiverGateReason } from "../agents/caregiverAccessGate";
import { fmtDate, fmtTime } from "../agents/caregiverBookingRequests";

const db = admin.firestore();
type Doc = Record<string, unknown>;

/** The page's Start Shift button opens this many minutes before the visit's start. */
export const START_WINDOW_MINUTES = 15;
/** A caregiver cancel this close to the start becomes needs_replacement (the family's fast replacement picker). */
export const CANCEL_URGENT_HOURS = 24;

export type VisitRefusalReason =
  | "not_found"            // no such shift
  | "not_yours"            // the caller is not the shift's caregiver
  | "membership"           // the gate: membership not active
  | "background"           // the gate: background check not cleared
  | "another_in_progress"  // one visit at a time
  | "not_scheduled"        // start/cancel/log: the visit is not 'scheduled'
  | "overdue"              // start: the visit's time has passed
  | "too_early"            // start: more than 15 minutes before the start
  | "not_in_progress"      // end: the visit was never started
  | "not_missed"           // log hours: the visit has not happened yet (not overdue)
  | "bad_times";           // log hours: end not after start / unparseable

export interface VisitRefusal {
  ok: false;
  reason: VisitRefusalReason;
  /** Channel-neutral sentence the site shows in its toast and Evia texts (Evia appends its keyword hints). */
  message: string;
  /** The shift's current status, when the refusal is about it. */
  status?: string;
  /** The caregiver record, on a gate refusal (so Evia can text the gate's CTA). */
  caregiver?: Doc;
  /** The other visit in progress, on another_in_progress. */
  other?: { id: string; shift: Doc };
}

export type StartVisitResult = { ok: true; shiftId: string; shift: Doc; alreadyStarted: boolean; startedAt: string } | VisitRefusal;
export type EndVisitResult = { ok: true; shiftId: string; shift: Doc; alreadyCompleted: boolean; completedAt: string } | VisitRefusal;
export type CancelVisitResult = { ok: true; shiftId: string; shift: Doc; status: "needs_replacement" | "cancelled" } | VisitRefusal;
export type CancelBookingResult = { ok: true; shiftId: string; anyUrgent: boolean; count: number } | VisitRefusal;
export type LogHoursResult = { ok: true; shiftId: string; shift: Doc } | VisitRefusal;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** "Mon, Sep 28, 2026, 11:00 AM – 2:00 PM with Basra Yousuf" — the visit in one line (Evia's wording, used in refusals). */
export function visitLine(shift: Doc): string {
  return `${fmtDate(String(shift.date ?? ""))}, ${fmtTime(shift.startTime as string | undefined)}${shift.endTime ? ` – ${fmtTime(shift.endTime as string)}` : ""} with ${shift.clientName || "the family"}`;
}

/** The site's finishFirstText (utils/shiftStart.ts): who the open visit is with. */
export function finishFirstText(other: { clientName?: unknown } | null): string {
  const who = typeof other?.clientName === "string" ? other.clientName.trim() : "";
  return who ? `Finish your visit with ${who} first.` : "Finish your current visit first.";
}

export function scheduledStartMs(shift: Doc): number {
  // The visit's own care-location zone (stamped on it; else its address's ZIP; else Pacific) — 2026-11-09.
  return wallToInstantMs(String(shift.date ?? ""), String(shift.startTime ?? "00:00").slice(0, 5), careZoneOf(shift as Record<string, unknown>));
}

/** Minutes until the visit's scheduled start (negative once it has begun); null when the record has no usable time. */
export function startsInMinutes(shift: Doc, nowMs = Date.now()): number | null {
  const ms = scheduledStartMs(shift);
  return Number.isFinite(ms) && ms > 0 ? (ms - nowMs) / 60000 : null;
}

/** The page's isUrgent: the visit starts within 24 hours (or already started). */
export function isUrgentCancel(shift: Doc, nowMs = Date.now()): boolean {
  const startsMs = scheduledStartMs(shift);
  return Number.isFinite(startsMs) && startsMs > 0 ? (startsMs - nowMs) / (1000 * 60 * 60) <= CANCEL_URGENT_HOURS : false;
}

/** A missed visit on the Past tab: still 'scheduled' and its window has passed (the site's shiftDisplayStatus 'overdue'). */
export function isMissedVisit(shift: Doc): boolean {
  return shift.status === "scheduled" && isShiftOverdue(shift);
}

const refuse = (reason: VisitRefusalReason, message: string, extra: Partial<VisitRefusal> = {}): VisitRefusal => ({ ok: false, reason, message, ...extra });

function ownerRefusal(shift: Doc, caregiverId: string | null): VisitRefusal | null {
  if (caregiverId !== null && shift.caregiverId !== caregiverId) return refuse("not_yours", "That visit isn't yours.");
  return null;
}

function gateRefusal(block: CaregiverGateReason | null, caregiver: Doc): VisitRefusal | null {
  if (block === "membership" || block === "background") return refuse(block, caregiverGateText(block, caregiver), { caregiver });
  return null;
}

/**
 * Start Shift, the checks (the page's button conditions + the gate it swaps the
 * button for): owner → gate → one visit at a time → not overdue → inside the
 * 15-minute window. `null` = may start. A visit already in progress is not a
 * refusal — startVisit reports alreadyStarted.
 */
export function startRefusal(args: {
  shift: Doc; caregiverId: string; gateBlock: CaregiverGateReason | null; caregiver: Doc;
  otherOpen: { id: string; shift: Doc } | null; nowMs?: number;
}): VisitRefusal | null {
  const { shift, caregiverId, gateBlock, caregiver, otherOpen } = args;
  const nowMs = args.nowMs ?? Date.now();
  const owner = ownerRefusal(shift, caregiverId);
  if (owner) return owner;
  if (shift.status !== "scheduled") return refuse("not_scheduled", `That visit is ${String(shift.status)}, so it can't be started.`, { status: String(shift.status ?? "") });
  const gate = gateRefusal(gateBlock, caregiver);
  if (gate) return gate;
  // One visit at a time (founder 2026-10-07): any other visit of this caregiver still in progress — any date — blocks the start.
  if (otherOpen) return refuse("another_in_progress", finishFirstText(otherOpen.shift), { other: otherOpen });
  // The page's Start Shift button: never once the visit is overdue, and only from 15 minutes before the start.
  if (isShiftOverdue(shift)) return refuse("overdue", `That visit's time has passed (${visitLine(shift)}) — it can't be started now.`);
  const mins = startsInMinutes(shift, nowMs);
  if (mins !== null && mins > START_WINDOW_MINUTES) {
    return refuse("too_early", `Not yet — Start opens ${START_WINDOW_MINUTES} minutes before the visit (${fmtTime(shift.startTime as string | undefined)} on ${fmtDate(String(shift.date ?? ""))}).`);
  }
  return null;
}

/** End: owner, and the visit is in progress (already completed is handled by endVisit as ok). */
export function endRefusal(args: { shift: Doc; caregiverId: string }): VisitRefusal | null {
  const owner = ownerRefusal(args.shift, args.caregiverId);
  if (owner) return owner;
  if (args.shift.status !== "in-progress") return refuse("not_in_progress", `That visit hasn't been started (${String(args.shift.status)}) — only a visit in progress can be ended.`, { status: String(args.shift.status ?? "") });
  return null;
}

/** Cancel (the ✕ / Cancel Booking): owner (unless the system is cancelling), and the visit is scheduled. */
export function cancelRefusal(args: { shift: Doc; caregiverId: string | null }): VisitRefusal | null {
  const owner = ownerRefusal(args.shift, args.caregiverId);
  if (owner) return owner;
  if (args.shift.status !== "scheduled") return refuse("not_scheduled", `That shift is already ${String(args.shift.status)} — nothing to cancel.`, { status: String(args.shift.status ?? "") });
  return null;
}

/** Log Hours: owner → the visit is a MISSED one (scheduled + overdue) → the gate (the page swaps the button) → end after start. */
export function logHoursRefusal(args: {
  shift: Doc; caregiverId: string; gateBlock: CaregiverGateReason | null; caregiver: Doc;
  startedAtMs: number; completedAtMs: number;
}): VisitRefusal | null {
  const { shift } = args;
  const owner = ownerRefusal(shift, args.caregiverId);
  if (owner) return owner;
  if (shift.status !== "scheduled") return refuse("not_scheduled", `That visit is already ${String(shift.status)} — nothing to log.`, { status: String(shift.status ?? "") });
  if (!isShiftOverdue(shift)) return refuse("not_missed", "That visit hasn't happened yet — Log Hours is only for a missed visit.", { status: "scheduled" });
  const gate = gateRefusal(args.gateBlock, args.caregiver);
  if (gate) return gate;
  if (!Number.isFinite(args.startedAtMs) || !Number.isFinite(args.completedAtMs) || args.completedAtMs <= args.startedAtMs) {
    return refuse("bad_times", "The end has to be after the start.");
  }
  return null;
}

// ── Loading ──────────────────────────────────────────────────────────────────

type Loaded = { ok: true; ref: FirebaseFirestore.DocumentReference; shift: Doc } | VisitRefusal;
async function loadShift(shiftId: string): Promise<Loaded> {
  const ref = db.collection("shifts").doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) return refuse("not_found", "I can't find that visit.");
  return { ok: true, ref, shift: (snap.data() ?? {}) as Doc };
}

/** The caregiver's visits IN PROGRESS right now (any date) — the one-visit-at-a-time rule's read (hooks/useInProgressVisits.ts on the site). */
export async function loadInProgressVisits(caregiverId: string): Promise<Array<{ id: string; shift: Doc; ref: FirebaseFirestore.DocumentReference }>> {
  const snap = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "==", "in-progress").get();
  return snap.docs.filter((d) => d.data().caregiverId === caregiverId).map((d) => ({ id: d.id, shift: d.data() as Doc, ref: d.ref }));
}

async function gateFor(caregiverId: string): Promise<{ block: CaregiverGateReason | null; caregiver: Doc }> {
  const access = await checkCaregiverAccess(caregiverId);
  return { block: access.ok ? null : access.block, caregiver: access.caregiver as Doc };
}

// ── The writes ───────────────────────────────────────────────────────────────

export async function startVisit(input: { caregiverId: string; shiftId: string; nowMs?: number }): Promise<StartVisitResult> {
  const nowMs = input.nowMs ?? Date.now();
  const loaded = await loadShift(input.shiftId);
  if (!loaded.ok) return loaded;
  const { ref, shift } = loaded;
  const owner = ownerRefusal(shift, input.caregiverId);
  if (owner) return owner;
  if (shift.status === "in-progress") {
    return { ok: true, shiftId: input.shiftId, shift, alreadyStarted: true, startedAt: typeof shift.startedAt === "string" ? shift.startedAt : String(shift.startedAt ?? "") };
  }
  if (shift.status !== "scheduled") return refuse("not_scheduled", `That visit is ${String(shift.status)}, so it can't be started.`, { status: String(shift.status ?? "") });
  const [{ block, caregiver }, open] = await Promise.all([gateFor(input.caregiverId), loadInProgressVisits(input.caregiverId)]);
  const otherOpen = open.find((o) => o.id !== input.shiftId) ?? null;
  const refusal = startRefusal({ shift, caregiverId: input.caregiverId, gateBlock: block, caregiver, otherOpen: otherOpen ? { id: otherOpen.id, shift: otherOpen.shift } : null, nowMs });
  if (refusal) return refusal;
  await ref.update({ status: "in-progress", startedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, shiftId: input.shiftId, shift, alreadyStarted: false, startedAt: new Date(nowMs).toISOString() };
}

export async function endVisit(input: { caregiverId: string; shiftId: string; closingNote?: unknown; nowMs?: number }): Promise<EndVisitResult> {
  const nowMs = input.nowMs ?? Date.now();
  const loaded = await loadShift(input.shiftId);
  if (!loaded.ok) return loaded;
  const { ref, shift } = loaded;
  const owner = ownerRefusal(shift, input.caregiverId);
  if (owner) return owner;
  if (shift.status === "completed") {
    return { ok: true, shiftId: input.shiftId, shift, alreadyCompleted: true, completedAt: typeof shift.completedAt === "string" ? shift.completedAt : String(shift.completedAt ?? "") };
  }
  const refusal = endRefusal({ shift, caregiverId: input.caregiverId });
  if (refusal) return refusal;
  const notes = String(input.closingNote ?? "").trim();
  await ref.update({
    status: "completed", completedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(notes ? { completionNotes: notes } : {}),
  });
  return { ok: true, shiftId: input.shiftId, shift, alreadyCompleted: false, completedAt: new Date(nowMs).toISOString() };
}

/**
 * The ✕'s write. `caregiverId: null` is the system path (the membership lock in
 * triggers/caregiverAccountEvents.ts releases the visit to the family with the
 * same patch) — no owner check, `cancelledBy: 'system'`.
 */
export async function cancelVisit(input: { caregiverId: string | null; shiftId: string; cancelledBy?: "caregiver" | "system"; nowMs?: number }): Promise<CancelVisitResult> {
  const nowMs = input.nowMs ?? Date.now();
  const loaded = await loadShift(input.shiftId);
  if (!loaded.ok) return loaded;
  const { ref, shift } = loaded;
  const refusal = cancelRefusal({ shift, caregiverId: input.caregiverId });
  if (refusal) return refusal;
  const status = isUrgentCancel(shift, nowMs) ? "needs_replacement" as const : "cancelled" as const;
  await ref.update({ status, cancelledBy: input.cancelledBy ?? "caregiver", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, shiftId: input.shiftId, shift, status };
}

/** The Cancel Booking button: this visit + every future scheduled visit of its booking, then the booking itself when none was urgent. */
export async function cancelBooking(input: { caregiverId: string; shiftId: string; nowMs?: number }): Promise<CancelBookingResult> {
  const nowMs = input.nowMs ?? Date.now();
  const loaded = await loadShift(input.shiftId);
  if (!loaded.ok) return loaded;
  const { ref, shift } = loaded;
  const refusal = cancelRefusal({ shift, caregiverId: input.caregiverId });
  if (refusal) return refusal;
  const bookingRequestId = typeof shift.bookingRequestId === "string" && shift.bookingRequestId ? shift.bookingRequestId : null;
  const batch = db.batch();
  let anyUrgent = false;
  let count = 0;
  const applyCancel = (r: FirebaseFirestore.DocumentReference, s: Doc) => {
    const u = isUrgentCancel(s, nowMs);
    if (u) anyUrgent = true;
    count += 1;
    batch.update(r, { status: u ? "needs_replacement" : "cancelled", cancelledBy: "caregiver", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  };
  applyCancel(ref, shift);
  if (bookingRequestId) {
    const future = await db.collection("shifts")
      .where("bookingRequestId", "==", bookingRequestId)
      .where("status", "==", "scheduled")
      .where("caregiverId", "==", input.caregiverId)
      .get();
    future.docs.forEach((d) => { if (d.id !== input.shiftId && d.data().status === "scheduled" && d.data().caregiverId === input.caregiverId) applyCancel(d.ref, d.data() as Doc); });
    await batch.commit();
    // Only fully close out the booking when nothing needs a replacement — an urgent visit keeps the booking (and the family's replacement prompt) live.
    if (!anyUrgent) {
      await db.collection("booking_requests").doc(bookingRequestId).update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
  } else {
    await batch.commit();
  }
  return { ok: true, shiftId: input.shiftId, anyUrgent, count };
}

/** The Past tab's Log Hours modal, field for field. `startedAtMs` / `completedAtMs` are the actual times the caregiver entered. */
export async function logHours(input: {
  caregiverId: string; shiftId: string; startedAtMs: number; completedAtMs: number; tasksCompleted: string[]; completionNotes?: unknown;
}): Promise<LogHoursResult> {
  const loaded = await loadShift(input.shiftId);
  if (!loaded.ok) return loaded;
  const { ref, shift } = loaded;
  const owner = ownerRefusal(shift, input.caregiverId);
  if (owner) return owner;
  const { block, caregiver } = await gateFor(input.caregiverId);
  const refusal = logHoursRefusal({ shift, caregiverId: input.caregiverId, gateBlock: block, caregiver, startedAtMs: input.startedAtMs, completedAtMs: input.completedAtMs });
  if (refusal) return refusal;
  const notes = String(input.completionNotes ?? "").trim();
  await ref.update({
    status: "completed",
    startedAt: admin.firestore.Timestamp.fromMillis(input.startedAtMs),
    completedAt: admin.firestore.Timestamp.fromMillis(input.completedAtMs),
    loggedManually: true,
    tasksCompleted: Array.isArray(input.tasksCompleted) ? input.tasksCompleted.filter((k): k is string => typeof k === "string") : [],
    ...(notes ? { completionNotes: notes } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true, shiftId: input.shiftId, shift };
}
