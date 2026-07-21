import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveCaraModelConfig = vi.fn();
const shouldFallbackAgentToAnthropic = vi.fn();
const shouldFallbackAgentToGemini = vi.fn();
const resolveGeminiAgentModel = vi.fn(() => "gemini-2.5-flash");
const callOpenAiAgentTurn = vi.fn();
const callClaudeWithRetry = vi.fn();

vi.mock("../config/caraModels", () => ({
  resolveCaraModelConfig: (...args: unknown[]) => resolveCaraModelConfig(...args),
  shouldFallbackAgentToAnthropic: () => shouldFallbackAgentToAnthropic(),
  shouldFallbackAgentToGemini: () => shouldFallbackAgentToGemini(),
  resolveGeminiAgentModel: () => resolveGeminiAgentModel(),
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
  getGeminiOpenAIClient: () => ({ __client: "gemini" }),
}));
const raiseProviderFailureAlert = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../observability/providerFailureAlert", () => ({
  raiseProviderFailureAlert: (...a: unknown[]) => raiseProviderFailureAlert(...a),
  classifyProviderError: () => "other",
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
  shouldFallbackAgentToGemini.mockReturnValue(false);
  resolveGeminiAgentModel.mockReturnValue("gemini-2.5-flash");
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

  it("falls back to Anthropic when OpenAI fails and Gemini is disabled, flagging modelFallbackUsed", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    shouldFallbackAgentToAnthropic.mockReturnValue(true);
    shouldFallbackAgentToGemini.mockReturnValue(false);
    callOpenAiAgentTurn.mockRejectedValue(new Error("openai down"));
    const metrics: Record<string, unknown> = {};

    const res = await runAgentModelTurn(baseParams(metrics));

    expect(res).toBe(anthropicResponse);
    expect(callClaudeWithRetry).toHaveBeenCalledTimes(1);
    expect(metrics.modelFallbackUsed).toBe(true);
    expect(metrics.modelProvider).toBe("anthropic");
    expect(metrics.modelUsed).toBe("claude-sonnet-4-6");
  });

  it("prefers Gemini as tier 2 when OpenAI fails and both fallbacks are enabled", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    shouldFallbackAgentToAnthropic.mockReturnValue(true);
    shouldFallbackAgentToGemini.mockReturnValue(true);
    resolveGeminiAgentModel.mockReturnValue("gemini-2.5-pro");
    const geminiResponse = { stop_reason: "end_turn", content: [{ type: "text", text: "via gemini" }] };
    callOpenAiAgentTurn
      .mockRejectedValueOnce(new Error("openai down"))
      .mockResolvedValueOnce(geminiResponse);
    const metrics: Record<string, unknown> = {};

    const res = await runAgentModelTurn(baseParams(metrics));

    expect(res).toBe(geminiResponse);
    expect(callClaudeWithRetry).not.toHaveBeenCalled();
    expect(callOpenAiAgentTurn.mock.calls[1][0]).toMatchObject({
      client: { __client: "gemini" },
      model: "gemini-2.5-pro",
    });
    expect(metrics.modelProvider).toBe("gemini");
    expect(metrics.modelUsed).toBe("gemini-2.5-pro");
    expect(metrics.modelFallbackUsed).toBe(true);
  });

  it("propagates the OpenAI error when both fallbacks are disabled", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    shouldFallbackAgentToAnthropic.mockReturnValue(false);
    shouldFallbackAgentToGemini.mockReturnValue(false);
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

  it("falls through to Anthropic tier 3 when BOTH OpenAI and Gemini fail", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    shouldFallbackAgentToAnthropic.mockReturnValue(true);
    shouldFallbackAgentToGemini.mockReturnValue(true);
    callOpenAiAgentTurn
      .mockRejectedValueOnce(new Error("400 tools array too long"))
      .mockRejectedValueOnce(new Error("gemini 503"));
    const metrics: Record<string, unknown> = {};

    const res = await runAgentModelTurn(baseParams(metrics));

    expect(res).toBe(anthropicResponse);
    expect(callOpenAiAgentTurn).toHaveBeenCalledTimes(2); // gpt-5.4 + gemini
    expect(callClaudeWithRetry).toHaveBeenCalledTimes(1);
    expect(metrics.modelProvider).toBe("anthropic");
    expect(metrics.modelUsed).toBe("claude-sonnet-4-6");
    expect(metrics.modelFallbackUsed).toBe(true);
    // Both upstream failures raised typed provider alerts
    expect(raiseProviderFailureAlert).toHaveBeenCalledTimes(2);
  });

  it("propagates the Gemini error when the Anthropic fallback is disabled", async () => {
    resolveCaraModelConfig.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    shouldFallbackAgentToAnthropic.mockReturnValue(false);
    shouldFallbackAgentToGemini.mockReturnValue(true);
    callOpenAiAgentTurn
      .mockRejectedValueOnce(new Error("openai down"))
      .mockRejectedValueOnce(new Error("gemini down"));

    await expect(runAgentModelTurn(baseParams())).rejects.toThrow("gemini down");
    expect(callClaudeWithRetry).not.toHaveBeenCalled();
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
