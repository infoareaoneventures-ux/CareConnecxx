// U2 (childcare marketplace plan 2026-07-22-002): canonical household +
// membership repository. Core invariants under test: idempotent creation with
// stable ownership, provisional phone-only members carrying ZERO grantable
// scopes (and no raw phone), membership revocation bumping the household
// accessVersion, and the derived summary being a versioned cache.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  });

  const makeQuery = (collPath: string, filters: any[] = []): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(collPath, [...filters, { field, op, value }]),
    get: async () => {
      const rows = [...docs.entries()]
        .filter(
          ([p]) =>
            p.startsWith(`${collPath}/`) &&
            p.split("/").length === collPath.split("/").length + 1,
        )
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) =>
          filters.every((f) =>
            f.op === "==" ? r._raw?.[f.field] === f.value : false,
          ),
        );
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${docs.size}`}`),
    where: makeQuery(path).where,
    get: makeQuery(path).get,
  });

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

import {
  householdDocId,
  membershipDocId,
  provisionalMembershipDocId,
  membershipPhoneHash,
  createHouseholdWithPrimaryMembership,
  getHousehold,
  getMembership,
  getActiveMembership,
  listHouseholdMemberships,
  listMembershipsForAdult,
  recordProvisionalPhoneMembership,
  promoteProvisionalMembership,
  revokeMembership,
  recomputeHouseholdDerivedSummary,
} from "./householdRepository";

const NOW = new Date("2026-07-22T12:00:00.000Z");

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
});

describe("deterministic IDs", () => {
  it("household ID is seeded from the primary adult uid", () => {
    expect(householdDocId("uid-1")).toBe("hh_uid-1");
    expect(() => householdDocId("")).toThrow();
  });

  it("membership ID is householdId__adultUid", () => {
    expect(membershipDocId("hh_uid-1", "uid-2")).toBe("hh_uid-1__uid-2");
  });

  it("provisional ID uses a PHONE HASH — the raw phone never appears in the ID", () => {
    const id = provisionalMembershipDocId("hh_uid-1", "+14085551234");
    expect(id.startsWith("hh_uid-1__prov_")).toBe(true);
    expect(id).not.toMatch(/4085551234/);
    // Deterministic (idempotent SMS-join retries):
    expect(provisionalMembershipDocId("hh_uid-1", "+14085551234")).toBe(id);
    expect(membershipPhoneHash("+14085551234")).toHaveLength(64);
  });
});

describe("createHouseholdWithPrimaryMembership (primary adult scenario)", () => {
  it("creates the household + primary membership transactionally", async () => {
    const result = await createHouseholdWithPrimaryMembership("parent-1", { now: NOW });
    expect(result.created).toBe(true);
    expect(result.household).toMatchObject({
      householdId: "hh_parent-1",
      primaryAdultUid: "parent-1",
      status: "active",
      accessVersion: 1,
    });
    expect(result.membership).toMatchObject({
      householdId: "hh_parent-1",
      adultUid: "parent-1",
      role: "primary",
      status: "active",
      source: "household_create",
    });
    expect(hoisted.docs.get("households/hh_parent-1")).toBeTruthy();
    expect(hoisted.docs.get("household_memberships/hh_parent-1__parent-1")).toBeTruthy();
  });

  it("is idempotent — re-running returns the existing household", async () => {
    await createHouseholdWithPrimaryMembership("parent-1", { now: NOW });
    const again = await createHouseholdWithPrimaryMembership("parent-1", { now: NOW });
    expect(again.created).toBe(false);
    expect(again.household.householdId).toBe("hh_parent-1");
  });

  it("fails closed when the seeded ID belongs to a transferred household (the seed is NOT ownership)", async () => {
    hoisted.docs.set("households/hh_parent-1", {
      householdId: "hh_parent-1",
      primaryAdultUid: "someone-else",
      status: "active",
      accessVersion: 3,
    });
    await expect(createHouseholdWithPrimaryMembership("parent-1", { now: NOW })).rejects.toMatchObject({
      code: "household_owned_by_other",
    });
  });
});

