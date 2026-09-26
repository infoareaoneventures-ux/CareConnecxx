// Availability = the website's TWO pickers (days of the week + parts of the
// day) and the wizard's $15–$200 rate rule, on Evia's side (2026-09-26).
import { describe, it, expect } from "vitest";
import { availabilityComplete, missingRequiredFields, coerceCaregiverRate } from "../onboardingContract";
import { hasTimeOfDaySignal } from "../caregiverAvailability";

describe("availabilityComplete", () => {
  it("needs BOTH days and a part of the day", () => {
    expect(availabilityComplete({ days: ["Monday"], hours: "mornings" })).toBe(true);
    expect(availabilityComplete({ days: ["weekdays"], hours: "9am-5pm" })).toBe(true);
    expect(availabilityComplete({ days: ["Monday"], hours: "" })).toBe(false);
    expect(availabilityComplete({ days: [], hours: "mornings and afternoons" })).toBe(false);
    expect(availabilityComplete({ days: [], hours: "" })).toBe(false);
    expect(availabilityComplete(undefined)).toBe(false);
  });
  it("a bare day list or a days-only string is not complete", () => {
    expect(availabilityComplete(["Monday", "Tuesday"])).toBe(false);
    expect(availabilityComplete("weekends only")).toBe(false);
    expect(availabilityComplete("weekends, mornings")).toBe(true);
  });
  it("a half answer keeps availability in the caregiver's missing list", () => {
    const base = { name: "M", street: "1 A St", zipCode: "95134", city: "San Jose", state: "CA", profilePhoto: "u", jobType: "occasional" };
    expect(missingRequiredFields("caregiver", { ...base, availability: { days: ["Monday"], hours: "" } })[0]).toBe("availability");
    expect(missingRequiredFields("caregiver", { ...base, availability: { days: ["Monday"], hours: "mornings" } })[0]).toBe("specialties");
  });
});

describe("hasTimeOfDaySignal", () => {
  it("recognizes parts of the day, clock ranges, and 'any time'", () => {
    expect(hasTimeOfDaySignal("mornings")).toBe(true);
    expect(hasTimeOfDaySignal("9am-5pm")).toBe(true);
    expect(hasTimeOfDaySignal("9 to 5")).toBe(true);
    expect(hasTimeOfDaySignal("flexible")).toBe(true);
    expect(hasTimeOfDaySignal("Monday")).toBe(false);
    expect(hasTimeOfDaySignal("")).toBe(false);
    expect(hasTimeOfDaySignal(undefined)).toBe(false);
  });
});

describe("coerceCaregiverRate — the wizard's $15–$200 rule", () => {
  it("accepts numbers and numeric strings inside the range", () => {
    expect(coerceCaregiverRate(25)).toBe(25);
    expect(coerceCaregiverRate("$23/hr")).toBe(23);
    expect(coerceCaregiverRate("15")).toBe(15);
    expect(coerceCaregiverRate(200)).toBe(200);
  });
  it("rejects anything outside $15–$200 or non-numeric", () => {
    expect(coerceCaregiverRate(3)).toBeNull();
    expect(coerceCaregiverRate("$3")).toBeNull();
    expect(coerceCaregiverRate(201)).toBeNull();
    expect(coerceCaregiverRate("flexible")).toBeNull();
  });
});
