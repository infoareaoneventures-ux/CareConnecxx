// Server-only memory_operations/{operationId} ledger (memory-grounding
// hardening plan 2026-07-17-002, U3 / KTD5 / KTD6, R9/R21/R23).
//
// The ledger records cross-provider memory work (Zep transcript writes,
// learned-fact extraction — and, in a later unit, correction/forget
// propagation) as durable, retryable operations with deterministic IDs derived
// from the source-turn key. It deliberately does NOT hand-roll a second
// lease/backoff state machine: claim/complete/fail run through the shared
// leased-operation engine in operations/externalSideEffect.ts (KTD6), with the
// memory-specific field names, exponential backoff with jitter, and
// lease-mirroring so the (status ASC, nextRetryAt ASC) composite index finds
// pending, retryable, AND lease-expired work.
//
// Privacy contract (R14/R21, Data Changes): an operation doc carries
// references, hashes, statuses, and timestamps ONLY. Never a raw user message,
// fact text, prompt, draft reply, phone scalar, Zep user/thread ID, or query
// text. Firestore reference paths may resolve to legacy phone-keyed docs —
// that is accepted; the phone must never be copied into a scalar field and
// paths must never be logged. Access is denied to all clients in
// firestore.rules (server-only).

import * as admin from "firebase-admin";
import { createHash } from "crypto";
import {
  createLeasedOperationStore,
  LeasedOperationClaim,
  LeasedOperationFailResult,
} from "../operations/externalSideEffect";

// Lazy handle: this module is imported (via conversationMemory.ts) by the
// activity-backfill script BEFORE admin.initializeApp() runs — module load
// must not touch the default app.
let _db: admin.firestore.Firestore | null = null;
function db(): admin.firestore.Firestore {
  if (!_db) _db = admin.firestore();
  return _db;
}

export const MEMORY_OPERATIONS_COLLECTION = "memory_operations";

// turn_sync: U3 completed-turn Zep/fact sync.
// correction/forget: U4 staged cross-store fact changes (worker propagation in U4b).
// re_remember: U4 explicit confirmed tombstone clear — recorded already-completed
// for auditability-by-reference (KTD16/R23); it never enters the retry sweep.
export type MemoryOperationKind = "turn_sync" | "correction" | "forget" | "re_remember";

// Status values are shared with the external-side-effect engine so the two
// ledgers speak one state language.
export type MemoryOperationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "retryable_failed"
  | "terminal_failed";

/** Statuses that mean the operation's work is not finished. */
export const UNRESOLVED_MEMORY_OPERATION_STATUSES: MemoryOperationStatus[] = [
  "pending",
  "processing",
  "retryable_failed",
];

export type MemoryOperationTargetKey =
  | "firestore"
  | "zepTranscript"
  | "learnedFacts"
  | "storage"
  | "embeddings"
  | "zepEdges"
  | "zepEpisodes";

export type MemoryTargetState = "pending" | "completed" | "failed" | "skipped";

export interface MemoryOperationTargetStatus {
  status: MemoryTargetState;
  /** Sanitized error class only (R21) — never a provider error message. */
  errorClass?: string | null;
}

export interface MemoryOperationDoc {
  kind: MemoryOperationKind;
  userId: string;
  /** Firestore path (may resolve to a phone-keyed doc — accepted; never logged). */
  sessionRef: string;
  /** turn_sync only. */
  sourceTurnKeyHash?: string;
  /** turn_sync only. */
  sourceChannel?: "linq" | "web";
  /** Firestore paths of the deterministic source rows — never copied text. */
  sourceMessageRefs: string[];
  learnedFactRefs: string[];
  /** turn_sync only: original source-turn timestamp (epoch ms) — Zep createdAt uses this, never dispatch time (KTD5). */
  sourceTurnTimestamp?: number;
  /** turn_sync only: deterministic per-role Zep message UUIDs, persisted BEFORE dispatch (KTD5). */
  zepMessageUuids?: { user: string; assistant: string };
  status: MemoryOperationStatus;
  attempts: number;
  nextRetryAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  targets: Record<MemoryOperationTargetKey, MemoryOperationTargetStatus>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Set only at completion (30-day retention). Failed/unresolved ops never expire. */
  expiresAt: string | null;
}

// ── Retry policy (Implementation-Time Checks defaults — tune from Wave A) ────

