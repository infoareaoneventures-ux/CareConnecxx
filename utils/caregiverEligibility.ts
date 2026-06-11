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
