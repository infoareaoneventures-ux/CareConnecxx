// Restricted child-file ingress and delivery.
//
// Browser Storage access is denied. Uploads use a single-use, metadata-bound
// write intent. Reads are streamed through an authenticated endpoint that
// rechecks authority and file state on every request; delivery references are
// routing identifiers, not bearer credentials.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { createHash } from "crypto";
import type { Readable } from "stream";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import { checkAuthority } from "./guardianAuthority";
import {
  CHILD_PROFILES_COLLECTION,
  CHILD_PRIVATE_SUBCOLLECTION,
  CHILD_FILE_RECORD_DOC_PREFIX,
  getChildProfile,
  ChildProfileError,
} from "../data/childProfileRepository";

export const CHILDCARE_STORAGE_ROOT = "childcare";
export const CHILD_FILE_DELIVERIES_COLLECTION = "childcare_file_delivery_refs";
export const DATA_LIFECYCLE_REQUESTS_COLLECTION = "data_lifecycle_requests";

export const CHILD_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CHILD_FILE_UPLOAD_URL_TTL_MS = 10 * 60 * 1000;
export const CHILD_FILE_DELIVERY_REF_TTL_MS = 10 * 60 * 1000;

export const CHILD_FILE_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export const CHILD_FILE_PURPOSES = [
  "safety_document",
  "care_document",
  "photo",
] as const;

export type ChildFilePurpose = (typeof CHILD_FILE_PURPOSES)[number];
export type ChildFileState =
  | "intent"
  | "quarantined"
  | "scanning"
  | "clean"
  | "rejected"
  | "error"
  | "deleted";
export type ChildFileScanState = "none" | "pending" | "scanning" | "clean" | "rejected" | "error";

