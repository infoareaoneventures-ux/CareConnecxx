// U14 (childcare marketplace plan 2026-07-22-002): deployment gate logic —
// refuses on failed audit, rollout hold, incomplete jurisdiction readiness,
// unresolved/unreconciled migration, unset cutoff, and unconfirmed preflight;
// proceeds only when every signal is green.

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({});
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  evaluateDeploymentGate,
  collectDeploymentGateSignals,
  REQUIRED_PREFLIGHT_CHECKS,
  DEPLOYMENT_STEPS,
  type DeploymentGateSignals,
  CHILDCARE_PRODUCTION_HOSTING_DOMAINS,
} from "./deployGate";

function greenPreflight(): Record<string, boolean> {
  return Object.fromEntries(REQUIRED_PREFLIGHT_CHECKS.map((k) => [k, true]));
}

function greenSignals(over: Partial<DeploymentGateSignals> = {}): DeploymentGateSignals {
  const appCheckProof = Object.fromEntries(
    CHILDCARE_PRODUCTION_HOSTING_DOMAINS.map((domain) => [
      domain,
      {
        normalAccepted: true,
        absentDenied: true,
        invalidDenied: true,
        expiredDenied: true,
        debugDenied: true,
        replayDenied: true,
      },
    ]),
  );
  return {
    consumerAuditPassed: true,
    indexAuditPassed: true,
    rolloutHold: { held: false, reasons: [], updatedAt: "" },
    jurisdictionReadiness: { state: "CA", policyVersion: "CA-1", activatable: true, issues: [] },
    migrationUnresolved: 0,
    migrationReconciled: true,
    cutoffSet: true,
    appCheckConfig: {
      mode: "enforce",
      source: "firestore",
      transitionRecorded: true,
      transitionAt: "2026-07-25T00:00:00.000Z",
      providerRegistrationVerified: true,
      debugTokensAllowed: false,
      verifiedDomains: [...CHILDCARE_PRODUCTION_HOSTING_DOMAINS],
    },
    appCheckProof,
    preflight: greenPreflight(),
    ...over,
  };
}

