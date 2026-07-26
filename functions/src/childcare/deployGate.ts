// ── Childcare deployment gate (childcare marketplace plan 2026-07-22-002, U14) ──
//
// The Deployment Gate's 10 steps as a CHECKED, DRY-RUN sequence, plus the
// hard refusal rules. This module is the AUTHORITATIVE, unit-tested gate logic;
// scripts/childcare-deploy-plan.mjs is the founder-facing CLI that collects the
// static signals and prints the plan + gate states. Actual execution is
// founder-run — nothing here deploys.
//
// The gate REFUSES to proceed when ANY of these hold (R61-R63):
//   • the consumer manifest audit fails (unclassified shared consumer),
//   • the query/index contract audit fails (missing/stale index),
//   • the childcare canary rollout-HOLD signal is set (isChildcareRolloutHeld),
//   • the jurisdiction readiness evaluator reports the pilot state incomplete,
//   • migration reconciliation has unexplained/quarantined records, or is
//     not reconciled,
//   • the migration cutoff is still the placeholder (isCareVerticalCutoffSet),
//   • any founder-attested preflight (secrets/config/App-Check/CLI/project) is
//     unconfirmed.

import {
  isChildcareRolloutHeld,
  CHILDCARE_CANARY_STATE_COLLECTION,
  CHILDCARE_MIGRATION_REPORT_DOC,
  type RolloutHoldState,
} from "./childcareCanaryWatch";
import { evaluateJurisdictionReadiness, type JurisdictionReadiness } from "./jurisdictionPolicy";
import { isCareVerticalCutoffSet } from "../data/contract";
import {
  getChildcareAppCheckConfig,
  type ChildcareAppCheckConfig,
} from "../config/featureFlags";

type Db = { collection(path: string): any };

// ── The 10 Deployment Gate steps (plan §Deployment Gate) ─────────────────────

export interface DeploymentStep {
  n: number;
  title: string;
  /** Refusal codes that block this step from being reached. */
  blockedBy: DeploymentRefusalCode[];
}

export const DEPLOYMENT_STEPS: readonly DeploymentStep[] = [
  { n: 1, title: "Confirm clean scope + exact commit SHA; re-run U0 manifest if source moved", blockedBy: ["consumer_audit_failed"] },
  {
    n: 2,
    title: "Verify project, CLI identity, secrets/config, App Check enforcement and replay proof, webhook destinations, pilot policy",
    blockedBy: [
      "preflight_unconfirmed",
      "app_check_not_enforced",
      "app_check_transition_unrecorded",
      "app_check_provider_unverified",
      "app_check_domains_unverified",
      "app_check_debug_tokens_allowed",
      "app_check_negative_proof_missing",
      "app_check_replay_proof_missing",
    ],
  },
  { n: 3, title: "Deploy additive Firestore indexes; wait until READY", blockedBy: ["index_audit_failed"] },
  { n: 4, title: "Deploy Firestore Rules + Storage Rules (childcare paths server-only, flags off)", blockedBy: [] },
  { n: 5, title: "Deploy Functions dark; verify deployed names + update times vs the Git SHA", blockedBy: [] },
  { n: 6, title: "Run migration dry-run → bounded apply → reconciliation → unresolved-record gate", blockedBy: ["cutoff_unset", "migration_unresolved", "migration_not_reconciled"] },
  { n: 7, title: "Deploy Hosting after local browser verify; verify both production domains serve the expected bundle", blockedBy: [] },
  { n: 8, title: "Run isolated synthetic production smokes (no real child identity/Checkr/Stripe; auto-cleanup)", blockedBy: [] },
  { n: 9, title: "Enable internal cohort, then one pilot jurisdiction/cohort; observe the approved window", blockedBy: ["rollout_held", "jurisdiction_incomplete"] },
  { n: 10, title: "Record proof (Hosting/Functions/Rules/indexes/scheduler/flags/migration/smokes/monitoring/rollback)", blockedBy: [] },
] as const;

// ── Signals + refusals ───────────────────────────────────────────────────────

export type DeploymentRefusalCode =
  | "consumer_audit_failed"
  | "index_audit_failed"
  | "rollout_held"
  | "jurisdiction_incomplete"
  | "migration_unresolved"
  | "migration_not_reconciled"
  | "cutoff_unset"
  | "preflight_unconfirmed"
  | "app_check_not_enforced"
  | "app_check_transition_unrecorded"
  | "app_check_provider_unverified"
  | "app_check_domains_unverified"
  | "app_check_debug_tokens_allowed"
  | "app_check_negative_proof_missing"
  | "app_check_replay_proof_missing";

export const CHILDCARE_PRODUCTION_HOSTING_DOMAINS = [
  "careconnex-d4c8b.web.app",
  "careconnex-d4c8b.firebaseapp.com",
] as const;

