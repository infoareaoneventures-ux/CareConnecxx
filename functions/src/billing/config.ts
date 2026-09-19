/**
 * Single source of truth for money-movement fee/rate constants.
 *
 * These values were previously duplicated as magic numbers across shiftHours.ts
 * and instantPayout.ts. Centralizing them keeps the rate one edit away and makes
 * every charge/payout path explainable. Do NOT change these amounts without a
 * deliberate pricing decision — they directly affect what clients are charged
 * and what caregivers receive.
 *
 * Note: invoicing.ts uses a separate, env-driven invoice tax/fee
 * (INVOICE_TAX_RATE / INVOICE_PLATFORM_FEE_RATE) which is a distinct fee from
 * the per-shift platform fee and the instant-payout processing fee below.
 */

/**
 * Platform fee added on top of a shift's gross pay when the client is charged
 * (processShiftPayment): max(gross * RATE, MIN). 9%, $1 minimum — the
 * "service fee" (founder decision 2026-09-19; was 1.5% / $0.50). Paid by the
 * family on top of the caregiver's rate; the caregiver's transfer is the gross.
 * Mirrored on the site in utils/pricing.ts (serviceFee.test.ts keeps them equal).
 */
export const SHIFT_PLATFORM_FEE_RATE = 0.09;
export const SHIFT_PLATFORM_FEE_MIN_DOLLARS = 1;

// Launch billing policy. Amounts use integer cents at trust boundaries; the
// existing shiftHours document keeps dollar mirrors until its readers migrate.
export const BILLING_CURRENCY = "usd" as const;
export const MAX_BILLABLE_HOURS_PER_VISIT = 24;
export const MAX_BILLABLE_AMOUNT_CENTS = 250_000;
export const EXPLICIT_APPROVAL_THRESHOLD_CENTS = 50_000;
export const MANUAL_REVIEW_REMINDER_HOURS = [24, 48] as const;
export const MANUAL_REVIEW_TIMEOUT_HOURS = 72;
export const CAREGIVER_PROFILE_RATE_MIN_DOLLARS = 15;
export const CAREGIVER_PROFILE_RATE_MAX_DOLLARS = 150;

/**
 * Instant payouts (founder decision 2026-09-19, reversing 2026-07-06): Stripe's
 * instant-payout fee — 1%, $0.50 minimum — is passed to the caregiver. The
 * payout is created for amount − fee and the fee is recouped from the connected
 * account by an account-debit transfer to the platform (payoutCommon.ts), so
 * nothing sweeps back to the caregiver. Standard daily payouts stay free.
 */
export const INSTANT_PAYOUT_FEE_RATE = 0.01;
export const INSTANT_PAYOUT_FEE_MIN_DOLLARS = 0.5;
