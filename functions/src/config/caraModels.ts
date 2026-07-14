export type CaraModelProvider = "openai" | "anthropic";

export type CaraModelTier =
  | "agent"
  | "quick"
  | "router"
  | "escalation"
  | "vision";

export interface CaraModelConfig {
  provider: CaraModelProvider;
  model: string;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULTS: Record<CaraModelTier, CaraModelConfig> = {
  // Main tool-use/reasoning loop. Keep this on a high-quality OpenAI model by
  // default; override with CARA_AGENT_MODEL when the account has a newer model.
  agent:     { provider: "openai", model: "gpt-4o" },
  // User-facing short replies and rewrites.
  quick:     { provider: "openai", model: "gpt-4o-mini" },
  // Cheap structured routing/extraction/classification.
  router:    { provider: "openai", model: "gpt-4o-mini" },
  // Reserved for high-risk escalation paths.
  escalation:{ provider: "openai", model: "gpt-4o" },
  // Image/document verification.
  vision:    { provider: "openai", model: "gpt-4o" },
};

const ENV_KEYS: Record<CaraModelTier, { provider?: string; model: string }> = {
  agent:     { provider: "CARA_AGENT_PROVIDER", model: "CARA_AGENT_MODEL" },
  quick:     { model: "CARA_QUICK_MODEL" },
  router:    { model: "CARA_ROUTER_MODEL" },
  escalation:{ model: "CARA_ESCALATION_MODEL" },
  vision:    { model: "CARA_VISION_MODEL" },
};

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function providerFromEnv(value: string | undefined, fallback: CaraModelProvider): CaraModelProvider {
  const normalized = clean(value)?.toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") return normalized;
  return fallback;
}

export function resolveCaraModelConfig(
  tier: CaraModelTier,
  env: EnvLike = process.env,
): CaraModelConfig {
  const defaults = DEFAULTS[tier];
  const keys = ENV_KEYS[tier];
  const providerDefault =
    tier === "agent" && (env.VITEST || env.NODE_ENV === "test")
      ? "anthropic"
      : defaults.provider;
  const provider = keys.provider ? providerFromEnv(env[keys.provider], providerDefault) : providerDefault;
  const modelDefault = tier === "agent" && provider === "anthropic"
    ? "claude-sonnet-4-6"
    : defaults.model;
  return {
    provider,
    model:    clean(env[keys.model]) ?? modelDefault,
  };
}

export function shouldFallbackAgentToAnthropic(env: EnvLike = process.env): boolean {
  return clean(env.CARA_AGENT_ANTHROPIC_FALLBACK)?.toLowerCase() !== "false";
}

// Tier-3 agent fallback: Gemini via its OpenAI-compatible endpoint. Fires only
// after both GPT-5.4 and the Anthropic fallback have failed, so the agent loop
// survives a dual-provider outage (e.g. the 2026-07-03 tool-cap 400 + Anthropic
// credit exhaustion). Requires GEMINI_API_KEY (already set for embeddings);
// disable explicitly with CARA_AGENT_GEMINI_FALLBACK=false.
export function shouldFallbackAgentToGemini(env: EnvLike = process.env): boolean {
  if (clean(env.CARA_AGENT_GEMINI_FALLBACK)?.toLowerCase() === "false") return false;
  return !!(clean(env.GEMINI_API_KEY) ?? clean(env.VITE_GEMINI_API_KEY));
}

export function resolveGeminiAgentModel(env: EnvLike = process.env): string {
  return clean(env.CARA_AGENT_GEMINI_MODEL) ?? "gemini-2.5-flash";
}

// ── Token cost estimation (ch9 layered-termination cost budget) ────────────────
// USD per 1M tokens, matched by model-name PREFIX so versioned/dated model ids
// still resolve. This backs the per-turn cost ceiling in the agent loop, NOT
// billing — so the numbers are deliberately CONSERVATIVE (rounded up). An
// over-estimate makes the loop stop a little sooner, which is the safe direction
// for a spend guard. Longest-prefix wins. Unknown models fall to DEFAULT_PRICING
// (priced as a frontier model so an unrecognized id never reads as "free").
interface ModelPrice { inputPerMTok: number; outputPerMTok: number }

const DEFAULT_PRICING: ModelPrice = { inputPerMTok: 5, outputPerMTok: 15 };

const MODEL_PRICING_USD_PER_MTOK: Array<[prefix: string, price: ModelPrice]> = [
  // OpenAI (GPT-5.4 family pricing not public at build time — priced at/above
  // the gpt-4o tier so the ceiling never under-counts).
  ["gpt-5.4-nano", { inputPerMTok: 0.5,  outputPerMTok: 2 }],
  ["gpt-5.4-mini", { inputPerMTok: 1,    outputPerMTok: 4 }],
  ["gpt-5.5",      { inputPerMTok: 6,    outputPerMTok: 18 }],
  ["gpt-5.4",      { inputPerMTok: 3,    outputPerMTok: 12 }],
  ["gpt-4o-mini",  { inputPerMTok: 0.6,  outputPerMTok: 2.4 }],
  ["gpt-4o",       { inputPerMTok: 5,    outputPerMTok: 15 }],
  // Anthropic
  ["claude-sonnet", { inputPerMTok: 3,   outputPerMTok: 15 }],
  ["claude-haiku",  { inputPerMTok: 1,   outputPerMTok: 5 }],
  ["claude-opus",   { inputPerMTok: 15,  outputPerMTok: 75 }],
  // Gemini
  ["gemini-2.5-pro",   { inputPerMTok: 2.5, outputPerMTok: 15 }],
  ["gemini-2.5-flash", { inputPerMTok: 0.3, outputPerMTok: 2.5 }],
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const m = (model ?? "").toLowerCase();
  let price = DEFAULT_PRICING;
  let bestLen = -1;
  for (const [prefix, p] of MODEL_PRICING_USD_PER_MTOK) {
    if (m.startsWith(prefix) && prefix.length > bestLen) {
      price = p;
      bestLen = prefix.length;
    }
  }
  return (inputTokens / 1_000_000) * price.inputPerMTok + (outputTokens / 1_000_000) * price.outputPerMTok;
}
