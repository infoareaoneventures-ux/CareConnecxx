import { describe, it, expect, vi } from "vitest";

// Stale-trigger guards (triggerEngine.ts, 2026-10-01): a held reminder is never
// released days late, and an interview reminder fires only against the live,
// still-agreed, still-about-an-hour-away interview.

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: () => ({ doc: () => ({}), where: () => ({}) }), doc: () => ({}), batch: () => ({}) }), { FieldValue: { serverTimestamp: () => "__ts__", delete: () => "__del__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({ pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) } }));

import { isStaleTrigger, interviewReminderStillValid, STALE_REMINDER_MS, STALE_GENERIC_MS } from "../triggerEngine";

const NOW = Date.parse("2026-10-02T03:10:00.000Z"); // the 8:10 PM PDT run that released the Sep 27 reminders

describe("isStaleTrigger", () => {
  it("an interview reminder more than 2 hours past due is stale; a fresh one is not", () => {
    expect(isStaleTrigger({ type: "appointment_reminder", scheduledAt: "2026-09-27T23:00:00.000Z" }, NOW)).toBe(true);  // Sep 27 — four days late
    expect(isStaleTrigger({ type: "appointment_reminder", scheduledAt: new Date(NOW - STALE_REMINDER_MS + 60_000).toISOString() }, NOW)).toBe(false);
    expect(isStaleTrigger({ type: "appointment_reminder", scheduledAt: new Date(NOW - STALE_REMINDER_MS - 60_000).toISOString() }, NOW)).toBe(true);
  });
  it("other triggers get a day; an unparseable date is never treated as stale", () => {
    expect(isStaleTrigger({ type: "custom", scheduledAt: new Date(NOW - STALE_GENERIC_MS + 60_000).toISOString() }, NOW)).toBe(false);
    expect(isStaleTrigger({ type: "custom", scheduledAt: new Date(NOW - STALE_GENERIC_MS - 60_000).toISOString() }, NOW)).toBe(true);
    expect(isStaleTrigger({ type: "custom", scheduledAt: "garbage" }, NOW)).toBe(false);
  });
});

describe("interviewReminderStillValid", () => {
  const inAnHour = new Date(NOW + 60 * 60_000).toISOString();
  it("fires only for an accepted/confirmed interview that starts 30–120 minutes from now", () => {
    expect(interviewReminderStillValid({ status: "accepted", scheduledTime: inAnHour }, NOW)).toBe(true);
    expect(interviewReminderStillValid({ status: "confirmed", scheduledTime: inAnHour }, NOW)).toBe(true);
    expect(interviewReminderStillValid({ status: "cancelled", scheduledTime: inAnHour }, NOW)).toBe(false);
    expect(interviewReminderStillValid({ status: "completed", scheduledTime: inAnHour }, NOW)).toBe(false);
    expect(interviewReminderStillValid({ status: "accepted", scheduledTime: "2026-09-28T00:00:00.000Z" }, NOW)).toBe(false); // already happened
    expect(interviewReminderStillValid({ status: "accepted", scheduledTime: new Date(NOW + 3 * 60 * 60_000).toISOString() }, NOW)).toBe(false); // moved later — a fresh reminder is scheduled for the new time
    expect(interviewReminderStillValid(null, NOW)).toBe(false);
  });
});
