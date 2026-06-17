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
 *
 * Cross-provider resilience: every fast-path call funnels through
 * `quickComplete`, which falls back to Anthropic Haiku if OpenAI errors or
 * times out. This means a single-provider (OpenAI) outage no longer removes
 * the crisis backstop in `crisisDetector` or breaks every `parseWithClaude`
 * handler — both providers must be down before the fast path fails.
 */

import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { callClaudeWithRetry } from "./claudeRetry";

// Anthropic model used only when the OpenAI fast path is unavailable. Haiku
// keeps the fallback cheap and fast, matching the single-shot fast-path role.
const FALLBACK_MODEL = "claude-haiku-4-5-20251001";

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
  const maxTokens = opts?.maxTokens ?? 200;
  try {
    const res = await getOpenAIClient().chat.completions.create(
      {
        model:       opts?.model ?? "gpt-4o-mini",
        max_tokens:  maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userText },
        ],
      },
      { signal: opts?.signal }
    );
    return (res.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    // The caller explicitly cancelled — honor the abort rather than spending
    // the fallback budget on work the caller no longer wants.
    if (opts?.signal?.aborted) throw err;
    // No second provider configured — propagate so the caller's own fail-safe
    // (e.g. crisisDetector returning "crisis") still triggers.
    if (!process.env.ANTHROPIC_API_KEY) throw err;
    return anthropicFallback(systemPrompt, userText, maxTokens, err);
  }
}

/**
 * Last-resort fast-path completion via Anthropic Haiku, used only when the
 * OpenAI call above fails. Mirrors `quickComplete`'s system+user shape and
 * returns the trimmed assistant text. Logs a recognizable activation marker
 * (`cara.llm.fallback`) so a single-provider OpenAI outage is observable
 * rather than silent.
 */
async function anthropicFallback(
  systemPrompt: string,
  userText: string,
  maxTokens: number,
  openaiErr: unknown
): Promise<string> {
  console.warn(
    "cara.llm.fallback: OpenAI fast path failed, falling back to Anthropic Haiku —",
    (openaiErr as Error)?.message ?? openaiErr
  );
  const msg = await callClaudeWithRetry(
    null,
    {
      model:      FALLBACK_MODEL,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userText }],
    },
    { timeoutMs: 8_000, maxAttempts: 2 }
  );
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
