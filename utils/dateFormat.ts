/**
 * One way to show a calendar day to a person: "Nov 23, 2026". Takes a "YYYY-MM-DD" string (read as that
 * calendar day, not shifted by the viewer's time zone), a Date, or a label like "Today"/"Tomorrow", and
 * returns anything it can't read unchanged so a bad value never becomes "Invalid Date".
 */
const LABELS = new Set(['today', 'tomorrow']);

export function formatDay(value: string | Date | null | undefined, opts: { withYear?: boolean } = {}): string {
  if (value == null || value === '') return '';
  const withYear = opts.withYear ?? true;
  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else {
    if (LABELS.has(value.trim().toLowerCase())) return value;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
    d = new Date(day);
  }
  if (isNaN(d.getTime())) return typeof value === 'string' ? value : '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}
