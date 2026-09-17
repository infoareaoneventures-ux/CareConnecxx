import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source-scan regression guard (2026-09-14, Hamse's call — full proactive
 * sweep), same style as agents/__tests__/whoIsWhoCoverage.test.ts's R11 audit.
 *
 * Rule: any date/time value that reaches SMS text (a sendMessage/sendToPhone
 * call, a template literal that becomes SMS copy) or an LLM prompt that
 * generates SMS text (generateCaraMessage context/fallback, a system-prompt
 * builder) MUST go through the shared formatters in utils/scheduledTime.ts —
 * formatDateForDisplay ("YYYY-MM-DD" → "September 15, 2026") and
 * formatHHMMForDisplay ("HH:MM" 24h → "9:00 AM") — never interpolated raw,
 * and never via a local reimplementation.
 *
 * Why this exists: a 2026-09-14 live-test session found this exact bug class
 * independently in 20+ files across the backend (raw "2026-09-15"/"14:00"
 * values reaching families and caregivers over SMS) despite two of the
 * shared formatters already existing and being correct — the problem was
 * never a missing formatter, it was call sites that forgot to use it. A
 * per-file count assertion (not a full TS parser) catches the same class of
 * regression the moment someone reintroduces a raw interpolation, the same
 * way R11 already guards who-is-who grounding.
 *
 * These are pragmatic per-file MINIMUM count assertions: each listed file
 * must call formatDateForDisplay/formatHHMMForDisplay at least as many times
 * as it did when this guard was written. Dropping a formatted call back to a
 * raw interpolation lowers the count and fails the corresponding assertion.
 * Adding MORE formatted call sites later is fine — bump the count here too
 * (or leave it; toBeGreaterThanOrEqual doesn't require the number be exact).
 */

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

// file (relative to this __tests__ dir) → minimum combined call count of
// formatDateForDisplay(...) + formatHHMMForDisplay(...).
const MIN_FORMATTER_CALLS: Array<[string, number]> = [
  ["../sms.ts",                                10],
  ["../triggers/notificationTriggers.ts",       7],
  // Dropped from 8 to 4 (2026-09-14): the caregiver-cancellation emergency-
  // replacement flow (handleCaregiverCancellation/onShiftUpdated) was removed
  // entirely — it duplicated/conflicted with the real shifts-based
  // needs_replacement flow (onShiftStatusChanged, mcp/server.ts's
  // get_callout_backups/select_callout_backup) and had a dead-end REPLACE/SKIP
  // reply path. Remaining calls are the booking-confirmed/arrival/reminder paths.
  ["../triggers/appointmentUpdated.ts",         4],
  ["../agents/latenessTracker.ts",              1],
  ["../scheduled/shiftTaskNudges.ts",           4],
  ["../scheduled/weeklyDigest.ts",              2],
  ["../scheduled/dayBeforeShiftReminder.ts",    2],
  // 2 (2026-09-17): the reminder is now one deterministic sentence per language,
  // each formatting the start time once — no model rewrite of the time anymore.
  ["../scheduled/clientDayBeforeReminder.ts",   1],
  ["../agents/clientSwapRequestHandler.ts",    13],
  ["../agents/caregiverSwapHandler.ts",        15],
  ["../agents/caregiverCancelShiftHandler.ts",  6],
  ["../agents/timesheetHandler.ts",            11],
  ["../agents/shiftOffer.ts",                  11],
  ["../agents/qaAgent.ts",                      4],
  ["../agents/situationSnapshot.ts",            2],
  // Dropped from 18 (2026-09-17): the legacy appointments-based REBOOK_REQUEST /
  // pendingRebook path (which formatted the prior visit's date/times in its
  // own copy) was removed — a resend/rebook now goes through the booking
  // flow, whose recap formats through the same helpers in bookingFlow.ts.
  // Dropped from 15 to 6 (2026-09-17): the legacy CANCEL_REQUEST /
  // pendingCancelConfirm path (which formatted the appointment's date/time
  // into its own briefing + confirm texts) was removed — cancel now goes
  // through cancelFlow.ts, which formats via bookingCancel.ts's option labels.
  // routeIntent.ts row removed 2026-09-17: its last formatted SMS sites (the
  // agent-task booking approval texts, hireMode summary, and the legacy
  // recurring-schedule handlers) all went with the retired Evia-only paths —
  // every date/time the router still sends is rendered by a scripted flow.
  ["../linq/routeCaregiver.ts",                 5],
  ["../mcp/server.ts",                          1],
];

describe("time/date formatting coverage — every audited SMS/LLM-prompt site is formatted", () => {
  it.each(MIN_FORMATTER_CALLS)("%s calls the shared formatters at least %i time(s)", (rel, minCalls) => {
    const src = read(rel);
    // formatDateWithWeekday (2026-09-14) is the same shared formatter family —
    // formatDateForDisplay with the weekday in front — so it counts too.
    const calls = count(src, "formatDateForDisplay(") + count(src, "formatHHMMForDisplay(") + count(src, "formatDateWithWeekday(");
    expect(calls, `${rel} must call formatDateForDisplay/formatDateWithWeekday/formatHHMMForDisplay at least ${minCalls} time(s) — found ${calls}. If a raw date/time interpolation crept back in, wrap it in the shared formatter instead of removing this assertion.`)
      .toBeGreaterThanOrEqual(minCalls);
  });

  it("bookingFlow.ts, interviewFlow.ts, and bookingResolution.ts (fixed earlier the same session) still import the shared formatters", () => {
    for (const rel of ["../agents/bookingFlow.ts", "../agents/interviewFlow.ts", "../agents/bookingResolution.ts"]) {
      const src = read(rel);
      expect(src, `${rel} must still import from utils/scheduledTime`)
        .toMatch(/from ["']\.\.\/(utils\/scheduledTime|scheduled\/shiftGenerator)["']/);
    }
  });
});
