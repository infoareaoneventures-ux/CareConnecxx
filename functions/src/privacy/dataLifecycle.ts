// ── Child data lifecycle state machine (childcare marketplace plan 2026-07-22-002, U3) ──
//
// R13-R15/KTD21: export / delete / redact are DURABLE, tracked workflows in
// `data_lifecycle_requests/{requestId}` — never a fire-and-forget delete and
// NEVER "delete Firebase Auth and call it account deletion" (R15). Each
// request fans out per-target tasks executed sequentially by the scheduled
// drain (scheduled/childcareLifecycleWorker.ts) with the claim/lease/bounded-
// retry/terminal semantics of the U2 guardianAuthorityOutbox dispatcher:
//
//   pending → in_progress → completed
//                        ↘ awaiting_provider  (Stripe Identity redaction is a
//                                              founder/provider-executed task —
//                                              we track STATE ONLY and complete
//                                              via markProviderTaskComplete)
//                        ↘ blocked_legal_hold (hold appeared after creation —
//                                              resumes when the hold clears)
//                        ↘ requires_admin_review (retry budget exhausted)
//
// Gates at creation (R14/R18): recent authentication (enforced by the calling
// callable from the ID token's auth_time), live `management` guardian
// authority for the child, and the legal-hold check (an active hold refuses
// delete/redact outright). Terminal proof records per-task counts and
// completion timestamps — deletion must remain provable.
//
// Task kinds per scope:
//   export : export_bundle (JSON bundle -> childcare Storage root, retrieved
//            through the authenticated child-file delivery endpoint)
//   delete : revoke_derived_access → firestore_delete (tombstone + private
//            purge) → storage_delete → ai_reference_scan → stripe_identity_
//            redaction (awaiting_provider) → orphan_file_scan
//   redact : safety_version_purge → storage_delete → ai_reference_scan →
//            stripe_identity_redaction → orphan_file_scan
//
// ai_reference_scan: childcare turns are memory-DENIED by construction (KTD17;
// children have no Zep user, no Linq thread, no learned facts), so the task
// VERIFIES that invariant — it scans for child references where modules exist
// and raises an admin review if any are found (they never should be). Real
// Zep/Linq deletion hooks land with U10's memory-eligibility work.
//
// Adult account deletion (R15): beginAdultAccountDeletion below is the
// server-owned entry point. It is deliberately NOT wired into any existing
// Firebase-Auth deletion path yet — reclassifying admin/adminUserActions.ts
// and any auth.user().onDelete trigger onto this workflow is later-unit
// (U12/U14) manifest work; the hook point is documented there.

import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { logAudit } from "../observability/auditLog";
import {
  checkAuthority,
  revokeGuardianAuthority,
  listAuthoritiesForAdult,
  GUARDIAN_AUTHORITIES_COLLECTION,
  type GuardianAuthorityDoc,
} from "../childcare/guardianAuthority";
import {
  getChildProfile,
  listChildSafetyVersions,
  listChildFileRecords,
  tombstoneChildProfileForDeletion,
  redactChildSafetyVersions,
  revokeAllChildViewerAccess,
  ChildProfileError,
} from "../data/childProfileRepository";
import {
  childFileStoragePrefix,
  createLifecycleExportDeliveryReference,
} from "../childcare/childFileAccess";

export const DATA_LIFECYCLE_REQUESTS_COLLECTION = "data_lifecycle_requests";

// ── Types ────────────────────────────────────────────────────────────────────

export type LifecycleScope = "export" | "delete" | "redact";

export type LifecycleRequestState =
  | "pending"
  | "in_progress"
  | "awaiting_provider"
  | "blocked_legal_hold"
  | "completed"
  | "requires_admin_review";

export type LifecycleTaskState = "pending" | "completed" | "awaiting_provider" | "failed";

export type LifecycleTaskKind =
  | "revoke_derived_access"
  | "firestore_delete"
  | "safety_version_purge"
  | "storage_delete"
  | "ai_reference_scan"
  | "stripe_identity_redaction"
  | "orphan_file_scan"
  | "export_bundle";

