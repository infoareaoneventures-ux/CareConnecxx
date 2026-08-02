// Scheduled memory-operation retry worker (memory-grounding hardening plan
// 2026-07-17-002, U3/U4b, KTD5/KTD6/KTD9/KTD10/KTD16, R8/R9/R13/R14/R21/R23).
//
// Every minute this worker transactionally claims due operations from the
// server-only memory_operations ledger (shared leased-operation engine — see
// operations/externalSideEffect.ts) and dispatches the durable side effects:
//
// turn_sync (U3):
//   • strict Zep transcript writes with the PERSISTED deterministic per-role
//     UUIDs (never re-derived) and the ORIGINAL source-turn timestamp as
//     createdAt — never dispatch time (KTD5),
//   • idempotent client learned-fact extraction (KTD7),
//   • clearing memorySyncStatus on the source rows so nightly compression may
//     eventually fold them (R9).
//
// correction / forget (U4b): resumable per-target propagation —
//   1. storage      — exact-match reconcile of the retired fact across the
//                     user's memory files (corrections write the corrected
//                     value; forgets remove the assertion),
//   2. embeddings   — purge embedding rows still carrying the retired text,
//   3. zepEpisodes/zepEdges — search the user's graph for matching edges;
//                     corrections stamp invalidAt, forgets delete matching
//                     edges AND their source episodes (episodes first, so a
//                     retry can still re-locate them through surviving edges).
//                     A MIXED episode is deleted — privacy wins; its unrelated
//                     facts remain in the higher-authority stores and are NOT
//                     re-ingested into Zep,
//   4. source rows  — known sourceMessageRefs are marked
//                     excludeFromMemoryConsolidationAt(+reason); legacy facts
//                     without provenance get a bounded scan of the 7-day
//                     consolidation window (KTD16/R23),
//   5. learnedFacts — finalize: corrections clear the pending marker on the
//                     superseded doc; forgets strip plaintext/embedding into a
//                     no-plaintext HMAC tombstone (fingerprint key REQUIRED to
//                     finalize — an unbound secret is a retryable failure),
//   6. completion   — durable agent_audit_log entry (memory_fact_corrected /
//                     memory_fact_forgotten — no fact text) written BEFORE the
//                     operation becomes expiry-eligible, then completedAt +
//                     30-day expiresAt, then the user's reconciliation-flag
//                     entry is cleared. Failed/unresolved operations never
//                     expire and stay masked (KTD9).
//
// Ordering (KTD5): each user's turn_sync operations are processed in
// SOURCE-TURN ORDER. An older unresolved turn blocks younger turns for that
// user. Correction/forget operations are independent of that ordering.
//
// Telemetry (R21): aggregate counts and sanitized error classes only. No
// operation IDs, no phones, no paths, no fact text, no Zep IDs.

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  claimMemoryOperation,
  clearReconciliationFlagEntry,
  completeMemoryOperation,
  failMemoryOperation,
  markMemoryOperationTarget,
  MEMORY_OPERATION_MAX_ATTEMPTS,
  MEMORY_OPERATIONS_COLLECTION,
  MemoryOperationTargetKey,
  TERMINAL_MEMORY_SYNC_STATUS,
  UNRESOLVED_MEMORY_OPERATION_STATUSES,
} from "../memory/memoryOperations";
import {
  addUserMessageToZepStrict,
  addAssistantMessageToZepStrict,
  findZepEdgesMatchingFact,
  invalidateZepEdgeStrict,
  deleteZepEdgeStrict,
  deleteZepEpisodeStrict,
  verifyZepForgottenFactAbsent,
  zepEdgeFactMatches,
  getZepUserId,
} from "../memory/zepClient";
import { extractAndStoreFacts, normalizeFactForFingerprint } from "../memory/learnedFacts";
import { reconcileFactAcrossMemoryFiles, deleteEmbeddingRowsMatching } from "../memory/memoryFiles";
import {
  getFingerprintKey,
  hmacFingerprint,
  MEMORY_FINGERPRINT_KEY_NAME,
  MEMORY_FINGERPRINT_KEY_SECRET,
} from "../memory/fingerprintKey";
import { logAudit } from "../observability/auditLog";
import { errorClassOf } from "../utils/errorClass";
import {
  AGED_MEMORY_OPERATION_ALERT_MS,
  raiseAgedMemoryOperationAlert,
  raiseTurnSyncOrderingBacklogAlert,
} from "../observability/caraOpsAlerts";
import { conversationPartitionIdsForRead } from "../agents/turnSourceKey";

