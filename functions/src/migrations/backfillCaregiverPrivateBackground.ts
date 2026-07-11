import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { CAREGIVER_PII_BACKGROUND_FIELDS, pickBackgroundPII } from "../caregiverPrivate";

const db = admin.firestore();

/**
 * One-shot backfill for the caregiver PII → private-subcollection migration
 * (2026-07-11). Identity PII (legal name, DOB, SSN-last-4, ZIP) used to sit in
 * the world-readable caregivers/{id}.backgroundCheckData; writers now route it
 * to caregivers/{id}/private/background. This moves the PII on EXISTING docs:
 *
 *   1. copy the PII subfields from parent backgroundCheckData → private/background
 *   2. delete those subfields from the parent backgroundCheckData (operational
 *      fields — status, checkrCandidateId, invitationStatus, … — are left intact)
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 * Dry-run with ?dryRun=1 to preview (reports which docs/fields would move,
 * WITHOUT logging the PII values themselves). Idempotent: a doc whose parent
 * carries no PII subfields is skipped, so it is safe to re-run.
 */
export const backfillCaregiverPrivateBackground = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onRequest(async (req, res) => {
    const adminSecret = req.headers["x-admin-secret"];
    if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    const results = {
      dryRun,
      caregiversScanned: 0,
      caregiversMigrated: 0,
      caregiversSkipped: 0,
      errors: 0,
      // field NAMES only — never the values (this is PII)
      perDoc: [] as Array<{ id: string; movedFields: string[] }>,
    };

    const snap = await db.collection("caregivers").limit(1000).get();
    results.caregiversScanned = snap.size;

    for (const doc of snap.docs) {
      try {
        const bg = (doc.data().backgroundCheckData ?? {}) as Record<string, unknown>;
        const pii = pickBackgroundPII(bg);
        const movedFields = Object.keys(pii);
        if (movedFields.length === 0) {
          results.caregiversSkipped++;
          continue;
        }

        results.caregiversMigrated++;
        results.perDoc.push({ id: doc.id, movedFields });

        if (dryRun) continue;

        // 1. copy PII into the private subcollection (merge — never clobber)
        await doc.ref.collection("private").doc("background").set(pii, { merge: true });

        // 2. delete the PII subfields from the parent backgroundCheckData
        const deletion: Record<string, unknown> = {};
        for (const f of CAREGIVER_PII_BACKGROUND_FIELDS) {
          if (bg[f] !== undefined) {
            deletion[`backgroundCheckData.${f}`] = admin.firestore.FieldValue.delete();
          }
        }
        await doc.ref.update(deletion);
      } catch (err) {
        results.errors++;
        console.error(`[backfillCaregiverPrivateBackground] ${doc.id} failed:`, err);
      }
    }

    res.status(200).json(results);
  });
