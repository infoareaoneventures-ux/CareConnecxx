const TRANSPORT_DOC_TYPES = ['driversLicense', 'insurance', 'registration'] as const;

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-');
  return new Date(+y, +m - 1, +d);
}

function offersTransportation(p: any): boolean {
  const services: string[] = [...(p.skills || []), ...(p.services || [])];
  return services.includes('Transportation');
}

/**
 * True when the caregiver offers Transportation AND all three transport
 * documents are admin-approved and unexpired. This is the DOCUMENTS half of
 * the transportation badge only — see hasValidTransportDocs for the badge.
 */
export type TransportProfile = { documents?: any; services?: string[]; skills?: string[]; isApprovedDriver?: boolean; hasValidTransportDocs?: boolean };

export function transportDocsApproved(profile: TransportProfile | null | undefined): boolean {
  if (!profile) return false;
  const p = profile as any;
  if (!offersTransportation(p)) return false;
  const docs = p.documents;
  if (!docs) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isValid = (doc: any) =>
    doc?.status === 'approved' &&
    (!doc.expirationDate || parseLocalDate(doc.expirationDate) >= today);
  return TRANSPORT_DOC_TYPES.every(t => isValid(docs[t]));
}

/**
 * The transportation badge families see. Returns true only when the caregiver
 * offers Transportation, all three transport documents are approved and
 * unexpired, AND the driving record (MVR) check cleared (`isApprovedDriver`,
 * written only by the Checkr webhook). Founder, 2026-09-25: the flat
 * membership covers the MVR, and neither the documents nor the MVR alone earns
 * the badge. Single source of truth — no stored field needed.
 */
export function hasValidTransportDocs(profile: TransportProfile | null | undefined): boolean {
  if (!profile) return false;
  // publicCaregiverProfiles (what every FAMILY-side surface reads — Find Caregivers,
  // the dashboard cards, the profile modal) never carry the documents: the server
  // computes this same rule from the private record and writes only the resulting
  // true/false (functions/src/publicCaregiverProfile.ts). Trust it when present;
  // without it (2026-09-30) the documents lookup below answered "no" for everyone
  // and the Transportation filter always returned 0.
  if (typeof profile.hasValidTransportDocs === 'boolean') return profile.hasValidTransportDocs;
  if (!transportDocsApproved(profile)) return false;
  return (profile as any).isApprovedDriver === true;
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
