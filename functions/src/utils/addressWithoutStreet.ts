// A pending booking request shows the care provider the family's city and ZIP, not the street (founder, 2026-11-15,
// "option 1 for now"): the same rule the job post already follows (the exact address is withheld until a booking is
// confirmed). The street appears once the care provider accepts.

/** "100 Test Lane, Gilroy, CA, 95020" → "Gilroy, CA, 95020". An address with no street part is returned as it is. */
export function addressWithoutStreet(address: string | undefined | null): string {
  const a = String(address ?? '').trim();
  if (!a) return '';
  const parts = a.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return a;
  // "Gilroy, CA 95020" (two parts, no street) is already city + state + ZIP
  if (parts.length === 2 && /\d{5}/.test(parts[1])) return a;
  return parts.slice(1).join(', ');
}
