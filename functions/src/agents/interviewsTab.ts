// agents/interviewsTab.ts — the website's Care Requests > Interviews tab as one
// read (2026-09-17), exactly the way components/client/PostsPage.tsx builds it:
//
//   video_interviews where clientId == me (statuses normalised the same way:
//   requested/scheduled → pending, confirmed → accepted), sorted pending →
//   accepted → completed → declined → cancelled, active ones soonest first
//   and resolved ones most recent first; each card joined to its job post
//   (banner: title, location, rate, frequency, care types), to the family's
//   booking_requests (the "Booking sent / accepted / Visit cancelled /
//   Caregiver declined" line, keyed `${caregiverId}_${jobId || interviewId}`
//   with the page's status priority) and to their scheduled shifts (Re-book
//   only once no shift is left) — plus `actions` = the exact buttons the row
//   shows under the page's own conditions.
import * as admin from "firebase-admin";
import { parseScheduledTimeMs, formatInterviewTime } from "../utils/scheduledTime";

const db = admin.firestore();

export type InterviewDisplayStatus = "pending" | "accepted" | "completed" | "declined" | "cancelled" | "no-response";

export type InterviewAction =
  | "join_video_call" | "message"
  | "accept_new_time" | "propose_time" | "cancel" | "mark_completed"
  | "cancel_pending_booking" | "rebook" | "resend" | "not_selected" | "send_booking"
  | "view_other_applicants" | "accept_proposed_time" | "propose_another_time";

export interface InterviewsTabRow {
  interviewId:   string;
  source:        "video_interviews";
  clientId:      string | null;
  caregiverId:   string | null;
  caregiverName: string | null;
  caregiverPhoto: string | null;
  scheduledTime: string | null;
  scheduledTimeLocal: string | null;
  interviewType: string;
  /** Raw stored status (requested/accepted/declined/completed/cancelled). */
  status:        string;
  /** The page's normalised pill: pending / accepted / completed / declined / cancelled. */
  displayStatus: InterviewDisplayStatus;
  callUrl:       string | null;
  notes:         string | null;
  jobId:         string | null;
  jobTitle:      string | null;
  applicationId: string | null;
  /** The linked post's banner, when the post still exists. */
  job:           { title: string; location: string | null; rate: number | null; frequency: string | null; careTypes: string[] } | null;
  proposedTime:  string | null;
  proposedTimeLocal: string | null;
  reschedulePendingTime:      string | null;
  reschedulePendingTimeLocal: string | null;
  rescheduledBy: "client" | "caregiver" | null;
  /** "you" = the caregiver proposed and the family must accept/decline; "caregiver" = the family's own proposal is out. */
  rescheduleWaitingOn: "you" | "caregiver" | null;
  /** The booking line under a completed interview, exactly as the page labels it. */
  booking: { id: string; status: "pending" | "accepted" | "declined" | "cancelled"; label: string; hasActiveShifts: boolean } | null;
  /** The family already marked this caregiver Not Selected. */
  notSelected: boolean;
  actions: InterviewAction[];
}

const STATUS_ORDER: Record<string, number> = { pending: 0, accepted: 1, completed: 3, declined: 4, cancelled: 5 };
const ACTIVE = new Set(["pending", "accepted"]);
const BOOKING_PRIORITY: Record<string, number> = { accepted: 4, pending: 3, declined: 2, cancelled: 1 };

export function normaliseInterviewStatus(raw: unknown): InterviewDisplayStatus {
  if (raw === "requested" || raw === "scheduled") return "pending";
  if (raw === "confirmed") return "accepted";
  return (raw as InterviewDisplayStatus) ?? "pending";
}

/** The page's filter pills map onto stored statuses: pending ⇢ requested. */
export function storedStatusesForFilter(filter: string | undefined): string[] | null {
  if (!filter || filter === "all") return null;
  if (filter === "pending" || filter === "requested") return ["requested", "scheduled", "pending"];
  if (filter === "accepted") return ["accepted", "confirmed"];
  return [filter];
}

const local = (iso: unknown): string | null => {
  if (typeof iso !== "string" || !iso) return null;
  const ms = parseScheduledTimeMs(iso);
  return Number.isNaN(ms) ? null : formatInterviewTime(ms);
};

