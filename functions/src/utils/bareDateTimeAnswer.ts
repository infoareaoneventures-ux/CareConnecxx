/**
 * Live-caught 2026-09-09: classifyIntentDetailed (intentClassifier.ts) sees
 * only the raw text with no conversation history, and misclassified bare
 * date/time answers ("9/11", "9/12", "12pm") as FACT_CORRECTION mid a
 * schedule_interview date/time ask — producing the nonsensical "I checked
 * what I have remembered, and I can't identify that memory" reply, or worse,
 * a false-positive match that claimed a (nonexistent) correction was staged.
 * A genuine fact correction always carries explanatory language per the
 * classifier's own few-shot examples ("actually mom is 82 not 78", "I meant
 * Tuesday not Monday") — a message that is ENTIRELY just a calendar date or a
 * clock time, with nothing else, cannot structurally carry that narrative.
 * This is a shape/format check (not intent parsing) used only to skip one
 * specific known misfire, matching the existing YES/NO-style carve-outs.
 */
export function isBareDateOrTimeAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{1,2}(:\d{2})?\s*(am|pm)|noon|midnight)$/i.test(trimmed);
}
