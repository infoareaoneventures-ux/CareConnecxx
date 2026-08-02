import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { createHash } from "crypto";
import type { ChildcareBookingDoc } from "./bookingPolicy";

export const CHILDCARE_SHIFT_GENERATION_OPERATIONS = "childcare_shift_generation_operations";
const MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60 * 1000;

type Db = FirebaseFirestore.Firestore;

/**
 * Durable-operation state machine (claim/lease/terminal convention shared with
 * guardianAuthority's outbox dispatcher and billing/approvalNoticeDispatcher).
 *
 * TERMINAL states are FINAL: once an operation reaches one, no enqueue may ever
 * move it back. The trigger seam (handleChildcareBookingRequestWrite) fires on
 * EVERY booking_requests write, so a non-idempotent enqueue would flip a
 * `completed` operation back to `pending` — dropping createdCount/completedAt,
 * resetting `attempt` (which defeats the bounded-retry cap and the escalation
 * alert), and re-queueing finished work on every subsequent booking write.
 */
export const TERMINAL_SHIFT_GENERATION_STATES = [
  "completed",
  "escalated",
  "skipped",
] as const;

/** Non-terminal states an existing operation may legitimately resume from. */
export const RESUMABLE_SHIFT_GENERATION_STATES = [
  "pending",
  "processing",
  "retryable_failure",
] as const;

export type ShiftGenerationState =
  | (typeof TERMINAL_SHIFT_GENERATION_STATES)[number]
  | (typeof RESUMABLE_SHIFT_GENERATION_STATES)[number];

export function isTerminalShiftGenerationState(state: unknown): boolean {
  return (TERMINAL_SHIFT_GENERATION_STATES as readonly string[]).includes(String(state ?? ""));
}

export function isResumableShiftGenerationState(state: unknown): boolean {
  return (RESUMABLE_SHIFT_GENERATION_STATES as readonly string[]).includes(String(state ?? ""));
}

/** Minimal snapshot shape the enqueue path needs (real or injected fake). */
export interface ShiftGenerationOperationSnapshot {
  exists: boolean;
  data(): FirebaseFirestore.DocumentData | undefined;
}

/**
 * The idempotent enqueue decision, factored out so both the transactional
 * (confirm) and standalone (trigger seam / reconcile) paths share one rule:
 *
 *   • absent OR unrecognized state  → write the full pending doc (create/self-heal)
 *   • terminal state                → NO write at all (no state regression, no
 *                                     counter reset, completedAt/createdCount kept)
 *   • resumable state               → touch `updatedAt` only (attempt, state and
 *                                     nextAttemptAt backoff all preserved)
 */
export function shiftGenerationEnqueuePlan(
  existing: ShiftGenerationOperationSnapshot | null | undefined,
  booking: ChildcareBookingDoc,
  now: Date,
): { action: "create" | "resume" | "noop"; payload: Record<string, unknown> | null } {
  const state = existing?.exists ? existing.data()?.state : undefined;
  if (!existing?.exists || (!isTerminalShiftGenerationState(state) && !isResumableShiftGenerationState(state))) {
    return { action: "create", payload: shiftGenerationOperationDoc(booking, now) };
  }
  if (isTerminalShiftGenerationState(state)) return { action: "noop", payload: null };
  return { action: "resume", payload: { updatedAt: now.toISOString() } };
}

export function shiftGenerationOperationId(bookingId: string, scheduleVersion: number): string {
  return `csg_${createHash("sha256")
    .update(`${bookingId}|${scheduleVersion}`)
    .digest("hex").slice(0, 40)}`;
}

