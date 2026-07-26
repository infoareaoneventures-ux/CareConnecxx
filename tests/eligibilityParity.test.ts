// U15 — caregiver-eligibility parity guard.
//
// `isCaregiverBookable` is duplicated: the canonical backend copy
// (functions/src/utils/caregiverEligibility.ts) and the frontend mirror
// (utils/caregiverEligibility.ts). They must stay logically identical — a drift
// would let one surface book a caregiver the other considers ineligible. This
// test fails the moment their behavior diverges on any input.

import { describe, it, expect } from "vitest";
import {
  isCaregiverBookable as backendBookable,
  isCaregiverChildcareVisible as backendChildVisible,
  isCaregiverBookableForVertical as backendForVertical,
} from "../functions/src/utils/caregiverEligibility";
import {
  isCaregiverBookable as frontendBookable,
  isCaregiverChildcareVisible as frontendChildVisible,
  isCaregiverBookableForVertical as frontendForVertical,
} from "../utils/caregiverEligibility";

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

// ── Childcare vertical hook (plan 2026-07-22-002 U5, R24/R31/AE9) ────────────
// The derived childcareProvider.visible flag is INDEPENDENT of senior
// bookability; both twins must agree on every input, and the senior contract
// must be untouched by any childcare state.

const CHILD_CASES: Array<{ label: string; input: any; child: boolean; senior: boolean }> = [
  {
    label: "senior-approved caregiver WITHOUT childcare visibility (AE9)",
    input: { onboardingStatus: "profile_complete", verificationStatus: "approved" },
    child: false,
    senior: true,
  },
  {
    label: "derived visibility true (server-computed R28 gate)",
    input: { onboardingStatus: "profile_complete", verificationStatus: "approved", childcareProvider: { visible: true } },
    child: true,
    senior: true,
  },
  {
    label: "childcare-visible does NOT require senior bookability (independent verticals)",
    input: { onboardingStatus: "incomplete", verificationStatus: "pending", childcareProvider: { visible: true } },
    child: true,
    senior: false,
  },
  {
    label: "visible must be EXACTLY true (truthy strings fail closed)",
    input: { childcareProvider: { visible: "true" } },
    child: false,
    senior: false,
  },
  { label: "empty object", input: {}, child: false, senior: false },
  { label: "null", input: null, child: false, senior: false },
  {
    label: "childcareProvider present but visibility revoked",
    input: { onboardingStatus: "profile_complete", verificationStatus: "approved", childcareProvider: { visible: false } },
    child: false,
    senior: true,
  },
];

describe("childcare vertical visibility parity (backend vs frontend twin)", () => {
  it.each(CHILD_CASES)("agrees on: $label", ({ input, child, senior }) => {
    expect(backendChildVisible(input)).toBe(child);
    expect(frontendChildVisible(input)).toBe(child);
    expect(backendForVertical(input, "child")).toBe(child);
    expect(frontendForVertical(input, "child")).toBe(child);
    // The senior contract stays byte-for-byte the legacy predicate.
    expect(backendForVertical(input, "senior")).toBe(senior);
    expect(frontendForVertical(input, "senior")).toBe(senior);
    expect(backendForVertical(input, "senior")).toBe(backendBookable(input));
    // Unknown verticals fail closed on both twins.
    expect(backendForVertical(input, "petcare")).toBe(false);
    expect(frontendForVertical(input, "petcare")).toBe(false);
  });
});
