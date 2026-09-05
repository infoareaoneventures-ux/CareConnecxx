import { describe, it, expect, afterEach } from "vitest";
import {
  timesheetAutoApprovalEnabled,
  isRoutingShadowEnabled,
  isConvergenceFlipped,
  caraOutputGuardEnabled,
  outboundHistoryRecordEnabled,
} from "./featureFlags";

describe("timesheetAutoApprovalEnabled", () => {
  afterEach(() => { delete process.env.TIMESHEET_AUTO_APPROVAL_ENABLED; });

  it("defaults OFF when the env var is unset", () => {
    delete process.env.TIMESHEET_AUTO_APPROVAL_ENABLED;
    expect(timesheetAutoApprovalEnabled()).toBe(false);
  });

  it("is ON only when exactly 'true'", () => {
    process.env.TIMESHEET_AUTO_APPROVAL_ENABLED = "true";
    expect(timesheetAutoApprovalEnabled()).toBe(true);
    process.env.TIMESHEET_AUTO_APPROVAL_ENABLED = "1";
    expect(timesheetAutoApprovalEnabled()).toBe(false);
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

// Hallucination hardening U1: KILL switch (default ON), not a launch gate —
// off only when the env var is exactly "false".
describe("caraOutputGuardEnabled (hallucination U1)", () => {
  afterEach(() => { delete process.env.CARA_OUTPUT_GUARD_ENABLED; });

  it("defaults ON when the env var is unset", () => {
    delete process.env.CARA_OUTPUT_GUARD_ENABLED;
    expect(caraOutputGuardEnabled()).toBe(true);
  });
  it("is OFF only when exactly 'false'", () => {
    process.env.CARA_OUTPUT_GUARD_ENABLED = "false";
    expect(caraOutputGuardEnabled()).toBe(false);
  });
  it("stays ON for any other value", () => {
    process.env.CARA_OUTPUT_GUARD_ENABLED = "true";
    expect(caraOutputGuardEnabled()).toBe(true);
    process.env.CARA_OUTPUT_GUARD_ENABLED = "0";
    expect(caraOutputGuardEnabled()).toBe(true);
  });
});

// Hallucination hardening U3: KILL switch (default ON), not a launch gate —
// off only when the env var is exactly "false".
describe("outboundHistoryRecordEnabled (hallucination U3)", () => {
  afterEach(() => { delete process.env.OUTBOUND_HISTORY_RECORD_ENABLED; });

  it("defaults ON when the env var is unset", () => {
    delete process.env.OUTBOUND_HISTORY_RECORD_ENABLED;
    expect(outboundHistoryRecordEnabled()).toBe(true);
  });
  it("is OFF only when exactly 'false'", () => {
    process.env.OUTBOUND_HISTORY_RECORD_ENABLED = "false";
    expect(outboundHistoryRecordEnabled()).toBe(false);
  });
  it("stays ON for any other value", () => {
    process.env.OUTBOUND_HISTORY_RECORD_ENABLED = "true";
    expect(outboundHistoryRecordEnabled()).toBe(true);
    process.env.OUTBOUND_HISTORY_RECORD_ENABLED = "0";
    expect(outboundHistoryRecordEnabled()).toBe(true);
  });
});

// NOTE: the ONBOARDING_AGENT_LOOP* canary-cohort tests were removed on 2026-07-08
// when the agent loop became the sole onboarding collection path (loop-only) and
// those flags were deleted. Routing is now unconditional — see
// onboardingContract.test.ts › shouldRouteOnboardingToLoop.

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
