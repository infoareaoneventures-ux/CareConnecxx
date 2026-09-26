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
// Flat annual membership (founder decision 2026-09-25): covers the required
// Checkr background check AND, when Transportation is offered, the MVR check
// bundled in — see CLAUDE.md. Replaces the old $54.99 base + $11.50 MVR
// add-on, which is retired (no more separate "Become an Approved Driver"
// checkout, so there is no separate MVR display string either).
const CAREGIVER_ANNUAL = "$69.99";

/** Family membership, bare amount — "$29.95". */
export function clientMonthlyAmount(): string {
  return CLIENT_MONTHLY;
}

/** Family membership with period — "$29.95/month". */
export function clientMonthlyDisplay(): string {
  return `${CLIENT_MONTHLY}/month`;
}

/** Caregiver membership, bare amount — "$69.99". */
export function caregiverAnnualAmount(): string {
  return CAREGIVER_ANNUAL;
}

/** Caregiver membership with period — "$69.99/year". */
export function caregiverAnnualDisplay(): string {
  return `${CAREGIVER_ANNUAL}/year`;
}
