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
 * Returns true ONLY when the caregiver has completed onboarding AND is
 * verification-approved. Safe to call with undefined/null.
 */
export function isCaregiverBookable(
  caregiver: CaregiverEligibilityFields | undefined | null
): boolean {
  if (!caregiver) return false;
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
