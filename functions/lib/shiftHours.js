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
exports.confirmCashReceived = exports.onShiftHoursApproved = exports.retryFailedShiftPayments = exports.autoAcceptCorrection = exports.autoApproveShiftHours = exports.retryShiftPayment = exports.adminResolveShiftHours = exports.respondToCorrection = exports.reviewShiftHours = exports.submitShiftHours = void 0;
exports.approveShiftHoursForClient = approveShiftHoursForClient;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const Stripe = require('stripe');
const stripe = new Stripe(((_a = functions.config().stripe) === null || _a === void 0 ? void 0 : _a.secret) || process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PLATFORM_FEE_RATE = 0.015; // 1.5%
const PLATFORM_FEE_MIN = 0.50; // $0.50 min
const MAX_PAYMENT_ATTEMPTS = 3;
// ---------- helpers ----------
async function requireAdmin(uid) {
    var _a;
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists || ((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.userType) !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
}
function computeTotalHours(startIso, endIso) {
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    if (!isFinite(start) || !isFinite(end) || end <= start) {
        throw new functions.https.HttpsError('invalid-argument', 'End time must be after start time');
    }
    return Math.round(((end - start) / 1000 / 60 / 60) * 100) / 100;
}
function nowIso() {
    return new Date().toISOString();
}
async function pushNotification(userId, type, title, message, data) {
    await db.collection('notifications').add({
        userId,
        type,
        title,
        message,
        data,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}
async function notifyAdmins(type, title, message, data) {
    const admins = await db.collection('users').where('userType', '==', 'admin').get();
    const batch = db.batch();
    admins.forEach(docSnap => {
        const ref = db.collection('notifications').doc();
        batch.set(ref, {
            userId: docSnap.id,
            type,
            title,
            message,
            data,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    });
    await batch.commit();
}
// ---------- callables ----------
/**
 * Caregiver submits hours for a completed appointment.
 */
exports.submitShiftHours = functions.https.onCall(async (data, context) => {
    var _a, _b, _c, _d;
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    const { shiftId, startTime, endTime, lineItems: rawLineItems = [] } = data;
    if (!shiftId || !startTime || !endTime) {
        throw new functions.https.HttpsError('invalid-argument', 'shiftId, startTime and endTime are required');
    }
    // Validate and sanitise line items
    const VALID_TYPES = ['overtime', 'mileage', 'supplies', 'bonus', 'custom'];
    const lineItems = (Array.isArray(rawLineItems) ? rawLineItems : [])
        .filter((li) => li && typeof li === 'object')
        .map((li) => ({
        type: VALID_TYPES.includes(li.type) ? li.type : 'custom',
        label: typeof li.label === 'string' ? li.label.slice(0, 100) : '',
        note: typeof li.note === 'string' ? li.note.slice(0, 500) : '',
        amount: Math.max(0, Math.round((Number(li.amount) || 0) * 100) / 100),
    }))
        .filter((li) => li.amount > 0);
    const lineItemsTotal = lineItems.reduce((sum, li) => sum + li.amount, 0);
    // Source of truth is now the shifts collection
    const shiftDocRef = db.collection('shifts').doc(shiftId);
    const shiftDocSnap = await shiftDocRef.get();
    if (!shiftDocSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'Shift not found');
    }
    const shiftDoc = shiftDocSnap.data();
    if (shiftDoc.caregiverId !== context.auth.uid) {
        throw new functions.https.HttpsError('permission-denied', 'Not your shift');
    }
    if (shiftDoc.status !== 'completed') {
        throw new functions.https.HttpsError('failed-precondition', 'Shift is not completed yet');
    }
    const shiftHoursRef = db.collection('shiftHours').doc(shiftId);
    const existing = await shiftHoursRef.get();
    if (existing.exists) {
        throw new functions.https.HttpsError('already-exists', 'Hours already submitted for this shift');
    }
    const caregiverDoc = await db.collection('users').doc(context.auth.uid).get();
    const caregiverData = caregiverDoc.data() || {};
    const totalHours = computeTotalHours(startTime, endTime);
    const payRate = shiftDoc.rate || caregiverData.hourlyRate || 25;
    const paymentMethod = (shiftDoc.paymentMethod || '').toLowerCase() === 'cash' ? 'cash' : 'credit';
    const submittedAt = nowIso();
    const autoApproveAt = new Date(Date.now() + ONE_DAY_MS).toISOString();
    const basePay = Math.round(totalHours * payRate * 100) / 100;
    const grossPay = Math.round((basePay + lineItemsTotal) * 100) / 100;
    await shiftHoursRef.set({
        id: shiftId,
        appointmentId: shiftId, // keep field for backward compat with existing queries
        shiftId,
        caregiverId: context.auth.uid,
        caregiverName: caregiverData.name || caregiverData.displayName || shiftDoc.caregiverName || 'Caregiver',
        caregiverPhotoURL: caregiverData.profilePhoto || caregiverData.photoURL || shiftDoc.caregiverPhotoURL || null,
        clientId: shiftDoc.clientId,
        clientName: shiftDoc.clientName || 'Client',
        payRate,
        currency: 'usd',
        paymentMethod,
        submittedStartTime: startTime,
        submittedEndTime: endTime,
        submittedTotalHours: totalHours,
        lineItems,
        lineItemsTotal,
        basePay,
        grossPay,
        submittedAt,
        autoApproveAt,
        paymentAttemptCount: 0,
        status: 'pending_client_review',
        createdAt: submittedAt,
        updatedAt: submittedAt,
    });
    await pushNotification(shiftDoc.clientId, 'shift_hours_submitted', 'Hours submitted for your review', `${caregiverData.name || 'Your caregiver'} submitted ${totalHours}h for review. Auto-approves in 24h.`, { appointmentId: shiftId, totalHours });
    // iMessage: notify client so they can approve or dispute without opening the app
    try {
        const clientUserSnap = await db.collection("users").doc(shiftDoc.clientId).get();
        const clientPhone = (_a = clientUserSnap.data()) === null || _a === void 0 ? void 0 : _a.phone;
        if (clientPhone) {
            const amount = (totalHours * payRate).toFixed(2);
            const { sendToPhone } = await Promise.resolve().then(() => __importStar(require("./linq/client")));
            await sendToPhone(clientPhone, `${(_b = caregiverData.name) !== null && _b !== void 0 ? _b : "Your caregiver"} submitted ${totalHours}h for ` +
                `${(_c = shiftDoc.date) !== null && _c !== void 0 ? _c : "today"}'s visit ($${amount}).\n\n` +
                `Reply APPROVE to confirm, or DISPUTE if something looks wrong.`);
            await db.collection("agent_sessions").doc(clientPhone).set({
                pendingShiftApproval: {
                    appointmentId: shiftId,
                    amount,
                    caregiverName: (_d = caregiverData.name) !== null && _d !== void 0 ? _d : "Caregiver",
                },
                pendingShiftApprovalSetAt: new Date().toISOString(),
            }, { merge: true });
        }
    }
    catch (err) {
        console.error("shiftHours iMessage notification error:", err);
    }
    return { success: true, shiftId, totalHours };
});
/**
 * Client approves or proposes a correction.
 */
exports.reviewShiftHours = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    const { appointmentId, action, proposedStartTime, proposedEndTime, proposalReason } = data;
    if (!appointmentId || (action !== 'approve' && action !== 'propose_correction')) {
        throw new functions.https.HttpsError('invalid-argument', 'appointmentId and valid action required');
    }
    const ref = db.collection('shiftHours').doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Shift hours not found');
    }
    const shift = snap.data();
    if (shift.clientId !== context.auth.uid) {
        throw new functions.https.HttpsError('permission-denied', 'Not your appointment');
    }
    if (shift.status !== 'pending_client_review') {
        throw new functions.https.HttpsError('failed-precondition', 'Already reviewed');
    }
    const now = nowIso();
    if (action === 'approve') {
        await ref.update({
            status: 'approved',
            finalStartTime: shift.submittedStartTime,
            finalEndTime: shift.submittedEndTime,
            finalTotalHours: shift.submittedTotalHours,
            grossPay: Math.round(shift.submittedTotalHours * shift.payRate * 100) / 100,
            resolvedAt: now,
            resolvedBy: 'client',
            updatedAt: now,
        });
        await pushNotification(shift.caregiverId, 'shift_hours_approved', 'Your hours were approved', `Client approved ${shift.submittedTotalHours}h.`, { appointmentId });
        return { success: true };
    }
    // action === 'propose_correction'
    if (!proposedStartTime || !proposedEndTime) {
        throw new functions.https.HttpsError('invalid-argument', 'Proposed start/end required');
    }
    const proposedTotalHours = computeTotalHours(proposedStartTime, proposedEndTime);
    const correctionRespondByAt = new Date(Date.now() + ONE_DAY_MS).toISOString();
    await ref.update({
        status: 'correction_proposed',
        proposedStartTime,
        proposedEndTime,
        proposedTotalHours,
        proposalReason: proposalReason || null,
        proposedAt: now,
        correctionRespondByAt,
        updatedAt: now,
    });
    await pushNotification(shift.caregiverId, 'shift_hours_correction_proposed', 'Client proposed a correction', `Client proposed ${proposedTotalHours}h (you submitted ${shift.submittedTotalHours}h). Respond within 24h or it auto-accepts.`, { appointmentId, proposedTotalHours });
    return { success: true };
});
/**
 * Caregiver accepts or rejects the client's correction.
 */
exports.respondToCorrection = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    const { appointmentId, action } = data;
    if (!appointmentId || (action !== 'accept' && action !== 'reject')) {
        throw new functions.https.HttpsError('invalid-argument', 'appointmentId and valid action required');
    }
    const ref = db.collection('shiftHours').doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Shift hours not found');
    }
    const shift = snap.data();
    if (shift.caregiverId !== context.auth.uid) {
        throw new functions.https.HttpsError('permission-denied', 'Not your shift');
    }
    if (shift.status !== 'correction_proposed') {
        throw new functions.https.HttpsError('failed-precondition', 'Nothing to respond to');
    }
    const now = nowIso();
    if (action === 'accept') {
        await ref.update({
            status: 'approved',
            finalStartTime: shift.proposedStartTime,
            finalEndTime: shift.proposedEndTime,
            finalTotalHours: shift.proposedTotalHours,
            grossPay: Math.round(shift.proposedTotalHours * shift.payRate * 100) / 100,
            resolvedAt: now,
            resolvedBy: 'caregiver',
            updatedAt: now,
        });
        await pushNotification(shift.clientId, 'shift_hours_approved', 'Caregiver accepted correction', `${shift.caregiverName} accepted your proposed ${shift.proposedTotalHours}h.`, { appointmentId });
        return { success: true };
    }
    // reject → admin mediation
    await ref.update({
        status: 'disputed_admin_review',
        resolvedBy: null,
        updatedAt: now,
    });
    await notifyAdmins('shift_hours_admin_review', 'Shift hours dispute needs mediation', `${shift.caregiverName} and ${shift.clientName} could not agree on hours for appointment ${appointmentId}.`, { appointmentId });
    return { success: true };
});
/**
 * Admin resolves a disputed shift.
 */
