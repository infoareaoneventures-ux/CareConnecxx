import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver persistence net (webhooks.ts) mirror of absorbClientFields:
// conservative extraction, per-field validation, and never overwriting a
// field the model already saved.

const parseWithClaude = vi.fn(async (..._a: unknown[]) => "{}");
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: (...a: unknown[]) => parseWithClaude(...a),
}));

import { absorbCaregiverFields } from "../caregiverFieldAbsorber";

beforeEach(() => {
  parseWithClaude.mockReset();
  parseWithClaude.mockResolvedValue("{}");
});

describe("absorbCaregiverFields", () => {
  it("captures a front-loaded multi-field message", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({
      name: "Maria", city: "San Jose", yearsExperience: 6,
      specialties: ["dementia"], certifications: ["CNA", "CPR"],
      hourlyRate: 25, email: "Maria.G@Example.com",
      jobType: "part_time", availability: { days: ["Monday"], hours: "8am-4pm" },
    }));
    const out = await absorbCaregiverFields("I'm Maria in San Jose...", {});
    expect(out).toMatchObject({
      name: "Maria", city: "San Jose", yearsExperience: 6,
      specialties: ["dementia"], certifications: ["CNA", "CPR"],
      hourlyRate: 25, email: "maria.g@example.com", jobType: "part_time",
      availability: { days: ["Monday"], hours: "8am-4pm" },
    });
  });

  it("never overwrites an already-saved field (model-saved values win)", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ name: "Maria", city: "San Jose" }));
    const out = await absorbCaregiverFields("msg", { name: "Maria G." });
    expect(out).toEqual({ city: "San Jose" });
  });

  it("drops malformed values instead of persisting garbage", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({
      yearsExperience: "six",           // not a number
      hourlyRate: 900,                  // out of the 5..200 clamp
      email: "not-an-email",
      jobType: "weekends",              // not in the enum
      zipCode: "9513",                  // not 5 digits
      specialties: [42, ""],            // no valid strings
      availability: { days: [], hours: "" },
    }));
    const out = await absorbCaregiverFields("msg", {});
    expect(out).toEqual({});
  });

  it("returns {} on parser failure or non-JSON output (conservative)", async () => {
    parseWithClaude.mockResolvedValueOnce("none");
    expect(await absorbCaregiverFields("msg", {})).toEqual({});
    parseWithClaude.mockRejectedValueOnce(new Error("model down"));
    expect(await absorbCaregiverFields("msg", {})).toEqual({});
  });

  it("never absorbs a bio (family-visible; collected explicitly by the loop)", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ bio: "I love caregiving", name: "Maria" }));
    const out = await absorbCaregiverFields("msg", {});
    expect(out).toEqual({ name: "Maria" });
  });
});