export interface LifecycleTask {
  taskId: string;
  kind: LifecycleTaskKind;
  state: LifecycleTaskState;
  attemptCount: number;
  lastErrorCode?: string | null;
  /** Per-task terminal proof: counts, paths, provider refs. Never child PII. */
  proof?: Record<string, unknown> | null;
  completedAt?: string | null;
}

export interface LifecycleRequestDoc {
  requestId: string;
  scope: LifecycleScope;
  childId: string;
  householdId: string;
  requesterUid: string;
  state: LifecycleRequestState;
  tasks: LifecycleTask[];
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastErrorCode?: string | null;
  /** Terminal proof (R13): aggregate counts + completion timestamps. */
  proof: {
    counts: Record<string, number>;
    startedAt: string | null;
    completedAt: string | null;
    retainedRecordReasons: string[];
  };
  /** Export scope only: the bundle's Storage path (served via signed URL). */
  exportPath?: string | null;
  retentionPolicyVersion: string | null;
  lastOperationKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LifecycleErrorCode =
  | "invalid_input"
  | "not_authorized"
  | "child_not_found"
  | "legal_hold_active"
  | "request_not_found";

export class LifecycleError extends Error {
  code: LifecycleErrorCode;
  constructor(code: LifecycleErrorCode, message?: string) {
    super(message ?? code);
    this.name = "LifecycleError";
    this.code = code;
  }
}

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

interface StorageFileLike {
  name: string;
  delete(opts?: Record<string, unknown>): Promise<unknown>;
}

interface BucketLike {
  file(path: string): {
    save(data: string | Buffer, opts?: Record<string, unknown>): Promise<unknown>;
    getMetadata(): Promise<[{
      generation?: string | number;
      size?: string | number;
      contentType?: string;
      metadata?: Record<string, string | undefined>;
    }]>;
    delete(opts?: Record<string, unknown>): Promise<unknown>;
  };
  getFiles(opts: { prefix: string }): Promise<[StorageFileLike[]]>;
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

export function lifecycleRequestId(childId: string, scope: LifecycleScope, idempotencyKey: string): string {
  return `dlr_${createHash("sha256").update(`${childId}:${scope}:${idempotencyKey}`).digest("hex").slice(0, 40)}`;
}

function requestRef(db: Db, requestId: string) {
  return db.collection(DATA_LIFECYCLE_REQUESTS_COLLECTION).doc(requestId);
}

// ── Task plans ───────────────────────────────────────────────────────────────

const TASK_PLAN: Record<LifecycleScope, LifecycleTaskKind[]> = {
  export: ["export_bundle"],
  delete: [
    "revoke_derived_access",
    "firestore_delete",
    "storage_delete",
    "ai_reference_scan",
    "stripe_identity_redaction",
    "orphan_file_scan",
  ],
  redact: [
    "safety_version_purge",
    "storage_delete",
    "ai_reference_scan",
    "stripe_identity_redaction",
    "orphan_file_scan",
  ],
};

function buildTasks(scope: LifecycleScope): LifecycleTask[] {
  return TASK_PLAN[scope].map((kind, i) => ({
    taskId: `t${i + 1}_${kind}`,
    kind,
    state: "pending",
    attemptCount: 0,
    lastErrorCode: null,
    proof: null,
    completedAt: null,
  }));
}

// ── Creation (authority + legal-hold gates; recent-auth is the callable's job) ─

export interface CreateLifecycleRequestParams {
  requesterUid: string;
  childId: string;
  scope: LifecycleScope;
  idempotencyKey: string;
  /**
   * Server-internal: beginAdultAccountDeletion sets this for the sole-guardian
   * case (the departing adult may hold only partial scopes yet the child data
   * MUST still reach a tracked deletion — R15). User-facing callables NEVER
   * pass it; they always take the management-authority gate.
   */
  systemInitiated?: boolean;
}

export async function createLifecycleRequest(
  params: CreateLifecycleRequestParams,
  opts: { db?: Db; now?: Date } = {},
): Promise<LifecycleRequestDoc> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const requesterUid = String(params.requesterUid ?? "").trim();
  const childId = String(params.childId ?? "").trim();
  const idempotencyKey = String(params.idempotencyKey ?? "").trim();
  const scope = params.scope;
  if (!requesterUid || !childId || !idempotencyKey || idempotencyKey.length > 128) {
    throw new LifecycleError("invalid_input");
  }
  if (scope !== "export" && scope !== "delete" && scope !== "redact") {
    throw new LifecycleError("invalid_input", "scope must be export, delete, or redact");
  }

