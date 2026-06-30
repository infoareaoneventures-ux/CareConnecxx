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

  it("defaults low-cost quick and router tiers to gpt-4o-mini", () => {
    expect(resolveCaraModelConfig("quick", {})).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(resolveCaraModelConfig("router", {})).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("keeps Anthropic fallback enabled unless explicitly disabled", () => {
    expect(shouldFallbackAgentToAnthropic({})).toBe(true);
    expect(shouldFallbackAgentToAnthropic({ CARA_AGENT_ANTHROPIC_FALLBACK: "false" })).toBe(false);
  });
});
