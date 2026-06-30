import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

type AnthropicTool = Anthropic.Tool & { cache_control?: unknown };

export interface OpenAiAgentTurnResult {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.Message["stop_reason"];
}

function systemToText(system: string | Anthropic.TextBlockParam[]): string {
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

function contentToToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) return String((block as { text?: unknown }).text ?? "");
        return JSON.stringify(block);
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function convertAnthropicMessages(messages: Anthropic.MessageParam[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      const toolCalls = message.content
        .filter((block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use")
        .map((block) => ({
          id:       block.id,
          type:     "function" as const,
          function: {
            name:      block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));
      out.push({
        role:       "assistant",
        content:    text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const textBlocks = message.content
      .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (textBlocks) out.push({ role: "user", content: textBlocks });

    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      out.push({
        role:         "tool",
        tool_call_id: block.tool_use_id,
        content:      contentToToolResultText(block.content),
      });
    }
  }

  return out;
}

function convertTools(tools: AnthropicTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type:     "function",
    function: {
      name:        tool.name,
      description: tool.description,
      parameters:  (tool.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { _rawArguments: raw };
  }
}

function finishReasonToStopReason(reason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"]): Anthropic.Message["stop_reason"] {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

export async function callOpenAiAgentTurn(params: {
  client: OpenAI;
  model: string;
  maxTokens: number;
  system: string | Anthropic.TextBlockParam[];
  tools: AnthropicTool[];
  toolChoice: "auto" | "none";
  messages: Anthropic.MessageParam[];
  signal?: AbortSignal;
}): Promise<OpenAiAgentTurnResult> {
  const tools = convertTools(params.tools);
  const res = await params.client.chat.completions.create(
    {
      model:      params.model,
      max_tokens: params.maxTokens,
      messages: [
        { role: "system", content: systemToText(params.system) },
        ...convertAnthropicMessages(params.messages),
      ],
      ...(tools.length ? { tools, tool_choice: params.toolChoice } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    { signal: params.signal },
  );

  const choice = res.choices[0];
  const message = choice?.message;
  const content: Anthropic.ContentBlock[] = [];
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  if (text) content.push({ type: "text", text } as Anthropic.TextBlock);

  for (const call of message?.tool_calls ?? []) {
    if (call.type !== "function") continue;
    content.push({
      type:  "tool_use",
      id:    call.id,
      name:  call.function.name,
      input: parseToolArguments(call.function.arguments),
    } as Anthropic.ToolUseBlock);
  }

  return {
    content,
    stop_reason: finishReasonToStopReason(choice?.finish_reason ?? "stop"),
  };
}

export const __test__ = {
  convertAnthropicMessages,
  convertTools,
};
