// ── Childcare shift payments (plan 2026-07-22-002, U8 / R37-R40, AE14-AE16) ──
//
// Orchestration for childcare money: payment authorization at booking
// (SetupIntent + saved off-session payment method — the SAME saved-method rail
// the senior shift charge uses), server-derived validated hours at check-out,
// overdue-visit policy states, family refund requests, and dispute payout
// holds. The actual per-occurrence CHARGE + TRANSFER reuse the proven senior
// machinery in shiftHours.ts (processShiftPayment / settleShiftTransfer /
// billingOperations ledger / processed_stripe_events) — childcare docs enter
// it as vertical-stamped shiftHours rows with a frozen policy pricing
// snapshot; the senior path never computes a childcare fee and vice versa.
//
// STRUCTURAL CONTRACTS:
//   • U7 SEAM: recordChildcareBookingPaymentAuthorization() is the ONLY
//     writer of booking payment-authorization state — this module calls it
//     with real Stripe correlation IDs (never bypasses it).
//   • R40 FAIL CLOSED: payment setup refuses when jurisdiction pricing refs
//     are unset (resolveChildcarePricingSnapshot throws). Occurrence charges
//     refuse when the frozen snapshot is missing. No senior amounts, ever.
//   • R7/A3: the PAYER needs live `payment` scope for every child on the
//     booking. A guardian without payment scope gets the explicit
//     pending-payer state (paymentAuthorization "pending" + paymentSetup
//     .pendingPayer) — the booking cannot confirm until a payer completes
//     authorization. A payer who is not a guardian can authorize/refund but
//     receives NO child data from any payment surface.
//   • R39/AE15: ONE ledger correlation per booking/shift — every childcare
//     shiftHours row carries childcareBookingId + childcareShiftId, and every
//     Stripe object carries the pinned opaque-ID metadata key set (R57).
//     Deterministic doc IDs + create-once transactions converge duplicates.
//   • Completion revalidates the assigned provider + live booking state
//     before any billable row is created (never trusts the callable input).

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import Stripe from "stripe";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import { checkAuthority } from "./guardianAuthority";
import { assertChildSafeOutboundPayload } from "./matchingEligibility";
import { CHILDCARE_PILOT_STATE } from "./signupIngress";
import { recordChildcareBookingPaymentAuthorization } from "./bookingCallables";
import {
  describeChildcareBookingStatus,
  type ChildcareBookingDoc,
  type ChildcareBookingSchedule,
} from "./bookingPolicy";
import {
  resolveChildcarePricingSnapshot,
  evaluateChildcareCancellation,
  evaluateChildcareRefundRequest,
  childcareSetupMetadata,
  ChildcarePaymentPolicyError,
  type ChildcarePricingSnapshot,
} from "./paymentPolicy";
import { evaluateShiftBillingPolicy, ShiftBillingPolicyError } from "../billing/shiftBillingPolicy";
import { BILLING_CURRENCY } from "../billing/config";
import { autoApproveAtIso, TIMESHEET_AUTO_APPROVE_HOURS } from "../config/slaConstants";
import { parseScheduledTimeMs } from "../utils/scheduledTime";

/** Vertical-distinct authority stamp: the senior trusted stamp is
 *  "server-v1"; childcare rows are server-created through THIS module only. */
export const CHILDCARE_BILLING_AUTHORITY = "childcare-server-v1" as const;

const PAYMENT_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:childcare:payment:mut:",
};

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

// Lazy Stripe client (refundProcessor.ts pattern — mock-friendly, no
// module-load Stripe construction).
let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(
      functions.config().stripe?.secret || process.env.STRIPE_SECRET_KEY || "",
      { timeout: 10_000 },
    );
  }
  return stripeClient;
}

// ── Shared guard helpers (U2/U3 middleware idiom) ────────────────────────────

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

async function requireChildcareWrites(): Promise<void> {
  const flags = await getChildcareFlags();
  if (!flags.writesEnabled) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
    );
  }
}

async function enforceRateLimit(op: string, uid: string): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, PAYMENT_MUTATION_RATE);
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
    "You do not have access to this resource.",
  );
}

