import { describe, it, expect } from "vitest";
import { coerceToolInput } from "../coerceToolInput";

const schema = {
  properties: {
    contact: { type: "object", properties: { name: { type: "string" }, age: { type: "number" } } },
    tags: { type: "array", items: { type: "string" } },
    count: { type: "number" },
    code: { type: "string" },
    on: { type: "boolean" },
    value: {}, // a union with no declared type
  },
};

describe("coerceToolInput", () => {
  it("unwraps a one-item list where an object is declared (the founders' emergency contact)", () => {
    expect(coerceToolInput({ contact: [{ name: "Hamse Mo", age: "40" }] }, schema)).toEqual({ contact: { name: "Hamse Mo", age: 40 } });
  });
  it("wraps a single object or value where a list is declared", () => {
    expect(coerceToolInput({ tags: "a" }, schema).tags).toEqual("a"); // a bare string is left to the handler
    expect(coerceToolInput({ tags: { x: 1 } }, schema).tags).toEqual([{ x: 1 }]);
  });
  it("fixes number and boolean slips by their declared type", () => {
    expect(coerceToolInput({ count: "3", code: 42, on: "true" }, schema)).toEqual({ count: 3, code: "42", on: true });
    expect(coerceToolInput({ on: "FALSE" }, schema).on).toBe(false);
  });
  it("leaves untyped properties, unknown keys and values that do not fit as they are", () => {
    const input = { value: [{ a: 1 }], extra: [1, 2], count: "many", contact: [{ a: 1 }, { b: 2 }] };
    expect(coerceToolInput(input, schema)).toEqual(input);
  });
  it("returns the input untouched when there is no schema", () => {
    const input = { a: [1] };
    expect(coerceToolInput(input, undefined)).toBe(input);
  });
});
