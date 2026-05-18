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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onRefundRequestWrite = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const stripe_1 = __importDefault(require("stripe"));
const caraAgent_1 = require("../agents/caraAgent");
const db = admin.firestore();
let _stripe = null;
function getStripe() {
    var _a;
    if (!_stripe) {
        _stripe = new stripe_1.default((_a = process.env.STRIPE_SECRET_KEY) !== null && _a !== void 0 ? _a : "", { apiVersion: "2023-10-16" });
    }
    return _stripe;
}
// ── onRefundRequestWrite — execute Stripe refund when status → "approved" ─────
exports.onRefundRequestWrite = functions.firestore
    .document("refundRequests/{requestId}")
    .onWrite(async (change, context) => {
    const requestId = context.params.requestId;
    const after = change.after.exists ? change.after.data() : null;
    const before = change.before.exists ? change.before.data() : null;
    if (!after)
        return;
    // Only act when status transitions to "approved"
    if (after.status !== "approved" || (before === null || before === void 0 ? void 0 : before.status) === "approved")
        return;
    // Prevent re-processing
    if (after.stripeRefundId)
        return;
    try {
        await processRefund(requestId, after);
    }
    catch (err) {
        console.error(`[onRefundRequestWrite] processRefund failed for ${requestId}:`, err);
        await change.after.ref.update({
            status: "failed",
            errorMessage: String(err),
            failedAt: new Date().toISOString(),
        });
    }
});
async function processRefund(requestId, req) {
    var _a, _b;
    const { appointmentId, clientId, amount } = req;
    // Look up Stripe payment intent from visit_billing records
    let paymentIntentId;
    const billingSnap = await db.collection("visit_billing")
        .where("appointmentId", "==", appointmentId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();
    if (!billingSnap.empty) {
        paymentIntentId = billingSnap.docs[0].data().stripePaymentIntentId;
    }
    // Fall back to appointment document
    if (!paymentIntentId) {
        const apptSnap = await db.collection("appointments").doc(appointmentId !== null && appointmentId !== void 0 ? appointmentId : "").get();
        paymentIntentId = (_a = apptSnap.data()) === null || _a === void 0 ? void 0 : _a.stripePaymentIntentId;
    }
    if (!paymentIntentId) {
        // No payment intent found — mark as manual (admin must refund through Stripe dashboard)
        await db.collection("refundRequests").doc(requestId).update({
            status: "manual_required",
            manualNote: "No Stripe payment intent found — please refund via Stripe dashboard",
            updatedAt: new Date().toISOString(),
        });
        await db.collection("admin_alerts").add({
            type: "refund_manual_required",
            requestId,
            clientId,
            appointmentId,
            amount,
            createdAt: new Date().toISOString(),
            resolved: false,
        });
        return;
    }
    // Execute the Stripe refund
    const amountCents = Math.round(amount * 100);
    const refund = await getStripe().refunds.create(Object.assign(Object.assign({ payment_intent: paymentIntentId }, (amountCents > 0 ? { amount: amountCents } : {})), { reason: "requested_by_customer", metadata: { requestId, clientId: clientId !== null && clientId !== void 0 ? clientId : "" } }), { idempotencyKey: `refund-${requestId}` });
    // Update refund request
    await db.collection("refundRequests").doc(requestId).update({
        status: "completed",
        stripeRefundId: refund.id,
        completedAt: new Date().toISOString(),
    });
    // Update appointment status
    if (appointmentId) {
        await db.collection("appointments").doc(appointmentId).update({
            status: "refunded",
            refundedAt: new Date().toISOString(),
        }).catch(() => { });
    }
    // Notify client
    if (clientId) {
        const userSnap = await db.collection("users").doc(clientId).get();
        const clientPhone = (_b = userSnap.data()) === null || _b === void 0 ? void 0 : _b.phone;
        if (clientPhone) {
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: `Your refund of $${Number(amount !== null && amount !== void 0 ? amount : 0).toFixed(2)} has been processed and will appear ` +
                    `on your statement within 5–10 business days.`,
                urgency: "standard",
                sourceAgent: "refund_processor",
                canDrop: false,
            }).catch(() => { });
        }
    }
    console.log(`[processRefund] Refund ${refund.id} executed for request ${requestId}`);
}
//# sourceMappingURL=refundProcessor.js.map