import { describe, it, expect } from "vitest";
import { todayForModel } from "../scheduledTime";

describe("todayForModel", () => {
  it("names the weekday so the model never has to work it out", () => {
    // 2026-11-23 is a Monday.
    expect(todayForModel(new Date("2026-11-23T18:00:00Z"))).toBe("Monday, 2026-11-23");
    expect(todayForModel(new Date("2026-11-25T18:00:00Z"))).toBe("Wednesday, 2026-11-25");
  });
  it("uses the business (Pacific) date, not UTC", () => {
    // 03:00 UTC on the 24th is still the evening of Monday the 23rd in Pacific time.
    expect(todayForModel(new Date("2026-11-24T03:00:00Z"))).toBe("Monday, 2026-11-23");
  });
});
