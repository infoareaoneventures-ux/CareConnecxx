// U6 childcare job/application/interview callable tests (plan 2026-07-22-002).
//
// Scenarios (plan U6 list): multiple children/age bands; required credential
// (policy-derived CPR equivalent); disabled infant/specialized category
// blocked; transport availability; expired provider excluded at discovery AND
// application AND interview; protected/private field exclusion with exact
// public field sets; no eligible results (empty, not error); duplicate
// application idempotency; withdrawn/closed job; interview gating both sides;
// calendar/SMS privacy (generic childcare content); policy change mid-flow;
// R32 legacy mirror never written; full U2/U3 middleware stack.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore mock (U3 pattern + dotted paths + add()) ─────────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

  const valueAt = (doc: any, path: string): unknown =>
    path.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

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
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
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
        .filter((r) => filters.every((f) => valueAt(r._raw, f.field) === f.value));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (path: string): any => {
    const q = makeQuery(path);
    return {
      doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${docs.size}`}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${path}/auto-${docs.size}`);
        await ref.set(data);
        return ref;
      },
      where: q.where,
      limit: q.limit,
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

  return { docs, makeCollRef, runTransaction, reset: () => docs.clear() };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (p: string) => hoisted.makeCollRef(p),
    runTransaction: hoisted.runTransaction,
  });
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

// R29 seam — controllable per test (the module is also consumed by
// matchingEligibility's default loaders, so ONE mock gates everything).
const recheckMock = vi.hoisted(() => vi.fn());
const loadProfileMock = vi.hoisted(() => vi.fn());
vi.mock("./providerEligibility", () => ({
  recheckChildcareProviderEligibility: recheckMock,
  loadChildcareVerticalProfile: loadProfileMock,
}));

// Jurisdiction policy: keep the REAL deferred-category allowlist; control the
// loaded policy + readiness verdict.
const loadPolicyMock = vi.hoisted(() => vi.fn());
const policyReadinessMock = vi.hoisted(() => vi.fn(() => [] as unknown[]));
vi.mock("./jurisdictionPolicy", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadJurisdictionPolicy: loadPolicyMock,
    evaluatePolicyReadiness: policyReadinessMock,
  };
});

// Server-side geocoding (approximate area) — deterministic coords.
vi.mock("../utils/geocode", () => ({
  geocodeZip: vi.fn(async () => ({ lat: 37.334123, lng: -121.891234 })),
  geocodeCity: vi.fn(async () => ({ lat: 37.334123, lng: -121.891234 })),
}));

// interviewLinkTrigger heavy deps (only its pure content helpers are exercised).
vi.mock("../agents/interviewLinks", () => ({ createInterviewCallAssets: vi.fn() }));
vi.mock("../observability/caraOpsAlerts", () => ({ createCaraOpsAlert: vi.fn(async () => {}) }));
vi.mock("../utils/toolNotify", () => ({ trySend: vi.fn(async () => ({ sent: true })) }));

import {
  createChildcareJobPost as _create,
  updateChildcareJobPost as _update,
  closeChildcareJobPost as _close,
  listMyChildcareJobs as _listMine,
  applyToChildcareJob as _apply,
  listEligibleChildcareJobs as _discover,
  requestChildcareInterview as _interview,
  childcareJobDocId,
  childcareApplicationDocId,
  childcareInterviewDocId,
  approximateCoord,
} from "./jobCallables";
import {
  CHILDCARE_JOB_OPEN_STATUS,
  CHILDCARE_JOB_PUBLIC_FIELDS,
  CHILDCARE_APPLICATION_PUBLIC_FIELDS,
  assertChildSafeOutboundPayload,
} from "./matchingEligibility";
import { authorityDocId } from "./guardianAuthority";
import { bustChildcareFlagsCache } from "../config/featureFlags";
import { familyChildcareObjectiveId } from "./signupIngress";
import {
  interviewCalendarTitle,
  interviewLinkMessage,
} from "../triggers/interviewLinkTrigger";

