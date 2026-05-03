import * as functions from "firebase-functions";

/**
 * Verify a Stripe Connect account is ready to receive a payout.
 *
 * Stripe will reject `payouts.create` if the account has outstanding KYC
 * requirements, but the raw error is opaque. This helper translates the
 * `account.requirements` shape into actionable HttpsError messages so the
 * caregiver UI can prompt the user to finish onboarding instead of showing
 * a generic Stripe error.
 */
export function assertPayoutsReady(account: any): void {
    if (!account.charges_enabled || !account.payouts_enabled) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "Account not fully onboarded. Please complete your Stripe Connect setup.",
        );
    }

    const disabled = account.requirements?.disabled_reason;
    if (disabled) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            `Stripe disabled payouts: ${disabled}. Please update your account info.`,
        );
    }

    const pastDue: string[] = account.requirements?.past_due ?? [];
    const currentlyDue: string[] = account.requirements?.currently_due ?? [];
    if (pastDue.length > 0 || currentlyDue.length > 0) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "Your Stripe account needs additional information before you can receive payouts. Please complete verification.",
        );
    }
}
