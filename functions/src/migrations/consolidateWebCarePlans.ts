import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * One-time migration: merge web-entered care-plan data stranded on the LEGACY
 * web path `senior_profiles/{uid}/care_plans/default` into the CANONICAL live
 * plan `care_plans/{clientId}` (web cutover 2026-07-12 — the web now reads and
 * writes the canonical doc, same as Evia's get/update_care_plan tools).
 *
 * Merge semantics (ADDITIVE ONLY — never deletes, never overwrites scalars):
 *   - medications:        union, deduped by lowercased name (string entries use
 *                         the whole string as the name)
 *   - emergencyContacts:  union, deduped by digits-only phone, falling back to
 *                         lowercased name
 *   - dailyRoutine:       union, deduped by time+description
 *   - accessCodes / dietaryRestrictions: copied only when the canonical doc
 *                         lacks the field
 * The legacy subdoc is left in place untouched (grace window — the web keeps a
 * read-only fallback to it until this migration has run).
 *
 * DRY-RUN BY DEFAULT. Pass `?apply=true` to perform writes.
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>.
 * Idempotent: the union-dedup keys make re-runs no-ops.
 */
export const consolidateWebCarePlans = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const apply = req.query.apply === "true";

  const results = {
    mode:               apply ? "APPLY" : "DRY_RUN",
    scannedSeniors:     0,
    legacyDocsFound:    0,
    plansMerged:        0,   // canonical doc updated (or would be, in dry-run)
    plansAlreadyClean:  0,   // legacy data already present on canonical — no-op
    fieldsMerged:       {} as Record<string, number>,
    errors:             [] as string[],
  };

  const medKey     = (m: unknown) => (typeof m === "string" ? m : String((m as Record<string, unknown>)?.name ?? JSON.stringify(m))).trim().toLowerCase();
  const contactKey = (c: unknown) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const phone = String(o.phone ?? "").replace(/\D/g, "");
    return phone || String(o.name ?? (typeof c === "string" ? c : JSON.stringify(c))).trim().toLowerCase();
  };
  const taskKey    = (t: unknown) => {
    const o = (t ?? {}) as Record<string, unknown>;
    return typeof t === "string" ? t.trim().toLowerCase() : `${o.time ?? ""}|${String(o.description ?? "").trim().toLowerCase()}`;
  };

  const seniorSnap = await db.collection("senior_profiles").get();

  for (const seniorDoc of seniorSnap.docs) {
    results.scannedSeniors++;
    const seniorId   = seniorDoc.id;
    const seniorData = seniorDoc.data();

    try {
      const legacySnap = await seniorDoc.ref.collection("care_plans").doc("default").get();
      if (!legacySnap.exists) continue;
      const legacy = legacySnap.data() ?? {};
      const hasContent =
        (Array.isArray(legacy.medications)       && legacy.medications.length > 0) ||
        (Array.isArray(legacy.emergencyContacts) && legacy.emergencyContacts.length > 0) ||
        (Array.isArray(legacy.dailyRoutine)      && legacy.dailyRoutine.length > 0) ||
        !!legacy.accessCodes || !!legacy.dietaryRestrictions;
      if (!hasContent) continue;
      results.legacyDocsFound++;

      // Same clientId resolution as migrateCarePlansToCanonical: household
      // seniors carry a clientId/userId back-ref; legacy docs are uid-keyed.
      const clientId = (seniorData.clientId as string | undefined)
        ?? (seniorData.userId as string | undefined)
        ?? seniorId;

      const canonicalRef  = db.collection("care_plans").doc(clientId);
      const canonicalSnap = await canonicalRef.get();
      const canonical     = canonicalSnap.exists ? (canonicalSnap.data() ?? {}) : {};

      const patch: Record<string, unknown> = {};

      const mergeArray = (field: string, keyFn: (v: unknown) => string) => {
        const legacyArr = Array.isArray(legacy[field]) ? (legacy[field] as unknown[]) : [];
        if (!legacyArr.length) return;
        const canonArr  = Array.isArray(canonical[field]) ? (canonical[field] as unknown[]) : [];
        const seen      = new Set(canonArr.map(keyFn));
        const additions = legacyArr.filter((item) => !seen.has(keyFn(item)));
        if (additions.length) {
          patch[field] = [...canonArr, ...additions];
          results.fieldsMerged[field] = (results.fieldsMerged[field] ?? 0) + additions.length;
        }
      };
      mergeArray("medications",       medKey);
      mergeArray("emergencyContacts", contactKey);
      mergeArray("dailyRoutine",      taskKey);
      for (const scalar of ["accessCodes", "dietaryRestrictions"] as const) {
        if (legacy[scalar] && !canonical[scalar]) {
          patch[scalar] = legacy[scalar];
          results.fieldsMerged[scalar] = (results.fieldsMerged[scalar] ?? 0) + 1;
        }
      }

      if (Object.keys(patch).length === 0) {
        results.plansAlreadyClean++;
        continue;
      }

      if (apply) {
        await canonicalRef.set({
          ...patch,
          lastUpdatedBy:          "migration:consolidateWebCarePlans",
          webDefaultsMigratedAt:  new Date().toISOString(),
          webDefaultsMigratedFrom: `senior_profiles/${seniorId}/care_plans/default`,
        }, { merge: true });
      }
      results.plansMerged++;
    } catch (err) {
      results.errors.push(`${seniorId}: ${String(err)}`);
    }
  }

  res.json(results);
});
