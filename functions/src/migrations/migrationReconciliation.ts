import {
  CHILDCARE_CANARY_STATE_COLLECTION,
  CHILDCARE_MIGRATION_REPORT_DOC,
} from "../childcare/childcareCanaryWatch";
import { assertNoChildPii } from "../childcare/privacyAssertions";

// U14 (childcare marketplace plan 2026-07-22-002): migration reconciliation
// report writer.
//
// The migration rehearsals write their before/after reconciliation counts to
// `childcare_canary_state/migration_report`. U13's canary
// (collectChildcareCanaryMetrics) reads the `unresolved` field from this doc
// into the `migration_count_mismatch` signal — a zero-tolerance, rollout-hold
// signal. So a rehearsal that leaves ANY quarantined/orphan record will hold
// the rollout automatically once the canary sweeps.
//
// The report is COUNTS ONLY — never document contents, never identifiers,
// never child data. assertMetricPayloadChildSafe enforces that before the write.

type Db = { collection(path: string): { doc(id: string): { set(data: unknown, opts?: unknown): Promise<unknown> } } };

export interface MigrationReconciliationReport {
  migration: string;
  version: string;
  mode: "DRY_RUN" | "APPLY";
  /** Old count (legacy source records scanned). */
  old: number;
  migrated: number;
  provisional: number;
  quarantined: number;
  /** -1 when not scanned (bounded run). */
  orphan: number;
  /** Records still needing explicit resolution (canary reads this). */
  unresolved: number;
  reconciled: boolean;
}

/**
 * Write the latest migration reconciliation report. One doc per collection
 * (last-writer-wins is fine — the canary wants the current state). Keyed by
 * migration name inside a `byMigration` map so multiple migrations coexist,
 * plus a top-level `unresolved` = the max across migrations for the canary.
 */
export async function writeMigrationReconciliationReport(
  db: Db,
  report: MigrationReconciliationReport,
  now: Date = new Date(),
): Promise<void> {
  const safe = {
    old: report.old,
    migrated: report.migrated,
    provisional: report.provisional,
    quarantined: report.quarantined,
    orphan: report.orphan,
    unresolved: report.unresolved,
    reconciled: report.reconciled,
    mode: report.mode,
    version: report.version,
  };
  // Counts + mode/version only — no child PII keys (this is a governance
  // report, not a metric envelope, so the strict metric allowlist does not
  // apply; assertNoChildPii guarantees no prohibited child field key sneaks in).
  assertNoChildPii(safe, `migration_report:${report.migration}`);

  const ref = db.collection(CHILDCARE_CANARY_STATE_COLLECTION).doc(CHILDCARE_MIGRATION_REPORT_DOC);
  // Use a NESTED object (not a dotted key): merge:true deep-merges the
  // byMigration map so multiple migrations coexist, whereas a "byMigration.x"
  // string key would be stored as a literal field name (dotted paths only work
  // in update(), not set(..., {merge:true})).
  await ref.set(
    {
      // The canary reads the top-level `unresolved` field.
      unresolved: report.unresolved,
      syntheticOnly: true,
      updatedAt: now.toISOString(),
      byMigration: { [report.migration]: { ...safe, updatedAt: now.toISOString() } },
    },
    { merge: true },
  );
}
