import * as admin from "firebase-admin";

const db = admin.firestore();
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

export type ExternalSideEffectState =
  | "pending"
  | "processing"
  | "completed"
  | "retryable_failed"
  | "terminal_failed";

export function externalOperationDocId(operationKey: string): string {
  return operationKey.replace(/\//g, "%2F");
}

export async function claimExternalSideEffectOperation(input: {
  operationKey: string;
  operationType: string;
  targetId: string;
  leaseMs?: number;
  maxAttempts?: number;
}): Promise<{ leaseOwner: string; attemptCount: number } | null> {
  const ref = db.collection("externalSideEffectOperations").doc(externalOperationDocId(input.operationKey));
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const current = snap.exists ? snap.data()! : {};
    const nowMs = Date.now();
    const leaseExpiresAt = Date.parse(String(current.leaseExpiresAt ?? ""));
    const nextAttemptAt = Date.parse(String(current.nextAttemptAt ?? ""));

    if (current.state === "completed" || current.state === "terminal_failed") return null;
    if (current.state === "processing" && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) return null;
    if (current.state === "retryable_failed" && Number.isFinite(nextAttemptAt) && nextAttemptAt > nowMs) return null;

    const attemptCount = Number(current.attemptCount ?? 0) + 1;
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const now = new Date(nowMs).toISOString();
    if (attemptCount > maxAttempts) {
      transaction.set(ref, {
        operationKey: input.operationKey,
        operationType: input.operationType,
        targetId: input.targetId,
        state: "terminal_failed" satisfies ExternalSideEffectState,
        attemptCount: Number(current.attemptCount ?? maxAttempts),
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        lastErrorCode: current.lastErrorCode ?? "attempt_limit_exceeded",
        createdAt: current.createdAt ?? now,
        updatedAt: now,
      }, { merge: true });
      return null;
    }

    const leaseOwner = `${input.operationType}-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
    transaction.set(ref, {
      operationKey: input.operationKey,
      operationType: input.operationType,
      targetId: input.targetId,
      state: "processing" satisfies ExternalSideEffectState,
      attemptCount,
      nextAttemptAt: null,
      leaseOwner,
      leaseExpiresAt: new Date(nowMs + (input.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(),
      providerOperationId: current.providerOperationId ?? null,
      completedAt: null,
      lastErrorCode: null,
      createdAt: current.createdAt ?? now,
      updatedAt: now,
    }, { merge: true });
    return { leaseOwner, attemptCount };
  });
}

export async function completeExternalSideEffectOperation(
  operationKey: string,
  leaseOwner: string,
  providerOperationId?: string,
): Promise<boolean> {
  const ref = db.collection("externalSideEffectOperations").doc(externalOperationDocId(operationKey));
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return false;
    const current = snap.data()!;
    if (current.state === "completed") return true;
    if (current.state !== "processing" || current.leaseOwner !== leaseOwner) return false;
    const now = new Date().toISOString();
    transaction.update(ref, {
      state: "completed" satisfies ExternalSideEffectState,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      providerOperationId: providerOperationId ?? current.providerOperationId ?? null,
      completedAt: now,
      lastErrorCode: null,
      updatedAt: now,
    });
    return true;
  });
}

export async function failExternalSideEffectOperation(
  operationKey: string,
  leaseOwner: string,
  error: unknown,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<void> {
  const ref = db.collection("externalSideEffectOperations").doc(externalOperationDocId(operationKey));
  const terminal = await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return false;
    const current = snap.data()!;
    if (current.state !== "processing" || current.leaseOwner !== leaseOwner) return false;
    const isTerminal = Number(current.attemptCount ?? 0) >= maxAttempts;
    const now = new Date().toISOString();
    transaction.update(ref, {
      state: (isTerminal ? "terminal_failed" : "retryable_failed") satisfies ExternalSideEffectState,
      nextAttemptAt: isTerminal ? null : now,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: null,
      lastErrorCode: (error instanceof Error ? error.message : String(error)).slice(0, 120),
      updatedAt: now,
    });
    return isTerminal;
  });

  if (terminal) {
    await db.collection("admin_alerts").doc(externalOperationDocId(`external-side-effect:${operationKey}`)).set({
      type: "external_side_effect_terminal_failure",
      operationKey,
      severity: "high",
      resolved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}
