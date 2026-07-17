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

// Launch billing kill switch. Auto-approval moves money without an explicit
// client action, so it stays fail-closed until the canonical appointment-backed
// timesheet and delivered-notice cutover has been verified in production.
export function timesheetAutoApprovalEnabled(): boolean {
  return process.env.TIMESHEET_AUTO_APPROVAL_ENABLED === "true";
}

// Post-payment care-plan interview (2026-07-15). After a family finishes
// onboarding, Evia interviews them to build the full care plan (task detail per
// recipient, medications, emergency contact) so caregivers know exactly what
// care is needed. Ships DARK until a fresh-number E2E through payment → interview
// → engaged-caregiver follow-up has run in prod. Reversible by clearing the env
// var — no data migration. See docs on the care-plan interview wave.
export function carePlanInterviewEnabled(): boolean {
  return process.env.CARE_PLAN_INTERVIEW_ENABLED === "true";
}

// Multi-recipient household scoping (2026-07-16). Default ON — this is a KILL
// switch, not a launch gate: off ("false") reverts update_care_plan /
// request_booking / create_care_journal_entry to their pre-wave account-level
// writes without a redeploy. Reads are fail-soft and unconditional (absent
// recipientMedical / recipient fields = account-level data is the answer), so
// flipping this off never hides data.
export function multiRecipientScopingEnabled(): boolean {
  return process.env.MULTI_RECIPIENT_SCOPING_ENABLED !== "false";
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

// Flows cut over to the prompt-driven dispatcher BY DEFAULT. Reversible per-flow
// via CONVERGENCE_UNFLIPPED (a kill switch), no redeploy needed.
//
//   • job_posting / modify_schedule (U13) — no payment/Checkr/account-creation
//     side effects; plan-sanctioned cutover on conversational parity alone,
//     proven by the resolveJobStep / resolveScheduleStep parity tests.
//   • onboarding (U12) — held DARK by default in the cara-100 ↔ caregiver-mvr
//     integration build (2026-06-27). cara-100 had flipped it on, but its parity
//     was proven against cara's *own* legacy machine; the merge brings in the
//     caregiver-mvr onboarding handlers, so that parity is no longer established
//     for the combined code, and the recommended real-model eval (KTD-6) was
//     never run. The proven legacy step flow ships by default. The dispatcher
//     stays fully available + tested (onboardingReplay U12 flag-ON suite) and can
//     be flipped per-flow via CONVERGENCE_FLIPPED=onboarding once re-validated.
const DEFAULT_FLIPPED_FLOWS: ReadonlySet<string> = new Set(["job_posting", "modify_schedule"]);

function convergenceUnflippedFlows(): ReadonlySet<string> {
  const raw = process.env.CONVERGENCE_UNFLIPPED ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isConvergenceFlipped(flow: string): boolean {
  // Kill switch wins: explicitly unflip a default-on flow if it ever misbehaves.
  if (convergenceUnflippedFlows().has(flow)) return false;
  // Default-on (conversational-parity-validated, no side effects).
  if (DEFAULT_FLIPPED_FLOWS.has(flow)) return true;
  // Everything else (incl. onboarding, reminder_management) stays opt-in via env.
  return convergenceFlippedFlows().has(flow);
}

// NOTE: the ONBOARDING_AGENT_LOOP* flags (role gate + canary cohort scoping) were
// removed on 2026-07-08 when the agent loop became the SOLE onboarding collection
// path (loop-only). Routing is now unconditional for text turns at a collection
// step — see shouldRouteOnboardingToLoop in agents/onboardingContract.ts. The env
// vars ONBOARDING_AGENT_LOOP / _PHONES / _COHORT_PCT are no longer read.
