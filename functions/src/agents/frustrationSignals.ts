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

// Agent "broken record" detection (ch10 — the confirm-name-loop class of bug).
// Mirror of the USER-side rephrase-loop check, but pointed at EVIA'S OWN recent
// outbound messages: if the reply she's about to send is a near-duplicate of
// something she just said, that's the pathological loop — break it (vary or
// escalate) instead of texting the same thing twice. Uses the same Jaccard
// helper as the user-side detector so the threshold behaviour matches.
//
// candidate = the about-to-send reply; recentHistory = the loaded turn history.
// excludeSynthetic drops the getConversationHistory summary-doc line (a fixed
// "Got it - I have context…" assistant string that would false-positive).
const SELF_REPEAT_THRESHOLD = 0.8; // stricter than the user-side 0.72: Evia
// legitimately reuses phrasing across a conversation; only near-identical
// consecutive sends are the loop we want to catch.
// Matched against the NORMALIZED text, so no punctuation (normalize strips the
// "-" in the real "Got it - I have context…" summary line).
const SYNTHETIC_SUMMARY_PREFIX = "got it i have context";

export function detectAgentSelfRepeat(
  candidate: string,
  recentHistory?: Array<{ role: "user" | "assistant"; content: string }>,
): { repeated: boolean; matchedPrior?: string; score?: number } {
  const normalized = normalize(candidate);
  if (normalized.length < MIN_REPHRASE_CHARS) return { repeated: false };

  const recentAssistant = (recentHistory ?? [])
    .filter(row => row.role === "assistant")
    .map(row => ({ raw: row.content, norm: normalize(row.content) }))
    .filter(row => row.norm.length >= MIN_REPHRASE_CHARS)
    .filter(row => !row.norm.startsWith(SYNTHETIC_SUMMARY_PREFIX))
    .slice(-4);

  for (const prev of recentAssistant) {
    const score = prev.norm === normalized ? 1 : similarity(prev.norm, normalized);
    if (score >= SELF_REPEAT_THRESHOLD) {
      return { repeated: true, matchedPrior: prev.raw, score };
    }
  }
  return { repeated: false };
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
