import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * One-time migration: converts old-style senior_profiles (where doc ID === client UID)
 * to the new multi-senior model (auto-generated ID + clientId back-reference).
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 *
 * Safe to re-run — already-migrated docs are skipped.
 */
export const migrateSeniorsToHousehold = functions.https.onRequest(async (req, res) => {
  // Protect: require admin secret header
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const results = { migrated: 0, skipped: 0, errors: [] as string[] };
  const seniorSnap = await db.collection("senior_profiles").get();

  for (const seniorDoc of seniorSnap.docs) {
    const seniorId = seniorDoc.id;
    const data = seniorDoc.data();

    // Already migrated: has a clientId field that differs from its own doc ID
    if (data.clientId && data.clientId !== seniorId) {
      results.skipped++;
      continue;
    }

    // Only migrate docs whose ID matches a real client user
    const userDoc = await db.collection("users").doc(seniorId).get();
    if (!userDoc.exists || userDoc.data()?.userType !== "client") {
      results.skipped++;
      continue;
    }

    try {
      // Create new senior_profiles doc with auto-generated ID
      const newSeniorRef = db.collection("senior_profiles").doc();
      const newSeniorId = newSeniorRef.id;

      await db.runTransaction(async (tx) => {
        // Create new senior doc with clientId back-reference
        tx.set(newSeniorRef, {
          ...data,
          clientId: seniorId,
          migratedFrom: seniorId,
        });
        // Update user doc with seniorIds array
        tx.update(db.collection("users").doc(seniorId), {
          seniorIds: admin.firestore.FieldValue.arrayUnion(newSeniorId),
        });
        // Mark old doc as migrated (kept as backup — do not delete)
        tx.update(seniorDoc.ref, { migratedTo: newSeniorId });
      });

      results.migrated++;
    } catch (err) {
      results.errors.push(`${seniorId}: ${String(err)}`);
    }
  }

  res.json(results);
});
