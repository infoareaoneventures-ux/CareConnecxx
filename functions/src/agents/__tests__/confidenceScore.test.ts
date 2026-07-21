import { describe, it, expect } from "vitest";
import { computeConfidenceScoreFromFields } from "../confidenceScore";

describe("computeConfidenceScoreFromFields (U2)", () => {
  it("scores a strong non-driver caregiver and lists signals", () => {
    const { score, signals } = computeConfidenceScoreFromFields({
      backgroundCheckStatus: "clear",
      approvedAt: new Date(Date.now() - 8 * 30 * 24 * 60 * 60 * 1000).toISOString(),
      rating: 4.5,
      verificationStatus: "approved",
      certifications: ["CNA", "CPR"],
    });
    // 35 (bgc) + ~10 (8mo tenure) + 18 (4.5★) + 15 (verified) + 10 (2 certs) ≈ 88
    expect(score).toBeGreaterThanOrEqual(80);
    expect(score).toBeLessThanOrEqual(95);
    expect(signals).toContain("background check cleared");
    expect(signals.some((s) => s.includes("★"))).toBe(true);
  });

  it("is cold-start neutral: a brand-new cleared caregiver gets no penalty", () => {
    const { score } = computeConfidenceScoreFromFields({ backgroundCheckStatus: "clear" });
    expect(score).toBe(35); // screening only; no negative, no fabricated history
  });

  it("gives zero (not negative) for a caregiver with no signals at all", () => {
    const { score, signals } = computeConfidenceScoreFromFields({
      pendingBackgroundCheck: true,
    });
    expect(score).toBe(0);
    expect(signals).toHaveLength(0);
  });

  it("does NOT penalize a non-driver for an absent MVR (full 35 from BGC)", () => {
    const nonDriver = computeConfidenceScoreFromFields({ backgroundCheckStatus: "clear" });
    expect(nonDriver.score).toBe(35);
    expect(nonDriver.signals).not.toContain("driving record cleared");
  });

  it("applies the MVR signal only when MVR was included AND cleared", () => {
    // Driver, MVR included + cleared → BGC 25 + MVR 10 = 35 (same ceiling as non-driver)
    const clearedDriver = computeConfidenceScoreFromFields({
      backgroundCheckStatus: "clear",
      backgroundCheckData: { mvrIncluded: true },
      isApprovedDriver: true,
    });
    expect(clearedDriver.score).toBe(35);
    expect(clearedDriver.signals).toContain("driving record cleared");

    // Driver, MVR included but not yet cleared → only BGC 25, not penalized below that
    const pendingMvrDriver = computeConfidenceScoreFromFields({
      backgroundCheckStatus: "clear",
      backgroundCheckData: { mvrIncluded: true },
      isApprovedDriver: false,
    });
    expect(pendingMvrDriver.score).toBe(25);
    expect(pendingMvrDriver.signals).not.toContain("driving record cleared");
  });

  it("never exceeds 100", () => {
    const { score } = computeConfidenceScoreFromFields({
      backgroundCheckStatus: "clear",
      backgroundCheckData: { mvrIncluded: true },
      isApprovedDriver: true,
      approvedAt: new Date(Date.now() - 24 * 30 * 24 * 60 * 60 * 1000).toISOString(),
      rating: 5,
      verificationStatus: "approved",
      certifications: ["CNA", "CPR", "HHA", "RN"],
    });
    expect(score).toBe(100);
  });

  it("ignores any legacy references data (references are not a signal)", () => {
    const withRefs = computeConfidenceScoreFromFields({
      backgroundCheckStatus: "clear",
      // references is intentionally not part of ConfidenceInput (the `as any`
      // cast below already admits it, so no @ts-expect-error is needed)
      references: [{ name: "X" }, { name: "Y" }, { name: "Z" }],
    } as any);
    const withoutRefs = computeConfidenceScoreFromFields({ backgroundCheckStatus: "clear" });
    expect(withRefs.score).toBe(withoutRefs.score);
  });

  it("caps tenure at 12 months and clamps out-of-range ratings", () => {
    // pendingBackgroundCheck suppresses the default-clear screening so we
    // isolate the tenure term.
    const a = computeConfidenceScoreFromFields({
      pendingBackgroundCheck: true,
      approvedAt: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const b = computeConfidenceScoreFromFields({
      pendingBackgroundCheck: true,
      approvedAt: new Date(Date.now() - 36 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(b.score).toBeGreaterThan(a.score); // more tenure scores higher
    expect(b.score).toBeLessThanOrEqual(15); // tenure alone is capped at 15

    const overRated = computeConfidenceScoreFromFields({ pendingBackgroundCheck: true, rating: 99 });
    expect(overRated.score).toBe(20); // clamped to the 20-pt rating ceiling
  });
});
