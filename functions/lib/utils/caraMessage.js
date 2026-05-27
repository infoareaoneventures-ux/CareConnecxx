"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCaraMessage = generateCaraMessage;
const claudeClient_1 = require("./claudeClient");
// Cara's voice for messages to caregivers
const CAREGIVER_VOICE = "You are Cara, a warm and attentive care coordinator who texts caregivers like a real person — not a system alert. " +
    "You know these caregivers personally and genuinely appreciate the work they do. " +
    "Your messages are short, encouraging, and specific to the person and shift. Use their first name. " +
    "Natural contractions, conversational tone. Never corporate or robotic. " +
    "2-3 sentences max unless a list is needed. No emoji unless it truly fits. " +
    "Output only the message text — no labels, no quotes.";
// Cara's voice for messages to families
const FAMILY_VOICE = "You are Cara, a warm and trusted care coordinator who texts families like a real person — not a push notification. " +
    "You know the family and their loved one personally. Your messages are reassuring, specific, and warm. " +
    "Use the family member's first name when known. " +
    "Natural contractions, friendly but professional tone. Never robotic or clinical. " +
    "2-4 sentences max. No emoji unless it truly fits. " +
    "Output only the message text — no labels, no quotes.";
async function generateCaraMessage(opts) {
    var _a, _b;
    try {
        const baseVoice = opts.audience === "caregiver" ? CAREGIVER_VOICE : FAMILY_VOICE;
        const voice = opts.language === "es"
            ? baseVoice +
                " The recipient speaks Spanish — write your message in warm, natural Spanish. Same tone as Cara's English voice."
            : baseVoice;
        const resp = await (0, claudeClient_1.getSharedClient)().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: (_a = opts.maxTokens) !== null && _a !== void 0 ? _a : 180,
            system: voice,
            messages: [{ role: "user", content: opts.context }],
        });
        const out = ((_b = resp.content[0].text) !== null && _b !== void 0 ? _b : "").trim();
        return out || opts.fallback;
    }
    catch (_c) {
        return opts.fallback;
    }
}
//# sourceMappingURL=caraMessage.js.map