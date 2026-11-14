import { describe, it, expect } from "vitest";
import { mergeSamePerson } from "../familyIntakeScript";

const mom = { relationship: "parent" as const, name: "" };
const linda = { relationship: "parent" as const, name: "Linda" };

describe("mergeSamePerson", () => {
  it("'my mom, Linda' read as two people becomes one named person", () => {
    expect(mergeSamePerson([linda, mom], "It's for my mom, Linda. She's 82")).toEqual([linda]);
    expect(mergeSamePerson([mom, linda], "my mom Linda")).toEqual([linda]);
  });
  it("two real people stay two", () => {
    expect(mergeSamePerson([linda, mom], "my mom Linda and my dad")).toHaveLength(2);
    expect(mergeSamePerson([mom, mom], "my parents")).toHaveLength(2);
    expect(mergeSamePerson([linda, { relationship: "parent" as const, name: "Frank" }], "mom Linda, dad Frank")).toHaveLength(2);
  });
  it("different relationships and the account holder are never merged", () => {
    expect(mergeSamePerson([linda, { relationship: "child" as const, name: "" }], "my mom Linda and my kid")).toHaveLength(2);
    expect(mergeSamePerson([{ relationship: "self" as const, name: "Sam" }, { relationship: "self" as const, name: "" }], "me")).toHaveLength(2);
  });
});
