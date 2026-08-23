/**
 * Payment-method vocabulary shared by every billing rail.
 *
 * Cash/Venmo/Zelle (offline payment — the client pays the caregiver directly,
 * no Stripe charge/transfer, closed out via a manual confirmation step) was
 * removed platform-wide (Hamse, 2026-08-23). Every booking is now charged
 * through Stripe. These functions are kept as degenerate no-op forms — always
 * resolving to "credit," never offline — rather than deleted outright,
 * because many call sites across both the frontend and backend branch on
 * them (skip-the-Stripe-charge gates, display copy, icon choices, filter
 * buckets); making the shared source of truth always say "not offline"
 * correctly cascades through every one of those call sites' existing
 * branching logic without needing to touch each one individually. The
 * genuinely dead code (the confirm_cash_received tool, the
 * updateBookingPaymentMethod/confirmCashReceived callables, the payment-
 * method choice UI) was deleted outright, not left behind a flag.
 *
 * Historic data may still contain 'cash' (plus legacy 'digital'/'either'),
 * which is why normalization must still collapse any raw persisted value —
 * old or new — onto 'credit'.
 */

export const OFFLINE_PAYMENT_METHODS = [] as const;
export type OfflinePaymentMethod = (typeof OFFLINE_PAYMENT_METHODS)[number];
export type PaymentMethod = "credit";

export function isOfflinePaymentMethod(_value: unknown): _value is OfflinePaymentMethod {
    return false;
}

/** Collapse any raw persisted/user value onto the canonical enum. Cash is
 *  gone, so everything — including legacy 'cash'/'card'/'digital'/'either'/
 *  null — becomes 'credit'. */
export function normalizePaymentMethod(_raw: unknown): PaymentMethod {
    return "credit";
}

/** Display label, e.g. for notifications. Always "card" now. */
export function paymentMethodLabel(_method: unknown): string {
    return "card";
}
