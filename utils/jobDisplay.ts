// Small rules for how an open job is listed to a care provider (2026-11-11, fix plan Wave 3: the list showed jobs dated
// weeks in the past, "26/hr" with no $, "via cash" / "via credit_card", and "Location TBD").

/** A job whose date is a real calendar date earlier than today is not takeable. "ASAP"/"Today"/missing dates are kept. */
export function isPastJob(job: { date?: unknown; startDate?: unknown; endDate?: unknown; ongoing?: boolean }, todayStr: string): boolean {
  const pick = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const end = pick(job.endDate);
  if (end) return end < todayStr; // a dated job is over once its end date has passed
  const start = pick(job.startDate) ?? pick(job.date);
  return !!start && start < todayStr && !job.ongoing;
}

/** "$26/hr", or "Flexible" for a flexible / unpriced job. */
export function jobRateText(job: { rate?: number | null; rateFlexible?: boolean } | null | undefined): string {
  if (!job || job.rateFlexible || !job.rate || job.rate <= 0) return 'Flexible';
  return `$${job.rate}/hr`;
}

/** Every job is paid by card through Evia (cash/Venmo/Zelle were removed platform-wide, 2026-08-23): one plain label. */
export const JOB_PAYMENT_TEXT = 'Paid by card through Evia';