describe("evaluateDeploymentGate (U14)", () => {
  it("proceeds when every signal is green — all 10 steps reachable", () => {
    const d = evaluateDeploymentGate(greenSignals());
    expect(d.canProceed).toBe(true);
    expect(d.refusals).toEqual([]);
    expect(d.steps).toHaveLength(DEPLOYMENT_STEPS.length);
    expect(d.steps.every((s) => s.reachable)).toBe(true);
  });

  it("refuses when the consumer manifest audit fails (blocks step 1)", () => {
    const d = evaluateDeploymentGate(greenSignals({ consumerAuditPassed: false }));
    expect(d.canProceed).toBe(false);
    expect(d.refusals.map((r) => r.code)).toContain("consumer_audit_failed");
    expect(d.steps.find((s) => s.n === 1)!.reachable).toBe(false);
  });

  it("refuses when the index audit fails (blocks step 3)", () => {
    const d = evaluateDeploymentGate(greenSignals({ indexAuditPassed: false }));
    expect(d.refusals.map((r) => r.code)).toContain("index_audit_failed");
    expect(d.steps.find((s) => s.n === 3)!.reachable).toBe(false);
  });

  it("refuses when the childcare canary rollout-HOLD is set (blocks cohort enablement, step 9)", () => {
    const d = evaluateDeploymentGate(
      greenSignals({ rolloutHold: { held: true, reasons: ["memory_denial_breach"], updatedAt: "now" } }),
    );
    expect(d.canProceed).toBe(false);
    expect(d.refusals.find((r) => r.code === "rollout_held")!.detail).toContain("memory_denial_breach");
    expect(d.steps.find((s) => s.n === 9)!.reachable).toBe(false);
  });

  it("refuses when jurisdiction readiness is incomplete (blocks step 9)", () => {
    const d = evaluateDeploymentGate(
      greenSignals({
        jurisdictionReadiness: {
          state: "CA",
          policyVersion: null,
          activatable: false,
          issues: [{ code: "approval_reference_missing", field: "approvals.legalCounsel", detail: "x" }],
        },
      }),
    );
    expect(d.refusals.map((r) => r.code)).toContain("jurisdiction_incomplete");
    expect(d.steps.find((s) => s.n === 9)!.reachable).toBe(false);
  });

  it("refuses when the migration has unresolved/quarantined records (blocks step 6)", () => {
    const d = evaluateDeploymentGate(greenSignals({ migrationUnresolved: 3 }));
    expect(d.refusals.find((r) => r.code === "migration_unresolved")!.detail).toContain("3");
    expect(d.steps.find((s) => s.n === 6)!.reachable).toBe(false);
  });

  it("refuses when the migration is not reconciled", () => {
    const d = evaluateDeploymentGate(greenSignals({ migrationReconciled: false }));
    expect(d.refusals.map((r) => r.code)).toContain("migration_not_reconciled");
  });

  it("refuses when the migration cutoff is still the placeholder", () => {
    const d = evaluateDeploymentGate(greenSignals({ cutoffSet: false }));
    expect(d.refusals.map((r) => r.code)).toContain("cutoff_unset");
    expect(d.steps.find((s) => s.n === 6)!.reachable).toBe(false);
  });

  it("refuses when any preflight check is unconfirmed (fail-closed on missing keys)", () => {
    const d = evaluateDeploymentGate(greenSignals({ preflight: { appCheckRegistered: true } }));
    const refusal = d.refusals.find((r) => r.code === "preflight_unconfirmed")!;
    expect(refusal.detail).toContain("targetProjectConfirmed");
    expect(d.steps.find((s) => s.n === 2)!.reachable).toBe(false);
  });

  it("accumulates multiple refusals at once", () => {
    const d = evaluateDeploymentGate(
      greenSignals({ consumerAuditPassed: false, indexAuditPassed: false, cutoffSet: false }),
    );
    expect(d.refusals.map((r) => r.code).sort()).toEqual(["consumer_audit_failed", "cutoff_unset", "index_audit_failed"]);
  });

  it("refuses until enforce mode, provider, both domains, negative cases, and replay are proven", () => {
    const d = evaluateDeploymentGate(
      greenSignals({
        appCheckConfig: {
          mode: "monitor",
          source: "default",
          transitionRecorded: false,
          transitionAt: null,
          providerRegistrationVerified: false,
          debugTokensAllowed: true,
          verifiedDomains: [],
        },
        appCheckProof: {},
      }),
    );
    expect(d.refusals.map((r) => r.code)).toEqual(
      expect.arrayContaining([
        "app_check_not_enforced",
        "app_check_transition_unrecorded",
        "app_check_provider_unverified",
        "app_check_domains_unverified",
        "app_check_debug_tokens_allowed",
        "app_check_negative_proof_missing",
        "app_check_replay_proof_missing",
      ]),
    );
    expect(d.steps.find((s) => s.n === 2)!.reachable).toBe(false);
  });
});

describe("collectDeploymentGateSignals (U14)", () => {
  // Fake db returning docs for rollout_hold, jurisdiction policy, migration report.
  function fakeDb(docs: Record<string, Record<string, unknown> | undefined>) {
    return {
      collection: (coll: string) => ({
        doc: (id: string) => ({
          get: async () => {
            const key = `${coll}/${id}`;
            const data = docs[key];
            return { exists: data !== undefined, id, data: () => data };
          },
        }),
      }),
    };
  }

  it("reads rollout hold, jurisdiction readiness, and migration report from Firestore", async () => {
    const db = fakeDb({
      "childcare_canary_state/rollout_hold": { held: false, reasons: [], updatedAt: "t" },
      "childcare_canary_state/migration_report": {
        unresolved: 0,
        byMigration: { migrateHouseholds: { reconciled: true } },
      },
      // absent jurisdiction policy → readiness will report policy_absent (not activatable)
    });
    const signals = await collectDeploymentGateSignals({
      db: db as any,
      pilotState: "CA",
      consumerAuditPassed: true,
      indexAuditPassed: true,
      preflight: greenPreflight(),
    });
    expect(signals.rolloutHold.held).toBe(false);
    expect(signals.migrationUnresolved).toBe(0);
    expect(signals.migrationReconciled).toBe(true);
    expect(signals.jurisdictionReadiness.activatable).toBe(false); // no CA policy seeded
  });

  it("treats an absent migration report as not-reconciled (rehearsal never ran)", async () => {
    const db = fakeDb({ "childcare_canary_state/rollout_hold": { held: false } });
    const signals = await collectDeploymentGateSignals({
      db: db as any,
      pilotState: "CA",
      consumerAuditPassed: true,
      indexAuditPassed: true,
      preflight: greenPreflight(),
    });
    expect(signals.migrationReconciled).toBe(false);
  });
});
