import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const deletedObjects: Array<{ path: string; options: Record<string, unknown> }> = [];
  const makeDoc = (docPath: string): any => ({
    id: docPath.split("/").pop(),
    path: docPath,
    get: async () => ({
      exists: docs.has(docPath),
      data: () => docs.get(docPath),
      ref: makeDoc(docPath),
    }),
    set: async (data: any) => docs.set(docPath, { ...data }),
    collection: (sub: string) => makeCollection(`${docPath}/${sub}`),
  });
  const matches = (data: any, field: string, op: string, value: any) => {
    if (op === "in") return Array.isArray(value) && value.includes(data?.[field]);
    if (op === "<=") return String(data?.[field] ?? "") <= String(value);
    return false;
  };
  const makeCollection = (
    collectionPath: string,
    filters: Array<{ field: string; op: string; value: any }> = [],
    rowLimit?: number,
  ): any => ({
    doc: (id: string) => makeDoc(`${collectionPath}/${id}`),
    where: (field: string, op: string, value: any) =>
      makeCollection(collectionPath, [...filters, { field, op, value }], rowLimit),
    orderBy: () => makeCollection(collectionPath, filters, rowLimit),
    limit: (value: number) => makeCollection(collectionPath, filters, value),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(([docPath]) =>
          docPath.startsWith(`${collectionPath}/`) &&
          docPath.split("/").length === collectionPath.split("/").length + 1)
        .map(([docPath, data]) => ({
          id: docPath.split("/").pop(),
          data: () => data,
          ref: makeDoc(docPath),
          raw: data,
        }))
        .filter((row) => filters.every((filter) =>
          matches(row.raw, filter.field, filter.op, filter.value)));
      if (rowLimit !== undefined) rows = rows.slice(0, rowLimit);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });
  const runTransaction = async (handler: any) =>
    handler({
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any) => docs.set(ref.path, { ...data }),
    });
  return {
    docs,
    deletedObjects,
    bucket: {
      file: (objectPath: string) => ({
        delete: async (options: Record<string, unknown> = {}) => {
          deletedObjects.push({ path: objectPath, options });
        },
      }),
    },
    makeCollection,
    runTransaction,
    reset() {
      docs.clear();
      deletedObjects.length = 0;
    },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (name: string) => hoisted.makeCollection(name),
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
vi.mock("firebase-functions/v2/pubsub", () => ({
  onMessagePublished: (_options: unknown, handler: unknown) => handler,
  onObjectFinalized: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

import {
  cleanupExpiredChildFileQuarantine,
  consumeChildFileScanResult,
  reconcileTimedOutChildFileScans,
  signScanResult,
  type ChildFileScanResult,
} from "./childFileScanResult";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const SECRET = "test-secret";
const IMAGE = `sha256:${"a".repeat(64)}`;
const OPERATION = `cfs_${"b".repeat(48)}`;
const FILE = `cf_${"c".repeat(40)}`;
const CHILD = "child_1";
const PATH = `childcare/hh_1/${CHILD}/photo/${FILE}`;
const SHA = "d".repeat(64);

function seedOperation() {
  hoisted.docs.set(`child_profiles/${CHILD}`, {
    childId: CHILD,
    householdId: "hh_1",
    careVertical: "child",
    state: "active",
    accessVersion: 1,
    legalHold: null,
  });
  hoisted.docs.set(`childcare_file_scan_operations/${OPERATION}`, {
    operationId: OPERATION,
    fileId: FILE,
    childId: CHILD,
    householdId: "hh_1",
    path: PATH,
    objectGeneration: "1001",
    sha256: SHA,
    contentType: "image/jpeg",
    size: 10,
    state: "dispatched",
    attempt: 1,
    maxAttempts: 3,
    deadlineAt: "2026-07-25T12:10:00.000Z",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  hoisted.docs.set(`child_profiles/${CHILD}/private/file_${FILE}`, {
    fileId: FILE,
    childId: CHILD,
    householdId: "hh_1",
    path: PATH,
    contentType: "image/jpeg",
    declaredBytes: 10,
    expectedSha256: SHA,
    purpose: "photo",
    state: "scanning",
    scanState: "scanning",
    createdByUid: "parent-1",
    authorityAccessVersion: 1,
    profileAccessVersion: 1,
    uploadIntentExpiresAt: "2026-07-25T12:10:00.000Z",
    objectGeneration: "1001",
    verifiedSha256: SHA,
    scanOperationId: OPERATION,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
}

function signedResult(
  overrides: Partial<Omit<ChildFileScanResult, "signature">> = {},
): ChildFileScanResult {
  const payload: Omit<ChildFileScanResult, "signature"> = {
    schemaVersion: 1,
    operationId: OPERATION,
    fileId: FILE,
    path: PATH,
    objectGeneration: "1001",
    sha256: SHA,
    result: "clean",
    reasonCode: "clamav_clean",
    engineVersion: "ClamAV 1.4.3",
    signatureVersion: "27888",
    signatureUpdatedAt: "2026-07-25T11:30:00.000Z",
    imageDigest: IMAGE,
    attempt: 1,
    scannedAt: NOW.toISOString(),
    ...overrides,
  };
  return { ...payload, signature: signScanResult(payload, SECRET) };
}

beforeEach(() => {
  hoisted.reset();
  seedOperation();
});

describe("consumeChildFileScanResult", () => {
  it("makes a file readable only for an exact signed clean result", async () => {
    const outcome = await consumeChildFileScanResult(signedResult(), {
      now: NOW,
      hmacSecret: SECRET,
      expectedImageDigest: IMAGE,
    });
    expect(outcome).toEqual({ status: "applied", state: "clean" });
    expect(hoisted.docs.get(`child_profiles/${CHILD}/private/file_${FILE}`)).toMatchObject({
      state: "clean",
      scanState: "clean",
      scanEngineVersion: "ClamAV 1.4.3",
      scanSignatureVersion: "27888",
      scanImageDigest: IMAGE,
      readableAt: NOW.toISOString(),
    });
  });

  it("quarantines malicious and engine-error results", async () => {
    const malicious = signedResult({ result: "malicious", reasonCode: "malware_detected" });
    await expect(
      consumeChildFileScanResult(malicious, {
        now: NOW,
        hmacSecret: SECRET,
        expectedImageDigest: IMAGE,
      }),
    ).resolves.toMatchObject({ state: "rejected" });
    expect(hoisted.docs.get(`child_profiles/${CHILD}/private/file_${FILE}`)).toMatchObject({
      state: "rejected",
      readableAt: null,
    });

    hoisted.reset();
    seedOperation();
    const error = signedResult({ result: "error", reasonCode: "scanner_engine_error" });
    await expect(
      consumeChildFileScanResult(error, {
        now: NOW,
        hmacSecret: SECRET,
        expectedImageDigest: IMAGE,
      }),
    ).resolves.toMatchObject({ state: "error" });
    expect(hoisted.docs.get(`child_profiles/${CHILD}/private/file_${FILE}`)).toMatchObject({
      state: "error",
      scanState: "error",
    });
  });

  it("rejects forged, stale-generation, stale-signature, and unapproved-image results", async () => {
    await expect(
      consumeChildFileScanResult(
        { ...signedResult(), signature: "0".repeat(64) },
        { now: NOW, hmacSecret: SECRET, expectedImageDigest: IMAGE },
      ),
    ).rejects.toThrow("invalid_result_signature");
    await expect(
      consumeChildFileScanResult(
        signedResult({ objectGeneration: "999" }),
        { now: NOW, hmacSecret: SECRET, expectedImageDigest: IMAGE },
      ),
    ).rejects.toThrow("scan_result_binding_mismatch");
    await expect(
      consumeChildFileScanResult(
        signedResult({ signatureUpdatedAt: "2026-07-23T10:00:00.000Z" }),
        { now: NOW, hmacSecret: SECRET, expectedImageDigest: IMAGE },
      ),
    ).rejects.toThrow("stale_scanner_signatures");
    await expect(
      consumeChildFileScanResult(
        signedResult(),
        { now: NOW, hmacSecret: SECRET, expectedImageDigest: `sha256:${"e".repeat(64)}` },
      ),
    ).rejects.toThrow("unapproved_scanner_image");
  });

  it("is idempotent after a terminal result", async () => {
    const result = signedResult();
    await consumeChildFileScanResult(result, {
      now: NOW,
      hmacSecret: SECRET,
      expectedImageDigest: IMAGE,
    });
    await expect(
      consumeChildFileScanResult(result, {
        now: NOW,
        hmacSecret: SECRET,
        expectedImageDigest: IMAGE,
      }),
    ).resolves.toEqual({ status: "duplicate", state: "clean" });
  });
});

describe("scan reconciliation", () => {
  it("retries timed-out work with a new bounded attempt and deadline", async () => {
    hoisted.docs.set(`childcare_file_scan_operations/${OPERATION}`, {
      ...hoisted.docs.get(`childcare_file_scan_operations/${OPERATION}`),
      deadlineAt: "2026-07-25T11:59:00.000Z",
    });
    const publish = vi.fn(async () => "message-2");
    const result = await reconcileTimedOutChildFileScans({
      now: NOW,
      publisher: { publish },
    });
    expect(result).toEqual({ examined: 1, retried: 1, exhausted: 0 });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2 }));
    expect(hoisted.docs.get(`childcare_file_scan_operations/${OPERATION}`)).toMatchObject({
      state: "dispatched",
      attempt: 2,
      publishedMessageId: "message-2",
    });
    expect(hoisted.docs.get(`child_profiles/${CHILD}/private/file_${FILE}`)).toMatchObject({
      state: "scanning",
      scanAttemptCount: 2,
    });
  });

  it("fails closed and alerts after the third timed-out attempt", async () => {
    hoisted.docs.set(`childcare_file_scan_operations/${OPERATION}`, {
      ...hoisted.docs.get(`childcare_file_scan_operations/${OPERATION}`),
      attempt: 3,
      deadlineAt: "2026-07-25T11:59:00.000Z",
    });
    const result = await reconcileTimedOutChildFileScans({ now: NOW });
    expect(result).toEqual({ examined: 1, retried: 0, exhausted: 1 });
    expect(hoisted.docs.get(`childcare_file_scan_operations/${OPERATION}`)).toMatchObject({
      state: "error",
      terminalAt: NOW.toISOString(),
      lastReasonCode: "retry_exhausted",
    });
    expect(hoisted.docs.get(`admin_alerts/child_file_scan_exhausted_${OPERATION}`)).toMatchObject({
      severity: "high",
      resolved: false,
    });
  });

  it("deletes old quarantine by exact generation but preserves legal holds", async () => {
    const old = "2026-07-17T11:00:00.000Z";
    hoisted.docs.set(`childcare_file_scan_operations/${OPERATION}`, {
      ...hoisted.docs.get(`childcare_file_scan_operations/${OPERATION}`),
      state: "rejected",
      createdAt: old,
    });
    await expect(
      cleanupExpiredChildFileQuarantine({ now: NOW, bucket: hoisted.bucket }),
    ).resolves.toEqual({ examined: 1, deleted: 1, legalHoldSkipped: 0 });
    expect(hoisted.deletedObjects).toEqual([{
      path: PATH,
      options: { ignoreNotFound: true, ifGenerationMatch: "1001" },
    }]);
    expect(hoisted.docs.get(`child_profiles/${CHILD}/private/file_${FILE}`)).toMatchObject({
      state: "deleted",
      deletedAt: NOW.toISOString(),
    });

    hoisted.reset();
    seedOperation();
    hoisted.docs.set(`child_profiles/${CHILD}`, {
      ...hoisted.docs.get(`child_profiles/${CHILD}`),
      legalHold: { active: true },
    });
    hoisted.docs.set(`childcare_file_scan_operations/${OPERATION}`, {
      ...hoisted.docs.get(`childcare_file_scan_operations/${OPERATION}`),
      state: "rejected",
      createdAt: old,
    });
    await expect(
      cleanupExpiredChildFileQuarantine({ now: NOW, bucket: hoisted.bucket }),
    ).resolves.toEqual({ examined: 1, deleted: 0, legalHoldSkipped: 1 });
    expect(hoisted.deletedObjects).toHaveLength(0);
  });
});
