"use strict";
/**
 * Shared OpenAI client for Cara's "fast path" Claude-equivalent calls.
 *
 * Cara is hybrid:
 *   - Short single-shot Haiku-equivalent calls (intent classification,
 *     YES/NO decisions, parseWithClaude extractions) go through this client
 *     to gpt-4o-mini. ~500ms typical, $0.15 per 1M input tokens.
 *   - The QA agent's tool-use loop stays on Claude Sonnet via claudeClient.ts.
 *
 * The shared instance has a 10s timeout and zero internal retries — our
 * retry/backoff logic lives in callers (parseWithClaude has its own loop).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOpenAIClient = getOpenAIClient;
exports.quickComplete = quickComplete;
const openai_1 = __importDefault(require("openai"));
let _sharedClient = null;
function getOpenAIClient() {
    var _a;
    if (!_sharedClient) {
        const apiKey = (_a = process.env.OPENAI_API_KEY) !== null && _a !== void 0 ? _a : "";
        if (!apiKey) {
            console.warn("openaiClient: OPENAI_API_KEY is not set — fast-path Claude calls will fail");
        }
        _sharedClient = new openai_1.default({ apiKey, timeout: 10000, maxRetries: 0 });
    }
    return _sharedClient;
}
/**
 * Convenience helper for short single-shot system+user prompts that mirrors
 * the shape Anthropic's `messages.create({ system, messages: [{ role: "user", content }] })`
 * was being used for. Returns the trimmed assistant text.
 *
 * Use this for any new fast-path call site instead of constructing the
 * OpenAI request shape inline.
 */
async function quickComplete(systemPrompt, userText, opts) {
    var _a, _b, _c, _d, _e;
    const res = await getOpenAIClient().chat.completions.create({
        model: (_a = opts === null || opts === void 0 ? void 0 : opts.model) !== null && _a !== void 0 ? _a : "gpt-4o-mini",
        max_tokens: (_b = opts === null || opts === void 0 ? void 0 : opts.maxTokens) !== null && _b !== void 0 ? _b : 200,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userText },
        ],
    }, { signal: opts === null || opts === void 0 ? void 0 : opts.signal });
    return ((_e = (_d = (_c = res.choices[0]) === null || _c === void 0 ? void 0 : _c.message) === null || _d === void 0 ? void 0 : _d.content) !== null && _e !== void 0 ? _e : "").trim();
}
//# sourceMappingURL=openaiClient.js.map