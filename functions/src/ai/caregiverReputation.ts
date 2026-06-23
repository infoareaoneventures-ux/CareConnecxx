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
 */

const COLLECTION = "caregiver_reputation";

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
 */
export async function recordCaregiverOutcome(
  db: admin.firestore.Firestore,
  caregiverId: string,
  outcome: "hire" | "pass",
  nowMs: number = Date.now(),
): Promise<void> {
  if (!caregiverId) return;
  const ref = db.collection(COLLECTION).doc(caregiverId);
  const delta = outcome === "hire" ? 1 : -1;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? (snap.data() as Partial<CaregiverReputation>) : undefined;
    const decayed = decayScore(prev?.score ?? 0, prev?.lastOutcomeAt ?? 0, nowMs);
    tx.set(ref, {
      score:         decayed + delta,
      lastOutcomeAt: nowMs,
      hireCount:     admin.firestore.FieldValue.increment(outcome === "hire" ? 1 : 0),
      passCount:     admin.firestore.FieldValue.increment(outcome === "pass" ? 1 : 0),
    }, { merge: true });
  }).catch((err) => console.error("[caregiverReputation] recordCaregiverOutcome error:", err));
}

/** Read a caregiver's current reputation boost (0 when none recorded). */
export async function getCaregiverReputationBoost(
  db: admin.firestore.Firestore,
  caregiverId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  if (!caregiverId) return 0;
  try {
    const snap = await db.collection(COLLECTION).doc(caregiverId).get();
    if (!snap.exists) return 0;
    const d = snap.data() as Partial<CaregiverReputation>;
    return reputationBoost({ score: d.score ?? 0, lastOutcomeAt: d.lastOutcomeAt ?? 0 }, nowMs);
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
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(caregiverIds.map(async (id) => {
    out.set(id, await getCaregiverReputationBoost(db, id, nowMs));
  }));
  return out;
}
