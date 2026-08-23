import { describe, it, expect } from "vitest";
import {
  recipientPlanKey,
  householdSeniorDocId,
  normalizeAdditionalRecipients,
  allCareRecipients,
} from "../careRecipients";

describe("recipientPlanKey — must match components/CarePlan.tsx getKey", () => {
  it("lowercases and defaults missing last name to noname", () => {
    expect(recipientPlanKey("Dorothy")).toBe("dorothy_noname");
    expect(recipientPlanKey("Dorothy", "Smith")).toBe("dorothy_smith");
  });
  it("collapses whitespace and strips field-path-hostile chars", () => {
    expect(recipientPlanKey("Mary Ann", "St. Clair")).toBe("mary_ann_st_clair");
    expect(recipientPlanKey("A[b]c*d/e~f")).toBe("abcdef_noname");
  });
});

describe("householdSeniorDocId", () => {
  it("is deterministic per client+name", () => {
    expect(householdSeniorDocId("uid1", "Frank")).toBe("uid1_frank_noname");
    expect(householdSeniorDocId("uid1", "Frank")).toBe(householdSeniorDocId("uid1", "Frank"));
  });
});

describe("normalizeAdditionalRecipients", () => {
  it("validates shape and drops junk", () => {
    expect(normalizeAdditionalRecipients([
      { name: "Frank", relationship: "father", age: 85 },
      { name: "  " },
      "junk",
      null,
      { relationship: "uncle" },
      { name: "Rosa", age: "not-a-number" },
    ])).toEqual([
      { name: "Frank", relationship: "father", age: 85 },
      { name: "Rosa" },
    ]);
  });
  it("dedupes by key", () => {
    expect(normalizeAdditionalRecipients([
      { name: "Frank" }, { name: "frank " },
    ])).toEqual([{ name: "Frank" }]);
  });
  it("returns [] for non-arrays", () => {
    expect(normalizeAdditionalRecipients(undefined)).toEqual([]);
    expect(normalizeAdditionalRecipients("Frank")).toEqual([]);
  });
});

describe("allCareRecipients", () => {
  it("primary first, then additional, primary deduped", () => {
    expect(allCareRecipients({
      seniorName: "Dorothy", relationship: "mother", age: 82,
      additionalRecipients: [
        { name: "Frank", relationship: "father", age: 85 },
        { name: "dorothy" },
      ],
    })).toEqual([
      { name: "Dorothy", relationship: "mother", age: 82 },
      { name: "Frank", relationship: "father", age: 85 },
    ]);
  });
  it("single-recipient signups yield one entry", () => {
    expect(allCareRecipients({ seniorName: "Dorothy", relationship: "mother" }))
      .toEqual([{ name: "Dorothy", relationship: "mother" }]);
  });
  it("empty data yields []", () => {
    expect(allCareRecipients({})).toEqual([]);
  });
  // Evia's internal "self" sentinel (self-referential voice/logic) must be
  // translated to the website wizard's "myself" before reaching a
  // website-facing document — see toWebsiteRelationship.
  it("translates the internal 'self' sentinel to the website's 'myself'", () => {
    expect(allCareRecipients({ seniorName: "Dorothy", relationship: "self" }))
      .toEqual([{ name: "Dorothy", relationship: "myself" }]);
  });
});
