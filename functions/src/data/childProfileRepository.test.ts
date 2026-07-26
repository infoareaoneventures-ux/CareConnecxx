// U3 (childcare marketplace plan 2026-07-22-002): child profile repository.
// Scenarios: zoned create (operational summary vs private safety versions),
// primary-guardian bootstrap, authority-scoped update/read, immutable safety
// versions + pointer, authorizedViewerUids projection maintenance, age-band
// recalc + EXPLICIT age-out transition (no Auth account, R16), legal holds,
// lifecycle tombstone/redaction support, and the structural no-child-contact
// guard (R9/AE2).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

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
  createChildProfileWithBootstrap,
  updateChildProfile,
  appendChildSafetyVersion,
  getChildProfile,
  getCurrentChildSafetyVersion,
  listChildSafetyVersions,
  recomputeAuthorizedViewerProjection,
  recalcChildAgeBand,
  setChildLegalHold,
  tombstoneChildProfileForDeletion,
  redactChildSafetyVersions,
  revokeAllChildViewerAccess,
  assertNoChildIdentityContactFields,
  normalizeChildSafetyData,
  computeAgeBand,
  childProfileDocId,
  ChildProfileError,
  type ChildProfileDoc,
} from "./childProfileRepository";
import { GUARDIAN_SCOPES } from "../childcare/guardianAuthority";

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
  allergiesNote: "peanuts",
  pickupNotes: null,
  custodyNotes: null,
  addressDetail: null,
};

function createParams(overrides: Record<string, unknown> = {}) {
  return {
    householdId: HH,
    createdByUid: "parent-1",
    displayLabel: "Mia",
    careCategories: ["babysitting"],
    safety: VALID_SAFETY,
    idempotencyKey: "op-1",
    ...overrides,
  } as any;
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  seedHousehold();
  seedMembership("parent-1");
  seedMembership("aunt-1");
});

// ── structural no-child-Auth assertions (R9/AE2) ─────────────────────────────

describe("structural no-child-contact guard", () => {
  it("rejects contact/identity keys at any depth", () => {
    for (const bad of [
      { email: "kid@example.com" },
      { phone: "+14085550000" },
      { nested: { childPhone: "+14085550000" } },
      { uid: "some-auth-uid" },
      { deep: [{ fcmToken: "tok" }] },
    ]) {
      expect(() => assertNoChildIdentityContactFields(bad)).toThrow(ChildProfileError);
    }
  });

  it("allows ADULT emergency contacts (the one sanctioned phone shape)", () => {
    expect(() =>
      assertNoChildIdentityContactFields({ emergencyContacts: [{ phone: "+14085551234" }] }),
    ).not.toThrow();
  });

  it("child profile and lifecycle modules never create or mutate Firebase Auth accounts", () => {
    const files = [
      path.resolve(__dirname, "childProfileRepository.ts"),
      path.resolve(__dirname, "../childcare/childProfileCallables.ts"),
      path.resolve(__dirname, "../childcare/childFileAccess.ts"),
      path.resolve(__dirname, "../privacy/dataLifecycle.ts"),
      path.resolve(__dirname, "../scheduled/childcareLifecycleWorker.ts"),
    ];
    // Children NEVER get Auth accounts, so no account-lifecycle Auth API may
    // appear in these modules. The one sanctioned Auth call is read-only
    // caller authentication (verifyIdToken) on the authenticated child-file
    // delivery endpoint — it reads a caller's own token and can neither create
    // nor mutate an account. Every admin.auth() site is checked individually
    // below so a future account-touching call cannot slip in.
    const ACCOUNT_LIFECYCLE_API =
      /\b(createUser|updateUser|deleteUser|deleteUsers|importUsers|setCustomUserClaims|createCustomToken|generatePasswordResetLink|generateEmailVerificationLink)\s*\(/;
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, `${file} must never create/touch Auth accounts`).not.toMatch(ACCOUNT_LIFECYCLE_API);
      for (const match of source.matchAll(/admin\s*\.\s*auth\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
        expect(
          match[1],
          `${file}: admin.auth().${match[1]}() is not a sanctioned read-only Auth call`,
        ).toBe("verifyIdToken");
      }
    }
  });
});