function invalidArgument(): functions.https.HttpsError {
  return new functions.https.HttpsError("invalid-argument", "Invalid request.");
}

function mapPaymentError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof ChildcarePaymentPolicyError) {
    // R40 fail-closed surfaces as an explicit, non-enumerating precondition.
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare payment is not available yet.",
      { code: err.code },
    );
  }
  console.error("[childcare/shiftPayments] error:", err instanceof Error ? err.message : err);
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

async function loadChildcareBookingOrDeny(
  db: Db,
  bookingId: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; booking: ChildcareBookingDoc }> {
  const ref = db.collection("booking_requests").doc(bookingId) as FirebaseFirestore.DocumentReference;
  const snap = await ref.get();
  const booking = (snap.data() ?? {}) as ChildcareBookingDoc;
  if (!snap.exists || booking.careVertical !== "child") throw permissionDenied();
  return { ref, booking: { ...booking, bookingId } };
}

// ── Generic child-safe money notifications (R43 — never child data) ──────────

async function writeChildSafeMoneyNotification(
  db: Db,
  recipientUid: string,
  notification: { type: string; title: string; body: string; refId: string },
): Promise<void> {
  const row = {
    userId: recipientUid,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data: { refId: notification.refId },
    isRead: false,
    createdAt: new Date().toISOString(),
  };
  assertChildSafeOutboundPayload(row, `shiftPayments.notification.${notification.type}`);
  await db.collection("users").doc(recipientUid).collection("notifications").add(row);
}

async function writeAdminAlert(db: Db, alert: Record<string, unknown>): Promise<void> {
  await db
    .collection("admin_alerts")
    .add({ resolved: false, createdAt: new Date().toISOString(), ...alert })
    .catch(() => {});
}

// ── Payer authority (R7/A3) ──────────────────────────────────────────────────

/** Does `uid` hold LIVE `payment` scope for EVERY child on the booking? */
export async function hasPaymentScopeForBooking(
  uid: string,
  booking: Pick<ChildcareBookingDoc, "childIds">,
  db: Db,
): Promise<boolean> {
  for (const childId of booking.childIds ?? []) {
    const decision = await checkAuthority(uid, childId, "payment", { db: db as never });
    if (!decision.allowed) return false;
  }
  return (booking.childIds ?? []).length > 0;
}

// ── setupChildcareBookingPayment (payment authorization — the U7 seam wire) ──

/**
 * Authorize payment for a childcare booking. Reuses the EXISTING senior
 * saved-method architecture: the payer's Stripe customer + default payment
 * method (Billing Portal-managed) are verified with a confirmed off-session
 * SetupIntent; per-occurrence charges later run through the proven
 * processShiftPayment off-session PaymentIntent rail. The response carries
 * booking/payment state ONLY — never child data (a payer need not be a
 * guardian).
 */
