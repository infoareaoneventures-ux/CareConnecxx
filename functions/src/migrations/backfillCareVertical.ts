import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  CARE_VERTICAL_COLLECTIONS,
  CARE_VERTICAL_MIGRATION_CUTOFF,
  isCareVerticalCutoffSet,
} from "../data/contract";

// U0 (childcare marketplace plan 2026-07-22-002): careVertical backfill.
//
// Stamps careVertical:"senior" on every legacy record in the shared
// collections (data/contract.ts CARE_VERTICAL_COLLECTIONS). Contract:
//   • Idempotent — already-stamped records are counted and skipped; re-running
//     converges to zero changes.
//   • Bounded batches with a resume cursor ({collection, docId}) so a partial
//     run (timeout/crash) resumes exactly where it stopped.
//   • Dry-run by default — writes happen only with apply=true AND a real
//     migration cutoff (isCareVerticalCutoffSet()). While the cutoff is the
//     placeholder, apply mode is refused (fail closed).
//   • NEVER infers "child": a record is stamped "senior" only when it has no
//     careVertical at all and was created before the cutoff. Records with an
//     invalid careVertical value, or created at/after the cutoff without one,
//     go to the unresolved-record quarantine list (doc path + reason) and are
//     left untouched for manual review — silently resolving them to senior is
//     the exact failure mode the cutoff rule exists to prevent.
//   • Returns before/after counts per collection.
//
// Wired into functions/src/index.ts by U14 (migration rehearsal + staged
// deployment), alongside migrateHouseholds and backfillProviderVerticalProfiles.
// Apply mode still refuses until the real migration cutoff is set
// (isCareVerticalCutoffSet) AND the hard non-production guard passes.

export const CARE_VERTICAL_BACKFILL_VERSION = "2026-07-22-v1";

const PAGE_SIZE = 500;

export interface CareVerticalBackfillOptions {
  /** Write mode. Default false (dry run): counts + quarantine only, no writes. */
  apply?: boolean;
  /** Subset of CARE_VERTICAL_COLLECTIONS to process (default: all, in order). */
  collections?: string[];
  /** Resume cursor from a previous partial run. */
  startAfter?: { collection: string; docId: string };
  /** Stop after scanning this many docs and return a resume cursor. */
  maxDocs?: number;
  /** Test override for the migration cutoff (ISO). Defaults to the contract constant. */
  cutoffIso?: string;
}

export interface QuarantinedRecord {
  collection: string;
  docId: string;
  reason: "invalid-care-vertical" | "post-cutoff-missing-vertical";
  /** The invalid value, when reason is invalid-care-vertical. Never record contents. */
  value?: string;
}

export interface CareVerticalBackfillResult {
  mode: "DRY_RUN" | "APPLY";
  cutoff: string;
  version: string;
  perCollection: Record<
    string,
    { scanned: number; stampedSenior: number; alreadyStamped: number; quarantined: number }
  >;
  scanned: number;
  stampedSenior: number;
  alreadyStamped: number;
  quarantined: QuarantinedRecord[];
  /** Present when maxDocs stopped the run early — pass back as startAfter. */
  resumeCursor: { collection: string; docId: string } | null;
  errors: string[];
}

function createdAtIso(doc: FirebaseFirestore.QueryDocumentSnapshot): string | null {
  // Firestore server metadata — present on every real snapshot; guarded for
  // injected test doubles that omit it.
  const ct = (doc as { createTime?: { toDate(): Date } }).createTime;
  return ct ? ct.toDate().toISOString() : null;
}

/**
 * Core backfill, injectable for tests (pass a Firestore double). The deployed
 * HTTP wrapper below is a thin auth/param shell around this.
 */
