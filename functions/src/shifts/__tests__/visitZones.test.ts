import { describe, it, expect, vi } from "vitest";

// Wave 2 / time zones (2026-11-09): a visit's date + start time are wall-clock AT ITS CARE LOCATION.
vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({}) }, firestore: Object.assign(() => ({}), { FieldValue: {} }) }));
vi.mock("firebase-functions/v1", () => ({ config: () => ({}) }));

import { scheduledStartMs, startsInMinutes } from "../visitActions";
import { shiftTimes } from "../../agents/caregiverTimesheets";

const visit = (extra: Record<string, unknown>) => ({ date: "2026-11-10", startTime: "09:00", endTime: "12:00", ...extra });

describe("scheduledStartMs — the visit's own zone", () => {
  it.each([
    ["America/New_York", "2026-11-10T14:00:00.000Z"],
    ["America/Chicago", "2026-11-10T15:00:00.000Z"],
    ["America/Denver", "2026-11-10T16:00:00.000Z"],
    ["America/Los_Angeles", "2026-11-10T17:00:00.000Z"],
    ["America/Anchorage", "2026-11-10T18:00:00.000Z"],
    ["Pacific/Honolulu", "2026-11-10T19:00:00.000Z"],
    ["America/Phoenix", "2026-11-10T16:00:00.000Z"],
  ])("9:00 AM at %s", (timeZone, iso) => {
    expect(new Date(scheduledStartMs(visit({ timeZone }))).toISOString()).toBe(iso);
  });

  it("a visit with no zone reads from its address's ZIP, then Pacific (every existing record)", () => {
    expect(new Date(scheduledStartMs(visit({ address: "1 Main St, Chicago, IL 60601" }))).toISOString()).toBe("2026-11-10T15:00:00.000Z");
    expect(new Date(scheduledStartMs(visit({}))).toISOString()).toBe("2026-11-10T17:00:00.000Z");
  });

  it("the 15-minute start window opens at the same real moment for every zone's 9:00 AM", () => {
    for (const timeZone of ["America/New_York", "America/Chicago", "America/Los_Angeles"]) {
      const start = scheduledStartMs(visit({ timeZone }));
      expect(startsInMinutes(visit({ timeZone }), start - 14 * 60_000)).toBeCloseTo(14, 5);
      expect(startsInMinutes(visit({ timeZone }), start + 5 * 60_000)).toBeCloseTo(-5, 5);
    }
  });

  it("a different machine/viewer zone changes nothing — it is the care location that counts", () => {
    const eastern = scheduledStartMs(visit({ timeZone: "America/New_York" }));
    const pacific = scheduledStartMs(visit({ timeZone: "America/Los_Angeles" }));
    expect(pacific - eastern).toBe(3 * 3600_000);
  });
});

describe("timesheet scheduled times — the visit's own zone", () => {
  it("scheduled start and end are instants at the care location, and a visit past midnight ends the next day", () => {
    const t = shiftTimes({ date: "2026-11-10", startTime: "22:00", endTime: "01:00", timeZone: "America/Chicago" });
    expect(new Date(t.scheduledStartMs).toISOString()).toBe("2026-11-11T04:00:00.000Z");
    expect(t.scheduledEndMs - t.scheduledStartMs).toBe(3 * 3600_000);
  });
  it("across a daylight-saving change the visit is still the right length", () => {
    // Sun Nov 1 2026 fall-back in New York: 00:30 → 03:30 wall clock is FOUR real hours.
    const t = shiftTimes({ date: "2026-11-01", startTime: "00:30", endTime: "03:30", timeZone: "America/New_York" });
    expect(t.scheduledEndMs - t.scheduledStartMs).toBe(4 * 3600_000);
  });
});
