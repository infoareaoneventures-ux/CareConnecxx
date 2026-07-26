import * as admin from "firebase-admin";

/**
 * Platform-wide, per-caregiver reputation (U5/U6).
 *
 * The platform already records hire/pass into per-CLIENT match_history
 * (ai/feedback.ts) and aggregates attribute-level patterns for Claude
 * (ai/outcomeAnalytics.ts). Neither gives a NEW family any benefit from the
 * fact that other families consistently hired (or passed on) a caregiver.
 * This module fills that gap: a single recency-decayed score per caregiver,
 * fed into matching as a bounded tie-breaker — never strong enough to override
 * skills/proximity.
 *
 * Storage is O(1): an exponentially time-decayed signed score plus raw counts
 * for display. On each outcome the prior score is decayed to "now" before the
 * new ±1 is added, so recent outcomes dominate and old ones fade without
 * storing per-event history. A caregiver with no outcomes scores neutral (0).
 *
 * VERTICAL AWARENESS (childcare plan 2026-07-22-002 U6, R45): reputation is
 * per-vertical. The legacy top-level fields (score/lastOutcomeAt/hireCount/
 * passCount) ARE the senior vertical — every existing reader/writer keeps its
 * exact pre-U6 behavior when no vertical is named (senior default, byte-
 * identical). Childcare outcomes live under separate child-prefixed fields on
 * the same doc, so:
 *   • senior hire/pass history can never move a childcare ranking, and
 *   • childcare outcomes can never contaminate the senior boost.
 * Childcare MATCHING additionally consumes NO reputation boost at all in U6 —
 * ai/scoring.scoreChildcareCandidate has no reputation input (structural R45);
 * the per-vertical child fields exist so U8's outcome writers have a home that
 * is provably not the senior signal.
 */

const COLLECTION = "caregiver_reputation";

export type ReputationVertical = "senior" | "child";

/** Score halves every ~365 days of inactivity. Recent outcomes dominate. */
export const REPUTATION_HALF_LIFE_MS = 365 * 24 * 60 * 60 * 1000;

/** Max points reputation can add to / subtract from a match score. A tie-breaker, not a driver. */
export const MAX_REPUTATION_BOOST = 6;

/** Net-score magnitude at which the boost reaches ~76% of the cap (tanh(1)). */
const BOOST_SCALE = 4;

export interface CaregiverReputation {
  score:         number; // time-decayed signed sum of outcomes (+1 hire, -1 pass)
  lastOutcomeAt: number; // epoch ms of the most recent outcome
  hireCount:     number;
  passCount:     number;
}

/**
 * Per-vertical field names on the caregiver_reputation doc. The senior
 * vertical keeps the ORIGINAL unprefixed fields (legacy data + every pre-U6
 * reader stay valid); childcare uses child-prefixed fields.
 */
export function reputationFieldNames(vertical: ReputationVertical): {
  score: string; lastOutcomeAt: string; hireCount: string; passCount: string;
} {
  if (vertical === "child") {
    return {
      score: "childScore",
      lastOutcomeAt: "childLastOutcomeAt",
      hireCount: "childHireCount",
      passCount: "childPassCount",
    };
  }
  return { score: "score", lastOutcomeAt: "lastOutcomeAt", hireCount: "hireCount", passCount: "passCount" };
}

/** Decay a stored score forward to `nowMs` (pure). */
export function decayScore(prevScore: number, prevAtMs: number, nowMs: number): number {
  if (!prevScore || !prevAtMs) return 0;
  const elapsed = Math.max(0, nowMs - prevAtMs);
  return prevScore * Math.pow(0.5, elapsed / REPUTATION_HALF_LIFE_MS);
}

/**
 * Map a stored reputation to a bounded match-score boost (pure). Decays the
 * score to `nowMs`, then squashes through tanh so it asymptotes to ±cap and a
 * single outcome barely moves the needle. Returns 0 for missing/empty input
 * (cold-start neutral).
 */
export function reputationBoost(
  rep: Pick<CaregiverReputation, "score" | "lastOutcomeAt"> | null | undefined,
  nowMs: number,
  cap: number = MAX_REPUTATION_BOOST,
): number {
  if (!rep) return 0;
  const decayed = decayScore(rep.score, rep.lastOutcomeAt, nowMs);
  return cap * Math.tanh(decayed / BOOST_SCALE);
}

/**
 * Record a hire/pass outcome for a caregiver. Transactional so concurrent
 * outcomes can't lose an increment. Decays the prior score to now before
 * adding the new signal.
 *
 * `vertical` defaults to "senior" (the pre-U6 behavior, byte-identical field
 * writes). Pass "child" for childcare outcomes — they land in the child-
 * prefixed fields and never touch the senior score (R45).
 */
export async function recordCaregiverOutcome(
  db: admin.firestore.Firestore,
  caregiverId: string,
  outcome: "hire" | "pass",
  nowMs: number = Date.now(),
  vertical: ReputationVertical = "senior",
): Promise<void> {
  if (!caregiverId) return;
  const ref = db.collection(COLLECTION).doc(caregiverId);
  const delta = outcome === "hire" ? 1 : -1;
  const f = reputationFieldNames(vertical);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
    const prevScore = typeof prev?.[f.score] === "number" ? (prev[f.score] as number) : 0;
    const prevAt = typeof prev?.[f.lastOutcomeAt] === "number" ? (prev[f.lastOutcomeAt] as number) : 0;
    const decayed = decayScore(prevScore, prevAt, nowMs);
    tx.set(ref, {
      [f.score]:         decayed + delta,
      [f.lastOutcomeAt]: nowMs,
      [f.hireCount]:     admin.firestore.FieldValue.increment(outcome === "hire" ? 1 : 0),
      [f.passCount]:     admin.firestore.FieldValue.increment(outcome === "pass" ? 1 : 0),
    }, { merge: true });
  }).catch((err) => console.error("[caregiverReputation] recordCaregiverOutcome error:", err));
}

/**
 * Read a caregiver's current reputation boost (0 when none recorded).
 * Vertical-scoped: the default ("senior") reads the legacy fields exactly as
 * before U6; "child" reads ONLY the child-prefixed fields — a caregiver with
 * senior hires but no childcare outcomes gets a 0 childcare boost (R45).
 */
export async function getCaregiverReputationBoost(
  db: admin.firestore.Firestore,
  caregiverId: string,
  nowMs: number = Date.now(),
  vertical: ReputationVertical = "senior",
): Promise<number> {
  if (!caregiverId) return 0;
  try {
    const snap = await db.collection(COLLECTION).doc(caregiverId).get();
    if (!snap.exists) return 0;
    const d = snap.data() as Record<string, unknown>;
    const f = reputationFieldNames(vertical);
    return reputationBoost(
      {
        score: typeof d[f.score] === "number" ? (d[f.score] as number) : 0,
        lastOutcomeAt: typeof d[f.lastOutcomeAt] === "number" ? (d[f.lastOutcomeAt] as number) : 0,
      },
      nowMs,
    );
  } catch (err) {
    console.warn("[caregiverReputation] getCaregiverReputationBoost failed:", err);
    return 0;
  }
}

/** Batch-read reputation boosts for several caregivers (used in matching). */
export async function getReputationBoosts(
  db: admin.firestore.Firestore,
  caregiverIds: string[],
  nowMs: number = Date.now(),
  vertical: ReputationVertical = "senior",
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(caregiverIds.map(async (id) => {
    out.set(id, await getCaregiverReputationBoost(db, id, nowMs, vertical));
  }));
  return out;
}
