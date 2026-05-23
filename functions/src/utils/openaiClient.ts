/**
 * Shared OpenAI client for Cara's "fast path" Claude-equivalent calls.
 *
 * Cara is hybrid:
 *   - Short single-shot Haiku-equivalent calls (intent classification,
 *     YES/NO decisions, parseWithClaude extractions) go through this client
 *     to gpt-4o-mini. ~500ms typical, $0.15 per 1M input tokens.
 *   - The QA agent's tool-use loop stays on Claude Sonnet via claudeClient.ts.
 *
 * The shared instance has a 10s timeout and zero internal retries — our
 * retry/backoff logic lives in callers (parseWithClaude has its own loop).
 */

import OpenAI from "openai";

let _sharedClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!_sharedClient) {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      console.warn("openaiClient: OPENAI_API_KEY is not set — fast-path Claude calls will fail");
    }
    _sharedClient = new OpenAI({ apiKey, timeout: 10_000, maxRetries: 0 });
  }
  return _sharedClient;
}

/**
 * Convenience helper for short single-shot system+user prompts that mirrors
 * the shape Anthropic's `messages.create({ system, messages: [{ role: "user", content }] })`
 * was being used for. Returns the trimmed assistant text.
 *
 * Use this for any new fast-path call site instead of constructing the
 * OpenAI request shape inline.
 */
export async function quickComplete(
  systemPrompt: string,
  userText: string,
  opts?: { maxTokens?: number; model?: string; signal?: AbortSignal }
): Promise<string> {
  const res = await getOpenAIClient().chat.completions.create(
    {
      model:       opts?.model ?? "gpt-4o-mini",
      max_tokens:  opts?.maxTokens ?? 200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userText },
      ],
    },
    { signal: opts?.signal }
  );
  return (res.choices[0]?.message?.content ?? "").trim();
}