export interface ChildFileRecord {
  fileId: string;
  childId: string;
  householdId: string;
  path: string;
  contentType: string;
  declaredBytes: number;
  expectedSha256: string;
  purpose: ChildFilePurpose;
  state: ChildFileState;
  scanState: ChildFileScanState;
  createdByUid: string;
  authorityAccessVersion: number;
  profileAccessVersion: number;
  uploadIntentExpiresAt: string;
  objectGeneration?: string | null;
  actualBytes?: number | null;
  verifiedSha256?: string | null;
  scanOperationId?: string | null;
  scanAttemptCount?: number;
  scanEngineVersion?: string | null;
  scanSignatureVersion?: string | null;
  scanImageDigest?: string | null;
  scanReasonCode?: string | null;
  scanDeadlineAt?: string | null;
  uploadedAt?: string | null;
  verifiedAt?: string | null;
  readableAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssignedProviderEligibilitySource {
  isAssignedProviderEligible(
    providerUid: string,
    childId: string,
  ): Promise<{ eligible: boolean; bookingId?: string | null; reason: string }>;
}

export const darkProviderEligibility: AssignedProviderEligibilitySource = {
  async isAssignedProviderEligible() {
    return {
      eligible: false,
      bookingId: null,
      reason: "provider_grants_dark_until_booking_integration",
    };
  },
};

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

export interface StorageObjectMetadata {
  size?: string | number;
  contentType?: string;
  generation?: string | number;
  metadata?: Record<string, string | undefined>;
}

interface StorageFileLike {
  getSignedUrl(opts: Record<string, unknown>): Promise<[string]>;
  getMetadata(): Promise<[StorageObjectMetadata]>;
  download(opts?: Record<string, unknown>): Promise<[Buffer]>;
  createReadStream(opts?: Record<string, unknown>): Readable;
  delete(opts?: Record<string, unknown>): Promise<unknown>;
}

interface BucketLike {
  file(path: string): StorageFileLike;
}

interface FileDeliveryRef {
  deliveryRef: string;
  kind: "child_file" | "lifecycle_export";
  actorUid: string;
  childId: string;
  fileId?: string | null;
  requestId?: string | null;
  path: string;
  objectGeneration?: string | null;
  contentType: string;
  expiresAt: string;
  createdAt: string;
}

function defaultDb(): Db {
  return admin.firestore();
}

function defaultBucket(): BucketLike {
  return admin.storage().bucket() as unknown as BucketLike;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

export function childFileStoragePrefix(householdId: string, childId: string): string {
  return `${CHILDCARE_STORAGE_ROOT}/${householdId}/${childId}`;
}

export function childFileId(childId: string, idempotencyKey: string): string {
  return `cf_${createHash("sha256").update(`${childId}:${idempotencyKey}`).digest("hex").slice(0, 40)}`;
}

export function childFileScanOperationId(fileId: string, generation: string): string {
  return `cfs_${createHash("sha256").update(`${fileId}:${generation}`).digest("hex").slice(0, 48)}`;
}

function deliveryRefId(kind: FileDeliveryRef["kind"], actorUid: string, objectId: string, nonce: string): string {
  return `cdr_${createHash("sha256")
    .update(`${kind}:${actorUid}:${objectId}:${nonce}`)
    .digest("hex")
    .slice(0, 48)}`;
}

function normalizeSha256(value: unknown): string {
  const checksum = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new ChildFileError("invalid_input", "A SHA-256 checksum is required.");
  return checksum;
}

export function fileRecordRef(db: Db, childId: string, fileId: string) {
  return db
    .collection(CHILD_PROFILES_COLLECTION)
    .doc(childId)
    .collection(CHILD_PRIVATE_SUBCOLLECTION)
    .doc(`${CHILD_FILE_RECORD_DOC_PREFIX}${fileId}`);
}

async function defaultAssignedProviderEligibility(db: Db): Promise<AssignedProviderEligibilitySource> {
  try {
    const { createBookingAssignedProviderSource } = await import("./safetyProjection");
    return createBookingAssignedProviderSource({ db: db as never });
  } catch (err) {
    console.error(
      "[childFileAccess] booking provider source unavailable; denying provider access:",
      err instanceof Error ? err.message : err,
    );
    return darkProviderEligibility;
  }
}

export type ChildFileErrorCode =
  | "invalid_input"
  | "not_authorized"
  | "content_type_rejected"
  | "size_rejected"
  | "checksum_mismatch"
  | "metadata_mismatch"
  | "generation_overwrite"
  | "intent_expired"
  | "file_not_found"
  | "stale_grant"
  | "file_not_clean";

export class ChildFileError extends Error {
  code: ChildFileErrorCode;
  constructor(code: ChildFileErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ChildFileError";
    this.code = code;
  }
}

export interface MintUploadIntentParams {
  actorUid: string;
  childId: string;
  contentType: string;
  declaredBytes: number;
  expectedSha256: string;
  purpose: string;
  idempotencyKey: string;
}

export interface UploadIntentResult {
  fileId: string;
  path: string;
  uploadUrl: string;
  expiresAt: string;
  requiredMetadata: {
    uploadIntentId: string;
    expectedSha256: string;
  };
}

export async function mintChildFileUploadIntent(
  params: MintUploadIntentParams,
  opts: { db?: Db; bucket?: BucketLike; now?: Date } = {},
): Promise<UploadIntentResult> {
  const db = opts.db ?? defaultDb();
  const bucket = opts.bucket ?? defaultBucket();
  const now = opts.now ?? new Date();
  const actorUid = String(params.actorUid ?? "").trim();
  const childId = String(params.childId ?? "").trim();
  const idempotencyKey = String(params.idempotencyKey ?? "").trim();
  const contentType = String(params.contentType ?? "").trim().toLowerCase();
  const purpose = String(params.purpose ?? "").trim();
  const declaredBytes = Number(params.declaredBytes);
  const expectedSha256 = normalizeSha256(params.expectedSha256);

  if (!actorUid || !childId || !idempotencyKey || idempotencyKey.length > 128) {
    throw new ChildFileError("invalid_input");
  }
  if (!(CHILD_FILE_ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw new ChildFileError("content_type_rejected", `Content type "${contentType}" is not allowed.`);
  }
  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0 || declaredBytes > CHILD_FILE_MAX_BYTES) {
    throw new ChildFileError("size_rejected", `Declared size must be 1..${CHILD_FILE_MAX_BYTES} bytes.`);
  }
  if (!(CHILD_FILE_PURPOSES as readonly string[]).includes(purpose)) {
    throw new ChildFileError("invalid_input", "Unknown file purpose.");
  }

  const decision = await checkAuthority(actorUid, childId, "management", { db, now });
  if (!decision.allowed || decision.accessVersion === null) throw new ChildFileError("not_authorized");
  const profile = await getChildProfile(childId, db);
  if (!profile || profile.state === "deleted" || profile.legalHold?.active) {
    throw new ChildFileError("not_authorized");
  }

  const fileId = childFileId(childId, idempotencyKey);
  const path = `${childFileStoragePrefix(profile.householdId, childId)}/${purpose}/${fileId}`;
  const expires = new Date(now.getTime() + CHILD_FILE_UPLOAD_URL_TTL_MS);
  const ts = nowIso(now);
  const ref = fileRecordRef(db, childId, fileId);
  const existing = await ref.get();

  if (existing.exists) {
    const prior = (existing.data() ?? {}) as ChildFileRecord;
    const sameIntent =
      prior.createdByUid === actorUid &&
      prior.contentType === contentType &&
      prior.declaredBytes === declaredBytes &&
      prior.expectedSha256 === expectedSha256 &&
      prior.purpose === purpose;
    if (!sameIntent || prior.state !== "intent" || Date.parse(prior.uploadIntentExpiresAt) <= now.getTime()) {
      throw new ChildFileError("stale_grant", "This upload intent cannot be reused.");
    }
  } else {
    const record: ChildFileRecord = {
      fileId,
      childId,
      householdId: profile.householdId,
      path,
      contentType,
      declaredBytes,
      expectedSha256,
      purpose: purpose as ChildFilePurpose,
      state: "intent",
      scanState: "none",
      createdByUid: actorUid,
      authorityAccessVersion: decision.accessVersion,
      profileAccessVersion: Number(profile.accessVersion ?? 0),
      uploadIntentExpiresAt: expires.toISOString(),
      objectGeneration: null,
      actualBytes: null,
      verifiedSha256: null,
      scanOperationId: null,
      scanAttemptCount: 0,
      uploadedAt: null,
      verifiedAt: null,
      readableAt: null,
      deletedAt: null,
      createdAt: ts,
      updatedAt: ts,
    };
    await ref.set(record);
  }

  const extensionHeaders = {
    "x-goog-meta-upload-intent-id": fileId,
    "x-goog-meta-expected-sha256": expectedSha256,
    "x-goog-if-generation-match": "0",
  };
  const [uploadUrl] = await bucket.file(path).getSignedUrl({
    version: "v4",
    action: "write",
    expires,
    contentType,
    extensionHeaders,
  });

  await logAudit({
    eventType: "child_file_upload_intent",
    userId: actorUid,
    data: { childId, fileId, purpose, contentType, declaredBytes },
  }).catch(() => {});

  return {
    fileId,
    path,
    uploadUrl,
    expiresAt: expires.toISOString(),
    requiredMetadata: { uploadIntentId: fileId, expectedSha256 },
  };
}

export interface VerifiedStorageObject {
  generation: string;
  contentType: string;
  size: number;
  sha256: string;
}

export async function verifyStoredChildFileObject(
  record: ChildFileRecord,
  opts: { bucket?: BucketLike; now?: Date } = {},
): Promise<VerifiedStorageObject> {
  const bucket = opts.bucket ?? defaultBucket();
  const now = opts.now ?? new Date();
  if (Date.parse(record.uploadIntentExpiresAt) <= now.getTime()) {
    throw new ChildFileError("intent_expired");
  }

  let metadata: StorageObjectMetadata;
  let bytes: Buffer;
  try {
    [metadata] = await bucket.file(record.path).getMetadata();
    [bytes] = await bucket.file(record.path).download({ validation: "crc32c" });
  } catch {
    throw new ChildFileError("file_not_found");
  }

  const generation = String(metadata.generation ?? "").trim();
  const contentType = String(metadata.contentType ?? "").trim().toLowerCase();
  const size = Number(metadata.size);
  const custom = metadata.metadata ?? {};
  if (!generation) throw new ChildFileError("metadata_mismatch", "Object generation is missing.");
  if (contentType !== record.contentType) throw new ChildFileError("metadata_mismatch", "Stored MIME type differs from the intent.");
  if (!Number.isFinite(size) || size !== record.declaredBytes || bytes.length !== record.declaredBytes) {
    throw new ChildFileError("size_rejected", "Stored size differs from the intent.");
  }
  if (
    custom["upload-intent-id"] !== record.fileId ||
    String(custom["expected-sha256"] ?? "").toLowerCase() !== record.expectedSha256
  ) {
    throw new ChildFileError("metadata_mismatch", "Required upload intent metadata is missing or invalid.");
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== record.expectedSha256) throw new ChildFileError("checksum_mismatch");
  return { generation, contentType, size, sha256 };
}

export async function quarantineVerifiedChildFile(
  childId: string,
  fileId: string,
  verified: VerifiedStorageObject,
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildFileRecord> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const ref = fileRecordRef(db, childId, fileId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ChildFileError("file_not_found");
    const record = (snap.data() ?? {}) as ChildFileRecord;
    if (record.state === "deleted") throw new ChildFileError("file_not_found");
    if (record.objectGeneration && record.objectGeneration !== verified.generation) {
      throw new ChildFileError("generation_overwrite");
    }
    if (record.expectedSha256 !== verified.sha256 || record.contentType !== verified.contentType) {
      throw new ChildFileError("metadata_mismatch");
    }
    if (record.state !== "intent") return record;

    const operationId = childFileScanOperationId(fileId, verified.generation);
    const updated: ChildFileRecord = {
      ...record,
      state: "quarantined",
      scanState: "pending",
      objectGeneration: verified.generation,
      actualBytes: verified.size,
      verifiedSha256: verified.sha256,
      scanOperationId: operationId,
      uploadedAt: ts,
      verifiedAt: ts,
      updatedAt: ts,
    };
    tx.set(ref, updated);
    return updated;
  });
}

export async function rejectChildFileObject(
  childId: string,
  fileId: string,
  reasonCode: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<void> {
  const db = opts.db ?? defaultDb();
  const ts = nowIso(opts.now);
  const ref = fileRecordRef(db, childId, fileId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const record = (snap.data() ?? {}) as ChildFileRecord;
    if (record.state === "clean" || record.state === "deleted") return;
    tx.set(ref, {
      ...record,
      state: "rejected",
      scanState: "rejected",
      scanReasonCode: String(reasonCode).slice(0, 80),
      updatedAt: ts,
    });
  });
}

export async function recheckChildFileUploadAuthority(
  record: ChildFileRecord,
  opts: { db?: Db; now?: Date } = {},
): Promise<void> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const decision = await checkAuthority(record.createdByUid, record.childId, "management", { db, now });
  if (!decision.allowed) throw new ChildFileError("not_authorized");
  if (decision.accessVersion !== record.authorityAccessVersion) throw new ChildFileError("stale_grant");
  const profile = await getChildProfile(record.childId, db);
  if (!profile || profile.state === "deleted" || profile.legalHold?.active) {
    throw new ChildFileError("not_authorized");
  }
  if (Number(profile.accessVersion ?? 0) !== record.profileAccessVersion) {
    throw new ChildFileError("stale_grant");
  }
}

