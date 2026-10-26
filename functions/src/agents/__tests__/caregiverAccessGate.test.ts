// The website's caregiver gate (hooks/useCaregiverGate.tsx), mirrored for Evia's
// action tools: membership → background check → (transport jobs) documents + MVR.
import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ firestore: () => ({ collection: () => ({ doc: () => ({}) }) }) }));
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async () => {}) }));

import {
  caregiverBlockReason,
  isCaregiverMembershipActive,
  isCaregiverBackgroundApproved,
  jobRequiresTransport,
  caregiverGateText,
  caregiverPayoutsLive,
} from "../caregiverAccessGate";
import { isCaregiverMembershipActiveForFamilies } from "../../utils/caregiverEligibility";

describe("the ONE care provider membership rule (sweep C1, 2026-10-11)", () => {
  it("active / trialing / past_due / payment_failed = active; canceled, unpaid, inactive are not; the legacy paid flag only with no status", () => {
    for (const s of ["active", "trialing", "past_due", "payment_failed"]) expect(isCaregiverMembershipActive({ membershipStatus: s })).toBe(true);
    for (const s of ["canceled", "unpaid", "inactive", "incomplete_expired"]) expect(isCaregiverMembershipActive({ membershipStatus: s, membershipPaid: true })).toBe(false);
    expect(isCaregiverMembershipActive({ membershipPaid: true })).toBe(true);
    expect(isCaregiverMembershipActive({})).toBe(false);
    expect(isCaregiverMembershipActive(null)).toBe(false);
  });
  it("is the same implementation the family-facing gate uses (utils/caregiverEligibility)", () => {
    for (const cg of [{ membershipStatus: "past_due" }, { membershipStatus: "canceled", membershipPaid: true }, { membershipPaid: true }, {}]) {
      expect(isCaregiverMembershipActive(cg)).toBe(isCaregiverMembershipActiveForFamilies(cg));
    }
  });
});

describe("caregiverPayoutsLive — the Payouts page's rule (sweep C2, 2026-10-11)", () => {
  it("payouts AND charges enabled; onboarding-complete or payouts alone are not live", () => {
    expect(caregiverPayoutsLive({ payoutsEnabled: true, chargesEnabled: true })).toBe(true);
    expect(caregiverPayoutsLive({ payoutsEnabled: true })).toBe(false);
    expect(caregiverPayoutsLive({ chargesEnabled: true, stripeOnboardingComplete: true })).toBe(false);
    expect(caregiverPayoutsLive({ stripeOnboardingComplete: true })).toBe(false);
    expect(caregiverPayoutsLive(undefined)).toBe(false);
  });
});

const PAID = { membershipStatus: "active" };
const CLEAR = { ...PAID, backgroundCheckStatus: "clear" };

describe("caregiverBlockReason — useCaregiverGate.tsx:95-96", () => {
  it("membership comes first, exactly as the site computes it", () => {
    expect(caregiverBlockReason({})).toBe("membership");
    expect(caregiverBlockReason({ membershipStatus: "canceled", membershipPaid: true })).toBe("membership");
    expect(isCaregiverMembershipActive({ membershipPaid: true })).toBe(true);          // no status yet + paid
    expect(isCaregiverMembershipActive({ membershipStatus: "trialing" })).toBe(true);
  });
  it("then the background check (verified / clear / complete all count)", () => {
    expect(caregiverBlockReason(PAID)).toBe("background");
    expect(isCaregiverBackgroundApproved({ verified: true })).toBe(true);
    expect(isCaregiverBackgroundApproved({ backgroundCheckComplete: true })).toBe(true);
    expect(caregiverBlockReason(CLEAR)).toBeNull();
  });
  it("membershipOnly = the site's gateMembership (messaging): ignores the background check", () => {
    expect(caregiverBlockReason(PAID, { membershipOnly: true })).toBeNull();
    expect(caregiverBlockReason({}, { membershipOnly: true })).toBe("membership");
  });
  it("transport jobs need Transportation offered AND a cleared driving record — no documents (2026-10-06)", () => {
    const offers = { ...CLEAR, services: ["Transportation"] };
    expect(caregiverBlockReason(offers, { transport: true })).toBe("transport"); // MVR not cleared
    expect(caregiverBlockReason({ ...offers, isApprovedDriver: true }, { transport: true })).toBeNull();
    // A caregiver who doesn't offer transportation can't take a transport job either.
    expect(caregiverBlockReason(CLEAR, { transport: true })).toBe("transport");
    // …but a non-transport action on the same caregiver is fine.
    expect(caregiverBlockReason(offers)).toBeNull();
  });
});

describe("jobRequiresTransport — JobBoard.tsx", () => {
  it("careTypes Transportation or requirements Driving", () => {
    expect(jobRequiresTransport({ careTypes: ["Companionship", "Transportation"] })).toBe(true);
    expect(jobRequiresTransport({ requirements: ["Driving"] })).toBe(true);
    expect(jobRequiresTransport({ careTypes: ["Companionship"] })).toBe(false);
    expect(jobRequiresTransport(undefined)).toBe(false);
  });
});

describe("caregiverGateText — the modal's own copy", () => {
  it("says what the site's modal says", () => {
    expect(caregiverGateText("membership")).toContain("You'll need an active membership for that");
    expect(caregiverGateText("background")).toContain("background check needs to clear");
    expect(caregiverGateText("transport")).toContain("Set Up Transportation");
    expect(caregiverGateText("transport")).toContain("complete the driving record check");
    expect(caregiverGateText("transport")).not.toMatch(/approved|cleared|badge/i);
    // 2026-10-06: not offering Transportation yet → the text says reply SERVICES (the site's button opens the Care Services editor); offering → Settings.
    expect(caregiverGateText("transport", { services: ["Companionship"] })).toContain("say services");
    expect(caregiverGateText("transport", { services: ["Companionship"] })).not.toContain("Settings");
    // Offering → no site link in the text either: the block texts the driving record card itself (founder, 2026-10-06).
    expect(caregiverGateText("transport", { services: ["Transportation"] })).not.toMatch(/Settings|http/);
  });
});
