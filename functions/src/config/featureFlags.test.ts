import { describe, it, expect, afterEach } from "vitest";
import {
  realWorldHealthcareActionsEnabled,
  isRoutingShadowEnabled,
  isConvergenceFlipped,
  isOnboardingAgentLoopEnabled,
  onboardingCohortPct,
  phoneCohortBucket,
  isPhoneInOnboardingCohort,
} from "./featureFlags";

describe("realWorldHealthcareActionsEnabled (H-U9)", () => {
  afterEach(() => { delete process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS; });

  it("defaults OFF when the env var is unset", () => {
    delete process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS;
    expect(realWorldHealthcareActionsEnabled()).toBe(false);
  });
  it("is ON only when exactly 'true'", () => {
    process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS = "true";
    expect(realWorldHealthcareActionsEnabled()).toBe(true);
  });
  it("treats other values as OFF", () => {
    process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS = "1";
    expect(realWorldHealthcareActionsEnabled()).toBe(false);
    process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS = "yes";
    expect(realWorldHealthcareActionsEnabled()).toBe(false);
  });
});

describe("routing convergence flags (U6/U10)", () => {
  afterEach(() => { delete process.env.ROUTING_CONVERGENCE_SHADOW; delete process.env.CONVERGENCE_FLIPPED; });

  it("shadow is off for every flow by default", () => {
    expect(isRoutingShadowEnabled("reminder_management")).toBe(false);
  });
  it("shadow is on only for flows listed (comma-separated, per-flow)", () => {
    process.env.ROUTING_CONVERGENCE_SHADOW = "reminder_management, modify_schedule";
    expect(isRoutingShadowEnabled("reminder_management")).toBe(true);
    expect(isRoutingShadowEnabled("modify_schedule")).toBe(true);
    expect(isRoutingShadowEnabled("refund")).toBe(false);
  });
  it("flip is off by default and on only for listed flows", () => {
    expect(isConvergenceFlipped("reminder_management")).toBe(false);
    process.env.CONVERGENCE_FLIPPED = "reminder_management";
    expect(isConvergenceFlipped("reminder_management")).toBe(true);
    expect(isConvergenceFlipped("refund")).toBe(false);
  });
});

describe("onboarding agent-loop canary cohort scoping", () => {
  afterEach(() => {
    delete process.env.ONBOARDING_AGENT_LOOP;
    delete process.env.ONBOARDING_AGENT_LOOP_PHONES;
    delete process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT;
  });

  it("role flag is off by default, on only for listed roles", () => {
    expect(isOnboardingAgentLoopEnabled("client")).toBe(false);
    process.env.ONBOARDING_AGENT_LOOP = "client";
    expect(isOnboardingAgentLoopEnabled("client")).toBe(true);
    expect(isOnboardingAgentLoopEnabled("caregiver")).toBe(false);
  });

  it("cohort pct defaults to 100 (everyone) and clamps to 0..100", () => {
    expect(onboardingCohortPct()).toBe(100);
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "10";
    expect(onboardingCohortPct()).toBe(10);
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "999";
    expect(onboardingCohortPct()).toBe(100);
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "-5";
    expect(onboardingCohortPct()).toBe(0);
    // A malformed value fails CLOSED (0), not open — a typo on the canary knob
    // must narrow to the safe legacy path, never widen exposure to 100%.
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "garbage";
    expect(onboardingCohortPct()).toBe(0);
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "10%";
    expect(onboardingCohortPct()).toBe(0);
  });

  it("phoneCohortBucket is deterministic and within 0..99", () => {
    const b = phoneCohortBucket("+15551234567");
    expect(b).toBe(phoneCohortBucket("+15551234567"));
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
  });

  it("default (no narrowing) → everyone is in cohort", () => {
    expect(isPhoneInOnboardingCohort("+15551234567")).toBe(true);
    expect(isPhoneInOnboardingCohort(undefined)).toBe(true);
  });

  it("pct=0 excludes everyone; pct=100 includes everyone", () => {
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "0";
    expect(isPhoneInOnboardingCohort("+15551234567")).toBe(false);
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "100";
    expect(isPhoneInOnboardingCohort("+15551234567")).toBe(true);
  });

  it("a narrowed pct is consistent per-phone and splits the space", () => {
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "50";
    // Stable membership: same phone → same answer across calls.
    const phone = "+15557654321";
    expect(isPhoneInOnboardingCohort(phone)).toBe(isPhoneInOnboardingCohort(phone));
    // Over many phones the in-cohort fraction is roughly the pct (loose bound).
    let inCohort = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      if (isPhoneInOnboardingCohort(`+1555${String(1000000 + i)}`)) inCohort++;
    }
    expect(inCohort / N).toBeGreaterThan(0.3);
    expect(inCohort / N).toBeLessThan(0.7);
  });

  it("allowlist wins over pct: only listed phones (exact or suffix) route", () => {
    process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "0"; // would exclude all…
    process.env.ONBOARDING_AGENT_LOOP_PHONES = "+15550001111, 9999";
    expect(isPhoneInOnboardingCohort("+15550001111")).toBe(true); // exact
    expect(isPhoneInOnboardingCohort("+15558889999")).toBe(true); // suffix
    expect(isPhoneInOnboardingCohort("+15550002222")).toBe(false); // not listed
    expect(isPhoneInOnboardingCohort(undefined)).toBe(false);
  });
});

// U13 flip POLICY. Safety-critical assertion: onboarding (sole signup path)
// stays DARK by default — only job_posting / modify_schedule cut over by default.
describe("convergence flip policy (U13 default-flipped + kill switch)", () => {
  afterEach(() => { delete process.env.CONVERGENCE_FLIPPED; delete process.env.CONVERGENCE_UNFLIPPED; });

  it("flips job_posting and modify_schedule ON by default, holds onboarding DARK", () => {
    expect(isConvergenceFlipped("job_posting")).toBe(true);
    expect(isConvergenceFlipped("modify_schedule")).toBe(true);
    // onboarding stays DARK by default in the cara-100 ↔ caregiver-mvr merge:
    // combined-code parity isn't established and the KTD-6 eval was never run, so
    // the proven legacy step flow ships. Still flippable per-flow once re-validated.
    expect(isConvergenceFlipped("onboarding")).toBe(false);
    process.env.CONVERGENCE_FLIPPED = "onboarding";
    expect(isConvergenceFlipped("onboarding")).toBe(true);
    delete process.env.CONVERGENCE_FLIPPED;
  });
  it("CONVERGENCE_UNFLIPPED rolls back onboarding (and any default-on flow)", () => {
    process.env.CONVERGENCE_UNFLIPPED = "onboarding";
    expect(isConvergenceFlipped("onboarding")).toBe(false);     // rolled back
    expect(isConvergenceFlipped("job_posting")).toBe(true);     // others unaffected
  });
  it("CONVERGENCE_UNFLIPPED is a reversible kill switch for default-on flows", () => {
    process.env.CONVERGENCE_UNFLIPPED = "job_posting";
    expect(isConvergenceFlipped("job_posting")).toBe(false);
    expect(isConvergenceFlipped("modify_schedule")).toBe(true);
  });
});