const db = admin.firestore();

export const MEMORY_WORKER_BATCH_LIMIT = 25;

/** Bounded legacy-provenance scan window/size (KTD16) — mirrors consolidation's 7d/60-row read. */
export const LEGACY_SOURCE_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_SOURCE_SCAN_LIMIT = 60;
/** Maximum unresolved turn_sync rows inspected per user before failing closed. */
export const TURN_SYNC_ORDERING_SCAN_LIMIT = LEGACY_SOURCE_SCAN_LIMIT;

/** Terminal-failed forget repair sweep: operations inspected per run. */
export const TERMINAL_FORGET_REVERIFY_LIMIT = 5;
/** Terminal-failed forget repair sweep: bounded re-verify budget per operation. */
export const TERMINAL_FORGET_REVERIFY_MAX_ATTEMPTS = 3;

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
  /** Due operations of a kind this worker does not process (e.g. malformed). */
  unsupportedKind: number;
  /** Due operations another worker claimed first (or that terminal-failed at claim). */
  claimMissed: number;
  /** Younger due turn_sync operations left queued behind an older unresolved turn. */
  blockedByOlder: number;
  /** Users deferred because their unresolved turn_sync queue exceeded the ordering cap. */
  orderingBacklogOverflows: number;
  completed: number;
  retryable: number;
  terminal: number;
  /** Zep writes reconciled as duplicate-success. */
  zepDuplicates: number;
  /** turn_sync zepTranscript targets skipped: the session has no Zep thread. */
  zepTranscriptSkips: number;
  /** Forget verifications run edge-inventory-only (no Zep thread to render). */
  forgetContextChecksSkipped: number;
  /** terminal_failed forgets re-opened after a clean Zep re-verify (repair path). */
  terminalForgetsReopened: number;
  /** Correction/forget operations fully completed this sweep. */
  factChangesCompleted: number;
  /** Source conversation rows newly excluded from consolidation (KTD16). */
  sourceRowsExcluded: number;
  /** Due operations older than AGED_MEMORY_OPERATION_ALERT_MS (U9 health signal). */
  agedPending: number;
  /** Age of the oldest due operation this sweep (ms; 0 when none are due). */
  oldestDueAgeMs: number;
}

interface DueOp {
  id: string;
  data: FirebaseFirestore.DocumentData;
}

