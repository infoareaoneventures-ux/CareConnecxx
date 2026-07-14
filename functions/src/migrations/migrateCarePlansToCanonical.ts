import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * One-time migration: consolidate care-plan data onto the canonical path
 * `care_plans/{clientId}` (+ its `versions` subcollection).
 *
 * Background (bug-audit 2026-07-06 §6.1): care plans were split across three
 * paths. The live read/write path (get_care_plan / update_care_plan) already
 * uses top-level `care_plans/{clientId}`, so live plans need NO movement. The
 * only data that can be stranded is what the OLD code wrote under
 * `senior_profiles/{seniorId}/…`:
 *   - `senior_profiles/{seniorId}/carePlanVersions/*` — old version snapshots
 *     (the old trigger listened on a path nothing wrote, so this is usually
 *     empty, but migrate any that exist).
 *   - `senior_profiles/{seniorId}/care_plans/active` — the old restore target
 *     (a doc nobody read). Only used to SEED `care_plans/{clientId}` if the
 *     canonical live plan doesn't exist yet.
 *
 * DRY-RUN BY DEFAULT. Pass `?apply=true` to perform writes.
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>.
 *
 * Idempotent:
 *   - version docs are copied preserving their doc id and skipped if the target
 *     already exists;
 *   - the live plan is seeded ONLY when `care_plans/{clientId}` is missing (an
 *     existing canonical live plan always wins and is never overwritten).
 * Safe to re-run.
 */
export const migrateCarePlansToCanonical = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const apply = req.query.apply === "true";

  const results = {
    mode:            apply ? "APPLY" : "DRY_RUN",
    scannedSeniors:  0,
    versionsMigrated: 0,   // would-migrate count in dry-run
    versionsSkipped:  0,   // target already existed (idempotent)
    livePlansSeeded:  0,   // canonical live plan seeded from old active doc
    livePlansPresent: 0,   // canonical live plan already existed → left as-is
    unresolvedClientId: [] as string[],
    errors:          [] as string[],
  };

  const seniorSnap = await db.collection("senior_profiles").get();

  for (const seniorDoc of seniorSnap.docs) {
    results.scannedSeniors++;
    const seniorId = seniorDoc.id;
    const seniorData = seniorDoc.data();

    try {
      const oldVersions = await seniorDoc.ref.collection("carePlanVersions").get();
      const oldActiveSnap = await seniorDoc.ref.collection("care_plans").doc("active").get();
      // Nothing stranded under this senior → skip quietly.
      if (oldVersions.empty && !oldActiveSnap.exists) continue;

      // Resolve the canonical key. Post-household-migration, senior_profiles docs
      // carry a `clientId` back-reference. Legacy self-keyed docs (id === client
      // uid) fall back to the doc id.
      const clientId = (seniorData.clientId as string | undefined) ?? seniorId;
      if (!clientId) {
        results.unresolvedClientId.push(seniorId);
        continue;
      }

      // ── Migrate version snapshots (preserve doc id → idempotent) ──────────
      for (const v of oldVersions.docs) {
        const targetRef = db.collection("care_plans").doc(clientId).collection("versions").doc(v.id);
        const targetSnap = await targetRef.get();
        if (targetSnap.exists) { results.versionsSkipped++; continue; }
        if (apply) await targetRef.set(v.data());
        results.versionsMigrated++;
      }

      // ── Seed the canonical live plan only if it's missing ────────────────
      if (oldActiveSnap.exists) {
        const canonicalRef = db.collection("care_plans").doc(clientId);
        const canonicalSnap = await canonicalRef.get();
        if (canonicalSnap.exists) {
          results.livePlansPresent++;   // live plan wins — never overwrite
        } else {
          const activeData = oldActiveSnap.data() ?? {};
          const plan = (activeData.carePlan ?? activeData) as Record<string, unknown>;
          if (apply) await canonicalRef.set({ ...plan, migratedFrom: `senior_profiles/${seniorId}/care_plans/active` });
          results.livePlansSeeded++;
        }
      }
    } catch (err) {
      results.errors.push(`${seniorId}: ${String(err)}`);
    }
  }

  res.json(results);
});
