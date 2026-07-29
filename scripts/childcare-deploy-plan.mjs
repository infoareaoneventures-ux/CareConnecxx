#!/usr/bin/env node
/**
 * Childcare staged-deploy DRY-RUN planner (plan 2026-07-22-002, U14).
 *
 *   node scripts/childcare-deploy-plan.mjs [--signals <live-signals.json>]
 *
 * Prints the Deployment Gate's 10 steps + gate states and REFUSES to advise
 * "proceed" when any gate is red. NOTHING here deploys — actual execution is
 * founder-run per docs/runbooks/childcare-launch.md.
 *
 * The static gates this script resolves itself:
 *   • consumer manifest audit  (npm run audit:childcare-consumers)
 *   • query/index contract audit (npm run audit:indexes)
 *   • migration cutoff set?     (functions/src/data/contract.ts placeholder)
 *
 * The LIVE gates (rollout hold, jurisdiction readiness, migration
 * reconciliation, step-2 preflight) require a running deploy environment with
 * Firebase credentials, so they are supplied via --signals <file.json>. The
 * AUTHORITATIVE, unit-tested refusal logic lives in
 * functions/src/childcare/deployGate.ts (evaluateDeploymentGate); this script
 * mirrors it for the CLI. Keep the two in sync.
 *
 * --signals JSON shape (all optional; missing live gates are treated as NOT yet
 * verified and block "proceed"):
 *   {
 *     "rolloutHeld": false, "rolloutReasons": [],
 *     "jurisdictionActivatable": false, "jurisdictionIssues": ["..."],
 *     "migrationUnresolved": 0, "migrationReconciled": true,
 *     "appCheck": {
 *       "mode": "enforce", "transitionRecorded": true,
 *       "providerRegistrationVerified": true, "debugTokensAllowed": false,
 *       "verifiedDomains": ["careconnex-d4c8b.web.app", "careconnex-d4c8b.firebaseapp.com"],
 *       "proofByDomain": { "<domain>": {
 *         "normalAccepted": true, "absentDenied": true, "invalidDenied": true,
 *         "expiredDenied": true, "debugDenied": true, "replayDenied": true
 *       }}
 *     },
 *     "preflight": { "targetProjectConfirmed": true, ... }
 *   }
 *
 * Exit 0 = every checked gate green (proceed). Exit 3 = refused. Exit 2 = setup error.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REQUIRED_PREFLIGHT = [
  'targetProjectConfirmed',
  'cliIdentityConfirmed',
  'secretsPresent',
  'appCheckRegistered',
  'webhookDestinationsConfirmed',
  'pilotPolicyApproved',
];
const APPCHECK_DOMAINS = [
  'careconnex-d4c8b.web.app',
  'careconnex-d4c8b.firebaseapp.com',
];

// The 10 Deployment Gate steps + the refusal codes that block each (mirrors
// DEPLOYMENT_STEPS in functions/src/childcare/deployGate.ts).
const STEPS = [
  [1, 'Confirm clean scope + exact commit SHA; re-run U0 manifest if source moved', ['consumer_audit_failed']],
  [2, 'Verify project, CLI identity, secrets/config, App Check enforcement and replay proof, webhook destinations, pilot policy', [
    'preflight_unconfirmed',
    'app_check_not_enforced',
    'app_check_transition_unrecorded',
    'app_check_provider_unverified',
    'app_check_domains_unverified',
    'app_check_debug_tokens_allowed',
    'app_check_negative_proof_missing',
    'app_check_replay_proof_missing',
  ]],
  [3, 'Deploy additive Firestore indexes; wait until READY', ['index_audit_failed']],
  [4, 'Deploy Firestore Rules + Storage Rules (childcare paths server-only, flags off)', []],
  [5, 'Deploy Functions dark; verify deployed names + update times vs the Git SHA', []],
  [6, 'Migration dry-run → bounded apply → reconciliation → unresolved-record gate', ['cutoff_unset', 'migration_unresolved', 'migration_not_reconciled']],
  [7, 'Deploy Hosting after local browser verify; verify both production domains serve the expected bundle', []],
  [8, 'Run isolated synthetic production smokes (no real child identity/Checkr/Stripe; auto-cleanup)', []],
  [9, 'Enable internal cohort, then one pilot jurisdiction/cohort; observe the approved window', ['rollout_held', 'jurisdiction_incomplete']],
  [10, 'Record proof (Hosting/Functions/Rules/indexes/scheduler/flags/migration/smokes/monitoring/rollback)', []],
];

function runAudit(label, cmd) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
    return { label, passed: true };
  } catch (err) {
    const out = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
    return { label, passed: false, detail: out.trim().split('\n').slice(-3).join(' | ') };
  }
}

const CARE_VERTICAL_CUTOFF_SENTINEL = '9999-12-31T23:59:59.999Z';

/**
 * Mirror isCareVerticalCutoffSet() from functions/src/data/contract.ts.
 *
 * contract.ts assigns CARE_VERTICAL_MIGRATION_CUTOFF one of two forms: the
 * placeholder IDENTIFIER while unset, or a real ISO string LITERAL once the
 * cutoff is chosen. Both must be recognized.
 *
 * The previous regex matched only identifiers ([A-Za-z_]+), so setting the
 * cutoff the natural way — a quoted ISO literal — produced NO match, and
 * `!!m` then reported the cutoff as unset. The gate could never go green no
 * matter what you wrote, while the runtime isCareVerticalCutoffSet() (which
 * compares values) correctly saw it as set. Two mirrors of one rule, silently
 * disagreeing. Returns {set, reason} so an unparseable assignment is
 * distinguishable from a deliberately-unset one instead of looking identical.
 */
