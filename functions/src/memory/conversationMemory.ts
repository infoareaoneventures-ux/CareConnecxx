// Shared turn-persistence policy boundary (memory-grounding hardening plan
// 2026-07-17-002, KTD1/KTD2 — U2 slice).
//
// U2 scope: verified-ingress ACTIVITY marking (R1) and the pure decision logic
// for the one-time activity backfill (R3). A later unit (U3) grows this module
// into deterministic Firestore turn persistence, Zep transcript scheduling, and
// learned-fact extraction scheduling — keep it a clean policy module: no
// telemetry with raw content, no model calls, no per-callsite special cases.
//
// R1 contract: every ACCEPTED inbound turn for an existing verified session
// writes agent_sessions/{phone}.lastMessageAt = server Timestamp BEFORE model
// execution. Rejected, rate-limited, invalid-signature, or unbound-identity
// requests must NOT write it. Callers own the "accepted" judgment — this module
// only owns HOW the mark is written (server timestamp, never an ISO string, so
// the nightly range query compares one type).

import * as admin from "firebase-admin";

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
