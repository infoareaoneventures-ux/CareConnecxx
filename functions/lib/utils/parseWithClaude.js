"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWithClaude = parseWithClaude;
exports.parseAndValidate = parseAndValidate;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
/**
 * Shared Claude Haiku parser for extracting structured values from free-form user text.
 * Retries up to 3 times on parse errors before giving up.
 * Replaces the inline parseWithClaude defined in individual handler files.
 */
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
const MAX_ATTEMPTS = 3;
async function parseWithClaude(systemPrompt, userText, maxTokens = 200) {
    var _a;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await getClaude().messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: maxTokens,
                system: systemPrompt,
                messages: [{ role: "user", content: userText }],
            });
            const text = ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
            if (text && text !== "__parse_error__")
                return text;
            // On __parse_error__, retry with a clarifying hint
            if (attempt < MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, 300 * attempt));
            }
        }
        catch (_b) {
            if (attempt === MAX_ATTEMPTS)
                return "__parse_error__";
            await new Promise(r => setTimeout(r, 300 * attempt));
        }
    }
    return "__parse_error__";
}
/**
 * Parse and validate against an allowed-values set in one step.
 * Returns the matched value or `fallback` if parsing fails.
 */
async function parseAndValidate(systemPrompt, userText, allowedValues, fallback) {
    const raw = await parseWithClaude(systemPrompt, userText);
    return allowedValues.includes(raw) ? raw : fallback;
}
//# sourceMappingURL=parseWithClaude.js.map