exports.adminResolveShiftHours = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    await requireAdmin(context.auth.uid);
    const { appointmentId, finalStartTime, finalEndTime, note } = data;
    if (!appointmentId || !finalStartTime || !finalEndTime) {
        throw new functions.https.HttpsError('invalid-argument', 'appointmentId, finalStartTime, finalEndTime required');
    }
    const ref = db.collection('shiftHours').doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Shift hours not found');
    }
    const shift = snap.data();
    if (shift.status !== 'disputed_admin_review') {
        throw new functions.https.HttpsError('failed-precondition', 'Not in admin review');
    }
    const finalTotalHours = computeTotalHours(finalStartTime, finalEndTime);
    const now = nowIso();
    await ref.update({
        status: 'approved',
        finalStartTime,
        finalEndTime,
        finalTotalHours,
        grossPay: Math.round(finalTotalHours * shift.payRate * 100) / 100,
        resolvedAt: now,
        resolvedBy: 'admin',
        adminAssignedTo: context.auth.uid,
        adminResolutionNote: note || null,
        updatedAt: now,
    });
    await pushNotification(shift.caregiverId, 'shift_hours_approved', 'Admin resolved your dispute', `Final: ${finalTotalHours}h.`, { appointmentId });
    await pushNotification(shift.clientId, 'shift_hours_approved', 'Admin resolved the dispute', `Final: ${finalTotalHours}h.`, { appointmentId });
    return { success: true };
});
/**
 * Admin manually retries a failed Stripe payment.
 */
