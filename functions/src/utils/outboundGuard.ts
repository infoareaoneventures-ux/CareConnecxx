// Dependency-light outbound message guard for fast paths that skip the full
// supervisor (lint + Claude constitution check in safety/supervisor.ts).
//
// runQuickReply and similar low-latency paths send model output straight to
// SMS — this guard is the last line of defense against obvious PII leaks
// (SSNs, card numbers, third-party emails) without adding an LLM round-trip.
//
// Design rules:
//   - FAIL OPEN for ordinary text. The guard exists to stop leaks, not to
//     block conversation — ok is always true; redacted text is still sent.
//   - Format regexes only. This is structural PII detection, NOT intent
//     parsing of user text, so regex is allowed here (see CLAUDE.md).
//   - Never log the redacted values themselves — only counts/kinds.

import { lintMessage } from "../safety/linter";

const REDACTED = "[redacted]";

export interface OutboundGuardResult {
  ok:         boolean;
  text:       string;
  redactions: string[];
}

// SSN: exactly 3-2-4 with dashes. Word boundaries prevent matching inside
// longer digit runs (e.g. tracking numbers).
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

// Candidate card number: 13–16 digits, optionally separated by single spaces
// or dashes. Runs of 12 or fewer digits (phone numbers, 10-digit booking
// refs, "call 911") never match; runs of 17+ have no word boundary inside
// and also never match. Candidates are Luhn-checked before redaction so
// order/booking ids that happen to be 13–16 digits aren't mangled.
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,15}\b/g;

// Email detection is format validation, not intent parsing. Cara's own
// addresses (support@careconnex.com etc.) are fine to send; anything else
// is a potential cross-user leak.
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const CARECONNEX_DOMAIN = /(^|\.)careconnex\.[a-z]+$/i;

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

export async function guardOutbound(
  text: string,
  ctx?: { audience?: "family" | "caregiver"; phone?: string },
): Promise<OutboundGuardResult> {
  const redactions: string[] = [];
  let result = text;

  // SSNs — always redact.
  result = result.replace(SSN_PATTERN, () => {
    redactions.push("ssn");
    return REDACTED;
  });

  // Card-like digit runs — redact only when Luhn-valid.
  result = result.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 16) return match;
    if (!luhnValid(digits)) return match;
    redactions.push("card_number");
    return REDACTED;
  });

  // Email addresses not on a careconnex domain.
  result = result.replace(EMAIL_PATTERN, (match, domain: string) => {
    if (CARECONNEX_DOMAIN.test(domain)) return match;
    redactions.push("email");
    return REDACTED;
  });

  // Reuse the supervisor's lint pass (banned phrases / robotic patterns) so
  // fast-path replies obey the same voice rules as full-agent replies.
  result = lintMessage(result);

  if (redactions.length > 0) {
    // Counts only — never the redacted values.
    const counts: Record<string, number> = {};
    for (const kind of redactions) counts[kind] = (counts[kind] ?? 0) + 1;
    console.warn("outboundGuard: redacted PII from outbound message", {
      counts,
      audience: ctx?.audience ?? "family",
    });
  }

  // Fail open — redacted/linted text is still sent; the guard never blocks.
  return { ok: true, text: result, redactions };
}
