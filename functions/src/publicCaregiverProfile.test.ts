import { describe, expect, it, vi } from "vitest";

// toPublicProfile is pure, but this file's module load calls admin.firestore()
// and functions.https.onCall(...) as side effects — stub both so the import
// doesn't need a real Firebase environment.
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({}) },
  firestore: () => ({}),
}));
vi.mock("firebase-functions/v1", () => ({
  __esModule: true,
  https: { onCall: (fn: unknown) => fn },
}));

import { toPublicProfile } from "./publicCaregiverProfile";

// 2026-08-24: the SMS caregiver preview (getCaregiverPreviewAction.ts) was
// switched to read publicCaregiverProfiles instead of raw caregivers, so it
// automatically respects a caregiver's hidden/visibility setting the same
// way the website's own caregiver-matching surfaces do. This pins the two
// things that change needed from the projection itself: a precomputed
// transport-eligibility flag (never the raw document data — this doc is
// meant to be publicly readable) and the __seedTag test marker passing
// through so isSeededCaregiver() still works against this collection too.
describe("toPublicProfile", () => {
  const approvedTransportDocs = {
    driversLicense: { status: "approved" },
    insurance: { status: "approved" },
    registration: { status: "approved" },
  };

  it("never includes the raw documents field", () => {
    const out = toPublicProfile("cg1", { name: "Alice", documents: approvedTransportDocs });
    expect(out.documents).toBeUndefined();
  });

  it("includes a precomputed hasValidTransportDocs flag instead", () => {
    const eligible = toPublicProfile("cg1", { name: "Alice", skills: ["Transportation"], documents: approvedTransportDocs });
    expect(eligible.hasValidTransportDocs).toBe(true);

    const ineligible = toPublicProfile("cg2", { name: "Bob", skills: ["Companionship"], documents: approvedTransportDocs });
    expect(ineligible.hasValidTransportDocs).toBe(false);
  });

  it("passes __seedTag through so isSeededCaregiver() still works on this projection", () => {
    const out = toPublicProfile("cg1", { name: "Fake Test Caregiver", __seedTag: "cara-test" });
    expect(out.__seedTag).toBe("cara-test");
  });

  it("omits __seedTag for a real caregiver (no key present)", () => {
    const out = toPublicProfile("cg1", { name: "Alice" });
    expect(out).not.toHaveProperty("__seedTag");
  });

  it("still carries the fields the eligibility/scoring/preview pipeline needs", () => {
    const out = toPublicProfile("cg1", {
      name: "Alice", onboardingStatus: "profile_complete", verificationStatus: "approved",
      city: "San Jose", state: "CA", lat: 37.3, lng: -121.9, skills: ["Dementia Care"],
    });
    expect(out).toMatchObject({
      onboardingStatus: "profile_complete", verificationStatus: "approved",
      city: "San Jose", lat: 37.3, lng: -121.9,
    });
  });
});
