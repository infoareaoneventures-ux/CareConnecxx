"use strict";
/**
 * Voice mirroring v0 — Sprint 3 / roadmap §5.2.
 *
 * Computes a lightweight per-family communication profile from recent inbound
 * messages and renders it as a one-line directive injected into the system
 * prompt. The goal is to make Cara's surface style track the family's: short
 * texters get short replies; emoji users get emoji back; Spanish writers get
 * Spanish responses; formal writers get a more grounded register.
 *
 * No ML. Just rolling stats over the last N user messages — anything else is
 * premature for this stage. Falls back to "no directive" when the sample is
 * too small to be meaningful (< MIN_SAMPLE).
 *
 * The CLAUDE.md "no regex for intent parsing" rule does not apply here: this
 * is purely formatting/style detection on the family's own text, not parsing
 * the meaning of what they said.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeVoiceProfile = computeVoiceProfile;
exports.buildVoiceDirective = buildVoiceDirective;
// Need at least this many user messages before we trust the profile. Below
// this we fall back to no directive (Cara's defaults are already sensible).
const MIN_SAMPLE = 3;
// Cap the sample window so style picked up months ago doesn't dominate the
// most recent register the family has been using.
const MAX_SAMPLE = 12;
// Unicode ranges that cover the bulk of typeable emoji on iOS/Android keyboards.
// Not exhaustive — we don't need it to be; rough rate detection is enough.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/gu;
// Common Spanish stopwords / function words. Presence of >=2 of these in a
// short SMS is a strong signal the message is Spanish, not English with a
// loanword. Lowercased; matched as whole-word tokens.
const SPANISH_MARKERS = new Set([
    "hola", "gracias", "buenos", "buenas", "días", "dias", "noches", "tardes",
    "por", "favor", "sí", "si", "no", "mamá", "mama", "papá", "papa",
    "está", "esta", "necesito", "ayuda", "salud", "doctor", "doctora",
    "medicamento", "medicina", "cita", "hoy", "mañana", "manana", "ayer",
    "muchas", "muy", "bien", "mal", "puede", "puedes", "quiero", "quisiera",
    "favor", "que", "qué", "como", "cómo", "para", "con", "sin", "porque",
    "hermana", "hermano", "abuela", "abuelo", "tío", "tia", "tía",
]);
// Casual markers — slang, abbreviations, lowercase-only style.
const CASUAL_MARKERS = [
    /\bthx\b/i, /\bok\b/i, /\bk\b/i, /\byeah\b/i, /\byep\b/i, /\bnope\b/i,
    /\blol\b/i, /\bidk\b/i, /\bbtw\b/i, /\bomg\b/i, /\bpls\b/i, /\bplz\b/i,
    /\bu\b/i, /\bur\b/i, /\bgonna\b/i, /\bwanna\b/i, /\bgotta\b/i, /\bya\b/i,
    /\bhey\b/i, /\bhi\b/i, /\bsup\b/i, /\bnah\b/i,
];
// Formal markers — full salutations, "thank you", complete clause-end periods.
const FORMAL_MARKERS = [
    /\bhello\b/i, /\bgood morning\b/i, /\bgood afternoon\b/i, /\bgood evening\b/i,
    /\bthank you\b/i, /\bplease\b/i, /\bI would like\b/i, /\bcould you\b/i,
    /\bwould you mind\b/i, /\bsincerely\b/i, /\bregards\b/i,
];
function tokenize(text) {
    var _a;
    return (_a = text.toLowerCase().match(/[a-záéíóúñü]+/giu)) !== null && _a !== void 0 ? _a : [];
}
function isProbablySpanish(text) {
    const tokens = tokenize(text);
    if (tokens.length === 0)
        return false;
    let hits = 0;
    for (const t of tokens)
        if (SPANISH_MARKERS.has(t))
            hits++;
    // Two hits OR ≥40% of tokens flagged in very short messages.
    return hits >= 2 || (hits / tokens.length) >= 0.4;
}
/**
 * Compute a voice profile from a list of recent conversation messages. Only
 * user-role messages contribute — Cara's own messages are her style, not the
 * family's. Returns null when the sample is too small to be meaningful.
 */
function computeVoiceProfile(messages) {
    var _a;
    // Take the most recent MAX_SAMPLE user messages (history is oldest→newest).
    const userTexts = messages
        .filter((m) => m.role === "user")
        .map((m) => { var _a; return ((_a = m.content) !== null && _a !== void 0 ? _a : "").trim(); })
        .filter((s) => s.length > 0 && !s.startsWith("[SYSTEM]")) // skip the summary-injection turn
        .slice(-MAX_SAMPLE);
    if (userTexts.length < MIN_SAMPLE)
        return null;
    let totalLen = 0;
    let totalEmoji = 0;
    let casualHits = 0;
    let formalHits = 0;
    let spanishMsgs = 0;
    for (const t of userTexts) {
        totalLen += t.length;
        totalEmoji += ((_a = t.match(EMOJI_RE)) !== null && _a !== void 0 ? _a : []).length;
        for (const r of CASUAL_MARKERS)
            if (r.test(t)) {
                casualHits++;
                break;
            }
        for (const r of FORMAL_MARKERS)
            if (r.test(t)) {
                formalHits++;
                break;
            }
        if (isProbablySpanish(t))
            spanishMsgs++;
    }
    const sampleSize = userTexts.length;
    const avgLength = totalLen / sampleSize;
    const emojiRate = totalEmoji / sampleSize;
    // Formality score: weighted toward formal markers; subtract for casual ones.
    // Bias by avg length — longer messages skew formal even without explicit markers.
    const lengthBoost = Math.min(1, avgLength / 200); // 200+ chars → max boost
    const rawScore = (formalHits - casualHits) / sampleSize;
    const formalityScore = Math.max(0, Math.min(1, 0.5 + 0.4 * rawScore + 0.2 * lengthBoost));
    let languagePref = "en";
    const spanishRatio = spanishMsgs / sampleSize;
    if (spanishRatio >= 0.6)
        languagePref = "es";
    else if (spanishRatio >= 0.25)
        languagePref = "mixed";
    return { sampleSize, avgLength, emojiRate, formalityScore, languagePref };
}
/**
 * Render the profile as a one-line directive for Claude's system prompt.
 * Empty string when there's not enough signal to be useful.
 */
function buildVoiceDirective(profile) {
    if (!profile)
        return "";
    const lengthHint = profile.avgLength < 30 ? "They text short — match it: 1 sentence, sometimes 2."
        : profile.avgLength < 80 ? "They write conversationally — 2 to 3 sentences is the right length."
            : "They write longer messages — you can match that when the moment warrants it.";
    const emojiHint = profile.emojiRate >= 0.5 ? "They use emoji often — a warm one when it fits is welcome."
        : profile.emojiRate >= 0.1 ? "They use occasional emoji — sparing 💙 when the moment genuinely calls for it."
            : "They don't use emoji — don't lead with one.";
    const formalityHint = profile.formalityScore >= 0.65 ? "Their register is on the formal side — full sentences, no slang."
        : profile.formalityScore <= 0.35 ? "Their register is casual — short, lowercase, no hedging language."
            : "";
    const langHint = profile.languagePref === "es" ? "They write in Spanish — respond in warm, natural Spanish unless they switch first."
        : profile.languagePref === "mixed" ? "They mix Spanish and English — match the language of their most recent message."
            : "";
    const parts = [lengthHint, emojiHint, formalityHint, langHint].filter(Boolean);
    return `<voice_mirror>\n${parts.join(" ")}\n</voice_mirror>`;
}
//# sourceMappingURL=voiceMirror.js.map