// Trajectory harness runner (plan 2026-07-18-001 U9, R45/AE22, KTD20).
//
// Executes write-capable eval fixtures against a SANDBOX environment and
// grades what HAPPENED — fresh-read final state (gradeFinalState) and the
// observed tool trajectory (gradeTrajectory) — never how the wording sounded.
// Results flow into intelligenceScorecard, which refuses to count skips as
// passes or let retries inflate coverage.
//
// SAFETY: assertSafeEvalEnvironment runs FIRST in every entry point and has
// no bypass (AE22). A fixture executed under an unprovable or production
// environment never runs — the whole suite refuses before any I/O.
//
// The harness is deliberately execution-agnostic: `run` is dependency-injected
// per fixture, so the same runner drives anything from a single adapter call
// to a full scripted agent turn against the emulator. The harness only owns
// seeding, fresh-read observation, grading, and honest aggregation.

import type * as admin from "firebase-admin";
import { assertSafeEvalEnvironment } from "./evalEnvironmentGuard";
import { gradeFinalState, gradeTrajectory, type TrajectorySpec, type GradeResult } from "./graders";
import {
  scoreCapability,
  summarizeScorecard,
  type CapabilityTrialResult,
  type CapabilityGateSpec,
  type ScorecardSummary,
} from "./intelligenceScorecard";

export interface FixtureSeedDoc {
  /** Firestore path, e.g. "agent_sessions/+15550001111". */
  path: string;
  data: Record<string, unknown>;
}

export interface TrajectoryFixture {
  id: string;
  capability: string;
  /** Documents seeded before the run (set with merge:false — exact state). */
  seed?: FixtureSeedDoc[];
  /**
   * The behavior under test. Receives the sandbox db; returns the tool-call
   * trajectory it observed. Throwing marks the trial FAILED (with the error
   * recorded); returning `{ skipped }` marks it SKIPPED with a reason.
   */
  run: (db: admin.firestore.Firestore) => Promise<{ toolCalls: string[] } | { skipped: string }>;
  expect: {
    /** Fresh-read this path after the run and grade its final state. */
    finalStatePath?: string;
    finalState?: { fields?: Record<string, unknown>; absentFields?: string[] };
    trajectory?: TrajectorySpec;
  };
}

export interface FixtureTrialOutcome extends CapabilityTrialResult {
  failures: string[];
}

async function seedFixture(db: admin.firestore.Firestore, fixture: TrajectoryFixture): Promise<void> {
  for (const doc of fixture.seed ?? []) {
    await db.doc(doc.path).set(doc.data);
  }
}

/** Run one fixture once. The environment guard has already run at suite level. */
export async function runFixtureTrial(
  db: admin.firestore.Firestore,
  fixture: TrajectoryFixture,
): Promise<FixtureTrialOutcome> {
  const base = { capability: fixture.capability, fixtureId: fixture.id };
  try {
    await seedFixture(db, fixture);
    const result = await fixture.run(db);
    if ("skipped" in result) {
      return { ...base, status: "skipped", reason: result.skipped, failures: [] };
    }

    const grades: GradeResult[] = [];
    if (fixture.expect.trajectory) {
      grades.push(gradeTrajectory(fixture.expect.trajectory, result.toolCalls));
    }
    if (fixture.expect.finalStatePath && fixture.expect.finalState) {
      // Fresh read — the grade is on what is actually in the store, never on
      // what the run claims it wrote (AE6-adjacent).
      const snap = await db.doc(fixture.expect.finalStatePath).get();
      grades.push(gradeFinalState(fixture.expect.finalState, snap.exists ? (snap.data() as Record<string, unknown>) : null));
    }

    const failures = grades.flatMap((g) => g.failures);
    return failures.length === 0
      ? { ...base, status: "passed", failures: [] }
      : { ...base, status: "failed", failures };
  } catch (err) {
    // A crash is a FAILED trial, not a skip — skips are for declared,
    // reviewable preconditions, never for errors (R48).
    return {
      ...base,
      status: "failed",
      failures: [`run threw: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

export interface HarnessRunReport {
  summary: ScorecardSummary;
  trials: FixtureTrialOutcome[];
}

/**
 * Run a suite: each fixture `trialsPerFixture` times (stochastic behaviors
 * need repeated trials), grouped and gated per capability. Refuses to start
 * outside a provable sandbox — no bypass.
 */
export async function runTrajectorySuite(
  db: admin.firestore.Firestore,
  fixtures: TrajectoryFixture[],
  spec: CapabilityGateSpec,
  opts?: { trialsPerFixture?: number; env?: NodeJS.ProcessEnv },
): Promise<HarnessRunReport> {
  assertSafeEvalEnvironment(opts?.env ?? process.env);

  const trials: FixtureTrialOutcome[] = [];
  const perFixture = Math.max(1, opts?.trialsPerFixture ?? 1);
  for (const fixture of fixtures) {
    for (let i = 0; i < perFixture; i++) {
      trials.push(await runFixtureTrial(db, fixture));
    }
  }

  const byCapability = new Map<string, CapabilityTrialResult[]>();
  for (const t of trials) {
    const list = byCapability.get(t.capability) ?? [];
    list.push({ capability: t.capability, fixtureId: t.fixtureId, status: t.status, reason: t.reason });
    byCapability.set(t.capability, list);
  }
  const rows = [...byCapability.values()].map((results) => scoreCapability(results, spec));

  return { summary: summarizeScorecard(rows), trials };
}
