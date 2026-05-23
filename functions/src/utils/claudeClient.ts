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

import Anthropic from "@anthropic-ai/sdk";

export type AnthropicLike = Anthropic;

let _sharedClient: Anthropic | null = null;

/**
 * Returns the singleton Claude client.
 * All functions in functions/src should use this instead of constructing
 * their own Anthropic instance.
 */
export function getSharedClient(): Anthropic {
  if (!_sharedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      console.warn("claudeClient: ANTHROPIC_API_KEY is not set — Claude calls will fail");
    }
    // Global 12s timeout — any direct `.messages.create` call that doesn't set
    // its own AbortSignal will fail fast instead of hanging for the SDK's
    // 10-minute default. Caller-supplied AbortSignals (used by
    // callClaudeWithRetry) still override this per-call.
    _sharedClient = new Anthropic({ apiKey, maxRetries: 0, timeout: 12_000 });
  }
  return _sharedClient;
}
