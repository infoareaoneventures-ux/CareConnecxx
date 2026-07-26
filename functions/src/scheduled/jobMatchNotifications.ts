import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getJobRecommendationsForCaregiver } from "../agents/jobMatchRecommender";
import { sendMessage } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { gateOptionalSend } from "./engineGate";

// One decision record per (caregiver, job) held for 7 days — the U8 gate's
// cross-source dedupe is the ONLY dedupe this source has ever had (audit
// 2026-07-22 found no sent-marker anywhere), so before the gate a caregiver
// with a standing high match could be re-texted about the SAME job every day
// a new unrelated job posted.
const JOB_MATCH_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const db = admin.firestore();

// Runs daily — texts caregivers when a new job has >75% match
export const sendJobMatchNotifications = functions.pubsub
  .schedule("0 10 * * *")   // 10am daily
  .timeZone("America/New_York")
  .onRun(async () => {
    // Find jobs posted in last 24 hours
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const newJobsSnap = await db.collection("job_posts")
      .where("status", "==", "open")
      .where("createdAt", ">=", yesterday)
      .get();

    if (newJobsSnap.empty) {
      console.log("[sendJobMatchNotifications] No new jobs posted in last 24h");
      return;
    }

    console.log(`[sendJobMatchNotifications] Found ${newJobsSnap.size} new job(s)`);

    // Get all verified active caregivers
    const caregiverSnap = await db.collection("caregivers")
      .where("verified", "==", true)
      .limit(100)
      .get();

    console.log(`[sendJobMatchNotifications] Checking ${caregiverSnap.size} verified caregivers`);

    const todayIso = new Date().toISOString();
    for (const cgDoc of caregiverSnap.docs) {
      const cg = cgDoc.data();

      // Canonical bookability post-filter (the where() above is index pre-filtering only)
      if (!isCaregiverBookable(cg)) continue;
      if (!cg.chatId && !cg.phone) continue;

      // Skip paused caregivers
      const pausedUntil = cg.pausedUntil as string | undefined;
      if (pausedUntil && pausedUntil > todayIso) continue;

      try {
        // Childcare U6 (plan 2026-07-22-002): SENIOR-ONLY EXPLICIT SKIP —
        // the recommender reads status=="open" job_posts, which structurally
        // excludes childcare jobs (status "open_childcare"). This filter makes
        // the skip explicit: no childcare job detail ever enters this SMS
        // pipeline (childcare notifications are the eligibility-gated in-app
        // rows written at job creation).
        const recs = (await getJobRecommendationsForCaregiver(cgDoc.id, 3))
          .filter((r) => (r as { careVertical?: string }).careVertical !== "child");
        const highMatch = recs.filter(r => r.matchScore >= 75);
        if (!highMatch.length) continue;

        const chatId = cg.chatId ?? cg.phone;
        const top = highMatch[0];

        // U8 engine gate (KTD15): discretionary marketplace outreach. Keyed
        // per (caregiver, job) so the same job never re-notifies within the
        // dedupe window; a deferred pass re-enters on tomorrow's run.
        const g = await gateOptionalSend({
          phone: (cg.phone ?? cgDoc.id) as string,
          candidate: {
            source: "jobMatchNotifications",
            category: "re_engagement",
            urgency: 2,
            evidenceCount: 1, // deterministic: live job post + computed match score
            dedupeKey: `jobmatch:${cgDoc.id}:${top.jobId}`,
            ttlMs: JOB_MATCH_DEDUPE_TTL_MS,
          },
        });
        if (!g.allowed) {
          console.info("jobMatchNotifications.policy", { caregiverId: cgDoc.id, jobId: top.jobId, disposition: g.disposition, reason: g.reason });
          continue;
        }

        const msg = await generateCaraMessage({
          audience: "caregiver",
          context:
            `A new job came in that's a great match for this caregiver. ` +
            `Care types: ${top.careTypes.join(", ")}. Schedule: ${top.schedule}. ` +
            `Rate: $${top.rate}/hr. Match score: ${top.matchScore}%. ` +
            `Let them know about it and invite them to reply "jobs" to see the details. ` +
            `Keep the tone excited but natural.`,
          fallback:
            `New job match for you! ${top.careTypes.join(", ")} — ${top.schedule}, ` +
            `$${top.rate}/hr (${top.matchScore}% match). Reply "jobs" to see details.`,
          maxTokens: 80,
        });
        await sendMessage(chatId, msg);
        console.log(`[sendJobMatchNotifications] Notified ${cgDoc.id} — ${top.matchScore}% match`);
      } catch (e) {
        console.error(`[sendJobMatchNotifications] Failed for ${cgDoc.id}:`, e);
      }
    }
  });
