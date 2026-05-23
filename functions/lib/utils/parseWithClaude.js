"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWithClaude = parseWithClaude;
exports.parseAndValidate = parseAndValidate;
const openaiClient_1 = require("./openaiClient");
/**
 * Shared structured-extraction helper for Cara handlers.
 *
 * **The function name is historical** — the underlying model is now
 * `gpt-4o-mini` for speed and lower rate-limit pressure. Public API
 * is unchanged so every caller continues to work without edits.
 *
 * Returns the trimmed assistant text, or `__parse_error__` after
 * MAX_ATTEMPTS unsuccessful tries. Callers should validate the return
 * value against their expected set of allowed answers.
 */
const MAX_ATTEMPTS = 3;
const PER_ATTEMPT_TIMEOUT_MS = 8000;
async function parseWithClaude(systemPrompt, userText, maxTokens = 200) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
        try {
            const text = await (0, openaiClient_1.quickComplete)(systemPrompt, userText, {
                maxTokens,
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (text && text !== "__parse_error__")
                return text;
            if (attempt < MAX_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, 300 * attempt));
            }
        }
        catch (_a) {
            clearTimeout(timer);
            if (attempt === MAX_ATTEMPTS)
                return "__parse_error__";
            await new Promise((r) => setTimeout(r, 300 * attempt));
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