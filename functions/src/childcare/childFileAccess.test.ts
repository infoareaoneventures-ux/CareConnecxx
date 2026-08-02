import { createHash } from "crypto";
import { Readable } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const objects = new Map<string, {
    bytes: Buffer;
    metadata: {
      size: string;
      contentType: string;
      generation: string;
      metadata: Record<string, string>;
    };
  }>();
  const signedUrlCalls: Array<Record<string, unknown>> = [];

  const makeDocRef = (docPath: string): any => ({
    id: docPath.split("/").pop(),
    path: docPath,
    get: async () => ({
      exists: docs.has(docPath),
      id: docPath.split("/").pop(),
      data: () => docs.get(docPath),
      ref: makeDocRef(docPath),
    }),
    set: async (data: any, options?: any) => {
      docs.set(docPath, options?.merge ? { ...(docs.get(docPath) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      docs.set(docPath, { ...(docs.get(docPath) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollection(`${docPath}/${sub}`),
  });
  const makeCollection = (collectionPath: string): any => ({
    doc: (id?: string) => makeDocRef(`${collectionPath}/${id ?? `auto-${docs.size}`}`),
    where: () => makeCollection(collectionPath),
    orderBy: () => makeCollection(collectionPath),
    limit: () => makeCollection(collectionPath),
    get: async () => ({ empty: true, size: 0, docs: [] }),
  });
  const runTransaction = async (handler: any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, options?: any) => {
        docs.set(ref.path, options?.merge ? { ...(docs.get(ref.path) ?? {}), ...data } : { ...data });
      },
      update: (ref: any, data: any) => {
        docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
      },
    };
    return handler(tx);
  };
  const bucket = {
    file: (objectPath: string) => ({
      getSignedUrl: async (options: Record<string, unknown>): Promise<[string]> => {
        signedUrlCalls.push({ path: objectPath, ...options });
        return [`https://upload.test/${objectPath}`];
      },
      // Tuple return types are annotated so the fake satisfies the production
      // StorageFileLike contract (Promise<[T]>) rather than Promise<T[]>.
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
      createReadStream: () => {
        const object = objects.get(objectPath);
        if (!object) throw new Error("not found");
        return Readable.from(object.bytes);
      },
      delete: async () => {
        objects.delete(objectPath);
      },
    }),
  };
  return {
    docs,
    objects,
    signedUrlCalls,
    makeCollection,
    runTransaction,
    bucket,
    reset() {
      docs.clear();
      objects.clear();
      signedUrlCalls.length = 0;
    },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (name: string) => hoisted.makeCollection(name),
    runTransaction: hoisted.runTransaction,
  });
  const storage: any = () => ({ bucket: () => hoisted.bucket });
  const auth: any = () => ({ verifyIdToken: vi.fn(async () => ({ uid: "parent-1" })) });
  return {
    __esModule: true,
    default: { firestore, storage, auth, apps: [{}] },
    firestore,
    storage,
    auth,
    apps: [{}],
  };
});

vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

import {
  CHILD_FILE_MAX_BYTES,
  authorizeChildFileDelivery,
  childFileStoragePrefix,
  confirmChildFileUpload,
  createChildFileDeliveryReference,
  mintChildFileUploadIntent,
  type ChildFileRecord,
  type StorageObjectMetadata,
} from "./childFileAccess";
import { GUARDIAN_SCOPES } from "./guardianAuthority";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const BYTES = Buffer.from("verified child file");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const CHILD = "child_abc";
const HOUSEHOLD = "hh_parent-1";
const VALID_INTENT = {
  actorUid: "parent-1",
  childId: CHILD,
  contentType: "image/jpeg",
  declaredBytes: BYTES.length,
  expectedSha256: SHA,
  purpose: "photo",
  idempotencyKey: "file-1",
};

function seedChild(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`child_profiles/${CHILD}`, {
    childId: CHILD,
    householdId: HOUSEHOLD,
    careVertical: "child",
    state: "active",
    accessVersion: 1,
    legalHold: null,
    ...overrides,
  });
}

function seedAuthority(uid: string, overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`guardian_authorities/${CHILD}__${uid}`, {
    authorityId: `${CHILD}__${uid}`,
    householdId: HOUSEHOLD,
    childId: CHILD,
    adultUid: uid,
    careVertical: "child",
    scopes: [...GUARDIAN_SCOPES],
    state: "active",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    expiresAt: null,
    accessVersion: 1,
    ...overrides,
  });
}

