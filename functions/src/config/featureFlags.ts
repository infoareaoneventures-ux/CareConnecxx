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

// Agent-native onboarding collapse (the conversational-collapse plan). When a
// role key is present, that role's CONVERSATIONAL field-collection runs inside
// the qaAgent loop (onboardingMode) instead of the scripted step runner — so
// Cara leads collection as one agent and never re-greets / double-sends. The
// deterministic transactional gates (payment/OTP/Checkr/Stripe/uploads) are NOT
// affected. OFF by default: the scripted runner ships until a real-model eval
// (U8) clears the flip. Comma-separated role keys, e.g. "client" or
// "client,caregiver". Distinct from CONVERGENCE_FLIPPED (the dispatcher's
// next-field selector) — this routes the whole collection turn to the loop.
export function onboardingAgentLoopRoles(): ReadonlySet<string> {
  const raw = process.env.ONBOARDING_AGENT_LOOP ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isOnboardingAgentLoopEnabled(role: "client" | "caregiver"): boolean {
  return onboardingAgentLoopRoles().has(role);
}

// Canary cohort scoping for the onboarding loop. The role flag above is all-or-
// none; these let a canary target a SMALL fraction of clients (the runbook's
// "small cohort / short window" step) without flipping 100% of traffic at once.
// Allowlist wins over percentage. BOTH default to "everyone in the enabled role",
// so behavior is identical to the role flag alone until a canary narrows it.
//
//   ONBOARDING_AGENT_LOOP_PHONES     comma-separated phone numbers; exact match
//                                    or suffix match (list the last N digits).
//                                    When set, ONLY these phones route.
//   ONBOARDING_AGENT_LOOP_COHORT_PCT 0..100 (default 100). A stable per-phone
//                                    hash bucket < pct routes to the loop.
export function onboardingCohortPhones(): ReadonlySet<string> {
  const raw = process.env.ONBOARDING_AGENT_LOOP_PHONES ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function onboardingCohortPct(): number {
  const raw = process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT;
  // Unset/empty is the legitimate default: no narrowing, everyone in the enabled
  // role (identical to the role flag alone).
  if (raw === undefined || raw.trim() === "") return 100;
  const n = Number(raw);
  // A MALFORMED value (e.g. "10%", "ten") must fail CLOSED, not open. This is a
  // containment knob: a typo should narrow exposure to the proven legacy path
  // (0%), never silently widen a 10% canary to 100% of traffic.
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

// Stable 0..99 bucket from a phone (FNV-1a over its chars, via Math.imul for
// 32-bit wraparound). Deterministic: a given phone is always in or out for the
// life of a canary, so a user's experience doesn't flip turn to turn.
export function phoneCohortBucket(phone: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < phone.length; i++) {
    h ^= phone.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h | 0) % 100;
}

export function isPhoneInOnboardingCohort(phone: string | undefined): boolean {
  const allow = onboardingCohortPhones();
  if (allow.size > 0) {
    if (!phone) return false;
    for (const a of allow) {
      if (phone === a || phone.endsWith(a)) return true;
    }
    return false;
  }
  const pct = onboardingCohortPct();
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  // A narrowed canary is active but we have no phone to bucket — exclude rather
  // than over-route.
  if (!phone) return false;
  return phoneCohortBucket(phone) < pct;
}
