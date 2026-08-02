// ── Childcare booking callables (plan 2026-07-22-002, U7 / R36-R40, R46) ─────
//
// v1 callables (deployed as v1-<name> via the firebase.json prefix):
//   requestChildcareBooking, acceptChildcareBooking, declineChildcareBooking,
//   cancelChildcareBooking, requestChildcareBookingChange,
//   respondChildcareBookingChange, substituteChildcareCaregiver,
//   checkInChildcareShift, checkOutChildcareShift, getChildcareBookingSafety,
//   acceptChildcareApplication, rejectChildcareApplication
//
// Every callable stacks the R21 controls in the U2/U3 order: requireAppCheck →
// Auth → Firestore-resident childcare flags (R61) → fail-closed rate limits →
// input bounds + idempotency → object-level authorization → enumeration-safe
// errors.
//
// STRUCTURAL CONTRACTS:
//   • R36: request → acceptance → conflict check → CURRENT family/provider
//     gates re-checked transactionally → payment authorization → confirmed
//     exactly once with postcondition evidence (actionEvidence receipts).
//   • AE14: payment authorization before acceptance keeps the booking
//     "requested"/"accepted" — never described as confirmed.
//   • U8 SEAM: recordChildcareBookingPaymentAuthorization() is the ONLY entry
//     for payment authorization state. This unit persists state + provider
//     correlation IDs; the actual Stripe authorize/capture/refund flows are
//     U8 and will call this function with real PaymentIntent IDs.
//   • KTD13/AE6: acceptance creates safety projection v1; substitution and
//     cancellation REVOKE FIRST (a committed revoke precedes replacement
//     validation — the intermediate revoked state is observable).
//   • R46: childcare appointments/shifts in the SHARED collections carry
//     typed recipient references + the age-band-safe display label ONLY
//     (canonicalApptFields + childcareApptFields; assertChildSafeAppointmentDoc
//     rejects child-sensitive fields structurally). They deliberately carry NO
//     billingAuthority stamp: childcare money flows are U8-owned, so the
//     senior validated-hours billing path cannot pick them up.
//   • Cross-vertical conflict (both directions): the childcare conflict check
//     reads the SAME shared appointments collection the senior check reads
//     (senior + childcare visits both live there), and childcare bookings in
//     blocking states are checked directly — a caregiver can never be
//     double-booked across verticals.
//   • Notifications from booking transitions are generic child-safe content
//     from the U9 childSafe template registry (childcare/notificationPolicy)
//     — static strings, idempotent rows, excludedUids-filtered (AE24); no
//     child name in any outbound row; display labels appear only inside
//     authenticated views.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { createHash } from "crypto";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import { checkAuthority, GuardianAuthorityError } from "./guardianAuthority";
import { getChildProfile, ChildProfileError } from "../data/childProfileRepository";
import { assertEnableableChildcareCategory } from "./jurisdictionPolicy";
import {
  recheckChildcareProviderEligibility,
  type ChildcareEligibilityResult,
  type EligibilityRecheckContext,
} from "./providerEligibility";
import { CHILDCARE_IDENTITY_SESSIONS_COLLECTION } from "./identityCallables";
import { familyChildcareObjectiveId } from "./signupIngress";
import { childcareApplicationDocId } from "./jobCallables";
import {
  applyChildcareBookingTransition,
  buildChildcareBookingDoc,
  describeChildcareBookingStatus,
  expandRecurringDates,
  isOvernightSchedule,
  normalizeChildcareBookingSchedule,
  scheduleConflictsWith,
  timesOverlap,
  BookingPolicyError,
  CONFLICT_BLOCKING_STATUSES,
  type ChildcareBookingDate,
  type ChildcareBookingDoc,
  type ChildcareBookingSchedule,
  type ChildcareBookingStatus,
  type ChildcarePaymentAuthorizationState,
} from "./bookingPolicy";
import {
  createSafetyProjectionVersion,
  readSafetyProjectionForCaregiver,
  revokeSafetyProjectionAccess,
  SafetyProjectionError,
} from "./safetyProjection";
import {
  canonicalApptFields,
  childcareApptFields,
  normalizeAppointmentDuration,
  assertChildSafeAppointmentDoc,
} from "../utils/appointmentDoc";
import {
  deliverChildcareNotification,
  type ChildcareNotificationKind,
} from "./notificationPolicy";
import {
  advanceChildcareConversationPhaseForBooking,
  ensureChildcareConversation,
  revokeChildcareConversationsForBooking,
} from "./conversationPolicy";
import { verifyPostcondition, type EvidenceReceipt } from "../agents/actionEvidence";

// ── Shared guard helpers (U2/U3 middleware idiom) ────────────────────────────

const BOOKING_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:childcare:booking:mut:",
};
const BOOKING_READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:booking:read:",
};

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

async function requireChildcareFlags(kind: "read" | "write"): Promise<void> {
  const flags = await getChildcareFlags();
  const ok = kind === "write" ? flags.writesEnabled : flags.enabled;
  if (!ok) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
    );
  }
}

async function enforceRateLimit(op: string, uid: string, config: RateLimitConfig): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, config);
  if (!result.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many requests. Please wait a moment and try again.",
    );
  }
}

/** ONE generic error for every not-found/not-authorized shape (enumeration-safe). */
function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

function invalidArgument(): functions.https.HttpsError {
  return new functions.https.HttpsError("invalid-argument", "Invalid request.");
}

function mapBookingError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof BookingPolicyError) {
    if (err.code === "invalid_input") throw invalidArgument();
    if (err.code === "stale_state_version") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This booking changed since you loaded it. Please refresh and try again.",
        { code: "stale_state_version" },
      );
    }
    if (err.code === "payment_not_authorized") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Payment authorization is required before this booking can be confirmed.",
        { code: "payment_not_authorized" },
      );
    }
    if (err.code === "invalid_transition") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This booking is not in a state where that action is possible.",
        { code: "invalid_transition" },
      );
    }
    throw permissionDenied();
  }
  if (err instanceof SafetyProjectionError) {
    if (err.code === "invalid_input") throw invalidArgument();
    if (err.code === "stale_projection") {
      // Only reachable by the CURRENT assigned, eligible caregiver — safe to
      // distinguish (the family changed safety details; a fresh version is due).
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Safety details were updated by the family. Please try again shortly.",
        { code: "stale_projection" },
      );
    }
    // no_projection / revoked / not_authorized / booking_not_active — indistinguishable.
    throw permissionDenied();
  }
  if (err instanceof GuardianAuthorityError || err instanceof ChildProfileError) {
    if ((err as { code?: string }).code === "invalid_input") throw invalidArgument();
    throw permissionDenied();
  }
  console.error("[bookingCallables] unexpected error:", err instanceof Error ? err.name : "Error");
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

// ── Doc IDs (deterministic create-once — AE15) ───────────────────────────────

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/** One booking per (client, idempotencyKey) — duplicate requests converge. */
export function childcareBookingDocId(clientUid: string, idempotencyKey: string): string {
  return `cbook_${sha1(`${clientUid}|${idempotencyKey}`)}`;
}

/** One appointment per (booking, date, startTime) — duplicate confirms converge. */
export function childcareAppointmentDocId(bookingId: string, date: string, startTime: string): string {
  return `cappt_${sha1(`${bookingId}|${date}|${startTime}`)}`;
}

/** One shift per (booking, date, startTime) — rolling generation is idempotent. */
export function childcareShiftDocId(bookingId: string, date: string, startTime: string): string {
  return `cshift_${sha1(`${bookingId}|${date}|${startTime}`)}`;
}

// ── Generic child-safe notifications (R43 — no child data, ever) ─────────────
//
// U9: unified onto the childSafe TEMPLATE REGISTRY (notificationPolicy.ts) +
// the idempotent deterministic-id writer (one event, one row — AE15) + the
// suspected-unsafe-party exclusion hook (AE24): a uid on the booking's
// excludedUids set receives nothing while other parties are notified.

async function writeChildSafeBookingNotification(
  db: Db,
  recipientUid: string,
  notification: {
    kind: ChildcareNotificationKind;
    bookingId: string;
    /** Dedupe key for this event (transition key idiom); defaults to kind. */
    eventKey?: string;
    exclusionRecord?: { excludedUids?: unknown } | null;
  },
): Promise<void> {
  await deliverChildcareNotification(
    {
      sourcePath: `booking_requests/${notification.bookingId}`,
      eventId: notification.eventKey ?? notification.kind,
      recipientUid,
      kind: notification.kind,
      data: { bookingId: notification.bookingId },
      exclusionRecord: notification.exclusionRecord ?? null,
    },
    { db },
  );
}

// ── Postcondition evidence (agents/actionEvidence.ts pattern) ────────────────

