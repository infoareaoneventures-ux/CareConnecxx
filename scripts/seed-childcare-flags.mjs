#!/usr/bin/env node
/**
 * Create / update childcare_flags/global — the childcare master kill switch.
 *
 * The document does not exist today, so readChildcareFlags() returns ALL OFF and
 * every childcare surface is dark. This script is how childcare turns on.
 *
 * FLAG SEMANTICS (config/featureFlags.ts)
 *   CHILDCARE_ENABLED            master — off means every other flag is off
 *   CHILDCARE_DISCOVERY_ENABLED  caregiver discovery / match surfaces
 *   CHILDCARE_WRITES_ENABLED     childcare writes (enrollment, bookings)
 *   CHILDCARE_PROACTIVE_ENABLED  proactive/outbound childcare messaging
 *   emergencyOff                 hard kill — true forces ALL OFF regardless
 *
 * ORDERING MATTERS. Turn these on LAST, after:
 *   1. scripts/seed-childcare-pricing.mjs --apply      (else payment refuses)
 *   2. scripts/seed-childcare-jurisdiction.mjs --apply (else policy is null)
 * Enabling first opens a signup funnel that cannot take a payment or produce a
 * match — a family would onboard into a dead end. This script REFUSES to enable
 * anything until it has verified both prerequisites exist (--apply path only).
 *
 * USAGE
 *   node scripts/seed-childcare-flags.mjs                                  # plan (all off)
 *   node scripts/seed-childcare-flags.mjs --on=enabled,writes,discovery    # plan
 *   node scripts/seed-childcare-flags.mjs --on=all --apply --project=careconnex-d4c8b
 *   node scripts/seed-childcare-flags.mjs --emergency-off --apply --project=...
 *
 * DRY RUN BY DEFAULT.
 */

const FLAG_BY_ALIAS = {
  enabled: "CHILDCARE_ENABLED",
  discovery: "CHILDCARE_DISCOVERY_ENABLED",
  writes: "CHILDCARE_WRITES_ENABLED",
  proactive: "CHILDCARE_PROACTIVE_ENABLED",
};
const ALL_FLAGS = Object.values(FLAG_BY_ALIAS);

function parseOn(args) {
  const arg = args.find((a) => a.startsWith("--on="));
  if (!arg) return [];
  const raw = (arg.split("=")[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.includes("all")) return [...ALL_FLAGS];
  const out = [];
  for (const alias of raw) {
    const flag = FLAG_BY_ALIAS[alias] ?? (ALL_FLAGS.includes(alias) ? alias : null);
    if (!flag) {
      console.error(`\nREFUSED: unknown flag "${alias}". Valid: ${Object.keys(FLAG_BY_ALIAS).join(", ")}, all\n`);
      process.exit(2);
    }
    out.push(flag);
  }
  return out;
}

async function verifyPrerequisites(db, on) {
  // Only meaningful when actually enabling something.
  if (!on.includes("CHILDCARE_ENABLED")) return [];
  const problems = [];

  const policySnap = await db.collection("jurisdiction_care_policies").doc("CA").get();
  if (!policySnap.exists) {
    problems.push("jurisdiction_care_policies/CA does not exist — loadJurisdictionPolicy returns null and every consumer fails closed. Run seed-childcare-jurisdiction.mjs --apply first.");
  } else {
    const p = policySnap.data() ?? {};
    if (p.status !== "configured") {
      problems.push(`jurisdiction_care_policies/CA status is "${String(p.status)}" — only "configured" is accepted.`);
    }
    if (!p.policyVersion) {
      problems.push("jurisdiction_care_policies/CA has no policyVersion — caregivers cannot satisfy policy acceptance.");
    }
    if (!Array.isArray(p.approvedServiceCategories) || p.approvedServiceCategories.length === 0) {
      problems.push("jurisdiction_care_policies/CA has no approvedServiceCategories — booking category checks fail closed.");
    }
    const REQUIRED_PRICING_REFS = [
      "familyEntitlementRef", "caregiverFeeRef", "screeningFeeRef",
      "siblingPolicyRef", "cancellationPolicyRef", "refundPolicyRef",
    ];
    const missingRefs = REQUIRED_PRICING_REFS.filter((k) => {
      const v = p.pricing?.[k];
      return v === null || v === undefined || String(v).trim() === "";
    });
    if (missingRefs.length) {
      problems.push(`jurisdiction_care_policies/CA pricing refs unset: ${missingRefs.join(", ")} — childcare payment setup refuses with pricing_unset. Run seed-childcare-pricing.mjs --apply first.`);
    } else {
      // Refs present — confirm the config documents they point at actually exist.
      const ids = REQUIRED_PRICING_REFS.map((k) => String(p.pricing[k]));
      const snaps = await Promise.all(
        ids.map((id) => db.collection("childcare_pricing_configs").doc(id).get()),
      );
      const dangling = ids.filter((_, i) => !snaps[i].exists);
      if (dangling.length) {
        problems.push(`pricing refs point at missing childcare_pricing_configs docs: ${dangling.join(", ")}`);
      }
    }
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const emergencyOff = args.includes("--emergency-off");
  const projectArg = (args.find((a) => a.startsWith("--project=")) ?? "").split("=")[1] ?? "";
  const on = emergencyOff ? [] : parseOn(args);

  const doc = { emergencyOff };
  for (const f of ALL_FLAGS) doc[f] = on.includes(f);

  console.log(`\nchildcare flags — ${apply ? "APPLY" : "DRY RUN (nothing will be written)"}`);
  console.log(`childcare_flags/global\n`);
  for (const f of ALL_FLAGS) console.log(`  ${f} = ${doc[f]}`);
  console.log(`  emergencyOff = ${doc.emergencyOff}`);

  if (emergencyOff) {
    console.log("\n⚠️  emergencyOff=true is a HARD KILL — forces every childcare flag off");
    console.log("    regardless of the individual values above.");
  } else if (!on.length) {
    console.log("\nNothing enabled. Pass --on=enabled,writes,discovery (or --on=all).");
  } else if (!on.includes("CHILDCARE_ENABLED")) {
    console.log("\n⚠️  CHILDCARE_ENABLED is NOT in --on, so every other flag stays effectively");
    console.log("    off (the master flag gates them all). Add `enabled` to --on.");
  }

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply --project=<projectId> to write.\n");
    return;
  }
  if (!projectArg) {
    console.error("\nREFUSED: --apply requires --project=<projectId> naming the target project.\n");
    process.exit(2);
  }

  const admin = await import("firebase-admin");
  if (!admin.apps.length) admin.initializeApp();
  const resolved = admin.app().options.projectId
    ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  if (resolved !== projectArg) {
    console.error(`\nREFUSED: credential project "${resolved}" != --project "${projectArg}".\n`);
    process.exit(2);
  }

  const db = admin.firestore();
  const problems = await verifyPrerequisites(db, on);
  if (problems.length) {
    console.error(`\nREFUSED: enabling childcare would open a funnel that cannot complete a booking:\n`);
    for (const p of problems) console.error(`  • ${p}`);
    console.error("\nFix these first, then re-run. (--emergency-off always works.)\n");
    process.exit(3);
  }

  await db.collection("childcare_flags").doc("global").set(doc, { merge: true });
  // The reader caches for CHILDCARE_FLAGS_CACHE_TTL_MS (60s), so a running
  // instance can serve stale flags for up to a minute after this write.
  console.log(`\n✅ wrote childcare_flags/global to ${projectArg}`);
  console.log("   Flag cache TTL is 60s — allow a minute for running instances to pick this up.\n");
}

main().catch((err) => {
  console.error("flag write failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
