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

// ── Childcare vertical hook (childcare marketplace plan 2026-07-22-002, U5) ──
//
// Per-vertical visibility is INDEPENDENT of senior bookability (R24/R31/AE9):
// the server-computed `childcareProvider.visible` flag is the full R28 gate
// (complete vertical profile + credentials + current screening + MANUAL
// approval + policy acceptance + jurisdiction + no suspension + membership),
// written only by functions/src/childcare/providerEligibility.ts and blocked
// from caregiver self-writes by firestore.rules. This module only READS the
// derived flag — it never infers childcare eligibility from senior fields,
// and senior bookability never consults childcare state.

export interface CaregiverVerticalVisibilityFields extends CaregiverEligibilityFields {
  childcareProvider?: { visible?: boolean } | null;
}

/** True ONLY when the server-derived childcare visibility flag is exactly true. */
export function isCaregiverChildcareVisible(
  caregiver: CaregiverVerticalVisibilityFields | undefined | null
): boolean {
  if (!caregiver) return false;
  return caregiver.childcareProvider?.visible === true;
}

/**
 * Per-vertical bookability: "senior" keeps the exact legacy contract above
 * (byte-for-byte — AE9); "child" is the derived visibility flag alone. Any
 * unknown vertical fails closed.
 */
export function isCaregiverBookableForVertical(
  caregiver: CaregiverVerticalVisibilityFields | undefined | null,
  vertical: string
): boolean {
  if (vertical === "senior") return isCaregiverBookable(caregiver);
  if (vertical === "child") return isCaregiverChildcareVisible(caregiver);
  return false;
}
