"use strict";
// Pure decision logic for "should the qaAgent fire the recovery sub-agent
// after this iteration of the tool-use loop?".
//
// Extracted so the policy is unit-testable without standing up the full
// Sonnet + MCP loop. The qaAgent imports `decideRecovery` and uses its result
// to gate the (Sonnet-backed) recovery sub-agent invocation.
//
// Policy:
//   • Fires when TWO consecutive iterations had every tool_use return an error.
//   • Fires AT MOST ONCE per turn (caller tracks `alreadyFired`).
//   • If an iteration had any successful tool call, the consecutive counter
//     resets — partial progress means we're not stuck.
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECOVERY_THRESHOLD = void 0;
exports.decideRecovery = decideRecovery;
/** Threshold — two consecutive all-error iterations triggers recovery. */
exports.RECOVERY_THRESHOLD = 2;
/**
 * Given the current `state` and the just-completed iteration's stats, return
 * the updated counter and whether recovery should fire NOW.
 *
 * The caller is responsible for setting `alreadyFired = true` after invoking
 * the recovery sub-agent. This function does not mutate.
 */
function decideRecovery(state, iteration) {
    // No tool calls this iteration → counter unchanged. Sonnet might have just
    // produced a text reply, or the iteration was a no-op due to truncation
    // patching. Treat as neutral.
    if (iteration.toolCalls <= 0) {
        return {
            shouldFire: false,
            consecutiveErrorIterations: state.consecutiveErrorIterations,
        };
    }
    const allErrored = iteration.toolErrors >= iteration.toolCalls;
    const next = allErrored ? state.consecutiveErrorIterations + 1 : 0;
    const shouldFire = !state.alreadyFired && next >= exports.RECOVERY_THRESHOLD;
    return {
        shouldFire,
        consecutiveErrorIterations: next,
    };
}
//# sourceMappingURL=recoveryDecision.js.map