export async function confirmChildFileUpload(
  params: { actorUid: string; childId: string; fileId: string },
  opts: { db?: Db; bucket?: BucketLike; now?: Date } = {},
): Promise<ChildFileRecord> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const { actorUid, childId, fileId } = params;
  if (!actorUid || !childId || !fileId) throw new ChildFileError("invalid_input");

  const ref = fileRecordRef(db, childId, fileId);
  const snap = await ref.get();
  if (!snap.exists) throw new ChildFileError("file_not_found");
  const record = (snap.data() ?? {}) as ChildFileRecord;
  if (record.state === "deleted" || record.state === "rejected") throw new ChildFileError("file_not_found");

  if (record.createdByUid !== actorUid) throw new ChildFileError("not_authorized");
  await recheckChildFileUploadAuthority(record, { db, now });

  if (record.state !== "intent") return record;
  const verified = await verifyStoredChildFileObject(record, { bucket: opts.bucket, now });
  const quarantined = await quarantineVerifiedChildFile(childId, fileId, verified, { db, now });

  await logAudit({
    eventType: "child_file_upload_verified",
    userId: actorUid,
    data: { childId, fileId, generation: verified.generation },
  }).catch(() => {});
  return quarantined;
}

async function authorizeActorForChild(
  actorUid: string,
  childId: string,
  db: Db,
  now: Date,
  providerEligibility?: AssignedProviderEligibilitySource,
): Promise<"guardian_authority" | "assigned_provider"> {
  const authority = await checkAuthority(actorUid, childId, "view", { db, now });
  if (authority.allowed) return "guardian_authority";
  const source = providerEligibility ?? (await defaultAssignedProviderEligibility(db));
  const provider = await source.isAssignedProviderEligible(actorUid, childId);
  if (provider.eligible) return "assigned_provider";
  throw new ChildFileError("not_authorized");
}

