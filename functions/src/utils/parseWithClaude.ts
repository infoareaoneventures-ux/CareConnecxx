import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Claude Haiku parser for extracting structured values from free-form user text.
 * Retries up to 3 times on parse errors before giving up.
 * Replaces the inline parseWithClaude defined in individual handler files.
 */

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

const MAX_ATTEMPTS = 3;

export async function parseWithClaude(
  systemPrompt: string,
  userText: string,
  maxTokens = 200
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await getClaude().messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages:   [{ role: "user", content: userText }],
      });
      const text = ((response.content[0] as { text: string }).text ?? "").trim();
      if (text && text !== "__parse_error__") return text;

      // On __parse_error__, retry with a clarifying hint
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 300 * attempt));
      }
    } catch {
      if (attempt === MAX_ATTEMPTS) return "__parse_error__";
      await new Promise(r => setTimeout(r, 300 * attempt));
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
