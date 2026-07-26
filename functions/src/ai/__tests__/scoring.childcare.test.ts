// Childcare scoring path (plan 2026-07-22-002 U6 — R34/R45) + senior
// characterization pin.
//
// Scenarios: childcare scorer consumes ONLY approved features; cross-vertical
// reputation / senior boosts structurally cannot move the score; sanitized
// allowlisted explanations only (no restricted fields); senior scoreCaregiver
// behavior is characterization-pinned (byte-identical to pre-U6).

import { describe, it, expect } from "vitest";
import {
  scoreCaregiver,
  scoreChildcareCandidate,
  CHILDCARE_APPROVED_SCORING_FEATURES,
  type ChildcareScoringInput,
} from "../scoring";

// ── Senior characterization (parity pin — scoreCaregiver untouched by U6) ────

describe("senior scoreCaregiver characterization (U6 parity pin)", () => {
  it("pins the full scored shape for a representative senior candidate", () => {
    const result = scoreCaregiver({
      caregiverId: "cg-senior-a",
      caregiverSkills: ["dementia", "meal prep"],
      clientNeeds: ["dementia", "mobility"],
      distanceMiles: 4,
      availabilityOverlap: 0.8,
      rating: 4.6,
      yearsExperience: 6,
      personalBoost: 0,
    });
    expect(result).toEqual({
      caregiverId: "cg-senior-a",
      score: 46,
      reasons: [
        "Skilled in: dementia",
        "Close to you (4 mi)",
        "Available during your care hours",
        "Highly rated (4.6★)",
      ],
      redFlags: [],
      confidence: "low",
      source: "fallback",
      semanticScore: 0,
      hardSkillsScore: 10,
      distanceScore: 20,
      availabilityScore: 8,
      ratingScore: 5,
      experienceScore: 3,
    });
  });

  it("pins the missing-critical-need penalty and red flag", () => {
    const result = scoreCaregiver({
      caregiverId: "cg-senior-b",
      caregiverSkills: ["companionship"],
      clientNeeds: ["hospice"],
      distanceMiles: 28,
      availabilityOverlap: 0.2,
      rating: 3.8,
      yearsExperience: 1,
      personalBoost: 0,
    });
    expect(result.score).toBe(0);
    expect(result.redFlags).toEqual([
      "No hospice experience listed",
      "28 miles away",
      "Below-average rating (3.8★)",
      "Limited schedule overlap",
    ]);
    expect(result.confidence).toBe("low");
  });

  it("pins that personalBoost still moves the SENIOR score (the boost childcare must not have)", () => {
    const base = {
      caregiverId: "cg-senior-c",
      caregiverSkills: ["dementia"],
      clientNeeds: ["dementia"],
      distanceMiles: 4,
      availabilityOverlap: 1,
      rating: 5,
      yearsExperience: 10,
    };
    const without = scoreCaregiver({ ...base, personalBoost: 0 });
    const withBoost = scoreCaregiver({ ...base, personalBoost: 5 });
    expect(withBoost.score).toBe(without.score + 5);
  });
});

// ── Childcare scorer (approved features only) ────────────────────────────────

const FULL_FIT: ChildcareScoringInput = {
  caregiverId: "cg-child-1",
  jobAgeBands: ["toddler", "preschool"],
  providerAgeBands: ["toddler", "preschool", "school_age"],
  jobCategories: ["babysitting"],
  providerServices: ["babysitting", "date_night_care"],
  distanceMiles: 3,
  availabilityOverlap: 0.9,
  yearsChildcareExperience: 5,
  childcareRating: 4.8,
};

describe("scoreChildcareCandidate (U6 — approved features only)", () => {
  it("scores a fully fitting candidate high with allowlisted reasons only", () => {
    const result = scoreChildcareCandidate(FULL_FIT);
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.confidence).toBe("high");
    expect(result.reasons).toEqual([
      "Supports all requested age groups",
      "Offers all requested care types",
      "Close to the job area",
      "Available during the requested hours",
    ]);
  });

  it("degrades coverage when a job band/category is not offered", () => {
    const partial = scoreChildcareCandidate({
      ...FULL_FIT,
      providerAgeBands: ["toddler"], // preschool uncovered
      providerServices: [], // category uncovered
    });
    const full = scoreChildcareCandidate(FULL_FIT);
    expect(partial.score).toBeLessThan(full.score);
    expect(partial.reasons).not.toContain("Supports all requested age groups");
    expect(partial.reasons).not.toContain("Offers all requested care types");
  });

  it("R45: cross-vertical reputation / senior boosts structurally cannot move the score", () => {
    const clean = scoreChildcareCandidate(FULL_FIT);
    // Every senior-side boost/rating channel, smuggled in as extra keys:
    const smuggled = scoreChildcareCandidate({
      ...FULL_FIT,
      personalBoost: 5,
      reputationBoost: 6,
      rating: 5,
      hireCount: 40,
      score: 99,
    } as unknown as ChildcareScoringInput);
    expect(smuggled).toEqual(clean);
  });

  it("declares its approved feature list (no reputation feature exists)", () => {
    expect(CHILDCARE_APPROVED_SCORING_FEATURES).toEqual([
      "ageBandCoverage",
      "categoryCoverage",
      "distanceMiles",
      "availabilityOverlap",
      "yearsChildcareExperience",
      "childcareRating",
    ]);
    expect(CHILDCARE_APPROVED_SCORING_FEATURES).not.toContain("reputationBoost");
    expect(CHILDCARE_APPROVED_SCORING_FEATURES).not.toContain("personalBoost");
  });

  it("explanations never carry restricted content — fixed allowlisted phrases only", () => {
    const results = [
      scoreChildcareCandidate(FULL_FIT),
      scoreChildcareCandidate({ ...FULL_FIT, distanceMiles: undefined, availabilityOverlap: undefined }),
      scoreChildcareCandidate({
        ...FULL_FIT,
        jobAgeBands: [],
        jobCategories: [],
        yearsChildcareExperience: 0,
        childcareRating: 0,
        distanceMiles: 20,
        availabilityOverlap: 0.1,
      }),
    ];
    const allowlist = new Set([
      "Supports all requested age groups",
      "Offers all requested care types",
      "Close to the job area",
      "Available during the requested hours",
      "5+ years of childcare experience",
      "Highly rated for childcare",
      "Eligible childcare provider in your area",
    ]);
    for (const r of results) {
      expect(r.reasons.length).toBeGreaterThan(0);
      for (const reason of r.reasons) {
        expect(allowlist.has(reason), `non-allowlisted explanation: "${reason}"`).toBe(true);
      }
    }
  });

  it("missing optional data scores neutral, never throws (empty ≠ error)", () => {
    const r = scoreChildcareCandidate({
      caregiverId: "cg-min",
      jobAgeBands: [],
      providerAgeBands: [],
      jobCategories: [],
      providerServices: [],
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.caregiverId).toBe("cg-min");
  });
});
