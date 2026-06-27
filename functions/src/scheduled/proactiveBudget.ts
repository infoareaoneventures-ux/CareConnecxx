/**
 * Cumulative per-family weekly proactive-send budget (U6/KTD-14, plan
 * 2026-06-23-001).
 *
 * The codebase already runs ~19 proactive scheduled sends plus a per-user DAILY
 * cap (`evaluateProactiveCap`). This adds a WEEKLY per-family ceiling with
 * priority ordering so that as a family's week fills up, the lowest-value
 * messages (payment nudges, satisfaction surveys) are dropped first while
 * operational reminders and per-shift feedback still get through. Pure — no I/O
 * — so it is directly unit-testable; jobs store the returned tally on the
 * family's agent_session.
 */

export type ProactiveCampaign =
  | "operational" // shift/arrival reminders — highest priority
  | "next_day_feedback"
  | "satisfaction_checkin"
  | "payment_reminder"; // lowest priority

/** Lower rank = higher priority = larger share of the weekly budget. */
const PRIORITY: Record<ProactiveCampaign, number> = {
  operational: 0,
  next_day_feedback: 1,
  satisfaction_checkin: 2,
  payment_reminder: 3,
};

/** Total proactive sends allowed per family per week (calibration pending). */
export const WEEKLY_FAMILY_PROACTIVE_BUDGET = 4;

export interface WeeklyBudgetTally {
  weekStart: string; // ISO date (Monday) the tally applies to
  count: number;
}

/** Monday-based ISO week start (date only) for the given instant. */
export function isoWeekStart(nowIso: string): string {
  const d = new Date(nowIso);
  const mondayOffset = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

/**
 * Decide whether a proactive message of `campaign` may be sent to a family this
 * week, given their stored tally. Lower-priority campaigns face a tighter
 * ceiling so they are the first dropped when the budget binds.
 */
export function evaluateWeeklyFamilyBudget(
  tally: WeeklyBudgetTally | undefined,
  campaign: ProactiveCampaign,
  nowIso: string,
  budget: number = WEEKLY_FAMILY_PROACTIVE_BUDGET,
): { allowed: boolean; next: WeeklyBudgetTally } {
  const weekStart = isoWeekStart(nowIso);
  const current = tally && tally.weekStart === weekStart ? tally.count : 0;
  // operational: budget, next_day_feedback: budget-1, ... never below 1.
  const ceiling = Math.max(budget - PRIORITY[campaign], 1);
  const allowed = current < ceiling;
  return { allowed, next: { weekStart, count: allowed ? current + 1 : current } };
}
