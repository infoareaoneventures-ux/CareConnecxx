// U13 metric-contract tests (plan 2026-07-22-002, R57/R63).
//
// The load-bearing invariant: EVERY declared metric shape is privacy-safe, and
// the registry stays in lock-step with the canary thresholds (no orphan
// signals, no metric a threshold forgot).

import { describe, it, expect } from "vitest";
import {
  CHILDCARE_METRICS,
  CHILDCARE_METRIC_SIGNALS,
  metricContractCoversAllThresholds,
} from "./childcareMetrics";
import { assertMetricPayloadChildSafe } from "./privacyAssertions";
import {
  CHILDCARE_CANARY_THRESHOLDS,
  CHILDCARE_ROLLOUT_HOLD_SIGNALS,
} from "../config/slaConstants";

describe("childcare metric contract", () => {
  it("every metric shape passes assertMetricPayloadChildSafe (no child PII, ever)", () => {
    for (const [signal, spec] of Object.entries(CHILDCARE_METRICS)) {
      expect(() => assertMetricPayloadChildSafe(spec.shape, signal), signal).not.toThrow();
    }
  });

  it("a metric shape carrying a child field would be REJECTED (guard is real)", () => {
    expect(() =>
      assertMetricPayloadChildSafe({ ...CHILDCARE_METRICS.enrollment_funnel_stall.shape, childName: "Mia" }, "leak"),
    ).toThrow(/prohibited key/);
  });

  it("registry ⇔ thresholds are in exact lock-step (no orphans either direction)", () => {
    expect(metricContractCoversAllThresholds()).toBe(true);
    expect(CHILDCARE_METRIC_SIGNALS.slice().sort()).toEqual(
      Object.keys(CHILDCARE_CANARY_THRESHOLDS).sort(),
    );
  });

  it("each spec's signal field matches its registry key and declares an owner", () => {
    for (const [key, spec] of Object.entries(CHILDCARE_METRICS)) {
      expect(spec.signal).toBe(key);
      expect(spec.owner.length).toBeGreaterThan(0);
    }
  });

  it("zero-tolerance metrics use amber:0/red:1 and all hold rollout", () => {
    for (const spec of Object.values(CHILDCARE_METRICS)) {
      if (!spec.zeroTolerance) continue;
      const th = CHILDCARE_CANARY_THRESHOLDS[spec.signal];
      expect(th.amber, spec.signal).toBe(0);
      expect(th.red, spec.signal).toBe(1);
      expect(CHILDCARE_ROLLOUT_HOLD_SIGNALS.has(spec.signal), spec.signal).toBe(true);
      expect(spec.holdsRollout, spec.signal).toBe(true);
    }
  });

  it("holdsRollout on every spec mirrors the slaConstants hold-signal set", () => {
    for (const spec of Object.values(CHILDCARE_METRICS)) {
      expect(spec.holdsRollout).toBe(CHILDCARE_ROLLOUT_HOLD_SIGNALS.has(spec.signal));
    }
  });
});
