import * as admin from "firebase-admin";

const db = admin.firestore();

export type CaraOpsSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface CaraOpsAlertInput {
  type: string;
  severity?: CaraOpsSeverity;
  phone?: string;
  userId?: string;
  role?: string;
  source?: string;
  message?: string;
  reason?: string;
  actionId?: string;
  toolName?: string;
  targetCollection?: string;
  targetDocId?: string;
  error?: string;
  /**
   * Free-form diagnostic context. Kept small on purpose: it is bounded to
   * ~4KB of serialized JSON before persistence (see boundContext) so an
   * oversized payload can't trip the Firestore 1MB document limit or bloat
   * storage. Pass only small, relevant key/values — not large blobs.
   */
  context?: Record<string, unknown>;
}

// Other string fields are capped at 500 chars; `context` is structured, so we
// bound its serialized size instead. Small contexts pass through unchanged;
// oversized ones are replaced with a truncated string marker so the alert
// still persists rather than failing the whole write.
const MAX_CONTEXT_JSON = 4000;
function boundContext(context: Record<string, unknown>): Record<string, unknown> | string {
  try {
    const json = JSON.stringify(context);
    if (json.length <= MAX_CONTEXT_JSON) return context;
    return `[context truncated] ${json.slice(0, MAX_CONTEXT_JSON)}...`;
  } catch {
    return "[context unserializable]";
  }
}

// ── U7 (R21): grounding/handoff alert redaction ──────────────────────────────
// Grounding-gate and human-handoff alerts describe a draft reply that may
// contain invented medical/identity/payment claims — the alert must reference
// the turn, never quote it. For these alert types the free-form `context` is
// filtered to an allowlist of hash/enum/count keys and short primitive values,
// so a call site can never (re)introduce a raw user message, draft reply, or
// prior reply into admin_alerts. Other alert types are untouched.
const GROUNDING_ALERT_TYPE = /(?:handoff|grounding)/i;
const GROUNDING_CONTEXT_ALLOWED_KEYS = new Set([
  "turnHash",
  "draftHash",
  "operationHash",
  "claimCategories",
  "claimRisk",
  "groundingVerdict",
  "verdict",
  "action",
  "verifierLatencyMs",
  "latencyMs",
  "pathway",
  "riskTiersEnabled",
  "count",
]);
const GROUNDING_CONTEXT_MAX_VALUE_CHARS = 64;

function sanitizeGroundingAlertContext(context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!GROUNDING_CONTEXT_ALLOWED_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (value.length > GROUNDING_CONTEXT_MAX_VALUE_CHARS) continue;
      out[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      const safe = value.filter(
        (v): v is string => typeof v === "string" && v.length <= GROUNDING_CONTEXT_MAX_VALUE_CHARS,
      );
      if (safe.length) out[key] = safe;
    }
    // objects / anything else: dropped — nested blobs can smuggle raw content
  }
  return out;
}

// ── U9 (R21/R22): sustained-Zep-outage alert ─────────────────────────────────
// The plan's monitoring contract: alert ONLY on a SUSTAINED rate of Zep
// unavailable/timeout outcomes — never on a single event, and NEVER on
// "empty" ("empty" is a successful provider response that happens to carry no
// context; paging on it would train operators to ignore the alert).
//
// Mechanism: turnMetrics.emitTurnMetrics feeds every turn's zepContextStatus
// into a small in-process rolling window here. When the window holds at least
// ZEP_OUTAGE_MIN_SAMPLES outcomes and the unavailable/timeout share reaches
// ZEP_OUTAGE_FAILURE_RATE, one deduplicated admin_alerts doc is written.
// Dedupe is a deterministic doc ID per ZEP_OUTAGE_ALERT_DEDUPE_MS time bucket
// (same set+merge pattern as the worker's terminal-operation alert), so a
// sustained outage produces ONE alert doc per bucket even across multiple
// function instances — each instance may attempt the write, but they all hit
// the same document.
//
// The window is per-instance by design: a real sustained outage is seen by
// every instance serving traffic, and the deterministic doc ID collapses their
// writes. A single instance's blip below MIN_SAMPLES never pages.
//
// Alert content is aggregate-only (R21): sample/failure counts, rate, window.
// No thread IDs, no Zep user IDs, no query text, no phones.

