import * as admin from "firebase-admin";
import { haversineMiles } from "../ai/scoring";
import { sendMessage, startTyping, getOrCreateSession } from "../linq/client";
import { computeSimpleMatchScore, INVITE_MATCH_THRESHOLD } from "./jobNotifications";

const db = admin.firestore();
const NOTIFY_RADIUS_MILES = 25; // mirror the job→caregiver fan-out radius

/**
 * U10 — the reverse of notifyAreaCaregivers (job → caregivers): when a caregiver
 * finishes onboarding, match them against EXISTING open jobs so they don't land
 * on an empty board on a quiet day. Invites them to the SINGLE best-fit job,
 * because the YES/NO apply flow tracks one pendingJobId per session — sending
 * several would clobber that slot. The caregiver can browse the rest ("jobs").
 *
 * Pure proximity + profile-fit gating reuses computeSimpleMatchScore /
 * INVITE_MATCH_THRESHOLD so the invite bar matches the forward direction.
 * Idempotent via the shared job_notifications guard.
 */
export async function notifyNewCaregiverOfJobs(caregiverId: string): Promise<void> {
  if (!caregiverId) return;
  try {
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    if (!cgSnap.exists) return;
    const cg = cgSnap.data()!;
    const phone = cg.phone as string | undefined;
    if (!phone || cg.optedOut === true) return;

    const cgLat = cg.latitude ?? cg.location?.latitude ?? cg.location?.lat;
    const cgLng = cg.longitude ?? cg.location?.longitude ?? cg.location?.lng;
    // No coords → can't proximity-match. Consistent with notifyAreaCaregivers,
    // which skips jobs it can't locate rather than blasting them out.
    if (typeof cgLat !== "number" || typeof cgLng !== "number") return;

    const cgSkills: string[] = [
      ...(cg.specialties ?? []),
      ...(cg.medicalSkills ?? []),
      ...(cg.certifications ?? []),
    ];

    const jobsSnap = await db.collection("job_posts")
      .where("status", "==", "open")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    if (jobsSnap.empty) return;

    type Scored = { jobId: string; data: admin.firestore.DocumentData; dist: number; score: number };
    const scored: Scored[] = [];
    for (const jobDoc of jobsSnap.docs) {
      const data = jobDoc.data();
      // Web-contract docs carry top-level lat/lng (all writers since
      // 2026-07-10); the object fallbacks cover legacy docs.
      const jLat = data.lat ?? data.location?.lat ?? data.location?.latitude ?? data.latitude;
      const jLng = data.lng ?? data.location?.lng ?? data.location?.longitude ?? data.longitude;
      const dist = haversineMiles(cgLat, cgLng, jLat, jLng);
      if (dist === undefined || dist > NOTIFY_RADIUS_MILES) continue;
      const careTypes: string[] = data.careTypes ?? [];
      const score = computeSimpleMatchScore(cgSkills, careTypes);
      if (score < INVITE_MATCH_THRESHOLD) continue;
      scored.push({ jobId: jobDoc.id, data, dist, score });
    }
    if (scored.length === 0) return;

    // Best fit first, then nearest. Pick the best job we haven't already
    // invited this caregiver to.
    scored.sort((a, b) => (b.score - a.score) || (a.dist - b.dist));
    let best: Scored | null = null;
    for (const cand of scored) {
      const existing = await db.collection("job_notifications")
        .where("caregiverId", "==", caregiverId)
        .where("jobId", "==", cand.jobId)
        .limit(1).get();
      if (existing.empty) { best = cand; break; }
    }
    if (!best) return;

    const session = await getOrCreateSession(phone, { caregiverId });
    if (session.optedOut) return;

    const firstName = (cg.firstName ?? cg.name ?? "there").split(" ")[0];
    const careTypes: string[] = best.data.careTypes ?? [];
    const careText = careTypes.length > 0 ? careTypes.join(", ") : "care";
    const city = best.data.location?.city ?? best.data.city ?? "your area";
    const more = scored.length - 1;
    const message =
      `Welcome aboard, ${firstName}! There's already a care job near you that fits your profile.\n\n` +
      `📍 ${city} · ${careText}\n\n` +
      `Interested? Just tell me yes or no — or ask me anything about it.` +
      (more > 0 ? `\n\n(${more} more open nearby — reply "jobs" to see them.)` : "");

    await startTyping(session.chatId).catch(() => {});
    await sendMessage(session.chatId, message);

    await db.collection("job_notifications").add({
      caregiverId,
      jobId:  best.jobId,
      phone,
      sentAt: new Date().toISOString(),
      source: "new_caregiver_match",
    });
    await db.collection("agent_sessions").doc(phone).update({
      awaitingJobResponse:              true,
      awaitingAvailabilityConfirmation: false,
      pendingJobId:                     best.jobId,
      pendingJobSentAt:                 new Date().toISOString(),
    } as admin.firestore.UpdateData<admin.firestore.DocumentData>);
  } catch (err) {
    console.error("[notifyNewCaregiverOfJobs] failed:", err);
  }
}
