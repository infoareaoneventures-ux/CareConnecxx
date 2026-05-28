import { quickComplete } from "../utils/openaiClient";

// Six tones the family or caregiver can be in when they reach Cara. These
// modulate how Cara replies (warmth, pace, length, emoji policy, formality)
// for the rest of the conversation — they are NOT intent labels and never
// change which tools Cara binds. State persists with a 12h TTL so a family
// in grief stays in grief for hours/days, not just one turn.
export type EmotionalContext =
  | "calm"        // default / neutral baseline — no special directive emitted
  | "anxious"     // worried, scared, overwhelmed about a care situation
  | "grieving"    // bereavement, recent loss, anticipatory grief
  | "frustrated"  // angry at the system, a caregiver, a missed visit, a bill
  | "rushed"      // short, terse, mid-something, "just need an answer"
  | "celebratory"; // good news, milestone, gratitude

const VALID = new Set<EmotionalContext>([
  "calm", "anxious", "grieving", "frustrated", "rushed", "celebratory",
]);

// Topic dimension — orthogonal to emotional posture. Anxious-about-HEALTH
// needs reassurance + journal/notes grounding; anxious-about-LOGISTICS
// needs a fast yes/no/specific answer. We don't burn a model call for this —
// just a cheap regex scan with fail-open to "general".
export type EmotionalTopic = "health" | "logistics" | "general";

// NOTE: truncated stems use `\w*` (not a trailing `\b`) so they match the full
// inflected word — `reschedul\w*` matches "reschedule"/"rescheduling", whereas
// `reschedul\b` would never match (the word continues past the boundary).
const HEALTH_PATTERNS = [
  /\b(pain|hurt\w*|bleed\w*|fever|temperature|breath\w*|chest|fall\w*|fell)\b/i,
  /\b(med|meds|medication\w*|prescript\w*|pill|dose|insulin|inhaler|oxygen)\b/i,
  /\b(doctor|dr\.|physician|nurse|hospital|emergency room|appointment with)\b/i,
  /\b(blood pressure|bp|heart rate|pulse|sugar|glucose|a1c)\b/i,
  /\b(sleep\w*|appetite|eat\w*|drink\w*|bathroom|incontinen\w*)\b/i,
  /\b(confus\w*|dementia|alzheimer\w*|memory|forgot|forget|forgetting)\b/i,
  /\b(mood|sad|crying|withdrawn|agitat\w*)\b/i,
];

const LOGISTICS_PATTERNS = [
  /\b(book\w*|reschedul\w*|cancel\w*|swap|move|moving|change|changing)\b/i,
  /\b(invoic\w*|bill\w*|charg\w*|payment|refund\w*|payout|subscription|membership)\b/i,
  /\b(when|what time|how long|hours?|schedul\w*|calendar|availability)\b/i,
  /\b(visit|shift|appointment|interview)\s+(time|date|day|hour)/i,
  /\b(passcode|login|password|portal|account|sign in)\b/i,
  /\b(address|directions|location|where)\b/i,
];

/**
 * Classify the topic of the inbound message — orthogonal to emotional
 * posture. Synchronous, regex-based, no model call, fail-open to "general".
 *
 * Used to nuance the emotional directive: "anxious + health" gets a
 * different addendum than "anxious + logistics". Topic isn't persisted
 * across turns (unlike posture) — each inbound is reclassified fresh.
 */
export function classifyEmotionalTopic(text: string): EmotionalTopic {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "general";
  const healthHits   = HEALTH_PATTERNS.filter(r => r.test(trimmed)).length;
  const logisticsHits = LOGISTICS_PATTERNS.filter(r => r.test(trimmed)).length;
  // When both are present, prefer health — it's the higher-stakes dimension
  // and the more conservative default for an eldercare agent.
  if (healthHits > 0 && healthHits >= logisticsHits) return "health";
  if (logisticsHits > 0) return "logistics";
  return "general";
}

// 12-hour TTL — a tone signal carries forward across the day. After 12h with
// no reinforcement (no non-calm classification), the session resets to calm.
export const EMOTIONAL_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Classify the emotional posture of a single inbound message.
 *
 * Returns "calm" on any timeout / error / unrecognized label — i.e. the
 * classifier biases toward "no special directive", because false positives
 * (treating a routine question as a crisis) are more damaging than misses.
 */
export async function classifyEmotionalContext(text: string): Promise<EmotionalContext> {
  const trimmed = text.trim();
  if (!trimmed) return "calm";
  // Don't bother classifying near-empty noise — wastes a model call and would
  // just return "calm" anyway.
  if (trimmed.length < 3) return "calm";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const raw = await quickComplete(
      "You read a single inbound message from a family member or caregiver to Cara, an AI care assistant. " +
      "Classify the EMOTIONAL POSTURE of the sender, not the topic. " +
      "Reply with exactly one word: calm, anxious, grieving, frustrated, rushed, or celebratory.\n" +
      "calm = neutral, ordinary check-in or question, no strong feeling.\n" +
      "anxious = worried, scared, overwhelmed (\"I don't know what to do\", \"is mom going to be okay\", \"I'm so worried\").\n" +
      "grieving = bereavement, recent loss, anticipatory grief, mentions of dying or end-of-life.\n" +
      "frustrated = angry, fed up, complaints about the caregiver/system/bill (\"this is ridiculous\", \"again??\", \"useless\").\n" +
      "rushed = terse, mid-something, just wants the answer (\"quick — what time\", \"can't talk now just confirm\").\n" +
      "celebratory = good news, gratitude, milestone (\"she's home!\", \"thank you so much\", \"best day in months\").\n" +
      "When uncertain, choose calm.",
      trimmed,
      { maxTokens: 6, signal: controller.signal },
    );
    clearTimeout(timer);
    const label = raw.trim().toLowerCase() as EmotionalContext;
    return VALID.has(label) ? label : "calm";
  } catch {
    clearTimeout(timer);
    return "calm";
  }
}

