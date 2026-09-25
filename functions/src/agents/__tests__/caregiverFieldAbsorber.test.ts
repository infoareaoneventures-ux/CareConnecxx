import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver persistence net (webhooks.ts) mirror of absorbClientFields:
// conservative extraction, per-field validation, and never overwriting a
// field the model already saved.

const parseWithClaude = vi.fn(async (..._a: unknown[]) => "{}");
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: (...a: unknown[]) => parseWithClaude(...a),
}));

import { absorbCaregiverFields, absorbCaregiverProfileUpdate } from "../caregiverFieldAbsorber";

beforeEach(() => {
  parseWithClaude.mockReset();
  parseWithClaude.mockResolvedValue("{}");
});

describe("absorbCaregiverFields", () => {
  it("captures a front-loaded multi-field message", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({
      name: "Maria", street: "12 Oak St", city: "San Jose", state: "ca", zipCode: "95134", yearsExperience: 6,
      specialties: ["dementia"], certifications: ["CNA", "CPR"],
      hourlyRate: 25, serviceRadius: 12, email: "Maria.G@Example.com",
      jobType: "part_time", availability: { days: ["Monday"], hours: "8am-4pm" },
    }));
    const out = await absorbCaregiverFields("I'm Maria in San Jose...", {});
    // Wizard shapes: experience bucketed, travel distance snapped to the nearest option,
    // state upper-cased; certifications are NOT a wizard field and are never absorbed.
    expect(out).toMatchObject({
      name: "Maria", street: "12 Oak St", city: "San Jose", state: "CA", zipCode: "95134", yearsExperience: "5-10 years",
      specialties: ["dementia"],
      hourlyRate: 25, serviceRadius: 10, email: "maria.g@example.com", jobType: "part_time",
      availability: { days: ["Monday"], hours: "8am-4pm" },
    });
    expect(out).not.toHaveProperty("certifications");
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

  it("ignores volunteered extras the site's wizard never asks (gender, languages, driving) — 2026-09-25", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({
      gender: "female", languages: ["English", "Spanish"], canDrive: true,
    }));
    const out = await absorbCaregiverFields("I'm a woman, I speak English and Spanish, and yes I drive", {});
    expect(out).toEqual({});
  });

  it("drops a street with no house number (a city or neighbourhood misread as a street)", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ street: "Willow Glen", state: "California" }));
    const out = await absorbCaregiverFields("I'm over in Willow Glen, California", {});
    expect(out).toEqual({});
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

// Gate-step profile updates (2026-07-15): a caregiver who volunteers new info
// AFTER collection ("I can do transportation as well" while parked at the
// photo gate) must have it merged ADDITIVELY — the collection-mode absorber
// refuses to touch filled fields, which silently dropped the addition (seen
// live 07-14, Hamse).
describe("absorbCaregiverProfileUpdate (gate-step additions)", () => {
  const HAMSE = {
    name: "Hamse",
    specialties: ["Companionship", "dementia"],
    skills:      ["Dementia / Memory Care", "Companionship"],
    services:    ["Dementia / Memory Care", "Companionship"],
  };

  it("adds a volunteered service to already-filled specialties/skills/services", async () => {
    parseWithClaude
      .mockResolvedValueOnce(JSON.stringify({ specialties: ["transportation"] }))  // collection pass (dropped: filled)
      .mockResolvedValueOnce(JSON.stringify({ specialties: ["transportation"] })); // update pass (additive)
    const out = await absorbCaregiverProfileUpdate("I can do transportation as well", HAMSE);
    expect(out.specialties).toEqual(["Companionship", "dementia", "transportation"]);
    // synonym map: "transportation" → canonical "Transportation", unioned in
    expect(out.services).toEqual(["Dementia / Memory Care", "Companionship", "Transportation"]);
    expect(out.skills).toEqual(["Dementia / Memory Care", "Companionship", "Transportation"]);
  });

  it("returns {} when the message adds nothing new (case-insensitive dupe)", async () => {
    parseWithClaude
      .mockResolvedValueOnce("{}")
      .mockResolvedValueOnce(JSON.stringify({ specialties: ["companionship"] }));
    const out = await absorbCaregiverProfileUpdate("I also do companionship", HAMSE);
    expect(out).toEqual({});
  });

  it("never overwrites a filled scalar from a casual mention", async () => {
    parseWithClaude
      .mockResolvedValueOnce(JSON.stringify({ hourlyRate: 30 }))
      .mockResolvedValueOnce("{}");
    const out = await absorbCaregiverProfileUpdate("my neighbor charges $30 an hour", { hourlyRate: 27 });
    expect(out).toEqual({});
  });

  it("merges volunteered availability days additively (hours kept)", async () => {
    parseWithClaude
      .mockResolvedValueOnce("{}")
      .mockResolvedValueOnce(JSON.stringify({ availabilityDays: ["Friday"] }));
    const out = await absorbCaregiverProfileUpdate("I'm also free Fridays",
      { availability: { days: ["Monday"], hours: "mornings" } });
    expect(out.availability).toEqual({ days: ["Monday", "Friday"], hours: "mornings" });
  });
});
