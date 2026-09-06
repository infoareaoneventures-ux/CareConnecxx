import * as admin from "firebase-admin";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

// Single source of truth for creating a video_interviews "requested" doc —
// used by BOTH the website's ScheduleInterviewModal (via the
// createVideoInterviewRequest callable) and Evia's schedule_interview /
// respond_to_job_application MCP tools. Before 2026-09-06 these were two
// independent implementations: Evia's never checked caregiver bookability
// (read straight from `caregivers`, no publicCaregiverProfiles gate) and had
// no daily rate limit, unlike the site's real flow. Unifying here means a
// future rule change (limit, eligibility, fields) can't drift between the two
// again.

const MAX_REQUESTS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export type VideoInterviewErrorCode =
  | "invalid-argument"
  | "failed-precondition"
  | "permission-denied"
  | "resource-exhausted";

export class VideoInterviewRequestError extends Error {
  code: VideoInterviewErrorCode;
  constructor(code: VideoInterviewErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RequestVideoInterviewParams {
  clientId: string;
  caregiverId: string;
  /** ISO timestamp — already combined date+time, must be in the future. */
  scheduledTime: string;
  notes?: string;
  jobId?: string;
  jobTitle?: string;
  interviewType?: string;
  /** Evia-only linkage (job_applications) — the site has no equivalent. */
  applicationId?: string;
  /** Caller identity for the audit log ("web" or a tool name). */
  source: string;
}

export interface VideoInterviewRequestResult {
  id: string;
  clientId: string;
  caregiverId: string;
  clientName: string;
  caregiverName: string;
  scheduledTime: string;
  status: "requested";
  createdAt: string;
  notes: string;
  interviewType: string;
  jobId?: string;
  jobTitle?: string;
  caregiverPhoto?: string;
  clientPhotoURL?: string;
  applicationId?: string;
}

export async function requestVideoInterview(
  params: RequestVideoInterviewParams,
): Promise<VideoInterviewRequestResult> {
  const { clientId, caregiverId, jobId, applicationId, source } = params;

  const scheduledMs = Date.parse(params.scheduledTime);
  if (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() - 5 * 60 * 1000) {
    throw new VideoInterviewRequestError("invalid-argument", "scheduledTime must be in the future");
  }
  const interviewType = ["video", "phone", "in-person"].includes(params.interviewType ?? "")
    ? (params.interviewType as string)
    : "video";
  const notes = (params.notes ?? "").slice(0, 2000);

  // Same bookability gate the website enforces (createVideoInterviewRequest.ts)
  // — only a caregiver visible in the public, verification-gated projection is
  // interview-able. Also doubles as the name/photo source, so this is the
  // ONLY caregiver read needed (Evia's old implementation read `caregivers`
  // directly, with no eligibility check at all).
  const caregiverSnap = await db.collection("publicCaregiverProfiles").doc(caregiverId).get();
  if (!caregiverSnap.exists) {
    throw new VideoInterviewRequestError("failed-precondition", "Caregiver is not available for interviews");
  }
  const cg = caregiverSnap.data() ?? {};
  const caregiverName = ((cg.name as string) || `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Caregiver";
  const caregiverPhoto = (cg.photoURL ?? cg.photo ?? cg.imageUrl) as string | undefined;

  const clientSnap = await db.collection("users").doc(clientId).get();
  const cl = clientSnap.data() ?? {};
  const clientName = ((cl.name as string) || `${cl.firstName ?? ""} ${cl.lastName ?? ""}`.trim()) || "A family";
  const clientPhotoURL = cl.photoURL as string | undefined;

  // Auto-derived from the job doc itself rather than trusting a caller-
  // supplied title — Evia's schedule_interview tool only ever has a jobId to
  // work with (it has no reason to already know the post's title), so
  // deriving it here means the tool doesn't need a redundant jobTitle input.
  let resolvedJobTitle = params.jobTitle;
  if (jobId) {
    const job = await db.collection("job_posts").doc(jobId).get();
    const ownerId = job.data()?.clientId ?? job.data()?.userId ?? job.data()?.createdBy;
    if (!job.exists || ownerId !== clientId) {
      throw new VideoInterviewRequestError("permission-denied", "The selected job does not belong to this client");
    }
    resolvedJobTitle = (job.data()?.title as string | undefined) ?? resolvedJobTitle;
  }

  const now = admin.firestore.Timestamp.now();
  const limitRef = db.collection("interviewRequestLimits").doc(clientId);
  const interviewRef = db.collection("video_interviews").doc();
  const interview: VideoInterviewRequestResult = {
    id: interviewRef.id,
    clientId, clientName, caregiverId, caregiverName,
    scheduledTime: new Date(scheduledMs).toISOString(),
    status: "requested",
    createdAt: now.toDate().toISOString(),
    notes,
    interviewType,
    ...(jobId ? { jobId } : {}),
    ...(resolvedJobTitle ? { jobTitle: resolvedJobTitle.slice(0, 200) } : {}),
    ...(caregiverPhoto ? { caregiverPhoto: caregiverPhoto.slice(0, 2048) } : {}),
    ...(clientPhotoURL ? { clientPhotoURL: clientPhotoURL.slice(0, 2048) } : {}),
    ...(applicationId ? { applicationId } : {}),
  };
  const { id: _omitId, ...docData } = interview;

  await db.runTransaction(async (transaction) => {
    const limit = await transaction.get(limitRef);
    const windowStartedAt = limit.data()?.windowStartedAt as admin.firestore.Timestamp | undefined;
    const inWindow = Boolean(windowStartedAt && now.toMillis() - windowStartedAt.toMillis() < DAY_MS);
    const count = inWindow ? Number(limit.data()?.count ?? 0) : 0;
    if (count >= MAX_REQUESTS_PER_DAY) {
      throw new VideoInterviewRequestError("resource-exhausted", "Daily interview request limit reached");
    }
    transaction.set(limitRef, {
      count: count + 1,
      windowStartedAt: inWindow ? windowStartedAt : now,
      updatedAt: now,
    });
    transaction.create(interviewRef, docData);
  });

  if (applicationId) {
    await db.collection("job_applications").doc(applicationId).update({ interviewId: interviewRef.id }).catch(() => {});
  }

  logAudit({
    eventType: "interview_scheduled",
    userId: clientId,
    data: { source, interviewId: interviewRef.id, caregiverId, scheduledTime: interview.scheduledTime },
  }).catch(() => {});

  return interview;
}
