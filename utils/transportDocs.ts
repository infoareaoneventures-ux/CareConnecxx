const TRANSPORT_DOC_TYPES = ['driversLicense', 'insurance', 'registration'] as const;

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-');
  return new Date(+y, +m - 1, +d);
}

/**
 * Returns true if the caregiver offers Transportation as a service AND
 * has all three transport documents approved and not expired.
 * This is the single source of truth for transport eligibility — no stored field needed.
 */
export function hasValidTransportDocs(profile: { documents?: any } | null | undefined): boolean {
  if (!profile) return false;
  const p = profile as any;
  const services: string[] = [...(p.skills || []), ...(p.services || [])];
  if (!services.includes('Transportation')) return false;
  const docs = p.documents;
  if (!docs) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isValid = (doc: any) =>
    doc?.status === 'approved' &&
    (!doc.expirationDate || parseLocalDate(doc.expirationDate) >= today);
  return TRANSPORT_DOC_TYPES.every(t => isValid(docs[t]));
}
