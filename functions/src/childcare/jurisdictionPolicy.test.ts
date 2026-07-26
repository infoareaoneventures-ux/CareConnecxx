// U1 (childcare marketplace plan 2026-07-22-002): jurisdiction policy is
// FAIL-CLOSED. Every incomplete combination — unknown state, disabled status,
// expired policy, missing insurance/legal evidence, deferred category,
// transport without MVR, unset pricing, stale approval version, emergency-off
// — must produce a structured readiness issue and block activation.
//
// NOTE (plan U1 test scenarios): "client policy mutation" denial is Firestore
// Rules work owned by U2 (tests/firestoreRules.childcare.test.ts). It is NOT
// faked here — today jurisdiction_care_policies has no rules block, so the
// rules catch-all default-denies clients; U2 pins that with emulator tests.

import { describe, it, expect } from "vitest";
import {
  CA_PILOT_POLICY_SEED,
  CHILDCARE_CONSENT_VERSION_KEYS,
  CHILDCARE_PRICING_REF_KEYS,
  DEFAULT_SCREENING_RENEWAL_MONTHS,
  DEFERRED_CHILDCARE_CATEGORIES,
  REQUIRED_APPROVAL_KINDS,
  SHARED_BASE_CHECKR_PACKAGE_REF,
  assertEnableableChildcareCategory,
  evaluateJurisdictionReadiness,
  evaluatePolicyReadiness,
  isDeferredChildcareCategory,
  loadJurisdictionPolicy,
  normalizeStateCode,
  resolveChildcareCheckrPackage,
  screeningRenewalMonths,
} from "./jurisdictionPolicy";
import type { ApprovalReference, JurisdictionCarePolicy } from "./jurisdictionPolicy";

const NOW = new Date("2026-07-22T12:00:00.000Z");

function approval(overrides: Partial<ApprovalReference> = {}): ApprovalReference {
  return {
    referenceId: "REF-123",
    issuedBy: "Example Issuer LLP",
    approvedOn: "2026-07-20",
    policyVersion: "CA-2026-07-22.1",
    expiresOn: null,
    ...overrides,
  };
}

/** A fully populated, activatable policy — proves the fail-closed list is completable. */
function completePolicy(overrides: Partial<JurisdictionCarePolicy> = {}): JurisdictionCarePolicy {
  return {
    ...CA_PILOT_POLICY_SEED,
    guardianProcessRef: "docs/counsel/CA-guardian-process-v1",
    incidentContacts: ["ops-oncall@example.test"],
    reportingObligationsRef: "docs/counsel/CA-mandated-reporting-v1",
    insuranceEvidenceRefs: ["COI-2026-0042"],
    consentVersions: {
      terms: "childcare-terms-v1",
      privacy: "childcare-privacy-v1",
      screeningDisclosure: "childcare-screening-disclosure-v1",
      guardianAttestation: "childcare-guardian-attestation-v1",
      communicationConsent: "childcare-communication-consent-v1",
      childcarePolicy: "childcare-policy-v1",
    },
    pricing: {
      familyEntitlementRef: "price_TEST_family_entitlement",
      caregiverFeeRef: "price_TEST_caregiver_fee",
      screeningFeeRef: "price_TEST_screening_fee",
      siblingPolicyRef: "policy_TEST_sibling",
      cancellationPolicyRef: "policy_TEST_cancellation",
      refundPolicyRef: "policy_TEST_refund",
    },
    approvals: {
      legalCounsel: approval({ referenceId: "COUNSEL-MEMO-9" }),
      insurance: approval({ referenceId: "COI-2026-0042" }),
      jurisdictionScreeningProgram: approval({ referenceId: "TRUSTLINE-777" }),
    },
    ...overrides,
  };
}

function issueCodes(policy: Partial<JurisdictionCarePolicy> | null, expectedState?: string): string[] {
  return evaluatePolicyReadiness(policy, { now: NOW, expectedState }).map((i) => i.code);
}

// Minimal injectable Firestore fake (pattern: data/seniorProfileRepository.test.ts).
function makeDb(docs: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  const db = {
    collection: (coll: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const p = `${coll}/${id}`;
          reads.push(p);
          return { exists: p in docs, data: () => docs[p] };
        },
      }),
    }),
  } as any;
  return { db, reads };
}

