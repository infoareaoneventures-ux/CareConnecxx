// U12 (childcare marketplace plan 2026-07-22-002): least-privilege operator
// scopes (R55/R56, KTD20, AE18). Scenarios: full allow/deny matrix
// (childSafety vs general vs broad-isAdmin-only vs none), broad admin without
// the child scope denied, reason missing → denied, stale auth_time → denied,
// operator removal (deactivate/delete) revokes access, enumeration-safe
// denials, the R56 fail-closed immutable access record, and the pure
// scope-satisfaction helper (six-role extensibility).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore mock (providerVerticalCallables.test.ts idiom) ───────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  let autoId = 0;
  let failAdds = false;
  const added: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
    }),
    set: async (data: any) => {
      docs.set(path, { ...data });
    },
  });

  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${autoId++}`}`),
    add: async (data: any) => {
      if (failAdds) throw new Error("simulated audit outage");
      const ref = makeDocRef(`${path}/auto-${autoId++}`);
      docs.set(ref.path, { ...data });
      added.push({ path: ref.path, data });
      return ref;
    },
  });

  return {
    docs,
    added,
    makeCollRef,
    setFailAdds: (v: boolean) => { failAdds = v; },
    reset: () => { docs.clear(); added.length = 0; failAdds = false; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({ collection: (p: string) => hoisted.makeCollRef(p) });
  firestore.Timestamp = { fromMillis: (ms: number) => ({ toMillis: () => ms }) };
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

import {
  requireOperatorScope,
  requireAnyOperatorScope,
  operatorScopeSatisfied,
  getActiveOperatorScopes,
  OPERATOR_SCOPE_CHILD_SAFETY,
  OPERATOR_SCOPE_GENERAL,
  OPERATOR_SCOPE_CHILD_BILLING,
  OPERATOR_SCOPE_CHILD_SUPPORT,
  OPERATOR_SCOPE_CHILD_SCREENING,
  CHILDCARE_OPERATORS_COLLECTION,
} from "./requireOperatorScope";

const freshAuthTime = () => Math.floor(Date.now() / 1000) - 5;
const staleAuthTime = () => Math.floor(Date.now() / 1000) - 3600;

function ctx(uid: string | null, opts: { authTime?: number } = {}): any {
  if (uid === null) return {};
  return { auth: { uid, token: { auth_time: opts.authTime ?? freshAuthTime() } } };
}

function grantOperator(uid: string, scopes: string[], overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`${CHILDCARE_OPERATORS_COLLECTION}/${uid}`, {
    operatorUid: uid,
    scopes,
    active: true,
    grantedByUid: "founder",
    grantedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  });
}

function seedBroadAdmin(uid: string) {
  hoisted.docs.set(`users/${uid}`, { userType: "admin", isAdmin: true });
}

beforeEach(() => {
  hoisted.reset();
});

// ── Pure helper (scope strings — six-role extensibility) ─────────────────────

describe("operatorScopeSatisfied (pure matrix)", () => {
  it("childSafetyOperator: explicit grant only — broad admin NEVER satisfies it (R55/AE18)", () => {
    expect(operatorScopeSatisfied(OPERATOR_SCOPE_CHILD_SAFETY, [OPERATOR_SCOPE_CHILD_SAFETY], false)).toBe(true);
    expect(operatorScopeSatisfied(OPERATOR_SCOPE_CHILD_SAFETY, [], true)).toBe(false);
    expect(operatorScopeSatisfied(OPERATOR_SCOPE_CHILD_SAFETY, [OPERATOR_SCOPE_GENERAL], true)).toBe(false);
  });

  it("generalOperator: explicit grant only; broad admin is never an operator grant", () => {
    expect(operatorScopeSatisfied(OPERATOR_SCOPE_GENERAL, [OPERATOR_SCOPE_GENERAL], false)).toBe(true);
    expect(operatorScopeSatisfied(OPERATOR_SCOPE_GENERAL, [], true)).toBe(false);
    expect(operatorScopeSatisfied(OPERATOR_SCOPE_GENERAL, [], false)).toBe(false);
  });

  it("unknown/future scopes fail closed without an explicit grant (six-role split ready)", () => {
    expect(operatorScopeSatisfied("screeningOperator", [], true)).toBe(false);
    expect(operatorScopeSatisfied("screeningOperator", ["screeningOperator"], false)).toBe(true);
  });
});

// ── Allow/deny matrix through the async gate ─────────────────────────────────

describe("requireOperatorScope — allow/deny matrix (R55)", () => {
  it("childSafety holder passes the childSafety gate and is denied the general gate", async () => {
    grantOperator("op-safety", [OPERATOR_SCOPE_CHILD_SAFETY]);
    await expect(
      requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_CHILD_SAFETY),
    ).resolves.toBe("op-safety");
    await expect(
      requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_GENERAL),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("general holder passes the general gate and is denied the childSafety gate", async () => {
    grantOperator("op-gen", [OPERATOR_SCOPE_GENERAL]);
    await expect(requireOperatorScope(ctx("op-gen"), OPERATOR_SCOPE_GENERAL)).resolves.toBe("op-gen");
    await expect(
      requireOperatorScope(ctx("op-gen"), OPERATOR_SCOPE_CHILD_SAFETY),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("broad-isAdmin-only is denied every childcare operator scope", async () => {
    seedBroadAdmin("admin-1");
    for (const scope of [
      OPERATOR_SCOPE_GENERAL,
      OPERATOR_SCOPE_CHILD_SAFETY,
      OPERATOR_SCOPE_CHILD_BILLING,
      OPERATOR_SCOPE_CHILD_SUPPORT,
      OPERATOR_SCOPE_CHILD_SCREENING,
    ]) {
      await expect(
        requireOperatorScope(ctx("admin-1"), scope),
      ).rejects.toMatchObject({ code: "permission-denied" });
    }
  });

  it("no grant, no admin: both scopes denied; unauthenticated denied", async () => {
    hoisted.docs.set("users/nobody", { userType: "caregiver" });
    await expect(
      requireOperatorScope(ctx("nobody"), OPERATOR_SCOPE_GENERAL),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      requireOperatorScope(ctx("nobody"), OPERATOR_SCOPE_CHILD_SAFETY),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      requireOperatorScope(ctx(null), OPERATOR_SCOPE_GENERAL),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("denials are enumeration-safe: identical code AND message for no-doc, inactive, and wrong-scope", async () => {
    grantOperator("op-inactive", [OPERATOR_SCOPE_CHILD_SAFETY], { active: false });
    grantOperator("op-wrong", [OPERATOR_SCOPE_GENERAL]);
    const errors: any[] = [];
    for (const uid of ["ghost", "op-inactive", "op-wrong"]) {
      try {
        await requireOperatorScope(ctx(uid), OPERATOR_SCOPE_CHILD_SAFETY);
        throw new Error("should have thrown");
      } catch (err) {
        errors.push(err);
      }
    }
    for (const err of errors) {
      expect(err.code).toBe("permission-denied");
      expect(err.message).toBe(errors[0].message);
    }
  });
});

// ── Operator removal revokes access (live read — no cache) ───────────────────

describe("operator removal", () => {
  it("deactivating the grant revokes access immediately", async () => {
    grantOperator("op-1", [OPERATOR_SCOPE_CHILD_SAFETY]);
    await expect(requireOperatorScope(ctx("op-1"), OPERATOR_SCOPE_CHILD_SAFETY)).resolves.toBe("op-1");
    grantOperator("op-1", [OPERATOR_SCOPE_CHILD_SAFETY], { active: false, revokedAt: "2026-07-23T01:00:00.000Z" });
    await expect(
      requireOperatorScope(ctx("op-1"), OPERATOR_SCOPE_CHILD_SAFETY),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("deleting the grant doc revokes access immediately", async () => {
    grantOperator("op-2", [OPERATOR_SCOPE_GENERAL]);
    await expect(requireOperatorScope(ctx("op-2"), OPERATOR_SCOPE_GENERAL)).resolves.toBe("op-2");
    hoisted.docs.delete(`${CHILDCARE_OPERATORS_COLLECTION}/op-2`);
    await expect(
      requireOperatorScope(ctx("op-2"), OPERATOR_SCOPE_GENERAL),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("getActiveOperatorScopes returns [] for missing/inactive and cleans grant values", async () => {
    const db = { collection: (p: string) => hoisted.makeCollRef(p) } as any;
    expect(await getActiveOperatorScopes("ghost", db)).toEqual([]);
    grantOperator("op-3", [OPERATOR_SCOPE_GENERAL, "", "  "], {});
    expect(await getActiveOperatorScopes("op-3", db)).toEqual([OPERATOR_SCOPE_GENERAL]);
    grantOperator("op-3", [OPERATOR_SCOPE_GENERAL], { active: false });
    expect(await getActiveOperatorScopes("op-3", db)).toEqual([]);
  });
});

// ── Recent auth (R18/R56) ────────────────────────────────────────────────────

describe("recent auth (auth_time)", () => {
  it("childSafety operations require recent auth BY DEFAULT — stale auth_time denied", async () => {
    grantOperator("op-safety", [OPERATOR_SCOPE_CHILD_SAFETY]);
    await expect(
      requireOperatorScope(ctx("op-safety", { authTime: staleAuthTime() }), OPERATOR_SCOPE_CHILD_SAFETY),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(
      requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_CHILD_SAFETY),
    ).resolves.toBe("op-safety");
  });

  it("general operations skip recent auth by default but can opt in", async () => {
    grantOperator("op-gen", [OPERATOR_SCOPE_GENERAL]);
    await expect(
      requireOperatorScope(ctx("op-gen", { authTime: staleAuthTime() }), OPERATOR_SCOPE_GENERAL),
    ).resolves.toBe("op-gen");
    await expect(
      requireOperatorScope(ctx("op-gen", { authTime: staleAuthTime() }), OPERATOR_SCOPE_GENERAL, {
        recentAuth: true,
      }),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("the scope check runs FIRST: a stale unauthorized caller sees permission-denied, not the auth hint", async () => {
    await expect(
      requireOperatorScope(ctx("stranger", { authTime: staleAuthTime() }), OPERATOR_SCOPE_CHILD_SAFETY),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── R56 reason-for-access + fail-closed immutable audit ─────────────────────

describe("sensitive access (reason + immutable audit, R56)", () => {
  const ACCESS = { action: "incident_detail_read", objectRef: "cinc_1" };

  it("missing/empty/whitespace reason → denied (failed-precondition)", async () => {
    grantOperator("op-safety", [OPERATOR_SCOPE_CHILD_SAFETY]);
    for (const reason of [undefined, null, "", "   ", 42]) {
      await expect(
        requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_CHILD_SAFETY, {
          access: { ...ACCESS, reason },
        }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
    }
    expect(hoisted.added).toHaveLength(0); // nothing recorded, nothing granted
  });

  it("valid reason → access record written with actor, scope, action, object, reason, timestamp", async () => {
    grantOperator("op-safety", [OPERATOR_SCOPE_CHILD_SAFETY]);
    const uid = await requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_CHILD_SAFETY, {
      access: { ...ACCESS, reason: "incident_investigation" },
      now: new Date("2026-07-23T12:00:00.000Z"),
    });
    expect(uid).toBe("op-safety");
    expect(hoisted.added).toHaveLength(1);
    const row = hoisted.added[0];
    expect(row.path.startsWith("agent_audit_log/")).toBe(true);
    expect(row.data).toMatchObject({
      eventType: "childcare_operator_access",
      userId: "op-safety",
      timestamp: "2026-07-23T12:00:00.000Z",
      data: {
        scope: OPERATOR_SCOPE_CHILD_SAFETY,
        action: "incident_detail_read",
        objectRef: "cinc_1",
        reasonCode: "incident_investigation",
      },
    });
    expect(row.data.ttl).toBeTruthy(); // 6y TTL stamped like every audit row
  });

  it("FAIL-CLOSED: when the audit row cannot be written, access is DENIED", async () => {
    grantOperator("op-safety", [OPERATOR_SCOPE_CHILD_SAFETY]);
    hoisted.setFailAdds(true);
    await expect(
      requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_CHILD_SAFETY, {
        access: { ...ACCESS, reason: "incident_investigation" },
      }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("free-form or oversized reasons are rejected", async () => {
    grantOperator("op-safety", [OPERATOR_SCOPE_CHILD_SAFETY]);
    await expect(
      requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_CHILD_SAFETY, {
        access: { ...ACCESS, reason: "because I want to see it" },
      }),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });
});

// ── requireAnyOperatorScope ──────────────────────────────────────────────────

describe("requireAnyOperatorScope", () => {
  it("first satisfied explicit scope wins; broad admin has no fallback", async () => {
    grantOperator("op-safety", [OPERATOR_SCOPE_CHILD_SAFETY]);
    const a = await requireAnyOperatorScope(
      ctx("op-safety"),
      [OPERATOR_SCOPE_CHILD_SAFETY, OPERATOR_SCOPE_GENERAL],
      { recentAuth: false },
    );
    expect(a).toEqual({ operatorUid: "op-safety", scope: OPERATOR_SCOPE_CHILD_SAFETY });

    seedBroadAdmin("admin-1");
    await expect(
      requireAnyOperatorScope(
        ctx("admin-1"),
        [OPERATOR_SCOPE_CHILD_SAFETY, OPERATOR_SCOPE_GENERAL],
        { recentAuth: false },
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("denied when no scope matches (enumeration-safe) and when unauthenticated", async () => {
    await expect(
      requireAnyOperatorScope(ctx("stranger"), [OPERATOR_SCOPE_CHILD_SAFETY, OPERATOR_SCOPE_GENERAL]),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      requireAnyOperatorScope(ctx(null), [OPERATOR_SCOPE_GENERAL]),
    ).rejects.toMatchObject({ code: "permission-denied" });
    // childSafety-only requirement: broad admin still denied through the any-gate.
    seedBroadAdmin("admin-1");
    await expect(
      requireAnyOperatorScope(ctx("admin-1"), [OPERATOR_SCOPE_CHILD_SAFETY]),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── Emergency-off (operator access is never dark) ────────────────────────────

describe("emergency-off carve-out", () => {
  it("the gate never consults childcare flags — access works with flags absent AND with emergencyOff set", async () => {
    grantOperator("op-safety", [OPERATOR_SCOPE_CHILD_SAFETY]);
    // No childcare_flags doc at all:
    await expect(requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_CHILD_SAFETY)).resolves.toBe("op-safety");
    // Emergency-off set:
    hoisted.docs.set("childcare_flags/global", { emergencyOff: true });
    await expect(requireOperatorScope(ctx("op-safety"), OPERATOR_SCOPE_CHILD_SAFETY)).resolves.toBe("op-safety");
  });
});
