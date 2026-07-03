import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { claimWebhookEvent, settleWebhookEvent, STRIPE_EVENTS_COLLECTION } from "./utils/webhookLedger";
import Stripe from "stripe";

if (!admin.apps.length) {
    admin.initializeApp();
}

const stripe = new Stripe(functions.config().stripe?.secret || process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();

const connectWebhookSecret = () =>
    functions.config().stripe?.connect_webhook_secret || process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

export const stripeConnectWebhook = functions
    .https.onRequest(async (req, res) => {
        const sig = req.headers["stripe-signature"];
        if (!sig) {
            res.status(400).send("Missing stripe-signature header");
            return;
        }

        const secret = connectWebhookSecret();
        if (!secret) {
            console.error("STRIPE_CONNECT_WEBHOOK_SECRET is not configured — refusing to process webhook");
            res.status(500).send("Webhook secret not configured");
            return;
        }

        let event: any;
        try {
            event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
        } catch (err: any) {
            console.error("Connect webhook signature verification failed:", err.message);
            res.status(400).send(`Webhook Error: ${err.message}`);
            return;
        }

        try {
            // Exactly-once guard — a duplicate account.updated would otherwise
            // re-fire advanceOnboardingStep and double-advance Evia's conversation.
            // (Stripe event ids are unique across webhook endpoints, so the
            // ledger collection is shared with the subscription webhook.)
            if (await claimWebhookEvent(STRIPE_EVENTS_COLLECTION, event.id) === "duplicate") {
                res.json({ received: true, status: "already_processed" });
                return;
            }

            if (event.type === "account.updated") {
                const account = event.data.object;
                const accountId: string = account.id;

                const snap = await db.collection("caregivers")
                    .where("stripeAccountId", "==", accountId)
                    .limit(1)
                    .get();

                if (!snap.empty) {
                    const chargesEnabled = !!account.charges_enabled;
                    const payoutsEnabled = !!account.payouts_enabled;
                    const detailsSubmitted = !!account.details_submitted;
                    const complete = chargesEnabled && payoutsEnabled;

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

                    // Advance Evia onboarding if caregiver has an iMessage session
                    if (complete) {
                        try {
                            const cgPhone = snap.docs[0].data().phone as string | undefined;
                            if (cgPhone) {
                                const { advanceOnboardingStep } = await import("./agents/onboardingConversation");
                                await advanceOnboardingStep(cgPhone, "stripe_connect", "");
                            }
                        } catch (err) {
                            console.error("advanceOnboardingStep(stripe_connect) error:", err);
                        }
                    }
                }
            } else if (event.type === "payout.paid" || event.type === "payout.failed") {
                // Connect webhook — event.account is the connected Stripe account ID
                const payout = event.data.object;
                const stripeAccountId: string = event.account;
                const amountDollars = (payout.amount / 100).toFixed(2);
                const isInstant = payout.method === "instant";

                const snap = await db.collection("caregivers")
                    .where("stripeAccountId", "==", stripeAccountId)
                    .limit(1)
                    .get();

                if (!snap.empty) {
                    const caregiverId = snap.docs[0].id;

                    if (event.type === "payout.paid") {
                        await db.collection("users").doc(caregiverId).collection("notifications").add({
                            userId: caregiverId,
                            type: "payout_paid",
                            title: "Payout Arrived",
                            body: `Your ${isInstant ? "instant" : "standard"} payout of $${amountDollars} has been deposited to your bank account.`,
                            isRead: false,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                    } else {
                        await db.collection("users").doc(caregiverId).collection("notifications").add({
                            userId: caregiverId,
                            type: "payout_failed",
                            title: "Payout Failed",
                            body: `Your payout of $${amountDollars} could not be deposited. Please check your bank account details.`,
                            isRead: false,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                    }
                }
            } else {
                console.log(`Unhandled Connect event: ${event.type}`);
            }

            await settleWebhookEvent(STRIPE_EVENTS_COLLECTION, event.id, "processed");
            res.json({ received: true });
        } catch (error) {
            console.error("Error handling Connect webhook event:", error);
            // Release the claim so Stripe's retry of this 500 reprocesses.
            await settleWebhookEvent(STRIPE_EVENTS_COLLECTION, event.id, "failed");
            res.status(500).send("Internal server error");
        }
    });
