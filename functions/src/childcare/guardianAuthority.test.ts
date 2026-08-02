// U2 (childcare marketplace plan 2026-07-22-002): guardian authority is THE
// permission source. These tests cover the plan's U2 scenarios at the model
// layer: household member without authority gets nothing, partial scopes,
// payer-not-guardian / guardian-not-payer, cross-child and cross-household
// denial, revoked/expired authority, concurrent change, provisional phone-only
// member, co-guardian revocation dispute-hold + durable notice effect, and
// admin/support denial (broad isAdmin alone can never pass checkAuthority).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore mock (pattern: admin/__tests__/adminExecutionTools.test.ts,
// extended with equality/in/<= where-chains + orderBy/limit for the outbox drain) ──
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const reads: string[] = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => {
      reads.push(path);
      return {
        exists: docs.has(path),
        id: path.split("/").pop(),
        data: () => docs.get(path),
        ref: makeDocRef(path),
      };
    },
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

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = doc?.[f.field];
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === "array-contains") return Array.isArray(v) && v.includes(f.value);
    if (f.op === "<=") return typeof v === "string" && v <= f.value;
    if (f.op === ">=") return typeof v === "string" && v >= f.value;
    return false;
  };

  const makeQuery = (collPath: string, filters: any[] = [], order?: any, lim?: number): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(collPath, [...filters, { field, op, value }], order, lim),
    orderBy: (field: string, dir?: string) => makeQuery(collPath, filters, { field, dir }, lim),
    limit: (n: number) => makeQuery(collPath, filters, order, n),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${collPath}/`) && p.split("/").length === collPath.split("/").length + 1)
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }));
      rows = rows.filter((r) => filters.every((f) => matches(r._raw, f)));
      if (order) {
        rows.sort((a, b) => {
          const av = a._raw?.[order.field] ?? "";
          const bv = b._raw?.[order.field] ?? "";
          return (av < bv ? -1 : av > bv ? 1 : 0) * (order.dir === "desc" ? -1 : 1);
        });
      }
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (path: string): any => {
    const q = makeQuery(path);
    return {
      doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${docs.size}`}`),
      where: q.where,
      orderBy: q.orderBy,
      limit: q.limit,
      get: q.get,
      add: async (data: any) => {
        const id = `auto-${docs.size}`;
        docs.set(`${path}/${id}`, { ...data });
        return { id };
      },
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
    reads,
    makeCollRef,
    runTransaction,
    reset: () => {
      docs.clear();
      reads.length = 0;
    },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (p: string) => hoisted.makeCollRef(p),
    runTransaction: hoisted.runTransaction,
  });
  firestore.FieldValue = { serverTimestamp: () => "SERVER_TS" };
  firestore.Timestamp = { fromMillis: (ms: number) => ({ __ms: ms }) };
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

vi.mock("../observability/auditLog", () => ({
  logAudit: vi.fn(async () => {}),
}));

const sendViaInteractionAgent = vi.fn();
vi.mock("../agents/caraAgent", () => ({
  sendViaInteractionAgent: (...a: unknown[]) => (sendViaInteractionAgent as any)(...a),
}));

import {
  GUARDIAN_SCOPES,
  authorityDocId,
  checkAuthority,
  grantGuardianAuthority,
  bootstrapPrimaryGuardianAuthority,
  updateAuthorityScopes,
  revokeGuardianAuthority,
  resolveAuthorityDispute,
  processGuardianAuthorityOutbox,
  normalizeScopes,
  GuardianAuthorityError,
} from "./guardianAuthority";
import { logAudit } from "../observability/auditLog";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const HH = "hh_parent-1";

function seedHousehold(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`households/${HH}`, {
    householdId: HH,
    primaryAdultUid: "parent-1",
    status: "active",
    policyVersion: null,
    accessVersion: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

function seedMembership(adultUid: string, overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`household_memberships/${HH}__${adultUid}`, {
    membershipId: `${HH}__${adultUid}`,
    householdId: HH,
    adultUid,
    role: adultUid === "parent-1" ? "primary" : "adult",
    status: "active",
    source: "invite",
    joinedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

function seedAuthority(
  childId: string,
  adultUid: string,
  overrides: Record<string, unknown> = {},
) {
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

function seedChildProfile(
  childId: string,
  authorizedViewerUids: string[] = ["parent-1", "aunt-1"],
) {
  hoisted.docs.set(`child_profiles/${childId}`, {
    childId,
    householdId: HH,
    careVertical: "child",
    state: "active",
    authorizedViewerUids,
    authorityProjection: {
      viewerUids: authorizedViewerUids,
      sourceAuthorityVersions: { "parent-1": 1, "aunt-1": 1 },
      projectionVersion: 2,
      computedAt: "2026-07-01T00:00:00.000Z",
    },
    accessVersion: 5,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
}

function seedChildcareRoom(
  roomId: string,
  childIds: string[] = ["child-1"],
) {
  hoisted.docs.set(`chatRooms/${roomId}`, {
    roomId,
    careVertical: "child",
    householdId: HH,
    childIds,
    participants: ["parent-1", "aunt-1"],
    participantNames: ["Parent", "Aunt"],
    participantAvatars: ["", ""],
    unreadCount: { "parent-1": 0, "aunt-1": 2 },
    state: "active",
    accessVersion: 3,
    revokedReason: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
});

// ── checkAuthority — THE permission primitive ────────────────────────────────

describe("checkAuthority", () => {
  it("household member WITHOUT guardian authority gets nothing (AE4)", async () => {
    seedHousehold();
    seedMembership("aunt-1"); // active member, zero authority records
    for (const scope of GUARDIAN_SCOPES) {
      const d = await checkAuthority("aunt-1", "child-1", scope, { now: NOW });
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("no_authority");
    }
  });

  it("partial scopes: granted scope allows, ungranted scope denies", async () => {
    seedAuthority("child-1", "aunt-1", { scopes: ["view", "message"] });
    expect((await checkAuthority("aunt-1", "child-1", "view", { now: NOW })).allowed).toBe(true);
    const denied = await checkAuthority("aunt-1", "child-1", "schedule", { now: NOW });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("scope_not_granted");
  });

  it("payer-not-guardian: payment-only authority cannot view or schedule", async () => {
    seedAuthority("child-1", "payer-1", { scopes: ["payment"] });
    expect((await checkAuthority("payer-1", "child-1", "payment", { now: NOW })).allowed).toBe(true);
    expect((await checkAuthority("payer-1", "child-1", "view", { now: NOW })).allowed).toBe(false);
    expect((await checkAuthority("payer-1", "child-1", "schedule", { now: NOW })).allowed).toBe(false);
  });

  it("guardian-not-payer: full care scopes without payment cannot pay", async () => {
    seedAuthority("child-1", "guardian-1", {
      scopes: ["view", "schedule", "message", "pickup", "emergency", "cancellation", "management"],
    });
    expect((await checkAuthority("guardian-1", "child-1", "schedule", { now: NOW })).allowed).toBe(true);
    const denied = await checkAuthority("guardian-1", "child-1", "payment", { now: NOW });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("scope_not_granted");
  });

  it("cross-child denial: authority for child-1 grants nothing for child-2", async () => {
    seedAuthority("child-1", "aunt-1");
    const d = await checkAuthority("aunt-1", "child-2", "view", { now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_authority");
  });

  it("cross-household / cross-adult denial: another adult's record never grants", async () => {
    seedAuthority("child-1", "aunt-1");
    const d = await checkAuthority("stranger-1", "child-1", "view", { now: NOW });
    expect(d.allowed).toBe(false);
  });

  it("revoked authority denies", async () => {
    seedAuthority("child-1", "aunt-1", { state: "revoked" });
    const d = await checkAuthority("aunt-1", "child-1", "view", { now: NOW });
    expect(d).toMatchObject({ allowed: false, reason: "revoked" });
  });

  it("expired authority denies (expiresAt in the past)", async () => {
    seedAuthority("child-1", "aunt-1", { expiresAt: "2026-07-20T00:00:00.000Z" });
    const d = await checkAuthority("aunt-1", "child-1", "view", { now: NOW });
    expect(d).toMatchObject({ allowed: false, reason: "expired" });
  });

  it("not-yet-effective authority denies", async () => {
    seedAuthority("child-1", "aunt-1", { effectiveAt: "2026-08-01T00:00:00.000Z" });
    const d = await checkAuthority("aunt-1", "child-1", "view", { now: NOW });
    expect(d).toMatchObject({ allowed: false, reason: "not_yet_effective" });
  });

  it("dispute-hold denies fail-closed", async () => {
    seedAuthority("child-1", "aunt-1", { state: "dispute_hold" });
    const d = await checkAuthority("aunt-1", "child-1", "view", { now: NOW });
    expect(d).toMatchObject({ allowed: false, reason: "dispute_hold" });
  });

  it("unknown state fails closed as malformed", async () => {
    seedAuthority("child-1", "aunt-1", { state: "approved" });
    const d = await checkAuthority("aunt-1", "child-1", "view", { now: NOW });
    expect(d).toMatchObject({ allowed: false, reason: "malformed" });
  });

  it("ADMIN DENIAL (R55/AE18): a broad admin with no authority record is denied and users/{uid} is never consulted", async () => {
    hoisted.docs.set("users/admin-1", { userType: "admin", isAdmin: true });
    const d = await checkAuthority("admin-1", "child-1", "view", { now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_authority");
    // checkAuthority must never read users/* — admin flags are structurally invisible.
    expect(hoisted.reads.filter((p) => p.startsWith("users/"))).toEqual([]);
  });

  it("malformed input denies", async () => {
    expect((await checkAuthority("", "child-1", "view")).reason).toBe("malformed");
    expect((await checkAuthority("a", "child-1", "not-a-scope" as any)).reason).toBe("malformed");
  });
});

// ── grants ───────────────────────────────────────────────────────────────────

describe("grantGuardianAuthority", () => {
  beforeEach(() => {
    seedHousehold();
    seedMembership("parent-1", { role: "primary", source: "household_create" });
    seedMembership("aunt-1");
    seedAuthority("child-1", "parent-1"); // parent holds management
  });

  it("management holder grants partial scopes to an active member", async () => {
    const doc = await grantGuardianAuthority(
      {
        granterUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        scopes: ["view", "schedule"],
      },
      { now: NOW },
    );
    expect(doc.scopes).toEqual(["schedule", "view"]);
    expect(doc.state).toBe("active");
    expect(doc.accessVersion).toBe(1);
    expect((await checkAuthority("aunt-1", "child-1", "view", { now: NOW })).allowed).toBe(true);
    expect((await checkAuthority("aunt-1", "child-1", "pickup", { now: NOW })).allowed).toBe(false);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "guardian_authority_granted" }),
    );
  });

  it("PROVISIONAL phone-only member can never be granted (zero grantable scopes)", async () => {
    hoisted.docs.set(`household_memberships/${HH}__prov_abc123`, {
      membershipId: `${HH}__prov_abc123`,
      householdId: HH,
      adultUid: null,
      role: "adult",
      status: "provisional",
      provisionalPhoneHash: "abc",
      source: "sms_join",
      joinedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    // Targeting the provisional row's key resolves to the provisional record
    // itself — rejected as not-authenticated (zero grantable scopes).
    await expect(
      grantGuardianAuthority(
        {
          granterUid: "parent-1",
          householdId: HH,
          childId: "child-1",
          targetAdultUid: "prov_abc123",
          scopes: ["view"],
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "target_not_authenticated" });

    // Even a directly seeded provisional row keyed like a uid is rejected.
    seedMembership("phoney-1", { status: "provisional", adultUid: null });
    await expect(
      grantGuardianAuthority(
        {
          granterUid: "parent-1",
          householdId: HH,
          childId: "child-1",
          targetAdultUid: "phoney-1",
          scopes: ["view"],
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "target_not_authenticated" });
  });

  it("granter without management is denied", async () => {
    seedAuthority("child-1", "aunt-1", { scopes: ["view"] });
    seedMembership("uncle-1");
    await expect(
      grantGuardianAuthority(
        {
          granterUid: "aunt-1",
          householdId: HH,
          childId: "child-1",
          targetAdultUid: "uncle-1",
          scopes: ["view"],
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("idempotency key: a retried grant converges (no double accessVersion bump)", async () => {
    const first = await grantGuardianAuthority(
      {
        granterUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        scopes: ["view"],
        idempotencyKey: "op-1",
      },
      { now: NOW },
    );
    const retry = await grantGuardianAuthority(
      {
        granterUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        scopes: ["view"],
        idempotencyKey: "op-1",
      },
      { now: NOW },
    );
    expect(retry.accessVersion).toBe(first.accessVersion);
  });

  it("re-granting widens by union and bumps accessVersion", async () => {
    seedAuthority("child-1", "aunt-1", { scopes: ["view"], accessVersion: 3 });
    const doc = await grantGuardianAuthority(
      {
        granterUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        scopes: ["schedule"],
      },
      { now: NOW },
    );
    expect(doc.scopes).toEqual(["schedule", "view"]);
    expect(doc.accessVersion).toBe(4);
  });
});

describe("bootstrapPrimaryGuardianAuthority", () => {
  beforeEach(() => {
    seedHousehold();
    seedMembership("parent-1", { role: "primary", source: "household_create" });
    seedMembership("aunt-1");
  });

  it("primary adult bootstraps full scopes for a new child", async () => {
    const doc = await bootstrapPrimaryGuardianAuthority(
      { householdId: HH, childId: "child-1", adultUid: "parent-1" },
      { now: NOW },
    );
    expect(doc.scopes).toEqual([...GUARDIAN_SCOPES]);
    expect(doc.source).toBe("bootstrap_primary_guardian");
  });

  it("refuses once ANY authority exists for the child", async () => {
    seedAuthority("child-1", "parent-1");
    await expect(
      bootstrapPrimaryGuardianAuthority(
        { householdId: HH, childId: "child-1", adultUid: "aunt-1" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "authority_already_bootstrapped" });
  });

  it("non-primary adult cannot bootstrap", async () => {
    await expect(
      bootstrapPrimaryGuardianAuthority(
        { householdId: HH, childId: "child-1", adultUid: "aunt-1" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });
});

// ── updates + R18 dispute-hold ───────────────────────────────────────────────

describe("updateAuthorityScopes", () => {
  beforeEach(() => {
    seedHousehold();
    seedMembership("parent-1", { role: "primary", source: "household_create" });
    seedMembership("aunt-1");
    seedAuthority("child-1", "parent-1"); // management
    seedAuthority("child-1", "aunt-1", { scopes: ["view", "schedule", "pickup"] });
    seedChildProfile("child-1");
  });

  it("widening another adult applies directly (no hold)", async () => {
    const r = await updateAuthorityScopes(
      {
        actorUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        newScopes: ["view", "schedule", "pickup", "message"],
      },
      { now: NOW },
    );
    expect(r.disputeHold).toBe(false);
    expect(r.authority.state).toBe("active");
    expect(r.authority.accessVersion).toBe(2);
  });

  it("REDUCING another adult's active scopes enters R18 dispute-hold with durable notice + invalidation + operator review", async () => {
    const r = await updateAuthorityScopes(
      {
        actorUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        newScopes: ["view"],
        reason: "changed arrangement",
      },
      { now: NOW },
    );
    expect(r.disputeHold).toBe(true);
    expect(r.authority.state).toBe("dispute_hold");
    expect(r.authority.disputeHold).toMatchObject({
      pendingAction: "reduce_scopes",
      pendingScopes: ["view"],
      openedByUid: "parent-1",
    });

    // Access is suspended fail-closed while the hold is open — but never silently:
    const denied = await checkAuthority("aunt-1", "child-1", "view", { now: NOW });
    expect(denied).toMatchObject({ allowed: false, reason: "dispute_hold" });

    // Durable outbox effects created in the SAME transaction (KTD23):
    const outbox = [...hoisted.docs.entries()].filter(([p]) => p.startsWith("guardianAuthorityOutbox/"));
    const kinds = outbox.map(([, d]) => d.kind).sort();
    expect(kinds).toEqual(["co_guardian_notice", "derived_access_invalidation"]);
    expect(outbox.every(([, d]) => d.state === "pending")).toBe(true);
    expect(outbox.every(([, d]) => d.affectedAdultUid === "aunt-1")).toBe(true);

    // Operator review path:
    const alerts = [...hoisted.docs.entries()].filter(([p]) => p.startsWith("admin_alerts/"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0][1]).toMatchObject({ type: "guardian_authority_dispute_hold", resolved: false });

    // Household accessVersion bumped (derived projections invalidate):
    expect(hoisted.docs.get(`households/${HH}`).accessVersion).toBe(2);
    // The browser Rules cache is denied in the SAME transaction as the hold.
    const profile = hoisted.docs.get("child_profiles/child-1");
    expect(profile.authorizedViewerUids).toEqual(["parent-1"]);
    expect(profile.authorityProjection.viewerUids).toEqual(["parent-1"]);
    expect(profile.authorityProjection.sourceAuthorityVersions["aunt-1"]).toBe(2);
    expect(profile.accessVersion).toBe(6);
  });

  it("self-reduction applies directly (no hold) but still bumps versions", async () => {
    const r = await updateAuthorityScopes(
      {
        actorUid: "aunt-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        newScopes: ["view"],
      },
      { now: NOW },
    );
    expect(r.disputeHold).toBe(false);
    expect(r.authority.scopes).toEqual(["view"]);
    expect(hoisted.docs.get(`households/${HH}`).accessVersion).toBe(2);
  });

  it("self-reduction that removes view denies the Rules cache atomically", async () => {
    await updateAuthorityScopes(
      {
        actorUid: "aunt-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        newScopes: ["pickup"],
      },
      { now: NOW },
    );

    expect(hoisted.docs.get("child_profiles/child-1").authorizedViewerUids).toEqual(["parent-1"]);
  });

  it("CONCURRENT CHANGE: expectedAccessVersion mismatch aborts", async () => {
    await expect(
      updateAuthorityScopes(
        {
          actorUid: "parent-1",
          householdId: HH,
          childId: "child-1",
          targetAdultUid: "aunt-1",
          newScopes: ["view"],
          expectedAccessVersion: 99,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "concurrent_change" });
  });

  it("an authority already on hold cannot be changed", async () => {
    seedAuthority("child-1", "aunt-1", { state: "dispute_hold", scopes: ["view"] });
    await expect(
      updateAuthorityScopes(
        {
          actorUid: "parent-1",
          householdId: HH,
          childId: "child-1",
          targetAdultUid: "aunt-1",
          newScopes: ["view", "schedule"],
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "authority_on_hold" });
  });
});

describe("revokeGuardianAuthority", () => {
  beforeEach(() => {
    seedHousehold();
    seedMembership("parent-1", { role: "primary", source: "household_create" });
    seedMembership("aunt-1");
    seedAuthority("child-1", "parent-1");
    seedAuthority("child-1", "aunt-1", { scopes: ["view", "pickup"] });
    seedChildProfile("child-1");
  });

  it("CO-GUARDIAN revocation enters dispute-hold with notice + invalidation + review (R18 — no silent lockout)", async () => {
    seedChildcareRoom("room-child-1");
    seedChildcareRoom("room-other-child", ["child-2"]);
    const r = await revokeGuardianAuthority(
      {
        actorUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        reason: "no longer authorized",
      },
      { now: NOW },
    );
    expect(r.disputeHold).toBe(true);
    expect(r.authority.state).toBe("dispute_hold");
    expect(r.authority.disputeHold?.pendingAction).toBe("revoke");

    const kinds = [...hoisted.docs.entries()]
      .filter(([p]) => p.startsWith("guardianAuthorityOutbox/"))
      .map(([, d]) => d.kind)
      .sort();
    expect(kinds).toEqual(["co_guardian_notice", "derived_access_invalidation"]);
    expect(
      [...hoisted.docs.entries()].some(
        ([p, d]) => p.startsWith("admin_alerts/") && d.type === "guardian_authority_dispute_hold",
      ),
    ).toBe(true);
    expect(hoisted.docs.get("child_profiles/child-1").authorizedViewerUids).toEqual(["parent-1"]);
    expect(hoisted.docs.get("chatRooms/room-child-1")).toMatchObject({
      participants: ["parent-1"],
      state: "revoked",
      accessVersion: 4,
    });
    expect(hoisted.docs.get("chatRooms/room-other-child").participants).toEqual([
      "parent-1",
      "aunt-1",
    ]);
  });

  it("self-revocation applies immediately (revoked) with invalidation fan-out only", async () => {
    const r = await revokeGuardianAuthority(
      { actorUid: "aunt-1", householdId: HH, childId: "child-1", targetAdultUid: "aunt-1" },
      { now: NOW },
    );
    expect(r.disputeHold).toBe(false);
    expect(r.authority.state).toBe("revoked");
    const kinds = [...hoisted.docs.entries()]
      .filter(([p]) => p.startsWith("guardianAuthorityOutbox/"))
      .map(([, d]) => d.kind);
    expect(kinds).toEqual(["derived_access_invalidation"]);
    expect((await checkAuthority("aunt-1", "child-1", "view", { now: NOW })).reason).toBe("revoked");
    expect(hoisted.docs.get("child_profiles/child-1").authorizedViewerUids).toEqual(["parent-1"]);
  });

  it("revoking an already-revoked authority repairs a stale Rules cache idempotently", async () => {
    seedAuthority("child-1", "aunt-1", { state: "revoked" });
    const r = await revokeGuardianAuthority(
      { actorUid: "parent-1", householdId: HH, childId: "child-1", targetAdultUid: "aunt-1" },
      { now: NOW },
    );
    expect(r.authority.state).toBe("revoked");
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("guardianAuthorityOutbox/"))).toEqual([]);
    expect(hoisted.docs.get("child_profiles/child-1").authorizedViewerUids).toEqual(["parent-1"]);
  });

  it("actor without management cannot revoke a co-guardian", async () => {
    seedMembership("uncle-1");
    seedAuthority("child-1", "uncle-1", { scopes: ["view"] });
    await expect(
      revokeGuardianAuthority(
        { actorUid: "uncle-1", householdId: HH, childId: "child-1", targetAdultUid: "aunt-1" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("concurrent change protection applies to revocation too", async () => {
    await expect(
      revokeGuardianAuthority(
        {
          actorUid: "parent-1",
          householdId: HH,
          childId: "child-1",
          targetAdultUid: "aunt-1",
          expectedAccessVersion: 42,
        },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "concurrent_change" });
  });
});

describe("resolveAuthorityDispute (operator review path)", () => {
  beforeEach(() => {
    seedHousehold();
    seedMembership("parent-1", { role: "primary", source: "household_create" });
    seedMembership("aunt-1");
    seedAuthority("child-1", "parent-1");
    seedAuthority("child-1", "aunt-1", { scopes: ["view", "pickup"] });
  });

  it("applying a held revocation finalizes revoked", async () => {
    await revokeGuardianAuthority(
      { actorUid: "parent-1", householdId: HH, childId: "child-1", targetAdultUid: "aunt-1" },
      { now: NOW },
    );
    const doc = await resolveAuthorityDispute(
      { operatorUid: "op-1", childId: "child-1", targetAdultUid: "aunt-1", resolution: "applied" },
      { now: NOW },
    );
    expect(doc.state).toBe("revoked");
    expect(doc.disputeHold?.resolution).toBe("applied");
  });

  it("restoring a held reduction returns the ORIGINAL scopes to active", async () => {
    await updateAuthorityScopes(
      {
        actorUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        newScopes: ["view"],
      },
      { now: NOW },
    );
    const doc = await resolveAuthorityDispute(
      { operatorUid: "op-1", childId: "child-1", targetAdultUid: "aunt-1", resolution: "restored" },
      { now: NOW },
    );
    expect(doc.state).toBe("active");
    expect([...doc.scopes].sort()).toEqual(["pickup", "view"]);
    expect((await checkAuthority("aunt-1", "child-1", "pickup", { now: NOW })).allowed).toBe(true);
  });

  it("applying a held reduction activates the reduced scope set", async () => {
    await updateAuthorityScopes(
      {
        actorUid: "parent-1",
        householdId: HH,
        childId: "child-1",
        targetAdultUid: "aunt-1",
        newScopes: ["view"],
      },
      { now: NOW },
    );
    const doc = await resolveAuthorityDispute(
      { operatorUid: "op-1", childId: "child-1", targetAdultUid: "aunt-1", resolution: "applied" },
      { now: NOW },
    );
    expect(doc.state).toBe("active");
    expect(doc.scopes).toEqual(["view"]);
  });

  it("resolving a non-held authority fails", async () => {
    await expect(
      resolveAuthorityDispute(
        { operatorUid: "op-1", childId: "child-1", targetAdultUid: "aunt-1", resolution: "applied" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "not_in_dispute" });
  });
});

// ── Outbox dispatcher (claim/lease/retry/terminal) ───────────────────────────

describe("guardian authority outbox dispatcher", () => {
  function seedOutbox(id: string, overrides: Record<string, unknown> = {}) {
    hoisted.docs.set(`guardianAuthorityOutbox/${id}`, {
      outboxId: id,
      kind: "co_guardian_notice",
      authorityId: "child-1__aunt-1",
      householdId: HH,
      childId: "child-1",
      affectedAdultUid: "aunt-1",
      actionByUid: "parent-1",
      action: "revoke",
      authorityAccessVersion: 2,
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: "2026-07-22T11:00:00.000Z",
      createdAt: "2026-07-22T11:00:00.000Z",
      updatedAt: "2026-07-22T11:00:00.000Z",
      ...overrides,
    });
  }

  it("delivers the co-guardian notice with a provider receipt and terminates completed", async () => {
    hoisted.docs.set("users/aunt-1", { phone: "+14085551234" });
    seedOutbox("n1");
    sendViaInteractionAgent.mockImplementation(async (_phone: string, opts: any) => {
      opts.onTransportReceipt?.("msg-123");
      return true;
    });

    const result = await processGuardianAuthorityOutbox();
    expect(result).toEqual({ attempted: 1, completed: 1 });
    const doc = hoisted.docs.get("guardianAuthorityOutbox/n1");
    expect(doc.state).toBe("completed");
    expect(doc.providerMessageId).toBe("msg-123");
    // Adult-generic notice — never a child name (R57).
    const content = sendViaInteractionAgent.mock.calls[0][1].content as string;
    expect(content).not.toMatch(/child-1/);
    expect(content).toMatch(/DISPUTE/);
  });

  it("missing recipient phone retries with backoff", async () => {
    seedOutbox("n2");
    const result = await processGuardianAuthorityOutbox();
    expect(result.completed).toBe(0);
    const doc = hoisted.docs.get("guardianAuthorityOutbox/n2");
    expect(doc.state).toBe("retry");
    expect(doc.lastErrorCode).toBe("affected_adult_phone_not_found");
    expect(doc.nextAttemptAt > "2026-07-22T11:00:00.000Z").toBe(true);
  });

  it("exhausted attempts become terminal requires_admin_review with an operator alert", async () => {
    seedOutbox("n3", { attemptCount: 4 }); // claim makes it 5 == MAX
    await processGuardianAuthorityOutbox();
    const doc = hoisted.docs.get("guardianAuthorityOutbox/n3");
    expect(doc.state).toBe("requires_admin_review");
    expect(doc.nextAttemptAt).toBeNull();
    expect(hoisted.docs.get("admin_alerts/guardian_outbox_stuck_n3")).toMatchObject({
      type: "guardian_authority_outbox_stuck",
    });
  });

  it("derived-access invalidation revokes the household's pending invite tokens", async () => {
    seedOutbox("i1", { kind: "derived_access_invalidation" });
    hoisted.docs.set("childcare_invite_tokens/inv_a", {
      tokenId: "inv_a",
      householdId: HH,
      status: "pending",
    });
    hoisted.docs.set("childcare_invite_tokens/inv_b", {
      tokenId: "inv_b",
      householdId: "hh_other",
      status: "pending",
    });
    const result = await processGuardianAuthorityOutbox();
    expect(result.completed).toBe(1);
    expect(hoisted.docs.get("childcare_invite_tokens/inv_a").status).toBe("revoked");
    expect(hoisted.docs.get("childcare_invite_tokens/inv_b").status).toBe("pending"); // other household untouched
    expect(hoisted.docs.get("guardianAuthorityOutbox/i1").state).toBe("completed");
  });

  it("a leased (processing) record is not double-claimed", async () => {
    seedOutbox("n4", { state: "processing", leaseExpiresAt: "2026-09-01T00:00:00.000Z" });
    const result = await processGuardianAuthorityOutbox();
    expect(result).toEqual({ attempted: 0, completed: 0 });
  });

  // ── Childcare U9 (R42/AE20): conversation revocation rides the same effect ──

  it("U9: derived-access invalidation removes an adult WITHOUT live `message` scope from the household's childcare rooms", async () => {
    seedOutbox("i2", { kind: "derived_access_invalidation" });
    // No guardian_authorities doc for aunt-1 ⇒ checkAuthority('message') denies.
    hoisted.docs.set("chatRooms/cchat_room1", {
      careVertical: "child",
      roomId: "cchat_room1",
      contextType: "booking",
      contextId: "cbook_1",
      householdId: HH,
      participants: ["parent-1", "aunt-1"],
      participantNames: ["Parent", "Aunt"],
      participantAvatars: ["", ""],
      state: "active",
      accessVersion: 1,
      unreadCount: { "parent-1": 0, "aunt-1": 0 },
    });
    // A DIFFERENT household's room must be untouched.
    hoisted.docs.set("chatRooms/cchat_other", {
      careVertical: "child",
      roomId: "cchat_other",
      householdId: "hh_other",
      participants: ["someone", "aunt-1"],
      participantNames: ["S", "Aunt"],
      participantAvatars: ["", ""],
      state: "active",
      accessVersion: 1,
      unreadCount: {},
    });

    const result = await processGuardianAuthorityOutbox();
    expect(result.completed).toBe(1);
    const room = hoisted.docs.get("chatRooms/cchat_room1");
    expect(room.participants).not.toContain("aunt-1");
    expect(room.accessVersion).toBe(2); // durable access-version bump
    expect(hoisted.docs.get("chatRooms/cchat_other").participants).toContain("aunt-1");
    expect(hoisted.docs.get("guardianAuthorityOutbox/i2")).toMatchObject({
      state: "completed",
      conversationsRevokedCount: 1,
    });
  });

  it("U9: an adult who KEEPS `message` scope after a reduction keeps their rooms", async () => {
    seedOutbox("i3", { kind: "derived_access_invalidation", action: "reduce_scopes" });
    hoisted.docs.set("guardian_authorities/child-1__aunt-1", {
      authorityId: "child-1__aunt-1",
      householdId: HH,
      childId: "child-1",
      adultUid: "aunt-1",
      careVertical: "child",
      scopes: ["view", "message"],
      state: "active",
      effectiveAt: "2026-07-01T00:00:00.000Z",
      expiresAt: null,
      accessVersion: 3,
    });
    hoisted.docs.set("chatRooms/cchat_keep", {
      careVertical: "child",
      roomId: "cchat_keep",
      householdId: HH,
      participants: ["parent-1", "aunt-1"],
      participantNames: ["Parent", "Aunt"],
      participantAvatars: ["", ""],
      state: "active",
      accessVersion: 1,
      unreadCount: {},
    });

    const result = await processGuardianAuthorityOutbox();
    expect(result.completed).toBe(1);
    expect(hoisted.docs.get("chatRooms/cchat_keep").participants).toContain("aunt-1");
    expect(hoisted.docs.get("guardianAuthorityOutbox/i3")).toMatchObject({
      state: "completed",
      conversationsRevokedCount: 0,
    });
  });
});

// ── misc ─────────────────────────────────────────────────────────────────────

describe("normalizeScopes / ids", () => {
  it("rejects unknown scopes and empty lists", () => {
    expect(normalizeScopes([])).toBeNull();
    expect(normalizeScopes(["view", "root"])).toBeNull();
    expect(normalizeScopes("view")).toBeNull();
    expect(normalizeScopes(["view", "view", "payment"])).toEqual(["payment", "view"]);
  });

  it("authorityDocId is deterministic and validated", () => {
    expect(authorityDocId("c1", "a1")).toBe("c1__a1");
    expect(() => authorityDocId("", "a1")).toThrow();
  });

  it("GuardianAuthorityError carries a typed code", () => {
    const e = new GuardianAuthorityError("not_authorized");
    expect(e.code).toBe("not_authorized");
  });
});
