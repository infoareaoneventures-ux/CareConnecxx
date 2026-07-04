import { getSharedClient } from "../utils/claudeClient";
import { getGeminiOpenAIClient, getOpenAIClient } from "../utils/openaiClient";
import { callClaudeWithRetry } from "../utils/claudeRetry";
import {
  resolveCaraModelConfig,
  resolveGeminiAgentModel,
  shouldFallbackAgentToAnthropic,
  shouldFallbackAgentToGemini,
} from "../config/caraModels";
import { callOpenAiAgentTurn } from "./openaiToolLoop";
import { raiseProviderFailureAlert } from "../observability/providerFailureAlert";

const ANTHROPIC_AGENT_MODEL = "claude-sonnet-4-6";

export interface AgentTurnMetrics {
  modelProvider?: string;
  modelUsed?: string;
  modelFallbackUsed?: boolean;
  [key: string]: unknown;
}

export interface RunAgentModelTurnParams {
  system: unknown;
  tools: unknown;
  forceTextReply: boolean;
  messages: unknown[];
  metrics: AgentTurnMetrics;
  maxTokens?: number;
}

/**
 * One agent-loop model call: resolves the configured provider for the "agent"
 * tier, calls it, and — when the primary is OpenAI and fails — falls back to
 * Anthropic when `shouldFallbackAgentToAnthropic()` allows. Extracted from
 * runQaAgent's loop so the production provider branch and its fallback are
 * independently testable (U2 fallback-coverage gate).
 */
export async function runAgentModelTurn(params: RunAgentModelTurnParams): Promise<any> {
  const { system, tools, forceTextReply, messages, metrics } = params;
  const maxTokens = params.maxTokens ?? 1024;

  const agentModel = resolveCaraModelConfig("agent");
  metrics.modelProvider = agentModel.provider;
  metrics.modelUsed = agentModel.model;

  const anthropicTurn = (model: string) =>
    callClaudeWithRetry(getSharedClient(), {
      model,
      max_tokens:  maxTokens,
      system:      system as any,
      tools:       tools as any,
      tool_choice: forceTextReply ? { type: "none" } : { type: "auto" },
      messages:    messages as any,
    }, { timeoutMs: 15_000, maxAttempts: 1 });

  if (agentModel.provider !== "openai") {
    // Respect CARA_AGENT_MODEL on the Anthropic path too — but only when it
    // names a Claude model. The documented rollback is a provider-only flip
    // (CARA_AGENT_MODEL may still name an OpenAI model), which must not be
    // handed to the Anthropic API.
    const model = agentModel.model.toLowerCase().startsWith("claude")
      ? agentModel.model
      : ANTHROPIC_AGENT_MODEL;
    metrics.modelUsed = model;
    return anthropicTurn(model);
  }

  // Tier-2 fallback (founder decision 2026-07-03): Gemini through its
  // OpenAI-compatible endpoint. Anthropic Sonnet is tier 3 — it stays in the
  // chain so the agent survives a simultaneous OpenAI + Gemini failure, but
  // Gemini is tried first (the Anthropic account ran out of credits on
  // 2026-07-03, which took the old tier-2 down with it).
  const geminiTurn = () => {
    const geminiModel = resolveGeminiAgentModel();
    metrics.modelProvider = "gemini";
    metrics.modelUsed = geminiModel;
    metrics.modelFallbackUsed = true;
    return callOpenAiAgentTurn({
      client:     getGeminiOpenAIClient(),
      model:      geminiModel,
      maxTokens,
      system:     system as any,
      tools:      tools as any,
      toolChoice: forceTextReply ? "none" : "auto",
      messages:   messages as any,
    });
  };

  return callOpenAiAgentTurn({
    client:     getOpenAIClient(),
    model:      agentModel.model,
    maxTokens,
    system:     system as any,
    tools:      tools as any,
    toolChoice: forceTextReply ? "none" : "auto",
    messages:   messages as any,
  }).catch(async (err: unknown) => {
    // A successful fallback still hides a failing primary provider (e.g.
    // OpenAI credit exhaustion) from ops — raise the alert here, before
    // returning the fallback result, so nobody has to notice the deflection
    // pattern in the wild to find out.
    raiseProviderFailureAlert({
      provider: "openai",
      model: agentModel.model,
      error: err,
    }).catch(() => {});

    const anthropicFallback = () => {
      metrics.modelProvider = "anthropic";
      metrics.modelUsed = ANTHROPIC_AGENT_MODEL;
      metrics.modelFallbackUsed = true;
      return anthropicTurn(ANTHROPIC_AGENT_MODEL);
    };

    if (shouldFallbackAgentToGemini()) {
      console.warn(
        "qaAgent: OpenAI agent loop failed; falling back to Gemini",
        err instanceof Error ? err.message : err,
      );
      try {
        return await geminiTurn();
      } catch (geminiErr: unknown) {
        if (!shouldFallbackAgentToAnthropic()) throw geminiErr;
        raiseProviderFailureAlert({
          provider: "gemini",
          model: resolveGeminiAgentModel(),
          error: geminiErr,
        }).catch(() => {});
        console.warn(
          "qaAgent: Gemini fallback also failed; falling back to Anthropic",
          geminiErr instanceof Error ? geminiErr.message : geminiErr,
        );
        return anthropicFallback();
      }
    }

    if (shouldFallbackAgentToAnthropic()) {
      console.warn(
        "qaAgent: OpenAI agent loop failed; falling back to Anthropic (Gemini fallback disabled)",
        err instanceof Error ? err.message : err,
      );
      return anthropicFallback();
    }

    throw err;
  });
}
