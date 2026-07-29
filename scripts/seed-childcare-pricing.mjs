#!/usr/bin/env node
/**
 * Seed the childcare pricing configuration (R40).
 *
 * Childcare payment setup FAILS CLOSED until these documents exist — by design,
 * so no childcare amount is ever inferred from senior defaults. This script
 * writes them from the founder's recorded decisions.
 *
 * DRY RUN BY DEFAULT. It prints the exact documents it would write and changes
 * nothing. To apply you must pass BOTH --apply AND --project=<projectId>, and
 * the project must match the credential's project — a mismatch aborts.
 *
 *   node scripts/seed-childcare-pricing.mjs                        # plan only
 *   node scripts/seed-childcare-pricing.mjs --apply --project=careconnex-d4c8b
 *
 * After applying, childcare payment setup stops refusing with `pricing_unset`.
 *
 * NOTE on readiness: evaluateJurisdictionReadiness("CA").activatable will still
 * be false until the legal/insurance/screening-program references and the six
 * consent versions are recorded. That evaluator is consulted ONLY by
 * childcare/deployGate.ts (the launch checklist) — no runtime request path calls
 * it — so those references are a governance requirement, not a code gate. They
 * do not block a family from paying once these pricing configs exist.
 */

// ── Founder decisions, 2026-07-25 ────────────────────────────────────────────
// DECIDED: families pay the SAME $29.95/mo membership as senior care; childcare
// caregivers pay the SAME $54.99/yr annual as senior caregivers.
const DECIDED = {
  // Existing live Stripe price — never recreate it.
  familyMonthlyPriceId: "price_1TO8D5L7Ss5iuUb73AQ3zHKO", // $29.95/mo
  caregiverAnnualDisplay: "$54.99/year",
  // "Same as senior" also applied to the per-shift platform fee, which senior
  // care charges on top of caregiver gross (billing/config.ts: 1.5%, $0.50 min).
  // ⚠️ CONFIRM: this is the consistent reading of "same as senior", not an
  // explicitly stated decision. Change these two numbers if childcare should
  // differ.
  platformFeeRate: 0.015,
  platformFeeMinCents: 50,
  // Screening: the shared Checkr base package (founder decision 2026-07-22) —
  // childcare reuses senior's package, so the fee treatment matches senior too.
  screeningFeeTreatment: "shared_base_package_same_as_senior",
};

// ── Founder-approved, 2026-07-28 ─────────────────────────────────────────────
// These three were previously PROPOSED defaults. The founder signed off on all
// three as written on 2026-07-28. Market grounding recorded at decision time:
// national babysitting rates run $26.24/hr for one child and $29.87/hr for two
// (+$3.63), with $3–4/hr per additional child — so +$3.00 sits at the low end.
// The refund window is deliberately far more generous than the market leader
// (UrbanSitter's terms: "ALL FEES AND CHARGES ARE NONREFUNDABLE"); that is a
// launch trust investment, chosen knowingly, not an inherited default.
const APPROVED = {
  // Senior couples care charges +$3–6/hr rather than 2× for a second recipient.
  // The sibling analogue: a flat per-additional-child hourly surcharge.
  siblingSurchargePerHourCents: 300, // +$3.00/hr per additional child
  cancellation: {
    // Sorted descending; evaluation picks the first window that matches.
    windows: [
      { hoursBeforeStart: 24, refundPercent: 100 }, // >= 24h out: full refund
      { hoursBeforeStart: 0, refundPercent: 50 },   // inside 24h: half
    ],
    providerNoShowRefundPercent: 100, // caregiver no-show: family made whole
  },
  refund: {
    windowHours: 72,   // family may request within 3 days of checkout
    allowPartial: true,
    maxPercent: 100,
  },
};

const POLICY_VERSION = "CA-2026-07-22.1"; // must match jurisdiction_care_policies/CA
const STATE = "CA";
const FOUNDER_SIGNOFF_DATE = "2026-07-28";

const REF_IDS = {
  familyEntitlementRef: "ca-family-entitlement-v1",
  caregiverFeeRef: "ca-caregiver-fee-v1",
  screeningFeeRef: "ca-screening-fee-v1",
  siblingPolicyRef: "ca-sibling-policy-v1",
  cancellationPolicyRef: "ca-cancellation-policy-v1",
  refundPolicyRef: "ca-refund-policy-v1",
};

