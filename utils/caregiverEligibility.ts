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
  /** ISO date/datetime; caregiver is unavailable while this is in the future. */
  pausedUntil?: string;
  /** Mirrored from the real SMS/TCPA opt-out (STOP keyword) — see the backend twin. */
  optedOut?: boolean;
  /** Membership (2026-10-06): families meet only caregivers whose membership is active — a lapsed one can't act on anything they send. */
  membershipStatus?: string;
  membershipPaid?: boolean;
  /** Precomputed on publicCaregiverProfiles (toPublicProfile) — trusted when present, the raw membership fields never land on the public copy. */
  clearedForFamilies?: boolean;
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
  caregiver: CaregiverEligibilityFields | undefined | null,
  nowIso: string = new Date().toISOString(),
): boolean {
  if (!caregiver) return false;
  if (caregiver.pausedUntil && caregiver.pausedUntil > nowIso) return false;
  if (caregiver.optedOut === true) return false;
  // 2026-10-06: + membership (isCaregiverClearedForFamilies) — a lapsed caregiver is not
  // bookable, listed, or contactable by new families; existing threads/visits untouched.
  return isCaregiverClearedForFamilies(caregiver);
}


/**
 * Founder, 2026-10-06: a family can do NOTHING with a caregiver whose background
 * check isn't clear / approved — not message, not interview, not open the profile.
 * This is the approval half of isCaregiverBookable WITHOUT the pause / opt-out
 * half, so a family already working with a caregiver who paused can still reach
 * them in an existing thread and see their profile. Used by: the profile pages,
 * the chat-room create rule (firestore.rules caregiverClearedForFamilies), the
 * interview helper, Evia's message tool and profile text, the public /p callable.
 */
export function isCaregiverClearedForFamilies(
  caregiver: CaregiverEligibilityFields | undefined | null,
): boolean {
  if (!caregiver) return false;
  if (typeof caregiver.clearedForFamilies === 'boolean') return caregiver.clearedForFamilies;
  return (
    caregiver.onboardingStatus === 'profile_complete' &&
    caregiver.verificationStatus === 'approved' &&
    isCaregiverMembershipActiveForFamilies(caregiver)
  );
}

/**
 * The membership half (2026-10-06): active / trialing, or the legacy paid flag with no
 * status yet — the same rule the caregiver's own gates use (hooks/useCaregiverGate.tsx
 * caregiverMembershipActive, agents/caregiverAccessGate.ts isCaregiverMembershipActive,
 * firestore.rules caregiverMembershipActive). A lapsed membership means the yearly
 * background check didn't re-run and the caregiver can't act, so families don't meet them.
 */
export function isCaregiverMembershipActiveForFamilies(
  caregiver: CaregiverEligibilityFields | undefined | null,
): boolean {
  if (!caregiver) return false;
  if (caregiver.membershipStatus === 'active' || caregiver.membershipStatus === 'trialing') return true;
  return !caregiver.membershipStatus && caregiver.membershipPaid === true;
}

/** What a family is told, everywhere, when a caregiver isn't cleared yet — never the reason. */
export const CAREGIVER_NOT_AVAILABLE_TEXT = "This caregiver isn't available yet.";

/**
 * Convenience predicate for Array#filter over Firestore doc data:
 *   snap.docs.map(d => d.data()).filter(bookableFilter)
 */
export const bookableFilter = (
  caregiver: CaregiverEligibilityFields | undefined | null
): boolean => isCaregiverBookable(caregiver);
