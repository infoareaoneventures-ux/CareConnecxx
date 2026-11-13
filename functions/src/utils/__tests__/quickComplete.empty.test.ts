import { describe, it, expect, vi, beforeEach } from "vitest";

// Wave 2 (2026-11-09): a quick check whose answer comes back EMPTY (a reasoning model spent its small allowance
// "thinking") is retried once with headroom, then handed to the Anthropic fallback, and always reported — it must
// never pass silently as "no emergency".

const h = vi.hoisted(() => ({
  create: vi.fn(),
  alert: vi.fn(async () => true),
  claude: vi.fn(),
  model: "gpt-5.4-mini",
}));

vi.mock("openai", () => ({ default: class { chat = { completions: { create: (...a: any[]) => (h.create as any)(...a) } }; } }));
vi.mock("langsmith/wrappers/openai", () => ({ wrapOpenAI: (c: unknown) => c }));
vi.mock("../claudeRetry", () => ({ callClaudeWithRetry: (...a: any[]) => (h.claude as any)(...a) }));
vi.mock("../../config/caraModels", () => ({ resolveCaraModelConfig: () => ({ model: h.model, provider: "openai" }) }));
vi.mock("../../observability/caraOpsAlerts", () => ({ createCaraOpsAlert: (...a: any[]) => (h.alert as any)(...a) }));
vi.mock("../../observability/providerFailureAlert", () => ({ raiseProviderFailureAlert: vi.fn(async () => {}) }));
vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }), { FieldValue: { increment: (n: number) => n } });
  return { __esModule: true, default: { firestore }, firestore };
});

import { quickComplete } from "../openaiClient";

const reply = (content: string | null, finish = "stop") => ({ choices: [{ message: { content }, finish_reason: finish }] });

beforeEach(() => {
  h.create.mockReset(); h.alert.mockClear(); h.claude.mockReset();
  process.env.OPENAI_API_KEY = "sk-test"; delete process.env.ANTHROPIC_API_KEY;
  h.model = "gpt-5.4-mini";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("quickComplete — empty answers", () => {
  it("a normal answer is returned with a single call and no alert", async () => {
    h.create.mockResolvedValueOnce(reply("  none "));
    expect(await quickComplete("sys", "hi", { maxTokens: 8 })).toBe("none");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("an EMPTY answer from a reasoning model is retried once with a bigger allowance, and the empty one is reported", async () => {
    h.create.mockResolvedValueOnce(reply("", "length")).mockResolvedValueOnce(reply("medical"));
    expect(await quickComplete("sys", "he is not breathing", { maxTokens: 8 })).toBe("medical");
    expect(h.create).toHaveBeenCalledTimes(2);
    const first = h.create.mock.calls[0][0], second = h.create.mock.calls[1][0];
    expect(first.max_completion_tokens).toBe(8);
    expect(second.max_completion_tokens).toBeGreaterThanOrEqual(512);
    await vi.waitFor(() => expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ type: "llm_quick_check_empty" })));
  });

  it("still empty after the retry → the Anthropic fallback answers", async () => {
    process.env.ANTHROPIC_API_KEY = "ak-test";
    h.create.mockResolvedValue(reply("", "length"));
    h.claude.mockResolvedValue({ content: [{ type: "text", text: "emotional" }] });
    expect(await quickComplete("sys", "text", { maxTokens: 8 })).toBe("emotional");
    expect(h.claude).toHaveBeenCalledTimes(1);
  });

  it("a non-reasoning model is not retried with a bigger allowance; the empty answer is logged every time, the ops alert is throttled to one per 10 minutes", async () => {
    h.model = "gpt-4o-mini";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.create.mockResolvedValueOnce(reply(""));
    expect(await quickComplete("sys", "text", { maxTokens: 8 })).toBe("");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cara.llm.empty"), expect.anything());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.alert).not.toHaveBeenCalled(); // the previous test already alerted within the window
  });
});
