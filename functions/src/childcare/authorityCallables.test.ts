// U2 (childcare marketplace plan 2026-07-22-002): v1 household/authority
// callables. Scenarios: primary adult, invited adult, wrong contact,
// replayed/expired invite (all enumeration-safe and indistinguishable),
// household member without guardian authority gets nothing, App Check
// monitor vs enforce, recent-auth stale rejection, rate limiting, idempotency,
// childcare-flag gating (R61), cross-household denial, and concurrent change.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── In-memory Firestore mock (equality/in/<= filters + transactions) ─────────
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

import {
  createHousehold as _createHousehold,
  inviteHouseholdAdult as _inviteHouseholdAdult,
  acceptHouseholdInvite as _acceptHouseholdInvite,
  grantGuardianAuthority as _grantGuardianAuthority,
  updateAuthorityScopes as _updateAuthorityScopes,
  revokeGuardianAuthority as _revokeGuardianAuthority,
  getMyHouseholdState as _getMyHouseholdState,
  requireRecentAuth,
  decodeInviteToken,
  inviteTokenDocId,
} from "./authorityCallables";
import { checkAuthority, GUARDIAN_SCOPES } from "./guardianAuthority";
import { bustChildcareFlagsCache } from "../config/featureFlags";

// The firebase-functions/v1 stub makes onCall(fn) === fn.
/* eslint-disable @typescript-eslint/no-explicit-any */
const createHousehold = _createHousehold as any;
const inviteHouseholdAdult = _inviteHouseholdAdult as any;
const acceptHouseholdInvite = _acceptHouseholdInvite as any;
const grantGuardianAuthority = _grantGuardianAuthority as any;
const updateAuthorityScopes = _updateAuthorityScopes as any;
const revokeGuardianAuthority = _revokeGuardianAuthority as any;
const getMyHouseholdState = _getMyHouseholdState as any;

const HH = "hh_parent-1";
const freshAuthTime = () => Math.floor(Date.now() / 1000) - 5;
const staleAuthTime = () => Math.floor(Date.now() / 1000) - 3600;

