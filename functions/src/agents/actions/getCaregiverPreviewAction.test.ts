import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({
    collection: () => ({
      where: () => ({
        where: () => ({ limit: () => ({ get: vi.fn() }) }),
        limit: () => ({ get: vi.fn() }),
      }),
    }),
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
} from "./getCaregiverPreviewAction";

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

  it("is visible to Cara and web but remains read-only", () => {
    expect(getCaregiverPreviewCaraAction.readOnly).toBe(true);
    expect(getCaregiverPreviewCaraAction.modelVisible).toBe(true);
    expect(getCaregiverPreviewCaraAction.webVisible).toBe(true);
    expect(getCaregiverPreviewCaraAction.publicAllowed).toBe(false);
  });
});
