import { describe, expect, it } from "vitest";
import { resolveCaraModelConfig, shouldFallbackAgentToAnthropic } from "./caraModels";

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
