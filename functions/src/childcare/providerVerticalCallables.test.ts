// U5 (childcare marketplace plan 2026-07-22-002): v1 provider vertical
// callables. Scenarios: new provider full path, dual provider base reuse
// (AE21 — no re-asking, base evidence adoption), policy mismatch (bundled
// package), consent-first screening, invitation idempotency, deferred-category
// hard block, adult-age failure, manual approve/revoke, suspension (works
// under write-freeze), the U13 childScreeningOperator scope gate (broad admin
// alone denied — stub replaced), recent-auth, flags gating (R61),
// App Check enforce, the R24 senior-field wall, and memory denial (AE22).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── In-memory Firestore mock (authorityCallables.test.ts idiom + subcollections,
//    add(), create(), deep merge) ─────────────────────────────────────────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
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

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
      ref: makeDocRef(path),
    }),
    set: async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? deepMerge(docs.get(path), data) : { ...data });
    },
    create: async (data: any) => {
      if (docs.has(path)) {
        const err: any = new Error(`6 ALREADY_EXISTS: ${path}`);
        err.code = 6;
        throw err;
      }
      docs.set(path, { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(path)) {
        const err: any = new Error(`5 NOT_FOUND: ${path}`);
        err.code = 5;
        throw err;
      }
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const dotGet = (obj: any, path: string): unknown =>
    path.split(".").reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), obj);

  const makeQuery = (collPath: string, filters: any[] = [], lim?: number): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(collPath, [...filters, { field, op, value }], lim),
    orderBy: () => makeQuery(collPath, filters, lim),
    limit: (n: number) => makeQuery(collPath, filters, n),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(
          ([p]) =>
            p.startsWith(`${collPath}/`) &&
            p.split("/").length === collPath.split("/").length + 1,
        )
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => f.op === "==" && dotGet(r._raw, f.field) === f.value));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (path: string): any => {
    const q = makeQuery(path);
    return {
      doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${autoId++}`}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${path}/auto-${autoId++}`);
        docs.set(ref.path, { ...data });
        return ref;
      },
      where: q.where,
      get: q.get,
    };
  };

  const runTransaction = async (fn: any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => {
        void ref.set(data, opts);
      },
      update: (ref: any, data: any) => {
        docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
      },
    };
    return fn(tx);
  };

  const createCheckrInvitation = vi.fn(async (_args: any) => ({
    invitationUrl: "https://apply.checkr.test/invite/xyz",
    candidateId: "cand_new",
  }));

  return { docs, makeCollRef, runTransaction, createCheckrInvitation, reset: () => docs.clear() };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (p: string) => hoisted.makeCollRef(p),
    runTransaction: hoisted.runTransaction,
  });
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../checkrApi", () => ({
  createCheckrInvitation: (args: unknown) => hoisted.createCheckrInvitation(args),
}));

import {
  upsertChildcareVerticalProfile as _upsert,
  getMyChildcareProviderState as _getState,
  acceptChildcarePolicy as _acceptPolicy,
  startChildcareScreening as _startScreening,
  approveChildcareProvider as _approve,
  suspendChildcareProvider as _suspend,
} from "./providerVerticalCallables";
import { bustChildcareFlagsCache } from "../config/featureFlags";
import { CA_PILOT_POLICY_SEED } from "./jurisdictionPolicy";
import { decideMemoryEligibility } from "../memory/memoryEligibility";
import { isChildcareVerticalSession } from "../agents/onboardingContract";

/* eslint-disable @typescript-eslint/no-explicit-any */
const upsert = _upsert as any;
const getState = _getState as any;
const acceptPolicy = _acceptPolicy as any;
const startScreening = _startScreening as any;
const approve = _approve as any;
const suspend = _suspend as any;

const BASE_PKG = "checkrdirect_essential_criminal";
const freshAuthTime = () => Math.floor(Date.now() / 1000) - 5;
const staleAuthTime = () => Math.floor(Date.now() / 1000) - 3600;

