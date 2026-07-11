import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
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
    return stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${base}/caregiver/payout?stripe=refresh`,
        return_url: `${base}/caregiver/payout?stripe=success`,
        type: "account_onboarding",
    });
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
    const cgSnap = await db.collection("caregivers").doc(uid).get();
    if (cgSnap.exists && cgSnap.data()?.stripeAccountId === accountId) return;

    const userSnap = await db.collection("users").doc(uid).get();
    const u = userSnap.exists ? userSnap.data() ?? {} : {};
    if (u.userType === "admin" || u.isAdmin === true) return;

    throw new functions.https.HttpsError(
        "permission-denied",
        "You do not have access to this Stripe account.",
    );
};

const syncAccountStatus = async (accountId: string) => {
    const account = await stripe.accounts.retrieve(accountId);
    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    const detailsSubmitted = !!account.details_submitted;
    const complete = chargesEnabled && payoutsEnabled;

    const snap = await db.collection("caregivers")
        .where("stripeAccountId", "==", accountId)
        .limit(1)
        .get();

    if (!snap.empty) {
        const update: Record<string, unknown> = {
            chargesEnabled,
            payoutsEnabled,
            detailsSubmitted,
            stripeOnboardingComplete: complete,
        };
        if (complete) {
            update.stripeOnboardingCompletedAt = admin.firestore.FieldValue.serverTimestamp();
        }
        await snap.docs[0].ref.update(update);
    }

    return { chargesEnabled, payoutsEnabled, detailsSubmitted, stripeOnboardingComplete: complete };
};

export const createStripeConnectAccount = functions
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
        }

        const uid = context.auth.uid;
        const email: string | undefined = data?.email || context.auth.token.email;

        const caregiverRef = db.collection("caregivers").doc(uid);
        const caregiverSnap = await caregiverRef.get();
        const existing = caregiverSnap.data()?.stripeAccountId as string | undefined;

        if (existing) {
            const link = await buildAccountLink(existing);
            return { accountId: existing, onboardingUrl: link.url, onboardingComplete: false };
        }

        const account = await stripe.accounts.create({
            type: "express",
            country: "US",
            email,
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
            },
            business_type: "individual",
            metadata: { caregiverId: uid, platform: "careconnex" },
        });

        await caregiverRef.set({
            stripeAccountId: account.id,
            stripeOnboardingComplete: false,
            payoutsEnabled: false,
            chargesEnabled: false,
            detailsSubmitted: false,
            stripeAccountCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        const link = await buildAccountLink(account.id);
        return { accountId: account.id, onboardingUrl: link.url, onboardingComplete: false };
    });

export const getStripeOnboardingLink = functions
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
        }

        const accountId: string | undefined = data?.accountId;
        if (!accountId) {
            throw new functions.https.HttpsError("invalid-argument", "accountId is required");
        }
        await assertCanAccessAccount(context, accountId);

        const link = await buildAccountLink(accountId);
        return { url: link.url };
    });

export const checkStripeAccountStatus = functions
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
        }

        const accountId: string | undefined = data?.accountId;
        if (!accountId) {
            throw new functions.https.HttpsError("invalid-argument", "accountId is required");
        }
        await assertCanAccessAccount(context, accountId);

        return syncAccountStatus(accountId);
    });
