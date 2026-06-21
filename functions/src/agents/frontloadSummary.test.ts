import { describe, it, expect } from "vitest";
import { summarizeFrontload } from "./frontloadSummary";

describe("summarizeFrontload", () => {
  it("recaps care facts when a family front-loads across 2+ question-groups", () => {
    const absorbed = {
      seniorName: "Dorothy",
      relationship: "mom",
      age: 78,
      conditions: ["early dementia"],
      city: "Austin",
    };
    const data = { firstName: "Sarah", ...absorbed };
    const recap = summarizeFrontload(absorbed, data);
    expect(recap).toBe("mom Dorothy, 78, early dementia, in Austin");
  });

  it("returns null for a single-group answer (handler acknowledges those)", () => {
    // Just the senior — the normal 'who are we caring for' answer.
    const absorbed = { seniorName: "Dorothy", relationship: "mom" };
    const data = { ...absorbed };
    expect(summarizeFrontload(absorbed, data)).toBeNull();
  });

  it("returns null when only the family member's own name is captured", () => {
    const absorbed = { firstName: "Sarah" };
    const data = { ...absorbed };
    expect(summarizeFrontload(absorbed, data)).toBeNull();
  });

  it("acknowledges name + senior even without care detail", () => {
    const absorbed = { firstName: "Sarah", seniorName: "Dorothy", relationship: "mom" };
    const data = { ...absorbed };
    // 2 groups (name + senior); the senior is the recap bit, name is the address.
    expect(summarizeFrontload(absorbed, data)).toBe("mom Dorothy");
  });

  it("includes schedule and caps care detail at three items", () => {
    const absorbed = {
      seniorName: "Dorothy",
      age: 78,
      conditions: ["dementia", "diabetes"],
      careNeeds: ["bathing", "meals"],
      schedule: "3 mornings a week",
    };
    const data = { ...absorbed };
    const recap = summarizeFrontload(absorbed, data);
    // needs detail capped at 3: age + first two conditions/needs
    expect(recap).toBe("Dorothy, 78, dementia, diabetes, 3 mornings a week");
  });

  it("returns null when 2 groups are flagged but no concrete facts are present", () => {
    // e.g. zipCode + firstName flagged but no city/senior/needs to recap
    const absorbed = { firstName: "Sarah", zipCode: "78701" };
    const data = { firstName: "Sarah", zipCode: "78701" };
    expect(summarizeFrontload(absorbed, data)).toBeNull();
  });
});