/** Lease must outlive the worst-case provider work: two Zep writes × 3 retries × backoff, plus extraction. */
export const MEMORY_OPERATION_LEASE_MS = 3 * 60 * 1000;
export const MEMORY_OPERATION_MAX_ATTEMPTS = 6;
export const MEMORY_OPERATION_RETRY_BASE_MS = 60 * 1000;
export const MEMORY_OPERATION_RETRY_MAX_MS = 30 * 60 * 1000;
export const COMPLETED_MEMORY_OPERATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Exponential backoff with jitter: base·2^(n-1) capped, plus up to +20% jitter. */
export function memoryOperationRetryDelayMs(attemptCount: number): number {
  const exp = Math.min(
    MEMORY_OPERATION_RETRY_BASE_MS * Math.pow(2, Math.max(0, attemptCount - 1)),
    MEMORY_OPERATION_RETRY_MAX_MS,
  );
  return Math.round(exp + exp * 0.2 * Math.random());
}

// ── Deterministic keys (R9) ───────────────────────────────────────────────────

/**
 * Opaque, deterministic hash of the stable source-turn key (Linq eventId or
 * web clientMessageId). Channel-scoped so a Linq event ID and a web client
 * message ID can never collide. The raw provider key is NOT stored anywhere —
 * the hash is sufficient (Data Changes note).
 */
export function hashSourceTurnKey(channel: "linq" | "web", sourceKey: string): string {
  return createHash("sha256").update(`evia-turn:v1:${channel}:${sourceKey}`).digest("hex").slice(0, 32);
}

export function turnSyncOperationId(sourceTurnKeyHash: string): string {
  return `turn_sync_${sourceTurnKeyHash}`;
}

/**
 * UUIDv5-style deterministic Zep message UUID from the source-turn key + role
 * (KTD5): sha256 of a versioned name string, truncated to 16 bytes with the
 * RFC 4122 version/variant bits stamped. Stable across retries and deploys —
 * but the worker must always REUSE the persisted value from the operation doc,
 * never re-derive (the derivation could change; the persisted UUID cannot).
 */
