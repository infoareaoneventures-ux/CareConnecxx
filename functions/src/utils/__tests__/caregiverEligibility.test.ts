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

  // 2026-09-06: pausing (pause_account/reactivate_account) used to be checked
  // only by the SMS matching flow's own local isTemporarilyUnavailable —
  // every other consumer of this canonical gate (Dashboard widget, Browse
  // Caregivers, find_nearby_caregivers) had no idea pausing existed.
  it("returns false while pausedUntil is in the future, even if otherwise bookable", () => {
    expect(
      isCaregiverBookable(
        { onboardingStatus: "profile_complete", verificationStatus: "approved", pausedUntil: "2026-10-01" },
        "2026-09-06T00:00:00.000Z",
      )
    ).toBe(false);
  });

  it("returns true again once pausedUntil is in the past", () => {
    expect(
      isCaregiverBookable(
        { onboardingStatus: "profile_complete", verificationStatus: "approved", pausedUntil: "2026-08-01" },
        "2026-09-06T00:00:00.000Z",
      )
    ).toBe(true);
  });

  it("is unaffected by an absent pausedUntil", () => {
    expect(
      isCaregiverBookable({ onboardingStatus: "profile_complete", verificationStatus: "approved" })
    ).toBe(true);
  });

  // 2026-09-06: the real SMS/TCPA opt-out (agent_sessions.optedOut) is
  // mirrored onto the caregiver doc (triggers/caregiverOptOutMirror.ts) —
  // before this, nothing in the matching pipeline checked it at all, so an
  // opted-out caregiver (Evia can no longer reach them) could still be
  // suggested as a match.
  it("returns false when optedOut is mirrored true, even if otherwise bookable", () => {
    expect(
      isCaregiverBookable({ onboardingStatus: "profile_complete", verificationStatus: "approved", optedOut: true })
    ).toBe(false);
  });

  it("is unaffected by optedOut explicitly false or absent", () => {
    expect(
      isCaregiverBookable({ onboardingStatus: "profile_complete", verificationStatus: "approved", optedOut: false })
    ).toBe(true);
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
