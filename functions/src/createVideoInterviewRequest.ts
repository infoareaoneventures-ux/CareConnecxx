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
  const clientId = context.auth?.uid;
  if (!clientId) throw new functions.https.HttpsError("unauthenticated", "Sign in required");

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
    return { interview };
  } catch (err) {
    if (err instanceof VideoInterviewRequestError) {
      throw new functions.https.HttpsError(err.code, err.message);
    }
    throw err;
  }
});
