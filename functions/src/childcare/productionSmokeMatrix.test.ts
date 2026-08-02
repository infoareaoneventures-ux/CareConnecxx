// U14 (childcare marketplace plan 2026-07-22-002): synthetic production smoke
// matrix — all 14 smokes pass their proof, auto-cleanup runs, cleanup failure
// is surfaced, and the hard non-production guard refuses prod.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({});
  return { __esModule: true, default: { firestore }, firestore };
});

import { runProductionSmokeMatrix, SMOKE_DEFINITIONS } from "./productionSmokeMatrix";
import { PRODUCTION_PROJECT_ID } from "../migrations/nonProductionGuard";
import { PRODUCTION_SMOKE_IDS } from "./productionProofRecorder";

const SKIP = { skipEnvironmentGuardForTest: true } as const;

describe("runProductionSmokeMatrix (U14)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("registers exactly the 14 matrix smokes (ids match the proof recorder)", () => {
    expect(SMOKE_DEFINITIONS).toHaveLength(14);
    expect(SMOKE_DEFINITIONS.map((s) => s.id).sort()).toEqual([...PRODUCTION_SMOKE_IDS].sort());
  });

  it("all 14 smokes pass their expected proof and cleanup succeeds", async () => {
    const cleaned: string[] = [];
    const r = await runProductionSmokeMatrix({ ...SKIP, cleanupFn: (id) => { cleaned.push(id); } });
    expect(r.allPassed).toBe(true);
    expect(r.results).toHaveLength(14);
    const failing = r.results.filter((x) => !x.passed);
    expect(failing).toEqual([]);
    // Every smoke that tracked an artifact had it torn down.
    expect(r.cleanup.attempted).toBe(cleaned.length);
    expect(r.cleanup.failed).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it("surfaces a cleanup failure (never left dangling silently)", async () => {
    const r = await runProductionSmokeMatrix({
      ...SKIP,
      cleanupFn: (id) => {
        if (id.startsWith("child_profiles/")) throw new Error("delete failed");
      },
    });
    expect(r.allPassed).toBe(true); // smokes themselves still pass
    expect(r.cleanup.failed.length).toBeGreaterThan(0);
    expect(r.clean).toBe(false); // but the run is not clean
  });

  it("refuses to run write-capable against the production project (hard guard)", async () => {
    process.env.GCLOUD_PROJECT = PRODUCTION_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CONFIG;
    await expect(runProductionSmokeMatrix()).rejects.toThrow(/production|hard guard/i);
  });
});
