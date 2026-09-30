import { describe, it, expect } from "vitest";
import { gridFromWeekly, weeklyFromGrid, applyGridPatch, gridText, emptyGrid, blocksFromSlots, gridsEqual } from "../caregiverAvailabilityGrid";

// The Calendar page's Update Availability grid as data — round-trips through the
// site's own conversions (services/availabilityService.ts) and the modal's taps.

describe("stored slots ↔ the modal's blocks", () => {
  it("reads canonical slots, legacy block names and odd ranges the way weeklySlotsToBl lights blocks", () => {
    expect(blocksFromSlots([{ start: "06:00", end: "12:00" }, { start: "12:00", end: "18:00" }])).toEqual(["morning", "afternoon"]);
    expect(blocksFromSlots(["evening", "Morning"])).toEqual(["morning", "evening"]);
    expect(blocksFromSlots([{ start: "09:00", end: "17:00" }])).toEqual(["morning", "afternoon"]);   // a clock range lights every block it touches
    expect(blocksFromSlots([{ start: "23:00", end: "06:00" }])).toEqual(["overnight"]);              // crosses midnight
    expect(blocksFromSlots([{ start: "08:00", end: "20:00" }])).toEqual(["morning", "afternoon", "evening"]);
    expect(blocksFromSlots([])).toEqual([]);
  });
  it("writes what Save writes: every day, canonical slot per block, in block order", () => {
    const grid = { ...emptyGrid(), monday: ["afternoon", "morning"] as any, saturday: ["overnight"] as any };
    expect(weeklyFromGrid(grid)).toEqual({
      sunday: [], monday: [{ start: "06:00", end: "12:00" }, { start: "12:00", end: "18:00" }], tuesday: [], wednesday: [], thursday: [], friday: [],
      saturday: [{ start: "23:00", end: "06:00" }],
    });
    expect(gridFromWeekly(weeklyFromGrid(grid))).toEqual({ ...emptyGrid(), monday: ["morning", "afternoon"], saturday: ["overnight"] });
  });
  it("tolerates abbreviated / capitalised day keys and ignores junk", () => {
    expect(gridFromWeekly({ Mon: ["morning"], TUESDAY: [{ start: "12:00", end: "18:00" }], nope: ["morning"], wed: "x" })).toEqual({ ...emptyGrid(), monday: ["morning"], tuesday: ["afternoon"] });
  });
});

describe("taps", () => {
  it("set replaces a day's column, add and remove toggle cells, ALL / [] clear or fill, unknown days are reported", () => {
    const current = { ...emptyGrid(), monday: ["morning"] as any, friday: ["morning", "afternoon", "evening"] as any };
    const r = applyGridPatch(current, { set: { tue: ["evening", "morning"] }, add: { monday: ["afternoon"], sat: ["all"] }, remove: { friday: ["afternoon"], sunday: "all", funday: ["morning"] } });
    expect(r.grid).toEqual({ ...emptyGrid(), monday: ["morning", "afternoon"], tuesday: ["morning", "evening"], friday: ["morning", "evening"], saturday: ["morning", "afternoon", "evening", "overnight"] });
    expect(r.unknownDays).toEqual(["funday"]);
    expect(gridsEqual(current, r.grid)).toBe(false);
    expect(applyGridPatch(current, {}).grid).toEqual(current);
  });
  it("prints the grid Sun → Sat like the modal's rows", () => {
    expect(gridText({ ...emptyGrid(), monday: ["morning", "afternoon"] as any })).toBe("Sun: —\nMon: Morning, Afternoon\nTue: —\nWed: —\nThu: —\nFri: —\nSat: —");
  });
});