export async function createChildFileDeliveryReference(
  params: { actorUid: string; childId: string; fileId: string; idempotencyKey: string },
  opts: {
    db?: Db;
    now?: Date;
    providerEligibility?: AssignedProviderEligibilitySource;
  } = {},
): Promise<{ deliveryRef: string; expiresAt: string; grantedVia: "guardian_authority" | "assigned_provider" }> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const { actorUid, childId, fileId } = params;
  const nonce = String(params.idempotencyKey ?? "").trim();
  if (!actorUid || !childId || !fileId || !nonce || nonce.length > 128) throw new ChildFileError("invalid_input");

  const snap = await fileRecordRef(db, childId, fileId).get();
  if (!snap.exists) throw new ChildFileError("file_not_found");
  const record = (snap.data() ?? {}) as ChildFileRecord;
  if (
    record.state !== "clean" ||
    record.scanState !== "clean" ||
    !record.objectGeneration ||
    record.verifiedSha256 !== record.expectedSha256
  ) {
    throw new ChildFileError("file_not_clean");
  }

  const grantedVia = await authorizeActorForChild(
    actorUid,
    childId,
    db,
    now,
    opts.providerEligibility,
  );
  const profile = await getChildProfile(childId, db);
  if (!profile || profile.state === "deleted") throw new ChildFileError("not_authorized");

  const deliveryRef = deliveryRefId("child_file", actorUid, fileId, nonce);
  const expiresAt = new Date(now.getTime() + CHILD_FILE_DELIVERY_REF_TTL_MS).toISOString();
  const doc: FileDeliveryRef = {
    deliveryRef,
    kind: "child_file",
    actorUid,
    childId,
    fileId,
    requestId: null,
    path: record.path,
    objectGeneration: record.objectGeneration,
    contentType: record.contentType,
    expiresAt,
    createdAt: nowIso(now),
  };
  await db.collection(CHILD_FILE_DELIVERIES_COLLECTION).doc(deliveryRef).set(doc);
  return { deliveryRef, expiresAt, grantedVia };
}

