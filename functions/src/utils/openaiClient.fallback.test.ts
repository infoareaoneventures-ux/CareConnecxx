import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the OpenAI client's create() and the Anthropic retry helper so we can
// drive each provider's success/failure independently.
const openaiCreate = vi.fn();
vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: (...args: unknown[]) => openaiCreate(...args) } };
  },
}));

const callClaudeWithRetry = vi.fn();
vi.mock("./claudeRetry", () => ({
  callClaudeWithRetry: (...args: unknown[]) => callClaudeWithRetry(...args),
}));

import { quickComplete } from "./openaiClient";

const OK_OPENAI = { choices: [{ message: { content: "  openai-result  " } }] };
const OK_ANTHROPIC = { content: [{ type: "text", text: "anthropic-result" }] };

describe("quickComplete cross-provider fallback", () => {
  beforeEach(() => {
    openaiCreate.mockReset();
    callClaudeWithRetry.mockReset();
    // Set both so getOpenAIClient never logs its missing-key warning, keeping
    // the fallback-log assertion below clean.
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
  });

  it("returns the OpenAI result and never calls Anthropic on success", async () => {
    openaiCreate.mockResolvedValue(OK_OPENAI);
    const out = await quickComplete("sys", "user");
    expect(out).toBe("openai-result");
    expect(callClaudeWithRetry).not.toHaveBeenCalled();
  });

  it("falls back to Anthropic Haiku when OpenAI throws", async () => {
    openaiCreate.mockRejectedValue(new Error("openai down"));
    callClaudeWithRetry.mockResolvedValue(OK_ANTHROPIC);

    const out = await quickComplete("sys", "user", { maxTokens: 5 });

    expect(out).toBe("anthropic-result");
    expect(callClaudeWithRetry).toHaveBeenCalledTimes(1);
    const params = callClaudeWithRetry.mock.calls[0][1] as {
      model: string; system: string; max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(params.model).toContain("haiku");
    expect(params.system).toBe("sys");
    expect(params.max_tokens).toBe(5);
    expect(params.messages[0]).toMatchObject({ role: "user", content: "user" });
  });

  it("propagates the original error when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    openaiCreate.mockRejectedValue(new Error("openai down"));
    await expect(quickComplete("sys", "user")).rejects.toThrow("openai down");
    expect(callClaudeWithRetry).not.toHaveBeenCalled();
  });

  it("propagates when both providers fail so the caller fail-safe triggers", async () => {
    openaiCreate.mockRejectedValue(new Error("openai down"));
    callClaudeWithRetry.mockRejectedValue(new Error("anthropic down"));
    await expect(quickComplete("sys", "user")).rejects.toThrow("anthropic down");
  });

  it("does not fall back when the caller aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    openaiCreate.mockRejectedValue(new Error("aborted"));
    await expect(
      quickComplete("sys", "user", { signal: ctrl.signal })
    ).rejects.toThrow();
    expect(callClaudeWithRetry).not.toHaveBeenCalled();
  });

  it("logs the cara.llm.fallback activation marker exactly once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    openaiCreate.mockRejectedValue(new Error("openai down"));
    callClaudeWithRetry.mockResolvedValue(OK_ANTHROPIC);

    await quickComplete("sys", "user");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("cara.llm.fallback");
    warn.mockRestore();
  });
});