exports.retryShiftPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    await requireAdmin(context.auth.uid);
    const { appointmentId } = data;
    if (!appointmentId) {
        throw new functions.https.HttpsError('invalid-argument', 'appointmentId required');
    }
    const ref = db.collection('shiftHours').doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Shift hours not found');
    }
    const shift = snap.data();
    if (shift.status !== 'payment_failed') {
        throw new functions.https.HttpsError('failed-precondition', 'Not in payment_failed state');
    }
    const result = await processShiftPayment(appointmentId, shift);
    return { success: result.ok, error: result.error };
});
// ---------- scheduled ----------
/**
 * Auto-approve shifts the client hasn't touched within 24h.
 */
exports.autoApproveShiftHours = functions.pubsub.schedule('every 1 hours').onRun(async () => {
    const now = nowIso();
    const snap = await db.collection('shiftHours')
        .where('status', '==', 'pending_client_review')
        .where('autoApproveAt', '<=', now)
        .limit(200)
        .get();
    for (const doc of snap.docs) {
        const shift = doc.data();
        await doc.ref.update({
            status: 'auto_approved',
            finalStartTime: shift.submittedStartTime,
            finalEndTime: shift.submittedEndTime,
            finalTotalHours: shift.submittedTotalHours,
            grossPay: Math.round(shift.submittedTotalHours * shift.payRate * 100) / 100,
            resolvedAt: now,
            resolvedBy: 'system_auto_approve',
            updatedAt: now,
        });
        await pushNotification(shift.caregiverId, 'shift_hours_auto_approved', 'Hours auto-approved', `Client did not respond in 24h; ${shift.submittedTotalHours}h auto-approved.`, { appointmentId: doc.id });
        await pushNotification(shift.clientId, 'shift_hours_auto_approved', 'Hours auto-approved', `The 24h review window closed; ${shift.submittedTotalHours}h auto-approved.`, { appointmentId: doc.id });
    }
    return null;
});
/**
 * Auto-accept client's proposed correction after 24h caregiver silence.
 */
