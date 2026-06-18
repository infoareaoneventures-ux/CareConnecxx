// Env-driven feature flags. Default OFF — a flag is on only when its env var is
// exactly "true".
//
// realWorldHealthcareActions ships the propose→confirm→execute healthcare
// browser actions (appointment booking, pharmacy refill, insurance check) DARK
// until the pre-launch gate closes:
//   1. HIPAA/BAA compliance sign-off (GCP BAA in place + consent scope reviewed).
//   2. OQ6 — approver-identity decision: is phone-as-sole-identity acceptable for
//      committing healthcare actions, or is a second factor / CANCEL window /
//      out-of-band execution notice required first?
//   3. Supported launch-portal list confirmed (MyChart + CVS/Walgreens/RiteAid
//      + the generic insurer URL).
//   4. Browserbase per-action cost guardrails (the two-pass premium).
// See docs/runbooks/healthcare-action.md for the full checklist + recovery.

export function realWorldHealthcareActionsEnabled(): boolean {
  return process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS === "true";
}

// U6: routing-convergence shadow comparison. OFF by default and scoped per flow:
// ROUTING_CONVERGENCE_SHADOW is a comma-separated list of flow keys for which the
// shadow harness runs (e.g. "reminder_management,modify_schedule"). A flow is
// only shadowed when its key is present — so convergence is measured one
// reversible flow at a time, never wholesale (spike + KTD-5/KTD-11).
export function routingShadowFlows(): ReadonlySet<string> {
  const raw = process.env.ROUTING_CONVERGENCE_SHADOW ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isRoutingShadowEnabled(flow: string): boolean {
  return routingShadowFlows().has(flow);
}

// U10: the convergence flip switch. CONVERGENCE_FLIPPED is a comma-separated list
// of flow keys whose LIVE handling has been flipped from the cascade state machine
// to the MCP tool loop — done per flow ONLY after its shadow data (U6/U7) shows
// parity. Off by default: a flow stays on its state machine until explicitly
// flipped. Retiring (deleting) the dead state machine is a later, post-flip cleanup
// — the flip is reversible by clearing the flag; deletion is not.
export function convergenceFlippedFlows(): ReadonlySet<string> {
  const raw = process.env.CONVERGENCE_FLIPPED ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isConvergenceFlipped(flow: string): boolean {
  return convergenceFlippedFlows().has(flow);
}
