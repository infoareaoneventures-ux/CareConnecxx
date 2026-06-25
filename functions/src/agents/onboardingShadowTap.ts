// Onboarding shadow tap (U10).
//
// The existing `routingShadowTap` shadows `runQaAgent`; onboarding runs through
// a different entry point (`onboardingConversation.handleOnboardingStep`), so it
// needs its own tap. This runs a `runner` — today the legacy machine, after U12
// the prompt-driven dispatcher — under dry-run isolation so it fires ZERO
// irreversible side effects (Stripe / Checkr / Auth / Firestore writes) while
// capturing what it WOULD have done. The captured trace is what U12's
// conversational-parity check compares against the live legacy machine.
//
// Off by default and gated per-flow via the existing ROUTING_CONVERGENCE_SHADOW
// flag (flow key "onboarding"), so it can be enabled one environment at a time
// and never affects production until explicitly switched on. It NEVER throws
// into the live caller — a shadow failure is swallowed and returned.

import { runOnboardingDryRun, RecordedSideEffect } from "./onboardingDryRun";
import { isRoutingShadowEnabled } from "../config/featureFlags";

export const ONBOARDING_SHADOW_FLOW = "onboarding";

export interface OnboardingShadowResult {
  recorded: RecordedSideEffect[];
  error?:   string;
}

// Returns null when the shadow is disabled (the common case) so the caller does
// no extra work. When enabled, runs `runner` dry and returns the recorded
// would-be side effects.
export async function runOnboardingShadow(
  runner: () => Promise<void>,
): Promise<OnboardingShadowResult | null> {
  if (!isRoutingShadowEnabled(ONBOARDING_SHADOW_FLOW)) return null;
  try {
    const { recorded } = await runOnboardingDryRun(runner);
    return { recorded };
  } catch (err) {
    // Shadow must never break the live turn — swallow and report.
    return { recorded: [], error: err instanceof Error ? err.message : String(err) };
  }
}
