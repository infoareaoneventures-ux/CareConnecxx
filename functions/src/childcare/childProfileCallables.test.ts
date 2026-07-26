// U3 (childcare marketplace plan 2026-07-22-002): v1 child-profile + lifecycle
// callables. Scenarios: full U2 middleware stack (App Check, Firestore-resident
// flags, rate limits, auth_time recent-auth, idempotency), create/read/update
// by authority scope, enumeration-safe errors, stale-viewer-cache vs authority
// (authority wins — the cache never authorizes a callable), export/deletion
// request gates incl. legal hold, and requester-scoped lifecycle status.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── In-memory Firestore mock (U2 pattern + subcollections + deletes) ─────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

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
    delete: async () => {
      docs.delete(path);
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = doc?.[f.field];
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === "<=") return typeof v === "string" && v <= f.value;
    return false;
  };

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
      delete: (ref: any) => {
        docs.delete(ref.path);
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

import {
  createChildProfile as _createChildProfile,
  updateChildProfile as _updateChildProfile,
  appendChildSafetyVersion as _appendChildSafetyVersion,
  getChildProfile as _getChildProfile,
  listMyChildren as _listMyChildren,
  requestChildDataExport as _requestChildDataExport,
  requestChildDataDeletion as _requestChildDataDeletion,
  getLifecycleRequestStatus as _getLifecycleRequestStatus,
} from "./childProfileCallables";
import { GUARDIAN_SCOPES } from "./guardianAuthority";
import { bustChildcareFlagsCache } from "../config/featureFlags";
import { setChildLegalHold } from "../data/childProfileRepository";

// The firebase-functions/v1 stub makes onCall(fn) === fn.
/* eslint-disable @typescript-eslint/no-explicit-any */
const createChildProfile = _createChildProfile as any;
const updateChildProfile = _updateChildProfile as any;
const appendChildSafetyVersion = _appendChildSafetyVersion as any;
const getChildProfile = _getChildProfile as any;
const listMyChildren = _listMyChildren as any;
const requestChildDataExport = _requestChildDataExport as any;
const requestChildDataDeletion = _requestChildDataDeletion as any;
const getLifecycleRequestStatus = _getLifecycleRequestStatus as any;

const HH = "hh_parent-1";
const freshAuthTime = () => Math.floor(Date.now() / 1000) - 5;
const staleAuthTime = () => Math.floor(Date.now() / 1000) - 3600;

function ctx(uid: string, opts: { authTime?: number; app?: boolean } = {}): any {
  return {
    auth: { uid, token: { auth_time: opts.authTime ?? freshAuthTime() } },
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

function seedHousehold() {
  hoisted.docs.set(`households/${HH}`, {
    householdId: HH,
    primaryAdultUid: "parent-1",
    status: "active",
    accessVersion: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
}

function seedMembership(adultUid: string) {
  hoisted.docs.set(`household_memberships/${HH}__${adultUid}`, {
    membershipId: `${HH}__${adultUid}`,
    householdId: HH,
    adultUid,
    role: adultUid === "parent-1" ? "primary" : "adult",
    status: "active",
    joinedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
}

function seedAuthority(childId: string, adultUid: string, overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`guardian_authorities/${childId}__${adultUid}`, {
    authorityId: `${childId}__${adultUid}`,
    householdId: HH,
    childId,
    adultUid,
    careVertical: "child",
    scopes: [...GUARDIAN_SCOPES],
    state: "active",
    source: "explicit_grant",
    grantedByUid: "parent-1",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    expiresAt: null,
    accessVersion: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

const VALID_SAFETY = {
  dateOfBirth: "2020-03-15",
  emergencyContacts: [{ name: "Grandma Rosa", relationship: "grandmother", phone: "+14085551234" }],
  healthNotes: "peanut allergy",
};

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    householdId: HH,
    displayLabel: "Mia",
    careCategories: ["babysitting"],
    safety: VALID_SAFETY,
    idempotencyKey: "op-1",
    guardianAttestationVersion: "attest-v1",
    ...overrides,
  };
}

async function createChild(): Promise<string> {
  const result = await createChildProfile(createPayload(), ctx("parent-1"));
  return result.childId;
}

const originalAppCheckMode = process.env.CHILDCARE_APPCHECK_MODE;

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.CHILDCARE_APPCHECK_MODE;
  enableChildcareFlags();
  seedHousehold();
  seedMembership("parent-1");
  seedMembership("aunt-1");
});

afterEach(() => {
  if (originalAppCheckMode === undefined) delete process.env.CHILDCARE_APPCHECK_MODE;
  else process.env.CHILDCARE_APPCHECK_MODE = originalAppCheckMode;
  bustChildcareFlagsCache();
});

// ── shared gates (the U2 middleware stack) ───────────────────────────────────

describe("shared callable gates", () => {
  it("unauthenticated callers are rejected", async () => {
    await expect(createChildProfile(createPayload(), {} as any)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(listMyChildren({}, {} as any)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("childcare flags OFF keeps every callable dark (fail-closed R61)", async () => {
    hoisted.docs.delete("childcare_flags/global");
    bustChildcareFlagsCache();
    await expect(createChildProfile(createPayload(), ctx("parent-1"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
    await expect(listMyChildren({}, ctx("parent-1"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("writesEnabled=false blocks mutations while reads still work", async () => {
    const childId = await createChild();
    enableChildcareFlags({ CHILDCARE_WRITES_ENABLED: false });
    await expect(
      updateChildProfile({ childId, displayLabel: "X" }, ctx("parent-1")),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    const read = await getChildProfile({ childId }, ctx("parent-1"));
    expect(read.success).toBe(true);
  });

  it("App Check enforce mode fails closed without a verified app", async () => {
    process.env.CHILDCARE_APPCHECK_MODE = "enforce";
    await expect(
      createChildProfile(createPayload(), ctx("parent-1", { app: false })),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("rate limit: an exhausted window rejects resource-exhausted", async () => {
    hoisted.docs.set("rate_limits/rl:childcare:mut:createChildProfile:parent-1", {
      windowStart: Date.now(),
      count: 10,
      updatedAt: Date.now(),
    });
    await expect(createChildProfile(createPayload(), ctx("parent-1"))).rejects.toMatchObject({
      code: "resource-exhausted",
    });
  });

  it("recent-auth: stale auth_time rejects the high-risk callables (R18)", async () => {
    const stale = ctx("parent-1", { authTime: staleAuthTime() });
    await expect(createChildProfile(createPayload(), stale)).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "recent_auth_required" },
    });
    await expect(
      appendChildSafetyVersion({ childId: "c", safety: {} }, stale),
    ).rejects.toMatchObject({ details: { code: "recent_auth_required" } });
    await expect(
      requestChildDataDeletion({ childId: "c", idempotencyKey: "k" }, stale),
    ).rejects.toMatchObject({ details: { code: "recent_auth_required" } });
    await expect(
      requestChildDataExport({ childId: "c", idempotencyKey: "k" }, stale),
    ).rejects.toMatchObject({ details: { code: "recent_auth_required" } });
  });
});

// ── create ───────────────────────────────────────────────────────────────────

describe("createChildProfile", () => {
  it("creates profile + bootstrap authority and returns the SUMMARY only (no DOB)", async () => {
    const result = await createChildProfile(createPayload(), ctx("parent-1"));
    expect(result.success).toBe(true);
    expect(result.profile.ageBand).toBe("school_age");
    expect(result.authority.scopes).toContain("management");
    // The response NEVER carries the private zone.
    expect(JSON.stringify(result)).not.toContain("2020-03-15");
    expect(JSON.stringify(result)).not.toContain("peanut");
    expect(JSON.stringify(result)).not.toContain("+14085551234");
  });

  it("requires a versioned guardian attestation (R23 — never a boolean)", async () => {
    await expect(
      createChildProfile(createPayload({ guardianAttestationVersion: "" }), ctx("parent-1")),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("non-primary adults are denied with the generic permission error", async () => {
    await expect(createChildProfile(createPayload(), ctx("aunt-1"))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("is idempotent per operation key", async () => {
    const first = await createChildProfile(createPayload(), ctx("parent-1"));
    const second = await createChildProfile(createPayload(), ctx("parent-1"));
    expect(second.childId).toBe(first.childId);
    expect(second.created).toBe(false);
  });
});

// ── read by scope + enumeration safety + cache-vs-authority ─────────────────

describe("getChildProfile / listMyChildren", () => {
  it("view-scoped adults read the summary; scopeless household members do not (AE4)", async () => {
    const childId = await createChild();
    seedAuthority(childId, "aunt-1", { scopes: ["view"] });
    const read = await getChildProfile({ childId }, ctx("aunt-1"));
    expect(read.profile.displayLabel).toBe("Mia");

    // Household member WITHOUT authority: denied.
    seedMembership("uncle-1");
    await expect(getChildProfile({ childId }, ctx("uncle-1"))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("unknown child and unauthorized child return the IDENTICAL error (enumeration-safe)", async () => {
    const childId = await createChild();
    const unauthorized = await getChildProfile({ childId }, ctx("stranger-1")).catch((e: any) => e);
    const missing = await getChildProfile({ childId: "child_nope" }, ctx("stranger-1")).catch((e: any) => e);
    expect(unauthorized.code).toBe("permission-denied");
    expect(missing.code).toBe("permission-denied");
    expect(unauthorized.message).toBe(missing.message);
  });

  it("STALE VIEWER CACHE vs authority: the authority wins — a cached uid with revoked authority is denied", async () => {
    const childId = await createChild();
    // Simulate a stale derived cache: revoked-1 still listed as a viewer...
    const doc = hoisted.docs.get(`child_profiles/${childId}`);
    hoisted.docs.set(`child_profiles/${childId}`, {
      ...doc,
      authorizedViewerUids: [...doc.authorizedViewerUids, "revoked-1"],
    });
    // ...but the authority record is REVOKED (version moved past the cache).
    seedAuthority(childId, "revoked-1", { state: "revoked", accessVersion: 4 });
    await expect(getChildProfile({ childId }, ctx("revoked-1"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    const list = await listMyChildren({}, ctx("revoked-1"));
    expect(list.children).toEqual([]);
  });

  it("listMyChildren returns only children with ACTIVE view authority", async () => {
    const childId = await createChild();
    seedAuthority(childId, "aunt-1", { scopes: ["view", "schedule"] });
    const forAunt = await listMyChildren({}, ctx("aunt-1"));
    expect(forAunt.children).toHaveLength(1);
    expect(forAunt.children[0].childId).toBe(childId);
    expect(forAunt.children[0].myScopes).toEqual(["view", "schedule"]);

    seedAuthority(childId, "expired-1", { expiresAt: "2026-01-01T00:00:00.000Z" });
    const forExpired = await listMyChildren({}, ctx("expired-1"));
    expect(forExpired.children).toEqual([]);
  });
});

// ── update + safety append by scope ──────────────────────────────────────────

describe("updateChildProfile / appendChildSafetyVersion", () => {
  it("management updates; view-only adults are denied", async () => {
    const childId = await createChild();
    seedAuthority(childId, "aunt-1", { scopes: ["view"] });
    const ok = await updateChildProfile({ childId, displayLabel: "Mia R" }, ctx("parent-1"));
    expect(ok.profile.displayLabel).toBe("Mia R");
    await expect(
      updateChildProfile({ childId, displayLabel: "X" }, ctx("aunt-1")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("appendChildSafetyVersion returns the version NUMBER, never the restricted payload", async () => {
    const childId = await createChild();
    const result = await appendChildSafetyVersion(
      { childId, safety: { healthNotes: "inhaler plan" }, idempotencyKey: "s2" },
      ctx("parent-1"),
    );
    expect(result.version).toBe(2);
    expect(JSON.stringify(result)).not.toContain("inhaler");
    expect(JSON.stringify(result)).not.toContain("2020-03-15");
  });

  it("a legal hold surfaces as failed-precondition on safety appends", async () => {
    const childId = await createChild();
    await setChildLegalHold(childId, { active: true, reason: "case 1", placedByUid: "op-1" });
    await expect(
      appendChildSafetyVersion({ childId, safety: { healthNotes: "x" } }, ctx("parent-1")),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "legal_hold_active" } });
  });
});

// ── lifecycle requests ───────────────────────────────────────────────────────

describe("lifecycle callables", () => {
  it("export request creates a pending state-machine doc", async () => {
    const childId = await createChild();
    const result = await requestChildDataExport({ childId, idempotencyKey: "e1" }, ctx("parent-1"));
    expect(result.success).toBe(true);
    expect(result.state).toBe("pending");
    const doc = hoisted.docs.get(`data_lifecycle_requests/${result.requestId}`);
    expect(doc.scope).toBe("export");
    expect(doc.tasks.map((t: any) => t.kind)).toEqual(["export_bundle"]);
  });

  it("deletion requires management; view-only and strangers are denied", async () => {
    const childId = await createChild();
    seedAuthority(childId, "aunt-1", { scopes: ["view"] });
    await expect(
      requestChildDataDeletion({ childId, idempotencyKey: "d1" }, ctx("aunt-1")),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      requestChildDataDeletion({ childId, idempotencyKey: "d1" }, ctx("stranger-1")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("LEGAL HOLD blocks deletion at creation with an explicit precondition", async () => {
    const childId = await createChild();
    await setChildLegalHold(childId, { active: true, reason: "case 2", placedByUid: "op-1" });
    await expect(
      requestChildDataDeletion({ childId, idempotencyKey: "d2" }, ctx("parent-1")),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "legal_hold_active" } });
    // Export is NOT blocked by a hold.
    const exportResult = await requestChildDataExport({ childId, idempotencyKey: "e2" }, ctx("parent-1"));
    expect(exportResult.success).toBe(true);
  });

  it("getLifecycleRequestStatus is requester-scoped (others get the generic error)", async () => {
    const childId = await createChild();
    const created = await requestChildDataDeletion({ childId, idempotencyKey: "d3" }, ctx("parent-1"));
    const status = await getLifecycleRequestStatus({ requestId: created.requestId }, ctx("parent-1"));
    expect(status.state).toBe("pending");
    expect(status.tasks.length).toBeGreaterThan(1);
    // Another adult — even one with authority over the child — cannot read it.
    seedAuthority(childId, "aunt-1");
    await expect(
      getLifecycleRequestStatus({ requestId: created.requestId }, ctx("aunt-1")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});