function ctx(uid: string, opts: { authTime?: number; app?: boolean; email?: string } = {}): any {
  return {
    auth: {
      uid,
      token: {
        auth_time: opts.authTime ?? freshAuthTime(),
        ...(opts.email ? { email: opts.email } : {}),
      },
    },
    ...(opts.app === false ? {} : { app: { appId: "test-app" } }),
  };
}

function enableChildcareFlags(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set("childcare_flags/global", {
    CHILDCARE_ENABLED: true,
    CHILDCARE_DISCOVERY_ENABLED: true,
    CHILDCARE_WRITES_ENABLED: true,
    CHILDCARE_PROACTIVE_ENABLED: true,
    ...overrides,
  });
  bustChildcareFlagsCache();
}

function seedCaregiver(uid: string, overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`caregivers/${uid}`, {
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
    onboardingStatus: "profile_complete",
    verificationStatus: "approved",
    hourlyRate: 30,
    specialties: ["dementia"],
    ...overrides,
  });
}

/**
 * U13: operator decisions require the childScreeningOperator scope grant
 * (childcare_operators/{uid} — the U5 broad-admin stub was replaced; broad
 * isAdmin alone is denied, pinned in the gates suite below).
 */
function seedScreeningOperator(uid: string) {
  hoisted.docs.set(`childcare_operators/${uid}`, {
    operatorUid: uid,
    scopes: ["childScreeningOperator"],
    active: true,
  });
}

/** Fully populated, activatable CA policy for the eligibility recomputes. */
function seedActivatablePolicy(overrides: Record<string, unknown> = {}) {
  const approval = (referenceId: string) => ({
    referenceId,
    issuedBy: "Example Issuer LLP",
    approvedOn: "2026-07-20",
    policyVersion: "CA-2026-07-22.1",
    expiresOn: null,
  });
  hoisted.docs.set("jurisdiction_care_policies/CA", {
    ...CA_PILOT_POLICY_SEED,
    guardianProcessRef: "docs/counsel/CA-guardian-process-v1",
    incidentContacts: ["ops-oncall@example.test"],
    reportingObligationsRef: "docs/counsel/CA-mandated-reporting-v1",
    insuranceEvidenceRefs: ["COI-2026-0042"],
    consentVersions: {
      terms: "t-v1", privacy: "p-v1", screeningDisclosure: "sd-v1",
      guardianAttestation: "ga-v1", communicationConsent: "cc-v1", childcarePolicy: "cp-v1",
    },
    pricing: {
      familyEntitlementRef: "price_T1", caregiverFeeRef: "price_T2", screeningFeeRef: "price_T3",
      siblingPolicyRef: "policy_T4", cancellationPolicyRef: "policy_T5", refundPolicyRef: "policy_T6",
    },
    approvals: {
      legalCounsel: approval("COUNSEL-MEMO-9"),
      insurance: approval("COI-2026-0042"),
      jurisdictionScreeningProgram: approval("TRUSTLINE-777"),
    },
    ...overrides,
  });
}

const VALID_PROFILE_INPUT = {
  jurisdictionState: "CA",
  ageBands: ["toddler", "preschool"],
  services: ["babysitting", "after_school_care"],
  yearsChildcareExperience: 4,
  hourlyRate: 28,
  offersTransport: false,
  adultAgeAttested: true,
};

const originalAppCheckMode = process.env.CHILDCARE_APPCHECK_MODE;
const OLD_ENV = { ...process.env };

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.CHILDCARE_APPCHECK_MODE;
  process.env.CHECKR_PACKAGE = BASE_PKG;
  enableChildcareFlags();
  seedActivatablePolicy();
  seedCaregiver("cg-1");
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  if (originalAppCheckMode === undefined) delete process.env.CHILDCARE_APPCHECK_MODE;
  else process.env.CHILDCARE_APPCHECK_MODE = originalAppCheckMode;
  bustChildcareFlagsCache();
});

// ── Gates ────────────────────────────────────────────────────────────────────

