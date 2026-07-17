// Model-output guard for generated messages (hallucination hardening U1).
//
// generateCaraMessage (and the direct messages.create generators, U2) call this
// on MODEL OUTPUT before delivery. Two failure shapes are blocked:
//   - meta_response: the model replied to the briefing AUTHOR instead of writing
//     the user-facing message ("I need the briefing context…, who's the
//     caregiver…") — the incident that leaked a raw meta-response to a live
//     caregiver's phone.
//   - url: the model composed a URL/domain. Real links are delivered separately
//     by the system as tappable cards; a composed URL is wrong and dead (R3).
//
// Design rules (mirrors redactPii.ts):
//   - FAIL OPEN: the guard never throws; on internal error it returns ok:true
//     and the message flows. Callers decide what to do on a failed check
//     (send their deterministic fallback instead).
//   - This inspects MODEL OUTPUT, not user input — regex is allowed here (see
//     CLAUDE.md; the audit notes this explicitly).
//   - All patterns are word-boundary-aware (\b). Do NOT copy linter.ts's
//     boundary-less construction — documented 2026-07-06 regression stripped
//     substrings out of legitimate words ("debriefing" must never match).
//   - Never log the message text itself — only counts/reasons.

export interface GuardResult {
  ok:      boolean;
  reason?: "meta_response" | "url";
}

// ---------------------------------------------------------------------------
// meta_response — requires a CONJUNCTION of two DISTINCT signals so legitimate
// copy that merely mentions "briefing" ("tomorrow's morning briefing") or
// "transcript" ("send a photo of your certificate or transcript") never trips:
//   (a) a context-request / inability shape — asking for more information,
//       or addressing the briefing author about writing the message; and
//   (b) a briefing/transcript reference or a role question ("who's the
//       caregiver", "who is the client").
// A role question alone also counts as the ask-for-context shape, but only in
// combination with an explicit briefing/transcript reference — otherwise a
// warm "Maria, who is your caregiver, will arrive at 2" would false-positive.
// ---------------------------------------------------------------------------

// (a) asking the author for more information/context (same clause, bounded).
const NEED_INFO = /\b(?:i|we)\s+(?:need|require|(?:don'?t|do not)\s+have)\b[^.!?\n]{0,80}\b(?:context|information|info|details)\b/i;

// (a) addressing the briefing author about producing the message itself.
const ADDRESS_AUTHOR = /\b(?:to|can'?t|cannot|before i(?: can)?)\s+(?:write|compose|draft|craft)\s+(?:this|that|the|a|your)\s+(?:message|text|reply|response)\b/i;

// (a) claiming not to see a message/briefing (inability shape).
const INABILITY = /\b(?:don'?t|do not|can'?t|cannot)\s+see\s+(?:a|the|any|your)\s+(?:message|briefing|transcript|context)\b/i;

// (b) an explicit briefing/transcript reference — word-boundary-aware, so
// "debriefing" never matches.
const BRIEFING_REF = /\b(?:briefing|transcript)s?\b/i;

// (b) a role question — the model asking who a party is.
const ROLE_QUESTION = /\bwho(?:'s|\s+is|\s+are)\s+(?:the|this|that|your|my|our)\s+(?:caregiver|client|senior|recipient|care\s+recipient|family\s+member)s?\b/i;

// ---------------------------------------------------------------------------
// url — any http(s)://, www., or bare-domain occurrence. Composed links are
// always wrong; real links are sent by the system as separate card bubbles.
// ---------------------------------------------------------------------------
const URL_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/\S+/i,
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}\b/i,
  // Bare domain with a common TLD (eviacares.com etc.). Bounded TLD list keeps
  // false positives out ("5 p.m.", file names like resume.pdf never match).
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|app|us|care|health|link|me)\b/i,
];

/**
 * Check model output before delivery. Returns `{ ok: false, reason }` when the
 * text is a meta-response to the briefing author or contains a composed URL;
 * `{ ok: true }` otherwise. Never throws (fail open on internal error) and
 * never logs the message text — reasons only.
 */
export function guardModelOutput(text: string): GuardResult {
  try {
    if (!text) return { ok: true };

    const needInfo      = NEED_INFO.test(text);
    const addressAuthor = ADDRESS_AUTHOR.test(text);
    const inability     = INABILITY.test(text);
    const briefingRef   = BRIEFING_REF.test(text);
    const roleQuestion  = ROLE_QUESTION.test(text);

    const contextRequest = needInfo || addressAuthor || inability;
    const isMeta =
      (contextRequest && (briefingRef || roleQuestion)) ||
      (roleQuestion && briefingRef);
    if (isMeta) {
      console.warn("guardModelOutput: model output rejected", { reason: "meta_response" });
      return { ok: false, reason: "meta_response" };
    }

    if (URL_PATTERNS.some((p) => p.test(text))) {
      console.warn("guardModelOutput: model output rejected", { reason: "url" });
      return { ok: false, reason: "url" };
    }

    return { ok: true };
  } catch {
    // FAIL OPEN: a guard bug must never block a send.
    return { ok: true };
  }
}
