import { describe, expect, it } from "vitest";
import { resolveShiftBillableAmount, shiftEndFromHours } from "./shiftBillingAmounts";

describe("resolveShiftBillableAmount", () => {
  it("returns one canonical cents and dollars calculation for a legal correction", () => {
    // requiresExplicitApproval is true here because a line item is present
    // (mileage) — not the dollar threshold. Any line item, however small,
    // forces explicit approval (Hamse, 2026-08-23) so the auto-approve/
    // auto-accept safety nets never silently resolve an uncapped,
    // caregiver-declared amount.
    expect(resolveShiftBillableAmount({
      startTime: "2026-07-13T09:00:00.000Z",
      endTime: "2026-07-13T15:00:00.000Z",
      bookedRateDollars: 30,
      lineItems: [{ type: "mileage", amount: 12.345 }],
    })).toMatchObject({
      totalHours: 6,
      basePayCents: 18000,
      lineItemsTotalCents: 1235,
      grossPayCents: 19235,
      basePay: 180,
      lineItemsTotal: 12.35,
      grossPay: 192.35,
      requiresExplicitApproval: true,
    });
  });

  it("rejects an over-24-hour correction before any document can be written", () => {
    expect(() => resolveShiftBillableAmount({
      startTime: "2026-07-01T09:00:00.000Z",
      endTime: "2026-07-22T05:00:00.000Z",
      bookedRateDollars: 30,
      lineItems: [],
    })).toThrow("cannot exceed 24 hours");
  });

  it("marks a large-but-legal correction for explicit approval", () => {
    expect(resolveShiftBillableAmount({
      startTime: "2026-07-13T09:00:00.000Z",
      endTime: "2026-07-13T19:00:00.000Z",
      bookedRateDollars: 60,
      lineItems: [],
    }).requiresExplicitApproval).toBe(true);
  });
});

describe("shiftEndFromHours", () => {
  it("derives a correction end time from the submitted start and corrected hours", () => {
    expect(shiftEndFromHours("2026-07-13T09:00:00.000Z", 4)).toBe(
      "2026-07-13T13:00:00.000Z",
    );
  });

  it("rejects missing starts and invalid hour values", () => {
    expect(() => shiftEndFromHours("", 4)).toThrow("valid submitted start time");
    expect(() => shiftEndFromHours("2026-07-13T09:00:00.000Z", 0)).toThrow(
      "positive corrected hours",
    );
  });
});
