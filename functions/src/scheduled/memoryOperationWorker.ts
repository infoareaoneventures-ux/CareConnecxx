// Scheduled memory-operation retry worker (memory-grounding hardening plan
// 2026-07-17-002, U3 / KTD5 / KTD6, R8/R9/R21).
//
// Every minute this worker transactionally claims due turn_sync operations
// from the server-only memory_operations ledger (shared leased-operation
// engine — see operations/externalSideEffect.ts) and dispatches the durable
// side effects the ingress turn deferred:
//   • strict Zep transcript writes with the PERSISTED deterministic per-role
//     UUIDs (never re-derived) and the ORIGINAL source-turn timestamp as
//     createdAt — never dispatch time (KTD5),
//   • idempotent client learned-fact extraction (KTD7),
//   • clearing memorySyncStatus on the source rows so nightly compression may
//     eventually fold them (R9).
//
// Ordering (KTD5): each user's turn_sync operations are processed in
// SOURCE-TURN ORDER. An older unresolved turn blocks younger turns for that
// user — younger due operations are simply left for a later sweep — so a
// retried older turn can never land in Zep after its own correction.
//
// Telemetry (R21): aggregate counts and sanitized error classes only. No
// operation IDs, no phones, no paths, no content.

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  claimMemoryOperation,
  completeMemoryOperation,
  failMemoryOperation,
  markMemoryOperationTarget,
  MEMORY_OPERATIONS_COLLECTION,
  UNRESOLVED_MEMORY_OPERATION_STATUSES,
} from "../memory/memoryOperations";
import { addUserMessageToZepStrict, addAssistantMessageToZepStrict } from "../memory/zepClient";
import { extractAndStoreFacts } from "../memory/learnedFacts";

const db = admin.firestore();

export const MEMORY_WORKER_BATCH_LIMIT = 25;

/**
 * Provider duplicate/already-exists responses are SUCCESS (KTD5): a worker
 * crash or timeout after Zep stored the message must reconcile as
 * duplicate-success on retry, not create a second episode.
 */
export function isZepDuplicateError(err: unknown): boolean {
  const status = (err as { status?: unknown; statusCode?: unknown });
  if (status?.status === 409 || status?.statusCode === 409) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /already[\s_-]?exists|duplicate/i.test(msg);
}

export interface MemoryWorkerCounts {
  /** Distinct due operations found by the sweep queries. */
  due: number;
  /** Due operations of a kind this worker does not process yet. */
  nonTurnSync: number;
  /** Due operations another worker claimed first (or that terminal-failed at claim). */
  claimMissed: number;
  /** Younger due operations left queued because an older turn for the same user is unresolved. */
  blockedByOlder: number;
  completed: number;
  retryable: number;
  terminal: number;
  /** Zep writes reconciled as duplicate-success. */
  zepDuplicates: number;
}

interface DueOp {
  id: string;
  data: FirebaseFirestore.DocumentData;
}

export async function runMemoryOperationWorker(nowMs: number = Date.now()): Promise<MemoryWorkerCounts> {
  const counts: MemoryWorkerCounts = {
    due: 0, nonTurnSync: 0, claimMissed: 0, blockedByOlder: 0,
    completed: 0, retryable: 0, terminal: 0, zepDuplicates: 0,
  };
  const nowIso = new Date(nowMs).toISOString();

  // Due = pending/retryable work past nextRetryAt, PLUS processing operations
  // whose mirrored nextRetryAt (== leaseExpiresAt) has passed — i.e. expired
  // leases. One (status ASC, nextRetryAt ASC) composite index serves all three.
  const due = new Map<string, DueOp>();
  for (const status of UNRESOLVED_MEMORY_OPERATION_STATUSES) {
    const snap = await db.collection(MEMORY_OPERATIONS_COLLECTION)
      .where("status", "==", status)
      .where("nextRetryAt", "<=", nowIso)
      .orderBy("nextRetryAt", "asc")
      .limit(MEMORY_WORKER_BATCH_LIMIT)
      .get();
    for (const d of snap.docs) due.set(d.id, { id: d.id, data: d.data() });
  }
  counts.due = due.size;

  // Group due turn_sync work by user for source-turn ordering.
  const byUser = new Map<string, DueOp[]>();
  for (const op of due.values()) {
    if (op.data.kind !== "turn_sync") {
      counts.nonTurnSync++;
      continue;
    }
    const userId = String(op.data.userId ?? "");
    const list = byUser.get(userId) ?? [];
    list.push(op);
    byUser.set(userId, list);
  }

  for (const [userId, dueOps] of byUser) {
    await processUserOperations(userId, dueOps, counts);
  }

  // Aggregate-only worker log (R21).
  console.log(JSON.stringify({
    memory_operation_worker: true,
    ...counts,
    timestamp: new Date().toISOString(),
  }));
  return counts;
}

