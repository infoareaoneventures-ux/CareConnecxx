// Prompt augmenter framework — composable, named, ordered pipeline of
// pure(ish) functions that each append a directive block to the system prompt.
//
// Phase 1 (this sprint): the framework + a runner. Existing inline appends in
// qaAgent.ts stay where they are; future PRs migrate them one-by-one into this
// registry so each move is small, reviewable, and unit-testable.
//
// Why composable: today the prompt is built by a vertical chain of
// `systemPrompt += ...` in qaAgent.ts. Adding a new directive means editing
// the agent file directly, which makes review noisy and tests harder. A
// registry lets us add/remove/reorder directives without touching the agent.
//
// Why pure: each augmenter is `(ctx) => string | null`. Side-effects (Firestore
// reads, Zep calls) stay in qaAgent — augmenters consume the data already on
// `ctx`. Keeps them trivially testable.

import type { TurnMetrics } from "./turnMetrics";

// Read-only view of everything an augmenter might need. Slots are nullable
// so callers don't have to populate every field — augmenters skip when their
// inputs aren't available.
export interface AugmenterContext {
  readonly text:        string;
  readonly phone:       string;
  readonly userId:      string;
  readonly seniorId:    string;
  readonly userType:    "client" | "caregiver";
  readonly session?:    Record<string, unknown>;
  readonly turnCount:   number;
  readonly metrics:     TurnMetrics;

  // Optional inputs populated upstream by the agent (kept loose so future
  // augmenters can add slots without churning every existing callsite).
  readonly extras?:     Record<string, unknown>;
}

export interface PromptAugmenter {
  // Stable kebab-case identifier. Used in metrics.augmentersApplied so
  // dashboard queries can track which directives fire how often.
  readonly name: string;

  // Short one-liner — shown in logs / debugging only.
  readonly description?: string;

  // Optional gate. Falsy → skip. Errors here are treated as "skip" so a buggy
  // predicate can't take out the whole pipeline.
  readonly predicate?: (ctx: AugmenterContext) => boolean;

  // Returns a directive block (already-formatted, no leading/trailing
  // newline — the runner inserts the separator). Returning null or an empty
  // string means "no directive this turn." May be async.
  readonly augment: (ctx: AugmenterContext) => Promise<string | null> | string | null;
}

export interface RunAugmentersResult {
  // The fully assembled directive block, including the original prompt and
  // every directive joined with double newlines. Callers replace systemPrompt
  // with this.
  readonly systemPrompt: string;

  // Ordered names of augmenters that actually emitted a non-empty directive.
  // Mirror this into metrics.augmentersApplied for observability.
  readonly applied: string[];
}

// Run an ordered list of augmenters and append their non-empty outputs to
// `basePrompt`. Predicate / augment errors are caught and logged so one bad
// augmenter can't break the rest of the chain (defense in depth — same
// philosophy as the wow-moment registry's safePredicate).
export async function runAugmenters(
  basePrompt: string,
  augmenters: readonly PromptAugmenter[],
  ctx:        AugmenterContext,
): Promise<RunAugmentersResult> {
  let systemPrompt = basePrompt;
  const applied: string[] = [];

  for (const a of augmenters) {
    try {
      if (a.predicate && !a.predicate(ctx)) continue;
    } catch (err) {
      console.warn(`promptAugmenters: predicate threw [${a.name}] — skipping`,
        err instanceof Error ? err.message : err);
      continue;
    }

    let directive: string | null = null;
    try {
      directive = await a.augment(ctx);
    } catch (err) {
      console.warn(`promptAugmenters: augment threw [${a.name}] — skipping`,
        err instanceof Error ? err.message : err);
      continue;
    }

    if (directive && directive.trim()) {
      systemPrompt += `\n\n${directive.trim()}`;
      applied.push(a.name);
    }
  }

  return { systemPrompt, applied };
}
