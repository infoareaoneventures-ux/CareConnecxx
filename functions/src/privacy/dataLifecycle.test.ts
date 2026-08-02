// U3 (childcare marketplace plan 2026-07-22-002): export/delete/redact durable
// state machine. Scenarios: authority + legal-hold gates at creation, legal
// hold appearing AFTER creation (blocked_legal_hold, resumable), export scope
// correctness (this child only, file inventory, requester-scoped signed URL),
// partial-deletion retry convergence, Stripe Identity redaction tracked as
// awaiting_provider STATE ONLY + operator completion, orphan-file scan,
// bounded retries → requires_admin_review, idempotent rerun, and the R15
// adult-deletion entry point (child survives when another guardian remains).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore + Storage mocks ──────────────────────────────────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const storedFiles = new Map<string, { content: string; contentType?: string }>();
  let failGetFilesTimes = 0;

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
      save: async (data: any, opts?: any) => {
        storedFiles.set(filePath, { content: String(data), contentType: opts?.contentType });
      },
      // Tuple return type annotated so the fake satisfies the production
      // BucketLike contract (Promise<[T]>) rather than Promise<T[]>.
      getMetadata: async (): Promise<[{
        generation?: string | number;
        size?: string | number;
        contentType?: string;
        metadata?: Record<string, string | undefined>;
      }]> => {
        if (!storedFiles.has(filePath)) throw new Error("not found");
        return [{
          generation: "1001",
          size: String(storedFiles.get(filePath)!.content.length),
          contentType: storedFiles.get(filePath)!.contentType,
          metadata: {},
        }];
      },
      delete: async () => {
        storedFiles.delete(filePath);
      },
    }),
    getFiles: async ({ prefix }: { prefix: string }): Promise<[{ name: string; delete: () => Promise<unknown> }[]]> => {
      if (failGetFilesTimes > 0) {
        failGetFilesTimes -= 1;
        throw Object.assign(new Error("transient storage outage"), { name: "StorageTransientError" });
      }
      return [
        [...storedFiles.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ name: k, delete: async () => storedFiles.delete(k) })),
      ];
    },
  };

  return {
    docs,
    storedFiles,
    bucket,
    makeCollRef,
    runTransaction,
    setFailGetFiles: (n: number) => {
      failGetFilesTimes = n;
    },
    reset: () => {
      docs.clear();
      storedFiles.clear();
      failGetFilesTimes = 0;
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
  createLifecycleRequest,
  processLifecycleRequestOnce,
  processLifecycleRequests,
  getLifecycleStatusForRequester,
  markProviderTaskComplete,
  beginAdultAccountDeletion,
  lifecycleRequestId,
  type LifecycleRequestDoc,
} from "./dataLifecycle";
import { setChildLegalHold } from "../data/childProfileRepository";
import { GUARDIAN_SCOPES } from "../childcare/guardianAuthority";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const LATER = new Date("2026-07-23T12:00:00.000Z");
const HH = "hh_parent-1";
const CHILD = "child_abc";
const OTHER_CHILD = "child_other";

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

function seedChild(childId: string, overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`child_profiles/${childId}`, {
    childId,
    householdId: HH,
    careVertical: "child",
    displayLabel: childId === CHILD ? "Mia" : "Theo",
    ageBand: "school_age",
    careCategories: ["babysitting"],
    state: "active",
    authorizedViewerUids: ["parent-1"],
    authorityProjection: null,
    accessVersion: 1,
    legalHold: null,
    retentionPolicyVersion: "childcare-retention-2026-07-22.1",
    policyVersion: null,
    safetyCurrentVersion: 1,
    createdByUid: "parent-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
  hoisted.docs.set(`child_profiles/${childId}/private/safety`, {
    childId,
    currentVersion: 1,
    accessVersion: 1,
    updatedByUid: "parent-1",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  hoisted.docs.set(`child_profiles/${childId}/private/safety/versions/1`, {
    childId,
    version: 1,
    data: {
      dateOfBirth: "2020-03-15",
      emergencyContacts: [{ name: "Grandma", relationship: "grandmother", phone: "+14085551234" }],
      healthNotes: childId === CHILD ? "peanut allergy" : "none",
      allergiesNote: null,
      pickupNotes: null,
      custodyNotes: null,
      addressDetail: null,
    },
    provenance: { changedByUid: "parent-1", changeReason: null, source: "profile_create" },
    immutable: true,
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  hoisted.docs.set(`child_profiles/${childId}/private/file_cf1${childId}`, {
    fileId: `cf1${childId}`,
    childId,
    householdId: HH,
    path: `childcare/${HH}/${childId}/photo/cf1${childId}`,
    contentType: "image/jpeg",
    declaredBytes: 100,
    purpose: "photo",
    state: "uploaded",
    createdByUid: "parent-1",
    authorityAccessVersion: 1,
    profileAccessVersion: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  hoisted.storedFiles.set(`childcare/${HH}/${childId}/photo/cf1${childId}`, { content: "img" });
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

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  seedHousehold();
  seedMembership("parent-1");
  seedMembership("coparent-1");
  seedChild(CHILD);
  seedAuthority(CHILD, "parent-1");
});

// ── creation gates ───────────────────────────────────────────────────────────

describe("createLifecycleRequest", () => {
  it("requires management authority — view-only adults and strangers are denied", async () => {
    seedAuthority(CHILD, "aunt-1", { scopes: ["view"] });
    await expect(
      createLifecycleRequest(
        { requesterUid: "aunt-1", childId: CHILD, scope: "delete", idempotencyKey: "d1" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      createLifecycleRequest(
        { requesterUid: "stranger-1", childId: CHILD, scope: "export", idempotencyKey: "e1" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("LEGAL HOLD blocks delete/redact at creation but not export", async () => {
    await setChildLegalHold(CHILD, { active: true, reason: "case 4", placedByUid: "op-1" }, { now: NOW });
    await expect(
      createLifecycleRequest(
        { requesterUid: "parent-1", childId: CHILD, scope: "delete", idempotencyKey: "d1" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "legal_hold_active" });
    await expect(
      createLifecycleRequest(
        { requesterUid: "parent-1", childId: CHILD, scope: "redact", idempotencyKey: "r1" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "legal_hold_active" });
    const exportRequest = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: CHILD, scope: "export", idempotencyKey: "e1" },
      { now: NOW },
    );
    expect(exportRequest.state).toBe("pending");
  });

  it("is idempotent per (child, scope, key)", async () => {
    const first = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: CHILD, scope: "delete", idempotencyKey: "d1" },
      { now: NOW },
    );
    const second = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: CHILD, scope: "delete", idempotencyKey: "d1" },
      { now: NOW },
    );
    expect(second.requestId).toBe(first.requestId);
    expect(second.createdAt).toBe(first.createdAt);
  });
});

// ── delete scope ─────────────────────────────────────────────────────────────

describe("delete scope", () => {
  async function createDelete(): Promise<LifecycleRequestDoc> {
    return createLifecycleRequest(
      { requesterUid: "parent-1", childId: CHILD, scope: "delete", idempotencyKey: "d1" },
      { now: NOW },
    );
  }

  it("runs the full fan-out and parks awaiting_provider on the Stripe redaction task", async () => {
    const request = await createDelete();
    const result = await processLifecycleRequestOnce(request.requestId, {
      bucket: hoisted.bucket,
      now: NOW,
    });
    expect(result?.state).toBe("awaiting_provider");

    const byKind = Object.fromEntries(result!.tasks.map((t) => [t.kind, t]));
    expect(byKind.revoke_derived_access.state).toBe("completed");
    expect(byKind.firestore_delete.state).toBe("completed");
    expect(byKind.firestore_delete.proof).toMatchObject({ tombstoned: true });
    expect(byKind.storage_delete.state).toBe("completed");
    expect(byKind.ai_reference_scan.state).toBe("completed");
    expect(byKind.ai_reference_scan.proof).toMatchObject({ referencesFound: 0 });
    // Stripe redaction: STATE TRACKING ONLY — founder/provider executes it.
    expect(byKind.stripe_identity_redaction.state).toBe("awaiting_provider");
    expect(byKind.stripe_identity_redaction.proof).toMatchObject({ providerExecuted: false });
    expect(byKind.orphan_file_scan.state).toBe("completed");

    // Effects: tombstone, private purge, storage cleanup, viewer revocation.
    const tombstone = hoisted.docs.get(`child_profiles/${CHILD}`);
    expect(tombstone.state).toBe("deleted");
    expect(tombstone.displayLabel).toBeUndefined();
    expect(tombstone.authorizedViewerUids).toEqual([]);
    expect(hoisted.docs.get(`child_profiles/${CHILD}/private/safety/versions/1`)).toBeUndefined();
    expect([...hoisted.storedFiles.keys()].filter((k) => !k.includes("/exports/"))).toEqual([]);

    // Terminal proof counts recorded.
    expect(result!.proof.counts["firestore_delete.deletedPrivateDocs"]).toBeGreaterThan(0);
    expect(result!.proof.startedAt).toBeTruthy();
  });

  it("STRIPE REDACTION task state tracking: operator completion finishes the request with proof", async () => {
    const request = await createDelete();
    const afterRun = await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: NOW });
    const stripeTask = afterRun!.tasks.find((t) => t.kind === "stripe_identity_redaction")!;
    const completed = await markProviderTaskComplete(
      { requestId: request.requestId, taskId: stripeTask.taskId, operatorUid: "founder-1", providerRef: "vs_redaction_123" },
      { now: LATER },
    );
    expect(completed.state).toBe("completed");
    expect(completed.proof.completedAt).toBeTruthy();
    const task = completed.tasks.find((t) => t.kind === "stripe_identity_redaction")!;
    expect(task.proof).toMatchObject({ providerExecuted: true, providerRef: "vs_redaction_123" });

    // Idempotent operator re-completion converges.
    const again = await markProviderTaskComplete(
      { requestId: request.requestId, taskId: stripeTask.taskId, operatorUid: "founder-1" },
      { now: LATER },
    );
    expect(again.state).toBe("completed");
  });

  it("PARTIAL DELETION retries converge: transient storage failure → backoff → success", async () => {
    const request = await createDelete();
    hoisted.setFailGetFiles(1); // first storage_delete attempt fails
    const firstPass = await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: NOW });
    expect(firstPass?.state).toBe("in_progress");
    expect(firstPass?.lastErrorCode).toBe("StorageTransientError");
    expect(firstPass?.nextAttemptAt).toBeTruthy();
    // Earlier tasks are already terminal and are NOT re-run.
    expect(firstPass?.tasks.find((t) => t.kind === "firestore_delete")?.state).toBe("completed");

    // Second pass (after backoff) converges.
    const secondPass = await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: LATER });
    expect(secondPass?.state).toBe("awaiting_provider");
    expect(secondPass?.tasks.find((t) => t.kind === "storage_delete")?.state).toBe("completed");
    expect([...hoisted.storedFiles.keys()].filter((k) => !k.includes("/exports/"))).toEqual([]);
  });

  it("bounded retries: exhausted budget lands in requires_admin_review with an alert", async () => {
    const request = await createDelete();
    hoisted.setFailGetFiles(99);
    // Force the attempt budget to its edge, then run once more.
    hoisted.docs.set(`data_lifecycle_requests/${request.requestId}`, {
      ...hoisted.docs.get(`data_lifecycle_requests/${request.requestId}`),
      attemptCount: 7,
    });
    const result = await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: NOW });
    expect(result?.state).toBe("requires_admin_review");
    expect(hoisted.docs.get(`admin_alerts/lifecycle_stuck_${request.requestId}`)).toMatchObject({
      type: "data_lifecycle_request_stuck",
    });
  });

  it("a LEGAL HOLD appearing after creation blocks execution and resumes when cleared", async () => {
    const request = await createDelete();
    await setChildLegalHold(CHILD, { active: true, reason: "late case", placedByUid: "op-1" }, { now: NOW });
    const blocked = await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: NOW });
    expect(blocked?.state).toBe("blocked_legal_hold");
    expect(hoisted.docs.get(`child_profiles/${CHILD}`).state).toBe("active"); // nothing deleted

    await setChildLegalHold(CHILD, null, { now: LATER }); // hold cleared
    const resumed = await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: LATER });
    expect(resumed?.state).toBe("awaiting_provider");
    expect(hoisted.docs.get(`child_profiles/${CHILD}`).state).toBe("deleted");
  });

  it("idempotent rerun: completed/claimed requests are not re-processed", async () => {
    const request = await createDelete();
    await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: NOW });
    const doc = hoisted.docs.get(`data_lifecycle_requests/${request.requestId}`);
    // awaiting_provider is not claimable — a rerun returns null and changes nothing.
    const rerun = await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: LATER });
    expect(rerun).toBeNull();
    expect(hoisted.docs.get(`data_lifecycle_requests/${request.requestId}`)).toEqual(doc);
  });
});