/* eslint-disable @typescript-eslint/no-explicit-any */
const createJob = _create as any;
const updateJob = _update as any;
const closeJob = _close as any;
const listMine = _listMine as any;
const applyJob = _apply as any;
const discover = _discover as any;
const requestInterview = _interview as any;

const FAMILY = "family-1";
const CG = "cg-1";
const HH = "hh_family-1";

function ctx(uid: string): any {
  return {
    auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) - 5 } },
    app: { appId: "test-app" },
  };
}

function enableFlags(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set("childcare_flags/global", {
    CHILDCARE_ENABLED: true,
    CHILDCARE_DISCOVERY_ENABLED: true,
    CHILDCARE_WRITES_ENABLED: true,
    CHILDCARE_PROACTIVE_ENABLED: true,
    ...overrides,
  });
  bustChildcareFlagsCache();
}

function seedChild(childId: string, ageBand: string, householdId = HH) {
  hoisted.docs.set(`child_profiles/${childId}`, {
    childId,
    householdId,
    careVertical: "child",
    displayLabel: "Kid",
    ageBand,
    careCategories: ["babysitting"],
    state: "active",
    authorizedViewerUids: [FAMILY],
    accessVersion: 1,
    safetyCurrentVersion: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
}

function seedAuthority(childId: string, uid: string, scopes: string[] = ["view", "schedule"]) {
  hoisted.docs.set(`guardian_authorities/${authorityDocId(childId, uid)}`, {
    authorityId: authorityDocId(childId, uid),
    childId,
    adultUid: uid,
    state: "active",
    scopes,
    accessVersion: 1,
  });
}

const ELIGIBLE = (transport = false) => ({
  eligible: true,
  issues: [],
  eligibilityVersion: "childcare-provider-eligibility-test",
  evidenceVersion: 2,
  capabilities: { transport },
  evidenceLabels: ["background_check_current"],
  renewal: { expiresAt: null, due: false, overdue: false },
});
const INELIGIBLE = (code: string) => ({
  eligible: false,
  issues: [{ code, field: "x", detail: "d" }],
  eligibilityVersion: "childcare-provider-eligibility-test",
  evidenceVersion: 2,
  capabilities: { transport: false },
  evidenceLabels: [],
  renewal: { expiresAt: null, due: false, overdue: false },
});

const POLICY = () => ({
  state: "CA",
  status: "configured",
  policyVersion: "ca-test-1",
  approvedServiceCategories: ["babysitting", "after_school_care"],
  caregiverMinimumAge: 18,
  screening: { checkrPackageRef: "shared-base-package", components: [] },
  credentialRules: { requiredCredentials: ["cpr_first_aid"] },
  transport: { enabled: true, requiresMvr: true },
});

const CREATE_INPUT = () => ({
  idempotencyKey: "key-1",
  childIds: ["child-a", "child-b"],
  serviceCategories: ["babysitting"],
  schedule: { days: ["Monday", "Wednesday"], timeOfDay: ["afternoon"], startDate: "2026-08-01", frequency: "weekly" },
  hourlyRate: 28,
  transportRequired: false,
  city: "San Jose",
  state: "CA",
  zipCode: "95112",
});

function seedFamilyWithChildren() {
  seedChild("child-a", "toddler");
  seedChild("child-b", "preschool");
  seedAuthority("child-a", FAMILY);
  seedAuthority("child-b", FAMILY);
}

async function createOpenJob(): Promise<string> {
  const res = await createJob(CREATE_INPUT(), ctx(FAMILY));
  return res.jobId as string;
}

function seedEligibleProvider(uid = CG) {
  hoisted.docs.set(`caregivers/${uid}`, {
    name: "Pat Provider",
    latitude: 37.34,
    longitude: -121.9,
    weeklyAvailability: {
      monday: [{ start: "12:00", end: "18:00" }],
      wednesday: [{ start: "12:00", end: "18:00" }],
    },
    childcareProvider: { visible: true },
  });
  hoisted.docs.set(`caregivers/${uid}/vertical_profiles/child`, {
    ageBands: ["toddler", "preschool", "school_age"],
    services: ["babysitting", "after_school_care"],
    yearsChildcareExperience: 4,
  });
}

beforeEach(() => {
  hoisted.reset();
  recheckMock.mockReset();
  recheckMock.mockResolvedValue(ELIGIBLE());
  loadProfileMock.mockReset();
  loadProfileMock.mockResolvedValue({
    ageBands: ["toddler", "preschool", "school_age"],
    services: ["babysitting", "after_school_care"],
    yearsChildcareExperience: 4,
  });
  loadPolicyMock.mockReset();
  loadPolicyMock.mockResolvedValue(POLICY());
  policyReadinessMock.mockReset();
  policyReadinessMock.mockReturnValue([]);
  enableFlags();
});

// ── createChildcareJobPost ───────────────────────────────────────────────────

describe("createChildcareJobPost", () => {
  it("creates a privacy-safe job for multiple children/age bands and NEVER the legacy mirror (R32/R33)", async () => {
    seedFamilyWithChildren();
    seedEligibleProvider();

    const res = await createJob(CREATE_INPUT(), ctx(FAMILY));
    expect(res.success).toBe(true);
    expect(res.created).toBe(true);

    const jobId = res.jobId as string;
    expect(jobId).toBe(childcareJobDocId(FAMILY, "key-1"));
    const stored = hoisted.docs.get(`job_posts/${jobId}`);
    expect(stored.careVertical).toBe("child");
    expect(stored.status).toBe(CHILDCARE_JOB_OPEN_STATUS);
    expect(stored.status).not.toBe("open"); // senior sweeps select status=="open"
    expect(stored.disclosurePhase).toBe("public_listing");
    expect(stored.childRequirements).toEqual({
      childCount: 2,
      ageBands: ["preschool", "toddler"],
      serviceCategories: ["babysitting"],
      requiredCredentials: ["cpr_first_aid"], // policy-derived (required credential)
      transportRequired: false,
    });
    // Approximate area computed server-side; coords rounded to a coarse cell.
    expect(stored.areaLabel).toBe("San Jose, CA");
    expect(stored.approxLat).toBe(approximateCoord(37.334123));
    expect(stored.approxLng).toBe(approximateCoord(-121.891234));
    expect(String(stored.approxLat)).not.toContain("334123");

    // The stored doc IS the safe surface: no child names/address/etc.
    expect(() => assertChildSafeOutboundPayload(stored, "test")).not.toThrow();

    // Child linkage is server-only (private subdoc), never on the public doc.
    expect(stored.childIds).toBeUndefined();
    expect(stored.householdId).toBeUndefined();
    expect(hoisted.docs.get(`job_posts/${jobId}/private/children`)).toEqual(
      expect.objectContaining({ childIds: ["child-a", "child-b"], householdId: HH }),
    );

    // R32: the legacy singleton mirror was NOT written.
    expect(hoisted.docs.has(`job_postings/${FAMILY}`)).toBe(false);

    // Public projection carries EXACTLY the public field set.
    expect(Object.keys(res.job).sort()).toEqual([...CHILDCARE_JOB_PUBLIC_FIELDS].sort());
  });

  it("requires LIVE schedule authority on EVERY selected child (enumeration-safe denial)", async () => {
    seedFamilyWithChildren();
    hoisted.docs.delete(`guardian_authorities/${authorityDocId("child-b", FAMILY)}`);
    await expect(createJob(CREATE_INPUT(), ctx(FAMILY))).rejects.toMatchObject({
      code: "permission-denied",
    });
    expect(hoisted.docs.has(`job_posts/${childcareJobDocId(FAMILY, "key-1")}`)).toBe(false);
  });

  it("blocks an infant-age-band child (deferred infant_care category)", async () => {
    seedChild("child-a", "infant");
    seedAuthority("child-a", FAMILY);
    await expect(
      createJob({ ...CREATE_INPUT(), childIds: ["child-a"] }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "deferred_category" } });
  });

  it("blocks deferred/unknown service categories (specialized care)", async () => {
    seedFamilyWithChildren();
    for (const category of ["infant_care", "specialized_needs_care", "overnight_care", "made_up"]) {
      await expect(
        createJob({ ...CREATE_INPUT(), serviceCategories: [category] }, ctx(FAMILY)),
      ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "deferred_category" } });
    }
  });

  it("blocks an enableable category the jurisdiction has not approved", async () => {
    seedFamilyWithChildren();
    await expect(
      createJob({ ...CREATE_INPUT(), serviceCategories: ["weekend_daytime_care"] }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "category_not_approved" } });
  });

  it("fails closed when the jurisdiction policy is not activatable", async () => {
    seedFamilyWithChildren();
    policyReadinessMock.mockReturnValue([{ code: "policy_missing", field: "x", detail: "d" }]);
    await expect(createJob(CREATE_INPUT(), ctx(FAMILY))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "jurisdiction_not_ready" },
    });
  });

  it("blocks transportRequired when the jurisdiction has transport disabled", async () => {
    seedFamilyWithChildren();
    loadPolicyMock.mockResolvedValue({ ...POLICY(), transport: { enabled: false, requiresMvr: true } });
    await expect(
      createJob({ ...CREATE_INPUT(), transportRequired: true }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "transport_not_available" } });
  });

  it("is idempotent per (client, idempotencyKey)", async () => {
    seedFamilyWithChildren();
    const first = await createJob(CREATE_INPUT(), ctx(FAMILY));
    const second = await createJob(CREATE_INPUT(), ctx(FAMILY));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
  });

  it("is dark behind the Firestore-resident childcare flags (R61)", async () => {
    seedFamilyWithChildren();
    enableFlags({ CHILDCARE_WRITES_ENABLED: false });
    await expect(createJob(CREATE_INPUT(), ctx(FAMILY))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "childcare_disabled" },
    });
  });

  it("notifies ONLY hard-eligible providers, with generic child-safe content (R34/R43)", async () => {
    seedFamilyWithChildren();
    seedEligibleProvider("cg-eligible");
    seedEligibleProvider("cg-expired");
    recheckMock.mockImplementation(async (uid: string) =>
      uid === "cg-expired" ? INELIGIBLE("screening_expired") : ELIGIBLE(),
    );

    const res = await createJob(CREATE_INPUT(), ctx(FAMILY));
    expect(res.notifiedCount).toBe(1);

    const notifications = [...hoisted.docs.entries()].filter(([p]) => p.includes("/notifications/"));
    expect(notifications).toHaveLength(1);
    const [path, payload] = notifications[0];
    expect(path.startsWith("users/cg-eligible/notifications/")).toBe(true);
    expect(payload.title).toBe("New childcare job near you");
    expect(payload.body).toContain("San Jose, CA");
    // Generic: no child facts, no names, no exact location.
    expect(() => assertChildSafeOutboundPayload(payload, "test")).not.toThrow();
    expect(JSON.stringify(payload)).not.toMatch(/Kid|child-a|child-b|95112/);
  });
});

