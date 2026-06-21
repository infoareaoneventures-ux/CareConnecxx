const BANNED_PHRASES: string[] = [
  "as an AI",
  "I cannot",
  "I am unable",
  "I don't have the ability",
  "I'm not able to",
  "rest assured",
  "at the end of the day",
  "moving forward",
  "in conclusion",
  "it's important to note",
  "please note that",
  "I want to make sure",
  "I hope this helps",
  "do not hesitate to",
  "feel free to",
  "leverage",
  "utilize",
  "synergy",
  "going forward",
  // Anti-sycophancy: robotic sympathy openers
  "I'm sorry to hear that",
  "I understand your frustration",
  "I understand how difficult",
  "Of course!",
  "Certainly!",
  "Absolutely!",
  "Let me know if you need anything else",
  "Let me know if there's anything else",
  "Is there anything else I can",
  // Bureaucratic / customer-service tone — Cara is a friend, not a clerk
  "Go ahead and share",
  "on file for you",
  "everything on file",
];

// Patterns that make text feel robotic or formal
const BANNED_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Em-dashes → comma
  { pattern: /\s*—\s*/g,                      replacement: ", " },
  // Trailing "Is there anything else I can help you with?"
  { pattern: /is there anything else (?:I can help(?: you)?(?: with)?|you(?:'d like to discuss)?)\??/gi, replacement: "" },
  // Sycophantic openers: "I understand" as sentence start → nothing (keep the rest)
  { pattern: /^I understand[,.]?\s*/i,         replacement: "" },
];

// Apply the banned-pattern and banned-phrase replacements. Shared by both
// lintMessage (collapses layout) and lintPreservingLayout (keeps layout).
function applyBans(text: string): string {
  let result = text;

  for (const { pattern, replacement } of BANNED_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  for (const phrase of BANNED_PHRASES) {
    // Case-insensitive, word-boundary-aware replacement
    const safePhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(safePhrase, "gi"), "");
  }

  return result;
}

export function lintMessage(text: string): string {
  let result = applyBans(text);

  // Clean up double spaces and leading/trailing whitespace left by replacements
  result = result.replace(/  +/g, " ").trim();

  // Remove lines that became empty after phrase removal
  result = result
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");

  return result;
}

/**
 * Layout-preserving variant of lintMessage. Applies the same em-dash and
 * banned-phrase cleanup, but KEEPS intentional blank lines (\n\n) instead of
 * collapsing them. Use this on multi-line transactional / scripted messages
 * (timesheets, OTP codes, intake summaries) where paragraph breaks carry
 * meaning — collapsing them the way lintMessage does would make those messages
 * cramped and harder to read.
 *
 * This is the function the outbound transport chokepoint uses so scripted /
 * hardcoded sends get the same voice cleanup the QA-agent path already gets via
 * supervise(), without flattening their formatting.
 */
export function lintPreservingLayout(text: string): string {
  let result = applyBans(text);

  // Per-line: collapse runs of spaces and trim trailing whitespace, but DON'T
  // drop blank lines — they separate paragraphs.
  result = result
    .split("\n")
    .map((l) => l.replace(/  +/g, " ").replace(/[ \t]+$/, ""))
    .join("\n");

  // Collapse 3+ consecutive newlines to a single blank line, then trim ends.
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}