export async function runMemoryOperationWorker(nowMs: number = Date.now()): Promise<MemoryWorkerCounts> {
  const counts: MemoryWorkerCounts = {
    due: 0, unsupportedKind: 0, claimMissed: 0, blockedByOlder: 0, orderingBacklogOverflows: 0,
    completed: 0, retryable: 0, terminal: 0, zepDuplicates: 0,
    zepTranscriptSkips: 0, forgetContextChecksSkipped: 0, terminalForgetsReopened: 0,
    factChangesCompleted: 0, sourceRowsExcluded: 0,
    agedPending: 0, oldestDueAgeMs: 0,
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

  // U9 aged-operation health check (evaluated over the due snapshot BEFORE
  // processing: an operation that spent over an hour unresolved is a health
  // event even if this very sweep finally resolves it). Every unresolved
  // operation re-enters the due set within ≤30 minutes (max backoff / lease
  // mirror), so a per-sweep look at the due batch cannot miss a stuck one.
  // The alert itself is deduplicated per operation (deterministic doc ID).
  for (const op of due.values()) {
    const createdMs = Date.parse(String(op.data.createdAt ?? ""));
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = nowMs - createdMs;
    if (ageMs > counts.oldestDueAgeMs) counts.oldestDueAgeMs = ageMs;
    if (ageMs >= AGED_MEMORY_OPERATION_ALERT_MS) {
      counts.agedPending++;
      await raiseAgedMemoryOperationAlert({
        operationId: op.id,
        kind: String(op.data.kind ?? ""),
        status: String(op.data.status ?? ""),
        ageMs,
        attempts: Number(op.data.attempts ?? 0),
      });
    }
  }

  // Split by kind: turn_sync work is grouped per user for source-turn
  // ordering; correction/forget operations are independent of that ordering.
  const byUser = new Map<string, DueOp[]>();
  const factChanges: DueOp[] = [];
  for (const op of due.values()) {
    if (op.data.kind === "turn_sync") {
      const userId = String(op.data.userId ?? "");
      const list = byUser.get(userId) ?? [];
      list.push(op);
      byUser.set(userId, list);
    } else if (op.data.kind === "correction" || op.data.kind === "forget") {
      factChanges.push(op);
    } else {
      counts.unsupportedKind++;
    }
  }

  for (const [userId, dueOps] of byUser) {
    await processUserOperations(userId, dueOps, counts, nowMs);
  }

  for (const op of factChanges) {
    const claim = await claimMemoryOperation(op.id);
    if (!claim) {
      counts.claimMissed++;
      continue;
    }
    try {
      await processFactChangeOperation(op.id, claim.leaseOwner, counts);
      counts.completed++;
      counts.factChangesCompleted++;
    } catch (err) {
      const failResult = await failMemoryOperation(op.id, claim.leaseOwner, err);
      if (failResult === "terminal") counts.terminal++;
      else counts.retryable++;
    }
  }

  // Repair sweep: terminal_failed forgets whose Zep layer is verifiably clean
  // must not mask the user's memory forever (audit P1).
  await sweepTerminalFailedForgets(counts);

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
  nowMs: number,
): Promise<void> {
  // Fetch a capped unresolved turn_sync set for this user (equality-only
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
      .limit(TURN_SYNC_ORDERING_SCAN_LIMIT + 1)
      .get();
    if (snap.docs.length > TURN_SYNC_ORDERING_SCAN_LIMIT) {
      // Do not sort a partial set: an unseen older source turn could otherwise
      // be overtaken. The aggregate-only alert contains no user or operation ID.
      counts.orderingBacklogOverflows++;
      counts.blockedByOlder += dueOps.length;
      await raiseTurnSyncOrderingBacklogAlert({
        cap: TURN_SYNC_ORDERING_SCAN_LIMIT,
        observedAtLeast: snap.docs.length,
        nowMs,
      });
      return;
    }
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
      counts.zepTranscriptSkips += result.zepTranscriptSkipped;
      counts.completed++;
    } catch (err) {
      const failResult = await failMemoryOperation(op.id, claim.leaseOwner, err);
      if (failResult === "terminal") {
        counts.terminal++;
        // R9 repair: a terminal turn_sync is never retried, so its source
        // rows' memorySyncStatus must not protect them from compression
        // forever. Stamp the terminal marker (visible on the row) so
        // compression/rollup treat the rows as released.
        await releaseTerminalTurnSyncSourceRows(op.data);
      } else {
        counts.retryable++;
      }
      break; // this user's younger turns stay blocked behind the failure
    }
  }
  counts.blockedByOlder += [...dueIds].filter(id => !handled.has(id)).length;
}

/** Best-effort release of a TERMINAL turn_sync operation's source rows (R9). */
async function releaseTerminalTurnSyncSourceRows(
  op: FirebaseFirestore.DocumentData,
): Promise<void> {
  const refs = (op.sourceMessageRefs ?? []) as string[];
  for (const path of refs) {
    await db.doc(path)
      .update({ memorySyncStatus: TERMINAL_MEMORY_SYNC_STATUS })
      .catch(() => {}); // already folded / missing row — nothing to release
  }
}

