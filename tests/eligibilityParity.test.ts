// U15 — caregiver-eligibility parity guard.
//
// `isCaregiverBookable` is duplicated: the canonical backend copy
// (functions/src/utils/caregiverEligibility.ts) and the frontend mirror
// (utils/caregiverEligibility.ts). They must stay logically identical — a drift
// would let one surface book a caregiver the other considers ineligible. This
// test fails the moment their behavior diverges on any input.

import { describe, it, expect } from "vitest";
import { isCaregiverBookable as backendBookable } from "../functions/src/utils/caregiverEligibility";
import { isCaregiverBookable as frontendBookable } from "../utils/caregiverEligibility";

const CASES: Array<{ label: string; input: any; expected: boolean }> = [
  { label: "complete + approved", input: { onboardingStatus: "profile_complete", verificationStatus: "approved" }, expected: true },
  { label: "complete + consider", input: { onboardingStatus: "profile_complete", verificationStatus: "consider" }, expected: false },
  { label: "complete + pending", input: { onboardingStatus: "profile_complete", verificationStatus: "pending" }, expected: false },
  { label: "incomplete + approved", input: { onboardingStatus: "incomplete", verificationStatus: "approved" }, expected: false },
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
