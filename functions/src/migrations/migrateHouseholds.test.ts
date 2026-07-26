// U14 (childcare marketplace plan 2026-07-22-002): household migration
// rehearsal — dry-run/resume, idempotent rerun, phone-only → provisional
// membership (zero scopes), unresolved/ambiguous quarantine, orphan detection,
// reconciliation (zero unexplained), and the hard non-production guard.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({});
  (firestore as unknown as Record<string, unknown>).FieldPath = { documentId: () => "__name__" };
  (firestore as unknown as Record<string, unknown>).FieldValue = { serverTimestamp: () => "SERVER_TS" };
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  runHouseholdMigration,
  HOUSEHOLD_MIGRATION_VERSION,
} from "./migrateHouseholds";
import { PRODUCTION_PROJECT_ID } from "./nonProductionGuard";

interface SeedDoc {
  data: Record<string, unknown>;
}

// In-memory Firestore double: id-ordered pagination (orderBy(documentId) +
// startAfter + limit), doc get/set, equality where(), full get(), and a batch.
function fakeDb(seed: Record<string, Record<string, SeedDoc>>) {
  const store = new Map<string, Map<string, SeedDoc>>();
  for (const [coll, docs] of Object.entries(seed)) {
    store.set(coll, new Map(Object.entries(docs).map(([id, d]) => [id, { data: { ...d.data } }])));
  }
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const collMap = (coll: string) => store.get(coll) ?? store.set(coll, new Map()).get(coll)!;

  const docRef = (coll: string, id: string) => ({
    __coll: coll,
    __id: id,
    path: `${coll}/${id}`,
    get: async () => {
      const d = collMap(coll).get(id);
      return { exists: !!d, id, data: () => d?.data };
    },
    set: async (data: Record<string, unknown>) => {
      writes.push({ path: `${coll}/${id}`, data });
      collMap(coll).set(id, { data: { ...data } });
    },
  });

  const makeQuery = (coll: string, after?: string, limit = Infinity, whereField?: string, whereVal?: unknown) => ({
    orderBy: () => makeQuery(coll, after, limit, whereField, whereVal),
    limit: (n: number) => makeQuery(coll, after, n, whereField, whereVal),
    startAfter: (id: string) => makeQuery(coll, id, limit, whereField, whereVal),
    where: (field: string, _op: string, val: unknown) => makeQuery(coll, after, limit, field, val),
    get: async () => {
      let entries = [...collMap(coll).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (whereField) entries = entries.filter(([, d]) => d.data[whereField] === whereVal);
      entries = entries.filter(([id]) => (after ? id > after : true)).slice(0, limit);
      const docs = entries.map(([id, d]) => ({ id, ref: docRef(coll, id), data: () => d.data }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  });

  const db = {
    collection: (coll: string) => ({
      ...makeQuery(coll),
      doc: (id: string) => docRef(coll, id),
    }),
    batch: () => {
      const ops: Array<{ ref: { __coll: string; __id: string }; data: Record<string, unknown> }> = [];
      return {
        set: (ref: { __coll: string; __id: string }, data: Record<string, unknown>) => ops.push({ ref, data }),
        commit: async () => {
          for (const op of ops) {
            writes.push({ path: `${op.ref.__coll}/${op.ref.__id}`, data: op.data });
            collMap(op.ref.__coll).set(op.ref.__id, { data: { ...op.data } });
          }
        },
      };
    },
  } as unknown as FirebaseFirestore.Firestore;
  return { db, writes, store };
}

const T = { skipEnvironmentGuardForTest: true } as const;

describe("runHouseholdMigration (U14)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("dry run counts households + provisional memberships without writing", async () => {
    const { db, writes } = fakeDb({
      users: { adultA: { data: { userType: "client" } } },
      senior_profiles: {
        adultA: { data: { name: "Mom", familyMembers: [{ phone: "+15551110001" }, { phone: "+15551110002" }] } },
      },
    });
    const r = await runHouseholdMigration(db, { orphanScan: false });
    expect(r.mode).toBe("DRY_RUN");
    expect(r.scannedSeniorProfiles).toBe(1);
    expect(r.householdsMigrated).toBe(1);
    expect(r.provisionalMembershipsCreated).toBe(2);
    expect(r.reconciled).toBe(true);
    expect(writes).toEqual([]); // dry run never writes
  });

  it("apply creates the household, primary membership, and provisional (phone-only, zero-scope) rows; idempotent on rerun", async () => {
    const { db, writes, store } = fakeDb({
      users: { adultA: { data: { userType: "client" } } },
      senior_profiles: { adultA: { data: { familyMembers: [{ phone: "+15551110001" }] } } },
    });
    const first = await runHouseholdMigration(db, { apply: true, orphanScan: false, ...T });
    expect(first.householdsMigrated).toBe(1);
    expect(first.provisionalMembershipsCreated).toBe(1);

    const household = store.get("households")!.get("hh_adultA")!.data;
    expect(household).toMatchObject({ primaryAdultUid: "adultA", status: "active", accessVersion: 1 });
    // Provisional membership: adultUid null (no auth), provisional status, phone HASH not raw phone.
    const memberships = [...store.get("household_memberships")!.values()].map((d) => d.data);
    const provisional = memberships.find((m) => m.status === "provisional")!;
    expect(provisional.adultUid).toBeNull();
    expect(provisional.provisionalPhoneHash).toBeTypeOf("string");
    expect(JSON.stringify(provisional)).not.toContain("+15551110001"); // raw phone never stored
    const primary = memberships.find((m) => m.role === "primary")!;
    expect(primary).toMatchObject({ adultUid: "adultA", status: "active" });

    const writeCount = writes.length;
    // Rerun converges: everything already present, zero new writes (besides the report).
    const second = await runHouseholdMigration(db, { apply: true, orphanScan: false, ...T });
    expect(second.householdsMigrated).toBe(0);
    expect(second.householdsAlreadyPresent).toBe(1);
    expect(second.provisionalMembershipsCreated).toBe(0);
    expect(second.provisionalMembershipsAlreadyPresent).toBe(1);
    const nonReportWrites = writes.slice(writeCount).filter((w) => !w.path.startsWith("childcare_canary_state/"));
    expect(nonReportWrites).toEqual([]);
  });

  it("pulls extra phones from family_groups keyed by seniorId into provisional memberships", async () => {
    const { db } = fakeDb({
      users: { adultA: { data: {} } },
      senior_profiles: { s1: { data: { clientId: "adultA", familyMembers: [{ phone: "+15551110001" }] } } },
      family_groups: { g1: { data: { seniorId: "s1", phones: ["+15551110001", "+15551110009"] } } },
    });
    const r = await runHouseholdMigration(db, { apply: true, orphanScan: false, ...T });
    // Two distinct phones (one dup) → 2 provisional memberships.
    expect(r.provisionalMembershipsCreated).toBe(2);
  });

  it("quarantines a senior_profile whose owning users doc is absent (never guessed into a household)", async () => {
    const { db } = fakeDb({
      users: {},
      senior_profiles: { ghost: { data: { clientId: "nobody" } } },
    });
    const r = await runHouseholdMigration(db, { apply: true, orphanScan: false, ...T });
    expect(r.householdsMigrated).toBe(0);
    expect(r.quarantined).toEqual([
      { seniorProfileId: "ghost", reason: "unresolved-owning-adult", detail: "owning users doc absent" },
    ]);
    expect(r.reconciled).toBe(true); // 0 migrated + 0 present + 1 quarantined === 1 scanned
  });

  it("quarantines a second senior_profile that claims an already-mapped primary adult (ambiguous)", async () => {
    const { db } = fakeDb({
      users: { adultA: { data: {} } },
      senior_profiles: {
        aa1: { data: { clientId: "adultA" } },
        aa2: { data: { clientId: "adultA" } },
      },
    });
    const r = await runHouseholdMigration(db, { apply: true, orphanScan: false, ...T });
    expect(r.householdsMigrated).toBe(1);
    expect(r.quarantined).toHaveLength(1);
    expect(r.quarantined[0].reason).toBe("ambiguous-owning-adult");
    expect(r.reconciled).toBe(true);
  });

  it("maxDocs stops early with a resume cursor; resuming completes the sweep", async () => {
    const { db } = fakeDb({
      users: { a: { data: {} }, b: { data: {} }, c: { data: {} } },
      senior_profiles: { a: { data: {} }, b: { data: {} }, c: { data: {} } },
    });
    const first = await runHouseholdMigration(db, { apply: true, maxDocs: 2, ...T });
    expect(first.scannedSeniorProfiles).toBe(2);
    expect(first.resumeCursor).toBe("b");
    expect(first.orphanFamilyGroups).toBe(-1); // orphan scan skipped on bounded runs

    const second = await runHouseholdMigration(db, { apply: true, startAfterDocId: first.resumeCursor!, ...T });
    expect(second.resumeCursor).toBeNull();
    expect(second.scannedSeniorProfiles).toBe(1);
  });

  it("counts orphan family_groups (seniorId with no senior_profile) on a full run", async () => {
    const { db } = fakeDb({
      users: { adultA: { data: {} } },
      senior_profiles: { s1: { data: { clientId: "adultA" } } },
      family_groups: {
        g1: { data: { seniorId: "s1" } },
        g2: { data: { seniorId: "gone" } },
      },
    });
    const r = await runHouseholdMigration(db, { apply: true, ...T });
    expect(r.orphanFamilyGroups).toBe(1);
  });

  it("writes a reconciliation report the canary can read (unresolved = quarantined + orphans)", async () => {
    const { db, store } = fakeDb({
      users: {},
      senior_profiles: { ghost: { data: { clientId: "nobody" } } },
      family_groups: { g1: { data: { seniorId: "gone" } } },
    });
    await runHouseholdMigration(db, { apply: true, ...T });
    const report = store.get("childcare_canary_state")!.get("migration_report")!.data;
    expect(report.unresolved).toBe(2); // 1 quarantined + 1 orphan
    expect(report.syntheticOnly).toBe(true);
  });

  it("apply REFUSES against the production project (hard non-production guard, no bypass)", async () => {
    const { db } = fakeDb({ users: {}, senior_profiles: {} });
    process.env.GCLOUD_PROJECT = PRODUCTION_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CONFIG;
    // No skip flag → the guard runs.
    await expect(runHouseholdMigration(db, { apply: true })).rejects.toThrow(/production|hard guard/i);
  });

  it("version stamp is exported and stable", () => {
    expect(HOUSEHOLD_MIGRATION_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/);
  });
});
