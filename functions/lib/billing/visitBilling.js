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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVisitPayment = createVisitPayment;
exports.handlePaymentError = handlePaymentError;
const admin = __importStar(require("firebase-admin"));
const stripe_1 = __importDefault(require("stripe"));
const client_1 = require("../linq/client");
const caraAgent_1 = require("../agents/caraAgent");
const auditLog_1 = require("../observability/auditLog");
const db = admin.firestore();
let _stripe = null;
function getStripe() {
    var _a;
    if (!_stripe) {
        _stripe = new stripe_1.default((_a = process.env.STRIPE_SECRET_KEY) !== null && _a !== void 0 ? _a : "", { apiVersion: "2023-10-16" });
    }
    return _stripe;
}
const SUPPORT_PHONE = (_a = process.env.SUPPORT_PHONE) !== null && _a !== void 0 ? _a : "1-800-555-0199";
async function createVisitPayment(params) {
    var _a, _b;
    const { appointmentId, clientId, clientPhone, caregiverId, caregiverName, caregiverPhone, durationHours, hourlyRate, date, } = params;
    const amountCents = Math.round(durationHours * hourlyRate * 100);
    const now = new Date().toISOString();
    // Retrieve client's Stripe customer ID + phone (if not supplied)
    const userSnap = await db.collection("users").doc(clientId).get();
    const resolvedPhone = clientPhone || ((_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.phone) || "";
    const customerId = (_b = userSnap.data()) === null || _b === void 0 ? void 0 : _b.stripeCustomerId;
    let paymentIntentId;
    if (customerId) {
        try {
            const pi = await getStripe().paymentIntents.create({
                amount: amountCents,
                currency: "usd",
                customer: customerId,
                application_fee_amount: 0, // Caregivers keep 100%
                description: `Care visit — ${caregiverName} on ${date}`,
                metadata: {
                    appointmentId,
                    clientId,
                    caregiverId,
                },
                confirm: false, // Confirm separately when client approves
            });
            paymentIntentId = pi.id;
        }
        catch (err) {
            console.error("createVisitPayment Stripe error:", err);
        }
    }
    // Write visit_payments doc
    await db.collection("visit_payments").doc(appointmentId).set({
        appointmentId,
        clientId,
        caregiverId,
        caregiverName,
        date,
        durationHours,
        hourlyRate,
        amountCents,
        status: paymentIntentId ? "pending" : "no_payment_method",
        stripePaymentIntentId: paymentIntentId !== null && paymentIntentId !== void 0 ? paymentIntentId : null,
        createdAt: now,
    });
    (0, auditLog_1.logBookingCreated)(clientId, caregiverId, [date]).catch(() => { });
    // Notify client (low urgency — informational)
    const totalStr = `$${(amountCents / 100).toFixed(2)}`;
    if (resolvedPhone)
        await (0, caraAgent_1.sendViaInteractionAgent)(resolvedPhone, {
            content: `Visit complete! A payment of ${totalStr} will be processed for today's ` +
                `${durationHours}h visit with ${caregiverName}.`,
            urgency: "low",
            sourceAgent: "visit_billing",
            canDrop: true,
        }).catch(() => { });
    // Notify caregiver directly (bypass interaction agent — caregiver-initiated message path)
    if (caregiverPhone) {
        await (0, client_1.sendToPhone)(caregiverPhone, `✅ Visit logged for ${date}. Your payment of ${totalStr} will be processed shortly.`).catch(() => { });
    }
}
async function handlePaymentError(params) {
    var _a;
    const { appointmentId, clientId, clientPhone, caregiverId, caregiverName, caregiverPhone, amountCents, errorMessage } = params;
    const now = new Date().toISOString();
    await db.collection("visit_payments").doc(appointmentId).set({
        status: "failed",
        failedAt: now,
        errorMessage,
    }, { merge: true });
    await db.collection("admin_alerts").add({
        type: "payment_failed",
        appointmentId,
        clientId,
        caregiverId,
        amountCents,
        errorMessage,
        createdAt: now,
        resolved: false,
        severity: "high",
    });
    const totalStr = `$${(amountCents / 100).toFixed(2)}`;
    // Notify client with a tap-to-fix link — immediate, can't drop
    try {
        const { generateToken } = await Promise.resolve().then(() => __importStar(require("../agents/tokenService")));
        const appUrl = (_a = process.env.APP_URL) !== null && _a !== void 0 ? _a : "https://cara.app";
        const token = generateToken({ phone: clientPhone, task: "payment" });
        const updateUrl = `${appUrl}/done?task=payment&t=${token}`;
        await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
            content: `There was an issue processing payment for the recent visit (${totalStr}). ` +
                `Tap the link to update your payment method and we'll retry automatically:\n${updateUrl}\n\n` +
                `Questions? Call us at ${SUPPORT_PHONE}.`,
            urgency: "immediate",
            sourceAgent: "visit_billing",
            canDrop: false,
        });
        await db.collection("appointments").doc(appointmentId).update({
            paymentFailureNotifiedAt: now,
        });
    }
    catch (notifyErr) {
        console.error("visitBilling: failed to notify client via iMessage:", notifyErr);
    }
    // Reassure caregiver they'll be paid
    if (caregiverPhone) {
        await (0, client_1.sendToPhone)(caregiverPhone, `Hi ${caregiverName.split(" ")[0]} — there was a payment processing issue on our end, ` +
            `but you will be paid for your visit. We're resolving it now.`).catch(() => { });
    }
}
//# sourceMappingURL=visitBilling.js.map