// Centralized SLA / TTL constants (U14).
//
// These durations were previously inlined as `24 * 60 * 60 * 1000` / `2 * 60 *
// 60 * 1000` across several writers AND quoted as "24h" / "2h" in user-facing
// copy. Centralizing them here is the single source of truth so the logic and
// the copy that quotes it can never drift apart. No Remote Config (KTD-9) —
// these are deploy-time constants.

const HOUR_MS = 60 * 60 * 1000;

// ── Timesheet auto-approve SLA ───────────────────────────────────────────────
// Caregiver-submitted shift hours auto-approve if the client doesn't review them
// within this window. Used by every `autoApproveAt` writer (shiftHours, the
// route-caregiver hours flow, the MCP submit_shift_hours tool) and the scheduled
// sweeper, plus every "auto-approves in 24h" copy string.
export const TIMESHEET_AUTO_APPROVE_HOURS = 24;
export const TIMESHEET_AUTO_APPROVE_MS = TIMESHEET_AUTO_APPROVE_HOURS * HOUR_MS;

// ISO timestamp at which submitted hours auto-approve, measured from `fromMs`
// (defaults to now). Keeps the computation identical across all writers.
export function autoApproveAtIso(fromMs: number = Date.now()): string {
  return new Date(fromMs + TIMESHEET_AUTO_APPROVE_MS).toISOString();
}

// ── Shift-offer TTL ──────────────────────────────────────────────────────────
// Shift offers (booking / swap / time-change) expire if the caregiver doesn't
// reply in time. Matches the booking-task TTL by design.
export const SHIFT_OFFER_TTL_HOURS = 2;
export const SHIFT_OFFER_TTL_MS = SHIFT_OFFER_TTL_HOURS * HOUR_MS;

// ── Childcare observability SLAs + canary thresholds (U13 / R57, R61-R63) ────
//
// Red/amber thresholds for childcareCanaryWatch. Two threshold CLASSES:
//   • ZERO-TOLERANCE invariants — any nonzero count is RED. These are safety/
//     privacy guarantees that must never be violated even once: a stale
//     provider still visible, a message-disclosure violation, a childcare row
//     in a memory store, a payment reconciliation mismatch, an unresolved
//     migration record, and source-manifest drift.
//   • GRADED signals — amber warns, red pages. Denial spikes, matching drops,
//     booking anomalies, incident SLA misses, and stuck lifecycle tasks.
//
// All counts are over the canary lookback window unless noted. These are
// deploy-time constants (no Remote Config) — same rationale as the SLAs above.

/** Canary lookback window for graded counts. */
export const CHILDCARE_CANARY_LOOKBACK_HOURS = 24;
export const CHILDCARE_CANARY_LOOKBACK_MS = CHILDCARE_CANARY_LOOKBACK_HOURS * HOUR_MS;

/** Serious-incident operator response SLA (R56/AE24). A case open past red is a miss. */
export const CHILDCARE_INCIDENT_SLA_AMBER_HOURS = 1;
export const CHILDCARE_INCIDENT_SLA_RED_HOURS = 4;

/** A lifecycle (export/delete/redact/age-out) task stuck longer than this is anomalous (R14-R16). */
export const CHILDCARE_LIFECYCLE_STUCK_AMBER_HOURS = 2;
export const CHILDCARE_LIFECYCLE_STUCK_RED_HOURS = 6;

/**
 * Graded thresholds keyed by signal. `amber` warns (medium alert, no rollout
 * hold); `red` pages AND sets the rollout-hold signal. ZERO-tolerance signals
 * carry amber:0/red:1 so any single occurrence is red.
 */
export const CHILDCARE_CANARY_THRESHOLDS = {
  // Graded operational signals.
  authority_denial_spike:     { amber: 20, red: 50 },
  matching_eligibility_drop:  { amber: 10, red: 25 },
  booking_transition_anomaly: { amber: 5,  red: 15 },
  incident_sla_miss:          { amber: 1,  red: 2 },
  lifecycle_task_stuck:       { amber: 3,  red: 10 },
  enrollment_funnel_stall:    { amber: 5,  red: 20 },
  // Zero-tolerance invariants — any nonzero occurrence is RED.
  provider_expiry_visible:    { amber: 0,  red: 1 },
  payment_reconciliation_mismatch: { amber: 0, red: 1 },
  message_disclosure_violation:    { amber: 0, red: 1 },
  memory_denial_breach:            { amber: 0, red: 1 },
  migration_count_mismatch:        { amber: 0, red: 1 },
  source_manifest_drift:           { amber: 0, red: 1 },
  redactor_failure:                { amber: 0, red: 1 },
} as const;

export type ChildcareCanarySignalName = keyof typeof CHILDCARE_CANARY_THRESHOLDS;

/** Signals whose RED state forces an automatic rollout HOLD (U14 deploy gate reads it). */
export const CHILDCARE_ROLLOUT_HOLD_SIGNALS: ReadonlySet<ChildcareCanarySignalName> = new Set([
  "provider_expiry_visible",
  "payment_reconciliation_mismatch",
  "message_disclosure_violation",
  "memory_denial_breach",
  "migration_count_mismatch",
  "source_manifest_drift",
  "redactor_failure",
  "incident_sla_miss",
]);

/** Escalation owner per signal (who gets paged / owns the response). */
export const CHILDCARE_CANARY_ESCALATION_OWNER: Record<ChildcareCanarySignalName, string> = {
  authority_denial_spike:          "childSafetyOperator",
  matching_eligibility_drop:       "generalOperator",
  booking_transition_anomaly:      "generalOperator",
  incident_sla_miss:               "childSafetyOperator",
  lifecycle_task_stuck:            "childSafetyOperator",
  enrollment_funnel_stall:         "generalOperator",
  provider_expiry_visible:         "childSafetyOperator",
  payment_reconciliation_mismatch: "generalOperator",
  message_disclosure_violation:    "childSafetyOperator",
  memory_denial_breach:            "childSafetyOperator",
  migration_count_mismatch:        "generalOperator",
  source_manifest_drift:           "generalOperator",
  redactor_failure:                "childSafetyOperator",
};
