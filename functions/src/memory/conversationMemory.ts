// Shared turn-persistence policy boundary (memory-grounding hardening plan
// 2026-07-17-002, KTD1/KTD2 — U2 slice; U3 adds deterministic turn persistence).
//
// U2 scope: verified-ingress ACTIVITY marking (R1) and the pure decision logic
// for the one-time activity backfill (R3). U3 adds persistCompletedTurn — the
// ONE owner for completed-session turn memory: deterministic Firestore rows +
// a reference-only turn_sync memory operation in a single atomic batch (R9),
// dispatched by scheduled/memoryOperationWorker.ts. Keep it a clean policy
// module: no telemetry with raw content, no model calls, no per-callsite
// special cases.
//
// R1 contract: every ACCEPTED inbound turn for an existing verified session
// writes agent_sessions/{phone}.lastMessageAt = server Timestamp BEFORE model
// execution. Rejected, rate-limited, invalid-signature, or unbound-identity
// requests must NOT write it. Callers own the "accepted" judgment — this module
// only owns HOW the mark is written (server timestamp, never an ISO string, so
// the nightly range query compares one type).

import * as admin from "firebase-admin";
import {
  buildTurnSyncOperationDoc,
  hashSourceTurnKey,
  MEMORY_OPERATIONS_COLLECTION,
  turnSyncOperationId,
} from "./memoryOperations";

/** Canonical field name for the nightly-selection activity timestamp. */
export const SESSION_ACTIVITY_FIELD = "lastMessageAt";

/**
 * Field patch for a verified inbound turn. Merge this into a session update
 * that already exists at the ingress seam (the Linq webhook writes it beside
 * `lastInboundAt` in one update). Always a Firestore server Timestamp — mixed
 * ISO/Timestamp comparisons are exactly the bug that made nightly selection
 * dead (KTD2).
 */
export function sessionActivityFields(): { lastMessageAt: admin.firestore.FieldValue } {
  return { lastMessageAt: admin.firestore.FieldValue.serverTimestamp() };
}

/**
 * Standalone activity write for ingress seams with no adjacent session update
 * (the web chat callable). Best-effort by design: activity marking must never
 * block or fail a user turn — a lost mark only means nightly selection sees the
 * previous activity timestamp. Call it AFTER every accept guard has passed and
 * BEFORE the model runs, so a model failure still leaves the turn counted.
 */
export async function markSessionActivity(
  phone: string,
  db: admin.firestore.Firestore = admin.firestore(),
): Promise<void> {
  try {
    await db.collection("agent_sessions").doc(phone).update(sessionActivityFields());
  } catch {
    // Never throw into a user turn. No log — a failure here is visible as a
    // stale lastMessageAt in aggregate nightly counts, and logging would need
    // the phone to be useful (R21 forbids that).
  }
}

// ── Activity backfill decision (R3, Backfill Gate) ───────────────────────────
//
// Pure function used by scripts/backfill-agent-session-last-message-at.mjs so
// the decision rules are unit-testable without Firestore. The script owns I/O
// (reads, writes, counters); this owns the policy:
//
//  • lastMessageAt may be derived ONLY from the latest role=="user" Firestore
//    conversation row's timestamp — never from message text.
//  • Only a timestamp inside the sane bound (within the last 7 days, not in the
//    future beyond small clock skew) is written; older evidence is counted as
//    stale and left unwritten so the backfill cannot mark stale sessions active.
//  • A missing session role may be repaired ONLY from an explicit canonical
//    role on users/{userId}; anything else is ambiguous and stays excluded.

/** Matches the nightly selection window — evidence older than this is stale. */
export const ACTIVITY_BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Tolerated forward clock skew; beyond this a timestamp is not sane evidence. */
export const ACTIVITY_BACKFILL_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface ActivityBackfillInput {
  /** agent_sessions/{phone}.lastMessageAt already present? */
  hasLastMessageAt: boolean;
  /** agent_sessions/{phone}.userType, verbatim (may be missing). */
  sessionUserType?: string | null;
  /** users/{userId}.userType — the explicit canonical role (may be missing). */
  canonicalUserType?: string | null;
  /** Latest role=="user" message timestamp in epoch ms, or null when none. */
  latestUserMessageTimestampMs?: number | null;
  nowMs: number;
}

