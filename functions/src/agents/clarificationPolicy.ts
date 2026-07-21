// Deterministic one-question clarification policy (plan 2026-07-18-001 U3,
// R16-R17, KTD7).
//
// When an objective has unresolved inputs, Evia asks exactly ONE question —
// the one that unlocks the most progress with the highest consequence of
// guessing wrong. Candidates come ONLY from the objective's unresolved state
// (missing inputs / ambiguous entities); the model may phrase the chosen
// question warmly, but it can never invent a candidate this policy didn't
// rank (KTD7). Pure module — no I/O, fully deterministic, stable tie-breaks.

export type GuessRisk = "low" | "medium" | "high";

export interface ClarificationCandidate {
  /** The unresolved field/entity this question would resolve. */
  field: string;
  /** Step ids that become actionable once this field is known. */
  unlocksSteps: string[];
  /** Consequence of acting on a guess instead of asking (money/authority/schedule = high). */
  riskIfGuessed: GuessRisk;
  /** Sanitized candidate values when the ambiguity is a known finite set (e.g. two seniors). */
  choices?: string[];
}

const RISK_WEIGHT: Record<GuessRisk, number> = { high: 2, medium: 1, low: 0 };

/**
 * Rank candidates by information gain then safety:
 *   1. more steps unlocked first (maximum progress per question — R16)
 *   2. higher risk-if-guessed first (never guess where guessing is expensive)
 *   3. fewer known choices first (a two-way ambiguity resolves crisper than a
 *      free-text ask)
 *   4. field name (stable, server-agnostic tie-break)
 */
export function rankClarifications(candidates: ClarificationCandidate[]): ClarificationCandidate[] {
  return [...candidates].sort((a, b) =>
    (b.unlocksSteps.length - a.unlocksSteps.length)
    || (RISK_WEIGHT[b.riskIfGuessed] - RISK_WEIGHT[a.riskIfGuessed])
    || ((a.choices?.length ?? Number.MAX_SAFE_INTEGER) - (b.choices?.length ?? Number.MAX_SAFE_INTEGER))
    || a.field.localeCompare(b.field),
  );
}

/**
 * The single question to ask this turn, or null when nothing is unresolved.
 * Callers must NOT ask about any other candidate this turn (R16: one question,
 * never several independent ones).
 */
export function selectClarification(candidates: ClarificationCandidate[]): ClarificationCandidate | null {
  if (candidates.length === 0) return null;
  return rankClarifications(candidates)[0];
}
