import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { executeInstantPayout, InstantPayoutError, InstantPayoutErrorCode } from "./payoutCommon";

if (!admin.apps.length) {
    admin.initializeApp();
}

const HTTPS_CODE_BY_PAYOUT_ERROR: Record<InstantPayoutErrorCode, functions.https.FunctionsErrorCode> = {
    NOT_FOUND: "not-found",
    NO_ACCOUNT: "failed-precondition",
    NOT_READY: "failed-precondition",
    NO_BALANCE: "failed-precondition",
    EXCEEDS_BALANCE: "invalid-argument",
    DUPLICATE: "already-exists",
    STRIPE_ERROR: "failed-precondition",
};

/**
 * Request an instant payout of the caregiver's instantly-available Stripe
 * balance. Free to the caregiver (the platform absorbs Stripe's instant fee).
 * Regular earnings need no request at all — Stripe pays out the Connect
 * balance automatically on the daily schedule.
 *
 * All payout mechanics (eligibility, replay guard, idempotency, records,
 * notification) live in payoutCommon.executeInstantPayout, shared with the
 * Evia MCP tool and SMS flow.
 */
/**
 * Read-only: what could be instantly paid out right now, straight from Stripe.
 * The payments page uses this for the cash-out modal so the number shown is
 * the number paid — the page's shift-derived "earned" figure can differ while
 * charges/transfers are still settling.
 */
export const getPayoutBalance = functions.https.onCall(async (_data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }
    const { getStripeClient } = await import("./stripe");
    const { getCaregiverPayoutFields } = await import("./caregiverPrivate");
    const payoutFields = await getCaregiverPayoutFields(context.auth.uid);
    const stripeAccountId = payoutFields.stripeAccountId as string | undefined;
    if (!stripeAccountId) {
        return { connected: false, instantAvailable: 0, pending: 0 };
    }
    const balance = await getStripeClient().balance.retrieve({ stripeAccount: stripeAccountId });
    const usd = (rows?: Array<{ amount: number; currency: string }>) =>
        (rows ?? []).find((b) => b.currency === 'usd')?.amount ?? 0;
    return {
        connected: true,
        instantAvailable: usd((balance as any).instant_available) / 100,
        pending: usd(balance.pending as any) / 100,
    };
});

export const requestInstantPayout = functions.https.onCall(async (_data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }

    try {
        const result = await executeInstantPayout({
            caregiverId: context.auth.uid,
            source: "app",
        });
        return {
            success: true,
            amount: result.amountCents / 100,
            gross: result.grossCents / 100,
            fee: result.feeCents / 100,
            payoutId: result.stripePayoutId,
            arrivalDate: result.arrivalDate,
            message: `Instant payout initiated — $${(result.amountCents / 100).toFixed(2)} after Stripe's $${(result.feeCents / 100).toFixed(2)} instant fee; funds arrive within about 30 minutes.`,
        };
    } catch (error: any) {
        if (error instanceof InstantPayoutError) {
            throw new functions.https.HttpsError(HTTPS_CODE_BY_PAYOUT_ERROR[error.code], error.message);
        }
        if (process.env.NODE_ENV !== 'production') {
            console.error('Instant payout error:', error);
        }
        throw new functions.https.HttpsError('internal', error.message || 'Payout failed');
    }
});
