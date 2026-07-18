/**
 * AI Output Sanitizer (hallucination hardening U10, R15)
 *
 * The SMS path guards model output server-side before delivery
 * (functions/src/safety/outputGuard.ts). The SPA renders AI text directly in
 * three surfaces — shift note, caregiver-search response, conversational
 * booking (services/ai.ts) — so this util is the frontend equivalent:
 * empty/whitespace output and meta-responses (the model replying to its
 * prompt author instead of writing the user-facing text) are replaced with a
 * surface-appropriate canned fallback.
 *
 * NOTE: the marker patterns below MIRROR functions/src/safety/outputGuard.ts
 * and must be kept ALIGNED BY REVIEW — the frontend and functions bundles are
 * separate builds, so no import across that boundary is possible. If a
 * pattern changes on either side, change both. The mirror covers the
 * META-RESPONSE markers only: outputGuard's URL check is deliberately NOT
 * mirrored here — it exists because SMS delivers real links as separate card
 * bubbles (a composed URL is always wrong there); the SPA has no such
 * delivery split, and replacing a whole shift note with canned fallback over
 * a domain mention would destroy legitimate content.
 *
 * Matching rules (same as outputGuard.ts):
 *  - All patterns are word-boundary-aware (\b) — "debriefing" must never
 *    match a "briefing" reference (documented 2026-07-06 substring
 *    regression).
 *  - meta-response requires a CONJUNCTION of two DISTINCT signals:
 *      (a) a context-request / inability shape — asking for more information,
 *          an imperative ask for the info needed to write the message
 *          ("please provide the caregiver's name…"), or addressing the
 *          prompt author about writing the message; and
 *      (b) a briefing/transcript reference or a role question ("who's the
 *          caregiver").
 *    A bare mention of "morning briefing" or "certificate or transcript"
 *    never trips it, and a warm "who is your caregiver" line alone doesn't
 *    either.
 *  - Never log the message text itself — reasons only.
 */

// (a) asking the author for more information/context.
const NEED_INFO = /\b(?:i|we)\s+(?:need|require|(?:don'?t|do not)\s+have)\b[^.!?\n]{0,80}\b(?:context|information|info|details)\b/i;

// (a) addressing the prompt author about producing the message itself.
const ADDRESS_AUTHOR = /\b(?:to|can'?t|cannot|before i(?: can)?)\s+(?:write|compose|draft|craft)\s+(?:this|that|the|a|your)\s+(?:message|text|reply|response)\b/i;

// (a) claiming not to see a message/briefing (inability shape).
const INABILITY = /\b(?:don'?t|do not|can'?t|cannot)\s+see\s+(?:a|the|any|your)\s+(?:message|briefing|transcript|context)\b/i;

// (a) an imperative ask for the info needed to write the message ("Please
// provide the caregiver's name…", "Share the shift details and I'll draft the
// text", "Let me know who the client is"). Requires an info-seeking object
// within the same clause (bounded, no nesting — ReDoS-safe), so ordinary
// imperatives in real copy ("please let me know if the time works") never
// match. Still only signal (a): the CONJUNCTION rule demands a
// briefing/transcript reference or role question on top.
const IMPERATIVE_ASK = /\b(?:please\s+)?(?:provide|share|send|give\s+me|tell\s+me|let\s+me\s+know)\b[^.!?\n]{0,80}\b(?:name|details|context|information|info|who\s+the|which\s+(?:client|caregiver|senior|shift))\b/i;

// (b) an explicit briefing/transcript reference — word-boundary-aware, so
// "debriefing" never matches.
const BRIEFING_REF = /\b(?:briefing|transcript)s?\b/i;

// (b) a role question — the model asking who a party is.
const ROLE_QUESTION = /\bwho(?:'s|\s+is|\s+are)\s+(?:the|this|that|your|my|our)\s+(?:caregiver|client|senior|recipient|care\s+recipient|family\s+member)s?\b/i;

/**
 * Sanitize AI-generated text before rendering it in the SPA.
 * Returns `fallback` when `text` is empty/whitespace or matches the
 * meta-response shape; returns `text` unchanged otherwise. Never throws
 * (fail open on internal error) and never logs the message text.
 */
export function sanitizeAiText(text: string, fallback: string): string {
  try {
    if (typeof text !== "string" || !text.trim()) return fallback;

    const contextRequest =
      NEED_INFO.test(text) || ADDRESS_AUTHOR.test(text) || INABILITY.test(text) ||
      IMPERATIVE_ASK.test(text);
    const briefingRef = BRIEFING_REF.test(text);
    const roleQuestion = ROLE_QUESTION.test(text);

    const isMeta =
      (contextRequest && (briefingRef || roleQuestion)) ||
      (roleQuestion && briefingRef);
    if (isMeta) {
      console.warn("sanitizeAiText: AI output replaced with fallback", { reason: "meta_response" });
      return fallback;
    }

    return text;
  } catch {
    // FAIL OPEN: a sanitizer bug must never blank a legitimate surface.
    return text || fallback;
  }
}

export default { sanitizeAiText };
