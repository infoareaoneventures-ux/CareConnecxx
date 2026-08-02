// Trusted Storage-finalize dispatcher for restricted child-file malware scans.

import * as admin from "firebase-admin";
import { PubSub } from "@google-cloud/pubsub";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { logAudit } from "../observability/auditLog";
import {
  ChildFileError,
  childFileScanOperationId,
  fileRecordRef,
  quarantineVerifiedChildFile,
  recheckChildFileUploadAuthority,
  rejectChildFileObject,
  verifyStoredChildFileObject,
  type ChildFileRecord,
  type StorageObjectMetadata,
} from "./childFileAccess";

export const CHILD_FILE_SCAN_OPERATIONS_COLLECTION = "childcare_file_scan_operations";
export const CHILD_FILE_SCAN_REQUEST_TOPIC =
  process.env.CHILD_FILE_SCAN_REQUEST_TOPIC || "childcare-file-scan-requests";
export const CHILD_FILE_SCAN_MAX_ATTEMPTS = 3;
export const CHILD_FILE_SCAN_SLA_MS = 10 * 60 * 1000;

export type ChildFileScanOperationState =
  | "pending"
  | "dispatched"
  | "clean"
  | "rejected"
  | "error";

export interface ChildFileScanOperation {
  operationId: string;
  fileId: string;
  childId: string;
  householdId: string;
  path: string;
  objectGeneration: string;
  sha256: string;
  contentType: string;
  size: number;
  state: ChildFileScanOperationState;
  attempt: number;
  maxAttempts: number;
  deadlineAt: string;
  publishedMessageId?: string | null;
  publishedAt?: string | null;
  terminalAt?: string | null;
  lastReasonCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChildFileScanRequest {
  schemaVersion: 1;
  operationId: string;
  fileId: string;
  path: string;
  objectGeneration: string;
  sha256: string;
  contentType: string;
  size: number;
  attempt: number;
  deadlineAt: string;
}

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

export interface ScanRequestPublisher {
  publish(request: ChildFileScanRequest): Promise<string>;
}

function defaultDb(): Db {
  return admin.firestore();
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

export function parseChildFileObjectPath(path: string): {
  householdId: string;
  childId: string;
  purpose: string;
  fileId: string;
} | null {
  const match = /^childcare\/([^/]+)\/([^/]+)\/(safety_document|care_document|photo)\/(cf_[a-f0-9]{40})$/.exec(
    String(path ?? ""),
  );
  if (!match) return null;
  return {
    householdId: match[1],
    childId: match[2],
    purpose: match[3],
    fileId: match[4],
  };
}

function rejectionReason(err: unknown): string {
  if (err instanceof ChildFileError) return err.code;
  return "object_verification_failed";
}

export async function dispatchChildFileScan(
  eventObject: {
    name?: string;
    generation?: string | number;
    contentType?: string;
    size?: string | number;
    metadata?: Record<string, string | undefined>;
  },
  opts: {
    db?: Db;
    bucket?: {
      file(path: string): {
        getMetadata(): Promise<[StorageObjectMetadata]>;
        download(opts?: Record<string, unknown>): Promise<[Buffer]>;
      };
    };
    publisher?: ScanRequestPublisher;
    now?: Date;
  } = {},
): Promise<{ status: "ignored" | "rejected" | "dispatched" | "duplicate"; operationId?: string }> {
  const parsed = parseChildFileObjectPath(String(eventObject.name ?? ""));
  if (!parsed) return { status: "ignored" };

  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const recordSnap = await fileRecordRef(db, parsed.childId, parsed.fileId).get();
  if (!recordSnap.exists) return { status: "ignored" };
  const record = (recordSnap.data() ?? {}) as ChildFileRecord;
  if (
    record.path !== eventObject.name ||
    record.householdId !== parsed.householdId ||
    record.purpose !== parsed.purpose ||
    record.state === "deleted"
  ) {
    return { status: "ignored" };
  }

  let verified;
  try {
    await recheckChildFileUploadAuthority(record, { db, now });
    verified = await verifyStoredChildFileObject(record, {
      bucket: opts.bucket as never,
      now,
    });
    if (eventObject.generation && String(eventObject.generation) !== verified.generation) {
      return { status: "ignored" };
    }
  } catch (err) {
    const reason = rejectionReason(err);
    await rejectChildFileObject(parsed.childId, parsed.fileId, reason, { db, now });
    await logAudit({
      eventType: "child_file_object_rejected",
      userId: "system",
      data: { childId: parsed.childId, fileId: parsed.fileId, reasonCode: reason },
    }).catch(() => {});
    return { status: "rejected" };
  }

  const quarantined = await quarantineVerifiedChildFile(parsed.childId, parsed.fileId, verified, { db, now });
  const operationId =
    quarantined.scanOperationId ?? childFileScanOperationId(parsed.fileId, verified.generation);
  const operationRef = db.collection(CHILD_FILE_SCAN_OPERATIONS_COLLECTION).doc(operationId);
  const operation = await db.runTransaction(async (tx) => {
    const existing = await tx.get(operationRef);
    if (existing.exists) return (existing.data() ?? {}) as ChildFileScanOperation;
    const created: ChildFileScanOperation = {
      operationId,
      fileId: parsed.fileId,
      childId: parsed.childId,
      householdId: parsed.householdId,
      path: record.path,
      objectGeneration: verified.generation,
      sha256: verified.sha256,
      contentType: verified.contentType,
      size: verified.size,
      state: "pending",
      attempt: 1,
      maxAttempts: CHILD_FILE_SCAN_MAX_ATTEMPTS,
      deadlineAt: new Date(now.getTime() + CHILD_FILE_SCAN_SLA_MS).toISOString(),
      publishedMessageId: null,
      publishedAt: null,
      terminalAt: null,
      lastReasonCode: null,
      createdAt: ts,
      updatedAt: ts,
    };
    tx.set(operationRef, created);
    return created;
  });

  if (operation.state !== "pending" || operation.publishedAt) {
    return { status: "duplicate", operationId };
  }

  const request: ChildFileScanRequest = {
    schemaVersion: 1,
    operationId,
    fileId: parsed.fileId,
    path: operation.path,
    objectGeneration: operation.objectGeneration,
    sha256: operation.sha256,
    contentType: operation.contentType,
    size: operation.size,
    attempt: operation.attempt,
    deadlineAt: operation.deadlineAt,
  };
  const messageId = await (opts.publisher ?? defaultPublisher()).publish(request);

  await db.runTransaction(async (tx) => {
    const [opSnap, fileSnap] = await Promise.all([
      tx.get(operationRef),
      tx.get(fileRecordRef(db, parsed.childId, parsed.fileId)),
    ]);
    if (!opSnap.exists || !fileSnap.exists) return;
    const currentOp = (opSnap.data() ?? {}) as ChildFileScanOperation;
    const currentFile = (fileSnap.data() ?? {}) as ChildFileRecord;
    if (currentOp.state !== "pending" || currentFile.objectGeneration !== operation.objectGeneration) return;
    tx.set(operationRef, {
      ...currentOp,
      state: "dispatched",
      publishedMessageId: messageId,
      publishedAt: ts,
      updatedAt: ts,
    });
    tx.set(fileRecordRef(db, parsed.childId, parsed.fileId), {
      ...currentFile,
      state: "scanning",
      scanState: "scanning",
      scanAttemptCount: currentOp.attempt,
      scanDeadlineAt: currentOp.deadlineAt,
      updatedAt: ts,
    });
  });

  return { status: "dispatched", operationId };
}

export const dispatchChildFileScanOnFinalize = onObjectFinalized(
  {
    region: process.env.CHILD_FILE_SCANNER_REGION || "us-central1",
    serviceAccount:
      process.env.CHILD_FILE_DISPATCHER_SERVICE_ACCOUNT || undefined,
    // retry disabled for the initial dark deploy (2026-07-28). A failure policy
    // forces `firebase deploy --force`, which ALSO deletes any deployed function
    // absent from source — currently the two untriaged orphans caraPhase1Webhook
    // and onTaskCreated. Deleting production functions as a side effect of a
    // deploy flag is not acceptable, and childcare is dark, so nothing is lost:
    // a failed dispatch leaves the file unusable (fail-closed) rather than
    // self-healing. Re-enable (with --force, after the orphan audit) before
    // childcare handles real uploads. dispatchChildFileScan is idempotent via a
    // deterministic operationId, so retry is safe to restore.
    retry: false,
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (event) => {
    await dispatchChildFileScan(event.data);
  },
);
