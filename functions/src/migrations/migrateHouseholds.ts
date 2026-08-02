import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  HOUSEHOLDS_COLLECTION,
  HOUSEHOLD_MEMBERSHIPS_COLLECTION,
  householdDocId,
  membershipDocId,
  provisionalMembershipDocId,
  membershipPhoneHash,
  type HouseholdDoc,
  type HouseholdMembershipDoc,
} from "../childcare/householdRepository";
import { assertNonProductionMigrationEnvironment } from "./nonProductionGuard";
import { writeMigrationReconciliationReport } from "./migrationReconciliation";

// U14 (childcare marketplace plan 2026-07-22-002): household migration REHEARSAL.
//
// Rehearses mapping the legacy family sources —
//   • `senior_profiles` (owning adult via clientId/doc-id + the phone-keyed
//     `familyMembers` array)
//   • `family_groups` (extra phones by seniorId)
// — into the canonical U2 `households` + `household_memberships` COMPATIBILITY
// PROJECTIONS. It NEVER touches child-vertical data and NEVER creates guardian
// authority: membership grants nothing (R7/AE4). Phone-only adults become
// PROVISIONAL memberships with zero grantable scopes (the U2 rule) — a recycled
// phone number is exactly the risk the household model replaces, so no child
// data ever flows through these legacy phone-keyed readers.
//
// Contract (mirrors backfillCareVertical.ts, the U0 idempotent bounded-batch
// pattern):
//   • Dry-run by DEFAULT — counts + quarantine only, no writes.
//   • Apply mode is refused unless the hard non-production guard passes
//     (nonProductionGuard.ts) — no real production data is migrated in this
//     unit; the founder runs it against emulator/copied non-production data.
//   • Bounded batches with a resume cursor (senior_profiles doc id) so a
//     partial run resumes exactly where it stopped.
//   • Idempotent — deterministic doc IDs (householdDocId / membershipDocId /
//     provisionalMembershipDocId); already-present docs are counted and skipped,
//     so a re-run converges to zero new writes.
//   • Unresolved/ambiguous rows are QUARANTINED with a reason and left
//     untouched — never guessed into a household.
//   • Reconciliation: old count, migrated, provisional, quarantined, orphan —
//     zero unexplained. A reconciliation report is written to
//     childcare_canary_state (U13 reads migration signals from there).
//
// NOT wired into index.ts yet beyond the guarded HTTP wrapper below; the founder
// runs the rehearsal from the deploy runbook (docs/runbooks/childcare-launch.md).

export const HOUSEHOLD_MIGRATION_VERSION = "2026-07-24-v1";

const PAGE_SIZE = 300;

export type HouseholdQuarantineReason =
  | "unresolved-owning-adult" // no clientId/doc-id resolves, or the owning users doc is absent
  | "ambiguous-owning-adult"; // more than one senior_profile claims the same primary uid

export interface HouseholdQuarantineRecord {
  seniorProfileId: string;
  reason: HouseholdQuarantineReason;
  /** Non-identifying detail (never child data). */
  detail?: string;
}

export interface HouseholdMigrationOptions {
  /** Write mode. Default false (dry run): counts + quarantine only, no writes. */
  apply?: boolean;
  /** Resume cursor from a previous partial run (senior_profiles doc id). */
  startAfterDocId?: string;
  /** Stop after scanning this many senior_profiles and return a resume cursor. */
  maxDocs?: number;
  /**
   * Run the family_groups orphan scan. Only meaningful on a FULL run (no
   * maxDocs/resume) — skipped on bounded runs since the full senior-id set is
   * needed to attribute orphans. Default true.
   */
  orphanScan?: boolean;
  /** Write the reconciliation report to childcare_canary_state. Default = apply. */
  writeReport?: boolean;
  /** Skip the non-production guard (tests only — never a production bypass). */
  skipEnvironmentGuardForTest?: boolean;
}

export interface HouseholdMigrationResult {
  mode: "DRY_RUN" | "APPLY";
  version: string;
  /** Old count: legacy senior_profiles scanned this run. */
  scannedSeniorProfiles: number;
  /** Households created this run. */
  householdsMigrated: number;
  /** Households already present (idempotent skips). */
  householdsAlreadyPresent: number;
  /** Provisional (phone-only adult) memberships created this run. */
  provisionalMembershipsCreated: number;
  /** Provisional memberships already present (idempotent skips). */
  provisionalMembershipsAlreadyPresent: number;
  quarantined: HouseholdQuarantineRecord[];
  /** family_groups whose seniorId has no senior_profile (full-run only; -1 = not scanned). */
  orphanFamilyGroups: number;
  /** Present when maxDocs stopped the run early — pass back as startAfterDocId. */
  resumeCursor: string | null;
  /** True when every scanned senior_profile is accounted for (migrated+present+quarantined). */
  reconciled: boolean;
  errors: string[];
}

