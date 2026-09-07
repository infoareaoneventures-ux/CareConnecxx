import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// Firestore-trigger workaround for the same GCP org-policy wall documented in
// project memory and triggers/accountActionQueue.ts (careconnex-d4c8b blocks
// granting public invoker IAM to brand-new Cloud Functions). The website
// writes a request doc directly to Firestore (allowed by firestore.rules, no
// Cloud Function call needed for that write) instead of calling a fresh
// onCall function; this trigger — Firestore-triggered, so it never needs
// public invoker IAM — picks it up and runs the real logic in
// functions/src/agents/interviewResponse.ts, the same shared function Evia's
// respond_to_interview_request MCP tool already uses.

type InterviewActionType = "respond_to_interview";

export const processInterviewActionQueue = functions.firestore
  .document("interview_action_requests/{requestId}")
  .onCreate(async (snap) => {
    const data = snap.data() as Record<string, unknown>;
    const type = data.type as InterviewActionType;

    try {
      const result = await dispatch(type, data);
      await snap.ref.update({
        status: "done",
        result: result ?? { success: true },
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

async function dispatch(type: InterviewActionType, data: Record<string, unknown>): Promise<Record<string, unknown> | void> {
  const { respondToInterviewRequest } = await import("../agents/interviewResponse");

  switch (type) {
    case "respond_to_interview": {
      const result = await respondToInterviewRequest({
        caregiverId: String(data.caregiverId ?? ""),
        interviewId: String(data.interviewId ?? ""),
        decision: data.decision === "accept" ? "accept" : "decline",
        proposedDate: data.proposedDate as string | undefined,
        proposedTime: data.proposedTime as string | undefined,
        message: data.message as string | undefined,
        source: "web",
      });
      return result as unknown as Record<string, unknown>;
    }

    default:
      throw new Error(`Unknown interview action type: ${String(type)}`);
  }
}
