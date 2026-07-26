import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();
const MAX_REQUESTS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function requiredText(value: unknown, field: string, maxLength = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new functions.https.HttpsError("invalid-argument", `${field} is invalid`);
  }
  return value.trim();
}

export const createVideoInterviewRequest = functions.https.onCall(async (data, context) => {
  const clientId = context.auth?.uid;
  if (!clientId) throw new functions.https.HttpsError("unauthenticated", "Sign in required");

  // Childcare U6 (plan 2026-07-22-002, R35): a typed childcare request routes
  // through the childcare both-sides gate (identity + per-child schedule
  // authority + provider eligibility recheck context "interview" + disclosure
  // policy) instead of the senior flow below. The childcare interview doc is
  // vertical-stamped and carries NO child-sensitive data; calendar/email/SMS
  // content downstream is generic (interviewLinkTrigger childcare branch).
  // Senior requests (no careVertical field) take the exact pre-U6 path.
  if (data?.careVertical === "child") {
    const { getChildcareFlags } = await import("./config/featureFlags");
    const flags = await getChildcareFlags();
    if (!flags.writesEnabled) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Childcare features are not available yet.",
        { code: "childcare_disabled" },
      );
    }
    const ccCaregiverId = requiredText(data?.caregiverId, "caregiverId", 128);
    const ccJobId = requiredText(data?.jobId, "jobId", 128);
    const ccScheduled = requiredText(data?.scheduledTime, "scheduledTime", 64);
    const ccScheduledMs = Date.parse(ccScheduled);
    if (!Number.isFinite(ccScheduledMs) || ccScheduledMs < Date.now() - 5 * 60 * 1000) {
      throw new functions.https.HttpsError("invalid-argument", "scheduledTime must be in the future");
    }
    const { createChildcareInterviewGated } = await import("./childcare/jobCallables");
    const result = await createChildcareInterviewGated({
      actorUid: clientId,
      jobId: ccJobId,
      caregiverId: ccCaregiverId,
      caregiverName: typeof data?.caregiverName === "string" ? data.caregiverName : null,
      scheduledMs: ccScheduledMs,
    });
    return { interview: { id: result.interviewId, careVertical: "child", scheduledTime: result.scheduledTime, status: "requested" } };
  }

  const caregiverId = requiredText(data?.caregiverId, "caregiverId", 128);
  const clientName = requiredText(data?.clientName, "clientName");
  const caregiverName = requiredText(data?.caregiverName, "caregiverName");
  const scheduledTime = requiredText(data?.scheduledTime, "scheduledTime", 64);
  const scheduledMs = Date.parse(scheduledTime);
  if (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() - 5 * 60 * 1000) {
    throw new functions.https.HttpsError("invalid-argument", "scheduledTime must be in the future");
  }

  const caregiver = await db.collection("publicCaregiverProfiles").doc(caregiverId).get();
  if (!caregiver.exists) {
    throw new functions.https.HttpsError("failed-precondition", "Caregiver is not available for interviews");
  }

  const jobId = typeof data?.jobId === "string" && data.jobId.trim() ? data.jobId.trim() : undefined;
  if (jobId) {
    const job = await db.collection("jobs").doc(jobId).get();
    const ownerId = job.data()?.clientId ?? job.data()?.userId ?? job.data()?.createdBy;
    if (!job.exists || ownerId !== clientId) {
      throw new functions.https.HttpsError("permission-denied", "The selected job does not belong to this client");
    }
  }

  const now = admin.firestore.Timestamp.now();
  const limitRef = db.collection("interviewRequestLimits").doc(clientId);
  const interviewRef = db.collection("video_interviews").doc();
  const notes = typeof data?.notes === "string" ? data.notes.slice(0, 2000) : "";
  const interviewType = ["video", "phone", "in-person"].includes(data?.interviewType)
    ? data.interviewType
    : "video";
  const interview = {
    clientId,
    clientName,
    caregiverId,
    caregiverName,
    scheduledTime: new Date(scheduledMs).toISOString(),
    status: "requested",
    createdAt: now.toDate().toISOString(),
    notes,
    interviewType,
    ...(jobId ? { jobId } : {}),
    ...(typeof data?.jobTitle === "string" ? { jobTitle: data.jobTitle.slice(0, 200) } : {}),
    ...(typeof data?.caregiverPhoto === "string" ? { caregiverPhoto: data.caregiverPhoto.slice(0, 2048) } : {}),
    ...(typeof data?.clientPhotoURL === "string" ? { clientPhotoURL: data.clientPhotoURL.slice(0, 2048) } : {}),
  };

  await db.runTransaction(async transaction => {
    const limit = await transaction.get(limitRef);
    const windowStartedAt = limit.data()?.windowStartedAt as admin.firestore.Timestamp | undefined;
    const inWindow = Boolean(windowStartedAt && now.toMillis() - windowStartedAt.toMillis() < DAY_MS);
    const count = inWindow ? Number(limit.data()?.count ?? 0) : 0;
    if (count >= MAX_REQUESTS_PER_DAY) {
      throw new functions.https.HttpsError("resource-exhausted", "Daily interview request limit reached");
    }
    transaction.set(limitRef, {
      count: count + 1,
      windowStartedAt: inWindow ? windowStartedAt : now,
      updatedAt: now,
    });
    transaction.create(interviewRef, interview);
  });

  return { interview: { id: interviewRef.id, ...interview } };
});
