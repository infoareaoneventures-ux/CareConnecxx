// Outcome and trajectory graders (plan 2026-07-18-001 U9, R45, KTD20).
//
// Evals grade what HAPPENED — final environment state and the tool
// trajectory — not how the final wording sounded. Pure functions; the
// trajectory harness feeds them observed state and calls, and multiple
// stochastic trials aggregate through intelligenceScorecard.ts (which
// already refuses to count skips as passes).

export interface GradeResult {
  passed: boolean;
  failures: string[];
}

/**
 * Final-state grade: every expected field must match observed state; fields
 * declared absent must be absent. Catches the classic false-success where the
 * model SAYS done but the document never changed (AE6-adjacent).
 */
export function gradeFinalState(
  expected: { fields?: Record<string, unknown>; absentFields?: string[] },
  observed: Record<string, unknown> | null,
): GradeResult {
  const failures: string[] = [];
  if (observed === null) {
    if (expected.fields && Object.keys(expected.fields).length > 0) {
      failures.push("expected document is missing entirely");
    }
  } else {
    for (const [k, v] of Object.entries(expected.fields ?? {})) {
      const got = observed[k];
      if (JSON.stringify(got) !== JSON.stringify(v)) {
        failures.push(`field ${k}: expected ${JSON.stringify(v)}, observed ${JSON.stringify(got)}`);
      }
    }
    for (const k of expected.absentFields ?? []) {
      if (k in observed && observed[k] !== undefined) failures.push(`field ${k} should be absent`);
    }
  }
  return { passed: failures.length === 0, failures };
}

export interface TrajectorySpec {
  /** Tools that MUST appear (in this relative order when order matters). */
  requiredTools?: string[];
  requiredInOrder?: boolean;
  /** Tools that must NEVER appear (authority/safety boundaries). */
  forbiddenTools?: string[];
  /** Max calls per tool name — catches duplicate side effects (R25). */
  maxCallsPerTool?: Record<string, number>;
  /** Cap on total calls — catches flailing. */
  maxTotalCalls?: number;
}

export function gradeTrajectory(spec: TrajectorySpec, calls: string[]): GradeResult {
  const failures: string[] = [];

  const required = spec.requiredTools ?? [];
  if (spec.requiredInOrder) {
    let cursor = 0;
    for (const call of calls) {
      if (cursor < required.length && call === required[cursor]) cursor++;
    }
    if (cursor < required.length) {
      failures.push(`required order broken: missing ${required.slice(cursor).join(", ")}`);
    }
  } else {
    for (const t of required) {
      if (!calls.includes(t)) failures.push(`required tool never called: ${t}`);
    }
  }

  for (const t of spec.forbiddenTools ?? []) {
    if (calls.includes(t)) failures.push(`forbidden tool called: ${t}`);
  }

  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const [tool, max] of Object.entries(spec.maxCallsPerTool ?? {})) {
    const n = counts.get(tool) ?? 0;
    if (n > max) failures.push(`duplicate effect: ${tool} called ${n}x (max ${max})`);
  }
  if (spec.maxTotalCalls !== undefined && calls.length > spec.maxTotalCalls) {
    failures.push(`flailing: ${calls.length} calls (max ${spec.maxTotalCalls})`);
  }

  return { passed: failures.length === 0, failures };
}