export interface AppCheckDomainProof {
  normalAccepted: boolean;
  absentDenied: boolean;
  invalidDenied: boolean;
  expiredDenied: boolean;
  debugDenied: boolean;
  replayDenied: boolean;
}

export type AppCheckProofByDomain = Record<string, AppCheckDomainProof | undefined>;

export interface DeploymentGateSignals {
  /** npm run audit:childcare-consumers exit 0. */
  consumerAuditPassed: boolean;
  /** npm run audit:indexes exit 0. */
  indexAuditPassed: boolean;
  /** From isChildcareRolloutHeld(db). */
  rolloutHold: RolloutHoldState;
  /** From evaluateJurisdictionReadiness(pilotState, {db}). */
  jurisdictionReadiness: JurisdictionReadiness;
  /** Unresolved (quarantined + orphan) records from the migration report. */
  migrationUnresolved: number;
  /** Whether the latest migration report reconciled with zero unexplained. */
  migrationReconciled: boolean;
  /** isCareVerticalCutoffSet() — false while the cutoff is the placeholder. */
  cutoffSet: boolean;
  /** Firestore-owned effective rollout state, never an operator assertion. */
  appCheckConfig: ChildcareAppCheckConfig;
  /** Recorded production probe results for each canonical Hosting domain. */
  appCheckProof: AppCheckProofByDomain;
  /**
   * Founder-attested step-2 preflight checks. Each key is a check name; a
   * false value = unconfirmed and blocks. Missing keys are treated as
   * unconfirmed (fail-closed).
   */
  preflight: Record<string, boolean>;
}

export const REQUIRED_PREFLIGHT_CHECKS: readonly string[] = [
  "targetProjectConfirmed",
  "cliIdentityConfirmed",
  "secretsPresent",
  "appCheckRegistered",
  "webhookDestinationsConfirmed",
  "pilotPolicyApproved",
];

export interface DeploymentRefusal {
  code: DeploymentRefusalCode;
  detail: string;
}

export interface DeploymentGateDecision {
  canProceed: boolean;
  refusals: DeploymentRefusal[];
  /** Per-step reachability given the refusals. */
  steps: Array<{ n: number; title: string; reachable: boolean; blockedBy: DeploymentRefusalCode[] }>;
}

/**
 * PURE gate evaluation. Given the collected signals, returns the refusal set +
 * per-step reachability. canProceed only when refusals is empty.
 */
