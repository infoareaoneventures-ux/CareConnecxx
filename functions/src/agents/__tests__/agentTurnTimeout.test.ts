import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({}) }, firestore: () => ({}) }));

// Wave 2 (2026-11-09): the main agent call has its own 28-second limit; it used the shared client's 10 seconds.
import { callOpenAiAgentTurn } from "../openaiToolLoop";
import { AGENT_TURN_TIMEOUT_MS } from "../agentModelTurn";

describe("agent turn time limit", () => {
  it("is 28 seconds, and callOpenAiAgentTurn hands it to the request as a per-call timeout", async () => {
    expect(AGENT_TURN_TIMEOUT_MS).toBe(28_000);
    const create = vi.fn(async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: {} }));
    await callOpenAiAgentTurn({ client: { chat: { completions: { create } } } as any, model: "gpt-5.4", maxTokens: 100, system: "s", tools: [], toolChoice: "auto", messages: [], timeoutMs: AGENT_TURN_TIMEOUT_MS });
    expect((create.mock.calls[0] as any)[1]).toMatchObject({ timeout: 28_000 });
  });

  it("without timeoutMs nothing is overridden", async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: {} }));
    await callOpenAiAgentTurn({ client: { chat: { completions: { create } } } as any, model: "gpt-5.4", maxTokens: 100, system: "s", tools: [], toolChoice: "auto", messages: [] });
    expect((create.mock.calls[0] as any)[1].timeout).toBeUndefined();
  });
});
