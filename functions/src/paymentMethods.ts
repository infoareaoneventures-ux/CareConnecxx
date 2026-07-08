import * as functions from "firebase-functions/v1";
import * as admin from 'firebase-admin';
import { OFFLINE_PAYMENT_METHODS } from './billing/paymentMethods';

const db = admin.firestore();

const VALID_PAYMENT_METHODS = ['credit', ...OFFLINE_PAYMENT_METHODS];

/**
 * Client switches the payment method on a confirmed, not-yet-started booking.
 * Guards: must be the booking's client; appointment must be in 'confirmed' status
 * AND not yet started.
 */
export const updateBookingPaymentMethod = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { appointmentId, paymentMethod } = data;
  if (!appointmentId || !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    throw new functions.https.HttpsError('invalid-argument', `appointmentId and paymentMethod (${VALID_PAYMENT_METHODS.join('|')}) required`);
  }

  const ref = db.collection('appointments').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Appointment not found');
  }
  const appt = snap.data()!;

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
export const migratePaymentMethods = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }
  const userDoc = await db.collection('users').doc(context.auth.uid).get();
  if (!userDoc.exists || userDoc.data()?.userType !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  let jobPostsUpdated = 0;
  let appointmentsBackfilled = 0;

  const jobPostsSnap = await db.collection('job_posts').get();
  const jobBatches: FirebaseFirestore.WriteBatch[] = [db.batch()];
  jobPostsSnap.forEach(doc => {
    const pm = doc.data().paymentMethod;
    if (pm === 'digital' || pm === 'either') {
      const batch = jobBatches[jobBatches.length - 1];
      batch.update(doc.ref, { paymentMethod: 'credit' });
      jobPostsUpdated++;
      if (jobPostsUpdated % 400 === 0) jobBatches.push(db.batch());
    }
  });
  for (const b of jobBatches) await b.commit();

  const apptSnap = await db.collection('appointments').get();
  const apptBatches: FirebaseFirestore.WriteBatch[] = [db.batch()];
  apptSnap.forEach(doc => {
    const pm = doc.data().paymentMethod;
    if (pm !== 'cash' && pm !== 'credit') {
      const batch = apptBatches[apptBatches.length - 1];
      batch.update(doc.ref, { paymentMethod: 'credit' });
      appointmentsBackfilled++;
      if (appointmentsBackfilled % 400 === 0) apptBatches.push(db.batch());
    }
  });
  for (const b of apptBatches) await b.commit();

  return { success: true, jobPostsUpdated, appointmentsBackfilled };
});
