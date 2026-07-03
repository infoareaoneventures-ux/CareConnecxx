import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * Situation snapshot — a compact, read-only summary of what currently needs the
 * user's attention, injected into the agent loop's standing context.
 *
 * Why this exists: the system prompt already tells Evia to "LEAD, DON'T ASK" —
 * to surface the most relevant thing instead of replying "what do you need?".
 * But to KNOW what to lead with (new applicants? an interview waiting? a
 * timesheet to approve?) she previously had to spend several tool round-trips
 * discovering it. The client standing context was rich; the caregiver context
 * was almost bare (just today's visit). This closes that gap by precomputing a
 * few headline counts so Evia can open proactively without the round-trips.
 *
 * The snapshot is a cached count, not authority to act. The injected directive
 * tells Evia to verify with a tool before asserting specifics or taking action,
 * consistent with the existing KNOWLEDGE BOUNDARY rule.
 *
 * Read-only and bounded: each builder runs a small set of proven-indexed
 * queries in parallel and fails soft (returns "") on any error, so a snapshot
 * problem can never break a turn. No money/booking/irreversible path is touched.
 */

export interface CaregiverSnapshotInput {
  pendingInterviews:  number;
  pendingApplications: number;
  hasShiftOffer:      boolean;
  hasJobInvite:       boolean;
  upcomingVisits:     number;
  nextVisit:          { date: string; startTime?: string } | null;
}

export interface ClientSnapshotInput {
  openJobs:          number;
  totalApplicants:   number;
  pendingTimesheets: number;
  upcomingVisits:    number;
  // When there's exactly one open job, its title — so Evia can name it ("3
  // applicants on your weekend-coverage post") instead of an abstract count.
  openJobTitle:      string | null;
}

/** A short, human label for a job post — mirrors list_client_jobs (mcp/server.ts). */
export function jobTitle(data: admin.firestore.DocumentData): string {
  const raw = (data.summary as string) ||
    `care — ${((data.careTypes as string[]) ?? []).slice(0, 2).join(", ")}`.trim();
  const cleaned = raw.replace(/\s+/g, " ").trim() || "care";
  return cleaned.length > 45 ? `${cleaned.slice(0, 44)}…` : cleaned;
}

const SNAPSHOT_HEADER =
  "CURRENT SITUATION (use this to lead proactively instead of asking " +
  "\"what do you need?\" — but it's a cached summary, so verify with a tool " +
  "before asserting specifics or taking action):";

/** Pure formatter — no I/O, unit-tested directly. Returns "" when nothing is worth surfacing. */
export function formatCaregiverSnapshot(s: CaregiverSnapshotInput): string {
  const lines: string[] = [];
  if (s.hasShiftOffer)
    lines.push("- A shift offer is awaiting your YES/NO.");
  if (s.hasJobInvite)
    lines.push("- A job invite is awaiting your YES/NO.");
  if (s.nextVisit) {
    const at = s.nextVisit.startTime ? ` at ${s.nextVisit.startTime}` : "";
    const more = s.upcomingVisits > 1 ? ` (+${s.upcomingVisits - 1} more in the next 7 days)` : "";
    lines.push(`- Next visit: ${s.nextVisit.date}${at}${more}.`);
  }
  if (s.pendingInterviews > 0)
    lines.push(`- ${s.pendingInterviews} interview request${s.pendingInterviews === 1 ? "" : "s"} awaiting your response.`);
  if (s.pendingApplications > 0)
    lines.push(`- ${s.pendingApplications} job application${s.pendingApplications === 1 ? "" : "s"} still pending a decision.`);
  if (lines.length === 0) return "";
  return `${SNAPSHOT_HEADER}\n${lines.join("\n")}`;
}

/** Pure formatter — no I/O, unit-tested directly. Returns "" when nothing is worth surfacing. */
export function formatClientSnapshot(s: ClientSnapshotInput): string {
  const lines: string[] = [];
  if (s.openJobs > 0) {
    const applicants = s.totalApplicants > 0
      ? ` (${s.totalApplicants} applicant${s.totalApplicants === 1 ? "" : "s"} total)`
      : "";
    if (s.openJobs === 1 && s.openJobTitle) {
      lines.push(`- 1 open job post for ${s.openJobTitle}${applicants}.`);
    } else {
      lines.push(`- ${s.openJobs} open job post${s.openJobs === 1 ? "" : "s"}${applicants}.`);
    }
  }
  if (s.pendingTimesheets > 0)
    lines.push(`- ${s.pendingTimesheets} timesheet${s.pendingTimesheets === 1 ? "" : "s"} waiting for your approval.`);
  if (s.upcomingVisits > 0)
    lines.push(`- ${s.upcomingVisits} upcoming visit${s.upcomingVisits === 1 ? "" : "s"} scheduled.`);
  if (lines.length === 0) return "";
  return `${SNAPSHOT_HEADER}\n${lines.join("\n")}`;
}

/**
 * Caregiver snapshot. Two proven-indexed queries (interview_requests by
 * caregiverId+status — see mcp/server.ts list path; job_applications by
 * caregiverId — see get_my_applications) plus zero-cost session flags. Soft-fail.
 */
export async function buildCaregiverSnapshot(
  caregiverId: string,
  session?: Record<string, unknown>,
): Promise<string> {
  if (!caregiverId) return "";
  try {
    const today = new Date().toISOString().slice(0, 10);
    const weekAhead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [interviewSnap, appSnap, visitSnap] = await Promise.all([
      // Statuses where the caregiver themselves must respond. Includes the SMS
      // interview flow's "awaiting_caregiver_availability" (interviewAgent.ts) —
      // previously missed. "pending_presentation" is excluded: it can mean
      // awaiting presentation to the client, not the caregiver.
      db.collection("interview_requests")
        .where("caregiverId", "==", caregiverId)
        .where("status", "in", ["awaiting_caregiver_availability", "awaiting_caregiver_response"])
        .limit(10).get().catch(() => null),
      db.collection("job_applications")
        .where("caregiverId", "==", caregiverId)
        .orderBy("appliedAt", "desc")
        .limit(10).get().catch(() => null),
      // Upcoming schedule — mirrors get_caregiver_appointments (mcp/server.ts),
      // so the (caregiverId, date, status) index is already provisioned.
      db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", ">=", today)
        .where("date", "<=", weekAhead)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .orderBy("date", "asc")
        .limit(6).get().catch(() => null),
    ]);

    const pendingApplications = (appSnap?.docs ?? [])
      .filter((d) => ((d.data().status as string) ?? "pending") === "pending").length;

    const visitDocs = visitSnap?.docs ?? [];
    const nextVisitData = visitDocs[0]?.data();
    const nextVisit = nextVisitData
      ? { date: nextVisitData.date as string, startTime: nextVisitData.startTime as string | undefined }
      : null;

    return formatCaregiverSnapshot({
      pendingInterviews:   interviewSnap?.size ?? 0,
      pendingApplications,
      hasShiftOffer:       !!session?.pendingShiftOfferId,
      hasJobInvite:        !!(session?.awaitingJobResponse && session?.pendingJobId),
      upcomingVisits:      visitDocs.length,
      nextVisit,
    });
  } catch {
    return "";
  }
}

/**
 * Client snapshot. Two proven-indexed queries (job_posts by clientId ordered by
 * createdAt — status filtered in memory to keep the index simple;
 * shiftHours by clientId+status — see get_pending_timesheets). Soft-fail.
 * Reuses the denormalized job_posts.applicantCount, so applicant totals cost no
 * extra reads.
 */
export async function buildClientSnapshot(userId: string): Promise<string> {
  if (!userId) return "";
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [jobsSnap, tsSnap, visitSnap] = await Promise.all([
      db.collection("job_posts")
        .where("clientId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(10).get().catch(() => null),
      db.collection("shiftHours")
        .where("clientId", "==", userId)
        .where("status", "==", "pending_client_review")
        .orderBy("submittedAt", "desc")
        .limit(5).get().catch(() => null),
      // Upcoming visits — mirrors getNextAppointment's (clientId, status, date)
      // index, just a higher limit, so it removes the get_upcoming_appointments
      // round-trip for "how many visits do I have coming up".
      db.collection("appointments")
        .where("clientId", "==", userId)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("date", ">=", today)
        .orderBy("date", "asc")
        .limit(10).get().catch(() => null),
    ]);

    const openJobDocs = (jobsSnap?.docs ?? [])
      .filter((d) => (d.data().status as string) === "open");
    const totalApplicants = openJobDocs
      .reduce((sum, d) => sum + ((d.data().applicantCount as number) ?? 0), 0);

    // Name the job only when there's exactly one open — naming it is the
    // "connect the dots" win; with several, a count avoids picking the wrong one.
    const openJobTitle = openJobDocs.length === 1 ? jobTitle(openJobDocs[0].data()) : null;

    return formatClientSnapshot({
      openJobs:          openJobDocs.length,
      totalApplicants,
      pendingTimesheets: tsSnap?.size ?? 0,
      upcomingVisits:    visitSnap?.size ?? 0,
      openJobTitle,
    });
  } catch {
    return "";
  }
}