export function shiftGenerationOperationDoc(
  booking: ChildcareBookingDoc,
  now: Date,
): Record<string, unknown> {
  const scheduleVersion = Number(booking.stateVersion ?? 0);
  const operationId = shiftGenerationOperationId(booking.bookingId, scheduleVersion);
  return {
    schemaVersion: "childcare-shift-generation-v1",
    careVertical: "child",
    operationId,
    bookingId: booking.bookingId,
    scheduleVersion,
    state: "pending",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: now.toISOString(),
    lastErrorCode: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/**
 * Read the operation doc INSIDE a transaction. Must be called BEFORE any of the
 * transaction's writes (Firestore requires all reads first), which is why the
 * read is a separate exported step rather than living inside
 * `enqueueShiftGenerationInTransaction`.
 */
export async function readShiftGenerationOperationInTransaction(
  tx: Pick<FirebaseFirestore.Transaction, "get">,
  db: Pick<Db, "collection">,
  booking: ChildcareBookingDoc,
): Promise<ShiftGenerationOperationSnapshot> {
  const operationId = shiftGenerationOperationId(
    booking.bookingId,
    Number(booking.stateVersion ?? 0),
  );
  const ref = db.collection(CHILDCARE_SHIFT_GENERATION_OPERATIONS).doc(operationId);
  return (await tx.get(
    ref as FirebaseFirestore.DocumentReference,
  )) as unknown as ShiftGenerationOperationSnapshot;
}

/**
 * Idempotent enqueue inside an existing transaction. `existing` is the snapshot
 * from `readShiftGenerationOperationInTransaction` (read before the writes) —
 * a terminal operation is left completely untouched.
 */
export function enqueueShiftGenerationInTransaction(
  tx: FirebaseFirestore.Transaction,
  db: Pick<Db, "collection">,
  booking: ChildcareBookingDoc,
  now: Date,
  existing: ShiftGenerationOperationSnapshot | null,
): string {
  const operationId = shiftGenerationOperationId(
    booking.bookingId,
    Number(booking.stateVersion ?? 0),
  );
  const plan = shiftGenerationEnqueuePlan(existing, booking, now);
  if (plan.action !== "noop" && plan.payload) {
    tx.set(
      db.collection(CHILDCARE_SHIFT_GENERATION_OPERATIONS).doc(operationId),
      plan.payload,
      { merge: true },
    );
  }
  return operationId;
}

/**
 * Idempotent enqueue for the trigger seam and the reconciler. Transactional
 * read-then-write: replaying it against a `completed`/`escalated`/`skipped`
 * operation is a genuine no-op (no state regression, no attempt reset, no loss
 * of createdCount/completedAt); a `pending`/`processing`/`retryable_failure`
 * operation stays exactly as resumable as it was.
 */
export async function enqueueShiftGenerationOperation(
  booking: ChildcareBookingDoc,
  opts: { db?: Db; now?: Date } = {},
): Promise<string> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const operationId = shiftGenerationOperationId(
    booking.bookingId,
    Number(booking.stateVersion ?? 0),
  );
  const ref = db.collection(CHILDCARE_SHIFT_GENERATION_OPERATIONS).doc(operationId);
  await db.runTransaction(async (tx) => {
    const existing = (await tx.get(ref)) as unknown as ShiftGenerationOperationSnapshot;
    const plan = shiftGenerationEnqueuePlan(existing, booking, now);
    if (plan.action === "noop" || !plan.payload) return;
    tx.set(ref, plan.payload, { merge: true });
  });
  return operationId;
}

function nextAttempt(now: Date, attempt: number): string {
  return new Date(now.getTime() + Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** attempt))).toISOString();
}

