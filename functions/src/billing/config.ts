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
 * (processShiftPayment): max(gross * RATE, MIN). 1.5%, $0.50 minimum.
 */
export const SHIFT_PLATFORM_FEE_RATE = 0.015;
export const SHIFT_PLATFORM_FEE_MIN_DOLLARS = 0.5;

/**
 * Instant payouts are FREE to the caregiver (pricing decision 2026-07-06):
 * the platform absorbs Stripe's instant-payout fee. Regular payouts happen
 * automatically on Stripe's daily schedule and were always free. The former
 * INSTANT_PAYOUT_FEE_RATE / INSTANT_PAYOUT_FEE_MIN_DOLLARS constants were
 * retired with that decision — reintroducing a caregiver-facing fee requires
 * real fee recoup (an account-debit transfer to the platform), not just a
 * smaller payout, because any remainder auto-sweeps back to the caregiver.
 */