exports.autoAcceptCorrection = functions.pubsub.schedule('every 1 hours').onRun(async () => {
    const now = nowIso();
    const snap = await db.collection('shiftHours')
        .where('status', '==', 'correction_proposed')
        .where('correctionRespondByAt', '<=', now)
        .limit(200)
        .get();
    for (const doc of snap.docs) {
        const shift = doc.data();
        await doc.ref.update({
            status: 'approved',
            finalStartTime: shift.proposedStartTime,
            finalEndTime: shift.proposedEndTime,
            finalTotalHours: shift.proposedTotalHours,
            grossPay: Math.round(shift.proposedTotalHours * shift.payRate * 100) / 100,
            resolvedAt: now,
            resolvedBy: 'system_auto_accept',
            updatedAt: now,
        });
        await pushNotification(shift.caregiverId, 'shift_hours_approved', 'Correction auto-accepted', `You did not respond in 24h; client's ${shift.proposedTotalHours}h proposal was accepted.`, { appointmentId: doc.id });
        await pushNotification(shift.clientId, 'shift_hours_approved', 'Correction auto-accepted', `Caregiver did not respond; your proposed ${shift.proposedTotalHours}h is final.`, { appointmentId: doc.id });
    }
    return null;
});
/**
 * Retry failed payments up to MAX_PAYMENT_ATTEMPTS.
 */
