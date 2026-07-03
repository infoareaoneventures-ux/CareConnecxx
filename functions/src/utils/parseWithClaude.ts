import { quickComplete } from "./openaiClient";

/**
 * Shared structured-extraction helper for Evia handlers.
 *
 * **The function name is historical** — the underlying model is now
 * `gpt-4o-mini` for speed and lower rate-limit pressure. Public API
 * is unchanged so every caller continues to work without edits.
 *
 * Returns the trimmed assistant text, or `__parse_error__` after
 * MAX_ATTEMPTS unsuccessful tries. Callers should validate the return
 * value against their expected set of allowed answers.
 */

const MAX_ATTEMPTS = 3;
const PER_ATTEMPT_TIMEOUT_MS = 8_000;

export async function parseWithClaude(
  systemPrompt: string,
  userText: string,
  maxTokens = 200
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);

    try {
      const text = await quickComplete(systemPrompt, userText, {
        maxTokens,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (text && text !== "__parse_error__") return text;

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    } catch {
      clearTimeout(timer);
      if (attempt === MAX_ATTEMPTS) return "__parse_error__";
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  return "__parse_error__";
}

/**
 * Parse and validate against an allowed-values set in one step.
 * Returns the matched value or `fallback` if parsing fails.
 */
export async function parseAndValidate<T extends string>(
  systemPrompt: string,
  userText: string,
  allowedValues: readonly T[],
  fallback: T
): Promise<T> {
  const raw = await parseWithClaude(systemPrompt, userText);
  return (allowedValues as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
