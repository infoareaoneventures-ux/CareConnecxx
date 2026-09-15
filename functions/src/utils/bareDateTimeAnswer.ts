/**
 * Live-caught 2026-09-09: classifyIntentDetailed (intentClassifier.ts) sees
 * only the raw text with no conversation history, and misclassified bare
 * date/time answers ("9/11", "9/12", "12pm") as FACT_CORRECTION mid a
 * schedule_interview date/time ask — producing the nonsensical "I checked
 * what I have remembered, and I can't identify that memory" reply, or worse,
 * a false-positive match that claimed a (nonexistent) correction was staged.
 * A genuine fact correction always carries explanatory language per the
 * classifier's own few-shot examples ("actually mom is 82 not 78", "I meant
 * Tuesday not Monday") — a message that is ENTIRELY just a date/time answer,
 * with nothing else, cannot structurally carry that narrative. This is a
 * shape/format check (not intent parsing) used only to skip one specific
 * known misfire, matching the existing YES/NO-style carve-outs.
 *
 * First pass only covered a BARE date or a BARE time ("9/11", "12pm").
 * Live-caught again the same night: the natural combined phrasing people
 * actually use ("9/11 at 10AM", "at 11am") still fell through the gap and
 * hit the same misfire — widened to cover DATE [at TIME] and [at] TIME.
 */
const DATE_SRC = String.raw`\d{1,2}\/\d{1,2}(?:\/\d{2,4})?`;
const TIME_SRC = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight`;
const BARE_DATE_OR_TIME_RE = new RegExp(
  `^(?:(?:${DATE_SRC})(?:\\s+at\\s+(?:${TIME_SRC}))?|(?:at\\s+)?(?:${TIME_SRC}))$`,
  "i",
);

export function isBareDateOrTimeAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return BARE_DATE_OR_TIME_RE.test(trimmed);
}

// Same misfire, yes/no-shaped (live-caught 2026-09-14): Evia asked "Do you
// want me to move Tuesday's visit to a new time?", the family replied "yes",
// and the per-turn fact-change detector staged it as a memory correction —
// "I can't identify that memory" — instead of the turn continuing. A message
// that is ENTIRELY a bare confirm/decline word cannot carry a correction.
// Mirrors approvalHandler.ts's TRIVIAL_YES/TRIVIAL_NO (kept as a local copy —
// importing approvalHandler from utils would pull in mcp/server and cycle).
const BARE_YES_NO = new Set([
  "YES", "Y", "YEAH", "YEP", "YUP", "OK", "OKAY", "SURE", "CONFIRM", "CONFIRMED",
  "GO AHEAD", "DO IT", "GO", "PROCEED", "APPROVED",
  "NO", "N", "NOPE", "NAH", "STOP", "WAIT", "CANCEL", "DON'T", "DONT", "NEVER MIND",
  "NEVERMIND", "ACTUALLY NO", "FORGET IT",
]);

export function isBareYesNoAnswer(text: string): boolean {
  return BARE_YES_NO.has(text.trim().toUpperCase().replace(/[.!?]+$/g, ""));
}
