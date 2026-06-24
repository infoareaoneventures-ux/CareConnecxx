import { describe, it, expect } from "vitest";
import {
  evaluateWeeklyFamilyBudget,
  isoWeekStart,
  WEEKLY_FAMILY_PROACTIVE_BUDGET,
} from "../proactiveBudget";

// 2026-06-23 is a Tuesday → week start Monday 2026-06-22.
const TUE = "2026-06-23T13:00:00.000Z";
const WEEK = "2026-06-22";

describe("proactive weekly family budget (KTD-14)", () => {
  it("computes a Monday-based week start", () => {
    expect(isoWeekStart(TUE)).toBe(WEEK);
    expect(isoWeekStart("2026-06-22T00:00:00.000Z")).toBe(WEEK); // Monday itself
    expect(isoWeekStart("2026-06-28T23:00:00.000Z")).toBe(WEEK); // Sunday end of week
  });

  it("allows the first send of the week for any campaign", () => {
    const r = evaluateWeeklyFamilyBudget(undefined, "payment_reminder", TUE);
    expect(r.allowed).toBe(true);
    expect(r.next).toEqual({ weekStart: WEEK, count: 1 });
  });

  it("drops the lowest-priority campaign first as the week fills", () => {
    // After 1 send this week, payment_reminder (ceiling 1) is blocked...
    const atOne = { weekStart: WEEK, count: 1 };
    expect(evaluateWeeklyFamilyBudget(atOne, "payment_reminder", TUE).allowed).toBe(false);
    // ...but next_day_feedback (ceiling budget-1=3) still gets through.
    expect(evaluateWeeklyFamilyBudget(atOne, "next_day_feedback", TUE).allowed).toBe(true);
  });

  it("blocks a campaign once its priority ceiling is reached without advancing the count", () => {
    const atCeiling = { weekStart: WEEK, count: WEEKLY_FAMILY_PROACTIVE_BUDGET };
    const r = evaluateWeeklyFamilyBudget(atCeiling, "operational", TUE);
    expect(r.allowed).toBe(false);
    expect(r.next.count).toBe(WEEKLY_FAMILY_PROACTIVE_BUDGET); // not incremented when blocked
  });

  it("resets when the stored tally is from a previous week", () => {
    const lastWeek = { weekStart: "2026-06-15", count: WEEKLY_FAMILY_PROACTIVE_BUDGET };
    const r = evaluateWeeklyFamilyBudget(lastWeek, "satisfaction_checkin", TUE);
    expect(r.allowed).toBe(true);
    expect(r.next).toEqual({ weekStart: WEEK, count: 1 });
  });
});
