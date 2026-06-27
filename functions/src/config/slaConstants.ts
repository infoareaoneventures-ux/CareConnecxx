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
