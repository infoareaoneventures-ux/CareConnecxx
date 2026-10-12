// New job posted → tell the caregivers who would see it (founder, 2026-09-27).
//
// The website has no job alert of its own; the founder wants caregivers told
// when a family posts, under the SITE's rules and nothing more:
//   • who: every caregiver whose dashboard shows "Nearby Jobs" — profile
//     complete, not opted out / paused, no ACTIVE family (an accepted booking
//     with a scheduled or in-progress shift; those caregivers see the home-base
//     layout instead, and can ask Evia anytime) — and for whom the job passes
//     the board's own drops (blocked client, deactivated client) and radius
//     rule (jobBoardPage.ts). Membership is NOT required: the site lists jobs
//     for unpaid caregivers too and gates only Apply.
//   • what: one text carrying the card's own lines (no link — they ask Evia),
//     mirrored into the website bell (users/{uid}/notifications). No yes/no
//     reply flow — they apply on the site or ask Evia, exactly as the page does.
//   • how: through sendViaInteractionAgent like every other proactive caregiver
//     text (caregiver sweep C13, 2026-10-11) — the session opt-out, dedup and the
//     block-only review of a fixed string apply; canDrop false; the bell is
//     written only when the text actually went (bell ⇄ text, C11).
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { writeUserNotification } from "../notifications/userNotification";
import { findCaregiverSession, jobRequiresTransport } from "../agents/caregiverAccessGate";
import { parkedDecision, parkDecision } from "../agents/decisionNotices";
import {
  normalizeJobPost, buildJobCard, jobCardLine, caregiverCoords, caregiverRadiusMiles, withinCaregiverRadius, drivingJobsHiddenFor } from "../agents/jobBoardPage";

const db = admin.firestore();

// CaregiverHomeDashboard.tsx hasActiveFamilies: an accepted booking_request
// cross-checked with a live scheduled / in-progress shift for it.
export async function caregiverHasActiveFamilies(caregiverId: string): Promise<boolean> {
  const [reqs, shifts] = await Promise.all([
    db.collection("booking_requests").where("caregiverId", "==", caregiverId).where("status", "==", "accepted").get(),
    db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "in", ["scheduled", "in-progress"]).get(),
  ]);
  if (reqs.empty || shifts.empty) return false;
  const live = new Set(shifts.docs.map((s) => s.data().bookingRequestId as string | undefined).filter(Boolean));
  return reqs.docs.some((r) => live.has(r.id));
}

export interface NewJobNoticeResult { notified: string[]; /** the text did not go (no session / opted out / blocked) — no bell either */ dropped: string[]; skipped: number }

export async function sendNewJobNotices(jobId: string, rawJob: Record<string, unknown>, eventId: string): Promise<NewJobNoticeResult> {
  const result: NewJobNoticeResult = { notified: [], dropped: [], skipped: 0 };
  const job = normalizeJobPost({ id: jobId, ...rawJob });
  if (job.status !== "open" || job.clientActive === false) return result;

  const nowIso = new Date().toISOString();
  const cgSnap = await db.collection("caregivers").where("onboardingStatus", "==", "profile_complete").get();

  for (const doc of cgSnap.docs) {
    const cg: Record<string, unknown> = { id: doc.id, ...(doc.data() as Record<string, unknown>) };
    if (cg.optedOut === true) { result.skipped++; continue; }
    if (typeof cg.pausedUntil === "string" && cg.pausedUntil > nowIso) { result.skipped++; continue; }
    // A Not approved driving record: she is not told about driving jobs (same rule as her lists).
    if (drivingJobsHiddenFor(cg) && jobRequiresTransport(job)) { result.skipped++; continue; }
    const coords = caregiverCoords(cg);
    if (!withinCaregiverRadius(job, coords, caregiverRadiusMiles(cg))) { result.skipped++; continue; }
    const userSnap = await db.collection("users").doc(doc.id).get().catch(() => null);
    const blocked = (userSnap?.data()?.blockedUsers as string[] | undefined) ?? [];
    if (blocked.includes(job.clientId as string)) { result.skipped++; continue; }
    if (await caregiverHasActiveFamilies(doc.id)) { result.skipped++; continue; }

    const card = buildJobCard(job, cg, coords);
    const line = jobCardLine(card);
    const body = `New job near you: ${line}.`;

    const sess = await findCaregiverSession(doc.id, cg.phone).catch(() => null);
    if (!sess) { result.dropped.push(doc.id); continue; }
    // Evia IS the second front door: no link — the caregiver asks her for the
    // details or to apply, like tapping the card on the site.
    let sent = false;
    try {
      sent = await sendViaInteractionAgent(sess.phone, {
        content: `${body} Reply APPLY or DETAILS.`, urgency: "standard", sourceAgent: "new_job_notice", canDrop: false, fixedString: true,
      });
    } catch (err) { console.error("[newJobNotice] text failed:", doc.id, err); }
    if (!sent) { result.dropped.push(doc.id); continue; }
    result.notified.push(doc.id);
    // "This job" in their next text resolves to this post (jobBoardText.resolveJobRef).
    try {
      await db.collection("agent_sessions").doc(sess.phone).set({
        lastNoticedJobId: jobId, lastNoticedJobAt: new Date().toISOString(),
        ...parkDecision(parkedDecision("new_job", jobId, "a new job near you", "caregiver")),
      }, { merge: true });
    } catch { /* best effort */ }
    await writeUserNotification({
      sourcePath: `job_posts/${jobId}`,
      eventId,
      recipientId: doc.id,
      transitionType: "new_job_posted",
      type: "new_job",
      title: "New job near you",
      body,
      data: { jobId, link: `/care-provider/jobs?job=${jobId}` },
    }).catch((err) => console.error("[newJobNotice] bell write failed:", doc.id, err));
  }
  return result;
}

export const onJobPostCreatedNotifyCaregivers = functions.firestore
  .document("job_posts/{postId}")
  .onCreate(async (snap, context) => {
    const data = snap.data() as Record<string, unknown>;
    if (data.status !== "open") return;
    // Idempotent across retries of this event: stamp first, then send.
    const stamped = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(snap.ref);
      if (fresh.data()?.newJobNoticeSentAt) return false;
      tx.update(snap.ref, { newJobNoticeSentAt: new Date().toISOString() });
      return true;
    });
    if (!stamped) return;
    const res = await sendNewJobNotices(context.params.postId, data, context.eventId);
    console.log(`[newJobNotice] job ${context.params.postId}: texted ${res.notified.length}, dropped ${res.dropped.length}, skipped ${res.skipped}`);
  });