export async function processShiftGenerationOperation(
  operationId: string,
  opts: { db?: Db; now?: Date; workerId?: string } = {},
): Promise<"completed" | "retryable_failure" | "escalated" | "skipped"> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const ref = db.collection(CHILDCARE_SHIFT_GENERATION_OPERATIONS).doc(operationId);
  const claimed = await db.runTransaction<FirebaseFirestore.DocumentData | null>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const op: FirebaseFirestore.DocumentData = snap.data() ?? {};
    if (isTerminalShiftGenerationState(op.state)) return null;
    if (op.state === "processing" && op.leaseExpiresAt > now.toISOString()) return null;
    const attempt = Number(op.attempt ?? 0) + 1;
    tx.update(ref, {
      state: "processing",
      attempt,
      leaseOwner: opts.workerId ?? `worker-${process.pid}`,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      updatedAt: now.toISOString(),
    });
    return { ...op, attempt };
  });
  if (!claimed) {
    return ((await ref.get()).data()?.state ?? "skipped") as "completed" | "escalated" | "skipped";
  }

  try {
    const bookingId = String(claimed.bookingId ?? "");
    const bookingSnap = await db.collection("booking_requests").doc(bookingId).get();
    const booking = bookingSnap.data() as ChildcareBookingDoc | undefined;
    if (
      !bookingSnap.exists ||
      booking?.careVertical !== "child" ||
      !["confirmed", "in_progress"].includes(booking.status) ||
      Number(booking.stateVersion ?? 0) < Number(claimed.scheduleVersion ?? 0)
    ) {
      await ref.update({
        state: "skipped", leaseOwner: null, leaseExpiresAt: null,
        nextAttemptAt: null, updatedAt: now.toISOString(),
      });
      return "skipped";
    }
    const { generateChildcareShiftsForBooking } = await import("./bookingCallables");
    const created = await generateChildcareShiftsForBooking(
      { ...booking, bookingId },
      { db, now, weeksAhead: 2 },
    );
    await ref.update({
      state: "completed", createdCount: created,
      leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
      completedAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    return "completed";
  } catch (error) {
    const attempt = Number(claimed.attempt ?? 1);
    const exhausted = attempt >= MAX_ATTEMPTS;
    await ref.update({
      state: exhausted ? "escalated" : "retryable_failure",
      leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: exhausted ? null : nextAttempt(now, attempt),
      lastErrorCode: error instanceof Error ? error.name.slice(0, 80) : "unknown",
      updatedAt: now.toISOString(),
    });
    if (exhausted) {
      await db.collection("admin_alerts").doc(`shift_generation_${operationId}`).set({
        type: "childcare_shift_generation_retry_exhausted",
        careVertical: "child", operationId, bookingId: claimed.bookingId ?? null,
        severity: "critical", resolved: false, createdAt: now.toISOString(),
      }, { merge: true });
      return "escalated";
    }
    throw error;
  }
}

export async function reconcileAndProcessChildcareShiftGeneration(
  opts: { db?: Db; now?: Date; limit?: number } = {},
): Promise<{ bookings: number; enqueued: number; processed: number; failed: number }> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
  const bookingSnap = await db.collection("booking_requests")
    .where("careVertical", "==", "child")
    .where("status", "in", ["confirmed", "in_progress"])
    .limit(limit).get();
  let enqueued = 0;
  for (const doc of bookingSnap.docs) {
    const booking = { ...(doc.data() as ChildcareBookingDoc), bookingId: doc.id };
    const operationId = shiftGenerationOperationId(doc.id, Number(booking.stateVersion ?? 0));
    const ref = db.collection(CHILDCARE_SHIFT_GENERATION_OPERATIONS).doc(operationId);
    if (!(await ref.get()).exists) {
      await enqueueShiftGenerationOperation(booking, { db, now });
      enqueued += 1;
    }
  }

  const operationSnap = await db.collection(CHILDCARE_SHIFT_GENERATION_OPERATIONS)
    .where("state", "in", ["pending", "retryable_failure", "processing"])
    .limit(limit).get();
  let processed = 0;
  let failed = 0;
  for (const doc of operationSnap.docs) {
    const op = doc.data();
    if (op.state === "retryable_failure" && op.nextAttemptAt > now.toISOString()) continue;
    try {
      await processShiftGenerationOperation(doc.id, { db, now });
      processed += 1;
    } catch {
      failed += 1;
    }
  }
  await db.collection("childcare_reconciliation_runs").add({
    type: "shift_generation", bookingCount: bookingSnap.size,
    enqueued, processed, failed, createdAt: now.toISOString(),
  });
  return { bookings: bookingSnap.size, enqueued, processed, failed };
}

export const processChildcareShiftGeneration = functions.pubsub
  .schedule("every 15 minutes")
  .onRun(async () => reconcileAndProcessChildcareShiftGeneration());
