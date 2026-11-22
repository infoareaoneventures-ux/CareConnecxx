import { describe, it, expect } from "vitest";
import { samePhone } from "./samePhone";

describe("samePhone", () => {
  it("matches the same line in different formats", () => {
    expect(samePhone("+15055281528", "(505) 528-1528")).toBe(true);
    expect(samePhone("505-528-1528", "+1 505 528 1528")).toBe(true);
  });
  it("does not match different numbers, or anything incomplete", () => {
    expect(samePhone("+15055281528", "+15054416156")).toBe(false);
    expect(samePhone("1528", "1528")).toBe(false);
    expect(samePhone(undefined, "+15055281528")).toBe(false);
  });
});