describe("membership reads", () => {
  beforeEach(async () => {
    await createHouseholdWithPrimaryMembership("parent-1", { now: NOW });
  });

  it("getMembership / getActiveMembership honor status", async () => {
    expect(await getMembership("hh_parent-1", "parent-1")).toMatchObject({ role: "primary" });
    expect(await getActiveMembership("hh_parent-1", "parent-1")).toBeTruthy();
    hoisted.docs.set("household_memberships/hh_parent-1__aunt-1", {
      membershipId: "hh_parent-1__aunt-1",
      householdId: "hh_parent-1",
      adultUid: "aunt-1",
      role: "adult",
      status: "revoked",
    });
    expect(await getActiveMembership("hh_parent-1", "aunt-1")).toBeNull();
    expect(await getMembership("hh_parent-1", "missing")).toBeNull();
  });

  it("listHouseholdMemberships / listMembershipsForAdult use equality-only queries", async () => {
    hoisted.docs.set("household_memberships/hh_parent-1__aunt-1", {
      membershipId: "hh_parent-1__aunt-1",
      householdId: "hh_parent-1",
      adultUid: "aunt-1",
      status: "active",
    });
    hoisted.docs.set("household_memberships/hh_other__aunt-1", {
      membershipId: "hh_other__aunt-1",
      householdId: "hh_other",
      adultUid: "aunt-1",
      status: "active",
    });
    expect(await listHouseholdMemberships("hh_parent-1")).toHaveLength(2);
    expect(await listMembershipsForAdult("aunt-1")).toHaveLength(2);
    expect(await listMembershipsForAdult("parent-1")).toHaveLength(1);
  });
});

describe("provisional phone-only members (SMS-joined, no Firebase Auth)", () => {
  beforeEach(async () => {
    await createHouseholdWithPrimaryMembership("parent-1", { now: NOW });
  });

  it("records a provisional membership with adultUid null and NO raw phone anywhere", async () => {
    const m = await recordProvisionalPhoneMembership("hh_parent-1", "+14085551234", { now: NOW });
    expect(m).toMatchObject({ status: "provisional", adultUid: null, role: "adult", joinedAt: null });
    const stored = JSON.stringify(hoisted.docs.get(`household_memberships/${m.membershipId}`));
    expect(stored).not.toMatch(/4085551234/); // hash only — recycled-number risk
    expect(m.provisionalPhoneHash).toBe(membershipPhoneHash("+14085551234"));
  });

  it("is idempotent per phone", async () => {
    const a = await recordProvisionalPhoneMembership("hh_parent-1", "+14085551234", { now: NOW });
    const b = await recordProvisionalPhoneMembership("hh_parent-1", "+14085551234", { now: NOW });
    expect(b.membershipId).toBe(a.membershipId);
    const rows = [...hoisted.docs.keys()].filter((p) => p.includes("__prov_"));
    expect(rows).toHaveLength(1);
  });

  it("requires an existing household", async () => {
    await expect(
      recordProvisionalPhoneMembership("hh_missing", "+14085551234", { now: NOW }),
    ).rejects.toMatchObject({ code: "household_not_found" });
  });

  it("promotion creates the real membership and supersedes the provisional row — grants still start at ZERO", async () => {
    await recordProvisionalPhoneMembership("hh_parent-1", "+14085551234", { now: NOW });
    const promoted = await promoteProvisionalMembership("hh_parent-1", "+14085551234", "aunt-1", {
      now: NOW,
      consentVersion: "childcare-consent-v1",
    });
    expect(promoted).toMatchObject({
      adultUid: "aunt-1",
      status: "active",
      source: "promotion",
      consentVersion: "childcare-consent-v1",
    });
    const provisional = hoisted.docs.get(
      `household_memberships/${provisionalMembershipDocId("hh_parent-1", "+14085551234")}`,
    );
    expect(provisional.status).toBe("superseded");
    // No guardian_authorities doc was created by promotion:
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("guardian_authorities/"))).toEqual([]);
  });

  it("promotion retry converges on the existing real membership", async () => {
    await recordProvisionalPhoneMembership("hh_parent-1", "+14085551234", { now: NOW });
    const first = await promoteProvisionalMembership("hh_parent-1", "+14085551234", "aunt-1", { now: NOW });
    // Simulate a retry where the provisional row was left un-superseded:
    hoisted.docs.set(
      `household_memberships/${provisionalMembershipDocId("hh_parent-1", "+14085551234")}`,
      { ...hoisted.docs.get(`household_memberships/${provisionalMembershipDocId("hh_parent-1", "+14085551234")}`), status: "provisional" },
    );
    const retry = await promoteProvisionalMembership("hh_parent-1", "+14085551234", "aunt-1", { now: NOW });
    expect(retry.membershipId).toBe(first.membershipId);
  });
});

