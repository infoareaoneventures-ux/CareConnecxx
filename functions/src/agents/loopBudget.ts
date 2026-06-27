import type { Intent } from "./intentClassifier";

/**
 * U5: flow-class-aware loop headroom.
 *
 * Multi-step real-world flows (healthcare browser actions: discover → credential
 * → fill → read-back verify) need more than 5 iterations to run to completion;
 * cheap read-only lookups need fewer. "standard" is the default and preserves the
 * prior 5-iteration behavior, including the null-intent (web/agent caller) path.
 */

export type FlowClass = "quick" | "standard" | "multistep";

const MULTISTEP_INTENTS: ReadonlySet<string> = new Set([
  "BOOK_DOCTOR_APPOINTMENT", "PRESCRIPTION_REFILL", "NEW_PRESCRIPTION", "FIND_NEARBY_PROVIDER",
]);

const QUICK_INTENTS: ReadonlySet<string> = new Set([
  "MEMORY_QUERY", "VIEW_MY_JOBS", "VIEW_APPLICANTS", "VIEW_JOURNAL",
  "VIEW_EARNINGS", "VIEW_INVOICE", "VIEW_CARE_PLAN_HISTORY",
]);

export function resolveLoopBudget(intent: Intent | null | undefined): { maxIterations: number; flowClass: FlowClass } {
  if (intent && MULTISTEP_INTENTS.has(intent)) return { maxIterations: 10, flowClass: "multistep" };
  if (intent && QUICK_INTENTS.has(intent))     return { maxIterations: 3,  flowClass: "quick" };
  return { maxIterations: 5, flowClass: "standard" };
}

/**
 * Independent of the iteration cap: bound total tool calls per turn so a confused
 * or prompt-injected loop cannot issue unbounded mutations before the wall-clock
 * ceiling stops it. Sized above any legitimate multi-step flow's tool count.
 */
export const MAX_TOOL_CALLS_PER_TURN = 16;
