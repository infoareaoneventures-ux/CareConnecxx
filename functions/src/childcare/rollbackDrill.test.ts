// U14 (childcare marketplace plan 2026-07-22-002): rollback drill — flags before
// code, ledger preserved (rollback during booking / after payment), stale access
// revoked, migration frozen at cursor, and senior behavior unchanged.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({});
  return { __esModule: true, default: { firestore }, firestore };
});

import { runRollbackDrill, type RollbackWorld } from "./rollbackDrill";
import { PRODUCTION_PROJECT_ID } from "../migrations/nonProductionGuard";

function world(over: Partial<RollbackWorld> = {}): RollbackWorld {
  return {
    seniorFlowsOperational: true,
    childFlags: { enabled: true, discoveryEnabled: true, writesEnabled: true, proactiveEnabled: true, emergencyOff: false },
    newProviderActionsAllowed: true,
    safetyAccess: [],
    paymentLedger: [],
    bookings: [],
    migrationRunning: true,
    migrationCursor: null,
    hostingRolledBack: false,
    functionsRolledBack: false,
    ...over,
  };
}

describe("runRollbackDrill (U14)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("disables all child flags + new provider actions first, then rolls back code", () => {
    const w = world();
    const r = runRollbackDrill(w);
    expect(w.childFlags).toEqual({ enabled: false, discoveryEnabled: false, writesEnabled: false, proactiveEnabled: false, emergencyOff: true });
    expect(w.newProviderActionsAllowed).toBe(false);
    expect(r.codeRolledBackAfterFlags).toBe(true);
    expect(w.hostingRolledBack).toBe(true);
    expect(w.functionsRolledBack).toBe(true);
    // Ordering: step 1 flags_off precedes step 5 code_rollback_last.
    expect(r.steps.map((s) => s.name)).toEqual([
      "flags_off", "preserve_money_state", "revoke_stale_access", "freeze_migration", "code_rollback_last", "senior_smoke",
    ]);
  });

  it("rollback DURING a booking preserves the booking + its active safety access", () => {
    const w = world({
      bookings: [{ id: "cbook_1", state: "in_progress" }],
      safetyAccess: [{ id: "s1", kind: "safety", hasCurrentBooking: true, hasAuthority: true }],
    });
    const r = runRollbackDrill(w);
    expect(w.bookings).toHaveLength(1); // booking not deleted
    expect(r.retainedAccessCount).toBe(1);
    expect(r.revokedAccessCount).toBe(0);
    expect(w.safetyAccess[0].revoked).toBeUndefined();
    expect(r.ledgerPreserved).toBe(true);
    expect(r.seniorSmokeUnchanged).toBe(true);
  });

  it("rollback AFTER payment preserves the ledger (nothing reversed)", () => {
    const w = world({
      paymentLedger: [
        { id: "p1", state: "captured" },
        { id: "p2", state: "authorized" },
      ],
    });
    const r = runRollbackDrill(w);
    expect(w.paymentLedger).toHaveLength(2);
    expect(w.paymentLedger.map((p) => p.state)).toEqual(["captured", "authorized"]); // untouched
    expect(r.ledgerPreserved).toBe(true);
  });

  it("revokes stale safety/chat/file access (no current booking or authority)", () => {
    const w = world({
      safetyAccess: [
        { id: "stale", kind: "file", hasCurrentBooking: false, hasAuthority: false },
        { id: "active", kind: "chat", hasCurrentBooking: true, hasAuthority: false },
      ],
    });
    const r = runRollbackDrill(w);
    expect(r.revokedAccessCount).toBe(1);
    expect(r.retainedAccessCount).toBe(1);
    expect(w.safetyAccess.find((g) => g.id === "stale")!.revoked).toBe(true);
    expect(w.safetyAccess.find((g) => g.id === "active")!.revoked).toBeUndefined();
  });

  it("freezes migration at a recorded cursor", () => {
    const w = world({ migrationRunning: true });
    const r = runRollbackDrill(w, { cursor: "senior_profiles/adultX" });
    expect(w.migrationRunning).toBe(false);
    expect(w.migrationCursor).toBe("senior_profiles/adultX");
    expect(r.steps.find((s) => s.name === "freeze_migration")!.detail).toContain("senior_profiles/adultX");
  });

  it("senior smoke is identical before and after (behavior untouched)", () => {
    const w = world({
      seniorFlowsOperational: true,
      paymentLedger: [{ id: "p1", state: "captured" }],
      bookings: [{ id: "b1", state: "confirmed" }],
    });
    const r = runRollbackDrill(w);
    expect(r.seniorSmokeBefore).toEqual(r.seniorSmokeAfter);
    expect(r.seniorSmokeUnchanged).toBe(true);
    expect(w.seniorFlowsOperational).toBe(true); // senior flows still operational
  });

  it("write-capable variant reuses the hard non-production guard (refuses prod)", () => {
    process.env.GCLOUD_PROJECT = PRODUCTION_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CONFIG;
    expect(() => runRollbackDrill(world(), { assertEnvironment: true })).toThrow(/production|hard guard/i);
  });
});
