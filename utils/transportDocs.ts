// Transportation on a caregiver's profile (founder, 2026-10-06): the driving record
// (MVR) through Checkr is the ONLY check behind it — no license / insurance /
// registration uploads, no admin document review, no expiry tracking. Those were
// removed with this rule; the caregiver's own attestation when she adds
// Transportation (own vehicle, valid license, registration and insurance) is the
// statement of responsibility, and the family is told transport is hers to provide.
//
// `hasValidTransportDocs` keeps its historical name because every family-side
// surface and Evia's matching read it; it now means "Transportation is live".

export type TransportProfile = { services?: string[]; skills?: string[]; isApprovedDriver?: boolean; hasValidTransportDocs?: boolean; mvrStatus?: unknown };

export function offersTransportation(p: TransportProfile | null | undefined): boolean {
  // services when it has entries, else skills — the field the profile page shows (2026-10-07: a stale
  // skills array still carrying Transportation sent a caregiver who had removed it to Settings).
  const services: string[] = (Array.isArray(p?.services) && p!.services!.length ? p!.services! : (p?.skills as string[]) || []) as string[];
  return services.includes('Transportation');
}

/**
 * Transportation live for families: the caregiver offers Transportation AND her
 * driving record cleared (`isApprovedDriver`, written by the Checkr webhook or the
 * admin's Approved). Public profile copies carry the precomputed flag — trust it.
 */
export function hasValidTransportDocs(profile: TransportProfile | null | undefined): boolean {
  if (!profile) return false;
  if (typeof profile.hasValidTransportDocs === 'boolean') return profile.hasValidTransportDocs;
  return offersTransportation(profile) && profile.isApprovedDriver === true;
}

/** JobBoard.tsx / caregiverAccessGate.ts: a job includes driving when it lists Transportation or requires Driving. */
export function jobIncludesDriving(job: { careTypes?: string[] | null; requirements?: string[] | null } | null | undefined): boolean {
  return !!(job?.careTypes?.includes('Transportation') || job?.requirements?.includes('Driving'));
}

/**
 * Driving jobs are not listed for a caregiver whose driving record the admin marked
 * Not approved (founder, 2026-10-05): a "Set Up Transportation" button there would
 * invite her to set up something already decided against. Everyone else — never
 * offered Transportation, record running or under review — still sees them with
 * that button, because for her it is a real path. Same rule in Evia's
 * jobBoardPage.ts (drivingJobsHiddenFor) and the new-job notice.
 */
export function drivingJobsHiddenFor(profile: { mvrStatus?: unknown } | null | undefined): boolean {
  return profile?.mvrStatus === 'not_approved';
}
