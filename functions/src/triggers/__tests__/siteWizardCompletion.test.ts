import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({ collection: () => ({}), runTransaction: async () => false });
  firestore.FieldValue = { serverTimestamp: () => "ts", delete: () => "del" };
  return { default: { firestore, apps: [{}] }, firestore, apps: [{}], initializeApp: () => ({}) };
});
vi.mock("firebase-functions/v1", () => ({
  firestore: { document: () => ({ onWrite: (fn: any) => fn, onUpdate: (fn: any) => fn }) },
}));

import { familyWizardFinishedOnSite, providerWizardFinishedOnSite, sessionStillCollecting } from "../siteWizardCompletion";

describe("site finished the questionnaire — when Evia texts the next gate (2026-10-19)", () => {
  it("a family's posting flipping to active is the wizard's last step", () => {
    expect(familyWizardFinishedOnSite({ status: "draft", draftStep: 5 }, { status: "active" })).toBe(true);
    expect(familyWizardFinishedOnSite(undefined, { status: "active" })).toBe(true);
    expect(familyWizardFinishedOnSite({ status: "active" }, { status: "active", notes: "edited" })).toBe(false); // an edit later
    expect(familyWizardFinishedOnSite({ status: "active" }, { status: "closed" })).toBe(false);
  });

  it("a provider's record stamping profile_complete is the wizard's last step", () => {
    expect(providerWizardFinishedOnSite({ onboardingStatus: "in_progress" }, { onboardingStatus: "profile_complete" })).toBe(true);
    expect(providerWizardFinishedOnSite({ onboardingStatus: "profile_complete" }, { onboardingStatus: "profile_complete", bio: "x" })).toBe(false);
  });

  it("acts only while the text cursor still sits on something the site just finished", () => {
    expect(sessionStillCollecting("client", "client_ask_senior")).toBe(true);
    expect(sessionStillCollecting("client", "client_ask_schedule")).toBe(true);
    expect(sessionStillCollecting("client", "client_ask_budget")).toBe(true);
    // Evia's own completion writes the record at confirm_intake — never a second text there.
    expect(sessionStillCollecting("client", "client_confirm_intake")).toBe(false);
    expect(sessionStillCollecting("client", "client_awaiting_identity")).toBe(false);
    expect(sessionStillCollecting("client", "complete")).toBe(false);
    expect(sessionStillCollecting("client", undefined)).toBe(false);

    expect(sessionStillCollecting("caregiver", "caregiver_ask_bio")).toBe(true);
    expect(sessionStillCollecting("caregiver", "caregiver_ask_location")).toBe(true);
    // complete_collection parks the gate step BEFORE stamping the record.
    expect(sessionStillCollecting("caregiver", "caregiver_send_membership")).toBe(false);
    expect(sessionStillCollecting("caregiver", "caregiver_awaiting_membership")).toBe(false);
  });
});