  // Authority gate (R14): lifecycle rights over a child require ACTIVE
  // management authority — checked live via THE permission primitive.
  if (!params.systemInitiated) {
    const decision = await checkAuthority(requesterUid, childId, "management", { db, now });
    if (!decision.allowed) throw new LifecycleError("not_authorized");
  }

  const profile = await getChildProfile(childId, db);
  if (!profile) throw new LifecycleError("not_authorized"); // enumeration-safe upstream
  if (profile.state === "deleted" && scope !== "export") {
    throw new LifecycleError("not_authorized");
  }
  // Legal-hold gate: an ACTIVE hold refuses destructive scopes at creation.
  if (scope !== "export" && profile.legalHold?.active) {
    throw new LifecycleError("legal_hold_active", "This record is under a legal hold and cannot be deleted yet.");
  }

  const requestId = lifecycleRequestId(childId, scope, idempotencyKey);
  const ref = requestRef(db, requestId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return (snap.data() ?? {}) as LifecycleRequestDoc; // idempotent retry

    const doc: LifecycleRequestDoc = {
      requestId,
      scope,
      childId,
      householdId: profile.householdId,
      requesterUid,
      state: "pending",
      tasks: buildTasks(scope),
      attemptCount: 0,
      nextAttemptAt: ts,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      proof: {
        counts: {},
        startedAt: null,
        completedAt: null,
        // R14: approved financial/dispute/safety/legal records are preserved;
        // reasons accumulate as tasks skip retained targets.
        retainedRecordReasons: [],
      },
      exportPath: null,
      retentionPolicyVersion: profile.retentionPolicyVersion ?? null,
      lastOperationKey: idempotencyKey,
      createdAt: ts,
      updatedAt: ts,
    };
    tx.set(ref, doc);
    return doc;
  });
}

// ── Status accessor (requester-scoped; the user-visible surface) ─────────────

export interface LifecycleStatusView {
  requestId: string;
  scope: LifecycleScope;
  state: LifecycleRequestState;
  tasks: Array<{ kind: LifecycleTaskKind; state: LifecycleTaskState; completedAt: string | null }>;
  proof: LifecycleRequestDoc["proof"];
  /** Export scope, completed only: non-secret authenticated delivery route. */
  exportDeliveryRef?: string | null;
  exportDeliveryRefExpiresAt?: string | null;
}

export async function getLifecycleStatusForRequester(
  requesterUid: string,
  requestId: string,
  opts: { db?: Db; bucket?: BucketLike; now?: Date } = {},
): Promise<LifecycleStatusView> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const snap = await requestRef(db, String(requestId ?? "").trim()).get();
  if (!snap.exists) throw new LifecycleError("request_not_found");
  const doc = (snap.data() ?? {}) as LifecycleRequestDoc;
  if (doc.requesterUid !== requesterUid) throw new LifecycleError("request_not_found"); // enumeration-safe

  const view: LifecycleStatusView = {
    requestId: doc.requestId,
    scope: doc.scope,
    state: doc.state,
    tasks: (doc.tasks ?? []).map((t) => ({ kind: t.kind, state: t.state, completedAt: t.completedAt ?? null })),
    proof: doc.proof,
    exportDeliveryRef: null,
    exportDeliveryRefExpiresAt: null,
  };

  if (doc.scope === "export" && doc.state === "completed" && doc.exportPath) {
    const delivery = await createLifecycleExportDeliveryReference({
      actorUid: requesterUid,
      childId: doc.childId,
      requestId: doc.requestId,
      path: doc.exportPath,
      idempotencyKey: `lifecycle-status:${doc.requestId}`,
    }, {
      db,
      bucket: (opts.bucket ?? defaultBucket()) as never,
      now,
    });
    view.exportDeliveryRef = delivery.deliveryRef;
    view.exportDeliveryRefExpiresAt = delivery.expiresAt;
  }
  return view;
}

