#!/usr/bin/env node
/**
 * Seed jurisdiction_care_policies/CA — the childcare jurisdiction policy record.
 *
 * WHY THIS EXISTS
 * ---------------
 * Childcare reads this document at runtime in several places:
 *   • providerEligibility  — needs `policyVersion` (a caregiver's
 *     acceptedPolicyVersion is compared against it; absent ⇒
 *     policy_acceptance_missing ⇒ ineligible)
 *   • bookingCallables     — assertEnableableChildcareCategory needs
 *     `approvedServiceCategories`
 *   • screeningPolicy      — needs `screening`
 *   • paymentPolicy        — needs `pricing.*Ref` (seeded separately by
 *     scripts/seed-childcare-pricing.mjs, NOT by this script)
 * loadJurisdictionPolicy returns null when the document is absent, and every
 * consumer fails closed on null. So without this record childcare cannot
 * function at all.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT INVENT
 * ---------------------------------------------
 * approvals.{legalCounsel,insurance,jurisdictionScreeningProgram},
 * consentVersions.*, guardianProcessRef, reportingObligationsRef,
 * insuranceEvidenceRefs and incidentContacts are EXTERNAL facts — a counsel
 * memo ID, an insurance certificate number, published consent version strings,
 * a real 24/7 escalation number. This script writes them ONLY from a values
 * file you supply (--values=path). It never fabricates them, because a
 * fabricated approval reference is a false compliance record asserting that
 * counsel and an insurer signed off on a date nobody signed off on.
 *
 * Those fields are checked by evaluatePolicyReadiness, which is consulted ONLY
 * by childcare/deployGate.ts (the launch checklist) — no runtime request path
 * calls it. So they are a GOVERNANCE requirement, not a code gate: childcare
 * will operate without them, and the checklist will keep saying REFUSED until
 * they are recorded. Both of those statements are true at the same time.
 *
 * USAGE
 *   node scripts/seed-childcare-jurisdiction.mjs                          # plan
 *   node scripts/seed-childcare-jurisdiction.mjs --values=ca-approvals.json
 *   node scripts/seed-childcare-jurisdiction.mjs --apply --project=careconnex-d4c8b
 *
 * DRY RUN BY DEFAULT. --apply requires --project=<id> matching the credential.
 *
 * Values-file shape (every key optional; only what you supply is written):
 * {
 *   "approvals": {
 *     "legalCounsel":  { "referenceId": "...", "issuedBy": "...", "approvedOn": "2026-07-2x", "policyVersion": "CA-2026-07-22.1", "expiresOn": null },
 *     "insurance":     { "referenceId": "...", "issuedBy": "...", "approvedOn": "...", "policyVersion": "CA-2026-07-22.1", "expiresOn": "2027-..." },
 *     "jurisdictionScreeningProgram": { "referenceId": "...", "issuedBy": "...", "approvedOn": "...", "policyVersion": "CA-2026-07-22.1" }
 *   },
 *   "consentVersions": { "terms": "...", "privacy": "...", "screeningDisclosure": "...",
 *                        "guardianAttestation": "...", "communicationConsent": "...", "childcarePolicy": "..." },
 *   "guardianProcessRef": "...",
 *   "reportingObligationsRef": "...",
 *   "insuranceEvidenceRefs": ["..."],
 *   "incidentContacts": [{ "label": "24/7 escalation", "phone": "+1..." }],
 *   "effectiveOn": "2026-07-28T00:00:00.000Z"
 * }
 */

import fs from "node:fs";
import path from "node:path";

const STATE = "CA";
const POLICY_VERSION = "CA-2026-07-22.1"; // must match seed-childcare-pricing.mjs

// ── Operational fields (mirrors CA_PILOT_POLICY_SEED in ────────────────────────
//    functions/src/childcare/jurisdictionPolicy.ts — keep the two in sync).
//    These are internal product decisions, not external attestations, so they
//    are safe for this script to write.
const OPERATIONAL = {
  state: STATE,
  // "configured" is the ONLY status evaluatePolicyReadiness accepts. "disabled"
  // is an explicit kill; anything else fails closed as policy_status_invalid.
  status: "configured",
  policyVersion: POLICY_VERSION,
  emergencyOff: false,
  approvedServiceCategories: ["babysitting", "nanny_care", "after_school_care", "date_night_care"],
  caregiverMinimumAge: 18,
  screening: {
    // Shared Checkr base package with senior care (founder decision 2026-07-22).
    // MUST equal SHARED_BASE_CHECKR_PACKAGE_REF in jurisdictionPolicy.ts.
    checkrPackageRef: "shared-base-package",
    components: ["ssn_trace", "national_criminal_search", "county_criminal_search", "sex_offender_search"],
    renewalMonths: 12,
  },
  // Evia is NON-MEDICAL — no clinical credentials are required or requestable.
  credentialRules: { requiredCredentials: [] },
  // Transport stays OFF for the pilot. If it is ever enabled, MVR is mandatory.
  transport: { enabled: false, requiresMvr: true },
  retentionPolicyVersion: "childcare-retention-2026-07-22.1",
};

