import * as admin from "firebase-admin";
import { parseScheduledTimeMs } from "../utils/scheduledTime";
import { sendToPhone } from "../linq/client";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

// Single source of truth for a caregiver responding to an interview request —
// used by BOTH Evia's respond_to_interview_request MCP tool and the website's
// caregiver dashboard (via respondToInterviewRequestWeb, the interview action
// queue). Before 2026-09-06 only Evia could record a counter-proposed time
// (proposedDate/proposedTime) — the website's own direct Firestore write path
// has no way to set that field (firestore.rules' allowed-keys list for
// video_interviews never included it), so a caregiver using the website could
// only Accept or Decline outright, never propose a different time. Unifying
// here means the website gets real parity instead of a second, easily-drifting
// implementation.

export type InterviewResponseErrorCode = "not-found" | "permission-denied" | "invalid-argument";

export class InterviewResponseError extends Error {
  code: InterviewResponseErrorCode;
  constructor(code: InterviewResponseErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RespondToInterviewParams {
  caregiverId: string;
  interviewId: string;
  decision: "accept" | "decline";
  /** Only meaningful with decision:"decline" — a counter-proposed time. */
  proposedDate?: string;
  proposedTime?: string;
  /** Optional free-text note when declining with no counter-proposal. */
  message?: string;
  /** Caller identity for the audit log ("web" or an MCP tool name). */
  source: string;
}

export interface RespondToInterviewResult {
  status: "accepted" | "declined";
  interviewId: string;
  callUrl: string | null;
  proposedTime: string | null;
}

export async function respondToInterviewRequest(
  params: RespondToInterviewParams,
): Promise<RespondToInterviewResult> {
  const { caregiverId, interviewId, decision, proposedDate, proposedTime, message, source } = params;

  const ivRef = db.collection("video_interviews").doc(interviewId);
  const ivSnap = await ivRef.get();
  if (!ivSnap.exists) throw new InterviewResponseError("not-found", "Interview not found");
  const iv = ivSnap.data()!;
  if (iv.caregiverId !== caregiverId) {
    throw new InterviewResponseError("permission-denied", "Interview does not belong to this caregiver");
  }

  // "accepted" — matches the website's own accept action (videoService.ts's
  // acceptInterview) exactly, not "confirmed": onVideoInterviewWrite's client
  // in-app-notification branch only checks for that exact string.
  const newStatus: "accepted" | "declined" = decision === "accept" ? "accepted" : "declined";
  const nowIso = new Date().toISOString();
  // respondedViaAgent: this function always sends its own SMS below (for both
  // the accept and decline-with-proposal cases), so onVideoInterviewWrite's
  // decline branch (notificationTriggers.ts) checks this flag to skip its own
  // generic text and avoid double-texting the client — regardless of whether
  // this call came from Evia or the website.
  const upd: Record<string, unknown> = { status: newStatus, respondedAt: nowIso, respondedViaAgent: true };

  let proposedIso: string | null = null;
  if (proposedDate && proposedTime) {
    const proposedMs = parseScheduledTimeMs(`${proposedDate}T${proposedTime}:00`);
    proposedIso = Number.isNaN(proposedMs) ? `${proposedDate}T${proposedTime}:00` : new Date(proposedMs).toISOString();
    upd.proposedTime = proposedIso;
  }
  await ivRef.update(upd);

  // Accept: the family's one text is the confirmed-time + Meet link message from
  // interviewLinkTrigger.ts, which fires on this same status change. Only the
  // decline outcomes are texted from here.
  const clientSess = decision === "accept"
    ? null
    : await db.collection("agent_sessions").where("userId", "==", iv.clientId).limit(1).get();
  if (clientSess && !clientSess.empty) {
    const cgData = (await db.collection("caregivers").doc(caregiverId).get()).data();
    const cgName = cgData?.name ?? "The caregiver";
    const notifyMsg = proposedDate
      ? `${cgName} can't make the original time but is free ${proposedDate} at ${proposedTime ?? ""}. Reply YES to book that time, or send another time.`
      : `${cgName} isn't available for the interview. ${message ?? ""}`.trim();
    await sendToPhone(clientSess.docs[0].id, notifyMsg).catch(() => {});
    // The website's Interviews card offers "Accept this time" / "Propose another
    // time" on a declined-with-counter interview; over text the family's reply
    // lands on agents/interviewCounterReply.ts, which makes the same new request.
    if (proposedIso) {
      await db.collection("agent_sessions").doc(clientSess.docs[0].id).set({
        pendingInterviewCounter: {
          interviewId, caregiverId, caregiverName: cgName, proposedTime: proposedIso,
          ...(iv.jobId ? { jobId: String(iv.jobId) } : {}),
          ...(iv.jobTitle ? { jobTitle: String(iv.jobTitle) } : {}),
        },
        pendingInterviewCounterSetAt: nowIso,
      }, { merge: true }).catch(() => {});
    }
  }

  logAudit({
    eventType: "interview_responded",
    userId: caregiverId,
    data: { source, interviewId, decision },
  }).catch(() => {});

  return {
    status: newStatus,
    interviewId,
    callUrl: (iv.callUrl as string | undefined) ?? null,
    proposedTime: proposedIso,
  };
}