async function processTurnSyncOperation(
  operationId: string,
  leaseOwner: string,
): Promise<{ zepDuplicates: number; zepTranscriptSkipped: number }> {
  let zepDuplicates = 0;
  let zepTranscriptSkipped = 0;

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

  // ── Childcare U10 backstop (R50/KTD17): eligibility is re-decided at
  // DISPATCH time from the live session + the immutable row stamps. A denied
  // session (reclassified senior→child, caregiver-childcare-context) or an
  // exclusion-stamped row marks every remaining target skipped — the worker
  // can never sync a denied turn into Zep or extract facts from it, even for
  // an operation created before the denial (retroactive-sync prohibition).
  {
    const { decideMemoryEligibility, logMemoryDenial, isMemoryExcludedRow } =
      await import("../memory/memoryEligibility");
    const sessionSnapForEligibility = await db.doc(String(op.sessionRef)).get();
    const sessionForEligibility = sessionSnapForEligibility.exists ? sessionSnapForEligibility.data()! : null;
    const decision = decideMemoryEligibility(sessionForEligibility as never);
    const rowExcluded = rows.some((r) => isMemoryExcludedRow(r as Record<string, unknown>));
    if (rowExcluded || !decision.eligible) {
      if (!decision.eligible) logMemoryDenial("memory_operation_worker_turn_sync", decision);
      else console.info(JSON.stringify({ memory_denied: true, site: "memory_operation_worker_turn_sync", reason: "row_exclusion_stamp" }));
      if (targets.zepTranscript?.status === "pending" || targets.zepTranscript?.status === "failed") {
        await markMemoryOperationTarget(operationId, "zepTranscript", "skipped");
        zepTranscriptSkipped = 1;
      }
      if (targets.learnedFacts?.status === "pending" || targets.learnedFacts?.status === "failed") {
        await markMemoryOperationTarget(operationId, "learnedFacts", "skipped");
      }
      const clearDenied = db.batch();
      for (const path of sourceRefs) {
        clearDenied.update(db.doc(path), { memorySyncStatus: admin.firestore.FieldValue.delete() });
      }
      await clearDenied.commit().catch(() => {});
      await completeMemoryOperation(operationId, leaseOwner);
      return { zepDuplicates, zepTranscriptSkipped };
    }
  }

  if (targets.zepTranscript?.status === "pending" || targets.zepTranscript?.status === "failed") {
    const sessionSnap = await db.doc(String(op.sessionRef)).get();
    const session = sessionSnap.exists ? sessionSnap.data()! : {};
    const zepThreadId = session.zepThreadId as string | undefined;
    if (!zepThreadId) {
      // No-Zep-identity SUCCESS semantics (mirrors the fact-change path): a
      // session that never acquired a Zep thread has no transcript target.
      // Throwing here minted a doomed retry cycle EVERY turn (terminal-alert
      // spam). The skip is durable on the target and counted in aggregates.
      await markMemoryOperationTarget(operationId, "zepTranscript", "skipped");
      zepTranscriptSkipped = 1;
    } else {
      const userName = (session.firstName as string | undefined) ?? "Family";

      const uuids = (op.zepMessageUuids ?? {}) as { user?: string; assistant?: string };
      const turnMs = Number(op.sourceTurnTimestamp ?? Date.now());

      // KTD5: persisted deterministic UUIDs (never re-derived) + the ORIGINAL
      // source-turn timestamps — a retry must be byte-identical to the first
      // attempt so the provider can deduplicate it.
      try {
        const result = await addUserMessageToZepStrict({
          threadId: zepThreadId,
          content: String(userRow.content ?? ""),
          userName,
          sentAt: new Date(turnMs),
          uuid: uuids.user,
        });
        if (result.deduplicated) zepDuplicates++;
      } catch (err) {
        if (!isZepDuplicateError(err)) throw err;
        zepDuplicates++;
      }
      try {
        const result = await addAssistantMessageToZepStrict({
          threadId: zepThreadId,
          content: String(assistantRow.content ?? ""),
          sentAt: new Date(turnMs + 1),
          uuid: uuids.assistant,
        });
        if (result.deduplicated) zepDuplicates++;
      } catch (err) {
        if (!isZepDuplicateError(err)) throw err;
        zepDuplicates++;
      }
      await markMemoryOperationTarget(operationId, "zepTranscript", "completed");
    }
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
  return { zepDuplicates, zepTranscriptSkipped };
}

// ── Correction / forget propagation (U4b) ────────────────────────────────────

function targetNeedsWork(targets: Record<string, { status?: string }>, key: string): boolean {
  const s = targets?.[key]?.status;
  return s === "pending" || s === "failed";
}

/** Runs one target's work; marks completed on success, failed (+ sanitized error class, R21) then rethrows on error. */
async function runTargetStep(
  operationId: string,
  target: MemoryOperationTargetKey,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    await markMemoryOperationTarget(operationId, target, "completed");
  } catch (err) {
    await markMemoryOperationTarget(operationId, target, "failed", errorClassOf(err)).catch(() => {});
    throw err;
  }
}

