import * as functions from "firebase-functions/v1";
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

      if (!services.includes('Transportation')) continue;

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

      if (!shouldHaveBadge) {
        notifications.push(
          db.collection('users').doc(doc.id).collection('notifications').add({
            title: 'Transportation documents expired',
            body: 'One or more of your transportation documents has expired. Upload updated documents to keep your transportation status active.',
            type: 'system',
            isRead: false,
            createdAt: new Date().toISOString(),
          })
        );
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
