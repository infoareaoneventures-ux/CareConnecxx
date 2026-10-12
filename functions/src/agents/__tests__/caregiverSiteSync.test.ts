// Site → Evia cursor reconciliation (caregiverSiteSync.ts) — caregiver sweep
// C1/C2/C5 (2026-10-11): the site's rules, and a membership paid on the SITE
// lands on the AWAITING-consent step (no second consent link).
import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ firestore: () => ({ collection: () => ({ doc: () => ({}) }) }) }));
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async () => {}) }));

import { reconciledCaregiverStep, consentAlreadyRequested } from "../caregiverSiteSync";

describe("reconciledCaregiverStep — membership = the ONE rule (C1/C5)", () => {
  it("a canceled status with a stale membershipPaid:true is NOT paid (the sync used to count the flag)", () => {
    expect(reconciledCaregiverStep("caregiver_awaiting_membership", { membershipStatus: "canceled", membershipPaid: true })).toBe("caregiver_awaiting_membership");
  });
  it("Stripe's retry states count as active, like the site's gate", () => {
    expect(reconciledCaregiverStep("caregiver_awaiting_membership", { membershipStatus: "past_due" })).toBe("caregiver_send_bgcheck");
    expect(reconciledCaregiverStep("caregiver_awaiting_membership", { membershipStatus: "payment_failed" })).toBe("caregiver_send_bgcheck");
    expect(reconciledCaregiverStep("caregiver_send_membership", { membershipPaid: true })).toBe("caregiver_send_bgcheck"); // legacy flag, no status
  });
  it("paid on the site = the webhook already parked 'authorize your background check' → the AWAITING-consent step, not a fresh send", () => {
    const cg = { membershipStatus: "active", backgroundCheckData: { consentRequired: true, invitationStatus: "awaiting_consent", status: "pending" } };
    expect(consentAlreadyRequested(cg)).toBe(true);
    expect(reconciledCaregiverStep("caregiver_awaiting_membership", cg)).toBe("caregiver_awaiting_bgcheck_consent");
    expect(reconciledCaregiverStep("caregiver_send_bgcheck", cg)).toBe("caregiver_awaiting_bgcheck_consent");
  });
  it("a live Checkr invitation moves past consent; a clear moves to payouts", () => {
    expect(reconciledCaregiverStep("caregiver_awaiting_bgcheck_consent", { membershipStatus: "active", backgroundCheckData: { checkrCandidateId: "c1", invitationStatus: "pending" } })).toBe("caregiver_awaiting_bgcheck");
    expect(reconciledCaregiverStep("caregiver_awaiting_bgcheck_consent", { membershipStatus: "active", backgroundCheckData: { checkrCandidateId: "c1", invitationStatus: "expired" } })).toBe("caregiver_awaiting_bgcheck_consent");
    expect(reconciledCaregiverStep("caregiver_awaiting_bgcheck", { backgroundCheckStatus: "clear" })).toBe("caregiver_send_stripe_connect");
  });
});

describe("reconciledCaregiverStep — payouts live = payouts AND charges (C2)", () => {
  it("stripeOnboardingComplete / payoutsEnabled alone are not 'live'", () => {
    expect(reconciledCaregiverStep("caregiver_awaiting_stripe", {}, { stripeOnboardingComplete: true })).toBe("caregiver_awaiting_stripe");
    expect(reconciledCaregiverStep("caregiver_awaiting_stripe", {}, { payoutsEnabled: true })).toBe("caregiver_awaiting_stripe");
    expect(reconciledCaregiverStep("caregiver_awaiting_stripe", { payoutsEnabled: true, stripeOnboardingComplete: true }, undefined)).toBe("caregiver_awaiting_stripe");
    expect(reconciledCaregiverStep("caregiver_awaiting_stripe", {}, { payoutsEnabled: true, chargesEnabled: true })).toBe("complete");
  });
  it("the wizard finished on the site moves a collection cursor to the first gate", () => {
    expect(reconciledCaregiverStep("caregiver_ask_bio", { onboardingStatus: "profile_complete" })).toBe("caregiver_send_membership");
    expect(reconciledCaregiverStep("caregiver_ask_bio", { onboardingStatus: "profile_complete", membershipStatus: "active" })).toBe("caregiver_send_bgcheck");
  });
});