describe("evaluatePolicyReadiness — fail-closed scenarios", () => {
  it("a complete policy is activatable with ZERO issues (the checklist is completable)", () => {
    const issues = evaluatePolicyReadiness(completePolicy(), { now: NOW, expectedState: "CA" });
    expect(issues).toEqual([]);
  });

  it("unknown state (no document) fails closed with policy_absent", () => {
    expect(issueCodes(null, "TX")).toEqual(["policy_absent"]);
  });

  it("explicitly disabled status blocks activation", () => {
    expect(issueCodes(completePolicy({ status: "disabled" }))).toContain("policy_disabled");
  });

  it("an unknown status value fails closed", () => {
    expect(issueCodes(completePolicy({ status: "launched" as any }))).toContain("policy_status_invalid");
  });

  it("expired policy blocks activation", () => {
    expect(issueCodes(completePolicy({ expiresOn: "2026-07-01" }))).toContain("policy_expired");
    // Future expiry is fine.
    expect(issueCodes(completePolicy({ expiresOn: "2027-01-01" }))).toEqual([]);
  });

  it("missing insurance evidence and missing legal approval are reported individually", () => {
    const codes = evaluatePolicyReadiness(
      completePolicy({
        insuranceEvidenceRefs: [],
        approvals: { ...completePolicy().approvals, legalCounsel: null },
      }),
      { now: NOW },
    );
    expect(codes.map((i) => i.code)).toContain("insurance_evidence_missing");
    expect(codes.filter((i) => i.code === "approval_reference_missing").map((i) => i.field)).toEqual([
      "approvals.legalCounsel",
    ]);
  });

  it("FILL_IN placeholder values count as unpopulated (mvrConfig convention)", () => {
    const codes = issueCodes(
      completePolicy({
        guardianProcessRef: "FILL_IN_GUARDIAN_PROCESS",
        insuranceEvidenceRefs: ["FILL_IN_COI"],
      }),
    );
    expect(codes).toContain("guardian_process_missing");
    expect(codes).toContain("insurance_evidence_missing");
  });

  it("every DEFERRED category is hard-blocked (overnight/medication/infant/specialized)", () => {
    for (const deferred of DEFERRED_CHILDCARE_CATEGORIES) {
      const codes = issueCodes(
        completePolicy({ approvedServiceCategories: ["babysitting", deferred] }),
      );
      expect(codes, deferred).toContain("deferred_category_enabled");
      expect(isDeferredChildcareCategory(deferred)).toBe(true);
      expect(() => assertEnableableChildcareCategory(deferred)).toThrow(/DEFERRED/);
    }
  });

  it("an unknown category fails closed (allowlist, not blocklist)", () => {
    expect(issueCodes(completePolicy({ approvedServiceCategories: ["pony_rides"] }))).toContain("unknown_category");
    expect(() => assertEnableableChildcareCategory("pony_rides")).toThrow(/Unknown/);
    expect(() => assertEnableableChildcareCategory("babysitting")).not.toThrow();
  });

  it("empty category list blocks activation", () => {
    expect(issueCodes(completePolicy({ approvedServiceCategories: [] }))).toContain("no_service_categories");
  });

  it("transport enabled without the MVR requirement is blocked", () => {
    expect(
      issueCodes(completePolicy({ transport: { enabled: true, requiresMvr: false } })),
    ).toContain("transport_without_mvr");
    // Transport WITH MVR required is acceptable at the policy layer.
    expect(issueCodes(completePolicy({ transport: { enabled: true, requiresMvr: true } }))).toEqual([]);
  });

  it("caregiver minimum age below 18 (or missing) is invalid", () => {
    expect(issueCodes(completePolicy({ caregiverMinimumAge: 17 }))).toContain("caregiver_minimum_age_invalid");
    expect(issueCodes(completePolicy({ caregiverMinimumAge: undefined as any }))).toContain(
      "caregiver_minimum_age_invalid",
    );
  });

  it("screening package must be the shared base package reference (R26 as amended)", () => {
    const bad = completePolicy();
    bad.screening = { ...bad.screening, checkrPackageRef: "some_other_package" };
    expect(issueCodes(bad)).toContain("screening_package_mismatch");
    // Both the sentinel and the resolved literal package are accepted.
    const literal = completePolicy();
    literal.screening = { ...literal.screening, checkrPackageRef: resolveChildcareCheckrPackage() };
    expect(issueCodes(literal)).toEqual([]);
    expect(SHARED_BASE_CHECKR_PACKAGE_REF).toBe("shared-base-package");
  });

  it("screening renewal defaults to annual and rejects invalid overrides", () => {
    const noOverride = completePolicy();
    noOverride.screening = { checkrPackageRef: SHARED_BASE_CHECKR_PACKAGE_REF, components: ["ssn_trace"] };
    expect(screeningRenewalMonths(noOverride)).toBe(DEFAULT_SCREENING_RENEWAL_MONTHS);
    const override = completePolicy();
    override.screening = { ...override.screening, renewalMonths: 6 };
    expect(screeningRenewalMonths(override)).toBe(6);
    const invalid = completePolicy();
    invalid.screening = { ...invalid.screening, renewalMonths: 0 };
    expect(issueCodes(invalid)).toContain("screening_renewal_invalid");
  });

  it("every unset pricing ref blocks activation individually (R40 — no invented pricing)", () => {
    const issues = evaluatePolicyReadiness(completePolicy({ pricing: CA_PILOT_POLICY_SEED.pricing }), { now: NOW });
    const pricingFields = issues.filter((i) => i.code === "pricing_unset").map((i) => i.field).sort();
    expect(pricingFields).toEqual(
      [...CHILDCARE_PRICING_REF_KEYS].map((k) => `pricing.${k}`).sort(),
    );
  });

  it("policy version transition invalidates every approval until re-approved", () => {
    const transitioned = completePolicy({ policyVersion: "CA-2026-08-01.2" });
    const issues = evaluatePolicyReadiness(transitioned, { now: NOW });
    const stale = issues.filter((i) => i.code === "approval_reference_stale_version").map((i) => i.field).sort();
    expect(stale).toEqual([...REQUIRED_APPROVAL_KINDS].map((k) => `approvals.${k}`).sort());
    expect(issues.length).toBe(REQUIRED_APPROVAL_KINDS.length); // nothing else broke
  });

  it("an expired approval reference blocks activation", () => {
    const p = completePolicy();
    p.approvals = { ...p.approvals, insurance: approval({ expiresOn: "2026-06-30" }) };
    expect(issueCodes(p)).toContain("approval_reference_expired");
  });

  it("emergency-off at the policy level blocks activation", () => {
    expect(issueCodes(completePolicy({ emergencyOff: true }))).toEqual(["emergency_off"]);
  });

  it("a malformed document reports issues instead of throwing", () => {
    const codes = issueCodes({ state: "CA" } as Partial<JurisdictionCarePolicy>, "CA");
    expect(codes.length).toBeGreaterThan(5);
    expect(codes).toContain("policy_status_invalid");
    expect(codes).toContain("screening_missing");
    expect(codes).not.toContain("state_mismatch");
  });
});

