import * as admin from "firebase-admin";

// Lazy handle: this module is imported (via memory/conversationMemory.ts) by
// the activity-backfill script BEFORE admin.initializeApp() runs, so module
// load must not touch the default app.
let _db: admin.firestore.Firestore | null = null;
function db(): admin.firestore.Firestore {
  if (!_db) _db = admin.firestore();
  return _db;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

export type ExternalSideEffectState =
  | "pending"
  | "processing"
  | "completed"
  | "retryable_failed"
  | "terminal_failed";

// ── Generic leased-operation engine ───────────────────────────────────────────
// Shared claim/complete/fail transaction primitives for durable server-side
// operation ledgers (memory-grounding hardening plan 2026-07-17-002, KTD6: the
// memory_operations ledger must NOT hand-roll a second lease/backoff state
// machine — it reuses this one). The original external-side-effect functions
// below delegate here unchanged; the memory store configures different field
// names (status/attempts/nextRetryAt), a backoff schedule, and lease-mirroring
// so an expired lease is discoverable through the same (state, nextRetry)
// composite index.

export interface LeasedOperationStoreConfig {
  collection: string;
  /** Doc field holding the state machine value. Default "state". */
  stateField?: string;
  /** Doc field holding the attempt counter. Default "attemptCount". */
  attemptsField?: string;
  /** Doc field holding the next-eligible-retry ISO timestamp. Default "nextAttemptAt". */
  nextRetryField?: string;
  leaseMs?: number;
  maxAttempts?: number;
  /**
   * Delay (ms) before failed attempt N (1-based) becomes claimable again.
   * Default: 0 — immediately due, the pre-engine external-side-effect behavior.
   */
  retryDelayMs?: (attemptCount: number) => number;
  /**
   * When true, claiming a missing doc creates it (external side effects mint
   * their ledger row at claim time). When false, a missing doc is unclaimable —
   * memory operations are pre-created atomically with their source rows.
   */
  createOnClaim?: boolean;
  /**
   * When true, the lease expiry is mirrored into the nextRetry field while
   * processing, so a crashed worker's expired lease is found by the same
   * (state ASC, nextRetry ASC) index that finds pending/retryable work.
   */
  mirrorLeaseIntoRetryField?: boolean;
  /**
   * Maps an error to the persisted lastErrorCode. Default: message slice.
   * Privacy-sensitive ledgers (R21) should map to a sanitized error class.
   */
  errorCode?: (error: unknown) => string;
  /**
   * Invoked (post-transaction, best-effort) whenever a doc transitions into
   * terminal_failed — from a claim that exhausted attempts or from fail().
   * Used for deduplicated terminal alerts.
   */
  onTerminal?: (docId: string) => void | Promise<void>;
}

export interface LeasedOperationClaim {
  leaseOwner: string;
  attemptCount: number;
}

export type LeasedOperationFailResult = "retryable" | "terminal" | "ignored";

export interface LeasedOperationStore {
  claim(
    docId: string,
    opts?: {
      seed?: Record<string, unknown>;
      leaseMs?: number;
      maxAttempts?: number;
      leaseOwnerPrefix?: string;
    },
  ): Promise<LeasedOperationClaim | null>;
  complete(docId: string, leaseOwner: string, patch?: Record<string, unknown>): Promise<boolean>;
  fail(
    docId: string,
    leaseOwner: string,
    error: unknown,
    opts?: { maxAttempts?: number; patch?: Record<string, unknown> },
  ): Promise<LeasedOperationFailResult>;
}

export function createLeasedOperationStore(config: LeasedOperationStoreConfig): LeasedOperationStore {
  const stateField = config.stateField ?? "state";
  const attemptsField = config.attemptsField ?? "attemptCount";
  const nextRetryField = config.nextRetryField ?? "nextAttemptAt";
  const retryDelayMs = config.retryDelayMs ?? (() => 0);
  const errorCode = config.errorCode ?? ((error: unknown) =>
    (error instanceof Error ? error.message : String(error)).slice(0, 120));

  const notifyTerminal = async (docId: string): Promise<void> => {
    if (!config.onTerminal) return;
    try {
      await config.onTerminal(docId);
    } catch {
      // Alerting is best-effort; the terminal state itself is already durable.
    }
  };

  return {
    async claim(docId, opts = {}) {
      const ref = db().collection(config.collection).doc(docId);
      const result = await db().runTransaction(async transaction => {
        const snap = await transaction.get(ref);
        if (!snap.exists && !config.createOnClaim) return { claim: null, terminal: false };
        const current = snap.exists ? snap.data()! : {};
        const nowMs = Date.now();
        const state = current[stateField];
        const leaseExpiresAt = Date.parse(String(current.leaseExpiresAt ?? ""));
        const nextRetryAt = Date.parse(String(current[nextRetryField] ?? ""));

        if (state === "completed" || state === "terminal_failed") return { claim: null, terminal: false };
        if (state === "processing" && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) {
          return { claim: null, terminal: false };
        }
        if (state === "retryable_failed" && Number.isFinite(nextRetryAt) && nextRetryAt > nowMs) {
          return { claim: null, terminal: false };
        }

        const attemptCount = Number(current[attemptsField] ?? 0) + 1;
        const maxAttempts = opts.maxAttempts ?? config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        const now = new Date(nowMs).toISOString();
        if (attemptCount > maxAttempts) {
          transaction.set(ref, {
            ...(opts.seed ?? {}),
            [stateField]: "terminal_failed" satisfies ExternalSideEffectState,
            [attemptsField]: Number(current[attemptsField] ?? maxAttempts),
            [nextRetryField]: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: null,
            lastErrorCode: current.lastErrorCode ?? "attempt_limit_exceeded",
            createdAt: current.createdAt ?? now,
            updatedAt: now,
          }, { merge: true });
          return { claim: null, terminal: true };
        }

        const prefix = opts.leaseOwnerPrefix ?? config.collection;
        const leaseOwner = `${prefix}-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
        const leaseExpiresIso = new Date(nowMs + (opts.leaseMs ?? config.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
        transaction.set(ref, {
          ...(opts.seed ?? {}),
          [stateField]: "processing" satisfies ExternalSideEffectState,
          [attemptsField]: attemptCount,
          [nextRetryField]: config.mirrorLeaseIntoRetryField ? leaseExpiresIso : null,
          leaseOwner,
          leaseExpiresAt: leaseExpiresIso,
          completedAt: null,
          lastErrorCode: null,
          createdAt: current.createdAt ?? now,
          updatedAt: now,
        }, { merge: true });
        return { claim: { leaseOwner, attemptCount }, terminal: false };
      });
      if (result.terminal) await notifyTerminal(docId);
      return result.claim;
    },

    async complete(docId, leaseOwner, patch) {
      const ref = db().collection(config.collection).doc(docId);
      return db().runTransaction(async transaction => {
        const snap = await transaction.get(ref);
        if (!snap.exists) return false;
        const current = snap.data()!;
        if (current[stateField] === "completed") return true;
        if (current[stateField] !== "processing" || current.leaseOwner !== leaseOwner) return false;
        const now = new Date().toISOString();
        transaction.update(ref, {
          [stateField]: "completed" satisfies ExternalSideEffectState,
          [nextRetryField]: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastErrorCode: null,
          updatedAt: now,
          ...(patch ?? {}),
        });
        return true;
      });
    },

    async fail(docId, leaseOwner, error, opts = {}) {
      const ref = db().collection(config.collection).doc(docId);
      const result = await db().runTransaction(async transaction => {
        const snap = await transaction.get(ref);
        if (!snap.exists) return "ignored" as const;
        const current = snap.data()!;
        if (current[stateField] !== "processing" || current.leaseOwner !== leaseOwner) return "ignored" as const;
        const maxAttempts = opts.maxAttempts ?? config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        const attemptCount = Number(current[attemptsField] ?? 0);
        const isTerminal = attemptCount >= maxAttempts;
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        transaction.update(ref, {
          [stateField]: (isTerminal ? "terminal_failed" : "retryable_failed") satisfies ExternalSideEffectState,
          [nextRetryField]: isTerminal ? null : new Date(nowMs + Math.max(0, retryDelayMs(attemptCount))).toISOString(),
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: null,
          lastErrorCode: errorCode(error),
          updatedAt: now,
          ...(opts.patch ?? {}),
        });
        return isTerminal ? ("terminal" as const) : ("retryable" as const);
      });
      if (result === "terminal") await notifyTerminal(docId);
      return result;
    },
  };
}

// ── External side-effect ledger (original consumer, behavior unchanged) ──────

export function externalOperationDocId(operationKey: string): string {
  return operationKey.replace(/\//g, "%2F");
}

const externalStore = createLeasedOperationStore({
  collection: "externalSideEffectOperations",
});

export async function claimExternalSideEffectOperation(input: {
  operationKey: string;
  operationType: string;
  targetId: string;
  leaseMs?: number;
  maxAttempts?: number;
}): Promise<{ leaseOwner: string; attemptCount: number } | null> {
  return externalStore.claim(externalOperationDocId(input.operationKey), {
    seed: {
      operationKey: input.operationKey,
      operationType: input.operationType,
      targetId: input.targetId,
    },
    leaseMs: input.leaseMs,
    maxAttempts: input.maxAttempts,
    leaseOwnerPrefix: input.operationType,
  });
}

export async function completeExternalSideEffectOperation(
  operationKey: string,
  leaseOwner: string,
  providerOperationId?: string,
): Promise<boolean> {
  return externalStore.complete(
    externalOperationDocId(operationKey),
    leaseOwner,
    providerOperationId ? { providerOperationId } : undefined,
  );
}

export async function failExternalSideEffectOperation(
  operationKey: string,
  leaseOwner: string,
  error: unknown,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<void> {
  const result = await externalStore.fail(externalOperationDocId(operationKey), leaseOwner, error, { maxAttempts });

  if (result === "terminal") {
    await db().collection("admin_alerts").doc(externalOperationDocId(`external-side-effect:${operationKey}`)).set({
      type: "external_side_effect_terminal_failure",
      operationKey,
      severity: "high",
      resolved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}
