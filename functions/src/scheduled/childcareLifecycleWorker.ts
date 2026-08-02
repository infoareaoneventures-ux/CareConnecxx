// ── Childcare lifecycle worker (childcare marketplace plan 2026-07-22-002, U3) ──
//
// The scheduled drain for the child-data privacy lifecycle (R13-R16):
//
//   1. data_lifecycle_requests — export/delete/redact state-machine progress
//      (privacy/dataLifecycle.ts; claim/lease/bounded-retry/terminal, the
//      guardianAuthorityOutbox dispatcher pattern from U2).
//   2. Age-band recalculation — reads the exact DOB from the PRIVATE zone
//      server-side and stamps only the BAND on the operational doc; crossing
//      the adult threshold produces the EXPLICIT aged_out transition (state
//      change + operator alert), never a silent adult conversion (R16).
//   3. Retention TTL enforcement — SHIPS OFF. Every purpose-specific duration
//      in docs/policies/childcare-data-retention.md is POLICY-TBD (counsel/
//      founder sign-off pending), and a placeholder duration authorizes
//      NOTHING. The per-purpose config below therefore holds nulls; the worker
//      supports per-purpose TTLs but refuses to enforce until EVERY purpose it
//      would touch has a concrete duration AND the retention policy version is
//      bumped (versioning rules in the policy doc). Legal hold always wins
//      over TTL.
//
// This worker runs UNGATED by the childcare feature flags: deletion/export are
// data rights (R14/R15) and age-out is a safety-correctness sweep — both must
// keep functioning during an emergency-off. It no-ops on empty collections.

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {
  processLifecycleRequests,
} from "../privacy/dataLifecycle";
import {
  listActiveChildProfiles,
  recalcChildAgeBand,
} from "../data/childProfileRepository";

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

// ── Retention configuration (R13 — POLICY-TBD, enforcement OFF) ─────────────

/** Purposes the TTL sweep would govern (classes from the retention policy doc). */
export const RETENTION_PURPOSES = [
  "childProfileAfterClosure", // class 1
  "supersededSafetyVersions", // class 2
  "revokedAuthorityRecords", // class 3
  "lifecycleRequestProof", // class 11
] as const;
export type RetentionPurpose = (typeof RETENTION_PURPOSES)[number];

/**
 * Per-purpose TTL in days. EVERY value is null until counsel/founder supplies
 * the concrete durations (docs/policies/childcare-data-retention.md v2) — a
 * null is POLICY-TBD and authorizes no deletion. Populating these is a policy
 * change: bump the retention policy version in the same commit.
 */
export const RETENTION_TTL_DAYS: Record<RetentionPurpose, number | null> = {
  childProfileAfterClosure: null, // POLICY-TBD
  supersededSafetyVersions: null, // POLICY-TBD
  revokedAuthorityRecords: null, // POLICY-TBD
  lifecycleRequestProof: null, // POLICY-TBD
};

/** The enforcement guard: OFF until every governed purpose has a duration. */
export function isRetentionEnforcementConfigured(): boolean {
  return RETENTION_PURPOSES.every((p) => {
    const days = RETENTION_TTL_DAYS[p];
    return typeof days === "number" && Number.isFinite(days) && days > 0;
  });
}

export interface RetentionSweepResult {
  enforced: boolean;
  reason: string | null;
  purposesMissingDuration: RetentionPurpose[];
}

/**
 * TTL sweep entry point. Supports per-purpose TTLs but SHIPS DARK: with any
 * POLICY-TBD duration it records the skip and touches nothing. When durations
 * land, the enforcement body goes here (legal hold always exempts a record).
 */
export async function runRetentionSweep(_db?: Db): Promise<RetentionSweepResult> {
  const missing = RETENTION_PURPOSES.filter((p) => RETENTION_TTL_DAYS[p] === null);
  if (!isRetentionEnforcementConfigured()) {
    return {
      enforced: false,
      reason: "retention_durations_policy_tbd",
      purposesMissingDuration: missing,
    };
  }
  // Unreachable until durations are populated; implemented alongside the
  // policy-version bump so enforcement and policy can never disagree.
  return { enforced: true, reason: null, purposesMissingDuration: [] };
}

// ── Age-band sweep ───────────────────────────────────────────────────────────

export interface AgeBandSweepResult {
  scanned: number;
  updated: number;
  agedOut: number;
}

export async function runAgeBandSweep(
  db?: Db,
  opts: { now?: Date; limit?: number } = {},
): Promise<AgeBandSweepResult> {
  const database = db ?? admin.firestore();
  const profiles = await listActiveChildProfiles(database, opts.limit ?? 200);
  let updated = 0;
  let agedOut = 0;
  for (const profile of profiles) {
    try {
      const result = await recalcChildAgeBand(profile.childId, { db: database, now: opts.now });
      if (result.changed) updated += 1;
      if (result.agedOut) agedOut += 1;
    } catch {
      // One malformed record never stalls the sweep — it stays on its current
      // band and the next pass retries.
    }
  }
  return { scanned: profiles.length, updated, agedOut };
}

// ── Combined pass (unit-testable; the scheduled export calls this) ──────────

export interface LifecycleWorkerPassResult {
  requests: { attempted: number; completed: number };
  ageBands: AgeBandSweepResult;
  retention: RetentionSweepResult;
}

export async function processChildcareLifecycleOnce(
  opts: { db?: Db; bucket?: unknown; now?: Date } = {},
): Promise<LifecycleWorkerPassResult> {
  const db = opts.db ?? admin.firestore();
  const requests = await processLifecycleRequests({
    db,
    // bucket is injectable for tests; production uses the default bucket.
    bucket: opts.bucket as never,
    now: opts.now,
  });
  const ageBands = await runAgeBandSweep(db, { now: opts.now });
  const retention = await runRetentionSweep(db);
  return { requests, ageBands, retention };
}

// ── Scheduled export ─────────────────────────────────────────────────────────

export const childcareLifecycleWorker = functions.pubsub
  .schedule("every 15 minutes")
  .timeZone("UTC")
  .onRun(async () => {
    const result = await processChildcareLifecycleOnce();
    if (
      result.requests.attempted > 0 ||
      result.ageBands.updated > 0 ||
      result.ageBands.agedOut > 0
    ) {
      console.log(
        `[childcareLifecycleWorker] requests=${result.requests.attempted}/${result.requests.completed} ` +
          `bands=${result.ageBands.updated} agedOut=${result.ageBands.agedOut} ` +
          `retention=${result.retention.enforced ? "on" : "off"}`,
      );
    }
  });
