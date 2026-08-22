import { describe, expect, it } from "vitest";
import {
  availabilityOverlap,
  hasValidTransportDocs,
  haversineDistanceMiles,
  scoreAndRankCaregivers,
  skillsOverlap,
} from "../caregiverMatchScoring";

describe("haversineDistanceMiles", () => {
  it("returns ~0 for the same point", () => {
    expect(haversineDistanceMiles(37.3382, -121.8863, 37.3382, -121.8863)).toBeCloseTo(0, 5);
  });

  it("returns a plausible distance between San Jose and San Francisco", () => {
    const dist = haversineDistanceMiles(37.3382, -121.8863, 37.7749, -122.4194);
    expect(dist).toBeGreaterThan(40);
    expect(dist).toBeLessThan(55);
  });
});

describe("skillsOverlap", () => {
  it("returns 0 when either side is empty", () => {
    expect(skillsOverlap([], ["companionship"])).toBe(0);
    expect(skillsOverlap(["Companionship"], [])).toBe(0);
  });

  it("returns the fraction of needs matched (case-insensitive, substring)", () => {
    expect(skillsOverlap(["Companionship", "Dementia Care"], ["companionship", "mobility"])).toBe(0.5);
  });

  it("returns 1 when every need is covered", () => {
    expect(skillsOverlap(["Companionship", "Dementia Care"], ["companionship"])).toBe(1);
  });
});

describe("availabilityOverlap", () => {
  it("returns 0 when the client schedule is missing", () => {
    expect(availabilityOverlap({ monday: ["9-5"] }, null)).toBe(0);
  });

  it("scores array-form client schedule against WeeklySchedule caregiver availability", () => {
    const score = availabilityOverlap(
      { monday: ["9-5"], wednesday: ["9-5"] },
      ["monday", "tuesday"],
    );
    expect(score).toBe(0.5);
  });

  it("scores object-form client schedule against array-form caregiver availability", () => {
    const score = availabilityOverlap(
      ["monday", "wednesday"],
      { monday: ["9-5"], tuesday: [] },
    );
    expect(score).toBe(1);
  });
});

describe("hasValidTransportDocs", () => {
  const approvedDocs = {
    driversLicense: { status: "approved" },
    insurance: { status: "approved" },
    registration: { status: "approved" },
  };

  it("false when Transportation isn't an offered service", () => {
    expect(hasValidTransportDocs({ skills: ["Companionship"], documents: approvedDocs })).toBe(false);
  });

  it("false when a document is missing or not approved", () => {
    expect(hasValidTransportDocs({
      skills: ["Transportation"],
      documents: { ...approvedDocs, insurance: { status: "pending" } },
    })).toBe(false);
  });

  it("true when Transportation is offered and all docs are approved, unexpired", () => {
    expect(hasValidTransportDocs({ skills: ["Transportation"], documents: approvedDocs })).toBe(true);
  });

  it("false when a document is expired", () => {
    expect(hasValidTransportDocs({
      skills: ["Transportation"],
      documents: { ...approvedDocs, registration: { status: "approved", expirationDate: "2000-01-01" } },
    })).toBe(false);
  });
});

describe("scoreAndRankCaregivers", () => {
  const bookable = { onboardingStatus: "profile_complete", verificationStatus: "approved" };
  const clientLocations = [{ lat: 37.3382, lng: -121.8863 }]; // San Jose

  it("excludes non-bookable caregivers", () => {
    const result = scoreAndRankCaregivers(
      [{ id: "a", data: { ...bookable, verificationStatus: "pending", lat: 37.34, lng: -121.89 } }],
      { clientLocations, clientCareNeeds: [], clientSchedule: null, needsTransportation: false },
    );
    expect(result).toEqual([]);
  });

  it("hard-filters out-of-range candidates when applyHardFilters is true", () => {
    const near = { id: "near", data: { ...bookable, lat: 37.34, lng: -121.89, rating: 4 } };
    const far  = { id: "far",  data: { ...bookable, lat: 40.7128, lng: -74.0060, rating: 5 } }; // NYC
    const result = scoreAndRankCaregivers([near, far], {
      clientLocations, clientCareNeeds: [], clientSchedule: null, needsTransportation: false,
      maxDistance: 25, applyHardFilters: true,
    });
    expect(result.map(c => c.id)).toEqual(["near"]);
  });

  it("keeps out-of-range candidates when applyHardFilters is false (backup pass)", () => {
    const near = { id: "near", data: { ...bookable, lat: 37.34, lng: -121.89, rating: 4 } };
    const far  = { id: "far",  data: { ...bookable, lat: 40.7128, lng: -74.0060, rating: 5 } };
    const result = scoreAndRankCaregivers([near, far], {
      clientLocations, clientCareNeeds: [], clientSchedule: null, needsTransportation: false,
      applyHardFilters: false,
    });
    expect(result.map(c => c.id).sort()).toEqual(["far", "near"]);
  });

  it("excludes caregivers outside their own serviceRadius even within maxDistance", () => {
    const cg = { id: "cg", data: { ...bookable, lat: 37.5, lng: -122.0, serviceRadius: 5 } };
    const result = scoreAndRankCaregivers([cg], {
      clientLocations, clientCareNeeds: [], clientSchedule: null, needsTransportation: false,
      maxDistance: 25, applyHardFilters: true,
    });
    expect(result).toEqual([]);
  });

  it("requires valid transport docs when needsTransportation is true", () => {
    const noDocs = { id: "no-docs", data: { ...bookable, lat: 37.34, lng: -121.89, skills: ["Transportation"] } };
    const result = scoreAndRankCaregivers([noDocs], {
      clientLocations, clientCareNeeds: [], clientSchedule: null, needsTransportation: true,
      applyHardFilters: true,
    });
    expect(result).toEqual([]);
  });

  it("sorts by skills overlap, then availability overlap, then rating, then distance", () => {
    const bestSkills = { id: "best-skills", data: { ...bookable, lat: 37.34, lng: -121.89, skills: ["Dementia Care"], rating: 3 } };
    const bestRating = { id: "best-rating", data: { ...bookable, lat: 37.34, lng: -121.89, skills: [], rating: 5 } };
    const result = scoreAndRankCaregivers([bestRating, bestSkills], {
      clientLocations, clientCareNeeds: ["dementia care"], clientSchedule: null, needsTransportation: false,
      applyHardFilters: false,
    });
    expect(result.map(c => c.id)).toEqual(["best-skills", "best-rating"]);
  });

  it("respects the limit", () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({
      id: `cg-${i}`, data: { ...bookable, lat: 37.34, lng: -121.89, rating: i },
    }));
    const result = scoreAndRankCaregivers(docs, {
      clientLocations, clientCareNeeds: [], clientSchedule: null, needsTransportation: false,
      applyHardFilters: false, limit: 5,
    });
    expect(result).toHaveLength(5);
  });
});
