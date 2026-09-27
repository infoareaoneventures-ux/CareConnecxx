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
} from "../caregiverAccessGate";

const PAID = { membershipStatus: "active" };
const CLEAR = { ...PAID, backgroundCheckStatus: "clear" };
const APPROVED_DOCS = {
  driversLicense: { status: "approved" }, insurance: { status: "approved" }, registration: { status: "approved" },
};

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
  it("transport jobs also need approved documents AND a cleared driving record", () => {
    const offers = { ...CLEAR, services: ["Transportation"] };
    expect(caregiverBlockReason(offers, { transport: true })).toBe("transport");
    expect(caregiverBlockReason({ ...offers, documents: APPROVED_DOCS }, { transport: true })).toBe("transport"); // MVR not cleared
    expect(caregiverBlockReason({ ...offers, documents: APPROVED_DOCS, isApprovedDriver: true }, { transport: true })).toBeNull();
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
    expect(caregiverGateText("membership")).toContain("you need an active membership to take this action");
    expect(caregiverGateText("background")).toContain("background check must be cleared");
    expect(caregiverGateText("transport")).toContain("transportation documents must be approved");
  });
});
