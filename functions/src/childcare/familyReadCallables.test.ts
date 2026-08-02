// U11 family-facing READ callable tests (plan 2026-07-22-002).
//
// Covers, per callable: authorized family/member happy path; wrong-authority /
// non-member denial; enumeration-safe wrong-ID (identical to no-authority);
// flags-off behavior (childcare_disabled); no child PII (exact address / DOB) in
// any response (exact response key sets asserted); App Check + rate-limit wiring
// present; the U6 eligibility hard-filter on applications; and the manager-only
// household-member enumeration (non-manager gets own record only).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── In-memory Firestore mock (bookingCallables.test pattern: ==, in) ──────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

  const valueAt = (doc: any, path: string): unknown =>
    path.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = valueAt(doc, f.field);
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === "array-contains") return Array.isArray(v) && v.includes(f.value);
    if (f.op === "<=") return typeof v === "string" && v <= f.value;
    return false;
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
        .filter((r) => filters.every((f) => matches(r._raw, f)));
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
      orderBy: q.orderBy,
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

  return {
    docs,
    db: { collection: (p: string) => makeCollRef(p), runTransaction },
    reset: () => docs.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => hoisted.db, {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete: () => ({ __delete: true }),
      increment: (n: number) => ({ __increment: n }),
    },
  });
  return {
    __esModule: true,
    default: { firestore, apps: [{}] },
    firestore,
    apps: [{}],
  };
});

vi.mock("../observability/auditLog", () => ({
  logAudit: vi.fn(async () => {}),
}));

const recheckMock = vi.hoisted(() => vi.fn());
vi.mock("./providerEligibility", () => ({
  recheckChildcareProviderEligibility: recheckMock,
}));

import {
  listMyChildcareBookings as _listBookings,
  getChildcareBooking as _getBooking,
  listChildcareJobApplications as _listApps,
  listHouseholdMembers as _listMembers,
} from "./familyReadCallables";
import { authorityDocId } from "./guardianAuthority";
import { membershipDocId } from "./householdRepository";
import { bustChildcareFlagsCache } from "../config/featureFlags";

/* eslint-disable @typescript-eslint/no-explicit-any */
const listBookings = _listBookings as any;
const getBooking = _getBooking as any;
const listApps = _listApps as any;
const listMembers = _listMembers as any;

const FAMILY = "family-1";
const COGUARDIAN = "adult-2";
const STRANGER = "stranger-9";
const CG = "cg-1";
const HH = "hh_family-1";

function ctx(uid: string, withApp = true): any {
  return {
    auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) - 5 } },
    ...(withApp ? { app: { appId: "test-app" } } : {}),
  };
}

function enableFlags(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set("childcare_flags/global", {
    CHILDCARE_ENABLED: true,
    CHILDCARE_DISCOVERY_ENABLED: true,
    CHILDCARE_WRITES_ENABLED: true,
    ...overrides,
  });
  bustChildcareFlagsCache();
}

function seedHousehold(primaryUid = FAMILY) {
  hoisted.docs.set(`households/${HH}`, {
    householdId: HH,
    primaryAdultUid: primaryUid,
    status: "active",
    accessVersion: 1,
  });
}

function seedMembership(uid: string, role: "primary" | "adult", status = "active") {
  hoisted.docs.set(`household_memberships/${membershipDocId(HH, uid)}`, {
    membershipId: membershipDocId(HH, uid),
    householdId: HH,
    adultUid: uid,
    role,
    status,
  });
}

function seedAuthority(
  childId: string,
  uid: string,
  scopes: string[] = ["view", "schedule", "cancellation"],
  state = "active",
) {
  hoisted.docs.set(`guardian_authorities/${authorityDocId(childId, uid)}`, {
    authorityId: authorityDocId(childId, uid),
    householdId: HH,
    childId,
    adultUid: uid,
    state,
    scopes,
    accessVersion: 1,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    expiresAt: null,
  });
}

function seedUser(uid: string, name: string) {
  hoisted.docs.set(`users/${uid}`, { name });
}

