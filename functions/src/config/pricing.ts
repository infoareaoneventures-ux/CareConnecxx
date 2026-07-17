// Display pricing — the single source of truth for every user-facing price
// string (prompts, nudges, tool detail strings, fallback copy). Charging is
// NOT here: Stripe price IDs and charge amounts live in stripe.ts / env config
// and must never be derived from these display strings. Keep the two in sync
// by changing THIS file whenever a Stripe price changes; no other copy site
// should ever hand-type a dollar amount.
//
// Shaped like mvrConfig.ts / config/serviceArea.ts: plain exported accessors,
// no side effects, no I/O. (R7, hallucination audit 2026-07-17 — seven
// hand-typed price literals had drifted into prompts.)

// One constant per price — every display variant derives from these.
const CLIENT_MONTHLY = "$29.95";
const CAREGIVER_ANNUAL = "$54.99";
const MVR_ONE_TIME = "$11.50";

/** Family membership, bare amount — "$29.95". */
export function clientMonthlyAmount(): string {
  return CLIENT_MONTHLY;
}

/** Family membership with period — "$29.95/month". */
export function clientMonthlyDisplay(): string {
  return `${CLIENT_MONTHLY}/month`;
}

/** Caregiver membership, bare amount — "$54.99". */
export function caregiverAnnualAmount(): string {
  return CAREGIVER_ANNUAL;
}

/** Caregiver membership with period — "$54.99/year". */
export function caregiverAnnualDisplay(): string {
  return `${CAREGIVER_ANNUAL}/year`;
}

/** Optional MVR (Approved Driver) add-on, one-time — "$11.50". */
export function mvrDisplay(): string {
  return MVR_ONE_TIME;
}
