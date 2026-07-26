// U5 (childcare marketplace plan 2026-07-22-002): the R28 childcare-visibility
// gate — complete profile AND credentials AND current screening AND MANUAL
// approval AND current policy acceptance AND jurisdiction eligibility AND no
// suspension AND membership/payout readiness where required. Structured issue
// list; zero issues = eligible. Independence (R24/R31/AE9): senior eligibility
// is never consulted and never written.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CA_PILOT_POLICY_SEED,
  type ApprovalReference,
  type JurisdictionCarePolicy,
} from "./jurisdictionPolicy";
import type { ChildcareScreeningDoc } from "./screeningPolicy";
import {
  CHILDCARE_PROVIDER_ELIGIBILITY_VERSION,
  CHILDCARE_PROVIDER_SUMMARY_FIELD,
  computeMissingChildcareFields,
  evaluateChildcareProviderEligibility,
  recheckChildcareProviderEligibility,
  recomputeChildcareProviderVisibility,
  runChildcareScreeningExpirySweep,
  type ChildcareVerticalProfileDoc,
} from "./providerEligibility";
import { bustChildcareFlagsCache } from "../config/featureFlags";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const BASE_PKG = "checkrdirect_essential_criminal";

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.CHECKR_PACKAGE = BASE_PKG;
  bustChildcareFlagsCache();
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  bustChildcareFlagsCache();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

/** Fully populated, ACTIVATABLE CA policy (jurisdictionPolicy.test.ts idiom). */
function activatablePolicy(overrides: Partial<JurisdictionCarePolicy> = {}): JurisdictionCarePolicy {
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

function baseCaregiver(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Jane Doe",
    email: "jane@example.test",
    phone: "+14085551234",
    city: "San Jose",
    state: "CA",
    zipCode: "95112",
    photo: "https://example.test/p.jpg",
    availability: { monday: ["morning"] },
    languages: ["English"],
    status: "active",
    membershipStatus: "active",
    // Senior-side fields — must never be consulted for childcare (AE9).
    onboardingStatus: "profile_complete",
    verificationStatus: "approved",
    ...overrides,
  };
}