function seedBooking(bookingId: string, overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`booking_requests/${bookingId}`, {
    careVertical: "child",
    bookingId,
    clientId: FAMILY,
    caregiverId: CG,
    caregiverName: "Pat Provider",
    householdId: HH,
    childIds: ["child-a"],
    recipientLabel: "M.",
    status: "confirmed",
    stateVersion: 3,
    schedule: { dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "13:00" }], recurring: null },
    hourlyRate: 28,
    paymentAuthorization: { state: "authorized", correlationId: "pi_1", updatedAt: "2026-08-01T00:00:00.000Z" },
    safetyAccessVersion: 1,
    pendingChange: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    // Deliberately include child-sensitive-looking fields the projection must
    // DROP — nothing address/DOB may ever reach a response.
    addressDetail: "123 Exact St",
    ...overrides,
  });
}

function seedJob(jobId: string, childIds = ["child-a"]) {
  hoisted.docs.set(`job_posts/${jobId}`, {
    careVertical: "child",
    clientId: FAMILY,
    status: "open_childcare",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  hoisted.docs.set(`job_posts/${jobId}/private/children`, { childIds, householdId: HH });
}

function seedApplication(jobId: string, caregiverId: string, status = "pending") {
  const id = `capp_${jobId}_${caregiverId}`;
  hoisted.docs.set(`job_applications/${id}`, {
    careVertical: "child",
    jobId,
    caregiverId,
    clientId: FAMILY,
    status,
    disclosurePhase: "application",
    appliedAt: "2026-08-02T00:00:00.000Z",
    jobTitle: "Childcare",
    areaLabel: "San Jose, CA",
    rate: 28,
    rateFlexible: false,
    // sensitive fields the public projection must NOT echo
    ssn: "000-00-0000",
  });
  return id;
}

const ELIGIBLE = { eligible: true, issues: [], capabilities: { transport: false } };
const INELIGIBLE = { eligible: false, issues: [{ code: "screening_expired" }], capabilities: {} };

const BOOKING_KEYS = [
  "bookingId", "status", "statusDescription", "stateVersion", "caregiverId",
  "caregiverName", "recipientLabel", "childIds", "schedule", "hourlyRate",
  "paymentAuthorization", "safetyAccessVersion", "pendingChange",
].sort();

function assertNoChildPII(payload: unknown) {
  const json = JSON.stringify(payload).toLowerCase();
  expect(json).not.toContain("exact st");
  expect(json).not.toContain("addressdetail");
  expect(json).not.toContain("dateofbirth");
  expect(json).not.toContain("2022-04-01"); // seeded DOB value if it leaked
  expect(json).not.toContain("ssn");
}

beforeEach(() => {
  hoisted.reset();
  recheckMock.mockReset();
  recheckMock.mockResolvedValue(ELIGIBLE);
  delete process.env.CHILDCARE_APPCHECK_MODE;
  enableFlags();
});

afterEach(() => {
  delete process.env.CHILDCARE_APPCHECK_MODE;
});

// ── listMyChildcareBookings ──────────────────────────────────────────────────
describe("listMyChildcareBookings", () => {
  it("family: returns bookings the caller holds authority on, family-safe keys only", async () => {
    seedHousehold();
    seedAuthority("child-a", FAMILY);
    seedBooking("bk-1");
    const res = await listBookings({ role: "family" }, ctx(FAMILY));
    expect(res.success).toBe(true);
    expect(res.bookings).toHaveLength(1);
    expect(Object.keys(res.bookings[0]).sort()).toEqual(BOOKING_KEYS);
    expect(res.bookings[0].paymentAuthorization).toEqual({ state: "authorized" });
    expect(res.bookings[0].recipientLabel).toBe("M.");
    assertNoChildPII(res.bookings);
  });

  it("family: a co-guardian with authority on a sibling child sees the booking", async () => {
    seedHousehold();
    seedAuthority("child-a", COGUARDIAN, ["view"]);
    seedBooking("bk-1");
    const res = await listBookings({ role: "family" }, ctx(COGUARDIAN));
    expect(res.bookings).toHaveLength(1);
  });

  it("family: no authority → empty list (never leaks other households' bookings)", async () => {
    seedHousehold();
    seedBooking("bk-1");
    const res = await listBookings({ role: "family" }, ctx(STRANGER));
    expect(res.bookings).toEqual([]);
  });

  it("family: a revoked authority does not surface the booking", async () => {
    seedHousehold();
    seedAuthority("child-a", FAMILY, ["view"], "revoked");
    seedBooking("bk-1");
    const res = await listBookings({ role: "family" }, ctx(FAMILY));
    expect(res.bookings).toEqual([]);
  });

  it("provider: returns bookings where the caller is the assigned caregiver", async () => {
    seedBooking("bk-1");
    const res = await listBookings({ role: "provider" }, ctx(CG));
    expect(res.bookings).toHaveLength(1);
    expect(Object.keys(res.bookings[0]).sort()).toEqual(BOOKING_KEYS);
    const other = await listBookings({ role: "provider" }, ctx("cg-other"));
    expect(other.bookings).toEqual([]);
  });

  it("rejects an unknown role", async () => {
    await expect(listBookings({ role: "admin" }, ctx(FAMILY))).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  it("flags-off returns childcare_disabled", async () => {
    enableFlags({ CHILDCARE_ENABLED: false });
    await expect(listBookings({ role: "family" }, ctx(FAMILY))).rejects.toMatchObject({
      details: { code: "childcare_disabled" },
    });
  });

  it("App Check enforce mode fails closed without an app token", async () => {
    process.env.CHILDCARE_APPCHECK_MODE = "enforce";
    await expect(listBookings({ role: "family" }, ctx(FAMILY, false))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });
});

// ── getChildcareBooking ──────────────────────────────────────────────────────
describe("getChildcareBooking", () => {
  it("authorized family: returns the family-safe booking (no safety payload, no address)", async () => {
    seedAuthority("child-a", FAMILY);
    seedBooking("bk-1");
    const res = await getBooking({ bookingId: "bk-1" }, ctx(FAMILY));
    expect(res.success).toBe(true);
    expect(Object.keys(res.booking).sort()).toEqual(BOOKING_KEYS);
    assertNoChildPII(res.booking);
  });

  it("enumeration-safe: wrong bookingId and no-authority raise the SAME error", async () => {
    seedAuthority("child-a", FAMILY);
    seedBooking("bk-1");
    const missing = await getBooking({ bookingId: "does-not-exist" }, ctx(FAMILY)).catch((e: any) => e);
    const noAuth = await getBooking({ bookingId: "bk-1" }, ctx(STRANGER)).catch((e: any) => e);
    expect(missing.code).toBe("permission-denied");
    expect(noAuth.code).toBe("permission-denied");
    expect(missing.message).toBe(noAuth.message);
  });

  it("flags-off returns childcare_disabled", async () => {
    enableFlags({ CHILDCARE_ENABLED: false });
    seedAuthority("child-a", FAMILY);
    seedBooking("bk-1");
    await expect(getBooking({ bookingId: "bk-1" }, ctx(FAMILY))).rejects.toMatchObject({
      details: { code: "childcare_disabled" },
    });
  });
});

// ── listChildcareJobApplications ─────────────────────────────────────────────
describe("listChildcareJobApplications", () => {
  it("family with schedule authority: returns public application projections only", async () => {
    seedAuthority("child-a", FAMILY);
    seedJob("job-1");
    seedApplication("job-1", CG);
    const res = await listApps({ jobId: "job-1" }, ctx(FAMILY));
    expect(res.success).toBe(true);
    expect(res.applications).toHaveLength(1);
    const app = res.applications[0];
    expect(app.applicationId).toBeTruthy();
    expect(app.caregiverId).toBe(CG);
    expect(app).not.toHaveProperty("ssn");
    assertNoChildPII(res.applications);
  });

  it("drops ineligible PENDING applicants (U6 hard-filter posture)", async () => {
    seedAuthority("child-a", FAMILY);
    seedJob("job-1");
    seedApplication("job-1", CG); // pending, will be ineligible
    recheckMock.mockResolvedValue(INELIGIBLE);
    const res = await listApps({ jobId: "job-1" }, ctx(FAMILY));
    expect(res.applications).toEqual([]);
  });

  it("keeps already-decided (accepted) applications regardless of live eligibility", async () => {
    seedAuthority("child-a", FAMILY);
    seedJob("job-1");
    seedApplication("job-1", CG, "accepted");
    recheckMock.mockResolvedValue(INELIGIBLE);
    const res = await listApps({ jobId: "job-1" }, ctx(FAMILY));
    expect(res.applications).toHaveLength(1);
    expect(res.applications[0].status).toBe("accepted");
  });

  it("denies a caller without schedule authority on every child (enumeration-safe)", async () => {
    seedAuthority("child-a", STRANGER, ["view"]); // has view, not schedule
    seedJob("job-1");
    seedApplication("job-1", CG);
    await expect(listApps({ jobId: "job-1" }, ctx(STRANGER))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("flags-off returns childcare_disabled", async () => {
    enableFlags({ CHILDCARE_ENABLED: false });
    seedAuthority("child-a", FAMILY);
    seedJob("job-1");
    await expect(listApps({ jobId: "job-1" }, ctx(FAMILY))).rejects.toMatchObject({
      details: { code: "childcare_disabled" },
    });
  });
});

// ── listHouseholdMembers ─────────────────────────────────────────────────────
describe("listHouseholdMembers", () => {
  it("manager (primary): lists OTHER adults with per-child authorities; self excluded", async () => {
    seedHousehold(FAMILY);
    seedMembership(FAMILY, "primary");
    seedMembership(COGUARDIAN, "adult");
    seedAuthority("child-a", FAMILY, ["view", "schedule", "management"]);
    seedAuthority("child-a", COGUARDIAN, ["view"]);
    seedUser(COGUARDIAN, "Alex P");
    const res = await listMembers({ householdId: HH }, ctx(FAMILY));
    expect(res.success).toBe(true);
    expect(res.isManager).toBe(true);
    expect(res.members).toHaveLength(1);
    const row = res.members[0];
    expect(Object.keys(row).sort()).toEqual(
      ["adultUid", "authorities", "displayLabel", "membershipStatus", "role"].sort(),
    );
    expect(row.adultUid).toBe(COGUARDIAN);
    expect(row.displayLabel).toBe("Alex P");
    expect(row.authorities[0]).toMatchObject({ childId: "child-a", scopes: ["view"], state: "active" });
    assertNoChildPII(res.members);
  });

  it("a management-scope holder (non-primary) is also a manager", async () => {
    seedHousehold(FAMILY);
    seedMembership(FAMILY, "primary");
    seedMembership(COGUARDIAN, "adult");
    seedAuthority("child-a", COGUARDIAN, ["view", "management"]);
    const res = await listMembers({ householdId: HH }, ctx(COGUARDIAN));
    expect(res.isManager).toBe(true);
    // Other adults = FAMILY (the primary); COGUARDIAN (self) excluded.
    expect(res.members.map((m: any) => m.adultUid)).toEqual([FAMILY]);
  });

  it("non-manager active member gets their OWN record only (stricter R7/R18 reading)", async () => {
    seedHousehold(FAMILY);
    seedMembership(FAMILY, "primary");
    seedMembership(COGUARDIAN, "adult");
    seedAuthority("child-a", COGUARDIAN, ["view"]); // no management
    const res = await listMembers({ householdId: HH }, ctx(COGUARDIAN));
    expect(res.isManager).toBe(false);
    expect(res.members).toHaveLength(1);
    expect(res.members[0].adultUid).toBe(COGUARDIAN);
  });

  it("non-member is denied (enumeration-safe)", async () => {
    seedHousehold(FAMILY);
    seedMembership(FAMILY, "primary");
    await expect(listMembers({ householdId: HH }, ctx(STRANGER))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("flags-off returns childcare_disabled", async () => {
    enableFlags({ CHILDCARE_ENABLED: false });
    seedHousehold(FAMILY);
    seedMembership(FAMILY, "primary");
    await expect(listMembers({ householdId: HH }, ctx(FAMILY))).rejects.toMatchObject({
      details: { code: "childcare_disabled" },
    });
  });
});
