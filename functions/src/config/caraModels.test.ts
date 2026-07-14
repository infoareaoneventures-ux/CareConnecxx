import { describe, expect, it } from "vitest";
import { resolveCaraModelConfig, shouldFallbackAgentToAnthropic, estimateCostUsd } from "./caraModels";

describe("estimateCostUsd", () => {
  it("prices a known model by prefix and scales with tokens", () => {
    const cost = estimateCostUsd("claude-sonnet-4-6", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(3 + 15, 5); // 3/MTok in + 15/MTok out
    expect(estimateCostUsd("claude-sonnet-4-6", 2_000_000, 0)).toBeCloseTo(6, 5);
  });

  it("prefers the LONGEST matching prefix (gpt-5.4-mini over gpt-5.4)", () => {
    const mini = estimateCostUsd("gpt-5.4-mini", 1_000_000, 0);
    const base = estimateCostUsd("gpt-5.4", 1_000_000, 0);
    expect(mini).toBeLessThan(base); // mini is cheaper — proves the longer prefix won
  });

  it("falls back to a frontier-priced default for an unknown model (never free)", () => {
    expect(estimateCostUsd("some-unreleased-model", 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd("gpt-5.4", 0, 0)).toBe(0);
  });
});

describe("resolveCaraModelConfig", () => {
  it("defaults production agent reasoning to OpenAI gpt-4o", () => {
    expect(resolveCaraModelConfig("agent", {})).toEqual({
      provider: "openai",
      model:    "gpt-4o",
    });
  });

  it("keeps legacy scripted tests on the Anthropic adapter unless overridden", () => {
    expect(resolveCaraModelConfig("agent", { VITEST: "true" })).toEqual({
      provider: "anthropic",
      model:    "claude-sonnet-4-6",
    });
  });

  it("allows the main agent model ladder to be changed without code edits", () => {
    expect(resolveCaraModelConfig("agent", {
      CARA_AGENT_PROVIDER: "openai",
      CARA_AGENT_MODEL:    "gpt-5.4",
    })).toEqual({
      provider: "openai",
      model:    "gpt-5.4",
    });
  });

  it("honors an explicit anthropic override in a prod-shaped env (no VITEST/NODE_ENV=test)", () => {
    expect(resolveCaraModelConfig("agent", {
      CARA_AGENT_PROVIDER: "anthropic",
    })).toEqual({
      provider: "anthropic",
      model:    "claude-sonnet-4-6",
    });
  });

  it("falls back to the prod default when CARA_AGENT_PROVIDER is set but unrecognized", () => {
    expect(resolveCaraModelConfig("agent", {
      CARA_AGENT_PROVIDER: "not-a-real-provider",
    })).toEqual({
      provider: "openai",
      model:    "gpt-4o",
    });
  });

  it("treats NODE_ENV=test the same as VITEST for the agent tier's test-env default", () => {
    expect(resolveCaraModelConfig("agent", { NODE_ENV: "test" })).toEqual({
      provider: "anthropic",
      model:    "claude-sonnet-4-6",
    });
  });

  it("defaults low-cost quick and router tiers to gpt-4o-mini", () => {
    expect(resolveCaraModelConfig("quick", {})).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(resolveCaraModelConfig("router", {})).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("keeps Anthropic fallback enabled unless explicitly disabled", () => {
    expect(shouldFallbackAgentToAnthropic({})).toBe(true);
    expect(shouldFallbackAgentToAnthropic({ CARA_AGENT_ANTHROPIC_FALLBACK: "false" })).toBe(false);
  });
});