describe("CA pilot seed shape — structurally sound, deliberately NOT activatable", () => {
  it("is blocked until concrete approval references are populated", () => {
    const issues = evaluatePolicyReadiness(CA_PILOT_POLICY_SEED, { now: NOW, expectedState: "CA" });
    expect(issues.length).toBeGreaterThan(0);
    const codes = new Set(issues.map((i) => i.code));
    // Founder attestation does not populate the record — these must all be open:
    expect(codes.has("approval_reference_missing")).toBe(true);
    expect(codes.has("insurance_evidence_missing")).toBe(true);
    expect(codes.has("pricing_unset")).toBe(true);
    expect(codes.has("consent_version_missing")).toBe(true);
    expect(codes.has("guardian_process_missing")).toBe(true);
    expect(codes.has("incident_contacts_missing")).toBe(true);
    expect(codes.has("reporting_obligations_missing")).toBe(true);
  });

  it("the seed's open items are EXACTLY the founder checklist (no structural issues)", () => {
    const fields = evaluatePolicyReadiness(CA_PILOT_POLICY_SEED, { now: NOW, expectedState: "CA" })
      .map((i) => i.field)
      .sort();
    const expected = [
      "guardianProcessRef",
      "incidentContacts",
      "reportingObligationsRef",
      "insuranceEvidenceRefs",
      ...CHILDCARE_CONSENT_VERSION_KEYS.map((k) => `consentVersions.${k}`),
      ...CHILDCARE_PRICING_REF_KEYS.map((k) => `pricing.${k}`),
      ...REQUIRED_APPROVAL_KINDS.map((k) => `approvals.${k}`),
    ].sort();
    expect(fields).toEqual(expected);
  });

  it("contains no deferred category, an 18+ age floor, shared package, and annual renewal", () => {
    for (const c of CA_PILOT_POLICY_SEED.approvedServiceCategories) {
      expect(isDeferredChildcareCategory(c), c).toBe(false);
    }
    expect(CA_PILOT_POLICY_SEED.caregiverMinimumAge).toBeGreaterThanOrEqual(18);
    expect(CA_PILOT_POLICY_SEED.screening.checkrPackageRef).toBe(SHARED_BASE_CHECKR_PACKAGE_REF);
    expect(screeningRenewalMonths(CA_PILOT_POLICY_SEED)).toBe(12);
    expect(CA_PILOT_POLICY_SEED.transport.enabled).toBe(false);
    expect(CA_PILOT_POLICY_SEED.transport.requiresMvr).toBe(true);
  });

  it("never invents pricing — no senior amount appears anywhere in the seed", () => {
    const serialized = JSON.stringify(CA_PILOT_POLICY_SEED);
    expect(serialized).not.toMatch(/29\.95|54\.99|2995|5499/);
    for (const k of CHILDCARE_PRICING_REF_KEYS) {
      expect(CA_PILOT_POLICY_SEED.pricing[k]).toBeNull();
    }
  });
});

