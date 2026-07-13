import * as admin from "firebase-admin";

const db = admin.firestore();
const LEASE_MS = 5 * 60 * 1000;

export function shiftPaymentOperationKey(appointmentId: string, generation: number): string {
  return `shift-payment:${appointmentId}:generation:${generation}`;
}

export async function claimShiftPaymentOperation(
  appointmentId: string,
  maxAttempts: number,
): Promise<{ shift: Record<string, any>; attempt: number; generation: number; operationKey: string } | null> {
  const shiftRef = db.collection("shiftHours").doc(appointmentId);
  return db.runTransaction(async (transaction) => {
    const shiftSnap = await transaction.get(shiftRef);
    if (!shiftSnap.exists) return null;
    const shift = shiftSnap.data() as Record<string, any>;
    if (shift.status === "paid" && shift.stripeTransferId) return null;

    const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));
    const operationKey = shiftPaymentOperationKey(appointmentId, generation);
    const operationRef = db.collection("billingOperations").doc(operationKey);
    const operationSnap = await transaction.get(operationRef);
    const operation = operationSnap.exists ? operationSnap.data()! : {};
    const nowMs = Date.now();
    const leaseExpiresAt = Date.parse(String(operation.leaseExpiresAt ?? ""));
    const nextAttemptAt = Date.parse(String(operation.nextAttemptAt ?? ""));
    if (operation.state === "completed" || operation.state === "waiting_provider") return null;
    if (operation.state === "processing" && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) return null;
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > nowMs) return null;

    const attempt = Math.max(Number(operation.attemptCount ?? 0), Number(shift.paymentAttemptCount ?? 0)) + 1;
    const now = new Date(nowMs).toISOString();
    if (attempt > maxAttempts) {
      transaction.update(shiftRef, {
        status: "requires_admin_review",
        autoApproveAt: null,
        paymentLeaseOwner: null,
        paymentLeaseExpiresAt: null,
        updatedAt: now,
      });
      transaction.set(operationRef, {
        operationKey,
        operationType: "shift_payment",
        targetId: appointmentId,
        generation,
        state: "requires_admin_review",
        attemptCount: Number(operation.attemptCount ?? maxAttempts),
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        lastErrorCode: "attempt_limit_exceeded",
        updatedAt: now,
        createdAt: operation.createdAt ?? now,
      }, { merge: true });
      return null;
    }

    const leaseOwner = `payment-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
    const leaseExpiry = new Date(nowMs + LEASE_MS).toISOString();
    transaction.set(operationRef, {
      operationKey,
      operationType: "shift_payment",
      targetId: appointmentId,
      generation,
      state: "processing",
      attemptCount: attempt,
      nextAttemptAt: null,
      leaseOwner,
      leaseExpiresAt: leaseExpiry,
      providerOperationId: operation.providerOperationId ?? null,
      completedAt: null,
      lastErrorCode: null,
      updatedAt: now,
      createdAt: operation.createdAt ?? now,
    }, { merge: true });
    transaction.update(shiftRef, {
      paymentGeneration: generation,
      paymentAttemptCount: attempt,
      paymentLeaseOwner: leaseOwner,
      paymentLeaseExpiresAt: leaseExpiry,
      updatedAt: now,
    });
    return { shift: { ...shift, paymentGeneration: generation, paymentAttemptCount: attempt }, attempt, generation, operationKey };
  });
}

export async function updateShiftPaymentOperation(
  operationKey: string,
  state: "waiting_provider" | "retry" | "completed" | "requires_admin_review",
  fields: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  await db.collection("billingOperations").doc(operationKey).set({
    state,
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: state === "completed" ? now : null,
    updatedAt: now,
    ...fields,
  }, { merge: true });
}
