/**
 * One-time migration: re-key senior_profiles from clientUID doc IDs
 * to auto-generated IDs with an explicit clientId back-reference.
 *
 * Run with:  node scripts/runMigration.js
 */

const admin = require("firebase-admin");

// Use the Firebase CLI's application default credentials (already logged in)
admin.initializeApp({ projectId: "careconnex-d4c8b" });
const db = admin.firestore();

async function migrate() {
  const results = { migrated: 0, skipped: 0, errors: [] };

  console.log("Querying all senior_profiles...");
  const seniorSnap = await db.collection("senior_profiles").get();
  console.log(`Found ${seniorSnap.size} senior_profiles documents.\n`);

  for (const seniorDoc of seniorSnap.docs) {
    const seniorId = seniorDoc.id;
    const data = seniorDoc.data();

    // Already migrated: has a clientId field that differs from its own ID
    if (data.clientId && data.clientId !== seniorId) {
      console.log(`  SKIP (already migrated): ${seniorId}`);
      results.skipped++;
      continue;
    }

    // Check if this doc ID matches a client user
    const userDoc = await db.collection("users").doc(seniorId).get();
    if (!userDoc.exists || userDoc.data()?.userType !== "client") {
      console.log(`  SKIP (no matching client): ${seniorId}`);
      results.skipped++;
      continue;
    }

    const clientName = userDoc.data()?.name ?? "unknown";
    const seniorName = data.name ?? "unknown";

    try {
      const newSeniorRef = db.collection("senior_profiles").doc();
      const newSeniorId = newSeniorRef.id;

      await db.runTransaction(async (tx) => {
        tx.set(newSeniorRef, { ...data, clientId: seniorId, migratedFrom: seniorId });
        tx.update(db.collection("users").doc(seniorId), {
          seniorIds: admin.firestore.FieldValue.arrayUnion(newSeniorId),
        });
        tx.update(seniorDoc.ref, { migratedTo: newSeniorId });
      });

      console.log(`  ✓ MIGRATED: client=${clientName} (${seniorId}) → senior=${seniorName} (${newSeniorId})`);
      results.migrated++;
    } catch (err) {
      console.error(`  ✗ ERROR: ${seniorId}: ${err}`);
      results.errors.push(`${seniorId}: ${err}`);
    }
  }

  return results;
}

migrate()
  .then((results) => {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Migration complete.");
    console.log(`  Migrated : ${results.migrated}`);
    console.log(`  Skipped  : ${results.skipped}`);
    console.log(`  Errors   : ${results.errors.length}`);
    if (results.errors.length) {
      console.log("\nErrors:");
      results.errors.forEach((e) => console.log("  -", e));
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