async function processUserOperations(
  userId: string,
  dueOps: DueOp[],
  counts: MemoryWorkerCounts,
): Promise<void> {
  // Fetch ALL unresolved turn_sync operations for this user (equality-only
  // query — served by Firestore's merged single-field indexes, no composite
  // needed) and walk them oldest-first. The due batch alone is not enough: an
  // older turn can be unresolved-but-not-due (future backoff), and a younger
  // due turn must NOT jump it.
  let orderedUnresolved: DueOp[];
  try {
    const snap = await db.collection(MEMORY_OPERATIONS_COLLECTION)
      .where("userId", "==", userId)
      .where("kind", "==", "turn_sync")
      .where("status", "in", UNRESOLVED_MEMORY_OPERATION_STATUSES)
      .get();
    orderedUnresolved = snap.docs
      .map(d => ({ id: d.id, data: d.data() }))
      .sort((a, b) => Number(a.data.sourceTurnTimestamp ?? 0) - Number(b.data.sourceTurnTimestamp ?? 0));
  } catch {
    // Ordering query failed — safer to do nothing for this user this sweep
    // than to risk out-of-order Zep transcript writes.
    counts.blockedByOlder += dueOps.length;
    return;
  }

  const dueIds = new Set(dueOps.map(o => o.id));
  const handled = new Set<string>();
  for (const op of orderedUnresolved) {
    if (!dueIds.has(op.id)) break; // older turn unresolved but not due → younger turns wait
    const claim = await claimMemoryOperation(op.id);
    if (!claim) {
      counts.claimMissed++;
      handled.add(op.id);
      break; // leased elsewhere / terminal — younger turns wait for resolution
    }
    handled.add(op.id);
    try {
      const result = await processTurnSyncOperation(op.id, claim.leaseOwner);
      counts.zepDuplicates += result.zepDuplicates;
      counts.completed++;
    } catch (err) {
      const failResult = await failMemoryOperation(op.id, claim.leaseOwner, err);
      if (failResult === "terminal") counts.terminal++;
      else counts.retryable++;
      break; // this user's younger turns stay blocked behind the failure
    }
  }
  counts.blockedByOlder += [...dueIds].filter(id => !handled.has(id)).length;
}

async function processTurnSyncOperation(
  operationId: string,
  leaseOwner: string,
): Promise<{ zepDuplicates: number }> {
  let zepDuplicates = 0;

  // Re-read the operation AFTER claiming: per-target statuses from a prior
  // partially-successful attempt must be honored (a Zep write that already
  // completed is not re-sent).
  const opSnap = await db.collection(MEMORY_OPERATIONS_COLLECTION).doc(operationId).get();
  const op = opSnap.data();
  if (!op) throw new Error("operation_missing");

  const targets = (op.targets ?? {}) as Record<string, { status?: string }>;
  const sourceRefs = (op.sourceMessageRefs ?? []) as string[];

  // Canonical content is read only while processing (KTD6) — never stored on
  // the operation.
  const rowSnaps = await Promise.all(sourceRefs.map(path => db.doc(path).get()));
  const rows = rowSnaps.map(s => (s.exists ? s.data()! : null));
  const userRow = rows.find(r => r?.role === "user");
  const assistantRow = rows.find(r => r?.role === "assistant");
  if (!userRow || !assistantRow) throw new Error("source_row_missing");

  if (targets.zepTranscript?.status === "pending" || targets.zepTranscript?.status === "failed") {
    const sessionSnap = await db.doc(String(op.sessionRef)).get();
    const session = sessionSnap.exists ? sessionSnap.data()! : {};
    const zepThreadId = session.zepThreadId as string | undefined;
    if (!zepThreadId) throw new Error("missing_zep_thread");
    const userName = (session.firstName as string | undefined) ?? "Family";

    const uuids = (op.zepMessageUuids ?? {}) as { user?: string; assistant?: string };
    const turnMs = Number(op.sourceTurnTimestamp ?? Date.now());

    // KTD5: persisted deterministic UUIDs (never re-derived) + the ORIGINAL
    // source-turn timestamps — a retry must be byte-identical to the first
    // attempt so the provider can deduplicate it.
    try {
      await addUserMessageToZepStrict({
        threadId: zepThreadId,
        content: String(userRow.content ?? ""),
        userName,
        sentAt: new Date(turnMs),
        uuid: uuids.user,
      });
    } catch (err) {
      if (!isZepDuplicateError(err)) throw err;
      zepDuplicates++;
    }
    try {
      await addAssistantMessageToZepStrict({
        threadId: zepThreadId,
        content: String(assistantRow.content ?? ""),
        sentAt: new Date(turnMs + 1),
        uuid: uuids.assistant,
      });
    } catch (err) {
      if (!isZepDuplicateError(err)) throw err;
      zepDuplicates++;
    }
    await markMemoryOperationTarget(operationId, "zepTranscript", "completed");
  }

  if (targets.learnedFacts?.status === "pending" || targets.learnedFacts?.status === "failed") {
    // Idempotent per source-turn key (KTD7): a retried extraction increments a
    // fact at most once. No zepUserId — the Zep transcript above already
    // carries the turn for graph extraction (KTD8).
    await extractAndStoreFacts(String(op.userId), String(userRow.content ?? ""), undefined, {
      sourceTurnKeyHash: String(op.sourceTurnKeyHash ?? ""),
      sourceMessageRefs: sourceRefs,
    });
    await markMemoryOperationTarget(operationId, "learnedFacts", "completed");
  }

  // All targets resolved: release the source rows to nightly compression (R9)…
  const clearBatch = db.batch();
  for (const path of sourceRefs) {
    clearBatch.update(db.doc(path), { memorySyncStatus: admin.firestore.FieldValue.delete() });
  }
  await clearBatch.commit();

  // …then finalize (sets completedAt + 30-day expiresAt). A crash between the
  // two is safe: the retry re-runs already-completed targets as no-ops.
  await completeMemoryOperation(operationId, leaseOwner);
  return { zepDuplicates };
}

// Every minute — the sweep cadence is the shortest useful retry delay
// (mirrors outboundQueueDrain's registration shape).
export const memoryOperationWorker = functions.pubsub
  .schedule("every 1 minutes")
  .onRun(async () => {
    await runMemoryOperationWorker();
  });