function buildDocs() {
  const now = new Date().toISOString();
  const base = { policyVersion: POLICY_VERSION, currency: "usd", state: STATE, seededAt: now };
  return {
    [REF_IDS.familyEntitlementRef]: {
      ...base,
      kind: "family_entitlement",
      stripePriceId: DECIDED.familyMonthlyPriceId,
      display: "$29.95/month",
      note: "Same membership as senior care — one membership covers both verticals.",
    },
    [REF_IDS.caregiverFeeRef]: {
      ...base,
      kind: "caregiver_fee",
      annualDisplay: DECIDED.caregiverAnnualDisplay,
      platformFeeRate: DECIDED.platformFeeRate,
      platformFeeMinCents: DECIDED.platformFeeMinCents,
      dualVerticalChargedOnce: true, // see report note — confirm
      note: "Same annual as senior caregivers; per-shift platform fee matches senior (1.5%, $0.50 min).",
    },
    [REF_IDS.screeningFeeRef]: {
      ...base,
      kind: "screening_fee",
      treatment: DECIDED.screeningFeeTreatment,
      note: "Shared Checkr base package with senior (founder decision 2026-07-22).",
    },
    [REF_IDS.siblingPolicyRef]: {
      ...base,
      kind: "sibling_policy",
      surchargePerHourCents: APPROVED.siblingSurchargePerHourCents,
      approvedOn: FOUNDER_SIGNOFF_DATE,
      note: "Founder-approved 2026-07-28. Mirrors senior couples-care surcharge shape, not 2x. Market: +$3.63/hr observed for a 2nd child; $3.00 is the low end.",
    },
    [REF_IDS.cancellationPolicyRef]: {
      ...base,
      kind: "cancellation_policy",
      ...APPROVED.cancellation,
      approvedOn: FOUNDER_SIGNOFF_DATE,
      note: "Founder-approved 2026-07-28. >=24h full refund, inside 24h 50%, provider no-show 100%.",
    },
    [REF_IDS.refundPolicyRef]: {
      ...base,
      kind: "refund_policy",
      ...APPROVED.refund,
      approvedOn: FOUNDER_SIGNOFF_DATE,
      note: "Founder-approved 2026-07-28. 72h post-shift window, partial allowed, max 100%.",
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const projectArg = (args.find((a) => a.startsWith("--project=")) ?? "").split("=")[1] ?? "";

  const docs = buildDocs();

  console.log(`\nchildcare pricing seed — ${apply ? "APPLY" : "DRY RUN (nothing will be written)"}`);
  console.log(`policyVersion: ${POLICY_VERSION}   state: ${STATE}\n`);
  console.log(`childcare_pricing_configs/  (${Object.keys(docs).length} documents)`);
  for (const [id, doc] of Object.entries(docs)) {
    const flag = String(doc.note ?? "").startsWith("PROPOSED") ? "  ⚠️ PROPOSED" : "";
    console.log(`  ${id}${flag}`);
    console.log(`    ${JSON.stringify(doc)}`);
  }
  console.log(`\njurisdiction_care_policies/${STATE}  ← pricing refs`);
  for (const [key, id] of Object.entries(REF_IDS)) console.log(`  pricing.${key} = "${id}"`);

  const unsigned = Object.values(docs).filter((d) =>
    String(d.note ?? "").startsWith("PROPOSED")).length;
  if (unsigned) {
    console.log(`\n⚠️  ${unsigned} document(s) still marked PROPOSED — founder sign-off missing.`);
  } else {
    console.log(`\nAll 6 configs are founder-approved (sign-off ${FOUNDER_SIGNOFF_DATE}).`);
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
  const batch = db.batch();
  for (const [id, doc] of Object.entries(docs)) {
    batch.set(db.collection("childcare_pricing_configs").doc(id), doc, { merge: true });
  }
  // NESTED object, not dotted keys. Firestore set() treats a key containing a
  // dot as a LITERAL field name — only update() interprets dots as field paths.
  // Writing {"pricing.familyEntitlementRef": id} would create a top-level field
  // literally named `pricing.familyEntitlementRef`, leaving policy.pricing
  // undefined, so resolveChildcarePricingSnapshot would still fail with
  // pricing_unset while this script printed success. merge:true merges the
  // nested map field-by-field, so sibling pricing keys are preserved.
  const pricing = {};
  for (const [key, id] of Object.entries(REF_IDS)) pricing[key] = id;
  batch.set(db.collection("jurisdiction_care_policies").doc(STATE), { pricing }, { merge: true });
  await batch.commit();

  console.log(`\n✅ wrote ${Object.keys(docs).length} pricing configs + ${Object.keys(REF_IDS).length} refs to ${projectArg}`);
  console.log("   Next: confirm evaluateJurisdictionReadiness(\"CA\") and record the");
  console.log("   legal/insurance/TrustLine references + consent versions.\n");
}

main().catch((err) => {
  console.error("seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
