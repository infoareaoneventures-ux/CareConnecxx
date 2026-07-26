// Trusted scan-result consumer plus timeout/retry/quarantine reconciliation.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { PubSub } from "@google-cloud/pubsub";
import { createHmac, timingSafeEqual } from "crypto";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { getChildProfile } from "../data/childProfileRepository";
import { logAudit } from "../observability/auditLog";
import {
  fileRecordRef,
  type ChildFileRecord,
} from "./childFileAccess";
import {
  CHILD_FILE_SCAN_MAX_ATTEMPTS,
  CHILD_FILE_SCAN_OPERATIONS_COLLECTION,
  CHILD_FILE_SCAN_REQUEST_TOPIC,
  CHILD_FILE_SCAN_SLA_MS,
  type ChildFileScanOperation,
  type ChildFileScanRequest,
  type ScanRequestPublisher,
} from "./childFileScan";

export const CHILD_FILE_SCAN_RESULT_TOPIC =
  process.env.CHILD_FILE_SCAN_RESULT_TOPIC || "childcare-file-scan-results";
export const CHILD_FILE_SCAN_SIGNATURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CHILD_FILE_QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type MalwareScanVerdict = "clean" | "malicious" | "error";

export interface ChildFileScanResult {
  schemaVersion: 1;
  operationId: string;
  fileId: string;
  path: string;
  objectGeneration: string;
  sha256: string;
  result: MalwareScanVerdict;
  reasonCode: string;
  engineVersion: string;
  signatureVersion: string;
  signatureUpdatedAt: string;
  imageDigest: string;
  attempt: number;
  scannedAt: string;
  signature: string;
}

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

interface BucketLike {
  file(path: string): {
    delete(opts?: Record<string, unknown>): Promise<unknown>;
  };
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

function defaultPublisher(): ScanRequestPublisher {
  const client = new PubSub();
  return {
    async publish(request) {
      return client.topic(CHILD_FILE_SCAN_REQUEST_TOPIC).publishMessage({ json: request });
    },
  };
}

export function canonicalScanResultPayload(result: Omit<ChildFileScanResult, "signature">): string {
  return JSON.stringify({
    schemaVersion: result.schemaVersion,
    operationId: result.operationId,
    fileId: result.fileId,
    path: result.path,
    objectGeneration: result.objectGeneration,
    sha256: result.sha256,
    result: result.result,
    reasonCode: result.reasonCode,
    engineVersion: result.engineVersion,
    signatureVersion: result.signatureVersion,
    signatureUpdatedAt: result.signatureUpdatedAt,
    imageDigest: result.imageDigest,
    attempt: result.attempt,
    scannedAt: result.scannedAt,
  });
}

export function signScanResult(
  result: Omit<ChildFileScanResult, "signature">,
  secret: string,
): string {
  return createHmac("sha256", secret).update(canonicalScanResultPayload(result)).digest("hex");
}

function validBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function validateChildFileScanResult(value: unknown): ChildFileScanResult {
  if (!value || typeof value !== "object") throw new Error("invalid_result_schema");
  const result = value as Partial<ChildFileScanResult>;
  if (
    result.schemaVersion !== 1 ||
    !validBoundedString(result.operationId, 80) ||
    !validBoundedString(result.fileId, 64) ||
    !validBoundedString(result.path, 512) ||
    !validBoundedString(result.objectGeneration, 64) ||
    !/^[a-f0-9]{64}$/.test(String(result.sha256 ?? "")) ||
    (result.result !== "clean" && result.result !== "malicious" && result.result !== "error") ||
    !validBoundedString(result.reasonCode, 80) ||
    !validBoundedString(result.engineVersion, 80) ||
    !validBoundedString(result.signatureVersion, 120) ||
    !validBoundedString(result.signatureUpdatedAt, 40) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(result.imageDigest ?? "")) ||
    !Number.isInteger(result.attempt) ||
    Number(result.attempt) < 1 ||
    Number(result.attempt) > CHILD_FILE_SCAN_MAX_ATTEMPTS ||
    !validBoundedString(result.scannedAt, 40) ||
    !/^[a-f0-9]{64}$/.test(String(result.signature ?? ""))
  ) {
    throw new Error("invalid_result_schema");
  }
  return result as ChildFileScanResult;
}

