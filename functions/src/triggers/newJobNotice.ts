// New job posted → tell the caregivers who would see it (founder, 2026-09-27).
//
// The website has no job alert of its own; the founder wants caregivers told
// when a family posts, under the SITE's rules and nothing more:
//   • who: every caregiver whose dashboard shows "Nearby Jobs" — profile
//     complete, not opted out / paused, no ACTIVE family (an accepted booking
//     with a scheduled or in-progress shift; those caregivers see the home-base
//     layout instead, and can ask Evia anytime) — and for whom the job passes
//     the board's own drops (blocked client, deactivated client) and radius
//     rule (jobBoardPage.ts).
//     CHANGED 2026-11-09 (fix plan, Wave 1 — a live test post texted a real care
//     provider far outside their area, twice): a TEXT now needs a provider we can
//     place on the map (a location AND a travel distance above zero) and a job with
//     coordinates — the board's "no radius / no location / no coordinates = show it"
//     leniency is right for a list the person opens, wrong for an unprompted text —
//     and the provider must be bookable (isCaregiverBookable: onboarding complete,
//     background check approved, membership active, not paused / opted out). The
//     website bell is written for everyone who qualifies even when no text goes.
//   • what: one text carrying the card's own lines (no link — they ask Evia),
//     mirrored into the website bell (users/{uid}/notifications). No yes/no
//     reply flow — they apply on the site or ask Evia, exactly as the page does.
//   • how: through sendViaInteractionAgent like every other proactive caregiver
//     text (caregiver sweep C13, 2026-10-11) — the session opt-out, dedup and the
//     block-only review of a fixed string apply; canDrop false. The bell no longer
//     waits for the text (2026-11-09): a provider with no text session, or whose
//     text the send layer dropped, still gets it on the site.
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { writeUserNotification } from "../notifications/userNotification";
import { findCaregiverSession, jobRequiresTransport } from "../agents/caregiverAccessGate";
import { parkedDecision, parkDecision } from "../agents/decisionNotices";
import { isCaregiverBookable, type CaregiverEligibilityFields } from "../utils/caregiverEligibility";
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

export interface NewJobNoticeResult { notified: string[]; /** the text did not go (no session / opted out / blocked) — the bell still did */ dropped: string[]; skipped: number }

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
    // Not bookable (onboarding / background check / membership) → no notice at all.
    if (!isCaregiverBookable(cg as CaregiverEligibilityFields, nowIso)) { result.skipped++; continue; }
    const coords = caregiverCoords(cg);
    const radius = caregiverRadiusMiles(cg);
    // The board's leniency (no radius / no location / no coordinates = "show it") must not decide an
    // unprompted text: without all three we cannot say the job is near them, so we say nothing.
    if (!coords || radius <= 0 || !job.lat || !job.lng) { result.skipped++; continue; }
    if (!withinCaregiverRadius(job, coords, radius)) { result.skipped++; continue; }
    const userSnap = await db.collection("users").doc(doc.id).get().catch(() => null);
    const blocked = (userSnap?.data()?.blockedUsers as string[] | undefined) ?? [];
    if (blocked.includes(job.clientId as string)) { result.skipped++; continue; }
    if (await caregiverHasActiveFamilies(doc.id)) { result.skipped++; continue; }

    const card = buildJobCard(job, cg, coords);
    const line = jobCardLine(card);
    const body = `New job near you: ${line}.`;

    const sess = await findCaregiverSession(doc.id, cg.phone).catch(() => null);
    // Evia IS the second front door: no link — the caregiver asks her for the
    // details or to apply, like tapping the card on the site.
    let sent = false;
    if (sess) {
      try {
        sent = await sendViaInteractionAgent(sess.phone, {
          content: `${body} Want the details, or want to apply?`, urgency: "standard", sourceAgent: "new_job_notice", canDrop: false, fixedString: true,
        });
      } catch (err) { console.error("[newJobNotice] text failed:", doc.id, err); }
    }
    if (sess && sent) {
      result.notified.push(doc.id);
      // "This job" in their next text resolves to this post (jobBoardText.resolveJobRef).
      try {
        await db.collection("agent_sessions").doc(sess.phone).set({
          lastNoticedJobId: jobId, lastNoticedJobAt: new Date().toISOString(),
          ...parkDecision(parkedDecision("new_job", jobId, "a new job near you", "caregiver")),
        }, { merge: true });
      } catch { /* best effort */ }
    } else {
      result.dropped.push(doc.id);
    }
    // The bell goes either way (2026-11-09): the provider qualifies even when no text could be sent.
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
