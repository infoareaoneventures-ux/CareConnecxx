import { describe, it, expect, afterEach } from "vitest";
import { realWorldHealthcareActionsEnabled } from "./featureFlags";

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
