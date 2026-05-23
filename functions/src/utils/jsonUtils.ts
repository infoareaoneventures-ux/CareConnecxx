/**
 * Tolerant JSON parsing for LLM output.
 *
 * Both Claude and gpt-4o-mini will occasionally wrap JSON in markdown code
 * fences (```json … ```) or add a stray sentence before the structure, even
 * when the prompt says "JSON only". Stock JSON.parse throws on those — and
 * because most call sites swallowed the throw silently, features all over
 * the codebase were dead for every user.
 *
 * Use unwrapJson() to clean LLM output before JSON.parse. Use safeParseJson()
 * when you also want the parse + fallback in one call.
 */

/**
 * Strip markdown fences and surrounding prose from an LLM JSON response.
 * Returns the inner JSON substring, or the original trimmed string if no
 * cleanup was needed.
 *
 * Pass `kind` to hint whether you expect an object or array — that lets the
 * extractor find the right braces even when the model emits explanatory prose.
 */
export function unwrapJson(raw: string, kind: "object" | "array" | "auto" = "auto"): string {
  let s = (raw ?? "").trim();
  if (!s) return "";

  // 1. Strip ```json ... ``` or ``` ... ``` fences
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  // 2. If extra prose precedes/follows the structure, slice to the outermost
  // braces. Pick the brace type based on `kind`, falling back to whichever
  // appears first if auto.
  const findRange = (open: string, close: string): [number, number] | null => {
    const start = s.indexOf(open);
    const end   = s.lastIndexOf(close);
    return start >= 0 && end > start ? [start, end] : null;
  };

  if (kind === "object") {
    const r = findRange("{", "}");
    if (r) s = s.slice(r[0], r[1] + 1);
  } else if (kind === "array") {
    const r = findRange("[", "]");
    if (r) s = s.slice(r[0], r[1] + 1);
  } else {
    const obj = findRange("{", "}");
    const arr = findRange("[", "]");
    // Prefer whichever opens first
    if (obj && arr) {
      s = obj[0] < arr[0] ? s.slice(obj[0], obj[1] + 1) : s.slice(arr[0], arr[1] + 1);
    } else if (obj) {
      s = s.slice(obj[0], obj[1] + 1);
    } else if (arr) {
      s = s.slice(arr[0], arr[1] + 1);
    }
  }

  return s.trim();
}

/**
 * Parse a JSON value from an LLM response with markdown / prose tolerance.
 * Returns `fallback` (default `null`) on any error and logs a warning so
 * silent failures stop disappearing. Pass `opName` so the log says which
 * caller failed.
 */
export function safeParseJson<T = unknown>(
  raw:      string,
  opName:   string,
  fallback: T | null = null,
  kind:     "object" | "array" | "auto" = "auto",
): T | null {
  const cleaned = unwrapJson(raw, kind);
  if (!cleaned) return fallback;
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    console.warn(`[safeParseJson:${opName}] JSON parse failed`, {
      preview: cleaned.slice(0, 200),
      err:     err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
