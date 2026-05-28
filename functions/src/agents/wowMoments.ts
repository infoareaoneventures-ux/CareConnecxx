// Wow-moment registry — a small catalog of delightful Cara moments that fire
// when conditions match (first booking confirmed, care anniversary, billing
// streaks, etc). Pure functions only — predicates take a snapshot context and
// return whether the moment is eligible. No I/O lives here; the caller
// (proactiveReflection, qaAgent, or a manual trigger) wires the snapshot.
//
// Why a registry instead of inline checks? Two reasons:
//   1. Adding a new wow-moment shouldn't touch reflection / qaAgent — just
//      drop a new entry and write the predicate.
//   2. Cooldown + recently-fired dedupe lives in one place. The same moment
//      shouldn't fire twice in the same window even if conditions still hold.

export interface WowSeniorEvent {
  type:      "booking_confirmed" | "visit_completed" | "billing_event" | "caregiver_assigned";
  timestamp: string;             // ISO
  meta?:     Record<string, unknown>;
}

export interface WowContext {
  /** Display name for the family member Cara writes to. */
  clientName?:        string;
  /** Display name for the senior being cared for. */
  seniorName?:        string;
  /** When the client joined CareConnex (ISO). Used for account-anniversary. */
  clientJoinedAt?:    string;
  /** When the first completed visit occurred (ISO). Used for care-anniversary. */
  firstVisitAt?:      string;
  /** Lifetime count of completed visits. Used for milestone moments. */
  completedVisits?:   number;
  /** Recent care-team events, oldest → newest, last ~30 days. */
  recentEvents?:      WowSeniorEvent[];
  /** When no billing issues (refunds/failures) in the last N days. */
  billingCleanDays?:  number;
  /** Caregiver IDs of the most recent N completed visits, newest → oldest. */
  recentCaregiverIds?: string[];
  /** Current time — injected so tests are deterministic. */
  now:                Date;
}

export interface WowMoment {
  name:          string;
  description:   string;
  /** Days a moment stays muted after firing. Defaults to 30. */
  cooldownDays?: number;
  predicate:     (ctx: WowContext) => boolean;
  /** Build the candidate SMS body. Kept under 200 chars to fit a single text. */
  buildMessage:  (ctx: WowContext) => string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(a.getTime() - b.getTime()) / DAY_MS);
}

function isFirstWeekOfMonth(date: Date): boolean {
  return date.getDate() <= 7;
}

