import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { toPublicProfile } from "./publicCaregiverProfile";

const db = admin.firestore();
const PROJECTION_VERSION = "2026-07-12-v1";

function projectionData(id: string, source: Record<string, unknown>): Record<string, unknown> {
  return {
    ...toPublicProfile(id, source),
    projectionVersion: PROJECTION_VERSION,
    projectedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

export const projectPublicCaregiverProfile = functions.firestore
  .document("caregivers/{caregiverId}")
  .onWrite(async (change, context) => {
    const target = db.collection("publicCaregiverProfiles").doc(context.params.caregiverId);
    if (!change.after.exists || change.after.data()?.profileVisibility === "hidden") {
      await target.delete().catch(() => undefined);
      return;
    }
    await target.set(projectionData(context.params.caregiverId, change.after.data() as Record<string, unknown>));
  });

export const backfillPublicCaregiverProfiles = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const apply = req.query.apply === "true";
  const result = {
    mode: apply ? "APPLY" : "DRY_RUN",
    scanned: 0,
    projected: 0,
    hidden: 0,
    missing: 0,
    stale: 0,
    errors: [] as string[],
  };

  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  do {
    let query = db.collection("caregivers").orderBy(admin.firestore.FieldPath.documentId()).limit(400);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    const batch = db.batch();
    let writes = 0;
    for (const sourceDoc of page.docs) {
      result.scanned++;
      try {
        const source = sourceDoc.data() as Record<string, unknown>;
        const target = db.collection("publicCaregiverProfiles").doc(sourceDoc.id);
        const existing = await target.get();
        if (source.profileVisibility === "hidden") {
          result.hidden++;
          if (apply && existing.exists) { batch.delete(target); writes++; }
          continue;
        }
        if (!existing.exists) result.missing++;
        else if (existing.data()?.projectionVersion !== PROJECTION_VERSION) result.stale++;
        if (apply) { batch.set(target, projectionData(sourceDoc.id, source)); writes++; }
        result.projected++;
      } catch (error) {
        result.errors.push(`${sourceDoc.id}: ${String(error)}`);
      }
    }
    if (apply && writes > 0) await batch.commit();
    cursor = page.docs.at(-1);
    if (page.size < 400) break;
  } while (cursor);
  res.json(result);
});
