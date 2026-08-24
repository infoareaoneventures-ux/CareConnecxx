import {
  EXPLICIT_APPROVAL_THRESHOLD_CENTS,
  MAX_BILLABLE_AMOUNT_CENTS,
  MAX_BILLABLE_HOURS_PER_VISIT,
} from "./config";

export class ShiftBillingPolicyError extends Error {
  constructor(
    public readonly code: "invalid_interval" | "visit_too_long" | "invalid_rate" | "amount_too_high",
    message: string,
  ) {
    super(message);
    this.name = "ShiftBillingPolicyError";
  }
}

export interface ShiftBillingPolicyResult {
  totalMinutes: number;
  totalHours: number;
  basePayCents: number;
  lineItemsTotalCents: number;
  grossPayCents: number;
  requiresExplicitApproval: boolean;
}

export function evaluateShiftBillingPolicy(input: {
  startTime: string;
  endTime: string;
  bookedRateDollars: number;
  approvedLineItemsTotalCents?: number;
}): ShiftBillingPolicyResult {
  const start = new Date(input.startTime).getTime();
  const end = new Date(input.endTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new ShiftBillingPolicyError("invalid_interval", "End time must be after start time");
  }

  const elapsedMinutes = (end - start) / 60_000;
  if (elapsedMinutes > MAX_BILLABLE_HOURS_PER_VISIT * 60) {
    throw new ShiftBillingPolicyError("visit_too_long", `A visit cannot exceed ${MAX_BILLABLE_HOURS_PER_VISIT} hours`);
  }
  if (!Number.isFinite(input.bookedRateDollars) || input.bookedRateDollars <= 0) {
    throw new ShiftBillingPolicyError("invalid_rate", "The appointment has no valid booked rate");
  }

  const totalMinutes = Math.round(elapsedMinutes * 1_000_000) / 1_000_000;
  const totalHours = totalMinutes / 60;
  const basePayCents = Math.round(totalHours * input.bookedRateDollars * 100);
  const lineItemsTotalCents = Math.max(0, Math.round(input.approvedLineItemsTotalCents ?? 0));
  const grossPayCents = basePayCents + lineItemsTotalCents;
  if (grossPayCents > MAX_BILLABLE_AMOUNT_CENTS) {
    throw new ShiftBillingPolicyError("amount_too_high", `A visit cannot exceed $${(MAX_BILLABLE_AMOUNT_CENTS / 100).toFixed(2)}`);
  }

  return {
    totalMinutes,
    totalHours,
    basePayCents,
    lineItemsTotalCents,
    grossPayCents,
    // A line item (mileage, supplies, a custom fee) is an uncapped,
    // caregiver-declared amount — unlike the base hours, which are bounded by
    // the scheduled shift. Requiring explicit approval whenever one is present
    // (not just past the dollar threshold) keeps the 24h auto-approve/
    // auto-accept safety nets from ever silently charging an unreviewed extra
    // charge (Hamse, 2026-08-23).
    requiresExplicitApproval: grossPayCents > EXPLICIT_APPROVAL_THRESHOLD_CENTS || lineItemsTotalCents > 0,
  };
}