describe("shared callable gates", () => {
  it("unauthenticated callers are rejected", async () => {
    await expect(upsert(VALID_PROFILE_INPUT, {} as any)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(getState({}, {} as any)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("childcare flags OFF keeps every callable dark (R61 fail-closed)", async () => {
    hoisted.docs.delete("childcare_flags/global");
    bustChildcareFlagsCache();
    await expect(upsert(VALID_PROFILE_INPUT, ctx("cg-1"))).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(getState({}, ctx("cg-1"))).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("App Check enforce mode fails closed on a missing token", async () => {
    process.env.CHILDCARE_APPCHECK_MODE = "enforce";
    await expect(upsert(VALID_PROFILE_INPUT, ctx("cg-1", { app: false }))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("operator callables: non-operators, BROAD-ADMIN-ONLY, and stale-auth callers are rejected (U12 — R55/AE18)", async () => {
    seedCaregiver("cg-1");
    hoisted.docs.set("caregivers/cg-1/vertical_profiles/child", { careVertical: "child" });
    hoisted.docs.set("users/cg-1", { userType: "caregiver" });
    // Non-admin, non-operator caller.
    await expect(approve({ caregiverUid: "cg-1", decision: "approved" }, ctx("cg-1"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    // Broad isAdmin ALONE — the U5 stub used to grant this; U12's replacement
    // DENIES it (screening review requires the childScreeningOperator scope).
    hoisted.docs.set("users/admin-only", { isAdmin: true, userType: "admin" });
    await expect(
      approve({ caregiverUid: "cg-1", decision: "approved" }, ctx("admin-only")),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      suspend({ caregiverUid: "cg-1", action: "suspend" }, ctx("admin-only")),
    ).rejects.toMatchObject({ code: "permission-denied" });
    // Scoped operator with STALE auth: the scope passes, recent-auth fails.
    seedScreeningOperator("op-1");
    await expect(
      approve({ caregiverUid: "cg-1", decision: "approved", reason: "screening_review" }, ctx("op-1", { authTime: staleAuthTime() })),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("operator removal revokes approve/suspend access immediately (grant is read live)", async () => {
    seedCaregiver("cg-1");
    hoisted.docs.set("caregivers/cg-1/vertical_profiles/child", { careVertical: "child" });
    seedScreeningOperator("op-1");
    const ok = await approve({ caregiverUid: "cg-1", decision: "approved", reason: "screening_review" }, ctx("op-1"));
    expect(ok.success).toBe(true);
    hoisted.docs.set("childcare_operators/op-1", { operatorUid: "op-1", scopes: ["childScreeningOperator"], active: false });
    await expect(
      approve({ caregiverUid: "cg-1", decision: "approved", reason: "screening_review" }, ctx("op-1")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── New provider full path ───────────────────────────────────────────────────

describe("new provider full path (upsert → accept policy → screening → manual approval)", () => {
  it("walks base → childcare delta → policy acceptance → screening → manual approval → visible", async () => {
    // 1. Upsert the childcare delta (base fields reused, never re-asked — AE21).
    const up = await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    expect(up.success).toBe(true);
    expect(up.reusedBaseFields).toEqual(expect.arrayContaining(["name", "email", "city", "photo"]));
    expect(up.missingBaseFields).toEqual([]);
    expect(up.missingChildcareFields).toEqual([]);
    const profile = hoisted.docs.get("caregivers/cg-1/vertical_profiles/child");
    expect(profile).toMatchObject({ careVertical: "child", jurisdictionState: "CA" });
    // Server-owned state cannot be self-granted at upsert.
    expect(profile.approval.state).toBe("none");
    expect(profile.acceptedPolicyVersion).toBeNull();

    // 2. Accept the current childcare policy (versioned receipt).
    const acc = await acceptPolicy({}, ctx("cg-1"));
    expect(acc).toMatchObject({ success: true, acceptedPolicyVersion: "CA-2026-07-22.1" });

    // 3. Start screening (consent-first) — no adoptable base evidence here, so
    //    a Checkr invitation is minted with the SHARED base package.
    seedCaregiver("cg-1", { backgroundCheckData: {} });
    const start = await startScreening({ screeningConsent: true }, ctx("cg-1", { email: "jane@example.test" }));
    expect(start).toMatchObject({ success: true, mode: "invitation_sent", evidenceStatus: "pending" });
    expect(hoisted.createCheckrInvitation).toHaveBeenCalledTimes(1);
    expect(hoisted.createCheckrInvitation.mock.calls[0][0]).toMatchObject({ packageSlug: BASE_PKG, customId: "cg-1" });

    // 4. Clear EVIDENCE alone is NOT visibility (R27) — simulate the webhook
    //    outcome, then require the manual operator decision (R28).
    hoisted.docs.set("caregivers/cg-1/screenings/child", {
      ...hoisted.docs.get("caregivers/cg-1/screenings/child"),
      evidenceStatus: "clear",
      reportCompletedAt: "2026-07-23T00:00:00.000Z",
      expiresAt: "2027-07-23T00:00:00.000Z",
      checkr: { candidateId: "cand_new", invitationId: "inv_1", reportId: "rep_1", invitationStatus: "completed" },
    });
    let state = await getState({}, ctx("cg-1"));
    expect(state.eligibility.eligible).toBe(false);
    expect(state.eligibility.issues.map((i: any) => i.code)).toContain("manual_approval_missing");

    seedScreeningOperator("op-1");
    const ap = await approve({ caregiverUid: "cg-1", decision: "approved", reason: "screening_review" }, ctx("op-1"));
    expect(ap).toMatchObject({ success: true, decision: "approved", visible: true });

    state = await getState({}, ctx("cg-1"));
    expect(state.eligibility.eligible).toBe(true);
    const summary = hoisted.docs.get("caregivers/cg-1").childcareProvider;
    expect(summary.visible).toBe(true);
    expect(summary.evidenceLabels).toEqual(
      expect.arrayContaining(["background_check_current", "childcare_reviewed", "childcare_policy_accepted"]),
    );
  });

  it("R24 WALL: the whole callable path never moves a senior parent-doc field", async () => {
    const before = { ...hoisted.docs.get("caregivers/cg-1") };
    seedScreeningOperator("op-1");
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    await acceptPolicy({}, ctx("cg-1"));
    await startScreening({ screeningConsent: true }, ctx("cg-1", { email: "jane@example.test" }));
    await approve({ caregiverUid: "cg-1", decision: "approved", reason: "screening_review" }, ctx("op-1"));
    await suspend({ caregiverUid: "cg-1", action: "suspend", code: "test", reason: "screening_review" }, ctx("op-1"));
    const after = hoisted.docs.get("caregivers/cg-1");
    for (const key of Object.keys(before)) {
      expect(after[key], `senior field "${key}" must be untouched`).toEqual(before[key]);
    }
    // The ONLY new parent key is the namespaced derived summary.
    const newKeys = Object.keys(after).filter((k) => !(k in before));
    expect(newKeys).toEqual(["childcareProvider"]);
  });
});

// ── Dual provider base reuse (AE21) ──────────────────────────────────────────

describe("dual provider (senior caregiver adds childcare)", () => {
  it("adopts current clear base evidence — NO duplicate Checkr check, no re-asking", async () => {
    seedCaregiver("cg-1", {
      backgroundCheckData: {
        status: "clear",
        completedAt: "2026-06-20T00:00:00.000Z",
        checkrCandidateId: "cand_base",
        checkrReportId: "rep_base",
      },
    });
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    const start = await startScreening({ screeningConsent: true }, ctx("cg-1"));
    expect(start).toMatchObject({ success: true, mode: "base_evidence_adopted", evidenceStatus: "clear" });
    expect(hoisted.createCheckrInvitation).not.toHaveBeenCalled();
    const screening = hoisted.docs.get("caregivers/cg-1/screenings/child");
    expect(screening).toMatchObject({
      evidenceSource: "shared_base_report_adoption",
      packageSlug: BASE_PKG,
      checkr: expect.objectContaining({ candidateId: "cand_base", reportId: "rep_base" }),
    });
    // Independent per-vertical expiry (annual default from completedAt).
    expect(screening.expiresAt).toBe("2027-06-20T00:00:00.000Z");
  });

  it("POLICY MISMATCH: a bundled criminal+MVR base report is NOT adopted — a fresh base-package invitation runs, reusing the candidate", async () => {
    seedCaregiver("cg-1", {
      backgroundCheckData: {
        status: "clear",
        completedAt: "2026-06-20T00:00:00.000Z",
        checkrCandidateId: "cand_base",
        mvrIncluded: true, // bundled package ≠ shared base package slug
      },
    });
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    const start = await startScreening({ screeningConsent: true }, ctx("cg-1", { email: "jane@example.test" }));
    expect(start).toMatchObject({ mode: "invitation_sent" });
    expect(hoisted.createCheckrInvitation).toHaveBeenCalledTimes(1);
    // Candidate reuse (checkr.ts renewal idiom) — never a duplicate candidate.
    expect(hoisted.createCheckrInvitation.mock.calls[0][0]).toMatchObject({
      candidateId: "cand_base",
      packageSlug: BASE_PKG,
    });
  });

  it("senior eligibility is untouched by the childcare enrollment (AE9)", async () => {
    seedCaregiver("cg-1", {
      backgroundCheckData: { status: "clear", completedAt: "2026-06-20T00:00:00.000Z", checkrCandidateId: "cand_base" },
    });
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    await startScreening({ screeningConsent: true }, ctx("cg-1"));
    const cg = hoisted.docs.get("caregivers/cg-1");
    expect(cg.verificationStatus).toBe("approved");
    expect(cg.onboardingStatus).toBe("profile_complete");
    expect(cg.backgroundCheckData).toEqual({
      status: "clear", completedAt: "2026-06-20T00:00:00.000Z", checkrCandidateId: "cand_base",
    });
  });
});

// ── Input validation ─────────────────────────────────────────────────────────

describe("input validation — fail closed", () => {
  it("DEFERRED categories are hard-blocked (infant/overnight/medication/specialized)", async () => {
    for (const svc of ["infant_care", "overnight_care", "medication_administration", "specialized_needs_care"]) {
      await expect(
        upsert({ ...VALID_PROFILE_INPUT, services: [svc] }, ctx("cg-1")),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    }
  });

  it("unknown categories and unknown age bands fail closed", async () => {
    await expect(upsert({ ...VALID_PROFILE_INPUT, services: ["petcare"] }, ctx("cg-1"))).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await expect(upsert({ ...VALID_PROFILE_INPUT, ageBands: ["adult"] }, ctx("cg-1"))).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  it("adult-age failure: missing attestation is reported as a missing childcare field and blocks eligibility", async () => {
    const up = await upsert({ ...VALID_PROFILE_INPUT, adultAgeAttested: false }, ctx("cg-1"));
    expect(up.missingChildcareFields).toContain("adultAgeAttested");
    const state = await getState({}, ctx("cg-1"));
    expect(state.eligibility.eligible).toBe(false);
  });

  it("an upsert cannot self-grant approval, policy acceptance, or clear a suspension", async () => {
    seedScreeningOperator("op-1");
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    await suspend({ caregiverUid: "cg-1", action: "suspend", code: "safety_hold", reason: "screening_review" }, ctx("op-1"));
    await upsert(
      {
        ...VALID_PROFILE_INPUT,
        approval: { state: "approved" },
        acceptedPolicyVersion: "CA-2026-07-22.1",
        suspension: { active: false },
      },
      ctx("cg-1"),
    );
    const profile = hoisted.docs.get("caregivers/cg-1/vertical_profiles/child");
    expect(profile.approval.state).toBe("none");
    expect(profile.acceptedPolicyVersion).toBeNull();
    expect(profile.suspension.active).toBe(true);
  });
});

// ── Screening start guards ───────────────────────────────────────────────────

describe("startChildcareScreening — consent-first + idempotent", () => {
  it("refuses without explicit screening consent (never a pre-consent Checkr call)", async () => {
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    await expect(startScreening({}, ctx("cg-1"))).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(startScreening({ screeningConsent: false }, ctx("cg-1"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
    expect(hoisted.createCheckrInvitation).not.toHaveBeenCalled();
  });

  it("a second start while an invitation is outstanding never mints a duplicate", async () => {
    seedCaregiver("cg-1", { backgroundCheckData: {} });
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    const first = await startScreening({ screeningConsent: true }, ctx("cg-1", { email: "jane@example.test" }));
    expect(first.mode).toBe("invitation_sent");
    const second = await startScreening({ screeningConsent: true }, ctx("cg-1", { email: "jane@example.test" }));
    expect(second.mode).toBe("invitation_outstanding");
    expect(hoisted.createCheckrInvitation).toHaveBeenCalledTimes(1);
  });

  it("current evidence short-circuits (already_current)", async () => {
    seedCaregiver("cg-1", {
      backgroundCheckData: { status: "clear", completedAt: "2026-06-20T00:00:00.000Z", checkrCandidateId: "cand_base" },
    });
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    await startScreening({ screeningConsent: true }, ctx("cg-1"));
    const again = await startScreening({ screeningConsent: true }, ctx("cg-1"));
    expect(again.mode).toBe("already_current");
  });
});

// ── Policy acceptance ────────────────────────────────────────────────────────

describe("acceptChildcarePolicy — versioned, fail-closed", () => {
  it("a versionless jurisdiction policy cannot be accepted (fail closed)", async () => {
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    seedActivatablePolicy({ policyVersion: "" });
    await expect(acceptPolicy({}, ctx("cg-1"))).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("a policy-version change invalidates the old acceptance until re-accepted", async () => {
    seedScreeningOperator("op-1");
    seedCaregiver("cg-1", {
      backgroundCheckData: { status: "clear", completedAt: "2026-06-20T00:00:00.000Z", checkrCandidateId: "cand_base" },
    });
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    await acceptPolicy({}, ctx("cg-1"));
    await startScreening({ screeningConsent: true }, ctx("cg-1"));
    await approve({ caregiverUid: "cg-1", decision: "approved", reason: "screening_review" }, ctx("op-1"));
    let state = await getState({}, ctx("cg-1"));
    expect(state.eligibility.eligible).toBe(true);

    // Version bump (re-approved for the new version) — acceptance goes stale.
    const approvalRef = (referenceId: string) => ({
      referenceId, issuedBy: "Example Issuer LLP", approvedOn: "2026-08-01",
      policyVersion: "CA-2026-08-01.2", expiresOn: null,
    });
    seedActivatablePolicy({
      policyVersion: "CA-2026-08-01.2",
      approvals: {
        legalCounsel: approvalRef("COUNSEL-MEMO-10"),
        insurance: approvalRef("COI-2026-0043"),
        jurisdictionScreeningProgram: approvalRef("TRUSTLINE-778"),
      },
    });
    state = await getState({}, ctx("cg-1"));
    expect(state.eligibility.eligible).toBe(false);
    expect(state.eligibility.issues.map((i: any) => i.code)).toContain("policy_acceptance_stale");

    await acceptPolicy({}, ctx("cg-1"));
    state = await getState({}, ctx("cg-1"));
    expect(state.eligibility.eligible).toBe(true);
  });
});

// ── Manual approve / revoke / suspend (operator seam) ────────────────────────

describe("operator decisions — manual approval is the only path to visibility", () => {
  async function fullyReadyProvider() {
    seedScreeningOperator("op-1");
    seedCaregiver("cg-1", {
      backgroundCheckData: { status: "clear", completedAt: "2026-06-20T00:00:00.000Z", checkrCandidateId: "cand_base" },
    });
    await upsert(VALID_PROFILE_INPUT, ctx("cg-1"));
    await acceptPolicy({}, ctx("cg-1"));
    await startScreening({ screeningConsent: true }, ctx("cg-1"));
  }

  it("manual revoke removes visibility without touching the screening evidence or senior state", async () => {
    await fullyReadyProvider();
    await approve({ caregiverUid: "cg-1", decision: "approved", reason: "screening_review" }, ctx("op-1"));
    expect(hoisted.docs.get("caregivers/cg-1").childcareProvider.visible).toBe(true);

    const rv = await approve({ caregiverUid: "cg-1", decision: "revoked", reason: "screening_review" }, ctx("op-1"));
    expect(rv).toMatchObject({ decision: "revoked", visible: false });
    expect(hoisted.docs.get("caregivers/cg-1/screenings/child").evidenceStatus).toBe("clear"); // evidence intact
    expect(hoisted.docs.get("caregivers/cg-1").verificationStatus).toBe("approved"); // senior intact (AE9)
  });

  it("suspension removes visibility and WORKS while childcare writes are frozen (safety lever)", async () => {
    await fullyReadyProvider();
    await approve({ caregiverUid: "cg-1", decision: "approved", reason: "screening_review" }, ctx("op-1"));
    enableChildcareFlags({ CHILDCARE_WRITES_ENABLED: false }); // write-freeze
    const s = await suspend({ caregiverUid: "cg-1", action: "suspend", code: "safety_review", reason: "screening_review" }, ctx("op-1"));
    expect(s).toMatchObject({ action: "suspend", visible: false });
    const lifted = await suspend({ caregiverUid: "cg-1", action: "lift", reason: "screening_review" }, ctx("op-1"));
    expect(lifted).toMatchObject({ action: "lift", visible: true });
  });
});

// ── Public projection parity (R30/AE9) ──────────────────────────────────────

describe("public projection — senior byte-parity + derived labels only (R30/AE9)", () => {
  const seniorDoc = {
    name: "Jane Doe", firstName: "Jane", lastName: "Doe", bio: "Hi", city: "San Jose", state: "CA",
    rating: 4.9, reviewCount: 12, verified: true, backgroundCheckStatus: "clear",
    verificationStatus: "approved", onboardingStatus: "profile_complete",
    hourlyRate: 30, specialties: ["dementia"], photo: "https://example.test/p.jpg",
    // Fields that must NEVER be projected:
    phone: "+14085551234", email: "jane@example.test",
    backgroundCheckData: { checkrCandidateId: "cand_1" },
  };

  it("a SENIOR-ONLY caregiver doc projects byte-identically (no new vertical keys)", async () => {
    const { toPublicProfile } = await import("../publicCaregiverProfile");
    const projected = toPublicProfile("cg-1", seniorDoc as any);
    expect(projected).not.toHaveProperty("verticalVisibility");
    expect(projected).not.toHaveProperty("childcareEvidenceLabels");
    expect(projected).not.toHaveProperty("childcareProvider");
    // The exact legacy key set — pinned so senior projections cannot drift.
    expect(Object.keys(projected).sort()).toEqual([
      "backgroundCheckStatus", "bio", "city", "firstName", "hourlyRate", "id", "lastName",
      "location", "name", "onboardingStatus", "photo", "rating", "reviewCount",
      "specialties", "state", "verificationStatus", "verified",
    ]);
  });

  it("a VISIBLE childcare provider projects derived labels only — never the raw summary or restricted evidence", async () => {
    const { toPublicProfile, PUBLIC_CHILDCARE_EVIDENCE_LABELS } = await import("../publicCaregiverProfile");
    const projected = toPublicProfile("cg-1", {
      ...seniorDoc,
      childcareProvider: {
        visible: true,
        evidenceLabels: ["background_check_current", "childcare_reviewed", "raw_report_leak", "internal_reason"],
        evidenceStatus: "clear",
        approvalState: "approved",
        eligibilityVersion: "childcare-provider-eligibility-2026-07-23.1",
        screeningExpiresAt: "2027-07-01T00:00:00.000Z",
      },
    } as any);
    expect(projected.verticalVisibility).toEqual({ child: true });
    // Allowlist filtering: unknown/internal strings are stripped.
    expect(projected.childcareEvidenceLabels).toEqual(["background_check_current", "childcare_reviewed"]);
    for (const l of projected.childcareEvidenceLabels as string[]) {
      expect(PUBLIC_CHILDCARE_EVIDENCE_LABELS).toContain(l);
    }
    // The internal summary itself (statuses, versions, expiry) never leaks.
    expect(projected).not.toHaveProperty("childcareProvider");
    const flat = JSON.stringify(projected);
    expect(flat).not.toContain("screeningExpiresAt");
    expect(flat).not.toContain("cand_1"); // no candidate PII (R30)
    expect(flat).not.toContain("approvalState");
  });

  it("a NOT-visible childcare provider projects visibility=false and NO labels (no internal reasons)", async () => {
    const { toPublicProfile } = await import("../publicCaregiverProfile");
    const projected = toPublicProfile("cg-1", {
      ...seniorDoc,
      childcareProvider: { visible: false, evidenceLabels: ["background_check_current"], evidenceStatus: "expired" },
    } as any);
    expect(projected.verticalVisibility).toEqual({ child: false });
    expect(projected).not.toHaveProperty("childcareEvidenceLabels");
    expect(JSON.stringify(projected)).not.toContain("expired"); // no internal reason leaks
  });

  it("R30: the projection allowlist contains no universal safety language", async () => {
    const { PUBLIC_CHILDCARE_EVIDENCE_LABELS } = await import("../publicCaregiverProfile");
    for (const label of PUBLIC_CHILDCARE_EVIDENCE_LABELS) {
      expect(label).not.toMatch(/safe|vetted|guarantee|trusted|certified_safe/i);
    }
  });

  // ── U8 (R45): per-vertical reputation labels — a DELIBERATE additive
  // extension of the pinned projection key set. The senior-only pin above must
  // keep passing unchanged; these keys appear ONLY for childcare-visible docs.
  it("U8: a VISIBLE childcare provider with a reputation summary emits per-vertical numbers only", async () => {
    const { toPublicProfile } = await import("../publicCaregiverProfile");
    const projected = toPublicProfile("cg-1", {
      ...seniorDoc,
      childcareProvider: { visible: true, evidenceLabels: ["childcare_reviewed"] },
      childcareReputationSummary: {
        ratingAvg: 4.7, ratingCount: 3, completedBookings: 5, repeatFamilies: 2,
        updatedAt: "2026-07-23T00:00:00.000Z",
      },
    } as any);
    expect(projected.childcareReputation).toEqual({
      ratingAvg: 4.7, ratingCount: 3, completedBookings: 5, repeatFamilies: 2,
    });
    // Per-vertical isolation on the PUBLIC surface: the senior rating field is
    // still the senior aggregate — the childcare block never overwrites it.
    expect(projected.rating).toBe(4.9);
    expect(projected.reviewCount).toBe(12);
    // The raw summary (with updatedAt) never leaks — numbers only.
    expect(JSON.stringify(projected.childcareReputation)).not.toContain("updatedAt");
  });

  it("U8: a NOT-visible provider never emits childcareReputation even when the summary exists", async () => {
    const { toPublicProfile } = await import("../publicCaregiverProfile");
    const projected = toPublicProfile("cg-1", {
      ...seniorDoc,
      childcareProvider: { visible: false },
      childcareReputationSummary: { ratingAvg: 4.7, ratingCount: 3, completedBookings: 5, repeatFamilies: 2 },
    } as any);
    expect(projected).not.toHaveProperty("childcareReputation");
  });
});

// ── Memory denial (AE22) ─────────────────────────────────────────────────────

describe("childcare qualifications never enter general memory (AE22)", () => {
  it("a childcare-stamped session is memory-DENIED and never routed to the senior loop", () => {
    const session = { userType: "caregiver", careVertical: "child" };
    const decision = decideMemoryEligibility(session);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("childcare_vertical");
    expect(isChildcareVerticalSession(session)).toBe(true);
  });

  it("the callables module imports NO memory subsystem (static wall)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "providerVerticalCallables.ts"), "utf8");
    for (const banned of ["memory/zepClient", "memory/learnedFacts", "memory/conversationMemory", "memory/memoryFiles", "pushOnboardingDataToZep"]) {
      expect(src.includes(banned), `must not import ${banned}`).toBe(false);
    }
  });
});