export const setupChildcareBookingPayment = childcareOnCall("setupChildcareBookingPayment", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareWrites();
  await enforceRateLimit("setupChildcareBookingPayment", uid);

  const bookingId = String(data?.bookingId ?? "").trim();
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();
    const { ref, booking } = await loadChildcareBookingOrDeny(db, bookingId);

    if (!["requested", "accepted"].includes(booking.status)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This booking is not awaiting payment authorization.",
        { code: "booking_not_payable" },
      );
    }

    // Payer scope: LIVE `payment` authority for every child (R7/A3).
    const isPayer = await hasPaymentScopeForBooking(uid, booking, db);
    if (!isPayer) {
      if (booking.clientId === uid) {
        // Guardian without payment scope: explicit PENDING-PAYER state. The
        // booking stays unconfirmable until an authorized payer completes
        // setup (AE14 — never described as confirmed).
        await ref.set(
          {
            paymentSetup: {
              pendingPayer: true,
              requestedByUid: uid,
              payerUid: null,
              updatedAt: now.toISOString(),
            },
          },
          { merge: true },
        );
        const { booking: updated } = await recordChildcareBookingPaymentAuthorization(
          { bookingId, state: "pending", correlationId: null },
          { db, now },
        );
        await logAudit({
          eventType: "childcare_payment_pending_payer",
          userId: uid,
          data: { bookingId },
        }).catch(() => {});
        return {
          success: true,
          bookingId,
          status: updated.status,
          paymentState: "pending",
          needsPayer: true,
          statusDescription: describeChildcareBookingStatus(updated.status, "pending"),
        };
      }
      throw permissionDenied();
    }

    // R40 pricing gate — unset refs/config refuse payment setup (fail closed).
    const pricingSnapshot = await resolveChildcarePricingSnapshot({
      state: CHILDCARE_PILOT_STATE,
      db: db as never,
      now,
    });

    // Payer's saved payment method — the SAME lookup the senior shift charge
    // uses (customers/{uid} first, users/{uid} fallback, customer default PM).
    let stripeCustomerId = ((await db.collection("customers").doc(uid).get()).data() ?? {})
      .stripeCustomerId as string | undefined;
    if (!stripeCustomerId) {
      stripeCustomerId = ((await db.collection("users").doc(uid).get()).data() ?? {})
        .stripeCustomerId as string | undefined;
    }
    if (!stripeCustomerId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Add a payment method to your account first.",
        { code: "no_payment_method" },
      );
    }
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if ((customer as Stripe.DeletedCustomer).deleted) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Add a payment method to your account first.",
        { code: "no_payment_method" },
      );
    }
    const liveCustomer = customer as Stripe.Customer;
    const defaultPm =
      liveCustomer.invoice_settings?.default_payment_method || liveCustomer.default_source;
    if (!defaultPm) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Add a payment method to your account first.",
        { code: "no_payment_method" },
      );
    }
    const paymentMethodId = typeof defaultPm === "string" ? defaultPm : defaultPm.id;

    // Confirmed off-session SetupIntent — a real Stripe authorization object
    // with a stable idempotency key: duplicate calls converge (AE15).
    const setupIntent = await stripe.setupIntents.create(
      {
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        confirm: true,
        usage: "off_session",
        metadata: childcareSetupMetadata(bookingId, booking.householdId),
      },
      { idempotencyKey: `childcare-payment-setup-${bookingId}` },
    );

    if (setupIntent.status !== "succeeded" && setupIntent.status !== "processing") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Your payment method needs additional verification. Please update it and try again.",
        { code: "card_action_required" },
      );
    }

    await ref.set(
      {
        paymentSetup: {
          pendingPayer: false,
          requestedByUid: uid,
          payerUid: uid,
          stripeCustomerId,
          paymentMethodId,
          setupIntentId: setupIntent.id,
          pricingSnapshot,
          updatedAt: now.toISOString(),
        },
      },
      { merge: true },
    );

    const state = setupIntent.status === "succeeded" ? "authorized" : "pending";
    const { booking: updated, confirmed } = await recordChildcareBookingPaymentAuthorization(
      { bookingId, state, correlationId: setupIntent.id },
      { db, now },
    );

    await logAudit({
      eventType: "childcare_payment_authorized",
      userId: uid,
      data: { bookingId, state, setupIntentId: setupIntent.id },
    }).catch(() => {});

    // NO child fields in the response (payer may not be a guardian — R7).
    return {
      success: true,
      bookingId,
      status: updated.status,
      paymentState: state,
      confirmed,
      statusDescription: describeChildcareBookingStatus(updated.status, state),
    };
  } catch (err) {
    mapPaymentError(err);
  }
});

// ── Validated hours at check-out (server-derived — R39) ─────────────────────

