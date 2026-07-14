/**
 * Payment-method vocabulary shared by every billing rail (2026-07-06).
 *
 * Clients choose per booking/job how the caregiver is paid:
 *  - "credit"  — charged through Stripe; grossPay transfers to the caregiver's
 *                Connect balance and auto-pays out on Stripe's daily schedule.
 *  - OFFLINE ("cash" | "venmo" | "zelle") — the client pays the caregiver
 *                directly. No Stripe charge or transfer fires; the shift is
 *                closed out when the caregiver confirms receipt
 *                (confirmCashReceived callable / confirm_cash_received tool).
 *
 * Historic data only contains 'cash' | 'credit' (plus legacy 'digital' |
 * 'either' collapsed to 'credit' by migratePaymentMethods), so normalization
 * must default every unknown value to 'credit' — the charging rail — never to
 * an offline method.
 */

export const OFFLINE_PAYMENT_METHODS = ["cash", "venmo", "zelle"] as const;
export type OfflinePaymentMethod = (typeof OFFLINE_PAYMENT_METHODS)[number];
export type PaymentMethod = OfflinePaymentMethod | "credit";

export function isOfflinePaymentMethod(value: unknown): value is OfflinePaymentMethod {
    return typeof value === "string" &&
        (OFFLINE_PAYMENT_METHODS as readonly string[]).includes(value.toLowerCase().trim());
}

/** Collapse any raw persisted/user value onto the canonical enum. Unknowns
 *  (including legacy 'card'/'digital'/'either'/null) become 'credit'. */
export function normalizePaymentMethod(raw: unknown): PaymentMethod {
    if (typeof raw !== "string") return "credit";
    const v = raw.toLowerCase().trim();
    return isOfflinePaymentMethod(v) ? (v as OfflinePaymentMethod) : "credit";
}

/** Display label, e.g. for notifications: "cash" → "cash", "venmo" → "Venmo". */
export function paymentMethodLabel(method: unknown): string {
    const m = normalizePaymentMethod(method);
    switch (m) {
        case "venmo": return "Venmo";
        case "zelle": return "Zelle";
        case "cash": return "cash";
        default: return "card";
    }
}
