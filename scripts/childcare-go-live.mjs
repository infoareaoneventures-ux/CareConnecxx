#!/usr/bin/env node
/**
 * Childcare go-live orchestrator — runs the three seed steps IN ORDER.
 *
 * WHY AN ORCHESTRATOR: the three steps have a hard dependency order, and getting
 * it wrong is the one mistake with a user-visible cost. Enabling flags before
 * pricing and the jurisdiction policy exist opens a signup funnel that cannot
 * take a payment or produce a match — a family onboards into a dead end. This
 * script makes the correct order the default and aborts the moment a step fails,
 * so a partial go-live is not reachable by fumbling the sequence.
 *
 *   1. seed-childcare-pricing.mjs       → childcare_pricing_configs + pricing.*Ref
 *   2. seed-childcare-jurisdiction.mjs  → jurisdiction_care_policies/CA
 *   3. seed-childcare-flags.mjs         → childcare_flags/global   (verifies 1+2)
 *
 * Step 3 independently re-verifies steps 1 and 2 against live Firestore before
 * enabling anything, so this ordering is belt AND suspenders.
 *
 * USAGE
 *   npm run childcare:go-live-plan                      # dry-run all three
 *   node scripts/childcare-go-live.mjs --values=ca.json # dry-run with approvals
 *   node scripts/childcare-go-live.mjs --apply --project=careconnex-d4c8b
 *
 * DRY RUN BY DEFAULT. --apply requires --project=<id>.
 *
 * Flags forwarded to step 3: --on=<list> (default: enabled,writes,discovery).
 * PROACTIVE IS OFF BY DEFAULT and that is deliberate — proactive outbound
 * childcare SMS is the only irreversible surface here (a flag can be switched
 * back; a text already delivered to a family cannot). Pass
 * --on=enabled,writes,discovery,proactive to include it.
 *
 * ROLLBACK
 *   node scripts/seed-childcare-flags.mjs --emergency-off --apply --project=<id>
 */

import { spawnSync } from "node:child_process";

const DEFAULT_ON = "enabled,writes,discovery";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const projectArg = (args.find((a) => a.startsWith("--project=")) ?? "").split("=")[1] ?? "";
const valuesArg = args.find((a) => a.startsWith("--values=")) ?? null;
const onArg = (args.find((a) => a.startsWith("--on=")) ?? `--on=${DEFAULT_ON}`);

if (apply && !projectArg) {
  console.error("\nREFUSED: --apply requires --project=<projectId>.\n");
  process.exit(2);
}

const applyFlags = apply ? ["--apply", `--project=${projectArg}`] : [];

const STEPS = [
  {
    name: "1/3 pricing configs",
    script: "scripts/seed-childcare-pricing.mjs",
    extra: [],
    why: "childcare payment setup refuses with pricing_unset until these exist",
  },
  {
    name: "2/3 jurisdiction policy",
    script: "scripts/seed-childcare-jurisdiction.mjs",
    extra: valuesArg ? [valuesArg] : [],
    why: "loadJurisdictionPolicy returns null without it and every consumer fails closed",
  },
  {
    name: "3/3 childcare flags",
    script: "scripts/seed-childcare-flags.mjs",
    extra: [onArg],
    why: "the master switch; re-verifies steps 1 and 2 before enabling anything",
  },
];

console.log(`\n╔══ childcare go-live — ${apply ? `APPLY to ${projectArg}` : "DRY RUN"} ══╗`);
if (!apply) {
  console.log("  Nothing will be written. Re-run with --apply --project=<id>.");
}
if (!onArg.includes("proactive")) {
  console.log("  NOTE: proactive outbound childcare SMS stays OFF (not needed to go live).");
}

let failed = null;
for (const step of STEPS) {
  console.log(`\n${"─".repeat(72)}\n▶ ${step.name} — ${step.why}\n${"─".repeat(72)}`);
  const res = spawnSync(
    process.execPath,
    [step.script, ...step.extra, ...applyFlags],
    { stdio: "inherit" },
  );
  if (res.error) {
    failed = { step, detail: res.error.message };
    break;
  }
  if (res.status !== 0) {
    failed = { step, detail: `exit code ${res.status}` };
    break;
  }
}

if (failed) {
  console.error(`\n╔══ ABORTED at ${failed.name ?? failed.step.name} (${failed.detail}) ══╗`);
  console.error("  Later steps were NOT run. Nothing downstream was enabled.");
  if (failed.step.script.includes("flags")) {
    console.error("  Flags were not written, so childcare remains dark.");
  } else {
    console.error("  Fix the failure above and re-run; steps are idempotent (merge writes).");
  }
  console.error("");
  process.exit(1);
}

console.log(`\n╔══ ${apply ? "GO-LIVE COMPLETE" : "DRY RUN COMPLETE"} ══╗`);
if (apply) {
  console.log("  Childcare is functionally live: signup → match → pay → book.");
  console.log("  Flag cache TTL is 60s; allow a minute for running instances.");
  console.log("\n  Rollback:");
  console.log(`    node scripts/seed-childcare-flags.mjs --emergency-off --apply --project=${projectArg}`);
  console.log("\n  Still outstanding (governance, not runtime): the approval and consent");
  console.log("  references. npm run childcare:deploy-plan will keep reporting");
  console.log("  jurisdiction_incomplete until they are recorded — that is accurate.");
} else {
  console.log("  Review the three plans above, then:");
  console.log(`    node scripts/childcare-go-live.mjs --apply --project=careconnex-d4c8b`);
}
console.log("");