export type BackfillRole = "client" | "caregiver" | "ambiguous";
export type BackfillHistory =
  | "already_populated"
  | "no_history"
  | "recent_history"
  | "stale_history";

export interface ActivityBackfillDecision {
  role: BackfillRole;
  /**
   * Non-null only when the session has no role AND the canonical users doc
   * carries an explicit one. Ambiguous sessions get null — they stay excluded
   * from nightly selection (R3).
   */
  repairUserType: "client" | "caregiver" | null;
  history: BackfillHistory;
  /** Non-null only for recent_history: the value to write, epoch ms. */
  writeLastMessageAtMs: number | null;
}

function explicitRole(value: string | null | undefined): "client" | "caregiver" | null {
  return value === "client" || value === "caregiver" ? value : null;
}

export function decideActivityBackfill(input: ActivityBackfillInput): ActivityBackfillDecision {
  // Role resolution: the session's own explicit role wins; a missing one may be
  // repaired only from the explicit canonical role. Everything else stays
  // ambiguous — never inferred from history or message content.
  const sessionRole = explicitRole(input.sessionUserType);
  const canonicalRole = explicitRole(input.canonicalUserType);
  const role: BackfillRole = sessionRole ?? canonicalRole ?? "ambiguous";
  const repairUserType = sessionRole === null ? canonicalRole : null;

  if (input.hasLastMessageAt) {
    return { role, repairUserType, history: "already_populated", writeLastMessageAtMs: null };
  }

  const ts = input.latestUserMessageTimestampMs;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return { role, repairUserType, history: "no_history", writeLastMessageAtMs: null };
  }

  const tooOld = ts < input.nowMs - ACTIVITY_BACKFILL_WINDOW_MS;
  const inFuture = ts > input.nowMs + ACTIVITY_BACKFILL_FUTURE_SKEW_MS;
  if (tooOld || inFuture) {
    // Future timestamps are also "not sane evidence of recent activity" — they
    // are bucketed with stale so they are counted but never written.
    return { role, repairUserType, history: "stale_history", writeLastMessageAtMs: null };
  }

  return { role, repairUserType, history: "recent_history", writeLastMessageAtMs: ts };
}

// ── Deterministic turn persistence (U3, R8/R9/R21) ───────────────────────────
//
// One API for every completed-session web/SMS agent or quick-reply turn: write
// the user+assistant rows to agent_conversations/{phone}/messages with
// DETERMINISTIC doc IDs derived from the stable source-turn key (Linq eventId /
// web clientMessageId) and create the reference-only turn_sync memory
// operation in the SAME Firestore batch. Retrying the same key is a no-op
// (batch.create on the deterministic operation ID makes the whole batch fail
// atomically with ALREADY_EXISTS → reported as a deduplicated success). The
// worker (scheduled/memoryOperationWorker.ts) later dispatches Zep transcript
// writes and learned-fact extraction, then clears memorySyncStatus.
//
// R8: a persistence failure after tools/reply already committed is observable
// (typed outcome + aggregate log) but never throws into the caller's turn and
// never re-drives the turn.

export type TurnChannel = "linq" | "web";

export interface CompletedTurnInput {
  channel: TurnChannel;
  /** Stable source key: the Linq eventId (SMS) or web clientMessageId. */
  sourceKey: string;
  phone: string;
  userId: string;
  userText: string;
  assistantText: string;
  /** Original turn timestamp (epoch ms). Defaults to now. */
  turnTimestampMs?: number;
  /**
   * true only for eligible CLIENT turns — caregiver turns are excluded from
   * family-fact extraction (R8). The caller owns the role judgment.
   */
  extractFacts: boolean;
  /**
   * true when the agent layer already persisted this turn's durable
   * user/assistant history pair (qaAgent.saveConversationTurn does this for
   * BOTH the full and quick paths). persistCompletedTurn then ADOPTS those
   * rows — tags them with the source-turn key + pending sync status and
   * references them from the operation — instead of writing a second pair.
   * The history reader has no content dedupe, so a second pair would duplicate
   * every turn in the model prompt. If the pair cannot be found (the agent
   * held the turn, skipped an empty turn, or its save failed), the turn is NOT
   * persisted (`rows_not_found`): the agent layer's judgment about what
   * constitutes a completed turn stays authoritative.
   */
  adoptExistingRows?: boolean;
}