function verifyResultSignature(result: ChildFileScanResult, secret: string): void {
  if (!secret) throw new Error("scan_result_secret_unavailable");
  const expected = signScanResult(
    {
      schemaVersion: result.schemaVersion,
      operationId: result.operationId,
      fileId: result.fileId,
      path: result.path,
      objectGeneration: result.objectGeneration,
      sha256: result.sha256,
      result: result.result,
      reasonCode: result.reasonCode,
      engineVersion: result.engineVersion,
      signatureVersion: result.signatureVersion,
      signatureUpdatedAt: result.signatureUpdatedAt,
      imageDigest: result.imageDigest,
      attempt: result.attempt,
      scannedAt: result.scannedAt,
    },
    secret,
  );
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(result.signature, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error("invalid_result_signature");
  }
}

function assertResultBinding(
  result: ChildFileScanResult,
  operation: ChildFileScanOperation,
  expectedImageDigest: string,
  now: Date,
): void {
  if (
    result.operationId !== operation.operationId ||
    result.fileId !== operation.fileId ||
    result.path !== operation.path ||
    result.objectGeneration !== operation.objectGeneration ||
    result.sha256 !== operation.sha256 ||
    result.attempt !== operation.attempt
  ) {
    throw new Error("scan_result_binding_mismatch");
  }
  if (!expectedImageDigest || result.imageDigest !== expectedImageDigest) {
    throw new Error("unapproved_scanner_image");
  }
  const signatureUpdatedAt = Date.parse(result.signatureUpdatedAt);
  const scannedAt = Date.parse(result.scannedAt);
  if (
    !Number.isFinite(signatureUpdatedAt) ||
    !Number.isFinite(scannedAt) ||
    signatureUpdatedAt > now.getTime() + 5 * 60 * 1000 ||
    now.getTime() - signatureUpdatedAt > CHILD_FILE_SCAN_SIGNATURE_MAX_AGE_MS ||
    scannedAt > now.getTime() + 5 * 60 * 1000
  ) {
    throw new Error("stale_scanner_signatures");
  }
}

