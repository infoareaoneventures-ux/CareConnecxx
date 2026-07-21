import { describe, expect, it } from "vitest";

import { scoreCapability, summarizeScorecard, type CapabilityTrialResult } from "./intelligenceScorecard";

const trial = (fixtureId: string, status: CapabilityTrialResult["status"], reason?: string): CapabilityTrialResult =>
  ({ capability: "tool_selection", fixtureId, status, reason });

const spec = { minEvaluatedTrials: 5, passThreshold: 0.9 };

describe("scoreCapability (U0/R48/AE18 — honest coverage)", () => {
  it("skipped trials never count as passes and never enter the denominator", () => {
    const row = scoreCapability([
      trial("f1", "passed"), trial("f2", "passed"), trial("f3", "passed"),
      trial("f4", "passed"), trial("f5", "passed"),
      trial("f6", "skipped", "no live provider"), trial("f7", "skipped", "flag off"),
    ], spec);
    expect(row.passRate).toBe(1);
    expect(row.evaluatedTrials).toBe(5);
    expect(row.skippedTrials).toBe(2);
    // 5 of 7 fixtures evaluated → coverage below the default 100% floor → not green.
    expect(row.coverage).toBeCloseTo(5 / 7);
    expect(row.gate).toBe("insufficient");
  });

  it("zero evaluated trials is insufficient, never a 100% pass", () => {
    const row = scoreCapability([trial("f1", "skipped", "x"), trial("f2", "skipped", "x")], spec);
    expect(row.passRate).toBeNull();
    expect(row.gate).toBe("insufficient");
  });

  it("retries of one fixture do not inflate the fixture count", () => {
    const row = scoreCapability([
      trial("f1", "failed"), trial("f1", "passed"), trial("f1", "passed"),
      trial("f1", "passed"), trial("f1", "passed"),
    ], spec);
    expect(row.fixtures).toBe(1);
    expect(row.evaluatedTrials).toBe(5);
    expect(row.passRate).toBeCloseTo(0.8);
    expect(row.gate).toBe("red"); // 0.8 < 0.9
  });

  it("goes green only with enough evaluated trials, full coverage, and pass rate over threshold", () => {
    const row = scoreCapability(
      Array.from({ length: 10 }, (_, i) => trial(`f${i}`, i === 0 ? "failed" : "passed")),
      spec,
    );
    expect(row.passRate).toBeCloseTo(0.9);
    expect(row.coverage).toBe(1);
    expect(row.gate).toBe("green");
  });

  it("a 100% threshold with any failure is red even when rounding would hide it", () => {
    const results = Array.from({ length: 200 }, (_, i) => trial(`f${i}`, i === 0 ? "failed" : "passed"));
    const row = scoreCapability(results, { minEvaluatedTrials: 5, passThreshold: 1 });
    expect(row.gate).toBe("red");
  });

  it("below minEvaluatedTrials is insufficient even at 100% pass", () => {
    const row = scoreCapability([trial("f1", "passed"), trial("f2", "passed")], spec);
    expect(row.gate).toBe("insufficient");
  });

  it("rejects mixed-capability input instead of silently merging", () => {
    expect(() => scoreCapability([
      trial("f1", "passed"),
      { capability: "other", fixtureId: "f2", status: "passed" },
    ], spec)).toThrow(/multiple capabilities/);
  });
});

describe("summarizeScorecard", () => {
  it("allGatesGreen requires every row green and at least one row", () => {
    const green = scoreCapability(
      Array.from({ length: 6 }, (_, i) => trial(`f${i}`, "passed")), spec);
    const insufficient = scoreCapability([trial("f1", "skipped", "x")], spec);

    expect(summarizeScorecard([]).allGatesGreen).toBe(false);
    expect(summarizeScorecard([green]).allGatesGreen).toBe(true);
    const mixed = summarizeScorecard([green, insufficient]);
    expect(mixed.allGatesGreen).toBe(false);
    expect(mixed.insufficientRows).toBe(1);
  });
});
