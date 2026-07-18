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

// Shared anti-invention prompt rule (hallucination hardening U1/U2, R1). Spliced
// into both caraMessage voices and appended to every direct messages.create
// generator's system prompt so the wording never drifts. It REPLACES the old
// "Be concrete — real names, dates, times, amounts — never vague" imperative,
// which pressured the model into producing a name even when the briefing gave
// none (the "Marcus" incident). Lives HERE (not caraMessage.ts) so consumers
// like humanReply survive tests that shallow-mock "../utils/caraMessage" with
// only generateCaraMessage — caraMessage.ts re-exports it for compatibility.
export const ANTI_INVENTION_CLAUSE =
  "Be concrete with the names, dates, times, and amounts given in the briefing — never vague. " +
  "Use ONLY names, dates, times, and amounts that appear in the briefing; " +
  "if a name or number is not given, refer generically ('your visit', 'the caregiver') and NEVER invent one.";

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

// (a) an imperative ask for the info needed to write the message ("Please
// provide the caregiver's name…", "Share the shift details and I'll draft the
// text", "Let me know who the client is"). Requires an info-seeking object
// within the same clause (bounded, no nesting — ReDoS-safe), so ordinary
// imperatives in real copy ("please let me know if the time works") never
// match. Still only signal (a): the CONJUNCTION rule below demands a
// briefing/transcript reference or role question on top.
const IMPERATIVE_ASK = /\b(?:please\s+)?(?:provide|share|send|give\s+me|tell\s+me|let\s+me\s+know)\b[^.!?\n]{0,80}\b(?:name|details|context|information|info|who\s+the|which\s+(?:client|caregiver|senior|shift))\b/i;

// (b) an explicit briefing/transcript reference — word-boundary-aware, so
// "debriefing" never matches.
const BRIEFING_REF = /\b(?:briefing|transcript)s?\b/i;

// (b) a role question — the model asking who a party is.
const ROLE_QUESTION = /\bwho(?:'s|\s+is|\s+are)\s+(?:the|this|that|your|my|our)\s+(?:caregiver|client|senior|recipient|care\s+recipient|family\s+member)s?\b/i;

// ---------------------------------------------------------------------------
// url — any http(s)://, www., or bare-domain occurrence. Composed links are
// always wrong; real links are sent by the system as separate card bubbles.
// ---------------------------------------------------------------------------
// All bare-domain patterns carry a negative lookbehind for "@": email
// addresses (support@eviacares.com — the platform email appears in legitimate
// copy) are not composed links and must never trip the check.
const URL_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/\S+/i,
  /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i,
  // Bare domain with an UNAMBIGUOUS TLD (eviacares.com etc.). Bounded TLD list
  // keeps false positives out ("5 p.m.", file names like resume.pdf never match).
  /(?<!@)\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|app|care|health|link)\b/i,
  // Short AMBIGUOUS TLDs (.me/.us/.co) false-positive on missing-space typos
  // ("text.me later", "trust.us"). Those only count with a URL-ish shape:
  // 2+ labels before the TLD, or a trailing /path. (www./http(s) shapes are
  // already caught by the patterns above.)
  /(?<!@)\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:me|us|co)\b/i,
  /(?<!@)\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:me|us|co)\/\S/i,
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
    const imperativeAsk = IMPERATIVE_ASK.test(text);
    const briefingRef   = BRIEFING_REF.test(text);
    const roleQuestion  = ROLE_QUESTION.test(text);

    const contextRequest = needInfo || addressAuthor || inability || imperativeAsk;
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
