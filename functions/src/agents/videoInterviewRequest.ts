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
  | "resource-exhausted"
  // 2026-09-09: the name-fallback lookup below can find MORE than one match
  // within this family's own shownCaregiverIds (two caregivers they were
  // shown genuinely share a name) — that's not the same failure as no match
  // at all, and collapsing both into one generic "not available" error left
  // the agent with nothing to ask the family other than a dead end.
  | "ambiguous";

export class VideoInterviewRequestError extends Error {
  code: VideoInterviewErrorCode;
  /** Populated only for code "ambiguous" — the tied candidates, so the
   *  caller can ask the family to pick one instead of guessing. */
  candidates?: Array<{ id: string; hourlyRate: number }>;
  constructor(code: VideoInterviewErrorCode, message: string, candidates?: Array<{ id: string; hourlyRate: number }>) {
    super(message);
    this.code = code;
    this.candidates = candidates;
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
  /** Evia-only — scopes the name-fallback lookup (see below) to caregivers
   *  this specific family has actually been shown. The website never needs
   *  this: it always passes a real id from its own UI selection. */
  phone?: string;
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
  const { clientId, caregiverId, jobId, applicationId, source, phone } = params;

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
  let caregiverSnap = await db.collection("publicCaregiverProfiles").doc(caregiverId).get();
  // 2026-09-09 (live-caught): Evia doesn't always have the caregiver's real
  // id in context when this is called (e.g. referencing someone named several
  // turns earlier, with no fresh search in between) and falls back to passing
  // their NAME as caregiverId — which can never resolve as a doc id and fails
  // identically regardless of date/time tried. Real Firestore auto-ids never
  // contain a space, so a space-containing "id" is unambiguously a name, not
  // a lookup miss.
  // SAFETY (caught before shipping): a bare, unscoped `where("name", "==", …)`
  // across the whole platform risks matching a same-named STRANGER instead of
  // the caregiver the family actually meant — worse than the original bug.
  // Scope strictly to this family's own shownCaregiverIds (every caregiver
  // this client has actually been shown, via matchingAgent.ts) and require a
  // UNIQUE match within that small set; anything ambiguous or unscoped fails
  // closed rather than guessing. No `phone` (e.g. the website, which never
  // hits this path — it always passes a real id) also fails closed.
  if (!caregiverSnap.exists && caregiverId.includes(" ") && phone) {
    const sessSnap = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    const shownIds = ((sessSnap?.data()?.shownCaregiverIds as string[] | undefined) ?? []).slice(0, 30);
    if (shownIds.length > 0) {
      const scoped = await db.collection("publicCaregiverProfiles")
        .where(admin.firestore.FieldPath.documentId(), "in", shownIds)
        .get().catch(() => null);
      const matches = (scoped?.docs ?? []).filter((d) => (d.data()?.name as string | undefined) === caregiverId);
      if (matches.length === 1) {
        caregiverSnap = matches[0];
      } else if (matches.length > 1) {
        throw new VideoInterviewRequestError(
          "ambiguous",
          `This family has been shown ${matches.length} caregivers named "${caregiverId}" — ask which one they mean, then retry with the correct caregiverId.`,
          matches.map((d) => ({ id: d.id, hourlyRate: (d.data().hourlyRate as number | undefined) ?? 0 })),
        );
      }
    }
  }
  if (!caregiverSnap.exists) {
    throw new VideoInterviewRequestError("failed-precondition", "Caregiver is not available for interviews");
  }
  // The real doc id, whichever lookup found it — every downstream write and
  // the returned result must use this, never the original `caregiverId` param
  // (which, on the name-fallback path above, is a name, not a real id).
  const resolvedCaregiverId = caregiverSnap.id;
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
    clientId, clientName, caregiverId: resolvedCaregiverId, caregiverName,
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
    // 2026-09-06: the cap is meant to stop a client from blasting requests at
    // many DIFFERENT caregivers in one day, not to cap legitimate back-and-forth
    // scheduling with a caregiver they're already talking to (e.g. Evia relaying
    // a caregiver's counter-proposed time and re-submitting once the family
    // agrees) — every round of that negotiation is a fresh request to the SAME
    // caregiverId, and used to burn the same daily quota as spamming five
    // strangers. Track distinct caregiverIds contacted today instead of a raw
    // count: a caregiver already in today's set never counts against the cap.
    const caregiverIds: string[] = inWindow
      ? ((limit.data()?.caregiverIds as string[] | undefined) ?? [])
      : [];
    const alreadyContactedToday = caregiverIds.includes(resolvedCaregiverId);
    if (!alreadyContactedToday && caregiverIds.length >= MAX_REQUESTS_PER_DAY) {
      throw new VideoInterviewRequestError("resource-exhausted", "Daily interview request limit reached");
    }
    transaction.set(limitRef, {
      caregiverIds: alreadyContactedToday ? caregiverIds : [...caregiverIds, resolvedCaregiverId],
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
    data: { source, interviewId: interviewRef.id, caregiverId: resolvedCaregiverId, scheduledTime: interview.scheduledTime },
  }).catch(() => {});

  return interview;
}