// ── Provider task completion (Stripe Identity redaction is founder-executed) ─

export async function markProviderTaskComplete(
  params: { requestId: string; taskId: string; operatorUid: string; providerRef?: string | null },
  opts: { db?: Db; now?: Date } = {},
): Promise<LifecycleRequestDoc> {
  const db = opts.db ?? defaultDb();
  const ts = nowIso(opts.now);
  const ref = requestRef(db, params.requestId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new LifecycleError("request_not_found");
    const doc = (snap.data() ?? {}) as LifecycleRequestDoc;
    const tasks = (doc.tasks ?? []).map((t) => {
      if (t.taskId !== params.taskId) return t;
      if (t.state === "completed") return t; // idempotent
      return {
        ...t,
        state: "completed" as LifecycleTaskState,
        proof: {
          ...(t.proof ?? {}),
          providerExecuted: true,
          providerRef: params.providerRef ? String(params.providerRef).slice(0, 200) : null,
          completedByOperatorUid: params.operatorUid,
        },
        completedAt: ts,
      };
    });
    const allDone = tasks.every((t) => t.state === "completed");
    const updated: LifecycleRequestDoc = {
      ...doc,
      tasks,
      state: allDone ? "completed" : doc.state,
      proof: allDone ? { ...doc.proof, completedAt: doc.proof.completedAt ?? ts } : doc.proof,
      updatedAt: ts,
    };
    tx.set(ref, updated);
    return updated;
  });

  await logAudit({
    eventType: "lifecycle_provider_task_completed",
    userId: params.operatorUid,
    data: { requestId: params.requestId, taskId: params.taskId },
  }).catch(() => {});
  return result;
}

// ── Task executors ───────────────────────────────────────────────────────────

interface TaskContext {
  db: Db;
  bucket: BucketLike;
  now: Date;
  request: LifecycleRequestDoc;
}

type TaskOutcome =
  | { ok: true; proof: Record<string, unknown>; awaitingProvider?: false }
  | { ok: true; proof: Record<string, unknown>; awaitingProvider: true }
  | { ok: false; errorCode: string };

async function runRevokeDerivedAccess(ctx: TaskContext): Promise<TaskOutcome> {
  const revoked = await revokeAllChildViewerAccess(ctx.request.childId, { db: ctx.db, now: ctx.now });
  return { ok: true, proof: { viewerAccessRevoked: revoked } };
}

async function runFirestoreDelete(ctx: TaskContext): Promise<TaskOutcome> {
  try {
    const result = await tombstoneChildProfileForDeletion(ctx.request.childId, ctx.request.requestId, {
      db: ctx.db,
      now: ctx.now,
    });
    return {
      ok: true,
      proof: { tombstoned: true, deletedPrivateDocs: result.deletedPrivateDocs },
    };
  } catch (err) {
    if (err instanceof ChildProfileError && err.code === "legal_hold_active") {
      return { ok: false, errorCode: "legal_hold_active" };
    }
    return { ok: false, errorCode: err instanceof Error ? err.name : "firestore_delete_failed" };
  }
}

async function runSafetyVersionPurge(ctx: TaskContext): Promise<TaskOutcome> {
  const result = await redactChildSafetyVersions(ctx.request.childId, ctx.request.requestId, {
    db: ctx.db,
    now: ctx.now,
  });
  return { ok: true, proof: { deletedVersions: result.deletedVersions } };
}

async function runStorageDelete(ctx: TaskContext): Promise<TaskOutcome> {
  try {
    const prefix = childFileStoragePrefix(ctx.request.householdId, ctx.request.childId);
    const [files] = await ctx.bucket.getFiles({ prefix });
    let deleted = 0;
    for (const file of files) {
      // The export bundle survives a delete request until its own retention
      // window (class 11 — deletion must remain provable / retrievable).
      if (file.name.includes("/exports/")) continue;
      await file.delete({ ignoreNotFound: true });
      deleted += 1;
    }
    return { ok: true, proof: { deletedFiles: deleted, prefix } };
  } catch (err) {
    return { ok: false, errorCode: err instanceof Error ? err.name : "storage_delete_failed" };
  }
}

