import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getCaregiverPayoutFields } from "./caregiverPrivate";
import { ensureConnectAccount, syncConnectAccountStatus, createConnectOnboardingLink } from "./connectAccount";
const Stripe = require("stripe");

if (!admin.apps.length) {
    admin.initializeApp();
}

const stripe = new Stripe(functions.config().stripe?.secret || process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();

const appUrl = (): string => {
    const url = functions.config().app?.url || process.env.APP_URL;
    if (!url) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "APP_URL is not configured for Stripe Connect redirects",
        );
    }
    return url.replace(/\/+$/, "");
};

const buildAccountLink = async (accountId: string) => {
    const base = appUrl();
    // Shared with Evia's Setup links and the Manage-in-Stripe fallback (connectAccount.ts).
    const url = await createConnectOnboardingLink(stripe, accountId, {
        returnUrl: `${base}/caregiver/payments?tab=payouts&stripe=success`,
        refreshUrl: `${base}/caregiver/payments?tab=payouts&stripe=refresh`,
    });
    return { url };
};

// Verify the caller is allowed to act on `accountId`: either it is the Stripe
// account on their own caregiver doc, or they are an admin (mirrors
// firestore.rules isAdmin()). Without this, any authenticated user could pass
// another caregiver's stripeAccountId — readable from the world-readable
// caregivers/{id} docs — and mint a live account-onboarding link for it,
// letting them edit that caregiver's payout bank account (account takeover).
const assertCanAccessAccount = async (
    context: functions.https.CallableContext,
    accountId: string,
): Promise<void> => {
    const uid = context.auth!.uid;
    const payout = await getCaregiverPayoutFields(uid);
    if (payout.stripeAccountId === accountId) return;

    const userSnap = await db.collection("users").doc(uid).get();
    const u = userSnap.exists ? userSnap.data() ?? {} : {};
    if (u.userType === "admin" || u.isAdmin === true) return;

    throw new functions.https.HttpsError(
        "permission-denied",
        "You do not have access to this Stripe account.",
    );
};

// Resolve the account to act on: an explicit accountId (ownership-checked) or,
// when omitted, the CALLER's own account — so the webapp never needs to read
// stripeAccountId client-side at all (it moved off the world-readable parent
// doc to caregivers/{id}/private/payout).
const resolveAccountForCaller = async (
    context: functions.https.CallableContext,
    requested: string | undefined,
): Promise<string> => {
    if (requested) {
        await assertCanAccessAccount(context, requested);
        return requested;
    }
    const payout = await getCaregiverPayoutFields(context.auth!.uid);
    const own = payout.stripeAccountId as string | undefined;
    if (!own) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "No Stripe account on file — start payout setup first.",
        );
    }
    return own;
};

// Shared with the Manage-in-Stripe fallback and Evia (connectAccount.ts): Stripe's
// own answer, written onto the record (parent + private/payout).
const syncAccountStatus = async (accountId: string) => syncConnectAccountStatus(stripe, accountId);

export const createStripeConnectAccount = functions
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
        }

        const uid = context.auth.uid;
        const email: string | undefined = data?.email || context.auth.token.email;

        // ONE find-or-create path, shared with every link Evia texts
        // (connectAccount.ts): the record is the only source of the account id.
        const caregiverSnap = await db.collection("caregivers").doc(uid).get();
        const { accountId } = await ensureConnectAccount(stripe, uid, { email, parentData: caregiverSnap.data() ?? null });

        const link = await buildAccountLink(accountId);
        return { accountId, onboardingUrl: link.url, onboardingComplete: false };
    });

export const getStripeOnboardingLink = functions
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
        }

        // accountId optional: omitted → the caller's own account (resolved
        // server-side from private/payout); provided → ownership-checked.
        const accountId = await resolveAccountForCaller(context, data?.accountId);

        const link = await buildAccountLink(accountId);
        return { url: link.url };
    });

export const checkStripeAccountStatus = functions
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
        }

        // accountId optional: omitted → the caller's own account (resolved
        // server-side from private/payout); provided → ownership-checked.
        const accountId = await resolveAccountForCaller(context, data?.accountId);

        return syncAccountStatus(accountId);
    });
