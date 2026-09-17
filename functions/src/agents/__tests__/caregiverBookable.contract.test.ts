import { describe, it, expect } from "vitest";
import {
  isCaregiverBookable,
  UNBOOKABLE_BG_STATUSES,
} from "../../utils/caregiverEligibility";

/**
 * Booking-path eligibility contract.
 *
 * These tests pin the isCaregiverBookable semantics that every booking path
 * (bookingSend.ts, replacements, swaps, matching) must enforce:
 * a caregiver may only be booked when onboarding is complete AND verification
 * is approved.
 */
describe("booking eligibility contract (isCaregiverBookable)", () => {
  it("a clear-approved caregiver is bookable", () => {
    const caregiver = {
      onboardingStatus: "profile_complete",
      verificationStatus: "approved",
      verified: true,
      status: "active",
      backgroundCheckData: { status: "clear" },
    };
    expect(isCaregiverBookable(caregiver)).toBe(true);
  });

  it.each(["consider", "suspended", "pre_adverse_action", "rejected"])(
    "a caregiver with verificationStatus '%s' is NOT bookable",
    (verificationStatus) => {
      const caregiver = {
        onboardingStatus: "profile_complete",
        verificationStatus,
        verified: true,
        status: "active",
      };
      expect(isCaregiverBookable(caregiver)).toBe(false);
      expect(UNBOOKABLE_BG_STATUSES).toContain(verificationStatus);
    }
  );

  it("a profile_complete-but-unverified caregiver is NOT bookable", () => {
    expect(
      isCaregiverBookable({
        onboardingStatus: "profile_complete",
        verificationStatus: "submitted",
      })
    ).toBe(false);
    expect(
      isCaregiverBookable({
        onboardingStatus: "profile_complete",
        // no verificationStatus at all
      })
    ).toBe(false);
  });

  it("an approved caregiver who never completed onboarding is NOT bookable", () => {
    expect(
      isCaregiverBookable({
        onboardingStatus: "incomplete",
        verificationStatus: "approved",
      })
    ).toBe(false);
  });

  it("missing caregiver docs are never bookable", () => {
    expect(isCaregiverBookable(undefined)).toBe(false);
    expect(isCaregiverBookable(null)).toBe(false);
  });
});