function verticalProfile(overrides: Partial<ChildcareVerticalProfileDoc> = {}): ChildcareVerticalProfileDoc {
  return {
    careVertical: "child",
    caregiverUid: "cg-1",
    ageBands: ["toddler", "preschool"],
    services: ["babysitting", "after_school_care"],
    yearsChildcareExperience: 4,
    references: ["Family reference A"],
    credentials: [],
    hourlyRate: 28,
    availabilityOverrides: null,
    transport: { offersTransport: false },
    limitations: [],
    jurisdictionState: "CA",
    adultAgeAttested: true,
    acceptedPolicyVersion: "CA-2026-07-22.1",
    acceptedPolicyAt: "2026-07-20T00:00:00.000Z",
    approval: { state: "approved", decidedByUid: "op-1", decidedAt: "2026-07-21T00:00:00.000Z", auditRef: "a1" },
    suspension: { active: false, code: null, suspendedByUid: null, suspendedAt: null },
    profileVersion: 2,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function clearScreening(overrides: Partial<ChildcareScreeningDoc> = {}): ChildcareScreeningDoc {
  return {
    careVertical: "child",
    caregiverUid: "cg-1",
    packageSlug: BASE_PKG,
    packageRef: "shared-base-package",
    jurisdictionState: "CA",
    requiredComponents: [...CA_PILOT_POLICY_SEED.screening.components],
    renewalMonths: 12,
    checkr: { candidateId: "cand_1", invitationId: "inv_1", reportId: "rep_1", invitationStatus: "completed" },
    evidenceStatus: "clear",
    evidenceSource: "checkr_webhook",
    reportCompletedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2027-07-01T00:00:00.000Z",
    adverseAction: { state: "none", updatedAt: null },
    policyVersion: "CA-2026-07-22.1",
    eligibilityVersion: 3,
    appliedEventIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function evaluate(overrides: {
  caregiver?: Record<string, unknown>;
  verticalProfile?: Partial<ChildcareVerticalProfileDoc> | null;
  screening?: Partial<ChildcareScreeningDoc> | null;
  policy?: Partial<JurisdictionCarePolicy> | null;
  requirements?: { membership?: boolean; payoutReadiness?: boolean };
} = {}) {
  return evaluateChildcareProviderEligibility({
    caregiver: overrides.caregiver ?? baseCaregiver(),
    verticalProfile: overrides.verticalProfile === undefined ? verticalProfile() : overrides.verticalProfile,
    screening: overrides.screening === undefined ? clearScreening() : overrides.screening,
    policy: overrides.policy === undefined ? activatablePolicy() : overrides.policy,
    now: NOW,
    requirements: overrides.requirements,
  });
}

const codesOf = (r: ReturnType<typeof evaluate>) => r.issues.map((i) => i.code);

// ── AE21 base reuse ──────────────────────────────────────────────────────────

describe("computeMissingChildcareFields — AE21 base reuse, never re-ask", () => {
  it("existing provider with full base: every base field reused, only childcare delta missing", () => {
    const m = computeMissingChildcareFields(baseCaregiver(), null);
    expect(m.missingBaseFields).toEqual([]);
    expect(m.reusedBaseFields).toContain("name");
    expect(m.reusedBaseFields).toContain("email");
    expect(m.reusedBaseFields).toContain("photo");
    // Everything childcare-specific is still owed — but NOTHING base is re-asked.
    expect(m.missingChildcareFields).toContain("ageBands");
    expect(m.missingChildcareFields).toContain("services");
    expect(m.missingChildcareFields).toContain("adultAgeAttested");
    expect(m.missingChildcareFields).not.toContain("name");
    expect(m.missingChildcareFields).not.toContain("email");
  });

  it("new provider missing base fields: base-then-delta", () => {
    const m = computeMissingChildcareFields({ name: "Jane" }, null);
    expect(m.reusedBaseFields).toEqual(["name"]);
    expect(m.missingBaseFields).toContain("email");
    expect(m.missingBaseFields).toContain("city");
  });

  it("complete vertical profile owes nothing", () => {
    const m = computeMissingChildcareFields(baseCaregiver(), verticalProfile());
    expect(m.missingChildcareFields).toEqual([]);
  });
});

// ── The R28 gate ─────────────────────────────────────────────────────────────

describe("evaluateChildcareProviderEligibility — the R28 AND-gate", () => {
  it("everything current ⇒ eligible with the version stamp and safe labels", () => {
    const r = evaluate();
    expect(r.issues).toEqual([]);
    expect(r.eligible).toBe(true);
    expect(r.eligibilityVersion).toBe(CHILDCARE_PROVIDER_ELIGIBILITY_VERSION);
    expect(r.evidenceVersion).toBe(3);
    expect(r.evidenceLabels).toEqual(
      expect.arrayContaining(["background_check_current", "childcare_reviewed", "childcare_policy_accepted"]),
    );
    // R30: labels are slugs, never narrative or universal safety language.
    for (const label of r.evidenceLabels) expect(label).toMatch(/^[a-z_]+$/);
  });

  it("CLEAR SCREENING ALONE IS NOT VISIBILITY: no manual approval ⇒ ineligible (R27/R28/AE10)", () => {
    const r = evaluate({
      verticalProfile: verticalProfile({
        approval: { state: "none", decidedByUid: null, decidedAt: null, auditRef: null },
      }),
    });
    expect(r.eligible).toBe(false);
    expect(codesOf(r)).toContain("manual_approval_missing");
  });

  it("revoked manual approval removes eligibility", () => {
    const r = evaluate({
      verticalProfile: verticalProfile({
        approval: { state: "revoked", decidedByUid: "op-1", decidedAt: NOW.toISOString(), auditRef: "a2" },
      }),
    });
    expect(codesOf(r)).toContain("manual_approval_revoked");
  });

  it("missing vertical profile fails closed", () => {
    const r = evaluate({ verticalProfile: null });
    expect(r.eligible).toBe(false);
    expect(codesOf(r)).toContain("vertical_profile_missing");
  });

  it("incomplete childcare fields (incl. adult-age failure) block eligibility", () => {
    const r = evaluate({ verticalProfile: verticalProfile({ ageBands: [], adultAgeAttested: false }) });
    const codes = codesOf(r);
    expect(codes).toContain("profile_incomplete");
    expect(r.issues.some((i) => i.field === "adultAgeAttested")).toBe(true);
  });

  it("expired jurisdiction-required credential blocks eligibility", () => {
    const policy = activatablePolicy({
      credentialRules: { requiredCredentials: ["child_safety_cert"] },
    });
    const r = evaluate({
      policy,
      verticalProfile: verticalProfile({
        credentials: [{ type: "child_safety_cert", expiresOn: "2026-01-01T00:00:00.000Z" }],
      }),
    });
    expect(codesOf(r)).toContain("credential_expired");
  });

  it("screening pending / expired / adverse each block through the screening evaluator", () => {
    expect(codesOf(evaluate({ screening: clearScreening({ evidenceStatus: "pending" }) }))).toContain("evidence_pending");
    expect(codesOf(evaluate({ screening: clearScreening({ expiresAt: "2026-07-01T00:00:00.000Z" }) }))).toContain("report_expired");
    expect(
      codesOf(evaluate({ screening: clearScreening({ adverseAction: { state: "post_adverse", updatedAt: NOW.toISOString() } }) })),
    ).toContain("adverse_action_active");
  });

  it("policy-version change invalidates the policy acceptance (policy_acceptance_stale)", () => {
    const r = evaluate({
      policy: activatablePolicy({
        policyVersion: "CA-2026-08-01.2",
        approvals: {
          legalCounsel: approval({ policyVersion: "CA-2026-08-01.2" }),
          insurance: approval({ policyVersion: "CA-2026-08-01.2" }),
          jurisdictionScreeningProgram: approval({ policyVersion: "CA-2026-08-01.2" }),
        },
      }),
    });
    expect(codesOf(r)).toContain("policy_acceptance_stale");
  });

  it("non-activatable jurisdiction (the unfinished CA seed) blocks everything", () => {
    const r = evaluate({ policy: CA_PILOT_POLICY_SEED });
    expect(codesOf(r)).toContain("jurisdiction_not_ready");
  });

  it("suspension and base account pause both remove childcare visibility", () => {
    expect(
      codesOf(evaluate({
        verticalProfile: verticalProfile({
          suspension: { active: true, code: "operator_suspension", suspendedByUid: "op-1", suspendedAt: NOW.toISOString() },
        }),
      })),
    ).toContain("suspension_active");
    expect(codesOf(evaluate({ caregiver: baseCaregiver({ status: "paused" }) }))).toContain("base_account_paused");
  });

  it("membership required by default; payout readiness only for payout-sensitive rechecks", () => {
    expect(codesOf(evaluate({ caregiver: baseCaregiver({ membershipStatus: "inactive" }) }))).toContain("membership_inactive");
    // Default: payout not required.
    expect(codesOf(evaluate())).not.toContain("payout_not_ready");
    // Payout-sensitive: required.
    const r = evaluate({ requirements: { payoutReadiness: true } });
    expect(codesOf(r)).toContain("payout_not_ready");
    const ready = evaluate({
      caregiver: baseCaregiver({ stripeAccountId: "acct_1", payoutsEnabled: true }),
      requirements: { payoutReadiness: true },
    });
    expect(codesOf(ready)).not.toContain("payout_not_ready");
  });

  it("AE9 INDEPENDENCE: senior verificationStatus is never consulted — childcare eligibility comes from the per-vertical records", () => {
    // A caregiver whose SENIOR verification was rejected but whose childcare
    // records are all current stays childcare-eligible: verticals are
    // independent, and adverse base events reach childcare through the
    // provider-ID-matched webhook mirror, never through the senior field.
    const r = evaluate({
      caregiver: baseCaregiver({ verificationStatus: "rejected", onboardingStatus: "incomplete" }),
    });
    expect(r.eligible).toBe(true);
  });
});

// ── Transport capability (AE13 — MVR optional vs required) ──────────────────

describe("transport capability — derived, never blocking (AE13)", () => {
  const transportPolicy = activatablePolicy({ transport: { enabled: true, requiresMvr: true } });

  it("offers transport + MVR required + NO MVR evidence ⇒ still eligible, transport withheld", () => {
    const r = evaluate({
      policy: transportPolicy,
      verticalProfile: verticalProfile({ transport: { offersTransport: true } }),
    });
    expect(r.eligible).toBe(true);
    expect(r.capabilities.transport).toBe(false);
    expect(r.evidenceLabels).not.toContain("transport_capable");
  });

  it("offers transport + current MVR evidence ⇒ transport capable", () => {
    const r = evaluate({
      policy: transportPolicy,
      caregiver: baseCaregiver({ isApprovedDriver: true, mvrStatus: "clear" }),
      verticalProfile: verticalProfile({ transport: { offersTransport: true } }),
    });
    expect(r.capabilities.transport).toBe(true);
    expect(r.evidenceLabels).toContain("transport_capable");
  });

  it("jurisdiction transport disabled ⇒ never transport capable (CA pilot)", () => {
    const r = evaluate({
      caregiver: baseCaregiver({ isApprovedDriver: true, mvrStatus: "clear" }),
      verticalProfile: verticalProfile({ transport: { offersTransport: true } }),
    });
    expect(r.capabilities.transport).toBe(false);
  });
});

// ── Fake Firestore (dot-path filters, deep merge, add()) ────────────────────

function makeDb(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initial));
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  let autoId = 0;

  const deepMerge = (prev: any, data: any): any => {
    const out: any = { ...(prev ?? {}) };
    for (const [k, v] of Object.entries(data ?? {})) {
      const both =
        v !== null && typeof v === "object" && !Array.isArray(v) &&
        out[k] !== null && typeof out[k] === "object" && !Array.isArray(out[k]);
      out[k] = both ? deepMerge(out[k], v) : v;
    }
    return out;
  };
  const dotGet = (obj: any, path: string): unknown =>
    path.split(".").reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), obj);
  const applyDotPath = (target: Record<string, unknown>, key: string, value: unknown) => {
    const parts = key.split(".");
    let obj: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = obj[parts[i]];
      obj[parts[i]] = existing && typeof existing === "object" ? { ...(existing as object) } : {};
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path), id: path.split("/").pop() }),
    set: async (data: any, opts?: any) => {
      writes.push({ path, data });
      docs.set(path, opts?.merge ? deepMerge(docs.get(path), data) : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND: ${path}`);
      writes.push({ path, data });
      const next = { ...(docs.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) applyDotPath(next, k, v);
      docs.set(path, next);
    },
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });

  const makeColl = (collPath: string, filters: Array<{ f: string; v: unknown }> = []): any => ({
    doc: (id?: string) => makeDocRef(`${collPath}/${id ?? `auto-${autoId++}`}`),
    add: async (data: any) => {
      const ref = makeDocRef(`${collPath}/auto-${autoId++}`);
      writes.push({ path: ref.path, data });
      docs.set(ref.path, { ...data });
      return ref;
    },
    where: (f: string, _op: string, v: unknown) => makeColl(collPath, [...filters, { f, v }]),
    get: async () => {
      const depth = collPath.split("/").length + 1;
      const rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${collPath}/`) && p.split("/").length === depth)
        .filter(([, d]) => filters.every((flt) => dotGet(d, flt.f) === flt.v))
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p) }));
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  return { db: { collection: (c: string) => makeColl(c) } as any, docs, writes };
}

