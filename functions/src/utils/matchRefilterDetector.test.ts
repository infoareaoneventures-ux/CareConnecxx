import { describe, it, expect, vi, beforeEach } from "vitest";

const quickComplete = vi.fn();
vi.mock("./openaiClient", () => ({
  quickComplete: (...args: unknown[]) => quickComplete(...args),
}));

import { detectMatchRefilter } from "./matchRefilterDetector";

describe("detectMatchRefilter", () => {
  beforeEach(() => quickComplete.mockReset());

  it("returns null for very short text without calling LLM", async () => {
    expect(await detectMatchRefilter("1")).toBeNull();
    expect(await detectMatchRefilter("ok")).toBeNull();
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("returns null when LLM says isRefilter=false", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({ isRefilter: false }));
    expect(await detectMatchRefilter("what's #2's rate?")).toBeNull();
  });

  it("extracts a rate refilter", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({
      isRefilter: true,
      rate: { direction: "lower" },
      summary: "cheaper caregivers",
    }));
    const result = await detectMatchRefilter("show me cheaper ones");
    expect(result).not.toBeNull();
    expect(result?.rate?.direction).toBe("lower");
    expect(result?.summary).toBe("cheaper caregivers");
  });

  it("extracts a skills refilter", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({
      isRefilter: true,
      skills: ["dementia", "mobility"],
      summary: "caregivers with dementia and mobility experience",
    }));
    const result = await detectMatchRefilter("anyone who can handle dementia and mobility?");
    expect(result?.skills).toEqual(["dementia", "mobility"]);
  });

  it("extracts language preference", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({
      isRefilter: true,
      languages: ["spanish"],
      summary: "Spanish-speaking caregivers",
    }));
    const result = await detectMatchRefilter("any Spanish-speaking caregivers?");
    expect(result?.languages).toEqual(["spanish"]);
  });

  it("strips markdown fences", async () => {
    quickComplete.mockResolvedValue("```json\n" + JSON.stringify({
      isRefilter: true,
      rate: { direction: "lower" },
      summary: "cheaper",
    }) + "\n```");
    const result = await detectMatchRefilter("cheaper please");
    expect(result?.rate?.direction).toBe("lower");
  });

  it("returns null when isRefilter=true but no actionable changes", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({ isRefilter: true, summary: "vague" }));
    const result = await detectMatchRefilter("hmm, not sure");
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    quickComplete.mockResolvedValue("not json");
    expect(await detectMatchRefilter("cheaper please")).toBeNull();
  });

  it("returns null when LLM returns an empty response (treats as no refilter)", async () => {
    quickComplete.mockResolvedValue("");
    expect(await detectMatchRefilter("cheaper please")).toBeNull();
  });

  it("clamps summary to 200 chars", async () => {
    const longSummary = "x".repeat(500);
    quickComplete.mockResolvedValue(JSON.stringify({
      isRefilter: true,
      rate: { direction: "lower" },
      summary: longSummary,
    }));
    const result = await detectMatchRefilter("cheaper please");
    expect(result?.summary.length).toBeLessThanOrEqual(200);
  });
});