/** Rolling evaluation window for Zep context outcomes. */
export const ZEP_OUTAGE_WINDOW_MS = 10 * 60 * 1000;
/** Never evaluate (let alone alert) below this many outcomes in the window. */
export const ZEP_OUTAGE_MIN_SAMPLES = 5;
/** Unavailable/timeout share of the window that counts as a sustained outage. */
export const ZEP_OUTAGE_FAILURE_RATE = 0.5;
/** One alert doc per this time bucket (deterministic-ID dedupe). */
export const ZEP_OUTAGE_ALERT_DEDUPE_MS = 30 * 60 * 1000;
/** Aggregation granularity; the bounded window reads at most eleven documents. */
export const ZEP_OUTAGE_BUCKET_MS = 60 * 1000;
/** Aggregate-only bucket collection. `expiresAt` permits TTL cleanup where enabled. */
export const ZEP_OUTAGE_BUCKET_COLLECTION = "cara_ops_zep_outage_buckets";
const ZEP_OUTAGE_BUCKET_READ_LIMIT = Math.ceil(ZEP_OUTAGE_WINDOW_MS / ZEP_OUTAGE_BUCKET_MS) + 1;
const ZEP_OUTAGE_BUCKET_RETENTION_MS = 2 * 60 * 60 * 1000;

export type ZepContextOutcome = "loaded" | "empty" | "unavailable" | "timeout";

/** Test seam retained for callers that simulate a cold instance. Buckets persist. */
export function __resetZepOutageWindowForTests(): void {
  // Deliberately empty: aggregation state is durable rather than process-local.
}

