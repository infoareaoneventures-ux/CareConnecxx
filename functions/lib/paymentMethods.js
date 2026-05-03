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
Object.defineProperty(exports, "__esModule", { value: true });
exports.migratePaymentMethods = exports.updateBookingPaymentMethod = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * Client switches the payment method on a confirmed, not-yet-started booking.
 * Guards: must be the booking's client; appointment must be in 'confirmed' status
 * AND not yet started.
 */
exports.updateBookingPaymentMethod = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    const { appointmentId, paymentMethod } = data;
    if (!appointmentId || (paymentMethod !== 'cash' && paymentMethod !== 'credit')) {
        throw new functions.https.HttpsError('invalid-argument', 'appointmentId and paymentMethod (cash|credit) required');
    }
    const ref = db.collection('appointments').doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Appointment not found');
    }
    const appt = snap.data();
    if (appt.clientId !== context.auth.uid) {
        throw new functions.https.HttpsError('permission-denied', 'Not your booking');
    }
    if (appt.status !== 'confirmed') {
        throw new functions.https.HttpsError('failed-precondition', 'Can only change payment before the booking starts');
    }
    const startIso = appt.isoDate || appt.date;
    if (startIso && new Date(startIso).getTime() <= Date.now()) {
        throw new functions.https.HttpsError('failed-precondition', 'Booking has already started');
    }
    await ref.update({
        paymentMethod,
        updatedAt: new Date().toISOString(),
    });
    return { success: true };
});
/**
 * One-shot admin migration: collapse legacy JobPaymentMethod ('digital'|'either')
 * to the new 'cash'|'credit' enum, and backfill Appointment.paymentMethod.
 */
exports.migratePaymentMethods = functions.https.onCall(async (_data, context) => {
    var _a;
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || ((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.userType) !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    let jobPostsUpdated = 0;
    let appointmentsBackfilled = 0;
    const jobPostsSnap = await db.collection('job_posts').get();
    const jobBatches = [db.batch()];
    jobPostsSnap.forEach(doc => {
        const pm = doc.data().paymentMethod;
        if (pm === 'digital' || pm === 'either') {
            const batch = jobBatches[jobBatches.length - 1];
            batch.update(doc.ref, { paymentMethod: 'credit' });
            jobPostsUpdated++;
            if (jobPostsUpdated % 400 === 0)
                jobBatches.push(db.batch());
        }
    });
    for (const b of jobBatches)
        await b.commit();
    const apptSnap = await db.collection('appointments').get();
    const apptBatches = [db.batch()];
    apptSnap.forEach(doc => {
        const pm = doc.data().paymentMethod;
        if (pm !== 'cash' && pm !== 'credit') {
            const batch = apptBatches[apptBatches.length - 1];
            batch.update(doc.ref, { paymentMethod: 'credit' });
            appointmentsBackfilled++;
            if (appointmentsBackfilled % 400 === 0)
                apptBatches.push(db.batch());
        }
    });
    for (const b of apptBatches)
        await b.commit();
    return { success: true, jobPostsUpdated, appointmentsBackfilled };
});
//# sourceMappingURL=paymentMethods.js.map