async function verifyBookingStatusPostcondition(
  actionName: string,
  bookingId: string,
  expectedStatus: ChildcareBookingStatus,
  db: Db,
  idempotencyKey?: string,
): Promise<EvidenceReceipt> {
  const receipt = await verifyPostcondition(
    actionName,
    {
      kind: "fresh_read",
      description: `booking_requests/${bookingId} has status ${expectedStatus}`,
      targetRef: () => `booking_requests/${bookingId}`,
      verify: async () => {
        const snap = await db.collection("booking_requests").doc(bookingId).get();
        const status = (snap.data() ?? {}).status;
        return {
          ok: snap.exists && status === expectedStatus,
          observed: { status: String(status ?? "missing") },
        };
      },
    },
    {},
    {},
    { db: db as admin.firestore.Firestore, idempotencyKey },
  );
  // Store a safe summary on the booking doc (never payload data).
  await db
    .collection("booking_requests")
    .doc(bookingId)
    .update({
      lastTransitionEvidence: {
        actionName: receipt.actionName,
        status: receipt.status,
        safeClaimCode: receipt.safeClaimCode,
        verifiedAt: receipt.verifiedAt,
      },
    })
    .catch(() => {});
  return receipt;
}

// ── Cross-vertical conflict check (both directions — R37/KTD12) ──────────────

/** Appointment statuses that occupy the caregiver's calendar (senior parity:
 *  the exact list agents/bookingExecutor.ts hasConflict uses). */
export const CONFLICT_APPT_STATUSES = [
  "confirmed",
  "in-progress",
  "pending_caregiver_confirmation",
] as const;

export interface BookingConflictResult {
  conflict: boolean;
  source: "appointment" | "childcare_booking" | null;
  date: string | null;
}

/** Concrete windows to check: explicit dates + the next 28 days of a recurring rule. */
export function concreteWindowsForConflict(
  schedule: ChildcareBookingSchedule,
  now: Date,
): ChildcareBookingDate[] {
  const windows = [...schedule.dates];
  if (schedule.recurring) {
    const from = now.toISOString().split("T")[0];
    const to = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    windows.push(...expandRecurringDates(schedule.recurring, from, to));
  }
  return windows;
}

/**
 * Is the caregiver already booked over any of the schedule's windows?
 * Direction 1 (any vertical → childcare): reads the SHARED appointments
 * collection, which contains senior AND childcare visits — a childcare
 * request cannot land on top of a senior visit.
 * Direction 2 is structural: confirmed childcare bookings write appointments
 * into the same collection, so the senior conflict check
 * (bookingExecutor.hasConflict) blocks senior bookings over childcare visits.
 * Pending/accepted childcare bookings (no appointments yet) are additionally
 * checked directly.
 */
export async function findChildcareBookingConflict(
  params: {
    caregiverId: string;
    schedule: ChildcareBookingSchedule;
    excludeBookingId?: string | null;
    db?: Db;
    now?: Date;
  },
): Promise<BookingConflictResult> {
  const db = params.db ?? defaultDb();
  const now = params.now ?? new Date();
  const windows = concreteWindowsForConflict(params.schedule, now);

  // 1. Shared appointments (senior + childcare), same query shape/index as
  //    the senior hasConflict (caregiverId ==, date ==, status in [...]).
  for (const window of windows) {
    const snap = await db
      .collection("appointments")
      .where("caregiverId", "==", params.caregiverId)
      .where("date", "==", window.date)
      .where("status", "in", [...CONFLICT_APPT_STATUSES])
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      if (params.excludeBookingId && d.childcareBookingId === params.excludeBookingId) continue;
      if (
        timesOverlap(
          String(d.startTime ?? "00:00"),
          String(d.endTime ?? "23:59"),
          window.startTime,
          window.endTime,
        )
      ) {
        return { conflict: true, source: "appointment", date: window.date };
      }
    }
  }

  // 2. Childcare bookings still in blocking states without appointments yet.
  const bookingSnap = await db
    .collection("booking_requests")
    .where("careVertical", "==", "child")
    .where("caregiverId", "==", params.caregiverId)
    .get();
  for (const doc of bookingSnap.docs) {
    const existing = doc.data() as Partial<ChildcareBookingDoc>;
    if (params.excludeBookingId && doc.id === params.excludeBookingId) continue;
    if (!CONFLICT_BLOCKING_STATUSES.includes(existing.status as ChildcareBookingStatus)) continue;
    const existingSchedule = existing.schedule as ChildcareBookingSchedule | undefined;
    if (!existingSchedule) continue;
    for (const window of windows) {
      if (scheduleConflictsWith(existingSchedule, window)) {
        return { conflict: true, source: "childcare_booking", date: window.date };
      }
    }
  }

  return { conflict: false, source: null, date: null };
}

function throwConflict(result: BookingConflictResult): never {
  throw new functions.https.HttpsError(
    "failed-precondition",
    "The caregiver already has a visit that overlaps this time.",
    { code: "schedule_conflict", date: result.date },
  );
}

// ── Shared family gates ──────────────────────────────────────────────────────

async function requireVerifiedFamilyIdentity(uid: string, db: Db): Promise<void> {
  const identitySnap = await db
    .collection(CHILDCARE_IDENTITY_SESSIONS_COLLECTION)
    .doc(familyChildcareObjectiveId(uid))
    .get();
  if ((identitySnap.data() ?? {}).status !== "verified") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Identity verification is required before booking childcare.",
      { code: "identity_required" },
    );
  }
}

/**
 * LIVE per-child authority gate (sibling bookings: one booking, authority per
 * child — AE1/AE4). Returns household + joined display labels. All children
 * must be active and share one household.
 */
async function requireAuthorityForChildren(
  uid: string,
  childIds: string[],
  scope: "schedule" | "cancellation",
  db: Db,
): Promise<{ householdId: string; recipientLabel: string }> {
  let householdId: string | null = null;
  const labels: string[] = [];
  for (const childId of childIds) {
    const decision = await checkAuthority(uid, childId, scope, { db });
    if (!decision.allowed) throw permissionDenied();
    const profile = await getChildProfile(childId, db);
    if (!profile || profile.state !== "active") throw permissionDenied();
    if (householdId === null) householdId = profile.householdId;
    else if (householdId !== profile.householdId) throw invalidArgument();
    labels.push(profile.displayLabel);
  }
  if (!householdId) throw invalidArgument();
  return { householdId, recipientLabel: labels.join(" & ") };
}

function requireEligible(
  eligibility: ChildcareEligibilityResult,
  code = "provider_not_eligible",
): void {
  if (!eligibility.eligible) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This caregiver is not currently eligible for childcare bookings.",
      { code },
    );
  }
}

function eligibilitySnapshotOf(
  eligibility: ChildcareEligibilityResult,
  context: EligibilityRecheckContext,
  now: Date,
): ChildcareBookingDoc["eligibilitySnapshot"] {
  return {
    context,
    eligibilityVersion: eligibility.eligibilityVersion,
    evidenceVersion: eligibility.evidenceVersion,
    at: now.toISOString(),
  };
}

async function loadChildcareBooking(
  db: Db,
  bookingId: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; booking: ChildcareBookingDoc }> {
  const ref = db.collection("booking_requests").doc(bookingId) as FirebaseFirestore.DocumentReference;
  const snap = await ref.get();
  if (!snap.exists) throw permissionDenied();
  const booking = (snap.data() ?? {}) as ChildcareBookingDoc;
  if (booking.careVertical !== "child") throw permissionDenied();
  return { ref, booking };
}

/** Transactionally apply one machine transition to a fresh read (KTD23). */
async function applyTransitionTx(
  db: Db,
  bookingId: string,
  params: Parameters<typeof applyChildcareBookingTransition>[1],
  mutate?: (next: ChildcareBookingDoc) => ChildcareBookingDoc,
): Promise<{ booking: ChildcareBookingDoc; changed: boolean }> {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("booking_requests").doc(bookingId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw permissionDenied();
    const booking = (snap.data() ?? {}) as ChildcareBookingDoc;
    if (booking.careVertical !== "child") throw permissionDenied();
    const { next, changed } = applyChildcareBookingTransition(booking, params);
    if (!changed) return { booking, changed: false };
    const finalDoc = mutate ? mutate(next) : next;
    tx.set(ref, finalDoc);
    return { booking: finalDoc, changed: true };
  });
}

// ── Appointment + shift materialization (confirmed bookings) ─────────────────

function windowDuration(startTime: string, endTime: string): number {
  return normalizeAppointmentDuration(undefined, undefined, startTime, endTime) ?? 1;
}

/**
 * Create the shared-appointments docs for a booking's concrete dates.
 * Deterministic IDs — duplicate confirmations converge (AE15). Docs carry the
 * typed recipient reference and display label ONLY (R46).
 */
