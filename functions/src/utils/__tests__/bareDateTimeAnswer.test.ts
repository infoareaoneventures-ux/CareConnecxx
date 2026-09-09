import { describe, it, expect } from "vitest";
import { isBareDateOrTimeAnswer } from "../bareDateTimeAnswer";

describe("isBareDateOrTimeAnswer", () => {
  it("matches the exact live-caught failures (2026-09-09)", () => {
    expect(isBareDateOrTimeAnswer("9/11")).toBe(true);
    expect(isBareDateOrTimeAnswer("9/12")).toBe(true);
    expect(isBareDateOrTimeAnswer("12pm")).toBe(true);
  });

  it("matches other bare date shapes", () => {
    expect(isBareDateOrTimeAnswer("9/12/26")).toBe(true);
    expect(isBareDateOrTimeAnswer("09/12/2026")).toBe(true);
  });

  it("matches other bare time shapes", () => {
    expect(isBareDateOrTimeAnswer("11am")).toBe(true);
    expect(isBareDateOrTimeAnswer("11 am")).toBe(true);
    expect(isBareDateOrTimeAnswer("11:00am")).toBe(true);
    expect(isBareDateOrTimeAnswer("11:00 AM")).toBe(true);
    expect(isBareDateOrTimeAnswer("1pm")).toBe(true);
    expect(isBareDateOrTimeAnswer("12:30pm")).toBe(true);
    expect(isBareDateOrTimeAnswer("noon")).toBe(true);
    expect(isBareDateOrTimeAnswer("midnight")).toBe(true);
    expect(isBareDateOrTimeAnswer("NOON")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isBareDateOrTimeAnswer("  9/12  ")).toBe(true);
    expect(isBareDateOrTimeAnswer(" 12pm ")).toBe(true);
  });

  it("does not match a real fact correction", () => {
    expect(isBareDateOrTimeAnswer("actually mom is 82 not 78")).toBe(false);
    expect(isBareDateOrTimeAnswer("I meant Tuesday not Monday")).toBe(false);
    expect(isBareDateOrTimeAnswer("wait, her doctor is Dr. Chen not Dr. Lee")).toBe(false);
  });

  it("does not match a date/time with extra words attached", () => {
    expect(isBareDateOrTimeAnswer("9/12 works for me")).toBe(false);
    expect(isBareDateOrTimeAnswer("let's do 12pm")).toBe(false);
    expect(isBareDateOrTimeAnswer("September 12")).toBe(false);
  });

  it("returns false for empty or whitespace-only text", () => {
    expect(isBareDateOrTimeAnswer("")).toBe(false);
    expect(isBareDateOrTimeAnswer("   ")).toBe(false);
  });
});