interface OccurrenceRow {
  id: string;
  collection: "appointments" | "shifts";
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

async function loadTodayOccurrences(
  db: Db,
  bookingId: string,
  today: string,
): Promise<OccurrenceRow[]> {
  const out: OccurrenceRow[] = [];
  const seen = new Set<string>();
  for (const collection of ["appointments", "shifts"] as const) {
    const field = collection === "appointments" ? "childcareBookingId" : "bookingRequestId";
    const snap = await db
      .collection(collection)
      .where(field, "==", bookingId)
      .where("date", "==", today)
      .get();
    for (const doc of snap.docs) {
      const d = (doc.data() ?? {}) as Record<string, unknown>;
      if (collection === "shifts" && d.careVertical !== "child") continue;
      const key = `${String(d.date)}|${String(d.startTime)}`;
      if (seen.has(key)) continue; // appointments doc wins over its shift twin
      seen.add(key);
      out.push({
        id: doc.id,
        collection,
        date: String(d.date ?? ""),
        startTime: String(d.startTime ?? ""),
        endTime: String(d.endTime ?? ""),
        status: String(d.status ?? ""),
        checkedInAt: typeof d.checkedInAt === "string" ? d.checkedInAt : null,
        checkedOutAt: typeof d.checkedOutAt === "string" ? d.checkedOutAt : null,
      });
    }
  }
  return out;
}

function scheduledWindowMs(row: OccurrenceRow): { start: number; end: number } | null {
  if (!row.date || !row.startTime || !row.endTime) return null;
  const start = parseScheduledTimeMs(`${row.date}T${row.startTime}:00`);
  let end = parseScheduledTimeMs(`${row.date}T${row.endTime}:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) end += 24 * 60 * 60 * 1000;
  return { start, end };
}

export interface ChildcareValidatedHoursResult {
  created: number;
  blockedReason:
    | null
    | "not_assigned_caregiver"
    | "booking_state_invalid"
    | "payment_not_authorized"
    | "pricing_snapshot_missing"
    | "no_billable_occurrence";
}

/**
 * Create vertical-stamped validated-hours rows (shiftHours docs) for the
 * booking's occurrences completed TODAY. Server-derived from check-in/out
 * stamps clamped to the scheduled window (createValidatedShiftHours pattern);
 * create-once on the deterministic occurrence ID (AE15). Revalidates the
 * assigned provider + live booking state before creating anything.
 *
 * Recurring bookings get the end-of-occurrence lifecycle U7 deferred: each
 * occurrence completes its OWN shiftHours row + payment; the booking itself
 * continues until end date/cancellation.
 */
export async function createChildcareValidatedShiftHoursForToday(
  params: { bookingId: string; actorUid: string },
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareValidatedHoursResult> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const { booking } = await loadChildcareBookingOrDeny(db, params.bookingId);

  // Revalidate assigned provider + booking state from a FRESH read (R29/R39).
  if (booking.caregiverId !== params.actorUid) {
    return { created: 0, blockedReason: "not_assigned_caregiver" };
  }
  if (!["in_progress", "confirmed", "completed"].includes(booking.status)) {
    return { created: 0, blockedReason: "booking_state_invalid" };
  }
  if (booking.paymentAuthorization?.state !== "authorized") {
    await writeAdminAlert(db, {
      type: "childcare_billing_blocked",
      bookingId: params.bookingId,
      reason: "payment_not_authorized",
      severity: "high",
    });
    return { created: 0, blockedReason: "payment_not_authorized" };
  }
  const setup = (booking as unknown as Record<string, unknown>).paymentSetup as
    | { payerUid?: string; pricingSnapshot?: ChildcarePricingSnapshot }
    | undefined;
  const snapshot = setup?.pricingSnapshot;
  const payerUid = setup?.payerUid;
  if (!snapshot || !payerUid) {
    // FAIL CLOSED (R40): no frozen policy pricing ⇒ no billable row, ever.
    await writeAdminAlert(db, {
      type: "childcare_billing_blocked",
      bookingId: params.bookingId,
      reason: "pricing_snapshot_missing",
      severity: "high",
    });
    return { created: 0, blockedReason: "pricing_snapshot_missing" };
  }

  const today = now.toISOString().split("T")[0];
  const occurrences = await loadTodayOccurrences(db, params.bookingId, today);
  let created = 0;

  for (const row of occurrences) {
    if (row.status !== "completed" || !row.checkedInAt || !row.checkedOutAt) continue;
    const window = scheduledWindowMs(row);
    if (!window) continue;

    const inMs = Date.parse(row.checkedInAt);
    const outMs = Date.parse(row.checkedOutAt);
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) continue;
    const billableStart = Math.max(inMs, window.start);
    const billableEnd = Math.min(outMs, window.end);
    if (billableEnd <= billableStart) {
      await writeAdminAlert(db, {
        type: "childcare_billing_window_empty",
        bookingId: params.bookingId,
        occurrenceId: row.id,
        severity: "medium",
      });
      continue;
    }

    let policy;
    try {
      policy = evaluateShiftBillingPolicy({
        startTime: new Date(billableStart).toISOString(),
        endTime: new Date(billableEnd).toISOString(),
        bookedRateDollars: Number(booking.hourlyRate),
      });
    } catch (err) {
      const code = err instanceof ShiftBillingPolicyError ? err.code : "billing_policy_error";
      await writeAdminAlert(db, {
        type: "childcare_billing_blocked",
        bookingId: params.bookingId,
        occurrenceId: row.id,
        reason: code,
        severity: "high",
      });
      continue;
    }

    const ts = now.toISOString();
    const shiftHoursRef = db.collection("shiftHours").doc(row.id);
    const doc: Record<string, unknown> = {
      id: row.id,
      appointmentId: row.id,
      careVertical: "child",
      childcareBookingId: params.bookingId,
      childcareShiftId: row.id,
      billingUserId: payerUid,
      caregiverId: booking.caregiverId,
      caregiverName: booking.caregiverName ?? "Caregiver",
      clientId: booking.clientId,
      clientName: "Family",
      date: row.date,
      payRate: Number(booking.hourlyRate),
      currency: BILLING_CURRENCY,
      paymentMethod: "credit",
      paymentMethodSnapshotAt: ts,
      submittedStartTime: new Date(billableStart).toISOString(),
      submittedEndTime: new Date(billableEnd).toISOString(),
      submittedTotalHours: policy.totalHours,
      lineItems: [],
      lineItemsTotal: 0,
      basePay: policy.basePayCents / 100,
      grossPay: policy.grossPayCents / 100,
      amountCents: policy.grossPayCents,
      requiresExplicitApproval: policy.requiresExplicitApproval,
      billingAuthority: CHILDCARE_BILLING_AUTHORITY,
      billingSource: "childcare_checkout",
      childcarePricing: {
        platformFeeRate: snapshot.platformFeeRate,
        platformFeeMinCents: snapshot.platformFeeMinCents,
        currency: snapshot.currency,
        policyVersion: snapshot.policyVersion,
        resolvedAt: snapshot.resolvedAt,
      },
      childcareRefundPolicy: snapshot.refund,
      approvalNoticeState: "pending",
      autoApproveAt: policy.requiresExplicitApproval ? null : autoApproveAtIso(now.getTime()),
      paymentGeneration: 1,
      paymentAttemptCount: 0,
      status: "pending_client_review",
      submittedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };

    const wrote = await db.runTransaction(async (tx) => {
      const existing = await tx.get(shiftHoursRef);
      if (existing.exists) return false;
      tx.set(shiftHoursRef, doc);
      return true;
    });
    if (!wrote) continue;
    created++;

    // Generic child-safe review notice (R43) — the family's approval channel
    // is in-app/web (Evia SMS timesheet flows for childcare are U10). Only a
    // DELIVERED notice unlocks auto-approval (same gate the senior flow uses).
    try {
      await writeChildSafeMoneyNotification(db, booking.clientId, {
        type: "childcare_hours_recorded",
        title: "Visit Hours Recorded",
        body:
          `Today's childcare visit hours were recorded. Review them in the app` +
          (policy.requiresExplicitApproval
            ? "; this visit needs your explicit approval."
            : `; they auto-approve in ${TIMESHEET_AUTO_APPROVE_HOURS}h.`),
        refId: row.id,
      });
      await shiftHoursRef.update({
        approvalNoticeState: "delivered",
        approvalNoticeChannel: "in_app",
        approvalNoticeDeliveredAt: new Date().toISOString(),
      });
    } catch (err) {
      // Notice not delivered ⇒ approvalNoticeState stays "pending" ⇒ the
      // auto-approve sweep will NOT silently charge the family (fail safe).
      console.error(
        "[childcare/shiftPayments] hours notice failed (auto-approve stays blocked):",
        err instanceof Error ? err.message : err,
      );
    }
    await logAudit({
      eventType: "childcare_validated_hours_created",
      userId: params.actorUid,
      data: { bookingId: params.bookingId, occurrenceId: row.id, amountCents: policy.grossPayCents },
    }).catch(() => {});
  }

  return { created, blockedReason: created === 0 ? "no_billable_occurrence" : null };
}

