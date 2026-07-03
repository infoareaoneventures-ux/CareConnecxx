import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { assertPayoutsReady } from "./payoutCommon";
import { INSTANT_PAYOUT_FEE_RATE, INSTANT_PAYOUT_FEE_MIN_DOLLARS } from "./billing/config";
const Stripe = require('stripe');

if (!admin.apps.length) {
    admin.initializeApp();
}

const stripe = new Stripe(functions.config().stripe?.secret || process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();

/**
 * Request instant payout for caregiver.
 *
 * Sums `grossPay` across the caregiver's `shiftHours` docs that have already
 * been charged (status='paid') but have not yet been paid out (no `payoutId`).
 * The claim is performed inside a Firestore transaction so concurrent calls
 * cannot double-pay the same shifts.
 */
export const requestInstantPayout = functions.https.onCall(async (_data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }

    const uid = context.auth.uid;

    try {
        const caregiverRef = db.collection('caregivers').doc(uid);
        const caregiverDoc = await caregiverRef.get();
        if (!caregiverDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Caregiver profile not found');
        }

        const stripeAccountId = caregiverDoc.data()?.stripeAccountId;
        if (!stripeAccountId) {
            throw new functions.https.HttpsError('failed-precondition', 'Please connect your bank account first');
        }

        const account = await stripe.accounts.retrieve(stripeAccountId);
        assertPayoutsReady(account);

        // Allocate a payout receipt ID up front so we can stamp it onto each
        // claimed shift inside the transaction (acts as the atomic claim token).
        const payoutRef = caregiverRef.collection('payouts').doc();
        const pendingPayoutId = payoutRef.id;

        // ---- Atomic claim ----
        const claim = await db.runTransaction(async (tx) => {
            const eligibleQuery = db.collection('shiftHours')
                .where('caregiverId', '==', uid)
                .where('status', '==', 'paid');
            const snap = await tx.get(eligibleQuery);

            let totalEarnings = 0;
            const shiftIds: string[] = [];
            const appointmentIds: string[] = [];
            const shiftRefs: FirebaseFirestore.DocumentReference[] = [];
            snap.forEach((doc) => {
                const s = doc.data();
                if (s.payoutId) return;
                totalEarnings += Number(s.grossPay) || 0;
                shiftIds.push(doc.id);
                shiftRefs.push(doc.ref);
                if (s.appointmentId) appointmentIds.push(s.appointmentId);
            });

            totalEarnings = Math.round(totalEarnings * 100) / 100;
            if (totalEarnings < 1) {
                throw new functions.https.HttpsError('failed-precondition', 'Minimum payout amount is $1.00');
            }

            const fee = Math.max(totalEarnings * INSTANT_PAYOUT_FEE_RATE, INSTANT_PAYOUT_FEE_MIN_DOLLARS);
            const netAmount = Math.round((totalEarnings - fee) * 100) / 100;

            shiftRefs.forEach((ref) => {
                tx.update(ref, {
                    payoutId: pendingPayoutId,
                    payoutStatus: 'pending',
                });
            });

            tx.set(payoutRef, {
                amount: netAmount,
                grossAmount: totalEarnings,
                fee,
                type: 'instant',
                status: 'pending',
                shiftIds,
                appointmentIds,
                createdAt: new Date().toISOString(),
            });

            return { totalEarnings, fee, netAmount, shiftIds, appointmentIds, shiftRefPaths: shiftRefs.map(r => r.path) };
        });

        // ---- Stripe call (outside transaction) ----
        let payout: any;
        try {
            payout = await stripe.payouts.create({
                amount: Math.round(claim.netAmount * 100),
                currency: 'usd',
                method: 'instant',
                statement_descriptor: 'Evia Payout',
            }, {
                stripeAccount: stripeAccountId,
                idempotencyKey: `instant-payout-${pendingPayoutId}`,
            });
        } catch (stripeErr: any) {
            // Compensating transaction: release the claim so the caregiver can retry.
            await db.runTransaction(async (tx) => {
                for (const path of claim.shiftRefPaths) {
                    tx.update(db.doc(path), {
                        payoutId: admin.firestore.FieldValue.delete(),
                        payoutStatus: admin.firestore.FieldValue.delete(),
                    });
                }
                tx.update(payoutRef, {
                    status: 'failed',
                    failureReason: stripeErr?.message || 'stripe_error',
                    failedAt: new Date().toISOString(),
                });
            });
            throw stripeErr;
        }

        // ---- Post-Stripe finalization ----
        const batch = db.batch();
        const arrivalDateIso = payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null;
        const paidOutAt = new Date().toISOString();

        claim.shiftRefPaths.forEach((path) => {
            batch.update(db.doc(path), {
                payoutType: 'instant',
                paidOutAt,
                stripePayoutId: payout.id,
                payoutStatus: 'completed',
            });
        });
        claim.appointmentIds.forEach((id) => {
            batch.update(db.collection('appointments').doc(id), {
                paymentStatus: 'paid',
                paidAt: paidOutAt,
                payoutId: pendingPayoutId,
            });
        });
        batch.update(payoutRef, {
            status: payout.status,
            stripePayoutId: payout.id,
            arrivalDate: arrivalDateIso,
            paidOutAt,
        });
        await batch.commit();

        await db.collection('users').doc(uid).collection('notifications').add({
            userId: uid,
            type: 'payout_initiated',
            title: 'Instant Payout Initiated',
            body: `Your instant payout of $${claim.netAmount.toFixed(2)} has been initiated.`,
            isRead: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
            success: true,
            amount: claim.netAmount,
            fee: claim.fee,
            payoutId: payout.id,
            arrivalDate: payout.arrival_date,
            message: 'Instant payout initiated successfully!',
        };

    } catch (error: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('Instant payout error:', error);
        }
        if (error.type === 'StripeCardError') {
            throw new functions.https.HttpsError('failed-precondition', 'Bank account issue: ' + error.message);
        } else if (error.type === 'StripeInvalidRequestError') {
            throw new functions.https.HttpsError('invalid-argument', error.message);
        }
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError('internal', error.message || 'Payout failed');
    }
});
