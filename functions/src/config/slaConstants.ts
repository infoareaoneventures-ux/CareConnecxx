// Centralized SLA / TTL constants (U14).
//
// This duration was previously inlined as `24 * 60 * 60 * 1000` across several
// writers AND quoted as "24h" in user-facing copy. (The 2h shift-offer TTL that
// lived here went with the shift-offer pipeline, removed 2026-09-28.) Centralizing them here is the single source of truth so the logic and
// the copy that quotes it can never drift apart. No Remote Config (KTD-9) —
// these are deploy-time constants.

const HOUR_MS = 60 * 60 * 1000;

// ── Timesheet auto-approve SLA ───────────────────────────────────────────────
// Caregiver-submitted shift hours auto-approve if the client doesn't review them
// within this window. Used by every `autoApproveAt` writer (shiftHours.ts) and the scheduled
// sweeper, plus every "auto-approves in 24h" copy string.
export const TIMESHEET_AUTO_APPROVE_HOURS = 24;
export const TIMESHEET_AUTO_APPROVE_MS = TIMESHEET_AUTO_APPROVE_HOURS * HOUR_MS;

// ISO timestamp at which submitted hours auto-approve, measured from `fromMs`
// (defaults to now). Keeps the computation identical across all writers.
export function autoApproveAtIso(fromMs: number = Date.now()): string {
  return new Date(fromMs + TIMESHEET_AUTO_APPROVE_MS).toISOString();
}
