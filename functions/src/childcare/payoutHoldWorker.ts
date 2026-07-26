import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { createHash } from "crypto";

export const CHILDCARE_PAYOUT_HOLD_OPERATIONS = "childcare_payout_hold_operations";
const MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60 * 1000;

type Db = FirebaseFirestore.Firestore;
export type PayoutHoldOperationState =
  | "pending" | "processing" | "held" | "already_held"
  | "already_paid_requires_recovery" | "missing_correlation"
  | "retryable_failure" | "escalated";

export function payoutHoldOperationId(
  sourceType: "stripe_dispute" | "internal_dispute",
  sourceId: string,
  appointmentId: string | null,
): string {
  return `cph_${createHash("sha256")
    .update(`${sourceType}|${sourceId}|${appointmentId ?? "missing"}`)
    .digest("hex").slice(0, 40)}`;
}

async function writeAlert(db: Db, operationId: string, data: Record<string, unknown>): Promise<void> {
  await db.collection("admin_alerts").doc(`payout_hold_${operationId}`).set({
    ...data, careVertical: "child", resolved: false, createdAt: new Date().toISOString(),
  }, { merge: true });
}

export async function enqueueChildcarePayoutHold(params: {
  sourceType: "stripe_dispute" | "internal_dispute";
  sourceId: string;
  appointmentId: string | null;
  bookingId?: string | null;
  paymentIntentId?: string | null;
  reason: string;
  db?: Db;
  now?: Date;
}): Promise<{ operationId: string; created: boolean }> {
  const db = params.db ?? admin.firestore();
  const now = params.now ?? new Date();
  const operationId = payoutHoldOperationId(params.sourceType, params.sourceId, params.appointmentId);
  const ref = db.collection(CHILDCARE_PAYOUT_HOLD_OPERATIONS).doc(operationId);
  const created = await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return false;
    tx.create(ref, {
      schemaVersion: "childcare-payout-hold-v1", careVertical: "child", operationId,
      sourceType: params.sourceType, sourceId: params.sourceId,
      appointmentId: params.appointmentId, bookingId: params.bookingId ?? null,
      paymentIntentId: params.paymentIntentId ?? null, reason: params.reason.slice(0, 200),
      state: params.appointmentId ? "pending" : "missing_correlation",
      attempt: 0, leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: params.appointmentId ? now.toISOString() : null,
      evidence: {}, lastErrorCode: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    return true;
  });
  if (!params.appointmentId) {
    await writeAlert(db, operationId, {
      type: "childcare_payout_hold_missing_correlation",
      operationId, sourceType: params.sourceType, sourceId: params.sourceId, severity: "critical",
    });
  }
  return { operationId, created };
}

async function writePartyNotices(db: Db, operationId: string, shift: Record<string, unknown>): Promise<void> {
  for (const uid of [shift.clientId, shift.caregiverId]) {
    if (typeof uid !== "string" || !uid) continue;
    await db.collection("users").doc(uid).collection("notifications")
      .doc(`payout_hold_${operationId}`).set({
        userId: uid, type: "childcare_payment_review", title: "Payment Under Review",
        body: "A payment concern is being reviewed. Open the app for status updates.",
        data: { refId: String(shift.childcareBookingId ?? operationId) },
        isRead: false, createdAt: new Date().toISOString(),
      });
  }
}

function retryAt(now: Date, attempt: number): string {
  const delay = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempt - 1)));
  return new Date(now.getTime() + delay).toISOString();
}

export async function processPayoutHoldOperation(
  operationId: string,
  opts: { db?: Db; now?: Date; workerId?: string } = {},
): Promise<PayoutHoldOperationState> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  const ref = db.collection(CHILDCARE_PAYOUT_HOLD_OPERATIONS).doc(operationId);
  const claimed = await db.runTransaction<FirebaseFirestore.DocumentData | null>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const op: FirebaseFirestore.DocumentData = snap.data() ?? {};
    if (["held", "already_held", "already_paid_requires_recovery", "missing_correlation", "escalated"].includes(op.state)) return null;
    if (op.state === "processing" && typeof op.leaseExpiresAt === "string" && op.leaseExpiresAt > now.toISOString()) return null;
    const attempt = Number(op.attempt ?? 0) + 1;
    tx.update(ref, {
      state: "processing", attempt, leaseOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      updatedAt: now.toISOString(),
    });
    return { ...op, attempt };
  });
  if (!claimed) {
    return ((await ref.get()).data()?.state ?? "escalated") as PayoutHoldOperationState;
  }

  try {
    const appointmentId = String(claimed.appointmentId ?? "");
    const shiftRef = db.collection("shiftHours").doc(appointmentId);
    const shiftSnap = await shiftRef.get();
    const shift = shiftSnap.data() ?? {};
    if (!appointmentId || !shiftSnap.exists || shift.careVertical !== "child") {
      await ref.update({
        state: "missing_correlation", leaseOwner: null, leaseExpiresAt: null,
        nextAttemptAt: null, lastErrorCode: "child_shift_not_found", updatedAt: now.toISOString(),
      });
      await writeAlert(db, operationId, {
        type: "childcare_payout_hold_missing_correlation", operationId, appointmentId, severity: "critical",
      });
      return "missing_correlation";
    }

    let state: PayoutHoldOperationState;
    if (shift.stripeTransferId) {
      state = "already_paid_requires_recovery";
      await writeAlert(db, operationId, {
        type: "childcare_dispute_after_payout", operationId, appointmentId, severity: "critical",
      });
    } else if (shift.payoutHold === true) {
      state = "already_held";
    } else {
      await shiftRef.update({
        payoutHold: true, payoutHoldReason: String(claimed.reason ?? "dispute"),
        payoutHoldOperationId: operationId, payoutHoldAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      state = "held";
    }
    await ref.update({
      state, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
      evidence: { appointmentId, bookingId: shift.childcareBookingId ?? null, payoutHoldObserved: true },
      updatedAt: now.toISOString(),
    });
    await writePartyNotices(db, operationId, shift);
    return state;
  } catch (error) {
    const attempt = Number(claimed.attempt ?? 1);
    const exhausted = attempt >= MAX_ATTEMPTS;
    await ref.update({
      state: exhausted ? "escalated" : "retryable_failure",
      leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: exhausted ? null : retryAt(now, attempt),
      lastErrorCode: error instanceof Error ? error.name.slice(0, 80) : "unknown",
      updatedAt: now.toISOString(),
    });
    if (exhausted) {
      await writeAlert(db, operationId, {
        type: "childcare_payout_hold_retry_exhausted", operationId, severity: "critical",
      });
      return "escalated";
    }
    throw error;
  }
}

export async function sweepPendingPayoutHolds(
  opts: { db?: Db; now?: Date; limit?: number } = {},
): Promise<{ attempted: number; completed: number; failed: number }> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const snap = await db.collection(CHILDCARE_PAYOUT_HOLD_OPERATIONS)
    .where("state", "in", ["pending", "retryable_failure", "processing"])
    .limit(Math.max(1, Math.min(opts.limit ?? 50, 100))).get();
  let completed = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    const op = doc.data();
    if (op.state === "retryable_failure" && typeof op.nextAttemptAt === "string" && op.nextAttemptAt > now.toISOString()) continue;
    try {
      await processPayoutHoldOperation(doc.id, { db, now });
      completed += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: completed + failed, completed, failed };
}

export const processChildcarePayoutHolds = functions.pubsub
  .schedule("every 5 minutes").onRun(async () => sweepPendingPayoutHolds());
