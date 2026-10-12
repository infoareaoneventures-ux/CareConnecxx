import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// Firestore-trigger workaround for the same GCP org-policy wall documented in
// triggers/accountActionQueue.ts and triggers/interviewActionQueue.ts
// (careconnex-d4c8b blocks granting public invoker IAM to brand-new Cloud
// Functions). The website's Start Shift / End / ✕ / Cancel Booking / Log Hours
// buttons write a request doc here (allowed by firestore.rules for the signed-in
// caregiver named on it) and this trigger runs the ONE server implementation in
// shifts/visitActions.ts — the same functions Evia's START / FINISH / CANCEL /
// LOG flows call — as admin. The caregiver can no longer write those statuses
// on shifts/{id} directly (firestore.rules, 2026-10-11).
//
// A sibling of account_action_requests rather than a new action set on it:
// that collection is world-readable (its unauthenticated recovery flows need
// it) and these requests carry visit notes and task lists, which only the
// caregiver should read back.
//
// Settlement: every request ends `status: 'done'` with `result` = the typed
// outcome — `{ ok: true, … }` or `{ ok: false, reason, message }` (a refusal is
// a normal outcome the page shows in its toast); `status: 'error'` only for an
// unexpected throw.

export type VisitActionType = "start_visit" | "end_visit" | "cancel_visit" | "cancel_booking" | "log_hours";

export const processVisitActionQueue = functions.firestore
  .document("visit_action_requests/{requestId}")
  .onCreate(async (snap) => {
    const data = snap.data() as Record<string, unknown>;
    const type = data.type as VisitActionType;

    try {
      const result = await dispatch(type, data);
      await snap.ref.update({
        status: "done",
        result,
        error: null,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      await snap.ref.update({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function dispatch(type: VisitActionType, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const caregiverId = str(data.caregiverId);
  const shiftId = str(data.shiftId);
  if (!caregiverId) throw new Error("caregiverId is required");
  if (!shiftId) throw new Error("shiftId is required");
  const actions = await import("../shifts/visitActions");

  switch (type) {
    case "start_visit": {
      const r = await actions.startVisit({ caregiverId, shiftId });
      return r.ok ? { ok: true, shiftId: r.shiftId, status: "in-progress", alreadyStarted: r.alreadyStarted, startedAt: r.startedAt } : refusal(r);
    }
    case "end_visit": {
      const r = await actions.endVisit({ caregiverId, shiftId, closingNote: str(data.closingNote) });
      return r.ok ? { ok: true, shiftId: r.shiftId, status: "completed", alreadyCompleted: r.alreadyCompleted, completedAt: r.completedAt } : refusal(r);
    }
    case "cancel_visit": {
      const r = await actions.cancelVisit({ caregiverId, shiftId, cancelledBy: "caregiver" });
      return r.ok ? { ok: true, shiftId: r.shiftId, status: r.status } : refusal(r);
    }
    case "cancel_booking": {
      const r = await actions.cancelBooking({ caregiverId, shiftId });
      return r.ok ? { ok: true, shiftId: r.shiftId, anyUrgent: r.anyUrgent, count: r.count } : refusal(r);
    }
    case "log_hours": {
      const startedAtMs = Date.parse(str(data.startedAt));
      const completedAtMs = Date.parse(str(data.completedAt));
      const tasksCompleted = Array.isArray(data.tasksCompleted) ? (data.tasksCompleted as unknown[]).filter((k): k is string => typeof k === "string") : [];
      const r = await actions.logHours({ caregiverId, shiftId, startedAtMs, completedAtMs, tasksCompleted, completionNotes: str(data.completionNotes) });
      return r.ok ? { ok: true, shiftId: r.shiftId, status: "completed" } : refusal(r);
    }
    default:
      throw new Error(`Unknown visit action type: ${String(type)}`);
  }
}

function refusal(r: { reason: string; message: string; status?: string }): Record<string, unknown> {
  return { ok: false, reason: r.reason, message: r.message, ...(r.status ? { status: r.status } : {}) };
}
