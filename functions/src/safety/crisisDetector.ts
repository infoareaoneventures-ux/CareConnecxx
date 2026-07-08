import { quickComplete } from "../utils/openaiClient";

export type CrisisType = "medical" | "emotional" | null;

// Keywords are stored lowercase and ACCENT-FREE. `detectCrisis` strips
// diacritics from the inbound text before matching, so "ataque al corazón"
// and the SMS-common unaccented "ataque al corazon" both hit. Spanish is a
// first-class supported language (see utils/language.ts) — crisis text in
// Spanish must be caught here, not only in English.
const MEDICAL_KEYWORDS = [
  // English
  "chest pain", "can't breathe", "cannot breathe", "heart attack",
  "stroke", "seizure", "unconscious", "not breathing", "stopped breathing",
  "passed out", "collapsed", "fell down", "bleeding badly", "unresponsive",
  "not responding", "not responsive", "won't wake up", "can't wake",
  "can't get up", "cannot get up", "fell and", "heart problem", "cardiac",
  "911", "ambulance", "emergency room", "er now", "call 911",
  "choking", "allergic reaction", "anaphylaxis", "overdose",
  // Spanish (accent-free)
  "no puedo respirar", "no puede respirar", "no respira", "dolor en el pecho",
  "ataque al corazon", "ataque cardiaco", "infarto", "derrame cerebral",
  "convulsion", "inconsciente", "no responde", "no reacciona",
  "se desmayo", "desmayo", "se cayo y no", "sangrando mucho",
  "emergencia", "ambulancia", "sala de emergencia", "urgencias",
  "se esta atragantando", "atragantando", "reaccion alergica", "sobredosis",
];

const EMOTIONAL_KEYWORDS = [
  // English
  "end it all", "end my life", "kill myself", "want to die",
  "don't want to be here", "can't go on", "no reason to live",
  "better off without me", "suicidal", "hurt myself",
  "self harm", "not worth living", "give up on life",
  // Spanish (accent-free)
  "quiero morir", "me quiero morir", "quiero morirme", "quitarme la vida",
  "acabar con todo", "matarme", "me quiero matar", "no quiero vivir",
  "no vale la pena vivir", "hacerme dano", "no puedo mas", "ya no puedo mas",
  "suicida", "suicidio", "mejor sin mi",
];

// Strip diacritics + lowercase so accent-free SMS text matches accented
// keywords and vice versa.
function normalizeForMatch(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export const MEDICAL_RESPONSE =
  "🚨 This sounds like an emergency. Please call 911 or go to your nearest ER immediately.\n\n" +
  "If you need me to notify the care team, reply NOTIFY.";

export const EMOTIONAL_RESPONSE =
  "I hear you, and I'm really glad you reached out. 💙\n\n" +
  "Please call or text 988 (Suicide & Crisis Lifeline) — they're available 24/7 and they care.\n\n" +
  "I'm here too. Do you want to talk?";

export function detectCrisis(text: string): CrisisType {
  const lower = normalizeForMatch(text);

  for (const kw of MEDICAL_KEYWORDS) {
    if (lower.includes(kw)) return "medical";
  }
  for (const kw of EMOTIONAL_KEYWORDS) {
    if (lower.includes(kw)) return "emotional";
  }
  return null;
}

/**
 * LLM crisis classifier for the no-keyword path. The keyword scan above can
 * only catch enumerated phrases; this catches paraphrased or code-switched
 * crisis text the list can't anticipate — in ANY language. It returns a type
 * only when the message is a genuine, current crisis, so a positive result can
 * route straight to the crisis response without a second verification call.
 *
 * Fail behavior: on error/timeout it returns null (NOT a crisis). Unlike
 * `isLikelyRealCrisis` — which fails safe to crisis because a keyword already
 * matched (high prior) — this runs on messages with no crisis signal at all
 * (low prior), so failing to crisis would mass-escalate benign traffic during
 * an LLM outage. The keyword scan remains the always-on safety net.
 */
export async function classifyCrisisMultilingual(text: string): Promise<CrisisType> {
  // Bound the call to ~1.5s on the inbound path. An outage/timeout degrades to
  // "no crisis" (null) rather than escalating benign traffic — the keyword scan
  // remains the always-on safety net.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const raw = await quickComplete(
      "You are a crisis classifier for a caregiving assistant. The message may be in any language. " +
        "Reply MEDICAL if it describes a medical emergency happening right now (the user or someone present: " +
        "not breathing, chest pain, stroke, unconscious, severe bleeding, overdose, etc.). " +
        "Reply EMOTIONAL if it expresses genuine suicidal thoughts, self-harm intent, or hopelessness right now. " +
        "Reply NONE for anything else — questions, scheduling, past events, hypotheticals, jokes, general topics. " +
        "When unsure, reply NONE. Reply with only one word: MEDICAL, EMOTIONAL, or NONE.",
      text,
      { maxTokens: 5, signal: controller.signal },
    );
    const v = raw.trim().toUpperCase();
    if (v.startsWith("MED")) return "medical";
    if (v.startsWith("EMO")) return "emotional";
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Verify a keyword hit is a real crisis rather than a quote, hypothetical, or
// historical reference. Fail-safe: on timeout, error, or "unclear" we treat as
// a real crisis (return true). Over-responding to safety is the lower-cost
// failure mode; under-responding is not. Tight 1.2s budget keeps the path
// fast enough for life-critical use.
export async function isLikelyRealCrisis(text: string, kind: "medical" | "emotional"): Promise<boolean> {
  try {
    const verdict = await Promise.race([
      quickComplete(
        kind === "medical"
          ? "Reply YES if the user is describing a medical emergency happening NOW (themselves or someone present). " +
            "Reply NO if it is a quote, joke, fictional reference, past event, hypothetical (\"what if\"), or a " +
            "question about symptoms in general. When in doubt, reply YES. Reply with only YES or NO."
          : "Reply YES if the user is expressing genuine suicidal thoughts, self-harm intent, or hopelessness right now. " +
            "Reply NO if it is a quote, joke, fictional reference, exaggeration about a non-life situation, or a question " +
            "about the topic in general. When in doubt, reply YES. Reply with only YES or NO.",
        text,
        { maxTokens: 5 },
      ),
      new Promise<string>((r) => setTimeout(() => r("YES"), 1_200)),
    ]);
    const v = verdict.trim().toUpperCase();
    if (v.startsWith("N")) return false;
    return true; // YES or anything else → fail-safe to crisis
  } catch {
    return true;
  }
}
