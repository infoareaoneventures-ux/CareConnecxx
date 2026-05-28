"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMOTIONAL_CONTEXT_TTL_MS = void 0;
exports.classifyEmotionalContext = classifyEmotionalContext;
exports.blendEmotionalContext = blendEmotionalContext;
exports.buildEmotionalContextDirective = buildEmotionalContextDirective;
const openaiClient_1 = require("../utils/openaiClient");
const VALID = new Set([
    "calm", "anxious", "grieving", "frustrated", "rushed", "celebratory",
]);
// 12-hour TTL — a tone signal carries forward across the day. After 12h with
// no reinforcement (no non-calm classification), the session resets to calm.
exports.EMOTIONAL_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * Classify the emotional posture of a single inbound message.
 *
 * Returns "calm" on any timeout / error / unrecognized label — i.e. the
 * classifier biases toward "no special directive", because false positives
 * (treating a routine question as a crisis) are more damaging than misses.
 */
async function classifyEmotionalContext(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return "calm";
    // Don't bother classifying near-empty noise — wastes a model call and would
    // just return "calm" anyway.
    if (trimmed.length < 3)
        return "calm";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
        const raw = await (0, openaiClient_1.quickComplete)("You read a single inbound message from a family member or caregiver to Cara, an AI care assistant. " +
            "Classify the EMOTIONAL POSTURE of the sender, not the topic. " +
            "Reply with exactly one word: calm, anxious, grieving, frustrated, rushed, or celebratory.\n" +
            "calm = neutral, ordinary check-in or question, no strong feeling.\n" +
            "anxious = worried, scared, overwhelmed (\"I don't know what to do\", \"is mom going to be okay\", \"I'm so worried\").\n" +
            "grieving = bereavement, recent loss, anticipatory grief, mentions of dying or end-of-life.\n" +
            "frustrated = angry, fed up, complaints about the caregiver/system/bill (\"this is ridiculous\", \"again??\", \"useless\").\n" +
            "rushed = terse, mid-something, just wants the answer (\"quick — what time\", \"can't talk now just confirm\").\n" +
            "celebratory = good news, gratitude, milestone (\"she's home!\", \"thank you so much\", \"best day in months\").\n" +
            "When uncertain, choose calm.", trimmed, { maxTokens: 6, signal: controller.signal });
        clearTimeout(timer);
        const label = raw.trim().toLowerCase();
        return VALID.has(label) ? label : "calm";
    }
    catch (_a) {
        clearTimeout(timer);
        return "calm";
    }
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
function blendEmotionalContext(stored, current, now = Date.now()) {
    const live = stored && stored.expiresAt > now ? stored : undefined;
    if (current !== "calm") {
        const next = {
            value: current,
            setAt: now,
            expiresAt: now + exports.EMOTIONAL_CONTEXT_TTL_MS,
        };
        return { value: current, persist: next };
    }
    if (live)
        return { value: live.value, persist: null };
    return { value: "calm", persist: null };
}
/**
 * Render a prompt directive for the resolved emotional context. Wrapped in
 * <emotional_context> so it anchors at the end of the system prompt where
 * Sonnet attends most.
 *
 * "calm" returns an empty string — no directive needed for the default tone,
 * and emitting one would unnecessarily invalidate the prompt cache.
 */
function buildEmotionalContextDirective(value) {
    switch (value) {
        case "anxious":
            return [
                "<emotional_context>",
                "The family is anxious. Lead with reassurance and concrete next steps before details.",
                "Shorter sentences. Acknowledge the worry by name (\"I can hear how worried you are\") once, then act.",
                "Do not pile on caveats, disclaimers, or \"please consult a professional\" hedges — they read as cold here.",
                "</emotional_context>",
            ].join("\n");
        case "grieving":
            return [
                "<emotional_context>",
                "The family is grieving. Slow down. Brief, warm, present. No upbeat phrasing, no exclamation points, no emoji.",
                "Don't redirect to logistics unless they bring it up. Stay with them.",
                "If they raise a task, handle it gently and quietly; don't celebrate completion.",
                "</emotional_context>",
            ].join("\n");
        case "frustrated":
            return [
                "<emotional_context>",
                "The family is frustrated. Own it without excuse-making. Skip filler and meta-talk.",
                "Acknowledge the specific thing that went wrong in one sentence, then say exactly what you'll do.",
                "Never say \"I understand how you feel.\" Show you understand by acting.",
                "</emotional_context>",
            ].join("\n");
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
//# sourceMappingURL=emotionalContext.js.map