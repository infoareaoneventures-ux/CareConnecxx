"use strict";
/**
 * Centralized Claude API client.
 *
 * Currently uses the direct Anthropic API (api.anthropic.com) because the GCP
 * project careconnex-d4c8b has 0 quota for Vertex AI Claude models on every
 * endpoint (global + regional). Vertex AI Model Garden enablement does not
 * grant serving quota — that requires a separate quota increase request.
 *
 * To switch back to Vertex AI once quota is granted, restore the Vertex
 * rawPredict implementation that lived here previously (git history) and
 * re-enable the GoogleAuth dependency.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSharedClient = getSharedClient;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
let _sharedClient = null;
/**
 * Returns the singleton Claude client.
 * All functions in functions/src should use this instead of constructing
 * their own Anthropic instance.
 */
function getSharedClient() {
    var _a;
    if (!_sharedClient) {
        const apiKey = (_a = process.env.ANTHROPIC_API_KEY) !== null && _a !== void 0 ? _a : "";
        if (!apiKey) {
            console.warn("claudeClient: ANTHROPIC_API_KEY is not set — Claude calls will fail");
        }
        // Global 12s timeout — any direct `.messages.create` call that doesn't set
        // its own AbortSignal will fail fast instead of hanging for the SDK's
        // 10-minute default. Caller-supplied AbortSignals (used by
        // callClaudeWithRetry) still override this per-call.
        _sharedClient = new sdk_1.default({ apiKey, maxRetries: 0, timeout: 12000 });
    }
    return _sharedClient;
}
//# sourceMappingURL=claudeClient.js.map