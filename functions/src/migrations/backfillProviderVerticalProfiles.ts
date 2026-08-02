import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  CAREGIVER_VERTICAL_PROFILES_SUBCOLLECTION,
  CHILD_VERTICAL_PROFILE_DOC_ID,
  CHILDCARE_PROVIDER_SUMMARY_FIELD,
  CHILDCARE_REUSED_BASE_FIELDS,
} from "../childcare/providerEligibility";
import { assertNonProductionMigrationEnvironment } from "./nonProductionGuard";
import { writeMigrationReconciliationReport } from "./migrationReconciliation";

// U14 (childcare marketplace plan 2026-07-22-002): provider base/senior split
// REHEARSAL (KTD9/R24, AE21).
//
// Ensures every existing caregiver has a clean reusable-adult base profile with
// a namespaced `senior` vertical marker — WITHOUT creating any childcare
// (`child`) vertical profile and WITHOUT creating any approval. Childcare
// enrollment is OPT-IN (U5): a provider adds childcare later, and its data lands
// cleanly namespaced alongside the senior marker. This migration only proves the
// split is clean; it never overwrites senior services/rates/approval/reputation
// on the base doc (senior behavior stays byte-identical).
//
// Integrity assertion (the "clean split" check, R24): if childcare-namespaced
// fields have bled onto the base caregiver doc, the split is DIRTY — that
// caregiver is QUARANTINED (never projected) for manual review rather than
// papered over.
//
// Contract (mirrors backfillCareVertical.ts):
//   • Dry-run by DEFAULT — counts + quarantine only, no writes.
//   • Apply refused unless the hard non-production guard passes (no real
//     production caregiver is touched in this unit).
//   • Bounded batches + resume cursor (caregivers doc id).
//   • Idempotent — the senior marker uses a fixed subcollection doc id; a re-run
//     converges to zero new writes.
//   • Reconciliation counts (never child data). childProfilesCreated is an
//     INVARIANT that must stay 0 — the migration never creates a child profile.

export const PROVIDER_VERTICAL_BACKFILL_VERSION = "2026-07-24-v1";

/** The senior vertical marker doc id (sibling of the `child` vertical profile). */
export const SENIOR_VERTICAL_PROFILE_DOC_ID = "senior";

const PAGE_SIZE = 300;

/**
 * Childcare-namespaced fields that must NEVER appear directly on the base
 * caregiver doc (they belong on caregivers/{uid}/vertical_profiles/child, R24).
 * Presence = a dirty base/senior split → quarantine.
 */
const CHILDCARE_BLEED_FIELDS: readonly string[] = [
  "ageBands",
  "yearsChildcareExperience",
  "adultAgeAttested",
  "childcareHourlyRate",
  CHILDCARE_PROVIDER_SUMMARY_FIELD, // "childcareProvider"
];

export type ProviderVerticalQuarantineReason = "child-fields-on-base";

export interface ProviderVerticalQuarantineRecord {
  caregiverUid: string;
  reason: ProviderVerticalQuarantineReason;
  /** The bled field names (never values). */
  fields: string[];
}

export interface ProviderVerticalBackfillOptions {
  apply?: boolean;
  startAfterDocId?: string;
  maxDocs?: number;
  writeReport?: boolean;
  skipEnvironmentGuardForTest?: boolean;
}

export interface ProviderVerticalBackfillResult {
  mode: "DRY_RUN" | "APPLY";
  version: string;
  scannedCaregivers: number;
  /** senior vertical markers created this run. */
  seniorMarkersCreated: number;
  /** senior vertical markers already present (idempotent skips). */
  seniorMarkersAlreadyPresent: number;
  /** INVARIANT: must always be 0 — this migration never creates a child profile. */
  childProfilesCreated: number;
  quarantined: ProviderVerticalQuarantineRecord[];
  resumeCursor: string | null;
  reconciled: boolean;
  errors: string[];
}

type Db = FirebaseFirestore.Firestore;