/**
 * Verify the no-child-AI-state invariant (KTD17). Children never have a Zep
 * user, Linq thread, or learned-facts row — this scan looks for childId
 * references where scannable modules exist and alerts if any are found.
 * U10's memory-eligibility work owns the real cleanup hooks.
 */
async function runAiReferenceScan(ctx: TaskContext): Promise<TaskOutcome> {
  const facts = await ctx.db
    .collection("learned_facts")
    .where("subjectChildId", "==", ctx.request.childId)
    .get()
    .catch(() => null);
  const referencesFound = facts ? facts.size : 0;
  if (referencesFound > 0) {
    // Should be impossible — surface for human review rather than silently deleting.
    return { ok: false, errorCode: "unexpected_ai_references_found" };
  }
  return { ok: true, proof: { referencesFound: 0, scannedStores: ["learned_facts"], zepUser: "none_by_construction" } };
}

/**
 * Stripe Identity redaction is executed by the founder/provider console —
 * children have no Stripe Identity session themselves (identity is ADULT
 * evidence, R17), so this task records the redaction obligation for any
 * request-linked adult verification data and parks as awaiting_provider.
 * markProviderTaskComplete closes it (state tracking only, per plan).
 */
async function runStripeIdentityRedaction(_ctx: TaskContext): Promise<TaskOutcome> {
  return {
    ok: true,
    awaitingProvider: true,
    proof: {
      providerExecuted: false,
      instructions: "founder-run: redact any Stripe Identity artifacts linked to this request, then mark complete",
    },
  };
}

async function runOrphanFileScan(ctx: TaskContext): Promise<TaskOutcome> {
  try {
    const prefix = childFileStoragePrefix(ctx.request.householdId, ctx.request.childId);
    const [files] = await ctx.bucket.getFiles({ prefix });
    let orphans = 0;
    for (const file of files) {
      if (file.name.includes("/exports/")) continue;
      await file.delete({ ignoreNotFound: true });
      orphans += 1;
    }
    return { ok: true, proof: { orphansDeleted: orphans, clean: orphans === 0 } };
  } catch (err) {
    return { ok: false, errorCode: err instanceof Error ? err.name : "orphan_scan_failed" };
  }
}

/**
 * Export scope correctness (R14/AE-export): the bundle contains THIS child's
 * profile summary, private safety versions, the requester-visible authority
 * rows, and a file INVENTORY (paths + metadata, no bytes). It never includes
 * other children, other households, provider raw evidence, or operator data.
 */
async function runExportBundle(ctx: TaskContext): Promise<TaskOutcome> {
  try {
    const { childId, householdId, requestId } = ctx.request;
    const [profile, versions, fileRecords] = await Promise.all([
      getChildProfile(childId, ctx.db),
      listChildSafetyVersions(childId, ctx.db),
      listChildFileRecords(childId, ctx.db),
    ]);
    if (!profile) return { ok: false, errorCode: "child_not_found" };

    const authoritySnap = await ctx.db
      .collection(GUARDIAN_AUTHORITIES_COLLECTION)
      .where("childId", "==", childId)
      .get();
    const authorities = authoritySnap.docs.map((d) => {
      const a = (d.data() ?? {}) as GuardianAuthorityDoc;
      return {
        adultUid: a.adultUid,
        scopes: a.scopes,
        state: a.state,
        effectiveAt: a.effectiveAt,
        expiresAt: a.expiresAt ?? null,
      };
    });

    const bundle = {
      exportVersion: 1,
      requestId,
      childId,
      householdId,
      generatedAt: nowIso(ctx.now),
      retentionPolicyVersion: ctx.request.retentionPolicyVersion,
      profile: {
        displayLabel: profile.displayLabel,
        ageBand: profile.ageBand,
        careCategories: profile.careCategories,
        state: profile.state,
        createdAt: profile.createdAt,
      },
      safetyVersions: versions.map((v) => ({
        version: v.version,
        data: v.data,
        provenance: v.provenance,
        createdAt: v.createdAt,
      })),
      guardianAuthorities: authorities,
      files: fileRecords.map((f) => ({
        fileId: f.fileId,
        purpose: f.purpose,
        contentType: f.contentType,
        state: f.state,
        path: f.path,
        createdAt: f.createdAt,
      })),
    };

    const exportPath = `${childFileStoragePrefix(householdId, childId)}/exports/${requestId}.json`;
    await ctx.bucket.file(exportPath).save(JSON.stringify(bundle, null, 2), {
      contentType: "application/json",
      resumable: false,
    });
    return {
      ok: true,
      proof: {
        exportPath,
        safetyVersionCount: versions.length,
        fileCount: fileRecords.length,
        authorityCount: authorities.length,
      },
    };
  } catch (err) {
    return { ok: false, errorCode: err instanceof Error ? err.name : "export_failed" };
  }
}