export async function consumeChildFileScanResult(
  input: unknown,
  opts: {
    db?: Db;
    now?: Date;
    hmacSecret?: string;
    expectedImageDigest?: string;
  } = {},
): Promise<{ status: "applied" | "duplicate"; state: "clean" | "rejected" | "error" }> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const result = validateChildFileScanResult(input);
  verifyResultSignature(
    result,
    opts.hmacSecret ?? process.env.CHILD_FILE_SCAN_RESULT_HMAC_SECRET ?? "",
  );

  const operationRef = db.collection(CHILD_FILE_SCAN_OPERATIONS_COLLECTION).doc(result.operationId);
  const operationSnap = await operationRef.get();
  if (!operationSnap.exists) throw new Error("scan_operation_not_found");
  const operation = (operationSnap.data() ?? {}) as ChildFileScanOperation;
  if (operation.state === "clean" || operation.state === "rejected") {
    return { status: "duplicate", state: operation.state };
  }
  assertResultBinding(
    result,
    operation,
    opts.expectedImageDigest ?? process.env.CHILD_FILE_SCANNER_IMAGE_DIGEST ?? "",
    now,
  );

  const terminalState =
    result.result === "clean" ? "clean" : result.result === "malicious" ? "rejected" : "error";
  const fileRef = fileRecordRef(db, operation.childId, operation.fileId);

  const applied = await db.runTransaction(async (tx) => {
    const [freshOpSnap, fileSnap] = await Promise.all([tx.get(operationRef), tx.get(fileRef)]);
    if (!freshOpSnap.exists || !fileSnap.exists) throw new Error("scan_target_not_found");
    const freshOp = (freshOpSnap.data() ?? {}) as ChildFileScanOperation;
    const file = (fileSnap.data() ?? {}) as ChildFileRecord;
    if (freshOp.state === "clean" || freshOp.state === "rejected") return false;
    if (
      freshOp.objectGeneration !== result.objectGeneration ||
      file.objectGeneration !== result.objectGeneration ||
      file.scanOperationId !== result.operationId
    ) {
      throw new Error("stale_scan_result");
    }

    tx.set(operationRef, {
      ...freshOp,
      state: terminalState,
      terminalAt: terminalState === "error" ? null : ts,
      lastReasonCode: result.reasonCode,
      updatedAt: ts,
    });
    tx.set(fileRef, {
      ...file,
      state: terminalState,
      scanState: terminalState,
      scanAttemptCount: result.attempt,
      scanEngineVersion: result.engineVersion,
      scanSignatureVersion: result.signatureVersion,
      scanImageDigest: result.imageDigest,
      scanReasonCode: result.reasonCode,
      readableAt: terminalState === "clean" ? ts : null,
      updatedAt: ts,
    });
    return true;
  });

  if (!applied) return { status: "duplicate", state: terminalState };
  await logAudit({
    eventType: "child_file_scan_result",
    userId: "system",
    data: {
      childId: operation.childId,
      fileId: operation.fileId,
      operationId: operation.operationId,
      result: terminalState,
      reasonCode: result.reasonCode,
      attempt: result.attempt,
    },
  }).catch(() => {});
  return { status: "applied", state: terminalState };
}

export async function reconcileTimedOutChildFileScans(
  opts: {
    db?: Db;
    publisher?: ScanRequestPublisher;
    now?: Date;
    limit?: number;
  } = {},
): Promise<{ examined: number; retried: number; exhausted: number }> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const snapshot = await db
    .collection(CHILD_FILE_SCAN_OPERATIONS_COLLECTION)
    .where("state", "in", ["pending", "dispatched", "error"])
    .where("deadlineAt", "<=", ts)
    .orderBy("deadlineAt", "asc")
    .limit(opts.limit ?? 50)
    .get();

  let retried = 0;
  let exhausted = 0;
  for (const row of snapshot.docs) {
    const operation = (row.data() ?? {}) as ChildFileScanOperation;
    const fileRef = fileRecordRef(db, operation.childId, operation.fileId);
    if (operation.attempt >= operation.maxAttempts) {
      await db.runTransaction(async (tx) => {
        const [opSnap, fileSnap] = await Promise.all([tx.get(row.ref), tx.get(fileRef)]);
        if (!opSnap.exists || !fileSnap.exists) return;
        const current = (opSnap.data() ?? {}) as ChildFileScanOperation;
        const file = (fileSnap.data() ?? {}) as ChildFileRecord;
        if (current.state === "clean" || current.state === "rejected") return;
        tx.set(row.ref, {
          ...current,
          state: "error",
          terminalAt: ts,
          lastReasonCode: "retry_exhausted",
          updatedAt: ts,
        });
        tx.set(fileRef, {
          ...file,
          state: "error",
          scanState: "error",
          scanReasonCode: "retry_exhausted",
          updatedAt: ts,
        });
      });
      await db.collection("admin_alerts").doc(`child_file_scan_exhausted_${operation.operationId}`).set({
        type: "child_file_scan_retry_exhausted",
        severity: "high",
        operationId: operation.operationId,
        childId: operation.childId,
        fileId: operation.fileId,
        createdAt: ts,
        resolved: false,
      });
      exhausted += 1;
      continue;
    }

    const nextAttempt = operation.attempt + 1;
    const deadlineAt = new Date(now.getTime() + CHILD_FILE_SCAN_SLA_MS).toISOString();
    const request: ChildFileScanRequest = {
      schemaVersion: 1,
      operationId: operation.operationId,
      fileId: operation.fileId,
      path: operation.path,
      objectGeneration: operation.objectGeneration,
      sha256: operation.sha256,
      contentType: operation.contentType,
      size: operation.size,
      attempt: nextAttempt,
      deadlineAt,
    };
    const messageId = await (opts.publisher ?? defaultPublisher()).publish(request);
    await db.runTransaction(async (tx) => {
      const [opSnap, fileSnap] = await Promise.all([tx.get(row.ref), tx.get(fileRef)]);
      if (!opSnap.exists || !fileSnap.exists) return;
      const current = (opSnap.data() ?? {}) as ChildFileScanOperation;
      const file = (fileSnap.data() ?? {}) as ChildFileRecord;
      if (current.state === "clean" || current.state === "rejected" || current.attempt !== operation.attempt) return;
      tx.set(row.ref, {
        ...current,
        state: "dispatched",
        attempt: nextAttempt,
        deadlineAt,
        publishedMessageId: messageId,
        publishedAt: ts,
        terminalAt: null,
        updatedAt: ts,
      });
      tx.set(fileRef, {
        ...file,
        state: "scanning",
        scanState: "scanning",
        scanAttemptCount: nextAttempt,
        scanDeadlineAt: deadlineAt,
        updatedAt: ts,
      });
    });
    retried += 1;
  }

  return { examined: snapshot.size, retried, exhausted };
}