export async function runCareVerticalBackfill(
  db: FirebaseFirestore.Firestore,
  options: CareVerticalBackfillOptions = {}
): Promise<CareVerticalBackfillResult> {
  const apply = options.apply === true;
  const cutoff = options.cutoffIso ?? CARE_VERTICAL_MIGRATION_CUTOFF;
  const targets = options.collections ?? [...CARE_VERTICAL_COLLECTIONS];
  const unknown = targets.filter((c) => !CARE_VERTICAL_COLLECTIONS.includes(c));
  if (unknown.length) {
    throw new Error(`Not careVertical collections: ${unknown.join(", ")}`);
  }

  const result: CareVerticalBackfillResult = {
    mode: apply ? "APPLY" : "DRY_RUN",
    cutoff,
    version: CARE_VERTICAL_BACKFILL_VERSION,
    perCollection: {},
    scanned: 0,
    stampedSenior: 0,
    alreadyStamped: 0,
    quarantined: [],
    resumeCursor: null,
    errors: [],
  };

  // Resume: skip collections that a previous run already completed.
  let startIdx = 0;
  let resumeDocId: string | undefined;
  if (options.startAfter) {
    const idx = targets.indexOf(options.startAfter.collection);
    if (idx < 0) throw new Error(`Resume cursor collection not in target list: ${options.startAfter.collection}`);
    startIdx = idx;
    resumeDocId = options.startAfter.docId;
  }

  let remaining = options.maxDocs ?? Number.POSITIVE_INFINITY;

  for (let i = startIdx; i < targets.length; i++) {
    const collName = targets[i];
    const counts = (result.perCollection[collName] ??= {
      scanned: 0,
      stampedSenior: 0,
      alreadyStamped: 0,
      quarantined: 0,
    });

    let cursorDocId = i === startIdx ? resumeDocId : undefined;
    for (;;) {
      if (remaining <= 0) {
        result.resumeCursor = cursorDocId
          ? { collection: collName, docId: cursorDocId }
          : { collection: collName, docId: "" };
        return result;
      }
      const pageLimit = Math.min(PAGE_SIZE, remaining);
      let query = db
        .collection(collName)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(pageLimit);
      if (cursorDocId) query = query.startAfter(cursorDocId);
      const page = await query.get();
      if (page.empty) break;

      const batch = db.batch();
      let writes = 0;
      for (const doc of page.docs) {
        result.scanned++;
        counts.scanned++;
        remaining--;
        try {
          const vertical = (doc.data() as { careVertical?: unknown }).careVertical;
          if (vertical === "senior" || vertical === "child") {
            result.alreadyStamped++;
            counts.alreadyStamped++;
            continue;
          }
          if (vertical !== undefined && vertical !== null) {
            // Present but invalid — quarantine, never overwrite silently.
            result.quarantined.push({
              collection: collName,
              docId: doc.id,
              reason: "invalid-care-vertical",
              value: String(vertical),
            });
            counts.quarantined++;
            continue;
          }
          const created = createdAtIso(doc);
          if (created !== null && created >= cutoff) {
            // Post-cutoff record with no vertical: fail closed — a new-write
            // path is broken and must be fixed, not papered over as senior.
            result.quarantined.push({
              collection: collName,
              docId: doc.id,
              reason: "post-cutoff-missing-vertical",
            });
            counts.quarantined++;
            continue;
          }
          // Legacy record (created before cutoff, no vertical) → senior.
          // "child" is NEVER inferred here regardless of record content.
          result.stampedSenior++;
          counts.stampedSenior++;
          if (apply) {
            batch.set(
              doc.ref,
              {
                careVertical: "senior",
                careVerticalBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
                careVerticalBackfillVersion: CARE_VERTICAL_BACKFILL_VERSION,
              },
              { merge: true }
            );
            writes++;
          }
        } catch (error) {
          result.errors.push(`${collName}/${doc.id}: ${String(error)}`);
        }
      }
      if (apply && writes > 0) await batch.commit();
      cursorDocId = page.docs[page.docs.length - 1].id;
      if (page.size < pageLimit) break;
    }
  }

  return result;
}

// Deployed HTTP wrapper — same auth/param shape as the other migration
// modules (x-admin-secret + ?apply=true), plus ?collection=, ?startAfterDoc=,
// ?maxDocs= for bounded resumable runs. Exported for U14 wiring; deliberately
// NOT re-exported from functions/src/index.ts yet (see module header).
export const backfillCareVertical = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const apply = req.query.apply === "true";
  if (apply && !isCareVerticalCutoffSet()) {
    // Fail closed: the cutoff placeholder means U14 has not chosen a real
    // migration cutoff yet — apply mode would stamp against a meaningless
    // legacy boundary. Dry runs remain allowed for rehearsal counts.
    res.status(412).json({
      error:
        "CARE_VERTICAL_MIGRATION_CUTOFF is still the placeholder. Set the real cutoff in " +
        "functions/src/data/contract.ts (U14) before applying; dry-run is available without it.",
    });
    return;
  }

  const collections =
    typeof req.query.collection === "string" && req.query.collection.length > 0
      ? req.query.collection.split(",")
      : undefined;
  const startAfter =
    typeof req.query.startAfterCollection === "string" && typeof req.query.startAfterDoc === "string"
      ? { collection: req.query.startAfterCollection, docId: req.query.startAfterDoc }
      : undefined;
  const maxDocs =
    typeof req.query.maxDocs === "string" && Number.isFinite(Number(req.query.maxDocs))
      ? Number(req.query.maxDocs)
      : undefined;

  try {
    const result = await runCareVerticalBackfill(admin.firestore(), {
      apply,
      collections,
      startAfter,
      maxDocs,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: String(error) });
  }
});
