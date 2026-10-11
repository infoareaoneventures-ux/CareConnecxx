// One cadence for the onboarding nudges (founder, 2026-10-11: "one per day is
// too much"): a person who stalls mid-signup hears from Evia three times —
// about 2, 5 and 12 days after their last message — then never again for that
// silence. A reply restarts the count from that reply. Never twice in one day.
// Nothing after 14 days of silence (abandoned, the old re-engagement window).

export const NUDGE_DAYS = [2, 5, 12] as const;
export const MAX_NUDGES = NUDGE_DAYS.length;
export const ABANDONED_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NudgeState {
  /** The person's last inbound message (falls back to the session's creation). */
  lastInboundAt?: string | null;
  createdAt?: string | null;
  /** Nudges already sent for THIS silence — see nudgeAnchorAt. */
  nudgeCount?: number | null;
  /** The lastInboundAt the count was taken against; a newer inbound resets the count. */
  nudgeAnchorAt?: string | null;
  nudgeSentAt?: string | null;
}

export interface NudgeDecision {
  /** 0 = nothing due; 1..3 = which nudge of the series is due now. */
  due: 0 | 1 | 2 | 3;
  /** The anchor the series is counted against (store it as nudgeAnchorAt on send). */
  anchorAt: string | null;
  /** Nudges already sent against that anchor. */
  countSoFar: number;
}

function ms(v: unknown): number {
  const t = typeof v === "string" && v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

export function decideNudge(s: NudgeState, nowMs = Date.now()): NudgeDecision {
  const anchorIso = (typeof s.lastInboundAt === "string" && s.lastInboundAt) ? s.lastInboundAt : (s.createdAt ?? null);
  const anchor = ms(anchorIso);
  if (!Number.isFinite(anchor)) return { due: 0, anchorAt: null, countSoFar: 0 };
  // A reply after the last nudge starts a fresh series.
  const countSoFar = s.nudgeAnchorAt === anchorIso ? Math.max(0, Number(s.nudgeCount ?? 0)) : 0;
  if (countSoFar >= MAX_NUDGES) return { due: 0, anchorAt: anchorIso, countSoFar };
  const idleDays = (nowMs - anchor) / DAY_MS;
  if (idleDays > ABANDONED_AFTER_DAYS) return { due: 0, anchorAt: anchorIso, countSoFar };
  if (idleDays < NUDGE_DAYS[countSoFar]) return { due: 0, anchorAt: anchorIso, countSoFar };
  // Never twice in one day.
  const last = ms(s.nudgeSentAt);
  if (Number.isFinite(last) && nowMs - last < DAY_MS) return { due: 0, anchorAt: anchorIso, countSoFar };
  return { due: (countSoFar + 1) as 1 | 2 | 3, anchorAt: anchorIso, countSoFar };
}
