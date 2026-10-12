// agents/interviewProposal.ts — "Keep current time" on an interview whose
// OTHER side proposed a different time (caregiver sweep B5, founder
// 2026-10-11 "okay build"): the family's Interviews tab (PostsPage.tsx
// handleKeepCurrentTime) and the caregiver's (JobBoard.tsx
// handleKeepCurrentTime) each write this exact field set; Evia's KEEP reply to
// the proposal notice (decisionNotices.ts) and the accept_interview_reschedule
// tool's action:"keep" (mcp/server.ts) both end HERE, so the text door is the
// button's write. A static test pins the two site handlers to
// KEEP_INTERVIEW_TIME_FIELDS so the three never drift.
//
// The write clears the proposal and nothing else: status and scheduledTime
// stay, so onVideoInterviewWrite (notificationTriggers.ts) sees "pending
// cleared, same status, same time" and tells the proposer — bell + text —
// "<Name> isn't able to move the interview — it's staying at <when>." Nothing
// here texts the other side.
import * as admin from "firebase-admin";
import { logAudit } from "../observability/auditLog";
import { parseScheduledTimeMs, formatInterviewTime } from "../utils/scheduledTime";
import { PENDING_STATUSES, ACCEPTED_STATUSES, interviewTimeIso } from "./caregiverInterviewsTab";

const db = admin.firestore();

/**
 * The field set of the Keep current time write — the pending proposal and its
 * sibling (rescheduledViaAgent, Evia's own "I texted this proposal" marker,
 * which belongs to the proposal being dropped), plus updatedAt. NOT
 * remindersScheduledAt (the time did not move; the reminder still stands) and
 * NOT scheduledTime / status.
 */
export const KEEP_INTERVIEW_TIME_FIELDS = ["reschedulePendingTime", "rescheduledBy", "rescheduledViaAgent", "updatedAt"] as const;

export function keepInterviewTimePatch(): Record<(typeof KEEP_INTERVIEW_TIME_FIELDS)[number], unknown> {
  return {
    reschedulePendingTime: admin.firestore.FieldValue.delete(),
    rescheduledBy:         admin.firestore.FieldValue.delete(),
    rescheduledViaAgent:   admin.firestore.FieldValue.delete(),
    updatedAt:             admin.firestore.FieldValue.serverTimestamp(),
  };
}

export type KeepInterviewTimeResult =
  | {
      ok: true;
      interviewId: string;
      keptBy: "caregiver" | "client";
      clientName: string;
      caregiverName: string;
      /** The confirmed time that stands (ISO as stored), and as Evia says it. */
      scheduledTime: string | null;
      scheduledTimeLocal: string | null;
    }
  | { ok: false; code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT"; message: string };

export interface KeepInterviewTimeParams {
  /** Who is keeping the time — must be the side that did NOT propose. */
  by: "caregiver" | "client";
  /** That side's id (caregivers/{uid} or users/{uid}). */
  userId: string;
  interviewId: string;
  /** Caller identity for the audit log. */
  source: string;
}

/** The button shows on a pending or accepted row with the OTHER side's proposal out. */
export async function keepInterviewTime(params: KeepInterviewTimeParams): Promise<KeepInterviewTimeResult> {
  const { by, userId, interviewId, source } = params;
  const ref = db.collection("video_interviews").doc(interviewId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: "NOT_FOUND", message: "Interview not found" };
  const iv = snap.data()!;
  const owner = by === "caregiver" ? iv.caregiverId : iv.clientId;
  if (!userId || owner !== userId) return { ok: false, code: "PERMISSION_DENIED", message: "Interview does not belong to this user" };
  if (!iv.reschedulePendingTime) return { ok: false, code: "INVALID_INPUT", message: "There is no pending reschedule proposal on this interview" };
  if (iv.rescheduledBy === by) {
    return { ok: false, code: "INVALID_INPUT", message: "This proposal is your own — it's waiting on the other party; cancel the interview if the time no longer works" };
  }
  const status = String(iv.status || "pending");
  if (![...PENDING_STATUSES, ...ACCEPTED_STATUSES].includes(status)) {
    return { ok: false, code: "INVALID_INPUT", message: `This interview is ${status} — there is no time to keep` };
  }

  await ref.update(keepInterviewTimePatch());

  logAudit({ eventType: "interview_time_kept", userId, data: { source, interviewId, keptBy: by, declinedProposal: iv.reschedulePendingTime } }).catch(() => {});

  const whenIso = interviewTimeIso(iv as Record<string, unknown>);
  const whenMs = whenIso ? parseScheduledTimeMs(whenIso) : NaN;
  return {
    ok: true,
    interviewId,
    keptBy: by,
    clientName: String(iv.clientName || "the family"),
    caregiverName: String(iv.caregiverName || "your caregiver"),
    scheduledTime: whenIso,
    scheduledTimeLocal: Number.isFinite(whenMs) && whenMs > 0 ? formatInterviewTime(whenMs) : null,
  };
}

/** Evia's confirm, both roles: "Kept the current time — your interview with <other side> stays at <when>." */
export function keptInterviewLine(r: Extract<KeepInterviewTimeResult, { ok: true }>): string {
  const other = r.keptBy === "caregiver" ? r.clientName : r.caregiverName;
  return `Kept the current time — your interview with ${other}${r.scheduledTimeLocal ? ` stays at ${r.scheduledTimeLocal}` : " stays as it is"}.`;
}