export const WOW_MOMENTS: WowMoment[] = [
  // First booking confirmed — fires within 48h of the first confirmation event.
  {
    name:        "first_booking_confirmed",
    description: "Celebrates the family's first confirmed booking — once only.",
    cooldownDays: 365, // truly once
    predicate: (ctx) => {
      const confirms = (ctx.recentEvents ?? []).filter(e => e.type === "booking_confirmed");
      if (confirms.length !== 1) return false;
      const ageMs = ctx.now.getTime() - new Date(confirms[0].timestamp).getTime();
      return ageMs >= 0 && ageMs <= 2 * DAY_MS;
    },
    buildMessage: (ctx) => {
      const who = ctx.seniorName ?? "your loved one";
      return `Quick note — your first booking for ${who} is locked in. Excited to get this rolling. I'll be in touch as the day approaches.`;
    },
  },

  // Care anniversary — N years since the first completed visit, fires in the
  // first week of the anniversary month so it doesn't compete with the day-of
  // bookings.
  {
    name:        "care_anniversary",
    description: "Marks an anniversary of the first completed visit.",
    cooldownDays: 300,
    predicate: (ctx) => {
      if (!ctx.firstVisitAt) return false;
      const first = new Date(ctx.firstVisitAt);
      if (Number.isNaN(first.getTime())) return false;
      // Same month as the first visit, at least 1 full year later, first week.
      const sameMonth = first.getMonth() === ctx.now.getMonth();
      const yearsSince = ctx.now.getFullYear() - first.getFullYear();
      return sameMonth && yearsSince >= 1 && isFirstWeekOfMonth(ctx.now);
    },
    buildMessage: (ctx) => {
      const first = new Date(ctx.firstVisitAt!);
      const years = ctx.now.getFullYear() - first.getFullYear();
      const who = ctx.seniorName ?? "your loved one";
      const yr = years === 1 ? "year" : "years";
      return `Hard to believe — ${years} ${yr} since the first visit with ${who}. Thanks for letting us be part of the care.`;
    },
  },

  // Milestone visit counts — 10th, 25th, 50th, 100th. Fires when the count
  // is hit exactly (no retroactive flagging — we check against a step list).
  {
    name:        "visit_milestone",
    description: "Marks 10/25/50/100 completed visits.",
    cooldownDays: 60,
    predicate: (ctx) => {
      const c = ctx.completedVisits ?? 0;
      return [10, 25, 50, 100, 250].includes(c);
    },
    buildMessage: (ctx) => {
      const c = ctx.completedVisits ?? 0;
      const who = ctx.seniorName ?? "your loved one";
      return `${c} visits in — that's a real care relationship. Hope ${who} is doing well today.`;
    },
  },

  // Caregiver streak — same caregiver for the last 5 completed visits. A
  // light acknowledgment that consistency is happening.
  {
    name:        "caregiver_streak",
    description: "Same caregiver for 5+ consecutive completed visits.",
    cooldownDays: 45,
    predicate: (ctx) => {
      const ids = ctx.recentCaregiverIds ?? [];
      if (ids.length < 5) return false;
      const first = ids[0];
      if (!first) return false;
      return ids.slice(0, 5).every(id => id === first);
    },
    buildMessage: (ctx) => {
      const who = ctx.seniorName ?? "your loved one";
      return `Noticing the same caregiver has been with ${who} the last few visits — consistency like that is gold. Let me know if you want me to lock it in as a standing match.`;
    },
  },

  // Smooth billing — 90+ days with no refunds, no failed payments. Quietly
  // confirms things are working.
  {
    name:        "smooth_billing_quarter",
    description: "90+ consecutive days with zero billing issues.",
    cooldownDays: 95, // fires roughly once a quarter at most
    predicate: (ctx) => (ctx.billingCleanDays ?? 0) >= 90,
    buildMessage: () =>
      "Quick heads-up: billing's been smooth on your end for the past quarter. No action needed — just wanted you to know it's been clean.",
  },
];

export interface FireRecord {
  name:    string;
  /** ISO timestamp of the last fire. */
  firedAt: string;
}

/**
 * Returns wow-moments whose predicate matches AND which are not muted by an
 * in-cooldown firing record. Ordering: registry order (so deterministic).
 * The caller is responsible for picking ONE if it wants to send only one.
 */
export function findEligibleWowMoments(
  ctx:           WowContext,
  recentFires:   readonly FireRecord[] = [],
): WowMoment[] {
  const muted = new Set<string>();
  for (const r of recentFires) {
    const def = WOW_MOMENTS.find(m => m.name === r.name);
    if (!def) continue;
    const firedAt = new Date(r.firedAt);
    if (Number.isNaN(firedAt.getTime())) continue;
    const cooldown = (def.cooldownDays ?? 30);
    if (daysBetween(ctx.now, firedAt) < cooldown) {
      muted.add(def.name);
    }
  }

  return WOW_MOMENTS.filter(m => !muted.has(m.name) && safePredicate(m, ctx));
}

function safePredicate(m: WowMoment, ctx: WowContext): boolean {
  try {
    return m.predicate(ctx);
  } catch (err) {
    console.warn(`wowMoments: predicate threw for "${m.name}"`, err);
    return false;
  }
}

/**
 * Render the chosen wow-moment as a structured candidate the caller can
 * either send directly or pass through the supervisor first.
 */
export interface WowCandidate {
  name:    string;
  message: string;
}

export function renderWowCandidate(moment: WowMoment, ctx: WowContext): WowCandidate {
  return { name: moment.name, message: moment.buildMessage(ctx).trim() };
}

/** Convenience: pick the first eligible moment (registry order) and render it. */
export function pickWowCandidate(
  ctx:         WowContext,
  recentFires: readonly FireRecord[] = [],
): WowCandidate | null {
  const eligible = findEligibleWowMoments(ctx, recentFires);
  if (eligible.length === 0) return null;
  return renderWowCandidate(eligible[0], ctx);
}
