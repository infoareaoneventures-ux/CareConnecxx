// Capability scorecard with honest coverage accounting (plan 2026-07-18-001
// U0, R45/R48/AE18).
//
// The rollout gates consume EVALUATED coverage, never nominal case counts:
//   - a skipped trial (missing provider, missing flag, refused environment)
//     is never a pass and never enters the pass-rate denominator
//   - retries of the same fixture never inflate the fixture count
//   - zero evaluated trials is "insufficient", not 100%
//   - a gate is green only when coverage AND pass rate clear their floors
//
// The behavioral rubric (weights, floors, 9.0 mapping) is versioned in
// docs/runbooks/evia-intelligence-rollout.md and ratified by the founder;
// this module only does the arithmetic and refuses to overstate it.

export type TrialStatus = "passed" | "failed" | "skipped";

export interface CapabilityTrialResult {
  capability: string;
  fixtureId: string;
  status: TrialStatus;
  /** Required for skipped trials — silent skips are unreviewable. */
  reason?: string;
}

export interface CapabilityScoreRow {
  capability: string;
  /** Unique fixtures seen (deduped — retries don't inflate this). */
  fixtures: number;
  evaluatedTrials: number;
  passedTrials: number;
  failedTrials: number;
  skippedTrials: number;
  /** passed / evaluated; null when nothing was evaluated. */
  passRate: number | null;
  /** Fixtures with at least one evaluated trial / all fixtures seen. */
  coverage: number | null;
  gate: "green" | "red" | "insufficient";
}

export interface CapabilityGateSpec {
  /** Minimum evaluated trials before the row can be anything but insufficient. */
  minEvaluatedTrials: number;
  /** Minimum pass rate (0-1) for green. */
  passThreshold: number;
  /** Minimum fixture coverage (0-1); defaults to 1 — skips must be explicit. */
  minCoverage?: number;
}

export function scoreCapability(
  results: CapabilityTrialResult[],
  spec: CapabilityGateSpec,
): CapabilityScoreRow {
  if (results.length === 0) {
    return {
      capability: "(none)", fixtures: 0, evaluatedTrials: 0, passedTrials: 0,
      failedTrials: 0, skippedTrials: 0, passRate: null, coverage: null, gate: "insufficient",
    };
  }
  const capability = results[0].capability;
  if (results.some((r) => r.capability !== capability)) {
    throw new Error("scoreCapability received trials from multiple capabilities");
  }

  const fixtures = new Set(results.map((r) => r.fixtureId));
  const evaluatedFixtures = new Set(
    results.filter((r) => r.status !== "skipped").map((r) => r.fixtureId),
  );
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const evaluated = passed + failed;

  const passRate = evaluated > 0 ? passed / evaluated : null;
  const coverage = fixtures.size > 0 ? evaluatedFixtures.size / fixtures.size : null;

  let gate: CapabilityScoreRow["gate"];
  if (evaluated < spec.minEvaluatedTrials || coverage === null || coverage < (spec.minCoverage ?? 1)) {
    gate = "insufficient";
  } else if (passRate !== null && passRate >= spec.passThreshold && failed >= 0) {
    gate = passRate >= spec.passThreshold ? "green" : "red";
  } else {
    gate = "red";
  }
  // A row with ANY failed trial on a 100% threshold is red, not green.
  if (gate === "green" && spec.passThreshold >= 1 && failed > 0) gate = "red";

  return {
    capability,
    fixtures: fixtures.size,
    evaluatedTrials: evaluated,
    passedTrials: passed,
    failedTrials: failed,
    skippedTrials: skipped,
    passRate,
    coverage,
    gate,
  };
}

export interface ScorecardSummary {
  rows: CapabilityScoreRow[];
  greenRows: number;
  redRows: number;
  insufficientRows: number;
  /**
   * True ONLY when every row is green. This is a necessary precondition for
   * "target achieved", never the whole claim — the versioned rubric score,
   * marketplace floors, and production observation windows are evaluated in
   * the rollout runbook on top of this.
   */
  allGatesGreen: boolean;
}

export function summarizeScorecard(rows: CapabilityScoreRow[]): ScorecardSummary {
  const greenRows = rows.filter((r) => r.gate === "green").length;
  const redRows = rows.filter((r) => r.gate === "red").length;
  const insufficientRows = rows.filter((r) => r.gate === "insufficient").length;
  return {
    rows,
    greenRows,
    redRows,
    insufficientRows,
    allGatesGreen: rows.length > 0 && greenRows === rows.length,
  };
}
