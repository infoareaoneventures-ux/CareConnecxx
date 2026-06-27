// Prompt-driven onboarding dispatcher (U12) — DARK behind CONVERGENCE_FLIPPED.
//
// The legacy machine sequences questions with a `switch(step)` where each
// handler hardcodes its own next step. This dispatcher replaces the SEQUENCING
// decision with a data-driven one: given what's already collected, it returns
// the next conversational step (the first whose required field is still empty).
// The field schema (CLIENT_STEP_ORDER / CLIENT_STEP_FIELD, exported from the
// legacy module) is the single contract, so the two paths cannot drift.
//
// Scope (deliberate, per plan U12): the dispatcher owns only the CONVERSATIONAL
// field-collection phase. The deterministic gate handlers — phone verification,
// Stripe, Checkr, Auth, terminal-state writes — are RETAINED unchanged; once the
// absorbable fields are collected the dispatcher hands back to the legacy
// post-collection step (`client_ask_start`) and the machine proceeds as before.
//
// KTD-7: a runtime LLM single-shot may later refine selection for ambiguous /
// out-of-order input, but the field-order resolver below is the deterministic
// contract and the parity oracle (U11 corpus) is asserted against it. Flag OFF
// (the default) ⇒ this module is never consulted and the live path is unchanged.

import {
  CLIENT_STEP_ORDER,
  CLIENT_STEP_FIELD,
  CLIENT_POST_COLLECTION_STEP,
  isFieldFilled,
} from "./onboardingConversation";
import { isConvergenceFlipped } from "../config/featureFlags";

export const ONBOARDING_CONVERGENCE_FLOW = "onboarding";

export function isOnboardingDispatchEnabled(): boolean {
  return isConvergenceFlipped(ONBOARDING_CONVERGENCE_FLOW);
}

// Return the next client conversational step given the data collected so far:
// the first step in the field-schema order whose field is still empty, or the
// post-collection hand-off step once they're all filled. Mirrors the legacy
// absorption auto-advance exactly, so it is parity-safe.
export function resolveClientStep(onboardingData: Record<string, unknown> | undefined): string {
  const data = onboardingData ?? {};
  for (const step of CLIENT_STEP_ORDER) {
    const field = CLIENT_STEP_FIELD[step];
    if (!isFieldFilled(data[field])) return step;
  }
  return CLIENT_POST_COLLECTION_STEP;
}

// Whether `step` is a step the dispatcher is allowed to recompute. Only the
// conversational client field-collection steps (and the empty bootstrap) — never
// a gate / awaiting / job / caregiver step, which stay on the legacy cursor.
export function isDispatchableClientStep(step: string): boolean {
  return step === "" || CLIENT_STEP_ORDER.includes(step);
}
