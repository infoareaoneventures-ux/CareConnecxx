import * as functions from "firebase-functions/v1";
import * as admin from 'firebase-admin';

const db = admin.firestore();

// Transportation live = offered on the profile + driving record (MVR) cleared.
// Founder, 2026-10-06: the MVR through Checkr is the ONLY check — the three
// transport documents, their admin review, expiry tracking and renewal reminders
// were removed. The stored `transportationBadge` flag is a projection of the live
// rule (utils/transportDocs.ts hasValidTransportDocs); announcements come from
// onCaregiverAccountChange, not from here.
function transportationLive(data: Record<string, any>): boolean {
  const services: string[] = data.services || data.skills || [];
  return services.includes('Transportation') && data.isApprovedDriver === true;
}

/** Daily (00:05 Pacific) — keeps every caregiver's stored flag in step with the rule; also the config/public heartbeat. */
export const evaluateTransportBadges = functions.pubsub
  .schedule('5 0 * * *')
  .timeZone('America/Los_Angeles')
  .onRun(async () => {
    // Daily heartbeat for config/public (Evia's number from the functions env) — see publicConfig.ts.
    await import('../publicConfig').then((m) => m.publishPublicConfig()).catch((err) => console.warn('publishPublicConfig failed:', err));

    // Public copies: re-project any caregiver still on an older projection version (2026-10-06).
    await import('../caregiverPublicProjection').then((m) => m.healStaleProjections()).catch((err) => console.warn('healStaleProjections failed:', err));

    const snap = await db.collection('caregivers').where('verified', '==', true).get();
    if (snap.empty) return;
    const batch = db.batch();
    let writes = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const shouldHaveBadge = transportationLive(data);
      if (shouldHaveBadge !== (data.transportationBadge === true)) {
        batch.update(doc.ref, { transportationBadge: shouldHaveBadge });
        writes++;
      }
    }
    if (writes) await batch.commit();
  });

/** Callable: re-evaluate one caregiver's flag now (the admin's driving-record buttons call it). */
export const refreshTransportBadge = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  const targetUid = data?.uid || context.auth.uid;
  const snap = await db.collection('caregivers').doc(targetUid).get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Caregiver not found');
  const caregiverData = snap.data() || {};
  const badge = caregiverData.verified === true && transportationLive(caregiverData);
  await snap.ref.update({ transportationBadge: badge });
  return { badge };
});
