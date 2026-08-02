// U14 (childcare marketplace plan 2026-07-22-002): provider base/senior split
// rehearsal — idempotent senior marker creation, NEVER a child profile/approval,
// dirty-split quarantine, resume, reconciliation, and the non-production guard.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({});
  (firestore as unknown as Record<string, unknown>).FieldPath = { documentId: () => "__name__" };
  (firestore as unknown as Record<string, unknown>).FieldValue = { serverTimestamp: () => "SERVER_TS" };
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  runProviderVerticalProfileBackfill,
  PROVIDER_VERTICAL_BACKFILL_VERSION,
  SENIOR_VERTICAL_PROFILE_DOC_ID,
} from "./backfillProviderVerticalProfiles";
import { PRODUCTION_PROJECT_ID } from "./nonProductionGuard";

interface SeedDoc {
  data: Record<string, unknown>;
}

// Fake Firestore with nested subcollections (caregivers/{id}/vertical_profiles/{sub}).
// Path is the full slash-joined key; collection()/doc() chain builds it up.
function fakeDb(seed: Record<string, Record<string, SeedDoc>>) {
  const store = new Map<string, Map<string, SeedDoc>>();
  for (const [coll, docs] of Object.entries(seed)) {
    store.set(coll, new Map(Object.entries(docs).map(([id, d]) => [id, { data: { ...d.data } }])));
  }
  const writes: Array<{ path: string }> = [];
  const collMap = (coll: string) => store.get(coll) ?? store.set(coll, new Map()).get(coll)!;

  const docRef = (collPath: string, id: string): any => ({
    __path: `${collPath}/${id}`,
    get: async () => {
      const d = collMap(collPath).get(id);
      return { exists: !!d, id, data: () => d?.data };
    },
    set: async (data: Record<string, unknown>) => {
      writes.push({ path: `${collPath}/${id}` });
      collMap(collPath).set(id, { data: { ...data } });
    },
    collection: (sub: string) => makeColl(`${collPath}/${id}/${sub}`),
  });

  const makeColl = (collPath: string, after?: string, limit = Infinity): any => ({
    doc: (id: string) => docRef(collPath, id),
    orderBy: () => makeColl(collPath, after, limit),
    limit: (n: number) => makeColl(collPath, after, n),
    startAfter: (id: string) => makeColl(collPath, id, limit),
    get: async () => {
      const entries = [...collMap(collPath).entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([id]) => (after ? id > after : true))
        .slice(0, limit);
      const docs = entries.map(([id, d]) => ({ id, ref: docRef(collPath, id), data: () => d.data }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  });

  const db = { collection: (coll: string) => makeColl(coll) } as unknown as FirebaseFirestore.Firestore;
  return { db, writes, store };
}

const T = { skipEnvironmentGuardForTest: true } as const;

describe("runProviderVerticalProfileBackfill (U14)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("dry run counts senior markers to create without writing", async () => {
    const { db, writes } = fakeDb({
      caregivers: { c1: { data: { name: "Ann", hourlyRate: 25 } }, c2: { data: { name: "Bo" } } },
    });
    const r = await runProviderVerticalProfileBackfill(db);
    expect(r.mode).toBe("DRY_RUN");
    expect(r.scannedCaregivers).toBe(2);
    expect(r.seniorMarkersCreated).toBe(2);
    expect(r.childProfilesCreated).toBe(0);
    expect(r.reconciled).toBe(true);
    expect(writes).toEqual([]);
  });

  it("apply creates the senior marker (never a child profile/approval); idempotent rerun", async () => {
    const { db, store, writes } = fakeDb({
      caregivers: { c1: { data: { name: "Ann", email: "a@x.com", languages: ["en"] } } },
    });
    const first = await runProviderVerticalProfileBackfill(db, { apply: true, ...T });
    expect(first.seniorMarkersCreated).toBe(1);

    const marker = store.get(`caregivers/c1/vertical_profiles`)!.get(SENIOR_VERTICAL_PROFILE_DOC_ID)!.data;
    expect(marker.careVertical).toBe("senior");
    expect(marker.reusableBaseFieldsPresent).toEqual(expect.arrayContaining(["name", "email", "languages"]));
    // No child vertical profile was created.
    expect(store.get(`caregivers/c1/vertical_profiles`)!.has("child")).toBe(false);
    // No approval field anywhere in the marker.
    expect(JSON.stringify(marker)).not.toContain("approval");

    const before = writes.length;
    const second = await runProviderVerticalProfileBackfill(db, { apply: true, ...T });
    expect(second.seniorMarkersCreated).toBe(0);
    expect(second.seniorMarkersAlreadyPresent).toBe(1);
    const nonReport = writes.slice(before).filter((w) => !w.path.startsWith("childcare_canary_state/"));
    expect(nonReport).toEqual([]);
  });

  it("quarantines a caregiver whose base doc carries childcare-namespaced fields (dirty split, R24)", async () => {
    const { db } = fakeDb({
      caregivers: { dirty: { data: { name: "X", ageBands: ["3-5"], childcareProvider: { approved: true } } } },
    });
    const r = await runProviderVerticalProfileBackfill(db, { apply: true, ...T });
    expect(r.seniorMarkersCreated).toBe(0);
    expect(r.quarantined).toHaveLength(1);
    expect(r.quarantined[0].reason).toBe("child-fields-on-base");
    expect(r.quarantined[0].fields).toEqual(expect.arrayContaining(["ageBands", "childcareProvider"]));
    expect(r.reconciled).toBe(true);
  });

  it("maxDocs stops early with a resume cursor; resuming completes", async () => {
    const { db } = fakeDb({
      caregivers: { a: { data: {} }, b: { data: {} }, c: { data: {} } },
    });
    const first = await runProviderVerticalProfileBackfill(db, { apply: true, maxDocs: 2, ...T });
    expect(first.scannedCaregivers).toBe(2);
    expect(first.resumeCursor).toBe("b");
    const second = await runProviderVerticalProfileBackfill(db, { apply: true, startAfterDocId: first.resumeCursor!, ...T });
    expect(second.resumeCursor).toBeNull();
    expect(second.scannedCaregivers).toBe(1);
  });

  it("apply REFUSES against the production project (hard non-production guard)", async () => {
    const { db } = fakeDb({ caregivers: {} });
    process.env.GCLOUD_PROJECT = PRODUCTION_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CONFIG;
    await expect(runProviderVerticalProfileBackfill(db, { apply: true })).rejects.toThrow(/production|hard guard/i);
  });

  it("version stamp exported and stable", () => {
    expect(PROVIDER_VERTICAL_BACKFILL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/);
  });
});