function isAlreadyExistsError(err: unknown): boolean {
  const code = (err as { code?: unknown; status?: unknown })?.code
    ?? (err as { status?: unknown })?.status;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

function safeErrorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

/**
 * Records one Zep context outcome and writes the deduplicated sustained-outage
 * alert when the window crosses the documented thresholds. Never throws.
 * Returns true only when this call persisted a new alert doc.
 */
export async function recordZepContextOutcome(
  status: ZepContextOutcome,
  nowMs: number = Date.now(),
): Promise<boolean> {
  // "empty" and "loaded" are SUCCESSFUL provider responses — they count as
  // healthy samples that dilute the failure rate; they can never trigger.
  const failed = status === "unavailable" || status === "timeout";
  try {
    const minuteStartMs = Math.floor(nowMs / ZEP_OUTAGE_BUCKET_MS) * ZEP_OUTAGE_BUCKET_MS;
    await db.collection(ZEP_OUTAGE_BUCKET_COLLECTION).doc(`zep-context:${minuteStartMs}`).set({
      minuteStartMs,
      samples: admin.firestore.FieldValue.increment(1),
      failures: admin.firestore.FieldValue.increment(failed ? 1 : 0),
      updatedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(minuteStartMs + ZEP_OUTAGE_BUCKET_RETENTION_MS).toISOString(),
    }, { merge: true });

    const firstMinuteMs = Math.floor((nowMs - ZEP_OUTAGE_WINDOW_MS) / ZEP_OUTAGE_BUCKET_MS)
      * ZEP_OUTAGE_BUCKET_MS;
    const bucketSnapshot = await db.collection(ZEP_OUTAGE_BUCKET_COLLECTION)
      .where("minuteStartMs", ">=", firstMinuteMs)
      .where("minuteStartMs", "<=", minuteStartMs)
      .orderBy("minuteStartMs", "asc")
      .limit(ZEP_OUTAGE_BUCKET_READ_LIMIT)
      .get();
    const { samples, failures } = bucketSnapshot.docs.reduce(
      (totals, doc) => ({
        samples: totals.samples + Math.max(0, Number(doc.data().samples ?? 0)),
        failures: totals.failures + Math.max(0, Number(doc.data().failures ?? 0)),
      }),
      { samples: 0, failures: 0 },
    );
    if (samples < ZEP_OUTAGE_MIN_SAMPLES) return false;
    const failureRate = failures / samples;
    if (failureRate < ZEP_OUTAGE_FAILURE_RATE) return false;

    const bucket = Math.floor(nowMs / ZEP_OUTAGE_ALERT_DEDUPE_MS);
    await db.collection("admin_alerts").doc(`zep-sustained-outage:${bucket}`).create({
      type: "zep_sustained_outage",
      severity: "high",
      source: "turn_metrics",
      resolved: false,
      createdAt: new Date(nowMs).toISOString(),
      // R21: counts and thresholds only.
      context: {
        samples,
        failures,
        failureRate: Math.round(failureRate * 100) / 100,
        windowMs: ZEP_OUTAGE_WINDOW_MS,
      },
    });
    return true;
  } catch (err) {
    if (isAlreadyExistsError(err)) return false;
    console.error("caraOpsAlert zep outage aggregation error:", safeErrorClass(err));
    return false;
  }
}

// ── U9 (R21/R22): aged-memory-operation alert ────────────────────────────────
// A memory_operations doc that stays unresolved past this age is stuck: normal
// retry either completes or goes terminal (its own deduplicated alert) within
// ~6 attempts / ≤30-minute backoff. What normal retry does NOT surface is a
// turn_sync operation parked indefinitely behind an older unresolved turn
// (blockedByOlder accrues no attempts) or a lease that keeps expiring — this
// alert catches those. The worker evaluates ages over its due batch every
// sweep; because backoff is capped at 30 minutes and leases at 3, every
// unresolved operation re-enters the due set well inside this threshold.

/** Unresolved-operation age that pages (evaluated by memoryOperationWorker). */
export const AGED_MEMORY_OPERATION_ALERT_MS = 60 * 60 * 1000;

/** One aggregate-only alert per half-hour while a turn-sync ordering queue is capped. */
export const TURN_SYNC_ORDERING_BACKLOG_ALERT_DEDUPE_MS = 30 * 60 * 1000;

/**
 * Emits a privacy-safe health signal when the worker cannot inspect every
 * unresolved turn for a user inside its ordering cap. The worker deliberately
 * defers that user rather than risk reordering transcript writes. No user,
 * operation, phone, path, or message identifier reaches this alert.
 */
export async function raiseTurnSyncOrderingBacklogAlert(input: {
  cap: number;
  observedAtLeast: number;
  nowMs?: number;
}): Promise<boolean> {
  const nowMs = input.nowMs ?? Date.now();
  const bucket = Math.floor(nowMs / TURN_SYNC_ORDERING_BACKLOG_ALERT_DEDUPE_MS);
  try {
    await db.collection("admin_alerts").doc(`memory-turn-sync-backlog:${bucket}`).set({
      type: "memory_turn_sync_backlog_capped",
      severity: "high",
      source: "memory_operation_worker",
      resolved: false,
      createdAt: new Date(nowMs).toISOString(),
      context: {
        cap: Math.max(0, Math.floor(input.cap)),
        observedAtLeast: Math.max(0, Math.floor(input.observedAtLeast)),
      },
    }, { merge: true });
    return true;
  } catch (err) {
    console.error("caraOpsAlert turn-sync backlog write error:", safeErrorClass(err));
    return false;
  }
}

const MEMORY_OPERATION_KINDS = new Set(["turn_sync", "correction", "forget", "re_remember"]);
const MEMORY_OPERATION_STATUSES = new Set(["pending", "processing", "retryable_failed"]);

/**
 * Deduplicated aged-operation alert: one admin_alerts doc per operation
 * (deterministic ID, set+merge — the same pattern as the terminal alert in
 * memoryOperations.ts). Carries the opaque operation ID plus enum/count fields
 * only — never refs, paths, phones, fact text, or Zep IDs (R21). Never throws.
 */
export async function raiseAgedMemoryOperationAlert(input: {
  operationId: string;
  kind: string;
  status: string;
  ageMs: number;
  attempts: number;
}): Promise<boolean> {
  try {
    await db.collection("admin_alerts").doc(`memory-operation-aged:${input.operationId}`).set({
      type: "memory_operation_aged",
      severity: "high",
      source: "memory_operation_worker",
      resolved: false,
      createdAt: new Date().toISOString(),
      operationId: input.operationId,
      context: {
        kind: MEMORY_OPERATION_KINDS.has(input.kind) ? input.kind : "other",
        status: MEMORY_OPERATION_STATUSES.has(input.status) ? input.status : "other",
        ageMs: Math.round(input.ageMs),
        attempts: input.attempts,
        thresholdMs: AGED_MEMORY_OPERATION_ALERT_MS,
      },
    }, { merge: true });
    return true;
  } catch (err) {
    console.error("caraOpsAlert aged operation write error:", err);
    return false;
  }
}

// Best-effort alerting sink: never throws (a failed alert must not break the
// caller's main flow). Returns true when the alert was persisted, false when
// the write failed — callers that tell a user "I've flagged this for review"
// can branch on this so they don't claim a flag that didn't persist.
export async function createCaraOpsAlert(input: CaraOpsAlertInput): Promise<boolean> {
  const now = new Date().toISOString();
  const isGroundingType = GROUNDING_ALERT_TYPE.test(input.type);
  const sanitized = input.context && isGroundingType
    ? sanitizeGroundingAlertContext(input.context)
    : undefined;
  // Grounding types persist only the sanitized context (dropped entirely when
  // nothing survives the allowlist); other types keep the original behavior.
  const context = isGroundingType
    ? (sanitized && Object.keys(sanitized).length ? sanitized : undefined)
    : input.context;
  try {
    await db.collection("admin_alerts").add({
      type: input.type,
      severity: input.severity ?? "medium",
      source: input.source ?? "cara",
      resolved: false,
      createdAt: now,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.message ? { message: input.message.slice(0, 500) } : {}),
      ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
      ...(input.actionId ? { actionId: input.actionId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.targetCollection ? { targetCollection: input.targetCollection } : {}),
      ...(input.targetDocId ? { targetDocId: input.targetDocId } : {}),
      ...(input.error ? { error: input.error.slice(0, 500) } : {}),
      ...(context ? { context: boundContext(context) } : {}),
    });
    return true;
  } catch (err) {
    console.error("caraOpsAlert write error:", err);
    return false;
  }
}