export async function createLifecycleExportDeliveryReference(
  params: {
    actorUid: string;
    childId: string;
    requestId: string;
    path: string;
    idempotencyKey: string;
  },
  opts: { db?: Db; bucket?: BucketLike; now?: Date } = {},
): Promise<{ deliveryRef: string; expiresAt: string }> {
  const db = opts.db ?? defaultDb();
  const bucket = opts.bucket ?? defaultBucket();
  const now = opts.now ?? new Date();
  const nonce = String(params.idempotencyKey ?? "").trim();
  if (!params.actorUid || !params.childId || !params.requestId || !params.path || !nonce) {
    throw new ChildFileError("invalid_input");
  }
  const authority = await checkAuthority(params.actorUid, params.childId, "management", { db, now });
  if (!authority.allowed) throw new ChildFileError("not_authorized");
  const [metadata] = await bucket.file(params.path).getMetadata();
  const generation = String(metadata.generation ?? "").trim();
  if (!generation) throw new ChildFileError("file_not_found");

  const deliveryRef = deliveryRefId("lifecycle_export", params.actorUid, params.requestId, nonce);
  const expiresAt = new Date(now.getTime() + CHILD_FILE_DELIVERY_REF_TTL_MS).toISOString();
  const doc: FileDeliveryRef = {
    deliveryRef,
    kind: "lifecycle_export",
    actorUid: params.actorUid,
    childId: params.childId,
    fileId: null,
    requestId: params.requestId,
    path: params.path,
    objectGeneration: generation,
    contentType: "application/json",
    expiresAt,
    createdAt: nowIso(now),
  };
  await db.collection(CHILD_FILE_DELIVERIES_COLLECTION).doc(deliveryRef).set(doc);
  return { deliveryRef, expiresAt };
}

