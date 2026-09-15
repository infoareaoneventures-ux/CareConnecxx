import { describe, it, expect } from "vitest";
import {
  parseScheduledTimeMs,
  businessTodayStr,
  businessTomorrowStr,
  slotHourKey,
  apptSlotHourKey,
  formatDateForDisplay,
  weekdayForDate,
  formatDateWithWeekday,
} from "./scheduledTime";

// Live-caught 2026-09-14: given only the bare date, the model (and one
// `new Date("YYYY-MM-DD").getDay()` call site) said "Tuesday, Sep 16" for a
// Wednesday — UTC-midnight parsing is still the previous day in Pacific after
// 5pm. The weekday is now computed from the date components and supplied.
describe("weekdayForDate / formatDateWithWeekday", () => {
  it("names the correct weekday regardless of the process timezone", () => {
    expect(weekdayForDate("2026-09-16")).toBe("Wednesday");
    expect(weekdayForDate("2026-09-15")).toBe("Tuesday");
    expect(weekdayForDate("2026-09-13")).toBe("Sunday");
  });

  it("prefixes the weekday onto the display date", () => {
    expect(formatDateWithWeekday("2026-09-16")).toBe("Wednesday, September 16, 2026");
  });

  it("passes non-ISO values through unchanged, with no weekday", () => {
    expect(weekdayForDate("ASAP")).toBeNull();
    expect(formatDateWithWeekday("ASAP")).toBe("ASAP");
  });
});

describe("formatDateForDisplay (live-caught: raw ISO echoed back in a text message)", () => {
  it("formats a YYYY-MM-DD value as a human-readable date", () => {
    expect(formatDateForDisplay("2026-09-15")).toBe("September 15, 2026");
  });

  it("passes non-ISO values (ASAP, a parse-failure fallback) through unchanged", () => {
    expect(formatDateForDisplay("ASAP")).toBe("ASAP");
    expect(formatDateForDisplay("next Monday")).toBe("next Monday");
    expect(formatDateForDisplay("TBD")).toBe("TBD");
  });
});

describe("businessTomorrowStr", () => {
  it("is the Pacific calendar day after businessTodayStr, not UTC", () => {
    // 2026-07-11T02:00:00Z = 7:00 PM PDT on 2026-07-10 — UTC date is already
    // the 11th, but Pacific tomorrow is still the 11th, not the 12th.
    const eveningPT = new Date("2026-07-11T02:00:00Z");
    expect(businessTodayStr("America/Los_Angeles", eveningPT)).toBe("2026-07-10");
    expect(businessTomorrowStr("America/Los_Angeles", eveningPT)).toBe("2026-07-11");
  });

  it("crosses month boundaries by calendar, not string math", () => {
    const now = new Date("2026-08-01T02:00:00Z"); // 7pm PDT July 31
    expect(businessTomorrowStr("America/Los_Angeles", now)).toBe("2026-08-01");
  });
});

describe("slot-hour collision keys", () => {
  it("keys a stored 12h-clock appointment and a naive ISO proposal into the same bucket", () => {
    // Family has a confirmed 2:00 PM PT appointment; caregiver proposes
    // "2026-07-12T14:00:00" (naive PT wall-clock, the parseAvailability shape).
    const busy = apptSlotHourKey("2026-07-12", "2:00 PM");
    const proposal = slotHourKey(parseScheduledTimeMs("2026-07-12T14:00:00"));
    expect(busy).toBe("2026-07-12T14");
    expect(proposal).toBe(busy);
  });

  it("keys a tz-aware ISO proposal into the same Pacific bucket", () => {
    const proposal = slotHourKey(parseScheduledTimeMs("2026-07-12T14:00:00-07:00"));
    expect(proposal).toBe("2026-07-12T14");
  });

  it("does not collide distinct hours", () => {
    const busy = apptSlotHourKey("2026-07-12", "2:00 PM");
    const proposal = slotHourKey(parseScheduledTimeMs("2026-07-12T16:00:00"));
    expect(proposal).not.toBe(busy);
  });

  it("handles single-digit and 24h stored times (the old slice(0,2) garbled these)", () => {
    expect(apptSlotHourKey("2026-07-12", "9:00 AM")).toBe("2026-07-12T09");
    expect(apptSlotHourKey("2026-07-12", "21:30")).toBe("2026-07-12T21");
    expect(apptSlotHourKey("2026-07-12", "12:00 AM")).toBe("2026-07-12T00");
  });

  it("returns null for unparseable stored times instead of a bogus bucket", () => {
    expect(apptSlotHourKey("2026-07-12", "afternoon")).toBeNull();
    expect(apptSlotHourKey("2026-07-12", undefined)).toBeNull();
    expect(apptSlotHourKey(undefined, "2:00 PM")).toBeNull();
  });
});
