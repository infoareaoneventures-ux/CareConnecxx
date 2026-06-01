"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestStandardPayout = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const payoutCommon_1 = require("./payoutCommon");
const Stripe = require("stripe");
if (!admin.apps.length) {
    admin.initializeApp();
}
const stripe = new Stripe(((_a = functions.config().stripe) === null || _a === void 0 ? void 0 : _a.secret) || process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();
/**
 * Request standard (free, 2-3 day) payout for caregiver.
 *
 * Same balance + atomic claim logic as `requestInstantPayout`, with no fee
 * and `method: 'standard'`.
 */
exports.requestStandardPayout = functions
    .https.onCall(async (_data, context) => {
    var _a;
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
    }
    const uid = context.auth.uid;
    try {
        const caregiverRef = db.collection("caregivers").doc(uid);
        const caregiverDoc = await caregiverRef.get();
        if (!caregiverDoc.exists) {
            throw new functions.https.HttpsError("not-found", "Caregiver profile not found");
        }
        const stripeAccountId = (_a = caregiverDoc.data()) === null || _a === void 0 ? void 0 : _a.stripeAccountId;
        if (!stripeAccountId) {
            throw new functions.https.HttpsError("failed-precondition", "Please connect your bank account first");
        }
        const account = await stripe.accounts.retrieve(stripeAccountId);
        (0, payoutCommon_1.assertPayoutsReady)(account);
        const payoutRef = caregiverRef.collection("payouts").doc();
        const pendingPayoutId = payoutRef.id;
        const claim = await db.runTransaction(async (tx) => {
            const eligibleQuery = db.collection("shiftHours")
                .where("caregiverId", "==", uid)
                .where("status", "==", "paid");
            const snap = await tx.get(eligibleQuery);
            let totalEarnings = 0;
            const shiftIds = [];
            const appointmentIds = [];
            const shiftRefs = [];
            snap.forEach((doc) => {
                const s = doc.data();
                if (s.payoutId)
                    return;
                totalEarnings += Number(s.grossPay) || 0;
                shiftIds.push(doc.id);
                shiftRefs.push(doc.ref);
                if (s.appointmentId)
                    appointmentIds.push(s.appointmentId);
            });
            totalEarnings = Math.round(totalEarnings * 100) / 100;
            if (totalEarnings < 1) {
                throw new functions.https.HttpsError("failed-precondition", "Minimum payout amount is $1.00");
            }
            shiftRefs.forEach((ref) => {
                tx.update(ref, {
                    payoutId: pendingPayoutId,
                    payoutStatus: "pending",
                });
            });
            tx.set(payoutRef, {
                amount: totalEarnings,
                grossAmount: totalEarnings,
                fee: 0,
                type: "standard",
                status: "pending",
                shiftIds,
                appointmentIds,
                createdAt: new Date().toISOString(),
            });
            return { totalEarnings, shiftIds, appointmentIds, shiftRefPaths: shiftRefs.map((r) => r.path) };
        });
        let payout;
        try {
            payout = await stripe.payouts.create({
                amount: Math.round(claim.totalEarnings * 100),
                currency: "usd",
                method: "standard",
                statement_descriptor: "Cara Payout",
            }, {
                stripeAccount: stripeAccountId,
                idempotencyKey: `standard-payout-${pendingPayoutId}`,
            });
        }
        catch (stripeErr) {
            await db.runTransaction(async (tx) => {
                for (const path of claim.shiftRefPaths) {
                    tx.update(db.doc(path), {
                        payoutId: admin.firestore.FieldValue.delete(),
                        payoutStatus: admin.firestore.FieldValue.delete(),
                    });
                }
                tx.update(payoutRef, {
                    status: "failed",
                    failureReason: (stripeErr === null || stripeErr === void 0 ? void 0 : stripeErr.message) || "stripe_error",
                    failedAt: new Date().toISOString(),
                });
            });
            throw stripeErr;
        }
        const batch = db.batch();
        const arrivalDateIso = payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null;
        const paidOutAt = new Date().toISOString();
        claim.shiftRefPaths.forEach((path) => {
            batch.update(db.doc(path), {
                payoutType: "standard",
                paidOutAt,
                stripePayoutId: payout.id,
                payoutStatus: "completed",
            });
        });
        claim.appointmentIds.forEach((id) => {
            batch.update(db.collection("appointments").doc(id), {
                paymentStatus: "paid",
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
        return {
            success: true,
            amount: claim.totalEarnings,
            fee: 0,
            payoutId: payout.id,
            arrivalDate: payout.arrival_date,
            message: "Standard payout initiated! Funds arrive in 2-3 business days.",
        };
    }
    catch (error) {
        if (process.env.NODE_ENV !== "production") {
            console.error("Standard payout error:", error);
        }
        if (error.type === "StripeCardError") {
            throw new functions.https.HttpsError("failed-precondition", "Bank account issue: " + error.message);
        }
        else if (error.type === "StripeInvalidRequestError") {
            throw new functions.https.HttpsError("invalid-argument", error.message);
        }
        if (error instanceof functions.https.HttpsError)
            throw error;
        throw new functions.https.HttpsError("internal", error.message || "Payout failed");
    }
});
//# sourceMappingURL=standardPayout.js.map