/** How many recent rows the adoption scan reads (a turn writes 2; headroom for
 *  interleaved transport-recorded sends). */
export const ADOPTED_ROW_SCAN_LIMIT = 20;

/** Rows older than this are never adopted — the turn being persisted JUST
 *  happened, so a stale identical pair (e.g. a repeated greeting) must not be
 *  retro-tagged with this turn's key. */
export const ADOPTED_ROW_MAX_AGE_MS = 30 * 60 * 1000;

export type TurnPersistenceOutcome =
  | { ok: true; operationId: string; sourceTurnKeyHash: string; deduplicated: boolean }
  | { ok: false; errorClass: string };

/** Deterministic per-turn message doc ID (role-scoped). */
export function turnMessageDocId(sourceTurnKeyHash: string, role: "user" | "assistant"): string {
  return `turn_${sourceTurnKeyHash}_${role}`;
}

export async function persistCompletedTurn(
  input: CompletedTurnInput,
  db: admin.firestore.Firestore = admin.firestore(),
): Promise<TurnPersistenceOutcome> {
  const sourceKey = input.sourceKey?.trim();
  if (!sourceKey) {
    // No stable key → no idempotency promise (Implementation-Time Checks:
    // "missing web client ID"). Observable, non-throwing; the wiring pass
    // decides any fallback.
    return { ok: false, errorClass: "missing_source_key" };
  }
  if (!input.userText?.trim() || !input.assistantText?.trim()) {
    // Mirror of qaAgent.saveConversationTurn's empty-turn guard: an empty
    // history row 400s later model calls.
    return { ok: false, errorClass: "empty_turn" };
  }

  const sourceTurnKeyHash = hashSourceTurnKey(input.channel, sourceKey);
  const operationId = turnSyncOperationId(sourceTurnKeyHash);
  try {
    const messagesCol = db.collection("agent_conversations").doc(input.phone).collection("messages");

    const rowShared = {
      sourceTurnKeyHash,
      sourceChannel: input.channel,
      // Unresolved sync protects the row from nightly compression (R9).
      memorySyncStatus: "pending",
    };

    let ts = input.turnTimestampMs ?? Date.now();
    let userMessagePath: string;
    let assistantMessagePath: string;
    const batch = db.batch();

    if (input.adoptExistingRows) {
      const adopted = await findAdoptableTurnRows(messagesCol, input, sourceTurnKeyHash);
      if (!adopted) return { ok: false, errorClass: "rows_not_found" };
      // The op's sourceTurnTimestamp is the ORIGINAL row timestamp — the worker
      // uses it for per-user ordering and as the Zep createdAt (KTD5/R9).
      ts = adopted.turnTimestampMs;
      userMessagePath = adopted.userRef.path;
      assistantMessagePath = adopted.assistantRef.path;
      batch.update(adopted.userRef, rowShared);
      batch.update(adopted.assistantRef, rowShared);
    } else {
      const userDocId = turnMessageDocId(sourceTurnKeyHash, "user");
      const assistantDocId = turnMessageDocId(sourceTurnKeyHash, "assistant");
      userMessagePath = `agent_conversations/${input.phone}/messages/${userDocId}`;
      assistantMessagePath = `agent_conversations/${input.phone}/messages/${assistantDocId}`;
      batch.set(messagesCol.doc(userDocId), {
        role: "user", content: input.userText, timestamp: ts, ...rowShared,
      });
      batch.set(messagesCol.doc(assistantDocId), {
        role: "assistant", content: input.assistantText, timestamp: ts + 1, ...rowShared,
      });
    }

    const { doc: operationDoc } = buildTurnSyncOperationDoc({
      channel: input.channel,
      sourceKey,
      phone: input.phone,
      userId: input.userId,
      turnTimestampMs: ts,
      extractFacts: input.extractFacts,
      userMessagePath,
      assistantMessagePath,
    });

    // create() (not set) on the deterministic operation ID: a duplicate turn
    // fails the WHOLE batch atomically, so a completed operation can never be
    // reset to pending and rows never re-acquire memorySyncStatus.
    batch.create(db.collection(MEMORY_OPERATIONS_COLLECTION).doc(operationId), operationDoc);
    await batch.commit();
    return { ok: true, operationId, sourceTurnKeyHash, deduplicated: false };
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      return { ok: true, operationId, sourceTurnKeyHash, deduplicated: true };
    }
    // R21: aggregate/reference-free log — error class + channel only.
    console.error(JSON.stringify({
      severity: "ERROR",
      memory_turn_persistence_failed: true,
      channel: input.channel,
      error_class: err instanceof Error ? err.constructor.name : typeof err,
      timestamp: new Date().toISOString(),
    }));
    return { ok: false, errorClass: err instanceof Error ? err.constructor.name : typeof err };
  }
}

