// Structural PII redaction for outbound messages (U10).
//
// Moved out of utils/outboundGuard.ts and into the transport so EVERY outbound
// path redacts — not just the runQuickReply fast path. normalizeParts (the Linq
// transport chokepoint every message crosses) calls this, so scripted sends and
// sendToPhone-initiated chats are now covered too. qaAgent still calls it before
// SAVING a turn, so PII never lands in conversation history either.
//
// Design rules (unchanged from the former outboundGuard):
//   - FAIL OPEN: redaction never blocks a send; it only scrubs values.
//   - Format regexes only — structural PII detection, NOT intent parsing of
//     user text, so regex is allowed here (see CLAUDE.md).
//   - Never log the redacted values themselves — only counts/kinds.

const REDACTED = "[redacted]";

export interface RedactResult {
  text:       string;
  redactions: string[];
}

// SSN: exactly 3-2-4 with dashes. Word boundaries prevent matching inside
// longer digit runs (e.g. tracking numbers).
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

// Candidate card number: 13–16 digits, optionally separated by single spaces
// or dashes. Runs of 12 or fewer digits (phone numbers, 10-digit booking refs,
// "call 911") never match; candidates are Luhn-checked before redaction so
// order/booking ids that happen to be 13–16 digits aren't mangled.
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,15}\b/g;

// Email detection is format validation, not intent parsing. Evia's own
// addresses (support@eviacares.com etc.) are explicitly allowlisted below.
// Edge case: "Meet @ 123 Main St" does NOT match (no .tld after the domain),
// so shift addresses with "@" in them are safe. Only foo@host.tld shapes match.
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
// eviacares.com is the current brand domain; careconnex stays allowlisted for
// legacy addresses still present in older threads.
const CARECONNEX_DOMAIN = /(^|\.)(careconnex|eviacares)\.[a-z]+$/i;

// Standard Luhn checksum — true for real card numbers, false for almost all
// arbitrary digit runs (ids, refs), which is what keeps false positives low.
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Redact SSNs, Luhn-valid card numbers, and non-careconnex emails. Idempotent
 * (redacting already-redacted text is a no-op), so it's safe to run at multiple
 * points in the pipeline. Returns the scrubbed text and the kinds redacted.
 */
export function redactPii(text: string): RedactResult {
  const redactions: string[] = [];
  let result = text;

  result = result.replace(SSN_PATTERN, () => { redactions.push("ssn"); return REDACTED; });

  result = result.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 16) return match;
    if (!luhnValid(digits)) return match;
    redactions.push("card_number");
    return REDACTED;
  });

  result = result.replace(EMAIL_PATTERN, (match, domain: string) => {
    if (CARECONNEX_DOMAIN.test(domain)) return match;
    redactions.push("email");
    return REDACTED;
  });

  if (redactions.length > 0) {
    const counts: Record<string, number> = {};
    for (const kind of redactions) counts[kind] = (counts[kind] ?? 0) + 1;
    console.warn("redactPii: redacted PII from outbound message", { counts });
  }

  return { text: result, redactions };
}