function reusableBaseFieldsPresent(data: Record<string, unknown>): string[] {
  return CHILDCARE_REUSED_BASE_FIELDS.filter((field) => {
    const v = data[field];
    if (v === undefined || v === null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
}

/**
 * Core provider base/senior split rehearsal, injectable for tests.
 */
export async function runProviderVerticalProfileBackfill(
  db: Db,
  options: ProviderVerticalBackfillOptions = {},
): Promise<ProviderVerticalBackfillResult> {
  const apply = options.apply === true;
  if (apply && options.skipEnvironmentGuardForTest !== true) {
    assertNonProductionMigrationEnvironment("runProviderVerticalProfileBackfill (apply)");
  }

  const result: ProviderVerticalBackfillResult = {
    mode: apply ? "APPLY" : "DRY_RUN",
    version: PROVIDER_VERTICAL_BACKFILL_VERSION,
    scannedCaregivers: 0,
    seniorMarkersCreated: 0,
    seniorMarkersAlreadyPresent: 0,
    childProfilesCreated: 0, // never incremented — the invariant
    quarantined: [],
    resumeCursor: null,
    reconciled: false,
    errors: [],
  };

  let remaining = options.maxDocs ?? Number.POSITIVE_INFINITY;
  let cursorDocId = options.startAfterDocId;

  for (;;) {
    if (remaining <= 0) {
      result.resumeCursor = cursorDocId ?? "";
      break;
    }
    const pageLimit = Math.min(PAGE_SIZE, remaining);
    let query = db
      .collection("caregivers")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageLimit);
    if (cursorDocId) query = query.startAfter(cursorDocId);
    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      result.scannedCaregivers++;
      remaining--;
      try {
        const data = (doc.data() ?? {}) as Record<string, unknown>;

        // Integrity: no childcare-namespaced field may live on the base doc.
        const bled = CHILDCARE_BLEED_FIELDS.filter((f) => data[f] !== undefined);
        if (bled.length > 0) {
          result.quarantined.push({ caregiverUid: doc.id, reason: "child-fields-on-base", fields: bled });
          continue;
        }

        const seniorRef = db
          .collection("caregivers")
          .doc(doc.id)
          .collection(CAREGIVER_VERTICAL_PROFILES_SUBCOLLECTION)
          .doc(SENIOR_VERTICAL_PROFILE_DOC_ID);
        const seniorSnap = await seniorRef.get();
        if (seniorSnap.exists) {
          result.seniorMarkersAlreadyPresent++;
        } else {
          result.seniorMarkersCreated++;
          if (apply) {
            const ts = new Date().toISOString();
            await seniorRef.set(
              {
                careVertical: "senior",
                caregiverUid: doc.id,
                // Reuse manifest (AE21) — which base fields childcare enrollment
                // can reuse without re-asking. Field NAMES only, never values.
                reusableBaseFieldsPresent: reusableBaseFieldsPresent(data),
                baseSplitVersion: PROVIDER_VERTICAL_BACKFILL_VERSION,
                createdAt: ts,
                updatedAt: ts,
              },
              { merge: false },
            );
          }
        }

        // INVARIANT: never create a child vertical profile or approval here.
        // (Referenced so the doc id is used and the intent is explicit.)
        void CHILD_VERTICAL_PROFILE_DOC_ID;
      } catch (error) {
        result.errors.push(`caregivers/${doc.id}: ${String(error)}`);
      }
    }

    cursorDocId = page.docs[page.docs.length - 1].id;
    if (page.size < pageLimit) break;
  }

  result.reconciled =
    result.seniorMarkersCreated + result.seniorMarkersAlreadyPresent + result.quarantined.length ===
      result.scannedCaregivers && result.childProfilesCreated === 0;

  const writeReport = options.writeReport ?? apply;
  if (writeReport) {
    try {
      await writeMigrationReconciliationReport(db, {
        migration: "backfillProviderVerticalProfiles",
        version: PROVIDER_VERTICAL_BACKFILL_VERSION,
        mode: result.mode,
        old: result.scannedCaregivers,
        migrated: result.seniorMarkersCreated,
        provisional: 0,
        quarantined: result.quarantined.length,
        orphan: -1,
        unresolved: result.quarantined.length,
        reconciled: result.reconciled,
      });
    } catch (error) {
      result.errors.push(`reconciliation report write: ${String(error)}`);
    }
  }

  return result;
}

// Deployed HTTP wrapper — same auth/param shape as backfillCareVertical.
export const backfillProviderVerticalProfiles = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const apply = req.query.apply === "true";
  const startAfterDocId = typeof req.query.startAfterDoc === "string" ? req.query.startAfterDoc : undefined;
  const maxDocs =
    typeof req.query.maxDocs === "string" && Number.isFinite(Number(req.query.maxDocs))
      ? Number(req.query.maxDocs)
      : undefined;
  try {
    const result = await runProviderVerticalProfileBackfill(admin.firestore(), { apply, startAfterDocId, maxDocs });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: String(error) });
  }
});
