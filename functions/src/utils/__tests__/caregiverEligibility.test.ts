import { describe, it, expect } from "vitest";
import {
  isCaregiverBookable,
  bookableFilter,
  UNBOOKABLE_BG_STATUSES,
} from "../caregiverEligibility";

describe("isCaregiverBookable", () => {
  it("returns true ONLY for profile_complete + approved", () => {
    expect(
      isCaregiverBookable({
        onboardingStatus: "profile_complete",
        verificationStatus: "approved",
      })
    ).toBe(true);
  });

  it("returns false for undefined / null / empty caregiver", () => {
    expect(isCaregiverBookable(undefined)).toBe(false);
    expect(isCaregiverBookable(null)).toBe(false);
    expect(isCaregiverBookable({})).toBe(false);
  });

  it("matrix: false for every combination except profile_complete + approved", () => {
    const onboardingStatuses = [
      undefined,
      "incomplete",
      "in_progress",
      "submitted",
      "profile_complete",
    ];
    const verificationStatuses = [
      undefined,
      "pending",
      "submitted",
      "info_requested",
      "rejected",
      "approved",
    ];

    for (const onboardingStatus of onboardingStatuses) {
      for (const verificationStatus of verificationStatuses) {
        const expected =
          onboardingStatus === "profile_complete" &&
          verificationStatus === "approved";
        expect(
          isCaregiverBookable({ onboardingStatus, verificationStatus }),
          `onboardingStatus=${onboardingStatus} verificationStatus=${verificationStatus}`
        ).toBe(expected);
      }
    }
  });

  it("returns false when verified=true but verificationStatus is missing", () => {
    expect(
      isCaregiverBookable({
        onboardingStatus: "profile_complete",
        verified: true,
      } as any)
    ).toBe(false);
  });

  it("returns false when status='active' but onboarding is incomplete", () => {
    expect(
      isCaregiverBookable({
        status: "active",
        onboardingStatus: "incomplete",
        verificationStatus: "approved",
      } as any)
    ).toBe(false);
  });

  it("returns false for every UNBOOKABLE_BG_STATUSES verificationStatus", () => {
    for (const status of UNBOOKABLE_BG_STATUSES) {
      expect(
        isCaregiverBookable({
          onboardingStatus: "profile_complete",
          verificationStatus: status,
        }),
        `verificationStatus=${status}`
      ).toBe(false);
    }
  });

  it("returns false when backgroundCheck status is unbookable and verificationStatus never reached approved", () => {
    for (const status of UNBOOKABLE_BG_STATUSES) {
      expect(
        isCaregiverBookable({
          onboardingStatus: "profile_complete",
          verificationStatus: status === "rejected" ? "rejected" : "submitted",
          backgroundCheckData: { status },
        } as any),
        `backgroundCheckData.status=${status}`
      ).toBe(false);
    }
  });

  it("UNBOOKABLE_BG_STATUSES contains the full adverse list", () => {
    expect([...UNBOOKABLE_BG_STATUSES].sort()).toEqual(
      [
        "consider",
        "suspended",
        "canceled",
        "disputed",
        "pre_adverse_action",
        "rejected",
        "post_adverse_action",
      ].sort()
    );
  });
});

describe("bookableFilter", () => {
  it("mirrors isCaregiverBookable for use with Array#filter", () => {
    const docs = [
      { onboardingStatus: "profile_complete", verificationStatus: "approved" },
      { onboardingStatus: "profile_complete", verificationStatus: "submitted" },
      { onboardingStatus: "incomplete", verificationStatus: "approved" },
      null,
      undefined,
    ];
    expect(docs.filter(bookableFilter)).toEqual([docs[0]]);
  });
});
