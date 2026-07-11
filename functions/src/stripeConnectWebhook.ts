import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { claimWebhookEvent, settleWebhookEvent, STRIPE_EVENTS_COLLECTION } from "./utils/webhookLedger";
import { isOfflinePaymentMethod } from "./billing/paymentMethods";
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

                    // Keep the caregivers/{id}/payouts ledger in sync. Instant
                    // payouts have a doc (written by executeInstantPayout);
                    // Stripe's automatic daily payouts have none, so record one
                    // here — this is the only writer for automatic payouts.
                    const payoutsCol = db.collection("caregivers").doc(caregiverId).collection("payouts");
                    const ledgerSnap = await payoutsCol.where("stripePayoutId", "==", payout.id).limit(1).get();
                    const settledStatus = event.type === "payout.paid" ? "paid" : "failed";
                    if (!ledgerSnap.empty) {
                        await ledgerSnap.docs[0].ref.update({
                            status: settledStatus,
                            ...(event.type === "payout.failed" ? { failureReason: payout.failure_message ?? payout.failure_code ?? "payout_failed" } : {}),
                            settledAt: new Date().toISOString(),
                        });
                    } else {
                        await payoutsCol.add({
                            amount: payout.amount / 100,
                            grossAmount: payout.amount / 100,
                            fee: 0,
                            type: isInstant ? "instant" : "automatic",
                            status: settledStatus,
                            source: "stripe_schedule",
                            stripePayoutId: payout.id,
                            arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null,
                            createdAt: new Date(payout.created * 1000).toISOString(),
                            settledAt: new Date().toISOString(),
                        });
                    }

                    if (event.type === "payout.paid") {
                        // Reconcile the shift ledger: every charged-and-transferred
                        // shift that hasn't been stamped yet is covered by the
                        // sweep that just landed. Keeps earnings/pending displays
                        // honest under automatic daily payouts.
                        const unstampedShifts = await db.collection("shiftHours")
                            .where("caregiverId", "==", caregiverId)
                            .where("status", "==", "paid")
                            .get();
                        const batch = db.batch();
                        const paidOutAt = new Date().toISOString();
                        // A payout only covers balance that settled BEFORE it was
                        // cut. A shift whose transfer landed after payout.created
                        // is in the NEXT sweep, not this one — stamping it here
                        // claims the money hit the bank ~1 day early.
                        const payoutCreatedMs = (payout.created ?? 0) * 1000;
                        let stamped = 0;
                        unstampedShifts.forEach((shiftDoc) => {
                            const s = shiftDoc.data();
                            // Offline shifts (cash/Venmo/Zelle) settle outside Stripe
                            // and are marked paid by confirmOfflinePaymentReceived.
                            if (s.paidOutAt || isOfflinePaymentMethod(s.paymentMethod)) return;
                            // Skip shifts that settled after this payout was created.
                            const settledMs = Date.parse(s.lastPaymentAttemptAt ?? s.updatedAt ?? "");
                            if (Number.isFinite(settledMs) && payoutCreatedMs && settledMs > payoutCreatedMs) return;
                            batch.update(shiftDoc.ref, {
                                payoutStatus: "completed",
                                payoutType: isInstant ? "instant" : "automatic",
                                paidOutAt,
                                stripePayoutId: payout.id,
                            });
                            if (s.appointmentId) {
                                // set+merge: never abort the batch on a missing appointment doc
                                batch.set(db.collection("appointments").doc(s.appointmentId), {
                                    paymentStatus: "paid",
                                    paidAt: paidOutAt,
                                }, { merge: true });
                            }
                            stamped++;
                        });
                        if (stamped > 0) await batch.commit();

                        await db.collection("users").doc(caregiverId).collection("notifications").add({
                            userId: caregiverId,
                            type: "payout_paid",
                            title: "Payout Arrived",
                            body: `Your ${isInstant ? "instant" : ""} payout of $${amountDollars} has been deposited to your bank account.`.replace("  ", " "),
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
