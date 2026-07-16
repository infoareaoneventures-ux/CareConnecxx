import { describe, it, expect } from "vitest";
import { computeRateRange, FALLBACK_RANGE } from "../marketRateRange";

// Pure percentile math + fallback rules. The Firestore-backed getMarketRateRange
// wrapper is deliberately thin (query → computeRateRange → cache, fail-soft to
// FALLBACK_RANGE) and is exercised by the callers' integration paths.

describe("computeRateRange", () => {
  it("returns null below the minimum sample size (fallback territory)", () => {
    expect(computeRateRange([])).toBeNull();
    expect(computeRateRange([20, 22, 25, 28])).toBeNull(); // 4 < 5
  });

  it("discards junk before counting the sample", () => {
    // 5 raw values but only 4 sane → still null
    expect(computeRateRange([20, 22, 25, 28, 999])).toBeNull();
    expect(computeRateRange([20, 22, 25, 28, NaN])).toBeNull();
    expect(computeRateRange([20, 22, 25, 28, 2])).toBeNull(); // below $10 sanity floor
  });

  it("computes a p25–p75 whole-dollar range from real rates", () => {
    const r = computeRateRange([18, 20, 22, 24, 25, 26, 28, 30, 32, 35]);
    expect(r).not.toBeNull();
    expect(r!.min).toBeGreaterThanOrEqual(18);
    expect(r!.max).toBeLessThanOrEqual(35);
    expect(r!.min).toBeLessThan(r!.max);
    expect(Number.isInteger(r!.min)).toBe(true);
    expect(Number.isInteger(r!.max)).toBe(true);
  });

  it("widens a degenerate spread so the hint never reads '$25–25/hr'", () => {
    const r = computeRateRange([25, 25, 25, 25, 25, 25]);
    expect(r).toEqual({ min: 25, max: 27 });
  });

  it("is unfazed by unsorted input", () => {
    const sorted   = computeRateRange([18, 20, 22, 25, 30]);
    const shuffled = computeRateRange([30, 18, 25, 20, 22]);
    expect(shuffled).toEqual(sorted);
  });

  it("keeps the documented static fallback at the original $18–28", () => {
    expect(FALLBACK_RANGE).toEqual({ min: 18, max: 28 });
  });
});
