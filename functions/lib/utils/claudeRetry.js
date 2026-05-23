"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callClaudeWithRetry = callClaudeWithRetry;
exports.safeCallClaude = safeCallClaude;
const claudeClient_1 = require("./claudeClient");
// Retryable Anthropic SDK error class names (also covers Vertex AI HTTP retries via axios)
const RETRYABLE_ERRORS = new Set([
    "APIConnectionError",
    "RateLimitError",
    "OverloadedError",
    "InternalServerError",
    "APIUserAbortError", // our AbortController fired — timeout; retry with same budget
]);
// InternalServerError covers 529 (overloaded) — back off the same as rate limit
const RATE_LIMIT_ERRORS = new Set(["RateLimitError", "OverloadedError", "InternalServerError"]);
function isRetryable(err) {
    var _a, _b;
    if (err instanceof Error)
        return RETRYABLE_ERRORS.has(err.constructor.name);
    // axios errors from Vertex AI: retry on 429/500/503
    if (err && typeof err === "object" && "response" in err) {
        const status = (_b = (_a = err.response) === null || _a === void 0 ? void 0 : _a.status) !== null && _b !== void 0 ? _b : 0;
        return status === 429 || status >= 500;
    }
    return false;
}
function isRateLimit(err) {
    var _a, _b;
    if (err instanceof Error)
        return RATE_LIMIT_ERRORS.has(err.constructor.name);
    if (err && typeof err === "object" && "response" in err) {
        const status = (_b = (_a = err.response) === null || _a === void 0 ? void 0 : _a.status) !== null && _b !== void 0 ? _b : 0;
        return status === 429 || status === 529 || status === 503;
    }
    return false;
}
function isAbortError(err) {
    if (!(err instanceof Error))
        return false;
    return (err.name === "AbortError" ||
        err.name === "CanceledError" ||
        err.constructor.name.includes("Abort") ||
        err.constructor.name.includes("Cancel"));
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/**
 * Call Claude with automatic retry + per-attempt timeout.
 *
 * The `client` parameter is kept for backward compatibility but is no longer
 * used — all calls route through getSharedClient() (Vertex AI) to avoid
 * Anthropic direct-API overload (529) issues.
 */
async function callClaudeWithRetry(client, params, opts) {
    var _a, _b;
    void client; // always use the shared Anthropic client
    const activeClient = (0, claudeClient_1.getSharedClient)();
    const timeoutMs = (_a = opts === null || opts === void 0 ? void 0 : opts.timeoutMs) !== null && _a !== void 0 ? _a : 30000;
    const maxAttempts = (_b = opts === null || opts === void 0 ? void 0 : opts.maxAttempts) !== null && _b !== void 0 ? _b : 3;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const result = await activeClient.messages.create(params, { signal: controller.signal });
            clearTimeout(timer);
            return result;
        }
        catch (err) {
            clearTimeout(timer);
            lastErr = err;
            if (!isAbortError(err) && !isRetryable(err))
                throw err;
            if (attempt < maxAttempts - 1) {
                // Rate limit / overload → longer back-off (1s → 4s → 16s)
                // Connection / abort   → shorter back-off (300ms → 600ms → 1.2s)
                const delay = isRateLimit(err)
                    ? Math.min(1000 * Math.pow(4, attempt), 16000) + Math.random() * 500
                    : Math.min(300 * Math.pow(2, attempt), 8000) + Math.random() * 100;
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
            timeoutMs: (_a = opts === null || opts === void 0 ? void 0 : opts.timeoutMs) !== null && _a !== void 0 ? _a : 30000,
            maxAttempts: 2,
        });
        return ((_b = result.content[0].text) !== null && _b !== void 0 ? _b : "").trim() || fallback;
    }
    catch (_c) {
        return fallback;
    }
}
//# sourceMappingURL=claudeRetry.js.map