export interface StoredEmotionalContext {
  value:     EmotionalContext;
  setAt:     number; // ms
  expiresAt: number; // ms
}

/**
 * Decide which context to USE for this turn (and persist), given:
 *   - what the session is currently carrying (may be undefined / expired)
 *   - what we just classified the current message as
 *
 * Rules:
 *   • Expired stored state is ignored.
 *   • A non-calm CURRENT signal always wins — refresh TTL.
 *   • A calm CURRENT signal does NOT clear a still-valid non-calm stored
 *     posture — grief and anxiety don't evaporate the moment someone sends
 *     a normal-sounding follow-up.
 *   • Default fallback is "calm" with no persisted record.
 */
export function blendEmotionalContext(
  stored:  StoredEmotionalContext | undefined,
  current: EmotionalContext,
  now: number = Date.now(),
): { value: EmotionalContext; persist: StoredEmotionalContext | null } {
  const live = stored && stored.expiresAt > now ? stored : undefined;

  if (current !== "calm") {
    const next: StoredEmotionalContext = {
      value:     current,
      setAt:     now,
      expiresAt: now + EMOTIONAL_CONTEXT_TTL_MS,
    };
    return { value: current, persist: next };
  }

  if (live) return { value: live.value, persist: null };
  return { value: "calm", persist: null };
}

/**
 * Render a prompt directive for the resolved emotional context. Wrapped in
 * <emotional_context> so it anchors at the end of the system prompt where
 * Sonnet attends most.
 *
 * "calm" returns an empty string — no directive needed for the default tone,
 * and emitting one would unnecessarily invalidate the prompt cache.
 *
 * Sprint 8: optional `topic` parameter (Health / Logistics / General) lets
 * anxious & frustrated branches nuance their guidance — health concerns need
 * grounding in journal/notes; logistics needs a fast specific answer.
 */
export function buildEmotionalContextDirective(
  value: EmotionalContext,
  topic: EmotionalTopic = "general",
): string {
  switch (value) {
    case "anxious": {
      const topicLine =
        topic === "health"
          ? "Topic is health: ground reassurance in journal/notes/care_plan data — call get_care_journal or get_senior_profile before stating anything specific about their condition."
          : topic === "logistics"
            ? "Topic is logistics: give a clear specific answer (time, name, yes/no) fast; reassurance is a single sentence at most."
            : "";
      return [
        "<emotional_context>",
        "The family is anxious. Lead with reassurance and concrete next steps before details.",
        "Shorter sentences. Acknowledge the worry by name (\"I can hear how worried you are\") once, then act.",
        "Do not pile on caveats, disclaimers, or \"please consult a professional\" hedges — they read as cold here.",
        ...(topicLine ? [topicLine] : []),
        "</emotional_context>",
      ].join("\n");
    }
    case "grieving":
      return [
        "<emotional_context>",
        "The family is grieving. Slow down. Brief, warm, present. No upbeat phrasing, no exclamation points, no emoji.",
        "Don't redirect to logistics unless they bring it up. Stay with them.",
        "If they raise a task, handle it gently and quietly; don't celebrate completion.",
        "</emotional_context>",
      ].join("\n");
    case "frustrated": {
      const topicLine =
        topic === "health"
          ? "Topic is health/care: acknowledge the specific care concern by name and pull recent journal notes (get_care_journal) before responding so your acknowledgment is grounded."
          : topic === "logistics"
            ? "Topic is logistics: fix the logistics directly in this turn — cancel, reschedule, refund, message the caregiver. Don't ask permission for the obvious next step."
            : "";
      return [
        "<emotional_context>",
        "The family is frustrated. Own it without excuse-making. Skip filler and meta-talk.",
        "Acknowledge the specific thing that went wrong in one sentence, then say exactly what you'll do.",
        "Never say \"I understand how you feel.\" Show you understand by acting.",
        ...(topicLine ? [topicLine] : []),
        "</emotional_context>",
      ].join("\n");
    }
    case "rushed":
      return [
        "<emotional_context>",
        "The family is in a hurry. Answer in one or two short sentences. No preamble, no \"happy to help\", just the answer.",
        "Save context and follow-up offers for later.",
        "</emotional_context>",
      ].join("\n");
    case "celebratory":
      return [
        "<emotional_context>",
        "The family just shared good news. Match the warmth without overdoing it. One short, sincere line of celebration before anything else.",
        "</emotional_context>",
      ].join("\n");
    case "calm":
    default:
      return "";
  }
}
