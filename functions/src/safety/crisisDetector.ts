export type CrisisType = "medical" | "emotional" | null;

const MEDICAL_KEYWORDS = [
  "chest pain", "can't breathe", "cannot breathe", "heart attack",
  "stroke", "seizure", "unconscious", "not breathing", "stopped breathing",
  "passed out", "collapsed", "fell down", "bleeding badly", "unresponsive",
  "not responding", "not responsive", "won't wake up", "can't wake",
  "can't get up", "cannot get up", "fell and", "heart problem", "cardiac",
  "911", "ambulance", "emergency room", "ER now", "call 911",
  "choking", "allergic reaction", "anaphylaxis", "overdose",
];

const EMOTIONAL_KEYWORDS = [
  "end it all", "end my life", "kill myself", "want to die",
  "don't want to be here", "can't go on", "no reason to live",
  "better off without me", "suicidal", "hurt myself",
  "self harm", "not worth living", "give up on life",
];

export const MEDICAL_RESPONSE =
  "🚨 This sounds like an emergency. Please call 911 or go to your nearest ER immediately.\n\n" +
  "If you need me to notify the care team, reply NOTIFY.";

export const EMOTIONAL_RESPONSE =
  "I hear you, and I'm really glad you reached out. 💙\n\n" +
  "Please call or text 988 (Suicide & Crisis Lifeline) — they're available 24/7 and they care.\n\n" +
  "I'm here too. Do you want to talk?";

export function detectCrisis(text: string): CrisisType {
  const lower = text.toLowerCase();

  for (const kw of MEDICAL_KEYWORDS) {
    if (lower.includes(kw)) return "medical";
  }
  for (const kw of EMOTIONAL_KEYWORDS) {
    if (lower.includes(kw)) return "emotional";
  }
  return null;
}
