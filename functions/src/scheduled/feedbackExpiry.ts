import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

export const expirePostVisitFeedback = functions.pubsub
  .schedule("0 3 * * *")   // 3am UTC daily
  .timeZone("UTC")
  .onRun(async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const now          = new Date().toISOString();

    const snap = await db.collection("proactive_triggers")
      .where("type",         "==", "custom")
      .where("firedAt",      "<=", sevenDaysAgo)
      .where("cancelledAt",  "==", null)
      .get();

    if (snap.empty) return;

    const stale = snap.docs.filter(doc =>
      (doc.data().message as string ?? "").startsWith("post_visit_feedback:")
    );

    if (stale.length === 0) return;

    const batch = db.batch();
    for (const doc of stale) {
      batch.update(doc.ref, { cancelledAt: now });
    }
    await batch.commit();

    console.log(`[expirePostVisitFeedback] Expired ${stale.length} stale feedback triggers`);
  });
