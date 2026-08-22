import { describe, expect, it, vi } from "vitest";

// The scored path issues exactly one query:
// caregivers.where("onboardingStatus","==","profile_complete").limit(100).get()
let caregiverDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];

vi.mock("firebase-admin", () => {
  const firestore = () => ({
    collection: () => ({
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: caregiverDocs.length === 0, docs: caregiverDocs }),
        }),
      }),
    }),
  });
  return { __esModule: true, default: { firestore }, firestore };
});

import { getCaregiverPreviewCaraAction } from "./getCaregiverPreviewAction";

function toDoc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

const BOOKABLE = { onboardingStatus: "profile_complete", verificationStatus: "approved" };
const ctx = { caller: "sms_agent" as const, role: "client" as const };
// San Jose
const SAN_JOSE = { lat: 37.3382, lng: -121.8863 };
// New York — far outside any reasonable service radius
const NEW_YORK = { lat: 40.7128, lng: -74.0060 };

describe("get_caregiver_preview — scored path (lat/lng present)", () => {
  it("ranks a nearby bookable caregiver as a local (non-widened) match", async () => {
    caregiverDocs = [toDoc("cg-near", { ...BOOKABLE, name: "Maria Santos", lat: 37.34, lng: -121.89 })];

    const result = await getCaregiverPreviewCaraAction.run(
      { city: "San Jose", seniorName: "Mom", careNeeds: [], needsTransportation: false, ...SAN_JOSE },
      ctx,
    );

    expect(result.available).toBe(true);
    expect(result.widened).toBe(false);
    expect(result.items.map(i => i.name)).toEqual(["Maria Santos"]);
  });

  it("falls back to the relaxed backup pass when nobody is within range, instead of an unordered grab", async () => {
    caregiverDocs = [toDoc("cg-far", { ...BOOKABLE, name: "Distant Dan", ...NEW_YORK })];

    const result = await getCaregiverPreviewCaraAction.run(
      { city: "San Jose", seniorName: "Mom", careNeeds: [], needsTransportation: false, ...SAN_JOSE },
      ctx,
    );

    expect(result.available).toBe(true);
    expect(result.widened).toBe(true);
    expect(result.items.map(i => i.name)).toEqual(["Distant Dan"]);
  });

  it("holds to the no-caregivers contract when no bookable caregiver exists at all", async () => {
    caregiverDocs = [toDoc("cg-pending", { onboardingStatus: "profile_complete", verificationStatus: "pending", name: "Not Approved", ...SAN_JOSE })];

    const result = await getCaregiverPreviewCaraAction.run(
      { city: "San Jose", seniorName: "Mom", careNeeds: [], needsTransportation: false, ...SAN_JOSE },
      ctx,
    );

    expect(result.available).toBe(false);
    expect(result.message).toContain("No charge until then");
  });

  it("excludes a seeded doc from the scored pool the same as the legacy path", async () => {
    caregiverDocs = [
      toDoc("cg-seed", { ...BOOKABLE, __seedTag: "cara-test", name: "Fake Test Caregiver", ...SAN_JOSE }),
      toDoc("cg-real", { ...BOOKABLE, name: "Maria Santos", lat: 37.34, lng: -121.89 }),
    ];

    const result = await getCaregiverPreviewCaraAction.run(
      { city: "San Jose", seniorName: "Mom", careNeeds: [], needsTransportation: false, ...SAN_JOSE },
      ctx,
    );

    expect(result.items.map(i => i.name)).toEqual(["Maria Santos"]);
    expect(result.message).not.toContain("Fake Test Caregiver");
  });

  it("requires valid transport docs when needsTransportation is true, even in the backup pass", async () => {
    caregiverDocs = [toDoc("cg-no-docs", { ...BOOKABLE, name: "No Docs Nancy", ...NEW_YORK, skills: ["Transportation"] })];

    const result = await getCaregiverPreviewCaraAction.run(
      { city: "San Jose", seniorName: "Mom", careNeeds: [], needsTransportation: true, ...SAN_JOSE },
      ctx,
    );

    expect(result.available).toBe(false);
  });
});
