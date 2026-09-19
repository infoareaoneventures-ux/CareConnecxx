import { evaluateShiftBillingPolicy } from "./shiftBillingPolicy";
import {
  SHIFT_PLATFORM_FEE_RATE, SHIFT_PLATFORM_FEE_MIN_DOLLARS, INSTANT_PAYOUT_FEE_RATE, INSTANT_PAYOUT_FEE_MIN_DOLLARS,
} from "./config";

/**
 * The family's service fee on a visit, in integer cents: max(gross × 9%, $1),
 * rounded once; a $0 visit carries no fee. This is THE fee calculation — the
 * charge, every stored amount, the approval text, the Timesheets card and
 * Evia's reads all go through it (the site mirrors it in utils/pricing.ts).
 */
export function serviceFeeCentsFor(grossCents: number): number {
  const g = Math.max(0, Math.round(Number(grossCents) || 0));
  if (g === 0) return 0;
  return Math.max(Math.round(g * SHIFT_PLATFORM_FEE_RATE), Math.round(SHIFT_PLATFORM_FEE_MIN_DOLLARS * 100));
}
export function totalChargeCentsFor(grossCents: number): number {
  const g = Math.max(0, Math.round(Number(grossCents) || 0));
  return g + serviceFeeCentsFor(g);
}

/** Stripe's instant-payout fee passed to the caregiver: max(amount × 1%, $0.50); $0 → 0. */
export function instantPayoutFeeCentsFor(amountCents: number): number {
  const a = Math.max(0, Math.round(Number(amountCents) || 0));
  if (a === 0) return 0;
  return Math.max(Math.round(a * INSTANT_PAYOUT_FEE_RATE), Math.round(INSTANT_PAYOUT_FEE_MIN_DOLLARS * 100));
}

const VALID_LINE_ITEM_TYPES = ["overtime", "mileage", "supplies", "bonus", "custom"];

export interface ShiftLineItem {
  type: string;
  label: string;
  note: string;
  amount: number;
}

export function sanitizeShiftLineItems(raw: unknown): ShiftLineItem[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((lineItem: unknown) => lineItem && typeof lineItem === "object")
    .map((lineItem: any) => ({
      type: VALID_LINE_ITEM_TYPES.includes(lineItem.type) ? lineItem.type : "custom",
      label: typeof lineItem.label === "string" ? lineItem.label.slice(0, 100) : "",
      note: typeof lineItem.note === "string" ? lineItem.note.slice(0, 500) : "",
      amount: Math.max(0, Math.round((Number(lineItem.amount) || 0) * 100) / 100),
    }))
    .filter((lineItem) => lineItem.amount > 0);
}

export function resolveShiftBillableAmount(input: {
  startTime: string;
  endTime: string;
  bookedRateDollars: number;
  lineItems?: unknown;
}) {
  const lineItems = sanitizeShiftLineItems(input.lineItems);
  const approvedLineItemsTotalCents = lineItems.reduce(
    (total, lineItem) => total + Math.round(lineItem.amount * 100),
    0,
  );
  const policy = evaluateShiftBillingPolicy({
    startTime: input.startTime,
    endTime: input.endTime,
    bookedRateDollars: input.bookedRateDollars,
    approvedLineItemsTotalCents,
  });

  const serviceFeeCents = serviceFeeCentsFor(policy.grossPayCents);
  const totalChargeCents = policy.grossPayCents + serviceFeeCents;
  return {
    ...policy,
    lineItems,
    basePay: policy.basePayCents / 100,
    lineItemsTotal: policy.lineItemsTotalCents / 100,
    grossPay: policy.grossPayCents / 100,
    // What the FAMILY is charged: gross + the service fee (the caregiver's transfer stays the gross).
    serviceFeeCents,
    serviceFee: serviceFeeCents / 100,
    totalChargeCents,
    totalCharge: totalChargeCents / 100,
  };
}

export function shiftEndFromHours(startTime: string, hours: number): string {
  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs)) {
    throw new Error("A valid submitted start time is required");
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("Correction requires positive corrected hours");
  }
  return new Date(startMs + hours * 60 * 60 * 1000).toISOString();
}
