import { describe, it, expect, vi } from "vitest";

// Defensive: some transitively-imported modules touch firebase-admin at load.
// This test never exercises the live-agent path (CARA_EVAL_LIVE unset), so an
// inert admin mock is enough.
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: vi.fn() }) },
  firestore: Object.assign(() => ({ collection: vi.fn() }), { FieldValue: {} }),
}));

import { runEvals } from "./runner";

describe("evals/runner honesty (ch7 TDAD)", () => {
  it("skips agent-output cases instead of fake-passing, and totals reconcile", async () => {
    const r = await runEvals();
    // The old runner auto-passed every non-crisis/linter case → this must be > 0
    // now, proving those cases are no longer counted as silent wins.
    expect(r.skipped).toBeGreaterThan(0);
    // Every case is exactly one of passed / failed / skipped.
    expect(r.passed + r.failed + r.skipped).toBe(r.total);
    expect(r.failed).toBe(r.failures.length);
  });

  it("computes pass rate over EVALUATED cases only (skips neither inflate nor dilute)", async () => {
    const r = await runEvals();
    expect(r.evaluated).toBe(r.total - r.skipped);
    if (r.evaluated > 0) {
      expect(r.rate).toBeCloseTo(r.passed / r.evaluated, 10);
    }
  });

  it("actually evaluates the deterministic categories (crisis/linter) — the gate is not vacuous", async () => {
    const r = await runEvals();
    expect(r.evaluated).toBeGreaterThan(0);
  });
});

// 2026-11-09 (Wave 2): emergency cases are must-pass in the release gate.
import { evalGateVerdict } from "./runner";
describe("evalGateVerdict — the release gate", () => {
  it("one missed emergency blocks the release even at a 96% overall pass rate", () => {
    const v = evalGateVerdict({ evaluated: 25, rate: 24 / 25, failures: [{ id: "crisis_21", category: "crisis" }] });
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/must-pass/);
    expect(v.reason).toContain("crisis_21");
  });
  it("a non-emergency failure only blocks below 90%", () => {
    expect(evalGateVerdict({ evaluated: 100, rate: 0.95, failures: [{ id: "x", category: "tone" }] }).pass).toBe(true);
    expect(evalGateVerdict({ evaluated: 100, rate: 0.85, failures: [{ id: "x", category: "tone" }] }).pass).toBe(false);
  });
  it("nothing evaluated is never a pass", () => {
    expect(evalGateVerdict({ evaluated: 0, rate: 0, failures: [] }).pass).toBe(false);
  });
  it("all clear passes", () => {
    expect(evalGateVerdict({ evaluated: 33, rate: 1, failures: [] }).pass).toBe(true);
  });
});
