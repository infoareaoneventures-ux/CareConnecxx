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
 * Badge requires: admin-approved account + all three transport docs approved + none expired
 * + the driving record (MVR) cleared (isApprovedDriver).
 * Strips badge if any doc expires. Notifies caregiver when docs are expiring soon.
 */
export const evaluateTransportBadges = functions.pubsub
  // 00:05 Pacific (founder, 2026-10-05): a document expires at midnight local time —
  // families should stop seeing Transportation that night, not up to 24h later.
  .schedule('5 0 * * *')
  .timeZone('America/Los_Angeles')
  .onRun(async () => {
    // Daily heartbeat for config/public (Evia's number from the functions env) — see publicConfig.ts.
    await import('../publicConfig').then((m) => m.publishPublicConfig()).catch((err) => console.warn('publishPublicConfig failed:', err));
    const snap = await db.collection('caregivers')
      .where('verified', '==', true)
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    const notifications: Promise<unknown>[] = [];

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

      // Badge = documents approved AND the driving record (MVR) cleared
      // (founder, 2026-09-25: admin approves the documents after both checks
      // are back; neither alone earns the badge).
      const shouldHaveBadge = allApproved && !anyExpired && data.isApprovedDriver === true;

      // Badge earned / lost is announced by onCaregiverAccountChange (bell +
      // text, once) from the live rule; this stored flag is only the projection.
      if (shouldHaveBadge !== (data.transportationBadge === true)) {
        batch.update(doc.ref, { transportationBadge: shouldHaveBadge });
      }

      // Renewal reminders (founder, 2026-10-05): at 30 days and again at 7 days, ONE
      // bell + text per window per expiry date (idempotent on the dates). A document
      // with a renewal already waiting for review is not nagged. The expiry itself is
      // announced by transport_badge_lost (expired) when the badge flips.
      const docsByLabel: Array<[string, any]> = [["Driver's License", license], ['Vehicle Insurance', insurance], ['Vehicle Registration', registration]];
      const needsRenewal = (d: any) => d?.status === 'approved' && !isExpired(d?.expirationDate) && d?.renewal?.status !== 'pending';
      const within = (d: any, days: number) => isExpiringSoon(d?.expirationDate, days) && !isExpired(d?.expirationDate);
      const window7  = docsByLabel.filter(([, d]) => needsRenewal(d) && within(d, 7));
      const window30 = docsByLabel.filter(([, d]) => needsRenewal(d) && within(d, 30) && !within(d, 7));
      // The "already sent" key names only the documents in THAT window with their own
      // dates — renewing one document never re-sends another document's reminder
      // (founder, 2026-10-05); a renewed document's new date starts its own cycle.
      const windowKey = (entries: Array<[string, any]>) => entries.map(([l, d]) => `${l}=${d?.expirationDate ?? ''}`).sort().join('|');
      for (const [entries, days] of [[window30, 30], [window7, 7]] as Array<[Array<[string, any]>, number]>) {
        if (!entries.length) continue;
        const labels = entries.map(([l]) => l);
        notifications.push(
          import('../notifications/caregiverAccountEvents').then(({ notifyCaregiverAccountEvent }) =>
            notifyCaregiverAccountEvent(doc.id, 'transport_doc_expiring', { eventId: `docs_expiring_${days}:${windowKey(entries)}`, ctx: { docs: labels, window: days } }),
          ).catch((err) => console.error('transport_doc_expiring notice failed for', doc.id, err)),
        );
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

  const targetUid = data?.uid || context.auth.uid;
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

  const badge = allApproved && !anyExpired && caregiverData.isApprovedDriver === true;
  await snap.ref.update({ transportationBadge: badge });
  return { badge };
});
