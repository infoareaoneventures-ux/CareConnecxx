// Long texts, split by us (2026-11-14, live text test over Call.com): a ~640-character services list reached the
// phone as two bubbles, the second ("ion … Tidying & Laundry") BEFORE the first and the cut in the middle of a word
// ("Supervis" + "ion"). Over plain SMS the carrier splits long messages by itself and the pieces can arrive in any
// order. We split first, at a paragraph / line / sentence / space — never inside a word — and the sender sends the
// pieces one at a time with a pause (client.ts), so they arrive in order.

export const SMS_CHUNK_MAX = 420;

function cutAt(text: string, max: number): number {
  const window = text.slice(0, max + 1);
  const para = window.lastIndexOf("\n\n");
  if (para >= max * 0.4) return para;
  const line = window.lastIndexOf("\n");
  if (line >= max * 0.4) return line;
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (sentence >= max * 0.4) return sentence + 1;
  const space = window.lastIndexOf(" ");
  if (space >= max * 0.4) return space;
  return max; // one unbroken run longer than max: the only case that cuts a word
}

/** The text as bubbles of at most `max` characters, split at the best boundary; a short text comes back as is. */
export function splitForSms(text: string, max: number = SMS_CHUNK_MAX): string[] {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t ? [t] : [];
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    const at = cutAt(rest, max);
    const piece = rest.slice(0, at).trim();
    if (piece) out.push(piece);
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Straight double quotes become typographic ones (2026-11-14, live text test over SMS): the recap's note and "show my
 * jobs" arrived as \"…\" with literal backslashes — the SMS path escapes a straight quote — while the same text over
 * iMessage was clean. Curly quotes are not escaped, and read better.
 */
export function curlyQuotes(text: string): string {
  return String(text ?? "").replace(/"([^"\n]*)"/g, "\u201C$1\u201D");
}
