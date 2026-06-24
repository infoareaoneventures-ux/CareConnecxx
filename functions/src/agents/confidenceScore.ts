import * as admin from "firebase-admin";

/**
 * Caregiver confidence score (U2 — plan 2026-06-23-001).
 *
 * A bounded-additive 0–100 trust/eligibility signal, kept distinct from the ML
 * `confidence` match score. Recomposed from the signals available today:
 * background check, MVR (drivers only), tenure, rating, verification, and
 * certifications. References are intentionally NOT a signal (idea #9 is out of
 * scope). Behavioral signals (check-in reliability, next-day feedback,
 * retention) are folded in later by U13 via the reliability-funnel counters.
 *
 * Design rules (KTD-2):
 *  - Cold-start neutral: no history yields no bonus, never a penalty.
 *  - Non-drivers are not penalized for an absent MVR — the screening cluster is
 *    worth the same 35 points whether earned from BGC alone (non-driver) or
 *    split BGC(25)+MVR(10) (driver), so both can reach 100.
 *  - Exact weights are an open question to calibrate against real data; this is
 *    a reasonable bounded-additive starting point, not a tuned model.
 */

export interface ConfidenceInput {
  backgroundCheckStatus?: string;
  pendingBackgroundCheck?: boolean;
  approvedAt?: string;
  rating?: number | null;
  verificationStatus?: string;
  certifications?: string[];
  /** True once an included MVR has cleared (set by checkr.ts). */
  isApprovedDriver?: boolean;
  /** Whether MVR was part of this caregiver's screening package. */
  backgroundCheckData?: { mvrIncluded?: boolean };
}

export interface ConfidenceResult {
  score: number;
  /** Human-readable contributors, surfaced to families. */
  signals: string[];
}

/**
 * Pure scoring function — used both by the live match path (already-loaded
 * candidate) and by the standalone Firestore-backed recompute. No I/O.
 */
export function computeConfidenceScoreFromFields(c: ConfidenceInput): ConfidenceResult {
  let s = 0;
  const signals: string[] = [];

  const bgClear =
    (c.backgroundCheckStatus ?? (c.pendingBackgroundCheck ? "pending" : "clear")) === "clear";
  const isDriver = c.backgroundCheckData?.mvrIncluded === true;
  const mvrClear = c.isApprovedDriver === true;

  // Screening cluster (35 pts total) — drivers split it BGC(25)+MVR(10) so a
  // cleared driver and a cleared non-driver both reach the same ceiling.
  if (isDriver) {
    if (bgClear) { s += 25; signals.push("background check cleared"); }
    if (mvrClear) { s += 10; signals.push("driving record cleared"); }
  } else if (bgClear) {
    s += 35;
    signals.push("background check cleared");
  }

  // Tenure (15 pts) — capped at 12 months, recency-aware.
  if (c.approvedAt) {
    const ms = Date.now() - new Date(c.approvedAt).getTime();
    const months = Number.isFinite(ms) ? Math.floor(ms / (30 * 24 * 60 * 60 * 1000)) : 0;
    if (months > 0) {
      s += (Math.min(months, 12) / 12) * 15;
      if (months >= 3) signals.push(`${months}+ months on platform`);
    }
  }

  // Rating (20 pts).
  if (c.rating != null && Number.isFinite(c.rating)) {
    s += (Math.max(0, Math.min(c.rating, 5)) / 5) * 20;
    signals.push(`${c.rating.toFixed(1)}★ rating`);
  }

  // Verification (15 pts).
  if (c.verificationStatus === "approved" || c.verificationStatus === "checkr_clear") {
    s += 15;
    signals.push("identity verified");
  }

  // Certifications (15 pts) — capped at 3.
  const certCount = Math.min(c.certifications?.length ?? 0, 3);
  if (certCount > 0) {
    s += (certCount / 3) * 15;
    signals.push(c.certifications!.slice(0, 2).join(", "));
  }

  return { score: Math.min(Math.round(s), 100), signals };
}

/**
 * Load a caregiver doc and compute their confidence score. Returns a neutral
 * zero (no penalty) for a missing caregiver.
 */
export async function computeConfidenceScore(caregiverId: string): Promise<ConfidenceResult> {
  const snap = await admin.firestore().collection("caregivers").doc(caregiverId).get();
  if (!snap.exists) return { score: 0, signals: [] };
  const d = snap.data() as ConfidenceInput;
  return computeConfidenceScoreFromFields({
    backgroundCheckStatus: d.backgroundCheckStatus,
    pendingBackgroundCheck: d.pendingBackgroundCheck,
    approvedAt: d.approvedAt,
    rating: d.rating,
    verificationStatus: d.verificationStatus,
    certifications: d.certifications,
    isApprovedDriver: d.isApprovedDriver,
    backgroundCheckData: d.backgroundCheckData,
  });
}

/** Field names that, when changed, warrant a confidence-score recompute. */
export const CONFIDENCE_SOURCE_FIELDS = [
  "backgroundCheckStatus",
  "pendingBackgroundCheck",
  "approvedAt",
  "rating",
  "verificationStatus",
  "certifications",
  "isApprovedDriver",
  "backgroundCheckData",
] as const;

/** Compute and persist the score onto the caregiver doc (seam U13 enriches). */
export async function persistConfidenceScore(caregiverId: string): Promise<ConfidenceResult> {
  const result = await computeConfidenceScore(caregiverId);
  await admin.firestore().collection("caregivers").doc(caregiverId).set(
    {
      confidenceScore: result.score,
      confidenceSignals: result.signals,
      confidenceScoreUpdatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  return result;
}