/**
 * Locate the just-written durable turn pair (qaAgent.saveConversationTurn's
 * auto-ID rows) so it can be adopted instead of duplicated. Newest-first scan;
 * a candidate must:
 *  • not already belong to a DIFFERENT turn (`sourceTurnKeyHash` unset, or
 *    already this turn's — the retry case),
 *  • not be a transport-recorded row (`source` tag),
 *  • match this turn's exact content for its role,
 *  • be recent (the turn just happened — see ADOPTED_ROW_MAX_AGE_MS).
 * Newest-first matching makes repeated identical texts safe: the first match
 * IS this turn's row; older identical rows were either adopted already or are
 * outside the freshness bound.
 */
async function findAdoptableTurnRows(
  messagesCol: admin.firestore.CollectionReference,
  input: CompletedTurnInput,
  sourceTurnKeyHash: string,
): Promise<{
  userRef: admin.firestore.DocumentReference;
  assistantRef: admin.firestore.DocumentReference;
  turnTimestampMs: number;
} | null> {
  const snap = await messagesCol
    .orderBy("timestamp", "desc")
    .limit(ADOPTED_ROW_SCAN_LIMIT)
    .get();

  const nowMs = Date.now();
  let userDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let assistantDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (const d of snap.docs) {
    const row = d.data() as Record<string, unknown>;
    const rowTs = row.timestamp;
    if (typeof rowTs !== "number") continue;                    // summary/odd rows — never candidates
    if (rowTs < nowMs - ADOPTED_ROW_MAX_AGE_MS) break;          // newest-first: everything after is older
    // Rows owned by a DIFFERENT turn are never candidates; rows already tagged
    // with THIS turn's hash stay adoptable so a retry reaches the operation's
    // atomic ALREADY_EXISTS dedupe instead of a false rows_not_found.
    if (row.sourceTurnKeyHash && row.sourceTurnKeyHash !== sourceTurnKeyHash) continue;
    if (typeof row.source === "string") continue; // transport-recorded outbound, not the turn pair
    if (!assistantDoc && row.role === "assistant" && row.content === input.assistantText) {
      assistantDoc = d;
    } else if (!userDoc && row.role === "user" && row.content === input.userText) {
      userDoc = d;
    }
    if (userDoc && assistantDoc) break;
  }

  if (!userDoc || !assistantDoc) return null;
  const userTs = (userDoc.data() as Record<string, unknown>).timestamp;
  return {
    userRef: userDoc.ref,
    assistantRef: assistantDoc.ref,
    turnTimestampMs: typeof userTs === "number" ? userTs : input.turnTimestampMs ?? Date.now(),
  };
}

function isAlreadyExistsError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 6 || code === "already-exists" || code === "ALREADY_EXISTS") return true;
  return err instanceof Error && /already[\s_-]?exists/i.test(err.message);
}