function cutoffIsSet() {
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'src', 'data', 'contract.ts'), 'utf8');
  const m = src.match(
    /export const CARE_VERTICAL_MIGRATION_CUTOFF\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))/,
  );
  if (!m) {
    return {
      set: false,
      reason:
        'could not parse the CARE_VERTICAL_MIGRATION_CUTOFF assignment in ' +
        'functions/src/data/contract.ts — fix this parser before trusting the gate',
    };
  }
  const literal = m[1] ?? m[2] ?? null;
  if (literal !== null) {
    if (literal === CARE_VERTICAL_CUTOFF_SENTINEL) {
      return { set: false, reason: 'still the far-future placeholder sentinel' };
    }
    if (Number.isNaN(Date.parse(literal))) {
      return { set: false, reason: `not a valid ISO-8601 timestamp: ${literal}` };
    }
    return { set: true, reason: literal };
  }
  if (m[3] === 'CARE_VERTICAL_CUTOFF_PLACEHOLDER') {
    return { set: false, reason: 'still assigned the placeholder identifier' };
  }
  // Assigned some other identifier — resolve it to its literal to avoid
  // reporting SET for an alias that itself still holds the sentinel.
  const alias = src.match(new RegExp(`${m[3]}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const aliasValue = alias ? (alias[1] ?? alias[2]) : null;
  if (aliasValue === null) {
    return { set: false, reason: `cutoff aliased to ${m[3]}, whose value could not be resolved` };
  }
  if (aliasValue === CARE_VERTICAL_CUTOFF_SENTINEL) {
    return { set: false, reason: `aliased to ${m[3]}, which is still the sentinel` };
  }
  return { set: true, reason: aliasValue };
}

function loadSignals() {
  const idx = process.argv.indexOf('--signals');
  if (idx < 0 || !process.argv[idx + 1]) return {};
  const p = path.resolve(process.cwd(), process.argv[idx + 1]);
  if (!fs.existsSync(p)) {
    console.error(`[deploy-plan] --signals file not found: ${p}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  console.log('── Childcare staged-deploy DRY-RUN planner (U14) ──\n');
  console.log('NOTHING here deploys. Actual execution is founder-run per docs/runbooks/childcare-launch.md.\n');

  const consumerAudit = runAudit('audit:childcare-consumers', 'node scripts/audit-childcare-consumers.mjs');
  const appCheckAudit = runAudit('audit:childcare-app-check', 'node scripts/audit-childcare-app-check.mjs');
  const indexAudit = runAudit('audit:indexes', 'node scripts/audit-firestore-query-contracts.mjs');
  const cutoffSet = cutoffIsSet();
  const s = loadSignals();

  const refusals = [];
  if (!consumerAudit.passed) refusals.push(['consumer_audit_failed', `audit:childcare-consumers FAILED — ${consumerAudit.detail ?? ''}`]);
  if (!appCheckAudit.passed) refusals.push(['consumer_audit_failed', `audit:childcare-app-check FAILED — ${appCheckAudit.detail ?? ''}`]);
  if (!indexAudit.passed) refusals.push(['index_audit_failed', `audit:indexes FAILED — ${indexAudit.detail ?? ''}`]);
  if (!cutoffSet.set) refusals.push(['cutoff_unset', `CARE_VERTICAL_MIGRATION_CUTOFF is not usable (${cutoffSet.reason}) — set the real cutoff before applying the migration.`]);

  // Live gates (from --signals). Missing = not yet verified → block.
  if (s.rolloutHeld === true) refusals.push(['rollout_held', `childcare canary rollout-HOLD set: ${(s.rolloutReasons ?? []).join(', ') || 'unknown'}`]);
  else if (s.rolloutHeld === undefined) refusals.push(['rollout_held', 'rollout-hold state not supplied (--signals rolloutHeld) — verify isChildcareRolloutHeld in the deploy env.']);

  if (s.jurisdictionActivatable === false) refusals.push(['jurisdiction_incomplete', `jurisdiction readiness incomplete: ${(s.jurisdictionIssues ?? []).length} open issue(s).`]);
  else if (s.jurisdictionActivatable === undefined) refusals.push(['jurisdiction_incomplete', 'jurisdiction readiness not supplied — run evaluateJurisdictionReadiness in the deploy env.']);

  if ((s.migrationUnresolved ?? -1) > 0) refusals.push(['migration_unresolved', `${s.migrationUnresolved} unresolved/quarantined migration record(s).`]);
  else if (s.migrationUnresolved === undefined) refusals.push(['migration_unresolved', 'migration reconciliation not supplied — run the migration rehearsal and record its report.']);

  if (s.migrationReconciled === false) refusals.push(['migration_not_reconciled', 'the latest migration report is not reconciled.']);

  const appCheck = s.appCheck ?? {};
  if (appCheck.mode !== 'enforce') {
    refusals.push(['app_check_not_enforced', `App Check mode is ${appCheck.mode ?? 'missing'}, not enforce.`]);
  }
  if (appCheck.transitionRecorded !== true) {
    refusals.push(['app_check_transition_unrecorded', 'Firestore App Check enforce transition is not recorded.']);
  }
  if (appCheck.providerRegistrationVerified !== true) {
    refusals.push(['app_check_provider_unverified', 'App Check provider registration is not verified.']);
  }
  const missingDomains = APPCHECK_DOMAINS.filter((domain) => !(appCheck.verifiedDomains ?? []).includes(domain));
  if (missingDomains.length) {
    refusals.push(['app_check_domains_unverified', `App Check domain verification missing: ${missingDomains.join(', ')}.`]);
  }
  if (appCheck.debugTokensAllowed !== false) {
    refusals.push(['app_check_debug_tokens_allowed', 'Production App Check debug tokens are not explicitly prohibited.']);
  }
  const negativeMissing = APPCHECK_DOMAINS.filter((domain) => {
    const proof = appCheck.proofByDomain?.[domain];
    return !proof?.normalAccepted || !proof?.absentDenied || !proof?.invalidDenied ||
      !proof?.expiredDenied || !proof?.debugDenied;
  });
  if (negativeMissing.length) {
    refusals.push(['app_check_negative_proof_missing', `normal/negative App Check proof missing: ${negativeMissing.join(', ')}.`]);
  }
  const replayMissing = APPCHECK_DOMAINS.filter(
    (domain) => appCheck.proofByDomain?.[domain]?.replayDenied !== true,
  );
  if (replayMissing.length) {
    refusals.push(['app_check_replay_proof_missing', `limited-use replay proof missing: ${replayMissing.join(', ')}.`]);
  }

  const preflight = s.preflight ?? {};
  const unconfirmed = REQUIRED_PREFLIGHT.filter((k) => preflight[k] !== true);
  if (unconfirmed.length) refusals.push(['preflight_unconfirmed', `unconfirmed preflight: ${unconfirmed.join(', ')}.`]);

  const active = new Set(refusals.map((r) => r[0]));

  console.log('Static gates:');
  console.log(`  [${consumerAudit.passed ? 'PASS' : 'FAIL'}] consumer manifest audit`);
  console.log(`  [${appCheckAudit.passed ? 'PASS' : 'FAIL'}] App Check policy audit`);
  console.log(`  [${indexAudit.passed ? 'PASS' : 'FAIL'}] query/index contract audit`);
  console.log(`  [${cutoffSet.set ? 'SET ' : 'UNSET'}] migration cutoff — ${cutoffSet.reason}\n`);

  console.log('Deployment Gate steps:');
  for (const [n, title, blockedBy] of STEPS) {
    const blocking = blockedBy.filter((c) => active.has(c));
    const mark = blocking.length ? 'BLOCKED' : 'ok';
    console.log(`  ${String(n).padStart(2)}. [${mark}] ${title}`);
    if (blocking.length) console.log(`        ↳ blocked by: ${blocking.join(', ')}`);
  }

  console.log('');
  if (refusals.length === 0) {
    console.log('VERDICT: PROCEED — every checked gate is green. (Live gates must be re-verified in the deploy env at run time.)');
    process.exit(0);
  }
  console.log('VERDICT: REFUSED — the following gates are red:');
  for (const [code, detail] of refusals) console.log(`  • ${code}: ${detail}`);
  process.exit(3);
}

main();