async function resolveOperationPhone(op: FirebaseFirestore.DocumentData): Promise<string> {
  const sessionRef = String(op.sessionRef ?? "");
  if (sessionRef.startsWith("agent_sessions/")) {
    const phone = sessionRef.slice("agent_sessions/".length);
    if (phone) return phone;
  }
  try {
    const snap = await db.collection("agent_sessions")
      .where("userId", "==", String(op.userId ?? ""))
      .limit(1)
      .get();
    return snap.empty ? "" : snap.docs[0].id;
  } catch {
    return "";
  }
}

async function processFactChangeOperation(
  operationId: string,
  leaseOwner: string,
  counts: MemoryWorkerCounts,
): Promise<void> {
  // Re-read AFTER claiming so a prior attempt's per-target progress is honored
  // — a retry resumes ONLY unfinished targets.
  const opSnap = await db.collection(MEMORY_OPERATIONS_COLLECTION).doc(operationId).get();
  const op = opSnap.data();
  if (!op) throw new Error("operation_missing");
  const kind = op.kind as "correction" | "forget";
  const userId = String(op.userId ?? "");
  const targets = (op.targets ?? {}) as Record<string, { status?: string }>;
  const nowIso = new Date().toISOString();

  // Canonical content is read only while processing (KTD6). The retired
  // plaintext lives on the staged fact doc until the learnedFacts finalize
  // step — which is deliberately LAST, so a retry after a Storage/Zep failure
  // can still locate exact matches.
  const factRefs = (op.learnedFactRefs ?? []) as string[];
  const targetFactPath = factRefs[0] ?? "";
  const replacementPath = factRefs[1] ?? "";
  const factSnap = targetFactPath ? await db.doc(targetFactPath).get() : null;
  const fact = factSnap?.exists ? factSnap.data()! : null;
  const retiredText = String(fact?.fact ?? "");
  const category = String(fact?.category ?? "unknown");

  let replacementText = "";
  if (kind === "correction" && replacementPath) {
    const repSnap = await db.doc(replacementPath).get();
    replacementText = String(repSnap.exists ? repSnap.data()?.fact ?? "" : "");
  }

  // 1) Storage: exact-match reconcile across the user's memory files. An
  //    already-gone fact doc (no retired plaintext) means nothing is
  //    addressable — success (R14 already-deleted semantics).
  if (targetNeedsWork(targets, "storage")) {
    await runTargetStep(operationId, "storage", async () => {
      if (retiredText) {
        await reconcileFactAcrossMemoryFiles(
          userId, retiredText, kind === "correction" ? replacementText : "",
        );
      }
    });
  }

  // 2) Embeddings: purge rows still carrying the retired text (files rewritten
  //    in step 1 also reindex through writeMemoryFile's per-file path).
  if (targetNeedsWork(targets, "embeddings")) {
    await runTargetStep(operationId, "embeddings", async () => {
      if (retiredText) await deleteEmbeddingRowsMatching(userId, retiredText);
    });
  }

  // 3) Zep edges/episodes: one graph search feeds both targets. Forget deletes
  //    episodes BEFORE edges so a mid-run crash leaves the edges in place to
  //    re-locate surviving episodes on retry (edge/episode UUIDs are never
  //    persisted on the operation — R21/Data Changes). Never a whole graph/
  //    user/thread.
  const zepEdgesNeeded = targetNeedsWork(targets, "zepEdges");
  const zepEpisodesNeeded = targetNeedsWork(targets, "zepEpisodes");
  if (zepEdgesNeeded || zepEpisodesNeeded) {
    const phone = await resolveOperationPhone(op);
    const zepUserId = phone ? getZepUserId(phone) : "";
    if (!zepUserId || !retiredText) {
      // No Zep identity or no retired plaintext (already-gone) — nothing
      // addressable in the Zep layer. Success.
      if (zepEpisodesNeeded) await markMemoryOperationTarget(operationId, "zepEpisodes", "completed");
      if (zepEdgesNeeded) await markMemoryOperationTarget(operationId, "zepEdges", "completed");
    } else {
      let matches: Awaited<ReturnType<typeof findZepEdgesMatchingFact>>;
      try {
        matches = await findZepEdgesMatchingFact({ zepUserId, factText: retiredText });
      } catch (err) {
        const cls = errorClassOf(err);
        if (zepEdgesNeeded) await markMemoryOperationTarget(operationId, "zepEdges", "failed", cls).catch(() => {});
        if (zepEpisodesNeeded) await markMemoryOperationTarget(operationId, "zepEpisodes", "failed", cls).catch(() => {});
        throw err;
      }
      if (kind === "forget") {
        // Re-run both delete passes whenever either target remains unresolved.
        // A prior edge delete can have raced a source episode or provider
        // eventual consistency; verification below is the completion boundary.
        // Thread resolution is failure-tolerant: a session without a
        // zepThreadId (or without a resolvable sessionRef) has no rendered
        // context to inspect — verification runs its edge-inventory half only
        // and the skip is counted, instead of terminal-failing the forget.
        let zepThreadId = "";
        try {
          const sessionSnap = await db.doc(String(op.sessionRef)).get();
          zepThreadId = String(sessionSnap.exists ? sessionSnap.data()?.zepThreadId ?? "" : "");
        } catch { /* no resolvable session — edge-inventory-only verification */ }
        if (!zepThreadId) counts.forgetContextChecksSkipped++;
        try {
          // Mixed episodes included by design: privacy wins (U4 approach).
          const episodeUuids = new Set(matches.flatMap((m) => m.episodes));
          for (const uuid of episodeUuids) await deleteZepEpisodeStrict(uuid);
          for (const match of matches) await deleteZepEdgeStrict(match.uuid);
          await verifyZepForgottenFactAbsent({
            zepUserId,
            factText: retiredText,
            threadId: zepThreadId || undefined,
          });
          if (zepEpisodesNeeded) await markMemoryOperationTarget(operationId, "zepEpisodes", "completed");
          if (zepEdgesNeeded) await markMemoryOperationTarget(operationId, "zepEdges", "completed");
        } catch (err) {
          const cls = errorClassOf(err);
          if (zepEpisodesNeeded) {
            await markMemoryOperationTarget(operationId, "zepEpisodes", "failed", cls).catch(() => {});
          }
          if (zepEdgesNeeded) {
            await markMemoryOperationTarget(operationId, "zepEdges", "failed", cls).catch(() => {});
          }
          throw err;
        }
      } else {
        if (zepEdgesNeeded) {
          await runTargetStep(operationId, "zepEdges", async () => {
            for (const m of matches) {
              await invalidateZepEdgeStrict({ edgeUuid: m.uuid, invalidAt: nowIso });
            }
          });
        }
        // Corrections keep source episodes — edge invalidation is what retires
        // the fact; the old statement remains history.
        if (zepEpisodesNeeded) await markMemoryOperationTarget(operationId, "zepEpisodes", "completed");
      }
    }
  }

  // 4) Source-row exclusion (KTD16/R23) — idempotent, so it simply runs on
  //    every attempt that has not yet finalized learned facts.
  if (targetNeedsWork(targets, "learnedFacts")) {
    const exclusionPatch = {
      excludeFromMemoryConsolidationAt: nowIso,
      excludeFromMemoryConsolidationReason: kind,
    };
    const knownRefs = (op.sourceMessageRefs ?? []) as string[];
    for (const path of knownRefs) {
      // A row already folded by compression is gone — nothing left to protect.
      await db.doc(path).update(exclusionPatch)
        .then(() => { counts.sourceRowsExcluded++; })
        .catch(() => {});
    }
    if (knownRefs.length === 0 && retiredText) {
      // Legacy fact without provenance: bounded scan of the same 7-day window
      // nightly consolidation reads, marking rows that restate the fact.
      const phone = await resolveOperationPhone(op);
      if (phone) {
        const snaps = await Promise.all(
          conversationPartitionIdsForRead(phone, "senior").map((partitionId) =>
            db.collection("agent_conversations").doc(partitionId).collection("messages")
              .where("timestamp", ">=", Date.now() - LEGACY_SOURCE_SCAN_WINDOW_MS)
              .orderBy("timestamp", "asc")
              .limit(LEGACY_SOURCE_SCAN_LIMIT)
              .get()),
        ).catch(() => []);
        const sourceDocs = snaps.flatMap((snap) => snap.docs)
          .filter((doc) => doc.data().careVertical !== "child")
          .sort((a, b) => Number(a.data().timestamp ?? 0) - Number(b.data().timestamp ?? 0))
          .slice(-LEGACY_SOURCE_SCAN_LIMIT);
        for (const d of sourceDocs) {
          const row = d.data();
          if (row.role !== "user" && row.role !== "assistant") continue;
          if (row.excludeFromMemoryConsolidationAt) continue;
          if (!zepEdgeFactMatches(String(row.content ?? ""), retiredText)) continue;
          await d.ref.update({
            ...exclusionPatch,
            excludeFromMemoryConsolidationReason: `${kind}_legacy_scan`,
          }).then(() => { counts.sourceRowsExcluded++; }).catch(() => {});
        }
      }
    }
  }

  // 5) Learned facts finalize — LAST, so the retired plaintext survived every
  //    matching step above.
  if (targetNeedsWork(targets, "learnedFacts")) {
    await runTargetStep(operationId, "learnedFacts", async () => {
      if (!fact) return; // already-gone doc → success
      const del = admin.firestore.FieldValue.delete();
      if (kind === "forget") {
        // KTD16: completion REQUIRES the fingerprint key — staging fail-opened
        // without it, but a tombstone without a fingerprint cannot block
        // passive re-extraction, so an unbound secret is a retryable failure.
        let fingerprintFields: Record<string, unknown> = {};
        if (!fact.forgottenFingerprint) {
          const material = getFingerprintKey();
          const norm = String(fact._norm ?? "") || normalizeFactForFingerprint(retiredText);
          if (norm) {
            fingerprintFields = {
              forgottenFingerprint: hmacFingerprint(norm, material),
              fingerprintKeyVersion: material.version,
            };
          }
        }
        // Strip plaintext + embeddings into the no-plaintext tombstone. Keeps:
        // forgottenFingerprint/fingerprintKeyVersion, category, provenance
        // refs (sourceMessageRefs), forgottenAt, userId, createdAt.
        await db.doc(targetFactPath).update({
          ...fingerprintFields,
          forgottenAt: nowIso,
          fact: del,
          _norm: del,
          embedding: del,
          embeddingModel: del,
          weight: del,
          mentionTurnKeys: del,
          pendingForgetOperationId: del,
        });
      } else {
        await db.doc(targetFactPath).update({
          pendingCorrectionOperationId: del,
          ...(fact.supersededAt ? {} : { supersededAt: nowIso }),
        });
      }
    });
  }

  // 6) Completion. The durable audit entry is written BEFORE the operation
  //    record becomes expiry-eligible (Implementation-Time Checks) — event
  //    metadata only, never fact text (R21).
  await logAudit({
    eventType: kind === "forget" ? "memory_fact_forgotten" : "memory_fact_corrected",
    userId,
    data: { source: "memory_operation_worker", category },
  });
  await completeMemoryOperation(operationId, leaseOwner);
  // The per-user suppression flag entry clears last; the reader also
  // self-heals completed entries, so a crash here only costs one extra read.
  await clearReconciliationFlagEntry(userId, operationId);
}