// ── Overdue childcare visits (late/no-show policy states — R37/R39) ─────────

export type ChildcareOverdueState = "awaiting_checkout" | "missed_visit_review";

/**
 * The appointmentCompletion guarded childcare branch. Childcare appointments
 * are NEVER wall-clock auto-completed (completion triggers money — only a
 * real check-out may complete a childcare visit). Overdue visits get explicit
 * policy states instead:
 *   • checked in, not checked out → "awaiting_checkout" + provider nudge;
 *   • never checked in            → "missed_visit_review" + admin review +
 *     generic notices. NO charge is created on either path.
 * Idempotent via the childcareOverdueState stamp.
 */
export async function handleOverdueChildcareVisit(
  apptId: string,
  appt: Record<string, unknown>,
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareOverdueState | null> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  if (appt.careVertical !== "child") return null;
  if (appt.childcareOverdueState) return appt.childcareOverdueState as ChildcareOverdueState;

  const checkedIn = typeof appt.checkedInAt === "string" && appt.checkedInAt;
  const state: ChildcareOverdueState = checkedIn ? "awaiting_checkout" : "missed_visit_review";
  const ts = now.toISOString();

  await db.collection("appointments").doc(apptId).update({
    childcareOverdueState: state,
    childcareOverdueAt: ts,
    // A never-checked-in visit exits the completion scan as an explicit
    // "missed" terminal state (no consumer treats "missed" as billable or
    // active); a checked-in visit stays "confirmed" so a late check-out can
    // still complete it.
    ...(state === "missed_visit_review" ? { status: "missed" } : {}),
  });

  const caregiverId = String(appt.caregiverId ?? "");
  const clientId = String(appt.clientId ?? "");
  if (state === "awaiting_checkout") {
    if (caregiverId) {
      await writeChildSafeMoneyNotification(db, caregiverId, {
        type: "childcare_checkout_reminder",
        title: "Check Out Reminder",
        body: "Please check out of today's childcare visit in the app so it can be completed.",
        refId: apptId,
      }).catch(() => {});
    }
  } else {
    await writeAdminAlert(db, {
      type: "childcare_visit_missed_review",
      appointmentId: apptId,
      bookingId: String(appt.childcareBookingId ?? ""),
      severity: "high",
    });
    for (const [uid, body] of [
      [clientId, "A scheduled childcare visit was not checked in. Our team is reviewing it — no charge was made."],
      [caregiverId, "A scheduled childcare visit was not checked in and is under review. Open the app for details."],
    ] as const) {
      if (!uid) continue;
      await writeChildSafeMoneyNotification(db, uid, {
        type: "childcare_visit_missed",
        title: "Visit Needs Review",
        body,
        refId: apptId,
      }).catch(() => {});
    }
  }
  await logAudit({
    eventType: "childcare_visit_overdue",
    userId: caregiverId || "system",
    data: { appointmentId: apptId, state },
  }).catch(() => {});
  return state;
}