const SENIOR_FIELDS = ["verified", "verificationStatus", "status", "onboardingStatus", "backgroundCheckData", "hourlyRate", "specialties"];

// ── recompute + AE9 parity ───────────────────────────────────────────────────

describe("recomputeChildcareProviderVisibility — parent summary, senior wall", () => {
  it("senior-only caregiver (no childcare docs): writes NOTHING (AE9 byte-identical)", async () => {
    const before = baseCaregiver();
    const { db, docs, writes } = makeDb({ "caregivers/cg-1": { ...before } });
    const summary = await recomputeChildcareProviderVisibility("cg-1", { db, now: NOW });
    expect(summary).toBeNull();
    expect(writes).toEqual([]);
    expect(docs.get("caregivers/cg-1")).toEqual(before);
  });

  it("childcare provider: writes ONLY the namespaced summary; senior fields untouched", async () => {
    const before = baseCaregiver({ backgroundCheckData: { status: "clear" }, hourlyRate: 30, specialties: ["dementia"] });
    const { db, docs } = makeDb({
      "caregivers/cg-1": { ...before },
      "caregivers/cg-1/vertical_profiles/child": verticalProfile() as any,
      "caregivers/cg-1/screenings/child": clearScreening() as any,
      "jurisdiction_care_policies/CA": activatablePolicy() as any,
    });
    const summary = await recomputeChildcareProviderVisibility("cg-1", { db, now: NOW });
    expect(summary).toMatchObject({ visible: true, approvalState: "approved", evidenceStatus: "clear" });
    const after = docs.get("caregivers/cg-1")! as any;
    expect(after[CHILDCARE_PROVIDER_SUMMARY_FIELD]).toMatchObject({ visible: true });
    for (const f of SENIOR_FIELDS) expect(after[f]).toEqual((before as any)[f]);
  });

  it("expired evidence / revocation ⇒ visible=false without touching senior fields (R31)", async () => {
    const before = baseCaregiver();
    const { db, docs } = makeDb({
      "caregivers/cg-1": { ...before },
      "caregivers/cg-1/vertical_profiles/child": verticalProfile() as any,
      "caregivers/cg-1/screenings/child": clearScreening({ evidenceStatus: "expired" }) as any,
      "jurisdiction_care_policies/CA": activatablePolicy() as any,
    });
    const summary = await recomputeChildcareProviderVisibility("cg-1", { db, now: NOW });
    expect(summary?.visible).toBe(false);
    const after = docs.get("caregivers/cg-1")! as any;
    for (const f of SENIOR_FIELDS) expect(after[f]).toEqual((before as any)[f]);
  });
});

