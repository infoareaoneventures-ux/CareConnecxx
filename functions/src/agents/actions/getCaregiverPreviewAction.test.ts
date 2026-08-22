import { describe, expect, it, vi } from "vitest";

// Mutable per-test fixtures the mocked Firestore reads from. `localDocs`
// backs the primary city-scoped query (`.where("city", ...)`); `widerDocs`
// backs the widened active-only fallback query.
let localDocs: Array<{ data: () => Record<string, unknown> }> = [];
let widerDocs: Array<{ data: () => Record<string, unknown> }> = [];

vi.mock("firebase-admin", () => {
  // Chainable query-builder mock: .where() can be called an arbitrary number of
  // times (each call just returns the same shape again, recording nothing since
  // the tests only care about the total filter count). The action's "local"
  // query chains 3 .where()s (onboardingStatus, verificationStatus, city) before
  // .limit().get(); its "wider" fallback chains only 2 (no city filter). Decide
  // which fixture to serve based on the accumulated where() count at the point
  // .limit().get() resolves.
  const buildQuery = (whereCount: number): any => ({
    where: () => buildQuery(whereCount + 1),
    limit: () => ({
      get: async () => {
        const docs = whereCount >= 3 ? localDocs : widerDocs;
        return { empty: docs.length === 0, docs };
      },
    }),
  });
  const firestore = () => ({
    collection: () => buildQuery(0),
  });
  return {
    __esModule: true,
    default: { firestore },
    firestore,
  };
});

import {
  buildCaregiverPreviewResult,
  getCaregiverPreviewCaraAction,
  isSeededCaregiver,
} from "./getCaregiverPreviewAction";

function toDoc(data: Record<string, unknown>) {
  return { data: () => data };
}

const REAL_CAREGIVER = {
  name: "Maria Santos",
  city: "San Jose",
  yearsExperience: 8,
  specialties: ["Dementia Care"],
};

const SEEDED_CAREGIVER = {
  __seedTag: "cara-test",
  name: "Fake Test Caregiver",
  city: "San Jose",
  yearsExperience: 99,
  specialties: ["Companionship"],
};

const ctx = { caller: "sms_agent" as const, role: "client" as const };

describe("getCaregiverPreviewAction", () => {
  it("formats active caregivers as a curated prose preview", () => {
    const result = buildCaregiverPreviewResult({
      city: "San Jose",
      seniorName: "Sarda",
      careNeeds: ["companionship", "transportation"],
      widened: false,
      caregivers: [
        { name: "Maria Santos", yearsExperience: 8, specialties: ["Dementia Care"] },
        { name: "James Okafor", experience: 5, skills: ["Companionship"] },
        { name: "Linda Tran", yearsExperience: 12, primaryServices: [{ name: "Medication Management" }] },
      ],
    });

    expect(result.available).toBe(true);
    expect(result.message).toContain("I found 3 caregivers near San Jose");
    expect(result.message).toContain("Maria Santos, 8 yrs experience, strongest fit for Dementia Care");
    expect(result.message).toContain("James Okafor, 5 yrs experience, strongest fit for Companionship");
    expect(result.message).toContain("I would start with the best fit");
    expect(result.message).not.toContain("•");
    expect(result.message).not.toMatch(/\n\s*1[.)]/);
  });

  it("returns an honest no-supply hold instead of taking payment", () => {
    const result = buildCaregiverPreviewResult({
      city: "Bakersfield",
      seniorName: "Mom",
      careNeeds: [],
      widened: false,
      caregivers: [],
    });

    expect(result.available).toBe(false);
    expect(result.message).toContain("No charge until then");
    expect(result.message).not.toContain("reply YES");
  });

  it("is visible to Evia and web but remains read-only", () => {
    expect(getCaregiverPreviewCaraAction.readOnly).toBe(true);
    expect(getCaregiverPreviewCaraAction.modelVisible).toBe(true);
    expect(getCaregiverPreviewCaraAction.webVisible).toBe(true);
    expect(getCaregiverPreviewCaraAction.publicAllowed).toBe(false);
  });

  describe("isSeededCaregiver", () => {
    it("flags docs carrying __seedTag", () => {
      expect(isSeededCaregiver(SEEDED_CAREGIVER)).toBe(true);
    });

    it("does not flag real caregiver docs", () => {
      expect(isSeededCaregiver(REAL_CAREGIVER)).toBe(false);
    });
  });

  describe("get_caregiver_preview action — seed-tag exclusion", () => {
    it("excludes a seeded doc among primary (local city) candidates", async () => {
      localDocs = [toDoc(REAL_CAREGIVER), toDoc(SEEDED_CAREGIVER)];
      widerDocs = [];

      const result = await getCaregiverPreviewCaraAction.run(
        { city: "San Jose", seniorName: "Mom", careNeeds: [] },
        ctx,
      );

      expect(result.available).toBe(true);
      expect(result.widened).toBe(false);
      expect(result.total).toBe(1);
      expect(result.items.map(i => i.name)).toEqual(["Maria Santos"]);
      expect(result.message).not.toContain("Fake Test Caregiver");
    });

    it("excludes a seeded doc that surfaces only via the widened-city fallback", async () => {
      // No local matches at all -> falls through to the wider active-only query.
      localDocs = [];
      widerDocs = [toDoc(SEEDED_CAREGIVER), toDoc(REAL_CAREGIVER)];

      const result = await getCaregiverPreviewCaraAction.run(
        { city: "Bakersfield", seniorName: "Mom", careNeeds: [] },
        ctx,
      );

      expect(result.available).toBe(true);
      expect(result.widened).toBe(true);
      expect(result.total).toBe(1);
      expect(result.items.map(i => i.name)).toEqual(["Maria Santos"]);
      expect(result.message).not.toContain("Fake Test Caregiver");
    });

    it("holds to the no-caregivers contract when every candidate is seeded", async () => {
      localDocs = [toDoc(SEEDED_CAREGIVER)];
      widerDocs = [toDoc(SEEDED_CAREGIVER)];

      const result = await getCaregiverPreviewCaraAction.run(
        { city: "Bakersfield", seniorName: "Mom", careNeeds: [] },
        ctx,
      );

      expect(result.available).toBe(false);
      expect(result.widened).toBe(false);
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
      expect(result.message).toContain("No charge until then");
      expect(result.message).not.toContain("Fake Test Caregiver");
    });

    it("leaves real caregivers unaffected when no seeded docs are present", async () => {
      localDocs = [toDoc(REAL_CAREGIVER)];
      widerDocs = [];

      const result = await getCaregiverPreviewCaraAction.run(
        { city: "San Jose", seniorName: "Mom", careNeeds: [] },
        ctx,
      );

      expect(result.available).toBe(true);
      expect(result.widened).toBe(false);
      expect(result.total).toBe(1);
      expect(result.items.map(i => i.name)).toEqual(["Maria Santos"]);
    });
  });
});
