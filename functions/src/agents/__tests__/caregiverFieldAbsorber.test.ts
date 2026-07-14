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

  it("captures the optional profile-parity extras when volunteered (2g)", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({
      gender: "female", languages: ["English", "Spanish"], canDrive: true,
    }));
    const out = await absorbCaregiverFields("I'm a woman, I speak English and Spanish, and yes I drive", {});
    expect(out).toEqual({ gender: "female", languages: ["English", "Spanish"], canDrive: true });
  });

  it("captures canDrive:false (a definite 'no', not a skip)", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ canDrive: false }));
    const out = await absorbCaregiverFields("no, I don't drive", {});
    expect(out).toEqual({ canDrive: false });
  });

  it("omits profile extras that aren't clearly stated", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ gender: "  ", languages: [], canDrive: "maybe" }));
    const out = await absorbCaregiverFields("msg", {});
    expect(out).toEqual({});
  });

  it("canonicalizes freshly-absorbed specialties into skills/services (keeps raw specialties)", async () => {
    parseWithClaude
      .mockResolvedValueOnce(JSON.stringify({ specialties: ["memory care", "meal prep"] })) // extraction
      .mockResolvedValueOnce(JSON.stringify(["Dementia / Memory Care", "Meal Preparation"])); // canonicalization
    const out = await absorbCaregiverFields("msg", {});
    expect(out.specialties).toEqual(["memory care", "meal prep"]);
    expect(out.skills).toEqual(["Dementia / Memory Care", "Meal Preparation"]);
    expect(out.services).toEqual(["Dementia / Memory Care", "Meal Preparation"]);
  });

  it("does not touch skills when the model already saved them", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ specialties: ["dementia"] }));
    const out = await absorbCaregiverFields("msg", { skills: ["Companionship"] });
    expect(out.specialties).toEqual(["dementia"]);
    expect(out.skills).toBeUndefined();
    expect(out.services).toBeUndefined();
  });
});