describe("recheckChildcareProviderEligibility — the R29 seam", () => {
  it("payout-sensitive contexts require payout readiness; discovery does not", async () => {
    const seed = {
      "caregivers/cg-1": baseCaregiver(),
      "caregivers/cg-1/vertical_profiles/child": verticalProfile() as any,
      "caregivers/cg-1/screenings/child": clearScreening() as any,
      "jurisdiction_care_policies/CA": activatablePolicy() as any,
    };
    const { db } = makeDb(seed);
    const discovery = await recheckChildcareProviderEligibility("cg-1", { context: "discovery", db, now: NOW });
    expect(discovery.eligible).toBe(true);
    const payout = await recheckChildcareProviderEligibility("cg-1", { context: "payout", db, now: NOW });
    expect(payout.eligible).toBe(false);
    expect(payout.issues.map((i) => i.code)).toContain("payout_not_ready");
  });

  it("fails closed on load errors", async () => {
    const exploding: any = { collection: () => { throw new Error("boom"); } };
    const r = await recheckChildcareProviderEligibility("cg-1", { context: "contact", db: exploding });
    expect(r.eligible).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("recheck_error");
  });
});

// ── Expiry sweep (R31) ───────────────────────────────────────────────────────

describe("runChildcareScreeningExpirySweep — guarded, senior-safe", () => {
  function sweepSeed(screeningOverrides: Partial<ChildcareScreeningDoc> = {}) {
    return {
      "childcare_flags/global": {
        CHILDCARE_ENABLED: true, CHILDCARE_DISCOVERY_ENABLED: true,
        CHILDCARE_WRITES_ENABLED: true, CHILDCARE_PROACTIVE_ENABLED: true,
      },
      "caregivers/cg-1": baseCaregiver({
        backgroundCheckData: { status: "clear", completedAt: "2026-06-01T00:00:00.000Z" },
        [CHILDCARE_PROVIDER_SUMMARY_FIELD]: { visible: true, evidenceStatus: "clear" },
      }),
      "caregivers/cg-1/vertical_profiles/child": verticalProfile() as any,
      "caregivers/cg-1/screenings/child": clearScreening(screeningOverrides) as any,
      "jurisdiction_care_policies/CA": activatablePolicy() as any,
    } as Record<string, Record<string, unknown>>;
  }

  it("childcare flags OFF ⇒ the sweep skips entirely (senior sweep untouched)", async () => {
    const { db, writes } = makeDb({ "caregivers/cg-1": baseCaregiver() });
    const r = await runChildcareScreeningExpirySweep({ db, now: NOW });
    expect(r).toMatchObject({ skipped: true, scanned: 0, expired: 0 });
    expect(writes).toEqual([]);
  });

  it("expired clear evidence ⇒ screening expired + visibility removed + notices; NO senior field moves", async () => {
    const seed = sweepSeed({ expiresAt: "2026-07-01T00:00:00.000Z" });
    const seniorBefore = { ...(seed["caregivers/cg-1"] as any) };
    const { db, docs } = makeDb(seed);
    const r = await runChildcareScreeningExpirySweep({ db, now: NOW });
    expect(r).toMatchObject({ skipped: false, expired: 1 });

    const screening = docs.get("caregivers/cg-1/screenings/child")! as any;
    expect(screening.evidenceStatus).toBe("expired");
    const cg = docs.get("caregivers/cg-1")! as any;
    expect(cg[CHILDCARE_PROVIDER_SUMMARY_FIELD].visible).toBe(false);
    // Senior fields byte-identical through the removal (R31/AE9).
    for (const f of SENIOR_FIELDS) expect(cg[f]).toEqual(seniorBefore[f]);
    // Renewal notice + admin alert via the existing notification patterns.
    const alerts = [...docs.entries()].filter(([p]) => p.startsWith("admin_alerts/"));
    expect(alerts.some(([, d]) => (d as any).type === "childcare_screening_expired")).toBe(true);
    const notifications = [...docs.entries()].filter(([p]) => p.startsWith("users/cg-1/notifications/"));
    expect(notifications.length).toBe(1);
  });

  it("renewal window (due, not overdue) ⇒ one notice with a 30-day cooldown", async () => {
    const seed = sweepSeed({ expiresAt: "2026-08-10T00:00:00.000Z" });
    const { db, docs } = makeDb(seed);
    const first = await runChildcareScreeningExpirySweep({ db, now: NOW });
    expect(first).toMatchObject({ renewalNotices: 1, expired: 0 });
    // Evidence stays clear and visibility stays on inside the warning window.
    expect((docs.get("caregivers/cg-1/screenings/child") as any).evidenceStatus).toBe("clear");
    // Second pass inside the cooldown: no duplicate notice.
    const second = await runChildcareScreeningExpirySweep({ db, now: new Date(NOW.getTime() + 24 * 3600 * 1000) });
    expect(second.renewalNotices).toBe(0);
  });
});
