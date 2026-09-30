import { describe, it, expect } from "vitest";
import { availabilityOverlap } from "../scoring";

// ai/scoring.ts availabilityOverlap: the caregiver's weeklyAvailability slots
// (the Calendar page's grid, canonical slots from blocksToWeeklySlots) against
// the family's schedule blocks.

describe("availabilityOverlap — the site's overnight slot crosses midnight", () => {
  it("a caregiver stored 23:00–06:00 (the site's overnight block) overlaps a family's overnight need", () => {
    const caregiver = { monday: [{ start: "23:00", end: "06:00" }] };
    const family = { monday: ["overnight"] };
    const score = availabilityOverlap(caregiver, family);
    expect(score).toBeGreaterThan(0);
  });
  it("a plain daytime slot still scores as before, and no overlap is 0", () => {
    expect(availabilityOverlap({ monday: [{ start: "06:00", end: "12:00" }] }, { monday: ["morning"] })).toBe(1);
    expect(availabilityOverlap({ monday: [{ start: "06:00", end: "12:00" }] }, { monday: ["overnight"] })).toBe(0);
  });
});
