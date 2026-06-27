import { describe, it, expect } from "vitest";
import { buildLayFallbackSummary } from "../shiftSummaryFallback";

describe("buildLayFallbackSummary (U3 PHI-safe fallback)", () => {
  it("summarizes a normal visit in lay terms with no concerns", () => {
    const out = buildLayFallbackSummary({
      seniorName: "Dorothy",
      cgFirstName: "Maria",
      mood: "cheerful",
      appetite: "good",
      activities: ["a walk", "lunch"],
    });
    expect(out).toContain("Maria just finished their visit with Dorothy");
    expect(out).toContain("cheerful mood");
    expect(out).toContain("No concerns to flag.");
  });

  it("does NOT echo raw clinical observations verbatim (PHI minimization)", () => {
    const clinical = "BP 150/95, gave 10mg lisinopril and 500mg metformin, loose stool x2";
    const out = buildLayFallbackSummary({
      seniorName: "Dorothy",
      cgFirstName: "Maria",
      observations: clinical,
    });
    expect(out).not.toContain(clinical);
    expect(out).not.toMatch(/lisinopril|metformin|150\/95|stool/i);
    // Instead it flags that there are details to follow up on.
    expect(out).toMatch(/noted a couple of details|reply here/i);
  });

  it("flags unplanned requests by name (non-clinical, family-relevant)", () => {
    const out = buildLayFallbackSummary({
      seniorName: "Dorothy",
      cgFirstName: "Maria",
      unplannedActivities: ["call her sister", "water the plants"],
    });
    expect(out).toContain("also asked for: call her sister, water the plants");
  });

  it("handles an empty entry without crashing", () => {
    const out = buildLayFallbackSummary({ seniorName: "your loved one", cgFirstName: "Maria" });
    expect(out).toContain("Maria just finished their visit with your loved one");
    expect(out).toContain("No concerns to flag.");
  });
});
