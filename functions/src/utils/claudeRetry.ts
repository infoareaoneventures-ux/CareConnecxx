import type Anthropic from "@anthropic-ai/sdk";
import { getSharedClient, type AnthropicLike } from "./claudeClient";

// Retryable Anthropic SDK error class names (also covers Vertex AI HTTP retries via axios)
const RETRYABLE_ERRORS = new Set([
  "APIConnectionError",
  "RateLimitError",
  "OverloadedError",
  "InternalServerError",
  "APIUserAbortError",  // our AbortController fired — timeout; retry with same budget
]);

// InternalServerError covers 529 (overloaded) — back off the same as rate limit
const RATE_LIMIT_ERRORS = new Set(["RateLimitError", "OverloadedError", "InternalServerError"]);

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) return RETRYABLE_ERRORS.has(err.constructor.name);
  // axios errors from Vertex AI: retry on 429/500/503
  if (err && typeof err === "object" && "response" in err) {
    const status = (err as { response?: { status?: number } }).response?.status ?? 0;
    return status === 429 || status >= 500;
  }
  return false;
}

function isRateLimit(err: unknown): boolean {
  if (err instanceof Error) return RATE_LIMIT_ERRORS.has(err.constructor.name);
  if (err && typeof err === "object" && "response" in err) {
    const status = (err as { response?: { status?: number } }).response?.status ?? 0;
    return status === 429 || status === 529 || status === 503;
  }
  return false;
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name === "CanceledError" ||
    err.constructor.name.includes("Abort") ||
    err.constructor.name.includes("Cancel")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Call Claude with automatic retry + per-attempt timeout.
 *
 * The `client` parameter is kept for backward compatibility but is no longer
 * used — all calls route through getSharedClient() (Vertex AI) to avoid
 * Anthropic direct-API overload (529) issues.
 */
export async function callClaudeWithRetry(
  client: AnthropicLike | Anthropic | null | undefined,
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts?: { timeoutMs?: number; maxAttempts?: number }
): Promise<Anthropic.Message> {
  void client; // always use the shared Anthropic client
  const activeClient = getSharedClient();
  const timeoutMs   = opts?.timeoutMs   ?? 30_000;
  const maxAttempts = opts?.maxAttempts ?? 3;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await activeClient.messages.create(params, { signal: controller.signal });
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (!isAbortError(err) && !isRetryable(err)) throw err;
      if (attempt < maxAttempts - 1) {
        // Rate limit / overload → longer back-off (1s → 4s → 16s)
        // Connection / abort   → shorter back-off (300ms → 600ms → 1.2s)
        const delay = isRateLimit(err)
          ? Math.min(1_000 * Math.pow(4, attempt), 16_000) + Math.random() * 500
          : Math.min(300 * Math.pow(2, attempt), 8_000) + Math.random() * 100;
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

export async function safeCallClaude(
  client: AnthropicLike | Anthropic | null | undefined,
  params: Anthropic.MessageCreateParamsNonStreaming,
  fallback: string,
  opts?: { timeoutMs?: number }
): Promise<string> {
  try {
    const result = await callClaudeWithRetry(client, params, {
      timeoutMs:   opts?.timeoutMs ?? 30_000,
      maxAttempts: 2,
    });
    return ((result.content[0] as { text: string }).text ?? "").trim() || fallback;
  } catch {
    return fallback;
  }
}
