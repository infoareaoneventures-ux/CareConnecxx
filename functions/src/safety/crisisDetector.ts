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
  "won't wake", "not waking up", "isn't waking", "isn't breathing",
  "bleeding a lot", "bleeding heavily", "won't stop bleeding",
  "fell in the", "fell on the", "fell off", "had a fall", "took a fall",
  "has fallen", "is on the floor", "overdosed", "od'd",
  "client fell", "mom fell", "dad fell", "took all the pills", "took all my pills",
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
  "suicide", "kill my self", "killing myself", "want to be dead",
  "don't want to live", "self-harm", "cut myself", "cutting myself",
  // Spanish (accent-free)
  "quiero morir", "me quiero morir", "quiero morirme", "quitarme la vida",
  "acabar con todo", "matarme", "me quiero matar", "no quiero vivir",
  "no vale la pena vivir", "hacerme dano", "no puedo mas", "ya no puedo mas",
  "suicida", "suicidio", "mejor sin mi",
];

// Strip diacritics + lowercase so accent-free SMS text matches accented
// keywords and vice versa. Curly apostrophes (iPhone default) fold to '.
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‛ʼ`´]/g, "'");
}

function stripApostrophes(text: string): string {
  return text.replace(/'/g, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Leading word boundary only, so Spanish plurals ("convulsiones") still match.
function compileKeywords(list: string[]): RegExp[] {
  const forms = new Set<string>();
  for (const kw of list) {
    forms.add(kw);
    forms.add(stripApostrophes(kw));
  }
  return [...forms].map((kw) => new RegExp(`(?:^|[^a-z0-9])${escapeRegex(kw)}`));
}

const MEDICAL_PATTERNS = compileKeywords(MEDICAL_KEYWORDS);
const EMOTIONAL_PATTERNS = compileKeywords(EMOTIONAL_KEYWORDS);

export const MEDICAL_RESPONSE =
  "🚨 This sounds like an emergency. Call 911 now. I can't give medical advice, so please follow what the 911 operator tells you.";

export const EMOTIONAL_RESPONSE =
  "I'm really glad you told me. 💙 If you or someone with you is in immediate danger, call 911 now. " +
  "You can also call or text 988 (Suicide & Crisis Lifeline), any time, day or night.";

export function detectCrisis(text: string): CrisisType {
  const normalized = normalizeForMatch(text);
  const candidates = [normalized, stripApostrophes(normalized)];
  const hits = (patterns: RegExp[]) => candidates.some((c) => patterns.some((p) => p.test(c)));

  if (hits(MEDICAL_PATTERNS)) return "medical";
  if (hits(EMOTIONAL_PATTERNS)) return "emotional";
  return null;
}

export type EmergencyKind = "medical" | "emotional" | "help";
export interface EmergencyAssessment {
  kind: EmergencyKind;
  /** Emotional only: false when the message is about SOMEONE ELSE (a care provider reporting the person in their care). */
  aboutSelf: boolean;
}

/**
 * LLM reader for every message the keyword list did not catch, in ANY language (founders 2026-11-26: "The client
 * fell", "I need help" and "I took all the pills" were all missed — it used to run only on non-English text).
 *
 * Fail behavior: on error/timeout it returns null (NOT a crisis). It runs on messages with no crisis signal at all
 * (low prior), so failing to crisis would mass-escalate benign traffic during an LLM outage. The keyword scan
 * remains the always-on safety net.
 */
export async function classifyEmergency(text: string): Promise<EmergencyAssessment | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const raw = await quickComplete(
      "You are the emergency reader for a home-care texting service (families and care providers). The message may be in any language. Reply with ONE word:\n" +
        "MEDICAL — a medical emergency or injury happening now or just now to the sender or someone with them (a fall, not breathing, chest pain, stroke, unconscious, severe bleeding, overdose or taking all their pills, fire, violence).\n" +
        "SELF_HARM_ME — the SENDER expresses suicidal thoughts, self-harm intent or real hopelessness right now.\n" +
        "SELF_HARM_OTHER — the sender reports that SOMEONE ELSE is suicidal or hurting themselves now.\n" +
        "HELP — an urgent plea for help that does not say what is wrong (\"I need help\", \"help me please\", \"please someone help\").\n" +
        "NONE — everything else, including: asking why there was no reply or chasing an answer; help with scheduling, the app, forms, payments or finding care; past events; hypotheticals; jokes and exaggerations; ordinary care notes and questions; care needs such as \"mom needs help bathing\".",
      text,
      { maxTokens: 8, signal: controller.signal },
    );
    const v = raw.trim().toUpperCase();
    if (v.startsWith("MED")) return { kind: "medical", aboutSelf: false };
    if (v.startsWith("SELF_HARM_OTHER")) return { kind: "emotional", aboutSelf: false };
    if (v.startsWith("SELF") || v.startsWith("EMO")) return { kind: "emotional", aboutSelf: true };
    if (v.startsWith("HELP")) return { kind: "help", aboutSelf: true };
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
// failure mode; under-responding is not. A 2.5s budget (1.2s was hit by ordinary calls) keeps the path
// fast enough for life-critical use.
export async function isLikelyRealCrisis(text: string, kind: "medical" | "emotional"): Promise<boolean> {
  try {
    const verdict = await Promise.race([
      quickComplete(
        kind === "medical"
          ? "Reply YES if the user is describing a medical emergency happening NOW or moments ago (themselves or someone present). " +
            "Reply NO if it is a quote, joke, fictional reference, hypothetical (\"what if\"), a question about symptoms in general, " +
            "or medical HISTORY and care background: something that happened before today (a year, \"last month\", \"has had\", " +
            "\"history of\") told to describe the care someone needs (\"he had a stroke in 2024 and needs mobility help\" is NO). " +
            "A bare report like \"he had a stroke\" or \"mom fell\" with no sign it is old is YES. When in doubt, reply YES. Reply with only YES or NO."
          : "Reply YES if the user is expressing genuine suicidal thoughts, self-harm intent, or hopelessness right now. " +
            "Reply NO if it is a quote, joke, fictional reference, exaggeration about a non-life situation, or a question " +
            "about the topic in general. When in doubt, reply YES. Reply with only YES or NO.",
        text,
        { maxTokens: 5 },
      ),
      new Promise<string>((r) => setTimeout(() => r("YES"), 2_500)),
    ]);
    const v = verdict.trim().toUpperCase();
    if (v.startsWith("N")) return false;
    return true; // YES or anything else → fail-safe to crisis
  } catch {
    return true;
  }
}
