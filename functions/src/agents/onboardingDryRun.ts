// Onboarding dry-run isolation (U10).
//
// The onboarding state machine (`onboardingConversation.ts`) performs its
// irreversible side effects — Stripe session/account creation, Checkr
// background-check submission, Firebase Auth account creation, and Firestore
// writes — as DIRECT calls, not MCP tools. The `runQaAgent`-layer shadow
// isolation (server.ts READ_ONLY_TOOLS) therefore never touches them.
//
// This module makes a *shadow* run of the onboarding handler write-safe so the
// prompt-driven dispatcher (U12) can be validated against the legacy machine
// without firing real payments / background checks / account creation. It uses
// AsyncLocalStorage so the conversational handlers don't need a `dryRun`
// parameter threaded through every signature — the side-effect call sites just
// ask `isOnboardingDryRun()`.
//
// NOTE: conversational OUTPUT (Linq `sendMessage`) is intentionally NOT guarded
// here — the replay harness (U11) mocks the Linq client to capture would-be
// messages, exactly as goldenTranscripts.test.ts does. Dry-run scope is the
// irreversible WRITES only: Stripe / Checkr / Auth / Firestore.

import { AsyncLocalStorage } from "node:async_hooks";

export interface RecordedSideEffect {
  kind:    string;                       // e.g. "stripe.checkout.create", "firestore.set:caregivers"
  detail?: Record<string, unknown>;      // non-PHI descriptor (ids/keys, never secrets)
}

interface DryRunStore {
  recorded: RecordedSideEffect[];
}

const als = new AsyncLocalStorage<DryRunStore>();

// Run `fn` in dry-run mode: every guarded side effect inside (transitively,
// across awaits) is suppressed + recorded instead of executed. Returns fn's
// result alongside the list of side effects that WOULD have fired.
export async function runOnboardingDryRun<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; recorded: RecordedSideEffect[] }> {
  const store: DryRunStore = { recorded: [] };
  const result = await als.run(store, fn);
  return { result, recorded: store.recorded };
}

export function isOnboardingDryRun(): boolean {
  return als.getStore() !== undefined;
}

// Record a side effect that was suppressed (or, for callers that guard inline,
// one they're about to skip). No-op outside a dry-run context.
export function recordSideEffect(kind: string, detail?: Record<string, unknown>): void {
  als.getStore()?.recorded.push({ kind, detail });
}

// Guard an irreversible side effect. In a dry-run: records `kind`+`detail` and
// returns `wouldBe` WITHOUT invoking `real`. Otherwise: executes `real`.
export async function guardSideEffect<T>(
  kind:    string,
  real:    () => Promise<T>,
  wouldBe: T,
  detail?: Record<string, unknown>,
): Promise<T> {
  if (isOnboardingDryRun()) {
    recordSideEffect(kind, detail);
    return wouldBe;
  }
  return real();
}
