// U14 (childcare marketplace plan 2026-07-22-002): production proof recorder —
// R62 evidence completeness + child-safe persistence.

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({});
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  buildProductionProofBundle,
  recordProductionProof,
  PRODUCTION_SMOKE_IDS,
  CHILDCARE_DEPLOYMENT_PROOF_DOC,
  type ProductionProofBundle,
} from "./productionProofRecorder";

function completeInput(): Partial<ProductionProofBundle> {
  return {
    gitSha: "abc1234",
    firebaseProject: "careconnex-staging",
    functionsUpdateTimes: { migrateHouseholds: "2026-07-24T00:00:00Z" },
    hostingRelease: "rel_1",
    rulesRelease: "rules_1",
    storageRulesRelease: "storage_1",
    indexStates: { childcare_booking_safety_q36: "READY" },
    schedulerStates: { childcareCanaryWatch: "disabled" },
    flagStates: { CHILDCARE_ENABLED: false },
    migrationCounts: { old: 10, migrated: 8, provisional: 3, quarantined: 0, orphan: 0, unresolved: 0 },
    smokeIds: [...PRODUCTION_SMOKE_IDS],
    monitoringHealth: { rolloutHeld: false, redSignals: 0 },
    rollbackDrill: { ranAt: "2026-07-24T01:00:00Z", seniorSmokeUnchanged: true },
  };
}

describe("buildProductionProofBundle (U14)", () => {
  it("is complete when every R62 evidence field is present and clean", () => {
    const { complete, missing } = buildProductionProofBundle(completeInput());
    expect(missing).toEqual([]);
    expect(complete).toBe(true);
  });

  it("flags an empty bundle with the full missing list", () => {
    const { complete, missing } = buildProductionProofBundle({});
    expect(complete).toBe(false);
    expect(missing).toEqual(expect.arrayContaining(["gitSha", "firebaseProject", "hostingRelease"]));
  });

  it("refuses when migration has unresolved records", () => {
    const { complete, missing } = buildProductionProofBundle({
      ...completeInput(),
      migrationCounts: { old: 10, migrated: 8, provisional: 3, quarantined: 2, orphan: 0, unresolved: 2 },
    });
    expect(complete).toBe(false);
    expect(missing).toContain("migrationCounts.unresolved(must be 0)");
  });

  it("refuses when an index is not READY", () => {
    const { missing } = buildProductionProofBundle({
      ...completeInput(),
      indexStates: { some_index: "CREATING" },
    });
    expect(missing.some((m) => m.startsWith("indexStates"))).toBe(true);
  });

  it("refuses when a smoke id is missing", () => {
    const { missing } = buildProductionProofBundle({
      ...completeInput(),
      smokeIds: PRODUCTION_SMOKE_IDS.slice(0, 5),
    });
    expect(missing.some((m) => m.startsWith("smokeIds"))).toBe(true);
  });

  it("refuses when the rollback drill changed senior behavior or monitoring is held", () => {
    const held = buildProductionProofBundle({ ...completeInput(), monitoringHealth: { rolloutHeld: true, redSignals: 0 } });
    expect(held.missing).toContain("monitoringHealth.rolloutHeld(held)");
    const regressed = buildProductionProofBundle({ ...completeInput(), rollbackDrill: { ranAt: "t", seniorSmokeUnchanged: false } });
    expect(regressed.missing).toContain("rollbackDrill.seniorSmokeUnchanged(false)");
  });
});

describe("recordProductionProof (U14)", () => {
  it("writes the bundle + verdict to childcare_canary_state/deployment_proof", async () => {
    let wrote: { coll?: string; id?: string; data?: any } = {};
    const db = {
      collection: (coll: string) => ({
        doc: (id: string) => ({
          set: async (data: unknown) => {
            wrote = { coll, id, data };
          },
        }),
      }),
    };
    const completeness = buildProductionProofBundle(completeInput());
    await recordProductionProof(db as any, completeness);
    expect(wrote.coll).toBe("childcare_canary_state");
    expect(wrote.id).toBe(CHILDCARE_DEPLOYMENT_PROOF_DOC);
    expect(wrote.data.complete).toBe(true);
    expect(wrote.data.syntheticOnly).toBe(true);
    expect(wrote.data.gitSha).toBe("abc1234");
  });
});