export async function ensureChildcareAppointments(
  booking: ChildcareBookingDoc,
  opts: { db?: Db; now?: Date } = {},
): Promise<number> {
  const db = opts.db ?? defaultDb();
  const ts = (opts.now ?? new Date()).toISOString();
  let created = 0;
  for (const window of booking.schedule.dates) {
    const apptId = childcareAppointmentDocId(booking.bookingId, window.date, window.startTime);
    const ref = db.collection("appointments").doc(apptId);
    const durationHours = windowDuration(window.startTime, window.endTime);
    const doc: Record<string, unknown> = {
      clientId: booking.clientId,
      caregiverId: booking.caregiverId,
      caregiverName: booking.caregiverName,
      date: window.date,
      startTime: window.startTime,
      endTime: window.endTime,
      durationHours,
      ...(typeof booking.hourlyRate === "number" ? { hourlyRate: booking.hourlyRate } : {}),
      ...canonicalApptFields({
        startTime: window.startTime,
        durationHours,
        hourlyRate: booking.hourlyRate ?? undefined,
      }),
      ...childcareApptFields({
        householdId: booking.householdId,
        childIds: booking.childIds,
        displayLabel: booking.recipientLabel,
        bookingId: booking.bookingId,
      }),
      status: "confirmed",
      caregiverConfirmed: true,
      createdAt: ts,
    };
    assertChildSafeAppointmentDoc(doc, "ensureChildcareAppointments");
    const wrote = await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return false;
      tx.set(ref, doc);
      return true;
    });
    if (wrote) created++;
  }
  return created;
}

/** Cancel this booking's future shared appointments (cancellation/substitution/change). */
export async function cancelChildcareAppointments(
  bookingId: string,
  opts: { db?: Db; now?: Date; reason: string },
): Promise<number> {
  const db = opts.db ?? defaultDb();
  const ts = (opts.now ?? new Date()).toISOString();
  const snap = await db
    .collection("appointments")
    .where("childcareBookingId", "==", bookingId)
    .get();
  let cancelled = 0;
  for (const doc of snap.docs) {
    const status = (doc.data() ?? {}).status;
    if (status === "completed" || status === "cancelled") continue;
    await doc.ref.update({ status: "cancelled", cancellationReason: opts.reason, cancelledAt: ts });
    cancelled++;
  }
  return cancelled;
}

/**
 * Generate vertical-stamped shifts for a CONFIRMED recurring childcare
 * booking, `weeksAhead` out from `fromDate`. Deterministic shift IDs make the
 * rolling sweep idempotent. Shift docs are child-safe by construction: typed
 * references + display label, NO address / care needs / emergency contact
 * (the senior shiftBase fields never appear here — R46).
 */
export async function generateChildcareShiftsForBooking(
  booking: ChildcareBookingDoc,
  opts: { db?: Db; now?: Date; weeksAhead?: number } = {},
): Promise<number> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = now.toISOString();
  if (!booking.schedule.recurring) return 0;
  if (booking.status !== "confirmed" && booking.status !== "in_progress") return 0;

  const from = now.toISOString().split("T")[0];
  const to = new Date(now.getTime() + (opts.weeksAhead ?? 2) * 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const windows = expandRecurringDates(booking.schedule.recurring, from, to);

  let created = 0;
  for (const window of windows) {
    const shiftId = childcareShiftDocId(booking.bookingId, window.date, window.startTime);
    const ref = db.collection("shifts").doc(shiftId);
    const doc: Record<string, unknown> = {
      careVertical: "child",
      recipientRef: {
        careVertical: "child",
        householdId: booking.householdId,
        childIds: booking.childIds,
      },
      recipientLabel: booking.recipientLabel,
      clientId: booking.clientId,
      caregiverId: booking.caregiverId,
      caregiverName: booking.caregiverName,
      date: window.date,
      startTime: window.startTime,
      endTime: window.endTime,
      status: "scheduled",
      rate: booking.hourlyRate ?? null,
      bookingRequestId: booking.bookingId,
      recurringWeekly: true,
      createdAt: ts,
    };
    assertChildSafeAppointmentDoc(doc, "generateChildcareShiftsForBooking");
    const wrote = await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return false;
      tx.set(ref, doc);
      return true;
    });
    if (wrote) created++;
  }
  return created;
}

// ── Trigger seam (scheduled/shiftGenerator.ts guarded childcare branch) ──────

/**
 * The ONLY childcare handler the shiftGenerator booking_requests trigger
 * calls (guarded on careVertical === "child" BEFORE any senior logic). Flag-
 * gated, never throws into the trigger, and never touches senior fields.
 */