// ── safety data normalization ────────────────────────────────────────────────

describe("normalizeChildSafetyData", () => {
  it("requires a valid past ISO date of birth", () => {
    expect(() => normalizeChildSafetyData({ ...VALID_SAFETY, dateOfBirth: "03/15/2020" }, { now: NOW })).toThrow();
    expect(() => normalizeChildSafetyData({ ...VALID_SAFETY, dateOfBirth: "2030-01-01" }, { now: NOW })).toThrow();
    expect(() => normalizeChildSafetyData({ emergencyContacts: [] }, { now: NOW })).toThrow(); // no dob
  });

  it("bounds emergency contacts and requires E.164 adult phones", () => {
    expect(() =>
      normalizeChildSafetyData(
        { ...VALID_SAFETY, emergencyContacts: [{ name: "X", relationship: "aunt", phone: "555-1234" }] },
        { now: NOW },
      ),
    ).toThrow();
    expect(() =>
      normalizeChildSafetyData(
        { ...VALID_SAFETY, emergencyContacts: new Array(6).fill(VALID_SAFETY.emergencyContacts[0]) },
        { now: NOW },
      ),
    ).toThrow();
  });

  it("carries forward previous values when fields are omitted", () => {
    const previous = normalizeChildSafetyData(VALID_SAFETY, { now: NOW });
    const next = normalizeChildSafetyData({ healthNotes: "updated" }, { previous, now: NOW });
    expect(next.dateOfBirth).toBe("2020-03-15");
    expect(next.healthNotes).toBe("updated");
    expect(next.allergiesNote).toBe("peanuts");
  });
});

describe("computeAgeBand", () => {
  it("maps ages to bands and 18+ to aged_out", () => {
    expect(computeAgeBand("2026-01-01", NOW)).toBe("infant");
    expect(computeAgeBand("2024-07-01", NOW)).toBe("toddler");
    expect(computeAgeBand("2022-07-01", NOW)).toBe("preschool");
    expect(computeAgeBand("2019-07-01", NOW)).toBe("school_age");
    expect(computeAgeBand("2015-07-01", NOW)).toBe("preteen");
    expect(computeAgeBand("2010-07-01", NOW)).toBe("teen");
    expect(computeAgeBand("2008-07-21", NOW)).toBe("aged_out");
  });
});

// ── create (zoned, bootstrapped, idempotent) ─────────────────────────────────

