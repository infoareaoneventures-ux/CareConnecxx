// U3 (childcare marketplace plan 2026-07-22-002): scheduled lifecycle worker.
// Scenarios: retention enforcement SHIPS OFF (every duration POLICY-TBD — the
// guard refuses enforcement and touches nothing), age-band sweep + explicit
// age-out transition, combined pass draining lifecycle requests, and the
// worker running UNGATED by childcare feature flags (data rights survive an
// emergency-off).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore + Storage mocks ──────────────────────────────────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const storedFiles = new Map<string, { content: string }>();

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
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
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

  const bucket = {
    file: (filePath: string) => ({
      name: filePath,
      save: async (data: any) => {
        storedFiles.set(filePath, { content: String(data) });
      },
      getSignedUrl: async (opts: Record<string, unknown>) => [
        `https://storage.signed.test/${opts.action}/${filePath}`,
      ],
      delete: async () => {
        storedFiles.delete(filePath);
      },
    }),
    getFiles: async ({ prefix }: { prefix: string }) => [
      [...storedFiles.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: k, delete: async () => storedFiles.delete(k) })),
    ],
  };

  return {
    docs,
    storedFiles,
    bucket,
    makeCollRef,
    runTransaction,
    reset: () => {
      docs.clear();
      storedFiles.clear();
    },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (p: string) => hoisted.makeCollRef(p),
    runTransaction: hoisted.runTransaction,
  });
  const storage: any = () => ({ bucket: () => hoisted.bucket });
  return {
    __esModule: true,
    default: { firestore, storage, apps: [{}] },
    firestore,
    storage,
    apps: [{}],
  };
});

vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

import {
  isRetentionEnforcementConfigured,
  runRetentionSweep,
  runAgeBandSweep,
  processChildcareLifecycleOnce,
  RETENTION_TTL_DAYS,
  RETENTION_PURPOSES,
} from "./childcareLifecycleWorker";
import { createLifecycleRequest } from "../privacy/dataLifecycle";
import { GUARDIAN_SCOPES } from "../childcare/guardianAuthority";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const HH = "hh_parent-1";

