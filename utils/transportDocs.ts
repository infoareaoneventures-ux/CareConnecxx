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
export type TransportProfile = { documents?: any; services?: string[]; skills?: string[]; isApprovedDriver?: boolean };

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
  if (!transportDocsApproved(profile)) return false;
  return (profile as any).isApprovedDriver === true;
}