describe("createChildProfileWithBootstrap", () => {
  it("creates the operational summary WITHOUT exact DOB and the private zone WITH it", async () => {
    const result = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    const childId = result.profile.childId;
    expect(childId).toBe(childProfileDocId(HH, "op-1"));

    // Operational summary: band only, categories, label — no DOB anywhere.
    const operational = hoisted.docs.get(`child_profiles/${childId}`);
    expect(operational.ageBand).toBe("school_age");
    expect(operational.displayLabel).toBe("Mia");
    expect(operational.careVertical).toBe("child");
    expect(JSON.stringify(operational)).not.toContain("2020-03-15");
    expect(JSON.stringify(operational)).not.toContain("peanut");
    // Structural: no contact/identity keys on the child record.
    expect(() => assertNoChildIdentityContactFields(operational)).not.toThrow();

    // Private zone: immutable v1 + pointer.
    const v1 = hoisted.docs.get(`child_profiles/${childId}/private/safety/versions/1`);
    expect(v1.data.dateOfBirth).toBe("2020-03-15");
    expect(v1.immutable).toBe(true);
    expect(v1.provenance.source).toBe("profile_create");
    const pointer = hoisted.docs.get(`child_profiles/${childId}/private/safety`);
    expect(pointer.currentVersion).toBe(1);

    // Bootstrap: the primary guardian holds ALL scopes.
    expect(result.authority.source).toBe("bootstrap_primary_guardian");
    expect(result.authority.scopes).toEqual([...GUARDIAN_SCOPES]);

    // Viewer projection includes the primary parent, version-stamped.
    const after = hoisted.docs.get(`child_profiles/${childId}`);
    expect(after.authorizedViewerUids).toEqual(["parent-1"]);
    expect(after.authorityProjection.projectionVersion).toBeGreaterThan(0);
    expect(after.authorityProjection.sourceAuthorityVersions["parent-1"]).toBe(1);
  });

  it("is idempotent: the same idempotency key converges to one child", async () => {
    const first = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    const second = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    expect(second.profile.childId).toBe(first.profile.childId);
    expect(second.created).toBe(false);
    const versions = await listChildSafetyVersions(first.profile.childId);
    expect(versions).toHaveLength(1);
  });

  it("only the household primary adult may create (bootstrap contract)", async () => {
    await expect(
      createChildProfileWithBootstrap(createParams({ createdByUid: "aunt-1", idempotencyKey: "op-2" }), { now: NOW }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      createChildProfileWithBootstrap(createParams({ householdId: "hh_missing" }), { now: NOW }),
    ).rejects.toMatchObject({ code: "household_not_found" });
  });

  it("rejects deferred/unknown care categories fail-closed", async () => {
    await expect(
      createChildProfileWithBootstrap(createParams({ careCategories: ["infant_care"] }), { now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createChildProfileWithBootstrap(createParams({ careCategories: ["overnight_care"] }), { now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createChildProfileWithBootstrap(createParams({ careCategories: ["made_up"] }), { now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses an adult-aged recipient (already_adult, R16 at the front door)", async () => {
    await expect(
      createChildProfileWithBootstrap(
        createParams({ safety: { ...VALID_SAFETY, dateOfBirth: "2005-01-01" } }),
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "already_adult" });
  });

  it("rejects display labels that smuggle contact handles", async () => {
    await expect(
      createChildProfileWithBootstrap(createParams({ displayLabel: "mia@example.com" }), { now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createChildProfileWithBootstrap(createParams({ displayLabel: "Mia 4085551234" }), { now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ── update by authority scope ────────────────────────────────────────────────

describe("updateChildProfile", () => {
  let childId: string;
  beforeEach(async () => {
    const result = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    childId = result.profile.childId;
  });

  it("management scope updates whitelisted fields", async () => {
    const updated = await updateChildProfile(
      { actorUid: "parent-1", childId, updates: { displayLabel: "Mia R" }, idempotencyKey: "u1" },
      { now: NOW },
    );
    expect(updated.displayLabel).toBe("Mia R");
  });

  it("a view-only adult cannot update (scope_not_granted)", async () => {
    seedAuthority(childId, "aunt-1", { scopes: ["view"] });
    await expect(
      updateChildProfile({ actorUid: "aunt-1", childId, updates: { displayLabel: "X" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("no authority at all denies like a stranger", async () => {
    await expect(
      updateChildProfile({ actorUid: "stranger-1", childId, updates: { displayLabel: "X" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });
});

// ── safety versions (immutable + pointer) ────────────────────────────────────

describe("appendChildSafetyVersion", () => {
  let childId: string;
  beforeEach(async () => {
    const result = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    childId = result.profile.childId;
  });

  it("appends an immutable v2 and advances the pointer + access versions", async () => {
    const before = hoisted.docs.get(`child_profiles/${childId}`) as ChildProfileDoc;
    const result = await appendChildSafetyVersion(
      {
        actorUid: "parent-1",
        childId,
        safety: { healthNotes: "new inhaler plan" },
        changeReason: "asthma dx",
        idempotencyKey: "s2",
      },
      { now: NOW },
    );
    expect(result.version.version).toBe(2);
    expect(result.version.data.dateOfBirth).toBe("2020-03-15"); // carried forward
    expect(result.pointer.currentVersion).toBe(2);
    // v1 remains untouched (immutability).
    const v1 = hoisted.docs.get(`child_profiles/${childId}/private/safety/versions/1`);
    expect(v1.data.healthNotes).toBe("peanut allergy");
    const after = hoisted.docs.get(`child_profiles/${childId}`) as ChildProfileDoc;
    expect(after.safetyCurrentVersion).toBe(2);
    expect(after.accessVersion).toBeGreaterThan(before.accessVersion);
    // Operational doc still carries no DOB.
    expect(JSON.stringify(after)).not.toContain("2020-03-15");
  });

  it("is idempotent per operation key", async () => {
    const p = { actorUid: "parent-1", childId, safety: { healthNotes: "x" }, idempotencyKey: "s-same" };
    const first = await appendChildSafetyVersion(p, { now: NOW });
    const second = await appendChildSafetyVersion(p, { now: NOW });
    expect(first.version.version).toBe(2);
    expect(second.appended).toBe(false);
    expect(second.pointer.currentVersion).toBe(2);
  });

  it("view/schedule scopes cannot append; strangers cannot append", async () => {
    seedAuthority(childId, "aunt-1", { scopes: ["view", "schedule"] });
    await expect(
      appendChildSafetyVersion({ actorUid: "aunt-1", childId, safety: { healthNotes: "x" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      appendChildSafetyVersion({ actorUid: "stranger-1", childId, safety: { healthNotes: "x" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("a legal hold freezes the safety record", async () => {
    await setChildLegalHold(childId, { active: true, reason: "case 12", placedByUid: "op-1" }, { now: NOW });
    await expect(
      appendChildSafetyVersion({ actorUid: "parent-1", childId, safety: { healthNotes: "x" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "legal_hold_active" });
  });
});

// ── viewer projection (R6 derived cache) ─────────────────────────────────────

describe("recomputeAuthorizedViewerProjection", () => {
  let childId: string;
  beforeEach(async () => {
    const result = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    childId = result.profile.childId;
  });

  it("includes active view-scoped adults and excludes revoked/expired/no-view", async () => {
    seedAuthority(childId, "aunt-1", { scopes: ["view", "schedule"], accessVersion: 3 });
    seedAuthority(childId, "revoked-1", { state: "revoked", accessVersion: 2 });
    seedAuthority(childId, "expired-1", { expiresAt: "2026-01-01T00:00:00.000Z", accessVersion: 1 });
    seedAuthority(childId, "payer-1", { scopes: ["payment"], accessVersion: 1 });

    const projection = await recomputeAuthorizedViewerProjection(childId, { now: NOW });
    expect(projection?.viewerUids).toEqual(["aunt-1", "parent-1"]);
    // Version-stamped from EVERY authority row, active or not.
    expect(projection?.sourceAuthorityVersions["revoked-1"]).toBe(2);
    const doc = hoisted.docs.get(`child_profiles/${childId}`);
    expect(doc.authorizedViewerUids).toEqual(["aunt-1", "parent-1"]);
  });

  it("no-ops for unknown children (invites may reference future children)", async () => {
    expect(await recomputeAuthorizedViewerProjection("child_missing")).toBeNull();
  });

  it("revokeAllChildViewerAccess empties the cache and bumps accessVersion", async () => {
    const before = hoisted.docs.get(`child_profiles/${childId}`);
    await revokeAllChildViewerAccess(childId, { now: NOW });
    const after = hoisted.docs.get(`child_profiles/${childId}`);
    expect(after.authorizedViewerUids).toEqual([]);
    expect(after.accessVersion).toBeGreaterThan(before.accessVersion);
  });
});

// ── age-band recalc + explicit age-out (R16) ─────────────────────────────────

describe("recalcChildAgeBand / age-out", () => {
  it("stamps only the band on the operational doc when the band changes", async () => {
    const { profile } = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    // Two years later the school_age child becomes a preteen — wait, 2020-03-15
    // at 2030 is 10 → preteen.
    const later = new Date("2030-07-22T12:00:00.000Z");
    const result = await recalcChildAgeBand(profile.childId, { now: later });
    expect(result.band).toBe("preteen");
    expect(result.changed).toBe(true);
    expect(result.agedOut).toBe(false);
    const doc = hoisted.docs.get(`child_profiles/${profile.childId}`);
    expect(doc.ageBand).toBe("preteen");
    expect(doc.state).toBe("active");
    expect(JSON.stringify(doc)).not.toContain("2020-03-15"); // band only, never DOB
  });

  it("crossing 18 produces the EXPLICIT aged_out transition with an operator alert and NO Auth account", async () => {
    const { profile } = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    const adult = new Date("2038-04-01T12:00:00.000Z"); // dob 2020-03-15 → 18
    const result = await recalcChildAgeBand(profile.childId, { now: adult });
    expect(result.agedOut).toBe(true);
    const doc = hoisted.docs.get(`child_profiles/${profile.childId}`);
    expect(doc.state).toBe("aged_out");
    expect(doc.ageBand).toBe("aged_out");
    expect(doc.agedOutAt).toBeTruthy();
    // Operator-visible transition:
    expect(hoisted.docs.get(`admin_alerts/child_aged_out_${profile.childId}`)).toMatchObject({
      type: "child_profile_aged_out",
    });
    // NEVER a silent adult conversion: no users/{uid} doc appears anywhere.
    const userDocs = [...hoisted.docs.keys()].filter((k) => k.startsWith("users/"));
    expect(userDocs).toEqual([]);
    // Idempotent second pass:
    const again = await recalcChildAgeBand(profile.childId, { now: adult });
    expect(again.agedOut).toBe(false);
    expect(again.changed).toBe(false);
  });
});

// ── lifecycle support (tombstone / redaction) ────────────────────────────────

describe("tombstone + redaction support", () => {
  let childId: string;
  beforeEach(async () => {
    const result = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    childId = result.profile.childId;
    await appendChildSafetyVersion(
      { actorUid: "parent-1", childId, safety: { healthNotes: "v2" }, idempotencyKey: "s2" },
      { now: NOW },
    );
  });

  it("tombstones the operational doc and purges the private zone (idempotent)", async () => {
    const result = await tombstoneChildProfileForDeletion(childId, "dlr_1", { now: NOW });
    expect(result.hadProfile).toBe(true);
    expect(result.deletedPrivateDocs).toBeGreaterThanOrEqual(3); // v1 + v2 + pointer
    const tombstone = hoisted.docs.get(`child_profiles/${childId}`);
    expect(tombstone.state).toBe("deleted");
    expect(tombstone.tombstone).toBe(true);
    expect(tombstone.lifecycleRequestId).toBe("dlr_1");
    expect(tombstone.displayLabel).toBeUndefined(); // no residual PII
    expect(tombstone.authorizedViewerUids).toEqual([]);
    expect(hoisted.docs.get(`child_profiles/${childId}/private/safety`)).toBeUndefined();
    expect(hoisted.docs.get(`child_profiles/${childId}/private/safety/versions/1`)).toBeUndefined();

    // Idempotent rerun converges.
    const rerun = await tombstoneChildProfileForDeletion(childId, "dlr_1", { now: NOW });
    expect(rerun.hadProfile).toBe(false);
    expect(rerun.deletedPrivateDocs).toBe(0);
  });

  it("a legal hold blocks the tombstone", async () => {
    await setChildLegalHold(childId, { active: true, reason: "case 9", placedByUid: "op-1" }, { now: NOW });
    await expect(tombstoneChildProfileForDeletion(childId, "dlr_2", { now: NOW })).rejects.toMatchObject({
      code: "legal_hold_active",
    });
  });

  it("redaction purges versions but keeps the profile with a redacted pointer", async () => {
    const result = await redactChildSafetyVersions(childId, "dlr_3", { now: NOW });
    expect(result.deletedVersions).toBe(2);
    const pointer = hoisted.docs.get(`child_profiles/${childId}/private/safety`);
    expect(pointer.redacted).toBe(true);
    expect(pointer.currentVersion).toBe(0);
    const profile = hoisted.docs.get(`child_profiles/${childId}`);
    expect(profile.state).toBe("active");
    expect(profile.safetyCurrentVersion).toBe(0);
    expect(await getCurrentChildSafetyVersion(childId)).toBeNull();
  });
});

// ── reads ────────────────────────────────────────────────────────────────────

describe("reads", () => {
  it("getChildProfile returns the operational doc; private accessor returns versions", async () => {
    const { profile } = await createChildProfileWithBootstrap(createParams(), { now: NOW });
    const read = await getChildProfile(profile.childId);
    expect(read?.displayLabel).toBe("Mia");
    const current = await getCurrentChildSafetyVersion(profile.childId);
    expect(current?.data.dateOfBirth).toBe("2020-03-15");
  });
});