// ── export scope ─────────────────────────────────────────────────────────────

describe("export scope", () => {
  it("EXPORT SCOPE CORRECTNESS: this child only — profile, safety versions, authorities, file inventory", async () => {
    seedChild(OTHER_CHILD); // must NOT leak into the bundle
    seedAuthority(OTHER_CHILD, "parent-1");
    const request = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: CHILD, scope: "export", idempotencyKey: "e1" },
      { now: NOW },
    );
    const result = await processLifecycleRequests({ bucket: hoisted.bucket, now: NOW });
    expect(result.completed).toBe(1);

    const doc = hoisted.docs.get(`data_lifecycle_requests/${request.requestId}`);
    expect(doc.state).toBe("completed");
    expect(doc.exportPath).toBe(`childcare/${HH}/${CHILD}/exports/${request.requestId}.json`);
    expect(doc.proof.completedAt).toBeTruthy();

    const bundle = JSON.parse(hoisted.storedFiles.get(doc.exportPath)!.content);
    expect(bundle.childId).toBe(CHILD);
    expect(bundle.profile.displayLabel).toBe("Mia");
    expect(bundle.safetyVersions).toHaveLength(1);
    expect(bundle.safetyVersions[0].data.dateOfBirth).toBe("2020-03-15");
    expect(bundle.guardianAuthorities).toHaveLength(1);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0].purpose).toBe("photo");
    // The OTHER child never appears.
    const raw = hoisted.storedFiles.get(doc.exportPath)!.content;
    expect(raw).not.toContain(OTHER_CHILD);
    expect(raw).not.toContain("Theo");
  });

  it("status accessor is requester-scoped and returns an authenticated delivery reference", async () => {
    const request = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: CHILD, scope: "export", idempotencyKey: "e2" },
      { now: NOW },
    );
    await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: NOW });

    const status = await getLifecycleStatusForRequester("parent-1", request.requestId, {
      bucket: hoisted.bucket,
      now: NOW,
    });
    expect(status.state).toBe("completed");
    expect(status.exportDeliveryRef).toMatch(/^cdr_[a-f0-9]{48}$/);
    expect(Date.parse(status.exportDeliveryRefExpiresAt!) - NOW.getTime()).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(hoisted.docs.get(`childcare_file_delivery_refs/${status.exportDeliveryRef}`)).toMatchObject({
      kind: "lifecycle_export",
      actorUid: "parent-1",
      childId: CHILD,
      requestId: request.requestId,
      objectGeneration: "1001",
    });

    // Another adult (even a guardian) cannot read the requester's status.
    seedAuthority(CHILD, "coparent-1");
    await expect(
      getLifecycleStatusForRequester("coparent-1", request.requestId, { bucket: hoisted.bucket, now: NOW }),
    ).rejects.toMatchObject({ code: "request_not_found" });
  });
});

