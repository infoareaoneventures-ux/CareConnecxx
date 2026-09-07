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

  // 2026-09-06: isCaregiverBookable() now checks pausedUntil — without this
  // field on the projection, every consumer reading publicCaregiverProfiles
  // (Dashboard widget, Browse Caregivers, find_nearby_caregivers) would
  // silently never see a caregiver's pause and keep showing them as bookable.
  it("carries pausedUntil through so the shared bookability gate can see it", () => {
    const out = toPublicProfile("cg1", { name: "Alice", pausedUntil: "2026-10-01" });
    expect(out.pausedUntil).toBe("2026-10-01");
  });

  it("omits pausedUntil for a caregiver who isn't paused", () => {
    const out = toPublicProfile("cg1", { name: "Alice" });
    expect(out).not.toHaveProperty("pausedUntil");
  });

  // 2026-09-06: isCaregiverBookable() now also checks optedOut (mirrored from
  // the real SMS opt-out) — same passthrough requirement as pausedUntil.
  it("carries optedOut through so the shared bookability gate can see it", () => {
    const out = toPublicProfile("cg1", { name: "Alice", optedOut: true });
    expect(out.optedOut).toBe(true);
  });

  // 2026-09-06: matchingAgent.ts moved onto this projection — these three
  // were only ever on the raw caregivers doc before.
  it("carries zipCode, gender, canDrive through for matchingAgent.ts's soft-preference scoring", () => {
    const out = toPublicProfile("cg1", { name: "Alice", zipCode: "95050", gender: "Female", canDrive: true });
    expect(out).toMatchObject({ zipCode: "95050", gender: "Female", canDrive: true });
  });
});