function seedChildWithDob(childId: string, dateOfBirth: string, band: string) {
  hoisted.docs.set(`child_profiles/${childId}`, {
    childId,
    householdId: HH,
    careVertical: "child",
    displayLabel: "Kid",
    ageBand: band,
    ageBandComputedAt: "2026-01-01T00:00:00.000Z",
    careCategories: ["babysitting"],
    state: "active",
    authorizedViewerUids: ["parent-1"],
    authorityProjection: null,
    accessVersion: 1,
    legalHold: null,
    retentionPolicyVersion: null,
    policyVersion: null,
    safetyCurrentVersion: 1,
    createdByUid: "parent-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  hoisted.docs.set(`child_profiles/${childId}/private/safety`, {
    childId,
    currentVersion: 1,
    accessVersion: 1,
    updatedByUid: "parent-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  hoisted.docs.set(`child_profiles/${childId}/private/safety/versions/1`, {
    childId,
    version: 1,
    data: { dateOfBirth, emergencyContacts: [], healthNotes: null, allergiesNote: null, pickupNotes: null, custodyNotes: null, addressDetail: null },
    provenance: { changedByUid: "parent-1", changeReason: null, source: "profile_create" },
    immutable: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
});

// ── retention guard (R13 — POLICY-TBD, enforcement OFF) ─────────────────────

describe("retention enforcement guard", () => {
  it("ships with every duration POLICY-TBD (null) — enforcement is OFF", () => {
    expect(isRetentionEnforcementConfigured()).toBe(false);
    for (const purpose of RETENTION_PURPOSES) {
      expect(RETENTION_TTL_DAYS[purpose]).toBeNull();
    }
  });

  it("the sweep records the skip and touches NOTHING", async () => {
    seedChildWithDob("child_r", "2020-03-15", "school_age");
    const before = new Map(hoisted.docs);
    const result = await runRetentionSweep();
    expect(result.enforced).toBe(false);
    expect(result.reason).toBe("retention_durations_policy_tbd");
    expect(result.purposesMissingDuration).toEqual([...RETENTION_PURPOSES]);
    expect(hoisted.docs).toEqual(before);
  });
});

// ── age-band sweep ───────────────────────────────────────────────────────────

describe("age-band sweep", () => {
  it("recalculates bands server-side and stamps only the BAND on operational docs", async () => {
    seedChildWithDob("child_band", "2021-06-01", "toddler"); // 5 at NOW → school_age
    seedChildWithDob("child_same", "2024-01-01", "toddler"); // still 2 → unchanged
    const result = await runAgeBandSweep(undefined, { now: NOW });
    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.agedOut).toBe(0);
    const doc = hoisted.docs.get("child_profiles/child_band");
    expect(doc.ageBand).toBe("school_age");
    expect(JSON.stringify(doc)).not.toContain("2021-06-01"); // DOB never leaves the private zone
  });

  it("AGE-OUT: crossing 18 is an explicit state transition with an operator alert — no Auth account", async () => {
    seedChildWithDob("child_adult", "2008-05-01", "teen"); // 18 at NOW
    const result = await runAgeBandSweep(undefined, { now: NOW });
    expect(result.agedOut).toBe(1);
    const doc = hoisted.docs.get("child_profiles/child_adult");
    expect(doc.state).toBe("aged_out");
    expect(doc.ageBand).toBe("aged_out");
    expect(hoisted.docs.get("admin_alerts/child_aged_out_child_adult")).toMatchObject({
      type: "child_profile_aged_out",
    });
    // NEVER a silent adult conversion: no users doc appears.
    expect([...hoisted.docs.keys()].filter((k) => k.startsWith("users/"))).toEqual([]);
  });

  it("a malformed record never stalls the sweep", async () => {
    seedChildWithDob("child_ok", "2021-06-01", "toddler");
    hoisted.docs.set("child_profiles/child_bad", {
      childId: "child_bad",
      householdId: HH,
      state: "active",
      ageBand: "toddler",
    }); // no private zone at all
    const result = await runAgeBandSweep(undefined, { now: NOW });
    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(1);
  });
});

// ── combined pass ────────────────────────────────────────────────────────────

describe("processChildcareLifecycleOnce", () => {
  it("drains lifecycle requests + sweeps bands + records the retention skip in one pass", async () => {
    seedChildWithDob("child_x", "2021-06-01", "toddler");
    hoisted.docs.set(`guardian_authorities/child_x__parent-1`, {
      authorityId: "child_x__parent-1",
      householdId: HH,
      childId: "child_x",
      adultUid: "parent-1",
      careVertical: "child",
      scopes: [...GUARDIAN_SCOPES],
      state: "active",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      accessVersion: 1,
    });
    const request = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: "child_x", scope: "export", idempotencyKey: "e1" },
      { now: NOW },
    );

    const result = await processChildcareLifecycleOnce({ bucket: hoisted.bucket, now: NOW });
    expect(result.requests.attempted).toBe(1);
    expect(result.requests.completed).toBe(1);
    expect(result.ageBands.updated).toBe(1);
    expect(result.retention.enforced).toBe(false);
    expect(hoisted.docs.get(`data_lifecycle_requests/${request.requestId}`).state).toBe("completed");
  });

  it("runs UNGATED by childcare flags: works with NO childcare_flags doc (emergency-off safe)", async () => {
    // Deliberately no childcare_flags/global doc — feature is fully dark.
    seedChildWithDob("child_dark", "2008-05-01", "teen");
    const result = await processChildcareLifecycleOnce({ bucket: hoisted.bucket, now: NOW });
    expect(result.ageBands.agedOut).toBe(1); // safety-correctness sweep still ran
  });
});
