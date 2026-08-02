// U0 (childcare marketplace plan 2026-07-22-002): careVertical backfill
// contract — idempotent senior stamping, dry-run default, resume cursor,
// quarantine for invalid/post-cutoff records, and the hard rule that "child"
// is NEVER inferred from record content.

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({});
  (firestore as unknown as Record<string, unknown>).FieldPath = {
    documentId: () => "__name__",
  };
  (firestore as unknown as Record<string, unknown>).FieldValue = {
    serverTimestamp: () => "SERVER_TS",
  };
  return { __esModule: true, default: { firestore }, firestore };
});

import { runCareVerticalBackfill, CARE_VERTICAL_BACKFILL_VERSION } from "./backfillCareVertical";

const CUTOFF = "2026-08-01T00:00:00.000Z";
const BEFORE = "2026-07-01T00:00:00.000Z";
const AFTER = "2026-08-02T00:00:00.000Z";

interface SeedDoc {
  data: Record<string, unknown>;
  createdIso?: string;
}

// Minimal in-memory Firestore double: id-ordered pagination
// (orderBy(documentId) + startAfter + limit), doc createTime metadata, and a
// write batch that records merged sets.
function fakeDb(seed: Record<string, Record<string, SeedDoc>>) {
  const store = new Map<string, Map<string, SeedDoc>>();
  for (const [coll, docs] of Object.entries(seed)) {
    store.set(coll, new Map(Object.entries(docs)));
  }
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const makeQuery = (coll: string, after?: string, limit = Infinity) => ({
    orderBy: () => makeQuery(coll, after, limit),
    limit: (n: number) => makeQuery(coll, after, n),
    startAfter: (id: string) => makeQuery(coll, id, limit),
    get: async () => {
      const docs = [...(store.get(coll) ?? new Map<string, SeedDoc>()).entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([id]) => (after ? id > after : true))
        .slice(0, limit)
        .map(([id, d]) => ({
          id,
          ref: { path: `${coll}/${id}` },
          data: () => d.data,
          createTime: d.createdIso ? { toDate: () => new Date(d.createdIso!) } : undefined,
        }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  });
  const db = {
    collection: (coll: string) => makeQuery(coll),
    batch: () => ({
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        writes.push({ path: ref.path, data });
        const [coll, id] = ref.path.split("/");
        const existing = store.get(coll)?.get(id);
        if (existing) existing.data = { ...existing.data, ...data };
      },
      commit: async () => undefined,
    }),
  } as unknown as FirebaseFirestore.Firestore;
  return { db, writes };
}

describe("runCareVerticalBackfill (U0)", () => {
  it("dry run counts stampable legacy records without writing", async () => {
    const { db, writes } = fakeDb({
      users: {
        u1: { data: { name: "A" }, createdIso: BEFORE },
        u2: { data: { careVertical: "senior" }, createdIso: BEFORE },
      },
    });
    const r = await runCareVerticalBackfill(db, { collections: ["users"], cutoffIso: CUTOFF });
    expect(r.mode).toBe("DRY_RUN");
    expect(r.stampedSenior).toBe(1);
    expect(r.alreadyStamped).toBe(1);
    expect(r.perCollection.users).toEqual({ scanned: 2, stampedSenior: 1, alreadyStamped: 1, quarantined: 0 });
    expect(writes).toEqual([]); // dry run never touches the batch
  });

  it("apply stamps careVertical:'senior' with version metadata and is idempotent on re-run", async () => {
    const { db, writes } = fakeDb({
      appointments: { a1: { data: { date: "2026-07-10" }, createdIso: BEFORE } },
    });
    const first = await runCareVerticalBackfill(db, { apply: true, collections: ["appointments"], cutoffIso: CUTOFF });
    expect(first.stampedSenior).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("appointments/a1");
    expect(writes[0].data).toMatchObject({
      careVertical: "senior",
      careVerticalBackfillVersion: CARE_VERTICAL_BACKFILL_VERSION,
    });

    // Second run converges: already stamped, zero new writes.
    const second = await runCareVerticalBackfill(db, { apply: true, collections: ["appointments"], cutoffIso: CUTOFF });
    expect(second.stampedSenior).toBe(0);
    expect(second.alreadyStamped).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it("quarantines an invalid careVertical value untouched (never overwrites silently)", async () => {
    const { db, writes } = fakeDb({
      users: { u1: { data: { careVertical: "elder" }, createdIso: BEFORE } },
    });
    const r = await runCareVerticalBackfill(db, { apply: true, collections: ["users"], cutoffIso: CUTOFF });
    expect(r.stampedSenior).toBe(0);
    expect(r.quarantined).toEqual([
      { collection: "users", docId: "u1", reason: "invalid-care-vertical", value: "elder" },
    ]);
    expect(writes).toEqual([]);
  });

  it("fails closed on a post-cutoff record with no vertical (quarantined, never silently senior)", async () => {
    const { db, writes } = fakeDb({
      shifts: { s1: { data: { status: "scheduled" }, createdIso: AFTER } },
    });
    const r = await runCareVerticalBackfill(db, { apply: true, collections: ["shifts"], cutoffIso: CUTOFF });
    expect(r.stampedSenior).toBe(0);
    expect(r.quarantined).toEqual([
      { collection: "shifts", docId: "s1", reason: "post-cutoff-missing-vertical" },
    ]);
    expect(writes).toEqual([]);
  });

  it("never infers 'child' — child-looking content still stamps 'senior' on a legacy record", async () => {
    const { db, writes } = fakeDb({
      job_posts: {
        j1: { data: { careNeeds: ["after-school pickup"], childName: "Max" }, createdIso: BEFORE },
      },
    });
    const r = await runCareVerticalBackfill(db, { apply: true, collections: ["job_posts"], cutoffIso: CUTOFF });
    expect(r.stampedSenior).toBe(1);
    expect(writes[0].data.careVertical).toBe("senior"); // vertical comes from the cutoff rule, not content
  });

  it("an explicit careVertical:'child' record is preserved, not re-stamped", async () => {
    const { db, writes } = fakeDb({
      users: { u1: { data: { careVertical: "child" }, createdIso: BEFORE } },
    });
    const r = await runCareVerticalBackfill(db, { apply: true, collections: ["users"], cutoffIso: CUTOFF });
    expect(r.alreadyStamped).toBe(1);
    expect(writes).toEqual([]);
  });

  it("maxDocs stops early with a resume cursor, and resuming completes the sweep", async () => {
    const seed = {
      users: {
        u1: { data: {}, createdIso: BEFORE },
        u2: { data: {}, createdIso: BEFORE },
        u3: { data: {}, createdIso: BEFORE },
      },
    };
    const { db, writes } = fakeDb(seed);
    const first = await runCareVerticalBackfill(db, {
      apply: true,
      collections: ["users"],
      cutoffIso: CUTOFF,
      maxDocs: 2,
    });
    expect(first.scanned).toBe(2);
    expect(first.resumeCursor).toEqual({ collection: "users", docId: "u2" });

    const second = await runCareVerticalBackfill(db, {
      apply: true,
      collections: ["users"],
      cutoffIso: CUTOFF,
      startAfter: first.resumeCursor!,
    });
    expect(second.resumeCursor).toBeNull();
    // Every doc stamped exactly once across the two runs.
    expect(writes.map((w) => w.path).sort()).toEqual(["users/u1", "users/u2", "users/u3"]);
  });

  it("rejects collections outside CARE_VERTICAL_COLLECTIONS", async () => {
    const { db } = fakeDb({});
    await expect(
      runCareVerticalBackfill(db, { collections: ["memory_operations"] })
    ).rejects.toThrow(/Not careVertical collections/);
  });

  it("legacy record with no createTime metadata is treated as pre-cutoff (stamped senior)", async () => {
    // Injected doubles / exotic snapshots without createTime: absence of
    // metadata cannot make a legacy record fail closed — only a real
    // post-cutoff timestamp can.
    const { db, writes } = fakeDb({ users: { u1: { data: {} } } });
    const r = await runCareVerticalBackfill(db, { apply: true, collections: ["users"], cutoffIso: CUTOFF });
    expect(r.stampedSenior).toBe(1);
    expect(writes).toHaveLength(1);
  });
});
