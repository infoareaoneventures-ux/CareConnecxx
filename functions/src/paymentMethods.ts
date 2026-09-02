import * as functions from "firebase-functions/v1";
import * as admin from 'firebase-admin';

const db = admin.firestore();

// updateBookingPaymentMethod (switch a booking between credit/cash/venmo/
// zelle) was removed along with cash itself (Hamse, 2026-08-23) — there's
// nothing left to switch to, every booking is charged by card.

/**
 * One-shot admin migration: collapse every legacy/non-credit payment-method
 * value — 'cash', 'venmo', 'zelle' (removed platform-wide 2026-08-23),
 * plus older 'digital'|'either' — onto 'credit', across job_posts,
 * appointments, and shiftHours.
 *
 * shiftHours was missed by the original 2026-08-23 removal (found 2026-08-31
 * during a full leftover-reference audit) — any pre-removal shiftHours doc
 * with a non-credit paymentMethod is what still drives the "Confirm Cash" /
 * "Paid directly" branches in ClientDashboard.tsx and
 * CaregiverHomeDashboard.tsx, describing a caregiver-confirms-cash step whose
 * backing tool no longer exists. Running this closes that gap for good.
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
  let shiftHoursBackfilled = 0;

  const jobPostsSnap = await db.collection('job_posts').get();
  const jobBatches: FirebaseFirestore.WriteBatch[] = [db.batch()];
  jobPostsSnap.forEach(doc => {
    const pm = doc.data().paymentMethod;
    if (pm !== 'credit') {
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
    if (pm !== 'credit') {
      const batch = apptBatches[apptBatches.length - 1];
      batch.update(doc.ref, { paymentMethod: 'credit' });
      appointmentsBackfilled++;
      if (appointmentsBackfilled % 400 === 0) apptBatches.push(db.batch());
    }
  });
  for (const b of apptBatches) await b.commit();

  const shiftHoursSnap = await db.collection('shiftHours').get();
  const shiftHoursBatches: FirebaseFirestore.WriteBatch[] = [db.batch()];
  shiftHoursSnap.forEach(doc => {
    const pm = doc.data().paymentMethod;
    if (pm !== 'credit') {
      const batch = shiftHoursBatches[shiftHoursBatches.length - 1];
      batch.update(doc.ref, { paymentMethod: 'credit' });
      shiftHoursBackfilled++;
      if (shiftHoursBackfilled % 400 === 0) shiftHoursBatches.push(db.batch());
    }
  });
  for (const b of shiftHoursBatches) await b.commit();

  return { success: true, jobPostsUpdated, appointmentsBackfilled, shiftHoursBackfilled };
});