export async function authorizeChildFileDelivery(
  actorUid: string,
  deliveryRef: string,
  opts: {
    db?: Db;
    now?: Date;
    providerEligibility?: AssignedProviderEligibilitySource;
  } = {},
): Promise<{ path: string; generation: string; contentType: string; filename: string }> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const refSnap = await db.collection(CHILD_FILE_DELIVERIES_COLLECTION).doc(deliveryRef).get();
  if (!refSnap.exists) throw new ChildFileError("file_not_found");
  const delivery = (refSnap.data() ?? {}) as FileDeliveryRef;
  if (delivery.actorUid !== actorUid || Date.parse(delivery.expiresAt) <= now.getTime()) {
    throw new ChildFileError("not_authorized");
  }

  await authorizeActorForChild(actorUid, delivery.childId, db, now, opts.providerEligibility);
  const profile = await getChildProfile(delivery.childId, db);
  if (!profile || profile.state === "deleted") throw new ChildFileError("not_authorized");

  if (delivery.kind === "child_file") {
    const fileSnap = await fileRecordRef(db, delivery.childId, String(delivery.fileId ?? "")).get();
    if (!fileSnap.exists) throw new ChildFileError("file_not_found");
    const record = (fileSnap.data() ?? {}) as ChildFileRecord;
    if (
      record.state !== "clean" ||
      record.scanState !== "clean" ||
      !record.objectGeneration ||
      record.objectGeneration !== delivery.objectGeneration
    ) {
      throw new ChildFileError("file_not_clean");
    }
    return {
      path: record.path,
      generation: record.objectGeneration,
      contentType: record.contentType,
      filename: `${record.fileId}${record.contentType === "application/pdf" ? ".pdf" : ""}`,
    };
  }

  const requestSnap = await db
    .collection(DATA_LIFECYCLE_REQUESTS_COLLECTION)
    .doc(String(delivery.requestId ?? ""))
    .get();
  if (!requestSnap.exists) throw new ChildFileError("file_not_found");
  const request = requestSnap.data() ?? {};
  if (
    request.requesterUid !== actorUid ||
    request.childId !== delivery.childId ||
    request.state !== "completed" ||
    request.scope !== "export" ||
    request.exportPath !== delivery.path
  ) {
    throw new ChildFileError("not_authorized");
  }
  return {
    path: delivery.path,
    generation: String(delivery.objectGeneration ?? ""),
    contentType: "application/json",
    filename: `careconnex-child-export-${delivery.requestId}.json`,
  };
}

const MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:childcare:mut:",
};
const READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:read:",
};

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

async function requireChildcareFlags(kind: "read" | "write"): Promise<void> {
  const flags = await getChildcareFlags();
  const ok = kind === "write" ? flags.writesEnabled : flags.enabled;
  if (!ok) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
    );
  }
}

async function enforceRateLimit(op: string, uid: string, config: RateLimitConfig): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, config);
  if (!result.allowed) {
    throw new functions.https.HttpsError("resource-exhausted", "Too many requests. Please try again.");
  }
}

