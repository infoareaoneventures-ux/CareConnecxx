"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callClaudeWithRetry = callClaudeWithRetry;
exports.safeCallClaude = safeCallClaude;
const RETRYABLE_ERRORS = new Set([
    "APIConnectionError",
    "RateLimitError",
    "OverloadedError",
    "InternalServerError",
]);
const RATE_LIMIT_ERRORS = new Set(["RateLimitError", "OverloadedError"]);
function isRetryable(err) {
    if (err instanceof Error)
        return RETRYABLE_ERRORS.has(err.constructor.name);
    return false;
}
function isRateLimit(err) {
    if (err instanceof Error)
        return RATE_LIMIT_ERRORS.has(err.constructor.name);
    return false;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function callClaudeWithRetry(client, params, opts) {
    var _a, _b;
    const timeoutMs = (_a = opts === null || opts === void 0 ? void 0 : opts.timeoutMs) !== null && _a !== void 0 ? _a : 25000;
    const maxAttempts = (_b = opts === null || opts === void 0 ? void 0 : opts.maxAttempts) !== null && _b !== void 0 ? _b : 3;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const result = await client.messages.create(params, { signal: controller.signal });
            clearTimeout(timer);
            return result;
        }
        catch (err) {
            clearTimeout(timer);
            lastErr = err;
            const isAbort = err instanceof Error && err.name === "AbortError";
            if (!isAbort && !isRetryable(err))
                throw err;
            if (attempt < maxAttempts - 1) {
                // Rate limit / overload errors need longer back-off (1s → 4s → 16s)
                // Connection errors use shorter back-off (200ms → 400ms → 800ms)
                const delay = isRateLimit(err)
                    ? Math.min(1000 * Math.pow(4, attempt), 16000) + Math.random() * 500
                    : Math.min(200 * Math.pow(2, attempt), 8000) + Math.random() * 100;
                await sleep(delay);
            }
        }
    }
    throw lastErr;
}
async function safeCallClaude(client, params, fallback, opts) {
    var _a, _b;
    try {
        const result = await callClaudeWithRetry(client, params, {
            timeoutMs: (_a = opts === null || opts === void 0 ? void 0 : opts.timeoutMs) !== null && _a !== void 0 ? _a : 25000,
            maxAttempts: 2,
        });
        return ((_b = result.content[0].text) !== null && _b !== void 0 ? _b : "").trim() || fallback;
    }
    catch (_c) {
        return fallback;
    }
}
//# sourceMappingURL=claudeRetry.js.map