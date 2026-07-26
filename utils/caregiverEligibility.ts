/**
 * Frontend mirror of the canonical caregiver-bookability contract.
 * The canonical twin lives at `functions/src/utils/caregiverEligibility.ts`
 * — keep the logic in both files identical.
 *
 * A caregiver is bookable ONLY when BOTH are true:
 *   - onboardingStatus  === 'profile_complete'
 *   - verificationStatus === 'approved'
 *
 * Firestore queries may pre-filter on one field (e.g. onboardingStatus ==
 * 'profile_complete'), but results MUST be post-filtered with
 * isCaregiverBookable() before display/booking.
 */

export interface CaregiverEligibilityFields {
  onboardingStatus?: string;
  verificationStatus?: string;
}

export const UNBOOKABLE_BG_STATUSES: readonly string[] = [
  'consider',
  'suspended',
  'canceled',
  'disputed',
  'pre_adverse_action',
  'rejected',
  'post_adverse_action',
];

export function isCaregiverBookable(
  caregiver: CaregiverEligibilityFields | undefined | null
): boolean {
  if (!caregiver) return false;
  return (
    caregiver.onboardingStatus === 'profile_complete' &&
    caregiver.verificationStatus === 'approved'
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
// Frontend mirror of the childcare hook in the canonical twin
// (functions/src/utils/caregiverEligibility.ts) — keep both identical (the
// eligibilityParity test pins this). Per-vertical visibility is INDEPENDENT
// of senior bookability (R24/R31/AE9): `childcareProvider.visible` is the
// server-computed full R28 gate; the browser only ever READS the derived flag.

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
 * Per-vertical bookability: 'senior' keeps the exact legacy contract above
 * (byte-for-byte — AE9); 'child' is the derived visibility flag alone. Any
 * unknown vertical fails closed.
 */
export function isCaregiverBookableForVertical(
  caregiver: CaregiverVerticalVisibilityFields | undefined | null,
  vertical: string
): boolean {
  if (vertical === 'senior') return isCaregiverBookable(caregiver);
  if (vertical === 'child') return isCaregiverChildcareVisible(caregiver);
  return false;
}
