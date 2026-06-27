import { describe, it, expect } from "vitest";
import { evaluateProactiveCap, MAX_PROACTIVE_PER_DAY, type ProactiveTally } from "../proactiveCap";

// Global per-user daily ceiling on proactive nudges — the one gate that sees all
// proactive sources at once, so stacking new nudges can't quietly spam a user.

const TODAY = "2026-06-23";

describe("evaluateProactiveCap", () => {
  it("allows the first nudge of the day when there's no prior tally", () => {
    const r = evaluateProactiveCap(undefined, TODAY);
    expect(r.allowed).toBe(true);
    expect(r.next).toEqual({ date: TODAY, count: 1 });
  });

  it("counts up across the day until the cap", () => {
    let tally: ProactiveTally = { date: TODAY, count: 0 };
    for (let i = 1; i <= MAX_PROACTIVE_PER_DAY; i++) {
      const r = evaluateProactiveCap(tally, TODAY);
      expect(r.allowed).toBe(true);
      expect(r.next.count).toBe(i);
      tally = r.next;
    }
  });

  it("blocks once the cap is reached, without advancing the count", () => {
    const atCap: ProactiveTally = { date: TODAY, count: MAX_PROACTIVE_PER_DAY };
    const r = evaluateProactiveCap(atCap, TODAY);
    expect(r.allowed).toBe(false);
    expect(r.next).toEqual({ date: TODAY, count: MAX_PROACTIVE_PER_DAY });
  });

  it("resets when the stored tally is from a previous day", () => {
    const yesterday: ProactiveTally = { date: "2026-06-22", count: MAX_PROACTIVE_PER_DAY };
    const r = evaluateProactiveCap(yesterday, TODAY);
    expect(r.allowed).toBe(true);
    expect(r.next).toEqual({ date: TODAY, count: 1 });
  });

  it("honors a custom cap", () => {
    expect(evaluateProactiveCap({ date: TODAY, count: 1 }, TODAY, 1).allowed).toBe(false);
    expect(evaluateProactiveCap({ date: TODAY, count: 0 }, TODAY, 1).allowed).toBe(true);
  });
});
