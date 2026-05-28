"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAugmenters = runAugmenters;
// Run an ordered list of augmenters and append their non-empty outputs to
// `basePrompt`. Predicate / augment errors are caught and logged so one bad
// augmenter can't break the rest of the chain (defense in depth — same
// philosophy as the wow-moment registry's safePredicate).
async function runAugmenters(basePrompt, augmenters, ctx) {
    let systemPrompt = basePrompt;
    const applied = [];
    for (const a of augmenters) {
        try {
            if (a.predicate && !a.predicate(ctx))
                continue;
        }
        catch (err) {
            console.warn(`promptAugmenters: predicate threw [${a.name}] — skipping`, err instanceof Error ? err.message : err);
            continue;
        }
        let directive = null;
        try {
            directive = await a.augment(ctx);
        }
        catch (err) {
            console.warn(`promptAugmenters: augment threw [${a.name}] — skipping`, err instanceof Error ? err.message : err);
            continue;
        }
        if (directive && directive.trim()) {
            systemPrompt += `\n\n${directive.trim()}`;
            applied.push(a.name);
        }
    }
    return { systemPrompt, applied };
}
//# sourceMappingURL=promptAugmenters.js.map