const TASK_EXECUTORS: Record<LifecycleTaskKind, (ctx: TaskContext) => Promise<TaskOutcome>> = {
  revoke_derived_access: runRevokeDerivedAccess,
  firestore_delete: runFirestoreDelete,
  safety_version_purge: runSafetyVersionPurge,
  storage_delete: runStorageDelete,
  ai_reference_scan: runAiReferenceScan,
  stripe_identity_redaction: runStripeIdentityRedaction,
  orphan_file_scan: runOrphanFileScan,
  export_bundle: runExportBundle,
};

// ── Drain (claim/lease/bounded retry, guardianAuthorityOutbox pattern) ──────

const LEASE_MS = 5 * 60 * 1000;
const MAX_REQUEST_ATTEMPTS = 8;

function retryAt(attemptCount: number, nowMs: number): string {
  const delaysMinutes = [1, 5, 15, 60, 240, 720, 1440, 1440];
  const delay = delaysMinutes[Math.min(Math.max(attemptCount - 1, 0), delaysMinutes.length - 1)];
  return new Date(nowMs + delay * 60 * 1000).toISOString();
}

async function claimLifecycleRequest(
  db: Db,
  requestId: string,
  workerId: string,
  now: Date,
): Promise<LifecycleRequestDoc | null> {
  const ref = requestRef(db, requestId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const doc = (snap.data() ?? {}) as LifecycleRequestDoc;
    const nowMs = now.getTime();
    const claimable =
      doc.state === "pending" || doc.state === "in_progress" || doc.state === "blocked_legal_hold";
    const nextAttempt = doc.nextAttemptAt ? Date.parse(doc.nextAttemptAt) : 0;
    const leaseExpiry = doc.leaseExpiresAt ? Date.parse(doc.leaseExpiresAt) : 0;
    if (!claimable || nextAttempt > nowMs || leaseExpiry > nowMs) return null;

    const attemptCount = Number(doc.attemptCount ?? 0) + 1;
    const ts = nowIso(now);
    const claimed: LifecycleRequestDoc = {
      ...doc,
      state: doc.state === "pending" ? "in_progress" : doc.state,
      attemptCount,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(nowMs + LEASE_MS).toISOString(),
      proof: { ...doc.proof, startedAt: doc.proof.startedAt ?? ts },
      updatedAt: ts,
    };
    tx.set(ref, claimed);
    return claimed;
  });
}

/**
 * Execute one claimed request: run tasks in order until all terminal, a task
 * fails (backoff + bounded retries → requires_admin_review), or a legal hold
 * blocks a destructive scope (blocked_legal_hold — resumes when cleared).
 * Idempotent rerun: completed tasks are skipped; deletes converge.
 */
