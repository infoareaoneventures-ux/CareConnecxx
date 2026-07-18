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

// Schema accommodates the later correction/forget units — only turn_sync is
// produced in this unit.
export type MemoryOperationKind = "turn_sync" | "correction" | "forget";

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
  sourceTurnKeyHash: string;
  sourceChannel: "linq" | "web";
  /** Firestore paths of the deterministic source rows — never copied text. */
  sourceMessageRefs: string[];
  learnedFactRefs: string[];
  /** Original source-turn timestamp (epoch ms) — Zep createdAt uses this, never dispatch time (KTD5). */
  sourceTurnTimestamp: number;
  /** Deterministic per-role Zep message UUIDs, persisted BEFORE dispatch (KTD5). */
  zepMessageUuids: { user: string; assistant: string };
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
