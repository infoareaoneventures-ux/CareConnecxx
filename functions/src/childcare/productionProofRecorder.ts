// ── Childcare production proof recorder (plan 2026-07-22-002, U14 / R62, AE30) ──
//
// Captures the R62 deployment-proof evidence bundle — one Git SHA and the
// matching Functions, Hosting, Rules, Storage Rules, indexes, scheduler,
// config/flags, migration counts, smoke IDs, monitoring health, and rollback
// drill — into a structured report doc (childcare_canary_state/deployment_proof)
// AND provides the proof template the founder fills in docs/runbooks/childcare-launch.md.
//
// Nothing here deploys. The bundle is child-safe by construction (SHAs, release
// IDs, counts, synthetic smoke IDs) — assertNoChildPii enforces it before write.

import {
  CHILDCARE_CANARY_STATE_COLLECTION,
} from "./childcareCanaryWatch";
import { assertNoChildPii } from "./privacyAssertions";

export const CHILDCARE_DEPLOYMENT_PROOF_DOC = "deployment_proof";

/** The 14 Production Smoke Matrix ids (plan §Production Smoke Matrix). */
export const PRODUCTION_SMOKE_IDS: readonly string[] = [
  "adult_child_boundary",
  "legacy_cutoff",
  "household_guardian",
  "storage",
  "screening",
  "matching_interview",
  "booking_truth",
  "safety_version",
  "communication",
  "care_payment_review",
  "evia",
  "incident",
  "lifecycle",
  "emergency_off",
] as const;

export interface ProductionProofBundle {
  /** THE single Git SHA every other artifact must map to (AE30). */
  gitSha: string;
  firebaseProject: string;
  /** Function name → deployed update time (ISO). */
  functionsUpdateTimes: Record<string, string>;
  hostingRelease: string;
  rulesRelease: string;
  storageRulesRelease: string;
  /** Index name → state (expected "READY"). */
  indexStates: Record<string, string>;
  /** Scheduler/job name → state ("enabled" | "disabled"). */
  schedulerStates: Record<string, string>;
  /** Childcare flag name → boolean (from childcare_flags at record time). */
  flagStates: Record<string, boolean>;
  migrationCounts: {
    old: number;
    migrated: number;
    provisional: number;
    quarantined: number;
    orphan: number;
    unresolved: number;
  };
  /** Synthetic smoke ids that passed. */
  smokeIds: string[];
  monitoringHealth: { rolloutHeld: boolean; redSignals: number };
  rollbackDrill: { ranAt: string; seniorSmokeUnchanged: boolean };
  recordedAt: string;
}

export interface ProofCompleteness {
  bundle: ProductionProofBundle;
  complete: boolean;
  /** Missing/invalid evidence field paths — the founder work list. */
  missing: string[];
}

