import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  CAREGIVER_PAYOUT_PRIVATE_FIELDS,
  pickPayoutPrivate,
} from "../caregiverPrivate";

const db = admin.firestore();

/**
 * Backfill for the caregiver payout-fields → private-subcollection migration
 * (2026-07-11 follow-up wave). stripeAccountId + the Connect gating booleans
 * lived on the world-readable caregivers/{id} parent; writers now dual-write
 * caregivers/{id}/private/payout and maintain a stripe_accounts/{accountId}
 * → { caregiverId } reverse map (the Connect webhooks look caregivers up by
 * accountId, which a subcollection can't serve via a collection query).
 *
 * TWO-PHASE by design:
 *   default        — copy parent payout fields → private/payout (merge) and
 *                    build the stripe_accounts map. NON-destructive; parent
 *                    stays the read-fallback. Safe to run immediately.
 *   ?deleteParent=1 — ALSO delete the payout fields from the parent doc.
 *                    Run ONLY after the reader cutover deploy is verified
 *                    (a live account.updated or checkStripeAccountStatus
 *                    round-trip) — every reader then resolves via
 *                    private/payout or the map.
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 * Dry-run with ?dryRun=1 (reports moves without writing). Idempotent.
 */
export const backfillCaregiverPayoutPrivate = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onRequest(async (req, res) => {
    const adminSecret = req.headers["x-admin-secret"];
    if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    const deleteParent = req.query.deleteParent === "1" || req.query.deleteParent === "true";
    const results = {
      dryRun,
      deleteParent,
      caregiversScanned: 0,
      caregiversCopied: 0,
      mapsWritten: 0,
      parentsCleaned: 0,
      caregiversSkipped: 0,
      errors: 0,
      perDoc: [] as Array<{ id: string; fields: string[]; mapped: boolean; parentCleaned: boolean }>,
    };

    const snap = await db.collection("caregivers").limit(1000).get();
    results.caregiversScanned = snap.size;

    for (const doc of snap.docs) {
      try {
        const parent = doc.data() as Record<string, unknown>;
        const payout = pickPayoutPrivate(parent);
        const fields = Object.keys(payout);
        if (fields.length === 0) {
          results.caregiversSkipped++;
          continue;
        }

        const accountId = typeof payout.stripeAccountId === "string" ? payout.stripeAccountId : "";
        results.caregiversCopied++;
        if (accountId) results.mapsWritten++;
        if (deleteParent) results.parentsCleaned++;
        results.perDoc.push({ id: doc.id, fields, mapped: !!accountId, parentCleaned: deleteParent });

        if (dryRun) continue;

        // 1. copy payout fields into private/payout (merge — never clobber)
        await doc.ref.collection("private").doc("payout").set(payout, { merge: true });

        // 2. reverse map for the webhook accountId → caregiver lookups
        if (accountId) {
          await db.collection("stripe_accounts").doc(accountId).set(
            { caregiverId: doc.id, updatedAt: new Date().toISOString() },
            { merge: true },
          );
        }

        // 3. optional destructive phase: strip the fields off the parent
        if (deleteParent) {
          const deletion: Record<string, unknown> = {};
          for (const f of CAREGIVER_PAYOUT_PRIVATE_FIELDS) {
            if (parent[f] !== undefined) deletion[f] = admin.firestore.FieldValue.delete();
          }
          await doc.ref.update(deletion);
        }
      } catch (err) {
        results.errors++;
        console.error(`[backfillCaregiverPayoutPrivate] ${doc.id} failed:`, err);
      }
    }

    res.status(200).json(results);
  });