// Fields this script writes ONLY from --values. Listed so the plan output can
// show you exactly what is still unpopulated.
const EXTERNAL_FIELDS = [
  "approvals.legalCounsel",
  "approvals.insurance",
  "approvals.jurisdictionScreeningProgram",
  "consentVersions.terms",
  "consentVersions.privacy",
  "consentVersions.screeningDisclosure",
  "consentVersions.guardianAttestation",
  "consentVersions.communicationConsent",
  "consentVersions.childcarePolicy",
  "guardianProcessRef",
  "reportingObligationsRef",
  "insuranceEvidenceRefs",
  "incidentContacts",
];

function isUnpopulated(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "" || v.startsWith("FILL_IN");
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function loadValues(args) {
  const arg = args.find((a) => a.startsWith("--values="));
  if (!arg) return {};
  const p = path.resolve(process.cwd(), arg.split("=")[1] ?? "");
  if (!fs.existsSync(p)) {
    console.error(`\nREFUSED: --values file not found: ${p}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`\nREFUSED: --values file is not valid JSON: ${err.message}\n`);
    process.exit(2);
  }
}

/** Reject an approval reference that is present but structurally incomplete. */
function validateApprovals(values) {
  const problems = [];
  for (const kind of ["legalCounsel", "insurance", "jurisdictionScreeningProgram"]) {
    const ref = values?.approvals?.[kind];
    if (ref === undefined) continue; // simply not supplied — fine
    for (const field of ["referenceId", "issuedBy", "approvedOn"]) {
      if (isUnpopulated(ref?.[field])) {
        problems.push(`approvals.${kind}.${field} is empty — an approval reference needs a concrete identifier, issuer, and date`);
      }
    }
    if (ref?.policyVersion && ref.policyVersion !== POLICY_VERSION) {
      problems.push(`approvals.${kind}.policyVersion "${ref.policyVersion}" != policy "${POLICY_VERSION}" — readiness would flag this as stale`);
    }
  }
  return problems;
}

function buildDoc(values) {
  const doc = { ...OPERATIONAL };
  if (values.effectiveOn !== undefined) doc.effectiveOn = values.effectiveOn;
  for (const key of ["guardianProcessRef", "reportingObligationsRef", "insuranceEvidenceRefs", "incidentContacts"]) {
    if (values[key] !== undefined) doc[key] = values[key];
  }
  if (values.approvals) doc.approvals = values.approvals;
  if (values.consentVersions) doc.consentVersions = values.consentVersions;
  return doc;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const projectArg = (args.find((a) => a.startsWith("--project=")) ?? "").split("=")[1] ?? "";
  const values = loadValues(args);

  const problems = validateApprovals(values);
  if (problems.length) {
    console.error(`\nREFUSED: the supplied --values file has structural problems:\n`);
    for (const p of problems) console.error(`  • ${p}`);
    console.error("");
    process.exit(2);
  }

  const doc = buildDoc(values);

  console.log(`\nchildcare jurisdiction seed — ${apply ? "APPLY" : "DRY RUN (nothing will be written)"}`);
  console.log(`jurisdiction_care_policies/${STATE}   policyVersion: ${POLICY_VERSION}\n`);
  console.log("Operational fields (written by this script):");
  for (const [k, v] of Object.entries(OPERATIONAL)) {
    console.log(`  ${k} = ${JSON.stringify(v)}`);
  }

  const stillMissing = EXTERNAL_FIELDS.filter((f) => isUnpopulated(getPath(doc, f)));
  const supplied = EXTERNAL_FIELDS.filter((f) => !isUnpopulated(getPath(doc, f)));

  if (supplied.length) {
    console.log(`\nExternal references supplied via --values (${supplied.length}):`);
    for (const f of supplied) console.log(`  ✓ ${f}`);
  }
  if (stillMissing.length) {
    console.log(`\nStill unpopulated (${stillMissing.length}) — governance, NOT a runtime blocker:`);
    for (const f of stillMissing) console.log(`  ○ ${f}`);
    console.log("\n  Childcare WILL operate without these. childcare:deploy-plan will keep");
    console.log("  reporting jurisdiction_incomplete until they are recorded, because");
    console.log("  evaluatePolicyReadiness (checklist-only) requires them.");
  }

  console.log(`\nNOT written here: pricing.*Ref — run scripts/seed-childcare-pricing.mjs.\n`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply --project=<projectId> to write.\n");
    return;
  }
  if (!projectArg) {
    console.error("REFUSED: --apply requires --project=<projectId> naming the target project.\n");
    process.exit(2);
  }

  // firebase-admin is CJS; ESM dynamic import wraps it under .default —
  // admin.apps would be undefined and .length throws before initializeApp.
  const adminMod = await import("firebase-admin");
  const admin = adminMod.default ?? adminMod;
  if (!admin.apps.length) admin.initializeApp();
  const resolved = admin.app().options.projectId
    ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  if (resolved !== projectArg) {
    console.error(`REFUSED: credential project "${resolved}" != --project "${projectArg}".\n`);
    process.exit(2);
  }

  // merge:true so this never clobbers pricing.*Ref written by the pricing seeder,
  // nor external references recorded by an earlier run with a --values file.
  await admin.firestore().collection("jurisdiction_care_policies").doc(STATE)
    .set(doc, { merge: true });

  console.log(`✅ wrote jurisdiction_care_policies/${STATE} to ${projectArg}\n`);
}

main().catch((err) => {
  console.error("seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