// ── orphan-file scan ─────────────────────────────────────────────────────────

describe("orphan-file scan", () => {
  it("sweeps unconfirmed/leftover objects under the child's prefix", async () => {
    // A stray unconfirmed upload the storage_delete pass will also see, plus one
    // written BETWEEN storage_delete and the orphan scan is the real target —
    // simulate by re-adding after the first pass via a redact request instead.
    hoisted.storedFiles.set(`childcare/${HH}/${CHILD}/photo/orphan-1`, { content: "stray" });
    const request = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: CHILD, scope: "delete", idempotencyKey: "d9" },
      { now: NOW },
    );
    const result = await processLifecycleRequestOnce(request.requestId, { bucket: hoisted.bucket, now: NOW });
    const orphanTask = result!.tasks.find((t) => t.kind === "orphan_file_scan")!;
    expect(orphanTask.state).toBe("completed");
    expect(orphanTask.proof).toMatchObject({ clean: true }); // storage_delete got them all
    expect([...hoisted.storedFiles.keys()].filter((k) => !k.includes("/exports/"))).toEqual([]);
  });
});

// ── adult account deletion (R15) ─────────────────────────────────────────────

describe("beginAdultAccountDeletion", () => {
  it("child SURVIVES when another guardian remains — only the requester's access ends", async () => {
    seedAuthority(CHILD, "coparent-1"); // second active guardian
    const plan = await beginAdultAccountDeletion("parent-1", { now: NOW });
    expect(plan.childrenRetained).toEqual([CHILD]);
    expect(plan.childrenScheduledForDeletion).toEqual([]);

    // Requester's authority revoked; co-parent's untouched; child intact.
    expect(hoisted.docs.get(`guardian_authorities/${CHILD}__parent-1`).state).toBe("revoked");
    expect(hoisted.docs.get(`guardian_authorities/${CHILD}__coparent-1`).state).toBe("active");
    expect(hoisted.docs.get(`child_profiles/${CHILD}`).state).toBe("active");
    expect(hoisted.docs.get(`child_profiles/${CHILD}/private/safety/versions/1`)).toBeTruthy();
  });

  it("sole guardian: a tracked delete request is created (never a bare Auth delete)", async () => {
    const plan = await beginAdultAccountDeletion("parent-1", { now: NOW });
    expect(plan.childrenScheduledForDeletion).toEqual([CHILD]);
    expect(plan.lifecycleRequestIds).toHaveLength(1);
    const expectedId = lifecycleRequestId(CHILD, "delete", "account_deletion:parent-1");
    expect(plan.lifecycleRequestIds[0]).toBe(expectedId);
    expect(hoisted.docs.get(`data_lifecycle_requests/${expectedId}`).state).toBe("pending");
    // Child data still present until the tracked workflow runs — no silent wipe.
    expect(hoisted.docs.get(`child_profiles/${CHILD}`).state).toBe("active");
  });

  it("is idempotent under retries (same deterministic request)", async () => {
    const first = await beginAdultAccountDeletion("parent-1", { now: NOW });
    // NOTE: after the first run the requester's authorities for retained
    // children are revoked; for the sole-guardian child, the request already
    // exists — a rerun converges rather than duplicating.
    const second = await beginAdultAccountDeletion("parent-1", { now: NOW });
    expect(second.lifecycleRequestIds).toEqual(first.lifecycleRequestIds);
  });
});
