import * as functions from "firebase-functions/v1";
import { requestVideoInterview, VideoInterviewRequestError } from "./agents/videoInterviewRequest";

function requiredText(value: unknown, field: string, maxLength = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new functions.https.HttpsError("invalid-argument", `${field} is invalid`);
  }
  return value.trim();
}

// Thin validation + auth wrapper — the actual caregiver-eligibility check,
// job-ownership check, rate limit, and video_interviews write all live in
// the shared requestVideoInterview (agents/videoInterviewRequest.ts), which
// Evia's schedule_interview / respond_to_job_application MCP tools use too.
export const createVideoInterviewRequest = functions.https.onCall(async (data, context) => {
  const callerId = context.auth?.uid;
  if (!callerId) throw new functions.https.HttpsError("unauthenticated", "Sign in required");
  // Admin assist (2026-10-22): an admin acting for a family during the person's open consent
  // window requests the interview AS the family (the record is the family's); the action is
  // logged under the admin's name and the family is told.
  const actingForUid = typeof data?.actingForUid === "string" && data.actingForUid.trim() ? data.actingForUid.trim() : null;
  let clientId = callerId;
  if (actingForUid && actingForUid !== callerId) {
    const { assistWindowOpenFor } = await import("./agents/adminAssist");
    if (!(await assistWindowOpenFor(actingForUid, callerId))) {
      throw new functions.https.HttpsError("permission-denied", "No open consent window for this person");
    }
    clientId = actingForUid;
  }

  const caregiverId = requiredText(data?.caregiverId, "caregiverId", 128);
  const scheduledTime = requiredText(data?.scheduledTime, "scheduledTime", 64);
  const jobId = typeof data?.jobId === "string" && data.jobId.trim() ? data.jobId.trim() : undefined;
  const jobTitle = typeof data?.jobTitle === "string" ? data.jobTitle : undefined;
  const notes = typeof data?.notes === "string" ? data.notes : undefined;
  const interviewType = typeof data?.interviewType === "string" ? data.interviewType : undefined;

  try {
    const interview = await requestVideoInterview({
      clientId, caregiverId, scheduledTime, jobId, jobTitle, notes, interviewType,
      source: "web",
    });
    if (actingForUid && clientId !== callerId) {
      const { recordAdminActed } = await import("./agents/adminAssist");
      const admin = await import("firebase-admin");
      const adminDoc = (await admin.firestore().collection("users").doc(callerId).get()).data() ?? {};
      const personDoc = (await admin.firestore().collection("users").doc(clientId).get()).data() ?? {};
      await recordAdminActed({
        uid: clientId, role: "client", adminUid: callerId,
        adminName: String(adminDoc.displayName ?? adminDoc.firstName ?? adminDoc.email ?? callerId),
        kind: "interview_requested", summary: "requested an interview with a care provider",
        sourcePath: `video_interviews/${interview.id}`, eventId: `acted_${interview.id}`,
        ...(typeof personDoc.phone === "string" ? { phone: personDoc.phone } : {}),
      }).catch((err) => console.warn("createVideoInterviewRequest: acted record failed", err instanceof Error ? err.message : err));
    }
    return { interview };
  } catch (err) {
    if (err instanceof VideoInterviewRequestError) {
      // "ambiguous" is Evia's name-lookup code, not a Functions error code — HttpsError
      // throws "Unknown error code" on it, which would surface as an opaque internal error.
      const code = err.code === "ambiguous" ? "failed-precondition" : err.code;
      throw new functions.https.HttpsError(code, err.message);
    }
    throw err;
  }
});