// ── Terminal-failed forget repair sweep (audit P1) ────────────────────────────
//
// A forget that terminal-fails leaves the user's memory masked FOREVER (failed
// operations never expire, KTD9) — even when its Zep data is verifiably absent
// (e.g. the old whole-context verification false positive). This bounded sweep
// re-inspects terminal_failed forgets:
//   • Zep layer confirmed clean — per-target zepEdges/zepEpisodes statuses
//     already completed, or a fresh edge-inventory scan finds ZERO matching
//     edges (marked completed on success) — the operation is RE-OPENED as
//     retryable with a one-attempt budget, so the normal resumable pipeline
//     finishes the remaining targets and unmasks through the standard
//     completion path (audit entry, expiresAt, reconciliation-flag clear).
//   • Zep still holds matching edges — the operation stays terminal (masked);
//     the re-verify budget is spent either way, so a genuinely dirty graph is
//     probed at most TERMINAL_FORGET_REVERIFY_MAX_ATTEMPTS times.
// Deletes nothing itself; never touches a whole graph/user/thread. Aggregate
// counts only (R21).
async function sweepTerminalFailedForgets(counts: MemoryWorkerCounts): Promise<void> {
  let snap: FirebaseFirestore.QuerySnapshot;
  try {
    // Equality-only pair — served by merged single-field indexes.
    snap = await db.collection(MEMORY_OPERATIONS_COLLECTION)
      .where("status", "==", "terminal_failed")
      .where("kind", "==", "forget")
      .limit(TERMINAL_FORGET_REVERIFY_LIMIT)
      .get();
  } catch {
    return; // a read failure just defers the repair sweep to the next minute
  }
  for (const doc of snap.docs) {
    const op = doc.data();
    const reverifies = Number(op.terminalReverifyAttempts ?? 0);
    if (reverifies >= TERMINAL_FORGET_REVERIFY_MAX_ATTEMPTS) continue;
    try {
      const targets = (op.targets ?? {}) as Record<string, { status?: string }>;
      let zepClean = !targetNeedsWork(targets, "zepEdges") && !targetNeedsWork(targets, "zepEpisodes");
      if (!zepClean) {
        // Re-verify the authoritative half only (edge inventory); terminal
        // forgets frequently belong to sessions with no rendered context.
        const factRefs = (op.learnedFactRefs ?? []) as string[];
        const factSnap = factRefs[0] ? await db.doc(factRefs[0]).get() : null;
        const retiredText = String(factSnap?.exists ? factSnap.data()?.fact ?? "" : "");
        const phone = await resolveOperationPhone(op);
        const zepUserId = phone ? getZepUserId(phone) : "";
        if (!retiredText || !zepUserId) {
          // Nothing addressable in Zep (same semantics as the main
          // processor's no-identity branch) — trivially clean.
          zepClean = true;
        } else {
          const matches = await findZepEdgesMatchingFact({ zepUserId, factText: retiredText });
          zepClean = matches.length === 0;
        }
        if (zepClean) {
          await markMemoryOperationTarget(doc.id, "zepEdges", "completed");
          await markMemoryOperationTarget(doc.id, "zepEpisodes", "completed");
        }
      }
      if (!zepClean) {
        await doc.ref.update({
          terminalReverifyAttempts: reverifies + 1,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      // Re-open with exactly one attempt of budget: the claim path refuses
      // attempts beyond the max, so each re-open buys one resumable pass —
      // bounded overall by terminalReverifyAttempts.
      await doc.ref.update({
        status: "retryable_failed",
        attempts: MEMORY_OPERATION_MAX_ATTEMPTS - 1,
        nextRetryAt: new Date().toISOString(),
        leaseOwner: null,
        leaseExpiresAt: null,
        terminalReverifyAttempts: reverifies + 1,
        updatedAt: new Date().toISOString(),
      });
      counts.terminalForgetsReopened++;
    } catch {
      // Best-effort repair (R21: nothing logged) — the operation stays
      // terminal and the next sweep may try again within the budget.
    }
  }
}

// Every minute — the sweep cadence is the shortest useful retry delay
// (mirrors outboundQueueDrain's registration shape). The fingerprint secret is
// bound here (functions v1 params pattern) because forget finalization
// computes/stamps tombstone fingerprints (KTD16 / Implementation-Time Checks).
export const memoryOperationWorker = functions
  .runWith({
    secrets: [(MEMORY_FINGERPRINT_KEY_SECRET?.name ?? MEMORY_FINGERPRINT_KEY_NAME)],
  })
  .pubsub
  .schedule("every 1 minutes")
  .onRun(async () => {
    await runMemoryOperationWorker();
  });
