import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { __test__, callOpenAiAgentTurn } from "./openaiToolLoop";

describe("openaiToolLoop", () => {
  it("converts Anthropic tool results into OpenAI tool messages", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Book care" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "quote_booking",
          input: { caregiverId: "cg1" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: "Quote is $120",
        }],
      },
    ];

    expect(__test__.convertAnthropicMessages(messages)).toEqual([
      { role: "user", content: "Book care" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "quote_booking",
            arguments: "{\"caregiverId\":\"cg1\"}",
          },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Quote is $120" },
    ]);
  });

  it("returns Anthropic-shaped tool_use blocks for the existing Cara loop", async () => {
    const create = vi.fn(async () => ({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "call_abc",
            type: "function",
            function: {
              name: "get_care_plan",
              arguments: "{\"seniorId\":\"senior-1\"}",
            },
          }],
        },
      }],
    }));

    const result = await callOpenAiAgentTurn({
      client: { chat: { completions: { create } } } as any,
      model: "gpt-4o",
      maxTokens: 200,
      system: "You are Cara.",
      tools: [{
        name: "get_care_plan",
        description: "Read care plan",
        input_schema: { type: "object", properties: { seniorId: { type: "string" } } },
      } as any],
      toolChoice: "auto",
      messages: [{ role: "user", content: "How is mom?" }],
    });

    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toEqual([{
      type: "tool_use",
      id: "call_abc",
      name: "get_care_plan",
      input: { seniorId: "senior-1" },
    }]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-4o",
      max_tokens: 200,
      tool_choice: "auto",
    }), expect.any(Object));
  });

  it("uses max_completion_tokens for GPT-5-family agent models", async () => {
    const create = vi.fn(async () => ({
      choices: [{
        finish_reason: "stop",
        message: { content: "Done.", tool_calls: [] },
      }],
    }));

    await callOpenAiAgentTurn({
      client: { chat: { completions: { create } } } as any,
      model: "gpt-5.4",
      maxTokens: 300,
      system: "You are Cara.",
      tools: [],
      toolChoice: "auto",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(create.mock.calls[0][0]).toMatchObject({
      model: "gpt-5.4",
      max_completion_tokens: 300,
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty("max_tokens");
  });

  it("omits OpenAI tools fields when no active tools are available", async () => {
    const create = vi.fn(async () => ({
      choices: [{
        finish_reason: "stop",
        message: { content: "I can help with that.", tool_calls: [] },
      }],
    }));

    await callOpenAiAgentTurn({
      client: { chat: { completions: { create } } } as any,
      model: "gpt-4o",
      maxTokens: 200,
      system: "You are Cara.",
      tools: [],
      toolChoice: "auto",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(create.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(create.mock.calls[0][0]).not.toHaveProperty("tool_choice");
  });
});
