import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({}) });
  return { __esModule: true, default: { firestore: stubFs }, firestore: stubFs };
});

import { runTrajectorySuite, runFixtureTrial, type TrajectoryFixture } from "./trajectoryHarness";
import { PRODUCTION_PROJECT_ID } from "./evalEnvironmentGuard";

const SANDBOX_ENV = { GCLOUD_PROJECT: "demo-evia-sandbox" } as NodeJS.ProcessEnv;

// In-memory Firestore double: doc(path).get/set only — all the harness uses.
function fakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed));
  return {
    store,
    doc: (path: string) => ({
      get: async () => {
        const data = store.get(path);
        return { exists: data !== undefined, data: () => data };
      },
      set: async (data: Record<string, unknown>) => { store.set(path, data); },
    }),
  } as never;
}

const SPEC = { minEvaluatedTrials: 1, passThreshold: 1 };

function fixture(overrides: Partial<TrajectoryFixture>): TrajectoryFixture {
  return {
    id: "fx-1",
    capability: "objective_ledger",
    run: async () => ({ toolCalls: ["get_care_plan"] }),
    expect: { trajectory: { requiredTools: ["get_care_plan"] } },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("trajectoryHarness (U9/R45/AE22)", () => {
  it("REFUSES to run against the production project — no bypass", async () => {
    await expect(
      runTrajectorySuite(fakeDb(), [fixture({})], SPEC, {
        env: { GCLOUD_PROJECT: PRODUCTION_PROJECT_ID } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/refused/i);
  });

  it("REFUSES an unprovable environment (no project id at all)", async () => {
    await expect(
      runTrajectorySuite(fakeDb(), [fixture({})], SPEC, { env: {} as NodeJS.ProcessEnv }),
    ).rejects.toThrow(/cannot be proven/i);
  });

  it("grades final state by FRESH READ, catching claimed-but-never-written state", async () => {
    const db = fakeDb();
    const out = await runFixtureTrial(db, fixture({
      run: async () => ({ toolCalls: ["update_care_plan"] }), // claims done, writes nothing
      expect: {
        trajectory: { requiredTools: ["update_care_plan"] },
        finalStatePath: "care_plans/client-1",
        finalState: { fields: { status: "active" } },
      },
    }));
    expect(out.status).toBe("failed");
    expect(out.failures.join(" ")).toMatch(/missing entirely/);
  });

  it("passes when the run actually writes the expected state", async () => {
    const db = fakeDb();
    const out = await runFixtureTrial(db, fixture({
      run: async (d) => {
        await (d as never as { doc: (p: string) => { set: (x: object) => Promise<void> } })
          .doc("care_plans/client-1").set({ status: "active" });
        return { toolCalls: ["update_care_plan"] };
      },
      expect: {
        trajectory: { requiredTools: ["update_care_plan"], forbiddenTools: ["delete_care_plan"] },
        finalStatePath: "care_plans/client-1",
        finalState: { fields: { status: "active" } },
      },
    }));
    expect(out.status).toBe("passed");
  });

  it("a crash is a FAILED trial with the error recorded — never a skip", async () => {
    const out = await runFixtureTrial(fakeDb(), fixture({
      run: async () => { throw new Error("adapter exploded"); },
    }));
    expect(out.status).toBe("failed");
    expect(out.failures[0]).toContain("adapter exploded");
  });

  it("declared skips carry a reason and never count as passes in the scorecard", async () => {
    const report = await runTrajectorySuite(
      fakeDb(),
      [
        fixture({ id: "fx-run" }),
        fixture({ id: "fx-skip", run: async () => ({ skipped: "provider flag off" }) }),
      ],
      { minEvaluatedTrials: 1, passThreshold: 1, minCoverage: 0.5 },
      { env: SANDBOX_ENV },
    );
    const row = report.summary.rows[0];
    expect(row.passedTrials).toBe(1);
    expect(row.skippedTrials).toBe(1);
    expect(report.trials.find((t) => t.fixtureId === "fx-skip")?.reason).toBe("provider flag off");
  });

  it("repeated trials of one fixture never inflate the fixture count", async () => {
    const report = await runTrajectorySuite(
      fakeDb(), [fixture({})], { minEvaluatedTrials: 3, passThreshold: 1 },
      { env: SANDBOX_ENV, trialsPerFixture: 3 },
    );
    expect(report.summary.rows[0].fixtures).toBe(1);
    expect(report.summary.rows[0].evaluatedTrials).toBe(3);
  });

  it("seeds fixture docs before the run", async () => {
    const db = fakeDb();
    const out = await runFixtureTrial(db, fixture({
      seed: [{ path: "agent_sessions/+1555", data: { onboardingStep: "complete" } }],
      run: async (d) => {
        const snap = await (d as never as { doc: (p: string) => { get: () => Promise<{ exists: boolean }> } })
          .doc("agent_sessions/+1555").get();
        return snap.exists ? { toolCalls: ["get_care_plan"] } : { toolCalls: [] };
      },
    }));
    expect(out.status).toBe("passed");
  });
});