exports.retryFailedShiftPayments = functions.pubsub.schedule('every 6 hours').onRun(async () => {
    const snap = await db.collection('shiftHours')
        .where('status', '==', 'payment_failed')
        .limit(50)
        .get();
    for (const doc of snap.docs) {
        const shift = doc.data();
        if ((shift.paymentAttemptCount || 0) >= MAX_PAYMENT_ATTEMPTS) {
            continue;
        }
        await processShiftPayment(doc.id, shift);
    }
    return null;
});
// ---------- Firestore trigger ----------
/**
 * When a shift transitions to approved/auto_approved and is credit, run Stripe.
 */
exports.onShiftHoursApproved = functions
    .firestore.document('shiftHours/{appointmentId}')
    .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const nowPayable = (after.status === 'approved' || after.status === 'auto_approved');
    const wasPayable = (before.status === 'approved' || before.status === 'auto_approved');
    if (!nowPayable || wasPayable) {
        return null;
    }
    if (after.paymentMethod === 'cash') {
        // Cash shifts: client has approved — notify caregiver to confirm cash receipt.
        // We do NOT mark paid here; caregiver must call confirmCashReceived to close it out.
        await pushNotification(after.caregiverId, 'shift_hours_cash_pending_confirmation', 'Client approved your hours', `Confirm you received $${(after.grossPay || 0).toFixed(2)} cash from ${after.clientName || 'the client'}.`, { appointmentId: context.params.appointmentId });
        return null;
    }
    await processShiftPayment(context.params.appointmentId, after);
    return null;
});
// ---------- core Stripe flow ----------
async function processShiftPayment(appointmentId, shift) {
    var _a, _b, _c;
    const ref = db.collection('shiftHours').doc(appointmentId);
    const attempt = (shift.paymentAttemptCount || 0) + 1;
    const now = nowIso();
    // Hard idempotency: never run the payment flow twice on a shift that's
    // already settled. The Stripe-side idempotencyKeys on charge/transfer below
    // are belt-and-suspenders — this short-circuits before we even hit Stripe.
    if (shift.status === 'paid' && shift.stripeChargeId && shift.stripeTransferId) {
        return { ok: true };
    }
    try {
        const caregiverSnap = await db.collection('caregivers').doc(shift.caregiverId).get();
        const caregiverStripeAccountId = (_a = caregiverSnap.data()) === null || _a === void 0 ? void 0 : _a.stripeAccountId;
        if (!caregiverStripeAccountId) {
            throw new Error('Caregiver has no Stripe Connect account');
        }
        const customerSnap = await db.collection('customers').doc(shift.clientId).get();
        const stripeCustomerId = (_b = customerSnap.data()) === null || _b === void 0 ? void 0 : _b.stripeCustomerId;
        if (!stripeCustomerId) {
            throw new Error('Client has no Stripe customer');
        }
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        const defaultPm = ((_c = customer.invoice_settings) === null || _c === void 0 ? void 0 : _c.default_payment_method)
            || customer.default_source;
        if (!defaultPm) {
            throw new Error('Client has no default payment method');
        }
        const grossCents = Math.round((shift.grossPay || 0) * 100);
        if (grossCents <= 0) {
            throw new Error('grossPay not set');
        }
        const feeCents = Math.max(Math.round(grossCents * PLATFORM_FEE_RATE), Math.round(PLATFORM_FEE_MIN * 100));
        const totalChargeCents = grossCents + feeCents;
        let paymentIntentId = shift.stripeChargeId;
        if (!paymentIntentId) {
            const intent = await stripe.paymentIntents.create({
                amount: totalChargeCents,
                currency: shift.currency || 'usd',
                customer: stripeCustomerId,
                payment_method: typeof defaultPm === 'string' ? defaultPm : defaultPm.id,
                confirm: true,
                off_session: true,
                description: `CareConnex shift ${appointmentId}`,
                metadata: { appointmentId, shiftHoursId: appointmentId },
            }, {
                // Idempotency-keyed by appointmentId so re-firing the Firestore
                // trigger never creates a second charge for the same shift.
                idempotencyKey: `shift-charge-${appointmentId}`,
            });
            paymentIntentId = intent.id;
        }
        let transferId = shift.stripeTransferId;
        if (!transferId) {
            const transfer = await stripe.transfers.create({
                amount: grossCents,
                currency: shift.currency || 'usd',
                destination: caregiverStripeAccountId,
                transfer_group: appointmentId,
                metadata: { appointmentId, shiftHoursId: appointmentId },
            }, {
                idempotencyKey: `shift-transfer-${appointmentId}`,
            });
            transferId = transfer.id;
        }
        // Sync the appointment's paymentStatus so the EarningsPanel and other
        // appointment-driven UIs reflect what really happened.
        const apptRef = db.collection('appointments').doc(appointmentId);
        const apptSnap = await apptRef.get();
        if (apptSnap.exists) {
            await apptRef.update({
                paymentStatus: 'pending', // pending payout — money is in Connect balance, not yet to bank
                chargedAt: now,
                stripeChargeId: paymentIntentId,
            });
        }
        await ref.update({
            status: 'paid',
            stripeChargeId: paymentIntentId,
            stripeTransferId: transferId,
            paymentAttemptCount: attempt,
            lastPaymentAttemptAt: now,
            updatedAt: now,
        });
        await pushNotification(shift.caregiverId, 'shift_hours_paid', 'Payment sent', `$${(grossCents / 100).toFixed(2)} is on its way.`, { appointmentId });
        return { ok: true };
    }
    catch (err) {
        const errorMessage = (err === null || err === void 0 ? void 0 : err.message) || 'Stripe error';
        const updates = {
            status: 'payment_failed',
            stripeFailureReason: errorMessage,
            paymentAttemptCount: attempt,
            lastPaymentAttemptAt: now,
            updatedAt: now,
        };
        await ref.update(updates);
        if (attempt >= MAX_PAYMENT_ATTEMPTS) {
            await notifyAdmins('shift_hours_payment_failed_escalated', 'Shift payment failed after retries', `Appointment ${appointmentId}: ${errorMessage}`, { appointmentId, attempt });
        }
        return { ok: false, error: errorMessage };
    }
}
/**
 * Caregiver confirms they received cash payment for an approved cash shift.
 * Moves status from approved/auto_approved → paid and notifies both parties.
 */