describe("revokeMembership", () => {
  beforeEach(async () => {
    await createHouseholdWithPrimaryMembership("parent-1", { now: NOW });
    hoisted.docs.set("household_memberships/hh_parent-1__aunt-1", {
      membershipId: "hh_parent-1__aunt-1",
      householdId: "hh_parent-1",
      adultUid: "aunt-1",
      role: "adult",
      status: "active",
    });
  });

  it("revokes and bumps the household accessVersion in one transaction", async () => {
    const m = await revokeMembership("hh_parent-1", "aunt-1", "parent-1", { now: NOW });
    expect(m.status).toBe("revoked");
    expect(m.revokedByUid).toBe("parent-1");
    expect(hoisted.docs.get("households/hh_parent-1").accessVersion).toBe(2);
  });

  it("is idempotent (no second accessVersion bump)", async () => {
    await revokeMembership("hh_parent-1", "aunt-1", "parent-1", { now: NOW });
    await revokeMembership("hh_parent-1", "aunt-1", "parent-1", { now: NOW });
    expect(hoisted.docs.get("households/hh_parent-1").accessVersion).toBe(2);
  });

  it("the primary membership is immutable here (ownership transfer is an explicit R16 workflow)", async () => {
    await expect(revokeMembership("hh_parent-1", "parent-1", "parent-1", { now: NOW })).rejects.toMatchObject({
      code: "primary_membership_immutable",
    });
  });
});

describe("recomputeHouseholdDerivedSummary (versioned cache, never authorizing)", () => {
  beforeEach(async () => {
    await createHouseholdWithPrimaryMembership("parent-1", { now: NOW });
  });

  it("derives counts + childIds from ACTIVE authorities only and bumps summaryVersion", async () => {
    hoisted.docs.set("household_memberships/hh_parent-1__aunt-1", {
      householdId: "hh_parent-1",
      adultUid: "aunt-1",
      status: "active",
    });
    hoisted.docs.set("household_memberships/hh_parent-1__prov_x", {
      householdId: "hh_parent-1",
      adultUid: null,
      status: "provisional",
    });
    hoisted.docs.set("guardian_authorities/child-1__parent-1", {
      householdId: "hh_parent-1",
      childId: "child-1",
      adultUid: "parent-1",
      state: "active",
    });
    hoisted.docs.set("guardian_authorities/child-2__parent-1", {
      householdId: "hh_parent-1",
      childId: "child-2",
      adultUid: "parent-1",
      state: "revoked", // excluded
    });

    const summary = await recomputeHouseholdDerivedSummary("hh_parent-1", { now: NOW });
    expect(summary).toMatchObject({
      activeAdultCount: 2,
      provisionalMemberCount: 1,
      childIdsWithActiveAuthority: ["child-1"],
      careVerticals: ["child"],
      summaryVersion: 1,
    });

    const again = await recomputeHouseholdDerivedSummary("hh_parent-1", { now: NOW });
    expect(again.summaryVersion).toBe(2);
    expect(hoisted.docs.get("households/hh_parent-1").derivedSummary.summaryVersion).toBe(2);
  });

  it("no active authorities means no child vertical claimed", async () => {
    const summary = await recomputeHouseholdDerivedSummary("hh_parent-1", { now: NOW });
    expect(summary.childIdsWithActiveAuthority).toEqual([]);
    expect(summary.careVerticals).toEqual([]);
  });

  it("household reads return null for unknown households", async () => {
    expect(await getHousehold("hh_missing")).toBeNull();
    await expect(recomputeHouseholdDerivedSummary("hh_missing")).rejects.toMatchObject({
      code: "household_not_found",
    });
  });
});
