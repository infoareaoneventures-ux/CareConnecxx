import { describe, expect, it } from "vitest";
import { evaluateShiftBillingPolicy, ShiftBillingPolicyError } from "./shiftBillingPolicy";

describe("evaluateShiftBillingPolicy", () => {
  it("uses exact elapsed minutes and rounds money once", () => {
    expect(evaluateShiftBillingPolicy({
      startTime: "2026-07-12T09:00:00.000Z",
      endTime: "2026-07-12T10:30:00.000Z",
      bookedRateDollars: 33.33,
    })).toMatchObject({ totalMinutes: 90, totalHours: 1.5, basePayCents: 5000, grossPayCents: 5000 });
  });

  it("allows a valid overnight interval", () => {
    expect(evaluateShiftBillingPolicy({
      startTime: "2026-07-12T22:00:00.000Z",
      endTime: "2026-07-13T06:00:00.000Z",
      bookedRateDollars: 30,
    }).totalHours).toBe(8);
  });

  it("rejects invalid and longer-than-24-hour intervals", () => {
    expect(() => evaluateShiftBillingPolicy({
      startTime: "2026-07-12T10:00:00.000Z",
      endTime: "2026-07-12T09:00:00.000Z",
      bookedRateDollars: 30,
    })).toThrowError(ShiftBillingPolicyError);
    expect(() => evaluateShiftBillingPolicy({
      startTime: "2026-07-12T09:00:00.000Z",
      endTime: "2026-07-13T09:00:01.000Z",
      bookedRateDollars: 30,
    })).toThrow("cannot exceed 24 hours");
  });

  it("requires explicit approval above $500 and rejects totals above $2,500", () => {
    expect(evaluateShiftBillingPolicy({
      startTime: "2026-07-12T09:00:00.000Z",
      endTime: "2026-07-12T19:00:00.000Z",
      bookedRateDollars: 60,
    }).requiresExplicitApproval).toBe(true);
    expect(() => evaluateShiftBillingPolicy({
      startTime: "2026-07-12T09:00:00.000Z",
      endTime: "2026-07-13T09:00:00.000Z",
      bookedRateDollars: 110,
    })).toThrow("cannot exceed $2500.00");
  });
});
