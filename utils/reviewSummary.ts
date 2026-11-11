// The rating shown in a care provider's header, from the reviews actually listed (2026-11-11, fix plan Wave 3:
// the header said "No reviews yet" while the Reviews section listed one 5-star review, because the header read a
// summary field on the profile that is updated later). The profile's own count wins only when it is higher — it can
// count reviews beyond the 20 the page lists.
export function reviewSummary(profile: { rating?: number; reviewCount?: number }, listed: Array<{ rating?: number }>): { count: number; rating: number } {
  const profileCount = Number(profile.reviewCount) || 0;
  const listedCount = listed.length;
  if (listedCount === 0) return { count: profileCount, rating: Number(profile.rating) || 0 };
  const avg = listed.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / listedCount;
  if (profileCount > listedCount) return { count: profileCount, rating: Number(profile.rating) || avg };
  return { count: listedCount, rating: avg };
}
