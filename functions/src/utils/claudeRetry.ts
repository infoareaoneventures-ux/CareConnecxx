import Anthropic from "@anthropic-ai/sdk";

const RETRYABLE_ERRORS = new Set([
  "APIConnectionError",
  "RateLimitError",
  "OverloadedError",
  "InternalServerError",
]);

const RATE_LIMIT_ERRORS = new Set(["RateLimitError", "OverloadedError"]);

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) return RETRYABLE_ERRORS.has(err.constructor.name);
  return false;
}

function isRateLimit(err: unknown): boolean {
  if (err instanceof Error) return RATE_LIMIT_ERRORS.has(err.constructor.name);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function callClaudeWithRetry(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts?: { timeoutMs?: number; maxAttempts?: number }
): Promise<Anthropic.Message> {
  const timeoutMs   = opts?.timeoutMs   ?? 25_000;
  const maxAttempts = opts?.maxAttempts ?? 3;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await client.messages.create(params, { signal: controller.signal });
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort && !isRetryable(err)) throw err;
      if (attempt < maxAttempts - 1) {
        // Rate limit / overload errors need longer back-off (1s → 4s → 16s)
        // Connection errors use shorter back-off (200ms → 400ms → 800ms)
        const delay = isRateLimit(err)
          ? Math.min(1_000 * Math.pow(4, attempt), 16_000) + Math.random() * 500
          : Math.min(200 * Math.pow(2, attempt), 8_000) + Math.random() * 100;
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

export async function safeCallClaude(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  fallback: string,
  opts?: { timeoutMs?: number }
): Promise<string> {
  try {
    const result = await callClaudeWithRetry(client, params, {
      timeoutMs:   opts?.timeoutMs ?? 25_000,
      maxAttempts: 2,
    });
    return ((result.content[0] as { text: string }).text ?? "").trim() || fallback;
  } catch {
    return fallback;
  }
}