function mapFileError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof ChildFileError) {
    if (
      err.code === "invalid_input" ||
      err.code === "content_type_rejected" ||
      err.code === "size_rejected" ||
      err.code === "checksum_mismatch" ||
      err.code === "metadata_mismatch"
    ) {
      throw new functions.https.HttpsError("invalid-argument", err.message, { code: err.code });
    }
    if (err.code === "stale_grant" || err.code === "intent_expired" || err.code === "generation_overwrite") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This upload can no longer be used. Please start again.",
        { code: err.code },
      );
    }
    throw new functions.https.HttpsError("permission-denied", "You do not have permission to perform this action.");
  }
  if (err instanceof ChildProfileError) {
    if (err.code === "invalid_input") throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    throw new functions.https.HttpsError("permission-denied", "You do not have permission to perform this action.");
  }
  console.error("[childFileAccess] unexpected error:", err instanceof Error ? err.name : "Error");
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

export const createChildFileUploadIntent = childcareOnCall("createChildFileUploadIntent", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("createChildFileUploadIntent", uid, MUTATION_RATE);
  try {
    const result = await mintChildFileUploadIntent({
      actorUid: uid,
      childId: String(data?.childId ?? "").trim(),
      contentType: String(data?.contentType ?? ""),
      declaredBytes: Number(data?.declaredBytes),
      expectedSha256: String(data?.expectedSha256 ?? ""),
      purpose: String(data?.purpose ?? ""),
      idempotencyKey: String(data?.idempotencyKey ?? "").trim(),
    });
    return { success: true, ...result };
  } catch (err) {
    mapFileError(err);
  }
});

export const confirmChildFileUploadCallable = childcareOnCall("confirmChildFileUpload", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("confirmChildFileUpload", uid, MUTATION_RATE);
  try {
    const record = await confirmChildFileUpload({
      actorUid: uid,
      childId: String(data?.childId ?? "").trim(),
      fileId: String(data?.fileId ?? "").trim(),
    });
    return {
      success: true,
      fileId: record.fileId,
      state: record.state,
      scanState: record.scanState,
    };
  } catch (err) {
    mapFileError(err);
  }
});

export const getChildFileDeliveryReference = childcareOnCall("getChildFileDeliveryReference", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("getChildFileDeliveryReference", uid, READ_RATE);
  try {
    const result = await createChildFileDeliveryReference({
      actorUid: uid,
      childId: String(data?.childId ?? "").trim(),
      fileId: String(data?.fileId ?? "").trim(),
      idempotencyKey: String(data?.idempotencyKey ?? "").trim(),
    });
    return { success: true, ...result };
  } catch (err) {
    mapFileError(err);
  }
});

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(String(header ?? "").trim());
  return match?.[1]?.trim() || null;
}

export const childFileDelivery = functions
  .runWith({ timeoutSeconds: 60, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") {
      res.status(405).send("Method not allowed.");
      return;
    }

    const token = bearerToken(req.header("authorization"));
    if (!token) {
      res.status(401).send("Authentication required.");
      return;
    }

    let uid: string;
    try {
      uid = (await admin.auth().verifyIdToken(token, true)).uid;
    } catch {
      res.status(401).send("Authentication required.");
      return;
    }

    const deliveryRef = String(req.query.ref ?? "").trim();
    if (!/^cdr_[a-f0-9]{48}$/.test(deliveryRef)) {
      res.status(404).send("File not found.");
      return;
    }

    try {
      await enforceRateLimit("childFileDelivery", uid, READ_RATE);
      const delivery = await authorizeChildFileDelivery(uid, deliveryRef);
      const stream = defaultBucket().file(delivery.path).createReadStream({
        validation: "crc32c",
        ifGenerationMatch: delivery.generation,
      });
      res.status(200);
      res.set("Content-Type", delivery.contentType);
      res.set("Content-Disposition", `attachment; filename="${delivery.filename.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`);
      stream.on("error", (err) => {
        console.error("[childFileDelivery] stream failed:", err instanceof Error ? err.name : "Error");
        if (!res.headersSent) res.status(404).send("File not found.");
        else res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      if (err instanceof functions.https.HttpsError && err.code === "resource-exhausted") {
        res.status(429).send("Too many requests.");
        return;
      }
      res.status(404).send("File not found.");
    }
  });
