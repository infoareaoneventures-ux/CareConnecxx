import * as admin from "firebase-admin";
import { logAudit } from "../observability/auditLog";
import { PENDING_STATUSES } from "./caregiverInterviewsTab";

const db = admin.firestore();

// A caregiver's Accept / Decline on an interview request — the Interviews tab's
// two buttons (components/caregiver/JobBoard.tsx handleAcceptInterview /
// handleDeclineInterview), as one function used by Evia's
// respond_to_interview_request tool and the website's interview action queue.
//
// 2026-09-27 (founder: Evia must not have paths the site doesn't): the
// decline-with-counter-offer that used to live here (proposedDate/Time →
// "Reply YES to book that time" → a NEW interview) is gone. Moving an interview
// is the site's Propose new time / Accept new time on the SAME record
// (reschedule_interview / accept_interview_reschedule). Nothing is texted from
// here: onVideoInterviewWrite (notificationTriggers.ts) writes the family's bell
// + text for a decline, and interviewLinkTrigger's Meet-link message is the
// family's one text for an accept — same as a click on the site.

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
  /** Caller identity for the audit log ("web" or an MCP tool name). */
  source: string;
}

export interface RespondToInterviewResult {
  status: "accepted" | "declined";
  interviewId: string;
  callUrl: string | null;
}

export async function respondToInterviewRequest(
  params: RespondToInterviewParams,
): Promise<RespondToInterviewResult> {
  const { caregiverId, interviewId, decision, source } = params;

  const ivRef = db.collection("video_interviews").doc(interviewId);
  const ivSnap = await ivRef.get();
  if (!ivSnap.exists) throw new InterviewResponseError("not-found", "Interview not found");
  const iv = ivSnap.data()!;
  if (iv.caregiverId !== caregiverId) {
    throw new InterviewResponseError("permission-denied", "Interview does not belong to this caregiver");
  }

  // The tab shows Accept / Decline only on a PENDING row. An accepted interview
  // is ended with Cancel; completed / declined / cancelled rows have no buttons.
  const status = String(iv.status || "pending");
  if (!PENDING_STATUSES.includes(status)) {
    throw new InterviewResponseError(
      "invalid-argument",
      status === "accepted" || status === "confirmed"
        ? "This interview is already accepted — cancel it (cancel_interview) or propose a new time (reschedule_interview) instead"
        : `This interview is ${status} — it can no longer be accepted or declined`,
    );
  }
  if (decision === "accept" && iv.reschedulePendingTime) {
    throw new InterviewResponseError(
      "invalid-argument",
      iv.rescheduledBy === "client"
        ? "The family proposed a new time for this interview — accept that time (accept_interview_reschedule) or propose a different one (reschedule_interview)"
        : "You already proposed a new time for this interview — it's waiting on the family to confirm; decline it if it no longer works",
    );
  }

  const updatedAt = admin.firestore.FieldValue.serverTimestamp();
  if (decision === "accept") {
    await ivRef.update({ status: "accepted", updatedAt });
  } else {
    await ivRef.update({
      status: "declined",
      updatedAt,
      // Terminal action: clear any leftover proposal, exactly as the site does.
      reschedulePendingTime: admin.firestore.FieldValue.delete(),
      rescheduledBy:         admin.firestore.FieldValue.delete(),
    });
  }

  logAudit({
    eventType: "interview_responded",
    userId: caregiverId,
    data: { source, interviewId, decision },
  }).catch(() => {});

  return {
    status: decision === "accept" ? "accepted" : "declined",
    interviewId,
    callUrl: (iv.callUrl as string | undefined) ?? null,
  };
}
