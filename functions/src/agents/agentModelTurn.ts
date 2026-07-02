import { getSharedClient } from "../utils/claudeClient";
import { getOpenAIClient } from "../utils/openaiClient";
import { callClaudeWithRetry } from "../utils/claudeRetry";
import { resolveCaraModelConfig, shouldFallbackAgentToAnthropic } from "../config/caraModels";
import { callOpenAiAgentTurn } from "./openaiToolLoop";

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

  const anthropicTurn = () =>
    callClaudeWithRetry(getSharedClient(), {
      model:       ANTHROPIC_AGENT_MODEL,
      max_tokens:  maxTokens,
      system:      system as any,
      tools:       tools as any,
      tool_choice: forceTextReply ? { type: "none" } : { type: "auto" },
      messages:    messages as any,
    }, { timeoutMs: 15_000, maxAttempts: 1 });

  if (agentModel.provider !== "openai") {
    return anthropicTurn();
  }

  return callOpenAiAgentTurn({
    client:     getOpenAIClient(),
    model:      agentModel.model,
    maxTokens,
    system:     system as any,
    tools:      tools as any,
    toolChoice: forceTextReply ? "none" : "auto",
    messages:   messages as any,
  }).catch(async (err: unknown) => {
    if (!shouldFallbackAgentToAnthropic()) throw err;
    console.warn(
      "qaAgent: OpenAI agent loop failed; falling back to Anthropic",
      err instanceof Error ? err.message : err,
    );
    metrics.modelProvider = "anthropic";
    metrics.modelUsed = ANTHROPIC_AGENT_MODEL;
    metrics.modelFallbackUsed = true;
    return anthropicTurn();
  });
}