function isNonEmptyStr(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isNonEmptyMap(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length > 0;
}

/**
 * Validate proof completeness (R62/AE30). Returns the bundle plus every missing
 * or invalid evidence field. Complete only when: one Git SHA + project + every
 * release/state map present, migration reconciled (unresolved === 0), all 14
 * smokes present, monitoring not held with zero red signals, and the rollback
 * drill left senior behavior unchanged.
 */
export function buildProductionProofBundle(input: Partial<ProductionProofBundle>): ProofCompleteness {
  const now = input.recordedAt ?? new Date().toISOString();
  const bundle: ProductionProofBundle = {
    gitSha: input.gitSha ?? "",
    firebaseProject: input.firebaseProject ?? "",
    functionsUpdateTimes: input.functionsUpdateTimes ?? {},
    hostingRelease: input.hostingRelease ?? "",
    rulesRelease: input.rulesRelease ?? "",
    storageRulesRelease: input.storageRulesRelease ?? "",
    indexStates: input.indexStates ?? {},
    schedulerStates: input.schedulerStates ?? {},
    flagStates: input.flagStates ?? {},
    migrationCounts: input.migrationCounts ?? { old: 0, migrated: 0, provisional: 0, quarantined: 0, orphan: 0, unresolved: 0 },
    smokeIds: input.smokeIds ?? [],
    monitoringHealth: input.monitoringHealth ?? { rolloutHeld: true, redSignals: 0 },
    rollbackDrill: input.rollbackDrill ?? { ranAt: "", seniorSmokeUnchanged: false },
    recordedAt: now,
  };

  const missing: string[] = [];
  if (!isNonEmptyStr(bundle.gitSha)) missing.push("gitSha");
  if (!isNonEmptyStr(bundle.firebaseProject)) missing.push("firebaseProject");
  if (!isNonEmptyMap(bundle.functionsUpdateTimes)) missing.push("functionsUpdateTimes");
  if (!isNonEmptyStr(bundle.hostingRelease)) missing.push("hostingRelease");
  if (!isNonEmptyStr(bundle.rulesRelease)) missing.push("rulesRelease");
  if (!isNonEmptyStr(bundle.storageRulesRelease)) missing.push("storageRulesRelease");
  if (!isNonEmptyMap(bundle.indexStates)) missing.push("indexStates");
  else {
    const notReady = Object.entries(bundle.indexStates).filter(([, s]) => String(s).toUpperCase() !== "READY");
    if (notReady.length) missing.push(`indexStates(not READY: ${notReady.map(([n]) => n).join(",")})`);
  }
  if (!isNonEmptyMap(bundle.schedulerStates)) missing.push("schedulerStates");
  if (!isNonEmptyMap(bundle.flagStates)) missing.push("flagStates");
  if (bundle.migrationCounts.unresolved !== 0) missing.push("migrationCounts.unresolved(must be 0)");

  const missingSmokes = PRODUCTION_SMOKE_IDS.filter((s) => !bundle.smokeIds.includes(s));
  if (missingSmokes.length) missing.push(`smokeIds(missing: ${missingSmokes.join(",")})`);

  if (bundle.monitoringHealth.rolloutHeld) missing.push("monitoringHealth.rolloutHeld(held)");
  if (bundle.monitoringHealth.redSignals !== 0) missing.push("monitoringHealth.redSignals(nonzero)");

  if (!isNonEmptyStr(bundle.rollbackDrill.ranAt)) missing.push("rollbackDrill.ranAt");
  if (!bundle.rollbackDrill.seniorSmokeUnchanged) missing.push("rollbackDrill.seniorSmokeUnchanged(false)");

  return { bundle, complete: missing.length === 0, missing };
}

type Db = { collection(path: string): { doc(id: string): { set(data: unknown, opts?: unknown): Promise<unknown> } } };

/**
 * Persist the proof bundle to childcare_canary_state/deployment_proof. Records
 * the bundle AND the completeness verdict so a later reader can tell whether
 * enablement was authorized. Child-safe by construction (assertNoChildPii).
 */
export async function recordProductionProof(db: Db, completeness: ProofCompleteness): Promise<void> {
  const record = {
    ...completeness.bundle,
    complete: completeness.complete,
    missing: completeness.missing,
    syntheticOnly: true,
  };
  assertNoChildPii(record, "deployment_proof");
  await db
    .collection(CHILDCARE_CANARY_STATE_COLLECTION)
    .doc(CHILDCARE_DEPLOYMENT_PROOF_DOC)
    .set(record, { merge: false });
}

/** Human-readable required-evidence list for the runbook proof section. */
export const PRODUCTION_PROOF_TEMPLATE_FIELDS: readonly string[] = [
  "gitSha",
  "firebaseProject",
  "functionsUpdateTimes (per childcare function → update time)",
  "hostingRelease",
  "rulesRelease",
  "storageRulesRelease",
  "indexStates (each required index → READY)",
  "schedulerStates (childcareCanaryWatch + lifecycle worker + expiry sweep)",
  "flagStates (childcare_flags/global + pilot state)",
  "migrationCounts (old/migrated/provisional/quarantined/orphan/unresolved=0)",
  "smokeIds (all 14 Production Smoke Matrix ids)",
  "monitoringHealth (rolloutHeld=false, redSignals=0)",
  "rollbackDrill (ranAt + seniorSmokeUnchanged=true)",
] as const;