export async function handleChildcareBookingRequestWrite(
  bookingId: string,
  after: Record<string, unknown> | null,
  opts: { db?: Db; now?: Date } = {},
): Promise<void> {
  try {
    if (!after || after.careVertical !== "child") return;
    const flags = await getChildcareFlags().catch(() => null);
    if (!flags?.enabled) return;
    if (after.status !== "confirmed" && after.status !== "in_progress") return;
    const booking = { ...(after as unknown as ChildcareBookingDoc), bookingId };
    const { enqueueShiftGenerationOperation } = await import("./shiftGenerationOperations");
    await enqueueShiftGenerationOperation(booking, opts as { db?: FirebaseFirestore.Firestore; now?: Date });
  } catch (err) {
    console.error(
      "[bookingCallables] childcare booking-write handler error (senior path unaffected):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Scheduled sweep: top up shifts for every ACTIVE recurring childcare booking
 * (the senior generateRollingShifts query selects status=='accepted' and can
 * never see childcare's 'confirmed'/'in_progress'). Flag-gated; never throws.
 * Query contract Q35 (careVertical + status).
 */
export async function sweepChildcareRollingShifts(
  opts: { db?: Db; now?: Date } = {},
): Promise<number> {
  try {
    const flags = await getChildcareFlags().catch(() => null);
    if (!flags?.enabled) return 0;
    const { reconcileAndProcessChildcareShiftGeneration } = await import("./shiftGenerationOperations");
    const result = await reconcileAndProcessChildcareShiftGeneration({
      db: (opts.db ?? defaultDb()) as unknown as FirebaseFirestore.Firestore,
      now: opts.now,
    });
    return result.processed;
  } catch (err) {
    console.error(
      "[bookingCallables] childcare rolling sweep error (senior path unaffected):",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

/**
 * Rolling top-up for one childcare booking (scheduled generateRollingShifts
 * guarded branch). Idempotent via deterministic shift IDs.
 */
export async function ensureChildcareRollingShifts(
  bookingId: string,
  bookingData: Record<string, unknown>,
  opts: { db?: Db; now?: Date } = {},
): Promise<number> {
  try {
    if (bookingData.careVertical !== "child") return 0;
    const flags = await getChildcareFlags().catch(() => null);
    if (!flags?.enabled) return 0;
    const booking = { ...(bookingData as unknown as ChildcareBookingDoc), bookingId };
    return await generateChildcareShiftsForBooking(booking, { ...opts, weeksAhead: 2 });
  } catch (err) {
    console.error(
      "[bookingCallables] childcare rolling-shift error (senior path unaffected):",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

// ── Confirmation flow (system transition — R36 order enforced by the machine) ─

async function confirmChildcareBookingIfReady(
  bookingId: string,
  db: Db,
  now: Date,
): Promise<{ confirmed: boolean; booking: ChildcareBookingDoc | null }> {
  const { booking } = await loadChildcareBooking(db, bookingId);
  if (booking.status !== "accepted") return { confirmed: false, booking };
  if (booking.paymentAuthorization?.state !== "authorized") return { confirmed: false, booking };

  const { booking: confirmed, changed } = await db.runTransaction(async (tx) => {
    const ref = db.collection("booking_requests").doc(bookingId);
    const freshSnap = await tx.get(ref);
    if (!freshSnap.exists) throw permissionDenied();
    const fresh = freshSnap.data() as ChildcareBookingDoc;
    const transition = applyChildcareBookingTransition(fresh, {
      event: "confirm",
      actor: "system",
      byUid: "system:payment_authorized",
      transitionKey: `confirm:${bookingId}:${fresh.paymentAuthorization?.correlationId ?? "none"}`,
      now,
    });
    if (!transition.changed) return { booking: fresh, changed: false };
    const {
      enqueueShiftGenerationInTransaction,
      readShiftGenerationOperationInTransaction,
    } = await import("./shiftGenerationOperations");
    // ALL reads before ANY write (Firestore transaction rule). The enqueue is
    // idempotent off this snapshot: an operation that already reached a terminal
    // state is never reset back to pending.
    const existingOperation = await readShiftGenerationOperationInTransaction(
      tx as FirebaseFirestore.Transaction,
      db as unknown as FirebaseFirestore.Firestore,
      transition.next,
    );
    tx.set(ref, transition.next);
    enqueueShiftGenerationInTransaction(
      tx as FirebaseFirestore.Transaction,
      db as unknown as FirebaseFirestore.Firestore,
      transition.next,
      now,
      existingOperation,
    );
    return { booking: transition.next, changed: true };
  });
  if (changed) {
    await ensureChildcareAppointments(confirmed, { db, now });
    await verifyBookingStatusPostcondition("childcare_booking_confirm", bookingId, "confirmed", db);
    // U9: the booking-context conversation advances to the confirmed
    // disclosure phase on the exactly-once confirm transition (R42), and the
    // room is server-ensured so both parties can coordinate immediately.
    try {
      await ensureChildcareConversation(
        {
          contextType: "booking",
          contextId: bookingId,
          householdId: confirmed.householdId,
          childIds: confirmed.childIds,
          participants: [confirmed.clientId, confirmed.caregiverId],
          participantNames: ["Family", confirmed.caregiverName],
          disclosurePhase: "confirmed_booking",
          now,
        },
        { db },
      );
      await advanceChildcareConversationPhaseForBooking(bookingId, { db, now });
    } catch (err) {
      console.error(
        "[bookingCallables] conversation ensure/phase error (confirm committed):",
        err instanceof Error ? err.message : err,
      );
    }
    await writeChildSafeBookingNotification(db, confirmed.clientId, {
      kind: "childcare_booking_confirmed_family",
      bookingId,
      eventKey: `confirm:${bookingId}`,
      exclusionRecord: confirmed,
    });
    await writeChildSafeBookingNotification(db, confirmed.caregiverId, {
      kind: "childcare_booking_confirmed_provider",
      bookingId,
      eventKey: `confirm:${bookingId}`,
      exclusionRecord: confirmed,
    });
    await logAudit({
      eventType: "childcare_booking_confirmed",
      userId: confirmed.clientId,
      data: { bookingId },
    }).catch(() => {});
    // U8/R45: record the child-vertical hire outcome in the per-vertical
    // reputation fields (NEVER the senior unprefixed fields). Exactly-once by
    // riding the `changed` flag of the exactly-once confirm transition.
    try {
      const { recordCaregiverOutcome } = await import("../ai/caregiverReputation");
      await recordCaregiverOutcome(
        db as unknown as admin.firestore.Firestore,
        confirmed.caregiverId,
        "hire",
        now.getTime(),
        "child",
      );
    } catch (err) {
      console.error(
        "[bookingCallables] childcare hire-outcome error (confirm committed):",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { confirmed: changed || confirmed.status === "confirmed", booking: confirmed };
}

// ── U8 payment seam ──────────────────────────────────────────────────────────

/**
 * THE payment-authorization entry point (U8 seam — documented contract).
 * Persists the authorization STATE + provider correlation ID idempotently and
 * advances an ACCEPTED booking to confirmed when authorization lands. A
 * booking still awaiting provider acceptance stays "requested" — payment can
 * never make care look confirmed (AE14). No Stripe call happens here; U8's
 * charge/capture flows call this with real PaymentIntent correlation IDs.
 */
export async function recordChildcareBookingPaymentAuthorization(
  params: {
    bookingId: string;
    state: Exclude<ChildcarePaymentAuthorizationState, "none">;
    correlationId: string | null;
  },
  opts: { db?: Db; now?: Date } = {},
): Promise<{ booking: ChildcareBookingDoc; confirmed: boolean }> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const bookingId = String(params.bookingId ?? "").trim();
  if (!bookingId) throw new BookingPolicyError("invalid_input");

  const updated = await db.runTransaction(async (tx) => {
    const ref = db.collection("booking_requests").doc(bookingId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new BookingPolicyError("invalid_input", "booking not found");
    const booking = (snap.data() ?? {}) as ChildcareBookingDoc;
    if (booking.careVertical !== "child") throw new BookingPolicyError("invalid_input");
    const prior = booking.paymentAuthorization;
    if (prior?.state === params.state && prior?.correlationId === (params.correlationId ?? null)) {
      return booking; // idempotent replay
    }
    const next: ChildcareBookingDoc = {
      ...booking,
      paymentAuthorization: {
        state: params.state,
        correlationId: params.correlationId ?? null,
        updatedAt: now.toISOString(),
      },
      updatedAt: now.toISOString(),
    };
    tx.set(ref, next);
    return next;
  });

  const { confirmed, booking } = await confirmChildcareBookingIfReady(bookingId, db, now);
  return { booking: booking ?? updated, confirmed };
}

// ── requestChildcareBooking ──────────────────────────────────────────────────

export const requestChildcareBooking = childcareOnCall("requestChildcareBooking", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("requestChildcareBooking", uid, BOOKING_MUTATION_RATE);

  const idempotencyKey = String(data?.idempotencyKey ?? "").trim();
  const applicationId = String(data?.applicationId ?? "").trim() || null;
  let caregiverId = String(data?.caregiverId ?? "").trim();
  const rawChildIds = Array.isArray(data?.childIds) ? data.childIds : null;
  if (!idempotencyKey || idempotencyKey.length > 128) throw invalidArgument();
  if (!rawChildIds || rawChildIds.length === 0 || rawChildIds.length > 6) throw invalidArgument();
  const childIds: string[] = [
    ...new Set(rawChildIds.map((c: unknown) => String(c ?? "").trim())),
  ].filter((c): c is string => Boolean(c));
  if (childIds.length === 0) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();

    // Family gates: identity + LIVE per-child schedule authority (R17/R36).
    await requireVerifiedFamilyIdentity(uid, db);
    const { householdId, recipientLabel } = await requireAuthorityForChildren(
      uid,
      childIds,
      "schedule",
      db,
    );

    // Booking source: an ACCEPTED application, or a direct caregiver match.
    let jobId: string | null = null;
    if (applicationId) {
      const appSnap = await db.collection("job_applications").doc(applicationId).get();
      const application = (appSnap.data() ?? {}) as Record<string, unknown>;
      if (
        !appSnap.exists ||
        application.careVertical !== "child" ||
        application.clientId !== uid ||
        application.status !== "accepted"
      ) {
        throw permissionDenied();
      }
      caregiverId = String(application.caregiverId ?? "");
      jobId = (application.jobId as string | undefined) ?? null;
    }
    if (!caregiverId || caregiverId.length > 128) throw invalidArgument();

    // Schedule + deferred-category block (overnight is policy-blocked — R37).
    const schedule = normalizeChildcareBookingSchedule(data?.schedule);
    if (isOvernightSchedule(schedule)) {
      try {
        assertEnableableChildcareCategory("overnight_care");
      } catch {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Overnight childcare is not available yet.",
          { code: "deferred_category" },
        );
      }
    }
    const hourlyRate = Number(data?.hourlyRate);

    // Provider gate: R29 recheck at the booking_request transition.
    const eligibility = await recheckChildcareProviderEligibility(caregiverId, {
      context: "booking_request",
      db,
    });
    requireEligible(eligibility);

    // Conflict check — both verticals (shared appointments + childcare bookings).
    const bookingId = childcareBookingDocId(uid, idempotencyKey);
    const conflict = await findChildcareBookingConflict({
      caregiverId,
      schedule,
      excludeBookingId: bookingId,
      db,
      now,
    });
    if (conflict.conflict) throwConflict(conflict);

    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const caregiverName = String((cgSnap.data() ?? {}).name ?? "Caregiver");

    const doc = buildChildcareBookingDoc({
      bookingId,
      clientId: uid,
      caregiverId,
      caregiverName,
      householdId,
      childIds,
      recipientLabel,
      schedule,
      hourlyRate: Number.isFinite(hourlyRate) && hourlyRate > 0 ? hourlyRate : null,
      jobId,
      applicationId,
      requestTransitionKey: `request:${bookingId}`,
      eligibilitySnapshot: eligibilitySnapshotOf(eligibility, "booking_request", now),
      now,
    });

    // Duplicate request idempotency: create-once on the deterministic ID.
    const ref = db.collection("booking_requests").doc(bookingId);
    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return false;
      tx.set(ref, doc);
      return true;
    });

    if (created) {
      await writeChildSafeBookingNotification(db, caregiverId, {
        kind: "childcare_booking_request",
        bookingId,
        eventKey: `request:${bookingId}`,
        exclusionRecord: doc,
      });
      await verifyBookingStatusPostcondition(
        "childcare_booking_request",
        bookingId,
        "requested",
        db,
        idempotencyKey,
      );
      await logAudit({
        eventType: "childcare_booking_requested",
        userId: uid,
        data: { bookingId, caregiverId, childCount: childIds.length },
      }).catch(() => {});
    }

    const stored = created ? doc : ((await ref.get()).data() as ChildcareBookingDoc);
    return {
      success: true,
      bookingId,
      created,
      status: stored.status,
      statusDescription: describeChildcareBookingStatus(
        stored.status,
        stored.paymentAuthorization?.state,
      ),
    };
  } catch (err) {
    mapBookingError(err);
  }
});

// ── acceptChildcareBooking / declineChildcareBooking (provider side) ─────────

export const acceptChildcareBooking = childcareOnCall("acceptChildcareBooking", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("acceptChildcareBooking", uid, BOOKING_MUTATION_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  const expectedStateVersion = data?.expectedStateVersion != null ? Number(data.expectedStateVersion) : null;
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();
    const { booking } = await loadChildcareBooking(db, bookingId);
    if (booking.caregiverId !== uid) throw permissionDenied();

    // R29 recheck at ACCEPTANCE (payout-sensitive). Screening expiry between
    // request and acceptance blocks HERE.
    const eligibility = await recheckChildcareProviderEligibility(uid, {
      context: "acceptance",
      db,
    });
    requireEligible(eligibility);

    // Conflict RE-check at acceptance (something may have booked since request).
    const conflict = await findChildcareBookingConflict({
      caregiverId: uid,
      schedule: booking.schedule,
      excludeBookingId: bookingId,
      db,
      now,
    });
    if (conflict.conflict) throwConflict(conflict);

    const { booking: accepted, changed } = await applyTransitionTx(
      db,
      bookingId,
      {
        event: "accept",
        actor: "provider",
        byUid: uid,
        transitionKey: `accept:${bookingId}`,
        now,
        expectedStateVersion,
      },
      (next) => ({
        ...next,
        eligibilitySnapshot: eligibilitySnapshotOf(eligibility, "acceptance", now),
      }),
    );

    // Acceptance creates safety projection v1 and grants the caregiver (R38).
    // Runs on IDEMPOTENT REPLAYS too when the pointer is missing (a retry
    // after a crash between the transition commit and the projection write
    // still converges to accepted-with-projection — AE15).
    const pointerSnap = await db.collection("childcare_booking_safety").doc(bookingId).get();
    if (changed || (!pointerSnap.exists && accepted.status === "accepted")) {
      const projection = await createSafetyProjectionVersion(
        {
          bookingId,
          childIds: accepted.childIds,
          assignedCaregiverUid: uid,
          createdByUid: uid,
        },
        { db, now },
      );
      await db
        .collection("booking_requests")
        .doc(bookingId)
        .update({ safetyAccessVersion: projection.pointer.accessVersion })
        .catch(() => {});
    }
    if (changed) {
      await verifyBookingStatusPostcondition("childcare_booking_accept", bookingId, "accepted", db);
      await writeChildSafeBookingNotification(db, accepted.clientId, {
        kind: "childcare_booking_accepted",
        bookingId,
        eventKey: `accept:${bookingId}`,
        exclusionRecord: accepted,
      });
      await logAudit({
        eventType: "childcare_booking_accepted",
        userId: uid,
        data: { bookingId },
      }).catch(() => {});
      // AE22 (U10): the caregiver now has an active childcare engagement —
      // their agent session is memory-denied while the context flag is set so
      // childcare qualifications discussed over SMS never enter general memory.
      // Best-effort; never blocks the acceptance.
      try {
        const { markCaregiverChildcareContext } = await import("../memory/memoryEligibility");
        await markCaregiverChildcareContext(uid);
      } catch { /* best-effort */ }
    }

    // Payment already authorized (family pre-authorized) → confirm now.
    const { booking: finalBooking } = await confirmChildcareBookingIfReady(bookingId, db, now);
    const current = finalBooking ?? accepted;
    return {
      success: true,
      bookingId,
      status: current.status,
      statusDescription: describeChildcareBookingStatus(
        current.status,
        current.paymentAuthorization?.state,
      ),
    };
  } catch (err) {
    mapBookingError(err);
  }
});

export const declineChildcareBooking = childcareOnCall("declineChildcareBooking", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("declineChildcareBooking", uid, BOOKING_MUTATION_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();
    const { booking } = await loadChildcareBooking(db, bookingId);
    if (booking.caregiverId !== uid) throw permissionDenied();

    const { booking: declined, changed } = await applyTransitionTx(db, bookingId, {
      event: "decline",
      actor: "provider",
      byUid: uid,
      transitionKey: `decline:${bookingId}`,
      now,
    });
    if (changed) {
      await verifyBookingStatusPostcondition("childcare_booking_decline", bookingId, "declined", db);
      await writeChildSafeBookingNotification(db, declined.clientId, {
        kind: "childcare_booking_declined",
        bookingId,
        eventKey: `decline:${bookingId}`,
        exclusionRecord: declined,
      });
      await logAudit({
        eventType: "childcare_booking_declined",
        userId: uid,
        data: { bookingId },
      }).catch(() => {});
    }
    return { success: true, bookingId, status: declined.status };
  } catch (err) {
    mapBookingError(err);
  }
});

// ── cancelChildcareBooking (either side per scope; REVOKE FIRST — AE6) ───────

export const cancelChildcareBooking = childcareOnCall("cancelChildcareBooking", async (data, context) => {
  const uid = requireAuth(context);
  await enforceRateLimit("cancelChildcareBooking", uid, BOOKING_MUTATION_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    return await cancelChildcareBookingCore(uid, bookingId);
  } catch (err) {
    mapBookingError(err);
  }
});

/**
 * U10: shared cancel core — the SINGLE cancellation logic path used by both
 * the web callable above and the Evia MCP tool (mcp/childcareTools.ts).
 * Action-time authorization (assigned provider OR live `cancellation` scope
 * for every child) and the runtime flags recheck live HERE, inside the
 * mutation, so no caller can skip them (R51/R52 — never trust the envelope
 * alone at mutation time).
 */
export async function cancelChildcareBookingCore(
  uid: string,
  bookingId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<{ success: true; bookingId: string; status: string }> {
  await requireChildcareFlags("write");
  {
    const db = opts.db ?? defaultDb();
    const now = opts.now ?? new Date();
    const { booking } = await loadChildcareBooking(db, bookingId);

    // Actor resolution: assigned provider, or a family adult holding LIVE
    // `cancellation` scope for EVERY child on the booking.
    let actor: "family" | "provider";
    if (booking.caregiverId === uid) {
      actor = "provider";
    } else {
      await requireAuthorityForChildren(uid, booking.childIds, "cancellation", db);
      actor = "family";
    }

    // REVOKE FIRST (AE6): safety + file access die before the cancellation
    // persists — never a window where a canceled booking still grants access.
    await revokeSafetyProjectionAccess(bookingId, {
      db,
      now,
      reason: "booking_canceled",
      byUid: uid,
    });
    // U9 (R42): conversation access dies with the booking — the room is
    // revoked (no more writes) and the CAREGIVER drops off the participant
    // list (read access dies too); the family keeps their own history.
    // Exact-address access already died with the safety revoke above (the
    // coordination projection rides the same accessVersion).
    await revokeChildcareConversationsForBooking(bookingId, {
      db,
      now,
      reason: "booking_canceled",
      revokeUid: booking.caregiverId,
    });

    const { booking: canceled, changed } = await applyTransitionTx(
      db,
      bookingId,
      {
        event: "cancel",
        actor,
        byUid: uid,
        transitionKey: `cancel:${bookingId}:${uid}`,
        now,
      },
      (next) => ({ ...next, safetyAccessVersion: null }),
    );

    if (changed) {
      await cancelChildcareAppointments(bookingId, { db, now, reason: "booking_canceled" });
      await cancelChildcareShifts(bookingId, { db, now, reason: "booking_canceled" });
      // U8: record the POLICY cancellation outcome (windows/percentages from
      // the frozen jurisdiction pricing snapshot) and move a live payment
      // authorization to "canceled" through the documented seam. Never
      // auto-charges; never throws into the committed cancel.
      try {
        const { evaluateAndRecordChildcareCancellation } = await import("./shiftPayments");
        await evaluateAndRecordChildcareCancellation(bookingId, { db, now, byUid: uid });
      } catch (err) {
        console.error(
          "[bookingCallables] childcare cancellation-outcome error (cancel committed):",
          err instanceof Error ? err.message : err,
        );
      }
      await verifyBookingStatusPostcondition("childcare_booking_cancel", bookingId, "canceled", db);
      const counterpartUid = actor === "provider" ? canceled.clientId : canceled.caregiverId;
      await writeChildSafeBookingNotification(db, counterpartUid, {
        kind: "childcare_booking_canceled",
        bookingId,
        eventKey: `cancel:${bookingId}`,
        exclusionRecord: canceled,
      });
      await logAudit({
        eventType: "childcare_booking_canceled",
        userId: uid,
        data: { bookingId, actor },
      }).catch(() => {});
      // AE22 restore: cancellation releases the caregiver, so lift their memory
      // denial if this was their last live childcare booking (fail-closed).
      if (canceled.caregiverId) {
        const { clearCaregiverChildcareContextIfIdle } = await import("../memory/memoryEligibility");
        await clearCaregiverChildcareContextIfIdle(canceled.caregiverId);
      }
    }
    return { success: true, bookingId, status: canceled.status };
  }
}

/** Cancel this booking's scheduled vertical-stamped shifts. */
export async function cancelChildcareShifts(
  bookingId: string,
  opts: { db?: Db; now?: Date; reason: string },
): Promise<number> {
  const db = opts.db ?? defaultDb();
  const ts = (opts.now ?? new Date()).toISOString();
  const snap = await db
    .collection("shifts")
    .where("bookingRequestId", "==", bookingId)
    .where("careVertical", "==", "child")
    .get();
  let cancelled = 0;
  for (const doc of snap.docs) {
    const status = (doc.data() ?? {}).status;
    if (status !== "scheduled") continue;
    await doc.ref.update({ status: "cancelled", cancellationReason: opts.reason, cancelledAt: ts });
    cancelled++;
  }
  return cancelled;
}

// ── requestChildcareBookingChange / respondChildcareBookingChange (R37) ──────

export const requestChildcareBookingChange = childcareOnCall("requestChildcareBookingChange", async (data, context) => {
  const uid = requireAuth(context);
  await enforceRateLimit("requestChildcareBookingChange", uid, BOOKING_MUTATION_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  const changeKey = String(data?.idempotencyKey ?? "").trim();
  if (!bookingId || bookingId.length > 128 || !changeKey || changeKey.length > 128) {
    throw invalidArgument();
  }

  try {
    return await requestChildcareBookingChangeCore(uid, {
      bookingId,
      changeKey,
      schedule: data?.schedule,
    });
  } catch (err) {
    mapBookingError(err);
  }
});

/**
 * U10: shared change-request core — the SINGLE schedule-change logic path used
 * by both the web callable above and the Evia MCP tool. Action-time authority
 * (`schedule` scope for every child), provider-eligibility recheck, conflict
 * revalidation, and the runtime flags recheck all live HERE (R37/R51/R52).
 */
export async function requestChildcareBookingChangeCore(
  uid: string,
  params: { bookingId: string; changeKey: string; schedule: unknown },
  opts: { db?: Db; now?: Date } = {},
): Promise<{ success: true; bookingId: string; applied: boolean; pending: boolean }> {
  await requireChildcareFlags("write");
  const bookingId = params.bookingId;
  const changeKey = params.changeKey;
  {
    const db = opts.db ?? defaultDb();
    const now = opts.now ?? new Date();
    const { ref, booking } = await loadChildcareBooking(db, bookingId);
    if (booking.clientId !== uid) throw permissionDenied();
    await requireAuthorityForChildren(uid, booking.childIds, "schedule", db);

    if (!["requested", "accepted", "confirmed"].includes(booking.status)) {
      throw new BookingPolicyError("invalid_transition", "booking is not changeable");
    }

    // Revalidate EVERYTHING at the new times (R37): overnight block, provider
    // eligibility, cross-vertical conflicts.
    const schedule = normalizeChildcareBookingSchedule(params.schedule);
    if (isOvernightSchedule(schedule)) {
      try {
        assertEnableableChildcareCategory("overnight_care");
      } catch {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Overnight childcare is not available yet.",
          { code: "deferred_category" },
        );
      }
    }
    const eligibility = await recheckChildcareProviderEligibility(booking.caregiverId, {
      context: "booking_request",
      db,
    });
    requireEligible(eligibility);
    const conflict = await findChildcareBookingConflict({
      caregiverId: booking.caregiverId,
      schedule,
      excludeBookingId: bookingId,
      db,
      now,
    });
    if (conflict.conflict) throwConflict(conflict);

    if ((booking.appliedTransitionKeys ?? []).includes(`change:${changeKey}`)) {
      return { success: true, bookingId, applied: booking.status === "requested", pending: booking.pendingChange !== null };
    }

    const ts = now.toISOString();
    if (booking.status === "requested") {
      // Pre-acceptance: the family may amend their own request directly.
      const next: ChildcareBookingDoc = {
        ...booking,
        schedule,
        stateVersion: booking.stateVersion + 1,
        appliedTransitionKeys: [...(booking.appliedTransitionKeys ?? []), `change:${changeKey}`].slice(-20),
        lastTransition: { event: "change", byUid: uid, actor: "family", transitionKey: `change:${changeKey}`, at: ts },
        updatedAt: ts,
      };
      await ref.set(next);
      return { success: true, bookingId, applied: true, pending: false };
    }

    // Post-acceptance: the change is PENDING until the provider re-accepts.
    const next: ChildcareBookingDoc = {
      ...booking,
      pendingChange: { schedule, requestedByUid: uid, requestedAt: ts, changeKey },
      stateVersion: booking.stateVersion + 1,
      appliedTransitionKeys: [...(booking.appliedTransitionKeys ?? []), `change:${changeKey}`].slice(-20),
      lastTransition: { event: "change", byUid: uid, actor: "family", transitionKey: `change:${changeKey}`, at: ts },
      updatedAt: ts,
    };
    await ref.set(next);
    await writeChildSafeBookingNotification(db, booking.caregiverId, {
      kind: "childcare_booking_change_requested",
      bookingId,
      eventKey: `change:${changeKey}`,
      exclusionRecord: booking,
    });
    return { success: true, bookingId, applied: false, pending: true };
  }
}

export const respondChildcareBookingChange = childcareOnCall("respondChildcareBookingChange", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("respondChildcareBookingChange", uid, BOOKING_MUTATION_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  const accept = data?.accept === true;
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();
    const { ref, booking } = await loadChildcareBooking(db, bookingId);
    if (booking.caregiverId !== uid) throw permissionDenied();
    const pending = booking.pendingChange;
    if (!pending) {
      throw new BookingPolicyError("invalid_transition", "no pending change");
    }

    const ts = now.toISOString();
    if (!accept) {
      await ref.update({ pendingChange: null, updatedAt: ts });
      await writeChildSafeBookingNotification(db, booking.clientId, {
        kind: "childcare_booking_change_declined",
        bookingId,
        eventKey: `change_declined:${pending.changeKey}`,
        exclusionRecord: booking,
      });
      return { success: true, bookingId, applied: false };
    }

    // Accepting a change REVALIDATES like an acceptance (R37).
    const eligibility = await recheckChildcareProviderEligibility(uid, {
      context: "acceptance",
      db,
    });
    requireEligible(eligibility);
    const conflict = await findChildcareBookingConflict({
      caregiverId: uid,
      schedule: pending.schedule,
      excludeBookingId: bookingId,
      db,
      now,
    });
    if (conflict.conflict) throwConflict(conflict);

    const next: ChildcareBookingDoc = {
      ...booking,
      schedule: pending.schedule,
      pendingChange: null,
      stateVersion: booking.stateVersion + 1,
      eligibilitySnapshot: eligibilitySnapshotOf(eligibility, "acceptance", now),
      lastTransition: {
        event: "change",
        byUid: uid,
        actor: "provider",
        transitionKey: `change_applied:${pending.changeKey}`,
        at: ts,
      },
      appliedTransitionKeys: [
        ...(booking.appliedTransitionKeys ?? []),
        `change_applied:${pending.changeKey}`,
      ].slice(-20),
      updatedAt: ts,
    };
    await ref.set(next);

    // Re-materialize the calendar for confirmed bookings.
    if (next.status === "confirmed") {
      await cancelChildcareAppointments(bookingId, { db, now, reason: "schedule_changed" });
      await cancelChildcareShifts(bookingId, { db, now, reason: "schedule_changed" });
      await ensureChildcareAppointments(next, { db, now });
      await generateChildcareShiftsForBooking(next, { db, now });
    }
    await writeChildSafeBookingNotification(db, booking.clientId, {
      kind: "childcare_booking_change_accepted",
      bookingId,
      eventKey: `change_applied:${pending.changeKey}`,
      exclusionRecord: booking,
    });
    return { success: true, bookingId, applied: true };
  } catch (err) {
    mapBookingError(err);
  }
});

// ── substituteChildcareCaregiver (revoke old FIRST — AE6 ordering) ───────────

export const substituteChildcareCaregiver = childcareOnCall("substituteChildcareCaregiver", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("substituteChildcareCaregiver", uid, BOOKING_MUTATION_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  const newCaregiverId = String(data?.newCaregiverId ?? "").trim();
  const substitutionKey = String(data?.idempotencyKey ?? "").trim();
  if (
    !bookingId || bookingId.length > 128 ||
    !newCaregiverId || newCaregiverId.length > 128 ||
    !substitutionKey || substitutionKey.length > 128
  ) {
    throw invalidArgument();
  }

  try {
    const db = defaultDb();
    const now = new Date();
    const { ref, booking } = await loadChildcareBooking(db, bookingId);

    // Family authorization required (R37/AE6) — `schedule` scope per child.
    if (booking.clientId !== uid) throw permissionDenied();
    await requireAuthorityForChildren(uid, booking.childIds, "schedule", db);

    // Idempotent replay.
    if ((booking.appliedTransitionKeys ?? []).includes(`substitute:${substitutionKey}`)) {
      return { success: true, bookingId, caregiverId: booking.caregiverId, substituted: booking.caregiverId === newCaregiverId };
    }
    if (!["accepted", "confirmed"].includes(booking.status)) {
      throw new BookingPolicyError("invalid_transition", "booking is not substitutable");
    }
    if (booking.caregiverId === newCaregiverId) throw invalidArgument();

    const previousCaregiverUid = booking.caregiverId;
    const ts = now.toISOString();

    // ── STEP 1 (committed BEFORE validation): revoke the old caregiver. ──
    // AE6: the old caregiver loses safety, file, chat, and exact-address
    // access BEFORE the replacement is granted anything. If step 2 fails we
    // stay in this observable revoked_pending_replacement state (fail safe).
    await revokeSafetyProjectionAccess(bookingId, {
      db,
      now,
      reason: "substitution",
      byUid: uid,
    });
    // U9 (R42/AE6): the OLD caregiver's conversation access dies in step 1 —
    // room revoked + uid off the participant list. The replacement gets a
    // NEW room in step 3 (context key includes the participant set, so the
    // fresh pair can never resurrect the old room).
    await revokeChildcareConversationsForBooking(bookingId, {
      db,
      now,
      reason: "substitution",
      revokeUid: previousCaregiverUid,
    });
    await ref.update({
      substitution: {
        state: "revoked_pending_replacement",
        previousCaregiverUid,
        revokedAt: ts,
      },
      safetyAccessVersion: null,
      updatedAt: ts,
    });

    // ── STEP 2: validate the replacement (R29 context "substitution" —
    // payout-sensitive — plus a cross-vertical conflict check). ──
    let eligibility: ChildcareEligibilityResult;
    let conflict: BookingConflictResult;
    try {
      eligibility = await recheckChildcareProviderEligibility(newCaregiverId, {
        context: "substitution",
        db,
      });
      requireEligible(eligibility, "replacement_not_eligible");
      conflict = await findChildcareBookingConflict({
        caregiverId: newCaregiverId,
        schedule: booking.schedule,
        excludeBookingId: bookingId,
        db,
        now,
      });
      if (conflict.conflict) throwConflict(conflict);
    } catch (validationErr) {
      // Old caregiver stays revoked; a human resolves (admin alert, R37).
      await db.collection("admin_alerts").add({
        type: "childcare_substitution_blocked",
        bookingId,
        previousCaregiverUid,
        attemptedCaregiverUid: newCaregiverId,
        createdAt: ts,
        resolved: false,
        priority: "high",
      }).catch(() => {});
      throw validationErr;
    }

    // ── STEP 3: assign + new safety version (fresh grant AFTER the revoke). ──
    const cgSnap = await db.collection("caregivers").doc(newCaregiverId).get();
    const newCaregiverName = String((cgSnap.data() ?? {}).name ?? "Caregiver");
    const projection = await createSafetyProjectionVersion(
      {
        bookingId,
        childIds: booking.childIds,
        assignedCaregiverUid: newCaregiverId,
        createdByUid: uid,
      },
      { db, now },
    );
    await ref.update({
      caregiverId: newCaregiverId,
      caregiverName: newCaregiverName,
      substitution: { state: "none", previousCaregiverUid, revokedAt: ts },
      safetyAccessVersion: projection.pointer.accessVersion,
      eligibilitySnapshot: eligibilitySnapshotOf(eligibility, "substitution", now),
      stateVersion: booking.stateVersion + 1,
      appliedTransitionKeys: [
        ...(booking.appliedTransitionKeys ?? []),
        `substitute:${substitutionKey}`,
      ].slice(-20),
      lastTransition: {
        event: "substitute",
        byUid: uid,
        actor: "family",
        transitionKey: `substitute:${substitutionKey}`,
        at: ts,
      },
      updatedAt: ts,
    });

    // Re-point the materialized calendar at the replacement.
    await reassignChildcareCalendar(bookingId, newCaregiverId, newCaregiverName, { db, now });

    // AE22 (U10): the replacement caregiver now holds an active childcare
    // engagement — memory-deny their agent session (best-effort, non-blocking).
    try {
      const { markCaregiverChildcareContext } = await import("../memory/memoryEligibility");
      await markCaregiverChildcareContext(newCaregiverId);
    } catch { /* best-effort */ }

    // AE22 restore: the REPLACED caregiver was released in step 1, so lift their
    // memory denial if this was their last live childcare booking. Ordered after
    // the replacement's stamp so a same-caregiver no-op substitution can never
    // clear the stamp it just set. Fail-closed on any doubt.
    if (previousCaregiverUid && previousCaregiverUid !== newCaregiverId) {
      try {
        const { clearCaregiverChildcareContextIfIdle } = await import("../memory/memoryEligibility");
        await clearCaregiverChildcareContextIfIdle(previousCaregiverUid);
      } catch { /* best-effort */ }
    }

    // U9 (R41/AE6): the replacement gets a NEW booking-context room (fresh
    // participant set ⇒ fresh deterministic key) AFTER the old caregiver's
    // access was revoked in step 1 — revoke-first ordering end to end.
    try {
      await ensureChildcareConversation(
        {
          contextType: "booking",
          contextId: bookingId,
          householdId: booking.householdId,
          childIds: booking.childIds,
          participants: [booking.clientId, newCaregiverId],
          participantNames: ["Family", newCaregiverName],
          disclosurePhase:
            booking.status === "confirmed" || booking.status === "in_progress"
              ? "confirmed_booking"
              : "pre_booking",
          now,
        },
        { db },
      );
    } catch (err) {
      console.error(
        "[bookingCallables] replacement conversation error (substitution committed):",
        err instanceof Error ? err.message : err,
      );
    }

    await writeChildSafeBookingNotification(db, previousCaregiverUid, {
      kind: "childcare_booking_unassigned",
      bookingId,
      eventKey: `substitute:${substitutionKey}:unassigned`,
      exclusionRecord: booking,
    });
    await writeChildSafeBookingNotification(db, newCaregiverId, {
      kind: "childcare_booking_assigned",
      bookingId,
      eventKey: `substitute:${substitutionKey}:assigned`,
      exclusionRecord: booking,
    });
    await logAudit({
      eventType: "childcare_booking_substituted",
      userId: uid,
      data: { bookingId, previousCaregiverUid, newCaregiverId },
    }).catch(() => {});

    return { success: true, bookingId, caregiverId: newCaregiverId, substituted: true };
  } catch (err) {
    mapBookingError(err);
  }
});

async function reassignChildcareCalendar(
  bookingId: string,
  caregiverId: string,
  caregiverName: string,
  opts: { db?: Db; now?: Date },
): Promise<void> {
  const db = opts.db ?? defaultDb();
  const apptSnap = await db
    .collection("appointments")
    .where("childcareBookingId", "==", bookingId)
    .get();
  for (const doc of apptSnap.docs) {
    const status = (doc.data() ?? {}).status;
    if (status === "completed" || status === "cancelled") continue;
    await doc.ref.update({ caregiverId, caregiverName });
  }
  const shiftSnap = await db
    .collection("shifts")
    .where("bookingRequestId", "==", bookingId)
    .where("careVertical", "==", "child")
    .get();
  for (const doc of shiftSnap.docs) {
    if ((doc.data() ?? {}).status !== "scheduled") continue;
    await doc.ref.update({ caregiverId, caregiverName });
  }
}

// ── Check-in / check-out (assigned + eligibility + state; GPS-free — R39) ────

async function requireAssignedActiveSafety(
  db: Db,
  booking: ChildcareBookingDoc,
  uid: string,
): Promise<void> {
  if (booking.caregiverId !== uid) throw permissionDenied();
  const pointerSnap = await db
    .collection("childcare_booking_safety")
    .doc(booking.bookingId)
    .get();
  const pointer = (pointerSnap.data() ?? {}) as Record<string, unknown>;
  if (
    !pointerSnap.exists ||
    pointer.state !== "active" ||
    pointer.assignedCaregiverUid !== uid ||
    (booking.safetyAccessVersion !== null &&
      Number(pointer.accessVersion) !== Number(booking.safetyAccessVersion))
  ) {
    throw permissionDenied();
  }
}

/**
 * Check-in core (shared by v1-checkInChildcareShift and the guarded childcare
 * branch of agents/gpsCheckin.ts). Assigned caregiver + CURRENT access
 * version + booking state + R29 "check_in" recheck. Throws HttpsError via
 * mapBookingError; callers own middleware (App Check / auth / flags / rate).
 */
export async function checkInChildcareBookingCore(
  params: { bookingId: string; callerUid: string },
  opts: { db?: Db; now?: Date } = {},
): Promise<{ bookingId: string; status: ChildcareBookingStatus }> {
  const bookingId = String(params.bookingId ?? "").trim();
  const uid = String(params.callerUid ?? "").trim();
  if (!bookingId || bookingId.length > 128 || !uid) throw invalidArgument();

  try {
    const db = opts.db ?? defaultDb();
    const now = opts.now ?? new Date();
    const { booking } = await loadChildcareBooking(db, bookingId);

    // Assigned caregiver + CURRENT access version + booking state (R38/R39).
    await requireAssignedActiveSafety(db, booking, uid);
    const eligibility = await recheckChildcareProviderEligibility(uid, {
      context: "check_in",
      db,
    });
    requireEligible(eligibility);

    const { booking: checkedIn, changed } = await applyTransitionTx(db, bookingId, {
      event: "check_in",
      actor: "provider",
      byUid: uid,
      transitionKey: `check_in:${bookingId}:${now.toISOString().split("T")[0]}`,
      now,
    });
    if (changed) {
      await setTodayChildcareVisitStatus(bookingId, "in-progress", { db, now });
      await verifyBookingStatusPostcondition("childcare_booking_check_in", bookingId, "in_progress", db);
      // Generic child-safe arrival notice (R43) — NO child name, NO location.
      await writeChildSafeBookingNotification(db, checkedIn.clientId, {
        kind: "childcare_shift_started",
        bookingId,
        eventKey: `check_in:${bookingId}:${now.toISOString().split("T")[0]}`,
        exclusionRecord: checkedIn,
      });
      await logAudit({
        eventType: "childcare_shift_checked_in",
        userId: uid,
        data: { bookingId },
      }).catch(() => {});
    }
    return { bookingId, status: checkedIn.status };
  } catch (err) {
    mapBookingError(err);
  }
}

export const checkInChildcareShift = childcareOnCall("checkInChildcareShift", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("checkInChildcareShift", uid, BOOKING_MUTATION_RATE);
  const result = await checkInChildcareBookingCore({
    bookingId: String(data?.bookingId ?? "").trim(),
    callerUid: uid,
  });
  return { success: true, ...result };
});

export const checkOutChildcareShift = childcareOnCall("checkOutChildcareShift", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("checkOutChildcareShift", uid, BOOKING_MUTATION_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();
    const { booking } = await loadChildcareBooking(db, bookingId);
    await requireAssignedActiveSafety(db, booking, uid);

    // Interim visit of a multi-visit/recurring booking returns to confirmed;
    // the final visit completes the booking.
    const remaining = await hasRemainingChildcareVisits(booking, { db, now });
    const event = remaining ? "check_out_visit" : "check_out";
    const target: ChildcareBookingStatus = remaining ? "confirmed" : "completed";

    const { booking: checkedOut, changed } = await applyTransitionTx(db, bookingId, {
      event,
      actor: "provider",
      byUid: uid,
      transitionKey: `${event}:${bookingId}:${now.toISOString().split("T")[0]}`,
      now,
    });
    if (changed) {
      await setTodayChildcareVisitStatus(bookingId, "completed", { db, now });
      // U8: each completed occurrence creates its OWN server-derived
      // validated-hours row (charge/transfer then run on the proven senior
      // rail). Recurring bookings complete per occurrence — the end-of-
      // occurrence lifecycle U7 deferred. Non-fatal: a billing failure never
      // un-checks-out the visit; it raises an admin alert inside the module.
      try {
        const { createChildcareValidatedShiftHoursForToday } = await import("./shiftPayments");
        await createChildcareValidatedShiftHoursForToday(
          { bookingId, actorUid: uid },
          { db, now },
        );
      } catch (err) {
        console.error(
          "[bookingCallables] childcare validated-hours error (checkout committed):",
          err instanceof Error ? err.message : err,
        );
      }
      if (!remaining) {
        // Booking complete: assigned access ends (time-bounded — R38).
        await revokeSafetyProjectionAccess(bookingId, {
          db,
          now,
          reason: "booking_completed",
          byUid: uid,
        });
        await db
          .collection("booking_requests")
          .doc(bookingId)
          .update({ safetyAccessVersion: null })
          .catch(() => {});
      }
      await verifyBookingStatusPostcondition("childcare_booking_check_out", bookingId, target, db);
      await writeChildSafeBookingNotification(db, checkedOut.clientId, {
        kind: "childcare_shift_completed",
        bookingId,
        eventKey: `check_out:${bookingId}:${now.toISOString().split("T")[0]}`,
        exclusionRecord: checkedOut,
      });
      await logAudit({
        eventType: "childcare_shift_checked_out",
        userId: uid,
        data: { bookingId, bookingCompleted: !remaining },
      }).catch(() => {});
      if (!remaining) {
        // AE22 restore: the engagement ended, so lift this caregiver's general
        // memory denial IF they hold no other live childcare booking. The helper
        // is fail-closed — it retains the stamp on any doubt.
        const { clearCaregiverChildcareContextIfIdle } = await import("../memory/memoryEligibility");
        await clearCaregiverChildcareContextIfIdle(uid);
      }
    }
    return { success: true, bookingId, status: checkedOut.status, bookingCompleted: !remaining };
  } catch (err) {
    mapBookingError(err);
  }
});

async function hasRemainingChildcareVisits(
  booking: ChildcareBookingDoc,
  opts: { db?: Db; now?: Date },
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().split("T")[0];
  if (booking.schedule.recurring) return true; // recurring bookings keep going
  return booking.schedule.dates.some((d) => d.date > today);
}

async function setTodayChildcareVisitStatus(
  bookingId: string,
  status: "in-progress" | "completed",
  opts: { db?: Db; now?: Date },
): Promise<void> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const today = now.toISOString().split("T")[0];
  const ts = now.toISOString();
  for (const collection of ["appointments", "shifts"] as const) {
    const field = collection === "appointments" ? "childcareBookingId" : "bookingRequestId";
    const snap = await db
      .collection(collection)
      .where(field, "==", bookingId)
      .where("date", "==", today)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() ?? {};
      if (collection === "shifts" && d.careVertical !== "child") continue;
      if (d.status === "cancelled" || d.status === "completed") continue;
      await doc.ref.update({
        status: collection === "shifts" && status === "in-progress" ? "in-progress" : status,
        ...(status === "in-progress" ? { checkedInAt: ts } : { checkedOutAt: ts }),
      });
    }
  }
}

// ── getChildcareBookingSafety (assigned caregiver, current version only) ─────

export const getChildcareBookingSafety = childcareOnCall("getChildcareBookingSafety", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("getChildcareBookingSafety", uid, BOOKING_READ_RATE);

  const bookingId = String(data?.bookingId ?? "").trim();
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const result = await readSafetyProjectionForCaregiver({ bookingId, callerUid: uid }, { db });
    await logAudit({
      eventType: "childcare_booking_safety_read",
      userId: uid,
      data: { bookingId, version: result.version },
    }).catch(() => {});
    return {
      success: true,
      bookingId,
      version: result.version,
      children: result.children,
    };
  } catch (err) {
    mapBookingError(err);
  }
});

