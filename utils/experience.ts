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
