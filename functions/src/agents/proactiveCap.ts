/**
 * Global per-user daily cap on proactive (unprompted, droppable) nudges.
 *
 * Every proactive source — situation snapshots, stale-applicant follow-ups,
 * timesheet/interview reminders, briefings, check-ins — flows through the one
 * send path (sendViaInteractionAgent) and each guards itself with its own
 * cooldown. None of them see each other, so without a shared ceiling a user can
 * get pinged by several independent jobs in a day. shouldSend already judges
 * "is this worth sending right now?"; this enforces the orthogonal "have we
 * already reached out enough today?" so proactive features stay safe to stack.
 *
 * Pure + tiny so the rollover/cap logic is unit-tested without Firestore. Only
 * canDrop, non-immediate messages are subject to it — user replies, must-send
 * messages, and urgent/safety messages bypass it entirely at the call site.
 */
export const MAX_PROACTIVE_PER_DAY = 3;

export interface ProactiveTally {
  date:  string; // UTC YYYY-MM-DD
  count: number;
}

/**
 * Decide whether one more proactive nudge may go out today, and return the tally
 * to persist if it does. `stored` is the user's last tally (or absent); `today`
 * is the current UTC date string. A stale tally (different day) resets to zero.
 */
export function evaluateProactiveCap(
  stored: ProactiveTally | undefined | null,
  today:  string,
  cap:    number = MAX_PROACTIVE_PER_DAY,
): { allowed: boolean; next: ProactiveTally } {
  const count = stored && stored.date === today ? stored.count : 0;
  if (count >= cap) {
    return { allowed: false, next: { date: today, count } };
  }
  return { allowed: true, next: { date: today, count: count + 1 } };
}