// ── update / close / listMine ────────────────────────────────────────────────

describe("update/close/listMyChildcareJobs", () => {
  it("owner can update safe fields; free text has no input surface", async () => {
    seedFamilyWithChildren();
    const jobId = await createOpenJob();
    const res = await updateJob({ jobId, hourlyRate: 32 }, ctx(FAMILY));
    expect(res.success).toBe(true);
    expect(hoisted.docs.get(`job_posts/${jobId}`).rate).toBe(32);
    // description/notes inputs are ignored — not part of the update surface.
    await updateJob({ jobId, description: "my kid Ava at 12 Main St" } as any, ctx(FAMILY));
    const stored = hoisted.docs.get(`job_posts/${jobId}`);
    expect(stored.description).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("Ava");
  });

  it("non-owner cannot update or close (enumeration-safe)", async () => {
    seedFamilyWithChildren();
    const jobId = await createOpenJob();
    await expect(updateJob({ jobId, hourlyRate: 1 }, ctx("stranger"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(closeJob({ jobId }, ctx("stranger"))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("close is idempotent and stamps closed status", async () => {
    seedFamilyWithChildren();
    const jobId = await createOpenJob();
    await closeJob({ jobId }, ctx(FAMILY));
    await closeJob({ jobId }, ctx(FAMILY));
    expect(hoisted.docs.get(`job_posts/${jobId}`).status).toBe("closed");
  });

  it("listMyChildcareJobs returns only the caller's childcare jobs in the public projection", async () => {
    seedFamilyWithChildren();
    const jobId = await createOpenJob();
    hoisted.docs.set("job_posts/senior-job", { clientId: FAMILY, status: "open", title: "Care for Mom" });
    hoisted.docs.set("job_posts/other-family", {
      clientId: "family-2", careVertical: "child", status: CHILDCARE_JOB_OPEN_STATUS,
    });
    const res = await listMine({}, ctx(FAMILY));
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].jobId).toBe(jobId);
    expect(Object.keys(res.jobs[0]).sort()).toEqual([...CHILDCARE_JOB_PUBLIC_FIELDS].sort());
  });
});

// ── listEligibleChildcareJobs (discovery) ────────────────────────────────────

describe("listEligibleChildcareJobs", () => {
  it("expired provider is excluded at DISCOVERY — empty jobs + own remediation only (R29/R30)", async () => {
    seedFamilyWithChildren();
    await createOpenJob();
    recheckMock.mockResolvedValue(INELIGIBLE("screening_expired"));
    const res = await discover({}, ctx(CG));
    expect(res.eligible).toBe(false);
    expect(res.jobs).toEqual([]);
    expect(res.remediation).toEqual(["screening_expired"]);
  });

  it("eligible provider sees fitting open jobs in the exact public projection", async () => {
    seedFamilyWithChildren();
    seedEligibleProvider();
    const jobId = await createOpenJob();
    const res = await discover({}, ctx(CG));
    expect(res.eligible).toBe(true);
    expect(res.jobs.map((j: any) => j.jobId)).toEqual([jobId]);
    expect(Object.keys(res.jobs[0]).sort()).toEqual([...CHILDCARE_JOB_PUBLIC_FIELDS].sort());
  });

  it("filters out jobs whose age bands the provider does not support", async () => {
    seedFamilyWithChildren();
    seedEligibleProvider();
    hoisted.docs.set(`caregivers/${CG}/vertical_profiles/child`, {
      ageBands: ["teen"], services: ["babysitting"], yearsChildcareExperience: 4,
    });
    await createOpenJob();
    const res = await discover({}, ctx(CG));
    expect(res.eligible).toBe(true);
    expect(res.jobs).toEqual([]); // empty, not an error
  });

  it("transport-required jobs appear only for MVR-evidence transport-capable providers (AE13)", async () => {
    seedFamilyWithChildren();
    seedEligibleProvider();
    const jobId = await createOpenJob();
    const priv = hoisted.docs.get(`job_posts/${jobId}`);
    hoisted.docs.set(`job_posts/${jobId}`, {
      ...priv,
      childRequirements: { ...priv.childRequirements, transportRequired: true },
    });
    recheckMock.mockResolvedValue(ELIGIBLE(false));
    expect((await discover({}, ctx(CG))).jobs).toEqual([]);
    recheckMock.mockResolvedValue(ELIGIBLE(true));
    expect((await discover({}, ctx(CG))).jobs.map((j: any) => j.jobId)).toEqual([jobId]);
  });

  it("is dark when discovery is disabled (R61)", async () => {
    enableFlags({ CHILDCARE_DISCOVERY_ENABLED: false });
    await expect(discover({}, ctx(CG))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "childcare_disabled" },
    });
  });
});

// ── applyToChildcareJob ──────────────────────────────────────────────────────

describe("applyToChildcareJob", () => {
  async function openJobWithProvider(): Promise<string> {
    seedFamilyWithChildren();
    seedEligibleProvider();
    return createOpenJob();
  }

  it("writes a privacy-safe application with disclosure + eligibility stamps", async () => {
    const jobId = await openJobWithProvider();
    const res = await applyJob({ jobId }, ctx(CG));
    expect(res.success).toBe(true);
    expect(res.created).toBe(true);
    expect(res.applicationId).toBe(childcareApplicationDocId(jobId, CG));

    const stored = hoisted.docs.get(`job_applications/${res.applicationId}`);
    expect(stored.careVertical).toBe("child");
    expect(stored.status).toBe("pending");
    expect(stored.disclosurePhase).toBe("application");
    expect(stored.eligibilityVersion).toBe("childcare-provider-eligibility-test");
    // No phone, no child facts — safe abstractions only (R33).
    expect(stored.phone).toBeUndefined();
    expect(() => assertChildSafeOutboundPayload(stored, "test")).not.toThrow();

    expect(Object.keys(res.application).sort()).toEqual(
      [...CHILDCARE_APPLICATION_PUBLIC_FIELDS].sort(),
    );
    // The recheck ran with the APPLICATION context (R29).
    expect(recheckMock).toHaveBeenCalledWith(CG, expect.objectContaining({ context: "application" }));
  });

  it("duplicate application converges to one doc (idempotent)", async () => {
    const jobId = await openJobWithProvider();
    const first = await applyJob({ jobId }, ctx(CG));
    const second = await applyJob({ jobId }, ctx(CG));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.applicationId).toBe(first.applicationId);
  });

  it("expired provider is excluded at APPLICATION (policy drift mid-flow fails here too)", async () => {
    const jobId = await openJobWithProvider();
    for (const code of ["screening_expired", "policy_acceptance_stale"]) {
      recheckMock.mockResolvedValue(INELIGIBLE(code));
      await expect(applyJob({ jobId }, ctx(CG))).rejects.toMatchObject({
        code: "failed-precondition",
        details: { code: "provider_not_eligible" },
      });
    }
    expect(hoisted.docs.has(`job_applications/${childcareApplicationDocId(jobId, CG)}`)).toBe(false);
  });

  it("rejects an eligible provider whose capabilities do not fit the job", async () => {
    const jobId = await openJobWithProvider();
    loadProfileMock.mockResolvedValue({ ageBands: ["teen"], services: ["babysitting"] });
    hoisted.docs.set(`caregivers/${CG}/vertical_profiles/child`, {
      ageBands: ["teen"], services: ["babysitting"],
    });
    await expect(applyJob({ jobId }, ctx(CG))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "job_requirements_not_met" },
    });
  });

  it("withdrawn/closed job rejects applications", async () => {
    const jobId = await openJobWithProvider();
    await closeJob({ jobId }, ctx(FAMILY));
    await expect(applyJob({ jobId }, ctx(CG))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "job_not_open" },
    });
  });

  it("senior jobs are not reachable through the childcare application callable", async () => {
    hoisted.docs.set("job_posts/senior-1", { clientId: "someone", status: "open" });
    await expect(applyJob({ jobId: "senior-1" }, ctx(CG))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });
});

