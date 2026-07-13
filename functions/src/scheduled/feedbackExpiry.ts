import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

export const expirePostVisitFeedback = functions.pubsub
  .schedule("0 3 * * *")   // 3am UTC daily
  .timeZone("UTC")
  .onRun(async () => {
    const now = new Date().toISOString();

    const snap = await db.collection("proactive_triggers")
      .where("type",         "==", "post_visit_feedback")
      .where("expiresAt",    "<=", now)
      .where("cancelledAt",  "==", null)
      .limit(500)
      .get();

    if (snap.empty) return;

    const stale = snap.docs.filter(doc => doc.data().feedbackReceived == null);

    if (stale.length === 0) return;

    const batch = db.batch();
    for (const doc of stale) {
      batch.update(doc.ref, {
        cancelledAt: now,
        feedbackReceived: now,
        feedbackStatus: "expired",
      });
    }
    await batch.commit();

    console.log(`[expirePostVisitFeedback] Expired ${stale.length} stale feedback triggers`);
  });
