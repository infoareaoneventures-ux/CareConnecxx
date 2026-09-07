/**
 * Canonical caregiver-bookability contract.
 *
 * A caregiver is bookable ONLY when BOTH are true:
 *   - onboardingStatus  === "profile_complete"  (Evia onboarding finished)
 *   - verificationStatus === "approved"          (background check cleared / admin approved)
 *
 * Query contract: Firestore queries may pre-filter on ONE field for index
 * efficiency (e.g. where("onboardingStatus", "==", "profile_complete") or
 * where("verified", "==", true)), but they MUST post-filter the fetched docs
 * with isCaregiverBookable() before using them. Never treat `verified: true`
 * or `status: "active"` alone as bookable.
 *
 * This module is intentionally dependency-free (no firebase imports) so the
 * frontend can mirror the exact same logic — see the twin file at
 * `utils/caregiverEligibility.ts` (repo root) and keep both in sync.
 */

export interface CaregiverEligibilityFields {
  onboardingStatus?: string;
  verificationStatus?: string;
  /** ISO date/datetime; caregiver is unavailable while this is in the future. */
  pausedUntil?: string;
  /**
   * Mirrored from agent_sessions.optedOut (the real SMS/TCPA opt-out, STOP
   * keyword) by triggers/caregiverOptOutMirror.ts — this field itself is
   * never the source of truth, just a denormalized copy this pure/sync
   * function can read without a second collection lookup.
   */
  optedOut?: boolean;
}

/**
 * Background-check / verification statuses that must NEVER result in a
 * bookable caregiver.
 */
export const UNBOOKABLE_BG_STATUSES: readonly string[] = [
  "consider",
  "suspended",
  "canceled",
  "disputed",
  "pre_adverse_action",
  "rejected",
  "post_adverse_action",
];

/**
 * Returns true ONLY when the caregiver has completed onboarding, is
 * verification-approved, AND isn't currently paused. Safe to call with
 * undefined/null.
 *
 * 2026-09-06: pausing (pause_account/reactivate_account, functions/src/agents/
 * pauseAccount.ts) used to be checked ONLY by the SMS matching flow
 * (matchingAgent.ts's own local isTemporarilyUnavailable) — the site's
 * Dashboard widget, Browse Caregivers page, and find_nearby_caregivers all
 * called this canonical gate directly and had no idea pausing existed, so a
 * caregiver who explicitly paused (vacation, break) could still be shown and
 * contacted everywhere except over SMS. Folding it in here closes that gap
 * everywhere at once, since this is the one function every surface calls.
 */
export function isCaregiverBookable(
  caregiver: CaregiverEligibilityFields | undefined | null,
  nowIso: string = new Date().toISOString(),
): boolean {
  if (!caregiver) return false;
  if (caregiver.pausedUntil && caregiver.pausedUntil > nowIso) return false;
  if (caregiver.optedOut === true) return false;
  return (
    caregiver.onboardingStatus === "profile_complete" &&
    caregiver.verificationStatus === "approved"
  );
}

/**
 * Convenience predicate for Array#filter over Firestore doc data:
 *   snap.docs.map(d => d.data()).filter(bookableFilter)
 */
export const bookableFilter = (
  caregiver: CaregiverEligibilityFields | undefined | null
): boolean => isCaregiverBookable(caregiver);