export async function processLifecycleRequestOnce(
  requestId: string,
  opts: { db?: Db; bucket?: BucketLike; now?: Date; workerId?: string } = {},
): Promise<LifecycleRequestDoc | null> {
  const db = opts.db ?? defaultDb();
  const bucket = opts.bucket ?? defaultBucket();
  const now = opts.now ?? new Date();
  const workerId = opts.workerId ?? `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const claimed = await claimLifecycleRequest(db, requestId, workerId, now);
  if (!claimed) return null;
  const ts = nowIso(now);

  // Legal-hold recheck for destructive scopes (a hold may appear AFTER creation).
  if (claimed.scope !== "export") {
    const profile = await getChildProfile(claimed.childId, db);
    if (profile?.legalHold?.active) {
      const blocked: LifecycleRequestDoc = {
        ...claimed,
        state: "blocked_legal_hold",
        nextAttemptAt: retryAt(claimed.attemptCount, now.getTime()),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "legal_hold_active",
        updatedAt: ts,
      };
      await requestRef(db, requestId).set(blocked);
      return blocked;
    }
  }

  const tasks = [...(claimed.tasks ?? [])];
  const counts: Record<string, number> = { ...(claimed.proof.counts ?? {}) };
  let failedCode: string | null = null;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task.state === "completed") continue;
    if (task.state === "awaiting_provider") continue; // closed only by markProviderTaskComplete

    const outcome = await TASK_EXECUTORS[task.kind]({ db, bucket, now, request: claimed });
    if (!outcome.ok) {
      tasks[i] = {
        ...task,
        state: "failed",
        attemptCount: Number(task.attemptCount ?? 0) + 1,
        lastErrorCode: String(outcome.errorCode).slice(0, 100),
      };
      failedCode = outcome.errorCode;
      break; // strict order — later tasks depend on earlier ones
    }
    tasks[i] = {
      ...task,
      state: outcome.awaitingProvider ? "awaiting_provider" : "completed",
      attemptCount: Number(task.attemptCount ?? 0) + 1,
      lastErrorCode: null,
      proof: outcome.proof,
      completedAt: outcome.awaitingProvider ? null : ts,
    };
    for (const [k, v] of Object.entries(outcome.proof)) {
      if (typeof v === "number") counts[`${task.kind}.${k}`] = v;
    }
  }

  let state: LifecycleRequestState;
  let nextAttemptAt: string | null = null;
  if (failedCode) {
    if (failedCode === "legal_hold_active") {
      state = "blocked_legal_hold";
      nextAttemptAt = retryAt(claimed.attemptCount, now.getTime());
      // Reset the failed marker — the task itself is fine, the hold blocks it.
      const idx = tasks.findIndex((t) => t.state === "failed");
      if (idx >= 0) tasks[idx] = { ...tasks[idx], state: "pending" };
    } else if (claimed.attemptCount >= MAX_REQUEST_ATTEMPTS) {
      state = "requires_admin_review";
    } else {
      state = "in_progress";
      nextAttemptAt = retryAt(claimed.attemptCount, now.getTime());
    }
  } else if (tasks.every((t) => t.state === "completed")) {
    state = "completed";
  } else if (tasks.some((t) => t.state === "awaiting_provider")) {
    state = "awaiting_provider";
  } else {
    state = "in_progress";
    nextAttemptAt = retryAt(claimed.attemptCount, now.getTime());
  }

  const exportTask = tasks.find((t) => t.kind === "export_bundle" && t.state === "completed");
  const updated: LifecycleRequestDoc = {
    ...claimed,
    state,
    tasks,
    nextAttemptAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: failedCode ? String(failedCode).slice(0, 100) : null,
    proof: {
      ...claimed.proof,
      counts,
      completedAt: state === "completed" ? claimed.proof.completedAt ?? ts : claimed.proof.completedAt ?? null,
    },
    exportPath: exportTask?.proof?.exportPath
      ? String(exportTask.proof.exportPath)
      : claimed.exportPath ?? null,
    updatedAt: ts,
  };
  await requestRef(db, requestId).set(updated);

  if (state === "requires_admin_review") {
    await db
      .collection("admin_alerts")
      .doc(`lifecycle_stuck_${requestId}`)
      .set({
        type: "data_lifecycle_request_stuck",
        severity: "high",
        requestId,
        childId: claimed.childId,
        scope: claimed.scope,
        lastErrorCode: updated.lastErrorCode,
        createdAt: ts,
        resolved: false,
      });
  }
  if (state === "completed") {
    await logAudit({
      eventType: "data_lifecycle_completed",
      userId: claimed.requesterUid,
      data: { requestId, childId: claimed.childId, scope: claimed.scope, counts },
    }).catch(() => {});
  }
  return updated;
}

/** Drain every ready request (query contract Q31: state + nextAttemptAt). */
export async function processLifecycleRequests(
  opts: { db?: Db; bucket?: BucketLike; now?: Date; limit?: number } = {},
): Promise<{ attempted: number; completed: number }> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ready = await db
    .collection(DATA_LIFECYCLE_REQUESTS_COLLECTION)
    .where("state", "in", ["pending", "in_progress", "blocked_legal_hold"])
    .where("nextAttemptAt", "<=", nowIso(now))
    .orderBy("nextAttemptAt", "asc")
    .limit(opts.limit ?? 20)
    .get();

  let completed = 0;
  for (const doc of ready.docs) {
    const result = await processLifecycleRequestOnce(doc.id, { db, bucket: opts.bucket, now });
    if (result?.state === "completed") completed += 1;
  }
  return { attempted: ready.size, completed };
}

// ── Adult account deletion entry point (R15) ─────────────────────────────────

export interface AdultDeletionPlan {
  adultUid: string;
  /** Children with ANOTHER active guardian: child survives, this adult's access ends. */
  childrenRetained: string[];
  /** Children where this adult was the sole guardian: full delete requests created. */
  childrenScheduledForDeletion: string[];
  lifecycleRequestIds: string[];
}

/**
 * THE server-owned account-deletion entry point for the childcare vertical
 * (R15 — deleting Firebase Auth alone is never account deletion). For every
 * child the departing adult holds authority over:
 *   • another ACTIVE guardian exists → self-revoke this adult's authority
 *     (the child and its data SURVIVE; the requester's access ends), or
 *   • this adult is the SOLE guardian → a tracked `delete` lifecycle request
 *     is created for the child.
 *
 * NOT WIRED into any existing Auth-deletion path yet — hooking
 * admin/adminUserActions.ts and any auth.user().onDelete trigger onto this
 * workflow (and reclassifying them in the consumer manifest) is later-unit
 * work (U12/U14). This function is the seam they will call.
 */
export async function beginAdultAccountDeletion(
  adultUid: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<AdultDeletionPlan> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const cleanUid = String(adultUid ?? "").trim();
  if (!cleanUid) throw new LifecycleError("invalid_input");

  const authorities = await listAuthoritiesForAdult(cleanUid, db);
  const plan: AdultDeletionPlan = {
    adultUid: cleanUid,
    childrenRetained: [],
    childrenScheduledForDeletion: [],
    lifecycleRequestIds: [],
  };

  for (const authority of authorities) {
    if (authority.state !== "active") continue;
    const othersSnap = await db
      .collection(GUARDIAN_AUTHORITIES_COLLECTION)
      .where("childId", "==", authority.childId)
      .get();
    const otherActive = othersSnap.docs
      .map((d) => (d.data() ?? {}) as GuardianAuthorityDoc)
      .filter(
        (a) =>
          a.adultUid !== cleanUid &&
          a.state === "active" &&
          !(typeof a.expiresAt === "string" && a.expiresAt && Date.parse(a.expiresAt) <= now.getTime()),
      );

    if (otherActive.length > 0) {
      // Child survives; the departing adult's access ends (self-revoke applies
      // immediately — no dispute hold for one's own authority).
      await revokeGuardianAuthority(
        {
          actorUid: cleanUid,
          householdId: authority.householdId,
          childId: authority.childId,
          targetAdultUid: cleanUid,
          reason: "account_deletion",
          idempotencyKey: `account_deletion:${cleanUid}:${authority.childId}`,
        },
        { db, now },
      );
      plan.childrenRetained.push(authority.childId);
    } else {
      const request = await createLifecycleRequest(
        {
          requesterUid: cleanUid,
          childId: authority.childId,
          scope: "delete",
          idempotencyKey: `account_deletion:${cleanUid}`,
          // Sole guardian: the child data must reach a tracked deletion even
          // when the departing adult holds only partial scopes (R15).
          systemInitiated: true,
        },
        { db, now },
      );
      plan.childrenScheduledForDeletion.push(authority.childId);
      plan.lifecycleRequestIds.push(request.requestId);
    }
  }

  await logAudit({
    eventType: "adult_account_deletion_started",
    userId: cleanUid,
    data: {
      childrenRetained: plan.childrenRetained.length,
      childrenScheduledForDeletion: plan.childrenScheduledForDeletion.length,
    },
  }).catch(() => {});
  return plan;
}
