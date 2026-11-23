/** An interview is over an hour after it started: from then on there is nothing to join, accept or reschedule. */
export const INTERVIEW_GRACE_MS = 60 * 60 * 1000;

export function interviewIsOver(scheduledAt: string | number | Date | null | undefined, now: number = Date.now()): boolean {
  if (scheduledAt == null || scheduledAt === '') return false;
  const t = new Date(scheduledAt as any).getTime();
  if (isNaN(t)) return false;
  return t + INTERVIEW_GRACE_MS < now;
}
