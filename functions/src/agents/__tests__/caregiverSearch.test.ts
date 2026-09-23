import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({}) }) }) }) }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://eviacares.com" }));

import { caregiverCardText, type CaregiverCard } from "../caregiverSearch";

// Transportation only counts as a service once the badge is earned — same gate
// as the profile page (caregiverProfilePage.ts / ClientCaregiverProfile.tsx)
// and the site's Find Caregivers search card. caregiverCardText used to list
// it from the raw skills array regardless of the badge (2026-09-22 parity fix).

function baseCard(overrides: Partial<CaregiverCard> = {}): CaregiverCard {
  return {
    id: "cg1", name: "Basra Yousuf", firstName: "Basra", lastName: "Yousuf",
    photoURL: null, rating: 4.9, reviewCount: 12, verified: true,
    backgroundCheckStatus: "clear", experience: 6, city: "San Jose",
    stateCode: "CA", zipCode: "95134", distance: 3, hourlyRate: 25,
    skills: ["Companionship", "Transportation"], languages: ["English"],
    hasReliableTransportation: false, isFavorite: false,
    state: "request_interview", actions: ["message", "request_interview"],
    profileUrl: "https://eviacares.com/p/cg1",
    ...overrides,
  };
}

describe("caregiverCardText — Transportation gated on the badge", () => {
  it("hides Transportation from the skills line until the badge is earned", () => {
    const text = caregiverCardText(baseCard({ hasReliableTransportation: false }));
    expect(text).toContain("Companionship");
    expect(text).not.toContain("Transportation");
  });

  it("shows Transportation once the badge is earned", () => {
    const text = caregiverCardText(baseCard({ hasReliableTransportation: true }));
    expect(text).toContain("Companionship, Transportation");
  });

  it("never lets Transportation count toward the +N overflow when hidden", () => {
    const text = caregiverCardText(baseCard({
      skills: ["Companionship", "Meal Preparation", "Transportation"],
      hasReliableTransportation: false,
    }));
    // Only 2 REAL skills remain (Transportation dropped) — no "+N" should appear.
    expect(text).toContain("Companionship, Meal Preparation");
    expect(text).not.toMatch(/\+\d/);
    expect(text).not.toContain("Transportation");
  });
});