export async function cleanupExpiredChildFileQuarantine(
  opts: { db?: Db; bucket?: BucketLike; now?: Date; limit?: number } = {},
): Promise<{ examined: number; deleted: number; legalHoldSkipped: number }> {
  const db = opts.db ?? defaultDb();
  const bucket = opts.bucket ?? defaultBucket();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const cutoff = new Date(now.getTime() - CHILD_FILE_QUARANTINE_RETENTION_MS).toISOString();
  const snapshot = await db
    .collection(CHILD_FILE_SCAN_OPERATIONS_COLLECTION)
    .where("state", "in", ["pending", "dispatched", "error", "rejected"])
    .where("createdAt", "<=", cutoff)
    .orderBy("createdAt", "asc")
    .limit(opts.limit ?? 50)
    .get();

  let deleted = 0;
  let legalHoldSkipped = 0;
  for (const row of snapshot.docs) {
    const operation = (row.data() ?? {}) as ChildFileScanOperation;
    const profile = await getChildProfile(operation.childId, db);
    if (profile?.legalHold?.active) {
      legalHoldSkipped += 1;
      continue;
    }
    await bucket.file(operation.path).delete({
      ignoreNotFound: true,
      ifGenerationMatch: operation.objectGeneration,
    });
    await db.runTransaction(async (tx) => {
      const fileRef = fileRecordRef(db, operation.childId, operation.fileId);
      const fileSnap = await tx.get(fileRef);
      if (!fileSnap.exists) return;
      const file = (fileSnap.data() ?? {}) as ChildFileRecord;
      if (file.objectGeneration !== operation.objectGeneration || file.state === "clean") return;
      tx.set(fileRef, {
        ...file,
        state: "deleted",
        scanState: file.scanState,
        deletedAt: ts,
        updatedAt: ts,
      });
    });
    deleted += 1;
  }
  return { examined: snapshot.size, deleted, legalHoldSkipped };
}

export const consumeChildFileScanResultMessage = onMessagePublished(
  {
    topic: CHILD_FILE_SCAN_RESULT_TOPIC,
    region: process.env.CHILD_FILE_SCANNER_REGION || "us-central1",
    retry: true,
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: ["CHILD_FILE_SCAN_RESULT_HMAC_SECRET"],
  },
  async (event) => {
    await consumeChildFileScanResult(event.data.message.json);
  },
);

export const reconcileChildFileScans = functions.pubsub
  .schedule("every 5 minutes")
  .timeZone("UTC")
  .onRun(async () => {
    await reconcileTimedOutChildFileScans();
    await cleanupExpiredChildFileQuarantine();
    return null;
  });
