/**
 * Shared OpenAI client for Evia's "fast path" Claude-equivalent calls.
 *
 * Evia is hybrid:
 *   - Short single-shot Haiku-equivalent calls (intent classification,
 *     YES/NO decisions, parseWithClaude extractions) go through this client
 *     to the configured router model.
 *   - The QA agent's tool-use loop uses the configured agent model/provider.
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
import "../observability/tracingGuard"; // tracing off unless explicitly allowed (health information)
import { wrapOpenAI } from "langsmith/wrappers/openai";
import type Anthropic from "@anthropic-ai/sdk";
import { callClaudeWithRetry } from "./claudeRetry";
import { resolveCaraModelConfig } from "../config/caraModels";

// Anthropic model used only when the OpenAI fast path is unavailable. Haiku
// keeps the fallback cheap and fast, matching the single-shot fast-path role.
const FALLBACK_MODEL = "claude-haiku-4-5-20251001";

let _sharedClient: OpenAI | null = null;
let _geminiClient: OpenAI | null = null;

export function openAiTokenLimitParam(model: string, maxTokens: number): { max_tokens?: number; max_completion_tokens?: number } {
  // Newer GPT-5-family chat models reject max_tokens and require
  // max_completion_tokens. Older chat models still accept max_tokens.
  return /^gpt-5(?:[.-]|$)/i.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

export function getOpenAIClient(): OpenAI {
  if (!_sharedClient) {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      console.warn("openaiClient: OPENAI_API_KEY is not set — fast-path Claude calls will fail");
    }
    // wrapOpenAI instruments every chat.completions call for LangSmith tracing
    // when LANGSMITH_TRACING=true; transparent pass-through when disabled.
    _sharedClient = wrapOpenAI(new OpenAI({ apiKey, timeout: 10_000, maxRetries: 0 }));
  }
  return _sharedClient;
}

/**
 * Gemini through Google's OpenAI-compatible endpoint — used as the agent
 * loop's tier-3 fallback (see agentModelTurn.ts). Speaking the OpenAI wire
 * format lets it reuse callOpenAiAgentTurn (message conversion, 128-tool cap)
 * with zero Gemini-specific translation code. Reuses the GEMINI_API_KEY
 * already configured for embeddings.
 */
export function getGeminiOpenAIClient(): OpenAI {
  if (!_geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY ?? "";
    if (!apiKey) {
      console.warn("openaiClient: GEMINI_API_KEY is not set — Gemini agent fallback will fail");
    }
    _geminiClient = new OpenAI({
      apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      timeout: 15_000,
      maxRetries: 0,
    });
  }
  return _geminiClient;
}

/**
 * Convenience helper for short single-shot system+user prompts that mirrors
 * the shape Anthropic's `messages.create({ system, messages: [{ role: "user", content }] })`
 * was being used for. Returns the trimmed assistant text.
 *
 * Use this for any new fast-path call site instead of constructing the
 * OpenAI request shape inline.
 */
// Throttle for the fallback-activation provider alert — one alert per warm
// instance per 10 minutes, not one per failed quick-call during an outage.
let _lastFallbackAlertAt = 0;

// A quick check that comes back EMPTY (2026-11-09, fix plan Wave 2). GPT-5-family models count their hidden
// reasoning against the small output allowance these checks use (8-200 tokens), so the allowance can be spent
// "thinking" and the visible answer left empty — and an empty answer from the backup emergency check is read
// as "no emergency". An empty answer is now retried once with reasoning headroom, then handed to the Anthropic
// fallback, and every occurrence is logged and alerted (throttled) so it is never silent.
let _lastEmptyAlertAt = 0;
function reportEmptyQuickReply(model: string, finishReason: string | null | undefined, maxTokens: number): void {
  console.error("cara.llm.empty: quick check returned no text", { model, finishReason, maxTokens });
  void (async () => {
    try {
      if (Date.now() - _lastEmptyAlertAt < 10 * 60_000) return;
      _lastEmptyAlertAt = Date.now();
      const { createCaraOpsAlert } = await import("../observability/caraOpsAlerts");
      await createCaraOpsAlert({
        type: "llm_quick_check_empty",
        severity: "medium",
        source: "openaiClient",
        message: `A quick AI check (${model}) returned no text (finish: ${finishReason ?? "?"}, allowance: ${maxTokens} tokens). Reasoning may be using the allowance.`,
        context: { model, finishReason: finishReason ?? "unknown", maxTokens },
      });
    } catch { /* non-critical */ }
  })();
}

export async function quickComplete(
  systemPrompt: string,
  userText: string,
  opts?: { maxTokens?: number; model?: string; signal?: AbortSignal }
): Promise<string> {
  const maxTokens = opts?.maxTokens ?? 200;
  try {
    const model = opts?.model ?? resolveCaraModelConfig("router").model;
    const ask = (budget: number) => getOpenAIClient().chat.completions.create(
      {
        model,
        ...openAiTokenLimitParam(model, budget),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userText },
        ],
      },
      { signal: opts?.signal }
    );
    let res = await ask(maxTokens);
    let text = (res.choices[0]?.message?.content ?? "").trim();
    if (!text) {
      reportEmptyQuickReply(model, res.choices[0]?.finish_reason, maxTokens);
      if (/^gpt-5(?:[.-]|$)/i.test(model)) {
        // Reasoning models: give the answer room beside the hidden reasoning, once.
        res = await ask(Math.max(maxTokens * 8, 512));
        text = (res.choices[0]?.message?.content ?? "").trim();
      }
      if (!text && process.env.ANTHROPIC_API_KEY && !opts?.signal?.aborted) {
        return anthropicFallback(systemPrompt, userText, maxTokens, new Error("OpenAI returned an empty completion"));
      }
    }
    return text;
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
  // The console.warn above is invisible in practice — "quietly running on the
  // paid fallback for days" was a real audit finding. Raise the typed provider
  // alert (billing/auth classes page the founder), throttled per instance so
  // an outage doesn't write an alert per quick-call, and bump a daily fallback
  // counter (every activation) so the fallback RATE is queryable. All
  // fire-and-forget: alerting must never add latency to the fallback itself.
  void (async () => {
    try {
      if (Date.now() - _lastFallbackAlertAt > 10 * 60_000) {
        _lastFallbackAlertAt = Date.now();
        const { raiseProviderFailureAlert } = await import("../observability/providerFailureAlert");
        await raiseProviderFailureAlert({ provider: "openai", model: "fast-path", error: openaiErr, hasFallback: true });
      }
      const adminMod = await import("firebase-admin");
      await adminMod.firestore()
        .collection("ops_counters")
        .doc(`llm_fallback_${new Date().toISOString().slice(0, 10)}`)
        .set(
          { count: adminMod.firestore.FieldValue.increment(1), updatedAt: new Date().toISOString() },
          { merge: true }
        );
    } catch { /* non-critical */ }
  })();
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