export function evaluateDeploymentGate(signals: DeploymentGateSignals): DeploymentGateDecision {
  const refusals: DeploymentRefusal[] = [];

  if (!signals.consumerAuditPassed) {
    refusals.push({ code: "consumer_audit_failed", detail: "audit:childcare-consumers did not pass — an unclassified shared consumer exists." });
  }
  if (!signals.indexAuditPassed) {
    refusals.push({ code: "index_audit_failed", detail: "audit:indexes did not pass — a compound query is unregistered or an index is missing/stale." });
  }
  if (signals.rolloutHold.held) {
    refusals.push({
      code: "rollout_held",
      detail: `childcare canary rollout-HOLD is set: ${signals.rolloutHold.reasons.join(", ") || "unknown"}.`,
    });
  }
  if (!signals.jurisdictionReadiness.activatable) {
    refusals.push({
      code: "jurisdiction_incomplete",
      detail: `jurisdiction ${signals.jurisdictionReadiness.state} readiness incomplete: ${signals.jurisdictionReadiness.issues.length} open issue(s).`,
    });
  }
  if (!signals.cutoffSet) {
    refusals.push({ code: "cutoff_unset", detail: "CARE_VERTICAL_MIGRATION_CUTOFF is still the placeholder — set the real cutoff before applying the migration." });
  }
  if (signals.migrationUnresolved > 0) {
    refusals.push({ code: "migration_unresolved", detail: `${signals.migrationUnresolved} unresolved/quarantined migration record(s) — every one needs explicit resolution.` });
  }
  if (!signals.migrationReconciled) {
    refusals.push({ code: "migration_not_reconciled", detail: "the latest migration report is not reconciled (unexplained count difference)." });
  }
  if (signals.appCheckConfig.mode !== "enforce") {
    refusals.push({
      code: "app_check_not_enforced",
      detail: `childcare App Check effective mode is ${signals.appCheckConfig.mode}, not enforce.`,
    });
  }
  if (!signals.appCheckConfig.transitionRecorded) {
    refusals.push({
      code: "app_check_transition_unrecorded",
      detail: "App Check enforce transition is not recorded in the Firestore global flag document.",
    });
  }
  if (!signals.appCheckConfig.providerRegistrationVerified) {
    refusals.push({
      code: "app_check_provider_unverified",
      detail: "Firebase App Check provider registration has not been verified.",
    });
  }
  const missingDomains = CHILDCARE_PRODUCTION_HOSTING_DOMAINS.filter(
    (domain) => !signals.appCheckConfig.verifiedDomains.includes(domain),
  );
  if (missingDomains.length > 0) {
    refusals.push({
      code: "app_check_domains_unverified",
      detail: `App Check is not verified for Hosting domain(s): ${missingDomains.join(", ")}.`,
    });
  }
  if (signals.appCheckConfig.debugTokensAllowed) {
    refusals.push({
      code: "app_check_debug_tokens_allowed",
      detail: "App Check debug tokens are allowed in the production rollout state.",
    });
  }
  const negativeProofMissing = CHILDCARE_PRODUCTION_HOSTING_DOMAINS.filter((domain) => {
    const proof = signals.appCheckProof[domain];
    return !proof ||
      !proof.normalAccepted ||
      !proof.absentDenied ||
      !proof.invalidDenied ||
      !proof.expiredDenied ||
      !proof.debugDenied;
  });
  if (negativeProofMissing.length > 0) {
    refusals.push({
      code: "app_check_negative_proof_missing",
      detail: `App Check normal/absent/invalid/expired/debug proof is incomplete for: ${negativeProofMissing.join(", ")}.`,
    });
  }
  const replayProofMissing = CHILDCARE_PRODUCTION_HOSTING_DOMAINS.filter(
    (domain) => signals.appCheckProof[domain]?.replayDenied !== true,
  );
  if (replayProofMissing.length > 0) {
    refusals.push({
      code: "app_check_replay_proof_missing",
      detail: `limited-use App Check replay denial is unproven for: ${replayProofMissing.join(", ")}.`,
    });
  }
  const unconfirmed = REQUIRED_PREFLIGHT_CHECKS.filter((k) => signals.preflight[k] !== true);
  if (unconfirmed.length > 0) {
    refusals.push({ code: "preflight_unconfirmed", detail: `unconfirmed preflight: ${unconfirmed.join(", ")}.` });
  }

  const active = new Set(refusals.map((r) => r.code));
  const steps = DEPLOYMENT_STEPS.map((s) => ({
    n: s.n,
    title: s.title,
    blockedBy: s.blockedBy.filter((c) => active.has(c)),
    reachable: s.blockedBy.every((c) => !active.has(c)),
  }));

  return { canProceed: refusals.length === 0, refusals, steps };
}

// ── Live signal collector (reads Firestore; audits/preflight are injected) ────

/**
 * Read the live gate signals a running environment can resolve: the rollout
 * hold, the jurisdiction readiness for the pilot state, the cutoff flag, and
 * the migration reconciliation report. Audit results and step-2 preflight are
 * NOT readable from Firestore — the caller (CLI) passes them in.
 */
export async function collectDeploymentGateSignals(opts: {
  db: Db;
  pilotState: string;
  consumerAuditPassed: boolean;
  indexAuditPassed: boolean;
  preflight: Record<string, boolean>;
  appCheckProof?: AppCheckProofByDomain;
  now?: Date;
}): Promise<DeploymentGateSignals> {
  const rolloutHold = await isChildcareRolloutHeld(opts.db as any);
  const jurisdictionReadiness = await evaluateJurisdictionReadiness(opts.pilotState, {
    db: opts.db as any,
    now: opts.now,
  });

  let migrationUnresolved = 0;
  let migrationReconciled = true;
  try {
    const snap = await opts.db
      .collection(CHILDCARE_CANARY_STATE_COLLECTION)
      .doc(CHILDCARE_MIGRATION_REPORT_DOC)
      .get();
    if (snap.exists) {
      const d = snap.data() ?? {};
      migrationUnresolved = Number(d.unresolved ?? 0) || 0;
      // Reconciled unless any sub-migration reports reconciled:false.
      const byMigration = (d.byMigration ?? {}) as Record<string, { reconciled?: boolean }>;
      migrationReconciled = Object.values(byMigration).every((m) => m.reconciled !== false);
    } else {
      // No report at all = migration rehearsal has not run → not reconciled.
      migrationReconciled = false;
    }
  } catch {
    // Fail SAFE for a deploy gate: an unreadable report is treated as unresolved.
    migrationUnresolved = 1;
    migrationReconciled = false;
  }

  return {
    consumerAuditPassed: opts.consumerAuditPassed,
    indexAuditPassed: opts.indexAuditPassed,
    rolloutHold,
    jurisdictionReadiness,
    migrationUnresolved,
    migrationReconciled,
    cutoffSet: isCareVerticalCutoffSet(),
    appCheckConfig: await getChildcareAppCheckConfig({ db: opts.db as any }),
    appCheckProof: opts.appCheckProof ?? {},
    preflight: opts.preflight,
  };
}
