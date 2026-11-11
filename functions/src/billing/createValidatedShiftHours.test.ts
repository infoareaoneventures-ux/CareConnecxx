import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({});
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

import { bookedWindowMillis } from "./createValidatedShiftHours";

describe("bookedWindowMillis", () => {
  it("resolves same-day appointment windows", () => {
    const result = bookedWindowMillis({ date: "2026-07-12", startTime: "09:00", endTime: "13:00" });
    expect(result).not.toBeNull();
    expect((result!.end - result!.start) / 3_600_000).toBe(4);
  });

  it("resolves overnight appointment windows", () => {
    const result = bookedWindowMillis({ date: "2026-07-12", startTime: "22:00", endTime: "06:00" });
    expect(result).not.toBeNull();
    expect((result!.end - result!.start) / 3_600_000).toBe(8);
  });

  it("uses duration when no end time is present and rejects incomplete records", () => {
    const result = bookedWindowMillis({ date: "2026-07-12", time: "09:00", durationHours: 3 });
    expect((result!.end - result!.start) / 3_600_000).toBe(3);
    expect(bookedWindowMillis({ date: "2026-07-12" })).toBeNull();
  });
});

// 2026-11-09 (all U.S. zones): the booked window is the visit's own care-location wall clock, so a correctly timed
// clock-in at a non-Pacific visit is not "outside the booked window".
describe("bookedWindowMillis — care-location zones", () => {
  it.each([
    ["America/New_York", "2026-11-10T14:00:00.000Z"],
    ["America/Chicago", "2026-11-10T15:00:00.000Z"],
    ["America/Denver", "2026-11-10T16:00:00.000Z"],
    ["America/Los_Angeles", "2026-11-10T17:00:00.000Z"],
    ["America/Phoenix", "2026-11-10T16:00:00.000Z"],
    ["Pacific/Honolulu", "2026-11-10T19:00:00.000Z"],
  ])("9:00 AM at %s starts at %s", (timeZone, iso) => {
    const w = bookedWindowMillis({ date: "2026-11-10", startTime: "09:00", endTime: "12:00", timeZone });
    expect(new Date(w!.start).toISOString()).toBe(iso);
    expect((w!.end - w!.start) / 3_600_000).toBe(3);
  });

  it("a visit with no zone reads from its address, then Pacific", () => {
    expect(new Date(bookedWindowMillis({ date: "2026-11-10", startTime: "09:00", endTime: "12:00", address: "1 Main St, Chicago, IL 60601" })!.start).toISOString()).toBe("2026-11-10T15:00:00.000Z");
    expect(new Date(bookedWindowMillis({ date: "2026-11-10", startTime: "09:00", endTime: "12:00" })!.start).toISOString()).toBe("2026-11-10T17:00:00.000Z");
  });

  it("a Chicago provider's real 9:02-11:58 AM clock times sit INSIDE the window (they would be 2 hours outside a Pacific one)", () => {
    const w = bookedWindowMillis({ date: "2026-11-10", startTime: "09:00", endTime: "12:00", timeZone: "America/Chicago" })!;
    const clockIn = Date.UTC(2026, 10, 10, 15, 2), clockOut = Date.UTC(2026, 10, 10, 17, 58);
    expect(clockIn >= w.start && clockOut <= w.end).toBe(true);
    const wrong = bookedWindowMillis({ date: "2026-11-10", startTime: "09:00", endTime: "12:00" })!; // Pacific reading
    expect(clockIn >= wrong.start && clockOut <= wrong.end).toBe(false);
  });
});
