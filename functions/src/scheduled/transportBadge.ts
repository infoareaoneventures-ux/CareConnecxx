import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const db = admin.firestore();

function isExpired(expirationDate?: string): boolean {
  if (!expirationDate) return false;
  return new Date(expirationDate) < new Date();
}

function isExpiringSoon(expirationDate?: string, daysAhead = 30): boolean {
  if (!expirationDate) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);
  return new Date(expirationDate) < cutoff;
}

/**
 * Daily job: re-evaluate transportation badges for all caregivers who offer Transportation.
 * Badge requires: admin-approved account + all three transport docs approved + none expired.
 * Strips badge if any doc expires. Notifies caregiver when docs are expiring soon.
 */
export const evaluateTransportBadges = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async () => {
    const snap = await db.collection('caregivers')
      .where('verified', '==', true)
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    const notifications: Promise<any>[] = [];

    for (const doc of snap.docs) {
      const data = doc.data();
      const services: string[] = data.services || data.skills || [];

      if (!services.includes('Transportation')) {
        // Not a transport caregiver — strip badge if they somehow have it
        if (data.transportationBadge === true) {
          batch.update(doc.ref, { transportationBadge: false });
        }
        continue;
      }

      const docs = data.documents || {};
      const license = docs.driversLicense;
      const insurance = docs.insurance;
      const registration = docs.registration;

      const allApproved =
        license?.status === 'approved' &&
        insurance?.status === 'approved' &&
        registration?.status === 'approved';

      const anyExpired =
        isExpired(license?.expirationDate) ||
        isExpired(insurance?.expirationDate) ||
        isExpired(registration?.expirationDate);

      const shouldHaveBadge = allApproved && !anyExpired;

      if (shouldHaveBadge !== (data.transportationBadge === true)) {
        batch.update(doc.ref, { transportationBadge: shouldHaveBadge });

        if (!shouldHaveBadge && data.transportationBadge === true) {
          // Badge just revoked — notify caregiver
          notifications.push(
            db.collection('users').doc(doc.id).collection('notifications').add({
              title: 'Transportation badge removed',
              body: 'One or more of your transportation documents has expired. Upload updated documents to restore your badge.',
              type: 'system',
              isRead: false,
              createdAt: new Date().toISOString(),
            })
          );
        }
      }

      // Warn about docs expiring within 30 days
      const expiringSoon: string[] = [];
      if (isExpiringSoon(license?.expirationDate) && !isExpired(license?.expirationDate)) expiringSoon.push("Driver's License");
      if (isExpiringSoon(insurance?.expirationDate) && !isExpired(insurance?.expirationDate)) expiringSoon.push('Vehicle Insurance');
      if (isExpiringSoon(registration?.expirationDate) && !isExpired(registration?.expirationDate)) expiringSoon.push('Vehicle Registration');

      if (expiringSoon.length > 0) {
        const lastWarnedAt: string | undefined = data.transportDocWarnedAt;
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        if (!lastWarnedAt || lastWarnedAt < oneDayAgo) {
          batch.update(doc.ref, { transportDocWarnedAt: new Date().toISOString() });
          notifications.push(
            db.collection('users').doc(doc.id).collection('notifications').add({
              title: 'Document expiring soon',
              body: `${expiringSoon.join(', ')} will expire within 30 days. Upload a renewal to keep your transportation badge active.`,
              type: 'system',
              isRead: false,
              createdAt: new Date().toISOString(),
            })
          );
        }
      }
    }

    await batch.commit();
    await Promise.allSettled(notifications);
    console.log(`evaluateTransportBadges: processed ${snap.docs.length} verified caregivers`);
  });

/**
 * Callable trigger: re-evaluate a single caregiver's transport badge immediately.
 * Used by admin panel after approving/rejecting a transport doc.
 */
export const refreshTransportBadge = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');

  const targetUid: string = data?.uid || context.auth.uid;

  const snap = await db.collection('caregivers').doc(targetUid).get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Caregiver not found');

  const caregiverData = snap.data() || {};
  const services: string[] = caregiverData.services || caregiverData.skills || [];

  if (!services.includes('Transportation') || !caregiverData.verified) {
    await snap.ref.update({ transportationBadge: false });
    return { badge: false };
  }

  const docs = caregiverData.documents || {};
  const allApproved =
    docs.driversLicense?.status === 'approved' &&
    docs.insurance?.status === 'approved' &&
    docs.registration?.status === 'approved';

  const anyExpired =
    isExpired(docs.driversLicense?.expirationDate) ||
    isExpired(docs.insurance?.expirationDate) ||
    isExpired(docs.registration?.expirationDate);

  const badge = allApproved && !anyExpired;
  await snap.ref.update({ transportationBadge: badge });
  return { badge };
});