// ── requestChildcareInterview (both-sides gates, R35) ────────────────────────

describe("requestChildcareInterview", () => {
  const WHEN = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  async function fullSetup(): Promise<string> {
    seedFamilyWithChildren();
    seedEligibleProvider();
    const jobId = await createOpenJob();
    await applyJob({ jobId }, ctx(CG));
    hoisted.docs.set(
      `childcare_identity_sessions/${familyChildcareObjectiveId(FAMILY)}`,
      { adultUid: FAMILY, status: "verified" },
    );
    return jobId;
  }

  it("creates an adult-to-adult, vertical-stamped, disclosure-safe interview (idempotent)", async () => {
    const jobId = await fullSetup();
    const res = await requestInterview(
      { jobId, caregiverId: CG, scheduledTime: WHEN, caregiverName: "Pat Provider" },
      ctx(FAMILY),
    );
    expect(res.success).toBe(true);
    expect(res.created).toBe(true);
    expect(res.interviewId).toBe(childcareInterviewDocId(jobId, CG));

    const stored = hoisted.docs.get(`video_interviews/${res.interviewId}`);
    expect(stored.careVertical).toBe("child");
    expect(stored.clientName).toBe("An Evia family"); // generic — never an account name
    expect(stored.disclosurePhase).toBe("interview");
    expect(stored.notes).toBeUndefined(); // no free-text surface
    expect(() => assertChildSafeOutboundPayload(stored, "test")).not.toThrow();
    expect(JSON.stringify(stored)).not.toMatch(/Kid|child-a|child-b/);
    // Interview-context recheck ran (R29).
    expect(recheckMock).toHaveBeenCalledWith(CG, expect.objectContaining({ context: "interview" }));

    const dup = await requestInterview({ jobId, caregiverId: CG, scheduledTime: WHEN }, ctx(FAMILY));
    expect(dup.created).toBe(false);
  });

  it("family side: identity verification is required", async () => {
    const jobId = await fullSetup();
    hoisted.docs.delete(`childcare_identity_sessions/${familyChildcareObjectiveId(FAMILY)}`);
    await expect(
      requestInterview({ jobId, caregiverId: CG, scheduledTime: WHEN }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "identity_required" } });
  });

  it("family side: revoked schedule authority since posting denies (AE20)", async () => {
    const jobId = await fullSetup();
    hoisted.docs.set(`guardian_authorities/${authorityDocId("child-a", FAMILY)}`, {
      childId: "child-a", adultUid: FAMILY, state: "revoked", scopes: ["view", "schedule"], accessVersion: 2,
    });
    await expect(
      requestInterview({ jobId, caregiverId: CG, scheduledTime: WHEN }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("provider side: no active application blocks the interview", async () => {
    const jobId = await fullSetup();
    hoisted.docs.delete(`job_applications/${childcareApplicationDocId(jobId, CG)}`);
    await expect(
      requestInterview({ jobId, caregiverId: CG, scheduledTime: WHEN }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "no_active_application" } });
  });

  it("provider side: expired provider is excluded at INTERVIEW (R29)", async () => {
    const jobId = await fullSetup();
    recheckMock.mockResolvedValue(INELIGIBLE("screening_expired"));
    await expect(
      requestInterview({ jobId, caregiverId: CG, scheduledTime: WHEN }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "provider_not_eligible" } });
    expect(hoisted.docs.has(`video_interviews/${childcareInterviewDocId(jobId, CG)}`)).toBe(false);
  });

  it("only the job owner can request (enumeration-safe)", async () => {
    const jobId = await fullSetup();
    await expect(
      requestInterview({ jobId, caregiverId: CG, scheduledTime: WHEN }, ctx("stranger")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── Calendar/SMS privacy (interviewLinkTrigger childcare content branch) ─────

describe("childcare interview calendar/SMS privacy (R35/R43)", () => {
  const childcareDoc = { careVertical: "child", clientName: "An Evia family", caregiverName: "Pat Provider" };
  const seniorDoc = { clientName: "The Nguyen family", caregiverName: "Pat Provider" };

  it("calendar titles: childcare fully generic; senior byte-identical", () => {
    expect(interviewCalendarTitle(childcareDoc as any, "Pat Provider")).toBe("Evia Care Interview");
    expect(interviewCalendarTitle(seniorDoc as any, "Pat Provider")).toBe("Care Interview — Pat Provider");
  });

  it("link SMS: childcare carries no names or child data; senior byte-identical", () => {
    const cc = interviewLinkMessage(childcareDoc as any, "caregiver", "An Evia family", "Fri 3pm", "https://call", "https://ics");
    expect(cc).toBe("Your Evia interview is confirmed for Fri 3pm. Join from your phone: https://call\n\nCalendar invite: https://ics");
    expect(cc).not.toMatch(/Pat|family|Kid/i);
    const senior = interviewLinkMessage(seniorDoc as any, "caregiver", "The Nguyen family", "Fri 3pm", "https://call", "");
    expect(senior).toBe("Your interview with The Nguyen family is confirmed for Fri 3pm. Join from your phone: https://call");
  });
});
