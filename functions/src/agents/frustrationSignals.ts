export interface FrustrationSignalInput {
  text: string;
  recentHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface FrustrationSignals {
  frustrationDetected: boolean;
  rephraseLoopDetected: boolean;
  repeatedGreetingDetected: boolean;
}

const FRUSTRATION_RE =
  /\b(annoyed|angry|mad|frustrated|horrible|terrible|useless|broken|not working|doesn'?t work|didn'?t work|wrong|stop|human|real person|agent|representative|why (are|aren'?t|isn'?t|won'?t)|you keep|same answer|again and again|still not|no link|didn'?t send|where'?s the link|what'?s going on)\b/i;

// "cara" kept alongside "evia": existing SMS users still greet by the old name.
const GREETING_RE = /^(hi|hey|hello|yo|cara|evia|(?:hey|hi|hello) (?:cara|evia))$/i;
const MIN_REPHRASE_CHARS = 18;

export function detectFrustrationSignals(input: FrustrationSignalInput): FrustrationSignals {
  const normalized = normalize(input.text);
  const recentUserMessages = (input.recentHistory ?? [])
    .filter(row => row.role === "user")
    .map(row => normalize(row.content))
    .filter(Boolean)
    .slice(-6);

  const frustrationDetected = FRUSTRATION_RE.test(input.text);
  const repeatedGreetingDetected =
    GREETING_RE.test(normalized) &&
    recentUserMessages.some(prev => prev === normalized || GREETING_RE.test(prev));

  const rephraseLoopDetected =
    normalized.length >= MIN_REPHRASE_CHARS &&
    recentUserMessages.some(prev =>
      prev.length >= MIN_REPHRASE_CHARS &&
      (prev === normalized || similarity(prev, normalized) >= 0.72),
    );

  return {
    frustrationDetected,
    rephraseLoopDetected,
    repeatedGreetingDetected,
  };
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a: string, b: string): number {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .split(" ")
      .filter(token => token.length > 2)
      .filter(token => !["the", "and", "you", "for", "that", "this", "with", "can", "could", "would"].includes(token)),
  );
}
