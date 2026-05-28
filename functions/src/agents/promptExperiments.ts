// Prompt A/B experiments framework.
//
// Lets us A/B test prompt variants without forking the agent. An experiment
// declares N variants (one usually "control"), an optional eligibility
// predicate, and per-variant weights. Each user × experiment is assigned to
// a sticky variant via a hash of (userId, experimentKey), so the same user
// sees the same variant across turns/sessions until the experiment ends.
//
// Plugs into the promptAugmenter pipeline as one additional augmenter
// (`experimentsAugmenter` below). The active variants for the turn are
// emitted on TurnMetrics.experiments so Cloud Logging can slice metrics by
// variant downstream.
//
// What's intentionally NOT here yet:
//   - persisting assignments (we hash, deterministic enough for sprint use)
//   - exposure logging beyond the per-turn log line (the cara.turn log line
//     already carries metrics.experiments, that's our exposure record)
//   - server-side flag store (in-process registry is sufficient; experiments
//     are config + redeployable; if we need dynamic flagging we layer it on)
//
// Public surface:
//   - registerExperiment(exp)
//   - clearExperiments()           (test-only)
//   - getActiveVariant(userId, key)
//   - getExperimentAssignments(ctx)
//   - experimentsAugmenter         (PromptAugmenter ready to drop into the pipeline)

import type { PromptAugmenter, AugmenterContext } from "./promptAugmenters";

export interface PromptExperiment {
  readonly key:         string;            // stable identifier — used in metrics
  readonly description: string;            // human-readable; logs only
  readonly variants:    Readonly<Record<string, string>>;  // variantName → directive (empty means "no directive")
  readonly weights?:    Readonly<Record<string, number>>;  // optional; defaults to uniform across variants
  // Cohort filter. Returning false → user is OFF the experiment (no variant
  // assigned, no directive injected). Defaults to "everyone is eligible."
  readonly predicate?:  (ctx: { userId: string; userType: "client" | "caregiver" }) => boolean;
}

// In-process registry. Experiments are registered at module load time
// (typically in qaAgent.ts or a sibling experiments registry file).
const REGISTRY = new Map<string, PromptExperiment>();

export function registerExperiment(exp: PromptExperiment): void {
  if (!exp.key || !/^[a-z][a-z0-9_-]*$/.test(exp.key)) {
    throw new Error(`promptExperiments: invalid key "${exp.key}" — must be lowercase kebab/snake`);
  }
  if (Object.keys(exp.variants).length < 2) {
    throw new Error(`promptExperiments: experiment "${exp.key}" needs ≥2 variants`);
  }
  if (exp.weights) {
    for (const v of Object.keys(exp.weights)) {
      if (!(v in exp.variants)) {
        throw new Error(`promptExperiments: weight for unknown variant "${v}" in "${exp.key}"`);
      }
    }
    for (const w of Object.values(exp.weights)) {
      if (w < 0 || !Number.isFinite(w)) {
        throw new Error(`promptExperiments: weights must be finite non-negative numbers (exp ${exp.key})`);
      }
    }
  }
  REGISTRY.set(exp.key, exp);
}

// Test-only — clear the registry between test cases. Not exported through
// the public agent surface; importers in product code shouldn't call it.
export function _clearExperiments(): void {
  REGISTRY.clear();
}

export function listExperiments(): readonly PromptExperiment[] {
  return Array.from(REGISTRY.values());
}

// FNV-1a 32-bit hash. Deterministic, cross-platform, no Node-specific deps,
// good distribution for short strings. Returns an unsigned 32-bit integer.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime mixing; the >>> 0 keeps it in unsigned 32-bit range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Resolve a sticky variant for (userId, experimentKey). Returns null when:
//   - experiment isn't registered
//   - userId is empty (anonymous turn — opt out of all experiments)
//   - the experiment's cohort predicate excludes the user
// Sticky guarantee: same inputs ALWAYS produce the same variant. No state.
export function getActiveVariant(
  userId:   string,
  expKey:   string,
  userType: "client" | "caregiver" = "client",
): string | null {
  if (!userId) return null;
  const exp = REGISTRY.get(expKey);
  if (!exp) return null;
  if (exp.predicate && !exp.predicate({ userId, userType })) return null;

  const variantNames = Object.keys(exp.variants);
  if (variantNames.length === 0) return null;

  // Weighted (or uniform) sampling driven by a hash bucket in [0, 1).
  const bucket = fnv1a(`${expKey}::${userId}`) / 0x100000000; // 2^32

  const rawWeights = variantNames.map((v) => exp.weights?.[v] ?? 1);
  const total = rawWeights.reduce((s, w) => s + w, 0);
  if (total <= 0) return variantNames[0] ?? null;

  let cursor = 0;
  for (let i = 0; i < variantNames.length; i++) {
    cursor += rawWeights[i] / total;
    if (bucket < cursor) return variantNames[i];
  }
  // Floating-point safety net — `bucket` is in [0, 1) but accumulated cursor
  // can end at 0.9999...; fall through to the last variant if we never hit.
  return variantNames[variantNames.length - 1];
}

export interface ExperimentAssignments {
  // For each registered experiment the user is eligible for: experimentKey → variantName.
  // Off-experiment / ineligible users are omitted entirely.
  readonly assignments: Readonly<Record<string, string>>;
  // Per-assignment directive blocks. May be empty when a variant is the "control"
  // (variant value is empty string).
  readonly directives:  readonly string[];
}

export function getExperimentAssignments(
  userId:   string,
  userType: "client" | "caregiver",
): ExperimentAssignments {
  const assignments: Record<string, string> = {};
  const directives:  string[] = [];

  for (const exp of REGISTRY.values()) {
    const variant = getActiveVariant(userId, exp.key, userType);
    if (!variant) continue;
    assignments[exp.key] = variant;
    const directive = exp.variants[variant];
    if (directive && directive.trim()) directives.push(directive.trim());
  }

  return { assignments, directives };
}

// PromptAugmenter ready to drop into the qaAgent pipeline. Reads the active
// experiment assignments for the turn, appends each non-empty variant
// directive to the system prompt, and writes assignments onto metrics.
export const experimentsAugmenter: PromptAugmenter = {
  name:        "experiments",
  description: "Injects active A/B experiment variant directives",
  augment: (ctx: AugmenterContext) => {
    if (!ctx.userId) return null;
    const { assignments, directives } = getExperimentAssignments(ctx.userId, ctx.userType);
    if (Object.keys(assignments).length === 0) return null;

    // Mutate metrics in place — same pattern as existing fields in qaAgent
    // (emotionalContext, skill, etc).
    (ctx.metrics as { experiments?: Record<string, string> }).experiments = assignments;

    if (directives.length === 0) return null;
    return directives.join("\n\n");
  },
};
