import { describe, it, expect, vi } from "vitest";

/**
 * markAppointmentsCompleted computes when a shift ends from the stored
 * Pacific wall-clock `isoDate` + `time`. Parsing that wall-clock as UTC
 * ("...T17:00:00Z") lands 7-8h EARLY — the cron then flips a 5pm shift to
 * `completed` around 12:30pm, hours before the caregiver arrives, which
 * unblocks submitShiftHours pre-shift. These tests pin the schedule-end
 * math to the business timezone (America/Los_Angeles).
 */

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: () => ({}) }), {
    FieldValue: { serverTimestamp: () => ({ __ts: true }) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) },
}));

import { computeScheduledEndMs } from "./appointmentCompletion";

describe("computeScheduledEndMs — business-timezone schedule math", () => {
  it("treats a 12h-clock time as Pacific wall-clock, not UTC", () => {
    // 5:00 PM PDT on 2026-07-11 + 2h → ends 7pm PDT = 2026-07-12T02:00:00Z
    const end = computeScheduledEndMs("2026-07-11", "5:00 PM", 2);
    expect(end).toBe(Date.parse("2026-07-12T02:00:00Z"));
  });

  it("treats a 24h-clock time as Pacific wall-clock, not UTC", () => {
    // 09:30 PDT on 2026-07-11 + 1h → ends 10:30 PDT = 17:30Z
    const end = computeScheduledEndMs("2026-07-11", "09:30", 1);
    expect(end).toBe(Date.parse("2026-07-11T17:30:00Z"));
  });

  it("respects PST (winter) offsets, not a hardcoded -7", () => {
    // 3:00 PM PST on 2026-01-15 + 1h → ends 4pm PST = 2026-01-16T00:00:00Z
    const end = computeScheduledEndMs("2026-01-15", "3:00 PM", 1);
    expect(end).toBe(Date.parse("2026-01-16T00:00:00Z"));
  });

  it("defaults duration to 1h when missing", () => {
    const end = computeScheduledEndMs("2026-07-11", "10:00 AM", undefined);
    expect(end).toBe(Date.parse("2026-07-11T18:00:00Z"));
  });

  it("returns null on unparseable inputs", () => {
    expect(computeScheduledEndMs(undefined, "10:00 AM", 1)).toBeNull();
    expect(computeScheduledEndMs("2026-07-11", "sometime", 1)).toBeNull();
  });
});
