import { describe, it, expect } from "vitest";
import { timeOfDayFromClock } from "../familyClockTimes";

describe("timeOfDayFromClock", () => {
  it("9am to 1pm touches the morning and the afternoon", () => {
    expect(timeOfDayFromClock("Saturdays 9am to 1pm")).toEqual(["morning", "afternoon"]);
    expect(timeOfDayFromClock("change the time to 9am-1pm")).toEqual(["morning", "afternoon"]);
    expect(timeOfDayFromClock("9:00 AM – 1:00 PM")).toEqual(["morning", "afternoon"]);
  });
  it("a start without am/pm takes the one that makes a forward range", () => {
    expect(timeOfDayFromClock("9-1pm")).toEqual(["morning", "afternoon"]);
    expect(timeOfDayFromClock("from 2 to 6 pm")).toEqual(["afternoon", "evening"]);
  });
  it("single parts and overnight", () => {
    expect(timeOfDayFromClock("8am to 11am")).toEqual(["morning"]);
    expect(timeOfDayFromClock("1pm to 4pm")).toEqual(["afternoon"]);
    expect(timeOfDayFromClock("10pm to 6am")).toEqual(["morning", "overnight"]);
    expect(timeOfDayFromClock("10pm to 6am")).toContain("overnight");
  });
  it("returns nothing when no range is stated", () => {
    expect(timeOfDayFromClock("mornings please")).toEqual([]);
    expect(timeOfDayFromClock("around 9am")).toEqual([]);
    expect(timeOfDayFromClock("")).toEqual([]);
  });
});
