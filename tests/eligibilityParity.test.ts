// U15 — caregiver-eligibility parity guard.
//
// `isCaregiverBookable` is duplicated: the canonical backend copy
// (functions/src/utils/caregiverEligibility.ts) and the frontend mirror
// (utils/caregiverEligibility.ts). They must stay logically identical — a drift
// would let one surface book a caregiver the other considers ineligible. This
// test fails the moment their behavior diverges on any input.

import { describe, it, expect } from "vitest";
import { isCaregiverBookable as backendBookable, isCaregiverClearedForFamilies as backendCleared } from "../functions/src/utils/caregiverEligibility";
import { isCaregiverBookable as frontendBookable, isCaregiverClearedForFamilies as frontendCleared } from "../utils/caregiverEligibility";

const CASES: Array<{ label: string; input: any; expected: boolean }> = [
  { label: "complete + approved + active membership", input: { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active" }, expected: true },
  { label: "complete + approved + trialing", input: { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "trialing" }, expected: true },
  { label: "complete + approved + legacy paid flag, no status", input: { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipPaid: true }, expected: true },
  // 2026-10-06 (founder): a lapsed membership is NOT bookable — families don't meet a caregiver who can't act.
  { label: "complete + approved but membership canceled", input: { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "canceled" }, expected: false },
  { label: "complete + approved but no membership at all", input: { onboardingStatus: "profile_complete", verificationStatus: "approved" }, expected: false },
  { label: "projected clearedForFamilies flag is trusted", input: { clearedForFamilies: true }, expected: true },
  { label: "projected clearedForFamilies:false wins over raw fields", input: { clearedForFamilies: false, onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active" }, expected: false },
  { label: "complete + consider", input: { onboardingStatus: "profile_complete", verificationStatus: "consider", membershipStatus: "active" }, expected: false },
  { label: "complete + pending", input: { onboardingStatus: "profile_complete", verificationStatus: "pending" }, expected: false },
  { label: "incomplete + approved", input: { onboardingStatus: "incomplete", verificationStatus: "approved", membershipStatus: "active" }, expected: false },
  { label: "verified:true alone is NOT bookable", input: { verified: true, status: "active" }, expected: false },
  { label: "status:active alone is NOT bookable", input: { status: "active" }, expected: false },
  { label: "empty object", input: {}, expected: false },
  { label: "undefined", input: undefined, expected: false },
  { label: "null", input: null, expected: false },
  { label: "rejected verification", input: { onboardingStatus: "profile_complete", verificationStatus: "rejected" }, expected: false },
  { label: "post_adverse_action", input: { onboardingStatus: "profile_complete", verificationStatus: "post_adverse_action" }, expected: false },
];

describe("caregiver eligibility parity (backend vs frontend twin)", () => {
  it.each(CASES)("agrees on: $label", ({ input, expected }) => {
    const backend = backendBookable(input);
    const frontend = frontendBookable(input);
    expect(backend).toBe(expected);
    expect(frontend).toBe(expected);
    expect(backend).toBe(frontend); // the parity invariant
  });
});

// 2026-10-06: the approval-only half (no pause / opt-out) that gates everything a
// family can do with a caregiver (message, interview, profile pages, Evia).
describe("caregiver cleared-for-families parity (backend vs frontend twin)", () => {
  const CLEARED_CASES: Array<{ label: string; input: any; expected: boolean }> = [
    { label: "complete + approved + active membership", input: { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active" }, expected: true },
    { label: "complete + approved but PAUSED is still cleared (pause is bookability, not approval)", input: { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active", pausedUntil: "2099-01-01" }, expected: true },
    { label: "complete + approved but membership LAPSED is not cleared (2026-10-06)", input: { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "canceled" }, expected: false },
    { label: "complete + pending", input: { onboardingStatus: "profile_complete", verificationStatus: "pending" }, expected: false },
    { label: "complete + submitted", input: { onboardingStatus: "profile_complete", verificationStatus: "submitted" }, expected: false },
    { label: "incomplete + approved", input: { onboardingStatus: "in_progress", verificationStatus: "approved" }, expected: false },
    { label: "verified:true alone is NOT cleared", input: { verified: true, status: "active" }, expected: false },
    { label: "empty / undefined / null", input: undefined, expected: false },
  ];
  it.each(CLEARED_CASES)("agrees on: $label", ({ input, expected }) => {
    expect(backendCleared(input)).toBe(expected);
    expect(frontendCleared(input)).toBe(expected);
  });
});