type Db = FirebaseFirestore.Firestore;

interface SeniorFamilyMember {
  phone?: unknown;
}

/** Owning adult uid for a senior_profile: clientId preferred, else the doc id. */
function resolveOwningAdultUid(docId: string, data: Record<string, unknown>): string | null {
  const clientId = typeof data.clientId === "string" ? data.clientId.trim() : "";
  if (clientId) return clientId;
  const byDocId = String(docId ?? "").trim();
  return byDocId || null;
}

/** Distinct, non-empty phone strings from a senior's familyMembers array. */
function collectFamilyMemberPhones(data: Record<string, unknown>): string[] {
  const members = Array.isArray(data.familyMembers) ? (data.familyMembers as SeniorFamilyMember[]) : [];
  const phones = members
    .map((m) => (typeof m?.phone === "string" ? m.phone.trim() : ""))
    .filter((p) => p.length > 0);
  return [...new Set(phones)];
}

/**
 * Core household migration, injectable for tests (pass a Firestore double). The
 * deployed HTTP wrapper below is a thin auth/param shell around this.
 */
export async function runHouseholdMigration(
  db: Db,
  options: HouseholdMigrationOptions = {},
): Promise<HouseholdMigrationResult> {
  const apply = options.apply === true;

  // Apply mode NEVER runs against production or an unprovable environment.
  if (apply && options.skipEnvironmentGuardForTest !== true) {
    assertNonProductionMigrationEnvironment("runHouseholdMigration (apply)");
  }

  const bounded = typeof options.maxDocs === "number";
  const orphanScan = options.orphanScan !== false && !bounded && !options.startAfterDocId;

  const result: HouseholdMigrationResult = {
    mode: apply ? "APPLY" : "DRY_RUN",
    version: HOUSEHOLD_MIGRATION_VERSION,
    scannedSeniorProfiles: 0,
    householdsMigrated: 0,
    householdsAlreadyPresent: 0,
    provisionalMembershipsCreated: 0,
    provisionalMembershipsAlreadyPresent: 0,
    quarantined: [],
    orphanFamilyGroups: -1,
    resumeCursor: null,
    reconciled: false,
    errors: [],
  };

  // Track the primary uids we mapped this run so a duplicate senior_profile
  // claiming the same owner is quarantined "ambiguous" rather than silently
  // colliding on the deterministic household id.
  const seenPrimaryUids = new Set<string>();
  const seenSeniorIds = new Set<string>();

  let remaining = options.maxDocs ?? Number.POSITIVE_INFINITY;
  let cursorDocId = options.startAfterDocId;

  for (;;) {
    if (remaining <= 0) {
      result.resumeCursor = cursorDocId ?? "";
      break;
    }
    const pageLimit = Math.min(PAGE_SIZE, remaining);
    let query = db
      .collection("senior_profiles")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageLimit);
    if (cursorDocId) query = query.startAfter(cursorDocId);
    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      result.scannedSeniorProfiles++;
      remaining--;
      try {
        const data = (doc.data() ?? {}) as Record<string, unknown>;
        seenSeniorIds.add(doc.id);

        const primaryUid = resolveOwningAdultUid(doc.id, data);
        if (!primaryUid) {
          result.quarantined.push({
            seniorProfileId: doc.id,
            reason: "unresolved-owning-adult",
            detail: "no clientId and no usable doc id",
          });
          continue;
        }
        // The owning adult must be a real account — a senior_profile whose
        // owner has no users doc is a residual/malformed legacy record, never
        // guessed into a household (matches migrateSeniorsToHousehold's guard).
        const ownerSnap = await db.collection("users").doc(primaryUid).get();
        if (!ownerSnap.exists) {
          result.quarantined.push({
            seniorProfileId: doc.id,
            reason: "unresolved-owning-adult",
            detail: "owning users doc absent",
          });
          continue;
        }
        if (seenPrimaryUids.has(primaryUid)) {
          result.quarantined.push({
            seniorProfileId: doc.id,
            reason: "ambiguous-owning-adult",
            detail: "primary uid already claimed by another senior_profile this run",
          });
          continue;
        }
        seenPrimaryUids.add(primaryUid);

        // 1. Household + primary membership (deterministic ids → idempotent).
        const hhId = householdDocId(primaryUid);
        const hhRef = db.collection(HOUSEHOLDS_COLLECTION).doc(hhId);
        const hhSnap = await hhRef.get();
        const ts = new Date().toISOString();
        if (hhSnap.exists) {
          result.householdsAlreadyPresent++;
        } else {
          result.householdsMigrated++;
          if (apply) {
            const household: HouseholdDoc = {
              householdId: hhId,
              primaryAdultUid: primaryUid,
              status: "active",
              policyVersion: null,
              accessVersion: 1,
              createdAt: ts,
              updatedAt: ts,
            };
            const primaryMembership: HouseholdMembershipDoc = {
              membershipId: membershipDocId(hhId, primaryUid),
              householdId: hhId,
              adultUid: primaryUid,
              role: "primary",
              status: "active",
              source: "household_create",
              invitedByUid: null,
              consentVersion: null,
              joinedAt: ts,
              createdAt: ts,
              updatedAt: ts,
            };
            const batch = db.batch();
            batch.set(hhRef, { ...household, householdMigrationVersion: HOUSEHOLD_MIGRATION_VERSION }, { merge: false });
            batch.set(
              db.collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION).doc(primaryMembership.membershipId),
              primaryMembership,
              { merge: false },
            );
            await batch.commit();
          }
        }

        // 2. Phone-only adults → PROVISIONAL memberships (zero scopes, U2 rule).
        //    Extra phones come from family_groups keyed by this seniorId.
        const phones = new Set(collectFamilyMemberPhones(data));
        try {
          const groupSnap = await db.collection("family_groups").where("seniorId", "==", doc.id).get();
          for (const g of groupSnap.docs) {
            const gp = (g.data() ?? {}) as Record<string, unknown>;
            const arr = Array.isArray(gp.phones) ? (gp.phones as unknown[]) : [];
            for (const p of arr) if (typeof p === "string" && p.trim()) phones.add(p.trim());
          }
        } catch {
          // family_groups scan is best-effort — a read failure never blocks the
          // household projection; it only under-counts provisional phones.
        }

        for (const phone of phones) {
          const provId = provisionalMembershipDocId(hhId, phone);
          const provRef = db.collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION).doc(provId);
          const provSnap = await provRef.get();
          if (provSnap.exists) {
            result.provisionalMembershipsAlreadyPresent++;
            continue;
          }
          result.provisionalMembershipsCreated++;
          if (apply) {
            const provisional: HouseholdMembershipDoc = {
              membershipId: provId,
              householdId: hhId,
              adultUid: null, // phone-only — no Firebase Auth; zero grantable scopes
              role: "adult",
              status: "provisional",
              provisionalPhoneHash: membershipPhoneHash(phone),
              source: "sms_join",
              invitedByUid: null,
              consentVersion: null,
              joinedAt: null,
              createdAt: ts,
              updatedAt: ts,
            };
            await provRef.set(provisional, { merge: false });
          }
        }
      } catch (error) {
        result.errors.push(`senior_profiles/${doc.id}: ${String(error)}`);
      }
    }

    cursorDocId = page.docs[page.docs.length - 1].id;
    if (page.size < pageLimit) break;
  }

  // 3. Orphan family_groups (full-run only): a group whose seniorId never
  //    matched a senior_profile is a residual legacy record with no household.
  if (orphanScan) {
    result.orphanFamilyGroups = 0;
    try {
      const groups = await db.collection("family_groups").get();
      for (const g of groups.docs) {
        const sid = String((g.data() ?? {}).seniorId ?? "");
        if (sid && !seenSeniorIds.has(sid)) result.orphanFamilyGroups++;
      }
    } catch (error) {
      result.errors.push(`family_groups orphan scan: ${String(error)}`);
    }
  }

  // Reconciliation: every scanned senior_profile is migrated, already present,
  // or quarantined — zero unexplained.
  result.reconciled =
    result.householdsMigrated + result.householdsAlreadyPresent + result.quarantined.length ===
    result.scannedSeniorProfiles;

  const writeReport = options.writeReport ?? apply;
  if (writeReport) {
    try {
      await writeMigrationReconciliationReport(db, {
        migration: "migrateHouseholds",
        version: HOUSEHOLD_MIGRATION_VERSION,
        mode: result.mode,
        old: result.scannedSeniorProfiles,
        migrated: result.householdsMigrated,
        provisional: result.provisionalMembershipsCreated,
        quarantined: result.quarantined.length,
        orphan: result.orphanFamilyGroups,
        // The canary reads `unresolved` — quarantined + orphans are the records
        // still needing explicit resolution before enablement.
        unresolved: result.quarantined.length + Math.max(0, result.orphanFamilyGroups),
        reconciled: result.reconciled,
      });
    } catch (error) {
      result.errors.push(`reconciliation report write: ${String(error)}`);
    }
  }

  return result;
}

// Deployed HTTP wrapper — same auth/param shape as backfillCareVertical
// (x-admin-secret + ?apply=true), plus ?startAfterDoc=, ?maxDocs=. Exported for
// U14 wiring; the founder runs the rehearsal against emulator/non-production
// data per docs/runbooks/childcare-launch.md.
export const migrateHouseholds = functions.https.onRequest(async (req, res) => {
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
    const result = await runHouseholdMigration(admin.firestore(), { apply, startAfterDocId, maxDocs });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: String(error) });
  }
});