describe("loader + readiness gate (injectable db)", () => {
  it("unknown/absent state doc ⇒ not activatable with policy_absent", async () => {
    const { db } = makeDb({});
    const r = await evaluateJurisdictionReadiness("tx", { db, now: NOW });
    expect(r.state).toBe("TX");
    expect(r.activatable).toBe(false);
    expect(r.policyVersion).toBeNull();
    expect(r.issues.map((i) => i.code)).toEqual(["policy_absent"]);
  });

  it("normalizes the state code and reads jurisdiction_care_policies/{STATE}", async () => {
    const { db, reads } = makeDb({
      "jurisdiction_care_policies/CA": completePolicy() as unknown as Record<string, unknown>,
    });
    const r = await evaluateJurisdictionReadiness(" ca ", { db, now: NOW });
    expect(reads).toEqual(["jurisdiction_care_policies/CA"]);
    expect(r.activatable).toBe(true);
    expect(r.policyVersion).toBe("CA-2026-07-22.1");
    expect(normalizeStateCode(" ca ")).toBe("CA");
  });

  it("a doc stored under the wrong state reports state_mismatch", async () => {
    const { db } = makeDb({
      "jurisdiction_care_policies/NV": completePolicy() as unknown as Record<string, unknown>, // state:"CA" inside
    });
    const r = await evaluateJurisdictionReadiness("NV", { db, now: NOW });
    expect(r.activatable).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("state_mismatch");
  });

  it("loadJurisdictionPolicy returns null for an empty state without touching Firestore", async () => {
    const { db, reads } = makeDb({});
    expect(await loadJurisdictionPolicy("  ", db)).toBeNull();
    expect(reads).toEqual([]);
  });

  it("the seeded CA shape loaded from Firestore is still blocked (fail-closed end to end)", async () => {
    const { db } = makeDb({
      "jurisdiction_care_policies/CA": CA_PILOT_POLICY_SEED as unknown as Record<string, unknown>,
    });
    const r = await evaluateJurisdictionReadiness("CA", { db, now: NOW });
    expect(r.activatable).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("approval_reference_missing");
  });
});
