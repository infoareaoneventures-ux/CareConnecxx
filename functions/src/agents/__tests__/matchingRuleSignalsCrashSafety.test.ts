import { describe, it, expect, vi } from "vitest";

// Transitive imports call admin.firestore() at module load, so the module won't
// import without a firebase-admin stub — this test exercises only the pure
// computeRuleSignals function, the stub just lets the module load.
vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: () => ({ where: () => ({}), doc: () => ({}), add: () => {} }) });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import { computeRuleSignals, type CaregiverCandidate } from "../matchingAgent";

// 2026-09-07: a live "matching_run_failed" alert ("...toLowerCase is not a
// function") crashed every attempt to find caregivers for a real family, even
// though the exact same caregivers were visible and bookable on the website.
// computeRuleSignals assumed caregiver.city / caregiver.availability.hours /
// caregiver.gender / intake.city / intake.timeOfDay / intake.genderPreference
// were always plain strings — publicCaregiverProfiles passes several of these
// through verbatim from whatever shape the raw caregiver doc actually has, and
// the website's own scoring (caregiverMatchScoring.ts) already treats
// availability as `unknown` rather than assuming a `{hours: string}` shape.
// These tests lock in that a malformed (non-string) value on any one of these
// fields degrades that one signal instead of throwing and failing the whole
// matching pass for every candidate.

const BASE_CAREGIVER: CaregiverCandidate = {
  id: "cg1",
  name: "Basra Yousuf",
  hourlyRate: 24,
  specialties: ["Companionship"],
  city: "San Jose",
  yearsExperience: 12,
};

const BASE_INTAKE = { city: "San Jose", zipCode: "95130" };

describe("computeRuleSignals — never throws on malformed real-world data", () => {
  it("does not throw when availability.hours is not a string", () => {
    const caregiver: CaregiverCandidate = {
      ...BASE_CAREGIVER,
      availability: { days: ["Mon"], hours: ["9am-5pm"] as unknown as string },
    };
    expect(() => computeRuleSignals(caregiver, BASE_INTAKE)).not.toThrow();
  });

  it("does not throw when the caregiver's city is not a string", () => {
    const caregiver: CaregiverCandidate = { ...BASE_CAREGIVER, city: { name: "San Jose" } as unknown as string };
    expect(() => computeRuleSignals(caregiver, BASE_INTAKE)).not.toThrow();
  });

  it("does not throw when the caregiver's gender is not a string", () => {
    const caregiver: CaregiverCandidate = { ...BASE_CAREGIVER, gender: 1 as unknown as string };
    const intake = { ...BASE_INTAKE, genderPreference: "female" };
    expect(() => computeRuleSignals(caregiver, intake)).not.toThrow();
  });

  it("does not throw when intake.city / intake.timeOfDay / intake.genderPreference are not strings", () => {
    const intake = {
      city: { name: "San Jose" },
      zipCode: 95130,
      timeOfDay: ["morning"],
      genderPreference: { value: "female" },
    };
    expect(() => computeRuleSignals(BASE_CAREGIVER, intake as any)).not.toThrow();
  });

  it("still produces a usable score when every risky field is malformed at once", () => {
    const caregiver: CaregiverCandidate = {
      ...BASE_CAREGIVER,
      city: null as unknown as string,
      gender: {} as unknown as string,
      availability: { days: [], hours: 42 as unknown as string },
    };
    const intake = { city: [], zipCode: null, timeOfDay: {}, genderPreference: [] };
    const { ruleScore, signals } = computeRuleSignals(caregiver, intake as any);
    expect(Number.isFinite(ruleScore)).toBe(true);
    expect(Number.isFinite(signals.distanceMiles ?? 0)).toBe(true);
  });
});