function ctx(uid: string, opts: { authTime?: number; phone?: string; app?: boolean } = {}): any {
  return {
    auth: {
      uid,
      token: {
        auth_time: opts.authTime ?? freshAuthTime(),
        ...(opts.phone ? { phone_number: opts.phone } : {}),
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

const originalAppCheckMode = process.env.CHILDCARE_APPCHECK_MODE;

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {}); // monitor-mode noise
  delete process.env.CHILDCARE_APPCHECK_MODE;
  enableChildcareFlags();
});

afterEach(() => {
  if (originalAppCheckMode === undefined) delete process.env.CHILDCARE_APPCHECK_MODE;
  else process.env.CHILDCARE_APPCHECK_MODE = originalAppCheckMode;
  bustChildcareFlagsCache();
});

// ── gates ────────────────────────────────────────────────────────────────────

describe("shared callable gates", () => {
  it("unauthenticated callers are rejected", async () => {
    await expect(createHousehold({}, {} as any)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(getMyHouseholdState({}, {} as any)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("childcare flags OFF (absent doc) keeps every callable dark — fail-closed R61", async () => {
    hoisted.docs.delete("childcare_flags/global");
    bustChildcareFlagsCache();
    await expect(createHousehold({}, ctx("parent-1"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
    await expect(getMyHouseholdState({}, ctx("parent-1"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("writesEnabled=false blocks mutations while enabled=true still allows reads", async () => {
    enableChildcareFlags({ CHILDCARE_WRITES_ENABLED: false });
    await expect(createHousehold({}, ctx("parent-1"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
    const state = await getMyHouseholdState({}, ctx("parent-1"));
    expect(state.success).toBe(true);
  });

  it("emergencyOff force-disables everything without a redeploy", async () => {
    enableChildcareFlags({ emergencyOff: true });
    await expect(getMyHouseholdState({}, ctx("parent-1"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("APP CHECK enforce mode fails closed without a verified app; monitor allows", async () => {
    process.env.CHILDCARE_APPCHECK_MODE = "enforce";
    await expect(createHousehold({}, ctx("parent-1", { app: false }))).rejects.toMatchObject({
      code: "failed-precondition",
    });
    // Same call succeeds with a verified app in enforce mode:
    const ok = await createHousehold({}, ctx("parent-1"));
    expect(ok.success).toBe(true);

    // Monitor mode (default): missing app is allowed.
    delete process.env.CHILDCARE_APPCHECK_MODE;
    hoisted.reset();
    enableChildcareFlags();
    const monitored = await createHousehold({}, ctx("parent-1", { app: false }));
    expect(monitored.success).toBe(true);
  });

  it("RATE LIMIT: an exhausted window rejects resource-exhausted (fail-closed util)", async () => {
    hoisted.docs.set("rate_limits/rl:childcare:mut:createHousehold:parent-1", {
      windowStart: Date.now(),
      count: 10,
      updatedAt: Date.now(),
    });
    await expect(createHousehold({}, ctx("parent-1"))).rejects.toMatchObject({
      code: "resource-exhausted",
    });
  });

  it("RECENT AUTH (R18): a stale auth_time claim rejects high-risk ops; fresh passes the gate", async () => {
    seedHouseholdViaCallable: {
      await createHousehold({}, ctx("parent-1"));
    }
    seedAuthority("child-1", "parent-1");
    seedMembership("aunt-1");

    await expect(
      grantGuardianAuthority(
        { householdId: HH, childId: "child-1", targetAdultUid: "aunt-1", scopes: ["view"] },
        ctx("parent-1", { authTime: staleAuthTime() }),
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });

    const ok = await grantGuardianAuthority(
      { householdId: HH, childId: "child-1", targetAdultUid: "aunt-1", scopes: ["view"] },
      ctx("parent-1"),
    );
    expect(ok.success).toBe(true);
  });

  it("requireRecentAuth reads ONLY the token auth_time claim (missing claim fails closed)", () => {
    expect(() => requireRecentAuth({ auth: { uid: "u", token: {} } } as any)).toThrowError(
      expect.objectContaining({ code: "failed-precondition" }),
    );
    expect(() =>
      requireRecentAuth({ auth: { uid: "u", token: { auth_time: freshAuthTime() } } } as any),
    ).not.toThrow();
    // A client-supplied "recentAuthAt" style field is structurally ignored —
    // there is no code path that reads anything but token.auth_time.
    expect(() =>
      requireRecentAuth({
        auth: { uid: "u", token: { auth_time: staleAuthTime() } },
        recentAuthAt: new Date().toISOString(),
      } as any),
    ).toThrowError(expect.objectContaining({ code: "failed-precondition" }));
  });
});

// ── primary adult + household creation ───────────────────────────────────────

describe("createHousehold (primary adult)", () => {
  it("creates the canonical household + primary membership and is idempotent", async () => {
    const first = await createHousehold({}, ctx("parent-1"));
    expect(first).toMatchObject({ success: true, householdId: HH, created: true });
    const again = await createHousehold({}, ctx("parent-1"));
    expect(again).toMatchObject({ success: true, householdId: HH, created: false });
    expect(hoisted.docs.get(`household_memberships/${HH}__parent-1`)).toMatchObject({
      role: "primary",
      status: "active",
    });
  });
});

// ── invite → accept flow ─────────────────────────────────────────────────────

describe("invite + accept flow", () => {
  const AUNT_PHONE = "+14085551234";

  async function invite(proposedScopes: unknown = [{ childId: "child-1", scopes: ["view", "schedule"] }]) {
    await createHousehold({}, ctx("parent-1"));
    return inviteHouseholdAdult(
      {
        householdId: HH,
        intendedContact: { channel: "sms", value: AUNT_PHONE },
        proposedScopes,
        idempotencyKey: "invite-1",
      },
      ctx("parent-1"),
    );
  }

  it("INVITED ADULT: token bound to household+contact+expiry+nonce; acceptance creates membership + consented authorities", async () => {
    const res = await invite();
    expect(res.success).toBe(true);
    expect(typeof res.inviteToken).toBe("string");
    const decoded = decodeInviteToken(res.inviteToken);
    expect(decoded?.tokenId).toBe(inviteTokenDocId(HH, "invite-1"));
    // Stored doc holds only the nonce HASH, never the raw nonce:
    const stored = hoisted.docs.get(`childcare_invite_tokens/${decoded!.tokenId}`);
    expect(stored.nonceHash).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(decoded!.nonce);

    const accepted = await acceptHouseholdInvite(
      { inviteToken: res.inviteToken, consentVersion: "childcare-consent-v1" },
      ctx("aunt-1", { phone: AUNT_PHONE }),
    );
    expect(accepted).toMatchObject({ success: true, householdId: HH });

    expect(hoisted.docs.get(`household_memberships/${HH}__aunt-1`)).toMatchObject({
      status: "active",
      source: "invite",
      consentVersion: "childcare-consent-v1",
    });
    // Proposed scopes became explicit authority — partial, not full:
    expect((await checkAuthority("aunt-1", "child-1", "view")).allowed).toBe(true);
    expect((await checkAuthority("aunt-1", "child-1", "pickup")).allowed).toBe(false);
  });

  it("WRONG CONTACT, REPLAY, and EXPIRY all fail with ONE indistinguishable error", async () => {
    const res = await invite();
    const messages: string[] = [];

    // Wrong contact — verified token phone differs from the intended contact.
    await acceptHouseholdInvite(
      { inviteToken: res.inviteToken, consentVersion: "v1" },
      ctx("stranger-1", { phone: "+19995550000" }),
    ).catch((e: any) => messages.push(`${e.code}|${e.message}`));

    // Legitimate accept…
    await acceptHouseholdInvite(
      { inviteToken: res.inviteToken, consentVersion: "v1" },
      ctx("aunt-1", { phone: AUNT_PHONE }),
    );
    // …then REPLAY (single-use nonce consumed).
    await acceptHouseholdInvite(
      { inviteToken: res.inviteToken, consentVersion: "v1" },
      ctx("aunt-1", { phone: AUNT_PHONE }),
    ).catch((e: any) => messages.push(`${e.code}|${e.message}`));

    // Expired token (fresh invite, clock past expiresAt).
    hoisted.reset();
    enableChildcareFlags();
    const res2 = await invite();
    const tokenId = decodeInviteToken(res2.inviteToken)!.tokenId;
    hoisted.docs.set(`childcare_invite_tokens/${tokenId}`, {
      ...hoisted.docs.get(`childcare_invite_tokens/${tokenId}`),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await acceptHouseholdInvite(
      { inviteToken: res2.inviteToken, consentVersion: "v1" },
      ctx("aunt-1", { phone: AUNT_PHONE }),
    ).catch((e: any) => messages.push(`${e.code}|${e.message}`));

    // Garbage token — same shape again.
    await acceptHouseholdInvite(
      { inviteToken: "inv_deadbeef.deadbeef", consentVersion: "v1" },
      ctx("aunt-1", { phone: AUNT_PHONE }),
    ).catch((e: any) => messages.push(`${e.code}|${e.message}`));

    expect(messages).toHaveLength(4);
    expect(new Set(messages).size).toBe(1); // enumeration-safe: identical code+message
    expect(messages[0].startsWith("permission-denied|")).toBe(true);
  });

  it("HOUSEHOLD MEMBER WITHOUT GUARDIAN AUTHORITY GETS NOTHING (AE4): scope-free invite grants zero scopes", async () => {
    const res = await invite([]); // membership-only invite
    await acceptHouseholdInvite(
      { inviteToken: res.inviteToken, consentVersion: "v1" },
      ctx("aunt-1", { phone: AUNT_PHONE }),
    );
    expect(hoisted.docs.get(`household_memberships/${HH}__aunt-1`).status).toBe("active");
    for (const scope of GUARDIAN_SCOPES) {
      expect((await checkAuthority("aunt-1", "child-1", scope)).allowed).toBe(false);
    }
    const state = await getMyHouseholdState({}, ctx("aunt-1"));
    expect(state.households).toHaveLength(1);
    expect(state.authorities).toEqual([]);
  });

  it("acceptance never widens an EXISTING authority record", async () => {
    seedAuthority("child-1", "aunt-1", { scopes: ["view"], state: "revoked" });
    const res = await invite([{ childId: "child-1", scopes: [...GUARDIAN_SCOPES] }]);
    await acceptHouseholdInvite(
      { inviteToken: res.inviteToken, consentVersion: "v1" },
      ctx("aunt-1", { phone: AUNT_PHONE }),
    );
    // The pre-existing (revoked) record is untouched — no silent re-grant.
    expect(hoisted.docs.get("guardian_authorities/child-1__aunt-1")).toMatchObject({
      state: "revoked",
      scopes: ["view"],
    });
  });

  it("invite is idempotent per idempotencyKey and the nonce is returned only once", async () => {
    const first = await invite();
    const retry = await inviteHouseholdAdult(
      {
        householdId: HH,
        intendedContact: { channel: "sms", value: AUNT_PHONE },
        proposedScopes: [{ childId: "child-1", scopes: ["view", "schedule"] }],
        idempotencyKey: "invite-1",
      },
      ctx("parent-1"),
    );
    expect(retry.alreadyExisted).toBe(true);
    expect(retry.inviteToken).toBeUndefined();
    expect(first.tokenId).toBe(retry.tokenId);
  });

  it("a non-member cannot invite; a non-primary member without management cannot invite", async () => {
    await createHousehold({}, ctx("parent-1"));
    seedMembership("aunt-1");
    const attempt = (uid: string) =>
      inviteHouseholdAdult(
        {
          householdId: HH,
          intendedContact: { channel: "sms", value: "+14085550000" },
          proposedScopes: [],
          idempotencyKey: "k",
        },
        ctx(uid),
      );
    await expect(attempt("stranger-1")).rejects.toMatchObject({ code: "permission-denied" });
    await expect(attempt("aunt-1")).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("invalid contact shapes are rejected as invalid-argument", async () => {
    await createHousehold({}, ctx("parent-1"));
    await expect(
      inviteHouseholdAdult(
        {
          householdId: HH,
          intendedContact: { channel: "sms", value: "408-555-1234" },
          idempotencyKey: "k",
        },
        ctx("parent-1"),
      ),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

// ── authority mutations through the callables ────────────────────────────────

describe("authority callables", () => {
  beforeEach(async () => {
    await createHousehold({}, ctx("parent-1"));
    seedMembership("aunt-1");
    seedAuthority("child-1", "parent-1");
  });

  it("grant → partial scopes; reduction of a co-guardian → dispute-hold response", async () => {
    const granted = await grantGuardianAuthority(
      { householdId: HH, childId: "child-1", targetAdultUid: "aunt-1", scopes: ["view", "pickup"] },
      ctx("parent-1"),
    );
    expect(granted).toMatchObject({ success: true, accessVersion: 1 });

    const reduced = await updateAuthorityScopes(
      { householdId: HH, childId: "child-1", targetAdultUid: "aunt-1", newScopes: ["view"] },
      ctx("parent-1"),
    );
    expect(reduced).toMatchObject({ success: true, disputeHold: true, state: "dispute_hold" });
    expect((await checkAuthority("aunt-1", "child-1", "view")).reason).toBe("dispute_hold");
  });

  it("self-revocation applies immediately through the callable", async () => {
    seedAuthority("child-1", "aunt-1", { scopes: ["view"] });
    const res = await revokeGuardianAuthority(
      { householdId: HH, childId: "child-1", targetAdultUid: "aunt-1" },
      ctx("aunt-1"),
    );
    expect(res).toMatchObject({ success: true, state: "revoked", disputeHold: false });
  });

  it("CROSS-HOUSEHOLD DENIAL and unknown-household produce the IDENTICAL error (enumeration-safe)", async () => {
    // aunt-1 is a member of HH but calls against another household.
    hoisted.docs.set("households/hh_other", {
      householdId: "hh_other",
      primaryAdultUid: "other-1",
      status: "active",
      accessVersion: 1,
    });
    const errors: string[] = [];
    await grantGuardianAuthority(
      { householdId: "hh_other", childId: "child-9", targetAdultUid: "aunt-1", scopes: ["view"] },
      ctx("parent-1"),
    ).catch((e: any) => errors.push(`${e.code}|${e.message}`));
    await grantGuardianAuthority(
      { householdId: "hh_missing", childId: "child-9", targetAdultUid: "aunt-1", scopes: ["view"] },
      ctx("parent-1"),
    ).catch((e: any) => errors.push(`${e.code}|${e.message}`));
    expect(errors).toHaveLength(2);
    expect(new Set(errors).size).toBe(1);
    expect(errors[0].startsWith("permission-denied|")).toBe(true);
  });

  it("CONCURRENT AUTHORITY CHANGE: expectedAccessVersion mismatch surfaces as aborted", async () => {
    seedAuthority("child-1", "aunt-1", { scopes: ["view", "pickup"], accessVersion: 2 });
    await expect(
      updateAuthorityScopes(
        {
          householdId: HH,
          childId: "child-1",
          targetAdultUid: "aunt-1",
          newScopes: ["view"],
          expectedAccessVersion: 1,
        },
        ctx("parent-1"),
      ),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("scope validation: unknown scopes rejected as invalid-argument", async () => {
    await expect(
      grantGuardianAuthority(
        { householdId: HH, childId: "child-1", targetAdultUid: "aunt-1", scopes: ["root"] },
        ctx("parent-1"),
      ),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

// ── getMyHouseholdState ──────────────────────────────────────────────────────

describe("getMyHouseholdState", () => {
  it("returns only the caller's own memberships and authority records", async () => {
    await createHousehold({}, ctx("parent-1"));
    seedMembership("aunt-1");
    seedAuthority("child-1", "parent-1");
    seedAuthority("child-1", "aunt-1", { scopes: ["view"] });

    const state = await getMyHouseholdState({}, ctx("aunt-1"));
    expect(state.households).toHaveLength(1);
    expect(state.households[0]).toMatchObject({ householdId: HH, isPrimary: false });
    expect(state.authorities).toHaveLength(1);
    expect(state.authorities[0]).toMatchObject({ childId: "child-1", scopes: ["view"] });
    // Never another adult's records:
    expect(state.authorities.some((a: any) => a.authorityId === "child-1__parent-1")).toBe(false);
  });
});