export async function listClientInterviews(clientId: string, filter?: string, now: number = Date.now()): Promise<InterviewsTabRow[]> {
  const wanted = storedStatusesForFilter(filter);
  const [ivSnap, postSnap, brSnap, shiftSnap] = await Promise.all([
    db.collection("video_interviews").where("clientId", "==", clientId).get(),
    db.collection("job_posts").where("clientId", "==", clientId).get(),
    db.collection("booking_requests").where("clientId", "==", clientId).get(),
    db.collection("shifts").where("clientId", "==", clientId).where("status", "==", "scheduled").get(),
  ]);

  const posts = new Map(postSnap.docs.map((d) => [d.id, d.data()]));

  // bookingStatuses — same key + priority as the page's listener.
  const bookings = new Map<string, { id: string; status: "pending" | "accepted" | "declined" | "cancelled" }>();
  for (const d of brSnap.docs) {
    const b = d.data();
    const key = `${b.caregiverId}_${b.jobId || b.interviewId || ""}`;
    const cur = bookings.get(key);
    const np = BOOKING_PRIORITY[String(b.status)] ?? 0;
    const cp = cur ? (BOOKING_PRIORITY[cur.status] ?? 0) : -1;
    if (np > cp) bookings.set(key, { id: d.id, status: b.status });
  }
  const activeBookingIds = new Set(shiftSnap.docs.map((d) => String(d.data().bookingRequestId ?? "")).filter(Boolean));

  const rows: InterviewsTabRow[] = ivSnap.docs
    .filter((d) => !wanted || wanted.includes(String(d.data().status ?? "")))
    .map((d) => {
      const iv = d.data();
      const displayStatus = normaliseInterviewStatus(iv.status);
      const post = iv.jobId ? posts.get(String(iv.jobId)) : undefined;
      const key = `${iv.caregiverId}_${iv.jobId || d.id}`;
      const bk = bookings.get(key) ?? null;
      const hasActiveShifts = !!bk && activeBookingIds.has(bk.id);
      const bookingLabel = !bk ? "" :
        bk.status === "pending" ? "Booking sent · Awaiting response" :
        bk.status === "accepted" ? (hasActiveShifts ? "Booking accepted" : "Booking finished — Re-book available") :
        bk.status === "cancelled" ? "Visit cancelled" : "Caregiver declined";
      const notSelected = displayStatus === "declined" && iv.declinedBy === "client";
      const startMs = typeof iv.scheduledTime === "string" ? parseScheduledTimeMs(iv.scheduledTime) : NaN;
      const isActive = ACTIVE.has(displayStatus);
      const meetUrl = typeof iv.callUrl === "string" && iv.callUrl.startsWith("https://meet.google.com/");

      const actions: InterviewAction[] = [];
      if (meetUrl && isActive) actions.push("join_video_call");
      if (isActive) actions.push("message");
      if (iv.reschedulePendingTime && iv.rescheduledBy === "caregiver") actions.push("accept_new_time");
      // Propose/Reschedule only on the family's TURN — never on their own outgoing proposal.
      if (isActive && iv.rescheduledBy !== "client") actions.push("propose_time");
      if (isActive) actions.push("cancel");
      if (displayStatus === "accepted" && Number.isFinite(startMs) && startMs < now) actions.push("mark_completed");
      if (displayStatus === "completed") {
        if (bk?.status === "pending") actions.push("cancel_pending_booking");
        else if (bk?.status === "accepted") { if (!hasActiveShifts) actions.push("rebook"); }
        else if (bk?.status === "declined" || bk?.status === "cancelled") actions.push("resend");
        else if (!notSelected) actions.push("not_selected", "send_booking");
      }
      if (displayStatus === "declined" && !notSelected && iv.jobId) actions.push("view_other_applicants");
      if (displayStatus === "declined" && iv.proposedTime) actions.push("accept_proposed_time", "propose_another_time");

      return {
        interviewId:   d.id,
        source:        "video_interviews" as const,
        clientId:      (iv.clientId as string | undefined) ?? null,
        caregiverId:   (iv.caregiverId as string | undefined) ?? null,
        caregiverName: (iv.caregiverName as string | undefined) ?? null,
        caregiverPhoto: (iv.caregiverPhoto as string | undefined) ?? null,
        scheduledTime: (iv.scheduledTime as string | undefined) ?? null,
        scheduledTimeLocal: local(iv.scheduledTime),
        interviewType: String(iv.interviewType ?? iv.type ?? "video"),
        status:        String(iv.status ?? "requested"),
        displayStatus,
        callUrl:       (iv.callUrl as string | undefined) ?? null,
        notes:         (iv.notes as string | undefined) ?? null,
        jobId:         (iv.jobId as string | undefined) ?? null,
        jobTitle:      (iv.jobTitle as string | undefined) ?? (post?.title as string | undefined) ?? null,
        applicationId: (iv.applicationId as string | undefined) ?? null,
        job: post ? {
          title:     String(post.title ?? ""),
          location:  ([post.city, post.state, post.zipCode].filter(Boolean).join(", ") || (post.location as string | undefined)) ?? null,
          rate:      post.rateFlexible || !post.rate ? null : Number(post.rate),
          frequency: (post.jobFrequency as string | undefined)?.replace("-", " ") ?? (post.minHoursPerWeek != null ? (Number(post.minHoursPerWeek) >= 32 ? "Full Time" : "Part Time") : null),
          careTypes: Array.isArray(post.careTypes) ? (post.careTypes as string[]) : [],
        } : null,
        proposedTime:  (iv.proposedTime as string | undefined) ?? null,
        proposedTimeLocal: local(iv.proposedTime),
        reschedulePendingTime:      (iv.reschedulePendingTime as string | undefined) ?? null,
        reschedulePendingTimeLocal: local(iv.reschedulePendingTime),
        rescheduledBy: (iv.rescheduledBy as "client" | "caregiver" | undefined) ?? null,
        rescheduleWaitingOn: iv.reschedulePendingTime ? (iv.rescheduledBy === "client" ? "caregiver" : "you") : null,
        booking: bk ? { ...bk, label: bookingLabel, hasActiveShifts } : null,
        notSelected,
        actions,
      };
    });

  rows.sort((a, b) => {
    const so = (STATUS_ORDER[a.displayStatus] ?? 9) - (STATUS_ORDER[b.displayStatus] ?? 9);
    if (so !== 0) return so;
    const at = a.scheduledTime ? parseScheduledTimeMs(a.scheduledTime) : 0;
    const bt = b.scheduledTime ? parseScheduledTimeMs(b.scheduledTime) : 0;
    return ACTIVE.has(a.displayStatus) ? at - bt : bt - at;
  });
  return rows;
}
