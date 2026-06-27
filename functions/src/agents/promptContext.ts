const INSTRUCTION_LIKE_LINES = [
  /\bignore\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/gi,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\bact\s+as\b/gi,
  /\b(?:system|developer|assistant|user|tool)\s*:/gi,
];

export function sanitizePromptContext(input: unknown, max = 2000): string {
  const raw = typeof input === "string" ? input : String(input ?? "");
  const stripped = raw
    .replace(/<\/?(?:system|assistant|human|user|instruction|instructions|prompt|context|tool|developer)\b[^>]*>/gi, " ")
    .replace(/\[(?:SYSTEM|ASSISTANT|HUMAN|USER|INST|\/INST|SYS|\/SYS|DEVELOPER|TOOL)\]/gi, " ")
    .replace(/<\|(?:im_start|im_end|endoftext)\|>/gi, " ")
    .replace(/\|\s*(?:im_start|im_end|endoftext)\s*\|/gi, " ");

  const neutralized = INSTRUCTION_LIKE_LINES.reduce(
    (text, pattern) => text.replace(pattern, "[user-authored instruction removed]"),
    stripped,
  );

  return neutralized
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export function sanitizePromptContextValue(input: unknown, max = 160): string | undefined {
  const sanitized = sanitizePromptContext(input, max);
  return sanitized || undefined;
}