// ── Cancellation policy outcome (policy-driven, no auto-charge) ──────────────

function nextOccurrenceStartMs(schedule: ChildcareBookingSchedule, nowMs: number): number | null {
  let best: number | null = null;
  for (const d of schedule?.dates ?? []) {
    const start = parseScheduledTimeMs(`${d.date}T${d.startTime}:00`);
    if (Number.isFinite(start) && start >= nowMs && (best === null || start < best)) best = start;
  }
  if (schedule?.recurring) {
    // Walk forward up to 8 days to find the next recurring occurrence.
    for (let i = 0; i <= 8; i++) {
      const day = new Date(nowMs + i * 24 * 60 * 60 * 1000);
      const dayName = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][day.getUTCDay()];
      if (!schedule.recurring.days.includes(dayName)) continue;
      const date = day.toISOString().split("T")[0];
      const start = parseScheduledTimeMs(`${date}T${schedule.recurring.startTime}:00`);
      if (Number.isFinite(start) && start >= nowMs && (best === null || start < best)) best = start;
    }
  }
  return best;
}

/**
 * Record the policy cancellation outcome on a JUST-CANCELED booking and move
 * a live payment authorization to "canceled" through the U7 seam. Policy
 * percentages/windows come from the FROZEN pricing snapshot — this records
 * the outcome and NEVER auto-charges a cancellation fee (charges only exist
 * for completed occurrences; refunds of those flow through refundRequests).
 * Never throws into the cancel path.
 */
