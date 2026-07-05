import { describe, it, expect } from "vitest";
import {
  deriveWeeklyAvailability,
  normalizeDays,
  parseHoursToSlots,
} from "../caregiverAvailability";

describe("parseHoursToSlots", () => {
  it("parses am/pm ranges", () => {
    expect(parseHoursToSlots("9am-5pm")).toEqual([{ start: "09:00", end: "17:00" }]);
  });
  it("parses 'to' ranges with minutes", () => {
    expect(parseHoursToSlots("9:30am to 2pm")).toEqual([{ start: "09:30", end: "14:00" }]);
  });
  it("assumes daytime for bare '9-5'", () => {
    expect(parseHoursToSlots("9-5")).toEqual([{ start: "09:00", end: "17:00" }]);
  });
  it("maps keyword blocks", () => {
    expect(parseHoursToSlots("mornings")).toEqual([{ start: "06:00", end: "12:00" }]);
    expect(parseHoursToSlots("mornings and evenings")).toEqual([
      { start: "06:00", end: "12:00" },
      { start: "17:00", end: "22:00" },
    ]);
  });
  it("treats flexible/anytime as all day", () => {
    expect(parseHoursToSlots("flexible")).toEqual([{ start: "00:00", end: "23:59" }]);
  });
  it("falls back to broad daytime on junk", () => {
    expect(parseHoursToSlots("")).toEqual([{ start: "08:00", end: "18:00" }]);
    expect(parseHoursToSlots("depends on the week")).toEqual([{ start: "08:00", end: "18:00" }]);
  });
});

describe("normalizeDays", () => {
  it("normalizes full day names", () => {
    expect(normalizeDays(["Monday", "Wednesday"])).toEqual(["monday", "wednesday"]);
  });
  it("expands weekdays / weekends / every day", () => {
    expect(normalizeDays(["weekdays"])).toEqual([
      "monday", "tuesday", "wednesday", "thursday", "friday",
    ]);
    expect(normalizeDays(["Weekends"])).toEqual(["saturday", "sunday"]);
    expect(normalizeDays(["every day"])).toHaveLength(7);
  });
  it("matches 3-letter abbreviations", () => {
    expect(normalizeDays(["Mon", "Tue", "sat"])).toEqual(["monday", "tuesday", "saturday"]);
  });
  it("returns [] for non-arrays and junk", () => {
    expect(normalizeDays(undefined)).toEqual([]);
    expect(normalizeDays("Monday")).toEqual([]);
    expect(normalizeDays([42])).toEqual([]);
  });
});

describe("deriveWeeklyAvailability", () => {
  it("builds the scoring-compatible map", () => {
    expect(
      deriveWeeklyAvailability({ days: ["Monday", "Tuesday"], hours: "9am-5pm" }),
    ).toEqual({
      monday:  [{ start: "09:00", end: "17:00" }],
      tuesday: [{ start: "09:00", end: "17:00" }],
    });
  });
  it("returns undefined when days missing", () => {
    expect(deriveWeeklyAvailability({ days: [], hours: "9-5" })).toBeUndefined();
    expect(deriveWeeklyAvailability(undefined)).toBeUndefined();
    expect(deriveWeeklyAvailability("9-5")).toBeUndefined();
  });
  it("defaults hours when unparseable but days known", () => {
    expect(deriveWeeklyAvailability({ days: ["Friday"], hours: "varies" })).toEqual({
      friday: [{ start: "08:00", end: "18:00" }],
    });
  });
});
