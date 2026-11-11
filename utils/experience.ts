// One formatter for a caregiver's experience wherever the site shows it.
// Caregivers store years as a number ("8") or a phrase ("5+ years"); the
// profile page and Find Caregivers used to append the bare word — "8 experience"
// (live-caught 2026-09-19). Mirrored in functions/src/agents/caregiverProfilePage.ts.
export function formatExperience(exp: unknown, emptyLabel = ''): string {
  const s = String(exp ?? '').trim();
  if (!s || s === '0') return emptyLabel;
  if (/experience/i.test(s)) return s;
  if (/year/i.test(s)) return `${s} experience`;
  const n = Number(s);
  if (Number.isFinite(n)) return `${s} ${n === 1 ? 'year' : 'years'} experience`;
  return `${s} experience`;
}

/**
 * Years of experience as a number, for filtering and sorting (2026-11-11, fix plan Wave 3: a "3-5 years" care
 * provider still showed under "5+ years" because the stored bucket string was compared with a number). A bucket reads
 * as its LOWER bound, so a family filtering for "5+ years" only sees providers whose bucket starts at 5 or more:
 * "< 1 year" → 0, "1-2 years" → 1, "3-5 years" → 3, "5-10 years" → 5, "10+ years" → 10. A plain number is itself.
 */
export function experienceYears(exp: unknown): number {
  if (typeof exp === 'number') return Number.isFinite(exp) && exp > 0 ? exp : 0;
  const s = String(exp ?? '').trim().toLowerCase();
  if (!s) return 0;
  if (/^(less than|under)\s*(a|1|one)\b/.test(s) || /^<\s*1/.test(s)) return 0;
  const m = s.match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}