function storeUpload(
  record: ChildFileRecord,
  overrides: {
    bytes?: Buffer;
    contentType?: string;
    generation?: string;
    size?: string;
    metadata?: Record<string, string>;
  } = {},
) {
  const bytes = overrides.bytes ?? BYTES;
  hoisted.objects.set(record.path, {
    bytes,
    metadata: {
      size: overrides.size ?? String(bytes.length),
      contentType: overrides.contentType ?? record.contentType,
      generation: overrides.generation ?? "1001",
      metadata: overrides.metadata ?? {
        "upload-intent-id": record.fileId,
        "expected-sha256": record.expectedSha256,
      },
    },
  });
}

async function createIntent() {
  const result = await mintChildFileUploadIntent(VALID_INTENT, {
    bucket: hoisted.bucket,
    now: NOW,
  });
  const record = hoisted.docs.get(`child_profiles/${CHILD}/private/file_${result.fileId}`) as ChildFileRecord;
  return { result, record };
}

beforeEach(() => {
  hoisted.reset();
  seedChild();
  seedAuthority("parent-1");
});

describe("restricted delivery posture", () => {
  it("contains no signed read URL or permanent download token", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "childFileAccess.ts"), "utf8");
    expect(source).not.toMatch(/action:\s*["']read["']/);
    expect(source).not.toMatch(/getDownloadURL\s*\(/);
    expect(source).not.toMatch(/makePublic\s*\(/);
  });

  it("keeps objects under the dedicated childcare prefix", () => {
    expect(childFileStoragePrefix(HOUSEHOLD, CHILD)).toBe(`childcare/${HOUSEHOLD}/${CHILD}`);
  });
});

describe("single-use upload intent", () => {
  it("binds path, MIME type, checksum metadata, authority versions, and expiry", async () => {
    const { result, record } = await createIntent();
    expect(result.path).toBe(`childcare/${HOUSEHOLD}/${CHILD}/photo/${result.fileId}`);
    expect(record).toMatchObject({
      state: "intent",
      scanState: "none",
      expectedSha256: SHA,
      authorityAccessVersion: 1,
      profileAccessVersion: 1,
    });
    expect(hoisted.signedUrlCalls[0]).toMatchObject({
      action: "write",
      contentType: "image/jpeg",
      extensionHeaders: {
        "x-goog-meta-upload-intent-id": result.fileId,
        "x-goog-meta-expected-sha256": SHA,
        "x-goog-if-generation-match": "0",
      },
    });
  });

  it("rejects invalid type, size, and checksum", async () => {
    await expect(
      mintChildFileUploadIntent({ ...VALID_INTENT, contentType: "text/html" }, { bucket: hoisted.bucket, now: NOW }),
    ).rejects.toMatchObject({ code: "content_type_rejected" });
    await expect(
      mintChildFileUploadIntent(
        { ...VALID_INTENT, declaredBytes: CHILD_FILE_MAX_BYTES + 1 },
        { bucket: hoisted.bucket, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "size_rejected" });
    await expect(
      mintChildFileUploadIntent({ ...VALID_INTENT, expectedSha256: "bad" }, { bucket: hoisted.bucket, now: NOW }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("cannot reuse an idempotency key with changed metadata", async () => {
    await createIntent();
    await expect(
      mintChildFileUploadIntent(
        { ...VALID_INTENT, declaredBytes: BYTES.length + 1 },
        { bucket: hoisted.bucket, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "stale_grant" });
  });
});

describe("object verification and quarantine", () => {
  it("inspects actual metadata, generation, bytes, and checksum before quarantine", async () => {
    const { record } = await createIntent();
    storeUpload(record);
    const confirmed = await confirmChildFileUpload(
      { actorUid: "parent-1", childId: CHILD, fileId: record.fileId },
      { bucket: hoisted.bucket, now: NOW },
    );
    expect(confirmed).toMatchObject({
      state: "quarantined",
      scanState: "pending",
      objectGeneration: "1001",
      actualBytes: BYTES.length,
      verifiedSha256: SHA,
    });
  });

  it.each([
    ["missing object", () => undefined, "file_not_found"],
    ["MIME mismatch", (record: ChildFileRecord) => storeUpload(record, { contentType: "image/png" }), "metadata_mismatch"],
    ["size mismatch", (record: ChildFileRecord) => storeUpload(record, { size: String(BYTES.length + 1) }), "size_rejected"],
    ["checksum mismatch", (record: ChildFileRecord) => storeUpload(record, { bytes: Buffer.alloc(BYTES.length, 1) }), "checksum_mismatch"],
    ["intent metadata mismatch", (record: ChildFileRecord) => storeUpload(record, { metadata: {} }), "metadata_mismatch"],
  ])("rejects %s", async (_label, arrange, code) => {
    const { record } = await createIntent();
    arrange(record);
    await expect(
      confirmChildFileUpload(
        { actorUid: "parent-1", childId: CHILD, fileId: record.fileId },
        { bucket: hoisted.bucket, now: NOW },
      ),
    ).rejects.toMatchObject({ code });
  });

  it("denies confirmation after authority or profile access changes", async () => {
    const { record } = await createIntent();
    storeUpload(record);
    seedAuthority("parent-1", { accessVersion: 2 });
    await expect(
      confirmChildFileUpload(
        { actorUid: "parent-1", childId: CHILD, fileId: record.fileId },
        { bucket: hoisted.bucket, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "stale_grant" });
  });
});

describe("revocable authenticated delivery", () => {
  async function seedCleanFile(): Promise<ChildFileRecord> {
    const { record } = await createIntent();
    storeUpload(record);
    const quarantined = await confirmChildFileUpload(
      { actorUid: "parent-1", childId: CHILD, fileId: record.fileId },
      { bucket: hoisted.bucket, now: NOW },
    );
    const clean: ChildFileRecord = {
      ...quarantined,
      state: "clean",
      scanState: "clean",
      readableAt: NOW.toISOString(),
    };
    hoisted.docs.set(`child_profiles/${CHILD}/private/file_${record.fileId}`, clean);
    return clean;
  }

  it("only creates references for verified-clean matching generations", async () => {
    const clean = await seedCleanFile();
    const route = await createChildFileDeliveryReference(
      { actorUid: "parent-1", childId: CHILD, fileId: clean.fileId, idempotencyKey: "view-1" },
      { now: NOW },
    );
    expect(route.deliveryRef).toMatch(/^cdr_[a-f0-9]{48}$/);
    await expect(authorizeChildFileDelivery("parent-1", route.deliveryRef, { now: NOW })).resolves.toMatchObject({
      path: clean.path,
      generation: "1001",
    });
  });

  it("a reference minted before revocation fails immediately after revocation", async () => {
    const clean = await seedCleanFile();
    const route = await createChildFileDeliveryReference(
      { actorUid: "parent-1", childId: CHILD, fileId: clean.fileId, idempotencyKey: "view-2" },
      { now: NOW },
    );
    seedAuthority("parent-1", { state: "revoked", accessVersion: 2 });
    await expect(authorizeChildFileDelivery("parent-1", route.deliveryRef, { now: NOW })).rejects.toMatchObject({
      code: "not_authorized",
    });
  });

  it("pending, rejected, and generation-overwritten files never receive a route", async () => {
    const { record } = await createIntent();
    await expect(
      createChildFileDeliveryReference(
        { actorUid: "parent-1", childId: CHILD, fileId: record.fileId, idempotencyKey: "pending" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "file_not_clean" });

    const clean = await seedCleanFile();
    const route = await createChildFileDeliveryReference(
      { actorUid: "parent-1", childId: CHILD, fileId: clean.fileId, idempotencyKey: "stale-generation" },
      { now: NOW },
    );
    hoisted.docs.set(`child_profiles/${CHILD}/private/file_${clean.fileId}`, {
      ...clean,
      objectGeneration: "1002",
    });
    await expect(authorizeChildFileDelivery("parent-1", route.deliveryRef, { now: NOW })).rejects.toMatchObject({
      code: "file_not_clean",
    });
  });

  it("rechecks provider assignment for every delivery request", async () => {
    const clean = await seedCleanFile();
    const eligible = {
      isAssignedProviderEligible: vi.fn(async () => ({ eligible: true, bookingId: "b1", reason: "assigned" })),
    };
    const route = await createChildFileDeliveryReference(
      { actorUid: "caregiver-1", childId: CHILD, fileId: clean.fileId, idempotencyKey: "provider" },
      { now: NOW, providerEligibility: eligible },
    );
    const replaced = {
      isAssignedProviderEligible: vi.fn(async () => ({ eligible: false, bookingId: null, reason: "replaced" })),
    };
    await expect(
      authorizeChildFileDelivery("caregiver-1", route.deliveryRef, {
        now: NOW,
        providerEligibility: replaced,
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });
});
