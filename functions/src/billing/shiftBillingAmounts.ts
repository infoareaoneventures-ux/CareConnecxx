import { evaluateShiftBillingPolicy } from "./shiftBillingPolicy";

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

  return {
    ...policy,
    lineItems,
    basePay: policy.basePayCents / 100,
    lineItemsTotal: policy.lineItemsTotalCents / 100,
    grossPay: policy.grossPayCents / 100,
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