export async function evaluateAndRecordChildcareCancellation(
  bookingId: string,
  opts: { db?: Db; now?: Date; byUid?: string } = {},
): Promise<void> {
  try {
    const db = opts.db ?? defaultDb();
    const now = opts.now ?? new Date();
    const { ref, booking } = await loadChildcareBookingOrDeny(db, bookingId);

    const setup = (booking as unknown as Record<string, unknown>).paymentSetup as
      | { pricingSnapshot?: ChildcarePricingSnapshot }
      | undefined;
    const snapshot = setup?.pricingSnapshot;
    if (snapshot) {
      const nextStart = nextOccurrenceStartMs(booking.schedule, now.getTime());
      if (nextStart !== null) {
        const outcome = evaluateChildcareCancellation(snapshot, nextStart, now.getTime());
        await ref.set(
          {
            cancellationPolicyOutcome: {
              hoursBeforeStart: Math.round(outcome.hoursBeforeStart * 100) / 100,
              refundPercent: outcome.refundPercent,
              matchedWindowHours: outcome.matchedWindowHours,
              policyVersion: snapshot.policyVersion,
              evaluatedAt: now.toISOString(),
              byUid: opts.byUid ?? null,
            },
          },
          { merge: true },
        );
      }
    }

    const priorState = booking.paymentAuthorization?.state;
    if (priorState === "pending" || priorState === "authorized") {
      await recordChildcareBookingPaymentAuthorization(
        { bookingId, state: "canceled", correlationId: booking.paymentAuthorization?.correlationId ?? null },
        { db, now },
      );
    }
  } catch (err) {
    console.error(
      "[childcare/shiftPayments] cancellation outcome error (cancel already committed):",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── requestChildcareRefund (policy-driven; existing refund state machine) ────

/**
 * Family/payer refund request for one CHARGED childcare occurrence. Computes
 * the policy-allowed amount (windows/percentages from the frozen snapshot —
 * never hardcoded) and creates a refundRequests row in the EXISTING refund
 * state machine (admin review via reviewRefundRequest → onRefundRequestWrite
 * → processApprovedRefund). Create-once — duplicate requests converge (AE15).
 */
export const requestChildcareRefund = childcareOnCall("requestChildcareRefund", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareWrites();
  await enforceRateLimit("requestChildcareRefund", uid);

  const bookingId = String(data?.bookingId ?? "").trim();
  const occurrenceId = String(data?.occurrenceId ?? "").trim();
  const reason = String(data?.reason ?? "").trim().slice(0, 500);
  const requestedCents = data?.amountCents == null ? null : Number(data.amountCents);
  if (!bookingId || bookingId.length > 128 || !occurrenceId || occurrenceId.length > 128) {
    throw invalidArgument();
  }
  if (requestedCents !== null && (!Number.isInteger(requestedCents) || requestedCents <= 0)) {
    throw invalidArgument();
  }

  try {
    const db = defaultDb();
    const now = new Date();
    const { booking } = await loadChildcareBookingOrDeny(db, bookingId);

    const shiftSnap = await db.collection("shiftHours").doc(occurrenceId).get();
    const shift = (shiftSnap.data() ?? {}) as Record<string, unknown>;
    if (
      !shiftSnap.exists ||
      shift.careVertical !== "child" ||
      shift.childcareBookingId !== bookingId
    ) {
      throw permissionDenied();
    }

    // Refunds are a PAYMENT action: the recorded payer, or an adult holding
    // live `payment` scope for every child on the booking (R7/A3).
    const isRecordedPayer = shift.billingUserId === uid;
    if (!isRecordedPayer && !(await hasPaymentScopeForBooking(uid, booking, db))) {
      throw permissionDenied();
    }

    if (shift.status !== "paid" || !shift.stripeChargeId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This visit has no completed payment to refund.",
        { code: "occurrence_not_charged" },
      );
    }

    const refundPolicy = shift.childcareRefundPolicy as
      | ChildcarePricingSnapshot["refund"]
      | undefined;
    if (!refundPolicy) {
      throw new ChildcarePaymentPolicyError(
        "pricing_config_invalid",
        "childcare shift row is missing its frozen refund policy",
      );
    }
    const chargedCents = Number(shift.amountCents ?? 0);
    const alreadyRefunded = Number(shift.refundedAmountCents ?? 0);
    const checkoutMs = Date.parse(String(shift.submittedEndTime ?? ""));
    const evaluation = evaluateChildcareRefundRequest(
      { refund: refundPolicy },
      {
        chargedCents: Math.max(0, chargedCents - alreadyRefunded),
        requestedCents,
        checkoutMs: Number.isFinite(checkoutMs) ? checkoutMs : 0,
        nowMs: now.getTime(),
      },
    );
    if (!evaluation.allowed) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This refund request is outside the refund policy. Contact support for help.",
        { code: evaluation.reasonCode, maxRefundableCents: evaluation.maxRefundableCents },
      );
    }

    const requestId = `${occurrenceId}:childcare`;
    const requestRef = db.collection("refundRequests").doc(requestId);
    const ts = now.toISOString();
    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(requestRef);
      if (existing.exists) return false;
      tx.set(requestRef, {
        careVertical: "child",
        childcareBookingId: bookingId,
        clientId: shift.clientId,
        requestedByUid: uid,
        appointmentId: occurrenceId,
        amountCents: requestedCents ?? evaluation.maxRefundableCents,
        policyMaxRefundableCents: evaluation.maxRefundableCents,
        reason,
        status: "requested",
        source: "childcare_web",
        requestedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
      return true;
    });

    if (created) {
      await logAudit({
        eventType: "childcare_refund_requested",
        userId: uid,
        data: { bookingId, occurrenceId, requestId },
      }).catch(() => {});
    }
    return { success: true, requestId, created, status: "requested" };
  } catch (err) {
    mapPaymentError(err);
  }
});

