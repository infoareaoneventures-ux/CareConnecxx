// Site-side mirror of the money constants in functions/src/billing/config.ts.
// The backend is the source of truth for what is CHARGED (integer cents,
// rounded once, minimum applied once — serviceFeeCentsFor in
// functions/src/billing/shiftBillingAmounts.ts). The site only ESTIMATES with
// these before approval (booking modal, caregiver profile) and labels the
// result on the Timesheets card; a functions test (serviceFee.test.ts) asserts
// these values equal the backend's so the two can never drift.
//
// Founder decision 2026-09-19: 9% service fee on each visit, $1 minimum, paid
// by the family on top of the caregiver's rate; caregivers keep 100% of their
// rate. Standard daily payouts are free to caregivers; the optional instant
// payout carries Stripe's fee (1%, $0.50 minimum), passed to the caregiver.

export const SERVICE_FEE_RATE = 0.09;
export const SERVICE_FEE_MIN_CENTS = 100;
export const SERVICE_FEE_PERCENT_LABEL = '9%';

export const INSTANT_PAYOUT_FEE_RATE = 0.01;
export const INSTANT_PAYOUT_FEE_MIN_CENTS = 50;
export const INSTANT_PAYOUT_FEE_LABEL = "Stripe's 1% instant fee (min $0.50)";

/** Fee in cents for a visit whose caregiver total is `grossCents` (0 → 0). Same arithmetic as the backend. */
export function serviceFeeCents(grossCents: number): number {
  const g = Math.max(0, Math.round(Number(grossCents) || 0));
  if (g === 0) return 0;
  return Math.max(Math.round(g * SERVICE_FEE_RATE), SERVICE_FEE_MIN_CENTS);
}

/** Dollar helpers for display. */
export function serviceFeeDollars(grossDollars: number): number {
  return serviceFeeCents(Math.round((Number(grossDollars) || 0) * 100)) / 100;
}
export function totalChargedDollars(grossDollars: number): number {
  const g = Math.round((Number(grossDollars) || 0) * 100);
  return (g + serviceFeeCents(g)) / 100;
}
/** "$27.25" for a $25/hr caregiver rate — the per-hour figure billed to the family (no minimum applies per hour). */
export function billedHourlyRate(rate: number): number {
  return Math.round((Number(rate) || 0) * (1 + SERVICE_FEE_RATE) * 100) / 100;
}

/** Instant payout fee in cents on `amountCents` (0 → 0). Same arithmetic as the backend. */
export function instantPayoutFeeCents(amountCents: number): number {
  const a = Math.max(0, Math.round(Number(amountCents) || 0));
  if (a === 0) return 0;
  return Math.max(Math.round(a * INSTANT_PAYOUT_FEE_RATE), INSTANT_PAYOUT_FEE_MIN_CENTS);
}
export function instantPayoutFeeDollars(amountDollars: number): number {
  return instantPayoutFeeCents(Math.round((Number(amountDollars) || 0) * 100)) / 100;
}

export const fmtMoney = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;
