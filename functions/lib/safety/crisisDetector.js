"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMOTIONAL_RESPONSE = exports.MEDICAL_RESPONSE = void 0;
exports.detectCrisis = detectCrisis;
exports.isLikelyRealCrisis = isLikelyRealCrisis;
const openaiClient_1 = require("../utils/openaiClient");
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
exports.MEDICAL_RESPONSE = "🚨 This sounds like an emergency. Please call 911 or go to your nearest ER immediately.\n\n" +
    "If you need me to notify the care team, reply NOTIFY.";
exports.EMOTIONAL_RESPONSE = "I hear you, and I'm really glad you reached out. 💙\n\n" +
    "Please call or text 988 (Suicide & Crisis Lifeline) — they're available 24/7 and they care.\n\n" +
    "I'm here too. Do you want to talk?";
function detectCrisis(text) {
    const lower = text.toLowerCase();
    for (const kw of MEDICAL_KEYWORDS) {
        if (lower.includes(kw))
            return "medical";
    }
    for (const kw of EMOTIONAL_KEYWORDS) {
        if (lower.includes(kw))
            return "emotional";
    }
    return null;
}
// Verify a keyword hit is a real crisis rather than a quote, hypothetical, or
// historical reference. Fail-safe: on timeout, error, or "unclear" we treat as
// a real crisis (return true). Over-responding to safety is the lower-cost
// failure mode; under-responding is not. Tight 1.2s budget keeps the path
// fast enough for life-critical use.
async function isLikelyRealCrisis(text, kind) {
    try {
        const verdict = await Promise.race([
            (0, openaiClient_1.quickComplete)(kind === "medical"
                ? "Reply YES if the user is describing a medical emergency happening NOW (themselves or someone present). " +
                    "Reply NO if it is a quote, joke, fictional reference, past event, hypothetical (\"what if\"), or a " +
                    "question about symptoms in general. When in doubt, reply YES. Reply with only YES or NO."
                : "Reply YES if the user is expressing genuine suicidal thoughts, self-harm intent, or hopelessness right now. " +
                    "Reply NO if it is a quote, joke, fictional reference, exaggeration about a non-life situation, or a question " +
                    "about the topic in general. When in doubt, reply YES. Reply with only YES or NO.", text, { maxTokens: 5 }),
            new Promise((r) => setTimeout(() => r("YES"), 1200)),
        ]);
        const v = verdict.trim().toUpperCase();
        if (v.startsWith("N"))
            return false;
        return true; // YES or anything else → fail-safe to crisis
    }
    catch (_a) {
        return true;
    }
}
//# sourceMappingURL=crisisDetector.js.map