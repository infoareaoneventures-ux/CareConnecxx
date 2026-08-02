import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const objects = new Map<string, any>();
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
  const makeCollection = (collectionPath: string): any => ({
    doc: (id: string) => makeDoc(`${collectionPath}/${id}`),
  });
  const runTransaction = async (handler: any) =>
    handler({
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any) => docs.set(ref.path, { ...data }),
    });
  const bucket = {
    file: (objectPath: string) => ({
      // Tuple return types are annotated so the fake satisfies the production
      // bucket contract (Promise<[T]>) rather than Promise<T[]>.
      getMetadata: async (): Promise<[StorageObjectMetadata]> => {
        const object = objects.get(objectPath);
        if (!object) throw new Error("not found");
        return [object.metadata];
      },
      download: async (): Promise<[Buffer]> => {
        const object = objects.get(objectPath);
        if (!object) throw new Error("not found");
        return [object.bytes];
      },
    }),
  };
  return {
    docs,
    objects,
    makeCollection,
    runTransaction,
    bucket,
    reset() {
      docs.clear();
      objects.clear();
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
vi.mock("firebase-functions/v2/storage", () => ({
  onObjectFinalized: (_options: unknown, handler: unknown) => handler,
  onMessagePublished: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

import {
  dispatchChildFileScan,
  parseChildFileObjectPath,
} from "./childFileScan";
import type { ChildFileScanRequest } from "./childFileScan";
import type { StorageObjectMetadata } from "./childFileAccess";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const BYTES = Buffer.from("scan fixture");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const CHILD = "child_1";
const FILE = `cf_${"a".repeat(40)}`;
const PATH = `childcare/hh_1/${CHILD}/photo/${FILE}`;
const RECORD_PATH = `child_profiles/${CHILD}/private/file_${FILE}`;

function seedIntent() {
  hoisted.docs.set(`child_profiles/${CHILD}`, {
    childId: CHILD,
    householdId: "hh_1",
    careVertical: "child",
    state: "active",
    accessVersion: 1,
    legalHold: null,
  });
  hoisted.docs.set(`guardian_authorities/${CHILD}__parent-1`, {
    authorityId: `${CHILD}__parent-1`,
    householdId: "hh_1",
    childId: CHILD,
    adultUid: "parent-1",
    careVertical: "child",
    scopes: ["view", "management"],
    state: "active",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    expiresAt: null,
    accessVersion: 1,
  });
  hoisted.docs.set(RECORD_PATH, {
    fileId: FILE,
    childId: CHILD,
    householdId: "hh_1",
    path: PATH,
    contentType: "image/jpeg",
    declaredBytes: BYTES.length,
    expectedSha256: SHA,
    purpose: "photo",
    state: "intent",
    scanState: "none",
    createdByUid: "parent-1",
    authorityAccessVersion: 1,
    profileAccessVersion: 1,
    uploadIntentExpiresAt: "2026-07-25T12:10:00.000Z",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  hoisted.objects.set(PATH, {
    bytes: BYTES,
    metadata: {
      size: String(BYTES.length),
      contentType: "image/jpeg",
      generation: "1001",
      metadata: {
        "upload-intent-id": FILE,
        "expected-sha256": SHA,
      },
    },
  });
}

beforeEach(() => {
  hoisted.reset();
  seedIntent();
});

describe("parseChildFileObjectPath", () => {
  it("accepts only immutable restricted upload paths", () => {
    expect(parseChildFileObjectPath(PATH)).toEqual({
      householdId: "hh_1",
      childId: CHILD,
      purpose: "photo",
      fileId: FILE,
    });
    expect(parseChildFileObjectPath(`childcare/hh_1/${CHILD}/exports/export.json`)).toBeNull();
    expect(parseChildFileObjectPath("caregivers/u/document")).toBeNull();
  });
});

describe("dispatchChildFileScan", () => {
  it("verifies, quarantines, creates one operation, and publishes one immutable request", async () => {
    // Typed param so `publish.mock.calls[0][0]` is the published request.
    const publish = vi.fn(async (_request: ChildFileScanRequest) => "message-1");
    const result = await dispatchChildFileScan(
      { name: PATH, generation: "1001" },
      { bucket: hoisted.bucket, publisher: { publish }, now: NOW },
    );
    expect(result.status).toBe("dispatched");
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toMatchObject({
      schemaVersion: 1,
      fileId: FILE,
      path: PATH,
      objectGeneration: "1001",
      sha256: SHA,
      attempt: 1,
    });
    expect(hoisted.docs.get(RECORD_PATH)).toMatchObject({
      state: "scanning",
      scanState: "scanning",
      objectGeneration: "1001",
    });
    expect(hoisted.docs.get(`childcare_file_scan_operations/${result.operationId}`)).toMatchObject({
      state: "dispatched",
      publishedMessageId: "message-1",
    });
  });

  it("deduplicates repeated finalize events", async () => {
    const publish = vi.fn(async () => "message-1");
    await dispatchChildFileScan(
      { name: PATH, generation: "1001" },
      { bucket: hoisted.bucket, publisher: { publish }, now: NOW },
    );
    const duplicate = await dispatchChildFileScan(
      { name: PATH, generation: "1001" },
      { bucket: hoisted.bucket, publisher: { publish }, now: NOW },
    );
    expect(duplicate.status).toBe("duplicate");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("rejects metadata or checksum drift without publishing", async () => {
    hoisted.objects.get(PATH).metadata.contentType = "image/png";
    const publish = vi.fn(async () => "never");
    const result = await dispatchChildFileScan(
      { name: PATH, generation: "1001" },
      { bucket: hoisted.bucket, publisher: { publish }, now: NOW },
    );
    expect(result.status).toBe("rejected");
    expect(publish).not.toHaveBeenCalled();
    expect(hoisted.docs.get(RECORD_PATH)).toMatchObject({
      state: "rejected",
      scanReasonCode: "metadata_mismatch",
    });
  });

  it("rejects finalize delivery after uploader authority revocation", async () => {
    hoisted.docs.set(`guardian_authorities/${CHILD}__parent-1`, {
      ...hoisted.docs.get(`guardian_authorities/${CHILD}__parent-1`),
      state: "revoked",
      accessVersion: 2,
    });
    const publish = vi.fn(async () => "never");
    const result = await dispatchChildFileScan(
      { name: PATH, generation: "1001" },
      { bucket: hoisted.bucket, publisher: { publish }, now: NOW },
    );
    expect(result.status).toBe("rejected");
    expect(publish).not.toHaveBeenCalled();
    expect(hoisted.docs.get(RECORD_PATH)).toMatchObject({
      state: "rejected",
      scanReasonCode: "not_authorized",
    });
  });

  it("ignores stale generation events", async () => {
    const publish = vi.fn(async () => "never");
    const result = await dispatchChildFileScan(
      { name: PATH, generation: "999" },
      { bucket: hoisted.bucket, publisher: { publish }, now: NOW },
    );
    expect(result.status).toBe("ignored");
    expect(publish).not.toHaveBeenCalled();
  });
});