exports.confirmCashReceived = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
    }
    const { appointmentId } = data;
    if (!appointmentId) {
        throw new functions.https.HttpsError('invalid-argument', 'appointmentId is required');
    }
    const ref = db.collection('shiftHours').doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Shift hours record not found');
    }
    const shift = snap.data();
    if (shift.caregiverId !== context.auth.uid) {
        throw new functions.https.HttpsError('permission-denied', 'Only the caregiver can confirm cash receipt');
    }
    if (shift.paymentMethod !== 'cash') {
        throw new functions.https.HttpsError('failed-precondition', 'Shift is not a cash payment');
    }
    if (shift.status !== 'approved' && shift.status !== 'auto_approved') {
        throw new functions.https.HttpsError('failed-precondition', `Shift must be approved to confirm — current status: ${shift.status}`);
    }
    const now = nowIso();
    await ref.update({
        status: 'paid',
        paidMethod: 'cash',
        paidAt: now,
        cashConfirmedAt: now,
        updatedAt: now,
    });
    await pushNotification(shift.caregiverId, 'shift_hours_paid', 'Cash payment confirmed', `${shift.finalTotalHours}h · $${(shift.grossPay || 0).toFixed(2)} marked as received.`, { appointmentId });
    await pushNotification(shift.clientId, 'shift_hours_paid', 'Hours settled', `${shift.caregiverName}'s ${shift.finalTotalHours}h cash shift is confirmed paid.`, { appointmentId });
    return { success: true };
});
/**
 * Approve shift hours on behalf of the client via iMessage reply.
 */
async function approveShiftHoursForClient(appointmentId) {
    const snap = await db.collection("shiftHours")
        .where("appointmentId", "==", appointmentId)
        .where("status", "==", "pending_client_review")
        .limit(1)
        .get();
    if (snap.empty)
        return;
    await snap.docs[0].ref.update({
        status: "approved",
        approvedAt: new Date().toISOString(),
        approvedBy: "client_imessage",
        updatedAt: new Date().toISOString(),
    });
}
//# sourceMappingURL=shiftHours.js.map