// ── Dispute / chargeback payout hold (R39 — money stops before it moves) ─────

/**
 * Hold the payout rail for one childcare shiftHours row (dispute opened or
 * Stripe chargeback received). processShiftPayment refuses to charge/transfer
 * a held row. Already-transferred money can only be escalated (admin alert) —
 * never silently clawed back. No-op for senior rows (guarded upstream too).
 */
export async function holdChildcareShiftPayout(
  appointmentId: string,
  reason: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<{ held: boolean; alreadyPaidOut: boolean }> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ref = db.collection("shiftHours").doc(appointmentId);
  const snap = await ref.get();
  const shift = (snap.data() ?? {}) as Record<string, unknown>;
  if (!snap.exists || shift.careVertical !== "child") return { held: false, alreadyPaidOut: false };

  if (shift.stripeTransferId) {
    await writeAdminAlert(db, {
      type: "childcare_dispute_after_payout",
      appointmentId,
      bookingId: String(shift.childcareBookingId ?? ""),
      reason,
      severity: "high",
    });
    return { held: false, alreadyPaidOut: true };
  }

  await ref.update({
    payoutHold: true,
    payoutHoldReason: reason,
    payoutHoldAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  await logAudit({
    eventType: "childcare_payout_held",
    userId: "system",
    data: { appointmentId, reason },
  }).catch(() => {});
  return { held: true, alreadyPaidOut: false };
}
