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
