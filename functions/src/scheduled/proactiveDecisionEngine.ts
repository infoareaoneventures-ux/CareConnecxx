// Unified proactive decision policy (plan 2026-07-18-001 U8, R40-R44, KTD15).
//
// Every OPTIONAL proactive source submits a PolicyCandidate; per recipient per
// pass, this pure policy picks AT MOST ONE optional send and gives every
// loser an explicit disposition (R43). Mandatory/emergency paths bypass per
// the frozen source manifest (docs/evia-proactive-source-manifest.md).
//
// Deterministic by construction (KTD16): ranking uses evidence coverage,
// urgency, and recipient load — never model self-confidence. Pure module: no
// I/O; callers load recipient state and persist dispositions.

export type CandidateCategory =
  | "health_pattern"   // requires deterministic careInsights evidence (R42)
  | "visit_risk"
  | "billing_heads_up"
  | "warmth"           // milestones, wow moments
  | "re_engagement"
  | "satisfaction";

export type CandidateDisposition = "send" | "review_first" | "deferred" | "suppressed" | "expired";

export interface PolicyCandidate {
  /** Manifest source id, e.g. "proactiveReflection". */
  source: string;
  category: CandidateCategory;
  /** 0-3: 3 = act today (visit at risk), 0 = nice-to-have. */
  urgency: 0 | 1 | 2 | 3;
  /** Count of deterministic evidence items backing it (careInsights etc.). */
  evidenceCount: number;
  /** Dedupe key: same-intent candidates across sources collapse (R43). */
  dedupeKey: string;
  createdAt: string;
  expiresAt: string;
}

export interface RecipientState {
  /** Optional proactive sends already delivered today. */
  optionalSendsToday: number;
  /** Currently inside the recipient's DND window. */
  inDnd: boolean;
  /** Recipient opted out of a category (R44 — cannot suppress mandatory). */
  mutedCategories?: CandidateCategory[];
  /** Daily budget for optional outreach (default 1). */
  dailyOptionalBudget?: number;
}

export interface CandidateDecision {
  candidate: PolicyCandidate;
  disposition: CandidateDisposition;
  reason: string;
  /** For deferred: when the candidate re-enters policy (R43). */
  nextEligibleAt?: string;
}

// Sensitive categories stay review-first until measured precision says
// otherwise (R42) — the engine can select them as the winner, but the winner
// goes to the review queue, not the wire.
const REVIEW_FIRST: ReadonlySet<CandidateCategory> = new Set(["health_pattern"]);

const CATEGORY_WEIGHT: Record<CandidateCategory, number> = {
  visit_risk: 50, health_pattern: 40, billing_heads_up: 30,
  satisfaction: 15, re_engagement: 10, warmth: 5,
};

function score(c: PolicyCandidate): number {
  return c.urgency * 100 + CATEGORY_WEIGHT[c.category] + Math.min(c.evidenceCount, 5);
}

const DEFER_HOURS = 24;

/**
 * Decide one recipient's pass. Deterministic: same inputs, same outputs,
 * stable ordering. At most one `send`/`review_first` per pass.
 */
export function decideForRecipient(
  candidates: PolicyCandidate[],
  state: RecipientState,
  now: Date = new Date(),
): CandidateDecision[] {
  const nowMs = now.getTime();
  const nextEligibleAt = new Date(nowMs + DEFER_HOURS * 60 * 60 * 1000).toISOString();
  const decisions: CandidateDecision[] = [];
  const live: PolicyCandidate[] = [];
  const seenDedupe = new Set<string>();

  // Stable order: score desc, then older first, then dedupeKey.
  const ordered = [...candidates].sort((a, b) =>
    score(b) - score(a) || a.createdAt.localeCompare(b.createdAt) || a.dedupeKey.localeCompare(b.dedupeKey));

  for (const c of ordered) {
    if (Date.parse(c.expiresAt) <= nowMs) {
      decisions.push({ candidate: c, disposition: "expired", reason: "expired_before_decision" });
      continue;
    }
    if (state.mutedCategories?.includes(c.category)) {
      decisions.push({ candidate: c, disposition: "suppressed", reason: "category_muted_by_recipient" });
      continue;
    }
    if (c.category === "health_pattern" && c.evidenceCount < 1) {
      // R42: no deterministic evidence = no health outreach, ever.
      decisions.push({ candidate: c, disposition: "suppressed", reason: "no_deterministic_evidence" });
      continue;
    }
    if (seenDedupe.has(c.dedupeKey)) {
      decisions.push({ candidate: c, disposition: "suppressed", reason: "duplicate_intent" });
      continue;
    }
    seenDedupe.add(c.dedupeKey);
    live.push(c);
  }

  const budget = state.dailyOptionalBudget ?? 1;
  const blocked = state.inDnd || state.optionalSendsToday >= budget;

  let winnerChosen = false;
  for (const c of live) {
    if (!winnerChosen && !blocked) {
      winnerChosen = true;
      decisions.push({
        candidate: c,
        disposition: REVIEW_FIRST.has(c.category) ? "review_first" : "send",
        reason: REVIEW_FIRST.has(c.category) ? "winner_sensitive_category" : "winner",
      });
    } else {
      decisions.push({
        candidate: c,
        disposition: "deferred",
        reason: blocked ? (state.inDnd ? "dnd_window" : "daily_budget_reached") : "lost_to_higher_priority",
        nextEligibleAt,
      });
    }
  }
  return decisions;
}