export function deriveZepMessageUuid(
  channel: "linq" | "web",
  sourceKey: string,
  role: "user" | "assistant",
): string {
  const bytes = createHash("sha256")
    .update(`evia-zep-message:v1:${channel}:${sourceKey}:${role}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── turn_sync operation construction ─────────────────────────────────────────

export interface TurnSyncOperationInput {
  channel: "linq" | "web";
  /** Stable provider source key — used for derivation only, never stored raw. */
  sourceKey: string;
  phone: string;
  userId: string;
  /** Original turn timestamp (epoch ms). */
  turnTimestampMs: number;
  /** Whether this turn is eligible for client learned-fact extraction (R8). */
  extractFacts: boolean;
  userMessagePath: string;
  assistantMessagePath: string;
}

export function buildTurnSyncOperationDoc(
  input: TurnSyncOperationInput,
): { operationId: string; doc: MemoryOperationDoc } {
  const sourceTurnKeyHash = hashSourceTurnKey(input.channel, input.sourceKey);
  const nowIso = new Date().toISOString();
  const doc: MemoryOperationDoc = {
    kind: "turn_sync",
    userId: input.userId,
    sessionRef: `agent_sessions/${input.phone}`,
    sourceTurnKeyHash,
    sourceChannel: input.channel,
    sourceMessageRefs: [input.userMessagePath, input.assistantMessagePath],
    learnedFactRefs: [],
    sourceTurnTimestamp: input.turnTimestampMs,
    zepMessageUuids: {
      user: deriveZepMessageUuid(input.channel, input.sourceKey, "user"),
      assistant: deriveZepMessageUuid(input.channel, input.sourceKey, "assistant"),
    },
    status: "pending",
    attempts: 0,
    // Pending operations are immediately due; the same (status, nextRetryAt)
    // index that finds retryable work finds them.
    nextRetryAt: nowIso,
    leaseOwner: null,
    leaseExpiresAt: null,
    targets: {
      // The source rows commit in the SAME batch as this operation (R9).
      firestore: { status: "completed" },
      zepTranscript: { status: "pending" },
      learnedFacts: { status: input.extractFacts ? "pending" : "skipped" },
      // Not applicable to turn_sync — reserved for correction/forget kinds.
      storage: { status: "skipped" },
      embeddings: { status: "skipped" },
      zepEdges: { status: "skipped" },
      zepEpisodes: { status: "skipped" },
    },
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: null,
    expiresAt: null,
  };
  return { operationId: turnSyncOperationId(sourceTurnKeyHash), doc };
}

// ── Correction / forget operations (U4a — staging; worker propagation U4b) ───
//
// Deterministic IDs derive from the verified userId + the TARGET FACT doc ID +
// the fact's change generation (a counter bumped by re-remember), so the same
// request while work is unresolved maps to the same operation (idempotent),
// while a genuinely new lifecycle of the same fact gets a fresh ID.

export function factChangeOperationId(
  kind: "correction" | "forget",
  userId: string,
  factDocId: string,
  changeGeneration = 0,
): string {
  const hash = createHash("sha256")
    .update(`evia-fact-op:v1:${kind}:${userId}:${factDocId}:${changeGeneration}`)
    .digest("hex")
    .slice(0, 32);
  return `${kind}_${hash}`;
}

export function reRememberOperationId(userId: string, factDocId: string, changeGeneration = 0): string {
  const hash = createHash("sha256")
    .update(`evia-fact-op:v1:re_remember:${userId}:${factDocId}:${changeGeneration}`)
    .digest("hex")
    .slice(0, 32);
  return `re_remember_${hash}`;
}

export interface FactChangeOperationInput {
  kind: "correction" | "forget";
  userId: string;
  phone?: string;
  targetFactDocId: string;
  changeGeneration?: number;
  /** Firestore path of the fact being corrected/forgotten (never its text). */
  targetFactPath: string;
  /** Correction only: Firestore path of the staged replacement fact. */
  replacementFactPath?: string;
  /** Known bounded source-row provenance from the target fact — refs only. */
  sourceMessageRefs?: string[];
}

export function buildFactChangeOperationDoc(
  input: FactChangeOperationInput,
): { operationId: string; doc: MemoryOperationDoc } {
  const nowIso = new Date().toISOString();
  const doc: MemoryOperationDoc = {
    kind: input.kind,
    userId: input.userId,
    sessionRef: input.phone ? `agent_sessions/${input.phone}` : "",
    sourceMessageRefs: (input.sourceMessageRefs ?? []).slice(0, 6),
    learnedFactRefs: [
      input.targetFactPath,
      ...(input.replacementFactPath ? [input.replacementFactPath] : []),
    ],
    status: "pending",
    attempts: 0,
    nextRetryAt: nowIso,
    leaseOwner: null,
    leaseExpiresAt: null,
    targets: {
      // Not applicable to correction/forget — the fact docs themselves are
      // staged in the SAME transaction that creates this operation (KTD9).
      firestore: { status: "skipped" },
      zepTranscript: { status: "skipped" },
      // The worker (U4b) finalizes learned facts (strip/tombstone), reconciles
      // Storage files + embeddings, and invalidates/deletes Zep edges/episodes.
      learnedFacts: { status: "pending" },
      storage: { status: "pending" },
      embeddings: { status: "pending" },
      zepEdges: { status: "pending" },
      zepEpisodes: { status: "pending" },
    },
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: null,
    expiresAt: null,
  };
  return {
    operationId: factChangeOperationId(
      input.kind, input.userId, input.targetFactDocId, input.changeGeneration ?? 0,
    ),
    doc,
  };
}

/** Already-completed audit record for an explicit confirmed re-remember (KTD16). */
export function buildReRememberOperationDoc(input: {
  userId: string;
  phone?: string;
  targetFactDocId: string;
  targetFactPath: string;
  changeGeneration?: number;
}): { operationId: string; doc: MemoryOperationDoc } {
  const nowIso = new Date().toISOString();
  const doc: MemoryOperationDoc = {
    kind: "re_remember",
    userId: input.userId,
    sessionRef: input.phone ? `agent_sessions/${input.phone}` : "",
    sourceMessageRefs: [],
    learnedFactRefs: [input.targetFactPath],
    status: "completed",
    attempts: 0,
    nextRetryAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    targets: {
      firestore: { status: "skipped" },
      zepTranscript: { status: "skipped" },
      learnedFacts: { status: "completed" },
      storage: { status: "skipped" },
      embeddings: { status: "skipped" },
      zepEdges: { status: "skipped" },
      zepEpisodes: { status: "skipped" },
    },
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: nowIso,
    expiresAt: new Date(Date.now() + COMPLETED_MEMORY_OPERATION_TTL_MS).toISOString(),
  };
  return {
    operationId: reRememberOperationId(
      input.userId, input.targetFactDocId, input.changeGeneration ?? 0,
    ),
    doc,
  };
}

// ── Per-user reconciliation flag (U4a suppression check, KTD9) ───────────────
//
// Design choice: a per-user FLAG DOC (memory_reconciliation/{userId}) rather
// than an equality query on memory_operations. Rationale:
//  • the check runs on EVERY prompt turn and inside every shared memory reader
//    (getMemoryContext, searchMemory*, searchZepMemory) — a single point read
//    is the cheapest possible primitive and needs no composite index deploy;
//  • Firestore allows only one `in` filter per query, and the natural query
//    (userId == X AND kind in [correction,forget] AND status in UNRESOLVED)
//    needs two;
//  • the flag is maintained TRANSACTIONALLY with staging (same transaction that
//    creates the operation and marks the fact pending), so it can never lag a
//    staged change; the worker clears entries on completion (U4b), and this
//    reader self-heals entries whose operation is already completed/expired.
//
// The doc stores operation IDs + kinds only — never fact text (R14/R21).

export const MEMORY_RECONCILIATION_COLLECTION = "memory_reconciliation";

export interface ReconciliationFlagEntry {
  kind: "correction" | "forget";
  createdAt: string;
}

/** Field patch that ADDS one pending entry — for use inside the staging transaction. */
export function reconciliationFlagAdd(
  operationId: string,
  kind: "correction" | "forget",
): Record<string, unknown> {
  return {
    pendingOperations: { [operationId]: { kind, createdAt: new Date().toISOString() } },
    updatedAt: new Date().toISOString(),
  };
}

export interface MemoryReconciliationState {
  /** Any correction/forget operation unresolved for this user. */
  pending: boolean;
  /** Storage memory files + embeddings must stay omitted (KTD9 per-store). */
  storageMasked: boolean;
  /** Zep context / graph search must stay omitted (KTD9 per-store). */
  zepMasked: boolean;
  pendingOperationIds: string[];
}

export const RECONCILIATION_ALL_CLEAR: MemoryReconciliationState = {
  pending: false,
  storageMasked: false,
  zepMasked: false,
  pendingOperationIds: [],
};

const UNRESOLVED_TARGET_STATES = new Set(["pending", "failed"]);
/** Bound on how many flagged operations one state read follows (R21-safe). */
const RECONCILIATION_MAX_TRACKED_OPS = 20;

function targetUnresolved(targets: Record<string, { status?: string } | undefined>, key: string): boolean {
  return UNRESOLVED_TARGET_STATES.has(String(targets?.[key]?.status ?? ""));
}

/**
 * Per-store suppression state for one user. Cheap: one point read for the
 * common (no reconciliation) case; a bounded set of operation reads otherwise.
 * Per-store unmasking (KTD9 as amended): once EVERY target in a store confirms
 * across all unresolved operations, that store's context returns while the
 * still-unconfirmed store stays omitted.
 *
 * Fail-open on read error (matching every shared memory reader's posture) with
 * a sanitized aggregate log — the flag doc lives in the same Firestore as the
 * memory it guards, so a read outage here implies the guarded reads fail too.
 */
export async function getMemoryReconciliationState(
  userId: string,
  dbArg?: admin.firestore.Firestore,
): Promise<MemoryReconciliationState> {
  if (!userId) return RECONCILIATION_ALL_CLEAR;
  const store = dbArg ?? db();
  try {
    const flagRef = store.collection(MEMORY_RECONCILIATION_COLLECTION).doc(userId);
    const flagSnap = await flagRef.get();
    const pendingMap = (flagSnap.exists ? flagSnap.data()?.pendingOperations : null) as
      | Record<string, ReconciliationFlagEntry>
      | null
      | undefined;
    const opIds = pendingMap ? Object.keys(pendingMap).slice(0, RECONCILIATION_MAX_TRACKED_OPS) : [];
    if (opIds.length === 0) return RECONCILIATION_ALL_CLEAR;

    const opSnaps = await Promise.all(
      opIds.map((id) => store.collection(MEMORY_OPERATIONS_COLLECTION).doc(id).get()),
    );

    let storageMasked = false;
    let zepMasked = false;
    const unresolvedIds: string[] = [];
    const resolvedEntries: string[] = [];

    for (let i = 0; i < opIds.length; i++) {
      const snap = opSnaps[i];
      const data = snap.exists ? snap.data() ?? {} : null;
      // Missing (expired-after-completion) or completed → resolved: self-heal
      // the flag entry. Failed/unresolved operations never expire, so a missing
      // doc can only mean prior completion.
      if (!data || data.status === "completed") {
        resolvedEntries.push(opIds[i]);
        continue;
      }
      unresolvedIds.push(opIds[i]);
      const targets = (data.targets ?? {}) as Record<string, { status?: string }>;
      if (targetUnresolved(targets, "storage") || targetUnresolved(targets, "embeddings")) {
        storageMasked = true;
      }
      if (targetUnresolved(targets, "zepEdges") || targetUnresolved(targets, "zepEpisodes")) {
        zepMasked = true;
      }
    }

    if (resolvedEntries.length > 0) {
      // Best-effort self-heal — next read gets the cheap all-clear point read.
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const id of resolvedEntries) {
        patch[`pendingOperations.${id}`] = admin.firestore.FieldValue.delete();
      }
      flagRef.update(patch).catch(() => {});
    }

    return {
      pending: unresolvedIds.length > 0,
      storageMasked,
      zepMasked,
      pendingOperationIds: unresolvedIds,
    };
  } catch (err) {
    // R21: outcome + error class only.
    console.warn(JSON.stringify({
      severity: "WARNING",
      memory_reconciliation_check_failed: true,
      error_class: errorClassOf(err),
      timestamp: new Date().toISOString(),
    }));
    return RECONCILIATION_ALL_CLEAR;
  }
}

/** Cheapest form of the check — true while ANY correction/forget is unresolved. */
export async function hasUnresolvedReconciliation(
  userId: string,
  dbArg?: admin.firestore.Firestore,
): Promise<boolean> {
  return (await getMemoryReconciliationState(userId, dbArg)).pending;
}

// ── Claim / complete / fail (shared engine, KTD6) ────────────────────────────

function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

/**
 * Deduplicated terminal alert (one admin_alerts doc per operation, set+merge).
 * Carries the opaque operation ID only — no refs, no content, no phone (R21).
 */
async function writeTerminalMemoryOperationAlert(operationId: string): Promise<void> {
  await db().collection("admin_alerts").doc(`memory-operation:${operationId}`).set({
    type: "memory_operation_terminal_failure",
    operationId,
    severity: "high",
    resolved: false,
    createdAt: new Date().toISOString(),
  }, { merge: true }).catch(() => {});
}

const memoryStore = createLeasedOperationStore({
  collection: MEMORY_OPERATIONS_COLLECTION,
  stateField: "status",
  attemptsField: "attempts",
  nextRetryField: "nextRetryAt",
  leaseMs: MEMORY_OPERATION_LEASE_MS,
  maxAttempts: MEMORY_OPERATION_MAX_ATTEMPTS,
  retryDelayMs: memoryOperationRetryDelayMs,
  // Operations are pre-created atomically with their source rows — a claim on
  // a missing doc must never fabricate one.
  createOnClaim: false,
  // Expired leases stay discoverable via (status=="processing", nextRetryAt<=now).
  mirrorLeaseIntoRetryField: true,
  // R21: persist the sanitized error class, never a provider message (which
  // can embed request URLs / thread IDs / content).
  errorCode: errorClassOf,
  onTerminal: writeTerminalMemoryOperationAlert,
});

export async function claimMemoryOperation(operationId: string): Promise<LeasedOperationClaim | null> {
  return memoryStore.claim(operationId, { leaseOwnerPrefix: "memory-worker" });
}

export async function completeMemoryOperation(operationId: string, leaseOwner: string): Promise<boolean> {
  return memoryStore.complete(operationId, leaseOwner, {
    expiresAt: new Date(Date.now() + COMPLETED_MEMORY_OPERATION_TTL_MS).toISOString(),
  });
}

export async function failMemoryOperation(
  operationId: string,
  leaseOwner: string,
  error: unknown,
): Promise<LeasedOperationFailResult> {
  return memoryStore.fail(operationId, leaseOwner, error);
}

/** Mark a single per-target outcome on a leased operation (dot-path update). */
export async function markMemoryOperationTarget(
  operationId: string,
  target: MemoryOperationTargetKey,
  status: MemoryTargetState,
  errorClass?: string,
): Promise<void> {
  await db().collection(MEMORY_OPERATIONS_COLLECTION).doc(operationId).update({
    [`targets.${target}.status`]: status,
    [`targets.${target}.errorClass`]: errorClass ?? null,
    updatedAt: new Date().toISOString(),
  });
}