// ── Application accept / reject (the U6 deferral — feeds booking requests) ───

export const acceptChildcareApplication = childcareOnCall("acceptChildcareApplication", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("acceptChildcareApplication", uid, BOOKING_MUTATION_RATE);
  return respondToChildcareApplication(uid, data, "accepted");
});

export const rejectChildcareApplication = childcareOnCall("rejectChildcareApplication", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("rejectChildcareApplication", uid, BOOKING_MUTATION_RATE);
  return respondToChildcareApplication(uid, data, "rejected");
});

async function respondToChildcareApplication(
  uid: string,
  data: unknown,
  decision: "accepted" | "rejected",
): Promise<{ success: true; applicationId: string; status: string; changed: boolean }> {
  const input = (data ?? {}) as Record<string, unknown>;
  const jobId = String(input.jobId ?? "").trim();
  const caregiverId = String(input.caregiverId ?? "").trim();
  if (!jobId || jobId.length > 128 || !caregiverId || caregiverId.length > 128) {
    throw invalidArgument();
  }

  try {
    const db = defaultDb();

    // Family gates: job ownership + identity + LIVE per-child schedule authority.
    const jobSnap = await db.collection("job_posts").doc(jobId).get();
    const job = (jobSnap.data() ?? {}) as Record<string, unknown>;
    if (!jobSnap.exists || job.careVertical !== "child" || job.clientId !== uid) {
      throw permissionDenied();
    }
    await requireVerifiedFamilyIdentity(uid, db);
    const privSnap = await db
      .collection("job_posts")
      .doc(jobId)
      .collection("private")
      .doc("children")
      .get();
    const childIds = ((privSnap.data() ?? {}).childIds ?? []) as string[];
    if (!childIds.length) throw permissionDenied();
    for (const childId of childIds) {
      const authority = await checkAuthority(uid, childId, "schedule", { db });
      if (!authority.allowed) throw permissionDenied();
    }

    const applicationId = childcareApplicationDocId(jobId, caregiverId);
    const appRef = db.collection("job_applications").doc(applicationId);
    const appSnap = await appRef.get();
    const application = (appSnap.data() ?? {}) as Record<string, unknown>;
    if (!appSnap.exists || application.careVertical !== "child") throw permissionDenied();

    // Idempotent replay: already at the requested decision → converge.
    if (application.status === decision) {
      return { success: true, applicationId, status: decision, changed: false };
    }
    if (application.status !== "pending") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This application has already been decided.",
        { code: "application_not_pending" },
      );
    }

    // Accepting requires the provider to STILL be eligible (R29).
    if (decision === "accepted") {
      const eligibility = await recheckChildcareProviderEligibility(caregiverId, {
        context: "application",
        db,
      });
      requireEligible(eligibility);
    }

    const ts = new Date().toISOString();
    await appRef.update({ status: decision, decidedAt: ts, decidedByUid: uid });
    await writeChildSafeBookingNotification(db, caregiverId, {
      kind:
        decision === "accepted"
          ? "childcare_application_accepted"
          : "childcare_application_rejected",
      bookingId: applicationId,
      eventKey: `application_${decision}:${applicationId}`,
    });
    await logAudit({
      eventType: `childcare_application_${decision}`,
      userId: uid,
      data: { jobId, applicationId, caregiverId },
    }).catch(() => {});
    return { success: true, applicationId, status: decision, changed: true };
  } catch (err) {
    mapBookingError(err);
  }
}

// Re-exported so tests/other units see the exact context list used here.
export type { EligibilityRecheckContext };
