import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveCaraModelConfig = vi.fn();
const shouldFallbackAgentToAnthropic = vi.fn();
const callOpenAiAgentTurn = vi.fn();
const callClaudeWithRetry = vi.fn();

vi.mock("../config/caraModels", () => ({
  resolveCaraModelConfig: (...args: unknown[]) => resolveCaraModelConfig(...args),
  shouldFallbackAgentToAnthropic: () => shouldFallbackAgentToAnthropic(),
}));
vi.mock("./openaiToolLoop", () => ({
  callOpenAiAgentTurn: (...args: unknown[]) => callOpenAiAgentTurn(...args),
}));
vi.mock("../utils/claudeRetry", () => ({
  callClaudeWithRetry: (...args: unknown[]) => callClaudeWithRetry(...args),
}));
vi.mock("../utils/claudeClient", () => ({
  getSharedClient: () => ({ __client: "anthropic" }),
}));
vi.mock("../utils/openaiClient", () => ({
  getOpenAIClient: () => ({ __client: "openai" }),
}));

import { runAgentModelTurn } from "./agentModelTurn";

const anthropicResponse = { stop_reason: "end_turn", content: [{ type: "text", text: "via anthropic" }] };
const openaiResponse = { stop_reason: "end_turn", content: [{ type: "text", text: "via openai" }] };

function baseParams(metrics: Record<string, unknown> = {}) {
  return {
    system: "SYSTEM",
    tools: [{ name: "t" }],
    forceTextReply: false,
    messages: [{ role: "user", content: "hi" }],
    metrics,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callClaudeWithRetry.mockResolvedValue(anthropicResponse);
  callOpenAiAgentTurn.mockResolvedValue(openaiResponse);
});

describe("runAgentModelTurn (production provider branch + fallback)", () => {
  it("routes through OpenAI when the agent tier resolves to openai, without touching Anthropic", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    const metrics: Record<string, unknown> = {};

    const res = await runAgentModelTurn(baseParams(metrics));

    expect(res).toBe(openaiResponse);
    expect(callOpenAiAgentTurn).toHaveBeenCalledTimes(1);
    expect(callClaudeWithRetry).not.toHaveBeenCalled();
    expect(metrics.modelProvider).toBe("openai");
    expect(metrics.modelUsed).toBe("gpt-5.4");
    expect(metrics.modelFallbackUsed).toBeUndefined();
  });

  it("falls back to Anthropic when OpenAI fails and fallback is enabled, flagging modelFallbackUsed", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    shouldFallbackAgentToAnthropic.mockReturnValue(true);
    callOpenAiAgentTurn.mockRejectedValue(new Error("openai down"));
    const metrics: Record<string, unknown> = {};

    const res = await runAgentModelTurn(baseParams(metrics));

    expect(res).toBe(anthropicResponse);
    expect(callClaudeWithRetry).toHaveBeenCalledTimes(1);
    expect(metrics.modelFallbackUsed).toBe(true);
    expect(metrics.modelProvider).toBe("anthropic");
    expect(metrics.modelUsed).toBe("claude-sonnet-4-6");
  });

  it("propagates the OpenAI error when fallback is disabled", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    shouldFallbackAgentToAnthropic.mockReturnValue(false);
    callOpenAiAgentTurn.mockRejectedValue(new Error("openai down"));
    const metrics: Record<string, unknown> = {};

    await expect(runAgentModelTurn(baseParams(metrics))).rejects.toThrow("openai down");
    expect(callClaudeWithRetry).not.toHaveBeenCalled();
    expect(metrics.modelFallbackUsed).toBeUndefined();
  });

  it("uses Anthropic directly when the agent tier resolves to anthropic", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const metrics: Record<string, unknown> = {};

    const res = await runAgentModelTurn(baseParams(metrics));

    expect(res).toBe(anthropicResponse);
    expect(callOpenAiAgentTurn).not.toHaveBeenCalled();
    expect(metrics.modelProvider).toBe("anthropic");
  });

  it("maps forceTextReply to each provider's tool-choice contract", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    await runAgentModelTurn({ ...baseParams(), forceTextReply: true });
    expect(callOpenAiAgentTurn.mock.calls[0][0]).toMatchObject({ toolChoice: "none" });

    resolveCaraModelConfig.mockReturnValue({ provider: "anthropic", model: "claude-sonnet-4-6" });
    await runAgentModelTurn({ ...baseParams(), forceTextReply: true });
    expect(callClaudeWithRetry.mock.calls[0][1]).toMatchObject({ tool_choice: { type: "none" } });
  });
});
