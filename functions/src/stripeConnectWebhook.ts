import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
const Stripe = require("stripe");

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

                    // Advance Cara onboarding if caregiver has an iMessage session
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
            } else {
                console.log(`Unhandled Connect event: ${event.type}`);
            }

            res.json({ received: true });
        } catch (error) {
            console.error("Error handling Connect webhook event:", error);
            res.status(500).send("Internal server error");
        }
    });
