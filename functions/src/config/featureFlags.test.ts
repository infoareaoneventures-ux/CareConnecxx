import { describe, it, expect, afterEach } from "vitest";
import { realWorldHealthcareActionsEnabled, isRoutingShadowEnabled, isConvergenceFlipped } from "./featureFlags";

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
