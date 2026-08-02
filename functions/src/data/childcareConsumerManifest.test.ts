// U0 (childcare marketplace plan 2026-07-22-002): the consumer manifest is only
// trustworthy if its entries stay mechanically valid — every sourceFile is a
// real file at HEAD (a renamed/deleted consumer must be re-classified, not
// silently orphaned), consumer names are unique, and every entry names a valid
// disposition and owner unit. The companion source scan (unregistered
// consumers) lives in scripts/audit-childcare-consumers.mjs.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  CHILDCARE_CONSUMER_MANIFEST,
  SHARED_VERTICAL_COLLECTIONS,
  consumersByDisposition,
  registeredSourceFiles,
} from "./childcareConsumerManifest";
import type { CareVerticalDisposition } from "./childcareConsumerManifest";

// functions/src/data → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const VALID_DISPOSITIONS: CareVerticalDisposition[] = [
  "shared-vertical-aware",
  "senior-only-explicit-skip",
  "child-specific",
  "legacy-compat-remove-after-migration",
  "disabled-before-childcare",
];

describe("childcare consumer manifest — structural validity (U0)", () => {
  it("every entry references a real file at HEAD", () => {
    const missing = CHILDCARE_CONSUMER_MANIFEST
      .filter((e) => !fs.existsSync(path.join(REPO_ROOT, e.sourceFile)))
      .map((e) => e.sourceFile);
    expect(
      missing,
      `Manifest entries reference files that do not exist (renamed/deleted consumers must be re-classified):\n  ${missing.join("\n  ")}`
    ).toEqual([]);
  });

  it("consumerName is unique across the manifest", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of CHILDCARE_CONSUMER_MANIFEST) {
      if (seen.has(e.consumerName)) dupes.push(e.consumerName);
      seen.add(e.consumerName);
    }
    expect(dupes, `Duplicate consumerName entries:\n  ${dupes.join("\n  ")}`).toEqual([]);
  });

  it("sourceFile is unique (one classification per file)", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of CHILDCARE_CONSUMER_MANIFEST) {
      if (seen.has(e.sourceFile)) dupes.push(e.sourceFile);
      seen.add(e.sourceFile);
    }
    expect(dupes, `Files classified twice:\n  ${dupes.join("\n  ")}`).toEqual([]);
  });

  it("every entry has a valid disposition and owner unit", () => {
    for (const e of CHILDCARE_CONSUMER_MANIFEST) {
      expect(VALID_DISPOSITIONS, `${e.consumerName}: invalid disposition "${e.disposition}"`).toContain(e.disposition);
      expect(e.ownerUnit, `${e.consumerName}: invalid ownerUnit "${e.ownerUnit}"`).toMatch(/^U([1-9]|1[0-4])$/);
    }
  });

  it("every listed collection is a known shared collection", () => {
    const known = new Set(SHARED_VERTICAL_COLLECTIONS);
    for (const e of CHILDCARE_CONSUMER_MANIFEST) {
      for (const c of e.collections) {
        expect(known.has(c), `${e.consumerName}: "${c}" is not in SHARED_VERTICAL_COLLECTIONS`).toBe(true);
      }
    }
  });

  it("entries with no direct collection literal carry an explanatory note", () => {
    // Empty collections is only legitimate for registered seams that consume
    // shared data indirectly — the note must say how.
    const silent = CHILDCARE_CONSUMER_MANIFEST
      .filter((e) => e.collections.length === 0 && !e.notes)
      .map((e) => e.consumerName);
    // Scheduled/trigger modules are registered wholesale by U0 (plan appendix)
    // even when they touch shared data only via helpers; those are exempt.
    const exempt = silent.filter(
      (n) => !n.startsWith("functions/src/scheduled/") && !n.startsWith("functions/src/triggers/")
    );
    expect(
      exempt,
      `Entries with no collections and no note (explain the indirect consumption):\n  ${exempt.join("\n  ")}`
    ).toEqual([]);
  });

  it("no disposition bucket is malformed and child-specific is exactly the U1 policy/flag consumers", () => {
    const buckets = consumersByDisposition();
    const total = Object.values(buckets).reduce((n, b) => n + b.length, 0);
    expect(total).toBe(CHILDCARE_CONSUMER_MANIFEST.length);
    // Deliberately updated by U1 (jurisdiction policy + childcare flags),
    // U2 (household/authority modules), U3 (child profiles, restricted
    // files, privacy lifecycle), U4 (family signup ingress, consent
    // receipts, identity gate, secure child-profile form), U5 (provider
    // vertical profile, screening evidence, eligibility), U6 (jobs,
    // applications, interviews, matching gate), U7 (booking state
    // machine, booking callables, safety projection), U8 (payment policy,
    // shift payments, reviews, reputation projection + its trigger), and U9
    // (conversation policy/callables + notification privacy policy). The next
    // addition (U10+ consumers) must update this expectation deliberately too.
    expect(buckets["child-specific"].map((e) => e.consumerName).sort()).toEqual([
      // U12 (deliberate addition): the operator incident queue UI
      // (callable-only — no direct Firestore access).
      "components/admin/ChildcareIncidentQueue",
      "components/client/childcare/ChildProfileFlow",
      // Front door STAGE 2 (deliberate additions): the conversational childcare
      // caregiver funnel's turn handler and its U5 enrollment wiring. They live
      // under agents/** because the funnel is a model turn, but they are
      // child-specific consumers and are classified as such.
      "functions/src/agents/childcareCaregiverEnrollment",
      "functions/src/agents/childcareCaregiverFunnelTurn",
      // U10 (deliberate additions): the childcare context envelope, the
      // family-side MCP tool pack, and the deterministic incident seam.
      "functions/src/agents/childcareSituation",
      // U14 (deliberate addition): the production-only App Check replay probe.
      "functions/src/childcare/appCheckProbe",
      "functions/src/childcare/authorityCallables",
      "functions/src/childcare/bookingCallables",
      "functions/src/childcare/bookingPolicy",
      "functions/src/childcare/childFileAccess",
      // U3 (deliberate additions): the restricted-file scan dispatch + result
      // consumers behind the authenticated delivery path.
      "functions/src/childcare/childFileScan",
      "functions/src/childcare/childFileScanResult",
      "functions/src/childcare/childProfileCallables",
      // U13 (deliberate addition): the privacy-safe canary watcher.
      "functions/src/childcare/childcareCanaryWatch",
      "functions/src/childcare/consentReceipts",
      "functions/src/childcare/conversationCallables",
      "functions/src/childcare/conversationPolicy",
      // U14 (deliberate addition): the deployment gate reads the rollout-hold +
      // migration report from childcare_canary_state.
      "functions/src/childcare/deployGate",
      // Pre-existing (U11 family read surface) — was missing from this pinned
      // list in the working tree; added here so the suite reflects the manifest.
      "functions/src/childcare/familyReadCallables",
      "functions/src/childcare/guardianAuthority",
      "functions/src/childcare/householdRepository",
      "functions/src/childcare/identityCallables",
      // U12 (deliberate additions): restricted incident cases (policy +
      // operator callables) over the U10 marker seam.
      "functions/src/childcare/incidentCallables",
      "functions/src/childcare/incidentPolicy",
      "functions/src/childcare/incidentSignal",
      "functions/src/childcare/jobCallables",
      "functions/src/childcare/jurisdictionPolicy",
      "functions/src/childcare/matchingEligibility",
      "functions/src/childcare/notificationPolicy",
      // U13 (deliberate additions): the exact-object operator access policy and
      // its limited-use callable.
      "functions/src/childcare/operatorAccess",
      "functions/src/childcare/operatorCallables",
      "functions/src/childcare/paymentPolicy",
      // U8 (deliberate addition): the durable dispute payout-hold worker.
      "functions/src/childcare/payoutHoldWorker",
      // U14 (deliberate addition): the R62 production-proof recorder writes the
      // evidence bundle to childcare_canary_state/deployment_proof.
      "functions/src/childcare/productionProofRecorder",
      "functions/src/childcare/providerEligibility",
      "functions/src/childcare/providerVerticalCallables",
      "functions/src/childcare/reputationProjection",
      "functions/src/childcare/reviewCallables",
      // U8 (deliberate addition): the operator review moderation callables.
      "functions/src/childcare/reviewModerationCallables",
      "functions/src/childcare/safetyProjection",
      "functions/src/childcare/screeningPolicy",
      // U7 (deliberate addition): the durable shift-generation worker.
      "functions/src/childcare/shiftGenerationOperations",
      "functions/src/childcare/shiftPayments",
      "functions/src/childcare/signupIngress",
      "functions/src/config/featureFlags",
      "functions/src/data/childProfileRepository",
      "functions/src/mcp/childcareTools",
      // U14 (deliberate addition): the migration reconciliation report writer.
      "functions/src/migrations/migrationReconciliation",
      "functions/src/privacy/dataLifecycle",
      "functions/src/scheduled/childcareLifecycleWorker",
      "functions/src/triggers/reviewProjection",
    ]);
  });

  it("the review-named high-risk seams are registered explicitly", () => {
    const files = registeredSourceFiles();
    for (const seam of [
      "functions/src/utils/appointmentDoc.ts",
      "functions/src/linq/routeIntent.ts",
      "functions/src/linq/inboundHelpers.ts",
      "functions/src/agents/careRecipients.ts",
      "functions/src/ai/caregiverReputation.ts",
      "functions/src/ai/feedback.ts",
      "functions/src/ai/outcomeAnalytics.ts",
      "services/server/matchingEngine.ts",
    ]) {
      expect(files.has(seam), `Review-named seam missing from manifest: ${seam}`).toBe(true);
    }
  });
});
